/**
 * Zipy AI — templates: template variables (templates batch 0).
 *
 * Template variables are distinct from content *placeholders* (see
 * `packages/content/src/personalization/variables.ts`). A content
 * placeholder is any slot a writer may reference in a step sentence. A
 * *template variable* is a named input the template requires before a
 * render can succeed — the equivalent of a function parameter: the version
 * of a release, the recipient of an onboarding email, the owner of an SOP.
 *
 * This module:
 *   1. `extractRequiredVariables(template)` — the union of the template's
 *      `requiredVariables` plus any `{{...}}` reference that appears in an
 *      operator-supplied template body. This is the derivation the render
 *      pipeline uses to decide what to ask for.
 *   2. `validateVariableBindings(template, bindings)` — checks every
 *      required variable has a binding and every binding matches the
 *      declared type. Missing bindings are returned as `TemplateGap`s, not
 *      thrown, so the reviewer UI can show what is missing.
 *   3. `applyTemplateVariables(template, bindings)` — returns a per-slot
 *      substitution map that the renderer uses. Unbound required slots are
 *      recorded as gaps; unbound optional slots are simply omitted.
 *
 * Design rules honoured:
 *  - No invented variables. The template declares them; the caller supplies
 *    the values. This module never fabricates a value and never derives one
 *    from a template's prose.
 *  - The variable grammar matches the content-side grammar (`{{name}}`,
 *    `{{name:fallback}}`) so a template author's syntax is uniform across
 *    the platform.
 *  - The module is pure: no clock reads, no randomness, no I/O.
 */

import type { Template } from "./library.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TemplateVariablesErrorCode =
  | "invalid-input"
  | "invalid-binding"
  | "duplicate-binding";

export class TemplateVariablesError extends Error {
  readonly code: TemplateVariablesErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TemplateVariablesErrorCode,
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

/** The same shape the content-side grammar uses. */
export const TEMPLATE_VARIABLE_TYPES = [
  "text",
  "email",
  "url",
  "number",
  "currency",
  "date",
  "phone",
  "identifier",
  "boolean",
] as const;
export type TemplateVariableType = (typeof TEMPLATE_VARIABLE_TYPES)[number];

/**
 * The caller's declaration of a variable *type*. The library itself only
 * states which *names* a template requires; a workspace may declare a type
 * per name so the renderer can validate a supplied value and the Q&A step
 * can prompt the editor with the right input widget.
 */
export interface TemplateVariableDeclaration {
  readonly name: string;
  readonly type: TemplateVariableType;
  readonly description: string;
  readonly sample: string | null;
  readonly required: boolean;
}

/** A binding the caller supplies for a render. */
export interface TemplateVariableBinding {
  readonly name: string;
  readonly value: string;
}

/** A single required variable that is missing a binding. */
export interface TemplateVariableGap {
  readonly name: string;
  readonly reason:
    | "missing-required-binding"
    | "invalid-binding-value"
    | "undeclared-type"
    | "duplicate-declaration";
  readonly detail: string;
}

/** The extracted variable requirement for a template. */
export interface TemplateVariableRequirement {
  readonly version: "template-variables/1";
  readonly templateId: string;
  /** Names required by the template, deduplicated and sorted. */
  readonly required: readonly string[];
  /** Names referenced but not declared required by the template's metadata. */
  readonly optional: readonly string[];
  /** Names present in the template body but unknown to any declaration. */
  readonly undeclared: readonly string[];
  readonly generatedAt: string;
}

/** The result of validating bindings against a requirement. */
export interface TemplateVariableValidation {
  readonly resolved: ReadonlyMap<string, string>;
  readonly missing: readonly TemplateVariableGap[];
  readonly valid: boolean;
}

/** The result of producing the substitution map for a render. */
export interface TemplateVariableApplication {
  /** Name → value for the renderer. Missing required slots are omitted. */
  readonly values: ReadonlyMap<string, string>;
  readonly gaps: readonly TemplateVariableGap[];
  readonly applied: boolean;
}

export interface ExtractRequirementInput {
  readonly template: Template;
  /**
   * Optional bodies to scan for `{{...}}` references. A template's built-in
   * sections may not carry any prose; the caller's draft provides the
   * bodies whose references must be resolvable.
   */
  readonly bodies?: readonly string[];
  /** Optional type declarations so the requirement carries the types. */
  readonly declarations?: readonly TemplateVariableDeclaration[];
}

export interface ValidateBindingsInput {
  readonly template: Template;
  readonly requirement: TemplateVariableRequirement;
  readonly bindings: readonly TemplateVariableBinding[];
  readonly declarations?: readonly TemplateVariableDeclaration[];
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The reference grammar: `{{ name }}` or `{{ name : fallback }}`. Kept
 * identical to the content-side module so a writer moving between a step
 * sentence and a template body uses one syntax.
 */
const REFERENCE_RE = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*(?::\s*([^{}]*?))?\s*\}\}/gu;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/u;

