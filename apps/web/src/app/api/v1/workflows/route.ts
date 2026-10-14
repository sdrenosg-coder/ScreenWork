/**
 * GET  /api/v1/workflows  — list workflows in the active workspace.
 * POST /api/v1/workflows  — create a workflow.
 *
 * The v1 route is a stable façade over the same `workflows/{id}.json` records
 * the synthesis worker writes and `/api/workflows/{id}/synthesize` reads. A
 * workflow created here is immediately eligible for synthesis through the
 * existing route; there is no second persistence path.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; the shared config gate returns
 *     503 with the missing variable named when either is absent.
 *   - Authenticates with the shared session and asserts
 *     `PERMISSIONS.workflow_read` (list) / `PERMISSIONS.workflow_create`
 *     (create).
 *   - Both operations are workspace-scoped. The active workspace comes from
 *     the session; the request cannot select another workspace.
 *
 * Pagination matches `/api/v1/guides`: descending `createdAt` with `id` as
 * the stable tiebreak, and an opaque base64url cursor. A cursor the server did
 * not issue is a 400, not a silent restart.
 *
 * Create semantics:
 *   - `goal` is required. It is the natural-language objective the synthesis
 *     layer maps to UI actions, so an empty goal cannot produce a plan.
 *   - `startUrl`, when supplied, must be an absolute http(s) URL. It is stored
 *     on the record and is the page the automation worker will load.
 *   - `sourceIds`, when supplied, must be a bounded array of UUIDs. Existence
 *     is not verified synchronously: an ingest may still be in flight, and the
 *     synthesis job reports an unresolvable source rather than blocking the
 *     workflow creation on a race with the worker.
 *
 * What this route does not do:
 *   - It does not invoke the LLM or run Playwright. Creation is metadata only.
 *   - It does not enqueue synthesis; that is `POST /api/v1/workflows/{id}/synthesize`.
 *   - It does not run on a schedule or set a recurring regeneration policy.
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

import { REF, openApiDocument } from "../openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORKFLOWS_PREFIX = "workflows";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const MAX_GOAL_LENGTH = 2000;
const MAX_URL_LENGTH = 2048;
const MAX_SOURCE_IDS = 128;

const WORKFLOW_STATUSES: readonly string[] = [
  "draft",
  "synthesizing",
  "synthesized",
  "running",
  "failed",
  "archived",
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
  readonly list?: (
    prefix: string,
    opts?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<{ readonly entries: readonly StorageEntry[]; readonly nextCursor: string | null }>;
  readonly listKeys?: (prefix: string) => Promise<readonly (string | StorageEntry)[]>;
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

async function listWorkflowKeys(
  store: StoreLike,
  limit: number,
): Promise<readonly StorageEntry[]> {
  const prefix = `${WORKFLOWS_PREFIX}/`;

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
    "The configured object-store driver exposes neither `list` nor `listKeys`, so workflow listing is not available. Use a driver that implements object listing, or switch to the S3 driver.",
  );
}

function workflowIdFromKey(key: string): string | null {
  const match = /^workflows\/([0-9a-f-]{36})\.json$/i.exec(key);
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
      `[/api/v1/workflows] session load failed: ${
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
          "An active workspace is required. Select a workspace before calling the workflows API.",
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
          "DATABASE_URL is not configured on this server. The workflows API cannot be served.",
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
    process.stderr.write(`[/api/v1/workflows] object store unavailable: ${message}\n`);
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

  const ctxOrError = await authenticate(req, PERMISSIONS.workflow_read);
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
  if (statusFilter !== null && !WORKFLOW_STATUSES.includes(statusFilter)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "status",
        message: `status must be one of: ${WORKFLOW_STATUSES.join(", ")}.`,
      },
      { status: 400 },
    );
  }

  const guideFilter = url.searchParams.get("guideId");
  if (guideFilter !== null && !UUID_PATTERN.test(guideFilter)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "guideId",
        message: "guideId must be a UUID.",
      },
      { status: 400 },
    );
  }

  const storeOrError = await openStore(workspaceId);
  if (storeOrError instanceof NextResponse) return storeOrError;
  const store = storeOrError;

  let entries: readonly StorageEntry[];
  try {
    entries = await listWorkflowKeys(store, limit + 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[/api/v1/workflows] list failed: ${message}\n`);
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message: `Workflows could not be listed from the object store: ${message}`,
      },
      { status: 503 },
    );
  }

  interface LoadedWorkflow {
    readonly id: string;
    readonly createdAt: string;
    readonly record: Readonly<Record<string, unknown>>;
  }

  const loaded: LoadedWorkflow[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = workflowIdFromKey(entry.key);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    let record: Readonly<Record<string, unknown>>;
    try {
      const raw = await readJsonOrNull(store, entry.key);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      record = raw as Readonly<Record<string, unknown>>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[/api/v1/workflows] skipping unreadable record ${entry.key}: ${message}\n`,
      );
      continue;
    }
    loaded.push({ id, createdAt: readTimestamp(record, entry.lastModified), record });
  }

  loaded.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  const afterCursor =
    cursor === null
      ? loaded
      : loaded.filter((w) =>
          isAfterCursor({ createdAt: w.createdAt, id: w.id }, cursor as CursorValue),
        );

  const filtered = afterCursor.filter((w) => {
    if (statusFilter !== null) {
      const status = readString(w.record, "status");
      if (status !== statusFilter) return false;
    }
    if (guideFilter !== null) {
      const guideId = readString(w.record, "guideId");
      if (guideId !== guideFilter) return false;
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
    workflows: page.map((w) => toWorkflowDto(w.id, w.record, workspaceId, w.createdAt)),
    pagination: {
      limit,
      hasMore,
      nextCursor,
      total: null,
    },
    openapi: REF.workflowList,
    schemaVersion: openApiDocument.info.version,
  });
}

/* -------------------------------------------------------------------------- */
/* POST                                                                        */
/* -------------------------------------------------------------------------- */

