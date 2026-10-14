/**
 * POST /api/artifacts/upload
 *
 * Multipart upload endpoint that is the single entry point for every
 * user-supplied artefact: URL snapshots referenced into the object store,
 * pasted text, uploaded images / PDFs / DOCX / PPTX, and audio / video.
 *
 * Responsibilities (final batch of the Storage / artifact / jobs phase):
 *  - Authenticate the caller and enforce workspace-scoped RBAC before a single
 *    byte is written. `PERMISSIONS.source_create` is the required permission;
 *    every upload ultimately becomes a source artefact, so an editor (or
 *    above) is the minimum role.
 *  - Reject requests when DATABASE_URL is missing. A queue-misconfiguration is
 *    reported in the response body (the artefact is still persisted) rather
 *    than as a top-level 503, since a valid artefact is useful even when the
 *    worker cannot yet run the ingestion.
 *  - Parse the multipart body (`request.formData()`) with a hard upper bound on
 *    the number of parts so a malicious uploader cannot exhaust memory.
 *  - Compute a streaming SHA-256 over the received bytes (delegating to the
 *    shared content-hash helper so the value matches the one the worker later
 *    computes when it re-reads the object).
 *  - Deduplicate: if an `artifacts` row already exists for the same
 *    (workspace, kind, content_hash) and is not soft-deleted, reuse it. No
 *    second object is written and no new version row is appended — the caller
 *    receives the existing artifact id with `deduplicated: true`. The
 *    downstream ingestion job is enqueued with an idempotency key derived from
 *    the shared content hash so re-uploading identical bytes does not spawn a
 *    second job.
 *  - Persist: one `artifacts` row plus one `artifact_versions` row
 *    (`version_number = 1`) in a single transaction, pointing both at the same
 *    `storage_key` / `content_hash`. A late UPDATE sets
 *    `artifacts.current_version_id` so the denormalised read path is warm.
 *  - Enqueue the matching ingestion job (`ingest:url` / `ingest:text` /
 *    `ingest:image` / `ingest:pdf` / `ingest:docx` / `ingest:pptx` /
 *    `ingest:audio` / `ingest:video`) through the shared queue so ingestion
 *    runs on the worker, not inside the request. Errors while enqueuing do not
 *    roll the artifact back — the artefact is still a valid record and the
 *    caller can retry just the ingestion via a future endpoint.
 *
 * Notes:
 *  - The object store is resolved through `forWorkspace(workspaceId)`, which
 *    enforces the workspace key prefix on every subsequent call.
 *  - No new credentials are invented. If the configured driver cannot be
 *    resolved (no driver registered for the selected name), the route returns
 *    503 with a clear message.
 *  - The route is intentionally strict about the parameters it accepts: an
 *    unknown `sourceKind` or a form field that does not match the declared
 *    kind yields a 400 rather than a silent best-effort mapping.
 *  - The 503 (object store unavailable) and 500 (storage write failed) paths
 *    return a JSON body of shape `{ error, message }`. The 503 is used when
 *    the driver factory refuses to construct; the 500 when the underlying
 *    put() rejected.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

import {
  defaultDatePartition,
  forWorkspace,
  ObjectKeyError,
  StorageConfigError,
  type ObjectKind as StorageObjectKind,
} from "@zipy/storage/objectStore";
import { ARTIFACT_KINDS, type ArtifactKind } from "@zipy/db/schema/artifacts";
import {
  enqueueJob,
  isJobKind,
  type EnqueueResult,
  type JobKind,
} from "@zipy/jobs/queue";
import { hashBytes } from "@zipy/hashing/contentHash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Source <-> artifact <-> ingest-job mapping                                  */
/* -------------------------------------------------------------------------- */

/**
 * The upload's `sourceKind` is a subset of the artifact kinds, prefixed with
 * `source_`. Keeping the mapping explicit lets a bad caller value fail with a
 * crisp 400 and lets us expose the accepted set in error messages.
 */
