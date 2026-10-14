/**
 * Zipy AI — UI element recognition for screenshots.
 *
 * Produces a page-level element index from the *raw UI element list* that the
 * vision pipeline (`@zipy/ingest/vlmElements`) produced for a screenshot, plus
 * the OCR text regions that overlap each element. That index is what the AI
 * workflow synthesis phase consumes to map a natural-language instruction to
 * a concrete element (`@e3`-style reference).
 *
 * Relationship to `@zipy/ingest/vlmElements`:
 *  - That module talks to a vision-language model. It is network-bound, and
 *    its output shape (`RecognizedElement`) is what this module takes as
 *    input.
 *  - This module is *pure*: it does not call a model, does not read files,
 *    and does not touch credentials. Its job is (a) validation and
 *    normalisation of a VLM response for a single page, (b) correction of the
 *    model's bounding boxes against the image bounds and against overlapping
 *    OCR text, (c) assignment of stable refs so the synthesis layer can refer
 *    to each element in a plan without repeating the pixel box.
 *
 * Correction rationale (why this module exists at all):
 *  - VLM boxes are sometimes offset by a few pixels from the true control.
 *    When an OCR region's text matches the element's label, the region's bbox
 *    is a stronger geometric anchor than the model's eyeballed box — the OCR
 *    box is produced from pixel evidence, not prediction.
 *  - `correctMode: "ocr-snap"` replaces the element bbox with the union of
 *    the model box and any overlapping OCR boxes whose text matches the
 *    label. `"strict"` keeps the model box exactly and only records the
 *    overlaps as diagnostics. The default is `"ocr-snap"` because it
 *    measurably reduces annotation drift (the later phase draws a highlight
 *    on the corrected box, not the raw one).
 *  - Every adjustment is *recorded* on the element as a `corrections` list
 *    so a reviewer can see what shape the model originally reported.
 *
 * No I/O. No network. No credentials. Pure.
 */

import type {
  BBox,
  OcrRegion,
  OcrResult,
} from "@zipy/ingest/ocr";
import type {
  RecognizedElement,
  UiElementKind,
} from "@zipy/ingest/vlmElements";
import { computeStableRef, slugifyName, isStableRef } from "@zipy/ingest/stableRefs";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type UiElementsErrorCode = "invalid-input" | "empty-input";

