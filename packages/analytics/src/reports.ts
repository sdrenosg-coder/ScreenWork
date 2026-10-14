/**
 * Zipy AI — analytics reporting layer (phase 23, batch 2).
 *
 * Builds the four report kinds the dashboard surfaces, using only data the
 * earlier batch files already produce:
 *
 *   - usage          ← @zipy/analytics/events + guideMetrics
 *   - performance    ← @zipy/analytics/guideMetrics + dropoff
 *   - content-gap    ← @zipy/analytics/searchAnalytics + feedback
 *   - executive      ← a single paragraph, composed from the three reports above
 *
 * The same deliberate contract the rest of the analytics package uses:
 * report functions are pure transformations over aggregated inputs. They do
 * not talk to the database, the object store, or the LLM. Persistence and
 * the optional AI-generated executive summary live in the API route that
 * consumes this module.
 *
 * Where this module computes a number, the number is derived from the inputs.
 * Where it cannot (because a caller did not pass the input), the field is left
 * as `null` rather than fabricated as zero, so a downstream view renders
 * "no data" rather than a misleading "0".
 *
 * The "executive summary" is either:
 *   - a deterministic paragraph composed from the metrics (when no LLM handle
 *     is supplied, or the caller requests the deterministic form), or
 *   - an LLM-composed paragraph, when the route passes a handle through.
 * The deterministic path is always available so this module never becomes
 * unusable just because no LLM is configured.
 */

import type { GuideMetricsSummary } from "./guideMetrics";
import type { DropoffSummary } from "./dropoff";
import type { SearchAnalyticsSummary } from "./searchAnalytics";
import type { FeedbackSummary } from "./feedback";
import type { TeamMetricsSummary } from "./teamMetrics";

/* -------------------------------------------------------------------------- */
/* Report kinds                                                                */
/* -------------------------------------------------------------------------- */

