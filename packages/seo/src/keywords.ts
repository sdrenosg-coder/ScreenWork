/**
 * Zipy AI — keyword optimization (SEO/quality/safety phase, batch 1).
 *
 * Pairs with `@zipy/seo/meta` (which places the caller's chosen keywords into a
 * generated title/description and reports the ones it could *not* place). This
 * module covers the complementary surface: taking a raw candidate keyword set,
 * normalising it, scoring each keyword against the guide brief, and suggesting
 * the keywords an operator should actually target — without ever inventing a
 * keyword, keyword density, or search-volume figure.
 *
 * Design rules honoured:
 *  - No invented facts. The composer never produces a keyword the caller did
 *    not supply and never fabricates search volume, ranking or difficulty.
 *    Scored candidates are derived *only* from the brief (goal, step titles,
 *    prerequisites, product name) and the caller's keyword list.
 *  - Deterministic given inputs. The output ordering is stable: primary by
 *    score descending, ties broken by the caller's input order. No clock
 *    read on the candidate path; the ISO timestamp is only a build record.
 *  - Vocabulary safety. Keywords are lowercased for comparison but preserved
 *    verbatim for placement; a keyword appearing only inside a URL or code
 *    span is not counted as "present in prose".
 *  - Suggestion never overrides the operator. `suggested` is a *proposal*;
 *    `chosen` is what the operator supplied. Nothing downstream assumes the
 *    two are equal.
 *
 * The module exports:
 *   - `composeKeywordPlan` — normalise + score + suggest.
 *   - `scoreKeyword` — per-keyword scoring helper (exported for tests).
 *   - `extractCandidateKeywords` — pull noun-ish phrases from brief fields
 *     (a deterministic derivation; no NLP model, no synonyms the brief did
 *     not contain).
 *   - `buildKeywordDirectives` — the LLM-visible block telling the writer how
 *     to use the chosen keywords in the guide body.
 *   - `rehydrateKeywordPlan` — typed load of a persisted payload.
 */

import type { SeoBrief } from "@zipy/seo/meta";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type KeywordsErrorCode = "invalid-input" | "shape";

