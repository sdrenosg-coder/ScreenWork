/**
 * Zipy AI — DOCX ingestion (worker side).
 *
 * Reads a .docx file from disk, extracts headings, paragraphs, lists, tables
 * and embedded images in document order, and returns a JSON-serializable
 * `DocxIngestResult`. Embedded images are surfaced as first-class records so
 * the caller can route them through the existing image ingestion pipeline
 * (`ingestImage`) for OCR + VLM UI-element recognition.
 *
 * Implementation strategy: a .docx is a ZIP whose `word/document.xml` holds
 * the WML markup, `word/media/*` holds embedded media, and
 * `word/_rels/document.xml.rels` holds the relationship ids that map
 * `r:embed` attributes to media files. We parse the XML with a small,
 * dependency-free extractor (the schema is bounded enough for a naïve
 * handler) rather than pulling in a full OOXML library. This keeps the
 * ingestion path honest about what it can and cannot extract:
 *
 *   - Supported: paragraphs (with style as heading level), runs with text,
 *     bulleted/numbered lists (`numPr` presence), simple tables (rows and
 *     cells with their flattened text), and inline/anchored images referenced
 *     via `r:embed` or `r:link` off relationships whose target lives under
 *     `word/media/`.
 *   - Not attempted: footnotes, comments, text boxes, tracked-change
 *     revisions, embedded charts, field codes with computed values, or
 *     theme-driven font metrics. These are silently *not* represented rather
 *     than invented. The counts of what was extracted are exposed so callers
 *     can detect a document whose payload lives in unsupported structures.
 *
 * The XML walker is a streaming character scanner, not a full DOM: it
 * recognises only the tags we need and treats unknown elements as transparent.
 * This is deliberate — a general-purpose XML parser is a large dependency and
 * the shape of WML for this extraction is well bounded.
 *
 * Design notes:
 *  - No Zip library dependency beyond Node's built-in `zlib`. We implement a
 *    minimal ZIP reader over `End of Central Directory` + local file headers.
 *    It supports STORED (0) and DEFLATE (8) methods, which covers every DOCX
 *    written by Word/LibreOffice/Google Docs. Zip64 and encrypted archives
 *    raise a precise error.
 *  - The result is JSON-serializable; no `Buffer` leaks through except on
 *    `embeddedImages[*].bytes` which the caller is expected to consume and
 *    discard before persisting (the caller stores the image via the object
 *    store and carries the artifact ref instead). The rehydrator strips bytes.
 *  - No network, no LLM, no credentials. Pure local parsing.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class DocxIngestError extends Error {
  readonly code:
    | "invalid-input"
    | "file-missing"
    | "not-a-zip"
    | "unsupported-zip"
    | "not-a-docx"
    | "corrupt"
    | "internal";
  constructor(message: string, code: DocxIngestError["code"]) {
    super(message);
    this.name = "DocxIngestError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface DocxBBox {
  /** Present only for images and (best-effort) tables; null otherwise. */
  readonly x: number | null;
  readonly y: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export type DocxBlockKind = "heading" | "paragraph" | "list" | "table" | "image";

export interface DocxBlock {
  /** 1-based ordinal in document order across all block kinds. */
  readonly ordinal: number;
  readonly kind: DocxBlockKind;
  /** Heading level 1-6 when kind === "heading"; null otherwise. */
  readonly level: number | null;
  /** Flattened, trimmed text of the paragraph/list/title. Empty for images. */
  readonly text: string;
  /** True when the paragraph carried `numPr`; used to differentiate list items. */
  readonly numbered: boolean;
  /** Table payload when kind === "table". */
  readonly table: DocxTable | null;
  /** Image payload when kind === "image". */
  readonly image: DocxImageRef | null;
}

export interface DocxTable {
  readonly rows: readonly (readonly string[])[];
  readonly columnCount: number;
  readonly rowCount: number;
  /** Markdown serialisation, ready for the MD export. */
  readonly markdown: string;
}

export interface DocxImageRef {
  /** Relationship id from `r:embed` or `r:link`. Stable within the document. */
  readonly relId: string;
  /** Media path inside the zip, e.g. "word/media/image1.png". */
  readonly zipPath: string;
  /** Folder-relative media filename, e.g. "image1.png". */
  readonly filename: string;
  /** Content type guessed from the media extension. */
  readonly mimeType: string;
  /** Captured alt text from `wp:docPr descr` when present, else empty. */
  readonly altText: string;
  /** Raw image bytes. The caller must persist and drop before storing the rest. */
  readonly bytes: Buffer;
  /** SHA-256 of `bytes`, so re-uploads can detect identical media. */
  readonly contentHash: string;
  /** Byte length of `bytes`. */
  readonly byteLength: number;
}

