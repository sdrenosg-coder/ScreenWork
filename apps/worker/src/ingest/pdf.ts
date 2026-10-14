/**
 * Zipy AI — PDF ingestion (worker side).
 *
 * Produces a single JSON-serializable `PdfIngestResult` from a PDF. Two paths
 * exist and the module picks between them honestly, never silently:
 *
 *   1. Layout-aware path (preferred): when DOCLING_SERVICE_URL is set, the
 *      PDF is parsed by the Docling service, which returns pages, text blocks,
 *      table structures, figures and per-region bounding boxes. Tables are
 *      additionally serialised to Markdown and to JSON so downstream phases
 *      have both a presentation form and a structural form without re-parsing.
 *
 *   2. Scan-fallback path (required): when Docling is unavailable we detect the
 *      text layer. If a page has no retrievable text at *any* position we flag
 *      the PDF as scanned and route page renderings through the existing
 *      `runOcr` adapter (`@zipy/ingest/ocr`). This is the same OCR engine the
 *      image-ingest path uses, so a scanned PDF and an image of the same page
 *      produce the same OCR shape.
 *
 * Three cases fall out and the module distinguishes them explicitly:
 *   - Docling configured and reachable     → strategy: "docling"
 *   - Docling not configured, text present  → strategy: "pdf-text" (via pdf.js
 *                                            when installed, otherwise the
 *                                            module fails with a clear error)
 *   - Docling not configured, no text       → strategy: "ocr" via pdf.js render
 *                                            + runOcr per page
 *   - Docling configured but *fails* (net/HTTP) → the error is re-thrown, not
 *     swallowed into a silent OCR fallback. The caller decides whether to
 *     retry with OCR explicitly.
 *
 * Design notes:
 *  - pdf.js is loaded lazily via `createRequire` because the workspace does
 *    not declare it yet. When neither it nor Docling is available callers get
 *    a precise `PdfIngestError` with `code: "pdfjs-missing"`.
 *  - No credential for the PDF is accepted here. Password-protected PDFs are
 *    surfaced as `code: "password-protected"` and the caller is expected to
 *    prompt the user (a later phase owns the vault).
 *  - The result is JSON-serializable end to end and shares its shape with the
 *    image path (per-region text + bbox + confidence) so a downstream
 *    canonicalisation pass can handle PDF, image and URL inputs uniformly.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  DoclingError,
  isDoclingConfigured,
  runDoclingParse,
  tableToJson,
  tableToMarkdown,
  type DoclingParseResult,
  type DoclingRegion,
  type DoclingTable,
} from "@zipy/ingest/docling";
import { runOcr, type OcrRegion, type OcrResult } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class PdfIngestError extends Error {
  readonly code:
    | "invalid-input"
    | "file-missing"
    | "pdfjs-missing"
    | "password-protected"
    | "corrupt"
    | "docling-failed"
    | "engine-unavailable"
    | "internal";
  constructor(message: string, code: PdfIngestError["code"]) {
    super(message);
    this.name = "PdfIngestError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type PdfIngestStrategy = "docling" | "pdf-text" | "ocr";

export interface PdfBBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PdfRegionKind =
  | "text"
  | "title"
  | "table"
  | "figure"
  | "header"
  | "footer"
  | "list"
  | "code"
  | "formula"
  | "caption";

export interface PdfTable {
  /** Row-major matrix of cell strings. Missing cells are empty strings. */
  readonly rows: readonly (readonly string[])[];
  readonly headerRows: number;
  readonly columnCount: number;
  readonly rowCount: number;
  /** Markdown serialisation of the same matrix, ready for the MD export. */
  readonly markdown: string;
  /** Structured serialisation (headers separate from data rows). */
  readonly json: {
    readonly headers: readonly string[];
    readonly rows: readonly (readonly string[])[];
    readonly columnCount: number;
  };
}

export interface PdfFigure {
  readonly caption: string;
  readonly imageId: string;
}

export interface PdfRegion {
  /** Source id within the page; makes provenance addressing stable. */
  readonly id: string;
  readonly kind: PdfRegionKind;
  readonly bbox: PdfBBox;
  readonly text: string;
  readonly confidence: number | null;
  readonly table: PdfTable | null;
  readonly figure: PdfFigure | null;
}

