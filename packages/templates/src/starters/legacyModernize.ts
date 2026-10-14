/**
 * Zipy AI — templates: legacy-doc-modernization starter (templates batch 2).
 *
 * The legacy-modernization starter converts an ingested legacy document
 * (typically a scanned PDF, a Word file, a PPTX, or a folder of
 * screenshots) into a modern, image-only guide. It is the entry point the
 * workspace calls when a user drags an old document into the modernizer.
 *
 * Modernization has three deltas relative to the other starters:
 *
 *   1. The *canonical items* (produced by the processing phase) are the
 *      input, not a workflow plan. Legacy documents do not describe
 *      workflows — they describe a process in prose. The starter takes the
 *      unified representation's canonical items and asks the LLM layer to
 *      propose a plan from them.
 *
 *   2. Legacy documents routinely contain text that no longer matches the
 *      current product. The starter requires the caller to supply a
 *      `staleness` classification for each source (`current`, `superseded`,
 *      `unknown`) and refuses to publish content derived from a source
 *      classified `superseded` without an explicit override.
 *
 *   3. Modernized screenshots replace embedded legacy images when the
 *      caller can supply fresh captures. When it cannot, the starter
 *      records a gap per step; it never invents a screenshot and it never
 *      passes a legacy screenshot through as if it were current.
 *
 * The starter does not itself run ingestion or OCR — those are the
 * processing phase's job. It consumes their canonical output. It also
 * does not call the LLM; the caller supplies a `plan` produced from the
 * canonical items (the synthesis phase's `stepSequence` output), and the
 * starter composes the modernized guide around it.
 *
 * Output shape is versioned for the export layer.
 */

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

export type LegacyModernizeErrorCode =
  | "invalid-input"
  | "no-source"
  | "no-plan"
  | "superseded-source"
  | "unknown-template";

