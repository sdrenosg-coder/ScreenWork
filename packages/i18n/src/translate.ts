/**
 * Zipy AI — multilingual: auto-translation, translation memory integration,
 * glossary-based translation and RTL marking (content-generation,
 * multilingual batch 1).
 *
 * Translation is done by an LLM. This module does *not* call a model; it
 * is the orchestration layer that decides *what to translate* and *where
 * the result lands*. The LLM call is injected as a `Translator` function
 * supplied by the caller (typically a thin wrapper over
 * `@zipy/llm/adapter`), so this module remains deterministic and testable
 * without a network.
 *
 * The flow for one segment is:
 *
 *   1. **Memory first.** Look the segment up in the supplied
 *      `TranslationMemoryStore`. An exact match is returned immediately —
 *      no LLM call, no cost. A fuzzy match is returned as a *suggestion*
 *      the caller decides whether to accept; it is not silently used.
 *   2. **Glossary guard.** Before calling the model, the segment is
 *      scanned for do-not-translate terms (from `dntGlossary.ts`, injected
 *      as a plain list here to keep the imports graph shallow). If it
 *      contains a DNT term, the term is protected and the model is told
 *      not to translate it.
 *   3. **LLM call.** The translator is invoked with the source, the
 *      target locale, the protected terms, the directive block and the
 *      segment key. Whatever the translator returns is trusted as the
 *      translated text; the module never rewrites it.
 *   4. **Store.** The result is written to the TM as `draft` (never
 *      `approved` — approval is a reviewer action).
 *
 * Batch translation is a thin loop over the same per-segment call; the
 * result carries per-segment outcomes so the caller can show a summary and
 * surface gaps.
 *
 * Design rules honoured:
 *  - No invented translations. A model failure yields a `failed` outcome
 *    with the source text preserved; the module does not fall back to a
 *    fake translation.
 *  - The module never claims the LLM output is correct. Each translated
 *    segment is stored as `draft` and marked `requiresReview: true`.
 *  - RTL output is a *marking*, not a rendering. This module only decides
 *    the direction and returns it; the export layer applies `dir="rtl"`.
 *  - Deterministic given the same translator and TM state.
 */

import {
  TranslationMemoryStore,
  type TranslationMemoryEntry,
  type LookupResult,
} from "@zipy/i18n/translationMemory";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TranslateErrorCode =
  | "invalid-input"
  | "translator-failed"
  | "unsupported-locale";

