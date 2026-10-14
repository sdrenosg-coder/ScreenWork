/**
 * Zipy AI — structured content: tables (content-generation, structured batch 2).
 *
 * Extracts *tabular* content that the plan and its artefacts already contain
 * and renders it as a column/row table. The composer recognises four table
 * kinds that appear naturally in a workflow guide:
 *
 *   - `field-definition` — every step that takes an input becomes a row:
 *        Field | Value | Source step.
 *   - `keyboard-shortcuts` — only when the caller supplies shortcut pairs
 *        (the plan does not carry keystrokes, so these are never invented).
 *   - `terminology` — glossary entries rendered as Term | Definition.
 *   - `comparison` — caller-supplied comparison rows for "X vs Y" tables.
 *
 * The composer never invents a row, a column or a cell value. When a table
 * kind has no source data, it is omitted and a `TableGap` is recorded. The
 * artefact is fully serialisable (no functions, no binary payloads).
 *
 * Output shape (`TableSet`) is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TableErrorCode = "invalid-input" | "no-goal";

export class TableError extends Error {
  readonly code: TableErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TableErrorCode,
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

export const TABLE_KINDS = [
  "field-definition",
  "keyboard-shortcuts",
  "terminology",
  "comparison",
] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

export interface TableColumn {
  /** Stable id used by the export layer to style a column (e.g. `field`). */
  readonly id: string;
  /** Display heading. */
  readonly heading: string;
  /** Advisory column alignment for HTML/PDF rendering. */
  readonly align: "left" | "right" | "center";
}

export interface TableRow {
  /** One cell per column, in the same order as the columns array. */
  readonly cells: readonly string[];
  /** Provenance: plan step id when the row derives from a step; null otherwise. */
  readonly sourceStepId: string | null;
}

export interface Table {
  readonly version: "table/1";
  readonly kind: TableKind;
  readonly id: string;
  readonly caption: string;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
}

export interface TableGap {
  readonly kind: TableKind;
  readonly reason:
    | "no-input-steps"
    | "no-shortcuts-supplied"
    | "no-glossary-supplied"
    | "no-comparison-supplied"
    | "no-plan-steps";
  readonly detail: string;
}

