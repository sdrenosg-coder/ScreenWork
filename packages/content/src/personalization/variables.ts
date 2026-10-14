/**
 * Zipy AI — personalization: user-defined variables and placeholders
 * (content-generation, personalization batch 1).
 *
 * A variable is a named slot the writer may reference in prose and the
 * runtime substitutes with sample data during a rendered run (or with the
 * reader's values in a personalised run). The grammar is deliberate:
 *
 *   {{ variable_name }}          — bare reference
 *   {{ variable_name:fallback }} — reference with a default used when no
 *                                  value is supplied for the run
 *
 * The grammar is intentionally narrow so the substitution pass is
 * deterministic and a reviewer can read every reference in the draft
 * without parsing prose. A literal `{{` in prose is escaped as `\{{`; the
 * composer records every reference it cannot resolve as a gap (`Gap`) rather
 * than silently leaving the placeholder in place or inventing a value.
 *
 * Design rules honoured:
 *  - Nothing is invented. The caller supplies the variables and the run
 *    values. The substitution pass does not fabricate a value and does not
 *    derive one from the surrounding prose. A variable with no value and no
 *    fallback is recorded as an unresolved gap the reviewer fills in.
 *  - The pass never rewrites unsupported regions: backtick spans, URL
 *    spans and code fences are excluded so a snippet that happens to
 *    contain `{{...}}` does not get substituted.
 *  - Deterministic: given the same draft and the same values, the output
 *    text and the recorded changes are byte-identical.
 *  - The variable definitions are workspace-scoped by the caller (this
 *    module is a pure function of its inputs) so a personalization pass in
 *    one workspace cannot leak a variable into another workspace's draft.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type VariablesErrorCode =
  | "invalid-input"
  | "duplicate-variable"
  | "invalid-name"
  | "invalid-grammar";

export class VariablesError extends Error {
  readonly code: VariablesErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: VariablesErrorCode,
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
 * A variable type constrains how the value is presented and which sample
 * generators the caller may choose from. The composer itself does not
 * generate sample values — the caller supplies them — but the type is
 * carried through so the export layer can render a phone number in a
 * conventional format and an email address as a mailto link, and so a
 * reviewer can see what each variable means at a glance.
 */
