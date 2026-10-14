/**
 * Zipy AI — interactive content: scenario questions
 * (editing & collaboration, batch 1).
 *
 * A *scenario* question is one whose stem narrates a starting state and a
 * goal, and whose answer requires the reader to reason about the workflow
 * rather than recall a single fact. This module generates scenario
 * questions from an already-approved workflow plan and its optional
 * conditional graph.
 *
 * Where the scenario questions in `quiz.ts` (batch 1) are a *single*
 * question per plan and sit alongside recall questions, this module is the
 * dedicated surface for the scenario kind: it can produce several scenario
 * questions, each from a different seed (a step's precondition, a
 * conditional branch, or a recovery path).
 *
 * Scenario shape:
 *
 *   - **Setup** — a one-sentence narrative placing the reader in a state
 *     the plan supports (a page they have open, a value they have just
 *     typed, a branch they are about to reach). The composer never invents
 *     product state; every noun in the setup refers to a plan step, a plan
 *     target, or the plan's goal.
 *   - **Question** — a single-sentence prompt asking what happens next (or
 *     what to do next). The question always has a determinate answer that
 *     is *checkable against the plan*.
 *   - **Options** — either a small set of named controls (drawn from the
 *     plan's own element names) with one correct, or two paragraphs
 *     describing outcomes (positive/negative) with one correct.
 *   - **Rationale per option** — every option carries a rationale; the
 *     wrong rationales state the invariant the reader might have confused
 *     ("selecting this control belongs to a different branch").
 *
 * The module produces questions in three seed classes:
 *
 *   `step-precondition` — "You are on the page before step N. What do you
 *     do?" Answer: the action step N performs. Only generated for steps
 *     with a named target.
 *
 *   `branch-true` / `branch-false` — for each conditional edge in the plan
 *     graph, a scenario that asks what happens when the condition holds,
 *     and (when a sibling edge is present) what happens when it does not.
 *
 *   `recovery` — for a step whose plan action fails (element not present),
 *     a scenario asks how the reader recovers. The correct answer is
 *     determined by the one recovery path the plan supports (retry the
 *     previous step, or reach the same action via the guide's alternative
 *     selector); when the plan supports neither, the composer records a
 *     `ScenarioGap` instead of inventing a recovery.
 *
 * Design rules honoured:
 *  - No facts invented. Every proper noun in a scenario also appears in the
 *    plan; unknown nouns are excluded.
 *  - Deterministic. Option order and scenario selection use the same
 *    seeded LCG used by `quiz.ts`, so a plan produces the same scenarios
 *    on every run.
 *  - The scenario format is JSON (`ScenarioQuestion[]`) so it can be
 *    embedded in the guide's interactive widget or exported to a course
 *    platform without a bespoke schema.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ScenarioErrorCode = "invalid-input" | "no-goal" | "no-steps";

export class ScenarioError extends Error {
  readonly code: ScenarioErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ScenarioErrorCode,
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

export const SCENARIO_SEED_KINDS = [
  "step-precondition",
  "branch-true",
  "branch-false",
  "recovery",
] as const;
export type ScenarioSeedKind = (typeof SCENARIO_SEED_KINDS)[number];

export interface ScenarioOption {
  readonly id: string;
  readonly text: string;
  readonly correct: boolean;
  /** Always non-empty; states why the option is or is not the scenario's answer. */
  readonly rationale: string;
}

export interface ScenarioQuestion {
  readonly id: string;
  readonly seed: ScenarioSeedKind;
  /** One-sentence narrative placing the reader in the situation. */
  readonly setup: string;
  /** What the reader is asked. */
  readonly question: string;
  readonly options: readonly ScenarioOption[];
  /** Ids of correct options, in `options` order. */
  readonly correctOptionIds: readonly string[];
  /** Plain-text answer for the export layer. */
  readonly answerText: string;
  /** Points the question is worth (all scenario questions are worth 3). */
  readonly points: 3;
  /** 1 = easy, 2 = medium, 3 = hard; scenario questions are always 3. */
  readonly difficulty: 3;
  /** Provenance: which step (or branch origin) the scenario targets. */
  readonly sourceStepId: string | null;
}

