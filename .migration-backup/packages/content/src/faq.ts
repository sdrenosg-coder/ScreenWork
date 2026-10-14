/**
 * Zipy AI — FAQ and troubleshooting FAQ generation (content-generation core, batch 1).
 *
 * The fifth layer of the core writing engine. Where `tipsWarnings.ts`
 * produces per-step callouts, this module produces the standalone FAQ
 * section that appears at the end of the guide: a list of question/answer
 * pairs that a reader might have after skimming the steps.
 *
 * The FAQ is not the same artefact as the troubleshooting callouts:
 *
 *   - Troubleshooting callouts are attached to a step and describe a
 *     symptom the reader will see on that screen.
 *   - FAQ entries stand alone, address questions the reader may not have
 *     while following the steps ("Can I do this without an admin account?"),
 *     and are the section most often surfaced by search and support.
 *
 * How the FAQ is populated, in order:
 *
 *   1. The deterministic composer derives entries from the plan and the
 *      sources using a small documented rule set: the goal (how-to framing),
 *      the step count (length expectation), the presence of an admin host
 *      (permission question), a source excerpt that mentions policy
 *      (compliance question), a destructive step (undo question), a financial
 *      step (cost question), an outbound step (recipient question), and a
 *      multilingual-target workspace (translation question, supplied by the
 *      caller via `targetLanguages`).
 *   2. When the LLM is available, it receives the plan, the sources, the
 *      question ideas from the composer, and the audience, and returns
 *      additional question/answer pairs. LLM pairs are appended after the
 *      composer's pairs, subject to a cap (`maxEntries`, default 10). LLM
 *      pairs are not allowed to remove composer pairs; when the composer
 *      pair is broader, its answer anchors the LLM's.
 *
 * Every FAQ entry carries its origin (composed, llm, fallback), a rule
 * identifier, and source labels the answer cites, so the provenance panel
 * can trace it.
 *
 * Design rules honoured:
 *  - Same `LlmHandle` shape as the other content layers; one adapter
 *    instance threads through the pipeline.
 *  - No invented policies, costs, or compliance requirements. FAQ answers
 *    state the general case ("Contact your administrator") when the source
 *    does not supply a specific answer; they do not invent one.
 *  - The module is a pure function of its arguments plus, in the LLM path,
 *    one adapter call. It performs no I/O.
 */

import type { PlanStep } from "@zipy/synth/stepSequence";
import type { LlmProvider } from "@zipy/llm/adapter";
import type { TitleSummarySource } from "@zipy/content/titleSummary";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type FaqErrorCode = "invalid-input" | "empty-plan";

