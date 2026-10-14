/**
 * Zipy AI — screenshot PII detection (vision-assisted, engine-agnostic).
 *
 * This module is the detection half of the "PII detection & blurring" feature
 * from Phase 10. It does NOT edit pixels; `redact.ts` performs the actual
 * blur/redaction. Keeping detection and mutation separate means:
 *
 *   - Bounding boxes and their provenance (`where`) can be surfaced in the
 *     post-generation editor without mutating the stored screenshot.
 *   - A reviewer can inspect the detections, adjust them, and *then* re-run
 *     the redactor. Nothing is destroyed silently.
 *   - The detection engine is pluggable. A vision model, an OCR-driven
 *     regex sweep, or both can be combined without the redactor caring.
 *
 * Detection engines supported (whichever the caller wires in):
 *
 *   1. **Text-based (OCR)** — the caller supplies OCR regions (with bounding
 *      boxes) for the screenshot. This module scans them for pattern matches
 *      by category. This is the default path when the screenshot already went
 *      through the ingest OCR stage.
 *   2. **Vision-based** — the caller supplies a VLM adapter (`VisionPiiProbe`).
 *      The adapter receives the image bytes and returns labelled bounding
 *      boxes. This is the higher-coverage path used when a VLM is configured.
 *
 * Both engines run when both are supplied. Results are merged with IoU-based
 * de-duplication; a text match that lands inside a vision box is folded into
 * the vision box (vision is more confident about *what* the region is, text
 * tells us *which* PII category is inside).
 *
 * Rules honoured here:
 *  - No invented detection results. Every box carries a `source` field
 *    naming the engine and the raw evidence (`matchedText`, `patternId`, or
 *    `visionLabel`). A reviewer can always ask "why was this flagged?".
 *  - No credentials, no network. The vision adapter is a caller-supplied
 *    callback; if none is configured, the vision path is skipped and the
 *    module does not pretend a vision engine ran.
 *  - Categories are user-extensible. `customPatterns` accepts caller-defined
 *    regexes and blur strategies.
 *  - Detections are deterministic for the same inputs. Pattern ordering is
 *    stable; IoU merging uses a deterministic tie-break.
 */

import type { BBox } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type PiiDetectErrorCode =
  | "invalid-input"
  | "invalid-pattern"
  | "probe-failed";

