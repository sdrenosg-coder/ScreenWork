/**
 * GET  /api/v1/guides   — list guides in the active workspace.
 * POST /api/v1/guides   — create a guide bound to a workflow.
 *
 * The v1 surface is a stable, versioned façade over the same workspace-scoped
 * store the unversioned routes use. It does not introduce a second persistence
 * path: the guide record lives under the exact same `guides/{id}.json` key
 * that `/api/guides/[id]/generate` and `/api/guides/[id]/export` read, so a
 * guide created here is immediately usable by the rest of the app.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; the shared config gate returns
 *     503 with the missing variable named when either is absent.
 *   - Authenticates with the shared session and asserts
 *     `PERMISSIONS.guide_read` (list) / `PERMISSIONS.guide_create` (create).
 *   - Both operations are workspace-scoped. The active workspace comes from
 *     the session; a request cannot select another workspace by supplying an
 *     id in the body.
 *
 * Pagination:
 *   - The list operation pages by descending `createdAt`, then by `id` as a
 *     stable tiebreak. The cursor is an opaque base64url of
 *     `{createdAt, id}`. A malformed cursor is a 400; the route never falls
 *     back to returning the first page for a cursor it cannot read, because
 *     that would silently duplicate rows for a caller that is paging.
 *
 * Create semantics:
 *   - A guide is bound to a workflow. The workflow must exist in the same
 *     workspace and must be in a state where a guide can be attached
 *     (`draft`, `synthesized`, or `running`). Attaching to a `failed` or
 *     `archived` workflow is a 409 with an explicit reason.
 *   - The title is required and length-bounded. A templateId, when supplied,
 *     must resolve in the template library; an unknown id is a 400 rather
 *     than a silently-ignored field.
 *
 * What this route does not do:
 *   - It does not synthesize the workflow or generate guide content. Those
 *     are separate operations so they can run and fail independently.
 *   - It does not assign a slug or publish the guide.
 *   - It does not charge the workspace or check plan limits; billing metering
 *     is a later phase and is not faked here.
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
import { tryGetTemplate } from "@zipy/templates/library";

import { REF, openApiDocument } from "../openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GUIDES_PREFIX = "guides";
const WORKFLOWS_PREFIX = "workflows";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const MAX_TITLE_LENGTH = 300;
const MAX_TEMPLATE_ID_LENGTH = 120;

/**
 * Guide statuses that can be attached to a workflow. A guide cannot be
 * attached to a workflow that failed or was archived because the resulting
 * guide would have no plan to generate from.
 */
const ATTACHABLE_WORKFLOW_STATUSES: readonly string[] = [
  "draft",
  "synthesizing",
  "synthesized",
  "running",
  "succeeded",
];

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
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
  // Object stores in this codebase expose a listing primitive; the exact name
  // and shape is owned by `@zipy/storage/objectStore`. We read it defensively
  // so a driver that names it `list` vs `listKeys` does not crash this route.
  readonly list?: (
    prefix: string,
    opts?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<{ readonly entries: readonly StorageEntry[]; readonly nextCursor: string | null }>;
  readonly listKeys?: (
    prefix: string,
  ) => Promise<readonly (string | StorageEntry)[]>;
}

function guideRecordKey(guideId: string): string {
  return `${GUIDES_PREFIX}/${guideId}.json`;
}

function workflowRecordKey(workflowId: string): string {
  return `${WORKFLOWS_PREFIX}/${workflowId}.json`;
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
  return JSON.parse(bytes.toString("utf8"));
}

/**
 * Enumerate guide records under the workspace prefix. The route prefers a
 * driver-native `list` that returns `{key, contentLength, lastModified}`; when
 * the driver only exposes `listKeys`, we fetch each record to recover the
 * timestamps the list response needs. That fallback is intentionally bounded
 * by the page limit plus a small over-fetch, so it cannot walk the entire
 * prefix for a large workspace.
 */
async function listGuideKeys(
  store: StoreLike,
  limit: number,
): Promise<readonly StorageEntry[]> {
  const prefix = `${GUIDES_PREFIX}/`;

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
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  throw new Error(
    "The configured object-store driver exposes neither `list` nor `listKeys`, so guide listing is not available. Use a driver that implements object listing, or switch to the S3 driver.",
  );
}

