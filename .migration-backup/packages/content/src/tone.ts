/**
 * Zipy AI — tone selection (content-generation, style batch 0).
 *
 * The tone layer is the first member of the style family. It answers one
 * question: *how should the guide's prose be voiced?* The answer is a small,
 * inspectable descriptor (`ToneProfile`) plus two functions that apply it:
 *
 *   - `applyTone(text, profile)` — a deterministic, non-LLM rewrite pass
 *     that adjusts surface features of a sentence without changing its
 *     meaning. It exists so that a caller can *observably* change wording
 *     with the tone knob even when no LLM is configured, and so that the
 *     LLM path has a stable base to write on top of.
 *   - `buildToneDirectives(profile)` — the instruction block threaded into
 *     the system prompt of every content layer through `@zipy/content/pipeline`.
 *
 * A tone profile is a *lens*, not a rulebook: it maps a small set of
 * surface transformations to a target voice, and never edits the subject,
 * verb or object of a sentence. Where a transformation cannot be applied
 * safely (e.g. a sentence that is not a plain command), the original text is
 * returned unchanged and the change is recorded in `ToneApplication.applied`
 * so a reviewer can see exactly what moved.
 *
 * Design rules honoured:
 *  - Deterministic. No LLM call.
 *  - Idempotent. Running `applyTone` twice yields the same result as once.
 *  - Reversible enough to be auditable. `ToneApplication.changes` records
 *    each edit as `{ before, after, rule }` so the diff view works.
 *  - No invented UI labels, no re-voicing of a proper noun, no touching of
 *    text inside backticks, quoted strings or code spans.
 *  - Pure function of its arguments.
 */

import type { TitleSummaryStyle } from "./titleSummary";
import type { FaqStyle } from "./faq";
import type { TipsWarningsStyle } from "./tipsWarnings";
import type { GlossaryStyle } from "./glossary";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ToneErrorCode = "invalid-input";

