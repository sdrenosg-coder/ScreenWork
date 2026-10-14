// apps/web/src/app/api/fusion/[id]/conflicts/route.ts
/**
 * GET /api/fusion/[id]/conflicts
 *
 * Reviewer-facing read surface for a single fusion run. Returns:
 *   - the fusion artifact's state (pending / succeeded / failed),
 *   - every cross-source conflict detected by `conflictDetect`,
 *   - every coverage gap detected by `gapDetect`,
 *   - the reconciliation summary produced by `reconcile`,
 *   - provenance refs (source ids, region keys, excerpts) so the UI can link a
 *     generated claim back to the artifact, page and region that produced it.
 *
 * This route is read-only. It does **not** run fusion, resolve conflicts, or
 * write anything: fusion runs on the worker as part of the combine job, and
 * the resolution/editing surface belongs to a later phase. The route's job is
 * to expose what the worker already persisted so `ProvenancePanel` can render
 * it without owning domain logic.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; returns 503 config_error
 *     otherwise (no synthesized response without a database to read).
 *   - Authenticates via the shared session module and asserts
 *     `PERMISSIONS.workspace_read`. A caller from another workspace gets 404
 *     (not 403) so workspace scoping does not leak the existence of fusion
 *     ids outside the caller's workspace.
 *   - The `[id]` path segment is the fusion artifact id. It is validated as a
 *     UUID before touching storage, so a malformed id is a 400.
 *   - Reads the fusion artifact from the artifact store using the `fusion/`
 *     namespace this phase writes under. A missing artifact is a 404. A
 *     `pending` artifact is returned with `state: "pending"` and empty
 *     conflict/gap lists so the UI's polling loop has something to render.
 *   - Every conflict and gap is passed through the same shape the
 *     `ProvenancePanel` parses. The route does not re-derive conflicts from
 *     raw sources; it surfaces the worker's persisted result verbatim, so a
 *     disagreement between this route and the panel points at one place to
 *     fix — the persisted artifact shape.
 *
 * The object store is the transport for the fusion artifact because the worker
 * writes large JSON blobs (conflict excerpts can be thousands of characters);
 * the storage layer is already workspace-scoped via `forWorkspace()`, so no
 * additional path prefixing is required for multi-tenancy.
 *
 * Endpoints that this route explicitly does not provide:
 *   - conflict resolution (belongs to the editor / review phases),
 *   - re-fusion of a changed source (belongs to the automation phase),
 *   - batch regeneration of affected steps (belongs to the content-automation
 *     phase),
 *   - cross-workspace sharing of a fusion id.
 */

import { NextResponse } from "next/server";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { forWorkspace } from "@zipy/storage/objectStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Storage namespace for fusion artifacts. The combine fanout writes
 * `fusion/{artifactId}.json` into the workspace-scoped store returned by
 * `forWorkspace(workspaceId)`; this route reads from the same key. The
 * workspace prefix is applied by `forWorkspace`, not by this string, so the
 * key here is workspace-relative.
 */
const FUSION_PREFIX = "fusion";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Upper bound on conflicts/gaps returned in one response. */
const MAX_ITEMS = 500;

/** Max excerpt length in a conflict side — matches the `ProvenancePanel`. */
const MAX_EXCERPT_LENGTH = 4000;

/* -------------------------------------------------------------------------- */
/* Persisted fusion artifact shape (as written by the fanout + fusion phase)   */
/* -------------------------------------------------------------------------- */

interface PersistedConflictSide {
  readonly sourceIds?: unknown;
  readonly regionKeys?: unknown;
  readonly excerpt?: unknown;
  readonly provenance?: unknown;
}

interface PersistedConflict {
  readonly id?: unknown;
  readonly summary?: unknown;
  readonly kind?: unknown;
  readonly candidateResolution?: unknown;
  readonly sides?: unknown;
  readonly regionKeys?: unknown;
  readonly detectedAt?: unknown;
}

interface PersistedGap {
  readonly id?: unknown;
  readonly summary?: unknown;
  readonly stepKey?: unknown;
  readonly severity?: unknown;
  readonly detectedAt?: unknown;
}

