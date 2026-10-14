/**
 * GET /api/guides/[id]/export?format=pdf|html|markdown|docx|imagepack
 *
 * Produces a downloadable artefact for a guide. The route is a thin dispatcher
 * over `@workspace/zipy/export`/index's renderers, plus the persistence/authorization
 * plumbing that every other guide-scoped route in this codebase uses.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; returns 503 config_error
 *     otherwise.
 *   - Authenticates via `loadSession` and asserts `PERMISSIONS.guide_read`.
 *     A caller without it gets 403 via `toAuthzFailure`.
 *   - `[id]` is the guide UUID.
 *   - `format` is required (query parameter). Unknown formats get a 400 that
 *     enumerates the supported set.
 *   - The guide record and the guide's *current draft* are read from the
 *     workspace-scoped object store. The draft is composed by
 *     `/api/guides/[id]/generate`; this route does not re-run the content
 *     pipeline.
 *   - On success, the route responds with the requested binary via the
 *     platform `Response` (Content-Type, Content-Disposition, Content-Length).
 *
 * The route does NOT:
 *   - Invent guide content when no draft is present. A 409 is returned with a
 *     clear message to run generation first.
 *   - Touch a running Playwright session or re-capture screenshots.
 *   - Serve signed URLs for a shared object store; it streams bytes through
 *     this handler so the request is subject to the same auth as the rest of
 *     the API.
 *
 * Image resolution:
 *   - Renderers receive an already-resolved `GuideDocument` plus an
 *     `imageResolver` that fetches bytes from the workspace-scoped store on
 *     demand. The dispatcher supplies that resolver; the renderer decides
 *     which images it needs.
 *
 * External setup: none for this route.
 */

import { HttpResponse } from "@/lib/http-response";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@workspace/zipy/web/rbac/permissions";
import { loadSession, type SessionRecord } from "@workspace/zipy/web/auth/session";
import { getConfig } from "@workspace/zipy/web/config";
import { forWorkspace } from "@workspace/zipy/storage/routeStore";

import { renderGuidePdf, renderGuideHtml, renderGuideMarkdown, type GuideDocument, type PdfExportOptions, type HtmlExportOptions, type MarkdownExportOptions } from "@workspace/zipy/export/index";
import { renderGuideDocx } from "@workspace/zipy/export/docx";
import { renderGuideImagePack } from "@workspace/zipy/export/imagePack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GUIDES_PREFIX = "guides";

const SUPPORTED_FORMATS = [
  "pdf",
  "html",
  "markdown",
  "docx",
  "imagepack",
] as const;

type ExportFormat = (typeof SUPPORTED_FORMATS)[number];

const FORMAT_CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  imagepack: "application/zip",
};

/* -------------------------------------------------------------------------- */
/* Storage helpers                                                             */
/* -------------------------------------------------------------------------- */

type StoreLike = {
  readonly get: (key: string) => Promise<Buffer | null>;
};

function guideRecordKey(guideId: string): string {
  return `${GUIDES_PREFIX}/${guideId}.json`;
}

function currentDraftKey(guideId: string): string {
  return `${GUIDES_PREFIX}/${guideId}/draft-current.json`;
}

