/**
 * Zipy AI — templates: spec-to-tutorial starter (templates batch 3, phase 17).
 *
 * The spec-to-tutorial starter converts a product specification (a PRD,
 * an RFC, an API contract, a Jira epic description, an OpenAPI document)
 * into a modern, image-only tutorial. It is the entry point the workspace
 * calls when a user drops a specification into Zipy and asks for a
 * tutorial.
 *
 * A specification is structurally different from a legacy document and
 * from a workflow plan:
 *
 *   - A spec describes *requirements* in the abstract register
 *     ("the system SHALL expose an endpoint that ..."). It does not
 *     describe a click path.
 *   - A spec may reference UI surfaces that do not yet exist (a
 *     "to-be-built" screen), so a tutorial derived from it must
 *     distinguish "the target of this step is a proposed screen" from
 *     "the target of this step exists today and was captured live".
 *   - A spec carries *acceptance criteria* per requirement. Those
 *     criteria are the natural source for the tutorial's verification
 *     steps and its "you will know this worked when..." notes.
 *
 * The starter therefore does five things, in order:
 *
 *   1. It requires the caller to supply a *plan* produced from the spec
 *      by the synthesis phase (`@zipy/synth/stepSequence`). The starter
 *      does not call the LLM and does not synthesize a plan. It refuses
 *      to run without a plan that has at least one step.
 *
 *   2. It consumes the spec's canonical items (the processing phase's
 *      output) to derive per-step *acceptance evidence* and *terminology*
 *      — never to invent a step. When the spec's canonical items carry a
 *      `requirement` annotation for a step's synthesis ref, the starter
 *      attaches that requirement's acceptance criteria to the tutorial
 *      step as a verification block.
 *
 *   3. It requires every step to be marked as either `proposed` (the
 *      screen does not exist yet; the tutorial ships with a placeholder
 *      image slot and a gap) or `captured` (a fresh screenshot asset id
 *      supplied by the caller, produced by the automation phase when the
 *      screen exists). A step that is neither is recorded as a gap and,
 *      unless the caller opts into `allowProposedScreens`, the starter
 *      refuses to compose the tutorial.
 *
 *   4. It adopts the composed tutorial into the templates module's
 *      `GuideSection` shape so the result participates in inheritance
 *      and the workspace registry.
 *
 *   5. It never fabricates a screenshot asset id, a requirement id, an
 *      acceptance criterion, a captured-at timestamp or a spec version.
 *      Missing facts are recorded as gaps and the caller decides how to
 *      resolve them.
 *
 * Output shape is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

import {
  getTemplate,
  type Template,
  type TemplateRegistry,
} from "../library.js";
import type { GuideSection, InheritanceGap } from "../inheritance.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SpecToTutorialErrorCode =
  | "invalid-input"
  | "no-plan"
  | "no-goal"
  | "no-steps"
  | "unacknowledged-proposed-screens"
  | "duplicate-step-result"
  | "unknown-template";

export class SpecToTutorialError extends Error {
  readonly code: SpecToTutorialErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SpecToTutorialErrorCode,
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

/** The tutorial follows the KB template shape by default. */
export const SPEC_TO_TUTORIAL_STARTER_TEMPLATE_ID = "kb-standard@1";

/** How a step's target screen is treated. */
export const STEP_SCREEN_STATES = ["proposed", "captured"] as const;
export type StepScreenState = (typeof STEP_SCREEN_STATES)[number];

/**
 * One acceptance criterion the caller has attached to a requirement id.
 * The starter never invents an id or a criterion body; the caller supplies
 * both, plus an optional verbatim quote from the source spec that the
 * reviewer can cross-check.
 */
export interface AcceptanceCriterion {
  readonly id: string;
  readonly body: string;
  /** Optional verbatim quote from the spec that substantiates this criterion. */
  readonly sourceQuote: string | null;
}

/**
 * A requirement extracted from the specification. The reader may draw this
 * from the processing phase's canonical items; the starter accepts it as
 * an explicit input so no canonical-item shape is assumed beyond what the
 * caller passes.
 */
export interface SpecRequirement {
  readonly id: string;
  /** Short requirement title, e.g. "Export customers to CSV". */
  readonly title: string;
  /** Requirements are grouped by their source section for the tutorial TOC. */
  readonly section: string | null;
  readonly criteria: readonly AcceptanceCriterion[];
  /**
   * The step ids in the plan that implement this requirement. The starter
   * uses these to attach the requirement's acceptance criteria to the
   * corresponding tutorial steps. A requirement that maps to no step
   * produces a gap and is dropped from the per-step verification blocks
   * (it stays in the "Coverage" section).
   */
  readonly planStepIds: readonly string[];
}

