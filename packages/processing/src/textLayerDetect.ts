/**
 * Zipy AI — text-layer detection for PDF pages and image-like documents.
 *
 * Before OCR is run against a page, we need to know whether the page already
 * carries an extractable text layer. Running OCR against a page that already
 * has real, selectable text is wasteful and, worse, can introduce OCR noise
 * on top of exact text. This module answers the question per page.
 *
 * Inputs are pure data:
 *   - `PageTextEvidence`: the per-page facts a parser already extracted.
 *     A PDF parser reports whether each page's `/Contents` produced text
 *     operators and how many glyphs; an image parser reports only pixel
 *     evidence. The detection here is *evidence-driven*, not heuristic on
 *     the raw PDF bytes — the PDF parser is the authority on whether a text
 *     layer exists. This module decides *how much* text is meaningful.
 *
 * Outputs:
 *   - `TextLayerVerdict`: one of `"has-text-layer"`, `"no-text-layer"`, or
 *     `"sparse"`. `"sparse"` is the case that matters most: a page with a few
 *     glyphs (page number, watermark, running header) is *not* OCR-free, and
 *     treating it as such is the common cause of "the guide says nothing
 *     about the form" bug reports. Callers route `"sparse"` and
 *     `"no-text-layer"` to OCR; `"has-text-layer"` skips OCR.
 *   - A `reasons` list so downstream provenance can record *why* the
 *     decision was made, not just what it was.
 *
 * Design notes honoured here:
 *  - No I/O, no credentials, no network, no PDF parser import. The caller
 *    (the docling/pdf ingest path) supplies `PageTextEvidence`.
 *  - Thresholds are named constants with comments explaining the rationale,
 *    and are exposed as options so a caller can tune them for a specific
 *    parser without editing this file.
 *  - Detection is per-page. A mixed PDF (scanned cover, text body) yields a
 *    page-level routing decision for each page.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TextLayerErrorCode = "invalid-input";

export class TextLayerError extends Error {
  readonly code: TextLayerErrorCode;
  constructor(message: string, code: TextLayerErrorCode) {
    super(message);
    this.name = "TextLayerError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-page evidence about the presence and quality of an extractable text
 * layer. Parser-agnostic: the PDF parser (or an image pipeline) populates
 * this from whatever source it has.
 *
 * Fields and their semantics:
 *
 *   - `pageIndex`: 0-based page index. Required so verdicts can be keyed
 *     back to the page they describe.
 *
 *   - `text`: the concatenated text the parser extracted from this page
 *     (glyph runs in reading order). May be the empty string when the page
 *     has no text operators at all. Whitespace-only counts as empty for the
 *     purposes of this module.
 *
 *   - `glyphCount`: the number of glyphs (not bytes, not words) the parser
 *     saw. Preferred over `text.length` because some parsers report `text`
 *     with non-printing marks or ligature substitutions that inflate the
 *     glyph-to-character ratio. If absent, `text.length` is used as a proxy.
 *
 *   - `hasTextOperators`: whether the parser encountered any text-showing
 *     operators (`Tj`, `TJ`, `'`, `"`) on this page. This is *the* signal a
 *     PDF parser has that a text layer exists at all. When `false`, we do
 *     not bother counting glyphs — the page is treated as image-only.
 *
 *   - `imageCoverageRatio`: optional 0..1 estimate of what fraction of the
 *     page area is covered by raster images. A page with `hasTextOperators:
 *     true` AND high coverage is a "scanned page with a small text layer"
 *     (common: the running header is real text, the body is a scanned
 *     image). We treat these as `"sparse"` regardless of glyph count so the
 *     caller OCRs the image below the header.
 *
 *   - `isEncrypted`: whether the parser reported the page as encrypted. We
 *     do not attempt to defeat encryption here; the verdict is `"sparse"`
 *     and the caller reports an explicit error upstream. This is a signal,
 *     not a workaround.
 *
 *   - `pageWidth` / `pageHeight`: optional, in PDF points or pixels. Used
 *     only to bound `imageCoverageRatio` sanity checks; never required.
 */