export interface TableSet {
  readonly version: "tables/1";
  readonly tables: readonly Table[];
  readonly gaps: readonly TableGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface KeyboardShortcut {
  /** e.g. "Ctrl+K" — supplied verbatim; never normalised. */
  readonly keys: string;
  /** The action the shortcut performs. */
  readonly action: string;
  /** Optional grouping label (e.g. "Editing", "Navigation"). */
  readonly group?: string;
}

export interface ComparisonRow {
  /** The criterion being compared (first column). */
  readonly criterion: string;
  /** One entry per compared option, in the order the caller supplied them. */
  readonly values: readonly string[];
}

export interface TableInputs {
  readonly plan: Plan;
  /** Optional shortcut list for the `keyboard-shortcuts` table. */
  readonly shortcuts?: readonly KeyboardShortcut[];
  /** Optional glossary entries for the `terminology` table. */
  readonly glossary?: readonly { readonly term: string; readonly definition: string }[];
  /**
   * Optional comparison table. Supply the option names as `comparisonOptions`
   * and one `ComparisonRow` per criterion.
   */
  readonly comparisonOptions?: readonly string[];
  readonly comparisonRows?: readonly ComparisonRow[];
  readonly comparisonCaption?: string | null;
  /**
   * Optional per-step copy overrides used as the "Field" cell's label when
   * the plan step has no target name of its own.
   */
  readonly stepText?: Readonly<Record<string, { readonly title: string; readonly description: string }>>;
  /** Optional caption for the field-definition table. */
  readonly fieldTableCaption?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeTables(inputs: TableInputs): TableSet {
  if (inputs === null || typeof inputs !== "object") {
    throw new TableError("composeTables requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new TableError("A plan object is required.", "invalid-input");
  }
  const goal = (plan as { goal?: unknown }).goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new TableError("The plan does not expose a goal.", "no-goal");
  }

  const gaps: TableGap[] = [];
  const steps = readSteps(plan);
  if (steps.length === 0) {
    gaps.push({
      kind: "field-definition",
      reason: "no-plan-steps",
      detail: "The supplied plan contains no steps; no field-definition table was produced.",
    });
  }

  const tables: Table[] = [];

  // -------------------------------------------------- field-definition ---
  const fieldRows: TableRow[] = [];
  for (const entry of steps) {
    const name = targetName(entry.planStep);
    const value =
      typeof entry.planStep.value === "string" && entry.planStep.value.trim().length > 0
        ? entry.planStep.value.trim()
        : null;
    // Only steps that take a value are rows; clicking a button is not a
    // "field" and adding it would make the table noisier, not more useful.
    if (value === null) continue;
    const label =
      name ??
      nonEmpty(inputs.stepText?.[entry.id]?.title) ??
      `Step ${entry.index}`;
    fieldRows.push({
      cells: [label, value, String(entry.index)],
      sourceStepId: entry.id,
    });
  }
  if (fieldRows.length > 0) {
    tables.push({
      version: "table/1",
      kind: "field-definition",
      id: "field-definition",
      caption:
        nonEmpty(inputs.fieldTableCaption) ??
        `Values entered during the workflow: ${goal}`,
      columns: [
        { id: "field", heading: "Field", align: "left" },
        { id: "value", heading: "Value", align: "left" },
        { id: "step", heading: "Step", align: "right" },
      ],
      rows: fieldRows,
    });
  } else if (steps.length > 0) {
    gaps.push({
      kind: "field-definition",
      reason: "no-input-steps",
      detail: "No plan step supplies a value, so there is no field-definition table.",
    });
  }

  // ------------------------------------------------- keyboard-shortcuts ---
  const shortcuts = pruneShortcuts(inputs.shortcuts ?? []);
  if (shortcuts.length > 0) {
    const hasGroups = shortcuts.some((s) => s.group !== undefined && s.group.length > 0);
    const columns: TableColumn[] = hasGroups
      ? [
          { id: "group", heading: "Group", align: "left" },
          { id: "action", heading: "Action", align: "left" },
          { id: "keys", heading: "Keys", align: "left" },
        ]
      : [
          { id: "action", heading: "Action", align: "left" },
          { id: "keys", heading: "Keys", align: "left" },
        ];
    const rows: TableRow[] = shortcuts.map((s) => ({
      cells: hasGroups ? [s.group ?? "", s.action, s.keys] : [s.action, s.keys],
      sourceStepId: null,
    }));
    tables.push({
      version: "table/1",
      kind: "keyboard-shortcuts",
      id: "keyboard-shortcuts",
      caption: "Keyboard shortcuts used in this workflow",
      columns,
      rows,
    });
  } else {
    gaps.push({
      kind: "keyboard-shortcuts",
      reason: "no-shortcuts-supplied",
      detail: "No keyboard shortcuts were supplied; the shortcut table was omitted.",
    });
  }

  // ------------------------------------------------------- terminology ---
  const glossary = pruneGlossary(inputs.glossary ?? []);
  if (glossary.length > 0) {
    tables.push({
      version: "table/1",
      kind: "terminology",
      id: "terminology",
      caption: "Terminology",
      columns: [
        { id: "term", heading: "Term", align: "left" },
        { id: "definition", heading: "Definition", align: "left" },
      ],
      rows: glossary.map((g) => ({
        cells: [g.term, g.definition],
        sourceStepId: null,
      })),
    });
  } else {
    gaps.push({
      kind: "terminology",
      reason: "no-glossary-supplied",
      detail: "No glossary entries were supplied; the terminology table was omitted.",
    });
  }

  // -------------------------------------------------------- comparison ---
  const options = pruneStrings(inputs.comparisonOptions ?? []);
  const compRows = pruneComparisonRows(inputs.comparisonRows ?? [], options.length);
  if (options.length >= 2 && compRows.length > 0) {
    const columns: TableColumn[] = [
      { id: "criterion", heading: "Criterion", align: "left" },
      ...options.map((opt, i) => ({
        id: `option-${i}`,
        heading: opt,
        align: "left" as const,
      })),
    ];
    const rows: TableRow[] = compRows.map((r) => ({
      cells: [r.criterion, ...r.values],
      sourceStepId: null,
    }));
    tables.push({
      version: "table/1",
      kind: "comparison",
      id: "comparison",
      caption: nonEmpty(inputs.comparisonCaption) ?? "Comparison",
      columns,
      rows,
    });
  } else {
    gaps.push({
      kind: "comparison",
      reason: "no-comparison-supplied",
      detail:
        "A comparison table requires at least two options and one row; none were supplied.",
    });
  }

  return {
    version: "tables/1",
    tables,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the table set as GitHub-flavoured Markdown. Column alignment is
 * honoured so the export layer's PDF path receives the same shape.
 */
export function renderTablesMarkdown(set: TableSet): string {
  const parts: string[] = [];
  for (const table of set.tables) {
    parts.push(`### ${table.caption}`);
    parts.push("");
    parts.push(renderTable(table));
    parts.push("");
  }
  if (set.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Table gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of set.gaps) {
      parts.push(`- **${gap.kind}** — ${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function renderTable(table: Table): string {
  const header = `| ${table.columns.map((c) => escapeMd(c.heading)).join(" | ")} |`;
  const separator = `| ${table.columns
    .map((c) => {
      switch (c.align) {
        case "right": return "---:";
        case "center": return ":---:";
        default: return "---";
      }
    })
    .join(" | ")} |`;
  const body = table.rows
    .map(
      (r) =>
        `| ${table.columns
          .map((_, i) => escapeMd(r.cells[i] ?? ""))
          .join(" | ")} |`,
    )
    .join("\n");
  return [header, separator, body].filter((s) => s.length > 0).join("\n");
}

export function buildTablesDirectives(): string {
  return [
    "You are producing structured tables from an already approved workflow plan.",
    "Supported table kinds: Field / Value / Step, Keyboard shortcuts, Terminology (Term / Definition), and Comparison (Criterion + one column per option).",
    "Every row must be derivable from the plan or from caller-supplied data. Never invent shortcuts, term definitions, option names or cell values.",
    "Field rows only include steps whose plan entry carries a value. Do not add rows for pure clicks or navigations.",
    "Leave a table out entirely when it has no source data; never pad a table with placeholder rows.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

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

function targetName(step: PlanStep): string | null {
  if (step.target === null || typeof step.target !== "object") return null;
  const name = step.target.name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

function pruneShortcuts(values: readonly KeyboardShortcut[]): readonly KeyboardShortcut[] {
  const out: KeyboardShortcut[] = [];
  const seen = new Set<string>();
  for (const s of values) {
    const keys = typeof s.keys === "string" ? s.keys.trim() : "";
    const action = typeof s.action === "string" ? s.action.trim() : "";
    if (keys.length === 0 || action.length === 0) continue;
    const group = typeof s.group === "string" ? s.group.trim() : "";
    const key = `${keys.toLowerCase()}\u0001${action.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(group.length > 0 ? { keys, action, group } : { keys, action });
  }
  return out;
}

function pruneGlossary(
  entries: readonly { readonly term: string; readonly definition: string }[],
): readonly { readonly term: string; readonly definition: string }[] {
  const out: { term: string; definition: string }[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const term = typeof e.term === "string" ? e.term.trim() : "";
    const def = typeof e.definition === "string" ? e.definition.trim() : "";
    if (term.length === 0 || def.length === 0) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, definition: def });
  }
  return out;
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

/**
 * Keep only rows whose `values` array matches the option count exactly.
 * A row with the wrong number of cells would render a broken table, so it
 * is dropped rather than padded or truncated.
 */
function pruneComparisonRows(
  rows: readonly ComparisonRow[],
  optionCount: number,
): readonly ComparisonRow[] {
  const out: ComparisonRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const criterion = typeof r.criterion === "string" ? r.criterion.trim() : "";
    if (criterion.length === 0) continue;
    const values = Array.isArray(r.values) ? r.values.map((v) => (typeof v === "string" ? v.trim() : "")) : [];
    if (values.length !== optionCount || optionCount === 0) continue;
    const key = criterion.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ criterion, values });
  }
  return out;
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function escapeMd(s: string): string {
  // Escape pipe characters so a cell never breaks the table layout; do not
  // escape anything else — callers own their own inline markup.
  return s.replace(/\|/g, "\\|");
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  targetName,
  pruneShortcuts,
  pruneGlossary,
  pruneStrings,
  pruneComparisonRows,
  renderTable,
  escapeMd,
});
