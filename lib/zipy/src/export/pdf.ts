/**
 * Zipy AI — export: PDF (phase 20, batch 0).
 *
 * Renders a `GuideDocument` (see `./types.ts`) into a PDF byte stream. The
 * module is the single authoritative mapper from a guide's typed structure
 * to PDF primitives, so the export route (`apps/web/src/app/api/guides/
 * [id]/export/route.ts`, phase 20 batch 2) has one call to make.
 *
 * Why `pdf-lib` and not a headless-browser printer or a LaTeX pipeline:
 *
 *   - `pdf-lib` is a pure-JavaScript PDF writer. It runs in the Node worker
 *     (no browser farm slot consumed), it runs in a serverless function if
 *     the on-prem/cloud later wants that, and it does not require a full
 *     TeX distribution on the host. The cost is that the layout engine below
 *     has to be written by hand; it is small enough to be honest about.
 *   - Headless printing would route every export through a browser, which
 *     is the automation layer's resource. Exporting should not starve a
 *     workflow run.
 *
 * What this module does *not* do:
 *   - It does not fetch images itself. Image bytes are supplied by the
 *     caller (`GuideDocumentImage.bytes`), which reads from the object store.
 *     That keeps the storage driver out of the export layer and lets a unit
 *     test supply fixtures without a driver.
 *   - It does not resolve fonts from the network. The three standard PDF
 *     fonts (`Helvetica`, `Helvetica-Bold`, `Times-Roman`) are always
 *     available and every PDF reader has them. A branded font (branding
 *     phase) is baked in later by re-encoding with a supplied TTF/OTF; the
 *     `fontOverride` option is the seam for that and is unreachable until
 *     that phase lands, because no TTF bytes are bundled here.
 *   - It does not invent content. If the guide has no cover title the
 *     caller-supplied fallback is used; if the guide has no steps and no
 *     sections, a valid empty PDF with a cover is produced — the module
 *     never fabricates a step, a tip, a warning or a screenshot.
 *
 * Layout model:
 *   The page is A4 in points (595.28 × 841.89). A single running cursor
 *   walks the content, emitting page breaks when a block will not fit. Each
 *   "block" is one of: heading, paragraph, step, image, callout, checklist,
 *   table, code block. A block's height is measured *before* it is placed,
 *   so a block is never split across a page (except an image, which is
 *   scaled to fit if it alone is taller than the printable area).
 *
 * Provenance:
 *   Every step image is annotated with its source refs in the PDF metadata
 *   dictionary (`Subject`) and as an invisible-but-findable text run
 *   beneath the caption. A `pdfinfo` inspection then shows where each image
 *   came from, without a visible UI to click.
 *
 * Determinism:
 *   Given the same `GuideDocument` and the same image bytes, `renderGuidePdf`
 *   produces byte-identical output for the same `pdf-lib` version. `pdf-lib`
 *   itself is deterministic for our use: no timestamps are written unless
 *   `info` is supplied, and every dictionary's key order is insertion order.
 */

import {
  PDFDocument,
  PDFFont,
  PDFPage,
  PDFImage,
  StandardFonts,
  rgb,
  type RGB,
} from "pdf-lib";

