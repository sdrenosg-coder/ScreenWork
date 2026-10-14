/**
 * Zipy AI — accessibility-tree extraction and compaction.
 *
 * The accessibility tree is the LLM's primary view of a page: it carries
 * roles, accessible names, states and a small set of durable attributes while
 * being roughly an order of magnitude smaller than the raw DOM. This module
 * owns the shape of that snapshot so URL ingest, workflow synthesis and
 * UI-change detection all speak the same language.
 *
 * Design notes:
 *  - This module is pure. It does not launch a browser. It accepts the output
 *    of `page.accessibility.snapshot()` (Playwright) or an equivalent
 *    `getComputedAccessibleNode`-style object and normalises it into a
 *    `A11yNode` tree. The browser driver lives in apps/worker.
 *  - Interactive detection is conservative: a node is "interactive" when its
 *    role is in a known set OR it has a click/focus affordance implied by its
 *    role (button, link, textbox, combobox, checkbox, radio, tab, menuitem,
 *    option, switch, slider, spinbutton, searchbox). Generic containers are
 *    not interactive even when focusable, because they produce noisy plans.
 *  - `compactA11yTree` prunes nodes that carry no semantic signal (unchanged
 *    state, empty generic wrappers) and truncates long text, so the output
 *    fits comfortably in an LLM context window. Compaction is deterministic:
 *    the same input always yields the same output, which is required for the
 *    prompt-cache and content-hash layers.
 *  - No credentials, no network, no I/O. Every function is synchronously pure
 *    except `extractInteractiveElements`, which is pure too (it walks the tree
 *    and returns a list).
 */

/* -------------------------------------------------------------------------- */
/* Role vocabulary                                                             */
/* -------------------------------------------------------------------------- */

/**
 * ARIA roles treated as interactive. Mirrors the WAI-ARIA widget roles plus
 * native HTML interactive roles Playwright surfaces. Adding a role here changes
 * what the element index considers actionable, so this list is intentionally
 * explicit rather than pattern-matched.
 */
export const INTERACTIVE_ROLES = [
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "checkbox",
  "switch",
  "tab",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "slider",
  "spinbutton",
  "scrollbar",
  "treeitem",
  "gridcell",
  "columnheader",
  "rowheader",
  "cell",
  "textfield",
  "select",
  "listitem",
] as const;

export type InteractiveRole = (typeof INTERACTIVE_ROLES)[number];

/** Roles whose presence marks a region as a form container. */
export const CONTAINER_ROLES = [
  "form",
  "dialog",
  "alertdialog",
  "navigation",
  "main",
  "region",
  "toolbar",
  "menu",
  "listbox",
  "tablist",
  "tabpanel",
  "table",
  "grid",
  "tree",
  "group",
] as const;

export type ContainerRole = (typeof CONTAINER_ROLES)[number];

/* -------------------------------------------------------------------------- */
/* Node shapes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A normalised accessibility node. This is our canonical shape — callers never
 * see Playwright's raw snapshot directly because its exact fields vary between
 * browser engines and Playwright versions.
 */
export interface A11yNode {
  /** DOM id of the node in the source page, if Playwright supplied one. */
  readonly id: string | null;
  /** ARIA role, e.g. "button", "textbox", "heading". */
  readonly role: string;
  /** Accessible name as computed by the browser's accessibility engine. */
  readonly name: string;
  /** Accessible description, if any. */
  readonly description: string | null;
  /** Current value for value-bearing roles (textbox, slider, checkbox). */
  readonly value: string | number | boolean | null;
  /** Supplementary attributes: checked, disabled, expanded, pressed, level… */
  readonly states: Readonly<Record<string, string | number | boolean>>;
  /** Whether the browser reports this node as focusable (best effort). */
  readonly focusable: boolean;
  /** Whether the browser reports this node as interactive / actionable. */
  readonly interactive: boolean;
  /** Whether the node is currently expaned/hidden where applicable. */
  readonly expanded: boolean | null;
  /** Depth in the tree, 0-based. Preserved so synthesis can reason about layout. */
  readonly depth: number;
  /** Ordered children. Absent children are `[]`, never `null`. */
  readonly children: readonly A11yNode[];
  /**
   * The DOM path Playwright recorded when the snapshot was taken, if the
   * caller supplied one (Playwright does not include this in the default
   * snapshot — the worker augments the raw snapshot with `_domPath`). Kept
   * opaque here; the element index owns selector generation.
   */
  readonly domPath: string | null;
}

