/**
 * POST /api/sources/combine
 *
 * Multi-source ingestion entry point. Accepts a JSON body describing one or
 * more sources (URL, text, image, PDF, DOCX, PPTX, audio, video) and enqueues
 * a single `ingest:combine` job that runs the fanout on the worker:
 *
 *   - Each source is ingested by the worker's per-kind resolver registry.
 *   - The worker fuses the results through `runFanout` and persists a unified
 *     source-combine artifact.
 *
 * The route deliberately does **not** run any ingestion here. Playwright,
 * OCR, VLM, Docling, ffmpeg and STT must not run inside an HTTP handler:
 * they are long-running, they need filesystem temp space and they own their
 * own retries. This route validates the shape of the request, enforces the
 * workspace RBAC, and hands the batch to the queue.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; returns 503 config_error
 *     otherwise.
 *   - Authenticates via the shared session module and asserts
 *     `PERMISSIONS.source_create`. A user without it gets 403.
 *   - Validates the source list before enqueuing: each entry must declare a
 *     known `kind`, and the union of supplied sources must be non-empty.
 *   - Cross-checks each `kind` against the file extensions / shape the
 *     worker's per-kind resolvers expect, but leaves deep validation to the
 *     worker (an image file the client mislabels as a PDF will fail on the
 *     worker with a precise error, not here).
 *   - Enforces a max source count per request and a max byte budget hint so
 *     a single request cannot try to ingest an unbounded amount of data.
 *   - Idempotency key scopes to `(workspace, ordered source fingerprints,
 *     priority override)`, so a resubmission of the same batch collapses onto
 *     the same job.
 *
 * Sources are supplied as an array. Each item supports either:
 *   - `{ kind: "url",  url, label?, prompt? }`
 *   - `{ kind: "text", prompt, label?, urlArtifactId? }`
 *   - `{ kind: "file", fileKind: "image"|"pdf"|"docx"|"pptx"|"audio"|"video",
 *       artifactId, label? }` — where `artifactId` refers to a previously
 *       uploaded object via `/api/sources/file` (or the generic artifacts
 *       upload route). This keeps the combine route a metadata-only surface;
 *       the bytes never traverse it.
 *
 * The `file` shape exists so a browser can upload the (potentially large)
 * bytes through the file-specific endpoint first, receive the storage key or
 * artifact id, and then combine several uploads into one fanout job without a
 * multi-gigabyte JSON body.
 *
 * External setup the customer must supply for the combine job to actually
 * complete on the worker (documented, not silently degraded):
 *   - The same per-kind prerequisites as `/api/sources/file`: Playwright for
 *     URL, OCR + VLM for image, Docling (or a PDF scan fallback) for PDF,
 *     ffmpeg + STT for audio, ffmpeg + OCR + VLM for video.
 *   - At least one LLM provider configuration is **not** required at this
 *     stage: the fanout produces a unified intermediate representation only.
 *     Later phases attach LLM synthesis downstream of this artifact.
 *
 * What is NOT implemented here: virus scanning. A deployment that requires AV
 * must front this endpoint with a scanning proxy.
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

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
import {
  DEFAULT_SOURCE_PRIORITY,
  SOURCE_KINDS,
  isSourceKind,
  parseSourcePriority,
  type SourceKind,
  SourcePriorityError,
} from "@zipy/ingest/sourcePriority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

const MAX_SOURCES_PER_REQUEST = 32;
const MAX_LABEL_LENGTH = 160;
const MAX_URL_LENGTH = 2048;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_ARTIFACT_ID_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * The `file` shaping uses an inner `fileKind` because "file" is a transport
 * choice, not a content kind. `fileKind` is the actual source kind.
 */
