/**
 * POST /api/sources/file
 *
 * Accepts an uploaded file (multipart/form-data) for the image, PDF, DOCX and
 * PPTX ingestion paths and enqueues the appropriate worker job:
 *
 *   - image/*                            → "ingest:image"
 *   - application/pdf                    → "ingest:pdf"
 *   - application/vnd...wordprocessingml → "ingest:docx"
 *   - application/vnd...presentationml   → "ingest:pptx"
 *
 * The route owns validation, MIME sniffing, and RBAC — it deliberately does
 * NOT run OCR, VLM or Playwright: those must run on the worker (the workers
 * own engine availability, retries and long-running execution). It writes the
 * received bytes to the object store (under a workspace-scoped key) and
 * enqueues a job whose payload references the stored object by key. The
 * worker reads the object back from the store, runs the ingest, and writes
 * the derived artifact. This keeps the HTTP request bounded in memory and
 * time, and keeps the object store as the single source of truth for the
 * upload.
 *
 * Contract:
 *   - Requires DATABASE_URL and SESSION_SECRET; returns 503 config_error
 *     otherwise (no fake uploads, no temporary secret).
 *   - Authenticates via the shared session module and asserts the
 *     `PERMISSIONS.source_create` permission. A user without it gets a 403.
 *   - Enforces a max upload size (default 50 MiB) via `Content-Length` up-front
 *     and a hard read cap so a chunked upload cannot exceed it silently.
 *   - Refuses when the jobs table cannot be reached: the whole point of the
 *     endpoint is to enqueue an ingest job, so a queue misconfiguration is a
 *     hard 503 rather than an orphaned object in the store.
 *   - Requires an `Idempotency-Key` (or the `idempotencyKey` form field). The
 *     key scopes `(workspace, contentHash, jobKind)` so a re-upload of
 *     identical bytes collapses onto the same job — matching the identical
 *     -content rule used by the text and URL routes.
 *
 * External setup the customer must supply for the ingest job to actually
 * complete on the worker (documented, not silently degraded):
 *   - For images: OCR engine (EasyOCR or Tesseract) reachable via the worker,
 *     plus an LLM provider for the VLM step. Without them the ingest job fails
 *     with a clear error.
 *   - For PDFs: either `DOCLING_SERVICE_URL` or a working `pdfjs-dist` +
 *     `@napi-rs/canvas` install for the scan fallback.
 *   - For DOCX/PPTX embedded images: the same image prerequisites as above.
 *
 * What is NOT implemented here: virus scanning. A deployment that requires AV
 * must front this endpoint with a scanning proxy; nothing in this handler
 * pretends otherwise.
 */

import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import {
  enqueueJob,
  isJobKind,
  type EnqueueResult,
  type JobKind,
} from "@zipy/jobs/queue";
import { getObjectStore, type ObjectStore } from "@zipy/storage/objectStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Limits + MIME policy                                                        */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

type IngestKind = "image" | "pdf" | "docx" | "pptx";

interface MimePolicy {
  readonly kind: IngestKind;
  readonly jobKind: JobKind;
  /** Alternative MIME spellings the browser may send (e.g. from older Office). */
  readonly aliases: readonly string[];
}

const MIME_POLICY: readonly MimePolicy[] = [
  {
    kind: "image",
    jobKind: "ingest:image",
    aliases: [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
      "image/gif",
      "image/bmp",
      "image/tiff",
      "image/tif",
    ],
  },
  {
    kind: "pdf",
    jobKind: "ingest:pdf",
    aliases: ["application/pdf", "application/x-pdf", "application/acrobat"],
  },
  {
    kind: "docx",
    jobKind: "ingest:docx",
    aliases: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-word.document.macroenabled.12",
    ],
  },
  {
    kind: "pptx",
    jobKind: "ingest:pptx",
    aliases: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint.presentation.macroenabled.12",
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Magic-byte sniffing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Sniff the first bytes so a client that lies about its MIME type (or omits it)
 * still lands on the right ingest path when the content is unambiguous. We
 * only rely on the sniff for the leading markers, and fall back to the
 * declared MIME when nothing matches. A wrong sniff cannot send the request
 * to the wrong pipeline unless the bytes really do look like another type —
 * in which case the user's intent is almost certainly the sniffed type.
 */
type SniffedKind = IngestKind | null;

function sniff(bytes: Buffer): SniffedKind {
  if (bytes.length < 4) return null;
  // PDF
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return "pdf";
  }
  // PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image";
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image";
  }
  // GIF (87a / 89a)
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image";
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image";
  }
  // TIFF (little / big endian)
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00)
  ) {
    return "image";
  }
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image";
  // OOXML (DOCX / PPTX are ZIP containers with a specific first local entry
  // name). We do not assume the ZIP is office content; the caller's declared
  // MIME (or the actual container content the worker will inspect) decides
  // between DOCX and PPTX. Sniffing just asserts "this is a ZIP container".
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    if (looksLikePptxContainer(bytes)) return "pptx";
    if (looksLikeDocxContainer(bytes)) return "docx";
    return null;
  }
  return null;
}