/**
 * The caller's per-step classification *and* (when captured) the screenshot
 * asset id. The starter requires one entry per plan step; a missing entry
 * produces a gap and (unless the caller opts in) blocks composition.
 */
export interface StepScreenInfo {
  readonly stepId: string;
  readonly state: StepScreenState;
  /**
   * When `state === "captured"`, the asset id of the fresh screenshot. When
   * `state === "proposed"`, must be null; the starter never invents one.
   */
  readonly screenshotAssetId: string | null;
  /** Optional ISO timestamp the screenshot was captured at. */
  readonly capturedAt?: string | null;
}

export interface SpecToTutorialInputs {
  readonly plan: Plan;
  /**
   * One or more requirements drawn from the specification. Requirements
   * drive the tutorial's verification blocks and coverage section. Empty
   * is accepted but produces an explicit gap.
   */
  readonly requirements: readonly SpecRequirement[];
  /**
   * Per-step screen classification. Every plan step must appear exactly
   * once; duplicates raise `duplicate-step-result`.
   */
  readonly stepScreens: readonly StepScreenInfo[];
  /**
   * Optional spec metadata the caller has supplied. The starter never
   * invents these values. Missing values become gaps.
   */
  readonly specMeta?: Partial<SpecMeta>;
  /** Title override. Falls back to the plan goal. */
  readonly title?: string | null;
  /** Summary override. */
  readonly summary?: string | null;
  /** Introduction override. */
  readonly introduction?: string | null;
  /** Caller-authored prerequisites; never invented. */
  readonly prerequisites?: readonly string[];
  /**
   * Explicit acknowledgement that tutorial steps targeting proposed
   * (not-yet-built) screens may be composed. Without this, the starter
   * refuses to compose when any step is `proposed`.
   */
  readonly allowProposedScreens?: boolean;
  /**
   * Optional per-step justification for a proposed screen, keyed by step
   * id. Required for every proposed step when `allowProposedScreens` is
   * true so the audit trail explains why a proposed target is acceptable.
   */
  readonly proposedJustification?: Readonly<Record<string, string>>;
  /** Optional workspace template registry that may shadow the builtin. */
  readonly registry?: TemplateRegistry;
}

export interface SpecMeta {
  /** A human identifier for the spec, e.g. "PRD-1421". Not invented. */
  readonly specId: string;
  /** A version string, e.g. "v3". Not invented. */
  readonly version: string;
  /** A title from the spec document itself. */
  readonly documentTitle: string;
  /** Caller-supplied author or owning team. */
  readonly owner: string | null;
}

export interface SpecToTutorialGap {
  readonly stepId: string | null;
  readonly requirementId: string | null;
  readonly reason:
    | "missing-step-screen-info"
    | "proposed-screen-unacknowledged"
    | "proposed-screen-without-justification"
    | "proposed-screen-with-screenshot"
    | "requirement-not-mapped-to-step"
    | "no-requirements"
    | "missing-spec-id"
    | "missing-spec-version"
    | "missing-document-title"
    | "step-has-no-plan-step"
    | "duplicate-step-screen-info";
  readonly detail: string;
}

export interface SpecToTutorialGuideSection extends GuideSection {
  readonly bucket:
    | "summary"
    | "introduction"
    | "prerequisites"
    | "steps"
    | "coverage"
    | "glossary";
}

