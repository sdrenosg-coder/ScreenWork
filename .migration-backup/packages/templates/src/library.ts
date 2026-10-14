/**
 * Zipy AI — templates: library (templates batch 0).
 *
 * The template library is a set of named, composable content templates that
 * describe *shape* rather than *content*. A template names its required
 * sections, the variable slots it requires, the snippets it pulls in, and
 * the long-form renderer it prefers (KB article, SOP, blog, ...). It never
 * embeds workflow-specific prose: the prose comes from the content
 * generator, the shape comes from here.
 *
 * Design rules honoured:
 *  - No invented templates. Every template is a real, documented artefact
 *    with an id, a version and a scope. The library is a *registry*, not a
 *    generator.
 *  - Templates are pure data. `library.ts` returns frozen objects; a caller
 *    that mutates them is a bug, not a feature.
 *  - Templates are versioned. When a template's shape changes, a new id
 *    (`kb-standard@2`) is published and the old id is kept so previously
 *    rendered guides keep a shape description.
 *  - Templates are workspace-aware: the built-in catalogue is `scope:
 *    "builtin"`; a workspace can register its own (`scope: "workspace"`)
 *    with the same shape and its own id. `resolveTemplate` prefers a
 *    workspace override for a builtin id.
 *  - Templates reference snippets and variables by id; the composer
 *    (`./snippets.ts`, `./variables.ts`) validates that every required id
 *    is defined before a render can succeed.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type LibraryErrorCode =
  | "invalid-input"
  | "unknown-template"
  | "duplicate-template"
  | "invalid-template";

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: LibraryErrorCode,
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

/**
 * The long-form renderer a template targets. This is the module `pipeline.ts`
 * dispatches to when the caller asks to render a guide using a template.
 */
export const TEMPLATE_RENDERERS = [
  "kb-article",
  "sop",
  "blog",
  "social",
  "email",
  "release-notes",
  "onboarding",
] as const;
export type TemplateRenderer = (typeof TEMPLATE_RENDERERS)[number];

/**
 * Built-in templates ship with the platform. `scope: "workspace"` templates
 * are registered by a workspace and may shadow a builtin of the same id.
 */
export type TemplateScope = "builtin" | "workspace";

/**
 * A section in a template. `required: true` sections must receive content;
 * the render pipeline records a *gap* rather than emitting an empty heading
 * when a required section has no content.
 */
export interface TemplateSection {
  readonly id: string;
  readonly heading: string;
  readonly kind: TemplateSectionKind;
  readonly required: boolean;
  /** Snippet ids that must be inserted into this section (in order). */
  readonly snippetIds: readonly string[];
}

export const TEMPLATE_SECTION_KINDS = [
  "prose",
  "step-list",
  "table",
  "checklist",
  "callout",
  "code",
  "decision-tree",
  "faq",
  "glossary",
  "quiz",
  "flashcards",
  "signature",
] as const;
export type TemplateSectionKind = (typeof TEMPLATE_SECTION_KINDS)[number];

/**
 * A template definition. Everything here is declarative — the runtime is
 * expected to combine this shape with content artefacts produced upstream.
 */
export interface Template {
  /** Stable id, e.g. `kb-standard@1`. */
  readonly id: string;
  /** Display name shown to authors. */
  readonly name: string;
  /** One-line description shown in the template picker. */
  readonly description: string;
  readonly renderer: TemplateRenderer;
  readonly scope: TemplateScope;
  /** Semantic version of the *shape* — bumped when sections change. */
  readonly shapeVersion: number;
  /** Ordered sections. */
  readonly sections: readonly TemplateSection[];
  /** Variable names the template requires; resolved by `./variables.ts`. */
  readonly requiredVariables: readonly string[];
  /** Snippet ids the template references across its sections. */
  readonly snippetIds: readonly string[];
  /** Tags for the picker's filter bar. */
  readonly tags: readonly string[];
  /**
   * Provenance of the template definition — which use-case starter introduced
   * it, if any. `null` for hand-authored templates.
   */
  readonly sourceStarter: string | null;
}

/** A registry of templates, indexable by id. */
export interface TemplateRegistry {
  readonly version: "template-registry/1";
  readonly templates: readonly Template[];
  readonly generatedAt: string;
}

