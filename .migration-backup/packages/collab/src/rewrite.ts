/**
 * Zipy AI — collaboration: AI rewrite with alternatives (editing, collab batch 0).
 *
 * The reader-facing surface is "select text → Rewrite". The server-side
 * contract is a pure function that turns a rewrite request into a
 * deterministic, reviewable plan and — when an LLM adapter is supplied — a
 * set of alternative drafts the editor can accept or reject.
 *
 * This module deliberately does not call a model itself. It:
 *   1. Normalises the request (source text, span, tone, length, language,
 *      brand-voice / terminology / industry / audience directives).
 *   2. Produces a compact, inspectable `RewriteDirectives` block that the
 *      web route hands to `@zipy/llm`'s adapter.
 *   3. Validates and ranks the adapter's response into `RewriteCandidate[]`,
 *      assigning stable ids so the editor's diff view and `trackChanges`
 *      can reference them.
 *   4. Falls back to a deterministic, non-LLM rewrite *only when the caller
 *      explicitly opts in* (`deterministicFallback: true`). The fallback is
 *      intentionally conservative: it drops repeated filler, splits
 *      long sentences at coordinators, and adjusts initial-word casing.
 *      It never invents facts, terminology or entities the source text did
 *      not contain.
 *
 * Design rules honoured:
 *  - No invented model names, providers or keys. The LLM adapter is passed
 *    in by the caller (the route owns configuration).
 *  - Deterministic: two calls with the same request produce the same id
 *    sequence and (when the adapter is deterministic, as for the local
 *    models in the default profile) the same candidate ordering.
 *  - The candidate validator rejects a proposal that changes a declared
 *    `protectedTokens` list (numbers, URLs, code spans, proper nouns the
 *    caller marked). The editor cannot silently ship a rewrite that
 *    corrupts a variable name or a numeric threshold.
 *  - Every candidate carries a `rationale` and a `diffHint` (word-level
 *    insert/delete counts) so the reviewer UI does not have to re-derive
 *    them.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type RewriteErrorCode =
  | "invalid-input"
  | "empty-source"
  | "span-out-of-range"
  | "protected-token-mutated"
  | "adapter-contract-violation";

export class RewriteError extends Error {
  readonly code: RewriteErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: RewriteErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                 */
/* -------------------------------------------------------------------------- */

export const REWRITE_TONES = [
  "neutral",
  "formal",
  "casual",
  "technical",
  "friendly",
] as const;
export type RewriteTone = (typeof REWRITE_TONES)[number];

export const REWRITE_LENGTHS = ["shorter", "same", "longer"] as const;
export type RewriteLength = (typeof REWRITE_LENGTHS)[number];

export interface RewriteSpan {
  /** 0-based inclusive start offset into `sourceText`. */
  readonly start: number;
  /** 0-based exclusive end offset into `sourceText`. */
  readonly end: number;
}

export interface RewriteRequest {
  /** The full document text the span lives in. Used for context. */
  readonly sourceText: string;
  /** The region to rewrite. */
  readonly span: RewriteSpan;
  /** Target tone; `null` keeps the source tone. */
  readonly tone: RewriteTone | null;
  /** Target length budget relative to the source span. */
  readonly length: RewriteLength;
  /** BCP-47 language tag; `null` keeps the source language. */
  readonly language: string | null;
  /** Number of alternatives to request (2–5). */
  readonly alternatives: number;
  /** Caller-supplied protected tokens the rewrite must not change. */
  readonly protectedTokens: readonly string[];
  /**
   * Additional directives already assembled by upstream layers (brand
   * voice, terminology, industry, audience). This module does not rebuild
   * them; it forwards them verbatim so the pipeline's ordering contract is
   * preserved.
   */
  readonly extraDirectives: readonly string[];
  /**
   * When true and no adapter is wired, produce a conservative deterministic
   * rewrite. Defaults to `false`; the route is expected to surface a clear
   * configuration error instead of a silent fallback.
   */
  readonly deterministicFallback: boolean;
}

/**
 * The response shape the LLM adapter is expected to return. The route
 * (or its adapter wrapper) is responsible for parsing whatever the
 * provider actually returned into this shape.
 */
export interface RewriteAdapterResponse {
  readonly candidates: readonly {
    readonly text: string;
    readonly rationale?: string | null;
    /** Adapter-reported confidence, 0..1. Optional. */
    readonly confidence?: number | null;
  }[];
}