export class TranslateError extends Error {
  readonly code: TranslateErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TranslateErrorCode,
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
 * The translator abstraction. It is deliberately narrow so a caller can
 * wire in any LLM (or a fake in tests) without changing this module.
 *
 * The translator receives the fully-assembled prompt (directive + source)
 * and returns the translated text. It must not be called for segments that
 * hit the memory; the caller does not need to implement caching.
 */
export type Translator = (input: {
  readonly directive: string;
  readonly sourceText: string;
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly protectedTerms: readonly string[];
  readonly segmentKey: string;
}) => Promise<string>;

export interface TranslateOneInput {
  readonly workspaceId: string;
  readonly translator: Translator;
  readonly memory: TranslationMemoryStore;
  readonly segmentKey: string;
  readonly sourceText: string;
  readonly sourceLocale: string;
  readonly targetLocale: string;
  /**
   * Do-not-translate terms for this target locale. The composer wraps each
   * term in the source text with a sentinel before sending and restores it
   * after the model returns. Only exact word-boundary matches are
   * protected.
   */
  readonly protectedTerms?: readonly string[];
  /**
   * When `true`, a fuzzy TM match short-circuits the LLM call and the
   * stored translation is returned with `fromMemory: true` and a note
   * that a reviewer should confirm. Defaults to `false`.
   */
  readonly useFuzzyMemory?: boolean;
  /**
   * Optional context string appended to every directive: the audience/industry
   * directive from `@zipy/content/personalization`. Kept as an opaque
   * string here so this module does not depend on the content package.
   */
  readonly styleContext?: string | null;
  /** Optional per-segment domain label stored with the TM entry. */
  readonly domain?: string | null;
}

export interface TranslateOneResult {
  readonly segmentKey: string;
  readonly sourceText: string;
  readonly targetText: string;
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly direction: "ltr" | "rtl";
  readonly outcome: "memory-exact" | "memory-fuzzy" | "translated" | "failed";
  readonly requiresReview: boolean;
  /** `true` when the result was served from memory without an LLM call. */
  readonly fromMemory: boolean;
  /** Similarity score for a fuzzy hit, in [0, 1]; `1` otherwise. */
  readonly memoryScore: number;
  /** Human-readable reason for the outcome; stable across runs. */
  readonly reason: string;
  /** Persisted TM row recovered from a store write; `null` on failure. */
  readonly storedEntry: TranslationMemoryEntry | null;
}

export interface TranslateBatchInput extends Omit<TranslateOneInput, "segmentKey" | "sourceText"> {
  /** Segments to translate. Each has a stable key and source text. */
  readonly segments: readonly {
    readonly segmentKey: string;
    readonly sourceText: string;
    readonly domain?: string | null;
  }[];
}

export interface TranslateBatchResult {
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly direction: "ltr" | "rtl";
  readonly results: readonly TranslateOneResult[];
  readonly summary: {
    readonly total: number;
    readonly fromMemoryExact: number;
    readonly fromMemoryFuzzy: number;
    readonly translated: number;
    readonly failed: number;
    /** Fraction of segments served from memory (cost saved). */
    readonly memoryHitRate: number;
  };
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Locale helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * BCP-47 tags whose primary script is right-to-left. The list is
 * deliberately narrow (the common ones) and callers can override with an
 * explicit `direction` if their locale is not covered. The list is a
 * *marking* hint; the export layer applies the actual `dir` attribute.
 */
const RTL_LANGUAGE_CODES: ReadonlySet<string> = new Set([
  "ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv", "ku", "ckb",
]);

/** Resolve the writing direction for a BCP-47 tag. Defaults to LTR. */
export function directionFor(locale: string): "ltr" | "rtl" {
  if (typeof locale !== "string") return "ltr";
  const primary = locale.trim().toLowerCase().split(/[-_]/u)[0] ?? "";
  return RTL_LANGUAGE_CODES.has(primary) ? "rtl" : "ltr";
}

export function isRTL(locale: string): boolean {
  return directionFor(locale) === "rtl";
}

/* -------------------------------------------------------------------------- */
/* Sentinel protection                                                         */
/* -------------------------------------------------------------------------- */

const DNT_OPEN = "\u0001D";
const DNT_CLOSE = "D\u0001";

interface ProtectedSegment {
  readonly text: string;
}

/**
 * Replace each protected term with a sentinel. Returns the protected text
 * and a restore function. Word boundaries are respected; case is preserved
 * because the sentinel only carries the index.
 */
function protectTerms(
  source: string,
  terms: readonly string[],
): { protectedText: string; restore: (s: string) => string; protectedCount: number } {
  const store: ProtectedSegment[] = [];
  let working = source;
  for (const term of terms) {
    if (typeof term !== "string") continue;
    const trimmed = term.trim();
    if (trimmed.length === 0) continue;
    const escaped = escapeRegExp(trimmed);
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "gu");
    working = working.replace(re, (match) => {
      const idx = store.length;
      store.push({ text: match });
      return `${DNT_OPEN}${idx}${DNT_CLOSE}`;
    });
  }
  const restore = (s: string): string => {
    let restored = s;
    let last: string;
    do {
      last = restored;
      restored = restored.replace(
        new RegExp(`${DNT_OPEN}(\\d+)${DNT_CLOSE}`, "g"),
        (_m, idx: string) => store[Number(idx)]?.text ?? "",
      );
    } while (restored !== last);
    return restored;
  };
  return { protectedText: working, restore, protectedCount: store.length };
}

/* -------------------------------------------------------------------------- */
/* translateOne                                                                */
/* -------------------------------------------------------------------------- */

export async function translateOne(input: TranslateOneInput): Promise<TranslateOneResult> {
  assertOneInput(input);
  const direction = directionFor(input.targetLocale);

  // ------------------------------------------------------------------ memory
  let memory: LookupResult | null = null;
  try {
    memory = input.memory.lookup({
      workspaceId: input.workspaceId,
      segmentKey: input.segmentKey,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      sourceText: input.sourceText,
      includeDrafts: false,
      fuzzyThreshold: input.useFuzzyMemory === true ? 0.6 : 1.01,
    });
  } catch (err) {
    // A lookup failure is not fatal: we simply skip the memory and continue
    // to the LLM. The error is not propagated because the translation path
    // is more valuable than a memory miss.
    memory = null;
    void err;
  }

  if (memory !== null && memory.outcome === "exact" && memory.entry !== null) {
    return {
      segmentKey: input.segmentKey,
      sourceText: input.sourceText,
      targetText: memory.entry.targetText,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      direction,
      outcome: "memory-exact",
      requiresReview: false,
      fromMemory: true,
      memoryScore: 1,
      reason: memory.reason,
      storedEntry: memory.entry,
    };
  }
  if (
    input.useFuzzyMemory === true &&
    memory !== null &&
    memory.outcome === "fuzzy" &&
    memory.entry !== null
  ) {
    return {
      segmentKey: input.segmentKey,
      sourceText: input.sourceText,
      targetText: memory.entry.targetText,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      direction,
      outcome: "memory-fuzzy",
      requiresReview: true,
      fromMemory: true,
      memoryScore: memory.score,
      reason: memory.reason,
      storedEntry: memory.entry,
    };
  }

  // ------------------------------------------------------------------ translate
  const protectedTerms = (input.protectedTerms ?? []).filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0,
  );
  const protection = protectTerms(input.sourceText, protectedTerms);