export interface PdfPage {
  /** 1-based page number. */
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  /** True when this page needed OCR (no extractable text). */
  readonly wasOcr: boolean;
  readonly regions: readonly PdfRegion[];
  /** Serialised OCR lines when `wasOcr` is true; otherwise null. */
  readonly ocr: OcrResult | null;
}

export interface PdfIngestResult {
  /** Absolute path the file was read from, when one was supplied. */
  readonly sourcePath: string | null;
  /** SHA-256 hash of the raw bytes, hex-encoded. */
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  /** Which strategy produced the pages. */
  readonly strategy: PdfIngestStrategy;
  /** Docling's parse output when the docling strategy was used; else null. */
  readonly docling: DoclingParseResult | null;
  /** The canonical pages the rest of the pipeline reads. */
  readonly pages: readonly PdfPage[];
  readonly pageCount: number;
  /** True when *any* page required OCR. */
  readonly anyOcr: boolean;
  /** Total number of regions across all pages. */
  readonly regionCount: number;
  /** Total number of table regions across all pages. */
  readonly tableCount: number;
  /** Total number of figure regions across all pages. */
  readonly figureCount: number;
  /** ISO timestamp. */
  readonly capturedAt: string;
  readonly durationMs: number;
}

export interface PdfIngestOptions {
  /** Absolute or relative path to the PDF. Required; the caller has already
   * received the file on disk. */
  readonly inputPath: string;
  /** MIME type override. Defaults to `application/pdf`. */
  readonly mimeType?: string;
  /**
   * Force the strategy. When omitted the module picks "docling" if the service
   * is configured, else "pdf-text" when text is extractable, else "ocr".
   */
  readonly forceStrategy?: PdfIngestStrategy;
  /** OCR engine override forwarded to `runOcr` when the OCR path runs. */
  readonly ocrEngine?: "easyocr" | "tesseract" | "cloud" | "auto";
  /** Render scale for the OCR path. 2 = 144 DPI. Default 2. */
  readonly renderScale?: number;
  /** Language hint for Docling (forwarded). */
  readonly language?: string;
  /** Hard timeout for the Docling request. */
  readonly doclingTimeoutMs?: number;
  /** Hard timeout per page for OCR. */
  readonly ocrTimeoutMs?: number;
  /** When true, do not fall back to OCR even if text extraction yields nothing. */
  readonly noOcrFallback?: boolean;
}

/* -------------------------------------------------------------------------- */
/* pdf.js lazy loading                                                         */
/* -------------------------------------------------------------------------- */

interface PdfJsViewport {
  readonly width: number;
  readonly height: number;
}

interface PdfJsRenderTask {
  promise: Promise<void>;
}

interface PdfJsPage {
  getViewport(opts: { scale: number }): PdfJsViewport;
  render(opts: {
    canvasContext: unknown;
    viewport: PdfJsViewport;
  }): PdfJsRenderTask;
  getTextContent(): Promise<{ items: ReadonlyArray<unknown> }>;
  readonly rotate: number;
}

interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
}

interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  getDocument(opts: {
    data?: Uint8Array;
    password?: string;
    isEvalSupported?: boolean;
  }): PdfJsLoadingTask;
}

const requireFromHere = createRequire(import.meta.url);

function loadPdfJs(): PdfJsModule {
  try {
    const legacy = safeRequire("pdfjs-dist/legacy/build/pdf.js");
    if (legacy !== null) return legacy as PdfJsModule;
    const standard = safeRequire("pdfjs-dist");
    if (standard !== null) return standard as PdfJsModule;
  } catch {
    /* fall through to the thrown error below */
  }
  throw new PdfIngestError(
    "PDF ingestion requires `pdfjs-dist` for text extraction and rendering. " +
      "Install it with `npm install pdfjs-dist`. When DOCLING_SERVICE_URL is configured " +
      "the Docling path does not need pdfjs-dist, but the scan fallback and text-layer " +
      "detection do.",
    "pdfjs-missing",
  );
}

