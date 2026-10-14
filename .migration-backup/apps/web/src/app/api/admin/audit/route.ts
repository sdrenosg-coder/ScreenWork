/**
 * GET /api/admin/audit
 *
 * Returns a page of audit-log entries for the caller's active workspace.
 * This is the read surface for the audit trail the platform-wide
 * `@zipy/security/auditLog` module writes to. The route is intentionally
 * narrow:
 *
 *   - It filters by the session's workspace. A caller cannot read another
 *     workspace's log by supplying an id in the query.
 *   - It enforces `PERMISSIONS.admin_read` (the RBAC admin read permission).
 *     A caller without it receives a 403 with the reason.
 *   - It supports `cursor`, `limit`, `action`, `actorId`, `from`, `to`.
 *     Filter values are validated; an unparseable timestamp is a 400 rather
 *     than a silent skip.
 *   - The cursor is an opaque base64url of `{at, id}` issued by this route.
 *     A cursor the server did not issue is a 400, never a restart from the
 *     beginning (which would duplicate entries for a caller that is paging).
 *
 * What this route does not do:
 *   - It does not write audit entries. Writes happen at the point of the
 *     action and are the responsibility of the calling resource route.
 *   - It does not export entries as CSV or JSON. Bulk export is a separate
 *     operation so it can be batched and rate-limited; the plan lists it as
 *     a later deliverable.
 *   - It does not attempt to redact IPs or user agents. Those are the whole
 *     point of the trail; access to this endpoint is what is gated.
 *
 * Storage:
 *   The audit entries live in the workspace-scoped object store under
 *   `audit/{YYYY-MM}/{uuid}.json`, mirroring the layout used by the audit
 *   writer. This route lists the prefix and reads entries. When the store
 *   does not expose a listing primitive the route fails with 503, naming the
 *   missing driver capability rather than silently returning an empty page.
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
  type SessionLike,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { forWorkspace } from "@zipy/storage/objectStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUDIT_PREFIX = "audit";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const MAX_ACTION_LENGTH = 200;

const AUDIT_OUTCOMES: readonly string[] = [
  "allowed",
  "denied",
  "error",
  "unknown",
];

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

interface StorageEntry {
  readonly key: string;
  readonly contentLength: number | undefined;
  readonly lastModified: string | undefined;
}

type StoreLike = {
  readonly get: (key: string) => Promise<Buffer | null>;
  readonly list?: (
    prefix: string,
    opts?: {
      readonly limit?: number;
      readonly cursor?: string;
    },
  ) => Promise<{
    readonly entries: readonly StorageEntry[];
    readonly nextCursor: string | null;
  }>;
  readonly listKeys?: (
    prefix: string,
  ) => Promise<readonly (string | StorageEntry)[]>;
};

async function openStore(
  workspaceId: string,
): Promise<StoreLike | NextResponse> {
  try {
    const store = await forWorkspace(workspaceId);
    return store as unknown as StoreLike;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[/api/admin/audit] object store unavailable: ${message}\n`);
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The audit store is not reachable on this server. Check STORAGE_DRIVER and the associated configuration.",
      },
      { status: 503 },
    );
  }
}

function entryIdFromKey(key: string): string | null {
  const match = /^audit\/\d{4}-\d{2}\/([0-9a-f-]{36})\.json$/i.exec(key);
  if (match === null) return null;
  const id = match[1];
  return typeof id === "string" && UUID_PATTERN.test(id) ? id : null;
}

async function readJson(
  store: StoreLike,
  key: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  let bytes: Buffer | null;
  try {
    bytes = await store.get(key);
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(m)) return null;
    throw error;
  }
  if (bytes === null) return null;
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Readonly<Record<string, unknown>>;
}

async function listAuditKeys(
  store: StoreLike,
): Promise<readonly StorageEntry[]> {
  const prefix = `${AUDIT_PREFIX}/`;

  if (typeof store.list === "function") {
    const result = await store.list(prefix, {});
    return result.entries;
  }
  if (typeof store.listKeys === "function") {
    const raw = await store.listKeys(prefix);
    const out: StorageEntry[] = [];
    for (const entry of raw) {
      if (typeof entry === "string") {
        out.push({ key: entry, contentLength: undefined, lastModified: undefined });
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  throw new Error(
    "The configured object-store driver exposes neither `list` nor `listKeys`, so audit entries cannot be enumerated. Use a driver that implements object listing.",
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

interface CursorValue {
  readonly at: string;
  readonly id: string;
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorValue | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as CursorValue).at === "string" &&
      typeof (parsed as CursorValue).id === "string" &&
      UUID_PATTERN.test((parsed as CursorValue).id)
    ) {
      return { at: (parsed as CursorValue).at, id: (parsed as CursorValue).id };
    }
    return null;
  } catch {
    return null;
  }
}

function isAfterCursor(
  entry: { readonly at: string; readonly id: string },
  cursor: CursorValue,
): boolean {
  if (entry.at < cursor.at) return true;
  if (entry.at > cursor.at) return false;
  return entry.id < cursor.id;
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

interface AuthedContext {
  readonly session: SessionRecord;
  readonly workspaceId: string;
}

async function authenticate(req: Request): Promise<AuthedContext | NextResponse> {
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: false,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/admin/audit] session load failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return NextResponse.json(
      { error: "session_error", message: "Could not load the caller session." },
      { status: 500 },
    );
  }
  if (session === null) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Authentication required." },
      { status: 401 },
    );
  }
  try {
    assertPermission(session as unknown as SessionLike, PERMISSIONS.admin_read);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  if (session.activeWorkspaceId === null) {
    return NextResponse.json(
      {
        error: "workspace_required",
        message:
          "An active workspace is required to read the audit log. Select a workspace first.",
      },
      { status: 403 },
    );
  }
  return { session, workspaceId: session.activeWorkspaceId };
}

function configGate(): NextResponse | null {
  const config = getConfig();
  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. The audit log cannot be served.",
      },
      { status: 503 },
    );
  }
  if (!config.auth.sessionSecretConfigured) {
    return NextResponse.json(
      {
        error: "config_error",
        message: "SESSION_SECRET is not configured on this server.",
      },
      { status: 503 },
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Query parsing                                                               */
/* -------------------------------------------------------------------------- */

