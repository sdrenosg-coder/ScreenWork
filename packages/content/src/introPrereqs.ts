/**
 * Zipy AI — guide introduction and prerequisites generation (content-generation core, batch 0).
 *
 * The second layer of the core writing engine. Where `titleSummary.ts`
 * answers "what is this guide and who is it for", this layer answers two
 * distinct questions the reader has *before* step 1:
 *
 *   1. The **introduction** — a short paragraph that restates the goal, names
 *      the outcome ("... you will see the new customer appear in the list"),
 *      and sets the reader's expectation about length and pace.
 *   2. The **prerequisites** — a list of things that must already be true
 *      before the reader begins: an account, a role, permissions,
 *      previously-created entities, reachable URLs, installed software.
 *
 * Both are produced in the same pass from the same inputs, because the two
 * are tightly coupled: a prerequisite named in the list should be reflected
 * in the introduction's framing ("this guide assumes you are signed in as an
 * administrator"), and vice versa.
 *
 * How the layer answers each question:
 *
 *   - **Prerequisites** are derived, in priority order:
 *       1. Explicit prerequisites supplied by the caller (a reviewer's list
 *          or a list parsed from a source document). These are authoritative
 *          and pass through unmodified.
 *       2. Prerequisites implied by the plan: a `navigate` step implies the
 *          target URL must be reachable; a step whose target's `role`
 *          matches a known "must be logged in" selector on a source that
 *          declares a login step; a `type` step whose target's role is
 *          `password` implies the reader must have credentials.
 *       3. Prerequisites inferred from the sources: a `url` source named
 *          "admin.example.com" implies admin access; a file source whose
 *          label contains "SOP" implies the reader has read the SOP.
 *       4. When no source supports any prerequisite, the layer emits an
 *          *empty* list rather than a generic boilerplate list. An empty
 *          list is honest and can be filled in by a reviewer; a fabricated
 *          "Windows 10 or later" is not.
 *   - The **introduction** is grounded in three concrete facts:
 *       1. The workflow's goal (from `options.guideGoal`, falling back to
 *          the title's action verb),
 *       2. The step count (so the reader knows how long this will take),
 *       3. The highest-ranked source's kind (so the reader knows the copy is
 *          grounded in a real system, not a mock).
 *
 * Design rules honoured:
 *  - The same `LlmHandle` shape used by the other content layers, so a single
 *    adapter instance threads through the pipeline.
 *  - Deterministic composer runs whenever the LLM is unavailable or
 *    requested; the composer is honest about what it can infer and records
 *    every inference.
 *  - No invented credentials, URLs or software requirements. A prerequisite
 *    is emitted only when it is grounded in the inputs; when the layer cannot
 *    find one it says so in `notes` rather than producing filler.
 *  - The module is a pure function of its arguments plus, in the LLM path,
 *    one adapter call.
 */

import type { PlanStep } from "@zipy/synth/stepSequence";
import type { LlmProvider } from "@zipy/llm/adapter";
import type { TitleSummarySource } from "@zipy/content/titleSummary";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type IntroPrereqsErrorCode = "invalid-input" | "empty-plan";

