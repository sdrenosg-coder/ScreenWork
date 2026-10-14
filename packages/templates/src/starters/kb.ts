/**
 * Zipy AI — templates: KB/help-centre article starter (templates batch 2).
 *
 * The KB starter is the entry point the workspace calls when a user picks
 * "Knowledge-base article" from the template picker. It is the adapter
 * layer between the templates module's `GuideSection` shape and the
 * content-side KB composer in `@zipy/content/longform/kbArticle`. It does
 * not compose prose itself: the article's structure, steps, FAQ, tips
 * and glossary come from `composeKbArticle`. The starter's job is to:
 *
 *   1. Resolve the `kb-standard@1` template from the catalogue.
 *   2. Forward the caller's inputs to `composeKbArticle`, plus the
 *      template's declared snippet ids so the composer inserts them in
 *      the right places.
 *   3. Adopt the composed article into `GuideSection[]` keyed by the
 *      template's declared section ids so the result participates in
 *      inheritance and the workspace registry.
 *   4. Surface composition gaps plus any template-side gaps (a required
 *      template section with no composed content).
 *
 * Every organisational fact — the article owner, the reviewer role, the
 * canonical article title — is caller-supplied. The starter never invents
 * a title, an owner, a subject-matter expert, or a URL. Where a
 * template-declared variable cannot be bound from the caller's input a
 * starter gap is recorded and the caller decides how to resolve it.
 *
 * The composed article is retained on the guide so the export layer can
 * re-render it byte-for-byte without re-running composition, and so the
 * post-generation editor can diff against the original AI output.
 */

import {
  composeKbArticle,
  renderKbArticleMarkdown,
  buildKbArticleDirectives,
  type KbArticle,
  type KbArticleInputs,
  type KbArticleGap,
} from "@zipy/content/longform/kbArticle";
import type { Plan } from "@zipy/synth/stepSequence";
import {
  getTemplate,
  type Template,
  type TemplateRegistry,
} from "../library.js";
import type { GuideSection } from "../inheritance.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type KbStarterErrorCode =
  | "invalid-input"
  | "no-goal"
  | "unknown-template"
  | "unbound-required-variable";