export const VARIABLE_TYPES = [
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
export type VariableType = (typeof VARIABLE_TYPES)[number];

/** A caller-declared variable. */
export interface VariableDefinition {
  /** The reference name, e.g. `customer_name`. Lowercase snake_case. */
  readonly name: string;
  readonly type: VariableType;
  /** One-line description shown to the writer/reviewer. Never empty. */
  readonly description: string;
  /** Default fallback used when the run does not supply a value. */
  readonly fallback: string | null;
  /**
   * A sample value used when rendering a "sample data" preview. Supplied
   * by the caller; the composer never invents one.
   */
  readonly sample: string | null;
  /** True when the workflow cannot proceed without a value. Reviewer-visible. */
  readonly required: boolean;
  /** Provenance labels (guide, artefact, page) for the definition itself. */
  readonly sourceRefs: readonly string[];
}

/** The set of variables declared for a guide. */
export interface VariableSet {
  readonly version: "variables/1";
  readonly definitions: readonly VariableDefinition[];
  /** Structural problems found while composing. */
  readonly gaps: readonly VariableGap[];
  readonly generatedAt: string;
}

export type VariableGapReason =
  | "invalid-name"
  | "missing-description"
  | "duplicate-variable"
  | "no-fallback-or-sample";

export interface VariableGap {
  readonly name: string | null;
  readonly reason: VariableGapReason;
  readonly detail: string;
}

/** A single `{{name}}` reference found in prose. */
export interface VariableReference {
  /** The name as written, e.g. `customer_name`. */
  readonly name: string;
  /** The literal span as it appeared in the input, e.g. `{{ customer_name }}`. */
  readonly raw: string;
  /** The fallback suffix when the caller used `{{name:value}}`. */
  readonly inlineFallback: string | null;
  /** 0-based offset of the reference in the *unprotected* input. */
  readonly offset: number;
}

export interface VariableChange {
  readonly kind: "substituted" | "unresolved";
  readonly name: string;
  readonly raw: string;
  /** The substitution value; `null` when the reference could not be resolved. */
  readonly value: string | null;
}

export interface VariableApplication {
  /** The rewritten text. Unresolved references are left as the literal `{{...}}`. */
  readonly text: string;
  readonly applied: boolean;
  readonly changes: readonly VariableChange[];
  /** References that could not be resolved from run values, definition fallback or inline fallback. */
  readonly unresolved: readonly VariableReference[];
  /** References whose name is not declared in the set. */
  readonly undeclared: readonly VariableReference[];
}

export interface ComposeVariablesInput {
  readonly definitions: readonly VariableDefinitionInput[];
}

export interface VariableDefinitionInput {
  readonly name: string;
  readonly type?: VariableType;
  readonly description?: string | null;
  readonly fallback?: string | null;
  readonly sample?: string | null;
  readonly required?: boolean;
  readonly sourceRefs?: readonly string[];
}

export interface ApplyVariablesInput {
  readonly set: VariableSet;
  /** The text to rewrite. */
  readonly text: string;
  /**
   * Run values keyed by variable name. Values supplied here win over the
   * definition's `sample` (used for a preview) and over the definition's
   * `fallback`.
   */
  readonly values?: Readonly<Record<string, string>>;
  /**
   * When `"sample"`, the definition's `sample` is used as the value so a
   * reviewer can preview with representative data. When `"fallback"`, the
   * definition's `fallback` is used. When `"none"`, only explicit `values`
   * are used and unresolved references are recorded as gaps.
   * Defaults to `"fallback"`.
   */
  readonly useDefinitionFallback?: "sample" | "fallback" | "none";
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Variable name grammar. Start with a lowercase ascii letter, then
 * lowercase letters, digits or underscores. This is deliberately narrow so
 * the reference syntax is unambiguous in prose without escaping.
 */
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * The reference pattern. Captures:
 *   1. the name
 *   2. the optional `:fallback` suffix
 * Whitespace inside the braces is tolerated.
 */
const REFERENCE_RE = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*(?::\s*([^{}]*?))?\s*\}\}/gu;

/**
 * The escape for a literal `{{` in prose. Uses a private-use sentinel so
 * the substitution pass can strip the backslash at the end and the escape
 * never collides with user text.
 */
