/**
 * Zipy AI — magnified inset ("callout bubble") for small UI elements.
 *
 * When a step targets an element whose smallest dimension is below the
 * legibility threshold (typically 40px), the surrounding screenshot cannot
 * show the element's label and shape clearly. The inset is a magnified copy
 * of a small crop around the target, placed in a free corner of the
 * screenshot, connected to the target by a thin guide line.
 *
 * This module produces the *geometry*: crop rectangle on the source image,
 * bubble rectangle on the page, magnification factor, the guide line's
 * endpoints, and the styling. It does not perform the actual pixel copy —
 * that is done by the image pipeline, which reads `cropBBox` and composites
 * the magnified result into `bubbleBBox`. Keeping the primitive geometric
 * means this module stays pure and testable.
 *
 * What this module is NOT:
 *  - A renderer of pixel data. `renderInsetSvg` emits the bubble's frame,
 *    drop shadow and guide line as SVG. The magnified content itself is
 *    injected by the image pipeline as an `<image>` element with a matching
 *    `viewBox` (see `renderInsetSvg`'s `contentHref` option).
 *  - A placement coordinator. Which corner the bubble lands in when the
 *    caller asks for `"auto"` is a local decision (based on the target's
 *    position); cross-annotation coordination lives in `placement.ts`.
 *
 * Design rules honoured:
 *  - Pure. No I/O, no DOM, no canvas.
 *  - Deterministic. Same inputs → same primitive.
 *  - Bounded. The bubble is clamped to the image; the crop is inset into the
 *    image so it never reads past the edge; the magnification is clamped to
 *    [1.5, 4]. When the image is too small for a separate bubble, the module
 *    throws `InsetError` with `image-too-small` so the coordinator can drop
 *    the inset and note it.
 *  - Honest. When the requested corner overlaps the target (very common when
 *    the target is near an edge), an alternative corner is chosen and the
 *    reason is recorded in `notes`.
 */

import type { BBox } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type InsetErrorCode = "invalid-input" | "invalid-bbox" | "image-too-small";