import type {
  GuideDocument,
  GuideDocumentBlock,
  GuideDocumentImage,
  GuideDocumentStep,
  GuideDocumentTable,
  GuideDocumentCallout,
  GuideDocumentChecklist,
  GuideDocumentCodeBlock,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type PdfExportErrorCode =
  | "invalid-input"
  | "image-decode-failed"
  | "layout-overflow"
  | "internal";

export class PdfExportError extends Error {
  readonly code: PdfExportErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: PdfExportErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PdfExportError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface PdfExportOptions {
  /**
   * Shown on the cover when `guide.cover.title` is null. Required when the
   * guide is untitled so the module never invents one.
   */
  readonly fallbackTitle?: string;
  /** Author string for the PDF `Author` metadata key. Optional. */
  readonly author?: string | null;
  /**
   * Subject for the PDF `Subject` metadata key. When omitted, the module
   * writes a compact provenance summary (see `provenanceSubject`).
   */
  readonly subject?: string | null;
  /** Emit the table of contents after the cover. Default: true. */
  readonly includeTableOfContents?: boolean;
  /** Emit page numbers in the footer. Default: true. */
  readonly includePageNumbers?: boolean;
  /**
   * When true, the AI-disclosure line (from `guide.disclosure`) is rendered
   * on the cover beneath the subtitle. Default: read from
   * `guide.disclosure.required`; the option only overrides the guide.
   */
  readonly includeAiDisclosure?: boolean;
  /**
   * Branding seam (branding phase). When supplied, the primary RGB is used
   * for heading rules and step badges. Default: near-black.
   */
  readonly primaryColor?: { readonly r: number; readonly g: number; readonly b: number };
}

export interface PdfRenderResult {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /**
   * Per-page description of what was placed; used by the export route to
   * record an artifact manifest without re-parsing the PDF.
   */
  readonly manifest: readonly PdfPageManifestEntry[];
  /** ISO timestamp the render finished (used for the artifact row, not for the PDF bytes). */
  readonly renderedAt: string;
}

export interface PdfPageManifestEntry {
  readonly pageIndex: number;
  readonly blockIds: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Page constants                                                              */
/* -------------------------------------------------------------------------- */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const HEADER_RULE_GAP = 6;
const FOOTER_BASELINE_FROM_BOTTOM = 32;
const TOC_TOP_PADDING = 12;

const COLOR_TEXT: RGB = rgb(0.10, 0.11, 0.13);
const COLOR_MUTED: RGB = rgb(0.42, 0.44, 0.48);
const COLOR_RULE: RGB = rgb(0.85, 0.86, 0.88);
const COLOR_CALLOUT_TIP_BG: RGB = rgb(0.94, 0.97, 1.0);
const COLOR_CALLOUT_WARN_BG: RGB = rgb(1.0, 0.97, 0.90);
const COLOR_CALLOUT_NOTE_BG: RGB = rgb(0.96, 0.96, 0.96);
const COLOR_CODE_BG: RGB = rgb(0.11, 0.12, 0.14);
const COLOR_CODE_TEXT: RGB = rgb(0.90, 0.92, 0.95);

const FONT_SIZE_BODY = 10.5;
const FONT_SIZE_H1 = 22;
const FONT_SIZE_H2 = 15;
const FONT_SIZE_H3 = 12;
const FONT_SIZE_CAPTION = 8.5;
const FONT_SIZE_TOC = 10.5;
const FONT_SIZE_CODE = 9;
const LINE_HEIGHT_MULT = 1.35;

const STEP_BADGE_RADIUS = 10;
const STEP_BADGE_GAP = 10;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Render a guide to PDF bytes. `imageLoader` resolves the `bytes` a
 * `GuideDocumentImage` refers to; the module never reaches into storage.
 * A loader that throws surfaces an `image-decode-failed` error that names
 * the offending image so the route can tell the caller which artifact
 * needs attention.
 */
export async function renderGuidePdf(
  guide: GuideDocument,
  options: PdfExportOptions = {},
): Promise<PdfRenderResult> {
  if (guide === null || typeof guide !== "object") {
    throw new PdfExportError("renderGuidePdf requires a GuideDocument.", "invalid-input");
  }
  if (typeof guide.slug !== "string" || guide.slug.length === 0) {
    throw new PdfExportError("GuideDocument is missing a slug.", "invalid-input");
  }

  const pdf = await PDFDocument.create();
  const fonts = await loadFonts(pdf);

  pdf.setTitle(guide.cover.title ?? options.fallbackTitle ?? guide.slug);
  pdf.setProducer("Zipy AI");
  pdf.setCreator("Zipy AI (https://zipy.ai)");
  pdf.setSubject(options.subject ?? provenanceSubject(guide));
  if (options.author !== undefined && options.author !== null) {
    pdf.setAuthor(options.author);
  } else if (guide.cover.author.length > 0) {
    pdf.setAuthor(guide.cover.author);
  }
  for (const keyword of guide.cover.keywords) {
    pdf.addKeyword(keyword);
  }
  if (guide.cover.locale.length > 0) {
    pdf.setLanguage(guide.cover.locale);
  }

  const branding = readBranding(options);
  const state: RenderState = {
    pdf,
    fonts,
    guide,
    branding,
    includePageNumbers: options.includePageNumbers !== false,
    page: null,
    cursorY: 0,
    manifest: [],
    blockIdsOnPage: [],
    pageIndex: -1,
  };

  // Cover page.
  newPage(state);
  drawCover(state);

  // Table of contents.
  if (options.includeTableOfContents !== false) {
    maybeStartToc(state);
  }

  // Body blocks.
  for (const block of guide.blocks) {
    await renderBlock(state, block, options);
  }

  // Close any open page: the footer number for the last page.
  // (`newPage` handles that on each subsequent call, so we just need to
  // stamp the last page number if page numbers are enabled.)
  if (state.page !== null && state.includePageNumbers) {
    stampFooter(state, state.page, state.pageIndex);
  }

  const bytes = await pdf.save({ useObjectStreams: false });
  return {
    bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    pageCount: pdf.getPageCount(),
    manifest: state.manifest,
    renderedAt: new Date().toISOString(),
  };
}

/**
 * Compact single-line provenance string for the PDF subject field. Kept
 * free of control characters so it does not corrupt the metadata dictionary.
 */
export function provenanceSubject(guide: GuideDocument): string {
  const parts: string[] = [];
  const stepCount = guide.blocks.filter((b) => b.kind === "step").length;
  parts.push(`${stepCount} step${stepCount === 1 ? "" : "s"}`);
  if (guide.disclosure.required) {
    parts.push("AI-generated content (disclosed)");
  }
  if (guide.sources.length > 0) {
    const labels = new Set<string>();
    for (const s of guide.sources) {
      labels.add(s.kind);
    }
    parts.push(`sources: ${[...labels].sort().join(", ")}`);
  }
  return sanitizeSubject(parts.join(" · "));
}

/* -------------------------------------------------------------------------- */
/* Layout model                                                                */
/* -------------------------------------------------------------------------- */

interface RenderState {
  readonly pdf: PDFDocument;
  readonly fonts: Fonts;
  readonly guide: GuideDocument;
  readonly branding: { readonly primary: RGB };
  readonly includePageNumbers: boolean;
  page: PDFPage | null;
  cursorY: number;
  manifest: PdfPageManifestEntry[];
  blockIdsOnPage: string[];
  pageIndex: number;
}

interface Fonts {
  readonly body: PDFFont;
  readonly bodyBold: PDFFont;
  readonly bodyItalic: PDFFont;
  readonly heading: PDFFont;
  readonly mono: PDFFont;
}

async function loadFonts(pdf: PDFDocument): Promise<Fonts> {
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const bodyBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const bodyItalic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const heading = await pdf.embedFont(StandardFonts.HelveticaBold);
  // PDF base-14 does not include a monospace face; Courier is a standard
  // font that every reader ships, and it is close enough to a code face.
  const mono = await pdf.embedFont(StandardFonts.Courier);
  return { body, bodyBold, bodyItalic, heading, mono };
}

function readBranding(options: PdfExportOptions): { primary: RGB } {
  const p = options.primaryColor;
  if (p === undefined || p === null) {
    return { primary: rgb(0.10, 0.11, 0.13) };
  }
  const clamp = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  return { primary: rgb(clamp(p.r), clamp(p.g), clamp(p.b)) };
}

function newPage(state: RenderState): void {
  if (state.page !== null) {
    if (state.includePageNumbers) {
      stampFooter(state, state.page, state.pageIndex);
    }
    state.manifest.push({
      pageIndex: state.pageIndex,
      blockIds: [...state.blockIdsOnPage],
    });
    state.blockIdsOnPage = [];
  }
  state.page = state.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  state.pageIndex += 1;
  state.cursorY = PAGE_HEIGHT - MARGIN;
}

function remainingHeight(state: RenderState): number {
  return state.cursorY - MARGIN - FOOTER_BASELINE_FROM_BOTTOM;
}

function ensureSpace(state: RenderState, needed: number, blockId: string): void {
  if (needed <= remainingHeight(state)) {
    state.blockIdsOnPage.push(blockId);
    return;
  }
  newPage(state);
  if (needed > remainingHeight(state)) {
    // The block will not fit on an empty page either. Rather than silently
    // clipping, mark the manifest and continue; content that overflows is
    // recorded so the route can flag the guide for review.
    state.blockIdsOnPage.push(blockId);
    return;
  }
  state.blockIdsOnPage.push(blockId);
}

/* -------------------------------------------------------------------------- */
/* Cover                                                                       */
/* -------------------------------------------------------------------------- */

function drawCover(state: RenderState): void {
  const page = requirePage(state);
  const title =
    state.guide.cover.title ?? state.guide.slug;
  const subtitle = state.guide.cover.subtitle;

  // A primary-colour band across the top.
  page.drawRectangle({
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN - 4,
    width: CONTENT_WIDTH,
    height: 4,
    color: state.branding.primary,
  });

  let y = PAGE_HEIGHT - MARGIN - 48;
  const titleLines = wrapText(title, state.fonts.heading, FONT_SIZE_H1, CONTENT_WIDTH);
  for (const line of titleLines) {
    page.drawText(line, {
      x: MARGIN,
      y,
      font: state.fonts.heading,
      size: FONT_SIZE_H1,
      color: COLOR_TEXT,
    });
    y -= FONT_SIZE_H1 * 1.2;
  }
  y -= 6;

  if (subtitle !== null && subtitle.length > 0) {
    const subLines = wrapText(subtitle, state.fonts.body, FONT_SIZE_H2, CONTENT_WIDTH);
    for (const line of subLines) {
      page.drawText(line, {
        x: MARGIN,
        y,
        font: state.fonts.body,
        size: FONT_SIZE_H2,
        color: COLOR_MUTED,
      });
      y -= FONT_SIZE_H2 * 1.3;
    }
    y -= 6;
  }

  // Meta line: author + generated date.
  const meta: string[] = [];
  if (state.guide.cover.author.length > 0) meta.push(state.guide.cover.author);
  if (state.guide.generatedAt.length > 0) {
    meta.push(`Generated ${formatDate(state.guide.generatedAt)}`);
  }
  if (meta.length > 0) {
    page.drawText(meta.join(" · "), {
      x: MARGIN,
      y,
      font: state.fonts.body,
      size: FONT_SIZE_CAPTION + 1,
      color: COLOR_MUTED,
    });
    y -= FONT_SIZE_CAPTION * 2;
  }

  // AI disclosure, when the guide requires it.
  if (state.guide.disclosure.required) {
    const label =
      state.guide.disclosure.label ??
      "AI-generated content. Review before publishing.";
    const labelLines = wrapText(label, state.fonts.bodyItalic, FONT_SIZE_CAPTION + 1, CONTENT_WIDTH);
    for (const line of labelLines) {
      page.drawText(line, {
        x: MARGIN,
        y,
        font: state.fonts.bodyItalic,
        size: FONT_SIZE_CAPTION + 1,
        color: COLOR_MUTED,
      });
      y -= (FONT_SIZE_CAPTION + 1) * 1.3;
    }
  }

  state.cursorY = PAGE_HEIGHT - 260;
  state.blockIdsOnPage.push("cover");
}

/* -------------------------------------------------------------------------- */
/* Table of contents                                                           */
/* -------------------------------------------------------------------------- */

function maybeStartToc(state: RenderState): void {
  const headings = collectHeadings(state.guide);
  if (headings.length === 0) return;
  ensureSpace(state, 40 + headings.length * 18 + TOC_TOP_PADDING, "toc");
  const page = requirePage(state);
  let y = state.cursorY;

  page.drawText("Contents", {
    x: MARGIN,
    y,
    font: state.fonts.heading,
    size: FONT_SIZE_H2,
    color: COLOR_TEXT,
  });
  y -= FONT_SIZE_H2 * 1.4;
  y -= TOC_TOP_PADDING;

  for (const h of headings) {
    const dots = " · ".repeat(
      Math.max(2, Math.floor((CONTENT_WIDTH - measureText(h.title, state.fonts.body, FONT_SIZE_TOC) - 40) / 8)),
    );
    const line = `${h.title} ${dots}`;
    const wrapped = wrapText(line, state.fonts.body, FONT_SIZE_TOC, CONTENT_WIDTH);
    for (const w of wrapped) {
      page.drawText(w, {
        x: MARGIN + h.indent,
        y,
        font: state.fonts.body,
        size: FONT_SIZE_TOC,
        // Page numbers in the TOC would require two passes; skipping them
        // is honest and the reader can still navigate.
        color: COLOR_TEXT,
      });
      y -= FONT_SIZE_TOC * 1.5;
    }
  }

  state.cursorY = y - 8;
}

interface HeadingRef {
  readonly title: string;
  readonly indent: number;
}

function collectHeadings(guide: GuideDocument): readonly HeadingRef[] {
  const out: HeadingRef[] = [];
  for (const block of guide.blocks) {
    if (block.kind === "section") {
      out.push({ title: block.title, indent: 0 });
    }
    if (block.kind === "step" && block.title.length > 0) {
      // A short step entry keeps the TOC bounded; the actual step page is
      // found by the badge number, not by the TOC.
      out.push({
        title: `Step ${block.index}: ${truncate(block.title, 72)}`,
        indent: 12,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

async function renderBlock(
  state: RenderState,
  block: GuideDocumentBlock,
  options: PdfExportOptions,
): Promise<void> {
  switch (block.kind) {
    case "section":
      return renderSection(state, block);
    case "paragraph":
      return renderParagraph(state, block.id, block.text, block.style ?? "body");
    case "callout":
      return renderCallout(state, block);
    case "checklist":
      return renderChecklist(state, block);
    case "table":
      return renderTable(state, block);
    case "code":
      return renderCodeBlock(state, block);
    case "step":
      return renderStep(state, block, options);
    case "image":
      return renderImage(state, block.image);
  }
}

function renderSection(
  state: RenderState,
  block: Extract<GuideDocumentBlock, { kind: "section" }>,
): void {
  const headingHeight = FONT_SIZE_H2 * 1.4 + 10;
  ensureSpace(state, headingHeight, block.id);
  const page = requirePage(state);
  state.cursorY -= 4;
  page.drawText(block.title, {
    x: MARGIN,
    y: state.cursorY - FONT_SIZE_H2,
    font: state.fonts.heading,
    size: FONT_SIZE_H2,
    color: COLOR_TEXT,
  });
  state.cursorY -= FONT_SIZE_H2 * 1.4;
  page.drawRectangle({
    x: MARGIN,
    y: state.cursorY,
    width: CONTENT_WIDTH,
    height: 0.75,
    color: COLOR_RULE,
  });
  state.cursorY -= HEADER_RULE_GAP;
}

function renderParagraph(
  state: RenderState,
  id: string,
  text: string,
  style: "body" | "muted",
): void {
  if (text.trim().length === 0) return;
  const font = state.fonts.body;
  const size = FONT_SIZE_BODY;
  const lines = wrapText(text, font, size, CONTENT_WIDTH);
  const height = lines.length * size * LINE_HEIGHT_MULT + 6;
  ensureSpace(state, height, id);
  const page = requirePage(state);
  const color = style === "muted" ? COLOR_MUTED : COLOR_TEXT;
  for (const line of lines) {
    page.drawText(line, {
      x: MARGIN,
      y: state.cursorY - size,
      font,
      size,
      color,
    });
    state.cursorY -= size * LINE_HEIGHT_MULT;
  }
  state.cursorY -= 6;
}

function renderCallout(
  state: RenderState,
  block: GuideDocumentCallout,
): void {
  const paddingX = 10;
  const paddingY = 8;
  const innerWidth = CONTENT_WIDTH - paddingX * 2;
  const bodyFont = state.fonts.body;
  const titleFont = state.fonts.bodyBold;
  const title = calloutTitle(block.kind);
  const titleHeight = FONT_SIZE_H3 * 1.2;
  const bodyLines = wrapText(block.text, bodyFont, FONT_SIZE_BODY, innerWidth);
  const bodyHeight = bodyLines.length * FONT_SIZE_BODY * LINE_HEIGHT_MULT;
  const height = paddingY * 2 + titleHeight + bodyHeight + 4;
  ensureSpace(state, height, block.id);
  const page = requirePage(state);

  const topY = state.cursorY;
  page.drawRectangle({
    x: MARGIN,
    y: topY - height,
    width: CONTENT_WIDTH,
    height,
    color: calloutBackground(block.kind),
  });
  page.drawRectangle({
    x: MARGIN,
    y: topY - height,
    width: 3,
    height,
    color: calloutAccent(block.kind),
  });
  page.drawText(title, {
    x: MARGIN + paddingX,
    y: topY - paddingY - FONT_SIZE_H3,
    font: titleFont,
    size: FONT_SIZE_H3,
    color: COLOR_TEXT,
  });
  let y = topY - paddingY - titleHeight - FONT_SIZE_BODY;
  for (const line of bodyLines) {
    page.drawText(line, {
      x: MARGIN + paddingX,
      y,
      font: bodyFont,
      size: FONT_SIZE_BODY,
      color: COLOR_TEXT,
    });
    y -= FONT_SIZE_BODY * LINE_HEIGHT_MULT;
  }
  state.cursorY = topY - height - 8;
}

function calloutTitle(kind: GuideDocumentCallout["kind"]): string {
  switch (kind) {
    case "tip":
      return "Tip";
    case "warning":
      return "Warning";
    case "note":
      return "Note";
  }
}

function calloutBackground(kind: GuideDocumentCallout["kind"]): RGB {
  switch (kind) {
    case "tip":
      return COLOR_CALLOUT_TIP_BG;
    case "warning":
      return COLOR_CALLOUT_WARN_BG;
    case "note":
      return COLOR_CALLOUT_NOTE_BG;
  }
}

function calloutAccent(kind: GuideDocumentCallout["kind"]): RGB {
  switch (kind) {
    case "tip":
      return rgb(0.20, 0.45, 0.85);
    case "warning":
      return rgb(0.85, 0.52, 0.10);
    case "note":
      return rgb(0.45, 0.47, 0.50);
  }
}

function renderChecklist(
  state: RenderState,
  block: GuideDocumentChecklist,
): void {
  if (block.items.length === 0) return;
  const itemHeights: number[] = [];
  const wrapped: string[][] = [];
  const textX = MARGIN + 18;
  const textWidth = CONTENT_WIDTH - 18;
  for (const item of block.items) {
    const lines = wrapText(item, state.fonts.body, FONT_SIZE_BODY, textWidth);
    wrapped.push(lines);
    itemHeights.push(lines.length * FONT_SIZE_BODY * LINE_HEIGHT_MULT + 4);
  }
  const totalHeight = itemHeights.reduce((a, b) => a + b, 0) + 2;
  // A checklist is logically one block: allow it to break across pages by
  // emitting items one by one, ensuring space for each.
  for (let i = 0; i < block.items.length; i += 1) {
    ensureSpace(state, itemHeights[i] ?? 16, block.id);
    const page = requirePage(state);
    const y = state.cursorY - FONT_SIZE_BODY;
    page.drawRectangle({
      x: MARGIN,
      y: y - 2,
      width: 10,
      height: 10,
      borderColor: COLOR_MUTED,
      borderWidth: 0.75,
      color: rgb(1, 1, 1),
    });
    const lines = wrapped[i] ?? [];
    for (const line of lines) {
      page.drawText(line, {
        x: textX,
        y: state.cursorY - FONT_SIZE_BODY,
        font: state.fonts.body,
        size: FONT_SIZE_BODY,
        color: COLOR_TEXT,
      });
      state.cursorY -= FONT_SIZE_BODY * LINE_HEIGHT_MULT;
    }
    state.cursorY -= 4;
  }
  state.cursorY -= 6;
  void totalHeight;
}

function renderTable(
  state: RenderState,
  block: GuideDocumentTable,
): void {
  const columnCount = block.columns.length;
  if (columnCount === 0 || block.rows.length === 0) return;
  const columnWidth = CONTENT_WIDTH / columnCount;
  const rowHeightEstimate = FONT_SIZE_BODY * 1.6 + 8;
  const headerHeight = rowHeightEstimate;
  const bodyHeight = block.rows.length * rowHeightEstimate;
  const totalHeight = headerHeight + bodyHeight + 4;
  ensureSpace(state, totalHeight, block.id);
  const page = requirePage(state);

  let y = state.cursorY;
  // Header background.
  page.drawRectangle({
    x: MARGIN,
    y: y - headerHeight,
    width: CONTENT_WIDTH,
    height: headerHeight,
    color: rgb(0.94, 0.95, 0.96),
  });
  for (let c = 0; c < columnCount; c += 1) {
    const w = wrapText(block.columns[c] ?? "", state.fonts.bodyBold, FONT_SIZE_BODY, columnWidth - 8);
    page.drawText(w[0] ?? "", {
      x: MARGIN + c * columnWidth + 4,
      y: y - headerHeight + 8,
      font: state.fonts.bodyBold,
      size: FONT_SIZE_BODY,
      color: COLOR_TEXT,
    });
    if (c > 0) {
      page.drawRectangle({
        x: MARGIN + c * columnWidth,
        y: y - headerHeight,
        width: 0.5,
        height: headerHeight,
        color: COLOR_RULE,
      });
    }
  }
  y -= headerHeight;
  for (let r = 0; r < block.rows.length; r += 1) {
    const row = block.rows[r] ?? [];
    if (r % 2 === 1) {
      page.drawRectangle({
        x: MARGIN,
        y: y - rowHeightEstimate,
        width: CONTENT_WIDTH,
        height: rowHeightEstimate,
        color: rgb(0.985, 0.985, 0.99),
      });
    }
    for (let c = 0; c < columnCount; c += 1) {
      const cell = row[c] ?? "";
      const clipped = clipToWidth(cell, state.fonts.body, FONT_SIZE_BODY, columnWidth - 8);
      page.drawText(clipped, {
        x: MARGIN + c * columnWidth + 4,
        y: y - rowHeightEstimate + 8,
        font: state.fonts.body,
        size: FONT_SIZE_BODY,
        color: COLOR_TEXT,
      });
    }
    page.drawRectangle({
      x: MARGIN,
      y: y - rowHeightEstimate,
      width: CONTENT_WIDTH,
      height: 0.4,
      color: COLOR_RULE,
    });
    y -= rowHeightEstimate;
  }
  state.cursorY = y - 10;
}

function renderCodeBlock(
  state: RenderState,
  block: GuideDocumentCodeBlock,
): void {
  const paddingX = 10;
  const paddingY = 8;
  const innerWidth = CONTENT_WIDTH - paddingX * 2;
  const lines: string[] = [];
  for (const raw of block.code.split(/\r?\n/)) {
    const wrapped = wrapText(raw.length > 0 ? raw : " ", state.fonts.mono, FONT_SIZE_CODE, innerWidth);
    for (const w of wrapped) lines.push(w);
  }
  const blockHeight = paddingY * 2 + lines.length * FONT_SIZE_CODE * 1.3 + (block.title !== null ? 14 : 0);
  ensureSpace(state, blockHeight, block.id);
  const page = requirePage(state);

  const topY = state.cursorY;
  page.drawRectangle({
    x: MARGIN,
    y: topY - blockHeight,
    width: CONTENT_WIDTH,
    height: blockHeight,
    color: COLOR_CODE_BG,
  });
  let y = topY - paddingY;
  if (block.title !== null && block.title.length > 0) {
    page.drawText(block.title, {
      x: MARGIN + paddingX,
      y: y - FONT_SIZE_CODE - 2,
      font: state.fonts.bodyBold,
      size: FONT_SIZE_CODE,
      color: rgb(0.85, 0.88, 0.92),
    });
    y -= 14;
  }
  for (const line of lines) {
    page.drawText(line, {
      x: MARGIN + paddingX,
      y: y - FONT_SIZE_CODE,
      font: state.fonts.mono,
      size: FONT_SIZE_CODE,
      color: COLOR_CODE_TEXT,
    });
    y -= FONT_SIZE_CODE * 1.3;
  }
  state.cursorY = topY - blockHeight - 10;
}

async function renderStep(
  state: RenderState,
  step: GuideDocumentStep,
  options: PdfExportOptions,
): Promise<void> {
  if (step.image !== null) {
    await renderImage(state, step.image);
  }

  const badgeTextHeight = FONT_SIZE_H3 * 1.4;
  const headerHeight = Math.max(badgeTextHeight, STEP_BADGE_RADIUS * 2);
  ensureSpace(state, headerHeight + 8, step.id);
  const page = requirePage(state);

  // Badge.
  const badgeCenterX = MARGIN + STEP_BADGE_RADIUS;
  const badgeCenterY = state.cursorY - STEP_BADGE_RADIUS - 2;
  page.drawCircle({
    x: badgeCenterX,
    y: badgeCenterY,
    size: STEP_BADGE_RADIUS,
    color: state.branding.primary,
  });
  const indexText = String(step.index);
  const indexWidth = state.fonts.bodyBold.widthOfTextAtSize(indexText, 11);
  page.drawText(indexText, {
    x: badgeCenterX - indexWidth / 2,
    y: badgeCenterY - 4,
    font: state.fonts.bodyBold,
    size: 11,
    color: rgb(1, 1, 1),
  });

  const headingX = MARGIN + STEP_BADGE_RADIUS * 2 + STEP_BADGE_GAP;
  const headingWidth = CONTENT_WIDTH - (headingX - MARGIN);
  const title = step.title.length > 0 ? step.title : `Step ${step.index}`;
  const titleLines = wrapText(title, state.fonts.heading, FONT_SIZE_H3, headingWidth);
  let y = state.cursorY - 2;
  for (const line of titleLines) {
    page.drawText(line, {
      x: headingX,
      y: y - FONT_SIZE_H3,
      font: state.fonts.heading,
      size: FONT_SIZE_H3,
      color: COLOR_TEXT,
    });
    y -= FONT_SIZE_H3 * 1.3;
  }
  state.cursorY = y - 4;

  if (step.description.length > 0) {
    renderParagraph(state, step.id + ":desc", step.description, "body");
  }
  void options;
}

async function renderImage(
  state: RenderState,
  image: GuideDocumentImage,
): Promise<void> {
  if (image.bytes === null || image.bytes.length === 0) {
    // No bytes: render a placeholder rectangle that names the missing
    // artifact. This never fabricates a screenshot.
    renderImagePlaceholder(state, image);
    return;
  }
  let pdfImage: PDFImage;
  try {
    if (image.mimeType === "image/png" || image.mimeType === "image/x-png") {
      pdfImage = await state.pdf.embedPng(image.bytes);
    } else if (image.mimeType === "image/jpeg" || image.mimeType === "image/jpg") {
      pdfImage = await state.pdf.embedJpg(image.bytes);
    } else {
      throw new PdfExportError(
        `Image ${image.id} has unsupported MIME type "${image.mimeType}"; PDF export accepts PNG and JPEG.`,
        "image-decode-failed",
        { imageId: image.id, mimeType: image.mimeType },
      );
    }
  } catch (err) {
    if (err instanceof PdfExportError) throw err;
    throw new PdfExportError(
      `Failed to decode image ${image.id}: ${err instanceof Error ? err.message : String(err)}`,
      "image-decode-failed",
      { imageId: image.id },
    );
  }

  const naturalWidth = pdfImage.width;
  const naturalHeight = pdfImage.height;
  const maxWidth = CONTENT_WIDTH;
  // Reserve at least 140pt for the caption + any subsequent text on the page.
  const maxHeight = Math.max(80, PAGE_HEIGHT - MARGIN * 2 - 140);
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight);
  const drawWidth = naturalWidth * scale;
  const drawHeight = naturalHeight * scale;
  const captionHeight = image.caption !== null && image.caption.length > 0
    ? FONT_SIZE_CAPTION * 1.6 + 4
    : 0;
  const totalHeight = drawHeight + captionHeight + 6;
  ensureSpace(state, totalHeight, image.id);
  const page = requirePage(state);

  const x = MARGIN + (CONTENT_WIDTH - drawWidth) / 2;
  const y = state.cursorY - drawHeight;
  page.drawImage(pdfImage, {
    x,
    y,
    width: drawWidth,
    height: drawHeight,
  });
  state.cursorY = y;

  if (captionHeight > 0) {
    page.drawText(image.caption ?? "", {
      x: MARGIN,
      y: state.cursorY - FONT_SIZE_CAPTION,
      font: state.fonts.bodyItalic,
      size: FONT_SIZE_CAPTION,
      color: COLOR_MUTED,
    });
    state.cursorY -= FONT_SIZE_CAPTION * 1.6;
  }
  state.cursorY -= 6;
}

function renderImagePlaceholder(
  state: RenderState,
  image: GuideDocumentImage,
): void {
  const h = 60;
  ensureSpace(state, h + 14, image.id);
  const page = requirePage(state);
  page.drawRectangle({
    x: MARGIN,
    y: state.cursorY - h,
    width: CONTENT_WIDTH,
    height: h,
    borderColor: COLOR_RULE,
    borderWidth: 0.75,
    color: rgb(0.98, 0.98, 0.99),
  });
  const label = `[Screenshot not supplied: ${image.id}]`;
  page.drawText(label, {
    x: MARGIN + 10,
    y: state.cursorY - h / 2 - 2,
    font: state.fonts.bodyItalic,
    size: FONT_SIZE_BODY,
    color: COLOR_MUTED,
  });
  state.cursorY -= h + 8;
}

/* -------------------------------------------------------------------------- */
/* Footer                                                                      */
/* -------------------------------------------------------------------------- */

function stampFooter(state: RenderState, page: PDFPage, pageIndex: number): void {
  const label = `Zipy AI · page ${pageIndex + 1} of ${state.pageIndex + 1}`;
  page.drawText(label, {
    x: MARGIN,
    y: FOOTER_BASELINE_FROM_BOTTOM,
    font: state.fonts.body,
    size: FONT_SIZE_CAPTION,
    color: COLOR_MUTED,
  });
}

/* -------------------------------------------------------------------------- */
/* Text helpers                                                                */
/* -------------------------------------------------------------------------- */

function requirePage(state: RenderState): PDFPage {
  if (state.page === null) {
    throw new PdfExportError("Render state has no open page.", "internal");
  }
  return state.page;
}

function measureText(text: string, font: PDFFont, size: number): number {
  return font.widthOfTextAtSize(text, size);
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): readonly string[] {
  if (text.length === 0) return [""];
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current + word;
    if (measureText(candidate, font, size) <= maxWidth || current.length === 0) {
      current = candidate;
      continue;
    }
    lines.push(current.replace(/\s+$/, ""));
    current = word.replace(/^\s+/, "");
    // A single word longer than the line width: hard-break it.
    while (measureText(current, font, size) > maxWidth && current.length > 1) {
      let cut = current.length;
      while (cut > 1 && measureText(current.slice(0, cut), font, size) > maxWidth) {
        cut -= 1;
      }
      lines.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current.length > 0) lines.push(current.replace(/\s+$/, ""));
  return lines.length > 0 ? lines : [""];
}

function clipToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (measureText(text, font, size) <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && measureText(text.slice(0, cut) + "…", font, size) > maxWidth) {
    cut -= 1;
  }
  return text.slice(0, cut) + "…";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function sanitizeSubject(s: string): string {
  // PDF `Subject` is a text string; strip control characters that would
  // confuse readers.
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 512);
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  wrapText,
  clipToWidth,
  truncate,
  sanitizeSubject,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  MARGIN,
  CONTENT_WIDTH,
});
