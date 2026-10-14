/**
 * Zipy AI — per-step title and description generation (content-generation core, batch 0).
 *
 * The third and final layer of this batch. Where `titleSummary.ts` writes the
 * guide-level title/summary and `introPrereqs.ts` writes the pre-step copy,
 * this file produces the copy that accompanies each step in the guide:
 *
 *   - a short **title** for the step ("Fill in the customer details"),
 *   - a **description** that tells the reader what to do in context
 *     ("Enter the customer's full name, then their email address. The email
 *     must be unique within the workspace.").
 *
 * The step copy is intentionally *not* the same as the annotation overlay
 * copy produced by `@zipy/annotate/stepCopy`. The annotation layer produces a
 * single, very short instruction line ("Click the "Add customer" button") to
 * be rendered on top of a screenshot. This layer produces the copy the reader
 * sees in the guide's step list: a title that names the step, and a
 * description that explains what the reader should do and *why* the step
 * matters in the workflow. The two layers share their inputs (the plan and
 * the sources) but produce different registers.
 *
 * How each field is derived:
 *
 *  - The **title** uses the plan step's action verb and its target element's
 *    accessible name (or role), matching the annotation layer's grammar so a
 *    reviewer sees the same nouns in both places. On top of that, the title
 *    may carry a one-word intent qualifier — "New", "Existing", "Details",
 *    "Confirmation" — chosen from the step's surrounding context (the
 *    presence of a subsequent commit step, whether the step is the first
 *    write, whether the step is the last click). The qualifier is added only
 *    when the plain title would be ambiguous ("Click Save" is fine as a
 *    step; "Enter the customer's name" benefits from "new" when the previous
 *    step created the record).
 *
 *  - The **description** is composed from four clauses, each of which is
 *    emitted only when it can be grounded:
 *       1. an action clause ("Click the "Add customer" button in the
 *          toolbar"),
 *       2. a purpose clause ("to open the new-customer form"),
 *       3. a constraint clause ("the email address must be unique within the
 *          workspace" — sourced from a `text` or `file` source that mentions
 *          uniqueness or the relevant field),
 *       4. a consequence clause ("the customer will appear at the top of the
 *          list" — sourced from the following step's action or the plan's
 *          goal).
 *
 * When the LLM is available, it receives the plan step, its surrounding
 * context in the plan, and the relevant source excerpts, and produces the
 * title and description in the same shape. When the LLM is unavailable or
 * fails, the deterministic composer produces all four fields and records
 * every fallback.
 *
 * Design rules honoured:
 *  - The same `LlmHandle` shape used by the other content layers.
 *  - The layer processes a whole plan in one call so the LLM (when used) can
 *    see each step in the context of the previous and next step. A per-step
 *    API is also exposed (`generateStepText`) for callers that need it
 *    (regeneration of a single step after a UI change, per the product's
 *    "auto-regenerate on UI change" flow).
 *  - No invented UI labels: every noun in the output comes from the plan, a
 *    source, or a small maintained lexicon of qualifiers (listed below).
 *  - Deterministic composer runs whenever the LLM is unavailable or the
 *    caller requests it; the composer is honest about which clauses it
 *    could not produce and records them in `notes`.
 */

import type { PlanStep } from "@zipy/synth/stepSequence";
import type { LlmProvider } from "@zipy/llm/adapter";
import type { TitleSummarySource } from "@zipy/content/titleSummary";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type StepTextErrorCode = "invalid-input" | "empty-plan";

