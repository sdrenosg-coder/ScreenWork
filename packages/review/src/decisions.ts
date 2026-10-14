/**
 * Zipy AI — human-in-the-loop review: approve/edit/reject decisions (phase 19, batch 1).
 *
 * Records and validates the reviewer's answer to a gate produced by
 * `@zipy/review/checkpoints`. A decision is the single point where a human
 * either lets a step run, changes what it will do, rejects it, or defers it.
 *
 * Design boundaries:
 *
 *  - No decision is fabricated. `recordDecision` refuses to invent a reviewer
 *    id, a timestamp, an edited value, or an approval. Every field on a
 *    recorded decision is supplied by the caller from an authenticated
 *    session; the module's job is to validate that the supplied action is one
 *    the gate actually offers, and to produce a normalised, auditable record.
 *
 *  - The module never executes the step. It produces a `DecidedGate` that the
 *    execution loop (`apps/worker/src/runWorkflow.ts`) reads to know whether
 *    to proceed, apply an override value, skip, or abort. Execution is the
 *    automation phase's business.
 *
 *  - The vocabulary is the gate's vocabulary. A `GateAction` the gate did not
 *    list for its risk class is rejected with `action-not-offered`. There is no
 *    path to "approve" a gate whose `actions` list only contains `reject`.
 *
 *  - Approving a batch is approving every step in the batch. Editing a batch
 *    is editing *one* step in it, addressed by step id, so a reviewer can
 *    correct a single mis-filled field without re-opening the whole form.
 *    Applying one edited value to every step in a batch would be a data-loss
 *    bug, so the module requires a `targetStepId` on an `edit` against a
 *    batched gate and refuses an edit without one.
 *
 *  - Rejection does not silently become skip. A rejected step stops the
 *    workflow unless the caller records a subsequent decision; the module
 *    surfaces `blocking: true` on the `DecidedGate` so the loop knows to halt.
 *
 * The module exports:
 *   - `recordDecision` — validate and persist one reviewer decision in memory.
 *   - `recordBatchDecisions` — record decisions for every gate in a plan in a
 *     single ordered pass (used by a batch-approval UI).
 *   - `describeDecision` — stable human text for the review UI / audit log.
 *   - `pendingGates` — the gates in a plan that still lack a decision.
 *   - `summariseDecisions` — counters for the review dashboard.
 *   - `rehydrateDecisionLog` — typed load of a persisted payload.
 *   - `__internals` — the validators, exported for tests.
 */

import {
  type CheckpointGate,
  type CheckpointPlan,
  type GateAction,
} from "./checkpoints.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DecisionsErrorCode =
  | "invalid-input"
  | "unknown-gate"
  | "action-not-offered"
  | "already-decided"
  | "missing-target"
  | "unknown-target-step";

