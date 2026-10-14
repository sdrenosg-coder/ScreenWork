/**
 * Zipy AI — long-form: SOP / runbook (content-generation, long-form batch 0).
 *
 * An SOP (standard operating procedure) is a *formal* procedure document:
 * it names the roles involved, states prerequisites and scope, sequences
 * steps with explicit checkpoint and rollback positions, and — importantly —
 * ends with rollback instructions for every mutating step. This module
 * composes that document from an approved workflow plan and the
 * core-writing artefacts produced elsewhere in `@zipy/content`.
 *
 * The composer never invents roles, checkpoints or rollback actions. It
 * reads them from:
 *
 *   1. The plan's `goal` and `steps`.
 *   2. Optional `roles` supplied by the caller (the workspace knows who
 *      runs this procedure; the platform does not).
 *   3. A per-step `checkpoint` flag and `rollback` string supplied by the
 *      caller — these come from the review phase's risk classification.
 *
 * Where a required field is absent the composer records a `SopGap` and,
 * for mutating steps, marks the rollback as "not specified" so a reviewer
 * cannot mistake the absence for a "no rollback needed" state.
 *
 * Output shape (`Sop`) is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SopErrorCode = "invalid-input" | "no-goal" | "empty-plan";

export class SopError extends Error {
  readonly code: SopErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SopErrorCode,
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

export const SOP_STEP_KINDS = ["starting", "mutating", "read-only", "terminal"] as const;
export type SopStepKind = (typeof SOP_STEP_KINDS)[number];

export interface SopRole {
  /** Role name as it appears in the workflow plan's supporting documents. */
  readonly name: string;
  /** Optional responsibilities. */
  readonly responsibilities?: readonly string[];
}

export interface SopStep {
  /** 1-based position. */
  readonly number: number;
  /** Stable id from the plan. */
  readonly sourceStepId: string;
  readonly kind: SopStepKind;
  readonly title: string;
  readonly body: string;
  /** Present only when the step mutates state and the caller supplied it. */
  readonly rollback: string | null;
  /** True when the review phase classified the step as a checkpoint. */
  readonly checkpoint: boolean;
  /** Optional screenshot asset ids for the SOP's illustrated variant. */
  readonly screenshotAssets: readonly string[];
}

export interface SopSection {
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly listItems?: readonly string[];
}

export interface SopGap {
  readonly step?: number;
  readonly reason:
    | "no-roles"
    | "no-plan-steps"
    | "no-rollback-for-mutating-step"
    | "no-prerequisites"
    | "no-scope";
  readonly detail: string;
}