export interface RegisterTemplateInput {
  readonly template: Omit<Template, "scope"> & { readonly scope?: TemplateScope };
  readonly workspaceId?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

const BUILTIN_TEMPLATES: readonly Template[] = Object.freeze([
  freezeTemplate({
    id: "kb-standard@1",
    name: "Knowledge-base article",
    description:
      "Standard help-centre article: title, summary, introduction, prerequisites, step-by-step instructions, tips, FAQ and glossary.",
    renderer: "kb-article",
    scope: "builtin",
    shapeVersion: 1,
    sections: [
      section("summary", "Summary", "prose", true),
      section("introduction", "Introduction", "prose", true),
      section("prerequisites", "Prerequisites", "checklist", false),
      section("steps", "Steps", "step-list", true),
      section("tips", "Tips & warnings", "callout", false),
      section("faq", "Frequently asked questions", "faq", false),
      section("glossary", "Glossary", "glossary", false),
    ],
    requiredVariables: [],
    snippetIds: [],
    tags: ["help-center", "standard", "reference"],
    sourceStarter: null,
  }),

  freezeTemplate({
    id: "sop-standard@1",
    name: "Standard operating procedure",
    description:
      "Formal procedure: roles, scope, prerequisites, procedure with rollback positions and approvals, and rollback summary.",
    renderer: "sop",
    scope: "builtin",
    shapeVersion: 1,
    sections: [
      section("roles", "Roles", "table", true),
      section("scope", "Scope", "prose", true),
      section("prerequisites", "Prerequisites", "checklist", true),
      section("procedure", "Procedure", "step-list", true),
      section("approvals", "Approvals", "table", false),
      section("rollback-summary", "Rollback summary", "prose", false),
    ],
    requiredVariables: ["procedure_owner"],
    snippetIds: ["compliance-disclaimer"],
    tags: ["sop", "runbook", "operations"],
    sourceStarter: "sop",
  }),

  freezeTemplate({
    id: "blog-standard@1",
    name: "Blog post",
    description:
      "Narrative blog post: lede, why-this-matters, numbered steps, wrapping up, optional FAQ and tags.",
    renderer: "blog",
    scope: "builtin",
    shapeVersion: 1,
    sections: [
      section("lede", "Lede", "prose", true),
      section("why", "Why this matters", "prose", false),
      section("steps", "Steps", "step-list", true),
      section("closing", "Wrapping up", "prose", true),
      section("faq", "Frequently asked questions", "faq", false),
    ],
    requiredVariables: [],
    snippetIds: [],
    tags: ["blog", "long-form", "narrative"],
    sourceStarter: null,
  }),

  freezeTemplate({
    id: "release-notes@1",
    name: "Release notes",
    description:
      "Product release-notes entry: version header, highlights, changes by category, migration notes and a signed-off summary.",
    renderer: "release-notes",
    scope: "builtin",
    shapeVersion: 1,
    sections: [
      section("highlights", "Highlights", "prose", true),
      section("added", "Added", "checklist", false),
      section("changed", "Changed", "checklist", false),
      section("removed", "Removed", "checklist", false),
      section("migration", "Migration notes", "prose", false),
    ],
    requiredVariables: ["version"],
    snippetIds: [],
    tags: ["release-notes", "changelog", "product"],
    sourceStarter: "release-notes",
  }),

  freezeTemplate({
    id: "onboarding-standard@1",
    name: "Employee onboarding",
    description:
      "Onboarding guide: welcome, pre-start checklist, day-one checklist, first-week milestones, day-30 expectations and acknowledgements.",
    renderer: "onboarding",
    scope: "builtin",
    shapeVersion: 1,
    sections: [
      section("welcome", "Welcome", "prose", true),
      section("pre-start", "Before your first day", "checklist", true),
      section("day-one", "Your first day", "checklist", true),
      section("first-week", "Your first week", "checklist", true),
      section("day-30", "Your first 30 days", "prose", true),
      section("acknowledgements", "Acknowledgements", "signature", false),
    ],
    requiredVariables: ["employee_name", "manager_name"],
    snippetIds: ["accessibility-statement"],
    tags: ["onboarding", "hr", "starter"],
    sourceStarter: "onboarding",
  }),

  freezeTemplate({
    id: "social-standard@1",
    name: "Social announcement",
    description:
      "Short social post: single body paragraph, at most a handful of hashtags and an optional link.",
    renderer: "social",
    scope: "builtin",
    shapeVersion: 1,
    sections: [
      section("body", "Body", "prose", true),
    ],
    requiredVariables: [],
    snippetIds: [],
    tags: ["social", "announcement", "short-form"],
    sourceStarter: null,
  }),

  freezeTemplate({
    id: "email-standard@1",
    name: "Email announcement",
    description:
      "Announcement email: subject, preheader, lede, bulleted key points, call to action and sign-off.",
    renderer: "email",
    scope: "builtin",
    shapeVersion: 1,
    sections: [
      section("lede", "Lede", "prose", true),
      section("key-points", "Key points", "checklist", false),
      section("cta", "Call to action", "prose", false),
      section("signoff", "Sign-off", "signature", false),
    ],
    requiredVariables: [],
    snippetIds: ["unsubscribe-line"],
    tags: ["email", "announcement", "marketing"],
    sourceStarter: null,
  }),
]);

/* -------------------------------------------------------------------------- */
/* Public API — registry                                                       */
/* -------------------------------------------------------------------------- */

/** Return the frozen list of built-in templates. */
export function listBuiltinTemplates(): readonly Template[] {
  return BUILTIN_TEMPLATES;
}

/**
 * Build a registry from built-ins plus any workspace overrides. A workspace
 * template with the same id as a builtin shadows the builtin for that
 * workspace (a later registration always wins, and the returned list is
 * sorted so the shadowed template is first).
 */
export function buildRegistry(
  workspaceTemplates: readonly Template[] = [],
): TemplateRegistry {
  if (!Array.isArray(workspaceTemplates)) {
    throw new LibraryError("`workspaceTemplates` must be an array.", "invalid-input");
  }
  const byId = new Map<string, Template>();
  for (const t of BUILTIN_TEMPLATES) byId.set(t.id, t);
  for (const t of workspaceTemplates) {
    validateTemplateShape(t);
    byId.set(t.id, t);
  }
  const templates = Array.from(byId.values()).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return {
    version: "template-registry/1",
    templates,
    generatedAt: new Date().toISOString(),
  };
}

/** Look up a single template from a registry or the builtin catalogue. */
export function getTemplate(
  id: string,
  registry?: TemplateRegistry,
): Template {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new LibraryError("Template id must be a non-empty string.", "invalid-input");
  }
  const trimmed = id.trim();
  const pool = registry?.templates ?? BUILTIN_TEMPLATES;
  const hit = pool.find((t) => t.id === trimmed);
  if (hit === undefined) {
    throw new LibraryError(
      `Unknown template "${trimmed}". Known ids: ${pool.map((t) => t.id).join(", ")}.`,
      "unknown-template",
      { id: trimmed },
    );
  }
  return hit;
}

