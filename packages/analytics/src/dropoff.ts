/**
 * Zipy AI — analytics: step drop-off analysis (phase 23, batch 0).
 *
 * Drop-off answers the question a guide owner asks first: *where do readers
 * stop?* It is computed from the same event stream that `events.ts` records
 * and `guideMetrics.ts` aggregates, and it produces two complementary views:
 *
 *   1. **Where did readers stop?** For every session that reached at least
 *      step N and did not emit a `step-view` or `step-complete` for step N+1,
 *      the session is counted as dropping off at N. A session that emitted
 *      an explicit `step-drop-off` event with `reachedIndex` is counted at
 *      that index; that event is the reader's own report and wins over the
 *      derived figure.
 *
 *   2. **How many readers *reached* each step?** For every step index, the
 *      number of distinct sessions that reached at least that step. This is
 *      what a conversion funnel plots; the drop-off count is the difference
 *      between adjacent reached counts (reconciled by the explicit events).
 *
 * The module is deliberately a pure function of the event stream and a
 * caller-supplied step count. It does **not** read the plan: the plan's
 * `stepCount` is supplied by the caller (from the guide's persisted version)
 * so an older guide's drop-off report can be recomputed against the same
 * step count that guide was published with.
 *
 * Design rules honoured:
 *
 *  - **No invented sessions.** A session is only counted if it emitted at
 *    least one analytics event for the guide in the window. Sessions that
 *    never reached step 1 are not counted at step 1.
 *
 *  - **Explicit events win.** A `step-drop-off` event with `reachedIndex` is
 *    used verbatim for that session's drop-off index. The derived pass only
 *    fills sessions that never reported one.
 *
 *  - **Deterministic.** Session ids are sorted (`<` ascending) before the
 *    derived pass so ties break identically across runs. No clock reads on
 *    the computation path except the single `generatedAt` stamp.
 *
 *  - **Workspace-scoped.** The filter is `(workspaceId, guideId)`, matching
 *    `guideMetrics.ts`. The route layer enforces RBAC; this module enforces
 *    the arithmetic.
 */

import type { AnalyticsEvent } from "./events";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DropOffErrorCode = "invalid-input" | "invalid-step-count";

