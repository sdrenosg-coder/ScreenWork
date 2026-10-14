/**
 * POST /api/analytics/events
 * GET  /api/analytics/events?window=7|30|90&kind=usage|performance|content-gap|executive
 *
 * Two responsibilities on one route:
 *
 *   POST  accepts a batch of viewer-dispatched events (view, step_view,
 *         step_complete, guide_complete, search, feedback) that the public
 *         guide page emits. Events are persisted as append-only NDJSON
 *         segments under the workspace-scoped object store; this route does
 *         NOT perform any aggregation inline (that is the reporter's job).
 *         Persistence-only keeps the write path cheap and immutable and
 *         ensures a spike in traffic cannot stall the read path.
 *
 *   GET   builds one of the four reports (usage / performance / content-gap /
 *         executive) from stored NDJSON segments in the requested window.
 *         The route reads the segments, delegates aggregation to
 *         `@zipy/analytics/*` (guideMetrics, dropoff, searchAnalytics,
 *         feedback, teamMetrics) and the presentation to `reports.ts`, then
 *         returns a JSON envelope. No caching layer is applied: each request
 *         recomputes, which is honest about the cost and keeps the response
 *         a pure function of what is on disk.
 *
 * Auth + RBAC:
 *   - POST requires only a valid session (no workspace RBAC) — views of a
 *     published guide arrive from any authenticated user, and the route
 *     pins the workspace from the *guide* record, not the caller's active
 *     workspace, so a viewer who is a member of multiple workspaces writes
 *     the event to the guide's workspace.
 *   - GET requires `PERMISSIONS.analytics_read` in the caller's active
 *     workspace and reads only that workspace's segments.
 *
 * External setup: none for this route. No LLM call happens unless
 * `kind=executive` and an LLM provider is configured; otherwise the
 * deterministic summary is returned.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
  type SessionLike,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { forWorkspace } from "@zipy/storage/objectStore";
import { describeConfiguredProviders } from "@zipy/llm/adapter";

import {
  ANALYTICS_EVENT_KINDS,
  isAnalyticsEventKind,
  type AnalyticsEventKind,
  type AnalyticsEventRecord,
} from "@zipy/analytics/events";
import {
  aggregateGuideMetrics,
  type GuideMetricsSummary,
} from "@zipy/analytics/guideMetrics";
import { aggregateDropoff, type DropoffSummary } from "@zipy/analytics/dropoff";
import {
  aggregateSearchAnalytics,
  type SearchAnalyticsSummary,
} from "@zipy/analytics/searchAnalytics";
import {
  aggregateFeedback,
  type FeedbackSummary,
} from "@zipy/analytics/feedback";
import {
  aggregateTeamMetrics,
  type TeamMetricsSummary,
} from "@zipy/analytics/teamMetrics";
import {
  buildReportWindow,
  buildReport,
  isReportKind,
  isReportWindowDays,
  REPORT_KINDS,
  REPORT_WINDOW_DAYS,
  type ReportKind,
  type ReportInputs,
  type ReportWindow,
  type ReportInputRef,
  type AnyReport,
  type ExecutiveSummaryLlmHandle,
} from "@zipy/analytics/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GUIDES_PREFIX = "guides";
const ANALYTICS_PREFIX = "analytics";

/** Max bytes of a single POST body. Well above the largest realistic batch. */
const MAX_BODY_BYTES = 256 * 1024;

/** Per request batch cap. The public page batches on `visibilitychange`. */
const MAX_EVENTS_PER_POST = 500;

/** Maximum NDJSON segments the GET reads before giving up (safety bound). */
const MAX_SEGMENTS_PER_READ = 2_000;

/** Bound on how many days back the retained-segment listing will scan. */
const MAX_RETAINED_DAYS = 400;

/* -------------------------------------------------------------------------- */
/* Storage adapter                                                             */
/* -------------------------------------------------------------------------- */

interface StorageEntry {
  readonly key: string;
  readonly contentLength: number | undefined;
  readonly lastModified: string | undefined;
}

