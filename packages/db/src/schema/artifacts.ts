/**
 * Zipy AI — artifacts, versions and job payload side-tables.
 *
 * Baseline schema for Phase 2. An "artifact" is any byte-carrying object the
 * platform produced or ingested: an uploaded source file, an extracted text
 * blob, a canonical representation, a rendered screenshot, an export bundle.
 * Bytes themselves live in the object store (`packages/storage`); this table
 * records identity, provenance, content hash and version lineage.
 *
 * Design notes:
 *  - Content addressing: `content_hash` is the SHA-256 of the stored bytes.
 *    Re-uploading identical content is detectable without reading the object;
 *    the versioning layer below relies on this to skip regeneration.
 *  - Every artifact is workspace-scoped (`workspace_id`) and every read or
 *    write is authorised through `apps/web/src/lib/rbac` before it reaches the
 *    SQL layer. There is no cross-tenant query in this schema.
 *  - `artifacts.parent_artifact_id` models derivation: an OCR extract points
 *    at the source image, a canonical item points at the extract, a screenshot
 *    points at the step that produced it.
 *  - `artifact_versions` is an append-only log. The current version is also
 *    denormalised onto `artifacts.current_version_id` for O(1) reads; the log
 *    keeps every prior version addressable for diff/restore flows.
 *  - All DDL is idempotent (`CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT
 *    EXISTS`) so the migration runner can re-run it cheaply. No triggers on
 *    these tables except `updated_at`, matching the convention in the users/
 *    workspaces migrations.
 */

export const ARTIFACTS_TABLE = "artifacts" as const;
export const ARTIFACT_VERSIONS_TABLE = "artifact_versions" as const;
export const ARTIFACT_SOURCE_LINKS_TABLE = "artifact_source_links" as const;

export const ARTIFACTS_SCHEMA_VERSION = 1 as const;

/**
 * Canonical artifact kinds. The first segment mirrors the object-store key
 * layout so a key can be reconstructed from `(workspace_id, kind, artifact_id,
 * filename)`. Adding a new kind requires updating `packages/storage` and any
 * downstream consumers that switch on kind.
 */