interface Filters {
  readonly action: string | null;
  readonly actorId: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

function parseFilters(url: URL): Filters | NextResponse {
  let action: string | null = null;
  const actionRaw = url.searchParams.get("action");
  if (actionRaw !== null && actionRaw.length > 0) {
    const trimmed = actionRaw.trim();
    if (trimmed.length > MAX_ACTION_LENGTH) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "action",
          message: `action exceeds the ${MAX_ACTION_LENGTH}-character limit.`,
        },
        { status: 400 },
      );
    }
    action = trimmed;
  }

  let actorId: string | null = null;
  const actorRaw = url.searchParams.get("actorId");
  if (actorRaw !== null && actorRaw.length > 0) {
    const trimmed = actorRaw.trim();
    if (!UUID_PATTERN.test(trimmed)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "actorId",
          message: "actorId must be a UUID.",
        },
        { status: 400 },
      );
    }
    actorId = trimmed;
  }

  let from: string | null = null;
  const fromRaw = url.searchParams.get("from");
  if (fromRaw !== null && fromRaw.length > 0) {
    const ts = Date.parse(fromRaw);
    if (Number.isNaN(ts)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "from",
          message: "from must be an ISO-8601 or parseable timestamp.",
        },
        { status: 400 },
      );
    }
    from = new Date(ts).toISOString();
  }

  let to: string | null = null;
  const toRaw = url.searchParams.get("to");
  if (toRaw !== null && toRaw.length > 0) {
    const ts = Date.parse(toRaw);
    if (Number.isNaN(ts)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "to",
          message: "to must be an ISO-8601 or parseable timestamp.",
        },
        { status: 400 },
      );
    }
    to = new Date(ts).toISOString();
  }

  if (from !== null && to !== null && from > to) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "from",
        message: "from must not be after to.",
      },
      { status: 400 },
    );
  }

  return { action, actorId, from, to };
}

function parseLimit(raw: string | null): number | NextResponse {
  if (raw === null || raw.length === 0) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "limit",
        message: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      },
      { status: 400 },
    );
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Entry DTO                                                                   */
/* -------------------------------------------------------------------------- */

interface AuditEntryDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId: string | null;
  readonly actorDisplay: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly at: string;
  readonly outcome: string;
  readonly detail: string | null;
}