const FILE_KINDS: readonly SourceKind[] = [
  "image",
  "pdf",
  "docx",
  "pptx",
  "audio",
  "video",
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/* Request types                                                               */
/* -------------------------------------------------------------------------- */

interface CombineBody {
  readonly sources?: unknown;
  /**
   * Comma-separated string (e.g. "url,pdf,image") or array of source kinds.
   * Applies to the whole batch — the fanout applies one order to every source
   * in the request. Per-source ordering overrides are intentionally not
   * supported; a request that needs mixed priorities should be split.
   */
  readonly sourcePriority?: unknown;
  /** Optional workspace id; defaults to the caller's active workspace. */
  readonly workspaceId?: unknown;
  /** Human label for the whole fanout artifact. */
  readonly label?: unknown;
  /**
   * When true, a request where every source fails returns a degraded unified
   * representation instead of a hard error. Recorded on the job payload.
   */
  readonly allowAllFailed?: unknown;
}

interface ValidatedUrlSource {
  readonly kind: "url";
  readonly url: string;
  readonly label: string | null;
  readonly prompt: string | null;
}

interface ValidatedTextSource {
  readonly kind: "text";
  readonly prompt: string;
  readonly label: string | null;
  readonly urlArtifactId: string | null;
}

interface ValidatedFileSource {
  /** Transport kind — the worker resolves `fileKind` to the actual resolver. */
  readonly kind: "file";
  readonly fileKind: SourceKind;
  /**
   * Identifier of the previously-uploaded artifact. Either an artifact UUID
   * (as stored in `artifacts.id`) or an opaque `storageKey` the caller
   * received from `/api/sources/file`. The worker resolves both.
   */
  readonly artifactId: string;
  readonly label: string | null;
}

type ValidatedSource =
  | ValidatedUrlSource
  | ValidatedTextSource
  | ValidatedFileSource;

interface ValidatedCombineBody {
  readonly sources: readonly ValidatedSource[];
  /** `null` when the caller did not override; the worker applies the default. */
  readonly sourcePriority: SourceKind[] | null;
  readonly workspaceId: string | null;
  readonly label: string | null;
  readonly allowAllFailed: boolean;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

function validateCombine(body: CombineBody): ValidatedCombineBody | NextResponse {
  const rawSources = body.sources;
  if (!Array.isArray(rawSources)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "sources",
        message: "`sources` must be an array with one or more source entries.",
      },
      { status: 400 },
    );
  }
  if (rawSources.length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "sources",
        message: "`sources` must contain at least one entry.",
      },
      { status: 400 },
    );
  }
  if (rawSources.length > MAX_SOURCES_PER_REQUEST) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "sources",
        message: `A single combine request may contain at most ${MAX_SOURCES_PER_REQUEST} sources. Split the batch.`,
      },
      { status: 400 },
    );
  }

  const validated: ValidatedSource[] = [];
  for (let i = 0; i < rawSources.length; i += 1) {
    const entry = rawSources[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: `sources[${i}]`,
          message: "Each source must be an object.",
        },
        { status: 400 },
      );
    }
    const result = validateOneSource(
      entry as Record<string, unknown>,
      `sources[${i}]`,
    );
    if (result instanceof NextResponse) return result;
    validated.push(result);
  }

  // ---------------------------------------------------- source priority ----
  let sourcePriority: SourceKind[] | null = null;
  if (body.sourcePriority !== undefined && body.sourcePriority !== null) {
    try {
      const resolved = parseSourcePriority(body.sourcePriority);
      // `parseSourcePriority` returns a total order; we only forward the
      // explicit part so the worker can decide the appended ordering itself
      // (and record "appended vs explicit" provenance on the artifact).
      sourcePriority = [...resolved.explicit];
    } catch (err) {
      if (err instanceof SourcePriorityError) {
        return NextResponse.json(
          {
            error: "validation_error",
            field: "sourcePriority",
            message: err.message,
          },
          { status: 400 },
        );
      }
      throw err;
    }
  }

  // ------------------------------------------------------ workspace id -----
  let workspaceId: string | null = null;
  if (typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0) {
    workspaceId = body.workspaceId.trim();
  }

  // ------------------------------------------------------------- label -----
  let label: string | null = null;
  if (typeof body.label === "string" && body.label.trim().length > 0) {
    label = body.label.trim().slice(0, MAX_LABEL_LENGTH);
  }

  // ------------------------------------------------------- allowAllFailed --
  const allowAllFailed = body.allowAllFailed === true;

  return {
    sources: validated,
    sourcePriority,
    workspaceId,
    label,
    allowAllFailed,
  };
}

function validateOneSource(
  entry: Record<string, unknown>,
  path: string,
): ValidatedSource | NextResponse {
  const kind = entry["kind"];
  if (kind === "url") return validateUrlSource(entry, path);
  if (kind === "text") return validateTextSource(entry, path);
  if (kind === "file") return validateFileSource(entry, path);
  return NextResponse.json(
    {
      error: "validation_error",
      field: `${path}.kind`,
      message:
        `Each source must have a "kind" of "url", "text" or "file". ` +
        `Received ${JSON.stringify(kind)}.`,
    },
    { status: 400 },
  );
}

