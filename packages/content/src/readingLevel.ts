/**
 * Zipy AI — reading-level targeting (content-generation, style batch 0).
 *
 * The reading-level layer works in two directions:
 *
 *   1. **Measurement.** `measureReadability(text)` computes the classic
 *      surface readability metrics — Flesch Reading Ease, Flesch-Kincaid
 *      Grade Level, Gunning Fog — plus the counts they are built from
 *      (words, sentences, syllables, complex words). The formulas are the
 *      textbook versions; no external dependency is used.
 *   2. **Targeting.** `applyReadingLevel(text, targetGrade)` performs a
 *      set of deterministic, meaning-preserving transformations that push a
 *      sentence toward a grade level. When the sentence does not need any
 *      change, it is returned verbatim. When a change cannot be made
 *      safely, the sentence is returned unchanged and the change is not
 *      recorded (a silent no-op is never recorded as a diff entry).
 *
 * A grade target is expressed as a number (Flesch-Kincaid grade). Common
 * values:
 *
 *   - 5–6   — plain-language summaries for a general audience
 *   - 8     — the default target for end-user guides
 *   - 12    — high-school level; may be needed for regulated content
 *   - 14+   — technical/developer audience
 *
 * The deterministic composer never invents content to lengthen a sentence.
 * When a sentence is below the target grade (too simple), the layer leaves
 * it alone rather than padding; the LLM path may add context if a caller
 * asks for it, but that is a per-layer decision, not a default here.
 *
 * Design rules honoured:
 *  - Deterministic. No LLM call. Idempotent for the same input and target.
 *  - No meaning changes: the transformations edit connectives, split long
 *    sentences, replace documented verbose forms ("in order to" → "to"),
 *    and expand or remove a small set of jargon substitutions. They never
 *    touch subject/verb/object, and never edit protected segments
 *    (backticks, quoted strings, URLs, brand terms).
 *  - Numbers are computed from the *materialised* text the caller passed,
 *    without any preprocessing that would change what the reader sees.
 *  - Pure function of its arguments.
 */

