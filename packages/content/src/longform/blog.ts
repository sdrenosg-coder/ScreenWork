/**
 * Zipy AI — long-form: blog post (content-generation, long-form batch 0).
 *
 * A blog post is a *narrative* rendering of the workflow: an engaging
 * lede, a short "why this matters" passage, the workflow steps told as a
 * story with first/second-person voice allowed, and a closing passage with
 * a call to action. It is the least structured of the long-form outputs —
 * no prerequisite callouts, no FAQ table, no checkout numbering.
 *
 * The composer is deterministic and composes from the same artefacts the
 * KB article consumes (`titleSummary`, `introPrereqs`, `stepText`,
 * `tipsWarnings`, `faq`, `glossary`), but interprets them through a
 * narrative lens. Where the artefacts are missing, gaps are recorded; the
 * composer never invents marketing claims, customer quotes, statistics or
 * links.
 *
 * Output shape (`BlogPost`) is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type BlogErrorCode = "invalid-input" | "no-goal";

export class BlogError extends Error {
  readonly code: BlogErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: BlogErrorCode,
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

export interface BlogParagraph {
  /** Plain prose for one paragraph. Empty strings are not permitted. */
  readonly text: string;
}

export interface BlogStep {
  readonly number: number;
  readonly sourceStepId: string;
  readonly heading: string;
  readonly paragraphs: readonly BlogParagraph[];
  /** Optional screenshot asset ids for the illustrated blog variant. */
  readonly screenshotAssets: readonly string[];
  /** Tips surfaced as a callout after the step's prose. */
  readonly tips: readonly string[];
}

export interface BlogFaq {
  readonly question: string;
  readonly answer: string;
}

export interface BlogGap {
  readonly section:
    | "lede"
    | "why"
    | "steps"
    | "closing"
    | "faq"
    | "tags";
  readonly reason:
    | "no-source"
    | "no-goal"
    | "no-plan-steps"
    | "no-faq-source"
    | "no-tags";
  readonly detail: string;
}

