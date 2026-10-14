import type { RecordData } from "./saas-routes";

/** Aggregate only recorded events. Raw search phrases, IPs and user IDs are
 * deliberately absent from the public-reader event store. */
export function readerInsights(events: RecordData[], guides: RecordData[]) {
  const worstDropOffSteps: RecordData[] = [];
  const lowRatedSteps: RecordData[] = [];
  const queryGroups = new Map<string, { query: string; count: number; zeroResult: true }>();
  const completedBySession = new Map<string, Set<number>>();
  const sessions = new Set<string>();
  let ratings = 0, ratingTotal = 0, searches = 0, unmatchedSearches = 0;
  for (const event of events) {
    const sid = `${event.guideId}/${event.visitId}`;
    if (event.kind === "view") sessions.add(sid);
    if (event.kind === "step-complete" && Number.isInteger(event.stepIndex)) {
      const steps = completedBySession.get(sid) ?? new Set<number>();
      steps.add(Number(event.stepIndex)); completedBySession.set(sid, steps);
    }
    if (event.kind === "feedback") { ratings++; ratingTotal += Number(event.rating); }
    if (event.kind === "search") {
      searches++;
      if (event.resultCount === 0 && typeof event.queryHash === "string") {
        unmatchedSearches++;
        const group = queryGroups.get(event.queryHash) ?? {
          query: `Private search ${event.queryHash.slice(0, 8)} (${event.queryLength} characters)`,
          count: 0, zeroResult: true as const,
        };
        group.count++; queryGroups.set(event.queryHash, group);
      }
    }
  }
  for (const guide of guides) {
    const guideEvents = events.filter(event => event.guideId === guide.id);
    const guideSteps = Array.isArray(guide.steps) ? guide.steps as RecordData[] : [];
    const stepCount = Math.max(0, ...guideEvents.map(event => Number(event.stepCount) || 0));
    const completeSessions = new Set(guideEvents.filter(event => event.kind === "complete").map(event => event.visitId));
    const reached = Array.from({ length: stepCount }, (_, i) => new Set(
      guideEvents.filter(event => ["step-view", "step-complete"].includes(String(event.kind)) && event.stepIndex === i + 1).map(event => event.visitId),
    ));
    for (let i = 0; i < stepCount; i++) {
      const current = reached[i]!;
      const next = reached[i + 1];
      const dropped = [...current].filter(visit => !completeSessions.has(visit) && !(next?.has(visit))).length;
      const stepTitle = String(guideEvents.find(event => event.stepIndex === i + 1)?.stepTitle ?? guideSteps[i]?.title ?? `Step ${i + 1}`);
      if (current.size) worstDropOffSteps.push({ guideId: guide.id, stepIndex: i + 1, stepTitle, reached: current.size, dropped, dropRate: dropped / current.size });
      const feedback = guideEvents.filter(event => event.kind === "feedback" && event.stepIndex === i + 1);
      if (feedback.length) {
        const averageRating = feedback.reduce((sum, event) => sum + Number(event.rating), 0) / feedback.length;
        if (averageRating < 3) lowRatedSteps.push({
          guideId: guide.id, stepIndex: i + 1, stepTitle, averageRating,
          negativeFeedback: feedback.filter(event => Number(event.rating) <= 2).length,
        });
      }
    }
  }
  return {
    averageStepsCompleted: sessions.size ? [...sessions].reduce((sum, session) => sum + (completedBySession.get(session)?.size ?? 0), 0) / sessions.size : null,
    worstDropOffSteps: worstDropOffSteps.sort((a, b) => Number(b.dropped) - Number(a.dropped) || Number(b.dropRate) - Number(a.dropRate)).slice(0, 20),
    lowRatedSteps: lowRatedSteps.sort((a, b) => Number(a.averageRating) - Number(b.averageRating)).slice(0, 20),
    topUnmatchedQueries: [...queryGroups.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    searches, unmatchedSearches, ratings, averageRating: ratings ? ratingTotal / ratings : null,
    hasStepEvents: events.some(event => event.kind === "step-view" || event.kind === "step-complete"),
    hasSearchEvents: searches > 0, hasRatings: ratings > 0,
  };
}
