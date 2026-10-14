/**
 * Zipy AI — step-number badges.
 *
 * A numbered badge placed near the target element so the reader can match a
 * step in the text with the element on the screenshot. Three placement
 * strategies are supported because the "correct" corner depends on what else
 * is around the element:
 *
 *  - `auto`        — pick the corner with the most free space against the
 *                    image edges, then against the exclusion rectangles the
 *                    caller supplies (highlights, arrows, other badges).
 *  - `top-left`    — classic placement for wide buttons; the badge floats on
 *                    the upper-left corner.
 *  - `centre-top`  — for narrow controls (links, tabs) where a corner would
 *                    collide with neighbouring elements.
 *
 * What this module is not:
 *  - A highlighter. `highlight.ts` produces the outline; the badge sits
 *    *adjacent*, not on top.
 *  - A placer of prose. The number is the step's ordinal; the string is
 *    produced here but the surrounding copy (step text, alt text) belongs to
 *    a later batch.
 *
 * Design rules honoured:
 *  - Pure. No I/O, no DOM.
 *  - Deterministic. Same inputs → same primitive.
 *  - Bounded. All geometry clamped to image bounds; degenerate inputs (badge
 *    diameter larger than the image) shrink to fit with a note.
 *  - Honest. When no placement can avoid the excluded rectangles, the
 *    placed badge overlaps and records a note naming the overlapping
 *    rectangle; it never silently drops the badge.
 */

import type { BBox } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type BadgeErrorCode = "invalid-input" | "invalid-bbox";