export class StepTextError extends Error {
  readonly code: StepTextErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: StepTextErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* LLM handle contract                                                         */
/* -------------------------------------------------------------------------- */

export interface StepTextLlmHandle {
  readonly complete: (args: {
    readonly task: "content.stepText";
    readonly system: string;
    readonly user: string;
    readonly maxOutputChars: number;
    readonly temperature: number;
    readonly provider?: LlmProvider;
    readonly model?: string | null;
  }) => Promise<{ readonly text: string }>;
  readonly isConfigured: () => boolean;
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type StepTextOrigin = "llm" | "composed" | "fallback";

/**
 * A single step's generated copy. Keyed by the plan step's `stepId` so a
 * caller can substitute a step's copy back into the plan without index
 * arithmetic.
 */
export interface StepCopyEntry {
  /** The plan step's `stepId`. Matches `PlanStep.stepId`. */
  readonly stepId: string;
  /** 1-based ordinal matching the plan step's `ordinal`. */
  readonly ordinal: number;
  /** Short imperative title, <= 60 characters. */
  readonly title: string;
  /** One to three sentences. */
  readonly description: string;
  /** Where the title came from. */
  readonly titleSource: StepTextOrigin;
  /** Where the description came from. */
  readonly descriptionSource: StepTextOrigin;
  /**
   * Which of the four composer clauses contributed text. Populated by the
   * composer; empty when the LLM produced the entry (the LLM's clauses are
   * not separable after the fact).
   */
  readonly clauses: readonly ("action" | "purpose" | "constraint" | "consequence")[];
  /** Notes affecting the entry, e.g. fallbacks or skipped clauses. */
  readonly notes: readonly string[];
}

export interface StepTextStyle {
  readonly tone?: "formal" | "casual" | "technical";
  readonly audience?: "end-user" | "admin" | "developer";
  readonly brandTerms?: readonly string[];
}

export interface GenerateStepTextOptions {
  readonly llm?: StepTextLlmHandle | null;
  readonly deterministic?: boolean;
  readonly provider?: LlmProvider;
  readonly model?: string | null;
  readonly style?: StepTextStyle;
  /** Guide goal, matched to the plan-level goal used by the other layers. */
  readonly guideGoal?: string | null;
  /** Sources for context; the same set passed to `generateTitleSummary`. */
  readonly sources?: readonly TitleSummarySource[];
  /**
   * Free-text excerpts from sources the caller wants the LLM to consider.
   * When a `file` or `text` source names a field or a constraint, the caller
   * (typically the fusion pipeline) provides the excerpt here. The composer
   * also uses these excerpts to find constraint clauses.
   */
  readonly sourceExcerpts?: readonly string[];
  /**
   * Restrict the operation to a subset of steps (regeneration after a UI
   * change). When supplied, the LLM sees the entire plan for context but the
   * returned entries are only for the requested stepIds.
   */
  readonly stepIds?: readonly string[];
}

export interface GenerateStepTextResult {
  readonly entries: readonly StepCopyEntry[];
  /** Where the whole batch came from. `fallback` means some entries failed. */
  readonly batchSource: StepTextOrigin;
  readonly llmFailureReason: string | null;
  readonly notes: readonly string[];
  readonly model: string | null;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const MAX_STEP_TITLE_LENGTH = 60;
export const MAX_STEP_DESCRIPTION_LENGTH = 480;

/**
 * The only vocabulary the composer uses for intent qualifiers. Every entry is
 * here so a reviewer can read the list and argue with it. The composer never
 * invents a qualifier not in this set.
 */
const INTENT_QUALIFIERS = Object.freeze({
  firstWrite: "new",
  editingExisting: "existing",
  detailsStep: "details",
  confirmStep: "confirmation",
} as const);

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Produce step copy for an entire plan (or a subset of its steps).
 *
 * Throws `StepTextError` for a malformed plan or an empty one. Never throws
 * for a bad LLM response; that path returns a `fallback` batch with the
 * composer output plus a reason.
 */
export async function generateStepTextBatch(
  plan: readonly PlanStep[],
  options: GenerateStepTextOptions = {},
): Promise<GenerateStepTextResult> {
  validatePlan(plan);
  const notes: string[] = [];
  const targetIds =
    options.stepIds !== undefined ? new Set(options.stepIds) : null;

  // Composer output for every step: cheap, always available, and also the
  // fallback when the LLM path fails.
  const composed = new Map<string, StepCopyEntry>();
  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    if (step === undefined) continue;
    const entry = composeStepCopy(plan, i, step, options, notes);
    composed.set(step.stepId, entry);
  }

