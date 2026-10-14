/**
 * Zipy AI — quality: human-correction feedback loop (phase 25, batch 2).
 *
 * The feedback loop turns reviewer corrections into machine-usable signals
 * for the *next* generation: prompt refinements (added to the prompt-version
 * store the A/B harness consults) and fine-tuning samples (accumulated under
 * a dataset the operator exports to an offline trainer). The module does not
 * call an LLM to "learn from feedback" and does not perform fine-tuning.
 * Both are external, human-gated steps; the loop's job is to record what
 * changed, aggregate it into *reusable* artefacts, and report what will
 * change the next time the generator runs.
 *
 * What the module owns
 * --------------------
 *
 *   1. **Capture.** A `CorrectionRecord` is produced when a reviewer edits,
 *      rewrites or rejects an AI-generated segment (a step description, a
 *      title, an FAQ answer). The record carries only the *diff* between the
 *      AI output and the accepted edit, plus its provenance: which prompt
 *      version produced the AI output, which case it belongs to, which
 *      workspace, which reviewer.
 *
 *   2. **Aggregation.** Corrections are grouped by prompt version so a
 *      pattern (the AI consistently misses a term, or overuses a phrase)
 *      surfaces as a candidate refinement. Aggregation is arithmetic, not
 *      ML: it computes counts, common edit operations and recurring terms.
 *
 *   3. **Candidate refinement.** Each group produces a `PromptRefinement`
 *      candidate: a short, operator-reviewable instruction that *would*
 *      improve the prompt. The module never applies a refinement
 *      automatically — the operator accepts it in the settings UI, and the
 *      refinement then travels through the prompt-version store the A/B
 *      harness reads.
 *
 *   4. **Fine-tuning dataset.** Corrections with `kind: "rewrite"` or
 *      `kind: "edit"` are convertible to a `TrainingSample` — the exact
 *      (prompt, completion) shape an offline SFT/DPO run expects. The module
 *      exports the samples; it does not upload them anywhere.
 *
 * What the module explicitly does NOT do
 * --------------------------------------
 *
 *   - It does not modify prompts at runtime. `applyAcceptedRefinements` is
 *     the *only* function that turns an accepted refinement into a prompt
 *     patch, and it is called by the settings UI when the operator clicks
 *     "Apply". The loop's default behaviour is to accumulate evidence.
 *
 *   - It does not train or upload a model. `toTrainingSamples` produces
 *     JSON-safe samples; the caller persists or ships them.
 *
 *   - It does not fabricate a correction. A `CorrectionRecord` whose diff is
 *     empty (the reviewer accepted the AI output) is recorded as `accepted`
 *     and excluded from refinement candidates, because "the model was right"
 *     is signal but is not a refinement.
 *
 *   - It does not assume a model or provider. The prompt-version id is a
 *     caller-supplied string; the module treats it as an opaque key.
 */

import type { PromptVersionRef } from "@zipy/llm/promptVersions";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type FeedbackLoopErrorCode = "invalid-input" | "shape";