async function readJsonOrNull(
  store: StoreLike,
  key: string,
): Promise<unknown | null> {
  let bytes: Buffer | null;
  try {
    bytes = await store.get(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(message)) return null;
    throw error;
  }
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Stored artifact ${key} is not valid JSON.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Draft → GuideDocument adaptation                                            */
/* -------------------------------------------------------------------------- */

interface DraftShape {
  readonly title?: unknown;
  readonly summary?: unknown;
  readonly introduction?: unknown;
  readonly prerequisites?: unknown;
  readonly steps?: unknown;
  readonly tips?: unknown;
  readonly warnings?: unknown;
  readonly faq?: unknown;
  readonly glossary?: unknown;
  readonly aiGenerated?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Convert a draft produced by `@workspace/zipy/content/pipeline` into a
 * `GuideDocument` consumable by the export renderers. The draft is the
 * pipeline's `GuideContentDraft`; its exact field set is owned by that
 * module. This adapter reads only the fields the renderers need and
 * preserves unknown fields on the section blocks' extras — so a later draft
 * field can be surfaced in the export without re-touching this route.
 *
 * If a field is missing in the draft, it is simply omitted from the
 * document; the renderer already tolerates optional fields.
 */
function adaptDraftToGuideDocument(
  draft: DraftShape,
  guideId: string,
  workspaceId: string,
): GuideDocument {
  const title =
    typeof draft.title === "string" && draft.title.length > 0
      ? draft.title
      : "Untitled guide";

  const sections: { heading: string; blocks: GuideDocument["blocks"][number][] }[] = [];

  const introText = collectParagraphs([
    draft.summary,
    draft.introduction,
  ]);
  if (introText.length > 0) {
    sections.push({
      heading: "Introduction",
      blocks: introText.map((t, i) => ({ kind: "paragraph" as const, id: `intro-${i}`, text: t })),
    });
  }

  const prereqItems = toParagraphList(draft.prerequisites);
  if (prereqItems.length > 0) {
    sections.push({
      heading: "Prerequisites",
      blocks: [
        {
          kind: "checklist" as const,
          id: "prerequisites",
          items: prereqItems,
        },
      ],
    });
  }

  const stepList = toStepList(draft.steps);
  if (stepList.length > 0) {
    sections.push({
      heading: "Steps",
      blocks: [...stepList],
    });
  }

  const tips = toParagraphList(draft.tips);
  const warnings = toParagraphList(draft.warnings);
  if (tips.length > 0 || warnings.length > 0) {
    const blocks: GuideDocument["blocks"][number][] = [];
    for (const t of tips) {
      blocks.push({ kind: "callout", id: `tip-${blocks.length}`, severity: "tip", text: t });
    }
    for (const w of warnings) {
      blocks.push({ kind: "callout", id: `warning-${blocks.length}`, severity: "warning", text: w });
    }
    sections.push({ heading: "Tips and warnings", blocks });
  }

  const faqPairs = toFaqPairs(draft.faq);
  if (faqPairs.length > 0) {
    sections.push({
      heading: "FAQ",
      blocks: faqPairs.flatMap((pair, i) => [
        { kind: "section" as const, id: `faq-question-${i}`, title: pair.question },
        { kind: "paragraph" as const, id: `faq-answer-${i}`, text: pair.answer },
      ]),
    });
  }

  const glossaryRows = toGlossaryRows(draft.glossary);
  if (glossaryRows.length > 0) {
    sections.push({
      heading: "Glossary",
      blocks: [
        {
          kind: "table" as const,
          id: "glossary",
          columns: ["Term", "Definition"],
          rows: glossaryRows.map((r) => [r.term, r.definition]),
        },
      ],
    });
  }

  const aiGenerated = draft.aiGenerated === true || typeof draft.aiDraftJobId === "string";
  const timestamp = new Date().toISOString();

  return {
    slug: typeof draft.slug === "string" && draft.slug ? draft.slug : guideId,
    cover: {
      title,
      subtitle: typeof draft.summary === "string" ? draft.summary : null,
      author: "",
      locale: typeof draft.language === "string" ? draft.language : "",
      keywords: [],
      branding: { primaryColor: null, logoDataUri: null, fontFamily: null },
    },
    blocks: sections.flatMap((section, i) => [
      { kind: "section" as const, id: `section-${i}`, title: section.heading },
      ...section.blocks,
    ]),
    sources: [],
    disclosure: { required: aiGenerated, label: aiGenerated ? "AI-generated" : null, url: null },
    generatedAt: typeof draft.createdAt === "string" ? draft.createdAt : timestamp,
    updatedAt: typeof draft.updatedAt === "string" ? draft.updatedAt : timestamp,
    seo: { metaTitle: title, metaDescription: null, canonicalUrl: null },
  };
}

function collectParagraphs(values: readonly unknown[]): readonly string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) {
      out.push(v.trim());
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.trim().length > 0) {
          out.push(item.trim());
        }
      }
    }
  }
  return out;
}

function toParagraphList(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) {
        out.push(item.trim());
      } else if (item !== null && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const text = typeof o["text"] === "string"
          ? o["text"]
          : typeof o["description"] === "string"
            ? o["description"]
            : typeof o["title"] === "string"
              ? o["title"]
              : null;
        if (text !== null && text.trim().length > 0) out.push(text.trim());
      }
    }
    return out;
  }
  return [];
}