/**
 * Register a workspace-authored template against a registry. Returns a new
 * registry object; the input registry is untouched. Rejects an invalid
 * shape with a descriptive `LibraryError`.
 */
export function registerTemplate(
  registry: TemplateRegistry,
  input: RegisterTemplateInput,
): TemplateRegistry {
  if (registry === null || typeof registry !== "object") {
    throw new LibraryError("A registry object is required.", "invalid-input");
  }
  if (input === null || typeof input !== "object" || input.template === undefined) {
    throw new LibraryError("A template input object is required.", "invalid-input");
  }
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
  const partial = input.template;
  const template: Template = freezeTemplate({
    ...partial,
    scope: workspaceId.length > 0 ? "workspace" : "workspace",
  } as Template);
  validateTemplateShape(template);

  const existing = registry.templates.find((t) => t.id === template.id);
  if (
    existing !== undefined &&
    existing.scope === "workspace" &&
    workspaceId.length > 0
  ) {
    // A re-registration from the same workspace replaces the previous
    // definition. A builtin shadow is allowed and replaces the builtin for
    // this registry.
  }
  const byId = new Map<string, Template>();
  for (const t of registry.templates) byId.set(t.id, t);
  byId.set(template.id, template);
  const templates = Array.from(byId.values()).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return {
    version: "template-registry/1",
    templates,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Resolve a template. A workspace registry first, the builtin catalogue
 * second. Throws when the id is not known in either catalogue.
 */
export function resolveTemplate(
  id: string,
  workspaceTemplates?: readonly Template[] | null,
): Template {
  if (Array.isArray(workspaceTemplates) && workspaceTemplates.length > 0) {
    const hit = workspaceTemplates.find((t) => t.id === id);
    if (hit !== undefined) return hit;
  }
  return getTemplate(id);
}

/**
 * Rehydrate a `TemplateRegistry` from persisted JSON. Invalid templates are
 * dropped silently — the composer's validation path is `registerTemplate`.
 */
export function rehydrateRegistry(value: unknown): TemplateRegistry {
  if (value === null || typeof value !== "object") {
    throw new LibraryError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const rawTemplates = Array.isArray(r["templates"]) ? (r["templates"] as unknown[]) : [];
  const templates: Template[] = [];
  for (const item of rawTemplates) {
    const parsed = parseTemplate(item);
    if (parsed === null) continue;
    templates.push(parsed);
  }
  return {
    version: "template-registry/1",
    templates: templates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function section(
  id: string,
  heading: string,
  kind: TemplateSectionKind,
  required: boolean,
  snippetIds: readonly string[] = [],
): TemplateSection {
  return Object.freeze({ id, heading, kind, required, snippetIds: [...snippetIds] });
}

function freezeTemplate(t: Template): Template {
  return Object.freeze({
    ...t,
    sections: Object.freeze(t.sections.map((s) => Object.freeze({ ...s }))),
    requiredVariables: Object.freeze([...t.requiredVariables]),
    snippetIds: Object.freeze([...t.snippetIds]),
    tags: Object.freeze([...t.tags]),
  });
}

function validateTemplateShape(t: Template): void {
  if (typeof t.id !== "string" || t.id.trim().length === 0) {
    throw new LibraryError("Template id must be a non-empty string.", "invalid-template");
  }
  if (typeof t.name !== "string" || t.name.trim().length === 0) {
    throw new LibraryError(`Template "${t.id}" has no name.`, "invalid-template", { id: t.id });
  }
  if (!TEMPLATE_RENDERERS.includes(t.renderer)) {
    throw new LibraryError(
      `Template "${t.id}" declares unknown renderer "${String(t.renderer)}".`,
      "invalid-template",
      { id: t.id, renderer: t.renderer },
    );
  }
  if (!Array.isArray(t.sections) || t.sections.length === 0) {
    throw new LibraryError(
      `Template "${t.id}" declares no sections.`,
      "invalid-template",
      { id: t.id },
    );
  }
  const seenSectionIds = new Set<string>();
  for (const s of t.sections) {
    if (typeof s.id !== "string" || s.id.trim().length === 0) {
      throw new LibraryError(
        `Template "${t.id}" has a section without an id.`,
        "invalid-template",
        { id: t.id },
      );
    }
    if (seenSectionIds.has(s.id)) {
      throw new LibraryError(
        `Template "${t.id}" declares section "${s.id}" more than once.`,
        "invalid-template",
        { id: t.id, sectionId: s.id },
      );
    }
    seenSectionIds.add(s.id);
    if (!TEMPLATE_SECTION_KINDS.includes(s.kind)) {
      throw new LibraryError(
        `Template "${t.id}" section "${s.id}" has unknown kind "${String(s.kind)}".`,
        "invalid-template",
        { id: t.id, sectionId: s.id, kind: s.kind },
      );
    }
  }
  if (!Number.isFinite(t.shapeVersion) || t.shapeVersion < 1) {
    throw new LibraryError(
      `Template "${t.id}" has an invalid shapeVersion.`,
      "invalid-template",
      { id: t.id, shapeVersion: t.shapeVersion },
    );
  }
}

function parseTemplate(value: unknown): Template | null {
  if (value === null || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const id = typeof o["id"] === "string" ? o["id"].trim() : "";
  const name = typeof o["name"] === "string" ? o["name"].trim() : "";
  const renderer = o["renderer"];
  if (id.length === 0 || name.length === 0 || !TEMPLATE_RENDERERS.includes(renderer as TemplateRenderer)) {
    return null;
  }
  if (!Array.isArray(o["sections"])) return null;

  const sections: TemplateSection[] = [];
  for (const rawS of o["sections"] as unknown[]) {
    if (rawS === null || typeof rawS !== "object") continue;
    const s = rawS as Record<string, unknown>;
    const sid = typeof s["id"] === "string" ? s["id"].trim() : "";
    const heading = typeof s["heading"] === "string" ? s["heading"] : "";
    const kind = s["kind"];
    if (sid.length === 0 || !TEMPLATE_SECTION_KINDS.includes(kind as TemplateSectionKind)) continue;
    sections.push(
      Object.freeze({
        id: sid,
        heading,
        kind: kind as TemplateSectionKind,
        required: s["required"] === true,
        snippetIds: Array.isArray(s["snippetIds"])
          ? Object.freeze(
              (s["snippetIds"] as unknown[]).filter(
                (v): v is string => typeof v === "string" && v.trim().length > 0,
              ),
            )
          : Object.freeze([]),
      }),
    );
  }
  if (sections.length === 0) return null;

  const scopeRaw = o["scope"];
  const scope: TemplateScope = scopeRaw === "workspace" ? "workspace" : "builtin";

  return freezeTemplate({
    id,
    name,
    description: typeof o["description"] === "string" ? o["description"] : "",
    renderer: renderer as TemplateRenderer,
    scope,
    shapeVersion:
      typeof o["shapeVersion"] === "number" && Number.isFinite(o["shapeVersion"])
        ? Math.max(1, Math.floor(o["shapeVersion"]))
        : 1,
    sections,
    requiredVariables: Array.isArray(o["requiredVariables"])
      ? (o["requiredVariables"] as unknown[]).filter(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        )
      : [],
    snippetIds: Array.isArray(o["snippetIds"])
      ? (o["snippetIds"] as unknown[]).filter(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        )
      : [],
    tags: Array.isArray(o["tags"])
      ? (o["tags"] as unknown[]).filter(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        )
      : [],
    sourceStarter: typeof o["sourceStarter"] === "string" ? o["sourceStarter"] : null,
  });
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  section,
  freezeTemplate,
  validateTemplateShape,
  parseTemplate,
});
