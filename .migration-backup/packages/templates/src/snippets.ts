/**
 * Zipy AI — templates: reusable snippets (templates batch 0).
 *
 * A *snippet* is a reusable content block that a template can pull into one
 * of its sections — a legal disclaimer, a compliance footer, an
 * accessibility statement, an unsubscribe line. Snippets carry a stable id
 * (`compliance-disclaimer`), a version, a body (`markdown` or `plain-text`)
 * and a set of variables the snippet expects to be bound at render time.
 *
 * The snippet library ships a small built-in catalogue of platform-owned
 * snippets (the ones a template like `sop-standard@1` or
 * `email-standard@1` declares). Workspaces register their own snippets
 * against the same registry; a workspace snippet with the same id shadows
 * the builtin for that workspace, matching the template shadowing rule.
 *
 * Design rules honoured:
 *  - No invented snippets. Every builtin has a real, reviewable purpose.
 *  - Snippets are frozen data. A workspace snippet must go through
 *    `registerSnippet`, which validates the shape and records gaps.
 *  - Snippet bodies may reference template variables using the same
 *    `{{name}}` grammar the rest of the platform uses. The renderer binds
 *    them via `./variables.ts`; this module does not perform substitution.
 *  - A snippet marked `legal: true` is always inserted *unedited* when a
 *    template declares it. The renderer must never trim or paraphrase a
 *    legal body; the flag is here so a validation pass can enforce that.
 *  - Deterministic and pure.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SnippetErrorCode =
  | "invalid-input"
  | "unknown-snippet"
  | "invalid-snippet"
  | "duplicate-snippet"
  | "cannot-edit-legal";

export class SnippetError extends Error {
  readonly code: SnippetErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SnippetErrorCode,
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

export type SnippetBodyFormat = "markdown" | "plain-text";

export type SnippetScope = "builtin" | "workspace";

export interface Snippet {
  /** Stable id, e.g. `compliance-disclaimer`. */
  readonly id: string;
  /** Display name shown in the snippet picker. */
  readonly name: string;
  /** One-line description for the picker. */
  readonly description: string;
  readonly scope: SnippetScope;
  readonly format: SnippetBodyFormat;
  /** The body. May contain `{{variable}}` references. */
  readonly body: string;
  /** Variable names the snippet expects bound at render time. */
  readonly variables: readonly string[];
  /**
   * A legal snippet is inserted verbatim by the renderer. Workspace authors
   * must not override a builtin that is marked legal with a body that
   * weakens the language, and the render pipeline must not paraphrase it.
   */
  readonly legal: boolean;
  /** True when the snippet is only valid at the end of a document. */
  readonly footerOnly: boolean;
  /** ISO timestamp for the builtin; empty for caller-registered snippets. */
  readonly updatedAt: string;
}

export interface SnippetRegistry {
  readonly version: "snippet-registry/1";
  readonly snippets: readonly Snippet[];
  readonly generatedAt: string;
}

export interface SnippetGap {
  readonly snippetId: string | null;
  readonly reason:
    | "invalid-id"
    | "empty-body"
    | "duplicate-id"
    | "unknown-variable"
    | "legal-override";
  readonly detail: string;
}

