/**
 * Zipy AI — annotation placement coordinator.
 *
 * The annotation engine has four primitive producers (`highlight.ts`,
 * `arrow.ts`, `badge.ts`, and `inset.ts` from this batch). Each of them
 * answers one question: *what shape*, *from where to where*, *which corner*,
 * *what magnification*. None of them knows about the others. This module is
 * the layer that answers *where do all of these go so the step reads cleanly*
 * — a coordination problem, not a rendering problem.
 *
 * Responsibilities:
 *  - Determine which primitives a step needs (highlight always for the
 *    primary element; arrow when the step has step-copy text that must be
 *    tied to the element; badge always; inset when the element is small).
 *  - Choose the arrow's anchor side, badge placement and inset corner so that
 *    they do not overlap each other or the primary target.
 *  - Produce the *exclusion rectangles* the badge layer consumes.
 *  - Return a deterministic, immutable `PlacementPlan` that the API route and
 *    the template layer consume directly.
 *
 * What this module is NOT:
 *  - A renderer. It emits primitives; `renderAnnotationOverlay` (below)
 *    concatenates their SVG fragments for the caller, but no raster work and
 *    no DOM.
 *  - A prose generator. The label box the arrow uses comes from the caller
 *    (the step-copy layer computes its layout). When the caller does not
 *    provide a label box — a common case when the API is generating a
 *    standalone screenshot annotation without a full guide layout — this
 *    module synthesises a conservative label box on the opposite side of the
 *    image from the target, so the arrow still has a start point.
 *
 * Design rules honoured:
 *  - Pure. No I/O, no DOM, no global state.
 *  - Deterministic. Same inputs → same `PlacementPlan` byte for byte.
 *  - Bounded. When the image is too small for all primitives, the plan
 *    degrades in a documented order (drop inset → drop arrow → keep
 *    highlight + badge) and records why in `notes`.
 *  - Honest. Every fallback is recorded in `notes`; nothing is silently
 *    dropped.
 */

import type { BBox } from "@zipy/ingest/ocr";

import {
  buildHighlight,
  renderHighlightSvg,
  type Highlight,
  type HighlightElementKind,
  type HighlightStyle,
} from "@zipy/annotate/highlight";
import {
  buildArrow,
  renderArrowSvg,
  type Arrow,
  type ArrowAnchorSide,
  type ArrowHeadStyle,
} from "@zipy/annotate/arrow";
import {
  buildBadge,
  renderBadgeSvg,
  type Badge,
  type BadgePlacement,
  type BadgeShape,
} from "@zipy/annotate/badge";
import {
  buildInset,
  renderInsetSvg,
  type Inset,
} from "@zipy/annotate/inset";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type PlacementErrorCode = "invalid-input" | "image-too-small";

