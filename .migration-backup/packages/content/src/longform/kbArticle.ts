/**
 * Zipy AI — long-form: KB / help-centre article (content-generation, long-form batch 0).
 *
 * Composes a full knowledge-base article from a workflow plan and the
 * core-writing artefacts already produced by `@zipy/content` (title/summary,
 * intro/prereqs, per-step copy, tips/warnings, FAQ, glossary).
 *
 * The module is a *composer*: it takes the caller's existing draft, fills
 * gaps with deterministic defaults derived from the plan, and exposes a
 * directive block that a later LLM pass consumes. It does not perform any
 * network I/O and it does not invent facts — where a section cannot be
 * derived from the plan or artefacts, the section is omitted and a gap is
 * recorded.
 *
 * Output shape (`KbArticle`) is versioned so an export template can rely on
 * a stable contract:
 *
 *   ┌ ArticleBlock           — generic heading + paragraphs + blocks
 *   │  └ KbSection           — a named section with a stable id
 *   ├ KbStepScreenshotRef    — a reference to a screenshot (never bytes)
 *   └ KbArticle + KbArticleGap
 *
 * A `KbArticle` is safe to serialise: it contains no functions, no class
 * instances and no binary payloads. Screenshots appear only as asset ids,
 * which the export layer resolves through the object store.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type KbArticleErrorCode =
  | "invalid-input"
  | "no-goal"
  | "empty-plan";

export class KbArticleError extends Error {
  readonly code: KbArticleErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: KbArticleErrorCode,
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

export const KB_SECTION_KINDS = [
  "overview",
  "prerequisites",
  "steps",
  "tips",
  "warnings",
  "troubleshooting",
  "faq",
  "glossary",
  "next-steps",
] as const;
export type KbSectionKind = (typeof KB_SECTION_KINDS)[number];

/** A single reference to a screenshot asset (never embedded bytes). */
export interface KbScreenshotRef {
  /** Stable asset id in the object store. */
  readonly assetId: string;
  /** Alt text for HTML/PDF export. */
  readonly alt: string;
  /** Optional semantic caption shown beneath the image. */
  readonly caption?: string;
}

/** One paragraph, list item or quote inside a section. */
export interface KbBlock {
  readonly kind: "paragraph" | "list" | "note" | "warning" | "code";
  /** Prose for `paragraph`/`note`/`warning`; the code text for `code`. */
  readonly text: string;
  /** Only set for `list`. Each entry is plain text, no inline markup. */
  readonly items?: readonly string[];
  /** Optional syntax language for `code` blocks (e.g. "bash"). */
  readonly language?: string;
}

/** One numbered step. */
export interface KbStep {
  /** 1-based position in the article. */
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** Optional screenshot references for this step. */
  readonly screenshots: readonly KbScreenshotRef[];
  /** Optional list of warnings attached to this step. */
  readonly warnings: readonly string[];
  /** Optional list of tips attached to this step. */
  readonly tips: readonly string[];
  /** Provenance: the plan step this KB step was derived from. */
  readonly sourceStepId: string;
}

export interface KbSection {
  readonly id: string;
  readonly kind: KbSectionKind;
  readonly heading: string;
  readonly blocks: readonly KbBlock[];
  /** Steps are only present on the `steps` section. */
  readonly steps?: readonly KbStep[];
}

/**
 * A declared gap: a section the composer could not fill from the supplied
 * inputs. Gaps are surfaced to the reviewer rather than silently omitted.
 */
export interface KbArticleGap {
  readonly section: KbSectionKind;
  readonly reason:
    | "no-source"
    | "no-goal"
    | "no-plan-steps"
    | "no-faq-source"
    | "no-glossary-source"
    | "no-tips-source";
  readonly detail: string;
}

