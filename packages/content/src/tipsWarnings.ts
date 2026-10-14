/**
 * Zipy AI — tips, warnings and troubleshooting generation (content-generation core, batch 1).
 *
 * The fourth layer of the core writing engine. Where `titleSummary.ts`,
 * `introPrereqs.ts` and `stepText.ts` write the guide's spine, this module
 * writes the callouts that precede, accompany or follow the steps:
 *
 *   - **tips** — short pieces of advice that make a step easier or faster
 *     without changing what the reader has to do ("Press Tab to move to the
 *     next field").
 *   - **warnings** — short caveats about a step that the reader should not
 *     skip or that could cause harm ("This action cannot be undone.").
 *   - **troubleshooting** — one or more question/answer pairs covering a
 *     likely error: what the reader sees, and what to try ("If the button is
 *     greyed out, check that you selected a customer first.").
 *
 * The module is anchored to the plan and the sources, exactly like the other
 * content layers, and produces deterministic output when no LLM is
 * configured. The deterministic composer is derived from a small, documented
 * set of signals — there is no hidden heuristic:
 *
 *   - **Warnings** are driven by the step's `kind`. A `destructive` step
 *     ("Delete customer") warns that the action removes data; a `financial`
 *     step warns that money will move; an `outbound` step warns that a
 *     message leaves the application; a `submit` step is warned when there is
 *     no preceding confirmation step. A `write` step whose target role is
 *     `textbox` and whose accessible name or an accompanying source excerpt
 *     matches a uniqueness keyword ("unique", "cannot be changed") gets a
 *     warning, because the reader needs the constraint spelled out.
 *   - **Tips** are driven by the step's action. A `type` step whose
 *     following step types into the same form gets a "use Tab" tip. A
 *     `select` step whose accessible name matches a known long-list pattern
 *     ("Country", "Currency") gets a "type to filter" tip when the source
 *     excerpt mentions search. A `navigate` step that is the plan's first
 *     step gets a "bookmark this URL" tip. A `scroll` step that is the
 *     last step before a commit click gets a "review the whole page" tip.
 *   - **Troubleshooting** entries are derived from the step's `kind` and its
 *     `match`. An `unmatched` step always produces a troubleshooting entry
 *     ("If you cannot find the button, the interface may have changed
 *     since this guide was captured."). An `ambiguous` step produces one
 *     that names the alternatives. A `destructive` step produces an undo
 *     entry. A `financial` step produces a "contact support if the charge
 *     is wrong" entry.
 *
 * Every callout carries the step it is attached to (`stepId` or null for
 * guide-level), a severity, a source (`composed`, `llm` or `fallback`),
 * and, when derived from a source, the source label it came from, so the
 * provenance panel can trace it.
 *
 * Design rules honoured:
 *  - Same `LlmHandle` shape used by the other content layers; a single
 *    adapter instance threads through the pipeline.
 *  - Deterministic output is the default. The LLM path merges additional
 *    callouts on top of the deterministic set; it never replaces the
 *    deterministic set, because a warning the composer believes must be
 *    shown should not be hidden by a model that disagrees.
 *  - No invented UI labels, no invented constraints, no invented error
 *    messages. Every callout is grounded in a plan step, a source excerpt
 *    supplied by the caller, or a source label.
 *  - The module is a pure function of its arguments plus, in the LLM path,
 *    one adapter call. It performs no I/O.
 */

import type { PlanStep, StepKind } from "@zipy/synth/stepSequence";
import type { LlmProvider } from "@zipy/llm/adapter";
import type { TitleSummarySource } from "@zipy/content/titleSummary";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TipsWarningsErrorCode = "invalid-input" | "empty-plan";