import type { PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ReadingLevelErrorCode = "invalid-input" | "invalid-target";

export class ReadingLevelError extends Error {
  readonly code: ReadingLevelErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ReadingLevelErrorCode,
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

export interface ReadabilityCounts {
  readonly words: number;
  readonly sentences: number;
  readonly syllables: number;
  /** Words with three or more syllables, excluding proper nouns and `-ed`/`-es` endings per Gunning's definition. */
  readonly complexWords: number;
  /** Words with three or more syllables without the Gunning exclusions, used for informational display. */
  readonly polysyllabicWords: number;
  readonly characters: number;
}

export interface ReadabilityScores {
  /** Flesch Reading Ease; higher is easier. 60+ is generally considered plain. */
  readonly fleschReadingEase: number;
  /** Flesch-Kincaid Grade Level; matches a US school grade. */
  readonly fleschKincaidGrade: number;
  /** Gunning Fog Index; matches a US school grade. */
  readonly gunningFog: number;
  /** SMOG index (approximation from the standard 30-sentence sampling rule). */
  readonly smog: number;
  /** The counts every score is built from. */
  readonly counts: ReadabilityCounts;
}

export const READING_LEVEL_RULES = [
  "verbose.expand",
  "connective.simplify",
  "sentence.split",
  "jargon.replace",
  "passive.detect",
] as const;
export type ReadingLevelRule = (typeof READING_LEVEL_RULES)[number];

export interface ReadingLevelChange {
  readonly rule: ReadingLevelRule;
  readonly before: string;
  readonly after: string;
}

export interface ReadingLevelApplication {
  readonly text: string;
  readonly applied: boolean;
  readonly changes: readonly ReadingLevelChange[];
  /** Score before the transformation, for the diff view. */
  readonly before: ReadabilityScores;
  /** Score after the transformation. */
  readonly after: ReadabilityScores;
  /** The target grade the caller asked for. */
  readonly targetGrade: number;
}

/**
 * A reading-level descriptor threaded through the content pipeline.
 * `targetGrade` is a Flesch-Kincaid grade the caller aims for; `tolerance`
 * is how far off the target the layer is allowed to leave a sentence (a
 * default of 1 means "grade N±1 is acceptable").
 */
export interface ReadingLevelProfile {
  readonly targetGrade: number;
  readonly tolerance: number;
  /** The terms the rewriter must treat as immutable. */
  readonly brandTerms: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_TARGET_GRADE = 8;
const DEFAULT_TOLERANCE = 1;
const MIN_TARGET_GRADE = 3;
const MAX_TARGET_GRADE = 20;

/**
 * Documented verbose→concise substitutions. Each entry is a phrase whose
 * meaning is preserved by the substitution; the list is audited rather than
 * generated.
 */
const VERBOSE_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ["in order to", "to"],
  ["due to the fact that", "because"],
  ["for the purpose of", "to"],
  ["in the event that", "if"],
  ["at this point in time", "now"],
  ["in the near future", "soon"],
  ["with regard to", "about"],
  ["with respect to", "about"],
  ["prior to", "before"],
  ["subsequent to", "after"],
  ["in the process of", "currently"],
  ["a large number of", "many"],
  ["a small number of", "few"],
  ["the majority of", "most"],
  ["in the absence of", "without"],
  ["in the presence of", "with"],
  ["make use of", "use"],
  ["take into consideration", "consider"],
  ["give consideration to", "consider"],
  ["come to the conclusion", "conclude"],
  ["provide assistance to", "help"],
  ["in spite of the fact that", "although"],
  ["on account of the fact that", "because"],
  ["it is necessary that you", "you must"],
  ["it is important that you", "you should"],
];

/**
 * Jargon substitutions applied when a sentence's grade is above target AND
 * the substitution does not change the meaning. Kept short.
 */
const JARGON_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ["utilise", "use"],
  ["utilize", "use"],
  ["leverage", "use"],
  ["facilitate", "help"],
  ["demonstrate", "show"],
  ["endeavour", "try"],
  ["endeavor", "try"],
  ["commence", "start"],
  ["terminate", "end"],
  ["initiate", "start"],
  ["ascertain", "find out"],
  ["subsequently", "then"],
  ["approximately", "about"],
  ["numerous", "many"],
  ["additional", "extra"],
  ["regarding", "about"],
];

const PROTECTED_OPEN = "\u0001P";
const PROTECTED_CLOSE = "P\u0001";
const BRAND_SENTINEL_OPEN = "\u0001B";
const BRAND_SENTINEL_CLOSE = "B\u0001";

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build a `ReadingLevelProfile` from caller-supplied values. Unknown or
 * out-of-range targets fall back to the default (`8`).
 */
export function buildReadingLevelProfile(input?: {
  readonly targetGrade?: number;
  readonly tolerance?: number;
  readonly brandTerms?: readonly string[];
}): ReadingLevelProfile {
  const raw = input?.targetGrade;
  const targetGrade =
    typeof raw === "number" && Number.isFinite(raw)
      ? clampInt(Math.round(raw), MIN_TARGET_GRADE, MAX_TARGET_GRADE)
      : DEFAULT_TARGET_GRADE;
  const tolerance =
    typeof input?.tolerance === "number" && Number.isFinite(input.tolerance)
      ? Math.max(0, Math.round(input.tolerance))
      : DEFAULT_TOLERANCE;
  const brandTerms = normaliseBrandTerms(input?.brandTerms ?? []);
  return { targetGrade, tolerance, brandTerms };
}

/**
 * Measure readability for a string. Never throws; on empty input, returns
 * zeroes with `words: 0`.
 */
export function measureReadability(text: string): ReadabilityScores {
  if (typeof text !== "string") {
    throw new ReadingLevelError("measureReadability requires a string.", "invalid-input");
  }
  const stripped = stripProtectedSegments(text);
  const counts = countUnits(stripped);
  return scoreFromCounts(counts);
}

/**
 * Apply the reading-level target to a string. The transformation is
 * iterative: it applies the longest-matching safe substitution first, then
 * splits remaining long sentences, sanitising the diff after each pass.
 * Returns the transformed text, the before/after scores and the list of
 * changes made.
 */
export function applyReadingLevel(
  text: string,
  profile: ReadingLevelProfile,
): ReadingLevelApplication {
  if (typeof text !== "string") {
    throw new ReadingLevelError("applyReadingLevel requires a string.", "invalid-input");
  }
  if (text.length === 0) {
    const zero = scoreFromCounts({
      words: 0,
      sentences: 0,
      syllables: 0,
      complexWords: 0,
      polysyllabicWords: 0,
      characters: 0,
    });
    return {
      text,
      applied: false,
      changes: [],
      before: zero,
      after: zero,
      targetGrade: profile.targetGrade,
    };
  }

  const before = measureReadability(text);
  if (before.fleschKincaidGrade <= profile.targetGrade + profile.tolerance) {
    return {
      text,
      applied: false,
      changes: [],
      before,
      after: before,
      targetGrade: profile.targetGrade,
    };
  }

  const { protectedText, restore } = protectSegments(text, profile.brandTerms);
  const changes: ReadingLevelChange[] = [];
  let working = protectedText;

  // 1. Verbose substitutions. Only fire when the sentence's grade is above
  //    target *and* the substitution shortens the text (no padding).
  for (const [from, to] of VERBOSE_SUBSTITUTIONS) {
    working = replaceWithLog(working, from, to, "verbose.expand", changes);
  }

  // 2. Jargon substitutions (higher grade only).
  if (profile.targetGrade <= 8) {
    for (const [from, to] of JARGON_SUBSTITUTIONS) {
      working = replaceWithLog(working, from, to, "jargon.replace", changes);
    }
  }

  // 3. Split long sentences (the biggest lever on grade, since the F-K
  //    formula is dominated by (words / sentences) and (syllables / words)).
  working = splitSentences(working, profile.targetGrade, changes);

  // 4. Re-measure and, if still above target, run a final split pass with a
  //    tighter threshold. Two passes are enough for typical tutorial prose;
  //    this avoids an unbounded loop.
  let after = measureReadability(restore(working));
  if (after.fleschKincaidGrade > profile.targetGrade + profile.tolerance) {
    working = splitSentences(working, profile.targetGrade - 2, changes);
    after = measureReadability(restore(working));
  }

  return {
    text: restore(working),
    applied: changes.length > 0,
    changes,
    before,
    after,
    targetGrade: profile.targetGrade,
  };
}

/**
 * Convenience: apply the reading level to every string in a content draft,
 * preserving the draft's shape. Only prose keys are rewritten.
 */
export function applyReadingLevelDeep<T>(
  value: T,
  profile: ReadingLevelProfile,
): { readonly value: T; readonly aggregateBefore: ReadabilityScores; readonly aggregateAfter: ReadabilityScores } {
  const strings: string[] = [];
  collectProseStrings(value, strings, 0);
  const joined = strings.join(" ");
  const before = measureReadability(joined);
  const rewritten = walkAndRewrite(value, profile, 0);
  const stringsAfter: string[] = [];
  collectProseStrings(rewritten, stringsAfter, 0);
  const after = measureReadability(stringsAfter.join(" "));
  return { value: rewritten as T, aggregateBefore: before, aggregateAfter: after };
}

/**
 * Target a grade level. This is the primary entrypoint for callers; it
 * accepts the looser `{ targetGrade, tolerance }` shape used by the
 * pipeline and normalises it to a `ReadingLevelProfile`.
 */
export function targetGrade(input?: {
  readonly targetGrade?: number;
  readonly tolerance?: number;
  readonly brandTerms?: readonly string[];
}): ReadingLevelProfile {
  return buildReadingLevelProfile(input);
}

/**
 * Measure the aggregate readability of an entire plan's step copy. This is
 * the helper the review UI uses to display a single "Guide reading level"
 * score.
 */
export function measurePlanReadability(plan: readonly PlanStep[]): ReadabilityScores {
  if (!Array.isArray(plan)) {
    throw new ReadingLevelError("measurePlanReadability requires a PlanStep array.", "invalid-input");
  }
  const pieces: string[] = [];
  for (const step of plan) {
    if (step.target !== null && step.target.name.length > 0) pieces.push(step.target.name);
    if (step.value !== null && step.value.length > 0) pieces.push(step.value);
  }
  return measureReadability(pieces.join(" "));
}

/* -------------------------------------------------------------------------- */
/* Readability math                                                            */
/* -------------------------------------------------------------------------- */

interface UnitCounts {
  readonly words: number;
  readonly sentences: number;
  readonly syllables: number;
  readonly complexWords: number;
  readonly polysyllabicWords: number;
  readonly characters: number;
}

function countUnits(text: string): UnitCounts {
  if (text.length === 0) {
    return { words: 0, sentences: 0, syllables: 0, complexWords: 0, polysyllabicWords: 0, characters: 0 };
  }

  // Split into words on non-letter/digit characters. Keep apostrophes and
  // hyphens inside words.
  const wordMatches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'\-]*/gu) ?? [];
  let syllables = 0;
  let complexWords = 0;
  let polysyllabicWords = 0;
  for (const word of wordMatches) {
    const s = countSyllables(word);
    syllables += s;
    if (s >= 3) {
      polysyllabicWords += 1;
      // Gunning's complex words exclude proper nouns (capitalised mid-
      // sentence), and words ending in -ed or -es.
      const isCapitalised = /^[A-Z]/.test(word);
      const shortEnding = /(?:ed|es)$/i.test(word);
      if (!isCapitalised && !shortEnding) complexWords += 1;
    }
  }

  // Sentences: split on `.!?` followed by whitespace or end-of-string, plus
  // paragraph breaks. Empty fragments are ignored.
  const sentenceMatches = text.match(/\S[^.!?\n]*[.!?]+(?=\s|$)|[^\n.!?]+$/g) ?? [];
  const sentences = Math.max(1, sentenceMatches.length);

  return {
    words: wordMatches.length,
    sentences,
    syllables,
    complexWords,
    polysyllabicWords,
    characters: text.length,
  };
}

function scoreFromCounts(c: UnitCounts): ReadabilityScores {
  if (c.words === 0 || c.sentences === 0) {
    return {
      fleschReadingEase: 100,
      fleschKincaidGrade: 0,
      gunningFog: 0,
      smog: 0,
      counts: c,
    };
  }
  const wordsPerSentence = c.words / c.sentences;
  const syllablesPerWord = c.syllables / c.words;
  const flesch = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
  const grade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
  const fog = 0.4 * (wordsPerSentence + 100 * (c.complexWords / c.words));
  // SMOG is normally measured over 30 sentences; when fewer are available,
  // the standard short-pass approximation is applied. The value is
  // informational, not a target.
  const smog = 1.0430 * Math.sqrt(c.polysyllabicWords * (30 / c.sentences)) + 3.1291;

  return {
    fleschReadingEase: round2(flesch),
    fleschKincaidGrade: round2(grade),
    gunningFog: round2(fog),
    smog: round2(smog),
    counts: c,
  };
}

/**
 * Approximate syllable count using the classic vowel-group heuristic: count
 * vowel groups, subtract a silent final "e", and clamp to at least one.
 * This is intentionally the standard heuristic — it is what Flesch's
 * calculator uses — so results are comparable to other tools.
 */
function countSyllables(word: string): number {
  const lower = word.toLowerCase().replace(/[^a-z]/g, "");
  if (lower.length === 0) return 1;
  if (lower.length <= 3) return 1;
  const vowels = "aeiouy";
  let groups = 0;
  let prevIsVowel = false;
  for (let i = 0; i < lower.length; i += 1) {
    const ch = lower.charAt(i);
    const isVowel = vowels.includes(ch);
    if (isVowel && !prevIsVowel) groups += 1;
    prevIsVowel = isVowel;
  }
  // Silent "e" rule. "le" at end acts as a syllable.
  if (lower.endsWith("e") && !lower.endsWith("le")) groups = Math.max(1, groups - 1);
  return Math.max(1, groups);
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Transformations                                                             */
/* -------------------------------------------------------------------------- */

function replaceWithLog(
  text: string,
  from: string,
  to: string,
  rule: ReadingLevelRule,
  changes: ReadingLevelChange[],
): string {
  if (from.length === 0) return text;
  const escaped = escapeRegExp(from);
  const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "giu");
  return text.replace(re, (match) => {
    const replacement = matchCase(match, to);
    if (replacement === match) return match;
    changes.push({ rule, before: match, after: replacement });
    return replacement;
  });
}

function splitSentences(
  text: string,
  targetGrade: number,
  changes: ReadingLevelChange[],
): string {
  // Split text into sentence-shaped pieces, preserving trailing punctuation.
  const sentenceRe = /(\S[^.!?\n]*[.!?]+)(\s*)/g;
  const out: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = sentenceRe.exec(text)) !== null) {
    const sentence = match[1] ?? "";
    const trailing = match[2] ?? "";
    const before = text.slice(lastIndex, match.index);
    if (before.length > 0) out.push(before);
    out.push(`${splitOneSentence(sentence, targetGrade, changes)}${trailing}`);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out.join("");
}