export interface SpecToTutorialGuide {
  readonly version: "spec-to-tutorial/1";
  readonly title: string;
  readonly summary: string;
  readonly introduction: string;
  readonly slug: string;
  readonly templateId: string;
  readonly specMeta: SpecMeta;
  readonly plan: Plan;
  readonly requirements: readonly SpecRequirement[];
  readonly stepScreens: readonly StepScreenInfo[];
  readonly sections: readonly SpecToTutorialGuideSection[];
  readonly gaps: readonly SpecToTutorialGap[];
  /** True when the caller explicitly accepted proposed (not-yet-built) screens. */
  readonly acceptedProposedScreens: boolean;
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildSpecToTutorial(
  inputs: SpecToTutorialInputs,
): SpecToTutorialGuide {
  if (inputs === null || typeof inputs !== "object") {
    throw new SpecToTutorialError(
      "buildSpecToTutorial requires an inputs object.",
      "invalid-input",
    );
  }
  if (inputs.plan === null || typeof inputs.plan !== "object") {
    throw new SpecToTutorialError(
      "A plan (produced by the synthesis phase) is required.",
      "no-plan",
    );
  }
  const goalRaw = (inputs.plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new SpecToTutorialError(
      "The plan does not expose a goal.",
      "no-goal",
    );
  }
  const goal = goalRaw.trim();

  const template = resolveSpecTemplate(inputs.registry);
  const gaps: SpecToTutorialGap[] = [];

  // 1. Requirements (may be empty — an explicit gap, not a throw).
  const requirements = sanitizeRequirements(inputs.requirements ?? [], gaps);
  if (requirements.length === 0) {
    gaps.push({
      stepId: null,
      requirementId: null,
      reason: "no-requirements",
      detail:
        "No requirements were supplied from the specification; the tutorial has no verification blocks.",
    });
  }

  // 2. Spec metadata.
  const specMeta = validateSpecMeta(inputs.specMeta ?? {}, gaps);

  // 3. Index the plan steps.
  const steps = readPlanSteps(inputs.plan);
  if (steps.length === 0) {
    throw new SpecToTutorialError(
      "The plan contains no steps; a tutorial cannot be composed from it.",
      "no-steps",
    );
  }

  // 4. Per-step screen classification. Every plan step must appear exactly
  //    once; duplicated entries raise because a duplicate would silently
  //    pick one classification over another.
  const stepIndex = new Map<string, { id: string; index: number; planStep: PlanStep }>();
  for (const s of steps) stepIndex.set(s.id, s);

  const screenByStepId = new Map<string, StepScreenInfo>();
  for (const info of inputs.stepScreens ?? []) {
    if (info === null || typeof info !== "object") continue;
    const stepId = typeof info.stepId === "string" ? info.stepId.trim() : "";
    if (stepId.length === 0) continue;
    if (screenByStepId.has(stepId)) {
      gaps.push({
        stepId,
        requirementId: null,
        reason: "duplicate-step-screen-info",
        detail: `Step "${stepId}" received two screen classifications; composition refused.`,
      });
      throw new SpecToTutorialError(
        `Step "${stepId}" received two screen classifications.`,
        "duplicate-step-result",
        { stepId },
      );
    }
    const state: StepScreenState =
      info.state === "captured" ? "captured" : "proposed";
    const assetId =
      typeof info.screenshotAssetId === "string" &&
      info.screenshotAssetId.trim().length > 0
        ? info.screenshotAssetId.trim()
        : null;
    const capturedAt =
      typeof info.capturedAt === "string" && info.capturedAt.trim().length > 0
        ? info.capturedAt.trim()
        : null;

    if (state === "proposed" && assetId !== null) {
      gaps.push({
        stepId,
        requirementId: null,
        reason: "proposed-screen-with-screenshot",
        detail: `Step "${stepId}" is classified proposed but carries a screenshot asset id; the asset id was dropped.`,
      });
    }
    if (state === "captured" && assetId === null) {
      gaps.push({
        stepId,
        requirementId: null,
        reason: "missing-step-screen-info",
        detail: `Step "${stepId}" is classified captured but no screenshot asset id was supplied.`,
      });
    }
    screenByStepId.set(
      stepId,
      Object.freeze({
        stepId,
        state,
        screenshotAssetId: state === "captured" ? assetId : null,
        capturedAt: state === "captured" ? capturedAt : null,
      }),
    );
  }

  // Any plan step without a screen entry is a gap and (unless the caller
  // opted into proposed screens) blocks composition.
  const missingScreens: string[] = [];
  const proposedMissing: string[] = [];
  for (const s of steps) {
    if (!screenByStepId.has(s.id)) {
      gaps.push({
        stepId: s.id,
        requirementId: null,
        reason: "missing-step-screen-info",
        detail: `Step "${s.id}" (index ${s.index}) has no screen classification.`,
      });
      missingScreens.push(s.id);
      proposedMissing.push(s.id);
    }
  }

  // Proposed screens require the caller's acknowledgement *and* a per-step
  // justification. Refuse when either is absent so nothing is silently
  // shipped against a not-yet-built target.
  const proposedSteps = steps.filter(
    (s) => screenByStepId.get(s.id)?.state === "proposed",
  );
  const allProposedStepIds = [...new Set([...proposedSteps.map((s) => s.id), ...proposedMissing])];
  if (allProposedStepIds.length > 0 && inputs.allowProposedScreens !== true) {
    for (const id of allProposedStepIds) {
      gaps.push({
        stepId: id,
        requirementId: null,
        reason: "proposed-screen-unacknowledged",
        detail: `Step "${id}" targets a proposed screen; carry-forward was not acknowledged.`,
      });
    }
    throw new SpecToTutorialError(
      `Tutorial composition refused: ${allProposedStepIds.length} step(s) target proposed (not-yet-built) screens and carry-forward was not acknowledged. Supply allowProposedScreens=true with a per-step justification to proceed.`,
      "unacknowledged-proposed-screens",
      { stepIds: allProposedStepIds },
    );
  }
  if (allProposedStepIds.length > 0) {
    for (const id of allProposedStepIds) {
      const just = inputs.proposedJustification?.[id];
      if (typeof just !== "string" || just.trim().length === 0) {
        gaps.push({
          stepId: id,
          requirementId: null,
          reason: "proposed-screen-without-justification",
          detail: `Step "${id}" targets a proposed screen and has no justification entry.`,
        });
      }
    }
  }

  // 5. Attach requirements to steps. Requirement → step mapping is by
  //    planStepIds; a requirement with no matching step is a gap and is
  //    kept only in the coverage section.
  const requirementByStepId = new Map<string, SpecRequirement[]>();
  for (const req of requirements) {
    let mapped = false;
    for (const stepId of req.planStepIds) {
      if (!stepIndex.has(stepId)) continue;
      mapped = true;
      const list = requirementByStepId.get(stepId) ?? [];
      list.push(req);
      requirementByStepId.set(stepId, list);
    }
    if (!mapped) {
      gaps.push({
        stepId: null,
        requirementId: req.id,
        reason: "requirement-not-mapped-to-step",
        detail: `Requirement "${req.id}" (${req.title}) is not mapped to any plan step; it appears only in Coverage.`,
      });
    }
  }

  // 6. Titles / slugs.
  const title =
    nonEmpty(inputs.title) ??
    (specMeta.documentTitle !== null
      ? `${specMeta.documentTitle} — tutorial`
      : `Tutorial: ${goal}`);
  const summary =
    nonEmpty(inputs.summary) ??
    buildDefaultSummary(specMeta, goal, requirements.length);
  const introduction =
    nonEmpty(inputs.introduction) ??
    buildDefaultIntroduction(specMeta, goal, steps.length, requirements.length);
  const slug = slugify(
    specMeta.specId !== null
      ? `tutorial-${specMeta.specId}`
      : `tutorial-${goal}`,
  );

  const prerequisites = pruneStrings(inputs.prerequisites ?? []);

  // 7. Compose sections in the template's declared order. The KB template
  //    is used as the structural skeleton; a "coverage" section is added
  //    for spec-derived requirements. A template that declares none of
  //    the spec-specific buckets still receives the tutorial's standard
  //    structure because the fallback includes all six buckets.
  const buckets = bucketOrderForTemplate(template);
  const sections: SpecToTutorialGuideSection[] = [];
  for (const bucket of buckets) {
    const section = buildSection(bucket, {
      title,
      summary,
      introduction,
      prerequisites,
      steps,
      screenByStepId,
      requirementByStepId,
      requirements,
      specMeta,
    });
    if (section !== null) sections.push(section);
  }

  return {
    version: "spec-to-tutorial/1",
    title,
    summary,
    introduction,
    slug,
    templateId: template.id,
    specMeta: {
      specId: specMeta.specId ?? "",
      version: specMeta.version ?? "",
      documentTitle: specMeta.documentTitle ?? "",
      owner: specMeta.owner,
    },
    plan: inputs.plan,
    requirements: Object.freeze(requirements),
    stepScreens: Object.freeze(Array.from(screenByStepId.values())),
    sections: Object.freeze(sections),
    gaps: Object.freeze(gaps),
    acceptedProposedScreens:
      allProposedStepIds.length > 0 && inputs.allowProposedScreens === true,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Markdown renderer for the spec-to-tutorial guide. Kept close to the
 * KB renderer's shape so the export layer can reuse its per-section
 * dispatch; the coverage section renders a table of requirement →
 * covered-by-step and a list of acceptance criteria.
 */
export function renderSpecToTutorialMarkdown(
  guide: SpecToTutorialGuide,
): string {
  const parts: string[] = [];
  parts.push(`# ${guide.title}`);
  parts.push("");
  if (guide.specMeta.specId.length > 0 || guide.specMeta.version.length > 0) {
    const bits: string[] = [];
    if (guide.specMeta.specId.length > 0) bits.push(`**Spec:** ${guide.specMeta.specId}`);
    if (guide.specMeta.version.length > 0) bits.push(`**Version:** ${guide.specMeta.version}`);
    if (guide.specMeta.owner !== null) bits.push(`**Owner:** ${guide.specMeta.owner}`);
    parts.push(bits.join("  \n"));
    parts.push("");
  }
  parts.push(guide.summary);
  parts.push("");
  if (guide.introduction.length > 0) {
    parts.push(guide.introduction);
    parts.push("");
  }
  if (guide.sections.some((s) => s.bucket === "prerequisites")) {
    parts.push("## Prerequisites");
    parts.push("");
    for (const p of pruneStrings(
      guide.sections
        .find((s) => s.bucket === "prerequisites")!
        .body.split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*]\s+/u, "").trim())
        .filter((line) => line.length > 0),
    )) {
      parts.push(`- ${p}`);
    }
    parts.push("");
  }
  parts.push("## Steps");
  parts.push("");
  for (const s of guide.sections) {
    if (s.bucket !== "steps") continue;
    parts.push(s.body);
    parts.push("");
  }
  if (guide.sections.some((s) => s.bucket === "coverage")) {
    parts.push("## Coverage");
    parts.push("");
    parts.push(guide.sections.find((s) => s.bucket === "coverage")!.body);
    parts.push("");
  }
  if (guide.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of guide.gaps) {
      const bits: string[] = [];
      if (gap.stepId !== null) bits.push(`step ${gap.stepId}`);
      if (gap.requirementId !== null) bits.push(`requirement ${gap.requirementId}`);
      const prefix = bits.length > 0 ? `[${bits.join(", ")}] ` : "";
      parts.push(`- ${prefix}${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildSpecToTutorialDirectives(): string {
  return [
    "You are writing an image-only tutorial from a product specification and an approved workflow plan.",
    "Every step must be covered by a fresh screenshot asset id, or marked as targeting a proposed (not-yet-built) screen. Never invent a screenshot asset id; when the screen does not exist, state it plainly.",
    "Verification blocks are drawn from the spec's acceptance criteria. Quote the criterion verbatim; do not paraphrase it into a marketing promise.",
    "Never invent a requirement id, an acceptance criterion body, a spec version, an owner name, a source quote, or a captured-at timestamp.",
    "The coverage table lists every requirement and the plan step(s) that implement it. A requirement with no step is listed as uncovered — do not silently drop it.",
    "Address the reader in the second person. Prefer imperative step bodies.",
    "Do not use the word 'simply'. Do not use marketing language. Do not promise a capability that the requirements do not name.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function resolveSpecTemplate(registry?: TemplateRegistry): Template {
  try {
    return getTemplate(SPEC_TO_TUTORIAL_STARTER_TEMPLATE_ID, registry);
  } catch (err) {
    throw new SpecToTutorialError(
      `Spec-to-tutorial target template "${SPEC_TO_TUTORIAL_STARTER_TEMPLATE_ID}" is not in the template catalogue.`,
      "unknown-template",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

function sanitizeRequirements(
  raw: readonly SpecRequirement[],
  gaps: SpecToTutorialGap[],
): SpecRequirement[] {
  const out: SpecRequirement[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const title = typeof r.title === "string" && r.title.trim().length > 0
      ? r.title.trim()
      : id;
    const section = typeof r.section === "string" && r.section.trim().length > 0
      ? r.section.trim()
      : null;
    const criteria: AcceptanceCriterion[] = [];
    if (Array.isArray(r.criteria)) {
      for (const c of r.criteria) {
        if (c === null || typeof c !== "object") continue;
        const cid = typeof c.id === "string" ? c.id.trim() : "";
        const body = typeof c.body === "string" ? c.body.trim() : "";
        if (cid.length === 0 || body.length === 0) continue;
        criteria.push(
          Object.freeze({
            id: cid,
            body,
            sourceQuote:
              typeof c.sourceQuote === "string" && c.sourceQuote.trim().length > 0
                ? c.sourceQuote.trim()
                : null,
          }),
        );
      }
    }
    const planStepIds = Array.isArray(r.planStepIds)
      ? (r.planStepIds as unknown[])
          .filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0,
          )
          .map((v) => v.trim())
      : [];
    out.push(
      Object.freeze({
        id,
        title,
        section,
        criteria: Object.freeze(criteria),
        planStepIds: Object.freeze(planStepIds),
      }),
    );
  }
  // Sort by section then id so output is deterministic.
  out.sort((a, b) => {
    const sA = a.section ?? "";
    const sB = b.section ?? "";
    if (sA !== sB) return sA < sB ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

function validateSpecMeta(
  raw: Partial<SpecMeta>,
  gaps: SpecToTutorialGap[],
): {
  specId: string | null;
  version: string | null;
  documentTitle: string | null;
  owner: string | null;
} {
  const specId = nonEmpty(raw.specId);
  const version = nonEmpty(raw.version);
  const documentTitle = nonEmpty(raw.documentTitle);
  const owner = nonEmpty(raw.owner ?? null);
  if (specId === null) {
    gaps.push({
      stepId: null,
      requirementId: null,
      reason: "missing-spec-id",
      detail: "No spec id was supplied; the tutorial header will omit it.",
    });
  }
  if (version === null) {
    gaps.push({
      stepId: null,
      requirementId: null,
      reason: "missing-spec-version",
      detail: "No spec version was supplied; the tutorial cannot state which revision it documents.",
    });
  }
  if (documentTitle === null) {
    gaps.push({
      stepId: null,
      requirementId: null,
      reason: "missing-document-title",
      detail: "No document title was supplied; the tutorial falls back to the plan goal for its title.",
    });
  }
  return { specId, version, documentTitle, owner };
}

interface IndexedStep {
  readonly id: string;
  readonly index: number;
  readonly planStep: PlanStep;
}

function readPlanSteps(plan: Plan): readonly IndexedStep[] {
  const raw = (plan as { steps?: unknown }).steps;
  if (!Array.isArray(raw)) return [];
  const out: IndexedStep[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const step = raw[i];
    if (step === null || typeof step !== "object") continue;
    const s = step as PlanStep;
    const id =
      typeof s.id === "string" && s.id.length > 0 ? s.id : `step-${i + 1}`;
    out.push({ id, index: i + 1, planStep: s });
  }
  return out;
}

/** Which buckets to emit, in order, given the resolved template. */
function bucketOrderForTemplate(
  template: Template,
): readonly SpecToTutorialGuideSection["bucket"][] {
  const known: SpecToTutorialGuideSection["bucket"][] = [
    "summary",
    "introduction",
    "prerequisites",
    "steps",
    "coverage",
    "glossary",
  ];
  const declared = new Set(template.sections.map((s) => s.id));
  const ordered: SpecToTutorialGuideSection["bucket"][] = [];
  for (const bucket of known) {
    if (
      declared.has(bucket) ||
      // The spec-to-tutorial starter always emits its structural sections
      // even when the template does not declare them; a template that
      // omits "coverage" still needs the requirement table so reviewers
      // can audit which requirements the tutorial covers. A starter gap
      // records the divergence.
      bucket === "steps" ||
      bucket === "coverage"
    ) {
      ordered.push(bucket);
    }
  }
  // Ensure summary/introduction/prerequisites are present at least when
  // the template declares them (already covered by the loop above).
  return Object.freeze(ordered);
}

interface SectionContext {
  readonly title: string;
  readonly summary: string;
  readonly introduction: string;
  readonly prerequisites: readonly string[];
  readonly steps: readonly IndexedStep[];
  readonly screenByStepId: ReadonlyMap<string, StepScreenInfo>;
  readonly requirementByStepId: ReadonlyMap<string, readonly SpecRequirement[]>;
  readonly requirements: readonly SpecRequirement[];
  readonly specMeta: {
    readonly specId: string | null;
    readonly version: string | null;
    readonly documentTitle: string | null;
    readonly owner: string | null;
  };
}

function buildSection(
  bucket: SpecToTutorialGuideSection["bucket"],
  ctx: SectionContext,
): SpecToTutorialGuideSection | null {
  switch (bucket) {
    case "summary": {
      return freezeSection({
        id: "summary",
        heading: "Summary",
        body: ctx.summary,
        assetRefs: [],
        requiredByTemplate: true,
        bucket,
      });
    }
    case "introduction": {
      if (ctx.introduction.length === 0) return null;
      return freezeSection({
        id: "introduction",
        heading: "Introduction",
        body: ctx.introduction,
        assetRefs: [],
        requiredByTemplate: false,
        bucket,
      });
    }
    case "prerequisites": {
      if (ctx.prerequisites.length === 0) return null;
      return freezeSection({
        id: "prerequisites",
        heading: "Prerequisites",
        body: ctx.prerequisites.map((p) => `- ${p}`).join("\n"),
        assetRefs: [],
        requiredByTemplate: true,
        bucket,
      });
    }
    case "steps": {
      const assetRefs: string[] = [];
      const lines: string[] = [];
      for (const step of ctx.steps) {
        lines.push(`### ${step.index}. ${describePlanStep(step.planStep)}`);
        lines.push("");
        const body = buildStepBody(step, ctx, assetRefs);
        if (body.length > 0) {
          lines.push(body);
          lines.push("");
        }
      }
      return freezeSection({
        id: "steps",
        heading: "Steps",
        body: lines.join("\n").trimEnd(),
        assetRefs,
        requiredByTemplate: true,
        bucket,
      });
    }
    case "coverage": {
      const body = buildCoverage(ctx);
      if (body.length === 0) return null;
      return freezeSection({
        id: "coverage",
        heading: "Coverage",
        body,
        assetRefs: [],
        requiredByTemplate: false,
        bucket,
      });
    }
    case "glossary": {
      // The starter does not extract a glossary itself; that is a
      // later-phase responsibility. Emit nothing rather than invent terms.
      return null;
    }
    default:
      return null;
  }
}

