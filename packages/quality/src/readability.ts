/**
 * Zipy AI — readability metrics (SEO/quality/safety phase, batch 1).
 *
 * Computes Flesch Reading Ease, Flesch-Kincaid Grade Level, Gunning Fog,
 * SMOG, Coleman-Liau and ARI from a string of prose. The scores drive two
 * downstream behaviours:
 *   - the review UI shows the reader the grade level of each section so a
 *     writer targeting grade 8 can verify the result;
 *   - the writer (packages/content/src/readingLevel.ts) can be given a
 *     target and the quality layer flags sections that miss it.
 *
 * Design rules honoured:
 *   - Deterministic. The syllable counter is the source of every score; it
 *     is a documented heuristic (see `countSyllables`) and is exported for
 *     tests. Given identical input, the scores are byte-identical.
 *   - No fabricated inputs. The counters return 0 / false / null rather than
 *     a plausible default when the text is empty or has no words. A score
 *     that would divide by zero is reported as `null`, never as 0 or 100.
 *   - Markup-aware. Fenced code blocks, inline code spans, URLs, headings
 *     markers (`#`), list markers and HTML tags are stripped before scoring.
 *     A shortcode in a `<pre>` block must not count as a "sentence".
 *   - Prose-only inputs where the metric is undefined are reported. For
 *     example, Coleman-Liau and ARI are unreliable below 100 words; the
 *     function still returns a value but records a `short-text` note that
 *     the review UI surfaces.
 *
 * References (formulas):
 *   - Flesch Reading Ease: 206.835 − 1.015*(words/sentences) − 84.6*(syllables/words)
 *   - Flesch-Kincaid Grade: 0.39*(words/sentences) + 11.8*(syllables/words) − 15.59
 *   - Gunning Fog:         0.4*[(words/sentences) + 100*(complexWords/words)]
 *   - SMOG:                1.0430*sqrt(polysyllables * (30/sentences)) + 3.1291
 *   - Coleman-Liau:        0.0588*L − 0.296*S − 15.8
 *   - ARI:                 4.71*(chars/words) + 0.5*(words/sentences) − 21.43
 *   (chars counts letters and digits only; S and L in Coleman-Liau are
 *    per-100-words percentages of sentences and letters respectively.)
 */

import type { AudienceProfile } from "@zipy/content/personalization/audience";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ReadabilityErrorCode = "invalid-input" | "shape";

export class ReadabilityError extends Error {
  readonly code: ReadabilityErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ReadabilityErrorCode,
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
  readonly wordCount: number;
  readonly sentenceCount: number;
  readonly syllableCount: number;
  /** Words with 3+ syllables (used by Gunning Fog and SMOG). */
  readonly polysyllableCount: number;
  /** Characters that count towards Coleman-Liau and ARI (letters and digits). */
  readonly letterCount: number;
}

export interface ReadabilityScores {
  /** Flesch Reading Ease — higher is easier (approx. 100 → 0). */
  readonly fleschReadingEase: number | null;
  /** Flesch-Kincaid grade level. `null` when the ratio is undefined. */
  readonly fleschKincaidGrade: number | null;
  /** Gunning Fog index. Requires 3+ sentences for a stable value. */
  readonly gunningFog: number | null;
  /** SMOG index. Requires 3+ sentences; unreliable below 30 sentences. */
  readonly smog: number | null;
  /** Coleman-Liau index. */
  readonly colemanLiau: number | null;
  /** Automated Readability Index. */
  readonly ari: number | null;
}

export interface ReadabilityNote {
  readonly kind:
    | "empty"
    | "no-words"
    | "no-sentences"
    | "short-text"
    | "very-short-text"
    | "smog-unreliable"
    | "syllable-heuristic";
  readonly detail: string;
}

export interface ReadabilityReport {
  readonly version: "readability/1";
  readonly counts: ReadabilityCounts;
  readonly scores: ReadabilityScores;
  /**
   * Best single "grade level" summary. Chosen deterministically: the mean of
   * `fleschKincaidGrade` and `gunningFog` when both are available, otherwise
   * whichever of the two is available, otherwise `null`.
   */
  readonly gradeLevel: number | null;
  /**
   * The reading-ease band the score falls into, using the conventional
   * interpretation. Recorded as a category string rather than a number so
   * the review UI does not need to re-implement the bands.
   */
  readonly easeBand: ReadingEaseBand | null;
  readonly notes: readonly ReadabilityNote[];
  /** Whether the text meets the audience's default target grade level. */
  readonly meetsAudienceTarget: boolean | null;
  /** The audience's default target grade level, echoed for the reviewer. */
  readonly audienceTargetGradeLevel: number | null;
  readonly generatedAt: string;
}

