// apps/web/src/app/api/fusion/[id]/conflicts/route.ts
/**
 * GET /api/fusion/[id]/conflicts
 *
 * Returns the conflict report for a fusion run identified by `id`. "Fusion
 * run" is the fanout artifact produced by the worker (`ingest:combine` job
 * with a terminal `succeeded` status, whose payload.result contains the
 * unified representation and the fusion metadata). This route reads that
 * artifact and returns:
 *
 *   - the conflicts detected across sources,
 *   - the gaps detected in the workflow coverage,
 *   - the reconciliation summary (supported/conflicting/unsupported counts),
 *   - provenance links for the caller's UI so a reviewer can jump from a
 *     conflict to the exact source region that produced each side.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; returns 503 config_error
 *     otherwise.
 *   - Authenticates via the shared session module and asserts
 *     `PERMISSIONS.source_read`. A user without it gets 403.
 *   - The fusion artifact must belong to the caller's active workspace;
 *     a request for another workspace's fusion id returns 404 (rather than
 *     403) so workspace membership is not disclosed.
 *   - The response is read-only and idempotent; solving a conflict is a
 *     separate write endpoint owned by a later phase (editing/collaboration).
 *   - Does **not** run fusion, reconciliation or LLM calls. Those already
 *     happened on the worker. If the artifact has not been produced yet, the
 *     route returns 202 with a `state` field so the UI can poll.
 *
 * The route deliberately reads only the `artifacts` row (metadata + the
 * worker-supplied result JSON) and does not open the object store: the
 * conflict report is written into the artifact's `metadata` by the fusion
 * phase on the worker, and reading it from the row keeps this endpoint O(1).
 */

import { NextResponse } from "next/server";
import { createRequire } from "node:module";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Postgres client (shared shape with sibling routes)                          */
/* -------------------------------------------------------------------------- */

type PgPool = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
  connect: () => Promise<PgClient>;
  end: () => Promise<void>;
};
type PgClient = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
};
type PoolCtor = new (
  opts: {
    connectionString: string;
    ssl?: { rejectUnauthorized: boolean } | false;
    max?: number;
  },
) => PgPool;

const require = createRequire(import.meta.url);