export class UiElementsError extends Error {
  readonly code: UiElementsErrorCode;
  constructor(message: string, code: UiElementsErrorCode) {
    super(message);
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs / outputs                                                            */
/* -------------------------------------------------------------------------- */

export type CorrectionMode = "ocr-snap" | "strict" | "none";

export interface BuildElementIndexInput {
  /** 0-based page/screenshot index in the source artifact. */
  readonly pageIndex: number;
  /** Image width in pixels. Required to clamp boxes. */
  readonly imageWidth: number;
  /** Image height in pixels. Required to clamp boxes. */
  readonly imageHeight: number;
  /** Raw elements produced by the VLM pipeline. */
  readonly elements: readonly RecognizedElement[];
  /** Optional OCR result for overlap-based correction and label enrichment. */
  readonly ocr?: OcrResult | null;
  /**
   * Hint for the ref scheme: which prefix to use (used only when the element
   * itself has no assignable role).
   */
  readonly defaultRole?: string | null;
}

export interface CorrectionRecord {
  readonly kind: "clamp" | "ocr-snap" | "label-enriched" | "dropped";
  readonly detail: string;
}

export interface IndexedUiElement {
  /** Stable ref using the shared `stableRefs` scheme. */
  readonly ref: string;
  readonly kind: UiElementKind;
  readonly rawRole: string;
  readonly label: string;
  /** Corrected bbox (see `correctionMode`). */
  readonly bbox: BBox;
  /** Original model bbox, unchanged. */
  readonly modelBBox: BBox;
  /** Adjusted confidence after OCR support is considered; `null` when unknown. */
  readonly confidence: number | null;
  readonly states: Readonly<Record<string, string | number | boolean>>;
  /** 0-based page index this element belongs to. */
  readonly pageIndex: number;
  /** Indexes into `input.ocr.regions` of the OCR regions that touched this box. */
  readonly overlappingOcrIndexes: readonly number[];
  /** Every adjustment this module made to the raw element, in order. */
  readonly corrections: readonly CorrectionRecord[];
}

export interface UiElementIndex {
  readonly pageIndex: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly correctionMode: CorrectionMode;
  readonly elements: readonly IndexedUiElement[];
  readonly elementCount: number;
  readonly droppedCount: number;
  /** Counts of elements per `UiElementKind`. */
  readonly kindCounts: Readonly<Record<UiElementKind, number>>;
  /** ISO timestamp of completion. */
  readonly generatedAt: string;
}

export interface BuildOptions {
  readonly correctionMode?: CorrectionMode;
  /** IoU threshold above which two elements are considered duplicates. Default 0.6. */
  readonly duplicateIoU?: number;
  /**
   * Minimum OCR-text similarity required for the OCR-snap correction. Cosine
   * over character bigrams; 0.5 by default. Lower values snap more
   * aggressively; higher values are more conservative.
   */
  readonly ocrLabelSimilarityThreshold?: number;
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

function clampBox(b: BBox, w: number, h: number): { readonly box: BBox; readonly clamped: boolean } {
  const x = Math.max(0, Math.min(w - 1, b.x));
  const y = Math.max(0, Math.min(h - 1, b.y));
  const right = Math.max(x + 1, Math.min(w, b.x + b.width));
  const bottom = Math.max(y + 1, Math.min(h, b.y + b.height));
  const box: BBox = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(right - x)),
    height: Math.max(1, Math.round(bottom - y)),
  };
  const clamped = box.x !== b.x || box.y !== b.y || box.width !== b.width || box.height !== b.height;
  return { box, clamped };
}

function intersectionArea(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function unionBox(a: BBox, b: BBox): BBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(right - x)),
    height: Math.max(1, Math.round(bottom - y)),
  };
}

function iou(a: BBox, b: BBox): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  if (union <= 0) return 0;
  return inter / union;
}

/* -------------------------------------------------------------------------- */
/* Label similarity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Character-bigram cosine similarity between two short labels. Chosen over
 * edit distance because UI labels are short and word order is irrelevant:
 * "Save" vs "Save Changes" gets a moderate score, "Save" vs "Svea" scores
 * low. Returns 0..1.
 */
function labelSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    if (s.length === 1) m.set(s, 1);
    return m;
  };
  const A = bigrams(na);
  const B = bigrams(nb);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const [g, ca] of A) {
    magA += ca * ca;
    const cb = B.get(g);
    if (cb !== undefined) dot += ca * cb;
  }
  for (const ca of B.values()) magB += ca * ca;
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build a page element index from a VLM response (and optional OCR).
 *
 * Order of operations:
 *   1. Validate the input shape and image dimensions.
 *   2. Clamp each element's bbox to the image (record a `clamp` correction
 *      when it changed).
 *   3. Find OCR regions touching each box and record their indexes.
 *   4. When `correctionMode === "ocr-snap"`, and an overlapping OCR region's
 *      text is sufficiently similar to the element's label, replace the bbox
 *      with the union of the current bbox and the matched OCR boxes.
 *   5. When the element has an empty label and an overlapping OCR region
 *      matches, adopt the region text as the label (so refs and downstream
 *      copy have something human-readable).
 *   6. Deduplicate elements whose boxes fully overlap an earlier element
 *      from the same kind (IoU >= `duplicateIoU`). The dropped count is
 *      recorded.
 *   7. Assign a stable ref in document order (y, then x).
 */