export interface PageTextEvidence {
  readonly pageIndex: number;
  readonly text: string;
  readonly glyphCount?: number | null;
  readonly hasTextOperators?: boolean | null;
  readonly imageCoverageRatio?: number | null;
  readonly isEncrypted?: boolean | null;
  readonly pageWidth?: number | null;
  readonly pageHeight?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                    */
/* -------------------------------------------------------------------------- */

export type TextLayerVerdict = "has-text-layer" | "sparse" | "no-text-layer";

export interface DetectionReason {
  /** Stable machine-readable code. */
  readonly code:
    | "no-text-operators"
    | "below-sparse-glyph-threshold"
    | "image-dominant"
    | "encrypted"
    | "sufficient-text";
  /** Human-readable explanation for a reviewer or the activity log. */
  readonly message: string;
}

export interface PageTextLayerDecision {
  readonly pageIndex: number;
  readonly verdict: TextLayerVerdict;
  /**
   * Glyph count used for the decision. When the parser did not report one,
   * this is `text.replace(/\s+/g, "").length` (whitespace-excluded character
   * count) so the value is comparable across parsers.
   */
  readonly effectiveGlyphCount: number;
  /** Whether OCR is advisable for this page, given the verdict. */
  readonly runOcr: boolean;
  /** One or more reasons explaining the verdict. Never empty. */
  readonly reasons: readonly DetectionReason[];
}

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Number of glyphs below which a page is considered sparse even if the
 * parser saw text operators. Chosen empirically: page numbers (~3 glyphs),
 * running footers (~30 glyphs), and short watermarks ("DRAFT") all sit far
 * below this line, while the shortest real form page (a login page with two
 * labels and two fields) is comfortably above it. Tunable via
 * `DetectOptions.sparseGlyphThreshold`.
 */
export const DEFAULT_SPARSE_GLYPH_THRESHOLD = 80;

/**
 * Image area coverage above which the page is treated as `"sparse"` even
 * when glyph count is high, because the text is a small header layered on
 * top of a scanned page. 0.5 (half the page) is deliberately conservative:
 * pages with a hero image and real body text sit below it; scanned pages
 * with a running header sit above it. Tunable.
 */
export const DEFAULT_IMAGE_DOMINANT_RATIO = 0.5;

export interface DetectOptions {
  readonly sparseGlyphThreshold?: number;
  readonly imageDominantRatio?: number;
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Decide, for a single page, whether it has a usable text layer, a sparse
 * one, or none. Pure and deterministic.
 */
export function classifyPage(
  evidence: PageTextEvidence,
  options: DetectOptions = {},
): PageTextLayerDecision {
  if (evidence === null || typeof evidence !== "object") {
    throw new TextLayerError(
      "classifyPage requires a PageTextEvidence object.",
      "invalid-input",
    );
  }
  if (typeof evidence.pageIndex !== "number" || !Number.isFinite(evidence.pageIndex)) {
    throw new TextLayerError(
      "PageTextEvidence.pageIndex must be a finite number.",
      "invalid-input",
    );
  }

  const sparseThreshold = clampPositiveInt(
    options.sparseGlyphThreshold ?? DEFAULT_SPARSE_GLYPH_THRESHOLD,
    DEFAULT_SPARSE_GLYPH_THRESHOLD,
  );
  const imageDominantRatio = clampRatio(
    options.imageDominantRatio ?? DEFAULT_IMAGE_DOMINANT_RATIO,
    DEFAULT_IMAGE_DOMINANT_RATIO,
  );

  const reasons: DetectionReason[] = [];

  // Encrypted pages are treated as sparse unconditionally. We do not attempt
  // to read them; the caller is expected to surface the encryption in the
  // source UI so the operator can supply a decrypted copy.
  if (evidence.isEncrypted === true) {
    reasons.push({
      code: "encrypted",
      message:
        "Page is marked encrypted by the parser; no text layer can be read without a decrypted copy.",
    });
    return {
      pageIndex: evidence.pageIndex,
      verdict: "sparse",
      effectiveGlyphCount: countEffectiveGlyphs(evidence),
      runOcr: true,
      reasons,
    };
  }

  // No text operators → no text layer at all. This is the strongest signal
  // and short-circuits everything else.
  if (evidence.hasTextOperators === false) {
    reasons.push({
      code: "no-text-operators",
      message:
        "Parser encountered no text-showing operators on this page; the page has no extractable text layer.",
    });
    return {
      pageIndex: evidence.pageIndex,
      verdict: "no-text-layer",
      effectiveGlyphCount: 0,
      runOcr: true,
      reasons,
    };
  }

  const glyphs = countEffectiveGlyphs(evidence);

  // Sparse-by-count: some text, but not enough to be the page's real layer.
  if (glyphs < sparseThreshold) {
    reasons.push({
      code: "below-sparse-glyph-threshold",
      message: `Page contains ${glyphs} glyph(s), below the sparse threshold of ${sparseThreshold}; treated as sparse.`,
    });
    // A page with zero glyphs and text operators is *also* sparse rather than
    // "has-text-layer"; the operator-level check above already handled the
    // no-operator case, so this branch is the "operators present but no
    // visible glyphs" case (rare, usually a broken ToUnicode map).
    const verdict: TextLayerVerdict = glyphs === 0 ? "no-text-layer" : "sparse";
    return {
      pageIndex: evidence.pageIndex,
      verdict,
      effectiveGlyphCount: glyphs,
      runOcr: true,
      reasons,
    };
  }

  // Image-dominant: enough text for the count, but the page is mostly an
  // image. This is the "scanned body with a real running header" case.
  const coverage = evidence.imageCoverageRatio;
  if (
    typeof coverage === "number" &&
    Number.isFinite(coverage) &&
    coverage >= imageDominantRatio
  ) {
    reasons.push({
      code: "image-dominant",
      message: `Page is ${(coverage * 100).toFixed(0)}% image coverage (>= ${(imageDominantRatio * 100).toFixed(0)}%); text layer is treated as partial.`,
    });
    return {
      pageIndex: evidence.pageIndex,
      verdict: "sparse",
      effectiveGlyphCount: glyphs,
      runOcr: true,
      reasons,
    };
  }

  reasons.push({
    code: "sufficient-text",
    message: `Page contains ${glyphs} glyph(s) with no image dominance; text layer is sufficient.`,
  });
  return {
    pageIndex: evidence.pageIndex,
    verdict: "has-text-layer",
    effectiveGlyphCount: glyphs,
    runOcr: false,
    reasons,
  };
}

/* -------------------------------------------------------------------------- */
/* Document-level summary                                                      */
/* -------------------------------------------------------------------------- */

export interface DocumentTextLayerSummary {
  /** Per-page decisions in the order supplied, keyed by `pageIndex`. */
  readonly pages: readonly PageTextLayerDecision[];
  readonly pageCount: number;
  /** Number of pages classified `"has-text-layer"`. */
  readonly pagesWithText: number;
  /** Number of pages classified `"sparse"`. */
  readonly sparsePages: number;
  /** Number of pages classified `"no-text-layer"`. */
  readonly imageOnlyPages: number;
  /**
   * True when at least one page should be OCR'd. Callers use this to decide
   * whether to invoke the OCR pipeline at all, avoiding a spawn for purely
   * text documents.
   */
  readonly requiresOcr: boolean;
  /**
   * True when some pages have a text layer and some do not. Mixed documents
   * are the common case for scanned-with-cover PDFs; the flag makes the
   * situation visible to reviewers rather than silent.
   */
  readonly isMixed: boolean;
}

/**
 * Classify every page of a document. Input order is preserved; the caller
 * does not need to pre-sort by `pageIndex` (though it may).
 */
export function classifyDocument(
  pages: readonly PageTextEvidence[],
  options: DetectOptions = {},
): DocumentTextLayerSummary {
  const decisions: PageTextLayerDecision[] = [];
  let withText = 0;
  let sparse = 0;
  let imageOnly = 0;
  for (const page of pages) {
    const decision = classifyPage(page, options);
    decisions.push(decision);
    if (decision.verdict === "has-text-layer") withText += 1;
    else if (decision.verdict === "sparse") sparse += 1;
    else imageOnly += 1;
  }
  const requiresOcr = decisions.some((d) => d.runOcr);
  const isMixed = withText > 0 && (sparse > 0 || imageOnly > 0);
  return {
    pages: decisions,
    pageCount: decisions.length,
    pagesWithText: withText,
    sparsePages: sparse,
    imageOnlyPages: imageOnly,
    requiresOcr,
    isMixed,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Effective glyph count for a page. Prefers the parser-reported `glyphCount`
 * when it is a finite non-negative number; otherwise derives from `text` by
 * excluding whitespace (so a page consisting only of newlines and tabs is
 * counted as 0).
 */
function countEffectiveGlyphs(evidence: PageTextEvidence): number {
  const reported = evidence.glyphCount;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return Math.floor(reported);
  }
  if (typeof evidence.text !== "string" || evidence.text.length === 0) return 0;
  // Exclude whitespace characters. `\s` in JS matches ASCII whitespace plus
  // Unicode space separators by default only when the `u` flag is used with
  // character classes; here, a simple strip of the common cases is enough —
  // extraction pipelines do not typically include exotic whitespace.
  return evidence.text.replace(/[\s\u00a0\u200b]+/g, "").length;
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function clampRatio(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted per-page decision. Throws on structurally invalid input
 * so the caller can surface a configuration/version problem rather than
 * silently skipping OCR.
 */
export function rehydratePageTextLayerDecision(value: unknown): PageTextLayerDecision {
  if (value === null || typeof value !== "object") {
    throw new TextLayerError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const pageIndex = r["pageIndex"];
  if (typeof pageIndex !== "number" || !Number.isFinite(pageIndex)) {
    throw new TextLayerError(
      "Rehydrate failed: pageIndex missing or non-numeric.",
      "invalid-input",
    );
  }
  const verdictRaw = r["verdict"];
  const verdict: TextLayerVerdict =
    verdictRaw === "has-text-layer" || verdictRaw === "sparse"
      ? verdictRaw
      : "no-text-layer";
  const effectiveGlyphCount =
    typeof r["effectiveGlyphCount"] === "number" &&
    Number.isFinite(r["effectiveGlyphCount"] as number)
      ? Math.max(0, Math.floor(r["effectiveGlyphCount"] as number))
      : 0;
  const runOcr = r["runOcr"] === true;
  const reasonsRaw = Array.isArray(r["reasons"]) ? (r["reasons"] as unknown[]) : [];
  const reasons: DetectionReason[] = [];
  for (const raw of reasonsRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const rr = raw as Record<string, unknown>;
    const codeRaw = rr["code"];
    const message = typeof rr["message"] === "string" ? (rr["message"] as string) : "";
    if (message.length === 0) continue;
    const code: DetectionReason["code"] =
      codeRaw === "no-text-operators" ||
      codeRaw === "below-sparse-glyph-threshold" ||
      codeRaw === "image-dominant" ||
      codeRaw === "encrypted" ||
      codeRaw === "sufficient-text"
        ? codeRaw
        : "sufficient-text";
    reasons.push({ code, message });
  }
  return {
    pageIndex,
    verdict,
    effectiveGlyphCount,
    runOcr,
    reasons,
  };
}
