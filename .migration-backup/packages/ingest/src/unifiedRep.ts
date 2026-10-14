/**
 * Zipy AI — Unified intermediate representation (UIR).
 *
 * One canonical, JSON-serializable shape that every ingestion module's output
 * is projected onto, so the cross-source fusion phase (`@zipy/fusion/*`) and
 * every downstream consumer reason about a single item schema rather than
 * seven source-specific result types.
 *
 * What this module is:
 *   - A type surface (`CanonicalItem`, `UnifiedRepresentation`) that carries
 *     content, annotations, provenance, and links to source artifacts.
 *   - Pure adapter functions that project each existing ingest result
 *     (`UrlIngestResult`, `TextPromptIngestResult`, `ImageIngestResult`,
 *     `PdfIngestResult`, `DocxIngestResult`, `PptxIngestResult`,
 *     `AudioIngestResult`, and the video ingest result) onto that surface.
 *   - A `fuseSources` entry point that takes N per-source projections plus a
 *     priority configuration and returns one `UnifiedRepresentation`.
 *
 * What this module is *not*:
 *   - It does not embed text, hash content, call a database, or touch the
 *     network. Projection is a mechanical mapping over already-produced data.
 *   - It does not invent items. If a source result has zero extractable
 *     items (e.g. an empty PDF page), the projection produces zero items, and
 *     `fuseSources` records a `sourceGaps` entry rather than a placeholder.
 *   - It does not decide modality weights; that is `@zipy/fusion/trustScore`
 *     and `@zipy/fusion/crossModalAttention`. Here we only honour the explicit
 *     source *priority* list (URL > PDF > image, etc.) when two sources
 *     duplicate the same item.
 *
 * Provenance model:
 *   Every `CanonicalItem` carries a `Provenance` record with an opaque
 *   `sourceRef` (the caller’s own identifier, typically an artifact id), a
 *   `locator` naming the position within the source (page, block index, frame
 *   timestamp, a11y ref, cell coordinates), and an optional `region` with a
 *   pixel bounding box. Downstream code can always answer "where did this
 *   come from?".
 *
 * The items are intentionally *not* merged across sources here. Fusion
 * (deduplication, cross-modal attention, conflict detection) is the next
 * phase; this module fuses the *container* (one UIR with N source headers and
 * the union of items tagged by source) so the fusion layer has a single input.
 */

import type { SttResult } from "@zipy/ingest/stt";
import type { DiarizationResult } from "@zipy/ingest/diarization";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type UnifiedRepErrorCode =
  | "invalid-input"
  | "unknown-source-kind"
  | "empty-representation";

export class UnifiedRepError extends Error {
  readonly code: UnifiedRepErrorCode;
  constructor(message: string, code: UnifiedRepErrorCode) {
    super(message);
    this.name = "UnifiedRepError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Canonical item model                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Modality of an item. Every item belongs to exactly one modality so fusion
 * can reason about per-modality embeddings.
 */
export type CanonicalModality =
  | "text"
  | "table"
  | "image"
  | "ui-element"
  | "diagram-node"
  | "diagram-edge"
  | "audio-transcript"
  | "video-frame"
  | "url-element"
  | "document-heading";

/** Content payload variants, keyed by `item.content.kind`. */
export type CanonicalContent =
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "rich"; readonly markdown: string; readonly text: string }
  | {
      readonly kind: "table";
      readonly markdown: string;
      readonly json: {
        readonly headers: readonly string[];
        readonly rows: readonly (readonly string[])[];
        readonly columnCount: number;
      };
    }
  | {
      readonly kind: "image";
      readonly mimeType: string;
      readonly contentHash: string;
      readonly byteLength: number;
      readonly altText: string;
      /** Object-store reference; null when bytes were only in memory at ingest time. */
      readonly objectRef: string | null;
    }
  | {
      readonly kind: "ui-element";
      readonly elementType: string;
      readonly label: string;
      /** Optional selector that can be re-resolved at automation time. */
      readonly selector: string | null;
      readonly role: string | null;
    }
  | {
      readonly kind: "audio-transcript";
      readonly text: string;
      readonly speaker: string | null;
      readonly confidence: number | null;
    }
  | {
      readonly kind: "video-frame";
      readonly timestampSeconds: number;
      readonly onScreenText: string;
      readonly frameHash: string;
    };

/** Region of a source artifact where an item originated. */
export type CanonicalLocator =
  | { readonly kind: "url-page"; readonly url: string }
  | { readonly kind: "a11y-node"; readonly ref: string; readonly role: string }
  | { readonly kind: "prompt"; readonly rawPromptHash: string }
  | { readonly kind: "image-region"; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly kind: "pdf-page"; readonly page: number; readonly blockOrdinal: number | null }
  | { readonly kind: "docx-paragraph"; readonly paragraphIndex: number }
  | { readonly kind: "pptx-block"; readonly slideNumber: number; readonly blockOrdinal: number }
  | { readonly kind: "audio-segment"; readonly ordinal: number; readonly start: number; readonly end: number }
  | { readonly kind: "video-frame"; readonly timestampSeconds: number }
  | { readonly kind: "table-cell"; readonly row: number; readonly col: number };

export interface Provenance {
  /**
   * Opaque source reference owned by the caller (typically an artifact id).
   * The UIR does not interpret it; consumers use it to link back.
   */
  readonly sourceRef: string;
  /** Modality of the source this item came from. */
  readonly sourceKind: CanonicalSourceKind;
  /** Human-readable label for UI ("Uploaded invoice.pdf", "https://app…"). */
  readonly sourceLabel: string;
  /** Where inside the source this item was found. */
  readonly locator: CanonicalLocator;
  /** Optional pixel bounding box in the source image, when known. */
  readonly pixelBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
  } | null;
  /** Page or slide number when applicable; null otherwise. */
  readonly pageNumber: number | null;
  /** Timestamp in seconds for audio/video-derived items; null otherwise. */
  readonly timestampSeconds: number | null;
}