function toStepList(
  raw: unknown,
): readonly GuideDocument["blocks"][number][] {
  if (!Array.isArray(raw)) return [];
  const out: GuideDocument["blocks"][number][] = [];
  let index = 1;
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const title =
      typeof e["title"] === "string" && e["title"].length > 0
        ? e["title"]
        : `Step ${index}`;
    const description =
      typeof e["description"] === "string" ? e["description"] : undefined;
    const imageRef = typeof e["screenshotRef"] === "string"
      ? e["screenshotRef"]
      : typeof e["imageRef"] === "string"
        ? e["imageRef"]
        : undefined;
    const altText = typeof e["altText"] === "string" ? e["altText"] : undefined;
    const stepIndexRaw = e["index"];
    const stepIndex =
      typeof stepIndexRaw === "number" && Number.isFinite(stepIndexRaw)
        ? Math.trunc(stepIndexRaw)
        : index;
    out.push({
      kind: "step",
      id: typeof e.id === "string" ? e.id : `step-${stepIndex}`,
      index: stepIndex,
      title,
      description: description ?? "",
      image: imageRef ? { id: imageRef, mimeType: "image/png", bytes: null, width: null, height: null, altText: altText ?? title, caption: null, sourceRefs: [imageRef] } : null,
      tips: toParagraphList(e.tips),
      warnings: toParagraphList(e.warnings),
    });
    index += 1;
  }
  return out;
}

interface FaqPair {
  readonly question: string;
  readonly answer: string;
}

function toFaqPairs(raw: unknown): readonly FaqPair[] {
  if (!Array.isArray(raw)) {
    if (raw !== null && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      const q = typeof o["question"] === "string" ? o["question"] : null;
      const a = typeof o["answer"] === "string" ? o["answer"] : null;
      if (q !== null && a !== null) return [{ question: q, answer: a }];
    }
    return [];
  }
  const out: FaqPair[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const q =
      typeof e["question"] === "string"
        ? e["question"]
        : typeof e["q"] === "string"
          ? e["q"]
          : null;
    const a =
      typeof e["answer"] === "string"
        ? e["answer"]
        : typeof e["a"] === "string"
          ? e["a"]
          : null;
    if (q !== null && a !== null) out.push({ question: q, answer: a });
  }
  return out;
}

interface GlossaryRow {
  readonly term: string;
  readonly definition: string;
}

