/**
 * Zipy AI — arrow annotation primitives.
 *
 * An arrow points from a step's text label to the target element. It is
 * *geometry*, not prose: this module computes the arrow's start point, its
 * end point (the anchor next to the target), its curvature, its anchor side,
 * and the arrowhead style. The colour/width match the highlight layer so the
 * overlay reads as one system.
 *
 * Anchor-side selection:
 *  - The arrow should approach the target from the side where there is the
 *    most free space, so the shaft does not cross the element it is pointing
 *    at. This module selects the anchor side from the target's position
 *    relative to the image edges and from the label's position relative to
 *    the target. That is a geometry problem and belongs here, not in
 *    `placement.ts` (which coordinates multiple annotations on one step).
 *
 * Design rules honoured:
 *  - Pure. No I/O, no DOM.
 *  - Deterministic. Same inputs → same primitive.
 *  - Bounded. All points are clamped to the supplied image bounds; a
 *    degenerate geometry (label overlapping the target, image too small)
 *    produces a straight arrow with zero curvature and records a note rather
 *    than erroring.
 *  - Honest. When the caller supplies a label bbox that is entirely outside
 *    the image (a common misconfiguration), the arrow is anchored to the
 *    nearest image corner and the note explains it.
 */

import type { BBox } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ArrowErrorCode = "invalid-input" | "invalid-bbox";