export const ARTIFACT_KINDS = [
  "source_url",       // headless-browser snapshot, a11y tree, DOM extract
  "source_text",      // free-form prompt or pasted text
  "source_image",     // uploaded image
  "source_pdf",       // uploaded PDF
  "source_docx",      // uploaded Word document
  "source_pptx",      // uploaded PowerPoint deck
  "source_audio",     // uploaded audio
  "source_video",     // uploaded video
  "extract",          // derived: OCR, layout, transcript, element inventory
  "canonical",        // unified intermediate representation
  "screenshot",       // Playwright capture (before/after, full-page, crop)
  "annotation",       // rendered overlay image
  "export",           // PDF/HTML/DOCX/MD/image-pack bundle
  "asset",            // branding asset (logo, font, custom CSS)
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const CREATE_ARTIFACTS_SQL = `
CREATE TABLE IF NOT EXISTS ${ARTIFACTS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  -- Parent artifact, when this artifact was derived from another one.
  parent_artifact_id    UUID REFERENCES ${ARTIFACTS_TABLE}(id) ON DELETE SET NULL,
  -- Object-store key of the current version's bytes (relative to store root).
  storage_key           TEXT NOT NULL,
  -- SHA-256 (hex) of the current version's bytes.
  content_hash          TEXT NOT NULL,
  size_bytes            BIGINT NOT NULL,
  content_type          TEXT,
  -- Original filename, if the artifact came from an upload.
  original_filename     TEXT,
  -- Human label shown in the UI, e.g. "Homepage screenshot".
  label                 TEXT,
  -- Current version pointer, denormalised for cheap reads. FK installed after
  -- artifact_versions exists to avoid a forward reference in DDL.
  current_version_id    UUID,
  -- Extensible metadata bag: source URL, page count, language, viewport, etc.
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${ARTIFACTS_TABLE}_kind_allowed
    CHECK (kind IN (
      'source_url','source_text','source_image','source_pdf','source_docx',
      'source_pptx','source_audio','source_video','extract','canonical',
      'screenshot','annotation','export','asset'
    )),
  CONSTRAINT ${ARTIFACTS_TABLE}_hash_format
    CHECK (length(content_hash) = 64 AND content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ${ARTIFACTS_TABLE}_storage_key_nonempty
    CHECK (length(btrim(storage_key)) > 0),
  CONSTRAINT ${ARTIFACTS_TABLE}_size_nonnegative
    CHECK (size_bytes >= 0)
);

-- Deduplication lookup: the same (workspace, kind) with the same hash is the
-- same bytes and does not need re-processing.
CREATE INDEX IF NOT EXISTS ${ARTIFACTS_TABLE}_content_hash_idx
  ON ${ARTIFACTS_TABLE} (workspace_id, kind, content_hash)
  WHERE deleted_at IS NULL;

-- Listing surfaces group by kind and order by recency.
CREATE INDEX IF NOT EXISTS ${ARTIFACTS_TABLE}_workspace_kind_idx
  ON ${ARTIFACTS_TABLE} (workspace_id, kind, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ${ARTIFACTS_TABLE}_parent_idx
  ON ${ARTIFACTS_TABLE} (parent_artifact_id)
  WHERE parent_artifact_id IS NOT NULL;

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${ARTIFACT_VERSIONS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id           UUID NOT NULL REFERENCES ${ARTIFACTS_TABLE}(id) ON DELETE CASCADE,
  version_number        INTEGER NOT NULL,
  storage_key           TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  size_bytes            BIGINT NOT NULL,
  content_type          TEXT,
  -- Free-form note supplied by the caller ("re-captured after UI change").
  change_note           TEXT,
  -- Who produced this version: a user id, or NULL for automated workers.
  produced_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Provenance label for automation: 'upload','worker:ingest','worker:capture',
  -- 'editor','export','regenerate'. Kept as free text so later phases can add
  -- values without a migration.
  produced_by_stage     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${ARTIFACT_VERSIONS_TABLE}_hash_format
    CHECK (length(content_hash) = 64 AND content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ${ARTIFACT_VERSIONS_TABLE}_version_positive
    CHECK (version_number >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS ${ARTIFACT_VERSIONS_TABLE}_artifact_version_uq
  ON ${ARTIFACT_VERSIONS_TABLE} (artifact_id, version_number);

CREATE INDEX IF NOT EXISTS ${ARTIFACT_VERSIONS_TABLE}_artifact_created_idx
  ON ${ARTIFACT_VERSIONS_TABLE} (artifact_id, created_at DESC);

-- ---------------------------------------------------------------------------

-- Cross-supporting link table: which sources fed which derived artifact. Used
-- by the fusion/provenance phases to walk from a generated step back to every
-- contributing input.
CREATE TABLE IF NOT EXISTS ${ARTIFACT_SOURCE_LINKS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  derived_artifact_id   UUID NOT NULL REFERENCES ${ARTIFACTS_TABLE}(id) ON DELETE CASCADE,
  source_artifact_id    UUID NOT NULL REFERENCES ${ARTIFACTS_TABLE}(id) ON DELETE CASCADE,
  -- Free-form "role" of the source in producing the derived artifact, e.g.
  -- 'primary','cited','embedded_image','transcript'.
  relation              TEXT NOT NULL DEFAULT 'primary',
  -- Trust weight assigned by the fusion phase; 0..1.
  trust_weight          NUMERIC(4,3),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${ARTIFACT_SOURCE_LINKS_TABLE}_no_self_link
    CHECK (derived_artifact_id <> source_artifact_id),
  CONSTRAINT ${ARTIFACT_SOURCE_LINKS_TABLE}_trust_range
    CHECK (trust_weight IS NULL OR (trust_weight >= 0 AND trust_weight <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS ${ARTIFACT_SOURCE_LINKS_TABLE}_pair_uq
  ON ${ARTIFACT_SOURCE_LINKS_TABLE} (derived_artifact_id, source_artifact_id, relation);

-- ---------------------------------------------------------------------------
-- Late FK: artifacts.current_version_id -> artifact_versions.id. Added after
-- artifact_versions exists so the CREATE TABLE above stays readable. The FK is
-- intentionally nullable and NOT validated against kind, so partial writes
-- (row inserted, version row inserted in the same transaction) still succeed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = '${ARTIFACTS_TABLE}_current_version_fk'
  ) THEN
    ALTER TABLE ${ARTIFACTS_TABLE}
      ADD CONSTRAINT ${ARTIFACTS_TABLE}_current_version_fk
      FOREIGN KEY (current_version_id)
      REFERENCES ${ARTIFACT_VERSIONS_TABLE}(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- updated_at trigger on artifacts. artifact_versions is append-only, so no
-- trigger there.

DROP TRIGGER IF EXISTS trg_${ARTIFACTS_TABLE}_updated_at ON ${ARTIFACTS_TABLE};
CREATE TRIGGER trg_${ARTIFACTS_TABLE}_updated_at
  BEFORE UPDATE ON ${ARTIFACTS_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();
`;

/* -------------------------------------------------------------------------- */
/* TypeScript row shapes                                                       */
/* -------------------------------------------------------------------------- */

export interface ArtifactRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: ArtifactKind;
  readonly parent_artifact_id: string | null;
  readonly storage_key: string;
  readonly content_hash: string;
  readonly size_bytes: string; // pg returns BIGINT as string
  readonly content_type: string | null;
  readonly original_filename: string | null;
  readonly label: string | null;
  readonly current_version_id: string | null;
  readonly metadata: Record<string, unknown>;
  readonly created_by: string | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ArtifactVersionRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly version_number: number;
  readonly storage_key: string;
  readonly content_hash: string;
  readonly size_bytes: string;
  readonly content_type: string | null;
  readonly change_note: string | null;
  readonly produced_by: string | null;
  readonly produced_by_stage: string | null;
  readonly created_at: Date;
}

export interface ArtifactSourceLinkRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly derived_artifact_id: string;
  readonly source_artifact_id: string;
  readonly relation: string;
  readonly trust_weight: string | null;
  readonly created_at: Date;
}

/* -------------------------------------------------------------------------- */
/* Guards and helpers                                                          */
/* -------------------------------------------------------------------------- */

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return (
    typeof value === "string" &&
    (ARTIFACT_KINDS as readonly string[]).includes(value)
  );
}

/** Object-store key prefix for an artifact of a given kind. */
export function artifactStoragePrefix(
  workspaceId: string,
  kind: ArtifactKind,
): string {
  // Matches `buildObjectKey` in @zipy/storage.
  return `${workspaceId}/${kind}`;
}
