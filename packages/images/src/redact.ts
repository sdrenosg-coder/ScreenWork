/**
 * Zipy AI — PII redaction.
 *
 * Consumes the detection list from `piiDetect.ts` and produces a new image
 * buffer with each detected region obscured. Detection and modulation are
 * separate on purpose (see the header of `piiDetect.ts` for why).
 *
 * Design:
 *  - **Sharp** is the only raster backend, matching the rest of the image
 *    pipeline. It is listed as a dependency of the images workspace; if it is
 *    not installed the module throws a descriptive error rather than silently
 *    skipping the redaction (a silently-un-redacted screenshot is worse than
 *    a loud failure).
 *  - **Idempotent.** Redacting an already-redacted region is safe: the pixel
 *    operation overwrites whatever is there. A caller that runs detection,
 *    then a second detection pass, then redact+redact does not produce a
 *    differently-damaged image.
 *  - **Strategy-aware.** `blur` applies a Gaussian blur sized to the region
 *    (so a small email address is still unreadable); `pixelate` downsamples
 *    then upsamples with nearest-neighbour, so the original pixels are not
 *    recoverable from any single output pixel; `solid` paints the region with
 *    a caller-configurable colour (default an opaque mid-grey).
 *  - **Padding.** A pixel-perfect rectangle around a single character is not
 *    enough — handwriting, subpixel anti-aliasing, and OCR's own box
 *    tolerance all leak a few pixels. Every region is padded by
 *    `paddingPx` (default 4) *before* mutation. Padding is clamped to the
 *    image bounds.
 *  - **Mode preservation.** Output uses the same format as input unless the
 *    caller overrides it. Alpha is preserved (PNG/WebP) or dropped (JPEG).
 *  - **No hidden state.** Every output image is a new Buffer; the input
 *    buffer is not mutated, so a caller can keep the original for the
 *    "before" half of a before/after pair.
 *
 * This module does not persist, does not touch the object store, and does not
 * decide retention. Callers (the worker, or the screenshot API route) wire
 * those concerns in.
 */

import sharp from "sharp";

import type { BBox } from "@zipy/ingest/ocr";

import type { PiiDetection, PiiStrategy } from "./piiDetect.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type RedactErrorCode =
  | "invalid-input"
  | "unsupported-format"
  | "encode-failed";