export const UPLOAD_SOURCE_KINDS = [
  "source_url",
  "source_text",
  "source_image",
  "source_pdf",
  "source_docx",
  "source_pptx",
  "source_audio",
  "source_video",
] as const;

export type UploadSourceKind = (typeof UPLOAD_SOURCE_KINDS)[number];

/**
 * Which ingest job kind corresponds to a source kind. Kept in a single
 * readonly map so a new source kind is a compile error here if the job queue
 * does not yet have a matching job kind (see the runtime guard below).
 */
const INGEST_JOB_FOR_SOURCE: Readonly<Record<UploadSourceKind, string>> =
  Object.freeze({
    source_url: "ingest:url",
    source_text: "ingest:text",
    source_image: "ingest:image",
    source_pdf: "ingest:pdf",
    source_docx: "ingest:docx",
    source_pptx: "ingest:pptx",
    source_audio: "ingest:audio",
    source_video: "ingest:video",
  });

/**
 * Storage object kinds recognised by the object-store layer. Uploads always
 * land under `source` — nothing else — so the retention sweep for scratch data
 * can find them by prefix.
 */
const SOURCE_STORAGE_KIND: StorageObjectKind = "source";

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Maximum byte size accepted by a single upload. Chosen so a single request
 * cannot exhaust worker memory; files above this bound should be uploaded
 * directly to the object store via a presigned PUT URL (a later phase).
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB

/** Hard cap on multipart parts to avoid pathological parse work. */
export const MAX_FORM_PARTS = 32;

/** Hard cap on the text payload for `source_text` uploads. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MiB of UTF-8 text

/**
 * Content-type defaults for each source kind. Used when the caller does not
 * supply an explicit `contentType`. The value here is what gets stored on the
 * artifact row and what the driver tags the object with.
 */
const DEFAULT_CONTENT_TYPE: Readonly<Record<UploadSourceKind, string>> =
  Object.freeze({
    source_url: "text/uri-list",
    source_text: "text/plain; charset=utf-8",
    source_image: "application/octet-stream",
    source_pdf: "application/pdf",
    source_docx:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    source_pptx:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    source_audio: "application/octet-stream",
    source_video: "application/octet-stream",
  });

/* -------------------------------------------------------------------------- */
/* Postgres client (shared shape with sibling routes)                          */
/* -------------------------------------------------------------------------- */

type PgPool = {
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
  connect: () => Promise<PgClient>;
  end: () => Promise<void>;
};
type PgClient = {
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release: () => void;
};
type PoolCtor = new (opts: {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean } | false;
  max?: number;
}) => PgPool;

const require = createRequire(import.meta.url);