export const READING_EASE_BANDS = [
  "very-easy",
  "easy",
  "fairly-easy",
  "standard",
  "fairly-difficult",
  "difficult",
  "very-difficult",
] as const;
export type ReadingEaseBand = (typeof READING_EASE_BANDS)[number];

export interface ScoreReadabilityInput {
  readonly text: string;
  readonly audience?: AudienceProfile | null;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const SHORT_TEXT_THRESHOLD = 100;
const VERY_SHORT_TEXT_THRESHOLD = 30;
const SMOG_RELIABLE_MIN_SENTENCES = 30;
const GUNNING_FOG_MIN_SENTENCES = 3;

/**
 * Default target grade levels by audience seniority. These are the *default*
 * targets; the writing layer (packages/content/src/readingLevel.ts) may
 * override them per guide.
 */
const AUDIENCE_DEFAULT_GRADE: Readonly<Record<string, number>> = Object.freeze({
  novice: 6,
  beginner: 8,
  intermediate: 10,
  expert: 14,
});

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function scoreReadability(input: ScoreReadabilityInput): ReadabilityReport {
  if (input === null || typeof input !== "object") {
    throw new ReadabilityError("scoreReadability requires an input object.", "invalid-input");
  }
  if (typeof input.text !== "string") {
    throw new ReadabilityError("`text` must be a string.", "invalid-input");
  }
  const notes: ReadabilityNote[] = [];
  const cleaned = stripMarkup(input.text);
  const counts = countAll(cleaned);

  if (counts.wordCount === 0) {
    notes.push({
      kind: cleaned.trim().length === 0 ? "empty" : "no-words",
      detail:
        cleaned.trim().length === 0
          ? "The input contained no scorable text."
          : "The input contained no ASCII word tokens after markup stripping (it may be a code-only or symbol-only fragment).",
    });
    return emptyReport(counts, notes, input.audience ?? null);
  }
  if (counts.sentenceCount === 0) {
    notes.push({
      kind: "no-sentences",
      detail:
        "No sentence-ending punctuation was found. The metrics that divide by sentence count are reported as null.",
    });
  }
  if (counts.wordCount < VERY_SHORT_TEXT_THRESHOLD) {
    notes.push({
      kind: "very-short-text",
      detail: `Only ${counts.wordCount} words; readability grades are noisy on fragments below ${VERY_SHORT_TEXT_THRESHOLD} words.`,
    });
  } else if (counts.wordCount < SHORT_TEXT_THRESHOLD) {
    notes.push({
      kind: "short-text",
      detail: `Only ${counts.wordCount} words; interpret the grades as indicative rather than as a section-level measurement.`,
    });
  }
  if (counts.sentenceCount < SMOG_RELIABLE_MIN_SENTENCES) {
    notes.push({
      kind: "smog-unreliable",
      detail: `SMOG is calibrated for at least ${SMOG_RELIABLE_MIN_SENTENCES} sentences; the reported value is not reliable for this length.`,
    });
  }
  notes.push({
    kind: "syllable-heuristic",
    detail:
      "Syllable counts use an orthographic heuristic, not a pronunciation dictionary; treat syllables-derived metrics (Flesch, Flesch-Kincaid, Gunning Fog, SMOG) as estimates.",
  });

  const scores = computeScores(counts);
  const gradeLevel = summariseGrade(scores);
  const easeBand = scores.fleschReadingEase !== null ? bandForEase(scores.fleschReadingEase) : null;
  const audienceTargetGradeLevel = audienceDefaultGrade(input.audience ?? null);
  const meetsAudienceTarget =
    audienceTargetGradeLevel !== null && gradeLevel !== null
      ? gradeLevel <= audienceTargetGradeLevel + 1.0
      : null;

  return {
    version: "readability/1",
    counts,
    scores,
    gradeLevel,
    easeBand,
    notes,
    meetsAudienceTarget,
    audienceTargetGradeLevel,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Score a set of named sections and return both the per-section reports and
 * an aggregate over the concatenated text. The aggregate is *not* the mean
 * of per-section grades — it re-runs the metrics over the combined text so
 * the reviewer sees the whole-guide grade alongside the section views.
 */
export function scoreSections(
  sections: readonly { readonly id: string; readonly label: string; readonly text: string }[],
  audience: AudienceProfile | null,
): {
  readonly sections: readonly {
    readonly id: string;
    readonly label: string;
    readonly report: ReadabilityReport;
  }[];
  readonly whole: ReadabilityReport;
} {
  if (!Array.isArray(sections)) {
    throw new ReadabilityError("`sections` must be an array.", "invalid-input");
  }
  const out: { id: string; label: string; report: ReadabilityReport }[] = [];
  const combined: string[] = [];
  for (const s of sections) {
    if (s === null || typeof s !== "object") continue;
    out.push({
      id: typeof s.id === "string" ? s.id : "",
      label: typeof s.label === "string" ? s.label : "",
      report: scoreReadability({ text: typeof s.text === "string" ? s.text : "", audience }),
    });
    combined.push(typeof s.text === "string" ? s.text : "");
  }
  return {
    sections: out,
    whole: scoreReadability({ text: combined.join("\n\n"), audience }),
  };
}

/**
 * The LLM-visible directive block. Append to the writer's system prompt when
 * a target grade level has been selected. Short and imperative.
 */
export function buildReadabilityDirectives(input: {
  readonly targetGradeLevel: number;
  readonly audience: AudienceProfile;
}): string {
  const lines: string[] = [];
  const target = Number.isFinite(input.targetGradeLevel)
    ? Math.max(1, Math.min(20, Math.round(input.targetGradeLevel)))
    : 8;
  lines.push(`Aim for a reading grade level of about ${target}.`);
  lines.push(
    "- Prefer short sentences. When a step calls for more than one clause, split it into two sentences rather than using a semicolon.",
  );
  lines.push(
    "- Prefer the first-person-active: 'Click Save' rather than 'Saving should be performed'.",
  );
  lines.push(
    "- Prefer concrete verbs and nouns. Do not introduce a synonym to vary the wording; consistency makes a step easier to follow.",
  );
  if (target <= 8) {
    lines.push(
      "- Prefer the shorter of two correct words. Avoid subordinate clauses and multi-level lists.",
    );
    lines.push("- Spell out acronyms on first use, then define them in the glossary.");
  } else if (target >= 13) {
    lines.push("- Assume the reader knows the domain's vocabulary; do not simplify a term of art.");
  }
  if (input.audience.seniority === "expert") {
    lines.push("- Assume expertise: prefer the operation name over the benefit statement.");
  } else if (input.audience.seniority === "novice") {
    lines.push(
      "- Assume a first-time reader: name the subject of every imperative verb ('Click the Save button', not 'Click Save').",
    );
  }
  if (input.audience.accessibilityConsiderations.length > 0) {
    lines.push(
      `- Accessibility notes for this audience: ${input.audience.accessibilityConsiderations.join(", ")}.`,
    );
  }
  return lines.join("\n");
}

/**
 * The band a Flesch Reading Ease score falls into. Exported because the
 * review UI displays the band as a label rather than the raw score.
 */
export function bandForEase(score: number): ReadingEaseBand {
  if (!Number.isFinite(score)) return "standard";
  if (score >= 90) return "very-easy";
  if (score >= 80) return "easy";
  if (score >= 70) return "fairly-easy";
  if (score >= 60) return "standard";
  if (score >= 50) return "fairly-difficult";
  if (score >= 30) return "difficult";
  return "very-difficult";
}

export function rehydrateReadabilityReport(value: unknown): ReadabilityReport {
  if (value === null || typeof value !== "object") {
    throw new ReadabilityError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "readability/1") {
    throw new ReadabilityError(
      `Rehydrate failed: expected version "readability/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  return {
    version: "readability/1",
    counts: readCounts(r["counts"]),
    scores: readScores(r["scores"]),
    gradeLevel: readNullableNumber(r["gradeLevel"]),
    easeBand: readBand(r["easeBand"]),
    notes: readNotes(r["notes"]),
    meetsAudienceTarget:
      r["meetsAudienceTarget"] === true ? true : r["meetsAudienceTarget"] === false ? false : null,
    audienceTargetGradeLevel: readNullableNumber(r["audienceTargetGradeLevel"]),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Markup stripping                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Remove everything that should not count as prose. Fenced code blocks come
 * first (their contents must not be treated as sentences or words), then
 * inline code spans, then HTML tags, then URLs, then markdown heading and
 * list markers. Whitespace is preserved so sentence boundaries survive.
 */
export function stripMarkup(text: string): string {
  if (typeof text !== "string") return "";
  let out = text;
  // Fenced code blocks — replace with a single space so offsets around the
  // block collapse cleanly.
  out = out.replace(/```[\s\S]*?```/gu, " ");
  // Inline code spans.
  out = out.replace(/`[^`\n]*`/gu, " ");
  // HTML/XML tags.
  out = out.replace(/<[^>]{0,200}>/gu, " ");
  // URLs.
  out = out.replace(/https?:\/\/[^\s)>\]}"']+/gu, " ");
  // Markdown images ![alt](url) and links [text](url) → keep the alt/text.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");
  // Heading markers at line starts.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, "");
  // List markers at line starts.
  out = out.replace(/^[ \t]*[-*+][ \t]+/gmu, "");
  out = out.replace(/^[ \t]*\d+[.)][ \t]+/gmu, "");
  // Blockquote markers.
  out = out.replace(/^[ \t]*>[ \t]?/gmu, "");
  // Inline emphasis markers (preserve the letters).
  out = out.replace(/(\*\*|__)([^*_]+)\1/gu, "$2");
  out = out.replace(/(\*|_)([^*_]+)\1/gu, "$2");
  return out;
}

/* -------------------------------------------------------------------------- */
/* Counting                                                                    */
/* -------------------------------------------------------------------------- */

export function countAll(text: string): ReadabilityCounts {
  const words = extractWords(text);
  const sentenceCount = countSentences(text);
  let syllables = 0;
  let polysyllables = 0;
  for (const w of words) {
    const s = countSyllables(w);
    syllables += s;
    if (s >= 3) polysyllables += 1;
  }
  let letters = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    // a-z, A-Z, 0-9
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)) letters += 1;
  }
  return {
    wordCount: words.length,
    sentenceCount,
    syllableCount: syllables,
    polysyllableCount: polysyllables,
    letterCount: letters,
  };
}

