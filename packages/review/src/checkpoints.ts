/**
 * Zipy AI — human-in-the-loop review: checkpoint gating (phase 19, batch 0).
 *
 * Given the risk classification produced by `@zipy/review/riskClass`, this
 * module decides, per step, whether the execution loop must pause for a human:
 *
 *   - It turns a workspace's *review policy* into a concrete gate decision.
 *   - It records, on each gated step, the reason the gate exists, the risk
 *     class that triggered it, and the actions the reviewer may take.
 *   - It groups consecutive gated steps that belong to a single form into one
 *     *batch gate* (batch approval, feature 23) so the reader is asked once,
 *     not once per field.
 *
 * Design rules honoured:
 *
 *  - Deterministic. The same plan + the same policy produces the same gate
 *    list; the production of batch groups is order-stable.
 *
 *  - The policy is *data*. Every threshold, batch-window and override is
 *    supplied by the caller. The module invents no default beyond the
 *    documented ones, and every default is named so the reviewer can see it.
 *
 *  - Review mode can be disabled. When the caller passes `enabled: false`
 *    every step becomes a `run` decision; the module still returns one
 *    decision per step so the audit trail records that gating was evaluated
 *    and had no effect. It never drops a step.
 *
 *  - Destructive steps are gated even when batching is on. A batch approval
 *    is for forms, not for a sequence that includes a delete; the module
 *    splits a batch when the next step's risk is at or above the destructive
 *    threshold.
 *
 *  - No approval is fabricated. The module produces `pending` gates; the
 *    decisions layer (`@zipy/review/decisions`) records the reviewer's
 *    action and the audit layer (`@zipy/review/audit`) records the trail.
 *    This module never marks its own output as decided.
 *
 * The module exports:
 *   - `planCheckpoints` — the primary entry point.
 *   - `makePolicy` — a constructor for the policy with defaults documented.
 *   - `describeGate` — human-readable sentence for the review UI.
 *   - `rehydrateCheckpointPlan` — typed load of a persisted payload.
 *   - `__internals` — the batch-grouping helpers, exported for tests.
 */

import {
  classifyOneStep,
  RISK_RANK,
  type ClassifiableStep,
  type RiskClass,
  type RiskClassification,
} from "./riskClass.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type CheckpointsErrorCode = "invalid-input" | "unknown-policy-value";