const ESCAPED_OPEN = /\{\{\{/gu;
const ESCAPE_SENTINEL_OPEN = "\u0001L{{";
const ESCAPE_SENTINEL_CLOSE = "}}\u0001";

const PROTECTED_OPEN = "\u0001P";
const PROTECTED_CLOSE = "P\u0001";

/* -------------------------------------------------------------------------- */
/* composeVariables                                                            */
/* -------------------------------------------------------------------------- */

export function composeVariables(
  definitions: readonly VariableDefinitionInput[],
): VariableSet {
  if (!Array.isArray(definitions)) {
    throw new VariablesError("`definitions` must be an array.", "invalid-input");
  }
  const gaps: VariableGap[] = [];
  const out: VariableDefinition[] = [];
  const seen = new Set<string>();

  for (const raw of definitions) {
    if (raw === null || typeof raw !== "object") {
      gaps.push({
        name: null,
        reason: "invalid-name",
        detail: "A variable definition was supplied that is not an object.",
      });
      continue;
    }
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name.length === 0 || !NAME_RE.test(name)) {
      gaps.push({
        name: name.length > 0 ? name : null,
        reason: "invalid-name",
        detail:
          name.length === 0
            ? "A variable definition was supplied without a name."
            : `Variable name "${name}" is invalid; expected lowercase snake_case starting with a letter.`,
      });
      continue;
    }
    if (seen.has(name)) {
      gaps.push({
        name,
        reason: "duplicate-variable",
        detail: `Variable "${name}" was declared more than once; the later declaration was dropped.`,
      });
      continue;
    }
    seen.add(name);

    const description =
      typeof raw.description === "string" ? raw.description.trim() : "";
    if (description.length === 0) {
      gaps.push({
        name,
        reason: "missing-description",
        detail: `Variable "${name}" has no description; a reviewer cannot tell what it means.`,
      });
    }

    const fallback = pruneString(raw.fallback);
    const sample = pruneString(raw.sample);
    if (raw.required === true && fallback === null && sample === null) {
      gaps.push({
        name,
        reason: "no-fallback-or-sample",
        detail: `Variable "${name}" is marked required but has neither a fallback nor a sample value; every render of this guide will need a supplied value.`,
      });
    }

    out.push({
      name,
      type: isVariableType(raw.type) ? raw.type : "text",
      description: description.length > 0 ? description : `Variable ${name}`,
      fallback,
      sample,
      required: raw.required === true,
      sourceRefs: Array.isArray(raw.sourceRefs)
        ? raw.sourceRefs.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        : [],
    });
  }

  return {
    version: "variables/1",
    definitions: out.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    gaps,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* findReferences                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Find every `{{name}}` / `{{name:fallback}}` reference in the text. Skips
 * backtick spans, URL spans and `\{{` escapes. Offsets refer to the input
 * text (before protection).
 */
export function findReferences(text: string): readonly VariableReference[] {
  if (typeof text !== "string") {
    throw new VariablesError("findReferences requires a string.", "invalid-input");
  }
  if (text.length === 0) return [];

  const spans = collectProtectedSpans(text);
  const out: VariableReference[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex — a module-level /g regex has state.
  REFERENCE_RE.lastIndex = 0;
  while ((match = REFERENCE_RE.exec(text)) !== null) {
    const offset = match.index;
    if (isInSpans(offset, match[0].length, spans)) continue;
    // A preceding unescaped backslash immediately before `{{` escapes it.
    if (offset > 0 && text.charAt(offset - 1) === "\\") {
      // And an odd count of backslashes means escaped; even means literal.
      let n = 0;
      let j = offset - 1;
      while (j >= 0 && text.charAt(j) === "\\") {
        n += 1;
        j -= 1;
      }
      if (n % 2 === 1) continue;
    }
    const name = match[1] ?? "";
    const fallbackRaw = match[2];
    const inlineFallback =
      typeof fallbackRaw === "string" && fallbackRaw.trim().length > 0
        ? fallbackRaw.trim()
        : null;
    out.push({
      name,
      raw: match[0],
      inlineFallback,
      offset,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* applyVariables                                                              */
/* -------------------------------------------------------------------------- */

export function applyVariables(input: ApplyVariablesInput): VariableApplication {
  if (input === null || typeof input !== "object") {
    throw new VariablesError("applyVariables requires an input object.", "invalid-input");
  }
  if (input.set === null || typeof input.set !== "object") {
    throw new VariablesError("applyVariables requires a variable set.", "invalid-input");
  }
  const text = typeof input.text === "string" ? input.text : "";
  if (text.length === 0) {
    return { text: "", applied: false, changes: [], unresolved: [], undeclared: [] };
  }

  const mode = input.useDefinitionFallback ?? "fallback";
  const values = input.values ?? {};
  const byName = new Map<string, VariableDefinition>();
  for (const def of input.set.definitions) byName.set(def.name, def);

  const references = findReferences(text);
  const changes: VariableChange[] = [];
  const unresolved: VariableReference[] = [];
  const undeclared: VariableReference[] = [];
  if (references.length === 0) {
    return { text: normaliseEscapes(text), applied: false, changes, unresolved, undeclared };
  }

  // Rewrite right-to-left so offsets stay stable.
  const ordered = references.slice().sort((a, b) => b.offset - a.offset);
  let working = text;
  for (const ref of ordered) {
    const declared = byName.get(ref.name);
    let value: string | null = null;
    if (Object.prototype.hasOwnProperty.call(values, ref.name)) {
      const v = values[ref.name];
      if (typeof v === "string") value = v;
    }
    if (value === null && declared !== undefined) {
      if (mode === "sample" && declared.sample !== null) value = declared.sample;
      else if (mode !== "none") {
        if (ref.inlineFallback !== null) value = ref.inlineFallback;
        else if (declared.fallback !== null) value = declared.fallback;
      } else if (ref.inlineFallback !== null) {
        value = ref.inlineFallback;
      }
    } else if (value === null && ref.inlineFallback !== null) {
      // Undeclared name with an inline fallback: the fallback is used, but
      // the reference is still recorded as undeclared for the reviewer.
      value = ref.inlineFallback;
    }

    if (value === null) {
      unresolved.push(ref);
      changes.push({
        kind: "unresolved",
        name: ref.name,
        raw: ref.raw,
        value: null,
      });
      continue;
    }
    working = working.slice(0, ref.offset) + value + working.slice(ref.offset + ref.raw.length);
    changes.push({
      kind: "substituted",
      name: ref.name,
      raw: ref.raw,
      value,
    });
    if (declared === undefined) undeclared.push(ref);
  }

  return {
    text: normaliseEscapes(working),
    applied: changes.some((c) => c.kind === "substituted"),
    changes,
    unresolved,
    undeclared,
  };
}

/**
 * Apply variables across a deep content structure. Only recognised prose
 * keys are visited; the substitution and the recorded changes are attached
 * to the top-level result so the caller can persist the diff.
 */
export function applyVariablesDeep<T>(
  value: T,
  input: Omit<ApplyVariablesInput, "text">,
): {
  readonly result: T;
  readonly applied: boolean;
  readonly changes: readonly VariableChange[];
  readonly unresolved: readonly VariableReference[];
  readonly undeclared: readonly VariableReference[];
} {
  const changes: VariableChange[] = [];
  const unresolved: VariableReference[] = [];
  const undeclared: VariableReference[] = [];
  let anyApplied = false;

  const result = walk(value, 0) as T;

  function walk(node: unknown, depth: number): unknown {
    if (depth > 8) return node;
    if (typeof node === "string") {
      const applied = applyVariables({ ...input, text: node });
      if (applied.applied) anyApplied = true;
      changes.push(...applied.changes);
      unresolved.push(...applied.unresolved);
      undeclared.push(...applied.undeclared);
      return applied.text;
    }
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((v) => walk(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = PROSE_KEYS.has(k) ? walk(v, depth + 1) : v;
    }
    return out;
  }

  return { result, applied: anyApplied, changes, unresolved, undeclared };
}

/* -------------------------------------------------------------------------- */
/* Directives                                                                  */
/* -------------------------------------------------------------------------- */

export function buildVariablesDirectives(set: VariableSet): string {
  const lines: string[] = [];
  lines.push("Variable substitutions available in this guide:");
  if (set.definitions.length === 0) {
    lines.push(
      "- No variables are declared; write concrete prose. Do not invent placeholder syntax.",
    );
    return lines.join("\n");
  }
  for (const def of set.definitions) {
    const parts = [`{{${def.name}}}`];
    if (def.description.length > 0) parts.push(`— ${def.description}`);
    if (def.type !== "text") parts.push(`[${def.type}]`);
    if (def.required) parts.push("(required)");
    lines.push(`- ${parts.join(" ")}`);
  }
  lines.push(
    "Rules for using variables:",
    "    - Reference a variable exactly as shown, e.g. `{{customer_name}}`. Do not add or remove braces or spaces.",
    "    - Use the variable only in a sentence whose meaning is unchanged when the placeholder is replaced with a concrete value.",
    "    - Do not invent variables that are not listed above. If a slot is needed but not declared, flag it so a reviewer can add it.",
    "    - Do not write a literal `{{` unless you mean a variable; escape a literal as `\\{{`.",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Rehydrate                                                                   */
/* -------------------------------------------------------------------------- */

export function rehydrateVariables(value: unknown): VariableSet {
  if (value === null || typeof value !== "object") {
    throw new VariablesError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const definitions: VariableDefinition[] = [];
  if (Array.isArray(r["definitions"])) {
    for (const entry of r["definitions"] as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const name = typeof e["name"] === "string" ? e["name"].trim() : "";
      if (name.length === 0 || !NAME_RE.test(name)) continue;
      definitions.push({
        name,
        type: isVariableType(e["type"]) ? e["type"] : "text",
        description: typeof e["description"] === "string" ? e["description"] : "",
        fallback: pruneString(e["fallback"]),
        sample: pruneString(e["sample"]),
        required: e["required"] === true,
        sourceRefs: Array.isArray(e["sourceRefs"])
          ? (e["sourceRefs"] as unknown[]).filter((s): s is string => typeof s === "string")
          : [],
      });
    }
  }
  const gaps: VariableGap[] = [];
  if (Array.isArray(r["gaps"])) {
    for (const entry of r["gaps"] as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const reason = e["reason"];
      if (
        reason !== "invalid-name" &&
        reason !== "missing-description" &&
        reason !== "duplicate-variable" &&
        reason !== "no-fallback-or-sample"
      ) {
        continue;
      }
      gaps.push({
        name: typeof e["name"] === "string" ? e["name"] : null,
        reason,
        detail: typeof e["detail"] === "string" ? e["detail"] : "",
      });
    }
  }
  return {
    version: "variables/1",
    definitions,
    gaps,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

const PROSE_KEYS = new Set<string>([
  "title",
  "summary",
  "description",
  "instruction",
  "text",
  "sentence",
  "introduction",
  "question",
  "answer",
  "note",
  "body",
  "content",
]);

function isVariableType(v: unknown): v is VariableType {
  return (
    v === "text" ||
    v === "email" ||
    v === "url" ||
    v === "number" ||
    v === "currency" ||
    v === "date" ||
    v === "phone" ||
    v === "identifier" ||
    v === "boolean"
  );
}

function pruneString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

interface ProtectedSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Identify regions of the input that the substitution pass must not touch:
 * backtick spans, fenced code blocks, URLs and the `\{{` escape sentinel.
 * Returns half-open ranges in the original text.
 */
function collectProtectedSpans(text: string): readonly ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];

  // Fenced code blocks first, so a backtick inside a fence does not create
  // an extra span.
  const fenceRe = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }

  // Inline code spans — single-backtick pairs, not inside a fence.
  const inlineRe = /`[^`\n]*`/g;
  while ((m = inlineRe.exec(text)) !== null) {
    if (!isInSpans(m.index, m[0].length, spans)) {
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  // URL spans.
  const urlRe = /https?:\/\/[^\s)>\]}"']+/g;
  while ((m = urlRe.exec(text)) !== null) {
    if (!isInSpans(m.index, m[0].length, spans)) {
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  return spans.sort((a, b) => a.start - b.start);
}

function isInSpans(
  offset: number,
  length: number,
  spans: readonly ProtectedSpan[],
): boolean {
  const end = offset + length;
  for (const s of spans) {
    if (offset < s.end && end > s.start) return true;
  }
  return false;
}

/**
 * Convert the escape sentinel back to a literal `{{`. Also collapses a
 * doubled escape if a caller double-escapes.
 */
function normaliseEscapes(text: string): string {
  return text.replace(ESCAPED_OPEN, "{{");
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  NAME_RE,
  REFERENCE_RE,
  collectProtectedSpans,
  isInSpans,
  normaliseEscapes,
  isVariableType,
  pruneString,
  ESCAPE_SENTINEL_OPEN,
  ESCAPE_SENTINEL_CLOSE,
  PROTECTED_OPEN,
  PROTECTED_CLOSE,
});
