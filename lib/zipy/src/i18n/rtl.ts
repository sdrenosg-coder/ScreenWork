/**
 * Zipy AI — right-to-left script support (content-generation, multilingual batch 2).
 *
 * A guide can be translated into a right-to-left (RTL) language — Arabic,
 * Hebrew, Persian, Urdu, and a handful of minority scripts. The translation
 * layer produces the *string* in the target language; this module produces
 * the *layout contract* the export and viewer layers use to render it:
 *
 *   1. **Direction detection** — given a BCP-47 target locale tag, return
 *      `"rtl"`, `"ltr"` or `"auto"`. Detection is deterministic and based on
 *      the primary subtag plus a short, maintained list of script tags.
 *   2. **Paragraph direction** — the Unicode Bidi Algorithm needs a paragraph
 *      direction; a paragraph whose first strong character is RTL renders
 *      RTL. `resolveParagraphDirection` implements the UBA's P2/P3 rules
 *      in a locale-aware way: it prefers the paragraph's first strong
 *      character, falling back to the guide's target locale.
 *   3. **Bidi isolation** — inline code, URLs, file paths and Latin product
 *      names must not swallow surrounding punctuation when they appear in
 *      RTL prose. `isolateForBidi` wraps these spans with Unicode isolate
 *      controls (U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI) so the
 *      surrounding text lays out correctly regardless of the run's own
 *      direction.
 *   4. **Export metadata** — a `RtlLayout` object carries the `dir` and
 *      `lang` attributes for `<html>`, the correct CSS logical-property
 *      hints, and a list of any spans that should be wrapped with
 *      `<bdi>` in HTML output. This is what the export layer reads; it
 *      does not re-derive direction from the string.
 *
 * Design rules honoured:
 *  - No content is rewritten. The module adds Unicode controls and layout
 *    metadata; it never changes a lexical token, gives a word the wrong
 *    ending, or converts a term between scripts.
 *  - Deterministic. The direction decision, the paragraph resolver, and
 *    the isolate wrapper are pure functions of their inputs.
 *  - Faithful to UBA. Paragraph direction follows P2/P3 *as the standard
 *    defines them*: first strong character, default to LTR only when no
 *    strong character exists. The locale fallback is a per-guide override
 *    used by the caller, not a redefinition of UBA.
 *  - Renders correctly for both directions. The CSS hints are logical
 *    properties (`inline-start`, `inline-end`), not physical ones
 *    (`left`, `right`), so an LTR guide and an RTL guide share the same
 *    stylesheet.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type RtlErrorCode = "invalid-input" | "unknown-locale";

export class RtlError extends Error {
  readonly code: RtlErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: RtlErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export const TEXT_DIRECTIONS = ["ltr", "rtl", "auto"] as const;
export type TextDirection = (typeof TEXT_DIRECTIONS)[number];

export interface DirectionInfo {
  /** The direction to render the guide in. */
  readonly direction: TextDirection;
  /**
   * The `lang` attribute to emit (BCP-47). Canonicalised minimum: the
   * caller's input trimmed and casing normalised to `ll-CC` where both
   * subtags are present.
   */
  readonly lang: string;
  /** True when the primary subtag is in the maintained RTL list. */
  readonly isRtl: boolean;
  /**
   * Script subtag (four-letter, e.g. `Arab`, `Hebr`) when the caller
   * supplied an explicit script; `null` when the locale relied on the
   * primary-subtag mapping.
   */
  readonly script: string | null;
  /** A short human-readable note for the reviewer UI. */
  readonly note: string;
}

/**
 * The layout contract for one guide. Emitted once per guide, read by the
 * export templates and the viewer. The caller must not re-derive direction
 * from the text; it must read `layout.direction`.
 */
export interface RtlLayout {
  readonly version: "rtl/1";
  readonly targetLocale: string;
  readonly direction: TextDirection;
  readonly lang: string;
  /**
   * CSS logical-property hints for the viewer's stylesheet. Kept as a
   * literal record so the caller can serialise it directly into a
   * `<style>` tag or a JSX `style` prop.
   */
  readonly cssHints: Readonly<Record<string, string>>;
  /**
   * Attribute map for `<html>` / `<body>`. Callers spread this into the
   * server-rendered tag.
   */
  readonly attributes: Readonly<Record<string, string>>;
  /** ISO timestamp. */
  readonly generatedAt: string;
}

