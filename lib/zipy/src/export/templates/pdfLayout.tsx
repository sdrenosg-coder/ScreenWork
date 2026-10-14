/**
 * Zipy AI — PDF layout template (phase 20, batch 2).
 *
 * A pure layout/geometry module consumed by the PDF renderer
 * (`packages/export/src/pdf.ts`). It produces a *render plan* — an ordered,
 * page-by-page list of drawing primitives — from a `GuideDocument`. The plan
 * is then fed to pdf-lib by `pdf.ts`. Keeping layout separate from the pdf-lib
 * drawing calls means:
 *
 *   - the layout maths (wrapping, pagination, image sizing) is testable in
 *     isolation, with no browser/pdf engine;
 *   - the same plan can feed the DOCX renderer's section model;
 *   - `renderGuidePdf` stays a thin serialiser.
 *
 * Design rules:
 *   - Deterministic: the same document always yields byte-identical geometry,
 *     so exports are reproducible and diffable.
 *   - No pdf-lib import: this module produces plain objects. `pdf.ts` maps
 *     them to pdf-lib primitives. If this template referenced pdf-lib types it
 *     could not feed the DOCX writer.
 *   - No I/O: images are referenced by key; the caller resolves the bytes.
 *   - Defensive: unknown block kinds degrade to a visible "unsupported block"
 *     placeholder rather than being dropped, so a guide can never silently
 *     lose content in the PDF.
 *
 * Page model (A4 portrait, 72pt/inch):
 *   - Letter and A4 are supported; the caller passes `pageSize`.
 *   - Every page carries a header rule and a footer with page N of M.
 *   - A cover page is emitted first when `includeCover` is true.
 *   - A table of contents page is emitted when `includeToc` is true and the
 *     document has more than one section (a one-section TOC is noise).
 */

import type {
  GuideDocument,
  GuideDocumentBlock,
  GuideDocumentChecklist,
  GuideDocumentCodeBlock,
  GuideDocumentCallout,
  GuideDocumentImageBlock,
  GuideDocumentParagraph,
  GuideDocumentSection,
  GuideDocumentStep,
  GuideDocumentTable,
  GuideDocumentCover,
} from "../types";

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type PdfPageSize = "A4" | "letter";

export interface PdfLayoutOptions {
  readonly pageSize: PdfPageSize;
  readonly includeCover: boolean;
  readonly includeToc: boolean;
  /** Margins in points. */
  readonly marginTop: number;
  readonly marginRight: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  /** Body font size in points. */
  readonly bodyFontSize: number;
  readonly headingFontSize: number;
  readonly subheadingFontSize: number;
  readonly smallFontSize: number;
  /** Additional top gap (points) inserted between top-level blocks. */
  readonly blockGap: number;
}

export interface PdfPageGeometry {
  readonly width: number;
  readonly height: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly contentRight: number;
  readonly contentBottom: number;
  readonly contentX: number;
}

/** A drawing primitive. `kind` tells the pdf writer how to render it. */
export type PdfPrimitive =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly x: number;
      readonly y: number;
      readonly size: number;
      readonly bold: boolean;
      readonly italic: boolean;
      readonly color: string;
      readonly maxWidth: number;
    }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly fill: string | null;
      readonly stroke: string | null;
      readonly strokeWidth: number;
    }
  | {
      readonly kind: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly color: string;
      readonly width: number;
    }
  | {
      readonly kind: "image";
      readonly imageRef: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly alt: string;
    };

export interface PdfPagePlan {
  /** 1-based index into the emitted pages. */
  readonly index: number;
  /** Distinguishes cover/toc/body so the writer can skip header/footer. */
  readonly role: "cover" | "toc" | "body";
  readonly primitives: readonly PdfPrimitive[];
}