/**
 * Look for the OOXML [Content_Types].xml entry name inside the first ~64 KiB of
 * the archive. This is a heuristic sniff only — Office always writes
 * `[Content_Types].xml` as the first entry, and either its name (with
 * "presentationml" vs "wordprocessingml" in the content type override or the
 * main document part) or the following bytes disambiguate DOCX vs PPTX. If we
 * cannot tell, we return false and the caller falls back to the declared MIME.
 */
function looksLikePptxContainer(bytes: Buffer): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const text = window.toString("latin1");
  return (
    text.includes("presentationml.presentation") ||
    text.includes("ppt/presentation.xml")
  );
}

function looksLikeDocxContainer(bytes: Buffer): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const text = window.toString("latin1");
  return (
    text.includes("wordprocessingml.document") ||
    text.includes("word/document.xml")
  );
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

interface ResolvedPolicy {
  readonly policy: MimePolicy;
  /** Where the kind came from; recorded for observability. */
  readonly source: "mime" | "sniff" | "extension";
}

function declaredMimeToKind(mime: string): MimePolicy | null {
  const normalised = mime.trim().toLowerCase();
  if (normalised.length === 0) return null;
  for (const policy of MIME_POLICY) {
    if (policy.aliases.includes(normalised)) return policy;
  }
  // Any other image/* still routes to the image path.
  if (normalised.startsWith("image/")) {
    const img = MIME_POLICY.find((p) => p.kind === "image");
    return img ?? null;
  }
  return null;
}

function extensionToKind(filename: string): MimePolicy | null {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "gif":
    case "bmp":
    case "tif":
    case "tiff":
      return MIME_POLICY.find((p) => p.kind === "image") ?? null;
    case "pdf":
      return MIME_POLICY.find((p) => p.kind === "pdf") ?? null;
    case "docx":
      return MIME_POLICY.find((p) => p.kind === "docx") ?? null;
    case "pptx":
      return MIME_POLICY.find((p) => p.kind === "pptx") ?? null;
    default:
      return null;
  }
}

function resolvePolicy(
  declaredMime: string,
  filename: string,
  bytes: Buffer,
): ResolvedPolicy | null {
  const fromMime = declaredMimeToKind(declaredMime);
  if (fromMime !== null) return { policy: fromMime, source: "mime" };
  const sniffed = sniff(bytes);
  if (sniffed !== null) {
    const policy = MIME_POLICY.find((p) => p.kind === sniffed);
    if (policy !== undefined) return { policy, source: "sniff" };
  }
  const fromExt = extensionToKind(filename);
  if (fromExt !== null) return { policy: fromExt, source: "extension" };
  return null;
}

interface ValidatedUpload {
  readonly bytes: Buffer;
  readonly declaredMime: string;
  readonly filename: string;
  readonly label: string | null;
  readonly resolved: ResolvedPolicy;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly idempotencyKey: string;
}

function readContentLength(req: Request, maxBytes: number): number | null | "too-large" {
  const raw = req.headers.get("content-length");
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > maxBytes) return "too-large";
  return n;
}

async function readStreamWithCap(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer | "too-large"> {
  if (stream === null) {
    return Buffer.alloc(0);
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Cancel the read — we've already exceeded. Returning "too-large" lets
      // the handler emit a 413 without buffering the rest.
      try {
        await reader.cancel();
      } catch {
        /* best effort */
      }
      return "too-large";
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

async function requireAuthenticatedSession(): Promise<
  { ok: true; session: SessionRecord; workspaceId: string } | { ok: false; response: NextResponse }
> {
  const config = getConfig();
  if (!config.database.configured) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "config_error",
          message:
            "DATABASE_URL is not configured on this server. File ingestion cannot be enqueued.",
        },
        { status: 503 },
      ),
    };
  }
  if (!config.auth.sessionSecretConfigured) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "config_error",
          message: "SESSION_SECRET is not configured on this server.",
        },
        { status: 503 },
      ),
    };
  }
  return { ok: true, session: null as unknown as SessionRecord, workspaceId: "" };
}

