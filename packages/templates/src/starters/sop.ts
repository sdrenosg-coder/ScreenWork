/**
 * Zipy AI — templates: SOP starter (templates batch 1).
 *
 * The SOP starter is the entry point the workspace calls when a user picks
 * "Standard operating procedure" from the template picker. It:
 *
 *   1. Resolves the `sop-standard@1` template from the catalogue.
 *   2. Delegates the actual document composition to
 *      `@zipy/content/longform/sop` (`composeSop`), which is the single
 *      source of truth for SOP shape and gap rules.
 *   3. Adopts the composed SOP into the templates module's `GuideSection`
 *      shape so an SOP-composed guide can participate in inheritance and
 *      the workspace's template registry without a schema mismatch.
 *
 * This file deliberately contains almost no prose composition logic, so
 * that a change to SOP rules only has to happen in
 * `packages/content/src/longform/sop.ts`. The starter is the adapter layer:
 * it validates the caller's inputs, invokes `composeSop`, converts the
 * `Sop` output into `GuideSection[]` keyed by the template's section ids,
 * and surfaces the SOP's own gap list alongside any template-side gaps.
 *
 * Every organisational fact (procedure owner, approver roles) is
 * caller-supplied. The starter never invents an owner, an approver, a
 * regulatory obligation or a rollback instruction.
 */

import {
  composeSop,
  renderSopMarkdown,
  buildSopDirectives,
  type Sop,
  type SopInputs,
  type SopRole,
  type SopGap,
} from "@zipy/content/longform/sop";
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

export type SopStarterErrorCode =
  | "invalid-input"
  | "no-goal"
  | "unknown-template"
  | "unknown-section";

