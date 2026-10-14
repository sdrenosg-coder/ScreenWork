/**
 * Zipy AI — structured content: checklists (content-generation, structured batch 2).
 *
 * A workflow guide naturally splits into three checklists:
 *
 *   1. `prerequisites` — what a reader must have in place before starting.
 *      Sourced from the caller's `introPrereqs` artefact (never invented).
 *   2. `steps` — the ordered sequence of actions, one item per plan step.
 *      The item text is the step's one-line instruction (from the `stepText`
 *      artefact, or derived deterministically from the plan).
 *   3. `post-completion` — what to verify once the workflow has run. Sourced
 *      from a caller-supplied list, or from a per-step copy for terminal
 *      steps when their `tipsWarnings` entry carries warnings (the warning
 *      is what the reader must confirm they avoided).
 *
 * Each checklist carries a stable id and `CheckedItem` objects so an export
 * template can render them as interactive `<input type="checkbox">` lists
 * or plain bullet lists without re-deriving anything.
 *
 * Output shape (`ChecklistSet`) is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ChecklistErrorCode = "invalid-input" | "no-goal";

export class ChecklistError extends Error {
  readonly code: ChecklistErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ChecklistErrorCode,
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

export const CHECKLIST_KINDS = ["prerequisites", "steps", "post-completion"] as const;
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number];

export interface CheckedItem {
  /** Stable id; safe to use as an HTML element id. */
  readonly id: string;
  /** The item text. Never empty; items with empty text are dropped. */
  readonly text: string;
  /**
   * `required` items must be satisfied before the reader continues;
   * `advisory` items are helpful checks. The composer marks prerequisites
   * and post-completion items as `required` and step items as `required`,
   * except an optional preface item which is `advisory`.
   */
  readonly requirement: "required" | "advisory";
  /** Provenance: the plan step when the item derives from a step. */
  readonly sourceStepId: string | null;
}

export interface Checklist {
  readonly kind: ChecklistKind;
  readonly id: string;
  readonly title: string;
  readonly items: readonly CheckedItem[];
}

export interface ChecklistGap {
  readonly kind: ChecklistKind;
  readonly reason:
    | "no-prerequisites-source"
    | "no-plan-steps"
    | "no-post-completion-source";
  readonly detail: string;
}

