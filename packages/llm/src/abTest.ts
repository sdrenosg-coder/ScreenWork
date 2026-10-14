/**
 * Zipy AI — LLM adapter: prompt version A/B testing (phase 25, batch 1).
 *
 * Phase 8 introduced `promptVersions.ts`, a registry of named, versioned
 * prompt templates and a resolver that chooses a version per call. This
 * module adds the *experiment* layer on top: an ability to run two prompt
 * versions (or two models, or two parameter sets) side by side, record
 * which arm served each call, and compute the outcome comparison from
 * per-call observations.
 *
 * What the module does:
 *
 *   - Defines an `AbExperiment` — a named experiment with two arms (`A` and
 *     `B`), a deterministic assignment function keyed on a caller-supplied
 *     subject (a user id, a workspace id, a guide id) so a single subject
 *     stays in one arm across calls, a start/stop control, and a routing
 *     weight.
 *
 *   - Provides `assignArm(experiment, subject)` — returns the arm the
 *     subject is assigned to. The assignment is deterministic: the subject
 *     is hashed with the experiment's id; the low bit of the hash selects
 *     the arm, adjusted by the routing weight. This means a shared subject
 *     (a workspace) sees one arm across a session; the platform does not
 *     flip arms every call.
 *
 *   - Provides `recordObservation` — an append-only sink for per-call
 *     observations (which arm, which prompt version, which model, latency,
 *     token cost, quality score, thumbs up/down, etc.). The module does
 *     not own the store: the caller supplies a `ObservationSink` interface
 *     that the platform's Postgres-backed implementation satisfies, and a
 *     `MemoryObservationSink` for tests and for the development default.
 *
 *   - Provides `summariseExperiment` — computes, from the recorded
 *     observations, per-arm counts and a two-sample comparison on whatever
 *     numerics an observation carries. The module refuses to conclude
 *     anything from an under-powered sample (a default minimum of 20
 *     observations per arm); it reports "insufficient data" explicitly
 *     instead of manufacturing a winner.
 *
 *   - Provides `evaluateWinner` — turns a summary into a decision with the
 *     same discipline: a metric is only called a winner when the sample
 *     size minimum is met and the difference exceeds a configured effect
 *     threshold. Every numeric report carries a note stating that this is
 *     a two-sample comparison over raw observations, not a significance
 *     test, and that a production decision should apply the operator's own
 *     statistical standards.
 *
 * Design rules honoured:
 *
 *   - **No call is made to a provider.** This module routes prompts and
 *     records what happened; the LLM adapter calls a provider.
 *
 *   - **No observation is invented.** The `recordObservation` function
 *     stores exactly what the caller supplies. A per-call cost that the
 *     provider did not report is stored as `null`, not as a zero. Cost
 *     tracking (a later batch) reads these numbers; the module does not
 *     synthesize them.
 *
 *   - **No probabilistic bucketing.** Assignment is deterministic on
 *     `(experiment.id, subject)`. A caller that wants a random arm per
 *     call is asking for a different experiment design; the module
 *     implements the one shape that has a stable subject-to-arm mapping.
 *     This is the shape an operator needs to compare two prompt versions
 *     against a shared user population without having a single user's two
 *     similar calls served by different arms.
 *
 *   - **The provided memory sink is not a durable store.** Its name says
 *     so; its type documents that it drops observations on process exit.
 *     Nothing in the module reads or writes a database.
 *
 * Exports:
 *   - `AB_TEST_VERSION`, `DEFAULT_MIN_OBSERVATIONS_PER_ARM`,
 *     `DEFAULT_EFFECT_THRESHOLD`.
 *   - Types: `Arm`, `AbExperiment`, `AbExperimentArm`, `AbObservation`,
 *     `ObservationSink`, `ExperimentSummary`, `ArmSummary`, `MetricSummary`,
 *     `WinnerDecision`, `DefineExperimentInput`.
 *   - Classes: `AbTestError`, `MemoryObservationSink`.
 *   - Functions: `defineExperiment`, `assignArm`, `resolveExperimentArm`,
 *     `recordObservation`, `summariseExperiment`, `evaluateWinner`,
 *     `rehydrateExperiment`, `experimentStatus`.
 */

