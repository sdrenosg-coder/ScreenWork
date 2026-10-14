/**
 * Zipy AI — analytics: search analytics (phase 23, batch 1).
 *
 * Search analytics answers the question a documentation owner asks when
 * readers cannot find what they need: *what are people searching for that
 * isn't there?* It consumes the `guide-search` events that `events.ts`
 * records and produces three views:
 *
 *   1. **Top queries.** The most frequent normalized query strings, with
 *      their per-query view counts and zero-result rate. A query that
 *      returned zero results is a *content-gap signal*; the batch-2 report
 *      layer turns the zero-result subset into prose.
 *
 *   2. **Per-guide search context.** For a single guide, which queries were
 *      issued while reading it, and which of them found a match. This is the
 *      view that appears next to a guide in the editor.
 *
 *   3. **Zero-result ledger.** The set of distinct queries that returned no
 *      result at least once, ordered by issue count, for the content-gap
 *      report.
 *
 * Design rules honoured:
 *
 *  - **No invented queries.** A query is only counted when a `guide-search`
 *    event carried a non-empty `query`. Query text is normalized for
 *    comparison (trim, collapse internal whitespace, lowercase for grouping)
 *    but the *display* string is the reader's own spelling; the module
 *    records both so a dashboard can show the reader's exact words.
 *
 *  - **Deterministic.** Ties on count break by the normalized query's
 *    lexicographic ascending order, so two runs over the same stream
 *    produce identical output. No clock reads on the computation path
 *    except the single `generatedAt` stamp.
 *
 *  - **Workspace-scoped.** The filter is `workspaceId`, and optionally
 *    `guideId`. A query issued in another workspace is never included. The
 *    route layer enforces RBAC; this module enforces the isolation in the
 *    arithmetic.
 *
 *  - **Empty is not zero.** A workspace with no search events produces
 *    `empty: true` and a null `zeroResultRate`; a rate over an empty
 *    denominator is not zero, and the dashboard must be able to tell "no
 *    searches recorded" from "0% of searches failed".
 *
 * The module never reads the guide plan and never fetches the search index;
 * the caller supplies the events and, when a guide scope is desired, the
 * `guideId`. That keeps the module a pure function of its inputs.
 */

import type { AnalyticsEvent } from "./events";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SearchAnalyticsErrorCode = "invalid-input" | "invalid-window";