export class KeywordsError extends Error {
  readonly code: KeywordsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: KeywordsErrorCode,
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

/**
 * Where a keyword came from. Operators supply `operator-chosen` and
 * `operator-raw` (the latter is normalised before it enters the plan).
 * Every other value is a deterministic derivation the composer proposes.
 */
export const KEYWORD_SOURCES = [
  "operator-chosen",
  "derived-from-goal",
  "derived-from-steps",
  "derived-from-product",
  "keyword-memory",
] as const;
export type KeywordSource = (typeof KEYWORD_SOURCES)[number];

/** A keyword the operator asked the guide to target. */
export interface ChosenKeyword {
  /** The keyword as the operator wrote it (case preserved). */
  readonly value: string;
  /** Normalised form used for comparisons and scoring. */
  readonly normalised: string;
  /**
   * When true, the keyword must appear at least once in the guide body (not
   * only in the meta title/description). A reviewer is expected to enforce
   * this; the composer records it but does not gate publication.
   */
  readonly required: boolean;
  /** Optional grouping label from the operator (e.g. "primary", "long-tail"). */
  readonly group: string | null;
}

/** A keyword the composer proposes but the operator has not yet chosen. */
export interface SuggestedKeyword {
  readonly value: string;
  readonly normalised: string;
  readonly source: KeywordSource;
  /** 0..1. Higher is a better target for this brief. */
  readonly score: number;
  /** One-line reason shown in the review UI. */
  readonly reason: string;
  /** Where the evidence for this keyword was found in the brief. */
  readonly evidence: readonly string[];
}

export interface ScoredKeyword {
  readonly value: string;
  readonly normalised: string;
  readonly source: KeywordSource;
  readonly score: number;
  readonly reason: string;
  readonly evidence: readonly string[];
  /** Whether the keyword is present (verbatim, case-insensitive) in the goal. */
  readonly inGoal: boolean;
  /** Whether the keyword is present in at least one step title. */
  readonly inStepTitles: boolean;
  /** Whether the keyword is present in the product name (when one exists). */
  readonly inProductName: boolean;
  /** Whether the keyword is present in at least one prerequisite sentence. */
  readonly inPrerequisites: boolean;
  /** How many step titles the keyword appears in. */
  readonly stepTitleHits: number;
}

export interface KeywordPlan {
  readonly version: "keyword-plan/1";
  /** Normalised, de-duplicated, operator-supplied keywords, in input order. */
  readonly chosen: readonly ChosenKeyword[];
  /** The composer's proposals, sorted best-first. */
  readonly suggested: readonly SuggestedKeyword[];
  /** Every scored candidate the composer evaluated, sorted best-first. */
  readonly scored: readonly ScoredKeyword[];
  /** Structural notes the reviewer must read. */
  readonly notes: readonly KeywordNote[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface KeywordNote {
  readonly kind:
    | "duplicate-suppressed"
    | "empty-suppressed"
    | "required-without-evidence"
    | "no-chosen"
    | "too-many-chosen"
    | "stopword-only";
  readonly detail: string;
}

export interface ComposeKeywordPlanInput {
  readonly brief: SeoBrief;
  /** Keywords the operator has explicitly chosen. */
  readonly chosen?: readonly (string | ChosenKeyword)[];
  /**
   * When true, the composer also proposes derived keywords from the brief.
   * Default true; set false when the operator wants only their own list
   * respected.
   */
  readonly suggest?: boolean;
  /** Hard ceiling on the number of suggestions returned. Default 12. */
  readonly maxSuggestions?: number;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A small English stop-word list. Used only to filter *suggestions* — a
 * chosen keyword is never rejected for containing a stop-word, because the
 * operator may deliberately target a phrase like "how to add a customer".
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "to",
  "of", "in", "on", "at", "by", "with", "from", "as", "is", "are", "be",
  "was", "were", "do", "does", "did", "how", "what", "when", "where", "why",
  "this", "that", "these", "those", "it", "its", "you", "your", "we", "our",
]);

const MAX_SUGGESTIONS_DEFAULT = 12;
const TOO_MANY_CHOSEN_THRESHOLD = 25;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the keyword plan. The operator's chosen keywords come first (their
 * order is preserved); the suggested list is a pure derivation over the
 * brief's goal, step titles, product name and prerequisites.
 */
export function composeKeywordPlan(input: ComposeKeywordPlanInput): KeywordPlan {
  if (input === null || typeof input !== "object") {
    throw new KeywordsError("composeKeywordPlan requires an input object.", "invalid-input");
  }
  if (input.brief === null || typeof input.brief !== "object") {
    throw new KeywordsError("`brief` is required.", "invalid-input");
  }
  if (typeof input.brief.goal !== "string" || input.brief.goal.trim().length === 0) {
    throw new KeywordsError("Brief `goal` must be a non-empty string.", "invalid-input");
  }
  if (!Array.isArray(input.brief.stepTitles)) {
    throw new KeywordsError("Brief `stepTitles` must be an array.", "invalid-input");
  }

  const notes: KeywordNote[] = [];
  const chosen = normaliseChosen(input.chosen ?? [], notes);
  if (chosen.length === 0) {
    notes.push({
      kind: "no-chosen",
      detail:
        "No target keywords were supplied. The guide will be optimised only against the brief's own vocabulary until the operator chooses keywords.",
    });
  } else if (chosen.length > TOO_MANY_CHOSEN_THRESHOLD) {
    notes.push({
      kind: "too-many-chosen",
      detail: `The operator supplied ${chosen.length} keywords, above the ${TOO_MANY_CHOSEN_THRESHOLD}-keyword guideline. Broad lists reduce placement quality; consider narrowing to the highest-intent phrases.`,
    });
  }
  for (const c of chosen) {
    if (c.required && !hasAnyEvidence(c.normalised, input.brief)) {
      notes.push({
        kind: "required-without-evidence",
        detail: `Required keyword "${c.value}" does not appear anywhere in the brief (goal, step titles, product name or prerequisites). A reviewer should check that the workflow actually covers it.`,
      });
    }
  }

  const derived = input.suggest === false ? [] : extractCandidateKeywords(input.brief);
  const scored = scoreCandidates(input.brief, derived);
  const chosenNorm = new Set(chosen.map((c) => c.normalised));
  const deduped = scored.filter((s) => !chosenNorm.has(s.normalised));
  deduped.sort(compareScored);

  const limit =
    Number.isFinite(input.maxSuggestions) && (input.maxSuggestions ?? 0) > 0
      ? Math.floor(input.maxSuggestions as number)
      : MAX_SUGGESTIONS_DEFAULT;
  const suggested: SuggestedKeyword[] = deduped.slice(0, limit).map((s) => ({
    value: s.value,
    normalised: s.normalised,
    source: s.source,
    score: s.score,
    reason: s.reason,
    evidence: s.evidence,
  }));

  return {
    version: "keyword-plan/1",
    chosen,
    suggested,
    scored: scored.slice().sort(compareScored),
    notes,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Score a single keyword against the brief. Exposed for tests and for the
 * review UI, which may want to score an operator-proposed keyword before
 * adding it to the chosen set.
 */
export function scoreKeyword(brief: SeoBrief, raw: string): ScoredKeyword | null {
  const normalised = normaliseKeyword(raw);
  if (normalised.length === 0) return null;
  return scoreOne(brief, raw.trim(), normalised, "operator-chosen");
}

/**
 * Deterministic keyword candidates derived from the brief. Each candidate is
 * a contiguous phrase from a brief field — the composer never invents a word
 * that is not present in the brief, and never normalises a phrase beyond
 * lowercasing and whitespace collapse.
 */
export function extractCandidateKeywords(brief: SeoBrief): readonly {
  readonly value: string;
  readonly source: KeywordSource;
}[] {
  const out: { value: string; source: KeywordSource }[] = [];
  const seen = new Set<string>();

  const push = (raw: string, source: KeywordSource): void => {
    const cleaned = cleanPhrase(raw);
    if (cleaned.length < 4) return;
    if (cleaned.length > 60) return;
    if (isStopwordOnly(cleaned)) return;
    const norm = normaliseKeyword(cleaned);
    if (norm.length === 0) return;
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push({ value: cleaned, source });
  };

  // The goal often yields a verb-phrase worth targeting directly.
  push(brief.goal, "derived-from-goal");
  // Nouns from the goal's subject: split on whitespace, keep the trailing
  // 1-3 token window when the phrase contains a verb-like first token.
  for (const ngram of ngrams(collapse(brief.goal), 2)) push(ngram, "derived-from-goal");
  for (const ngram of ngrams(collapse(brief.goal), 3)) push(ngram, "derived-from-goal");

  // Step titles are the workflow's own vocabulary; a noun phrase that recurs
  // across steps is a strong signal.
  for (const title of brief.stepTitles) {
    if (typeof title !== "string") continue;
    push(title, "derived-from-steps");
    for (const ngram of ngrams(collapse(title), 2)) push(ngram, "derived-from-steps");
  }

  if (brief.productName !== null && brief.productName.trim().length > 0) {
    push(brief.productName, "derived-from-product");
    // Product + goal verb is a natural target, e.g. "add customer acme crm"
    // is not useful but "acme crm customer" often is — the n-gram pass over
    // the goal combined with the product name is computed by scoreOne.
  }

  return out;
}

/**
 * The LLM-visible directive block. Append to the writer's system prompt when
 * requesting body prose. Deliberately short — the plan carries the list.
 */
export function buildKeywordDirectives(plan: KeywordPlan): string {
  const lines: string[] = [];
  const chosen = plan.chosen;
  if (chosen.length === 0) {
    lines.push(
      "No target keywords are set for this guide. Write clear, specific prose and do not stuff or repeat a phrase for search purposes.",
    );
    return lines.join("\n");
  }
  lines.push("Target keywords for this guide:");
  for (const c of chosen) {
    const bits: string[] = [`- "${c.value}"`];
    if (c.required) bits.push("(required)");
    if (c.group !== null) bits.push(`[${c.group}]`);
    lines.push(bits.join(" "));
  }
  lines.push(
    "Rules for using keywords:",
    "    - Each required keyword must appear at least once in the body prose, in a sentence whose meaning is unchanged if the keyword were removed.",
    "    - Do not stuff a keyword into a step whose real subject is different. If a keyword does not fit a step, leave it out and note the miss for a reviewer.",
    "    - Do not repeat a keyword more than once per section. The platform does not target a keyword density and will not reward padding.",
    "    - Do not invent related keywords, synonyms or LSI phrases that are not listed and not present in the sources.",
  );
  return lines.join("\n");
}

export function rehydrateKeywordPlan(value: unknown): KeywordPlan {
  if (value === null || typeof value !== "object") {
    throw new KeywordsError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "keyword-plan/1") {
    throw new KeywordsError(
      `Rehydrate failed: expected version "keyword-plan/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  return {
    version: "keyword-plan/1",
    chosen: readChosen(r["chosen"]),
    suggested: readSuggested(r["suggested"]),
    scored: readScored(r["scored"]),
    notes: readNotes(r["notes"]),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function normaliseChosen(
  input: readonly (string | ChosenKeyword)[],
  notes: KeywordNote[],
): readonly ChosenKeyword[] {
  const out: ChosenKeyword[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (raw === null || raw === undefined) continue;
    let value: string;
    let required = false;
    let group: string | null = null;
    if (typeof raw === "string") {
      value = raw;
    } else if (typeof raw === "object") {
      value = typeof raw.value === "string" ? raw.value : "";
      required = raw.required === true;
      group = typeof raw.group === "string" && raw.group.trim().length > 0 ? raw.group.trim() : null;
    } else {
      continue;
    }
    const trimmed = value.trim();
    const normalised = normaliseKeyword(trimmed);
    if (normalised.length === 0) {
      notes.push({
        kind: "empty-suppressed",
        detail: `A chosen keyword was empty or contained only whitespace and was suppressed.`,
      });
      continue;
    }
    if (seen.has(normalised)) {
      notes.push({
        kind: "duplicate-suppressed",
        detail: `The keyword "${trimmed}" appears more than once in the chosen list; the duplicate was suppressed.`,
      });
      continue;
    }
    seen.add(normalised);
    out.push({ value: trimmed, normalised, required, group });
  }
  return out;
}

function scoreCandidates(
  brief: SeoBrief,
  candidates: readonly { readonly value: string; readonly source: KeywordSource }[],
): readonly ScoredKeyword[] {
  const out: ScoredKeyword[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const normalised = normaliseKeyword(c.value);
    if (normalised.length === 0) continue;
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    const scored = scoreOne(brief, c.value, normalised, c.source);
    out.push(scored);
  }
  return out;
}

function scoreOne(
  brief: SeoBrief,
  value: string,
  normalised: string,
  source: KeywordSource,
): ScoredKeyword {
  const goalNorm = normaliseKeyword(brief.goal);
  const productNorm = brief.productName !== null ? normaliseKeyword(brief.productName) : "";
  const stepNorms = brief.stepTitles
    .filter((t): t is string => typeof t === "string")
    .map((t) => normaliseKeyword(t));
  const prereqNorms = brief.prerequisites
    .filter((p): p is string => typeof p === "string")
    .map((p) => normaliseKeyword(p));

  const inGoal = goalNorm.includes(normalised);
  const inProductName = productNorm.length > 0 && productNorm.includes(normalised);
  const stepTitleHits = stepNorms.filter((t) => t.includes(normalised)).length;
  const inStepTitles = stepTitleHits > 0;
  const inPrerequisites = prereqNorms.some((p) => p.includes(normalised));

  const evidence: string[] = [];
  if (inGoal) evidence.push("goal");
  if (inStepTitles) evidence.push(`step titles ×${stepTitleHits}`);
  if (inProductName) evidence.push("product name");
  if (inPrerequisites) evidence.push("prerequisites");

  // Deterministic score. Weighting rationale:
  //   - Goal presence (0.35) is the strongest signal: the keyword names the
  //     workflow's actual outcome.
  //   - Step-title recurrence (0.10 per hit, capped at 0.30) captures
  //     workflow vocabulary the brief already uses.
  //   - Product mention (0.15) is a strong topical signal but only when the
  //     brief names a product.
  //   - Prerequisite mention (0.10) is a soft signal.
  //   - Shorter keywords (< 5 tokens) are slightly favoured because longer
  //     phrases are more brittle to match; the penalty is capped so a
  //     long-tail phrase with strong evidence still ranks highly.
  let score = 0;
  if (inGoal) score += 0.35;
  score += Math.min(0.30, 0.10 * stepTitleHits);
  if (inProductName) score += 0.15;
  if (inPrerequisites) score += 0.10;
  const tokenCount = normalised.split(/\s+/u).filter((t) => t.length > 0).length;
  if (tokenCount >= 5) score -= 0.05;
  if (tokenCount === 1) score -= 0.10;
  // Clamp into [0, 1].
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  const reason =
    evidence.length > 0
      ? `Appears in: ${evidence.join(", ")}.`
      : "Derived from the brief but not a verbatim substring of any single field (a multi-field signal).";

  return {
    value,
    normalised,
    source,
    score: Number(score.toFixed(4)),
    reason,
    evidence,
    inGoal,
    inStepTitles,
    inProductName,
    inPrerequisites,
    stepTitleHits,
  };
}

function compareScored(a: ScoredKeyword, b: ScoredKeyword): number {
  if (b.score !== a.score) return b.score - a.score;
  // Stable tie-break: alphabetical, so regeneration with identical inputs
  // produces identical output.
  if (a.normalised < b.normalised) return -1;
  if (a.normalised > b.normalised) return 1;
  return 0;
}

function hasAnyEvidence(normalised: string, brief: SeoBrief): boolean {
  const haystacks: string[] = [brief.goal];
  if (brief.productName !== null) haystacks.push(brief.productName);
  for (const s of brief.stepTitles) if (typeof s === "string") haystacks.push(s);
  for (const p of brief.prerequisites) if (typeof p === "string") haystacks.push(p);
  const hay = haystacks.map(normaliseKeyword).join(" ");
  return hay.includes(normalised);
}

function normaliseKeyword(s: string): string {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/gu, "")
    .replace(/[^a-z0-9\s\-_.+]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function cleanPhrase(s: string): string {
  return s
    .replace(/\s+/gu, " ")
    .replace(/^[\s,;:.!?\-–—]+/u, "")
    .replace(/[\s,;:.!?\-–—]+$/u, "")
    .trim();
}

function collapse(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

function ngrams(s: string, n: number): readonly string[] {
  if (typeof s !== "string" || s.length === 0 || n <= 0) return [];
  const tokens = s.split(/\s+/u).filter((t) => t.length > 0);
  if (tokens.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i += 1) {
    out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

function isStopwordOnly(phrase: string): boolean {
  const tokens = phrase
    .toLowerCase()
    .split(/\s+/u)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  return tokens.every((t) => STOP_WORDS.has(t));
}

/* -------------------------------------------------------------------------- */
/* Rehydrate readers                                                           */
/* -------------------------------------------------------------------------- */

function readChosen(v: unknown): readonly ChosenKeyword[] {
  if (!Array.isArray(v)) return [];
  const out: ChosenKeyword[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const value = typeof o["value"] === "string" ? o["value"] : "";
    const normalised = typeof o["normalised"] === "string" ? o["normalised"] : normaliseKeyword(value);
    if (value.trim().length === 0 || normalised.length === 0) continue;
    out.push({
      value,
      normalised,
      required: o["required"] === true,
      group: typeof o["group"] === "string" && o["group"].trim().length > 0 ? o["group"].trim() : null,
    });
  }
  return out;
}

function readSuggested(v: unknown): readonly SuggestedKeyword[] {
  if (!Array.isArray(v)) return [];
  const out: SuggestedKeyword[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const value = typeof o["value"] === "string" ? o["value"] : "";
    const normalised = typeof o["normalised"] === "string" ? o["normalised"] : normaliseKeyword(value);
    if (value.trim().length === 0 || normalised.length === 0) continue;
    out.push({
      value,
      normalised,
      source: readSource(o["source"]),
      score: readNumber(o["score"]),
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
      evidence: readStringList(o["evidence"]),
    });
  }
  return out;
}

function readScored(v: unknown): readonly ScoredKeyword[] {
  if (!Array.isArray(v)) return [];
  const out: ScoredKeyword[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const value = typeof o["value"] === "string" ? o["value"] : "";
    const normalised = typeof o["normalised"] === "string" ? o["normalised"] : normaliseKeyword(value);
    if (value.trim().length === 0 || normalised.length === 0) continue;
    out.push({
      value,
      normalised,
      source: readSource(o["source"]),
      score: readNumber(o["score"]),
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
      evidence: readStringList(o["evidence"]),
      inGoal: o["inGoal"] === true,
      inStepTitles: o["inStepTitles"] === true,
      inProductName: o["inProductName"] === true,
      inPrerequisites: o["inPrerequisites"] === true,
      stepTitleHits:
        typeof o["stepTitleHits"] === "number" && Number.isFinite(o["stepTitleHits"])
          ? Math.max(0, Math.floor(o["stepTitleHits"]))
          : 0,
    });
  }
  return out;
}

function readNotes(v: unknown): readonly KeywordNote[] {
  if (!Array.isArray(v)) return [];
  const out: KeywordNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "duplicate-suppressed" &&
      kind !== "empty-suppressed" &&
      kind !== "required-without-evidence" &&
      kind !== "no-chosen" &&
      kind !== "too-many-chosen" &&
      kind !== "stopword-only"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

function readSource(v: unknown): KeywordSource {
  return v === "operator-chosen" ||
    v === "derived-from-goal" ||
    v === "derived-from-steps" ||
    v === "derived-from-product" ||
    v === "keyword-memory"
    ? v
    : "operator-chosen";
}

function readNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return 0;
}

function readStringList(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  normaliseKeyword,
  cleanPhrase,
  collapse,
  ngrams,
  isStopwordOnly,
  compareScored,
  hasAnyEvidence,
  scoreOne,
  readChosen,
  readSuggested,
  readScored,
  readNotes,
  STOP_WORDS,
  MAX_SUGGESTIONS_DEFAULT,
  TOO_MANY_CHOSEN_THRESHOLD,
});