function buildStepBody(
  step: IndexedStep,
  ctx: SectionContext,
  assetRefs: string[],
): string {
  const parts: string[] = [];
  const screen = ctx.screenByStepId.get(step.id);

  // Compose the action line from the plan step.
  const actionLine = describeAction(step.planStep);
  if (actionLine.length > 0) {
    parts.push(actionLine);
    parts.push("");
  }

  // Screenshot.
  if (screen !== undefined && screen.state === "captured" && screen.screenshotAssetId !== null) {
    parts.push(`![Step ${step.index}](asset://${screen.screenshotAssetId})`);
    assetRefs.push(screen.screenshotAssetId);
    parts.push("");
    if (screen.capturedAt !== null && screen.capturedAt !== undefined) {
      parts.push(`_Captured ${screen.capturedAt}._`);
      parts.push("");
    }
  } else if (screen !== undefined && screen.state === "proposed") {
    parts.push(
      "_This step targets a screen that does not exist yet; the screenshot is a placeholder._",
    );
    parts.push("");
  } else {
    parts.push("_No screen classification was supplied for this step._");
    parts.push("");
  }

  // Verification block: acceptance criteria from requirements mapped to
  // this step. Emitted verbatim; the starter never paraphrases a criterion.
  const reqs = ctx.requirementByStepId.get(step.id) ?? [];
  if (reqs.length > 0) {
    const lines: string[] = [];
    for (const req of reqs) {
      lines.push(`> **Requirement ${req.id}** — ${req.title}`);
      if (req.criteria.length > 0) {
        for (const c of req.criteria) {
          const quotePart = c.sourceQuote !== null ? `  \n  > _Spec: ${c.sourceQuote}_` : "";
          lines.push(`> - ${c.body}${quotePart}`);
        }
      } else {
        lines.push("> - No acceptance criteria were supplied for this requirement.");
      }
    }
    parts.push(lines.join("\n"));
    parts.push("");
  }

  return parts.join("\n").trimEnd();
}