/**
 * A `guides/{id}.json` key is a guide record. Nested keys such as
 * `guides/{id}/draft-current.json` and `guides/{id}/drafts/{run}.json` are not.
 */
function guideIdFromKey(key: string): string | null {
  const match = /^guides\/([0-9a-f-]{36})\.json$/i.exec(key);
  if (match === null) return null;
  const id = match[1];
  return typeof id === "string" && UUID_PATTERN.test(id) ? id : null;
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

interface CursorValue {
  readonly createdAt: string;
  readonly id: string;
}

function encodeCursor(value: CursorValue): string {
  const json = JSON.stringify(value);
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeCursor(raw: string): CursorValue | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as CursorValue).createdAt === "string" &&
      typeof (parsed as CursorValue).id === "string" &&
      UUID_PATTERN.test((parsed as CursorValue).id)
    ) {
      return { createdAt: (parsed as CursorValue).createdAt, id: (parsed as CursorValue).id };
    }
    return null;
  } catch {
    return null;
  }
}

/** Descending by createdAt, then descending by id. */
function isAfterCursor(
  entry: { readonly createdAt: string; readonly id: string },
  cursor: CursorValue,
): boolean {
  if (entry.createdAt < cursor.createdAt) return true;
  if (entry.createdAt > cursor.createdAt) return false;
  return entry.id < cursor.id;
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

interface AuthedContext {
  readonly session: SessionRecord;
  readonly workspaceId: string;
}

async function authenticate(
  req: Request,
  permission: string,
): Promise<AuthedContext | NextResponse> {
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: false,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/v1/guides] session load failed: ${
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
    assertPermission(session as unknown as SessionLike, permission);
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
          "An active workspace is required. Select a workspace before calling the guides API.",
      },
      { status: 403 },
    );
  }

  return { session, workspaceId: session.activeWorkspaceId };
}

/* -------------------------------------------------------------------------- */
/* Shared guards                                                               */
/* -------------------------------------------------------------------------- */

function configGate(): NextResponse | null {
  const config = getConfig();
  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. The guides API cannot be served.",
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
    process.stderr.write(`[/api/v1/guides] object store unavailable: ${message}\n`);
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
/* GET                                                                         */
/* -------------------------------------------------------------------------- */

export async function GET(req: Request): Promise<NextResponse> {
  const gate = configGate();
  if (gate !== null) return gate;

  const ctxOrError = await authenticate(req, PERMISSIONS.guide_read);
  if (ctxOrError instanceof NextResponse) return ctxOrError;
  const { workspaceId } = ctxOrError;

  const url = new URL(req.url);

  const limitOrError = parseLimit(url.searchParams.get("limit"));
  if (limitOrError instanceof NextResponse) return limitOrError;
  const limit = limitOrError;

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

  const statusFilter = url.searchParams.get("status");
  if (
    statusFilter !== null &&
    !["draft", "review", "published", "archived"].includes(statusFilter)
  ) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "status",
        message: "status must be one of: draft, review, published, archived.",
      },
      { status: 400 },
    );
  }

  const workflowFilter = url.searchParams.get("workflowId");
  if (workflowFilter !== null && !UUID_PATTERN.test(workflowFilter)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "workflowId",
        message: "workflowId must be a UUID.",
      },
      { status: 400 },
    );
  }

  const storeOrError = await openStore(workspaceId);
  if (storeOrError instanceof NextResponse) return storeOrError;
  const store = storeOrError;

  // We fetch one extra record past the page boundary so we can tell whether a
  // next page exists without a separate count query.
  let entries: readonly StorageEntry[];
  try {
    entries = await listGuideKeys(store, limit + 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[/api/v1/guides] list failed: ${message}\n`);
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message: `Guides could not be listed from the object store: ${message}`,
      },
      { status: 503 },
    );
  }

  // Recover each record so we can sort, filter and render the response shape.
  interface LoadedGuide {
    readonly id: string;
    readonly createdAt: string;
    readonly record: Readonly<Record<string, unknown>>;
  }

  const loaded: LoadedGuide[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = guideIdFromKey(entry.key);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    let record: Readonly<Record<string, unknown>>;
    try {
      const raw = await readJsonOrNull(store, entry.key);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      record = raw as Readonly<Record<string, unknown>>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[/api/v1/guides] skipping unreadable record ${entry.key}: ${message}\n`);
      continue;
    }
    const createdAt = readTimestamp(record, entry.lastModified);
    loaded.push({ id, createdAt, record });
  }

  loaded.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  const afterCursor =
    cursor === null
      ? loaded
      : loaded.filter((g) => isAfterCursor({ createdAt: g.createdAt, id: g.id }, cursor as CursorValue));

  const filtered = afterCursor.filter((g) => {
    if (statusFilter !== null) {
      const status = readString(g.record, "status");
      if (status !== statusFilter) return false;
    }
    if (workflowFilter !== null) {
      const workflowId = readString(g.record, "workflowId");
      if (workflowId !== workflowFilter) return false;
    }
    return true;
  });

  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null;

  return NextResponse.json({
    guides: page.map((g) => toGuideDto(g.id, g.record, workspaceId, g.createdAt)),
    pagination: {
      limit,
      hasMore,
      nextCursor,
      total: null,
    },
    openapi: REF.guideList,
    schemaVersion: openApiDocument.info.version,
  });
}

