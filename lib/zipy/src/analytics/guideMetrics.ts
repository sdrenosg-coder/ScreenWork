/**
 * Zipy AI — analytics: per-guide metrics aggregation (phase 23, batch 0).
 *
 * Given the append-only event stream from `events.ts`, this module produces
 * the per-guide metric set a dashboard reads:
 *
 *   - views               — one per distinct session that emitted a `guide-view`.
 *   - completions         — one per distinct session that emitted a `guide-complete`.
 *   - completionRate      — completions / views, with a null result when views is 0.
 *   - medianDurationMs    — median `durationMs` across completed sessions.
 *   - averageStepReached  — mean highest `stepIndex` seen across sessions.
 *   - feedbackCount       — number of `step-feedback`/`guide-feedback` events.
 *   - averageFeedback     — mean 1..5 rating across those feedback events.
 *   - stepDropOffs        — per-step counts produced by `dropoff.ts` (imported
 *                            by the caller and passed in, so this module stays
 *                            a pure aggregator over numbers).
 *   - generatedAt         — ISO stamp on the aggregation itself.
 *
 * Design rules honoured:
 *
 *  - **Deterministic.** Ties on the median are broken by taking the lower
 *    middle value; ties on ordering are broken by session id (`<`, ascending)
 *    so two runs over the same events produce identical output. No clock
 *    reads on the computation path except the single `generatedAt` stamp.
 *
 *  - **No invented completeness.** A guide with zero views reports
 *    `completionRate: null` and `averageFeedback: null`; a rate over an empty
 *    denominator is not zero, and the dashboard must be able to tell "no data"
 *    from "0%".
 *
 *  - **Workspace-scoped.** The filter is `(workspaceId, guideId)`; an event
 *    tagged for a different workspace is never included. The route layer
 *    enforces RBAC on the caller side; the module enforces the scope in the
 *    arithmetic.
 *
 *  - **Sessions, not rows.** A reader who reloads a page and views the guide
 *    twice in the same session still counts as one view. A reader who opens
 *    five tabs and completes each one still counts as one completion. The
 *    aggregator de-duplicates by `sessionId` before it counts.
 *
 *  - **Fixed clock in tests.** `occurredAt` windows are explicit: the caller
 *    supplies `since`/`until` (each optional); absent, the window is the
 *    whole history. No window is invented.
 */

import type { AnalyticsEvent } from "./events";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type GuideMetricsErrorCode = "invalid-input" | "invalid-window";