import type { LlmProvider } from "@zipy/db/../../apps/web/src/lib/config";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AbTestErrorCode =
  | "invalid-input"
  | "shape"
  | "sink-failure"
  | "experiment-closed";

export class AbTestError extends Error {
  readonly code: AbTestErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: AbTestErrorCode,
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

export const AB_TEST_VERSION = "ab-test/1" as const;

/**
 * The minimum number of observations per arm the module will draw a winner
 * from. Below this, `evaluateWinner` returns "insufficient-data" with the
 * per-arm counts, so the operator can see how many more calls are needed.
 *
 * The default is deliberately small — 20 per arm — because the platform's
 * generation volume is low for most workspaces and a large minimum would
 * make the feature useless for anyone but the largest customers. The
 * constant is exported so an operator can raise it per experiment.
 */
export const DEFAULT_MIN_OBSERVATIONS_PER_ARM = 20;

/**
 * The minimum absolute difference in a metric (on the metric's own scale)
 * before the module will call one arm a winner. Below this, the module
 * reports "tie" rather than "winner", on the reasoning that a difference
 * the operator cannot act on is not a decision.
 *
 * The default is deliberately conservative and expressed on a normalized
 * scale: `0.05` means "a 5% relative improvement". A caller with a metric
 * whose meaning is absolute (latency in milliseconds) sets its own
 * threshold per metric.
 */
export const DEFAULT_EFFECT_THRESHOLD = 0.05 as const;

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export const ARMS = ["A", "B"] as const;
export type Arm = (typeof ARMS)[number];

/**
 * One arm of an experiment. The `promptVersion` and `modelOverride` are the
 * variables under test; a caller may test both together (a "compare prompt
 * v4 with GPT-4o against prompt v5 with Claude Sonnet") or pin one of them
 * and vary the other.
 */
export interface AbExperimentArm {
  readonly promptVersion: string;
  /**
   * Optional model override. `null` means "use the adapter's configured
   * default" and is the correct value when the experiment is testing a
   * prompt version only.
   */
  readonly modelOverride: {
    readonly provider: LlmProvider;
    readonly model: string | null;
  } | null;
  /**
   * Whatever the operator wants to attach to the arm: a label, a URL, a
   * ticket number. Stored verbatim in the summary so a reader knows what
   * "B" means without opening a second tool.
   */
  readonly description: string;
}

export type ExperimentStatus = "draft" | "running" | "stopped";

export interface AbExperiment {
  readonly version: typeof AB_TEST_VERSION;
  readonly id: string;
  readonly name: string;
  readonly status: ExperimentStatus;
  readonly arms: Readonly<Record<Arm, AbExperimentArm>>;
  /**
   * The share of subjects assigned to arm A, in `[0, 1]`. The default is
   * `0.5`. A value of `1` gives every subject arm A (useful for a canary
   * rollout where the operator wants every call to use a new prompt version
   * and every observation to be attributable to it, while still being able
   * to compute a per-arm report).
   */
  readonly armAWeight: number;
  readonly minObservationsPerArm: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
}

export interface DefineExperimentInput {
  readonly id: string;
  readonly name: string;
  readonly arms: Readonly<Record<Arm, AbExperimentArm>>;
  readonly armAWeight?: number;
  readonly minObservationsPerArm?: number;
  readonly status?: ExperimentStatus;
}

/**
 * One observation. The module stores the numeric fields as `null` when the
 * caller did not supply a number, and *never* replaces a null with a zero.
 * This is what makes "the provider did not report a cost" distinguishable
 * from "the provider reported a cost of zero".
 */
export interface AbObservation {
  readonly experimentId: string;
  readonly arm: Arm;
  /** Caller-defined id, typically the job id, so an observation is traceable. */
  readonly subject: string;
  /** Stable per-call id; used as the primary key in the sink. */
  readonly callId: string;
  readonly promptVersion: string;
  readonly provider: string | null;
  readonly model: string | null;
  /** Recorded at the caller's clock; the module never overwrites it. */
  readonly atIso: string;
  /** Round-trip latency in milliseconds, or null if unobserved. */
  readonly latencyMs: number | null;
  /** Total input + output tokens, or null if unobserved. */
  readonly totalTokens: number | null;
  /** Cost in the caller's chosen currency unit, or null if unobserved. */
  readonly cost: number | null;
  /**
   * Quality score in `[0, 1]`, or `null`. The caller decides the scale; the
   * module requires that the scale is documented in the observation's
   * `qualityNote` field when it is not `null`, so a report can label what
   * the number means.
   */
  readonly qualityScore: number | null;
  readonly qualityNote: string | null;
  /**
   * True when a human reviewer flagged the output as rejected; null when
   * the review surface did not produce a decision.
   */
  readonly humanRejected: boolean | null;
}

/**
 * The storage interface the caller implements. The platform's Postgres-backed
 * implementation uses the jobs/telemetry tables; a test uses the memory sink.
 * A sink failure is surfaced as an `AbTestError` so a lost observation is
 * visible rather than treated as a zero.
 */
export interface ObservationSink {
  append(observation: AbObservation): Promise<void>;
  listByExperiment(experimentId: string): Promise<readonly AbObservation[]>;
}

/* -------------------------------------------------------------------------- */
/* Memory sink (development + tests)                                           */
/* -------------------------------------------------------------------------- */

/**
 * An in-memory sink. It is deliberately named so its non-durability is
 * obvious. It exists so the module can be exercised end-to-end without a
 * database and so a development workspace can preview prompt-version
 * comparisons without persistence. It does not survive a process restart and
 * makes no claim to concurrency safety across processes.
 */
export class MemoryObservationSink implements ObservationSink {
  private readonly byExperiment = new Map<string, AbObservation[]>();
  private readonly seenCallIds = new Set<string>();