export interface RegisterSnippetInput {
  readonly snippet: Omit<Snippet, "scope" | "updatedAt"> & {
    readonly scope?: SnippetScope;
    readonly updatedAt?: string;
  };
  /**
   * Whether the caller has permission to shadow a *legal* builtin snippet.
   * When false (the default), an attempt to shadow a legal snippet is
   * rejected with a `SnippetGap` and a `SnippetError`.
   */
  readonly allowLegalOverride?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Built-in catalogue                                                          */
/* -------------------------------------------------------------------------- */

const BUILTIN_SNIPPETS: readonly Snippet[] = Object.freeze([
  freezeSnippet({
    id: "compliance-disclaimer",
    name: "Compliance disclaimer",
    description:
      "Footer disclaimer for procedures that touch regulated data or regulated processes.",
    scope: "builtin",
    format: "markdown",
    body: [
      "> **Compliance notice.** This procedure touches data that is subject to the workspace's",
      "> regulatory obligations. Follow it exactly as written. If the workflow below does not match",
      "> the current version of the system, stop and raise a change request before proceeding.",
    ].join("\n"),
    variables: [],
    legal: true,
    footerOnly: true,
    updatedAt: "2024-06-01T00:00:00.000Z",
  }),

  freezeSnippet({
    id: "accessibility-statement",
    name: "Accessibility statement",
    description:
      "Standard statement noting the guide is intended to be accessible and how to request an alternative format.",
    scope: "builtin",
    format: "markdown",
    body: [
      "_This guide is published with accessibility in mind. Screenshots are captioned and steps are",
      "written as plain sentences. If you need this material in an alternative format, contact your",
      "workspace administrator._",
    ].join("\n"),
    variables: [],
    legal: false,
    footerOnly: true,
    updatedAt: "2024-06-01T00:00:00.000Z",
  }),

  freezeSnippet({
    id: "unsubscribe-line",
    name: "Unsubscribe line",
    description:
      "Standard footer line for announcement emails. Contains the `{{unsubscribe_url}}` variable.",
    scope: "builtin",
    format: "plain-text",
    body: "You are receiving this message because you subscribed to product updates. Unsubscribe: {{unsubscribe_url}}",
    variables: ["unsubscribe_url"],
    legal: false,
    footerOnly: true,
    updatedAt: "2024-06-01T00:00:00.000Z",
  }),

  freezeSnippet({
    id: "ai-disclosure-short",
    name: "AI-generated content disclosure",
    description:
      "Short disclosure that the guide's prose was generated with AI assistance and reviewed by a named role. Use `{{reviewer_role}}` to bind the role.",
    scope: "builtin",
    format: "markdown",
    body: [
      "_Content in this document was generated with AI assistance and reviewed by the",
      "`{{reviewer_role}}` before publication. Where the AI-generated text disagreed with the",
      "sources, the sources take precedence._",
    ].join("\n"),
    variables: ["reviewer_role"],
    legal: false,
    footerOnly: false,
    updatedAt: "2024-06-01T00:00:00.000Z",
  }),

  freezeSnippet({
    id: "onboarding-acknowledgement",
    name: "Onboarding acknowledgement",
    description:
      "Signature block for onboarding guides. Uses `{{employee_name}}` and `{{start_date}}`.",
    scope: "builtin",
    format: "markdown",
    body: [
      "**Acknowledgement.** I, `{{employee_name}}`, have read the onboarding guide and understand",
      "the expectations described above. My first day is `{{start_date}}`.",
    ].join("\n"),
    variables: ["employee_name", "start_date"],
    legal: false,
    footerOnly: true,
    updatedAt: "2024-06-01T00:00:00.000Z",
  }),

  freezeSnippet({
    id: "prerequisite-verify-account",
    name: "Verify account prerequisite",
    description:
      "Reusable prerequisite checklist item for workflows that require an existing account.",
    scope: "builtin",
    format: "markdown",
    body: "- You are signed in to the workspace with an account that can reach the workflow's starting screen.",
    variables: [],
    legal: false,
    footerOnly: false,
    updatedAt: "2024-06-01T00:00:00.000Z",
  }),
]);

/* -------------------------------------------------------------------------- */
/* Public API — builtins                                                       */
/* -------------------------------------------------------------------------- */

export function listBuiltinSnippets(): readonly Snippet[] {
  return BUILTIN_SNIPPETS;
}

/* -------------------------------------------------------------------------- */
/* Public API — registry                                                       */
/* -------------------------------------------------------------------------- */

export function buildSnippetRegistry(
  workspaceSnippets: readonly Snippet[] = [],
): SnippetRegistry {
  if (!Array.isArray(workspaceSnippets)) {
    throw new SnippetError("`workspaceSnippets` must be an array.", "invalid-input");
  }
  const byId = new Map<string, Snippet>();
  for (const s of BUILTIN_SNIPPETS) byId.set(s.id, s);
  for (const s of workspaceSnippets) {
    validateSnippetShape(s);
    byId.set(s.id, s);
  }
  const snippets = Array.from(byId.values()).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return {
    version: "snippet-registry/1",
    snippets,
    generatedAt: new Date().toISOString(),
  };
}

export function getSnippet(id: string, registry?: SnippetRegistry): Snippet {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new SnippetError("Snippet id must be a non-empty string.", "invalid-input");
  }
  const trimmed = id.trim();
  const pool = registry?.snippets ?? BUILTIN_SNIPPETS;
  const hit = pool.find((s) => s.id === trimmed);
  if (hit === undefined) {
    throw new SnippetError(
      `Unknown snippet "${trimmed}". Known ids: ${pool.map((s) => s.id).join(", ")}.`,
      "unknown-snippet",
      { id: trimmed },
    );
  }
  return hit;
}