export class GuideMetricsError extends Error {
  readonly code: GuideMetricsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: GuideMetricsErrorCode,
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

export interface DropOffEntry {
  /** 1-based step index. */
  readonly stepIndex: number;
  /** Number of distinct sessions that dropped off at this step. */
  readonly count: number;
  /**
   * A caller-supplied label (the step's title from the plan). Present only
   * when the caller passed a step-label map.
   */
  readonly label: string | null;
}

export interface GuideMetrics {
  readonly version: "guide-metrics/1";
  readonly workspaceId: string;
  readonly guideId: string;
  readonly slug: string | null;
  /** Distinct sessions with at least one `guide-view`. */
  readonly views: number;
  /** Distinct sessions with at least one `guide-complete`. */
  readonly completions: number;
  /** completions / views, or null when views is 0. */
  readonly completionRate: number | null;
  /** Median `durationMs` across completed sessions; null when none supplied one. */
  readonly medianDurationMs: number | null;
  /** Mean highest `stepIndex` reached across all sessions; null when impossible. */
  readonly averageStepReached: number | null;
  /** Total feedback events counted (step + guide). */
  readonly feedbackCount: number;
  /** Mean rating across feedback events; null when no feedback exists. */
  readonly averageFeedback: number | null;
  /** Rows the aggregator produced; supplied via `dropOffs`. */
  readonly stepDropOffs: readonly DropOffEntry[];
  /** True when the guide has no events in the window. */
  readonly empty: boolean;
  /** ISO stamp the aggregation ran. */
  readonly generatedAt: string;
}

export interface ComputeGuideMetricsInput {
  /**
   * The events to aggregate. The caller is responsible for scoping the
   * events to a workspace it is authorised to read; this module additionally
   * enforces `workspaceId`/`guideId` filters so a mixed batch cannot leak
   * another guide's numbers into the report.
   */
  readonly events: readonly AnalyticsEvent[];
  readonly workspaceId: string;
  readonly guideId: string;
  /**
   * Optional drop-off rows precomputed by `dropoff.ts`. When supplied the
   * rows are attached verbatim (after label resolution via `stepLabels`).
   * When omitted the aggregator emits an empty list and `stepDropOffs` is
   * only produced by the drop-off pass in the caller.
   */
  readonly dropOffs?: readonly { readonly stepIndex: number; readonly count: number }[];
  /** Optional map from step id to label, used to label the drop-off rows. */
  readonly stepLabels?: Readonly<Record<string, string>>;
  /** Optional map from step index to label, e.g. built from a plan snapshot. */
  readonly stepLabelsByIndex?: Readonly<Record<number, string>>;
  /** Inclusive lower bound on `occurredAt`; ISO string. */
  readonly since?: string | null;
  /** Inclusive upper bound on `occurredAt`; ISO string. */
  readonly until?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function computeGuideMetrics(input: ComputeGuideMetricsInput): GuideMetrics {
  if (input === null || typeof input !== "object") {
    throw new GuideMetricsError("computeGuideMetrics requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.events)) {
    throw new GuideMetricsError("`events` must be an array.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new GuideMetricsError("`workspaceId` is required.", "invalid-input");
  }
  if (typeof input.guideId !== "string" || input.guideId.trim().length === 0) {
    throw new GuideMetricsError("`guideId` is required.", "invalid-input");
  }

  const since = parseBoundary(input.since, "since", -Infinity);
  const until = parseBoundary(input.until, "until", Infinity);
  if (since > until) {
    throw new GuideMetricsError(
      `The analytics window is empty: "since" (${String(input.since)}) is after "until" (${String(input.until)}).`,
      "invalid-window",
      { since: input.since, until: input.until },
    );
  }

  const eventSlug = new Map<string, string | null>();       // sessionId -> slug
  const sessionViews = new Set<string>();
  const sessionCompletions = new Set<string>();
  const sessionDurations = new Map<string, number>();        // sessionId -> durationMs
  const sessionHighestStep = new Map<string, number>();      // sessionId -> highest 1-based step reached
  const feedbackRatings: number[] = [];
  let slug: string | null = null;

  // Per-event pass. All "session" sets are keyed by the sessionId so a
  // reload does not multi-count; a session that appears in views and later
  // in completions is deduped across both.
  for (const event of input.events) {
    if (event === null || typeof event !== "object") continue;
    if (event.workspaceId !== input.workspaceId) continue;
    if (event.guideId !== input.guideId) continue;
    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs)) continue;
    if (occurredMs < since || occurredMs > until) continue;

    if (slug === null && typeof event.slug === "string" && event.slug.length > 0) {
      slug = event.slug;
    }
    const sid = event.sessionId;
    if (typeof sid === "string" && sid.length > 0) {
      const prev = eventSlug.get(sid);
      if (prev === undefined || prev === null) {
        eventSlug.set(sid, event.slug);
      }
    }

    switch (event.kind) {
      case "guide-view":
        sessionViews.add(sid);
        break;
      case "guide-complete": {
        sessionCompletions.add(sid);
        const durationMs = readFiniteNumber(event.payload.durationMs);
        if (durationMs !== null) sessionDurations.set(sid, durationMs);
        const stepCount = readFiniteNumber(event.payload.stepCount);
        if (stepCount !== null && stepCount > 0) {
          recordHighestStep(sessionHighestStep, sid, stepCount);
        }
        break;
      }
      case "step-view":
      case "step-complete":
      case "step-drop-off": {
        const stepIndex = readFiniteNumber(event.payload.stepIndex);
        if (stepIndex !== null && stepIndex >= 1) {
          recordHighestStep(sessionHighestStep, sid, stepIndex);
        }
        if (event.kind === "step-drop-off") {
          const reached = readFiniteNumber(event.payload.reachedIndex);
          if (reached !== null && reached >= 1) {
            recordHighestStep(sessionHighestStep, sid, reached);
          }
        }
        break;
      }
      case "step-feedback":
      case "guide-feedback": {
        const rating = readFiniteNumber(event.payload.rating);
        if (rating !== null && rating >= 1 && rating <= 5 && Number.isInteger(rating)) {
          feedbackRatings.push(rating);
        }
        break;
      }
      case "guide-search":
      case "generation-run":
        // Neither contributes to the guide-level counts aggregated here.
        break;
    }
  }

  const views = sessionViews.size;
  const completions = sessionCompletions.size;
  const completionRate = views > 0 ? completions / views : null;

  // Median over the completed sessions that supplied a duration. A session
  // that never completed is not a sample of "how long a completed run takes".
  const durations = [...sessionDurations.entries()]
    .filter(([sid]) => sessionCompletions.has(sid))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, d]) => d);
  const medianDurationMs = medianOf(durations);

  // Average of the highest step each session reached. Only sessions that
  // emitted at least one step event count; a session that merely loaded the
  // page but never advanced is not a sample.
  const stepReaches = [...sessionHighestStep.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, i]) => i);
  const averageStepReached = stepReaches.length > 0
    ? stepReaches.reduce((a, b) => a + b, 0) / stepReaches.length
    : null;

  const feedbackCount = feedbackRatings.length;
  const averageFeedback = feedbackCount > 0
    ? feedbackRatings.reduce((a, b) => a + b, 0) / feedbackCount
    : null;

  const stepDropOffs: DropOffEntry[] = [];
  if (Array.isArray(input.dropOffs)) {
    for (const row of input.dropOffs) {
      if (row === null || typeof row !== "object") continue;
      const stepIndex =
        typeof row.stepIndex === "number" && Number.isFinite(row.stepIndex) && row.stepIndex >= 1
          ? Math.trunc(row.stepIndex)
          : null;
      const count =
        typeof row.count === "number" && Number.isFinite(row.count) && row.count >= 0
          ? Math.trunc(row.count)
          : null;
      if (stepIndex === null || count === null) continue;
      const byIndex = input.stepLabelsByIndex?.[stepIndex] ?? null;
      stepDropOffs.push({ stepIndex, count, label: byIndex });
    }
    stepDropOffs.sort((a, b) => a.stepIndex - b.stepIndex);
  }

  const empty =
    views === 0 &&
    completions === 0 &&
    durations.length === 0 &&
    stepReaches.length === 0 &&
    feedbackCount === 0 &&
    stepDropOffs.length === 0;

  return {
    version: "guide-metrics/1",
    workspaceId: input.workspaceId,
    guideId: input.guideId,
    slug,
    views,
    completions,
    completionRate,
    medianDurationMs,
    averageStepReached,
    feedbackCount,
    averageFeedback,
    stepDropOffs,
    empty,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Compute metrics for many guides in one pass. Returns the per-guide reports
 * in the order the `guideIds` were supplied so a dashboard can render a
 * stable list. Guides with no events produce `empty: true` reports rather
 * than being dropped, so the caller can show "0 views" explicitly.
 */
export function computeGuideMetricsBatch(input: {
  readonly events: readonly AnalyticsEvent[];
  readonly workspaceId: string;
  readonly guideIds: readonly string[];
}): readonly GuideMetrics[] {
  if (input === null || typeof input !== "object") {
    throw new GuideMetricsError("computeGuideMetricsBatch requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.guideIds)) {
    throw new GuideMetricsError("`guideIds` must be an array.", "invalid-input");
  }
  const out: GuideMetrics[] = [];
  for (const guideId of input.guideIds) {
    if (typeof guideId !== "string" || guideId.trim().length === 0) continue;
    out.push(
      computeGuideMetrics({
        events: input.events,
        workspaceId: input.workspaceId,
        guideId,
      }),
    );
  }
  return out;
}

/**
 * A stable, human-readable summary line for the dashboard card. Kept
 * parallel to `Metrics.summariseHandoff` in review/handoff.ts: no numbers
 * are formatted with locale rules so the string is identical in every
 * environment.
 */
export function summariseGuideMetrics(metrics: GuideMetrics): string {
  if (metrics.empty) {
    return `No analytics events recorded for guide ${metrics.guideId} in the window.`;
  }
  const rate =
    metrics.completionRate === null
      ? "no completion rate available"
      : `${(Math.round(metrics.completionRate * 1000) / 10).toString()}% completion`;
  const dur =
    metrics.medianDurationMs === null
      ? "no duration samples"
      : `median ${Math.round(metrics.medianDurationMs)} ms`;
  const feedback =
    metrics.averageFeedback === null
      ? "no feedback"
      : `mean rating ${Math.round(metrics.averageFeedback * 100) / 100} over ${metrics.feedbackCount} response${metrics.feedbackCount === 1 ? "" : "s"}`;
  return `${metrics.views} view${metrics.views === 1 ? "" : "s"}, ${metrics.completions} completion${metrics.completions === 1 ? "" : "s"} — ${rate}; ${dur}; ${feedback}.`;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function recordHighestStep(
  map: Map<string, number>,
  sessionId: string,
  stepIndex: number,
): void {
  const prev = map.get(sessionId) ?? 0;
  if (stepIndex > prev) map.set(sessionId, stepIndex);
}

function readFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Lower-middle median. For an even-length list the lower of the two middle
 * values is returned; the choice is documented so downstream tests are not
 * surprised. Returns null when no samples exist.
 */
function medianOf(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid] ?? null;
}

function parseBoundary(
  raw: string | null | undefined,
  field: string,
  absent: number,
): number {
  if (raw === undefined || raw === null) return absent;
  if (typeof raw !== "string") {
    throw new GuideMetricsError(
      `Field "${field}" must be an ISO-8601 string when supplied.`,
      "invalid-window",
      { field },
    );
  }
  const t = raw.trim();
  if (t.length === 0) return absent;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) {
    throw new GuideMetricsError(
      `Field "${field}" is not a valid ISO-8601 timestamp: "${t}".`,
      "invalid-window",
      { field, value: t },
    );
  }
  return ms;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  recordHighestStep,
  readFiniteNumber,
  medianOf,
  parseBoundary,
});

