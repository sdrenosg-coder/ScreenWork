/**
 * Zipy AI — export package barrel (phase 20).
 *
 * Stable entry-points for every consumer (the export route, the worker's
 * batch jobs, the SDKs). Only the renderers implemented in phases already
 * landed are re-exported here; batch 1 (DOCX, image pack, embed) and batch
 * 2 (PDF layout template, export route, publishing page) add their own
 * exports when they land, without changing the existing names.
 *
 * Names are re-exported rather than namespaced so a caller writes
 * `import { renderGuidePdf } from "@zipy/export"` and discovers the
 * available renderers from one file.
 */

export type {
  GuideDocument,
  GuideDocumentBlock,
  GuideDocumentSection,
  GuideDocumentParagraph,
  GuideDocumentCallout,
  GuideDocumentChecklist,
  GuideDocumentTable,
  GuideDocumentCodeBlock,
  GuideDocumentStep,
  GuideDocumentImage,
  GuideDocumentImageBlock,
  GuideDocumentCover,
  GuideDocumentBranding,
  GuideDocumentSeo,
  GuideSource,
  GuideSourceKind,
  GuideDisclosure,
} from "./types";
export { summariseGuideDocument, collectGuideImages } from "./types";

export type {
  PdfExportOptions,
  PdfRenderResult,
  PdfPageManifestEntry,
  PdfExportErrorCode,
} from "./pdf";
export { renderGuidePdf, PdfExportError, provenanceSubject } from "./pdf";

export type {
  HtmlExportOptions,
  HtmlRenderResult,
  HtmlExportErrorCode,
} from "./html";
export { renderGuideHtml, HtmlExportError } from "./html";

export type {
  MarkdownExportOptions,
  MarkdownBundleFile,
  MarkdownRenderResult,
  MarkdownExportErrorCode,
} from "./markdown";
export {
  renderGuideMarkdown,
  collectImageBundlePaths,
  MarkdownExportError,
} from "./markdown";