/**
 * Register a snippet. Returns a new registry plus any gaps recorded. The
 * caller decides what to do with the gaps; a `SnippetError` is thrown when
 * a legal builtin would be shadowed without explicit opt-in.
 */
export function registerSnippet(
  registry: SnippetRegistry,
  input: RegisterSnippetInput,
): { readonly registry: SnippetRegistry; readonly gaps: readonly SnippetGap[] } {
  if (registry === null || typeof registry !== "object") {
    throw new SnippetError("A registry object is required.", "invalid-input");
  }
  if (input === null || typeof input !== "object" || input.snippet === undefined) {
    throw new SnippetError("A snippet input object is required.", "invalid-input");
  }
  const gaps: SnippetGap[] = [];
  const partial = input.snippet;

  const id = typeof partial.id === "string" ? partial.id.trim() : "";
  if (id.length === 0 || !ID_RE.test(id)) {
    gaps.push({
      snippetId: id || null,
      reason: "invalid-id",
      detail: `Snippet id "${id}" is invalid; expected lowercase kebab-case.`,
    });
    throw new SnippetError(
      `Snippet id "${id}" is invalid; expected lowercase kebab-case.`,
      "invalid-snippet",
      { id },
    );
  }

  const body = typeof partial.body === "string" ? partial.body : "";
  if (body.trim().length === 0) {
    gaps.push({
      snippetId: id,
      reason: "empty-body",
      detail: `Snippet "${id}" has an empty body.`,
    });
    throw new SnippetError(`Snippet "${id}" has an empty body.`, "invalid-snippet", { id });
  }

  const existing = registry.snippets.find((s) => s.id === id);
  if (existing !== undefined && existing.legal && existing.scope === "builtin") {
    if (input.allowLegalOverride !== true) {
      gaps.push({
        snippetId: id,
        reason: "legal-override",
        detail: `Snippet "${id}" is a legal builtin; shadowing it requires explicit allowLegalOverride.`,
      });
      throw new SnippetError(
        `Snippet "${id}" is a legal builtin; shadowing it requires explicit allowLegalOverride.`,
        "cannot-edit-legal",
        { id },
      );
    }
  }

  const snippet = freezeSnippet({
    id,
    name: typeof partial.name === "string" && partial.name.trim().length > 0
      ? partial.name.trim()
      : id,
    description: typeof partial.description === "string" ? partial.description : "",
    scope: "workspace",
    format: partial.format === "plain-text" ? "plain-text" : "markdown",
    body,
    variables: Array.isArray(partial.variables)
      ? (partial.variables as unknown[]).filter(
          (v): v is string => typeof v === "string" && NAME_RE.test(v),
        )
      : [],
    legal: partial.legal === true,
    footerOnly: partial.footerOnly === true,
    updatedAt:
      typeof partial.updatedAt === "string" && partial.updatedAt.length > 0
        ? partial.updatedAt
        : new Date().toISOString(),
  });

  const byId = new Map<string, Snippet>();
  for (const s of registry.snippets) byId.set(s.id, s);
  byId.set(snippet.id, snippet);
  const snippets = Array.from(byId.values()).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  return {
    registry: {
      version: "snippet-registry/1",
      snippets,
      generatedAt: new Date().toISOString(),
    },
    gaps,
  };
}

/**
 * Verify that a set of snippet ids exists in the registry and, when
 * `allowedVariables` is supplied, that every variable a snippet references
 * is in the allow-list. Returns gaps, never throws on ordinary misses so
 * the reviewer UI can list what is missing.
 */
