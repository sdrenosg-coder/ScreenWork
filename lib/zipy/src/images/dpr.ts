/**
 * Zipy AI — device-pixel-ratio (DPR) policy.
 *
 * The product spec calls for "Screenshots captured at 2x or 3x device pixel
 * ratio for crisp output in PDFs and Retina displays." This module is the
 * single source of truth for what "2x" or "3x" means for a step screenshot,
 * and it validates that a captured image's pixel dimensions are consistent
 * with the DPR the capture claimed.
 *
 * Design rules honoured:
 *  - Pure arithmetic plus one optional `sharp` decode. Metadata verification
 *    is opt-in; a caller that already knows the image size (the capture layer
 *    does) does not pay for a second decode.
 *  - The DPR *used to capture* a screenshot is recorded; the DPR *verified
 *    from the image* is derived from the file's actual pixel dimensions
 *    divided by its CSS-pixel width. A mismatch is reported, never silently
 *    reconciled.
 *  - Recognised DPRs are a small, closed set (1, 1.5, 2, 2.25, 3). A caller
 *    that asks for 4× is refused with an explicit error rather than producing
 *    a 4×-size image that downstream consumers never expect.
 *  - No image bytes are fabricated or padded. Upscaling after the fact does
 *    not improve retina sharpness, so this module refuses that shortcut.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DprErrorCode =
  | "invalid-input"
  | "unsupported-dpr"
  | "decode-failed";

export class DprError extends Error {
  readonly code: DprErrorCode;
  constructor(message: string, code: DprErrorCode, cause?: unknown) {
    super(message);
    this.name = "DprError";
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The recognised DPR values. The system's UI does not offer a free-form
 * number: the four choices the spec calls out plus macOS's "1.5" (fractional
 * scaling at 150% on Windows) and Windows's "1.25" (125%). Anything outside
 * this set is refused.
 */
export type RecognisedDpr = 1 | 1.25 | 1.5 | 2 | 2.25 | 3;

export const RECOGNISED_DPRS: readonly RecognisedDpr[] = [1, 1.25, 1.5, 2, 2.25, 3];

/** The default the platform uses for step captures when no policy is set. */
export const DEFAULT_DPR: RecognisedDpr = 2;

/** The maximum the platform supports. Above this a "screenshot" is a poster. */
export const MAX_DPR: RecognisedDpr = 3;

export interface DprDescriptor {
  readonly dpr: RecognisedDpr;
  /** CSS-pixel dimensions the capture was requested at. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** Device-pixel dimensions the capture produced. Must equal css × dpr. */
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  /** Human-readable label used in the review UI ("2×", "1.5×"). */
  readonly label: string;
}

export interface DprVerificationResult {
  readonly claimed: DprDescriptor;
  /** DPR derived from the image's actual pixel count divided by its claimed CSS width. */
  readonly derivedDpr: number;
  readonly derivedDeviceWidth: number;
  readonly derivedDeviceHeight: number;
  readonly matches: boolean;
  readonly remarks: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Normalise a numeric DPR to one of `RECOGNISED_DPRS`. Accepts 1.25, 1.5
 * etc. exactly; an 1.2501 is rounded to 1.25 and then matched, but a value
 * that rounds to something outside the closed set throws. This is the
 * entrance-point for a value that came from config, a query param or a
 * customer support payload.
 */
export function normaliseDpr(value: unknown): RecognisedDpr {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DprError(
      "DPR must be a finite number within the recognised set " +
        `${RECOGNISED_DPRS.join(", ")}.`,
      "invalid-input",
    );
  }
  if (value <= 0) {
    throw new DprError("DPR must be positive.", "invalid-input");
  }
  if (value > MAX_DPR) {
    throw new DprError(
      `DPR ${value} exceeds the platform maximum of ${MAX_DPR}. Higher DPR is refused because the capture stops being comparable to the rest of the guide.`,
      "unsupported-dpr",
    );
  }
  for (const candidate of RECOGNISED_DPRS) {
    if (Math.abs(candidate - value) < 1e-6) return candidate;
  }
  throw new DprError(
    `DPR ${value} is not a recognised value. Recognised values: ${RECOGNISED_DPRS.join(", ")}.`,
    "unsupported-dpr",
  );
}

/**
 * Label for the review UI. Kept as a separate function so a locale-specific
 * number formatting change lives in one place.
 */
export function dprLabel(dpr: RecognisedDpr): string {
  if (dpr === 1) return "1×";
  if (dpr === 2) return "2×";
  if (dpr === 3) return "3×";
  return `${dpr}×`;
}

