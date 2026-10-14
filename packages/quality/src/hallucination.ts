/**
 * Zipy AI — hallucination detection (SEO/quality/safety phase, batch 2).
 *
 * Detects statements in generated content that are not grounded in the guide's
 * sources. It is the reviewing layer that sits between the fact-checker (which
 * evaluates a claim the writer already decomposed) and the human reviewer:
 * the fact-checker answers "is *this* claim supported?", while hallucination
 * detection answers "which sentences of this generated prose are not grounded
 * at all?" — so a writer is not required to self-decompose before review.
 *
 * Relationship to `@zipy/quality/factCheck`:
 *   - This module segments prose into sentences/paragraphs, then for each
 *     sentence produces a `GroundingVerdict` using the same token-coverage
 *     logic the fact-checker applies to a claim. It re-uses the fact-checker's
 *     exported helpers (`claimTokens`, `findExcerpt`) so the two layers agree
 *     on what "grounded" means and cannot drift apart.
 *   - The fact-checker's absolute-marker / negation checks are applied here
 *     too, so over-reach and polarity flips are surfaced as hallucination
 *     findings rather than only as fact-check verdicts.
 *
 * Design rules honoured:
 *  - No invented evidence. A sentence is only reported as `grounded` when the
 *    sources contain its content tokens verbatim. The module never fabricates
 *    an excerpt, never paraphrases a source to make it fit, and never invents a
 *    source.
 *  - No invented sources. Every source the module cites was supplied by the
 *    caller; the live-URL snapshot is only consulted when the route layer has
 *    already taken it, and its absence is recorded as a note rather than
 *    silently skipped.
 *  - Deterministic given inputs. Coverage is a token-set ratio; the same text
 *    against the same sources always produces the same verdict.
 *  - Conservative and advisory. The module never blocks publication on its
 *    own; it produces findings a reviewer acts on. False positives (reporting a
 *    grounded sentence as a hallucination) erode reviewer trust, so the default
 *    threshold is high.
 *  - Structural sentences are not checked. A heading, a "Step 1" list marker,
 *    a bullet pure navigational text ("Continue.") and a code block are not
 *    treated as claims; they are recorded as `non-claim` so the reviewer sees
 *    them in the breakdown without the module pretending to have an opinion.
 *
 * The module exports:
 *   - `detectHallucinations` — the primary entry point.
 *   - `segmentProse` — segment a body string into paragraph/sentence units.
 *   - `classifySentence` — surface classification used to skip non-claims.
 *   - `buildHallucinationDirectives` — the LLM-visible block telling the
 *     writer what to do so a sentence grounds cleanly.
 *   - `rehydrateHallucinationReport` — typed load of a persisted payload.
 *   - `__internals` — helpers exported for tests.
 */

import {
  claimTokens,
  findExcerpt,
  DEFAULT_SUPPORT_THRESHOLD,
  DEFAULT_PARTIAL_THRESHOLD,
  type FactCheckSource,
  type LiveUrlSnapshot,
} from "@zipy/quality/factCheck";
import type { AudienceProfile } from "@zipy/content/personalization/audience";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type HallucinationErrorCode = "invalid-input" | "shape";

