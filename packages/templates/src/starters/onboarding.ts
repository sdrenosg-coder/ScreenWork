/**
 * Zipy AI — templates: onboarding guide starter (templates batch 1).
 *
 * The onboarding starter turns a workflow plan plus caller-supplied
 * organisational facts (employee name, manager, start date, pre-start
 * checklist items, etc.) into an onboarding guide. An onboarding guide is
 * structurally different from a KB article: it addresses the reader ("you")
 * in the second person, is organised around a *timeline* (before day one,
 * day one, week one, day thirty) rather than a linear procedure, and ends
 * with a signature/acknowledgement block.
 *
 * The starter composes the well-known shape from `./library.ts`
 * (`onboarding-standard@1`) using the following rule for pulling content
 * out of a plan:
 *
 *   - Plan steps whose action is `navigate` become "before your first day"
 *     items (account access, links to open, MFA enrolment).
 *   - Plan steps whose action is `type` on a named element or that carry a
 *     value become "day one" items (set up a profile, enter personal
 *     details).
 *   - All other steps are grouped into the "first week" checklist in their
 *     original plan order.
 *   - The "first 30 days" section is prose taken from the caller's
 *     `day30Expectations`; without it the section is left out and a gap is
 *     recorded — the starter never invents expectations.
 *
 * Every organisational fact is caller-supplied. The starter never invents
 * an employee name, a manager, a start date, a company name, a link or a
 * checklist item. Missing facts are recorded as gaps so the reviewer can
 * fill them in.
 *
 * Output shape (`OnboardingGuide`) is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";
import {
  getTemplate,
  type Template,
  type TemplateRegistry,
} from "../library.js";
import type { GuideSection } from "../inheritance.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type OnboardingErrorCode =
  | "invalid-input"
  | "no-goal"
  | "unknown-template";

export class OnboardingError extends Error {
  readonly code: OnboardingErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: OnboardingErrorCode,
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

export interface OnboardingFacts {
  /** The new joiner's preferred name; used for the second-person address. */
  readonly employeeName: string;
  /** Joiner's role/title as it should appear in the guide. */
  readonly employeeRole: string | null;
  readonly managerName: string;
  /** ISO date string, e.g. "2024-06-01". */
  readonly startDate: string;
  /** Workspace/company name; used in the welcome paragraph. */
  readonly organisationName: string;
}

export interface OnboardingGuideSection extends GuideSection {
  /** Timeline bucket this section belongs to. */
  readonly bucket:
    | "welcome"
    | "pre-start"
    | "day-one"
    | "first-week"
    | "day-30"
    | "acknowledgements";
}

export interface OnboardingGap {
  readonly bucket: OnboardingGuideSection["bucket"] | null;
  readonly reason:
    | "missing-employee-name"
    | "missing-manager-name"
    | "missing-start-date"
    | "missing-organisation"
    | "no-pre-start-items"
    | "no-day-one-items"
    | "no-first-week-items"
    | "no-day30-expectations"
    | "no-acknowledgement"
    | "no-plan-steps";
  readonly detail: string;
}

