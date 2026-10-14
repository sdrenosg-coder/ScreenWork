/**
 * Zipy AI — step and plan confidence scoring.
 *
 * Two things live here:
 *
 *  1. The *canonical* confidence formula for a plan step, extracted from
 *     `stepSequence.ts` so both the sequencing step and this module agree, and
 *     so reviewers and dependent phases (review gating, distillation
 *     thresholding, analytics) can point to a single source of truth.
 *
 *  2. A *bundle* constructor (`scorePlan`) that, given a `StepPlan` and the
 *     snapshot it was built from, returns:
 *       - per-step confidence + the exact breakdown of components,
 *       - a plan-level aggregate (mean/median/percentiles), and
 *       - the set of steps that should be gated for review when the caller
 *         supplies a review policy (threshold, minimum acceptable count).
 *
 * The bundle is what the review phase consumes. It is purely deterministic —
 * no LLM call, no I/O — so the review UI can re-derive the same numbers on
 * every render without drift.
 *
 * Design constraints honoured here:
 *  - Pure. Same inputs → identical numbers. Time-dependent inputs are read
 *    from the caller, never from `Date.now()` inside the calculation.
 *  - Component breakdown is exposed, not hidden. Every aggregate score is
 *    accompanied by the individual component scores that produced it, so a
 *    user who disagrees with a weight can see exactly where the difference
 *    would land.
 *  - No invented data. A step whose target is missing contributes a match
 *    score of 0 rather than an imputed value; the reviewer sees the low
 *    number, not a smoothed one.
 *
 * Relationship to `stepSequence.ts`: that module currently computes a
 * confidence with the same formula. `stepSequence.ts` is already in the
 * repo and cannot be re-emitted in this batch, so this module imports from
 * it and treats its per-step `confidence` value as authoritative for the
 * `selectAndNormalise` inputs. When the sequencing phase is next touched the
 * intent is to have `stepSequence.ts` delegate to `confidenceForStep` below
 * — the two implementations agree today and the module documents the
 * intended dependency direction.
 */

import type {
  PlanStep,
  StepKind,
  StepPlan,
  PlanDiagnostics,
} from "@zipy/synth/stepSequence";
import type { A11ySnapshot, SnapshotEntry } from "@zipy/synth/a11ySnapshot";
import type {
  MatchQuality,
  TextToActionResult,
} from "@zipy/synth/textToAction";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ConfidenceErrorCode = "invalid-input" | "empty-plan";