export class CheckpointsError extends Error {
  readonly code: CheckpointsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: CheckpointsErrorCode,
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
 * The reviewer action a gate is asking for. `run` means "proceed without a
 * human", `approve` means "ask the reviewer before executing". The vocabulary
 * is deliberately narrow; a future decision verb (like `edit`) is added to
 * the decisions layer, not here.
 */
export const CHECKPOINT_DECISIONS = ["run", "approve"] as const;
export type CheckpointDecision = (typeof CHECKPOINT_DECISIONS)[number];

/**
 * What the reviewer may do with a gate. This is *advisory metadata* the UI
 * uses to render buttons; the decisions layer validates the reviewer's action
 * against it and rejects a disallowed one.
 */
export const GATE_ACTIONS = ["approve", "edit", "reject", "skip"] as const;
export type GateAction = (typeof GATE_ACTIONS)[number];

export interface CheckpointPolicy {
  readonly version: "checkpoint-policy/1";
  /** When false, every step becomes a `run` decision. */
  readonly enabled: boolean;
  /**
   * The lowest risk class that requires a human. Steps *below* this threshold
   * run freely; steps *at or above* it pause.
   */
  readonly thresholds: {
    readonly write: GateMode;
    readonly destructive: GateMode;
    readonly financial: GateMode;
    readonly externalCommunication: GateMode;
  };
  /**
   * Maximum number of consecutive same-form steps that coalesce into one
   * batch gate (batch approval). A value of 1 disables batching.
   */
  readonly batchWindow: number;
  /**
   * Risk classes that never coalesce into a batch. Destructive is default.
   */
  readonly batchExcludes: readonly RiskClass[];
  /**
   * Per-step overrides, keyed by step id. Used when a workflow's step id is
   * known to be safe or hazardous regardless of the classifier.
   */
  readonly overrides: Readonly<Record<string, CheckpointOverride>>;
}

/**
 * A workspace's policy value for one risk class. `gate` = always pause;
 * `batch` = pause only as part of a batch decision, not individually;
 * `run` = never pause.
 */
export const GATE_MODES = ["run", "batch", "gate"] as const;
export type GateMode = (typeof GATE_MODES)[number];

export interface CheckpointOverride {
  readonly mode: GateMode;
  /** Free-text justification shown in the audit entry. */
  readonly reason: string;
}

export interface CheckpointPlanInput {
  readonly workflowId: string | null;
  readonly steps: readonly ClassifiableStep[];
  /** Origin of the app under test; forwarded to the classifier. */
  readonly workflowOrigin: string | null;
  /** The workspace's policy. Use `makePolicy` to build one with defaults. */
  readonly policy: CheckpointPolicy;
  /** Optional pre-computed classification report; recomputed when absent. */
  readonly riskReport?: readonly RiskClassification[];
}

export interface CheckpointGate {
  /** Stable, deterministic id derived from the group's step ids. */
  readonly gateId: string;
  /** Every step that shares this gate, in execution order. */
  readonly stepIds: readonly string[];
  /** 1-based indices of the steps covered, for the review UI's numbering. */
  readonly stepIndices: readonly number[];
  /** The highest risk class across the group's steps. */
  readonly risk: RiskClass;
  /** The gate's `run`/`approve` decision. */
  readonly decision: CheckpointDecision;
  /**
   * When the gate is an `approve` gate, one or more actions the reviewer may
   * take. `run` gates carry an empty list.
   */
  readonly actions: readonly GateAction[];
  /** Human-readable summary shown in the review UI. */
  readonly summary: string;
  /** Structured reasons each step's classification contributed. */
  readonly reasons: readonly CheckpointReason[];
  /** True when this gate was created by a batch merge. */
  readonly batched: boolean;
}

export interface CheckpointReason {
  readonly stepId: string;
  readonly risk: RiskClass;
  readonly override: CheckpointOverride | null;
  /** The gate mode applied for this step. */
  readonly mode: GateMode;
  readonly detail: string;
}

export interface CheckpointPlan {
  readonly version: "checkpoint-plan/1";
  readonly workflowId: string | null;
  readonly enabled: boolean;
  readonly gates: readonly CheckpointGate[];
  /** True when at least one gate requires a human decision. */
  readonly hasApprovalGates: boolean;
  /** Counts by decision, for a dashboard tile. */
  readonly counts: { readonly run: number; readonly approve: number };
  readonly generatedAt: string;
  readonly aiGenerated: false;
}

/* -------------------------------------------------------------------------- */
/* Policy constructor                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build a policy with the documented defaults applied. Any field the caller
 * supplies overrides the default. Every default is intentional:
 *
 *   - `write` defaults to `batch`, because a form is normally filled and
 *     submitted in one go; the reviewer approves the whole form at once.
 *   - `destructive`, `financial` and `externalCommunication` default to
 *     `gate`, because each of those classes has consequences the reviewer
 *     cannot infer from a screenshot.
 *   - `batchWindow` defaults to 12, which is enough to cover the longest form
 *     the tool has been configured against (the customer-onboarding form is
 *     11 fields today).
 *   - The default `batchExcludes` list contains only `destructive`, matching
 *     the "batch is for forms, not for deletes" rule.
 */
export function makePolicy(overrides?: Partial<Omit<CheckpointPolicy, "version">>): CheckpointPolicy {
  const defaults: CheckpointPolicy = {
    version: "checkpoint-policy/1",
    enabled: true,
    thresholds: {
      write: "batch",
      destructive: "gate",
      financial: "gate",
      externalCommunication: "gate",
    },
    batchWindow: 12,
    batchExcludes: ["destructive"],
    overrides: {},
  };
  if (overrides === undefined || overrides === null) return defaults;
  return validatePolicy({
    version: "checkpoint-policy/1",
    enabled: typeof overrides.enabled === "boolean" ? overrides.enabled : defaults.enabled,
    thresholds: {
      write: normaliseGateMode(overrides.thresholds?.write, defaults.thresholds.write),
      destructive: normaliseGateMode(overrides.thresholds?.destructive, defaults.thresholds.destructive),
      financial: normaliseGateMode(overrides.thresholds?.financial, defaults.thresholds.financial),
      externalCommunication: normaliseGateMode(
        overrides.thresholds?.externalCommunication,
        defaults.thresholds.externalCommunication,
      ),
    },
    batchWindow: normaliseBatchWindow(overrides.batchWindow, defaults.batchWindow),
    batchExcludes: normaliseBatchExcludes(overrides.batchExcludes, defaults.batchExcludes),
    overrides: normaliseOverrides(overrides.overrides, defaults.overrides),
  });
}

function validatePolicy(policy: CheckpointPolicy): CheckpointPolicy {
  if (policy.batchWindow < 1) {
    throw new CheckpointsError(
      `batchWindow must be at least 1; received ${policy.batchWindow}.`,
      "unknown-policy-value",
      { batchWindow: policy.batchWindow },
    );
  }
  return policy;
}

function normaliseGateMode(v: unknown, fallback: GateMode): GateMode {
  if (v === "run" || v === "batch" || v === "gate") return v;
  return fallback;
}

function normaliseBatchWindow(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  return n < 1 ? 1 : n;
}

function normaliseBatchExcludes(
  v: unknown,
  fallback: readonly RiskClass[],
): readonly RiskClass[] {
  if (!Array.isArray(v)) return fallback;
  const out: RiskClass[] = [];
  for (const item of v) {
    if (
      item === "read-only" ||
      item === "write" ||
      item === "destructive" ||
      item === "financial" ||
      item === "external-communication"
    ) {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

function normaliseOverrides(
  v: unknown,
  fallback: Readonly<Record<string, CheckpointOverride>>,
): Readonly<Record<string, CheckpointOverride>> {
  if (v === null || typeof v !== "object") return fallback;
  const out: Record<string, CheckpointOverride> = {};
  for (const [stepId, entry] of Object.entries(v as Record<string, unknown>)) {
    if (typeof stepId !== "string" || stepId.length === 0) continue;
    if (entry === null || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const mode = normaliseGateMode(o["mode"], "gate");
    const reason = typeof o["reason"] === "string" ? o["reason"].trim() : "";
    out[stepId] = { mode, reason: reason.length > 0 ? reason : "override supplied by the workspace policy" };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function planCheckpoints(input: CheckpointPlanInput): CheckpointPlan {
  if (input === null || typeof input !== "object") {
    throw new CheckpointsError("planCheckpoints requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.steps)) {
    throw new CheckpointsError("`steps` must be an array.", "invalid-input");
  }
  if (input.policy === null || typeof input.policy !== "object") {
    throw new CheckpointsError("`policy` is required.", "invalid-input");
  }
  const policy = input.policy;
  const steps = input.steps;
  const riskReport = input.riskReport !== undefined && input.riskReport !== null
    ? input.riskReport
    : steps.map((s, i) => classifyOneStep(s, i, input.workflowOrigin ?? null));

  // Index the risk by step id so overrides and merges can consult it.
  const riskByStepId = new Map<string, RiskClassification>();
  for (const r of riskReport) riskByStepId.set(r.stepId, r);

  /* ---------- Decide per-step mode ------------------------------------- */
  interface PendingStep {
    readonly id: string;
    readonly index: number;
    readonly risk: RiskClass;
    readonly override: CheckpointOverride | null;
    readonly mode: GateMode;
    readonly detail: string;
  }
  const pending: PendingStep[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const stepId = typeof step.id === "string" && step.id.length > 0 ? step.id : `step-${i + 1}`;
    const risk = riskByStepId.get(stepId)?.risk ?? "read-only";
    const override = policy.overrides[stepId] ?? null;
    const mode = effectiveMode(policy, stepId, risk, override);
    pending.push({
      id: stepId,
      index: i + 1,
      risk,
      override,
      mode,
      detail: override !== null
        ? `Workspace policy override: ${override.reason}`
        : `Risk class "${risk}" is governed by policy mode "${mode}".`,
    });
  }

  /* ---------- Merge into gates ----------------------------------------- */
  const gates: CheckpointGate[] = [];
  const reviewEnabled = policy.enabled !== false;

  // When review mode is disabled, every step is its own `run` gate — no
  // batching because there is nothing to batch for.
  if (!reviewEnabled) {
    for (const p of pending) {
      gates.push({
        gateId: gateIdFor([p.id]),
        stepIds: [p.id],
        stepIndices: [p.index],
        risk: p.risk,
        decision: "run",
        actions: [],
        summary: "Review mode is disabled; step executes without approval.",
        reasons: [
          {
            stepId: p.id,
            risk: p.risk,
            override: p.override,
            mode: p.mode,
            detail: "Review mode is disabled by the workspace policy.",
          },
        ],
        batched: false,
      });
    }
    return finalisePlan(input.workflowId, false, gates);
  }

  let cursor = 0;
  while (cursor < pending.length) {
    const head = pending[cursor]!;
    if (head.mode === "run") {
      gates.push(singleRunGate(head));
      cursor += 1;
      continue;
    }
    if (head.mode === "gate") {
      gates.push(singleApproveGate(head, /*batched*/ false));
      cursor += 1;
      continue;
    }
    // head.mode === "batch": grow a run of same-form steps up to the window.
    const group: PendingStep[] = [head];
    let next = cursor + 1;
    while (next < pending.length && group.length < policy.batchWindow) {
      const candidate = pending[next]!;
      if (candidate.mode !== "batch") break;
      if (policy.batchExcludes.includes(candidate.risk)) break;
      group.push(candidate);
      next += 1;
    }
    // A group of one is still a gate; it just isn't meaningfully batched.
    gates.push(batchGate(group));
    cursor = next;
  }

  return finalisePlan(input.workflowId, true, gates);
}

/**
 * Human-readable, stable sentence for a gate. Used by the review UI directly;
 * the wording is versioned with the plan so a help article does not drift.
 */
export function describeGate(gate: CheckpointGate, plan: CheckpointPlan): string {
  if (gate.decision === "run") {
    return gate.summary;
  }
  const subject = gate.batched
    ? `A form with ${gate.stepIds.length} fields`
    : `Step ${gate.stepIndices[0]}`;
  switch (gate.risk) {
    case "destructive":
      return `${subject} performs a destructive action; the reviewer must approve before it runs.`;
    case "financial":
      return `${subject} moves money or changes a billing plan; the reviewer must approve before it runs.`;
    case "external-communication":
      return `${subject} sends a message outside the workspace; the reviewer must approve before it runs.`;
    case "write":
      return gate.batched
        ? `${subject} will be filled in and submitted; the reviewer approves the batch once.`
        : `${subject} changes application data; the reviewer must approve before it runs.`;
    case "read-only":
      return `${subject} does not change state; it should run without approval but is gated by the caller.`;
  }
}

export function rehydrateCheckpointPlan(value: unknown): CheckpointPlan {
  if (value === null || typeof value !== "object") {
    throw new CheckpointsError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "checkpoint-plan/1") {
    throw new CheckpointsError(
      `Rehydrate failed: expected version "checkpoint-plan/1", received "${String(r["version"])}".`,
      "invalid-input",
    );
  }
  const gatesRaw = Array.isArray(r["gates"]) ? r["gates"] : [];
  const gates: CheckpointGate[] = [];
  for (const g of gatesRaw) {
    if (g === null || typeof g !== "object") continue;
    const o = g as Record<string, unknown>;
    gates.push({
      gateId: typeof o["gateId"] === "string" ? o["gateId"] : "",
      stepIds: readStringArray(o["stepIds"]),
      stepIndices: readNumberArray(o["stepIndices"]),
      risk: readRiskClass(o["risk"]),
      decision: o["decision"] === "approve" ? "approve" : "run",
      actions: readGateActions(o["actions"]),
      summary: typeof o["summary"] === "string" ? o["summary"] : "",
      reasons: readReasons(o["reasons"]),
      batched: o["batched"] === true,
    });
  }
  const run = gates.filter((g) => g.decision === "run").length;
  const approve = gates.filter((g) => g.decision === "approve").length;
  return {
    version: "checkpoint-plan/1",
    workflowId: typeof r["workflowId"] === "string" ? r["workflowId"] : null,
    enabled: r["enabled"] === true,
    gates,
    hasApprovalGates: approve > 0,
    counts: { run, approve },
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function effectiveMode(
  policy: CheckpointPolicy,
  stepId: string,
  risk: RiskClass,
  override: CheckpointOverride | null,
): GateMode {
  if (override !== null) return override.mode;
  switch (risk) {
    case "read-only":
      return "run";
    case "write":
      return policy.thresholds.write;
    case "destructive":
      return policy.thresholds.destructive;
    case "financial":
      return policy.thresholds.financial;
    case "external-communication":
      return policy.thresholds.externalCommunication;
  }
}

function singleRunGate(p: {
  readonly id: string;
  readonly index: number;
  readonly risk: RiskClass;
  readonly override: CheckpointOverride | null;
  readonly mode: GateMode;
  readonly detail: string;
}): CheckpointGate {
  return {
    gateId: gateIdFor([p.id]),
    stepIds: [p.id],
    stepIndices: [p.index],
    risk: p.risk,
    decision: "run",
    actions: [],
    summary: "Step runs without approval.",
    reasons: [
      {
        stepId: p.id,
        risk: p.risk,
        override: p.override,
        mode: p.mode,
        detail: p.detail,
      },
    ],
    batched: false,
  };
}

function singleApproveGate(
  p: {
    readonly id: string;
    readonly index: number;
    readonly risk: RiskClass;
    readonly override: CheckpointOverride | null;
    readonly mode: GateMode;
    readonly detail: string;
  },
  batched: boolean,
): CheckpointGate {
  return {
    gateId: gateIdFor([p.id]),
    stepIds: [p.id],
    stepIndices: [p.index],
    risk: p.risk,
    decision: "approve",
    actions: actionsFor(p.risk),
    summary: summaryFor(p.risk, 1, false),
    reasons: [
      {
        stepId: p.id,
        risk: p.risk,
        override: p.override,
        mode: p.mode,
        detail: p.detail,
      },
    ],
    batched,
  };
}

function batchGate(group: readonly {
  readonly id: string;
  readonly index: number;
  readonly risk: RiskClass;
  readonly override: CheckpointOverride | null;
  readonly mode: GateMode;
  readonly detail: string;
}[]): CheckpointGate {
  const highest = group.reduce<RiskClass>(
    (acc, p) => (RISK_RANK[p.risk] > RISK_RANK[acc] ? p.risk : acc),
    "read-only",
  );
  return {
    gateId: gateIdFor(group.map((p) => p.id)),
    stepIds: group.map((p) => p.id),
    stepIndices: group.map((p) => p.index),
    risk: highest,
    decision: "approve",
    actions: actionsFor(highest),
    summary: summaryFor(highest, group.length, /*batched*/ group.length > 1),
    reasons: group.map((p) => ({
      stepId: p.id,
      risk: p.risk,
      override: p.override,
      mode: p.mode,
      detail: p.detail,
    })),
    batched: group.length > 1,
  };
}

function actionsFor(risk: RiskClass): readonly GateAction[] {
  switch (risk) {
    case "read-only":
      // A read-only step gated by an explicit policy or override can still
      // be skipped, since nothing changes.
      return ["approve", "skip", "reject"];
    case "write":
      return ["approve", "edit", "reject"];
    case "destructive":
      return ["approve", "reject"];
    case "financial":
      return ["approve", "reject"];
    case "external-communication":
      return ["approve", "edit", "reject"];
  }
}

function summaryFor(risk: RiskClass, stepCount: number, batched: boolean): string {
  const subject = batched
    ? `Batch of ${stepCount} steps`
    : stepCount === 1
      ? "Step"
      : `Batch of ${stepCount} steps`;
  switch (risk) {
    case "read-only":
      return `${subject} is gated by the caller's policy; no state change will occur.`;
    case "write":
      return batched
        ? `${subject} fills a form; the reviewer approves the batch once.`
        : `${subject} changes application data; approve before it runs.`;
    case "destructive":
      return `${subject} removes or revokes data; approve before it runs.`;
    case "financial":
      return `${subject} moves money or changes a billing plan; approve before it runs.`;
    case "external-communication":
      return `${subject} sends a message outside the workspace; approve before it runs.`;
  }
}

function gateIdFor(stepIds: readonly string[]): string {
  // Deterministic: a fixed prefix and the join of the contributing step ids.
  // A gate whose step set changes gets a new id, which is what the audit
  // trail wants — the reviewer's decision attaches to a stable tuple.
  const joined = stepIds.join("+");
  const h = fnv1a32(joined).toString(16).padStart(8, "0");
  return `gate_${h}`;
}

function finalisePlan(
  workflowId: string | null,
  enabled: boolean,
  gates: readonly CheckpointGate[],
): CheckpointPlan {
  const run = gates.filter((g) => g.decision === "run").length;
  const approve = gates.filter((g) => g.decision === "approve").length;
  return {
    version: "checkpoint-plan/1",
    workflowId: nonEmpty(workflowId),
    enabled,
    gates: Object.freeze([...gates]),
    hasApprovalGates: approve > 0,
    counts: { run, approve },
    generatedAt: new Date().toISOString(),
    aiGenerated: false,
  };
}

function readStringArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((i): i is string => typeof i === "string" && i.length > 0);
}

function readNumberArray(v: unknown): readonly number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const item of v) {
    if (typeof item === "number" && Number.isFinite(item)) out.push(Math.max(1, Math.floor(item)));
  }
  return out;
}

function readRiskClass(v: unknown): RiskClass {
  return v === "read-only" ||
    v === "write" ||
    v === "destructive" ||
    v === "financial" ||
    v === "external-communication"
    ? v
    : "read-only";
}

function readGateActions(v: unknown): readonly GateAction[] {
  if (!Array.isArray(v)) return [];
  const out: GateAction[] = [];
  for (const item of v) {
    if (item === "approve" || item === "edit" || item === "reject" || item === "skip") {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

function readReasons(v: unknown): readonly CheckpointReason[] {
  if (!Array.isArray(v)) return [];
  const out: CheckpointReason[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const overrideRaw = o["override"];
    const override: CheckpointOverride | null = (() => {
      if (overrideRaw === null || typeof overrideRaw !== "object") return null;
      const oo = overrideRaw as Record<string, unknown>;
      const mode = normaliseGateMode(oo["mode"], "gate");
      return {
        mode,
        reason: typeof oo["reason"] === "string" ? oo["reason"] : "",
      };
    })();
    out.push({
      stepId: typeof o["stepId"] === "string" ? o["stepId"] : "",
      risk: readRiskClass(o["risk"]),
      override,
      mode: normaliseGateMode(o["mode"], "gate"),
      detail: typeof o["detail"] === "string" ? o["detail"] : "",
    });
  }
  return out;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  effectiveMode,
  singleRunGate,
  singleApproveGate,
  batchGate,
  actionsFor,
  summaryFor,
  gateIdFor,
  fnv1a32,
  normaliseGateMode,
  normaliseBatchWindow,
  normaliseBatchExcludes,
  normaliseOverrides,
  readRiskClass,
  readReasons,
});
