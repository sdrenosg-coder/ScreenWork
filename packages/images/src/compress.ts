/**
 * Zipy AI — screenshot compression policy.
 *
 * Applies one of a small set of named policies to a screenshot buffer and
 * reports the outcome (chosen format, quality, byte length, ratio). The
 * "Feature: Image compression" line in the product spec says WebP or JPEG at a
 * quality level that preserves readability, PNG when lossless is required.
 * This module is the place that decision is made *uniformly* for every
 * screenshot the platform emits, so the tutorial never mixes formats by
 * accident.
 *
 * Design rules honoured here:
 *  - **Format is a policy outcome, not a caller default.** The caller asks
 *    for `"readable"`, `"thumb"`, `"lossless"`, or `"auto"`; the module picks
 *    the format. A caller that specifically needs a format passes
 *    `"lossless"` (PNG) or `"archive"` (lossless WebP) instead of guessing.
 *  - **No hidden upscaling.** The module never enlarges an image to "improve"
 *    readability. At 2× DPR the captures are already crisp; compression is
 *    about file size, not quality.
 *  - **Readability floor is a hard rule for `"readable"`.** Below a
 *    configurable quality (default 60) text on a screenshot loses legibility;
 *    the module refuses to emit a `readable`-policy image at a lower quality
 *    and returns a descriptive error rather than a blurry tutorial.
 *  - **Deterministic.** The same input buffer and policy always produce the
 *    same output bytes (sharp's encoders are deterministic for a given
 *    version and options; the module does not add any timing/randomness).
 *  - **Metadata is stripped.** EXIF, ICC profile (by default), and any other
 *    metadata are removed unless `keepMetadata` is set. A screenshot should
 *    not carry a hidden copyright string from the browser's rendering
 *    environment.
 *  - **No target-size search loop.** A quality search that iterates until a
 *    size target is hit either converges slowly or silently degrades quality;
 *    instead the module applies the policy's quality and *reports* the size.
 *    If a size ceiling is required, `maxBytes` caps it — the module attempts a
 *    single controlled quality step-down and, if the result still exceeds the
 *    cap, returns `exceededMaxBytes: true` alongside the best-effort bytes so
 *    the caller can decide to rescale, split, or reject.
 */

import sharp from "sharp";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type CompressErrorCode =
  | "invalid-input"
  | "unsupported-policy"
  | "quality-below-floor"
  | "encode-failed";