interface PersistedReconciliation {
  readonly totalClaims?: unknown;
  readonly supportedClaims?: unknown;
  readonly conflictingClaims?: unknown;
  readonly unsupportedClaims?: unknown;
  readonly parametricOnlyClaims?: unknown;
  readonly meanConfidence?: unknown;
}

interface PersistedFusionArtifact {
  readonly kind?: unknown;
  readonly state?: unknown;
  readonly workspaceId?: unknown;
  readonly artifactId?: unknown;
  readonly jobId?: unknown;
  readonly conflicts?: unknown;
  readonly gaps?: unknown;
  readonly reconciliation?: unknown;
  readonly parametricUsed?: unknown;
  readonly parametricModel?: unknown;
  readonly generatedAt?: unknown;
  readonly notes?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Response shape (must match ProvenancePanel's parser exactly)                */
/* -------------------------------------------------------------------------- */

interface ConflictSideDto {
  readonly sourceIds: readonly string[];
  readonly regionKeys: readonly string[];
  readonly excerpt: string | null;
  readonly provenance: Readonly<Record<string, unknown>>;
}

interface ConflictDto {
  readonly id: string;
  readonly summary: string;
  readonly kind: string;
  readonly candidateResolution: string | null;
  readonly sides: readonly ConflictSideDto[];
  readonly regionKeys: readonly string[];
  readonly detectedAt: string | null;
}

interface GapDto {
  readonly id: string;
  readonly summary: string;
  readonly stepKey: string | null;
  readonly severity: string;
  readonly detectedAt: string | null;
}

interface ReconciliationDto {
  readonly totalClaims: number;
  readonly supportedClaims: number;
  readonly conflictingClaims: number;
  readonly unsupportedClaims: number;
  readonly parametricOnlyClaims: number;
  readonly meanConfidence: number;
}

type FusionStateDto = "pending" | "succeeded" | "failed" | "unknown";

interface ConflictsResponse {
  readonly fusionId: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly state: FusionStateDto;
  readonly jobId: string | null;
  readonly conflicts: readonly ConflictDto[];
  readonly gaps: readonly GapDto[];
  readonly reconciliation: ReconciliationDto | null;
  readonly parametricUsed: boolean;
  readonly parametricModel: string | null;
  readonly generatedAt: string | null;
  readonly conflictsCount: number;
  readonly gapsCount: number;
  readonly message: string;
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Normalisation helpers                                                       */
/* -------------------------------------------------------------------------- */

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return value;
  }
  return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

function normaliseSide(raw: unknown): ConflictSideDto {
  const obj = asRecord(raw);
  const excerptRaw = asString(obj["excerpt"]);
  return {
    sourceIds: asStringArray(obj["sourceIds"]),
    regionKeys: asStringArray(obj["regionKeys"]),
    excerpt:
      excerptRaw !== null ? truncate(excerptRaw, MAX_EXCERPT_LENGTH) : null,
    provenance: asRecord(obj["provenance"]),
  };
}

function normaliseConflict(raw: unknown, index: number): ConflictDto | null {
  const obj = asRecord(raw);
  const summary = asString(obj["summary"]);
  // A conflict without a summary has nothing for the reviewer to act on. Skip
  // it rather than render an empty card; the caller still sees the honest
  // total (see `conflictsCount` below) so they know a malformed entry existed.
  if (summary === null) return null;

  const id = asString(obj["id"]) ?? `conflict-${index}`;
  const kind = asString(obj["kind"]) ?? "unknown";
  const candidateResolution = asString(obj["candidateResolution"]);

  const sidesRaw = obj["sides"];
  const sides: ConflictSideDto[] = [];
  if (Array.isArray(sidesRaw)) {
    for (const s of sidesRaw) sides.push(normaliseSide(s));
  }

  return {
    id,
    summary,
    kind,
    candidateResolution,
    sides,
    regionKeys: asStringArray(obj["regionKeys"]),
    detectedAt: asIsoString(obj["detectedAt"]),
  };
}

function normaliseGap(raw: unknown, index: number): GapDto | null {
  const obj = asRecord(raw);
  const summary = asString(obj["summary"]);
  if (summary === null) return null;
  const id = asString(obj["id"]) ?? `gap-${index}`;
  const stepKey = asString(obj["stepKey"]);
  const severity = asString(obj["severity"]) ?? "warning";
  return {
    id,
    summary,
    stepKey,
    severity,
    detectedAt: asIsoString(obj["detectedAt"]),
  };
}

function normaliseReconciliation(raw: unknown): ReconciliationDto | null {
  if (raw === null || raw === undefined) return null;
  const obj = asRecord(raw);
  const totalClaims = asNumber(obj["totalClaims"]);
  const supportedClaims = asNumber(obj["supportedClaims"]);
  const conflictingClaims = asNumber(obj["conflictingClaims"]);
  const unsupportedClaims = asNumber(obj["unsupportedClaims"]);
  const parametricOnlyClaims = asNumber(obj["parametricOnlyClaims"]);
  const meanConfidence = asNumber(obj["meanConfidence"]);
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

function normaliseState(raw: unknown): FusionStateDto {
  if (raw === "pending" || raw === "succeeded" || raw === "failed") return raw;
  return "unknown";
}

function normaliseNotes(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const n of raw) {
    if (typeof n === "string" && n.length > 0) out.push(n);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Storage lookup                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The object key for a fusion artifact within an already-workspace-scoped
 * store. The `[id]` path segment is validated as a UUID, so no further
 * sanitisation is needed here — the value is content-addressed and cannot
 * introduce path traversal.
 */
function fusionObjectKey(artifactId: string): string {
  return `${FUSION_PREFIX}/${artifactId}.json`;
}

type ReadOutcome =
  | { readonly kind: "ok"; readonly artifact: PersistedFusionArtifact }
  | { readonly kind: "not-found" }
  | { readonly kind: "corrupt" };

/**
 * Read the fusion artifact from the workspace-scoped store. The ObjectStore
 * surface used across the codebase returns a Buffer for the bytes (see the
 * sibling routes), or throws an error whose message matches a "not found"
 * pattern when the key does not exist. We normalise a JSON parse failure to
 * "corrupt" so the caller can distinguish "not written yet" from "written by
 * an incompatible deployment".
 */
async function readFusionArtifact(
  store: {
    readonly get: (key: string) => Promise<Buffer | null>;
  },
  artifactId: string,
): Promise<ReadOutcome> {
  const key = fusionObjectKey(artifactId);
  let bytes: Buffer | null;
  try {
    bytes = await store.get(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(message)) {
      return { kind: "not-found" };
    }
    throw error;
  }
  if (bytes === null) return { kind: "not-found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { kind: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "corrupt" };
  }
  return { kind: "ok", artifact: parsed as PersistedFusionArtifact };
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

export async function GET(
  req: Request,
  context: { readonly params: { readonly id: string } },
): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Fusion conflicts cannot be read.",
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

  // -------------------------------------------------------- auth + RBAC ----
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: false,
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
    assertPermission(session, PERMISSIONS.workspace_read);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  const workspaceId = session.activeWorkspaceId;
  if (workspaceId === null) {
    return NextResponse.json(
      {
        error: "workspace_required",
        message: "An active workspace is required to read fusion conflicts.",
      },
      { status: 403 },
    );
  }

  // ------------------------------------------------------------- id -------
  const fusionId = context.params.id;
  if (typeof fusionId !== "string" || !UUID_PATTERN.test(fusionId)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "id",
        message:
          "Fusion id must be a UUID. Pass the artifactId returned by the combine job, not the job id.",
      },
      { status: 400 },
    );
  }

  // ----------------------------------------------------------- storage ----
  let store: Awaited<ReturnType<typeof forWorkspace>>;
  try {
    store = await forWorkspace(workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/fusion/[id]/conflicts] object store unavailable: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The artifact object store is not configured on this server. Check STORAGE_DRIVER and the associated S3/local configuration.",
      },
      { status: 503 },
    );
  }

