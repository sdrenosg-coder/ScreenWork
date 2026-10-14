/**
 * Zipy AI — interactive content: quiz generation
 * (editing & collaboration, batch 1).
 *
 * Generates a quiz from an already-approved workflow plan. This module is
 * the *interactive* sibling of `packages/content/src/longform/quizFlashcards.ts`:
 *
 *   - `quizFlashcards.ts` produces a **static** study / print artefact
 *     (questions with an answer key, flashcards).
 *   - `quiz.ts` (this module) produces an **interactive assessment**: a
 *     set of questions with *graded* answer keys, distractor rationales
 *     (why each wrong option is wrong), a per-question `points` weight and
 *     a `passThreshold`, suitable for rendering as a self-check widget or
 *     persisting to a course system. Scenarios and multi-answer questions
 *     live here; the static surface does not need them.
 *
 * Both modules derive their questions deterministically from the same
 * plan. Neither module invents facts: every question stem references a
 * step (`stepId`) and a real element name in the plan. Multiple-choice
 * distractors are drawn from *other* plan elements, so they are wrong *by
 * construction* — never fabricated.
 *
 * Design boundaries honoured here:
 *  - No LLM call. The composer is deterministic; the route can pass the
 *    output through a style/tone pass separately.
 *  - No randomness that leaks into output. The deterministic shuffle is
 *    seeded from the step index (see `shuffleDeterministic`), so two runs
 *    of `composeInteractiveQuiz` on the same plan produce the same bytes.
 *  - Every question carries `sourceStepId` (or `null` for pure-glossary
 *    questions) so the review phase can trace an answer to its origin.
 *  - Distractor rationales never claim a fact the plan does not support;
 *    they state the *rule* the distractor violates ("this control belongs
 *    to a different step").
 *  - The composer records `gaps` rather than filling missing branches with
 *    filler; the review surface shows what the plan did not support.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type InteractiveQuizErrorCode = "invalid-input" | "no-goal" | "no-steps";

export class InteractiveQuizError extends Error {
  readonly code: InteractiveQuizErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: InteractiveQuizErrorCode,
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

export const INTERACTIVE_QUESTION_KINDS = [
  "multiple-choice",
  "multi-answer",
  "true-false",
  "fill-in-the-blank",
  "scenario",
] as const;
export type InteractiveQuestionKind = (typeof INTERACTIVE_QUESTION_KINDS)[number];

export interface InteractiveQuizOption {
  readonly id: string;
  readonly text: string;
  readonly correct: boolean;
  /**
   * Why this option is wrong (or why it is correct). Populated for every
   * option; a review surface can render the rationale next to each option.
   * Empty string is never produced — the composer writes at least a short
   * sentence for the correct and for each incorrect option.
   */
  readonly rationale: string;
}

export interface InteractiveQuizQuestion {
  /** Stable id within the quiz: `q-<n>` derived from plan order + kind. */
  readonly id: string;
  readonly kind: InteractiveQuestionKind;
  /** The question stem. */
  readonly stem: string;
  readonly options: readonly InteractiveQuizOption[];
  /** Every option id that is correct, in the order they appear in `options`. */
  readonly correctOptionIds: readonly string[];
  /** Answer as plain text; useful for the export layer. */
  readonly answerText: string;
  /** The `points` awarded for a fully correct answer. */
  readonly points: number;
  /** Provenance. `null` only for glossary-derived questions. */
  readonly sourceStepId: string | null;
  /** 1 = easy, 2 = medium, 3 = hard. Advisory. */
  readonly difficulty: 1 | 2 | 3;
}

export interface InteractiveQuizGap {
  readonly sourceStepId: string | null;
  readonly reason:
    | "no-steps"
    | "no-target"
    | "no-value"
    | "insufficient-distractors"
    | "no-glossary-for-fill-in"
    | "no-conditional-branch";
  readonly detail: string;
}

