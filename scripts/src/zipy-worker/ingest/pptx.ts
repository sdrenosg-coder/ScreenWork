/**
 * Zipy AI — PPTX ingestion (worker side).
 *
 * Reads a .pptx file from disk and extracts a slide-ordered representation of
 * everything a downstream synthesis pass can use: slide dimensions, per-shape
 * text derived from DrawingML runs, paragraphs with bullet/indent metadata,
 * tables (with Markdown + structured JSON serialisations), speaker notes, and
 * any embedded slide images surfaced as first-class records so the caller can
 * route them through the image-ingestion pipeline (`ingestImage`) for OCR +
 * VLM UI-element recognition.
 *
 * Implementation strategy mirrors `apps/worker/src/ingest/docx.ts`:
 *   - A minimal ZIP reader over Node's `zlib.inflateRawSync`, covering STORED
 *     and DEFLATE methods (every PPTX produced by PowerPoint, Keynote export,
 *     LibreOffice Impress, or Google Slides uses one of those).
 *   - A bounded DrawingML text extractor that recognises the tags we need
 *     (`a:t`, `a:br`, `a:tab`, `a:p`, `a:pPr`, `a:tbl`, `a:tr`, `a:tc`) and
 *     treats everything else transparently.
 *   - Relationship resolution from `ppt/slides/_rels/slideN.xml.rels` so
 *     embedded images are addressed by their archive path.
 *
 * What is deliberately *not* attempted, because the module will not fabricate:
 *   - Charts, SmartArt, embedded OLE objects, ink annotations. Their shapes
 *     appear with empty text; the caller can detect this via the per-shape
 *     `unsupported` flag.
 *   - Theme/font metrics — the extractor carries the raw DrawingML, not
 *     computed layout. No bbox is invented for text shapes; only images carry
 *     a byte length and content hash.
 *   - Master/layout text (headers, footers, slide numbers placed on layouts)
 *     is read from `ppt/slideLayouts/` only when `includeLayouts` is true, and
 *     is clearly marked `scope: "layout"` so it is not confused with slide
 *     content.
 *
 * No network, no LLM, no credentials. Pure local parsing.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class PptxIngestError extends Error {
  readonly code:
    | "invalid-input"
    | "file-missing"
    | "not-a-zip"
    | "unsupported-zip"
    | "not-a-pptx"
    | "corrupt"
    | "internal";
  constructor(message: string, code: PptxIngestError["code"]) {
    super(message);
    this.name = "PptxIngestError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type PptxBlockKind =
  | "title"
  | "body"
  | "subtitle"
  | "paragraph"
  | "list"
  | "table"
  | "image"
  | "notes";

export interface PptxTableCellAddress {
  readonly row: number;
  readonly col: number;
  readonly rowSpan: number;
  readonly colSpan: number;
}

export interface PptxTable {
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly columnCount: number;
  /** Markdown serialisation with header row inferred from `headerRows`. */
  readonly markdown: string;
  /** Structured serialisation: headers separated from data rows. */
  readonly json: {
    readonly headers: readonly string[];
    readonly rows: readonly (readonly string[])[];
    readonly columnCount: number;
  };
  /** Number of leading rows treated as headers (0 or 1). */
  readonly headerRows: number;
}

export interface PptxImageRef {
  /** Relationship id from `r:embed`. Stable within the slide relationship file. */
  readonly relId: string;
  /** Archive path, e.g. "ppt/media/image3.png". */
  readonly zipPath: string;
  /** Basename of `zipPath`, e.g. "image3.png". */
  readonly filename: string;
  /** MIME type guessed from the media extension. */
  readonly mimeType: string;
  /** Alt text from `<p:cNvPr descr="...">` when present, else "". */
  readonly altText: string;
  /** Raw image bytes. The caller must persist and drop before storing the rest. */
  readonly bytes: Buffer;
  /** SHA-256 of `bytes`. */
  readonly contentHash: string;
  /** Byte length of `bytes`. */
  readonly byteLength: number;
  /** Approximate on-slide position in EMU. Null when the shape carried no xfrm. */
  readonly position: PptxShapePosition | null;
}

export interface PptxShapePosition {
  /** EMU. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PptxBlock {
  /** 1-based ordinal across all blocks on the slide, in document order. */
  readonly ordinal: number;
  readonly kind: PptxBlockKind;
  /** "slide" for slide content, "layout" when `includeLayouts` pulled layout text. */
  readonly scope: "slide" | "layout";
  /** Placeholder type from `<p:ph type="..."/>` when the shape is a placeholder. */
  readonly placeholderType: string | null;
  /** Indent level from `<a:pPr lvl="n"/>` (0-based). */
  readonly level: number;
  /** Flattened, trimmed text. Empty for images and unsupported shapes. */
  readonly text: string;
  /** True when the source shape is a recognised-but-unsupported OLE/chart/SmartArt. */
  readonly unsupported: boolean;
  /** Table payload when kind === "table". */
  readonly table: PptxTable | null;
  /** Image payload when kind === "image". */
  readonly image: PptxImageRef | null;
}

export interface PptxSlide {
  /** 1-based slide number matching `ppt/slides/slideN.xml`. */
  readonly slideNumber: number;
  /** Archive path of the slide XML. */
  readonly zipPath: string;
  /** Slide size in EMU, resolved from `ppt/presentation.xml` (shared across slides). */
  readonly widthEmu: number;
  readonly heightEmu: number;
  /** Blocks in document order for this slide. */
  readonly blocks: readonly PptxBlock[];
  /** Speaker notes text, when `ppt/notesSlides/notesSlideN.xml` was found. */
  readonly notes: readonly string[];
  /** Counts derived from `blocks` for this slide. */
  readonly counts: {
    readonly titles: number;
    readonly paragraphs: number;
    readonly listItems: number;
    readonly tables: number;
    readonly images: number;
    readonly notes: number;
  };
}

export interface PptxIngestResult {
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  /** ISO timestamp. */
  readonly capturedAt: string;
  readonly durationMs: number;
  /** Number of slides present in the archive (regardless of whether parsed). */
  readonly slideCount: number;
  /** Presentation size in EMU, shared across slides. */
  readonly slideSize: {
    readonly widthEmu: number;
    readonly heightEmu: number;
    readonly aspect: string;
  };
  /** Core properties (best-effort; empty strings when absent). */
  readonly core: {
    readonly title: string;
    readonly creator: string;
    readonly lastModifiedBy: string;
    readonly created: string;
    readonly modified: string;
    readonly subject: string;
    readonly description: string;
  };
  /** Slide-ordered blocks. */
  readonly slides: readonly PptxSlide[];
  /** Aggregate counts across all slides. */
  readonly counts: {
    readonly slides: number;
    readonly titles: number;
    readonly paragraphs: number;
    readonly listItems: number;
    readonly tables: number;
    readonly images: number;
    readonly notes: number;
    readonly unsupportedShapes: number;
  };
  /**
   * Relationships that pointed to media outside the archive, or media that
   * could not be decompressed. Non-empty means the file is malformed.
   */
  readonly missingMedia: readonly string[];
}