export class HallucinationError extends Error {
  readonly code: HallucinationErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: HallucinationErrorCode,
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
 * A minimal document model. The caller supplies the generated prose as an
 * ordered list of blocks so section boundaries are preserved. Blocks are
 * either paragraphs of prose, headings, list items or code. Anything that is
 * not `paragraph` or `list-item` is treated as a non-claim and is not
 * scored; it is still included in the report so the reviewer sees the full
 * body.
 */
export const HALLUCINATION_BLOCK_KINDS = [
  "paragraph",
  "list-item",
  "heading",
  "code",
  "callout",
  "table-cell",
] as const;
export type HallucinationBlockKind = (typeof HALLUCINATION_BLOCK_KINDS)[number];

export interface GenerateBlock {
  /** Stable identifier, e.g. `step-3.description`. */
  readonly id: string;
  readonly kind: HallucinationBlockKind;
  /** Human-visible location, e.g. "Step 3 — description". */
  readonly location: string;
  /** The block's text. May be empty. */
  readonly text: string;
}

export const GROUNDING_VERDICTS = [
  "grounded",
  "partially-grounded",
  "ungrounded",
  "contradicted",
  "non-claim",
  "unknown",
] as const;
export type GroundingVerdict = (typeof GROUNDING_VERDICTS)[number];

export interface GroundingEvidence {
  readonly sourceId: string;
  readonly sourceKind: FactCheckSource["kind"];
  readonly sourceLabel: string;
  readonly locator: string | null;
  readonly excerpt: string;
  readonly matchedTokens: number;
  readonly coverage: number;
}

export interface SentenceFinding {
  readonly blockId: string;
  readonly location: string;
  /** 0-based index of the sentence within the block. */
  readonly sentenceIndex: number;
  readonly text: string;
  readonly verdict: GroundingVerdict;
  /** Best coverage observed across all sources; [0, 1]. */
  readonly bestCoverage: number;
  /** All source excerpts that cleared the evidence floor, best-first. */
  readonly evidence: readonly GroundingEvidence[];
  /** Human-readable reason for the verdict. */
  readonly reason: string;
  /**
   * True when the sentence carries an absolute marker ("never", "always",
   * "only", etc.) that no source repeats verbatim. Absolute claims over-reach
   * from evidence that supports a narrower statement.
   */
  readonly overreach: boolean;
  /** True when the sentence carries a negation the matched source does not. */
  readonly polarityMismatch: boolean;
}

export interface BlockReport {
  readonly blockId: string;
  readonly location: string;
  readonly kind: HallucinationBlockKind;
  readonly findings: readonly SentenceFinding[];
  /**
   * `non-claim` when the block's kind is not scorable, `checked` when at
   * least one sentence was scored.
   */
  readonly disposition: "checked" | "non-claim";
}

export interface HallucinationNote {
  readonly kind:
    | "no-sources"
    | "sources-empty"
    | "no-blocks"
    | "live-url-unavailable"
    | "live-url-loaded"
    | "non-claim-block"
    | "empty-block"
    | "short-sentence"
    | "empty-sentence"
    | "threshold-explicit";
  readonly detail: string;
}

export interface HallucinationReport {
  readonly version: "hallucination/1";
  readonly blocks: readonly BlockReport[];
  readonly notes: readonly HallucinationNote[];
  readonly summary: {
    readonly totalSentences: number;
    readonly grounded: number;
    readonly partiallyGrounded: number;
    readonly ungrounded: number;
    readonly contradicted: number;
    readonly nonClaim: number;
    readonly unknown: number;
    readonly overreach: number;
    readonly polarityMismatch: number;
  };
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface DetectHallucinationsInput {
  readonly blocks: readonly GenerateBlock[];
  readonly sources: readonly FactCheckSource[];
  /**
   * Optional live-URL snapshot, when the caller has already fetched the
   * page. The detector never performs I/O itself; without it, live-URL
   * checks are recorded as unavailable.
   */
  readonly liveUrl?: LiveUrlSnapshot | null;
  readonly supportThreshold?: number;
  readonly partialThreshold?: number;
  readonly audience: AudienceProfile;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** A sentence with fewer than this many content tokens is too vague to score. */
export const MIN_SENTENCE_TOKENS = 3;
/** Sources whose coverage is below this fraction are omitted from the evidence list. */
const EVIDENCE_FLOOR = 0.20;
/** Absolute markers whose repetition in a source is required to not over-reach. */
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
/** Negation tokens. Presence/absence is compared between sentence and source. */
const NEGATIONS: ReadonlySet<string> = new Set([
  "not",
  "no",
  "never",
  "without",
  "cannot",
  "can't",
  "don't",
  "doesn't",
  "won't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
]);
/** Block kinds that are not scored; their text is not treated as a claim. */
const NON_CLAIM_KINDS: ReadonlySet<HallucinationBlockKind> = new Set([
  "heading",
  "code",
]);

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function detectHallucinations(
  input: DetectHallucinationsInput,
): HallucinationReport {
  if (input === null || typeof input !== "object") {
    throw new HallucinationError("detectHallucinations requires an input object.", "invalid-input");
  }
  if (!Array.isArray(input.blocks)) {
    throw new HallucinationError("`blocks` must be an array.", "invalid-input");
  }
  if (!Array.isArray(input.sources)) {
    throw new HallucinationError("`sources` must be an array.", "invalid-input");
  }

  const supportThreshold = readThreshold(input.supportThreshold, DEFAULT_SUPPORT_THRESHOLD);
  const partialThreshold = readThreshold(input.partialThreshold, DEFAULT_PARTIAL_THRESHOLD);
  if (partialThreshold >= supportThreshold) {
    throw new HallucinationError(
      `partialThreshold (${partialThreshold}) must be less than supportThreshold (${supportThreshold}).`,
      "invalid-input",
    );
  }

  const notes: HallucinationNote[] = [];

  // Effective source set: caller sources plus the live-URL snapshot, when
  // supplied. Applied the same way the fact-checker does so the two layers
  // make identical grounding decisions on identical input.
  const sources: FactCheckSource[] = [];
  for (const s of input.sources) {
    if (s === null || typeof s !== "object") continue;
    sources.push({
      id: typeof s.id === "string" ? s.id : "",
      kind: s.kind,
      label: typeof s.label === "string" ? s.label : "",
      text: typeof s.text === "string" ? s.text : "",
      locator: typeof s.locator === "string" && s.locator.trim().length > 0 ? s.locator : null,
      capturedAt:
        typeof s.capturedAt === "string" && s.capturedAt.trim().length > 0 ? s.capturedAt : null,
    });
  }
  if (input.liveUrl !== undefined && input.liveUrl !== null) {
    sources.push({
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
        "No live URL snapshot was supplied. Grounding is checked against the ingested sources only; the detector did not fetch any page.",
    });
  }
  if (sources.length === 0) {
    notes.push({
      kind: "no-sources",
      detail:
        "No sources were supplied. Every scorable sentence is reported as `unknown`.",
    });
  } else if (sources.every((s) => s.text.trim().length === 0)) {
    notes.push({
      kind: "sources-empty",
      detail:
        "All supplied sources contain no text. Every scorable sentence is reported as `unknown`.",
    });
  }
  if (input.blocks.length === 0) {
    notes.push({
      kind: "no-blocks",
      detail: "No blocks were supplied to check.",
    });
  }

  // Pre-tokenise each source once.
  const preparedSources = sources.map((s) => ({
    source: s,
    tokens: new Set(claimTokens(s.text).map((t) => t.normalised)),
  }));

  const blocks: BlockReport[] = [];
  const summaryMutable = {
    totalSentences: 0,
    grounded: 0,
    partiallyGrounded: 0,
    ungrounded: 0,
    contradicted: 0,
    nonClaim: 0,
    unknown: 0,
    overreach: 0,
    polarityMismatch: 0,
  };

  for (const raw of input.blocks) {
    if (raw === null || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id : "";
    const kind = readBlockKind(raw.kind);
    const location = typeof raw.location === "string" ? raw.location : "";
    const text = typeof raw.text === "string" ? raw.text : "";

    if (NON_CLAIM_KINDS.has(kind)) {
      notes.push({
        kind: "non-claim-block",
        detail: `Block "${id}" (kind=${kind}) is structural and was not scored.`,
      });
      blocks.push({
        blockId: id,
        location,
        kind,
        findings: [],
        disposition: "non-claim",
      });
      continue;
    }
    if (text.trim().length === 0) {
      notes.push({
        kind: "empty-block",
        detail: `Block "${id}" is empty and was skipped.`,
      });
      blocks.push({
        blockId: id,
        location,
        kind,
        findings: [],
        disposition: "checked",
      });
      continue;
    }

    const findings: SentenceFinding[] = [];
    const sentences =
      kind === "list-item"
        ? classifySentences(text.trim())
        : classifySentences(text);
    let index = 0;
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (s.length === 0) continue;
      const tokens = claimTokens(s);
      if (tokens.length === 0) {
        notes.push({
          kind: "empty-sentence",
          detail: `Block "${id}", sentence ${index}: no content tokens; reported as unknown.`,
        });
        findings.push(unknownFinding(id, location, index, s));
        summaryMutable.totalSentences += 1;
        summaryMutable.unknown += 1;
        index += 1;
        continue;
      }
      if (tokens.length < MIN_SENTENCE_TOKENS) {
        notes.push({
          kind: "short-sentence",
          detail: `Block "${id}", sentence ${index}: fewer than ${MIN_SENTENCE_TOKENS} content tokens; reported as unknown.`,
        });
        findings.push(unknownFinding(id, location, index, s));
        summaryMutable.totalSentences += 1;
        summaryMutable.unknown += 1;
        index += 1;
        continue;
      }

      const finding = evaluateSentence({
        blockId: id,
        location,
        sentenceIndex: index,
        text: s,
        tokens,
        preparedSources,
        supportThreshold,
        partialThreshold,
      });
      findings.push(finding);
      summaryMutable.totalSentences += 1;
      switch (finding.verdict) {
        case "grounded":
          summaryMutable.grounded += 1;
          break;
        case "partially-grounded":
          summaryMutable.partiallyGrounded += 1;
          break;
        case "ungrounded":
          summaryMutable.ungrounded += 1;
          break;
        case "contradicted":
          summaryMutable.contradicted += 1;
          break;
        case "unknown":
          summaryMutable.unknown += 1;
          break;
        default:
          summaryMutable.nonClaim += 1;
          break;
      }
      if (finding.overreach) summaryMutable.overreach += 1;
      if (finding.polarityMismatch) summaryMutable.polarityMismatch += 1;
      index += 1;
    }

    blocks.push({
      blockId: id,
      location,
      kind,
      findings,
      disposition: "checked",
    });
  }

  if (input.supportThreshold === undefined || input.partialThreshold === undefined) {
    notes.push({
      kind: "threshold-explicit",
      detail: `Support threshold ${supportThreshold}; partial threshold ${partialThreshold}.`,
    });
  }

  return {
    version: "hallucination/1",
    blocks,
    notes,
    summary: summaryMutable,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Segment a block of prose into sentences. Deterministic and offline: the
 * same string always produces the same segmentation. Abbreviations, decimals
 * and initials are treated conservatively (a period that the sentence-split
 * heuristic cannot confidently resolve to a break does not break).
 *
 * Exported because the review UI displays the same segmentation the detector
 * scored.
 */
export function segmentProse(text: string): readonly string[] {
  if (typeof text !== "string" || text.trim().length === 0) return [];
  // Normalise newlines into sentence breaks; the caller may flatten a list
  // into a single text field. A blank line is a hard break.
  const flattened = text
    .replace(/\r\n?/gu, "\n")
    .replace(/\n{2,}/gu, ". ")
    .replace(/\n/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flattened)) !== null) {
    const idx = m.index;
    const matched = m[0];
    const next = idx + matched.length < flattened.length ? flattened.charAt(idx + matched.length) : "";
    // Require either end-of-string or whitespace after a terminator; a
    // terminator immediately followed by a non-space is part of a token.
    if (next.length > 0 && !/\s/u.test(next)) continue;
    // A period between two digits is a decimal point.
    const prev = idx > 0 ? flattened.charAt(idx - 1) : "";
    if (matched === "." && /[0-9]/u.test(prev) && /[0-9]/u.test(next)) continue;
    // A single-capital-letter with a period is an initial.
    if (matched === ".") {
      const oneLetter = flattened.charAt(idx - 1);
      const beforeOne = idx >= 2 ? flattened.charAt(idx - 2) : "";
      if (/[A-Z]/u.test(oneLetter) && (beforeOne === "" || /\s|[("]/u.test(beforeOne))) {
        continue;
      }
      const before = flattened.slice(Math.max(0, idx - 6), idx).toLowerCase();
      if (/(^|[\s(])(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|st|no|fig|approx)$/u.test(before)) {
        continue;
      }
    }
    const sentence = flattened.slice(start, idx + matched.length).trim();
    if (sentence.length > 0) out.push(sentence);
    start = idx + matched.length;
  }
  const tail = flattened.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  // A single sentence with no terminator still counts as one unit.
  if (out.length === 0 && flattened.length > 0) out.push(flattened);
  return out;
}

/**
 * Classify each word of a block's sentence into a shape. Used to drop a
 * sentence that is *purely* sub-heading-shaped ("Steps:") from the scoring
 * pass, while still returning it so the reviewer sees the segmentation.
 */
export function classifySentences(text: string): readonly string[] {
  if (typeof text !== "string") return [];
  const sentences = segmentProse(text);
  const out: string[] = [];
  for (const s of sentences) {
    const trimmed = s.trim();
    if (trimmed.length === 0) continue;
    // Drop a pure heading tail like "Steps:" from the scoring set; keep it
    // in the returned list as an empty string so the caller can decide.
    if (/^[A-Za-z][A-Za-z0-9 \-_/]{0,60}:?$/u.test(trimmed) && trimmed.endsWith(":") && trimmed.split(/\s+/u).length <= 4) {
      continue;
    }
    out.push(trimmed);
  }
  return out;
}

/**
 * Categorise a *block* for the reviewer's sidebar.
 */
export function classifyBlock(block: GenerateBlock): HallucinationBlockKind | "unknown" {
  if (block === null || typeof block !== "object") return "unknown";
  return readBlockKind(block.kind);
}

/**
 * The LLM-visible directive block. Append to the writer's system prompt when
 * a guide will be hallucination-checked. Short, imperative, and consistent
 * with the fact-checker's directives so the writer is not given conflicting
 * instructions.
 */
export function buildHallucinationDirectives(input: {
  readonly audience: AudienceProfile;
  readonly hasLiveUrl: boolean;
}): string {
  const lines: string[] = [];
  lines.push(
    "Every sentence of your prose will be checked for grounding against the guide's sources.",
  );
  lines.push(
    "- State only what the sources state. If a source does not mention a field, a default, a step or a behaviour, do not add it.",
  );
  lines.push(
    "- Prefer a specific, checkable claim over a general one. A sentence that names the subject, the action and the target is checkable; a sentence that summarises a paragraph is not.",
  );
  lines.push(
    "- Do not invent UI strings ('Click Save'), routes ('/customers/new'), keyboard shortcuts or error messages. If a source uses a specific string, use that exact string; if no source does, omit the sentence.",
  );
  lines.push(
    "- Do not write a transition that carries a claim ('This makes the customer active.'). A transition carries a claim when it introduces a fact the sources do not state.",
  );
  lines.push(
    "- Do not state an absolute ('always', 'never', 'only', 'first', 'requires') unless a source uses the same word. An absolute over-reaches from evidence that supports a narrower statement.",
  );
  lines.push(
    "- Preserve polarity. If a source says a field is optional, do not write that it is required; if a source says a step is skipped, do not write that it runs.",
  );
  if (!input.hasLiveUrl) {
    lines.push(
      "- No live URL snapshot is available for this check. You will be verified against the ingested sources only. If a sentence depends on the application's current state, flag it for a reviewer instead of asserting it.",
    );
  }
  if (input.audience.seniority === "expert") {
    lines.push(
      "- Assume an expert reader will scrutinise every version number, field name and default. Reproduce them from the sources exactly.",
    );
  } else if (input.audience.seniority === "novice") {
    lines.push(
      "- Avoid hedge words ('typically', 'usually', 'in most cases') unless a source uses them; a hedge makes a sentence uncheckable without adding clarity.",
    );
  }
  return lines.join("\n");
}

export function rehydrateHallucinationReport(value: unknown): HallucinationReport {
  if (value === null || typeof value !== "object") {
    throw new HallucinationError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "hallucination/1") {
    throw new HallucinationError(
      `Rehydrate failed: expected version "hallucination/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  return {
    version: "hallucination/1",
    blocks: readBlocks(r["blocks"]),
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
  readonly tokens: ReadonlySet<string>;
}

interface EvaluateInput {
  readonly blockId: string;
  readonly location: string;
  readonly sentenceIndex: number;
  readonly text: string;
  readonly tokens: readonly { readonly raw: string; readonly normalised: string }[];
  readonly preparedSources: readonly PreparedSource[];
  readonly supportThreshold: number;
  readonly partialThreshold: number;
}

function evaluateSentence(input: EvaluateInput): SentenceFinding {
  const sentenceSet = new Set(input.tokens.map((t) => t.normalised));
  const sentenceNegations = collectNegations(input.text);
  const sentencePositives = sentenceNegations.size === 0;
  const absoluteMarkers = input.tokens
    .map((t) => t.normalised)
    .filter((t) => ABSOLUTE_MARKERS.has(t));

  const evidence: GroundingEvidence[] = [];
  let bestCoverage = 0;
  let bestSourceLabel: string | null = null;
  let contradiction: GroundingEvidence | null = null;

  for (const src of input.preparedSources) {
    let matched = 0;
    for (const t of sentenceSet) {
      if (src.tokens.has(t)) matched += 1;
    }
    const coverage = sentenceSet.size === 0 ? 0 : matched / sentenceSet.size;
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestSourceLabel = src.source.label;
    }
    if (coverage < EVIDENCE_FLOOR) continue;
    const excerptResult = findExcerpt(src.source.text, input.tokens);
    const excerpt = excerptResult !== null ? excerptResult.excerpt : "";
    const sourceNegations = collectNegations(
      excerptResult !== null ? excerptResult.excerpt : src.source.text.slice(0, 800),
    );
    const sourcePositives = sourceNegations.size === 0;
    let polarityMismatch = false;
    if (coverage >= input.partialThreshold) {
      if (sentencePositives !== sourcePositives) polarityMismatch = true;
    }
    const ev: GroundingEvidence = {
      sourceId: src.source.id,
      sourceKind: src.source.kind,
      sourceLabel: src.source.label,
      locator: src.source.locator,
      excerpt,
      matchedTokens: matched,
      coverage: round3(coverage),
    };
    if (polarityMismatch && (contradiction === null || ev.coverage > contradiction.coverage)) {
      contradiction = ev;
    }
    evidence.push(ev);
  }

  evidence.sort((a, b) => b.coverage - a.coverage);
  const polarityMismatch = contradiction !== null;

  let verdict: GroundingVerdict;
  let reason: string;
  if (polarityMismatch) {
    verdict = "contradicted";
    reason =
      `A source states the sentence with the opposite polarity (negation mismatch) at coverage ` +
      `${(contradiction?.coverage ?? 0) * 100 | 0}%.`;
  } else if (bestCoverage >= input.supportThreshold) {
    verdict = "grounded";
    reason =
      bestSourceLabel !== null
        ? `Matched ${(bestCoverage * 100).toFixed(0)}% of the sentence's content tokens against source "${bestSourceLabel}".`
        : "Matched the sentence against the supplied sources.";
  } else if (bestCoverage >= input.partialThreshold) {
    verdict = "partially-grounded";
    reason =
      `Matched ${(bestCoverage * 100).toFixed(0)}% of the sentence's content tokens; the sources do not fully state the assertion. A reviewer must confirm the framing.`;
  } else if (bestCoverage > 0) {
    verdict = "ungrounded";
    reason =
      `Matched only ${(bestCoverage * 100).toFixed(0)}% of the sentence's content tokens; the sources do not contain the assertion.`;
  } else {
    verdict = "ungrounded";
    reason = "None of the sentence's content tokens appear in any source. The sentence is not grounded.";
  }

  const overreach =
    absoluteMarkers.length > 0 &&
    (verdict === "partially-grounded" || verdict === "ungrounded" || verdict === "unknown");

  return {
    blockId: input.blockId,
    location: input.location,
    sentenceIndex: input.sentenceIndex,
    text: input.text,
    verdict,
    bestCoverage: round3(bestCoverage),
    evidence,
    reason,
    overreach,
    polarityMismatch,
  };
}

function unknownFinding(
  blockId: string,
  location: string,
  sentenceIndex: number,
  text: string,
): SentenceFinding {
  return {
    blockId,
    location,
    sentenceIndex,
    text,
    verdict: "unknown",
    bestCoverage: 0,
    evidence: [],
    reason: "The sentence is too short or contains no content tokens to verify.",
    overreach: false,
    polarityMismatch: false,
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

function readThreshold(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function readBlockKind(v: unknown): HallucinationBlockKind {
  return v === "paragraph" ||
    v === "list-item" ||
    v === "heading" ||
    v === "code" ||
    v === "callout" ||
    v === "table-cell"
    ? v
    : "paragraph";
}

function readVerdict(v: unknown): GroundingVerdict {
  return v === "grounded" ||
    v === "partially-grounded" ||
    v === "ungrounded" ||
    v === "contradicted" ||
    v === "non-claim" ||
    v === "unknown"
    ? v
    : "unknown";
}

function readSourceKind(v: unknown): FactCheckSource["kind"] {
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

/* -------------------------------------------------------------------------- */
/* Rehydrate readers                                                           */
/* -------------------------------------------------------------------------- */

function readEvidence(v: unknown): readonly GroundingEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: GroundingEvidence[] = [];
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
    });
  }
  return out;
}

function readFindings(v: unknown): readonly SentenceFinding[] {
  if (!Array.isArray(v)) return [];
  const out: SentenceFinding[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    out.push({
      blockId: typeof o["blockId"] === "string" ? o["blockId"] : "",
      location: typeof o["location"] === "string" ? o["location"] : "",
      sentenceIndex:
        typeof o["sentenceIndex"] === "number" && Number.isFinite(o["sentenceIndex"])
          ? Math.max(0, Math.floor(o["sentenceIndex"]))
          : 0,
      text: typeof o["text"] === "string" ? o["text"] : "",
      verdict: readVerdict(o["verdict"]),
      bestCoverage:
        typeof o["bestCoverage"] === "number" && Number.isFinite(o["bestCoverage"])
          ? o["bestCoverage"]
          : 0,
      evidence: readEvidence(o["evidence"]),
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
      overreach: o["overreach"] === true,
      polarityMismatch: o["polarityMismatch"] === true,
    });
  }
  return out;
}

function readBlocks(v: unknown): readonly BlockReport[] {
  if (!Array.isArray(v)) return [];
  const out: BlockReport[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const disposition = o["disposition"];
    out.push({
      blockId: typeof o["blockId"] === "string" ? o["blockId"] : "",
      location: typeof o["location"] === "string" ? o["location"] : "",
      kind: readBlockKind(o["kind"]),
      findings: readFindings(o["findings"]),
      disposition: disposition === "non-claim" ? "non-claim" : "checked",
    });
  }
  return out;
}

function readNotes(v: unknown): readonly HallucinationNote[] {
  if (!Array.isArray(v)) return [];
  const out: HallucinationNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "no-sources" &&
      kind !== "sources-empty" &&
      kind !== "no-blocks" &&
      kind !== "live-url-unavailable" &&
      kind !== "live-url-loaded" &&
      kind !== "non-claim-block" &&
      kind !== "empty-block" &&
      kind !== "short-sentence" &&
      kind !== "empty-sentence" &&
      kind !== "threshold-explicit"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

function readSummary(v: unknown): HallucinationReport["summary"] {
  const fallback = {
    totalSentences: 0,
    grounded: 0,
    partiallyGrounded: 0,
    ungrounded: 0,
    contradicted: 0,
    nonClaim: 0,
    unknown: 0,
    overreach: 0,
    polarityMismatch: 0,
  };
  if (v === null || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  return {
    totalSentences: readInt(o["totalSentences"]),
    grounded: readInt(o["grounded"]),
    partiallyGrounded: readInt(o["partiallyGrounded"]),
    ungrounded: readInt(o["ungrounded"]),
    contradicted: readInt(o["contradicted"]),
    nonClaim: readInt(o["nonClaim"]),
    unknown: readInt(o["unknown"]),
    overreach: readInt(o["overreach"]),
    polarityMismatch: readInt(o["polarityMismatch"]),
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
  segmentProse,
  classifySentences,
  classifyBlock,
  evaluateSentence,
  collectNegations,
  readThreshold,
  round3,
  readFindings,
  readBlocks,
  readNotes,
  readSummary,
  EVIDENCE_FLOOR,
  MIN_SENTENCE_TOKENS,
  ABSOLUTE_MARKERS,
  NEGATIONS,
  NON_CLAIM_KINDS,
});