export class LegacyModernizeError extends Error {
  readonly code: LegacyModernizeErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: LegacyModernizeErrorCode,
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

/** The modernized guide follows the KB template's shape by default. */
export const LEGACY_MODERNIZE_STARTER_TEMPLATE_ID = "kb-standard@1";

export const LEGACY_SOURCE_KINDS = [
  "pdf",
  "docx",
  "pptx",
  "image",
  "html",
  "unknown",
] as const;
export type LegacySourceKind = (typeof LEGACY_SOURCE_KINDS)[number];

export const LEGACY_SOURCE_STALENESS = [
  "current",
  "superseded",
  "unknown",
] as const;
export type LegacySourceStaleness = (typeof LEGACY_SOURCE_STALENESS)[number];

/**
 * A reference to one ingested legacy source. `artifactId` points at an
 * artifact already persisted via the storage/jobs phase; this starter never
 * loads or hashes the underlying bytes.
 */
export interface LegacySourceRef {
  readonly artifactId: string;
  readonly kind: LegacySourceKind;
  /** Original filename or URL, shown in provenance. */
  readonly label: string;
  readonly staleness: LegacySourceStaleness;
  /** Optional ISO date the caller believes this document was last current. */
  readonly lastKnownCurrent?: string | null;
  /** Canonical item ids that came from this source. Used for provenance links. */
  readonly canonicalItemIds?: readonly string[];
}

/**
 * A screenshot replacement. The starter never invents one; the caller
 * either supplies a fresh capture (produced by the automation phase) or
 * leaves the slot empty and accepts a gap.
 */
export interface ScreenshotReplacement {
  readonly stepId: string;
  readonly screenshotAssetId: string;
  /** Which legacy source (if any) this replaces. Recorded for provenance. */
  readonly replacedSourceArtifactId: string | null;
}

export interface LegacyModernizeInputs {
  /** One or more legacy sources; at least one is required. */
  readonly sources: readonly LegacySourceRef[];
  /**
   * The plan produced by the synthesis phase from the canonical items.
   * Required; the starter does not synthesize a plan itself.
   */
  readonly plan: Plan;
  /** Fresh screenshot captures keyed by step id. Optional. */
  readonly screenshotReplacements?: readonly ScreenshotReplacement[];
  /** Title override. Falls back to a derived title. */
  readonly title?: string | null;
  /**
   * Explicit acknowledgement that content from a `superseded` source is
   * being carried forward. Without this, the starter refuses to compose a
   * guide that draws on a superseded source.
   */
  readonly allowSupersededSources?: boolean;
  /** Optional per-source explanation when carrying superseded content forward. */
  readonly supersededJustification?: Readonly<Record<string, string>>;
  readonly registry?: TemplateRegistry;
}

export interface LegacyModernizeGap {
  readonly stepId: string | null;
  readonly sourceArtifactId: string | null;
  readonly reason:
    | "missing-replacement-screenshot"
    | "superseded-source-unacknowledged"
    | "unknown-source-kind"
    | "no-plan-steps"
    | "no-canonical-items";
  readonly detail: string;
}

export interface LegacySourceProvenance {
  readonly artifactId: string;
  readonly kind: LegacySourceKind;
  readonly label: string;
  readonly staleness: LegacySourceStaleness;
  readonly canonicalItemIds: readonly string[];
}

export interface LegacyModernizeGuide {
  readonly version: "legacy-modernize/1";
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  readonly templateId: string;
  readonly plan: Plan;
  readonly sources: readonly LegacySourceProvenance[];
  readonly screenshotReplacements: readonly ScreenshotReplacement[];
  readonly sections: readonly GuideSection[];
  readonly gaps: readonly LegacyModernizeGap[];
  /** True when the caller explicitly accepted superseded content. */
  readonly acceptedSupersededContent: boolean;
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildModernizedGuide(
  inputs: LegacyModernizeInputs,
): LegacyModernizeGuide {
  if (inputs === null || typeof inputs !== "object") {
    throw new LegacyModernizeError(
      "buildModernizedGuide requires an inputs object.",
      "invalid-input",
    );
  }
  if (!Array.isArray(inputs.sources) || inputs.sources.length === 0) {
    throw new LegacyModernizeError(
      "At least one legacy source is required.",
      "no-source",
    );
  }
  if (inputs.plan === null || typeof inputs.plan !== "object") {
    throw new LegacyModernizeError(
      "A plan (from the synthesis phase) is required.",
      "no-plan",
    );
  }

  const template = resolveModernizeTemplate(inputs.registry);
  const gaps: LegacyModernizeGap[] = [];

  // Validate and normalize source refs. Unknown kinds are recorded as gaps
  // but not dropped: the caller may still want them linked for provenance.
  const sources: LegacySourceProvenance[] = [];
  const superseded: LegacySourceProvenance[] = [];
  for (const src of inputs.sources) {
    if (src === null || typeof src !== "object") continue;
    const artifactId = typeof src.artifactId === "string" ? src.artifactId.trim() : "";
    if (artifactId.length === 0) continue;
    const kind = normalizeKind(src.kind, gaps);
    const staleness = normalizeStaleness(src.staleness);
    const label = typeof src.label === "string" && src.label.trim().length > 0
      ? src.label.trim()
      : artifactId;
    const canonicalItemIds = Array.isArray(src.canonicalItemIds)
      ? Object.freeze(
          src.canonicalItemIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          ),
        )
      : Object.freeze([]);
    const norm: LegacySourceProvenance = Object.freeze({
      artifactId,
      kind,
      label,
      staleness,
      canonicalItemIds,
    });
    sources.push(norm);
    if (staleness === "superseded") superseded.push(norm);
  }

  if (sources.length === 0) {
    throw new LegacyModernizeError(
      "No usable source references were supplied (every entry was missing an artifactId).",
      "no-source",
    );
  }

