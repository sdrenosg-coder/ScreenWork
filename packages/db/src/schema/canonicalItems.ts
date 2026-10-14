/**
 * Zipy AI — persistence DDL for canonical sources and their items.
 *
 * The canonical representation (built by `@zipy/processing/canonical`) is
 * what every later phase consumes: fusion read-aloud, synthesis, content
 * generation, provenance. Persisting it means a page refresh does not
 * re-parse PDFs, and the conflict/fact-check passes can query
 * `provenance.bbox` and `time_range` without re-opening raw artifacts.
 *
 * Design notes:
 *  - Two tables, `canonical_sources` (header, one row per artifact) and
 *    `canonical_items` (one row per item), so queries that only need a page
 *    or a time range never touch the (larger) item text.
 *  - JSONB for `content` and `provenance`: the shapes are additive and
 *    versioned by the module, not by extra columns. `canonical_version`
 *    records the module's schema revision so a `rehydrate` can detect a
 *    version it does not understand.
 *  - Bounding box columns are denormalised (four integers) so reviewers can
 *    index and query spatially without parsing JSONB.
 *  - `time_start_ms` / `time_end_ms` are denormalised for the same reason.
 *  - `research NOT NULL` on `artifact_id` with an FK to `artifacts(id)`:
 *    a canonical item without a source artifact is not useful, and the FK
 *    makes it impossible to leave an orphaned source by deleting the
 *    artifact through the API.
 *  - The DDL is idempotent (`IF NOT EXISTS`) so the migration runner
 *    (`packages/db/src/migrate.ts`) can re-run safely.
 *
 * No SQL is invented beyond the tables named here. The migration runner and
 * any other phase that adds tables append their own DDL blocks; this file
 * only owns the canonical surface.
 */

import type { CanonicalItemKind } from "@zipy/processing/canonical";

/** Table names, exported so readers do not retype string literals. */
export const CANONICAL_SOURCES_TABLE = "canonical_sources" as const;
export const CANONICAL_ITEMS_TABLE = "canonical_items" as const;

/**
 * Bump when the *persisted shape* of a `canonical_sources` or
 * `canonical_items` row changes in a way `rehydrateCanonicalSource` must
 * understand. `rehydrate` does not currently read this value, but the
 * runner stores it so a future version can.
 */
export const CANONICAL_SCHEMA_VERSION = 1 as const;

/**
 * Migration ordering: after jobs (40) so `artifacts` and `workspace_id` FKs
 * are already established. Kept as a distinct integer so a future reorder
 * does not require editing every schema file's comment.
 */
export const CANONICAL_MIGRATION_ORDER = 60 as const;

/**
 * Stable list of canonical item kinds for CHECK constraints and rehydration.
 * Keep this list in lockstep with `CanonicalItemKind` in
 * `@zipy/processing/canonical`. A new kind appended to the union *must*
 * also be appended here; a mismatch will be caught by `typecheck` because
 * `CanonicalItemKindInSqlList` uses the union as its type.
 */
export const CANONICAL_ITEM_KINDS_FOR_SQL: readonly CanonicalItemKind[] = [
  "page-text",
  "layout-region",
  "table",
  "table-cell",
  "ui-element",
  "diagram-node",
  "diagram-edge",
  "diagram-description",
  "transcript-segment",
  "video-frame",
  "plain-text",
];

/**
 * Compile-time assurance that `CANONICAL_ITEM_KINDS_FOR_SQL` covers every
 * member of `CanonicalItemKind`. If a kind is added to the union without
 * being added to the list above, the `Exclude` becomes non-`never` and this
 * assignment fails `tsc`.
 */
type _AssertAllKindsInSqlList = Exclude<
  CanonicalItemKind,
  (typeof CANONICAL_ITEM_KINDS_FOR_SQL)[number]
> extends never
  ? true
  : false;
const _assertAllKindsInSqlList: _AssertAllKindsInSqlList = true;
void _assertAllKindsInSqlList;

const KIND_IN_LIST_SQL = CANONICAL_ITEM_KINDS_FOR_SQL.map((k) => `'${k}'`).join(", ");