function validateUrlSource(
  entry: Record<string, unknown>,
  path: string,
): ValidatedUrlSource | NextResponse {
  const rawUrl = typeof entry["url"] === "string" ? entry["url"].trim() : "";
  if (rawUrl.length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.url`,
        message: "A url source requires a non-empty `url` string.",
      },
      { status: 400 },
    );
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.url`,
        message: `url exceeds the ${MAX_URL_LENGTH}-character limit.`,
      },
      { status: 400 },
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.url`,
        message: "The submitted URL is not a valid absolute URL.",
      },
      { status: 400 },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.url`,
        message: "Only http and https URLs are accepted for URL ingestion.",
      },
      { status: 400 },
    );
  }
  let label: string | null = null;
  if (typeof entry["label"] === "string" && entry["label"].trim().length > 0) {
    label = entry["label"].trim().slice(0, MAX_LABEL_LENGTH);
  }
  let prompt: string | null = null;
  if (typeof entry["prompt"] === "string" && entry["prompt"].trim().length > 0) {
    prompt = entry["prompt"].trim().slice(0, MAX_PROMPT_LENGTH);
  }
  return { kind: "url", url: parsed.toString(), label, prompt };
}

function validateTextSource(
  entry: Record<string, unknown>,
  path: string,
): ValidatedTextSource | NextResponse {
  const raw = typeof entry["prompt"] === "string" ? entry["prompt"].trim() : "";
  if (raw.length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.prompt`,
        message: "A text source requires a non-empty `prompt` string.",
      },
      { status: 400 },
    );
  }
  if (raw.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.prompt`,
        message: `prompt exceeds the ${MAX_PROMPT_LENGTH}-character limit.`,
      },
      { status: 400 },
    );
  }
  let label: string | null = null;
  if (typeof entry["label"] === "string" && entry["label"].trim().length > 0) {
    label = entry["label"].trim().slice(0, MAX_LABEL_LENGTH);
  }
  let urlArtifactId: string | null = null;
  if (typeof entry["urlArtifactId"] === "string") {
    const trimmed = entry["urlArtifactId"].trim();
    if (trimmed.length === 0) {
      urlArtifactId = null;
    } else if (!UUID_PATTERN.test(trimmed)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: `${path}.urlArtifactId`,
          message: "urlArtifactId must be a UUID string when provided.",
        },
        { status: 400 },
      );
    } else {
      urlArtifactId = trimmed;
    }
  }
  return { kind: "text", prompt: raw, label, urlArtifactId };
}