export class BadgeError extends Error {
  readonly code: BadgeErrorCode;
  constructor(message: string, code: BadgeErrorCode) {
    super(message);
    this.name = "BadgeError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const BADGE_PLACEMENTS = [
  "auto",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "centre-top",
] as const;
export type BadgePlacement = (typeof BADGE_PLACEMENTS)[number];

export const BADGE_SHAPES = ["circle", "rounded-square"] as const;
export type BadgeShape = (typeof BADGE_SHAPES)[number];

/* -------------------------------------------------------------------------- */
/* Primitive                                                                   */
/* -------------------------------------------------------------------------- */

export interface Badge {
  readonly type: "badge";
  /** The 1-based step ordinal rendered inside the badge. */
  readonly ordinal: number;
  /** The string the badge displays. Usually the ordinal, but a caller can supply e.g. "5a". */
  readonly label: string;
  readonly shape: BadgeShape;
  /** The badge's own bounding box, image pixels. */
  readonly bbox: BBox;
  /** Diameter for `circle`, or the corner-radius for `rounded-square`. */
  readonly diameter: number;
  readonly cornerRadius: number;
  /** Fill colour. */
  readonly fillColor: string;
  /** Text colour. */
  readonly textColor: string;
  /** Stroke colour; drawn only when `strokeWidth > 0`. */
  readonly strokeColor: string;
  readonly strokeWidth: number;
  /** Font size in pixels for the label. */
  readonly fontSize: number;
  /** Font family string. Defaults to a system stack. */
  readonly fontFamily: string;
  /** 0..1 opacity. */
  readonly opacity: number;
  /** The placement actually used (never `auto`). */
  readonly placement: Exclude<BadgePlacement, "auto">;
  /** Explanation of any adjustment, in order. */
  readonly notes: readonly string[];
}

export interface BuildBadgeOptions {
  /** Placement strategy; default `auto`. */
  readonly placement?: BadgePlacement;
  readonly shape?: BadgeShape;
  /** Badge diameter in pixels. Defaults to 28px. */
  readonly diameter?: number;
  /**
   * Distance between the badge's nearest edge and the element's bbox. Larger
   * values float the badge further out. Default 6px.
   */
  readonly offset?: number;
  readonly fillColor?: string;
  readonly textColor?: string;
  readonly strokeColor?: string;
  readonly strokeWidth?: number;
  readonly fontFamily?: string;
  readonly opacity?: number;
  /**
   * Rectangles the badge should avoid overlapping (highlights, arrow tips,
   * previously placed badges). Auto placement chooses the corner with the
   * least intersection.
   */
  readonly exclusionRects?: readonly BBox[];
  /**
   * When true, a badge that would overlap any exclusion rectangle is emitted
   * anyway with a note. Defaults to true; set to false to make auto placement
   * throw a `BadgeError` when no clear corner exists (rare; usually the
   * designer wants *some* placement).
   */
  readonly allowOverlap?: boolean;
  /**
   * Image bounds for clamping. When omitted, the badge is emitted with a
   * note and no clamping happens against the image (only against exclusions).
   */
  readonly imageWidth?: number;
  readonly imageHeight?: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildBadge(
  ordinal: number,
  targetBBox: BBox,
  options: BuildBadgeOptions = {},
): Badge {
  if (!Number.isFinite(ordinal) || ordinal < 1) {
    throw new BadgeError("ordinal must be a finite number >= 1.", "invalid-input");
  }
  const target = validateBox(targetBBox);

  const notes: string[] = [];
  const shape: BadgeShape = options.shape === "rounded-square" ? "rounded-square" : "circle";
  const requestedDiameter = clampPositive(options.diameter ?? 28, 8);
  const offset = clampNonNegative(options.offset ?? 6);
  const fillColor = normaliseColor(options.fillColor ?? "#dc2626");
  const textColor = normaliseColor(options.textColor ?? "#ffffff");
  const strokeColor = normaliseColor(options.strokeColor ?? "#ffffff");
  const strokeWidth = clampNonNegative(options.strokeWidth ?? 2);
  const opacity = clamp01(options.opacity ?? 1);
  const fontFamily = typeof options.fontFamily === "string" && options.fontFamily.trim().length > 0
    ? options.fontFamily
    : "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const exclusions = Array.isArray(options.exclusionRects) ? options.exclusionRects : [];
  const allowOverlap = options.allowOverlap !== false;

  // The badge diameter may need to shrink if the image is smaller than the
  // requested diameter plus the offset (a 12px-wide image cannot fit a 28px
  // badge). Shrink to fit and record the reason.
  let diameter = requestedDiameter;
  const imageW = positiveOrUndefined(options.imageWidth);
  const imageH = positiveOrUndefined(options.imageHeight);
  if (imageW !== undefined && imageH !== undefined) {
    const maxFit = Math.max(8, Math.floor(Math.min(imageW, imageH) - 4));
    if (diameter > maxFit) {
      notes.push(
        `Badge diameter ${diameter}px shrunk to ${maxFit}px to fit the ${imageW}x${imageH} image.`,
      );
      diameter = maxFit;
    }
  }

  const requestedPlacement: BadgePlacement = options.placement ?? "auto";
  const placement =
    requestedPlacement === "auto"
      ? chooseCorner(target, diameter, offset, exclusions, imageW, imageH)
      : requestedPlacement;

  const rawBBox = badgeRectFor(target, placement, diameter, offset);
  const adjusted = fitInsideImage(rawBBox, imageW, imageH, notes);

  if (requestedPlacement === "auto") {
    const best = chooseCorner(target, diameter, offset, exclusions, imageW, imageH);
    if (best !== placement) {
      notes.push(
        `Requested auto placement; chose "${placement}" after excluding occupied corners.`,
      );
    }
  }

  const overlap = firstOverlap(adjusted, exclusions);
  if (overlap !== null) {
    if (!allowOverlap) {
      throw new BadgeError(
        `No free corner for badge #${ordinal}; every candidate overlaps an exclusion rectangle.`,
        "invalid-input",
      );
    }
    notes.push(
      `Badge overlaps an exclusion rectangle at (${overlap.x},${overlap.y},${overlap.width}x${overlap.height}); no corner was free.`,
    );
  }

  const cornerRadius = shape === "circle" ? Math.floor(diameter / 2) : Math.max(4, Math.floor(diameter / 4));
  const fontSize = Math.max(10, Math.floor(diameter * 0.52));

  return {
    type: "badge",
    ordinal: Math.floor(ordinal),
    label: String(Math.floor(ordinal)),
    shape,
    bbox: adjusted,
    diameter,
    cornerRadius,
    fillColor,
    textColor,
    strokeColor,
    strokeWidth,
    fontSize,
    fontFamily,
    opacity,
    placement,
    notes,
  };
}

/**
 * Allow a caller (the editing layer) to produce a badge with a non-numeric
 * label ("5a", "★"). Preserves the rest of the geometry pipeline.
 */
export function buildLabeledBadge(
  label: string,
  ordinal: number,
  targetBBox: BBox,
  options: BuildBadgeOptions = {},
): Badge {
  const base = buildBadge(ordinal, targetBBox, options);
  return { ...base, label: String(label) };
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

const CANDIDATE_CORNERS: readonly Exclude<BadgePlacement, "auto">[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "centre-top",
];

function chooseCorner(
  target: BBox,
  diameter: number,
  offset: number,
  exclusions: readonly BBox[],
  imageW: number | undefined,
  imageH: number | undefined,
): Exclude<BadgePlacement, "auto"> {
  let best: { readonly placement: Exclude<BadgePlacement, "auto">; readonly overlap: number } | null =
    null;
  for (const placement of CANDIDATE_CORNERS) {
    const rect = badgeRectFor(target, placement, diameter, offset);
    const bounded = clampRectToImage(rect, imageW, imageH);
    let overlapArea = 0;
    for (const ex of exclusions) {
      overlapArea += intersectionArea(bounded, ex);
    }
    // Also prefer corners that are inside the image even if no exclusions
    // were supplied.
    if (
      imageW !== undefined &&
      imageH !== undefined &&
      (bounded.x < 0 || bounded.y < 0 || bounded.x + bounded.width > imageW || bounded.y + bounded.height > imageH)
    ) {
      overlapArea += 1000; // Strong penalty; a partially clipped badge reads badly.
    }
    if (best === null || overlapArea < best.overlap) {
      best = { placement, overlap: overlapArea };
    }
  }
  return best?.placement ?? "top-left";
}

function badgeRectFor(
  target: BBox,
  placement: Exclude<BadgePlacement, "auto">,
  diameter: number,
  offset: number,
): BBox {
  switch (placement) {
    case "top-left":
      return {
        x: target.x - diameter - offset,
        y: target.y - diameter - offset,
        width: diameter,
        height: diameter,
      };
    case "top-right":
      return {
        x: target.x + target.width + offset,
        y: target.y - diameter - offset,
        width: diameter,
        height: diameter,
      };
    case "bottom-left":
      return {
        x: target.x - diameter - offset,
        y: target.y + target.height + offset,
        width: diameter,
        height: diameter,
      };
    case "bottom-right":
      return {
        x: target.x + target.width + offset,
        y: target.y + target.height + offset,
        width: diameter,
        height: diameter,
      };
    case "centre-top":
      return {
        x: target.x + target.width / 2 - diameter / 2,
        y: target.y - diameter - offset,
        width: diameter,
        height: diameter,
      };
  }
}

function fitInsideImage(
  rect: BBox,
  imageW: number | undefined,
  imageH: number | undefined,
  notes: string[],
): BBox {
  const clamped = clampRectToImage(rect, imageW, imageH);
  if (
    Math.round(clamped.x) !== Math.round(rect.x) ||
    Math.round(clamped.y) !== Math.round(rect.y) ||
    Math.round(clamped.width) !== Math.round(rect.width) ||
    Math.round(clamped.height) !== Math.round(rect.height)
  ) {
    notes.push(
      `Badge bbox clamped to image bounds: (${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}) → (${clamped.x},${clamped.y},${clamped.width}x${clamped.height}).`,
    );
  }
  return clamped;
}

function clampRectToImage(
  rect: BBox,
  imageW: number | undefined,
  imageH: number | undefined,
): BBox {
  const rounded = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  if (imageW === undefined || imageH === undefined) return rounded;
  const x = Math.max(0, Math.min(imageW - rounded.width, rounded.x));
  const y = Math.max(0, Math.min(imageH - rounded.height, rounded.y));
  return { x, y, width: rounded.width, height: rounded.height };
}

function intersectionArea(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function firstOverlap(rect: BBox, exclusions: readonly BBox[]): BBox | null {
  for (const ex of exclusions) {
    if (intersectionArea(rect, ex) > 0) return ex;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* SVG rendering                                                               */
/* -------------------------------------------------------------------------- */

export interface RenderBadgeOptions {
  readonly standalone?: boolean;
}

export function renderBadgeSvg(badge: Badge, options: RenderBadgeOptions = {}): string {
  const b = badge.bbox;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const r = badge.diameter / 2;
  const fill = escapeAttr(badge.fillColor);
  const text = escapeAttr(badge.textColor);
  const stroke = escapeAttr(badge.strokeColor);
  const sw = formatNumber(badge.strokeWidth);
  const opacity = formatNumber(badge.opacity);

  const shape = badge.shape === "circle"
    ? `<circle cx="${formatNumber(cx)}" cy="${formatNumber(cy)}" r="${formatNumber(r)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" />`
    : `<rect x="${formatNumber(b.x)}" y="${formatNumber(b.y)}" width="${formatNumber(b.width)}" height="${formatNumber(b.height)}" rx="${badge.cornerRadius}" ry="${badge.cornerRadius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}" />`;

  const label =
    `<text x="${formatNumber(cx)}" y="${formatNumber(cy)}" text-anchor="middle" dominant-baseline="central" fill="${text}" font-family="${escapeAttr(badge.fontFamily)}" font-size="${formatNumber(badge.fontSize)}" font-weight="700" opacity="${opacity}">${escapeText(badge.label)}</text>`;

  return wrapIfStandalone(shape + label, b, options);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function validateBox(b: BBox): BBox {
  if (b === null || typeof b !== "object") {
    throw new BadgeError("buildBadge requires a target BBox.", "invalid-input");
  }
  const nums = [b.x, b.y, b.width, b.height];
  for (const n of nums) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new BadgeError("BBox fields must be finite numbers.", "invalid-bbox");
    }
  }
  if (b.width <= 0 || b.height <= 0) {
    throw new BadgeError("BBox width and height must be positive.", "invalid-bbox");
  }
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function positiveOrUndefined(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return v;
}

function clampPositive(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return v;
}

function clampNonNegative(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

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
  if (typeof value !== "string") return "#dc2626";
  const v = value.trim().toLowerCase();
  if (v.length === 0) return "#dc2626";
  if (/^#[0-9a-f]{3}$/i.test(v)) return v;
  if (/^#[0-9a-f]{4}$/i.test(v)) return v;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{8}$/i.test(v)) return v;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v)) return v;
  if (/^hsla?\(\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?%\s*,\s*\d+(\.\d+)?%\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v)) return v;
  if (NAMED_COLOURS.has(v)) return v;
  return "#dc2626";
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrapIfStandalone(
  fragment: string,
  b: BBox,
  options: RenderBadgeOptions,
): string {
  if (options.standalone !== true) return fragment;
  const vb = `${formatNumber(b.x)} ${formatNumber(b.y)} ${formatNumber(b.width)} ${formatNumber(b.height)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Step badge">${fragment}</svg>`;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateBadge(value: unknown): Badge {
  if (value === null || typeof value !== "object") {
    throw new BadgeError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const ordinal = parseIntOr(r["ordinal"], 1);
  const label = typeof r["label"] === "string" ? (r["label"] as string) : String(ordinal);
  const shapeRaw = r["shape"];
  const shape: BadgeShape = shapeRaw === "rounded-square" ? "rounded-square" : "circle";
  const bbox = parseBBox(r["bbox"]);
  const diameter = clampPositive(numberOr(r["diameter"], 28), 8);
  const cornerRadius = Math.max(0, numberOr(r["cornerRadius"], shape === "circle" ? Math.floor(diameter / 2) : 6));
  const fillColor = normaliseColor(typeof r["fillColor"] === "string" ? (r["fillColor"] as string) : "#dc2626");
  const textColor = normaliseColor(typeof r["textColor"] === "string" ? (r["textColor"] as string) : "#ffffff");
  const strokeColor = normaliseColor(typeof r["strokeColor"] === "string" ? (r["strokeColor"] as string) : "#ffffff");
  const strokeWidth = clampNonNegative(numberOr(r["strokeWidth"], 2));
  const fontSize = clampPositive(numberOr(r["fontSize"], Math.floor(diameter * 0.52)), 8);
  const fontFamily = typeof r["fontFamily"] === "string" && (r["fontFamily"] as string).length > 0
    ? (r["fontFamily"] as string)
    : "system-ui, sans-serif";
  const opacity = clamp01(numberOr(r["opacity"], 1));
  const placementRaw = r["placement"];
  const placement: Exclude<BadgePlacement, "auto"> =
    placementRaw === "top-left" ||
    placementRaw === "top-right" ||
    placementRaw === "bottom-left" ||
    placementRaw === "bottom-right" ||
    placementRaw === "centre-top"
      ? placementRaw
      : "top-left";
  const notes = Array.isArray(r["notes"])
    ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    type: "badge",
    ordinal,
    label,
    shape,
    bbox,
    diameter,
    cornerRadius,
    fillColor,
    textColor,
    strokeColor,
    strokeWidth,
    fontSize,
    fontFamily,
    opacity,
    placement,
    notes,
  };
}

function parseBBox(v: unknown): BBox {
  if (v === null || typeof v !== "object") {
    throw new BadgeError("Rehydrate failed: bbox missing.", "invalid-input");
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
    throw new BadgeError("Rehydrate failed: invalid bbox fields.", "invalid-bbox");
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

function parseIntOr(v: unknown, fallback: number): number {
  const n = numberOr(v, NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  chooseCorner,
  badgeRectFor,
  fitInsideImage,
  clampRectToImage,
  intersectionArea,
  firstOverlap,
  normaliseColor,
  validateBox,
});
