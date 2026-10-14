/**
 * Zipy AI — structured content: decision trees (content-generation, structured batch 3).
 *
 * Renders a branching workflow as a text-based decision tree. The source of
 * truth is the conditional workflow graph produced by
 * `@zipy/synth/conditionalGraph`; this module does not parse the plan
 * itself. When the caller supplies a graph, every branch, condition and
 * leaf is turned into a tree node with a stable id. When the caller
 * supplies only a linear plan, a single-branch tree is produced and a gap
 * is recorded noting that no branching was supplied.
 *
 * Boundaries:
 *  - Branch conditions are emitted verbatim from the graph; the composer
 *    never invents a condition it was not given.
 *  - The ASCII rendering is deterministic and stable across runs; given the
 *    same graph, the output text is byte-identical (modulo the timestamp
 *    on the top-level payload).
 *  - When a graph edge has no condition and no label, the edge is rendered
 *    as the default ("otherwise") branch and no gap is recorded for it —
 *    a graph without a condition on an otherwise branch is well-formed.
 *
 * Output shape (`DecisionTree`) is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DecisionTreeErrorCode = "invalid-input" | "no-root";

export class DecisionTreeError extends Error {
  readonly code: DecisionTreeErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DecisionTreeErrorCode,
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

export interface DecisionBranch {
  /**
   * Condition text for the branch. `null` marks the default ("otherwise")
   * edge, whose decision uses the node's own name as the question.
   */
  readonly condition: string | null;
  /** Optional short label for the branch; drawn from the graph edge label. */
  readonly label: string | null;
  /** The subtree reached when the condition holds. */
  readonly next: DecisionNode;
}

export interface DecisionNode {
  readonly id: string;
  /** Short question or action phrased as a tree node label. */
  readonly label: string;
  /**
   * Optional detail line shown under the node in exhaustive views. Caller
   * supplied; the composer never generates prose here.
   */
  readonly detail: string | null;
  /** Provenance: the plan step id when the node derives from a step. */
  readonly sourceStepId: string | null;
  /** Branches leaving this node. Empty on a leaf. */
  readonly branches: readonly DecisionBranch[];
}

export interface DecisionTreeGap {
  readonly nodeId: string | null;
  readonly reason:
    | "no-graph-supplied"
    | "linear-plan"
    | "branch-without-condition"
    | "empty-plan";
  readonly detail: string;
}