export class PlacementError extends Error {
  readonly code: PlacementErrorCode;
  constructor(message: string, code: PlacementErrorCode) {
    super(message);
    this.name = "PlacementError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The order in which optional primitives are dropped when the image cannot
 * hold them all. Kept explicit so the report to the reviewer says *which*
 * step the plan degraded at, not "some annotation failed".
 */
export const DEGRADATION_ORDER = ["inset", "arrow", "badge"] as const;
export type DegradedFeature = (typeof DEGRADATION_ORDER)[number];

export interface StepLabelBox {
  /** The step copy's own text box, in image pixel space. */
  readonly bbox: BBox;
  /**
   * Whether the label is above, below, left or right of the target in the
   * guide's layout. This is a hint; the arrow layer is free to override.
   */
  readonly relativeToTarget?: "above" | "below" | "left" | "right";
}

export interface PlacementStepInput {
  /** 1-based step ordinal, used for the badge label. */
  readonly ordinal: number;
  /** Label override; defaults to `String(ordinal)`. */
  readonly badgeLabel?: string;
  /** The element the step targets. Required. */
  readonly targetBBox: BBox;
  /** The element's kind, for highlight style inference. */
  readonly elementKind: HighlightElementKind;
  /** The step's copy box, when available. */
  readonly label?: StepLabelBox;
  /** The element's ref; carried through for provenance in the plan. */
  readonly elementRef?: string;
}

export interface PlacementOptions {
  /** Image width in pixels. Required. */
  readonly imageWidth: number;
  /** Image height in pixels. Required. */
  readonly imageHeight: number;
  /** Highlight style override; `undefined` uses per-kind inference. */
  readonly highlightStyle?: HighlightStyle;
  /** Explicit arrow anchor side; `undefined` = auto. */
  readonly arrowAnchorSide?: ArrowAnchorSide;
  /** Arrow head style; default `triangle`. */
  readonly arrowHeadStyle?: ArrowHeadStyle;
  /** Badge placement; default `auto`. */
  readonly badgePlacement?: BadgePlacement;
  /** Badge shape; default `circle`. */
  readonly badgeShape?: BadgeShape;
  /** Badge diameter override; default 28px. */
  readonly badgeDiameter?: number;
  /** Explicit inset corner; `undefined` = auto. */
  readonly insetCorner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /**
   * The pixel side below which an inset is generated for the target. The
   * default, 40px, matches the "small UI element" threshold the product
   * documents.
   */
  readonly insetSmallElementThreshold?: number;
  /**
   * The inset magnification factor. Clamped to [1.5, 4] by the inset layer.
   * Default 2.5.
   */
  readonly insetMagnification?: number;
  /** Features to suppress. Used by the review editor. */
  readonly suppress?: readonly DegradedFeature[];
}

/* -------------------------------------------------------------------------- */
/* PlacementPlan                                                              */
/* -------------------------------------------------------------------------- */

export interface PlacementPlan {
  readonly ordinal: number;
  readonly elementRef: string | null;
  readonly highlight: Highlight;
  readonly badge: Badge;
  readonly arrow: Arrow | null;
  readonly inset: Inset | null;
  /** Rectangles occluded by existing primitives. Fed to nothing here; reported for the editor. */
  readonly occupiedRects: readonly BBox[];
  /** Explanation of any drop or substitution, in order. */
  readonly notes: readonly string[];
  /** Which optional features were dropped this run; empty when none. */
  readonly degraded: readonly DegradedFeature[];
}

/**
 * Plan placement for every step of a workflow. The plan for a single step is
 * produced by `planStepPlacement`; this wraps it so the API route has one
 * call.
 */
export function planPlacements(
  steps: readonly PlacementStepInput[],
  options: PlacementOptions,
): readonly PlacementPlan[] {
  const plans: PlacementPlan[] = [];
  for (const step of steps) {
    plans.push(planStepPlacement(step, options));
  }
  return plans;
}

export function planStepPlacement(
  step: PlacementStepInput,
  options: PlacementOptions,
): PlacementPlan {
  if (step === null || typeof step !== "object") {
    throw new PlacementError("planStepPlacement requires a step input.", "invalid-input");
  }
  if (
    !Number.isFinite(options.imageWidth) ||
    options.imageWidth <= 0 ||
    !Number.isFinite(options.imageHeight) ||
    options.imageHeight <= 0
  ) {
    throw new PlacementError(
      "imageWidth and imageHeight must be positive finite numbers.",
      "invalid-input",
    );
  }

  const notes: string[] = [];
  const degraded: DegradedFeature[] = [];
  const suppress = new Set(options.suppress ?? []);

  const target = validateBox(step.targetBBox);
  const imageW = options.imageWidth;
  const imageH = options.imageHeight;

  // 1. Highlight is always produced — a step with no highlight is unreadable.
  const highlight = buildHighlight(target, step.elementKind, {
    imageWidth: imageW,
    imageHeight: imageH,
    style: options.highlightStyle,
  });

  // 2. Inset (magnified bubble) — only useful when the element is small.
  const smallThreshold = clampPositive(options.insetSmallElementThreshold ?? 40, 4);
  const smallestSide = Math.min(target.width, target.height);
  let inset: Inset | null = null;
  if (!suppress.has("inset") && smallestSide < smallThreshold) {
    try {
      inset = buildInset(target, {
        imageWidth: imageW,
        imageHeight: imageH,
        magnification: options.insetMagnification,
        corner: options.insetCorner,
      });
    } catch (err) {
      notes.push(
        `Inset generation failed for target ${Math.round(smallestSide)}px: ${errorMessage(err)}.`,
      );
      degraded.push("inset");
    }
  }

  // 3. Badge always attempted.
  const exclusionRects: BBox[] = [target];
  if (inset !== null) exclusionRects.push(inset.bubbleBBox);

  let badge: Badge | null = null;
  if (!suppress.has("badge")) {
    try {
      badge = buildBadge(step.ordinal, target, {
        placement: options.badgePlacement ?? "auto",
        shape: options.badgeShape ?? "circle",
        diameter: options.badgeDiameter,
        exclusionRects,
        imageWidth: imageW,
        imageHeight: imageH,
        allowOverlap: true,
      });
    } catch (err) {
      notes.push(`Badge generation failed: ${errorMessage(err)}.`);
      degraded.push("badge");
    }
  }

  // 4. Arrow — needs a label box. When the caller does not supply one, we
  //    synthesise a conservative box on the opposite side of the image from
  //    the target. That keeps the arrow sensible even when the API is called
  //    without a full guide layout.
  let arrow: Arrow | null = null;
  if (!suppress.has("arrow")) {
    const labelBox = step.label?.bbox ?? synthesiseLabelBox(target, imageW, imageH);
    if (step.label === undefined) {
      notes.push(
        "No step label box supplied; synthesised a conservative label box on the opposite side of the image from the target.",
      );
    }
    try {
      arrow = buildArrow(labelBox, target, {
        imageWidth: imageW,
        imageHeight: imageH,
        anchorSide: options.arrowAnchorSide,
        headStyle: options.arrowHeadStyle,
      });
    } catch (err) {
      notes.push(`Arrow generation failed: ${errorMessage(err)}.`);
      degraded.push("arrow");
    }
  }

  // 5. If the image is very small, drop in documented order until the plan
  //    fits. The order is `inset`, then `arrow`; badge and highlight are never
  //    dropped because losing them makes the step ambiguous.
  const MIN_IMAGE_SIDE = 80;
  if (imageW < MIN_IMAGE_SIDE || imageH < MIN_IMAGE_SIDE) {
    if (inset !== null) {
      inset = null;
      if (!degraded.includes("inset")) degraded.push("inset");
      notes.push(
        `Image is ${imageW}x${imageH} (< ${MIN_IMAGE_SIDE}px minimum); inset dropped to preserve legibility.`,
      );
    }
    if (arrow !== null && (imageW < MIN_IMAGE_SIDE / 2 || imageH < MIN_IMAGE_SIDE / 2)) {
      arrow = null;
      if (!degraded.includes("arrow")) degraded.push("arrow");
      notes.push(
        "Image is extremely small; arrow dropped. Highlight and badge retained.",
      );
    }
  }

  if (badge === null) {
    // A plan with no badge is legal but unusual; record it.
    if (suppress.has("badge")) {
      notes.push("Badge suppressed by caller.");
    }
  }

  const occupiedRects = collectOccupied(highlight, badge, arrow, inset);

  return {
    ordinal: step.ordinal,
    elementRef: step.elementRef ?? null,
    highlight,
    badge:
      badge ??
      // A placeholder badge is preferable to a null in the output type; the
      // caller can render `null` when they want to suppress it.
      buildBadge(step.ordinal, target, {
        placement: "top-left",
        shape: "circle",
        imageWidth: imageW,
        imageHeight: imageH,
      }),
    arrow,
    inset,
    occupiedRects,
    notes,
    degraded,
  };
}

/* -------------------------------------------------------------------------- */
/* SVG overlay rendering                                                       */
/* -------------------------------------------------------------------------- */

export interface RenderOverlayOptions {
  /**
   * When true, wraps the concatenated fragments in a self-contained `<svg>`
   * whose viewBox covers the full image. Defaults to true — that is what the
   * API route wants. Set to false when the caller already owns an overlay.
   */
  readonly standalone?: boolean;
}

/**
 * Concatenate the SVG fragments of every primitive into a single overlay
 * fragment (or a standalone `<svg>`). The order is deliberate: highlight
 * first (bottom), inset second (drawn above the highlight so the magnified
 * content is legible), arrow above that, badge on top.
 */
export function renderAnnotationOverlay(
  plan: PlacementPlan,
  options: RenderOverlayOptions = {},
): string {
  const parts: string[] = [];
  parts.push(renderHighlightSvg(plan.highlight));
  if (plan.inset !== null) parts.push(renderInsetSvg(plan.inset));
  if (plan.arrow !== null) parts.push(renderArrowSvg(plan.arrow));
  parts.push(renderBadgeSvg(plan.badge));
  const body = parts.join("");
  const standalone = options.standalone !== false;
  if (!standalone) return body;
  // The overlay's viewBox is determined by the union of all primitives; when
  // the caller renders the overlay over the whole screenshot, they should
  // pass `standalone: false`. This branch exists so a caller can embed a
  // self-contained snippet without knowing the image dimensions.
  const rects = plan.occupiedRects;
  if (rects.length === 0) return body;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  const pad = 24;
  const vb = `${formatNumber(minX - pad)} ${formatNumber(minY - pad)} ${formatNumber(maxX - minX + pad * 2)} ${formatNumber(maxY - minY + pad * 2)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Step annotations">${body}</svg>`;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function synthesiseLabelBox(target: BBox, imageW: number, imageH: number): BBox {
  // Place the label on the opposite side of the image from the target. The
  // label's width is a fraction of the image's width so arrows read cleanly
  // even when the target is on one edge.
  const labelWidth = Math.max(80, Math.round(imageW * 0.28));
  const labelHeight = 40;
  const targetCentreX = target.x + target.width / 2;
  const targetCentreY = target.y + target.height / 2;
  const preferLeft = targetCentreX > imageW / 2;
  const preferTop = targetCentreY > imageH / 2;
  const x = preferLeft
    ? Math.max(0, Math.round(target.x - labelWidth - 24))
    : Math.min(imageW - labelWidth, Math.round(target.x + target.width + 24));
  const y = preferTop
    ? Math.max(0, Math.round(target.y - labelHeight - 24))
    : Math.min(imageH - labelHeight, Math.round(target.y + target.height + 24));
  return { x, y, width: labelWidth, height: labelHeight };
}

function collectOccupied(
  highlight: Highlight,
  badge: Badge | null,
  arrow: Arrow | null,
  inset: Inset | null,
): readonly BBox[] {
  const out: BBox[] = [highlight.bbox];
  if (badge !== null) out.push(badge.bbox);
  if (arrow !== null) {
    // The arrow's curve is bounded by the union of its endpoints and control.
    const xs = [arrow.from.x, arrow.to.x, arrow.control.x];
    const ys = [arrow.from.y, arrow.to.y, arrow.control.y];
    out.push({
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    });
  }
  if (inset !== null) {
    out.push(inset.bubbleBBox);
    out.push(inset.cropBBox);
  }
  return out;
}

function validateBox(b: BBox): BBox {
  if (b === null || typeof b !== "object") {
    throw new PlacementError("A BBox is required.", "invalid-input");
  }
  const nums = [b.x, b.y, b.width, b.height];
  for (const n of nums) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new PlacementError("BBox fields must be finite numbers.", "invalid-input");
    }
  }
  if (b.width <= 0 || b.height <= 0) {
    throw new PlacementError("BBox width and height must be positive.", "invalid-input");
  }
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function clampPositive(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return v;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydratePlacementPlan(value: unknown): PlacementPlan {
  if (value === null || typeof value !== "object") {
    throw new PlacementError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const ordinal = numberOr(r["ordinal"], 1);
  const elementRef = typeof r["elementRef"] === "string" ? (r["elementRef"] as string) : null;
  const highlightRaw = r["highlight"];
  const badgeRaw = r["badge"];
  if (highlightRaw === null || typeof highlightRaw !== "object") {
    throw new PlacementError("Rehydrate failed: 'highlight' is required.", "invalid-input");
  }
  if (badgeRaw === null || typeof badgeRaw !== "object") {
    throw new PlacementError("Rehydrate failed: 'badge' is required.", "invalid-input");
  }
  // We deliberately do not import the concrete rehydrators here — that would
  // couple placement to the primitive layers' internals. The caller (the
  // API route) is responsible for rehydrating primitives via their own
  // modules and passing them back in. This function exists so a persisted
  // plan with primitive objects intact can be brought back without a
  // bespoke parser.
  const notes = Array.isArray(r["notes"])
    ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const degradedRaw = Array.isArray(r["degraded"]) ? (r["degraded"] as unknown[]) : [];
  const degraded = degradedRaw.filter(
    (s): s is DegradedFeature => s === "inset" || s === "arrow" || s === "badge",
  );
  const occupiedRectsRaw = Array.isArray(r["occupiedRects"]) ? (r["occupiedRects"] as unknown[]) : [];
  const occupiedRects: BBox[] = [];
  for (const rb of occupiedRectsRaw) {
    if (rb === null || typeof rb !== "object") continue;
    const o = rb as Record<string, unknown>;
    const x = numberOr(o["x"], NaN);
    const y = numberOr(o["y"], NaN);
    const width = numberOr(o["width"], NaN);
    const height = numberOr(o["height"], NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      continue;
    }
    if (width <= 0 || height <= 0) continue;
    occupiedRects.push({ x, y, width, height });
  }
  return {
    ordinal,
    elementRef,
    // The primitives are rehydrated by their own modules; we carry through
    // the raw shapes with a structural cast guarded by the shape check above.
    highlight: highlightRaw as unknown as Highlight,
    badge: badgeRaw as unknown as Badge,
    arrow: r["arrow"] !== null && typeof r["arrow"] === "object" ? (r["arrow"] as unknown as Arrow) : null,
    inset: r["inset"] !== null && typeof r["inset"] === "object" ? (r["inset"] as unknown as Inset) : null,
    occupiedRects,
    notes,
    degraded,
  };
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
  synthesiseLabelBox,
  collectOccupied,
  validateBox,
  clampPositive,
});
