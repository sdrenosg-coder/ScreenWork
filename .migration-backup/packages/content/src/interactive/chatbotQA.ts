/**
 * Zipy AI — interactive content: support-chatbot Q&A pairs
 * (editing & collaboration, batch 2).
 *
 * Produces a grounded Q&A set a support chatbot can answer from, derived
 * entirely from an already-approved workflow plan, its optional glossary
 * and the per-step copy the core writing layers produced. This is the
 * conversational sibling of `quiz.ts` and `scenarios.ts`:
 *
 *   - `quiz.ts`      — graded assessment questions with distractor rationales.
 *   - `scenarios.ts` — narrative reasoning questions.
 *   - `chatbotQA.ts` — *user-phrased* question / answer pairs a retrieval
 *                      layer or chatbot can serve verbatim, plus the
 *                      follow-up questions the answer should surface.
 *
 * Every pair has:
 *   - `question`       — a natural-language question a user might ask.
 *     Phrasings are drawn from templates selected by the action kind and
 *     the plan's own element/value names. The module never invents a
 *     product feature: the *object* of the question always appears in the
 *     plan (a target name, a value, a step id, the goal, or a glossary
 *     term).
 *   - `answer`         — a short answer (2–4 sentences) whose sentences
 *     are drawn from the per-step copy when supplied, and are otherwise
 *     composed from the plan's own action/target/value fields.
 *   - `sources`        — the step ids (and glossary terms) the answer is
 *     grounded in. Empty sources are not allowed; a pair that would have
 *     no source is recorded as a gap instead of being emitted.
 *   - `followUps`      — other questions in the set the reader is likely
 *     to ask next. Follow-ups are computed by overlapping the pair's
 *     source steps and chosen deterministically.
 *   - `intents`        — coarse intent labels (`onboarding`, `how-to`,
 *     `troubleshooting`, `reference`, `policy`) the chatbot can filter on.
 *
 * Design rules honoured:
 *  - No facts invented. Every proper noun in a question or answer also
 *    appears in the plan, the supplied per-step copy, or the glossary.
 *  - Deterministic. Question selection and follow-up selection are stable
 *    across runs on the same inputs.
 *  - No LLM call. The route can pass the output through the style/tone
 *    layer separately.
 *  - Provenance. Every pair carries `sources` (step ids / glossary terms)
 *    so the review surface can trace an answer back to its origin.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ChatbotQAErrorCode = "invalid-input" | "no-goal" | "no-steps";

export class ChatbotQAError extends Error {
  readonly code: ChatbotQAErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ChatbotQAErrorCode,
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

export const CHATBOT_INTENTS = [
  "how-to",
  "onboarding",
  "troubleshooting",
  "reference",
  "policy",
] as const;
export type ChatbotIntent = (typeof CHATBOT_INTENTS)[number];

export interface ChatbotSourceRef {
  /** Step id when the source is a plan step; null for glossary sources. */
  readonly stepId: string | null;
  /** Glossary term when the source is a definition; null for step sources. */
  readonly glossaryTerm: string | null;
}

export interface ChatbotQAPair {
  /** Stable id derived from the question kind and the seed step/term. */
  readonly id: string;
  readonly intents: readonly ChatbotIntent[];
  readonly question: string;
  readonly answer: string;
  readonly sources: readonly ChatbotSourceRef[];
  /** Ids of other questions in the same set that are likely follow-ups. */
  readonly followUpIds: readonly string[];
}

export interface ChatbotQAGap {
  readonly sourceStepId: string | null;
  readonly reason:
    | "no-steps"
    | "no-target"
    | "no-value"
    | "no-glossary"
    | "no-prerequisite-step"
    | "no-alternatives";
  readonly detail: string;
}