export interface KbArticle {
  /** Format version for the export templates. */
  readonly version: "kb-article/1";
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  readonly sections: readonly KbSection[];
  /** Tags for search; generated from glossary + goal keywords. */
  readonly tags: readonly string[];
  /** Estimated reading time in minutes (heuristic, advisory). */
  readonly readingTimeMinutes: number;
  /** Declared gaps for the reviewer. Never empty when a section is absent. */
  readonly gaps: readonly KbArticleGap[];
  /** ISO timestamp of composition. */
  readonly generatedAt: string;
  /** Marks this artefact as AI-generated per the safety phase's policy. */
  readonly aiGenerated: true;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/** The minimal shape the composer needs from the core-writing artefacts. */
export interface KbArticleInputs {
  /** The workflow plan this article documents. */
  readonly plan: Plan;
  /**
   * Optional prose artefacts already generated by the core-writing layers.
   * Every field is optional; missing fields become `gaps`.
   */
  readonly title?: { readonly title: string; readonly summary: string } | null;
  readonly introPrereqs?: {
    readonly introduction: string;
    readonly prerequisites: readonly string[];
  } | null;
  /** Per-step copy already generated by `@zipy/content/stepText`. */
  readonly stepText?: Readonly<Record<string, { readonly title: string; readonly description: string }>>;
  /** Tips/warnings already generated by `@zipy/content/tipsWarnings`. */
  readonly tipsWarnings?: Readonly<
    Record<string, { readonly tips: readonly string[]; readonly warnings: readonly string[] }>
  >;
  /** FAQ pairs already generated by `@zipy/content/faq`. */
  readonly faq?: readonly { readonly question: string; readonly answer: string }[];
  /** Glossary entries already generated by `@zipy/content/glossary`. */
  readonly glossary?: readonly { readonly term: string; readonly definition: string }[];
  /** Optional slug override; otherwise derived from the title. */
  readonly slug?: string;
  /** Optional tags override; otherwise derived from the title + glossary. */
  readonly tags?: readonly string[];
  /**
   * Optional screenshot references keyed by plan step id. When absent, the
   * step's screenshots list is empty — the article never invents asset ids.
   */
  readonly screenshotsByStepId?: Readonly<Record<string, readonly KbScreenshotRef[]>>;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compose a `KbArticle` from the caller's plan and partial artefacts. Never
 * throws for missing optional inputs — gaps are recorded instead. Throws
 * only for shape errors (e.g. a non-object plan).
 */
export function composeKbArticle(inputs: KbArticleInputs): KbArticle {
  if (inputs === null || typeof inputs !== "object") {
    throw new KbArticleError("composeKbArticle requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new KbArticleError("A plan object is required.", "invalid-input");
  }
  if (!("goal" in plan) || typeof (plan as { goal?: unknown }).goal !== "string") {
    throw new KbArticleError(
      "The plan does not expose a `goal` string.",
      "no-goal",
    );
  }

  const gaps: KbArticleGap[] = [];
  const goal = (plan as unknown as { goal: string }).goal;
  const steps = readSteps(plan);

  // --------------------------------------------------------------- title --
  const title =
    nonEmpty(inputs.title?.title) ??
    nonEmpty(goal) ??
    "Workflow guide";
  const summary =
    nonEmpty(inputs.title?.summary) ??
    nonEmpty(steps.length > 0 ? `How to ${lowerFirstGoal(goal)} in ${steps.length} steps.` : "") ??
    "";

  if (inputs.title === undefined || inputs.title === null) {
    gaps.push({
      section: "overview",
      reason: "no-source",
      detail: "No title/summary artefact was supplied; a deterministic fallback was used.",
    });
  }

  // ------------------------------------------------------------- sections --
  const sections: KbSection[] = [];

  // Overview
  const overviewBlocks: KbBlock[] = [];
  if (summary.length > 0) {
    overviewBlocks.push({ kind: "paragraph", text: summary });
  }
  if (inputs.introPrereqs?.introduction !== undefined && inputs.introPrereqs.introduction.trim().length > 0) {
    overviewBlocks.push({ kind: "paragraph", text: inputs.introPrereqs.introduction.trim() });
  }
  if (overviewBlocks.length > 0) {
    sections.push({
      id: "overview",
      kind: "overview",
      heading: "Overview",
      blocks: overviewBlocks,
    });
  } else {
    gaps.push({
      section: "overview",
      reason: "no-source",
      detail: "No summary or introduction text was available.",
    });
  }

  // Prerequisites
  const prereqs = pruneStrings(inputs.introPrereqs?.prerequisites ?? []);
  if (prereqs.length > 0) {
    sections.push({
      id: "prerequisites",
      kind: "prerequisites",
      heading: "Before you begin",
      blocks: [{ kind: "list", text: "Prerequisites", items: prereqs }],
    });
  } else {
    gaps.push({
      section: "prerequisites",
      reason: "no-source",
      detail: "No prerequisites were supplied; the section was omitted.",
    });
  }

  // Steps
  if (steps.length === 0) {
    gaps.push({
      section: "steps",
      reason: "no-plan-steps",
      detail: "The supplied plan contains no steps.",
    });
  } else {
    const kbSteps = buildSteps(steps, inputs);
    sections.push({
      id: "steps",
      kind: "steps",
      heading: "Steps",
      blocks: [],
      steps: kbSteps,
    });
  }

  // Tips / warnings gathered across steps
  const allTips: string[] = [];
  const allWarnings: string[] = [];
  for (const step of steps) {
    const entry = inputs.tipsWarnings?.[step.id];
    if (entry === undefined) continue;
    for (const t of entry.tips) if (t.trim().length > 0) allTips.push(`Step ${step.index}: ${t.trim()}`);
    for (const w of entry.warnings) if (w.trim().length > 0) allWarnings.push(`Step ${step.index}: ${w.trim()}`);
  }
  if (allTips.length > 0) {
    sections.push({
      id: "tips",
      kind: "tips",
      heading: "Tips",
      blocks: [{ kind: "list", text: "Tips", items: allTips }],
    });
  } else {
    gaps.push({
      section: "tips",
      reason: "no-tips-source",
      detail: "No step tips were supplied.",
    });
  }
  if (allWarnings.length > 0) {
    sections.push({
      id: "warnings",
      kind: "warnings",
      heading: "Warnings",
      blocks: [{ kind: "list", text: "Warnings", items: allWarnings }],
    });
  }

  // FAQ
  const faq = pruneFaq(inputs.faq ?? []);
  if (faq.length > 0) {
    const blocks: KbBlock[] = [];
    for (const entry of faq) {
      blocks.push({ kind: "paragraph", text: `Q: ${entry.question}` });
      blocks.push({ kind: "paragraph", text: `A: ${entry.answer}` });
    }
    sections.push({
      id: "faq",
      kind: "faq",
      heading: "Frequently asked questions",
      blocks,
    });
  } else {
    gaps.push({
      section: "faq",
      reason: "no-faq-source",
      detail: "No FAQ pairs were supplied.",
    });
  }

  // Glossary
  const glossary = pruneGlossary(inputs.glossary ?? []);
  if (glossary.length > 0) {
    const blocks: KbBlock[] = [];
    for (const entry of glossary) {
      blocks.push({ kind: "paragraph", text: `${entry.term}: ${entry.definition}` });
    }
    sections.push({
      id: "glossary",
      kind: "glossary",
      heading: "Glossary",
      blocks,
    });
  } else {
    gaps.push({
      section: "glossary",
      reason: "no-glossary-source",
      detail: "No glossary entries were supplied.",
    });
  }

  // ----------------------------------------------------------------- meta --
  const slug = inputs.slug !== undefined && inputs.slug.trim().length > 0
    ? normaliseSlug(inputs.slug)
    : slugify(title);
  const tags = pruneStrings(inputs.tags ?? buildTags(title, goal, glossary)).slice(0, 12);
  const readingTimeMinutes = estimateReadingTime(sections);

  return {
    version: "kb-article/1",
    title,
    summary,
    slug,
    sections,
    tags,
    readingTimeMinutes,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the KB article as GitHub-flavoured Markdown. Screenshots are
 * emitted as `![alt](asset://<id>)` so the caller can substitute a real URL
 * at export time without re-running the composer.
 */
export function renderKbArticleMarkdown(article: KbArticle): string {
  const parts: string[] = [];
  parts.push(`# ${article.title}`);
  parts.push("");
  if (article.summary.length > 0) {
    parts.push(article.summary);
    parts.push("");
  }
  if (article.tags.length > 0) {
    parts.push(article.tags.map((t) => `\`${t}\``).join(" "));
    parts.push("");
  }
  for (const section of article.sections) {
    parts.push(`## ${section.heading}`);
    parts.push("");
    for (const block of section.blocks) {
      parts.push(renderBlock(block));
      parts.push("");
    }
    if (section.steps !== undefined) {
      for (const step of section.steps) {
        parts.push(`### ${step.number}. ${step.title}`);
        parts.push("");
        if (step.body.length > 0) {
          parts.push(step.body);
          parts.push("");
        }
        for (const shot of step.screenshots) {
          parts.push(`![${escapeMd(shot.alt)}](asset://${shot.assetId})`);
          if (shot.caption !== undefined) {
            parts.push(`*${escapeMd(shot.caption)}*`);
          }
          parts.push("");
        }
        if (step.warnings.length > 0) {
          for (const w of step.warnings) {
            parts.push(`> **Warning:** ${w}`);
          }
          parts.push("");
        }
        if (step.tips.length > 0) {
          for (const t of step.tips) {
            parts.push(`> **Tip:** ${t}`);
          }
          parts.push("");
        }
      }
    }
  }
  if (article.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Content gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of article.gaps) {
      parts.push(`- **${gap.section}** — ${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Build the LLM directive block for a KB article. The block is appended to
 * the system prompt of the composition step; it instructs the model to
 * respect the compose contract (no invented sections, respect gaps).
 */
export function buildKbArticleDirectives(): string {
  return [
    "You are writing a knowledge-base article from an already approved workflow plan.",
    "Follow this structure exactly: Overview, Before you begin, Steps, optional Tips, optional Warnings, optional FAQ, optional Glossary.",
    "Every step must contain: a short imperative title, a body that names the exact UI element from the plan, and no more than four sentences.",
    "Do not add sections that are not listed. If a section has no source, do not invent content — leave the section out and note the gap.",
    "Do not invent product names, URLs, version numbers, field labels or error codes.",
    "Do not restate the step title in the body. Do not begin the body with 'In this step'. Do not use the word 'simply'.",
    "Every generated string is subject to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Block rendering                                                             */
/* -------------------------------------------------------------------------- */

function renderBlock(block: KbBlock): string {
  switch (block.kind) {
    case "paragraph":
      return block.text;
    case "note":
      return `> **Note:** ${block.text}`;
    case "warning":
      return `> **Warning:** ${block.text}`;
    case "code":
      return `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``;
    case "list": {
      const items = block.items ?? [];
      return items.map((item) => `- ${item}`).join("\n");
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Composer internals                                                          */
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

function buildSteps(
  steps: readonly IndexedStep[],
  inputs: KbArticleInputs,
): readonly KbStep[] {
  const out: KbStep[] = [];
  for (const s of steps) {
    const copy = inputs.stepText?.[s.id];
    const title = nonEmpty(copy?.title) ?? defaultStepTitle(s.planStep, s.index);
    const body = nonEmpty(copy?.description) ?? defaultStepBody(s.planStep);
    const tipsEntry = inputs.tipsWarnings?.[s.id];
    out.push({
      number: s.index,
      title,
      body,
      screenshots: inputs.screenshotsByStepId?.[s.id] ?? [],
      tips: tipsEntry !== undefined ? pruneStrings(tipsEntry.tips) : [],
      warnings: tipsEntry !== undefined ? pruneStrings(tipsEntry.warnings) : [],
      sourceStepId: s.id,
    });
  }
  return out;
}

function defaultStepTitle(step: PlanStep, index: number): string {
  const targetName = step.target !== null && step.target.name.trim().length > 0
    ? step.target.name.trim()
    : null;
  const verb = actionVerb(step.action);
  if (targetName !== null) return `${verb} ${targetName}`;
  return `Step ${index}`;
}

function defaultStepBody(step: PlanStep): string {
  const targetName = step.target !== null && step.target.name.trim().length > 0
    ? step.target.name.trim()
    : null;
  const action = step.action;
  const value =
    typeof step.value === "string" && step.value.trim().length > 0
      ? step.value.trim()
      : null;
  switch (action) {
    case "click":
      return targetName !== null
        ? `Select ${targetName}.`
        : "Select the target control.";
    case "type":
      return value !== null && targetName !== null
        ? `In ${targetName}, enter ${value}.`
        : value !== null
          ? `Enter ${value} in the field.`
          : "Enter the required value in the field.";
    case "select":
      return value !== null && targetName !== null
        ? `In ${targetName}, choose ${value}.`
        : "Choose the required option.";
    case "navigate":
      return value !== null ? `Navigate to ${value}.` : "Navigate to the next page.";
    case "scroll":
      return "Scroll to reveal the next control.";
    default:
      return targetName !== null ? `Interact with ${targetName}.` : "Perform the indicated action.";
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

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function nonEmpty(v: string | undefined | null): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
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

function pruneFaq(entries: readonly { readonly question: string; readonly answer: string }[]): readonly { readonly question: string; readonly answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const q = typeof e.question === "string" ? e.question.trim() : "";
    const a = typeof e.answer === "string" ? e.answer.trim() : "";
    if (q.length === 0 || a.length === 0) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ question: q, answer: a });
  }
  return out;
}

function pruneGlossary(entries: readonly { readonly term: string; readonly definition: string }[]): readonly { readonly term: string; readonly definition: string }[] {
  const out: { term: string; definition: string }[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const term = typeof e.term === "string" ? e.term.trim() : "";
    const def = typeof e.definition === "string" ? e.definition.trim() : "";
    if (term.length === 0 || def.length === 0) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, definition: def });
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
    .slice(0, 80) || "guide";
}

function normaliseSlug(s: string): string {
  return slugify(s);
}

function buildTags(
  title: string,
  goal: string,
  glossary: readonly { readonly term: string }[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string): void => {
    const key = t.toLowerCase();
    if (key.length < 3 || seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const w of title.split(/\s+/)) add(w);
  for (const w of goal.split(/\s+/)) add(w);
  for (const g of glossary) add(g.term);
  return out;
}

function estimateReadingTime(sections: readonly KbSection[]): number {
  let words = 0;
  for (const section of sections) {
    for (const b of section.blocks) {
      words += countWords(b.text);
      if (b.items !== undefined) {
        for (const item of b.items) words += countWords(item);
      }
    }
    if (section.steps !== undefined) {
      for (const step of section.steps) {
        words += countWords(step.title);
        words += countWords(step.body);
      }
    }
  }
  // 200 words per minute — the widely used plain-prose default.
  return Math.max(1, Math.round(words / 200));
}

function countWords(s: string): number {
  return (s.match(/[\p{L}\p{N}][\p{L}\p{N}'\-]*/gu) ?? []).length;
}

function lowerFirstGoal(goal: string): string {
  const trimmed = goal.trim();
  if (trimmed.length === 0) return "complete the workflow";
  // Drop a leading "How to " if the goal already begins with it.
  const stripped = trimmed.replace(/^how\s+to\s+/i, "");
  return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  slugify,
  buildTags,
  estimateReadingTime,
  countWords,
  renderBlock,
  defaultStepTitle,
  defaultStepBody,
  actionVerb,
  lowerFirstGoal,
});