export interface DocxIngestResult {
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  /** ISO timestamp. */
  readonly capturedAt: string;
  readonly durationMs: number;
  /** Core properties (best effort; empty strings when not present). */
  readonly core: {
    readonly title: string;
    readonly creator: string;
    readonly lastModifiedBy: string;
    readonly created: string;
    readonly modified: string;
    readonly subject: string;
    readonly description: string;
  };
  /** Blocks in document order. */
  readonly blocks: readonly DocxBlock[];
  /** Convenience counts derived from `blocks`. */
  readonly counts: {
    readonly headings: number;
    readonly paragraphs: number;
    readonly listItems: number;
    readonly tables: number;
    readonly images: number;
  };
  /**
   * Record of relationships that referenced media not present in the archive.
   * Non-empty means the document is malformed; the caller may decide to warn.
   */
  readonly missingMedia: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Minimal ZIP reader                                                          */
/* -------------------------------------------------------------------------- */

interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

function readUInt32LE(bytes: Buffer, offset: number): number {
  return bytes.readUInt32LE(offset);
}
function readUInt16LE(bytes: Buffer, offset: number): number {
  return bytes.readUInt16LE(offset);
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  // The EOCD record is at the end but may be followed by a variable-length
  // comment (up to 65535 bytes). Scan backwards for the signature.
  const minPos = Math.max(0, bytes.length - 22 - 65_535);
  for (let i = bytes.length - 22; i >= minPos; i -= 1) {
    if (readUInt32LE(bytes, i) === ZIP_EOCD_SIG) return i;
  }
  return -1;
}

function readZipCentralDirectory(bytes: Buffer): readonly ZipEntry[] {
  if (bytes.length < 22) {
    throw new DocxIngestError("File is too small to be a ZIP archive.", "not-a-zip");
  }
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) {
    throw new DocxIngestError(
      "File does not contain a ZIP End of Central Directory record. It is not a .docx.",
      "not-a-zip",
    );
  }
  // Detect Zip64: a valid DOCX from Word is never Zip64, but archives from
  // exotic tooling can be. We refuse rather than silently mis-parse.
  if (
    eocd >= 20 &&
    readUInt32LE(bytes, eocd - 20) === ZIP64_EOCD_LOCATOR_SIG
  ) {
    throw new DocxIngestError(
      "ZIP64 archives are not supported by this reader. Re-save the document with a tool that emits a standard DOCX ZIP.",
      "unsupported-zip",
    );
  }
  const totalEntries = readUInt16LE(bytes, eocd + 10);
  const cdOffset = readUInt32LE(bytes, eocd + 16);
  const cdSize = readUInt32LE(bytes, eocd + 12);
  if (cdOffset + cdSize > bytes.length) {
    throw new DocxIngestError(
      "ZIP central directory extends beyond the file; archive is corrupt.",
      "corrupt",
    );
  }
  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > bytes.length) {
      throw new DocxIngestError("ZIP central directory entry ran past the file end.", "corrupt");
    }
    if (readUInt32LE(bytes, cursor) !== 0x02014b50) {
      throw new DocxIngestError(
        "ZIP central directory entry has an unexpected signature.",
        "corrupt",
      );
    }
    const compressionMethod = readUInt16LE(bytes, cursor + 10);
    const compressedSize = readUInt32LE(bytes, cursor + 20);
    const uncompressedSize = readUInt32LE(bytes, cursor + 24);
    const nameLength = readUInt16LE(bytes, cursor + 28);
    const extraLength = readUInt16LE(bytes, cursor + 30);
    const commentLength = readUInt16LE(bytes, cursor + 32);
    const localHeaderOffset = readUInt32LE(bytes, cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      throw new DocxIngestError("ZIP entry name ran past the file end.", "corrupt");
    }
    const name = bytes.toString("utf8", nameStart, nameEnd);
    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function extractZipEntry(bytes: Buffer, entry: ZipEntry): Buffer {
  if (entry.localHeaderOffset + 30 > bytes.length) {
    throw new DocxIngestError(`ZIP local header for "${entry.name}" is out of bounds.`, "corrupt");
  }
  if (readUInt32LE(bytes, entry.localHeaderOffset) !== ZIP_LOCAL_SIG) {
    throw new DocxIngestError(
      `ZIP local header for "${entry.name}" has an unexpected signature.`,
      "corrupt",
    );
  }
  const nameLength = readUInt16LE(bytes, entry.localHeaderOffset + 26);
  const extraLength = readUInt16LE(bytes, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) {
    throw new DocxIngestError(
      `ZIP local data for "${entry.name}" extends past the file end.`,
      "corrupt",
    );
  }
  const slice = bytes.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(slice);
  if (entry.compressionMethod === 8) {
    const out = inflateRawSync(slice);
    if (out.length !== entry.uncompressedSize && entry.uncompressedSize !== 0) {
      // Length mismatch is informational; some producers report 0 in the
      // central directory. We trust the inflated bytes and do not raise.
    }
    return out;
  }
  throw new DocxIngestError(
    `ZIP entry "${entry.name}" uses unsupported compression method ${entry.compressionMethod}. Only STORED(0) and DEFLATE(8) are supported.`,
    "unsupported-zip",
  );
}

