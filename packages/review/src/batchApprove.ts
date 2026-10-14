/**
 * Zipy AI — human-in-the-loop review: batch form approval (phase 19, batch 1).
 *
 * Turns a group of gated write steps (a filled form) into a single approval
 * package a reviewer accepts or rejects in one action. It exists because the
 * checkpoint layer groups fields into a batch gate, but a reviewer needs to
 * *see* what the batch will submit — every field, every value, and where each
 * value came from — before they approve.
 *
 * Design boundaries:
 *
 *  - The module reads the plan, the gate plan, and the proposed actions from
 *    the caller. It never invents a value, a field name, or a source. Every
 *    field in a package is one a plan step will actually type, select, or
 *    toggle.
 *
 *  - The package is presentation + a single decision. The submit decision is
 *    recorded through `@zipy/review/decisions`, not here, so there is exactly
 *    one decision path and one audit entry per gate.
 *
 *  - A package never mixes gates. If two batched gates are adjacent in the
 *    plan (a policy that batches only write steps sits between a form and a
 *    delete), each gets its own package. Combining them would let a reviewer
 *    approve a destructive step under a "this is a form" headline.
 *
 *  - A package can be "invalid": two steps assigning the same field, a
 *    required field with no value, or a value the plan derived from a source
 *    marked superseded. An invalid package cannot be submitted without an
 *    explicit reviewer override; the module says which rule fired and why.
 *
 *  - Deterministic. The same inputs produce the same field order, the same
 *    package ids, and the same validation notes. Field order follows the
 *    plan's step order; the package id is derived from the contributing
 *    gate's id.
 *
 * The module exports:
 *   - `buildBatchPackages` — the primary entry point.
 *   - `applyBatchDecision` — reject/approve an entire package at once.
 *   - `describePackage` — stable human text for the review UI.
 *   - `packageSummary` — counters for the review dashboard.
 *   - `rehydrateBatchPackages` — typed load of a persisted payload.
 *   - `__internals` — the validators, exported for tests.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

import type {
  CheckpointGate,
  CheckpointPlan,
  GateAction,
} from "./checkpoints.js";
import {
  recordBatchDecisions,
  type DecisionLog,
  type DecisionTiming,
  type ReviewerDecision,
} from "./decisions.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type BatchApproveErrorCode =
  | "invalid-input"
  | "no-plan"
  | "package-not-found"
  | "invalid-package"
  | "gate-actions-empty";

export class BatchApproveError extends Error {
  readonly code: BatchApproveErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: BatchApproveErrorCode,
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
 * One field in a batch package: the step that writes it, the value it will
 * write, and the field name (from the plan step's target). The reviewer sees
 * one of these per row in the approval UI.
 */
export interface BatchField {
  readonly stepId: string;
  readonly stepIndex: number;
  /** The field's accessible name or label, from the plan step's target. */
  readonly fieldName: string;
  /** The control the plan will use: role + name. */
  readonly targetRole: string | null;
  readonly targetName: string | null;
  /** The value the plan will type/select/toggle. Null when the step writes none. */
  readonly value: string | null;
  /** The action verb ("type", "select", "toggle", ...). */
  readonly action: string;
  /**
   * Provenance for the value, when the caller supplied one. Null when the
   * caller did not associate the field with a source.
   */
  readonly sourceRef: BatchFieldSourceRef | null;
}

export interface BatchFieldSourceRef {
  readonly artifactId: string;
  /** Human label for the source, e.g. "customer-onboarding.pdf p.3". */
  readonly label: string;
  /**
   * The source's staleness classification, if the caller supplied one. The
   * batch validator refuses to submit a package whose fields draw on a
   * superseded source unless the reviewer overrides.
   */
  readonly staleness: "current" | "superseded" | "unknown" | null;
}

export interface BatchValidationNote {
  readonly severity: "error" | "warning";
  readonly rule:
    | "duplicate-field"
    | "missing-value"
    | "superseded-source"
    | "unknown-source-staleness"
    | "no-fields";
  readonly stepId: string | null;
  readonly detail: string;
}

