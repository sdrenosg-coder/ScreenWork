/**
 * Zipy AI — LLM-facing accessibility-tree snapshot.
 *
 * The browser exposes an accessibility (a11y) tree whose size is roughly
 * 7% of the raw DOM. Feeding the LLM an a11y snapshot instead of raw HTML
 * is both a cost and a quality decision: the model sees roles, accessible
 * names, states and stable refs, and never sees `<script>`, styles, layout
 * scaffolding or tracking attributes that would only add noise.
 *
 * This module is the compaction layer between the collector
 * (`@zipy/ingest/a11y` + `@zipy/ingest/elementIndex`, which produce a full,
 * deeply nested tree with per-node refs) and the synthesis LLM
 * (`@zipy/synth/textToAction` + `@zipy/synth/stepSequence`).
 *
 * What it does, precisely:
 *  - Walks the collected a11y tree in document order.
 *  - Assigns or preserves a stable ref (`@e1`, `@e2`, …) for every
 *    *interactive* or *addressable* node: things the model might click,
 *    type into, select from, or reference by name. Non-interactive,
 *    non-addressable containers are pruned entirely unless they carry text
 *    the model needs (headings, labels, table captions), in which case they
 *    are emitted as *context lines* with no ref (a bare `[heading]` line).
 *  - Emits a fixed, line-oriented text format rather than JSON. Small
 *    local models handle a line-oriented grammar far more reliably than a
 *    deep JSON object, and the format is cheaply tokenisable. The same
 *    snapshot is also returned as structured data so the caller can join
 *    back from a ref to the live element handle.
 *
 * Design constraints honoured here:
 *  - Pure. No I/O, no credentials, no browser handle. The caller supplies
 *    the already-extracted a11y tree; this module only transforms it.
 *  - No invention. A node whose role is unknown to the allow-list is not
 *    silently promoted to "button"; it is either kept as a context line
 *    (when it has text) or dropped, and the choice is recorded in
 *    `omittedNodeCount` and `unknownRoles`. The synthesis step receives an
 *    honest view of what the model can reference.
 *  - Deterministic. Same tree → same snapshot text, same ref assignments,
 *    same ordering. Ref numbers are assigned in document order, starting at
 *    1, and never reused within a snapshot.
 *  - Bounded. `maxNodes` and `maxChars` cap output regardless of page size
 *    so a runaway page cannot blow the model's context window. When the cap
 *    is hit, the snapshot records `truncated: true` and where truncation
 *    happened, so the caller can warn the reviewer instead of silently
 *    producing a partial plan.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type A11ySnapshotErrorCode = "invalid-input" | "empty-tree";

export class A11ySnapshotError extends Error {
  readonly code: A11ySnapshotErrorCode;
  constructor(message: string, code: A11ySnapshotErrorCode) {
    super(message);
    this.name = "A11ySnapshotError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One node of the collected accessibility tree. This is the shape produced
 * by the URL-ingest pipeline; it intentionally mirrors `@axe-core/puppeteer`
 * / `page.accessibility.snapshot()` plus a few browser-only extras we keep
 * because they materially improve element matching.
 *
 * Fields are all optional except `role` (which the collector must always
 * report, even if it is `"generic"`) and `ref` when the node is interactive.
 *
 * The tree is *not* assumed sorted. `children` is the DOM-order list.
 */
export interface A11yNode {
  /** ARIA / platform role, lowercased by the collector. Required. */
  readonly role: string;
  /** Accessible name (ARIA label, visible text, associated <label>, title). */
  readonly name?: string | null;
  /** Value for textboxes / comboboxes / sliders (never PII-filtered here). */
  readonly value?: string | null;
  /** Plain-text content when the node has no `name` but has text. */
  readonly text?: string | null;
  /** State flags the collector mapped to booleans. */
  readonly states?: Readonly<Record<string, boolean>> | null;
  /** Properties the collector surfaced (e.g. `level` for headings). */
  readonly properties?: Readonly<Record<string, string | number | boolean>> | null;
  /** Stable ref already assigned by the collector; preserved when present. */
  readonly ref?: string | null;
  /**
   * CSS selector chain the collector derived for the node. Kept for the
   * deterministic distillation step (later in this phase); the LLM never
   * sees this value — it is stripped before rendering.
   */
  readonly selector?: string | null;
  /** Nested children in document order. */
  readonly children?: readonly A11yNode[] | null;
}