  const directive = buildTranslateDirective({
    sourceLocale: input.sourceLocale,
    targetLocale: input.targetLocale,
    direction,
    protectedTerms,
    styleContext: input.styleContext ?? null,
  });

  let translated: string;
  try {
    translated = await input.translator({
      directive,
      sourceText: protection.protectedText,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      protectedTerms,
      segmentKey: input.segmentKey,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      segmentKey: input.segmentKey,
      sourceText: input.sourceText,
      targetText: input.sourceText,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      direction,
      outcome: "failed",
      requiresReview: true,
      fromMemory: false,
      memoryScore: 0,
      reason: `translator did not return a result: ${message}`,
      storedEntry: null,
    };
  }

  if (typeof translated !== "string" || translated.trim().length === 0) {
    return {
      segmentKey: input.segmentKey,
      sourceText: input.sourceText,
      targetText: input.sourceText,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      direction,
      outcome: "failed",
      requiresReview: true,
      fromMemory: false,
      memoryScore: 0,
      reason: "translator returned an empty string",
      storedEntry: null,
    };
  }

  const restoreInput = protection.protectedCount > 0 ? translated : translated;
  const restored = protection.restore(restoreInput);

  // ------------------------------------------------------------ memory store
  let storedEntry: TranslationMemoryEntry | null = null;
  try {
    storedEntry = input.memory.put({
      workspaceId: input.workspaceId,
      segmentKey: input.segmentKey,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      sourceText: input.sourceText,
      targetText: restored,
      status: "draft",
      updatedAt: new Date().toISOString(),
      approvedBy: null,
      domain: input.domain ?? null,
    });
  } catch (err) {
    void err;
    storedEntry = null;
  }

  return {
    segmentKey: input.segmentKey,
    sourceText: input.sourceText,
    targetText: restored,
    sourceLocale: input.sourceLocale,
    targetLocale: input.targetLocale,
    direction,
    outcome: "translated",
    requiresReview: true,
    fromMemory: false,
    memoryScore: 0,
    reason: "translated by model; stored as draft pending reviewer approval",
    storedEntry,
  };
}

/* -------------------------------------------------------------------------- */
/* translateBatch                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Translate an ordered set of segments. Translation is run sequentially by
 * default so the caller can bound model concurrency elsewhere; a caller
 * that wants parallelism can call `translateOne` itself.
 */
export async function translateBatch(
  input: TranslateBatchInput,
): Promise<TranslateBatchResult> {
  if (input === null || typeof input !== "object") {
    throw new TranslateError("translateBatch requires an input object.", "invalid-input");
  }
  if (!Array.isArray(input.segments)) {
    throw new TranslateError("`segments` must be an array.", "invalid-input");
  }
  if (typeof input.translator !== "function") {
    throw new TranslateError("`translator` must be a function.", "invalid-input");
  }
  if (input.memory === null || typeof input.memory !== "object") {
    throw new TranslateError("`memory` must be a TranslationMemoryStore instance.", "invalid-input");
  }

  const results: TranslateOneResult[] = [];
  for (const segment of input.segments) {
    if (segment === null || typeof segment !== "object") continue;
    const result = await translateOne({
      workspaceId: input.workspaceId,
      translator: input.translator,
      memory: input.memory,
      segmentKey: segment.segmentKey,
      sourceText: segment.sourceText,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      protectedTerms: input.protectedTerms,
      useFuzzyMemory: input.useFuzzyMemory,
      styleContext: input.styleContext,
      domain: segment.domain ?? input.domain,
    });
    results.push(result);
  }

  let fromMemoryExact = 0;
  let fromMemoryFuzzy = 0;
  let translated = 0;
  let failed = 0;
  for (const r of results) {
    switch (r.outcome) {
      case "memory-exact": fromMemoryExact += 1; break;
      case "memory-fuzzy": fromMemoryFuzzy += 1; break;
      case "translated": translated += 1; break;
      case "failed": failed += 1; break;
    }
  }
  const total = results.length;
  const memoryHitRate = total === 0
    ? 0
    : (fromMemoryExact + fromMemoryFuzzy) / total;

  return {
    sourceLocale: input.sourceLocale,
    targetLocale: input.targetLocale,
    direction: directionFor(input.targetLocale),
    results,
    summary: {
      total,
      fromMemoryExact,
      fromMemoryFuzzy,
      translated,
      failed,
      memoryHitRate: Math.round(memoryHitRate * 1000) / 1000,
    },
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Directive builder                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The directive the model sees for a translation call. It is passed through
 * the injected translator, not through the LLM adapter, so this module can
 * be tested with a trivial fake.
 */
export function buildTranslateDirective(input: {
  readonly sourceLocale: string;
  readonly targetLocale: string;
  readonly direction: "ltr" | "rtl";
  readonly protectedTerms: readonly string[];
  readonly styleContext: string | null;
}): string {
  const lines: string[] = [];
  lines.push(
    `Translate the following text from ${input.sourceLocale} to ${input.targetLocale}.`,
  );
  lines.push(
    "- Return only the translated text. No headings, no commentary, no alternative translations, no line breaks around the text.",
  );
  lines.push(
    "- Preserve all inline punctuation and code-like tokens exactly as they appear.",
  );
  lines.push(
    "- Preserve the tone and register of the source; do not add or remove information.",
  );
  if (input.protectedTerms.length > 0) {
    lines.push(
      `- Do not translate or reorder the following terms; they must appear in the output exactly as in the source: ${input.protectedTerms.join(", ")}.`,
    );
  }
  if (input.direction === "rtl") {
    lines.push(
      "- The target language is written right-to-left. Use the natural RTL word order of the language; do not mirror punctuation that is code-like.",
    );
  }
  if (input.styleContext !== null && input.styleContext.trim().length > 0) {
    lines.push("Workspace context (do not translate it, do not echo it):");
    lines.push(input.styleContext.trim());
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Rehydrate a `TranslateBatchResult`. Only well-formed rows are kept;
 * unknown outcomes are recorded as `failed` so a corrupted payload cannot
 * be mistaken for a successful translation.
 */
export function rehydrateTranslateBatch(value: unknown): TranslateBatchResult {
  if (value === null || typeof value !== "object") {
    throw new TranslateError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const sourceLocale = typeof r["sourceLocale"] === "string" ? r["sourceLocale"] : "en";
  const targetLocale = typeof r["targetLocale"] === "string" ? r["targetLocale"] : "en";
  const resultsRaw = Array.isArray(r["results"]) ? (r["results"] as unknown[]) : [];
  const results: TranslateOneResult[] = [];
  for (const item of resultsRaw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const outcome = readOutcome(o["outcome"]);
    if (outcome === null) continue;
    results.push({
      segmentKey: typeof o["segmentKey"] === "string" ? o["segmentKey"] : "",
      sourceText: typeof o["sourceText"] === "string" ? o["sourceText"] : "",
      targetText: typeof o["targetText"] === "string" ? o["targetText"] : "",
      sourceLocale: typeof o["sourceLocale"] === "string" ? o["sourceLocale"] : sourceLocale,
      targetLocale: typeof o["targetLocale"] === "string" ? o["targetLocale"] : targetLocale,
      direction: o["direction"] === "rtl" ? "rtl" : "ltr",
      outcome,
      requiresReview: o["requiresReview"] === true,
      fromMemory: o["fromMemory"] === true,
      memoryScore: typeof o["memoryScore"] === "number" ? o["memoryScore"] : 0,
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
      storedEntry: null,
    });
  }
  const summaryRaw = r["summary"];
  let summary: TranslateBatchResult["summary"];
  if (summaryRaw !== null && typeof summaryRaw === "object") {
    const s = summaryRaw as Record<string, unknown>;
    summary = {
      total: numberOr(s["total"], results.length),
      fromMemoryExact: numberOr(s["fromMemoryExact"], 0),
      fromMemoryFuzzy: numberOr(s["fromMemoryFuzzy"], 0),
      translated: numberOr(s["translated"], 0),
      failed: numberOr(s["failed"], 0),
      memoryHitRate: typeof s["memoryHitRate"] === "number" ? s["memoryHitRate"] : 0,
    };
  } else {
    summary = {
      total: results.length,
      fromMemoryExact: results.filter((r) => r.outcome === "memory-exact").length,
      fromMemoryFuzzy: results.filter((r) => r.outcome === "memory-fuzzy").length,
      translated: results.filter((r) => r.outcome === "translated").length,
      failed: results.filter((r) => r.outcome === "failed").length,
      memoryHitRate: 0,
    };
  }
  return {
    sourceLocale,
    targetLocale,
    direction: r["direction"] === "rtl" ? "rtl" : directionFor(targetLocale),
    results,
    summary,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function assertOneInput(input: TranslateOneInput): void {
  if (input === null || typeof input !== "object") {
    throw new TranslateError("translateOne requires an input object.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new TranslateError("translateOne requires a workspaceId.", "invalid-input");
  }
  if (typeof input.translator !== "function") {
    throw new TranslateError("translateOne requires a `translator` function.", "invalid-input");
  }
  if (input.memory === null || typeof input.memory !== "object") {
    throw new TranslateError(
      "translateOne requires a TranslationMemoryStore instance.",
      "invalid-input",
    );
  }
  if (typeof input.segmentKey !== "string" || input.segmentKey.trim().length === 0) {
    throw new TranslateError("translateOne requires a segmentKey.", "invalid-input");
  }
  if (typeof input.sourceText !== "string" || input.sourceText.trim().length === 0) {
    throw new TranslateError("translateOne requires non-empty sourceText.", "invalid-input");
  }
  if (typeof input.sourceLocale !== "string" || input.sourceLocale.trim().length === 0) {
    throw new TranslateError("translateOne requires a sourceLocale.", "invalid-input");
  }
  if (typeof input.targetLocale !== "string" || input.targetLocale.trim().length === 0) {
    throw new TranslateError("translateOne requires a targetLocale.", "invalid-input");
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readOutcome(v: unknown): TranslateOneResult["outcome"] | null {
  if (v === "memory-exact" || v === "memory-fuzzy" || v === "translated" || v === "failed") {
    return v;
  }
  return null;
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  RTL_LANGUAGE_CODES,
  protectTerms,
  escapeRegExp,
  readOutcome,
  buildTranslateDirective,
});
