/**
 * Zipy AI — canonical viewport policy.
 *
 * The product spec requires "All screenshots use the same viewport dimensions,
 * ensuring a clean, professional guide." This module is the single source of
 * truth for that geometry. `@/lib/config` already carries a configured
 * viewport (env-driven), but capture code, the annotate phase, and the
 * post-generation editor all need *comparable* numbers and a way to detect a
 * screenshot that was captured at the wrong size. Centralising the algebra
 * here keeps the "consistent viewport" guarantee enforceable rather than
 * being an informal convention.
 *
 * Design rules honoured:
 *  - Pure geometry. No Playwright, no sharp, no DB.
 *  - No invented snapshots. The module never fabricates an image or bytes.
 *  - Optional viewport overrides are validated, not silently clamped to a
 *    "sensible" default — a caller that asks for 1920×1080 and receives
 *    1440×900 without knowing it is the bug this module exists to prevent.
 *  - Aspect-ratio drift between captures is *reported*, never silently
 *    normalised away. The caller (step executor, editor, exporter) decides
 *    whether to re-capture.
 */

import type { BBox } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ViewportErrorCode =
  | "invalid-input"
  | "invalid-bounds"
  | "unsupported-preset";

export class ViewportError extends Error {
  readonly code: ViewportErrorCode;
  constructor(message: string, code: ViewportErrorCode, cause?: unknown) {
    super(message);
    this.name = "ViewportError";
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The bookkeeping shape stored per step-screenshot. `deviceWidth` and
 * `deviceHeight` are `width * dpr` / `height * dpr`, precomputed so downstream
 * consumers (redact, annotate) do not have to re-multiply.
 *
 * `dpr` is included here for symmetry with the DB row the capture layer
 * stores; the value is a number and is validated by `dpr.ts`, not this file.
 */
export interface ViewportDescriptor {
  readonly width: number;
  readonly height: number;
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly dpr: number;
  /** Opaque label recorded alongside the screenshot for review UI ("desktop", "mobile"). */
  readonly preset: ViewportPresetName | "custom";
}

export type ViewportPresetName =
  | "desktop"
  | "desktop-wide"
  | "laptop"
  | "tablet"
  | "mobile"
  | "mobile-large";

/**
 * A single screenshot's own recorded viewport. This is what the post-generation
 * editor reads to render an overlay at the same coordinate space as the
 * underlying redacted image.
 */
export interface RecordedViewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/* -------------------------------------------------------------------------- */
/* Preset table                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Named viewport presets. These are the sizes the "Consistent viewport"
 * feature exposes in the UI. Values are chosen for tutorial legibility at 2×:
 * 1440×900 produces a 2880×1800 device-pixel capture, which stays under the
 * default per-image memory budget while still looking crisp on Retina.
 */
const VIEWPORT_PRESETS: Readonly<Record<ViewportPresetName, ViewportSize>> = {
  desktop: { width: 1440, height: 900 },
  "desktop-wide": { width: 1728, height: 1080 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
  "mobile-large": { width: 430, height: 932 },
};

/**
 * Hard bounds. Larger than these is almost certainly a mistake (a caller that
 * passed CSS-pixel dimensions too large for any real display); smaller is
 * guaranteed to produce an unreadable tutorial.
 */
const MIN_EDGE_PX = 200;
const MAX_EDGE_PX = 8192;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/** Return a fresh copy of a named preset. Throws on unknown names. */
export function getViewportPreset(name: string): ViewportSize {
  if (typeof name !== "string" || name.length === 0) {
    throw new ViewportError("Viewport preset name must be a non-empty string.", "invalid-input");
  }
  if (!(name in VIEWPORT_PRESETS)) {
    throw new ViewportError(
      `Unknown viewport preset "${name}". Known presets: ${Object.keys(VIEWPORT_PRESETS).join(", ")}.`,
      "unsupported-preset",
    );
  }
  const preset = VIEWPORT_PRESETS[name as ViewportPresetName];
  return { width: preset.width, height: preset.height };
}

export function listViewportPresets(): readonly {
  readonly name: ViewportPresetName;
  readonly size: ViewportSize;
}[] {
  return (Object.keys(VIEWPORT_PRESETS) as ViewportPresetName[]).map((name) => ({
    name,
    size: { ...(VIEWPORT_PRESETS[name] as ViewportSize) },
  }));
}

/**
 * Validate a caller-supplied viewport against the module's hard bounds. Returns
 * a normalised (rounded, integer) copy on success. Never silently clamps —
 * a request outside the bounds is an error, because the caller needs to know
 * its assumed geometry is not what it will receive.
 */
export function validateViewportSize(size: ViewportSize): ViewportSize {
  if (size === null || typeof size !== "object") {
    throw new ViewportError("Viewport size must be an object.", "invalid-input");
  }
  const w = size.width;
  const h = size.height;
  if (
    typeof w !== "number" ||
    !Number.isFinite(w) ||
    typeof h !== "number" ||
    !Number.isFinite(h)
  ) {
    throw new ViewportError("Viewport width and height must be finite numbers.", "invalid-input");
  }
  const wi = Math.round(w);
  const hi = Math.round(h);
  if (wi < MIN_EDGE_PX || hi < MIN_EDGE_PX) {
    throw new ViewportError(
      `Viewport ${wi}×${hi} is below the minimum edge of ${MIN_EDGE_PX}px; screenshots at this size stop being legible.`,
      "invalid-bounds",
    );
  }
  if (wi > MAX_EDGE_PX || hi > MAX_EDGE_PX) {
    throw new ViewportError(
      `Viewport ${wi}×${hi} exceeds the maximum edge of ${MAX_EDGE_PX}px.`,
      "invalid-bounds",
    );
  }
  return { width: wi, height: hi };
}

/**
 * Build the descriptor the DB row stores. Combines the CSS-pixel viewport with
 * a device-scale factor and pre-computes the device-pixel dimensions. This is
 * what the capture layer writes; the annotate and export phases read it back
 * via `rehydrateViewportDescriptor`.
 */
export function describeViewport(
  size: ViewportSize,
  dpr: number,
  preset: ViewportPresetName | "custom" = "custom",
): ViewportDescriptor {
  const normalised = validateViewportSize(size);
  if (typeof dpr !== "number" || !Number.isFinite(dpr) || dpr <= 0) {
    throw new ViewportError("Device-scale factor must be a positive finite number.", "invalid-input");
  }
  const deviceWidth = Math.round(normalised.width * dpr);
  const deviceHeight = Math.round(normalised.height * dpr);
  return {
    width: normalised.width,
    height: normalised.height,
    deviceWidth,
    deviceHeight,
    dpr,
    preset,
  };
}

/**
 * Metadata probe on a stored screenshot's recorded viewport. Two things are
 * detected:
 *
 *  1. Aspect-ratio drift — a capture whose aspect ratio differs from the
 *     canonical geometry's by more than the configured tolerance is flagged.
 *  2. Dimension mismatch — a capture whose CSS-pixel dimensions differ from
 *     the canonical geometry is flagged.
 *
 * Neither is auto-corrected. `corrected` is null on drift; the caller decides
 * to re-capture, letterbox, or accept.
 */
export interface ViewportConsistencyReport {
  readonly expected: ViewportDescriptor;
  readonly recorded: RecordedViewport;
  readonly matches: boolean;
  readonly aspectRatioDrift: number;
  readonly aspectRatioDriftExceeded: boolean;
  readonly dimensionMismatch: boolean;
  readonly corrected: ViewportDescriptor | null;
  readonly notes: readonly string[];
}

export interface ConsistencyOptions {
  /**
   * Maximum tolerated aspect-ratio drift as an absolute difference between the
   * two ratios. Default 0.01 (1%). A 1440×900 image is 1.600; a 1440×901 image
   * is 1.5982, which is inside the default tolerance.
   */
  readonly aspectTolerance?: number;
}

export function checkViewportConsistency(
  expected: ViewportDescriptor,
  recorded: RecordedViewport,
  options: ConsistencyOptions = {},
): ViewportConsistencyReport {
  if (expected === null || typeof expected !== "object") {
    throw new ViewportError("expected descriptor must be an object.", "invalid-input");
  }
  if (recorded === null || typeof recorded !== "object") {
    throw new ViewportError("recorded viewport must be an object.", "invalid-input");
  }
  if (
    typeof recorded.width !== "number" ||
    !Number.isFinite(recorded.width) ||
    recorded.width <= 0 ||
    typeof recorded.height !== "number" ||
    !Number.isFinite(recorded.height) ||
    recorded.height <= 0
  ) {
    throw new ViewportError("recorded width/height must be positive finite numbers.", "invalid-input");
  }
  if (typeof recorded.dpr !== "number" || !Number.isFinite(recorded.dpr) || recorded.dpr <= 0) {
    throw new ViewportError("recorded dpr must be a positive finite number.", "invalid-input");
  }

  const tolerance =
    typeof options.aspectTolerance === "number" &&
    Number.isFinite(options.aspectTolerance) &&
    options.aspectTolerance >= 0
      ? options.aspectTolerance
      : 0.01;

  const expectedRatio = expected.width / expected.height;
  const recordedRatio = recorded.width / recorded.height;
  const aspectRatioDrift = Math.abs(expectedRatio - recordedRatio);
  const aspectRatioDriftExceeded = aspectRatioDrift > tolerance;

  const dimensionMismatch =
    Math.round(recorded.width) !== expected.width ||
    Math.round(recorded.height) !== expected.height;

  const matches = !aspectRatioDriftExceeded && !dimensionMismatch;

  const notes: string[] = [];
  if (aspectRatioDriftExceeded) {
    notes.push(
      `Aspect ratio drifted by ${aspectRatioDrift.toFixed(4)} (expected ${expectedRatio.toFixed(4)}, recorded ${recordedRatio.toFixed(4)}); tolerance is ${tolerance}.`,
    );
  }
  if (dimensionMismatch) {
    notes.push(
      `Recorded CSS-pixel dimensions ${Math.round(recorded.width)}×${Math.round(recorded.height)} do not match expected ${expected.width}×${expected.height}.`,
    );
  }
  if (recorded.dpr !== expected.dpr) {
    notes.push(
      `Recorded dpr ${recorded.dpr} does not match expected ${expected.dpr}; the device-pixel image is unlikely to be comparable.`,
    );
  }

  return {
    expected,
    recorded: {
      width: Math.round(recorded.width),
      height: Math.round(recorded.height),
      dpr: recorded.dpr,
    },
    matches,
    aspectRatioDrift,
    aspectRatioDriftExceeded,
    dimensionMismatch,
    // Deliberately null on a mismatch: normalising silently is the bug the
    // module exists to prevent. A caller that wants the corrected value must
    // ask by building a new descriptor from the canonical geometry.
    corrected: matches ? { ...expected } : null,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* BBox normalisation                                                          */
/* -------------------------------------------------------------------------- */

export type BBoxSpace = "css" | "device";

/**
 * Convert a bounding box from one coordinate space to the other. The
 * annotation phase runs in device space (that is what the redactor and the
 * image compositor both consume), while element geometry from Playwright is
 * in CSS space. This is the single conversion point so a step that is
 * annotated at 2× does not place its highlight at half the intended
 * position.
 *
 * The conversion is lossless for integer coordinates when `dpr` is an
 * integer; otherwise the result is rounded and the caller is expected to
 * have accounted for that on the round trip.
 */
export function convertBBoxSpace(bbox: BBox, from: BBoxSpace, to: BBoxSpace, dpr: number): BBox {
  if (bbox === null || typeof bbox !== "object") {
    throw new ViewportError("BBox must be an object.", "invalid-input");
  }
  if (typeof dpr !== "number" || !Number.isFinite(dpr) || dpr <= 0) {
    throw new ViewportError("dpr must be a positive finite number.", "invalid-input");
  }
  if (
    typeof bbox.x !== "number" ||
    typeof bbox.y !== "number" ||
    typeof bbox.width !== "number" ||
    typeof bbox.height !== "number" ||
    !Number.isFinite(bbox.x) ||
    !Number.isFinite(bbox.y) ||
    !Number.isFinite(bbox.width) ||
    !Number.isFinite(bbox.height) ||
    bbox.width < 0 ||
    bbox.height < 0
  ) {
    throw new ViewportError(
      "BBox x/y/width/height must be finite numbers with non-negative width and height.",
      "invalid-input",
    );
  }
  if (from === to) {
    return {
      x: Math.round(bbox.x),
      y: Math.round(bbox.y),
      width: Math.max(0, Math.round(bbox.width)),
      height: Math.max(0, Math.round(bbox.height)),
    };
  }
  const factor = from === "css" && to === "device" ? dpr : 1 / dpr;
  return {
    x: Math.round(bbox.x * factor),
    y: Math.round(bbox.y * factor),
    width: Math.max(0, Math.round(bbox.width * factor)),
    height: Math.max(0, Math.round(bbox.height * factor)),
  };
}

/**
 * Clip a bbox to a viewport in device-pixel space. Returns null when the bbox
 * lies entirely outside — matches the redact contract where an out-of-bounds
 * detection is *skipped*, not coerced to a 1×1 rectangle.
 */
export function clipBBoxToViewport(bbox: BBox, descriptor: ViewportDescriptor): BBox | null {
  if (bbox === null || typeof bbox !== "object") {
    throw new ViewportError("BBox must be an object.", "invalid-input");
  }
  if (descriptor === null || typeof descriptor !== "object") {
    throw new ViewportError("Descriptor must be an object.", "invalid-input");
  }
  const w = descriptor.deviceWidth;
  const h = descriptor.deviceHeight;
  if (w <= 0 || h <= 0) {
    throw new ViewportError("Descriptor device dimensions must be positive.", "invalid-input");
  }
  const x = Math.max(0, Math.min(w, Math.floor(bbox.x)));
  const y = Math.max(0, Math.min(h, Math.floor(bbox.y)));
  const right = Math.max(x, Math.min(w, Math.ceil(bbox.x + bbox.width)));
  const bottom = Math.max(y, Math.min(h, Math.ceil(bbox.y + bbox.height)));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `ViewportDescriptor`. Throws on structurally invalid
 * payloads (same contract as `rehydrateCompressResult` and
 * `rehydrateRedactionSummary`) so a corrupted descriptor cannot feed the
 * coordinate maths a plausible-looking but wrong geometry.
 */
export function rehydrateViewportDescriptor(value: unknown): ViewportDescriptor {
  if (value === null || typeof value !== "object") {
    throw new ViewportError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const width = Math.round(numberOr(r["width"], NaN));
  const height = Math.round(numberOr(r["height"], NaN));
  const dpr = numberOr(r["dpr"], NaN);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ViewportError("Rehydrate failed: width/height are not positive numbers.", "invalid-input");
  }
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new ViewportError("Rehydrate failed: dpr is not a positive number.", "invalid-input");
  }
  const presetRaw = r["preset"];
  const preset: ViewportPresetName | "custom" =
    typeof presetRaw === "string" && presetRaw in VIEWPORT_PRESETS
      ? (presetRaw as ViewportPresetName)
      : "custom";
  // Prefer persisted device dimensions, but validate them before trusting;
  // fall back to `width * dpr` so a partial row does not produce a NaN-aware
  // overlay in the editor.
  const deviceWidth = Math.round(numberOr(r["deviceWidth"], width * dpr));
  const deviceHeight = Math.round(numberOr(r["deviceHeight"], height * dpr));
  return {
    width,
    height,
    deviceWidth: deviceWidth > 0 ? deviceWidth : Math.round(width * dpr),
    deviceHeight: deviceHeight > 0 ? deviceHeight : Math.round(height * dpr),
    dpr,
    preset,
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
/* Exported constants                                                          */
/* -------------------------------------------------------------------------- */

export const VIEWPORT_MIN_EDGE_PX = MIN_EDGE_PX;
export const VIEWPORT_MAX_EDGE_PX = MAX_EDGE_PX;