/**
 * A span in the source that should be isolated when rendered into RTL
 * prose. The export layer reads this list to decide which substrings to
 * wrap with Unicode isolates (for plain text) or `<bdi>` (for HTML).
 */
export interface BidiIsolationSpan {
  /** 0-based inclusive start offset in the input text. */
  readonly start: number;
  /** 0-based exclusive end offset. */
  readonly end: number;
  /** The exact substring. */
  readonly text: string;
  /** Why the span is isolated. */
  readonly reason:
    | "inline-code"
    | "url"
    | "file-path"
    | "identifier"
    | "number-with-punctuation";
  /** The direction the span's own content resolves to. */
    readonly runDirection: "ltr" | "rtl" | "neutral";
}

export interface BidiIsolationResult {
  readonly text: string;
  readonly spans: readonly BidiIsolationSpan[];
}

/* -------------------------------------------------------------------------- */
/* Locale → direction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The maintained list of RTL *language* primary subtags. The list covers
 * the languages the platform's customers have requested; a workspace can
 * add a locale the platform does not recognise by supplying an explicit
 * script subtag (e.g. `az-Arab`).
 */
const RTL_LANGUAGES: readonly string[] = Object.freeze([
  "ar", // Arabic
  "he", // Hebrew (modern)
  "iw", // Hebrew (legacy code)
  "fa", // Persian / Farsi
  "ur", // Urdu
  "ps", // Pashto
  "sd", // Sindhi
  "ug", // Uyghur
  "yi", // Yiddish
  "dv", // Dhivehi
  "ku", // Kurdish (covers ckb and kmr; Sorani is RTL, Kurmanji is LTR — caller can override)
  "ckb", // Central Kurdish / Sorani
  "nqo", // N'Ko
  "rhg", // Rohingya
  "prs", // Dari
  "bal", // Balochi
  "khw", // Khowar
  "ks", // Kashmiri
  "brh", // Brahui
]);

/**
 * The maintained list of RTL *script* subtags (four-letter, capitalised).
 * A locale with an explicit script subtag is directed by the script, not
 * the language. This lets `az-Arab` render RTL even though `az` is LTR.
 */
const RTL_SCRIPTS: readonly string[] = Object.freeze([
  "Arab",
  "Hebr",
  "Thaa",
  "Nkoo",
  "Syrc",
  "Samr",
  "Mand",
  "Mend",
  "Adlm",
  "Rohg",
]);

/**
 * Parse a BCP-47 tag into its primary subtag, script (four letters), and
 * region. Returns `null` when the tag is empty or malformed beyond repair.
 * Deliberately permissive: it accepts `en`, `en-US`, `ar`, `ar-EG`,
 * `zh-Hans-CN`, `az-Arab`, `sr-Cyrl-ME`. It does not accept private-use
 * tags or tags with more than three subtags, which the platform never
 * receives from a supported source.
 */
export interface ParsedLocale {
  readonly language: string;
  readonly script: string | null;
  readonly region: string | null;
}

export function parseLocale(input: string): ParsedLocale | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().replace(/_/g, "-");
  if (trimmed.length === 0) return null;
  const parts = trimmed.split("-").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const language = parts[0]!.toLowerCase();
  if (!/^[a-z]{2,3}$/u.test(language)) return null;
  let script: string | null = null;
  let region: string | null = null;
  for (let i = 1; i < parts.length && i <= 2; i += 1) {
    const p = parts[i]!;
    if (/^[A-Za-z]{4}$/u.test(p)) {
      script = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    } else if (/^[A-Za-z]{2}$/u.test(p) || /^\d{3}$/u.test(p)) {
      region = p.toUpperCase();
    }
  }
  return { language, script, region };
}

/**
 * Determine the direction for a target locale. Deterministic and pure. A
 * caller that wants to force a direction for a guide should set it in the
 * workspace's localisation settings; this function returns what the
 * locale implies.
 */
