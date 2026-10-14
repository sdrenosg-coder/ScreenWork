/**
 * Zipy AI — export: shared document shape (phase 20, batch 0).
 *
 * The `GuideDocument` is the *single* input to every export renderer (PDF,
 * HTML, Markdown, DOCX, image-pack, embed). It is deliberately declarative
 * and renderer-free: a list of typed blocks, a cover, a source list, and a
 * disclosure record. This file is authored once and reused by every export
 * batch, so a renderer that needs a new field asks for it here rather than
 * reaching into the underlying guide row.
 *
 * Consistency rules:
 *   - `id` is unique within a document and stable across renders. Renderers
 *     use it for element ids, anchor links and provenance.
 *   - A `"step"` block carries `index` (1-based), a title, a description,
 *     and an optional image; the renderer never re-numbers.
 *   - Image bytes are supplied by the caller — the export layer never reads
 *     from the object store. `bytes: null` records "no artifact"; a renderer
 *     shows a placeholder, never a fabricated image.
 *   - Provenance is carried on every image (`sourceRefs`), and on the
 *     document itself (`sources`).
 *   - `disclosure.required` records whether the platform's AI-disclosure
 *     label must appear in the output. Renderers honour it.
 *
 * The document is assembled by the export route from persisted guide rows;
 * the assembly itself is a later-batch concern. This file only defines the
 * shape every renderer consumes.
 */

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

export type GuideDocumentBlock =
  | GuideDocumentSection
  | GuideDocumentParagraph
  | GuideDocumentCallout
  | GuideDocumentChecklist
  | GuideDocumentTable
  | GuideDocumentCodeBlock
  | GuideDocumentStep
  | GuideDocumentImageBlock;

export interface GuideDocumentSection {
  readonly kind: "section";
  readonly id: string;
  readonly title: string;
}

export interface GuideDocumentParagraph {
  readonly kind: "paragraph";
  readonly id: string;
  readonly text: string;
  readonly style?: "body" | "muted";
}

export interface GuideDocumentCallout {
  readonly kind: "callout";
  readonly id: string;
  readonly kind2?: never; // reserved
  readonly severity: "tip" | "warning" | "note";
  readonly text: string;
}

export interface GuideDocumentChecklist {
  readonly kind: "checklist";
  readonly id: string;
  readonly items: readonly string[];
}

export interface GuideDocumentTable {
  readonly kind: "table";
  readonly id: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface GuideDocumentCodeBlock {
  readonly kind: "code";
  readonly id: string;
  readonly language: string;
  readonly title: string | null;
  readonly code: string;
}

export interface GuideDocumentImage {
  readonly id: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp" | string;
  /** Raw image bytes. `null` means "not supplied"; renderers show a placeholder. */
  readonly bytes: Uint8Array | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly altText: string;
  readonly caption: string | null;
  /** Provenance: source artifact ids and optional region hints. */
  readonly sourceRefs: readonly string[];
}

export interface GuideDocumentImageBlock {
  readonly kind: "image";
  readonly id: string;
  readonly image: GuideDocumentImage;
}

export interface GuideDocumentStep {
  readonly kind: "step";
  readonly id: string;
  /** 1-based step index as it appears in the guide. */
  readonly index: number;
  readonly title: string;
  readonly description: string;
  readonly image: GuideDocumentImage | null;
  /** Optional per-step tips and warnings carried from the content layer. */
  readonly tips: readonly string[];
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Cover, sources, disclosure                                                  */
/* -------------------------------------------------------------------------- */

export interface GuideDocumentCover {
  readonly title: string | null;
  readonly subtitle: string | null;
  /** Author display name; empty string means no author. */
  readonly author: string;
  /** BCP-47 locale tag; empty string means "unspecified". */
  readonly locale: string;
  /** Keywords surfaced from SEO layer; empty list means none. */
  readonly keywords: readonly string[];
  /**
   * Optional colour/font tokens from the branding phase. Renderers honour
   * what they support and ignore the rest, rather than erroring.
   */
  readonly branding: GuideDocumentBranding;
}

export interface GuideDocumentBranding {
  readonly primaryColor: { readonly r: number; readonly g: number; readonly b: number } | null;
  readonly logoDataUri: string | null;
  readonly fontFamily: string | null;
}

export type GuideSourceKind =
  | "url"
  | "text"
  | "image"
  | "pdf"
  | "docx"
  | "pptx"
  | "audio"
  | "video"
  | "other";

export interface GuideSource {
  readonly kind: GuideSourceKind;
  /** Short human label for the source (URL, filename, transcript name). */
  readonly label: string;
  /** Optional stable id so the embedding page can link back. */
  readonly ref: string | null;
}

export interface GuideDisclosure {
  /**
   * When true, the disclosure label must be rendered into the output. Set by
   * the caller from the workspace's disclosure policy; the renderers do not
   * decide this.
   */
  readonly required: boolean;
  /** Optional override label; renderers use a neutral default when null. */
  readonly label: string | null;
  /** Optional URL to the platform's AI disclosure page; may be null. */
  readonly url: string | null;
}

/* -------------------------------------------------------------------------- */
/* Document                                                                    */
/* -------------------------------------------------------------------------- */

export interface GuideDocument {
  /** Stable slug used for canonical URLs, embed codes and filenames. */
  readonly slug: string;
  readonly cover: GuideDocumentCover;
  readonly blocks: readonly GuideDocumentBlock[];
  readonly sources: readonly GuideSource[];
  readonly disclosure: GuideDisclosure;
  /** ISO timestamp of when the guide's current version was generated. */
  readonly generatedAt: string;
  /** ISO timestamp of the last edit; may equal `generatedAt`. */
  readonly updatedAt: string;
  /**
   * Optional SEO metadata that HTML/Markdown exports use. PDF and DOCX
   * renderers ignore it beyond the title.
   */
  readonly seo: GuideDocumentSeo;
}

export interface GuideDocumentSeo {
  readonly metaTitle: string | null;
  readonly metaDescription: string | null;
  readonly canonicalUrl: string | null;
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A single-line summary suitable for a subtitle in an export that has none.
 * Deterministic and side-effect free; used by tests and by callers that
 * want a compact caption without invoking a renderer.
 */
export function summariseGuideDocument(guide: GuideDocument): string {
  const stepCount = guide.blocks.filter((b) => b.kind === "step").length;
  const sectionCount = guide.blocks.filter((b) => b.kind === "section").length;
  const parts: string[] = [];
  if (stepCount > 0) parts.push(`${stepCount} step${stepCount === 1 ? "" : "s"}`);
  if (sectionCount > 0) parts.push(`${sectionCount} section${sectionCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * The set of image blocks in document order. Used by the image-pack export
 * and by callers that need to walk all screenshots without walking the
 * block tree twice.
 */
export function collectGuideImages(
  guide: GuideDocument,
): readonly { readonly blockId: string; readonly image: GuideDocumentImage }[] {
  const out: { blockId: string; image: GuideDocumentImage }[] = [];
  for (const block of guide.blocks) {
    if (block.kind === "image") {
      out.push({ blockId: block.id, image: block.image });
    } else if (block.kind === "step" && block.image !== null) {
      out.push({ blockId: block.id, image: block.image });
    }
  }
  return out;
}