export interface InteractiveQuiz {
  readonly version: "interactive-quiz/1";
  readonly title: string;
  readonly instructions: string;
  readonly questions: readonly InteractiveQuizQuestion[];
  readonly gaps: readonly InteractiveQuizGap[];
  /** Sum of `points` across questions. */
  readonly totalPoints: number;
  /** Absolute points required to pass. */
  readonly passThreshold: number;
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface InteractiveQuizInputs {
  readonly plan: Plan;
  readonly title?: string | null;
  /** Optional instructions; a sensible default is provided when omitted. */
  readonly instructions?: string | null;
  /**
   * Glossary term/definition pairs. Used for true/false and fill-in-the-blank
   * (the blank is the term; the "word bank" is drawn from other glossary
   * terms, never fabricated).
   */
  readonly glossary?: readonly { readonly term: string; readonly definition: string }[];
  /**
   * Per-step English from the core writing layers. When supplied, the
   * step description is used verbatim as a rationale, so the quiz's
   * "why" matches the guide's "what".
   */
  readonly stepText?: Readonly<
    Record<string, { readonly title: string; readonly description: string }>
  >;
  /** Cap on question count (default: 10). */
  readonly maxQuestions?: number;
  /** Fraction of total points required to pass (default: 0.7, i.e. 70%). */
  readonly passFraction?: number;
  /**
   * Whether a scenario question is generated when the plan exposes exactly
   * one conditional branch. Scenarios require a real branch; when no
   * branch is present the composer records a gap.
   */
  readonly includeScenarios?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeInteractiveQuiz(inputs: InteractiveQuizInputs): InteractiveQuiz {
  if (inputs === null || typeof inputs !== "object") {
    throw new InteractiveQuizError("composeInteractiveQuiz requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new InteractiveQuizError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new InteractiveQuizError("The plan does not expose a goal.", "no-goal");
  }
  const goal = goalRaw.trim();
  const maxQuestions = clampInt(inputs.maxQuestions, 10, 1, 40);
  const passFraction = clampFraction(inputs.passFraction, 0.7);
  const includeScenarios = inputs.includeScenarios !== false;

  const steps = readSteps(plan);
  if (steps.length === 0) {
    throw new InteractiveQuizError(
      "The plan contains no steps; a quiz cannot be generated.",
      "no-steps",
    );
  }

  const gaps: InteractiveQuizGap[] = [];
  const targets = collectTargetNames(steps);
  const glossary = pruneGlossary(inputs.glossary ?? []);

  const questions: InteractiveQuizQuestion[] = [];

  // --- Question 1 per step: which control advances the workflow? --------
  for (const step of steps) {
    if (questions.length >= maxQuestions) break;
    const targetName = targetNameOrNull(step.planStep);
    if (targetName === null) {
      gaps.push({
        sourceStepId: step.id,
        reason: "no-target",
        detail: `Step ${step.index} has no target element name; a control question was skipped.`,
      });
      continue;
    }
    const distractors = pickDistractors(targetName, targets, 3);
    if (distractors.length < 3) {
      gaps.push({
        sourceStepId: step.id,
        reason: "insufficient-distractors",
        detail: `Step ${step.index} has fewer than three other named elements in the plan for multiple-choice distractors.`,
      });
      continue;
    }
    const review = inputs.stepText?.[step.id];
    const correctRationale =
      review !== undefined && review.description.trim().length > 0
        ? review.description.trim()
        : defaultRationale(step.planStep);
    const options = buildSingleChoice(
      targetName,
      correctRationale,
      distractors,
      step.index,
    );
    questions.push({
      id: `q-${step.index}-action`,
      kind: "multiple-choice",
      stem: actionStem(step.planStep),
      options,
      correctOptionIds: options.filter((o) => o.correct).map((o) => o.id),
      answerText: targetName,
      points: difficultyFor(step.planStep) === 1 ? 1 : 2,
      sourceStepId: step.id,
      difficulty: difficultyFor(step.planStep),
    });
  }

  // --- Fill-in-the-blank for every step with an explicit value ----------
  for (const step of steps) {
    if (questions.length >= maxQuestions) break;
    const value = valueOrNull(step.planStep);
    if (value === null) {
      gaps.push({
        sourceStepId: step.id,
        reason: "no-value",
        detail: `Step ${step.index} has no explicit sample value; a fill-in-the-blank question was skipped.`,
      });
      continue;
    }
    const target = targetNameOrNull(step.planStep);
    questions.push({
      id: `q-${step.index}-value`,
      kind: "fill-in-the-blank",
      stem:
        target !== null
          ? `Fill in the blank: in ${target}, enter ______.`
          : `Fill in the blank: the workflow requires the value ______ at this step.`,
      options: [], // free-text answer
      correctOptionIds: [],
      answerText: value,
      points: 2,
      sourceStepId: step.id,
      difficulty: 2,
    });
  }

  // --- Glossary-driven true/false --------------------------------------
  for (const entry of glossary) {
    if (questions.length >= maxQuestions) break;
    const options: InteractiveQuizOption[] = [
      {
        id: "opt-true",
        text: "True",
        correct: true,
        rationale: `The glossary defines "${entry.term}" as: ${entry.definition}`,
      },
      {
        id: "opt-false",
        text: "False",
        correct: false,
        rationale: `This statement does not contradict the glossary definition of "${entry.term}"; the correct answer is True.`,
      },
    ];
    questions.push({
      id: `q-term-${slugifyId(entry.term)}`,
      kind: "true-false",
      stem: `True or false: in this workflow, "${entry.term}" means: ${entry.definition}`,
      options,
      correctOptionIds: ["opt-true"],
      answerText: "True",
      points: 1,
      sourceStepId: null,
      difficulty: 1,
    });
  }

  // --- Multi-answer: the fields a step in this workflow requires --------
  // Only produced when the plan exposes at least two `type`/`select` steps
  // with distinct targets, so the "which fields are required" question is
  // grounded in the plan.
  if (questions.length < maxQuestions) {
    const fieldSteps = steps.filter(
      (s) => s.planStep.action === "type" || s.planStep.action === "select",
    );
    const distinctFields = new Map<string, string>(); // lowercased name → display name
    for (const s of fieldSteps) {
      const name = targetNameOrNull(s.planStep);
      if (name !== null) distinctFields.set(name.toLowerCase(), name);
    }
    if (distinctFields.size >= 2) {
      const correct = [...distinctFields.values()].slice(0, 3);
      // Distractors: any other named elements that are *not* input-like.
      const noneFields: string[] = [];
      const seen = new Set(correct.map((c) => c.toLowerCase()));
      for (const name of targets) {
        if (seen.has(name.toLowerCase())) continue;
        noneFields.push(name);
        if (noneFields.length >= 2) break;
      }
      if (noneFields.length >= 1) {
        const options: InteractiveQuizOption[] = [];
        let idx = 0;
        for (const c of correct) {
          idx += 1;
          options.push({
            id: `opt-${idx}`,
            text: c,
            correct: true,
            rationale: `The plan fills "${c}" as part of this workflow.`,
          });
        }
        for (const d of noneFields) {
          idx += 1;
          options.push({
            id: `opt-${idx}`,
            text: d,
            correct: false,
            rationale: `"${d}" is a control in the plan but is not filled with a value during this workflow.`,
          });
        }
        const shuffled = shuffleDeterministic(options, 0);
        questions.push({
          id: "q-multi-fields",
          kind: "multi-answer",
          stem: "Which of the following fields does the workflow fill in with a value? Select every one that applies.",
          options: shuffled,
          correctOptionIds: shuffled.filter((o) => o.correct).map((o) => o.id),
          answerText: correct.join(", "),
          points: 3,
          sourceStepId: null,
          difficulty: 3,
        });
      }
    }
  }

  // --- Scenario from a conditional branch (if one exists) ---------------
  if (includeScenarios && questions.length < maxQuestions) {
    const branch = findConditionalBranch(plan);
    if (branch === null) {
      gaps.push({
        sourceStepId: null,
        reason: "no-conditional-branch",
        detail: "The plan exposes no conditional branch; a scenario question was not generated.",
      });
    } else {
      const { condition, thenStepId, elseStepId } = branch;
      const thenStep = steps.find((s) => s.id === thenStepId) ?? null;
      const elseStep = steps.find((s) => s.id === elseStepId) ?? null;
      const thenName = thenStep !== null ? targetNameOrNull(thenStep.planStep) : null;
      const elseName = elseStep !== null ? targetNameOrNull(elseStep.planStep) : null;
      if (thenName !== null && elseName !== null) {
        const options: InteractiveQuizOption[] = [
          {
            id: "opt-then",
            text: thenName,
            correct: true,
            rationale: `When the condition "${condition}" is true, the workflow proceeds with "${thenName}".`,
          },
          {
            id: "opt-else",
            text: elseName,
            correct: false,
            rationale: `"${elseName}" is the control used on the *other* branch (condition false), not this one.`,
          },
        ];
        const shuffled = shuffleDeterministic(options, 1);
        questions.push({
          id: "q-scenario-branch",
          kind: "scenario",
          stem: `The workflow reaches a branch with the condition: "${condition}". When the condition is *true*, which control does the workflow use next?`,
          options: shuffled,
          correctOptionIds: shuffled.filter((o) => o.correct).map((o) => o.id),
          answerText: thenName,
          points: 3,
          sourceStepId: thenStepId,
          difficulty: 3,
        });
      }
    }
  }

  const title =
    nonEmpty(inputs.title) ?? `Interactive quiz: ${goal.replace(/^how\s+to\s+/i, "")}`;
  const instructions =
    nonEmpty(inputs.instructions) ??
    "Answer every question. Your score is shown once you submit; each wrong answer links back to the workflow step it is drawn from.";

  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);
  const passThreshold = Math.max(1, Math.ceil(totalPoints * passFraction));

  return {
    version: "interactive-quiz/1",
    title,
    instructions,
    questions: questions.slice(0, maxQuestions),
    gaps,
    totalPoints,
    passThreshold,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Grade a submission. `answers` maps question id to the option ids the
 * candidate selected (for select-based questions) or to a free-text string
 * (for fill-in-the-blank). Returns a per-question grade and the total.
 * Grading is deterministic; a missing answer counts as incorrect and is
 * reflected in the result with `answered: false`.
 */
export function gradeInteractiveQuiz(
  quiz: InteractiveQuiz,
  answers: Readonly<Record<string, readonly string[] | string>>,
): InteractiveQuizGrade {
  if (quiz === null || typeof quiz !== "object") {
    throw new InteractiveQuizError("gradeInteractiveQuiz requires a quiz object.", "invalid-input");
  }
  if (answers === null || typeof answers !== "object") {
    throw new InteractiveQuizError("gradeInteractiveQuiz requires an answers object.", "invalid-input");
  }
  let earned = 0;
  let total = 0;
  const perQuestion: InteractiveQuizQuestionGrade[] = [];
  for (const question of quiz.questions) {
    total += question.points;
    const raw = answers[question.id];
    let awarded = 0;
    let answered = raw !== undefined;
    let note: string;
    switch (question.kind) {
      case "multiple-choice":
      case "true-false":
      case "multi-answer":
      case "scenario": {
        const selected = Array.isArray(raw)
          ? raw.filter((x): x is string => typeof x === "string")
          : typeof raw === "string" && raw.length > 0
            ? [raw]
            : [];
        if (selected.length === 0) {
          answered = false;
          note = "No option was selected.";
          break;
        }
        const correctSet = new Set(question.correctOptionIds);
        const selectedSet = new Set(selected);
        const perfectMatch =
          selectedSet.size === correctSet.size &&
          [...selectedSet].every((id) => correctSet.has(id));
        if (perfectMatch) {
          awarded = question.points;
          note = "Correct.";
        } else {
          const selectedCorrect = [...selectedSet].filter((id) => correctSet.has(id));
          const selectedWrong = [...selectedSet].filter((id) => !correctSet.has(id));
          if (
            question.kind === "multi-answer" &&
            selectedWrong.length === 0 &&
            selectedCorrect.length > 0
          ) {
            // Partial credit for a multi-answer: half points, rounded up,
            // only when no wrong option was selected. This is documented
            // in the instructions submitted with the quiz.
            awarded = Math.ceil(question.points / 2);
            note = "Partial: some, but not all, correct options were selected.";
          } else {
            note = selectedWrong.length > 0
              ? "Incorrect: at least one selected option is not required by this workflow."
              : "Incorrect: not every correct option was selected.";
          }
        }
        break;
      }
      case "fill-in-the-blank": {
        const text = typeof raw === "string" ? raw : "";
        const trimmed = text.trim();
        if (trimmed.length === 0) {
          answered = false;
          note = "No answer was entered.";
          break;
        }
        // Case-insensitive, whitespace-normalised comparison.
        const normalised = trimmed.replace(/\s+/g, " ").toLowerCase();
        const expected = question.answerText.replace(/\s+/g, " ").toLowerCase();
        if (normalised === expected) {
          awarded = question.points;
          note = "Correct.";
        } else {
          note = "Incorrect: the value the workflow requires for this step is different.";
        }
        break;
      }
    }
    earned += awarded;
    perQuestion.push({
      questionId: question.id,
      answered,
      awarded,
      possible: question.points,
      note,
    });
  }
  return {
    version: "interactive-quiz-grade/1",
    earned,
    total,
    passed: total > 0 && earned >= quiz.passThreshold,
    perQuestion,
    gradedAt: new Date().toISOString(),
  };
}

export interface InteractiveQuizQuestionGrade {
  readonly questionId: string;
  readonly answered: boolean;
  readonly awarded: number;
  readonly possible: number;
  readonly note: string;
}

export interface InteractiveQuizGrade {
  readonly version: "interactive-quiz-grade/1";
  readonly earned: number;
  readonly total: number;
  readonly passed: boolean;
  readonly perQuestion: readonly InteractiveQuizQuestionGrade[];
  readonly gradedAt: string;
}

export function buildInteractiveQuizDirectives(): string {
  return [
    "You are writing an interactive assessment over an already approved workflow plan and its glossary.",
    "Every question must be directly answerable by a reader who has completed the workflow; never test product trivia, licensing or features the plan does not mention.",
    "Multiple-choice distractors MUST be drawn from other named controls that appear in the plan; do not invent control names.",
    "Every option carries a rationale: for the correct option, cite the plan step; for each distractor, state the rule it violates ('this control belongs to a different step' / 'this value is not filled during this workflow').",
    "Multi-answer questions must say so in the stem ('select every one that applies') and must have at least one distractor as well as at least two correct options.",
    "Fill-in-the-blank answers are exact values from the plan; a reviewer checks them letter for letter.",
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

interface ConditionalBranch {
  readonly condition: string;
  readonly thenStepId: string;
  readonly elseStepId: string;
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

function findConditionalBranch(plan: Plan): ConditionalBranch | null {
  const graph = (plan as { graph?: unknown }).graph;
  if (graph === null || typeof graph !== "object") return null;
  const edges = (graph as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) return null;
  for (const e of edges) {
    if (e === null || typeof e !== "object") continue;
    const edge = e as Record<string, unknown>;
    const condition = typeof edge["condition"] === "string" ? (edge["condition"] as string).trim() : "";
    if (condition.length === 0) continue;
    const from = typeof edge["from"] === "string" ? (edge["from"] as string) : "";
    const to = typeof edge["to"] === "string" ? (edge["to"] as string) : "";
    if (from.length === 0 || to.length === 0) continue;
    // The graph shape exposed by `conditionalGraph.ts` includes branches as
    // edges with a `condition`; the *other* outgoing edge from `from` (with
    // no condition, or with the negation) is the else branch. Find it.
    for (const other of edges) {
      if (other === null || typeof other !== "object") continue;
      const o = other as Record<string, unknown>;
      if (o === edge) continue;
      if (typeof o["from"] !== "string" || o["from"] !== from) continue;
      const otherTo = typeof o["to"] === "string" ? (o["to"] as string) : "";
      if (otherTo.length === 0 || otherTo === to) continue;
      return { condition, thenStepId: to, elseStepId: otherTo };
    }
  }
  return null;
}

function buildSingleChoice(
  correct: string,
  correctRationale: string,
  distractors: readonly string[],
  seed: number,
): readonly InteractiveQuizOption[] {
  const raw: InteractiveQuizOption[] = [
    { id: "opt-correct", text: correct, correct: true, rationale: correctRationale },
  ];
  let n = 0;
  for (const d of distractors) {
    n += 1;
    raw.push({
      id: `opt-${n}`,
      text: d,
      correct: false,
      rationale: `"${d}" is a control in this workflow, but it is not the target of this step.`,
    });
  }
  return shuffleDeterministic(raw, seed);
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

/**
 * Deterministic Fisher-Yates with an LCG seeded from the caller's step
 * index. Two runs on the same plan produce the same option ordering.
 */
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

function actionStem(step: PlanStep): string {
  switch (step.action) {
    case "click":
      return "Which control does the workflow interact with at this step?";
    case "type":
      return "Into which field does the workflow enter a value at this step?";
    case "select":
      return "Which control does the workflow use to choose an option at this step?";
    case "navigate":
      return "Which control moves the workflow to the next page?";
    case "scroll":
      return "Which control is needed to reveal the next part of the workflow?";
    default:
      return "Which control advances the workflow at this step?";
  }
}

function defaultRationale(step: PlanStep): string {
  const name = targetNameOrNull(step);
  const value = valueOrNull(step);
  switch (step.action) {
    case "click":
      return name !== null
        ? `The workflow advances when you click ${name}.`
        : "The workflow advances when you click the target control.";
    case "type":
      return name !== null && value !== null
        ? `Enter ${value} in ${name}.`
        : name !== null
          ? `Enter the required value in ${name}.`
          : "Enter the required value in the field.";
    case "select":
      return name !== null && value !== null
        ? `Choose ${value} from ${name}.`
        : name !== null
          ? `Choose the required option from ${name}.`
          : "Choose the required option.";
    case "navigate":
      return value !== null ? `Navigate to ${value}.` : "Move to the next page.";
    case "scroll":
      return "Scroll to reveal the next control.";
    default:
      return name !== null ? `Interact with ${name}.` : "Perform the indicated action.";
  }
}

function difficultyFor(step: PlanStep): 1 | 2 | 3 {
  if (step.action === "click") return targetNameOrNull(step) !== null ? 1 : 2;
  if (step.action === "type" || step.action === "select") return 2;
  if (step.action === "navigate" || step.action === "scroll") return 1;
  return 2;
}

function pruneGlossary(
  entries: readonly { readonly term: string; readonly definition: string }[],
): readonly { readonly term: string; readonly definition: string }[] {
  const seen = new Set<string>();
  const out: { term: string; definition: string }[] = [];
  for (const e of entries) {
    const term = typeof e.term === "string" ? e.term.trim() : "";
    const definition = typeof e.definition === "string" ? e.definition.trim() : "";
    if (term.length === 0 || definition.length === 0) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, definition });
  }
  return out;
}

function slugifyId(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "x"
  );
}

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clampFraction(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v <= 0) return fallback;
  if (v > 1) return 1;
  return v;
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
  findConditionalBranch,
  buildSingleChoice,
  pickDistractors,
  shuffleDeterministic,
  actionStem,
  defaultRationale,
  difficultyFor,
  pruneGlossary,
  slugifyId,
  clampInt,
  clampFraction,
});