export interface ChatbotQASet {
  readonly version: "chatbot-qa/1";
  readonly title: string;
  readonly pairs: readonly ChatbotQAPair[];
  readonly gaps: readonly ChatbotQAGap[];
  /**
   * Terms/controls the set knows about. The retrieval layer can use this
   * list to expand user queries before matching a pair.
   */
  readonly lexicon: readonly string[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface ChatbotQAInputs {
  readonly plan: Plan;
  readonly title?: string | null;
  /** Glossary term/definition pairs; feeds `reference` pairs. */
  readonly glossary?: readonly { readonly term: string; readonly definition: string }[];
  /**
   * Per-step copy from the core writing layers. When supplied, the answer
   * uses the reviewer-approved description verbatim as its first sentence.
   */
  readonly stepText?: Readonly<
    Record<string, { readonly title: string; readonly description: string }>
  >;
  /**
   * Terms the workflow's users are known to type into the help search
   * box. When supplied, `how-to` questions are also generated keyed on
   * these synonyms; the returned `lexicon` lists them so the retrieval
   * layer can map a user's term back to the canonical pair. Terms that
   * do not correspond to any plan step or glossary entry are dropped
   * (with a gap) — never invented into a question.
   */
  readonly aliases?: readonly { readonly term: string; readonly canonical: string }[];
  /** Cap on the number of pairs (default 24). */
  readonly maxPairs?: number;
  /**
   * Whether `troubleshooting` pairs should be generated for input steps.
   * Default: true.
   */
  readonly includeTroubleshooting?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeChatbotQA(inputs: ChatbotQAInputs): ChatbotQASet {
  if (inputs === null || typeof inputs !== "object") {
    throw new ChatbotQAError("composeChatbotQA requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new ChatbotQAError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new ChatbotQAError("The plan does not expose a goal.", "no-goal");
  }
  const goal = goalRaw.trim();
  const maxPairs = clampInt(inputs.maxPairs, 24, 1, 200);
  const includeTroubleshooting = inputs.includeTroubleshooting !== false;

  const steps = readSteps(plan);
  if (steps.length === 0) {
    throw new ChatbotQAError(
      "The plan contains no steps; a chatbot Q&A set cannot be generated.",
      "no-steps",
    );
  }

  const gaps: ChatbotQAGap[] = [];
  const glossary = pruneGlossary(inputs.glossary ?? []);
  const pairs: ChatbotQAPair[] = [];

  // -------- 1. `how-to` pair for each step's target ----------------------
  for (const step of steps) {
    if (pairs.length >= maxPairs) break;
    const target = targetNameOrNull(step.planStep);
    if (target === null) {
      gaps.push({
        sourceStepId: step.id,
        reason: "no-target",
        detail: `Step ${step.index} has no target element name; a how-to pair was skipped.`,
      });
      continue;
    }
    const question = howToQuestion(step.planStep, target);
    const answer = answerForStep(step, inputs.stepText, goal);
    pairs.push({
      id: `qa-${step.index}-how-to`,
      intents: ["how-to"],
      question,
      answer,
      sources: [{ stepId: step.id, glossaryTerm: null }],
      followUpIds: [],
    });
  }

  // -------- 2. `reference` pair per glossary term ------------------------
  for (const entry of glossary) {
    if (pairs.length >= maxPairs) break;
    pairs.push({
      id: `qa-term-${slugifyId(entry.term)}`,
      intents: ["reference"],
      question: `What does "${entry.term}" mean in this workflow?`,
      answer: `${entry.term}: ${entry.definition}`,
      sources: [{ stepId: null, glossaryTerm: entry.term }],
      followUpIds: [],
    });
    if (glossary.length === 0) continue;
  }
  if (glossary.length === 0) {
    gaps.push({
      sourceStepId: null,
      reason: "no-glossary",
      detail: "The inputs contain no glossary entries; reference pairs were not generated.",
    });
  }

  // -------- 3. `onboarding` pair when the plan has ≥2 steps --------------
  if (steps.length >= 2 && pairs.length < maxPairs) {
    const first = steps[0]!;
    const last = steps[steps.length - 1]!;
    const firstTarget = targetNameOrNull(first.planStep);
    const lastTarget = targetNameOrNull(last.planStep);
    pairs.push({
      id: "qa-overview",
      intents: ["onboarding"],
      question: `How do I complete the whole workflow "${goal}"?`,
      answer: buildOverviewAnswer(goal, firstTarget, lastTarget, steps.length),
      sources: [
        { stepId: first.id, glossaryTerm: null },
        { stepId: last.id, glossaryTerm: null },
      ],
      followUpIds: [],
    });
  }

  // -------- 4. `troubleshooting` pair for each input step ----------------
  if (includeTroubleshooting) {
    for (const step of steps) {
      if (pairs.length >= maxPairs) break;
      if (step.planStep.action !== "type" && step.planStep.action !== "select") continue;
      const target = targetNameOrNull(step.planStep);
      const value = valueOrNull(step.planStep);
      if (target === null || value === null) {
        gaps.push({
          sourceStepId: step.id,
          reason: value === null ? "no-value" : "no-target",
          detail: `Step ${step.index} does not name both a target and a value; a troubleshooting pair was skipped.`,
        });
        continue;
      }
      pairs.push({
        id: `qa-${step.index}-troubleshoot`,
        intents: ["troubleshooting"],
        question: `What do I do if the value I enter into ${target} is rejected?`,
        answer:
          `The plan expects the value "${value}" in ${target}. ` +
          `Re-enter it exactly; if the workflow still refuses the value, ` +
          `return to the previous confirmed step and repeat the action. The plan does not document an alternative value for this step.`,
        sources: [{ stepId: step.id, glossaryTerm: null }],
        followUpIds: [],
      });
    }
  }

  // -------- 5. `how-to` pair per alias term -------------------------------
  const aliases = pruneAliases(inputs.aliases ?? []);
  for (const alias of aliases) {
    if (pairs.length >= maxPairs) break;
    const canonical = alias.canonical.trim();
    const step = steps.find((s) => {
      const name = targetNameOrNull(s.planStep);
      return name !== null && name.toLowerCase() === canonical.toLowerCase();
    });
    if (step === undefined) {
      gaps.push({
        sourceStepId: null,
        reason: "no-target",
        detail: `Alias "${alias.term}" maps to "${canonical}", which is not a control in the plan; the alias pair was skipped.`,
      });
      continue;
    }
    const answer = answerForStep(step, inputs.stepText, goal);
    pairs.push({
      id: `qa-alias-${slugifyId(alias.term)}`,
      intents: ["how-to"],
      question: `How do I use ${alias.term} in this workflow?`,
      answer,
      sources: [{ stepId: step.id, glossaryTerm: null }],
      followUpIds: [],
    });
  }

  // -------- 6. Compute follow-ups (overlap on source step ids) ----------
  const withFollowUps = pairFollowUps(pairs);

  // -------- 7. Build the lexicon ----------------------------------------
  const lexicon = buildLexicon(steps, glossary, aliases);

  const title = nonEmpty(inputs.title) ?? `Support chatbot Q&A: ${goal.replace(/^how\s+to\s+/i, "")}`;

  return {
    version: "chatbot-qa/1",
    title,
    pairs: withFollowUps.slice(0, maxPairs),
    gaps,
    lexicon,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the Q&A set as Markdown, suitable for pasting into a help-centre
 * article or pasting into a chatbot's knowledge base upload form.
 */
export function renderChatbotQAMarkdown(set: ChatbotQASet): string {
  const parts: string[] = [];
  parts.push(`# ${set.title}`);
  parts.push("");
  parts.push(
    `_${set.pairs.length} question${set.pairs.length === 1 ? "" : "s"}. Tagged as AI-generated; review before publishing._`,
  );
  parts.push("");
  for (const pair of set.pairs) {
    const tags = pair.intents.length > 0 ? ` _(intents: ${pair.intents.join(", ")})_` : "";
    parts.push(`### Q: ${pair.question}${tags}`);
    parts.push("");
    parts.push(pair.answer);
    parts.push("");
    if (pair.followUpIds.length > 0) {
      parts.push("See also:");
      for (const id of pair.followUpIds) {
        const target = set.pairs.find((p) => p.id === id);
        if (target !== undefined) parts.push(`- ${target.question}`);
      }
      parts.push("");
    }
  }
  if (set.lexicon.length > 0) {
    parts.push("## Lexicon");
    parts.push("");
    for (const term of set.lexicon) parts.push(`- ${term}`);
    parts.push("");
  }
  if (set.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Q&A gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of set.gaps) {
      parts.push(`- ${gap.sourceStepId !== null ? `Step ${gap.sourceStepId}: ` : ""}${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildChatbotQADirectives(): string {
  return [
    "You are writing a support chatbot's question/answer knowledge base for an already approved workflow plan and glossary.",
    "Every question must be one a real user of this workflow would plausibly type; phrasings avoid product trivia and never claim features the plan does not mention.",
    "Every proper noun in a question or answer must appear in the plan (a target, a value, a step id, or the plan's goal) or in the supplied glossary.",
    "Answers are short (2–4 sentences), factual, and stated in the same voice as the guide. When a reviewer-approved step description is supplied, reuse it as the first sentence.",
    "Troubleshooting pairs only describe the recovery path the plan actually documents; do not invent error messages, retries, fallbacks or alternative values.",
    "Return `sources` for every pair — the step ids and/or glossary terms the answer is grounded in. A pair with no source is dropped, not emitted.",
    "Tag each pair with intents drawn from: `how-to`, `onboarding`, `troubleshooting`, `reference`, `policy`. Do not invent new intent labels.",
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

function howToQuestion(step: PlanStep, target: string): string {
  switch (step.action) {
    case "click":
      return `How do I click ${target}?`;
    case "type": {
      const value = valueOrNull(step);
      return value !== null
        ? `What value goes in ${target}?`
        : `How do I fill in ${target}?`;
    }
    case "select": {
      const value = valueOrNull(step);
      return value !== null
        ? `Which option do I select in ${target}?`
        : `How do I choose an option in ${target}?`;
    }
    case "navigate":
      return `Where does clicking ${target} take me?`;
    case "scroll":
      return `How do I reveal ${target}?`;
    default:
      return `How do I use ${target}?`;
  }
}

function answerForStep(
  step: IndexedStep,
  stepText: Readonly<Record<string, { readonly title: string; readonly description: string }>> | undefined,
  goal: string,
): string {
  const target = targetNameOrNull(step.planStep) ?? "the control";
  const value = valueOrNull(step.planStep);
  const review = stepText?.[step.id];
  const parts: string[] = [];
  if (review !== undefined && review.description.trim().length > 0) {
    parts.push(ensureSentence(review.description.trim()));
  } else {
    parts.push(defaultStepSentence(step.planStep, target, value));
  }
  parts.push(
    `This is step ${step.index} of the workflow "${goal}".`,
  );
  if (
    (step.planStep.action === "type" || step.planStep.action === "select") &&
    value !== null
  ) {
    parts.push(`The plan uses the value "${value}" here.`);
  }
  return parts.join(" ");
}

function defaultStepSentence(step: PlanStep, target: string, value: string | null): string {
  switch (step.action) {
    case "click":
      return `Click ${target}.`;
    case "type":
      return value !== null
        ? `Enter "${value}" in ${target}.`
        : `Enter the required value in ${target}.`;
    case "select":
      return value !== null
        ? `Select "${value}" from ${target}.`
        : `Select the required option from ${target}.`;
    case "navigate":
      return value !== null
        ? `Navigate to ${value}.`
        : "Move to the next page.";
    case "scroll":
      return `Scroll to reveal ${target}.`;
    default:
      return `Perform the action on ${target}.`;
  }
}

function buildOverviewAnswer(
  goal: string,
  firstTarget: string | null,
  lastTarget: string | null,
  stepCount: number,
): string {
  const start =
    firstTarget !== null
      ? `start by interacting with ${firstTarget}`
      : "start from the first step of the workflow";
  const end =
    lastTarget !== null
      ? `finish by interacting with ${lastTarget}`
      : "finish with the last step of the workflow";
  return `To complete "${goal}", ${start} and ${end}. The workflow has ${stepCount} step${stepCount === 1 ? "" : "s"} in total.`;
}

function ensureSentence(s: string): string {
  if (s.length === 0) return s;
  const last = s.slice(-1);
  if (last === "." || last === "!" || last === "?") return s;
  return `${s}.`;
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

function pruneAliases(
  entries: readonly { readonly term: string; readonly canonical: string }[],
): readonly { readonly term: string; readonly canonical: string }[] {
  const seen = new Set<string>();
  const out: { term: string; canonical: string }[] = [];
  for (const e of entries) {
    const term = typeof e.term === "string" ? e.term.trim() : "";
    const canonical = typeof e.canonical === "string" ? e.canonical.trim() : "";
    if (term.length === 0 || canonical.length === 0) continue;
    const key = `${term.toLowerCase()}\u0001${canonical.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, canonical });
  }
  return out;
}

function pairFollowUps(pairs: readonly ChatbotQAPair[]): readonly ChatbotQAPair[] {
  const byStep = new Map<string, string[]>();
  for (const p of pairs) {
    for (const s of p.sources) {
      if (s.stepId === null) continue;
      const list = byStep.get(s.stepId) ?? [];
      list.push(p.id);
      byStep.set(s.stepId, list);
    }
  }
  const out: ChatbotQAPair[] = [];
  for (const p of pairs) {
    const candidateIds = new Set<string>();
    for (const s of p.sources) {
      if (s.stepId === null) continue;
      for (const sibling of byStep.get(s.stepId) ?? []) {
        if (sibling !== p.id) candidateIds.add(sibling);
      }
    }
    // Cap to 3 follow-ups, stable order = insertion order of the pairs array.
    const ordered: string[] = [];
    for (const candidate of pairs) {
      if (ordered.length >= 3) break;
      if (candidateIds.has(candidate.id)) ordered.push(candidate.id);
    }
    out.push({ ...p, followUpIds: ordered });
  }
  return out;
}

function buildLexicon(
  steps: readonly IndexedStep[],
  glossary: readonly { readonly term: string; readonly definition: string }[],
  aliases: readonly { readonly term: string; readonly canonical: string }[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string): void => {
    const t = s.trim();
    if (t.length === 0) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const s of steps) {
    const name = targetNameOrNull(s.planStep);
    if (name !== null) add(name);
    const value = valueOrNull(s.planStep);
    if (value !== null) add(value);
  }
  for (const e of glossary) add(e.term);
  for (const a of aliases) add(a.term);
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
  targetNameOrNull,
  valueOrNull,
  howToQuestion,
  answerForStep,
  buildOverviewAnswer,
  ensureSentence,
  pruneGlossary,
  pruneAliases,
  pairFollowUps,
  buildLexicon,
  slugifyId,
  clampInt,
});