function safeRequire(name: string): unknown | null {
  try {
    return requireFromHere(name);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Config helpers                                                              */
/* -------------------------------------------------------------------------- */

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Text-layer detection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Compute whether a page has extractable text. pdf.js `getTextContent()`
 * returns items whose `str` fields are the text runs. A page with no items, or
 * with items that all have empty/whitespace strings, is text-layer free (i.e.
 * a scanned page). Returned per page so multi-page documents can route only
 * the scanned pages through OCR.
 */
function pageHasText(items: ReadonlyArray<unknown>): boolean {
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const str = (item as Record<string, unknown>)["str"];
    if (typeof str === "string" && str.trim().length > 0) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Text extraction from pdf.js                                                 */
/* -------------------------------------------------------------------------- */

interface PdfTextRun {
  readonly text: string;
  readonly bbox: PdfBBox;
}

function extractTextRuns(items: ReadonlyArray<unknown>): readonly PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const str = typeof r["str"] === "string" ? (r["str"] as string) : "";
    const transform = Array.isArray(r["transform"]) ? (r["transform"] as unknown[]) : null;
    if (str.length === 0 || transform === null) continue;
    // pdf.js exposes `transform: [a, b, c, d, e, f]` where (e, f) is the text
    // baseline origin in user-space points with a bottom-left origin. We don't
    // have exact widths without the font metrics, so we approximate the box:
    //   height derived from the font matrix (`d` is the y-scale),
    //   width derived from the item's own `width` when present, else the run
    //   length in pixels approximated from the font scale.
    const e = Number(transform[4]);
    const f = Number(transform[5]);
    const d = Number(transform[3]);
    const a = Number(transform[0]);
    if (!Number.isFinite(e) || !Number.isFinite(f) || !Number.isFinite(d) || !Number.isFinite(a)) {
      continue;
    }
    const height = Math.abs(d) > 0 ? Math.abs(d) : 10;
    const widthRaw = typeof r["width"] === "number" ? (r["width"] as number) : null;
    const approxWidth =
      widthRaw !== null && Number.isFinite(widthRaw) && widthRaw > 0
        ? widthRaw
        : Math.max(1, str.length * Math.max(1, Math.abs(a)));
    // We report in top-left-origin pixel-like units to keep parity with OCR.
    // The caller converts to points when serialising to PDF coordinates; we
    // document the unit on the page.
    runs.push({
      text: str,
      bbox: {
        x: e,
        y: f - height,
        width: approxWidth,
        height,
      },
    });
  }
  runs.sort((a, b) => {
    if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });
  return runs;
}

/* -------------------------------------------------------------------------- */
/* Region assembly (per strategy)                                              */
/* -------------------------------------------------------------------------- */

function regionId(pageNumber: number, ordinal: number): string {
  return `p${pageNumber}-r${ordinal}`;
}

function doclingRegionFrom(region: DoclingRegion): {
  readonly kind: PdfRegionKind;
  readonly bbox: PdfBBox;
  readonly text: string;
  readonly confidence: number | null;
  readonly table: PdfTable | null;
  readonly figure: PdfFigure | null;
} {
  const table = region.table === null ? null : tableToPdfTable(region.table);
  const figure =
    region.figure === null
      ? null
      : { caption: region.figure.caption, imageId: region.figure.imageId };
  return {
    kind: region.kind,
    bbox: region.bbox,
    text: region.text,
    confidence: region.confidence,
    table,
    figure,
  };
}

function tableToPdfTable(table: DoclingTable): PdfTable {
  const markdown = tableToMarkdown(table);
  const json = tableToJson(table);
  return {
    rows: table.rows,
    headerRows: table.headerRows,
    columnCount: table.columnCount,
    rowCount: table.rowCount,
    markdown,
    json,
  };
}

function regionsFromDoclingPage(page: DoclingParseResult["pages"][number], pageNumber: number): PdfRegion[] {
  const out: PdfRegion[] = [];
  page.regions.forEach((region, i) => {
    const normalised = doclingRegionFrom(region);
    out.push({
      id: regionId(pageNumber, i + 1),
      ...normalised,
    });
  });
  return out;
}

function regionsFromOcrPage(ocr: OcrResult, pageNumber: number): PdfRegion[] {
  const out: PdfRegion[] = [];
  ocr.regions.forEach((r: OcrRegion, i) => {
    if (r.text.length === 0) return;
    out.push({
      id: regionId(pageNumber, i + 1),
      kind: "text",
      bbox: r.bbox,
      text: r.text,
      confidence: r.confidence,
      table: null,
      figure: null,
    });
  });
  return out;
}

function regionsFromTextRuns(runs: readonly PdfTextRun[], pageNumber: number): PdfRegion[] {
  const out: PdfRegion[] = [];
  runs.forEach((run, i) => {
    if (run.text.trim().length === 0) return;
    out.push({
      id: regionId(pageNumber, i + 1),
      kind: "text",
      bbox: run.bbox,
      text: run.text,
      confidence: null,
      table: null,
      figure: null,
    });
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* OCR path (scan fallback)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Render a page to a PNG buffer via pdf.js + @napi-rs/canvas. Canvas is
 * optional; when it is not installed the OCR path cannot run and the module
 * raises a precise error naming both packages. No PDF is ever stored: the
 * rendered image is transient and passed straight into `runOcr`.
 */
interface CanvasLike {
  createCanvas(width: number, height: number): {
    getContext(type: "2d"): unknown;
    toBuffer(mime: "image/png"): Buffer;
  };
}

function loadCanvas(): CanvasLike {
  const mod = safeRequire("@napi-rs/canvas");
  if (mod === null || typeof mod !== "object") {
    throw new PdfIngestError(
      "Rendering a scanned PDF for OCR requires `@napi-rs/canvas` (or an equivalent " +
        "Node canvas shim). Install it with `npm install @napi-rs/canvas`. Without a " +
        "canvas either set DOCLING_SERVICE_URL so Docling handles scanning, or ingest " +
        "each page as a standalone image.",
      "engine-unavailable",
    );
  }
  const c = mod as Partial<CanvasLike>;
  if (typeof c.createCanvas !== "function") {
    throw new PdfIngestError(
      "The `@napi-rs/canvas` module did not export `createCanvas`; the installed version is not supported.",
      "engine-unavailable",
    );
  }
  return c as CanvasLike;
}

async function renderPageToPng(
  page: PdfJsPage,
  scale: number,
  canvas: CanvasLike,
): Promise<Buffer> {
  const viewport = page.getViewport({ scale });
  const canvasEl = canvas.createCanvas(
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height)),
  );
  const ctx = canvasEl.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvasEl.toBuffer("image/png");
}

/* -------------------------------------------------------------------------- */
/* Detection helpers                                                           */
/* -------------------------------------------------------------------------- */

function isPdfPasswordError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  const message = (err as { message?: unknown }).message;
  if (name === "PasswordException") return true;
  if (typeof message === "string" && /password/i.test(message)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ingest a PDF file. Returns a JSON-serializable result. Throws
 * `PdfIngestError` for any failing precondition (missing file, corrupt PDF,
 * password protection, unavailable extraction engine).
 */
export async function ingestPdf(options: PdfIngestOptions): Promise<PdfIngestResult> {
  const started = Date.now();
  const inputPath = options.inputPath;
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new PdfIngestError("ingestPdf requires a non-empty inputPath.", "invalid-input");
  }
  if (!existsSync(inputPath)) {
    throw new PdfIngestError(`PDF file does not exist: ${inputPath}`, "file-missing");
  }
  const bytes = await readFile(inputPath);
  if (bytes.length === 0) {
    throw new PdfIngestError(`PDF file is empty: ${inputPath}`, "invalid-input");
  }
  const contentHash = sha256Hex(bytes);
  const mimeType = options.mimeType ?? inferPdfMime(inputPath);

  // ---------------------------------------------------------------- Docling --
  const doclingConfigured = isDoclingConfigured();
  const forced = options.forceStrategy;

  if (forced === "docling" || (forced === undefined && doclingConfigured)) {
    if (!doclingConfigured) {
      throw new PdfIngestError(
        "forceStrategy=docling was requested but DOCLING_SERVICE_URL is not configured.",
        "engine-unavailable",
      );
    }
    let docling: DoclingParseResult;
    try {
      docling = await runDoclingParse(bytes, {
        filename: path.basename(inputPath),
        mimeType,
        language: options.language,
        timeoutMs: options.doclingTimeoutMs,
      });
    } catch (err) {
      if (err instanceof DoclingError) {
        // Re-wrap with a code the worker classifies as a job failure.
        throw new PdfIngestError(
          `Docling parse failed (${err.code}): ${err.message}`,
          err.code === "service-unavailable" ? "engine-unavailable" : "docling-failed",
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new PdfIngestError(`Docling parse failed: ${message}`, "docling-failed");
    }
    const pages: PdfPage[] = docling.pages.map((p) =>
      buildDoclingPage(p, p.pageNumber),
    );
    return summarize({
      sourcePath: inputPath,
      contentHash,
      byteLength: bytes.length,
      mimeType,
      strategy: "docling",
      docling,
      pages,
      anyOcr: false,
      started,
    });
  }

  // ------------------------------------------------------------ pdf.js half --
  const pdfjs = loadPdfJs();
  let doc: PdfJsDocument;
  let loadingTask: PdfJsLoadingTask | null = null;
  try {
    const data = new Uint8Array(bytes);
    loadingTask = pdfjs.getDocument({ data, isEvalSupported: false });
    doc = await loadingTask.promise;
  } catch (err) {
    if (isPdfPasswordError(err)) {
      throw new PdfIngestError(
        "This PDF is password-protected. Provide the password via the vault-backed credentials surface once that phase lands; until then re-upload an unlocked copy.",
        "password-protected",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfIngestError(`Failed to open PDF: ${message}`, "corrupt");
  }

  try {
    const renderScale = Math.max(1, Math.min(4, options.renderScale ?? 2));
    const pages: PdfPage[] = [];
    let anyOcr = false;

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const hasText = pageHasText(textContent.items);

      if (hasText || options.noOcrFallback === true) {
        if (!hasText && options.noOcrFallback === true) {
          // Caller explicitly forbade OCR; emit an empty-text page rather than
          // substituting unverified output.
          pages.push({
            pageNumber,
            width: viewport.width,
            height: viewport.height,
            wasOcr: false,
            regions: [],
            ocr: null,
          });
          continue;
        }
        const runs = extractTextRuns(textContent.items);
        const regions = regionsFromTextRuns(runs, pageNumber);
        pages.push({
          pageNumber,
          width: viewport.width,
          height: viewport.height,
          wasOcr: false,
          regions,
          ocr: null,
        });
        continue;
      }

      // No text layer: OCR the rendered page.
      const canvas = loadCanvas();
      const png = await renderPageToPng(page, renderScale, canvas);
      let ocr: OcrResult;
      try {
        ocr = await runOcr(png, {
          engine: options.ocrEngine,
          timeoutMs: options.ocrTimeoutMs ?? readIntEnv("OCR_TIMEOUT_MS", 120_000),
        });
      } catch (err) {
        const code = err !== null && typeof err === "object" && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
        const message = err instanceof Error ? err.message : String(err);
        const wrappedCode: PdfIngestError["code"] =
          code === "engine-unavailable" || code === "cloud-not-configured"
            ? "engine-unavailable"
            : "internal";
        throw new PdfIngestError(
          `OCR of page ${pageNumber} failed: ${message}`,
          wrappedCode,
        );
      }
      const regions = regionsFromOcrPage(ocr, pageNumber);
      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        wasOcr: true,
        regions,
        ocr,
      });
      anyOcr = true;
    }

    // If the caller forced "ocr" but every page had text, we still ran as
    // requested; strategy reflects what actually happened.
    const strategy: PdfIngestStrategy = anyOcr ? "ocr" : "pdf-text";
    return summarize({
      sourcePath: inputPath,
      contentHash,
      byteLength: bytes.length,
      mimeType,
      strategy,
      docling: null,
      pages,
      anyOcr,
      started,
    });
  } finally {
    if (loadingTask !== null) {
      try {
        await loadingTask.destroy();
      } catch {
        /* best effort */
      }
    }
  }
}

function buildDoclingPage(
  page: DoclingParseResult["pages"][number],
  pageNumber: number,
): PdfPage {
  return {
    pageNumber,
    width: page.width,
    height: page.height,
    wasOcr: false,
    regions: regionsFromDoclingPage(page, pageNumber),
    ocr: null,
  };
}

interface SummarizeInput {
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly strategy: PdfIngestStrategy;
  readonly docling: DoclingParseResult | null;
  readonly pages: readonly PdfPage[];
  readonly anyOcr: boolean;
  readonly started: number;
}

function summarize(input: SummarizeInput): PdfIngestResult {
  let regionCount = 0;
  let tableCount = 0;
  let figureCount = 0;
  for (const page of input.pages) {
    for (const region of page.regions) {
      regionCount += 1;
      if (region.table !== null) tableCount += 1;
      if (region.figure !== null) figureCount += 1;
    }
  }
  return {
    sourcePath: input.sourcePath,
    contentHash: input.contentHash,
    byteLength: input.byteLength,
    mimeType: input.mimeType,
    strategy: input.strategy,
    docling: input.docling,
    pages: input.pages,
    pageCount: input.pages.length,
    anyOcr: input.anyOcr,
    regionCount,
    tableCount,
    figureCount,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - input.started,
  };
}

function sha256Hex(bytes: Buffer): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

function inferPdfMime(inputPath: string): string {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export interface RehydratedPdfIngest {
  readonly sourcePath: string | null;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly strategy: PdfIngestStrategy;
  readonly pages: readonly PdfPage[];
  readonly pageCount: number;
  readonly anyOcr: boolean;
  readonly capturedAt: string;
}

/**
 * Read a persisted `PdfIngestResult` back. Tables are reconstructed with their
 * markdown and structured forms so downstream readers do not re-derive them.
 * Throws `PdfIngestError` with `code: "internal"` on malformed payloads.
 */
export function rehydratePdfIngest(value: unknown): RehydratedPdfIngest {
  if (value === null || typeof value !== "object") {
    throw new PdfIngestError("Rehydrate failed: payload is not an object.", "internal");
  }
  const r = value as Record<string, unknown>;
  const strategyRaw = r["strategy"];
  const strategy: PdfIngestStrategy =
    strategyRaw === "docling" || strategyRaw === "pdf-text" || strategyRaw === "ocr"
      ? strategyRaw
      : "pdf-text";
  const pagesRaw = Array.isArray(r["pages"]) ? (r["pages"] as unknown[]) : [];
  const pages: PdfPage[] = [];
  for (const pageRaw of pagesRaw) {
    const page = parseStoredPage(pageRaw);
    if (page !== null) pages.push(page);
  }
  if (pages.length === 0) {
    throw new PdfIngestError(
      "Rehydrate failed: no pages in stored payload.",
      "internal",
    );
  }
  return {
    sourcePath: typeof r["sourcePath"] === "string" ? (r["sourcePath"] as string) : null,
    contentHash: typeof r["contentHash"] === "string" ? (r["contentHash"] as string) : "",
    mimeType: typeof r["mimeType"] === "string" ? (r["mimeType"] as string) : "application/pdf",
    strategy,
    pages,
    pageCount: typeof r["pageCount"] === "number" ? (r["pageCount"] as number) : pages.length,
    anyOcr: r["anyOcr"] === true,
    capturedAt: typeof r["capturedAt"] === "string" ? (r["capturedAt"] as string) : "",
  };
}

function parseStoredPage(raw: unknown): PdfPage | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pageNumber = typeof r["pageNumber"] === "number" ? (r["pageNumber"] as number) : 0;
  const width = typeof r["width"] === "number" ? (r["width"] as number) : 0;
  const height = typeof r["height"] === "number" ? (r["height"] as number) : 0;
  if (pageNumber <= 0 || width <= 0 || height <= 0) return null;
  const regionsRaw = Array.isArray(r["regions"]) ? (r["regions"] as unknown[]) : [];
  const regions: PdfRegion[] = [];
  for (const regionRaw of regionsRaw) {
    const region = parseStoredRegion(regionRaw);
    if (region !== null) regions.push(region);
  }
  return {
    pageNumber,
    width,
    height,
    wasOcr: r["wasOcr"] === true,
    regions,
    ocr: null, // Stored OCR is kept on the page but not needed at this layer; callers that want it read `region.text`.
  };
}

function parseStoredRegion(raw: unknown): PdfRegion | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? (r["id"] as string) : null;
  const kind = typeof r["kind"] === "string" ? (r["kind"] as string) : null;
  if (id === null || kind === null) return null;
  const validKinds: readonly PdfRegionKind[] = [
    "text",
    "title",
    "table",
    "figure",
    "header",
    "footer",
    "list",
    "code",
    "formula",
    "caption",
  ];
  const safeKind: PdfRegionKind = (validKinds as readonly string[]).includes(kind)
    ? (kind as PdfRegionKind)
    : "text";
  const bboxRaw = r["bbox"];
  let bbox: PdfBBox = { x: 0, y: 0, width: 0, height: 0 };
  if (bboxRaw !== null && typeof bboxRaw === "object") {
    const b = bboxRaw as Record<string, unknown>;
    bbox = {
      x: typeof b["x"] === "number" ? (b["x"] as number) : 0,
      y: typeof b["y"] === "number" ? (b["y"] as number) : 0,
      width: typeof b["width"] === "number" ? (b["width"] as number) : 0,
      height: typeof b["height"] === "number" ? (b["height"] as number) : 0,
    };
  }
  const table = parseStoredTable(r["table"]);
  const figure =
    r["figure"] !== null && typeof r["figure"] === "object"
      ? {
          caption:
            typeof (r["figure"] as Record<string, unknown>)["caption"] === "string"
              ? ((r["figure"] as Record<string, unknown>)["caption"] as string)
              : "",
          imageId:
            typeof (r["figure"] as Record<string, unknown>)["imageId"] === "string"
              ? ((r["figure"] as Record<string, unknown>)["imageId"] as string)
              : "",
        }
      : null;
  return {
    id,
    kind: safeKind,
    bbox,
    text: typeof r["text"] === "string" ? (r["text"] as string) : "",
    confidence:
      typeof r["confidence"] === "number" && Number.isFinite(r["confidence"] as number)
        ? (r["confidence"] as number)
        : null,
    table,
    figure,
  };
}

function parseStoredTable(raw: unknown): PdfTable | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rowsRaw = Array.isArray(r["rows"]) ? (r["rows"] as unknown[]) : null;
  if (rowsRaw === null) return null;
  const rows: string[][] = [];
  for (const rowRaw of rowsRaw) {
    if (!Array.isArray(rowRaw)) return null;
    const row: string[] = [];
    for (const cell of rowRaw as unknown[]) {
      row.push(typeof cell === "string" ? cell : String(cell ?? ""));
    }
    rows.push(row);
  }
  const markdown = typeof r["markdown"] === "string" ? (r["markdown"] as string) : "";
  const jsonRaw = r["json"];
  let json: PdfTable["json"] = { headers: [], rows: [], columnCount: 0 };
  if (jsonRaw !== null && typeof jsonRaw === "object") {
    const j = jsonRaw as Record<string, unknown>;
    const headers = Array.isArray(j["headers"])
      ? (j["headers"] as unknown[]).map((v) => (typeof v === "string" ? v : String(v ?? "")))
      : [];
    const jrows = Array.isArray(j["rows"]) ? (j["rows"] as unknown[]) : [];
    const outRows: string[][] = [];
    for (const jrow of jrows) {
      if (!Array.isArray(jrow)) continue;
      outRows.push(
        (jrow as unknown[]).map((v) => (typeof v === "string" ? v : String(v ?? ""))),
      );
    }
    json = {
      headers,
      rows: outRows,
      columnCount:
        typeof j["columnCount"] === "number" ? (j["columnCount"] as number) : 0,
    };
  }
  return {
    rows,
    headerRows: typeof r["headerRows"] === "number" ? (r["headerRows"] as number) : 0,
    columnCount: typeof r["columnCount"] === "number" ? (r["columnCount"] as number) : 0,
    rowCount: typeof r["rowCount"] === "number" ? (r["rowCount"] as number) : rows.length,
    markdown,
    json,
  };
}