/** Free-form annotations carried alongside the content (OCR confidence, VLM labels, etc.). */
export interface CanonicalAnnotations {
  /** OCR confidence in [0,1] when the item came from OCR; null when not applicable. */
  readonly ocrConfidence: number | null;
  /** VLM-provided element/region label; null when not applicable. */
  readonly vlmLabel: string | null;
  /** Arbitrary key/value metadata the extractor chose to keep. Values must be JSON primitives. */
  readonly extra: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CanonicalItem {
  /** Stable id within this representation. Deterministic from local inputs. */
  readonly id: string;
  readonly modality: CanonicalModality;
  readonly content: CanonicalContent;
  readonly provenance: Provenance;
  readonly annotations: CanonicalAnnotations;
  /**
   * Sequence index within the source; used to preserve reading order when the
   * fusion layer needs to reconstruct a narrative.
   */
  readonly ordinalInSource: number;
}

/* -------------------------------------------------------------------------- */
/* Source kinds and headers                                                    */
/* -------------------------------------------------------------------------- */

export type CanonicalSourceKind =
  | "url"
  | "text"
  | "image"
  | "pdf"
  | "docx"
  | "pptx"
  | "audio"
  | "video";

export interface SourceHeader {
  readonly sourceRef: string;
  readonly sourceKind: CanonicalSourceKind;
  readonly sourceLabel: string;
  /** Content hash of the original artifact; may be "" when the caller did not supply one. */
  readonly contentHash: string;
  readonly mimeType: string;
  /** ISO timestamp of the ingest. May be "" when unavailable. */
  readonly capturedAt: string;
  /** Number of items projected from this source. */
  readonly itemCount: number;
}

/* -------------------------------------------------------------------------- */
/* Unified representation                                                      */
/* -------------------------------------------------------------------------- */

export interface UnifiedRepresentation {
  /** Deterministic id from the set of source refs + hashes. */
  readonly id: string;
  /** ISO timestamp. */
  readonly createdAt: string;
  /** Source headers in the priority order the caller supplied. */
  readonly sources: readonly SourceHeader[];
  /** All items across all sources, ordered by source priority then ordinal. */
  readonly items: readonly CanonicalItem[];
  /**
   * Sources that contributed zero items. Reported explicitly; nothing is
   * fabricated to fill the gap.
   */
  readonly sourceGaps: readonly {
    readonly sourceRef: string;
    readonly reason: string;
  }[];
  /** Counts, cheaply derived. */
  readonly counts: {
    readonly items: number;
    readonly byModality: Readonly<Record<CanonicalModality, number>>;
    readonly bySourceKind: Readonly<Record<CanonicalSourceKind, number>>;
  };
}

/* -------------------------------------------------------------------------- */
/* Projection result from each ingest module                                   */
/* -------------------------------------------------------------------------- */

export interface SourceProjection {
  readonly header: SourceHeader;
  readonly items: readonly CanonicalItem[];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function emptyCounts(): Record<CanonicalModality, number> {
  return {
    text: 0,
    table: 0,
    image: 0,
    "ui-element": 0,
    "diagram-node": 0,
    "diagram-edge": 0,
    "audio-transcript": 0,
    "video-frame": 0,
    "url-element": 0,
    "document-heading": 0,
  };
}

function emptySourceCounts(): Record<CanonicalSourceKind, number> {
  return {
    url: 0,
    text: 0,
    image: 0,
    pdf: 0,
    docx: 0,
    pptx: 0,
    audio: 0,
    video: 0,
  };
}

function stableId(parts: readonly (string | number)[]): string {
  const joined = parts.map((p) => String(p)).join("\u0000");
  // FNV-1a 64-bit (two 32-bit halves); deterministic and dependency-free.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < joined.length; i += 1) {
    const c = joined.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const hi = (h1 >>> 0).toString(16).padStart(8, "0");
  const lo = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${hi}${lo}`;
}

function safeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------- */
/* Projections: each ingest module → SourceProjection                          */
/* -------------------------------------------------------------------------- */

/* ---------------------------------- URL ---------------------------------- */

import type { A11yTree, A11yNode } from "@zipy/ingest/a11y";
import type { IndexedElement } from "@zipy/ingest/elementIndex";

export interface UrlProjectionInput {
  readonly sourceRef: string;
  readonly url: string;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly a11y: A11yTree;
  readonly elements: readonly IndexedElement[];
  readonly sourceLabel?: string;
}

/**
 * Project a URL ingest (a11y tree + element index) onto the canonical surface.
 * Produces one `url-element` item per interactive element with a stable ref,
 * and one `text` item per node that carries a name but no matching element
 * (headings, landmarks, static text).
 */
export function projectUrlIngest(input: UrlProjectionInput): SourceProjection {
  const items: CanonicalItem[] = [];
  const sourceLabel = input.sourceLabel ?? input.url;

  const elementByRef = new Map<string, IndexedElement>();
  for (const el of input.elements) elementByRef.set(el.ref, el);

  const a11yNodes = flattenA11y(input.a11y);
  for (let i = 0; i < a11yNodes.length; i += 1) {
    const node = a11yNodes[i];
    const ref = typeof node.stableRef === "string" ? node.stableRef : null;
    const name = typeof node.name === "string" ? node.name.trim() : "";
    const role = typeof node.role === "string" ? node.role : "";

    if (ref !== null && elementByRef.has(ref)) {
      const el = elementByRef.get(ref) as IndexedElement;
      const itemId = stableId([input.sourceRef, "url-element", ref]);
      items.push({
        id: itemId,
        modality: "url-element",
        content: {
          kind: "ui-element",
          elementType: el.elementType ?? el.tagName ?? "unknown",
          label: name.length > 0 ? name : (el.text ?? ""),
          selector: el.selector ?? null,
          role: role.length > 0 ? role : null,
        },
        provenance: {
          sourceRef: input.sourceRef,
          sourceKind: "url",
          sourceLabel,
          locator: { kind: "a11y-node", ref, role: role.length > 0 ? role : "unknown" },
          pixelBox: null,
          pageNumber: null,
          timestampSeconds: null,
        },
        annotations: {
          ocrConfidence: null,
          vlmLabel: null,
          extra: {
            tagName: el.tagName ?? null,
            isInteractive: el.isInteractive ?? true,
          },
        },
        ordinalInSource: i,
      });
      continue;
    }

    if (name.length === 0) continue;
    const itemId = stableId([input.sourceRef, "text", "a11y", i]);
    items.push({
      id: itemId,
      modality: role === "heading" ? "document-heading" : "text",
      content: { kind: "plain", text: safeText(name) },
      provenance: {
        sourceRef: input.sourceRef,
        sourceKind: "url",
        sourceLabel,
        locator: {
          kind: "a11y-node",
          ref: ref ?? `a11y:${i}`,
          role: role.length > 0 ? role : "unknown",
        },
        pixelBox: null,
        pageNumber: null,
        timestampSeconds: null,
      },
      annotations: {
        ocrConfidence: null,
        vlmLabel: null,
        extra: { role },
      },
      ordinalInSource: i,
    });
  }

  return {
    header: {
      sourceRef: input.sourceRef,
      sourceKind: "url",
      sourceLabel,
      contentHash: input.contentHash,
      mimeType: "text/html",
      capturedAt: input.capturedAt,
      itemCount: items.length,
    },
    items,
  };
}

function flattenA11y(tree: A11yTree): readonly A11yNode[] {
  const out: A11yNode[] = [];
  const stack: A11yNode[] = [...tree.roots];
  while (stack.length > 0) {
    const node = stack.pop() as A11yNode;
    out.push(node);
    if (Array.isArray(node.children)) {
      // Preserve document order for children by pushing reversed.
      const children = node.children;
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }
  return out;
}

/* ---------------------------------- Text ---------------------------------- */

export interface TextPromptProjectionInput {
  readonly sourceRef: string;
  readonly prompt: string;
  readonly goal: string;
  readonly entities: readonly { readonly kind: string; readonly value: string }[];
  readonly subTasks: readonly { readonly ordinal: number; readonly description: string }[];
  readonly capturedAt: string;
  readonly sourceLabel?: string;
}

/**
 * Project a parsed text prompt. Emits one `text` item for the goal, one per
 * entity, and one per sub-task. The raw prompt hash is the locator so the
 * caller can always trace back to the origin prompt.
 */
export function projectTextPrompt(input: TextPromptProjectionInput): SourceProjection {
  const items: CanonicalItem[] = [];
  const sourceLabel = input.sourceLabel ?? "Text prompt";
  const promptHash = stableId([input.prompt]);
  const pushText = (
    ordinal: number,
    roleKey: string,
    text: string,
    extra: CanonicalAnnotations["extra"],
    modality: CanonicalModality = "text",
  ): void => {
    const trimmed = safeText(text);
    if (trimmed.length === 0) return;
    items.push({
      id: stableId([input.sourceRef, "prompt", roleKey, ordinal]),
      modality,
      content: { kind: "plain", text: trimmed },
      provenance: {
        sourceRef: input.sourceRef,
        sourceKind: "text",
        sourceLabel,
        locator: { kind: "prompt", rawPromptHash: promptHash },
        pixelBox: null,
        pageNumber: null,
        timestampSeconds: null,
      },
      annotations: {
        ocrConfidence: null,
        vlmLabel: null,
        extra: { role: roleKey, ...extra },
      },
      ordinalInSource: ordinal,
    });
  };

  let ordinal = 0;
  pushText(ordinal, "goal", input.goal, {});
  ordinal += 1;
  for (let i = 0; i < input.entities.length; i += 1) {
    const e = input.entities[i];
    pushText(ordinal, `entity:${e.kind}`, e.value, { entityKind: e.kind });
    ordinal += 1;
  }
  for (const st of input.subTasks) {
    pushText(ordinal, `subtask:${st.ordinal}`, st.description, { subtaskOrdinal: st.ordinal });
    ordinal += 1;
  }

  return {
    header: {
      sourceRef: input.sourceRef,
      sourceKind: "text",
      sourceLabel,
      contentHash: promptHash,
      mimeType: "text/plain",
      capturedAt: input.capturedAt,
      itemCount: items.length,
    },
    items,
  };
}

/* ---------------------------------- Image --------------------------------- */

export interface OcrBlockProjectionInput {
  readonly ordinal: number;
  readonly text: string;
  readonly confidence: number | null;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface VlmElementProjectionInput {
  readonly ordinal: number;
  readonly elementType: string;
  readonly label: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly confidence: number | null;
}

export interface ImageProjectionInput {
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly altText: string;
  readonly objectRef: string | null;
  readonly capturedAt: string;
  readonly ocrBlocks: readonly OcrBlockProjectionInput[];
  readonly vlmElements: readonly VlmElementProjectionInput[];
  readonly sourceLabel?: string;
  readonly pixelScale?: number;
}

/**
 * Project an image ingest (OCR blocks + VLM elements) onto the canonical
 * surface. Produces one `text` item per OCR block (with its pixel region) and
 * one `ui-element` item per recognized UI element.
 */
export function projectImageIngest(input: ImageProjectionInput): SourceProjection {
  const items: CanonicalItem[] = [];
  const sourceLabel = input.sourceLabel ?? "Uploaded image";
  const scale = input.pixelScale ?? 1;

  for (const block of input.ocrBlocks) {
    const text = safeText(block.text);
    if (text.length === 0) continue;
    items.push({
      id: stableId([input.sourceRef, "ocr", block.ordinal]),
      modality: "text",
      content: { kind: "plain", text },
      provenance: {
        sourceRef: input.sourceRef,
        sourceKind: "image",
        sourceLabel,
        locator: {
          kind: "image-region",
          x: block.box.x,
          y: block.box.y,
          width: block.box.width,
          height: block.box.height,
        },
        pixelBox: {
          x: block.box.x,
          y: block.box.y,
          width: block.box.width,
          height: block.box.height,
          scale,
        },
        pageNumber: null,
        timestampSeconds: null,
      },
      annotations: {
        ocrConfidence: block.confidence,
        vlmLabel: null,
        extra: {},
      },
      ordinalInSource: block.ordinal,
    });
  }

  for (const el of input.vlmElements) {
    const label = safeText(el.label);
    items.push({
      id: stableId([input.sourceRef, "vlm", el.ordinal]),
      modality: "ui-element",
      content: {
        kind: "ui-element",
        elementType: el.elementType,
        label,
        selector: null,
        role: null,
      },
      provenance: {
        sourceRef: input.sourceRef,
        sourceKind: "image",
        sourceLabel,
        locator: {
          kind: "image-region",
          x: el.box.x,
          y: el.box.y,
          width: el.box.width,
          height: el.box.height,
        },
        pixelBox: {
          x: el.box.x,
          y: el.box.y,
          width: el.box.width,
          height: el.box.height,
          scale,
        },
        pageNumber: null,
        timestampSeconds: null,
      },
      annotations: {
        ocrConfidence: null,
        vlmLabel: el.elementType,
        extra: { confidence: el.confidence },
      },
      ordinalInSource: el.ordinal,
    });
  }

  // Also carry the image itself as an item so downstream code can reach the
  // object reference and alt text without re-reading the source.
  items.push({
    id: stableId([input.sourceRef, "image", input.contentHash]),
    modality: "image",
    content: {
      kind: "image",
      mimeType: input.mimeType,
      contentHash: input.contentHash,
      byteLength: input.byteLength,
      altText: input.altText,
      objectRef: input.objectRef,
    },
    provenance: {
      sourceRef: input.sourceRef,
      sourceKind: "image",
      sourceLabel,
      locator: { kind: "url-page", url: sourceLabel },
      pixelBox: null,
      pageNumber: null,
      timestampSeconds: null,
    },
    annotations: {
      ocrConfidence: null,
      vlmLabel: null,
      extra: {},
    },
    ordinalInSource: items.length,
  });

  return {
    header: {
      sourceRef: input.sourceRef,
      sourceKind: "image",
      sourceLabel,
      contentHash: input.contentHash,
      mimeType: input.mimeType,
      capturedAt: input.capturedAt,
      itemCount: items.length,
    },
    items,
  };
}

/* ---------------------------------- PDF ----------------------------------- */

export interface PdfBlockProjectionInput {
  readonly ordinal: number;
  readonly page: number;
  readonly kind: "text" | "table" | "figure";
  readonly text: string;
  readonly table: {
    readonly markdown: string;
    readonly json: {
      readonly headers: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly columnCount: number;
    };
  } | null;
}

export interface PdfProjectionInput {
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly pageCount: number;
  readonly blocks: readonly PdfBlockProjectionInput[];
  readonly sourceLabel?: string;
}

/**
 * Project a PDF ingest. Text blocks become `text` items, tables become
 * `table` items, figures become `image` items with an objectRef when supplied.
 */
export function projectPdfIngest(input: PdfProjectionInput): SourceProjection {
  const items: CanonicalItem[] = [];
  const sourceLabel = input.sourceLabel ?? "Uploaded PDF";

  for (const block of input.blocks) {
    if (block.kind === "text") {
      const text = safeText(block.text);
      if (text.length === 0) continue;
      items.push({
        id: stableId([input.sourceRef, "pdf-text", block.page, block.ordinal]),
        modality: "text",
        content: { kind: "plain", text },
        provenance: {
          sourceRef: input.sourceRef,
          sourceKind: "pdf",
          sourceLabel,
          locator: { kind: "pdf-page", page: block.page, blockOrdinal: block.ordinal },
          pixelBox: null,
          pageNumber: block.page,
          timestampSeconds: null,
        },
        annotations: { ocrConfidence: null, vlmLabel: null, extra: {} },
        ordinalInSource: block.ordinal,
      });
      continue;
    }
    if (block.kind === "table" && block.table !== null) {
      items.push({
        id: stableId([input.sourceRef, "pdf-table", block.page, block.ordinal]),
        modality: "table",
        content: {
          kind: "table",
          markdown: block.table.markdown,
          json: block.table.json,
        },
        provenance: {
          sourceRef: input.sourceRef,
          sourceKind: "pdf",
          sourceLabel,
          locator: { kind: "pdf-page", page: block.page, blockOrdinal: block.ordinal },
          pixelBox: null,
          pageNumber: block.page,
          timestampSeconds: null,
        },
        annotations: { ocrConfidence: null, vlmLabel: null, extra: {} },
        ordinalInSource: block.ordinal,
      });
      continue;
    }
    // figure: represented as a text placeholder for now; the image bytes
    // are referenced via the caller's object store.
    const caption = safeText(block.text);
    items.push({
      id: stableId([input.sourceRef, "pdf-figure", block.page, block.ordinal]),
      modality: "image",
      content: {
        kind: "image",
        mimeType: "application/octet-stream",
        contentHash: "",
        byteLength: 0,
        altText: caption,
        objectRef: null,
      },
      provenance: {
        sourceRef: input.sourceRef,
        sourceKind: "pdf",
        sourceLabel,
        locator: { kind: "pdf-page", page: block.page, blockOrdinal: block.ordinal },
        pixelBox: null,
        pageNumber: block.page,
        timestampSeconds: null,
      },
      annotations: { ocrConfidence: null, vlmLabel: "figure", extra: {} },
      ordinalInSource: block.ordinal,
    });
  }

  return {
    header: {
      sourceRef: input.sourceRef,
      sourceKind: "pdf",
      sourceLabel,
      contentHash: input.contentHash,
      mimeType: "application/pdf",
      capturedAt: input.capturedAt,
      itemCount: items.length,
    },
    items,
  };
}

/* ---------------------------------- DOCX ----------------------------------- */

export interface DocxBlockProjectionInput {
  readonly ordinal: number;
  readonly kind: "heading" | "paragraph" | "list" | "table";
  readonly text: string;
  readonly table: {
    readonly markdown: string;
    readonly json: {
      readonly headers: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly columnCount: number;
    };
  } | null;
}

export interface DocxProjectionInput {
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly blocks: readonly DocxBlockProjectionInput[];
  readonly sourceLabel?: string;
}

export function projectDocxIngest(input: DocxProjectionInput): SourceProjection {
  const items: CanonicalItem[] = [];
  const sourceLabel = input.sourceLabel ?? "Uploaded document";
  for (const block of input.blocks) {
    if (block.kind === "table" && block.table !== null) {
      items.push({
        id: stableId([input.sourceRef, "docx-table", block.ordinal]),
        modality: "table",
        content: {
          kind: "table",
          markdown: block.table.markdown,
          json: block.table.json,
        },
        provenance: {
          sourceRef: input.sourceRef,
          sourceKind: "docx",
          sourceLabel,
          locator: { kind: "docx-paragraph", paragraphIndex: block.ordinal },
          pixelBox: null,
          pageNumber: null,
          timestampSeconds: null,
        },
        annotations: { ocrConfidence: null, vlmLabel: null, extra: {} },
        ordinalInSource: block.ordinal,
      });
      continue;
    }
    const text = safeText(block.text);
    if (text.length === 0) continue;
    items.push({
      id: stableId([input.sourceRef, "docx", block.kind, block.ordinal]),
      modality: block.kind === "heading" ? "document-heading" : "text",
      content: { kind: "plain", text },
      provenance: {
        sourceRef: input.sourceRef,
        sourceKind: "docx",
        sourceLabel,
        locator: { kind: "docx-paragraph", paragraphIndex: block.ordinal },
        pixelBox: null,
        pageNumber: null,
        timestampSeconds: null,
      },
      annotations: {
        ocrConfidence: null,
        vlmLabel: null,
        extra: { blockKind: block.kind },
      },
      ordinalInSource: block.ordinal,
    });
  }
  return {
    header: {
      sourceRef: input.sourceRef,
      sourceKind: "docx",
      sourceLabel,
      contentHash: input.contentHash,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      capturedAt: input.capturedAt,
      itemCount: items.length,
    },
    items,
  };
}

/* ---------------------------------- PPTX ----------------------------------- */

export interface PptxBlockProjectionInput {
  readonly ordinal: number;
  readonly slideNumber: number;
  readonly kind: "title" | "paragraph" | "list" | "table" | "image" | "notes" | "subtitle";
  readonly text: string;
  readonly table: {
    readonly markdown: string;
    readonly json: {
      readonly headers: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly columnCount: number;
    };
  } | null;
  readonly imageRef: {
    readonly contentHash: string;
    readonly mimeType: string;
    readonly byteLength: number;
    readonly altText: string;
    readonly objectRef: string | null;
  } | null;
}

export interface PptxProjectionInput {
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly blocks: readonly PptxBlockProjectionInput[];
  readonly sourceLabel?: string;
}

export function projectPptxIngest(input: PptxProjectionInput): SourceProjection {
  const items: CanonicalItem[] = [];
  const sourceLabel = input.sourceLabel ?? "Uploaded presentation";
  for (const block of input.blocks) {
    if (block.kind === "table" && block.table !== null) {
      items.push({
        id: stableId([input.sourceRef, "pptx-table", block.slideNumber, block.ordinal]),
        modality: "table",
        content: {
          kind: "table",
          markdown: block.table.markdown,
          json: block.table.json,
        },
        provenance: {
          sourceRef: input.sourceRef,
          sourceKind: "pptx",
          sourceLabel,
          locator: { kind: "pptx-block", slideNumber: block.slideNumber, blockOrdinal: block.ordinal },
          pixelBox: null,
          pageNumber: block.slideNumber,
          timestampSeconds: null,
        },
        annotations: { ocrConfidence: null, vlmLabel: null, extra: {} },
        ordinalInSource: block.ordinal,
      });
      continue;
    }
    if (block.kind === "image" && block.imageRef !== null) {
      items.push({
        id: stableId([input.sourceRef, "pptx-image", block.slideNumber, block.ordinal]),
        modality: "image",
        content: {
          kind: "image",
          mimeType: block.imageRef.mimeType,
          contentHash: block.imageRef.contentHash,
          byteLength: block.imageRef.byteLength,
          altText: block.imageRef.altText,
          objectRef: block.imageRef.objectRef,
        },
        provenance: {
          sourceRef: input.sourceRef,
          sourceKind: "pptx",
          sourceLabel,
          locator: { kind: "pptx-block", slideNumber: block.slideNumber, blockOrdinal: block.ordinal },
          pixelBox: null,
          pageNumber: block.slideNumber,
          timestampSeconds: null,
        },
        annotations: { ocrConfidence: null, vlmLabel: null, extra: {} },
        ordinalInSource: block.ordinal,
      });
      continue;
    }
    const text = safeText(block.text);
    if (text.length === 0) continue;
    items.push({
      id: stableId([input.sourceRef, "pptx", block.kind, block.slideNumber, block.ordinal]),
      modality:
        block.kind === "title" || block.kind === "subtitle" ? "document-heading" : "text",
      content: { kind: "plain", text },
      provenance: {
        sourceRef: input.sourceRef,
        sourceKind: "pptx",
        sourceLabel,
        locator: { kind: "pptx-block", slideNumber: block.slideNumber, blockOrdinal: block.ordinal },
        pixelBox: null,
        pageNumber: block.slideNumber,
        timestampSeconds: null,
      },
      annotations: {
        ocrConfidence: null,
        vlmLabel: null,
        extra: { blockKind: block.kind },
      },
      ordinalInSource: block.ordinal,
    });
  }
  return {
    header: {
      sourceRef: input.sourceRef,
      sourceKind: "pptx",
      sourceLabel,
      contentHash: input.contentHash,
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      capturedAt: input.capturedAt,
      itemCount: items.length,
    },
    items,
  };
}

/* --------------------------------- Audio ---------------------------------- */

export interface AudioProjectionInput {
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly capturedAt: string;
  readonly stt: SttResult;
  readonly diarization: DiarizationResult;
  readonly sourceLabel?: string;
}

/**
 * Project an audio ingest. Produces one `audio-transcript` item per
 * diarization segment (or per STT segment when diarization is not available).
 * The speaker field is the engine-reported label or null; nothing is invented.
 */
export function projectAudioIngest(input: AudioProjectionInput): SourceProjection {
  const items: CanonicalItem[] = [];
  const sourceLabel = input.sourceLabel ?? "Uploaded audio";

  const diarizedByOrdinal = new Map<number, { speaker: string | null }>();
  for (const seg of input.diarization.segments) {
    diarizedByOrdinal.set(seg.ordinal, { speaker: seg.speaker });
  }

  for (const seg of input.stt.segments) {
    const text = safeText(seg.text);
    if (text.length === 0) continue;
    const speaker = diarizedByOrdinal.get(seg.ordinal)?.speaker ?? null;
    items.push({
      id: stableId([input.sourceRef, "audio-seg", seg.ordinal]),
      modality: "audio-transcript",
      content: {
        kind: "audio-transcript",
        text,
        speaker,
        confidence: seg.confidence,
      },
      provenance: {
        sourceRef: input.sourceRef,
        sourceKind: "audio",
        sourceLabel,
        locator: { kind: "audio-segment", ordinal: seg.ordinal, start: seg.start, end: seg.end },
        pixelBox: null,
        pageNumber: null,
        timestampSeconds: seg.start,
      },
      annotations: {
        ocrConfidence: null,
        vlmLabel: null,
        extra: {
          start: seg.start,
          end: seg.end,
          speaker: speaker ?? null,
        },
      },
      ordinalInSource: seg.ordinal,
    });
  }

  return {
    header: {
      sourceRef: input.sourceRef,
      sourceKind: "audio",
      sourceLabel,
      contentHash: input.contentHash,
      mimeType: input.mimeType,
      capturedAt: input.capturedAt,
      itemCount: items.length,
    },
    items,
  };
}

/* --------------------------------- Video ---------------------------------- */

export interface VideoFrameProjectionInput {
  readonly ordinal: number;
  readonly timestampSeconds: number;
  readonly frameHash: string;
  readonly onScreenText: string;
  readonly ocrBlocks: readonly OcrBlockProjectionInput[];
  readonly vlmElements: readonly VlmElementProjectionInput[];
}

export interface VideoProjectionInput {
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly capturedAt: string;
  readonly durationSeconds: number;
  readonly frames: readonly VideoFrameProjectionInput[];
  readonly sourceLabel?: string;
  readonly pixelScale?: number;
}

/**
 * Project a video ingest. Emits one `video-frame` item per sampled frame
 * (with on-screen text + frame hash), plus a `text` item per OCR block and a
 * `ui-element` item per recognized UI element within each frame. Provenance
 * carries the frame timestamp so the caller can always re-locate the frame.
 *
 * Note: no video bytes are referenced. Frames are the durable artifacts.
 */
export function projectVideoIngest(input: VideoProjectionInput): SourceProjection {
  const items: CanonicalItem[] = [];
  const sourceLabel = input.sourceLabel ?? "Uploaded video";
  const scale = input.pixelScale ?? 1;
  let ordinalCursor = 0;

  for (const frame of input.frames) {
    items.push({
      id: stableId([input.sourceRef, "video-frame", frame.ordinal]),
      modality: "video-frame",
      content: {
        kind: "video-frame",
        timestampSeconds: frame.timestampSeconds,
        onScreenText: safeText(frame.onScreenText),
        frameHash: frame.frameHash,
      },
      provenance: {
        sourceRef: input.sourceRef,
        sourceKind: "video",
        sourceLabel,
        locator: { kind: "video-frame", timestampSeconds: frame.timestampSeconds },
        pixelBox: null,
        pageNumber: null,
        timestampSeconds: frame.timestampSeconds,
      },
      annotations: { ocrConfidence: null, vlmLabel: null, extra: {} },
      ordinalInSource: ordinalCursor,
    });
    ordinalCursor += 1;

    for (const block of frame.ocrBlocks) {
      const text = safeText(block.text);
      if (text.length === 0) continue;
      items.push({
        id: stableId([input.sourceRef, "video-ocr", frame.ordinal, block.ordinal]),
        modality: "text",
        content: { kind: "plain", text },
        provenance: {
          sourceRef: input.sourceRef,
          sourceKind: "video",
          sourceLabel,
          locator: {
            kind: "image-region",
            x: block.box.x,
            y: block.box.y,
            width: block.box.width,
            height: block.box.height,
          },
          pixelBox: {
            x: block.box.x,
            y: block.box.y,
            width: block.box.width,
            height: block.box.height,
            scale,
          },
          pageNumber: null,
          timestampSeconds: frame.timestampSeconds,
        },
        annotations: {
          ocrConfidence: block.confidence,
          vlmLabel: null,
          extra: { frameOrdinal: frame.ordinal },
        },
        ordinalInSource: ordinalCursor,
      });
      ordinalCursor += 1;
    }

    for (const el of frame.vlmElements) {
      items.push({
        id: stableId([input.sourceRef, "video-vlm", frame.ordinal, el.ordinal]),
        modality: "ui-element",
        content: {
          kind: "ui-element",
          elementType: el.elementType,
          label: safeText(el.label),
          selector: null,
          role: null,
        },
        provenance: {
          sourceRef: input.sourceRef,
          sourceKind: "video",
          sourceLabel,
          locator: {
            kind: "image-region",
            x: el.box.x,
            y: el.box.y,
            width: el.box.width,
            height: el.box.height,
          },
          pixelBox: {
            x: el.box.x,
            y: el.box.y,
            width: el.box.width,
            height: el.box.height,
            scale,
          },
          pageNumber: null,
          timestampSeconds: frame.timestampSeconds,
        },
        annotations: {
          ocrConfidence: null,
          vlmLabel: el.elementType,
          extra: { frameOrdinal: frame.ordinal, confidence: el.confidence },
        },
        ordinalInSource: ordinalCursor,
      });
      ordinalCursor += 1;
    }
  }

  return {
    header: {
      sourceRef: input.sourceRef,
      sourceKind: "video",
      sourceLabel,
      contentHash: input.contentHash,
      mimeType: input.mimeType,
      capturedAt: input.capturedAt,
      itemCount: items.length,
    },
    items,
  };
}

/* -------------------------------------------------------------------------- */
/* Fusion                                                                      */
/* -------------------------------------------------------------------------- */

export interface SourcePriorityEntry {
  readonly sourceRef: string;
  /** Lower number = higher priority. Ties are broken by input order. */
  readonly priority: number;
}

export interface FuseOptions {
  /**
   * Optional explicit ordering. When absent, sources are ordered by the order
   * they appear in `sources`. The caller typically supplies this from the
   * workspace-level source priority list.
   */
  readonly priority?: readonly SourcePriorityEntry[];
}

/**
 * Combine N `SourceProjection`s into a single `UnifiedRepresentation`.
 *
 * This does not deduplicate or reconcile items across sources — that is the
 * fusion phase. It produces one container with headers ordered by the supplied
 * priority (or input order when no priority list is supplied), all items
 * concatenated in that same order, and an explicit gap record for any source
 * that produced zero items.
 *
 * Determinism: identical inputs produce identical `id` and item ordering.
 * The representation `id` is derived from the (sourceRef, contentHash) pairs
 * in priority order; item ids are derived from their own source refs and
 * ordinal/locator values, so they remain stable even if the priority list
 * changes.
 */
export function fuseSources(
  sources: readonly SourceProjection[],
  options: FuseOptions = {},
): UnifiedRepresentation {
  if (sources.length === 0) {
    throw new UnifiedRepError(
      "fuseSources requires at least one source projection.",
      "invalid-input",
    );
  }

  const priorityMap = new Map<string, number>();
  if (Array.isArray(options.priority)) {
    for (const entry of options.priority) {
      priorityMap.set(entry.sourceRef, entry.priority);
    }
  }

  const ordered: SourceProjection[] = [...sources];
  ordered.sort((a, b) => {
    const pa = priorityMap.get(a.header.sourceRef);
    const pb = priorityMap.get(b.header.sourceRef);
    if (pa === undefined && pb === undefined) return 0;
    if (pa === undefined) return 1;
    if (pb === undefined) return -1;
    return pa - pb;
  });

  const items: CanonicalItem[] = [];
  const headers: SourceHeader[] = [];
  const sourceGaps: { sourceRef: string; reason: string }[] = [];
  const modalityCounts = emptyCounts();
  const sourceCounts = emptySourceCounts();

  for (const source of ordered) {
    headers.push(source.header);
    sourceCounts[source.header.sourceKind] += 1;
    if (source.items.length === 0) {
      sourceGaps.push({
        sourceRef: source.header.sourceRef,
        reason: "Source produced zero canonical items during projection.",
      });
    }
    for (const item of source.items) {
      items.push(item);
      modalityCounts[item.modality] += 1;
    }
  }

  const idParts: (string | number)[] = [];
  for (const h of headers) {
    idParts.push(h.sourceKind, h.sourceRef, h.contentHash);
  }
  const id = stableId(idParts);

  return {
    id,
    createdAt: nowIso(),
    sources: headers,
    items,
    sourceGaps,
    counts: {
      items: items.length,
      byModality: modalityCounts,
      bySourceKind: sourceCounts,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export interface RehydratedUnifiedRepresentation {
  readonly id: string;
  readonly createdAt: string;
  readonly sources: readonly SourceHeader[];
  readonly items: readonly CanonicalItem[];
  readonly sourceGaps: readonly { readonly sourceRef: string; readonly reason: string }[];
  readonly counts: UnifiedRepresentation["counts"];
}

/**
 * Read a persisted `UnifiedRepresentation`. Validates only the top-level
 * shape; item payloads are structurally typed via `CanonicalContent` and are
 * not re-validated here — consumers that require deep validation call the
 * appropriate per-modality rehydrator (e.g. `rehydrateSttResult`).
 */
export function rehydrateUnifiedRepresentation(
  value: unknown,
): RehydratedUnifiedRepresentation {
  if (value === null || typeof value !== "object") {
    throw new UnifiedRepError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const sourcesRaw = Array.isArray(r["sources"]) ? (r["sources"] as unknown[]) : [];
  const sources: SourceHeader[] = [];
  for (const sRaw of sourcesRaw) {
    if (sRaw === null || typeof sRaw !== "object") continue;
    const s = sRaw as Record<string, unknown>;
    const kindRaw = s["sourceKind"];
    const validKinds: readonly CanonicalSourceKind[] = [
      "url",
      "text",
      "image",
      "pdf",
      "docx",
      "pptx",
      "audio",
      "video",
    ];
    if (typeof kindRaw !== "string" || !(validKinds as readonly string[]).includes(kindRaw)) {
      continue;
    }
    const sourceRef = typeof s["sourceRef"] === "string" ? (s["sourceRef"] as string) : "";
    if (sourceRef.length === 0) continue;
    sources.push({
      sourceRef,
      sourceKind: kindRaw as CanonicalSourceKind,
      sourceLabel:
        typeof s["sourceLabel"] === "string" ? (s["sourceLabel"] as string) : "",
      contentHash:
        typeof s["contentHash"] === "string" ? (s["contentHash"] as string) : "",
      mimeType: typeof s["mimeType"] === "string" ? (s["mimeType"] as string) : "",
      capturedAt:
        typeof s["capturedAt"] === "string" ? (s["capturedAt"] as string) : "",
      itemCount: typeof s["itemCount"] === "number" ? (s["itemCount"] as number) : 0,
    });
  }
  const itemsRaw = Array.isArray(r["items"]) ? (r["items"] as unknown[]) : [];
  const items: CanonicalItem[] = [];
  for (const iRaw of itemsRaw) {
    if (iRaw === null || typeof iRaw !== "object") continue;
    const i = iRaw as Record<string, unknown>;
    const id = typeof i["id"] === "string" ? (i["id"] as string) : "";
    if (id.length === 0) continue;
    const modalityRaw = i["modality"];
    const validModalities: readonly CanonicalModality[] = [
      "text",
      "table",
      "image",
      "ui-element",
      "diagram-node",
      "diagram-edge",
      "audio-transcript",
      "video-frame",
      "url-element",
      "document-heading",
    ];
    if (typeof modalityRaw !== "string" || !(validModalities as readonly string[]).includes(modalityRaw)) {
      continue;
    }
    const content = i["content"];
    if (content === null || typeof content !== "object") continue;
    const provenance = i["provenance"];
    if (provenance === null || typeof provenance !== "object") continue;
    const annotations = i["annotations"];
    items.push({
      id,
      modality: modalityRaw as CanonicalModality,
      content: content as CanonicalContent,
      provenance: provenance as Provenance,
      annotations:
        annotations !== null && typeof annotations === "object"
          ? (annotations as CanonicalAnnotations)
          : { ocrConfidence: null, vlmLabel: null, extra: {} },
      ordinalInSource:
        typeof i["ordinalInSource"] === "number"
          ? (i["ordinalInSource"] as number)
          : items.length,
    });
  }
  const gapsRaw = Array.isArray(r["sourceGaps"]) ? (r["sourceGaps"] as unknown[]) : [];
  const sourceGaps: { sourceRef: string; reason: string }[] = [];
  for (const g of gapsRaw) {
    if (g === null || typeof g !== "object") continue;
    const gg = g as Record<string, unknown>;
    const ref = typeof gg["sourceRef"] === "string" ? (gg["sourceRef"] as string) : "";
    if (ref.length === 0) continue;
    sourceGaps.push({
      sourceRef: ref,
      reason: typeof gg["reason"] === "string" ? (gg["reason"] as string) : "",
    });
  }
  const countsRaw = r["counts"];
  let counts: UnifiedRepresentation["counts"] = {
    items: items.length,
    byModality: emptyCounts(),
    bySourceKind: emptySourceCounts(),
  };
  if (countsRaw !== null && typeof countsRaw === "object") {
    const c = countsRaw as Record<string, unknown>;
    const byModality = emptyCounts();
    const bySourceKind = emptySourceCounts();
    const bm = c["byModality"];
    if (bm !== null && typeof bm === "object") {
      for (const key of Object.keys(byModality) as CanonicalModality[]) {
        const v = (bm as Record<string, unknown>)[key];
        if (typeof v === "number" && Number.isFinite(v)) byModality[key] = v;
      }
    }
    const bk = c["bySourceKind"];
    if (bk !== null && typeof bk === "object") {
      for (const key of Object.keys(bySourceKind) as CanonicalSourceKind[]) {
        const v = (bk as Record<string, unknown>)[key];
        if (typeof v === "number" && Number.isFinite(v)) bySourceKind[key] = v;
      }
    }
    counts = {
      items: typeof c["items"] === "number" ? (c["items"] as number) : items.length,
      byModality,
      bySourceKind,
    };
  }
  return {
    id: typeof r["id"] === "string" ? (r["id"] as string) : "",
    createdAt: typeof r["createdAt"] === "string" ? (r["createdAt"] as string) : "",
    sources,
    items,
    sourceGaps,
    counts,
  };
}