export interface BlogPost {
  readonly version: "blog/1";
  readonly title: string;
  readonly slug: string;
  /** Meta description for SEO/social; kept short (155 chars typical). */
  readonly metaDescription: string;
  /** The lede paragraph, always present when a goal was supplied. */
  readonly lede: BlogParagraph;
  /** "Why this matters" passage; omitted (null) when no intro was supplied. */
  readonly why: BlogParagraph | null;
  readonly steps: readonly BlogStep[];
  readonly closing: BlogParagraph;
  readonly faq: readonly BlogFaq[];
  readonly tags: readonly string[];
  /** Estimated reading time in minutes; 200 wpm heuristic. */
  readonly readingTimeMinutes: number;
  readonly gaps: readonly BlogGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface BlogInputs {
  readonly plan: Plan;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly slug?: string | null;
  readonly metaDescription?: string | null;
  /** Long-form intro; used for the "why this matters" section. */
  readonly introduction?: string | null;
  /** Step copy overrides. */
  readonly stepText?: Readonly<Record<string, { readonly title: string; readonly description: string }>>;
  readonly tipsWarnings?: Readonly<
    Record<string, { readonly tips: readonly string[]; readonly warnings: readonly string[] }>
  >;
  readonly faq?: readonly { readonly question: string; readonly answer: string }[];
  readonly tags?: readonly string[];
  readonly screenshotsByStepId?: Readonly<Record<string, readonly string[]>>;
  /**
   * Optional call-to-action sentence for the closing. The workspace supplies
   * it (it usually names the product or links to a signup page); the
   * composer does not invent one.
   */
  readonly callToAction?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeBlogPost(inputs: BlogInputs): BlogPost {
  if (inputs === null || typeof inputs !== "object") {
    throw new BlogError("composeBlogPost requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new BlogError("A plan object is required.", "invalid-input");
  }
  const goal = (plan as { goal?: unknown }).goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new BlogError("The plan does not expose a goal.", "no-goal");
  }

  const gaps: BlogGap[] = [];
  const steps = readSteps(plan);

  // Title
  const title = nonEmpty(inputs.title) ?? narrativeTitle(goal);
  if (inputs.title === undefined || inputs.title === null) {
    gaps.push({
      section: "lede",
      reason: "no-source",
      detail: "No title artefact was supplied; a deterministic fallback was used.",
    });
  }

  // Lede
  const ledeText = nonEmpty(inputs.summary) ?? defaultLede(goal, steps.length);
  const lede: BlogParagraph = { text: ledeText };
  if (inputs.summary === undefined || inputs.summary === null) {
    gaps.push({
      section: "lede",
      reason: "no-source",
      detail: "No summary paragraph was supplied; a deterministic lede was used.",
    });
  }

  // Why this matters
  const whyText = nonEmpty(inputs.introduction);
  const why: BlogParagraph | null = whyText !== null ? { text: whyText } : null;
  if (why === null) {
    gaps.push({
      section: "why",
      reason: "no-source",
      detail: "No introduction paragraph was supplied; the 'why this matters' section was omitted.",
    });
  }

  // Steps
  const blogSteps: BlogStep[] = [];
  if (steps.length === 0) {
    gaps.push({
      section: "steps",
      reason: "no-plan-steps",
      detail: "The supplied plan contains no steps.",
    });
  } else {
    for (const entry of steps) {
      const copy = inputs.stepText?.[entry.id];
      const heading = nonEmpty(copy?.title) ?? narrativeStepHeading(entry.planStep, entry.index);
      const body = nonEmpty(copy?.description) ?? defaultStepBody(entry.planStep);
      const tips = (inputs.tipsWarnings?.[entry.id]?.tips ?? [])
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      blogSteps.push({
        number: entry.index,
        sourceStepId: entry.id,
        heading,
        paragraphs: [{ text: body }],
        screenshotAssets: pruneStrings(inputs.screenshotsByStepId?.[entry.id] ?? []),
        tips,
      });
    }
  }

  // Closing
  const cta = nonEmpty(inputs.callToAction);
  const closing: BlogParagraph = {
    text: cta !== null
      ? `${cta} The whole workflow takes about ${Math.max(1, Math.round(blogSteps.length * 0.25))} minute${blogSteps.length > 1 ? "s" : ""} once you know the sequence.`
      : `That is the whole workflow: ${blogSteps.length} step${blogSteps.length === 1 ? "" : "s"} from start to finish. Repeat it as often as your work requires; the sequence does not change.`,
  };

  // FAQ
  const faq = pruneFaq(inputs.faq ?? []);
  if (faq.length === 0) {
    gaps.push({
      section: "faq",
      reason: "no-faq-source",
      detail: "No FAQ pairs were supplied; the FAQ section was omitted.",
    });
  }

  // Tags
  const tags = pruneStrings(inputs.tags ?? extractTags(title, goal)).slice(0, 12);
  if (tags.length === 0) {
    gaps.push({
      section: "tags",
      reason: "no-tags",
      detail: "No tags were supplied and none could be derived from the title or goal.",
    });
  }

  const slug = inputs.slug !== undefined && inputs.slug !== null
    ? slugify(inputs.slug)
    : slugify(title);

  const metaDescription = nonEmpty(inputs.metaDescription) ?? truncate(lede.text, 155);

  const readingTimeMinutes = estimateReadingTime(lede, why, blogSteps, closing, faq);

  return {
    version: "blog/1",
    title,
    slug,
    metaDescription,
    lede,
    why,
    steps: blogSteps,
    closing,
    faq,
    tags,
    readingTimeMinutes,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

export function renderBlogMarkdown(post: BlogPost): string {
  const parts: string[] = [];
  parts.push(`# ${post.title}`);
  parts.push("");
  parts.push(post.lede.text);
  parts.push("");
  if (post.why !== null) {
    parts.push("## Why this matters");
    parts.push("");
    parts.push(post.why.text);
    parts.push("");
  }
  for (const step of post.steps) {
    parts.push(`## ${step.number}. ${step.heading}`);
    parts.push("");
    for (const p of step.paragraphs) {
      parts.push(p.text);
      parts.push("");
    }
    for (const asset of step.screenshotAssets) {
      parts.push(`![Step ${step.number}](asset://${asset})`);
      parts.push("");
    }
    for (const tip of step.tips) {
      parts.push(`> **Tip:** ${tip}`);
      parts.push("");
    }
  }
  parts.push("## Wrapping up");
  parts.push("");
  parts.push(post.closing.text);
  parts.push("");
  if (post.faq.length > 0) {
    parts.push("## Frequently asked questions");
    parts.push("");
    for (const entry of post.faq) {
      parts.push(`### ${entry.question}`);
      parts.push("");
      parts.push(entry.answer);
      parts.push("");
    }
  }
  if (post.tags.length > 0) {
    parts.push(post.tags.map((t) => `#${t.replace(/\s+/g, "-").toLowerCase()}`).join(" "));
    parts.push("");
  }
  if (post.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Content gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of post.gaps) {
      parts.push(`- **${gap.section}** — ${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildBlogDirectives(): string {
  return [
    "You are writing a blog post that narrates an approved workflow plan.",
    "Voice: friendly, second person ('you'), no sales claims and no invented customer quotes or statistics.",
    "Structure exactly: Title, Lede, optional Why this matters, numbered steps, Wrapping up, optional FAQ, optional tags.",
    "Each step is a short heading and one paragraph that names the exact UI element from the plan.",
    "Do not restate the heading in the paragraph. Do not use the word 'simply'. Do not promise an outcome the sources do not support.",
    "If the workspace supplies a call-to-action sentence, use it verbatim in the closing paragraph; do not modify it.",
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

function narrativeTitle(goal: string): string {
  const cleaned = goal.trim().replace(/^how\s+to\s+/i, "");
  const lead = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return `A practical guide: ${lead}`;
}

function defaultLede(goal: string, stepCount: number): string {
  const cleaned = goal.trim().replace(/^how\s+to\s+/i, "");
  const lead = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  if (stepCount === 0) {
    return `Here is how to ${lead}. The workflow has not been expanded into steps yet.`;
  }
  return `Here is how to ${lead} in ${stepCount} clear step${stepCount === 1 ? "" : "s"}. The sequence below is the one that works reliably, regardless of how often you run it.`;
}

function narrativeStepHeading(step: PlanStep, index: number): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  switch (step.action) {
    case "click":
      return name !== null ? `Open ${name}` : `Click the target control`;
    case "type":
      return name !== null ? `Fill in ${name}` : `Enter the value`;
    case "select":
      return name !== null ? `Choose from ${name}` : `Pick the option`;
    case "navigate":
      return `Go to the next page`;
    case "scroll":
      return `Scroll to the next control`;
    default:
      return `Step ${index}`;
  }
}

function defaultStepBody(step: PlanStep): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  const value = typeof step.value === "string" && step.value.trim().length > 0 ? step.value.trim() : null;
  switch (step.action) {
    case "click":
      return name !== null
        ? `Select ${name}. The page updates to show the next stage of the workflow.`
        : "Select the target control. The page updates to show the next stage of the workflow.";
    case "type":
      return value !== null && name !== null
        ? `Enter ${value} in ${name}. The field accepts the value without further formatting.`
        : "Enter the required value in the field.";
    case "select":
      return value !== null && name !== null
        ? `Choose ${value} from ${name}. The selection is confirmed on the same screen.`
        : "Choose the required option from the list.";
    case "navigate":
      return value !== null ? `Navigate to ${value}.` : "Navigate to the next page.";
    case "scroll":
      return "Scroll to reveal the next control.";
    default:
      return name !== null ? `Interact with ${name}.` : "Perform the indicated action.";
  }
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

function pruneFaq(entries: readonly { readonly question: string; readonly answer: string }[]): readonly BlogFaq[] {
  const out: BlogFaq[] = [];
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

function extractTags(title: string, goal: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const consider = (s: string): void => {
    for (const word of s.split(/\s+/)) {
      const t = word.replace(/[^\p{L}\p{N}\-]/gu, "").trim();
      if (t.length < 4) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  };
  consider(title);
  consider(goal);
  return out.slice(0, 8);
}

function estimateReadingTime(
  lede: BlogParagraph,
  why: BlogParagraph | null,
  steps: readonly BlogStep[],
  closing: BlogParagraph,
  faq: readonly BlogFaq[],
): number {
  let words = countWords(lede.text) + countWords(closing.text);
  if (why !== null) words += countWords(why.text);
  for (const s of steps) {
    words += countWords(s.heading);
    for (const p of s.paragraphs) words += countWords(p.text);
    for (const t of s.tips) words += countWords(t);
  }
  for (const entry of faq) words += countWords(entry.question) + countWords(entry.answer);
  return Math.max(1, Math.round(words / 200));
}

function countWords(s: string): number {
  return (s.match(/[\p{L}\p{N}][\p{L}\p{N}'\-]*/gu) ?? []).length;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Truncate at a word boundary, no trailing ellipsis (the caller decides).
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "post";
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
  narrativeTitle,
  narrativeStepHeading,
  defaultLede,
  defaultStepBody,
  extractTags,
  estimateReadingTime,
  countWords,
  truncate,
  pruneFaq,
  pruneStrings,
});
