/**
 * Zipy AI — retry policy for selector resolution and action execution.
 *
 * This module owns *when to retry* and *how long to back off*. It does not
 * own *which selector to try* — that is `selectors.ts`'s job. The joined
 * contract is:
 *
 *   attempt 1 → primary selector (from the plan)
 *   attempt 2 → first fallback
 *   attempt 3 → second fallback
 *   ...
 *   attempt N → last fallback, or stop
 *
 * A "successful" attempt is defined by the caller: this module accepts an
 * async function that returns a discriminated `AttemptOutcome`. That keeps
 * the retry module agnostic to whether the attempt was a selector probe, a
 * click, a fill, or a navigation — every resilience site uses the same
 * policy.
 *
 * Design rules honoured here:
 *  - Backoff is bounded and deterministic: `min(maxBackoffMs, baseMs *
 *    2^(attempt - 1))`. Jitter is applied only when the caller opts in and
 *    the caller supplies the RNG (no `Math.random()` in library code, so
 *    tests are reproducible).
 *  - Fatal outcomes stop immediately. `page-closed` and `abort` are never
 *    retried. Transient outcomes are retried up to `maxAttempts`.
 *  - Every attempt records its outcome so `changeDetect.ts` (and the review
 *    phase) can see the full history, not just the final result.
 *  - The module never sleeps on a closed page or on an abort signal that has
 *    fired. `sleepWithAbort` is a first-class helper.
 */

import { getConfig } from "@/lib/config";

import { sleep } from "./waits.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The classification every attempt must produce. The retry loop switches on
 * this and nothing else. A caller with an error object must map it first
 * (see `classifyError`).
 */
export type AttemptOutcome<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "transient"; readonly reason: string; readonly detail?: string }
  | { readonly kind: "fatal"; readonly reason: string; readonly detail?: string }
  | { readonly kind: "retry-with-next-candidate"; readonly reason: string; readonly detail?: string };

/**
 * The full attempt history. `attempts` is length ≥ 1 on any terminal result
 * (the loop always runs at least one attempt). `attempts.at(-1)` is the
 * terminal outcome.
 */
export interface RetryHistory<T> {
  readonly final: AttemptOutcome<T>;
  readonly attempts: readonly RetryAttempt[];
  readonly elapsedMs: number;
}

/** One entry per attempt, in order. */
export interface RetryAttempt {
  /** 1-based attempt number. */
  readonly attempt: number;
  /** Result classification of this attempt. */
  readonly outcome: "success" | "transient" | "fatal" | "retry-with-next-candidate";
  /** Free-text reason from the attempt (empty on success). */
  readonly reason: string;
  /** Optional detail (typically an error message). */
  readonly detail: string;
  /** Time spent on this attempt, ms. */
  readonly elapsedMs: number;
  /** Backoff *before* the next attempt (0 when this is the terminal attempt). */
  readonly backoffMs: number;
}

/** Options governing a retry run. */
export interface RetryOptions<T> {
  /**
   * Absolute cap on attempts. Includes the first. Default is
   * `config.jobs.maxAttempts` for worker flows; callers that need a
   * different budget pass one explicitly. Must be ≥ 1.
   */
  readonly maxAttempts?: number;
  /**
   * Base backoff in ms. Default `config.jobs.backoffBaseMs`. The actual
   * delay for attempt N is `min(maxBackoffMs, base * 2^(N-1))`.
   */
  readonly baseBackoffMs?: number;
  /** Cap on the exponential backoff. Default 30_000 ms. */
  readonly maxBackoffMs?: number;
  /**
   * When supplied, the run aborts as soon as the signal fires. A fired
   * signal also terminates a backoff sleep.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Optional RNG for deterministic jitter. When null (the default) no
   * jitter is applied. The caller passes `Math.random` explicitly to opt
   * in; library code never reaches for it directly.
   */
  readonly rng?: (() => number) | null;
  /**
   * Jitter fraction in [0, 1]. Effective only with a non-null `rng`. The
   * applied backoff is `delay * (1 - jitterFraction * rng())`.
   */
  readonly jitterFraction?: number;
  /**
   * Optional hook called after every attempt. Never awaited in a way that
   * can block the loop for longer than the caller's own promise; a
   * throwing hook is swallowed (a logging hook must not abort a run).
   */
  readonly onAttempt?: (entry: RetryAttempt) => void | Promise<void>;
}

export class RetryAbortedError extends Error {
  public readonly code = "retry_aborted" as const;
  constructor(message = "Retry run aborted before completion.") {
    super(message);
    this.name = "RetryAbortedError";
  }
}