export interface Sop {
  readonly version: "sop/1";
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  readonly roles: readonly SopRole[];
  readonly scope: SopSection;
  readonly prerequisites: SopSection;
  readonly steps: readonly SopStep[];
  /** Ordered list of role names that must sign off at each checkpoint. */
  readonly approvals: readonly { readonly step: number; readonly role: string }[];
  readonly rollbackSummary: readonly string[];
  readonly gaps: readonly SopGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface SopInputs {
  readonly plan: Plan;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly slug?: string | null;
  /** Roles that execute or approve the procedure. */
  readonly roles?: readonly SopRole[];
  /** Scope sentence(s). Required by the SOP format; missing becomes a gap. */
  readonly scope?: readonly string[];
  readonly prerequisites?: readonly string[];
  /** Per-step title/body overrides from the core-writing layers. */
  readonly stepText?: Readonly<Record<string, { readonly title: string; readonly description: string }>>;
  /**
   * Per-step risk information from the review phase. When a step is
   * classified as a checkpoint the SOP marks it and the approval list is
   * populated for that role.
   */
  readonly review?: Readonly<Record<string, {
    readonly kind?: SopStepKind;
    readonly checkpoint?: boolean;
    readonly approverRole?: string;
    readonly rollback?: string;
  }>>;
  readonly screenshotsByStepId?: Readonly<Record<string, readonly string[]>>;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeSop(inputs: SopInputs): Sop {
  if (inputs === null || typeof inputs !== "object") {
    throw new SopError("composeSop requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new SopError("A plan object is required.", "invalid-input");
  }
  const goal = (plan as { goal?: unknown }).goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new SopError("The plan does not expose a goal.", "no-goal");
  }

  const gaps: SopGap[] = [];
  const roles = pruneRoles(inputs.roles ?? []);
  if (roles.length === 0) {
    gaps.push({
      reason: "no-roles",
      detail: "No roles were supplied; the SOP cannot state who executes or approves the procedure.",
    });
  }

  const title = nonEmpty(inputs.title) ?? `SOP: ${goal}`;
  const summary = nonEmpty(inputs.summary) ?? `Standard operating procedure for: ${goal}.`;
  const slug = inputs.slug !== undefined && inputs.slug !== null
    ? slugify(inputs.slug)
    : slugify(`sop-${goal}`);

  // Scope
  const scopeParagraphs = pruneStrings(inputs.scope ?? []);
  if (scopeParagraphs.length === 0) {
    gaps.push({
      reason: "no-scope",
      detail: "No scope sentence was supplied; the scope section is empty.",
    });
  }
  const scope: SopSection = {
    id: "scope",
    heading: "Scope",
    paragraphs: scopeParagraphs.length > 0
      ? scopeParagraphs
      : ["This procedure covers the workflow defined by the accompanying plan."],
  };

  // Prerequisites
  const prereqs = pruneStrings(inputs.prerequisites ?? []);
  if (prereqs.length === 0) {
    gaps.push({
      reason: "no-prerequisites",
      detail: "No prerequisites were supplied.",
    });
  }
  const prerequisites: SopSection = {
    id: "prerequisites",
    heading: "Prerequisites",
    paragraphs: [],
    listItems: prereqs.length > 0 ? prereqs : [],
  };

  // Steps
  const rawSteps = readSteps(plan);
  if (rawSteps.length === 0) {
    gaps.push({ reason: "no-plan-steps", detail: "The supplied plan contains no steps." });
  }
  const approvals: { step: number; role: string }[] = [];
  const rollbackSummary: string[] = [];
  const steps: SopStep[] = [];

  for (let i = 0; i < rawSteps.length; i += 1) {
    const entry = rawSteps[i]!;
    const review = inputs.review?.[entry.id];
    const kind = review?.kind ?? inferKind(entry.planStep);
    const textEntry = inputs.stepText?.[entry.id];
    const stepTitle = nonEmpty(textEntry?.title) ?? defaultStepTitle(entry.planStep, entry.index);
    const stepBody = nonEmpty(textEntry?.description) ?? defaultStepBody(entry.planStep);
    const checkpoint = review?.checkpoint === true;
    const rollback = typeof review?.rollback === "string" && review.rollback.trim().length > 0
      ? review.rollback.trim()
      : null;

    if (kind === "mutating" && rollback === null) {
      gaps.push({
        step: entry.index,
        reason: "no-rollback-for-mutating-step",
        detail: `Step ${entry.index} mutates state but no rollback instruction was supplied.`,
      });
    }
    if (checkpoint) {
      const role = nonEmpty(review?.approverRole);
      if (role !== null) {
        approvals.push({ step: entry.index, role });
      } else {
        gaps.push({
          step: entry.index,
          reason: "no-roles",
          detail: `Step ${entry.index} is a checkpoint but no approver role was supplied.`,
        });
      }
    }
    if (kind === "mutating" && rollback !== null) {
      rollbackSummary.push(`Step ${entry.index} — ${rollback}`);
    }

    steps.push({
      number: entry.index,
      sourceStepId: entry.id,
      kind,
      title: stepTitle,
      body: stepBody,
      rollback,
      checkpoint,
      screenshotAssets: pruneStrings(inputs.screenshotsByStepId?.[entry.id] ?? []),
    });
  }

  return {
    version: "sop/1",
    title,
    summary,
    slug,
    roles,
    scope,
    prerequisites,
    steps,
    approvals,
    rollbackSummary,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the SOP as Markdown. Screenshots are referenced as
 * `asset://<id>` placeholders so the export layer can substitute real URLs.
 */
export function renderSopMarkdown(sop: Sop): string {
  const parts: string[] = [];
  parts.push(`# ${sop.title}`);
  parts.push("");
  parts.push(sop.summary);
  parts.push("");

  if (sop.roles.length > 0) {
    parts.push("## Roles");
    parts.push("");
    for (const r of sop.roles) {
      const responsibilities = (r.responsibilities ?? []).filter((s) => s.length > 0);
      parts.push(
        responsibilities.length > 0
          ? `- **${r.name}** — ${responsibilities.join("; ")}`
          : `- **${r.name}**`,
      );
    }
    parts.push("");
  }

  parts.push(`## ${sop.scope.heading}`);
  parts.push("");
  for (const p of sop.scope.paragraphs) {
    parts.push(p);
    parts.push("");
  }

  parts.push(`## ${sop.prerequisites.heading}`);
  parts.push("");
  if ((sop.prerequisites.listItems ?? []).length === 0) {
    parts.push("_Prerequisites not supplied._");
  } else {
    for (const item of sop.prerequisites.listItems ?? []) {
      parts.push(`- ${item}`);
    }
  }
  parts.push("");

  parts.push("## Procedure");
  parts.push("");
  for (const step of sop.steps) {
    const tags: string[] = [];
    if (step.kind === "mutating") tags.push("mutating");
    if (step.checkpoint) tags.push("checkpoint");
    const suffix = tags.length > 0 ? ` _(${tags.join(", ")})_` : "";
    parts.push(`### ${step.number}. ${step.title}${suffix}`);
    parts.push("");
    parts.push(step.body);
    parts.push("");
    if (step.rollback !== null) {
      parts.push(`> **Rollback:** ${step.rollback}`);
      parts.push("");
    } else if (step.kind === "mutating") {
      parts.push("> **Rollback:** not specified — reviewer action required.");
      parts.push("");
    }
    for (const asset of step.screenshotAssets) {
      parts.push(`![Step ${step.number}](asset://${asset})`);
      parts.push("");
    }
  }

  if (sop.approvals.length > 0) {
    parts.push("## Approvals");
    parts.push("");
    for (const a of sop.approvals) {
      parts.push(`- Step ${a.step}: **${a.role}**`);
    }
    parts.push("");
  }

  if (sop.rollbackSummary.length > 0) {
    parts.push("## Rollback summary");
    parts.push("");
    for (const line of sop.rollbackSummary) parts.push(`- ${line}`);
    parts.push("");
  }

  if (sop.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Content gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of sop.gaps) {
      parts.push(`- ${gap.step !== undefined ? `Step ${gap.step}: ` : ""}${gap.detail}`);
    }
    parts.push("");
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildSopDirectives(): string {
  return [
    "You are writing a standard operating procedure (SOP) from an approved workflow plan.",
    "Follow this structure exactly: Roles, Scope, Prerequisites, Procedure, Approvals, Rollback summary.",
    "Every step title is a short imperative. Every step body names the exact UI element from the plan and states the expected outcome.",
    "For every mutating step you MUST include a rollback instruction; if the review phase did not supply one, state that explicitly rather than inventing a rollback.",
    "Checkpoints are called out inline and listed under Approvals with an owning role.",
    "Do not invent roles, approver names or regulatory obligations. Do not use the word 'simply'.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface IndexedStep {
  readonly id: string;
  readonly index: number;
  readonly planStep: PlanStep;
}

function readSteps(plan: Plan): readonly IndexedStep[] {
  const raw = (plan as { steps?: unknown }).steps;
  if (!Array.isArray(raw)) return [];
  const out: IndexedStep[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const step = raw[i];
    if (step === null || typeof step !== "object") continue;
    const s = step as PlanStep;
    const id = typeof s.id === "string" && s.id.length > 0 ? s.id : `step-${i + 1}`;
    out.push({ id, index: i + 1, planStep: s });
  }
  return out;
}

function inferKind(step: PlanStep): SopStepKind {
  // Without the review phase's risk classification we can only distinguish
  // read-only navigation from potential state changes. The plan action
  // vocabulary is: click, type, select, scroll, navigate. Anything except
  // pure navigation and scrolling is treated as potentially mutating so the
  // SOP errs on the side of requiring a rollback, and the gap list captures
  // the absence of a supplied rollback.
  switch (step.action) {
    case "navigate":
    case "scroll":
      return "read-only";
    case "click":
    case "type":
    case "select":
      return "mutating";
    default:
      return "starting";
  }
}

function defaultStepTitle(step: PlanStep, index: number): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  const verb = actionVerb(step.action);
  return name !== null ? `${verb} ${name}` : `Step ${index}`;
}

function defaultStepBody(step: PlanStep): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  const value = typeof step.value === "string" && step.value.trim().length > 0 ? step.value.trim() : null;
  switch (step.action) {
    case "click":
      return name !== null
        ? `Select ${name} and confirm the resulting page state.`
        : "Select the target control and confirm the resulting page state.";
    case "type":
      return value !== null && name !== null
        ? `Enter ${value} in ${name}.`
        : "Enter the required value in the field.";
    case "select":
      return value !== null && name !== null
        ? `Choose ${value} from ${name}.`
        : "Choose the required option.";
    case "navigate":
      return value !== null ? `Navigate to ${value}.` : "Navigate to the next page.";
    case "scroll":
      return "Scroll to reveal the next control.";
    default:
      return name !== null ? `Interact with ${name}.` : "Perform the indicated action.";
  }
}

function actionVerb(action: string): string {
  switch (action) {
    case "click": return "Click";
    case "type": return "Enter";
    case "select": return "Choose";
    case "navigate": return "Go to";
    case "scroll": return "Scroll to";
    default: return "Interact with";
  }
}

function pruneRoles(roles: readonly SopRole[]): readonly SopRole[] {
  const seen = new Set<string>();
  const out: SopRole[] = [];
  for (const r of roles) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const responsibilities = (r.responsibilities ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
    out.push({
      name,
      ...(responsibilities.length > 0 ? { responsibilities } : {}),
    });
  }
  return out;
}

function pruneStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = typeof v === "string" ? v.trim() : "";
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "sop";
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
  slugify,
  inferKind,
  defaultStepTitle,
  defaultStepBody,
  actionVerb,
  pruneRoles,
  pruneStrings,
});
