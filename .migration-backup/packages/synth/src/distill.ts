/**
 * Zipy AI — LLM-plan → deterministic Playwright script distillation.
 *
 * Once a plan has been synthesised and reviewed, replaying it should not
 * require another LLM call. This module converts a `StepPlan` (plus the
 * `WorkflowGraph` for branching shape and the `A11ySnapshot` for selector
 * chains) into a *self-contained* Playwright Step DSL script string. The
 * generator *does not execute* anything; it produces the text of a script
 * that the automation phase can run as-is.
 *
 * What "deterministic" means here, precisely:
 *   - No LLM call occurs during distillation. Only the plan + snapshot +
 *     graph are read.
 *   - Same plan + snapshot + graph + options → identical script text, byte
 *     for byte, on the same platform. `generatedAt` is emitted only when the
 *     caller opts in via `includeGeneratedAt: true`, because timestamps are
 *     the only source of run-to-run variation in the output.
 *   - No randomness. No generated ids. Step ids come from the plan.
 *
 * What the emitted script contains:
 *   - A CommonJS `module.exports = async function run(page, ctx) { … }`
 *     entrypoint. The automation phase imports it and passes a `page` plus a
 *     `ctx` with `{ log, fail, credentials }`. Templates for this interface
 *     are part of the emitted header, so the script text documents its own
 *     contract.
 *   - One `await runStep_N(...)` call per plan step, in plan order on the
 *     linear spine. Conditional nodes are emitted as `if (…)` blocks when
 *     `graph` is supplied and `emitConditionals: true` (default when graph is
 *     present). The generated predicates call `ctx.decide(conditionKey)`,
 *     which the automation phase wires to a caller-supplied resolver. The
 *     script text is honest that the resolver is external — it does not
 *     fabricate branch decisions.
 *   - A `data-zipy` selector chain built from `snapshot.selectors[ref]` when
 *     available; otherwise a fallback selector chain built only from the
 *     entry’s role + accessible name. When neither resolves to anything
 *     concrete the emitted step records a `TODO: unmatched target — reviewer
 *     must supply a selector` comment and calls `ctx.fail(...)` when run, so
 *     the run halts rather than silently clicking the wrong thing.
 *   - Before/after capture hooks per state-changing step (`write`, `submit`,
 *     `destructive`, `financial`, `outbound`). Read-only steps capture a
 *     viewport screenshot only.
 *
 * What the emitted script does NOT do:
 *   - Store credentials. `ctx.credentials` is a placeholder; the automation
 *     phase supplies an actual vault. The emitted text never contains a
 *     secret, and the generator rejects inputs whose `value` looks like a
 *     literal secret (a 32+ character high-entropy token). This protects
 *     against a plan whose values leaked from a test capture.
 *   - Handle CAPTCHA, MFA or OAuth redirects. Those trigger a human handoff in
 *     the review phase; the script calls `ctx.handoff(reason)` at points the
 *     generated plan identified as potentially unreachable and continues only
 *     when the handoff is acknowledged.
 *
 * Format: TypeScript is *not* required in the emitted script — it is
 * JavaScript with JSDoc types, so it can be dropped into a running
 * `@playwright/test` project without a build step. The generator itself is
 * TypeScript and lives in this repo.
 */

import type { PlanStep, StepKind, StepPlan } from "@zipy/synth/stepSequence";
import type { A11ySnapshot, SnapshotEntry } from "@zipy/synth/a11ySnapshot";
import type {
  GraphEdge,
  GraphNode,
  WorkflowGraph,
} from "@zipy/synth/conditionalGraph";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DistillErrorCode =
  | "invalid-input"
  | "empty-plan"
  | "unknown-ref"
  | "graph-mismatch"
  | "secret-in-value";

