/**
 * Zipy AI — templates: content inheritance (templates batch 1).
 *
 * A child guide inherits named sections from a parent guide and may override
 * specific sections in place. The inheritance rule is deliberately narrow:
 *
 *   - A child guide names a `parentId` (a guide id) and an ordered list of
 *     `overrides` keyed by section id.
 *   - For each section in the parent, if the child supplies an override,
 *     the override content wins and the section is marked `source: "child"`.
 *     Otherwise the parent block is copied verbatim and marked
 *     `source: "parent"`.
 *   - The child may also declare `localSections` — sections that only exist
 *     in the child. These never appear in a parent-only render.
 *   - `detachedSections` remove a section the parent declared. Removing a
 *     `required` section (as determined by the template that produced the
 *     parent guide) is recorded as a `Gap`, not silently dropped: the
 *     reviewer must confirm the intent.
 *
 * Design rules honoured:
 *  - No invented content. The child supplies overrides as content blocks;
 *    the module does not paraphrase a parent block, does not suffix a
 *    section heading with "(inherited)", and does not concatenate parent
 *    and child bodies. Whichever block wins is copied whole.
 *  - Cycles are rejected deterministically. Inheritance is a DAG; a chain
 *    of parents that returns to the starting guide throws
 *    `InheritanceError` with `code: "cycle"` and the offending chain.
 *  - The module is pure: same inputs give byte-identical outputs. It writes
 *    nothing to storage and reads no clock beyond a documented timestamp.
 *  - Runtime-agnostic: the module never assumes a database. The caller
 *    supplies the chain as an array of `GuideBlock`s; a DB-backed loader is
 *    expected to fetch parents and pass them in. This keeps the module
 *    testable and the runtime free to use any persistence layer.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type InheritanceErrorCode =
  | "invalid-input"
  | "cycle"
  | "missing-parent"
  | "duplicate-override"
  | "duplicate-section";

export class InheritanceError extends Error {
  readonly code: InheritanceErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: InheritanceErrorCode,
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
 * One section of a guide. `body` is prose/Markdown already produced by the
 * content layer; this module never parses it.
 */
export interface GuideSection {
  readonly id: string;
  readonly heading: string;
  /** Body of the section; the module never rewrites it. */
  readonly body: string;
  /** Optional asset refs (screenshots, code blocks, generated tables). */
  readonly assetRefs: readonly string[];
  /**
   * Whether the originating template marked this section required. Carried
   * on the section so a child that detaches it can be reported as a gap
   * without the resolver having to re-load the template.
   */
  readonly requiredByTemplate: boolean;
}

/** One guide as the resolver sees it. */
export interface GuideBlock {
  /** Stable guide id. */
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly sections: readonly GuideSection[];
  /**
   * Id of this guide's parent, if any. Composition across a chain is the
   * caller's job: the resolver expects the immediate parent and the result
   * of that parent's own resolution when recursing. See `resolveInheritance`.
   */
  readonly parentId: string | null;
}

/** Where the content in the resolved section came from. */
export type SectionOrigin = "parent" | "child";

export interface ResolvedSection extends GuideSection {
  readonly origin: SectionOrigin;
  /**
   * The section id in the parent whose content this section replaced, or
   * `null` when the section is new in the child or draws from the parent
   * unchanged.
   */
  readonly overrodeSectionId: string | null;
}

export interface InheritanceGap {
  readonly sectionId: string | null;
  readonly reason:
    | "detached-required-section"
    | "unknown-override"
    | "unknown-detached"
    | "duplicate-override"
    | "duplicate-section"
    | "missing-parent";
  readonly detail: string;
}

/**
 * A child's declaration of what it wants. `overrides` replaces a section;
 * `detachedSections` removes one; `localSections` adds new ones.
 */