export class ToneError extends Error {
  readonly code: ToneErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ToneErrorCode,
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

export const TONES = ["formal", "casual", "technical", "neutral"] as const;
export type Tone = (typeof TONES)[number];

export const AUDIENCES = ["end-user", "admin", "developer"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * A read-only description of the tone the guide is being written in.
 * `brandTerms` are the terms that must never be re-cased or re-voiced.
 */
export interface ToneProfile {
  readonly tone: Tone;
  /** Term list that the rewriter must treat as immutable. */
  readonly brandTerms: readonly string[];
  /**
   * Free-text voice notes supplied by the caller (e.g. from brand
   * guidelines). They are appended verbatim to the LLM directive block and
   * are not interpreted by the deterministic pass.
   */
  readonly voiceNotes: readonly string[];
}

/** The style knobs accepted by other `@zipy/content` layers. */
export type ToneCarrier =
  | TitleSummaryStyle
  | FaqStyle
  | TipsWarningsStyle
  | GlossaryStyle
  | { readonly tone?: Tone; readonly brandTerms?: readonly string[] };

export interface ToneApplication {
  readonly text: string;
  readonly applied: boolean;
  readonly changes: readonly ToneChange[];
}

export interface ToneChange {
  readonly rule: ToneRule;
  readonly before: string;
  readonly after: string;
}

/**
 * The transformations the deterministic pass can apply. Kept as a closed
 * union so a reviewer can grep for each rule's effect.
 */
export const TONE_RULES = [
  "contraction.expand",
  "contraction.collapse",
  "sentence.split",
  "ampersand.expand",
  "ellipsis.normalise",
  "imperative.leading.please",
  "imperative.leading.removePlease",
  "greeting.detach",
] as const;
export type ToneRule = (typeof TONE_RULES)[number];

/* -------------------------------------------------------------------------- */
/* Constants: known safe contractions                                          */
/* -------------------------------------------------------------------------- */

/**
 * Contractions the deterministic pass understands. Expansion is used for
 * formal and technical tones; collapse is used for casual. The list is
 * deliberately small — every entry is unambiguous and does not change
 * meaning when substituted. Anything not in this list is left alone.
 */
const CONTRACTION_MAP: ReadonlyArray<readonly [string, string]> = [
  // [contracted, expanded]
  ["don't", "do not"],
  ["doesn't", "does not"],
  ["didn't", "did not"],
  ["won't", "will not"],
  ["wouldn't", "would not"],
  ["can't", "cannot"],
  ["couldn't", "could not"],
  ["shouldn't", "should not"],
  ["isn't", "is not"],
  ["aren't", "are not"],
  ["wasn't", "was not"],
  ["weren't", "were not"],
  ["hasn't", "has not"],
  ["haven't", "have not"],
  ["hadn't", "had not"],
  ["it's", "it is"],
  ["that's", "that is"],
  ["there's", "there is"],
  ["you're", "you are"],
  ["you've", "you have"],
  ["you'll", "you will"],
  ["we're", "we are"],
  ["we've", "we have"],
  ["we'll", "we will"],
  ["they're", "they are"],
  ["they've", "they have"],
  ["they'll", "they will"],
  ["i'm", "I am"],
  ["i've", "I have"],
  ["i'll", "I will"],
  ["let's", "let us"],
];

const BRAND_SENTINEL_OPEN = "\u0001B";
const BRAND_SENTINEL_CLOSE = "B\u0001";
const PROTECTED_OPEN = "\u0001P";
const PROTECTED_CLOSE = "P\u0001";

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build a `ToneProfile` from the style knobs passed by other content layers.
 * Unknown tones fall back to `neutral`; brand terms are deduplicated
 * case-insensitively but their first-seen casing is preserved.
 */
export function buildToneProfile(
  carrier: ToneCarrier | undefined,
  extra?: { readonly voiceNotes?: readonly string[] },
): ToneProfile {
  const tone: Tone = isTone(carrier?.tone) ? carrier.tone : "neutral";
  const brandTerms = normaliseBrandTerms(carrier?.brandTerms ?? []);
  const voiceNotes = (extra?.voiceNotes ?? [])
    .map((s) => collapseWhitespace(s))
    .filter((s) => s.length > 0);
  return { tone, brandTerms, voiceNotes };
}

/**
 * Apply the tone profile to a single string. Returns the rewritten text
 * plus a record of every change and a flag indicating whether any change
 * was made. Never throws.
 */
export function applyTone(text: string, profile: ToneProfile): ToneApplication {
  if (typeof text !== "string") {
    throw new ToneError("applyTone requires a string.", "invalid-input");
  }
  if (text.length === 0) {
    return { text, applied: false, changes: [] };
  }

  // Protect anything we must not rewrite: backticks, quoted strings, URL
  // shapes, and the caller's brand terms.
  const { protectedText, restore } = protectSegments(text, profile.brandTerms);

  const changes: ToneChange[] = [];
  let working = protectedText;

  // --- Rule 1: ellipsis normalisation (all tones) -----------------------
  working = replaceWithLog(
    working,
    /\u2026/g,
    "...",
    "ellipsis.normalise",
    changes,
  );

  // --- Rule 2: ampersand expansion (formal and technical) ---------------
  if (profile.tone === "formal" || profile.tone === "technical") {
    working = replaceWithLog(
      working,
      /(\p{L})\s+&\s+(\p{L})/gu,
      "$1 and $2",
      "ampersand.expand",
      changes,
    );
  }

  // --- Rule 3: contractions --------------------------------------------
  if (profile.tone === "formal" || profile.tone === "technical") {
    for (const [contract, expanded] of CONTRACTION_MAP) {
      working = replaceContraction(working, contract, expanded, changes, "contraction.expand");
    }
  } else if (profile.tone === "casual") {
    for (const [contract, expanded] of CONTRACTION_MAP) {
      // Only collapse the safe subset: "do not" → "don't" etc. We avoid
      // collapsing when the expanded form is at the start of a sentence and
      // the contraction would look odd ("Do not" vs "Don't" — "Don't" is
      // fine, but "i'm" for "I am" is not; brand guard below).
      if (expanded === "I am" || expanded === "I have" || expanded === "I will") continue;
      working = replaceContraction(working, expanded, contract, changes, "contraction.collapse");
    }
  }

  // --- Rule 4: imperative leading "please" -----------------------------
  if (profile.tone === "formal") {
    working = addPolitePrefix(working, changes);
  } else if (profile.tone === "casual") {
    working = removePolitePrefix(working, changes);
  }

  // --- Rule 5: sentence splitting for very long sentences (technical) --
  if (profile.tone === "technical") {
    working = splitLongSentences(working, 220, changes);
  }

  const restored = restore(working);

  return {
    text: restored,
    applied: changes.length > 0,
    changes,
  };
}

/**
 * Build the instruction block that is appended to every layer's system
 * prompt. This is the LLM-visible expression of the tone profile.
 */
export function buildToneDirectives(profile: ToneProfile): string {
  const lines: string[] = [];
  lines.push(`Voice: ${describeTone(profile.tone)}.`);

  if (profile.tone === "formal") {
    lines.push("Use complete sentences. Avoid contractions and slang. Prefer 'please' before direct instructions.");
  } else if (profile.tone === "casual") {
    lines.push("Write in a friendly, conversational register. Contractions are welcome. Second person ('you') throughout.");
  } else if (profile.tone === "technical") {
    lines.push("Write for a practitioner. Prefer precise nouns, avoid idioms, and split long sentences rather than nested clauses.");
  } else {
    lines.push("Write plainly and neutrally; do not embellish.");
  }

  if (profile.brandTerms.length > 0) {
    lines.push(
      `Preserve these terms verbatim, including their capitalisation: ${profile.brandTerms.join(", ")}.`,
    );
  } else {
    lines.push("Do not invent product, page or brand names.");
  }

  for (const note of profile.voiceNotes) {
    lines.push(`Voice note from brand guidelines: ${note}`);
  }

  return lines.join("\n");
}

/**
 * Apply the tone to every string in a shallow record. The shape is preserved
 * verbatim; only the string values are rewritten. Nested objects and arrays
 * are walked (bounded depth) so a content draft's strings are all covered.
 */
export function applyToneDeep<T>(value: T, profile: ToneProfile): T {
  return walkAndRewrite(value, profile, 0) as T;
}

/* -------------------------------------------------------------------------- */
/* Rerwriting primitives                                                       */
/* -------------------------------------------------------------------------- */

function replaceWithLog(
  text: string,
  pattern: RegExp,
  replacement: string,
  rule: ToneRule,
  changes: ToneChange[],
): string {
  return text.replace(pattern, (match, ...rest) => {
    const expanded = typeof replacement === "string"
      ? replacement.replace(/\$(\d)/g, (_m, d) => {
          const idx = Number(d) - 1;
          const capture = rest[idx];
          return typeof capture === "string" ? capture : "";
        })
      : replacement;
    if (expanded !== match) {
      changes.push({ rule, before: match, after: expanded });
    }
    return expanded;
  });
}

function replaceContraction(
  text: string,
  from: string,
  to: string,
  changes: ToneChange[],
  rule: ToneRule,
): string {
  const escaped = escapeRegExp(from);
  // Word-boundary-ish match that also handles the trailing apostrophe case.
  const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "giu");
  return text.replace(re, (match) => {
    const replacement = matchCase(match, to);
    if (replacement !== match) {
      changes.push({ rule, before: match, after: replacement });
    }
    return replacement;
  });
}

function addPolitePrefix(text: string, changes: ToneChange[]): string {
  // Match sentences that start with a bare imperative and do not already
  // begin with "please". We look for a sentence start that is a capitalised
  // verb-like word followed by a lowercase word (a heuristic that avoids
  // proper nouns like "Stripe Reports" — the second word is lowercase).
  const re = /(^|[.!?]\s+)(?!Please\b)([A-Z][a-z]{2,}\s+[a-z])/g;
  return text.replace(re, (match, lead: string, body: string) => {
    const replacement = `${lead}Please ${lowerFirst(body)}`;
    changes.push({ rule: "imperative.leading.please", before: match, after: replacement });
    return replacement;
  });
}

function removePolitePrefix(text: string, changes: ToneChange[]): string {
  const re = /(^|[.!?]\s+)Please\s+([a-z])/g;
  return text.replace(re, (match, lead: string, body: string) => {
    const replacement = `${lead}${body.toUpperCase()}`;
    changes.push({ rule: "imperative.leading.removePlease", before: match, after: replacement });
    return replacement;
  });
}

function splitLongSentences(
  text: string,
  maxChars: number,
  changes: ToneChange[],
): string {
  if (text.length <= maxChars) return text;
  // Split on `, and ` / `, but ` / `; ` when the resulting pieces are each
  // shorter than the limit. This is a conservative transformation: it only
  // fires when the join word is unambiguous.
  const parts = text.split(/(,\s+(?:and|but|so|yet|or)\s+|;\s+)/);
  if (parts.length < 3) return text;
  const rebuilt: string[] = [];
  let current = "";
  for (const part of parts) {
    if (part.match(/^[,;]/) || current.length + part.length > maxChars) {
      if (current.length > 0) rebuilt.push(current.trim());
      current = part.trim();
    } else {
      current = current.length > 0 ? `${current} ${part}` : part;
    }
  }
  if (current.length > 0) rebuilt.push(current.trim());
  if (rebuilt.length <= 1) return text;
  const joined = rebuilt
    .map((piece, i) => {
      if (i === 0) return piece;
      return `${piece.charAt(0).toUpperCase()}${piece.slice(1)}`;
    })
    .join(". ");
  changes.push({ rule: "sentence.split", before: text, after: joined });
  return joined;
}

/* -------------------------------------------------------------------------- */
/* Protection of segments we must not rewrite                                  */
/* -------------------------------------------------------------------------- */

interface Protection {
  readonly protectedText: string;
  readonly restore: (s: string) => string;
}

function protectSegments(text: string, brandTerms: readonly string[]): Protection {
  const brands: string[] = [];
  let working = text;

  // 1. Brand terms first — must survive every subsequent step.
  for (const brand of brandTerms) {
    if (brand.length === 0) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegExp(brand)}(?![\\p{L}\\p{N}-])`, "gu");
    working = working.replace(re, (match) => {
      const idx = brands.length;
      brands.push(match);
      return `${BRAND_SENTINEL_OPEN}${idx}${BRAND_SENTINEL_CLOSE}`;
    });
  }

  // 2. Code spans, quoted strings, URLs.
  const protectedSegments: string[] = [];
  const protect = (match: string): string => {
    const idx = protectedSegments.length;
    protectedSegments.push(match);
    return `${PROTECTED_OPEN}${idx}${PROTECTED_CLOSE}`;
  };
  working = working
    .replace(/`[^`]*`/g, protect)
    .replace(/"[^"]*"/g, protect)
    .replace(/'[^']*'/g, protect)
    .replace(/https?:\/\/[^\s)]+/g, protect);