function toGlossaryRows(raw: unknown): readonly GlossaryRow[] {
  if (!Array.isArray(raw)) {
    if (raw !== null && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      const out: GlossaryRow[] = [];
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string") out.push({ term: k, definition: v });
      }
      return out;
    }
    return [];
  }
  const out: GlossaryRow[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const term = typeof e["term"] === "string" ? e["term"] : null;
    const definition =
      typeof e["definition"] === "string"
        ? e["definition"]
        : typeof e["description"] === "string"
          ? e["description"]
          : null;
    if (term !== null && definition !== null) out.push({ term, definition });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Auth helpers                                                                */
/* -------------------------------------------------------------------------- */

async function requireSession(
  req: Request,
): Promise<SessionRecord | HttpResponse> {
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: false,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/guides/[id]/export] session load failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return HttpResponse.json(
      { error: "session_error", message: "Could not load the caller session." },
      { status: 500 },
    );
  }
  if (session === null) {
    return HttpResponse.json(
      { error: "unauthenticated", message: "Authentication required." },
      { status: 401 },
    );
  }
  try {
    assertPermission(session, PERMISSIONS.guide_read);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return HttpResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  return session;
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

export async function GET(
  req: Request,
  context: { readonly params: { readonly id: string } },
): Promise<Response> {
  const config = getConfig();

  if (!config.database.configured) {
    return HttpResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Exports cannot be authenticated.",
      },
      { status: 503 },
    );
  }
  if (!config.auth.sessionSecretConfigured) {
    return HttpResponse.json(
      { error: "config_error", message: "SESSION_SECRET is not configured on this server." },
      { status: 503 },
    );
  }

  const sessionOrError = await requireSession(req);
  if (sessionOrError instanceof HttpResponse) return sessionOrError;
  const session = sessionOrError;

  const workspaceId = session.activeWorkspaceId;
  if (workspaceId === null) {
    return HttpResponse.json(
      {
        error: "workspace_required",
        message: "An active workspace is required to export a guide.",
      },
      { status: 403 },
    );
  }

  const guideId = context.params.id;
  if (typeof guideId !== "string" || !UUID_PATTERN.test(guideId)) {
    return HttpResponse.json(
      { error: "validation_error", field: "id", message: "Guide id must be a UUID." },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const formatRaw = url.searchParams.get("format");
  if (formatRaw === null || formatRaw.length === 0) {
    return HttpResponse.json(
      {
        error: "validation_error",
        field: "format",
        message: `Query parameter "format" is required. Supported: ${SUPPORTED_FORMATS.join(", ")}.`,
      },
      { status: 400 },
    );
  }
  const format = formatRaw.toLowerCase() as ExportFormat;
  if (!(SUPPORTED_FORMATS as readonly string[]).includes(format)) {
    return HttpResponse.json(
      {
        error: "validation_error",
        field: "format",
        message: `Unsupported format "${formatRaw}". Supported: ${SUPPORTED_FORMATS.join(", ")}.`,
      },
      { status: 400 },
    );
  }

  // ------------------------------------------------------------- storage ----
  let store: StoreLike;
  try {
    store = (await forWorkspace(workspaceId)) as unknown as StoreLike;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/guides/[id]/export] object store unavailable: ${message}\n`,
    );
    return HttpResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The artifact object store is not configured on this server. Check STORAGE_DRIVER and the associated S3/local configuration.",
      },
      { status: 503 },
    );
  }

  // ------------------------------------------------------- guide record -----
  let guideRecord: unknown;
  try {
    guideRecord = await readJsonOrNull(store, guideRecordKey(guideId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/guides/[id]/export] guide read failed for ${guideId}: ${message}\n`,
    );
    return HttpResponse.json(
      {
        error: "storage_failed",
        message:
          "The guide record could not be read from the object store. Check server logs.",
      },
      { status: 503 },
    );
  }
  if (guideRecord === null || typeof guideRecord !== "object" || Array.isArray(guideRecord)) {
    return HttpResponse.json(
      {
        error: "not_found",
        message:
          "No guide exists under this id in your active workspace. Create the guide before exporting it.",
      },
      { status: 404 },
    );
  }

  // ------------------------------------------------------- current draft ----
  let draftRaw: unknown;
  try {
    draftRaw = await readJsonOrNull(store, currentDraftKey(guideId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/guides/[id]/export] draft read failed for ${guideId}: ${message}\n`,
    );
    return HttpResponse.json(
      {
        error: "storage_failed",
        message:
          "The guide draft could not be read from the object store. Check server logs.",
      },
      { status: 503 },
    );
  }
  if (draftRaw === null || typeof draftRaw !== "object" || Array.isArray(draftRaw)) {
    // Native editor saves are already content drafts, not a separate pipeline file.
    if (guideRecord && typeof guideRecord === "object" && !Array.isArray(guideRecord)
      && Array.isArray((guideRecord as Record<string, unknown>).steps)) draftRaw = guideRecord;
  }
  if (draftRaw === null || typeof draftRaw !== "object" || Array.isArray(draftRaw)) {
    return HttpResponse.json(
      {
        error: "no_draft",
        message:
          "No content draft exists for this guide. Run POST /api/guides/{id}/generate before exporting.",
      },
      { status: 409 },
    );
  }

  // --------------------------------------------------------- adapt ----------
  const document = adaptDraftToGuideDocument(
    draftRaw as DraftShape,
    guideId,
    workspaceId,
  );

  const imageResolver = makeImageResolver(store, guideId);

  // ------------------------------------------------------- dispatch ---------
  try {
    const result = await dispatchExport(format, document, imageResolver);
    return new Response(result.body, {
      status: 200,
      headers: {
        "content-type": result.contentType,
        "content-length": String(result.byteLength),
        "content-disposition": buildContentDisposition(result.filename),
        "cache-control": "private, no-store",
        "x-zipy-guide-id": guideId,
        "x-zipy-workspace-id": workspaceId,
        "x-zipy-export-format": format,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown }).code;
    process.stderr.write(
      `[/api/guides/[id]/export] ${format} render failed for ${guideId}: ${message}\n`,
    );
    if (code === "unsupported") {
      return HttpResponse.json(
        {
          error: "unsupported_export",
          message,
        },
        { status: 422 },
      );
    }
    return HttpResponse.json(
      {
        error: "export_failed",
        message:
          "The export could not be rendered. Check server logs for the underlying error.",
      },
      { status: 500 },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

interface ExportResult {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
  readonly byteLength: number;
}

type ImageResolver = (imageRef: string) => Promise<{
  readonly bytes: Uint8Array;
  readonly contentType: string;
} | null>;

async function dispatchExport(
  format: ExportFormat,
  document: GuideDocument,
  imageResolver: ImageResolver,
): Promise<ExportResult> {
  // Resolve only workspace-scoped stored images, never arbitrary remote URLs.
  document = {
    ...document,
    blocks: await Promise.all(document.blocks.map(async block => {
      if (block.kind !== "step" || !block.image) return block;
      const resolved = await imageResolver(block.image.id);
      return resolved ? { ...block, image: { ...block.image, bytes: resolved.bytes, mimeType: resolved.contentType } } : block;
    })),
  };
  switch (format) {
    case "pdf": {
      const opts: PdfExportOptions = {
        includeTableOfContents: true,
      };
      const r = await renderGuidePdf(document, opts);
      return {
        body: toUint8(r.bytes),
        contentType: FORMAT_CONTENT_TYPES.pdf,
        filename: sanitiseFilename(document.cover.title ?? document.slug, "pdf"),
        byteLength: r.bytes.length,
      };
    }
    case "html": {
      const opts: HtmlExportOptions = {
        fragmentOnly: false,
      };
      const r = await renderGuideHtml(document, opts);
      const bytes = toUint8FromString(r.html);
      return {
        body: bytes,
        contentType: FORMAT_CONTENT_TYPES.html,
        filename: sanitiseFilename(document.cover.title ?? document.slug, "html"),
        byteLength: bytes.length,
      };
    }
    case "markdown": {
      const opts: MarkdownExportOptions = {
        frontMatter: true,
      };
      const r = await renderGuideMarkdown(document, opts);
      const bytes = toUint8FromString(r.readme);
      return {
        body: bytes,
        contentType: FORMAT_CONTENT_TYPES.markdown,
        filename: sanitiseFilename(document.cover.title ?? document.slug, "md"),
        byteLength: bytes.length,
      };
    }
    case "docx": {
      const r = renderGuideDocx(document);
      const bytes = toUint8(r.bytes);
      return {
        body: bytes,
        contentType: FORMAT_CONTENT_TYPES.docx,
        filename: sanitiseFilename(document.cover.title ?? document.slug, "docx"),
        byteLength: bytes.length,
      };
    }
    case "imagepack": {
      const r = renderGuideImagePack(document, { generatedAt: document.generatedAt });
      const bytes = toUint8(r.bytes);
      return {
        body: bytes,
        contentType: FORMAT_CONTENT_TYPES.imagepack,
        filename: sanitiseFilename(document.cover.title ?? document.slug, "zip"),
        byteLength: bytes.length,
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function makeImageResolver(
  store: StoreLike,
  guideId: string,
): ImageResolver {
  return async (imageRef: string) => {
    // Image refs are guide-scoped in storage; a ref is either a workspace
    // object key (`screenshots/...`) or a guide-scoped key. We try both,
    // preferring the guide-scoped one because that is where the pipeline
    // writes the step screenshots.
    const candidates = [
      imageRef,
      `${GUIDES_PREFIX}/${guideId}/${imageRef}`,
      `${GUIDES_PREFIX}/${guideId}/screenshots/${imageRef}`,
    ];
    for (const key of candidates) {
      let bytes: Buffer | null;
      try {
        bytes = await store.get(key);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not.?found|enoent|no such key|404/i.test(message)) continue;
        throw error;
      }
      if (bytes !== null) {
        return {
          bytes: new Uint8Array(bytes),
          contentType: contentTypeForKey(key),
        };
      }
    }
    return null;
  };
}

function contentTypeForKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function toUint8(value: Uint8Array | Buffer | ArrayBufferView): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  // Fallback: value must be a Buffer at this point.
  return new Uint8Array(value as Uint8Array);
}

function toUint8FromString(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function sanitiseFilename(title: string, extension: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9.\-_ ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  const safe = base.length === 0 ? "guide" : base.slice(0, 80);
  return `${safe}.${extension}`;
}

function buildContentDisposition(filename: string): string {
  // ASCII fallback plus RFC 5987 encoded variant for non-ASCII titles.
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

const READ_ONLY_MESSAGE =
  "This endpoint accepts GET with a `format` query parameter to download a guide in that format.";

export async function POST(): Promise<HttpResponse> {
  return HttpResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function PUT(): Promise<HttpResponse> {
  return HttpResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function DELETE(): Promise<HttpResponse> {
  return HttpResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Exports are rendered on demand; there is nothing to delete on the server. Use admin/retention for retention sweeps.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}

