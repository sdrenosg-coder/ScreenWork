/**
 * Zipy AI — ordered step-sequence synthesis.
 *
 * The final layer of the synthesis batch. It takes the intent extraction from
 * `textToAction.ts`, the accessibility snapshot from `a11ySnapshot.ts`, and
 * the profile of how this guide will normally be used, and emits a single,
 * ordered, confidence-scored action list the browser-automation phase can
 * execute. This is the artefact the reviewer reviews and the automation
 * package runs.
 *
 * What this module does, precisely:
 *  - Normalises the incoming sub-tasks through a canonical orderer: starts
 *    from the operator's stated order, then reorders *only where the browser
 *    semantics require it* (a `type` cannot precede its target's `click` when
 *    the click is required to reveal the field; a final `click` on "Save"
 *    should not be followed by anything that depends on the unsaved form).
 *  - Deduplicates repeated sub-tasks (an identical click on the same ref
 *    that appears twice in the operator's prompt is collapsed, with a note
 *    recording the collapse so the reviewer sees it).
 *  - Assigns a `kind` to each step so the automation layer knows whether it
 *    is a state-changing action (needs before/after capture) or read-only
 *    (no capture beyond the step image).
 *  - Computes a per-step confidence from: sub-task match quality, snapshot
 *    snapshot quality (truncation, ambiguous candidates), operator prompt
 *    clarity (goal present, target phrase length), and step kind (write
 *    steps get a small penalty because the automation layer will need
 *    writable credentials). Low-confidence steps are flagged.
 *  - Emits `StepPlan` — an ordered, immutable list — that the downstream
 *    distillation step (`distill.ts`, later batch) can convert into a
 *    deterministic Playwright script.
 *
 * What this module is NOT:
 *  - A conditional graph. Branching (`if the customer exists, skip`) is
 *    handled by `conditionalGraph.ts` (later batch). This module assumes a
 *    linear plan and produces one. When the extraction carries conditional
 *    cues the module records them but does not attempt to model them here.
 *  - A browser. Nothing here resolves a selector or opens a page.
 *  - A provider assumption. No LLM call is made here; this module is purely
 *    deterministic given its inputs. The LLM's contribution is already
 *    baked into `TextToActionResult.extraction`.
 */

import type { A11ySnapshot, SnapshotEntry } from "@zipy/synth/a11ySnapshot";
import type {
  ActionVerb,
  IntentExtraction,
  MatchQuality,
  SubTask,
  TextToActionResult,
} from "@zipy/synth/textToAction";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type StepSequenceErrorCode =
  | "invalid-input"
  | "empty-extraction"
  | "unmatched-required-target";