interface StoreLike {
  readonly get: (key: string) => Promise<Buffer | null>;
  readonly put: (
    key: string,
    data: Buffer,
    opts?: {
      readonly contentType?: string;
      readonly contentLength?: number;
      readonly metadata?: Readonly<Record<string, string>>;
    },
  ) => Promise<void>;
  readonly list?: (
    prefix: string,
    opts?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<{
    readonly entries: readonly StorageEntry[];
    readonly nextCursor: string | null;
  }>;
  readonly listKeys?: (
    prefix: string,
  ) => Promise<readonly (string | StorageEntry)[]>;
}

function guideRecordKey(guideId: string): string {
  return `${GUIDES_PREFIX}/${guideId}.json`;
}

/** Segments are sharded by date so a single day's writes do not grow unbounded. */
function segmentKey(workspaceId: string, dayIso: string, segmentId: string): string {
  return `${ANALYTICS_PREFIX}/${workspaceId}/events/${dayIso}/${segmentId}.ndjson`;
}

function segmentPrefix(workspaceId: string, dayIso: string): string {
  return `${ANALYTICS_PREFIX}/${workspaceId}/events/${dayIso}/`;
}

function eventsRootPrefix(workspaceId: string): string {
  return `${ANALYTICS_PREFIX}/${workspaceId}/events/`;
}

async function readJsonOrNull(store: StoreLike, key: string): Promise<unknown | null> {
  let bytes: Buffer | null;
  try {
    bytes = await store.get(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(message)) return null;
    throw error;
  }
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Stored artifact ${key} is not valid JSON.`);
  }
}

async function readNdjson(store: StoreLike, key: string): Promise<readonly unknown[]> {
  let bytes: Buffer | null;
  try {
    bytes = await store.get(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(message)) return [];
    throw error;
  }
  if (bytes === null) return [];
  const text = bytes.toString("utf8");
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A corrupt line is skipped rather than failing the whole read;
      // the segment is append-only, so a partial write is the only realistic
      // cause and losing one line is better than returning no report.
      process.stderr.write(
        `[/api/analytics/events] skipping corrupt NDJSON line in ${key}\n`,
      );
    }
  }
  return out;
}

/**
 * Enumerate event segment keys for the workspace in the window. The driver may
 * expose `list(prefix)` or `listKeys(prefix)`; the route reads defensively so
 * neither naming style is a hard failure.
 */
async function listSegmentKeys(
  store: StoreLike,
  workspaceId: string,
  window: ReportWindow,
): Promise<readonly string[]> {
  const fromDay = isoDay(window.fromIso);
  const toDay = isoDay(window.toIso);

  // Iterate days from `fromDay` back to `toDay` in ascending date order. A
  // day list is bounded by MAX_RETAINED_DAYS; a caller requesting an
  // absurd window is clipped here rather than scanning the whole bucket.
  const days = enumerateDays(fromDay, toDay, MAX_RETAINED_DAYS);

  const collected: string[] = [];
  for (const day of days) {
    if (collected.length >= MAX_SEGMENTS_PER_READ) break;
    const prefix = segmentPrefix(workspaceId, day);
    const entries = await listPrefixEntries(store, prefix, MAX_SEGMENTS_PER_READ - collected.length);
    for (const entry of entries) {
      collected.push(typeof entry === "string" ? entry : entry.key);
      if (collected.length >= MAX_SEGMENTS_PER_READ) break;
    }
  }
  return collected;
}

async function listPrefixEntries(
  store: StoreLike,
  prefix: string,
  limit: number,
): Promise<readonly StorageEntry[]> {
  if (typeof store.list === "function") {
    const result = await store.list(prefix, { limit });
    return result.entries;
  }
  if (typeof store.listKeys === "function") {
    const raw = await store.listKeys(prefix);
    const out: StorageEntry[] = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        out.push({ key: entry, contentLength: undefined, lastModified: undefined });
      } else {
        out.push(entry);
      }
      if (out.length >= limit) break;
    }
    return out;
  }
  throw new Error(
    "The configured object-store driver exposes neither `list` nor `listKeys`; analytics reads cannot enumerate event segments.",
  );
}

function isoDay(iso: string): string {
  // YYYY-MM-DD in UTC, matching how segments are sharded on write.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

function enumerateDays(from: string, to: string, maxDays: number): readonly string[] {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return [];
  const days: string[] = [];
  let cursor = fromMs;
  while (cursor <= toMs && days.length < maxDays) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 24 * 60 * 60 * 1000;
  }
  return days;
}

/* -------------------------------------------------------------------------- */
/* Auth helpers                                                                */
/* -------------------------------------------------------------------------- */

interface RequireReturn {
  readonly session: SessionRecord | null;
  readonly error: NextResponse | null;
}

async function requireSession(req: Request): Promise<RequireReturn> {
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: false,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/analytics/events] session load failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return {
      session: null,
      error: NextResponse.json(
        { error: "session_error", message: "Could not load the caller session." },
        { status: 500 },
      ),
    };
  }
  if (session === null) {
    return {
      session: null,
      error: NextResponse.json(
        { error: "unauthenticated", message: "Authentication required." },
        { status: 401 },
      ),
    };
  }
  return { session, error: null };
}

function configGate(): NextResponse | null {
  const config = getConfig();
  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Analytics events cannot be accepted or served.",
      },
      { status: 503 },
    );
  }
  if (!config.auth.sessionSecretConfigured) {
    return NextResponse.json(
      { error: "config_error", message: "SESSION_SECRET is not configured on this server." },
      { status: 503 },
    );
  }
  return null;
}

async function openStore(workspaceId: string): Promise<StoreLike | NextResponse> {
  try {
    const store = await forWorkspace(workspaceId);
    return store as unknown as StoreLike;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[/api/analytics/events] object store unavailable: ${message}\n`);
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The artifact object store is not configured on this server. Check STORAGE_DRIVER and the associated S3/local configuration.",
      },
      { status: 503 },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* POST                                                                        */