export class SopStarterError extends Error {
  readonly code: SopStarterErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SopStarterErrorCode,
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

export const SOP_STARTER_TEMPLATE_ID = "sop-standard@1";

/**
 * A starter-side gap that is not part of the content-side `SopGap` union:
 * the starter records template-level problems (a template that omits a
 * section the SOP composer produced, or an SOP section that has no
 * corresponding template section).
 */
export interface SopStarterGap {
  readonly source: "starter" | "sop" | "template";
  readonly templateSectionId: string | null;
  readonly detail: string;
  /** The SOP gap when `source === "sop"`, for reviewer triage. */
  readonly sopGap?: SopGap;
}

/**
 * The composed guide. Its `sections` are `GuideSection`-shaped so
 * inheritance and the workspace registry see a uniform shape.
 */
export interface SopStarterGuide {
  readonly version: "sop-starter/1";
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  readonly templateId: string;
  /** The `Sop` document the adapter adopted. Kept for re-render and export. */
  readonly sop: Sop;
  /** Sections keyed by the template's section order. */
  readonly sections: readonly GuideSection[];
  readonly gaps: readonly SopStarterGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface SopStarterInputs {
  readonly plan: Plan;
  /** The workspace's procedure owner (a role name). */
  readonly procedureOwner: string | null;
  /** Roles that execute or approve. */
  readonly roles?: readonly SopRole[];
  /** Scope sentences. */
  readonly scope?: readonly string[];
  /** Prerequisites. */
  readonly prerequisites?: readonly string[];
  /** Per-step copy from the core writing layers, forwarded to `composeSop`. */
  readonly stepText?: SopInputs["stepText"];
  /** Per-step review classification, forwarded to `composeSop`. */
  readonly review?: SopInputs["review"];
  readonly screenshotsByStepId?: SopInputs["screenshotsByStepId"];
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly registry?: TemplateRegistry;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildSopFromStarter(inputs: SopStarterInputs): SopStarterGuide {
  if (inputs === null || typeof inputs !== "object") {
    throw new SopStarterError("buildSopFromStarter requires an inputs object.", "invalid-input");
  }
  if (inputs.plan === null || typeof inputs.plan !== "object") {
    throw new SopStarterError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (inputs.plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new SopStarterError("The plan does not expose a goal.", "no-goal");
  }

  const template = resolveSopTemplate(inputs.registry);

  // Merge the caller-supplied roles with the procedure owner so a caller
  // that only names the owner still ends up with that role in the SOP.
  const roles = mergeRoles(inputs.procedureOwner, inputs.roles ?? []);

  const sop = composeSop({
    plan: inputs.plan,
    title: inputs.title ?? null,
    summary: inputs.summary ?? null,
    slug: null,
    roles,
    scope: inputs.scope,
    prerequisites: inputs.prerequisites,
    stepText: inputs.stepText,
    review: inputs.review,
    screenshotsByStepId: inputs.screenshotsByStepId,
  });

  const gaps: SopStarterGap[] = [];
  if (inputs.procedureOwner === null || inputs.procedureOwner.trim().length === 0) {
    gaps.push({
      source: "starter",
      templateSectionId: "roles",
      detail:
        "No procedure owner was supplied; the SOP cannot state which role owns the procedure.",
    });
  }
  for (const sopGap of sop.gaps) {
    gaps.push({
      source: "sop",
      templateSectionId: sopGapSectionId(sopGap),
      detail: sopGap.detail,
      sopGap,
    });
  }

  const sections = adoptSopIntoGuideSections(sop, template, gaps);

  return {
    version: "sop-starter/1",
    title: sop.title,
    summary: sop.summary,
    slug: sop.slug,
    templateId: template.id,
    sop,
    sections,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Re-exports the content-side SOP markdown renderer so callers of the
 * starter do not need a second import. Kept as a thin wrapper so any
 * starter-specific decoration lands here in one place.
 */
export function renderSopStarterMarkdown(guide: SopStarterGuide): string {
  return renderSopMarkdown(guide.sop);
}

/** Re-export of the SOP composer's directive text for LLM callers. */
export function buildSopStarterDirectives(): string {
  return buildSopDirectives();
}

/**
 * Convert a composed SOP into the `GuideSection[]` shape the templates
 * module expects. A `sections` entry is produced for every template section
 * whose SOP source is present; either the SOP produced no content for a
 * template section (a gap is recorded) or it produced a section that has no
 * template counterpart (also a gap).
 */
export function adoptSopIntoGuideSections(
  sop: Sop,
  template: Template,
  gaps: SopStarterGap[],
): readonly GuideSection[] {
  const templateSectionIds = new Set(template.sections.map((s) => s.id));
  const sopsSections = sopSourceIds();
  const out: GuideSection[] = [];
  const byId = new Map<string, GuideSection>();

  // Roles
  if (sop.roles.length > 0) {
    byId.set(
      "roles",
      freezeGuideSection({
        id: "roles",
        heading: "Roles",
        body: renderRolesAsProse(sop.roles),
        assetRefs: Object.freeze([]),
        requiredByTemplate: requiredFor(template, "roles"),
      }),
    );
  } else {
    gaps.push({
      source: "template",
      templateSectionId: "roles",
      detail:
        "Template `sop-standard@1` declares a required Roles section but the composed SOP has no roles.",
    });
  }

  // Scope
  byId.set(
    "scope",
    freezeGuideSection({
      id: "scope",
      heading: sop.scope.heading,
      body: sop.scope.paragraphs.join("\n\n"),
      assetRefs: Object.freeze([]),
      requiredByTemplate: requiredFor(template, "scope"),
    }),
  );

  // Prerequisites
  byId.set(
    "prerequisites",
    freezeGuideSection({
      id: "prerequisites",
      heading: sop.prerequisites.heading,
      body: renderBulletBody(sop.prerequisites.listItems ?? []),
      assetRefs: Object.freeze([]),
      requiredByTemplate: requiredFor(template, "prerequisites"),
    }),
  );

  // Procedure (steps)
  byId.set(
    "procedure",
    freezeGuideSection({
      id: "procedure",
      heading: "Procedure",
      body: renderProcedureAsProse(sop),
      assetRefs: Object.freeze(
        sop.steps.flatMap((s) => s.screenshotAssets).slice(),
      ),
      requiredByTemplate: requiredFor(template, "procedure"),
    }),
  );

  // Approvals (only when present)
  if (sop.approvals.length > 0) {
    byId.set(
      "approvals",
      freezeGuideSection({
        id: "approvals",
        heading: "Approvals",
        body: renderApprovalsAsProse(sop),
        assetRefs: Object.freeze([]),
        requiredByTemplate: requiredFor(template, "approvals"),
      }),
    );
  }

  // Rollback summary (only when present)
  if (sop.rollbackSummary.length > 0) {
    byId.set(
      "rollback-summary",
      freezeGuideSection({
        id: "rollback-summary",
        heading: "Rollback summary",
        body: renderBulletBody(sop.rollbackSummary),
        assetRefs: Object.freeze([]),
        requiredByTemplate: requiredFor(template, "rollback-summary"),
      }),
    );
  }

  // Missing template sections that the SOP did not produce.
  for (const templateSection of template.sections) {
    if (!byId.has(templateSection.id)) {
      if (templateSection.required) {
        gaps.push({
          source: "template",
          templateSectionId: templateSection.id,
          detail: `Template section "${templateSection.id}" is required but the composed SOP produced no content for it.`,
        });
      }
      continue;
    }
    if (!sopsSections.has(templateSection.id)) {
      // Covered above by byId.has(...) — kept for clarity but the set is
      // informational and never used as a source of gaps.
    }
  }

  // Emit in template order; sections the template does not declare but the
  // SOP produced are appended after (this is not an error — the
  // `sop-standard@1` template may gain sections while a composed SOP keeps
  // legacy ones).
  for (const templateSection of template.sections) {
    const section = byId.get(templateSection.id);
    if (section !== undefined) out.push(section);
  }
  for (const [id, section] of byId.entries()) {
    if (!templateSectionIds.has(id)) {
      out.push(section);
      gaps.push({
        source: "starter",
        templateSectionId: id,
        detail: `Composed SOP produced section "${id}" which template "${template.id}" does not declare.`,
      });
    }
  }

  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function resolveSopTemplate(registry?: TemplateRegistry): Template {
  try {
    return getTemplate(SOP_STARTER_TEMPLATE_ID, registry);
  } catch (err) {
    throw new SopStarterError(
      `SOP template "${SOP_STARTER_TEMPLATE_ID}" is not in the template catalogue.`,
      "unknown-template",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

function mergeRoles(
  owner: string | null,
  roles: readonly SopRole[],
): readonly SopRole[] {
  const seen = new Set<string>();
  const out: SopRole[] = [];
  const push = (r: SopRole): void => {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (name.length === 0) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const responsibilities = (r.responsibilities ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out.push(
      responsibilities.length > 0 ? { name, responsibilities } : { name },
    );
  };
  if (typeof owner === "string" && owner.trim().length > 0) {
    push({ name: owner.trim(), responsibilities: ["Owns the procedure"] });
  }
  for (const r of roles) push(r);
  return Object.freeze(out);
}

function sopGapSectionId(gap: SopGap): string | null {
  switch (gap.reason) {
    case "no-roles":
      return "roles";
    case "no-plan-steps":
      return "procedure";
    case "no-rollback-for-mutating-step":
      return "rollback-summary";
    case "no-prerequisites":
      return "prerequisites";
    case "no-scope":
      return "scope";
    default:
      return null;
  }
}

function renderRolesAsProse(roles: readonly SopRole[]): string {
  return roles
    .map((r) => {
      const responsibilities = (r.responsibilities ?? []).filter(
        (s) => s.length > 0,
      );
      return responsibilities.length > 0
        ? `${r.name} — ${responsibilities.join("; ")}`
        : r.name;
    })
    .join("\n");
}

function renderProcedureAsProse(sop: Sop): string {
  const lines: string[] = [];
  for (const step of sop.steps) {
    const tags: string[] = [];
    if (step.kind === "mutating") tags.push("mutating");
    if (step.checkpoint) tags.push("checkpoint");
    const suffix = tags.length > 0 ? ` _(${tags.join(", ")})_` : "";
    lines.push(`### ${step.number}. ${step.title}${suffix}`);
    lines.push("");
    lines.push(step.body);
    if (step.rollback !== null) {
      lines.push("");
      lines.push(`> Rollback: ${step.rollback}`);
    } else if (step.kind === "mutating") {
      lines.push("");
      lines.push("> Rollback: not specified — reviewer action required.");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderApprovalsAsProse(sop: Sop): string {
  return sop.approvals.map((a) => `Step ${a.step} — ${a.role}`).join("\n");
}

function renderBulletBody(items: readonly string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
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

/**
 * The section ids the SOP composer can produce. Used only to document the
 * mapping; the actual adoption is driven by the template's declared ids so
 * this stays in sync when the SOP composer adds a section.
 */
function sopSourceIds(): ReadonlySet<string> {
  return new Set(["roles", "scope", "prerequisites", "procedure", "approvals", "rollback-summary"]);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  resolveSopTemplate,
  mergeRoles,
  sopGapSectionId,
  renderRolesAsProse,
  renderProcedureAsProse,
  renderApprovalsAsProse,
  renderBulletBody,
  requiredFor,
  freezeGuideSection,
  sopSourceIds,
});