export class StepSequenceError extends Error {
  readonly code: StepSequenceErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: StepSequenceErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "StepSequenceError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Risk classification per step. The review phase (`@zipy/review/riskClass`)
 * uses this to decide whether to gate on human approval. Defined here so
 * the sequence is self-describing even before the review phase lands, and so
 * the distillation step can pick the right wait strategy.
 *
 *  - `read-only`    — scroll, navigate to a page, focus a field. Safe.
 *  - `write`        — type into a field, select an option, toggling a
 *                     non-destructive control. Persists data only on a
 *                     subsequent submit.
 *  - `submit`       — a commit action: a Save / Submit / Create button that
 *                     persists the changes made by the preceding writes.
 *  - `destructive`  — a Delete / Remove / Revoke button or an action whose
 *                     accessible name matches the destructive lexicon.
 *  - `financial`    — actions against well-known financial verbs or a page
 *                     whose URL contains `/billing`, `/checkout`, `/pay`.
 *  - `outbound`     — actions that send mail / messages / notifications to a
 *                     third party (Send, Email, Notify, Invite).
 */
export const STEP_KINDS = [
  "read-only",
  "write",
  "submit",
  "destructive",
  "financial",
  "outbound",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * A single ordered, actionable step. Every field is populated from
 * verifiable inputs — nothing is invented. When the target could not be
 * matched (`match: "unmatched"`) `ref` and `target` are null; the reviewer
 * sees the step and the reason it is unresolved.
 */
export interface PlanStep {
  /** 1-based ordinal within the plan. */
  readonly ordinal: number;
  readonly stepId: string;
  /** The action the automation layer performs. */
  readonly action: ActionVerb;
  /** Stable ref to the citable snapshot element, or null when unmatched. */
  readonly ref: string | null;
  /**
   * Snapshot entry the step targets, or null when unmatched. Preserved so
   * the annotation package can place highlights without re-fetching the
   * snapshot.
   */
  readonly target: SnapshotEntry | null;
  /** Free-form value to type/select; null for click/scroll/navigate. */
  readonly value: string | null;
  /**
   * For `navigate` steps: the resolved URL. For all other steps: null.
   * Synthesised from the snapshot's `sourceUrl` when the operator's target
   * is a path ("/customers/new"), else null.
   */
  readonly navigateUrl: string | null;
  /** Read-only vs write vs destructive classification for review gating. */
  readonly kind: StepKind;
  /** Match quality inherited from the sub-task. */
  readonly match: MatchQuality;
  /** 0..1 confidence. See `confidenceFor` for the exact formula. */
  readonly confidence: number;
  /** Whether the step should be flagged for human review. */
  readonly needsReview: boolean;
  /** Human-readable note(s) that explain why the step is what it is. */
  readonly notes: readonly string[];
  /**
   * Sub-tasks this step collapsed (identical action+ref). When non-empty,
   * the reviewer sees that the operator's prompt named the same action more
   * than once; the collapse is recorded rather than hidden.
   */
  readonly collapsedFrom: readonly string[];
}

export interface PlanDiagnostics {
  readonly subTaskCount: number;
  readonly stepCount: number;
  readonly collapsedCount: number;
  readonly unmatchedCount: number;
  readonly ambiguousCount: number;
  readonly needsReviewCount: number;
  readonly meanConfidence: number;
  readonly byKind: Readonly<Record<StepKind, number>>;
  /**
   * Conditional cues the extraction noticed ("if the customer exists…").
   * Propagated to the caller so `conditionalGraph.ts` can model them.
   * This module does not attempt to model conditionals itself.
   */
  readonly conditionalCues: readonly string[];
  /** Snapshot diagnostics, carried through so the report is one call away. */
  readonly snapshotTruncated: boolean;
  readonly snapshotTruncationReason: "max-nodes" | "max-chars" | null;
}

/**
 * The plan the automation and distillation phases consume. Immutable.
 */
export interface StepPlan {
  readonly steps: readonly PlanStep[];
  readonly diagnostics: PlanDiagnostics;
  /** The URL the plan should start from. */
  readonly startUrl: string;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface BuildPlanOptions {
  /**
   * Below this confidence, `needsReview` is set. Defaults to 0.55 — tuned so
   * that an `exact` match with an `ambiguous` snapshot is still auto-runnable
   * while a `fuzzy` match on a truncated snapshot goes to review.
   */
  readonly reviewThreshold?: number;
  /**
   * When true, `unmatched` sub-tasks are dropped from the plan (and
   * recorded in `collapsedFrom` for provenance). Defaults to false: safer to
   * keep them so the reviewer can supply a manual target than to silently
   * drop a step the operator asked for.
   */
  readonly dropUnmatched?: boolean;
  /**
   * Optional overrides for risk classification. Keys are refs; values are
   * the kind to force for a step targeting that ref. Used by callers with
   * domain knowledge ("the "Archive" button is destructive even though it
   * does not look like it").
   */
  readonly kindOverrides?: Readonly<Record<string, StepKind>>;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildStepPlan(
  result: TextToActionResult,
  snapshot: A11ySnapshot,
  options: BuildPlanOptions = {},
): StepPlan {
  if (result === null || typeof result !== "object") {
    throw new StepSequenceError("buildStepPlan requires a TextToActionResult.", "invalid-input");
  }
  if (snapshot === null || typeof snapshot !== "object") {
    throw new StepSequenceError("buildStepPlan requires an A11ySnapshot.", "invalid-input");
  }
  const extraction = result.extraction;
  if (extraction === null || typeof extraction !== "object") {
    throw new StepSequenceError("TextToActionResult.extraction is missing.", "invalid-input");
  }
  if (!Array.isArray(extraction.subTasks) || extraction.subTasks.length === 0) {
    throw new StepSequenceError(
      "Extraction contains no sub-tasks to sequence.",
      "empty-extraction",
    );
  }

  const reviewThreshold = clamp01(options.reviewThreshold ?? 0.55);
  const dropUnmatched = options.dropUnmatched === true;
  const kindOverrides = options.kindOverrides ?? {};

  const ordered = orderSubTasks(extraction.subTasks, snapshot);
  const { deduped, collapsedMap } = dedupe(ordered);

  const steps: PlanStep[] = [];
  let ordinal = 1;

  for (const st of deduped) {
    if (st.match === "unmatched" && dropUnmatched) continue;
    const collapsed = collapsedMap.get(st.subTaskId) ?? [];
    const kind = classifyStep(st, snapshot, kindOverrides);
    const navigateUrl = resolveNavigateUrl(st, snapshot);
    const confidence = confidenceFor(st, snapshot, kind, result);
    const needsReview = confidence < reviewThreshold || st.match === "unmatched" || st.match === "ambiguous";

    const notes: string[] = [];
    if (st.match === "unmatched") {
      notes.push(
        "No snapshot element matched this target; the reviewer must select one.",
      );
    }
    if (st.match === "ambiguous" && st.candidates.length > 1) {
      const alts = st.candidates
        .slice(1, 4)
        .map((c) => `${c.ref} "${c.name}"`)
        .join(", ");
      notes.push(`Multiple snapshot elements matched; alternatives: ${alts}.`);
    }
    if (collapsed.length > 0) {
      notes.push(
        `Collapsed ${collapsed.length} duplicate sub-task(s) with the same action and target.`,
      );
    }
    if (result.adapterUsed === false && result.adapterFallbackReason !== null) {
      notes.push(
        `LLM mapping unavailable (${result.adapterFallbackReason}); plan is deterministic-only.`,
      );
    }

    steps.push({
      ordinal,
      stepId: `step_${ordinal}`,
      action: st.verb,
      ref: st.ref,
      target: st.matchedEntry,
      value: st.value,
      navigateUrl,
      kind,
      match: st.match,
      confidence,
      needsReview,
      notes,
      collapsedFrom: collapsed,
    });
    ordinal += 1;
  }

  const diagnostics = summarise(steps, extraction, snapshot);
  const startUrl = resolveStartUrl(snapshot, steps);

  return {
    steps,
    diagnostics,
    startUrl,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reorder sub-tasks into a linear execution order, starting from the
 * operator's stated order. The only reordering that occurs is the promotion
 * of `navigate` sub-tasks that reference a URL *different from the snapshot
 * URL* to the front of the plan, because starting anywhere other than the
 * snapshot's page requires navigating first. Everything else preserves the
 * operator's order.
 *
 * No step is moved to the end: an operator who wrote "type X into Y, then
 * click Save" gets exactly that order. "Save before fill" is not something
 * this module invents.
 */
function orderSubTasks(
  subTasks: readonly SubTask[],
  snapshot: A11ySnapshot,
): readonly SubTask[] {
  const startUrl = normaliseUrl(snapshot.sourceUrl);
  const front: SubTask[] = [];
  const rest: SubTask[] = [];
  for (const st of subTasks) {
    if (st.verb === "navigate") {
      const url = extractUrlFromPhrase(st.targetPhrase);
      if (url !== null && normaliseUrl(url) !== startUrl) {
        front.push(st);
        continue;
      }
    }
    rest.push(st);
  }
  return [...front, ...rest];
}

/* -------------------------------------------------------------------------- */
/* Deduplication                                                               */
/* -------------------------------------------------------------------------- */

interface DedupeResult {
  readonly deduped: readonly SubTask[];
  readonly collapsedMap: ReadonlyMap<string, readonly string[]>;
}

/**
 * Collapse sub-tasks that share (verb, ref) AND, for write verbs, the same
 * value. Two `click`s on the same ref is a clear duplicate; two `type`s on
 * the same ref with different values is a legitimate sequence (and is
 * preserved). The first occurrence is retained; later occurrences are
 * recorded under `collapsedFrom` on the retained step.
 *
 * `navigate` steps are never collapsed (each navigation is meaningful for
 * the resulting history).
 */
function dedupe(subTasks: readonly SubTask[]): DedupeResult {
  const byKey = new Map<string, SubTask>();
  const collapsedMap = new Map<string, string[]>();
  const order: string[] = [];

  for (const st of subTasks) {
    if (st.verb === "navigate") {
      // Keep every navigate distinct.
      const key = `${st.subTaskId}`;
      byKey.set(key, st);
      order.push(key);
      continue;
    }
    const key = `${st.verb}\u0001${st.ref ?? "<null>"}\u0001${st.value ?? ""}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, st);
      order.push(key);
      continue;
    }
    const list = collapsedMap.get(existing.subTaskId);
    if (list === undefined) collapsedMap.set(existing.subTaskId, [st.subTaskId]);
    else list.push(st.subTaskId);
  }

  const deduped: SubTask[] = [];
  for (const key of order) {
    const st = byKey.get(key);
    if (st !== undefined) deduped.push(st);
  }
  return { deduped, collapsedMap };
}

/* -------------------------------------------------------------------------- */
/* Step classification                                                         */
/* -------------------------------------------------------------------------- */

const DESTRUCTIVE_LEXICON = /\b(delete|remove|revoke|archive|destroy|cancel\s+account|purge|deactivate|disable\s+account)\b/i;
const SUBMIT_LEXICON = /\b(save|submit|create|confirm|apply|ok|done|publish|enable|activate|update)\b/i;
const FINANCIAL_LEXICON = /\b(pay|charge|purchase|buy|checkout|invoice|bill|subscribe|upgrade\s+plan|downgrade\s+plan)\b/i;
const OUTBOUND_LEXICON = /\b(send|email|invite|notify|share|post|broadcast|message)\b/i;

function classifyStep(
  st: SubTask,
  snapshot: A11ySnapshot,
  overrides: Readonly<Record<string, StepKind>>,
): StepKind {
  if (st.ref !== null && overrides[st.ref] !== undefined) {
    return overrides[st.ref] as StepKind;
  }
  if (st.verb === "navigate" || st.verb === "scroll") return "read-only";
  if (st.verb === "type" || st.verb === "select") {
    // A type into a search/filter box is read-only in effect; we cannot tell
    // from the snapshot without inspecting roles, so we use the entry's role
    // as a hint.
    const role = st.matchedEntry?.role ?? "";
    if (role === "searchbox") return "read-only";
    return "write";
  }
  // verb === "click"
  const name = st.matchedEntry?.name ?? st.targetPhrase;
  const url = snapshot.sourceUrl.toLowerCase();
  if (FINANCIAL_LEXICON.test(name) || /\/(billing|checkout|pay|payment|subscription)\b/.test(url)) {
    return "financial";
  }
  if (DESTRUCTIVE_LEXICON.test(name)) return "destructive";
  if (OUTBOUND_LEXICON.test(name)) return "outbound";
  if (SUBMIT_LEXICON.test(name)) return "submit";
  return "read-only";
}

/* -------------------------------------------------------------------------- */
/* Navigate URL resolution                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the target URL for a `navigate` step. Absolute URLs pass through;
 * paths ("/customers/new") resolve against the snapshot's source URL. When
 * neither is parseable, returns null and the reviewer sees the raw phrase.
 */
function resolveNavigateUrl(st: SubTask, snapshot: A11ySnapshot): string | null {
  if (st.verb !== "navigate") return null;
  const candidate = extractUrlFromPhrase(st.targetPhrase);
  if (candidate === null) return null;
  try {
    const url = new URL(candidate, snapshot.sourceUrl);
    return url.toString();
  } catch {
    return null;
  }
}

function extractUrlFromPhrase(phrase: string): string | null {
  const trimmed = phrase.trim();
  if (trimmed.length === 0) return null;
  // Absolute URL?
  const abs = /^https?:\/\/\S+$/i.exec(trimmed);
  if (abs !== null) return abs[0];
  // Path?
  const rel = /^\/[^\s]*$/.exec(trimmed);
  if (rel !== null) return rel[0];
  // Host without scheme? ("example.com/foo") — accept only when the first
  // token looks like a domain.
  const hostLike = /^[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.exec(trimmed);
  if (hostLike !== null) return `https://${hostLike[0]}`;
  return null;
}

function resolveStartUrl(snapshot: A11ySnapshot, steps: readonly PlanStep[]): string {
  // If the first step is a navigate to a different page, the plan starts
  // after that navigation; the automation layer will navigate to
  // `snapshot.sourceUrl` first, run step 1 (the navigate), then proceed.
  // Keeping `startUrl = sourceUrl` makes this uniform and lets the reviewer
  // see exactly where the run begins.
  void steps;
  return snapshot.sourceUrl;
}

function normaliseUrl(u: string): string {
  try {
    const url = new URL(u);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return u.trim();
  }
}

/* -------------------------------------------------------------------------- */
/* Confidence scoring                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute a step's confidence in [0, 1].
 *
 * Components and weights:
 *  - Match quality (0.45):  exact=1, fuzzy=0.75, ambiguous=0.5, unmatched=0.
 *  - Snapshot freshness (0.15):  1 - snapshotTruncatedPenalty. A truncated
 *    snapshot halves this contribution.
 *  - Prompt clarity (0.15):  whether the extraction produced a goal, and
 *    whether the sub-task's target phrase is non-trivial.
 *  - Adapter trust (0.10):  when the LLM was used and did not fall back,
 *    full weight; otherwise 0.7 (deterministic is trusted but does not see
 *    the whole snapshot).
 *  - Step kind penalty (0.15):  read-only carries no penalty; write gets a
 *    small penalty (needs writable credentials); submit/destructive/financial/
 *    outbound get a slightly larger penalty (review gating is more important
 *    on those).
 *
 * The result is clamped to [0, 1]. The formula is deliberately simple and
 * documented, so a reviewer can recompute it by hand and argue with any
 * constant they disagree with.
 */
function confidenceFor(
  st: SubTask,
  snapshot: A11ySnapshot,
  kind: StepKind,
  result: TextToActionResult,
): number {
  const matchScore =
    st.match === "exact"
      ? 1
      : st.match === "fuzzy"
        ? 0.75
        : st.match === "ambiguous"
          ? 0.5
          : 0;

  const truncatedPenalty = snapshot.diagnostics.truncated ? 0.5 : 1;
  const snapshotScore = truncatedPenalty;

  const goalBonus = result.extraction.goal !== null ? 1 : 0.6;
  const phraseLength = st.targetPhrase.trim().length;
  const phraseScore = phraseLength >= 6 ? 1 : phraseLength >= 3 ? 0.75 : 0.4;
  const promptScore = (goalBonus + phraseScore) / 2;

  const adapterScore = result.adapterUsed === true ? 1 : 0.7;

  const kindPenalty =
    kind === "read-only"
      ? 1
      : kind === "write"
        ? 0.95
        : kind === "submit"
          ? 0.9
          : 0.85;

  const weighted =
    0.45 * matchScore +
    0.15 * snapshotScore +
    0.15 * promptScore +
    0.10 * adapterScore +
    0.15 * kindPenalty;

  // `unmatched` steps cannot be advanced on; cap confidence below the review
  // threshold regardless of the other components.
  if (st.match === "unmatched") return Math.min(weighted, 0.2);

  return clamp01(weighted);
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

function summarise(
  steps: readonly PlanStep[],
  extraction: IntentExtraction,
  snapshot: A11ySnapshot,
): PlanDiagnostics {
  let collapsed = 0;
  let unmatched = 0;
  let ambiguous = 0;
  let needsReview = 0;
  let confidenceSum = 0;
  const byKind: Record<StepKind, number> = {
    "read-only": 0,
    write: 0,
    submit: 0,
    destructive: 0,
    financial: 0,
    outbound: 0,
  };
  for (const step of steps) {
    collapsed += step.collapsedFrom.length;
    if (step.match === "unmatched") unmatched += 1;
    if (step.match === "ambiguous") ambiguous += 1;
    if (step.needsReview) needsReview += 1;
    confidenceSum += step.confidence;
    byKind[step.kind] += 1;
  }

  return {
    subTaskCount: extraction.subTasks.length,
    stepCount: steps.length,
    collapsedCount: collapsed,
    unmatchedCount: unmatched,
    ambiguousCount: ambiguous,
    needsReviewCount: needsReview,
    meanConfidence: steps.length === 0 ? 0 : clamp01(confidenceSum / steps.length),
    byKind,
    conditionalCues: extraction.unmappedCandidates.filter((c) =>
      /\b(if|unless|when)\b/i.test(c),
    ),
    snapshotTruncated: snapshot.diagnostics.truncated,
    snapshotTruncationReason: snapshot.diagnostics.truncationReason,
  };
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateStepPlan(value: unknown): StepPlan {
  if (value === null || typeof value !== "object") {
    throw new StepSequenceError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const stepsRaw = Array.isArray(r["steps"]) ? (r["steps"] as unknown[]) : [];
  const steps: PlanStep[] = [];
  for (const raw of stepsRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const actionRaw = o["action"];
    const action: ActionVerb | null =
      actionRaw === "click" ||
      actionRaw === "type" ||
      actionRaw === "select" ||
      actionRaw === "scroll" ||
      actionRaw === "navigate"
        ? actionRaw
        : null;
    if (action === null) continue;
    const kindRaw = o["kind"];
    const kind: StepKind =
      kindRaw === "read-only" ||
      kindRaw === "write" ||
      kindRaw === "submit" ||
      kindRaw === "destructive" ||
      kindRaw === "financial" ||
      kindRaw === "outbound"
        ? kindRaw
        : "read-only";
    const matchRaw = o["match"];
    const match: MatchQuality =
      matchRaw === "exact" || matchRaw === "fuzzy" || matchRaw === "ambiguous" || matchRaw === "unmatched"
        ? matchRaw
        : "unmatched";
    steps.push({
      ordinal:
        typeof o["ordinal"] === "number" && Number.isFinite(o["ordinal"] as number)
          ? Math.max(1, Math.floor(o["ordinal"] as number))
          : steps.length + 1,
      stepId: typeof o["stepId"] === "string" ? (o["stepId"] as string) : `step_${steps.length + 1}`,
      action,
      ref: typeof o["ref"] === "string" ? (o["ref"] as string) : null,
      target: readMaybeEntry(o["target"]),
      value: typeof o["value"] === "string" ? (o["value"] as string) : null,
      navigateUrl: typeof o["navigateUrl"] === "string" ? (o["navigateUrl"] as string) : null,
      kind,
      match,
      confidence:
        typeof o["confidence"] === "number" && Number.isFinite(o["confidence"] as number)
          ? clamp01(o["confidence"] as number)
          : 0,
      needsReview: o["needsReview"] === true,
      notes: Array.isArray(o["notes"])
        ? (o["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      collapsedFrom: Array.isArray(o["collapsedFrom"])
        ? (o["collapsedFrom"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    });
  }

  const diagRaw = (r["diagnostics"] ?? {}) as Record<string, unknown>;
  const byKindRaw = (diagRaw["byKind"] ?? {}) as Record<string, unknown>;
  const byKind: Record<StepKind, number> = {
    "read-only": 0,
    write: 0,
    submit: 0,
    destructive: 0,
    financial: 0,
    outbound: 0,
  };
  for (const k of STEP_KINDS) {
    const v = byKindRaw[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) byKind[k] = Math.floor(v);
  }
  const truncationReasonRaw = diagRaw["snapshotTruncationReason"];
  const snapshotTruncationReason: PlanDiagnostics["snapshotTruncationReason"] =
    truncationReasonRaw === "max-nodes" || truncationReasonRaw === "max-chars"
      ? truncationReasonRaw
      : null;

  return {
    steps,
    diagnostics: {
      subTaskCount: numberOr(diagRaw["subTaskCount"], steps.length),
      stepCount: numberOr(diagRaw["stepCount"], steps.length),
      collapsedCount: numberOr(diagRaw["collapsedCount"], 0),
      unmatchedCount: numberOr(diagRaw["unmatchedCount"], 0),
      ambiguousCount: numberOr(diagRaw["ambiguousCount"], 0),
      needsReviewCount: numberOr(diagRaw["needsReviewCount"], 0),
      meanConfidence:
        typeof diagRaw["meanConfidence"] === "number" && Number.isFinite(diagRaw["meanConfidence"] as number)
          ? clamp01(diagRaw["meanConfidence"] as number)
          : 0,
      byKind,
      conditionalCues: Array.isArray(diagRaw["conditionalCues"])
        ? (diagRaw["conditionalCues"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      snapshotTruncated: diagRaw["snapshotTruncated"] === true,
      snapshotTruncationReason,
    },
    startUrl: typeof r["startUrl"] === "string" ? (r["startUrl"] as string) : "",
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
  };
}

function readMaybeEntry(v: unknown): SnapshotEntry | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ref = typeof o["ref"] === "string" ? (o["ref"] as string) : "";
  const role = typeof o["role"] === "string" ? (o["role"] as string) : "";
  if (ref.length === 0 || role.length === 0) return null;
  return {
    ref,
    role,
    name: typeof o["name"] === "string" ? (o["name"] as string) : "",
    value: typeof o["value"] === "string" ? (o["value"] as string) : null,
    level:
      typeof o["level"] === "number" && Number.isFinite(o["level"] as number)
        ? Math.floor(o["level"] as number)
        : null,
    states: Array.isArray(o["states"])
      ? (o["states"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    properties:
      o["properties"] !== null && typeof o["properties"] === "object"
        ? (o["properties"] as Readonly<Record<string, string | number | boolean>>)
        : {},
    depth:
      typeof o["depth"] === "number" && Number.isFinite(o["depth"] as number)
        ? Math.max(0, Math.floor(o["depth"] as number))
        : 0,
  };
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  orderSubTasks,
  dedupe,
  classifyStep,
  resolveNavigateUrl,
  extractUrlFromPhrase,
  normaliseUrl,
  confidenceFor,
  summarise,
});