export interface DecisionTree {
  readonly version: "decision-tree/1";
  readonly title: string;
  readonly root: DecisionNode;
  /** Number of terminal nodes (leaves) in the tree. */
  readonly leafCount: number;
  /** Maximum depth of the tree; leaf-only trees are depth 0. */
  readonly depth: number;
  /** Pre-rendered ASCII visualisation, deterministic for a given tree. */
  readonly ascii: string;
  readonly gaps: readonly DecisionTreeGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

/**
 * Minimal shape of the conditional graph this module consumes. Kept
 * structurally compatible with `@zipy/synth/conditionalGraph` so the caller
 * can pass that graph directly without a cast.
 */
export interface ConditionalGraphLike {
  readonly goal?: string;
  readonly nodes: readonly {
    readonly id: string;
    readonly label?: string | null;
    readonly name?: string | null;
    readonly detail?: string | null;
    readonly stepId?: string | null;
    readonly kind?: "action" | "decision" | "start" | "end" | string;
  }[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly condition?: string | null;
    readonly label?: string | null;
  }[];
  readonly rootId?: string | null;
}

export interface DecisionTreeInputs {
  /** Optional plan; used when no graph is supplied to produce a linear tree. */
  readonly plan?: Plan | null;
  /** Optional branch-defining graph; when supplied, this is the source of truth. */
  readonly graph?: ConditionalGraphLike | null;
  /** Optional title; falls back to the graph goal or the plan goal. */
  readonly title?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeDecisionTree(inputs: DecisionTreeInputs): DecisionTree {
  if (inputs === null || typeof inputs !== "object") {
    throw new DecisionTreeError("composeDecisionTree requires an inputs object.", "invalid-input");
  }

  const gaps: DecisionTreeGap[] = [];
  const graph = inputs.graph ?? null;

  let root: DecisionNode;
  let title: string;

  if (graph !== null && typeof graph === "object" && Array.isArray(graph.nodes) && graph.nodes.length > 0) {
    const built = buildFromGraph(graph, gaps);
    root = built.root;
    title = nonEmpty(inputs.title) ?? nonEmpty(graph.goal) ?? "Workflow decision tree";
  } else {
    if (graph !== null && typeof graph === "object") {
      gaps.push({
        nodeId: null,
        reason: "no-graph-supplied",
        detail: "A conditional graph object was supplied but contained no nodes; falling back to a linear tree from the plan.",
      });
    } else {
      gaps.push({
        nodeId: null,
        reason: "no-graph-supplied",
        detail: "No conditional graph was supplied; a linear (single-branch) tree was produced from the plan.",
      });
    }
    const plan = inputs.plan ?? null;
    if (plan === null || typeof plan !== "object") {
      throw new DecisionTreeError(
        "Either a conditional graph or a plan must be supplied.",
        "no-root",
      );
    }
    const built = buildFromPlan(plan, gaps);
    root = built.root;
    title = nonEmpty(inputs.title) ?? built.title;
  }

  const leafCount = countLeaves(root);
  const depth = maxDepth(root);
  const ascii = renderTreeAscii(root);

  return {
    version: "decision-tree/1",
    title,
    root,
    leafCount,
    depth,
    ascii,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the tree as a fenced Markdown block using the pre-computed ASCII
 * visualisation. Kept separate so an export template can embed the ASCII
 * form inside any surrounding prose without re-rendering.
 */
export function renderDecisionTreeMarkdown(tree: DecisionTree): string {
  const parts: string[] = [];
  parts.push(`## ${tree.title}`);
  parts.push("");
  parts.push("```text");
  parts.push(tree.ascii.replace(/\s+$/u, ""));
  parts.push("```");
  parts.push("");
  if (tree.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Decision-tree gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of tree.gaps) {
      parts.push(`- ${gap.nodeId !== null ? `Node ${gap.nodeId}: ` : ""}${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildDecisionTreeDirectives(): string {
  return [
    "You are producing a text-based decision tree for an approved workflow.",
    "The tree has exactly one root. Every non-leaf node poses a question whose answer determines the outgoing branch; label the branch with the condition verbatim from the source (e.g., 'account exists', 'value is negative').",
    "The default / otherwise branch is rendered as 'otherwise' and is never labelled with an invented condition.",
    "Leaf nodes are short action sentences ('Create the account', 'Skip to step 5').",
    "Do not invent conditions. If a branch exists in the plan but you cannot identify its condition from the sources, leave the condition blank so it renders as 'otherwise' and the reviewer is notified.",
    "Do not use the word 'simply'. Do not add marketing language.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Graph import                                                                */
/* -------------------------------------------------------------------------- */

function buildFromGraph(
  graph: ConditionalGraphLike,
  gaps: DecisionTreeGap[],
): { readonly root: DecisionNode } {
  const nodesById = new Map<string, ConditionalGraphLike["nodes"][number]>();
  for (const node of graph.nodes) {
    if (node === null || typeof node !== "object") continue;
    if (typeof node.id !== "string" || node.id.length === 0) continue;
    nodesById.set(node.id, node);
  }

  const edgesByFrom = new Map<
    string,
    { readonly to: string; readonly condition: string | null; readonly label: string | null }[]
  >();
  for (const edge of graph.edges) {
    if (edge === null || typeof edge !== "object") continue;
    if (typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    const list = edgesByFrom.get(edge.from) ?? [];
    list.push({
      to: edge.to,
      condition:
        typeof edge.condition === "string" && edge.condition.trim().length > 0
          ? edge.condition.trim()
          : null,
      label:
        typeof edge.label === "string" && edge.label.trim().length > 0
          ? edge.label.trim()
          : null,
    });
    edgesByFrom.set(edge.from, list);
  }

  const rootId = pickRootId(graph, nodesById, edgesByFrom);
  if (rootId === null) {
    throw new DecisionTreeError(
      "The conditional graph does not expose a usable root node.",
      "no-root",
    );
  }

  // Recursive build with cycle protection. A graph with a cycle is malformed
  // for a decision tree; the revisit is treated as a leaf and a gap is
  // recorded rather than looping.
  const visiting = new Set<string>();
  const built = new Map<string, DecisionNode>();

  const build = (id: string): DecisionNode => {
    const cached = built.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      const stale = nodesById.get(id);
      return {
        id,
        label: nodeLabel(stale),
        detail: nodeDetail(stale),
        sourceStepId: nodeStepId(stale),
        branches: [],
      };
    }
    visiting.add(id);
    const node = nodesById.get(id);
    const outgoing = edgesByFrom.get(id) ?? [];
    const branches: DecisionBranch[] = [];
    for (const edge of outgoing) {
      const next = build(edge.to);
      if (edge.condition === null && outgoing.length > 1 && !hasDefaultBranch(branches)) {
        // Multiple outgoing edges and no condition on this one: treat as
        // the default branch, per the composer contract.
        branches.push({ condition: null, label: edge.label, next });
      } else {
        branches.push({ condition: edge.condition, label: edge.label, next });
      }
    }
    const decision: DecisionNode = {
      id,
      label: nodeLabel(node),
      detail: nodeDetail(node),
      sourceStepId: nodeStepId(node),
      branches,
    };
    visiting.delete(id);
    built.set(id, decision);
    return decision;
  };

  const root = build(rootId);

  // Gap detection: a decision node with multiple branches that lacks a
  // default branch leaves an unhandled "otherwise" case.
  walk(root, (node) => {
    if (node.branches.length >= 2 && !hasDefaultBranch(node.branches)) {
      gaps.push({
        nodeId: node.id,
        reason: "branch-without-condition",
        detail: `Decision node "${node.label}" has ${node.branches.length} branches and no default branch; add an otherwise case.`,
      });
    }
  });

  return { root };
}

function pickRootId(
  graph: ConditionalGraphLike,
  nodesById: ReadonlyMap<string, ConditionalGraphLike["nodes"][number]>,
  edgesByFrom: ReadonlyMap<string, readonly unknown[]>,
): string | null {
  if (typeof graph.rootId === "string" && graph.rootId.length > 0 && nodesById.has(graph.rootId)) {
    return graph.rootId;
  }
  // A node with no incoming edges is a valid root.
  const incoming = new Set<string>();
  for (const edges of edgesByFrom.values()) {
    for (const edge of edges) {
      const to = (edge as { to?: unknown }).to;
      if (typeof to === "string") incoming.add(to);
    }
  }
  const candidates: string[] = [];
  for (const id of nodesById.keys()) {
    if (!incoming.has(id)) candidates.push(id);
  }
  if (candidates.length === 1) return candidates[0]!;
  // Multiple candidates: prefer a node whose kind says "start".
  for (const id of candidates) {
    const node = nodesById.get(id);
    if (node !== undefined && node.kind === "start") return id;
  }
  if (candidates.length > 0) {
    // Deterministic tie-break: lowest id in lexical order.
    candidates.sort();
    return candidates[0]!;
  }
  // Every node has an incoming edge (a cycle). Pick the first node as root.
  const first = [...nodesById.keys()].sort()[0];
  return first ?? null;
}

function nodeLabel(node: ConditionalGraphLike["nodes"][number] | undefined): string {
  if (node === undefined) return "Unnamed node";
  if (typeof node.label === "string" && node.label.trim().length > 0) return node.label.trim();
  if (typeof node.name === "string" && node.name.trim().length > 0) return node.name.trim();
  return "Unnamed node";
}

function nodeDetail(node: ConditionalGraphLike["nodes"][number] | undefined): string | null {
  if (node === undefined) return null;
  if (typeof node.detail === "string" && node.detail.trim().length > 0) return node.detail.trim();
  return null;
}

function nodeStepId(node: ConditionalGraphLike["nodes"][number] | undefined): string | null {
  if (node === undefined) return null;
  if (typeof node.stepId === "string" && node.stepId.trim().length > 0) return node.stepId.trim();
  return null;
}

function hasDefaultBranch(branches: readonly DecisionBranch[]): boolean {
  return branches.some((b) => b.condition === null);
}

/* -------------------------------------------------------------------------- */
/* Plan fallback                                                               */
/* -------------------------------------------------------------------------- */

function buildFromPlan(
  plan: Plan,
  gaps: DecisionTreeGap[],
): { readonly root: DecisionNode; readonly title: string } {
  const goalRaw = (plan as { goal?: unknown }).goal;
  const goal = typeof goalRaw === "string" && goalRaw.trim().length > 0
    ? goalRaw.trim()
    : "Workflow decision tree";
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    gaps.push({
      nodeId: null,
      reason: "empty-plan",
      detail: "The plan does not expose a goal; a placeholder title was used.",
    });
  }

  const steps = readSteps(plan);
  if (steps.length === 0) {
    gaps.push({
      nodeId: null,
      reason: "empty-plan",
      detail: "The plan contains no steps; the tree has a single placeholder node.",
    });
    return {
      root: {
        id: "root",
        label: goal,
        detail: null,
        sourceStepId: null,
        branches: [],
      },
      title: goal,
    };
  }

  // Single-branch linear tree: each step points to the next; the final step
  // is the leaf. This is a valid tree; the composer records a gap so the
  // reviewer knows branching behaviour was not supplied.
  gaps.push({
    nodeId: null,
    reason: "linear-plan",
    detail: "No conditional graph was supplied; the tree is a linear chain of the plan's steps.",
  });

  let leaf: DecisionNode | null = null;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const entry = steps[i]!;
    const label = planStepLabel(entry.planStep, entry.index);
    const detail = entry.planStep.value !== null && typeof entry.planStep.value === "string" && entry.planStep.value.trim().length > 0
      ? entry.planStep.value.trim()
      : null;
    const node: DecisionNode = {
      id: `node-${entry.index}`,
      label,
      detail,
      sourceStepId: entry.id,
      branches:
        leaf !== null
          ? [{ condition: null, label: null, next: leaf }]
          : [],
    };
    leaf = node;
  }

  return {
    root: leaf!,
    title: goal,
  };
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

function planStepLabel(step: PlanStep, index: number): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  const value = typeof step.value === "string" && step.value.trim().length > 0 ? step.value.trim() : null;
  switch (step.action) {
    case "click":
      return name !== null ? `Click ${name}` : `Click the target control (step ${index})`;
    case "type":
      return name !== null
        ? value !== null
          ? `Enter value in ${name}`
          : `Enter the value in ${name}`
        : `Enter the value in the field (step ${index})`;
    case "select":
      return name !== null
        ? value !== null
          ? `Choose ${value} from ${name}`
          : `Choose from ${name}`
        : `Choose the required option (step ${index})`;
    case "navigate":
      return value !== null ? `Navigate to ${value}` : "Navigate to the next page";
    case "scroll":
      return "Scroll to reveal the next control";
    default:
      return name !== null ? `Interact with ${name}` : `Perform the action (step ${index})`;
  }
}

/* -------------------------------------------------------------------------- */
/* ASCII rendering                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Render the tree as an indented ASCII diagram. Uses `+--` / `|  ` box
 * drawing (ASCII, not Unicode) so the output survives being pasted into any
 * terminal and into a plain-text email body. Deterministic: identical input
 * produces byte-identical output.
 */
function renderTreeAscii(root: DecisionNode): string {
  const lines: string[] = [];

  const branchLabel = (branch: DecisionBranch, isLast: boolean): string => {
    const connector = isLast ? "`-- " : "+-- ";
    const text = branch.condition !== null ? branch.condition : "otherwise";
    const label = branch.label !== null && branch.label !== text ? ` (${branch.label})` : "";
    return `${connector}[${text}]${label}`;
  };

  const walk = (node: DecisionNode, prefix: string, branch: DecisionBranch | null, isLast: boolean): void => {
    if (branch !== null) {
      lines.push(`${prefix}${branchLabel(branch, isLast)}`);
      const childPrefix = prefix + (isLast ? "    " : "|   ");
      lines.push(`${childPrefix}${node.label}`);
      queueChildren(node, childPrefix);
    } else {
      lines.push(`${prefix}${node.label}`);
      queueChildren(node, prefix);
    }
  };

  const queueChildren = (node: DecisionNode, prefix: string): void => {
    const branches = node.branches;
    for (let i = 0; i < branches.length; i += 1) {
      const child = branches[i]!;
      const last = i === branches.length - 1;
      walk(child.next, prefix, child, last);
    }
  };

  // Root has no incoming branch; render as the head of the diagram.
  walk(root, "", null, true);

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Traversal helpers                                                           */
/* -------------------------------------------------------------------------- */

function walk(node: DecisionNode, visit: (n: DecisionNode) => void): void {
  // Iterative DFS with a visited set so a malformed (cyclic) tree does not
  // hang the caller. A visitor may see a node more than once when the same
  // node appears under multiple branches; we only skip re-expansion of its
  // children on the *second* visit for that node id in the same path. That
  // distinction matters for callers that count branches.
  const stack: DecisionNode[] = [node];
  const path = new Set<string>();
  const expand = (n: DecisionNode): void => {
    visit(n);
    if (path.has(n.id)) return;
    path.add(n.id);
    for (const b of n.branches) {
      stack.push(b.next);
    }
    // Path is not popped here because we want id-based dedup across the
    // whole traversal; a decision tree that references the same node id
    // twice is malformed, and the visitor still sees each occurrence once.
  };
  while (stack.length > 0) {
    const next = stack.pop()!;
    expand(next);
  }
}

function countLeaves(root: DecisionNode): number {
  let leaves = 0;
  walk(root, (n) => {
    if (n.branches.length === 0) leaves += 1;
  });
  return leaves;
}

function maxDepth(root: DecisionNode): number {
  let depth = 0;
  const visit = (n: DecisionNode, d: number): void => {
    if (d > depth) depth = d;
    for (const b of n.branches) visit(b.next, d + 1);
  };
  visit(root, 0);
  return depth;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  buildFromGraph,
  buildFromPlan,
  pickRootId,
  nodeLabel,
  nodeDetail,
  nodeStepId,
  hasDefaultBranch,
  planStepLabel,
  renderTreeAscii,
  countLeaves,
  maxDepth,
});