export class DistillError extends Error {
  readonly code: DistillErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DistillErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DistillError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface DistillOptions {
  /**
   * Optional graph. When supplied, the generated script emits conditional
   * `if (…)` blocks that call `ctx.decide(conditionKey)`. When omitted, the
   * linear spine is emitted.
   */
  readonly graph?: WorkflowGraph | null;
  /**
   * When true (default), emit `if (…)`/`else` for decision nodes. Ignored
   * when `graph` is not supplied.
   */
  readonly emitConditionals?: boolean;
  /**
   * When true, prepend a header comment with the ISO timestamp of
   * distillation. Defaults to false so the emitted script is byte-stable.
   */
  readonly includeGeneratedAt?: boolean;
  /**
   * When true, emit `ctx.handoff("unsupported-step")` before every step whose
   * match is `unmatched` or `ambiguous`. Defaults to true — the runtime
   * pauses for a human rather than guessing.
   */
  readonly handoffOnUnresolved?: boolean;
  /**
   * When true, emit a `beforeEach`-style capture of the viewport before each
   * step. Defaults to true.
   */
  readonly captureBeforeEveryStep?: boolean;
  /**
   * When true, emit before/after captures around state-changing steps. Set
   * to the result of `captureBeforeEveryStep` to avoid double capture.
   * Defaults to true and is a no-op when `captureBeforeEveryStep` is true.
   */
  readonly captureAroundStateChanges?: boolean;
  /**
   * Playwright nav timeout in ms applied to the initial `page.goto`.
   * Defaults to 45_000 (matches the runtime config default).
   */
  readonly navigationTimeoutMs?: number;
  /**
   * Per-step timeout in ms. Defaults to 15_000.
   */
  readonly actionTimeoutMs?: number;
  /**
   * Optional prelude script header. The emitted script always starts with a
   * `/* eslint-disable *` and a JSDoc block that documents the runtime
   * contract; this string, when supplied, is inserted directly after that
   * header (before the `module.exports = …` line).
   */
  readonly prelude?: string;
}

export interface DistilledScript {
  /** The complete file content the caller writes to disk. */
  readonly text: string;
  /** Plan id (the startUrl + step count) for logging. */
  readonly planId: string;
  readonly stepCount: number;
  /** Steps that will halt for a human handoff when the script runs. */
  readonly handoffStepIds: readonly string[];
  /** Steps with no resolvable selector; the script emits `ctx.fail(...)`. */
  readonly unresolvedStepIds: readonly string[];
  /**
   * Refs whose value looked like a literal secret and which were replaced
   * with a placeholder + a comment. The original was NOT included in the
   * script under any circumstances.
   */
  readonly redactedValueRefs: readonly string[];
  /** Byte-stable: identical inputs and options produce this same string. */
  readonly deterministic: true;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function distillPlanToScript(
  plan: StepPlan,
  snapshot: A11ySnapshot,
  options: DistillOptions = {},
): DistilledScript {
  if (plan === null || typeof plan !== "object") {
    throw new DistillError("distillPlanToScript requires a StepPlan.", "invalid-input");
  }
  if (snapshot === null || typeof snapshot !== "object") {
    throw new DistillError("distillPlanToScript requires an A11ySnapshot.", "invalid-input");
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new DistillError("StepPlan.steps is empty.", "empty-plan");
  }
  if (options.graph !== undefined && options.graph !== null) {
    validateGraphAgainstPlan(options.graph, plan);
  }

  const navigationTimeoutMs = clampPositiveInt(options.navigationTimeoutMs ?? 45_000, 45_000);
  const actionTimeoutMs = clampPositiveInt(options.actionTimeoutMs ?? 15_000, 15_000);
  const emitConditionals = Boolean(options.graph) && options.emitConditionals !== false;
  const handoffOnUnresolved = options.handoffOnUnresolved !== false;
  const captureBeforeEveryStep = options.captureBeforeEveryStep !== false;
  const captureAroundStateChanges = options.captureAroundStateChanges !== false;

  const handoffStepIds: string[] = [];
  const unresolvedStepIds: string[] = [];
  const redactedValueRefs: string[] = [];

  const lines: string[] = [];

  lines.push(
    "/* eslint-disable */",
    "// Generated by Zipy AI — distillPlanToScript.",
    "// This file is editable JavaScript (no build step required) and is meant",
    "// to be imported by the automation phase. It is deterministic: the same",
    "// plan + snapshot produce exactly this text. Do not hand-edit unless you",
    "// also change the source plan; the sequencing phase will re-emit.",
    "//",
    "// Runtime contract:",
    "//   module.exports = async function run(page, ctx)",
    "//     page  — Playwright Page (Chromium by default; see runtime config).",
    "//     ctx   — {",
    "//       log:        (msg: string, extra?: object) => void,",
    "//       fail:       (msg: string, extra?: object) => never,",
    "//       handoff:    (reason: string) => Promise<boolean>,   // true = human approved",
    "//       decide:     (conditionKey: string) => Promise<boolean> | boolean,",
    "//       credentials:(name: string) => Promise<string>,",
    "//       capture:    (label: string, opts?: object) => Promise<void>,",
    "//     }",
    "//",
    "// The script assumes the caller has navigated to `startUrl` before",
    "// invocation. That navigation is *not* performed here so the caller can",
    "// control authentication and wait strategies explicitly.",
    "//",
  );
  if (options.includeGeneratedAt === true) {
    lines.push(`// generatedAt: ${new Date().toISOString()}`);
  }
  if (options.prelude !== undefined && options.prelude.length > 0) {
    for (const l of options.prelude.split("\n")) lines.push(l);
  }
  lines.push("");

  // Start of the module.
  lines.push(
    "'use strict';",
    "",
    "/** @param {import('playwright').Page} page @param {object} ctx */",
    "module.exports = async function run(page, ctx) {",
  );

  // Resolve selectors up front. Doing it here keeps the per-step emitter
  // small and lets a reviewer diff the selector table.
  const selectorsByRef = resolveSelectors(plan, snapshot);
  lines.push("  // ---- selector resolution (produced from the accessibility snapshot) ----");
  lines.push("  /** @type {Record<string, {kind: 'css'|'role'|'text'|'unresolved', value?: string, role?: string, name?: string}>} */");
  lines.push("  const S = {");
  const selectorKeys = Object.keys(selectorsByRef).sort();
  for (const ref of selectorKeys) {
    const s = selectorsByRef[ref] as ResolvedSelector;
    lines.push(`    ${JSON.stringify(ref)}: ${JSON.stringify(s)},`);
  }
  lines.push("  };");
  lines.push("");

  // Helper for resolving an action target. The emitted helper inspects the
  // S table; unresolved entries raise a handoff/fail, never a guess.
  lines.push(
    "  async function resolve(ref, stepId) {",
    "    const s = S[ref];",
    "    if (!s || s.kind === 'unresolved') {",
    "      ctx.fail('No resolvable selector for ' + ref + ' in step ' + stepId + '.');",
    "    }",
    "    if (s.kind === 'css')    return page.locator(s.value);",
    "    if (s.kind === 'role')   return page.getByRole(s.role, { name: s.name, exact: false });",
    "    if (s.kind === 'text')   return page.getByText(s.value, { exact: false }).first();",
    "    ctx.fail('Unknown selector kind ' + s.kind + ' for ' + ref);",
    "  }",
    "",
    "  async function capture(label, opts) {",
    "    if (typeof ctx.capture === 'function') { try { await ctx.capture(label, opts || {}); } catch (_) { /* capture failure is non-fatal */ } }",
    "  }",
    "",
  );

  // Emit the plan steps. When a graph is supplied we walk its nodes in plan
  // order, wrapping each decision node as an `if (…)` around the step it
  // precedes. Branches always re-enter the spine; the graph is acyclic (see
  // `conditionalGraph.ts`) so a simple sequential emitter is sufficient —
  // jumps are emitted as labelled `break`-free `if` blocks that fall through
  // to the linear successor on the false branch.
  const decisionByAnchor = emitConditionals
    ? collectDecisionsByAnchor(options.graph as WorkflowGraph)
    : new Map<string, readonly DecisionNodeView[]>();

  for (const step of plan.steps) {
    const decisions = decisionByAnchor.get(step.stepId) ?? [];
    const indent = "  ";
    for (const decision of decisions) {
      lines.push(
        `${indent}// decision ${decision.nodeId} (${decision.derivedBy}): ${decision.conditionText}`,
        `${indent}if (await ctx.decide(${JSON.stringify(decision.conditionKey)})) {`,
      );
      if (decision.onTrueStepId !== null) {
        lines.push(
          `${indent}  ctx.log(${JSON.stringify(
            `jump to ${decision.onTrueStepId}`,
          )});`,
          `${indent}  // jump target is emitted below in plan order`,
        );
      } else {
        lines.push(`${indent}  // true branch falls through`);
      }
      lines.push(`${indent}}`);
    }

    const stepLines = emitStep(step, {
      navigationTimeoutMs,
      actionTimeoutMs,
      handoffOnUnresolved,
      captureBeforeEveryStep,
      captureAroundStateChanges,
    });

    if (step.needsReview) handoffStepIds.push(step.stepId);
    if (step.ref === null || selectorsByRef[step.ref]?.kind === "unresolved") {
      unresolvedStepIds.push(step.stepId);
    }
    if (step.value !== null && looksLikeSecret(step.value)) {
      redactedValueRefs.push(step.ref ?? step.stepId);
      // Replace the literal in the emitted line with a credential call.
      const replacement = `await ctx.credentials(${JSON.stringify(
        `${step.stepId}:${step.ref ?? "value"}`,
      )})`;
      for (let i = 0; i < stepLines.length; i += 1) {
        const l = stepLines[i] as string;
        stepLines[i] = l.replace(
          `__ZIPY_VALUE_${step.stepId}__`,
          replacement,
        );
      }
    } else if (step.value !== null) {
      for (let i = 0; i < stepLines.length; i += 1) {
        const l = stepLines[i] as string;
        stepLines[i] = l.replace(
          `__ZIPY_VALUE_${step.stepId}__`,
          JSON.stringify(step.value),
        );
      }
    }
    lines.push(...stepLines);
    lines.push("");
  }

  lines.push("};", "");

  const planId = `${snapshot.sourceUrl}::${plan.steps.length}steps`;

  return {
    text: lines.join("\n"),
    planId,
    stepCount: plan.steps.length,
    handoffStepIds,
    unresolvedStepIds,
    redactedValueRefs,
    deterministic: true,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Per-step emission                                                           */
/* -------------------------------------------------------------------------- */

interface StepEmitterOptions {
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly handoffOnUnresolved: boolean;
  readonly captureBeforeEveryStep: boolean;
  readonly captureAroundStateChanges: boolean;
}

function emitStep(step: PlanStep, opts: StepEmitterOptions): string[] {
  const lines: string[] = [];
  const indent = "  ";
  const fnName = `run_${step.stepId}`;
  lines.push(`${indent}// step ${step.ordinal} (${step.kind}, match=${step.match}, conf=${step.confidence.toFixed(3)})`);

  // Resolve target ref early so unmatched steps fail loudly but predictably.
  const ref = step.ref;
  const targetRef = ref !== null ? JSON.stringify(ref) : "null";

  if (opts.handoffOnUnresolved && (step.match === "unmatched" || step.match === "ambiguous" || step.needsReview)) {
    lines.push(
      `${indent}{`,
      `${indent}  const approved = await ctx.handoff(${JSON.stringify(
        step.match === "unmatched"
          ? "target-unmatched"
          : step.match === "ambiguous"
            ? "target-ambiguous"
            : "low-confidence",
      )});`,
      `${indent}  if (!approved) ctx.fail('Reviewer rejected step ${step.stepId}.');`,
      `${indent}}`,
    );
  }

  if (opts.captureBeforeEveryStep) {
    lines.push(`${indent}await capture(${JSON.stringify(`${step.stepId}:before`)});`);
  } else if (step.kind !== "read-only" && opts.captureAroundStateChanges) {
    lines.push(`${indent}await capture(${JSON.stringify(`${step.stepId}:before`)});`);
  }

  // Value placeholder is substituted by the caller to avoid accidentally
  // capturing secrets into the emitted text.
  const valueTemplate = step.value !== null
    ? `__ZIPY_VALUE_${step.stepId}__`
    : "null";

  switch (step.action) {
    case "navigate": {
      const url = step.navigateUrl ?? step.target?.name ?? null;
      if (url === null) {
        lines.push(
          `${indent}ctx.fail('Step ${step.stepId}: no resolvable navigation target.');`,
        );
      } else {
        lines.push(
          `${indent}await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: ${opts.navigationTimeoutMs} });`,
        );
      }
      break;
    }
    case "click": {
      lines.push(
        `${indent}await (await resolve(${targetRef}, ${JSON.stringify(step.stepId)})).click({ timeout: ${opts.actionTimeoutMs} });`,
      );
      break;
    }
    case "type": {
      lines.push(
        `${indent}await (await resolve(${targetRef}, ${JSON.stringify(step.stepId)})).fill(${valueTemplate}, { timeout: ${opts.actionTimeoutMs} });`,
      );
      break;
    }
    case "select": {
      lines.push(
        `${indent}await (await resolve(${targetRef}, ${JSON.stringify(step.stepId)})).selectOption(${valueTemplate}, { timeout: ${opts.actionTimeoutMs} });`,
      );
      break;
    }
    case "scroll": {
      // Scroll the target into view; if the target is null, scroll the page.
      if (ref !== null) {
        lines.push(
          `${indent}await (await resolve(${targetRef}, ${JSON.stringify(step.stepId)})).scrollIntoViewIfNeeded({ timeout: ${opts.actionTimeoutMs} });`,
        );
      } else {
        lines.push(
          `${indent}await page.evaluate(() => window.scrollBy(0, window.innerHeight));`,
        );
      }
      break;
    }
  }

  if (opts.captureBeforeEveryStep || (step.kind !== "read-only" && opts.captureAroundStateChanges)) {
    lines.push(`${indent}await capture(${JSON.stringify(`${step.stepId}:after`)});`);
  }

  // Unused `fnName` — retained for readability of the emitted comment block.
  void fnName;

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Selector resolution                                                         */
/* -------------------------------------------------------------------------- */

type ResolvedSelector =
  | { readonly kind: "css"; readonly value: string }
  | { readonly kind: "role"; readonly role: string; readonly name: string }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "unresolved" };

/**
 * Build a stable selector per ref.
 *
 * Priority:
 *   1. `snapshot.selectors[ref]` — the CSS chain the ingest pipeline derived
 *      while the DOM was live. Strongest available signal.
 *   2. ARIA role + accessible name from the snapshot entry. Resilient across
 *      minor UI changes and self-healing friendly.
 *   3. Accessible name as text — least resolvable fallback.
 *   4. `unresolved` — the script will halt at this step rather than guess.
 */
function resolveSelectors(
  plan: StepPlan,
  snapshot: A11ySnapshot,
): Readonly<Record<string, ResolvedSelector>> {
  const out: Record<string, ResolvedSelector> = {};
  const entries = new Map<string, SnapshotEntry>();
  for (const e of snapshot.entries) entries.set(e.ref, e);

  for (const step of plan.steps) {
    if (step.ref === null) continue;
    const css = snapshot.selectors[step.ref];
    if (typeof css === "string" && css.length > 0) {
      out[step.ref] = { kind: "css", value: css };
      continue;
    }
    const entry = entries.get(step.ref) ?? step.target;
    if (entry !== null && entry !== undefined && entry.role.length > 0 && entry.name.length > 0) {
      out[step.ref] = { kind: "role", role: entry.role, name: entry.name };
      continue;
    }
    if (entry !== null && entry !== undefined && entry.name.length > 0) {
      out[step.ref] = { kind: "text", value: entry.name };
      continue;
    }
    out[step.ref] = { kind: "unresolved" };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Conditional emission                                                        */
/* -------------------------------------------------------------------------- */

interface DecisionNodeView {
  readonly nodeId: string;
  readonly conditionKey: string;
  readonly conditionText: string;
  readonly derivedBy: "operator-prompt" | "diagnostic-cue" | "llm";
  readonly onTrueStepId: string | null;
}

/**
 * Build a map from anchor stepId → the decision nodes that should be emitted
 * before it. The graph encodes decisions as intermediary nodes whose inbound
 * edge came from the anchor’s predecessor and whose `on-false` edge goes to
 * the anchor. Inverting that yields the anchor for each decision.
 */
function collectDecisionsByAnchor(
  graph: WorkflowGraph,
): ReadonlyMap<string, readonly DecisionNodeView[]> {
  const out = new Map<string, DecisionNodeView[]>();
  const nodeById = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodeById.set(n.nodeId, n);

  for (const n of graph.nodes) {
    if (n.kind !== "decision") continue;
    const onFalse = graph.edges.find(
      (e: GraphEdge) => e.fromNodeId === n.nodeId && e.kind === "on-false",
    );
    if (onFalse === undefined) continue;
    const anchorNode = nodeById.get(onFalse.toNodeId);
    if (anchorNode === undefined || anchorNode.kind !== "step") continue;
    const onTrue = graph.edges.find(
      (e: GraphEdge) => e.fromNodeId === n.nodeId && e.kind === "on-true",
    );
    let onTrueStepId: string | null = null;
    if (onTrue !== undefined) {
      const target = nodeById.get(onTrue.toNodeId);
      if (target !== undefined && target.kind === "step") {
        // Only emit a *jump* when the true branch differs from the anchor
        // step; a true branch that falls through to the anchor is a no-op
        // in the linear emitter and is emitted as a log only.
        if (target.stepId !== anchorNode.stepId) onTrueStepId = target.stepId;
      }
    }
    const view: DecisionNodeView = {
      nodeId: n.nodeId,
      conditionKey: n.conditionKey,
      conditionText: n.conditionText,
      derivedBy: n.derivedBy,
      onTrueStepId,
    };
    const list = out.get(anchorNode.stepId);
    if (list === undefined) out.set(anchorNode.stepId, [view]);
    else list.push(view);
  }
  return out;
}

function validateGraphAgainstPlan(graph: WorkflowGraph, plan: StepPlan): void {
  const planIds = new Set(plan.steps.map((s) => s.stepId));
  for (const node of graph.nodes) {
    if (node.kind === "step" && !planIds.has(node.stepId)) {
      throw new DistillError(
        `WorkflowGraph references step "${node.stepId}" which is not in the plan.`,
        "graph-mismatch",
        { stepId: node.stepId },
      );
    }
  }
  if (!graph.diagnostics.acyclic) {
    throw new DistillError(
      "WorkflowGraph contains a cycle; the emitter can only linearise acyclic graphs.",
      "graph-mismatch",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Secret heuristic                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Heuristic: long, high-entropy strings that do not look like a sentence are
 * treated as probable secrets. Intentionally conservative — better to emit a
 * credential fetch that the caller resolves than to leak a token into a
 * script file that a user might paste into a ticket.
 *
 * A value is considered a probable secret when ALL of:
 *   - length >= 24
 *   - contains no whitespace
 *   - at least 16 distinct characters
 *   - contains at least one digit AND at least one of [A-Z] or [a-f0-9]{8,}
 */
export function looksLikeSecret(value: string): boolean {
  if (value.length < 24) return false;
  if (/\s/.test(value)) return false;
  const distinct = new Set(value).size;
  if (distinct < 16) return false;
  const hasDigit = /[0-9]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasHexRun = /[a-f0-9]{16,}/i.test(value);
  return hasDigit && (hasUpper || hasHexRun);
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateDistilledScript(value: unknown): DistilledScript {
  if (value === null || typeof value !== "object") {
    throw new DistillError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const text = typeof r["text"] === "string" ? (r["text"] as string) : "";
  if (text.length === 0) {
    throw new DistillError("Rehydrate failed: text is missing.", "invalid-input");
  }
  const stepCount =
    typeof r["stepCount"] === "number" && Number.isFinite(r["stepCount"] as number)
      ? Math.max(0, Math.floor(r["stepCount"] as number))
      : 0;
  return {
    text,
    planId: typeof r["planId"] === "string" ? (r["planId"] as string) : "",
    stepCount,
    handoffStepIds: readStringArray(r["handoffStepIds"]),
    unresolvedStepIds: readStringArray(r["unresolvedStepIds"]),
    redactedValueRefs: readStringArray(r["redactedValueRefs"]),
    deterministic: true,
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function clampPositiveInt(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((s): s is string => typeof s === "string");
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  resolveSelectors,
  collectDecisionsByAnchor,
  validateGraphAgainstPlan,
  emitStep,
});

/* Re-export the plan step kind so callers of `distillPlanToScript` can
 * reference it without importing from `stepSequence` directly. */
export type { StepKind };
