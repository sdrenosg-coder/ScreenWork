/**
 * Zipy AI — Docling adapter (layout + table structure extraction).
 *
 * Wraps a Docling service (DocLayNet layout model + TableFormer table
 * structure model) as an HTTP JSON surface. This module does NOT bundle the
 * Docling Python runtime: the operator runs it out of process and points
 * DOCLING_SERVICE_URL at it. When that env var is absent the adapter throws
 * `DoclingError` with `code: "service-unavailable"` rather than fabricating a
 * layout — the caller (PDF/DOCX pipeline) then degrades explicitly by
 * surfacing the error to the user or falling back to text-only extraction when
 * that fallback is itself justified.
 *
 * Service contract (documented, not invented here):
 *   POST {DOCLING_SERVICE_URL}/parse
 *   Content-Type: application/json
 *   {
 *     "filename": string,
 *     "mimeType": string,
 *     "dataBase64": string,
 *     "options": { "tables": true, "figures": true, "language": "en" }
 *   }
 *   -> 200 {
 *     "width": number, "height": number,
 *     "pages": [{
 *       "pageNumber": number,
 *       "width": number, "height": number,
 *       "regions": [{
 *         "kind": "text" | "title" | "table" | "figure" | "header" | "footer" | "list" | "code" | "formula" | "caption",
 *         "bbox": { "x": number, "y": number, "width": number, "height": number },
 *         "text": string,
 *         "confidence": number | null,
 *         "table": {                  // present when kind === "table"
 *           "rows": string[][],
 *           "headerRows": number,
 *           "columnCount": number,
 *           "rowCount": number
 *         } | null,
 *         "figure": {                 // present when kind === "figure"
 *           "caption": string,
 *           "imageId": string
 *         } | null
 *       }]
 *     }]
 *   }
 *
 * Every field is validated on ingress. Malformed regions are recorded in
 * `droppedCount` and surfaced to the caller so a partial parse is visibly
 * partial, never silently truncated.
 *
 * Design notes:
 *  - Auth uses a bearer token from DOCLING_SERVICE_TOKEN when set; otherwise
 *    the request is sent unauthenticated (a local sidecar on 127.0.0.1 does
 *    not need a token).
 *  - Table models emit `rows` as a rectangular string matrix with empty
 *    strings for absent cells. The caller decides how to serialise (Markdown,
 *    HTML, JSON); this module keeps the canonical matrix and the row/column
 *    counts so downstream serialisation is a pure function.
 *  - Bounding boxes are in the coordinate system the service reported,
 *    normally PDF points with top-left origin. `unit` on the parse result
 *    records what the service declared so callers do not guess.
 *  - No retries here; the caller owns retry/backoff. Failures bubble as
 *    `DoclingError` with a code the job runner can classify.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class DoclingError extends Error {
  readonly code:
    | "service-unavailable"
    | "invalid-input"
    | "request-failed"
    | "bad-response"
    | "timeout"
    | "internal";
  constructor(message: string, code: DoclingError["code"]) {
    super(message);
    this.name = "DoclingError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface DoclingBBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type DoclingRegionKind =
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

export interface DoclingTable {
  /** Row-major cell matrix. Empty string = absent cell. */
  readonly rows: readonly (readonly string[])[];
  /** Number of leading rows the model flagged as header rows (>= 0). */
  readonly headerRows: number;
  readonly columnCount: number;
  readonly rowCount: number;
}

export interface DoclingFigure {
  readonly caption: string;
  /** Service-assigned id the caller can use to fetch the cropped image. */
  readonly imageId: string;
}

export interface DoclingRegion {
  readonly kind: DoclingRegionKind;
  readonly bbox: DoclingBBox;
  /** The region's primary text. May be empty for pure-figure regions. */
  readonly text: string;
  /** 0..1 model confidence, or null when the service did not report one. */
  readonly confidence: number | null;
  readonly table: DoclingTable | null;
  readonly figure: DoclingFigure | null;
}

export interface DoclingPage {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly regions: readonly DoclingRegion[];
}