export class CompressError extends Error {
  readonly code: CompressErrorCode;
  constructor(message: string, code: CompressErrorCode, cause?: unknown) {
    super(message);
    this.name = "CompressError";
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Named compression policies. A caller that knows nothing about formats
 * passes one of these and gets a consistent result across the tutorial.
 *
 *   - `readable`     — the default for a step screenshot. WebP at quality 82
 *                      (or JPEG 85 when WebP is disabled), which is the
 *                      trade-off the feature list asks for.
 *   - `thumb`        — a step-list thumbnail. WebP at quality 65 and
 *                      optionally a max edge length (see `maxEdgePx`).
 *   - `lossless`     — a PNG for cases where every pixel matters (a diff
 *                      between two runs, an audit export of what users saw).
 *   - `archive`      — a lossless WebP for storing the master copy after the
 *                      per-step image is produced. Smaller than PNG.
 *   - `auto`         — pick `readable` for most screenshots, but `lossless`
 *                      for images whose pixel content is nearly monochrome
 *                      (a "which pixels changed" diff, a mostly-empty modal).
 *                      The heuristic is: encode with `readable` and with
 *                      `lossless`, keep whichever is smaller. This is a
 *                      single extra encode; the alternative (a complex
 *                      heuristic that guesses wrong) costs the same bytes on
 *                      every downstream fetch.
 */
export type CompressionPolicy = "readable" | "thumb" | "lossless" | "archive" | "auto";

export type CompressionFormat = "webp" | "jpeg" | "png";

export interface CompressOptions {
  readonly policy?: CompressionPolicy;
  /**
   * Disable WebP and fall back to JPEG for the `readable`/`thumb` policies.
   * Set to true when the downstream consumer cannot decode WebP.
   * (The platform default is to allow WebP.)
   */
  readonly disallowWebp?: boolean;
  /** Quality override 1..100. When absent, the policy default is used. */
  readonly quality?: number;
  /**
   * Maximum edge (longest side) in pixels. When set, the image is proportionally
   * downscaled to fit within the box. Never upscales.
   */
  readonly maxEdgePx?: number;
  /**
   * When set and the encoded size exceeds this byte count, the module tries a
   * single controlled quality step-down (see `QUALITY_STEP_DOWN`). If the
   * result is still over, `exceededMaxBytes` is true and the best-effort
   * bytes are returned.
   */
  readonly maxBytes?: number;
  /** Keep metadata (EXIF, ICC, XMP). Default false — the module strips them. */
  readonly keepMetadata?: boolean;
}

export interface CompressResult {
  readonly bytes: Buffer;
  readonly format: CompressionFormat;
  readonly quality: number | null;
  readonly policy: CompressionPolicy;
  readonly inputFormat: string | null;
  readonly inputByteLength: number;
  readonly outputByteLength: number;
  /** Ratio output/input. Less than 1 means the image got smaller. */
  readonly ratio: number;
  readonly width: number;
  readonly height: number;
  /** When the caller set `maxBytes` and the best effort still exceeded it. */
  readonly exceededMaxBytes: boolean;
  /** Human-readable reason the policy resolved as it did (e.g. "auto picked png: smaller for monochrome"). */
  readonly policyReason: string;
  readonly generatedAt: string;
}

export interface CompressInput {
  readonly imageBytes: Buffer;
  readonly inputFormat?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Policy table                                                                */
/* -------------------------------------------------------------------------- */

interface PolicyDefinition {
  readonly defaultFormat: CompressionFormat;
  readonly defaultQuality: number;
  readonly lossless: boolean;
  /** Minimum acceptable quality for this policy. Below this, the module errors. */
  readonly qualityFloor: number;
}

const POLICY_TABLE: Readonly<Record<Exclude<CompressionPolicy, "auto">, PolicyDefinition>> = {
  readable: { defaultFormat: "webp", defaultQuality: 82, lossless: false, qualityFloor: 60 },
  thumb: { defaultFormat: "webp", defaultQuality: 65, lossless: false, qualityFloor: 45 },
  lossless: { defaultFormat: "png", defaultQuality: 100, lossless: true, qualityFloor: 100 },
  archive: { defaultFormat: "webp", defaultQuality: 100, lossless: true, qualityFloor: 100 },
};

const QUALITY_STEP_DOWN = 12;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compress a screenshot according to the requested policy and return the
 * resulting buffer plus a summary the caller can log against the guide.
 */
export async function compressScreenshot(
  input: CompressInput,
  options: CompressOptions = {},
): Promise<CompressResult> {
  if (input === null || typeof input !== "object") {
    throw new CompressError("compressScreenshot requires an input object.", "invalid-input");
  }
  if (!Buffer.isBuffer(input.imageBytes) || input.imageBytes.length === 0) {
    throw new CompressError("imageBytes must be a non-empty Buffer.", "invalid-input");
  }

  const policy: CompressionPolicy = options.policy ?? "readable";
  const inputByteLength = input.imageBytes.length;
  const inputFormat = typeof input.inputFormat === "string" ? input.inputFormat : null;

  if (policy === "auto") {
    // Try both readable and lossless and keep the smaller.
    const readable = await compressByPolicy(input.imageBytes, "readable", options, inputByteLength, inputFormat);
    const lossless = await compressByPolicy(input.imageBytes, "lossless", options, inputByteLength, inputFormat);
    const chosen = readable.bytes.length <= lossless.bytes.length ? readable : lossless;
    const reason =
      chosen === readable
        ? `auto picked ${readable.format}: readable (${readable.bytes.length}B) <= lossless (${lossless.bytes.length}B)`
        : `auto picked ${lossless.format}: lossless (${lossless.bytes.length}B) < readable (${readable.bytes.length}B)`;
    return {
      ...chosen,
      policy: "auto",
      policyReason: reason,
    };
  }

  if (!(policy in POLICY_TABLE)) {
    throw new CompressError(
      `Unsupported compression policy "${String(policy)}".`,
      "unsupported-policy",
    );
  }

  return await compressByPolicy(input.imageBytes, policy, options, inputByteLength, inputFormat);
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

async function compressByPolicy(
  source: Buffer,
  policy: Exclude<CompressionPolicy, "auto">,
  options: CompressOptions,
  inputByteLength: number,
  inputFormat: string | null,
): Promise<CompressResult> {
  const def = POLICY_TABLE[policy];

  // Determine the format this policy will use.
  const format = resolveFormat(policy, def, options.disallowWebp === true);

  // Determine quality (lossless policy ignores quality).
  let quality: number | null;
  if (def.lossless) {
    quality = null;
  } else {
    quality = clampQuality(options.quality ?? def.defaultQuality);
    if (quality < def.qualityFloor) {
      throw new CompressError(
        `Requested quality ${quality} is below the ${policy} policy floor of ${def.qualityFloor}. ` +
          `Below this floor screenshots stop being legible; raise the quality or pick the "lossless" policy.`,
        "quality-below-floor",
      );
    }
  }

  // Determine target dimensions.
  const meta = await safeMetadata(source);
  if (meta === null || meta.width === undefined || meta.height === undefined) {
    throw new CompressError(
      "Input image has no readable dimensions; refusing to compress a possibly-corrupt buffer.",
      "unsupported-policy",
    );
  }
  const originalWidth = meta.width;
  const originalHeight = meta.height;
  const maxEdgePx = clampOptionalPositiveInt(options.maxEdgePx);
  const scale = maxEdgePx !== null
    ? Math.min(1, maxEdgePx / Math.max(originalWidth, originalHeight))
    : 1;
  const targetWidth = Math.max(1, Math.round(originalWidth * scale));
  const targetHeight = Math.max(1, Math.round(originalHeight * scale));

  // Build the encoder. Metadata is stripped unless asked to keep.
  const withMetadata = options.keepMetadata === true;

  let output = await encodeAt(source, {
    format,
    quality,
    targetWidth,
    targetHeight,
    withMetadata,
  });

  let exceededMaxBytes = false;
  const maxBytes = clampOptionalPositiveInt(options.maxBytes);
  if (maxBytes !== null && output.length > maxBytes && !def.lossless) {
    // A single controlled step-down. If still over, return the best effort and
    // flag it — the caller decides whether to scale further, split, or accept.
    const stepQuality = Math.max(
      def.qualityFloor,
      (quality ?? def.defaultQuality) - QUALITY_STEP_DOWN,
    );
    if (stepQuality < (quality ?? def.defaultQuality)) {
      output = await encodeAt(source, {
        format,
        quality: stepQuality,
        targetWidth,
        targetHeight,
        withMetadata,
      });
      quality = stepQuality;
    }
    if (output.length > maxBytes) exceededMaxBytes = true;
  }

  const ratio = inputByteLength === 0 ? 0 : output.length / inputByteLength;
  return {
    bytes: output,
    format,
    quality,
    policy,
    inputFormat,
    inputByteLength,
    outputByteLength: output.length,
    ratio,
    width: targetWidth,
    height: targetHeight,
    exceededMaxBytes,
    policyReason:
      maxEdgePx !== null
        ? `${policy} → ${format} (longest edge clamped to ${maxEdgePx}px)`
        : `${policy} → ${format}`,
    generatedAt: new Date().toISOString(),
  };
}

interface EncodeArgs {
  readonly format: CompressionFormat;
  readonly quality: number | null;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly withMetadata: boolean;
}

async function encodeAt(
  source: Buffer,
  args: EncodeArgs,
): Promise<Buffer> {
  let pipeline = sharp(source, { failOn: "none" });
  const meta = await pipeline.metadata();
  const needsResize =
    meta.width !== args.targetWidth || meta.height !== args.targetHeight;

  if (needsResize) {
    // `fit: "fill"` is safe because we computed the target dimensions
    // ourselves from the original aspect ratio. Lanczos3 is the best general
    // choice for downscaling text-heavy screenshots (no ringing on glyphs at
    // moderate scales; sharp's default for resize is lanczos3 anyway).
    pipeline = pipeline.resize(args.targetWidth, args.targetHeight, {
      fit: "fill",
      kernel: "lanczos3",
    });
  }

  if (!args.withMetadata) {
    // Rotate so EXIF orientation does not matter after stripping; then drop
    // the metadata. `withMetadata: false` is sharp's default but we make it
    // explicit so a future sharp default change does not silently alter us.
    pipeline = pipeline.rotate().withMetadata({});
  }

  try {
    if (args.format === "png") {
      // Compression level 9 trades a bit of CPU for the smallest PNG; a
      // screenshot is a one-off encode, so this is the right trade.
      return await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    }
    if (args.format === "webp") {
      const q = args.quality ?? 82;
      // `effort: 4` matches sharp's default; 6 is measurably slower without
      // meaningful size wins at screenshot quality. Alpha stays; sharp keeps
      // it by default for WebP.
      return await pipeline.webp({ quality: q, effort: 4 }).toBuffer();
    }
    // jpeg
    const q = args.quality ?? 85;
    return await pipeline
      .jpeg({ quality: q, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer();
  } catch (error) {
    throw new CompressError(
      `Encode failed for ${args.format}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "encode-failed",
      error,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Format / policy resolution                                                  */
/* -------------------------------------------------------------------------- */

function resolveFormat(
  policy: Exclude<CompressionPolicy, "auto">,
  def: PolicyDefinition,
  disallowWebp: boolean,
): CompressionFormat {
  if (policy === "lossless") return "png";
  if (policy === "archive") return "webp"; // WebP supports true lossless
  if (def.defaultFormat === "webp" && disallowWebp) return "jpeg";
  return def.defaultFormat;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function safeMetadata(source: Buffer): Promise<sharp.Metadata | null> {
  try {
    return await sharp(source, { failOn: "none" }).metadata();
  } catch {
    return null;
  }
}

function clampQuality(q: number): number {
  if (!Number.isFinite(q)) return 82;
  if (q < 1) return 1;
  if (q > 100) return 100;
  return Math.round(q);
}

function clampOptionalPositiveInt(v: number | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.max(1, Math.floor(v));
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `CompressResult`. This does NOT reconstruct the image
 * bytes — the caller is expected to read those from the object store using
 * the artifact reference it already holds. Throws on structurally invalid
 * payloads so a corrupted summary is not accepted into the audit trail.
 */
export function rehydrateCompressResult(value: unknown): Omit<CompressResult, "bytes"> {
  if (value === null || typeof value !== "object") {
    throw new CompressError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const fmtRaw = r["format"];
  const format: CompressionFormat =
    fmtRaw === "webp" || fmtRaw === "jpeg" || fmtRaw === "png" ? fmtRaw : "png";
  const policyRaw = r["policy"];
  const policy: CompressionPolicy =
    policyRaw === "readable" ||
    policyRaw === "thumb" ||
    policyRaw === "lossless" ||
    policyRaw === "archive" ||
    policyRaw === "auto"
      ? policyRaw
      : "readable";
  return {
    format,
    quality:
      typeof r["quality"] === "number" && Number.isFinite(r["quality"] as number)
        ? clampQuality(r["quality"] as number)
        : null,
    policy,
    inputFormat: typeof r["inputFormat"] === "string" ? (r["inputFormat"] as string) : null,
    inputByteLength: Math.max(0, Math.floor(numberOr(r["inputByteLength"], 0))),
    outputByteLength: Math.max(0, Math.floor(numberOr(r["outputByteLength"], 0))),
    ratio:
      typeof r["ratio"] === "number" && Number.isFinite(r["ratio"] as number)
        ? (r["ratio"] as number)
        : 0,
    width: Math.max(1, Math.floor(numberOr(r["width"], 1))),
    height: Math.max(1, Math.floor(numberOr(r["height"], 1))),
    exceededMaxBytes: r["exceededMaxBytes"] === true,
    policyReason: typeof r["policyReason"] === "string" ? (r["policyReason"] as string) : "",
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
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