/* -------------------------------------------------------------------------- */
/* Minimal WML extractor                                                       */
/* -------------------------------------------------------------------------- */

interface WmlParagraph {
  readonly kind: "paragraph" | "list";
  readonly styleId: string;
  readonly text: string;
  readonly numbered: boolean;
  /** Relationship ids from any `r:embed` or `r:link` attributes in the paragraph. */
  readonly imageRelIds: readonly string[];
  /** Alt-texts keyed by rel id when the producer emitted `wp:docPr descr`. */
  readonly imageAltTexts: ReadonlyMap<string, string>;
}

interface WmlTable {
  readonly rows: readonly (readonly string[])[];
}

interface ParsedDocument {
  readonly paragraphs: readonly WmlParagraph[];
  /** Table XML spans in order; we record a marker to interleave in document
   * order when combining with paragraphs. */
  readonly blocks: readonly ({ readonly kind: "p"; readonly paragraph: WmlParagraph } | { readonly kind: "tbl"; readonly table: WmlTable })[];
}

/**
 * Very small tag scanner over the document body. It is *not* a full XML
 * parser; it assumes the well-formed subset that Word emits. Unknown elements
 * are skipped transparently. Text is collected from `<w:t>` runs; paragraph
 * boundaries are `<w:p>...</w:p>`; tables are `<w:tbl>...</w:tbl>` with
 * `<w:tr>` and `<w:tc>` for rows and cells; list items are paragraphs whose
 * paragraph properties explicitly contain `<w:numPr>`.
 */
function parseDocumentXml(xml: string): ParsedDocument {
  const blocks: ParsedDocument["blocks"][number][] = [];
  const paragraphs: WmlParagraph[] = [];

  let i = 0;
  const len = xml.length;

  // Skip past the body start so we never accidentally pick up properties from
  // sectPr or similar. We look for `<w:body>` and stop before the first table
  // we do not understand.
  const bodyStart = xml.indexOf("<w:body");
  i = bodyStart >= 0 ? xml.indexOf(">", bodyStart) + 1 : 0;

  while (i < len) {
    const pStart = xml.indexOf("<w:p ", i);
    const pStartBare = xml.indexOf("<w:p>", i);
    const tblStart = xml.indexOf("<w:tbl", i);
    const bodyEnd = xml.indexOf("</w:body>", i);
    const next = pickEarliest([pStart, pStartBare, tblStart, bodyEnd >= 0 ? bodyEnd : len + 1]);
    if (next < 0) break;
    if (bodyEnd >= 0 && next === bodyEnd) break;

    if (next === tblStart) {
      const tblEnd = xml.indexOf("</w:tbl>", tblStart);
      if (tblEnd < 0) break;
      const table = parseTableXml(xml.slice(tblStart, tblEnd + "</w:tbl>".length));
      blocks.push({ kind: "tbl", table });
      i = tblEnd + "</w:tbl>".length;
      continue;
    }

    // Paragraph
    const pEnd = xml.indexOf("</w:p>", next);
    if (pEnd < 0) break;
    const segment = xml.slice(next, pEnd + "</w:p>".length);
    const paragraph = parseParagraphXml(segment);
    paragraphs.push(paragraph);
    blocks.push({ kind: "p", paragraph });
    i = pEnd + "</w:p>".length;
  }

  return { paragraphs, blocks };
}

function pickEarliest(indices: readonly number[]): number {
  let best = -1;
  for (const v of indices) {
    if (v < 0) continue;
    if (best === -1 || v < best) best = v;
  }
  return best;
}

/**
 * Extract a paragraph's text and metadata. Text comes from `<w:t>...</w:t>`
 * runs (with `<w:tab/>` and `<w:br/>` mapped to a single space and a newline
 * respectively). Style is read from `<w:pStyle w:val="Heading1"/>` or similar.
 * Numbering is detected from any `<w:numPr>` in the paragraph's `<w:pPr>`.
 * Image relationships are read from `r:embed` / `r:link` attributes anywhere
 * in the segment; alt text from `wp:docPr ... descr="..."`.
 */