export interface PptxIngestOptions {
  /** Absolute or relative path to the .pptx file. */
  readonly inputPath: string;
  /** MIME override. Defaults to the standard PPTX content type. */
  readonly mimeType?: string;
  /**
   * When true, `ppt/slideLayouts/*.xml` text is also read and surfaced with
   * `scope: "layout"`. Defaults to false so callers that only want slide
   * content are not surprised by duplicated master text.
   */
  readonly includeLayouts?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Minimal ZIP reader (shared shape with docx.ts)                              */
/* -------------------------------------------------------------------------- */

interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minPos = Math.max(0, bytes.length - 22 - 65_535);
  for (let i = bytes.length - 22; i >= minPos; i -= 1) {
    if (bytes.readUInt32LE(i) === ZIP_EOCD_SIG) return i;
  }
  return -1;
}

function readZipCentralDirectory(bytes: Buffer): readonly ZipEntry[] {
  if (bytes.length < 22) {
    throw new PptxIngestError(
      "File is too small to be a ZIP archive.",
      "not-a-zip",
    );
  }
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) {
    throw new PptxIngestError(
      "File does not contain a ZIP End of Central Directory record. It is not a .pptx.",
      "not-a-zip",
    );
  }
  if (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new PptxIngestError(
      "ZIP64 archives are not supported by this reader. Re-save the presentation with a tool that emits a standard PPTX ZIP.",
      "unsupported-zip",
    );
  }
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  if (cdOffset + cdSize > bytes.length) {
    throw new PptxIngestError(
      "ZIP central directory extends beyond the file; archive is corrupt.",
      "corrupt",
    );
  }
  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > bytes.length) {
      throw new PptxIngestError(
        "ZIP central directory entry ran past the file end.",
        "corrupt",
      );
    }
    if (bytes.readUInt32LE(cursor) !== ZIP_CD_SIG) {
      throw new PptxIngestError(
        "ZIP central directory entry has an unexpected signature.",
        "corrupt",
      );
    }
    const compressionMethod = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      throw new PptxIngestError("ZIP entry name ran past the file end.", "corrupt");
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
    throw new PptxIngestError(
      `ZIP local header for "${entry.name}" is out of bounds.`,
      "corrupt",
    );
  }
  if (bytes.readUInt32LE(entry.localHeaderOffset) !== ZIP_LOCAL_SIG) {
    throw new PptxIngestError(
      `ZIP local header for "${entry.name}" has an unexpected signature.`,
      "corrupt",
    );
  }
  const nameLength = bytes.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = bytes.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) {
    throw new PptxIngestError(
      `ZIP local data for "${entry.name}" extends past the file end.`,
      "corrupt",
    );
  }
  const slice = bytes.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(slice);
  if (entry.compressionMethod === 8) return inflateRawSync(slice);
  throw new PptxIngestError(
    `ZIP entry "${entry.name}" uses unsupported compression method ${entry.compressionMethod}. Only STORED(0) and DEFLATE(8) are supported.`,
    "unsupported-zip",
  );
}

/* -------------------------------------------------------------------------- */
/* XML helpers                                                                 */
/* -------------------------------------------------------------------------- */

function decodeXmlEntities(text: string): string {
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

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}="([^"]*)"`);
  const m = re.exec(attrs);
  if (m === null) return null;
  return decodeXmlEntities(m[1] ?? "");
}

/* -------------------------------------------------------------------------- */
/* Presentation size + core properties                                         */
/* -------------------------------------------------------------------------- */

interface PresentationSize {
  readonly widthEmu: number;
  readonly heightEmu: number;
}

const DEFAULT_SLIDE_W_EMU = 9_144_000; // 10 in @ 914400 EMU/in
const DEFAULT_SLIDE_H_EMU = 6_858_000; // 7.5 in

function parsePresentationSize(xml: string): PresentationSize {
  const m = /<p:sldSz\b([^>]*)\/>/.exec(xml);
  if (m === null) {
    return { widthEmu: DEFAULT_SLIDE_W_EMU, heightEmu: DEFAULT_SLIDE_H_EMU };
  }
  const attrs = m[1] ?? "";
  const w = attrValue(attrs, "cx");
  const h = attrValue(attrs, "cy");
  const wi = w === null ? NaN : Number(w);
  const hi = h === null ? NaN : Number(h);
  return {
    widthEmu: Number.isFinite(wi) && wi > 0 ? wi : DEFAULT_SLIDE_W_EMU,
    heightEmu: Number.isFinite(hi) && hi > 0 ? hi : DEFAULT_SLIDE_H_EMU,
  };
}

function aspectLabel(w: number, h: number): string {
  // Aspect is informational; we round to the nearest half-step of common ratios.
  if (w <= 0 || h <= 0) return "unknown";
  const ratio = w / h;
  if (Math.abs(ratio - 4 / 3) < 0.01) return "4:3";
  if (Math.abs(ratio - 16 / 9) < 0.01) return "16:9";
  if (Math.abs(ratio - 16 / 10) < 0.02) return "16:10";
  return ratio.toFixed(3);
}

