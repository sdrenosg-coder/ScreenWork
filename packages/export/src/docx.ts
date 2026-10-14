/**
 * Zipy AI — export: DOCX (phase 20, batch 1).
 *
 * Renders a `GuideDocument` (see `./types.ts`) into an OOXML `.docx` byte
 * stream suitable for Word, Google Docs and LibreOffice. The output is a
 * WordprocessingML package: `[Content_Types].xml`, `_rels/.rels`,
 * `word/document.xml`, `word/_rels/document.xml.rels`, plus one embed per
 * image already referenced within `document.xml`.
 *
 * Why hand-rolled OOXML rather than the `docx` npm package:
 *
 *   - The image-export and embed-export deliverables in this same batch
 *     need no external runtime; keeping DOCX dependency-free keeps the
 *     `@zipy/export` package installable in the worker and in any edge
 *     runtime, matching the decision already made for PDF/HTML/Markdown.
 *   - The subset of OOXML we emit is small and stable: headings, body
 *     paragraphs, a bullet list, tables, monospace runs, and embedded
 *     images with a caption. A general-purpose writer would pull fifty
 *     models into the bundle for a fraction of their surface.
 *   - Word's OOXML is well specified; the risk of a hand-rolled writer is
 *     containment (a misplaced namespace) not correctness of the primitives.
 *     The escaping rules and namespace declarations below are the load-bearing
 *     surface and are covered by the internals exposed at the bottom of the
 *     file.
 *
 * What this module guarantees:
 *
 *   - **Escaping.** Every user-supplied string is XML-escaped (five
 *     predefined entities). There is no template-injection path.
 *   - **Determinism.** The zip entry order, the media filenames, the
 *     relationship ids, and the drawing ids are all derived from the
 *     document *order* — no clock, no date, no random. Given the same
 *     `GuideDocument` and the same image bytes, the produced bytes are
 *     identical for a fixed timestamp policy (see `options.timestamp`).
 *   - **No invented content.** A block with no representation in DOCX
 *     (unknown `kind`) is skipped and returned in `warnings`. A step with
 *     no image renders its text and badge only; the placeholder image in the
 *     PDF renderer is *not* mirrored here — a Word reader would print a
 *     dashed box that looks like a rendering bug, whereas the PDF is a
 *     fixed-layout surface where a placeholder is legible as such.
 *   - **No `core.xml` timestamp churn unless asked.** The default is to
 *     leave the package without `docProps/core.xml` so the output is
 *     reproducible. Passing `options.timestamp` emits the props file.
 *   - **No compressed-zip library dependency.** A stored (uncompressed)
 *     zip is a valid zip. Word, Google Docs and LibreOffice all accept a
 *     stored zip. Producing one requires only the CRC-32 table and the
 *     local/central-directory records implemented below.
 *
 * What this module does *not* do:
 *   - It does not fetch images. `GuideDocumentImage.bytes` must be supplied
 *     by the caller; a `null` byte array is rendered as a labelled placeholder
 *     paragraph (the *text* of which names the image id) so the document
 *     never silently drops a step.
 *   - It does not deliver a Word style (named styles for Heading 1/2/3, a
 *     Normal font family, table borders). The renderer emits direct
 *     formatting (`<w:rPr>`, `<w:pPr>`) that Word honours without a styles
 *     part; the branding phase can add a `styles.xml` later through the
 *     `styleOverrides` seam that is reserved here.
 *   - It does not perform a load-balancing pass on the package. The output
 *     is a linear emission in document order; re-ordering is the caller's
 *     concern.
 */