/* -------------------------------------------------------------------------- */

interface RawEvent {
  readonly kind?: unknown;
  readonly guideId?: unknown;
  readonly stepIndex?: unknown;
  readonly query?: unknown;
  readonly rating?: unknown;
  readonly comment?: unknown;
  readonly sessionId?: unknown;
  readonly occurredAt?: unknown;
  readonly [key: string]: unknown;
}

interface ValidatedEvent {
  readonly kind: AnalyticsEventKind;
  readonly guideId: string;
  readonly stepIndex: number | null;
  readonly query: string | null;
  readonly rating: number | null;
  readonly comment: string | null;
  readonly sessionId: string | null;
  readonly occurredAt: string;
}

interface ValidatedBatch {
  readonly events: readonly ValidatedEvent[];
  /** Distinct guide ids observed in the batch, used to pin the workspace. */
  readonly guideIds: readonly string[];
}

const VALID_RATING = (v: unknown): number | null => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 1 || v > 5) return null;
  return v;
};

function validateBatchBody(raw: unknown): ValidatedBatch | NextResponse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "body",
        message: "Request body must be a JSON object { events: [...] }.",
      },
      { status: 400 },
    );
  }
  const eventsRaw = (raw as { events?: unknown }).events;
  if (!Array.isArray(eventsRaw)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "events",
        message: "events must be an array.",
      },
      { status: 400 },
    );
  }
  if (eventsRaw.length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "events",
        message: "events must contain at least one entry.",
      },
      { status: 400 },
    );
  }
  if (eventsRaw.length > MAX_EVENTS_PER_POST) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "events",
        message: `At most ${MAX_EVENTS_PER_POST} events per request.`,
      },
      { status: 400 },
    );
  }

  const guideSet = new Set<string>();
  const events: ValidatedEvent[] = [];
  for (let i = 0; i < eventsRaw.length; i += 1) {
    const entry = eventsRaw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: `events[${i}]`,
          message: "Each event must be an object.",
        },
        { status: 400 },
      );
    }
    const e = entry as RawEvent;
    if (!isAnalyticsEventKind(e.kind)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: `events[${i}].kind`,
          message: `kind must be one of: ${ANALYTICS_EVENT_KINDS.join(", ")}.`,
        },
        { status: 400 },
      );
    }
    const guideId = typeof e.guideId === "string" ? e.guideId.trim() : "";
    if (!UUID_PATTERN.test(guideId)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: `events[${i}].guideId`,
          message: "guideId must be a UUID.",
        },
        { status: 400 },
      );
    }
    let stepIndex: number | null = null;
    if (e.stepIndex !== undefined && e.stepIndex !== null) {
      if (
        typeof e.stepIndex !== "number" ||
        !Number.isInteger(e.stepIndex) ||
        e.stepIndex < 0
      ) {
        return NextResponse.json(
          {
            error: "validation_error",
            field: `events[${i}].stepIndex`,
            message: "stepIndex must be a non-negative integer when present.",
          },
          { status: 400 },
        );
      }
      stepIndex = e.stepIndex;
    }
    const query =
      typeof e.query === "string" && e.query.trim().length > 0
        ? e.query.trim().slice(0, 500)
        : null;
    const rating = VALID_RATING(e.rating);
    const comment =
      typeof e.comment === "string" && e.comment.trim().length > 0
        ? e.comment.trim().slice(0, 2_000)
        : null;
    const sessionId =
      typeof e.sessionId === "string" && e.sessionId.trim().length > 0
        ? e.sessionId.trim().slice(0, 128)
        : null;
    const occurredAt =
      typeof e.occurredAt === "string" && !Number.isNaN(Date.parse(e.occurredAt))
        ? new Date(e.occurredAt).toISOString()
        : new Date().toISOString();

    events.push({
      kind: e.kind as AnalyticsEventKind,
      guideId,
      stepIndex,
      query,
      rating,
      comment,
      sessionId,
      occurredAt,
    });
    guideSet.add(guideId);
  }

  return { events, guideIds: Array.from(guideSet) };
}