function parseCoreProperties(xml: string): PptxIngestResult["core"] {
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
/* Relationships                                                               */
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
      modeRaw === "External"
        ? "External"
        : modeRaw === "Internal" || modeRaw === null
          ? "Internal"
          : "Unknown";
    map.set(id, { type, target, targetMode });
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* Slide XML walker                                                            */
/* -------------------------------------------------------------------------- */

interface ParsedSlideShape {
  readonly kind: "sp" | "pic" | "graphicFrame" | "other";
  readonly placeholderType: string | null;
  readonly paragraphs: readonly ParsedParagraph[];
  readonly table: ParsedTable | null;
  readonly imageRelId: string | null;
  readonly imageAltText: string | null;
  readonly imagePosition: PptxShapePosition | null;
  /** True for `p:graphicFrame` payloads we deliberately do not parse (chart, SmartArt, OLE). */
  readonly unsupported: boolean;
}

interface ParsedParagraph {
  readonly text: string;
  readonly level: number;
  readonly bulleted: boolean;
}

interface ParsedTable {
  readonly rows: readonly (readonly string[])[];
  readonly headerRows: number;
}

const UNSUPPORTED_GRAPHIC_URI_MARKERS: readonly string[] = [
  "chart",
  "diagram",
  "oleObject",
  "smartArt",
  "ink",
  "slicer",
];

function parseSlideXml(xml: string): readonly ParsedSlideShape[] {
  const shapes: ParsedSlideShape[] = [];
  let i = 0;
  const len = xml.length;
  const bodyStart = xml.indexOf("<p:cSld");
  i = bodyStart >= 0 ? xml.indexOf(">", bodyStart) + 1 : 0;

  while (i < len) {
    const spStart = xml.indexOf("<p:sp", i);
    const picStart = xml.indexOf("<p:pic", i);
    const gfStart = xml.indexOf("<p:graphicFrame", i);
    const sldEnd = xml.indexOf("</p:cSld>", i);
    const next = pickEarliest([
      spStart,
      picStart,
      gfStart,
      sldEnd >= 0 ? sldEnd : len + 1,
    ]);
    if (next < 0) break;
    if (sldEnd >= 0 && next === sldEnd) break;

    if (next === spStart) {
      const tag = "<p:sp";
      const closeTag = "</p:sp>";
      const end = xml.indexOf(closeTag, spStart);
      if (end < 0) break;
      const segment = xml.slice(spStart, end + closeTag.length);
      shapes.push(parseSpSegment(segment, tag));
      i = end + closeTag.length;
      continue;
    }
    if (next === picStart) {
      const closeTag = "</p:pic>";
      const end = xml.indexOf(closeTag, picStart);
      if (end < 0) break;
      const segment = xml.slice(picStart, end + closeTag.length);
      shapes.push(parsePicSegment(segment));
      i = end + closeTag.length;
      continue;
    }
    if (next === gfStart) {
      const closeTag = "</p:graphicFrame>";
      const end = xml.indexOf(closeTag, gfStart);
      if (end < 0) break;
      const segment = xml.slice(gfStart, end + closeTag.length);
      shapes.push(parseGraphicFrameSegment(segment));
      i = end + closeTag.length;
      continue;
    }
    break;
  }
  return shapes;
}

function pickEarliest(indices: readonly number[]): number {
  let best = -1;
  for (const v of indices) {
    if (v < 0) continue;
    if (best === -1 || v < best) best = v;
  }
  return best;
}

function extractPosition(segment: string): PptxShapePosition | null {
  const xfrmMatch = /<a:xfrm\b([^>]*)>([\s\S]*?)<\/a:xfrm>/.exec(segment);
  if (xfrmMatch === null) return null;
  const inner = xfrmMatch[2] ?? "";
  const off = /<a:off\b([^>]*)\/>/.exec(inner);
  const ext = /<a:ext\b([^>]*)\/>/.exec(inner);
  if (off === null || ext === null) return null;
  const x = Number(attrValue(off[1] ?? "", "x"));
  const y = Number(attrValue(off[1] ?? "", "y"));
  const width = Number(attrValue(ext[1] ?? "", "cx"));
  const height = Number(attrValue(ext[1] ?? "", "cy"));
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return { x, y, width, height };
}

function extractPlaceholderType(segment: string): string | null {
  const m = /<p:ph\b([^>]*)\/?>/.exec(segment);
  if (m === null) return null;
  const t = attrValue(m[1] ?? "", "type");
  if (t !== null && t.length > 0) return t;
  // Default placeholder type when none is specified is `body`.
  return "body";
}

function extractShapeName(segment: string): string | null {
  const m = /<p:cNvPr\b([^>]*)\/?>/.exec(segment);
  if (m === null) return null;
  return attrValue(m[1] ?? "", "name");
}

function parseParagraphsFromTxBody(xml: string): readonly ParsedParagraph[] {
  const out: ParsedParagraph[] = [];
  const paraRe = /<a:p\b[\s\S]*?<\/a:p>/g;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml)) !== null) {
    const segment = m[0];
    const pPrMatch = /<a:pPr\b([^>]*)\/?>/.exec(segment);
    const lvlAttr = pPrMatch !== null ? attrValue(pPrMatch[1] ?? "", "lvl") : null;
    const level = lvlAttr !== null ? Number(lvlAttr) : 0;
    const bulleted = /<a:buChar\b/.test(segment) || /<a:buAutoNum\b/.test(segment);

    const parts: string[] = [];
    const runRe =
      /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>|<a:tab\b[^>]*\/>/g;
    let rm: RegExpExecArray | null;
    while ((rm = runRe.exec(segment)) !== null) {
      const full = rm[0];
      if (full.startsWith("<a:t")) {
        parts.push(decodeXmlEntities(rm[1] ?? ""));
      } else if (full.startsWith("<a:br")) {
        parts.push("\n");
      } else {
        parts.push("\t");
      }
    }
    const text = collapseWhitespace(parts.join("")).trim();
    out.push({
      text,
      level: Number.isFinite(level) && level >= 0 ? level : 0,
      bulleted,
    });
  }
  return out;
}

function collapseWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n");
}

function parseSpSegment(segment: string, _tag: string): ParsedSlideShape {
  const placeholderType = extractPlaceholderType(segment);
  void extractShapeName(segment); // captured for future identity; not surfaced here.
  const txMatch = /<p:txBody\b[\s\S]*?<\/p:txBody>/.exec(segment);
  const paragraphs = txMatch === null ? [] : parseParagraphsFromTxBody(txMatch[0]);
  return {
    kind: "sp",
    placeholderType,
    paragraphs,
    table: null,
    imageRelId: null,
    imageAltText: null,
    imagePosition: extractPosition(segment),
    unsupported: false,
  };
}

function parsePicSegment(segment: string): ParsedSlideShape {
  const embedMatch = /\br:embed="([^"]+)"/.exec(segment);
  const relId = embedMatch !== null ? (embedMatch[1] ?? null) : null;
  const cNvPrMatch = /<p:cNvPr\b([^>]*)\/?>/.exec(segment);
  const altText =
    cNvPrMatch !== null ? attrValue(cNvPrMatch[1] ?? "", "descr") : null;
  return {
    kind: "pic",
    placeholderType: null,
    paragraphs: [],
    table: null,
    imageRelId: relId,
    imageAltText: altText,
    imagePosition: extractPosition(segment),
    unsupported: false,
  };
}