export class TipsWarningsError extends Error {
  readonly code: TipsWarningsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TipsWarningsErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* LLM handle contract                                                         */
/* -------------------------------------------------------------------------- */

export interface TipsWarningsLlmHandle {
  readonly complete: (args: {
    readonly task: "content.tipsWarnings";
    readonly system: string;
    readonly user: string;
    readonly maxOutputChars: number;
    readonly temperature: number;
    readonly provider?: LlmProvider;
    readonly model?: string | null;
  }) => Promise<{ readonly text: string }>;
  readonly isConfigured: () => boolean;
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export const CALLOUT_KINDS = ["tip", "warning", "note", "troubleshooting"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export const CALLOUT_SEVERITIES = ["info", "caution", "danger"] as const;
export type CalloutSeverity = (typeof CALLOUT_SEVERITIES)[number];

export type CalloutOrigin = "composed" | "llm" | "fallback";

/**
 * One callout. `stepId` is null when the callout is guide-level ("before you
 * start, make sure..."); otherwise it names the plan step it is attached to.
 * `troubleshootingQuestion` is populated only for `kind === "troubleshooting"`.
 */
export interface Callout {
  readonly stepId: string | null;
  readonly kind: CalloutKind;
  readonly severity: CalloutSeverity;
  /** One-sentence body. <= 320 characters. */
  readonly text: string;
  /**
   * For troubleshooting callouts, the question the reader is asking. Null
   * for other kinds.
   */
  readonly troubleshootingQuestion: string | null;
  /** Where the callout came from. */
  readonly origin: CalloutOrigin;
  /** The rule that produced the callout, for auditability. */
  readonly rule: string;
  /** Source labels (from the caller's `sources`) that the callout is grounded in. */
  readonly sourceRefs: readonly string[];
  /** Free-form note explaining why the rule fired. */
  readonly note: string;
}

export interface TipsWarningsStyle {
  readonly tone?: "formal" | "casual" | "technical";
  readonly audience?: "end-user" | "admin" | "developer";
  readonly brandTerms?: readonly string[];
}

export interface GenerateTipsWarningsOptions {
  readonly llm?: TipsWarningsLlmHandle | null;
  readonly deterministic?: boolean;
  readonly provider?: LlmProvider;
  readonly model?: string | null;
  readonly style?: TipsWarningsStyle;
  /** Guide goal, threaded through from the earlier layers for LLM context. */
  readonly guideGoal?: string | null;
  /** Sources; only `label` and `kind` are read, matching `TitleSummarySource`. */
  readonly sources?: readonly TitleSummarySource[];
  /**
   * Source excerpts the caller extracted during fusion. Used by the
   * deterministic composer for uniqueness/constraint warnings and for the
   * "type to filter" tip when a source explicitly mentions search.
   */
  readonly sourceExcerpts?: readonly string[];
  /**
   * When false (default), the composer emits at most one tip per step, one
   * warning per step and at most one troubleshooting entry per step. When
   * true, every matching rule fires (may produce several callouts per step).
   * The default preserves a readable guide.
   */
  readonly verbose?: boolean;
}

export interface GenerateTipsWarningsResult {
  readonly callouts: readonly Callout[];
  readonly tipsCount: number;
  readonly warningsCount: number;
  readonly troubleshootingCount: number;
  readonly origin: CalloutOrigin;
  readonly llmFailureReason: string | null;
  readonly notes: readonly string[];
  readonly model: string | null;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const MAX_CALLOUT_TEXT_LENGTH = 320;
export const MAX_TROUBLESHOOTING_QUESTION_LENGTH = 140;

const UNIQUENESS_RE = /\b(unique|cannot\s+be\s+changed|cannot\s+be\s+edited|read[- ]?only|one\s+time|permanent)\b/i;
const SEARCH_HINT_RE = /\b(type\s+to\s+search|start\s+typing|searchable|filter\s+the\s+list)\b/i;
const LONG_LIST_RE = /\b(country|currency|timezone|time\s+zone|language|region|locale|state\s+list|category)\b/i;
const MFA_RE = /\b(mfa|2fa|two[- ]?factor|verification\s+code|authenticator)\b/i;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Produce tips, warnings and troubleshooting entries for a plan.
 *
 * Throws `TipsWarningsError` for a malformed or empty plan. Never throws for
 * a bad LLM response; the deterministic set is always emitted and a reason is
 * recorded.
 */
export async function generateTipsWarnings(
  plan: readonly PlanStep[],
  options: GenerateTipsWarningsOptions = {},
): Promise<GenerateTipsWarningsResult> {
  validatePlan(plan);

  const notes: string[] = [];
  const sources = options.sources ?? [];
  const excerpts = options.sourceExcerpts ?? [];
  const verbose = options.verbose === true;

  const composed = composeCallouts(plan, {
    sources,
    excerpts,
    verbose,
    notes,
  });

  const composedCounts = countByKind(composed);

  if (options.deterministic === true) {
    return {
      callouts: composed,
      tipsCount: composedCounts.tip,
      warningsCount: composedCounts.warning,
      troubleshootingCount: composedCounts.troubleshooting,
      origin: "composed",
      llmFailureReason: null,
      notes: [
        ...notes,
        "Deterministic mode requested; LLM path skipped entirely.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  const llm = options.llm ?? null;
  if (llm === null || !llm.isConfigured()) {
    return {
      callouts: composed,
      tipsCount: composedCounts.tip,
      warningsCount: composedCounts.warning,
      troubleshootingCount: composedCounts.troubleshooting,
      origin: "composed",
      llmFailureReason: null,
      notes: [
        ...notes,
        llm === null
          ? "No LLM handle supplied; deterministic composer used for tips, warnings and troubleshooting."
          : "LLM handle reported no provider configured; deterministic composer used.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // LLM path.
  let raw: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await llm.complete({
      task: "content.tipsWarnings",
      system: buildSystemPrompt(options.style),
      user: buildUserPrompt(plan, options, composed),
      maxOutputChars: Math.min(6000, 800 + plan.length * 240),
      temperature: 0.3,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    raw = response.text;
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  const parsed = raw === null ? null : parseLlmCallouts(raw, plan);
  if (parsed === null || parsed.length === 0) {
    const reason =
      failureReason ??
      "LLM returned no usable callouts; composer output retained.";
    return {
      callouts: composed.map((c) => ({ ...c, origin: "fallback" as const })),
      tipsCount: composedCounts.tip,
      warningsCount: composedCounts.warning,
      troubleshootingCount: composedCounts.troubleshooting,
      origin: "fallback",
      llmFailureReason: reason,
      notes: [
        ...notes,
        "LLM callout response could not be parsed; deterministic callouts kept with origin=fallback.",
      ],
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Merge: the deterministic set is preserved (a warning the composer fired
  // is not removed by the LLM); LLM callouts are added when they are not
  // duplicates under the same-key comparison.
  const merged = mergeCallouts(composed, parsed);
  const counts = countByKind(merged);

  return {
    callouts: merged,
    tipsCount: counts.tip,
    warningsCount: counts.warning,
    troubleshootingCount: counts.troubleshooting,
    origin: "llm",
    llmFailureReason: null,
    notes,
    model: null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Re-hydrate a persisted result. The shape is validated field-by-field; any
 * unrecognised value falls back to a safe default rather than throwing, so a
 * partially-written row in the DB can still be loaded and shown for review.
 */
export function rehydrateTipsWarnings(value: unknown): GenerateTipsWarningsResult {
  if (value === null || typeof value !== "object") {
    throw new TipsWarningsError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const raw = Array.isArray(r["callouts"]) ? (r["callouts"] as unknown[]) : [];
  const callouts: Callout[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = readString(o["text"]);
    if (text === null || text.length === 0) continue;
    callouts.push({
      stepId: readString(o["stepId"]),
      kind: readCalloutKind(o["kind"]),
      severity: readSeverity(o["severity"]),
      text,
      troubleshootingQuestion: readString(o["troubleshootingQuestion"]),
      origin: readOrigin(o["origin"]),
      rule: readString(o["rule"]) ?? "unknown",
      sourceRefs: Array.isArray(o["sourceRefs"])
        ? (o["sourceRefs"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      note: readString(o["note"]) ?? "",
    });
  }
  const counts = countByKind(callouts);
  return {
    callouts,
    tipsCount: numberOr(r["tipsCount"], counts.tip),
    warningsCount: numberOr(r["warningsCount"], counts.warning),
    troubleshootingCount: numberOr(r["troubleshootingCount"], counts.troubleshooting),
    origin: readOrigin(r["origin"]),
    llmFailureReason: readString(r["llmFailureReason"]),
    notes: Array.isArray(r["notes"])
      ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    model: readString(r["model"]),
    generatedAt: readString(r["generatedAt"]) ?? "",
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic composer                                                      */
/* -------------------------------------------------------------------------- */

interface ComposeInputs {
  readonly sources: readonly TitleSummarySource[];
  readonly excerpts: readonly string[];
  readonly verbose: boolean;
  readonly notes: string[];
}

function composeCallouts(
  plan: readonly PlanStep[],
  inputs: ComposeInputs,
): readonly Callout[] {
  const out: Callout[] = [];

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    if (step === undefined) continue;
    const prior = i > 0 ? plan[i - 1] ?? null : null;
    const next = i + 1 < plan.length ? plan[i + 1] ?? null : null;

    const warnings = warningsForStep(step, prior, next, inputs);
    const tips = tipsForStep(step, prior, next, inputs);
    const trouble = troubleshootingForStep(step, inputs);

    // When not verbose, keep at most one of each kind per step so the guide
    // stays readable. The most severe warning wins, and the highest-priority
    // troubleshooting entry (matched first) wins.
    const capped = inputs.verbose
      ? [...warnings, ...tips, ...trouble]
      : [
          ...(warnings[0] !== undefined ? [warnings[0]] : []),
          ...(tips[0] !== undefined ? [tips[0]] : []),
          ...(trouble[0] !== undefined ? [trouble[0]] : []),
        ];
    for (const c of capped) out.push(c);
  }

  if (out.length === 0) {
    inputs.notes.push(
      "No tips, warnings or troubleshooting entries fired for this plan; the guide has no callouts.",
    );
  }
  return out;
}

interface CalloutArgs {
  readonly stepId: string;
  readonly kind: CalloutKind;
  readonly severity: CalloutSeverity;
  readonly text: string;
  readonly rule: string;
  readonly note: string;
  readonly sourceRefs?: readonly string[];
  readonly troubleshootingQuestion?: string;
}

function makeCallout(args: CalloutArgs): Callout {
  return {
    stepId: args.stepId,
    kind: args.kind,
    severity: args.severity,
    text: trimAtWord(collapseWhitespace(args.text), MAX_CALLOUT_TEXT_LENGTH),
    troubleshootingQuestion:
      args.troubleshootingQuestion !== undefined
        ? trimAtWord(
            collapseWhitespace(args.troubleshootingQuestion),
            MAX_TROUBLESHOOTING_QUESTION_LENGTH,
          )
        : null,
    origin: "composed",
    rule: args.rule,
    sourceRefs: args.sourceRefs ?? [],
    note: args.note,
  };
}

/* -------------------------------------------------------------------------- */
/* Warnings                                                                    */
/* -------------------------------------------------------------------------- */

function warningsForStep(
  step: PlanStep,
  prior: PlanStep | null,
  next: PlanStep | null,
  inputs: ComposeInputs,
): readonly Callout[] {
  const out: Callout[] = [];

  if (step.kind === "destructive") {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "warning",
        severity: "danger",
        text: `This action removes data and cannot be undone from this screen. Confirm the selection before continuing.`,
        rule: "kind.destructive",
        note: "Step kind is destructive; the reader must be told the action removes data.",
      }),
    );
  }

  if (step.kind === "financial") {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "warning",
        severity: "danger",
        text: `This step involves a payment or subscription change. Double-check the amount and the account before continuing.`,
        rule: "kind.financial",
        note: "Step kind is financial; the reader should confirm before committing.",
      }),
    );
  }

  if (step.kind === "outbound") {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "warning",
        severity: "caution",
        text: `This sends a message outside the application. Review the recipient and the content before confirming.`,
        rule: "kind.outbound",
        note: "Step kind is outbound; the reader should verify the recipient.",
      }),
    );
  }

  if (step.kind === "submit") {
    // Warn on a submit that has no explicit confirmation step immediately
    // before it, since the reader will not have a chance to review.
    const hasConfirmationStepBefore =
      prior !== null && /\b(confirm|review|verify)\b/i.test(priorName(prior));
    if (!hasConfirmationStepBefore && next !== null) {
      out.push(
        makeCallout({
          stepId: step.stepId,
          kind: "warning",
          severity: "caution",
          text: `This commits the changes made in the previous steps. After clicking, the application will continue to the next page.`,
          rule: "kind.submit.noConfirmation",
          note: "Submit step with no confirmation step immediately before it and at least one subsequent step.",
        }),
      );
    }
  }

  // Uniqueness / read-only constraint warning for text fields.
  if (step.action === "type" && step.target !== null) {
    const fieldLabel = (step.target.name || step.target.role).toLowerCase();
    const sourceRefs: string[] = [];
    for (const excerpt of inputs.excerpts) {
      if (!UNIQUENESS_RE.test(excerpt)) continue;
      if (!excerpt.toLowerCase().includes(fieldLabel.split(" ")[0] ?? "")) continue;
      sourceRefs.push(excerpt.slice(0, 60));
    }
    if (sourceRefs.length > 0) {
      const sourceLabels = inputs.sources.map((s) => s.label);
      out.push(
        makeCallout({
          stepId: step.stepId,
          kind: "warning",
          severity: "caution",
          text: `The value you enter in "${step.target.name || "this field"}" must be unique and cannot be changed later. Choose it carefully.`,
          rule: "constraint.uniqueness",
          note: "A source excerpt flagged this field as unique or read-only.",
          sourceRefs: sourceLabels,
        }),
      );
    }
  }

  // MFA / verification step: warn the reader to have the device ready.
  if (
    step.action === "type" &&
    step.kind === "read-only" &&
    step.target !== null &&
    /\b(code|verification|otp)\b/i.test(step.target.name)
  ) {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "warning",
        severity: "info",
        text: `Have your authenticator app or second device ready before this step; the code expires quickly.`,
        rule: "auth.mfa",
        note: "A verification-code field was detected.",
      }),
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Tips                                                                        */
/* -------------------------------------------------------------------------- */

function tipsForStep(
  step: PlanStep,
  prior: PlanStep | null,
  next: PlanStep | null,
  inputs: ComposeInputs,
): readonly Callout[] {
  const out: Callout[] = [];

  // "Tab between fields" tip: current step is a type, and the next step is
  // also a type into the same form (no commit between them).
  if (step.action === "type" && next !== null && next.action === "type") {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "tip",
        severity: "info",
        text: `Press Tab to move to the next field without using the mouse.`,
        rule: "type.followingType",
        note: "Two consecutive type steps; the reader can use the keyboard between them.",
      }),
    );
  }

  // "Type to search" tip: a select whose target name matches a long list and
  // whose source excerpt mentions search.
  if (step.action === "select" && step.target !== null) {
    const nameMatchesLongList = LONG_LIST_RE.test(step.target.name);
    const sourceMentionsSearch = inputs.excerpts.some((e) => SEARCH_HINT_RE.test(e));
    if (nameMatchesLongList && sourceMentionsSearch) {
      out.push(
        makeCallout({
          stepId: step.stepId,
          kind: "tip",
          severity: "info",
          text: `Start typing in "${step.target.name}" to filter the list; it is faster than scrolling.`,
          rule: "select.searchable",
          note: "A long-list dropdown with a source excerpt that mentions typing to search.",
          sourceRefs: inputs.sources.map((s) => s.label),
        }),
      );
    }
  }

  // "Bookmark this URL" tip for the first step of a navigate-starting plan.
  if (step.action === "navigate" && prior === null && step.navigateUrl !== null) {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "tip",
        severity: "info",
        text: `Bookmark ${step.navigateUrl} — you will return to it whenever you repeat this workflow.`,
        rule: "navigate.bookmark",
        note: "First step of the plan is a navigation; a bookmark saves the reader time on repeat runs.",
      }),
    );
  }

  // "Review the whole page" tip: a scroll step immediately before a submit.
  if (step.action === "scroll" && next !== null && next.kind === "submit") {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "tip",
        severity: "info",
        text: `Check every section of the page before saving; the review below is the last chance to correct a value.`,
        rule: "scroll.beforeSubmit",
        note: "A scroll step directly precedes a submit; the reader is being asked to review.",
      }),
    );
  }

  // "Use the filter" tip for the first click after an initial select.
  if (
    step.action === "click" &&
    step.target !== null &&
    prior !== null &&
    prior.action === "select"
  ) {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "tip",
        severity: "info",
        text: `If the list is long, use the search box above it to jump straight to the row you need.`,
        rule: "click.afterSelect",
        note: "A click directly follows a select; a filter shortens the search on long lists.",
      }),
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Troubleshooting                                                             */
/* -------------------------------------------------------------------------- */

function troubleshootingForStep(
  step: PlanStep,
  inputs: ComposeInputs,
): readonly Callout[] {
  const out: Callout[] = [];

  if (step.match === "unmatched") {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "troubleshooting",
        severity: "caution",
        text: `If you cannot find this element, the interface may have changed since this guide was captured. Look for a neighbouring control with a similar name, and treat this step as a starting point rather than an exact instruction.`,
        rule: "match.unmatched",
        note: "The plan could not match this step's target to the accessibility tree.",
        troubleshootingQuestion: `What if the element this step refers to is not on the page?`,
      }),
    );
  } else if (step.match === "ambiguous") {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "troubleshooting",
        severity: "info",
        text: `If this click does not do what you expect, check the page for another control with a similar name and try that one instead.`,
        rule: "match.ambiguous",
        note: "More than one element matched this step's target. Verify the one the guide points at.",
        troubleshootingQuestion: `Which control should I use if several have the same name?`,
      }),
    );
  }

  if (step.kind === "destructive") {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "troubleshooting",
        severity: "danger",
        text: `If you removed the wrong record, contact your administrator immediately; many systems keep a short recovery window, but it is not guaranteed.`,
        rule: "kind.destructive.undo",
        note: "A destructive action was performed; the reader may need to recover.",
        troubleshootingQuestion: `What should I do if I deleted the wrong item?`,
      }),
    );
  }

  if (step.kind === "financial") {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "troubleshooting",
        severity: "caution",
        text: `If the amount or the account is wrong, stop and contact support before continuing. Reversing a completed transaction is possible only through support.`,
        rule: "kind.financial.wrongCharge",
        note: "A financial action was performed; a wrong amount requires support.",
        troubleshootingQuestion: `What if the amount shown is not what I expected?`,
      }),
    );
  }

  // MFA lookup: if the plan contains an MFA step and this step is the one
  // before it, tell the reader how to find the code.
  if (step.target !== null && MFA_RE.test(step.target.name)) {
    out.push(
      makeCallout({
        stepId: step.stepId,
        kind: "troubleshooting",
        severity: "info",
        text: `If the code is rejected, check that your device's clock is correct and request a new code. Codes are valid for a short window and cannot be reused.`,
        rule: "auth.mfa.codeRejected",
        note: "An MFA step was detected.",
        troubleshootingQuestion: `The verification code is rejected — what do I check first?`,
      }),
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* LLM prompt construction                                                     */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(style: TipsWarningsStyle | undefined): string {
  const tone = style?.tone ?? "neutral";
  const audience = style?.audience ?? "end-user";
  const brand = style?.brandTerms ?? [];
  const brandLine =
    brand.length > 0
      ? `Preserve these brand terms verbatim: ${brand.join(", ")}.`
      : "Do not invent product, page or brand names.";

  return [
    "You write the small callouts (tips, warnings, notes and troubleshooting entries) that appear next to the steps of a screenshot tutorial.",
    "",
    "Format rules:",
    "- Output one callout per line, in this exact format:",
    "    S<ordinal> <kind> | <severity> | <text>",
    "  where <kind> is one of: tip, warning, note, troubleshooting",
    "        <severity> is one of: info, caution, danger",
    "        <text> is one sentence, <= 320 characters.",
    "- For troubleshooting entries, follow the line with a second line:",
    "    Q<ordinal>: <the reader's question, <= 140 characters>",
    "- Prefix a calling-out step with its 1-based ordinal from the plan.",
    "  Use 'S0' for a guide-level callout that does not belong to any step.",
    "",
    "Rules about content:",
    "- A tip makes a step faster or easier without changing what the reader does.",
    "- A warning tells the reader something they could lose or break by getting it wrong.",
    "- A note is neutral context the reader may want to know.",
    "- A troubleshooting entry names a symptom and gives a concrete first thing to try.",
    "- Do not invent error messages, UI labels or constraints. Ground every callout in the plan or the sources.",
    "- Do not restate the step as a callout.",
    `Assume the reader is ${audience}. Use a ${tone} tone.`,
    brandLine,
  ].join("\n");
}

function buildUserPrompt(
  plan: readonly PlanStep[],
  options: GenerateTipsWarningsOptions,
  composed: readonly Callout[],
): string {
  const lines: string[] = [];
  const goal = readString(options.guideGoal ?? null);
  lines.push(`Guide goal: ${goal ?? "(none supplied)"}`);

  const sources = options.sources ?? [];
  if (sources.length > 0) {
    lines.push("Sources:");
    for (const s of sources) lines.push(`  - [${s.kind}] ${s.label}`);
  } else {
    lines.push("Sources: (none supplied)");
  }

  const excerpts = options.sourceExcerpts ?? [];
  if (excerpts.length > 0) {
    lines.push("Source excerpts (each on its own line; may justify a note or a warning):");
    for (const ex of excerpts) lines.push(`  - ${collapseWhitespace(ex).slice(0, 300)}`);
  }

  lines.push(`Steps: ${plan.length}`);
  for (const step of plan) {
    const target =
      step.target !== null && step.target.name.length > 0
        ? `"${step.target.name}"`
        : step.target !== null
          ? `the ${step.target.role}`
          : "(unresolved target)";
    const value = step.value !== null ? ` value=${JSON.stringify(step.value)}` : "";
    lines.push(
      `  ${step.ordinal}. action=${step.action} target=${target}${value} kind=${step.kind} match=${step.match}`,
    );
  }

  if (composed.length > 0) {
    lines.push("");
    lines.push("Callouts the deterministic pass already produced (do NOT repeat these; you may add different ones):");
    for (const c of composed) {
      const stepRef = c.stepId ?? "guide";
      lines.push(`  - ${stepRef} [${c.kind}/${c.severity}] ${c.text}`);
    }
  }

  lines.push("");
  lines.push("Respond with one callout per line, formatted exactly as described in the system prompt.");
  return lines.join("\n");
}

interface ParsedCallout {
  readonly stepOrdinal: number; // 0 = guide-level
  readonly kind: CalloutKind;
  readonly severity: CalloutSeverity;
  readonly text: string;
  readonly question: string | null;
}

function parseLlmCallouts(
  raw: string,
  plan: readonly PlanStep[],
): readonly Callout[] | null {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return null;

  const lines = text.split("\n");
  const parsed: ParsedCallout[] = [];

  // Track pending question for the most recent troubleshooting entry.
  let lastTroubleshootingIndex = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const questionMatch = /^Q(\d+)\s*[:\-]\s*(.+)$/i.exec(trimmed);
    if (questionMatch !== null && lastTroubleshootingIndex >= 0) {
      const q = questionMatch[2];
      if (q !== undefined) {
        const prior = parsed[lastTroubleshootingIndex];
        if (prior !== undefined) {
          parsed[lastTroubleshootingIndex] = {
            ...prior,
            question: sanitiseLine(q),
          };
        }
      }
      continue;
    }

    const calloutMatch = /^S(\d+)\s+(tip|warning|note|troubleshooting)\s*\|\s*(info|caution|danger)\s*\|\s*(.+)$/i.exec(
      trimmed,
    );
    if (calloutMatch === null) continue;
    const ordinalRaw = calloutMatch[1];
    const kindRaw = calloutMatch[2];
    const severityRaw = calloutMatch[3];
    const bodyRaw = calloutMatch[4];
    if (
      ordinalRaw === undefined ||
      kindRaw === undefined ||
      severityRaw === undefined ||
      bodyRaw === undefined
    ) {
      continue;
    }
    const ordinal = Number(ordinalRaw);
    if (!Number.isFinite(ordinal) || ordinal < 0) continue;
    const kind = normaliseKind(kindRaw);
    const severity = normaliseSeverity(severityRaw);
    const body = sanitiseLine(bodyRaw);
    if (body.length === 0) continue;
    parsed.push({
      stepOrdinal: Math.trunc(ordinal),
      kind,
      severity,
      text: body,
      question: null,
    });
    if (kind === "troubleshooting") lastTroubleshootingIndex = parsed.length - 1;
    else lastTroubleshootingIndex = -1;
  }

  if (parsed.length === 0) return null;

  // Map ordinals to stepIds. Ordinal 0 becomes a guide-level callout
  // (stepId null); unknown ordinals are dropped with no side effects.
  const byOrdinal = new Map<number, string>();
  for (const step of plan) byOrdinal.set(step.ordinal, step.stepId);

  const out: Callout[] = [];
  for (const p of parsed) {
    const stepId = p.stepOrdinal === 0 ? null : byOrdinal.get(p.stepOrdinal) ?? null;
    if (p.stepOrdinal > 0 && stepId === null) continue;
    out.push({
      stepId,
      kind: p.kind,
      severity: p.severity,
      text: trimAtWord(p.text, MAX_CALLOUT_TEXT_LENGTH),
      troubleshootingQuestion:
        p.question !== null
          ? trimAtWord(p.question, MAX_TROUBLESHOOTING_QUESTION_LENGTH)
          : null,
      origin: "llm",
      rule: "llm",
      sourceRefs: [],
      note: "Provided by the language model.",
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function validatePlan(plan: readonly PlanStep[]): void {
  if (!Array.isArray(plan)) {
    throw new TipsWarningsError(
      "generateTipsWarnings requires a PlanStep array.",
      "invalid-input",
    );
  }
  if (plan.length === 0) {
    throw new TipsWarningsError(
      "Cannot generate tips, warnings and troubleshooting for an empty plan.",
      "empty-plan",
    );
  }
  for (const step of plan) {
    if (step === null || typeof step !== "object") {
      throw new TipsWarningsError(
        "Plan contains a non-object step.",
        "invalid-input",
      );
    }
  }
}

function mergeCallouts(
  composed: readonly Callout[],
  llm: readonly Callout[],
): readonly Callout[] {
  const out: Callout[] = [...composed];
  const seen = new Set<string>();
  for (const c of composed) seen.add(calloutKey(c));
  for (const c of llm) {
    const key = calloutKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function calloutKey(c: Callout): string {
  const ref = c.stepId ?? "guide";
  return `${ref}\u0001${c.kind}\u0001${c.text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?,;:]+$/g, "")}`;
}

function countByKind(callouts: readonly Callout[]): {
  readonly tip: number;
  readonly warning: number;
  readonly troubleshooting: number;
} {
  let tip = 0;
  let warning = 0;
  let troubleshooting = 0;
  for (const c of callouts) {
    if (c.kind === "tip") tip += 1;
    else if (c.kind === "warning") warning += 1;
    else if (c.kind === "troubleshooting") troubleshooting += 1;
  }
  return { tip, warning, troubleshooting };
}

function priorName(step: PlanStep): string {
  if (step.target !== null && step.target.name.length > 0) return step.target.name;
  return step.action;
}

function trimAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace < max * 0.6) return `${slice}…`;
  return `${slice.slice(0, lastSpace)}…`;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function sanitiseLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v;
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return fallback;
}

function readCalloutKind(v: unknown): CalloutKind {
  if (v === "tip" || v === "warning" || v === "note" || v === "troubleshooting") return v;
  return "note";
}

function readSeverity(v: unknown): CalloutSeverity {
  if (v === "info" || v === "caution" || v === "danger") return v;
  return "info";
}

function readOrigin(v: unknown): CalloutOrigin {
  if (v === "composed" || v === "llm" || v === "fallback") return v;
  return "composed";
}

function normaliseKind(raw: string): CalloutKind {
  const k = raw.toLowerCase();
  if (k === "tip" || k === "warning" || k === "note" || k === "troubleshooting") return k;
  return "note";
}

function normaliseSeverity(raw: string): CalloutSeverity {
  const s = raw.toLowerCase();
  if (s === "info" || s === "caution" || s === "danger") return s;
  return "info";
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  composeCallouts,
  warningsForStep,
  tipsForStep,
  troubleshootingForStep,
  parseLlmCallouts,
  mergeCallouts,
  calloutKey,
  countByKind,
  MAX_CALLOUT_TEXT_LENGTH,
  MAX_TROUBLESHOOTING_QUESTION_LENGTH,
  CALLOUT_KINDS,
  CALLOUT_SEVERITIES,
});