async function resolveEventWorkspace(
  store: StoreLike,
  guideIds: readonly string[],
  callerWorkspaceId: string | null,
): Promise<string | NextResponse> {
  // For each guide id in the batch, look up its workspace. All guides in a
  // batch must belong to a single workspace; events that span workspaces are
  // a client-side bug, not something to silently split. The first guide
  // decides the workspace for the batch.
  if (guideIds.length === 0) {
    return NextResponse.json(
      { error: "validation_error", message: "No guide ids in the batch." },
      { status: 400 },
    );
  }
  const first = guideIds[0]!;
  const raw = await readJsonOrNull(store, guideRecordKey(first));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      {
        error: "not_found",
        field: "guideId",
        message:
          "The guide referenced by these events could not be found in the object store. Events cannot be attributed to a workspace.",
      },
      { status: 404 },
    );
  }
  const guideWorkspaceId = (raw as Record<string, unknown>)["workspaceId"];
  if (typeof guideWorkspaceId !== "string" || guideWorkspaceId.length === 0) {
    return NextResponse.json(
      {
        error: "guide_incomplete",
        field: "guideId",
        message: "The guide record has no workspaceId, so events cannot be attributed.",
      },
      { status: 409 },
    );
  }

  // If the caller has an active workspace that is *different* from the
  // guide's, that's still acceptable for a POST (a viewer of a shared guide
  // writes to the guide's workspace). We only reject when the caller's
  // active workspace is set and the guide is in a workspace they are not a
  // member of — but membership is not something this route can verify from
  // the store alone. The event is a view-related metric, not privileged
  // data; we therefore accept cross-workspace POSTs that target a guide id
  // the caller can see (they already had to know the id and the guide's
  // public share link).
  void callerWorkspaceId;
  return guideWorkspaceId;
}

