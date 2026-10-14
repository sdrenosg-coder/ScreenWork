/**
 * Zipy AI — coverage gap detection.
 *
 * Conflict detection answers "do the sources disagree?". Gap detection answers
 * the complementary question: "does any source actually cover this step?" A
 * workflow synthesised from partial inputs will have steps that no source
 * supports; those steps are exactly the ones the LLM is most likely to
 * hallucinate. This module finds them, flags them for review, and (depending
 * on the caller's policy) marks them as candidates for AI generation — with
 * `needsGeneration: true` — or as blockers that must be filled by the user
 * before the workflow is publishable.
 *
 * What this module is, precisely:
 *  - Evidence-based. It does not invent a "canonical" step set to compare
 *    against. It enumerates the *actions* the sources describe (via the same
 *    text→action parsing `conflictDetect.ts` uses, plus the structured step
 *    items once the synthesis phase produces them), groups those actions by
 *    their target, and reports:
 *        - subjects described by zero sources (nothing supports this step),
 *        - subjects described by exactly one source (weak coverage; not a
 *          gap per se, but the reviewer sees it),
 *        - subjects that appear in the goal but not in any source.
 *
 *  - Deterministic. Same inputs, same parameters → same gap set, same order.
 *
 *  - Honest about its own confidence. A "gap" is inherently a heuristic: the
 *    caller may have supplied a text prompt whose wording we did not parse
 *    into an action, in which case a step described only there is invisible
 *    to this module. Every gap carries `basis` describing exactly how it was
 *    derived, and every report carries the parameters it used, so a reviewer
 *    can reason about false positives.
 *
 * What this module is NOT:
 *  - A completeness oracle. It does not claim "workflow is complete"; it
 *    claims "these specific subjects lack evidence in this working set".
 *  - A conflict detector. Overlap between sources is fine here; the two
 *    modules are deliberately separate so a caller can run gap detection
 *    without conflict detection and get a usable answer.
 *
 * Inputs:
 *  - `sources`: the same working set `conflictDetect.ts` consumes, so a
 *    caller runs both from one load.
 *  - `goal`: optional natural-language goal (typically the text-prompt
 *    source's parsed goal, or the operator's stated objective). When
 *    supplied, subjects mentioned in the goal but absent from every source
 *    produce gaps with `basis = "goal-not-covered"`.
 *  - `expectedSubjects`: optional list of subjects the caller already knows
 *    must be covered (e.g. the fields of a form template). A subject on this
 *    list with no source evidence is a gap with `basis = "expected-not-covered"`;
 *    this is the strongest signal and is used by the review UI to gate
 *    publishing.
 */

import type { ProvenanceIndex } from "@zipy/fusion/provenance";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type GapDetectErrorCode = "invalid-input" | "missing-provenance-index";

