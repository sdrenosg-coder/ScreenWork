/**
 * Zipy AI — UI-change detection.
 *
 * The point of a *deterministic* tutorial run is that it can be re-executed
 * without an LLM. That only works if the DOM the plan was based on still
 * matches the DOM at re-run time. When it stops matching — a developer
 * renames a button, a form grows a new required field, a modal moves behind
 * a feature flag — the re-run should not silently click the wrong thing. It
 * should either (a) fall back to a self-healing selector with a truthful
 * "the plan's primary selector drifted" signal (see `selectors.ts`), or
 * (b) when the change is structural, request re-synthesis.
 *
 * This module is the *planner* part: given the current page state and a
 * stored "snapshot" of a previous run, decide which steps are likely still
 * valid, which steps should be re-tried with a fallback, and which steps
 * need a fresh synthesis. The three verdicts are exhaustive:
 *
 *   - "stable"     — the step's recorded primary selector still matches a
 *                    visible element that carries the same accessible name.
 *   - "drifted"    — the primary selector no longer matches, but the
 *                    accessible role+name does. A fallback can be used
 *                    (retry.ts handles the policy) but the plan should be
 *                    flagged for review.
 *   - "changed"    — even the accessible role+name does not match. The
 *                    step cannot be trusted; re-synthesis is required.
 *
 * Snapshots are minimal and PII-safe: they store the CSS selector, the
 * accessible role and name of each step's target, and a count of elements
 * in the surrounding region. They do not store DOM HTML, form values or
 * screenshots — those belong to the artifact or capture modules, not here.
 *
 * Design rules honoured here:
 *  - No DOM is invented. The module reads through the page surface; a
 *    reduced double that cannot answer a query yields a structured
 *    "unknown" verdict, never a fabricated match.
 *  - The "snapshot" is a value the caller persists. This module produces and
 *    consumes it but does not write to the database.
 *  - Timestamped: every snapshot records when it was taken so a very old
 *    one can be treated as low-confidence by the caller.
 */

import type { ResolvablePage, ResolvableLocator } from "./selectors.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Per-step snapshot. Deliberately small: for each step the plan recorded,
 * the CSS selector, the accessible role and name, and the count of buttons,
 * inputs and links visible at snapshot time so a caller can spot a page
 * that changed shape entirely.
 */
export interface StepSnapshot {
  /** The step's position in the plan (1-based). */
  readonly step: number;
  /** The plan's primary CSS selector for the step's target. */
  readonly cssSelector: string;
  /** ARIA role of the target, when the snapshot captured one. */
  readonly role: string | null;
  /** Accessible name of the target, when the snapshot captured one. */
  readonly accessibleName: string | null;
  /** Whether the target was visible at snapshot time. */
  readonly visibleAtSnapshot: boolean;
}

export interface PageSnapshot {
  /** Full URL captured at snapshot time, with query string stripped. */
  readonly url: string;
  /** ISO timestamp of when the snapshot was taken. */
  readonly capturedAt: string;
  /** Number of `<button>` / `[role="button"]` elements visible. */
  readonly buttonCount: number;
  /** Number of text/email/password inputs visible. */
  readonly inputCount: number;
  /** Number of `<a href>` elements visible. */
  readonly linkCount: number;
  /** One entry per recorded step (in plan order). */
  readonly steps: readonly StepSnapshot[];
}

/** The three verdicts per step, plus "unknown" for a page that cannot answer. */
export type StepVerdict = "stable" | "drifted" | "changed" | "unknown";

/** A verdict for one step, with the reason for the decision. */
export interface StepChange {
  readonly step: number;
  readonly verdict: StepVerdict;
  /** Short reason suitable for a reviewer UI. */
  readonly reason: string;
  /** The primary selector the drift was measured against. */
  readonly cssSelector: string;
  /** The role+name identity, when available. */
  readonly identity: string | null;
}