  if (superseded.length > 0 && inputs.allowSupersededSources !== true) {
    for (const s of superseded) {
      gaps.push({
        stepId: null,
        sourceArtifactId: s.artifactId,
        reason: "superseded-source-unacknowledged",
        detail: `Source "${s.label}" is classified superseded; carry-forward was not acknowledged.`,
      });
    }
    throw new LegacyModernizeError(
      `Guide composition refused: ${superseded.length} source(s) are classified superseded and carry-forward was not acknowledged. Supply allowSupersededSources=true to proceed, and record a justification in supersededJustification.`,
      "superseded-source",
      { supersededArtifactIds: superseded.map((s) => s.artifactId) },
    );
  }

  // Refuse an unacknowledged superseded set entry even when the flag is set:
  // a justification entry per superseded source is required so the audit
  // trail explains why the content was carried forward.
  if (superseded.length > 0) {
    for (const s of superseded) {
      const just = inputs.supersededJustification?.[s.artifactId];
      if (typeof just !== "string" || just.trim().length === 0) {
        gaps.push({
          stepId: null,
          sourceArtifactId: s.artifactId,
          reason: "superseded-source-unacknowledged",
          detail: `Source "${s.label}" is classified superseded and has no justification entry.`,
        });
      }
    }
  }

  // Determine which steps still need a fresh screenshot. The caller may
  // supply more replacements than steps; extras are kept as-is (they may
  // belong to sibling composition) but never invented.
  const replacementByStep = new Map<string, ScreenshotReplacement>();
  for (const rep of inputs.screenshotReplacements ?? []) {
    if (rep === null || typeof rep !== "object") continue;
    const stepId = typeof rep.stepId === "string" ? rep.stepId.trim() : "";
    const assetId = typeof rep.screenshotAssetId === "string"
      ? rep.screenshotAssetId.trim()
      : "";
    if (stepId.length === 0 || assetId.length === 0) continue;
    replacementByStep.set(stepId, {
      stepId,
      screenshotAssetId: assetId,
      replacedSourceArtifactId:
        typeof rep.replacedSourceArtifactId === "string"
          ? rep.replacedSourceArtifactId.trim()
          : null,
    });
  }

  const planSteps = readPlanSteps(inputs.plan);
  if (planSteps.length === 0) {
    gaps.push({
      stepId: null,
      sourceArtifactId: null,
      reason: "no-plan-steps",
      detail:
        "The supplied plan has no steps; the modernized guide's step list cannot be built.",
    });
  }
  for (const step of planSteps) {
    if (!replacementByStep.has(step.id)) {
      gaps.push({
        stepId: step.id,
        sourceArtifactId: null,
        reason: "missing-replacement-screenshot",
        detail: `Step ${step.index} has no fresh screenshot replacement; the guide will be published without an image for this step.`,
      });
    }
  }

  const planTitle = typeof (inputs.plan as { goal?: unknown }).goal === "string"
    ? String((inputs.plan as { goal: string }).goal).trim()
    : "";
  const title =
    nonEmpty(inputs.title) ??
    (planTitle.length > 0
      ? `Modernized: ${planTitle}`
      : "Modernized legacy guide");
  const summary = buildDefaultSummary(sources, superseded.length > 0);
  const slug = slugify(`modernize-${planTitle.length > 0 ? planTitle : "legacy"}`);

  const sections = buildSectionsFromPlan(
    inputs.plan,
    sources,
    replacementByStep,
    template,
  );

