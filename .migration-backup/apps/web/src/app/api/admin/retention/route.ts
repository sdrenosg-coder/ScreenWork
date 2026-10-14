/**
 * GET /api/admin/retention  — read the workspace retention policy.
 * PUT /api/admin/retention  — update the workspace retention policy.
 *
 * Purpose:
 *   The workspace compliance record holds the retention windows the
 *   platform's `@zipy/security/retention` sweep reads when it deletes
 *   artifacts, guides and audit logs. This route is the only write surface
 *   for it. Reads are served from the same record so a caller always sees
 *   the authoritative value the sweep will use.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; 503 config_error otherwise.
 *   - Authenticates with the shared session. Reads require
 *     `PERMISSIONS.admin_read`; writes require `PERMISSIONS.admin_update`.
 *   - The workspace scope comes from the session; a caller cannot read or
 *     write another workspace's policy.
 *   - Retention windows are integers 1..3650 days. A missing field on PUT
 *     leaves the existing value unchanged (partial update), but at least one
 *     field must be supplied or the request is a 400.
 *   - `dryRun: true` performs the sweep in "count only" mode and records the
 *     result without deleting. A dry run is a write (it records a sweep
 *     entry), so it uses the same permission as a save.
 *
 * What this route does not do:
 *   - It does not delete anything synchronously. The retention sweep is a
 *     worker job; this route records the policy and, when the caller passes
 *     `dryRun`, asks the worker to run one sweep immediately. The route never
 *     walks the object store itself, so a retention change cannot block an
 *     HTTP response on an unbounded scan.
 *   - It does not validate the encryption master key. Encryption at rest is
 *     configured by ENCRYPTION_MASTER_KEY on the server; this route reports
 *     whether it is available (through the security module) but does not
 *     accept or rotate keys.
 *   - It does not surface GDPR data-subject flows. Those live on the
 *     workspace-scoped member surface (the security package's gdpr module).
 *     A link is documented in the response's notes, not executed here.
 */

import { NextResponse } from "next/server";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
  type SessionLike,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { forWorkspace } from "@zipy/storage/objectStore";
import { enqueueJob, isJobKind, type EnqueueResult, type JobKind } from "@zipy/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const POLICY_KEY = "compliance/retention-policy.json";

const MIN_DAYS = 1;
const MAX_DAYS = 3650;

const RETENTION_SWEEP_JOB_KIND = "compliance:retention-sweep";

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

type StoreLike = {
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
};

async function openStore(
  workspaceId: string,
): Promise<StoreLike | NextResponse> {
  try {
    const store = await forWorkspace(workspaceId);
    return store as unknown as StoreLike;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/admin/retention] object store unavailable: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The workspace object store is not reachable on this server. Check STORAGE_DRIVER and the associated configuration.",
      },
      { status: 503 },
    );
  }
}

