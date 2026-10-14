/**
 * Zipy AI — conditional workflow graph synthesis.
 *
 * The linear plan produced by `stepSequence.ts` models the happy path. Real
 * administrative workflows branch: "if the customer already exists, skip to
 * step 5", "on the Enterprise plan, select Annual billing first". This module
 * upgrades a linear `StepPlan` into a `WorkflowGraph` — a small directed acyclic
 * graph with:
 *
 *   - one `start` node
 *   - one `step` node per plan step (carrying the plan step by reference)
 *   - zero or more `decision` nodes, each with two outgoing `branch` edges
 *     (`on-true`, `on-false`) that rejoin at a target step, or `end` to
 *     terminate
 *   - one `end` node
 *
 * Where the branches come from (in priority order):
 *   1. Explicit conditionals in the operator prompt matched against the plan
 *      steps lexically ("if the customer exists, skip to step 4" attaches a
 *      decision node *before* the first step whose text matches "customer
 *      exists" and an `on-true` edge that jumps to the step whose ordinal is
 *      given; `on-false` continues to the following step).
 *   2. `PlanDiagnostics.conditionalCues` — cues the deterministic extractor
 *      already surfaced. Same handling as (1), but with the cue text as the
 *      condition.
 *   3. An LLM pass. When the caller supplies `mode: "llm"` and the adapter is
 *      configured, the model is asked to propose conditionals against the
 *      numbered plan. Every proposal must name *existing* step ordinals and
 *      existing action ids; anything else is dropped and recorded. LLM output
 *      is never trusted to invent steps or ordinals.
 *
 * What this module is NOT:
 *   - A planner. It never adds or removes plan steps; every `step` node in
 *     the output corresponds to exactly one plan step, by `stepId`.
 *   - A browser. It computes structure, not execution.
 *   - A provider assumption. With `mode: "deterministic"` (the default for
 *     offline/CI runs) it uses only the lexical rules and the extractor's own
 *     cues. When `mode: "llm"` is requested but no adapter is available, it
 *     falls back to the deterministic path and records why in
 *     `adapterFallbackReason`. It never fabricates a conditional.
 *
 * Cycle safety: the module builds the graph topologically and then verifies
 * acyclicity by walking every node’s outgoing edges. A proposed jump target
 * that would create a cycle is *rejected* and the decision node is dropped;
 * the rejection is recorded in `diagnostics.rejectedBranches`.
 */