export function validateSnippets(
  ids: readonly string[],
  registry: SnippetRegistry,
  allowedVariables?: readonly string[],
): readonly SnippetGap[] {
  if (!Array.isArray(ids)) {
    throw new SnippetError("`ids` must be an array.", "invalid-input");
  }
  if (registry === null || typeof registry !== "object") {
    throw new SnippetError("A snippet registry is required.", "invalid-input");
  }
  const allowed =
    allowedVariables !== undefined && Array.isArray(allowedVariables)
      ? new Set(allowedVariables)
      : null;

  const gaps: SnippetGap[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) {
      gaps.push({
        snippetId: trimmed,
        reason: "duplicate-id",
        detail: `Snippet "${trimmed}" appears more than once.`,
      });
      continue;
    }
    seen.add(trimmed);
    const hit = registry.snippets.find((s) => s.id === trimmed);
    if (hit === undefined) {
      gaps.push({
        snippetId: trimmed,
        reason: "invalid-id",
        detail: `Snippet "${trimmed}" is not in the registry.`,
      });
      continue;
    }
    if (allowed !== null) {
      for (const name of hit.variables) {
        if (!allowed.has(name)) {
          gaps.push({
            snippetId: trimmed,
            reason: "unknown-variable",
            detail: `Snippet "${trimmed}" references variable "${name}" that the render did not bind.`,
          });
        }
      }
    }
  }
  return Object.freeze(gaps);
}

/** Rehydrate a `SnippetRegistry` from persisted JSON. Invalid entries are dropped. */
export function rehydrateSnippetRegistry(value: unknown): SnippetRegistry {
  if (value === null || typeof value !== "object") {
    throw new SnippetError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const raw = Array.isArray(r["snippets"]) ? (r["snippets"] as unknown[]) : [];
  const snippets: Snippet[] = [];
  for (const item of raw) {
    const parsed = parseSnippet(item);
    if (parsed === null) continue;
    snippets.push(parsed);
  }
  return {
    version: "snippet-registry/1",
    snippets: snippets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/u;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/u;

function freezeSnippet(s: Snippet): Snippet {
  return Object.freeze({
    ...s,
    variables: Object.freeze([...s.variables]),
  });
}

function validateSnippetShape(s: Snippet): void {
  if (typeof s.id !== "string" || !ID_RE.test(s.id)) {
    throw new SnippetError(
      `Snippet id "${String(s.id)}" is invalid; expected lowercase kebab-case.`,
      "invalid-snippet",
      { id: s.id },
    );
  }
  if (typeof s.body !== "string" || s.body.trim().length === 0) {
    throw new SnippetError(
      `Snippet "${s.id}" has an empty body.`,
      "invalid-snippet",
      { id: s.id },
    );
  }
  if (s.format !== "markdown" && s.format !== "plain-text") {
    throw new SnippetError(
      `Snippet "${s.id}" declares unknown format "${String(s.format)}".`,
      "invalid-snippet",
      { id: s.id },
    );
  }
  for (const v of s.variables) {
    if (typeof v !== "string" || !NAME_RE.test(v)) {
      throw new SnippetError(
        `Snippet "${s.id}" declares invalid variable name "${String(v)}".`,
        "invalid-snippet",
        { id: s.id, variable: v },
      );
    }
  }
}

function parseSnippet(value: unknown): Snippet | null {
  if (value === null || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const id = typeof o["id"] === "string" ? o["id"].trim() : "";
  const body = typeof o["body"] === "string" ? o["body"] : "";
  if (id.length === 0 || !ID_RE.test(id) || body.trim().length === 0) return null;
  const format = o["format"] === "plain-text" ? "plain-text" : "markdown";
  const scopeRaw = o["scope"];
  const scope: SnippetScope = scopeRaw === "workspace" ? "workspace" : "builtin";
  return freezeSnippet({
    id,
    name: typeof o["name"] === "string" && o["name"].trim().length > 0 ? o["name"].trim() : id,
    description: typeof o["description"] === "string" ? o["description"] : "",
    scope,
    format,
    body,
    variables: Array.isArray(o["variables"])
      ? (o["variables"] as unknown[]).filter(
          (v): v is string => typeof v === "string" && NAME_RE.test(v),
        )
      : [],
    legal: o["legal"] === true,
    footerOnly: o["footerOnly"] === true,
    updatedAt: typeof o["updatedAt"] === "string" ? o["updatedAt"] : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  ID_RE,
  NAME_RE,
  freezeSnippet,
  validateSnippetShape,
  parseSnippet,
});