export class InsetError extends Error {
  readonly code: InsetErrorCode;
  constructor(message: string, code: InsetErrorCode) {
    super(message);
    this.name = "InsetError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const INSET_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type InsetCorner = (typeof INSET_CORNERS)[number];

export const INSET_FRAME_STYLES = ["rounded", "square"] as const;
export type InsetFrameStyle = (typeof INSET_FRAME_STYLES)[number];

/* -------------------------------------------------------------------------- */
/* Primitive                                                                   */
/* -------------------------------------------------------------------------- */

export interface Inset {
  readonly type: "inset";
  /** The rectangle on the source image to magnify (image pixel space). */
  readonly cropBBox: BBox;
  /** The rectangle on the page where the magnified copy is placed. */
  readonly bubbleBBox: BBox;
  /** Magnification factor applied to `cropBBox` to fill `bubbleBBox`. Clamped to [1.5, 4]. */
  readonly magnification: number;
  /** Corner the bubble is placed in (never `auto`). */
  readonly corner: InsetCorner;
  readonly frameStyle: InsetFrameStyle;
  /** Corner radius for the frame; 0 when `frameStyle === "square"`. */
  readonly cornerRadius: number;
  readonly frameColor: string;
  readonly frameWidth: number;
  /** 0..1; applied to the frame only, not the magnified content. */
  readonly frameOpacity: number;
  /** Drop shadow colour; set to `null` to disable. */
  readonly shadowColor: string | null;
  /** Guide line from the bubble to the target's nearest corner. */
  readonly guide: {
    readonly from: { readonly x: number; readonly y: number };
    readonly to: { readonly x: number; readonly y: number };
    readonly strokeColor: string;
    readonly strokeWidth: number;
    readonly dashArray: string;
    readonly opacity: number;
  };
  /** Explanation of any adjustment, in order. */
  readonly notes: readonly string[];
}

export interface BuildInsetOptions {
  /** Image width in pixels; required. */
  readonly imageWidth: number;
  /** Image height in pixels; required. */
  readonly imageHeight: number;
  /**
   * Requested corner. `"auto"` or omitted places the bubble in the corner
   * farthest from the target's centre.
   */
  readonly corner?: InsetCorner | "auto";
  /**
   * Magnification factor. Values below 1.5 are lifted to 1.5 (the floor at
   * which small text is legible at 2x device scale); values above 4 are
   * capped (further magnification produces blur without additional legibility).
   * Default: 2.5.
   */
  readonly magnification?: number;
  /**
   * Bubble width as a fraction of image width. Default 0.22 — a bubble that
   * occupies roughly a fifth of the width reads clearly without dominating
   * the screenshot.
   */
  readonly sizeFraction?: number;
  /** Frame style; default `rounded`. */
  readonly frameStyle?: InsetFrameStyle;
  readonly frameColor?: string;
  readonly frameWidth?: number;
  readonly frameOpacity?: number;
  readonly shadowColor?: string | null;
  readonly guideStrokeColor?: string;
  readonly guideStrokeWidth?: number;
  readonly guideDashArray?: string;
  readonly guideOpacity?: number;
  /**
   * Distance between the bubble's nearest edge and the image edge. Default
   * 16px.
   */
  readonly margin?: number;
  /**
   * Extra padding added to the crop rectangle around the target so the
   * magnified result shows some surrounding context. Default 6px at the
   * *source* scale.
   */
  readonly cropPadding?: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildInset(targetBBox: BBox, options: BuildInsetOptions): Inset {
  const target = validateBox(targetBBox, "targetBBox");
  if (
    !Number.isFinite(options.imageWidth) ||
    options.imageWidth <= 0 ||
    !Number.isFinite(options.imageHeight) ||
    options.imageHeight <= 0
  ) {
    throw new InsetError(
      "imageWidth and imageHeight must be positive finite numbers.",
      "invalid-input",
    );
  }

  const imageW = options.imageWidth;
  const imageH = options.imageHeight;
  const notes: string[] = [];

  const sizeFraction = clamp01(options.sizeFraction ?? 0.22);
  const margin = clampNonNegative(options.margin ?? 16);
  const cropPadding = clampNonNegative(options.cropPadding ?? 6);
  const frameStyle: InsetFrameStyle = options.frameStyle === "square" ? "square" : "rounded";
  const frameColor = normaliseColor(options.frameColor ?? "#0f172a");
  const frameWidth = clampPositive(options.frameWidth ?? 2, 0.5);
  const frameOpacity = clamp01(options.frameOpacity ?? 1);
  const shadowColor =
    options.shadowColor === null
      ? null
      : options.shadowColor === undefined
        ? "rgba(15,23,42,0.35)"
        : normaliseColor(options.shadowColor);
  const guideStrokeColor = normaliseColor(options.guideStrokeColor ?? "#f59e0b");
  const guideStrokeWidth = clampPositive(options.guideStrokeWidth ?? 1.5, 0.5);
  const guideDashArray = typeof options.guideDashArray === "string" ? options.guideDashArray : "4 4";
  const guideOpacity = clamp01(options.guideOpacity ?? 0.85);

  // Bubble size: fraction of the image, but bounded so very wide/short images
  // do not produce a bubble taller than the image allows.
  let bubbleW = Math.max(64, Math.round(imageW * sizeFraction));
  let bubbleH = Math.max(64, Math.round(imageH * sizeFraction));
  // Cap the bubble at half the image in either dimension.
  const maxW = Math.floor(imageW * 0.5);
  const maxH = Math.floor(imageH * 0.5);
  if (bubbleW > maxW) {
    notes.push(
      `Bubble width ${bubbleW}px capped at ${maxW}px (half the image width).`,
    );
    bubbleW = maxW;
  }
  if (bubbleH > maxH) {
    notes.push(
      `Bubble height ${bubbleH}px capped at ${maxH}px (half the image height).`,
    );
    bubbleH = maxH;
  }
  if (bubbleW < 32 || bubbleH < 32) {
    throw new InsetError(
      `Image is too small for a magnified inset (bubble would be ${bubbleW}x${bubbleH}).`,
      "image-too-small",
    );
  }

  // Crop rectangle around the target + padding, clamped to the image.
  const crop = clampBoxToImage(
    {
      x: target.x - cropPadding,
      y: target.y - cropPadding,
      width: target.width + cropPadding * 2,
      height: target.height + cropPadding * 2,
    },
    imageW,
    imageH,
  );
  if (crop.width !== target.width + cropPadding * 2 || crop.height !== target.height + cropPadding * 2) {
    notes.push(
      "Crop rectangle was trimmed to keep the magnified content inside the image bounds.",
    );
  }

  // Corner selection.
  const requestedCorner: InsetCorner | "auto" = options.corner ?? "auto";
  const corner =
    requestedCorner === "auto" ? chooseCorner(target, imageW, imageH) : requestedCorner;

  let bubble = bubbleRectFor(corner, imageW, imageH, bubbleW, bubbleH, margin);
  // If the chosen bubble overlaps the target, pick the farthest corner.
  if (rectsOverlap(bubble, expandBox(target, 8))) {
    const alternative = farthestCornerFrom(target, imageW, imageH);
    if (alternative !== corner) {
      notes.push(
        `Bubble placed in "${corner}" would overlap the target; moved to "${alternative}".`,
      );
      bubble = bubbleRectFor(alternative, imageW, imageH, bubbleW, bubbleH, margin);
    }
  }

  // Magnification: the ratio of the bubble's smaller side to the crop's
  // smaller side, clamped to [1.5, 4]. Using the smaller side (not area)
  // keeps the ratio consistent with what a reader perceives as "magnified".
  const cropSmall = Math.max(1, Math.min(crop.width, crop.height));
  const bubbleSmall = Math.min(bubble.width, bubble.height);
  const requestedMag = clampRange(options.magnification ?? 2.5, 1.5, 4);
  const ratioMag = clampRange(bubbleSmall / cropSmall, 1.5, 4);
  const magnification = roundTo2(requestedMag < ratioMag ? requestedMag : ratioMag);
  if (Math.abs(requestedMag - magnification) > 0.01) {
    notes.push(
      `Magnification adjusted from ${requestedMag}× to ${magnification}× to fit the crop (${crop.width}x${crop.height}) into the bubble (${bubble.width}x${bubble.height}).`,
    );
  }

  // Guide line: shortest edge-to-edge line between the bubble and the target.
  const guide = closestGuideLine(bubble, target, {
    strokeColor: guideStrokeColor,
    strokeWidth: guideStrokeWidth,
    dashArray: guideDashArray,
    opacity: guideOpacity,
  });

  const frameCornerRadius =
    frameStyle === "square" ? 0 : Math.min(16, Math.floor(Math.min(bubble.width, bubble.height) / 8));

  return {
    type: "inset",
    cropBBox: {
      x: Math.round(crop.x),
      y: Math.round(crop.y),
      width: Math.max(1, Math.round(crop.width)),
      height: Math.max(1, Math.round(crop.height)),
    },
    bubbleBBox: {
      x: Math.round(bubble.x),
      y: Math.round(bubble.y),
      width: Math.max(1, Math.round(bubble.width)),
      height: Math.max(1, Math.round(bubble.height)),
    },
    magnification,
    corner: cornerForBubble(bubble, imageW, imageH, margin),
    frameStyle,
    cornerRadius: frameCornerRadius,
    frameColor,
    frameWidth,
    frameOpacity,
    shadowColor,
    guide,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* SVG rendering                                                               */
/* -------------------------------------------------------------------------- */

export interface RenderInsetOptions {
  /**
   * When provided, an `<image>` element is placed inside the bubble with this
   * `href` and a `<viewBox>` matching the crop rectangle. The magnified
   * content is expected to be a data URI or a URL the renderer is allowed to
   * fetch (which the export pipeline usually resolves to a data URI before
   * handing the SVG to a PDF renderer).
   */
  readonly contentHref?: string;
  /**
   * Wrap in a self-contained `<svg>` sized to the image. Requires the caller
   * to know the image dimensions; this is derived from `bubbleBBox` and the
   * guide when the caller does not supply them.
   */
  readonly standalone?: boolean;
  /** Image dimensions for standalone wrapping. Optional. */
  readonly imageWidth?: number;
  readonly imageHeight?: number;
}

export function renderInsetSvg(inset: Inset, options: RenderInsetOptions = {}): string {
  const bubble = inset.bubbleBBox;
  const rx = inset.cornerRadius;
  const frame = escapeAttr(inset.frameColor);
  const fw = formatNumber(inset.frameWidth);
  const fo = formatNumber(inset.frameOpacity);

  // Optional magnified content: an <image> element using SVG's support for
  // nested viewBox-style cropping via `<pattern>` is complex; we use a clip
  // path + <image> with `preserveAspectRatio` set to the crop's aspect.
  let contentSvg = "";
  if (options.contentHref !== undefined && options.contentHref.length > 0) {
    const crop = inset.cropBBox;
    const clipId = `inset-clip-${Math.round(bubble.x)}-${Math.round(bubble.y)}`;
    contentSvg =
      `<defs><clipPath id="${clipId}"><rect x="${formatNumber(bubble.x)}" y="${formatNumber(bubble.y)}" width="${formatNumber(bubble.width)}" height="${formatNumber(bubble.height)}" rx="${rx}" ry="${rx}" /></clipPath></defs>` +
      `<image href="${escapeAttr(options.contentHref)}" x="${formatNumber(bubble.x)}" y="${formatNumber(bubble.y)}" width="${formatNumber(bubble.width)}" height="${formatNumber(bubble.height)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" data-crop-x="${formatNumber(crop.x)}" data-crop-y="${formatNumber(crop.y)}" data-crop-w="${formatNumber(crop.width)}" data-crop-h="${formatNumber(crop.height)}" />`;
  }

  const shadow =
    inset.shadowColor !== null
      ? `<rect x="${formatNumber(bubble.x + 2)}" y="${formatNumber(bubble.y + 4)}" width="${formatNumber(bubble.width)}" height="${formatNumber(bubble.height)}" rx="${rx}" ry="${rx}" fill="${escapeAttr(inset.shadowColor)}" />`
      : "";

  const frameRect = `<rect x="${formatNumber(bubble.x)}" y="${formatNumber(bubble.y)}" width="${formatNumber(bubble.width)}" height="${formatNumber(bubble.height)}" rx="${rx}" ry="${rx}" fill="none" stroke="${frame}" stroke-width="${fw}" opacity="${fo}" />`;

  const g = inset.guide;
  const dash = g.dashArray.length > 0 ? ` stroke-dasharray="${escapeAttr(g.dashArray)}"` : "";
  const guide =
    `<line x1="${formatNumber(g.from.x)}" y1="${formatNumber(g.from.y)}" x2="${formatNumber(g.to.x)}" y2="${formatNumber(g.to.y)}" stroke="${escapeAttr(g.strokeColor)}" stroke-width="${formatNumber(g.strokeWidth)}"${dash} opacity="${formatNumber(g.opacity)}" stroke-linecap="round" />`;

  const fragment = shadow + contentSvg + frameRect + guide;

  if (options.standalone !== true) return fragment;
  const w = options.imageWidth ?? Math.max(bubble.x + bubble.width + 24, g.to.x + 24);
  const h = options.imageHeight ?? Math.max(bubble.y + bubble.height + 24, g.to.y + 24);
  const vb = `0 0 ${formatNumber(w)} ${formatNumber(h)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Magnified inset of the target element">${fragment}</svg>`;
}

/* -------------------------------------------------------------------------- */
/* Placement helpers                                                           */
/* -------------------------------------------------------------------------- */

function chooseCorner(target: BBox, imageW: number, imageH: number): InsetCorner {
  // Pick the corner farthest from the target's centre. This is intuitive and
  // deterministic.
  return farthestCornerFrom(target, imageW, imageH);
}

function farthestCornerFrom(target: BBox, imageW: number, imageH: number): InsetCorner {
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const left = cx < imageW / 2;
  const top = cy < imageH / 2;
  // Farthest corner is the one diagonally opposite.
  if (left && top) return "bottom-right";
  if (left && !top) return "top-right";
  if (!left && top) return "bottom-left";
  return "top-left";
}

function bubbleRectFor(
  corner: InsetCorner,
  imageW: number,
  imageH: number,
  width: number,
  height: number,
  margin: number,
): BBox {
  switch (corner) {
    case "top-left":
      return { x: margin, y: margin, width, height };
    case "top-right":
      return { x: Math.max(margin, imageW - width - margin), y: margin, width, height };
    case "bottom-left":
      return { x: margin, y: Math.max(margin, imageH - height - margin), width, height };
    case "bottom-right":
      return {
        x: Math.max(margin, imageW - width - margin),
        y: Math.max(margin, imageH - height - margin),
        width,
        height,
      };
  }
}

function cornerForBubble(
  bubble: BBox,
  imageW: number,
  imageH: number,
  margin: number,
): InsetCorner {
  const nearLeft = bubble.x <= margin + 1;
  const nearTop = bubble.y <= margin + 1;
  if (nearLeft && nearTop) return "top-left";
  if (nearLeft && !nearTop) return "bottom-left";
  if (!nearLeft && nearTop) return "top-right";
  // If it is not at top-right, and not any other, treat as bottom-right unless
  // it is clearly centred, in which case fall back to the corner it is nearest.
  const dLeft = bubble.x;
  const dRight = imageW - (bubble.x + bubble.width);
  const dTop = bubble.y;
  const dBottom = imageH - (bubble.y + bubble.height);
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft && min === dTop) return "top-left";
  if (min === dLeft && min === dBottom) return "bottom-left";
  if (min === dRight && min === dTop) return "top-right";
  return "bottom-right";
}

function closestGuideLine(
  bubble: BBox,
  target: BBox,
  style: {
    readonly strokeColor: string;
    readonly strokeWidth: number;
    readonly dashArray: string;
    readonly opacity: number;
  },
): Inset["guide"] {
  // Nearest corner-to-corner pair. Using corners rather than centres keeps
  // the line from crossing either rectangle.
  const bubbleCorners: readonly { readonly x: number; readonly y: number }[] = [
    { x: bubble.x, y: bubble.y },
    { x: bubble.x + bubble.width, y: bubble.y },
    { x: bubble.x, y: bubble.y + bubble.height },
    { x: bubble.x + bubble.width, y: bubble.y + bubble.height },
  ];
  const targetCorners: readonly { readonly x: number; readonly y: number }[] = [
    { x: target.x, y: target.y },
    { x: target.x + target.width, y: target.y },
    { x: target.x, y: target.y + target.height },
    { x: target.x + target.width, y: target.y + target.height },
  ];
  let best: { from: { x: number; y: number }; to: { x: number; y: number }; d: number } | null = null;
  for (const bc of bubbleCorners) {
    for (const tc of targetCorners) {
      const d = Math.hypot(tc.x - bc.x, tc.y - bc.y);
      if (best === null || d < best.d) {
        best = { from: bc, to: tc, d };
      }
    }
  }
  const chosen = best ?? { from: bubbleCorners[0] as { x: number; y: number }, to: targetCorners[0] as { x: number; y: number }, d: 0 };
  return {
    from: { x: Math.round(chosen.from.x), y: Math.round(chosen.from.y) },
    to: { x: Math.round(chosen.to.x), y: Math.round(chosen.to.y) },
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
    dashArray: style.dashArray,
    opacity: style.opacity,
  };
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

function validateBox(b: BBox, name: string): BBox {
  if (b === null || typeof b !== "object") {
    throw new InsetError(`buildInset requires ${name}.`, "invalid-input");
  }
  const nums = [b.x, b.y, b.width, b.height];
  for (const n of nums) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new InsetError(`${name} fields must be finite numbers.`, "invalid-bbox");
    }
  }
  if (b.width <= 0 || b.height <= 0) {
    throw new InsetError(`${name} width and height must be positive.`, "invalid-bbox");
  }
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function clampBoxToImage(b: BBox, w: number, h: number): BBox {
  const x = Math.max(0, Math.min(w - 1, b.x));
  const y = Math.max(0, Math.min(h - 1, b.y));
  const right = Math.max(x + 1, Math.min(w, b.x + b.width));
  const bottom = Math.max(y + 1, Math.min(h, b.y + b.height));
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function expandBox(b: BBox, by: number): BBox {
  return { x: b.x - by, y: b.y - by, width: b.width + by * 2, height: b.height + by * 2 };
}

function rectsOverlap(a: BBox, b: BBox): boolean {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top;
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

function clampRange(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function roundTo2(v: number): number {
  return Math.round(v * 100) / 100;
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
  if (typeof value !== "string") return "#0f172a";
  const v = value.trim().toLowerCase();
  if (v.length === 0) return "#0f172a";
  if (/^#[0-9a-f]{3}$/i.test(v)) return v;
  if (/^#[0-9a-f]{4}$/i.test(v)) return v;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{8}$/i.test(v)) return v;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v)) return v;
  if (/^hsla?\(\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?%\s*,\s*\d+(\.\d+)?%\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v)) return v;
  if (NAMED_COLORS_SAFE(v)) return v;
  return "#0f172a";
}

function NAMED_COLORS_SAFE(v: string): boolean {
  return NAMED_COLOURS.has(v);
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateInset(value: unknown): Inset {
  if (value === null || typeof value !== "object") {
    throw new InsetError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const cropBBox = parseBBox(r["cropBBox"], "cropBBox");
  const bubbleBBox = parseBBox(r["bubbleBBox"], "bubbleBBox");
  const magnification = clampRange(numberOr(r["magnification"], 2.5), 1.5, 4);
  const cornerRaw = r["corner"];
  const corner: InsetCorner =
    cornerRaw === "top-left" || cornerRaw === "top-right" || cornerRaw === "bottom-left" || cornerRaw === "bottom-right"
      ? cornerRaw
      : "top-left";
  const frameStyleRaw = r["frameStyle"];
  const frameStyle: InsetFrameStyle = frameStyleRaw === "square" ? "square" : "rounded";
  const cornerRadius = Math.max(0, numberOr(r["cornerRadius"], 0));
  const frameColor = normaliseColor(typeof r["frameColor"] === "string" ? (r["frameColor"] as string) : "#0f172a");
  const frameWidth = clampPositive(numberOr(r["frameWidth"], 2), 0.5);
  const frameOpacity = clamp01(numberOr(r["frameOpacity"], 1));
  const shadowColorRaw = r["shadowColor"];
  const shadowColor =
    shadowColorRaw === null
      ? null
      : typeof shadowColorRaw === "string"
        ? normaliseColor(shadowColorRaw)
        : "rgba(15,23,42,0.35)";
  const guideRaw = (r["guide"] ?? {}) as Record<string, unknown>;
  const guideFrom = parsePoint(guideRaw["from"], "guide.from");
  const guideTo = parsePoint(guideRaw["to"], "guide.to");
  const guide: Inset["guide"] = {
    from: guideFrom,
    to: guideTo,
    strokeColor: normaliseColor(typeof guideRaw["strokeColor"] === "string" ? (guideRaw["strokeColor"] as string) : "#f59e0b"),
    strokeWidth: clampPositive(numberOr(guideRaw["strokeWidth"], 1.5), 0.5),
    dashArray: typeof guideRaw["dashArray"] === "string" ? (guideRaw["dashArray"] as string) : "4 4",
    opacity: clamp01(numberOr(guideRaw["opacity"], 0.85)),
  };
  const notes = Array.isArray(r["notes"])
    ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    type: "inset",
    cropBBox,
    bubbleBBox,
    magnification,
    corner,
    frameStyle,
    cornerRadius,
    frameColor,
    frameWidth,
    frameOpacity,
    shadowColor,
    guide,
    notes,
  };
}

function parseBBox(v: unknown, name: string): BBox {
  if (v === null || typeof v !== "object") {
    throw new InsetError(`Rehydrate failed: ${name} missing.`, "invalid-input");
  }
  const r = v as Record<string, unknown>;
  const x = numberOr(r["x"], NaN);
  const y = numberOr(r["y"], NaN);
  const width = numberOr(r["width"], NaN);
  const height = numberOr(r["height"], NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new InsetError(`Rehydrate failed: ${name} fields invalid.`, "invalid-bbox");
  }
  if (width <= 0 || height <= 0) {
    throw new InsetError(`Rehydrate failed: ${name} dimensions not positive.`, "invalid-bbox");
  }
  return { x, y, width, height };
}

function parsePoint(v: unknown, name: string): { readonly x: number; readonly y: number } {
  if (v === null || typeof v !== "object") {
    throw new InsetError(`Rehydrate failed: ${name} missing.`, "invalid-input");
  }
  const r = v as Record<string, unknown>;
  const x = numberOr(r["x"], NaN);
  const y = numberOr(r["y"], NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new InsetError(`Rehydrate failed: ${name} fields invalid.`, "invalid-input");
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
  chooseCorner,
  farthestCornerFrom,
  bubbleRectFor,
  cornerForBubble,
  closestGuideLine,
  clampBoxToImage,
  rectsOverlap,
  validateBox,
  normaliseColor,
});