function buildCoverage(ctx: SectionContext): string {
  if (ctx.requirements.length === 0) return "";
  const lines: string[] = [];
  lines.push("| Requirement | Section | Covered by steps | Criteria |");
  lines.push("| --- | --- | --- | --- |");
  for (const req of ctx.requirements) {
    const coveredBy =
      req.planStepIds.length > 0
        ? req.planStepIds.join(", ")
        : "_not covered by any plan step_";
    const criteriaCount = req.criteria.length;
    lines.push(
      `| ${escapeTableCell(req.id)} — ${escapeTableCell(req.title)} | ${
        req.section !== null ? escapeTableCell(req.section) : "—"
      } | ${escapeTableCell(coveredBy)} | ${criteriaCount} |`,
    );
  }
  return lines.join("\n");
}

function describePlanStep(step: PlanStep): string {
  const name =
    step.target !== null && typeof step.target.name === "string" && step.target.name.trim().length > 0
      ? step.target.name.trim()
      : null;
  switch (step.action) {
    case "click":
      return name !== null ? `Click ${name}` : "Click the target control";
    case "type":
      return name !== null ? `Enter a value in ${name}` : "Enter the required value";
    case "select":
      return name !== null ? `Choose from ${name}` : "Choose the required option";
    case "navigate":
      return name !== null ? `Navigate to ${name}` : "Navigate to the next page";
    case "scroll":
      return "Scroll to reveal the next control";
    default:
      return name !== null ? `Interact with ${name}` : "Perform the indicated action";
  }
}