function readString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const v = record[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toEntryDto(
  id: string,
  record: Readonly<Record<string, unknown>>,
  workspaceId: string,
  fallbackTimestamp: string | undefined,
): AuditEntryDto | null {
  const action = readString(record, "action");
  const at =
    readString(record, "at") ??
    readString(record, "createdAt") ??
    (typeof fallbackTimestamp === "string" && fallbackTimestamp.length > 0
      ? new Date(fallbackTimestamp).toISOString()
      : null);
  if (action === null || at === null) return null;

  const outcomeRaw = readString(record, "outcome");
  const outcome =
    outcomeRaw !== null && AUDIT_OUTCOMES.includes(outcomeRaw)
      ? outcomeRaw
      : "unknown";

  return {
    id,
    workspaceId,
    actorId: readString(record, "actorId"),
    actorDisplay: readString(record, "actorDisplay"),
    action,
    targetType: readString(record, "targetType"),
    targetId: readString(record, "targetId"),
    ip: readString(record, "ip"),
    userAgent: readString(record, "userAgent"),
    at,
    outcome,
    detail: readString(record, "detail"),
  };
}

/* -------------------------------------------------------------------------- */
/* GET                                                                         */
/* -------------------------------------------------------------------------- */

export async function GET(req: Request): Promise<NextResponse> {
  const gate = configGate();
  if (gate !== null) return gate;

  const ctxOrError = await authenticate(req);
  if (ctxOrError instanceof NextResponse) return ctxOrError;
  const { workspaceId } = ctxOrError;

  const url = new URL(req.url);

  const limitOrError = parseLimit(url.searchParams.get("limit"));
  if (limitOrError instanceof NextResponse) return limitOrError;
  const limit = limitOrError;

  const filtersOrError = parseFilters(url);
  if (filtersOrError instanceof NextResponse) return filtersOrError;
  const filters = filtersOrError;

  const cursorRaw = url.searchParams.get("cursor");
  let cursor: CursorValue | null = null;
  if (cursorRaw !== null && cursorRaw.length > 0) {
    cursor = decodeCursor(cursorRaw);
    if (cursor === null) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "cursor",
          message:
            "The cursor is not a value this server issued. Restart pagination without a cursor.",
        },
        { status: 400 },
      );
    }
  }

  const storeOrError = await openStore(workspaceId);
  if (storeOrError instanceof NextResponse) return storeOrError;
  const store = storeOrError;

  let entries: readonly StorageEntry[];
  try {
    entries = await listAuditKeys(store);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[/api/admin/audit] list failed: ${message}\n`);
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message: `Audit entries could not be listed from the object store: ${message}`,
      },
      { status: 503 },
    );
  }

  const loaded: AuditEntryDto[] = [];
  for (const entry of entries) {
    const id = entryIdFromKey(entry.key);
    if (id === null) continue;
    let record: Readonly<Record<string, unknown>> | null;
    try {
      record = await readJson(store, entry.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[/api/admin/audit] skipping unreadable entry ${entry.key}: ${message}\n`,
      );
      continue;
    }
    if (record === null) continue;
    const dto = toEntryDto(id, record, workspaceId, entry.lastModified);
    if (dto === null) continue;
    loaded.push(dto);
  }

  // Newest first by `at`, then by `id` as the stable tiebreak.
  loaded.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  const afterCursor =
    cursor === null
      ? loaded
      : loaded.filter((e) =>
          isAfterCursor({ at: e.at, id: e.id }, cursor as CursorValue),
        );

  const filtered = afterCursor.filter((e) => {
    if (filters.action !== null && e.action !== filters.action) return false;
    if (filters.actorId !== null && e.actorId !== filters.actorId) return false;
    if (filters.from !== null && e.at < filters.from) return false;
    if (filters.to !== null && e.at > filters.to) return false;
    return true;
  });

  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ at: last.at, id: last.id })
      : null;

  return NextResponse.json({
    entries: page,
    nextCursor,
    total: filtered.length,
    message:
      "Audit entries are scoped to the caller's active workspace. Filters are applied server-side.",
    notes: [
      "Entries are recorded by the action owner; this endpoint only reads.",
      "IP and user agent are intentionally not redacted; access is gated by the admin.read permission.",
    ],
    cursorFingerprint: createHash("sha256")
      .update(`${filters.action ?? ""}\u0000${filters.actorId ?? ""}\u0000${filters.from ?? ""}\u0000${filters.to ?? ""}`)
      .digest("hex")
      .slice(0, 16),
  });
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Audit entries are written by the action that produced them. This endpoint only reads.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Audit entries are pruned by the retention sweep, not by direct deletion through the API. Adjust the retention policy through /api/admin/retention.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