  let outcome: ReadOutcome;
  try {
    outcome = await readFusionArtifact(
      store as unknown as {
        readonly get: (key: string) => Promise<Buffer | null>;
      },
      fusionId,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/fusion/[id]/conflicts] storage read failed for ${fusionId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The fusion artifact could not be read from the object store. Check server logs.",
      },
      { status: 503 },
    );
  }

  if (outcome.kind === "not-found") {
    // 404 (not 403) so a caller cannot probe for fusion ids outside their
    // workspace; the workspace-scoped key makes "exists elsewhere" and "does
    // not exist" indistinguishable from the caller's perspective.
    return NextResponse.json(
      {
        error: "not_found",
        message:
          "No fusion artifact exists under this id in your active workspace. If the combine job is still running, retry once it has finished.",
      },
      { status: 404 },
    );
  }
  if (outcome.kind === "corrupt") {
    return NextResponse.json(
      {
        error: "corrupt_artifact",
        message:
          "The fusion artifact is not a valid JSON object. It may have been written by an incompatible deployment; re-run the combine job.",
      },
      { status: 500 },
    );
  }

  const artifact = outcome.artifact;

  // ----------------------------------------------------------- shape ------
  const persistedWorkspaceId = asString(artifact.workspaceId);
  // Defence in depth: even with a workspace-scoped key, refuse to serve a
  // stored artifact whose embedded workspaceId disagrees. A mismatch means a
  // bug elsewhere; surfacing it is safer than returning the wrong data.
  if (persistedWorkspaceId !== null && persistedWorkspaceId !== workspaceId) {
    process.stderr.write(
      `[/api/fusion/[id]/conflicts] workspace mismatch for ${fusionId}: stored=${persistedWorkspaceId} caller=${workspaceId}\n`,
    );
    return NextResponse.json(
      {
        error: "not_found",
        message:
          "No fusion artifact exists under this id in your active workspace.",
      },
      { status: 404 },
    );
  }

  const state = normaliseState(artifact.state);
  const jobId = asString(artifact.jobId);

  const rawConflicts = Array.isArray(artifact.conflicts)
    ? (artifact.conflicts as readonly unknown[])
    : [];
  const rawGaps = Array.isArray(artifact.gaps)
    ? (artifact.gaps as readonly unknown[])
    : [];

  const conflicts: ConflictDto[] = [];
  for (
    let i = 0;
    i < rawConflicts.length && conflicts.length < MAX_ITEMS;
    i += 1
  ) {
    const normalised = normaliseConflict(rawConflicts[i], i);
    if (normalised !== null) conflicts.push(normalised);
  }
  const gaps: GapDto[] = [];
  for (let i = 0; i < rawGaps.length && gaps.length < MAX_ITEMS; i += 1) {
    const normalised = normaliseGap(rawGaps[i], i);
    if (normalised !== null) gaps.push(normalised);
  }

  const reconciliation = normaliseReconciliation(artifact.reconciliation);
  const parametricUsed = artifact.parametricUsed === true;
  const parametricModel = asString(artifact.parametricModel);
  const generatedAt = asIsoString(artifact.generatedAt);
  const notes = normaliseNotes(artifact.notes);

  const message = (() => {
    switch (state) {
      case "pending":
        return "Fusion is still running. Conflicts and gaps will populate when the worker finishes.";
      case "failed":
        return "Fusion failed for this run. See the job status in the worker log; source ingestion artifacts may still be readable individually.";
      case "succeeded":
        return conflicts.length === 0 && gaps.length === 0
          ? "Fusion succeeded with no cross-source conflicts or coverage gaps recorded."
          : `Fusion succeeded: ${rawConflicts.length} conflict(s) and ${rawGaps.length} coverage gap(s) detected.`;
      case "unknown":
      default:
        return "The fusion artifact does not declare a recognised state; treat the conflicts/gaps below as advisory.";
    }
  })();

  const response: ConflictsResponse = {
    fusionId,
    workspaceId,
    artifactId: asString(artifact.artifactId) ?? fusionId,
    state,
    jobId,
    conflicts,
    gaps,
    reconciliation,
    parametricUsed,
    parametricModel,
    generatedAt,
    // Counts are the persisted totals, not the normalised in-memory arrays:
    // if a malformed entry had to be skipped, the reviewer still sees how many
    // the conflict detector actually found.
    conflictsCount: rawConflicts.length,
    gapsCount: rawGaps.length,
    message,
    notes,
  };

  return NextResponse.json(response, { status: 200 });
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

const READ_ONLY_MESSAGE =
  "This endpoint is read-only. Conflict resolution and re-fusion run through the workflow synthesize/regenerate surface, not here.";

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function PUT(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function PATCH(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "This endpoint is read-only. Deleting a fusion artifact belongs to the retention surface (admin/retention), not this route.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