function describeAction(step: PlanStep): string {
  const value =
    typeof step.value === "string" && step.value.trim().length > 0
      ? step.value.trim()
      : null;
  switch (step.action) {
    case "click":
      return value !== null ? `Click the control and select "${value}".` : "Click the target control.";
    case "type":
      return value !== null ? `Enter \`${value}\`.` : "Enter the required value.";
    case "select":
      return value !== null ? `Select \`${value}\` from the dropdown.` : "Select the required option.";
    case "navigate":
      return value !== null ? `Open ${value}.` : "Navigate to the next page.";
    case "scroll":
      return "Scroll the page to reveal the next control.";
    default:
      return "Perform the indicated action.";
  }
}

function buildDefaultSummary(
  meta: {
    readonly specId: string | null;
    readonly version: string | null;
    readonly documentTitle: string | null;
  },
  goal: string,
  requirementCount: number,
): string {
  const parts: string[] = [];
  if (meta.documentTitle !== null) parts.push(meta.documentTitle);
  else parts.push(goal);
  if (meta.specId !== null && meta.version !== null) {
    parts.push(`(${meta.specId} ${meta.version})`);
  } else if (meta.specId !== null) {
    parts.push(`(${meta.specId})`);
  } else if (meta.version !== null) {
    parts.push(`(${meta.version})`);
  }
  parts.push(
    requirementCount > 0
      ? `Covers ${requirementCount} requirement${requirementCount === 1 ? "" : "s"} from the specification.`
      : "No requirements were supplied; the tutorial documents the workflow that the specification describes.",
  );
  return parts.join(" ");
}

