/**
 * Zipy AI — wait strategies for headless automation.
 *
 * The automation step executor needs a *bounded* set of "the page is ready
 * for the next action" checks. Playwright's own `waitFor*` methods cover most
 * cases, but their failure semantics are inconsistent: a timeout rejects with
 * an opaque `TimeoutError`, and long-polling pages never emit `networkidle`.
 * This module wraps each Playwright primitive with:
 *
 *   - an explicit `timeoutMs` (defaulted from `@/lib/config`), and
 *   - a `WaitOutcome` discriminated union that distinguishes:
 *       * `ready`        — the condition held within the deadline.
 *       * `timeout`      — the deadline elapsed. Never throws for timeouts;
 *                          the caller decides whether to retry or flag.
 *       * `closed`       — the page was closed before the condition held.
 *
 * The distinction matters for the resilience phase: a `timeout` on
 * `networkidle` is *expected* on a long-polling app and should be retried or
 * skipped; a `closed` is fatal for the step. Collapsing both into a throw
 * would force the step executor to parse error messages.
 *
 * Design rules honoured here:
 *  - No arbitrary sleeps. Every wait has an observable condition.
 *  - The module never invents a page or a context: it operates on the value
 *    the caller passes in, and it does not close anything.
 *  - The `PlaywrightPage` type in `browser.ts` deliberately omits the
 *    `waitFor*` methods (the browser module only needs the launch surface).
 *    We accept a structurally-wider type here and detect absence at runtime
 *    so a test double with reduced surface produces a typed `closed`/`timeout`
 *    rather than an `undefined is not a function`.
 */

import { getConfig } from "@/lib/config";

import type { PlaywrightPage } from "./browser.ts";

/* -------------------------------------------------------------------------- */
/* Outcome                                                                     */
/* -------------------------------------------------------------------------- */

export type WaitOutcome =
  | {
      readonly status: "ready";
      readonly condition: WaitConditionName;
      readonly elapsedMs: number;
      readonly detail?: string;
    }
  | {
      readonly status: "timeout";
      readonly condition: WaitConditionName;
      readonly elapsedMs: number;
      readonly detail?: string;
    }
  | {
      readonly status: "closed";
      readonly condition: WaitConditionName;
      readonly elapsedMs: number;
      readonly detail?: string;
    };

export type WaitConditionName =
  | "load"
  | "domcontentloaded"
  | "networkidle"
  | "visible"
  | "hidden"
  | "attached"
  | "detached"
  | "enabled"
  | "text"
  | "url"
  | "stable";

/**
 * Rich surface the wait helpers need. Playwright's Page satisfies it; the
 * `browser.ts` module's narrower `PlaywrightPage` does not. We declare the
 * extra methods locally to avoid widening the browser interface to all of
 * Playwright.
 */
export interface WaitablePage extends PlaywrightPage {
  waitForLoadState?(
    state: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number },
  ): Promise<void>;
  waitForSelector?(
    selector: string,
    options?: {
      state?: "attached" | "detached" | "visible" | "hidden";
      timeout?: number;
#ifdef NeverFalse // (illustrative only; not emitted)
#endif
    },
  ): Promise<unknown>;
  waitForURL?(
    url: string | RegExp | ((url: URL) => boolean),
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number },
  ): Promise<void>;
  waitForFunction?<T = unknown>(
    predicate: string | ((arg: unknown) => T),
    arg?: unknown,
    options?: { timeout?: number; polling?: number | "raf" },
  ): Promise<unknown>;
  isClosed?(): boolean;
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

export interface WaitOptions {
  /** Deadline in milliseconds. Defaults per-condition (see `DEFAULT_TIMEOUTS`). */
  readonly timeoutMs?: number;
  /**
   * When true, a `timeout` outcome is logged to stderr with the condition
   * name and elapsed time. Never logs page content, credentials or URLs with
   * query strings. Used by the step executor to keep an observable trace
   * without a logging framework.
   */
  readonly trace?: boolean;
}