export interface BatchPackage {
  readonly version: "batch-package/1";
  /** Derived from the gate id; stable across a rerun of unchanged inputs. */
  readonly packageId: string;
  readonly workflowId: string | null;
  readonly gateId: string;
  /** Ordered as the plan orders the steps. */
  readonly fields: readonly BatchField[];
  /** Errors block submission; warnings are advisory. */
  readonly validation: readonly BatchValidationNote[];
  /** True when the package contains at least one `error`-severity note. */
  readonly invalid: boolean;
  /** The action verbs the gate will exercise, deduplicated, in order. */
  readonly actions: readonly string[];
  /** Human summary shown at the top of the approval sheet. */
  readonly summary: string;
  readonly generatedAt: string;
  readonly aiGenerated: false;
}

export interface BuildBatchPackagesInput {
  readonly plan: Plan;
  readonly checkpoints: CheckpointPlan;
  /**
   * Optional per-step source references the caller attaches to a step id.
   * Used for the "field came from source X, which is superseded" note and
   * for the fields' provenance display.
   */
  readonly sourceRefsByStepId?: Readonly<Record<string, BatchFieldSourceRef>>;
}

export interface ApplyBatchDecisionInput {
  readonly plan: CheckpointPlan;
  readonly packages: readonly BatchPackage[];
  readonly packageId: string;
  readonly action: Extract<GateAction, "approve" | "reject">;
  readonly reviewerId: string;
  readonly decidedAt: string;
  readonly note?: string | null;
  readonly timing?: DecisionTiming;
  /**
   * When true, the caller accepts an invalid package. Every error-severity
   * validation note is converted into a recorded override so the audit trail
   * shows what was accepted.
   */
  readonly allowInvalid?: boolean;
  readonly existingLog?: DecisionLog | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildBatchPackages(input: BuildBatchPackagesInput): readonly BatchPackage[] {
  if (input === null || typeof input !== "object") {
    throw new BatchApproveError("buildBatchPackages requires an inputs object.", "invalid-input");
  }
  const plan = input.plan;
  const checkpoints = input.checkpoints;
  if (plan === null || typeof plan !== "object") {
    throw new BatchApproveError("A plan is required.", "no-plan");
  }
  if (checkpoints === null || typeof checkpoints !== "object" || checkpoints.version !== "checkpoint-plan/1") {
    throw new BatchApproveError(
      'A CheckpointPlan (version "checkpoint-plan/1") is required.',
      "invalid-input",
    );
  }

  const stepById = indexSteps(plan);
  const packages: BatchPackage[] = [];
  for (const gate of checkpoints.gates) {
    // Only batched `approve` gates become packages. A single-step gate is
    // still approved through the decisions layer, but the batch UI does not
    // present it — the reviewer's approve/reject on a single step is enough.
    if (gate.decision !== "approve" || !gate.batched) continue;
    packages.push(buildOnePackage(gate, stepById, input.sourceRefsByStepId));
  }
  return Object.freeze(packages);
}

/**
 * Record the reviewer's accept/reject for an entire package as a single
 * decision on the underlying gate. Returns the accumulated decision log.
 *
 * An invalid package is refused unless the caller sets `allowInvalid`, in
 * which case the resulting decision's note records every error-severity
 * validation note verbatim so the audit trail shows what was accepted.
 */
export function applyBatchDecision(input: ApplyBatchDecisionInput): DecisionLog {
  if (input === null || typeof input !== "object") {
    throw new BatchApproveError("applyBatchDecision requires an inputs object.", "invalid-input");
  }
  if (input.action !== "approve" && input.action !== "reject") {
    throw new BatchApproveError(
      `Batch decisions accept "approve" or "reject" only; received "${String(input.action)}".`,
      "invalid-input",
      { action: input.action },
    );
  }
  const pkg = input.packages.find((p) => p.packageId === input.packageId);
  if (pkg === undefined) {
    throw new BatchApproveError(
      `No batch package with id "${input.packageId}".`,
      "package-not-found",
      { packageId: input.packageId },
    );
  }
  if (pkg.invalid && input.allowInvalid !== true) {
    const errors = pkg.validation.filter((v) => v.severity === "error").map((v) => v.rule);
    throw new BatchApproveError(
      `Package ${pkg.packageId} failed validation (${errors.join(", ")}); supply allowInvalid=true to override and record the acceptance.`,
      "invalid-package",
      { packageId: pkg.packageId, rules: errors },
    );
  }
  const gate = input.plan.gates.find((g) => g.gateId === pkg.gateId);
  if (gate === undefined) {
    throw new BatchApproveError(
      `Package ${pkg.packageId} refers to gate "${pkg.gateId}", which the plan does not contain.`,
      "invalid-input",
      { packageId: pkg.packageId, gateId: pkg.gateId },
    );
  }
  if (gate.actions.length === 0) {
    throw new BatchApproveError(
      `Gate "${gate.gateId}" offers no reviewer actions.`,
      "gate-actions-empty",
      { gateId: gate.gateId },
    );
  }
  if (!gate.actions.includes(input.action)) {
    throw new BatchApproveError(
      `Gate "${gate.gateId}" does not offer "${input.action}".`,
      "invalid-input",
      { gateId: gate.gateId, action: input.action, offered: gate.actions },
    );
  }

  // Compose the note. When the caller overrode an invalid package, the note
  // leads with the verbatim validator output; the caller's own note follows.
  const overrideNote = (() => {
    if (!pkg.invalid) return null;
    const errors = pkg.validation.filter((v) => v.severity === "error");
    if (errors.length === 0) return null;
    return `Overrode validation: ${errors.map((e) => e.detail).join(" ")}`;
  })();
  const callerNote = nonEmpty(input.note ?? null);
  const combinedNote = [overrideNote, callerNote].filter((v): v is string => v !== null).join(" ");

  return recordBatchDecisions({
    plan: input.plan,
    decisions: [
      {
        gateId: pkg.gateId,
        action: input.action,
        reviewerId: input.reviewerId,
        decidedAt: input.decidedAt,
        note: combinedNote.length > 0 ? combinedNote : null,
        timing: input.timing,
      },
    ],
  });
}

/**
 * Stable human text a reviewer sees at the top of the approval sheet. The
 * wording is versioned with the package so a screenshot in a help article
 * does not drift between releases.
 */
export function describePackage(pkg: BatchPackage): string {
  const label = pkg.fields.length === 1 ? "1 field" : `${pkg.fields.length} fields`;
  const verbs = pkg.actions.length > 0 ? pkg.actions.join("/") : "no action";
  const status = pkg.invalid
    ? ` This package failed validation and requires an override to submit.`
    : "";
  return `${label} will be submitted (${verbs}).${status}`;
}

export function packageSummary(packages: readonly BatchPackage[]): {
  readonly total: number;
  readonly valid: number;
  readonly invalid: number;
  readonly totalFields: number;
  readonly fieldsFromSupersededSources: number;
} {
  let valid = 0;
  let invalid = 0;
  let totalFields = 0;
  let fromSuperseded = 0;
  for (const p of packages) {
    if (p.invalid) invalid += 1;
    else valid += 1;
    totalFields += p.fields.length;
    for (const f of p.fields) {
      if (f.sourceRef !== null && f.sourceRef.staleness === "superseded") fromSuperseded += 1;
    }
  }
  return {
    total: packages.length,
    valid,
    invalid,
    totalFields,
    fieldsFromSupersededSources: fromSuperseded,
  };
}

export function rehydrateBatchPackages(value: unknown): readonly BatchPackage[] {
  if (!Array.isArray(value)) {
    throw new BatchApproveError("Rehydrate failed: expected a JSON array.", "invalid-input");
  }
  const out: BatchPackage[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o["version"] !== "batch-package/1") continue;
    out.push({
      version: "batch-package/1",
      packageId: typeof o["packageId"] === "string" ? o["packageId"] : "",
      workflowId: typeof o["workflowId"] === "string" ? o["workflowId"] : null,
      gateId: typeof o["gateId"] === "string" ? o["gateId"] : "",
      fields: readFields(o["fields"]),
      validation: readValidation(o["validation"]),
      invalid: o["invalid"] === true,
      actions: readStringArray(o["actions"]),
      summary: typeof o["summary"] === "string" ? o["summary"] : "",
      generatedAt: typeof o["generatedAt"] === "string" ? o["generatedAt"] : "",
      aiGenerated: false,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface IndexedStep {
  readonly id: string;
  readonly index: number;
  readonly planStep: PlanStep;
}

function indexSteps(plan: Plan): { readonly byId: Map<string, IndexedStep>; readonly ordered: readonly IndexedStep[] } {
  const byId = new Map<string, IndexedStep>();
  const ordered: IndexedStep[] = [];
  const raw = (plan as { steps?: unknown }).steps;
  if (!Array.isArray(raw)) return { byId, ordered };
  for (let i = 0; i < raw.length; i += 1) {
    const s = raw[i];
    if (s === null || typeof s !== "object") continue;
    const step = s as PlanStep;
    const id = typeof step.id === "string" && step.id.length > 0 ? step.id : `step-${i + 1}`;
    const indexed: IndexedStep = { id, index: i + 1, planStep: step };
    byId.set(id, indexed);
    ordered.push(indexed);
  }
  return { byId, ordered };
}

function buildOnePackage(
  gate: CheckpointGate,
  stepIndex: { readonly byId: Map<string, IndexedStep> },
  sourceRefsByStepId: Readonly<Record<string, BatchFieldSourceRef>> | undefined,
): BatchPackage {
  const fields: BatchField[] = [];
  const actions: string[] = [];
  const validation: BatchValidationNote[] = [];
  const seenFieldNames = new Map<string, string>();
  for (const stepId of gate.stepIds) {
    const indexed = stepIndex.byId.get(stepId);
    if (indexed === undefined) {
      // A gate references a step the plan does not contain. This is a
      // programming error between the checkpoint layer and the caller, not a
      // reviewer-facing problem; record it as a warning and continue so the
      // reviewer still sees the fields that do exist.
      validation.push({
        severity: "warning",
        rule: "no-fields",
        stepId,
        detail: `Gate references step "${stepId}", which the plan does not contain.`,
      });
      continue;
    }
    const ps = indexed.planStep;
    const fieldName = fieldNameOf(ps);
    const value = typeof ps.value === "string" ? ps.value : null;
    const sourceRef = sourceRefsByStepId?.[stepId] ?? null;

    if (!actions.includes(ps.action)) actions.push(ps.action);

    // Duplicate-field check: two steps assigning the same accessible name. A
    // form field is uniquely addressed by its name; two steps writing the
    // same name is a likely plan error the reviewer should confirm.
    const priorStepId = seenFieldNames.get(fieldName.toLowerCase());
    if (priorStepId !== undefined) {
      validation.push({
        severity: "warning",
        rule: "duplicate-field",
        stepId,
        detail: `Fields "${fieldName}" are written by both step "${priorStepId}" and step "${stepId}".`,
      });
    } else {
      seenFieldNames.set(fieldName.toLowerCase(), stepId);
    }

    // Missing-value check for value-carrying verbs.
    if (isValueCarryingVerb(ps.action) && (value === null || value.trim().length === 0)) {
      validation.push({
        severity: "error",
        rule: "missing-value",
        stepId,
        detail: `Step "${stepId}" (${ps.action} "${fieldName}") has no value to submit.`,
      });
    }

    // Source staleness checks.
    if (sourceRef !== null) {
      if (sourceRef.staleness === "superseded") {
        validation.push({
          severity: "error",
          rule: "superseded-source",
          stepId,
          detail: `Step "${stepId}" will submit a value taken from superseded source "${sourceRef.label}" (${sourceRef.artifactId}).`,
        });
      } else if (sourceRef.staleness === "unknown") {
        validation.push({
          severity: "warning",
          rule: "unknown-source-staleness",
          stepId,
          detail: `Step "${stepId}" will submit a value taken from source "${sourceRef.label}", whose staleness is unknown.`,
        });
      }
    }

    fields.push({
      stepId,
      stepIndex: indexed.index,
      fieldName,
      targetRole: nonEmpty(ps.target?.role ?? null),
      targetName: nonEmpty(ps.target?.name ?? null),
      value,
      action: ps.action,
      sourceRef,
    });
  }

  if (fields.length === 0) {
    validation.push({
      severity: "error",
      rule: "no-fields",
      stepId: null,
      detail: `Gate "${gate.gateId}" produced no fields; the batch cannot be presented to a reviewer.`,
    });
  }

  const invalid = validation.some((v) => v.severity === "error");
  const packageId = packageIdFor(gate.gateId);
  return {
    version: "batch-package/1",
    packageId,
    workflowId: null,
    gateId: gate.gateId,
    fields: Object.freeze(fields),
    validation: Object.freeze(validation),
    invalid,
    actions: Object.freeze(actions),
    summary: buildPackageSummary(fields.length, actions, invalid),
    generatedAt: new Date().toISOString(),
    aiGenerated: false,
  };
}

function fieldNameOf(step: PlanStep): string {
  const name = step.target?.name;
  if (typeof name === "string" && name.trim().length > 0) return name.trim();
  const role = step.target?.role;
  if (typeof role === "string" && role.trim().length > 0) return role.trim();
  return step.id.length > 0 ? step.id : "unnamed field";
}

function isValueCarryingVerb(action: string): boolean {
  return (
    action === "type" ||
    action === "select" ||
    action === "toggle" ||
    action === "navigate" ||
    action === "upload"
  );
}

function buildPackageSummary(
  fieldCount: number,
  actions: readonly string[],
  invalid: boolean,
): string {
  const label = fieldCount === 1 ? "1 field" : `${fieldCount} fields`;
  const verbList = actions.length > 0 ? actions.join("/") : "no action";
  const status = invalid ? " Some fields failed validation and require an override." : "";
  return `${label} will be submitted (${verbList}).${status}`;
}

function packageIdFor(gateId: string): string {
  const h = fnv1a32(`pkg|${gateId}`).toString(16).padStart(8, "0");
  return `pkg_${h}`;
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

function readFields(v: unknown): readonly BatchField[] {
  if (!Array.isArray(v)) return [];
  const out: BatchField[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const sourceRefRaw = o["sourceRef"];
    let sourceRef: BatchFieldSourceRef | null = null;
    if (sourceRefRaw !== null && typeof sourceRefRaw === "object") {
      const sr = sourceRefRaw as Record<string, unknown>;
      const stalenessRaw = sr["staleness"];
      const staleness: BatchFieldSourceRef["staleness"] =
        stalenessRaw === "current" || stalenessRaw === "superseded" || stalenessRaw === "unknown"
          ? stalenessRaw
          : null;
      sourceRef = {
        artifactId: typeof sr["artifactId"] === "string" ? sr["artifactId"] : "",
        label: typeof sr["label"] === "string" ? sr["label"] : "",
        staleness,
      };
    }
    out.push({
      stepId: typeof o["stepId"] === "string" ? o["stepId"] : "",
      stepIndex:
        typeof o["stepIndex"] === "number" && Number.isFinite(o["stepIndex"])
          ? Math.max(1, Math.floor(o["stepIndex"]))
          : 1,
      fieldName: typeof o["fieldName"] === "string" ? o["fieldName"] : "",
      targetRole: typeof o["targetRole"] === "string" ? o["targetRole"] : null,
      targetName: typeof o["targetName"] === "string" ? o["targetName"] : null,
      value: typeof o["value"] === "string" ? o["value"] : null,
      action: typeof o["action"] === "string" ? o["action"] : "",
      sourceRef,
    });
  }
  return out;
}

function readValidation(v: unknown): readonly BatchValidationNote[] {
  if (!Array.isArray(v)) return [];
  const out: BatchValidationNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const severity = o["severity"] === "error" ? "error" : "warning";
    const ruleRaw = o["rule"];
    const rule: BatchValidationNote["rule"] =
      ruleRaw === "duplicate-field" ||
      ruleRaw === "missing-value" ||
      ruleRaw === "superseded-source" ||
      ruleRaw === "unknown-source-staleness" ||
      ruleRaw === "no-fields"
        ? ruleRaw
        : "no-fields";
    out.push({
      severity,
      rule,
      stepId: typeof o["stepId"] === "string" ? o["stepId"] : null,
      detail: typeof o["detail"] === "string" ? o["detail"] : "",
    });
  }
  return out;
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
  indexSteps,
  buildOnePackage,
  fieldNameOf,
  isValueCarryingVerb,
  buildPackageSummary,
  packageIdFor,
  fnv1a32,
  readFields,
  readValidation,
});

/**
 * The `ReviewerDecision` type is re-declared here for callers that only want
 * the batch facade; it is exported as a type-only alias so the module does
 * not import the decisions file at runtime for consumers that only compose
 * packages.
 */
export type { ReviewerDecision };