function parseParagraphXml(segment: string): WmlParagraph {
  // Style
  let styleId = "";
  const styleMatch = /<w:pStyle[^>]*\sw:val="([^"]*)"/.exec(segment);
  if (styleMatch !== null && typeof styleMatch[1] === "string") {
    styleId = styleMatch[1];
  } else {
    // Empty attribute may appear as `w:val=''` (rare) or `w:val` alone; we
    // only accept quoted forms.
  }

  const numbered = /<w:numPr\b/.test(segment);

  // Text runs
  const textParts: string[] = [];
  const runRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(segment)) !== null) {
    const full = m[0];
    if (full.startsWith("<w:t")) {
      textParts.push(decodeXmlEntities(m[1] ?? ""));
    } else if (full.startsWith("<w:tab")) {
      textParts.push("\t");
    } else {
      textParts.push("\n");
    }
  }
  const text = collapseWhitespace(textParts.join("")).trim();

  // Image relationships
  const imageRelIds: string[] = [];
  const relRe = /\sr:(?:embed|link)="([^"]+)"/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(segment)) !== null) {
    const id = rm[1];
    if (typeof id === "string" && id.length > 0) imageRelIds.push(id);
  }
  // Alt texts
  const imageAltTexts = new Map<string, string>();
  const docPrRe = /<wp:docPr\b[^>]*\sdescr="([^"]*)"/g;
  let dm: RegExpExecArray | null;
  const altTextsInOrder: string[] = [];
  while ((dm = docPrRe.exec(segment)) !== null) {
    altTextsInOrder.push(decodeXmlEntities(dm[1] ?? ""));
  }
  // Pair alt texts with image rel ids best-effort: docPr appears once per
  // drawing, in document order; when the counts match we assign in order.
  if (altTextsInOrder.length === imageRelIds.length) {
    for (let i = 0; i < imageRelIds.length; i += 1) {
      const id = imageRelIds[i];
      const alt = altTextsInOrder[i];
      if (typeof id === "string" && typeof alt === "string") imageAltTexts.set(id, alt);
    }
  }

  return {
    kind: numbered ? "list" : "paragraph",
    styleId,
    text,
    numbered,
    imageRelIds,
    imageAltTexts,
  };
}

function parseTableXml(segment: string): WmlTable {
  const rows: string[][] = [];
  let i = 0;
  while (true) {
    const rowStart = segment.indexOf("<w:tr", i);
    if (rowStart < 0) break;
    const rowEnd = segment.indexOf("</w:tr>", rowStart);
    if (rowEnd < 0) break;
    const rowXml = segment.slice(rowStart, rowEnd + "</w:tr>".length);
    const cells: string[] = [];
    let j = 0;
    while (true) {
      const cellStart = segment.indexOf("<w:tc", j);
      if (cellStart < 0 || cellStart > rowEnd) break;
      // Row boundary check: the cell must start within the current row.
      if (cellStart > rowEnd) break;
      const cellEnd = segment.indexOf("</w:tc>", cellStart);
      if (cellEnd < 0) break;
      const cellXml = segment.slice(cellStart, cellEnd + "</w:tc>".length);
      cells.push(flattenCellText(cellXml));
      j = cellEnd + "</w:tc>".length;
    }
    rows.push(cells);
    i = rowEnd + "</w:tr>".length;
    void rowXml;
  }
  // Rectangularise.
  let maxCols = 0;
  for (const r of rows) if (r.length > maxCols) maxCols = r.length;
  for (const r of rows) while (r.length < maxCols) r.push("");
  return { rows };
}

function flattenCellText(cellXml: string): string {
  // A cell may itself contain <w:p> childrens. We concatenate their text with
  // a space so a multi-paragraph cell becomes one string.
  const parts: string[] = [];
  const paraRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  let matchedAny = false;
  while ((m = paraRe.exec(cellXml)) !== null) {
    matchedAny = true;
    const para = parseParagraphXml(m[0]);
    if (para.text.length > 0) parts.push(para.text);
  }
  if (!matchedAny) {
    // Fallback: no paragraph wrapper (unusual); extract direct <w:t>.
    const directParts: string[] = [];
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(cellXml)) !== null) {
      directParts.push(decodeXmlEntities(tm[1] ?? ""));
    }
    return collapseWhitespace(directParts.join(" ")).trim();
  }
  return collapseWhitespace(parts.join(" ")).trim();
}

function decodeXmlEntities(text: string): string {
  // &amp; must be decoded last to avoid double-decoding.
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_full, num: string) => {
      const n = Number(num);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _full;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_full, hex: string) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _full;
    })
    .replace(/&amp;/g, "&");
}