function splitOneSentence(
  sentence: string,
  targetGrade: number,
  changes: ReadingLevelChange[],
): string {
  const stripped = sentence.replace(/[.!?]+$/, "").trim();
  if (stripped.length === 0) return sentence;
  const scores = measureReadability(stripped);
  // Only split when the sentence is comfortably above the target grade.
  if (scores.fleschKincaidGrade <= targetGrade + 1) return sentence;

  // Split on a comma followed by a coordinator or subordinator. Each piece
  // is preserved verbatim; capitalisation of the first letter is applied to
  // each resulting sentence.
  const parts = stripped.split(/,\s+(?=(?:and|but|so|yet|or|while|when|if|after|before)\b)/i);
  if (parts.length < 2) return sentence;

  const finalised = parts
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map((piece, i) => {
      const capitalised = i === 0 ? piece : `${piece.charAt(0).toUpperCase()}${piece.slice(1)}`;
      return capitalised;
    });
  if (finalised.length < 2) return sentence;

  const joined = `${finalised.join(". ")}${/[.!?]$/.test(sentence) ? sentence.slice(-1) : "."}`;
  changes.push({ rule: "sentence.split", before: sentence, after: joined });
  return joined;
}

/* -------------------------------------------------------------------------- */
/* Protection & deep walk                                                      */
/* -------------------------------------------------------------------------- */