/**
 * The raw snapshot shape tolerated by this module. It is intentionally a loose
 * `Record<string, unknown>` view so a Playwright engine change does not force a
 * rewrite of this module. `parseA11ySnapshot` reads only well-known fields and
 * falls back to safe defaults elsewhere.
 */
export type RawA11ySnapshot = Record<string, unknown> | null | undefined;

/* -------------------------------------------------------------------------- */
/* Role classification                                                         */
/* -------------------------------------------------------------------------- */

const INTERACTIVE_ROLE_SET: ReadonlySet<string> = new Set(
  INTERACTIVE_ROLES as readonly string[],
);
const CONTAINER_ROLE_SET: ReadonlySet<string> = new Set(
  CONTAINER_ROLES as readonly string[],
);

export function isInteractiveRole(role: string): boolean {
  if (typeof role !== "string") return false;
  // Playwright normalises roles to lowercase words with spaces (e.g. "text box"
  // becomes "textbox") — but defensive lowercasing costs nothing.
  return INTERACTIVE_ROLE_SET.has(role.toLowerCase());
}

export function isContainerRole(role: string): boolean {
  if (typeof role !== "string") return false;
  return CONTAINER_ROLE_SET.has(role.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "mixed") return false; // aria-checked="mixed" is not a boolean
  }
  return null;
}

/**
 * Extract the small set of state booleans that later phases reason about.
 * Unknown keys are preserved so a browser engine that adds new attributes does
 * not require a code change here — downstream consumers can still read them.
 */
function extractStates(raw: Record<string, unknown>): Readonly<Record<string, string | number | boolean>> {
  const states: Record<string, string | number | boolean> = {};
  const known = [
    "checked",
    "disabled",
    "expanded",
    "pressed",
    "selected",
    "readonly",
    "required",
    "invalid",
    "busy",
    "multiselectable",
    "level",
    "posinset",
    "setsize",
    "orientation",
    "autocomplete",
    "haspopup",
  ] as const;
  for (const key of known) {
    const rawValue = raw[key];
    if (rawValue === undefined || rawValue === null) continue;
    if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
      states[key] = rawValue;
    }
  }
  return states;
}

/**
 * Convert a raw Playwright accessibility snapshot node (and its descendants)
 * into our normalised `A11yNode`. `depth` is materialised here so callers
 * never need to re-walk the tree just to compute indentation.
 */
export function parseA11ySnapshot(raw: RawA11ySnapshot, depth = 0): A11yNode | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const roleRaw = asString(record["role"]) ?? "";
  const role = roleRaw.length > 0 ? roleRaw.toLowerCase() : "generic";
  const name = asString(record["name"]) ?? "";
  const description = asString(record["description"]);
  const value = record["value"] as string | number | boolean | null | undefined;
  const id = asString(record["id"]) ?? asString(record["_id"]);
  const domPath = asString(record["_domPath"]);
  const focusable = asBoolean(record["focusable"]) ?? false;
  const interactive = asBoolean(record["interactive"]) ?? isInteractiveRole(role);
  const expanded = asBoolean(record["expanded"]);

  const childrenRaw = record["children"];
  const children: A11yNode[] = [];
  if (Array.isArray(childrenRaw)) {
    for (const child of childrenRaw) {
      const parsed = parseA11ySnapshot(child as RawA11ySnapshot, depth + 1);
      if (parsed !== null) children.push(parsed);
    }
  }

  return {
    id,
    role,
    name,
    description,
    value: value === undefined ? null : (value as string | number | boolean | null),
    states: extractStates(record),
    focusable,
    interactive,
    expanded,
    depth,
    children,
    domPath,
  };
}