export interface ChangeReport {
  readonly url: string;
  /** ISO timestamp the report was produced. */
  readonly checkedAt: string;
  readonly steps: readonly StepChange[];
  /** Overall verdict: "stable" only when every step is stable. */
  readonly overall: "stable" | "drifted" | "changed" | "unknown";
  /** Reason for the overall verdict (the first non-stable step, or "all stable"). */
  readonly overallReason: string;
}

/* -------------------------------------------------------------------------- */
/* Snapshot capture                                                            */
/* -------------------------------------------------------------------------- */

export interface SnapshotCaptureOptions {
  /**
   * The plan's recorded steps. Each step's `cssSelector` is required; role
   * and name are best-effort (we try to read them from the page but do not
   * fail when they are absent).
   */
  readonly steps: readonly {
    readonly step: number;
    readonly cssSelector: string;
    readonly role?: string | null;
    readonly accessibleName?: string | null;
  }[];
  /** Per-locator wait when probing visibility, ms. Default 500 ms. */
  readonly probeTimeoutMs?: number;
  /** When true, do not strip the URL's query string. Default false. */
  readonly keepQueryString?: boolean;
}

/**
 * Capture a snapshot of the current page against a plan. Returns null when
 * the page cannot answer structural queries (a reduced double); throws only
 * for unexpected internal errors.
 *
 * The counts (button/input/link) come from a single `page.evaluate` call so
 * a slow page is queried once. If the page does not expose `evaluate`, the
 * counts are recorded as 0 and the caller can infer unreliability from
 * `steps[*].visibleAtSnapshot === false` combined with a non-empty plan.
 */