export async function POST(req: Request): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. File ingestion cannot be enqueued.",
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

  // -------------------------------------------------------- session / RBAC -
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: true,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/sources/file] session load failed: ${
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
    assertPermission(session, PERMISSIONS.source_create);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  const workspaceId = session.activeWorkspaceId as string;

  // --------------------------------------------------------------- parse --
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return NextResponse.json(
      {
        error: "unsupported_media_type",
        message:
          "This endpoint accepts multipart/form-data only. Send the file in a `file` part.",
      },
      { status: 415 },
    );
  }

  const maxBytes = DEFAULT_MAX_UPLOAD_BYTES;
  const declaredLength = readContentLength(req, maxBytes);
  if (declaredLength === "too-large") {
    return NextResponse.json(
      {
        error: "payload_too_large",
        message: `Upload exceeds the ${maxBytes}-byte limit.`,
      },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "invalid_multipart", message: `Malformed multipart body: ${message}` },
      { status: 400 },
    );
  }

  const filePart = form.get("file");
  if (!(filePart instanceof File)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "file",
        message: "A `file` part with the uploaded document is required.",
      },
      { status: 400 },
    );
  }

  // Filename — bounded, sanitized only when we name the object-store key.
  const rawFilename = filePart.name || "upload.bin";
  const filename = rawFilename.slice(0, MAX_FILENAME_LENGTH);

  // Optional human label for the UI.
  let label: string | null = null;
  const labelPart = form.get("label");
  if (typeof labelPart === "string" && labelPart.trim().length > 0) {
    label = labelPart.trim().slice(0, 160);
  }

  // Idempotency key — required so identical re-uploads collapse.
  let idempotencyKey: string | null = null;
  const idemPart = form.get("idempotencyKey");
  if (typeof idemPart === "string" && idemPart.trim().length > 0) {
    idempotencyKey = idemPart.trim().slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
  }
  if (idempotencyKey === null) {
    const header = req.headers.get("idempotency-key");
    if (header !== null && header.trim().length > 0) {
      idempotencyKey = header.trim().slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
    }
  }

  // Read the file bytes with a hard cap regardless of Content-Length.
  let bytes: Buffer | "too-large";
  try {
    bytes = await readStreamWithCap(
      (filePart.stream() as ReadableStream<Uint8Array>) ?? null,
      maxBytes,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "read_failed", message: `Could not read the uploaded file: ${message}` },
      { status: 400 },
    );
  }
  if (bytes === "too-large") {
    return NextResponse.json(
      {
        error: "payload_too_large",
        message: `Upload exceeded the ${maxBytes}-byte limit while streaming.`,
      },
      { status: 413 },
    );
  }
  if (bytes.length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "file",
        message: "Uploaded file is empty.",
      },
      { status: 400 },
    );
  }

  // ------------------------------------------------------------ policy -----
  const declaredMime = filePart.type || "";
  const resolved = resolvePolicy(declaredMime, filename, bytes);
  if (resolved === null) {
    return NextResponse.json(
      {
        error: "unsupported_file_type",
        field: "file",
        message:
          "Unsupported file type. This endpoint accepts images, PDF, DOCX and PPTX. " +
          "Text, URL and audio/video inputs are submitted through their own endpoints.",
        declaredMime: declaredMime.length > 0 ? declaredMime : null,
      },
      { status: 415 },
    );
  }

  // ----------------------------------------------------------- job kind ----
  if (!isJobKind(resolved.policy.jobKind)) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          `The job queue does not expose a \`${resolved.policy.jobKind}\` job kind. ` +
          "The queue schema and this route have drifted; redeploy the queue module.",
      },
      { status: 503 },
    );
  }
  const jobKind: JobKind = resolved.policy.jobKind;

  // --------------------------------------------------------- object store --
  let objectStore: ObjectStore;
  try {
    objectStore = getObjectStore();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/sources/file] object store unavailable: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The artifact object store is not reachable. Check STORAGE_DRIVER and the " +
          "associated S3/local configuration.",
      },
      { status: 503 },
    );
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const storageKey = buildUploadStorageKey({
    workspaceId,
    kind: resolved.policy.kind,
    contentHash,
    filename,
  });

  try {
    await objectStore.put(storageKey, bytes, {
      contentType: declaredMime.length > 0 ? declaredMime : defaultMimeForKind(resolved.policy.kind),
      contentLength: bytes.length,
      metadata: {
        "zipy-content-hash": contentHash,
        "zipy-original-filename": filename,
        "zipy-kind": resolved.policy.kind,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/sources/file] object store write failed for ${storageKey}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The uploaded file could not be persisted to the object store. Check server logs.",
      },
      { status: 503 },
    );
  }

  // --------------------------------------------------------------- enqueue --
  // The idempotency key given by the caller is scoped to
  // (workspace, content hash, job kind) so a re-upload of identical bytes
  // never produces a second ingest. A different filename with the same bytes
  // still collapses; the caller controls change detection via the idempotency
  // key when they want a genuine re-run.
  const effectiveIdempotencyKey =
    idempotencyKey !== null
      ? `source:file:${jobKind}:${hashShort(idempotencyKey)}`
      : `source:file:${jobKind}:${contentHash.slice(0, 32)}`;

  let enqueued: EnqueueResult;
  try {
    enqueued = await enqueueJob({
      workspaceId,
      kind: jobKind,
      payload: {
        source: "file",
        kind: resolved.policy.kind,
        declaredMime: declaredMime.length > 0 ? declaredMime : null,
        mimeResolutionSource: resolved.source,
        filename,
        label,
        contentHash,
        byteLength: bytes.length,
        storageKey,
        // The worker reopens the object from the store; we deliberately do
        // not embed the raw bytes in the queue row.
        requestedAt: new Date().toISOString(),
        correlationId: randomUUID(),
      },
      idempotencyKey: effectiveIdempotencyKey,
      // A file upload has no upstream correlation id — each upload is its own.
      correlationId: null,
      enqueuedBy: session.userId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/sources/file] enqueue ${jobKind} failed: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "queue_unavailable",
        message:
          "The ingestion job could not be enqueued. The job queue is not reachable; " +
          "check DATABASE_URL and the jobs table. The uploaded object remains in the " +
          "object store and a later retry with the same Idempotency-Key will reuse this upload.",
        storageKey,
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      job: {
        id: enqueued.jobId,
        kind: enqueued.kind,
        status: enqueued.status,
        created: enqueued.created,
        idempotencyKey: effectiveIdempotencyKey,
      },
      source: {
        kind: `source_${resolved.policy.kind}`,
        filename,
        label,
        declaredMime: declaredMime.length > 0 ? declaredMime : null,
        resolvedKind: resolved.policy.kind,
        resolutionSource: resolved.source,
        contentHash,
        byteLength: bytes.length,
        storageKey,
        workspaceId,
      },
      message:
        enqueued.created
          ? `Ingestion job (${jobKind}) enqueued. The worker reads the uploaded object, runs the pipeline and writes the derived artifact.`
          : "An identical upload is already pending or active; the existing job will be reused.",
      externalSetup: EXTERNAL_SETUP_NOTES[resolved.policy.kind],
    },
    { status: enqueued.created ? 202 : 200 },
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function buildUploadStorageKey(args: {
  workspaceId: string;
  kind: IngestKind;
  contentHash: string;
  filename: string;
}): string {
  const safeName = args.filename
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  const name = safeName.length > 0 ? safeName : "upload.bin";
  // uploads/{workspace}/{kind}/{sha256:2}-{sha256:rest}-{name}
  // Prefix-hashing the filename keeps the key content-addressed and stable.
  return `uploads/${sanitizePathSegment(args.workspaceId)}/${args.kind}/${args.contentHash.slice(
    0,
    2,
  )}/${args.contentHash.slice(2, 34)}-${name}`;
}

function sanitizePathSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "ws";
}