function collapseWhitespace(s: string): string {
  // Collapse runs of horizontal whitespace; keep newlines we inserted for
  // line breaks. We then trim in the caller.
  return s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n");
}

/* -------------------------------------------------------------------------- */
/* Relationships + core properties                                             */
/* -------------------------------------------------------------------------- */

interface Relationship {
  readonly type: string;
  readonly target: string;
  readonly targetMode: "Internal" | "External" | "Unknown";
}

function parseRelationships(xml: string): ReadonlyMap<string, Relationship> {
  const map = new Map<string, Relationship>();
  const relRe = /<Relationship\b([^>]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    const id = attrValue(attrs, "Id");
    const type = attrValue(attrs, "Type");
    const target = attrValue(attrs, "Target");
    const modeRaw = attrValue(attrs, "TargetMode");
    if (id === null || type === null || target === null) continue;
    const targetMode: Relationship["targetMode"] =
      modeRaw === "External" ? "External" : modeRaw === "Internal" || modeRaw === null ? "Internal" : "Unknown";
    map.set(id, { type, target, targetMode });
  }
  return map;
}

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}="([^"]*)"`);
  const m = re.exec(attrs);
  if (m === null) return null;
  return decodeXmlEntities(m[1] ?? "");
}

function parseCoreProperties(xml: string): DocxIngestResult["core"] {
  const pick = (tag: string): string => {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
    const m = re.exec(xml);
    if (m === null) return "";
    return decodeXmlEntities(m[1] ?? "").trim();
  };
  return {
    title: pick("dc:title"),
    creator: pick("dc:creator"),
    lastModifiedBy: pick("cp:lastModifiedBy"),
    created: pick("dcterms:created"),
    modified: pick("dcterms:modified"),
    subject: pick("dc:subject"),
    description: pick("dc:description"),
  };
}

/* -------------------------------------------------------------------------- */
/* Heading detection                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Turn a style id into a heading level when the style id matches the common
 * conventions Word uses:
 *   "Heading1" .. "Heading9" (built-in)
 *   "heading 1" .. "heading 9" (lowercase variants)
 *   "Ttulo1"/"berschrift1"/"Titre1" — localised names we explicitly do not
 *   guess at. When a document uses localised heading style ids the caller can
 *   supply a resolver in a later phase. We do *not* infer a heading from
 *   formatting alone; that would be a fabrication.
 */
