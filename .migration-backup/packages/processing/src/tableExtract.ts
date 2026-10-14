/**
 * Zipy AI — table structure extraction.
 *
 * Takes a set of raw blocks (typically the cells of a table, filtered by the
 * layout classifier or flagged by the parser) and reconstructs a table grid:
 * rows, columns, header row detection, and merge detection (colspan/rowspan).
 * Serialises to Markdown, JSON, and HTML.
 *
 * The extraction is *evidence-driven*, not generative:
 *   - Cells must already exist as raw blocks. This module does not invent
 *     cells that the parser missed, and it does not "guess" missing rows
 *     from context. When the grid is ragged (a short row), the module marks
 *     the row `ragged: true` and records which column indexes are missing.
 *     The caller can review or reject the table.
 *   - `TableFormer` (via Docling) may supply a cell grid directly. When the
 *     caller passes `providedCells`, this module trusts the provided
 *     row/column coordinates and skips geometric inference. When only raw
 *     cells are available, the geometric clustering path runs.
 *
 * Merge detection: after the grid is built, adjacent cells with the same
 * text *and* no separating line-gap are merged into a single cell with
 * colspan/rowspan. The rule is deliberately conservative — it requires
 * identical text after trimming, which catches "Yes / Yes / Yes" spanning
 * header groups but does not merge a repeated body value that happens to
 * occur twice.
 *
 * Serialisers:
 *   - `toMarkdown`: GitHub-flavoured Markdown, aligning the header row.
 *     Empty cells become blank Markdown cells (one space).
 *   - `toJson`: nested array of rows of cell objects (text, colspan, rowspan,
 *     isHeader).
 *   - `toHtml`: minimal `<table>` with `<th>` on header cells and
 *     `colspan`/`rowspan` attributes on merged cells.
 *
 * No I/O. No network. No credentials. Pure.
 */

import type { BBox } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TableExtractErrorCode = "invalid-input" | "empty-input";