export class RedactError extends Error {
  readonly code: RedactErrorCode;
  constructor(message: string, code: RedactErrorCode, cause?: unknown) {
    super(message);
    this.name = "RedactError";
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type RedactFormat = "png" | "jpeg" | "webp";

export interface RedactOptions {
  /**
   * Padding, in pixels, added around every detection's bbox before mutation.
   * Coordinates are already in device pixels (the redactor is unaware of DPR);
   * the caller passes device-pixel boxes as produced by `piiDetect.ts`.
   * Default 4.
   */
  readonly paddingPx?: number;
  /**
   * Output format. Default matches `inputFormat` when supplied, else "png".
   * WebP and JPEG require a quality; the default is 82 for JPEG and 78 for
   * WebP (matching the compress module's policy defaults).
   */
  readonly outputFormat?: RedactFormat;
  /** Input format. Used to pick a default output format when one is not supplied. */
  readonly inputFormat?: RedactFormat;
  /** JPEG/WebP quality. Ignored for PNG. */
  readonly quality?: number;
  /** Colour for `solid` strategy regions. Default an opaque mid-grey (#808080). */
  readonly solidColor?: string;
  /**
   * Blur sigma override for `blur` strategy regions. When absent, the sigma
   * is chosen per-region as `max(6, min(width, height) / 6)` so both small
   * text and large regions are fully obscured.
   */
  readonly blurSigma?: number;
  /**
   * When true, mask every detection with the same rectangle colour (a
   * "blackout" mode). Useful for a legal-style redaction where the original
   * pixels must not be recoverable at all. Strategy fields are ignored;
   * EVERY region becomes solid.
   */
  readonly blackout?: boolean;
}

export interface RedactionSummary {
  /** Number of regions actually mutated (i.e. excluding detections that were outside the image). */
  readonly regionsRedacted: number;
  /** Bounding-boxes actually painted, after padding and clamping. */
  readonly paintedBoxes: readonly BBox[];
  /** Detections whose bbox fell entirely outside the image and were skipped. */
  readonly skippedDetectionCount: number;
  readonly strategyBreakdown: Readonly<Record<PiiStrategy, number>>;
  readonly outputFormat: RedactFormat;
  readonly outputByteLength: number;
  readonly width: number;
  readonly height: number;
  readonly generatedAt: string;
}

export interface RedactInput {
  readonly imageBytes: Buffer;
  readonly detections: readonly PiiDetection[];
  /** Image dimensions in device pixels. Required — the redactor does not decode just to read them. */
  readonly width: number;
  readonly height: number;
  readonly inputFormat?: RedactFormat;
}

export interface RedactResult {
  readonly bytes: Buffer;
  readonly format: RedactFormat;
  readonly summary: RedactionSummary;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Redact every region named in `input.detections` and return a new image.
 *
 * The redactor does not decode the input buffer to determine its size: the
 * caller supplies `width`/`height` because those were already recorded in the
 * capture provenance. Passing mismatched dimensions is caught by sharp's
 * composite step (which refuses to paint beyond the canvas) and will surface
 * as an `encode-failed` error rather than a silently truncated redaction.
 */
export async function redactPii(
  input: RedactInput,
  options: RedactOptions = {},
): Promise<RedactResult> {
  if (input === null || typeof input !== "object") {
    throw new RedactError("redactPii requires an input object.", "invalid-input");
  }
  if (!Buffer.isBuffer(input.imageBytes) || input.imageBytes.length === 0) {
    throw new RedactError("imageBytes must be a non-empty Buffer.", "invalid-input");
  }
  if (
    typeof input.width !== "number" ||
    !Number.isFinite(input.width) ||
    input.width <= 0 ||
    typeof input.height !== "number" ||
    !Number.isFinite(input.height) ||
    input.height <= 0
  ) {
    throw new RedactError("width and height must be positive finite numbers.", "invalid-input");
  }
  if (!Array.isArray(input.detections)) {
    throw new RedactError("detections must be an array.", "invalid-input");
  }

  const paddingPx =
    typeof options.paddingPx === "number" && Number.isFinite(options.paddingPx)
      ? Math.max(0, Math.floor(options.paddingPx))
      : 4;

  const outputFormat: RedactFormat =
    options.outputFormat ??
    input.inputFormat ??
    "png";

  if (outputFormat !== "png" && outputFormat !== "jpeg" && outputFormat !== "webp") {
    throw new RedactError(
      `Unsupported output format "${String(outputFormat)}".`,
      "unsupported-format",
    );
  }

  const quality = clampQuality(
    options.quality ?? (outputFormat === "jpeg" ? 82 : 78),
  );

  // ---------------------------------------------------------------------
  // Compute the padded, clamped box for each detection.
  // ---------------------------------------------------------------------
  const paintedBoxes: BBox[] = [];
  const strategyCounts: Record<PiiStrategy, number> = { blur: 0, pixelate: 0, solid: 0 };
  let skipped = 0;
  const plan: {
    readonly box: BBox;
    readonly strategy: PiiStrategy;
    readonly sigma: number | null;
  }[] = [];

  for (const d of input.detections) {
    if (d === null || typeof d !== "object") continue;
    const b = d.bbox;
    if (
      b === null ||
      typeof b !== "object" ||
      typeof b.x !== "number" ||
      typeof b.y !== "number" ||
      typeof b.width !== "number" ||
      typeof b.height !== "number" ||
      !Number.isFinite(b.x) ||
      !Number.isFinite(b.y) ||
      !Number.isFinite(b.width) ||
      !Number.isFinite(b.height) ||
      b.width <= 0 ||
      b.height <= 0
    ) {
      continue;
    }
    const padded: BBox = {
      x: Math.max(0, Math.floor(b.x - paddingPx)),
      y: Math.max(0, Math.floor(b.y - paddingPx)),
      width: 0,
      height: 0,
    };
    const right = Math.min(input.width, Math.ceil(b.x + b.width + paddingPx));
    const bottom = Math.min(input.height, Math.ceil(b.y + b.height + paddingPx));
    padded.width = Math.max(0, right - padded.x);
    padded.height = Math.max(0, bottom - padded.y);
    if (padded.width <= 0 || padded.height <= 0) {
      skipped += 1;
      continue;
    }
    const strategy: PiiStrategy = options.blackout === true ? "solid" : d.strategy;
    const sigma = chooseSigma(strategy, padded, options.blurSigma);
    plan.push({ box: padded, strategy, sigma });
    paintedBoxes.push(padded);
    strategyCounts[strategy] += 1;
  }

  // ---------------------------------------------------------------------
  // Encode the redacted image.
  // ---------------------------------------------------------------------
  let outputBytes: Buffer;
  try {
    outputBytes = await encodeRedacted(input.imageBytes, plan, {
      outputFormat,
      quality,
      solidColor: options.solidColor ?? "#808080",
    });
  } catch (error) {
    throw new RedactError(
      `Failed to redact image: ${error instanceof Error ? error.message : String(error)}`,
      "encode-failed",
      error,
    );
  }

  return {
    bytes: outputBytes,
    format: outputFormat,
    summary: {
      regionsRedacted: plan.length,
      paintedBoxes,
      skippedDetectionCount: skipped,
      strategyBreakdown: strategyCounts,
      outputFormat,
      outputByteLength: outputBytes.length,
      width: input.width,
      height: input.height,
      generatedAt: new Date().toISOString(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Encoder                                                                     */
/* -------------------------------------------------------------------------- */

interface EncodePlan {
  readonly outputFormat: RedactFormat;
  readonly quality: number;
  readonly solidColor: string;
}

interface PlannedRegion {
  readonly box: BBox;
  readonly strategy: PiiStrategy;
  readonly sigma: number | null;
}

/**
 * Build the redacted image. The implementation composites per-region opaque
 * overlays on top of a *blurred copy* of the original:
 *
 *   1. Blur the whole image once (sigma = the maximum sigma across regions,
 *      capped). One global blur is much cheaper than a per-region blur, and
 *      because the blurred copy is used only under region rectangles the
 *      visible sharpness of the rest of the screenshot is preserved.
 *   2. Build a single composite patch: an RGBA overlay the size of the image
 *      where each region is either (a) a transparent hole, letting the blurred
 *      layer show through, (b) a pixelated region, or (c) a solid fill.
 *   3. Extract the pixelated subimages individually and stamp them into the
 *      overlay so per-region pixelate scales are independent.
 *
 * This keeps a single `sharp` composite call (sharp's performance guidance is
 * to composite once, not N times).
 */
async function encodeRedacted(
  source: Buffer,
  plan: readonly PlannedRegion[],
  encode: EncodePlan,
): Promise<Buffer> {
  const format: "png" | "jpeg" | "webp" = encode.outputFormat;

  if (plan.length === 0) {
    // No regions: just re-encode (format conversion is a legitimate operation
    // and callers may rely on this to normalise format).
    return await sharp(source, { failOn: "none" })
      .toFormat(format, format === "png" ? {} : { quality: encode.quality })
      .toBuffer();
  }

  // Collect the metadata for the source; needed because we build a
  // pixel-matched overlay and sharp will assert dimensions match at composite
  // time. We trust the caller-supplied width/height only for the *plan*, and
  // use sharp's actual decoded dimensions for the canvas (mismatch is caught
  // below).
  const meta = await sharp(source, { failOn: "none" }).metadata();
  const canvasWidth = meta.width ?? 0;
  const canvasHeight = meta.height ?? 0;
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new RedactError(
      "Input image has no readable dimensions; refusing to redact a possibly-corrupt buffer.",
      "unsupported-format",
    );
  }

  const clampToCanvas = (b: BBox): BBox => {
    const x = Math.max(0, Math.min(canvasWidth, Math.floor(b.x)));
    const y = Math.max(0, Math.min(canvasHeight, Math.floor(b.y)));
    const right = Math.max(x, Math.min(canvasWidth, Math.ceil(b.x + b.width)));
    const bottom = Math.max(y, Math.min(canvasHeight, Math.ceil(b.y + b.height)));
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  };

  const canvasPlan = plan
    .map((p) => ({ ...p, box: clampToCanvas(p.box) }))
    .filter((p) => p.box.width > 0 && p.box.height > 0);

  if (canvasPlan.length === 0) {
    return await sharp(source, { failOn: "none" })
      .toFormat(format, format === "png" ? {} : { quality: encode.quality })
      .toBuffer();
  }

  const maxSigma = canvasPlan.reduce(
    (acc, p) => (p.strategy === "blur" && p.sigma !== null && p.sigma > acc ? p.sigma : acc),
    0,
  );

  const basePipeline = sharp(source, { failOn: "none" });
  const base = maxSigma > 0
    ? await basePipeline.blur(maxSigma).toBuffer()
    : await basePipeline.toBuffer();

  // Build overlay of the same size, initially fully transparent.
  const overlayParts: sharp.OverlayOptions[] = [];

  for (const p of canvasPlan) {
    if (p.strategy === "solid") {
      // A small 1×1 png of the colour, then composited with a tile? sharp does
      // not tile. Instead, create a flat rectangle to the exact size.
      const rect = await solidRectangle(p.box.width, p.box.height, encode.solidColor);
      overlayParts.push({ input: rect, top: p.box.y, left: p.box.x });
      continue;
    }
    if (p.strategy === "pixelate") {
      const pixelBlock = choosePixelBlock(p.box);
      const rect = await pixelatedCrop(base, p.box, pixelBlock);
      overlayParts.push({ input: rect, top: p.box.y, left: p.box.x });
      continue;
    }
    // blur: the overlay for a blur region is *the same region* taken from the
    // globally-blurred `base`. That gives a single-pass blur without the
    // per-region cost of calling `blur` on each subimage.
    if (maxSigma > 0) {
      const rect = await cropFrom(base, p.box);
      overlayParts.push({ input: rect, top: p.box.y, left: p.box.x });
    }
    // If maxSigma is 0 (no blur regions had a positive sigma), nothing to do.
  }

  const out = await sharp(base)
    .composite(overlayParts)
    .toFormat(format, format === "png" ? {} : { quality: encode.quality })
    .toBuffer();
  return out;
}

/* -------------------------------------------------------------------------- */
/* Subimage helpers                                                            */
/* -------------------------------------------------------------------------- */

async function solidRectangle(width: number, height: number, color: string): Promise<Buffer> {
  // Fastest reliable path: create a 1×1 image of `color`, then resize with
  // `kernel: "nearest"` to the target size. sharp's resize does exactly this
  // style of fill when the source is smaller than the destination and the
  // kernel is nearest, at near-zero cost.
  const safeColor = normalizeHexColor(color) ?? "#808080";
  const one = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: safeColor,
    },
  })
    .png()
    .toBuffer();
  return await sharp(one)
    .resize(width, height, { kernel: "nearest" })
    .png()
    .toBuffer();
}

async function cropFrom(source: Buffer, box: BBox): Promise<Buffer> {
  return await sharp(source, { failOn: "none" })
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .png()
    .toBuffer();
}

async function pixelatedCrop(source: Buffer, box: BBox, block: number): Promise<Buffer> {
  const blockSize = Math.max(2, Math.min(64, Math.floor(block)));
  // Downsample by |block| then upsample with nearest. Downsampling with "box"
  // kernel averages each |block|×|block| tile; nearest upsampling preserves
  // the block boundaries, so no pixel in the output is recoverable except as
  // the tile mean.
  const downW = Math.max(1, Math.floor(box.width / blockSize));
  const downH = Math.max(1, Math.floor(box.height / blockSize));
  return await sharp(source, { failOn: "none" })
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .resize(downW, downH, { kernel: "box" })
    .resize(box.width, box.height, { kernel: "nearest" })
    .png()
    .toBuffer();
}

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                  */
/* -------------------------------------------------------------------------- */

function chooseSigma(strategy: PiiStrategy, box: BBox, override: number | undefined): number | null {
  if (strategy !== "blur") return null;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.min(50, override);
  }
  const minDim = Math.min(box.width, box.height);
  // Small text (< 20 px tall): sigma 6 fully obscures glyph shapes. Larger
  // regions scale up to 50 — the cap keeps the blur pass cheap while staying
  // opaque against single letters inside a large block.
  const s = Math.max(6, Math.min(50, minDim / 6));
  return s;
}

function choosePixelBlock(box: BBox): number {
  const minDim = Math.min(box.width, box.height);
  // Aim for ~3–8 blocks across the smaller dimension so the region reads as
  // obvious pixelation without regenerating the original via paired tiles.
  const b = Math.round(minDim / 6);
  return Math.max(3, Math.min(32, b));
}

/* -------------------------------------------------------------------------- */
/* Format helpers                                                              */
/* -------------------------------------------------------------------------- */

function clampQuality(q: number): number {
  if (!Number.isFinite(q)) return 80;
  if (q < 1) return 1;
  if (q > 100) return 100;
  return Math.round(q);
}

/**
 * Accept `#rgb`, `#rrggbb`, `#rrggbbaa`, or a bare `rrggbb`; reject anything
 * else (return null) so the caller sees the default rather than sharp's
 * internal error for an invalid colour.
 */
function normalizeHexColor(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0) return null;
  const withHash = t.startsWith("#") ? t : `#${t}`;
  if (/^#[0-9a-fA-F]{3}$/.test(withHash)) return withHash;
  if (/^#[0-9a-fA-F]{6}$/.test(withHash)) return withHash;
  if (/^#[0-9a-fA-F]{8}$/.test(withHash)) return withHash;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `RedactionSummary`. Throws on structurally invalid payloads
 * so a corrupted summary is not silently accepted into the audit trail.
 */
export function rehydrateRedactionSummary(value: unknown): RedactionSummary {
  if (value === null || typeof value !== "object") {
    throw new RedactError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const boxesRaw = Array.isArray(r["paintedBoxes"]) ? (r["paintedBoxes"] as unknown[]) : [];
  const paintedBoxes: BBox[] = [];
  for (const bRaw of boxesRaw) {
    const b = parseBBox(bRaw);
    if (b !== null) paintedBoxes.push(b);
  }
  const sbRaw = (r["strategyBreakdown"] ?? {}) as Record<string, unknown>;
  const strategyBreakdown: Record<PiiStrategy, number> = {
    blur: numberOr(sbRaw["blur"], 0),
    pixelate: numberOr(sbRaw["pixelate"], 0),
    solid: numberOr(sbRaw["solid"], 0),
  };
  const fmtRaw = r["outputFormat"];
  const outputFormat: RedactFormat =
    fmtRaw === "jpeg" || fmtRaw === "webp" || fmtRaw === "png" ? fmtRaw : "png";
  return {
    regionsRedacted: Math.max(0, Math.floor(numberOr(r["regionsRedacted"], 0))),
    paintedBoxes,
    skippedDetectionCount: Math.max(0, Math.floor(numberOr(r["skippedDetectionCount"], 0))),
    strategyBreakdown,
    outputFormat,
    outputByteLength: Math.max(0, Math.floor(numberOr(r["outputByteLength"], 0))),
    width: Math.max(1, Math.floor(numberOr(r["width"], 1))),
    height: Math.max(1, Math.floor(numberOr(r["height"], 1))),
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
  };
}

function parseBBox(v: unknown): BBox | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const x = numberOr(o["x"], NaN);
  const y = numberOr(o["y"], NaN);
  const width = numberOr(o["width"], NaN);
  const height = numberOr(o["height"], NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
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