/* -------------------------------------------------------------------------- */
/* POST                                                                        */
/* -------------------------------------------------------------------------- */

interface CreateGuideBody {
  readonly workflowId?: unknown;
  readonly title?: unknown;
  readonly templateId?: unknown;
}

interface ValidatedCreate {
  readonly workflowId: string;
  readonly title: string;
  readonly templateId: string | null;
}

function validateCreate(raw: unknown): ValidatedCreate | NextResponse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      { error: "validation_error", message: "A JSON object body is required." },
      { status: 400 },
    );
  }
  const body = raw as CreateGuideBody;

  const workflowIdRaw = typeof body.workflowId === "string" ? body.workflowId.trim() : "";
  if (workflowIdRaw.length === 0) {
    return NextResponse.json(
      { error: "validation_error", field: "workflowId", message: "workflowId is required." },
      { status: 400 },
    );
  }
  if (!UUID_PATTERN.test(workflowIdRaw)) {
    return NextResponse.json(
      { error: "validation_error", field: "workflowId", message: "workflowId must be a UUID." },
      { status: 400 },
    );
  }

  const titleRaw = typeof body.title === "string" ? body.title.trim() : "";
  if (titleRaw.length === 0) {
    return NextResponse.json(
      { error: "validation_error", field: "title", message: "title is required." },
      { status: 400 },
    );
  }
  if (titleRaw.length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "title",
        message: `title exceeds the ${MAX_TITLE_LENGTH}-character limit.`,
      },
      { status: 400 },
    );
  }

  let templateId: string | null = null;
  if (typeof body.templateId === "string" && body.templateId.trim().length > 0) {
    const candidate = body.templateId.trim();
    if (candidate.length > MAX_TEMPLATE_ID_LENGTH) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "templateId",
          message: `templateId exceeds the ${MAX_TEMPLATE_ID_LENGTH}-character limit.`,
        },
        { status: 400 },
      );
    }
    let resolved: unknown;
    try {
      resolved = tryGetTemplate(candidate);
    } catch {
      // If the template library is unavailable we refuse rather than record a
      // templateId we could not verify, which would later look like a valid
      // but missing template.
      return NextResponse.json(
        {
          error: "config_error",
          message:
            "The template library is not available on this server, so templateId cannot be validated. Omit templateId or redeploy with the templates package built.",
        },
        { status: 503 },
      );
    }
    if (resolved === null || resolved === undefined) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "templateId",
          message: `No template with id "${candidate}" is registered in the template library.`,
        },
        { status: 400 },
      );
    }
    templateId = candidate;
  }

  return { workflowId: workflowIdRaw, title: titleRaw, templateId };
}