async function readPolicy(
  store: StoreLike,
): Promise<Readonly<Record<string, unknown>> | null> {
  let bytes: Buffer | null;
  try {
    bytes = await store.get(POLICY_KEY);
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
      touch: permission === PERMISSIONS.admin_update,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/admin/retention] session load failed: ${
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
          "An active workspace is required to read or update the retention policy.",
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
          "DATABASE_URL is not configured on this server. The retention policy cannot be served.",
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
/* DTO                                                                         */
/* -------------------------------------------------------------------------- */

interface RetentionDto {
  readonly workspaceId: string;
  readonly artifactDays: number;
  readonly guideDays: number;
  readonly logDays: number;
  readonly lastSweepAt: string | null;
  readonly lastSweep: {
    readonly deletedArtifacts: number;
    readonly deletedGuides: number;
    readonly deletedLogs: number;
    readonly dryRun: boolean;
    readonly ranAt: string;
  } | null;
  readonly encryption: {
    readonly atRestConfigured: boolean;
    readonly keyVersion: string | null;
    readonly algorithm: string;
  };
  readonly message: string;
  readonly notes: readonly string[];
}

function readString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const v = record[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readInt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const v = record[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function buildDto(
  workspaceId: string,
  policy: Readonly<Record<string, unknown>> | null,
  message: string,
  notes: readonly string[],
): RetentionDto {
  const config = getConfig();
  const defaultDays = config.compliance.defaultRetentionDays;

  const artifactDays =
    readInt(policy ?? {}, "artifactDays") ?? defaultDays;
  const guideDays = readInt(policy ?? {}, "guideDays") ?? defaultDays;
  const logDays = readInt(policy ?? {}, "logDays") ?? defaultDays;

  let lastSweep: RetentionDto["lastSweep"] = null;
  const lsRaw = policy === null ? null : policy["lastSweep"];
  if (lsRaw !== null && lsRaw !== undefined && typeof lsRaw === "object") {
    const ls = lsRaw as Record<string, unknown>;
    const da = readInt(ls, "deletedArtifacts");
    const dg = readInt(ls, "deletedGuides");
    const dl = readInt(ls, "deletedLogs");
    const ranAt = readString(ls, "ranAt");
    if (da !== null && dg !== null && dl !== null && ranAt !== null) {
      lastSweep = {
        deletedArtifacts: da,
        deletedGuides: dg,
        deletedLogs: dl,
        dryRun: ls["dryRun"] === true,
        ranAt,
      };
    }
  }

  const lastSweepAt = policy === null ? null : readString(policy, "lastSweepAt");

  const encryption = {
    atRestConfigured: config.compliance.encryptionMasterKeyConfigured,
    keyVersion:
      config.compliance.encryptionMasterKeyConfigured ? "v1" : null,
    algorithm: "AES-256-GCM",
  };

  return {
    workspaceId,
    artifactDays,
    guideDays,
    logDays,
    lastSweepAt: lastSweepAt ?? lastSweep?.ranAt ?? null,
    lastSweep,
    encryption,
    message,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* GET                                                                         */
/* -------------------------------------------------------------------------- */

export async function GET(req: Request): Promise<NextResponse> {
  const gate = configGate();
  if (gate !== null) return gate;

  const ctxOrError = await authenticate(req, PERMISSIONS.admin_read);
  if (ctxOrError instanceof NextResponse) return ctxOrError;
  const { workspaceId } = ctxOrError;

  const storeOrError = await openStore(workspaceId);
  if (storeOrError instanceof NextResponse) return storeOrError;
  const store = storeOrError;

  let policy: Readonly<Record<string, unknown>> | null;
  try {
    policy = await readPolicy(store);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/admin/retention] policy read failed: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message: "The retention policy could not be read from the workspace store.",
      },
      { status: 503 },
    );
  }

  const notes: string[] = [];
  if (policy === null) {
    notes.push(
      `No retention policy has been saved for this workspace; the platform default of ${getConfig().compliance.defaultRetentionDays} days is applied.`,
    );
  }
  notes.push(
    "Encryption at rest is enabled when ENCRYPTION_MASTER_KEY is set on the server. This route does not accept or rotate keys.",
  );
  notes.push(
    "Data-subject export and deletion requests are handled on the workspace member surface, not through this route.",
  );

  return NextResponse.json(
    buildDto(
      workspaceId,
      policy,
      policy === null
        ? "Returning platform-default retention; no workspace policy is saved."
        : "Returning the saved workspace retention policy.",
      notes,
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* PUT                                                                         */
/* -------------------------------------------------------------------------- */

interface PutBody {
  readonly artifactDays?: unknown;
  readonly guideDays?: unknown;
  readonly logDays?: unknown;
  readonly dryRun?: unknown;
}

interface ParsedPut {
  readonly artifactDays: number | null;
  readonly guideDays: number | null;
  readonly logDays: number | null;
  readonly dryRun: boolean;
}

function parseDaysField(
  raw: unknown,
  field: string,
): number | null | NextResponse {
  if (raw === undefined) return null;
  if (raw === null) {
    return NextResponse.json(
      {
        error: "validation_error",
        field,
        message: `${field} must be an integer between ${MIN_DAYS} and ${MAX_DAYS}, or omitted to leave unchanged.`,
      },
      { status: 400 },
    );
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field,
        message: `${field} must be a finite integer.`,
      },
      { status: 400 },
    );
  }
  const n = Math.trunc(raw);
  if (n < MIN_DAYS || n > MAX_DAYS) {
    return NextResponse.json(
      {
        error: "validation_error",
        field,
        message: `${field} must be between ${MIN_DAYS} and ${MAX_DAYS} days.`,
      },
      { status: 400 },
    );
  }
  return n;
}

function parsePut(raw: unknown): ParsedPut | NextResponse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      { error: "invalid_json", message: "A JSON object body is required." },
      { status: 400 },
    );
  }
  const body = raw as PutBody;

  const a = parseDaysField(body.artifactDays, "artifactDays");
  if (a instanceof NextResponse) return a;
  const g = parseDaysField(body.guideDays, "guideDays");
  if (g instanceof NextResponse) return g;
  const l = parseDaysField(body.logDays, "logDays");
  if (l instanceof NextResponse) return l;

  const dryRun = body.dryRun === true;

  if (a === null && g === null && l === null && !dryRun) {
    return NextResponse.json(
      {
        error: "validation_error",
        message:
          "At least one of artifactDays, guideDays, logDays or dryRun must be supplied.",
      },
      { status: 400 },
    );
  }
  return { artifactDays: a, guideDays: g, logDays: l, dryRun };
}

export async function PUT(req: Request): Promise<NextResponse> {
  const gate = configGate();
  if (gate !== null) return gate;

  const ctxOrError = await authenticate(req, PERMISSIONS.admin_update);
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

  const parsed = parsePut(bodyJson);
  if (parsed instanceof NextResponse) return parsed;

  const storeOrError = await openStore(workspaceId);
  if (storeOrError instanceof NextResponse) return storeOrError;
  const store = storeOrError;

  let existing: Readonly<Record<string, unknown>> | null;
  try {
    existing = await readPolicy(store);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/admin/retention] policy read-before-write failed: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message: "The retention policy could not be read before writing.",
      },
      { status: 503 },
    );
  }

  const config = getConfig();
  const defaultDays = config.compliance.defaultRetentionDays;

  const artifactDays =
    parsed.artifactDays ?? readInt(existing ?? {}, "artifactDays") ?? defaultDays;
  const guideDays =
    parsed.guideDays ?? readInt(existing ?? {}, "guideDays") ?? defaultDays;
  const logDays =
    parsed.logDays ?? readInt(existing ?? {}, "logDays") ?? defaultDays;

  const nowIso = new Date().toISOString();
  const nextPolicy = {
    kind: "compliance.retention",
    schemaVersion: 1,
    workspaceId,
    artifactDays,
    guideDays,
    logDays,
    lastSweepAt: existing === null ? null : readString(existing, "lastSweepAt"),
    lastSweep: existing === null ? null : existing["lastSweep"] ?? null,
    updatedAt: nowIso,
    updatedBy: session.userId,
  };

  const bytes = Buffer.from(JSON.stringify(nextPolicy, null, 2), "utf8");
  try {
    await store.put(POLICY_KEY, bytes, {
      contentType: "application/json",
      contentLength: bytes.length,
      metadata: {
        "zipy-kind": "compliance.retention",
        "zipy-workspace-id": workspaceId,
        "zipy-updated-by": session.userId,
        "zipy-updated-at": nowIso,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/admin/retention] policy write failed: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The retention policy could not be written. Retry; no partial record was created.",
      },
      { status: 503 },
    );
  }

  const notes: string[] = [
    "The worker applies this policy on its next scheduled sweep.",
    "Encryption at rest is governed by ENCRYPTION_MASTER_KEY on the server, not by this policy.",
  ];

  // -------------------------------------------------- optional dry sweep ---
  let sweepJob: EnqueueResult | null = null;
  let sweepError: string | null = null;
  if (parsed.dryRun) {
    if (!isJobKind(RETENTION_SWEEP_JOB_KIND)) {
      sweepError =
        "The job queue does not expose a `compliance:retention-sweep` job kind. The policy was saved, but no dry sweep was requested.";
    } else {
      const jobKind: JobKind = RETENTION_SWEEP_JOB_KIND;
      try {
        sweepJob = await enqueueJob({
          workspaceId,
          kind: jobKind,
          payload: {
            workspaceId,
            dryRun: true,
            artifactDays,
            guideDays,
            logDays,
            requestedAt: nowIso,
          },
          idempotencyKey: `compliance:retention-sweep:${workspaceId}:dry:${nowIso}`,
          correlationId: workspaceId,
          enqueuedBy: session.userId,
        });
        notes.push(
          "A dry retention sweep was enqueued. The result is recorded on the policy's lastSweep field; nothing is deleted.",
        );
      } catch (error) {
        sweepError =
          error instanceof Error
            ? `The policy was saved, but the dry sweep could not be enqueued: ${error.message}`
            : "The policy was saved, but the dry sweep could not be enqueued.";
      }
    }
  }

  const dto = buildDto(
    workspaceId,
    nextPolicy as Readonly<Record<string, unknown>>,
    parsed.dryRun
      ? sweepError === null
        ? "Retention policy saved and a dry sweep enqueued."
        : "Retention policy saved; the dry sweep could not be requested."
      : "Retention policy saved.",
    notes,
  );

  return NextResponse.json({
    ...dto,
    sweepJob: sweepJob === null
      ? null
      : {
          id: sweepJob.jobId,
          kind: sweepJob.kind,
          status: sweepJob.status,
          created: sweepJob.created,
        },
    sweepError,
  });
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Retention policies are not deleted; adjust the windows to fall back to the platform default.",
    },
    { status: 405, headers: { Allow: "GET, PUT" } },
  );
}