export class PiiDetectError extends Error {
  readonly code: PiiDetectErrorCode;
  constructor(message: string, code: PiiDetectErrorCode, cause?: unknown) {
    super(message);
    this.name = "PiiDetectError";
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Categories and strategies                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The canonical PII categories this module detects out of the box. A caller
 * may still attach a custom category by supplying `customPatterns`; that
 * category is not part of this closed set and its id is prefixed
 * `custom:` so downstream code can distinguish policy categories from
 * user-defined ones.
 */
export type PiiCategory =
  | "email"
  | "phone"
  | "person-name"
  | "credit-card"
  | "ssn"
  | "iban"
  | "ip-address"
  | "api-key"
  | "bearer-token"
  | "password-field"
  | "date-of-birth"
  | "postal-address"
  | "url-with-token"
  | "custom";

export type PiiStrategy = "blur" | "pixelate" | "solid";

/**
 * A single detected PII region on the screenshot. Coordinates are in *device*
 * pixels (i.e. already multiplied by the deviceScaleFactor the capture used),
 * because that is what the redactor and the annotation placement layer both
 * operate on.
 */
export interface PiiDetection {
  /** `<sourceKind>:<ordinal>`; deterministic within one detection run. */
  readonly id: string;
  readonly category: PiiCategory;
  /** For custom categories or user-supplied rules, the caller's rule id. */
  readonly ruleId: string | null;
  readonly bbox: BBox;
  /** 0..1 confidence. Text regex matches get patternDefault; vision gets the probe's score. */
  readonly confidence: number;
  readonly strategy: PiiStrategy;
  /** Which engine produced this detection. */
  readonly source: "ocr-text" | "vision" | "merged";
  /**
   * The literal text (or a truncated slice) that triggered this detection.
   * Redacted by the redactor at render time; kept here so the reviewer sees
   * *why* a region is flagged. Never persisted without encryption at rest.
   */
  readonly matchedText: string | null;
  /** Which pattern (from this module's built-ins) matched, when applicable. */
  readonly patternId: string | null;
  /** Which VLM label the probe returned, when applicable. */
  readonly visionLabel: string | null;
}

export interface PiiDetectionResult {
  readonly detections: readonly PiiDetection[];
  readonly detectionCount: number;
  readonly byCategory: Readonly<Record<PiiCategory, number>>;
  /** Diagnostics for the reviewer: why each engine did/did not contribute. */
  readonly engineReport: {
    readonly textEngine: "ran" | "skipped-no-ocr" | "ran-empty";
    readonly visionEngine: "ran" | "skipped-no-probe" | "ran-empty" | "probe-error";
    readonly probeError: string | null;
  };
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* OCR region input                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal OCR region shape this module reads. `@zipy/ingest/ocr` owns the
 * full shape; this declaration captures only the fields detection uses, so
 * the module does not have to track every future OCR field.
 */
export interface PiiTextRegion {
  readonly text: string;
  readonly bbox: BBox;
  /** 0..1 confidence from OCR; absent means "not scored". */
  readonly confidence?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Vision probe (caller-supplied)                                              */
/* -------------------------------------------------------------------------- */

/**
 * A rectangle a vision probe returns. Coordinates must be in *device* pixels
 * so they align with `PiiTextRegion.bbox`.
 */
export interface VisionPiiBox {
  readonly bbox: BBox;
  /** The probe's own label, e.g. "email", "name", "credit_card", "phone". */
  readonly label: string;
  /** 0..1 confidence. Values outside the range are clamped; NaN is rejected. */
  readonly confidence: number;
  /** Optional snippet of the recognised text the probe read. */
  readonly text?: string | null;
}

/**
 * The probe interface. The caller supplies an implementation, typically as a
 * thin wrapper around the vision model adapter. The module awaits it exactly
 * once per image; the caller is responsible for caching, retries, and cost.
 *
 * If the probe throws, `PiiDetectError("probe-failed")` is NOT propagated —
 * instead the engine report marks the vision engine as `probe-error` and the
 * detection continues with text-only results. A failed vision call must not
 * silently lose the OCR detections.
 */
export interface VisionPiiProbe {
  (input: {
    readonly imageBytes: Buffer;
    readonly mimeType: string;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly deviceScaleFactor: number;
  }): Promise<readonly VisionPiiBox[]>;
}

/* -------------------------------------------------------------------------- */
/* Custom pattern input                                                        */
/* -------------------------------------------------------------------------- */

export interface CustomPiiPattern {
  /** Stable id, e.g. "internal-account-id". Used in `PiiDetection.ruleId`. */
  readonly id: string;
  readonly description: string;
  /** A JS `RegExp`; its `source` and `flags` are read via `String()` for stability. */
  readonly pattern: RegExp;
  readonly strategy?: PiiStrategy;
  /** 0..1 default confidence assigned to a match of this pattern. Default 0.85. */
  readonly confidence?: number;
  /**
   * Optional category override: when supplied, detections from this pattern
   * use this category (any of `PiiCategory` or a free string — a non-canonical
   * string is normalised to "custom" and the rule id carries the distinction).
   */
  readonly category?: PiiCategory | string | null;
}

/* -------------------------------------------------------------------------- */
/* Detect options                                                              */
/* -------------------------------------------------------------------------- */

export interface DetectPiiOptions {
  /** When true, text-engine detection runs. Default true. */
  readonly useOcr?: boolean;
  /** Vision probe. When absent, the vision path is skipped entirely. */
  readonly probe?: VisionPiiProbe | null;
  /** MIME type of `imageBytes`, e.g. "image/png". Required when `probe` is set. */
  readonly mimeType?: string;
  /** Extra patterns; run in addition to the built-ins. */
  readonly customPatterns?: readonly CustomPiiPattern[];
  /**
   * Which built-in categories to scan for. When absent, all built-ins run.
   * Supplying a list is the right way to honour a per-workspace policy that
   * disables categories the customer does not deal with.
   */
  readonly enabledCategories?: readonly PiiCategory[];
  /**
   * IoU threshold above which a text match and a vision box are considered
   * the same detection. Default 0.35.
   */
  readonly mergeIoU?: number;
  /**
   * When true, a detection's `matchedText` carries the matched substring.
   * When false, only its length and category are retained. The caller sets
   * this to false when persisting detections in a store that must not hold
   * the plaintext, then surfaces the flag to the reviewer.
   */
  readonly keepMatchedText?: boolean;
}

export interface DetectPiiInput {
  readonly imageBytes: Buffer;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  /** OCR regions previously extracted from the image; empty when OCR has not run. */
  readonly ocrRegions?: readonly PiiTextRegion[] | null;
}

/* -------------------------------------------------------------------------- */
/* Built-in pattern table                                                      */
/* -------------------------------------------------------------------------- */

interface BuiltinPattern {
  readonly category: PiiCategory;
  readonly id: string;
  readonly re: RegExp;
  readonly strategy: PiiStrategy;
  readonly confidence: number;
}

/**
 * Built-in patterns. Each regex is anchored loosely (no `^`/`$`), because an
 * OCR region can contain a label followed by the PII value ("Email:
 * a@b.com"). Word boundaries are used where applicable so a partial match on
 * a longer token ("user@example.comx") does not flag the trailing nonsense.
 *
 * These patterns are deliberately conservative: false positives create a
 * blurred screenshot with no visible data in the region, which is safer than
 * a leaked secret. A reviewer can still un-blur a false positive in the
 * editor — the reverse is not recoverable.
 */
const BUILTIN_PATTERNS: readonly BuiltinPattern[] = [
  {
    category: "email",
    id: "email",
    // Multi-part TLD aware (foo@bar.co.uk).
    re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/i,
    strategy: "blur",
    confidence: 0.95,
  },
  {
    category: "credit-card",
    id: "credit-card",
    // 13–19 digits with optional spacing/hyphens; a following Luhn check is
    // applied by the caller through `isValidLuhn` (below) to cut false
    // positives from unrelated long digit strings.
    re: /\b(?:\d[ -]?){12,18}\d\b/,
    strategy: "solid",
    confidence: 0.9,
  },
  {
    category: "ssn",
    id: "ssn",
    re: /\b\d{3}-\d{2}-\d{4}\b/,
    strategy: "solid",
    confidence: 0.95,
  },
  {
    category: "phone",
    id: "phone",
    // International prefixes, US style, and common separators. Deliberately
    // broad — screenshots of CRM UIs are exactly where phone numbers appear.
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}[ .-]?\d{2,4}[ .-]?\d{2,4}\b/,
    strategy: "blur",
    confidence: 0.75,
  },
  {
    category: "ip-address",
    id: "ipv4",
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b/,
    strategy: "blur",
    confidence: 0.9,
  },
  {
    category: "api-key",
    id: "api-key-prefixed",
    // Common API key prefixes: sk_, pk_, rk_, ghp_, gho_, AKIA, xox[baprs]-
    re: /\b(?:sk|pk|rk)_[A-Za-z0-9]{16,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    strategy: "solid",
    confidence: 0.95,
  },
  {
    category: "bearer-token",
    id: "bearer-token",
    // "Bearer <token>" or a bare "Authorization: <token>" header dump.
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
    strategy: "solid",
    confidence: 0.95,
  },
  {
    category: "date-of-birth",
    id: "dob-iso",
    // ISO or slash-separated dates. Broad; a reviewer may un-blur.
    re: /\b(?:19|20)\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\b/,
    strategy: "blur",
    confidence: 0.6,
  },
  {
    category: "iban",
    id: "iban",
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/,
    strategy: "solid",
    confidence: 0.85,
  },
  {
    category: "url-with-token",
    id: "url-with-token",
    // A URL carrying a token/secret query parameter.
    re: /\bhttps?:\/\/[^\s]*(?:[?&](?:token|access_token|api_key|apikey|key|sig|signature|auth)=[^\s&#]+)/i,
    strategy: "solid",
    confidence: 0.9,
  },
  {
    category: "password-field",
    id: "password-label",
    // A label adjacent to a password input, where OCR captured the label but
    // not the masked dots. The bbox is the label region; the redactor blurs
    // toward the input when the annotation phase runs.
    re: /\b(?:password|passwd|pwd)\b\s*[:=]?/i,
    strategy: "solid",
    confidence: 0.7,
  },
];

/* -------------------------------------------------------------------------- */
/* Luhn check                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Luhn checksum for credit-card-shaped matches. Returns false for obviously
 * invalid numbers so the "credit-card" pattern does not flag long IDs.
 * Whitespace and hyphens are stripped first.
 */
export function isValidLuhn(candidate: string): boolean {
  const digits = candidate.replace(/[^0-9]/g, "");
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const ch = digits.charCodeAt(i) - 48;
    let d = ch;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Detect PII regions on a screenshot.
 *
 * When both engines are available, both run and their results are merged.
 * When only one is available, only that one runs — the engine report records
 * which paths were taken so the reviewer sees exactly what was checked.
 * Nothing is blurred here; `redact.ts` performs the mutation.
 */
export async function detectPii(
  input: DetectPiiInput,
  options: DetectPiiOptions = {},
): Promise<PiiDetectionResult> {
  if (input === null || typeof input !== "object") {
    throw new PiiDetectError("detectPii requires an input object.", "invalid-input");
  }
  if (!Buffer.isBuffer(input.imageBytes) || input.imageBytes.length === 0) {
    throw new PiiDetectError("imageBytes must be a non-empty Buffer.", "invalid-input");
  }
  if (
    typeof input.viewport?.width !== "number" ||
    typeof input.viewport?.height !== "number" ||
    input.viewport.width <= 0 ||
    input.viewport.height <= 0
  ) {
    throw new PiiDetectError("viewport must be { width > 0, height > 0 }.", "invalid-input");
  }
  if (
    typeof input.deviceScaleFactor !== "number" ||
    !Number.isFinite(input.deviceScaleFactor) ||
    input.deviceScaleFactor <= 0
  ) {
    throw new PiiDetectError("deviceScaleFactor must be a positive finite number.", "invalid-input");
  }

  const useOcr = options.useOcr !== false;
  const keepMatchedText = options.keepMatchedText !== false;
  const mergeIoU = clampRatio(options.mergeIoU ?? 0.35);
  const customPatterns = normaliseCustomPatterns(options.customPatterns ?? []);
  const enabled = normaliseEnabledCategories(options.enabledCategories);
  const builtins = enabled === null
    ? BUILTIN_PATTERNS
    : BUILTIN_PATTERNS.filter((p) => enabled.has(p.category) || p.category === "custom");

  const inputErrors: string[] = [];
  void inputErrors; // reserved for future per-engine input validation messages

  // ---------------------------------------------------------------------
  // Text engine
  // ---------------------------------------------------------------------
  let textEngine: PiiDetectionResult["engineReport"]["textEngine"];
  const textDetections: MutableDetection[] = [];
  if (!useOcr) {
    textEngine = "skipped-no-ocr";
  } else if (!Array.isArray(input.ocrRegions) || input.ocrRegions.length === 0) {
    textEngine = "skipped-no-ocr";
  } else {
    const text = runTextEngine(input.ocrRegions, builtins, customPatterns, keepMatchedText);
    textDetections.push(...text);
    textEngine = text.length === 0 ? "ran-empty" : "ran";
  }

  // ---------------------------------------------------------------------
  // Vision engine
  // ---------------------------------------------------------------------
  let visionEngine: PiiDetectionResult["engineReport"]["visionEngine"];
  let probeError: string | null = null;
  const visionDetections: MutableDetection[] = [];
  const probe = options.probe ?? null;
  if (probe === null) {
    visionEngine = "skipped-no-probe";
  } else if (typeof options.mimeType !== "string" || options.mimeType.length === 0) {
    // The probe needs a mime type; refusing is more helpful than guessing.
    throw new PiiDetectError(
      "A vision probe was supplied but `mimeType` is missing; the probe cannot be called without it.",
      "invalid-input",
    );
  } else {
    try {
      const raw = await probe({
        imageBytes: input.imageBytes,
        mimeType: options.mimeType,
        viewport: input.viewport,
        deviceScaleFactor: input.deviceScaleFactor,
      });
      const normalised = Array.isArray(raw) ? raw : [];
      for (const box of normalised) {
        const detection = normaliseVisionBox(box, input.viewport, input.deviceScaleFactor);
        if (detection !== null) visionDetections.push(detection);
      }
      visionEngine = visionDetections.length === 0 ? "ran-empty" : "ran";
    } catch (error) {
      visionEngine = "probe-error";
      probeError = error instanceof Error ? error.message : String(error);
    }
  }

  // ---------------------------------------------------------------------
  // Merge and renumber
  // ---------------------------------------------------------------------
  const merged = mergeDetections(textDetections, visionDetections, mergeIoU);
  const detections = finaliseDetections(merged);

  return {
    detections,
    detectionCount: detections.length,
    byCategory: tallyByCategory(detections),
    engineReport: {
      textEngine,
      visionEngine,
      probeError,
    },
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Text engine                                                                 */
/* -------------------------------------------------------------------------- */

interface MutableDetection {
  id: string;
  category: PiiCategory;
  ruleId: string | null;
  bbox: BBox;
  confidence: number;
  strategy: PiiStrategy;
  source: PiiDetection["source"];
  matchedText: string | null;
  patternId: string | null;
  visionLabel: string | null;
}

function runTextEngine(
  regions: readonly PiiTextRegion[],
  builtins: readonly BuiltinPattern[],
  customs: readonly NormalisedCustomPattern[],
  keepMatchedText: boolean,
): MutableDetection[] {
  const out: MutableDetection[] = [];
  for (const region of regions) {
    if (region === null || typeof region !== "object") continue;
    if (typeof region.text !== "string" || region.text.length === 0) continue;
    if (!isBBox(region.bbox)) continue;
    const ocrConfidence =
      typeof region.confidence === "number" && Number.isFinite(region.confidence)
        ? clampRatio(region.confidence)
        : null;
    // Built-ins first, then customs. Deterministic ordering of ids.
    for (const p of builtins) {
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      // Safety bound: 32 matches per region per pattern is ample for a
      // screenshot; a pathological OCR blob should not stall the worker.
      let guard = 0;
      while ((m = p.re.exec(region.text)) !== null && guard < 32) {
        guard += 1;
        const matched = m[0];
        // Credit card: run Luhn check to cut false positives.
        if (p.category === "credit-card" && !isValidLuhn(matched)) {
          if (m.index === p.re.lastIndex) p.re.lastIndex += 1;
          continue;
        }
        // A zero-width match would loop; the guard already caps it, but we
        // also skip emitting to avoid duplicate zero-area boxes.
        if (matched.length === 0) {
          p.re.lastIndex += 1;
          continue;
        }
        const confidence =
          ocrConfidence === null
            ? p.confidence
            : clampRatio(p.confidence * (0.5 + 0.5 * ocrConfidence));
        out.push({
          id: "",
          category: p.category,
          ruleId: null,
          bbox: roundBBox(region.bbox),
          confidence,
          strategy: p.strategy,
          source: "ocr-text",
          matchedText: keepMatchedText ? matched : null,
          patternId: p.id,
          visionLabel: null,
        });
        if (m.index === p.re.lastIndex) p.re.lastIndex += 1;
      }
    }
    for (const c of customs) {
      const re = new RegExp(c.re.source, c.re.flags.includes("g") ? c.re.flags : c.re.flags + "g");
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(region.text)) !== null && guard < 32) {
        guard += 1;
        const matched = m[0];
        if (matched.length === 0) {
          re.lastIndex += 1;
          continue;
        }
        const confidence =
          ocrConfidence === null
            ? c.confidence
            : clampRatio(c.confidence * (0.5 + 0.5 * ocrConfidence));
        out.push({
          id: "",
          category: c.category,
          ruleId: c.id,
          bbox: roundBBox(region.bbox),
          confidence,
          strategy: c.strategy,
          source: "ocr-text",
          matchedText: keepMatchedText ? matched : null,
          patternId: c.id,
          visionLabel: null,
        });
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Custom pattern normalisation                                                */
/* -------------------------------------------------------------------------- */

interface NormalisedCustomPattern {
  readonly id: string;
  readonly description: string;
  readonly re: RegExp;
  readonly strategy: PiiStrategy;
  readonly confidence: number;
  readonly category: PiiCategory;
}

const ALL_CATEGORIES: ReadonlySet<PiiCategory> = new Set([
  "email",
  "phone",
  "person-name",
  "credit-card",
  "ssn",
  "iban",
  "ip-address",
  "api-key",
  "bearer-token",
  "password-field",
  "date-of-birth",
  "postal-address",
  "url-with-token",
  "custom",
]);

function normaliseCustomPatterns(given: readonly CustomPiiPattern[]): NormalisedCustomPattern[] {
  const out: NormalisedCustomPattern[] = [];
  const seenIds = new Set<string>();
  for (const p of given) {
    if (p === null || typeof p !== "object") continue;
    if (typeof p.id !== "string" || p.id.length === 0) {
      throw new PiiDetectError("Custom pattern is missing a non-empty id.", "invalid-pattern");
    }
    if (seenIds.has(p.id)) {
      throw new PiiDetectError(
        `Custom pattern id "${p.id}" is duplicated; ids must be unique within a single detection run.`,
        "invalid-pattern",
      );
    }
    seenIds.add(p.id);
    if (!(p.pattern instanceof RegExp)) {
      throw new PiiDetectError(
        `Custom pattern "${p.id}" is not a RegExp.`,
        "invalid-pattern",
      );
    }
    const strategy: PiiStrategy =
      p.strategy === "pixelate" || p.strategy === "solid" ? p.strategy : "blur";
    const confidence =
      typeof p.confidence === "number" && Number.isFinite(p.confidence)
        ? clampRatio(p.confidence)
        : 0.85;
    const categoryRaw = p.category;
    const category: PiiCategory =
      typeof categoryRaw === "string" && ALL_CATEGORIES.has(categoryRaw as PiiCategory)
        ? (categoryRaw as PiiCategory)
        : "custom";
    out.push({
      id: p.id,
      description: typeof p.description === "string" ? p.description : "",
      re: p.pattern,
      strategy,
      confidence,
      category,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Vision box normalisation                                                    */
/* -------------------------------------------------------------------------- */

function normaliseVisionBox(
  box: VisionPiiBox,
  viewport: { readonly width: number; readonly height: number },
  dpr: number,
): MutableDetection | null {
  if (box === null || typeof box !== "object") return null;
  if (typeof box.label !== "string" || box.label.length === 0) return null;
  // The probe is documented to return device-pixel boxes. Guard against a
  // misconfigured probe returning CSS-pixel boxes by clamping to the device
  // viewport; a box that lands fully outside is dropped (nothing to redact).
  const deviceW = viewport.width * dpr;
  const deviceH = viewport.height * dpr;
  const b = box.bbox;
  if (
    typeof b?.x !== "number" ||
    typeof b?.y !== "number" ||
    typeof b?.width !== "number" ||
    typeof b?.height !== "number" ||
    b.width <= 0 ||
    b.height <= 0
  ) {
    return null;
  }
  if (b.x >= deviceW || b.y >= deviceH || b.x + b.width <= 0 || b.y + b.height <= 0) {
    return null;
  }
  const clamped = clampBBoxToBounds(b, deviceW, deviceH);
  if (clamped.width <= 0 || clamped.height <= 0) return null;
  const label = box.label.toLowerCase();
  const category = mapVisionLabel(label);
  const strategy: PiiStrategy =
    category === "credit-card" || category === "ssn" || category === "api-key" || category === "bearer-token"
      ? "solid"
      : "blur";
  const confidence =
    typeof box.confidence === "number" && Number.isFinite(box.confidence)
      ? clampRatio(box.confidence)
      : 0.5;
  return {
    id: "",
    category,
    ruleId: null,
    bbox: roundBBox(clamped),
    confidence,
    strategy,
    source: "vision",
    matchedText:
      typeof box.text === "string" && box.text.length > 0 ? box.text : null,
    patternId: null,
    visionLabel: box.label,
  };
}

/**
 * Map a vision label to a canonical category. Unknown labels collapse to
 * `person-name`, which is the safe default for the most common vision
 * detections (a name in a UI). A label that explicitly signals a custom
 * concept is not guessed at; it becomes `custom` and the caller reads
 * `visionLabel` from the detection.
 */
function mapVisionLabel(label: string): PiiCategory {
  const l = label.replace(/[\s_-]+/g, " ").trim();
  if (l === "email" || l === "e-mail") return "email";
  if (l === "phone" || l === "phone number" || l === "mobile") return "phone";
  if (l === "name" || l === "person" || l === "person name" || l === "full name" || l === "author") {
    return "person-name";
  }
  if (l === "credit card" || l === "credit-card" || l === "card number" || l === "pan") {
    return "credit-card";
  }
  if (l === "ssn" || l === "social security number") return "ssn";
  if (l === "iban" || l === "account number" || l === "swift" || l === "bic") return "iban";
  if (l === "ip" || l === "ip address" || l === "ip-address") return "ip-address";
  if (l === "api key" || l === "api-key" || l === "secret" || l === "token") return "api-key";
  if (l === "bearer" || l === "bearer token") return "bearer-token";
  if (l === "password" || l === "passphrase") return "password-field";
  if (l === "dob" || l === "date of birth" || l === "birthday") return "date-of-birth";
  if (l === "address" || l === "postal address" || l === "postal-address") return "postal-address";
  if (l === "url" || l === "url with token") return "url-with-token";
  return "person-name";
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                       */
/* -------------------------------------------------------------------------- */

function mergeDetections(
  textDetections: readonly MutableDetection[],
  visionDetections: readonly MutableDetection[],
  mergeIoU: number,
): MutableDetection[] {
  const out: MutableDetection[] = [];

  // Vision boxes are kept first because they carry a *semantic* label; a
  // text match that lands inside one of them is folded into the vision box
  // (the vision engine says "what", text says "which PII category").
  const mergedIndexes = new Set<number>();
  for (const v of visionDetections) {
    out.push({ ...v });
  }

  for (const t of textDetections) {
    let mergedInto = -1;
    for (let i = 0; i < out.length; i += 1) {
      if (mergedIndexes.has(i)) continue;
      const v = out[i] as MutableDetection;
      const score = iou(v.bbox, t.bbox);
      if (score >= mergeIoU || containsBox(v.bbox, t.bbox)) {
        mergedInto = i;
        break;
      }
    }
    if (mergedInto === -1) {
      out.push({ ...t });
      continue;
    }
    const target = out[mergedInto] as MutableDetection;
    // Fold text evidence into the vision detection. Keep the vision bbox as
    // the canonical region (the vision engine usually returns a tighter box
    // for a UI element), but record the text pattern and matchedText for
    // reviewer transparency.
    out[mergedInto] = {
      ...target,
      source: "merged",
      // Category: prefer the vision category when it is not "person-name"
      // (the vision fallback); otherwise the text category wins because it is
      // more specific (an "@foo.com" match is unambiguously email).
      category:
        target.category === "person-name" && t.category !== "custom"
          ? t.category
          : target.category,
      confidence: Math.max(target.confidence, t.confidence),
      // Keep whichever strategy is the more aggressive of the two (solid >
      // pixelate > blur), so a certificate-grade redaction is not weakened by
      // a merge.
      strategy: sharperStrategy(target.strategy, t.strategy),
      matchedText: target.matchedText ?? t.matchedText,
      patternId: t.patternId,
      ruleId: t.ruleId,
    };
    mergedIndexes.add(mergedInto);
  }

  // Final pass: de-duplicate identical overlaps among *text* detections that
  // each matched a different pattern. Two detections with the same bbox and
  // the same category collapse; otherwise both are kept (a reviewer wants to
  // see that email AND phone were both detected in the same region).
  const deduped: MutableDetection[] = [];
  for (const d of out) {
    const existing = deduped.find(
      (e) =>
        e.category === d.category &&
        nearEqualBBox(e.bbox, d.bbox, 2) &&
        e.matchedText === d.matchedText,
    );
    if (existing === undefined) deduped.push(d);
  }
  return deduped;
}

const STRATEGY_RANK: Readonly<Record<PiiStrategy, number>> = {
  blur: 0,
  pixelate: 1,
  solid: 2,
};

function sharperStrategy(a: PiiStrategy, b: PiiStrategy): PiiStrategy {
  return STRATEGY_RANK[a] >= STRATEGY_RANK[b] ? a : b;
}

function finaliseDetections(md: readonly MutableDetection[]): PiiDetection[] {
  // Stable ordering: reading order (y then x) so the rendered blur order is
  // deterministic and the reviewer sees detections in the order they appear
  // on the image.
  const sorted = md.slice().sort((a, b) => {
    if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
    if (a.bbox.x !== b.bbox.x) return a.bbox.x - b.bbox.x;
    return a.category.localeCompare(b.category);
  });
  const out: PiiDetection[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const d = sorted[i] as MutableDetection;
    out.push({
      id: `${d.source}:${i}`,
      category: d.category,
      ruleId: d.ruleId,
      bbox: d.bbox,
      confidence: d.confidence,
      strategy: d.strategy,
      source: d.source,
      matchedText: d.matchedText,
      patternId: d.patternId,
      visionLabel: d.visionLabel,
    });
  }
  return out;
}

function tallyByCategory(detections: readonly PiiDetection[]): Readonly<Record<PiiCategory, number>> {
  const out: Record<PiiCategory, number> = {
    "email": 0,
    "phone": 0,
    "person-name": 0,
    "credit-card": 0,
    "ssn": 0,
    "iban": 0,
    "ip-address": 0,
    "api-key": 0,
    "bearer-token": 0,
    "password-field": 0,
    "date-of-birth": 0,
    "postal-address": 0,
    "url-with-token": 0,
    "custom": 0,
  };
  for (const d of detections) out[d.category] += 1;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Enabled categories                                                          */
/* -------------------------------------------------------------------------- */

function normaliseEnabledCategories(
  categories: readonly PiiCategory[] | undefined,
): ReadonlySet<PiiCategory> | null {
  if (categories === undefined) return null;
  const set = new Set<PiiCategory>();
  for (const c of categories) {
    if (typeof c !== "string") continue;
    if (ALL_CATEGORIES.has(c as PiiCategory)) set.add(c as PiiCategory);
  }
  if (set.size === 0) return new Set<PiiCategory>();
  return set;
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

function isBBox(b: unknown): b is BBox {
  if (b === null || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["x"] === "number" &&
    typeof o["y"] === "number" &&
    typeof o["width"] === "number" &&
    typeof o["height"] === "number" &&
    Number.isFinite(o["width"] as number) &&
    Number.isFinite(o["height"] as number) &&
    (o["width"] as number) > 0 &&
    (o["height"] as number) > 0
  );
}

function roundBBox(b: BBox): BBox {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(1, Math.round(b.width)),
    height: Math.max(1, Math.round(b.height)),
  };
}

function clampBBoxToBounds(b: BBox, w: number, h: number): BBox {
  const x = Math.max(0, Math.min(w, Math.floor(b.x)));
  const y = Math.max(0, Math.min(h, Math.floor(b.y)));
  const right = Math.max(x, Math.min(w, Math.ceil(b.x + b.width)));
  const bottom = Math.max(y, Math.min(h, Math.ceil(b.y + b.height)));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function intersectionArea(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function iou(a: BBox, b: BBox): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function containsBox(outer: BBox, inner: BBox): boolean {
  // Inner is contained when at least 90% of its area lies inside the outer.
  const inter = intersectionArea(outer, inner);
  const innerArea = inner.width * inner.height;
  if (innerArea <= 0) return false;
  return inter / innerArea >= 0.9;
}

function nearEqualBBox(a: BBox, b: BBox, tolerance: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
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
 * Read a persisted `PiiDetectionResult`. Throws on structurally invalid
 * payloads so a corrupted detection list cannot feed the redactor a
 * nonsense-ordered set.
 */
export function rehydratePiiDetectionResult(value: unknown): PiiDetectionResult {
  if (value === null || typeof value !== "object") {
    throw new PiiDetectError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const detectionsRaw = Array.isArray(r["detections"]) ? (r["detections"] as unknown[]) : [];
  const detections: PiiDetection[] = [];
  for (const dRaw of detectionsRaw) {
    if (dRaw === null || typeof dRaw !== "object") continue;
    const d = dRaw as Record<string, unknown>;
    if (typeof d["id"] !== "string") continue;
    const catRaw = typeof d["category"] === "string" ? (d["category"] as string) : "custom";
    const category: PiiCategory = ALL_CATEGORIES.has(catRaw as PiiCategory)
      ? (catRaw as PiiCategory)
      : "custom";
    const bbox = parseBBox(d["bbox"]);
    if (bbox === null) continue;
    const strategyRaw = d["strategy"];
    const strategy: PiiStrategy =
      strategyRaw === "pixelate" || strategyRaw === "solid" ? strategyRaw : "blur";
    const sourceRaw = d["source"];
    const source: PiiDetection["source"] =
      sourceRaw === "vision" || sourceRaw === "merged" || sourceRaw === "ocr-text"
        ? sourceRaw
        : "ocr-text";
    detections.push({
      id: d["id"] as string,
      category,
      ruleId: typeof d["ruleId"] === "string" ? (d["ruleId"] as string) : null,
      bbox,
      confidence:
        typeof d["confidence"] === "number" && Number.isFinite(d["confidence"] as number)
          ? clampRatio(d["confidence"] as number)
          : 0.5,
      strategy,
      source,
      matchedText: typeof d["matchedText"] === "string" ? (d["matchedText"] as string) : null,
      patternId: typeof d["patternId"] === "string" ? (d["patternId"] as string) : null,
      visionLabel: typeof d["visionLabel"] === "string" ? (d["visionLabel"] as string) : null,
    });
  }
  const reportRaw = (r["engineReport"] ?? {}) as Record<string, unknown>;
  const textRaw = reportRaw["textEngine"];
  const visionRaw = reportRaw["visionEngine"];
  const textEngine: PiiDetectionResult["engineReport"]["textEngine"] =
    textRaw === "ran" || textRaw === "ran-empty" || textRaw === "skipped-no-ocr"
      ? textRaw
      : "skipped-no-ocr";
  const visionEngine: PiiDetectionResult["engineReport"]["visionEngine"] =
    visionRaw === "ran" ||
    visionRaw === "ran-empty" ||
    visionRaw === "skipped-no-probe" ||
    visionRaw === "probe-error"
      ? visionRaw
      : "skipped-no-probe";
  return {
    detections,
    detectionCount: detections.length,
    byCategory: tallyByCategory(detections),
    engineReport: {
      textEngine,
      visionEngine,
      probeError: typeof reportRaw["probeError"] === "string" ? (reportRaw["probeError"] as string) : null,
    },
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
  };
}

function parseBBox(v: unknown): BBox | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o["x"] !== "number" ||
    typeof o["y"] !== "number" ||
    typeof o["width"] !== "number" ||
    typeof o["height"] !== "number"
  ) {
    return null;
  }
  if (!Number.isFinite(o["x"]) || !Number.isFinite(o["y"])) return null;
  if (!Number.isFinite(o["width"]) || !Number.isFinite(o["height"])) return null;
  if (o["width"] <= 0 || o["height"] <= 0) return null;
  return {
    x: Math.round(o["x"]),
    y: Math.round(o["y"]),
    width: Math.max(1, Math.round(o["width"])),
    height: Math.max(1, Math.round(o["height"])),
  };
}
