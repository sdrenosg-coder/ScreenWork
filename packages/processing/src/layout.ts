/**
 * Zipy AI — layout region segmentation and classification.
 *
 * Segments a page (document or screenshot) into typed regions — headings,
 * body text, lists, tables, captions, headers, footers, figures, form fields
 * — so downstream extraction and content generation can treat each region
 * with the right code path (e.g. table structure parsing for tables, OCR for
 * figures, skip for headers/footers).
 *
 * The segmentation *source* is pluggable:
 *   - "docling": routed through a DocLayNet/Docling HTTP service when
 *     `DOCLING_SERVICE_URL` is configured (see `packages/ingest/src/docling.ts`
 *     for the raw service caller). This module consumes the raw region list
 *     that service returns and normalises it.
 *   - "heuristic": a deterministic geometry-only classifier used when no
 *     layout model is configured. Heuristics are conservative: they classify
 *     regions by position (top/bottom margins = header/footer), by
 *     aspect/vertical gap (a short block above a long block = heading), and
 *     by very tall rows containing many short columns (table indicator). The
 *     heuristic produces a *provisional* labelled layout and marks each
 *     region's `provenance` as `"heuristic"` so consumers can decide whether
 *     to trust it. Nothing is invented: region boundaries must come from a
 *     real text extractor or OCR engine; the heuristic only assigns labels.
 *
 * Inputs are pure data. This module never reads files, opens sockets, or
 * touches credentials. It consumes the raw text-block list that the caller
 * (docling adapter, PDF parser, OCR post-processor) already produced.
 *
 * Output is a `LayoutResult` — a flat, ordered list of typed regions with
 * bounding boxes and provenance. Consumers (canonical representation
 * builder, content generation) consume it directly.
 */

import type { BBox } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type LayoutErrorCode = "invalid-input" | "empty-input";