  return {
    version: "legacy-modernize/1",
    title,
    summary,
    slug,
    templateId: template.id,
    plan: inputs.plan,
    sources: Object.freeze(sources),
    screenshotReplacements: Object.freeze(Array.from(replacementByStep.values())),
    sections,
    gaps: Object.freeze(gaps),
    acceptedSupersededContent: superseded.length > 0 && inputs.allowSupersededSources === true,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

export function renderModernizedMarkdown(guide: LegacyModernizeGuide): string {
  const parts: string[] = [];
  parts.push(`# ${guide.title}`);
  parts.push("");
  parts.push(guide.summary);
  parts.push("");
  parts.push("## Sources");
  parts.push("");
  for (const s of guide.sources) {
    parts.push(
      `- \`${s.kind}\` **${s.label}** — staleness: ${s.staleness}; artifact: ${s.artifactId}`,
    );
  }
  parts.push("");
  for (const section of guide.sections) {
    parts.push(`## ${section.heading}`);
    parts.push("");
    if (section.body.length > 0) {
      parts.push(section.body);
      parts.push("");
    }
  }
  if (guide.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Modernization gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of guide.gaps) {
      const bits: string[] = [];
      if (gap.stepId !== null) bits.push(`step ${gap.stepId}`);
      if (gap.sourceArtifactId !== null) bits.push(`source ${gap.sourceArtifactId}`);
      const prefix = bits.length > 0 ? `[${bits.join(", ")}] ` : "";
      parts.push(`- ${prefix}${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildLegacyModernizeDirectives(): string {
  return [
    "You are modernizing a legacy document into a step-by-step image-only guide.",
    "The legacy document's own text is a source of truth only when the caller classified it as 'current'. Treat 'superseded' and 'unknown' sources as advisory: never quote them as instructions.",
    "Never rewrite a legacy screenshot into the modernized guide. When a fresh screenshot has been supplied for a step, reference it; when it has not, leave the slot empty and record a gap.",
    "Step titles and bodies are derived from the approved plan (produced by the synthesis phase), not from the legacy text. Use the legacy text only for terminology, glossary entries and subtle context the plan does not cover.",
    "Maintain a provenance record for every step: which source artifact it descends from, and whether the source was current or superseded.",
    "Do not use the word 'simply'. Do not use marketing language.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function resolveModernizeTemplate(registry?: TemplateRegistry): Template {
  try {
    return getTemplate(LEGACY_MODERNIZE_STARTER_TEMPLATE_ID, registry);
  } catch (err) {
    throw new LegacyModernizeError(
      `Modernization target template "${LEGACY_MODERNIZE_STARTER_TEMPLATE_ID}" is not in the template catalogue.`,
      "unknown-template",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

function normalizeKind(
  value: unknown,
  gaps: LegacyModernizeGap[],
): LegacySourceKind {
  if (typeof value === "string") {
    for (const k of LEGACY_SOURCE_KINDS) {
      if (k === value) return k;
    }
  }
  gaps.push({
    stepId: null,
    sourceArtifactId: null,
    reason: "unknown-source-kind",
    detail: `Source kind "${String(value)}" is not recognised; recorded as 'unknown'.`,
  });
  return "unknown";
}

function normalizeStaleness(value: unknown): LegacySourceStaleness {
  if (value === "current" || value === "superseded" || value === "unknown") {
    return value;
  }
  return "unknown";
}

interface IndexedPlanStep {
  readonly id: string;
  readonly index: number;
}

function readPlanSteps(plan: Plan): readonly IndexedPlanStep[] {
  const raw = (plan as { steps?: unknown }).steps;
  if (!Array.isArray(raw)) return [];
  const out: IndexedPlanStep[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const step = raw[i];
    if (step === null || typeof step !== "object") continue;
    const s = step as { id?: unknown };
    const id = typeof s.id === "string" && s.id.length > 0 ? s.id : `step-${i + 1}`;
    out.push({ id, index: i + 1 });
  }
  return out;
}

function buildSectionsFromPlan(
  plan: Plan,
  sources: readonly LegacySourceProvenance[],
  replacementByStep: ReadonlyMap<string, ScreenshotReplacement>,
  template: Template,
): readonly GuideSection[] {
  const out: GuideSection[] = [];
  const declaredIds = new Set(template.sections.map((s) => s.id));

  // Provenance section: which sources fed this guide.
  if (declaredIds.has("summary") || declaredIds.has("introduction")) {
    const summaryId = declaredIds.has("summary") ? "summary" : "introduction";
    out.push(
      freezeSection({
        id: summaryId,
        heading: summaryId === "summary" ? "Summary" : "Introduction",
        body: sources
          .map(
            (s) =>
              `- **${s.label}** (\`${s.kind}\`, ${s.staleness}) — ${s.artifactId}`,
          )
          .join("\n"),
        assetRefs: [],
        requiredByTemplate: requiredFor(template, summaryId),
      }),
    );
  }