const DEFAULT_TIMEOUTS: Readonly<Record<WaitConditionName, number>> = {
  load: 45_000,
  domcontentloaded: 30_000,
  networkidle: 15_000,
  visible: 15_000,
  hidden: 15_000,
  attached: 15_000,
  detached: 15_000,
  enabled: 10_000,
  text: 10_000,
  url: 30_000,
  stable: 2_000,
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function resolveTimeout(condition: WaitConditionName, override: number | undefined): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const config = getConfig().browser;
  // For load/domcontentloaded/networkidle fall back to the configured defaults
  // when they exist, so a single env var changes both the browser default and
  // these waits.
  if (condition === "load" || condition === "domcontentloaded" || condition === "networkidle") {
    return Math.max(
      DEFAULT_TIMEOUTS[condition],
      typeof config.navigationTimeoutMs === "number"
        ? config.navigationTimeoutMs
        : DEFAULT_TIMEOUTS[condition],
    );
  }
  return Math.max(
    DEFAULT_TIMEOUTS[condition],
    typeof config.defaultTimeoutMs === "number"
      ? config.defaultTimeoutMs
      : DEFAULT_TIMEOUTS[condition],
  );
}

/**
 * Playwright's timeout errors have `name === "TimeoutError"`. We check the
 * name and, when available, the `message`. This is the canonical text
 * Playwright uses; matching on it here keeps the caller free of string
 * sniffing.
 */
function isTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as { name?: unknown; message?: unknown };
  if (e.name === "TimeoutError") return true;
  if (typeof e.message === "string" && e.message.includes("Timeout ")) return true;
  return false;
}

function isClosedError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const e = error as { message?: unknown };
  if (typeof e.message !== "string") return false;
  return (
    e.message.includes("Target page, context or browser has been closed") ||
    e.message.includes("Target closed") ||
    e.message.includes("Page closed") ||
    e.message.includes("been closed")
  );
}

function pageIsClosed(page: WaitablePage): boolean {
  if (typeof page.isClosed !== "function") return false;
  try {
    return page.isClosed();
  } catch {
    return false;
  }
}