export class DecisionsError extends Error {
  readonly code: DecisionsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DecisionsErrorCode,
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
 * The reviewer's resolved action against a gate. `skip` only appears when the
 * gate's `actions` list includes it (read-only steps gated by caller policy);
 * `edit` only when the risk class permits an edit. See `actionsFor` in
 * `checkpoints.ts` for the mapping.
 */
export const DECISION_TIMINGS = ["live", "pre-run", "post-hoc"] as const;
export type DecisionTiming = (typeof DECISION_TIMINGS)[number];

/**
 * One reviewer decision. `editedValue` is set only when `action` is `edit`;
 * `targetStepId` is required for an `edit` against a batched gate.
 */
export interface ReviewerDecision {
  readonly version: "review-decision/1";
  /** Deterministic id derived from the gate and the reviewer. */
  readonly decisionId: string;
  readonly gateId: string;
  readonly stepIds: readonly string[];
  readonly action: GateAction;
  /** Authenticated reviewer identity. Never invented by the module. */
  readonly reviewerId: string;
  /** ISO 8601 timestamp the caller recorded. Never invented. */
  readonly decidedAt: string;
  /**
   * For an `edit` on a batched gate, the step whose value is being changed.
   * Null otherwise.
   */
  readonly targetStepId: string | null;
  /** The edited value for `edit` decisions; null otherwise. */
  readonly editedValue: string | null;
  /** Free-text note from the reviewer, shown in the audit trail. */
  readonly note: string | null;
  /** When the reviewer answered relative to the run. */
  readonly timing: DecisionTiming;
  /** The gate's risk class at decision time. */
  readonly risk: CheckpointGate["risk"];
}

/** A gate with the decision that was recorded against it. */
export interface DecidedGate {
  readonly gate: CheckpointGate;
  readonly decision: ReviewerDecision;
  /**
   * True when the loop must stop before the next gate. Set for `reject`. A
   * `skip` is not blocking — the step is removed from the plan and the loop
   * proceeds. An `edit` is not blocking — the loop applies the new value.
   */
  readonly blocking: boolean;
  /**
   * True when the loop may proceed past this gate without further pause.
   * False for `reject` and for gates whose decision is missing.
   */
  readonly proceed: boolean;
}

/** The complete decision log for a plan. */
export interface DecisionLog {
  readonly version: "review-decision-log/1";
  readonly workflowId: string | null;
  readonly gates: readonly DecidedGate[];
  /** Gates in the plan whose decision is still missing. */
  readonly pendingGateIds: readonly string[];
  readonly counts: {
    readonly total: number;
    readonly approved: number;
    readonly edited: number;
    readonly rejected: number;
    readonly skipped: number;
    readonly pending: number;
  };
  /**
   * True when at least one decision is `reject`. The execution loop must not
   * proceed while a rejection is unresolved.
   */
  readonly hasBlockingRejection: boolean;
  readonly generatedAt: string;
  readonly aiGenerated: false;
}

export interface RecordDecisionInput {
  readonly plan: CheckpointPlan;
  readonly gateId: string;
  /** The action the reviewer chose. Must be one the gate offers. */
  readonly action: GateAction;
  /** Authenticated reviewer identity. Required and non-empty. */
  readonly reviewerId: string;
  /** ISO 8601 timestamp the caller recorded. Required and non-empty. */
  readonly decidedAt: string;
  /** Required for an `edit` on a batched gate; forbidden otherwise. */
  readonly targetStepId?: string | null;
  /** Required for an `edit`; forbidden otherwise. */
  readonly editedValue?: string | null;
  /** Optional free-text note. */
  readonly note?: string | null;
  /** Defaults to "live". */
  readonly timing?: DecisionTiming;
  /** An already-accumulated log; the new decision is merged into it. */
  readonly existingLog?: DecisionLog | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function recordDecision(input: RecordDecisionInput): DecisionLog {
  if (input === null || typeof input !== "object") {
    throw new DecisionsError("recordDecision requires an inputs object.", "invalid-input");
  }
  const plan = input.plan;
  if (plan === null || typeof plan !== "object" || plan.version !== "checkpoint-plan/1") {
    throw new DecisionsError(
      'recordDecision requires a CheckpointPlan (version "checkpoint-plan/1").',
      "invalid-input",
    );
  }
  if (typeof input.gateId !== "string" || input.gateId.length === 0) {
    throw new DecisionsError("`gateId` is required.", "invalid-input");
  }
  if (typeof input.reviewerId !== "string" || input.reviewerId.trim().length === 0) {
    throw new DecisionsError(
      "`reviewerId` is required and must not be empty — a decision is always attributable.",
      "invalid-input",
    );
  }
  if (typeof input.decidedAt !== "string" || input.decidedAt.trim().length === 0) {
    throw new DecisionsError(
      "`decidedAt` is required — the caller records the timestamp.",
      "invalid-input",
    );
  }
  const timing: DecisionTiming =
    input.timing === "pre-run" || input.timing === "post-hoc" ? input.timing : "live";
  if (!isGateAction(input.action)) {
    throw new DecisionsError(
      `Unknown action "${String(input.action)}".`,
      "invalid-input",
      { action: input.action },
    );
  }

  const gate = plan.gates.find((g) => g.gateId === input.gateId);
  if (gate === undefined) {
    throw new DecisionsError(
      `The plan contains no gate with id "${input.gateId}".`,
      "unknown-gate",
      { gateId: input.gateId },
    );
  }

  if (!gate.actions.includes(input.action)) {
    throw new DecisionsError(
      `Gate ${gate.gateId} (risk "${gate.risk}") offers [${gate.actions.join(", ")}]; action "${input.action}" is not permitted.`,
      "action-not-offered",
      {
        gateId: gate.gateId,
        risk: gate.risk,
        offered: gate.actions,
        requested: input.action,
      },
    );
  }

  // Edit-specific validation.
  const targetStepId = nonEmpty(input.targetStepId);
  const editedValue = typeof input.editedValue === "string" ? input.editedValue : null;
  if (input.action === "edit") {
    if (editedValue === null || editedValue.trim().length === 0) {
      throw new DecisionsError(
        'An "edit" action must supply a non-empty `editedValue`.',
        "invalid-input",
        { gateId: gate.gateId },
      );
    }
    if (gate.batched && targetStepId === null) {
      throw new DecisionsError(
        `Gate ${gate.gateId} is batched (${gate.stepIds.length} steps); an "edit" must name the step it applies to.`,
        "missing-target",
        { gateId: gate.gateId, stepIds: gate.stepIds },
      );
    }
    if (targetStepId !== null && !gate.stepIds.includes(targetStepId)) {
      throw new DecisionsError(
        `Gate ${gate.gateId} does not cover a step with id "${targetStepId}".`,
        "unknown-target-step",
        { gateId: gate.gateId, targetStepId, stepIds: gate.stepIds },
      );
    }
  } else {
    // A non-edit decision must not carry edit-only fields.
    if (targetStepId !== null) {
      throw new DecisionsError(
        `\`targetStepId\` is only valid for an "edit" decision; action was "${input.action}".`,
        "invalid-input",
        { gateId: gate.gateId, action: input.action },
      );
    }
    if (editedValue !== null) {
      throw new DecisionsError(
        `\`editedValue\` is only valid for an "edit" decision; action was "${input.action}".`,
        "invalid-input",
        { gateId: gate.gateId, action: input.action },
      );
    }
  }

  const decision: ReviewerDecision = {
    version: "review-decision/1",
    decisionId: decisionIdFor(gate.gateId, input.reviewerId, input.decidedAt),
    gateId: gate.gateId,
    stepIds: Object.freeze([...gate.stepIds]),
    action: input.action,
    reviewerId: input.reviewerId.trim(),
    decidedAt: input.decidedAt.trim(),
    targetStepId: input.action === "edit" ? targetStepId : null,
    editedValue: input.action === "edit" ? editedValue : null,
    note: nonEmpty(input.note),
    timing,
    risk: gate.risk,
  };

  const decided: DecidedGate = {
    gate,
    decision,
    blocking: input.action === "reject",
    proceed: input.action !== "reject",
  };

  // Build the merge target: the existing log (if supplied) minus any prior
  // decision for this gate, plus the new decision.
  const base = input.existingLog ?? emptyLog(plan);
  const merged = mergeDecision(base, decided, plan);
  return merged;
}

/**
 * Record decisions for every gate in a plan in a single ordered pass. Used by
 * a batch-approval UI that submits one decision per gate up front. Gates the
 * caller does not name remain pending; the caller cannot accidentally
 * auto-approve a gate by omission.
 */
export function recordBatchDecisions(input: {
  readonly plan: CheckpointPlan;
  readonly decisions: readonly {
    readonly gateId: string;
    readonly action: GateAction;
    readonly reviewerId: string;
    readonly decidedAt: string;
    readonly targetStepId?: string | null;
    readonly editedValue?: string | null;
    readonly note?: string | null;
    readonly timing?: DecisionTiming;
  }[];
}): DecisionLog {
  if (input === null || typeof input !== "object") {
    throw new DecisionsError("recordBatchDecisions requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.decisions)) {
    throw new DecisionsError("`decisions` must be an array.", "invalid-input");
  }
  let log: DecisionLog = emptyLog(input.plan);
  for (const d of input.decisions) {
    log = recordDecision({
      plan: input.plan,
      gateId: d.gateId,
      action: d.action,
      reviewerId: d.reviewerId,
      decidedAt: d.decidedAt,
      targetStepId: d.targetStepId ?? null,
      editedValue: d.editedValue ?? null,
      note: d.note ?? null,
      timing: d.timing,
      existingLog: log,
    });
  }
  return log;
}

/**
 * Stable human sentence for the review UI. The wording is versioned with the
 * plan so a screenshot in a help article does not drift between releases.
 */
export function describeDecision(decided: DecidedGate): string {
  const { gate, decision } = decided;
  const reviewer = decision.reviewerId;
  switch (decision.action) {
    case "approve":
      return gate.batched
        ? `Reviewer "${reviewer}" approved the batch of ${gate.stepIds.length} steps (risk "${gate.risk}").`
        : `Reviewer "${reviewer}" approved step(s) ${gate.stepIndices.join(", ")} (risk "${gate.risk}").`;
    case "edit": {
      const where = decision.targetStepId !== null ? ` step "${decision.targetStepId}"` : "";
      return `Reviewer "${reviewer}" approved the gate and edited${where} to a new value (risk "${gate.risk}").`;
    }
    case "reject":
      return `Reviewer "${reviewer}" rejected step(s) ${gate.stepIndices.join(", ")} (risk "${gate.risk}"); the workflow stops here.`;
    case "skip":
      return `Reviewer "${reviewer}" skipped step(s) ${gate.stepIndices.join(", ")}; they will be omitted from the run.`;
  }
}

/**
 * The gates in a plan whose decision has not been recorded. Preserves plan
 * order so a review UI can present them in execution order.
 */
export function pendingGates(
  plan: CheckpointPlan,
  log: DecisionLog,
): readonly CheckpointGate[] {
  const decided = new Set(log.gates.map((d) => d.gate.gateId));
  return plan.gates.filter((g) => g.decision === "approve" && !decided.has(g.gateId));
}

/**
 * Counters for the review dashboard. Returned as a plain object so the
 * dashboard can render it without depending on the log shape.
 */
export function summariseDecisions(log: DecisionLog): DecisionLog["counts"] {
  if (log === null || typeof log !== "object" || log.version !== "review-decision-log/1") {
    throw new DecisionsError(
      'summariseDecisions requires a DecisionLog (version "review-decision-log/1").',
      "invalid-input",
    );
  }
  return log.counts;
}

export function rehydrateDecisionLog(value: unknown): DecisionLog {
  if (value === null || typeof value !== "object") {
    throw new DecisionsError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "review-decision-log/1") {
    throw new DecisionsError(
      `Rehydrate failed: expected version "review-decision-log/1", received "${String(r["version"])}".`,
      "invalid-input",
    );
  }
  const gatesRaw = Array.isArray(r["gates"]) ? r["gates"] : [];
  const gates: DecidedGate[] = [];
  for (const item of gatesRaw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const gateRaw = o["gate"];
    if (gateRaw === null || typeof gateRaw !== "object") continue;
    const g = gateRaw as Record<string, unknown>;
    const actionsRaw = Array.isArray(g["actions"]) ? g["actions"] : [];
    const actions: GateAction[] = [];
    for (const a of actionsRaw) {
      if (a === "approve" || a === "edit" || a === "reject" || a === "skip") actions.push(a);
    }
    const gate: CheckpointGate = {
      gateId: typeof g["gateId"] === "string" ? g["gateId"] : "",
      stepIds: readStringArray(g["stepIds"]),
      stepIndices: readNumberArray(g["stepIndices"]),
      risk:
        g["risk"] === "read-only" ||
        g["risk"] === "write" ||
        g["risk"] === "destructive" ||
        g["risk"] === "financial" ||
        g["risk"] === "external-communication"
          ? g["risk"]
          : "read-only",
      decision: g["decision"] === "approve" ? "approve" : "run",
      actions: Object.freeze(actions),
      summary: typeof g["summary"] === "string" ? g["summary"] : "",
      reasons: [],
      batched: g["batched"] === true,
    };
    const dRaw = o["decision"];
    if (dRaw === null || typeof dRaw !== "object") continue;
    const d = dRaw as Record<string, unknown>;
    const action: GateAction =
      d["action"] === "edit" || d["action"] === "reject" || d["action"] === "skip"
        ? d["action"]
        : "approve";
    const timing: DecisionTiming =
      d["timing"] === "pre-run" || d["timing"] === "post-hoc" ? d["timing"] : "live";
    const decision: ReviewerDecision = {
      version: "review-decision/1",
      decisionId: typeof d["decisionId"] === "string" ? d["decisionId"] : "",
      gateId: typeof d["gateId"] === "string" ? d["gateId"] : "",
      stepIds: readStringArray(d["stepIds"]),
      action,
      reviewerId: typeof d["reviewerId"] === "string" ? d["reviewerId"] : "",
      decidedAt: typeof d["decidedAt"] === "string" ? d["decidedAt"] : "",
      targetStepId: typeof d["targetStepId"] === "string" ? d["targetStepId"] : null,
      editedValue: typeof d["editedValue"] === "string" ? d["editedValue"] : null,
      note: typeof d["note"] === "string" ? d["note"] : null,
      timing,
      risk: gate.risk,
    };
    gates.push({
      gate,
      decision,
      blocking: o["blocking"] === true,
      proceed: o["proceed"] === true,
    });
  }
  const counts = readCounts(r["counts"]);
  return {
    version: "review-decision-log/1",
    workflowId: typeof r["workflowId"] === "string" ? r["workflowId"] : null,
    gates,
    pendingGateIds: readStringArray(r["pendingGateIds"]),
    counts,
    hasBlockingRejection: gates.some((g) => g.blocking),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function emptyLog(plan: CheckpointPlan): DecisionLog {
  return finaliseLog(plan, []);
}

function mergeDecision(
  log: DecisionLog,
  decided: DecidedGate,
  plan: CheckpointPlan,
): DecisionLog {
  // A gate can only carry one decision; a second attempt at the same gate is
  // a state error so a reviewer cannot silently overwrite an audit entry.
  const existing = log.gates.find((g) => g.gate.gateId === decided.gate.gateId);
  if (existing !== undefined) {
    throw new DecisionsError(
      `Gate ${decided.gate.gateId} has already been decided by "${existing.decision.reviewerId}" at ${existing.decision.decidedAt}.`,
      "already-decided",
      { gateId: decided.gate.gateId },
    );
  }
  return finaliseLog(plan, [...log.gates, decided]);
}

function finaliseLog(plan: CheckpointPlan, gates: readonly DecidedGate[]): DecisionLog {
  const decidedIds = new Set(gates.map((g) => g.gate.gateId));
  const pendingGateIds: string[] = [];
  for (const g of plan.gates) {
    if (g.decision !== "approve") continue;
    if (!decidedIds.has(g.gateId)) pendingGateIds.push(g.gateId);
  }
  const counts = {
    total: plan.gates.filter((g) => g.decision === "approve").length,
    approved: gates.filter((g) => g.decision.action === "approve").length,
    edited: gates.filter((g) => g.decision.action === "edit").length,
    rejected: gates.filter((g) => g.decision.action === "reject").length,
    skipped: gates.filter((g) => g.decision.action === "skip").length,
    pending: pendingGateIds.length,
  };
  return {
    version: "review-decision-log/1",
    workflowId: plan.workflowId,
    gates: Object.freeze([...gates]),
    pendingGateIds: Object.freeze(pendingGateIds),
    counts,
    hasBlockingRejection: gates.some((g) => g.blocking),
    generatedAt: new Date().toISOString(),
    aiGenerated: false,
  };
}

function isGateAction(v: unknown): v is GateAction {
  return v === "approve" || v === "edit" || v === "reject" || v === "skip";
}

function decisionIdFor(gateId: string, reviewerId: string, decidedAt: string): string {
  const h = fnv1a32(`${gateId}|${reviewerId}|${decidedAt}`).toString(16).padStart(8, "0");
  return `dec_${h}`;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
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

function readCounts(v: unknown): DecisionLog["counts"] {
  const fallback: DecisionLog["counts"] = {
    total: 0,
    approved: 0,
    edited: 0,
    rejected: 0,
    skipped: 0,
    pending: 0,
  };
  if (v === null || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  const read = (k: keyof DecisionLog["counts"]): number => {
    const val = o[k];
    return typeof val === "number" && Number.isFinite(val) ? Math.max(0, Math.floor(val)) : 0;
  };
  return {
    total: read("total"),
    approved: read("approved"),
    edited: read("edited"),
    rejected: read("rejected"),
    skipped: read("skipped"),
    pending: read("pending"),
  };
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
  emptyLog,
  mergeDecision,
  finaliseLog,
  isGateAction,
  decisionIdFor,
  fnv1a32,
  readStringArray,
  readNumberArray,
  readCounts,
});