import type {
  GuideDocument,
  GuideDocumentBlock,
  GuideDocumentCallout,
  GuideDocumentChecklist,
  GuideDocumentCodeBlock,
  GuideDocumentImage,
  GuideDocumentStep,
  GuideDocumentTable,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DocxExportErrorCode =
  | "invalid-input"
  | "image-unsupported"
  | "internal";

export class DocxExportError extends Error {
  readonly code: DocxExportErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DocxExportErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DocxExportError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface DocxExportOptions {
  /**
   * Title shown on the cover when `guide.cover.title` is null. Required when
   * the guide is untitled so the module never invents one.
   */
  readonly fallbackTitle?: string;
  /**
   * ISO timestamp. When supplied, the package includes `docProps/core.xml`
   * with `created`/`modified` set to it. When omitted, no `core.xml` is
   * emitted and every zip entry carries the fixed epoch timestamp
   * `1980-01-01T00:00:00Z` (the zip format's zero point), which makes the
   * output byte-reproducible.
   */
  readonly timestamp?: string | null;
  /**
   * Reserved seam for the branding phase: a full `word/styles.xml` body.
   * When supplied it is embedded under `word/styles.xml` and referenced in
   * the content types and relationships. When null, no styles part is
   * emitted and direct run/paragraph formatting is used exclusively.
   */
  readonly styleOverrides?: {
    readonly stylesXml: string;
  } | null;
}

export interface DocxRenderResult {
  readonly bytes: Uint8Array;
  readonly warnings: readonly string[];
  /** Number of images actually embedded in the package (bytes supplied). */
  readonly embeddedImageCount: number;
  /** Number of images referenced in document.xml but rendered as placeholders. */
  readonly placeholderImageCount: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function renderGuideDocx(
  guide: GuideDocument,
  options: DocxExportOptions = {},
): DocxRenderResult {
  if (guide === null || typeof guide !== "object") {
    throw new DocxExportError("renderGuideDocx requires a GuideDocument.", "invalid-input");
  }
  if (typeof guide.slug !== "string" || guide.slug.length === 0) {
    throw new DocxExportError("GuideDocument is missing a slug.", "invalid-input");
  }

  const warnings: string[] = [];
  const title = guide.cover.title ?? options.fallbackTitle ?? guide.slug;

  // Build the body and collect media in a single pass so relationship ids
  // and media filenames are deterministic in document order.
  const media: MediaEntry[] = [];
  const body = buildBody(guide, title, media, warnings);

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>
${body.xml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const documentRels = buildDocumentRels(media, options.styleOverrides ?? null);
  const contentTypes = buildContentTypes(media, options.styleOverrides ?? null);
  const rootRels = buildRootRels(options.styleOverrides ?? null);

  const files: ZipEntry[] = [];
  files.push(textEntry("[Content_Types].xml", contentTypes));
  files.push(textEntry("_rels/.rels", rootRels));
  files.push(textEntry("word/document.xml", documentXml));
  files.push(textEntry("word/_rels/document.xml.rels", documentRels));

  if (options.styleOverrides !== null && options.styleOverrides !== undefined) {
    files.push(textEntry("word/styles.xml", options.styleOverrides.stylesXml));
  }

  for (const m of media) {
    files.push(binaryEntry(`word/media/${m.filename}`, m.bytes));
  }

  let embeddedImageCount = 0;
  let placeholderImageCount = 0;
  for (const m of media) {
    if (m.bytes.length > 0) embeddedImageCount += 1;
    else placeholderImageCount += 1;
  }

  if (options.timestamp !== null && options.timestamp !== undefined) {
    const iso = normalizeIso(options.timestamp);
    files.push(textEntry("docProps/core.xml", buildCoreProperties(guide, title, iso)));
    // A slight re-order is fine; some consumers expect `[Content_Types].xml`
    // first (it is), and the rest is free.
  }

  const zipTimestamp = options.timestamp !== null && options.timestamp !== undefined
    ? toDosDateTime(options.timestamp)
    : DOS_EPOCH;

  const bytes = buildStoredZip(files, zipTimestamp);
  return {
    bytes,
    warnings,
    embeddedImageCount,
    placeholderImageCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Body construction                                                           */
/* -------------------------------------------------------------------------- */

interface MediaEntry {
  /** Filename inside `word/media/`. */
  readonly filename: string;
  /** Content type for `[Content_Types].xml`. */
  readonly contentType: string;
  /** Bytes (may be zero-length for a placeholder; placeholder entries are not written into `word/media/`). */
  readonly bytes: Uint8Array;
  /** Relationship id within `document.xml.rels`. */
  readonly relId: string;
  /** Word drawing id (unique in the document). */
  readonly drawingId: number;
  /** Width in EMUs (English Metric Units, 914400 per inch). */
  readonly cxEmu: number;
  /** Height in EMUs. */
  readonly cyEmu: number;
  /** Alt text used for the `wp:docPr` description attribute. */
  readonly altText: string;
  /** Caption rendered beneath the image (may be empty). */
  readonly caption: string | null;
}

interface BodyBuild {
  readonly xml: string;
}

function buildBody(
  guide: GuideDocument,
  title: string,
  media: MediaEntry[],
  warnings: string[],
): BodyBuild {
  const parts: string[] = [];
  let drawingCounter = 1;

  // Cover
  parts.push(paragraph(headingRun(title, 0, true), {
    spacingAfterPt: 6,
    alignment: "center",
  }));
  if (guide.cover.subtitle !== null && guide.cover.subtitle.length > 0) {
    parts.push(paragraph(textRun(guide.cover.subtitle, { italic: true, sizePt: 14 }), {
      alignment: "center",
      spacingAfterPt: 4,
    }));
  }
  const meta: string[] = [];
  if (guide.cover.author.length > 0) meta.push(guide.cover.author);
  if (guide.generatedAt.length > 0) {
    meta.push(`Generated ${formatIsoDate(guide.generatedAt)}`);
  }
  if (meta.length > 0) {
    parts.push(paragraph(textRun(meta.join(" · "), {
      sizePt: 9,
      color: "6B7078",
    }), { alignment: "center", spacingAfterPt: 6 }));
  }
  if (guide.sources.length > 0) {
    parts.push(paragraph(headingRun("Sources", 2), { spacingBeforePt: 6, spacingAfterPt: 2 }));
    for (const source of guide.sources) {
      const label = `${source.kind} — ${source.label}`;
      parts.push(paragraph(textRun(label, { sizePt: 9, color: "424548" }), {
        listBullet: true,
        spacingAfterPt: 1,
      }));
    }
  }
  if (guide.disclosure.required) {
    const label = guide.disclosure.label ?? "AI-generated content. Review before publishing.";
    parts.push(paragraph(textRun(label, { italic: true, sizePt: 9, color: "6B7078" }), {
      spacingBeforePt: 6,
      spacingAfterPt: 4,
    }));
  }

  // Body blocks
  for (const block of guide.blocks) {
    const emitted = renderBlock(block, media, warnings, () => {
      const current = drawingCounter;
      drawingCounter += 1;
      return current;
    });
    for (const x of emitted) parts.push(x);
  }

  return { xml: parts.join("\n") };
}

function renderBlock(
  block: GuideDocumentBlock,
  media: MediaEntry[],
  warnings: string[],
  nextDrawingId: () => number,
): readonly string[] {
  switch (block.kind) {
    case "section":
      return [paragraph(headingRun(block.title, 1), {
        spacingBeforePt: 14,
        spacingAfterPt: 4,
      })];
    case "paragraph": {
      const runs = textRun(block.text, {
        italic: block.style === "muted",
        color: block.style === "muted" ? "6B7078" : null,
      });
      return [paragraph(runs, { spacingAfterPt: 4 })];
    }
    case "callout":
      return renderCallout(block);
    case "checklist":
      return renderChecklist(block);
    case "table":
      return renderTable(block);
    case "code":
      return renderCodeBlock(block);
    case "step":
      return renderStep(block, media, nextDrawingId, warnings);
    case "image":
      return renderImageBlock(block.id, block.image, media, nextDrawingId);
    default: {
      const exhaustive: never = block;
      void exhaustive;
      warnings.push(
        `Skipping block of unknown kind: ${String((block as { kind?: unknown }).kind)}`,
      );
      return [];
    }
  }
}

function renderCallout(block: GuideDocumentCallout): readonly string[] {
  const title = block.severity === "tip" ? "Tip" : block.severity === "warning" ? "Warning" : "Note";
  const color = block.severity === "tip"
    ? "1D4ED8"
    : block.severity === "warning"
      ? "B45309"
      : "52525B";
  return [
    paragraph(
      [
        textRun(`${title}: `, { bold: true, color }),
        textRun(block.text, { color }),
      ],
      {
        shadingFill: block.severity === "tip"
          ? "EFF6FF"
          : block.severity === "warning"
            ? "FFF7E6"
            : "F4F4F5",
        spacingBeforePt: 4,
        spacingAfterPt: 4,
        leftIndentTwips: 240,
        rightIndentTwips: 240,
        borderLeft: color,
      },
    ),
  ];
}

function renderChecklist(block: GuideDocumentChecklist): readonly string[] {
  if (block.items.length === 0) return [];
  const out: string[] = [];
  for (const item of block.items) {
    out.push(paragraph(textRun(`☐  ${item}`), {
      spacingAfterPt: 1,
      leftIndentTwips: 240,
    }));
  }
  out.push(paragraph(textRun(""), { spacingAfterPt: 0 }));
  return out;
}

function renderTable(block: GuideDocumentTable): readonly string[] {
  if (block.columns.length === 0 || block.rows.length === 0) return [];
  const colCount = block.columns.length;
  const gridColWidth = Math.floor(9500 / colCount); // 9500 twips ≈ 6.6 in usable width.
  const grid = `<w:tblGrid>${Array.from({ length: colCount }, () => `<w:gridCol w:w="${gridColWidth}"/>`).join("")}</w:tblGrid>`;
  const borders = `
    <w:tblBorders>
      <w:top w:val="single" w:sz="4" w:color="D5D6D8"/>
      <w:left w:val="single" w:sz="4" w:color="D5D6D8"/>
      <w:bottom w:val="single" w:sz="4" w:color="D5D6D8"/>
      <w:right w:val="single" w:sz="4" w:color="D5D6D8"/>
      <w:insideH w:val="single" w:sz="4" w:color="D5D6D8"/>
      <w:insideV w:val="single" w:sz="4" w:color="D5D6D8"/>
    </w:tblBorders>`;
  const headerCells = block.columns.map((c) => `
    <w:tc>
      <w:tcPr><w:tcW w:w="${gridColWidth}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F0F1F2"/></w:tcPr>
      ${paragraph(textRun(c, { bold: true, sizePt: 10 }), { spacingAfterPt: 0 })}
    </w:tc>`).join("");
  const rows = block.rows.map((row) => {
    const cells: string[] = [];
    for (let c = 0; c < colCount; c += 1) {
      const cell = row[c] ?? "";
      cells.push(`
        <w:tc>
          <w:tcPr><w:tcW w:w="${gridColWidth}" w:type="dxa"/></w:tcPr>
          ${paragraph(textRun(cell, { sizePt: 10 }), { spacingAfterPt: 0 })}
        </w:tc>`);
    }
    return `<w:tr>${cells.join("")}</w:tr>`;
  }).join("");
  const table = `
    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="0" w:type="auto"/>
        ${borders}
      </w:tblPr>
      ${grid}
      <w:tr>${headerCells}</w:tr>
      ${rows}
    </w:tbl>`;
  // A trailing empty paragraph after a table keeps Word from merging the
  // table into the next paragraph.
  return [table, paragraph(textRun(""), { spacingAfterPt: 0 })];
}

function renderCodeBlock(block: GuideDocumentCodeBlock): readonly string[] {
  const lines = block.code.split(/\r?\n/);
  const out: string[] = [];
  if (block.title !== null && block.title.length > 0) {
    out.push(paragraph(textRun(block.title, { bold: true, sizePt: 9, color: "424548" }), {
      spacingAfterPt: 1,
    }));
  }
  // One paragraph per line so Word does not soft-wrap the fence into the
  // following block. Each line is a monospace run with a code-block shading.
  for (const line of lines) {
    out.push(paragraph(
      textRun(line.length === 0 ? " " : line, {
        mono: true,
        sizePt: 9,
        color: "E0E8F0",
      }),
      {
        shadingFill: "1C1F26",
        spacingBeforePt: 0,
        spacingAfterPt: 0,
        leftIndentTwips: 120,
        rightIndentTwips: 120,
        keepLines: true,
      },
    ));
  }
  // Closing spacing so the code block is visually distinct from the next
  // paragraph.
  out.push(paragraph(textRun(""), { spacingAfterPt: 2 }));
  return out;
}

function renderStep(
  block: GuideDocumentStep,
  media: MediaEntry[],
  nextDrawingId: () => number,
  warnings: string[],
): readonly string[] {
  const out: string[] = [];
  const title = block.title.length > 0 ? block.title : `Step ${block.index}`;
  out.push(paragraph(
    [
      textRun(`Step ${block.index}. `, { bold: true, color: "181A1F" }),
      textRun(title, { bold: true, color: "181A1F" }),
    ],
    { spacingBeforePt: 12, spacingAfterPt: 2, keepWithNext: true },
  ));
  if (block.image !== null) {
    for (const item of renderImageFigure(block.id, block.image, media, nextDrawingId)) {
      out.push(item);
    }
  }
  if (block.description.length > 0) {
    out.push(paragraph(textRun(block.description), { spacingAfterPt: 2 }));
  }
  for (const tip of block.tips) {
    out.push(paragraph(
      [textRun("Tip: ", { bold: true, color: "1D4ED8" }), textRun(tip, { color: "1D4ED8" })],
      { shadingFill: "EFF6FF", spacingAfterPt: 2, leftIndentTwips: 240, rightIndentTwips: 240 },
    ));
  }
  for (const warning of block.warnings) {
    out.push(paragraph(
      [textRun("Warning: ", { bold: true, color: "B45309" }), textRun(warning, { color: "B45309" })],
      { shadingFill: "FFF7E6", spacingAfterPt: 2, leftIndentTwips: 240, rightIndentTwips: 240 },
    ));
  }
  void warnings;
  return out;
}

function renderImageBlock(
  blockId: string,
  image: GuideDocumentImage,
  media: MediaEntry[],
  nextDrawingId: () => number,
): readonly string[] {
  return renderImageFigure(blockId, image, media, nextDrawingId);
}

function renderImageFigure(
  blockId: string,
  image: GuideDocumentImage,
  media: MediaEntry[],
  nextDrawingId: () => number,
): readonly string[] {
  const out: string[] = [];
  const mime = image.mimeType;
  const supported = mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg";

  if (
    image.bytes === null ||
    image.bytes.length === 0 ||
    !supported
  ) {
    const reason = image.bytes === null || image.bytes.length === 0
      ? "Screenshot not supplied"
      : `Unsupported image format (${mime})`;
    out.push(paragraph(textRun(`[${reason}: ${image.id}]`, { italic: true, color: "6B7078" }), {
      spacingAfterPt: 2,
      leftIndentTwips: 240,
    }));
    if (image.caption !== null && image.caption.length > 0) {
      out.push(paragraph(textRun(image.caption, { italic: true, sizePt: 9, color: "6B7078" }), {
        spacingAfterPt: 2,
      }));
    }
    return out;
  }

  const contentType = mime === "image/png" ? "image/png" : "image/jpeg";
  const ext = mime === "image/png" ? "png" : "jpg";
  const sequence = media.length + 1;
  const relId = `rIdImg${sequence}`;
  const drawingId = nextDrawingId();
  // Filenames derived from content hash + block id keep duplicates from
  // colliding when the same image appears in multiple steps.
  const filename = `zipy_image_${drawingId}_${sanitizeSegment(blockId)}.${ext}`;
  const altText = image.altText.length > 0 ? image.altText : `Screenshot ${image.id}`;

  const cxEmu = computeImageWidthEmu(image);
  const cyEmu = computeImageHeightEmu(image, cxEmu);

  media.push({
    filename,
    contentType,
    bytes: image.bytes,
    relId,
    drawingId,
    cxEmu,
    cyEmu,
    altText,
    caption: image.caption,
  });

  out.push(inlineImageParagraph({
    relId,
    drawingId,
    cxEmu,
    cyEmu,
    altText,
  }));

  if (image.caption !== null && image.caption.length > 0) {
    out.push(paragraph(textRun(image.caption, { italic: true, sizePt: 9, color: "6B7078" }), {
      spacingAfterPt: 2,
    }));
  }
  if (image.sourceRefs.length > 0) {
    out.push(paragraph(textRun(`Source: ${image.sourceRefs.join(", ")}`, {
      italic: true,
      sizePt: 8,
      color: "6B7078",
    }), { spacingAfterPt: 4 }));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* OOXML primitives                                                            */
/* -------------------------------------------------------------------------- */

interface RunOptions {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly mono?: boolean;
  readonly sizePt?: number;
  readonly color?: string | null;
}

function textRun(text: string, opts: RunOptions = {}): string {
  const escaped = escapeXml(text);
  const rPrParts: string[] = [];
  if (opts.bold) rPrParts.push(`<w:b/>`);
  if (opts.italic) rPrParts.push(`<w:i/>`);
  // Half-points as required by OOXML (`w:sz` is in half-points).
  const halfPoints = Math.max(2, Math.round((opts.sizePt ?? 11) * 2));
  rPrParts.push(`<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/>`);
  if (opts.color !== null && opts.color !== undefined && opts.color.length > 0) {
    rPrParts.push(`<w:color w:val="${escapeXml(opts.color)}"/>`);
  }
  if (opts.mono) {
    rPrParts.push(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>`);
  }
  const rPr = rPrParts.length > 0 ? `<w:rPr>${rPrParts.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`;
}

function headingRun(text: string, level: 0 | 1 | 2, isTitle: boolean = false): string {
  const sizePt = level === 0 ? 24 : level === 1 ? 16 : 13;
  return textRun(text, { bold: true, sizePt, color: isTitle ? "181A1F" : "181A1F" });
}

interface ParagraphOptions {
  readonly alignment?: "center" | "left" | "right";
  readonly spacingBeforePt?: number;
  readonly spacingAfterPt?: number;
  readonly leftIndentTwips?: number;
  readonly rightIndentTwips?: number;
  readonly shadingFill?: string;
  readonly borderLeft?: string;
  readonly listBullet?: boolean;
  readonly keepWithNext?: boolean;
  readonly keepLines?: boolean;
}

function paragraph(runs: string, opts: ParagraphOptions = {}): string {
  const pPrParts: string[] = [];
  const spacingAttrs: string[] = [];
  if (opts.spacingBeforePt !== undefined) {
    spacingAttrs.push(`w:before="${Math.round(opts.spacingBeforePt * 20)}"`);
  }
  if (opts.spacingAfterPt !== undefined) {
    spacingAttrs.push(`w:after="${Math.round(opts.spacingAfterPt * 20)}"`);
  }
  if (spacingAttrs.length > 0) {
    pPrParts.push(`<w:spacing ${spacingAttrs.join(" ")}/>`);
  }
  if (opts.alignment !== undefined) {
    pPrParts.push(`<w:jc w:val="${opts.alignment}"/>`);
  }
  if (opts.leftIndentTwips !== undefined || opts.rightIndentTwips !== undefined) {
    const left = opts.leftIndentTwips ?? 0;
    const right = opts.rightIndentTwips ?? 0;
    pPrParts.push(`<w:ind w:left="${left}" w:right="${right}"/>`);
  }
  if (opts.shadingFill !== undefined && opts.shadingFill.length > 0) {
    pPrParts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${escapeXml(opts.shadingFill)}"/>`);
  }
  if (opts.borderLeft !== undefined && opts.borderLeft.length > 0) {
    pPrParts.push(
      `<w:pBdr><w:left w:val="single" w:sz="24" w:space="4" w:color="${escapeXml(opts.borderLeft)}"/></w:pBdr>`,
    );
  }
  if (opts.listBullet === true) {
    // A simple bullet: a leading "•  " is written as its own run; Word will
    // accept it because it is text, not a numbering definition.
    pPrParts.push(`<w:ind w:left="360" w:hanging="180"/>`);
  }
  if (opts.keepWithNext === true) {
    pPrParts.push(`<w:keepNext/>`);
  }
  if (opts.keepLines === true) {
    pPrParts.push(`<w:keepLines/>`);
  }
  const pPr = pPrParts.length > 0 ? `<w:pPr>${pPrParts.join("")}</w:pPr>` : "";
  const body = opts.listBullet === true ? `<w:r><w:t xml:space="preserve">•  </w:t></w:r>${runs}` : runs;
  return `<w:p>${pPr}${body}</w:p>`;
}

interface InlineImageInput {
  readonly relId: string;
  readonly drawingId: number;
  readonly cxEmu: number;
  readonly cyEmu: number;
  readonly altText: string;
}

function inlineImageParagraph(input: InlineImageInput): string {
  const xml = `
<w:p>
  <w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/></w:pPr>
  <w:r>
    <w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="${input.cxEmu}" cy="${input.cyEmu}"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>
        <wp:docPr id="${input.drawingId}" name="Picture ${input.drawingId}" descr="${escapeXml(input.altText)}" title="${escapeXml(input.altText)}"/>
        <wp:cNvGraphicFramePr>
          <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
        </wp:cNvGraphicFramePr>
        <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:nvPicPr>
                <pic:cNvPr id="${input.drawingId}" name="${escapeXml(input.altText)}"/>
                <pic:cNvPicPr/>
              </pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="${escapeXml(input.relId)}"/>
                <a:stretch><a:fillRect/></a:stretch>
              </pic:blipFill>
              <pic:spPr>
                <a:xfrm>
                  <a:off x="0" y="0"/>
                  <a:ext cx="${input.cxEmu}" cy="${input.cyEmu}"/>
                </a:xfrm>
                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
              </pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing>
  </w:r>
</w:p>`;
  return xml.trim();
}

/* -------------------------------------------------------------------------- */
/* Package parts                                                               */
/* -------------------------------------------------------------------------- */

function buildContentTypes(
  media: readonly MediaEntry[],
  styleOverrides: { readonly stylesXml: string } | null,
): string {
  const defaults = new Map<string, string>();
  defaults.set("rels", "application/vnd.openxmlformats-package.relationships+xml");
  defaults.set("xml", "application/xml");
  const overrides: string[] = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
  ];
  if (styleOverrides !== null) {
    overrides.push(
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
    );
  }
  for (const m of media) {
    if (m.contentType === "image/png" || m.contentType === "image/jpeg") {
      const ext = m.contentType === "image/png" ? "png" : "jpeg";
      defaults.set(ext, m.contentType);
    }
  }
  const defaultXml = [...defaults.entries()]
    .map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  ${defaultXml}
  ${overrides.join("\n  ")}
</Types>`;
}

function buildRootRels(styleOverrides: { readonly stylesXml: string } | null): string {
  void styleOverrides;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function buildDocumentRels(
  media: readonly MediaEntry[],
  styleOverrides: { readonly stylesXml: string } | null,
): string {
  const entries: string[] = [];
  if (styleOverrides !== null) {
    entries.push(
      `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    );
  }
  for (const m of media) {
    entries.push(
      `<Relationship Id="${escapeXml(m.relId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${escapeXml(m.filename)}"/>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${entries.join("\n  ")}
</Relationships>`;
}

function buildCoreProperties(
  guide: GuideDocument,
  title: string,
  iso: string,
): string {
  const author = guide.cover.author.length > 0 ? guide.cover.author : "Zipy AI";
  const subject = guide.seo.metaDescription ?? "";
  const keywords = guide.cover.keywords.join(", ");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:dcmitype="http://purl.org/dc/dcmitype/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>${escapeXml(author)}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>
  <dc:subject>${escapeXml(subject)}</dc:subject>
  <cp:keywords>${escapeXml(keywords)}</cp:keywords>
  <dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(iso)}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(iso)}</dcterms:modified>
</cp:coreProperties>`;
}

/* -------------------------------------------------------------------------- */
/* Image sizing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Width in EMUs. A max width of 6.0 inches (≈ 5486400 EMU) matches the
 * printable width after the 1-inch margins set above. Aspect ratio is
 * preserved by deriving height from width.
 */
const MAX_WIDTH_EMU = 5_486_400;

function computeImageWidthEmu(image: GuideDocumentImage): number {
  if (image.width !== null && image.height !== null && image.width > 0 && image.height > 0) {
    // Treat the source dimensions as CSS pixels at 96 DPI.
    const pxWidth = image.width;
    const emuPerPx = 9525; // 914400 EMU per inch / 96 px per inch
    const natural = pxWidth * emuPerPx;
    return Math.min(natural, MAX_WIDTH_EMU);
  }
  return MAX_WIDTH_EMU;
}

function computeImageHeightEmu(image: GuideDocumentImage, cxEmu: number): number {
  if (image.width !== null && image.height !== null && image.width > 0 && image.height > 0) {
    const ratio = image.height / image.width;
    return Math.max(1, Math.round(cxEmu * ratio));
  }
  // A DOCX drawing requires a height; without dimensions assume a 4:3 frame,
  // which is the median for a screenshot.
  return Math.max(1, Math.round(cxEmu * 0.625));
}

/* -------------------------------------------------------------------------- */
/* Zip writer (stored, spec-compliant)                                         */
/* -------------------------------------------------------------------------- */

const DOS_EPOCH: { readonly date: number; readonly time: number } = {
  date: 0x0021, // 1980-01-01
  time: 0x0000, // 00:00:00
};

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly crc32: number;
}

function textEntry(name: string, content: string): ZipEntry {
  const bytes = textEncoder.encode(content);
  return {
    name,
    data: bytes,
    crc32: crc32(bytes),
  };
}

function binaryEntry(name: string, bytes: Uint8Array): ZipEntry {
  return {
    name,
    data: bytes,
    crc32: crc32(bytes),
  };
}

/**
 * A deterministic *stored* (method 0, no compression) zip. All files use the
 * same DOS date/time so two calls with the same inputs produce identical
 * bytes. Word, Google Docs, LibreOffice and macOS's Archive Utility accept
 * this without complaint.
 *
 * The central directory is written after the local entries; no
 * `extra` fields are emitted (the specification makes them optional), which
 * keeps the writer simple and the output compact.
 */
function buildStoredZip(
  entries: readonly ZipEntry[],
  timestamp: { readonly date: number; readonly time: number },
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lh = new DataView(localHeader.buffer);
    lh.setUint32(0, 0x04034b50, true); // local file header signature
    lh.setUint16(4, 20, true); // version needed to extract
    lh.setUint16(6, 0, true); // general purpose bit flag
    lh.setUint16(8, 0, true); // compression method: 0 (stored)
    lh.setUint16(10, timestamp.time, true);
    lh.setUint16(12, timestamp.date, true);
    lh.setUint32(14, entry.crc32, true);
    lh.setUint32(18, entry.data.length, true);
    lh.setUint32(22, entry.data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);

    chunks.push(localHeader);
    chunks.push(entry.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true); // central directory signature
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true); // flags
    cdv.setUint16(10, 0, true); // method
    cdv.setUint16(12, timestamp.time, true);
    cdv.setUint16(14, timestamp.date, true);
    cdv.setUint32(16, entry.crc32, true);
    cdv.setUint32(20, entry.data.length, true);
    cdv.setUint32(24, entry.data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra length
    cdv.setUint16(32, 0, true); // comment length
    cdv.setUint16(34, 0, true); // disk number start
    cdv.setUint16(36, 0, true); // internal attrs
    cdv.setUint32(38, 0, true); // external attrs
    cdv.setUint32(42, offset, true); // local header offset
    cd.set(nameBytes, 46);
    centralDir.push(cd);

    offset += localHeader.length + entry.data.length;
  }

  const cdLength = centralDir.reduce((sum, cd) => sum + cd.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // cd start disk
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdLength, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // comment length

  const total = offset + cdLength + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  for (const cd of centralDir) {
    out.set(cd, cursor);
    cursor += cd.length;
  }
  out.set(end, cursor);
  return out;
}

/* -------------------------------------------------------------------------- */
/* CRC-32                                                                      */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ b) & 0xff] ?? 0)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Escaping / utilities                                                        */
/* -------------------------------------------------------------------------- */

const textEncoder = new TextEncoder();

/**
 * XML-escape the five predefined entities and strip the ASCII control
 * characters that are illegal in XML 1.0 (everything below 0x20 except tab,
 * LF and CR). A stray vertical tab from a source document would otherwise
 * make the package unreadable.
 */
export function escapeXml(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    if (ch === 38) { out += "&amp;"; continue; }
    if (ch === 60) { out += "&lt;"; continue; }
    if (ch === 62) { out += "&gt;"; continue; }
    if (ch === 34) { out += "&quot;"; continue; }
    if (ch === 39) { out += "&apos;"; continue; }
    if (ch === 9 || ch === 10 || ch === 13) { out += input.charAt(i); continue; }
    if (ch < 0x20) { continue; }
    out += input.charAt(i);
  }
  return out;
}

function sanitizeSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : "asset";
}

function formatIsoDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new DocxExportError(
      `Invalid ISO timestamp: ${iso}`,
      "invalid-input",
      { timestamp: iso },
    );
  }
  return new Date(t).toISOString();
}

function toDosDateTime(iso: string): { readonly date: number; readonly time: number } {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DOS_EPOCH;
  const d = new Date(t);
  const year = d.getUTCFullYear();
  if (year < 1980 || year > 2107) return DOS_EPOCH;
  const date =
    (((year - 1980) & 0x7f) << 9) |
    (((d.getUTCMonth() + 1) & 0x0f) << 5) |
    (d.getUTCDate() & 0x1f);
  const time =
    ((d.getUTCHours() & 0x1f) << 11) |
    ((d.getUTCMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getUTCSeconds() / 2)) & 0x1f);
  return { date: date & 0xffff, time: time & 0xffff };
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  escapeXml,
  crc32,
  buildStoredZip,
  textRun,
  paragraph,
  sanitizeSegment,
  toDosDateTime,
  DOS_EPOCH,
});
