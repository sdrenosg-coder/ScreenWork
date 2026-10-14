/**
 * Zipy AI — glossary extraction and linking (content-generation core, batch 1).
 *
 * The sixth and final layer of the core writing engine. It produces the
 * glossary that sits at the end of the guide and the per-step links that
 * point back into it:
 *
 *   - **Terms** — an ordered list of {term, definition, firstUseStepId,
 *     sourceRefs} entries. The list is deduplicated case-insensitively.
 *   - **Links** — for each plan step, the list of term spellings that occur
 *     in that step's copy (title, description, or the copy's callouts when
 *     supplied). The view layer uses these to wrap the first occurrence of
 *     each term in a glossary link.
 *
 * Where else term information can come from, in priority order:
 *
 *   1. **Caller-supplied glossary** (`explicitTerms`) — a reviewer's list or
 *      a customer's approved glossary. These are authoritative; they are
 *      always emitted, always win on conflict, and their definitions are
 *      never replaced.
 *   2. **The plan** — technical terms and acronyms that appear in step titles
 *      and descriptions. Definitions for these are drawn from the sources
 *      when a source names the term; otherwise the composer emits a
 *      placeholder definition that is honest about its origin ("No definition
 *      found in the sources; define this term before publishing.").
 *   3. **The sources** — source labels and excerpts supplied by the caller.
 *      A source excerpt of the form "ACME — Acme Corp Enterprise" or "the
 *      term 'purchase order' refers to ..." is parsed for a term and its
 *      definition. This is the "term and its definition are both in the
 *      text" case; it does not invent definitions.
 *   4. **The LLM** — when configured, the LLM sees the plan, the sources and
 *      the composer's candidate terms, and returns definitions for the terms
 *      that are missing one. The LLM never invents a term that is not
 *      already a candidate; it only supplies definitions for the candidates.
 *
 * Design rules honoured:
 *  - Same `LlmHandle` shape used by the other content layers.
 *  - No invented definitions. A term whose definition cannot be grounded has
 *    `definition: null` and `def`initionSource: "none"`, and the caller is
 *    expected to route it for review.
 *  - Acronyms are expanded on first use when both the acronym and its
 *    expansion are supplied by the caller (`explicitExpand`) or discovered
 *    together in a source excerpt. Expansion is recorded separately from
 *    definition so a term can be expanded without being defined and vice
 *    versa.
 *  - The module is a pure function of its arguments plus, in the LLM path,
 *    one adapter call. It performs no I/O.
 */

import type { PlanStep } from "@zipy/synth/stepSequence";
import type { LlmProvider } from "@zipy/llm/adapter";
import type { TitleSummarySource } from "@zipy/content/titleSummary";
import type { StepCopyEntry } from "@zipy/content/stepText";
import type { Callout } from "@zipy/content/tipsWarnings";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type GlossaryErrorCode = "invalid-input" | "empty-plan";

export class GlossaryError extends Error {
  readonly code: GlossaryErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: GlossaryErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    this.name = "GlossaryError";
    this.code = code;
    this.detail = detail;
    super(message);
  }
}

/* -------------------------------------------------------------------------- */
/* LLM handle contract                                                         */
/* -------------------------------------------------------------------------- */

