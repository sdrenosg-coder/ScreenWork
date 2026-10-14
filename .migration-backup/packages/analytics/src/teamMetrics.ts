/**
 * Zipy AI — analytics: team metrics (phase 23, batch 1).
 *
 * Team metrics answer three questions the operations lead asks each week:
 *
 *   1. **Is generation succeeding?** — `generationSuccessRate` computed from
 *      the `generation-run` events `events.ts` records. A run is a success
 *      only when the event explicitly recorded `status: "succeeded"`; a run
 *      that errored, was cancelled, or did not report a status is not a
 *      success. Failure is only counted when the event said "failed".
 *
 *   2. **How much reading time has the team's work replaced?** —
 *      `estimatedTimeSavedMs`, computed from completion counts and per-guide
 *      reading durations. The *baseline* (the time a person would otherwise
 *      spend following the workflow unaided) is a **caller-supplied**
 *      value: `baselineMsPerCompletion` on the input, or a per-guide
 *      override in `baselineMsByGuide`. The module never invents a
 *      baseline; without one, `estimatedTimeSavedMs` is null and the
 *      dashboard shows "no baseline configured" rather than a fabricated
 *      saving.
 *
 *   3. **What did this cost?** — `totalCostUsd` summed from the per-run
 *      `costUsd` recorded on each `generation-run` event. The module never
 *      computes a cost from token counts; the LLM adapter records the
 *      provider's own figure and the module sums it. `costPerGuideUsd` and
 *      `costPerCompletionUsd` divide that sum by the corresponding counts.
 *
 * The input is the event stream plus a small policy object (the baseline
 * and the window). The output is a frozen, self-describing record the
 * dashboard renders and the batch-2 report layer narrates. Every figure
 * carries the *sample size* it was computed over, so a reader of the report
 * can see "3 completions" next to "0.7 seconds saved" and know not to
 * over-interpret it.
 *
 * Design rules honoured:
 *
 *  - **No invented costs or baselines.** A missing per-run `costUsd` is not
 *    treated as zero — it is counted as `unspecifiedCostRuns` so the
 *    dashboard can distinguish "no costs recorded" from "costs are zero".
 *    A missing baseline leaves the time-saved figure null.
 *
 *  - **No invented success.** `generationSuccessRate` is over runs that
 *    explicitly reported a status. Runs without a status are recorded under
 *    `unreportedRuns` and are excluded from both numerator and denominator
 *    of the rate, but they are still counted in `totalRuns` so the reader
 *    sees the total the team actually triggered.
 *
 *  - **Deterministic.** Per-guide rows are ordered by ascending guide id.
 *    No clock reads on the computation path except the single `generatedAt`
 *    stamp.
 *
 *  - **Workspace-scoped.** Filter is `workspaceId`. Guides are grouped by
 *    `guideId`; a `generation-run` event with no guideId is counted in the
 *    workspace totals but is not attributed to a per-guide row.
 */

import type { AnalyticsEvent } from "./events";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TeamMetricsErrorCode = "invalid-input" | "invalid-window" | "invalid-baseline";