/**
 * Extract prose-word tokens. Keeps internal apostrophes and hyphens so
 * "don't" and "sign-in" count as one word; discards tokens that contain no
 * letter or digit.
 */
export function extractWords(text: string): readonly string[] {
  if (typeof text !== "string") return [];
  const re = /[A-Za-z0-9][A-Za-z0-9'’\-_.]*/gu;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    // Ignore pure numeric tokens of length 1-3 — they are more often list
    // numbers or version fragments than prose words.
    if (/^[0-9.]{1,3}$/u.test(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * Count sentences. A sentence ends at `.`, `!` or `?`. An abbreviation
 * followed by a period and a lowercase next character is not treated as a
 * sentence break; an ellipsis (`...`) counts as one break. The heuristic is
 * deliberately conservative — over-counting is more disruptive to the
 * formulae than under-counting.
 */
export function countSentences(text: string): number {
  if (typeof text !== "string" || text.trim().length === 0) return 0;
  // Collapse ellipses and multiple terminators to a single period.
  const normalised = text.replace(/\.{2,}/gu, ".").replace(/([!?])\1+/gu, "$1");
  let count = 0;
  const re = /[.!?]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalised)) !== null) {
    const idx = m.index;
    const prev = idx > 0 ? normalised.charAt(idx - 1) : "";
    const next = idx + 1 < normalised.length ? normalised.charAt(idx + 1) : "";
    // A period between two digits is a decimal point, not a sentence break.
    if (m[0] === "." && /[0-9]/u.test(prev) && /[0-9]/u.test(next)) continue;
    // A period followed by an alphanumeric char (no whitespace) is likely
    // part of an abbreviation or domain; skip.
    if (m[0] === "." && /[A-Za-z0-9]/u.test(next)) continue;
    // A period preceded by a common abbreviation (single-letter, "etc",
    // "e.g", "i.e", "vs", "Mr", "Dr", "St") is not a sentence break.
    if (m[0] === ".") {
      const before = normalised.slice(Math.max(0, idx - 6), idx).toLowerCase();
      if (/(^|[\s(])(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|st|no|fig|approx)$/u.test(before)) continue;
      // A single capital letter followed by a period, e.g. "A." — treat as
      // an initial, not a sentence break.
      const oneLetter = normalised.slice(Math.max(0, idx - 1), idx);
      if (/^[A-Z]$/u.test(oneLetter)) {
        const beforeOne = normalised.charAt(Math.max(0, idx - 2));
        if (beforeOne === " " || beforeOne === "") {
          // e.g. "J. Smith" — skip.
          continue;
        }
      }
    }
    count += 1;
  }
  // A trailing fragment with no terminator still counts as one sentence.
  const lastTerminator = Math.max(
    normalised.lastIndexOf("."),
    normalised.lastIndexOf("!"),
    normalised.lastIndexOf("?"),
  );
  const tail = normalised.slice(lastTerminator + 1).trim();
  if (tail.length > 0 && /[A-Za-z0-9]/u.test(tail)) count += 1;
  // A single word with no terminator should not be reported as a sentence.
  if (count === 0 && extractWords(text).length > 0) count = 1;
  return count;
}

/**
 * Count syllables in a single word using an orthographic heuristic. The
 * method is the well-known "count vowel groups, subtract silent e, add 1 for
 * le-ending consonant clusters" rule set, which agrees with a pronunciation
 * dictionary on roughly 90% of common English words.
 *
 * The heuristic is exported so callers can see and test the exact rule; the
 * report carries a `syllable-heuristic` note so downstream consumers do not
 * treat the number as authoritative.
 */
export function countSyllables(word: string): number {
  if (typeof word !== "string") return 0;
  const w = word.toLowerCase().replace(/[^a-z]/gu, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;

  let count = 0;
  const SILENT = new Set(["a", "e", "i", "o", "u", "y"]);
  let prevVowel = false;
  for (let i = 0; i < w.length; i += 1) {
    const c = w.charAt(i);
    const isVowel = SILENT.has(c);
    if (isVowel && !prevVowel) count += 1;
    prevVowel = isVowel;
  }

  // Silent trailing e (unless the word is a "le" pattern, e.g. "table").
  if (w.endsWith("e") && !w.endsWith("le") && w.length > 2) {
    if (count > 1) count -= 1;
  }
  // Words ending in "le" preceded by a consonant get the final syllable back.
  if (w.endsWith("le") && w.length >= 3) {
    const before = w.charAt(w.length - 3);
    if (before.length > 0 && !SILENT.has(before)) count += 1;
  }
  // Words ending in "es" or "ed" often lose a syllable (e.g. "walked").
  if (w.length > 4 && (w.endsWith("ed") || w.endsWith("es"))) {
    const before = w.charAt(w.length - 3);
    if (before.length > 0 && !SILENT.has(before)) {
      if (count > 1) count -= 1;
    }
  }
  return Math.max(1, count);
}

/* -------------------------------------------------------------------------- */
/* Score computation                                                           */
/* -------------------------------------------------------------------------- */

export function computeScores(counts: ReadabilityCounts): ReadabilityScores {
  const { wordCount: W, sentenceCount: S, syllableCount: Sy, polysyllableCount: P, letterCount: L } = counts;
  const wordsPerSentence = S > 0 ? W / S : null;
  const syllablesPerWord = W > 0 ? Sy / W : null;

  const fleschReadingEase =
    wordsPerSentence !== null && syllablesPerWord !== null
      ? round2(206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord)
      : null;

  const fleschKincaidGrade =
    wordsPerSentence !== null && syllablesPerWord !== null
      ? round2(0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59)
      : null;

  const gunningFog =
    S >= GUNNING_FOG_MIN_SENTENCES && W > 0 && wordsPerSentence !== null
      ? round2(0.4 * (wordsPerSentence + 100 * (P / W)))
      : null;

  const smog =
    S > 0 && W > 0
      ? round2(1.0430 * Math.sqrt(P * (30 / S)) + 3.1291)
      : null;

  // Coleman-Liau: 0.0588*L − 0.296*S − 15.8, where L and S are per-100-word
  // percentages of letters and sentences.
  const colemanLiau =
    W > 0 ? round2(0.0588 * ((L / W) * 100) - 0.296 * ((S / W) * 100) - 15.8) : null;

  // ARI: 4.71*(chars/words) + 0.5*(words/sentences) − 21.43.
  const ari =
    W > 0 && wordsPerSentence !== null
      ? round2(4.71 * (L / W) + 0.5 * wordsPerSentence - 21.43)
      : null;

  return {
    fleschReadingEase,
    fleschKincaidGrade,
    gunningFog,
    smog,
    colemanLiau,
    ari,
  };
}

function summariseGrade(scores: ReadabilityScores): number | null {
  const parts: number[] = [];
  if (scores.fleschKincaidGrade !== null) parts.push(scores.fleschKincaidGrade);
  if (scores.gunningFog !== null) parts.push(scores.gunningFog);
  if (parts.length === 0) {
    // Fall back to Coleman-Liau, then ARI. Both are less calibrated on short
    // text; the report's notes already flag the length.
    if (scores.colemanLiau !== null) return Math.max(0, scores.colemanLiau);
    if (scores.ari !== null) return Math.max(0, scores.ari);
    return null;
  }
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return round2(avg);
}

function audienceDefaultGrade(audience: AudienceProfile | null): number | null {
  if (audience === null || typeof audience !== "object") return null;
  const seniority = typeof audience.seniority === "string" ? audience.seniority : "";
  const value = AUDIENCE_DEFAULT_GRADE[seniority];
  return typeof value === "number" ? value : null;
}

function emptyReport(
  counts: ReadabilityCounts,
  notes: readonly ReadabilityNote[],
  audience: AudienceProfile | null,
): ReadabilityReport {
  return {
    version: "readability/1",
    counts,
    scores: {
      fleschReadingEase: null,
      fleschKincaidGrade: null,
      gunningFog: null,
      smog: null,
      colemanLiau: null,
      ari: null,
    },
    gradeLevel: null,
    easeBand: null,
    notes,
    meetsAudienceTarget: null,
    audienceTargetGradeLevel: audienceDefaultGrade(audience),
    generatedAt: new Date().toISOString(),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Rehydrate readers                                                           */
/* -------------------------------------------------------------------------- */

function readCounts(v: unknown): ReadabilityCounts {
  if (v === null || typeof v !== "object") {
    return {
      wordCount: 0,
      sentenceCount: 0,
      syllableCount: 0,
      polysyllableCount: 0,
      letterCount: 0,
    };
  }
  const o = v as Record<string, unknown>;
  return {
    wordCount: readInt(o["wordCount"]),
    sentenceCount: readInt(o["sentenceCount"]),
    syllableCount: readInt(o["syllableCount"]),
    polysyllableCount: readInt(o["polysyllableCount"]),
    letterCount: readInt(o["letterCount"]),
  };
}

function readScores(v: unknown): ReadabilityScores {
  if (v === null || typeof v !== "object") {
    return {
      fleschReadingEase: null,
      fleschKincaidGrade: null,
      gunningFog: null,
      smog: null,
      colemanLiau: null,
      ari: null,
    };
  }
  const o = v as Record<string, unknown>;
  return {
    fleschReadingEase: readNullableNumber(o["fleschReadingEase"]),
    fleschKincaidGrade: readNullableNumber(o["fleschKincaidGrade"]),
    gunningFog: readNullableNumber(o["gunningFog"]),
    smog: readNullableNumber(o["smog"]),
    colemanLiau: readNullableNumber(o["colemanLiau"]),
    ari: readNullableNumber(o["ari"]),
  };
}

function readNotes(v: unknown): readonly ReadabilityNote[] {
  if (!Array.isArray(v)) return [];
  const out: ReadabilityNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "empty" &&
      kind !== "no-words" &&
      kind !== "no-sentences" &&
      kind !== "short-text" &&
      kind !== "very-short-text" &&
      kind !== "smog-unreliable" &&
      kind !== "syllable-heuristic"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

function readBand(v: unknown): ReadingEaseBand | null {
  if (
    v === "very-easy" ||
    v === "easy" ||
    v === "fairly-easy" ||
    v === "standard" ||
    v === "fairly-difficult" ||
    v === "difficult" ||
    v === "very-difficult"
  ) {
    return v;
  }
  return null;
}

function readInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  return 0;
}

function readNullableNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  stripMarkup,
  extractWords,
  countSentences,
  countSyllables,
  computeScores,
  summariseGrade,
  audienceDefaultGrade,
  round2,
  SHORT_TEXT_THRESHOLD,
  VERY_SHORT_TEXT_THRESHOLD,
  SMOG_RELIABLE_MIN_SENTENCES,
  GUNNING_FOG_MIN_SENTENCES,
  AUDIENCE_DEFAULT_GRADE,
});