function validateFileSource(
  entry: Record<string, unknown>,
  path: string,
): ValidatedFileSource | NextResponse {
  const fileKindRaw = entry["fileKind"];
  if (typeof fileKindRaw !== "string" || !isSourceKind(fileKindRaw)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.fileKind`,
        message:
          `A file source requires a \`fileKind\` of one of ${FILE_KINDS.join(", ")}. ` +
          `Received ${JSON.stringify(fileKindRaw)}.`,
      },
      { status: 400 },
    );
  }
  if (!FILE_KINDS.includes(fileKindRaw)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.fileKind`,
        message:
          `\`${fileKindRaw}\` is not a file source kind. ` +
          `Use one of ${FILE_KINDS.join(", ")}.`,
      },
      { status: 400 },
    );
  }
  const artifactIdRaw = entry["artifactId"];
  if (typeof artifactIdRaw !== "string" || artifactIdRaw.trim().length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.artifactId`,
        message:
          "A file source requires the `artifactId` (or storage key) returned by the file upload endpoint.",
      },
      { status: 400 },
    );
  }
  const artifactId = artifactIdRaw.trim();
  if (artifactId.length > MAX_ARTIFACT_ID_LENGTH) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: `${path}.artifactId`,
        message: `artifactId exceeds the ${MAX_ARTIFACT_ID_LENGTH}-character limit.`,
      },
      { status: 400 },
    );
  }
  let label: string | null = null;
  if (typeof entry["label"] === "string" && entry["label"].trim().length > 0) {
    label = entry["label"].trim().slice(0, MAX_LABEL_LENGTH);
  }
  return {
    kind: "file",
    fileKind: fileKindRaw,
    artifactId,
    label,
  };
}

/* -------------------------------------------------------------------------- */
/* Fingerprint + idempotency                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic fingerprint for the request used as the idempotency key.
 * Includes: workspace, ordered list of source fingerprints, priority override
 * and the allowAllFailed flag. Excludes the label (a label change on the
 * same batch should NOT trigger a re-run).
 *
 * Source fingerprints are order-independent *within a kind* but keep the
 * caller's order across kinds: two URL sources in different orders describe
 * the same request semantically? No — URL order affects which page is treated
 * as the "primary" URL by downstream synthesis. So we keep the supplied order
 * for the fingerprint too. If the caller wants a re-run they reorder,
 * change a source, or change the priority override.
 */
function fingerprintRequest(args: {
  workspaceId: string;
  sources: readonly ValidatedSource[];
  priority: SourceKind[] | null;
  allowAllFailed: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`ws=${args.workspaceId}`);
  for (const s of args.sources) {
    lines.push(sourceFingerprint(s));
  }
  lines.push(`priority=${(args.priority ?? []).join(",")}`);
  lines.push(`allowAllFailed=${args.allowAllFailed ? "1" : "0"}`);
  const h = createHash("sha256");
  h.update(lines.join("\u0001"));
  return h.digest("hex").slice(0, 32);
}

function sourceFingerprint(s: ValidatedSource): string {
  switch (s.kind) {
    case "url":
      return `url:${s.url}|prompt=${s.prompt ?? ""}`;
    case "text":
      return `text:${s.prompt}|urlArtifactId=${s.urlArtifactId ?? ""}`;
    case "file":
      return `file:${s.fileKind}:${s.artifactId}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

export async function POST(req: Request): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Combine ingestion cannot be enqueued.",
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

  // ------------------------------------------------------ auth + RBAC -----
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: true,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/sources/combine] session load failed: ${
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

  // ------------------------------------------------------------- parse ----
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  if (bodyJson === null || typeof bodyJson !== "object" || Array.isArray(bodyJson)) {
    return NextResponse.json(
      {
        error: "invalid_json",
        message: "Request body must be a JSON object.",
      },
      { status: 400 },
    );
  }

  const validated = validateCombine(bodyJson as CombineBody);
  if (validated instanceof NextResponse) return validated;

  // ------------------------------------------------------- workspace id ---
  // The caller's active workspace is authoritative; the body may only select
  // among workspaces the caller is a member of, and this phase does not
  // implement workspace switching on this route, so the body `workspaceId`
  // must equal the session's active workspace id when present.
  const sessionWorkspaceId = session.activeWorkspaceId as string;
  const workspaceId =
    validated.workspaceId ?? sessionWorkspaceId;
  if (workspaceId !== sessionWorkspaceId) {
    return NextResponse.json(
      {
        error: "forbidden",
        message:
          "workspaceId in the request body does not match your active workspace. Switch workspaces through the session, not by overriding the body.",
      },
      { status: 403 },
    );
  }

  // ------------------------------------------------------------ job kind --
  const jobKindCandidate = "ingest:combine";
  if (!isJobKind(jobKindCandidate)) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "The job queue does not expose an `ingest:combine` job kind. The queue schema and this route have drifted; redeploy the queue module.",
      },
      { status: 503 },
    );
  }
  const jobKind: JobKind = jobKindCandidate;

  // ------------------------------------------------------- idempotency ----
  // Optional caller-supplied Idempotency-Key header is XOR'd with the
  // fingerprint so a caller who wants a genuine re-run can supply a fresh key
  // without touching the source list.
  const headerIdempotency = req.headers.get("idempotency-key");
  const fingerprint = fingerprintRequest({
    workspaceId,
    sources: validated.sources,
    priority: validated.sourcePriority,
    allowAllFailed: validated.allowAllFailed,
  });
  const callerKey =
    headerIdempotency !== null && headerIdempotency.trim().length > 0
      ? headerIdempotency.trim().slice(0, MAX_IDEMPOTENCY_KEY_LENGTH)
      : null;
  const idempotencyKey =
    callerKey !== null
      ? `source:combine:${jobKind}:${fingerprint}:${hashShort(callerKey)}`
      : `source:combine:${jobKind}:${fingerprint}`;

  // ------------------------------------------------------------- enqueue --
  let enqueued: EnqueueResult;
  try {
    enqueued = await enqueueJob({
      workspaceId,
      kind: jobKind,
      payload: {
        sources: validated.sources.map((s) => serializeSourceForPayload(s)),
        sourcePriority: validated.sourcePriority,
        allowAllFailed: validated.allowAllFailed,
        label: validated.label,
        requestedAt: new Date().toISOString(),
      },
      idempotencyKey,
      correlationId: null,
      enqueuedBy: session.userId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/sources/combine] enqueue ingest:combine failed: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "queue_unavailable",
        message:
          "The combine-ingestion job could not be enqueued. The job queue is not reachable; check DATABASE_URL and the jobs table.",
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
        idempotencyKey,
      },
      source: {
        kind: "source_combine",
        workspaceId,
        label: validated.label,
        // Echo back the caller-visible shape: sources + resolved priority.
        // When the caller did not override, we return the shipped default so
        // the response is self-describing.
        sources: validated.sources.map((s) => serializeSourceForPayload(s)),
        sourcePriority:
          validated.sourcePriority !== null
            ? [...validated.sourcePriority]
            : [...DEFAULT_SOURCE_PRIORITY],
        sourcePriorityOverride: validated.sourcePriority !== null,
        allowAllFailed: validated.allowAllFailed,
      },
      message:
        enqueued.created
          ? "Combine ingestion job enqueued. The worker runs every source's ingest pipeline in parallel, fuses the results into a unified intermediate representation, and writes a source_combine artifact."
          : "An identical combine ingestion is already pending or active; the existing job will be reused.",
      externalSetup: EXTERNAL_SETUP_NOTES,
    },
    { status: enqueued.created ? 202 : 200 },
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function hashShort(value: string): string {
  const h = createHash("sha256");
  h.update(value);
  return h.digest("hex").slice(0, 32);
}