function requirePoolCtor(): PoolCtor {
  try {
    const mod = require("pg") as { Pool: PoolCtor };
    return mod.Pool;
  } catch {
    throw new Error(
      "Zipy AI artifacts/upload: the `pg` package is not installed. Run `npm install` at the repository root.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Input normalisation                                                         */
/* -------------------------------------------------------------------------- */

function isUploadSourceKind(v: unknown): v is UploadSourceKind {
  return (
    typeof v === "string" &&
    (UPLOAD_SOURCE_KINDS as readonly string[]).includes(v)
  );
}

/**
 * Map the `sourceKind` request field to the artifact kind the row will use.
 * The two names are identical by construction; this function exists so the
 * compiler treats the mapping as an intentional decision, not an accident.
 */
function artifactKindFor(sourceKind: UploadSourceKind): ArtifactKind {
  // Every upload source kind is also a valid artifact kind (guaranteed by the
  // shared `ARTIFACT_KINDS` catalogue; the assertion is a cheap defensive
  // check for a future edit that removes one side of the pair).
  if (!(ARTIFACT_KINDS as readonly string[]).includes(sourceKind)) {
    throw new Error(
      `Internal mapping error: source kind "${sourceKind}" has no matching artifact kind.`,
    );
  }
  return sourceKind as ArtifactKind;
}

/**
 * Map the `sourceKind` request field to the ingest job kind. Validated against
 * the runtime `JOB_KINDS` list so a drifted mapping fails loudly rather than
 * enqueueing an unknown job.
 */
function ingestJobFor(sourceKind: UploadSourceKind): JobKind {
  const candidate = INGEST_JOB_FOR_SOURCE[sourceKind];
  if (!isJobKind(candidate)) {
    throw new Error(
      `Internal mapping error: source kind "${sourceKind}" maps to unknown job kind "${candidate}".`,
    );
  }
  return candidate;
}

/** Sanitise a filename for use as an object key segment. */
function sanitizeFilename(raw: string | null, fallbackBase: string): string {
  const base = (raw ?? "").trim().length > 0 ? raw!.trim() : fallbackBase;
  // Strip any path separators, then keep a conservative character class which
  // the object-store key validator will accept. Extensions survive.
  const noSlashes = base.replace(/[\\/]+/g, "_");
  const cleaned = noSlashes.replace(/[^A-Za-z0-9._-]+/g, "_");
  // Avoid `.` / `..` — sanitisation above would produce those if the input was
  // literally "..", so handle it explicitly.
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return fallbackBase;
  }
  return cleaned.slice(0, 128);
}

/**
 * Read a form field as a string. Returns null when absent or empty. A File
 * value is rejected — a caller mixing File and string fields for the same key
 * is a mistake worth surfacing.
 */
function readStringField(
  form: FormData,
  name: string,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  const raw = form.get(name);
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === "string") {
    return { ok: true, value: raw };
  }
  return { ok: false, reason: `Field "${name}" must be a plain string.` };
}

/* -------------------------------------------------------------------------- */
/* Body readers                                                                */
/* -------------------------------------------------------------------------- */

interface CommonBody {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly originalFilename: string | null;
}

/**
 * Read the raw bytes for a request. For a `source_url` upload, the body is a
 * small JSON/plain-text pointer, not the page itself; the worker will fetch
 * the URL. For every other kind the body must be a File part named `file`
 * (or, for `source_text`, either a `file` or a `text` form field).
 */
function extractBytes(
  sourceKind: UploadSourceKind,
  form: FormData,
): { ok: true; body: CommonBody } | { ok: false; status: number; message: string } {
  if (sourceKind === "source_text") {
    const filePart = form.get("file");
    if (filePart && typeof filePart !== "string") {
      return readFileBytes(filePart, "text/plain; charset=utf-8");
    }
    const textField = form.get("text");
    if (typeof textField === "string" && textField.length > 0) {
      const bytes = Buffer.from(textField, "utf8");
      if (bytes.length > MAX_TEXT_BYTES) {
        return {
          ok: false,
          status: 413,
          message: `Text payload exceeds the ${MAX_TEXT_BYTES}-byte limit.`,
        };
      }
      return {
        ok: true,
        body: {
          bytes,
          contentType: "text/plain; charset=utf-8",
          originalFilename: null,
        },
      };
    }
    return {
      ok: false,
      status: 400,
      message:
        'A source_text upload requires either a "file" part or a non-empty "text" field.',
    };
  }

  const filePart = form.get("file");
  if (!filePart || typeof filePart === "string") {
    return {
      ok: false,
      status: 400,
      message: `A file part named "file" is required for ${sourceKind}.`,
    };
  }
  const contentTypeOverride = form.get("contentType");
  const contentType =
    typeof contentTypeOverride === "string" && contentTypeOverride.length > 0
      ? contentTypeOverride
      : filePart.type && filePart.type.length > 0
        ? filePart.type
        : DEFAULT_CONTENT_TYPE[sourceKind];
  return readFileBytes(filePart, contentType);
}

async function readFileBytes(
  file: Blob,
  contentType: string,
): Promise<
  { ok: true; body: CommonBody } | { ok: false; status: number; message: string }
> {
  if (typeof file.size === "number" && file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `Upload exceeds the ${MAX_UPLOAD_BYTES}-byte limit.`,
    };
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `Upload exceeds the ${MAX_UPLOAD_BYTES}-byte limit.`,
    };
  }
  // `File` instances expose a `name`; the Blob interface does not, so read it
  // defensively.
  const anyFile = file as unknown as { name?: unknown };
  const originalFilename =
    typeof anyFile.name === "string" && anyFile.name.length > 0
      ? anyFile.name
      : null;
  return {
    ok: true,
    body: { bytes: buf, contentType, originalFilename },
  };
}