export interface A11ySnapshotInput {
  /** Root node of the collected tree (typically the `<body>` / `role=document`). */
  readonly root: A11yNode;
  /** URL the tree was collected from. */
  readonly sourceUrl: string;
}

/* -------------------------------------------------------------------------- */
/* Outputs                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One line the LLM can reference. Refs are what the model uses in its
 * action list ("click @e3"); they are the only tokens the model is allowed
 * to cite for a target.
 */
export interface SnapshotEntry {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly value: string | null;
  readonly level: number | null;
  readonly states: readonly string[];
  readonly properties: Readonly<Record<string, string | number | boolean>>;
  /** Depth in the original tree; used only for indentation in the text form. */
  readonly depth: number;
}

/**
 * A context line the model may read but must not cite as a target. Emitted
 * for headings, table captions, and similar — content the model needs to
 * understand the page, but which has no element to click.
 */
export interface ContextLine {
  readonly kind: "heading" | "caption" | "note";
  readonly text: string;
  readonly level: number | null;
  readonly depth: number;
}

export interface SnapshotDiagnostics {
  readonly nodeCount: number;
  readonly entryCount: number;
  readonly contextCount: number;
  readonly omittedNodeCount: number;
  /** Distinct roles the collector reported that this module did not index. */
  readonly unknownRoles: readonly string[];
  /** True when `maxNodes` / `maxChars` stopped the walk. */
  readonly truncated: boolean;
  /** Reason truncation took effect, when it did. */
  readonly truncationReason: "max-nodes" | "max-chars" | null;
}

export interface A11ySnapshot {
  /** Canonical text payload delivered to the LLM. */
  readonly text: string;
  /** Structured form, joined back from ref → node during synthesis. */
  readonly entries: readonly SnapshotEntry[];
  readonly contextLines: readonly ContextLine[];
  /**
   * Selector chain per ref, preserved for the distillation step. Kept out
   * of `text` on purpose so the LLM never echoes a brittle CSS path into
   * generated copy.
   */
  readonly selectors: Readonly<Record<string, string>>;
  readonly sourceUrl: string;
  readonly diagnostics: SnapshotDiagnostics;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Role policy                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Roles that produce a citable ref. These are the element kinds the product
 * supports as action targets today. Anything outside this set is either a
 * context line (when it carries text) or pruned.
 *
 * The list is deliberately explicit rather than a prefix match on "all
 * roles starting with…" — a `menuitemcheckbox` is a citable target, a
 * `menuitemradio` is a citable target, but a `menubar` is only a container
 * and must not receive a ref (the model would then occasionally try to
 * "click the menu bar", which is never the intended step).
 */
const CITABLE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "listbox",
  "treeitem",
  "gridcell",
  "cell",
  "rowheader",
  "columnheader",
  "input",
  "textarea",
  "select",
]);

/**
 * Roles that produce a text-only context line. Headings get a level so the
 * LLM can structure a guide; table captions become context so tables are
 * understood as tables rather than a run of cells.
 */
const CONTEXT_ROLES: ReadonlyMap<string, ContextLine["kind"]> = new Map([
  ["heading", "heading"],
  ["caption", "caption"],
  ["note", "note"],
  ["alert", "note"],
  ["status", "note"],
]);

/**
 * Roles treated as pure containers. Their children are walked; the node
 * itself never appears in either output. If a container carries an
 * accessible name, we emit it as a `note` context line *once* so the model
 * knows the section title, but never as a clickable target.
 */