  // Steps section: composed from plan steps + fresh screenshot replacements.
  const stepLines: string[] = [];
  const assetRefs: string[] = [];
  const raw = (plan as { steps?: unknown }).steps;
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 1) {
      const s = raw[i];
      if (s === null || typeof s !== "object") continue;
      const ps = s as { id?: unknown; action?: unknown; target?: unknown; value?: unknown };
      const id = typeof ps.id === "string" && ps.id.length > 0 ? ps.id : `step-${i + 1}`;
      const number = i + 1;
      const title = describeAction(ps.action, ps.target);
      stepLines.push(`### ${number}. ${title}`);
      stepLines.push("");
      const val = typeof ps.value === "string" && ps.value.trim().length > 0
        ? ps.value.trim()
        : null;
      if (val !== null) {
        stepLines.push(`Value: \`${val}\``);
        stepLines.push("");
      }
      const rep = replacementByStep.get(id);
      if (rep !== undefined) {
        stepLines.push(`![Step ${number}](asset://${rep.screenshotAssetId})`);
        assetRefs.push(rep.screenshotAssetId);
        stepLines.push("");
      } else {
        stepLines.push("_No fresh screenshot supplied for this step._");
        stepLines.push("");
      }
    }
  }

  const stepsId = declaredIds.has("steps") ? "steps" : null;
  if (stepsId !== null) {
    out.push(
      freezeSection({
        id: stepsId,
        heading: "Steps",
        body: stepLines.join("\n").trimEnd(),
        assetRefs,
        requiredByTemplate: requiredFor(template, stepsId),
      }),
    );
  }

  return Object.freeze(out);
}

function describeAction(action: unknown, target: unknown): string {
  const name =
    target !== null && typeof target === "object" && typeof (target as { name?: unknown }).name === "string"
      ? String((target as { name: string }).name).trim()
      : "";
  switch (action) {
    case "click":
      return name.length > 0 ? `Click ${name}` : "Click the target control";
    case "type":
      return name.length > 0 ? `Enter a value in ${name}` : "Enter the required value";
    case "select":
      return name.length > 0 ? `Choose from ${name}` : "Choose the required option";
    case "navigate":
      return name.length > 0 ? `Navigate to ${name}` : "Navigate to the next page";
    case "scroll":
      return "Scroll to reveal the next control";
    default:
      return name.length > 0 ? `Interact with ${name}` : "Perform the indicated action";
  }
}

function buildDefaultSummary(
  sources: readonly LegacySourceProvenance[],
  hasSuperseded: boolean,
): string {
  const labels = sources.map((s) => s.label).join(", ");
  const suffix = hasSuperseded
    ? " Some content was carried forward from superseded sources; review before publishing."
    : "";
  return `Modernized guide produced from legacy sources: ${labels}.${suffix}`;
}

function freezeSection(s: GuideSection): GuideSection {
  return Object.freeze({
    id: s.id,
    heading: s.heading,
    body: s.body,
    assetRefs: Object.freeze([...s.assetRefs]),
    requiredByTemplate: s.requiredByTemplate,
  });
}

function requiredFor(template: Template, sectionId: string): boolean {
  const section = template.sections.find((s) => s.id === sectionId);
  return section !== undefined ? section.required : false;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "modernize"
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
  resolveModernizeTemplate,
  normalizeKind,
  normalizeStaleness,
  readPlanSteps,
  buildSectionsFromPlan,
  describeAction,
  buildDefaultSummary,
  freezeSection,
  requiredFor,
  slugify,
});
