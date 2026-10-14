/**
 * Zipy AI — ingested source records (URL snapshots, text prompts, file
 * uploads).
 *
 * A "source" is the top-level row that a user creates when submitting an
 * input. It is the aggregate the UI lists, the API returns, and the fusion
 * phase iterates over. Bytes and extracted payloads live in `artifacts`
 * (Phase 2); this schema records the *identity* of a source and its
 * intermediate processing state.
 *
 * Design notes:
 *  - One row per submission. Multiple sources can be attached to a workflow
 *    (see `source_workflow_links`) so a workflow's grounding is explicit.
 *  - `kind` mirrors the four top-level categories the UI exposes (url, text,
 *    image, file). File sub-kinds (pdf/docx/pptx/audio/video) are carried in
 *    `file_kind` so a single "upload" widget still produces one source row.
 *  - `status` is the state machine over the ingestion pipeline:
 *      pending    → row inserted, job not yet claimed
 *      ingesting  → worker claimed the job, work in progress
 *      ready      → at least one derived artifact is usable
 *      failed     → the ingestion exhausted retries
 *      superseded → a subsequent submission of the same content_hash exists
 *    The state machine is deliberately small; per-derivation states live on
 *    artifacts so a URL snapshot's *page contents* can be re-processed without
 *    the source going back to `pending`.
 *  - Content addressing: `content_hash` is the SHA-256 of the canonical input
 *    (URL normalized, text trimmed, file bytes). The unique index below is
 *    per (workspace, kind, content_hash) so re-submitting the same URL does
 *    not create a second source row. The worker checks for an existing
 *    ready sibling and no-ops rather than re-running Playwright.
 *  - `source_priority` captures the user's preference for which source wins
 *    when two sources disagree. It is an integer weight (lower = higher
 *    priority) so the fusion layer's arithmetic is trivial.
 *  - `payload` is a JSONB bag whose shape is validated in TypeScript by
 *    @zipy/ingest helpers (e.g. `UrlIngestResult`, `TextPromptArtifactPayload`).
 *    The DB stores it opaque; consumers narrow it on read via typed loaders.
 *  - No credentials, no PII by construction: message bodies, prompts and
 *    uploaded bytes live only in artifacts. `payload` carries structure
 *    (URL, language hints, entity lists) and never carries raw bytes.
 */

export const SOURCES_TABLE = "sources" as const;
export const SOURCE_WORKFLOW_LINKS_TABLE = "source_workflow_links" as const;
export const SOURCE_CONFLICTS_TABLE = "source_conflicts" as const;

export const SOURCES_SCHEMA_VERSION = 1 as const;

/**
 * Top-level source kinds. The set is closed because every consumer switches
 * on it; new kinds require a migration and a code change in @zipy/ingest.
 */