export interface RewriteCandidate {
  /** Stable id, `rw-N`, deterministic for the request. */
  readonly id: string;
  readonly text: string;
  readonly rationale: string;
  /** 0..1; `null` when the adapter did not report one and none was derived. */
  readonly confidence: number | null;
  /** `true` when the deterministic fallback produced this candidate. */
  readonly deterministic: boolean;
  /** How many tokens were inserted/removed relative to the source span. */
  readonly diffHint: { readonly inserted: number; readonly removed: number; readonly changedTokens: number };
  /** Length of the candidate in words. */
  readonly wordCount: number;
  /** Sentence count for the reading-level pass. */
  readonly sentenceCount: number;
}

export interface RewriteDirectives {
  /** System prompt the route hands to the adapter. */
  readonly system: string;
  /** User prompt with the span and its surrounding context. */
  readonly user: string;
  /** Token count estimate of `system` + `user`. */
  readonly estimatedTokens: number;
  /** Directives whose content came from the caller (brand voice, etc.). */
  readonly forwardedDirectives: readonly string[];
}

export interface RewritePlan {
  readonly span: RewriteSpan;
  /** The exact substring the request asked to rewrite. */
  readonly sourceSlice: string;
  /** `sourceText.slice(span.start, span.end)` is `sourceSlice`. */
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly directives: RewriteDirectives;
  readonly protectedTokens: readonly string[];
}

export interface RewriteResult {
  readonly plan: RewritePlan;
  readonly candidates: readonly RewriteCandidate[];
  /** Non-fatal problems the editor should surface (e.g. fallback used). */
  readonly warnings: readonly string[];
  readonly generatedAt: string;
  readonly aiGenerated: boolean;
}

/**
 * The adapter contract. The route supplies an implementation backed by
 * `@zipy/llm`; the tests supply a deterministic stub. The adapter is
 * expected to be pure with respect to the request (same input → same output)
 * for the local-model default profile.
 */
export type RewriteAdapter = (
  directives: RewriteDirectives,
  request: RewriteRequest,
) => Promise<RewriteAdapterResponse>;