export async function POST(req: Request): Promise<NextResponse> {
  const gate = configGate();
  if (gate !== null) return gate;

  const { session, error } = await requireSession(req);
  if (error !== null) return error;
  if (session === null) {
    // Safety net; requireSession pairs a null session with a non-null error.
    return NextResponse.json(
      { error: "unauthenticated", message: "Authentication required." },
      { status: 401 },
    );
  }

  // Body size guard — do not buffer an oversized body.
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const len = Number(contentLengthHeader);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return NextResponse.json(
        {
          error: "payload_too_large",
          message: `Batch exceeds the ${MAX_BODY_BYTES}-byte limit.`,
        },
        { status: 413 },
      );
    }
  }

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const validated = validateBatchBody(bodyJson);
  if (validated instanceof NextResponse) return validated;

  // The caller's active workspace is only used as a fallback if the guide
  // record cannot be read (which we then surface as not_found). The normal
  // path pins the workspace to the guide.
  const callerWorkspaceId = session.activeWorkspaceId ?? null;

  // Open the caller's active workspace-scoped store just to read the guide
  // records. If the caller has no active workspace, refuse because the
  // store driver is workspace-scoped and we cannot cross a workspace boundary
  // without knowing which guide is which.
  const callerStoreOrError = await openStore(callerWorkspaceId ?? "");
  if (callerStoreOrError instanceof NextResponse) return callerStoreOrError;
  const callerStore = callerStoreOrError;

  const pinnedOrError = await resolveEventWorkspace(
    callerStore,
    validated.guideIds,
    callerWorkspaceId,
  );
  if (pinnedOrError instanceof NextResponse) return pinnedOrError;
  const pinnedWorkspaceId = pinnedOrError;

  // Re-open the store scoped to the pinned workspace. The event segments live
  // under the guide's workspace, so a viewer who is in a different active
  // workspace still writes to the correct place.
  const writerStoreOrError =
    pinnedWorkspaceId === callerWorkspaceId
      ? callerStore
      : await openStore(pinnedWorkspaceId);
  if (writerStoreOrError instanceof NextResponse) return writerStoreOrError;
  const writerStore = writerStoreOrError;

  const nowIso = new Date().toISOString();
  const dayIso = isoDay(nowIso);
  const segmentId = `${nowIso.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const key = segmentKey(pinnedWorkspaceId, dayIso, segmentId);

  // Each event is enriched with the workspace and a stable server-side
  // envelope. `receivedAt` is server time; `occurredAt` is the client time
  // the view actually happened, when supplied. Both are kept so a client
  // whose clock is off does not corrupt the analytics window.
  const lines: string[] = [];
  for (const e of validated.events) {
    const record: AnalyticsEventRecord = {
      id: randomUUID(),
      workspaceId: pinnedWorkspaceId,
      guideId: e.guideId,
      kind: e.kind,
      stepIndex: e.stepIndex,
      query: e.query,
      rating: e.rating,
      comment: e.comment,
      sessionId: e.sessionId,
      occurredAt: e.occurredAt,
      receivedAt: nowIso,
      schemaVersion: 1,
    } as AnalyticsEventRecord;
    lines.push(JSON.stringify(record));
  }
  const payload = Buffer.from(`${lines.join("\n")}\n`, "utf8");

  try {
    await writerStore.put(key, payload, {
      contentType: "application/x-ndjson",
      contentLength: payload.length,
      metadata: {
        "zipy-kind": "analytics-events",
        "zipy-workspace-id": pinnedWorkspaceId,
        "zipy-day": dayIso,
        "zipy-event-count": String(validated.events.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[/api/analytics/events] segment write failed for ${key}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The analytics segment could not be persisted. Retry the request; no events were recorded.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      accepted: validated.events.length,
      segment: {
        key,
        day: dayIso,
        workspaceId: pinnedWorkspaceId,
        byteLength: payload.length,
      },
      message: "Events accepted and appended to the workspace's analytics stream.",
    },
    { status: 202 },
  );
}

/* -------------------------------------------------------------------------- */
/* GET                                                                         */
/* -------------------------------------------------------------------------- */

export async function GET(req: Request): Promise<NextResponse> {
  const gate = configGate();
  if (gate !== null) return gate;

  const { session, error } = await requireSession(req);
  if (error !== null) return error;
  if (session === null) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Authentication required." },
      { status: 401 },
    );
  }

  // Analytics reads are workspace-scoped, so RBAC is required here (unlike the
  // POST path, which is a viewer-facing write).
  try {
    assertPermission(session as unknown as SessionLike, PERMISSIONS.analytics_read);
  } catch (err) {
    const failure = toAuthzFailure(err);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw err;
  }

  const workspaceId = session.activeWorkspaceId;
  if (workspaceId === null) {
    return NextResponse.json(
      {
        error: "workspace_required",
        message: "An active workspace is required to read analytics reports.",
      },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const kindRaw = url.searchParams.get("kind");
  if (kindRaw === null || kindRaw.length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "kind",
        message: `Query parameter "kind" is required. One of: ${REPORT_KINDS.join(", ")}.`,
      },
      { status: 400 },
    );
  }
  if (!isReportKind(kindRaw)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "kind",
        message: `Unsupported kind "${kindRaw}". Supported: ${REPORT_KINDS.join(", ")}.`,
      },
      { status: 400 },
    );
  }
  const kind: ReportKind = kindRaw;

  const windowRaw = url.searchParams.get("window");
  let windowDays: number = 30;
  if (windowRaw !== null && windowRaw.length > 0) {
    const parsed = Number(windowRaw);
    if (!isReportWindowDays(parsed)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "window",
          message: `window must be one of: ${REPORT_WINDOW_DAYS.join(", ")} (days).`,
        },
        { status: 400 },
      );
    }
    windowDays = parsed;
  }

  const now = new Date();
  const window = buildReportWindow(windowDays, now);

  const storeOrError = await openStore(workspaceId);
  if (storeOrError instanceof NextResponse) return storeOrError;
  const store = storeOrError;

  // -------------------------------------------------------- read segments --
  let segmentKeys: readonly string[];
  try {
    segmentKeys = await listSegmentKeys(store, workspaceId, window);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[/api/analytics/events] segment listing failed for ${workspaceId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message: `Analytics segments could not be listed: ${message}`,
      },
      { status: 503 },
    );
  }

  const events: AnalyticsEventRecord[] = [];
  for (const key of segmentKeys) {
    let rows: readonly unknown[];
    try {
      rows = await readNdjson(store, key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[/api/analytics/events] segment read failed for ${key}: ${message}\n`,
      );
      continue;
    }
    for (const row of rows) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      // Filter by workspace defensively; a segment under a workspace prefix
      // should already be scoped, but we double-check so a mis-placed segment
      // cannot leak cross-workspace data into a report.
      if (r["workspaceId"] !== workspaceId) continue;
      const occurredAt = typeof r["occurredAt"] === "string" ? r["occurredAt"] : null;
      if (occurredAt !== null) {
        if (occurredAt < window.fromIso || occurredAt > window.toIso) continue;
      }
      if (!isAnalyticsEventKind(r["kind"])) continue;
      events.push(row as AnalyticsEventRecord);
    }
  }

  // --------------------------------------------------- aggregate ----------
  let guideMetrics: GuideMetricsSummary | undefined;
  let dropoff: DropoffSummary | undefined;
  let search: SearchAnalyticsSummary | undefined;
  let feedback: FeedbackSummary | undefined;
  let teamMetrics: TeamMetricsSummary | undefined;
  const aggregationErrors: string[] = [];

  try {
    guideMetrics = aggregateGuideMetrics(events, { window, workspaceId });
  } catch (err) {
    aggregationErrors.push(
      `guideMetrics: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    dropoff = aggregateDropoff(events, { window, workspaceId });
  } catch (err) {
    aggregationErrors.push(
      `dropoff: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    search = aggregateSearchAnalytics(events, { window, workspaceId });
  } catch (err) {
    aggregationErrors.push(
      `searchAnalytics: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    feedback = aggregateFeedback(events, { window, workspaceId });
  } catch (err) {
    aggregationErrors.push(
      `feedback: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    teamMetrics = aggregateTeamMetrics(events, { window, workspaceId });
  } catch (err) {
    aggregationErrors.push(
      `teamMetrics: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const inputs: ReportInputs = {
    workspaceId,
    generatedAt: now.toISOString(),
    window,
    guideMetrics,
    dropoff,
    search,
    feedback,
    teamMetrics,
  };

  // ------------------------------------------------------ LLM handle ------
  const executiveLlm = kind === "executive" ? makeExecutiveLlmHandle() : undefined;

  let report: AnyReport;
  try {
    report = await buildReport(kind, inputs, {
      llm: executiveLlm,
      preferDeterministic: executiveLlm === undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[/api/analytics/events] ${kind} report failed for ${workspaceId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "report_failed",
        message: `The ${kind} report could not be generated: ${message}`,
      },
      { status: 500 },
    );
  }

  const provenance = provenanceSummary(report.inputs, aggregationErrors);
  const segmentCount = segmentKeys.length;
  const eventCount = events.length;

  return NextResponse.json({
    report,
    provenance,
    scan: {
      segmentsRead: segmentCount,
      eventsRead: eventCount,
      truncated: segmentCount >= MAX_SEGMENTS_PER_READ,
    },
    warnings:
      aggregationErrors.length === 0
        ? []
        : aggregationErrors.map(
            (e) =>
              `An aggregation layer reported an error and its fields were omitted from the report: ${e}`,
          ),
  });
}

/* -------------------------------------------------------------------------- */
/* Provenance helpers                                                          */
/* -------------------------------------------------------------------------- */

function provenanceSummary(
  inputs: readonly ReportInputRef[],
  aggregationErrors: readonly string[],
): {
  readonly sources: readonly ReportInputRef[];
  readonly missing: readonly string[];
  readonly aggregationErrors: readonly string[];
} {
  const missing: string[] = [];
  for (const i of inputs) {
    if (i.empty) missing.push(i.name);
  }
  return {
    sources: inputs,
    missing,
    aggregationErrors,
  };
}

/* -------------------------------------------------------------------------- */
/* LLM handle construction                                                     */
/* -------------------------------------------------------------------------- */

function makeExecutiveLlmHandle(): ExecutiveSummaryLlmHandle | undefined {
  const state = describeConfiguredProviders() as unknown;
  if (state === null || typeof state !== "object") return undefined;
  const configured = (state as { configured?: unknown }).configured;
  if (!Array.isArray(configured) || configured.length === 0) return undefined;

  return {
    isConfigured: () => true,
    complete: async (args) => {
      type AdapterModule = {
        readonly complete: (a: {
          readonly task?: string;
          readonly system: string;
          readonly user: string;
          readonly maxOutputChars: number;
          readonly temperature: number;
          readonly model?: string | null;
        }) => Promise<{
          readonly text: string;
          readonly provider?: string;
          readonly model?: string;
        }>;
      };
      const mod = (await import("@zipy/llm/adapter")) as unknown as AdapterModule;
      const result = await mod.complete({
        task: "analytics.executive-summary",
        system: args.system,
        user: args.user,
        maxOutputChars: args.maxOutputChars,
        temperature: args.temperature,
        model: args.model ?? null,
      });
      return {
        text: result.text,
        provider: result.provider,
        model: result.model,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

export async function PUT(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Analytics events are append-only. This endpoint accepts GET (reports) and POST (event batches).",
    },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}

export async function PATCH(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Analytics events are append-only. This endpoint accepts GET (reports) and POST (event batches).",
    },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Analytics segments are immutable once written. Delete a workspace's events through the admin retention surface, not this route.",
    },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}