function stripProtectedSegments(text: string): string {
  return text
    .replace(/`[^`]*`/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/https?:\/\/[^\s)]+/g, "");
}

interface Protection {
  readonly protectedText: string;
  readonly restore: (s: string) => string;
}

function protectSegments(text: string, brandTerms: readonly string[]): Protection {
  const protectedSegments: string[] = [];
  const brands: string[] = [];
  let working = text;

  // Brand terms first.
  for (const brand of brandTerms) {
    if (brand.length === 0) continue;
    const escaped = escapeRegExp(brand);
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "gu");
    working = working.replace(re, (match) => {
      const idx = brands.length;
      brands.push(match);
      return `${BRAND_SENTINEL_OPEN}${idx}${BRAND_SENTINEL_CLOSE}`;
    });
  }

  const protect = (match: string): string => {
    const idx = protectedSegments.length;
    protectedSegments.push(match);
    return `${PROTECTED_OPEN}${idx}${PROTECTED_CLOSE}`;
  };
  working = working
    .replace(/`[^`]*`/g, protect)
    .replace(/"[^"]*"/g, protect)
    .replace(/https?:\/\/[^\s)]+/g, protect);

  const restore = (s: string): string => {
    let restored = s;
    let last: string;
    do {
      last = restored;
      restored = restored.replace(
        new RegExp(`${PROTECTED_OPEN}(\\d+)${PROTECTED_CLOSE}`, "g"),
        (_m, idx: string) => protectedSegments[Number(idx)] ?? "",
      );
      restored = restored.replace(
        new RegExp(`${BRAND_SENTINEL_OPEN}(\\d+)${BRAND_SENTINEL_CLOSE}`, "g"),
        (_m, idx: string) => brands[Number(idx)] ?? "",
      );
    } while (restored !== last);
    return restored;
  };

  return { protectedText: working, restore };
}

