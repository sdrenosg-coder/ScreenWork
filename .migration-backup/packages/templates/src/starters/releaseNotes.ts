/**
 * Zipy AI — templates: release-notes starter (templates batch 2).
 *
 * The release-notes starter turns a workflow plan plus caller-supplied
 * release information (version, date, author, migration notes) into a
 * release-notes document following the `release-notes@1` template.
 *
 * A release note is structurally different from a KB article or an SOP:
 * it is version-anchored, its "changes" are organised into the
 * conventional Added / Changed / Removed / Fixed buckets, and it must
 * carry a version identifier and a release date in its header. The
 * starter derives the *highlights* bucket from the plan's steps (each
 * step's title becomes a highlight), and takes the remaining buckets
 * from the caller's change lists verbatim. It never invents a change log
 * entry, a version number, or a release date.
 *
 * The module carries three deliberate design rules:
 *
 *   1. The plan's steps are one source of highlights, not the whole
 *      change log. Caller-supplied change lists are additional — they
 *      are never merged into the derived highlights because the two
 *      audiences differ (steps describe what changed in the UI; change
 *      lists describe what changed in the product).
 *   2. Categories are stable and closed (`added`, `changed`, `removed`,
 *      `fixed`). A caller that passes an unknown category receives a
 *      starter gap; nothing is silently dropped.
 *   3. The header carries the version and date. If either is missing the
 *      note is still composed but a gap is recorded, and the caller's
 *      rendering layer is expected to block publication on a missing
 *      version.
 *
 * Output shape is versioned for the export layer.
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

export type ReleaseNotesErrorCode =
  | "invalid-input"
  | "no-goal"
  | "unknown-template"
  | "missing-version";

export class ReleaseNotesError extends Error {
  readonly code: ReleaseNotesErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ReleaseNotesErrorCode,
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

export const RELEASE_NOTES_STARTER_TEMPLATE_ID = "release-notes@1";

export const RELEASE_CHANGE_CATEGORIES = [
  "added",
  "changed",
  "removed",
  "fixed",
] as const;
export type ReleaseChangeCategory = (typeof RELEASE_CHANGE_CATEGORIES)[number];

export interface ReleaseNotesFacts {
  /** Semantic version string, e.g. "2024.06.1" — caller-supplied. */
  readonly version: string;
  /** ISO date string of the release. */
  readonly releaseDate: string;
  /** Author or team name shown in the header. */
  readonly author: string | null;
  /** Optional related ticket or PR URL. Never invented. */
  readonly trackingUrl: string | null;
}

export interface ReleaseChange {
  readonly category: ReleaseChangeCategory;
  /** Imperative one-line description, e.g. "Add CSV export to the customer list". */
  readonly description: string;
  /** Optional work-item reference, e.g. an issue key. */
  readonly reference: string | null;
}

export interface ReleaseNotesGuideSection extends GuideSection {
  readonly bucket:
    | "header"
    | "highlights"
    | "added"
    | "changed"
    | "removed"
    | "fixed"
    | "migration";
}

export interface ReleaseNotesGap {
  readonly bucket: ReleaseNotesGuideSection["bucket"] | null;
  readonly reason:
    | "missing-version"
    | "missing-release-date"
    | "no-highlights"
    | "no-migration-notes"
    | "unknown-category"
    | "no-plan-steps";
  readonly detail: string;
}