  const planEntries = collectEntries(plan, composed, targetIds);

  if (options.deterministic === true) {
    return {
      entries: planEntries,
      batchSource: "composed",
      llmFailureReason: null,
      notes: [
        ...notes,
        "Deterministic mode requested; LLM path skipped entirely.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  const llm = options.llm ?? null;
  if (llm === null || !llm.isConfigured()) {
    return {
      entries: planEntries,
      batchSource: "composed",
      llmFailureReason: null,
      notes: [
        ...notes,
        llm === null
          ? "No LLM handle supplied; deterministic composer used for step copy."
          : "LLM handle reported no provider configured; deterministic composer used for step copy.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // LLM path: send the whole plan so the model can consider context.
  let raw: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await llm.complete({
      task: "content.stepText",
      system: buildSystemPrompt(options.style),
      user: buildUserPrompt(plan, options, composed),
      maxOutputChars: Math.min(8000, 400 + plan.length * 400),
      temperature: 0.3,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    raw = response.text;
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  const parsed = raw === null ? null : parseLlmBatch(raw, plan);
  if (parsed === null || parsed.size === 0) {
    const reason =
      failureReason ??
      "LLM returned an unusable step-copy batch; composer output substituted.";
    return {
      entries: planEntries.map((e) => ({
        ...e,
        titleSource: "fallback",
        descriptionSource: "fallback",
        notes: [...e.notes, "Batch fallback: LLM step-copy response was unusable."],
      })),
      batchSource: "fallback",
      llmFailureReason: reason,
      notes: [...notes, "LLM batch response could not be parsed."],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  const merged: StepCopyEntry[] = [];
  for (const entry of planEntries) {
    const llmEntry = parsed.get(entry.stepId);
    if (llmEntry === undefined) {
      // Preserve the composer entry for this step; it was either outside the
      // requested subset or the LLM skipped it.
      merged.push(entry);
      continue;
    }
    const title = trimAtWord(llmEntry.title, MAX_STEP_TITLE_LENGTH);
    const description = trimAtWord(llmEntry.description, MAX_STEP_DESCRIPTION_LENGTH);
    merged.push({
      stepId: entry.stepId,
      ordinal: entry.ordinal,
      title: title.length > 0 ? title : entry.title,
      description: description.length > 0 ? description : entry.description,
      titleSource: title.length > 0 ? "llm" : entry.titleSource,
      descriptionSource: description.length > 0 ? "llm" : entry.descriptionSource,
      clauses: title.length > 0 && description.length > 0 ? [] : entry.clauses,
      notes: entry.notes,
    });
  }

  return {
    entries: merged,
    batchSource: "llm",
    llmFailureReason: null,
    notes,
    model: parsed.values().next().value?.model ?? null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Single-step convenience: produces exactly one entry. Used by the product's
 * per-step regeneration flow when a UI change makes one step stale. Delegates
 * to the batch function so the code path (LLM or composer) is identical.
 */
export async function generateStepText(
  plan: readonly PlanStep[],
  stepId: string,
  options: GenerateStepTextOptions = {},
): Promise<StepCopyEntry> {
  validatePlan(plan);
  if (!plan.some((s) => s.stepId === stepId)) {
    throw new StepTextError(
      `generateStepText: step "${stepId}" is not present in the plan.`,
      "invalid-input",
      { stepId },
    );
  }
  const result = await generateStepTextBatch(plan, {
    ...options,
    stepIds: [stepId],
  });
  const entry = result.entries[0];
  if (entry === undefined) {
    throw new StepTextError(
      `generateStepText: no entry was produced for step "${stepId}".`,
      "invalid-input",
      { stepId },
    );
  }
  return entry;
}

export function rehydrateStepTextBatch(value: unknown): GenerateStepTextResult {
  if (value === null || typeof value !== "object") {
    throw new StepTextError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const raw = Array.isArray(r["entries"]) ? (r["entries"] as unknown[]) : [];
  const entries: StepCopyEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const stepId = readString(o["stepId"]);
    if (stepId === null || stepId.length === 0) continue;
    const ordinalRaw = o["ordinal"];
    const ordinal =
      typeof ordinalRaw === "number" && Number.isFinite(ordinalRaw)
        ? Math.max(1, Math.trunc(ordinalRaw))
        : entries.length + 1;
    entries.push({
      stepId,
      ordinal,
      title: readString(o["title"]) ?? "",
      description: readString(o["description"]) ?? "",
      titleSource: readOrigin(o["titleSource"]),
      descriptionSource: readOrigin(o["descriptionSource"]),
      clauses: Array.isArray(o["clauses"])
        ? (o["clauses"] as unknown[]).filter(
            (c): c is StepCopyEntry["clauses"][number] =>
              c === "action" || c === "purpose" || c === "constraint" || c === "consequence",
          )
        : [],
      notes: Array.isArray(o["notes"])
        ? (o["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    });
  }
  return {
    entries,
    batchSource: readOrigin(r["batchSource"]),
    llmFailureReason: readString(r["llmFailureReason"]),
    notes: Array.isArray(r["notes"])
      ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    model: readString(r["model"]),
    generatedAt: readString(r["generatedAt"]) ?? "",
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic composer                                                      */
/* -------------------------------------------------------------------------- */

function composeStepCopy(
  plan: readonly PlanStep[],
  index: number,
  step: PlanStep,
  options: GenerateStepTextOptions,
  notes: string[],
): StepCopyEntry {
  const stepNotes: string[] = [];
  const priorSteps = plan.slice(0, index);
  const followingSteps = plan.slice(index + 1);
  const qualifier = pickIntentQualifier(step, priorSteps, followingSteps);

  const title = composeTitle(step, qualifier, stepNotes);
  const composed = composeDescription(step, {
    priorSteps,
    followingSteps,
    qualifier,
    guideGoal: options.guideGoal ?? null,
    sourceExcerpts: options.sourceExcerpts ?? [],
    stepNotes,
  });

  // Push per-step notes up to the batch notes as well, so a reviewer reading
  // the batch-level notes sees every annotation. Both lists are preserved.
  for (const n of stepNotes) notes.push(`Step ${step.ordinal}: ${n}`);

  return {
    stepId: step.stepId,
    ordinal: step.ordinal,
    title,
    description: composed.description,
    titleSource: "composed",
    descriptionSource: "composed",
    clauses: composed.clauses,
    notes: stepNotes,
  };
}

function composeTitle(
  step: PlanStep,
  qualifier: string | null,
  stepNotes: string[],
): string {
  const targetName = readableTargetName(step);
  const verb = titleVerbFor(step);
  const body =
    qualifier !== null
      ? `${verb} ${qualifier} ${targetName}`
      : `${verb} ${targetName}`;
  const trimmed = trimAtWord(collapseWhitespace(body), MAX_STEP_TITLE_LENGTH);
  if (qualifier !== null) {
    stepNotes.push(
      `Title qualifier "${qualifier}" added based on the step's position and the plan context.`,
    );
  }
  return capitalise(trimmed);
}

function titleVerbFor(step: PlanStep): string {
  switch (step.action) {
    case "click":
      // A commit click gets a more specific verb than "click".
      if (step.target !== null && step.target.name.length > 0) {
        const commit = /\b(save|submit|create|confirm|apply|ok|done|publish|activate|enable|update)\b/i.exec(
          step.target.name,
        );
        if (commit !== null && commit[1] !== undefined) {
          return capitalise(commit[1].toLowerCase());
        }
      }
      return "Click";
    case "type":
      return "Enter";
    case "select":
      return "Choose";
    case "scroll":
      return "Review";
    case "navigate":
      return "Open";
  }
}

function readableTargetName(step: PlanStep): string {
  if (step.action === "navigate" && step.navigateUrl !== null) {
    try {
      const u = new URL(step.navigateUrl);
      const path = u.pathname.replace(/^\/+/, "");
      if (path.length > 0) return `${u.host}${path === "" ? "" : `/${path.replace(/\/+$/, "")}`}`;
      return u.host;
    } catch {
      return step.navigateUrl;
    }
  }
  if (step.target !== null && step.target.name.length > 0) {
    return step.target.name;
  }
  if (step.target !== null) {
    return `the ${roleNoun(step.target.role)}`;
  }
  return "the target element";
}

function roleNoun(role: string): string {
  switch (role) {
    case "textbox":
    case "searchbox":
      return "field";
    case "combobox":
      return "dropdown";
    case "checkbox":
      return "checkbox";
    case "radio":
    case "menuitemradio":
      return "radio option";
    case "switch":
      return "toggle";
    case "tab":
      return "tab";
    case "link":
      return "link";
    case "button":
      return "button";
    case "menuitem":
      return "menu item";
    case "option":
      return "option";
    case "slider":
      return "slider";
    default:
      return "control";
  }
}

/**
 * Choose the intent qualifier for a step. The qualifier is one of the words
 * in `INTENT_QUALIFIERS`; the composer never adds a qualifier that is not in
 * that set. The decision rules are:
 *
 *   - If the step is the first `type` or `select` in the plan and there is a
 *     later commit click, and the guide's goal mentions "create" or "new",
 *     use `firstWrite` ("new").
 *   - If the step's target names an existing row/record (as evidenced by a
 *     preceding select step), use `editingExisting`.
 *   - If the step is a `type` step and the previous step is a `click` on a
 *     form-opening control, use `detailsStep`.
 *   - If the step is the final commit click and a preceding write step
 *     exists, use `confirmStep`.
 *   - Otherwise, no qualifier.
 */
function pickIntentQualifier(
  step: PlanStep,
  priorSteps: readonly PlanStep[],
  followingSteps: readonly PlanStep[],
): string | null {
  const isWrite = step.action === "type" || step.action === "select";
  const hasFollowingCommit = followingSteps.some(
    (s) =>
      s.action === "click" &&
      s.kind === "submit" &&
      s.target !== null,
  );
  const isFirstWrite =
    isWrite &&
    !priorSteps.some((s) => s.action === "type" || s.action === "select");

  if (isFirstWrite && hasFollowingCommit) {
    return INTENT_QUALIFIERS.firstWrite;
  }

  const priorWrite = priorSteps.some((s) => s.action === "type" || s.action === "select");
  const isCommitClick =
    step.action === "click" &&
    step.kind === "submit" &&
    step.target !== null;
  if (isCommitClick && priorWrite) {
    return INTENT_QUALIFIERS.confirmStep;
  }

  if (isWrite && priorWrite) {
    return INTENT_QUALIFIERS.detailsStep;
  }

  const priorSelect = priorSteps.some((s) => s.action === "select");
  if (isWrite && priorSelect) {
    return INTENT_QUALIFIERS.editingExisting;
  }

  return null;
}

interface DescriptionComposition {
  readonly description: string;
  readonly clauses: readonly StepCopyEntry["clauses"][number][];
}

interface ComposeDescriptionInput {
  readonly priorSteps: readonly PlanStep[];
  readonly followingSteps: readonly PlanStep[];
  readonly qualifier: string | null;
  readonly guideGoal: string | null;
  readonly sourceExcerpts: readonly string[];
  readonly stepNotes: string[];
}

function composeDescription(
  step: PlanStep,
  input: ComposeDescriptionInput,
): DescriptionComposition {
  const clauses: StepCopyEntry["clauses"][number][] = [];
  const sentences: string[] = [];

  // 1. Action clause.
  const actionSentence = actionClause(step);
  if (actionSentence !== null) {
    sentences.push(actionSentence);
    clauses.push("action");
  }

  // 2. Purpose clause. Grounded in the goal and the step's position.
  const purpose = purposeClause(step, input);
  if (purpose !== null) {
    sentences.push(purpose);
    clauses.push("purpose");
  }

  // 3. Constraint clause. Only emitted when a source excerpt names a
  //    constraint that is relevant to this step's target.
  const constraint = constraintClause(step, input);
  if (constraint !== null) {
    sentences.push(constraint);
    clauses.push("constraint");
  }

  // 4. Consequence clause. Grounded in the *next* step's action.
  const consequence = consequenceClause(step, input);
  if (consequence !== null) {
    sentences.push(consequence);
    clauses.push("consequence");
  }

  if (sentences.length === 0) {
    input.stepNotes.push(
      "No description clauses could be grounded in the inputs; description left empty for review.",
    );
  }

  const description = trimAtWord(
    collapseWhitespace(sentences.join(" ")),
    MAX_STEP_DESCRIPTION_LENGTH,
  );

  return { description, clauses };
}

function actionClause(step: PlanStep): string | null {
  const name = readableTargetName(step);
  const quoted = step.target !== null && step.target.name.length > 0
    ? `"${name}"`
    : name;
  const value = step.value ?? "";
  switch (step.action) {
    case "click":
      return `Click ${quoted}.`;
    case "type":
      return value.length > 0
        ? `Type "${value}" into ${quoted}.`
        : `Type the required value into ${quoted}.`;
    case "select":
      return value.length > 0
        ? `Select "${value}" from ${quoted}.`
        : `Select the appropriate option in ${quoted}.`;
    case "scroll":
      return `Scroll to ${quoted}.`;
    case "navigate":
      if (step.navigateUrl !== null) {
        return `Open ${step.navigateUrl}.`;
      }
      return `Navigate to ${quoted}.`;
  }
}

function purposeClause(step: PlanStep, input: ComposeDescriptionInput): string | null {
  const goal = input.guideGoal !== null ? collapseWhitespace(input.guideGoal) : null;
  if (step.kind === "submit") {
    if (goal !== null) {
      return `This commits the workflow so that you can ${lowerFirst(goal)}.`;
    }
    return `This commits the changes made in the preceding steps.`;
  }
  if (step.action === "navigate" && goal !== null) {
    return `This is the starting point for the ${lowerFirst(goal)} workflow.`;
  }
  if (step.action === "type" && input.qualifier === INTENT_QUALIFIERS.detailsStep) {
    return `Fill in the next field of the form.`;
  }
  if (step.kind === "destructive") {
    return `This action permanently removes the selected item.`;
  }
  if (step.kind === "financial") {
    return `This step records a payment-related action and cannot be undone automatically.`;
  }
  if (step.kind === "outbound") {
    return `This action sends a message outside the application; review the recipient before confirming.`;
  }
  return null;
}

function constraintClause(step: PlanStep, input: ComposeDescriptionInput): string | null {
  if (input.sourceExcerpts.length === 0) return null;
  if (step.action !== "type" && step.action !== "select") return null;
  const targetName = (step.target?.name ?? "").toLowerCase();
  const targetLabel = targetName.length > 0 ? targetName : "field";
  const keywords = constraintKeywordsFor(step);
  if (keywords.length === 0) return null;
  for (const excerpt of input.sourceExcerpts) {
    const lower = excerpt.toLowerCase();
    for (const keyword of keywords) {
      if (lower.includes(keyword) && lower.includes(targetLabel.split(" ")[0] ?? "")) {
        const sentence = firstSentenceMentioning(excerpt, keyword);
        if (sentence !== null) {
          return `Note: ${sentence}`;
        }
      }
    }
  }
  return null;
}

function constraintKeywordsFor(step: PlanStep): readonly string[] {
  switch (step.action) {
    case "type":
      return ["must", "required", "unique", "cannot", "should not", "maximum", "minimum"];
    case "select":
      return ["required", "must be", "choose only"];
    default:
      return [];
  }
}

function firstSentenceMentioning(text: string, keyword: string): string | null {
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (s.toLowerCase().includes(keyword)) {
      return s.replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

function consequenceClause(step: PlanStep, input: ComposeDescriptionInput): string | null {
  const next = input.followingSteps[0];
  if (next === undefined) {
    if (step.kind === "submit") {
      return `After confirming, the application returns to the previous page.`;
    }
    return null;
  }
  const nextName = readableTargetName(next);
  if (next.action === "click" && next.target !== null && next.target.name.length > 0) {
    return `The next step asks you to click "${nextName}".`;
  }
  if (next.action === "type") {
    return `The next step asks you to enter a value into "${nextName}".`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* LLM prompt construction                                                     */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(style: StepTextStyle | undefined): string {
  const tone = style?.tone ?? "neutral";
  const audience = style?.audience ?? "end-user";
  const brand = style?.brandTerms ?? [];
  const brandLine =
    brand.length > 0
      ? `Preserve these brand terms verbatim: ${brand.join(", ")}.`
      : "Do not invent product or brand names; use only what the inputs describe.";

  return [
    "You write per-step copy for a step-by-step screenshot tutorial.",
    "",
    "For each step you produce exactly two lines:",
    "    S<ordinal> Title: <short imperative title, <= 60 characters, no trailing period>",
    "    S<ordinal> Description: <one to three sentences, <= 480 characters>",
    "Separate the steps with a blank line.",
    "",
    "Rules:",
    "- The title starts with a verb (Click, Enter, Choose, Open, Review, Save, Submit, Confirm).",
    "- The description explains the action AND why it matters in the workflow; it is not a restatement of the title.",
    "- Do not invent UI labels, page names or values. Use only what the inputs contain.",
    "- Do not add emoji, exclamation marks or marketing copy.",
    "- Do not include the ordinal inside the title or description.",
    `Assume the reader is ${audience}. Use a ${tone} tone.`,
    brandLine,
  ].join("\n");
}

function buildUserPrompt(
  plan: readonly PlanStep[],
  options: GenerateStepTextOptions,
  composed: ReadonlyMap<string, StepCopyEntry>,
): string {
  const lines: string[] = [];
  const goal = readString(options.guideGoal ?? null);
  lines.push(`Guide goal: ${goal ?? "(none supplied)"}`);
  const sources = options.sources ?? [];
  if (sources.length > 0) {
    lines.push("Sources:");
    for (const s of sources) lines.push(`  - [${s.kind}] ${s.label}`);
  } else {
    lines.push("Sources: (none supplied)");
  }
  const excerpts = options.sourceExcerpts ?? [];
  if (excerpts.length > 0) {
    lines.push("Source excerpts (each on its own line; may be used to explain constraints):");
    for (const ex of excerpts) lines.push(`  - ${collapseWhitespace(ex).slice(0, 300)}`);
  }

  lines.push("");
  lines.push("Steps:");
  for (const step of plan) {
    const target =
      step.target !== null && step.target.name.length > 0
        ? `“${step.target.name}”`
        : step.target !== null
          ? `the ${step.target.role}`
          : "(unresolved target)";
    const value = step.value !== null ? ` value=${JSON.stringify(step.value)}` : "";
    const url = step.navigateUrl !== null ? ` url=${step.navigateUrl}` : "";
    lines.push(`  ${step.ordinal}. action=${step.action} target=${target}${value}${url} kind=${step.kind}`);
    const c = composed.get(step.stepId);
    if (c !== undefined) {
      lines.push(`     candidate title: ${c.title}`);
    }
  }

  lines.push("");
  lines.push("Respond with one title/description pair per step, formatted exactly as described.");
  return lines.join("\n");
}

interface ParsedStepEntry {
  readonly stepId: string;
  readonly title: string;
  readonly description: string;
  readonly model: string | null;
}

/**
 * Parse the LLM's batch response. The expected format is one
 * "S<ordinal> Title: ..." and "S<ordinal> Description: ..." pair per step,
 * separated by blank lines. The parser is tolerant of a missing ordinal prefix
 * (falls back to position) and of case variation in the field labels.
 */
function parseLlmBatch(
  raw: string,
  plan: readonly PlanStep[],
): ReadonlyMap<string, ParsedStepEntry> | null {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return null;

  const byOrdinal = new Map<number, { title: string | null; description: string | null }>();

  const lineRe = /^\s*S?(\d+)\s+(title|description)\s*[:\-]\s*(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(text)) !== null) {
    const ordinalRaw = match[1];
    const fieldRaw = match[2];
    const body = match[3];
    if (ordinalRaw === undefined || fieldRaw === undefined || body === undefined) continue;
    const ordinal = Number(ordinalRaw);
    if (!Number.isFinite(ordinal) || ordinal <= 0) continue;
    const current = byOrdinal.get(ordinal) ?? { title: null, description: null };
    if (fieldRaw.toLowerCase() === "title") {
      current.title = sanitiseLine(body);
    } else {
      current.description = sanitiseLine(body);
    }
    byOrdinal.set(ordinal, current);
  }

  // Fallback parse: no ordinal prefix, but at least one title/description
  // pair. Assign by plan order.
  if (byOrdinal.size === 0) {
    const titleRe = /^\s*title\s*[:\-]\s*(.+)$/gim;
    const descRe = /^\s*description\s*[:\-]\s*(.+)$/gim;
    const titles: string[] = [];
    const descriptions: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = titleRe.exec(text)) !== null) {
      if (m[1] !== undefined) titles.push(sanitiseLine(m[1]));
    }
    while ((m = descRe.exec(text)) !== null) {
      if (m[1] !== undefined) descriptions.push(sanitiseLine(m[1]));
    }
    if (titles.length === 0 && descriptions.length === 0) return null;
    const count = Math.max(titles.length, descriptions.length);
    for (let i = 0; i < count; i += 1) {
      byOrdinal.set(i + 1, {
        title: titles[i] ?? null,
        description: descriptions[i] ?? null,
      });
    }
  }

  const byStepId = new Map<string, ParsedStepEntry>();
  for (const step of plan) {
    const parsed = byOrdinal.get(step.ordinal);
    if (parsed === undefined) continue;
    byStepId.set(step.stepId, {
      stepId: step.stepId,
      title: parsed.title ?? "",
      description: parsed.description ?? "",
      model: null,
    });
  }
  return byStepId;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function collectEntries(
  plan: readonly PlanStep[],
  composed: ReadonlyMap<string, StepCopyEntry>,
  targetIds: ReadonlySet<string> | null,
): StepCopyEntry[] {
  const out: StepCopyEntry[] = [];
  for (const step of plan) {
    if (targetIds !== null && !targetIds.has(step.stepId)) continue;
    const entry = composed.get(step.stepId);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

function validatePlan(plan: readonly PlanStep[]): void {
  if (!Array.isArray(plan)) {
    throw new StepTextError(
      "generateStepTextBatch requires a PlanStep array.",
      "invalid-input",
    );
  }
  if (plan.length === 0) {
    throw new StepTextError(
      "Cannot generate step copy for an empty plan.",
      "empty-plan",
    );
  }
  for (const step of plan) {
    if (step === null || typeof step !== "object") {
      throw new StepTextError(
        "Plan contains a non-object step.",
        "invalid-input",
      );
    }
  }
}

function trimAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace < max * 0.6) return `${slice}…`;
  return `${slice.slice(0, lastSpace)}…`;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function sanitiseLine(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capitalise(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v;
}

function readOrigin(v: unknown): StepTextOrigin {
  if (v === "llm" || v === "composed" || v === "fallback") return v;
  return "composed";
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  composeStepCopy,
  composeTitle,
  composeDescription,
  pickIntentQualifier,
  actionClause,
  purposeClause,
  constraintClause,
  consequenceClause,
  parseLlmBatch,
  titleVerbFor,
  readableTargetName,
  INTENT_QUALIFIERS,
  MAX_STEP_TITLE_LENGTH,
  MAX_STEP_DESCRIPTION_LENGTH,
});