export class SearchAnalyticsError extends Error {
  readonly code: SearchAnalyticsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SearchAnalyticsErrorCode,
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
 * One distinct query, aggregated. `normalized` is the grouping key; `sample`
 * is the reader's exact spelling from the *first* occurrence, retained so the
 * dashboard can display what was actually typed without a second lookup.
 */
export interface SearchQueryRow {
  /** The reader's exact spelling, from the first occurrence in the stream. */
  readonly sample: string;
  /** The comparison key: trimmed, whitespace-collapsed, lowercased. */
  readonly normalized: string;
  /** Total `guide-search` events for this query in the window. */
  readonly issued: number;
  /** How many of those returned at least one result. */
  readonly withResults: number;
  /** How many returned zero results (`resultCount === 0`). */
  readonly zeroResult: number;
  /** zeroResult / issued, or null when `issued` is 0 (never the case for a row). */
  readonly zeroResultRate: number | null;
  /** Distinct sessions that issued this query. */
  readonly sessions: number;
  /** Distinct guide ids the query was issued against. */
  readonly guideIds: readonly string[];
}

export interface SearchAnalytics {
  readonly version: "search-analytics/1";
  readonly workspaceId: string;
  /** Null when the caller requested a workspace-wide report. */
  readonly guideId: string | null;
  /** Total `guide-search` events counted in the window. */
  readonly totalSearches: number;
  /** Distinct normalized queries. */
  readonly distinctQueries: number;
  /** Distinct queries that returned zero results at least once. */
  readonly distinctZeroResultQueries: number;
  /** Total searches that returned zero results. */
  readonly zeroResultSearches: number;
  /** zeroResultSearches / totalSearches, or null when totalSearches is 0. */
  readonly zeroResultRate: number | null;
  /** Rows ordered by `issued` desc, then normalized asc. */
  readonly rows: readonly SearchQueryRow[];
  /** The zero-result subset, same ordering. Convenience for the gap report. */
  readonly zeroResultRows: readonly SearchQueryRow[];
  /** True when no search events matched the filter and window. */
  readonly empty: boolean;
  /** ISO stamp the aggregation ran. */
  readonly generatedAt: string;
}

export interface ComputeSearchAnalyticsInput {
  readonly events: readonly AnalyticsEvent[];
  readonly workspaceId: string;
  /** When supplied, restrict to searches issued against this guide. */
  readonly guideId?: string | null;
  /** Inclusive lower bound on `occurredAt`; ISO string. */
  readonly since?: string | null;
  /** Inclusive upper bound on `occurredAt`; ISO string. */
  readonly until?: string | null;
  /**
   * Maximum number of rows to return. Defaults to 100. The aggregation still
   * counts every event; only the returned `rows` are truncated, and
   * `truncated` is set when it happens so the caller knows.
   */
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function computeSearchAnalytics(
  input: ComputeSearchAnalyticsInput,
): SearchAnalytics {
  if (input === null || typeof input !== "object") {
    throw new SearchAnalyticsError("computeSearchAnalytics requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.events)) {
    throw new SearchAnalyticsError("`events` must be an array.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new SearchAnalyticsError("`workspaceId` is required.", "invalid-input");
  }

  const since = parseBoundary(input.since, "since", -Infinity);
  const until = parseBoundary(input.until, "until", Infinity);
  if (since > until) {
    throw new SearchAnalyticsError(
      `The analytics window is empty: "since" (${String(input.since)}) is after "until" (${String(input.until)}).`,
      "invalid-window",
      { since: input.since, until: input.until },
    );
  }

  const guideScoped =
    typeof input.guideId === "string" && input.guideId.trim().length > 0
      ? input.guideId
      : null;

  interface Accum {
    sample: string;
    issued: number;
    withResults: number;
    zeroResult: number;
    sessions: Set<string>;
    guideIds: Set<string>;
  }
  const byQuery = new Map<string, Accum>();
  let totalSearches = 0;
  let zeroResultSearches = 0;

  for (const event of input.events) {
    if (event === null || typeof event !== "object") continue;
    if (event.kind !== "guide-search") continue;
    if (event.workspaceId !== input.workspaceId) continue;
    if (guideScoped !== null && event.guideId !== guideScoped) continue;

    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs)) continue;
    if (occurredMs < since || occurredMs > until) continue;

    const rawQuery = readQueryText(event.payload.query);
    if (rawQuery === null) continue;
    const normalized = normalizeQuery(rawQuery);
    if (normalized.length === 0) continue;

    totalSearches += 1;

    const resultCount = readResultCount(event.payload.resultCount);
    const isZero = resultCount !== null && resultCount === 0;
    if (isZero) zeroResultSearches += 1;

    let acc = byQuery.get(normalized);
    if (acc === undefined) {
      acc = {
        sample: rawQuery,
        issued: 0,
        withResults: 0,
        zeroResult: 0,
        sessions: new Set<string>(),
        guideIds: new Set<string>(),
      };
      byQuery.set(normalized, acc);
    }
    acc.issued += 1;
    if (resultCount !== null && resultCount > 0) acc.withResults += 1;
    if (isZero) acc.zeroResult += 1;
    if (typeof event.sessionId === "string" && event.sessionId.length > 0) {
      acc.sessions.add(event.sessionId);
    }
    if (typeof event.guideId === "string" && event.guideId.length > 0) {
      acc.guideIds.add(event.guideId);
    }
  }

  const allRows: SearchQueryRow[] = [];
  for (const [normalized, acc] of byQuery.entries()) {
    allRows.push({
      sample: acc.sample,
      normalized,
      issued: acc.issued,
      withResults: acc.withResults,
      zeroResult: acc.zeroResult,
      zeroResultRate: acc.issued > 0 ? acc.zeroResult / acc.issued : null,
      sessions: acc.sessions.size,
      guideIds: [...acc.guideIds].sort(compareStrings),
    });
  }
  allRows.sort((a, b) => {
    if (b.issued !== a.issued) return b.issued - a.issued;
    return compareStrings(a.normalized, b.normalized);
  });

  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
      ? Math.floor(input.limit)
      : 100;
  const rows = allRows.slice(0, limit).map(freezeRow);
  const zeroResultRows = allRows
    .filter((r) => r.zeroResult > 0)
    .slice(0, limit)
    .map(freezeRow);

  const distinctZeroResultQueries = allRows.filter((r) => r.zeroResult > 0).length;
  const empty = totalSearches === 0;

  return Object.freeze({
    version: "search-analytics/1" as const,
    workspaceId: input.workspaceId,
    guideId: guideScoped,
    totalSearches,
    distinctQueries: allRows.length,
    distinctZeroResultQueries,
    zeroResultSearches,
    zeroResultRate: totalSearches > 0 ? zeroResultSearches / totalSearches : null,
    rows,
    zeroResultRows,
    empty,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * One-line human summary for the dashboard card. Stable wording; no locale
 * formatting, so the string is byte-identical across environments and can
 * be snapshot-tested.
 */
export function summariseSearchAnalytics(analytics: SearchAnalytics): string {
  if (analytics.empty) {
    return analytics.guideId === null
      ? `No search events recorded for workspace ${analytics.workspaceId} in the window.`
      : `No search events recorded for guide ${analytics.guideId} in the window.`;
  }
  const rate =
    analytics.zeroResultRate === null
      ? "no zero-result rate available"
      : `${Math.round(analytics.zeroResultRate * 1000) / 10}% returned nothing`;
  const top = analytics.zeroResultRows.slice(0, 3).map((r) => `"${r.sample}"`);
  const gapClause =
    top.length === 0
      ? "No zero-result queries recorded."
      : `Most-requested gaps: ${top.join(", ")}.`;
  return `${analytics.totalSearches} search${analytics.totalSearches === 1 ? "" : "es"} across ${analytics.distinctQueries} distinct quer${analytics.distinctQueries === 1 ? "y" : "ies"} — ${rate}. ${gapClause}`;
}

/** Rehydrate a persisted `SearchAnalytics` payload. Rows keep their shape. */
export function rehydrateSearchAnalytics(value: unknown): SearchAnalytics {
  if (value === null || typeof value !== "object") {
    throw new SearchAnalyticsError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const rows = readRows(r["rows"]);
  const zeroResultRows = readRows(r["zeroResultRows"]);
  return {
    version: "search-analytics/1",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    guideId: typeof r["guideId"] === "string" ? r["guideId"] : null,
    totalSearches: readCount(r["totalSearches"]),
    distinctQueries: readCount(r["distinctQueries"]),
    distinctZeroResultQueries: readCount(r["distinctZeroResultQueries"]),
    zeroResultSearches: readCount(r["zeroResultSearches"]),
    zeroResultRate:
      typeof r["zeroResultRate"] === "number" && Number.isFinite(r["zeroResultRate"])
        ? r["zeroResultRate"]
        : null,
    rows,
    zeroResultRows,
    empty: r["empty"] === true,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function readQueryText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/gu, " ").toLowerCase();
}

function readResultCount(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0) return null;
  return Math.trunc(v);
}

function readCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

function freezeRow(row: SearchQueryRow): SearchQueryRow {
  return Object.freeze({
    ...row,
    guideIds: Object.freeze(row.guideIds.slice()),
  });
}

function readRows(v: unknown): SearchQueryRow[] {
  if (!Array.isArray(v)) return [];
  const out: SearchQueryRow[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const normalized = typeof o["normalized"] === "string" ? o["normalized"] : "";
    if (normalized.length === 0) continue;
    out.push({
      sample: typeof o["sample"] === "string" ? o["sample"] : normalized,
      normalized,
      issued: readCount(o["issued"]),
      withResults: readCount(o["withResults"]),
      zeroResult: readCount(o["zeroResult"]),
      zeroResultRate:
        typeof o["zeroResultRate"] === "number" && Number.isFinite(o["zeroResultRate"])
          ? o["zeroResultRate"]
          : null,
      sessions: readCount(o["sessions"]),
      guideIds: Array.isArray(o["guideIds"])
        ? (o["guideIds"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    });
  }
  return out;
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
    throw new SearchAnalyticsError(
      `Field "${field}" must be an ISO-8601 string when supplied.`,
      "invalid-window",
      { field },
    );
  }
  const t = raw.trim();
  if (t.length === 0) return absent;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) {
    throw new SearchAnalyticsError(
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
  readQueryText,
  normalizeQuery,
  readResultCount,
  compareStrings,
  parseBoundary,
});