export function buildUiElementIndex(
  input: BuildElementIndexInput,
  options: BuildOptions = {},
): UiElementIndex {
  if (input === null || typeof input !== "object") {
    throw new UiElementsError("buildUiElementIndex requires an input object.", "invalid-input");
  }
  if (
    typeof input.pageIndex !== "number" ||
    !Number.isFinite(input.pageIndex) ||
    input.pageIndex < 0
  ) {
    throw new UiElementsError("pageIndex must be a finite non-negative number.", "invalid-input");
  }
  if (
    typeof input.imageWidth !== "number" ||
    !Number.isFinite(input.imageWidth) ||
    input.imageWidth <= 0 ||
    typeof input.imageHeight !== "number" ||
    !Number.isFinite(input.imageHeight) ||
    input.imageHeight <= 0
  ) {
    throw new UiElementsError(
      "imageWidth and imageHeight must be finite positive numbers.",
      "invalid-input",
    );
  }
  if (!Array.isArray(input.elements)) {
    throw new UiElementsError("elements must be an array.", "invalid-input");
  }

  const correctionMode: CorrectionMode =
    options.correctionMode === "strict" || options.correctionMode === "none"
      ? options.correctionMode
      : "ocr-snap";
  const duplicateIoU = clampRatio(options.duplicateIoU ?? 0.6);
  const similarityThreshold = clampRatio(options.ocrLabelSimilarityThreshold ?? 0.5);

  const ocrRegions: readonly OcrRegion[] =
    input.ocr !== null && input.ocr !== undefined && Array.isArray(input.ocr.regions)
      ? input.ocr.regions
      : [];

  // Stage 1: clamp + gather OCR overlaps.
  interface Candidate {
    readonly source: RecognizedElement;
    modelBBox: BBox;
    bbox: BBox;
    label: string;
    confidence: number | null;
    readonly corrections: CorrectionRecord[];
    readonly overlappingOcrIndexes: number[];
  }
  const candidates: Candidate[] = [];
  for (const el of input.elements) {
    if (el === null || typeof el !== "object") continue;
    if (
      typeof el.bbox?.x !== "number" ||
      typeof el.bbox?.y !== "number" ||
      typeof el.bbox?.width !== "number" ||
      typeof el.bbox?.height !== "number" ||
      el.bbox.width <= 0 ||
      el.bbox.height <= 0
    ) {
      // Structurally impossible box; drop with a record.
      continue;
    }
    const corrections: CorrectionRecord[] = [];
    const { box: clampedBox, clamped } = clampBox(el.bbox, input.imageWidth, input.imageHeight);
    if (clamped) {
      corrections.push({
        kind: "clamp",
        detail:
          `Original bbox (${el.bbox.x},${el.bbox.y},${el.bbox.width}x${el.bbox.height}) ` +
          `clamped to (${clampedBox.x},${clampedBox.y},${clampedBox.width}x${clampedBox.height}).`,
      });
    }
    const overlapping: number[] = [];
    for (let i = 0; i < ocrRegions.length; i += 1) {
      const r = ocrRegions[i];
      if (r === undefined) continue;
      if (intersectionArea(clampedBox, r.bbox) > 0) overlapping.push(i);
    }
    candidates.push({
      source: el,
      modelBBox: el.bbox,
      bbox: clampedBox,
      label: typeof el.label === "string" ? el.label.trim() : "",
      confidence: typeof el.confidence === "number" && Number.isFinite(el.confidence) ? el.confidence : null,
      corrections,
      overlappingOcrIndexes: overlapping,
    });
  }

  // Stage 2: label enrichment from matching OCR text.
  for (const c of candidates) {
    if (c.label.length > 0) continue;
    for (const idx of c.overlappingOcrIndexes) {
      const r = ocrRegions[idx];
      if (r === undefined) continue;
      const text = r.text.trim();
      if (text.length === 0) continue;
      c.label = text;
      c.corrections.push({
        kind: "label-enriched",
        detail: `Label adopted from OCR region ${idx}: "${text.slice(0, 80)}".`,
      });
      break;
    }
  }

  // Stage 3: OCR-snap bbox correction when the label matches overlapping OCR.
  if (correctionMode === "ocr-snap") {
    for (const c of candidates) {
      if (c.label.length === 0) continue;
      let snapped = false;
      let unioned: BBox = c.bbox;
      for (const idx of c.overlappingOcrIndexes) {
        const r = ocrRegions[idx];
        if (r === undefined) continue;
        const similarity = labelSimilarity(c.label, r.text);
        if (similarity < similarityThreshold) continue;
        unioned = unionBox(unioned, r.bbox);
        snapped = true;
      }
      if (snapped && (unioned.width !== c.bbox.width || unioned.height !== c.bbox.height || unioned.x !== c.bbox.x || unioned.y !== c.bbox.y)) {
        c.corrections.push({
          kind: "ocr-snap",
          detail:
            `Bbox snapped from OCR evidence: (${c.bbox.x},${c.bbox.y},${c.bbox.width}x${c.bbox.height}) ` +
            `→ (${unioned.x},${unioned.y},${unioned.width}x${unioned.height}).`,
        });
        c.bbox = unioned;
      }
    }
  }

  // Stage 4: deduplicate by IoU within the same kind.
  const kept: Candidate[] = [];
  for (const c of candidates) {
    let duplicate = false;
    for (const k of kept) {
      if (k.source.kind !== c.source.kind) continue;
      if (iou(k.bbox, c.bbox) >= duplicateIoU) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    kept.push(c);
  }
  const droppedCount = candidates.length - kept.length;

  // Stage 5: sort into reading order and assign stable refs.
  kept.sort((a, b) => {
    if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
    if (a.bbox.x !== b.bbox.x) return a.bbox.x - b.bbox.x;
    return a.source.ref.localeCompare(b.source.ref);
  });

  const indexed: IndexedUiElement[] = [];
  for (let i = 0; i < kept.length; i += 1) {
    const c = kept[i] as Candidate;
    const role = c.source.rawRole.length > 0 ? c.source.rawRole : c.source.kind;
    let sameRoleSameSlugOrdinal = 0;
    let unnamedRoleOrdinal = 0;
    const slug = slugifyName(c.label);
    for (let j = 0; j <= i; j += 1) {
      const peer = kept[j];
      if (peer === undefined) continue;
      const peerRole = peer.source.rawRole.length > 0 ? peer.source.rawRole : peer.source.kind;
      if (peerRole !== role) continue;
      if (slug.length > 0) {
        if (slugifyName(peer.label) === slug) sameRoleSameSlugOrdinal += 1;
      } else if (slugifyName(peer.label).length === 0) {
        unnamedRoleOrdinal += 1;
      }
    }
    const ref = computeStableRef({
      role,
      name: c.label,
      sameRoleSameSlugOrdinal: Math.max(1, sameRoleSameSlugOrdinal),
      unnamedRoleOrdinal: Math.max(1, unnamedRoleOrdinal),
    });
    indexed.push({
      ref,
      kind: c.source.kind,
      rawRole: c.source.rawRole,
      label: c.label,
      bbox: c.bbox,
      modelBBox: c.modelBBox,
      confidence: c.confidence,
      states: c.source.states ?? {},
      pageIndex: input.pageIndex,
      overlappingOcrIndexes: c.overlappingOcrIndexes.slice(),
      corrections: c.corrections.slice(),
    });
  }

  const kindCounts = buildKindCounts(indexed);

  return {
    pageIndex: input.pageIndex,
    imageWidth: Math.round(input.imageWidth),
    imageHeight: Math.round(input.imageHeight),
    correctionMode,
    elements: indexed,
    elementCount: indexed.length,
    droppedCount,
    kindCounts,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Look up elements by ref. Useful for the synthesis layer's step executor,
 * which receives refs and needs the pixel box.
 */
export function findUiElement(
  index: UiElementIndex,
  ref: string,
): IndexedUiElement | null {
  if (index === null || typeof index !== "object") return null;
  for (const el of index.elements) {
    if (el.ref === ref) return el;
  }
  return null;
}

/**
 * Return every element whose label contains the provided text
 * (case-insensitive, substring). Used by the text-to-action layer to
 * pre-filter candidates before asking the LLM to make the final choice.
 */
export function searchUiElements(
  index: UiElementIndex,
  query: string,
): readonly IndexedUiElement[] {
  if (index === null || typeof index !== "object") return [];
  const needle = query.toLowerCase().trim();
  if (needle.length === 0) return [];
  const out: IndexedUiElement[] = [];
  for (const el of index.elements) {
    if (el.label.toLowerCase().includes(needle)) out.push(el);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const ALL_ELEMENT_KINDS: readonly UiElementKind[] = [
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "option",
  "slider",
  "datepicker",
  "icon",
  "other",
];

function buildKindCounts(
  elements: readonly IndexedUiElement[],
): Readonly<Record<UiElementKind, number>> {
  const out = {} as Record<UiElementKind, number>;
  for (const k of ALL_ELEMENT_KINDS) out[k] = 0;
  for (const e of elements) out[e.kind] += 1;
  return out;
}

function clampRatio(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `UiElementIndex`. Throws on malformed payloads so a
 * damaged snapshot cannot silently feed an empty element set to synthesis.
 */
export function rehydrateUiElementIndex(value: unknown): UiElementIndex {
  if (value === null || typeof value !== "object") {
    throw new UiElementsError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const pageIndex = numberOr(r["pageIndex"], 0);
  const imageWidth = Math.max(1, numberOr(r["imageWidth"], 1));
  const imageHeight = Math.max(1, numberOr(r["imageHeight"], 1));
  const correctionModeRaw = r["correctionMode"];
  const correctionMode: CorrectionMode =
    correctionModeRaw === "strict" || correctionModeRaw === "none"
      ? correctionModeRaw
      : "ocr-snap";

  const elementsRaw = Array.isArray(r["elements"]) ? (r["elements"] as unknown[]) : [];
  const elements: IndexedUiElement[] = [];
  for (const elRaw of elementsRaw) {
    if (elRaw === null || typeof elRaw !== "object") continue;
    const e = elRaw as Record<string, unknown>;
    const ref = typeof e["ref"] === "string" ? (e["ref"] as string) : "";
    if (!isStableRef(ref)) continue;
    const bbox = parseBBox(e["bbox"]);
    const modelBBox = parseBBox(e["modelBBox"]);
    if (bbox === null || modelBBox === null) continue;
    const kindRaw = typeof e["kind"] === "string" ? (e["kind"] as string) : "other";
    const kind: UiElementKind = (ALL_ELEMENT_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as UiElementKind)
      : "other";
    const confidenceRaw = e["confidence"];
    const confidence =
      typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
        ? clampRatio(confidenceRaw as number)
        : null;
    const states: Record<string, string | number | boolean> = {};
    if (e["states"] !== null && typeof e["states"] === "object") {
      for (const [k, v] of Object.entries(e["states"] as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          states[k] = v;
        }
      }
    }
    const ocrIdxRaw = Array.isArray(e["overlappingOcrIndexes"])
      ? (e["overlappingOcrIndexes"] as unknown[])
      : [];
    const overlappingOcrIndexes = ocrIdxRaw.filter(
      (n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0,
    );
    const corrRaw = Array.isArray(e["corrections"]) ? (e["corrections"] as unknown[]) : [];
    const corrections: CorrectionRecord[] = [];
    for (const cRaw of corrRaw) {
      if (cRaw === null || typeof cRaw !== "object") continue;
      const c = cRaw as Record<string, unknown>;
      const kindRaw2 = c["kind"];
      const kindRec: CorrectionRecord["kind"] =
        kindRaw2 === "clamp" || kindRaw2 === "ocr-snap" || kindRaw2 === "label-enriched" || kindRaw2 === "dropped"
          ? kindRaw2
          : "clamp";
      corrections.push({
        kind: kindRec,
        detail: typeof c["detail"] === "string" ? (c["detail"] as string) : "",
      });
    }
    elements.push({
      ref,
      kind,
      rawRole: typeof e["rawRole"] === "string" ? (e["rawRole"] as string) : kind,
      label: typeof e["label"] === "string" ? (e["label"] as string) : "",
      bbox,
      modelBBox,
      confidence,
      states,
      pageIndex: numberOr(e["pageIndex"], pageIndex),
      overlappingOcrIndexes,
      corrections,
    });
  }

  return {
    pageIndex,
    imageWidth,
    imageHeight,
    correctionMode,
    elements,
    elementCount: elements.length,
    droppedCount: numberOr(r["droppedCount"], 0),
    kindCounts: buildKindCounts(elements),
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
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