export class GapDetectError extends Error {
  readonly code: GapDetectErrorCode;
  constructor(message: string, code: GapDetectErrorCode) {
    super(message);
    this.name = "GapDetectError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface GapItemInput {
  readonly itemId: string;
  readonly kind: string;
  readonly content: unknown;
}

export interface GapSourceInput {
  readonly sourceId: string;
  readonly artifactId: string;
  readonly sourceType: string;
  readonly items: readonly GapItemInput[];
}

/**
 * How a gap was derived. Ordered roughly by how much weight the reviewer
 * should give it:
 *  - `expected-not-covered`: the caller declared this subject must be
 *    covered; no source mentions it. The strongest signal.
 *  - `goal-not-covered`: the operator's stated goal names this subject; no
 *    source mentions it.
 *  - `single-source-only`: exactly one source describes this subject. Not a
 *    gap by strict definition, but the reviewer may want to confirm the
 *    single source is authoritative.
 */
export const GAP_BASES = [
  "expected-not-covered",
  "goal-not-covered",
  "single-source-only",
] as const;
export type GapBasis = (typeof GAP_BASES)[number];

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export interface SubjectEvidence {
  readonly sourceId: string;
  readonly artifactId: string;
  readonly itemId: string;
  /** The literal text the subject was extracted from. */
  readonly text: string;
  /** Human-readable provenance line, e.g. "Onboarding.pdf p.4". */
  readonly citation: string;
}

export interface CoverageGap {
  readonly gapId: string;
  /** The subject (a normalised action target, or a goal keyword). */
  readonly subject: string;
  readonly displaySubject: string;
  readonly basis: GapBasis;
  /**
   * Sources that *do* mention this subject. Empty for
   * `expected-not-covered` and `goal-not-covered`; length 1 for
   * `single-source-only`.
   */
  readonly evidence: readonly SubjectEvidence[];
  /**
   * Which coverage-augmentation action the caller should offer. `"generate"`
   * when the caller has opted into AI generation for gaps; `"review"` when
   * the caller wants a human to fill the step. The module does not choose
   * this — the caller passes a policy — but the value is stored per gap so
   * the review UI can render a single button without re-deciding.
   */
  readonly needsAction: "generate" | "review";
  readonly notes: readonly string[];
}

export interface GapReport {
  readonly gaps: readonly CoverageGap[];
  readonly byBasis: Readonly<Record<GapBasis, number>>;
  /**
   * Subjects that appeared in at least one source AND are covered, exposed so
   * the review UI can render an "covered subjects" list without re-deriving
   * it (and for the caller's executive summaries).
   */
  readonly coveredSubjects: readonly string[];
  readonly sourceCount: number;
  readonly itemCount: number;
  readonly parameters: GapReportParameters;
  readonly generatedAt: string;
}

export interface GapReportParameters {
  readonly expectedSubjectsCount: number;
  readonly goalSubjectsCount: number;
  readonly singleSourcePolicy: "review" | "generate" | "ignore";
  readonly minSubjectLength: number;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface DetectGapsOptions {
  /**
   * Natural-language goal statement. Typically from the text-prompt source.
   * Subjects extracted from the goal but not covered by any source become
   * gaps. When omitted, this check is skipped.
   */
  readonly goal?: string | null;
  /**
   * Subjects the caller has declared must be covered. Case- and
   * punctuation-insensitive comparison; each entry is normalised the same way
   * the extractor normalises source subjects.
   */
  readonly expectedSubjects?: readonly string[] | null;
  /**
   * What to do with subjects covered by exactly one source. Default
   * `"review"`, which is the conservative choice: the reviewer sees them but
   * nothing is auto-generated. `"generate"` is appropriate when the operator
   * has explicitly asked for completeness at the cost of some hallucination
   * risk; `"ignore"` suppresses the report entry entirely.
   */
  readonly singleSourcePolicy?: "review" | "generate" | "ignore";
  /**
   * What to do with subjects that no source covers. Default `"review"`.
   * `"generate"` marks them as AI-generation candidates (used by the
   * auto-regeneration pipeline); `"review"` leaves the decision to a human.
   */
  readonly missingPolicy?: "generate" | "review";
  /**
   * Minimum length of a subject, after normalisation, to be considered.
   * Defaults to 3; anything shorter (e.g. "i", "ok") is noise.
   */
  readonly minSubjectLength?: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function detectGaps(
  sources: readonly GapSourceInput[],
  provenanceIndex: ProvenanceIndex,
  options: DetectGapsOptions = {},
): GapReport {
  if (!Array.isArray(sources)) {
    throw new GapDetectError("detectGaps requires an array of sources.", "invalid-input");
  }
  if (provenanceIndex === null || typeof provenanceIndex !== "object" || !provenanceIndex.byItemId) {
    throw new GapDetectError(
      "detectGaps requires a ProvenanceIndex (build one with buildProvenanceIndex).",
      "missing-provenance-index",
    );
  }

  const minSubjectLength = Math.max(1, Math.floor(options.minSubjectLength ?? 3));
  const singleSourcePolicy = options.singleSourcePolicy ?? "review";
  const missingPolicy = options.missingPolicy ?? "review";

  // ---- Collect per-subject evidence ---------------------------------------
  // A "subject" is a normalised action target ("save button", "email field").
  // Provenance and evidence excerpts are attached so the report can show
  // exactly which item produced each mention.
  const evidenceBySubject = new Map<string, SubjectEvidence[]>();
  const displaySubjectBySubject = new Map<string, string>();
  let itemCount = 0;

  for (const src of sources) {
    if (src === null || typeof src !== "object") {
      throw new GapDetectError("GapSourceInput entries must be objects.", "invalid-input");
    }
    if (typeof src.sourceId !== "string" || src.sourceId.length === 0) {
      throw new GapDetectError("GapSourceInput.sourceId is missing.", "invalid-input");
    }
    if (typeof src.artifactId !== "string" || src.artifactId.length === 0) {
      throw new GapDetectError(
        `GapSourceInput "${src.sourceId}" is missing artifactId.`,
        "invalid-input",
      );
    }
    for (const item of src.items) {
      if (item === null || typeof item !== "object") continue;
      itemCount += 1;
      const candidates = extractSubjects(item);
      for (const candidate of candidates) {
        const key = normalizeSubject(candidate.subject);
        if (key.length < minSubjectLength) continue;
        if (!displaySubjectBySubject.has(key)) {
          displaySubjectBySubject.set(key, candidate.display);
        }
        let bucket = evidenceBySubject.get(key);
        if (bucket === undefined) {
          bucket = [];
          evidenceBySubject.set(key, bucket);
        }
        bucket.push({
          sourceId: src.sourceId,
          artifactId: src.artifactId,
          itemId: item.itemId,
          text: candidate.excerpt,
          citation: citationFor(provenanceIndex, item.itemId, src.artifactId),
        });
      }
    }
  }

  // ---- Determine which subjects each source covers (distinct sourceIds) ---
  const sourceIdsBySubject = new Map<string, Set<string>>();
  for (const [key, bucket] of evidenceBySubject) {
    const set = new Set<string>();
    for (const e of bucket) set.add(e.sourceId);
    sourceIdsBySubject.set(key, set);
  }

  // ---- Assemble gaps ------------------------------------------------------
  const gaps: CoverageGap[] = [];
  const coveredSubjects: string[] = [];

  for (const [key, sourceSet] of sourceIdsBySubject) {
    const coverage = sourceSet.size;
    const displaySubject = displaySubjectBySubject.get(key) ?? key;
    if (coverage >= 2) {
      coveredSubjects.push(displaySubject);
      continue;
    }
    // Exactly one source covers it.
    if (singleSourcePolicy === "ignore") {
      coveredSubjects.push(displaySubject);
      continue;
    }
    const evidence = (evidenceBySubject.get(key) ?? []).slice();
    gaps.push({
      gapId: `single:${key}`,
      subject: key,
      displaySubject,
      basis: "single-source-only",
      evidence,
      needsAction: singleSourcePolicy === "generate" ? "generate" : "review",
      notes: [`Only source "${evidence[0]?.sourceId ?? "unknown"}" describes this subject.`],
    });
  }

  // ---- Goal subjects not covered -----------------------------------------
  const goalText = typeof options.goal === "string" ? options.goal : "";
  const goalSubjects = goalText.length > 0 ? extractGoalSubjects(goalText) : [];
  let goalSubjectsCount = 0;
  for (const gs of goalSubjects) {
    const key = normalizeSubject(gs);
    if (key.length < minSubjectLength) continue;
    goalSubjectsCount += 1;
    if (sourceIdsBySubject.has(key)) continue;
    if (gaps.some((g) => g.subject === key)) continue;
    gaps.push({
      gapId: `goal:${key}`,
      subject: key,
      displaySubject: gs,
      basis: "goal-not-covered",
      evidence: [],
      needsAction: missingPolicy,
      notes: ["Subject appears in the stated goal but no source mentions it."],
    });
  }

  // ---- Expected subjects not covered -------------------------------------
  const expected = Array.isArray(options.expectedSubjects) ? options.expectedSubjects : [];
  let expectedCount = 0;
  for (const raw of expected) {
    if (typeof raw !== "string") continue;
    const key = normalizeSubject(raw);
    if (key.length < minSubjectLength) continue;
    expectedCount += 1;
    if (sourceIdsBySubject.has(key)) continue;
    if (gaps.some((g) => g.subject === key)) continue;
    gaps.push({
      gapId: `expected:${key}`,
      subject: key,
      displaySubject: raw,
      basis: "expected-not-covered",
      evidence: [],
      needsAction: "review",
      notes: ["Caller declared this subject must be covered; no source mentions it."],
    });
  }

  // ---- Deterministic sort -------------------------------------------------
  // Priority: basis (expected > goal > single), then subject lexicographically.
  // The order is stable across runs and independent of Map iteration.
  const basisRank: Record<GapBasis, number> = {
    "expected-not-covered": 0,
    "goal-not-covered": 1,
    "single-source-only": 2,
  };
  gaps.sort((a, b) => {
    const ra = basisRank[a.basis];
    const rb = basisRank[b.basis];
    if (ra !== rb) return ra - rb;
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    return 0;
  });

  coveredSubjects.sort();

  const byBasis: Record<GapBasis, number> = {
    "expected-not-covered": 0,
    "goal-not-covered": 0,
    "single-source-only": 0,
  };
  for (const g of gaps) byBasis[g.basis] += 1;

  return {
    gaps,
    byBasis,
    coveredSubjects,
    sourceCount: sources.length,
    itemCount,
    parameters: {
      expectedSubjectsCount: expectedCount,
      goalSubjectsCount,
      singleSourcePolicy,
      minSubjectLength,
    },
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Subject extraction                                                          */
/* -------------------------------------------------------------------------- */

interface SubjectCandidate {
  /** Normalised comparison key. */
  readonly subject: string;
  /** Human-readable form preserved from the source. */
  readonly display: string;
  /** Literal excerpt from the item this candidate came from. */
  readonly excerpt: string;
}

/**
 * Extract subjects from one item. Different item kinds yield subjects from
 * different fields:
 *  - `ui-element`: its label (a button named "Save" is a subject).
 *  - `transcript-segment`: parsed action targets ("click Save" → "Save").
 *  - `step` (synthesis-phase items): the action's target label.
 *  - `page-text` / `plain-text`: parsed action targets, same as transcripts.
 *  - `table-cell`: not treated as a subject (cells are data, not steps).
 */
function extractSubjects(item: GapItemInput): readonly SubjectCandidate[] {
  switch (item.kind) {
    case "ui-element": {
      const value = readValue(item.content);
      if (value === null) return [];
      const label = typeof value["label"] === "string" ? (value["label"] as string) : "";
      if (label.trim().length === 0) return [];
      return [{ subject: label, display: label, excerpt: label }];
    }
    case "transcript-segment":
    case "page-text":
    case "plain-text": {
      const value = readValue(item.content);
      if (value === null) return [];
      const text = typeof value["text"] === "string" ? (value["text"] as string) : "";
      if (text.trim().length === 0) return [];
      const parsed = parseActionFromText(text);
      if (parsed === null) return [];
      return [
        {
          subject: parsed.target,
          display: parsed.target,
          excerpt: text.trim(),
        },
      ];
    }
    case "step": {
      const value = readValue(item.content);
      if (value === null) return [];
      const target =
        typeof value["targetLabel"] === "string"
          ? (value["targetLabel"] as string)
          : typeof value["target"] === "string"
            ? (value["target"] as string)
            : "";
      if (target.trim().length === 0) return [];
      return [{ subject: target, display: target, excerpt: target.trim() }];
    }
    default:
      return [];
  }
}

/**
 * Extract subjects from a goal statement. Extracts noun phrases following the
 * action verbs the product ships with ("create a customer" → "customer"), and
 * falls back to significant tokens (len >= 4, not stop words) so a short goal
 * still yields something comparable.
 *
 * The goal-subject policy is deliberately permissive: a false positive here
 * yields a "goal-not-covered" gap, which is *safe* (the reviewer just sees an
 * extra entry) whereas a false negative would hide a genuine gap.
 */
function extractGoalSubjects(goal: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Verb-led extraction: `create a customer` → `customer`; `update the
  // customer's email` → `email` and `customer`.
  const verbLed = /\b(?:create|add|update|edit|delete|remove|open|close|submit|save|cancel|invite|remove|assign|grant|revoke|enable|disable|configure|set|import|export|upload|download|search)\b\s+(?:a|an|the|new)?\s*([a-zA-Z][a-zA-Z0-9'_-]*(?:\s+[a-zA-Z][a-zA-Z0-9'_-]*){0,3})/gi;
  let m: RegExpExecArray | null;
  while ((m = verbLed.exec(goal)) !== null) {
    const phrase = (m[1] ?? "").trim();
    if (phrase.length === 0) continue;
    // Take the trailing noun as the subject (the last token in the phrase)
    // and the whole phrase as a secondary subject, since both are commonly
    // useful for gap comparison ("customer email" and "email").
    const lastWord = phrase.split(/\s+/).pop() ?? "";
    for (const candidate of [phrase, lastWord]) {
      const key = normalizeSubject(candidate);
      if (key.length < 3 || seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
  }
  if (out.length > 0) return out;

  // Fallback: non-stop-word tokens of length >= 4.
  for (const token of goal.split(/[^A-Za-z0-9]+/)) {
    const lower = token.toLowerCase();
    if (lower.length < 4 || STOP_WORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(token);
  }
  return out;
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "this",
  "that",
  "these",
  "those",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "can",
  "could",
  "should",
  "would",
  "will",
  "may",
  "might",
  "any",
  "all",
  "some",
  "each",
  "user",
  "users",
  "you",
  "your",
  "our",
  "their",
  "them",
  "they",
  "please",
  "then",
  "than",
  "when",
  "where",
  "what",
  "which",
  "how",
  "why",
]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function readValue(content: unknown): Record<string, unknown> | null {
  if (content === null || typeof content !== "object") return null;
  const o = content as Record<string, unknown>;
  const v = o["value"];
  if (v !== null && typeof v === "object") return v as Record<string, unknown>;
  return o;
}

function parseActionFromText(text: string): { readonly action: string; readonly target: string } | null {
  const t = text.trim();
  if (t.length === 0) return null;
  const m = /^\s*(click|press|select|open|tap|choose)\s+(?:the\s+)?([A-Za-z0-9][^.,;!?]{0,63})/i.exec(t);
  if (m === null) return null;
  return { action: (m[1] as string).toLowerCase(), target: (m[2] as string).trim().toLowerCase() };
}

function normalizeSubject(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function citationFor(
  index: ProvenanceIndex,
  itemId: string,
  fallbackArtifactId: string,
): string {
  const entry = index.byItemId.get(itemId);
  if (entry === undefined) return `${fallbackArtifactId} [unresolved]`;
  const n = entry.normalized;
  const parts: string[] = [n.artifactId];
  if (n.pageIndex !== null) parts.push(`p.${n.pageIndex + 1}`);
  if (n.timeRange !== null) {
    parts.push(`${formatMs(n.timeRange.startMs)}–${formatMs(n.timeRange.endMs)}`);
  }
  if (n.bbox !== null) parts.push(`@ (${Math.round(n.bbox.x)},${Math.round(n.bbox.y)})`);
  return parts.join(" ");
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (v: number) => v.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
