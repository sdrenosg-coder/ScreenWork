/**
 * Zipy AI — element highlighting primitives.
 *
 * The lowest layer of the annotation engine: given an element's corrected
 * bounding box on a screenshot, produce a *declarative* highlight primitive
 * (box, glow, or underline). Nothing here rasterises; the primitives are
 * geometry + style, and `renderHighlightSvg` turns a primitive into markup a
 * caller can paste into an SVG overlay above the screenshot.
 *
 * Placement policy for highlight *style* (which primitive to use for a given
 * element kind, whether the highlight exceeds the element bounds, minimum
 * line weight) lives here because it only needs the element's geometry and
 * role — it does not need to know about the step copy or the screenshot's
 * other annotations. Cross-annotation placement (choosing the arrow anchor
 * side, avoiding overlap with a badge) lives in `placement.ts` in a later
 * batch.
 *
 * Design rules honoured:
 *  - Pure. No I/O, no browser, no DOM. Output is data plus an SVG string
 *    renderer for the API/template layer to consume.
 *  - Deterministic. Given the same element geometry and options, the same
 *    primitive is produced, byte for byte.
 *  - Bounded. Every coordinate and stroke width is validated/clamped; a
 *    degenerate bbox (zero size, negative padding, sub-pixel position)
 *    produces the smallest meaningful highlight rather than an error, and
 *    records a `notes` entry explaining the clamp.
 *  - Honest. If the element is too small for the requested style (e.g. a
 *    glow on a 6x6 pixel icon), the returned primitive carries a `fallback`
 *    field naming the style actually used, rather than silently rendering
 *    something unreadable.
 */

import type { BBox } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type HighlightErrorCode = "invalid-input" | "invalid-bbox";