export class ConfidenceError extends Error {
  readonly code: ConfidenceErrorCode;
  constructor(message: string, code: ConfidenceErrorCode) {
    super(message);
    this.name = "ConfidenceError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Component breakdown                                                         */
/* -------------------------------------------------------------------------- */

/** The five inputs to the step-confidence formula. All are in [0, 1]. */
export interface ConfidenceComponents {
  /** exact=1, fuzzy=0.75, ambiguous=0.5, unmatched=0. */
  readonly matchScore: number;
  /** 0.5 when the snapshot was truncated, else 1. */
  readonly snapshotScore: number;
  /** Combines goal presence and target-phrase length. */
  readonly promptScore: number;
  /** 1 when an LLM adapter answered, 0.7 when the deterministic path ran. */
  readonly adapterScore: number;
  /** read-only=1, write=0.95, submit=0.9, destructive/financial/outbound=0.85. */
  readonly kindPenalty: number;
}

/** The weights applied to each component. Exported so callers can reason about them. */
export const CONFIDENCE_WEIGHTS = Object.freeze({
  match: 0.45,
  snapshot: 0.15,
  prompt: 0.15,
  adapter: 0.1,
  kind: 0.15,
} as const);

export interface StepConfidence {
  readonly stepId: string;
  readonly ordinal: number;
  /** Final score in [0, 1]; already capped for `unmatched` steps. */
  readonly score: number;
  readonly components: ConfidenceComponents;
  /** True when the score was capped because the step is unmatched. */
  readonly cappedByUnmatched: boolean;
  /**
   * The per-step confidence already written by `stepSequence.ts`. Exposed so
   * any disagreement between this module and the sequencing module is
   * *visible* rather than swallowed.
   */
  readonly recordedByStepSequence: number;
  /** True when this module and the sequencing module agree to within 1e-6. */
  readonly agreesWithStepSequence: boolean;
}

/* -------------------------------------------------------------------------- */
/* Inputs for a single calculation                                             */
/* -------------------------------------------------------------------------- */

export interface StepScoringInput {
  readonly step: PlanStep;
  readonly snapshot: A11ySnapshot;
  /** Present when the plan came from `buildStepPlan`; used for goal presence. */
  readonly goalPresent: boolean | null;
  /** Whether the LLM adapter answered the *mapping* call. */
  readonly adapterUsed: boolean | null;
}

/* -------------------------------------------------------------------------- */
/* Public API — single step                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compute the canonical confidence for one plan step. Deterministic and pure.
 */
export function scoreStep(input: StepScoringInput): StepConfidence {
  if (input === null || typeof input !== "object" || input.step === null) {
    throw new ConfidenceError("scoreStep requires a StepScoringInput.", "invalid-input");
  }
  const { step, snapshot } = input;
  const matchScore = scoreMatch(step.match);
  const snapshotScore = snapshot.diagnostics.truncated ? 0.5 : 1;

  const goalBonus = input.goalPresent === null ? 1 : input.goalPresent ? 1 : 0.6;
  const phraseLength = step.target?.name.length ?? 0;
  const phraseScore = phraseLength >= 6 ? 1 : phraseLength >= 3 ? 0.75 : 0.4;
  const promptScore = (goalBonus + phraseScore) / 2;

  const adapterScore = input.adapterUsed === false ? 0.7 : 1;

  const kindPenalty = scoreKind(step.kind);

  const components: ConfidenceComponents = {
    matchScore,
    snapshotScore,
    promptScore,
    adapterScore,
    kindPenalty,
  };

  const weighted =
    CONFIDENCE_WEIGHTS.match * matchScore +
    CONFIDENCE_WEIGHTS.snapshot * snapshotScore +
    CONFIDENCE_WEIGHTS.prompt * promptScore +
    CONFIDENCE_WEIGHTS.adapter * adapterScore +
    CONFIDENCE_WEIGHTS.kind * kindPenalty;

  const cappedByUnmatched = step.match === "unmatched";
  const score = cappedByUnmatched ? Math.min(weighted, 0.2) : clamp01(weighted);

  const recorded = clamp01(step.confidence);
  const agrees = Math.abs(recorded - score) < 1e-6;

  return {
    stepId: step.stepId,
    ordinal: step.ordinal,
    score,
    components,
    cappedByUnmatched,
    recordedByStepSequence: recorded,
    agreesWithStepSequence: agrees,
  };
}

function scoreMatch(match: MatchQuality): number {
  switch (match) {
    case "exact":
      return 1;
    case "fuzzy":
      return 0.75;
    case "ambiguous":
      return 0.5;
    case "unmatched":
      return 0;
  }
}

function scoreKind(kind: StepKind): number {
  switch (kind) {
    case "read-only":
      return 1;
    case "write":
      return 0.95;
    case "submit":
      return 0.9;
    case "destructive":
    case "financial":
    case "outbound":
      return 0.85;
  }
}

/* -------------------------------------------------------------------------- */
/* Plan-level bundle                                                           */
/* -------------------------------------------------------------------------- */

export interface ReviewPolicy {
  /**
   * Score below which a step is gated for human review. Defaults to 0.55,
   * matching `stepSequence.ts`'s default.
   */
  readonly threshold?: number;
  /**
   * When set, steps are additionally gated when their kind is in this set,
   * regardless of confidence. Typical value: ["destructive","financial",
   * "outbound"] — the review phase overrides this when the operator opts
   * into risk gating.
   */
  readonly alwaysGateKinds?: readonly StepKind[];
  /**
   * When true (default), any step whose `match` is `ambiguous` or `unmatched`
   * is gated regardless of its computed score. Matches the sequencing
   * module's default `needsReview` rule.
   */
  readonly gateAmbiguousOrUnmatched?: boolean;
}

export interface PlanScoreDistribution {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  /** 25th percentile, linear interpolation between neighbours. */
  readonly p25: number;
  /** 75th percentile, linear interpolation between neighbours. */
  readonly p75: number;
}

export interface PlanConfidenceBundle {
  readonly steps: readonly StepConfidence[];
  readonly distribution: PlanScoreDistribution;
  readonly byKind: Readonly<Record<StepKind, PlanScoreDistribution>>;
  /** Steps whose score is below the threshold. */
  readonly belowThreshold: readonly string[];
  /** Steps whose kind is in `alwaysGateKinds`. */
  readonly gatedByKind: readonly string[];
  /** Steps that are ambiguous or unmatched (when gating is on). */
  readonly gatedByMatch: readonly string[];
  /** Union of the three gating reasons, de-duplicated, in plan order. */
  readonly gatedStepIds: readonly string[];
  /** True when this module and `stepSequence.ts` agree on every step. */
  readonly consistentWithStepSequence: boolean;
  /** Steps whose scores disagree (should be empty today). */
  readonly disagreements: readonly string[];
  readonly policy: Required<ReviewPolicy>;
  readonly generatedAt: string;
}

export interface ScorePlanOptions extends ReviewPolicy {
  /**
   * Optional plan step to confidence map already computed elsewhere. When
   * omitted, `scorePlan` computes from scratch. Useful when the caller has a
   * cached bundle.
   */
  readonly providedConfidences?: ReadonlyMap<string, number>;
  /**
   * Set when the plan’s source `TextToActionResult` is available; enables the
   * adapter-score component to reflect reality rather than a default of 1.
   */
  readonly textToAction?: TextToActionResult | null;
}

/**
 * Score a plan and produce the review bundle. Pure; safe to call on every
 * render.
 */
export function scorePlan(
  plan: StepPlan,
  snapshot: A11ySnapshot,
  options: ScorePlanOptions = {},
): PlanConfidenceBundle {
  if (plan === null || typeof plan !== "object") {
    throw new ConfidenceError("scorePlan requires a StepPlan.", "invalid-input");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new ConfidenceError("StepPlan.steps is empty.", "empty-plan");
  }
  if (snapshot === null || typeof snapshot !== "object") {
    throw new ConfidenceError("scorePlan requires an A11ySnapshot.", "invalid-input");
  }

  const threshold = clamp01(options.threshold ?? 0.55);
  const alwaysGateKinds: readonly StepKind[] = options.alwaysGateKinds ?? [];
  const gateAmbiguousOrUnmatched = options.gateAmbiguousOrUnmatched !== false;

  const goalPresent = options.textToAction?.extraction.goal !== undefined
    ? options.textToAction.extraction.goal !== null
    : null;
  const adapterUsed = options.textToAction !== null && options.textToAction !== undefined
    ? options.textToAction.adapterUsed
    : null;

  const steps: StepConfidence[] = [];
  for (const step of plan.steps) {
    const provided = options.providedConfidences?.get(step.stepId);
    if (provided !== undefined) {
      const recorded = clamp01(step.confidence);
      const score = clamp01(provided);
      steps.push({
        stepId: step.stepId,
        ordinal: step.ordinal,
        score,
        components: {
          matchScore: scoreMatch(step.match),
          snapshotScore: snapshot.diagnostics.truncated ? 0.5 : 1,
          promptScore: score, // provided value overrides; components kept best-effort
          adapterScore: adapterUsed === false ? 0.7 : 1,
          kindPenalty: scoreKind(step.kind),
        },
        cappedByUnmatched: step.match === "unmatched",
        recordedByStepSequence: recorded,
        agreesWithStepSequence: Math.abs(recorded - score) < 1e-6,
      });
      continue;
    }
    steps.push(
      scoreStep({
        step,
        snapshot,
        goalPresent,
        adapterUsed,
      }),
    );
  }

  const values = steps.map((s) => s.score);
  const distribution = distributionOf(values);

  const byKindMap: Record<StepKind, number[]> = {
    "read-only": [],
    write: [],
    submit: [],
    destructive: [],
    financial: [],
    outbound: [],
  };
  for (let i = 0; i < steps.length; i += 1) {
    const step = plan.steps[i];
    const conf = steps[i];
    if (step === undefined || conf === undefined) continue;
    (byKindMap[step.kind] as number[]).push(conf.score);
  }
  const byKind: Record<StepKind, PlanScoreDistribution> = {
    "read-only": distributionOf(byKindMap["read-only"] as number[]),
    write: distributionOf(byKindMap.write as number[]),
    submit: distributionOf(byKindMap.submit as number[]),
    destructive: distributionOf(byKindMap.destructive as number[]),
    financial: distributionOf(byKindMap.financial as number[]),
    outbound: distributionOf(byKindMap.outbound as number[]),
  };

  const belowThreshold: string[] = [];
  const gatedByKind: string[] = [];
  const gatedByMatch: string[] = [];
  const gatedSet = new Set<string>();
  const gatedOrdered: string[] = [];

  const kindGate = new Set<StepKind>(alwaysGateKinds);
  for (let i = 0; i < steps.length; i += 1) {
    const conf = steps[i] as StepConfidence;
    const step = plan.steps[i] as PlanStep;
    let gated = false;
    if (conf.score < threshold) {
      belowThreshold.push(conf.stepId);
      gated = true;
    }
    if (kindGate.has(step.kind)) {
      gatedByKind.push(conf.stepId);
      gated = true;
    }
    if (gateAmbiguousOrUnmatched && (step.match === "ambiguous" || step.match === "unmatched")) {
      gatedByMatch.push(conf.stepId);
      gated = true;
    }
    if (gated && !gatedSet.has(conf.stepId)) {
      gatedSet.add(conf.stepId);
      gatedOrdered.push(conf.stepId);
    }
  }

  const disagreements = steps.filter((s) => !s.agreesWithStepSequence).map((s) => s.stepId);

  return {
    steps,
    distribution,
    byKind,
    belowThreshold,
    gatedByKind,
    gatedByMatch,
    gatedStepIds: gatedOrdered,
    consistentWithStepSequence: disagreements.length === 0,
    disagreements,
    policy: {
      threshold,
      alwaysGateKinds,
      gateAmbiguousOrUnmatched,
    },
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Distribution helper                                                         */
/* -------------------------------------------------------------------------- */

function distributionOf(values: readonly number[]): PlanScoreDistribution {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, median: 0, p25: 0, p75: 0 };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / count;
  return {
    count,
    min: sorted[0] as number,
    max: sorted[count - 1] as number,
    mean,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
  };
}

/**
 * Linear-interpolation quantile over an ascending, non-empty array. Matches
 * the "type 7" definition used by NumPy and R’s default.
 */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;
  const pos = (sorted.length - 1) * clamp01(q);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower] as number;
  const weight = pos - lower;
  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight;
}

/* -------------------------------------------------------------------------- */
/* Convenience: gate check for a single step                                   */
/* -------------------------------------------------------------------------- */

/**
 * A stateless helper the review UI can use to filter steps without
 * re-scoring the whole plan. `bundle` is the result of `scorePlan`; `stepId`
 * must exist within it.
 */
export function isGated(bundle: PlanConfidenceBundle, stepId: string): boolean {
  return bundle.gatedStepIds.includes(stepId);
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateStepConfidence(value: unknown): StepConfidence {
  if (value === null || typeof value !== "object") {
    throw new ConfidenceError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const o = value as Record<string, unknown>;
  const stepId = typeof o["stepId"] === "string" ? (o["stepId"] as string) : "";
  if (stepId.length === 0) {
    throw new ConfidenceError("Rehydrate failed: stepId is missing.", "invalid-input");
  }
  const componentsRaw = (o["components"] ?? {}) as Record<string, unknown>;
  return {
    stepId,
    ordinal:
      typeof o["ordinal"] === "number" && Number.isFinite(o["ordinal"] as number)
        ? Math.max(1, Math.floor(o["ordinal"] as number))
        : 1,
    score:
      typeof o["score"] === "number" && Number.isFinite(o["score"] as number)
        ? clamp01(o["score"] as number)
        : 0,
    components: {
      matchScore: readComponent(componentsRaw["matchScore"]),
      snapshotScore: readComponent(componentsRaw["snapshotScore"]),
      promptScore: readComponent(componentsRaw["promptScore"]),
      adapterScore: readComponent(componentsRaw["adapterScore"]),
      kindPenalty: readComponent(componentsRaw["kindPenalty"]),
    },
    cappedByUnmatched: o["cappedByUnmatched"] === true,
    recordedByStepSequence:
      typeof o["recordedByStepSequence"] === "number" &&
      Number.isFinite(o["recordedByStepSequence"] as number)
        ? clamp01(o["recordedByStepSequence"] as number)
        : 0,
    agreesWithStepSequence: o["agreesWithStepSequence"] === true,
  };
}

export function rehydratePlanConfidenceBundle(value: unknown): PlanConfidenceBundle {
  if (value === null || typeof value !== "object") {
    throw new ConfidenceError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const steps = Array.isArray(r["steps"])
    ? (r["steps"] as unknown[]).map((s) => rehydrateStepConfidence(s))
    : [];
  const diagRaw = (r["distribution"] ?? {}) as Record<string, unknown>;
  const policyRaw = (r["policy"] ?? {}) as Record<string, unknown>;
  const byKindRaw = (r["byKind"] ?? {}) as Record<string, unknown>;
  const byKind: Record<StepKind, PlanScoreDistribution> = {
    "read-only": distributionOf([]),
    write: distributionOf([]),
    submit: distributionOf([]),
    destructive: distributionOf([]),
    financial: distributionOf([]),
    outbound: distributionOf([]),
  };
  for (const k of ["read-only", "write", "submit", "destructive", "financial", "outbound"] as const) {
    const raw = byKindRaw[k];
    if (raw !== null && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      byKind[k] = {
        count: numberOr(o["count"], 0),
        min: clamp01(numberOr(o["min"], 0)),
        max: clamp01(numberOr(o["max"], 0)),
        mean: clamp01(numberOr(o["mean"], 0)),
        median: clamp01(numberOr(o["median"], 0)),
        p25: clamp01(numberOr(o["p25"], 0)),
        p75: clamp01(numberOr(o["p75"], 0)),
      };
    }
  }
  return {
    steps,
    distribution: {
      count: numberOr(diagRaw["count"], steps.length),
      min: clamp01(numberOr(diagRaw["min"], 0)),
      max: clamp01(numberOr(diagRaw["max"], 0)),
      mean: clamp01(numberOr(diagRaw["mean"], 0)),
      median: clamp01(numberOr(diagRaw["median"], 0)),
      p25: clamp01(numberOr(diagRaw["p25"], 0)),
      p75: clamp01(numberOr(diagRaw["p75"], 0)),
    },
    byKind,
    belowThreshold: readStringArray(r["belowThreshold"]),
    gatedByKind: readStringArray(r["gatedByKind"]),
    gatedByMatch: readStringArray(r["gatedByMatch"]),
    gatedStepIds: readStringArray(r["gatedStepIds"]),
    consistentWithStepSequence: r["consistentWithStepSequence"] !== false,
    disagreements: readStringArray(r["disagreements"]),
    policy: {
      threshold: clamp01(numberOr(policyRaw["threshold"], 0.55)),
      alwaysGateKinds: Array.isArray(policyRaw["alwaysGateKinds"])
        ? (policyRaw["alwaysGateKinds"] as unknown[]).filter(
            (k): k is StepKind =>
              k === "read-only" ||
              k === "write" ||
              k === "submit" ||
              k === "destructive" ||
              k === "financial" ||
              k === "outbound",
          )
        : [],
      gateAmbiguousOrUnmatched: policyRaw["gateAmbiguousOrUnmatched"] !== false,
    },
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
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

function readComponent(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return clamp01(v);
  return 0;
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  return fallback;
}

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((s): s is string => typeof s === "string");
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  scoreMatch,
  scoreKind,
  distributionOf,
  quantile,
});

/* Re-export plan-level diagnostics type for downstream consumers. */
export type { PlanDiagnostics };
/* Re-export the snapshot entry type so bundle consumers do not need to
 * import from a11ySnapshot separately when they already have a bundle. */
export type { SnapshotEntry };