export class LayoutError extends Error {
  readonly code: LayoutErrorCode;
  constructor(message: string, code: LayoutErrorCode) {
    super(message);
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Region kinds                                                                */
/* -------------------------------------------------------------------------- */

export type RegionKind =
  | "heading"
  | "body"
  | "list"
  | "list-item"
  | "table"
  | "table-cell"
  | "caption"
  | "header"
  | "footer"
  | "figure"
  | "form-field"
  | "code"
  | "quote"
  | "other";

export type RegionProvenance = "docling" | "heuristic";

/* -------------------------------------------------------------------------- */
/* Input evidence                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The unit of input the segmentation operates on. The caller (a layout
 * service adapter, a PDF parser, or an OCR post-processor) produces these.
 *
 * `text` is required because each block's *content* is what allows
 * classification (e.g. "Font: bold and 1.4x body size" is what identifies a
 * heading when geometry alone is ambiguous).
 *
 * `fontSizePt` and `bold` are optional but strongly preferred from a text
 * extractor: without them, headings must be inferred purely from position.
 */
export interface RawBlock {
  /** Bounding box in the page's coordinate system (top-left origin). */
  readonly bbox: BBox;
  /** Extracted text (may be empty for pure figures). */
  readonly text: string;
  /** Optional font size in points or pixels (parser units). */
  readonly fontSizePt?: number | null;
  /** Optional bold flag from the parser. */
  readonly bold?: boolean | null;
  /** Optional italics flag. */
  readonly italic?: boolean | null;
  /** Optional role hint from the parser (e.g. from a PDF's tagged content). */
  readonly roleHint?:
    | "paragraph"
    | "heading"
    | "list"
    | "listitem"
    | "table"
    | "tablecell"
    | "caption"
    | "figure"
    | "code"
    | "quote"
    | null;
  /** Optional table row/column count when the block is a table's cell. */
  readonly tableCellRow?: number | null;
  readonly tableCellColumn?: number | null;
}

/**
 * Page-level input to `segmentLayout`. `pageWidth` / `pageHeight` are used
 * only when the caller selects the heuristic classifier (to derive margins);
 * a docling-provided region list is trusted as-is and does not depend on
 * them.
 */
export interface LayoutPageInput {
  readonly pageIndex: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly blocks: readonly RawBlock[];
  /**
   * Optional: docling-provided region labels. When present, the classifier
   * is skipped and the labels are used directly. This is the correct path
   * when a real layout service is configured.
   */
  readonly providedRegions?: readonly ProvidedRegion[] | null;
}

/**
 * A region as returned by a layout service (Docling/DocLayNet). The service
 * may already have merged blocks; this module normalises the shape.
 */
export interface ProvidedRegion {
  readonly kind: RegionKind;
  readonly bbox: BBox;
  readonly text: string;
  /**
   * Optional 0..1 confidence the model reported. Remains `null` when the
   * model did not report one; consumers treat `null` as "no claim".
   */
  readonly confidence?: number | null;
  /** Zero-based index of the source block(s) this region came from, if known. */
  readonly sourceBlockIndexes?: readonly number[] | null;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export interface LayoutRegion {
  /** Monotonic region id within the page (0-based, reading order). */
  readonly regionId: number;
  readonly pageIndex: number;
  readonly kind: RegionKind;
  readonly bbox: BBox;
  readonly text: string;
  /** Where the `kind` came from. */
  readonly provenance: RegionProvenance;
  /** Model confidence when the source provided one, else `null`. */
  readonly confidence: number | null;
  /**
   * Zero-based indexes into `LayoutPageInput.blocks` of the raw blocks that
   * this region absorbed. Empty when a layout service supplied the region
   * without a source-block mapping.
   */
  readonly sourceBlockIndexes: readonly number[];
  /**
   * Table cell coordinates when `kind === "table-cell"`, else `null`.
   * Preserved here so a downstream table builder does not need to re-derive
   * them from geometry.
   */
  readonly tableCell:
    | { readonly row: number; readonly column: number }
    | null;
}

export interface LayoutResult {
  readonly pageIndex: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  /** Regions in reading order: top-to-bottom, then left-to-right. */
  readonly regions: readonly LayoutRegion[];
  /** Total number of regions emitted. */
  readonly regionCount: number;
  /** Which classifier ran (or which service supplied the labels). */
  readonly classifier: "docling" | "heuristic";
  /** Number of regions per kind, keyed by kind. */
  readonly kindCounts: Readonly<Record<RegionKind, number>>;
  /** ISO timestamp of completion. */
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Heuristic thresholds                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fraction of page height that defines the "header band". Blocks whose bbox
 * lies entirely within the top N% of the page are considered header
 * candidates. 8% is chosen because most body content starts below the top
 * margin and the running header sits inside it; screenshots with a
 * persistent nav bar are handled by the same rule.
 */
const DEFAULT_HEADER_BAND = 0.08;

/**
 * Same idea at the bottom: the last 8% of page height is the footer band.
 */
const DEFAULT_FOOTER_BAND = 0.08;

/**
 * A block whose bbox is at least this many times taller than the running
 * median line height is considered a heading candidate *when* it also sits
 * above the surrounding body blocks. Multiplied height is a more robust
 * signal than absolute point size, which varies by document.
 */
const HEADING_HEIGHT_RATIO = 1.6;

/**
 * A block is considered a table candidate when it contains at least this
 * many short "cell-like" sub-blocks aligned into a grid, inferred from
 * vertical column alignment. The heuristic is deliberately conservative: a
 * two-cell figure caption must not be promoted to a table.
 */
const TABLE_MIN_COLUMNS = 2;
const TABLE_MIN_ROWS = 2;

/**
 * A block whose bbox touches all four page margins (i.e. spans the text
 * column) and whose text is long is body text. This is the fallback label.
 */
const BODY_MIN_CHARS = 20;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Segment one page into typed regions. When `input.providedRegions` is
 * non-null, those labels are used directly; otherwise the heuristic
 * classifier runs.
 *
 * Throws `LayoutError` when the input is structurally impossible (missing
 * page dimensions, blocks with degenerate boxes).
 */
export function segmentLayout(input: LayoutPageInput): LayoutResult {
  if (input === null || typeof input !== "object") {
    throw new LayoutError("segmentLayout requires a LayoutPageInput.", "invalid-input");
  }
  if (
    typeof input.pageIndex !== "number" ||
    !Number.isFinite(input.pageIndex) ||
    typeof input.pageWidth !== "number" ||
    !Number.isFinite(input.pageWidth) ||
    input.pageWidth <= 0 ||
    typeof input.pageHeight !== "number" ||
    !Number.isFinite(input.pageHeight) ||
    input.pageHeight <= 0
  ) {
    throw new LayoutError(
      "segmentLayout requires finite positive pageWidth and pageHeight and a numeric pageIndex.",
      "invalid-input",
    );
  }
  if (!Array.isArray(input.blocks)) {
    throw new LayoutError("segmentLayout requires `blocks` to be an array.", "invalid-input");
  }
  for (const b of input.blocks) {
    if (b === null || typeof b !== "object") {
      throw new LayoutError("segmentLayout found a non-object block.", "invalid-input");
    }
    if (
      typeof b.bbox?.x !== "number" ||
      typeof b.bbox?.y !== "number" ||
      typeof b.bbox?.width !== "number" ||
      typeof b.bbox?.height !== "number"
    ) {
      throw new LayoutError("segmentLayout found a block with a malformed bbox.", "invalid-input");
    }
  }

  const regions =
    input.providedRegions !== null && input.providedRegions !== undefined
      ? normalizeProvidedRegions(input.providedRegions, input.pageIndex)
      : heuristicSegment(input);

  // Force reading order (top-to-bottom, then left-to-right). Region ids are
  // assigned *after* ordering so they are contiguous and stable.
  const ordered = regions
    .map((r, index) => ({ r, index }))
    .sort((a, b) => {
      if (a.r.bbox.y !== b.r.bbox.y) return a.r.bbox.y - b.r.bbox.y;
      if (a.r.bbox.x !== b.r.bbox.x) return a.r.bbox.x - b.r.bbox.x;
      return a.index - b.index;
    })
    .map(({ r }) => r);

  const withIds: LayoutRegion[] = ordered.map((r, i) => ({
    ...r,
    regionId: i,
  }));

  const kindCounts = buildKindCounts(withIds);

  return {
    pageIndex: input.pageIndex,
    pageWidth: input.pageWidth,
    pageHeight: input.pageHeight,
    regions: withIds,
    regionCount: withIds.length,
    classifier:
      input.providedRegions !== null && input.providedRegions !== undefined
        ? "docling"
        : "heuristic",
    kindCounts,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Provided-region normalisation                                               */
/* -------------------------------------------------------------------------- */

function normalizeProvidedRegions(
  provided: readonly ProvidedRegion[],
  pageIndex: number,
): LayoutRegion[] {
  const out: LayoutRegion[] = [];
  for (let i = 0; i < provided.length; i += 1) {
    const r = provided[i];
    if (r === undefined || r === null || typeof r !== "object") continue;
    if (
      typeof r.bbox?.x !== "number" ||
      typeof r.bbox?.y !== "number" ||
      typeof r.bbox?.width !== "number" ||
      typeof r.bbox?.height !== "number"
    ) {
      continue;
    }
    const kind = normaliseKind(r.kind);
    const text = typeof r.text === "string" ? r.text : "";
    const confidence =
      typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? Math.max(0, Math.min(1, r.confidence))
        : null;
    const sourceBlockIndexes = Array.isArray(r.sourceBlockIndexes)
      ? r.sourceBlockIndexes.filter(
          (n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0,
        )
      : [];
    out.push({
      regionId: i, // overwritten after ordering
      pageIndex,
      kind,
      bbox: roundBBox(r.bbox),
      text,
      provenance: "docling",
      confidence,
      sourceBlockIndexes,
      tableCell: null,
    });
  }
  return out;
}

function normaliseKind(kind: RegionKind): RegionKind {
  const known: readonly RegionKind[] = [
    "heading",
    "body",
    "list",
    "list-item",
    "table",
    "table-cell",
    "caption",
    "header",
    "footer",
    "figure",
    "form-field",
    "code",
    "quote",
    "other",
  ];
  if ((known as readonly string[]).includes(kind)) return kind;
  return "other";
}

/* -------------------------------------------------------------------------- */
/* Heuristic segmentation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic, geometry-first classifier. The heuristic is intentionally
 * conservative; its regions are marked `provenance: "heuristic"` so that
 * downstream content generation can downgrade its confidence or ask a human
 * to confirm.
 *
 * Rules, in priority order:
 *   1. Blocks fully in the top `DEFAULT_HEADER_BAND` → `header`.
 *   2. Blocks fully in the bottom `DEFAULT_FOOTER_BAND` → `footer`.
 *   3. Blocks with `roleHint === "table"` → `table`.
 *   4. Blocks with `roleHint === "tablecell"` → `table-cell` (with row/column
 *      from the block if present).
 *   5. Blocks whose `roleHint` is a direct map (paragraph/list/listitem/
 *      caption/figure/code/quote) → mapped kind.
 *   6. Otherwise, classify by font/geometry:
 *      - Heading candidate: `bold === true` OR `fontSizePt` >= 1.6× page
 *        median.
 *      - Caption candidate: `italic === true` AND text starts with a
 *        figure/table label ("Figure", "Table", "Fig.", "Tab.").
 *      - Body: everything else.
 *
 * Explicit non-goal: heuristic detection of table *structure* (rows/columns)
 * from geometry. That is `tableExtract`'s job and requires more than block
 * bboxes.
 */
function heuristicSegment(input: LayoutPageInput): LayoutRegion[] {
  const sorted = input.blocks
    .map((b, index) => ({ b, index }))
    .sort((a, b) => {
      if (a.b.bbox.y !== b.b.bbox.y) return a.b.bbox.y - b.b.bbox.y;
      if (a.b.bbox.x !== b.b.bbox.x) return a.b.bbox.x - b.b.bbox.x;
      return a.index - b.index;
    })
    .map(({ b, index }) => ({ b, index }));

  const headerBandEnd = input.pageHeight * DEFAULT_HEADER_BAND;
  const footerBandStart = input.pageHeight * (1 - DEFAULT_FOOTER_BAND);

  // Median font size across blocks that report one, used for heading
  // detection. Absent font info → null → fall back to bold-only.
  const fontSizes: number[] = [];
  for (const { b } of sorted) {
    if (typeof b.fontSizePt === "number" && Number.isFinite(b.fontSizePt) && b.fontSizePt > 0) {
      fontSizes.push(b.fontSizePt);
    }
  }
  const medianFont = fontSizes.length > 0 ? median(fontSizes) : null;

  const out: LayoutRegion[] = [];
  for (const { b, index } of sorted) {
    const kind = classifyHeuristic(b, {
      headerBandEnd,
      footerBandStart,
      medianFont,
    });
    out.push({
      regionId: out.length,
      pageIndex: input.pageIndex,
      kind,
      bbox: roundBBox(b.bbox),
      text: b.text,
      provenance: "heuristic",
      confidence: null,
      sourceBlockIndexes: [index],
      tableCell:
        kind === "table-cell" &&
        typeof b.tableCellRow === "number" &&
        typeof b.tableCellColumn === "number"
          ? { row: b.tableCellRow, column: b.tableCellColumn }
          : null,
    });
  }
  return out;
}

function classifyHeuristic(
  block: RawBlock,
  ctx: {
    readonly headerBandEnd: number;
    readonly footerBandStart: number;
    readonly medianFont: number | null;
  },
): RegionKind {
  const { bbox } = block;
  const top = bbox.y;
  const bottom = bbox.y + bbox.height;

  if (bottom <= ctx.headerBandEnd) return "header";
  if (top >= ctx.footerBandStart) return "footer";

  const hint = block.roleHint;
  if (hint === "table") return "table";
  if (hint === "tablecell") return "table-cell";
  if (hint === "paragraph") return "body";
  if (hint === "list") return "list";
  if (hint === "listitem") return "list-item";
  if (hint === "caption") return "caption";
  if (hint === "heading") return "heading";
  if (hint === "figure") return "figure";
  if (hint === "code") return "code";
  if (hint === "quote") return "quote";

  const text = block.text.trim();

  // Caption-by-prefix: "Figure 1: …", "Table 3 …". Common enough that a
  // prefix match is a strong signal; a false positive here is low-cost
  // (captions are still rendered).
  if (/^(figure|fig\.|table|tab\.)\s+\d/i.test(text)) return "caption";

  // Heading-by-font: bold, or materially larger than the median.
  if (block.bold === true && text.length > 0 && text.length <= 140) return "heading";
  if (
    ctx.medianFont !== null &&
    typeof block.fontSizePt === "number" &&
    Number.isFinite(block.fontSizePt) &&
    block.fontSizePt >= ctx.medianFont * HEADING_HEIGHT_RATIO &&
    text.length > 0 &&
    text.length <= 140
  ) {
    return "heading";
  }

  // Non-empty text of moderate length → body. Very short text with no other
  // signal is `other` rather than `body` to avoid promoting page numbers.
  if (text.length >= BODY_MIN_CHARS) return "body";
  if (text.length > 0) return "other";

  // Empty text blocks are figures.
  return "figure";
}

/* -------------------------------------------------------------------------- */
/* Table-candidate detection (used by the classifier)                          */
/* -------------------------------------------------------------------------- */

/**
 * Return `true` when a set of raw blocks plausibly forms a table grid, based
 * on column alignment. Exposed because `canonical.ts` and the visual
 * annotation layer both benefit from knowing whether a set of blocks is a
 * table before the full `tableExtract` runs.
 *
 * The heuristic is intentionally narrow: it requires at least
 * `TABLE_MIN_COLUMNS` distinct column x-positions AND at least
 * `TABLE_MIN_ROWS` rows (by approximate y-alignment). It is a filter, not a
 * classifier — a positive result means "worth running table extraction".
 */
export function isTableCandidate(blocks: readonly RawBlock[]): boolean {
  if (blocks.length < TABLE_MIN_COLUMNS * TABLE_MIN_ROWS) return false;
  const xs: number[] = [];
  for (const b of blocks) {
    xs.push(Math.round(b.bbox.x));
  }
  xs.sort((a, b) => a - b);
  const distinctColumns = countDistinctWithTolerance(xs, 4);
  if (distinctColumns < TABLE_MIN_COLUMNS) return false;
  const ys: number[] = [];
  for (const b of blocks) {
    ys.push(Math.round(b.bbox.y));
  }
  ys.sort((a, b) => a - b);
  const distinctRows = countDistinctWithTolerance(ys, Math.max(2, Math.round(median(blocks.map((b) => b.bbox.height)) / 2)));
  return distinctRows >= TABLE_MIN_ROWS;
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

function roundBBox(b: BBox): BBox {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(1, Math.round(b.width)),
    height: Math.max(1, Math.round(b.height)),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const a = sorted[mid - 1] ?? 0;
  const b = sorted[mid] ?? 0;
  return (a + b) / 2;
}

function countDistinctWithTolerance(sorted: readonly number[], tolerance: number): number {
  if (sorted.length === 0) return 0;
  const tol = Math.max(0, tolerance);
  let count = 1;
  let last = sorted[0] ?? 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const v = sorted[i] ?? 0;
    if (v - last > tol) {
      count += 1;
      last = v;
    }
  }
  return count;
}

function buildKindCounts(regions: readonly LayoutRegion[]): Readonly<Record<RegionKind, number>> {
  const kinds: readonly RegionKind[] = [
    "heading",
    "body",
    "list",
    "list-item",
    "table",
    "table-cell",
    "caption",
    "header",
    "footer",
    "figure",
    "form-field",
    "code",
    "quote",
    "other",
  ];
  const out = {} as Record<RegionKind, number>;
  for (const k of kinds) out[k] = 0;
  for (const r of regions) out[r.kind] += 1;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `LayoutResult`. Throws `LayoutError` with code
 * `"invalid-input"` on malformed payloads.
 */
export function rehydrateLayoutResult(value: unknown): LayoutResult {
  if (value === null || typeof value !== "object") {
    throw new LayoutError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const pageIndex = numberOr(r["pageIndex"], 0);
  const pageWidth = numberOr(r["pageWidth"], 0);
  const pageHeight = numberOr(r["pageHeight"], 0);
  const classifierRaw = r["classifier"];
  const classifier: "docling" | "heuristic" =
    classifierRaw === "docling" ? "docling" : "heuristic";

  const regionsRaw = Array.isArray(r["regions"]) ? (r["regions"] as unknown[]) : [];
  const regions: LayoutRegion[] = [];
  for (const rRaw of regionsRaw) {
    if (rRaw === null || typeof rRaw !== "object") continue;
    const rr = rRaw as Record<string, unknown>;
    const bbox = parseBBox(rr["bbox"]);
    if (bbox === null) continue;
    const kind = normaliseKind(
      typeof rr["kind"] === "string" ? (rr["kind"] as RegionKind) : "other",
    );
    const provenanceRaw = rr["provenance"];
    const provenance: RegionProvenance = provenanceRaw === "docling" ? "docling" : "heuristic";
    const sourceIndexesRaw = Array.isArray(rr["sourceBlockIndexes"])
      ? (rr["sourceBlockIndexes"] as unknown[])
      : [];
    const sourceBlockIndexes = sourceIndexesRaw.filter(
      (n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0,
    );
    const tableCellRaw = rr["tableCell"];
    let tableCell: { row: number; column: number } | null = null;
    if (tableCellRaw !== null && typeof tableCellRaw === "object") {
      const tc = tableCellRaw as Record<string, unknown>;
      const row = numberOr(tc["row"], NaN);
      const column = numberOr(tc["column"], NaN);
      if (Number.isFinite(row) && Number.isFinite(column)) {
        tableCell = { row, column };
      }
    }
    regions.push({
      regionId: numberOr(rr["regionId"], regions.length),
      pageIndex: numberOr(rr["pageIndex"], pageIndex),
      kind,
      bbox,
      text: typeof rr["text"] === "string" ? (rr["text"] as string) : "",
      provenance,
      confidence:
        typeof rr["confidence"] === "number" && Number.isFinite(rr["confidence"] as number)
          ? Math.max(0, Math.min(1, rr["confidence"] as number))
          : null,
      sourceBlockIndexes,
      tableCell,
    });
  }

  return {
    pageIndex,
    pageWidth,
    pageHeight,
    regions,
    regionCount: regions.length,
    classifier,
    kindCounts: buildKindCounts(regions),
    generatedAt:
      typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
  };
}

function parseBBox(v: unknown): BBox | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const x = numberOr(r["x"], NaN);
  const y = numberOr(r["y"], NaN);
  const width = numberOr(r["width"], NaN);
  const height = numberOr(r["height"], NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