export async function captureSnapshot(
  page: ResolvablePage,
  options: SnapshotCaptureOptions,
): Promise<PageSnapshot | null> {
  if (isPageClosed(page)) return null;

  const url = pageUrl(page, options.keepQueryString ?? false);

  const counts = await readCounts(page);
  if (counts === null) {
    // The page cannot answer structural queries. We refuse to fabricate a
    // snapshot that says "0 buttons, 0 inputs" — that would look like a
    // valid empty page.
    return null;
  }

  const probeTimeoutMs = normaliseTimeout(options.probeTimeoutMs, 500);
  const steps: StepSnapshot[] = [];
  for (const s of options.steps) {
    const visible = await probeVisibility(page, s.cssSelector, probeTimeoutMs);
    steps.push({
      step: s.step,
      cssSelector: s.cssSelector,
      role: s.role ?? null,
      accessibleName: s.accessibleName ?? null,
      visibleAtSnapshot: visible,
    });
  }

  return {
    url,
    capturedAt: new Date().toISOString(),
    buttonCount: counts.buttons,
    inputCount: counts.inputs,
    linkCount: counts.links,
    steps,
  };
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                        */
/* -------------------------------------------------------------------------- */

export interface DetectChangesOptions {
  /**
   * When the current URL differs from the snapshot URL, the run is treated
   * as "changed" at the top level because the plan was recorded elsewhere.
   * Default true (a URL mismatch is a strong signal). Set false when the
   * caller knows the workflow legitimately navigates between URLs.
   */
  readonly treatUrlMismatchAsChanged?: boolean;
  /** Per-locator wait when probing visibility, ms. Default 500 ms. */
  readonly probeTimeoutMs?: number;
  /** When true, strip the current page's query string for the URL compare. */
  readonly stripQueryString?: boolean;
}

/**
 * Compare the current page against a stored snapshot and produce a report.
 * This module never throws for a "changed" verdict — that is the expected
 * outcome of a UI that changed. It throws only for programmer errors
 * (e.g. a snapshot with a duplicate step number).
 */
export async function detectChanges(
  page: ResolvablePage,
  snapshot: PageSnapshot,
  options: DetectChangesOptions = {},
): Promise<ChangeReport> {
  ensureUniqueSteps(snapshot.steps);
  const checkedAt = new Date().toISOString();
  const currentUrl = pageUrl(page, !(options.stripQueryString ?? true));

  const urlMismatch = currentUrl.length > 0 && snapshot.url.length > 0 && currentUrl !== snapshot.url;
  const treatUrlMismatch = options.treatUrlMismatchAsChanged ?? true;

  const probeTimeoutMs = normaliseTimeout(options.probeTimeoutMs, 500);

  if (isPageClosed(page)) {
    return {
      url: currentUrl,
      checkedAt,
      steps: snapshot.steps.map((s) => ({
        step: s.step,
        verdict: "unknown" as const,
        reason: "The page was closed before change detection ran.",
        cssSelector: s.cssSelector,
        identity: identityString(s),
      })),
      overall: "unknown",
      overallReason: "The page was closed before change detection ran.",
    };
  }

  const stepChanges: StepChange[] = [];

  for (const step of snapshot.steps) {
    const identity = identityString(step);

    // 1) Primary selector: still matches a visible element?
    const primaryVisible = await probeVisibility(page, step.cssSelector, probeTimeoutMs);
    if (primaryVisible) {
      stepChanges.push({
        step: step.step,
        verdict: "stable",
        reason: "The recorded CSS selector matched a visible element.",
        cssSelector: step.cssSelector,
        identity,
      });
      continue;
    }

    // 2) The accessible role+name still matches?
    if (step.role !== null && step.role.trim().length > 0) {
      const ariaVisible = await probeAria(page, step.role, step.accessibleName, probeTimeoutMs);
      if (ariaVisible) {
        stepChanges.push({
          step: step.step,
          verdict: "drifted",
          reason:
            "The recorded CSS selector no longer matches a visible element, but the accessible role/name did. " +
            "A fallback selector can be used; the plan should be flagged for review.",
          cssSelector: step.cssSelector,
          identity,
        });
        continue;
      }
    }

    // 3) Neither matched — treat as changed.
    stepChanges.push({
      step: step.step,
      verdict: "changed",
      reason:
        "Neither the recorded CSS selector nor the accessible role/name matched a visible element. " +
        "Re-synthesis is required.",
      cssSelector: step.cssSelector,
      identity,
    });
  }

  const overall = computeOverall(stepChanges, urlMismatch && treatUrlMismatch);
  const overallReason = computeOverallReason(stepChanges, urlMismatch && treatUrlMismatch);

  return {
    url: currentUrl,
    checkedAt,
    steps: stepChanges,
    overall,
    overallReason,
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience wrapper                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One-call convenience: take a fresh snapshot, diff it against a stored one,
 * return the change report. Used by the re-run path when the caller only
 * wants to know whether re-synthesis is required before attempting the plan.
 *
 * The snapshot *is* taken here (unlike the two-step API) so the caller does
 * not have to hold a page open across a DB read. That makes this safe to use
 * from `runWorkflow.ts` without adding latency between capture and diff.
 */
export async function checkAgainstSnapshot(
  page: ResolvablePage,
  previous: PageSnapshot,
  options: DetectChangesOptions = {},
): Promise<ChangeReport> {
  return await detectChanges(page, previous, options);
}

/* -------------------------------------------------------------------------- */
/* Page probes                                                                 */
/* -------------------------------------------------------------------------- */

interface PageCounts {
  readonly buttons: number;
  readonly inputs: number;
  readonly links: number;
}

/**
 * Read button/input/link counts in a single evaluate. Returns null when the
 * page does not expose `evaluate` — the caller treats that as "cannot
 * snapshot" rather than "empty page".
 */
async function readCounts(page: ResolvablePage): Promise<PageCounts | null> {
  if (typeof page.evaluate !== "function") return null;
  try {
    const result = await page.evaluate<
      PageCounts
    >(() => {
      const visible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
        return true;
      };
      const doc = document;
      const buttons = Array.from(
        doc.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'),
      ).filter(visible).length;
      const inputs = Array.from(
        doc.querySelectorAll('input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], input:not([type])'),
      ).filter(visible).length;
      const links = Array.from(doc.querySelectorAll("a[href]")).filter(visible).length;
      return { buttons, inputs, links };
    });
    if (result === null || typeof result !== "object") return null;
    const r = result as Record<string, unknown>;
    if (typeof r["buttons"] !== "number" || typeof r["inputs"] !== "number" || typeof r["links"] !== "number") {
      return null;
    }
    return {
      buttons: r["buttons"] as number,
      inputs: r["inputs"] as number,
      links: r["links"] as number,
    };
  } catch {
    return null;
  }
}

async function probeVisibility(
  page: ResolvablePage,
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  if (typeof page.locator !== "function") return false;
  let locator: ResolvableLocator;
  try {
    locator = page.locator(selector);
  } catch {
    return false;
  }
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function probeAria(
  page: ResolvablePage,
  role: string,
  name: string | null,
  timeoutMs: number,
): Promise<boolean> {
  if (typeof page.getByRole !== "function") return false;
  try {
    const locator =
      name !== null && name.trim().length > 0
        ? page.getByRole(role, { name, exact: true })
        : page.getByRole(role);
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function pageUrl(page: ResolvablePage, keepQueryString: boolean): string {
  if (typeof page.url !== "function") return "";
  let raw: string;
  try {
    raw = page.url();
  } catch {
    return "";
  }
  if (raw.length === 0) return "";
  if (keepQueryString) return raw;
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

function isPageClosed(page: ResolvablePage): boolean {
  if (typeof page.isClosed !== "function") return false;
  try {
    return page.isClosed();
  } catch {
    return false;
  }
}

function normaliseTimeout(raw: number | undefined, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

function identityString(step: StepSnapshot): string | null {
  if (step.role === null && step.accessibleName === null) return null;
  const role = step.role ?? "?";
  const name = step.accessibleName ?? "?";
  return `${role}:"${name}"`;
}

function ensureUniqueSteps(steps: readonly StepSnapshot[]): void {
  const seen = new Set<number>();
  for (const s of steps) {
    if (seen.has(s.step)) {
      throw new Error(
        `Snapshot contains duplicate step number ${s.step}. A snapshot must record each step exactly once.`,
      );
    }
    seen.add(s.step);
  }
}

function computeOverall(
  changes: readonly StepChange[],
  urlMismatch: boolean,
): ChangeReport["overall"] {
  if (urlMismatch) return "changed";
  if (changes.length === 0) return "stable";
  let hasDrifted = false;
  let hasUnknown = false;
  for (const c of changes) {
    if (c.verdict === "changed") return "changed";
    if (c.verdict === "drifted") hasDrifted = true;
    if (c.verdict === "unknown") hasUnknown = true;
  }
  if (hasDrifted) return "drifted";
  if (hasUnknown) return "unknown";
  return "stable";
}

function computeOverallReason(
  changes: readonly StepChange[],
  urlMismatch: boolean,
): string {
  if (urlMismatch) {
    return "The current page URL differs from the URL the snapshot was taken on.";
  }
  if (changes.length === 0) {
    return "No steps to compare.";
  }
  const firstNonStable = changes.find((c) => c.verdict !== "stable");
  if (firstNonStable === undefined) {
    return "Every recorded step still matches its primary selector.";
  }
  return `Step ${firstNonStable.step}: ${firstNonStable.reason}`;
}

/* -------------------------------------------------------------------------- */
/* Public alias for plan-checking flows                                        */
/* -------------------------------------------------------------------------- */

/**
 * Convenience predicate: true when re-synthesis is required. The worker's
 * re-run path calls this before attempting the plan; a `true` return
 * short-circuits to the synthesize endpoint rather than risking a step
 * acting on the wrong element.
 */
export function requiresResynthesis(report: ChangeReport): boolean {
  return report.overall === "changed";
}

/**
 * Convenience predicate: true when the plan is usable but flagged for
 * review. Drifted plans may still run — the fallback selectors in
 * `selectors.ts` handle the resolution — but the reviewer should see the
 * drift signal.
 */
export function shouldFlagForReview(report: ChangeReport): boolean {
  return report.overall === "drifted" || report.overall === "changed";
}