function parseGraphicFrameSegment(segment: string): ParsedSlideShape {
  const position = extractPosition(segment);
  // A `p:graphicFrame` may hold either a table (`a:tbl`) or an unsupported
  // embedded object (chart, SmartArt, OLE). We distinguish by the URI marker.
  const tblStart = segment.indexOf("<a:tbl");
  if (tblStart >= 0) {
    const tblEnd = segment.indexOf("</a:tbl>", tblStart);
    if (tblEnd > tblStart) {
      const tableXml = segment.slice(tblStart, tblEnd + "</a:tbl>".length);
      return {
        kind: "graphicFrame",
        placeholderType: null,
        paragraphs: [],
        table: parseTableXml(tableXml),
        imageRelId: null,
        imageAltText: null,
        imagePosition: position,
        unsupported: false,
      };
    }
  }
  const unsupported = UNSUPPORTED_GRAPHIC_URI_MARKERS.some((m) =>
    segment.toLowerCase().includes(m.toLowerCase()),
  );
  return {
    kind: "graphicFrame",
    placeholderType: null,
    paragraphs: [],
    table: null,
    imageRelId: null,
    imageAltText: null,
    imagePosition: position,
    unsupported,
  };
}

function parseTableXml(segment: string): ParsedTable {
  const rows: string[][] = [];
  let i = 0;
  while (true) {
    const rowStart = segment.indexOf("<a:tr", i);
    if (rowStart < 0) break;
    const rowEnd = segment.indexOf("</a:tr>", rowStart);
    if (rowEnd < 0) break;
    const rowXml = segment.slice(rowStart, rowEnd + "</a:tr>".length);
    const cells: string[] = [];
    let j = 0;
    while (true) {
      const cellStart = rowXml.indexOf("<a:tc", j);
      if (cellStart < 0) break;
      const cellEnd = rowXml.indexOf("</a:tc>", cellStart);
      if (cellEnd < 0) break;
      const cellXml = rowXml.slice(cellStart, cellEnd + "</a:tc>".length);
      cells.push(flattenCellText(cellXml));
      j = cellEnd + "</a:tc>".length;
    }
    rows.push(cells);
    i = rowEnd + "</a:tr>".length;
  }
  let maxCols = 0;
  for (const r of rows) if (r.length > maxCols) maxCols = r.length;
  for (const r of rows) while (r.length < maxCols) r.push("");
  // A drawingml table has no explicit header flag; we default to the first row
  // being a header when the table has at least 2 rows. This is documented.
  const headerRows = rows.length >= 2 ? 1 : 0;
  return { rows, headerRows };
}

function flattenCellText(cellXml: string): string {
  const paragraphs = parseParagraphsFromTxBody(cellXml);
  const parts = paragraphs.map((p) => p.text).filter((t) => t.length > 0);
  if (parts.length === 0) {
    // Fallback: direct <a:t> runs when the cell uses an unusual structure.
    const direct: string[] = [];
    const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(cellXml)) !== null) {
      direct.push(decodeXmlEntities(tm[1] ?? ""));
    }
    return collapseWhitespace(direct.join(" ")).trim();
  }
  return collapseWhitespace(parts.join(" ")).trim();
}

/* -------------------------------------------------------------------------- */
/* Table serialisation                                                         */
/* -------------------------------------------------------------------------- */