export function detectDirection(locale: string): DirectionInfo {
  if (typeof locale !== "string") {
    throw new RtlError("detectDirection requires a locale string.", "invalid-input");
  }
  const parsed = parseLocale(locale);
  if (parsed === null) {
    throw new RtlError(
      `detectDirection: "${locale}" is not a recognisable BCP-47 tag.`,
      "unknown-locale",
      { locale },
    );
  }

  const lang = [
    parsed.language,
    parsed.script,
    parsed.region,
  ]
    .filter((v): v is string => v !== null)
    .join("-");

  if (parsed.script !== null) {
    const isRtlScript = RTL_SCRIPTS.some((s) => s.toLowerCase() === parsed.script!.toLowerCase());
    return {
      direction: isRtlScript ? "rtl" : "ltr",
      lang,
      isRtl: isRtlScript,
      script: parsed.script,
      note: isRtlScript
        ? `Script subtag "${parsed.script}" renders right-to-left.`
        : `Script subtag "${parsed.script}" renders left-to-right.`,
    };
  }

  const isRtlLanguage = RTL_LANGUAGES.includes(parsed.language);
  return {
    direction: isRtlLanguage ? "rtl" : "ltr",
    lang,
    isRtl: isRtlLanguage,
    script: null,
    note: isRtlLanguage
      ? `Language "${parsed.language}" is in the platform's RTL language list.`
      : `Language "${parsed.language}" renders left-to-right. If the guide uses a non-Latin script (e.g. az-Arab), supply an explicit script subtag.`,
  };
}

/* -------------------------------------------------------------------------- */
/* RTL layout contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build the layout contract for a guide. The CSS hints prefer logical
 * properties so the same stylesheet serves both directions.
 */