export interface DoclingParseResult {
  /** Which service endpoint served the request. */
  readonly endpoint: string;
  /** Coordinate unit the service reported; "pt" and "px" are the common ones. */
  readonly unit: "pt" | "px" | "unknown";
  /** Total page count as reported. */
  readonly pageCount: number;
  /** Width/height of the *first* page. Multi-size PDFs are uncommon; callers
   * must read per-page dims from `pages` for mixed-orientation documents. */
  readonly width: number;
  readonly height: number;
  readonly pages: readonly DoclingPage[];
  /** Regions that failed validation and were dropped. */
  readonly droppedCount: number;
  /** Wall-clock duration of the round-trip. */
  readonly durationMs: number;
  /** ISO timestamp when the parse completed. */
  readonly completedAt: string;
}

export interface DoclingParseOptions {
  /** Original filename, reported to the service for format sniffing. */
  readonly filename: string;
  /** MIME type asserted by the caller. */
  readonly mimeType: string;
  /** Force table model on/off. Default: true. */
  readonly tables?: boolean;
  /** Force figure detection on/off. Default: true. */
  readonly figures?: boolean;
  /** OCR language hint passed through to Docling's internal OCR. */
  readonly language?: string;
  /** Hard request timeout in ms. Default: DOCLING_TIMEOUT_MS or 180_000. */
  readonly timeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * True when a Docling service URL is configured. Exposed so callers can branch
 * on service availability without catching an exception. Returning `false`
 * makes no attempt to reach the service.
 */
export function isDoclingConfigured(): boolean {
  return readEnv("DOCLING_SERVICE_URL") !== null;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

interface FetchResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<FetchResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed, raw };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function coerceBBox(v: unknown): DoclingBBox | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const x = coerceNumber(r["x"]);
  const y = coerceNumber(r["y"]);
  const w = coerceNumber(r["width"]);
  const h = coerceNumber(r["height"]);
  if (x === null || y === null || w === null || h === null) return null;
  if (w < 0 || h < 0) return null;
  return { x, y, width: w, height: h };
}

const VALID_KINDS: readonly DoclingRegionKind[] = [
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

function coerceKind(v: unknown): DoclingRegionKind | null {
  if (typeof v !== "string") return null;
  const lowered = v.toLowerCase().trim();
  return (VALID_KINDS as readonly string[]).includes(lowered)
    ? (lowered as DoclingRegionKind)
    : null;
}

function coerceTable(v: unknown): DoclingTable | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const rowsRaw = Array.isArray(r["rows"]) ? (r["rows"] as unknown[]) : null;
  if (rowsRaw === null) return null;
  const rows: string[][] = [];
  let maxCols = 0;
  for (const rowRaw of rowsRaw) {
    if (!Array.isArray(rowRaw)) return null;
    const row: string[] = [];
    for (const cell of rowRaw as unknown[]) {
      if (cell === null || cell === undefined) {
        row.push("");
      } else if (typeof cell === "string") {
        row.push(cell);
      } else if (typeof cell === "number" || typeof cell === "boolean") {
        row.push(String(cell));
      } else {
        row.push("");
      }
    }
    rows.push(row);
    if (row.length > maxCols) maxCols = row.length;
  }
  // Rectangularise: pad short rows so downstream serialisation is trivial.
  for (const row of rows) {
    while (row.length < maxCols) row.push("");
  }
  const headerRowsRaw = coerceNumber(r["headerRows"]);
  const headerRows =
    headerRowsRaw === null || headerRowsRaw < 0
      ? 0
      : Math.min(Math.floor(headerRowsRaw), rows.length);
  return {
    rows,
    headerRows,
    columnCount: maxCols,
    rowCount: rows.length,
  };
}

function coerceFigure(v: unknown): DoclingFigure | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const caption = typeof r["caption"] === "string" ? (r["caption"] as string) : "";
  const imageId = typeof r["imageId"] === "string" ? (r["imageId"] as string) : "";
  if (caption.length === 0 && imageId.length === 0) return null;
  return { caption, imageId };
}

function parseRegion(raw: unknown): DoclingRegion | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = coerceKind(r["kind"]);
  const bbox = coerceBBox(r["bbox"]);
  if (kind === null || bbox === null) return null;
  const text = typeof r["text"] === "string" ? (r["text"] as string) : "";
  const confRaw = coerceNumber(r["confidence"]);
  const confidence = confRaw === null ? null : Math.max(0, Math.min(1, confRaw));
  const table = coerceTable(r["table"]);
  const figure = coerceFigure(r["figure"]);
  return { kind, bbox, text, confidence, table, figure };
}