/** Walk every node in a tree. Pre-order; deterministic. */
export function* walkA11y(node: A11yNode): Generator<A11yNode> {
  yield node;
  for (const child of node.children) {
    yield* walkA11y(child);
  }
}

/** Count nodes, interactive nodes and max depth. */
export interface A11yStats {
  readonly nodeCount: number;
  readonly interactiveCount: number;
  readonly maxDepth: number;
  readonly namedCount: number;
}

export function a11yStats(root: A11yNode): A11yStats {
  let nodeCount = 0;
  let interactiveCount = 0;
  let namedCount = 0;
  let maxDepth = 0;
  for (const node of walkA11y(root)) {
    nodeCount += 1;
    if (node.interactive) interactiveCount += 1;
    if (node.name.trim().length > 0) namedCount += 1;
    if (node.depth > maxDepth) maxDepth = node.depth;
  }
  return { nodeCount, interactiveCount, maxDepth, namedCount };
}

/* -------------------------------------------------------------------------- */
/* Compaction                                                                  */
/* -------------------------------------------------------------------------- */

export interface CompactOptions {
  /** Truncate accessible names longer than this (characters). Default 120. */
  readonly maxNameLength?: number;
  /** Truncate values longer than this (characters). Default 160. */
  readonly maxValueLength?: number;
  /** Drop descendants deeper than this. Default 60 (very generous). */
  readonly maxDepth?: number;
  /**
   * When true, drop nodes that carry no signal: unnamed generic containers
   * with no interactive descendants. Defaults to true.
   */
  readonly dropEmptyGenerics?: boolean;
}