async function runWait(
  page: WaitablePage,
  condition: WaitConditionName,
  timeoutMs: number,
  run: () => Promise<void>,
): Promise<WaitOutcome> {
  if (pageIsClosed(page)) {
    return {
      status: "closed",
      condition,
      elapsedMs: 0,
      detail: "The page was closed before the wait started.",
    };
  }
  const started = Date.now();
  try {
    await run();
    return {
      status: "ready",
      condition,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    if (isTimeoutError(error)) {
      return {
        status: "timeout",
        condition,
        elapsedMs,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (isClosedError(error)) {
      return {
        status: "closed",
        condition,
        elapsedMs,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    // Unexpected error: surface it rather than masking it as a timeout.
    throw error;
  }
}

function traceWait(outcome: WaitOutcome, trace: boolean | undefined): void {
  if (trace !== true) return;
  if (outcome.status === "ready") return;
  // eslint-disable-next-line no-console
  console.error(
    `[zipy/automation] wait ${outcome.condition} -> ${outcome.status} after ${outcome.elapsedMs}ms${
      outcome.detail !== undefined ? ` (${outcome.detail})` : ""
    }`,
  );
}

/* -------------------------------------------------------------------------- */
/* Load-state waits                                                            */
/* -------------------------------------------------------------------------- */

export async function waitForLoad(
  page: WaitablePage,
  options: WaitOptions = {},
): Promise<WaitOutcome> {
  return await waitForLoadState(page, "load", options);
}

export async function waitForDomContentLoaded(
  page: WaitablePage,
  options: WaitOptions = {},
): Promise<WaitOutcome> {
  return await waitForLoadState(page, "domcontentloaded", options);
}

/**
 * Wait for network idle. This is the most fragile wait in practice: SPA
 * applications with polling sockets rarely reach it. Callers should treat a
 * `timeout` outcome here as expected and fall back to an element-visible
 * wait, rather than as a step failure.
 */
export async function waitForNetworkIdle(
  page: WaitablePage,
  options: WaitOptions = {},
): Promise<WaitOutcome> {
  return await waitForLoadState(page, "networkidle", options);
}

/**
 * Wait for a Playwright load state by name. When the page lacks
 * `waitForLoadState` (a reduced test double), the wait returns `closed`
 * immediately with a descriptive detail rather than pretending the page is
 * ready.
 */
export async function waitForLoadState(
  page: WaitablePage,
  state: "load" | "domcontentloaded" | "networkidle",
  options: WaitOptions = {},
): Promise<WaitOutcome> {
  if (typeof page.waitForLoadState !== "function") {
    return {
      status: "closed",
      condition: state,
      elapsedMs: 0,
      detail:
        "The page does not expose `waitForLoadState`. It is not a real Playwright Page.",
    };
  }
  const timeoutMs = resolveTimeout(state, options.timeoutMs);
  const outcome = await runWait(page, state, timeoutMs, () =>
    (page.waitForLoadState as NonNullable<WaitablePage["waitForLoadState"]>)(state, {
      timeout: timeoutMs,
    }),
  );
  traceWait(outcome, options.trace);
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Element waits                                                               */
/* -------------------------------------------------------------------------- */

export type SelectorState = "attached" | "detached" | "visible" | "hidden";

export interface WaitForSelectorOptions extends WaitOptions {
  readonly state?: SelectorState;
}

/**
 * Wait for an element to reach a given state. Returns `timeout` (rather than
 * throwing) when the state is not reached; the caller decides whether to try
 * a fallback selector (retry.ts owns that policy).
 */
export async function waitForSelector(
  page: WaitablePage,
  selector: string,
  options: WaitForSelectorOptions = {},
): Promise<WaitOutcome> {
  const state: SelectorState = options.state ?? "visible";
  if (typeof page.waitForSelector !== "function") {
    return {
      status: "closed",
      condition: state,
      elapsedMs: 0,
      detail: "The page does not expose `waitForSelector`.",
    };
  }
  const timeoutMs = resolveTimeout(state, options.timeoutMs);
  const outcome = await runWait(page, state, timeoutMs, async () => {
    await (page.waitForSelector as NonNullable<WaitablePage["waitForSelector"]>)(selector, {
      state,
      timeout: timeoutMs,
    });
  });
  traceWait(outcome, options.trace);
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* URL waits                                                                   */
/* -------------------------------------------------------------------------- */

export interface WaitForUrlOptions extends WaitOptions {
  readonly waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
}

export async function waitForUrl(
  page: WaitablePage,
  url: string | RegExp | ((url: URL) => boolean),
  options: WaitForUrlOptions = {},
): Promise<WaitOutcome> {
  if (typeof page.waitForURL !== "function") {
    return {
      status: "closed",
      condition: "url",
      elapsedMs: 0,
      detail: "The page does not expose `waitForURL`.",
    };
  }
  const timeoutMs = resolveTimeout("url", options.timeoutMs);
  const outcome = await runWait(page, "url", timeoutMs, async () => {
    await (page.waitForURL as NonNullable<WaitablePage["waitForURL"]>)(url, {
      timeout: timeoutMs,
      waitUntil: options.waitUntil ?? "load",
    });
  });
  traceWait(outcome, options.trace);
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Predicate waits                                                             */
/* -------------------------------------------------------------------------- */

export interface WaitForFunctionOptions extends WaitOptions {
  /** Polling strategy in ms, or "raf" to poll on animation frames. Default 100ms. */
  readonly polling?: number | "raf";
}

/**
 * Wait for an arbitrary in-page predicate to return a truthy value. The
 * predicate is a string (evaluated in the page) or a function that receives
 * the optional argument. The function must not reference outer scope — it
 * runs in the browser.
 */
export async function waitForFunction<T = unknown>(
  page: WaitablePage,
  predicate: string | ((arg: unknown) => T),
  arg: unknown = undefined,
  options: WaitForFunctionOptions = {},
): Promise<WaitOutcome> {
  if (typeof page.waitForFunction !== "function") {
    return {
      status: "closed",
      condition: "stable",
      elapsedMs: 0,
      detail: "The page does not expose `waitForFunction`.",
    };
  }
  const timeoutMs = resolveTimeout("stable", options.timeoutMs);
  const outcome = await runWait(page, "stable", timeoutMs, async () => {
    await (page.waitForFunction as NonNullable<WaitablePage["waitForFunction"]>)(
      predicate as string | ((arg: unknown) => T),
      arg,
      { timeout: timeoutMs, polling: options.polling ?? 100 },
    );
  });
  traceWait(outcome, options.trace);
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Composite readiness                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Result of a composite "page is ready" check. `ready` is true only when the
 * chosen readiness strategy held; a networkidle timeout alone is not fatal
 * when the visible anchor was found.
 */
export interface PageReadyOutcome {
  readonly status: "ready" | "timeout" | "closed";
  readonly network: WaitOutcome;
  readonly anchor: WaitOutcome | null;
  readonly elapsedMs: number;
  readonly detail: string;
}

export interface PageReadyOptions {
  /**
   * Selector to treat as "the page has rendered its content". When supplied
   * and networkidle times out, a passing anchor wait rescues the readiness
   * check. When omitted, networkidle alone decides.
   */
  readonly anchorSelector?: string | null;
  readonly networkTimeoutMs?: number;
  readonly anchorTimeoutMs?: number;
  readonly trace?: boolean;
}

/**
 * The recommended readiness check for interactive workflows:
 *
 *   1. Wait for domcontentloaded (fast, always fires).
 *   2. Wait for networkidle with a bounded timeout.
 *   3. If networkidle timed out *and* an anchor selector is provided,
 *      wait for that selector. Success here overrides the network timeout.
 *   4. If the page closed at any stage, return `closed`.
 *
 * The function never throws for a soft failure — it returns a structured
 * outcome so the caller (the step executor) can decide whether to press on.
 */
export async function waitForPageReady(
  page: WaitablePage,
  options: PageReadyOptions = {},
): Promise<PageReadyOutcome> {
  const started = Date.now();
  const dcl = await waitForLoadState(page, "domcontentloaded", {
    timeoutMs: options.networkTimeoutMs,
    trace: options.trace,
  });
  if (dcl.status === "closed") {
    return {
      status: "closed",
      network: dcl,
      anchor: null,
      elapsedMs: Date.now() - started,
      detail: "The page closed before domcontentloaded.",
    };
  }
  const network = await waitForNetworkIdle(page, {
    timeoutMs: options.networkTimeoutMs,
    trace: options.trace,
  });
  if (network.status === "closed") {
    return {
      status: "closed",
      network,
      anchor: null,
      elapsedMs: Date.now() - started,
      detail: "The page closed during the networkidle wait.",
    };
  }
  if (network.status === "ready") {
    return {
      status: "ready",
      network,
      anchor: null,
      elapsedMs: Date.now() - started,
      detail: "domcontentloaded and networkidle both completed.",
    };
  }
  // networkidle timed out. Try the anchor selector.
  const anchorSelector = options.anchorSelector ?? null;
  if (anchorSelector === null) {
    return {
      status: "timeout",
      network,
      anchor: null,
      elapsedMs: Date.now() - started,
      detail:
        "networkidle did not settle and no anchor selector was provided to confirm readiness.",
    };
  }
  const anchor = await waitForSelector(page, anchorSelector, {
    state: "visible",
    timeoutMs: options.anchorTimeoutMs,
    trace: options.trace,
  });
  if (anchor.status === "closed") {
    return {
      status: "closed",
      network,
      anchor,
      elapsedMs: Date.now() - started,
      detail: "The page closed while waiting for the anchor selector.",
    };
  }
  if (anchor.status === "ready") {
    return {
      status: "ready",
      network,
      anchor,
      elapsedMs: Date.now() - started,
      detail: `networkidle timed out but anchor "${anchorSelector}" became visible.`,
    };
  }
  return {
    status: "timeout",
    network,
    anchor,
    elapsedMs: Date.now() - started,
    detail: `networkidle timed out and anchor "${anchorSelector}" was not visible within the deadline.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Fixed top-of-run delay (used only when the caller asks for it)              */
/* -------------------------------------------------------------------------- */

/**
 * Sleep for the given number of milliseconds. Exposed because the *capture*
 * module needs a bounded settle delay after actions that trigger layout
 * animations and there is no reliable rendering event to wait on for that
 * specific case. It must never be used as a substitute for a real condition
 * check; the caller is expected to pass a small value (≤ 500 ms).
 */
export async function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(ms)));
}