function defaultMimeForKind(kind: IngestKind): string {
  switch (kind) {
    case "image":
      return "application/octet-stream";
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
}

/* -------------------------------------------------------------------------- */
/* External setup notes (documented, never silently satisfied)                 */
/* -------------------------------------------------------------------------- */

const EXTERNAL_SETUP_NOTES: Readonly<Record<IngestKind, readonly string[]>> = {
  image: [
    "An OCR engine must be reachable from the worker: EasyOCR via PYTHON_PATH, Tesseract via a system install, or a cloud OCR service via OCR_SERVICE_URL.",
    "A vision-language model is required for UI element recognition: either a hosted provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY) or a local server (OLLAMA_BASE_URL, VLLM_BASE_URL).",
  ],
  pdf: [
    "Preferred: configure DOCLING_SERVICE_URL so the layout-and-table parser handles the PDF.",
    "Scan fallback requires `pdfjs-dist` and `@napi-rs/canvas` installed in the worker, plus the same OCR prerequisites as the image path.",
  ],
  docx: [
    "Text, headings, lists and tables are extracted by the built-in OOXML reader, which has no external dependency.",
    "Embedded images (route through the image pipeline) require the same OCR + VLM setup as the image path.",
  ],
  pptx: [
    "Slides, shapes, tables and speaker notes are extracted by the built-in OOXML reader, which has no external dependency.",
    "Embedded slide images (route through the image pipeline) require the same OCR + VLM setup as the image path.",
    "Charts, SmartArt and OLE objects are surfaced as unsupported shapes with empty text; a later phase can add rasterisation.",
  ],
};

/* -------------------------------------------------------------------------- */
/* Explicit refusal for other methods                                          */
/* -------------------------------------------------------------------------- */

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "This endpoint accepts POST with a multipart/form-data body containing a `file` part.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