export class FaqError extends Error {
  readonly code: FaqErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: FaqErrorCode,
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

export interface FaqLlmHandle {
  readonly complete: (args: {
    readonly task: "content.faq";
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

export type FaqOrigin = "composed" | "llm" | "fallback";

/**
 * Rule identifiers the composer uses. Kept as a union so a reviewer can grep
 * for a specific rule and see it fire; also the value persisted alongside
 * each entry for telemetry.
 */
export const FAQ_RULES = [
  "goal.howTo",
  "length.expectation",
  "permission.admin",
  "compliance.policy",
  "undo.destructive",
  "cost.financial",
  "recipient.outbound",
  "translation.languages",
  "prereq.missing",
  "offline.iterations",
] as const;
export type FaqRule = (typeof FAQ_RULES)[number];

export interface FaqEntry {
  /** The reader's question. Ends with a question mark. */
  readonly question: string;
  /** One to three sentences. */
  readonly answer: string;
  readonly origin: FaqOrigin;
  readonly rule: FaqRule | "llm";
  /** Source labels the answer cites; empty when the answer is generic. */
  readonly sourceRefs: readonly string[];
  /** Free-form note explaining why the entry fired. */
  readonly note: string;
}

export interface FaqStyle {
  readonly tone?: "formal" | "casual" | "technical";
  readonly audience?: "end-user" | "admin" | "developer";
  readonly brandTerms?: readonly string[];
}

export interface GenerateFaqOptions {
  readonly llm?: FaqLlmHandle | null;
  readonly deterministic?: boolean;
  readonly provider?: LlmProvider;
  readonly model?: string | null;
  readonly style?: FaqStyle;
  /** Guide goal; threaded through from the earlier layers. */
  readonly guideGoal?: string | null;
  /** Page title where the workflow starts. */
  readonly startPageTitle?: string | null;
  /** Sources; only `label` and `kind` are read, matching `TitleSummarySource`. */
  readonly sources?: readonly TitleSummarySource[];
  /** Source excerpts the caller extracted during fusion. */
  readonly sourceExcerpts?: readonly string[];
  /**
   * Languages the guide will be published in, as IETF tags ("en", "de-DE").
   * When non-empty and does not contain "en", a translation FAQ entry is
   * emitted. Supplied by the caller so this layer does not itself depend on
   * the i18n package.
   */
  readonly targetLanguages?: readonly string[];
  /**
   * Whether the guide is intended for repeated runs. When true, an
   * "iterations" entry is emitted (how to re-run, what persists). Default
   * true; most screenshot tutorials are run more than once.
   */
  readonly iterative?: boolean;
  /**
   * Maximum number of FAQ entries. Default 10 — long enough to cover the
   * usual questions, short enough to read.
   */
  readonly maxEntries?: number;
}

export interface GenerateFaqResult {
  readonly entries: readonly FaqEntry[];
  readonly origin: FaqOrigin;
  readonly llmFailureReason: string | null;
  readonly notes: readonly string[];
  readonly model: string | null;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const MAX_FAQ_QUESTION_LENGTH = 160;
export const MAX_FAQ_ANSWER_LENGTH = 480;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Produce FAQ entries for a plan.
 *
 * Throws `FaqError` for a malformed or empty plan. Never throws for a bad LLM
 * response; the deterministic entries are always returned, and a reason is
 * recorded.
 */
export async function generateFaq(
  plan: readonly PlanStep[],
  options: GenerateFaqOptions = {},
): Promise<GenerateFaqResult> {
  validatePlan(plan);
  const notes: string[] = [];

  const composed = composeFaq(plan, options, notes);
  const maxEntries = clampInt(options.maxEntries ?? 10, 1, 50);
  const trimmedComposed = composed.slice(0, maxEntries);

  if (options.deterministic === true) {
    return {
      entries: trimmedComposed,
      origin: "composed",
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
      entries: trimmedComposed,
      origin: "composed",
      llmFailureReason: null,
      notes: [
        ...notes,
        llm === null
          ? "No LLM handle supplied; deterministic composer used for FAQ."
          : "LLM handle reported no provider configured; deterministic composer used for FAQ.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  let raw: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await llm.complete({
      task: "content.faq",
      system: buildSystemPrompt(options.style),
      user: buildUserPrompt(plan, options, trimmedComposed),
      maxOutputChars: Math.min(4000, 800 + maxEntries * 300),
      temperature: 0.3,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    raw = response.text;
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  const parsed = raw === null ? null : parseLlmFaq(raw);
  if (parsed === null || parsed.length === 0) {
    const reason =
      failureReason ??
      "LLM returned no usable FAQ entries; composer output retained.";
    return {
      entries: trimmedComposed.map((e) => ({ ...e, origin: "fallback" as const })),
      origin: "fallback",
      llmFailureReason: reason,
      notes: [
        ...notes,
        "LLM FAQ response could not be parsed; deterministic entries kept with origin=fallback.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Merge: composer entries first (they cover the essentials), then LLM
  // entries that are not duplicates, capped to maxEntries.
  const merged = mergeFaq(trimmedComposed, parsed).slice(0, maxEntries);

  return {
    entries: merged,
    origin: "llm",
    llmFailureReason: null,
    notes,
    model: null,
    generatedAt: new Date().toISOString(),
  };
}

export function rehydrateFaq(value: unknown): GenerateFaqResult {
  if (value === null || typeof value !== "object") {
    throw new FaqError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const raw = Array.isArray(r["entries"]) ? (r["entries"] as unknown[]) : [];
  const entries: FaqEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const question = readString(o["question"]);
    const answer = readString(o["answer"]);
    if (question === null || answer === null) continue;
    if (question.length === 0 || answer.length === 0) continue;
    entries.push({
      question,
      answer,
      origin: readOrigin(o["origin"]),
      rule: readRule(o["rule"]),
      sourceRefs: Array.isArray(o["sourceRefs"])
        ? (o["sourceRefs"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      note: readString(o["note"]) ?? "",
    });
  }
  return {
    entries,
    origin: readOrigin(r["origin"]),
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

function composeFaq(
  plan: readonly PlanStep[],
  options: GenerateFaqOptions,
  notes: string[],
): readonly FaqEntry[] {
  const entries: FaqEntry[] = [];
  const goal = readString(options.guideGoal ?? null);
  const sources = options.sources ?? [];
  const excerpts = options.sourceExcerpts ?? [];

  // 1. How-to question, grounded in the guide's goal or its action verb.
  if (goal !== null && goal.length > 0) {
    entries.push(
      makeEntry({
        question: `How do I ${lowerFirst(goal.replace(/[.!?]+$/, ""))}?`,
        answer: `Follow the steps in this guide in order. The workflow is grounded in ${describeSources(sources)}; each step shows the screen you should see at that point. If a screen does not match, use the troubleshooting entries on the step to adjust.`,
        rule: "goal.howTo",
        note: "Goal was supplied; a how-to entry anchors the FAQ.",
      }),
    );
  } else {
    const first = plan[0];
    const firstAction = first !== undefined ? actionVerbFor(first) : "complete this workflow";
    entries.push(
      makeEntry({
        question: `How do I ${firstAction}?`,
        answer: `Follow the steps in the guide from the beginning. The workflow was captured from ${describeSources(sources)}; each step shows the screen you should see at that moment.`,
        rule: "goal.howTo",
        note: "No explicit goal; the FAQ anchored on the first step's action.",
      }),
    );
  }

  // 2. Length expectation.
  entries.push(
    makeEntry({
      question: `How long does this take?`,
      answer:
        plan.length <= 3
          ? `The workflow has ${plan.length} step${plan.length === 1 ? "" : "s"} and takes a few minutes to complete the first time. Repeat runs are faster.`
          : `The workflow has ${plan.length} steps. The first run usually takes around ten minutes; repeat runs take less because you are already signed in and know the layout.`,
      rule: "length.expectation",
      note: "Step count is emitted unconditionally; it is the FAQ entry readers look for most.",
    }),
  );

  // 3. Permission question triggered by an admin host.
  const adminHost = findAdminHost(plan, sources);
  if (adminHost !== null) {
    entries.push(
      makeEntry({
        question: `Can I complete this without an administrator account?`,
        answer: `This workflow touches ${adminHost}, which normally requires administrative rights. If the action you need is greyed out or the page is not visible, ask your administrator to grant the relevant permission, or have them run the workflow with you.`,
        rule: "permission.admin",
        note: "An admin host was detected in the plan or sources.",
        sourceRefs: sources.map((s) => s.label),
      }),
    );
  }

  // 4. Compliance / policy question triggered by a policy-shaped source.
  const policySource = sources.find((s) =>
    /\b(policy|compliance|gdpr|hipaa|sox|pci|retention|procedure)\b/i.test(s.label),
  );
  if (policySource !== undefined) {
    entries.push(
      makeEntry({
        question: `What policy governs this workflow?`,
        answer: `The workflow was captured with reference to "${policySource.label}". Follow your organisation's version of that document when the two disagree; the guide describes the screen, the policy describes the rules.`,
        rule: "compliance.policy",
        note: "A source label mentioned a policy or compliance framework.",
        sourceRefs: [policySource.label],
      }),
    );
  }

  // 5. Undo question triggered by a destructive step.
  const destructiveStep = plan.find((s) => s.kind === "destructive");
  if (destructiveStep !== undefined) {
    entries.push(
      makeEntry({
        question: `Can I undo this if I make a mistake?`,
        answer: `Step ${destructiveStep.ordinal} (${describeTarget(destructiveStep)}) removes data. Recovery depends on your application: some systems keep a short trash window, others do not. If you are unsure, stop before the destructive step and check with your administrator.`,
        rule: "undo.destructive",
        note: "A destructive step exists in the plan; the FAQ surfaces the recovery question.",
      }),
    );
  }

  // 6. Cost question triggered by a financial step.
  const financialStep = plan.find((s) => s.kind === "financial");
  if (financialStep !== undefined) {
    entries.push(
      makeEntry({
        question: `Will I be charged for completing this workflow?`,
        answer: `Step ${financialStep.ordinal} (${describeTarget(financialStep)}) is a payment-related action. The exact charge depends on your account and plan; check the amount on the screen before confirming. If the amount is not what you expected, cancel and contact support before completing the step.`,
        rule: "cost.financial",
        note: "A financial step exists in the plan.",
      }),
    );
  }

  // 7. Recipient question triggered by an outbound step.
  const outboundStep = plan.find((s) => s.kind === "outbound");
  if (outboundStep !== undefined) {
    entries.push(
      makeEntry({
        question: `Who receives the message at step ${outboundStep.ordinal}?`,
        answer: `Step ${outboundStep.ordinal} (${describeTarget(outboundStep)}) sends a message to the recipients configured in the form. Read the recipient field carefully; messages sent from the application cannot be recalled.`,
        rule: "recipient.outbound",
        note: "An outbound step exists in the plan.",
      }),
    );
  }

  // 8. Translation question triggered by non-English target languages.
  const langs = (options.targetLanguages ?? []).filter((l) => l.length > 0);
  const hasNonEnglish = langs.some((l) => !/^en(-|$)/i.test(l));
  if (hasNonEnglish) {
    entries.push(
      makeEntry({
        question: `Is this guide available in other languages?`,
        answer: `The written guide will be published in ${langs.join(", ")}. The screenshots remain in the language of the captured application unless the workflow is run again in a different locale.`,
        rule: "translation.languages",
        note: "Translation targets include at least one non-English language.",
      }),
    );
  }

  // 9. Prerequisites question when the plan contains a password field or an
  //    admin-only step but no explicit prerequisites were passed. This
  //    complements `introPrereqs.ts`: the FAQ restates the answer in
  //    question form for readers who skip the intro.
  const needsAuth =
    plan.some(
      (s) => s.target !== null && /password/i.test(s.target.name),
    ) || adminHost !== null;
  if (needsAuth) {
    entries.push(
      makeEntry({
        question: `Do I need to sign in before starting?`,
        answer: `Yes. The workflow targets an authenticated surface. Sign in with an account that has the rights the steps require; if a step is greyed out, the account you used does not have that permission.`,
        rule: "prereq.missing",
        note: "The plan targets an authenticated surface.",
      }),
    );
  }

  // 10. Iterations question, when the guide is marked as iterative.
  if (options.iterative !== false) {
    entries.push(
      makeEntry({
        question: `Can I run this workflow more than once?`,
        answer: `Yes. Most fields in the workflow accept multiple records; the ones that must be unique (such as an email address) are noted in the step where they are entered. Repeat runs are faster because you already know the layout.`,
        rule: "offline.iterations",
        note: "Iterative workflow; the FAQ restates the multi-run expectation.",
      }),
    );
  }

  if (entries.length === 0) {
    notes.push(
      "No deterministic FAQ entries fired; the plan is short and the sources are sparse.",
    );
  }
  if (excerpts.length === 0 && sources.length === 0) {
    notes.push(
      "No sources or excerpts were supplied; FAQ answers are generic and should be reviewed before publishing.",
    );
  }

  return entries;
}

interface FaqSeed {
  readonly question: string;
  readonly answer: string;
  readonly rule: FaqRule;
  readonly note: string;
  readonly sourceRefs?: readonly string[];
}

function makeEntry(seed: FaqSeed): FaqEntry {
  return {
    question: trimAtWord(collapseWhitespace(seed.question), MAX_FAQ_QUESTION_LENGTH),
    answer: trimAtWord(collapseWhitespace(seed.answer), MAX_FAQ_ANSWER_LENGTH),
    origin: "composed",
    rule: seed.rule,
    sourceRefs: seed.sourceRefs ?? [],
    note: seed.note,
  };
}

function findAdminHost(
  plan: readonly PlanStep[],
  sources: readonly TitleSummarySource[],
): string | null {
  for (const step of plan) {
    if (step.action !== "navigate" || step.navigateUrl === null) continue;
    try {
      const host = new URL(step.navigateUrl).host;
      if (/(^|\.)admin\.|(^|\.)manage\./i.test(host)) return host;
    } catch {
      // not a URL; skip
    }
  }
  for (const s of sources) {
    if (s.kind !== "url") continue;
    if (/(^|\.)admin\.|(^|\.)manage\./i.test(s.label)) return s.label;
  }
  return null;
}

function describeSources(sources: readonly TitleSummarySource[]): string {
  if (sources.length === 0) return "the supplied workflow";
  const first = sources[0];
  if (first === undefined) return "the supplied workflow";
  const kindPhrase = (() => {
    switch (first.kind) {
      case "url": return "the live application";
      case "text": return "the written brief";
      case "image": return "the captured screenshots";
      case "file": return "the supplied document";
      case "audio": return "the narrated recording";
      case "video": return "the recorded walkthrough";
    }
  })();
  if (sources.length === 1) return kindPhrase;
  return `${kindPhrase} and ${sources.length - 1} additional source${sources.length - 1 === 1 ? "" : "s"}`;
}

function describeTarget(step: PlanStep): string {
  if (step.target !== null && step.target.name.length > 0) return `"${step.target.name}"`;
  if (step.target !== null) return `the ${step.target.role}`;
  return "the target element";
}

function actionVerbFor(step: PlanStep): string {
  switch (step.action) {
    case "click":
      return "complete this workflow";
    case "type":
      return "enter the required values";
    case "select":
      return "choose the required options";
    case "scroll":
      return "review the page";
    case "navigate":
      return "open the workflow's starting page";
  }
}

/* -------------------------------------------------------------------------- */
/* LLM prompt construction                                                     */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(style: FaqStyle | undefined): string {
  const tone = style?.tone ?? "neutral";
  const audience = style?.audience ?? "end-user";
  const brand = style?.brandTerms ?? [];
  const brandLine =
    brand.length > 0
      ? `Preserve these brand terms verbatim: ${brand.join(", ")}.`
      : "Do not invent product, page or brand names.";

  return [
    "You write the FAQ section of a step-by-step screenshot tutorial.",
    "",
    "Format rules:",
    "- Produce one FAQ entry per block. Each entry is exactly two lines:",
    "    Q: <the reader's question, ends with a question mark, <= 160 characters>",
    "    A: <one to three sentences, <= 480 characters>",
    "- Separate entries with a blank line.",
    "- Do not repeat any question the deterministic pass already produced.",
    "",
    "Content rules:",
    "- The FAQ covers questions the reader might have after skimming the steps: permissions, consequences, prerequisites, repeat runs, policy.",
    "- Do not invent policies, costs, compliance requirements or error messages.",
    "- When a specific answer is not in the inputs, say so plainly ('Check with your administrator.').",
    "- Do not restate a step as a question and answer.",
    `Assume the reader is ${audience}. Use a ${tone} tone.`,
    brandLine,
  ].join("\n");
}

function buildUserPrompt(
  plan: readonly PlanStep[],
  options: GenerateFaqOptions,
  existing: readonly FaqEntry[],
): string {
  const lines: string[] = [];
  const goal = readString(options.guideGoal ?? null);
  lines.push(`Guide goal: ${goal ?? "(none supplied)"}`);
  if (options.startPageTitle !== null && options.startPageTitle !== undefined) {
    lines.push(`Start page title: ${options.startPageTitle}`);
  }
  const sources = options.sources ?? [];
  if (sources.length > 0) {
    lines.push("Sources:");
    for (const s of sources) lines.push(`  - [${s.kind}] ${s.label}`);
  } else {
    lines.push("Sources: (none supplied)");
  }
  const excerpts = options.sourceExcerpts ?? [];
  if (excerpts.length > 0) {
    lines.push("Source excerpts:");
    for (const ex of excerpts) lines.push(`  - ${collapseWhitespace(ex).slice(0, 300)}`);
  }

  lines.push(`Step count: ${plan.length}`);
  lines.push("Steps (summary):");
  for (const step of plan) {
    lines.push(`  ${step.ordinal}. ${step.action} ${describeTarget(step)} [${step.kind}]`);
  }

  if (existing.length > 0) {
    lines.push("");
    lines.push("Questions the deterministic pass already produced (do NOT repeat these):");
    for (const e of existing) lines.push(`  - ${e.question}`);
  }

  lines.push("");
  lines.push("Respond with FAQ entries formatted exactly as described in the system prompt.");
  return lines.join("\n");
}

interface ParsedFaqEntry {
  readonly question: string;
  readonly answer: string;
}

function parseLlmFaq(raw: string): readonly FaqEntry[] | null {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return null;

  // Split by blank lines, then within each block, extract Q: and A: lines.
  const blocks = text.split(/\n\s*\n+/);
  const out: FaqEntry[] = [];
  for (const block of blocks) {
    const qMatch = /^\s*Q\s*[:\-]\s*(.+)$/im.exec(block);
    const aMatch = /^\s*A\s*[:\-]\s*([\s\S]+)$/im.exec(block);
    if (qMatch === null || aMatch === null) continue;
    const question = sanitiseLine(qMatch[1] ?? "");
    const answer = sanitiseLine(aMatch[1] ?? "");
    if (question.length === 0 || answer.length === 0) continue;
    out.push({
      question: trimAtWord(question, MAX_FAQ_QUESTION_LENGTH),
      answer: trimAtWord(answer, MAX_FAQ_ANSWER_LENGTH),
      origin: "llm",
      rule: "llm",
      sourceRefs: [],
      note: "Provided by the language model.",
    });
  }
  return out.length > 0 ? out : null;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function validatePlan(plan: readonly PlanStep[]): void {
  if (!Array.isArray(plan)) {
    throw new FaqError("generateFaq requires a PlanStep array.", "invalid-input");
  }
  if (plan.length === 0) {
    throw new FaqError("Cannot generate FAQ entries for an empty plan.", "empty-plan");
  }
  for (const step of plan) {
    if (step === null || typeof step !== "object") {
      throw new FaqError("Plan contains a non-object step.", "invalid-input");
    }
  }
}

function mergeFaq(
  composed: readonly FaqEntry[],
  llm: readonly FaqEntry[],
): readonly FaqEntry[] {
  const out: FaqEntry[] = [...composed];
  const seen = new Set<string>();
  for (const e of composed) seen.add(faqKey(e));
  for (const e of llm) {
    const key = faqKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function faqKey(e: FaqEntry): string {
  // Normalise the question only, since two entries with the same question
  // but different answers is the case the dedupe is designed to catch.
  return e.question.toLowerCase().replace(/\s+/g, " ").replace(/[?!.,;:]+$/g, "").trim();
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
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function lowerFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v;
}

function readOrigin(v: unknown): FaqOrigin {
  if (v === "composed" || v === "llm" || v === "fallback") return v;
  return "composed";
}

function readRule(v: unknown): FaqEntry["rule"] {
  if (v === "llm") return "llm";
  if (typeof v !== "string") return "goal.howTo";
  for (const rule of FAQ_RULES) {
    if (rule === v) return rule;
  }
  return "goal.howTo";
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  const n = Math.trunc(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  composeFaq,
  makeEntry,
  findAdminHost,
  describeSources,
  describeTarget,
  parseLlmFaq,
  mergeFaq,
  faqKey,
  FAQ_RULES,
  MAX_FAQ_QUESTION_LENGTH,
  MAX_FAQ_ANSWER_LENGTH,
});