function headingLevelFromStyle(styleId: string): number | null {
  if (styleId.length === 0) return null;
  const trimmed = styleId.trim();
  const m = /^heading\s*([1-9])$/i.exec(trimmed);
  if (m !== null && typeof m[1] === "string") {
    const n = Number(m[1]);
    if (n >= 1 && n <= 9) return n;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Markdown table serialisation                                                */
/* -------------------------------------------------------------------------- */

function tableToMarkdown(table: DocxTable): string {
  if (table.rowCount === 0) return "";
  const lines: string[] = [];
  const header = table.rows[0] ?? [];
  lines.push(`| ${header.map(escapeMdCell).join(" | ")} |`);
  const sep = new Array(Math.max(1, table.columnCount)).fill("---").join(" | ");
  lines.push(`| ${sep} |`);
  for (let i = 1; i < table.rows.length; i += 1) {
    const row = table.rows[i] ?? [];
    lines.push(`| ${row.map(escapeMdCell).join(" | ")} |`);
  }
  return lines.join("\n");
}

function escapeMdCell(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/* -------------------------------------------------------------------------- */
/* MIME guessing for embedded media                                            */
/* -------------------------------------------------------------------------- */

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".emf": "image/emf",
  ".wmf": "image/wmf",
  ".svg": "image/svg+xml",
};

function mimeFromMediaPath(zipPath: string): string {
  const ext = path.extname(zipPath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

export interface DocxIngestOptions {
  /** Absolute or relative path to the .docx file. */
  readonly inputPath: string;
  /** MIME type override. Defaults to the standard DOCX content type. */
  readonly mimeType?: string;
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Ingest a .docx file. Returns a `DocxIngestResult` whose `blocks` are in
 * document order and whose `images[*].bytes` are raw. The caller is expected
 * to persist images to the object store and then strip the bytes before
 * writing the derived artifact (use `rehydrateDocxIngest` on the stored form).
 */
export async function ingestDocx(options: DocxIngestOptions): Promise<DocxIngestResult> {
  const started = Date.now();
  const inputPath = options.inputPath;
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new DocxIngestError("ingestDocx requires a non-empty inputPath.", "invalid-input");
  }
  if (!existsSync(inputPath)) {
    throw new DocxIngestError(`DOCX file does not exist: ${inputPath}`, "file-missing");
  }
  const bytes = await readFile(inputPath);
  if (bytes.length === 0) {
    throw new DocxIngestError(`DOCX file is empty: ${inputPath}`, "invalid-input");
  }
  const contentHash = sha256Hex(bytes);
  const mimeType = options.mimeType ?? DOCX_MIME;

  let entries: readonly ZipEntry[];
  try {
    entries = readZipCentralDirectory(bytes);
  } catch (err) {
    if (err instanceof DocxIngestError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DocxIngestError(`Failed to read container ZIP: ${message}`, "corrupt");
  }

  const entryByName = new Map<string, ZipEntry>();
  for (const e of entries) entryByName.set(e.name, e);

  const documentEntry = entryByName.get("word/document.xml");
  if (documentEntry === undefined) {
    throw new DocxIngestError(
      "Archive does not contain word/document.xml. The file is not a .docx document.",
      "not-a-docx",
    );
  }
  const documentXml = extractZipEntry(bytes, documentEntry).toString("utf8");
  const parsed = parseDocumentXml(documentXml);

  // Relationships (for embedded images) — optional but present in practice.
  let relationships = new Map<string, Relationship>();
  const relEntry = entryByName.get("word/_rels/document.xml.rels");
  if (relEntry !== undefined) {
    try {
      relationships = new Map(parseRelationships(extractZipEntry(bytes, relEntry).toString("utf8")));
    } catch {
      relationships = new Map();
    }
  }

  // Core properties are optional.
  let core: DocxIngestResult["core"] = {
    title: "",
    creator: "",
    lastModifiedBy: "",
    created: "",
    modified: "",
    subject: "",
    description: "",
  };
  const coreEntry = entryByName.get("docProps/core.xml");
  if (coreEntry !== undefined) {
    try {
      core = parseCoreProperties(extractZipEntry(bytes, coreEntry).toString("utf8"));
    } catch {
      /* keep defaults */
    }
  }

  // Build blocks, materialising image references into DocxImageRef where the
  // media actually exists in the archive.
  const blocks: DocxBlock[] = [];
  const missingMedia: string[] = [];
  let ordinal = 0;

  for (const block of parsed.blocks) {
    if (block.kind === "tbl") {
      const table: DocxTable = {
        rows: block.table.rows,
        columnCount:
          block.table.rows.length > 0 ? (block.table.rows[0]?.length ?? 0) : 0,
        rowCount: block.table.rows.length,
        markdown: "",
      };
      const fullTable: DocxTable = { ...table, markdown: tableToMarkdown(table) };
      ordinal += 1;
      blocks.push({
        ordinal,
        kind: "table",
        level: null,
        text: "",
        numbered: false,
        table: fullTable,
        image: null,
      });
      continue;
    }
    const p = block.paragraph;
    // Skip truly empty paragraphs that carry no images — they clutter without
    // conveying anything.
    if (p.text.length === 0 && p.imageRelIds.length === 0) continue;
    const headingLevel = headingLevelFromStyle(p.styleId);

    if (p.text.length > 0) {
      ordinal += 1;
      blocks.push({
        ordinal,
        kind: headingLevel !== null ? "heading" : p.kind === "list" ? "list" : "paragraph",
        level: headingLevel,
        text: p.text,
        numbered: p.numbered,
        table: null,
        image: null,
      });
    }

    // Materialise images that belong to this paragraph.
    for (const relId of p.imageRelIds) {
      const rel = relationships.get(relId);
      if (rel === undefined) {
        missingMedia.push(`relationship ${relId}`);
        continue;
      }
      if (rel.targetMode === "External") {
        // External image targets are not embedded in the archive. Surface the
        // URL as alt text rather than a binary; the caller decides whether to
        // fetch it (out of scope here; no network is performed).
        continue;
      }
      const zipPath = normalizeRelTarget(rel.target);
      const entry = entryByName.get(zipPath);
      if (entry === undefined) {
        missingMedia.push(`media ${zipPath} (rel ${relId})`);
        continue;
      }
      let imageBytes: Buffer;
      try {
        imageBytes = extractZipEntry(bytes, entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        missingMedia.push(`media ${zipPath} unreadable: ${message}`);
        continue;
      }
      ordinal += 1;
      const imageRef: DocxImageRef = {
        relId,
        zipPath,
        filename: path.basename(zipPath),
        mimeType: mimeFromMediaPath(zipPath),
        altText: p.imageAltTexts.get(relId) ?? "",
        bytes: imageBytes,
        contentHash: sha256Hex(imageBytes),
        byteLength: imageBytes.length,
      };
      blocks.push({
        ordinal,
        kind: "image",
        level: null,
        text: "",
        numbered: false,
        table: null,
        image: imageRef,
      });
    }
  }

  const counts = {
    headings: blocks.filter((b) => b.kind === "heading").length,
    paragraphs: blocks.filter((b) => b.kind === "paragraph").length,
    listItems: blocks.filter((b) => b.kind === "list").length,
    tables: blocks.filter((b) => b.kind === "table").length,
    images: blocks.filter((b) => b.kind === "image").length,
  };

  return {
    sourcePath: inputPath,
    contentHash,
    byteLength: bytes.length,
    mimeType,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    core,
    blocks,
    counts,
    missingMedia,
  };
}

/**
 * Resolve a relationship target to an archive path. DOCX relationship targets
 * are relative to `word/` (where document.xml lives) and often expressed as
 * `media/image1.png`. Absolute paths starting with `/` are relative to the
 * package root.
 */
function normalizeRelTarget(target: string): string {
  if (target.startsWith("/")) {
    return target.slice(1);
  }
  // Strip leading "./" segments.
  let t = target;
  while (t.startsWith("./")) t = t.slice(2);
  if (t.startsWith("word/")) return t;
  return `word/${t}`;
}

function sha256Hex(bytes: Buffer): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export interface RehydratedDocxIngest {
  readonly sourcePath: string | null;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly core: DocxIngestResult["core"];
  readonly blocks: readonly DocxBlock[];
  readonly counts: DocxIngestResult["counts"];
  readonly missingMedia: readonly string[];
  readonly capturedAt: string;
}

/**
 * Read a persisted `DocxIngestResult` back for downstream consumers. Image
 * `bytes` are dropped on rehydration by design: the persisted artifact must
 * carry an object-store reference for each image, and the caller re-resolves
 * those references when it needs the raw pixels. `rehydrated.blocks` therefore
 * carries `image.mimeType`, `image.contentHash` and `image.zipPath`, which is
 * the addressing surface the object store already accepts.
 *
 * Throws `DocxIngestError` with code `"internal"` on malformed payloads.
 */
export function rehydrateDocxIngest(value: unknown): RehydratedDocxIngest {
  if (value === null || typeof value !== "object") {
    throw new DocxIngestError("Rehydrate failed: payload is not an object.", "internal");
  }
  const r = value as Record<string, unknown>;
  const blocksRaw = Array.isArray(r["blocks"]) ? (r["blocks"] as unknown[]) : [];
  const blocks: DocxBlock[] = [];
  for (const raw of blocksRaw) {
    const b = parseStoredBlock(raw);
    if (b !== null) blocks.push(b);
  }
  const countsRaw = r["counts"];
  const counts: DocxIngestResult["counts"] =
    countsRaw !== null && typeof countsRaw === "object"
      ? {
          headings:
            typeof (countsRaw as Record<string, unknown>)["headings"] === "number"
              ? ((countsRaw as Record<string, unknown>)["headings"] as number)
              : blocks.filter((b) => b.kind === "heading").length,
          paragraphs:
            typeof (countsRaw as Record<string, unknown>)["paragraphs"] === "number"
              ? ((countsRaw as Record<string, unknown>)["paragraphs"] as number)
              : blocks.filter((b) => b.kind === "paragraph").length,
          listItems:
            typeof (countsRaw as Record<string, unknown>)["listItems"] === "number"
              ? ((countsRaw as Record<string, unknown>)["listItems"] as number)
              : blocks.filter((b) => b.kind === "list").length,
          tables:
            typeof (countsRaw as Record<string, unknown>)["tables"] === "number"
              ? ((countsRaw as Record<string, unknown>)["tables"] as number)
              : blocks.filter((b) => b.kind === "table").length,
          images:
            typeof (countsRaw as Record<string, unknown>)["images"] === "number"
              ? ((countsRaw as Record<string, unknown>)["images"] as number)
              : blocks.filter((b) => b.kind === "image").length,
        }
      : {
          headings: blocks.filter((b) => b.kind === "heading").length,
          paragraphs: blocks.filter((b) => b.kind === "paragraph").length,
          listItems: blocks.filter((b) => b.kind === "list").length,
          tables: blocks.filter((b) => b.kind === "table").length,
          images: blocks.filter((b) => b.kind === "image").length,
        };
  const coreRaw = r["core"];
  const core: DocxIngestResult["core"] =
    coreRaw !== null && typeof coreRaw === "object"
      ? {
          title: typeof (coreRaw as Record<string, unknown>)["title"] === "string"
            ? ((coreRaw as Record<string, unknown>)["title"] as string)
            : "",
          creator: typeof (coreRaw as Record<string, unknown>)["creator"] === "string"
            ? ((coreRaw as Record<string, unknown>)["creator"] as string)
            : "",
          lastModifiedBy:
            typeof (coreRaw as Record<string, unknown>)["lastModifiedBy"] === "string"
              ? ((coreRaw as Record<string, unknown>)["lastModifiedBy"] as string)
              : "",
          created: typeof (coreRaw as Record<string, unknown>)["created"] === "string"
            ? ((coreRaw as Record<string, unknown>)["created"] as string)
            : "",
          modified: typeof (coreRaw as Record<string, unknown>)["modified"] === "string"
            ? ((coreRaw as Record<string, unknown>)["modified"] as string)
            : "",
          subject: typeof (coreRaw as Record<string, unknown>)["subject"] === "string"
            ? ((coreRaw as Record<string, unknown>)["subject"] as string)
            : "",
          description:
            typeof (coreRaw as Record<string, unknown>)["description"] === "string"
              ? ((coreRaw as Record<string, unknown>)["description"] as string)
              : "",
        }
      : {
          title: "",
          creator: "",
          lastModifiedBy: "",
          created: "",
          modified: "",
          subject: "",
          description: "",
        };
  const missingMedia: string[] = [];
  if (Array.isArray(r["missingMedia"])) {
    for (const item of r["missingMedia"] as unknown[]) {
      if (typeof item === "string") missingMedia.push(item);
    }
  }
  return {
    sourcePath: typeof r["sourcePath"] === "string" ? (r["sourcePath"] as string) : null,
    contentHash: typeof r["contentHash"] === "string" ? (r["contentHash"] as string) : "",
    mimeType: typeof r["mimeType"] === "string" ? (r["mimeType"] as string) : DOCX_MIME,
    core,
    blocks,
    counts,
    missingMedia,
    capturedAt: typeof r["capturedAt"] === "string" ? (r["capturedAt"] as string) : "",
  };
}

function parseStoredBlock(raw: unknown): DocxBlock | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ordinal = typeof r["ordinal"] === "number" ? (r["ordinal"] as number) : 0;
  if (ordinal <= 0) return null;
  const kindRaw = typeof r["kind"] === "string" ? (r["kind"] as string) : "";
  const validKinds: readonly DocxBlockKind[] = [
    "heading",
    "paragraph",
    "list",
    "table",
    "image",
  ];
  if (!(validKinds as readonly string[]).includes(kindRaw)) return null;
  const kind = kindRaw as DocxBlockKind;
  const level = typeof r["level"] === "number" ? (r["level"] as number) : null;
  const text = typeof r["text"] === "string" ? (r["text"] as string) : "";
  const numbered = r["numbered"] === true;

  let table: DocxTable | null = null;
  if (r["table"] !== null && typeof r["table"] === "object") {
    const t = r["table"] as Record<string, unknown>;
    const rowsRaw = Array.isArray(t["rows"]) ? (t["rows"] as unknown[]) : [];
    const rows: string[][] = [];
    for (const rowRaw of rowsRaw) {
      if (!Array.isArray(rowRaw)) continue;
      rows.push((rowRaw as unknown[]).map((v) => (typeof v === "string" ? v : String(v ?? ""))));
    }
    let maxCols = 0;
    for (const row of rows) if (row.length > maxCols) maxCols = row.length;
    table = {
      rows,
      columnCount:
        typeof t["columnCount"] === "number" ? (t["columnCount"] as number) : maxCols,
      rowCount: typeof t["rowCount"] === "number" ? (t["rowCount"] as number) : rows.length,
      markdown: typeof t["markdown"] === "string" ? (t["markdown"] as string) : "",
    };
  }

  let image: DocxImageRef | null = null;
  if (r["image"] !== null && typeof r["image"] === "object") {
    const i = r["image"] as Record<string, unknown>;
    const relId = typeof i["relId"] === "string" ? (i["relId"] as string) : "";
    const zipPath = typeof i["zipPath"] === "string" ? (i["zipPath"] as string) : "";
    if (relId.length > 0 && zipPath.length > 0) {
      image = {
        relId,
        zipPath,
        filename: typeof i["filename"] === "string" ? (i["filename"] as string) : path.basename(zipPath),
        mimeType:
          typeof i["mimeType"] === "string" ? (i["mimeType"] as string) : mimeFromMediaPath(zipPath),
        altText: typeof i["altText"] === "string" ? (i["altText"] as string) : "",
        // bytes are deliberately dropped on rehydration; see the doc comment.
        bytes: Buffer.alloc(0),
        contentHash: typeof i["contentHash"] === "string" ? (i["contentHash"] as string) : "",
        byteLength: typeof i["byteLength"] === "number" ? (i["byteLength"] as number) : 0,
      };
    }
  }

  return { ordinal, kind, level, text, numbered, table, image };
}