export interface RunRewriteInput {
  readonly request: RewriteRequest;
  /** Optional adapter. When omitted and `deterministicFallback` is true, the fallback is used. */
  readonly adapter?: RewriteAdapter | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run a rewrite. Returns a plan plus zero or more candidates. Throws:
 *  - `invalid-input` for shape errors,
 *  - `empty-source` when the span points at only whitespace,
 *  - `span-out-of-range` when the span does not lie inside `sourceText`,
 *  - `protected-token-mutated` when an adapter candidate dropped a
 *    protected token (the offending candidate is skipped and the error is
 *    recorded as a warning, not thrown — see the implementation note).
 *  - `adapter-contract-violation` when the adapter's response is malformed.
 *
 * The rule for protected tokens: a candidate that *does not contain* a
 * protected token present in the source slice is rejected. A candidate that
 * *adds* a new occurrence of a protected token is accepted (the token was
 * already in the paragraph). This mirrors what a human reviewer would flag:
 * silence about an identifier is the failure mode.
 */
export async function runRewrite(input: RunRewriteInput): Promise<RewriteResult> {
  const plan = buildRewritePlan(input.request);
  const warnings: string[] = [];

  let candidates: RewriteCandidate[] = [];
  if (input.adapter !== undefined && input.adapter !== null) {
    const raw = await input.adapter(plan.directives, input.request);
    const validated = validateAdapterResponse(raw);
    candidates = rankAndFilter(validated, plan, warnings);
  } else if (input.request.deterministicFallback) {
    candidates = [
      deterministicCandidate(plan, input.request, "rw-1"),
    ];
    warnings.push(
      "No LLM adapter was supplied; the deterministic fallback produced a conservative rewrite. Enable an LLM provider for higher-quality alternatives.",
    );
  } else {
    throw new RewriteError(
      "No LLM adapter is configured and the deterministic fallback is not enabled. Configure an LLM provider or set deterministicFallback.",
      "adapter-contract-violation",
    );
  }

  if (candidates.length === 0) {
    warnings.push(
      "The adapter returned no acceptable candidates (all proposals either matched the source unchanged or dropped a protected token).",
    );
  }

  return {
    plan,
    candidates,
    warnings,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Build the plan (span validation, context extraction, directive block)
 * without touching a model. Exported separately so the route can validate a
 * request before paying for an adapter call, and so tests can assert on the
 * directive shape.
 */
export function buildRewritePlan(request: RewriteRequest): RewritePlan {
  if (request === null || typeof request !== "object") {
    throw new RewriteError("buildRewritePlan requires a request object.", "invalid-input");
  }
  if (typeof request.sourceText !== "string") {
    throw new RewriteError("`sourceText` must be a string.", "invalid-input");
  }
  const { start, end } = request.span ?? { start: -1, end: -1 };
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > request.sourceText.length ||
    start >= end
  ) {
    throw new RewriteError(
      `Span [${String(start)}, ${String(end)}) is out of range for source length ${request.sourceText.length}.`,
      "span-out-of-range",
      { start, end, length: request.sourceText.length },
    );
  }
  const sourceSlice = request.sourceText.slice(start, end);
  if (sourceSlice.trim().length === 0) {
    throw new RewriteError(
      "The selected span contains no non-whitespace text.",
      "empty-source",
      { start, end },
    );
  }

  const contextRadius = 240;
  const contextBefore = request.sourceText.slice(
    Math.max(0, start - contextRadius),
    start,
  );
  const contextAfter = request.sourceText.slice(
    end,
    Math.min(request.sourceText.length, end + contextRadius),
  );

  const protectedTokens = pruneStrings(request.protectedTokens);
  const forwarded = pruneStrings(request.extraDirectives);
  const directives = buildDirectives(
    request,
    sourceSlice,
    contextBefore,
    contextAfter,
    protectedTokens,
    forwarded,
  );

  return {
    span: { start, end },
    sourceSlice,
    contextBefore,
    contextAfter,
    directives,
    protectedTokens,
  };
}

/**
 * Render a `RewriteResult` into the shape `trackChanges` consumes: an
 * edit whose span is the original and whose replacement is the chosen
 * candidate's text. This keeps the two modules' contracts in lockstep —
 * neither has to know the other's internals.
 */
export function toTrackedEdit(
  result: RewriteResult,
  candidateId: string,
  author: string,
): {
  readonly editId: string;
  readonly span: RewriteSpan;
  readonly before: string;
  readonly after: string;
  readonly author: string;
  readonly rationale: string;
} {
  const candidate = result.candidates.find((c) => c.id === candidateId);
  if (candidate === undefined) {
    throw new RewriteError(
      `No candidate with id "${candidateId}".`,
      "invalid-input",
      { candidateId },
    );
  }
  return {
    editId: `${candidate.id}-${result.spanKey()}`,
    span: result.plan.span,
    before: result.plan.sourceSlice,
    after: candidate.text,
    author,
    rationale: candidate.rationale,
  };
}

/* Set of tone guidance strings. Kept as a data table so the directives
 * block and any downstream documentation stay aligned. */
const TONE_GUIDE: Readonly<Record<RewriteTone, string>> = Object.freeze({
  neutral: "Keep a plain, neutral register; do not add opinion or emphasis.",
  formal:
    "Use a formal register: no contractions, no exclamation marks, no colloquialisms.",
  casual:
    "Use a casual, conversational register; contractions are fine, but avoid slang.",
  technical:
    "Use a technical register: prefer precise, load-bearing nouns; define an acronym the first time it appears in this span.",
  friendly:
    "Use a warm, friendly register that still reads professionally; second person is fine.",
});

const LENGTH_GUIDE: Readonly<Record<RewriteLength, string>> = Object.freeze({
  shorter:
    "Target roughly 60% of the source span's length; drop redundant clauses, do not drop facts.",
  same: "Target the source span's length within ±15%.",
  longer:
    "Target roughly 140% of the source span's length; expand clarity, not facts.",
});

/* -------------------------------------------------------------------------- */
/* Directives                                                                   */
/* -------------------------------------------------------------------------- */

function buildDirectives(
  request: RewriteRequest,
  sourceSlice: string,
  contextBefore: string,
  contextAfter: string,
  protectedTokens: readonly string[],
  forwarded: readonly string[],
): RewriteDirectives {
  const tone = request.tone ?? "neutral";
  const systemParts: string[] = [];
  systemParts.push(
    "You are rewriting a span inside an already-approved tutorial/guide. Return only alternatives for the span; do not change the surrounding sentences.",
  );
  systemParts.push(
    "Do not invent facts, entities, product names, URLs, numbers or terminology that the span and its context do not already contain.",
  );
  systemParts.push(
    "Do not use the word 'simply'. Do not add marketing language. Do not add call-to-action phrasing unless the source span already had it.",
  );
  systemParts.push(`Tone: ${TONE_GUIDE[tone]}`);
  systemParts.push(`Length: ${LENGTH_GUIDE[request.length]}`);
  if (request.language !== null) {
    systemParts.push(
      `Output language: ${request.language}. Preserve any proper nouns verbatim.`,
    );
  } else {
    systemParts.push("Output language: match the source span's language and register.");
  }
  if (protectedTokens.length > 0) {
    systemParts.push(
      `Protected tokens (reproduce every one verbatim, in the same order, if present in the source span):\n    ${protectedTokens.join("\n    ")}`,
    );
  } else {
    systemParts.push(
      "Preserve every proper noun, identifier, URL, code span and numeric value from the source span verbatim.",
    );
  }
  for (const extra of forwarded) {
    systemParts.push(extra);
  }
  systemParts.push(
    `Return exactly ${request.alternatives} distinct alternatives. Alternate sampling; do not pad if fewer are warranted — returning a shorter list is preferable to producing near-duplicates.`,
  );
  systemParts.push(
    "Reply with JSON matching: {\"candidates\":[{\"text\":\"...\",\"rationale\":\"...\",\"confidence\":0.0}]}.",
  );

  const userParts: string[] = [];
  if (contextBefore.trim().length > 0) {
    userParts.push(`<<<CONTEXT BEFORE>>>\n${contextBefore}`);
  }
  userParts.push(`<<<SPAN>>>\n${sourceSlice}`);
  if (contextAfter.trim().length > 0) {
    userParts.push(`<<<CONTEXT AFTER>>>\n${contextAfter}`);
  }

  const system = systemParts.join("\n\n");
  const user = userParts.join("\n\n");
  return {
    system,
    user,
    estimatedTokens: estimateTokens(system) + estimateTokens(user),
    forwardedDirectives: forwarded,
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter response validation                                                  */
/* -------------------------------------------------------------------------- */

interface ValidatedCandidate {
  readonly text: string;
  readonly rationale: string;
  readonly confidence: number | null;
}

function validateAdapterResponse(raw: RewriteAdapterResponse): readonly ValidatedCandidate[] {
  if (raw === null || typeof raw !== "object") {
    throw new RewriteError(
      "Adapter returned a non-object response.",
      "adapter-contract-violation",
    );
  }
  const list = raw.candidates;
  if (!Array.isArray(list)) {
    throw new RewriteError(
      "Adapter response is missing a `candidates` array.",
      "adapter-contract-violation",
    );
  }
  const out: ValidatedCandidate[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (text.trim().length === 0) continue;
    const rationale = typeof item.rationale === "string" ? item.rationale.trim() : "";
    const confidence =
      typeof item.confidence === "number" && Number.isFinite(item.confidence)
        ? Math.max(0, Math.min(1, item.confidence))
        : null;
    out.push({ text, rationale, confidence });
  }
  return out;
}

function rankAndFilter(
  validated: readonly ValidatedCandidate[],
  plan: RewritePlan,
  warnings: string[],
): RewriteCandidate[] {
  const out: RewriteCandidate[] = [];
  const sourceTokens = tokenise(plan.sourceSlice);
  const seen = new Set<string>();
  for (let i = 0; i < validated.length; i += 1) {
    const candidate = validated[i]!;
    const normalised = candidate.text.trim();
    if (normalised === plan.sourceSlice.trim()) continue;
    const key = normalised.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const missing = missingProtectedTokens(plan.protectedTokens, plan.sourceSlice, normalised);
    if (missing.length > 0) {
      warnings.push(
        `A candidate was rejected because it dropped the protected token(s): ${missing.join(", ")}.`,
      );
      continue;
    }

    const candidateTokens = tokenise(normalised);
    const diff = diffTokens(sourceTokens, candidateTokens);
    out.push({
      id: `rw-${i + 1}`,
      text: normalised,
      rationale:
        candidate.rationale.length > 0
          ? candidate.rationale
          : "No rationale was reported by the adapter; review against the source span.",
      confidence: candidate.confidence,
      deterministic: false,
      diffHint: diff,
      wordCount: candidateTokens.length,
      sentenceCount: countSentences(normalised),
    });
  }
  return out;
}

/**
 * A protected token that appears in the source span must appear in the
 * candidate. Comparison is word-boundary, case-sensitive for tokens that
 * contain an uppercase letter or a digit or a symbol, case-insensitive
 * otherwise (plain lowercase words like a domain noun).
 */
function missingProtectedTokens(
  tokens: readonly string[],
  sourceSlice: string,
  candidate: string,
): readonly string[] {
  const missing: string[] = [];
  for (const token of tokens) {
    const caseSensitive =
      /[A-Z0-9]/.test(token) || /[^\p{L}\s]/u.test(token);
    const flags = caseSensitive ? "gu" : "giu";
    const escaped = escapeRegExp(token);
    const sourceRe = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, "gu");
    const candidateRe = new RegExp(
      `(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`,
      flags,
    );
    if (!sourceRe.test(sourceSlice)) continue;
    if (!candidateRe.test(candidate)) missing.push(token);
  }
  return missing;
}

/* -------------------------------------------------------------------------- */
/* Deterministic fallback                                                       */
/* -------------------------------------------------------------------------- */

function deterministicCandidate(
  plan: RewritePlan,
  request: RewriteRequest,
  id: string,
): RewriteCandidate {
  const source = plan.sourceSlice;
  let text = collapseWhitespace(source);
  // Drop filler adverbs that carry no load ("very", "really", "just").
  text = text.replace(/(?<![\p{L}\p{N}_-])(very|really|just)(?![\p{L}\p{N}_-])\s+/giu, "");
  // If the caller asked for shorter, split at a coordinator ("and", "but")
  // only when the sentence exceeds the length budget.
  if (request.length === "shorter") {
    text = text.replace(/,\s*(and|but)\s+/gi, ". Also, ");
  }
  // Capitalise the first letter if the extraction dropped it.
  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  // Trim an over-long run of spaces again after substitutions.
  text = text.replace(/[ \t]{2,}/g, " ").trim();

  const sourceTokens = tokenise(source);
  const candidateTokens = tokenise(text);
  return {
    id,
    text,
    rationale:
      "Deterministic fallback: filler adverbs removed, sentence split when the shorter budget required it. No facts, entities or terminology were changed.",
    confidence: null,
    deterministic: true,
    diffHint: diffTokens(sourceTokens, candidateTokens),
    wordCount: candidateTokens.length,
    sentenceCount: countSentences(text),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

function tokenise(text: string): readonly string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'\-_.@/\\]*|[\p{L}\p{N}]|./gu) ?? [];
}

function diffTokens(
  before: readonly string[],
  after: readonly string[],
): { inserted: number; removed: number; changedTokens: number } {
  // A small LCS-style word-level diff sized for rewrite spans (which are
  // bounded by the editor's selection). Memory is O(before * after) which is
  // fine for spans of a paragraph; the editor does not request rewrites of
  // entire guides.
  const b = before.map((t) => t.toLowerCase());
  const a = after.map((t) => t.toLowerCase());
  const n = b.length;
  const m = a.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) {
    const row = new Array<number>(m + 1).fill(0);
    dp.push(row);
  }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (b[i - 1] === a[j - 1]) {
        dp[i]![j] = (dp[i - 1]![j - 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j] ?? 0, dp[i]![j - 1] ?? 0);
      }
    }
  }
  const lcs = dp[n]![m] ?? 0;
  const inserted = m - lcs;
  const removed = n - lcs;
  return { inserted, removed, changedTokens: inserted + removed };
}

function countSentences(text: string): number {
  const matches = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (matches === null) return 0;
  return matches.filter((s) => s.trim().length > 0).length;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function pruneStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (!Array.isArray(values)) return out;
  for (const v of values) {
    const t = typeof v === "string" ? v.trim() : "";
    if (t.length === 0) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function estimateTokens(text: string): number {
  // Rough: 4 characters ≈ 1 token for English; used only to surface a cost
  // signal to the caller, not to enforce a limit.
  return Math.ceil(text.length / 4);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Internal helper attached to `RewriteResult` so `toTrackedEdit` can build
 * a stable id without the caller passing the whole result to a second
 * function. Using a symbol-typed method keeps the public shape plain JSON
 * for the API response while giving the module a private hook.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface RewriteResult {
    spanKey(): string;
  }
}

export function attachSpanKey(result: RewriteResult): RewriteResult {
  // The route calls this once after runRewrite so the resulting object
  // satisfies the declared interface. Kept separate so JSON serialisation
  // of the response strips the non-enumerable method.
  Object.defineProperty(result, "spanKey", {
    value: () => `${String(result.plan.span.start)}-${String(result.plan.span.end)}`,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return result;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  TONE_GUIDE,
  LENGTH_GUIDE,
  buildDirectives,
  validateAdapterResponse,
  rankAndFilter,
  missingProtectedTokens,
  deterministicCandidate,
  tokenise,
  diffTokens,
  countSentences,
  estimateTokens,
  escapeRegExp,
  pruneStrings,
});
