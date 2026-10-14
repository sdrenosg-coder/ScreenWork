/**
 * Zipy AI — natural-language prompt ingestion (worker side).
 *
 * The user does not have to hand-author a workflow graph. This module accepts a
 * free-form description of the goal ("Create a new customer with name Jane Doe
 * and email jane@example.com") and returns a *structured plan scaffold*: the
 * goal, the entity list, the ordered sub-tasks and, when a URL ingest was
 * provided alongside, the set of candidate element refs from that page's
 * element index. It is intentionally the shallow half of text-to-action: no
 * browser, no LLM round-trip, no mutation of the URL artifact. The synthesis
 * phase consumes this output and augments it with a11y grounding.
 *
 * Design notes:
 *  - Parsing is deterministic and offline. There is no network call, no model
 *    invocation and no external service required. This module does not pretend
 *    to be the LLM: it extracts the goal + entities + naively split sub-tasks,
 *    and marks each sub-task with a `needsGrounding: true` flag so the
 *    synthesis phase knows to attach a stable ref from the element index. That
 *    is the honest split: structure here, grounding later.
 *  - Entity extraction is rule-based and bounded. It recognises emails, URLs,
 *    phone numbers, dates (ISO), numbers and quoted strings. It does NOT
 *    invent a semantic type it cannot justify ("Jane Doe" is not confidently a
 *    `person_name`). Better to surface the raw literal than fabricate a label.
 *    Callers that have an LLM configured may subsequently classify these
 *    entities; the deterministic extraction is what is guaranteed offline.
 *  - Sub-task splitting uses a small set of action verbs as the split anchor
 *    ("click", "open", "navigate", "type", "enter", "fill", "select", "choose",
 *    "submit", "save", "press", "download", "upload", "review", "verify",
 *    "confirm", "toggle", "close", "expand", "collapse", "search", "sign",
 *    "log"). If none of the verbs appear, we return a single sub-task whose
 *    description is the entire prompt (never fabricate a sequence).
 *  - The result is JSON-serializable and its shape is stable within a session;
 *    fields are additive only.
 *  - No credentials, no network, no filesystem access. Pure.
 */

