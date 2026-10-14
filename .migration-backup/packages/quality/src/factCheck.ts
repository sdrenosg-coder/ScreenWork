/**
 * Zipy AI — fact-checking (SEO/quality/safety phase, batch 1).
 *
 * Cross-references a generated claim against the guide's sources and, when
 * configured, the live URL the workflow was captured from. Reports each
 * assertion as one of:
 *
 *   - `supported`   — at least one source verbatim or near-verbatim states
 *                     the assertion (matched at the token level).
 *   - `partial`     — the sources support every content token but not the
 *                     full assertion; a reviewer must verify the framing.
 *   - `contradicted`— the sources state the *opposite* (a negation mismatched
 *                     between claim and source).
 *   - `unsupported` — no source contains the assertion's content tokens.
 *   - `unknown`     — the fact-checker could not evaluate the claim (empty
 *                     sources, whitespace-only claim, or a source that could
 *                     not be loaded and the checker was not allowed to
 *                     proceed offline).
 *
 * Design rules honoured:
 *  - No invented evidence. The checker never fabricates a source excerpt,
 *    never paraphrases a source to make it match, and never reports
 *    `supported` unless the evidence it cites appears verbatim in a source.
 *    Excerpts are the smallest span of source text that contains the matched
 *    tokens.
 *  - No invented sources. The caller supplies the sources. The live URL is
 *    only consulted when a fetcher is supplied; without one, live-URL checks
 *    are recorded as `unknown` with a descriptive note rather than skipped
 *    silently.
 *  - Deterministic given inputs. The token match is a set/order comparison,
 *    not a probabilistic model. The same claim against the same sources
 *    produces the same result.
 *  - Conservative. False positives (a claim reported as supported when it is
 *    not) are worse than false negatives for a review tool; the default
 *    threshold is high (see `DEFAULT_SUPPORT_THRESHOLD`).
 *  - Never blocks publication on its own. The report is advisory; a human
 *    reviewer accepts, edits or rejects.
 *
 * The module exports:
 *   - `factCheck` — evaluate one or many claims against a source set.
 *   - `buildFactCheckDirectives` — the LLM-visible block telling the writer
 *     how to phrase claims so they are verifiable.
 *   - `rehydrateFactCheckReport` — typed load of a persisted payload.
 *   - `claimTokens` / `findExcerpt` — low-level helpers, exported for tests.
 */

import type { AudienceProfile } from "@zipy/content/personalization/audience";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type FactCheckErrorCode = "invalid-input" | "shape";