export class IntroPrereqsError extends Error {
  readonly code: IntroPrereqsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: IntroPrereqsErrorCode,
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

export interface IntroPrereqsLlmHandle {
  readonly complete: (args: {
    readonly task: "content.introPrereqs";
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

/**
 * Where a prerequisite came from. A reviewer can decide whether an explicit
 * prerequisite (supplied by a person) should trump one inferred from a plan
 * or source, and the UI colours them accordingly.
 */
export type PrerequisiteOrigin =
  | "explicit"
  | "plan"
  | "source"
  | "llm";

export interface Prerequisite {
  /** Short, imperative phrase, e.g. "Sign in with an admin account". */
  readonly text: string;
  /** Why the layer believes this prerequisite applies. */
  readonly reason: string;
  /** Where the prerequisite came from. */
  readonly origin: PrerequisiteOrigin;
  /**
   * Optional refs to the plan steps or source labels that justify the
   * prerequisite. Used by the provenance panel; never rendered as raw ids in
   * the reader-facing intro.
   */
  readonly refs: readonly string[];
}

export interface IntroPrereqStyle {
  readonly tone?: "formal" | "casual" | "technical";
  readonly audience?: "end-user" | "admin" | "developer";
  readonly brandTerms?: readonly string[];
}

export interface GenerateIntroPrereqsOptions {
  readonly llm?: IntroPrereqsLlmHandle | null;
  readonly deterministic?: boolean;
  readonly provider?: LlmProvider;
  readonly model?: string | null;
  readonly style?: IntroPrereqStyle;
  /** Goals the reader is trying to accomplish; typically from `IntentExtraction`. */
  readonly guideGoal?: string | null;
  /** Page title where the workflow starts; used to ground the intro. */
  readonly startPageTitle?: string | null;
  /** Sources that ground the guide; same inputs as `generateTitleSummary`. */
  readonly sources?: readonly TitleSummarySource[];
  /**
   * Prerequisites supplied by the caller (a reviewer's list or a parsed
   * source). These pass through unmodified and are marked `explicit`.
   */
  readonly explicitPrerequisites?: readonly string[];
  /**
   * Maximum number of prerequisites to emit. Defaults to 6; a longer list is
   * not read and pushes the reader past the introduction.
   */
  readonly maxPrerequisites?: number;
}

export interface IntroPrereqsResult {
  /** 2-4 sentences. No bullet points, no headings. */
  readonly introduction: string;
  /** Ordered list of prerequisites, most fundamental first. Never null. */
  readonly prerequisites: readonly Prerequisite[];
  /** Whether the introduction came from the LLM, the composer, or a fallback. */
  readonly introductionSource: "llm" | "composed" | "fallback";
  /** Whether the prerequisites came from the LLM, the composer, or a fallback. */
  readonly prerequisitesSource: "llm" | "composed" | "fallback";
  /** Populated when the LLM was attempted and failed. Otherwise null. */
  readonly llmFailureReason: string | null;
  /** Informational notes recorded by the layer, e.g. empty prerequisite list. */
  readonly notes: readonly string[];
  readonly model: string | null;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Produce the guide's introduction and prerequisites.
 *
 * Throws `IntroPrereqsError` for a malformed plan (`invalid-input`) or an
 * empty plan (`empty-plan`). Never throws for a bad LLM response — that path
 * returns a `fallback` result with a reason.
 */
export async function generateIntroPrereqs(
  plan: readonly PlanStep[],
  options: GenerateIntroPrereqsOptions = {},
): Promise<IntroPrereqsResult> {
  validatePlan(plan);
  const notes: string[] = [];

  const composedPrereqs = composePrerequisites(
    plan,
    options.explicitPrerequisites ?? [],
    options.sources ?? [],
    notes,
  );
  const composedIntro = composeIntroduction(plan, options, composedPrereqs, notes);

  const maxPrereqs = clampInt(options.maxPrerequisites ?? 6, 0, 20);
  const trimmed = composedPrereqs.slice(0, maxPrereqs);
  if (composedPrereqs.length > trimmed.length) {
    notes.push(
      `Composer produced ${composedPrereqs.length} prerequisites; trimmed to ${maxPrereqs} for readability.`,
    );
  }

  if (options.deterministic === true) {
    return {
      introduction: composedIntro,
      prerequisites: trimmed,
      introductionSource: "composed",
      prerequisitesSource: "composed",
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
      introduction: composedIntro,
      prerequisites: trimmed,
      introductionSource: "composed",
      prerequisitesSource: "composed",
      llmFailureReason: null,
      notes: [
        ...notes,
        llm === null
          ? "No LLM handle supplied; deterministic composer used for introduction and prerequisites."
          : "LLM handle reported no provider configured; deterministic composer used for introduction and prerequisites.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // LLM path.
  let raw: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await llm.complete({
      task: "content.introPrereqs",
      system: buildSystemPrompt(options.style),
      user: buildUserPrompt(plan, options, composedPrereqs),
      maxOutputChars: 1200,
      temperature: 0.3,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    raw = response.text;
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  const parsed = raw === null ? null : parseLlmResponse(raw);
  if (parsed === null || parsed.introduction === null) {
    const reason =
      failureReason ??
      "LLM returned an unusable introduction/prerequisites response; composer output substituted.";
    return {
      introduction: composedIntro,
      prerequisites: trimmed,
      introductionSource: "fallback",
      prerequisitesSource: "fallback",
      llmFailureReason: reason,
      notes: [
        ...notes,
        "LLM response could not be parsed; fallback to composer.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Merge the LLM prerequisites with the composer's. LLM rows are added only
  // when they are not semantically identical to a composer row; a
  // case-insensitive, whitespace-collapsed comparison catches the common
  // duplication.
  const llmPrereqs: Prerequisite[] = parsed.prerequisites.map((text) => ({
    text,
    reason: "Identified by the language model from the plan and sources.",
    origin: "llm",
    refs: [],
  }));
  const merged = mergePrereqs(composedPrereqs, llmPrereqs).slice(0, maxPrereqs);

  return {
    introduction: trimAtWord(parsed.introduction, 900),
    prerequisites: merged,
    introductionSource: "llm",
    prerequisitesSource: merged.length > 0 ? "llm" : "composed",
    llmFailureReason: null,
    notes,
    model: parsed.model,
    generatedAt: new Date().toISOString(),
  };
}

export function rehydrateIntroPrereqs(value: unknown): IntroPrereqsResult {
  if (value === null || typeof value !== "object") {
    throw new IntroPrereqsError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const prereqsRaw = Array.isArray(r["prerequisites"])
    ? (r["prerequisites"] as unknown[])
    : [];
  const prerequisites: Prerequisite[] = [];
  for (const p of prereqsRaw) {
    if (p === null || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const text = readString(o["text"]);
    if (text === null || text.length === 0) continue;
    prerequisites.push({
      text,
      reason: readString(o["reason"]) ?? "",
      origin: readOrigin(o["origin"]),
      refs: Array.isArray(o["refs"])
        ? (o["refs"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    });
  }
  return {
    introduction: readString(r["introduction"]) ?? "",
    prerequisites,
    introductionSource: readSource(r["introductionSource"]),
    prerequisitesSource: readSource(r["prerequisitesSource"]),
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

function composeIntroduction(
  plan: readonly PlanStep[],
  options: GenerateIntroPrereqsOptions,
  prerequisites: readonly Prerequisite[],
  notes: string[],
): string {
  const goal = readString(options.guideGoal ?? null);
  const stepCount = plan.length;
  const page = readString(options.startPageTitle ?? null);
  const sources = options.sources ?? [];
  const audience = options.style?.audience ?? "end-user";

  const audienceWord =
    audience === "admin" ? "administrators" : audience === "developer" ? "developers" : "users";

  const opening =
    goal !== null
      ? `This guide shows how to ${lowerFirst(goal.trim())}.`
      : `This guide walks through a ${stepCount}-step ${page !== null ? `${page} ` : ""}workflow.`;
  const paceClause =
    stepCount <= 3
      ? ` It takes just a few minutes to complete.`
      : stepCount <= 8
        ? ` Follow the steps in order; the full workflow takes around ten minutes.`
        : ` The workflow has ${stepCount} steps and will take some care to complete the first time.`;
  const groundingClause =
    sources.length > 0
      ? ` The steps were captured from ${describeSources(sources)}.`
      : ` No live source was captured for this guide; the steps describe the intended actions.`;
  const prereqClause =
    prerequisites.length > 0
      ? ` Before you begin, check the prerequisites listed below.`
      : ` No prerequisites were identified from the sources; add any that apply before publishing.`;
  const audienceClause = ` Intended for ${audienceWord}.`;

  if (sources.length === 0) {
    notes.push(
      "No sources supplied; the introduction is grounded only in the plan and goal.",
    );
  }
  if (goal === null && page === null) {
    notes.push(
      "Neither `guideGoal` nor `startPageTitle` was supplied; the introduction uses the step count as its anchor.",
    );
  }

  const sentence = `${opening}${paceClause}${groundingClause}${prereqClause}${audienceClause}`;
  return trimAtWord(collapseWhitespace(sentence), 900);
}

function composePrerequisites(
  plan: readonly PlanStep[],
  explicit: readonly string[],
  sources: readonly TitleSummarySource[],
  notes: string[],
): readonly Prerequisite[] {
  const out: Prerequisite[] = [];
  const seen = new Set<string>();
  const push = (text: string, reason: string, origin: PrerequisiteOrigin, refs: readonly string[]) => {
    const key = normaliseKey(text);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, reason, origin, refs });
  };

  // 1. Explicit prerequisites from the caller.
  for (const text of explicit) {
    const clean = collapseWhitespace(text).replace(/[.;]+$/, "");
    if (clean.length === 0) continue;
    push(clean, "Supplied by the caller as an explicit prerequisite.", "explicit", []);
  }

  // 2. Plan-derived prerequisites.
  const hosts = collectHostsFromPlan(plan);
  const hasPasswordType = plan.some(
    (s) => s.action === "type" && s.target !== null && s.target.role === "textbox" && /password/i.test(s.target.name),
  );
  const hasAdminUrl = hosts.some((h) => /(^|\.)admin\.|(^|\.)manage\./i.test(h));
  const hasPortalUrl = hosts.some((h) => /portal|dashboard|console/i.test(h));

  if (hasAdminUrl) {
    push(
      "Sign in with an account that has administrator rights.",
      "The workflow's host name contains an admin or management subdomain.",
      "plan",
      hosts.filter((h) => /(^|\.)admin\.|(^|\.)manage\./i.test(h)),
    );
  } else if (hasPasswordType) {
    push(
      "Have your credentials ready to sign in.",
      "A step types into a password field, which implies a login.",
      "plan",
      plan
        .filter((s) => s.action === "type" && s.target !== null && /password/i.test(s.target.name))
        .map((s) => s.stepId),
    );
  } else if (hosts.length > 0) {
    push(
      "Be signed in to the application.",
      "The workflow targets a live host; most authenticated applications require a session.",
      "plan",
      hosts,
    );
  }

  if (hasPortalUrl && !hasAdminUrl) {
    push(
      "Confirm your account has access to the application dashboard.",
      "The workflow's host name matches a dashboard or portal pattern.",
      "plan",
      hosts.filter((h) => /portal|dashboard|console/i.test(h)),
    );
  }

  const requiredPages = collectPagesFromPlan(plan);
  if (requiredPages.length > 0) {
    push(
      `Have access to ${requiredPages.join(", ")}.`,
      "The workflow navigates to a specific path, which must be reachable.",
      "plan",
      requiredPages,
    );
  }

  // 3. Source-derived prerequisites.
  for (const s of sources) {
    if (s.kind === "file" && /\bsop\b|\bpolicy\b|\bprocedure\b/i.test(s.label)) {
      push(
        `Read the ${cleanLabelForProse(s.label)} before you begin.`,
        "A source document names a policy or procedure and is described as a prerequisite.",
        "source",
        [s.label],
      );
    }
    if (s.kind === "url" && /(^|\.)admin\.|(^|\.)manage\./i.test(s.label)) {
      push(
        "Have the URL of the admin console available.",
        "A source is the admin console URL and will be required during the workflow.",
        "source",
        [s.label],
      );
    }
  }

  if (out.length === 0) {
    notes.push(
      "No prerequisites were inferred from the plan or sources; the list is empty and should be reviewed before publishing.",
    );
  }
  return out;
}

function collectHostsFromPlan(plan: readonly PlanStep[]): readonly string[] {
  const hosts = new Set<string>();
  for (const step of plan) {
    if (step.action !== "navigate" || step.navigateUrl === null) continue;
    try {
      const u = new URL(step.navigateUrl);
      hosts.add(u.host);
    } catch {
      // Not a URL; skip.
    }
  }
  return [...hosts];
}

function collectPagesFromPlan(plan: readonly PlanStep[]): readonly string[] {
  const pages = new Set<string>();
  for (const step of plan) {
    if (step.action !== "navigate" || step.navigateUrl === null) continue;
    try {
      const u = new URL(step.navigateUrl);
      const path = u.pathname.replace(/^\/+|\/+$/g, "");
      if (path.length > 0) pages.add(`/${path}`);
    } catch {
      // Not a URL; skip.
    }
  }
  return [...pages];
}

function cleanLabelForProse(label: string): string {
  return collapseWhitespace(label).replace(/[.!?]+$/, "");
}

/* -------------------------------------------------------------------------- */
/* LLM prompt construction                                                     */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(style: IntroPrereqStyle | undefined): string {
  const tone = style?.tone ?? "neutral";
  const audience = style?.audience ?? "end-user";
  const brand = style?.brandTerms ?? [];
  const brandLine =
    brand.length > 0
      ? `Preserve these brand terms verbatim: ${brand.join(", ")}.`
      : "Do not invent product, page or brand names.";

  return [
    "You write the introduction and prerequisites for a step-by-step screenshot tutorial.",
    "",
    "Format rules:",
    "- Output exactly two sections in this order, each on its own line:",
    "    Introduction: <2-4 sentences, no bullet points, no headings>",
    "    Prerequisites: <one prerequisite per line, each prefixed with '- '>",
    "- A prerequisite is a state that must already hold before the reader starts (an account, a role, a page, a file). It is not a step.",
    "- Emit at most six prerequisites. If you cannot identify any, output 'Prerequisites: none'.",
    "- Do not invent credentials, URLs, software requirements or prior tasks that are not grounded in the inputs.",
    "- Do not restate the individual steps verbatim; introduce them.",
    `Assume the reader is ${audience}. Use a ${tone} tone.`,
    brandLine,
  ].join("\n");
}

function buildUserPrompt(
  plan: readonly PlanStep[],
  options: GenerateIntroPrereqsOptions,
  composedPrereqs: readonly Prerequisite[],
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

  if (composedPrereqs.length > 0) {
    lines.push("Candidate prerequisites the deterministic pass identified (may be used, rewritten or omitted):");
    for (const p of composedPrereqs) lines.push(`  - ${p.text}`);
  } else {
    lines.push("No candidate prerequisites were identified by the deterministic pass.");
  }

  lines.push(`Step count: ${plan.length}`);
  lines.push("Steps (summary):");
  for (const step of plan) {
    const target =
      step.target !== null && step.target.name.length > 0
        ? `“${step.target.name}”`
        : step.target !== null
          ? `the ${step.target.role}`
          : "(unresolved target)";
    lines.push(`  ${step.ordinal}. ${step.action} ${target} [${step.kind}]`);
  }

  lines.push("Respond with the two sections described in the system prompt.");
  return lines.join("\n");
}

interface ParsedIntroPrereqs {
  readonly introduction: string | null;
  readonly prerequisites: readonly string[];
  readonly model: string | null;
}

function parseLlmResponse(raw: string): ParsedIntroPrereqs | null {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return null;

  const introMatch = /^\s*introduction\s*[:\-]\s*([\s\S]+?)(?:\n\s*prerequisites?\s*[:\-]|$)/im.exec(text);
  const prereqMatch = /^\s*prerequisites?\s*[:\-]\s*([\s\S]*)$/im.exec(text);

  const introduction = introMatch !== null ? sanitiseLine(introMatch[1] ?? "") : null;

  const prerequisites: string[] = [];
  if (prereqMatch !== null) {
    const block = prereqMatch[1] ?? "";
    for (const piece of block.split(/\n+/)) {
      const clean = sanitiseLine(piece.replace(/^\s*[-*•]\s*/, "").replace(/^\s*\d+[.)]\s*/, ""));
      if (clean.length === 0) continue;
      if (/^none\b/i.test(clean)) continue;
      prerequisites.push(clean);
    }
  }

  if (introduction === null && prerequisites.length === 0) {
    // No sections at all: interpret the entire text as the introduction and
    // emit no prerequisites. This is the shape a model produces when the
    // format instruction is ignored and the prerequisites are trivially empty.
    const whole = sanitiseLine(text);
    if (whole.length === 0) return null;
    return { introduction: whole, prerequisites: [], model: null };
  }
  return { introduction, prerequisites, model: null };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function validatePlan(plan: readonly PlanStep[]): void {
  if (!Array.isArray(plan)) {
    throw new IntroPrereqsError(
      "generateIntroPrereqs requires a PlanStep array.",
      "invalid-input",
    );
  }
  if (plan.length === 0) {
    throw new IntroPrereqsError(
      "Cannot generate an introduction and prerequisites for an empty plan.",
      "empty-plan",
    );
  }
  for (const step of plan) {
    if (step === null || typeof step !== "object") {
      throw new IntroPrereqsError(
        "Plan contains a non-object step.",
        "invalid-input",
      );
    }
  }
}

function mergePrereqs(
  composed: readonly Prerequisite[],
  llm: readonly Prerequisite[],
): readonly Prerequisite[] {
  const out: Prerequisite[] = [];
  const seen = new Set<string>();
  for (const p of composed) {
    const key = normaliseKey(p.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  for (const p of llm) {
    const key = normaliseKey(p.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function normaliseKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?,;:]+$/g, "").trim();
}

function describeSources(sources: readonly TitleSummarySource[]): string {
  const first = sources[0];
  if (first === undefined) return "the supplied sources";
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

function lowerFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v;
}

function readOrigin(v: unknown): PrerequisiteOrigin {
  if (v === "explicit" || v === "plan" || v === "source" || v === "llm") return v;
  return "plan";
}

function readSource(v: unknown): IntroPrereqsResult["introductionSource"] {
  if (v === "llm" || v === "composed" || v === "fallback") return v;
  return "composed";
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
  composeIntroduction,
  composePrerequisites,
  collectHostsFromPlan,
  collectPagesFromPlan,
  parseLlmResponse,
  mergePrereqs,
  normaliseKey,
});