function requirePoolCtor(): PoolCtor {
  try {
    const mod = require("pg") as { Pool: PoolCtor };
    return mod.Pool;
  } catch {
    throw new Error(
      "Zipy AI /api/fusion/[id]/conflicts: the `pg` package is not installed. Run `npm install` at the repository root.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Response shape                                                              */
/* -------------------------------------------------------------------------- */

interface ConflictSideDTO {
  readonly sourceIds: readonly string[];
  readonly regionKeys: readonly string[];
  /** Human-visible excerpt from the conflicting side, when the fusion phase recorded one. */
  readonly excerpt: string | null;
  /** Free-form provenance the fusion phase may supply (page, timestamp, bbox, ...). */
  readonly provenance: Readonly<Record<string, unknown>>;
}

interface ConflictDTO {
  readonly id: string;
  readonly summary: string;
  readonly kind: string;
  readonly candidateResolution: string | null;
  readonly sides: readonly ConflictSideDTO[];
  readonly regionKeys: readonly string[];
  readonly detectedAt: string | null;
}

interface GapDTO {
  readonly id: string;
  readonly summary: string;
  readonly stepKey: string | null;
  readonly severity: string;
  readonly detectedAt: string | null;
}

interface ReconciliationSummaryDTO {
  readonly totalClaims: number;
  readonly supportedClaims: number;
  readonly conflictingClaims: number;
  readonly unsupportedClaims: number;
  readonly parametricOnlyClaims: number;
  readonly meanConfidence: number;
}

interface FusionConflictsResponse {
  readonly fusionId: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly state: "pending" | "succeeded" | "failed" | "unknown";
  readonly jobId: string | null;
  readonly conflicts: readonly ConflictDTO[];
  readonly gaps: readonly GapDTO[];
  readonly reconciliation: ReconciliationSummaryDTO | null;
  readonly parametricUsed: boolean;
  readonly parametricModel: string | null;
  readonly generatedAt: string | null;
  readonly conflictsCount: number;
  readonly gapsCount: number;
  /** Free-form banner message the UI may show, matching the source ingest routes. */
  readonly message: string;
  /** Structural notes: still meaningful even with an empty conflicts list. */
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Artifact/job lookup                                                          */
/* -------------------------------------------------------------------------- */

interface ArtifactRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly metadata: unknown;
  readonly created_at: Date;
}

interface JobRow {
  readonly id: string;
  readonly status: string;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function findArtifact(
  client: PgClient,
  workspaceId: string,
  fusionId: string,
): Promise<ArtifactRow | null> {
  // The fusion id is the artifact id of the source_combine artifact. The
  // worker writes it with the workspace id and a source_combine kind; the
  // route will not return an artifact from another workspace.
  const res = await client.query(
    `SELECT id, workspace_id, kind, metadata, created_at
       FROM artifacts
      WHERE id = $1
        AND workspace_id = $2
        AND kind = 'source_combine'
        AND deleted_at IS NULL
      LIMIT 1`,
    [fusionId, workspaceId],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0] as ArtifactRow;
}

async function findJobForArtifact(
  client: PgClient,
  workspaceId: string,
  artifactId: string,
): Promise<JobRow | null> {
  // The combine route strings the artifact id into the job's `correlation_id`.
  // Reading it here lets the endpoint answer "is this fusion still running?"
  // without a separate queue table scan by the client.
  const res = await client.query(
    `SELECT id, status
       FROM jobs
      WHERE workspace_id = $1
        AND correlation_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [workspaceId, artifactId],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0] as JobRow;
}

/* -------------------------------------------------------------------------- */
/* Metadata extraction                                                          */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseConflicts(metadata: Record<string, unknown> | null): readonly ConflictDTO[] {
  if (metadata === null) return [];
  const raw = metadata["conflicts"];
  if (!Array.isArray(raw)) return [];
  const out: ConflictDTO[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (rec === null) continue;
    const id = asString(rec["id"]);
    const summary = asString(rec["summary"]);
    const kind = asString(rec["kind"]);
    if (id === null || summary === null) continue;
    const sidesRaw = rec["sides"];
    const sides: ConflictSideDTO[] = [];
    if (Array.isArray(sidesRaw)) {
      for (const s of sidesRaw) {
        const sRec = asRecord(s);
        if (sRec === null) continue;
        const provenance = asRecord(sRec["provenance"]) ?? {};
        sides.push({
          sourceIds: asStringArray(sRec["sourceIds"]),
          regionKeys: asStringArray(sRec["regionKeys"]),
          excerpt: asString(sRec["excerpt"]),
          provenance,
        });
      }
    }
    out.push({
      id,
      summary,
      kind: kind ?? "unspecified",
      candidateResolution: asString(rec["candidateResolution"]),
      sides,
      regionKeys: asStringArray(rec["regionKeys"]),
      detectedAt: asString(rec["detectedAt"]),
    });
  }
  return out;
}

function parseGaps(metadata: Record<string, unknown> | null): readonly GapDTO[] {
  if (metadata === null) return [];
  const raw = metadata["gaps"];
  if (!Array.isArray(raw)) return [];
  const out: GapDTO[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (rec === null) continue;
    const id = asString(rec["id"]);
    const summary = asString(rec["summary"]);
    if (id === null || summary === null) continue;
    out.push({
      id,
      summary,
      stepKey: asString(rec["stepKey"]),
      severity: asString(rec["severity"]) ?? "warning",
      detectedAt: asString(rec["detectedAt"]),
    });
  }
  return out;
}

function parseReconciliationSummary(
  metadata: Record<string, unknown> | null,
): ReconciliationSummaryDTO | null {
  if (metadata === null) return null;
  const rec = asRecord(metadata["reconciliation"]);
  if (rec === null) return null;
  const totalClaims = asNumber(rec["totalClaims"]);
  const supportedClaims = asNumber(rec["supportedClaims"]);
  const conflictingClaims = asNumber(rec["conflictingClaims"]);
  const unsupportedClaims = asNumber(rec["unsupportedClaims"]);
  const parametricOnlyClaims = asNumber(rec["parametricOnlyClaims"]);
  const meanConfidence = asNumber(rec["meanConfidence"]);
  if (
    totalClaims === null ||
    supportedClaims === null ||
    conflictingClaims === null ||
    unsupportedClaims === null ||
    parametricOnlyClaims === null ||
    meanConfidence === null
  ) {
    return null;
  }
  return {
    totalClaims,
    supportedClaims,
    conflictingClaims,
    unsupportedClaims,
    parametricOnlyClaims,
    meanConfidence,
  };
}

/* -------------------------------------------------------------------------- */
/* Route                                                                        */
/* -------------------------------------------------------------------------- */

export async function GET(
  req: Request,
  context: { params: { id: string } },
): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Fusion conflict reports cannot be read.",
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

  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: true,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/fusion/[id]/conflicts] session load failed: ${
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
    assertPermission(session, PERMISSIONS.source_read);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  const workspaceId = session.activeWorkspaceId as string;

  const fusionId = context.params.id;
  if (!isUuid(fusionId)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "id",
        message: "The fusion id must be a UUID.",
      },
      { status: 400 },
    );
  }

  let Pool: PoolCtor;
  try {
    Pool = requirePoolCtor();
  } catch (error) {
    process.stderr.write(
      `[/api/fusion/[id]/conflicts] pg unavailable: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return NextResponse.json(
      { error: "config_error", message: "Database driver unavailable." },
      { status: 503 },
    );
  }
  const pool = new Pool({
    connectionString: config.database.url as string,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    max: 2,
  });
  const client = await pool.connect();

  try {
    const artifact = await findArtifact(client, workspaceId, fusionId);
    if (artifact === null) {
      return NextResponse.json(
        {
          error: "not_found",
          message:
            "No source-combine artifact exists for that id in your workspace.",
        },
        { status: 404 },
      );
    }

    const job = await findJobForArtifact(client, workspaceId, artifact.id);
    const metadata = asRecord(artifact.metadata);

    const state = resolveState(job);
    const conflicts = parseConflicts(metadata);
    const gaps = parseGaps(metadata);
    const reconciliation = parseReconciliationSummary(metadata);
    const parametricUsed = metadata?.["parametricUsed"] === true;
    const parametricModel = metadata
      ? asString(metadata["parametricModel"])
      : null;

    const generatedAt =
      (metadata ? asString(metadata["generatedAt"]) : null) ??
      artifact.created_at.toISOString();

    const notes = buildNotes({ state, conflicts, gaps, reconciliation });

    const body: FusionConflictsResponse = {
      fusionId: artifact.id,
      workspaceId: artifact.workspace_id,
      artifactId: artifact.id,
      state,
      jobId: job?.id ?? null,
      conflicts,
      gaps,
      reconciliation,
      parametricUsed,
      parametricModel,
      generatedAt,
      conflictsCount: conflicts.length,
      gapsCount: gaps.length,
      message: buildMessage(state, conflicts.length, gaps.length),
      notes,
    };

    return NextResponse.json(body, {
      status: state === "succeeded" || state === "failed" ? 200 : 202,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/fusion/[id]/conflicts] failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return NextResponse.json(
      {
        error: "server_error",
        message: "Could not load the fusion conflict report. Check server logs.",
      },
      { status: 500 },
    );
  } finally {
    client.release();
    await pool.end();
  }
}

function resolveState(
  job: JobRow | null,
): FusionConflictsResponse["state"] {
  if (job === null) return "unknown";
  switch (job.status) {
    case "succeeded":
    case "failed":
    case "pending":
    case "active":
      return job.status === "active" ? "pending" : (job.status as FusionConflictsResponse["state"]);
    default:
      return "unknown";
  }
}

function buildMessage(
  state: FusionConflictsResponse["state"],
  conflictsCount: number,
  gapsCount: number,
): string {
  switch (state) {
    case "pending":
      return "The fusion pass is still running. The conflict report is not yet final.";
    case "failed":
      return "The fusion pass failed. No conflict report is available; inspect the job log for the failure reason.";
    case "unknown":
      return "No fusion job was found for this artifact. The report below reflects only what the artifact metadata contains.";
    case "succeeded":
      return `Fusion succeeded with ${conflictsCount} cross-source conflict${
        conflictsCount === 1 ? "" : "s"
      } and ${gapsCount} coverage gap${gapsCount === 1 ? "" : "s"}.`;
  }
}

function buildNotes(input: {
  readonly state: FusionConflictsResponse["state"];
  readonly conflicts: readonly ConflictDTO[];
  readonly gaps: readonly GapDTO[];
  readonly reconciliation: ReconciliationSummaryDTO | null;
}): readonly string[] {
  const notes: string[] = [];
  if (input.conflicts.length === 0 && input.state === "succeeded") {
    notes.push(
      "No cross-source conflicts were detected. This does not prove agreement — it means no two sources made incompatible statements about the same step.",
    );
  }
  if (input.reconciliation === null) {
    notes.push(
      "No reconciliation summary was recorded on the fusion artifact. Later phases may not have run yet.",
    );
  } else if (input.reconciliation.unsupportedClaims > 0) {
    notes.push(
      `${input.reconciliation.unsupportedClaims} claim${
        input.reconciliation.unsupportedClaims === 1 ? "" : "s"
      } failed the support threshold. These are candidates for human review.`,
    );
  }
  if (input.gaps.length > 0) {
    notes.push(
      "Coverage gaps indicate workflow steps not evidenced by any source. They are candidates for review or AI generation of the missing step.",
    );
  }
  return notes;
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                                */
/* -------------------------------------------------------------------------- */

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "This endpoint is read-only. Resolving a conflict is handled by the editing/collaboration surface.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