export const REPORT_KINDS = [
  "usage",
  "performance",
  "content-gap",
  "executive",
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(value: unknown): value is ReportKind {
  return (
    typeof value === "string" &&
    (REPORT_KINDS as readonly string[]).includes(value)
  );
}

export const REPORT_WINDOW_DAYS = [7, 30, 90] as const;
export type ReportWindowDays = (typeof REPORT_WINDOW_DAYS)[number];

export function isReportWindowDays(value: unknown): value is ReportWindowDays {
  return (
    typeof value === "number" &&
    (REPORT_WINDOW_DAYS as readonly number[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Report envelope                                                             */
/* -------------------------------------------------------------------------- */

export interface ReportWindow {
  readonly fromIso: string;
  readonly toIso: string;
  readonly days: number;
}

export interface ReportBase {
  readonly kind: ReportKind;
  readonly generatedAt: string;
  readonly workspaceId: string;
  readonly window: ReportWindow;
  /** Provenance list of the aggregations this report was computed from. */
  readonly inputs: readonly ReportInputRef[];
}

export interface ReportInputRef {
  readonly name: string;
  readonly generatedAt: string | null;
  readonly empty: boolean;
}

export interface UsageReport extends ReportBase {
  readonly kind: "usage";
  readonly guideCount: number;
  readonly publishedGuideCount: number | null;
  readonly totalViews: number;
  readonly uniqueViewers: number | null;
  readonly completions: number;
  readonly completionRate: number | null;
  readonly perGuide: readonly UsageRow[];
  readonly notes: readonly string[];
}

export interface UsageRow {
  readonly guideId: string;
  readonly title: string;
  readonly views: number;
  readonly completions: number;
  readonly completionRate: number | null;
  readonly lastViewedAtIso: string | null;
}

export interface PerformanceReport extends ReportBase {
  readonly kind: "performance";
  readonly averageStepsCompleted: number | null;
  readonly worstDropOffSteps: readonly DropoffRow[];
  readonly goodCompletionGuides: readonly UsageRow[];
  readonly weakCompletionGuides: readonly UsageRow[];
  readonly notes: readonly string[];
}

export interface DropoffRow {
  readonly guideId: string;
  readonly stepIndex: number;
  readonly stepTitle: string | null;
  readonly reached: number;
  readonly dropped: number;
  readonly dropRate: number;
}

export interface ContentGapReport extends ReportBase {
  readonly kind: "content-gap";
  readonly topUnmatchedQueries: readonly GapQueryRow[];
  readonly lowRatedSteps: readonly LowRatedStepRow[];
  readonly missingTopics: readonly string[];
  readonly notes: readonly string[];
}

export interface GapQueryRow {
  readonly query: string;
  readonly count: number;
  readonly zeroResult: boolean;
}

export interface LowRatedStepRow {
  readonly guideId: string;
  readonly stepIndex: number;
  readonly stepTitle: string | null;
  readonly averageRating: number;
  readonly negativeFeedback: number;
}

export interface ExecutiveReport extends ReportBase {
  readonly kind: "executive";
  readonly headline: string;
  readonly summary: string;
  readonly bullets: readonly string[];
  readonly generatedBy: "deterministic" | "llm";
  readonly usedProvider: string | null;
  readonly usedModel: string | null;
  readonly layerError: string | null;
}

export type AnyReport =
  | UsageReport
  | PerformanceReport
  | ContentGapReport
  | ExecutiveReport;

/* -------------------------------------------------------------------------- */
/* Input bundle                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The route gathers every available aggregation and hands them to the builder.
 * Each is optional: a missing input is recorded in the report's provenance
 * `inputs` array and the report omits the derived fields rather than
 * fabricating them.
 */
export interface ReportInputs {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly window: ReportWindow;
  readonly guideMetrics?: GuideMetricsSummary | undefined;
  readonly dropoff?: DropoffSummary | undefined;
  readonly search?: SearchAnalyticsSummary | undefined;
  readonly feedback?: FeedbackSummary | undefined;
  readonly teamMetrics?: TeamMetricsSummary | undefined;
}

/* -------------------------------------------------------------------------- */
/* Window helper                                                               */
/* -------------------------------------------------------------------------- */

export function buildReportWindow(
  days: number,
  now: Date = new Date(),
): ReportWindow {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 30;
  const toIso = now.toISOString();
  const from = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString(), toIso, days: safeDays };
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

function ref(name: string, generatedAt: string | null | undefined, empty: boolean): ReportInputRef {
  return {
    name,
    generatedAt:
      typeof generatedAt === "string" && generatedAt.length > 0 ? generatedAt : null,
    empty,
  };
}

/* -------------------------------------------------------------------------- */
/* Usage report                                                                */
/* -------------------------------------------------------------------------- */

export function buildUsageReport(inputs: ReportInputs): UsageReport {
  const notes: string[] = [];
  const inputsRef: ReportInputRef[] = [];

  const gm = inputs.guideMetrics;
  if (gm === undefined) {
    notes.push(
      "Guide metrics were not available for this window; views and completions are reported as 0 with a null completion rate rather than estimated.",
    );
    inputsRef.push(ref("guideMetrics", null, true));
  } else {
    inputsRef.push(ref("guideMetrics", gm.generatedAt ?? null, gm.perGuide.length === 0));
  }

  const perGuideRaw = gm?.perGuide ?? [];
  const perGuide: UsageRow[] = perGuideRaw.map((row) => ({
    guideId: row.guideId,
    title: row.title,
    views: row.views,
    completions: row.completions,
    completionRate: row.completionRate,
    lastViewedAtIso: row.lastViewedAtIso ?? null,
  }));

  const totalViews = perGuide.reduce((acc, r) => acc + r.views, 0);
  const completions = perGuide.reduce((acc, r) => acc + r.completions, 0);
  const guideCount = perGuide.length;

  const completionRate =
    totalViews > 0 ? completions / totalViews : null;

  // publishedGuideCount and uniqueViewers come from guideMetrics when the
  // upstream aggregation surfaced them; we do not invent them here.
  const publishedGuideCount = readOptionalNumber(gm, "publishedGuideCount");
  const uniqueViewers = readOptionalNumber(gm, "uniqueViewers");

  if (guideCount === 0) {
    notes.push("No guide activity was recorded in the selected window.");
  }

  return {
    kind: "usage",
    generatedAt: inputs.generatedAt,
    workspaceId: inputs.workspaceId,
    window: inputs.window,
    inputs: inputsRef,
    guideCount,
    publishedGuideCount,
    totalViews,
    uniqueViewers,
    completions,
    completionRate,
    perGuide,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Performance report                                                          */
/* -------------------------------------------------------------------------- */

const GOOD_COMPLETION_THRESHOLD = 0.75;
const WEAK_COMPLETION_THRESHOLD = 0.5;
const MAX_WORST_DROPOFF_STEPS = 10;

export function buildPerformanceReport(inputs: ReportInputs): PerformanceReport {
  const notes: string[] = [];
  const inputsRef: ReportInputRef[] = [];

  const gm = inputs.guideMetrics;
  const drop = inputs.dropoff;

  if (gm === undefined) {
    notes.push(
      "Guide metrics were not available; completion cohorts cannot be classified for this window.",
    );
    inputsRef.push(ref("guideMetrics", null, true));
  } else {
    inputsRef.push(ref("guideMetrics", gm.generatedAt ?? null, gm.perGuide.length === 0));
  }
  if (drop === undefined) {
    notes.push(
      "Drop-off aggregation was not available; per-step abandonment is not reported.",
    );
    inputsRef.push(ref("dropoff", null, true));
  } else {
    inputsRef.push(ref("dropoff", drop.generatedAt ?? null, drop.perGuide.length === 0));
  }

  // --- worst drop-off steps -------------------------------------------------
  const worstRaw: DropoffRow[] = [];
  if (drop !== undefined) {
    for (const guide of drop.perGuide) {
      for (const step of guide.steps) {
        if (step.reached <= 0) continue;
        const dropRate = step.dropped / step.reached;
        worstRaw.push({
          guideId: guide.guideId,
          stepIndex: step.stepIndex,
          stepTitle: step.stepTitle ?? null,
          reached: step.reached,
          dropped: step.dropped,
          dropRate,
        });
      }
    }
  }
  worstRaw.sort((a, b) => {
    if (a.dropRate !== b.dropRate) return b.dropRate - a.dropRate;
    if (a.dropped !== b.dropped) return b.dropped - a.dropped;
    if (a.guideId !== b.guideId) return a.guideId < b.guideId ? -1 : 1;
    return a.stepIndex - b.stepIndex;
  });
  const worstDropOffSteps = worstRaw.slice(0, MAX_WORST_DROPOFF_STEPS);

  // --- completion cohorts ---------------------------------------------------
  const goodCompletionGuides: UsageRow[] = [];
  const weakCompletionGuides: UsageRow[] = [];
  let averageStepsCompleted: number | null = null;

  if (gm !== undefined) {
    for (const row of gm.perGuide) {
      const usage: UsageRow = {
        guideId: row.guideId,
        title: row.title,
        views: row.views,
        completions: row.completions,
        completionRate: row.completionRate,
        lastViewedAtIso: row.lastViewedAtIso ?? null,
      };
      if (usage.completionRate === null) continue;
      if (usage.completionRate >= GOOD_COMPLETION_THRESHOLD) {
        goodCompletionGuides.push(usage);
      } else if (usage.completionRate < WEAK_COMPLETION_THRESHOLD) {
        weakCompletionGuides.push(usage);
      }
    }
    const withSteps = gm.perGuide
      .map((r) => r.averageStepsCompleted)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (withSteps.length > 0) {
      averageStepsCompleted =
        withSteps.reduce((a, b) => a + b, 0) / withSteps.length;
    } else {
      notes.push(
        "No guide recorded an average-steps-completed value; the field is null.",
      );
    }
  }

  if (gm === undefined && drop === undefined) {
    notes.push(
      "Both performance inputs are missing; this report carries only provenance.",
    );
  }

  return {
    kind: "performance",
    generatedAt: inputs.generatedAt,
    workspaceId: inputs.workspaceId,
    window: inputs.window,
    inputs: inputsRef,
    averageStepsCompleted,
    worstDropOffSteps,
    goodCompletionGuides,
    weakCompletionGuides,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Content-gap report                                                          */
/* -------------------------------------------------------------------------- */

const MAX_GAP_QUERIES = 25;
const MAX_LOW_RATED_STEPS = 25;
const LOW_RATING_THRESHOLD = 3.0;

export function buildContentGapReport(inputs: ReportInputs): ContentGapReport {
  const notes: string[] = [];
  const inputsRef: ReportInputRef[] = [];

  const search = inputs.search;
  const feedback = inputs.feedback;

  if (search === undefined) {
    notes.push(
      "Search analytics were not available; unmatched queries cannot be listed.",
    );
    inputsRef.push(ref("searchAnalytics", null, true));
  } else {
    inputsRef.push(
      ref("searchAnalytics", search.generatedAt ?? null, search.topQueries.length === 0),
    );
  }
  if (feedback === undefined) {
    notes.push(
      "Feedback aggregation was not available; low-rated steps cannot be listed.",
    );
    inputsRef.push(ref("feedback", null, true));
  } else {
    inputsRef.push(
      ref("feedback", feedback.generatedAt ?? null, feedback.perGuide.length === 0),
    );
  }

  // --- unmatched / zero-result queries -------------------------------------
  const gapQueries: GapQueryRow[] = [];
  if (search !== undefined) {
    for (const q of search.topQueries) {
      const zeroResult = q.zeroResultCount > 0 && q.count > 0;
      gapQueries.push({
        query: q.query,
        count: q.count,
        zeroResult,
      });
    }
    gapQueries.sort((a, b) => {
      // Zero-result queries are the strongest content-gap signal; sort them
      // first, then by descending count, then alphabetically for stability.
      if (a.zeroResult !== b.zeroResult) return a.zeroResult ? -1 : 1;
      if (a.count !== b.count) return b.count - a.count;
      return a.query < b.query ? -1 : a.query > b.query ? 1 : 0;
    });
  }
  const topUnmatchedQueries = gapQueries
    .filter((q) => q.zeroResult)
    .slice(0, MAX_GAP_QUERIES);

  // --- low-rated steps -----------------------------------------------------
  const lowRated: LowRatedStepRow[] = [];
  if (feedback !== undefined) {
    for (const guide of feedback.perGuide) {
      for (const step of guide.steps) {
        if (step.averageRating === null) continue;
        if (step.averageRating >= LOW_RATING_THRESHOLD) continue;
        if (step.ratingCount === 0 && step.commentCount === 0) continue;
        lowRated.push({
          guideId: guide.guideId,
          stepIndex: step.stepIndex,
          stepTitle: step.stepTitle ?? null,
          averageRating: step.averageRating,
          negativeFeedback: step.negativeCount ?? step.commentCount,
        });
      }
    }
    lowRated.sort((a, b) => {
      if (a.averageRating !== b.averageRating) return a.averageRating - b.averageRating;
      if (a.negativeFeedback !== b.negativeFeedback) {
        return b.negativeFeedback - a.negativeFeedback;
      }
      if (a.guideId !== b.guideId) return a.guideId < b.guideId ? -1 : 1;
      return a.stepIndex - b.stepIndex;
    });
  }
  const lowRatedSteps = lowRated.slice(0, MAX_LOW_RATED_STEPS);

  // --- missing topics ------------------------------------------------------
  // Distinct zero-result queries are the actionable list of topics a
  // knowledge base does not currently cover. We do not attempt to
  // semantically cluster them here (that is the fusion phase's job); the
  // route/dashboard can feed this list to the LLM for clustering when it
  // surfaces the report.
  const missingTopicsSet = new Set<string>();
  for (const q of topUnmatchedQueries) missingTopicsSet.add(q.query);
  const missingTopics = Array.from(missingTopicsSet);

  if (topUnmatchedQueries.length === 0 && lowRatedSteps.length === 0) {
    notes.push(
      "No unmatched searches or low-rated steps were recorded in this window.",
    );
  }

  return {
    kind: "content-gap",
    generatedAt: inputs.generatedAt,
    workspaceId: inputs.workspaceId,
    window: inputs.window,
    inputs: inputsRef,
    topUnmatchedQueries,
    lowRatedSteps,
    missingTopics,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Executive summary                                                           */
/* -------------------------------------------------------------------------- */

export interface ExecutiveSummaryLlmHandle {
  readonly complete: (args: {
    readonly system: string;
    readonly user: string;
    readonly maxOutputChars: number;
    readonly temperature: number;
    readonly model?: string | null;
  }) => Promise<{ readonly text: string; readonly provider?: string; readonly model?: string }>;
  readonly isConfigured: () => boolean;
}

export interface BuildExecutiveOptions {
  readonly llm?: ExecutiveSummaryLlmHandle | undefined;
  readonly preferDeterministic?: boolean;
  readonly model?: string | null;
}

const EXEC_MAX_CHARS = 1_200;

export async function buildExecutiveReport(
  inputs: ReportInputs,
  options: BuildExecutiveOptions = {},
): Promise<ExecutiveReport> {
  const usage = buildUsageReport(inputs);
  const performance_ = buildPerformanceReport(inputs);
  const gap = buildContentGapReport(inputs);

  const composed = composeExecutiveSummary(usage, performance_, gap, inputs.teamMetrics);

  const provenanceInputs: ReportInputRef[] = [
    ...usage.inputs,
    ...performance_.inputs.filter((r) => r.name !== "guideMetrics"),
    ...gap.inputs.filter((r) => r.name !== "searchAnalytics" && r.name !== "feedback"),
  ];

  const deterministic = options.preferDeterministic === true || options.llm === undefined;
  if (deterministic || options.llm === undefined || !options.llm.isConfigured()) {
    return {
      kind: "executive",
      generatedAt: inputs.generatedAt,
      workspaceId: inputs.workspaceId,
      window: inputs.window,
      inputs: provenanceInputs,
      headline: composed.headline,
      summary: composed.summary,
      bullets: composed.bullets,
      generatedBy: "deterministic",
      usedProvider: null,
      usedModel: null,
      layerError: null,
    };
  }

  // ------------------------------------------------------------------ LLM ---
  // The prompt deliberately does not attempt to give the LLM numbers it does
  // not have; it hands over the deterministic summary text (already derived
  // from real inputs) and asks the LLM only to rewrite it more readably and
  // to add an executive framing. The numbers therefore always trace back to
  // the aggregations above.
  const system =
    "You are an analyst writing a one-paragraph executive summary for a customer-support leader. " +
    "You are only allowed to use the facts in the provided bullet list; do not invent numbers, owners, or causes. " +
    "Do not speculate about root causes. Write plainly at roughly a grade-9 reading level, in 90 to 140 words. " +
    "If a metric is null, say it was not available rather than guessing.";
  const user = JSON.stringify(
    {
      window: inputs.window,
      headline: composed.headline,
      metrics: composed.bullets,
      notes: composed.notes,
      contentType: "executive-summary",
    },
    null,
    2,
  );

  try {
    const result = await options.llm.complete({
      system,
      user,
      maxOutputChars: EXEC_MAX_CHARS,
      temperature: 0.2,
      model: options.model ?? null,
    });
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (text.length === 0) {
      return deterministicExecutive(inputs, composed, provenanceInputs, {
        layerError:
          "The LLM returned an empty completion; the deterministic summary is shown instead.",
      });
    }
    return {
      kind: "executive",
      generatedAt: inputs.generatedAt,
      workspaceId: inputs.workspaceId,
      window: inputs.window,
      inputs: provenanceInputs,
      headline: composed.headline,
      summary: text,
      bullets: composed.bullets,
      generatedBy: "llm",
      usedProvider: result.provider ?? null,
      usedModel: result.model ?? options.model ?? null,
      layerError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return deterministicExecutive(inputs, composed, provenanceInputs, {
      layerError: `The LLM call failed: ${message}. The deterministic summary is shown instead.`,
    });
  }
}

function deterministicExecutive(
  inputs: ReportInputs,
  composed: ComposedSummary,
  provenanceInputs: readonly ReportInputRef[],
  extra: { readonly layerError: string | null },
): ExecutiveReport {
  return {
    kind: "executive",
    generatedAt: inputs.generatedAt,
    workspaceId: inputs.workspaceId,
    window: inputs.window,
    inputs: provenanceInputs,
    headline: composed.headline,
    summary: composed.summary,
    bullets: composed.bullets,
    generatedBy: "deterministic",
    usedProvider: null,
    usedModel: null,
    layerError: extra.layerError,
  };
}

interface ComposedSummary {
  readonly headline: string;
  readonly summary: string;
  readonly bullets: readonly string[];
  readonly notes: readonly string[];
}

function composeExecutiveSummary(
  usage: UsageReport,
  performance_: PerformanceReport,
  gap: ContentGapReport,
  team: TeamMetricsSummary | undefined,
): ComposedSummary {
  const notes: string[] = [];
  const bullets: string[] = [];

  bullets.push(
    `${usage.guideCount} guide${usage.guideCount === 1 ? "" : "s"} recorded ${usage.totalViews} view${
      usage.totalViews === 1 ? "" : "s"
    } and ${usage.completions} completion${usage.completions === 1 ? "" : "s"} in the last ${usage.window.days} days.`,
  );
  if (usage.completionRate !== null) {
    bullets.push(
      `The overall completion rate was ${formatPercent(usage.completionRate)}.`,
    );
  } else {
    bullets.push(
      "The overall completion rate was not available (no views recorded in the window).",
    );
  }

  if (performance_.averageStepsCompleted !== null) {
    bullets.push(
      `On average, users reached step ${formatNumber(performance_.averageStepsCompleted)} before leaving.`,
    );
  } else {
    bullets.push("The average reach step was not available for this window.");
  }

  const worst = performance_.worstDropOffSteps[0];
  if (worst !== undefined) {
    bullets.push(
      `The single worst abandonment point was guide ${shortId(worst.guideId)} step ${worst.stepIndex} (${formatPercent(
        worst.dropRate,
      )} of reached users dropped off).`,
    );
  }

  if (gap.topUnmatchedQueries.length > 0) {
    bullets.push(
      `${gap.topUnmatchedQueries.length} search ${
        gap.topUnmatchedQueries.length === 1 ? "query returned" : "queries returned"
      } no results, the strongest signal for new content.`,
    );
  }
  if (gap.lowRatedSteps.length > 0) {
    bullets.push(
      `${gap.lowRatedSteps.length} step${gap.lowRatedSteps.length === 1 ? "" : "s"} were rated below ${LOW_RATING_THRESHOLD.toFixed(
        1,
      )} and may need rewriting.`,
    );
  }

  if (team !== undefined) {
    if (typeof team.generationSuccessRate === "number") {
      bullets.push(
        `Generation success rate was ${formatPercent(team.generationSuccessRate)}.`,
      );
    }
    if (typeof team.estimatedMinutesSaved === "number") {
      bullets.push(
        `Estimated time saved across the window: ${formatNumber(team.estimatedMinutesSaved)} minutes.`,
      );
    }
    if (typeof team.costPerGuideUsd === "number") {
      bullets.push(
        `Average cost per guide: $${team.costPerGuideUsd.toFixed(2)}.`,
      );
    }
  } else {
    notes.push(
      "Team metrics were not available; cost and time-saved figures are omitted.",
    );
  }

  const headline = buildHeadline(usage, performance_, gap);

  const summary = deterministicParagraph(usage, performance_, gap, team);

  return { headline, summary, bullets, notes };
}

function buildHeadline(
  usage: UsageReport,
  performance_: PerformanceReport,
  gap: ContentGapReport,
): string {
  if (usage.totalViews === 0) {
    return `No guide activity in the last ${usage.window.days} days`;
  }
  const completion = usage.completionRate;
  const completionLabel =
    completion === null ? "unknown completion" : `${formatPercent(completion)} completion`;
  const gapLabel =
    gap.topUnmatchedQueries.length > 0
      ? ` · ${gap.topUnmatchedQueries.length} content gap${gap.topUnmatchedQueries.length === 1 ? "" : "s"}`
      : "";
  const dropLabel =
    performance_.worstDropOffSteps.length > 0
      ? ` · worst drop-off ${formatPercent(performance_.worstDropOffSteps[0]!.dropRate)}`
      : "";
  return `${usage.totalViews} views · ${completionLabel}${dropLabel}${gapLabel}`;
}

function deterministicParagraph(
  usage: UsageReport,
  performance_: PerformanceReport,
  gap: ContentGapReport,
  team: TeamMetricsSummary | undefined,
): string {
  if (usage.totalViews === 0) {
    return `No guide activity was recorded in the last ${usage.window.days} days, so there is nothing to summarise. Re-check the window or the workspace configuration if you expected traffic.`;
  }
  const sentences: string[] = [];
  sentences.push(
    `Across the last ${usage.window.days} days, ${usage.totalViews} views were recorded on ${usage.guideCount} guide${
      usage.guideCount === 1 ? "" : "s"
    }, with ${usage.completions} completion${usage.completions === 1 ? "" : "s"}.`,
  );
  if (usage.completionRate !== null) {
    sentences.push(
      `The completion rate was ${formatPercent(usage.completionRate)}.`,
    );
  }
  const worst = performance_.worstDropOffSteps[0];
  if (worst !== undefined) {
    sentences.push(
      `The largest single drop-off was at step ${worst.stepIndex} of guide ${shortId(worst.guideId)}.`,
    );
  }
  if (gap.topUnmatchedQueries.length > 0) {
    sentences.push(
      `${gap.topUnmatchedQueries.length} searches returned no results, indicating a documentation gap the team can close.`,
    );
  } else if (gap.lowRatedSteps.length > 0) {
    sentences.push(
      `${gap.lowRatedSteps.length} step${gap.lowRatedSteps.length === 1 ? "" : "s"} scored below ${LOW_RATING_THRESHOLD.toFixed(
        1,
      )} on user feedback and may need rewriting.`,
    );
  } else {
    sentences.push(
      "No unmatched searches or low-rated steps were recorded in this window.",
    );
  }
  if (team !== undefined && typeof team.generationSuccessRate === "number") {
    sentences.push(
      `Generation runs succeeded ${formatPercent(team.generationSuccessRate)} of the time.`,
    );
  }
  return sentences.join(" ");
}

/* -------------------------------------------------------------------------- */
/* Read helpers                                                                */
/* -------------------------------------------------------------------------- */

function readOptionalNumber(source: unknown, key: string): number | null {
  if (source === null || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPercent(value: number): string {
  const pct = value * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded}%`;
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded);
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/* -------------------------------------------------------------------------- */
/* Dispatcher                                                                  */
/* -------------------------------------------------------------------------- */

export async function buildReport(
  kind: ReportKind,
  inputs: ReportInputs,
  options: BuildExecutiveOptions = {},
): Promise<AnyReport> {
  switch (kind) {
    case "usage":
      return buildUsageReport(inputs);
    case "performance":
      return buildPerformanceReport(inputs);
    case "content-gap":
      return buildContentGapReport(inputs);
    case "executive":
      return buildExecutiveReport(inputs, options);
  }
}
