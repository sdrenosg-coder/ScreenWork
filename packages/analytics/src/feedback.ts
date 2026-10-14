/**
 * Zipy AI — analytics: reader feedback capture & aggregation (phase 23, batch 1).
 *
 * The feedback layer turns the `step-feedback` and `guide-feedback` events
 * a reader leaves into the two views the dashboard shows:
 *
 *   1. **Per-guide summary.** Average rating, distribution across the 1..5
 *      scale, response count, and the share of responses that came with a
 *      comment. This is the number next to a guide's title.
 *
 *   2. **Per-step summary.** The same aggregation split by `stepIndex` so a
 *      reviewer can see whether a specific step is why a guide is rated
 *      low. A step with ratings but no written comment still counts; the
 *      written *reason* is what the reviewer follows up on, and the module
 *      records which responses carried one.
 *
 * Feedback is *never summarised by the LLM here*. This module produces the
 * numbers; the batch-2 report layer turns them into prose. The distinction
 * matters: an operator must be able to see the underlying counts, not only
 * the model's interpretation of them.
 *
 * Design rules honoured:
 *
 *  - **No invented ratings.** A rating is counted only when it is an integer
 *    in 1..5. Out-of-range, fractional or non-numeric payloads are dropped
 *    and recorded as `gaps`, not coerced. A malformed rating silently
 *    treated as 5 would be a bug the dashboard could not see.
 *
 *  - **Deterministic.** Ties on counts break by the key's lexicographic
 *    ascending order. Comments are deduplicated preserving their first-seen
 *    order, so two runs over the same stream produce identical output.
 *
 *  - **Workspace-scoped.** Filter is `(workspaceId)` and, when supplied,
 *    `guideId`. Events tagged for another workspace are never included.
 *    The route layer enforces RBAC; this module enforces the arithmetic.
 *
 *  - **Empty is not neutral.** A guide with no feedback reports `empty: true`
 *    and a null `averageRating`. Treating "no feedback" as a 0 or a 5 would
 *    misrepresent the guide's quality; the dashboard must be able to tell
 *    "no ratings" from "everyone hated it".
 *
 *  - **Comments are verbatim.** The reader's exact text is kept; the module
 *    only trims surrounding whitespace. Any redaction is the safety layer's
 *    job (`@zipy/safety/piiText`), performed upstream, not here — this
 *    module reads what was persisted.
 */

import type { AnalyticsEvent } from "./events";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type FeedbackErrorCode = "invalid-input" | "invalid-window";