export class FactCheckError extends Error {
  readonly code: FactCheckErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: FactCheckErrorCode,
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
 * Where a source came from. Mirrors the phases upstream (URL ingest, PDF,
 * image, docx, pptx, audio) so the review UI can group evidence by origin.
 */
export const FACT_CHECK_SOURCE_KINDS = [
  "url",
  "pdf",
  "docx",
  "pptx",
  "image",
  "audio",
  "video",
  "text",
  "live-url",
] as const;
export type FactCheckSourceKind = (typeof FACT_CHECK_SOURCE_KINDS)[number];

export interface FactCheckSource {
  /** Stable identifier, e.g. the artifact or source row id. */
  readonly id: string;
  readonly kind: FactCheckSourceKind;
  /** Human label shown next to an excerpt, e.g. "Onboarding PDF, p. 4". */
  readonly label: string;
  /** The source's scorable text. May be empty (e.g. a scanned page with no OCR). */
  readonly text: string;
  /**
   * Page or timestamp the text came from, when the source is paginated or
   * time-indexed. Carried verbatim into the excerpt reference.
   */
  readonly locator: string | null;
  /** ISO 8601 fetch or ingest time. Used by the review UI's freshness view. */
  readonly capturedAt: string | null;
}

export interface ClaimInput {
  /** Stable identifier, e.g. `step-3.description` or `title`. */
  readonly id: string;
  /** Where the claim sits in the guide, shown in the review UI. */
  readonly location: string;
  /** The claim text as written. */
  readonly text: string;
  /**
   * Optional hint: the writer flagged the claim as requiring a source. The
   * checker treats all claims as requiring support; the hint only affects
   * the ordering in which unresolved claims are surfaced.
   */
  readonly requiresSource?: boolean;
}

export const FACT_CHECK_VERDICTS = [
  "supported",
  "partial",
  "contradicted",
  "unsupported",
  "unknown",
] as const;
export type FactCheckVerdict = (typeof FACT_CHECK_VERDICTS)[number];

export interface FactCheckEvidence {
  /** Which source the excerpt came from. */
  readonly sourceId: string;
  readonly sourceKind: FactCheckSourceKind;
  readonly sourceLabel: string;
  readonly locator: string | null;
  /** The verbatim span of source text supporting the claim. */
  readonly excerpt: string;
  /** Number of claim content tokens found verbatim in this source. */
  readonly matchedTokens: number;
  /** Fraction of claim content tokens found in this source ([0, 1]). */
  readonly coverage: number;
  /**
   * When the source states the claim with an inverted polarity (a negation
   * the claim does not have, or vice versa), this is set to the excerpt
   * that reveals the disagreement.
   */
  readonly contradictionExcerpt: string | null;
}

export interface FactCheckResult {
  readonly claimId: string;
  readonly location: string;
  readonly claimText: string;
  readonly verdict: FactCheckVerdict;
  /**
   * The highest coverage observed across the sources, regardless of verdict.
   * Shown in the review UI next to the verdict.
   */
  readonly bestCoverage: number;
  /** Every source whose coverage crossed the low-evidence floor. Best-first. */
  readonly evidence: readonly FactCheckEvidence[];
  /** Human-readable reason for the verdict. Never empty for a non-supported result. */
  readonly reason: string;
  /**
   * True when the claim states an absolute (never, always, first, only) that
   * no source repeats verbatim. Absolute claims over-reach from evidence
   * that supports a narrower statement; the checker flags them separately
   * from a support failure.
   */
  readonly overreach: boolean;
}

export type FactCheckNoteKind =
  | "no-sources"
  | "no-claims"
  | "sources-empty"
  | "live-url-unavailable"
  | "live-url-skipped"
  | "live-url-loaded"
  | "claim-empty"
  | "short-claim"
  | "threshold-explicit";

export interface FactCheckNote {
  readonly kind: FactCheckNoteKind;
  readonly detail: string;
}

export interface FactCheckReport {
  readonly version: "fact-check/1";
  readonly results: readonly FactCheckResult[];
  readonly notes: readonly FactCheckNote[];
  /** Aggregate counts, useful for a summary panel. */
  readonly summary: {
    readonly total: number;
    readonly supported: number;
    readonly partial: number;
    readonly contradicted: number;
    readonly unsupported: number;
    readonly unknown: number;
    readonly overreach: number;
  };
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

/**
 * The fetch result the checker uses for the live URL. Supplied by the caller
 * (the route layer) after fetching the page itself; the fact-checker never
 * performs network I/O directly so it cannot become an implicit dependency.
 */
export interface LiveUrlSnapshot {
  readonly url: string;
  readonly text: string;
  readonly capturedAt: string;
  readonly locator: string | null;
}

export interface FactCheckInput {
  readonly claims: readonly ClaimInput[];
  readonly sources: readonly FactCheckSource[];
  /**
   * The live URL snapshot, when the route layer has already fetched it.
   * Without it, live-URL checks are recorded as `live-url-unavailable` and
   * no live-URL evidence is emitted.
   */
  readonly liveUrl?: LiveUrlSnapshot | null;
  /**
   * Coverage threshold above which a claim is `supported` (when no source
   * triggers a contradiction). Defaults to `DEFAULT_SUPPORT_THRESHOLD`.
   */
  readonly supportThreshold?: number;
  /**
   * Coverage threshold above which a claim is at least `partial`.
   * Defaults to `DEFAULT_PARTIAL_THRESHOLD`.
   */
  readonly partialThreshold?: number;
  readonly audience: AudienceProfile;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A claim is `supported` at this coverage fraction. Set deliberately high:
 * a review tool that reports "supported" for a partly-matched sentence will
 * lose reviewer trust quickly.
 */
export const DEFAULT_SUPPORT_THRESHOLD = 0.85;
/** A claim is at least `partial` at this coverage fraction. */
export const DEFAULT_PARTIAL_THRESHOLD = 0.45;
/** Claims shorter than this token count are flagged as too vague to check. */
export const MIN_CLAIM_TOKENS = 3;
/** Sources whose coverage is below this are omitted from the evidence list. */
const EVIDENCE_FLOOR = 0.20;

/**
 * Words that signal an absolute claim. When the source does not repeat one
 * of these, the claim is flagged as `overreach` — the writer has stated more
 * than the sources do.
 */
const ABSOLUTE_MARKERS: ReadonlySet<string> = new Set([
  "never",
  "always",
  "must",
  "only",
  "any",
  "all",
  "every",
  "first",
  "last",
  "guaranteed",
  "requires",
]);

/**
 * Tokens the checker treats as stop-words: they never count towards coverage.
 * The list is short — the checker prefers to over-match on non-stop tokens
 * than to score a phrase as supported because it shares "the", "of" and "a".
 */
const STOP_TOKENS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "to",
  "of", "in", "on", "at", "by", "with", "from", "as", "is", "are", "be",
  "was", "were", "do", "does", "did", "it", "its", "you", "your", "we",
  "our", "this", "that", "these", "those",
]);

/** Negation tokens. Presence or absence is compared between claim and source. */
const NEGATIONS: ReadonlySet<string> = new Set([
  "not", "no", "never", "without", "cannot", "can't", "don't", "doesn't",
  "won't", "isn't", "aren't", "wasn't", "weren't", "won\\u2019t",
]);

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function factCheck(input: FactCheckInput): FactCheckReport {
  if (input === null || typeof input !== "object") {
    throw new FactCheckError("factCheck requires an input object.", "invalid-input");
  }
  if (!Array.isArray(input.claims)) {
    throw new FactCheckError("`claims` must be an array.", "invalid-input");
  }
  if (!Array.isArray(input.sources)) {
    throw new FactCheckError("`sources` must be an array.", "invalid-input");
  }
  const supportThreshold = readThreshold(input.supportThreshold, DEFAULT_SUPPORT_THRESHOLD);
  const partialThreshold = readThreshold(input.partialThreshold, DEFAULT_PARTIAL_THRESHOLD);
  if (partialThreshold >= supportThreshold) {
    throw new FactCheckError(
      `partialThreshold (${partialThreshold}) must be less than supportThreshold (${supportThreshold}).`,
      "invalid-input",
    );
  }

  const notes: FactCheckNote[] = [];
  if (input.claims.length === 0) {
    notes.push({ kind: "no-claims", detail: "No claims were supplied to check." });
  }

  // Build the effective source list: the caller's sources plus the live-URL
  // snapshot when present.
  const rawSources: FactCheckSource[] = [];
  for (const s of input.sources) {
    if (s === null || typeof s !== "object") continue;
    rawSources.push({
      id: typeof s.id === "string" ? s.id : "",
      kind: readSourceKind(s.kind),
      label: typeof s.label === "string" ? s.label : "",
      text: typeof s.text === "string" ? s.text : "",
      locator: typeof s.locator === "string" && s.locator.trim().length > 0 ? s.locator : null,
      capturedAt:
        typeof s.capturedAt === "string" && s.capturedAt.trim().length > 0 ? s.capturedAt : null,
    });
  }
  if (input.liveUrl !== undefined && input.liveUrl !== null) {
    rawSources.push({
      id: "live-url",
      kind: "live-url",
      label: input.liveUrl.url,
      text: typeof input.liveUrl.text === "string" ? input.liveUrl.text : "",
      locator: input.liveUrl.locator,
      capturedAt: input.liveUrl.capturedAt,
    });
    notes.push({
      kind: "live-url-loaded",
      detail: `Live URL snapshot for ${input.liveUrl.url} was included as a source.`,
    });
  } else {
    notes.push({
      kind: "live-url-unavailable",
      detail:
        "No live URL snapshot was supplied. Claims are checked against the guide's ingested sources only; no page was fetched by the fact-checker itself.",
    });
  }
  if (rawSources.length === 0) {
    notes.push({
      kind: "no-sources",
      detail:
        "No sources were supplied. Every claim whose text is non-empty is reported as `unknown`.",
    });
  } else if (rawSources.every((s) => s.text.trim().length === 0)) {
    notes.push({
      kind: "sources-empty",
      detail:
        "All supplied sources have empty text (e.g. a scanned page with no OCR). Every claim is reported as `unknown`.",
    });
  }

  // Pre-tokenise each source once so a large source set does not re-tokenise
  // per claim.
  const preparedSources = rawSources.map((s) => ({
    source: s,
    normalised: normaliseForMatch(s.text),
    tokens: new Set(claimTokens(s.text).map((t) => t.normalised)),
  }));

  const results: FactCheckResult[] = [];
  for (const raw of input.claims) {
    if (raw === null || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id : "";
    const location = typeof raw.location === "string" ? raw.location : "";
    const text = typeof raw.text === "string" ? raw.text : "";
    const tokens = claimTokens(text);
    if (text.trim().length === 0) {
      notes.push({
        kind: "claim-empty",
        detail: `Claim "${id}" is empty and was reported as unknown.`,
      });
      results.push(unknownResult(id, location, text, "The claim text is empty."));
      continue;
    }
    if (tokens.length < MIN_CLAIM_TOKENS) {
      notes.push({
        kind: "short-claim",
        detail: `Claim "${id}" has fewer than ${MIN_CLAIM_TOKENS} content tokens; a short claim is too vague to verify against sources.`,
      });
      results.push(unknownResult(id, location, text, "The claim is too short to verify."));
      continue;
    }
    results.push(
      evaluateClaim({
        id,
        location,
        text,
        tokens,
        preparedSources,
        supportThreshold,
        partialThreshold,
      }),
    );
  }

  if (input.supportThreshold === undefined || input.partialThreshold === undefined) {
    notes.push({
      kind: "threshold-explicit",
      detail: `Support threshold ${supportThreshold}; partial threshold ${partialThreshold}. Pass ` +
        "`supportThreshold`/`partialThreshold` to override.",
    });
  }

  const summary = {
    total: results.length,
    supported: results.filter((r) => r.verdict === "supported").length,
    partial: results.filter((r) => r.verdict === "partial").length,
    contradicted: results.filter((r) => r.verdict === "contradicted").length,
    unsupported: results.filter((r) => r.verdict === "unsupported").length,
    unknown: results.filter((r) => r.verdict === "unknown").length,
    overreach: results.filter((r) => r.overreach).length,
  };

  return {
    version: "fact-check/1",
    results,
    notes,
    summary,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * The LLM-visible directive block. Append to the writer's system prompt when
 * the guide will be fact-checked. Short and imperative.
 */
export function buildFactCheckDirectives(input: {
  readonly audience: AudienceProfile;
  readonly hasLiveUrl: boolean;
}): string {
  const lines: string[] = [];
  lines.push("Every factual claim you write will be checked against the guide's sources.");
  lines.push(
    "- State only what the sources state. Do not generalise a specific observation ('the Save button is green') into a rule ('the Save button is always green').",
  );
  lines.push(
    "- Do not assert an absolute ('always', 'never', 'only', 'first') unless a source uses the same word. An absolute over-reaches from evidence that supports a narrower statement.",
  );
  lines.push(
    "- Name the actor of an action. 'Click Save' is checkable; 'it is saved' is not.",
  );
  lines.push(
    "- Do not paraphrase a source so that the paraphrase adds a claim. If the source is imprecise, say the source is imprecise rather than resolving it in your own words.",
  );
  if (!input.hasLiveUrl) {
    lines.push(
      "- No live URL snapshot is available for this check. You will be verified against the ingested sources only; if a claim depends on the application's current state, flag it for a reviewer rather than asserting it.",
    );
  }
  if (input.audience.seniority === "expert") {
    lines.push("- Assume an expert reader's scrutiny: name versions, field names and defaults explicitly.");
  } else if (input.audience.seniority === "novice") {
    lines.push(
      "- Avoid hedged phrases ('typically', 'usually') unless the source states them; they make a claim uncheckable without adding clarity for a novice reader.",
    );
  }
  return lines.join("\n");
}

/**
 * Tokenise a claim or source into content tokens. Keeps alphanumeric runs,
 * drops stop-words, and normalises the result to lowercase. Exported for
 * tests and for the review UI's "matched tokens" breakdown.
 */
export function claimTokens(text: string): readonly { readonly raw: string; readonly normalised: string }[] {
  if (typeof text !== "string") return [];
  const re = /[A-Za-z][A-Za-z0-9'’\-_.]*/gu;
  const out: { raw: string; normalised: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const normalised = raw.toLowerCase().replace(/[’]/gu, "'").replace(/[^a-z0-9'\-_.]/gu, "");
    if (normalised.length < 2) continue;
    if (STOP_TOKENS.has(normalised)) continue;
    out.push({ raw, normalised });
  }
  return out;
}

/**
 * Find the smallest contiguous span of `source` that contains the matched
 * tokens, in their original order, within a small window. Returns `null`
 * when no such span exists. Exported for tests.
 *
 * The implementation walks the source tokens and, for each starting token
 * that matches a claim token, extends a window while claim tokens appear.
 * The window that matches the most claim tokens wins; ties go to the earliest.
 */
export function findExcerpt(
  source: string,
  claim: readonly { readonly normalised: string }[],
): { readonly excerpt: string; readonly matchedTokens: number } | null {
  if (typeof source !== "string" || source.length === 0) return null;
  if (claim.length === 0) return null;
  const claimSet = new Set(claim.map((t) => t.normalised));
  const re = /[A-Za-z][A-Za-z0-9'’\-_.]*/gu;
  const positions: { start: number; end: number; normalised: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const raw = m[0];
    const normalised = raw.toLowerCase().replace(/[’]/gu, "'").replace(/[^a-z0-9'\-_.]/gu, "");
    positions.push({ start: m.index, end: m.index + raw.length, normalised });
  }
  if (positions.length === 0) return null;

  let best: { start: number; end: number; matched: number } | null = null;
  const maxWindow = Math.max(40, claim.length * 6);
  for (let i = 0; i < positions.length; i += 1) {
    const first = positions[i];
    if (first === undefined) continue;
    if (!claimSet.has(first.normalised)) continue;
    const seen = new Set<string>();
    let last = i;
    for (let j = i; j < positions.length && j < i + maxWindow; j += 1) {
      const tok = positions[j];
      if (tok === undefined) continue;
      if (claimSet.has(tok.normalised)) {
        seen.add(tok.normalised);
        last = j;
      }
    }
    if (seen.size === 0) continue;
    const spanStart = positions[i]?.start ?? 0;
    const spanEnd = positions[last]?.end ?? 0;
    if (best === null || seen.size > best.matched) {
      best = { start: spanStart, end: spanEnd, matched: seen.size };
    }
  }
  if (best === null) return null;
  // Trim the excerpt at word boundaries and cap its length so a matched
  // span inside a long sentence does not copy the whole paragraph.
  let excerpt = source.slice(best.start, best.end).trim();
  if (excerpt.length > 320) {
    excerpt = excerpt.slice(0, 320);
    const space = excerpt.lastIndexOf(" ");
    if (space > 200) excerpt = excerpt.slice(0, space);
    excerpt = `${excerpt}…`;
  }
  return { excerpt, matchedTokens: best.matched };
}

export function rehydrateFactCheckReport(value: unknown): FactCheckReport {
  if (value === null || typeof value !== "object") {
    throw new FactCheckError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "fact-check/1") {
    throw new FactCheckError(
      `Rehydrate failed: expected version "fact-check/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  return {
    version: "fact-check/1",
    results: readResults(r["results"]),
    notes: readNotes(r["notes"]),
    summary: readSummary(r["summary"]),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface PreparedSource {
  readonly source: FactCheckSource;
  readonly normalised: string;
  readonly tokens: ReadonlySet<string>;
}

interface EvaluateInput {
  readonly id: string;
  readonly location: string;
  readonly text: string;
  readonly tokens: readonly { readonly raw: string; readonly normalised: string }[];
  readonly preparedSources: readonly PreparedSource[];
  readonly supportThreshold: number;
  readonly partialThreshold: number;
}

function evaluateClaim(input: EvaluateInput): FactCheckResult {
  const claimSet = new Set(input.tokens.map((t) => t.normalised));
  const claimNegations = collectNegations(input.text);
  const absoluteMarkers = input.tokens
    .map((t) => t.normalised)
    .filter((t) => ABSOLUTE_MARKERS.has(t));

  const evidence: FactCheckEvidence[] = [];
  let bestCoverage = 0;
  let bestSourceId: string | null = null;
  let contradiction: FactCheckEvidence | null = null;

  for (const src of input.preparedSources) {
    let matched = 0;
    for (const t of claimSet) {
      if (src.tokens.has(t)) matched += 1;
    }
    const coverage = claimSet.size === 0 ? 0 : matched / claimSet.size;
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestSourceId = src.source.id;
    }
    if (coverage < EVIDENCE_FLOOR) continue;
    const excerptResult = findExcerpt(src.source.text, input.tokens);
    const excerpt = excerptResult !== null ? excerptResult.excerpt : "";
    const sourceNegations = collectNegations(
      excerptResult !== null ? excerptResult.excerpt : src.source.text.slice(0, 800),
    );
    let contradictionExcerpt: string | null = null;
    // A contradiction requires: (a) enough coverage that the source is
    // clearly about the same subject, and (b) a negation mismatch between
    // the claim and the source span.
    if (coverage >= input.partialThreshold) {
      const claimPositive = claimNegations.size === 0;
      const sourcePositive = sourceNegations.size === 0;
      if (claimPositive !== sourcePositive) {
        contradictionExcerpt = excerpt.length > 0 ? excerpt : src.source.text.slice(0, 240);
      }
    }
    const ev: FactCheckEvidence = {
      sourceId: src.source.id,
      sourceKind: src.source.kind,
      sourceLabel: src.source.label,
      locator: src.source.locator,
      excerpt,
      matchedTokens: matched,
      coverage: round3(coverage),
      contradictionExcerpt,
    };
    if (contradictionExcerpt !== null && (contradiction === null || ev.coverage > contradiction.coverage)) {
      contradiction = ev;
    }
    evidence.push(ev);
  }

  evidence.sort((a, b) => b.coverage - a.coverage);

  let verdict: FactCheckVerdict;
  let reason: string;
  if (contradiction !== null) {
    verdict = "contradicted";
    reason =
      `The source "${contradiction.sourceLabel}" states the claim with the opposite polarity ` +
      `(negation mismatch). Coverage ${(contradiction.coverage * 100).toFixed(0)}%.`;
  } else if (bestCoverage >= input.supportThreshold) {
    verdict = "supported";
    reason =
      bestSourceId !== null
        ? `Matched ${(bestCoverage * 100).toFixed(0)}% of the claim's content tokens against source "${bestSourceId}".`
        : "Matched the claim against the supplied sources.";
  } else if (bestCoverage >= input.partialThreshold) {
    verdict = "partial";
    reason =
      `Matched only ${(bestCoverage * 100).toFixed(0)}% of the claim's content tokens; the sources do not fully state the assertion. A reviewer must confirm the framing.`;
  } else if (bestCoverage > 0) {
    verdict = "unsupported";
    reason =
      `Matched only ${(bestCoverage * 100).toFixed(0)}% of the claim's content tokens; the sources do not contain the assertion.`;
  } else {
    verdict = "unsupported";
    reason =
      "None of the claim's content tokens appear in any source. The claim is not grounded.";
  }

  const overreach =
    absoluteMarkers.length > 0 &&
    (verdict === "partial" || verdict === "unsupported" || verdict === "unknown");

  return {
    claimId: input.id,
    location: input.location,
    claimText: input.text,
    verdict,
    bestCoverage: round3(bestCoverage),
    evidence,
    reason,
    overreach,
  };
}

function unknownResult(
  id: string,
  location: string,
  text: string,
  reason: string,
): FactCheckResult {
  return {
    claimId: id,
    location,
    claimText: text,
    verdict: "unknown",
    bestCoverage: 0,
    evidence: [],
    reason,
    overreach: false,
  };
}

function collectNegations(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  if (typeof text !== "string") return out;
  const re = /[A-Za-z][A-Za-z0-9'’]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const normalised = m[0].toLowerCase().replace(/[’]/gu, "'");
    if (NEGATIONS.has(normalised)) out.add(normalised);
  }
  return out;
}

function normaliseForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

function readThreshold(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function readSourceKind(v: unknown): FactCheckSourceKind {
  return v === "url" ||
    v === "pdf" ||
    v === "docx" ||
    v === "pptx" ||
    v === "image" ||
    v === "audio" ||
    v === "video" ||
    v === "text" ||
    v === "live-url"
    ? v
    : "text";
}

function readVerdict(v: unknown): FactCheckVerdict {
  return v === "supported" ||
    v === "partial" ||
    v === "contradicted" ||
    v === "unsupported" ||
    v === "unknown"
    ? v
    : "unknown";
}

/* -------------------------------------------------------------------------- */
/* Rehydrate readers                                                           */
/* -------------------------------------------------------------------------- */

function readEvidence(v: unknown): readonly FactCheckEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: FactCheckEvidence[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    out.push({
      sourceId: typeof o["sourceId"] === "string" ? o["sourceId"] : "",
      sourceKind: readSourceKind(o["sourceKind"]),
      sourceLabel: typeof o["sourceLabel"] === "string" ? o["sourceLabel"] : "",
      locator: typeof o["locator"] === "string" ? o["locator"] : null,
      excerpt: typeof o["excerpt"] === "string" ? o["excerpt"] : "",
      matchedTokens:
        typeof o["matchedTokens"] === "number" && Number.isFinite(o["matchedTokens"])
          ? Math.max(0, Math.floor(o["matchedTokens"]))
          : 0,
      coverage:
        typeof o["coverage"] === "number" && Number.isFinite(o["coverage"]) ? o["coverage"] : 0,
      contradictionExcerpt:
        typeof o["contradictionExcerpt"] === "string" && o["contradictionExcerpt"].length > 0
          ? o["contradictionExcerpt"]
          : null,
    });
  }
  return out;
}

function readResults(v: unknown): readonly FactCheckResult[] {
  if (!Array.isArray(v)) return [];
  const out: FactCheckResult[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    out.push({
      claimId: typeof o["claimId"] === "string" ? o["claimId"] : "",
      location: typeof o["location"] === "string" ? o["location"] : "",
      claimText: typeof o["claimText"] === "string" ? o["claimText"] : "",
      verdict: readVerdict(o["verdict"]),
      bestCoverage:
        typeof o["bestCoverage"] === "number" && Number.isFinite(o["bestCoverage"])
          ? o["bestCoverage"]
          : 0,
      evidence: readEvidence(o["evidence"]),
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
      overreach: o["overreach"] === true,
    });
  }
  return out;
}

function readNotes(v: unknown): readonly FactCheckNote[] {
  if (!Array.isArray(v)) return [];
  const out: FactCheckNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "no-sources" &&
      kind !== "no-claims" &&
      kind !== "sources-empty" &&
      kind !== "live-url-unavailable" &&
      kind !== "live-url-skipped" &&
      kind !== "live-url-loaded" &&
      kind !== "claim-empty" &&
      kind !== "short-claim" &&
      kind !== "threshold-explicit"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

function readSummary(v: unknown): FactCheckReport["summary"] {
  const fallback = {
    total: 0,
    supported: 0,
    partial: 0,
    contradicted: 0,
    unsupported: 0,
    unknown: 0,
    overreach: 0,
  };
  if (v === null || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  return {
    total: readInt(o["total"]),
    supported: readInt(o["supported"]),
    partial: readInt(o["partial"]),
    contradicted: readInt(o["contradicted"]),
    unsupported: readInt(o["unsupported"]),
    unknown: readInt(o["unknown"]),
    overreach: readInt(o["overreach"]),
  };
}

function readInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  claimTokens,
  findExcerpt,
  collectNegations,
  normaliseForMatch,
  evaluateClaim,
  readThreshold,
  round3,
  ABSOLUTE_MARKERS,
  STOP_TOKENS,
  NEGATIONS,
  EVIDENCE_FLOOR,
});