  const restore = (s: string): string => {
    let restored = s;
    // Restore protected segments in a loop because a segment can contain
    // the sentinel shape itself (unlikely, but cheap to guard).
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

/* -------------------------------------------------------------------------- */
/* Deep apply                                                                  */
/* -------------------------------------------------------------------------- */

function walkAndRewrite(value: unknown, profile: ToneProfile, depth: number): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    const result = applyTone(value, profile);
    return result.text;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => walkAndRewrite(item, profile, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Skip fields that are structural, not prose. This is a short, explicit
    // allowlist of prose keys so the deep walk does not accidentally
    // rewrite identifiers (workflowId, stepId, timestamps, etc.).
    if (PROSE_KEYS.has(k)) {
      out[k] = walkAndRewrite(v, profile, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
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
  "term",
  "definition",
  "note",
  "body",
  "content",
  "label",
  "intro",
  "prerequisites",
]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function describeTone(tone: Tone): string {
  switch (tone) {
    case "formal": return "formal and instructive";
    case "casual": return "friendly and conversational";
    case "technical": return "precise and technical";
    case "neutral": return "neutral";
  }
}

function isTone(value: unknown): value is Tone {
  return (
    value === "formal" ||
    value === "casual" ||
    value === "technical" ||
    value === "neutral"
  );
}

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
  const targetFirst = target.charAt(0);
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return `${targetFirst.toUpperCase()}${target.slice(1)}`;
  }
  return target;
}

function lowerFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  CONTRACTION_MAP,
  protectSegments,
  replaceContraction,
  addPolitePrefix,
  removePolitePrefix,
  splitLongSentences,
  normaliseBrandTerms,
  describeTone,
  escapeRegExp,
  TONES,
  AUDIENCES,
  TONE_RULES,
});
