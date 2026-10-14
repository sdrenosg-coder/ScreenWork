/**
 * Zipy AI — long-form: quiz and flashcards (content-generation, long-form batch 1).
 *
 * Generates a small assessment set from a workflow plan:
 *   - multiple-choice questions (single correct answer, exactly 4 options),
 *   - true/false questions,
 *   - fill-in-the-blank questions,
 *   - flashcards (term/definition pairs from glossary + key terms),
 *   - scenario questions (multi-sentence stems that require reasoning).
 *
 * The composer is deterministic: every question is *derived* from the plan
 * (step action, target element name, and any supplied per-step copy or
 * glossary entries) using documented templates. When a stem cannot be
 * generated for a step — for example, a step has no target and no value — a
 * `QuizGap` is recorded instead of a filler question.
 *
 * Design boundaries:
 *  - No distractors are invented that reference a fact the plan does not
 *    concern. Distractors for a "which element do you click?" question are
 *    taken from other *plan* elements, so they are wrong by construction
 *    (they name a real element that is not the correct one for this step).
 *  - Question difficulty is inferred from the plan's action vocabulary:
 *    a `click` on a named element gives an easy question; a conditional
 *    branch gives a harder scenario question. The composer never inflates
 *    difficulty with unrelated topics.
 *  - The score key is returned alongside each question so an export layer
 *    can render a self-check sheet without needing the composer.
 *
 * Output shape (`Quiz` and `FlashcardDeck`) are versioned for the export
 * layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type QuizErrorCode = "invalid-input" | "no-goal";

export class QuizError extends Error {
  readonly code: QuizErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: QuizErrorCode,
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

export const QUESTION_KINDS = [
  "multiple-choice",
  "true-false",
  "fill-in-the-blank",
  "scenario",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface QuizOption {
  readonly text: string;
  readonly correct: boolean;
}

export interface QuizQuestion {
  readonly id: string;
  readonly kind: QuestionKind;
  /** The question stem. Never empty. */
  readonly stem: string;
  /** Present for multiple-choice questions; empty for other kinds. */
  readonly options: readonly QuizOption[];
  /** The correct answer as a plain string (used for all kinds). */
  readonly answer: string;
  /** A short explanation of why the answer is correct. */
  readonly explanation: string;
  /** Provenance: the plan step id this question derives from. */
  readonly sourceStepId: string | null;
  /** 1 = easy, 2 = medium, 3 = hard. Advisory only. */
  readonly difficulty: 1 | 2 | 3;
}

export interface Flashcard {
  readonly id: string;
  readonly front: string;
  readonly back: string;
  /** Provenance: the plan step id when the card derives from a step; null for glossary cards. */
  readonly sourceStepId: string | null;
}

export interface QuizGap {
  readonly sourceStepId: string | null;
  readonly reason:
    | "no-plan-steps"
    | "step-has-no-target"
    | "step-has-no-value"
    | "no-distractors"
    | "no-glossary";
  readonly detail: string;
}