export interface OnboardingGuide {
  readonly version: "onboarding/1";
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  /** The facts the guide was composed with. */
  readonly facts: OnboardingFacts;
  /** Ordered sections in the timeline order the template declares. */
  readonly sections: readonly OnboardingGuideSection[];
  /** The template id the guide follows (currently always `onboarding-standard@1`). */
  readonly templateId: string;
  readonly gaps: readonly OnboardingGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface OnboardingStarterInputs {
  readonly plan: Plan;
  /** Organisational facts. Partial facts are accepted; missing fields become gaps. */
  readonly facts: Partial<OnboardingFacts>;
  /**
   * Pre-start checklist items the caller has authored (e.g. "Sign the NDA").
   * Combined with the plan-derived items; the plan-derived items come first.
   */
  readonly preStartItems?: readonly string[];
  /** Day-one items the caller has authored (e.g. "Introduce yourself in #general"). */
  readonly dayOneItems?: readonly string[];
  /** First-week milestone items the caller has authored. */
  readonly firstWeekItems?: readonly string[];
  /** Prose for the "first 30 days" section. Never invented; absent = gap. */
  readonly day30Expectations?: readonly string[];
  /** Sign-off block; the starter never fabricates a signature. */
  readonly acknowledgement?: string | null;
  /** Optional override of the template registry (workspace templates). */
  readonly registry?: TemplateRegistry;
  /** Optional title override; falls back to a deterministic title. */
  readonly title?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export const ONBOARDING_STARTER_TEMPLATE_ID = "onboarding-standard@1";

export function buildOnboardingGuide(
  inputs: OnboardingStarterInputs,
): OnboardingGuide {
  if (inputs === null || typeof inputs !== "object") {
    throw new OnboardingError("buildOnboardingGuide requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new OnboardingError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new OnboardingError("The plan does not expose a goal.", "no-goal");
  }
  const goal = goalRaw.trim();

  const template = resolveOnboardingTemplate(inputs.registry);
  const gaps: OnboardingGap[] = [];

  const facts = validateFacts(inputs.facts ?? {}, gaps);

  const title =
    nonEmpty(inputs.title) ??
    (facts.employeeName !== null
      ? `Onboarding guide for ${facts.employeeName}`
      : `Onboarding guide`);
  const summary =
    facts.employeeName !== null && facts.organisationName !== null
      ? `Welcome, ${facts.employeeName}. This guide walks you through your first 30 days at ${facts.organisationName}.`
      : `This guide walks the new joiner through their first 30 days.`;
  const slug = slugify(`onboarding-${facts.employeeName ?? goal}`);

  const steps = readSteps(plan);
  if (steps.length === 0) {
    gaps.push({
      bucket: null,
      reason: "no-plan-steps",
      detail: "The plan contains no steps; the timeline checklists cannot be derived.",
    });
  }

  // Bucket the plan steps.
  const preStartFromPlan: string[] = [];
  const dayOneFromPlan: string[] = [];
  const firstWeekFromPlan: string[] = [];
  for (const step of steps) {
    const text = describeStep(step.planStep);
    if (text === null) continue;
    switch (step.planStep.action) {
      case "navigate":
        preStartFromPlan.push(text);
        break;
      case "type":
        dayOneFromPlan.push(text);
        break;
      default:
        firstWeekFromPlan.push(text);
        break;
    }
  }

  const preStartItems = uniqueStrings([
    ...preStartFromPlan,
    ...pruneStrings(inputs.preStartItems ?? []),
  ]);
  const dayOneItems = uniqueStrings([
    ...dayOneFromPlan,
    ...pruneStrings(inputs.dayOneItems ?? []),
  ]);
  const firstWeekItems = uniqueStrings([
    ...firstWeekFromPlan,
    ...pruneStrings(inputs.firstWeekItems ?? []),
  ]);
  const day30Prose = pruneStrings(inputs.day30Expectations ?? []);
  const acknowledgement = nonEmpty(inputs.acknowledgement);

  if (preStartItems.length === 0) {
    gaps.push({
      bucket: "pre-start",
      reason: "no-pre-start-items",
      detail:
        "No pre-start items were supplied or derivable from the plan; the 'Before your first day' section is empty.",
    });
  }
  if (dayOneItems.length === 0) {
    gaps.push({
      bucket: "day-one",
      reason: "no-day-one-items",
      detail:
        "No day-one items were supplied or derivable from the plan; the 'Your first day' section is empty.",
    });
  }
  if (firstWeekItems.length === 0) {
    gaps.push({
      bucket: "first-week",
      reason: "no-first-week-items",
      detail:
        "No first-week items were supplied or derivable from the plan; the 'Your first week' section is empty.",
    });
  }
  if (day30Prose.length === 0) {
    gaps.push({
      bucket: "day-30",
      reason: "no-day30-expectations",
      detail:
        "No 'first 30 days' expectations were supplied; the section is omitted rather than invented.",
    });
  }
  if (acknowledgement === null) {
    gaps.push({
      bucket: "acknowledgements",
      reason: "no-acknowledgement",
      detail: "No acknowledgement block was supplied; the guide ends without a signature.",
    });
  }

  // Resolve the template's section order. Missing caller content for a
  // section that the template declared produces no section entry — the gap
  // list already records why.
  const sections: OnboardingGuideSection[] = [];
  for (const templateSection of template.sections) {
    const bucket = sectionIdToBucket(templateSection.id);
    if (bucket === null) continue;
    const built = buildSection(bucket, {
      facts,
      title,
      summary,
      preStartItems,
      dayOneItems,
      firstWeekItems,
      day30Prose,
      acknowledgement,
    });
    if (built !== null) sections.push(built);
  }

  return {
    version: "onboarding/1",
    title,
    summary,
    slug,
    facts: {
      employeeName: facts.employeeName ?? "",
      employeeRole: facts.employeeRole,
      managerName: facts.managerName ?? "",
      startDate: facts.startDate ?? "",
      organisationName: facts.organisationName ?? "",
    },
    sections,
    templateId: template.id,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the onboarding guide as Markdown. Identical structure to
 * `renderSopMarkdown` (heading, prose, bullet lists, sign-off) so the
 * export layer can share a renderer.
 */
export function renderOnboardingMarkdown(guide: OnboardingGuide): string {
  const parts: string[] = [];
  parts.push(`# ${guide.title}`);
  parts.push("");
  parts.push(guide.summary);
  parts.push("");
  for (const section of guide.sections) {
    parts.push(`## ${section.heading}`);
    parts.push("");
    if (section.body.length > 0) {
      parts.push(section.body);
      parts.push("");
    }
    const bullets = extractBullets(section.body);
    if (bullets.length > 0) {
      for (const b of bullets) parts.push(`- ${b}`);
      parts.push("");
    }
  }
  if (guide.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of guide.gaps) {
      parts.push(`- ${gap.bucket !== null ? `[${gap.bucket}] ` : ""}${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildOnboardingDirectives(): string {
  return [
    "You are writing an employee onboarding guide from an approved workflow plan and caller-supplied organisational facts.",
    "Address the reader in the second person. Never invent an employee name, manager name, start date, organisation name, link, or checklist item — use the caller-supplied facts verbatim and flag missing facts as gaps.",
    "Follow the timeline structure exactly: Welcome, Before your first day, Your first day, Your first week, Your first 30 days, Acknowledgements. Omit a bucket entirely when the caller supplied nothing for it.",
    "Checklist items are imperative and named after a concrete action (an account to open, a form to sign, a person to meet). Do not include vague items like 'learn about the company'.",
    "Do not include benefits, policies, org charts, or company values unless the caller supplied them.",
    "Do not use the word 'simply'. Do not use marketing language.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function resolveOnboardingTemplate(registry?: TemplateRegistry): Template {
  try {
    return getTemplate(ONBOARDING_STARTER_TEMPLATE_ID, registry);
  } catch (err) {
    throw new OnboardingError(
      `Onboarding template "${ONBOARDING_STARTER_TEMPLATE_ID}" is not in the template catalogue.`,
      "unknown-template",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

function validateFacts(
  raw: Partial<OnboardingFacts>,
  gaps: OnboardingGap[],
): {
  employeeName: string | null;
  employeeRole: string | null;
  managerName: string | null;
  startDate: string | null;
  organisationName: string | null;
} {
  const employeeName = nonEmpty(raw.employeeName);
  const employeeRole = nonEmpty(raw.employeeRole ?? null);
  const managerName = nonEmpty(raw.managerName);
  const startDate = nonEmpty(raw.startDate);
  const organisationName = nonEmpty(raw.organisationName);

  if (employeeName === null) {
    gaps.push({
      bucket: "welcome",
      reason: "missing-employee-name",
      detail: "No employee name was supplied; the guide addresses a generic reader.",
    });
  }
  if (managerName === null) {
    gaps.push({
      bucket: "welcome",
      reason: "missing-manager-name",
      detail: "No manager name was supplied; the guide does not name a manager.",
    });
  }
  if (startDate === null) {
    gaps.push({
      bucket: "pre-start",
      reason: "missing-start-date",
      detail: "No start date was supplied; the guide cannot state when day one is.",
    });
  }
  if (organisationName === null) {
    gaps.push({
      bucket: "welcome",
      reason: "missing-organisation",
      detail: "No organisation name was supplied; the guide does not name the employer.",
    });
  }
  return { employeeName, employeeRole, managerName, startDate, organisationName };
}

interface SectionBuildContext {
  readonly facts: {
    readonly employeeName: string | null;
    readonly employeeRole: string | null;
    readonly managerName: string | null;
    readonly startDate: string | null;
    readonly organisationName: string | null;
  };
  readonly title: string;
  readonly summary: string;
  readonly preStartItems: readonly string[];
  readonly dayOneItems: readonly string[];
  readonly firstWeekItems: readonly string[];
  readonly day30Prose: readonly string[];
  readonly acknowledgement: string | null;
}

function buildSection(
  bucket: OnboardingGuideSection["bucket"],
  ctx: SectionBuildContext,
): OnboardingGuideSection | null {
  switch (bucket) {
    case "welcome": {
      const lines: string[] = [];
      const who = ctx.facts.employeeName;
      const org = ctx.facts.organisationName;
      const role = ctx.facts.employeeRole;
      const manager = ctx.facts.managerName;
      const start = ctx.facts.startDate;
      const lead =
        who !== null && org !== null
          ? `Welcome to ${org}, ${who}.`
          : who !== null
            ? `Welcome, ${who}.`
            : org !== null
              ? `Welcome to ${org}.`
              : `Welcome.`;
      lines.push(lead);
      if (role !== null) lines.push(`You are joining as ${role}.`);
      if (start !== null) lines.push(`Your first day is ${start}.`);
      if (manager !== null) {
        lines.push(`Your manager is ${manager}. Reach out to them if anything in this guide is unclear.`);
      }
      return Object.freeze({
        id: "welcome",
        heading: "Welcome",
        body: lines.join(" "),
        assetRefs: Object.freeze([]),
        requiredByTemplate: true,
        bucket,
      });
    }
    case "pre-start": {
      if (ctx.preStartItems.length === 0) return null;
      return Object.freeze({
        id: "pre-start",
        heading: "Before your first day",
        body: "",
        assetRefs: Object.freeze([]),
        requiredByTemplate: true,
        bucket,
      });
    }
    case "day-one": {
      if (ctx.dayOneItems.length === 0) return null;
      return Object.freeze({
        id: "day-one",
        heading: "Your first day",
        body: "",
        assetRefs: Object.freeze([]),
        requiredByTemplate: true,
        bucket,
      });
    }
    case "first-week": {
      if (ctx.firstWeekItems.length === 0) return null;
      return Object.freeze({
        id: "first-week",
        heading: "Your first week",
        body: "",
        assetRefs: Object.freeze([]),
        requiredByTemplate: true,
        bucket,
      });
    }
    case "day-30": {
      if (ctx.day30Prose.length === 0) return null;
      return Object.freeze({
        id: "day-30",
        heading: "Your first 30 days",
        body: ctx.day30Prose.join("\n\n"),
        assetRefs: Object.freeze([]),
        requiredByTemplate: true,
        bucket,
      });
    }
    case "acknowledgements": {
      if (ctx.acknowledgement === null) return null;
      return Object.freeze({
        id: "acknowledgements",
        heading: "Acknowledgements",
        body: ctx.acknowledgement,
        assetRefs: Object.freeze([]),
        requiredByTemplate: false,
        bucket,
      });
    }
    default:
      return null;
  }
}

/**
 * The onboarding starter carries the checklist items out-of-band (as a
 * section body that renders as a bullet list). Since `GuideSection.body` is
 * a single string, checklist sections render their items as one bullet per
 * line. This helper recovers the bullet list from a checklist section body
 * so `renderOnboardingMarkdown` can re-emit it as Markdown bullets.
 */
export function checklistItemsFor(
  guide: OnboardingGuide,
  bucket: OnboardingGuideSection["bucket"],
): readonly string[] {
  const section = guide.sections.find((s) => s.bucket === bucket);
  if (section === undefined) return [];
  return extractBullets(section.body);
}

function extractBullets(body: string): string[] {
  // Checklist sections store items one per line with no marker; this helper
  // is defensive for two cases: (a) bodies that carry a plain newline list,
  // and (b) bodies already prefixed with `- `. Only (a) is expected from
  // the starter, but tolerating (b) avoids re-prefixing during round-trips.
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/u, "").trim())
    .filter((line) => line.length > 0);
}

function sectionIdToBucket(
  sectionId: string,
): OnboardingGuideSection["bucket"] | null {
  switch (sectionId) {
    case "welcome":
    case "pre-start":
    case "day-one":
    case "first-week":
    case "day-30":
    case "acknowledgements":
      return sectionId;
    default:
      return null;
  }
}

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

function describeStep(step: PlanStep): string | null {
  const name = step.target !== null && step.target.name.trim().length > 0
    ? step.target.name.trim()
    : null;
  const value = typeof step.value === "string" && step.value.trim().length > 0
    ? step.value.trim()
    : null;
  switch (step.action) {
    case "click":
      return name !== null ? `Click ${name}.` : null;
    case "type":
      return name !== null
        ? value !== null
          ? `Enter ${value} in ${name}.`
          : `Complete ${name}.`
        : null;
    case "select":
      return name !== null
        ? value !== null
          ? `Choose ${value} from ${name}.`
          : `Choose from ${name}.`
        : null;
    case "navigate":
      return value !== null ? `Open ${value}.` : null;
    case "scroll":
      return null;
    default:
      return name !== null ? `Interact with ${name}.` : null;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
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

function pruneStrings(values: readonly string[]): string[] {
  return uniqueStrings(values);
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "onboarding"
  );
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
  resolveOnboardingTemplate,
  validateFacts,
  buildSection,
  extractBullets,
  sectionIdToBucket,
  describeStep,
  slugify,
  uniqueStrings,
});