import { slugifyName } from "@zipy/ingest/stableRefs";
import type { ElementIndex, IndexedElement } from "@zipy/ingest/elementIndex";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class TextPromptError extends Error {
  readonly code:
    | "empty-prompt"
    | "too-long"
    | "internal";
  constructor(message: string, code: TextPromptError["code"]) {
    super(message);
    this.name = "TextPromptError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type EntityKind =
  | "email"
  | "url"
  | "phone"
  | "iso_date"
  | "number"
  | "quoted_string"
  | "unclassified";

export interface ExtractedEntity {
  /** Raw literal as it appeared in the prompt. */
  readonly literal: string;
  /** Best-effort kind; never fabricated when uncertain (`unclassified`). */
  readonly kind: EntityKind;
  /** Character offset of the first occurrence in the original prompt. */
  readonly offset: number;
}

export type SubTaskVerb =
  | "click"
  | "open"
  | "navigate"
  | "type"
  | "enter"
  | "fill"
  | "select"
  | "choose"
  | "submit"
  | "save"
  | "press"
  | "download"
  | "upload"
  | "review"
  | "verify"
  | "confirm"
  | "toggle"
  | "close"
  | "expand"
  | "collapse"
  | "search"
  | "sign"
  | "log"
  | "unknown";

export interface SubTask {
  /** 1-based ordinal within the prompt. */
  readonly ordinal: number;
  /** Detected verb, or `unknown` when the clause did not lead with a verb. */
  readonly verb: SubTaskVerb;
  /** The clause text verbatim (trimmed). */
  readonly description: string;
  /**
   * True when this sub-task has no grounding yet — the synthesis phase must
   * attach a stable element ref from the element index before it can be
   * executed by Playwright.
   */
  readonly needsGrounding: boolean;
  /**
   * Candidate element refs from the attached element index whose role or name
   * loosely matches this sub-task's text. Empty when no index was supplied or
   * no candidate is plausible. Never fabricated.
   */
  readonly candidateRefs: readonly string[];
}

export interface ParsedPrompt {
  /** The verbatim prompt. */
  readonly prompt: string;
  /** Human-readable goal sentence derived from the first clause. */
  readonly goal: string;
  /** Entities extracted from the prompt (may be empty). */
  readonly entities: readonly ExtractedEntity[];
  /** Ordered sub-tasks. Always at least one. */
  readonly subTasks: readonly SubTask[];
  /** True when the caller supplied a page element index we attached to. */
  readonly grounded: boolean;
  /** ISO timestamp of parsing. */
  readonly parsedAt: string;
  /** Number of characters in the source prompt. */
  readonly characterCount: number;
}

export interface ParsePromptOptions {
  /** Free-form prompt. Required, non-empty after trim, ≤ 20_000 characters. */
  readonly prompt: string;
  /**
   * Optional element index from a URL ingest. When supplied, candidate refs
   * are attached to each sub-task. When omitted, `grounded: false` and every
   * sub-task carries an empty `candidateRefs` array.
   */
  readonly elementIndex?: ElementIndex;
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

const MAX_PROMPT_LENGTH = 20_000;

/* -------------------------------------------------------------------------- */
/* Entity extraction                                                           */
/* -------------------------------------------------------------------------- */

// Order matters — the most specific patterns run first so an email is not also
// reported as a quoted string, and an ISO date is not also reported as a
// number. Each regex is `g` and global-multi-match; we walk them in priority
// order and de-overlap by character offset.

const ENTITY_PATTERNS: readonly {
  readonly kind: EntityKind;
  readonly re: RegExp;
}[] = [
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: "url", re: /https?:\/\/[^\s"')]+/g },
  {
    kind: "iso_date",
    re: /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  },
  {
    kind: "phone",
    re: /(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?!\d)/g,
  },
  { kind: "quoted_string", re: /"([^"\n]{1,200})"|'([^'\n]{1,200})'/g },
  { kind: "number", re: /(?<![\w.-])\d+(?:\.\d+)?(?![\w.-])/g },
];

interface OffsetSpan {
  readonly start: number;
  readonly end: number;
}

function overlapsAny(span: OffsetSpan, taken: readonly OffsetSpan[]): boolean {
  for (const t of taken) {
    if (span.start < t.end && span.end > t.start) return true;
  }
  return false;
}

function extractEntities(prompt: string): readonly ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const taken: OffsetSpan[] = [];
  for (const { kind, re } of ENTITY_PATTERNS) {
    // Fresh lastIndex per pattern because the regex is cached on the module.
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(prompt)) !== null) {
      const literal = match[0];
      if (literal.length === 0) continue;
      const span: OffsetSpan = {
        start: match.index,
        end: match.index + literal.length,
      };
      if (overlapsAny(span, taken)) continue;
      // For quoted strings, prefer the capture group over the quotes.
      let raw = literal;
      if (kind === "quoted_string") {
        raw = match[1] ?? match[2] ?? literal;
        if (raw.length === 0) continue;
      }
      taken.push(span);
      entities.push({ literal: raw, kind, offset: match.index });
    }
  }
  // Sort by offset so the order matches the prompt.
  entities.sort((a, b) => a.offset - b.offset);
  return entities;
}

/* -------------------------------------------------------------------------- */
/* Sub-task splitting                                                          */
/* -------------------------------------------------------------------------- */

const VERB_ALIASES: Readonly<Record<string, SubTaskVerb>> = {
  click: "click",
  tap: "click",
  press: "press",
  open: "open",
  navigate: "navigate",
  go: "navigate",
  type: "type",
  enter: "enter",
  fill: "fill",
  select: "select",
  choose: "choose",
  pick: "choose",
  submit: "submit",
  save: "save",
  download: "download",
  upload: "upload",
  review: "review",
  verify: "verify",
  confirm: "confirm",
  toggle: "toggle",
  close: "close",
  expand: "expand",
  collapse: "collapse",
  search: "search",
  find: "search",
  sign: "sign",
  login: "log",
  log: "log",
};

/**
 * Tokenize the prompt into clauses, then label each clause with its leading
 * verb. Splitting uses commas, semicolons, newlines and the word "then" as
 * separators. We deliberately do not split on "and" — "click and type" is one
 * compound action in practice and splitting it invents two steps that share a
 * single UI element.
 */