/* -------------------------------------------------------------------------- */
/* Public API — extraction                                                     */
/* -------------------------------------------------------------------------- */

export function extractRequiredVariables(
  input: ExtractRequirementInput,
): TemplateVariableRequirement {
  if (input === null || typeof input !== "object" || input.template === null) {
    throw new TemplateVariablesError(
      "extractRequiredVariables requires a template.",
      "invalid-input",
    );
  }
  const template = input.template;
  const declared = new Map<string, TemplateVariableDeclaration>();
  if (Array.isArray(input.declarations)) {
    for (const d of input.declarations) {
      if (d === null || typeof d !== "object") continue;
      const name = typeof d.name === "string" ? d.name.trim() : "";
      if (name.length === 0 || !NAME_RE.test(name)) continue;
      declared.set(name, d);
    }
  }

  const required = new Set<string>();
  for (const name of template.requiredVariables) required.add(name);

  const optional = new Set<string>();
  const undeclared = new Set<string>();

  const bodies = Array.isArray(input.bodies) ? input.bodies : [];
  for (const body of bodies) {
    if (typeof body !== "string" || body.length === 0) continue;
    REFERENCE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REFERENCE_RE.exec(body)) !== null) {
      const name = m[1];
      if (typeof name !== "string") continue;
      if (required.has(name)) continue;
      if (declared.has(name)) {
        if (declared.get(name)!.required) required.add(name);
        else optional.add(name);
      } else {
        undeclared.add(name);
      }
    }
  }

  return Object.freeze({
    version: "template-variables/1",
    templateId: template.id,
    required: Object.freeze(Array.from(required).sort()),
    optional: Object.freeze(Array.from(optional).sort()),
    undeclared: Object.freeze(Array.from(undeclared).sort()),
    generatedAt: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Public API — validation & application                                       */
/* -------------------------------------------------------------------------- */

export function validateVariableBindings(
  input: ValidateBindingsInput,
): TemplateVariableValidation {
  if (input === null || typeof input !== "object") {
    throw new TemplateVariablesError(
      "validateVariableBindings requires an input object.",
      "invalid-input",
    );
  }
  if (input.requirement === null || typeof input.requirement !== "object") {
    throw new TemplateVariablesError(
      "validateVariableBindings requires a requirement.",
      "invalid-input",
    );
  }
  if (!Array.isArray(input.bindings)) {
    throw new TemplateVariablesError(
      "`bindings` must be an array of {name, value}.",
      "invalid-binding",
    );
  }

  const declared = new Map<string, TemplateVariableDeclaration>();
  if (Array.isArray(input.declarations)) {
    for (const d of input.declarations) {
      if (d === null || typeof d !== "object") continue;
      const name = typeof d.name === "string" ? d.name.trim() : "";
      if (name.length === 0 || !NAME_RE.test(name)) continue;
      declared.set(name, d);
    }
  }

  const resolved = new Map<string, string>();
  const missing: TemplateVariableGap[] = [];
  const seenBindings = new Set<string>();

  for (const binding of input.bindings) {
    if (binding === null || typeof binding !== "object") continue;
    const name = typeof binding.name === "string" ? binding.name.trim() : "";
    const value = typeof binding.value === "string" ? binding.value : "";
    if (name.length === 0 || !NAME_RE.test(name)) {
      missing.push({
        name: name || "(unnamed)",
        reason: "invalid-binding-value",
        detail: `A binding had an invalid name "${name}".`,
      });
      continue;
    }
    if (seenBindings.has(name)) {
      missing.push({
        name,
        reason: "duplicate-binding",
        detail: `Variable "${name}" was bound more than once; the later binding was dropped.`,
      });
      continue;
    }
    seenBindings.add(name);

    const decl = declared.get(name);
    if (decl !== undefined && !isValidValue(value, decl.type)) {
      missing.push({
        name,
        reason: "invalid-binding-value",
        detail: `Binding for "${name}" is not a valid ${decl.type}.`,
      });
      continue;
    }
    resolved.set(name, value);
  }

  for (const name of input.requirement.required) {
    if (!resolved.has(name)) {
      missing.push({
        name,
        reason: "missing-required-binding",
        detail: `Template "${input.requirement.templateId}" requires a value for "${name}".`,
      });
    }
  }

  return Object.freeze({
    resolved,
    missing: Object.freeze(missing),
    valid: missing.length === 0,
  });
}

export function applyTemplateVariables(
  input: ValidateBindingsInput,
): TemplateVariableApplication {
  const validation = validateVariableBindings(input);
  return Object.freeze({
    values: validation.resolved,
    gaps: validation.missing,
    applied: validation.resolved.size > 0,
  });
}

/**
 * Convenience: map the requirement to a declaration list. Used by the
 * editor's "what does this template need?" pane. Undeclared names get a
 * default `text` declaration with an empty sample.
 */
export function describeRequirement(
  requirement: TemplateVariableRequirement,
  declarations: readonly TemplateVariableDeclaration[] = [],
): readonly TemplateVariableDeclaration[] {
  const byName = new Map<string, TemplateVariableDeclaration>();
  for (const d of declarations) {
    if (d === null || typeof d !== "object") continue;
    const name = typeof d.name === "string" ? d.name.trim() : "";
    if (name.length === 0 || !NAME_RE.test(name)) continue;
    byName.set(name, d);
  }
  const out: TemplateVariableDeclaration[] = [];
  for (const name of requirement.required) {
    out.push(
      byName.get(name) ?? {
        name,
        type: "text",
        description: "",
        sample: null,
        required: true,
      },
    );
  }
  for (const name of requirement.optional) {
    const existing = byName.get(name);
    if (existing !== undefined) {
      out.push(existing);
      continue;
    }
    out.push({
      name,
      type: "text",
      description: "",
      sample: null,
      required: false,
    });
  }
  return Object.freeze(out);
}

/** Rehydrate a `TemplateVariableRequirement` from persisted JSON. */
export function rehydrateRequirement(value: unknown): TemplateVariableRequirement {
  if (value === null || typeof value !== "object") {
    throw new TemplateVariablesError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const required = Array.isArray(r["required"])
    ? (r["required"] as unknown[]).filter((v): v is string => typeof v === "string" && NAME_RE.test(v))
    : [];
  const optional = Array.isArray(r["optional"])
    ? (r["optional"] as unknown[]).filter((v): v is string => typeof v === "string" && NAME_RE.test(v))
    : [];
  const undeclared = Array.isArray(r["undeclared"])
    ? (r["undeclared"] as unknown[]).filter((v): v is string => typeof v === "string" && NAME_RE.test(v))
    : [];
  return Object.freeze({
    version: "template-variables/1",
    templateId: typeof r["templateId"] === "string" ? r["templateId"] : "",
    required: Object.freeze(required.slice().sort()),
    optional: Object.freeze(optional.slice().sort()),
    undeclared: Object.freeze(undeclared.slice().sort()),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function isValidValue(value: string, type: TemplateVariableType): boolean {
  if (value.trim().length === 0) return false;
  switch (type) {
    case "text":
    case "identifier":
      return true;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case "url":
      try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    case "number":
      return Number.isFinite(Number(value));
    case "currency":
      return /^-?\d+(\.\d{1,6})?$/u.test(value.replace(/[,\s]/g, ""));
    case "date":
      return !Number.isNaN(Date.parse(value));
    case "phone":
      return /^[+()\d\s.-]{5,32}$/u.test(value);
    case "boolean":
      return ["true", "false", "yes", "no", "1", "0"].includes(value.toLowerCase());
    default:
      return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  REFERENCE_RE,
  NAME_RE,
  isValidValue,
});