export interface ChecklistSet {
  readonly version: "checklists/1";
  readonly checklists: readonly Checklist[];
  readonly gaps: readonly ChecklistGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface ChecklistInputs {
  readonly plan: Plan;
  /** Prerequisite items, typically from an already-generated intro section. */
  readonly prerequisites?: readonly string[];
  /** Post-completion verification items, supplied by the caller. */
  readonly postCompletion?: readonly string[];
  /** Per-step copy overrides from the core-writing layers. */
  readonly stepText?: Readonly<Record<string, { readonly title: string; readonly description: string }>>;
  /** Per-step tips/warnings; a warning contributes a post-completion item. */
  readonly tipsWarnings?: Readonly<
    Record<string, { readonly tips: readonly string[]; readonly warnings: readonly string[] }>
  >;
  /** Optional override for the prerequisites checklist title. */
  readonly prerequisitesTitle?: string | null;
  /** Optional override for the steps checklist title. */
  readonly stepsTitle?: string | null;
  /** Optional override for the post-completion checklist title. */
  readonly postCompletionTitle?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeChecklists(inputs: ChecklistInputs): ChecklistSet {
  if (inputs === null || typeof inputs !== "object") {
    throw new ChecklistError("composeChecklists requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new ChecklistError("A plan object is required.", "invalid-input");
  }
  const goal = (plan as { goal?: unknown }).goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new ChecklistError("The plan does not expose a goal.", "no-goal");
  }

  const gaps: ChecklistGap[] = [];
  const checklists: Checklist[] = [];

  // ----------------------------------------------------- prerequisites ---
  const prereqs = pruneStrings(inputs.prerequisites ?? []);
  if (prereqs.length > 0) {
    checklists.push({
      kind: "prerequisites",
      id: "prerequisites",
      title: nonEmpty(inputs.prerequisitesTitle) ?? "Before you begin",
      items: prereqs.map((text, i) => ({
        id: `prereq-${i + 1}`,
        text,
        requirement: "required",
        sourceStepId: null,
      })),
    });
  } else {
    gaps.push({
      kind: "prerequisites",
      reason: "no-prerequisites-source",
      detail: "No prerequisite items were supplied; the prerequisites checklist was omitted.",
    });
  }

  // ------------------------------------------------------------- steps ---
  const steps = readSteps(plan);
  if (steps.length > 0) {
    checklists.push({
      kind: "steps",
      id: "steps",
      title: nonEmpty(inputs.stepsTitle) ?? "Steps",
      items: steps.map((s) => ({
        id: `step-${s.index}`,
        text: stepChecklistText(s, inputs.stepText),
        requirement: "required",
        sourceStepId: s.id,
      })),
    });
  } else {
    gaps.push({
      kind: "steps",
      reason: "no-plan-steps",
      detail: "The supplied plan contains no steps; the steps checklist was omitted.",
    });
  }

  // --------------------------------------------------- post-completion ---
  const explicitPost = pruneStrings(inputs.postCompletion ?? []);
  const warningsAsItems = collectWarningItems(steps, inputs.tipsWarnings);
  const items: CheckedItem[] = [];
  for (let i = 0; i < explicitPost.length; i += 1) {
    items.push({
      id: `post-${i + 1}`,
      text: explicitPost[i]!,
      requirement: "required",
      sourceStepId: null,
    });
  }
  for (const w of warningsAsItems) {
    items.push({
      id: `post-warn-${w.stepIndex}`,
      text: w.text,
      requirement: "required",
      sourceStepId: w.sourceStepId,
    });
  }
  if (items.length > 0) {
    checklists.push({
      kind: "post-completion",
      id: "post-completion",
      title: nonEmpty(inputs.postCompletionTitle) ?? "After you finish",
      items,
    });
  } else {
    gaps.push({
      kind: "post-completion",
      reason: "no-post-completion-source",
      detail:
        "No post-completion items and no step warnings were supplied; the post-completion checklist was omitted.",
    });
  }

  return {
    version: "checklists/1",
    checklists,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the checklist set as Markdown with `- [ ]` items so a reader can
 * copy the output into a GitHub issue or a task tracker without editing.
 */
export function renderChecklistsMarkdown(set: ChecklistSet): string {
  const parts: string[] = [];
  for (const checklist of set.checklists) {
    parts.push(`### ${checklist.title}`);
    parts.push("");
    for (const item of checklist.items) {
      const marker = item.requirement === "required" ? "[ ]" : "[~]";
      parts.push(`- ${marker} ${item.text}`);
    }
    parts.push("");
  }
  if (set.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Checklist gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of set.gaps) {
      parts.push(`- **${gap.kind}** — ${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildChecklistsDirectives(): string {
  return [
    "You are producing checklists from an already approved workflow plan.",
    "Exactly three checklists are supported: prerequisites, steps, post-completion.",
    "Prerequisite items are things the reader must have in place before starting; each item is one short imperative sentence.",
    "Step items are one-line descriptions of each plan step, using the exact UI element name from the plan.",
    "Post-completion items are verifications the reader runs after the workflow: confirm the record exists, confirm the notification arrived, and so on.",
    "Never invent prerequisites or verification steps. Leave a checklist out when it has no source.",
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

interface WarningItem {
  readonly stepIndex: number;
  readonly sourceStepId: string;
  readonly text: string;
}

function collectWarningItems(
  steps: readonly IndexedStep[],
  tipsWarnings: ChecklistInputs["tipsWarnings"],
): readonly WarningItem[] {
  if (tipsWarnings === undefined) return [];
  const out: WarningItem[] = [];
  for (const s of steps) {
    const entry = tipsWarnings[s.id];
    if (entry === undefined) continue;
    for (const w of entry.warnings) {
      const text = typeof w === "string" ? w.trim() : "";
      if (text.length === 0) continue;
      out.push({ stepIndex: s.index, sourceStepId: s.id, text });
    }
  }
  return out;
}

function stepChecklistText(
  step: IndexedStep,
  stepText: ChecklistInputs["stepText"],
): string {
  const override = stepText?.[step.id]?.description;
  if (typeof override === "string" && override.trim().length > 0) {
    return firstSentence(override.trim());
  }
  const name =
    step.planStep.target !== null && step.planStep.target.name.trim().length > 0
      ? step.planStep.target.name.trim()
      : null;
  const value =
    typeof step.planStep.value === "string" && step.planStep.value.trim().length > 0
      ? step.planStep.value.trim()
      : null;
  switch (step.planStep.action) {
    case "click":
      return name !== null ? `Click ${name}` : "Click the target control";
    case "type":
      return name !== null && value !== null
        ? `Enter the required value in ${name}`
        : name !== null
          ? `Enter the required value in ${name}`
          : "Enter the required value";
    case "select":
      return name !== null && value !== null
        ? `Choose the required option from ${name}`
        : name !== null
          ? `Choose the required option from ${name}`
          : "Choose the required option";
    case "navigate":
      return value !== null ? `Navigate to ${value}` : "Navigate to the next page";
    case "scroll":
      return "Scroll to reveal the next control";
    default:
      return name !== null ? `Complete the action on ${name}` : `Complete step ${step.index}`;
  }
}

function firstSentence(s: string): string {
  const m = s.match(/^[^.!?]+[.!?]?/);
  return (m?.[0] ?? s).trim();
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

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  collectWarningItems,
  stepChecklistText,
  firstSentence,
  pruneStrings,
});