const DEFAULT_COMPACT: Required<CompactOptions> = {
  maxNameLength: 120,
  maxValueLength: 160,
  maxDepth: 60,
  dropEmptyGenerics: true,
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function stringifyValue(value: string | number | boolean | null, max: number): string | null {
  if (value === null) return null;
  if (typeof value === "string") return truncate(value, max);
  return String(value);
}

/**
 * Produce a compacted copy of the tree suitable for embedding in prompts and
 * hashing for the UI-change detector. Compaction is a pure function of the
 * inputs so two identical snapshots produce byte-identical output.
 */
export function compactA11yTree(root: A11yNode, opts?: CompactOptions): A11yNode {
  const options = { ...DEFAULT_COMPACT, ...(opts ?? {}) };
  return compactNode(root, options);
}

function compactNode(node: A11yNode, options: Required<CompactOptions>): A11yNode {
  const children: A11yNode[] = [];
  for (const child of node.children) {
    if (child.depth > options.maxDepth) continue;
    const compacted = compactNode(child, options);
    if (
      options.dropEmptyGenerics &&
      compacted.role === "generic" &&
      compacted.name.length === 0 &&
      compacted.children.length === 0 &&
      !compacted.interactive
    ) {
      continue;
    }
    children.push(compacted);
  }

  const rawName = node.name ?? "";
  const name = truncate(rawName, options.maxNameLength);

  return {
    id: node.id,
    role: node.role,
    name,
    description: node.description === null ? null : truncate(node.description, options.maxNameLength),
    value: node.value === null ? null : (typeof node.value === "string" ? truncate(node.value, options.maxValueLength) : node.value),
    states: node.states,
    focusable: node.focusable,
    interactive: node.interactive,
    expanded: node.expanded,
    depth: node.depth,
    children,
    domPath: node.domPath,
  };
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Render a compacted tree as indented plain text. This is what the LLM sees.
 * The format is stable so prompt-cache keys do not drift across releases:
 *
 *   [0] heading "Account Settings"
 *     [1] textbox "Email" value="user@example.com"
 *     [1] button "Save"
 *
 * `interactive` marks a node with a leading `*` so a small model can spot the
 * actionable items without parsing a separate JSON structure.
 */
export function serializeA11yTree(
  root: A11yNode,
  opts?: { readonly markInteractive?: boolean; readonly includeStates?: boolean },
): string {
  const markInteractive = opts?.markInteractive ?? true;
  const includeStates = opts?.includeStates ?? true;
  const lines: string[] = [];
  for (const node of walkA11y(root)) {
    const indent = "  ".repeat(node.depth);
    const marker = markInteractive && node.interactive ? "*" : " ";
    const parts: string[] = [`${indent}${marker} [${node.depth}] ${node.role}`];
    if (node.name.length > 0) parts.push(JSON.stringify(node.name));
    if (node.value !== null && node.value !== "") {
      parts.push(`value=${JSON.stringify(stringifyValue(node.value, 160))}`);
    }
    if (includeStates) {
      const stateKeys = Object.keys(node.states);
      if (stateKeys.length > 0) {
        const stateRepr = stateKeys
          .sort()
          .map((k) => `${k}=${JSON.stringify(node.states[k])}`)
          .join(" ");
        parts.push(stateRepr);
      }
    }
    if (node.description !== null && node.description.length > 0) {
      parts.push(`desc=${JSON.stringify(node.description)}`);
    }
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Reconstruct from a stored payload                                           */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild an `A11yNode` tree from a value that has been through
 * `JSON.parse(JSON.stringify(...))`. Used when the worker reads back a snapshot
 * it stored as an artifact's metadata. Validates shape and returns `null` for
 * structurally-invalid input so callers can fail with a specific error instead
 * of dereferencing `undefined`.
 */
export function hydrateA11yNode(value: unknown): A11yNode | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const role = typeof r["role"] === "string" ? (r["role"] as string) : null;
  if (role === null) return null;
  const children: A11yNode[] = [];
  if (Array.isArray(r["children"])) {
    for (const child of r["children"]) {
      const parsed = hydrateA11yNode(child);
      if (parsed !== null) children.push(parsed);
    }
  }
  const id = typeof r["id"] === "string" ? (r["id"] as string) : null;
  const name = typeof r["name"] === "string" ? (r["name"] as string) : "";
  const description = typeof r["description"] === "string" ? (r["description"] as string) : null;
  const valueRaw = r["value"];
  const value: string | number | boolean | null =
    valueRaw === null || valueRaw === undefined
      ? null
      : typeof valueRaw === "string" || typeof valueRaw === "number" || typeof valueRaw === "boolean"
        ? (valueRaw as string | number | boolean)
        : null;
  const states: Record<string, string | number | boolean> = {};
  if (r["states"] && typeof r["states"] === "object") {
    for (const [k, v] of Object.entries(r["states"] as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        states[k] = v;
      }
    }
  }
  const focusable = typeof r["focusable"] === "boolean" ? (r["focusable"] as boolean) : false;
  const interactive =
    typeof r["interactive"] === "boolean" ? (r["interactive"] as boolean) : isInteractiveRole(role);
  const expanded = typeof r["expanded"] === "boolean" ? (r["expanded"] as boolean) : null;
  const depth = typeof r["depth"] === "number" && Number.isFinite(r["depth"]) ? (r["depth"] as number) : 0;
  const domPath = typeof r["domPath"] === "string" ? (r["domPath"] as string) : null;
  return {
    id,
    role,
    name,
    description,
    value,
    states,
    focusable,
    interactive,
    expanded,
    depth,
    children,
    domPath,
  };
}

/** A specific error used when a snapshot's shape is not usable. */
export class A11yParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A11yParseError";
  }
}

/**
 * Parse a raw snapshot and throw a descriptive `A11yParseError` when the
 * result is unusable (null root or no nodes). The worker uses this so a
 * failure surfaces at ingest time rather than during synthesis.
 */
export function parseA11ySnapshotOrThrow(raw: RawA11ySnapshot): A11yNode {
  const parsed = parseA11ySnapshot(raw, 0);
  if (parsed === null) {
    throw new A11yParseError(
      "Accessibility snapshot was empty or null. The page may not have finished loading, or the browser wrote an empty tree.",
    );
  }
  const stats = a11yStats(parsed);
  if (stats.nodeCount === 0) {
    throw new A11yParseError("Accessibility snapshot contained no usable nodes.");
  }
  return parsed;
}