export class KbStarterError extends Error {
  readonly code: KbStarterErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: KbStarterErrorCode,
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

export const KB_STARTER_TEMPLATE_ID = "kb-standard@1";

/** Starter-side gap; distinct from the composer's own gap union. */
export interface KbStarterGap {
  readonly source: "starter" | "kb" | "template";
  readonly templateSectionId: string | null;
  readonly detail: string;
  /** The underlying composer gap when `source === "kb"`, for reviewer triage. */
  readonly kbGap?: KbArticleGap;
}

export interface KbStarterGuide {
  readonly version: "kb-starter/1";
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  readonly templateId: string;
  /** The article the adapter adopted. Kept for re-render and export. */
  readonly article: KbArticle;
  /** Sections keyed in the template's declared order. */
  readonly sections: readonly GuideSection[];
  readonly gaps: readonly KbStarterGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface KbStarterInputs {
  readonly plan: Plan;
  /** Per-step copy from the core writing layers, forwarded to the composer. */
  readonly stepText?: KbArticleInputs["stepText"];
  /** Tips and warnings from the core writing layers. */
  readonly tips?: KbArticleInputs["tips"];
  readonly faq?: KbArticleInputs["faq"];
  readonly glossary?: KbArticleInputs["glossary"];
  /** Screenshot asset ids keyed by step id. */
  readonly screenshotsByStepId?: KbArticleInputs["screenshotsByStepId"];
  /** Article-level overrides; never invented by the starter. */
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly introduction?: string | null;
  readonly prerequisites?: readonly string[];
  /** Studio brand/voice directives the composer expects to see inside the LLM prompt. */
  readonly styleDirectives?: KbArticleInputs["styleDirectives"];
  /** Optional workspace template registry that may shadow the builtin. */
  readonly registry?: TemplateRegistry;
  /**
   * Variables the template requires that must be bound before composition.
   * Passed through to the composer for insertion into snippet bodies. The
   * starter never fabricates a missing value: the caller must supply it.
   */
  readonly variables?: Readonly<Record<string, string>>;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildKbFromStarter(inputs: KbStarterInputs): KbStarterGuide {
  if (inputs === null || typeof inputs !== "object") {
    throw new KbStarterError(
      "buildKbFromStarter requires an inputs object.",
      "invalid-input",
    );
  }
  if (inputs.plan === null || typeof inputs.plan !== "object") {
    throw new KbStarterError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (inputs.plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new KbStarterError("The plan does not expose a goal.", "no-goal");
  }

  const template = resolveKbTemplate(inputs.registry);
  const gaps: KbStarterGap[] = [];

  // Every required variable must be bound by the caller before composition
  // — the starter refuses to invent one. `kb-standard@1` requires none, but
  // a workspace override may add some, so the check runs against whatever
  // template was resolved.
  for (const name of template.requiredVariables) {
    const value = inputs.variables?.[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      gaps.push({
        source: "starter",
        templateSectionId: null,
        detail: `Template "${template.id}" requires a binding for "${name}" but none was supplied.`,
      });
      throw new KbStarterError(
        `Template "${template.id}" requires variable "${name}" which was not bound.`,
        "unbound-required-variable",
        { templateId: template.id, variable: name },
      );
    }
  }

  // Forward everything the composer understands. Snippet ids come from the
  // template's declared list so an override that adds a snippet id is
  // honoured without the caller having to know about it.
  const article = composeKbArticle({
    plan: inputs.plan,
    title: inputs.title ?? null,
    summary: inputs.summary ?? null,
    introduction: inputs.introduction ?? null,
    prerequisites: inputs.prerequisites,
    stepText: inputs.stepText,
    tips: inputs.tips,
    faq: inputs.faq,
    glossary: inputs.glossary,
    screenshotsByStepId: inputs.screenshotsByStepId,
    snippetIds: template.snippetIds,
    variables: inputs.variables,
    styleDirectives: inputs.styleDirectives,
  });

  // Surface the composer's gaps under the starter-side type so callers do
  // not have to import the composer's gap union to triage a guide.
  for (const kbGap of article.gaps) {
    gaps.push({
      source: "kb",
      templateSectionId: kbGapSectionId(kbGap),
      detail: kbGap.detail,
      kbGap,
    });
  }

  const sections = adoptArticleIntoGuideSections(article, template, gaps);

  return {
    version: "kb-starter/1",
    title: article.title,
    summary: article.summary,
    slug: article.slug,
    templateId: template.id,
    article,
    sections,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Re-export of the composer's markdown renderer. Kept as a thin wrapper so
 * any starter-specific decoration lands here in one place if it is ever
 * needed. Callers that only need the article use `renderKbArticleMarkdown`.
 */
export function renderKbStarterMarkdown(guide: KbStarterGuide): string {
  return renderKbArticleMarkdown(guide.article);
}

/** Re-export of the composer's directive text for LLM prompts. */
export function buildKbStarterDirectives(): string {
  return buildKbArticleDirectives();
}

/**
 * Adopt a composed article into `GuideSection[]` following the template's
 * declared section order. Sections the template does not declare but the
 * article produced are appended after in template-order-stable fashion so
 * the editor still shows them; each such append records a starter gap
 * because a template should know about its own sections.
 */
export function adoptArticleIntoGuideSections(
  article: KbArticle,
  template: Template,
  gaps: KbStarterGap[],
): readonly GuideSection[] {
  const templateSectionIds = new Set(template.sections.map((s) => s.id));
  const byId = new Map<string, GuideSection>();

  // summary
  if (article.summary.trim().length > 0) {
    byId.set(
      "summary",
      freezeGuideSection({
        id: "summary",
        heading: "Summary",
        body: article.summary,
        assetRefs: Object.freeze([]),
        requiredByTemplate: requiredFor(template, "summary"),
      }),
    );
  } else if (template.sections.some((s) => s.id === "summary" && s.required)) {
    gaps.push({
      source: "template",
      templateSectionId: "summary",
      detail:
        "Template declares a required Summary section but the composed article has no summary.",
    });
  }

  // introduction
  if (article.introduction.trim().length > 0) {
    byId.set(
      "introduction",
      freezeGuideSection({
        id: "introduction",
        heading: "Introduction",
        body: article.introduction,
        assetRefs: Object.freeze([]),
        requiredByTemplate: requiredFor(template, "introduction"),
      }),
    );
  } else if (template.sections.some((s) => s.id === "introduction" && s.required)) {
    gaps.push({
      source: "template",
      templateSectionId: "introduction",
      detail:
        "Template declares a required Introduction section but the composed article has no introduction.",
    });
  }

  // prerequisites
  if (article.prerequisites.length > 0) {
    byId.set(
      "prerequisites",
      freezeGuideSection({
        id: "prerequisites",
        heading: "Prerequisites",
        body: article.prerequisites.map((p) => `- ${p}`).join("\n"),
        assetRefs: Object.freeze([]),
        requiredByTemplate: requiredFor(template, "prerequisites"),
      }),
    );
  } else if (template.sections.some((s) => s.id === "prerequisites" && s.required)) {
    gaps.push({
      source: "template",
      templateSectionId: "prerequisites",
      detail:
        "Template declares a required Prerequisites section but the article has none.",
    });
  }

  // steps
  byId.set(
    "steps",
    freezeGuideSection({
      id: "steps",
      heading: "Steps",
      body: renderStepsAsMarkdown(article),
      assetRefs: Object.freeze(
        article.steps.flatMap((s) => s.screenshotAssets).slice(),
      ),
      requiredByTemplate: requiredFor(template, "steps"),
    }),
  );

  // tips
  if (article.tips.length > 0) {
    byId.set(
      "tips",
      freezeGuideSection({
        id: "tips",
        heading: "Tips & warnings",
        body: article.tips
          .map((t) => `> **${t.kind === "warning" ? "Warning" : "Tip"}:** ${t.body}`)
          .join("\n\n"),
        assetRefs: Object.freeze([]),
        requiredByTemplate: requiredFor(template, "tips"),
      }),
    );
  } else if (template.sections.some((s) => s.id === "tips" && s.required)) {
    gaps.push({
      source: "template",
      templateSectionId: "tips",
      detail: "Template declares a required Tips section but the article has none.",
    });
  }

  // faq
  if (article.faq.length > 0) {
    byId.set(
      "faq",
      freezeGuideSection({
        id: "faq",
        heading: "Frequently asked questions",
        body: article.faq
          .map((qa) => `**${qa.question}**\n\n${qa.answer}`)
          .join("\n\n"),
        assetRefs: Object.freeze([]),
        requiredByTemplate: requiredFor(template, "faq"),
      }),
    );
  } else if (template.sections.some((s) => s.id === "faq" && s.required)) {
    gaps.push({
      source: "template",
      templateSectionId: "faq",
      detail: "Template declares a required FAQ section but the article has none.",
    });
  }

  // glossary
  if (article.glossary.length > 0) {
    byId.set(
      "glossary",
      freezeGuideSection({
        id: "glossary",
        heading: "Glossary",
        body: article.glossary
          .map((g) => `- **${g.term}** — ${g.definition}`)
          .join("\n"),
        assetRefs: Object.freeze([]),
        requiredByTemplate: requiredFor(template, "glossary"),
      }),
    );
  } else if (template.sections.some((s) => s.id === "glossary" && s.required)) {
    gaps.push({
      source: "template",
      templateSectionId: "glossary",
      detail:
        "Template declares a required Glossary section but the article has none.",
    });
  }

  // Emit in template order first, then any article sections the template
  // does not declare. The latter append path records a starter gap because
  // a template should be the source of truth for its own section list.
  const out: GuideSection[] = [];
  const emitted = new Set<string>();
  for (const templateSection of template.sections) {
    const section = byId.get(templateSection.id);
    if (section === undefined) continue;
    out.push(section);
    emitted.add(templateSection.id);
  }
  for (const [id, section] of byId.entries()) {
    if (emitted.has(id)) continue;
    out.push(section);
    if (!templateSectionIds.has(id)) {
      gaps.push({
        source: "starter",
        templateSectionId: id,
        detail: `Composed article produced section "${id}" which template "${template.id}" does not declare.`,
      });
    }
  }

  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function resolveKbTemplate(registry?: TemplateRegistry): Template {
  try {
    return getTemplate(KB_STARTER_TEMPLATE_ID, registry);
  } catch (err) {
    throw new KbStarterError(
      `KB template "${KB_STARTER_TEMPLATE_ID}" is not in the template catalogue.`,
      "unknown-template",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

function kbGapSectionId(gap: KbArticleGap): string | null {
  // The composer uses a small, stable reason vocabulary; map each reason to
  // the section that the gap affects so the reviewer UI can put a marker on
  // the right heading.
  switch (gap.reason) {
    case "no-steps":
      return "steps";
    case "no-introduction":
      return "introduction";
    case "no-summary":
      return "summary";
    case "no-prerequisites":
      return "prerequisites";
    case "no-tips":
      return "tips";
    case "no-faq":
      return "faq";
    case "no-glossary":
      return "glossary";
    default:
      return null;
  }
}

function renderStepsAsMarkdown(article: KbArticle): string {
  const parts: string[] = [];
  for (const step of article.steps) {
    parts.push(`### ${step.number}. ${step.title}`);
    parts.push("");
    parts.push(step.body);
    parts.push("");
    for (const asset of step.screenshotAssets) {
      parts.push(`![Step ${step.number}](asset://${asset})`);
      parts.push("");
    }
  }
  return parts.join("\n").trimEnd();
}

function requiredFor(template: Template, sectionId: string): boolean {
  const section = template.sections.find((s) => s.id === sectionId);
  return section !== undefined ? section.required : false;
}

function freezeGuideSection(s: GuideSection): GuideSection {
  return Object.freeze({
    id: s.id,
    heading: s.heading,
    body: s.body,
    assetRefs: Object.freeze([...s.assetRefs]),
    requiredByTemplate: s.requiredByTemplate,
  });
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  resolveKbTemplate,
  kbGapSectionId,
  renderStepsAsMarkdown,
  requiredFor,
  freezeGuideSection,
});
