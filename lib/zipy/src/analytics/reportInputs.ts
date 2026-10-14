/** Adapts canonical per-guide aggregations to the workspace report contract. */
import type { AnalyticsEvent } from "./events";
import { computeGuideMetricsBatch } from "./guideMetrics";
import { computeDropOff } from "./dropoff";
import { computeSearchAnalytics } from "./searchAnalytics";
import { computeFeedback } from "./feedback";
import { computeTeamMetrics } from "./teamMetrics";

interface Context {
  workspaceId: string;
  window: { fromIso: string; toIso: string };
}
function scoped(events: readonly AnalyticsEvent[], context: Context) {
  return events.filter(event => event.workspaceId === context.workspaceId
    && event.occurredAt >= context.window.fromIso && event.occurredAt <= context.window.toIso);
}
function ids(events: readonly AnalyticsEvent[]) {
  return [...new Set(events.map(event => event.guideId))];
}
export function aggregateGuideMetrics(input: readonly AnalyticsEvent[], context: Context) {
  const events = scoped(input, context);
  return {
    generatedAt: new Date().toISOString(),
    perGuide: computeGuideMetricsBatch({ events, workspaceId: context.workspaceId, guideIds: ids(events) }).map(metric => ({
      ...metric,
      title: metric.slug ?? metric.guideId,
      // Reaching a step is not evidence of completing it.
      averageStepsCompleted: null as number | null,
      lastViewedAtIso: events.filter(event => event.guideId === metric.guideId && event.kind === "guide-view")
        .map(event => event.occurredAt).sort().at(-1) ?? null,
    })),
  };
}
export function aggregateDropoff(input: readonly AnalyticsEvent[], context: Context) {
  const events = scoped(input, context);
  return {
    generatedAt: new Date().toISOString(),
    perGuide: ids(events).flatMap(guideId => {
      const counts = events.filter(event => event.guideId === guideId)
        .map(event => event.payload.stepCount).filter((count): count is number => Number.isInteger(count) && Number(count) > 0);
      if (!counts.length) return []; // Never infer a total step count from a partial visit.
      const analysis = computeDropOff({ events, workspaceId: context.workspaceId, guideId, stepCount: Math.max(...counts) });
      return [{ guideId, steps: analysis.rows.map(row => ({
        stepIndex: row.stepIndex, stepTitle: null as string | null,
        reached: row.reached, dropped: row.droppedOff,
      })) }];
    }),
  };
}
export function aggregateSearchAnalytics(input: readonly AnalyticsEvent[], context: Context) {
  const analysis = computeSearchAnalytics({ events: scoped(input, context), workspaceId: context.workspaceId });
  return {
    generatedAt: analysis.generatedAt,
    topQueries: analysis.rows.map(row => ({ query: row.sample, count: row.issued, zeroResultCount: row.zeroResult })),
  };
}
export function aggregateFeedback(input: readonly AnalyticsEvent[], context: Context) {
  const events = scoped(input, context);
  return {
    generatedAt: new Date().toISOString(),
    perGuide: ids(events).map(guideId => {
      const feedback = computeFeedback({ events, workspaceId: context.workspaceId, guideId });
      return { guideId, steps: feedback.steps.map(step => ({
        stepIndex: step.stepIndex, stepTitle: step.label, averageRating: step.averageRating,
        ratingCount: step.responseCount, commentCount: step.commentCount,
        negativeCount: step.distribution.r1 + step.distribution.r2,
      })) };
    }),
  };
}
export function aggregateTeamMetrics(input: readonly AnalyticsEvent[], context: Context) {
  const metrics = computeTeamMetrics({ events: scoped(input, context), workspaceId: context.workspaceId });
  return {
    ...metrics,
    estimatedMinutesSaved: metrics.estimatedTimeSavedMs === null ? null : metrics.estimatedTimeSavedMs / 60_000,
    costPerGuideUsd: metrics.guides.length && metrics.unspecifiedCostRuns < metrics.totalRuns
      ? metrics.totalCostUsd / metrics.guides.length : null,
  };
}
export type GuideMetricsSummary = ReturnType<typeof aggregateGuideMetrics>;
export type DropoffSummary = ReturnType<typeof aggregateDropoff>;
export type SearchAnalyticsSummary = ReturnType<typeof aggregateSearchAnalytics>;
export type FeedbackReportSummary = ReturnType<typeof aggregateFeedback>;
export type TeamMetricsSummary = ReturnType<typeof aggregateTeamMetrics>;