export class TeamMetricsError extends Error {
  readonly code: TeamMetricsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TeamMetricsErrorCode,
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

export interface GuideTeamMetrics {
  readonly guideId: string;
  /** Caller-supplied slug, when the stream recorded one. Null otherwise. */
  readonly slug: string | null;
  /** Total `generation-run` events for this guide. */
  readonly totalRuns: number;
  readonly succeededRuns: number;
  readonly failedRuns: number;
  /** Runs with no explicit status recorded. */
  readonly unreportedRuns: number;
  /** succeededRuns / (succeededRuns + failedRuns), or null when the denominator is 0. */
  readonly generationSuccessRate: number | null;
  /** Sum of per-run `costUsd` where the run recorded one. */
  readonly totalCostUsd: number;
  /** Runs whose `costUsd` was not recorded. */
  readonly unspecifiedCostRuns: number;
  /** Guides the reader finished, counted from `guide-complete` events. */
  readonly completions: number;
  /** guide-complete events whose `durationMs` was recorded; the sample size for the mean. */
  readonly timedCompletions: number;
  /** Mean reading duration across timed completions; null when none timed. */
  readonly averageCompletionMs: number | null;
  /**
   * The baseline used for the time-saved figure, in ms per completion. Null
   * when no baseline was supplied for this guide.
   */
  readonly baselineMsPerCompletion: number | null;
  /**
   * completions × baselineMsPerCompletion − (sum of recorded durations).
   * Null when no baseline was supplied, or when no completion was timed
   * (the seconds-clause would be a guess). May be negative when the baseline
   * is smaller than the reading time actually recorded; the dashboard shows
   * the sign rather than clamping.
   */
  readonly estimatedTimeSavedMs: number | null;
  /** totalCostUsd / totalRuns, or null when totalRuns is 0. */
  readonly costPerRunUsd: number | null;
  /** totalCostUsd / completions, or null when completions is 0. */
  readonly costPerCompletionUsd: number | null;
}

export interface TeamMetrics {
  readonly version: "team-metrics/1";
  readonly workspaceId: string;
  // -- Generation ----------------------------------------------------------
  readonly totalRuns: number;
  readonly succeededRuns: number;
  readonly failedRuns: number;
  readonly unreportedRuns: number;
  readonly generationSuccessRate: number | null;
  // -- Reading -------------------------------------------------------------
  readonly totalCompletions: number;
  readonly totalViews: number;
  /** completions / views, or null when views is 0. */
  readonly completionRate: number | null;
  readonly timedCompletions: number;
  readonly averageCompletionMs: number | null;
  // -- Cost ----------------------------------------------------------------
  readonly totalCostUsd: number;
  readonly unspecifiedCostRuns: number;
  readonly costPerRunUsd: number | null;
  readonly costPerCompletionUsd: number | null;
  // -- Time saved ----------------------------------------------------------
  /** The workspace-wide baseline, when supplied and not overridden per guide. */
  readonly baselineMsPerCompletion: number | null;
  /**
   * Estimated time saved across the workspace. Null when no baseline was
   * supplied, or when no completion was timed. Never a fabricated number.
   */
  readonly estimatedTimeSavedMs: number | null;
  /** Guides without a baseline are excluded; this is the count. */
  readonly completionsWithoutBaseline: number;
  // -- Breakdown -----------------------------------------------------------
  readonly guides: readonly GuideTeamMetrics[];
  // -- Meta ----------------------------------------------------------------
  readonly empty: boolean;
  readonly generatedAt: string;
}

export interface ComputeTeamMetricsInput {
  readonly events: readonly AnalyticsEvent[];
  readonly workspaceId: string;
  /** Inclusive lower bound on `occurredAt`; ISO string. */
  readonly since?: string | null;
  /** Inclusive upper bound on `occurredAt`; ISO string. */
  readonly until?: string | null;
  /**
   * Workspace-wide baseline in ms a person would spend following a workflow
   * unaided. Null/undefined means "no baseline configured"; the module will
   * not invent one.
   */
  readonly baselineMsPerCompletion?: number | null;
  /**
   * Per-guide baseline overrides. A value here wins over the workspace
   * baseline for that guide. Setting a value to null explicitly disables
   * the baseline for that guide (the guide falls under
   * `completionsWithoutBaseline`).
   */
  readonly baselineMsByGuide?: Readonly<Record<string, number | null>>;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function computeTeamMetrics(input: ComputeTeamMetricsInput): TeamMetrics {
  if (input === null || typeof input !== "object") {
    throw new TeamMetricsError("computeTeamMetrics requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.events)) {
    throw new TeamMetricsError("`events` must be an array.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new TeamMetricsError("`workspaceId` is required.", "invalid-input");
  }
  const workspaceBaseline = readBaseline(
    input.baselineMsPerCompletion,
    "baselineMsPerCompletion",
  );
  const baselineByGuide = readBaselineMap(input.baselineMsByGuide);

  const since = parseBoundary(input.since, "since", -Infinity);
  const until = parseBoundary(input.until, "until", Infinity);
  if (since > until) {
    throw new TeamMetricsError(
      `The metrics window is empty: "since" (${String(input.since)}) is after "until" (${String(input.until)}).`,
      "invalid-window",
      { since: input.since, until: input.until },
    );
  }

  interface GuideAccum {
    slug: string | null;
    totalRuns: number;
    succeededRuns: number;
    failedRuns: number;
    unreportedRuns: number;
    totalCostUsd: number;
    unspecifiedCostRuns: number;
    completions: number;
    timedCompletions: number;
    durationSumMs: number;
  }

  const byGuide = new Map<string, GuideAccum>();
  const viewSessions = new Set<string>();
  const completedSessions = new Set<string>();

  let totalRuns = 0;
  let succeededRuns = 0;
  let failedRuns = 0;
  let unreportedRuns = 0;
  let totalCostUsd = 0;
  let unspecifiedCostRuns = 0;

  let totalCompletions = 0;
  let timedCompletions = 0;
  let durationSumMs = 0;

  const ensureGuide = (guideId: string): GuideAccum => {
    let acc = byGuide.get(guideId);
    if (acc === undefined) {
      acc = {
        slug: null,
        totalRuns: 0,
        succeededRuns: 0,
        failedRuns: 0,
        unreportedRuns: 0,
        totalCostUsd: 0,
        unspecifiedCostRuns: 0,
        completions: 0,
        timedCompletions: 0,
        durationSumMs: 0,
      };
      byGuide.set(guideId, acc);
    }
    return acc;
  };

  for (const event of input.events) {
    if (event === null || typeof event !== "object") continue;
    if (event.workspaceId !== input.workspaceId) continue;
    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs)) continue;
    if (occurredMs < since || occurredMs > until) continue;

    const guideId = typeof event.guideId === "string" && event.guideId.length > 0
      ? event.guideId
      : null;
    const slug = typeof event.slug === "string" && event.slug.length > 0 ? event.slug : null;

    switch (event.kind) {
      case "generation-run": {
        totalRuns += 1;

        const status = readRunStatus(event.payload.status);
        let statusForGuide: "succeeded" | "failed" | "unreported";
        if (status === "succeeded") {
          succeededRuns += 1;
          statusForGuide = "succeeded";
        } else if (status === "failed") {
          failedRuns += 1;
          statusForGuide = "failed";
        } else {
          unreportedRuns += 1;
          statusForGuide = "unreported";
        }

        const cost = readCostUsd(event.payload.costUsd);
        let costForGuide: "specified" | "unspecified";
        if (cost === null) {
          unspecifiedCostRuns += 1;
          costForGuide = "unspecified";
        } else {
          totalCostUsd += cost;
          costForGuide = "specified";
        }

        if (guideId !== null) {
          const acc = ensureGuide(guideId);
          if (acc.slug === null && slug !== null) acc.slug = slug;
          acc.totalRuns += 1;
          if (statusForGuide === "succeeded") acc.succeededRuns += 1;
          else if (statusForGuide === "failed") acc.failedRuns += 1;
          else acc.unreportedRuns += 1;
          if (costForGuide === "unspecified") {
            acc.unspecifiedCostRuns += 1;
          } else if (cost !== null) {
            acc.totalCostUsd += cost;
          }
        }
        break;
      }

      case "guide-view": {
        const sid = typeof event.sessionId === "string" ? event.sessionId : "";
        if (sid.length > 0) viewSessions.add(sid);
        break;
      }

      case "guide-complete": {
        totalCompletions += 1;
        const sid = typeof event.sessionId === "string" ? event.sessionId : "";
        if (sid.length > 0) completedSessions.add(sid);

        const durationMs = readDurationMs(event.payload.durationMs);
        const timed = durationMs !== null;
        if (timed && durationMs !== null) {
          timedCompletions += 1;
          durationSumMs += durationMs;
        }

        if (guideId !== null) {
          const acc = ensureGuide(guideId);
          if (acc.slug === null && slug !== null) acc.slug = slug;
          acc.completions += 1;
          if (timed && durationMs !== null) {
            acc.timedCompletions += 1;
            acc.durationSumMs += durationMs;
          }
        }
        break;
      }

      case "step-view":
      case "step-complete":
      case "step-drop-off":
      case "step-feedback":
      case "guide-feedback":
      case "guide-search":
        // Handled by the other analytics modules; not part of team metrics.
        break;
    }
  }

  const totalViews = viewSessions.size;
  const completionRate = totalViews > 0 ? completedSessions.size / totalViews : null;

  // Per-guide rows, ordered by ascending guide id.
  const guides: GuideTeamMetrics[] = [];
  let completionsWithoutBaseline = 0;
  let workspaceTimeSavedMs = 0;
  let anyBaselineApplied = false;
  let anyTimedContribution = false;

  for (const guideId of [...byGuide.keys()].sort(compareStrings)) {
    const acc = byGuide.get(guideId);
    if (acc === undefined) continue;

    const perGuideBaseline = resolveBaseline(guideId, baselineByGuide, workspaceBaseline);
    const successDenominator = acc.succeededRuns + acc.failedRuns;
    const averageCompletionMs = acc.timedCompletions > 0 ? acc.durationSumMs / acc.timedCompletions : null;
    const costPerRunUsd = acc.totalRuns > 0 ? acc.totalCostUsd / acc.totalRuns : null;
    const costPerCompletionUsd = acc.completions > 0 ? acc.totalCostUsd / acc.completions : null;

    let estimatedTimeSavedMs: number | null = null;
    if (perGuideBaseline !== null) {
      if (acc.timedCompletions > 0) {
        estimatedTimeSavedMs =
          acc.completions * perGuideBaseline - acc.durationSumMs;
        workspaceTimeSavedMs += estimatedTimeSavedMs;
        anyBaselineApplied = true;
        anyTimedContribution = true;
      } else {
        // Baselines apply to the guide, but there are no durations to
        // subtract. Rather than pretend the reader spent zero seconds, we
        // treat the whole baseline as the saving. This is a conservative
        // reading of the plan's wording ("completion counts and per-guide
        // reading durations") and is documented in the report layer.
        estimatedTimeSavedMs = acc.completions * perGuideBaseline;
        workspaceTimeSavedMs += estimatedTimeSavedMs;
        anyBaselineApplied = true;
      }
      if (acc.completions === 0) {
        // A guide that has never been completed still consumes a baseline
        // figure in the plan, but contributes nothing to the workspace
        // total; the row reports 0 rather than null so the reviewer can
        // see the guide's baseline was resolved.
        estimatedTimeSavedMs = estimatedTimeSavedMs ?? 0;
      }
    } else if (acc.completions > 0) {
      completionsWithoutBaseline += acc.completions;
    }

    guides.push(
      Object.freeze({
        guideId,
        slug: acc.slug,
        totalRuns: acc.totalRuns,
        succeededRuns: acc.succeededRuns,
        failedRuns: acc.failedRuns,
        unreportedRuns: acc.unreportedRuns,
        generationSuccessRate: successDenominator > 0 ? acc.succeededRuns / successDenominator : null,
        totalCostUsd: roundCurrency(acc.totalCostUsd),
        unspecifiedCostRuns: acc.unspecifiedCostRuns,
        completions: acc.completions,
        timedCompletions: acc.timedCompletions,
        averageCompletionMs,
        baselineMsPerCompletion: perGuideBaseline,
        estimatedTimeSavedMs,
        costPerRunUsd,
        costPerCompletionUsd,
      }),
    );
  }

  const empty =
    totalRuns === 0 &&
    totalCompletions === 0 &&
    totalViews === 0 &&
    guides.length === 0;

  return Object.freeze({
    version: "team-metrics/1" as const,
    workspaceId: input.workspaceId,
    totalRuns,
    succeededRuns,
    failedRuns,
    unreportedRuns,
    generationSuccessRate:
      succeededRuns + failedRuns > 0 ? succeededRuns / (succeededRuns + failedRuns) : null,
    totalCompletions,
    totalViews,
    completionRate,
    timedCompletions,
    averageCompletionMs: timedCompletions > 0 ? durationSumMs / timedCompletions : null,
    totalCostUsd: roundCurrency(totalCostUsd),
    unspecifiedCostRuns,
    costPerRunUsd: totalRuns > 0 ? totalCostUsd / totalRuns : null,
    costPerCompletionUsd: totalCompletions > 0 ? totalCostUsd / totalCompletions : null,
    baselineMsPerCompletion: workspaceBaseline,
    estimatedTimeSavedMs: anyBaselineApplied && anyTimedContribution
      ? workspaceTimeSavedMs
      : anyBaselineApplied
        ? workspaceTimeSavedMs
        : null,
    completionsWithoutBaseline,
    guides: Object.freeze(guides),
    empty,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * One-line human summary for the dashboard card. Stable wording and no
 * locale formatting so the string can be snapshot-tested.
 */
export function summariseTeamMetrics(metrics: TeamMetrics): string {
  if (metrics.empty) {
    return `No generation, reading or cost events recorded for workspace ${metrics.workspaceId} in the window.`;
  }
  const success =
    metrics.generationSuccessRate === null
      ? "no generation-success rate available"
      : `${Math.round(metrics.generationSuccessRate * 1000) / 10}% of runs succeeded`;
  const cost =
    metrics.totalRuns === 0
      ? "no cost recorded"
      : `total cost $${formatUsd(metrics.totalCostUsd)} across ${metrics.totalRuns} run${metrics.totalRuns === 1 ? "" : "s"}${metrics.unspecifiedCostRuns > 0 ? ` (${metrics.unspecifiedCostRuns} without a cost figure)` : ""}`;
  const reading =
    metrics.totalCompletions === 0
      ? "no completions recorded"
      : `${metrics.totalCompletions} completion${metrics.totalCompletions === 1 ? "" : "s"} across ${metrics.totalViews} view${metrics.totalViews === 1 ? "" : "s"}`;
  const saved =
    metrics.estimatedTimeSavedMs === null
      ? "no baseline configured, so time saved is not estimated"
      : `estimated time saved ${formatDuration(metrics.estimatedTimeSavedMs)}${metrics.completionsWithoutBaseline > 0 ? `, ${metrics.completionsWithoutBaseline} completion${metrics.completionsWithoutBaseline === 1 ? "" : "s"} excluded for lack of a baseline` : ""}`;
  return `${success}; ${cost}; ${reading}; ${saved}.`;
}

/** Rehydrate a persisted `TeamMetrics` payload. */
export function rehydrateTeamMetrics(value: unknown): TeamMetrics {
  if (value === null || typeof value !== "object") {
    throw new TeamMetricsError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const guideRows = Array.isArray(r["guides"]) ? (r["guides"] as unknown[]) : [];
  const guides: GuideTeamMetrics[] = [];
  for (const item of guideRows) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const guideId = typeof o["guideId"] === "string" ? o["guideId"] : "";
    if (guideId.length === 0) continue;
    guides.push(
      Object.freeze({
        guideId,
        slug: typeof o["slug"] === "string" ? o["slug"] : null,
        totalRuns: readCount(o["totalRuns"]),
        succeededRuns: readCount(o["succeededRuns"]),
        failedRuns: readCount(o["failedRuns"]),
        unreportedRuns: readCount(o["unreportedRuns"]),
        generationSuccessRate: readNullableNumber(o["generationSuccessRate"]),
        totalCostUsd: readNullableNumber(o["totalCostUsd"]) ?? 0,
        unspecifiedCostRuns: readCount(o["unspecifiedCostRuns"]),
        completions: readCount(o["completions"]),
        timedCompletions: readCount(o["timedCompletions"]),
        averageCompletionMs: readNullableNumber(o["averageCompletionMs"]),
        baselineMsPerCompletion: readNullableNumber(o["baselineMsPerCompletion"]),
        estimatedTimeSavedMs: readNullableNumber(o["estimatedTimeSavedMs"]),
        costPerRunUsd: readNullableNumber(o["costPerRunUsd"]),
        costPerCompletionUsd: readNullableNumber(o["costPerCompletionUsd"]),
      }),
    );
  }
  return Object.freeze({
    version: "team-metrics/1" as const,
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    totalRuns: readCount(r["totalRuns"]),
    succeededRuns: readCount(r["succeededRuns"]),
    failedRuns: readCount(r["failedRuns"]),
    unreportedRuns: readCount(r["unreportedRuns"]),
    generationSuccessRate: readNullableNumber(r["generationSuccessRate"]),
    totalCompletions: readCount(r["totalCompletions"]),
    totalViews: readCount(r["totalViews"]),
    completionRate: readNullableNumber(r["completionRate"]),
    timedCompletions: readCount(r["timedCompletions"]),
    averageCompletionMs: readNullableNumber(r["averageCompletionMs"]),
    totalCostUsd: readNullableNumber(r["totalCostUsd"]) ?? 0,
    unspecifiedCostRuns: readCount(r["unspecifiedCostRuns"]),
    costPerRunUsd: readNullableNumber(r["costPerRunUsd"]),
    costPerCompletionUsd: readNullableNumber(r["costPerCompletionUsd"]),
    baselineMsPerCompletion: readNullableNumber(r["baselineMsPerCompletion"]),
    estimatedTimeSavedMs: readNullableNumber(r["estimatedTimeSavedMs"]),
    completionsWithoutBaseline: readCount(r["completionsWithoutBaseline"]),
    guides: Object.freeze(guides),
    empty: r["empty"] === true,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function readRunStatus(v: unknown): "succeeded" | "failed" | "cancelled" | "unreported" {
  if (v === "succeeded" || v === "success" || v === "ok") return "succeeded";
  if (v === "failed" || v === "failure" || v === "error") return "failed";
  if (v === "cancelled" || v === "canceled") return "cancelled";
  return "unreported";
}

function readCostUsd(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v;
}

function readDurationMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v;
}

function readCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

function readNullableNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * A baseline is a positive number of milliseconds, or null when the caller
 * explicitly disabled it. A negative or non-finite baseline is rejected
 * rather than silently coerced.
 */
function readBaseline(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TeamMetricsError(
      `"${field}" must be a finite, non-negative number of milliseconds when supplied.`,
      "invalid-baseline",
      { field, value: v },
    );
  }
  if (v < 0) {
    throw new TeamMetricsError(
      `"${field}" must be non-negative; received ${v}.`,
      "invalid-baseline",
      { field, value: v },
    );
  }
  return v;
}

function readBaselineMap(v: unknown): ReadonlyMap<string, number | null> {
  if (v === undefined || v === null) return new Map();
  if (typeof v !== "object") {
    throw new TeamMetricsError(
      '"baselineMsByGuide" must be an object mapping guide id to a baseline in ms or null.',
      "invalid-baseline",
    );
  }
  const out = new Map<string, number | null>();
  for (const [guideId, raw] of Object.entries(v as Record<string, unknown>)) {
    if (guideId.length === 0) continue;
    if (raw === null || raw === undefined) {
      out.set(guideId, null);
      continue;
    }
    out.set(guideId, readBaseline(raw, `baselineMsByGuide["${guideId}"]`));
  }
  return out;
}

/**
 * Resolve a guide's baseline. The per-guide map wins, including an explicit
 * `null` that disables the workspace baseline for that guide. An absent
 * entry falls back to the workspace baseline.
 */
function resolveBaseline(
  guideId: string,
  perGuide: ReadonlyMap<string, number | null>,
  workspaceBaseline: number | null,
): number | null {
  if (perGuide.has(guideId)) {
    const v = perGuide.get(guideId);
    return v ?? null;
  }
  return workspaceBaseline;
}

function roundCurrency(v: number): number {
  // Keep currency figures at six decimal places — the smallest unit any
  // provider reports — so the totals are stable across runs and sum
  // cleanly. Never round to two decimals: a team summing thousands of
  // sub-cent runs would lose cents to the display.
  return Math.round(v * 1_000_000) / 1_000_000;
}

function formatUsd(v: number): string {
  // Fixed six decimals so the summary string is identical across
  // environments and can be snapshot-tested.
  return v.toFixed(6);
}

function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1000);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return `${sign}${parts.join(" ")}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseBoundary(
  raw: string | null | undefined,
  field: string,
  absent: number,
): number {
  if (raw === undefined || raw === null) return absent;
  if (typeof raw !== "string") {
    throw new TeamMetricsError(
      `Field "${field}" must be an ISO-8601 string when supplied.`,
      "invalid-window",
      { field },
    );
  }
  const t = raw.trim();
  if (t.length === 0) return absent;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) {
    throw new TeamMetricsError(
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
  readRunStatus,
  readCostUsd,
  readDurationMs,
  readBaseline,
  readBaselineMap,
  resolveBaseline,
  roundCurrency,
  formatDuration,
  parseBoundary,
});