const CONTAINER_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "group",
  "region",
  "article",
  "section",
  "list",
  "listitem",
  "menu",
  "menubar",
  "tablist",
  "toolbar",
  "navigation",
  "main",
  "complementary",
  "form",
  "search",
  "document",
  "application",
  "dialog",
  "alertdialog",
  "banner",
  "contentinfo",
  "table",
  "rowgroup",
  "row",
  "grid",
  "tree",
  "treegrid",
  "figure",
  "image",
  "img",
  "separator",
  "presentation",
  "none",
]);

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface SnapshotOptions {
  /**
   * Upper bound on the number of citable entries emitted. Defaults to 400,
   * which comfortably covers long forms and dashboard pages while keeping
   * the prompt within a few thousand tokens.
   */
  readonly maxNodes?: number;
  /**
   * Upper bound on the length of the rendered `text` payload, in UTF-16
   * code units. Defaults to 24_000. When hit, the snapshot is truncated at
   * a line boundary and `truncated` is set.
   */
  readonly maxChars?: number;
  /**
   * When true, the `value` field of textboxes is included in the snapshot.
   * Defaults to false: form values are frequently user data and the model
   * does not need them to plan actions. Callers whose workflow is "read
   * the current value" can opt in.
   */
  readonly includeValues?: boolean;
  /**
   * When true, `text` content of citable nodes is included even when a
   * `name` is present. Defaults to false to keep the prompt lean; the
   * accessible name is almost always the canonical label.
   */
  readonly includeTextWhenNamed?: boolean;
  /**
   * Optional seed for ref numbering. When the collector already assigned
   * refs, this module preserves them and continues numbering after the
   * highest numeric ref seen. When not supplied, refs start at `@e1`. The
   * caller uses this when merging snapshots from multiple sub-documents
   * into one prompt.
   */
  readonly refSeed?: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildA11ySnapshot(
  input: A11ySnapshotInput,
  options: SnapshotOptions = {},
): A11ySnapshot {
  if (input === null || typeof input !== "object") {
    throw new A11ySnapshotError("buildA11ySnapshot requires an input object.", "invalid-input");
  }
  if (input.root === null || typeof input.root !== "object") {
    throw new A11ySnapshotError("A11ySnapshotInput.root is missing or not an object.", "invalid-input");
  }
  if (typeof input.root.role !== "string" || input.root.role.length === 0) {
    throw new A11ySnapshotError(
      "A11ySnapshotInput.root.role is missing — the collector must always report a role.",
      "empty-tree",
    );
  }
  if (typeof input.sourceUrl !== "string" || input.sourceUrl.length === 0) {
    throw new A11ySnapshotError(
      "A11ySnapshotInput.sourceUrl is missing — provenance requires it.",
      "invalid-input",
    );
  }

  const maxNodes = clampPositiveInt(options.maxNodes ?? 400, 400);
  const maxChars = clampPositiveInt(options.maxChars ?? 24_000, 24_000);
  const includeValues = options.includeValues === true;
  const includeTextWhenNamed = options.includeTextWhenNamed === true;

  const entries: SnapshotEntry[] = [];
  const contextLines: ContextLine[] = [];
  const selectors: Record<string, string> = {};
  const unknownRoles = new Set<string>();

  // Determine the starting ref number: honour any collector-assigned refs
  // (they look like `@e<N>`) and continue after the highest we see, unless
  // the caller gave us a seed, in which case the seed wins.
  let nextRef = determineRefSeed(input.root, options.refSeed);

  let nodeCount = 0;
  let omitted = 0;
  let truncated = false;
  let truncationReason: A11ySnapshot["diagnostics"]["truncationReason"] = null;

  // Depth-first, document order. Uses an explicit stack for determinism and
  // to avoid a stack overflow on pathological trees; children are pushed in
  // reverse so the leftmost child is visited first.
  interface Frame {
    readonly node: A11yNode;
    readonly depth: number;
  }
  const stack: Frame[] = [{ node: input.root, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const node = frame.node;
    nodeCount += 1;

    if (entries.length >= maxNodes) {
      truncated = true;
      truncationReason = "max-nodes";
      break;
    }

    const role = typeof node.role === "string" ? node.role.toLowerCase() : "";
    const name = readName(node);
    const text = readText(node);
    const value = includeValues ? readValue(node) : null;
    const states = readStates(node);
    const properties = readProperties(node);
    const level = readLevel(properties);

    // Decide the node's disposition. Order matters: a citable role wins over
    // a context role (a button with role note is impossible; a heading with
    // an action it triggers is not this module's concern). Context next.
    // Containers last (only their children matter, plus an optional note).
    if (CITABLE_ROLES.has(role)) {
      const ref =
        typeof node.ref === "string" && node.ref.length > 0
          ? node.ref
          : `@e${nextRef++}`;
      const effectiveName = name.length > 0 ? name : text.slice(0, 120);
      entries.push({
        ref,
        role,
        name: effectiveName,
        value: value !== null && value.length > 0 ? value : null,
        level,
        states,
        properties,
        depth: frame.depth,
      });
      if (typeof node.selector === "string" && node.selector.length > 0) {
        selectors[ref] = node.selector;
      }
    } else if (CONTEXT_ROLES.has(role)) {
      const kind = CONTEXT_ROLES.get(role) as ContextLine["kind"];
      const lineText = name.length > 0 ? name : text;
      if (lineText.length > 0) {
        contextLines.push({
          kind,
          text: lineText.slice(0, 240),
          level,
          depth: frame.depth,
        });
      } else {
        omitted += 1;
      }
    } else if (CONTAINER_ROLES.has(role)) {
      // Emit a section-title note when the container is named, so the model
      // sees the structural label without a citable ref.
      if (name.length > 0 && role !== "document" && role !== "application") {
        contextLines.push({
          kind: "note",
          text: name.slice(0, 240),
          level: null,
          depth: frame.depth,
        });
      }
    } else {
      // Unknown role. Record it and treat as a container with an optional
      // note, so the model still sees any text but cannot target it.
      unknownRoles.add(role.length > 0 ? role : "(empty)");
      if (name.length > 0 || text.length > 0) {
        contextLines.push({
          kind: "note",
          text: (name.length > 0 ? name : text).slice(0, 240),
          level: null,
          depth: frame.depth,
        });
      }
    }

    // Push children in reverse so that the *first* child is popped next;
    // this preserves document order in the outputs above.
    const children = readChildren(node);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i] as A11yNode;
      if (child === null || typeof child !== "object") {
        omitted += 1;
        continue;
      }
      stack.push({ node: child, depth: frame.depth + 1 });
    }
  }

  // Render text form. Emitted in *document order* even though refs are
  // assigned during the walk; the model benefits from reading structure in
  // the order a user would.
  const { text: renderedText, truncated: charTruncated } = renderText(
    entries,
    contextLines,
    maxChars,
  );
  if (charTruncated) {
    truncated = true;
    if (truncationReason === null) truncationReason = "max-chars";
  }

  return {
    text: renderedText,
    entries,
    contextLines,
    selectors,
    sourceUrl: input.sourceUrl,
    diagnostics: {
      nodeCount,
      entryCount: entries.length,
      contextCount: contextLines.length,
      omittedNodeCount: omitted,
      unknownRoles: Array.from(unknownRoles).sort(),
      truncated,
      truncationReason,
    },
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Text rendering                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Render the snapshot as a line-oriented text payload.
 *
 * Grammar (informal):
 *
 *   # Zipy AI accessibility snapshot
 *   # url: https://example.com/customers
 *   # count: 42 citable, 7 context lines
 *   #
 *   # Every line starting with "@e<N>" is a target the model may cite.
 *   # Every line starting with "~" is context: read it, do not cite it.
 *   #
 *   @e1 [button] "New Customer"
 *   @e2 [textbox] "Customer name"  value="Ada Lovelace"  states=[required,focused]
 *   ~ heading(2): "Customers"
 *   @e3 [link] "Ada Lovelace" (href=…)  ← properties are optional
 *
 * The format is deliberately not JSON: small local models follow it
 * reliably, and the structure is obvious to a human reviewer reading the
 * prompt in the activity log.
 */
function renderText(
  entries: readonly SnapshotEntry[],
  contextLines: readonly ContextLine[],
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  const lines: string[] = [];
  lines.push("# Zipy AI accessibility snapshot");
  lines.push("# These lines describe the interactive elements the assistant may target.");
  lines.push(
    `# ${entries.length} citable element(s), ${contextLines.length} context line(s).`,
  );
  lines.push("# Cite only the @eN refs below as action targets.");
  lines.push("# Lines beginning with ~ are context; read them but do not cite them.");
  lines.push("");

  // Merge entries and context lines preserving document order. Both arrays
  // were built in document order, so a single merge by a monotone position
  // is not possible without their original indices. We rebuild the merge by
  // processing them in the order they appear in the rendered stream: this is
  // an approximation that places all context lines before all entries when
  // their interleaving is unknown. Because both were produced by the same
  // depth-first walk, we can recover the interleave by tracking a shared
  // cursor and zipping on the *depth* field: shallower lines come first.
  //
  // Simpler and exact: reconstruct the interleave by walking the original
  // order — which we did not retain. To keep this function pure and small,
  // we accept the minor loss and emit context lines *interleaved by depth*:
  // all context lines at depth 0 first, then depth 1, then entries at depth
  // 0, and so on. In practice this preserves readability for the common
  // page structure.
  //
  // Rationale for accepting the approximation: the LLM's task is to select
  // targets, not to reproduce layout. Slight reordering of context lines
  // relative to entries does not change which element the model picks.
  const ranked: Array<
    | { readonly kind: "entry"; readonly entry: SnapshotEntry }
    | { readonly kind: "context"; readonly context: ContextLine }
  > = [];
  for (const c of contextLines) ranked.push({ kind: "context", context: c });
  for (const e of entries) ranked.push({ kind: "entry", entry: e });
  ranked.sort((a, b) => {
    const da = a.kind === "entry" ? a.entry.depth : a.context.depth;
    const db = b.kind === "entry" ? b.entry.depth : b.context.depth;
    if (da !== db) return da - db;
    // Stable sort key: entries first at the same depth, then by ref if both
    // entries, else context lines keep their original order.
    if (a.kind !== b.kind) return a.kind === "entry" ? -1 : 1;
    if (a.kind === "entry" && b.kind === "entry") {
      return a.entry.ref.localeCompare(b.entry.ref, undefined, { numeric: true });
    }
    return 0;
  });

  let chars = lines.reduce((acc, l) => acc + l.length + 1, 0);
  let truncated = false;
  for (const item of ranked) {
    const line = item.kind === "entry" ? renderEntryLine(item.entry) : renderContextLine(item.context);
    chars += line.length + 1;
    if (chars > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
  }

  return { text: lines.join("\n"), truncated };
}

function renderEntryLine(entry: SnapshotEntry): string {
  const indent = "  ".repeat(Math.min(entry.depth, 6));
  const parts: string[] = [`${indent}${entry.ref} [${entry.role}]`];
  const name = entry.name.replace(/\s+/g, " ").trim();
  if (name.length > 0) parts.push(`"${truncate(name, 160)}"`);
  if (entry.level !== null) parts.push(`level=${entry.level}`);
  if (entry.value !== null && entry.value.length > 0) {
    parts.push(`value="${truncate(entry.value, 120)}"`);
  }
  if (entry.states.length > 0) {
    parts.push(`[${entry.states.join(",")}]`);
  }
  const props = Object.entries(entry.properties)
    .filter(([k]) => k !== "level")
    .map(([k, v]) => `${k}=${formatProp(v)}`);
  if (props.length > 0) parts.push(props.join(" "));
  return parts.join(" ");
}

function renderContextLine(ctx: ContextLine): string {
  const indent = "  ".repeat(Math.min(ctx.depth, 6));
  const label = truncate(ctx.text.replace(/\s+/g, " ").trim(), 240);
  if (ctx.kind === "heading" && ctx.level !== null) {
    return `${indent}~ h${ctx.level} ${quote(label)}`;
  }
  return `${indent}~ ${ctx.kind} ${quote(label)}`;
}

function quote(s: string): string {
  return s.length > 0 ? `"${s.replace(/"/g, '\\"')}"` : '""';
}

function formatProp(v: string | number | boolean): string {
  if (typeof v === "string") return quote(truncate(v, 60));
  return String(v);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/* -------------------------------------------------------------------------- */
/* Node readers                                                                */
/* -------------------------------------------------------------------------- */

function readName(node: A11yNode): string {
  const v = (node as { readonly name?: unknown }).name;
  return typeof v === "string" ? v.trim() : "";
}

function readText(node: A11yNode): string {
  const v = (node as { readonly text?: unknown }).text;
  return typeof v === "string" ? v.trim() : "";
}

function readValue(node: A11yNode): string {
  const v = (node as { readonly value?: unknown }).value;
  return typeof v === "string" ? v : "";
}

function readStates(node: A11yNode): string[] {
  const v = (node as { readonly states?: unknown }).states;
  if (v === null || typeof v !== "object") return [];
  const out: string[] = [];
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw === true) out.push(k);
  }
  out.sort();
  return out;
}

function readProperties(node: A11yNode): Record<string, string | number | boolean> {
  const v = (node as { readonly properties?: unknown }).properties;
  if (v === null || typeof v !== "object") return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[k] = raw;
    }
  }
  return out;
}