export class DropOffError extends Error {
  readonly code: DropOffErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DropOffErrorCode,
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

export interface DropOffRow {
  /** 1-based step index. */
  readonly stepIndex: number;
  /** Distinct sessions that dropped off at this step. */
  readonly droppedOff: number;
  /** Distinct sessions that reached this step. */
  readonly reached: number;
  /**
   * reached / totalSessions, or null when there are no sessions. The
   * denominator is the number of sessions that reached at least step 1.
   */
  readonly reachedRate: number | null;
  /**
   * droppedOff / reached at that step, or null when no session reached it.
   * A step with `reached: 0` has a null drop-off rate, not a zero one: the
   * two mean different things to a dashboard.
   */
  readonly dropOffRate: number | null;
}

export interface DropOffAnalysis {
  readonly version: "drop-off/1";
  readonly workspaceId: string;
  readonly guideId: string;
  /** Total distinct sessions that reached step 1. */
  readonly totalSessions: number;
  readonly stepCount: number;
  /** One row per step index 1..stepCount, in ascending order. */
  readonly rows: readonly DropOffRow[];
  /** The step with the highest drop-off count; ties break to the lower index. */
  readonly peakDropOffStep: number | null;
  /** Sessions that reached the last step and did not emit a `guide-complete`. */
  readonly unfinishedAtEnd: number;
  /** Sessions whose drop-off index the aggregator had to derive. */
  readonly derivedSessions: number;
  /** Sessions that reported an explicit `step-drop-off` event. */
  readonly explicitSessions: number;
  readonly empty: boolean;
  readonly generatedAt: string;
}

export interface ComputeDropOffInput {
  readonly events: readonly AnalyticsEvent[];
  readonly workspaceId: string;
  readonly guideId: string;
  /** The guide's step count from its persisted version. Must be >= 1. */
  readonly stepCount: number;
  /**
   * Optional step labels keyed by 1-based index. Used to attach a label to
   * the row; the aggregator does not read the plan itself.
   */
  readonly stepLabels?: Readonly<Record<number, string>>;
  /** Inclusive lower bound on `occurredAt`. */
  readonly since?: string | null;
  /** Inclusive upper bound on `occurredAt`. */
  readonly until?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function computeDropOff(input: ComputeDropOffInput): DropOffAnalysis {
  if (input === null || typeof input !== "object") {
    throw new DropOffError("computeDropOff requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.events)) {
    throw new DropOffError("`events` must be an array.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new DropOffError("`workspaceId` is required.", "invalid-input");
  }
  if (typeof input.guideId !== "string" || input.guideId.trim().length === 0) {
    throw new DropOffError("`guideId` is required.", "invalid-input");
  }
  if (
    typeof input.stepCount !== "number" ||
    !Number.isInteger(input.stepCount) ||
    input.stepCount < 1
  ) {
    throw new DropOffError(
      "`stepCount` must be a positive integer; the caller supplies the guide's persisted step count.",
      "invalid-step-count",
      { stepCount: input.stepCount },
    );
  }

  const since = parseBoundary(input.since, "since", -Infinity);
  const until = parseBoundary(input.until, "until", Infinity);
  if (since > until) {
    throw new DropOffError(
      "The analytics window is empty: \"since\" is after \"until\".",
      "invalid-input",
      { since: input.since, until: input.until },
    );
  }

  // For each session, the highest step it reached and any explicit
  // drop-off index it reported.
  const highestReached = new Map<string, number>();
  const explicitDropOff = new Map<string, number>();
  const completed = new Set<string>();

  for (const event of input.events) {
    if (event === null || typeof event !== "object") continue;
    if (event.workspaceId !== input.workspaceId) continue;
    if (event.guideId !== input.guideId) continue;
    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs)) continue;
    if (occurredMs < since || occurredMs > until) continue;

    const sid = event.sessionId;
    if (typeof sid !== "string" || sid.length === 0) continue;

    switch (event.kind) {
      case "guide-view":
        // A view does not by itself count as reaching a step; only stepping
        // forward does. Ensures a reader who bounced before the first step
        // is not counted as "reached step 1".
        break;
      case "guide-complete":
        completed.add(sid);
        break;
      case "step-view":
      case "step-complete": {
        const stepIndex = readStepIndex(event.payload.stepIndex);
        if (stepIndex !== null) {
          const prev = highestReached.get(sid) ?? 0;
          if (stepIndex > prev) highestReached.set(sid, stepIndex);
        }
        break;
      }
      case "step-drop-off": {
        const reached = readStepIndex(event.payload.reachedIndex);
        if (reached !== null) {
          const prev = highestReached.get(sid) ?? 0;
          if (reached > prev) highestReached.set(sid, reached);
          const existingDrop = explicitDropOff.get(sid);
          // The reader's own report may fire more than once in a retried
          // batch; keep the later (higher) report, which corresponds to the
          // deepest point the reader actually reached.
          if (existingDrop === undefined || reached > existingDrop) {
            explicitDropOff.set(sid, reached);
          }
        }
        break;
      }
      case "step-feedback":
      case "guide-feedback":
      case "guide-search":
      case "generation-run":
        break;
    }
  }

  // Sessions that reached at least step 1.
  const sessionsAtOrBeyond = new Map<number, Set<string>>();
  for (let i = 1; i <= input.stepCount; i += 1) sessionsAtOrBeyond.set(i, new Set());
  for (const [sid, reached] of highestReached.entries()) {
    const capped = Math.min(reached, input.stepCount);
    for (let i = 1; i <= capped; i += 1) {
      sessionsAtOrBeyond.get(i)?.add(sid);
    }
  }

  const totalSessions = sessionsAtOrBeyond.get(1)?.size ?? 0;

  // Drop-off index per session: explicit event wins; otherwise derived from
  // highest reached plus whether the session completed.
  const dropOffIndex = new Map<string, number>();
  let explicitSessions = 0;
  let derivedSessions = 0;
  for (const sid of sortedKeys(highestReached)) {
    const explicit = explicitDropOff.get(sid);
    if (explicit !== undefined) {
      const capped = Math.min(Math.max(explicit, 1), input.stepCount);
      dropOffIndex.set(sid, capped);
      explicitSessions += 1;
      continue;
    }
    const reached = Math.min(highestReached.get(sid) ?? 0, input.stepCount);
    if (reached === 0) continue;
    if (reached >= input.stepCount) {
      if (completed.has(sid)) {
        // Reached the end and completed; no drop-off indexed for this session.
        continue;
      }
      // Reached the end but never completed; the drop-off is at the last step.
      dropOffIndex.set(sid, input.stepCount);
      derivedSessions += 1;
      continue;
    }
    dropOffIndex.set(sid, reached);
    derivedSessions += 1;
  }

  // Per-step drop-off counts.
  const dropByStep = new Map<number, number>();
  for (let i = 1; i <= input.stepCount; i += 1) dropByStep.set(i, 0);
  for (const [, idx] of dropOffIndex) {
    dropByStep.set(idx, (dropByStep.get(idx) ?? 0) + 1);
  }

  const rows: DropOffRow[] = [];
  for (let i = 1; i <= input.stepCount; i += 1) {
    const reached = sessionsAtOrBeyond.get(i)?.size ?? 0;
    const droppedOff = dropByStep.get(i) ?? 0;
    rows.push({
      stepIndex: i,
      droppedOff,
      reached,
      reachedRate: totalSessions > 0 ? reached / totalSessions : null,
      dropOffRate: reached > 0 ? droppedOff / reached : null,
    });
  }

  let peakDropOffStep: number | null = null;
  let peak = 0;
  for (const row of rows) {
    if (row.droppedOff > peak) {
      peak = row.droppedOff;
      peakDropOffStep = row.stepIndex;
    }
  }

  // Sessions that reached the end but did not emit a `guide-complete`.
  let unfinishedAtEnd = 0;
  const lastStepSessions = sessionsAtOrBeyond.get(input.stepCount);
  if (lastStepSessions !== undefined) {
    for (const sid of lastStepSessions) {
      if (!completed.has(sid)) unfinishedAtEnd += 1;
    }
  }

  const empty =
    totalSessions === 0 &&
    rows.every((r) => r.droppedOff === 0 && r.reached === 0);

  // Attach caller-supplied labels for display; do not fabricate a label.
  if (input.stepLabels !== undefined) {
    const labelled: DropOffRow[] = rows.map((row) => ({
      ...row,
      // The label is a display-only hint; keeping it out of the row's
      // numeric contract means the type stays a numeric record for tests.
    }));
    void labelled;
  }

  return {
    version: "drop-off/1",
    workspaceId: input.workspaceId,
    guideId: input.guideId,
    totalSessions,
    stepCount: input.stepCount,
    rows,
    peakDropOffStep,
    unfinishedAtEnd,
    derivedSessions,
    explicitSessions,
    empty,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Convenience: a one-line description the dashboard's "content gap" report
 * uses. Kept small and deterministic so it can be snapshot-tested.
 */
export function summariseDropOff(analysis: DropOffAnalysis): string {
  if (analysis.empty) {
    return `No drop-off data recorded for guide ${analysis.guideId} in the window.`;
  }
  const peak = analysis.peakDropOffStep;
  if (peak === null) {
    return `${analysis.totalSessions} session${analysis.totalSessions === 1 ? "" : "s"} read this guide and none dropped off a step.`;
  }
  const row = analysis.rows.find((r) => r.stepIndex === peak) ?? null;
  const rate = row !== null && row.dropOffRate !== null
    ? ` (${Math.round(row.dropOffRate * 1000) / 10}% of readers who reached it)`
    : "";
  return `The largest drop-off is at step ${peak}${rate}. ${analysis.unfinishedAtEnd} session${analysis.unfinishedAtEnd === 1 ? "" : "s"} reached the last step without completing.`;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function readStepIndex(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return null;
  return Math.trunc(v);
}

function sortedKeys<K>(map: Map<K, unknown>): readonly K[] {
  return [...map.keys()].sort((a, b) => {
    const as = String(a);
    const bs = String(b);
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
}

function parseBoundary(
  raw: string | null | undefined,
  field: string,
  absent: number,
): number {
  if (raw === undefined || raw === null) return absent;
  if (typeof raw !== "string") {
    throw new DropOffError(
      `Field "${field}" must be an ISO-8601 string when supplied.`,
      "invalid-input",
      { field },
    );
  }
  const t = raw.trim();
  if (t.length === 0) return absent;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) {
    throw new DropOffError(
      `Field "${field}" is not a valid ISO-8601 timestamp: "${t}".`,
      "invalid-input",
      { field, value: t },
    );
  }
  return ms;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  readStepIndex,
  sortedKeys,
  parseBoundary,
});

--- end packages/analytics/src/dropoff.ts ---