export interface ReleaseNotesGuide {
  readonly version: "release-notes/1";
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  readonly templateId: string;
  readonly facts: ReleaseNotesFacts;
  readonly sections: readonly ReleaseNotesGuideSection[];
  readonly gaps: readonly ReleaseNotesGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface ReleaseNotesStarterInputs {
  readonly plan: Plan;
  /** Version and date are required for a usable note; missing = gap. */
  readonly facts: Partial<ReleaseNotesFacts>;
  /** Change entries by category. Unknown categories produce gaps. */
  readonly changes?: readonly ReleaseChange[];
  /** Prose migration notes; never invented. */
  readonly migrationNotes?: readonly string[];
  /** Optional title override; falls back to a deterministic title. */
  readonly title?: string | null;
  /** Optional summary override. */
  readonly summary?: string | null;
  readonly registry?: TemplateRegistry;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildReleaseNotesGuide(
  inputs: ReleaseNotesStarterInputs,
): ReleaseNotesGuide {
  if (inputs === null || typeof inputs !== "object") {
    throw new ReleaseNotesError(
      "buildReleaseNotesGuide requires an inputs object.",
      "invalid-input",
    );
  }
  if (inputs.plan === null || typeof inputs.plan !== "object") {
    throw new ReleaseNotesError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (inputs.plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new ReleaseNotesError("The plan does not expose a goal.", "no-goal");
  }
  const goal = goalRaw.trim();

  const template = resolveReleaseNotesTemplate(inputs.registry);
  const gaps: ReleaseNotesGap[] = [];

  const facts = validateFacts(inputs.facts ?? {}, gaps);
  if (facts.version === null) {
    // A release note without a version is not publishable. Rather than
    // silently inventing one, the starter refuses with an actionable error.
    throw new ReleaseNotesError(
      "A release version is required. Supply `facts.version`.",
      "missing-version",
    );
  }

  const title =
    nonEmpty(inputs.title) ??
    `Release ${facts.version}${facts.releaseDate !== null ? ` (${facts.releaseDate})` : ""}`;
  const summary =
    nonEmpty(inputs.summary) ??
    buildDefaultSummary(facts, goal);
  const slug = slugify(`release-${facts.version}`);

  // Derive highlights from the plan's steps.
  const steps = readSteps(inputs.plan);
  if (steps.length === 0) {
    gaps.push({
      bucket: "highlights",
      reason: "no-plan-steps",
      detail:
        "The plan contains no steps; the highlights list cannot be derived from the workflow.",
    });
  }
  const derivedHighlights = steps
    .map((s) => describePlanStep(s.planStep))
    .filter((s): s is string => s !== null);

  // Partition caller-declared changes by category. Unknown categories are
  // recorded as gaps rather than being silently coerced into a known one.
  const changesByCategory: Record<ReleaseChangeCategory, ReleaseChange[]> = {
    added: [],
    changed: [],
    removed: [],
    fixed: [],
  };
  for (const change of inputs.changes ?? []) {
    if (change === null || typeof change !== "object") continue;
    const cat = change.category;
    if (typeof cat !== "string" || !(RELEASE_CHANGE_CATEGORIES as readonly string[]).includes(cat)) {
      gaps.push({
        bucket: null,
        reason: "unknown-category",
        detail: `Change entry has unknown category "${String(cat)}"; dropped.`,
      });
      continue;
    }
    const description = typeof change.description === "string" ? change.description.trim() : "";
    if (description.length === 0) continue;
    changesByCategory[cat as ReleaseChangeCategory].push({
      category: cat as ReleaseChangeCategory,
      description,
      reference: typeof change.reference === "string" && change.reference.trim().length > 0
        ? change.reference.trim()
        : null,
    });
  }

  const migrationNotes = pruneStrings(inputs.migrationNotes ?? []);
  if (migrationNotes.length === 0) {
    gaps.push({
      bucket: "migration",
      reason: "no-migration-notes",
      detail:
        "No migration notes were supplied; the section is omitted rather than invented.",
    });
  }
  if (derivedHighlights.length === 0 && inputs.changes === undefined) {
    gaps.push({
      bucket: "highlights",
      reason: "no-highlights",
      detail: "No highlights were derived from the plan or supplied as changes.",
    });
  }

  // Compose sections in the template's declared order.
  const sections: ReleaseNotesGuideSection[] = [];
  const ctx: SectionContext = {
    facts,
    title,
    summary,
    derivedHighlights,
    changesByCategory,
    migrationNotes,
  };
  for (const templateSection of template.sections) {
    const bucket = sectionIdToBucket(templateSection.id);
    if (bucket === null) continue;
    const built = buildSection(bucket, ctx, templateSection.required);
    if (built !== null) sections.push(built);
  }

  return {
    version: "release-notes/1",
    title,
    summary,
    slug,
    templateId: template.id,
    facts: {
      version: facts.version,
      releaseDate: facts.releaseDate ?? "",
      author: facts.author,
      trackingUrl: facts.trackingUrl,
    },
    sections,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

export function renderReleaseNotesMarkdown(guide: ReleaseNotesGuide): string {
  const parts: string[] = [];
  parts.push(`# ${guide.title}`);
  parts.push("");
  parts.push(guide.summary);
  parts.push("");
  for (const section of guide.sections) {
    if (section.bucket === "header") continue; // title/summary already emitted
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
    parts.push("_Gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of guide.gaps) {
      parts.push(`- ${gap.bucket !== null ? `[${gap.bucket}] ` : ""}${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildReleaseNotesDirectives(): string {
  return [
    "You are writing product release notes from an approved workflow plan and caller-supplied change lists.",
    "Follow this structure exactly: a header block with version and release date, then Highlights, Added, Changed, Removed, Fixed (only emit a change bucket that has entries), then Migration notes.",
    "Highlights are 3–6 short imperative sentences drawn from the plan's steps. Do not repeat a change entry as a highlight.",
    "Change entries use the exact wording the caller supplied; never rewrite a change list or invent an issue key.",
    "Never invent a version number, a release date, or a migration step. When the caller did not supply one, state the absence in the gap list, not in the prose.",
    "Do not use the word 'simply'. Do not use marketing superlatives.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function resolveReleaseNotesTemplate(registry?: TemplateRegistry): Template {
  try {
    return getTemplate(RELEASE_NOTES_STARTER_TEMPLATE_ID, registry);
  } catch (err) {
    throw new ReleaseNotesError(
      `Release-notes template "${RELEASE_NOTES_STARTER_TEMPLATE_ID}" is not in the template catalogue.`,
      "unknown-template",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

function validateFacts(
  raw: Partial<ReleaseNotesFacts>,
  gaps: ReleaseNotesGap[],
): {
  version: string | null;
  releaseDate: string | null;
  author: string | null;
  trackingUrl: string | null;
} {
  const version = nonEmpty(raw.version);
  const releaseDate = nonEmpty(raw.releaseDate);
  const author = nonEmpty(raw.author ?? null);
  const trackingUrl = nonEmpty(raw.trackingUrl ?? null);
  if (version === null) {
    gaps.push({
      bucket: "header",
      reason: "missing-version",
      detail: "No version was supplied; release notes cannot be published without a version.",
    });
  }
  if (releaseDate === null) {
    gaps.push({
      bucket: "header",
      reason: "missing-release-date",
      detail: "No release date was supplied; the header will omit the date.",
    });
  }
  return { version, releaseDate, author, trackingUrl };
}

interface SectionContext {
  readonly facts: {
    readonly version: string | null;
    readonly releaseDate: string | null;
    readonly author: string | null;
    readonly trackingUrl: string | null;
  };
  readonly title: string;
  readonly summary: string;
  readonly derivedHighlights: readonly string[];
  readonly changesByCategory: Record<ReleaseChangeCategory, readonly ReleaseChange[]>;
  readonly migrationNotes: readonly string[];
}

function buildSection(
  bucket: ReleaseNotesGuideSection["bucket"],
  ctx: SectionContext,
  required: boolean,
): ReleaseNotesGuideSection | null {
  switch (bucket) {
    case "header": {
      const lines: string[] = [];
      if (ctx.facts.version !== null) lines.push(`**Version:** ${ctx.facts.version}`);
      if (ctx.facts.releaseDate !== null) lines.push(`**Released:** ${ctx.facts.releaseDate}`);
      if (ctx.facts.author !== null) lines.push(`**Author:** ${ctx.facts.author}`);
      if (ctx.facts.trackingUrl !== null) lines.push(`**Tracking:** ${ctx.facts.trackingUrl}`);
      if (lines.length === 0) return null;
      return freezeSection({
        id: "header",
        heading: "Release header",
        body: lines.join("  \n"),
        assetRefs: [],
        requiredByTemplate: required,
        bucket,
      });
    }
    case "highlights": {
      const items = uniqueStrings(ctx.derivedHighlights);
      if (items.length === 0) return null;
      return freezeSection({
        id: "highlights",
        heading: "Highlights",
        body: items.map((i) => `- ${i}`).join("\n"),
        assetRefs: [],
        requiredByTemplate: required,
        bucket,
      });
    }
    case "added":
    case "changed":
    case "removed":
    case "fixed": {
      const entries = ctx.changesByCategory[bucket];
      if (entries.length === 0) return null;
      return freezeSection({
        id: bucket,
        heading: capitalise(bucket),
        body: renderChangeEntries(entries),
        assetRefs: [],
        requiredByTemplate: required,
        bucket,
      });
    }
    case "migration": {
      if (ctx.migrationNotes.length === 0) return null;
      return freezeSection({
        id: "migration",
        heading: "Migration notes",
        body: ctx.migrationNotes.map((n) => `- ${n}`).join("\n"),
        assetRefs: [],
        requiredByTemplate: required,
        bucket,
      });
    }
    default:
      return null;
  }
}

function renderChangeEntries(entries: readonly ReleaseChange[]): string {
  return entries
    .map((e) =>
      e.reference !== null ? `- ${e.description} (${e.reference})` : `- ${e.description}`,
    )
    .join("\n");
}

function sectionIdToBucket(
  id: string,
): ReleaseNotesGuideSection["bucket"] | null {
  switch (id) {
    case "header":
    case "highlights":
    case "added":
    case "changed":
    case "removed":
    case "fixed":
    case "migration":
      return id;
    default:
      return null;
  }
}

function buildDefaultSummary(
  facts: {
    readonly version: string | null;
    readonly releaseDate: string | null;
  },
  goal: string,
): string {
  const versionPart = facts.version !== null ? `Release ${facts.version}` : "This release";
  const datePart = facts.releaseDate !== null ? ` on ${facts.releaseDate}` : "";
  return `${versionPart}${datePart} covers the workflow: ${goal}.`;
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

function describePlanStep(step: PlanStep): string | null {
  const name = step.target !== null && step.target.name.trim().length > 0
    ? step.target.name.trim()
    : null;
  const value = typeof step.value === "string" && step.value.trim().length > 0
    ? step.value.trim()
    : null;
  switch (step.action) {
    case "click":
      return name !== null ? `New control: ${name}` : null;
    case "type":
      return name !== null
        ? value !== null
          ? `New field: ${name} (accepts ${value})`
          : `New field: ${name}`
        : null;
    case "select":
      return name !== null
        ? value !== null
          ? `New dropdown option: ${name} = ${value}`
          : `New dropdown: ${name}`
        : null;
    case "navigate":
      return value !== null ? `New page: ${value}` : null;
    case "scroll":
      return null;
    default:
      return name !== null ? `New interaction: ${name}` : null;
  }
}

function freezeSection(s: ReleaseNotesGuideSection): ReleaseNotesGuideSection {
  return Object.freeze({
    id: s.id,
    heading: s.heading,
    body: s.body,
    assetRefs: Object.freeze([...s.assetRefs]),
    requiredByTemplate: s.requiredByTemplate,
    bucket: s.bucket,
  });
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

function capitalise(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "release"
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
  resolveReleaseNotesTemplate,
  validateFacts,
  buildSection,
  renderChangeEntries,
  sectionIdToBucket,
  buildDefaultSummary,
  describePlanStep,
  freezeSection,
  uniqueStrings,
  capitalise,
  slugify,
});