export function buildRtlLayout(targetLocale: string): RtlLayout {
  const info = detectDirection(targetLocale);
  const dirAttr = info.direction === "auto" ? "auto" : info.direction;
  return {
    version: "rtl/1",
    targetLocale: info.lang,
    direction: info.direction,
    lang: info.lang,
    cssHints: {
      direction: info.direction === "auto" ? "inherit" : info.direction,
      "text-align": "start",
      "margin-inline-start": "0",
      "margin-inline-end": "0",
      "padding-inline-start": "0",
      "padding-inline-end": "0",
      // The viewer's annotation layer must place arrows and badges using
      // logical offsets; these hints name the two sides so the annotation
      // package can read them without re-deriving direction.
      "--zipy-inline-start": info.direction === "rtl" ? "right" : "left",
      "--zipy-inline-end": info.direction === "rtl" ? "left" : "right",
    },
    attributes: {
      lang: info.lang,
      dir: dirAttr,
    },
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Paragraph direction (UBA P2/P3)                                             */
/* -------------------------------------------------------------------------- */

/**
 * A small subset of Unicode bidi classes sufficient for paragraph
 * direction: `L` (left-to-right), `R` (right-to-left), `AL` (Arabic
 * letter), `EN`/`AN` (numbers, weak, ignored for P2), and everything else
 * treated as neutral.
 *
 * The classification is codepoint-range based, which is what the export
 * layer needs (a full UBA implementation is not required to honour P2/P3).
 * The ranges are drawn from the Unicode character database's bidi
 * properties for the writing systems the platform supports.
 */
type BidiClass = "L" | "R" | "AL" | "other";

function classify(codepoint: number): BidiClass {
  // Hebrew and related scripts — strong R.
  if (
    (codepoint >= 0x0590 && codepoint <= 0x05ff) || // Hebrew
    (codepoint >= 0x07c0 && codepoint <= 0x085f) || // NKo, Samaritan, Mandaic
    (codepoint >= 0xfb1d && codepoint <= 0xfb4f) || // Hebrew presentation forms
    (codepoint >= 0x10800 && codepoint <= 0x10fff) // Cypriot, Phoenician, ... (many are R)
  ) {
    return "R";
  }
  // Arabic and Syriac-derived scripts — strong AL.
  if (
    (codepoint >= 0x0600 && codepoint <= 0x06ff) || // Arabic
    (codepoint >= 0x0700 && codepoint <= 0x074f) || // Syriac
    (codepoint >= 0x0750 && codepoint <= 0x077f) || // Arabic Supplement
    (codepoint >= 0x08a0 && codepoint <= 0x08ff) || // Arabic Extended-A
    (codepoint >= 0xfb50 && codepoint <= 0xfdff) || // Arabic presentation forms A
    (codepoint >= 0xfe70 && codepoint <= 0xfeff) // Arabic presentation forms B
  ) {
    return "AL";
  }
  // Latin and other LTR alphabetic scripts.
  if (
    (codepoint >= 0x0041 && codepoint <= 0x005a) ||
    (codepoint >= 0x0061 && codepoint <= 0x007a) ||
    (codepoint >= 0x00c0 && codepoint <= 0x024f) || // Latin-1 supplement + Extended A/B
    (codepoint >= 0x0370 && codepoint <= 0x03ff) || // Greek
    (codepoint >= 0x0400 && codepoint <= 0x04ff) || // Cyrillic
    (codepoint >= 0x0530 && codepoint <= 0x058f) || // Armenian
    (codepoint >= 0x0900 && codepoint <= 0x0dff) || // Indic scripts
    (codepoint >= 0x0e00 && codepoint <= 0x0e7f) || // Thai
    (codepoint >= 0x0e80 && codepoint <= 0x0eff) || // Lao
    (codepoint >= 0x3040 && codepoint <= 0x9fff) || // Hiragana/Katakana/CJK
    (codepoint >= 0xac00 && codepoint <= 0xd7af) // Hangul
  ) {
    return "L";
  }
  return "other";
}

export interface ParagraphDirectionInput {
  readonly text: string;
  /**
   * The guide's target-locale direction. Used as the fallback when the
   * paragraph has no strong character (as UBA P3 requires) — a caller that
   * wants the strict-LTR default from UBA P3 should pass `"ltr"`.
   */
  readonly defaultDirection?: "ltr" | "rtl";
}

/**
 * Resolve a paragraph's base direction using UBA rules P2 and P3:
 *
 *  - P2: find the first character with bidi class L, AL or R.
 *  - P3: if the first strong character is L, the paragraph direction is
 *    LTR; if AL or R, the direction is RTL. If there is no strong
 *    character, the direction is the caller-supplied default (LTR by the
 *    standard; the guide's target locale by this call).
 *
 * Numeric runs and punctuation are neutral for this purpose and are
 * skipped, matching the standard.
 */
export function resolveParagraphDirection(
  input: ParagraphDirectionInput,
): "ltr" | "rtl" {
  if (input === null || typeof input !== "object") {
    throw new RtlError("resolveParagraphDirection requires an input object.", "invalid-input");
  }
  const text = typeof input.text === "string" ? input.text : "";
  const fallback = input.defaultDirection ?? "ltr";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const cls = classify(cp);
    if (cls === "L") return "ltr";
    if (cls === "R" || cls === "AL") return "rtl";
  }
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Bidi isolation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Locate spans that should be isolated when their container is RTL (or
 * mixed-direction). Recognised spans:
 *
 *   - inline code — backtick-delimited spans
 *   - URLs — `https?://…`
 *   - file paths — POSIX-esque paths starting with `/` or `./`
 *   - identifiers — dotted/snake/camel API identifiers that begin with an
 *     ASCII letter and contain only ASCII letters, digits, `.`, `_` or `-`
 *   - numbers with punctuation — phone-like strings, IP addresses and
 *     version numbers whose LTR run should not split a neighbouring RTL
 *     sentence
 *
 * The spans are returned as offset ranges into the *original* text.
 */
export function findBidiIsolationSpans(text: string): readonly BidiIsolationSpan[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const spans: BidiIsolationSpan[] = [];
  const push = (
    start: number,
    end: number,
    reason: BidiIsolationSpan["reason"],
  ): void => {
    if (end <= start) return;
    // Drop any span fully contained in an existing one.
    for (const s of spans) {
      if (start >= s.start && end <= s.end) return;
    }
    spans.push({
      start,
      end,
      text: text.slice(start, end),
      reason,
      runDirection: runDirectionOf(text.slice(start, end)),
    });
  };

  let m: RegExpExecArray | null;

  // Inline code first: the markers are ASCII, so a code span inside an RTL
  // paragraph is the classic example of a run that needs isolation.
  const inlineCode = /`[^`\n]*`/gu;
  while ((m = inlineCode.exec(text)) !== null) {
    push(m.index, m.index + m[0].length, "inline-code");
  }

  const url = /https?:\/\/[^\s`)>\]}"']+/gu;
  while ((m = url.exec(text)) !== null) {
    push(m.index, m.index + m[0].length, "url");
  }

  const filePath = /(?:^|[\s("'])((?:\/|\.\/|\.\.\/)[\p{L}\p{N}_.\-/]+)/gu;
  while ((m = filePath.exec(text)) !== null) {
    const group = m[1] ?? "";
    if (group.length === 0) continue;
    const start = m.index + m[0].length - group.length;
    push(start, start + group.length, "file-path");
  }

  // Dotted / snake / camel identifiers. Deliberately requires at least one
  // of `.`, `_` or `-` OR an all-caps run of 2+ letters followed by a dot —
  // so we do not swallow every word.
  const identifier = /(?<![\p{L}\p{N}_])([A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)+)(?![\p{L}\p{N}_])/gu;
  while ((m = identifier.exec(text)) !== null) {
    push(m.index, m.index + m[0].length, "identifier");
  }

  // Numbers with a punctuation separator that are likely to be an LTR run:
  // version numbers (1.2.3), IPs (10.0.0.1), phone-ish (555-123-4567).
  const numbery = /(?<![\p{L}\p{N}])(\d+(?:[.\-]\d+){1,7})(?![\p{L}\p{N}])/gu;
  while ((m = numbery.exec(text)) !== null) {
    push(m.index, m.index + m[0].length, "number-with-punctuation");
  }

  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Wrap every isolation span with the Unicode isolate controls that match
 * its own resolved run direction:
 *
 *   - LRI (U+2066) … PDI (U+2069) for an LTR run
 *   - RLI (U+2067) … PDI (U+2069) for an RTL run
 *   - FSI (U+2068) … PDI (U+2069) for a neutral or unresolved run
 *
 * The control characters are invisible; a calling code path that stores
 * the result in a DB column must not trim them. `stripBidiControls`
 * removes them for a plaintext paste.
 */
export function isolateForBidi(text: string): BidiIsolationResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: "", spans: [] };
  }
  const spans = findBidiIsolationSpans(text);
  if (spans.length === 0) {
    return { text, spans };
  }
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    out += isolateControlOpen(span.runDirection) + span.text + "\u2069";
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { text: out, spans };
}