export interface Quiz {
  readonly version: "quiz/1";
  readonly title: string;
  readonly questions: readonly QuizQuestion[];
  readonly gaps: readonly QuizGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface FlashcardDeck {
  readonly version: "flashcards/1";
  readonly title: string;
  readonly cards: readonly Flashcard[];
  readonly gaps: readonly QuizGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface QuizFlashcardsInputs {
  readonly plan: Plan;
  /** Optional quiz title; falls back to a deterministic one from the goal. */
  readonly title?: string | null;
  /**
   * Optional glossary entries (term/definition). Used to populate
   * flashcards and to construct fill-in-the-blank distractors for multiple
   * choice questions.
   */
  readonly glossary?: readonly { readonly term: string; readonly definition: string }[];
  /**
   * Optional per-step copy from the core-writing layers. When supplied, the
   * step description becomes the quiz's "explanation" field.
   */
  readonly stepText?: Readonly<Record<string, { readonly title: string; readonly description: string }>>;
  /** Maximum number of quiz questions to produce (default 8). */
  readonly maxQuestions?: number;
  /** Maximum number of flashcards to produce (default 12). */
  readonly maxFlashcards?: number;
  /** Whether to include scenario questions. Default: true. */
  readonly includeScenarios?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeQuiz(inputs: QuizFlashcardsInputs): Quiz {
  if (inputs === null || typeof inputs !== "object") {
    throw new QuizError("composeQuiz requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new QuizError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new QuizError("The plan does not expose a goal.", "no-goal");
  }
  const goal = goalRaw.trim();

  const maxQuestions = clampInt(inputs.maxQuestions, 8, 1, 40);
  const includeScenarios = inputs.includeScenarios !== false;

  const gaps: QuizGap[] = [];
  const steps = readSteps(plan);
  if (steps.length === 0) {
    gaps.push({
      sourceStepId: null,
      reason: "no-plan-steps",
      detail: "The plan contains no steps; no questions could be derived.",
    });
  }
  const targets = collectTargetNames(steps);
  const glossary = pruneGlossary(inputs.glossary ?? []);

  const questions: QuizQuestion[] = [];
  for (const step of steps) {
    if (questions.length >= maxQuestions) break;
    const review = inputs.stepText?.[step.id];
    const explanation = nonEmpty(review?.description) ?? defaultExplanation(step.planStep);

    // Question 1: which control do you interact with next?
    if (step.planStep.target !== null && step.planStep.target.name.trim().length > 0) {
      const correct = step.planStep.target.name.trim();
      const distractors = pickDistractors(correct, targets, 3);
      if (distractors.length === 3) {
        questions.push({
          id: `q-${step.index}-action`,
          kind: "multiple-choice",
          stem: actionStem(step.planStep),
          options: shuffleDeterministic(
            [
              { text: correct, correct: true },
              ...distractors.map((d) => ({ text: d, correct: false })),
            ],
            step.index,
          ),
          answer: correct,
          explanation,
          sourceStepId: step.id,
          difficulty: difficultyFor(step.planStep),
        });
        if (questions.length >= maxQuestions) break;
      } else {
        gaps.push({
          sourceStepId: step.id,
          reason: "no-distractors",
          detail: `Step ${step.index} does not have enough other named targets in the plan to build a multiple-choice question.`,
        });
      }
    } else {
      gaps.push({
        sourceStepId: step.id,
        reason: "step-has-no-target",
        detail: `Step ${step.index} has no target element name; an action question cannot be generated.`,
      });
    }

    // Question 2: fill-in-the-blank for steps with a value.
    const value = typeof step.planStep.value === "string" && step.planStep.value.trim().length > 0
      ? step.planStep.value.trim()
      : null;
    if (value !== null && questions.length < maxQuestions) {
      questions.push({
        id: `q-${step.index}-value`,
        kind: "fill-in-the-blank",
        stem: fillInBlankStem(step.planStep),
        options: [],
        answer: value,
        explanation: `The workflow requires the value "${value}" for this step.`,
        sourceStepId: step.id,
        difficulty: 2,
      });
    } else if (value === null) {
      gaps.push({
        sourceStepId: step.id,
        reason: "step-has-no-value",
        detail: `Step ${step.index} has no sample value; a fill-in-the-blank question was skipped.`,
      });
    }
  }

  // Glossary-derived true/false questions — each asserts a real definition.
  for (const entry of glossary) {
    if (questions.length >= maxQuestions) break;
    questions.push({
      id: `q-term-${slugifyId(entry.term)}`,
      kind: "true-false",
      stem: `True or false: in this workflow, "${entry.term}" means: ${entry.definition}.`,
      options: [
        { text: "True", correct: true },
        { text: "False", correct: false },
      ],
      answer: "True",
      explanation: `The glossary defines "${entry.term}" as: ${entry.definition}.`,
      sourceStepId: null,
      difficulty: 1,
    });
  }

  // Scenario question — a narrative stem over 2–3 step descriptions.
  if (includeScenarios && questions.length < maxQuestions && steps.length >= 2) {
    const head = steps[0]!;
    const tail = steps[steps.length - 1]!;
    if (
      head.planStep.target !== null && head.planStep.target.name.trim().length > 0 &&
      tail.planStep.target !== null && tail.planStep.target.name.trim().length > 0
    ) {
      questions.push({
        id: `q-scenario`,
        kind: "scenario",
        stem: `You open the workflow at the start of this guide. After performing the first action (${actionVerb(head.planStep.action).toLowerCase()} ${head.planStep.target.name.trim()}), what is the final control you interact with before the workflow is complete?`,
        options: [],
        answer: tail.planStep.target.name.trim(),
        explanation: `The final step of the workflow interacts with ${tail.planStep.target.name.trim()}.`,
        sourceStepId: tail.id,
        difficulty: 3,
      });
    }
  }

  if (questions.length === 0) {
    gaps.push({
      sourceStepId: null,
      reason: "no-distractors",
      detail: "No questions could be generated from the supplied plan and glossary.",
    });
  }

  const title = nonEmpty(inputs.title) ?? `Quiz: ${goal.replace(/^how\s+to\s+/i, "")}`;

  return {
    version: "quiz/1",
    title,
    questions: questions.slice(0, maxQuestions),
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

export function composeFlashcards(inputs: QuizFlashcardsInputs): FlashcardDeck {
  if (inputs === null || typeof inputs !== "object") {
    throw new QuizError("composeFlashcards requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new QuizError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new QuizError("The plan does not expose a goal.", "no-goal");
  }
  const goal = goalRaw.trim();

  const maxFlashcards = clampInt(inputs.maxFlashcards, 12, 1, 60);
  const gaps: QuizGap[] = [];
  const cards: Flashcard[] = [];

  const glossary = pruneGlossary(inputs.glossary ?? []);
  if (glossary.length === 0) {
    gaps.push({
      sourceStepId: null,
      reason: "no-glossary",
      detail: "No glossary entries were supplied; term flashcards were not generated.",
    });
  }
  for (const entry of glossary) {
    if (cards.length >= maxFlashcards) break;
    cards.push({
      id: `fc-term-${slugifyId(entry.term)}`,
      front: `What does "${entry.term}" mean in this workflow?`,
      back: entry.definition,
      sourceStepId: null,
    });
  }

  const steps = readSteps(plan);
  if (steps.length === 0) {
    gaps.push({
      sourceStepId: null,
      reason: "no-plan-steps",
      detail: "The plan contains no steps; step flashcards were not generated.",
    });
  }
  for (const step of steps) {
    if (cards.length >= maxFlashcards) break;
    const name = step.planStep.target !== null && step.planStep.target.name.trim().length > 0
      ? step.planStep.target.name.trim()
      : null;
    const value = typeof step.planStep.value === "string" && step.planStep.value.trim().length > 0
      ? step.planStep.value.trim()
      : null;
    if (name === null) {
      gaps.push({
        sourceStepId: step.id,
        reason: "step-has-no-target",
        detail: `Step ${step.index} has no target element name; a step flashcard was skipped.`,
      });
      continue;
    }
    const review = inputs.stepText?.[step.id];
    const back = nonEmpty(review?.description) ?? defaultExplanation(step.planStep);
    cards.push({
      id: `fc-step-${step.index}`,
      front:
        value !== null
          ? `Which step value is required when you ${actionVerb(step.planStep.action).toLowerCase()} ${name}?`
          : `What do you do with ${name}?`,
      back: value !== null ? value : back,
      sourceStepId: step.id,
    });
  }

  const title = nonEmpty(inputs.title) ?? `Flashcards: ${goal.replace(/^how\s+to\s+/i, "")}`;

  return {
    version: "flashcards/1",
    title,
    cards: cards.slice(0, maxFlashcards),
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the quiz as plain Markdown with an answer key at the end. A
 * reviewer can scan the questions and confirm the answers are supported by
 * the plan without re-running the composer.
 */
export function renderQuizMarkdown(quiz: Quiz): string {
  const parts: string[] = [];
  parts.push(`# ${quiz.title}`);
  parts.push("");
  parts.push(`_${quiz.questions.length} question${quiz.questions.length === 1 ? "" : "s"}._`);
  parts.push("");
  const key: string[] = [];
  for (let i = 0; i < quiz.questions.length; i += 1) {
    const q = quiz.questions[i]!;
    parts.push(`### ${i + 1}. ${q.stem}`);
    parts.push("");
    for (const opt of q.options) {
      parts.push(`- ${opt.text}`);
    }
    if (q.options.length > 0) parts.push("");
    parts.push(`_Difficulty: ${"★".repeat(q.difficulty)}._`);
    parts.push("");
    key.push(`${i + 1}. ${q.answer} — ${q.explanation}`);
  }
  parts.push("## Answer key");
  parts.push("");
  for (const line of key) parts.push(`- ${line}`);
  parts.push("");
  if (quiz.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Quiz gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of quiz.gaps) {
      parts.push(`- ${gap.sourceStepId !== null ? `Step ${gap.sourceStepId}: ` : ""}${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Render the flashcard deck as plain Markdown with each card in a
 * collapsed question/answer block. The export layer can also render the
 * deck as an Anki-importable TSV.
 */
export function renderFlashcardsMarkdown(deck: FlashcardDeck): string {
  const parts: string[] = [];
  parts.push(`# ${deck.title}`);
  parts.push("");
  parts.push(`_${deck.cards.length} card${deck.cards.length === 1 ? "" : "s"}._`);
  parts.push("");
  for (const card of deck.cards) {
    parts.push(`### ${card.front}`);
    parts.push("");
    parts.push(card.back);
    parts.push("");
  }
  if (deck.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Deck gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of deck.gaps) {
      parts.push(`- ${gap.sourceStepId !== null ? `Step ${gap.sourceStepId}: ` : ""}${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildQuizDirectives(): string {
  return [
    "You are writing a short assessment over an already approved workflow plan.",
    "Every question must be *directly* answerable by a reader who has completed the workflow; do not test product trivia, licensing, or features the plan does not mention.",
    "Question kinds: multiple-choice (exactly one correct option, three distractors drawn from the plan's other elements), true/false, fill-in-the-blank, and scenario.",
    "Distractors must be plausible-looking UI element names that appear *elsewhere* in the plan and that are *wrong* for this step; do not invent element names.",
    "Provide a one-sentence explanation for every answer that references the plan step it was derived from.",
    "Do not use the word 'simply'. Do not add marketing language.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

export function buildFlashcardsDirectives(): string {
  return [
    "You are writing a flashcard deck over an already approved workflow plan and a glossary.",
    "Each card has a *question* on the front and a short *answer* on the back. The answer is a definition, a value, or a one-sentence procedure.",
    "Term cards come from the glossary only; do not invent terms. Step cards describe the exact UI element and value the plan specifies.",
    "Do not include trivia. Do not include multi-sentence answers.",
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

function collectTargetNames(steps: readonly IndexedStep[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of steps) {
    const name = s.planStep.target !== null && s.planStep.target.name.trim().length > 0
      ? s.planStep.target.name.trim()
      : null;
    if (name === null) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Pick `count` distractors from the plan's element names, excluding the
 * correct answer. The returned list is always shorter than or equal to
 * `count`; callers check for an exact count before using the distractors.
 */
function pickDistractors(
  correct: string,
  pool: readonly string[],
  count: number,
): string[] {
  const correctKey = correct.toLowerCase();
  const candidates = pool.filter((p) => p.toLowerCase() !== correctKey);
  if (candidates.length < count) return candidates;
  // Deterministic slice; the composer never uses randomness so two runs on
  // the same plan produce the same question set.
  return candidates.slice(0, count);
}

/**
 * Deterministic shuffle: swaps positions using a per-step seed derived from
 * the step index. Ensures the correct option is not always first while
 * keeping the composer pure (two runs produce the same order).
 */
function shuffleDeterministic<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  // Fisher-Yates with a small LCG derived from the seed.
  let state = (seed * 2654435761) >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function actionStem(step: PlanStep): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  const verb = actionVerb(step.action);
  switch (step.action) {
    case "click":
      return name !== null
        ? `To progress through this workflow, which control do you ${verb.toLowerCase()}?`
        : "Which control do you click to progress through this workflow?";
    case "type":
      return name !== null
        ? `In which field do you enter the required value?`
        : "In which field do you enter the required value?";
    case "select":
      return name !== null
        ? `Which input do you use to choose the required option?`
        : "Which input do you use to choose the required option?";
    case "navigate":
      return "Which action moves the workflow to the next page?";
    case "scroll":
      return "Which control moves the workflow past the current section?";
    default:
      return "Which control advances the workflow at this point?";
  }
}

function fillInBlankStem(step: PlanStep): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  if (name !== null) {
    return `Fill in the blank: in ${name}, enter ______.`;
  }
  return `Fill in the blank: the workflow requires the value ______ at this step.`;
}

function defaultExplanation(step: PlanStep): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  const value = typeof step.value === "string" && step.value.trim().length > 0 ? step.value.trim() : null;
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
          : "Choose the required option from the list.";
    case "navigate":
      return value !== null ? `Navigate to ${value}.` : "Move to the next page.";
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

function difficultyFor(step: PlanStep): 1 | 2 | 3 {
  if (step.action === "click") return step.target !== null && step.target.name.trim().length > 0 ? 1 : 2;
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
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "x";
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
  collectTargetNames,
  pickDistractors,
  shuffleDeterministic,
  actionStem,
  fillInBlankStem,
  defaultExplanation,
  actionVerb,
  difficultyFor,
  slugifyId,
  clampInt,
});