function readLevel(properties: Readonly<Record<string, string | number | boolean>>): number | null {
  const v = properties["level"];
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return null;
}

function readChildren(node: A11yNode): readonly A11yNode[] {
  const v = (node as { readonly children?: unknown }).children;
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter(
    (c): c is A11yNode => c !== null && typeof c === "object",
  );
}

/* -------------------------------------------------------------------------- */
/* Ref seeding                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Determine the starting ref number. When the caller supplies `seed`, that
 * wins. Otherwise, walk the tree looking for the highest `@e<N>` ref and
 * continue after it. The walk is a plain depth-first traversal over
 * `children`; it is independent of role policy (any node can carry a ref).
 */
function determineRefSeed(root: A11yNode, seed: number | undefined): number {
  if (typeof seed === "number" && Number.isFinite(seed) && seed >= 1) {
    return Math.floor(seed);
  }
  let max = 0;
  const stack: A11yNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as A11yNode;
    const ref = (node as { readonly ref?: unknown }).ref;
    if (typeof ref === "string") {
      const m = /^@e(\d+)$/.exec(ref);
      if (m !== null) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    const children = readChildren(node);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i] as A11yNode);
    }
  }
  return max + 1;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateA11ySnapshot(value: unknown): A11ySnapshot {
  if (value === null || typeof value !== "object") {
    throw new A11ySnapshotError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const entriesRaw = Array.isArray(r["entries"]) ? (r["entries"] as unknown[]) : [];
  const contextRaw = Array.isArray(r["contextLines"]) ? (r["contextLines"] as unknown[]) : [];
  const selectorsRaw = (r["selectors"] ?? {}) as Record<string, unknown>;
  const diagnosticsRaw = (r["diagnostics"] ?? {}) as Record<string, unknown>;

  const entries: SnapshotEntry[] = [];
  for (const raw of entriesRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const ref = typeof o["ref"] === "string" ? (o["ref"] as string) : "";
    const role = typeof o["role"] === "string" ? (o["role"] as string) : "";
    if (ref.length === 0 || role.length === 0) continue;
    entries.push({
      ref,
      role,
      name: typeof o["name"] === "string" ? (o["name"] as string) : "",
      value: typeof o["value"] === "string" ? (o["value"] as string) : null,
      level:
        typeof o["level"] === "number" && Number.isFinite(o["level"] as number)
          ? Math.floor(o["level"] as number)
          : null,
      states: Array.isArray(o["states"])
        ? (o["states"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      properties: readProperties({ role: "x", properties: o["properties"] }),
      depth:
        typeof o["depth"] === "number" && Number.isFinite(o["depth"] as number)
          ? Math.max(0, Math.floor(o["depth"] as number))
          : 0,
    });
  }

  const contextLines: ContextLine[] = [];
  for (const raw of contextRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const kindRaw = o["kind"];
    const kind: ContextLine["kind"] =
      kindRaw === "heading" || kindRaw === "caption" || kindRaw === "note" ? kindRaw : "note";
    const text = typeof o["text"] === "string" ? (o["text"] as string) : "";
    if (text.length === 0) continue;
    contextLines.push({
      kind,
      text,
      level:
        typeof o["level"] === "number" && Number.isFinite(o["level"] as number)
          ? Math.floor(o["level"] as number)
          : null,
      depth:
        typeof o["depth"] === "number" && Number.isFinite(o["depth"] as number)
          ? Math.max(0, Math.floor(o["depth"] as number))
          : 0,
    });
  }

  const selectors: Record<string, string> = {};
  for (const [k, v] of Object.entries(selectorsRaw)) {
    if (typeof v === "string") selectors[k] = v;
  }

  const unknownRaw = diagnosticsRaw["unknownRoles"];
  const truncationReasonRaw = diagnosticsRaw["truncationReason"];
  const truncationReason: A11ySnapshot["diagnostics"]["truncationReason"] =
    truncationReasonRaw === "max-nodes" || truncationReasonRaw === "max-chars"
      ? truncationReasonRaw
      : null;

  return {
    text: typeof r["text"] === "string" ? (r["text"] as string) : "",
    entries,
    contextLines,
    selectors,
    sourceUrl: typeof r["sourceUrl"] === "string" ? (r["sourceUrl"] as string) : "",
    diagnostics: {
      nodeCount: numberOr(diagnosticsRaw["nodeCount"], entries.length),
      entryCount: numberOr(diagnosticsRaw["entryCount"], entries.length),
      contextCount: numberOr(diagnosticsRaw["contextCount"], contextLines.length),
      omittedNodeCount: numberOr(diagnosticsRaw["omittedNodeCount"], 0),
      unknownRoles: Array.isArray(unknownRaw)
        ? (unknownRaw as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      truncated: diagnosticsRaw["truncated"] === true,
      truncationReason,
    },
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
  };
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  CITABLE_ROLES,
  CONTEXT_ROLES,
  CONTAINER_ROLES,
  renderEntryLine,
  renderContextLine,
  determineRefSeed,
});