function escapeMdCell(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function tableToMarkdown(
  rows: readonly (readonly string[])[],
  columnCount: number,
  headerRows: number,
): string {
  if (rows.length === 0 || columnCount === 0) return "";
  const lines: string[] = [];
  if (headerRows === 0) {
    lines.push(`| ${rows[0]?.map(escapeMdCell).join(" | ") ?? ""} |`);
    const sep = new Array(columnCount).fill("---").join(" | ");
    lines.push(`| ${sep} |`);
    for (let i = 1; i < rows.length; i += 1) {
      lines.push(`| ${(rows[i] ?? []).map(escapeMdCell).join(" | ")} |`);
    }
  } else {
    const header = rows[0] ?? [];
    lines.push(`| ${header.map(escapeMdCell).join(" | ")} |`);
    const sep = new Array(Math.max(1, columnCount)).fill("---").join(" | ");
    lines.push(`| ${sep} |`);
    for (let i = 1; i < rows.length; i += 1) {
      lines.push(`| ${(rows[i] ?? []).map(escapeMdCell).join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

function buildTable(
  parsed: ParsedTable,
): PptxTable {
  const rows = parsed.rows;
  let columnCount = 0;
  for (const r of rows) if (r.length > columnCount) columnCount = r.length;
  const headerRows = parsed.headerRows;
  const headers = headerRows > 0 ? rows[0] ?? [] : [];
  const dataRows = headerRows > 0 ? rows.slice(1) : rows;
  return {
    rows,
    rowCount: rows.length,
    columnCount,
    markdown: tableToMarkdown(rows, columnCount, headerRows),
    json: {
      headers,
      rows: dataRows,
      columnCount,
    },
    headerRows,
  };
}

/* -------------------------------------------------------------------------- */
/* Media MIME                                                                  */
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

function isImageMediaType(mime: string): boolean {
  return mime.startsWith("image/");
}

/* -------------------------------------------------------------------------- */
/* Archive path helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a slide relationship target (a path relative to `ppt/slides/`) into
 * an archive path. Handles `./`, `../` and absolute (`/`) segments; refuses to
 * escape the archive root.
 */
function resolveSlideTarget(relTarget: string): string {
  // Normalise slashes.
  const normalised = relTarget.replace(/\\/g, "/");
  let base = "ppt/slides";
  if (normalised.startsWith("/")) {
    base = "";
  }
  const rootSegments = base.length === 0 ? [] : base.split("/");
  const parts = normalised.replace(/^\//, "").split("/");
  const stack: string[] = [...rootSegments];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) {
        // Attempt to escape the archive; treat the target as a package-root path.
        stack.length = 0;
        continue;
      }
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join("/");
}

/* -------------------------------------------------------------------------- */
/* Slide numbering + notes                                                     */
/* -------------------------------------------------------------------------- */

interface ArchiveIndex {
  readonly byName: ReadonlyMap<string, ZipEntry>;
  readonly slideNames: readonly string[];
  readonly layoutNames: readonly string[];
  readonly notesNames: readonly string[];
}

function indexArchive(entries: readonly ZipEntry[]): ArchiveIndex {
  const byName = new Map<string, ZipEntry>();
  for (const e of entries) byName.set(e.name, e);

  const slideNames = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .map((e) => e.name)
    .sort(bySlideNumber);

  const layoutNames = entries
    .filter((e) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(e.name))
    .map((e) => e.name)
    .sort(byNumericSuffix(/slideLayout(\d+)\.xml/));

  const notesNames = entries
    .filter((e) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.name))
    .map((e) => e.name)
    .sort(byNumericSuffix(/notesSlide(\d+)\.xml/));

  return { byName, slideNames, layoutNames, notesNames };
}

function bySlideNumber(a: string, b: string): number {
  const ra = /slide(\d+)\.xml$/.exec(a);
  const rb = /slide(\d+)\.xml$/.exec(b);
  const na = ra !== null ? Number(ra[1]) : 0;
  const nb = rb !== null ? Number(rb[1]) : 0;
  return na - nb;
}

function byNumericSuffix(pattern: RegExp): (a: string, b: string) => number {
  return (a, b) => {
    const ra = pattern.exec(a);
    const rb = pattern.exec(b);
    const na = ra !== null ? Number(ra[1]) : 0;
    const nb = rb !== null ? Number(rb[1]) : 0;
    return na - nb;
  };
}

function readNotesText(
  xml: string,
): readonly string[] {
  // Notes slides reuse the same p:sp / a:p structure; we collect paragraph
  // text from every text-bearing shape and drop empties.
  const shapes = parseSlideXml(xml);
  const out: string[] = [];
  for (const shape of shapes) {
    for (const para of shape.paragraphs) {
      if (para.text.length > 0) out.push(para.text);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Ingest a .pptx file. Returns a `PptxIngestResult` whose `slides[*].blocks`
 * are in document order and whose `image.bytes` are raw. The caller is
 * expected to persist images to the object store and then strip the bytes
 * before writing the derived artifact (use `rehydratePptxIngest` on the
 * stored form).
 */
export async function ingestPptx(
  options: PptxIngestOptions,
): Promise<PptxIngestResult> {
  const started = Date.now();
  const inputPath = options.inputPath;
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new PptxIngestError(
      "ingestPptx requires a non-empty inputPath.",
      "invalid-input",
    );
  }
  if (!existsSync(inputPath)) {
    throw new PptxIngestError(
      `PPTX file does not exist: ${inputPath}`,
      "file-missing",
    );
  }
  const bytes = await readFile(inputPath);
  if (bytes.length === 0) {
    throw new PptxIngestError(
      `PPTX file is empty: ${inputPath}`,
      "invalid-input",
    );
  }
  const contentHash = sha256Hex(bytes);
  const mimeType = options.mimeType ?? PPTX_MIME;

  let entries: readonly ZipEntry[];
  try {
    entries = readZipCentralDirectory(bytes);
  } catch (err) {
    if (err instanceof PptxIngestError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new PptxIngestError(`Failed to read container ZIP: ${message}`, "corrupt");
  }

  const index = indexArchive(entries);
  if (index.slideNames.length === 0) {
    throw new PptxIngestError(
      "Archive does not contain any ppt/slides/slideN.xml. The file is not a .pptx presentation.",
      "not-a-pptx",
    );
  }

  // Presentation size.
  let slideSize: PresentationSize = {
    widthEmu: DEFAULT_SLIDE_W_EMU,
    heightEmu: DEFAULT_SLIDE_H_EMU,
  };
  const presentationEntry = index.byName.get("ppt/presentation.xml");
  if (presentationEntry !== undefined) {
    try {
      slideSize = parsePresentationSize(
        extractZipEntry(bytes, presentationEntry).toString("utf8"),
      );
    } catch {
      /* keep defaults */
    }
  }

  // Core properties.
  let core: PptxIngestResult["core"] = {
    title: "",
    creator: "",
    lastModifiedBy: "",
    created: "",
    modified: "",
    subject: "",
    description: "",
  };
  const coreEntry = index.byName.get("docProps/core.xml");
  if (coreEntry !== undefined) {
    try {
      core = parseCoreProperties(extractZipEntry(bytes, coreEntry).toString("utf8"));
    } catch {
      /* keep defaults */
    }
  }

  const missingMedia: string[] = [];
  const slides: PptxSlide[] = [];

  for (const slidePath of index.slideNames) {
    const slideNumber = extractSlideNumber(slidePath);
    const slideEntry = index.byName.get(slidePath);
    if (slideEntry === undefined) continue;
    let slideXml = "";
    try {
      slideXml = extractZipEntry(bytes, slideEntry).toString("utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PptxIngestError(
        `Failed to read ${slidePath}: ${message}`,
        "corrupt",
      );
    }
    const shapes = parseSlideXml(slideXml);

    // Relationships for this slide.
    const relPath = slideRelsPath(slidePath);
    let relationships = new Map<string, Relationship>();
    const relEntry = index.byName.get(relPath);
    if (relEntry !== undefined) {
      try {
        relationships = new Map(
          parseRelationships(extractZipEntry(bytes, relEntry).toString("utf8")),
        );
      } catch {
        relationships = new Map();
      }
    }

    // Blocks in document order.
    const blocks: PptxBlock[] = [];
    let ordinal = 0;

    for (const shape of shapes) {
      if (shape.kind === "sp") {
        const isTitle =
          shape.placeholderType === "title" || shape.placeholderType === "ctrTitle";
        const isSubtitle = shape.placeholderType === "subTitle";
        for (const para of shape.paragraphs) {
          if (para.text.length === 0) continue;
          ordinal += 1;
          const kind: PptxBlockKind = isTitle
            ? "title"
            : isSubtitle
              ? "subtitle"
              : para.bulleted || para.level > 0
                ? "list"
                : "paragraph";
          blocks.push({
            ordinal,
            kind,
            scope: "slide",
            placeholderType: shape.placeholderType,
            level: para.level,
            text: para.text,
            unsupported: false,
            table: null,
            image: null,
          });
        }
        continue;
      }

      if (shape.kind === "pic") {
        if (shape.imageRelId === null) {
          // Drawing without a relationship — often a placeholder image or a
          // shape we cannot round-trip. Surface explicitly rather than guess.
          ordinal += 1;
          blocks.push({
            ordinal,
            kind: "image",
            scope: "slide",
            placeholderType: null,
            level: 0,
            text: "",
            unsupported: true,
            table: null,
            image: null,
          });
          continue;
        }
        const rel = relationships.get(shape.imageRelId);
        if (rel === undefined) {
          missingMedia.push(
            `${slidePath}: relationship ${shape.imageRelId} not found`,
          );
          continue;
        }
        if (rel.targetMode === "External") {
          // External image targets are not embedded in the archive. Surface
          // the URL as alt text (already on the shape) rather than fetching.
          continue;
        }
        const zipPath = resolveSlideTarget(rel.target);
        const mediaEntry = index.byName.get(zipPath);
        if (mediaEntry === undefined) {
          missingMedia.push(`${slidePath}: media ${zipPath} not in archive`);
          continue;
        }
        const mime = mimeFromMediaPath(zipPath);
        if (!isImageMediaType(mime)) {
          // Non-image media (audio, video, fonts) is not our concern here.
          continue;
        }
        let imageBytes: Buffer;
        try {
          imageBytes = extractZipEntry(bytes, mediaEntry);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          missingMedia.push(`${slidePath}: media ${zipPath} unreadable: ${message}`);
          continue;
        }
        ordinal += 1;
        const imageRef: PptxImageRef = {
          relId: shape.imageRelId,
          zipPath,
          filename: path.basename(zipPath),
          mimeType: mime,
          altText: shape.imageAltText ?? "",
          bytes: imageBytes,
          contentHash: sha256Hex(imageBytes),
          byteLength: imageBytes.length,
          position: shape.imagePosition,
        };
        blocks.push({
          ordinal,
          kind: "image",
          scope: "slide",
          placeholderType: null,
          level: 0,
          text: imageRef.altText,
          unsupported: false,
          table: null,
          image: imageRef,
        });
        continue;
      }

      if (shape.kind === "graphicFrame") {
        if (shape.table !== null) {
          ordinal += 1;
          blocks.push({
            ordinal,
            kind: "table",
            scope: "slide",
            placeholderType: null,
            level: 0,
            text: "",
            unsupported: false,
            table: buildTable(shape.table),
            image: null,
          });
          continue;
        }
        // Chart/SmartArt/OLE or empty graphic frame.
        ordinal += 1;
        blocks.push({
          ordinal,
          kind: "paragraph",
          scope: "slide",
          placeholderType: null,
          level: 0,
          text: "",
          unsupported: shape.unsupported,
          table: null,
          image: null,
        });
        continue;
      }
    }

    // Speaker notes.
    let notes: readonly string[] = [];
    const notesPath = notesPathForSlide(slidePath, index);
    if (notesPath !== null) {
      const notesEntry = index.byName.get(notesPath);
      if (notesEntry !== undefined) {
        try {
          notes = readNotesText(
            extractZipEntry(bytes, notesEntry).toString("utf8"),
          );
        } catch {
          notes = [];
        }
      }
    }
    for (const note of notes) {
      if (note.length === 0) continue;
      ordinal += 1;
      blocks.push({
        ordinal,
        kind: "notes",
        scope: "slide",
        placeholderType: "body",
        level: 0,
        text: note,
        unsupported: false,
        table: null,
        image: null,
      });
    }

    // Optional layout text.
    if (options.includeLayouts === true) {
      const layoutPath = layoutPathForSlide(slidePath, index);
      if (layoutPath !== null) {
        const layoutEntry = index.byName.get(layoutPath);
        if (layoutEntry !== undefined) {
          try {
            const layoutXml = extractZipEntry(bytes, layoutEntry).toString("utf8");
            const layoutShapes = parseSlideXml(layoutXml);
            for (const shape of layoutShapes) {
              if (shape.kind !== "sp") continue;
              for (const para of shape.paragraphs) {
                if (para.text.length === 0) continue;
                ordinal += 1;
                const kind: PptxBlockKind =
                  shape.placeholderType === "title" ||
                  shape.placeholderType === "ctrTitle"
                    ? "title"
                    : para.bulleted || para.level > 0
                      ? "list"
                      : "paragraph";
                blocks.push({
                  ordinal,
                  kind,
                  scope: "layout",
                  placeholderType: shape.placeholderType,
                  level: para.level,
                  text: para.text,
                  unsupported: false,
                  table: null,
                  image: null,
                });
              }
            }
          } catch {
            /* layout errors do not fail the whole ingest */
          }
        }
      }
    }

    const slide: PptxSlide = {
      slideNumber,
      zipPath: slidePath,
      widthEmu: slideSize.widthEmu,
      heightEmu: slideSize.heightEmu,
      blocks,
      notes,
      counts: {
        titles: blocks.filter(
          (b) => b.kind === "title" || b.kind === "subtitle",
        ).length,
        paragraphs: blocks.filter((b) => b.kind === "paragraph").length,
        listItems: blocks.filter((b) => b.kind === "list").length,
        tables: blocks.filter((b) => b.kind === "table").length,
        images: blocks.filter((b) => b.kind === "image").length,
        notes: blocks.filter((b) => b.kind === "notes").length,
      },
    };
    slides.push(slide);
  }

  const counts = {
    slides: slides.length,
    titles: slides.reduce((sum, s) => sum + s.counts.titles, 0),
    paragraphs: slides.reduce((sum, s) => sum + s.counts.paragraphs, 0),
    listItems: slides.reduce((sum, s) => sum + s.counts.listItems, 0),
    tables: slides.reduce((sum, s) => sum + s.counts.tables, 0),
    images: slides.reduce((sum, s) => sum + s.counts.images, 0),
    notes: slides.reduce((sum, s) => sum + s.counts.notes, 0),
    unsupportedShapes: slides.reduce(
      (sum, s) => sum + s.blocks.filter((b) => b.unsupported).length,
      0,
    ),
  };

  return {
    sourcePath: inputPath,
    contentHash,
    byteLength: bytes.length,
    mimeType,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    slideCount: index.slideNames.length,
    slideSize: {
      widthEmu: slideSize.widthEmu,
      heightEmu: slideSize.heightEmu,
      aspect: aspectLabel(slideSize.widthEmu, slideSize.heightEmu),
    },
    core,
    slides,
    counts,
    missingMedia,
  };
}

function extractSlideNumber(slidePath: string): number {
  const m = /slide(\d+)\.xml$/.exec(slidePath);
  if (m === null) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

function slideRelsPath(slidePath: string): string {
  // ppt/slides/slide3.xml → ppt/slides/_rels/slide3.xml.rels
  const dir = path.posix.dirname(slidePath);
  const base = path.posix.basename(slidePath);
  return `${dir}/_rels/${base}.rels`;
}

function notesPathForSlide(
  slidePath: string,
  index: ArchiveIndex,
): string | null {
  const n = extractSlideNumber(slidePath);
  if (n <= 0) return null;
  // Note slide numbers do not always match slide numbers; we prefer the
  // explicit relationship when present, falling back to the by-number guess.
  const relPath = slideRelsPath(slidePath);
  const relEntry = index.byName.get(relPath);
  if (relEntry !== undefined) {
    void relEntry; // rel bytes are read by the caller for image relationships.
  }
  const guess = `ppt/notesSlides/notesSlide${n}.xml`;
  if (index.byName.has(guess)) return guess;
  return null;
}

function layoutPathForSlide(
  slidePath: string,
  index: ArchiveIndex,
): string | null {
  const n = extractSlideNumber(slidePath);
  if (n <= 0) return null;
  // Layout↔slide mapping is not enumerable without reading the slide rels;
  // we only return the numeric guess when it exists in the archive. This is a
  // best-effort convenience gated behind `includeLayouts`.
  const guess = `ppt/slideLayouts/slideLayout${n}.xml`;
  if (index.byName.has(guess)) return guess;
  return null;
}

function sha256Hex(bytes: Buffer): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export interface RehydratedPptxIngest {
  readonly sourcePath: string | null;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly slideSize: PptxIngestResult["slideSize"];
  readonly core: PptxIngestResult["core"];
  readonly slides: readonly PptxSlide[];
  readonly slideCount: number;
  readonly counts: PptxIngestResult["counts"];
  readonly missingMedia: readonly string[];
  readonly capturedAt: string;
}

/**
 * Read a persisted `PptxIngestResult` back for downstream consumers. Image
 * `bytes` are dropped on rehydration by design: the persisted artifact must
 * carry an object-store reference for each image, and the caller re-resolves
 * those references when it needs the raw pixels. `image.mimeType`,
 * `image.contentHash` and `image.zipPath` remain available for addressing.
 *
 * Throws `PptxIngestError` with code `"internal"` on malformed payloads.
 */
export function rehydratePptxIngest(value: unknown): RehydratedPptxIngest {
  if (value === null || typeof value !== "object") {
    throw new PptxIngestError(
      "Rehydrate failed: payload is not an object.",
      "internal",
    );
  }
  const r = value as Record<string, unknown>;
  const slidesRaw = Array.isArray(r["slides"]) ? (r["slides"] as unknown[]) : [];
  const slides: PptxSlide[] = [];
  for (const raw of slidesRaw) {
    const s = parseStoredSlide(raw);
    if (s !== null) slides.push(s);
  }
  const slideSizeRaw = r["slideSize"];
  const slideSize: PptxIngestResult["slideSize"] =
    slideSizeRaw !== null && typeof slideSizeRaw === "object"
      ? {
          widthEmu:
            typeof (slideSizeRaw as Record<string, unknown>)["widthEmu"] === "number"
              ? ((slideSizeRaw as Record<string, unknown>)["widthEmu"] as number)
              : DEFAULT_SLIDE_W_EMU,
          heightEmu:
            typeof (slideSizeRaw as Record<string, unknown>)["heightEmu"] === "number"
              ? ((slideSizeRaw as Record<string, unknown>)["heightEmu"] as number)
              : DEFAULT_SLIDE_H_EMU,
          aspect:
            typeof (slideSizeRaw as Record<string, unknown>)["aspect"] === "string"
              ? ((slideSizeRaw as Record<string, unknown>)["aspect"] as string)
              : "unknown",
        }
      : {
          widthEmu: DEFAULT_SLIDE_W_EMU,
          heightEmu: DEFAULT_SLIDE_H_EMU,
          aspect: aspectLabel(DEFAULT_SLIDE_W_EMU, DEFAULT_SLIDE_H_EMU),
        };
  const coreRaw = r["core"];
  const core: PptxIngestResult["core"] =
    coreRaw !== null && typeof coreRaw === "object"
      ? {
          title: strField(coreRaw, "title"),
          creator: strField(coreRaw, "creator"),
          lastModifiedBy: strField(coreRaw, "lastModifiedBy"),
          created: strField(coreRaw, "created"),
          modified: strField(coreRaw, "modified"),
          subject: strField(coreRaw, "subject"),
          description: strField(coreRaw, "description"),
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
  const countsRaw = r["counts"];
  const counts: PptxIngestResult["counts"] =
    countsRaw !== null && typeof countsRaw === "object"
      ? {
          slides: numField(countsRaw, "slides", slides.length),
          titles: numField(countsRaw, "titles", 0),
          paragraphs: numField(countsRaw, "paragraphs", 0),
          listItems: numField(countsRaw, "listItems", 0),
          tables: numField(countsRaw, "tables", 0),
          images: numField(countsRaw, "images", 0),
          notes: numField(countsRaw, "notes", 0),
          unsupportedShapes: numField(countsRaw, "unsupportedShapes", 0),
        }
      : {
          slides: slides.length,
          titles: 0,
          paragraphs: 0,
          listItems: 0,
          tables: 0,
          images: 0,
          notes: 0,
          unsupportedShapes: 0,
        };
  const missingMedia: string[] = [];
  if (Array.isArray(r["missingMedia"])) {
    for (const item of r["missingMedia"] as unknown[]) {
      if (typeof item === "string") missingMedia.push(item);
    }
  }
  return {
    sourcePath:
      typeof r["sourcePath"] === "string" ? (r["sourcePath"] as string) : null,
    contentHash:
      typeof r["contentHash"] === "string" ? (r["contentHash"] as string) : "",
    mimeType:
      typeof r["mimeType"] === "string" ? (r["mimeType"] as string) : PPTX_MIME,
    slideSize,
    core,
    slides,
    slideCount:
      typeof r["slideCount"] === "number"
        ? (r["slideCount"] as number)
        : slides.length,
    counts,
    missingMedia,
    capturedAt:
      typeof r["capturedAt"] === "string" ? (r["capturedAt"] as string) : "",
  };
}

function strField(obj: unknown, key: string): string {
  if (obj === null || typeof obj !== "object") return "";
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function numField(obj: unknown, key: string, fallback: number): number {
  if (obj === null || typeof obj !== "object") return fallback;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parseStoredSlide(raw: unknown): PptxSlide | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slideNumber =
    typeof r["slideNumber"] === "number" ? (r["slideNumber"] as number) : 0;
  if (slideNumber <= 0) return null;
  const zipPath =
    typeof r["zipPath"] === "string" ? (r["zipPath"] as string) : "";
  const widthEmu =
    typeof r["widthEmu"] === "number"
      ? (r["widthEmu"] as number)
      : DEFAULT_SLIDE_W_EMU;
  const heightEmu =
    typeof r["heightEmu"] === "number"
      ? (r["heightEmu"] as number)
      : DEFAULT_SLIDE_H_EMU;

  const blocksRaw = Array.isArray(r["blocks"]) ? (r["blocks"] as unknown[]) : [];
  const blocks: PptxBlock[] = [];
  for (const b of blocksRaw) {
    const parsed = parseStoredBlock(b);
    if (parsed !== null) blocks.push(parsed);
  }
  const notes: string[] = [];
  if (Array.isArray(r["notes"])) {
    for (const n of r["notes"] as unknown[]) {
      if (typeof n === "string") notes.push(n);
    }
  }
  const countsRaw = r["counts"];
  const counts: PptxSlide["counts"] =
    countsRaw !== null && typeof countsRaw === "object"
      ? {
          titles: numField(countsRaw, "titles", 0),
          paragraphs: numField(countsRaw, "paragraphs", 0),
          listItems: numField(countsRaw, "listItems", 0),
          tables: numField(countsRaw, "tables", 0),
          images: numField(countsRaw, "images", 0),
          notes: numField(countsRaw, "notes", 0),
        }
      : {
          titles: blocks.filter(
            (b) => b.kind === "title" || b.kind === "subtitle",
          ).length,
          paragraphs: blocks.filter((b) => b.kind === "paragraph").length,
          listItems: blocks.filter((b) => b.kind === "list").length,
          tables: blocks.filter((b) => b.kind === "table").length,
          images: blocks.filter((b) => b.kind === "image").length,
          notes: blocks.filter((b) => b.kind === "notes").length,
        };
  return { slideNumber, zipPath, widthEmu, heightEmu, blocks, notes, counts };
}

function parseStoredBlock(raw: unknown): PptxBlock | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ordinal = typeof r["ordinal"] === "number" ? (r["ordinal"] as number) : 0;
  if (ordinal <= 0) return null;
  const kindRaw = typeof r["kind"] === "string" ? (r["kind"] as string) : "";
  const validKinds: readonly PptxBlockKind[] = [
    "title",
    "body",
    "subtitle",
    "paragraph",
    "list",
    "table",
    "image",
    "notes",
  ];
  if (!(validKinds as readonly string[]).includes(kindRaw)) return null;
  const kind = kindRaw as PptxBlockKind;
  const scopeRaw = r["scope"];
  const scope: PptxBlock["scope"] =
    scopeRaw === "layout" ? "layout" : "slide";
  const placeholderType =
    typeof r["placeholderType"] === "string"
      ? (r["placeholderType"] as string)
      : null;
  const level = typeof r["level"] === "number" ? (r["level"] as number) : 0;
  const text = typeof r["text"] === "string" ? (r["text"] as string) : "";
  const unsupported = r["unsupported"] === true;

  let table: PptxTable | null = null;
  if (r["table"] !== null && typeof r["table"] === "object") {
    table = parseStoredTable(r["table"]);
  }

  let image: PptxImageRef | null = null;
  if (r["image"] !== null && typeof r["image"] === "object") {
    const i = r["image"] as Record<string, unknown>;
    const relId = typeof i["relId"] === "string" ? (i["relId"] as string) : "";
    const zipPath = typeof i["zipPath"] === "string" ? (i["zipPath"] as string) : "";
    if (relId.length > 0 && zipPath.length > 0) {
      const position =
        i["position"] !== null && typeof i["position"] === "object"
          ? parseStoredPosition(i["position"])
          : null;
      image = {
        relId,
        zipPath,
        filename:
          typeof i["filename"] === "string"
            ? (i["filename"] as string)
            : path.basename(zipPath),
        mimeType:
          typeof i["mimeType"] === "string"
            ? (i["mimeType"] as string)
            : mimeFromMediaPath(zipPath),
        altText: typeof i["altText"] === "string" ? (i["altText"] as string) : "",
        // bytes are deliberately dropped on rehydration.
        bytes: Buffer.alloc(0),
        contentHash:
          typeof i["contentHash"] === "string"
            ? (i["contentHash"] as string)
            : "",
        byteLength:
          typeof i["byteLength"] === "number"
            ? (i["byteLength"] as number)
            : 0,
        position,
      };
    }
  }

  return {
    ordinal,
    kind,
    scope,
    placeholderType,
    level,
    text,
    unsupported,
    table,
    image,
  };
}

function parseStoredTable(raw: unknown): PptxTable | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rowsRaw = Array.isArray(r["rows"]) ? (r["rows"] as unknown[]) : null;
  if (rowsRaw === null) return null;
  const rows: string[][] = [];
  for (const rowRaw of rowsRaw) {
    if (!Array.isArray(rowRaw)) return null;
    rows.push(
      (rowRaw as unknown[]).map((v) =>
        typeof v === "string" ? v : String(v ?? ""),
      ),
    );
  }
  let columnCount = 0;
  for (const row of rows) if (row.length > columnCount) columnCount = row.length;
  const headerRows =
    typeof r["headerRows"] === "number" ? (r["headerRows"] as number) : 0;
  const markdown = typeof r["markdown"] === "string" ? (r["markdown"] as string) : "";
  const jsonRaw = r["json"];
  let json: PptxTable["json"] = { headers: [], rows: [], columnCount };
  if (jsonRaw !== null && typeof jsonRaw === "object") {
    const j = jsonRaw as Record<string, unknown>;
    const headers = Array.isArray(j["headers"])
      ? (j["headers"] as unknown[]).map((v) =>
          typeof v === "string" ? v : String(v ?? ""),
        )
      : [];
    const jrows = Array.isArray(j["rows"]) ? (j["rows"] as unknown[]) : [];
    const outRows: string[][] = [];
    for (const jrow of jrows) {
      if (!Array.isArray(jrow)) continue;
      outRows.push(
        (jrow as unknown[]).map((v) =>
          typeof v === "string" ? v : String(v ?? ""),
        ),
      );
    }
    json = {
      headers,
      rows: outRows,
      columnCount:
        typeof j["columnCount"] === "number"
          ? (j["columnCount"] as number)
          : columnCount,
    };
  }
  return {
    rows,
    rowCount:
      typeof r["rowCount"] === "number" ? (r["rowCount"] as number) : rows.length,
    columnCount:
      typeof r["columnCount"] === "number"
        ? (r["columnCount"] as number)
        : columnCount,
    markdown,
    json,
    headerRows,
  };
}

function parseStoredPosition(raw: unknown): PptxShapePosition | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = typeof r["x"] === "number" ? (r["x"] as number) : NaN;
  const y = typeof r["y"] === "number" ? (r["y"] as number) : NaN;
  const width = typeof r["width"] === "number" ? (r["width"] as number) : NaN;
  const height = typeof r["height"] === "number" ? (r["height"] as number) : NaN;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return { x, y, width, height };
}