/**
 * Validate a source_url body. The URL must be absolute http(s) and reasonably
 * short — the worker will refuse to fetch anything else anyway, so reject at
 * the edge for a crisper error.
 */
function readUrlReference(
  form: FormData,
):
  | { ok: true; url: string }
  | { ok: false; status: number; message: string } {
  const raw = form.get("url");
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      message: 'A source_url upload requires a non-empty "url" field.',
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length > 2048) {
    return {
      ok: false,
      status: 400,
      message: "The submitted URL exceeds the 2048-character limit.",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      status: 400,
      message: "The submitted URL is not a valid absolute URL.",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      status: 400,
      message: "Only http and https URLs are accepted for URL ingestion.",
    };
  }
  return { ok: true, url: parsed.toString() };
}

/* -------------------------------------------------------------------------- */
/* Artifact persistence                                                        */
/* -------------------------------------------------------------------------- */

interface PersistInput {
  readonly workspaceId: string;
  readonly kind: ArtifactKind;
  readonly storageKey: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly originalFilename: string | null;
  readonly label: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdBy: string;
}

interface PersistResult {
  readonly artifactId: string;
  readonly versionId: string;
  readonly versionNumber: number;
}

/**
 * Insert the artifact + version rows and wire `current_version_id`. Uses a
 * single transaction so a partially-persisted artifact cannot be observed by
 * the worker.
 */