const PROSE_KEYS = new Set<string>([
  "title",
  "summary",
  "description",
  "instruction",
  "text",
  "sentence",
  "introduction",
  "question",
  "answer",
  "note",
  "body",
  "content",
]);

function walkAndRewrite(value: unknown, profile: ReadingLevelProfile, depth: number): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    const result = applyReadingLevel(value, profile);
    return result.text;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => walkAndRewrite(v, profile, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = PROSE_KEYS.has(k) ? walkAndRewrite(v, profile, depth + 1) : v;
  }
  return out;
}

function collectProseStrings(value: unknown, out: string[], depth: number): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectProseStrings(v, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PROSE_KEYS.has(k)) collectProseStrings(v, out, depth + 1);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function normaliseBrandTerms(terms: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function matchCase(source: string, target: string): string {
  const first = source.charAt(0);
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return `${target.charAt(0).toUpperCase()}${target.slice(1)}`;
  }
  return target;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampInt(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  countSyllables,
  countUnits,
  scoreFromCounts,
  splitOneSentence,
  splitSentences,
  protectSegments,
  stripProtectedSegments,
  normaliseBrandTerms,
  VERBOSE_SUBSTITUTIONS,
  JARGON_SUBSTITUTIONS,
  DEFAULT_TARGET_GRADE,
  DEFAULT_TOLERANCE,
  READING_LEVEL_RULES,
});