interface CreateWorkflowBody {
  readonly goal?: unknown;
  readonly startUrl?: unknown;
  readonly guideId?: unknown;
  readonly sourceIds?: unknown;
}

interface ValidatedCreate {
  readonly goal: string;
  readonly startUrl: string | null;
  readonly guideId: string | null;
  readonly sourceIds: readonly string[];
}

function validateCreate(raw: unknown): ValidatedCreate | NextResponse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      { error: "validation_error", message: "A JSON object body is required." },
      { status: 400 },
    );
  }
  const body = raw as CreateWorkflowBody;

  const goalRaw = typeof body.goal === "string" ? body.goal.trim() : "";
  if (goalRaw.length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "goal",
        message:
          "goal is required: it is the objective the synthesis layer maps to UI actions, and an empty goal cannot produce a plan.",
      },
      { status: 400 },
    );
  }
  if (goalRaw.length > MAX_GOAL_LENGTH) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "goal",
        message: `goal exceeds the ${MAX_GOAL_LENGTH}-character limit.`,
      },
      { status: 400 },
    );
  }

  let startUrl: string | null = null;
  if (typeof body.startUrl === "string" && body.startUrl.trim().length > 0) {
    const candidate = body.startUrl.trim();
    if (candidate.length > MAX_URL_LENGTH) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "startUrl",
          message: `startUrl exceeds the ${MAX_URL_LENGTH}-character limit.`,
        },
        { status: 400 },
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "startUrl",
          message: "startUrl must be an absolute http(s) URL.",
        },
        { status: 400 },
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "startUrl",
          message: "Only http and https URLs are accepted as a workflow start page.",
        },
        { status: 400 },
      );
    }
    startUrl = parsed.toString();
  }

  let guideId: string | null = null;
  if (typeof body.guideId === "string" && body.guideId.trim().length > 0) {
    const candidate = body.guideId.trim();
    if (!UUID_PATTERN.test(candidate)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "guideId",
          message: "guideId must be a UUID.",
        },
        { status: 400 },
      );
    }
    guideId = candidate;
  }

  let sourceIds: readonly string[] = [];
  if (body.sourceIds !== undefined && body.sourceIds !== null) {
    if (!Array.isArray(body.sourceIds)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "sourceIds",
          message: "sourceIds must be an array of UUID strings.",
        },
        { status: 400 },
      );
    }
    if (body.sourceIds.length > MAX_SOURCE_IDS) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "sourceIds",
          message: `At most ${MAX_SOURCE_IDS} source ids per workflow.`,
        },
        { status: 400 },
      );
    }
    const out: string[] = [];
    for (let i = 0; i < body.sourceIds.length; i += 1) {
      const entry = body.sourceIds[i];
      if (typeof entry !== "string" || !UUID_PATTERN.test(entry.trim())) {
        return NextResponse.json(
          {
            error: "validation_error",
            field: `sourceIds[${i}]`,
            message: "Each source id must be a UUID string.",
          },
          { status: 400 },
        );
      }
      out.push(entry.trim());
    }
    sourceIds = out;
  }

  return { goal: goalRaw, startUrl, guideId, sourceIds };
}