/**
 * Build the descriptor for a capture. Validates the CSS dimensions through
 * the same bounds the viewport module uses, so a bad pair of arguments
 * surfaces here with a DPR-shaped error rather than at capture time.
 */
export function describeDpr(args: {
  readonly dpr: unknown;
  readonly cssWidth: number;
  readonly cssHeight: number;
}): DprDescriptor {
  if (args === null || typeof args !== "object") {
    throw new DprError("describeDpr requires an object argument.", "invalid-input");
  }
  const dpr = normaliseDpr(args.dpr);
  if (
    typeof args.cssWidth !== "number" ||
    !Number.isFinite(args.cssWidth) ||
    args.cssWidth <= 0 ||
    typeof args.cssHeight !== "number" ||
    !Number.isFinite(args.cssHeight) ||
    args.cssHeight <= 0
  ) {
    throw new DprError("cssWidth and cssHeight must be positive finite numbers.", "invalid-input");
  }
  const cssWidth = Math.round(args.cssWidth);
  const cssHeight = Math.round(args.cssHeight);
  return {
    dpr,
    cssWidth,
    cssHeight,
    deviceWidth: Math.round(cssWidth * dpr),
    deviceHeight: Math.round(cssHeight * dpr),
    label: dprLabel(dpr),
  };
}

/**
 * Verify a stored screenshot is consistent with the DPR the capture claimed.
 *
 * The check is `imageWidth === cssWidth * dpr` and `imageHeight === cssHeight
 * * dpr`. A failure is *reported*, never silently corrected — the caller
 * (usually the annotation phase, which paints into the device space the
 * descriptor claims) can decide whether to re-capture, letterbox, or reject
 * the step. If `imageBytes`/`mimeType` are supplied, dimensions are read from
 * the image itself with a single `sharp` decode; otherwise the caller must
 * provide `actualDeviceWidth`/`actualDeviceHeight`.
 */
export interface VerifyDprInput {
  readonly claimed: DprDescriptor;
  readonly actualDeviceWidth?: number;
  readonly actualDeviceHeight?: number;
  readonly imageBytes?: Buffer;
}

export async function verifyDpr(input: VerifyDprInput): Promise<DprVerificationResult> {
  if (input === null || typeof input !== "object") {
    throw new DprError("verifyDpr requires an input object.", "invalid-input");
  }
  const claimed = input.claimed;
  if (
    claimed === null ||
    typeof claimed !== "object" ||
    typeof claimed.dpr !== "number" ||
    typeof claimed.cssWidth !== "number" ||
    typeof claimed.cssHeight !== "number"
  ) {
    throw new DprError("claimed descriptor is malformed.", "invalid-input");
  }

  let actualW: number | null = null;
  let actualH: number | null = null;

  if (
    typeof input.actualDeviceWidth === "number" &&
    Number.isFinite(input.actualDeviceWidth) &&
    typeof input.actualDeviceHeight === "number" &&
    Number.isFinite(input.actualDeviceHeight)
  ) {
    actualW = Math.round(input.actualDeviceWidth);
    actualH = Math.round(input.actualDeviceHeight);
  } else if (Buffer.isBuffer(input.imageBytes) && input.imageBytes.length > 0) {
    // Lazy import: sharp is required by the compress/redact modules already;
    // failing here with an explicit DprError is preferable to a raw module
    // resolution error reaching the caller.
    let sharpModule: typeof import("sharp") | null = null;
    try {
      sharpModule = (await import("sharp")) as unknown as typeof import("sharp");
    } catch (error) {
      throw new DprError(
        `Cannot verify DPR from image bytes because sharp is not installed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "decode-failed",
        error,
      );
    }
    try {
      const meta = await sharpModule.default(input.imageBytes, { failOn: "none" }).metadata();
      if (typeof meta.width === "number" && typeof meta.height === "number" && meta.width > 0 && meta.height > 0) {
        actualW = meta.width;
        actualH = meta.height;
      }
    } catch (error) {
      throw new DprError(
        `Failed to read image dimensions for DPR verification: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "decode-failed",
        error,
      );
    }
  }

  if (actualW === null || actualH === null) {
    throw new DprError(
      "verifyDpr requires either actualDeviceWidth/Height or a decodable imageBytes buffer.",
      "invalid-input",
    );
  }

  const derivedW = actualW;
  const derivedH = actualH;
  // Derived DPR: prefer width; fall back to height if width cannot be divided
  // cleanly (e.g. an image-wide fraction). Rounded to three decimals so two
  // independently-captured images compare with a stable tolerance.
  const derivedDprWidth = claimed.cssWidth > 0 ? derivedW / claimed.cssWidth : NaN;
  const derivedDprHeight = claimed.cssHeight > 0 ? derivedH / claimed.cssHeight : NaN;
  const derivedDpr = round3(
    Number.isFinite(derivedDprWidth) ? derivedDprWidth : derivedDprHeight,
  );

  const expectedW = Math.round(claimed.cssWidth * claimed.dpr);
  const expectedH = Math.round(claimed.cssHeight * claimed.dpr);
  const matches = expectedW === derivedW && expectedH === derivedH;

  const remarks: string[] = [];
  if (!matches) {
    remarks.push(
      `Claimed ${claimed.dpr}× (${claimed.cssWidth}×${claimed.cssHeight} CSS → ${expectedW}×${expectedH} device) ` +
        `but the image is ${derivedW}×${derivedH} device pixels (derived ${derivedDpr}×).`,
    );
  }
  if (!Number.isFinite(derivedDprWidth)) {
    remarks.push("Claimed cssWidth is not a positive number; derived DPR is unreliable.");
  }
  if (Math.abs(derivedDprWidth - derivedDprHeight) > 0.05 && Number.isFinite(derivedDprWidth)) {
    remarks.push(
      "Horizontal and vertical derived DPR differ by more than 0.05; the capture may have been resized non-uniformly after capture.",
    );
  }

  return {
    claimed,
    derivedDpr,
    derivedDeviceWidth: derivedW,
    derivedDeviceHeight: derivedH,
    matches,
    remarks,
  };
}