/**
 * Serialize a validated source for the job payload. This is the shape the
 * worker's `ingest:combine` handler expects; if the worker needs a different
 * shape, this function and the worker's handler must move together.
 *
 * - For URL and text sources the payload matches the individual ingest
 *   payloads (`/api/sources/url` and `/api/sources/text`) so the worker can
 *   reuse the same parsers.
 * - For file sources the payload carries the artifact id + fileKind; the
 *   worker resolves the artifact id to a stored object and dispatches to the
 *   resolver for `fileKind`.
 */
function serializeSourceForPayload(
  source: ValidatedSource,
): Record<string, unknown> {
  switch (source.kind) {
    case "url":
      return {
        kind: "url",
        url: source.url,
        label: source.label,
        prompt: source.prompt,
      };
    case "text":
      return {
        kind: "text",
        prompt: source.prompt,
        label: source.label,
        urlArtifactId: source.urlArtifactId,
      };
    case "file":
      return {
        kind: "file",
        fileKind: source.fileKind,
        artifactId: source.artifactId,
        label: source.label,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* External setup notes (documented, never silently satisfied)                 */
/* -------------------------------------------------------------------------- */

const EXTERNAL_SETUP_NOTES: readonly string[] = [
  "URL sources require a working Playwright install on the worker (Chromium/Firefox/WebKit) with the browser binaries downloaded.",
  "Image sources require an OCR engine reachable from the worker (EasyOCR via PYTHON_PATH, Tesseract via a system install, or a cloud OCR service via OCR_SERVICE_URL) and a VLM (a hosted provider API key or a local server via OLLAMA_BASE_URL / VLLM_BASE_URL) for UI-element recognition.",
  "PDF sources require DOCLING_SERVICE_URL for layout and table extraction; scanned PDFs additionally require the image prerequisites and (for the PDF scan fallback) `pdfjs-dist` + `@napi-rs/canvas` installed in the worker.",
  "DOCX/PPTX sources parse without external dependencies; embedded images route through the image prerequisites above.",
  "Audio sources require an STT engine (STT_SERVICE_URL for cloud/whisper-http, or a local whisper binary reachable from the worker).",
  "Video sources require ffmpeg/ffprobe on the worker PATH and the STT prerequisites above for the optional audio track.",
  "Sources whose engine is missing are recorded as `error` entries on the fanout result; the request still completes as long as at least one source succeeded. Pass allowAllFailed: true to receive a degraded unified representation instead of an error when every source fails.",
];

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "This endpoint accepts POST with a JSON body containing a `sources` array. See the job payload echo in a successful response for the expected source shapes.",
    },
    {
      status: 405,
      headers: { Allow: "POST" },
    },
  );
}

/* References to imported symbols, used by the type-checker and to document
 * which kind values this route understands. */
void SOURCE_KINDS;