/**
 * The DDL executed by the migration runner. Two statements: the source
 * header (keyed on the artifact; one canonical source per artifact) and the
 * item table (keyed on `(canonical_source_id, item_id)`, where `item_id`
 * is the deterministic id produced by the builder).
 *
 * Indexes:
 *  - `canonical_sources(workspace_id)` — every read is workspace-scoped.
 *  - `canonical_sources(artifact_id)` is the UNIQUE constraint, so no extra
 *    index is needed.
 *  - `canonical_items(canonical_source_id)` — the primary scan pattern.
 *  - `canonical_items(canonical_source_id, kind)` — kind filters.
 *  - `canonical_items(canonical_source_id, page_index)` — "what's on page N".
 *  - `canonical_items(canonical_source_id, time_start_ms)` — frame/segment
 *    lookup by timestamp.
 *
 * The FK on `canonical_items.canonical_source_id` uses `ON DELETE CASCADE`
 * so a source delete (from the artifact-delete path) removes its items
 * atomically. The FK on `workspace_id` uses the same pattern as the rest of
 * the schema (CASCADE) so a workspace delete is a single statement.
 *
 * `research NOT NULL` on `artifact_id` and `workspace_id`: a canonical
 * source must be attributable to a workspace and an artifact.
 */
export const CREATE_CANONICAL_ITEMS_SQL = `
CREATE TABLE IF NOT EXISTS ${CANONICAL_SOURCES_TABLE} (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_id     UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL,
  adapters_used   TEXT[] NOT NULL DEFAULT '{}',
  canonical_version INTEGER NOT NULL DEFAULT ${CANONICAL_SCHEMA_VERSION},
  item_count      INTEGER NOT NULL DEFAULT 0,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT canonical_sources_artifact_unique UNIQUE (artifact_id)
);

CREATE INDEX IF NOT EXISTS canonical_sources_workspace_id_idx
  ON ${CANONICAL_SOURCES_TABLE} (workspace_id);

CREATE TABLE IF NOT EXISTS ${CANONICAL_ITEMS_TABLE} (
  id                    BIGSERIAL PRIMARY KEY,
  canonical_source_id   BIGINT NOT NULL REFERENCES ${CANONICAL_SOURCES_TABLE}(id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id               TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN (${KIND_IN_LIST_SQL})),
  content               JSONB NOT NULL,
  provenance            JSONB NOT NULL,
  annotations           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Denormalised for indexing (bbox in image/page pixel coordinates):
  bbox_x                INTEGER,
  bbox_y                INTEGER,
  bbox_width            INTEGER,
  bbox_height           INTEGER,
  -- Denormalised time range (media-axis milliseconds):
  time_start_ms         BIGINT,
  time_end_ms           BIGINT,
  -- 0-based page index; NULL for time-axis-only items:
  page_index            INTEGER,
  CONSTRAINT canonical_items_source_item_unique UNIQUE (canonical_source_id, item_id),
  CONSTRAINT canonical_items_bbox_or_time_or_page CHECK (
    page_index IS NOT NULL
    OR (bbox_x IS NOT NULL AND bbox_y IS NOT NULL AND bbox_width IS NOT NULL AND bbox_height IS NOT NULL)
    OR (time_start_ms IS NOT NULL AND time_end_ms IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS canonical_items_source_idx
  ON ${CANONICAL_ITEMS_TABLE} (canonical_source_id);

CREATE INDEX IF NOT EXISTS canonical_items_source_kind_idx
  ON ${CANONICAL_ITEMS_TABLE} (canonical_source_id, kind);

CREATE INDEX IF NOT EXISTS canonical_items_source_page_idx
  ON ${CANONICAL_ITEMS_TABLE} (canonical_source_id, page_index);

CREATE INDEX IF NOT EXISTS canonical_items_source_time_idx
  ON ${CANONICAL_ITEMS_TABLE} (canonical_source_id, time_start_ms);

CREATE INDEX IF NOT EXISTS canonical_items_workspace_idx
  ON ${CANONICAL_ITEMS_TABLE} (workspace_id);
`;

/* -------------------------------------------------------------------------- */
/* Row types                                                                   */
/* -------------------------------------------------------------------------- */

/** Row shape of `canonical_sources`. */
export interface CanonicalSourceRow {
  readonly id: number;
  readonly workspace_id: string;
  readonly artifact_id: string;
  readonly source_type: string;
  readonly adapters_used: readonly string[];
  readonly canonical_version: number;
  readonly item_count: number;
  readonly generated_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Row shape of `canonical_items`. */
export interface CanonicalItemRow {
  readonly id: number;
  readonly canonical_source_id: number;
  readonly workspace_id: string;
  readonly item_id: string;
  readonly kind: string;
  readonly content: unknown;
  readonly provenance: unknown;
  readonly annotations: unknown;
  readonly bbox_x: number | null;
  readonly bbox_y: number | null;
  readonly bbox_width: number | null;
  readonly bbox_height: number | null;
  readonly time_start_ms: number | null;
  readonly time_end_ms: number | null;
  readonly page_index: number | null;
}
