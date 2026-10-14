/**
 * Zipy AI — LLM fallback chains (phase 25, batch 3).
 *
 * A provider-agnostic "try A, then B, then C" executor around the adapter
 * interface from `adapter.ts`. The build plan (plan-1) is a local-first
 * default with optional hosted overrides; this module makes that decision an
 * *observable runtime behaviour* rather than a documentation claim: the
 * caller declares a chain, the executor runs it, and the result records
 * which provider actually produced the output and which providers failed.
 *
 * Design rules honoured here:
 *
 *  - **No default invented from nothing.** The chain is caller-supplied.
 *    When a chain is empty the executor throws `empty-chain` with a
 *    descriptive message; it does not fall back to a "default" provider
 *    that might not be configured.
 *
 *  - **Provider configuration is the caller's contract.** This module does
 *    not read `config.ts`. It receives `attempts`, each a typed
 *    `ChainAttempt` with an `invoke` function. The adapter caller decides
 *    which configured providers are eligible and in what order. A chain
 *    constructor that read secrets from the environment would hide the "is
 *    this provider configured" question from the code path the operator
 *    audits, and would collide with the BYO-key model where a workspace's
 *    own key is supplied per-request.
 *
 *  - **Bounded, observable retries.** Each attempt carries its own
 *    `maxAttempts` and `timeoutMs`. The executor runs attempts in order and
 *    stops on the first success. An exponential backoff is applied between
 *    failed retries of the same provider; providers are not separated by a
 *    backoff (the second provider's first attempt should not be slowed by
 *    the first provider's transient error).
 *
 *  - **Every failure is recorded.** The result distinguishes "provider
 *    returned a non-retryable error", "provider timed out", "provider
 *    failed after N retries", "attempt was ineligible" and "caller aborted
 *    before the chain ran". An operator looking at a support ticket can
 *    see exactly how far the chain got without re-running it.
 *
 *  - **Abort signal is honoured.** An `AbortSignal` cancels in-flight
 *    attempts and prevents the next attempt from starting, so fallback is
 *    usable inside a request handler with a user who may navigate away.
 *
 *  - **Deterministic for a fixed input.** The chain order is fixed by the
 *    caller; the module does not shuffle, sort or "optimise" the order.
 *    Cost tracking (`costTracking.ts`) and prompt versioning
 *    (`promptVersions.ts`) rely on this being a pure pass-through.
 *
 * Exports:
 *   - Types: `ChainAttempt`, `ChainRequest`, `ChainResult`,
 *     `ChainAttemptFailure`, `ChainAttemptSuccess`.
 *   - Functions: `runFallbackChain`, `summariseChainResult`,
 *     `buildChainFromConfigured`.
 *   - `FallbackChainError`, `FallbackChainErrorCode`.
 */

import { readClassifier, withClassifier, type ClassifiedAttempt } from "./fallbackChainExecutorPatch";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type FallbackChainErrorCode =
  | "invalid-input"
  | "empty-chain"
  | "aborted";