function parsePage(raw: unknown, fallbackNumber: number): DoclingPage | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pageNumberRaw = coerceNumber(r["pageNumber"]);
  const pageNumber =
    pageNumberRaw === null ? fallbackNumber : Math.max(1, Math.floor(pageNumberRaw));
  const width = coerceNumber(r["width"]);
  const height = coerceNumber(r["height"]);
  if (width === null || height === null) return null;
  const regionsRaw = Array.isArray(r["regions"]) ? (r["regions"] as unknown[]) : [];
  const regions: DoclingRegion[] = [];
  for (const regionRaw of regionsRaw) {
    const region = parseRegion(regionRaw);
    if (region !== null) regions.push(region);
  }
  return { pageNumber, width, height, regions };
}

function coerceUnit(v: unknown): "pt" | "px" | "unknown" {
  if (typeof v !== "string") return "unknown";
  const lowered = v.toLowerCase().trim();
  if (lowered === "pt" || lowered === "point" || lowered === "points") return "pt";
  if (lowered === "px" || lowered === "pixel" || lowered === "pixels") return "px";
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Send a document to the configured Docling service and return a validated
 * parse result. Throws `DoclingError` when the service is not configured, the
 * request fails, times out, or responds with a malformed body.
 */
export async function runDoclingParse(
  bytes: Buffer,
  options: DoclingParseOptions,
): Promise<DoclingParseResult> {
  const baseUrl = readEnv("DOCLING_SERVICE_URL");
  if (baseUrl === null) {
    throw new DoclingError(
      "DOCLING_SERVICE_URL is not set. Layout-aware parsing requires a reachable " +
        "Docling service (run the Docling Python runtime and point DOCLING_SERVICE_URL at it). " +
        "Zipy AI does not bundle or pre-provision it.",
      "service-unavailable",
    );
  }
  if (bytes.length === 0) {
    throw new DoclingError("runDoclingParse requires a non-empty document buffer.", "invalid-input");
  }
  if (options.filename.trim().length === 0) {
    throw new DoclingError("runDoclingParse requires a non-empty filename.", "invalid-input");
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/parse`;
  const token = readEnv("DOCLING_SERVICE_TOKEN");
  const headers: Record<string, string> = {};
  if (token !== null) headers["authorization"] = `Bearer ${token}`;

  const timeoutMs = options.timeoutMs ?? readIntEnv("DOCLING_TIMEOUT_MS", 180_000);

  const requestBody = {
    filename: options.filename,
    mimeType: options.mimeType,
    dataBase64: bytes.toString("base64"),
    options: {
      tables: options.tables !== false,
      figures: options.figures !== false,
      language: options.language ?? "en",
    },
  };

  const started = Date.now();
  let res: FetchResult;
  try {
    res = await postJson(endpoint, headers, requestBody, timeoutMs);
  } catch (err) {
    // AbortError from our timeout vs a genuine network error.
    const isAbort =
      err !== null &&
      typeof err === "object" &&
      (err as { name?: unknown }).name === "AbortError";
    if (isAbort) {
      throw new DoclingError(
        `Docling request to ${endpoint} exceeded ${timeoutMs}ms. Raise DOCLING_TIMEOUT_MS or reduce document size.`,
        "timeout",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new DoclingError(
      `Docling request to ${endpoint} failed: ${message}`,
      "request-failed",
    );
  }

  if (!res.ok) {
    throw new DoclingError(
      `Docling service returned HTTP ${res.status}. Body: ${res.raw.slice(0, 400)}`,
      "request-failed",
    );
  }
  if (res.body === null || typeof res.body !== "object") {
    throw new DoclingError("Docling service returned a non-JSON-object body.", "bad-response");
  }
  const root = res.body as Record<string, unknown>;
  const pagesRaw = Array.isArray(root["pages"]) ? (root["pages"] as unknown[]) : [];
  if (pagesRaw.length === 0) {
    throw new DoclingError(
      "Docling service returned no pages. An empty parse is indistinguishable from a misconfigured service; refusing to proceed with an empty result.",
      "bad-response",
    );
  }

  const pages: DoclingPage[] = [];
  let droppedCount = 0;
  for (let i = 0; i < pagesRaw.length; i += 1) {
    const page = parsePage(pagesRaw[i], i + 1);
    if (page === null) {
      droppedCount += 1;
      continue;
    }
    // Count regions the parser rejected inside an otherwise valid page.
    const regionsRaw = Array.isArray((pagesRaw[i] as Record<string, unknown>)["regions"])
      ? ((pagesRaw[i] as Record<string, unknown>)["regions"] as unknown[])
      : [];
    droppedCount += regionsRaw.length - page.regions.length;
    pages.push(page);
  }
  if (pages.length === 0) {
    throw new DoclingError(
      "Docling service returned pages but none were valid (missing width/height).",
      "bad-response",
    );
  }

  const first = pages[0] as DoclingPage;
  const unit = coerceUnit(root["unit"]);

  return {
    endpoint,
    unit,
    pageCount: pages.length,
    width: first.width,
    height: first.height,
    pages,
    droppedCount,
    durationMs: Date.now() - started,
    completedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Serialisation helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Serialise a `DoclingTable` to GitHub-flavoured Markdown. Header rows are the
 * first `headerRows` rows; when `headerRows` is 0 we emit no header separator
 * (a plain pipe table), which is the honest rendering of a header-less model
 * output (never inventing a header).
 */
export function tableToMarkdown(table: DoclingTable): string {
  if (table.rowCount === 0) return "";
  const lines: string[] = [];
  const headerRows = table.headerRows;
  if (headerRows > 0) {
    for (let i = 0; i < headerRows; i += 1) {
      const row = table.rows[i] ?? [];
      lines.push(`| ${row.map(escapeMdCell).join(" | ")} |`);
    }
    const sep = new Array(table.columnCount).fill("---").join(" | ");
    lines.push(`| ${sep} |`);
    for (let i = headerRows; i < table.rowCount; i += 1) {
      const row = table.rows[i] ?? [];
      lines.push(`| ${row.map(escapeMdCell).join(" | ")} |`);
    }
  } else {
    for (const row of table.rows) {
      lines.push(`| ${row.map(escapeMdCell).join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

function escapeMdCell(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Serialise a `DoclingTable` to JSON with explicit header/data rows so callers
 * that need structure (not presentation) do not re-derive it.
 */
export function tableToJson(table: DoclingTable): {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly columnCount: number;
} {
  const headerRows = table.headerRows;
  if (headerRows > 0) {
    return {
      headers: table.rows[0] ?? [],
      rows: table.rows.slice(headerRows),
      columnCount: table.columnCount,
    };
  }
  return {
    headers: [],
    rows: table.rows,
    columnCount: table.columnCount,
  };
}

/**
 * Rehydrate a stored `DoclingParseResult`. Throws on malformed payloads so a
 * caller can fail the job rather than operate on a partial structure.
 */
export function rehydrateDoclingParse(value: unknown): DoclingParseResult {
  if (value === null || typeof value !== "object") {
    throw new DoclingError("Rehydrate failed: payload is not an object.", "internal");
  }
  const r = value as Record<string, unknown>;
  const pagesRaw = Array.isArray(r["pages"]) ? (r["pages"] as unknown[]) : [];
  const pages: DoclingPage[] = [];
  for (let i = 0; i < pagesRaw.length; i += 1) {
    const page = parsePage(pagesRaw[i], i + 1);
    if (page !== null) pages.push(page);
  }
  if (pages.length === 0) {
    throw new DoclingError("Rehydrate failed: no valid pages in stored payload.", "internal");
  }
  const first = pages[0] as DoclingPage;
  const width = coerceNumber(r["width"]);
  const height = coerceNumber(r["height"]);
  return {
    endpoint: typeof r["endpoint"] === "string" ? (r["endpoint"] as string) : "",
    unit: coerceUnit(r["unit"]),
    pageCount: typeof r["pageCount"] === "number" ? (r["pageCount"] as number) : pages.length,
    width: width === null ? first.width : width,
    height: height === null ? first.height : height,
    pages,
    droppedCount: typeof r["droppedCount"] === "number" ? (r["droppedCount"] as number) : 0,
    durationMs: typeof r["durationMs"] === "number" ? (r["durationMs"] as number) : 0,
    completedAt: typeof r["completedAt"] === "string" ? (r["completedAt"] as string) : "",
  };
}