export class FeedbackError extends Error {
  readonly code: FeedbackErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: FeedbackErrorCode,
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

/** The five-bucket rating distribution. Sum equals the response count. */
export interface RatingDistribution {
  readonly r1: number;
  readonly r2: number;
  readonly r3: number;
  readonly r4: number;
  readonly r5: number;
}

export interface FeedbackComment {
  /** The reader's exact text (trimmed). Never empty. */
  readonly text: string;
  readonly rating: number;
  readonly sessionId: string | null;
  readonly guideId: string | null;
  /** Null for guide-level feedback; a 1-based step index for step-level. */
  readonly stepIndex: number | null;
  readonly occurredAt: string;
}

export interface StepFeedbackRow {
  readonly stepIndex: number;
  /** Caller-supplied step title from the plan, when available; else null. */
  readonly label: string | null;
  readonly responseCount: number;
  readonly averageRating: number | null;
  readonly distribution: RatingDistribution;
  /** Responses that carried a written comment. */
  readonly commentCount: number;
}

export interface FeedbackSummary {
  readonly version: "feedback/1";
  readonly workspaceId: string;
  readonly guideId: string | null;
  /** Total responses included (step + guide level). */
  readonly responseCount: number;
  /** Responses at the step level. */
  readonly stepResponseCount: number;
  /** Responses at the guide level. */
  readonly guideResponseCount: number;
  /** Mean rating across every response; null when there are none. */
  readonly averageRating: number | null;
  readonly distribution: RatingDistribution;
  /** Mean rating across step-level responses only; null when none. */
  readonly stepAverageRating: number | null;
  /** Mean rating across guide-level responses only; null when none. */
  readonly guideAverageRating: number | null;
  /** Distinct sessions that left at least one response. */
  readonly respondingSessions: number;
  /** Responses that carried a written comment. */
  readonly commentCount: number;
  /** commentCount / responseCount, or null when responseCount is 0. */
  readonly commentRate: number | null;
  /** Comments in first-seen order; capped by `commentLimit` input. */
  readonly comments: readonly FeedbackComment[];
  /** Per-step rows, ordered by ascending step index. */
  readonly steps: readonly StepFeedbackRow[];
  /** Decisions about responses the aggregator could not count. */
  readonly gaps: readonly FeedbackGap[];
  readonly empty: boolean;
  readonly generatedAt: string;
}

export interface FeedbackGap {
  readonly kind: "invalid-rating" | "orphan-step-feedback" | "empty-comment";
  readonly sessionId: string | null;
  readonly guideId: string | null;
  readonly stepIndex: number | null;
  readonly detail: string;
}

export interface ComputeFeedbackInput {
  readonly events: readonly AnalyticsEvent[];
  readonly workspaceId: string;
  /** When supplied, restrict to feedback on this guide. */
  readonly guideId?: string | null;
  /** Inclusive lower bound on `occurredAt`; ISO string. */
  readonly since?: string | null;
  /** Inclusive upper bound on `occurredAt`; ISO string. */
  readonly until?: string | null;
  /**
   * Optional step labels keyed by 1-based index from the guide's persisted
   * plan. Used to label `StepFeedbackRow` entries; the module does not look
   * up the plan itself.
   */
  readonly stepLabelsByIndex?: Readonly<Record<number, string>>;
  /** Maximum number of comments to retain in `comments`. Defaults to 50. */
  readonly commentLimit?: number;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const MIN_RATING = 1;
const MAX_RATING = 5;
const DEFAULT_COMMENT_LIMIT = 50;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function computeFeedback(input: ComputeFeedbackInput): FeedbackSummary {
  if (input === null || typeof input !== "object") {
    throw new FeedbackError("computeFeedback requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.events)) {
    throw new FeedbackError("`events` must be an array.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new FeedbackError("`workspaceId` is required.", "invalid-input");
  }

  const since = parseBoundary(input.since, "since", -Infinity);
  const until = parseBoundary(input.until, "until", Infinity);
  if (since > until) {
    throw new FeedbackError(
      `The analytics window is empty: "since" (${String(input.since)}) is after "until" (${String(input.until)}).`,
      "invalid-window",
      { since: input.since, until: input.until },
    );
  }

  const guideScoped =
    typeof input.guideId === "string" && input.guideId.trim().length > 0
      ? input.guideId
      : null;

  const commentLimit =
    typeof input.commentLimit === "number" && Number.isFinite(input.commentLimit) && input.commentLimit > 0
      ? Math.floor(input.commentLimit)
      : DEFAULT_COMMENT_LIMIT;

  const dist: MutableDistribution = { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 };
  const sessions = new Set<string>();
  const comments: FeedbackComment[] = [];
  const seenComments = new Set<string>();
  const gaps: FeedbackGap[] = [];

  let responseCount = 0;
  let stepResponseCount = 0;
  let guideResponseCount = 0;
  let ratingSum = 0;
  let stepRatingSum = 0;
  let guideRatingSum = 0;

  // Per-step accumulators keyed by 1-based step index.
  interface StepAccum {
    count: number;
    sum: number;
    commentCount: number;
    dist: MutableDistribution;
  }
  const byStep = new Map<number, StepAccum>();

  for (const event of input.events) {
    if (event === null || typeof event !== "object") continue;
    if (event.kind !== "step-feedback" && event.kind !== "guide-feedback") continue;
    if (event.workspaceId !== input.workspaceId) continue;
    if (guideScoped !== null && event.guideId !== guideScoped) continue;

    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs)) continue;
    if (occurredMs < since || occurredMs > until) continue;

    const sessionId =
      typeof event.sessionId === "string" && event.sessionId.length > 0
        ? event.sessionId
        : null;
    const eventGuideId = typeof event.guideId === "string" ? event.guideId : null;

    const rating = readRating(event.payload.rating);
    if (rating === null) {
      gaps.push({
        kind: "invalid-rating",
        sessionId,
        guideId: eventGuideId,
        stepIndex: readStepIndex(event.payload.stepIndex),
        detail: `A ${event.kind} event carried a rating that is not an integer in ${MIN_RATING}..${MAX_RATING}; it was not counted.`,
      });
      continue;
    }

    const rawComment =
      typeof event.payload.comment === "string" ? event.payload.comment.trim() : "";
    const comment = rawComment.length > 0 ? rawComment : null;

    responseCount += 1;
    ratingSum += rating;
    bumpDistribution(dist, rating);
    if (sessionId !== null) sessions.add(sessionId);

    const stepIndex =
      event.kind === "step-feedback" ? readStepIndex(event.payload.stepIndex) : null;

    if (stepIndex !== null) {
      stepResponseCount += 1;
      stepRatingSum += rating;
      let acc = byStep.get(stepIndex);
      if (acc === undefined) {
        acc = { count: 0, sum: 0, commentCount: 0, dist: { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 } };
        byStep.set(stepIndex, acc);
      }
      acc.count += 1;
      acc.sum += rating;
      bumpDistribution(acc.dist, rating);
      if (comment !== null) acc.commentCount += 1;
    } else {
      // Guide-level, or a step-feedback event missing its stepIndex. A
      // step-feedback without an index is a data problem the reviewer sees
      // as a gap; it still counts toward the guide average because the
      // reader did rate *something*.
      if (event.kind === "step-feedback") {
        gaps.push({
          kind: "orphan-step-feedback",
          sessionId,
          guideId: eventGuideId,
          stepIndex: null,
          detail: "A step-feedback event was recorded without a stepIndex; counted at guide level.",
        });
      }
      guideResponseCount += 1;
      guideRatingSum += rating;
    }

    if (comment !== null) {
      const dedupeKey = `${stepIndex ?? "guide"}|${rating}|${comment}`;
      if (!seenComments.has(dedupeKey)) {
        seenComments.add(dedupeKey);
        comments.push({
          text: comment,
          rating,
          sessionId,
          guideId: eventGuideId,
          stepIndex,
          occurredAt: event.occurredAt,
        });
      }
    }
  }

  const steps: StepFeedbackRow[] = [];
  const labels = input.stepLabelsByIndex ?? {};
  for (const stepIndex of sortedNumericKeys(byStep)) {
    const acc = byStep.get(stepIndex);
    if (acc === undefined) continue;
    const label = readLabel(labels[stepIndex]);
    steps.push({
      stepIndex,
      label,
      responseCount: acc.count,
      averageRating: acc.count > 0 ? acc.sum / acc.count : null,
      distribution: freezeDistribution(acc.dist),
      commentCount: acc.commentCount,
    });
  }

  const retainedComments = comments.slice(0, commentLimit);
  const commentCount = comments.length;

  const empty = responseCount === 0 && commentCount === 0 && steps.length === 0 && gaps.length === 0;

  return Object.freeze({
    version: "feedback/1" as const,
    workspaceId: input.workspaceId,
    guideId: guideScoped,
    responseCount,
    stepResponseCount,
    guideResponseCount,
    averageRating: responseCount > 0 ? ratingSum / responseCount : null,
    distribution: freezeDistribution(dist),
    stepAverageRating: stepResponseCount > 0 ? stepRatingSum / stepResponseCount : null,
    guideAverageRating: guideResponseCount > 0 ? guideRatingSum / guideResponseCount : null,
    respondingSessions: sessions.size,
    commentCount,
    commentRate: responseCount > 0 ? commentCount / responseCount : null,
    comments: Object.freeze(retainedComments),
    steps: Object.freeze(steps),
    gaps: Object.freeze(gaps),
    empty,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * One-line human summary for the dashboard card. Stable wording and no
 * locale formatting so the string can be snapshot-tested.
 */
export function summariseFeedback(summary: FeedbackSummary): string {
  if (summary.empty) {
    return summary.guideId === null
      ? `No reader feedback recorded for workspace ${summary.workspaceId} in the window.`
      : `No reader feedback recorded for guide ${summary.guideId} in the window.`;
  }
  if (summary.responseCount === 0) {
    return `${summary.gaps.length} malformed feedback event${summary.gaps.length === 1 ? "" : "s"} were dropped and no valid ratings were recorded.`;
  }
  const mean = summary.averageRating;
  const meanText =
    mean === null ? "no average available" : `mean ${Math.round(mean * 100) / 100}`;
  const commentText =
    summary.commentCount === 0
      ? "no written comments"
      : `${summary.commentCount} written comment${summary.commentCount === 1 ? "" : "s"}`;
  const lowStep = lowestRatedStep(summary.steps);
  const stepClause =
    lowStep === null
      ? ""
      : ` Lowest-rated step is ${lowStep.stepIndex}${lowStep.label !== null ? ` (${lowStep.label})` : ""}.`;
  return `${summary.responseCount} response${summary.responseCount === 1 ? "" : "s"} — ${meanText}; ${commentText}.${stepClause}`;
}

/**
 * The step with the lowest average rating among steps with at least
 * `minResponses` responses. Ties break to the lower step index. Returns
 * null when no step meets the threshold.
 */
export function lowestRatedStep(
  steps: readonly StepFeedbackRow[],
  minResponses = 1,
): StepFeedbackRow | null {
  const threshold = Number.isFinite(minResponses) && minResponses > 0 ? Math.floor(minResponses) : 1;
  let best: StepFeedbackRow | null = null;
  for (const row of steps) {
    if (row.responseCount < threshold) continue;
    const avg = row.averageRating;
    if (avg === null) continue;
    if (best === null) {
      best = row;
      continue;
    }
    const bestAvg = best.averageRating ?? Number.POSITIVE_INFINITY;
    if (avg < bestAvg || (avg === bestAvg && row.stepIndex < best.stepIndex)) {
      best = row;
    }
  }
  return best;
}

/** Rehydrate a persisted `FeedbackSummary` payload. */
export function rehydrateFeedback(value: unknown): FeedbackSummary {
  if (value === null || typeof value !== "object") {
    throw new FeedbackError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  return {
    version: "feedback/1",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    guideId: typeof r["guideId"] === "string" ? r["guideId"] : null,
    responseCount: readCount(r["responseCount"]),
    stepResponseCount: readCount(r["stepResponseCount"]),
    guideResponseCount: readCount(r["guideResponseCount"]),
    averageRating: readNullableNumber(r["averageRating"]),
    distribution: readDistribution(r["distribution"]),
    stepAverageRating: readNullableNumber(r["stepAverageRating"]),
    guideAverageRating: readNullableNumber(r["guideAverageRating"]),
    respondingSessions: readCount(r["respondingSessions"]),
    commentCount: readCount(r["commentCount"]),
    commentRate: readNullableNumber(r["commentRate"]),
    comments: readComments(r["comments"]),
    steps: readSteps(r["steps"]),
    gaps: readGaps(r["gaps"]),
    empty: r["empty"] === true,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface MutableDistribution {
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  r5: number;
}

function bumpDistribution(dist: MutableDistribution, rating: number): void {
  switch (rating) {
    case 1: dist.r1 += 1; break;
    case 2: dist.r2 += 1; break;
    case 3: dist.r3 += 1; break;
    case 4: dist.r4 += 1; break;
    case 5: dist.r5 += 1; break;
  }
}

function freezeDistribution(dist: MutableDistribution): RatingDistribution {
  return Object.freeze({ r1: dist.r1, r2: dist.r2, r3: dist.r3, r4: dist.r4, r5: dist.r5 });
}

function readRating(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (!Number.isInteger(v)) return null;
  if (v < MIN_RATING || v > MAX_RATING) return null;
  return v;
}

function readStepIndex(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return null;
  return Math.trunc(v);
}

function readLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function readCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

function readNullableNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readDistribution(v: unknown): RatingDistribution {
  if (v === null || typeof v !== "object") return Object.freeze({ r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 });
  const o = v as Record<string, unknown>;
  return Object.freeze({
    r1: readCount(o["r1"]),
    r2: readCount(o["r2"]),
    r3: readCount(o["r3"]),
    r4: readCount(o["r4"]),
    r5: readCount(o["r5"]),
  });
}

function readComments(v: unknown): readonly FeedbackComment[] {
  if (!Array.isArray(v)) return [];
  const out: FeedbackComment[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = typeof o["text"] === "string" ? o["text"].trim() : "";
    if (text.length === 0) continue;
    out.push({
      text,
      rating: readRating(o["rating"]) ?? 0,
      sessionId: typeof o["sessionId"] === "string" ? o["sessionId"] : null,
      guideId: typeof o["guideId"] === "string" ? o["guideId"] : null,
      stepIndex: readStepIndex(o["stepIndex"]),
      occurredAt: typeof o["occurredAt"] === "string" ? o["occurredAt"] : "",
    });
  }
  return Object.freeze(out);
}

function readSteps(v: unknown): readonly StepFeedbackRow[] {
  if (!Array.isArray(v)) return [];
  const out: StepFeedbackRow[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const stepIndex = readStepIndex(o["stepIndex"]);
    if (stepIndex === null) continue;
    out.push({
      stepIndex,
      label: readLabel(o["label"]),
      responseCount: readCount(o["responseCount"]),
      averageRating: readNullableNumber(o["averageRating"]),
      distribution: readDistribution(o["distribution"]),
      commentCount: readCount(o["commentCount"]),
    });
  }
  return Object.freeze(out);
}

function readGaps(v: unknown): readonly FeedbackGap[] {
  if (!Array.isArray(v)) return [];
  const out: FeedbackGap[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (kind !== "invalid-rating" && kind !== "orphan-step-feedback" && kind !== "empty-comment") {
      continue;
    }
    out.push({
      kind,
      sessionId: typeof o["sessionId"] === "string" ? o["sessionId"] : null,
      guideId: typeof o["guideId"] === "string" ? o["guideId"] : null,
      stepIndex: readStepIndex(o["stepIndex"]),
      detail: typeof o["detail"] === "string" ? o["detail"] : "",
    });
  }
  return Object.freeze(out);
}

function sortedNumericKeys(map: Map<number, unknown>): number[] {
  return [...map.keys()].sort((a, b) => a - b);
}

function parseBoundary(
  raw: string | null | undefined,
  field: string,
  absent: number,
): number {
  if (raw === undefined || raw === null) return absent;
  if (typeof raw !== "string") {
    throw new FeedbackError(
      `Field "${field}" must be an ISO-8601 string when supplied.`,
      "invalid-window",
      { field },
    );
  }
  const t = raw.trim();
  if (t.length === 0) return absent;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) {
    throw new FeedbackError(
      `Field "${field}" is not a valid ISO-8601 timestamp: "${t}".`,
      "invalid-window",
      { field, value: t },
    );
  }
  return ms;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  MIN_RATING,
  MAX_RATING,
  DEFAULT_COMMENT_LIMIT,
  bumpDistribution,
  readRating,
  readStepIndex,
  parseBoundary,
});