/**
 * Strip every bidi control character from the input, including the ones
 * `isolateForBidi` inserted. Used when a caller must produce plain text
 * (plain-text email, a Markdown file without Unicode runs, JSON in a log
 * line).
 */
export function stripBidiControls(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/\uFEFF/gu, "");
}

/* -------------------------------------------------------------------------- */
/* Directives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The LLM-visible directive block. It is short: the model does not control
 * layout, and the more the model is told about punctuation, the more often
 * it "fixes" it in the wrong direction. The directive names the language,
 * the direction and the one rule the model can honour — do not insert
 * directional marks, do not translate DNT terms, and do not reorder a
 * sentence to make an LTR run read better.
 */
export function buildRtlDirectives(layout: RtlLayout): string {
  const lines: string[] = [];
  lines.push(
    `Target locale: ${layout.lang}. Writing direction: ${layout.direction === "rtl" ? "right-to-left" : "left-to-right"}.`,
  );
  if (layout.direction === "rtl") {
    lines.push(
      "Additional rules for right-to-left writing:",
      "    - Do not insert directional marks (LRM/RLM/LRE/RLE/PDF) or Unicode isolate controls; the export layer adds them from the source document structure.",
      "    - Do not reorder a sentence to make a Latin run (a product name, an inline code span, a URL) read more naturally. Keep the term in place and keep the sentence grammatical around it.",
      "    - Use the target language's own punctuation. Do not substitute ASCII commas, question marks or quotation marks for the language's native forms where the language requires them.",
      "    - Do not translate do-not-translate terms. They are supplied by the caller and appear verbatim in the output.",
    );
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Rehydrate                                                                   */
/* -------------------------------------------------------------------------- */

export function rehydrateRtlLayout(value: unknown): RtlLayout {
  if (value === null || typeof value !== "object") {
    throw new RtlError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const targetLocale = typeof r["targetLocale"] === "string" ? r["targetLocale"] : "";
  // Recompute from the locale so an outdated CSS-hint map does not leak an
  // old rule set into a viewer that has moved on. This is deliberate: the
  // layout is a pure function of the locale.
  const layout = buildRtlLayout(targetLocale);
  return {
    ...layout,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : layout.generatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function isolateControlOpen(direction: BidiIsolationSpan["runDirection"]): string {
  switch (direction) {
    case "ltr":
      return "\u2066"; // LRI
    case "rtl":
      return "\u2067"; // RLI
    default:
      return "\u2068"; // FSI
  }
}

function runDirectionOf(run: string): BidiIsolationSpan["runDirection"] {
  if (run.length === 0) return "neutral";
  for (const ch of run) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const cls = classify(cp);
    if (cls === "L") return "ltr";
    if (cls === "R" || cls === "AL") return "rtl";
  }
  return "neutral";
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  RTL_LANGUAGES,
  RTL_SCRIPTS,
  classify,
  isolateControlOpen,
  runDirectionOf,
});