function splitClauses(prompt: string): readonly string[] {
  // Normalise whitespace first so newlines become stable separators.
  const normalised = prompt.replace(/\s+/g, " ").trim();
  // Insert a comma before " then " so the split below is uniform.
  const withThen = normalised.replace(/\s+then\s+/gi, "; ");
  const pieces = withThen
    .split(/[;,.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return pieces;
}

function detectVerb(clause: string): SubTaskVerb {
  // Look at the first word (case-insensitive, punctuation-stripped).
  const firstWordMatch = /^([A-Za-z]+)/.exec(clause);
  if (firstWordMatch === null) return "unknown";
  const word = firstWordMatch[1].toLowerCase();
  return VERB_ALIASES[word] ?? "unknown";
}

/* -------------------------------------------------------------------------- */
/* Element-index candidate matching                                            */
/* -------------------------------------------------------------------------- */

/**
 * Compute plausible element refs for a clause by looking for element names or
 * roles that appear in the clause text. This is intentionally recall-oriented
 * and always bounded — we return at most 5 refs per sub-task and never invent
 * one. The synthesis phase re-ranks; this is a hint set.
 *
 * Matching strategy:
 *  - For each interactive element with a non-empty name, compute its slug.
 *    If the slug or a token from the slug appears as a whole word in the
 *    clause, the element is a candidate.
 *  - Score by descending slug length (more specific wins) and by the element
 *    being enabled. Stable ties broken by index order for determinism.
 */
function candidateRefsForClause(
  clause: string,
  index: ElementIndex | undefined,
): readonly string[] {
  if (index === undefined) return [];
  const clauseTokens = new Set(
    clause
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
  if (clauseTokens.size === 0) return [];

  interface Scored {
    readonly ref: string;
    readonly score: number;
    readonly order: number;
  }
  const scored: Scored[] = [];

  index.elements.forEach((el: IndexedElement, order: number) => {
    const slug = slugifyName(el.name);
    if (slug.length === 0) return;
    const slugTokens = slug.split("-").filter((t) => t.length >= 3);
    if (slugTokens.length === 0) return;
    let hits = 0;
    for (const token of slugTokens) {
      if (clauseTokens.has(token)) hits += 1;
    }
    if (hits === 0) return;
    // Score: number of slug tokens that matched, weighted by the element being
    // enabled (a disabled button is less plausible) and by slug length
    // (a longer slug means a more specific name match).
    const enabledBonus = el.enabled ? 1 : 0;
    const score = hits * 10 + enabledBonus + Math.min(slug.length, 32) / 32;
    scored.push({ ref: el.ref, score, order });
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.order - b.order;
  });
  return scored.slice(0, 5).map((s) => s.ref);
}

/* -------------------------------------------------------------------------- */
/* Goal derivation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Derive a short goal sentence from the prompt. The heuristic: use the first
 * clause, capitalised, with a trailing period. If the first clause is longer
 * than 160 characters, truncate at a word boundary. Never fabricate a goal
 * that is not present in the prompt.
 */
function deriveGoal(prompt: string, firstClause: string): string {
  const base = firstClause.length > 0 ? firstClause : prompt.trim();
  const capped =
    base.length > 160
      ? base.slice(0, 157).replace(/\s+\S*$/, "") + "…"
      : base;
  const capitalised = capped.charAt(0).toUpperCase() + capped.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Parse a free-form prompt into a `ParsedPrompt`. Pure and deterministic: the
 * same input yields the same output (modulo `parsedAt`, which is a wall-clock
 * timestamp and deliberately NOT part of any hash the caller computes over the
 * parsed structure for cache keying — callers who need a content hash should
 * hash the raw prompt, not `parsedAt`).
 *
 * The caller (worker job handler or REST route) persists the parsed structure
 * as a `source_text` artifact. This module performs no persistence.
 */
export function parseTextPrompt(options: ParsePromptOptions): ParsedPrompt {
  const raw = options.prompt;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new TextPromptError(
      "Text prompt is required and must be a non-empty string.",
      "empty-prompt",
    );
  }
  if (raw.length > MAX_PROMPT_LENGTH) {
    throw new TextPromptError(
      `Text prompt exceeds the maximum length of ${MAX_PROMPT_LENGTH} characters (was ${raw.length}).`,
      "too-long",
    );
  }

  const prompt = raw.trim();
  const clauses = splitClauses(prompt);
  const index = options.elementIndex;

  const subTasks: SubTask[] = clauses.map((clause, i) => {
    const verb = detectVerb(clause);
    const candidates = candidateRefsForClause(clause, index);
    return {
      ordinal: i + 1,
      verb,
      description: clause,
      // A sub-task is grounded only when we found at least one candidate ref
      // AND the clause described an actionable verb. A "review" clause with a
      // candidate is still a candidate for grounding, so we don't over-filter.
      needsGrounding: candidates.length === 0,
      candidateRefs: candidates,
    };
  });

  const entities = extractEntities(prompt);
  const goal = deriveGoal(prompt, clauses[0] ?? "");
  const grounded = index !== undefined && subTasks.some((s) => s.candidateRefs.length > 0);

  return {
    prompt,
    goal,
    entities,
    subTasks,
    grounded,
    parsedAt: new Date().toISOString(),
    characterCount: prompt.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read back a persisted `ParsedPrompt`. Throws a `TextPromptError` with
 * `code: "internal"` when the stored payload is malformed, so callers can fail
 * the job rather than proceed with a partial plan.
 */
export function rehydrateParsedPrompt(value: unknown): ParsedPrompt {
  if (value === null || typeof value !== "object") {
    throw new TextPromptError(
      "Rehydrate failed: payload is not an object.",
      "internal",
    );
  }
  const r = value as Record<string, unknown>;
  const prompt = typeof r["prompt"] === "string" ? (r["prompt"] as string) : null;
  const goal = typeof r["goal"] === "string" ? (r["goal"] as string) : null;
  if (prompt === null || goal === null) {
    throw new TextPromptError(
      "Rehydrate failed: stored prompt is missing `prompt` or `goal`.",
      "internal",
    );
  }

  const entities: ExtractedEntity[] = [];
  if (Array.isArray(r["entities"])) {
    for (const e of r["entities"] as unknown[]) {
      if (e === null || typeof e !== "object") continue;
      const er = e as Record<string, unknown>;
      const literal = typeof er["literal"] === "string" ? (er["literal"] as string) : null;
      const kind = typeof er["kind"] === "string" ? (er["kind"] as string) : null;
      const offset = typeof er["offset"] === "number" ? (er["offset"] as number) : 0;
      if (literal === null || kind === null) continue;
      // Kind is validated to the closed union; unknown kinds fall back to
      // `unclassified` rather than being dropped.
      const safeKind: EntityKind =
        kind === "email" ||
        kind === "url" ||
        kind === "phone" ||
        kind === "iso_date" ||
        kind === "number" ||
        kind === "quoted_string"
          ? (kind as EntityKind)
          : "unclassified";
      entities.push({ literal, kind: safeKind, offset });
    }
  }

  const subTasks: SubTask[] = [];
  if (Array.isArray(r["subTasks"])) {
    for (const s of r["subTasks"] as unknown[]) {
      if (s === null || typeof s !== "object") continue;
      const sr = s as Record<string, unknown>;
      const ordinal = typeof sr["ordinal"] === "number" ? (sr["ordinal"] as number) : 0;
      const verb = typeof sr["verb"] === "string" ? (sr["verb"] as string) : "unknown";
      const description = typeof sr["description"] === "string" ? (sr["description"] as string) : "";
      const needsGrounding = sr["needsGrounding"] === true;
      const candidateRefs: string[] = [];
      if (Array.isArray(sr["candidateRefs"])) {
        for (const c of sr["candidateRefs"] as unknown[]) {
          if (typeof c === "string") candidateRefs.push(c);
        }
      }
      if (ordinal <= 0 || description.length === 0) continue;
      const safeVerb: SubTaskVerb =
        verb in VERB_ALIASES || verb === "unknown"
          ? (verb as SubTaskVerb)
          : "unknown";
      subTasks.push({
        ordinal,
        verb: safeVerb,
        description,
        needsGrounding,
        candidateRefs,
      });
    }
  }

  const grounded = r["grounded"] === true;
  const parsedAt = typeof r["parsedAt"] === "string" ? (r["parsedAt"] as string) : "";
  const characterCount =
    typeof r["characterCount"] === "number" ? (r["characterCount"] as number) : prompt.length;

  return {
    prompt,
    goal,
    entities,
    subTasks,
    grounded,
    parsedAt,
    characterCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence payload shape                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `ParsedPrompt` that is persisted as a `source_text` artifact.
 * `parsedAt` is included as metadata (not part of the semantic payload) so the
 * UI can display "parsed N minutes ago" without a join.
 */
export interface TextPromptArtifactPayload {
  readonly prompt: string;
  readonly goal: string;
  readonly entities: readonly ExtractedEntity[];
  readonly subTasks: readonly SubTask[];
  readonly grounded: boolean;
  readonly parsedAt: string;
  readonly characterCount: number;
  /**
   * Which URL-ingest artifact this prompt was planned against, when the
   * caller combined a URL plus a text prompt. Null when the prompt was
   * ingested standalone.
   */
  readonly groundedAgainstArtifactId: string | null;
}

export function toArtifactPayload(
  parsed: ParsedPrompt,
  groundedAgainstArtifactId: string | null,
): TextPromptArtifactPayload {
  return {
    prompt: parsed.prompt,
    goal: parsed.goal,
    entities: parsed.entities,
    subTasks: parsed.subTasks,
    grounded: parsed.grounded,
    parsedAt: parsed.parsedAt,
    characterCount: parsed.characterCount,
    groundedAgainstArtifactId,
  };
}