/* -------------------------------------------------------------------------- */
/* Core loop                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run `attempt` until it returns `success`, a `fatal` outcome, or the
 * attempt budget is exhausted. `retry-with-next-candidate` is treated like
 * `transient` for retry purposes but recorded distinctly in history —
 * `selectors.ts` uses it to signal "try the next fallback selector" rather
 * than "the same selector failed transiently".
 *
 * The function is generic in the success value `T`, so the same loop
 * handles a `ResolutionResult`, a click confirmation boolean, or a fill
 * result.
 *
 * Returns the full history. The caller inspects `history.final.kind` to
 * decide what to do; the module never throws for a non-success outcome —
 * except for an aborted run, where `RetryAbortedError` is thrown because
 * an abort is a caller-driven decision, not an attempt outcome.
 */
export async function runWithRetry<T>(
  attempt: (attemptNumber: number) => Promise<AttemptOutcome<T>>,
  options: RetryOptions<T> = {},
): Promise<RetryHistory<T>> {
  const config = getConfig().jobs;
  const maxAttempts = normalisePositiveInt(options.maxAttempts, config.maxAttempts);
  const baseBackoffMs = normalisePositiveInt(options.baseBackoffMs, config.backoffBaseMs);
  const maxBackoffMs = normalisePositiveInt(options.maxBackoffMs, 30_000);
  const startedAt = Date.now();
  const attempts: RetryAttempt[] = [];

  let lastOutcome: AttemptOutcome<T> | null = null;

  for (let n = 1; n <= maxAttempts; n++) {
    if (isAborted(options.abortSignal)) {
      throw new RetryAbortedError(
        `Retry run aborted after ${attempts.length} attempt(s).`,
      );
    }
    const attemptStartedAt = Date.now();
    const outcome = await safeAttempt(attempt, n, options.abortSignal);
    const elapsedMs = Date.now() - attemptStartedAt;

    const entryBase: Omit<RetryAttempt, "backoffMs"> = {
      attempt: n,
      outcome: outcome.kind,
      reason: "reason" in outcome ? outcome.reason : "",
      detail: "detail" in outcome ? outcome.detail ?? "" : "",
      elapsedMs,
    };
    lastOutcome = outcome;

    const terminal = outcome.kind === "success" || outcome.kind === "fatal";
    const exhausted = n >= maxAttempts;
    const backoffMs = terminal || exhausted ? 0 : computeBackoff(n, baseBackoffMs, maxBackoffMs, options);

    const entry: RetryAttempt = { ...entryBase, backoffMs };
    attempts.push(entry);
    recordAttempt(entry, options.onAttempt);

    if (terminal) {
      return {
        final: outcome,
        attempts: [...attempts],
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (exhausted) {
      // Loop ends; return whatever the last outcome was.
      return {
        final: outcome,
        attempts: [...attempts],
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (backoffMs > 0) {
      await sleepWithAbort(backoffMs, options.abortSignal);
      if (isAborted(options.abortSignal)) {
        throw new RetryAbortedError(
          `Retry run aborted during backoff after attempt ${n}.`,
        );
      }
    }
  }

  // The loop above always returns; this line is unreachable but satisfies
  // the type checker and documents the invariant.
  if (lastOutcome === null) {
    throw new RetryAbortedError("Retry loop exited without producing an outcome.");
  }
  return {
    final: lastOutcome,
    attempts: [...attempts],
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * A convenience wrapper for the common selector-fallback flow: build the
 * candidate list once, then for each candidate attempt resolution; stop on
 * first success. The caller supplies a factory that turns an attempt number
 * into a candidate so this module never imports `selectors.ts` and does not
 * create a cycle.
 *
 * Semantics: an "attempt" for a selector run is per-candidate. Backoff
 * still applies between candidates (a slow, warming page can benefit), but
 * the default `baseBackoffMs` for selector runs is short. Callers can
 * override by passing their own options.
 */
export async function runSelectorAttempts<T>(
  candidates: readonly (readonly [number, () => Promise<AttemptOutcome<T>>])[],
  options: RetryOptions<T> = {},
): Promise<RetryHistory<T>> {
  if (candidates.length === 0) {
    return {
      final: {
        kind: "fatal",
        reason: "no-candidates",
        detail: "No selector candidates were supplied to runSelectorAttempts.",
      },
      attempts: [],
      elapsedMs: 0,
    };
  }
  // Build a map from attempt number to candidate for O(1) lookup.
  const byAttempt = new Map<number, () => Promise<AttemptOutcome<T>>>();
  for (const [n, fn] of candidates) byAttempt.set(n, fn);

  const attempt = async (n: number): Promise<AttemptOutcome<T>> => {
    const fn = byAttempt.get(n);
    if (fn === undefined) {
      return {
        kind: "fatal",
        reason: "candidate-exhausted",
        detail: `No candidate available for attempt ${n}.`,
      };
    }
    return await fn();
  };

  return await runWithRetry(attempt, {
    ...options,
    maxAttempts: options.maxAttempts ?? candidates.length,
  });
}

/* -------------------------------------------------------------------------- */
/* Error classification                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Map an arbitrary thrown error into an `AttemptOutcome` classification.
 * The rules are:
 *   - Closed page/context → fatal (nothing can revive a closed page).
 *   - Timeout → transient (retry is exactly the right response).
 *   - Element-not-attached / element-detached during action → transient.
 *   - Network errors (`net::`) → transient.
 *   - Everything else → transient with the error's message, *unless* the
 *     caller passes a `knownFatal` predicate.
 *
 * Returning `transient` by default is deliberate: for resilience, an
 * unknown error that could be a transient state should be retried once and
 * then surfaced. The attempt history preserves the error message regardless
 * of classification.
 */
export interface ClassifyOptions {
  /** Additional predicate that labels an error fatal before the default rules. */
  readonly knownFatal?: (error: unknown) => boolean;
}

export function classifyError<T>(error: unknown, options: ClassifyOptions = {}): AttemptOutcome<T> {
  if (options.knownFatal?.(error) === true) {
    return {
      kind: "fatal",
      reason: "known-fatal",
      detail: describeError(error),
    };
  }
  if (error === null || typeof error !== "object") {
    return {
      kind: "transient",
      reason: "non-error-thrown",
      detail: String(error),
    };
  }
  const name = (error as { name?: unknown }).name;
  const message = (error as { message?: unknown }).message;
  const text = typeof message === "string" ? message : "";

  if (typeof name === "string" && name === "TimeoutError") {
    return { kind: "transient", reason: "timeout", detail: text };
  }
  if (text.includes("Timeout ")) {
    return { kind: "transient", reason: "timeout", detail: text };
  }
  if (
    text.includes("Target page, context or browser has been closed") ||
    text.includes("Target closed") ||
    text.includes("Page closed") ||
    text.includes("been closed")
  ) {
    return { kind: "fatal", reason: "page-closed", detail: text };
  }
  if (
    text.includes("Element is not attached") ||
    text.includes("element is not attached") ||
    text.includes("Element is detached")
  ) {
    return { kind: "transient", reason: "detached", detail: text };
  }
  if (text.includes("net::") || text.includes("ERR_")) {
    return { kind: "transient", reason: "network", detail: text };
  }
  if (text.includes("strict mode violation")) {
    // Playwright's "resolved to N elements" — likely our CSS matched more
    // than one node. Treat as transient so the next candidate is tried; a
    // caller that expects this can pass `knownFatal`.
    return { kind: "transient", reason: "multiple-matches", detail: text };
  }
  return {
    kind: "transient",
    reason: "unclassified",
    detail: text.length > 0 ? text : "unclassified error",
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null) return "null";
  if (typeof error === "object") {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
    return "unnamed error object";
  }
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function normalisePositiveInt(raw: number | undefined, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

function computeBackoff(
  attemptNumber: number,
  baseMs: number,
  maxMs: number,
  options: RetryOptions<unknown>,
): number {
  // 2^(attemptNumber - 1) is the exponential multiplier; capped at maxMs.
  const exponent = Math.max(0, attemptNumber - 1);
  const raw = baseMs * Math.pow(2, exponent);
  const capped = Math.min(maxMs, raw);
  const rng = options.rng ?? null;
  const jitter = options.jitterFraction ?? 0;
  if (rng === null || jitter <= 0) return Math.floor(capped);
  const factor = 1 - Math.max(0, Math.min(1, jitter)) * clamp01(rng());
  return Math.floor(capped * factor);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  return signal.aborted;
}

/**
 * The attempt is wrapped so a thrown error is classified rather than
 * propagating. The caller's `attempt` should *return* an `AttemptOutcome`;
 * if it *throws*, we map the error through `classifyError`. This is a
 * safety net so a misbehaving attempt function cannot crash the whole run.
 */
async function safeAttempt<T>(
  attempt: (attemptNumber: number) => Promise<AttemptOutcome<T>>,
  attemptNumber: number,
  abortSignal: AbortSignal | undefined,
): Promise<AttemptOutcome<T>> {
  try {
    return await attempt(attemptNumber);
  } catch (error) {
    if (isAborted(abortSignal)) {
      return { kind: "fatal", reason: "aborted", detail: describeError(error) };
    }
    return classifyError<T>(error);
  }
}

function recordAttempt(
  entry: RetryAttempt,
  hook: ((entry: RetryAttempt) => void | Promise<void>) | undefined,
): void {
  if (hook === undefined) return;
  try {
    const result = hook(entry);
    if (result !== undefined && typeof (result as Promise<unknown>).then === "function") {
      // Fire-and-forget; a rejected hook must not abort the run.
      Promise.resolve(result).catch(() => {
        /* swallow hook errors by design */
      });
    }
  } catch {
    /* swallow hook errors by design */
  }
}

/**
 * Sleep that can be interrupted by an AbortSignal. Used for backoff so an
 * abort does not have to wait out a long exponential delay. Uses the base
 * `sleep` from `waits.ts` in short slices so the loop can check the signal.
 */
export async function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) return;
  const sliceMs = 100;
  let remaining = Math.floor(ms);
  while (remaining > 0) {
    if (signal.aborted) return;
    const slice = Math.min(sliceMs, remaining);
    await sleep(slice);
    remaining -= slice;
  }
}