import type { StepPlan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ConditionalGraphErrorCode =
  | "invalid-input"
  | "empty-plan"
  | "duplicate-step-id"
  | "llm-invalid-output";

export class ConditionalGraphError extends Error {
  readonly code: ConditionalGraphErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ConditionalGraphErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ConditionalGraphError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type NodeKind = "start" | "step" | "decision" | "end";
export type EdgeKind = "next" | "on-true" | "on-false" | "cancel" | "error";

export interface GraphNodeBase {
  readonly nodeId: string;
  readonly kind: NodeKind;
}

export interface StartNode extends GraphNodeBase {
  readonly kind: "start";
}

export interface EndNode extends GraphNodeBase {
  readonly kind: "end";
}

export interface StepNode extends GraphNodeBase {
  readonly kind: "step";
  /** The plan step this node executes. Preserved by `stepId`. */
  readonly stepId: string;
  /** 1-based ordinal mirrored from the plan for readability. */
  readonly ordinal: number;
}

/**
 * A decision node evaluates `condition` before executing the node it precedes.
 * The graph constrains every decision to exactly two outgoing edges: one
 * `on-true`, one `on-false`. When `onFalseTarget` is omitted, the false branch
 * falls through to the node immediately after the decision.
 */
export interface DecisionNode extends GraphNodeBase {
  readonly kind: "decision";
  /** Machine-readable condition token (stable, lowercase, no spaces). */
  readonly conditionKey: string;
  /** Human-readable condition text as inferred from the prompt or LLM. */
  readonly conditionText: string;
  /** How the condition was derived — reviewer transparency. */
  readonly derivedBy: "operator-prompt" | "diagnostic-cue" | "llm";
}

export type GraphNode = StartNode | StepNode | DecisionNode | EndNode;

export interface GraphEdge {
  readonly edgeId: string;
  readonly kind: EdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  /**
   * Optional reviewer-visible label — for a decision branch, whether the
   * condition was true or false; for an error edge, the error the edge
   * handles ("element-not-found", "timeout").
   */
  readonly label: string | null;
}

export interface RejectedBranch {
  readonly decisionNodeId: string;
  readonly reason:
    | "unknown-target-step"
    | "would-create-cycle"
    | "duplicate-branch"
    | "self-loop";
  readonly detail: string;
}

export interface GraphDiagnostics {
  readonly nodeCount: number;
  readonly stepNodeCount: number;
  readonly decisionNodeCount: number;
  readonly edgeCount: number;
  readonly conditionalCuesConsidered: readonly string[];
  readonly llmCandidatesConsidered: number;
  readonly llmCandidatesAccepted: number;
  readonly rejectedBranches: readonly RejectedBranch[];
  /** True when at least one decision node was added. */
  readonly hasConditionals: boolean;
  /** Reached the whole graph traversal without hitting a cycle. */
  readonly acyclic: boolean;
}

/**
 * The full workflow graph. Step *order* is preserved on `stepOrder`; the graph
 * structure carries the branch edges on top of that order.
 */
export interface WorkflowGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /**
   * The order steps execute in on the happy path (all conditions false /
   * default branches). Every plan step appears exactly once.
   */
  readonly stepOrder: readonly string[];
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly diagnostics: GraphDiagnostics;
  readonly generatedAt: string;
  /** Honest provenance for the caller. */
  readonly adapterUsed: boolean;
  readonly adapterFallbackReason: string | null;
  readonly model: string | null;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface BuildGraphOptions {
  /**
   * `"deterministic"` (default) uses only lexical rules + the extractor's cues.
   * `"llm"` additionally asks the adapter for candidate conditionals; on any
   * failure it silently falls back to deterministic and records the reason.
   */
  readonly mode?: "llm" | "deterministic";
  /**
   * When true, an "error" edge is added from each step to the end node so the
   * automation layer can halt on any step failure without extra bookkeeping.
   * Defaults to true.
   */
  readonly addErrorEdges?: boolean;
  /**
   * String that identifies "cancel" buttons in step notes/names, so a
   * `cancel` edge can be added from the step that opens the dialog.
   * Defaults to the word "cancel" — override for non-English UIs.
   */
  readonly cancelLexicon?: string | null;
}

/* -------------------------------------------------------------------------- */
/* LLM adapter contract (same shape as textToAction.ts)                        */
/* -------------------------------------------------------------------------- */

interface LlmCompleteRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly correlationId: string | null;
  readonly jsonMode: true;
}

interface LlmCompleteResponse {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
}

interface LlmAdapter {
  completeText(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
  isConfigured(): boolean;
}

async function resolveLlmAdapter(): Promise<LlmAdapter | null> {
  try {
    const mod = (await import("@zipy/llm/adapter")) as unknown as {
      getDefaultAdapter?: () => Promise<LlmAdapter> | LlmAdapter;
      default?: LlmAdapter;
    };
    if (typeof mod.getDefaultAdapter === "function") {
      const adapter = await mod.getDefaultAdapter();
      if (isLlmAdapter(adapter)) return adapter;
    }
    if (mod.default !== undefined && isLlmAdapter(mod.default)) {
      return mod.default;
    }
    return null;
  } catch {
    return null;
  }
}

function isLlmAdapter(value: unknown): value is LlmAdapter {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["completeText"] === "function" &&
    typeof v["isConfigured"] === "function"
  );
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export async function buildWorkflowGraph(
  plan: StepPlan,
  options: BuildGraphOptions = {},
): Promise<WorkflowGraph> {
  if (plan === null || typeof plan !== "object") {
    throw new ConditionalGraphError("buildWorkflowGraph requires a StepPlan.", "invalid-input");
  }
  if (!Array.isArray(plan.steps)) {
    throw new ConditionalGraphError("StepPlan.steps is missing.", "invalid-input");
  }
  if (plan.steps.length === 0) {
    throw new ConditionalGraphError("StepPlan.steps is empty.", "empty-plan");
  }

  const stepIds = new Set<string>();
  for (const s of plan.steps) {
    if (stepIds.has(s.stepId)) {
      throw new ConditionalGraphError(
        `Duplicate plan stepId "${s.stepId}"; the plan must not reuse ids.`,
        "duplicate-step-id",
        { stepId: s.stepId },
      );
    }
    stepIds.add(s.stepId);
  }

  const mode = options.mode ?? "deterministic";
  const addErrorEdges = options.addErrorEdges !== false;
  const cancelLexicon = options.cancelLexicon ?? "cancel";

  // Always build the linear spine first. Decision nodes will be spliced in
  // on top of this spine without reordering steps.
  const spine = buildSpine(plan, addErrorEdges, cancelLexicon);

  // Deterministic conditionals: from the extractor's own cues and from the
  // diagnostic conditionalCues list on the plan.
  const deterministicCandidates = collectDeterministicConditionals(plan);

  let llmCandidates: readonly ConditionalCandidate[] = [];
  let adapterUsed = false;
  let adapterFallbackReason: string | null = null;
  let model: string | null = null;

  if (mode === "llm") {
    const adapter = await resolveLlmAdapter();
    if (adapter === null || !adapter.isConfigured()) {
      adapterFallbackReason = "no-adapter-configured";
    } else {
      try {
        const completion = await adapter.completeText({
          systemPrompt: buildSystemPrompt(),
          userPrompt: buildUserPrompt(plan),
          maxOutputTokens: 1024,
          temperature: 0.1,
          correlationId: null,
          jsonMode: true,
        });
        const parsed = parseLlmConditionals(completion.text, plan);
        if (parsed === null) {
          adapterFallbackReason = "adapter-returned-invalid-json";
        } else {
          adapterUsed = true;
          model = `${completion.provider}:${completion.model}`;
          llmCandidates = parsed;
        }
      } catch {
        adapterFallbackReason = "adapter-error";
      }
    }
  }

  const allCandidates = dedupeCandidates([
    ...deterministicCandidates,
    ...llmCandidates,
  ]);

  const { nodes, edges, rejected } = spliceConditionals(
    spine.nodes,
    spine.edges,
    allCandidates,
    plan,
  );

  const acyclic = verifyAcyclic(nodes, edges);

  const acceptedLlm = allCandidates.filter((c) => c.derivedBy === "llm").length;
  const decisionCount = nodes.filter((n) => n.kind === "decision").length;

  return {
    nodes,
    edges,
    stepOrder: plan.steps.map((s) => s.stepId),
    startNodeId: spine.startNodeId,
    endNodeId: spine.endNodeId,
    diagnostics: {
      nodeCount: nodes.length,
      stepNodeCount: plan.steps.length,
      decisionNodeCount: decisionCount,
      edgeCount: edges.length,
      conditionalCuesConsidered: plan.diagnostics.conditionalCues.slice(),
      llmCandidatesConsidered: llmCandidates.length,
      llmCandidatesAccepted: acceptedLlm,
      rejectedBranches: rejected,
      hasConditionals: decisionCount > 0,
      acyclic,
    },
    generatedAt: new Date().toISOString(),
    adapterUsed,
    adapterFallbackReason,
    model,
  };
}

/* -------------------------------------------------------------------------- */
/* Spine construction                                                          */
/* -------------------------------------------------------------------------- */

interface Spine {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly startNodeId: string;
  readonly endNodeId: string;
}

function buildSpine(
  plan: StepPlan,
  addErrorEdges: boolean,
  cancelLexicon: string,
): Spine {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const startNodeId = "n_start";
  const endNodeId = "n_end";

  nodes.push({ nodeId: startNodeId, kind: "start" });

  let prevId: string = startNodeId;
  let edgeSeq = 1;

  for (const step of plan.steps) {
    const nodeId = `n_step_${step.stepId}`;
    nodes.push({
      nodeId,
      kind: "step",
      stepId: step.stepId,
      ordinal: step.ordinal,
    });
    edges.push({
      edgeId: `e${edgeSeq++}`,
      kind: "next",
      fromNodeId: prevId,
      toNodeId: nodeId,
      label: null,
    });
    prevId = nodeId;
  }

  nodes.push({ nodeId: endNodeId, kind: "end" });
  edges.push({
    edgeId: `e${edgeSeq++}`,
    kind: "next",
    fromNodeId: prevId,
    toNodeId: endNodeId,
    label: null,
  });

  if (addErrorEdges) {
    const errorLabel = "step-failed";
    for (const step of plan.steps) {
      edges.push({
        edgeId: `e${edgeSeq++}`,
        kind: "error",
        fromNodeId: `n_step_${step.stepId}`,
        toNodeId: endNodeId,
        label: errorLabel,
      });
    }
  }

  if (cancelLexicon !== null && cancelLexicon.trim().length > 0) {
    const re = new RegExp(`\\b${escapeRegExp(cancelLexicon.trim())}\\b`, "i");
    for (const step of plan.steps) {
      if (step.kind === "read-only") continue;
      const name = (step.target?.name ?? "") + " " + step.notes.join(" ");
      if (!re.test(name)) continue;
      edges.push({
        edgeId: `e${edgeSeq++}`,
        kind: "cancel",
        fromNodeId: `n_step_${step.stepId}`,
        toNodeId: endNodeId,
        label: "cancel",
      });
    }
  }

  return { nodes, edges, startNodeId, endNodeId };
}

/* -------------------------------------------------------------------------- */
/* Conditional extraction                                                      */
/* -------------------------------------------------------------------------- */

interface ConditionalCandidate {
  /** Step the decision sits *before* (the step whose condition is evaluated). */
  readonly beforeStepId: string;
  /** Where to jump on true, or null to fall through. */
  readonly onTrueStepId: string | null;
  /** Human-readable condition text as inferred. */
  readonly conditionText: string;
  readonly derivedBy: "operator-prompt" | "diagnostic-cue" | "llm";
}

const CONDITIONAL_RE =
  /\b(?:if|unless|when)\b\s+([^,;.]+?)\s*,?\s*(?:then\s+)?(?:skip\s+to|jump\s+to|go\s+to)\s+(?:step\s+)?(\d+)/gi;

/**
 * Look for conditional clues in the plan's `diagnostics.conditionalCues` and
 * in the target/notes of each step (the operator often writes the condition
 * into the step description).
 *
 * The rule produces an `on-true` jump to the *ordinal* named in the text.
 * Ordinals in the plan are 1-based, matching what a user sees in the UI.
 */
function collectDeterministicConditionals(plan: StepPlan): readonly ConditionalCandidate[] {
  const out: ConditionalCandidate[] = [];
  const ordToStepId = new Map<number, string>();
  for (const s of plan.steps) ordToStepId.set(s.ordinal, s.stepId);
  const cues = plan.diagnostics.conditionalCues;

  // Rule 1: cues from the plan diagnostics — attach the decision before the
  // first step whose text/notes mention any token from the condition.
  for (const cue of cues) {
    const parsed = parseConditionalText(cue, ordToStepId);
    if (parsed === null) continue;
    const anchor = findAnchorStep(plan, cue);
    if (anchor === null) continue;
    out.push({
      beforeStepId: anchor.stepId,
      onTrueStepId: parsed.onTrueStepId,
      conditionText: parsed.conditionText,
      derivedBy: "diagnostic-cue",
    });
  }

  // Rule 2: scan each step's notes for a "skip to step N" phrase.
  for (const step of plan.steps) {
    for (const note of step.notes) {
      const parsed = parseConditionalText(note, ordToStepId);
      if (parsed === null) continue;
      const anchor = findAnchorStep(plan, parsed.conditionText) ?? step;
      out.push({
        beforeStepId: anchor.stepId,
        onTrueStepId: parsed.onTrueStepId,
        conditionText: parsed.conditionText,
        derivedBy: "operator-prompt",
      });
    }
  }

  return out;
}

interface ParsedConditional {
  readonly conditionText: string;
  readonly onTrueStepId: string | null;
}

function parseConditionalText(
  text: string,
  ordToStepId: ReadonlyMap<number, string>,
): ParsedConditional | null {
  CONDITIONAL_RE.lastIndex = 0;
  const m = CONDITIONAL_RE.exec(text);
  if (m === null) return null;
  const conditionText = (m[1] ?? "").trim();
  const ordinalText = m[2];
  if (conditionText.length === 0 || ordinalText === undefined) return null;
  const ordinal = Number(ordinalText);
  if (!Number.isFinite(ordinal) || ordinal < 1) return null;
  const stepId = ordToStepId.get(ordinal) ?? null;
  return { conditionText, onTrueStepId: stepId };
}

/**
 * Pick the plan step that the condition should be evaluated *before*. The
 * heuristic is lexical: choose the earliest step whose accessible name or
 * notes contain the first content-bearing noun of the condition. When no step
 * matches, the caller falls back to anchoring on the first step.
 */
function findAnchorStep(plan: StepPlan, conditionText: string): PlanStep | null {
  const words = conditionText
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  if (words.length === 0) return null;
  for (const step of plan.steps) {
    const haystack = `${step.target?.name ?? ""} ${step.notes.join(" ")}`.toLowerCase();
    if (words.some((w) => haystack.includes(w))) return step;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* LLM conditional prompt + parsing                                            */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(): string {
  return [
    "You enrich a linear step plan with conditional jumps.",
    "You receive a numbered list of plan steps (ordinal, verb, target, notes).",
    "Return ONLY a JSON object:",
    '{"conditionals":[',
    '  {"beforeOrdinal": <int>,"onTrueOrdinal": <int>|null,"condition":"<short text>"}',
    "]}",
    "",
    "Rules:",
    " - beforeOrdinal and onTrueOrdinal must reference ordinals in the plan.",
    " - Use null for onTrueOrdinal when the condition falls through (no jump).",
    " - Do not add, remove or reorder steps.",
    " - Do not output commentary outside the JSON object.",
    " - Return an empty conditionals array when the plan contains no conditionals.",
  ].join("\n");
}

function buildUserPrompt(plan: StepPlan): string {
  const lines: string[] = [];
  lines.push("## Plan steps");
  for (const step of plan.steps) {
    const target = step.target?.name ?? step.ref ?? "(unmatched)";
    lines.push(
      `${step.ordinal}. ${step.action} "${target}"` +
        (step.value !== null ? ` value="${step.value}"` : "") +
        (step.notes.length > 0 ? ` -- ${step.notes.join("; ")}` : ""),
    );
  }
  if (plan.diagnostics.conditionalCues.length > 0) {
    lines.push("");
    lines.push("## Detected conditional cues");
    for (const cue of plan.diagnostics.conditionalCues) lines.push(`- ${cue}`);
  }
  return lines.join("\n");
}

function parseLlmConditionals(
  raw: string,
  plan: StepPlan,
): readonly ConditionalCandidate[] | null {
  const trimmed = raw.trim();
  let jsonText = trimmed;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence !== null && typeof fence[1] === "string") jsonText = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const list = Array.isArray(root["conditionals"]) ? (root["conditionals"] as unknown[]) : [];

  const ordToStepId = new Map<number, string>();
  for (const s of plan.steps) ordToStepId.set(s.ordinal, s.stepId);

  const out: ConditionalCandidate[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const beforeOrdinal = readOrdinal(o["beforeOrdinal"]);
    if (beforeOrdinal === null) continue;
    const beforeStepId = ordToStepId.get(beforeOrdinal);
    if (beforeStepId === undefined) continue;

    const onTrueRaw = o["onTrueOrdinal"];
    let onTrueStepId: string | null = null;
    if (onTrueRaw !== null && onTrueRaw !== undefined) {
      const onTrueOrdinal = readOrdinal(onTrueRaw);
      if (onTrueOrdinal === null) continue;
      const target = ordToStepId.get(onTrueOrdinal);
      if (target === undefined) continue;
      onTrueStepId = target;
    }

    const condition = typeof o["condition"] === "string" ? (o["condition"] as string).trim() : "";
    if (condition.length === 0) continue;

    out.push({
      beforeStepId,
      onTrueStepId,
      conditionText: condition,
      derivedBy: "llm",
    });
  }
  return out;
}

function readOrdinal(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 1) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return null;
}

function dedupeCandidates(
  list: readonly ConditionalCandidate[],
): readonly ConditionalCandidate[] {
  const seen = new Set<string>();
  const out: ConditionalCandidate[] = [];
  for (const c of list) {
    // Prefer operator-provided text over diagnostic cues over LLM text; keep
    // deterministic candidates before LLM ones for the same anchor+jump.
    const key = `${c.beforeStepId}\u0001${c.onTrueStepId ?? ""}`;
    if (seen.has(key)) {
      const existing = out.find(
        (x) => `${x.beforeStepId}\u0001${x.onTrueStepId ?? ""}` === key,
      );
      if (existing !== undefined && existing.derivedBy === "llm") {
        // Deterministic wins over LLM for the same anchor+jump.
        const idx = out.indexOf(existing);
        out[idx] = c;
      }
      continue;
    }
    seen.add(key);
    out.push(c);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Splicing conditionals into the spine                                        */
/* -------------------------------------------------------------------------- */

interface SpliceResult {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly rejected: readonly RejectedBranch[];
}

function spliceConditionals(
  spineNodes: readonly GraphNode[],
  spineEdges: readonly GraphEdge[],
  candidates: readonly ConditionalCandidate[],
  plan: StepPlan,
): SpliceResult {
  const nodes: GraphNode[] = spineNodes.slice();
  const edges: GraphEdge[] = spineEdges.slice();
  const rejected: RejectedBranch[] = [];

  // Group candidates by anchor. Multiple conditionals before the same step
  // are stacked in the order they were supplied.
  const byAnchor = new Map<string, ConditionalCandidate[]>();
  for (const c of candidates) {
    const list = byAnchor.get(c.beforeStepId);
    if (list === undefined) byAnchor.set(c.beforeStepId, [c]);
    else list.push(c);
  }

  const stepOrdinalById = new Map<string, number>();
  for (const s of plan.steps) stepOrdinalById.set(s.stepId, s.ordinal);

  let decisionSeq = 1;
  let edgeSeq = edges.length + 1;

  for (const step of plan.steps) {
    const list = byAnchor.get(step.stepId);
    if (list === undefined || list.length === 0) continue;
    const stepNodeId = `n_step_${step.stepId}`;
    const stepOrdinal = stepOrdinalById.get(step.stepId) ?? 0;

    for (const candidate of list) {
      // Validate jump target. Null target means "fall through" — no jump.
      let targetNodeId: string | null = null;
      if (candidate.onTrueStepId !== null) {
        const targetOrdinal = stepOrdinalById.get(candidate.onTrueStepId);
        if (targetOrdinal === undefined) {
          rejected.push({
            decisionNodeId: `n_decision_${decisionSeq}`,
            reason: "unknown-target-step",
            detail: `Condition references step "${candidate.onTrueStepId}" which is not in the plan.`,
          });
          continue;
        }
        // A target ordinal equal to the decision's own step creates a
        // self-loop (the decision sits immediately before its own anchor
        // step); forward jumps are fine; backward jumps are rejected as
        // potential cycles.
        if (targetOrdinal === stepOrdinal) {
          rejected.push({
            decisionNodeId: `n_decision_${decisionSeq}`,
            reason: "self-loop",
            detail: `Condition on step ${step.ordinal} targets itself.`,
          });
          continue;
        }
        if (targetOrdinal < stepOrdinal) {
          rejected.push({
            decisionNodeId: `n_decision_${decisionSeq}`,
            reason: "would-create-cycle",
            detail: `Backward jump from step ${step.ordinal} to step ${targetOrdinal} would create a cycle.`,
          });
          continue;
        }
        targetNodeId = `n_step_${candidate.onTrueStepId}`;
      }

      const decisionNodeId = `n_decision_${decisionSeq++}`;
      const conditionKey = slugifyCondition(candidate.conditionText);
      const decisionNode: DecisionNode = {
        nodeId: decisionNodeId,
        kind: "decision",
        conditionKey,
        conditionText: candidate.conditionText,
        derivedBy: candidate.derivedBy,
      };
      nodes.push(decisionNode);

      // Reroute the edge that currently flows *into* the anchor step so
      // that the decision node sits between the previous node and the
      // anchor. The previous node is whichever node's `next` or `on-false`
      // edge currently targets the anchor.
      const incomingIndex = findIncomingEdgeIndex(edges, stepNodeId);
      if (incomingIndex === -1) {
        rejected.push({
          decisionNodeId,
          reason: "duplicate-branch",
          detail: `Could not splice decision before step ${step.ordinal}: no incoming edge found.`,
        });
        nodes.pop();
        continue;
      }
      const incoming = edges[incomingIndex] as GraphEdge;
      // Replace incoming.toNodeId with the decision node.
      edges[incomingIndex] = {
        edgeId: incoming.edgeId,
        kind: incoming.kind,
        fromNodeId: incoming.fromNodeId,
        toNodeId: decisionNodeId,
        label: incoming.label,
      };

      // on-false edge: decision → anchor step.
      edges.push({
        edgeId: `e${edgeSeq++}`,
        kind: "on-false",
        fromNodeId: decisionNodeId,
        toNodeId: stepNodeId,
        label: "false",
      });

      // on-true edge: decision → target step (or anchor when no jump).
      edges.push({
        edgeId: `e${edgeSeq++}`,
        kind: "on-true",
        fromNodeId: decisionNodeId,
        toNodeId: targetNodeId ?? stepNodeId,
        label: targetNodeId === null ? "true (continue)" : "true (jump)",
      });
    }
  }

  return { nodes, edges, rejected };
}

function findIncomingEdgeIndex(edges: readonly GraphEdge[], toNodeId: string): number {
  // Prefer a `next` or `on-false` edge; fall back to any incoming edge so a
  // decision spliced after another decision lands correctly.
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i] as GraphEdge;
    if (e.toNodeId !== toNodeId) continue;
    if (e.kind === "next" || e.kind === "on-false") return i;
  }
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i] as GraphEdge;
    if (e.toNodeId === toNodeId) return i;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Acyclicity check                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Verify the graph has no directed cycle by attempting a topological sort
 * over the intended execution direction. Error and cancel edges terminate at
 * the end node and are excluded from the cycle check because they are
 * exceptional, not part of the flow.
 */
function verifyAcyclic(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): boolean {
  const nodeIds = new Set(nodes.map((n) => n.nodeId));
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const e of edges) {
    if (e.kind === "error" || e.kind === "cancel") continue;
    const list = adjacency.get(e.fromNodeId);
    if (list !== undefined) list.push(e.toNodeId);
  }

  // Three-colour DFS: 0 = unvisited, 1 = visiting, 2 = done.
  const colour = new Map<string, 0 | 1 | 2>();
  for (const id of nodeIds) colour.set(id, 0);

  for (const start of nodeIds) {
    if (colour.get(start) !== 0) continue;
    const stack: Array<{ id: string; index: number }> = [{ id: start, index: 0 }];
    colour.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; index: number };
      const children = adjacency.get(frame.id) ?? [];
      if (frame.index >= children.length) {
        colour.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const child = children[frame.index] as string;
      frame.index += 1;
      const c = colour.get(child);
      if (c === 1) return false; // back-edge found
      if (c === 0) {
        colour.set(child, 1);
        stack.push({ id: child, index: 0 });
      }
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function slugifyCondition(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateWorkflowGraph(value: unknown): WorkflowGraph {
  if (value === null || typeof value !== "object") {
    throw new ConditionalGraphError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const nodesRaw = Array.isArray(r["nodes"]) ? (r["nodes"] as unknown[]) : [];
  const edgesRaw = Array.isArray(r["edges"]) ? (r["edges"] as unknown[]) : [];
  const diagRaw = (r["diagnostics"] ?? {}) as Record<string, unknown>;

  const nodes: GraphNode[] = [];
  for (const raw of nodesRaw) {
    const n = readNode(raw);
    if (n !== null) nodes.push(n);
  }
  const edges: GraphEdge[] = [];
  for (const raw of edgesRaw) {
    const e = readEdge(raw);
    if (e !== null) edges.push(e);
  }
  const rejected: RejectedBranch[] = Array.isArray(diagRaw["rejectedBranches"])
    ? (diagRaw["rejectedBranches"] as unknown[])
        .map((item) => {
          if (item === null || typeof item !== "object") return null;
          const o = item as Record<string, unknown>;
          const reasonRaw = o["reason"];
          const reason: RejectedBranch["reason"] =
            reasonRaw === "unknown-target-step" ||
            reasonRaw === "would-create-cycle" ||
            reasonRaw === "duplicate-branch" ||
            reasonRaw === "self-loop"
              ? reasonRaw
              : "duplicate-branch";
          return {
            decisionNodeId:
              typeof o["decisionNodeId"] === "string" ? (o["decisionNodeId"] as string) : "",
            reason,
            detail: typeof o["detail"] === "string" ? (o["detail"] as string) : "",
          };
        })
        .filter((x): x is RejectedBranch => x !== null)
    : [];

  return {
    nodes,
    edges,
    stepOrder: Array.isArray(r["stepOrder"])
      ? (r["stepOrder"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    startNodeId: typeof r["startNodeId"] === "string" ? (r["startNodeId"] as string) : "n_start",
    endNodeId: typeof r["endNodeId"] === "string" ? (r["endNodeId"] as string) : "n_end",
    diagnostics: {
      nodeCount:
        typeof diagRaw["nodeCount"] === "number" && Number.isFinite(diagRaw["nodeCount"] as number)
          ? Math.max(0, Math.floor(diagRaw["nodeCount"] as number))
          : nodes.length,
      stepNodeCount:
        typeof diagRaw["stepNodeCount"] === "number" && Number.isFinite(diagRaw["stepNodeCount"] as number)
          ? Math.max(0, Math.floor(diagRaw["stepNodeCount"] as number))
          : nodes.filter((n) => n.kind === "step").length,
      decisionNodeCount:
        typeof diagRaw["decisionNodeCount"] === "number" &&
        Number.isFinite(diagRaw["decisionNodeCount"] as number)
          ? Math.max(0, Math.floor(diagRaw["decisionNodeCount"] as number))
          : nodes.filter((n) => n.kind === "decision").length,
      edgeCount:
        typeof diagRaw["edgeCount"] === "number" && Number.isFinite(diagRaw["edgeCount"] as number)
          ? Math.max(0, Math.floor(diagRaw["edgeCount"] as number))
          : edges.length,
      conditionalCuesConsidered: Array.isArray(diagRaw["conditionalCuesConsidered"])
        ? (diagRaw["conditionalCuesConsidered"] as unknown[]).filter(
            (s): s is string => typeof s === "string",
          )
        : [],
      llmCandidatesConsidered:
        typeof diagRaw["llmCandidatesConsidered"] === "number" &&
        Number.isFinite(diagRaw["llmCandidatesConsidered"] as number)
          ? Math.max(0, Math.floor(diagRaw["llmCandidatesConsidered"] as number))
          : 0,
      llmCandidatesAccepted:
        typeof diagRaw["llmCandidatesAccepted"] === "number" &&
        Number.isFinite(diagRaw["llmCandidatesAccepted"] as number)
          ? Math.max(0, Math.floor(diagRaw["llmCandidatesAccepted"] as number))
          : 0,
      rejectedBranches: rejected,
      hasConditionals: diagRaw["hasConditionals"] === true,
      acyclic: diagRaw["acyclic"] !== false,
    },
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
    adapterUsed: r["adapterUsed"] === true,
    adapterFallbackReason:
      typeof r["adapterFallbackReason"] === "string"
        ? (r["adapterFallbackReason"] as string)
        : null,
    model: typeof r["model"] === "string" ? (r["model"] as string) : null,
  };
}

function readNode(raw: unknown): GraphNode | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nodeId = typeof o["nodeId"] === "string" ? (o["nodeId"] as string) : "";
  if (nodeId.length === 0) return null;
  const kindRaw = o["kind"];
  if (kindRaw === "start") return { nodeId, kind: "start" };
  if (kindRaw === "end") return { nodeId, kind: "end" };
  if (kindRaw === "step") {
    const stepId = typeof o["stepId"] === "string" ? (o["stepId"] as string) : "";
    if (stepId.length === 0) return null;
    const ordinal =
      typeof o["ordinal"] === "number" && Number.isFinite(o["ordinal"] as number)
        ? Math.max(1, Math.floor(o["ordinal"] as number))
        : 1;
    return { nodeId, kind: "step", stepId, ordinal };
  }
  if (kindRaw === "decision") {
    const conditionText = typeof o["conditionText"] === "string" ? (o["conditionText"] as string) : "";
    if (conditionText.length === 0) return null;
    const derivedByRaw = o["derivedBy"];
    const derivedBy: DecisionNode["derivedBy"] =
      derivedByRaw === "operator-prompt" || derivedByRaw === "diagnostic-cue" || derivedByRaw === "llm"
        ? derivedByRaw
        : "operator-prompt";
    return {
      nodeId,
      kind: "decision",
      conditionKey:
        typeof o["conditionKey"] === "string" && (o["conditionKey"] as string).length > 0
          ? (o["conditionKey"] as string)
          : slugifyCondition(conditionText),
      conditionText,
      derivedBy,
    };
  }
  return null;
}

function readEdge(raw: unknown): GraphEdge | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const edgeId = typeof o["edgeId"] === "string" ? (o["edgeId"] as string) : "";
  const fromNodeId = typeof o["fromNodeId"] === "string" ? (o["fromNodeId"] as string) : "";
  const toNodeId = typeof o["toNodeId"] === "string" ? (o["toNodeId"] as string) : "";
  if (edgeId.length === 0 || fromNodeId.length === 0 || toNodeId.length === 0) return null;
  const kindRaw = o["kind"];
  const kind: EdgeKind =
    kindRaw === "next" ||
    kindRaw === "on-true" ||
    kindRaw === "on-false" ||
    kindRaw === "cancel" ||
    kindRaw === "error"
      ? kindRaw
      : "next";
  return {
    edgeId,
    kind,
    fromNodeId,
    toNodeId,
    label: typeof o["label"] === "string" ? (o["label"] as string) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  buildSpine,
  collectDeterministicConditionals,
  parseConditionalText,
  findAnchorStep,
  parseLlmConditionals,
  dedupeCandidates,
  spliceConditionals,
  findIncomingEdgeIndex,
  verifyAcyclic,
  slugifyCondition,
  CONDITIONAL_RE,
});