  async append(observation: AbObservation): Promise<void> {
    if (this.seenCallIds.has(observation.callId)) {
      // The observation, if already stored, is not overwritten. A duplicate
      // callId is either a retry (the same observation) or a client bug (a
      // different observation); the module refuses to guess which and
      // reports the collision instead.
      throw new AbTestError(
        `Observation with callId "${observation.callId}" has already been recorded; the module refuses to overwrite it. Use a unique callId per call.`,
        "sink-failure",
        { callId: observation.callId },
      );
    }
    this.seenCallIds.add(observation.callId);
    const list = this.byExperiment.get(observation.experimentId) ?? [];
    list.push(observation);
    this.byExperiment.set(observation.experimentId, list);
  }

  async listByExperiment(experimentId: string): Promise<readonly AbObservation[]> {
    return this.byExperiment.get(experimentId) ?? [];
  }

  /** Test-only: how many observations are stored for an experiment. */
  sizeFor(experimentId: string): number {
    return (this.byExperiment.get(experimentId) ?? []).length;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function defineExperiment(input: DefineExperimentInput): AbExperiment {
  if (input === null || typeof input !== "object") {
    throw new AbTestError("defineExperiment requires an input object.", "invalid-input");
  }
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    throw new AbTestError("`id` is required.", "invalid-input");
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new AbTestError("`name` is required.", "invalid-input");
  }
  const arms = validateArms(input.arms);
  const armAWeight = validateWeight(input.armAWeight);
  const minObservationsPerArm =
    typeof input.minObservationsPerArm === "number" &&
    Number.isFinite(input.minObservationsPerArm) &&
    input.minObservationsPerArm > 0
      ? Math.floor(input.minObservationsPerArm)
      : DEFAULT_MIN_OBSERVATIONS_PER_ARM;
  const status: ExperimentStatus =
    input.status === "running" || input.status === "stopped" ? input.status : "draft";
  const now = new Date().toISOString();
  return Object.freeze({
    version: AB_TEST_VERSION,
    id: input.id,
    name: input.name,
    status,
    arms,
    armAWeight,
    minObservationsPerArm,
    createdAt: now,
    startedAt: status === "running" ? now : null,
    stoppedAt: status === "stopped" ? now : null,
  });
}

/**
 * Deterministic arm assignment. The subject is hashed with the experiment's
 * id; the hash value, reduced into `[0, 1)`, is compared against
 * `experiment.armAWeight`. A subject whose hash-derived score is less than
 * the threshold gets arm A, otherwise arm B. This makes the assignment
 * stable per subject: the same `(experiment, subject)` pair always yields
 * the same arm, regardless of process, machine or time.
 *
 * A stopped experiment still assigns an arm (the assignment is a property
 * of the subject, not of the experiment's running state); `resolveExperimentArm`
 * is the function a caller uses when it wants to know whether the
 * experiment is *currently* serving requests.
 */
export function assignArm(experiment: AbExperiment, subject: string): Arm {
  if (experiment === null || typeof experiment !== "object" || experiment.version !== AB_TEST_VERSION) {
    throw new AbTestError(
      `assignArm requires an AbExperiment (version "${AB_TEST_VERSION}").`,
      "invalid-input",
    );
  }
  if (typeof subject !== "string" || subject.length === 0) {
    throw new AbTestError("`subject` must be a non-empty string.", "invalid-input");
  }
  const score = hashToUnitInterval(`${experiment.id}::${subject}`);
  return score < experiment.armAWeight ? "A" : "B";
}

export interface ResolveArmResult {
  readonly arm: Arm;
  readonly armInfo: AbExperimentArm;
  /**
   * Whether the experiment was running when this call resolved. `false`
   * means the caller should fall back to its own default prompt version
   * rather than the arm's.
   */
  readonly experimentRunning: boolean;
}

/**
 * Resolve the arm for a subject and report whether the experiment is
 * currently serving. A caller uses this immediately before constructing a
 * request: it takes `armInfo.promptVersion` as the prompt to use, applies
 * `armInfo.modelOverride` if present, and passes `result.arm` back to
 * `recordObservation` when the call completes. When `experimentRunning` is
 * `false`, the caller ignores the arm and uses its configured default.
 */
export function resolveExperimentArm(
  experiment: AbExperiment,
  subject: string,
): ResolveArmResult {
  const arm = assignArm(experiment, subject);
  return {
    arm,
    armInfo: experiment.arms[arm],
    experimentRunning: experiment.status === "running",
  };
}

/**
 * Validate and forward an observation to the sink. The module does not
 * mutate the observation; it checks the shape (a `totalTokens` of `-1` is
 * rejected; a `qualityScore` outside `[0, 1]` is rejected) and appends.
 *
 * The `arm` on the observation is not checked against `assignArm`: the
 * caller has already resolved the arm with `resolveExperimentArm` and may
 * have overridden it (e.g. a canary rollout forcing arm A). The module
 * trusts the recorded arm; the report shows the arms as they were used.
 */
export async function recordObservation(
  sink: ObservationSink,
  experimental: AbExperiment,
  observation: AbObservation,
): Promise<void> {
  if (sink === null || typeof sink !== "object") {
    throw new AbTestError("`sink` is required.", "invalid-input");
  }
  if (experimental === null || typeof experimental !== "object" || experimental.version !== AB_TEST_VERSION) {
    throw new AbTestError(
      `recordObservation requires an AbExperiment (version "${AB_TEST_VERSION}").`,
      "invalid-input",
    );
  }
  if (observation === null || typeof observation !== "object") {
    throw new AbTestError("`observation` is required.", "invalid-input");
  }
  if (observation.experimentId !== experimental.id) {
    throw new AbTestError(
      `Observation experimentId "${observation.experimentId}" does not match the supplied experiment "${experimental.id}".`,
      "invalid-input",
    );
  }
  if (observation.arm !== "A" && observation.arm !== "B") {
    throw new AbTestError(`Observation arm must be "A" or "B".`, "invalid-input");
  }
  if (typeof observation.callId !== "string" || observation.callId.length === 0) {
    throw new AbTestError("Observation `callId` is required.", "invalid-input");
  }
  if (typeof observation.subject !== "string" || observation.subject.length === 0) {
    throw new AbTestError("Observation `subject` is required.", "invalid-input");
  }
  if (typeof observation.atIso !== "string" || observation.atIso.length === 0) {
    throw new AbTestError("Observation `atIso` is required.", "invalid-input");
  }
  if (observation.totalTokens !== null && (!Number.isFinite(observation.totalTokens) || observation.totalTokens < 0)) {
    throw new AbTestError(
      `Observation \`totalTokens\` must be null or a non-negative number; received ${String(observation.totalTokens)}.`,
      "invalid-input",
    );
  }
  if (observation.latencyMs !== null && (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0)) {
    throw new AbTestError(
      `Observation \`latencyMs\` must be null or a non-negative number; received ${String(observation.latencyMs)}.`,
      "invalid-input",
    );
  }
  if (observation.cost !== null && (!Number.isFinite(observation.cost) || observation.cost < 0)) {
    throw new AbTestError(
      `Observation \`cost\` must be null or a non-negative number; received ${String(observation.cost)}.`,
      "invalid-input",
    );
  }
  if (
    observation.qualityScore !== null &&
    (!Number.isFinite(observation.qualityScore) ||
      observation.qualityScore < 0 ||
      observation.qualityScore > 1)
  ) {
    throw new AbTestError(
      `Observation \`qualityScore\` must be null or a number in [0, 1]; received ${String(observation.qualityScore)}.`,
      "invalid-input",
    );
  }
  try {
    await sink.append(observation);
  } catch (err) {
    if (err instanceof AbTestError) throw err;
    throw new AbTestError(
      err instanceof Error
        ? `The observation sink failed to store the observation: ${err.message}`
        : "The observation sink failed to store the observation.",
      "sink-failure",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

export interface MetricSummary {
  readonly metric: string;
  readonly unit: "ms" | "tokens" | "cost" | "ratio";
  readonly meanA: number | null;
  readonly meanB: number | null;
  /**
   * `meanA - meanB` for a metric where lower is better (latency, cost); the
   * summariser always records the raw difference and reports the direction
   * separately.
   */
  readonly difference: number | null;
  /** Fraction of the larger absolute magnitude; null when both are zero. */
  readonly relativeDifference: number | null;
  /** Which arm provides the smaller value; null when the values are equal. */
  readonly lowerIs: Arm | "equal" | null;
  /** Observations contributing to the metric; excludes nulls. */
  readonly countA: number;
  readonly countB: number;
}

export interface ArmSummary {
  readonly arm: Arm;
  readonly promptVersion: string;
  readonly description: string;
  readonly observations: number;
  readonly uniqueSubjects: number;
  readonly humanRejected: number;
  readonly humanAccepted: number;
  readonly humanUndecided: number;
}

export interface ExperimentSummary {
  readonly experimentId: string;
  readonly experimentName: string;
  readonly status: ExperimentStatus;
  readonly generatedAt: string;
  readonly arms: readonly ArmSummary[];
  readonly metrics: readonly MetricSummary[];
  /** A human-readable note stating the statistical caveat, always present. */
  readonly caveat: string;
  /** Reasons the summary cannot draw a conclusion; empty when it can. */
  readonly blockers: readonly string[];
}

export async function summariseExperiment(
  sink: ObservationSink,
  experiment: AbExperiment,
): Promise<ExperimentSummary> {
  if (sink === null || typeof sink !== "object") {
    throw new AbTestError("`sink` is required.", "invalid-input");
  }
  if (experiment === null || typeof experiment !== "object" || experiment.version !== AB_TEST_VERSION) {
    throw new AbTestError(
      `summariseExperiment requires an AbExperiment (version "${AB_TEST_VERSION}").`,
      "invalid-input",
    );
  }
  let observations: readonly AbObservation[];
  try {
    observations = await sink.listByExperiment(experiment.id);
  } catch (err) {
    throw new AbTestError(
      err instanceof Error
        ? `The observation sink failed to list observations: ${err.message}`
        : "The observation sink failed to list observations.",
      "sink-failure",
    );
  }

  const arms: ArmSummary[] = ARMS.map((arm) => summariseArm(arm, experiment.arms[arm], observations));

  const metrics: MetricSummary[] = [
    summariseMetric("latency", "ms", observations, extractLatency),
    summariseMetric("totalTokens", "tokens", observations, extractTokens),
    summariseMetric("cost", "cost", observations, extractCost),
    summariseMetric("qualityScore", "ratio", observations, extractQuality),
  ];

  const blockers: string[] = [];
  for (const arm of arms) {
    if (arm.observations < experiment.minObservationsPerArm) {
      blockers.push(
        `Arm "${arm.arm}" has ${arm.observations} observation${arm.observations === 1 ? "" : "s"}; the minimum is ${experiment.minObservationsPerArm}.`,
      );
    }
  }
  if (experiment.status !== "running") {
    blockers.push(
      `The experiment is "${experiment.status}". Reports are computed over historical observations; no new calls are being served by the experiment.`,
    );
  }

  return {
    experimentId: experiment.id,
    experimentName: experiment.name,
    status: experiment.status,
    generatedAt: new Date().toISOString(),
    arms,
    metrics,
    caveat:
      "This summary reports per-arm means and raw differences. It is not a significance test; the module has no hypothesis-test implementation and does not claim one. A production decision should apply the operator's own statistical standards to the raw observations, which the sink retains.",
    blockers,
  };
}

export interface WinnerDecision {
  readonly metric: string;
  readonly winner: Arm | "tie" | "insufficient-data";
  readonly effect: number | null;
  readonly threshold: number;
  readonly reason: string;
}

/**
 * Turn a summary into a per-metric winner decision. The rules are:
 *
 *   - Every arm must have at least `experiment.minObservationsPerArm`
 *     observations contributing to the metric. Otherwise: insufficient-data.
 *
 *   - The relative difference between the arms must meet or exceed the
 *     effect threshold for that metric. Otherwise: tie.
 *
 *   - The winner is the arm with the better value: lower for latency, cost
 *     and token count; higher for quality. `direction` is supplied per
 *     metric by the caller because "better" is a property of the metric,
 *     not of the number.
 */
export function evaluateWinner(
  summary: ExperimentSummary,
  metric: string,
  direction: "lower" | "higher",
  effectThreshold: number = DEFAULT_EFFECT_THRESHOLD,
): WinnerDecision {
  if (summary === null || typeof summary !== "object") {
    throw new AbTestError("`summary` is required.", "invalid-input");
  }
  const m = summary.metrics.find((x) => x.metric === metric);
  if (m === undefined) {
    throw new AbTestError(
      `No metric "${metric}" in the summary for experiment "${summary.experimentId}".`,
      "invalid-input",
      { metric, available: summary.metrics.map((x) => x.metric) },
    );
  }
  if (m.meanA === null || m.meanB === null) {
    return {
      metric: m.metric,
      winner: "insufficient-data",
      effect: null,
      threshold: effectThreshold,
      reason: `One or both arms have no observations contributing to "${m.metric}". Cannot compare.`,
    };
  }
  const minA = summary.arms.find((a) => a.arm === "A")?.observations ?? 0;
  const minB = summary.arms.find((a) => a.arm === "B")?.observations ?? 0;
  if (minA < m.countA || minB < m.countB) {
    // Defensive: not possible given how summariseMetric works, but explicit.
    return {
      metric: m.metric,
      winner: "insufficient-data",
      effect: null,
      threshold: effectThreshold,
      reason: "Observation counts are inconsistent between the summary's arms and metrics.",
    };
  }
  const relative = m.relativeDifference;
  if (relative === null) {
    return {
      metric: m.metric,
      winner: "tie",
      effect: null,
      threshold: effectThreshold,
      reason: `Both arms have the same value for "${m.metric}" (${m.meanA}); no difference to act on.`,
    };
  }
  if (Math.abs(relative) < effectThreshold) {
    return {
      metric: m.metric,
      winner: "tie",
      effect: relative,
      threshold: effectThreshold,
      reason: `The relative difference (${(relative * 100).toFixed(2)}%) is below the ${(effectThreshold * 100).toFixed(2)}% effect threshold.`,
    };
  }
  let winner: Arm;
  if (direction === "lower") {
    winner = m.meanA < m.meanB ? "A" : "B";
  } else {
    winner = m.meanA > m.meanB ? "A" : "B";
  }
  return {
    metric: m.metric,
    winner,
    effect: relative,
    threshold: effectThreshold,
    reason:
      `Arm "${winner}" is better on "${m.metric}" by ${(Math.abs(relative) * 100).toFixed(2)}% relative to the other arm; the effect threshold is ${(effectThreshold * 100).toFixed(2)}%.`,
  };
}

/** Stable identifier for a summary's experiment, for logging. */
export function experimentStatus(experiment: AbExperiment): ExperimentStatus {
  return experiment.status;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateExperiment(value: unknown): AbExperiment {
  if (value === null || typeof value !== "object") {
    throw new AbTestError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== AB_TEST_VERSION) {
    throw new AbTestError(
      `Rehydrate failed: expected version "${AB_TEST_VERSION}", received "${String(r["version"])}".`,
      "shape",
    );
  }
  const armsRaw = r["arms"];
  let arms: Readonly<Record<Arm, AbExperimentArm>>;
  try {
    arms = validateArms(armsRaw);
  } catch (err) {
    throw new AbTestError(
      err instanceof Error ? `Rehydrate failed: ${err.message}` : "Rehydrate failed: invalid arms.",
      "shape",
    );
  }
  const status: ExperimentStatus =
    r["status"] === "running" || r["status"] === "stopped" ? r["status"] : "draft";
  return {
    version: AB_TEST_VERSION,
    id: typeof r["id"] === "string" ? r["id"] : "",
    name: typeof r["name"] === "string" ? r["name"] : "",
    status,
    arms,
    armAWeight: typeof r["armAWeight"] === "number" && Number.isFinite(r["armAWeight"]) ? r["armAWeight"] : 0.5,
    minObservationsPerArm:
      typeof r["minObservationsPerArm"] === "number" && Number.isFinite(r["minObservationsPerArm"])
        ? Math.max(1, Math.floor(r["minObservationsPerArm"]))
        : DEFAULT_MIN_OBSERVATIONS_PER_ARM,
    createdAt: typeof r["createdAt"] === "string" ? r["createdAt"] : "",
    startedAt: typeof r["startedAt"] === "string" ? r["startedAt"] : null,
    stoppedAt: typeof r["stoppedAt"] === "string" ? r["stoppedAt"] : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function validateArms(input: unknown): Readonly<Record<Arm, AbExperimentArm>> {
  if (input === null || typeof input !== "object") {
    throw new AbTestError("`arms` must be an object with A and B.", "invalid-input");
  }
  const o = input as Record<string, unknown>;
  const armA = readArm(o["A"], "A");
  const armB = readArm(o["B"], "B");
  return Object.freeze({ A: armA, B: armB });
}

function readArm(v: unknown, arm: Arm): AbExperimentArm {
  if (v === null || typeof v !== "object") {
    throw new AbTestError(`Arm "${arm}" must be an object.`, "invalid-input");
  }
  const o = v as Record<string, unknown>;
  const promptVersion = typeof o["promptVersion"] === "string" ? o["promptVersion"].trim() : "";
  if (promptVersion.length === 0) {
    throw new AbTestError(`Arm "${arm}" must name a promptVersion.`, "invalid-input");
  }
  const modelOverrideRaw = o["modelOverride"];
  let modelOverride: AbExperimentArm["modelOverride"] = null;
  if (modelOverrideRaw !== null && modelOverrideRaw !== undefined) {
    if (typeof modelOverrideRaw !== "object") {
      throw new AbTestError(`Arm "${arm}" modelOverride must be an object or null.`, "invalid-input");
    }
    const mo = modelOverrideRaw as Record<string, unknown>;
    const provider = mo["provider"];
    if (
      provider !== "openai" &&
      provider !== "anthropic" &&
      provider !== "gemini" &&
      provider !== "ollama" &&
      provider !== "vllm"
    ) {
      throw new AbTestError(
        `Arm "${arm}" modelOverride.provider must be one of openai, anthropic, gemini, ollama, vllm.`,
        "invalid-input",
      );
    }
    modelOverride = {
      provider,
      model: typeof mo["model"] === "string" && mo["model"].trim().length > 0 ? mo["model"].trim() : null,
    };
  }
  const description = typeof o["description"] === "string" ? o["description"] : "";
  return Object.freeze({ promptVersion, modelOverride, description });
}

function validateWeight(v: unknown): number {
  if (v === undefined || v === null) return 0.5;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new AbTestError(
      `armAWeight must be a number in [0, 1]; received ${String(v)}.`,
      "invalid-input",
    );
  }
  return v;
}

/**
 * FNV-1a 32-bit hash, mapped to a unit interval. Deterministic, cheap, and
 * adequate for arm bucketing where the goal is a stable partition rather
 * than a cryptographic property. The hash is emitted as an unsigned 32-bit
 * integer so two different hosts agree on it.
 */
function hashToUnitInterval(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // FNV prime 16777619, applied with Math.imul to stay in 32 bits.
    h = Math.imul(h, 0x01000193);
  }
  const unsigned = h >>> 0;
  return unsigned / 0x100000000;
}

function summariseArm(
  arm: Arm,
  armInfo: AbExperimentArm,
  observations: readonly AbObservation[],
): ArmSummary {
  const filtered = observations.filter((o) => o.arm === arm);
  const subjects = new Set<string>();
  let rejected = 0;
  let accepted = 0;
  let undecided = 0;
  for (const o of filtered) {
    subjects.add(o.subject);
    if (o.humanRejected === true) rejected += 1;
    else if (o.humanRejected === false) accepted += 1;
    else undecided += 1;
  }
  return {
    arm,
    promptVersion: armInfo.promptVersion,
    description: armInfo.description,
    observations: filtered.length,
    uniqueSubjects: subjects.size,
    humanRejected: rejected,
    humanAccepted: accepted,
    humanUndecided: undecided,
  };
}

function summariseMetric(
  metric: string,
  unit: MetricSummary["unit"],
  observations: readonly AbObservation[],
  extract: (o: AbObservation) => number | null,
): MetricSummary {
  const a: number[] = [];
  const b: number[] = [];
  for (const o of observations) {
    const v = extract(o);
    if (v === null || !Number.isFinite(v)) continue;
    if (o.arm === "A") a.push(v);
    else if (o.arm === "B") b.push(v);
  }
  const meanA = a.length === 0 ? null : a.reduce((s, x) => s + x, 0) / a.length;
  const meanB = b.length === 0 ? null : b.reduce((s, x) => s + x, 0) / b.length;
  const difference = meanA !== null && meanB !== null ? meanA - meanB : null;
  let relativeDifference: number | null = null;
  if (difference !== null && meanA !== null && meanB !== null) {
    const denom = Math.max(Math.abs(meanA), Math.abs(meanB));
    relativeDifference = denom === 0 ? null : difference / denom;
  }
  let lowerIs: Arm | "equal" | null = null;
  if (meanA !== null && meanB !== null) {
    if (meanA === meanB) lowerIs = "equal";
    else lowerIs = meanA < meanB ? "A" : "B";
  }
  return {
    metric,
    unit,
    meanA,
    meanB,
    difference,
    relativeDifference,
    lowerIs,
    countA: a.length,
    countB: b.length,
  };
}

function extractLatency(o: AbObservation): number | null {
  return o.latencyMs;
}

function extractTokens(o: AbObservation): number | null {
  return o.totalTokens;
}

function extractCost(o: AbObservation): number | null {
  return o.cost;
}

function extractQuality(o: AbObservation): number | null {
  return o.qualityScore;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  hashToUnitInterval,
  validateArms,
  readArm,
  validateWeight,
  summariseArm,
  summariseMetric,
  extractLatency,
  extractTokens,
  extractCost,
  extractQuality,
});
