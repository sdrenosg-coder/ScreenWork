import type { Express } from "express";
import { PERMISSIONS } from "@workspace/zipy/web/rbac/permissions";
import { ApiFailure, endpoint, workspace, read, type Store, type RecordData } from "./saas-routes";
import { readerInsights } from "./reader-analytics";
import { mapConcurrent } from "@workspace/zipy/storage/mapConcurrent";

export async function listRecords(store: Store, prefix: string, accept: (key: string) => boolean = key => key.endsWith(".json")) {
  const records: RecordData[] = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let segments = 0;
  do {
    const page = await store.list(prefix, { limit: 250, cursor });
    segments++;
    await mapConcurrent(page.entries, async entry => {
      if (!accept(entry.key)) return;
      const record = await read(store, entry.key);
      if (record) records.push(record);
    });
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("Storage repeated a listing cursor.");
      cursors.add(cursor);
    }
    if (records.length >= 10000 && cursor) return { records, segments, truncated: true };
  } while (cursor);
  return { records, segments, truncated: false };
}

export function registerWorkspaceReports(app: Express) {
  app.get("/api/v1/audit", endpoint(async (req, res) => {
    const { store, workspaceId } = await workspace(req, PERMISSIONS.guide_read);
    const limit = Number(req.query.limit ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiFailure(400, "validation_error", "limit must be between 1 and 100.");
    const result = await listRecords(store, "activity/");
    const sorted = result.records.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
    let after = sorted;
    if (req.query.cursor !== undefined) {
      try {
        const cursor = JSON.parse(Buffer.from(String(req.query.cursor), "base64url").toString()) as { at?: string; id?: string };
        if (typeof cursor.at !== "string" || typeof cursor.id !== "string") throw new Error("cursor");
        after = sorted.filter(row => String(row.at) < cursor.at! || (row.at === cursor.at && String(row.id) < cursor.id!));
      } catch { throw new ApiFailure(400, "validation_error", "The activity cursor is invalid."); }
    }
    const data = after.slice(0, limit);
    const last = data[data.length - 1];
    const nextCursor = after.length > limit && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString("base64url") : null;
    res.json({
      data, entries: data, pagination: { nextCursor, total: sorted.length, hasMore: nextCursor !== null },
      meta: { workspaceId, generatedAt: new Date().toISOString(), truncated: result.truncated },
      nextCursor, workspaceId, generatedAt: new Date().toISOString(),
    });
  }));

  app.get("/api/analytics/events", endpoint(async (req, res) => {
    const { store, workspaceId } = await workspace(req, PERMISSIONS.analytics_read);
    const kind = String(req.query.kind ?? "usage");
    const days = Number(req.query.window ?? 30);
    if (!["usage", "performance", "content-gap", "executive"].includes(kind) || ![7, 30, 90].includes(days)) {
      throw new ApiFailure(400, "validation_error", "Choose a supported report and a 7, 30 or 90 day window.");
    }
    const generatedAt = new Date().toISOString();
    const fromIso = new Date(Date.now() - days * 86400000).toISOString();
    const [guides, scanned] = await Promise.all([
      listRecords(store, "guides/", key => /^guides\/[0-9a-f-]{36}\.json$/i.test(key)),
      listRecords(store, "reader-events/"),
    ]);
    const events = scanned.records.filter(event => typeof event.at === "string" && event.at >= fromIso && event.at <= generatedAt);
    const insights = readerInsights(events, guides.records);
    const rows = guides.records.map(guide => {
      const views = events.filter(event => event.guideId === guide.id && event.kind === "view");
      const visits = new Set(views.map(event => event.visitId));
      const completions = events.filter(event => event.guideId === guide.id && event.kind === "complete" && visits.has(event.visitId)).length;
      return {
        guideId: String(guide.id), title: String(guide.title ?? "Untitled guide"),
        views: views.length, completions, completionRate: views.length ? completions / views.length : null,
        lastViewedAtIso: views.map(event => String(event.at)).sort().at(-1) ?? null,
      };
    }).sort((a, b) => b.views - a.views || a.title.localeCompare(b.title));
    const totalViews = rows.reduce((sum, row) => sum + row.views, 0);
    const completions = rows.reduce((sum, row) => sum + row.completions, 0);
    const publishedGuideCount = guides.records.filter(guide => guide.status === "published" && guide.visibility === "public").length;
    const inputs = [
      { name: "Current workspace guides", generatedAt, empty: guides.records.length === 0 },
      { name: "Recorded anonymous reader sessions", generatedAt, empty: events.length === 0 },
    ];
    const base = { kind, generatedAt, workspaceId, window: { fromIso, toIso: generatedAt, days }, inputs };
    const notes = [
      "Views count anonymous guide sessions recorded since tracking was enabled. Reloading in the same tab does not add a view.",
      "Completions are explicitly marked by readers. Unique people are not identified; no account, IP address or fingerprint is stored in analytics events.",
      "Guide inventory counts reflect the current workspace. Reader counts use the selected date window; unrecorded historical visits cannot be reconstructed.",
    ];
    let report: RecordData;
    if (kind === "usage") {
      report = { ...base, guideCount: guides.records.length, publishedGuideCount, totalViews, uniqueViewers: null, completions, completionRate: totalViews ? completions / totalViews : null, perGuide: rows, notes };
    } else if (kind === "performance") {
      report = { ...base, averageStepsCompleted: insights.hasStepEvents ? insights.averageStepsCompleted : null, worstDropOffSteps: insights.worstDropOffSteps, goodCompletionGuides: rows.filter(row => row.views > 0 && Number(row.completionRate) >= .7), weakCompletionGuides: rows.filter(row => row.views > 0 && Number(row.completionRate) < .7), notes: [...notes, "Step reach is recorded when a step is visible. Step completion is explicitly marked. Drop-off is inferred from recorded reach, not a claim that a reader failed the process."] };
    } else if (kind === "content-gap") {
      report = { ...base, topUnmatchedQueries: insights.topUnmatchedQueries, lowRatedSteps: insights.lowRatedSteps, missingTopics: [], searchCount: insights.searches, unmatchedSearches: insights.unmatchedSearches, ratingCount: insights.ratings, averageRating: insights.averageRating, notes: ["Searches and 1–5 ratings are collected from public readers. Search phrases are never stored: hashes group repeated searches without exposing their text.", "Missing topics cannot be named from private query hashes. Low ratings and zero-result counts identify where authors should investigate."] };
    } else {
      report = {
        ...base, headline: `${totalViews} recorded guide sessions in ${days} days`,
        summary: `This workspace has ${guides.records.length} guides, including ${publishedGuideCount} public guides. Readers recorded ${completions} completions during the selected period.`,
        bullets: [...rows.filter(row => row.views > 0).slice(0, 3).map(row => `${row.title}: ${row.views} sessions, ${row.completions} completions.`), ...notes],
        generatedBy: "deterministic", usedProvider: null, usedModel: null, layerError: null,
      };
    }
    const truncated = guides.truncated || scanned.truncated;
    res.json({
      report, provenance: { sources: inputs, missing: kind === "content-gap" ? [...(!insights.hasSearchEvents ? ["No search events in this window"] : []), ...(!insights.hasRatings ? ["No ratings in this window"] : []), "Raw search phrases (not collected)"] : kind === "performance" ? (!insights.hasStepEvents ? ["No step events in this window"] : []) : ["Cross-session viewer identity (not collected)"], aggregationErrors: [] },
      scan: { segmentsRead: guides.segments + scanned.segments, eventsRead: scanned.records.length, truncated },
      warnings: truncated ? ["The scan reached its safety limit. Counts are partial; do not interpret them as complete totals."] : [],
    });
  }));
}