export async function POST(req: Request): Promise<NextResponse> {
  const gate = configGate();
  if (gate !== null) return gate;

  const ctxOrError = await authenticate(req, PERMISSIONS.workflow_create);
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

  const workflowId = randomUUID();
  const nowIso = new Date().toISOString();
  const record = {
    kind: "workflow",
    schemaVersion: 1,
    id: workflowId,
    workspaceId,
    guideId: validated.guideId,
    status: "draft",
    goal: validated.goal,
    startUrl: validated.startUrl,
    sourceIds: validated.sourceIds,
    planRevision: null,
    stepCount: null,
    lowConfidenceStepCount: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: session.userId,
  };

  const bytes = Buffer.from(JSON.stringify(record, null, 2), "utf8");
  try {
    await store.put(workflowRecordKey(workflowId), bytes, {
      contentType: "application/json",
      contentLength: bytes.length,
      metadata: {
        "zipy-kind": "workflow",
        "zipy-workflow-id": workflowId,
        "zipy-workspace-id": workspaceId,
        "zipy-created-by": session.userId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[/api/v1/workflows] create failed: ${message}\n`);
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The workflow record could not be written to the object store. Retry; no partial record was created.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      workflow: toWorkflowDto(
        workflowId,
        record as Readonly<Record<string, unknown>>,
        workspaceId,
        nowIso,
      ),
      message:
        "Workflow created. Run POST /api/v1/workflows/{id}/synthesize to synthesize its action plan; synthesis requires a configured LLM provider.",
    },
    { status: 201, headers: { Location: `/api/v1/workflows/${workflowId}` } },
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
  if (typeof fallback === "string" && fallback.length > 0) {
    const asDate = new Date(fallback);
    if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  }
  return new Date(0).toISOString();
}

function toWorkflowDto(
  workflowId: string,
  record: Readonly<Record<string, unknown>>,
  workspaceId: string,
  createdAt: string,
): Readonly<Record<string, unknown>> {
  const status = readString(record, "status") ?? "draft";
  const planRevisionRaw = record["planRevision"];
  const planRevision =
    typeof planRevisionRaw === "number" && Number.isFinite(planRevisionRaw)
      ? Math.trunc(planRevisionRaw)
      : null;
  return {
    id: workflowId,
    workspaceId,
    guideId: readString(record, "guideId"),
    status,
    goal: readString(record, "goal"),
    startUrl: readString(record, "startUrl"),
    planRevision,
    stepCount: readNumber(record, "stepCount"),
    lowConfidenceStepCount: readNumber(record, "lowConfidenceStepCount"),
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
      message:
        "Workflows are updated through their own resource routes. This collection accepts GET and POST.",
    },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}

export async function PATCH(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Workflows are updated through their own resource routes. This collection accepts GET and POST.",
    },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Collection-wide deletion is not exposed. Archive a workflow through its resource route, or use the admin retention surface.",
    },
    { status: 405, headers: { Allow: "GET, POST" } },
  );
}