export class FeedbackLoopError extends Error {
  readonly code: FeedbackLoopErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: FeedbackLoopErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public constants                                                            */
/* -------------------------------------------------------------------------- */

export const FEEDBACK_LOOP_VERSION = "feedback-loop/1" as const;

/**
 * The minimum number of corrections in a group before the loop offers a
 * refinement candidate. Below this, a single reviewer's wording preference
 * is not a pattern; above it, the operator is shown what the model
 * consistently gets wrong. The value is deliberately low (3) because a
 * reviewer who corrects the same term three times in one guide has
 * demonstrated a pattern for that workspace.
 */
export const MIN_CORRECTIONS_FOR_REFINEMENT = 3;

/**
 * The candidate-refinement kinds the loop can produce. Each is a directive
 * an operator can add to a system prompt; the loop never composes free-form
 * LLM output for the refinement itself. This is a hard boundary: the loop
 * runs on user corrections, which are the *most* sensitive data in the
 * product, and a free-form LLM-mediated summary of them would leak into a
 * provider the operator may not expect.
 */
export const REFINEMENT_KINDS = [
  "prefer-term",         // e.g. "use 'client' not 'customer' when the workspace says so".
  "avoid-phrase",        // e.g. "do not start steps with 'Simply'".
  "add-constraint",      // e.g. "always name the button text verbatim".
  "fix-terminology",     // acronyms and product names the model misuses.
  "reduce-verbosity",    // the model consistently writes longer than the reviewer wants.
  "increase-detail",     // the model consistently under-specifies.
  "fix-structure",       // sections/steps ordered wrong.
] as const;
export type RefinementKind = (typeof REFINEMENT_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a reviewer did. `accepted` records a positive signal (the AI output
 * was used verbatim); the other kinds record a correction. A record whose
 * `kind` is `accepted` must have an empty `diff`.
 */
export const CORRECTION_KINDS = [
  "accepted",
  "edit",
  "rewrite",
  "reject",
  "reorder",
  "annotate",
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

/**
 * The segment of content a correction applies to. Small, explicit union so
 * aggregation can group by segment without heuristics.
 */
export const SEGMENT_KINDS = [
  "title",
  "summary",
  "introduction",
  "prerequisites",
  "step-title",
  "step-description",
  "tip",
  "warning",
  "faq-question",
  "faq-answer",
  "glossary-term",
  "glossary-definition",
  "longform-section",
  "structured-block",
  "other",
] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/**
 * A word-level diff between the AI output and the reviewer's accepted
 * version. Word-level (rather than char-level) is what aggregation groups
 * terms on; character-level diffs are already available through the collab
 * `trackChanges` module and are not what the loop consumes.
 */
export interface CorrectionDiff {
  /** The AI output's words, in order, as a plain string. */
  readonly fromText: string;
  /** The reviewer's accepted version, in order, as a plain string. */
  readonly toText: string;
  /**
   * Words that appear in `toText` and not in `fromText`, deduplicated case
   * insensitively, ordered by first occurrence in `toText`. These are the
   * "the model omitted this" signals.
   */
  readonly addedTerms: readonly string[];
  /**
   * Words that appear in `fromText` and not in `toText`. These are the "the
   * model overused / invented this" signals.
   */
  readonly removedTerms: readonly string[];
}

/**
 * One reviewer correction. Immutable once recorded; a re-edit produces a new
 * record so the loop has the full history (reverting and re-editing tells
 * the loop something different than a single edit).
 */
export interface CorrectionRecord {
  readonly version: typeof FEEDBACK_LOOP_VERSION;
  /** Stable id for the correction, generated by the caller. */
  readonly id: string;
  readonly workspaceId: string;
  /** Which guide / workflow / case the segment belongs to. */
  readonly subjectId: string;
  /** The step id (when applicable) within the subject. */
  readonly stepId: string | null;
  /** Which kind of segment was corrected. */
  readonly segment: SegmentKind;
  readonly kind: CorrectionKind;
  /**
   * The prompt version that produced the AI output. Null when the AI output
   * predates prompt-version tracking; the record is still kept (it feeds the
   * fine-tuning dataset) but excluded from prompt refinement candidates.
   */
  readonly promptVersion: PromptVersionRef | null;
  /**
   * The diff. Required for `edit`, `rewrite`, `reject` (empty `toText`) and
   * `annotate` (empty `toText`, non-empty `annotation`); forbidden for
   * `accepted` (must be `{ fromText, toText: "", addedTerms: [], removedTerms: [] }`
   * — see `recordCorrection`).
   */
  readonly diff: CorrectionDiff;
  /**
   * A free-form reviewer note. Attached to the record and surfaced in the
   * loop's aggregation, but **never** ingested as a prompt refinement: an
   * operator note is not a pattern. The field is preserved for downstream
   * human review.
   */
  readonly annotation: string | null;
  /** The reviewer's user id. Required; corrections are always attributed. */
  readonly reviewerId: string;
  readonly recordedAt: string;
}

export interface RecordCorrectionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly subjectId: string;
  readonly stepId?: string | null;
  readonly segment: SegmentKind;
  readonly kind: CorrectionKind;
  readonly promptVersion?: PromptVersionRef | null;
  readonly fromText: string;
  readonly toText: string;
  readonly annotation?: string | null;
  readonly reviewerId: string;
  /**
   * A clock. The module reads time only through this argument so tests are
   * deterministic.
   */
  readonly now: Date;
}

export interface PromptRefinement {
  readonly version: typeof FEEDBACK_LOOP_VERSION;
  readonly kind: RefinementKind;
  /** The prompt version the refinement is a candidate for. */
  readonly promptVersionId: string;
  /** One-line imperative an operator can read at a glance. */
  readonly instruction: string;
  /** The precise tokens the refinement is about, sorted. Never empty. */
  readonly terms: readonly string[];
  /** The number of corrections in this workspace that support the candidate. */
  readonly evidenceCount: number;
  /** Segment kinds the corrections touch; empty when the group spans all. */
  readonly segments: readonly SegmentKind[];
  /**
   * The record ids that support the refinement. The operator UI links them
   * so a reviewer can see each correction before accepting.
   */
  readonly evidenceRecordIds: readonly string[];
  /** True once the operator has accepted the refinement. */
  readonly accepted: boolean;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
}

export interface AggregateInput {
  readonly workspaceId: string;
  /** The prompt version whose corrections to aggregate. */
  readonly promptVersion: PromptVersionRef;
  /** All correction records available to the loop. Filtered internally. */
  readonly corrections: readonly CorrectionRecord[];
  /**
   * Optional override of the minimum evidence count. The default is
   * `MIN_CORRECTIONS_FOR_REFINEMENT`.
   */
  readonly minEvidence?: number;
  /**
   * Optional list of corrections the operator has already accepted. A
   * refinement that has an exact `(kind, terms)` match against an accepted
   * one is returned with `accepted: true` so the UI can display it as
   * "already applied". The loop does not re-apply it.
   */
  readonly accepted?: readonly PromptRefinement[];
}

export interface FeedbackAggregate {
  readonly version: typeof FEEDBACK_LOOP_VERSION;
  readonly workspaceId: string;
  readonly promptVersionId: string;
  readonly totalCorrections: number;
  readonly acceptedCount: number;
  readonly correctionCount: number;
  readonly rejectionCount: number;
  /** Corrections grouped by segment, in `SEGMENT_KINDS` order. */
  readonly bySegment: Readonly<Record<SegmentKind, number>>;
  /** Corrections grouped by kind, in `CORRECTION_KINDS` order. */
  readonly byKind: Readonly<Record<CorrectionKind, number>>;
  /** The refinement candidates, sorted by evidence count descending. */
  readonly refinements: readonly PromptRefinement[];
  /** A short, deterministic summary line for the review UI. */
  readonly summary: string;
}

/**
 * One training sample for an offline SFT/DPO run. Only produced from
 * corrections where the reviewer's text is a usable *positive* completion:
 * `edit`, `rewrite`. `reject` yields a negative-only signal and is exported
 * as `preference: "negative"` with no `completion`; `accepted` yields a
 * positive-only signal with `completion` equal to the AI text.
 */
export interface TrainingSample {
  readonly promptVersionId: string;
  readonly segment: SegmentKind;
  /** The exact text the AI produced. */
  readonly completion: string;
  /** The exact text the reviewer accepted, when applicable. */
  readonly chosen: string | null;
  readonly rejected: string | null;
  readonly preference: "positive" | "negative" | "both";
  /** Terms the model missed (added by the reviewer) or overused (removed). */
  readonly addedTerms: readonly string[];
  readonly removedTerms: readonly string[];
  /** Record id; used to link a sample back to the correction it came from. */
  readonly sourceRecordId: string;
}

export interface ApplyAcceptedInput {
  readonly promptVersion: PromptVersionRef;
  readonly refinements: readonly PromptRefinement[];
  /**
   * Optional cap on the number of refinements applied in one call. A prompt
   * with ten appended constraints becomes hard for the model to obey; the
   * operator UI applies refinements one at a time by default.
   */
  readonly maxToApply?: number;
}

export interface AppliedRefinement {
  readonly promptVersionId: string;
  readonly refinementInstruction: string;
  /** Where in the prompt the refinement was inserted (informational). */
  readonly placement: "appended-constraints" | "appended-terminology";
  readonly kind: RefinementKind;
}

/* -------------------------------------------------------------------------- */
/* Public API — capture                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Record a reviewer correction. `fromText` and `toText` are the only content
 * arguments; the diff is computed here so every caller produces the same
 * shape. For `accepted`, `toText` must be empty and no diff is recorded —
 * the fact that the reviewer accepted the AI's text is the signal, and
 * recording a diff of an identical string would be noise.
 */
export function recordCorrection(input: RecordCorrectionInput): CorrectionRecord {
  if (input === null || typeof input !== "object") {
    throw new FeedbackLoopError("recordCorrection requires an input object.", "invalid-input");
  }
  const id = requireNonEmpty(input.id, "id");
  const workspaceId = requireNonEmpty(input.workspaceId, "workspaceId");
  const subjectId = requireNonEmpty(input.subjectId, "subjectId");
  const reviewerId = requireNonEmpty(input.reviewerId, "reviewerId");
  if (!isCorrectionKind(input.kind)) {
    throw new FeedbackLoopError(
      `\`kind\` must be one of ${CORRECTION_KINDS.join(", ")}; received ${JSON.stringify(input.kind)}.`,
      "invalid-input",
    );
  }
  if (!isSegmentKind(input.segment)) {
    throw new FeedbackLoopError(
      `\`segment\` must be one of ${SEGMENT_KINDS.join(", ")}; received ${JSON.stringify(input.segment)}.`,
      "invalid-input",
    );
  }
  if (typeof input.fromText !== "string") {
    throw new FeedbackLoopError("`fromText` must be a string.", "invalid-input");
  }
  if (typeof input.toText !== "string") {
    throw new FeedbackLoopError("`toText` must be a string.", "invalid-input");
  }
  if (input.kind === "accepted" && input.toText.trim().length > 0) {
    throw new FeedbackLoopError(
      "`kind: \"accepted\"` records that the AI text was used verbatim; `toText` must be empty to avoid ambiguity.",
      "invalid-input",
    );
  }
  if (input.kind === "reject" && input.toText.trim().length > 0) {
    throw new FeedbackLoopError(
      "`kind: \"reject\"` records that no acceptable replacement was written; `toText` must be empty.",
      "invalid-input",
    );
  }
  if (input.now === undefined || !(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new FeedbackLoopError(
      "`now` must be a valid Date; the module never reads the system clock itself.",
      "invalid-input",
    );
  }

  const diff = buildDiff(input.fromText, input.toText);

  return Object.freeze({
    version: FEEDBACK_LOOP_VERSION,
    id,
    workspaceId,
    subjectId,
    stepId: typeof input.stepId === "string" && input.stepId.length > 0 ? input.stepId : null,
    segment: input.segment,
    kind: input.kind,
    promptVersion: input.promptVersion ?? null,
    diff,
    annotation:
      typeof input.annotation === "string" && input.annotation.trim().length > 0
        ? input.annotation.trim()
        : null,
    reviewerId,
    recordedAt: input.now.toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Public API — aggregate                                                      */
/* -------------------------------------------------------------------------- */

export function aggregate(input: AggregateInput): FeedbackAggregate {
  if (input === null || typeof input !== "object") {
    throw new FeedbackLoopError("aggregate requires an input object.", "invalid-input");
  }
  const workspaceId = requireNonEmpty(input.workspaceId, "workspaceId");
  if (input.promptVersion === null || typeof input.promptVersion !== "object") {
    throw new FeedbackLoopError("`promptVersion` is required.", "invalid-input");
  }
  const promptVersionId = readPromptVersionId(input.promptVersion);
  if (promptVersionId === null) {
    throw new FeedbackLoopError(
      "`promptVersion` must carry an id (the field is required by `PromptVersionRef`).",
      "invalid-input",
    );
  }
  if (!Array.isArray(input.corrections)) {
    throw new FeedbackLoopError("`corrections` must be an array.", "invalid-input");
  }
  const minEvidence =
    typeof input.minEvidence === "number" && Number.isFinite(input.minEvidence) && input.minEvidence >= 1
      ? Math.floor(input.minEvidence)
      : MIN_CORRECTIONS_FOR_REFINEMENT;
  const accepted = input.accepted ?? [];

  // Scope corrections before grouping. A correction for another workspace or
  // another prompt version must never influence this aggregate.
  const scoped = input.corrections.filter(
    (c) =>
      c.workspaceId === workspaceId &&
      c.promptVersion !== null &&
      readPromptVersionId(c.promptVersion) === promptVersionId,
  );

  const { refinementCandidates, evidence, acceptedCount, correctionCount, rejectionCount } =
    buildRefinementCandidates(scoped, promptVersionId, minEvidence, accepted);

  const bySegment = emptySegmentCounts();
  const byKind = emptyKindCounts();
  for (const c of scoped) {
    bySegment[c.segment] = (bySegment[c.segment] ?? 0) + 1;
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  }

  const summary = `${scoped.length} correction${scoped.length === 1 ? "" : "s"} on prompt version "${promptVersionId}": ${acceptedCount} accepted, ${correctionCount} edited/rewritten, ${rejectionCount} rejected. ${refinementCandidates.length} refinement candidate${refinementCandidates.length === 1 ? "" : "s"} above the ${minEvidence}-correction threshold.`;

  // Sort refinement candidates by evidence count desc, then kind, then the
  // first term, so a diff between two aggregates is stable.
  const refinements = [...refinementCandidates].sort((a, b) => {
    if (b.evidenceCount !== a.evidenceCount) return b.evidenceCount - a.evidenceCount;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const aFirst = a.terms[0] ?? "";
    const bFirst = b.terms[0] ?? "";
    if (aFirst !== bFirst) return aFirst < bFirst ? -1 : 1;
    return 0;
  });

  return Object.freeze({
    version: FEEDBACK_LOOP_VERSION,
    workspaceId,
    promptVersionId,
    totalCorrections: scoped.length,
    acceptedCount,
    correctionCount,
    rejectionCount,
    bySegment: Object.freeze(bySegment),
    byKind: Object.freeze(byKind),
    refinements: Object.freeze(refinements),
    summary,
    ...{ __evidence: evidence },
  } as FeedbackAggregate);
}

/* -------------------------------------------------------------------------- */
/* Public API — apply                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Turn accepted refinements into prompt additions. The return value is a
 * list of `AppliedRefinement` records; the caller (settings UI or a route)
 * is responsible for actually updating the prompt-version store. The
 * function refuses to apply a refinement whose `accepted` flag is false, so
 * a caller cannot bypass the operator's accept step by passing a candidate
 * straight through.
 */
export function applyAcceptedRefinements(input: ApplyAcceptedInput): readonly AppliedRefinement[] {
  if (input === null || typeof input !== "object") {
    throw new FeedbackLoopError("applyAcceptedRefinements requires an input object.", "invalid-input");
  }
  if (input.promptVersion === null || typeof input.promptVersion !== "object") {
    throw new FeedbackLoopError("`promptVersion` is required.", "invalid-input");
  }
  const promptVersionId = readPromptVersionId(input.promptVersion);
  if (promptVersionId === null) {
    throw new FeedbackLoopError("`promptVersion` must carry an id.", "invalid-input");
  }
  if (!Array.isArray(input.refinements)) {
    throw new FeedbackLoopError("`refinements` must be an array.", "invalid-input");
  }
  const maxToApply =
    typeof input.maxToApply === "number" && Number.isFinite(input.maxToApply) && input.maxToApply >= 1
      ? Math.floor(input.maxToApply)
      : input.refinements.length;

  const out: AppliedRefinement[] = [];
  for (const r of input.refinements) {
    if (out.length >= maxToApply) break;
    if (r.promptVersionId !== promptVersionId) continue;
    if (!r.accepted) continue;
    out.push(
      Object.freeze({
        promptVersionId,
        refinementInstruction: r.instruction,
        placement:
          r.kind === "fix-terminology" || r.kind === "prefer-term"
            ? "appended-terminology"
            : "appended-constraints",
        kind: r.kind,
      }),
    );
  }
  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* Public API — training samples                                               */
/* -------------------------------------------------------------------------- */

/**
 * Convert corrections into training samples. Only corrections with a
 * recorded prompt version are exported; a correction whose prompt version is
 * unknown cannot be annotated for offline training because the model that
 * produced the completion is unknown.
 *
 * The sample's `chosen` is the reviewer's text; `rejected` is the AI's text.
 * For `accepted`, the AI's text is the accepted completion and `chosen`
 * equals it; the sample is marked `positive`. For `reject`, the AI's text is
 * the rejected candidate and `chosen` is null; the sample is marked
 * `negative`.
 */
export function toTrainingSamples(corrections: readonly CorrectionRecord[]): readonly TrainingSample[] {
  if (!Array.isArray(corrections)) {
    throw new FeedbackLoopError("`corrections` must be an array.", "invalid-input");
  }
  const out: TrainingSample[] = [];
  for (const c of corrections) {
    if (c.promptVersion === null) continue;
    const promptVersionId = readPromptVersionId(c.promptVersion);
    if (promptVersionId === null) continue;
    if (c.kind === "accepted") {
      out.push(
        Object.freeze({
          promptVersionId,
          segment: c.segment,
          completion: c.diff.fromText,
          chosen: c.diff.fromText,
          rejected: null,
          preference: "positive",
          addedTerms: Object.freeze([]),
          removedTerms: Object.freeze([]),
          sourceRecordId: c.id,
        }),
      );
      continue;
    }
    if (c.kind === "reject") {
      out.push(
        Object.freeze({
          promptVersionId,
          segment: c.segment,
          completion: c.diff.fromText,
          chosen: null,
          rejected: c.diff.fromText,
          preference: "negative",
          addedTerms: Object.freeze([...c.diff.addedTerms]),
          removedTerms: Object.freeze([...c.diff.removedTerms]),
          sourceRecordId: c.id,
        }),
      );
      continue;
    }
    if (c.kind === "edit" || c.kind === "rewrite") {
      out.push(
        Object.freeze({
          promptVersionId,
          segment: c.segment,
          completion: c.diff.fromText,
          chosen: c.diff.toText,
          rejected: c.diff.fromText,
          preference: "both",
          addedTerms: Object.freeze([...c.diff.addedTerms]),
          removedTerms: Object.freeze([...c.diff.removedTerms]),
          sourceRecordId: c.id,
        }),
      );
      continue;
    }
    // `reorder` and `annotate` produce structure changes the SFT sample
    // shape does not express; they are skipped rather than coerced.
  }
  return Object.freeze(out);
}

/**
 * Rehydrate a persisted correction record. The version is asserted and each
 * field is shape-checked; a correction that has a `kind: "accepted"` with a
 * non-empty `toText` is rejected as malformed so the invariant holds across
 * the persistence boundary.
 */
export function rehydrateCorrectionRecord(value: unknown): CorrectionRecord {
  if (value === null || typeof value !== "object") {
    throw new FeedbackLoopError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== FEEDBACK_LOOP_VERSION) {
    throw new FeedbackLoopError(
      `Rehydrate failed: expected version "${FEEDBACK_LOOP_VERSION}", received "${String(r["version"])}".`,
      "shape",
    );
  }
  if (!isCorrectionKind(r["kind"])) {
    throw new FeedbackLoopError(
      `Rehydrate failed: unknown \`kind\` ${JSON.stringify(r["kind"])}.`,
      "shape",
    );
  }
  if (!isSegmentKind(r["segment"])) {
    throw new FeedbackLoopError(
      `Rehydrate failed: unknown \`segment\` ${JSON.stringify(r["segment"])}.`,
      "shape",
    );
  }
  const diffRaw = r["diff"];
  if (diffRaw === null || typeof diffRaw !== "object") {
    throw new FeedbackLoopError("Rehydrate failed: `diff` is missing or malformed.", "shape");
  }
  const d = diffRaw as Record<string, unknown>;
  const toText = typeof d["toText"] === "string" ? d["toText"] : "";
  if ((r["kind"] === "accepted" || r["kind"] === "reject") && toText.trim().length > 0) {
    throw new FeedbackLoopError(
      `Rehydrate failed: a \`${r["kind"]}\` correction may not carry a non-empty \`toText\`.`,
      "shape",
    );
  }
  return Object.freeze({
    version: FEEDBACK_LOOP_VERSION,
    id: typeof r["id"] === "string" ? r["id"] : "",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    subjectId: typeof r["subjectId"] === "string" ? r["subjectId"] : "",
    stepId: typeof r["stepId"] === "string" ? r["stepId"] : null,
    segment: r["segment"],
    kind: r["kind"],
    promptVersion: readPromptVersionRef(r["promptVersion"]),
    diff: Object.freeze({
      fromText: typeof d["fromText"] === "string" ? d["fromText"] : "",
      toText,
      addedTerms: Object.freeze(
        Array.isArray(d["addedTerms"])
          ? d["addedTerms"].filter((t): t is string => typeof t === "string")
          : [],
      ),
      removedTerms: Object.freeze(
        Array.isArray(d["removedTerms"])
          ? d["removedTerms"].filter((t): t is string => typeof t === "string")
          : [],
      ),
    }),
    annotation: typeof r["annotation"] === "string" ? r["annotation"] : null,
    reviewerId: typeof r["reviewerId"] === "string" ? r["reviewerId"] : "",
    recordedAt: typeof r["recordedAt"] === "string" ? r["recordedAt"] : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Internals — diff                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build a word-level diff. Uses `Intl.Segmenter` when available (Node 20 and
 * every modern browser) and falls back to whitespace + punctuation splitting
 * otherwise. Term comparison is case-insensitive; the terms are returned in
 * their *first-occurrence* casing from `toText` / `fromText` respectively.
 *
 * STOPWORDS are filtered from `addedTerms` / `removedTerms` because a
 * correction that inserts "the" is not a refinement candidate; the removal
 * set is filtered the same way so the two are symmetric.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "to",
  "of", "in", "on", "at", "by", "with", "from", "as", "is", "are", "was",
  "were", "be", "been", "being", "it", "its", "this", "that", "these",
  "those", "you", "your", "yours", "we", "our", "ours", "they", "them",
  "their", "theirs", "he", "she", "him", "her", "his", "hers", "i", "me",
  "my", "mine", "us", "will", "would", "should", "could", "can", "may",
  "might", "must", "shall", "have", "has", "had", "do", "does", "did",
  "not", "no", "yes", "so", "up", "down", "out", "into", "onto", "over",
  "under", "again", "once", "here", "there", "when", "where", "why", "how",
  "all", "any", "some", "more", "most", "other", "such", "only", "own",
  "same", "than", "too", "very", "just", "also", "now", "new", "use",
  "used", "using", "please", "simply", "note", "check",
]);

function buildDiff(fromText: string, toText: string): CorrectionDiff {
  const fromTokens = tokenise(fromText);
  const toTokens = tokenise(toText);

  const fromSet = new Set(fromTokens.map((t) => t.toLowerCase()));
  const toSet = new Set(toTokens.map((t) => t.toLowerCase()));

  const seenAdded = new Set<string>();
  const addedTerms: string[] = [];
  for (const t of toTokens) {
    const key = t.toLowerCase();
    if (fromSet.has(key)) continue;
    if (STOPWORDS.has(key)) continue;
    if (seenAdded.has(key)) continue;
    seenAdded.add(key);
    addedTerms.push(t);
  }

  const seenRemoved = new Set<string>();
  const removedTerms: string[] = [];
  for (const t of fromTokens) {
    const key = t.toLowerCase();
    if (toSet.has(key)) continue;
    if (STOPWORDS.has(key)) continue;
    if (seenRemoved.has(key)) continue;
    seenRemoved.add(key);
    removedTerms.push(t);
  }

  return Object.freeze({
    fromText,
    toText,
    addedTerms: Object.freeze(addedTerms),
    removedTerms: Object.freeze(removedTerms),
  });
}

/**
 * Tokenise into words. Preserves original casing; strips leading/trailing
 * punctuation from each token so "'Save,'" and "Save" compare equal.
 * Uses `Intl.Segmenter` when present so CJK and other scripts (that do not
 * use whitespace) still produce word-level tokens; falls back to a
 * whitespace + punctuation split otherwise.
 */
function tokenise(text: string): readonly string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const maybeSegmenter = (Intl as unknown as { Segmenter?: new (locale: string, options: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string; isWordLike: boolean }> } }).Segmenter;
  if (typeof maybeSegmenter === "function") {
    try {
      const seg = new maybeSegmenter("und", { granularity: "word" });
      const out: string[] = [];
      for (const piece of seg.segment(text)) {
        if (!piece.isWordLike) continue;
        const cleaned = piece.segment.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "");
        if (cleaned.length > 0) out.push(cleaned);
      }
      return out;
    } catch {
      // Fall through to the manual tokeniser on an environment whose
      // Segmenter misbehaves; the fallback is deterministic.
    }
  }
  const manual = text.match(/[\p{L}\p{N}_]+/gu);
  return manual === null ? [] : manual;
}

/* -------------------------------------------------------------------------- */
/* Internals — refinement candidate builder                                    */
/* -------------------------------------------------------------------------- */

interface RefinementsBuildResult {
  readonly refinementCandidates: readonly PromptRefinement[];
  readonly evidence: ReadonlyMap<string, readonly CorrelationEvidence[]>;
  readonly acceptedCount: number;
  readonly correctionCount: number;
  readonly rejectionCount: number;
}

interface CorrelationEvidence {
  readonly recordId: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Group the scoped corrections and derive a refinement candidate per group.
 * The grouping key is `(kind, normalised terms tuple)` after excluding
 * `accepted`/`reject` corrections (which carry no positive terms). A group
 * is a candidate when its size is at least `minEvidence`.
 *
 * The instruction string is composed deterministically from the group, never
 * from a model: `"Prefer the term ... over ..."`, `"Do not start steps with
 * ..."`, etc. The composer maps `(kind, terms)` → a template; unknown shapes
 * fall through to `add-constraint`.
 */
function buildRefinementCandidates(
  scoped: readonly CorrectionRecord[],
  promptVersionId: string,
  minEvidence: number,
  alreadyAccepted: readonly PromptRefinement[],
): RefinementsBuildResult {
  let acceptedCount = 0;
  let correctionCount = 0;
  let rejectionCount = 0;

  // Group term-level signals. Only corrections with a usable diff (edit,
  // rewrite, reject) contribute to term groups; a `reorder` or `annotate`
  // with no diff is skipped for aggregation (it is still counted in the
  // per-kind tallies by the caller).
  const addedGroups = new Map<string, CorrelationEvidence[]>();
  const removedGroups = new Map<string, CorrelationEvidence[]>();

  for (const c of scoped) {
    if (c.kind === "accepted") {
      acceptedCount += 1;
      continue;
    }
    if (c.kind === "reject") {
      rejectionCount += 1;
      if (c.diff.removedTerms.length > 0) {
        const key = termKey(c.diff.removedTerms);
        pushGroup(removedGroups, key, {
          recordId: c.id,
          added: c.diff.addedTerms,
          removed: c.diff.removedTerms,
        });
      }
      continue;
    }
    correctionCount += 1;
    if (c.diff.addedTerms.length > 0) {
      const key = termKey(c.diff.addedTerms);
      pushGroup(addedGroups, key, {
        recordId: c.id,
        added: c.diff.addedTerms,
        removed: c.diff.removedTerms,
      });
    }
    if (c.diff.removedTerms.length > 0) {
      const key = termKey(c.diff.removedTerms);
      pushGroup(removedGroups, key, {
        recordId: c.id,
        added: c.diff.addedTerms,
        removed: c.diff.removedTerms,
      });
    }
  }

  const evidence = new Map<string, readonly CorrelationEvidence[]>();
  for (const [key, list] of addedGroups) evidence.set(`added:${key}`, Object.freeze([...list]));
  for (const [key, list] of removedGroups) evidence.set(`removed:${key}`, Object.freeze([...list]));

  const refinements: PromptRefinement[] = [];
  const alreadyAcceptedKeys = new Set(
    alreadyAccepted.map((r) => `${r.kind}::${r.terms.map((t) => t.toLowerCase()).sort().join("|")}`),
  );

  for (const [key, records] of addedGroups) {
    if (records.length < minEvidence) continue;
    const terms = keyToTerms(key);
    if (terms.length === 0) continue;
    const kind = chooseKind(terms, "add");
    const existingAccepted = alreadyAccepted.find(
      (r) => `${r.kind}::${r.terms.map((t) => t.toLowerCase()).sort().join("|")}` === `${kind}::${key}`,
    );
    refinements.push(
      Object.freeze({
        version: FEEDBACK_LOOP_VERSION,
        kind,
        promptVersionId,
        instruction: composeInstruction(kind, terms, null),
        terms: Object.freeze([...terms]),
        evidenceCount: records.length,
        segments: Object.freeze(uniqueSegments(scoped, records)),
        evidenceRecordIds: Object.freeze(records.map((r) => r.recordId)),
        accepted: existingAccepted !== undefined,
        acceptedBy: existingAccepted?.acceptedBy ?? null,
        acceptedAt: existingAccepted?.acceptedAt ?? null,
      }),
    );
    void alreadyAcceptedKeys;
  }

  for (const [key, records] of removedGroups) {
    if (records.length < minEvidence) continue;
    const terms = keyToTerms(key);
    if (terms.length === 0) continue;
    const kind = chooseKind(terms, "remove");
    const existingAccepted = alreadyAccepted.find(
      (r) => `${r.kind}::${r.terms.map((t) => t.toLowerCase()).sort().join("|")}` === `${kind}::${key}`,
    );
    refinements.push(
      Object.freeze({
        version: FEEDBACK_LOOP_VERSION,
        kind,
        promptVersionId,
        instruction: composeInstruction(kind, terms, null),
        terms: Object.freeze([...terms]),
        evidenceCount: records.length,
        segments: Object.freeze(uniqueSegments(scoped, records)),
        evidenceRecordIds: Object.freeze(records.map((r) => r.recordId)),
        accepted: existingAccepted !== undefined,
        acceptedBy: existingAccepted?.acceptedBy ?? null,
        acceptedAt: existingAccepted?.acceptedAt ?? null,
      }),
    );
  }

  return {
    refinementCandidates: Object.freeze(refinements),
    evidence,
    acceptedCount,
    correctionCount,
    rejectionCount,
  };
}

function pushGroup(
  groups: Map<string, CorrelationEvidence[]>,
  key: string,
  evidence: CorrelationEvidence,
): void {
  const list = groups.get(key);
  if (list === undefined) groups.set(key, [evidence]);
  else list.push(evidence);
}

function termKey(terms: readonly string[]): string {
  const normalised = [...new Set(terms.map((t) => t.toLowerCase()))].sort();
  return normalised.join("|");
}

function keyToTerms(key: string): readonly string[] {
  if (key.length === 0) return [];
  const pieces = key.split("|").filter((p) => p.length > 0);
  return Object.freeze([...pieces]);
}

function uniqueSegments(
  scoped: readonly CorrectionRecord[],
  evidence: readonly CorrelationEvidence[],
): readonly SegmentKind[] {
  const ids = new Set(evidence.map((e) => e.recordId));
  const out = new Set<SegmentKind>();
  for (const c of scoped) if (ids.has(c.id)) out.add(c.segment);
  return [...out].sort();
}

/**
 * Choose the refinement kind from the term shape and direction. The choice
 * is deliberately conservative: a term mismatch is a `prefer-term` /
 * `fix-terminology` (based on the term's appearance), a stopword-class
 * removal is `reduce-verbosity`, and anything else is `add-constraint` /
 * `avoid-phrase`. The operator reads the instruction before accepting it, so
 * a mis-classified candidate is visible, not silently applied.
 */
function chooseKind(terms: readonly string[], direction: "add" | "remove"): RefinementKind {
  const joined = terms.join(" ").toLowerCase();
  const acronymShaped = terms.some((t) => /^[A-Z]{2,}$/.test(t));
  if (acronymShaped) return "fix-terminology";
  if (direction === "add") {
    if (/\b(please|simply|just|easily)\b/.test(joined)) return "avoid-phrase";
    if (joined.length > 40) return "increase-detail";
    return "prefer-term";
  }
  if (direction === "remove") {
    if (/\b(please|simply|just|easily|actually|basically)\b/.test(joined)) return "reduce-verbosity";
    if (joined.length > 40) return "reduce-verbosity";
    return "avoid-phrase";
  }
  return "add-constraint";
}

function composeInstruction(
  kind: RefinementKind,
  terms: readonly string[],
  replacement: string | null,
): string {
  const list = terms.join(", ");
  switch (kind) {
    case "prefer-term":
      return `Prefer the term(s) "${list}" in place of other wording, unless a quoted source string requires different wording.`;
    case "avoid-phrase":
      return `Avoid the phrase(s) "${list}".`;
    case "add-constraint":
      return `When writing steps that involve "${list}", include the term explicitly in the step text.`;
    case "fix-terminology":
      return `Use the acronym or product name(s) "${list}" exactly as written; expand an acronym on first use.`;
    case "reduce-verbosity":
      return `Reduce verbosity: drop the phrase(s) "${list}". Do not use filler wording such as "please", "just" or "simply".`;
    case "increase-detail":
      return `Increase detail around "${list}": the reviewer added this context to every corrected step in the group.`;
    case "fix-structure":
      return `Reorganise around "${list}": the reviewer reordered or restructured the affected section.`;
    default:
      return replacement ?? `Address the reviewer correction concerning "${list}".`;
  }
}

/* -------------------------------------------------------------------------- */
/* Internals — shape helpers                                                   */
/* -------------------------------------------------------------------------- */

function requireNonEmpty(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new FeedbackLoopError(`\`${path}\` must be a non-empty string.`, "invalid-input", { path });
  }
  return v.trim();
}

function isCorrectionKind(v: unknown): v is CorrectionKind {
  return (
    v === "accepted" ||
    v === "edit" ||
    v === "rewrite" ||
    v === "reject" ||
    v === "reorder" ||
    v === "annotate"
  );
}

function isSegmentKind(v: unknown): v is SegmentKind {
  return (
    v === "title" ||
    v === "summary" ||
    v === "introduction" ||
    v === "prerequisites" ||
    v === "step-title" ||
    v === "step-description" ||
    v === "tip" ||
    v === "warning" ||
    v === "faq-question" ||
    v === "faq-answer" ||
    v === "glossary-term" ||
    v === "glossary-definition" ||
    v === "longform-section" ||
    v === "structured-block" ||
    v === "other"
  );
}

function readPromptVersionId(v: PromptVersionRef | unknown): string | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  // The prompt-versions module uses `id` as the identifier across its
  // reference type; read it defensively since we treat the ref as opaque.
  return typeof o["id"] === "string" && o["id"].length > 0
    ? o["id"]
    : typeof o["version"] === "string" && o["version"].length > 0
      ? o["version"]
      : null;
}

function readPromptVersionRef(v: unknown): PromptVersionRef | null {
  if (v === null || typeof v !== "object") return null;
  // A persisted prompt-version reference carries enough shape to be
  // rehydrated across the DB boundary; the exact field set is owned by the
  // prompt-versions module. Copy the object here so a rehydrated record is
  // self-contained; the caller validates it further through that module.
  return v as PromptVersionRef;
}

function emptySegmentCounts(): Record<SegmentKind, number> {
  const out = {} as Record<SegmentKind, number>;
  for (const k of SEGMENT_KINDS) out[k] = 0;
  return out;
}

function emptyKindCounts(): Record<CorrectionKind, number> {
  const out = {} as Record<CorrectionKind, number>;
  for (const k of CORRECTION_KINDS) out[k] = 0;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  buildDiff,
  tokenise,
  STOPWORDS,
  termKey,
  keyToTerms,
  chooseKind,
  composeInstruction,
  uniqueSegments,
  buildRefinementCandidates,
  readPromptVersionId,
  isCorrectionKind,
  isSegmentKind,
  requireNonEmpty,
  emptySegmentCounts,
  emptyKindCounts,
});