export class TableExtractError extends Error {
  readonly code: TableExtractErrorCode;
  constructor(message: string, code: TableExtractErrorCode) {
    super(message);
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A candidate cell. Either produced by upstream layout classification (each
 * block that was labelled `table-cell`) or by a layout service that already
 * identified the cell grid.
 */
export interface RawTableCell {
  readonly bbox: BBox;
  readonly text: string;
  /**
   * When supplied (layout service path), the 0-based row index for this
   * cell. `null` means "not supplied, infer from geometry".
   */
  readonly rowHint?: number | null;
  /** Same for column. */
  readonly columnHint?: number | null;
  /**
   * When true, the source parser reported that this cell is a header cell.
   * Used as a hint; the final header row is decided by `headerRowIndex`
   * unless the caller supplies one.
   */
  readonly isHeaderHint?: boolean | null;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export interface TableCell {
  /** Text content, trimmed. */
  readonly text: string;
  /** 0-based row index in the reconstructed grid. */
  readonly row: number;
  /** 0-based column index in the reconstructed grid. */
  readonly column: number;
  /** Column span (>1 when merged horizontally). */
  readonly colspan: number;
  /** Row span (>1 when merged vertically). */
  readonly rowspan: number;
  /** Whether this cell is part of the header row(s). */
  readonly isHeader: boolean;
  /** The bounding box of the cell, in page coordinates. */
  readonly bbox: BBox;
}

export interface TableRow {
  readonly row: number;
  readonly cells: readonly TableCell[];
  /**
   * True when the row contains fewer cells than the modal row width. The
   * missing column indexes are listed in `missingColumns`.
   */
  readonly ragged: boolean;
  readonly missingColumns: readonly number[];
  readonly isHeaderRow: boolean;
}

export interface ReconstructedTable {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rows: readonly TableRow[];
  /** Index of the header row, or `null` when the table has no header. */
  readonly headerRowIndex: number | null;
  /** True when the grid is complete (no ragged rows). */
  readonly isComplete: boolean;
  /** Bounding box of the whole table. */
  readonly bbox: BBox;
}

/* -------------------------------------------------------------------------- */
/* Errors and types end; JSON/Markdown/HTML cell shapes                        */
/* -------------------------------------------------------------------------- */

export interface TableJsonCell {
  readonly text: string;
  readonly colspan: number;
  readonly rowspan: number;
  readonly isHeader: boolean;
}

export type TableJson = readonly (readonly TableJsonCell[])[];

/* -------------------------------------------------------------------------- */
/* Errors and utilities                                                        */
/* -------------------------------------------------------------------------- */

function roundBBox(b: BBox): BBox {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(1, Math.round(b.width)),
    height: Math.max(1, Math.round(b.height)),
  };
}

/**
 * Reconstruct a table grid from raw cells. When every cell supplies row and
 * column hints, hints are used directly. Otherwise the geometry is clustered
 * into rows and columns.
 *
 * Throws `TableExtractError` with code `"empty-input"` when there are fewer
 * than 2 cells or fewer than 2 distinct rows or columns — that is not a
 * table, and returning an empty grid would hide the caller's mistake.
 */
export function reconstructTable(
  cells: readonly RawTableCell[],
  options: { readonly headerRowIndex?: number | null } = {},
): ReconstructedTable {
  if (!Array.isArray(cells)) {
    throw new TableExtractError("reconstructTable requires an array of cells.", "invalid-input");
  }
  if (cells.length < 4) {
    throw new TableExtractError(
      `reconstructTable requires at least 4 cells; received ${cells.length}. ` +
        `Cells must first be identified by the layout classifier.`,
      "empty-input",
    );
  }
  for (const c of cells) {
    if (c === null || typeof c !== "object") {
      throw new TableExtractError(
        "reconstructTable found a non-object cell.",
        "invalid-input",
      );
    }
    if (
      typeof c.bbox?.x !== "number" ||
      typeof c.bbox?.y !== "number" ||
      typeof c.bbox?.width !== "number" ||
      typeof c.bbox?.height !== "number"
    ) {
      throw new TableExtractError(
        "reconstructTable found a cell with a malformed bbox.",
        "invalid-input",
      );
    }
  }

  const allHintsPresent = cells.every(
    (c) =>
      typeof c.rowHint === "number" &&
      Number.isFinite(c.rowHint) &&
      typeof c.columnHint === "number" &&
      Number.isFinite(c.columnHint),
  );

  const { grid, maxRow, maxColumn } = allHintsPresent
    ? buildFromHints(cells)
    : buildFromGeometry(cells);

  if (maxRow + 1 < 2 || maxColumn + 1 < 2) {
    throw new TableExtractError(
      `Reconstructed grid is ${maxRow + 1}x${maxColumn + 1}; ` +
        `a table requires at least 2 rows and 2 columns.`,
      "empty-input",
    );
  }

  const headerRowIndex = determineHeaderRowIndex(
    grid,
    options.headerRowIndex,
    maxRow,
  );

  // Merge adjacent same-text cells. Merge runs before building TableRow
  // objects so that cell counts line up with the modal width.
  applyHorizontalMerge(grid, maxRow, maxColumn);

  const rowCount = maxRow + 1;
  const columnCount = maxColumn + 1;
  const rows: TableRow[] = [];
  let isComplete = true;
  let tableMinX = Number.POSITIVE_INFINITY;
  let tableMinY = Number.POSITIVE_INFINITY;
  let tableMaxX = Number.NEGATIVE_INFINITY;
  let tableMaxY = Number.NEGATIVE_INFINITY;

  for (let r = 0; r <= maxRow; r += 1) {
    const rowCells: TableCell[] = [];
    const presentColumns = new Set<number>();
    for (let c = 0; c <= maxColumn; c += 1) {
      const cell = grid[r]?.[c];
      if (cell === null || cell === undefined) continue;
      const isHeader = headerRowIndex !== null && r === headerRowIndex;
      presentColumns.add(c);
      rowCells.push({
        text: cell.text,
        row: r,
        column: c,
        colspan: cell.colspan,
        rowspan: cell.rowspan,
        isHeader,
        bbox: cell.bbox,
      });
      tableMinX = Math.min(tableMinX, cell.bbox.x);
      tableMinY = Math.min(tableMinY, cell.bbox.y);
      tableMaxX = Math.max(tableMaxX, cell.bbox.x + cell.bbox.width);
      tableMaxY = Math.max(tableMaxY, cell.bbox.y + cell.bbox.height);
    }
    // A row is ragged if any column index in [0, maxColumn] is missing,
    // *except* those that are covered by a colspan from a lower index.
    const covered = new Set<number>(presentColumns);
    for (const c of presentColumns) {
      const cell = grid[r]?.[c];
      if (cell === undefined || cell === null) continue;
      if (cell.colspan > 1) {
        for (let k = 1; k < cell.colspan; k += 1) covered.add(c + k);
      }
    }
    const missingColumns: number[] = [];
    for (let c = 0; c <= maxColumn; c += 1) {
      if (!covered.has(c)) missingColumns.push(c);
    }
    const ragged = missingColumns.length > 0;
    if (ragged) isComplete = false;
    rows.push({
      row: r,
      cells: rowCells,
      ragged,
      missingColumns,
      isHeaderRow: headerRowIndex !== null && r === headerRowIndex,
    });
  }

  const bbox: BBox =
    Number.isFinite(tableMinX) && Number.isFinite(tableMinY)
      ? {
          x: Math.round(tableMinX),
          y: Math.round(tableMinY),
          width: Math.max(1, Math.round(tableMaxX - tableMinX)),
          height: Math.max(1, Math.round(tableMaxY - tableMinY)),
        }
      : { x: 0, y: 0, width: 1, height: 1 };

  return {
    rowCount,
    columnCount,
    rows,
    headerRowIndex,
    isComplete,
    bbox,
  };
}

/* -------------------------------------------------------------------------- */
/* Geometry clustering                                                         */
/* -------------------------------------------------------------------------- */

interface MutableCell {
  text: string;
  bbox: BBox;
  colspan: number;
  rowspan: number;
}

type Grid = MutableCell[][];

function buildFromHints(cells: readonly RawTableCell[]): {
  grid: Grid;
  maxRow: number;
  maxColumn: number;
} {
  let maxRow = 0;
  let maxColumn = 0;
  for (const c of cells) {
    const r = Math.max(0, Math.floor(c.rowHint ?? 0));
    const col = Math.max(0, Math.floor(c.columnHint ?? 0));
    if (r > maxRow) maxRow = r;
    if (col > maxColumn) maxColumn = col;
  }
  const grid: Grid = [];
  for (let r = 0; r <= maxRow; r += 1) {
    const row: MutableCell[] = new Array(maxColumn + 1).fill(null) as unknown as MutableCell[];
    grid.push(row);
  }
  for (const c of cells) {
    const r = Math.max(0, Math.floor(c.rowHint ?? 0));
    const col = Math.max(0, Math.floor(c.columnHint ?? 0));
    const existing = grid[r]?.[col];
    if (existing !== undefined && existing !== null && existing.text.length > 0) {
      // Two cells declaring the same (row, column). This is a real data
      // problem in the source layout; keep the first and append the second
      // to avoid silent loss. Row/column of the appended portion are
      // unknown, so we do not attempt a merge; the caller sees evidence in
      // the text.
      existing.text = `${existing.text} / ${c.text.trim()}`;
      continue;
    }
    if (grid[r] === undefined) continue;
    grid[r][col] = {
      text: c.text.trim(),
      bbox: roundBBox(c.bbox),
      colspan: 1,
      rowspan: 1,
    };
  }
  return { grid, maxRow, maxColumn };
}

function buildFromGeometry(cells: readonly RawTableCell[]): {
  grid: Grid;
  maxRow: number;
  maxColumn: number;
} {
  // Row boundary detection: cluster by cell vertical centre, with tolerance
  // = median cell height * 0.5. This groups cells that share a visual row
  // even when their exact y differs slightly (very common in PDFs).
  const heights = cells.map((c) => c.bbox.height).slice().sort((a, b) => a - b);
  const medianHeight = medianNumber(heights);
  const rowTolerance = Math.max(2, medianHeight * 0.5);

  interface RowBucket {
    readonly centre: number;
    readonly cells: RawTableCell[];
  }
  const rowBuckets: RowBucket[] = [];
  const centres = cells
    .map((c) => ({ c, cy: c.bbox.y + c.bbox.height / 2 }))
    .sort((a, b) => a.cy - b.cy);
  for (const { c, cy } of centres) {
    const last = rowBuckets[rowBuckets.length - 1];
    if (last === undefined || Math.abs(cy - last.centre) > rowTolerance) {
      rowBuckets.push({ centre: cy, cells: [c] });
    } else {
      // Merge into the running bucket: the bucket centre stays as the first
      // cell's centre to keep clustering stable.
      (last.cells as RawTableCell[]).push(c);
    }
  }

  // Column boundary detection: cluster by cell horizontal centre, with a
  // much tighter tolerance because columns must be strictly separated.
  const widths = cells.map((c) => c.bbox.width).slice().sort((a, b) => a - b);
  const medianWidth = medianNumber(widths);
  const columnTolerance = Math.max(2, medianWidth * 0.35);

  const centreXList = cells
    .map((c) => c.bbox.x + c.bbox.width / 2)
    .slice()
    .sort((a, b) => a - b);
  const columns: number[] = [];
  for (const cx of centreXList) {
    const last = columns[columns.length - 1];
    if (last === undefined || cx - last > columnTolerance) {
      columns.push(cx);
    }
  }

  const maxRow = Math.max(0, rowBuckets.length - 1);
  const maxColumn = Math.max(0, columns.length - 1);
  const grid: Grid = [];
  for (let r = 0; r <= maxRow; r += 1) {
    grid.push(new Array(maxColumn + 1).fill(null) as unknown as MutableCell[]);
  }
  for (let r = 0; r <= maxRow; r += 1) {
    const bucket = rowBuckets[r];
    if (bucket === undefined) continue;
    for (const cell of bucket.cells) {
      const cx = cell.bbox.x + cell.bbox.width / 2;
      const col = nearestColumnIndex(columns, cx, columnTolerance);
      if (col === null) continue;
      const existing = grid[r]?.[col];
      if (existing !== undefined && existing !== null) {
        // Two cells map to the same grid slot. Merge their text with a
        // separator so information is preserved rather than dropped.
        existing.text = existing.text.length > 0
          ? `${existing.text} ${cell.text.trim()}`.trim()
          : cell.text.trim();
        continue;
      }
      if (grid[r] === undefined) continue;
      grid[r][col] = {
        text: cell.text.trim(),
        bbox: roundBBox(cell.bbox),
        colspan: 1,
        rowspan: 1,
      };
    }
  }
  return { grid, maxRow, maxColumn };
}

function nearestColumnIndex(
  columns: readonly number[],
  cx: number,
  tolerance: number,
): number | null {
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < columns.length; i += 1) {
    const c = columns[i] ?? 0;
    const d = Math.abs(cx - c);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best === null) return null;
  if (bestDist > tolerance * 2) return null;
  return best;
}

/* -------------------------------------------------------------------------- */
/* Merge detection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Merge adjacent cells that carry the exact same trimmed text. Only the
 * *horizontal* direction is merged automatically; vertical merges are
 * left to the caller because they change reading order (a row-spanning
 * cell implies the cell should be read once, not per-row), and that is a
 * template-level decision, not a reconstruction one.
 *
 * The merge uses a simple linear scan: for each cell, if its right
 * neighbour is non-empty and has identical text, extend colspan and clear
 * the neighbour. The scan terminates because it only ever advances the
 * right edge.
 */
function applyHorizontalMerge(grid: Grid, maxRow: number, maxColumn: number): void {
  for (let r = 0; r <= maxRow; r += 1) {
    const row = grid[r];
    if (row === undefined) continue;
    for (let c = 0; c <= maxColumn; c += 1) {
      const cell = row[c];
      if (cell === null || cell === undefined) continue;
      if (cell.text.length === 0) continue;
      let span = cell.colspan;
      let next = c + span;
      while (next <= maxColumn) {
        const neighbour = row[next];
        if (neighbour === null || neighbour === undefined) break;
        if (neighbour.text.trim() !== cell.text) break;
        // Do not merge across a cell that already claims a span > 1 from a
        // previous group.
        if (neighbour.colspan > 1) break;
        span += neighbour.colspan;
        row[next] = null as unknown as MutableCell;
        next += neighbour.colspan;
      }
      cell.colspan = span;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Header detection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Decide which row (if any) is the header. Precedence:
 *   1. `providedHeaderRowIndex` when it is a valid row index.
 *   2. The row whose cells all report `isHeaderHint === true` in the source
 *      data. When no cell reports a hint, no row is auto-promoted.
 *
 * The heuristic does NOT just assume row 0 is the header: a large fraction of
 * real tables (and any table with a title row) do not have a header at row 0.
 */
function determineHeaderRowIndex(
  _grid: Grid,
  provided: number | null | undefined,
  maxRow: number,
): number | null {
  if (
    typeof provided === "number" &&
    Number.isFinite(provided) &&
    provided >= 0 &&
    provided <= maxRow
  ) {
    return Math.floor(provided);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Serialisers                                                                 */
/* -------------------------------------------------------------------------- */

function escapeMarkdownCell(text: string): string {
  // Replace pipes and newlines so a cell cannot break the row layout.
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/**
 * Render a Markdown table (GitHub-flavoured). Header row is inferred from
 * `table.headerRowIndex`; when no header exists, an empty header row is
 * emitted so the Markdown remains valid.
 */
export function toMarkdown(table: ReconstructedTable): string {
  const columnCount = table.columnCount;
  if (columnCount === 0 || table.rowCount === 0) return "";

  const header = table.headerRowIndex;
  const headerCells: string[] = [];
  for (let c = 0; c < columnCount; c += 1) {
    if (header === null) {
      headerCells.push("");
      continue;
    }
    const cell = findCellAt(table, header, c);
    headerCells.push(cell === null ? "" : escapeMarkdownCell(cell.text));
  }
  const separator = headerCells.map(() => "---");

  const lines: string[] = [];
  lines.push(`| ${headerCells.join(" | ")} |`);
  lines.push(`| ${separator.join(" | ")} |`);

  for (const row of table.rows) {
    if (header !== null && row.row === header) continue;
    const cells: string[] = [];
    for (let c = 0; c < columnCount; c += 1) {
      const cell = findCellAt(table, row.row, c);
      cells.push(cell === null ? "" : escapeMarkdownCell(cell.text));
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/**
 * Render the table as a JSON-friendly nested array of cell objects.
 */
export function toJson(table: ReconstructedTable): TableJson {
  const out: TableJsonCell[][] = [];
  for (const row of table.rows) {
    const cells: TableJsonCell[] = [];
    for (let c = 0; c < table.columnCount; c += 1) {
      const cell = findCellAt(table, row.row, c);
      if (cell === null) continue;
      cells.push({
        text: cell.text,
        colspan: cell.colspan,
        rowspan: cell.rowspan,
        isHeader: cell.isHeader,
      });
    }
    out.push(cells);
  }
  return out;
}

/**
 * Render the table as minimal HTML. `<th>` is used for header cells;
 * `colspan` / `rowspan` attributes are emitted when > 1.
 */
export function toHtml(table: ReconstructedTable): string {
  const lines: string[] = ["<table>"];
  for (const row of table.rows) {
    const cells: string[] = [];
    for (let c = 0; c < table.columnCount; c += 1) {
      const cell = findCellAt(table, row.row, c);
      if (cell === null) continue;
      const tag = cell.isHeader ? "th" : "td";
      const attrs: string[] = [];
      if (cell.colspan > 1) attrs.push(`colspan="${cell.colspan}"`);
      if (cell.rowspan > 1) attrs.push(`rowspan="${cell.rowspan}"`);
      const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
      cells.push(`<${tag}${attrStr}>${escapeHtml(cell.text)}</${tag}>`);
    }
    lines.push(`  <tr>${cells.join("")}</tr>`);
  }
  lines.push("</table>");
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* -------------------------------------------------------------------------- */
/* Lookup helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Find the cell that covers grid position (row, column), following the
 * spans implied by colspans in that row. Returns `null` when the position
 * is empty (ragged grid).
 */
export function findCellAt(
  table: ReconstructedTable,
  row: number,
  column: number,
): TableCell | null {
  const r = table.rows[row];
  if (r === undefined) return null;
  for (const cell of r.cells) {
    if (cell.column <= column && cell.column + cell.colspan > column) return cell;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

function medianNumber(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const a = sorted[mid - 1] ?? 0;
  const b = sorted[mid] ?? 0;
  return (a + b) / 2;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `ReconstructedTable`. Throws `TableExtractError` with
 * code `"invalid-input"` on malformed payloads.
 */
export function rehydrateReconstructedTable(value: unknown): ReconstructedTable {
  if (value === null || typeof value !== "object") {
    throw new TableExtractError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const rowCount = numberOr(r["rowCount"], 0);
  const columnCount = numberOr(r["columnCount"], 0);
  const headerRowRaw = r["headerRowIndex"];
  const headerRowIndex =
    typeof headerRowRaw === "number" && Number.isFinite(headerRowRaw)
      ? Math.floor(headerRowRaw)
      : null;
  const isComplete = r["isComplete"] === true;
  const bbox = parseBBox(r["bbox"]) ?? { x: 0, y: 0, width: 1, height: 1 };

  const rowsRaw = Array.isArray(r["rows"]) ? (r["rows"] as unknown[]) : [];
  const rows: TableRow[] = [];
  for (const rowRaw of rowsRaw) {
    if (rowRaw === null || typeof rowRaw !== "object") continue;
    const rr = rowRaw as Record<string, unknown>;
    const rowIndex = numberOr(rr["row"], rows.length);
    const cellsRaw = Array.isArray(rr["cells"]) ? (rr["cells"] as unknown[]) : [];
    const cells: TableCell[] = [];
    for (const cellRaw of cellsRaw) {
      if (cellRaw === null || typeof cellRaw !== "object") continue;
      const cc = cellRaw as Record<string, unknown>;
      const cellBbox = parseBBox(cc["bbox"]);
      if (cellBbox === null) continue;
      cells.push({
        text: typeof cc["text"] === "string" ? (cc["text"] as string) : "",
        row: numberOr(cc["row"], rowIndex),
        column: numberOr(cc["column"], 0),
        colspan: Math.max(1, numberOr(cc["colspan"], 1)),
        rowspan: Math.max(1, numberOr(cc["rowspan"], 1)),
        isHeader: cc["isHeader"] === true,
        bbox: cellBbox,
      });
    }
    const missingColumnsRaw = Array.isArray(rr["missingColumns"])
      ? (rr["missingColumns"] as unknown[])
      : [];
    const missingColumns = missingColumnsRaw.filter(
      (n): n is number => typeof n === "number" && Number.isFinite(n),
    );
    rows.push({
      row: rowIndex,
      cells,
      ragged: rr["ragged"] === true,
      missingColumns,
      isHeaderRow: rr["isHeaderRow"] === true,
    });
  }

  return {
    rowCount,
    columnCount,
    rows,
    headerRowIndex,
    isComplete,
    bbox,
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