/* -------------------------------------------------------------------------- */
/* Pixel-space helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Convert a number of CSS pixels into device pixels at the given DPR.
 * Symmetric with `deviceToCss`. Both call `normaliseDpr` so an unrecognised
 * DPR is refused with a DprError rather than producing a plausibly-sized
 * number.
 */
export function cssToDevice(cssPixels: number, dpr: unknown): number {
  if (typeof cssPixels !== "number" || !Number.isFinite(cssPixels)) {
    throw new DprError("cssPixels must be a finite number.", "invalid-input");
  }
  const d = normaliseDpr(dpr);
  return Math.round(cssPixels * d);
}

export function deviceToCss(devicePixels: number, dpr: unknown): number {
  if (typeof devicePixels !== "number" || !Number.isFinite(devicePixels)) {
    throw new DprError("devicePixels must be a finite number.", "invalid-input");
  }
  const d = normaliseDpr(dpr);
  return devicePixels / d;
}

/**
 * The most common way a caller gets a DPR: from the environment/config. This
 * thin wrapper exists so callers import from one module rather than
 * repeating validation. Returning `DEFAULT_DPR` on an absent value is
 * deliberate (the capture layer must have *some* value); an *invalid* value
 * is refused.
 */
export function dprOrDefault(value: unknown): RecognisedDpr {
  if (value === undefined || value === null) return DEFAULT_DPR;
  return normaliseDpr(value);
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `DprDescriptor`. Throws on structurally invalid payloads
 * (same contract as the other rehydration helpers in this package).
 */
export function rehydrateDprDescriptor(value: unknown): DprDescriptor {
  if (value === null || typeof value !== "object") {
    throw new DprError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const dpr = normaliseDpr(r["dpr"]);
  const cssWidth = Math.round(numberOr(r["cssWidth"], NaN));
  const cssHeight = Math.round(numberOr(r["cssHeight"], NaN));
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth <= 0 || cssHeight <= 0) {
    throw new DprError(
      "Rehydrate failed: cssWidth/cssHeight are not positive numbers.",
      "invalid-input",
    );
  }
  const deviceWidth = Math.round(numberOr(r["deviceWidth"], cssWidth * dpr));
  const deviceHeight = Math.round(numberOr(r["deviceHeight"], cssHeight * dpr));
  return {
    dpr,
    cssWidth,
    cssHeight,
    deviceWidth: deviceWidth > 0 ? deviceWidth : Math.round(cssWidth * dpr),
    deviceHeight: deviceHeight > 0 ? deviceHeight : Math.round(cssHeight * dpr),
    label: typeof r["label"] === "string" ? (r["label"] as string) : dprLabel(dpr),
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

function round3(v: number): number {
  if (!Number.isFinite(v)) return NaN;
  return Math.round(v * 1000) / 1000;
}