function buildDefaultIntroduction(
  meta: {
    readonly specId: string | null;
    readonly version: string | null;
    readonly documentTitle: string | null;
    readonly owner: string | null;
  },
  goal: string,
  stepCount: number,
  requirementCount: number,
): string {
  const lines: string[] = [];
  const doc =
    meta.documentTitle !== null
      ? meta.documentTitle
      : meta.specId !== null
        ? `specification ${meta.specId}`
        : "the specification";
  lines.push(
    `This tutorial is derived from ${doc} and documents the workflow: ${goal}.`,
  );
  if (meta.owner !== null) {
    lines.push(`The specification is owned by ${meta.owner}.`);
  }
  lines.push(
    `It contains ${stepCount} step${stepCount === 1 ? "" : "s"}${
      requirementCount > 0
        ? ` and is verified against ${requirementCount} acceptance criterion set${requirementCount === 1 ? "" : "s"}`
        : ""
    }.`,
  );
  return lines.join(" ");
}

function escapeTableCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function freezeSection(
  s: SpecToTutorialGuideSection,
): SpecToTutorialGuideSection {
  return Object.freeze({
    id: s.id,
    heading: s.heading,
    body: s.body,
    assetRefs: Object.freeze([...s.assetRefs]),
    requiredByTemplate: s.requiredByTemplate,
    bucket: s.bucket,
  });
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

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "tutorial"
  );
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Inheritance-compat helper                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Convenience: expose the guide as a `GuideBlock` for the inheritance
 * module so a caller can register the tutorial as a parent for a child
 * guide without translating the section shape themselves.
 */
export function asGuideBlock(
  guide: SpecToTutorialGuide,
  workspaceId: string,
  parentId: string | null = null,
): {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly sections: readonly GuideSection[];
  readonly parentId: string | null;
} {
  return Object.freeze({
    id: guide.slug,
    workspaceId,
    title: guide.title,
    sections: Object.freeze(
      guide.sections.map((s) =>
        Object.freeze({
          id: s.id,
          heading: s.heading,
          body: s.body,
          assetRefs: s.assetRefs,
          requiredByTemplate: s.requiredByTemplate,
        }),
      ),
    ),
    parentId,
  });
}

/** Re-exported for callers that build a child composition around a tutorial. */
export type { InheritanceGap };

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  resolveSpecTemplate,
  sanitizeRequirements,
  validateSpecMeta,
  readPlanSteps,
  bucketOrderForTemplate,
  buildSection,
  buildStepBody,
  buildCoverage,
  describePlanStep,
  describeAction,
  buildDefaultSummary,
  buildDefaultIntroduction,
  escapeTableCell,
  freezeSection,
  slugify,
});