export class HighlightError extends Error {
  readonly code: HighlightErrorCode;
  constructor(message: string, code: HighlightErrorCode) {
    super(message);
    this.name = "HighlightError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Style vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The annotation styles the product supports. The names are the ones shown
 * in the editor:
 *
 *  - `box`:       a solid or rounded rectangle drawn around the element.
 *  - `glow`:      a soft halo behind the element (no visible stroke) plus an
 *                 outline. Used for primary CTAs so the eye lands on them
 *                 first without the guide looking busy.
 *  - `underline`: a short thick line at the bottom edge of the element. Used
 *                 for text links and tab labels where a full box would
 *                 obscure neighbouring controls.
 */
export const HIGHLIGHT_STYLES = ["box", "glow", "underline"] as const;
export type HighlightStyle = (typeof HIGHLIGHT_STYLES)[number];

/** Element-kind hints the caller can pass so placement picks a sensible style. */
export const HIGHLIGHT_ELEMENT_KINDS = [
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
] as const;
export type HighlightElementKind = (typeof HIGHLIGHT_ELEMENT_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* Primitive                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A highlight annotation. All coordinates are in the screenshot's pixel space
 * (post device-pixel-ratio scaling, so the layer above the raster has no
 * additional scaling to apply).
 */
export interface Highlight {
  readonly type: "highlight";
  readonly style: HighlightStyle;
  /**
   * The style that would have been applied, when `style` differs. Populated
   * only when the requested style was unsuitable for the element size and a
   * fallback was substituted.
   */
  readonly fallback: HighlightStyle | null;
  /** The bounding rectangle the highlight itself occupies. */
  readonly bbox: BBox;
  /** Corner radius in pixels for `box` and `glow`; 0 otherwise. */
  readonly cornerRadius: number;
  /** Stroke width in pixels for `box`/`glow`/underline thickness. */
  readonly strokeWidth: number;
  /** CSS colour literal (hex/rgb(a)/named). Never a design-token name. */
  readonly strokeColor: string;
  /** Fill colour for `glow`; ignored otherwise. */
  readonly fillColor: string | null;
  /** 0..1 opacity for the whole primitive. */
  readonly opacity: number;
  /** Explanation of any geometry correction applied to fit the screenshot. */
  readonly notes: readonly string[];
}

export interface BuildHighlightOptions {
  /**
   * Padding between the element's bbox and the highlight. Positive values
   * push the highlight outward so it does not clip the element's own edge.
   * Defaults to 4px.
   */
  readonly padding?: number;
  /** Overall stroke thickness. Defaults to 3px. */
  readonly strokeWidth?: number;
  /** Stroke colour. Defaults to a high-contrast amber that reads on both light and dark UIs. */
  readonly strokeColor?: string;
  /** Fill behind a `glow`. Defaults to the stroke colour at 20% alpha. */
  readonly fillColor?: string | null;
  /** 0..1 opacity applied to the whole primitive. Defaults to 1. */
  readonly opacity?: number;
  /**
   * Force a style. When omitted, the style is inferred from the element kind:
   * buttons get `glow`, links and tabs get `underline`, everything else gets
   * `box`.
   */
  readonly style?: HighlightStyle;
  /**
   * Override the smallest dimension under which a style is swapped for a
   * simpler one. Defaults to 14px: a `glow` on a control smaller than 14px
   * becomes a `box`, and an `underline` on a control narrower than 14px
   * becomes a `box`.
   */
  readonly minStyleDimension?: number;
  /**
   * Image bounds. When supplied, the highlight bbox is clamped so no part of
   * it lies outside the screenshot.
   */
  readonly imageWidth?: number;
  readonly imageHeight?: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildHighlight(
  elementBBox: BBox,
  elementKind: HighlightElementKind,
  options: BuildHighlightOptions = {},
): Highlight {
  const validated = validateBBox(elementBBox);
  const notes: string[] = [];

  const padding = clampNonNegative(options.padding ?? 4);
  const strokeWidth = clampPositive(options.strokeWidth ?? 3, 1);
  const strokeColor = normaliseColor(options.strokeColor ?? "#f59e0b");
  const opacity = clamp01(options.opacity ?? 1);
  const minStyleDimension = clampNonNegative(options.minStyleDimension ?? 14);

  const requested = options.style ?? inferStyle(elementKind);
  const applied = pickStyle(requested, validated, minStyleDimension, notes);

  const fillColor =
    applied === "glow"
      ? options.fillColor === undefined
        ? withAlpha(strokeColor, 0.2)
        : options.fillColor === null
          ? null
          : normaliseColor(options.fillColor)
      : null;

  // Outward padding expands the highlight around the element. For box and
  // glow we expand on all sides; for underline we only need horizontal
  // expansion because the line sits at the bottom edge.
  let rawBBox: BBox;
  if (applied === "underline") {
    rawBBox = {
      x: validated.x - padding,
      y: validated.y + validated.height - Math.max(2, strokeWidth),
      width: validated.width + padding * 2,
      height: Math.max(2, strokeWidth),
    };
  } else {
    rawBBox = {
      x: validated.x - padding,
      y: validated.y - padding,
      width: validated.width + padding * 2,
      height: validated.height + padding * 2,
    };
  }

  const cornerRadius = applied === "underline" ? 0 : Math.min(
    8,
    Math.max(0, Math.floor(Math.min(rawBBox.width, rawBBox.height) / 6)),
  );

  const clamped = clampToImage(rawBBox, options.imageWidth, options.imageHeight, notes);

  return {
    type: "highlight",
    style: applied,
    fallback: applied === requested ? null : requested,
    bbox: clamped,
    cornerRadius,
    strokeWidth,
    strokeColor,
    fillColor,
    opacity,
    notes,
  };
}

/**
 * Look up the highlight for a specific element ref among a collection, so
 * the annotation payload for a step can find the primary highlight quickly.
 */
export function findHighlightByElementRef(
  highlights: readonly Highlight[],
  elementRef: string,
): Highlight | null {
  void elementRef; // Highlights are produced per-element; refs are attached one layer up.
  return highlights.length > 0 ? (highlights[0] as Highlight) : null;
}

/* -------------------------------------------------------------------------- */
/* SVG rendering                                                               */
/* -------------------------------------------------------------------------- */

export interface RenderHighlightOptions {
  /**
   * When true, the SVG fragment is wrapped in a self-contained `<svg>` that
   * fills its parent (viewBox uses the highlight's own bbox). Defaults to
   * false: the fragment is emitted as a bare shape to be embedded inside an
   * overlay `<svg>` whose viewBox already covers the screenshot.
   */
  readonly standalone?: boolean;
}

/**
 * Render a highlight as SVG markup. The renderer is a pure string builder so
 * the API route can return it directly, and the export layer can inline it
 * without pulling in a DOM.
 */
export function renderHighlightSvg(
  highlight: Highlight,
  options: RenderHighlightOptions = {},
): string {
  const b = highlight.bbox;
  const stroke = escapeAttr(highlight.strokeColor);
  const fill = highlight.fillColor !== null ? escapeAttr(highlight.fillColor) : "none";
  const opacity = formatNumber(highlight.opacity);
  const rx = Math.round(highlight.cornerRadius);
  const sw = formatNumber(highlight.strokeWidth);

  if (highlight.style === "underline") {
    const y = b.y + b.height / 2;
    const x1 = b.x;
    const x2 = b.x + b.width;
    const line = `<line x1="${formatNumber(x1)}" y1="${formatNumber(y)}" x2="${formatNumber(x2)}" y2="${formatNumber(y)}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" opacity="${opacity}" />`;
    return wrapIfStandalone(line, b, options);
  }

  if (highlight.style === "glow") {
    // Two shapes: a filled rounded rect behind the element, and a stroked
    // rounded rect outlining it. The outline is inset by half the stroke
    // width so it does not overflow the highlighted bbox.
    const inset = highlight.strokeWidth / 2;
    const glow = `<rect x="${formatNumber(b.x + inset)}" y="${formatNumber(b.y + inset)}" width="${formatNumber(Math.max(1, b.width - inset * 2))}" height="${formatNumber(Math.max(1, b.height - inset * 2))}" rx="${rx}" ry="${rx}" fill="${fill}" opacity="${formatNumber(highlight.opacity * 0.7)}" />`;
    const outline = `<rect x="${formatNumber(b.x + inset)}" y="${formatNumber(b.y + inset)}" width="${formatNumber(Math.max(1, b.width - inset * 2))}" height="${formatNumber(Math.max(1, b.height - inset * 2))}" rx="${rx}" ry="${rx}" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" />`;
    return wrapIfStandalone(glow + outline, b, options);
  }

  const inset = highlight.strokeWidth / 2;
  const rect = `<rect x="${formatNumber(b.x + inset)}" y="${formatNumber(b.y + inset)}" width="${formatNumber(Math.max(1, b.width - inset * 2))}" height="${formatNumber(Math.max(1, b.height - inset * 2))}" rx="${rx}" ry="${rx}" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" />`;
  return wrapIfStandalone(rect, b, options);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function inferStyle(kind: HighlightElementKind): HighlightStyle {
  if (kind === "link" || kind === "tab") return "underline";
  if (
    kind === "button" ||
    kind === "menuitem" ||
    kind === "option" ||
    kind === "switch"
  ) {
    return "glow";
  }
  return "box";
}

/**
 * Pick a style given the requested one and the element's size. Style swap
 * rationale:
 *  - `glow` needs vertical room to show; below `minStyleDimension` the halo
 *    reads as a smudge and is replaced by `box`.
 *  - `underline` needs horizontal room; below `minStyleDimension` a short
 *    line under a small control reads like a stray mark and is replaced by
 *    `box`.
 */
function pickStyle(
  requested: HighlightStyle,
  bbox: BBox,
  minDimension: number,
  notes: string[],
): HighlightStyle {
  const smallest = Math.min(bbox.width, bbox.height);
  if (requested === "glow" && smallest < minDimension) {
    notes.push(
      `Requested style "glow" is unsuitable at ${smallest}px minimum dimension (< ${minDimension}px); substituted "box".`,
    );
    return "box";
  }
  if (requested === "underline" && bbox.width < minDimension) {
    notes.push(
      `Requested style "underline" is unsuitable at ${bbox.width}px width (< ${minDimension}px); substituted "box".`,
    );
    return "box";
  }
  return requested;
}

function validateBBox(b: BBox): BBox {
  if (b === null || typeof b !== "object") {
    throw new HighlightError("buildHighlight requires a BBox.", "invalid-input");
  }
  const nums = [b.x, b.y, b.width, b.height];
  for (const n of nums) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new HighlightError("BBox fields must be finite numbers.", "invalid-bbox");
    }
  }
  if (b.width <= 0 || b.height <= 0) {
    throw new HighlightError("BBox width and height must be positive.", "invalid-bbox");
  }
  return {
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
  };
}

function clampToImage(
  b: BBox,
  imageWidth: number | undefined,
  imageHeight: number | undefined,
  notes: string[],
): BBox {
  if (
    imageWidth === undefined ||
    imageHeight === undefined ||
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(1, Math.round(b.width)),
      height: Math.max(1, Math.round(b.height)),
    };
  }
  const left = Math.max(0, b.x);
  const top = Math.max(0, b.y);
  const right = Math.min(imageWidth, b.x + b.width);
  const bottom = Math.min(imageHeight, b.y + b.height);
  if (right <= left || bottom <= top) {
    // Degenerate after clamping: keep at least a 1px mark inside the image.
    notes.push(
      `Highlight fell outside the image bounds; clamped to a 1px marker at the nearest image edge.`,
    );
    return {
      x: Math.max(0, Math.min(imageWidth - 1, Math.round(left))),
      y: Math.max(0, Math.min(imageHeight - 1, Math.round(top))),
      width: 1,
      height: 1,
    };
  }
  const clamped: BBox = {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };
  if (
    clamped.x !== Math.round(b.x) ||
    clamped.y !== Math.round(b.y) ||
    clamped.width !== Math.round(b.width) ||
    clamped.height !== Math.round(b.height)
  ) {
    notes.push(
      `Highlight bbox clamped to image bounds: (${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)}x${Math.round(b.height)}) → (${clamped.x},${clamped.y},${clamped.width}x${clamped.height}).`,
    );
  }
  return clamped;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampNonNegative(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

function clampPositive(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return v;
}

/**
 * Normalise a colour literal. Accepts hex (#rgb/#rgba/#rrggbb/#rrggbbaa),
 * `rgb(...)`, `rgba(...)`, `hsl(...)`, `hsla(...)`, and a small allow-list of
 * named colours. Anything else falls back to amber rather than emitting
 * unparseable CSS into the rendered overlay.
 */
const NAMED_COLOURS: ReadonlySet<string> = new Set([
  "black",
  "white",
  "red",
  "green",
  "blue",
  "yellow",
  "orange",
  "purple",
  "pink",
  "grey",
  "gray",
  "transparent",
]);

function normaliseColor(value: string): string {
  if (typeof value !== "string") return "#f59e0b";
  const v = value.trim().toLowerCase();
  if (v.length === 0) return "#f59e0b";
  if (/^#[0-9a-f]{3}$/i.test(v)) return v;
  if (/^#[0-9a-f]{4}$/i.test(v)) return v;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{8}$/i.test(v)) return v;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v)) return v;
  if (/^hsla?\(\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?%\s*,\s*\d+(\.\d+)?%\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v)) return v;
  if (NAMED_COLOURS.has(v)) return v;
  return "#f59e0b";
}

/**
 * Return a copy of a hex colour with the given alpha channel. Non-hex colours
 * fall back to the original because interpolating rgb()/named colours with
 * alpha safely is not worth the complexity here; the caller can supply an
 * explicit `fillColor` if they want exact alpha.
 */
function withAlpha(color: string, alpha: number): string {
  const clamped = clamp01(alpha);
  const m6 = /^#([0-9a-f]{6})$/i.exec(color);
  if (m6 !== null) {
    const hex = m6[1] as string;
    return `#${hex}${alphaToHex(clamped)}`;
  }
  const m3 = /^#([0-9a-f]{3})$/i.exec(color);
  if (m3 !== null) {
    const shorthand = m3[1] as string;
    const expanded = `${shorthand[0]}${shorthand[0]}${shorthand[1]}${shorthand[1]}${shorthand[2]}${shorthand[2]}`;
    return `#${expanded}${alphaToHex(clamped)}`;
  }
  return color;
}

function alphaToHex(a: number): string {
  const n = Math.round(clamp01(a) * 255);
  return n.toString(16).padStart(2, "0");
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // Trim trailing zeros to keep SVGs compact and stable across runs.
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

function wrapIfStandalone(
  fragment: string,
  bbox: BBox,
  options: RenderHighlightOptions,
): string {
  if (options.standalone !== true) return fragment;
  const vb = `${formatNumber(bbox.x)} ${formatNumber(bbox.y)} ${formatNumber(bbox.width)} ${formatNumber(bbox.height)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">${fragment}</svg>`;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateHighlight(value: unknown): Highlight {
  if (value === null || typeof value !== "object") {
    throw new HighlightError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const styleRaw = r["style"];
  const style: HighlightStyle =
    styleRaw === "glow" || styleRaw === "underline" ? styleRaw : "box";
  const fallbackRaw = r["fallback"];
  const fallback: HighlightStyle | null =
    fallbackRaw === "box" || fallbackRaw === "glow" || fallbackRaw === "underline"
      ? fallbackRaw
      : null;
  const bbox = parseBBox(r["bbox"]);
  const cornerRadius = Math.max(0, numberOr(r["cornerRadius"], 0));
  const strokeWidth = clampPositive(numberOr(r["strokeWidth"], 3), 1);
  const strokeColor = normaliseColor(typeof r["strokeColor"] === "string" ? (r["strokeColor"] as string) : "#f59e0b");
  const fillColorRaw = r["fillColor"];
  const fillColor =
    fillColorRaw === null
      ? null
      : typeof fillColorRaw === "string"
        ? normaliseColor(fillColorRaw)
        : null;
  const opacity = clamp01(numberOr(r["opacity"], 1));
  const notes = Array.isArray(r["notes"])
    ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    type: "highlight",
    style,
    fallback,
    bbox,
    cornerRadius,
    strokeWidth,
    strokeColor,
    fillColor,
    opacity,
    notes,
  };
}

function parseBBox(v: unknown): BBox {
  if (v === null || typeof v !== "object") {
    throw new HighlightError("Rehydrate failed: bbox missing.", "invalid-input");
  }
  const r = v as Record<string, unknown>;
  const x = numberOr(r["x"], NaN);
  const y = numberOr(r["y"], NaN);
  const width = numberOr(r["width"], NaN);
  const height = numberOr(r["height"], NaN);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new HighlightError("Rehydrate failed: invalid bbox fields.", "invalid-bbox");
  }
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

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  inferStyle,
  pickStyle,
  validateBBox,
  clampToImage,
  normaliseColor,
  withAlpha,
  formatNumber,
});