export interface ChildCompositionInput {
  readonly child: GuideBlock;
  /**
   * The immediate parent resolved to a list of sections. When the caller
   * has an unresolved parent this is the parent's own sections (a
   * single-level compose). When the parent itself inherits, the caller
   * passes the result of resolving the parent first, so this resolves the
   * whole chain in one pass.
   */
  readonly parent: {
    readonly id: string;
    readonly title: string;
    readonly sections: readonly GuideSection[];
  } | null;
  readonly overrides?: readonly GuideSection[];
  readonly detachedSections?: readonly string[];
  readonly localSections?: readonly GuideSection[];
}

export interface ResolvedComposition {
  readonly version: "inheritance/1";
  readonly guideId: string;
  readonly workspaceId: string;
  readonly title: string;
  /** Chain of parent ids from immediate parent up to the root; nearest first. */
  readonly ancestry: readonly string[];
  readonly sections: readonly ResolvedSection[];
  readonly gaps: readonly InheritanceGap[];
  readonly generatedAt: string;
}

export interface ResolveInheritanceInput {
  /**
   * The chain of guides from the leaf upward: `chain[0]` is the child, the
   * last entry is the root ancestor. Every entry's `parentId` must point to
   * the next entry (or be `null` on the last entry). This is the shape a
   * repository loader produces when it walks the parent references.
   */
  readonly chain: readonly GuideBlock[];
  /** Per-guide override/detach list keyed by guide id. Optional. */
  readonly composition?: Readonly<
    Record<
      string,
      { readonly overrides?: readonly GuideSection[]; readonly detachedSections?: readonly string[] }
    >
  >;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a child against its immediate parent. This is the single-hop
 * function; use `resolveInheritance` to walk a chain.
 */
export function composeChild(input: ChildCompositionInput): ResolvedComposition {
  if (input === null || typeof input !== "object") {
    throw new InheritanceError("composeChild requires an inputs object.", "invalid-input");
  }
  if (input.child === null || typeof input.child !== "object") {
    throw new InheritanceError("composeChild requires a `child` block.", "invalid-input");
  }
  const child = validateGuide(input.child);

  const gaps: InheritanceGap[] = [];
  const overrides = validateSectionList(input.overrides ?? [], "override");
  const localSections = validateSectionList(input.localSections ?? [], "local");
  const detached = new Set<string>(
    (input.detachedSections ?? []).filter((s): s is string => typeof s === "string" && s.trim().length > 0),
  );

  // Duplicate-detection across the three child-side lists.
  const childSectionIds = new Set<string>();
  for (const s of overrides) {
    if (childSectionIds.has(s.id)) {
      gaps.push({
        sectionId: s.id,
        reason: "duplicate-override",
        detail: `Override for "${s.id}" was declared more than once.`,
      });
      throw new InheritanceError(
        `Override for "${s.id}" was declared more than once.`,
        "duplicate-override",
        { id: s.id },
      );
    }
    childSectionIds.add(s.id);
  }
  for (const s of localSections) {
    if (childSectionIds.has(s.id)) {
      gaps.push({
        sectionId: s.id,
        reason: "duplicate-section",
        detail: `Section "${s.id}" appears in both overrides and local sections.`,
      });
      throw new InheritanceError(
        `Section "${s.id}" appears in both overrides and local sections.`,
        "duplicate-section",
        { id: s.id },
      );
    }
    childSectionIds.add(s.id);
  }

  const parent = input.parent;
  const parentSectionsById = new Map<string, GuideSection>();
  if (parent !== null && parent !== undefined) {
    for (const s of parent.sections) {
      parentSectionsById.set(s.id, s);
    }
  }

  // Unknown override / unknown detached sections relative to the parent.
  for (const s of overrides) {
    if (parent !== null && !parentSectionsById.has(s.id)) {
      gaps.push({
        sectionId: s.id,
        reason: "unknown-override",
        detail: `Override for "${s.id}" does not match any section in the parent guide.`,
      });
    }
  }
  for (const id of detached) {
    if (parent !== null && !parentSectionsById.has(id)) {
      gaps.push({
        sectionId: id,
        reason: "unknown-detached",
        detail: `Detached section "${id}" does not exist in the parent guide.`,
      });
    }
  }

  // Build the resolved section list.
  const resolved: ResolvedSection[] = [];
  const overrideById = new Map<string, GuideSection>();
  for (const s of overrides) overrideById.set(s.id, s);

  if (parent !== null && parent !== undefined) {
    for (const parentSection of parent.sections) {
      if (detached.has(parentSection.id)) {
        if (parentSection.requiredByTemplate) {
          gaps.push({
            sectionId: parentSection.id,
            reason: "detached-required-section",
            detail: `Child "${child.id}" detaches required section "${parentSection.id}" from parent "${parent.id}".`,
          });
        }
        continue;
      }
      const override = overrideById.get(parentSection.id);
      if (override !== undefined) {
        resolved.push({
          id: override.id,
          heading: override.heading.length > 0 ? override.heading : parentSection.heading,
          body: override.body,
          assetRefs: override.assetRefs,
          requiredByTemplate: parentSection.requiredByTemplate,
          origin: "child",
          overrodeSectionId: parentSection.id,
        });
      } else {
        resolved.push({
          id: parentSection.id,
          heading: parentSection.heading,
          body: parentSection.body,
          assetRefs: parentSection.assetRefs,
          requiredByTemplate: parentSection.requiredByTemplate,
          origin: "parent",
          overrodeSectionId: null,
        });
      }
    }
  }

  // Local (child-only) sections come last, in the order the caller declared.
  for (const s of localSections) {
    resolved.push({
      id: s.id,
      heading: s.heading,
      body: s.body,
      assetRefs: s.assetRefs,
      requiredByTemplate: s.requiredByTemplate,
      origin: "child",
      overrodeSectionId: null,
    });
  }

  const ancestry: string[] = [];
  if (parent !== null && parent !== undefined) ancestry.push(parent.id);

  return {
    version: "inheritance/1",
    guideId: child.id,
    workspaceId: child.workspaceId,
    title: child.title,
    ancestry,
    sections: resolved,
    gaps,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Resolve a chain of guides in one pass. The chain must be ordered from
 * leaf upward: `chain[0]` is the child, the last entry is the root. The
 * last entry's `parentId` must be `null`; every other entry must point to
 * the next entry's id.
 */
export function resolveInheritance(
  input: ResolveInheritanceInput,
): ResolvedComposition {
  if (input === null || typeof input !== "object") {
    throw new InheritanceError("resolveInheritance requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.chain) || input.chain.length === 0) {
    throw new InheritanceError("`chain` must be a non-empty array.", "invalid-input");
  }
  const chain = input.chain.map((g) => validateGuide(g));

  // Cycle/consistency check: every entry but the last must point to the next.
  const seenIds = new Set<string>();
  for (let i = 0; i < chain.length; i += 1) {
    const guide = chain[i]!;
    if (seenIds.has(guide.id)) {
      throw new InheritanceError(
        `Cycle detected: guide "${guide.id}" appears more than once in the chain.`,
        "cycle",
        { guideId: guide.id, chain: chain.map((g) => g.id) },
      );
    }
    seenIds.add(guide.id);
  }
  for (let i = 0; i < chain.length - 1; i += 1) {
    const guide = chain[i]!;
    const next = chain[i + 1]!;
    if (guide.parentId !== next.id) {
      throw new InheritanceError(
        `Chain is inconsistent: guide "${guide.id}".parentId="${String(guide.parentId)}" does not point to "${next.id}".`,
        "missing-parent",
        { guideId: guide.id, parentId: guide.parentId, expected: next.id },
      );
    }
  }
  const root = chain[chain.length - 1]!;
  if (root.parentId !== null) {
    throw new InheritanceError(
      `Root guide "${root.id}" declares a parentId "${root.parentId}"; the chain is incomplete.`,
      "missing-parent",
      { guideId: root.id, parentId: root.parentId },
    );
  }

  // Fold from the root downward: each step composes the next inner guide
  // against the accumulating result.
  let composed: ResolvedComposition = rootComposition(root);
  for (let i = chain.length - 2; i >= 0; i -= 1) {
    const guide = chain[i]!;
    const composition = input.composition?.[guide.id];
    const next = composeChild({
      child: guide,
      parent: {
        id: chain[i + 1]!.id,
        title: chain[i + 1]!.title,
        sections: composed.sections.map((s) => ({
          id: s.id,
          heading: s.heading,
          body: s.body,
          assetRefs: s.assetRefs,
          requiredByTemplate: s.requiredByTemplate,
        })),
      },
      overrides: composition?.overrides,
      detachedSections: composition?.detachedSections,
      localSections:
        guide.sections.length > 0
          ? // A child that carries its own sections treats those as local sections
            // unless the composition block named them as overrides. This is how a
            // freshly authored child is previewed before any override list exists.
            guide.sections.filter(
              (s) => !(composition?.overrides ?? []).some((o) => o.id === s.id),
            )
          : undefined,
    });
    composed = {
      ...composition,
      ancestry: [chain[i + 1]!.id, ...composed.ancestry],
    };
  }

  return composed;
}

/**
 * Compact report for reviewers: how many sections came from the parent vs
 * the child, and any gaps. Useful for the child-guide preview pane.
 */
export function summariseInheritance(composition: ResolvedComposition): string {
  const fromParent = composition.sections.filter((s) => s.origin === "parent").length;
  const fromChild = composition.sections.filter((s) => s.origin === "child").length;
  const lines: string[] = [];
  lines.push(`Guide ${composition.guideId} — ${composition.sections.length} sections`);
  lines.push(`  inherited from parent: ${fromParent}`);
  lines.push(`  authored in this guide: ${fromChild}`);
  if (composition.ancestry.length > 0) {
    lines.push(`  ancestry (nearest first): ${composition.ancestry.join(" → ")}`);
  }
  if (composition.gaps.length > 0) {
    lines.push(`  gaps: ${composition.gaps.length}`);
    for (const gap of composition.gaps) {
      lines.push(`    - ${gap.sectionId !== null ? `[${gap.sectionId}] ` : ""}${gap.detail}`);
    }
  }
  return lines.join("\n");
}

/** Rehydrate a resolved composition. Missing fields default to empty. */
export function rehydrateComposition(value: unknown): ResolvedComposition {
  if (value === null || typeof value !== "object") {
    throw new InheritanceError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const sections: ResolvedSection[] = [];
  if (Array.isArray(r["sections"])) {
    for (const entry of r["sections"] as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const s = entry as Record<string, unknown>;
      const id = typeof s["id"] === "string" ? s["id"].trim() : "";
      if (id.length === 0) continue;
      const origin: SectionOrigin = s["origin"] === "child" ? "child" : "parent";
      sections.push(
        Object.freeze({
          id,
          heading: typeof s["heading"] === "string" ? s["heading"] : "",
          body: typeof s["body"] === "string" ? s["body"] : "",
          assetRefs: Array.isArray(s["assetRefs"])
            ? Object.freeze(
                (s["assetRefs"] as unknown[]).filter(
                  (v): v is string => typeof v === "string",
                ),
              )
            : Object.freeze([]),
          requiredByTemplate: s["requiredByTemplate"] === true,
          origin,
          overrodeSectionId:
            typeof s["overrodeSectionId"] === "string" ? s["overrodeSectionId"] : null,
        }),
      );
    }
  }
  const gaps: InheritanceGap[] = [];
  if (Array.isArray(r["gaps"])) {
    for (const entry of r["gaps"] as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const g = entry as Record<string, unknown>;
      const reason = g["reason"];
      if (
        reason !== "detached-required-section" &&
        reason !== "unknown-override" &&
        reason !== "unknown-detached" &&
        reason !== "duplicate-override" &&
        reason !== "duplicate-section" &&
        reason !== "missing-parent"
      ) {
        continue;
      }
      gaps.push({
        sectionId: typeof g["sectionId"] === "string" ? g["sectionId"] : null,
        reason,
        detail: typeof g["detail"] === "string" ? g["detail"] : "",
      });
    }
  }
  const ancestry = Array.isArray(r["ancestry"])
    ? (r["ancestry"] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return Object.freeze({
    version: "inheritance/1",
    guideId: typeof r["guideId"] === "string" ? r["guideId"] : "",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    title: typeof r["title"] === "string" ? r["title"] : "",
    ancestry: Object.freeze(ancestry),
    sections: Object.freeze(sections),
    gaps: Object.freeze(gaps),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function rootComposition(root: GuideBlock): ResolvedComposition {
  const sections: ResolvedSection[] = root.sections.map((s) => ({
    id: s.id,
    heading: s.heading,
    body: s.body,
    assetRefs: s.assetRefs,
    requiredByTemplate: s.requiredByTemplate,
    origin: "child",
    overrodeSectionId: null,
  }));
  return {
    version: "inheritance/1",
    guideId: root.id,
    workspaceId: root.workspaceId,
    title: root.title,
    ancestry: [],
    sections,
    gaps: [],
    generatedAt: new Date().toISOString(),
  };
}

function validateGuide(g: GuideBlock): GuideBlock {
  if (g === null || typeof g !== "object") {
    throw new InheritanceError("A guide block is required.", "invalid-input");
  }
  if (typeof g.id !== "string" || g.id.trim().length === 0) {
    throw new InheritanceError("Guide id must be a non-empty string.", "invalid-input");
  }
  if (typeof g.workspaceId !== "string" || g.workspaceId.trim().length === 0) {
    throw new InheritanceError(
      `Guide "${g.id}" has no workspaceId.`,
      "invalid-input",
      { guideId: g.id },
    );
  }
  if (g.parentId !== null && typeof g.parentId !== "string") {
    throw new InheritanceError(
      `Guide "${g.id}" has a non-string parentId.`,
      "invalid-input",
      { guideId: g.id },
    );
  }
  return {
    id: g.id,
    workspaceId: g.workspaceId,
    title: typeof g.title === "string" ? g.title : g.id,
    sections: validateSectionList(g.sections, "guide"),
    parentId: g.parentId,
  };
}

function validateSectionList(
  sections: readonly GuideSection[],
  role: string,
): readonly GuideSection[] {
  if (!Array.isArray(sections)) {
    throw new InheritanceError(`${role} sections must be an array.`, "invalid-input");
  }
  const out: GuideSection[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    if (s === null || typeof s !== "object") continue;
    const id = typeof s.id === "string" ? s.id.trim() : "";
    if (id.length === 0) {
      throw new InheritanceError(
        `${role} section is missing an id.`,
        "invalid-input",
      );
    }
    if (seen.has(id)) {
      throw new InheritanceError(
        `${role} section "${id}" was declared more than once.`,
        "duplicate-section",
        { id, role },
      );
    }
    seen.add(id);
    out.push(
      Object.freeze({
        id,
        heading: typeof s.heading === "string" ? s.heading : "",
        body: typeof s.body === "string" ? s.body : "",
        assetRefs: Array.isArray(s.assetRefs)
          ? Object.freeze(
              (s.assetRefs as unknown[]).filter(
                (v): v is string => typeof v === "string" && v.trim().length > 0,
              ),
            )
          : Object.freeze([]),
        requiredByTemplate: s.requiredByTemplate === true,
      }),
    );
  }
  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  rootComposition,
  validateGuide,
  validateSectionList,
});