export interface ScenarioGap {
  readonly sourceStepId: string | null;
  readonly reason:
    | "no-steps"
    | "no-target"
    | "no-branches"
    | "no-sibling-branch"
    | "no-recovery-path"
    | "no-distractors";
  readonly detail: string;
}

export interface ScenarioSet {
  readonly version: "scenarios/1";
  readonly title: string;
  readonly questions: readonly ScenarioQuestion[];
  readonly gaps: readonly ScenarioGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface ScenarioInputs {
  readonly plan: Plan;
  readonly title?: string | null;
  /** Cap on scenario count (default 4). */
  readonly maxScenarios?: number;
  /**
   * Whether to generate a recovery scenario for the first step that
   * requires input (a `type` or `select` step). Default: true.
   */
  readonly includeRecovery?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeScenarios(inputs: ScenarioInputs): ScenarioSet {
  if (inputs === null || typeof inputs !== "object") {
    throw new ScenarioError("composeScenarios requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new ScenarioError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new ScenarioError("The plan does not expose a goal.", "no-goal");
  }
  const goal = goalRaw.trim();
  const maxScenarios = clampInt(inputs.maxScenarios, 4, 1, 20);
  const includeRecovery = inputs.includeRecovery !== false;

  const steps = readSteps(plan);
  if (steps.length === 0) {
    throw new ScenarioError(
      "The plan contains no steps; scenario questions cannot be generated.",
      "no-steps",
    );
  }

  const gaps: ScenarioGap[] = [];
  const allTargets = collectTargetNames(steps);
  const questions: ScenarioQuestion[] = [];

  // 1. One precondition scenario for the first step with a named target.
  const firstTarget = steps.find((s) => targetNameOrNull(s.planStep) !== null) ?? null;
  if (firstTarget === null) {
    gaps.push({
      sourceStepId: null,
      reason: "no-target",
      detail: "No step in the plan names a target element; a precondition scenario was not generated.",
    });
  } else {
    const name = targetNameOrNull(firstTarget.planStep);
    /* istanbul ignore next — firstTarget is guaranteed non-null target. */
    if (name !== null) {
      const distractors = pickDistractors(name, allTargets, 2);
      if (distractors.length < 2) {
        gaps.push({
          sourceStepId: firstTarget.id,
          reason: "no-distractors",
          detail: "The plan does not name at least three distinct controls for a precondition scenario.",
        });
      } else {
        const setup = `You are at the page where the workflow "${goal}" begins. You can see the following controls: ${[name, ...distractors].map((n) => `"${n}"`).join(", ")}.`;
        const question = `Which control does the workflow interact with first?`;
        const options: ScenarioOption[] = [
          {
            id: "opt-first",
            text: name,
            correct: true,
            rationale: `${name} is the first named control the plan interacts with.`,
          },
        ];
        let idx = 0;
        for (const d of distractors) {
          idx += 1;
          options.push({
            id: `opt-${idx}`,
            text: d,
            correct: false,
            rationale: `"${d}" is used later in the workflow, not at the first step.`,
          });
        }
        const shuffled = shuffleDeterministic(options, 0);
        questions.push({
          id: "sc-first",
          seed: "step-precondition",
          setup,
          question,
          options: shuffled,
          correctOptionIds: shuffled.filter((o) => o.correct).map((o) => o.id),
          answerText: name,
          points: 3,
          difficulty: 3,
          sourceStepId: firstTarget.id,
        });
      }
    }
  }

  // 2. One scenario per conditional edge, if any.
  const branches = collectConditionalBranches(plan, steps);
  if (branches.length === 0) {
    gaps.push({
      sourceStepId: null,
      reason: "no-branches",
      detail: "The plan exposes no conditional edges; branch scenarios were not generated.",
    });
  } else {
    for (const branch of branches) {
      if (questions.length >= maxScenarios) break;
      const thenName = branch.thenTarget;
      const elseName = branch.elseTarget;
      if (thenName === null) {
        gaps.push({
          sourceStepId: branch.thenStepId,
          reason: "no-target",
          detail: `The plan's "then" branch step "${branch.thenStepId}" has no named target; a branch scenario was skipped.`,
        });
        continue;
      }
      if (elseName === null) {
        gaps.push({
          sourceStepId: branch.elseStepId,
          reason: "no-sibling-branch",
          detail: `The plan's "else" branch step "${branch.elseStepId}" has no named target; a two-option branch scenario was skipped.`,
        });
        // Even without an else, generate a true-only scenario with a
        // distractor drawn from the plan's other elements — never invent.
        const distractors = pickDistractors(thenName, allTargets, 2);
        if (distractors.length < 2) continue;
        const options: ScenarioOption[] = [
          {
            id: "opt-then",
            text: thenName,
            correct: true,
            rationale: `When the condition "${branch.condition}" is true, the workflow proceeds with ${thenName}.`,
          },
        ];
        let idx = 0;
        for (const d of distractors) {
          idx += 1;
          options.push({
            id: `opt-${idx}`,
            text: d,
            correct: false,
            rationale: `"${d}" is not the branch target for the condition "${branch.condition}".`,
          });
        }
        const shuffled = shuffleDeterministic(options, branch.thenStepId.length);
        questions.push({
          id: `sc-branch-true-${branch.originStepId}`,
          seed: "branch-true",
          setup: `The workflow reaches a decision point after step "${branch.originStepId}". The condition is: "${branch.condition}".`,
          question: "When the condition is true, which control does the workflow use next?",
          options: shuffled,
          correctOptionIds: shuffled.filter((o) => o.correct).map((o) => o.id),
          answerText: thenName,
          points: 3,
          difficulty: 3,
          sourceStepId: branch.thenStepId,
        });
        continue;
      }

      // Both branches present: generate a true-branch scenario.
      const options: ScenarioOption[] = [
        {
          id: "opt-then",
          text: thenName,
          correct: true,
          rationale: `When the condition "${branch.condition}" is true, the workflow proceeds with ${thenName}.`,
        },
        {
          id: "opt-else",
          text: elseName,
          correct: false,
          rationale: `"${elseName}" is the control used on the *other* branch (condition false), not this one.`,
        },
      ];
      const shuffled = shuffleDeterministic(options, branch.originStepId.length);
      questions.push({
        id: `sc-branch-true-${branch.originStepId}`,
        seed: "branch-true",
        setup: `The workflow reaches a decision point after step "${branch.originStepId}". The condition is: "${branch.condition}".`,
        question: "When the condition is true, which control does the workflow use next?",
        options: shuffled,
        correctOptionIds: shuffled.filter((o) => o.correct).map((o) => o.id),
        answerText: thenName,
        points: 3,
        difficulty: 3,
        sourceStepId: branch.thenStepId,
      });

      if (questions.length >= maxScenarios) break;

      const optionsFalse: ScenarioOption[] = [
        {
          id: "opt-then",
          text: thenName,
          correct: false,
          rationale: `"${thenName}" is used when the condition "${branch.condition}" is true, not when it is false.`,
        },
        {
          id: "opt-else",
          text: elseName,
          correct: true,
          rationale: `When the condition "${branch.condition}" is false, the workflow uses ${elseName}.`,
        },
      ];
      const shuffledFalse = shuffleDeterministic(optionsFalse, branch.originStepId.length + 1);
      questions.push({
        id: `sc-branch-false-${branch.originStepId}`,
        seed: "branch-false",
        setup: `The workflow reaches a decision point after step "${branch.originStepId}". The condition is: "${branch.condition}".`,
        question: "When the condition is false, which control does the workflow use next?",
        options: shuffledFalse,
        correctOptionIds: shuffledFalse.filter((o) => o.correct).map((o) => o.id),
        answerText: elseName,
        points: 3,
        difficulty: 3,
        sourceStepId: branch.elseStepId,
      });
    }
  }

  // 3. Recovery scenario for a `type`/`select` step.
  if (includeRecovery && questions.length < maxScenarios) {
    const inputStep = steps.find(
      (s) => s.planStep.action === "type" || s.planStep.action === "select",
    );
    if (inputStep === undefined) {
      gaps.push({
        sourceStepId: null,
        reason: "no-recovery-path",
        detail: "The plan has no input step; a recovery scenario was not generated.",
      });
    } else {
      const name = targetNameOrNull(inputStep.planStep);
      const value = valueOrNull(inputStep.planStep);
      if (name === null || value === null) {
        gaps.push({
          sourceStepId: inputStep.id,
          reason: "no-recovery-path",
          detail: `Input step "${inputStep.id}" does not name both a target and a value; a recovery scenario was skipped.`,
        });
      } else {
        const prevStep = steps[inputStep.index - 2];
        const prevName = prevStep !== undefined ? targetNameOrNull(prevStep.planStep) : null;
        if (prevName === null) {
          gaps.push({
            sourceStepId: inputStep.id,
            reason: "no-recovery-path",
            detail: `The step before "${inputStep.id}" does not name a target, so a retry scenario was not generated.`,
          });
        } else {
          const distractors = pickDistractors(name, allTargets, 1);
          const distraction = distractors[0] ?? null;
          if (distraction === null) {
            gaps.push({
              sourceStepId: inputStep.id,
              reason: "no-distractors",
              detail: "Not enough named controls in the plan to build a recovery scenario.",
            });
          } else {
            const options: ScenarioOption[] = [
              {
                id: "opt-retry",
                text: `Re-perform step "${prevName}", then retry ${name}.`,
                correct: true,
                rationale: `The plan shows ${prevName} as the step immediately before ${name}; retrying from the last confirmed state is the supported recovery path.`,
              },
              {
                id: "opt-skip",
                text: `Skip ${name} and continue to the next step.`,
                correct: false,
                rationale: `The plan does not support skipping ${name}; the workflow expects ${value} to be entered here.`,
              },
              {
                id: "opt-other",
                text: `Use ${distraction} instead.`,
                correct: false,
                rationale: `"${distraction}" performs a different action in this workflow and does not substitute for entering a value in ${name}.`,
              },
            ];
            const shuffled = shuffleDeterministic(options, inputStep.index);
            questions.push({
              id: `sc-recovery-${inputStep.id}`,
              seed: "recovery",
              setup: `During step "${inputStep.id}", the ${name} field does not accept the value you attempt to enter. The step immediately before it was "${prevName}".`,
              question: `What does the workflow's recovery path recommend?`,
              options: shuffled,
              correctOptionIds: shuffled.filter((o) => o.correct).map((o) => o.id),
              answerText: `Re-perform step "${prevName}", then retry ${name}.`,
              points: 3,
              difficulty: 3,
              sourceStepId: inputStep.id,
            });
          }
        }
      }
    }
  }

  const title =
    nonEmpty(inputs.title) ?? `Scenario questions: ${goal.replace(/^how\s+to\s+/i, "")}`;

  return {
    version: "scenarios/1",
    title,
    questions: questions.slice(0, maxScenarios),
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render a scenario set as plain Markdown, with each question's options
 * listed and a separate answer key at the end (so a reviewer can scan the
 * question without seeing the answer).
 */
export function renderScenariosMarkdown(set: ScenarioSet): string {
  const parts: string[] = [];
  parts.push(`# ${set.title}`);
  parts.push("");
  parts.push(
    `_${set.questions.length} scenario question${set.questions.length === 1 ? "" : "s"}; each is worth 3 points._`,
  );
  parts.push("");
  const key: string[] = [];
  for (let i = 0; i < set.questions.length; i += 1) {
    const q = set.questions[i]!;
    parts.push(`### ${i + 1}. ${q.setup}`);
    parts.push("");
    parts.push(q.question);
    parts.push("");
    for (const opt of q.options) {
      parts.push(`- ${opt.text}`);
    }
    parts.push("");
    key.push(`${i + 1}. ${q.answerText}`);
  }
  parts.push("## Answer key");
  parts.push("");
  for (const line of key) parts.push(`- ${line}`);
  parts.push("");
  if (set.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Scenario gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of set.gaps) {
      parts.push(`- ${gap.sourceStepId !== null ? `Step ${gap.sourceStepId}: ` : ""}${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildScenarioDirectives(): string {
  return [
    "You are writing scenario questions over an already approved workflow plan.",
    "Each question has three parts: a one-sentence setup that places the reader in a specific state, a one-sentence question that asks what happens or what to do, and a small set of options with exactly one correct.",
    "Every noun in the setup and question must appear in the plan (as a step target, a step value, a step id, or the plan's goal). Do not invent product state, error messages or system names.",
    "Options are drawn from the plan's own element names or from actions the plan performs; wrong options state the confused invariant in their rationale ('belongs to a different branch', 'not the first step').",
    "Recovery scenarios are only generated when the plan makes the recovery path explicit; do not invent an undo, retry, or fallback the plan does not mention.",
    "Do not use the word 'simply'. Do not include marketing language.",
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

interface BranchInfo {
  readonly originStepId: string;
  readonly condition: string;
  readonly thenStepId: string;
  readonly elseStepId: string;
  readonly thenTarget: string | null;
  readonly elseTarget: string | null;
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

function collectTargetNames(steps: readonly IndexedStep[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of steps) {
    const name = targetNameOrNull(s.planStep);
    if (name === null) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function targetNameOrNull(step: PlanStep): string | null {
  const t = (step as { target?: unknown }).target;
  if (t === null || typeof t !== "object") return null;
  const name = (t as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function valueOrNull(step: PlanStep): string | null {
  const v = (step as { value?: unknown }).value;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectConditionalBranches(
  plan: Plan,
  steps: readonly IndexedStep[],
): readonly BranchInfo[] {
  const graph = (plan as { graph?: unknown }).graph;
  if (graph === null || typeof graph !== "object") return [];
  const edges = (graph as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) return [];

  const byFromAndCondition = new Map<string, { from: string; condition: string; to: string }[]>();
  for (const e of edges) {
    if (e === null || typeof e !== "object") continue;
    const edge = e as Record<string, unknown>;
    const from = typeof edge["from"] === "string" ? (edge["from"] as string) : "";
    const to = typeof edge["to"] === "string" ? (edge["to"] as string) : "";
    if (from.length === 0 || to.length === 0) continue;
    const condition = typeof edge["condition"] === "string" ? (edge["condition"] as string).trim() : "";
    if (condition.length === 0) continue;
    const key = `${from}\u0001${condition}`;
    const list = byFromAndCondition.get(key) ?? [];
    list.push({ from, condition, to });
    byFromAndCondition.set(key, list);
  }

  const branches: BranchInfo[] = [];
  const consumedElse = new Set<string>();
  for (const group of byFromAndCondition.values()) {
    for (const t of group) {
      // The "else" sibling is the first unconditional outgoing edge from
      // `t.from` that is not already accounted for as a "then" of another
      // condition.
      let elseEdge: { from: string; to: string } | null = null;
      for (const candidate of edges) {
        if (candidate === null || typeof candidate !== "object") continue;
        const c = candidate as Record<string, unknown>;
        if (typeof c["from"] !== "string" || c["from"] !== t.from) continue;
        if (typeof c["to"] !== "string") continue;
        const cCond = typeof c["condition"] === "string" ? (c["condition"] as string).trim() : "";
        if (cCond.length > 0) continue;
        if (t.to === c["to"]) continue;
        const key = `${t.from}\u0001${c["to"]}`;
        if (consumedElse.has(key)) continue;
        elseEdge = { from: t.from, to: c["to"] };
        consumedElse.add(key);
        break;
      }
      if (elseEdge === null) continue;
      const thenStep = steps.find((s) => s.id === t.to) ?? null;
      const elseStep = steps.find((s) => s.id === elseEdge.to) ?? null;
      branches.push({
        originStepId: t.from,
        condition: t.condition,
        thenStepId: t.to,
        elseStepId: elseEdge.to,
        thenTarget: thenStep !== null ? targetNameOrNull(thenStep.planStep) : null,
        elseTarget: elseStep !== null ? targetNameOrNull(elseStep.planStep) : null,
      });
    }
  }
  return branches;
}

function pickDistractors(
  correct: string,
  pool: readonly string[],
  count: number,
): readonly string[] {
  const correctKey = correct.toLowerCase();
  const candidates = pool.filter((p) => p.toLowerCase() !== correctKey);
  if (candidates.length < count) return candidates;
  return candidates.slice(0, count);
}

function shuffleDeterministic<T>(items: readonly T[], seed: number): readonly T[] {
  const out = items.slice();
  let state = (seed * 2654435761 + 1) >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i];
    const b = out[j];
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
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
  readSteps,
  collectTargetNames,
  targetNameOrNull,
  valueOrNull,
  collectConditionalBranches,
  pickDistractors,
  shuffleDeterministic,
  clampInt,
});