export class FallbackChainError extends Error {
  readonly code: FallbackChainErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: FallbackChainErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A single attempt in the chain. `name` is a stable identifier the caller
 * chooses — typically `<provider>:<model>` — and is echoed in the result.
 *
 * `invoke` is called with the request payload and an `AbortSignal` that the
 * caller should pass through to the underlying HTTP client. This module
 * never calls a network API itself.
 */
export interface ChainAttempt<TRequest, TResponse> {
  readonly name: string;
  /**
   * Whether the attempt is eligible for this request. This is *not* a
   * runtime retry decision; it is the caller's pre-check ("is this provider
   * configured for this workspace?"). An attempt with `eligible: false` is
   * skipped and recorded as `skipped`.
   */
  readonly eligible: boolean;
  readonly invoke: (payload: TRequest, signal: AbortSignal) => Promise<TResponse>;
  /** Retries *after* the first attempt. Default 1 (a single retry). */
  readonly maxAttempts?: number;
  /** Per-attempt timeout in ms. Default 60_000; the adapter's own default should match. */
  readonly timeoutMs?: number;
  /** Backoff base in ms between retries of *this* attempt. Default 250. */
  readonly backoffBaseMs?: number;
}

export interface ChainRequest<TRequest> {
  readonly payload: TRequest;
  /** An optional signal the caller already holds; the executor wraps it. */
  readonly signal?: AbortSignal;
  /**
   * Non-retryable error classifier. Called with a thrown value; when it
   * returns `true`, the executor does not retry this provider and moves on
   * to the next attempt. Default: everything is retryable.
   */
  readonly isNonRetryable?: (error: unknown) => boolean;
}

export type ChainAttemptFailure =
  | {
      readonly kind: "failed";
      readonly name: string;
      /** The provider attempts made; ≥1 once a try has been issued. */
      readonly attempts: number;
      readonly message: string;
      readonly code: string | null;
      /** Whether the failure was classified as non-retryable. */
      readonly nonRetryable: boolean;
    }
  | {
      readonly kind: "skipped";
      readonly name: string;
      readonly reason: string;
    }
  | {
      readonly kind: "timed-out";
      readonly name: string;
      readonly timeoutMs: number;
      readonly attempts: number;
    };

export interface ChainAttemptSuccess<TResponse> {
  readonly name: string;
  readonly response: TResponse;
  /** The provider attempts made before the success (1 means first try). */
  readonly attempts: number;
  readonly durationMs: number;
}

export interface ChainResult<TResponse> {
  readonly ok: boolean;
  readonly success: ChainAttemptSuccess<TResponse> | null;
  readonly failures: readonly ChainAttemptFailure[];
  /** Total wall-clock duration of the chain, in ms. */
  readonly totalDurationMs: number;
  /**
   * The order in which the executor visited the attempts, including
   * skipped ones. Useful for the audit log: "why did this run go to
   * provider B" is answered by looking at the sequence.
   */
  readonly visited: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Executor                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run the chain. Attempts are visited in the given order. An eligible
 * attempt is retried up to `maxAttempts` (default 1 retry, i.e. up to two
 * tries) with `backoffBaseMs` exponential backoff between retries. The
 * first attempt to succeed ends the chain and its response is returned.
 *
 * When every eligible attempt fails, the chain returns `ok: false` with the
 * full failure list. The executor does *not* throw on chain exhaustion —
 * the caller decides whether "every provider failed" is a 503, a fall back
 * to a deterministic template, or a queue for later. Throwing here would
 * force a try/catch in every call site.
 *
 * The executor throws only on `invalid-input`, `empty-chain` and `aborted`.
 */
export async function runFallbackChain<TRequest, TResponse>(
  attempts: readonly ChainAttempt<TRequest, TResponse>[],
  request: ChainRequest<TRequest>,
): Promise<ChainResult<TResponse>> {
  if (!Array.isArray(attempts)) {
    throw new FallbackChainError("`attempts` must be an array.", "invalid-input");
  }
  if (attempts.length === 0) {
    throw new FallbackChainError(
      "The fallback chain is empty. The caller must supply at least one attempt (an LLM provider in local or hosted mode).",
      "empty-chain",
    );
  }
  if (request === null || typeof request !== "object") {
    throw new FallbackChainError("`request` must be an object.", "invalid-input");
  }
  if (request.signal?.aborted === true) {
    throw new FallbackChainError(
      "The request signal was already aborted before the chain started.",
      "aborted",
    );
  }

  const startedAt = Date.now();
  const failures: ChainAttemptFailure[] = [];
  const visited: string[] = [];

  for (const attempt of attempts) {
    if (attempt === null || typeof attempt !== "object" || typeof attempt.name !== "string") {
      throw new FallbackChainError(
        "Each attempt must be an object with a `name` and an `invoke` function.",
        "invalid-input",
      );
    }
    if (typeof attempt.invoke !== "function") {
      throw new FallbackChainError(
        `Attempt "${attempt.name}" is missing an \`invoke\` function.`,
        "invalid-input",
        { name: attempt.name },
      );
    }
    visited.push(attempt.name);

    if (request.signal?.aborted === true) {
      throw new FallbackChainError("The request signal was aborted mid-chain.", "aborted");
    }

    if (attempt.eligible !== true) {
      failures.push({
        kind: "skipped",
        name: attempt.name,
        reason:
          "Attempt is not eligible for this request (typically: provider not configured for this workspace).",
      });
      continue;
    }

    const maxAttempts =
      typeof attempt.maxAttempts === "number" && attempt.maxAttempts >= 1
        ? Math.floor(attempt.maxAttempts)
        : 1;
    const totalTries = maxAttempts + 1; // one initial try plus retries
    const timeoutMs =
      typeof attempt.timeoutMs === "number" && attempt.timeoutMs > 0
        ? Math.floor(attempt.timeoutMs)
        : 60_000;
    const backoffBaseMs =
      typeof attempt.backoffBaseMs === "number" && attempt.backoffBaseMs >= 0
        ? Math.floor(attempt.backoffBaseMs)
        : 250;
    const isNonRetryable = readClassifier(attempt, request);

    let lastError: unknown = null;
    let recorded = false;
    let attemptNumber = 0;

    for (let tryIndex = 0; tryIndex < totalTries; tryIndex += 1) {
      attemptNumber = tryIndex + 1;
      const perAttemptStartedAt = Date.now();
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const composedSignal = composeSignals(request.signal, timeoutController.signal);

      try {
        const response = await attempt.invoke(request.payload, composedSignal);
        clearTimeout(timer);
        return {
          ok: true,
          success: {
            name: attempt.name,
            response,
            attempts: attemptNumber,
            durationMs: Date.now() - perAttemptStartedAt,
          },
          failures,
          totalDurationMs: Date.now() - startedAt,
          visited,
        };
      } catch (err) {
        clearTimeout(timer);
        lastError = err;

        if (request.signal?.aborted === true) {
          throw new FallbackChainError("The request signal was aborted mid-chain.", "aborted");
        }

        if (timeoutController.signal.aborted) {
          // The per-attempt timeout cancelled this try (and, because the
          // caller's signal is not the one that aborted, the timeout, not
          // the caller, is the cause). Retry if retries remain; otherwise
          // record a "timed-out" entry and move on.
          if (tryIndex < totalTries - 1) {
            await sleep(backoffBaseMs * 2 ** tryIndex, request.signal);
            continue;
          }
          failures.push({
            kind: "timed-out",
            name: attempt.name,
            timeoutMs,
            attempts: attemptNumber,
          });
          recorded = true;
          break;
        }

        if (isNonRetryable(err)) {
          failures.push({
            kind: "failed",
            name: attempt.name,
            attempts: attemptNumber,
            message: err instanceof Error ? err.message : String(err),
            code: readErrorCode(err),
            nonRetryable: true,
          });
          recorded = true;
          break;
        }

        if (tryIndex < totalTries - 1) {
          await sleep(backoffBaseMs * 2 ** tryIndex, request.signal);
          continue;
        }

        // Out of retries; record the failure below.
        break;
      }
    }

    if (!recorded) {
      failures.push({
        kind: "failed",
        name: attempt.name,
        attempts: attemptNumber,
        message:
          lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error"),
        code: readErrorCode(lastError),
        nonRetryable: false,
      });
    }
  }

  return {
    ok: false,
    success: null,
    failures,
    totalDurationMs: Date.now() - startedAt,
    visited,
  };
}

/**
 * One-line summary of a chain result for the audit log and the failure
 * banner. Stable wording; tests assert the shape of `visited` and
 * `failures` rather than the exact string.
 */
export function summariseChainResult<TResponse>(result: ChainResult<TResponse>): string {
  if (result.ok && result.success !== null) {
    const { name, attempts, durationMs } = result.success;
    const retried =
      attempts > 1 ? ` after ${attempts - 1} retr${attempts - 1 === 1 ? "y" : "ies"}` : "";
    return `Fallback chain succeeded on "${name}"${retried} in ${durationMs}ms.`;
  }
  const visited = result.visited.join(" → ");
  const first = result.failures[0];
  const summary =
    first === undefined
      ? "No provider was visited."
      : first.kind === "skipped"
        ? `No eligible provider was available (first skipped: "${first.name}" — ${first.reason})`
        : first.kind === "timed-out"
          ? `Every provider failed; the first failure was a ${first.timeoutMs}ms timeout on "${first.name}".`
          : `Every provider failed; the first failure was on "${first.name}": ${first.message}`;
  return `Fallback chain exhausted after visiting [${visited}]. ${summary}`;
}

/**
 * Build a chain from a list of providers the operator has configured. The
 * caller supplies, per provider, an "is it configured" flag and an invoke
 * function; the function produces a `ChainAttempt[]` with `eligible` set
 * accordingly and in the caller's order.
 *
 * This is deliberately a thin shim, not a policy: it does not "pick the
 * best provider", and it does not add a default to the tail. If every
 * provider is unconfigured, the resulting chain has entries but every
 * entry's `eligible` is `false`, and `runFallbackChain` returns a chain
 * result with all attempts skipped — the operator sees exactly what was
 * missing. That is the correct shape for the "no LLM configured" case: an
 * explicit error, not a fabricated response.
 */
export function buildChainFromConfigured<TRequest, TResponse>(
  providers: readonly {
    readonly name: string;
    readonly configured: boolean;
    readonly invoke: (payload: TRequest, signal: AbortSignal) => Promise<TResponse>;
    readonly maxAttempts?: number;
    readonly timeoutMs?: number;
    readonly backoffBaseMs?: number;
  }[],
): readonly ChainAttempt<TRequest, TResponse>[] {
  if (!Array.isArray(providers)) {
    throw new FallbackChainError("`providers` must be an array.", "invalid-input");
  }
  return providers.map((p) => {
    if (
      p === null ||
      typeof p !== "object" ||
      typeof p.name !== "string" ||
      p.name.trim().length === 0
    ) {
      throw new FallbackChainError("Each provider entry must have a non-empty `name`.", "invalid-input");
    }
    if (typeof p.invoke !== "function") {
      throw new FallbackChainError(
        `Provider "${p.name}" must supply an \`invoke\` function.`,
        "invalid-input",
        { name: p.name },
      );
    }
    const attempt: ChainAttempt<TRequest, TResponse> = {
      name: p.name,
      eligible: p.configured === true,
      invoke: p.invoke,
      maxAttempts: p.maxAttempts,
      timeoutMs: p.timeoutMs,
      backoffBaseMs: p.backoffBaseMs,
    };
    return attempt;
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function readErrorCode(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function composeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (a === undefined) return b;
  if (a.aborted) return a;
  const controller = new AbortController();
  const onAbortA = (): void => controller.abort();
  const onAbortB = (): void => controller.abort();
  a.addEventListener("abort", onAbortA, { once: true });
  b.addEventListener("abort", onAbortB, { once: true });
  return controller.signal;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new FallbackChainError("Aborted during backoff.", "aborted"));
      return;
    }
    const delay = Math.max(0, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new FallbackChainError("Aborted during backoff.", "aborted"));
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/* -------------------------------------------------------------------------- */
/* Public helper: attach a per-attempt classifier                              */
/* -------------------------------------------------------------------------- */

/**
 * Attach a per-attempt retry classifier. See the module header of
 * `fallbackChainExecutorPatch.ts` for the rationale and precedence rules.
 */
export function withNonRetryableClassifier<TRequest, TResponse>(
  attempt: ChainAttempt<TRequest, TResponse>,
  classifier: (request: ChainRequest<TRequest>, error: unknown) => boolean,
): ClassifiedAttempt<TRequest, TResponse> {
  return withClassifier(attempt, classifier);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  composeSignals,
  sleep,
  readErrorCode,
});