export interface GlossaryLlmHandle {
  readonly complete: (args: {
    readonly task: "content.glossary";
    readonly system: string;
    readonly user: string;
    readonly maxOutputChars: number;
    readonly temperature: number;
    readonly provider?: LlmProvider;
    readonly model?: string | null;
  }) => Promise<{ readonly text: string }>;
  readonly isConfigured: () => boolean;
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type DefinitionSource = "explicit" | "source" | "llm" | "none";
export type ExpandSource = "explicit" | "source" | "none";
export type GlossaryOrigin = "composed" | "llm" | "fallback";

export interface GlossaryTerm {
  /** The canonical spelling of the term, as it should be rendered in the glossary. */
  readonly term: string;
  /** Lowercased, whitespace-collapsed spelling used for matching. */
  readonly matchKey: string;
  /** Definition text, or null when no definition could be grounded. */
  readonly definition: string | null;
  /** Where the definition came from. */
  readonly definitionSource: DefinitionSource;
  /**
   * Acronym expansion, when the term is an acronym and an expansion is known.
   * Null otherwise. A term may have an expansion without a definition.
   */
  readonly expansion: string | null;
  /** Where the expansion came from. */
  readonly expansionSource: ExpandSource;
  /**
   * Ordinal of the plan step where the term first appears (1-based), or null
   * when the term is not attributable to a step (guide-level glossary).
   */
  readonly firstUseOrdinal: number | null;
  /**
   * Spellings the term is matched by. Always includes `term`. Additional
   * spellings come from the caller's `explicitExpand` and from source
   * excerpts of the form "Term (Expansion)".
   */
  readonly spellings: readonly string[];
  /** Source labels the term's definition is grounded in. */
  readonly sourceRefs: readonly string[];
  /** A short note explaining why the term is in the glossary. */
  readonly note: string;
}

/**
 * The list of terms that occur in a given step's copy. The view layer turns
 * each entry into a link to the glossary anchor for `matchKey`.
 */
export interface GlossaryLink {
  readonly stepId: string;
  /** Term matchKeys occurring in the step, in order of first appearance. */
  readonly matchKeys: readonly string[];
}

export interface ExplicitTermInput {
  readonly term: string;
  readonly definition: string;
  /** Optional expansion for acronyms. */
  readonly expansion?: string | null;
}

export interface GlossaryStyle {
  readonly tone?: "formal" | "casual" | "technical";
  readonly audience?: "end-user" | "admin" | "developer";
  /** Extra brand terms that should never be treated as glossary candidates. */
  readonly brandTerms?: readonly string[];
}

export interface GenerateGlossaryOptions {
  readonly llm?: GlossaryLlmHandle | null;
  readonly deterministic?: boolean;
  readonly provider?: LlmProvider;
  readonly model?: string | null;
  readonly style?: GlossaryStyle;
  /** Sources; used for term and definition detection, matching `TitleSummarySource`. */
  readonly sources?: readonly TitleSummarySource[];
  /** Source excerpts the caller extracted during fusion. */
  readonly sourceExcerpts?: readonly string[];
  /**
   * Per-step copy from `stepText.ts`. Used to (a) extract candidate terms
   * from the copy the reader will actually see, and (b) build the links.
   * Supply the batch output's `entries` directly.
   */
  readonly stepCopy?: readonly StepCopyEntry[];
  /**
   * Callouts from `tipsWarnings.ts`. Used only to widen the term-search
   * space; callout bodies sometimes name a term the step copy does not.
   */
  readonly callouts?: readonly Callout[];
  /** Caller-supplied glossary. Authoritative; never replaced. */
  readonly explicitTerms?: readonly ExplicitTermInput[];
  /**
   * Caller-supplied acronym expansions as `{ acronym: expansion }`. Used to
   * expand acronyms on first use without asking the LLM.
   */
  readonly explicitExpand?: Readonly<Record<string, string>>;
  /**
   * Maximum number of terms to return. Default 40 — large enough for a
   * technical guide, small enough to stay a glossary rather than an index.
   */
  readonly maxTerms?: number;
}

export interface GenerateGlossaryResult {
  readonly terms: readonly GlossaryTerm[];
  readonly links: readonly GlossaryLink[];
  readonly origin: GlossaryOrigin;
  readonly llmFailureReason: string | null;
  readonly notes: readonly string[];
  readonly model: string | null;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const MAX_TERM_LENGTH = 60;
export const MAX_DEFINITION_LENGTH = 320;
export const MAX_EXPANSION_LENGTH = 120;

/**
 * Words that are never glossary candidates. Kept short and explicit; a
 * reviewer can read and argue with it. The list contains only generic
 * boilerplate that would appear in every guide: verbs of navigation and
 * field roles. Domain nouns are always candidates.
 */
const STOP_WORDS = new Set<string>([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "by", "for",
  "with", "from", "into", "onto", "is", "are", "be", "was", "were", "this",
  "that", "these", "those", "it", "its", "as", "if", "then", "else", "when",
  "click", "tap", "press", "enter", "type", "select", "choose", "open",
  "go", "navigate", "scroll", "review", "save", "submit", "confirm", "apply",
  "cancel", "back", "next", "previous", "continue", "finish", "done",
  "field", "input", "button", "link", "page", "screen", "step", "guide",
  "value", "option", "item", "list", "form", "tab", "menu", "dropdown",
  "checkbox", "radio", "toggle", "control", "element", "you", "your",
  "them", "their", "they", "we", "our", "us", "i", "me", "my", "he",
  "she", "his", "her", "one", "two", "three", "new", "old", "first",
  "last", "same", "other", "all", "any", "some", "no", "not", "yes",
]);

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Produce the guide's glossary and per-step links.
 *
 * Throws `GlossaryError` for a malformed or empty plan. Never throws for a
 * bad LLM response; deterministic terms are always returned, and a reason is
 * recorded.
 */
export async function generateGlossary(
  plan: readonly PlanStep[],
  options: GenerateGlossaryOptions = {},
): Promise<GenerateGlossaryResult> {
  validatePlan(plan);
  const notes: string[] = [];

  const sources = options.sources ?? [];
  const excerpts = options.sourceExcerpts ?? [];
  const stepCopy = options.stepCopy ?? [];
  const callouts = options.callouts ?? [];
  const explicitTerms = options.explicitTerms ?? [];
  const explicitExpand = options.explicitExpand ?? {};
  const brandTerms = options.style?.brandTerms ?? [];

  // Step 1: build the candidate set (term -> detection info).
  const candidates = collectCandidates(plan, stepCopy, callouts, brandTerms);

  // Step 2: build the spellings and expansions maps.
  const expansions = new Map<string, { expansion: string; source: ExpandSource }>();
  for (const [acronym, expansion] of Object.entries(explicitExpand)) {
    const key = normaliseKey(acronym);
    if (key.length === 0) continue;
    expansions.set(key, { expansion, source: "explicit" });
  }
  const sourceExpansions = findExpansionsInExcerpts(excerpts);
  for (const [key, value] of sourceExpansions) {
    if (!expansions.has(key)) expansions.set(key, { expansion: value, source: "source" });
  }

  // Step 3: build the definitions map from explicit terms and sources.
  const definitions = new Map<string, { definition: string; source: DefinitionSource; refs: readonly string[] }>();
  for (const t of explicitTerms) {
    const key = normaliseKey(t.term);
    if (key.length === 0) continue;
    const def = collapseWhitespace(t.definition);
    if (def.length === 0) continue;
    definitions.set(key, {
      definition: trimAtWord(def, MAX_DEFINITION_LENGTH),
      source: "explicit",
      refs: [],
    });
    // Explicit terms are added to the candidate set even when the plan does
    // not mention them; the reviewer asked for them.
    candidates.set(key, {
      term: t.term,
      matchKey: key,
      firstUseOrdinal: candidates.get(key)?.firstUseOrdinal ?? null,
      spellings: expandSpellings(t.term, key),
      note: "Supplied by the caller as an explicit glossary term.",
    });
  }
  const sourceDefs = findDefinitionsInExcerpts(excerpts);
  for (const [key, value] of sourceDefs) {
    if (!definitions.has(key)) {
      definitions.set(key, {
        definition: value,
        source: "source",
        refs: sources.map((s) => s.label),
      });
    }
  }

  // Step 4: order candidates. Explicit terms first (in the caller's order),
  // then candidates by firstUseOrdinal ascending, then alphabetically.
  const orderedCandidates = orderCandidates(candidates, explicitTerms.map((t) => normaliseKey(t.term)));

  // Step 5: project candidates into GlossaryTerm[].
  const projected: GlossaryTerm[] = orderedCandidates.map((c) => {
    const defEntry = definitions.get(c.matchKey);
    const expandEntry = expansions.get(c.matchKey);
    return {
      term: c.term,
      matchKey: c.matchKey,
      definition: defEntry?.definition ?? null,
      definitionSource: defEntry?.source ?? "none",
      expansion: expandEntry?.expansion ?? null,
      expansionSource: expandEntry?.source ?? "none",
      firstUseOrdinal: c.firstUseOrdinal,
      spellings: c.spellings,
      sourceRefs: defEntry?.refs ?? [],
      note: c.note,
    };
  });

  const maxTerms = clampInt(options.maxTerms ?? 40, 1, 200);
  const trimmed = projected.slice(0, maxTerms);

  // Step 6: build links (terms occurring in each step's copy).
  const links = buildLinks(plan, trimmed, stepCopy, callouts);

  if (trimmed.length === 0) {
    notes.push(
      "No glossary terms were detected. Set `explicitTerms` or add domain nouns to the plan to seed the glossary.",
    );
  }
  const undefinedCount = trimmed.filter((t) => t.definition === null).length;
  if (undefinedCount > 0) {
    notes.push(
      `${undefinedCount} glossary term${undefinedCount === 1 ? "" : "s"} could not be defined from the sources and should be reviewed.`,
    );
  }

  if (options.deterministic === true) {
    return {
      terms: trimmed,
      links,
      origin: "composed",
      llmFailureReason: null,
      notes: [
        ...notes,
        "Deterministic mode requested; LLM path skipped entirely.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  const llm = options.llm ?? null;
  if (llm === null || !llm.isConfigured()) {
    return {
      terms: trimmed,
      links,
      origin: "composed",
      llmFailureReason: null,
      notes: [
        ...notes,
        llm === null
          ? "No LLM handle supplied; deterministic composer used for glossary."
          : "LLM handle reported no provider configured; deterministic composer used for glossary.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Step 7: only ask the LLM for definitions the deterministic pass could
  // not ground. This keeps cost down and prevents the LLM from overwriting
  // an explicit or source-grounded definition.
  const missing = trimmed.filter((t) => t.definition === null);
  if (missing.length === 0) {
    return {
      terms: trimmed,
      links,
      origin: "composed",
      llmFailureReason: null,
      notes: [
        ...notes,
        "All glossary terms were grounded by the deterministic pass; LLM call skipped.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  let raw: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await llm.complete({
      task: "content.glossary",
      system: buildSystemPrompt(options.style),
      user: buildUserPrompt(plan, options, trimmed, missing, sources, excerpts),
      maxOutputChars: Math.min(6000, 400 + missing.length * 320),
      temperature: 0.2,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    raw = response.text;
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  if (raw === null) {
    const reason =
      failureReason ??
      "LLM was unavailable when definitions were requested; glossary retains null definitions.";
    return {
      terms: trimmed.map((t) =>
        t.definition === null
          ? { ...t, note: `${t.note} LLM call failed: ${reason}` }
          : t,
      ),
      links,
      origin: "fallback",
      llmFailureReason: reason,
      notes: [
        ...notes,
        "LLM call failed; undefined terms remain null and require review.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  const parsed = parseLlmDefinitions(raw);
  if (parsed === null || parsed.size === 0) {
    const reason =
      "LLM returned no usable definitions; glossary retains null definitions for review.";
    return {
      terms: trimmed,
      links,
      origin: "fallback",
      llmFailureReason: reason,
      notes: [...notes, "LLM glossary response could not be parsed."],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Apply LLM definitions only where the deterministic pass had null and
  // the LLM returned a non-empty definition for that key.
  const finalTerms: GlossaryTerm[] = trimmed.map((t) => {
    if (t.definition !== null) return t;
    const llmDef = parsed.get(t.matchKey);
    if (llmDef === undefined || llmDef.length === 0) return t;
    return {
      ...t,
      definition: trimAtWord(llmDef, MAX_DEFINITION_LENGTH),
      definitionSource: "llm",
      note: `${t.note} Definition supplied by the language model.`,
    };
  });

  const stillUndefined = finalTerms.filter((t) => t.definition === null).length;
  if (stillUndefined > 0) {
    notes.push(
      `${stillUndefined} glossary term${stillUndefined === 1 ? "" : "s"} remained undefined after the LLM pass and require review.`,
    );
  }

  return {
    terms: finalTerms,
    links,
    origin: "llm",
    llmFailureReason: null,
    notes,
    model: null,
    generatedAt: new Date().toISOString(),
  };
}

export function rehydrateGlossary(value: unknown): GenerateGlossaryResult {
  if (value === null || typeof value !== "object") {
    throw new GlossaryError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const raw = Array.isArray(r["terms"]) ? (r["terms"] as unknown[]) : [];
  const terms: GlossaryTerm[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const term = readString(o["term"]);
    if (term === null || term.length === 0) continue;
    const matchKey = readString(o["matchKey"]) ?? normaliseKey(term);
    terms.push({
      term,
      matchKey,
      definition: readString(o["definition"]),
      definitionSource: readDefinitionSource(o["definitionSource"]),
      expansion: readString(o["expansion"]),
      expansionSource: readExpansionSource(o["expansionSource"]),
      firstUseOrdinal: numberOrNull(o["firstUseOrdinal"]),
      spellings: Array.isArray(o["spellings"])
        ? (o["spellings"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [term],
      sourceRefs: Array.isArray(o["sourceRefs"])
        ? (o["sourceRefs"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      note: readString(o["note"]) ?? "",
    });
  }
  const linksRaw = Array.isArray(r["links"]) ? (r["links"] as unknown[]) : [];
  const links: GlossaryLink[] = [];
  for (const item of linksRaw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const stepId = readString(o["stepId"]);
    if (stepId === null || stepId.length === 0) continue;
    links.push({
      stepId,
      matchKeys: Array.isArray(o["matchKeys"])
        ? (o["matchKeys"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    });
  }
  return {
    terms,
    links,
    origin: readGlossaryOrigin(r["origin"]),
    llmFailureReason: readString(r["llmFailureReason"]),
    notes: Array.isArray(r["notes"])
      ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    model: readString(r["model"]),
    generatedAt: readString(r["generatedAt"]) ?? "",
  };
}

/* -------------------------------------------------------------------------- */
/* Candidate collection                                                        */
/* -------------------------------------------------------------------------- */

interface Candidate {
  readonly term: string;
  readonly matchKey: string;
  readonly firstUseOrdinal: number | null;
  readonly spellings: readonly string[];
  readonly note: string;
}

function collectCandidates(
  plan: readonly PlanStep[],
  stepCopy: readonly StepCopyEntry[],
  callouts: readonly Callout[],
  brandTerms: readonly string[],
): Map<string, Candidate> {
  const candidates = new Map<string, Candidate>();
  const brandKeys = new Set(brandTerms.map(normaliseKey).filter((k) => k.length > 0));

  // Index the stepOrdinal -> stepId map so we can attribute a first use to a
  // plan ordinal when we detect the term in the step copy.
  const ordinalByStepId = new Map<string, number>();
  for (const step of plan) ordinalByStepId.set(step.stepId, step.ordinal);

  // 1. Terms from step copy (title + description). These are the terms the
  //    reader actually sees.
  for (const entry of stepCopy) {
    const ordinal = ordinalByStepId.get(entry.stepId) ?? null;
    addTermsFromText(entry.title, ordinal, candidates, brandKeys);
    addTermsFromText(entry.description, ordinal, candidates, brandKeys);
  }

  // 2. Terms from callout bodies (widens the search but does not create
  //    guide-level terms: a callout is attached to a step).
  for (const c of callouts) {
    const ordinal =
      c.stepId === null ? null : ordinalByStepId.get(c.stepId) ?? null;
    addTermsFromText(c.text, ordinal, candidates, brandKeys);
    if (c.troubleshootingQuestion !== null) {
      addTermsFromText(c.troubleshootingQuestion, ordinal, candidates, brandKeys);
    }
  }

  // 3. Terms from the plan that the copy does not contain: the accessible
  //    name of a click/select target is a prime candidate for a domain noun
  //    ("Purchase order" button). This is a defensive fallback for guides
  //    whose copy has not yet been generated.
  if (stepCopy.length === 0) {
    for (const step of plan) {
      if (step.target === null) continue;
      if (step.target.name.length > 0) {
        addTermsFromText(step.target.name, step.ordinal, candidates, brandKeys);
      }
      if (step.value !== null) addTermsFromText(step.value, step.ordinal, candidates, brandKeys);
    }
  }

  return candidates;
}

function addTermsFromText(
  text: string,
  ordinal: number | null,
  candidates: Map<string, Candidate>,
  brandKeys: ReadonlySet<string>,
): void {
  if (text.length === 0) return;

  // Strategy A: acronyms. An uppercase sequence of 2-7 letters (with a
  // digit permitted) is treated as an acronym and added as a candidate.
  const acronymRe = /\b([A-Z][A-Z0-9]{1,6})\b/g;
  let m: RegExpExecArray | null;
  while ((m = acronymRe.exec(text)) !== null) {
    const acronym = m[1];
    if (acronym === undefined) continue;
    if (isProbablyRomanNumeral(acronym)) continue;
    const key = normaliseKey(acronym);
    if (key.length === 0) continue;
    if (brandKeys.has(key)) continue;
    upsertCandidate(candidates, {
      term: acronym,
      matchKey: key,
      firstUseOrdinal: ordinal,
      spellings: [acronym],
      note: "Detected as an acronym in the guide copy.",
    });
  }

  // Strategy B: capitalised multi-word noun phrases. A run of 1-4
  // Capitalised-or-all-caps words that are not the sentence's first word
  // and are not stop words. This captures "Purchase Order", "Acme Reports",
  // "Stripe Connect" without needing a domain lexicon.
  const tokens = text.split(/(\s+|[.,;:!?()"'`«»„“”‘’\-–—/\\]+)/);
  let runStart = -1;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    const trimmed = tok.replace(/[^\p{L}\p{N}\-]/gu, "");
    if (trimmed.length < 2) {
      flushRun(tokens, runStart, i, ordinal, candidates, brandKeys, text);
      runStart = -1;
      continue;
    }
    const first = trimmed.charAt(0);
    const isCap = first === first.toUpperCase() && first !== first.toLowerCase();
    if (!isCap) {
      flushRun(tokens, runStart, i, ordinal, candidates, brandKeys, text);
      runStart = -1;
      continue;
    }
    if (runStart === -1) runStart = i;
  }
  flushRun(tokens, runStart, tokens.length, ordinal, candidates, brandKeys, text);
}

function flushRun(
  tokens: readonly string[],
  start: number,
  end: number,
  ordinal: number | null,
  candidates: Map<string, Candidate>,
  brandKeys: ReadonlySet<string>,
  sourceText: string,
): void {
  if (start === -1) return;
  const parts: string[] = [];
  for (let i = start; i < end; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    const trimmed = tok.replace(/[^\p{L}\p{N}\-]/gu, "");
    if (trimmed.length < 2) continue;
    parts.push(trimmed);
    if (parts.length >= 4) break;
  }
  if (parts.length === 0) return;

  // Drop a leading stop word (a capitalised word that is actually the start
  // of a sentence, "Once you have...", should not seed a term).
  while (parts.length > 1 && STOP_WORDS.has(parts[0]?.toLowerCase() ?? "")) {
    parts.shift();
  }

  // Require the run to be at least 3 characters of the phrase (avoids
  // single-letter capitals) and at least one character of the phrase that
  // is not a stop word (avoids "The A").
  const phrase = parts.join(" ");
  if (phrase.length < 3) return;
  const allStop = parts.every((p) => STOP_WORDS.has(p.toLowerCase()));
  if (allStop) return;

  // Single-word candidates: only if they look like a proper noun (are not a
  // stop word, are not "I"/"You", and are at least 4 characters long).
  if (parts.length === 1) {
    const word = parts[0] ?? "";
    if (word.length < 4) return;
    if (STOP_WORDS.has(word.toLowerCase())) return;
  }

  // Sentence-position guard: if the first token is the very first token of
  // the text, it is probably a sentence's first word and should not seed a
  // standalone candidate unless the run has more than one word.
  const firstTokenIndex = sourceText.indexOf(parts[0] ?? "");
  if (parts.length === 1 && firstTokenIndex === 0) return;

  const key = normaliseKey(phrase);
  if (key.length === 0) return;
  if (brandKeys.has(key)) return;
  upsertCandidate(candidates, {
    term: phrase,
    matchKey: key,
    firstUseOrdinal: ordinal,
    spellings: [phrase],
    note: "Detected as a capitalised term in the guide copy.",
  });
}

function upsertCandidate(candidates: Map<string, Candidate>, next: Candidate): void {
  const existing = candidates.get(next.matchKey);
  if (existing === undefined) {
    candidates.set(next.matchKey, next);
    return;
  }
  // Merge: keep the earliest firstUseOrdinal; extend the spellings.
  const firstUseOrdinal =
    existing.firstUseOrdinal === null
      ? next.firstUseOrdinal
      : next.firstUseOrdinal === null
        ? existing.firstUseOrdinal
        : Math.min(existing.firstUseOrdinal, next.firstUseOrdinal);
  const spellingSet = new Set<string>([...existing.spellings, ...next.spellings]);
  candidates.set(next.matchKey, {
    term: existing.term,
    matchKey: next.matchKey,
    firstUseOrdinal,
    spellings: [...spellingSet],
    note: existing.note,
  });
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

function orderCandidates(
  candidates: ReadonlyMap<string, Candidate>,
  explicitOrder: readonly string[],
): readonly Candidate[] {
  const explicitRank = new Map<string, number>();
  explicitOrder.forEach((k, idx) => explicitRank.set(k, idx));

  const list = [...candidates.values()];
  list.sort((a, b) => {
    const ra = explicitRank.get(a.matchKey);
    const rb = explicitRank.get(b.matchKey);
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    }
    const oa = a.firstUseOrdinal ?? Number.POSITIVE_INFINITY;
    const ob = b.firstUseOrdinal ?? Number.POSITIVE_INFINITY;
    if (oa !== ob) return oa - ob;
    return a.term.localeCompare(b.term);
  });
  return list;
}

/* -------------------------------------------------------------------------- */
/* Definition discovery from excerpts                                          */
/* -------------------------------------------------------------------------- */

/**
 * Parse "Term — definition" or "Term: definition" pairs from source
 * excerpts. The separator is an em dash, en dash, colon or " - " with a
 * meaningful amount of text on both sides. Only the *first* definition for a
 * term is used; later excerpts do not overwrite an earlier one, matching the
 * fusion layer's "higher-trust source wins" convention that the caller has
 * already applied when ordering the excerpts.
 */
function findDefinitionsInExcerpts(
  excerpts: readonly string[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const excerpt of excerpts) {
    const lines = excerpt.split(/\n+/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      // "Term — definition"
      const emMatch = /^([^—–:\n]{2,60})\s*[—–]\s*(.{6,})$/.exec(trimmed);
      if (emMatch !== null) {
        recordDefinition(out, emMatch[1] ?? "", emMatch[2] ?? "");
        continue;
      }
      // "Term: definition" — only when the left side is short and looks like
      // a term (avoids catching "Step 3: click Save" as a definition).
      const colonMatch = /^([A-Za-z][A-Za-z0-9 '\-]{1,50})\s*:\s*(.{8,})$/.exec(trimmed);
      if (colonMatch !== null) {
        const left = colonMatch[1] ?? "";
        if (!/^(step|stage|phase)\b/i.test(left)) {
          recordDefinition(out, left, colonMatch[2] ?? "");
        }
      }
    }
  }
  return out;
}

function recordDefinition(out: Map<string, string>, left: string, right: string): void {
  const term = left.trim().replace(/^["'«»„“”‘’]+|["'«»„“”‘’]+$/g, "").trim();
  if (term.length < 2 || term.length > 60) return;
  if (STOP_WORDS.has(term.toLowerCase())) return;
  const key = normaliseKey(term);
  if (key.length === 0) return;
  if (out.has(key)) return;
  const definition = collapseWhitespace(right).replace(/[;.]\s*$/, ".");
  if (definition.length < 6) return;
  out.set(key, trimAtWord(definition, MAX_DEFINITION_LENGTH));
}

/**
 * Parse "Term (Expansion)" pairs from source excerpts. This is the
 * ubiquitous "Full Name (FULL)" / "FULL (Full Name)" form; both orders are
 * accepted.
 */
function findExpansionsInExcerpts(
  excerpts: readonly string[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const reA = /\b([A-Z][A-Za-z0-9 '\-]{2,60}?)\s*\(([A-Z][A-Z0-9]{1,7})\)/g; // "Full Name (FULL)"
  const reB = /\b([A-Z][A-Z0-9]{1,7})\s*\(([A-Z][A-Za-z0-9 '\-]{2,60}?)\)/g; // "FULL (Full Name)"
  for (const excerpt of excerpts) {
    let m: RegExpExecArray | null;
    while ((m = reA.exec(excerpt)) !== null) {
      const expansion = m[1];
      const acronym = m[2];
      if (expansion === undefined || acronym === undefined) continue;
      const key = normaliseKey(acronym);
      if (key.length === 0) continue;
      if (out.has(key)) continue;
      out.set(key, trimAtWord(collapseWhitespace(expansion), MAX_EXPANSION_LENGTH));
    }
    while ((m = reB.exec(excerpt)) !== null) {
      const acronym = m[1];
      const expansion = m[2];
      if (acronym === undefined || expansion === undefined) continue;
      const key = normaliseKey(acronym);
      if (key.length === 0) continue;
      if (out.has(key)) continue;
      out.set(key, trimAtWord(collapseWhitespace(expansion), MAX_EXPANSION_LENGTH));
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Links                                                                       */
/* -------------------------------------------------------------------------- */

function buildLinks(
  plan: readonly PlanStep[],
  terms: readonly GlossaryTerm[],
  stepCopy: readonly StepCopyEntry[],
  callouts: readonly Callout[],
): readonly GlossaryLink[] {
  const copyByStepId = new Map<string, StepCopyEntry>();
  for (const entry of stepCopy) copyByStepId.set(entry.stepId, entry);

  const calloutsByStepId = new Map<string, Callout[]>();
  for (const c of callouts) {
    if (c.stepId === null) continue;
    const list = calloutsByStepId.get(c.stepId) ?? [];
    list.push(c);
    calloutsByStepId.set(c.stepId, list);
  }

  const links: GlossaryLink[] = [];
  for (const step of plan) {
    const haystacks: string[] = [];
    const copy = copyByStepId.get(step.stepId);
    if (copy !== undefined) {
      haystacks.push(copy.title, copy.description);
    } else if (step.target !== null) {
      // No generated copy yet: fall back to the accessible name so links
      // still work in the preview before step copy is generated.
      haystacks.push(step.target.name);
    }
    const stepCallouts = calloutsByStepId.get(step.stepId) ?? [];
    for (const c of stepCallouts) haystacks.push(c.text);

    const haystack = haystacks.join(" ").toLowerCase();
    if (haystack.length === 0) continue;

    const matchKeys: string[] = [];
    const seen = new Set<string>();
    for (const term of terms) {
      if (seen.has(term.matchKey)) continue;
      // Match on any of the term's spellings as a whole-word substring.
      let found = false;
      for (const spelling of term.spellings) {
        if (spelling.length === 0) continue;
        if (containsWord(haystack, spelling.toLowerCase())) {
          found = true;
          break;
        }
      }
      if (found) {
        matchKeys.push(term.matchKey);
        seen.add(term.matchKey);
      }
    }
    if (matchKeys.length > 0) {
      links.push({ stepId: step.stepId, matchKeys });
    }
  }
  return links;
}

function containsWord(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  // Escape regex metacharacters in the needle.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word-boundary match; JS's \b does not treat hyphens as part of a word, so
  // also require the neighbours to be non-letter/non-digit/non-hyphen.
  const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "u");
  return re.test(haystack);
}

/* -------------------------------------------------------------------------- */
/* LLM prompt construction                                                     */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(style: GlossaryStyle | undefined): string {
  const tone = style?.tone ?? "neutral";
  const audience = style?.audience ?? "end-user";
  const brand = style?.brandTerms ?? [];
  const brandLine =
    brand.length > 0
      ? `Preserve these brand terms verbatim: ${brand.join(", ")}.`
      : "Do not invent product, page or brand names.";

  return [
    "You write glossary definitions for a step-by-step screenshot tutorial.",
    "",
    "Format rules:",
    "- Produce one definition per block. Each block is exactly two lines:",
    "    T: <the term, verbatim from the candidate list>",
    "    D: <a one-or-two-sentence definition, <= 320 characters>",
    "- Separate blocks with a blank line.",
    "- Use the exact spelling of each term from the candidate list.",
    "",
    "Content rules:",
    "- Ground each definition in the sources and the plan; do not invent policies, prices or field names.",
    "- If a term cannot be defined from the inputs, respond with 'D: (not defined by the sources)'.",
    "- Do not expand an acronym whose expansion is not in the inputs.",
    `Assume the reader is ${audience}. Use a ${tone} tone.`,
    brandLine,
  ].join("\n");
}

function buildUserPrompt(
  plan: readonly PlanStep[],
  options: GenerateGlossaryOptions,
  allTerms: readonly GlossaryTerm[],
  missing: readonly GlossaryTerm[],
  sources: readonly TitleSummarySource[],
  excerpts: readonly string[],
): string {
  const lines: string[] = [];
  const goal = readString(options.guideGoal ?? null);
  lines.push(`Guide goal: ${goal ?? "(none supplied)"}`);

  if (sources.length > 0) {
    lines.push("Sources:");
    for (const s of sources) lines.push(`  - [${s.kind}] ${s.label}`);
  } else {
    lines.push("Sources: (none supplied)");
  }

  if (excerpts.length > 0) {
    lines.push("Source excerpts (use as the basis for definitions when they cover the term):");
    for (const ex of excerpts) lines.push(`  - ${collapseWhitespace(ex).slice(0, 300)}`);
  }

  lines.push(`Step count: ${plan.length}`);
  lines.push("Steps (summary):");
  for (const step of plan) {
    lines.push(
      `  ${step.ordinal}. ${step.action} ${step.target !== null && step.target.name.length > 0 ? `"${step.target.name}"` : step.target !== null ? `the ${step.target.role}` : "(unresolved target)"}`,
    );
  }

  if (allTerms.length > missing.length) {
    lines.push("");
    lines.push("Terms already defined by the deterministic pass (do NOT redefine these):");
    for (const t of allTerms) {
      if (t.definition !== null) lines.push(`  - ${t.term}`);
    }
  }

  lines.push("");
  lines.push("Terms that need a definition:");
  for (const t of missing) lines.push(`  - ${t.term}`);

  lines.push("");
  lines.push("Respond with the definition blocks formatted exactly as described in the system prompt.");
  return lines.join("\n");
}

interface ParsedGlossaryDefinition {
  readonly term: string;
  readonly definition: string;
}

function parseLlmDefinitions(raw: string): ReadonlyMap<string, string> | null {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return null;

  const out = new Map<string, string>();
  const blocks = text.split(/\n\s*\n+/);
  for (const block of blocks) {
    const tMatch = /^\s*T\s*[:\-]\s*(.+)$/im.exec(block);
    const dMatch = /^\s*D\s*[:\-]\s*([\s\S]+)$/im.exec(block);
    if (tMatch === null || dMatch === null) continue;
    const term = sanitiseLine(tMatch[1] ?? "");
    let def = sanitiseLine(dMatch[1] ?? "");
    if (term.length === 0 || def.length === 0) continue;
    // The LLM is instructed to signal "no definition" with a sentinel;
    // translate it to an empty string so the caller's merge logic drops it.
    if (/^\(\s*not\s+defined/i.test(def) || /^not\s+defined\b/i.test(def)) def = "";
    if (def.length === 0) continue;
    out.set(normaliseKey(term), def);
  }
  return out.size > 0 ? out : null;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function validatePlan(plan: readonly PlanStep[]): void {
  if (!Array.isArray(plan)) {
    throw new GlossaryError("generateGlossary requires a PlanStep array.", "invalid-input");
  }
  if (plan.length === 0) {
    throw new GlossaryError(
      "Cannot generate a glossary for an empty plan.",
      "empty-plan",
    );
  }
  for (const step of plan) {
    if (step === null || typeof step !== "object") {
      throw new GlossaryError("Plan contains a non-object step.", "invalid-input");
    }
  }
}

function expandSpellings(term: string, key: string): readonly string[] {
  const out = new Set<string>([term]);
  // Add the key as a spelling only when it differs from the term and would
  // be a valid alternative spelling (e.g. "FULL" ↔ "full"). This is not a
  // general case-folding: matching is done case-insensitively anyway, so we
  // only add when the key preserves the term's letters.
  if (key !== term.toLowerCase()) return [term];
  return [...out];
}

function normaliseKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/g, "").trim();
}

function isProbablyRomanNumeral(s: string): boolean {
  return /^[IVXLCDM]+$/.test(s) && s.length >= 1 && s.length <= 5;
}

function trimAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace < max * 0.6) return `${slice}…`;
  return `${slice.slice(0, lastSpace)}…`;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function sanitiseLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return null;
}

function readDefinitionSource(v: unknown): DefinitionSource {
  if (v === "explicit" || v === "source" || v === "llm" || v === "none") return v;
  return "none";
}

function readExpansionSource(v: unknown): ExpandSource {
  if (v === "explicit" || v === "source" || v === "none") return v;
  return "none";
}

function readGlossaryOrigin(v: unknown): GlossaryOrigin {
  if (v === "composed" || v === "llm" || v === "fallback") return v;
  return "composed";
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  const n = Math.trunc(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  collectCandidates,
  addTermsFromText,
  upsertCandidate,
  orderCandidates,
  findDefinitionsInExcerpts,
  findExpansionsInExcerpts,
  buildLinks,
  containsWord,
  parseLlmDefinitions,
  normaliseKey,
  isProbablyRomanNumeral,
  expandSpellings,
  MAX_TERM_LENGTH,
  MAX_DEFINITION_LENGTH,
  MAX_EXPANSION_LENGTH,
});