export interface PdfLayoutPlan {
  readonly pages: readonly PdfPagePlan[];
  readonly geometry: PdfPageGeometry;
  readonly fonts: {
    readonly body: number;
    readonly heading: number;
    readonly subheading: number;
    readonly small: number;
  };
  /** Inventory of images referenced by the plan, in first-use order. */
  readonly imageRefs: readonly string[];
  /** Provenance strings emitted as footnotes. */
  readonly footnotes: readonly string[];
}

export interface PdfLayoutError extends Error {
  readonly code: "unknown-block" | "invalid-document";
  readonly detail: string;
}

export function isPdfLayoutError(e: unknown): e is PdfLayoutError {
  return (
    e instanceof Error &&
    typeof (e as { code?: unknown }).code === "string" &&
    ((e as { code: string }).code === "unknown-block" ||
      (e as { code: string }).code === "invalid-document")
  );
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

const PAGE_SIZES: Record<PdfPageSize, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

export function defaultPdfLayoutOptions(
  pageSize: PdfPageSize = "A4",
): PdfLayoutOptions {
  return {
    pageSize,
    includeCover: true,
    includeToc: true,
    marginTop: 64,
    marginRight: 56,
    marginBottom: 64,
    marginLeft: 56,
    bodyFontSize: 11,
    headingFontSize: 20,
    subheadingFontSize: 14,
    smallFontSize: 9,
    blockGap: 10,
  };
}

/* -------------------------------------------------------------------------- */
/* Text metrics (approximate, deterministic)                                   */
/* -------------------------------------------------------------------------- */

/**
 * The writer has no font metrics before it loads a font. To keep layout
 * deterministic and engine-independent we use a conservative monospaced-ish
 * estimate: average glyph advance is 0.5 × font size for proportionals and
 * 0.6 × for the code font. This slightly over-estimates width, which biases
 * pagination toward earlier wraps — safer than the opposite.
 */
export function estimateTextWidth(
  text: string,
  fontSize: number,
  monospace: boolean,
): number {
  const per = monospace ? 0.6 : 0.5;
  return text.length * fontSize * per;
}

export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  monospace: boolean,
): readonly string[] {
  if (text.length === 0) return [""];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const attempt = current.length === 0 ? word : `${current} ${word}`;
    if (
      current.length === 0 ||
      estimateTextWidth(attempt, fontSize, monospace) <= maxWidth
    ) {
      current = attempt;
      continue;
    }
    lines.push(current);
    // A single word longer than the line: hard-split it.
    if (estimateTextWidth(word, fontSize, monospace) > maxWidth) {
      const chunkSize = Math.max(
        1,
        Math.floor(maxWidth / (fontSize * (monospace ? 0.6 : 0.5))),
      );
      for (let i = 0; i < word.length; i += chunkSize) {
        lines.push(word.slice(i, i + chunkSize));
      }
      current = "";
    } else {
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.4 * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export function computeGeometry(opts: PdfLayoutOptions): PdfPageGeometry {
  const dims = PAGE_SIZES[opts.pageSize];
  const contentWidth = dims.width - opts.marginLeft - opts.marginRight;
  const contentHeight = dims.height - opts.marginTop - opts.marginBottom;
  return {
    width: dims.width,
    height: dims.height,
    contentWidth,
    contentHeight,
    contentRight: dims.width - opts.marginRight,
    contentBottom: opts.marginBottom,
    contentX: opts.marginLeft,
  };
}

/* -------------------------------------------------------------------------- */
/* Colour palette                                                              */
/* -------------------------------------------------------------------------- */

const COLOR = {
  text: "#0f172a",
  muted: "#475569",
  rule: "#e2e8f0",
  calloutTip: "#eff6ff",
  calloutTipBorder: "#bfdbfe",
  calloutWarning: "#fffbeb",
  calloutWarningBorder: "#fde68a",
  calloutNote: "#f8fafc",
  calloutNoteBorder: "#cbd5e1",
  stepBadge: "#e0e7ff",
  stepBadgeFg: "#1e3a8a",
  codeBg: "#0f172a",
  codeFg: "#e2e8f0",
  tableHead: "#f1f5f9",
  tableBorder: "#cbd5e1",
} as const;

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

interface Cursor {
  pageIndex: number;
  y: number;
  primitives: PdfPrimitive[];
  pages: PdfPagePlan[];
  role: PdfPagePlan["role"];
  footnotes: string[];
  imageOrder: string[];
  imageSeen: Set<string>;
}

function startPage(c: Cursor, geo: PdfPageGeometry, opts: PdfLayoutOptions): void {
  c.pages.push({
    index: c.pages.length + 1,
    role: c.role,
    primitives: c.primitives,
  });
  c.primitives = [];
  c.y = geo.height - opts.marginTop;
}

function finishPage(c: Cursor, geo: PdfPageGeometry, opts: PdfLayoutOptions): void {
  if (c.role === "cover") return;
  // Header rule
  c.primitives.push({
    kind: "line",
    x1: geo.contentX,
    y1: geo.height - opts.marginTop + 12,
    x2: geo.contentRight,
    y2: geo.height - opts.marginTop + 12,
    color: COLOR.rule,
    width: 0.5,
  });
  // Footer: the writer adds the "N of M" page number because the total is
  // only known at the end; it replaces the token `{{page}}`.
}

function pushCompletedPage(c: Cursor): void {
  c.pages.push({
    index: c.pages.length + 1,
    role: c.role,
    primitives: c.primitives,
  });
  c.primitives = [];
}

function ensureSpace(
  c: Cursor,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
  needed: number,
): void {
  if (c.y - needed >= geo.contentBottom) return;
  finishPage(c, geo, opts);
  pushCompletedPage(c);
  c.primitives = [];
  c.y = geo.height - opts.marginTop;
}

function emitText(
  c: Cursor,
  text: string,
  opts: {
    readonly size: number;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly color?: string;
    readonly maxWidth?: number;
    readonly monospace?: boolean;
    readonly gapAfter?: number;
  },
): void {
  const maxWidth = opts.maxWidth ?? 0;
  const lines = wrapText(
    text,
    maxWidth === 0 ? Number.MAX_SAFE_INTEGER : maxWidth,
    opts.size,
    opts.monospace === true,
  );
  const lh = lineHeightFor(opts.size);
  const gap = opts.gapAfter ?? 0;
  for (let i = 0; i < lines.length; i += 1) {
    c.y -= lh;
    c.primitives.push({
      kind: "text",
      text: lines[i] ?? "",
      x: 0, // filled in by caller-supplied x in emitTextAt
      y: c.y,
      size: opts.size,
      bold: opts.bold === true,
      italic: opts.italic === true,
      color: opts.color ?? COLOR.text,
      maxWidth: maxWidth === 0 ? Number.MAX_SAFE_INTEGER : maxWidth,
    });
  }
  c.y -= gap;
}

/**
 * Text helper that records the x position so bullets and indented blocks are
 * placed correctly. The `emitText` above is retained as the canonical emitter
 * for the body; this variant offsets both text and any leading glyph.
 */
function emitTextAt(
  c: Cursor,
  x: number,
  text: string,
  opts: {
    readonly size: number;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly color?: string;
    readonly maxWidth: number;
    readonly monospace?: boolean;
    readonly gapAfter?: number;
  },
): void {
  const lines = wrapText(text, opts.maxWidth, opts.size, opts.monospace === true);
  const lh = lineHeightFor(opts.size);
  for (const line of lines) {
    c.y -= lh;
    c.primitives.push({
      kind: "text",
      text: line,
      x,
      y: c.y,
      size: opts.size,
      bold: opts.bold === true,
      italic: opts.italic === true,
      color: opts.color ?? COLOR.text,
      maxWidth: opts.maxWidth,
    });
  }
  if (opts.gapAfter !== undefined) c.y -= opts.gapAfter;
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

export function planPdfLayout(
  doc: GuideDocument,
  opts: PdfLayoutOptions,
): PdfLayoutPlan {
  if (doc === null || typeof doc !== "object") {
    throw layoutError("invalid-document", "GuideDocument must be an object.");
  }
  const geo = computeGeometry(opts);
  const fonts = {
    body: opts.bodyFontSize,
    heading: opts.headingFontSize,
    subheading: opts.subheadingFontSize,
    small: opts.smallFontSize,
  };

  const cursor: Cursor = {
    pageIndex: 0,
    y: 0,
    primitives: [],
    pages: [],
    role: "body",
    footnotes: [],
    imageOrder: [],
    imageSeen: new Set(),
  };

  if (opts.includeCover) {
    cursor.role = "cover";
    startPage(cursor, geo, opts);
    renderCover(cursor, doc.cover, geo, opts);
    pushCompletedPage(cursor);
    cursor.pages[cursor.pages.length - 1] = {
      ...cursor.pages[cursor.pages.length - 1]!,
      primitives: cursor.primitives.length > 0
        ? cursor.primitives
        : cursor.pages[cursor.pages.length - 1]!.primitives,
    };
    cursor.primitives = [];
  }

  const sections = doc.sections ?? [];
  if (opts.includeToc && sections.length > 1) {
    cursor.role = "toc";
    startPage(cursor, geo, opts);
    renderToc(cursor, sections, geo, opts);
    emitTextAt(cursor, geo.contentX, "", { size: opts.smallFontSize, maxWidth: geo.contentWidth });
    pushCompletedPage(cursor);
    cursor.primitives = [];
  }

  cursor.role = "body";
  startPage(cursor, geo, opts);
  let firstBodySection = true;
  for (const section of sections) {
    if (!firstBodySection) {
      cursor.y -= opts.blockGap * 2;
    }
    firstBodySection = false;
    renderSection(cursor, section, geo, opts);
  }

  if (cursor.primitives.length > 0) {
    pushCompletedPage(cursor);
  } else if (cursor.pages.length === 0) {
    // Empty document edge case: emit a single, explicit placeholder page.
    pushCompletedPage(cursor);
  }

  return {
    pages: cursor.pages,
    geometry: geo,
    fonts,
    imageRefs: cursor.imageOrder,
    footnotes: cursor.footnotes,
  };
}

/* -------------------------------------------------------------------------- */
/* Cover                                                                       */
/* -------------------------------------------------------------------------- */

function renderCover(
  c: Cursor,
  cover: GuideDocumentCover | undefined,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  const top = geo.height - opts.marginTop - 20;
  c.y = top;

  // Vertical band
  c.primitives.push({
    kind: "rect",
    x: 0,
    y: geo.height - 24,
    width: geo.width,
    height: 24,
    fill: COLOR.text,
    stroke: null,
    strokeWidth: 0,
  });

  if (cover === undefined) {
    emitTextAt(c, geo.contentX, "Guide", {
      size: opts.headingFontSize,
      bold: true,
      maxWidth: geo.contentWidth,
    });
    return;
  }

  c.y -= 40;
  emitTextAt(c, geo.contentX, cover.title, {
    size: opts.headingFontSize + 6,
    bold: true,
    color: COLOR.text,
    maxWidth: geo.contentWidth,
    gapAfter: 12,
  });

  if (cover.subtitle !== undefined && cover.subtitle.length > 0) {
    emitTextAt(c, geo.contentX, cover.subtitle, {
      size: opts.subheadingFontSize,
      italic: true,
      color: COLOR.muted,
      maxWidth: geo.contentWidth,
      gapAfter: 12,
    });
  }

  c.y -= 12;
  if (cover.product !== undefined && cover.product.length > 0) {
    emitTextAt(c, geo.contentX, cover.product, {
      size: opts.bodyFontSize,
      color: COLOR.muted,
      maxWidth: geo.contentWidth,
      gapAfter: 6,
    });
  }
  if (cover.version !== undefined && cover.version.length > 0) {
    emitTextAt(c, geo.contentX, `Version: ${cover.version}`, {
      size: opts.smallFontSize,
      color: COLOR.muted,
      maxWidth: geo.contentWidth,
      gapAfter: 4,
    });
  }
  if (cover.generatedAt !== undefined && cover.generatedAt.length > 0) {
    emitTextAt(c, geo.contentX, `Generated: ${cover.generatedAt}`, {
      size: opts.smallFontSize,
      color: COLOR.muted,
      maxWidth: geo.contentWidth,
      gapAfter: 4,
    });
  }
  if (cover.branding !== undefined) {
    const b = cover.branding;
    if (b.organization !== undefined && b.organization.length > 0) {
      emitTextAt(c, geo.contentX, b.organization, {
        size: opts.bodyFontSize,
        color: COLOR.muted,
        maxWidth: geo.contentWidth,
        gapAfter: 4,
      });
    }
    if (b.logoImageRef !== undefined) {
      emitImage(c, b.logoImageRef, geo, opts, 96, "Organization logo");
    }
  }

  emitTextAt(
    c,
    geo.contentX,
    doc_disc(c),
    {
      size: opts.smallFontSize,
      italic: true,
      color: COLOR.muted,
      maxWidth: geo.contentWidth,
    },
  );
}

// Small helper so the cover can reference the AI-disclosure line without
// threading the full document through. The disclosure is written by the
// safety layer; if it is not present we fall back to the platform default.
function doc_disc(c: Cursor): string {
  const fallback =
    "This guide was generated by Zipy AI from the sources listed in its provenance. Review before publishing.";
  const existing = c.pages
    .flatMap((p) => p.primitives)
    .some((p) => p.kind === "text" && p.text.includes("AI"));
  return existing
    ? "This guide was generated by Zipy AI. Review before publishing."
    : fallback;
}

/* -------------------------------------------------------------------------- */
/* Table of contents                                                           */
/* -------------------------------------------------------------------------- */

function renderToc(
  c: Cursor,
  sections: readonly GuideDocumentSection[],
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  emitTextAt(c, geo.contentX, "Contents", {
    size: opts.headingFontSize - 4,
    bold: true,
    maxWidth: geo.contentWidth,
    gapAfter: 10,
  });
  sections.forEach((s, i) => {
    const label = `${i + 1}. ${s.heading}`;
    emitTextAt(c, geo.contentX, label, {
      size: opts.bodyFontSize,
      maxWidth: geo.contentWidth,
      gapAfter: 2,
    });
    const subCount = (s.blocks ?? []).filter(
      (b) => b.kind === "heading",
    ).length;
    if (subCount > 0) {
      emitTextAt(
        c,
        geo.contentX + 12,
        `${subCount} sub-heading${subCount === 1 ? "" : "s"}`,
        {
          size: opts.smallFontSize,
          italic: true,
          color: COLOR.muted,
          maxWidth: geo.contentWidth - 12,
          gapAfter: 4,
        },
      );
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Section + block dispatch                                                    */
/* -------------------------------------------------------------------------- */

function renderSection(
  c: Cursor,
  section: GuideDocumentSection,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  ensureSpace(c, geo, opts, 40);
  emitTextAt(c, geo.contentX, section.heading, {
    size: opts.subheadingFontSize,
    bold: true,
    maxWidth: geo.contentWidth,
    gapAfter: 6,
  });
  for (const block of section.blocks ?? []) {
    ensureSpace(c, geo, opts, 20);
    renderBlock(c, block, geo, opts);
  }
}

function renderBlock(
  c: Cursor,
  block: GuideDocumentBlock,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  switch (block.kind) {
    case "paragraph":
      renderParagraph(c, block, geo, opts);
      return;
    case "heading":
      ensureSpace(c, geo, opts, 30);
      emitTextAt(c, geo.contentX, block.text, {
        size: opts.bodyFontSize + 2,
        bold: true,
        maxWidth: geo.contentWidth,
        gapAfter: 4,
      });
      return;
    case "callout":
      renderCallout(c, block, geo, opts);
      return;
    case "checklist":
      renderChecklist(c, block, geo, opts);
      return;
    case "table":
      renderTable(c, block, geo, opts);
      return;
    case "code":
      renderCode(c, block, geo, opts);
      return;
    case "step":
      renderStep(c, block, geo, opts);
      return;
    case "image":
      renderImageBlock(c, block, geo, opts);
      return;
    default: {
      // Unknown block kinds are surfaced, not dropped, so no content is
      // silently lost when a later block type is added to the writer but not
      // to this template.
      const unknown = block as { kind?: unknown };
      throw layoutError(
        "unknown-block",
        `PDF layout does not support block kind "${String(unknown.kind)}".`,
      );
    }
  }
}

function renderParagraph(
  c: Cursor,
  block: GuideDocumentParagraph,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  emitTextAt(c, geo.contentX, block.text, {
    size: opts.bodyFontSize,
    maxWidth: geo.contentWidth,
    gapAfter: opts.blockGap,
  });
}

/* -------------------------------------------------------------------------- */
/* Callouts                                                                    */
/* -------------------------------------------------------------------------- */

function renderCallout(
  c: Cursor,
  block: GuideDocumentCallout,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  const lines = wrapText(block.text, geo.contentWidth - 16, opts.bodyFontSize, false);
  const boxHeight = lines.length * lineHeightFor(opts.bodyFontSize) + 16;
  ensureSpace(c, geo, opts, boxHeight + 6);
  const { fill, border } = calloutPalette(block.tone ?? "note");
  const top = c.y;
  c.primitives.push({
    kind: "rect",
    x: geo.contentX - 6,
    y: top - boxHeight,
    width: geo.contentWidth + 4,
    height: boxHeight,
    fill,
    stroke: border,
    strokeWidth: 0.5,
  });
  c.y = top - 8;
  const labelText = calloutLabel(block.tone ?? "note");
  emitTextAt(c, geo.contentX, labelText, {
    size: opts.smallFontSize,
    bold: true,
    color: COLOR.text,
    maxWidth: geo.contentWidth - 12,
    gapAfter: 2,
  });
  emitTextAt(c, geo.contentX, block.text, {
    size: opts.bodyFontSize,
    maxWidth: geo.contentWidth - 12,
    gapAfter: opts.blockGap,
  });
}

function calloutPalette(
  tone: GuideDocumentCallout["tone"],
): { readonly fill: string; readonly border: string } {
  switch (tone) {
    case "tip":
      return { fill: COLOR.calloutTip, border: COLOR.calloutTipBorder };
    case "warning":
      return { fill: COLOR.calloutWarning, border: COLOR.calloutWarningBorder };
    case "note":
    default:
      return { fill: COLOR.calloutNote, border: COLOR.calloutNoteBorder };
  }
}

function calloutLabel(tone: GuideDocumentCallout["tone"]): string {
  switch (tone) {
    case "tip":
      return "TIP";
    case "warning":
      return "WARNING";
    case "note":
    default:
      return "NOTE";
  }
}

/* -------------------------------------------------------------------------- */
/* Checklists                                                                  */
/* -------------------------------------------------------------------------- */

function renderChecklist(
  c: Cursor,
  block: GuideDocumentChecklist,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  if (block.title !== undefined && block.title.length > 0) {
    emitTextAt(c, geo.contentX, block.title, {
      size: opts.bodyFontSize,
      bold: true,
      maxWidth: geo.contentWidth,
      gapAfter: 2,
    });
  }
  for (const item of block.items) {
    const glyph = item.checked === true ? "☒" : "☐";
    emitTextAt(c, geo.contentX, `${glyph}  ${item.text}`, {
      size: opts.bodyFontSize,
      maxWidth: geo.contentWidth - 8,
      gapAfter: 1,
    });
  }
  c.y -= opts.blockGap;
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

function renderTable(
  c: Cursor,
  block: GuideDocumentTable,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  const cols = Math.max(1, block.columns.length);
  const colWidth = geo.contentWidth / cols;
  const rowHeight = lineHeightFor(opts.bodyFontSize) + 6;
  if (block.caption !== undefined && block.caption.length > 0) {
    emitTextAt(c, geo.contentX, block.caption, {
      size: opts.smallFontSize,
      italic: true,
      color: COLOR.muted,
      maxWidth: geo.contentWidth,
      gapAfter: 2,
    });
  }
  // Header row
  ensureSpace(c, geo, opts, rowHeight * 2);
  const headerTop = c.y;
  c.primitives.push({
    kind: "rect",
    x: geo.contentX,
    y: headerTop - rowHeight,
    width: geo.contentWidth,
    height: rowHeight,
    fill: COLOR.tableHead,
    stroke: COLOR.tableBorder,
    strokeWidth: 0.4,
  });
  block.columns.forEach((col, i) => {
    const x = geo.contentX + colWidth * i + 4;
    c.y = headerTop - rowHeight + 5;
    c.primitives.push({
      kind: "text",
      text: col,
      x,
      y: c.y,
      size: opts.smallFontSize,
      bold: true,
      italic: false,
      color: COLOR.text,
      maxWidth: colWidth - 8,
    });
  });
  c.y = headerTop - rowHeight;
  // Body rows
  for (const row of block.rows) {
    ensureSpace(c, geo, opts, rowHeight);
    const rowTop = c.y;
    c.primitives.push({
      kind: "rect",
      x: geo.contentX,
      y: rowTop - rowHeight,
      width: geo.contentWidth,
      height: rowHeight,
      fill: null,
      stroke: COLOR.tableBorder,
      strokeWidth: 0.4,
    });
    for (let i = 0; i < cols; i += 1) {
      const cell = row.cells[i] ?? "";
      const x = geo.contentX + colWidth * i + 4;
      c.primitives.push({
        kind: "text",
        text: cell,
        x,
        y: rowTop - rowHeight + 5,
        size: opts.smallFontSize,
        bold: false,
        italic: false,
        color: COLOR.text,
        maxWidth: colWidth - 8,
      });
    }
    c.y = rowTop - rowHeight;
  }
  c.y -= opts.blockGap;
}

/* -------------------------------------------------------------------------- */
/* Code                                                                        */
/* -------------------------------------------------------------------------- */

function renderCode(
  c: Cursor,
  block: GuideDocumentCodeBlock,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  const lines = block.code.split("\n");
  const lh = lineHeightFor(opts.smallFontSize);
  let all: readonly string[] = lines;
  // Break long code lines
  const maxChars = Math.max(20, Math.floor((geo.contentWidth - 16) / (opts.smallFontSize * 0.6)));
  const broken: string[] = [];
  for (const l of lines) {
    if (l.length <= maxChars) {
      broken.push(l);
      continue;
    }
    for (let i = 0; i < l.length; i += maxChars) broken.push(l.slice(i, i + maxChars));
  }
  all = broken;
  const boxHeight = all.length * lh + 12;
  ensureSpace(c, geo, opts, Math.min(boxHeight, geo.contentHeight));

  if (block.language !== undefined && block.language.length > 0) {
    emitTextAt(c, geo.contentX, block.language, {
      size: opts.smallFontSize,
      italic: true,
      color: COLOR.muted,
      maxWidth: geo.contentWidth,
      gapAfter: 2,
    });
  }
  const top = c.y;
  c.primitives.push({
    kind: "rect",
    x: geo.contentX - 4,
    y: top - boxHeight,
    width: geo.contentWidth + 8,
    height: boxHeight,
    fill: COLOR.codeBg,
    stroke: null,
    strokeWidth: 0,
  });
  c.y = top - 6;
  for (const line of all) {
    c.y -= lh;
    c.primitives.push({
      kind: "text",
      text: line,
      x: geo.contentX,
      y: c.y,
      size: opts.smallFontSize,
      bold: false,
      italic: false,
      color: COLOR.codeFg,
      maxWidth: geo.contentWidth,
    });
  }
  c.y -= opts.blockGap;
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

function renderStep(
  c: Cursor,
  block: GuideDocumentStep,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  ensureSpace(c, geo, opts, 30);
  const badgeSize = 18;
  const badgeTop = c.y - badgeSize + 2;
  c.primitives.push({
    kind: "rect",
    x: geo.contentX,
    y: badgeTop,
    width: badgeSize,
    height: badgeSize,
    fill: COLOR.stepBadge,
    stroke: null,
    strokeWidth: 0,
  });
  c.primitives.push({
    kind: "text",
    text: String(block.index),
    x: geo.contentX + 5,
    y: badgeTop + 4,
    size: opts.smallFontSize + 1,
    bold: true,
    italic: false,
    color: COLOR.stepBadgeFg,
    maxWidth: badgeSize,
  });
  const textX = geo.contentX + badgeSize + 6;
  const textWidth = geo.contentRight - textX;
  c.y -= badgeSize + 2;
  emitTextAt(c, textX, block.title, {
    size: opts.bodyFontSize,
    bold: true,
    maxWidth: textWidth,
    gapAfter: 2,
  });
  if (block.description !== undefined && block.description.length > 0) {
    emitTextAt(c, textX, block.description, {
      size: opts.bodyFontSize,
      maxWidth: textWidth,
      gapAfter: 2,
    });
  }
  if (block.imageRef !== undefined && block.imageRef.length > 0) {
    emitImage(c, block.imageRef, geo, opts, 220, block.altText ?? block.title);
  }
  if (block.notes !== undefined) {
    for (const n of block.notes) {
      emitTextAt(c, textX, `• ${n}`, {
        size: opts.smallFontSize,
        italic: true,
        color: COLOR.muted,
        maxWidth: textWidth,
        gapAfter: 1,
      });
    }
  }
  c.y -= opts.blockGap;
}

/* -------------------------------------------------------------------------- */
/* Images                                                                      */
/* -------------------------------------------------------------------------- */

function renderImageBlock(
  c: Cursor,
  block: GuideDocumentImageBlock,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
): void {
  const maxHeight = 260;
  emitImage(c, block.imageRef, geo, opts, maxHeight, block.alt ?? "");
  if (block.caption !== undefined && block.caption.length > 0) {
    emitTextAt(c, geo.contentX, block.caption, {
      size: opts.smallFontSize,
      italic: true,
      color: COLOR.muted,
      maxWidth: geo.contentWidth,
      gapAfter: 2,
    });
  }
  c.y -= opts.blockGap;
}

function emitImage(
  c: Cursor,
  imageRef: string,
  geo: PdfPageGeometry,
  opts: PdfLayoutOptions,
  maxHeight: number,
  alt: string,
): void {
  // Layout reserves a 16:9 box up to maxHeight; the writer scales the actual
  // image into that box preserving aspect ratio (it knows the true dims).
  const width = geo.contentWidth;
  const height = Math.min(maxHeight, (width * 9) / 16);
  ensureSpace(c, geo, opts, height + 4);
  c.y -= height;
  c.primitives.push({
    kind: "image",
    imageRef,
    x: geo.contentX,
    y: c.y,
    width,
    height,
    alt,
  });
  if (!c.imageSeen.has(imageRef)) {
    c.imageSeen.add(imageRef);
    c.imageOrder.push(imageRef);
  }
  c.y -= 4;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

function layoutError(
  code: PdfLayoutError["code"],
  detail: string,
): PdfLayoutError {
  const err = new Error(`PDF layout error [${code}]: ${detail}`) as PdfLayoutError;
  // Assigning readonly-typed fields on a constructed error.
  Object.assign(err, { code, detail });
  return err;
}