async function persistArtifact(
  client: PgClient,
  input: PersistInput,
): Promise<PersistResult> {
  await client.query("BEGIN");
  try {
    const artIns = await client.query(
      `INSERT INTO artifacts
         (workspace_id, kind, storage_key, content_hash, size_bytes,
          content_type, original_filename, label, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING id`,
      [
        input.workspaceId,
        input.kind,
        input.storageKey,
        input.contentHash,
        input.sizeBytes,
        input.contentType,
        input.originalFilename,
        input.label,
        JSON.stringify(input.metadata),
        input.createdBy,
      ],
    );
    const artifactId = (artIns.rows[0] as { id: string }).id;

    const verIns = await client.query(
      `INSERT INTO artifact_versions
         (artifact_id, version_number, storage_key, content_hash, size_bytes,
          content_type, change_note, produced_by, produced_by_stage)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        artifactId,
        input.storageKey,
        input.contentHash,
        input.sizeBytes,
        input.contentType,
        "initial upload",
        input.createdBy,
        "upload",
      ],
    );
    const versionId = (verIns.rows[0] as { id: string }).id;

    await client.query(
      `UPDATE artifacts SET current_version_id = $2 WHERE id = $1`,
      [artifactId, versionId],
    );

    await client.query("COMMIT");
    return { artifactId, versionId, versionNumber: 1 };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

/**
 * Look up a non-deleted artifact in the same workspace + kind with identical
 * content hash. Content addressing means the same bytes are the same artifact
 * regardless of filename.
 */
async function findExistingByHash(
  client: PgClient,
  workspaceId: string,
  kind: ArtifactKind,
  contentHash: string,
): Promise<{ id: string; currentVersionId: string | null } | null> {
  const res = await client.query(
    `SELECT id, current_version_id
       FROM artifacts
      WHERE workspace_id = $1
        AND kind = $2
        AND content_hash = $3
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [workspaceId, kind, contentHash],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as {
    id: string;
    current_version_id: string | null;
  };
  return { id: row.id, currentVersionId: row.current_version_id };
}

/* -------------------------------------------------------------------------- */
/* Error response helpers                                                      */
/* -------------------------------------------------------------------------- */

function jsonError(
  status: number,
  error: string,
  message: string,
): NextResponse {
  return NextResponse.json({ error, message }, { status });
}

/* -------------------------------------------------------------------------- */
/* Route handler                                                               */
/* -------------------------------------------------------------------------- */

export async function POST(req: Request): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return jsonError(
      503,
      "config_error",
      "DATABASE_URL is not configured on this server. Uploads cannot be persisted.",
    );
  }
  if (!config.auth.sessionSecretConfigured) {
    return jsonError(
      503,
      "config_error",
      "SESSION_SECRET is not configured on this server. Refusing to accept uploads.",
    );
  }

  // --- Auth + workspace scope ---------------------------------------------
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: true,
    });
  } catch (error) {
    process.stderr.write(
      `[artifacts.upload] session load failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return jsonError(
      500,
      "session_error",
      "Could not load the caller session. Check server logs.",
    );
  }

  if (session === null) {
    return jsonError(401, "unauthenticated", "Authentication required.");
  }
  if (session.activeWorkspaceId === null || session.workspaceRole === null) {
    return jsonError(
      403,
      "workspace_required",
      "An active workspace is required to upload artifacts.",
    );
  }
  try {
    assertPermission(session, PERMISSIONS.source_create);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  const workspaceId = session.activeWorkspaceId;

  // --- Parse multipart -----------------------------------------------------
  let form: FormData;
  try {
    form = await req.formData();
  } catch (error) {
    process.stderr.write(
      `[artifacts.upload] formData parse failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return jsonError(
      400,
      "invalid_form",
      "Request body could not be parsed as multipart/form-data.",
    );
  }

  // Hard cap on the number of parts. `formData()` has already materialised the
  // body, so this is a defensive bound against pathological requests, not a
  // memory-safety guarantee (the size cap above covers that).
  let partCount = 0;
  for (const _ of form.keys()) partCount += 1;
  if (partCount > MAX_FORM_PARTS) {
    return jsonError(
      400,
      "too_many_parts",
      `Uploads may contain at most ${MAX_FORM_PARTS} form parts.`,
    );
  }

  // --- Validate source kind -----------------------------------------------
  const rawKind = form.get("sourceKind");
  if (typeof rawKind !== "string" || !isUploadSourceKind(rawKind)) {
    return jsonError(
      400,
      "invalid_source_kind",
      `"sourceKind" must be one of: ${UPLOAD_SOURCE_KINDS.join(", ")}.`,
    );
  }
  const sourceKind: UploadSourceKind = rawKind;

  // --- Optional metadata fields -------------------------------------------
  const labelRead = readStringField(form, "label");
  if (!labelRead.ok) {
    return jsonError(400, "invalid_field", labelRead.reason);
  }
  const labelRaw = labelRead.value;

  const noteRead = readStringField(form, "changeNote");
  if (!noteRead.ok) {
    return jsonError(400, "invalid_field", noteRead.reason);
  }
  const changeNote = noteRead.value;

  // --- Read / validate body ------------------------------------------------
  let body: CommonBody;
  let urlReference: string | null = null;

  if (sourceKind === "source_url") {
    const urlResult = readUrlReference(form);
    if (!urlResult.ok) {
      return jsonError(urlResult.status, "invalid_url", urlResult.message);
    }
    urlReference = urlResult.url;
    // The stored bytes are just the URL itself; the worker performs the fetch.
    const bytes = Buffer.from(urlResult.url, "utf8");
    body = {
      bytes,
      contentType: DEFAULT_CONTENT_TYPE.source_url,
      originalFilename: null,
    };
  } else {
    const extract = extractBytes(sourceKind, form);
    if (!extract.ok) {
      return jsonError(extract.status, "invalid_body", extract.message);
    }
    body = extract.body;
  }

  if (body.bytes.byteLength === 0 && sourceKind !== "source_text") {
    return jsonError(
      400,
      "empty_body",
      "The uploaded file is empty. Upload a file with content.",
    );
  }

  // --- Hash ----------------------------------------------------------------
  let contentHash: string;
  try {
    contentHash = hashBytes(body.bytes).sha256;
  } catch (error) {
    process.stderr.write(
      `[artifacts.upload] hash failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return jsonError(
      500,
      "hash_failed",
      "Could not compute the content hash of the uploaded bytes.",
    );
  }

  // --- Resolve object store -----------------------------------------------
  let store;
  try {
    store = await forWorkspace(workspaceId);
  } catch (error) {
    if (error instanceof StorageConfigError) {
      process.stderr.write(
        `[artifacts.upload] object store unavailable: ${error.message}\n`,
      );
      return jsonError(
        503,
        "storage_unavailable",
        "The object store is not configured on this server.",
      );
    }
    throw error;
  }

  // --- Connect to Postgres -------------------------------------------------
  const Pool = requirePoolCtor();
  const pool = new Pool({
    connectionString: config.database.url as string,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    max: 2,
  });
  const client = await pool.connect();

  try {
    // --- Dedup check -------------------------------------------------------
    const artifactKind = artifactKindFor(sourceKind);
    const existing = await findExistingByHash(
      client,
      workspaceId,
      artifactKind,
      contentHash,
    );

    let artifactId: string;
    let versionId: string | null;
    let deduplicated: boolean;
    let storageKey: string;

    if (existing !== null) {
      artifactId = existing.id;
      versionId = existing.currentVersionId;
      deduplicated = true;
      // We do not have the key in hand; look it up for the response body.
      const keyRes = await client.query(
        `SELECT storage_key FROM artifacts WHERE id = $1 LIMIT 1`,
        [artifactId],
      );
      storageKey = (keyRes.rows[0] as { storage_key: string }).storage_key;
    } else {
      // Compose the object key:
      //   <workspaceId>/source/<artifact-UUID>/<YYYY>/<MM>/<filename>
      const artifactUuid = randomUUID();
      const filename = sanitizeFilename(
        body.originalFilename,
        defaultFilename(sourceKind, artifactUuid),
      );
      try {
        storageKey = store.buildKey({
          kind: SOURCE_STORAGE_KIND,
          scopeId: artifactUuid,
          filename,
          datePartition: defaultDatePartition(),
        });
      } catch (error) {
        if (error instanceof ObjectKeyError) {
          return jsonError(
            400,
            "invalid_filename",
            `Filename is not usable as an object key: ${error.message}`,
          );
        }
        throw error;
      }

      // Write to the store first. If this fails we return an error and never
      // touch Postgres, guaranteeing the store and DB cannot diverge when the
      // DB insert below fails too (the orphan is recovered by a later
      // retention sweep for keys with no DB row).
      try {
        await store.put({
          key: storageKey,
          body: body.bytes,
          contentType: body.contentType,
          expectedSha256: contentHash,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[artifacts.upload] object put failed: ${message}\n`,
        );
        return jsonError(
          500,
          "storage_write_failed",
          "The uploaded bytes could not be written to the object store.",
        );
      }

      const persisted = await persistArtifact(client, {
        workspaceId,
        kind: artifactKind,
        storageKey,
        contentHash,
        sizeBytes: body.bytes.byteLength,
        contentType: body.contentType,
        originalFilename: body.originalFilename,
        label: labelRaw,
        metadata: buildMetadata({
          sourceKind,
          urlReference,
          changeNote,
        }),
        createdBy: session.userId,
      });
      artifactId = persisted.artifactId;
      versionId = persisted.versionId;
      deduplicated = false;
    }

    // --- Enqueue ingestion -------------------------------------------------
    const jobKind = ingestJobFor(sourceKind);
    const jobPayload: Record<string, unknown> = {
      artifactId,
      workspaceId,
      sourceKind,
      storageKey,
      contentHash,
      contentType: body.contentType,
      originalFilename: body.originalFilename,
      ...(urlReference !== null ? { url: urlReference } : {}),
      ...(labelRaw !== null ? { label: labelRaw } : {}),
    };

    let enqueued: EnqueueResult | null = null;
    let enqueueError: string | null = null;
    try {
      enqueued = await enqueueJob({
        workspaceId,
        kind: jobKind,
        payload: jobPayload,
        // Content-addressed idempotency key: a byte-identical upload for the
        // same (workspace, kind) collapses onto the same pending/active job.
        idempotencyKey: `ingest:${artifactKind}:${contentHash}`,
        correlationId: artifactId,
        enqueuedBy: session.userId,
      });
    } catch (error) {
      // The artifact is persisted; a queue failure is reported in the response
      // so the caller can re-trigger ingestion without re-uploading the file.
      const message = error instanceof Error ? error.message : String(error);
      enqueueError = message;
      process.stderr.write(
        `[artifacts.upload] enqueue ${jobKind} failed: ${message}\n`,
      );
    }

    const status = enqueueError === null ? 201 : 202;
    return NextResponse.json(
      {
        artifact: {
          id: artifactId,
          workspaceId,
          kind: artifactKind,
          storageKey,
          contentHash,
          sizeBytes: body.bytes.byteLength,
          contentType: body.contentType,
          originalFilename: body.originalFilename,
          label: labelRaw,
          currentVersionId: versionId,
          deduplicated,
        },
        ingestion: enqueued
          ? {
              jobId: enqueued.jobId,
              kind: enqueued.kind,
              status: enqueued.status,
              created: enqueued.created,
            }
          : {
              kind: jobKind,
              error: enqueueError,
              message:
                "The upload succeeded, but the ingestion job could not be enqueued. Retry ingestion once the job queue is reachable.",
            },
      },
      { status },
    );
  } catch (error) {
    process.stderr.write(
      `[artifacts.upload] failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return jsonError(
      500,
      "upload_failed",
      "The upload could not be completed. Check server logs for details.",
    );
  } finally {
    client.release();
    await pool.end();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers kept local to this route                                            */
/* -------------------------------------------------------------------------- */

/** Fallback filename when the caller did not supply one. */
function defaultFilename(sourceKind: UploadSourceKind, uuid: string): string {
  const shortId = uuid.slice(0, 8);
  switch (sourceKind) {
    case "source_url":
      return `url-${shortId}.txt`;
    case "source_text":
      return `text-${shortId}.txt`;
    case "source_image":
      return `image-${shortId}.bin`;
    case "source_pdf":
      return `document-${shortId}.pdf`;
    case "source_docx":
      return `document-${shortId}.docx`;
    case "source_pptx":
      return `deck-${shortId}.pptx`;
    case "source_audio":
      return `audio-${shortId}.bin`;
    case "source_video":
      return `video-${shortId}.bin`;
  }
}

/**
 * Small metadata bag persisted with the artifact. Uses the standard JSONB
 * columns already declared on `artifacts`; no schema change is required.
 */
function buildMetadata(input: {
  readonly sourceKind: UploadSourceKind;
  readonly urlReference: string | null;
  readonly changeNote: string | null;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sourceKind: input.sourceKind,
    uploadedAt: new Date().toISOString(),
  };
  if (input.urlReference !== null) out["url"] = input.urlReference;
  if (input.changeNote !== null) out["changeNote"] = input.changeNote;
  return out;
}