export async function POST(req: Request): Promise<NextResponse> {
  const gate = configGate();
  if (gate !== null) return gate;

  const ctxOrError = await authenticate(req, PERMISSIONS.guide_create);
  if (ctxOrError instanceof NextResponse) return ctxOrError;
  const { session, workspaceId } = ctxOrError;

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const validated = validateCreate(bodyJson);
  if (validated instanceof NextResponse) return validated;

  const storeOrError = await openStore(workspaceId);
  if (storeOrError instanceof NextResponse) return storeOrError;
  const store = storeOrError;

  // ---------------------------------------------------- verify the workflow -
  let workflowRaw: unknown;
  try {
    workflowRaw = await readJsonOrNull(store, workflowRecordKey(validated.workflowId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[/api/v1/guides] workflow read failed: ${message}\n`);
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message: "The workflow record could not be read from the object store.",
      },
      { status: 503 },
    );
  }
  if (workflowRaw === null || typeof workflowRaw !== "object" || Array.isArray(workflowRaw)) {
    return NextResponse.json(
      {
        error: "not_found",
        field: "workflowId",
        message:
          "No workflow exists under this id in your active workspace. Create and synthesize the workflow before creating a guide.",
      },
      { status: 404 },
    );
  }
  const workflowRecord = workflowRaw as Readonly<Record<string, unknown>>;
  const workflowStatus = readString(workflowRecord, "status") ?? "draft";
  if (!ATTACHABLE_WORKFLOW_STATUSES.includes(workflowStatus)) {
    return NextResponse.json(
      {
        error: "conflict",
        field: "workflowId",
        message: `The workflow is in status "${workflowStatus}" and cannot have a guide attached. Re-synthesize or restore the workflow, then retry.`,
      },
      { status: 409 },
    );
  }

  // ------------------------------------------------------------ create -----
  const guideId = randomUUID();
  const nowIso = new Date().toISOString();
  const record = {
    kind: "guide",
    schemaVersion: 1,
    id: guideId,
    workspaceId,
    workflowId: validated.workflowId,
    title: validated.title,
    status: "draft",
    templateId: validated.templateId,
    slug: null,
    aiGenerated: false,
    sources: Array.isArray(workflowRecord["sources"]) ? workflowRecord["sources"] : [],
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: session.userId,
  };

  const bytes = Buffer.from(JSON.stringify(record, null, 2), "utf8");
  try {
    await store.put(guideRecordKey(guideId), bytes, {
      contentType: "application/json",
      contentLength: bytes.length,
      metadata: {
        "zipy-kind": "guide",
        "zipy-guide-id": guideId,
        "zipy-workspace-id": workspaceId,
        "zipy-workflow-id": validated.workflowId,
        "zipy-created-by": session.userId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[/api/v1/guides] create failed: ${message}\n`);
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The guide record could not be written to the object store. Retry; no partial record was created.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      guide: toGuideDto(guideId, record as Readonly<Record<string, unknown>>, workspaceId, nowIso),
      message:
        "Guide created. Run POST /api/v1/guides/{id}/generate to compose its content draft from the workflow's synthesized plan.",
    },
    { status: 201, headers: { Location: `/api/v1/guides/${guideId}` } },
  );
}

/* -------------------------------------------------------------------------- */
/* DTO mapping                                                                 */
/* -------------------------------------------------------------------------- */

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTimestamp(
  record: Readonly<Record<string, unknown>>,
  fallback: string | undefined,
): string {
  const direct = readString(record, "createdAt");
  if (direct !== null) return direct;
  const alt = readString(record, "created_at");
  if (alt !== null) return alt;
  if (typeof fallback === "string" && fallback.length > 0) {
    const asDate = new Date(fallback);
    if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  }
  // A record without a timestamp is not silently dated `now`, which would
  // distort ordering on every read. It is sorted to the epoch so it appears
  // last and its absence is visible.
  return new Date(0).toISOString();
}

function toGuideDto(
  guideId: string,
  record: Readonly<Record<string, unknown>>,
  workspaceId: string,
  createdAt: string,
): Readonly<Record<string, unknown>> {
  const workflowId = readString(record, "workflowId");
  const status = readString(record, "status") ?? "draft";
  const sourceCount = Array.isArray(record["sources"]) ? (record["sources"] as unknown[]).length : 0;
  return {
    id: guideId,
    workspaceId,
    workflowId: workflowId ?? "",
    title: readString(record, "title") ?? "Untitled guide",
    status,
    slug: readString(record, "slug"),
    aiGenerated: record["aiGenerated"] === true,
    sourceCount,
    stepCount: readNumber(record, "stepCount") ?? 0,
    createdAt,
    updatedAt: readString(record, "updatedAt") ?? createdAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

export async function PUT(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message: "Guides are updated through their own resource routes. This collection accepts GET and POST.",
    },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}

export async function PATCH(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message: "Guides are updated through their own resource routes. This collection accepts GET and POST.",
    },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Collection-wide deletion is not exposed. Delete a guide through its resource route, or use the admin retention surface.",
    },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}