export const SOURCE_KINDS = ["url", "text", "image", "file"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Secondary classification for uploads so a single "upload" flow can produce
 * the correct extract. `null` for url and text sources.
 */
export const SOURCE_FILE_KINDS = [
  "pdf",
  "docx",
  "pptx",
  "audio",
  "video",
  "unknown",
] as const;
export type SourceFileKind = (typeof SOURCE_FILE_KINDS)[number];

/** State machine over the ingestion pipeline. */
export const SOURCE_STATUSES = [
  "pending",
  "ingesting",
  "ready",
  "failed",
  "superseded",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/**
 * How a source is treated by the fusion layer. Matches the four "modes" the
 * phase plan describes — `primary` is the default and the highest weight;
 * `context` is a hint (e.g. a supplementary image) that is not expected to
 * contain the canonical step list.
 */
export const SOURCE_ROLES = ["primary", "supporting", "context", "reference"] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export const CREATE_SOURCES_SQL = `
CREATE TABLE IF NOT EXISTS ${SOURCES_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  -- For 'file' kind only; the specific format so the worker can route.
  file_kind             TEXT,
  -- Source role in the fusion layer. 'primary' is the default.
  role                  TEXT NOT NULL DEFAULT 'primary',
  -- Lower number wins in fusion tie-breaks. Defaults to 100.
  source_priority       INTEGER NOT NULL DEFAULT 100,
  -- Human label shown in the UI, e.g. "Signup flow", "Onboarding PDF".
  label                 TEXT,
  -- Canonical URL for 'url' sources after normalization (strip fragment,
  -- sort query, lowercase host). Empty for non-url sources.
  canonical_url         TEXT,
  -- SHA-256 of the canonical input bytes / normalized string. See file header.
  content_hash          TEXT NOT NULL,
  -- MIME type of the raw input (image/svg+xml, application/pdf, ...).
  mime_type             TEXT,
  -- Size in bytes of the raw input, when known.
  size_bytes            BIGINT,
  -- Ingestion state machine. See SOURCE_STATUSES.
  status                TEXT NOT NULL DEFAULT 'pending',
  -- Number of attempts the worker has made to ingest this source.
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  -- Last ingestion error, surfaced to the UI when status='failed'.
  last_error            TEXT,
  -- Free-form structured payload; shape is typed per-kind in TypeScript.
  -- Never contains raw bytes or PII.
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${SOURCES_TABLE}_kind_allowed
    CHECK (kind IN ('url','text','image','file')),
  CONSTRAINT ${SOURCES_TABLE}_file_kind_allowed
    CHECK (
      file_kind IS NULL
      OR file_kind IN ('pdf','docx','pptx','audio','video','unknown')
    ),
  CONSTRAINT ${SOURCES_TABLE}_file_kind_requires_file
    CHECK (
      (kind = 'file' AND file_kind IS NOT NULL)
      OR (kind <> 'file' AND file_kind IS NULL)
    ),
  CONSTRAINT ${SOURCES_TABLE}_role_allowed
    CHECK (role IN ('primary','supporting','context','reference')),
  CONSTRAINT ${SOURCES_TABLE}_status_allowed
    CHECK (status IN ('pending','ingesting','ready','failed','superseded')),
  CONSTRAINT ${SOURCES_TABLE}_priority_range
    CHECK (source_priority >= 0 AND source_priority <= 10000),
  CONSTRAINT ${SOURCES_TABLE}_hash_format
    CHECK (length(content_hash) = 64 AND content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ${SOURCES_TABLE}_url_requires_canonical_url
    CHECK (
      (kind = 'url' AND canonical_url IS NOT NULL AND length(btrim(canonical_url)) > 0)
      OR kind <> 'url'
    ),
  CONSTRAINT ${SOURCES_TABLE}_attempts_nonnegative
    CHECK (attempt_count >= 0),
  CONSTRAINT ${SOURCES_TABLE}_size_nonnegative
    CHECK (size_bytes IS NULL OR size_bytes >= 0)
);

-- Dedupe lookup: the same (workspace, kind) with the same hash is the same
-- logical input. Re-submission reuses the existing ready row.
CREATE UNIQUE INDEX IF NOT EXISTS ${SOURCES_TABLE}_dedupe_uq
  ON ${SOURCES_TABLE} (workspace_id, kind, content_hash)
  WHERE deleted_at IS NULL;

-- Listing surface: recency-ordered per workspace.
CREATE INDEX IF NOT EXISTS ${SOURCES_TABLE}_workspace_created_idx
  ON ${SOURCES_TABLE} (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Worker claim surface: pending sources, oldest first. Partial index keeps the
-- claim scan cheap even with many ready rows.
CREATE INDEX IF NOT EXISTS ${SOURCES_TABLE}_pending_idx
  ON ${SOURCES_TABLE} (status, created_at)
  WHERE status IN ('pending','ingesting') AND deleted_at IS NULL;

-- Lookup by canonical URL for the "replace this bookmark's snapshot" flow.
CREATE INDEX IF NOT EXISTS ${SOURCES_TABLE}_canonical_url_idx
  ON ${SOURCES_TABLE} (workspace_id, canonical_url)
  WHERE kind = 'url' AND deleted_at IS NULL;

-- Filters the UI exposes.
CREATE INDEX IF NOT EXISTS ${SOURCES_TABLE}_workspace_status_kind_idx
  ON ${SOURCES_TABLE} (workspace_id, status, kind)
  WHERE deleted_at IS NULL;

-- updated_at trigger.
DROP TRIGGER IF EXISTS trg_${SOURCES_TABLE}_updated_at ON ${SOURCES_TABLE};
CREATE TRIGGER trg_${SOURCES_TABLE}_updated_at
  BEFORE UPDATE ON ${SOURCES_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();

-- ---------------------------------------------------------------------------
-- Link table: sources attached to a workflow. A workflow is any of the
-- synthesis-phase entities (guides, runbooks); until that schema lands this
-- uses a TEXT-keyed reference so cross-schema FKs do not block ingestion.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${SOURCE_WORKFLOW_LINKS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id             UUID NOT NULL REFERENCES ${SOURCES_TABLE}(id) ON DELETE CASCADE,
  -- Opaque identifier of the workflow the source was attached to. Becomes a
  -- UUID FK once the workflows table exists.
  workflow_ref          TEXT NOT NULL,
  -- The order in which the user attached the source. Ties on `source_priority`
  -- fall back to this for determinism.
  attached_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ${SOURCE_WORKFLOW_LINKS_TABLE}_workflow_ref_nonempty
    CHECK (length(btrim(workflow_ref)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ${SOURCE_WORKFLOW_LINKS_TABLE}_unique_pair
  ON ${SOURCE_WORKFLOW_LINKS_TABLE} (workflow_ref, source_id);

CREATE INDEX IF NOT EXISTS ${SOURCE_WORKFLOW_LINKS_TABLE}_workflow_idx
  ON ${SOURCE_WORKFLOW_LINKS_TABLE} (workflow_ref, attached_at);

-- ---------------------------------------------------------------------------
-- Conflict log: every cross-source disagreement detected by the fusion phase
-- is recorded here so the UI can surface it and the reviewer can resolve it.
-- This table is deliberately independent of the specific conflict-detection
-- algorithm — it stores the *observation*, not the algorithm's internals.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${SOURCE_CONFLICTS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_ref          TEXT NOT NULL,
  -- The two sources that disagreed. Both are always set.
  source_a_id           UUID NOT NULL REFERENCES ${SOURCES_TABLE}(id) ON DELETE CASCADE,
  source_b_id           UUID NOT NULL REFERENCES ${SOURCES_TABLE}(id) ON DELETE CASCADE,
  -- Free-form subtype the detector assigned, e.g. 'step_ordering',
  -- 'element_label', 'field_required', 'url_route'.
  conflict_kind         TEXT NOT NULL,
  -- Short human description of what disagreed.
  summary               TEXT NOT NULL,
  -- The two disagreeing excerpts, verbatim.
  excerpt_a             TEXT,
  excerpt_b             TEXT,
  -- Confidence 0..1 that this is a real conflict (filters noise).
  confidence            NUMERIC(4,3) NOT NULL DEFAULT 0.500,
  -- Lifecycle: 'open' until a reviewer marks it resolved or dismissed.
  status                TEXT NOT NULL DEFAULT 'open',
  -- Resolution chosen by the reviewer, when any.
  resolution            TEXT,
  resolved_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${SOURCE_CONFLICTS_TABLE}_distinct_sources
    CHECK (source_a_id <> source_b_id),
  CONSTRAINT ${SOURCE_CONFLICTS_TABLE}_workflow_ref_nonempty
    CHECK (length(btrim(workflow_ref)) > 0),
  CONSTRAINT ${SOURCE_CONFLICTS_TABLE}_conflict_kind_nonempty
    CHECK (length(btrim(conflict_kind)) > 0),
  CONSTRAINT ${SOURCE_CONFLICTS_TABLE}_summary_nonempty
    CHECK (length(btrim(summary)) > 0),
  CONSTRAINT ${SOURCE_CONFLICTS_TABLE}_confidence_range
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT ${SOURCE_CONFLICTS_TABLE}_status_allowed
    CHECK (status IN ('open','resolved','dismissed')),
  CONSTRAINT ${SOURCE_CONFLICTS_TABLE}_resolution_requires_status
    CHECK (
      (status = 'open' AND resolved_at IS NULL AND resolution IS NULL)
      OR (status IN ('resolved','dismissed') AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS ${SOURCE_CONFLICTS_TABLE}_workflow_open_idx
  ON ${SOURCE_CONFLICTS_TABLE} (workspace_id, workflow_ref, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ${SOURCE_CONFLICTS_TABLE}_source_a_idx
  ON ${SOURCE_CONFLICTS_TABLE} (source_a_id);

CREATE INDEX IF NOT EXISTS ${SOURCE_CONFLICTS_TABLE}_source_b_idx
  ON ${SOURCE_CONFLICTS_TABLE} (source_b_id);
`;

/* -------------------------------------------------------------------------- */
/* TypeScript row shapes                                                       */
/* -------------------------------------------------------------------------- */

export interface SourceRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: SourceKind;
  readonly file_kind: SourceFileKind | null;
  readonly role: SourceRole;
  readonly source_priority: number;
  readonly label: string | null;
  readonly canonical_url: string | null;
  readonly content_hash: string;
  readonly mime_type: string | null;
  readonly size_bytes: string | null; // BIGINT arrives as string via pg
  readonly status: SourceStatus;
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly payload: Record<string, unknown>;
  readonly created_by: string | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface SourceWorkflowLinkRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly source_id: string;
  readonly workflow_ref: string;
  readonly attached_at: Date;
  readonly created_by: string | null;
}

export interface SourceConflictRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly workflow_ref: string;
  readonly source_a_id: string;
  readonly source_b_id: string;
  readonly conflict_kind: string;
  readonly summary: string;
  readonly excerpt_a: string | null;
  readonly excerpt_b: string | null;
  readonly confidence: string; // NUMERIC arrives as string via pg
  readonly status: "open" | "resolved" | "dismissed";
  readonly resolution: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

export function isSourceKind(value: unknown): value is SourceKind {
  return (
    typeof value === "string" &&
    (SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isSourceFileKind(value: unknown): value is SourceFileKind {
  return (
    typeof value === "string" &&
    (SOURCE_FILE_KINDS as readonly string[]).includes(value)
  );
}

export function isSourceStatus(value: unknown): value is SourceStatus {
  return (
    typeof value === "string" &&
    (SOURCE_STATUSES as readonly string[]).includes(value)
  );
}

export function isSourceRole(value: unknown): value is SourceRole {
  return (
    typeof value === "string" &&
    (SOURCE_ROLES as readonly string[]).includes(value)
  );
}

/**
 * True when the source is in a state where further processing is expected:
 * `pending`, `ingesting` or `superseded`. Used by the worker claim query and
 * by the UI to disable destructive actions while a job is in flight.
 */
export function isSourceInFlight(status: SourceStatus): boolean {
  return status === "pending" || status === "ingesting";
}

/**
 * Error class thrown by the loader when a persisted payload does not match the
 * type its `kind` declares. Kept here (not in @zipy/ingest) so the schema
 * module owns the shape it validates.
 */
export class SourcePayloadShapeError extends Error {
  readonly kind: SourceKind;
  constructor(kind: SourceKind, reason: string) {
    super(`Source payload for kind="${kind}" is invalid: ${reason}`);
    this.name = "SourcePayloadShapeError";
    this.kind = kind;
  }
}

/**
 * Narrow a `SourceRow.payload` to the shape the URL-ingest flow produces.
 * The check is shallow (top-level fields only) because the deep structure
 * (a11y tree) is validated by @zipy/ingest on rehydration. Returns the same
 * object on success; throws `SourcePayloadShapeError` otherwise.
 */
export function assertUrlSourcePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const required = ["finalUrl", "capturedAt", "a11y", "elements"];
  for (const key of required) {
    if (!(key in payload)) {
      throw new SourcePayloadShapeError("url", `missing field "${key}"`);
    }
  }
  if (typeof payload["finalUrl"] !== "string") {
    throw new SourcePayloadShapeError("url", `"finalUrl" must be a string`);
  }
  if (typeof payload["capturedAt"] !== "string") {
    throw new SourcePayloadShapeError("url", `"capturedAt" must be a string`);
  }
  if (!Array.isArray(payload["elements"])) {
    throw new SourcePayloadShapeError("url", `"elements" must be an array`);
  }
  if (payload["a11y"] === null || typeof payload["a11y"] !== "object") {
    throw new SourcePayloadShapeError("url", `"a11y" must be an object`);
  }
  return payload;
}

/**
 * Narrow a `SourceRow.payload` to the shape the text-prompt flow produces.
 * See `apps/worker/src/ingest/textPrompt.ts` for the producer of this shape.
 */
export function assertTextSourcePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const required = ["prompt", "goal", "subTasks"];
  for (const key of required) {
    if (!(key in payload)) {
      throw new SourcePayloadShapeError("text", `missing field "${key}"`);
    }
  }
  if (typeof payload["prompt"] !== "string" || payload["prompt"].length === 0) {
    throw new SourcePayloadShapeError("text", `"prompt" must be a non-empty string`);
  }
  if (typeof payload["goal"] !== "string" || payload["goal"].length === 0) {
    throw new SourcePayloadShapeError("text", `"goal" must be a non-empty string`);
  }
  if (!Array.isArray(payload["subTasks"]) || payload["subTasks"].length === 0) {
    throw new SourcePayloadShapeError("text", `"subTasks" must be a non-empty array`);
  }
  return payload;
}