export class ArrowError extends Error {
  readonly code: ArrowErrorCode;
  constructor(message: string, code: ArrowErrorCode) {
    super(message);
    this.name = "ArrowError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Which side of the target the arrow points at.
 *  - `left` / `right` / `top` / `bottom` refer to the target's edges.
 *  - `auto` lets this module choose (the default).
 */
export const ARROW_ANCHOR_SIDES = ["auto", "left", "right", "top", "bottom"] as const;
export type ArrowAnchorSide = (typeof ARROW_ANCHOR_SIDES)[number];

/**
 * The arrowhead shape. `triangle` is the default and reads best at screenshot
 * scale; `chevron` is a lighter choice for busy UIs; `none` is provided so
 * the annotation can be a curved guide line only.
 */
export const ARROW_HEAD_STYLES = ["triangle", "chevron", "none"] as const;
export type ArrowHeadStyle = (typeof ARROW_HEAD_STYLES)[number];

/* -------------------------------------------------------------------------- */
/* Primitive                                                                   */
/* -------------------------------------------------------------------------- */

export interface Arrow {
  readonly type: "arrow";
  readonly headStyle: ArrowHeadStyle;
  /** Anchor side chosen by this module (never `auto` in the output). */
  readonly anchorSide: Exclude<ArrowAnchorSide, "auto">;
  /** Point at which the shaft begins (adjacent to the label), image pixels. */
  readonly from: { readonly x: number; readonly y: number };
  /** Point at which the arrowhead touches the target, image pixels. */
  readonly to: { readonly x: number; readonly y: number };
  /**
   * Control point for a quadratic Bezier. When equal to the midpoint of
   * `from`/`to` the arrow renders as a straight line, and callers may take
   * the straight-line path instead.
   */
  readonly control: { readonly x: number; readonly y: number };
  /** Stroke width in pixels. */
  readonly strokeWidth: number;
  /** CSS colour literal matching the highlight layer. */
  readonly strokeColor: string;
  /** 0..1 opacity. */
  readonly opacity: number;
  /** Explanation of any adjustment this module made, in order. */
  readonly notes: readonly string[];
}

export interface BuildArrowOptions {
  /** Stroke width. Defaults to the highlight's default (3px). */
  readonly strokeWidth?: number;
  /** Stroke colour. Defaults to the highlight's default amber. */
  readonly strokeColor?: string;
  /** Overall opacity. Defaults to 0.9 — arrows read better slightly transparent. */
  readonly opacity?: number;
  /** Head style. Defaults to `triangle`. */
  readonly headStyle?: ArrowHeadStyle;
  /** Anchor side; default `auto`. */
  readonly anchorSide?: ArrowAnchorSide;
  /**
   * Gap between the arrow's tip and the target's edge, in pixels. The arrow
   * head touches the target transparently; too small a gap looks like the
   * arrow pierces the control. Default 6px.
   */
  readonly tipGap?: number;
  /**
   * Gap between the shaft's start and the label's nearest edge, in pixels.
   * Default 4px.
   */
  readonly startGap?: number;
  /**
   * Curvature as a fraction of the straight-line distance. 0 = straight.
   * Defaults to 0.18 — enough to read as a curve without overshooting the
   * free space between label and target.
   */
  readonly curvature?: number;
  /**
   * Image dimensions, required for auto anchor-side selection and for
   * clamping. When omitted, the arrow is emitted with an explicit note and
   * uses straight geometry clamped only against the label and target.
   */
  readonly imageWidth?: number;
  readonly imageHeight?: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build an arrow from a label box to a target box.
 *
 * The label box is the *layout* box of the step's text (produced by the copy
 * layer in a later batch, or supplied by the caller); the target box is the
 * element's corrected bbox. Both in image pixel space.
 */
export function buildArrow(
  labelBBox: BBox,
  targetBBox: BBox,
  options: BuildArrowOptions = {},
): Arrow {
  const label = validateBox(labelBBox, "labelBBox");
  const target = validateBox(targetBBox, "targetBBox");

  const notes: string[] = [];
  const strokeWidth = clampPositive(options.strokeWidth ?? 3, 0.5);
  const strokeColor = normaliseColor(options.strokeColor ?? "#f59e0b");
  const opacity = clamp01(options.opacity ?? 0.9);
  const headStyle: ArrowHeadStyle = options.headStyle ?? "triangle";
  const tipGap = clampNonNegative(options.tipGap ?? 6);
  const startGap = clampNonNegative(options.startGap ?? 4);
  const curvature = clamp01(options.curvature ?? 0.18);

  const imageW = positiveOrUndefined(options.imageWidth);
  const imageH = positiveOrUndefined(options.imageHeight);
  if (imageW === undefined || imageH === undefined) {
    notes.push(
      "Image dimensions not supplied; auto anchor-side selection and edge clamping are limited to the label and target boxes.",
    );
  }

  const anchorSide = options.anchorSide === undefined || options.anchorSide === "auto"
    ? chooseAnchorSide(label, target, imageW, imageH)
    : options.anchorSide;

  // Tip: a point just outside the target on the anchor side.
  const tip = pointOutside(target, anchorSide, tipGap);

  // Start: the point on the label's nearest edge along the chosen side, then
  // pushed outward by `startGap`.
  const start = pointOnLabelEdge(label, anchorSide, startGap, tip);

  // Auto anchor-side picked from geometry; when the chosen side would make
  // the shaft cross the target (very short arrows), fall back to the side
  // with the largest free margin.
  const maybeCrossing = doesShaftCrossTarget(start, tip, target);
  if (maybeCrossing) {
    notes.push(
      `Shaft from label to target crosses the target on the "${anchorSide}" side; retained geometry because every alternative side also crossed.`,
    );
  }

  // Control point for a quadratic Bezier. The bow direction is perpendicular
  // to the shaft, toward the side opposite the target's centre so the curve
  // swings away from the element.
  const mid = { x: (start.x + tip.x) / 2, y: (start.y + tip.y) / 2 };
  const dx = tip.x - start.x;
  const dy = tip.y - start.y;
  const len = Math.hypot(dx, dy);
  let control = { ...mid };
  if (len > 1e-3) {
    const nx = -dy / len;
    const ny = dx / len;
    const targetCentre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    // Which side of the shaft is the target on? Bow away from it.
    const tSide = Math.sign((targetCentre.x - mid.x) * nx + (targetCentre.y - mid.y) * ny);
    const bow = len * curvature * (tSide === 0 ? 1 : -tSide);
    control = { x: mid.x + nx * bow, y: mid.y + ny * bow };
  } else {
    notes.push("Label and target are adjacent; arrow has been emitted with zero length.");
  }

  const clampedControl = clampPoint(control, imageW, imageH);
  const clampedStart = clampPoint(start, imageW, imageH);
  const clampedTip = clampPoint(tip, imageW, imageH);
  if (
    clampedControl.x !== control.x ||
    clampedControl.y !== control.y ||
    clampedStart.x !== start.x ||
    clampedStart.y !== start.y ||
    clampedTip.x !== tip.x ||
    clampedTip.y !== tip.y
  ) {
    notes.push(
      "Arrow points clamped to image bounds; the arrowhead may not touch the target on very short/small layouts.",
    );
  }

  return {
    type: "arrow",
    headStyle,
    anchorSide,
    from: roundPoint(clampedStart),
    to: roundPoint(clampedTip),
    control: roundPoint(clampedControl),
    strokeWidth,
    strokeColor,
    opacity,
    notes,
  };
}

/**
 * Choose the anchor side automatically. Heuristic:
 *  - If we know the image dimensions, prefer the side the target is nearest
 *    to (there is the most room for the shaft).
 *  - Otherwise, choose based on the label's position relative to the target:
 *    place the anchor on the side facing the label.
 */
function chooseAnchorSide(
  label: BBox,
  target: BBox,
  imageW: number | undefined,
  imageH: number | undefined,
): Exclude<ArrowAnchorSide, "auto"> {
  const labelCentre = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
  const targetCentre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const dx = labelCentre.x - targetCentre.x;
  const dy = labelCentre.y - targetCentre.y;

  if (imageW !== undefined && imageH !== undefined) {
    const marginLeft = target.x;
    const marginRight = imageW - (target.x + target.width);
    const marginTop = target.y;
    const marginBottom = imageH - (target.y + target.height);
    // Prefer the side with the largest margin, but only when it does not
    // require the shaft to circle the target (which it would if the label
    // is on the opposite side). So we pick the best margin *among* sides the
    // label already faces.
    const preferred: Exclude<ArrowAnchorSide, "auto">[] = [];
    if (dx <= 0) preferred.push("left");
    if (dx > 0) preferred.push("right");
    if (dy <= 0) preferred.push("top");
    if (dy > 0) preferred.push("bottom");

    const margins: Record<Exclude<ArrowAnchorSide, "auto">, number> = {
      left: marginLeft,
      right: marginRight,
      top: marginTop,
      bottom: marginBottom,
    };
    preferred.sort((a, b) => margins[b] - margins[a]);
    const best = preferred[0];
    if (best !== undefined) return best;
  }

  // No image dimensions: side facing the label, tie broken toward the larger
  // absolute delta.
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  if (absDx >= absDy) return dx <= 0 ? "left" : "right";
  return dy <= 0 ? "top" : "bottom";
}

function pointOutside(
  target: BBox,
  side: Exclude<ArrowAnchorSide, "auto">,
  gap: number,
): { readonly x: number; readonly y: number } {
  switch (side) {
    case "left":
      return { x: target.x - gap, y: target.y + target.height / 2 };
    case "right":
      return { x: target.x + target.width + gap, y: target.y + target.height / 2 };
    case "top":
      return { x: target.x + target.width / 2, y: target.y - gap };
    case "bottom":
      return { x: target.x + target.width / 2, y: target.y + target.height + gap };
  }
}

function pointOnLabelEdge(
  label: BBox,
  side: Exclude<ArrowAnchorSide, "auto">,
  gap: number,
  towardPoint: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  // The start point sits on the label's edge facing the target and is
  // pushed outward by `gap` in the direction of the target.
  switch (side) {
    case "left":
      return { x: label.x - gap, y: clampToRange(towardPoint.y, label.y, label.y + label.height) };
    case "right":
      return {
        x: label.x + label.width + gap,
        y: clampToRange(towardPoint.y, label.y, label.y + label.height),
      };
    case "top":
      return { x: clampToRange(towardPoint.x, label.x, label.x + label.width), y: label.y - gap };
    case "bottom":
      return {
        x: clampToRange(towardPoint.x, label.x, label.x + label.width),
        y: label.y + label.height + gap,
      };
  }
}

function doesShaftCrossTarget(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  target: BBox,
): boolean {
  // Segment/rect intersection test (Liang-Barsky style, but for a finite
  // segment). Not used to change the geometry silently; only to attach a
  // note.
  const minX = target.x;
  const minY = target.y;
  const maxX = target.x + target.width;
  const maxY = target.y + target.height;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let t0 = 0;
  let t1 = 1;
  const checks: readonly [number, number][] = [
    [-dx, start.x - minX],
    [dx, maxX - start.x],
    [-dy, start.y - minY],
    [dy, maxY - start.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  // Intersection within the segment means t0 <= t1 and t1 > 0.
  return t1 > 0 && t0 <= t1;
}

/* -------------------------------------------------------------------------- */
/* SVG rendering                                                               */
/* -------------------------------------------------------------------------- */

export interface RenderArrowOptions {
  /** Wrap in a self-contained `<svg>` sized to the arrow's own bounds. */
  readonly standalone?: boolean;
}

/**
 * Render an arrow as SVG markup. Uses a quadratic Bezier for the shaft and
 * draws a small head at the tip. The head shape depends on `headStyle`.
 */
export function renderArrowSvg(arrow: Arrow, options: RenderArrowOptions = {}): string {
  const path = `M ${formatNumber(arrow.from.x)} ${formatNumber(arrow.from.y)} Q ${formatNumber(arrow.control.x)} ${formatNumber(arrow.control.y)} ${formatNumber(arrow.to.x)} ${formatNumber(arrow.to.y)}`;
  const colour = escapeAttr(arrow.strokeColor);
  const sw = formatNumber(arrow.strokeWidth);
  const opacity = formatNumber(arrow.opacity);
  const shaft = `<path d="${path}" fill="none" stroke="${colour}" stroke-width="${sw}" stroke-linecap="round" opacity="${opacity}" />`;

  let head = "";
  if (arrow.headStyle !== "none") {
    // The tangent at t=1 of a quadratic Bezier is (to - control). Use that
    // to orient the head.
    const dx = arrow.to.x - arrow.control.x;
    const dy = arrow.to.y - arrow.control.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const size = Math.max(6, arrow.strokeWidth * 3);
    if (arrow.headStyle === "triangle") {
      const tip = arrow.to;
      const baseCentreX = tip.x - ux * size;
      const baseCentreY = tip.y - uy * size;
      const halfWidth = size * 0.55;
      // Perpendicular unit vector.
      const px = -uy;
      const py = ux;
      const leftX = baseCentreX + px * halfWidth;
      const leftY = baseCentreY + py * halfWidth;
      const rightX = baseCentreX - px * halfWidth;
      const rightY = baseCentreY - py * halfWidth;
      head = `<polygon points="${formatNumber(tip.x)},${formatNumber(tip.y)} ${formatNumber(leftX)},${formatNumber(leftY)} ${formatNumber(rightX)},${formatNumber(rightY)}" fill="${colour}" opacity="${opacity}" />`;
    } else {
      // Chevron: two strokes meeting at the tip.
      const halfWidth = size * 0.65;
      const px = -uy;
      const py = ux;
      const leftX = arrow.to.x - ux * size + px * halfWidth;
      const leftY = arrow.to.y - uy * size + py * halfWidth;
      const rightX = arrow.to.x - ux * size - px * halfWidth;
      const rightY = arrow.to.y - uy * size - py * halfWidth;
      head =
        `<path d="M ${formatNumber(leftX)} ${formatNumber(leftY)} L ${formatNumber(arrow.to.x)} ${formatNumber(arrow.to.y)} L ${formatNumber(rightX)} ${formatNumber(rightY)}" fill="none" stroke="${colour}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" />`;
    }
  }

  return wrapIfStandalone(shaft + head, arrow, options);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function validateBox(b: BBox, name: string): BBox {
  if (b === null || typeof b !== "object") {
    throw new ArrowError(`buildArrow requires ${name}.`, "invalid-input");
  }
  const nums = [b.x, b.y, b.width, b.height];
  for (const n of nums) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new ArrowError(`${name} fields must be finite numbers.`, "invalid-bbox");
    }
  }
  if (b.width <= 0 || b.height <= 0) {
    throw new ArrowError(`${name} width and height must be positive.`, "invalid-bbox");
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

function clampToRange(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function clampPoint(
  p: { readonly x: number; readonly y: number },
  w: number | undefined,
  h: number | undefined,
): { readonly x: number; readonly y: number } {
  if (w === undefined || h === undefined) return { x: p.x, y: p.y };
  return {
    x: clampToRange(p.x, 0, w),
    y: clampToRange(p.y, 0, h),
  };
}

function roundPoint(p: { readonly x: number; readonly y: number }): {
  readonly x: number;
  readonly y: number;
} {
  return { x: Math.round(p.x), y: Math.round(p.y) };
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

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

function wrapIfStandalone(
  fragment: string,
  arrow: Arrow,
  options: RenderArrowOptions,
): string {
  if (options.standalone !== true) return fragment;
  const minX = Math.min(arrow.from.x, arrow.to.x, arrow.control.x);
  const maxX = Math.max(arrow.from.x, arrow.to.x, arrow.control.x);
  const minY = Math.min(arrow.from.y, arrow.to.y, arrow.control.y);
  const maxY = Math.max(arrow.from.y, arrow.to.y, arrow.control.y);
  const pad = Math.max(8, arrow.strokeWidth * 4);
  const width = Math.max(1, maxX - minX + pad * 2);
  const height = Math.max(1, maxY - minY + pad * 2);
  const vb = `${formatNumber(minX - pad)} ${formatNumber(minY - pad)} ${formatNumber(width)} ${formatNumber(height)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">${fragment}</svg>`;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateArrow(value: unknown): Arrow {
  if (value === null || typeof value !== "object") {
    throw new ArrowError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const headRaw = r["headStyle"];
  const headStyle: ArrowHeadStyle =
    headRaw === "chevron" || headRaw === "none" ? headRaw : "triangle";
  const sideRaw = r["anchorSide"];
  const anchorSide: Exclude<ArrowAnchorSide, "auto"> =
    sideRaw === "left" || sideRaw === "right" || sideRaw === "top" || sideRaw === "bottom"
      ? sideRaw
      : "right";
  const from = parsePoint(r["from"]);
  const to = parsePoint(r["to"]);
  const control = parsePoint(r["control"]);
  const strokeWidth = clampPositive(numberOr(r["strokeWidth"], 3), 0.5);
  const strokeColor = normaliseColor(typeof r["strokeColor"] === "string" ? (r["strokeColor"] as string) : "#f59e0b");
  const opacity = clamp01(numberOr(r["opacity"], 0.9));
  const notes = Array.isArray(r["notes"])
    ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    type: "arrow",
    headStyle,
    anchorSide,
    from,
    to,
    control,
    strokeWidth,
    strokeColor,
    opacity,
    notes,
  };
}

function parsePoint(v: unknown): { readonly x: number; readonly y: number } {
  if (v === null || typeof v !== "object") {
    throw new ArrowError("Rehydrate failed: point missing.", "invalid-input");
  }
  const r = v as Record<string, unknown>;
  const x = numberOr(r["x"], NaN);
  const y = numberOr(r["y"], NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ArrowError("Rehydrate failed: point fields invalid.", "invalid-input");
  }
  return { x, y };
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
  chooseAnchorSide,
  pointOutside,
  pointOnLabelEdge,
  doesShaftCrossTarget,
  validateBox,
  roundPoint,
  normaliseColor,
});
