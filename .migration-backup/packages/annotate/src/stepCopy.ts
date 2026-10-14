/**
 * Zipy AI — step-copy generation for the annotation layer.
 *
 * Two products come out of this module, both tied to the same step context:
 *
 *  1. The step's instruction text, e.g. "Click the Add customer button in the
 *     top-right corner." Produced by the LLM (adapter) when a provider is
 *     configured, and by a deterministic template otherwise. The interface
 *     is the same either way so downstream code does not branch on which
 *     path produced it.
 *  2. A *layout box* for that copy on the screenshot, so the arrow layer has
 *     something to point from. The layout is performed locally with a simple
 *     monospace-ish estimator (average char width by font size); it is
 *     deliberately conservative — the caller (guide template) may reflow the
 *     box based on the real font metrics and pass the corrected box back in.
 *
 * What this module is NOT:
 *  - A layout engine. It does not measure a real font. The estimate is good
 *    enough for arrow geometry on preview screenshots; the PDF/HTML export
 *    layers recompute layout with the real renderer and pass a corrected box
 *    to `planStepPlacement` via `StepLabelBox`.
 *  - A prose finisher. It does not add emoji, marketing language, or tone
 *    adjustments; those live in `@zipy/content/tone` and the later content
 *    batch. This module produces the plain, factual step instruction the
 *    annotation overlay needs.
 *  - A safety filter. PII redaction and harmful-content checks are applied
 *    by `@zipy/safety` and the generation pipeline before this module is
 *    called. When adapter output arrives with a redaction placeholder, we
 *    preserve it verbatim.
 *
 * Design rules honoured:
 *  - Pure. No I/O beyond the LLM adapter's `generate()` call.
 *  - Deterministic *given the same adapter*: template fallback is fully
 *    deterministic; adapter output is cached at the call site by the caller
 *    (`@zipy/llm/cache` in the later batch). This module does not cache.
 *  - Bounded. Adapter failures produce the deterministic fallback plus a
 *    note; they never throw out of `generateStepCopy`.
 *  - Honest. The returned `StepCopy` records whether the adapter was used
 *    (`source: "adapter" | "template"`), the model name that answered, and
 *    any fallback reason. No claim is made that a provider is configured.
 */

import type { BBox } from "@zipy/ingest/ocr";
import type { PlanStep, StepKind } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type StepCopyErrorCode = "invalid-input";

export class StepCopyError extends Error {
  readonly code: StepCopyErrorCode;
  constructor(message: string, code: StepCopyErrorCode) {
    super(message);
    this.name = "StepCopyError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter contract                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal contract this module expects from an LLM adapter. The concrete
 * adapter in `@zipy/llm/adapter` (later batch) implements this; the same
 * shape is used here so step-copy generation is decoupled from any single
 * provider.
 *
 * A caller that has no adapter may pass `null` and rely on the template
 * fallback.
 */
export interface StepCopyAdapter {
  readonly name: string;
  readonly model: string | null;
  generate(input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly maxOutputTokens: number;
  }): Promise<{
    readonly text: string;
    readonly model: string;
    readonly totalTokens: number;
  }>;
}

/* -------------------------------------------------------------------------- */
/* Output types                                                                */
/* -------------------------------------------------------------------------- */

export interface StepCopyContext {
  /** The plan step this copy is generated for. */
  readonly step: PlanStep;
  /**
   * The page title or heading, if the caller can supply one. Used by the
   * template to name the page ("... on the Customers page").
   */
  readonly pageTitle?: string;
  /**
   * Additional context the caller wants the LLM to see — e.g. the guide's
   * goal from `IntentExtraction.goal`, or the audience tier.
   */
  readonly guideGoal?: string;
  /** Optional audience hint ("end user", "admin"). */
  readonly audienceHint?: string;
  /** Optional tone hint ("formal", "casual", "technical"). */
  readonly toneHint?: "formal" | "casual" | "technical";
}

export interface StepCopy {
  /** 1-based ordinal matching the plan step's `ordinal`. */
  readonly ordinal: number;
  readonly stepId: string;
  /** The one-line instruction shown next to the badge. */
  readonly text: string;
  /** The step title shown in the guide's step list. Kept short (<= 60 chars). */
  readonly title: string;
  /** Where the copy came from. Used for provenance and diagnostic reporting. */
  readonly source: "template" | "adapter";
  /** The model that produced the text, when `source === "adapter"`. */
  readonly model: string | null;
  /** The adapter that produced the text, when `source === "adapter"`. */
  readonly adapter: string | null;
  /** Reason the adapter was not used. Null when `source === "adapter"`. */
  readonly fallbackReason: string | null;
  /** Token usage when `source === "adapter"`. Null otherwise. */
  readonly totalTokens: number | null;
  /** The copy's layout box on the image, when the caller supplies a box for it. */
  readonly layoutBBox: BBox | null;
  /** ISO timestamp of generation. */
  readonly generatedAt: string;
  /** Explanation of any template substitution, in order. */
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Generate step copy for one plan step.
 *
 * When `adapter` is null or its call fails, produces the deterministic
 * template-based copy and records the reason in `fallbackReason`. This
 * function never rejects.
 */
export async function generateStepCopy(
  context: StepCopyContext,
  adapter: StepCopyAdapter | null,
): Promise<StepCopy> {
  if (context === null || typeof context !== "object") {
    throw new StepCopyError("generateStepCopy requires a context object.", "invalid-input");
  }
  if (context.step === null || typeof context.step !== "object") {
    throw new StepCopyError("StepCopyContext.step is required.", "invalid-input");
  }
  const step = context.step;
  const notes: string[] = [];

  // Template path is always computed; it becomes the result when the adapter
  // is unavailable or fails.
  const template = buildTemplateCopy(context);

  if (adapter === null) {
    return {
      ...template,
      source: "template",
      model: null,
      adapter: null,
      fallbackReason: "No LLM adapter configured for step-copy generation.",
      totalTokens: null,
      generatedAt: new Date().toISOString(),
      notes: [...template.notes, "Template fallback used; no adapter supplied."],
    };
  }

  try {
    const response = await adapter.generate({
      systemPrompt: buildSystemPrompt(context),
      userPrompt: buildUserPrompt(context),
      maxOutputTokens: 200,
    });
    const text = sanitiseText(response.text);
    if (text.length === 0) {
      notes.push("Adapter returned an empty response; template copy used.");
      return {
        ...template,
        source: "template",
        model: null,
        adapter: null,
        fallbackReason: "Adapter returned an empty response.",
        totalTokens: response.totalTokens,
        generatedAt: new Date().toISOString(),
        notes,
      };
    }
    // Prefer the adapter's instruction line; keep the template title unless
    // the adapter's answer clearly embeds one ("Title: X\nInstruction: Y").
    const parsed = parseAdapterOutput(text);
    return {
      ordinal: step.ordinal,
      stepId: step.stepId,
      text: parsed.instruction.length > 0 ? parsed.instruction : template.text,
      title: parsed.title.length > 0 ? parsed.title : template.title,
      source: "adapter",
      model: response.model.length > 0 ? response.model : adapter.model,
      adapter: adapter.name,
      fallbackReason: null,
      totalTokens: response.totalTokens,
      layoutBBox: template.layoutBBox,
      generatedAt: new Date().toISOString(),
      notes,
    };
  } catch (err) {
    notes.push(
      `Adapter "${adapter.name}" failed: ${err instanceof Error ? err.message : String(err)}. Template copy used.`,
    );
    return {
      ...template,
      source: "template",
      model: null,
      adapter: null,
      fallbackReason: err instanceof Error ? err.message : String(err),
      totalTokens: null,
      generatedAt: new Date().toISOString(),
      notes,
    };
  }
}

/**
 * Estimate a layout box for step copy given the copy text and the anchor
 * (target element) position. Deterministic; caller may override.
 *
 * The estimate assumes a 14px sans-serif font at 2x device scale (so the
 * runtime pixel size is ~28px, matching the screenshot's own pixel scale).
 * Average character width for a mixed-case sans-serif at that size is around
 * 0.55 * font-size, which we use directly.
 */
export function estimateStepCopyLayout(
  text: string,
  anchor: BBox,
  imageWidth: number,
  imageHeight: number,
  options: EstimateLayoutOptions = {},
): { readonly bbox: BBox; readonly placement: "above" | "below" | "left" | "right" } {
  const fontSizePx = clampPositive(options.fontSizePx ?? 28, 8);
  const lineHeight = Math.round(fontSizePx * 1.4);
  const averageCharWidth = fontSizePx * 0.55;
  const maxWidthFraction = clamp01(options.maxWidthFraction ?? 0.34);
  const maxWidth = Math.max(120, Math.floor(imageWidth * maxWidthFraction));
  const padding = clampNonNegative(options.padding ?? 12);
  const gap = clampNonNegative(options.gap ?? 16);

  const textLen = Math.max(1, text.length);
  const estimatedWidth = Math.min(maxWidth, Math.round(textLen * averageCharWidth) + padding * 2);
  const linesEstimate = Math.max(1, Math.ceil((textLen * averageCharWidth) / Math.max(1, estimatedWidth - padding * 2)));
  const estimatedHeight = linesEstimate * lineHeight + padding * 2;

  const targetCentreX = anchor.x + anchor.width / 2;
  const targetCentreY = anchor.y + anchor.height / 2;

  // Prefer the side with the most room.
  const marginLeft = anchor.x;
  const marginRight = imageWidth - (anchor.x + anchor.width);
  const marginTop = anchor.y;
  const marginBottom = imageHeight - (anchor.y + anchor.height);
  const preferHorizontal = marginLeft + marginRight >= marginTop + marginBottom;

  let bbox: BBox;
  let placement: "above" | "below" | "left" | "right";
  if (preferHorizontal) {
    if (marginRight >= marginLeft) {
      bbox = {
        x: anchor.x + anchor.width + gap,
        y: targetCentreY - estimatedHeight / 2,
        width: estimatedWidth,
        height: estimatedHeight,
      };
      placement = "right";
    } else {
      bbox = {
        x: anchor.x - estimatedWidth - gap,
        y: targetCentreY - estimatedHeight / 2,
        width: estimatedWidth,
        height: estimatedHeight,
      };
      placement = "left";
    }
  } else {
    if (marginBottom >= marginTop) {
      bbox = {
        x: targetCentreX - estimatedWidth / 2,
        y: anchor.y + anchor.height + gap,
        width: estimatedWidth,
        height: estimatedHeight,
      };
      placement = "below";
    } else {
      bbox = {
        x: targetCentreX - estimatedWidth / 2,
        y: anchor.y - estimatedHeight - gap,
        width: estimatedWidth,
        height: estimatedHeight,
      };
      placement = "above";
    }
  }

  // Clamp to the image bounds; the caller sees the arrow start from the
  // (possibly clamped) edge of the box.
  bbox = clampBox(bbox, imageWidth, imageHeight);

  return { bbox, placement };
}

export interface EstimateLayoutOptions {
  readonly fontSizePx?: number;
  readonly maxWidthFraction?: number;
  readonly padding?: number;
  readonly gap?: number;
}

/* -------------------------------------------------------------------------- */
/* Template fallback copy                                                      */
/* -------------------------------------------------------------------------- */

function buildTemplateCopy(context: StepCopyContext): StepCopy {
  const step = context.step;
  const notes: string[] = [];
  const phrase = describeAction(step);
  const suffix = describeLocation(step, context.pageTitle);
  const text = `${phrase}${suffix !== null ? ` ${suffix}` : ""}`.trim();
  const title = buildTitle(step);
  return {
    ordinal: step.ordinal,
    stepId: step.stepId,
    text,
    title,
    source: "template",
    model: null,
    adapter: null,
    fallbackReason: null,
    totalTokens: null,
    layoutBBox: null,
    generatedAt: new Date().toISOString(),
    notes,
  };
}

function describeAction(step: PlanStep): string {
  const name = readableName(step);
  const value = step.value ?? "";
  switch (step.action) {
    case "click":
      return `Click ${name}.`;
    case "type":
      return value.length > 0
        ? `Type "${value}" into ${name}.`
        : `Type into ${name}.`;
    case "select":
      return value.length > 0
        ? `Select "${value}" in ${name}.`
        : `Select an option in ${name}.`;
    case "scroll":
      return `Scroll to ${name}.`;
    case "navigate":
      return step.navigateUrl !== null ? `Navigate to ${step.navigateUrl}.` : `Navigate to ${name}.`;
  }
}

function describeLocation(step: PlanStep, pageTitle: string | undefined): string | null {
  const parts: string[] = [];
  if (step.target !== null) {
    const hint = roleToLocationHint(step.target.role);
    if (hint !== null) parts.push(hint);
    if (step.target.name.length > 0) {
      parts.push(`the "${step.target.name}" ${roleToNoun(step.target.role)}`);
    }
  }
  if (pageTitle !== undefined && pageTitle.trim().length > 0) {
    parts.push(`on the ${pageTitle} page`);
  }
  if (parts.length === 0) return null;
  return parts.join(", ") + ".";
}

function buildTitle(step: PlanStep): string {
  const name = readableName(step).replace(/^"|"$|\.$/g, "");
  const title = `${capitalise(step.action)} ${name}`;
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}

function readableName(step: PlanStep): string {
  if (step.ref === null && step.target === null) {
    return `the target element (unresolved)`;
  }
  if (step.target !== null && step.target.name.length > 0) {
    return `the "${step.target.name}"`;
  }
  if (step.target !== null) {
    return `the ${roleToNoun(step.target.role)}`;
  }
  return "the target element";
}

function roleToNoun(role: string): string {
  switch (role) {
    case "textbox":
    case "searchbox":
      return "field";
    case "combobox":
      return "dropdown";
    case "checkbox":
      return "checkbox";
    case "radio":
    case "menuitemradio":
      return "radio option";
    case "switch":
      return "toggle";
    case "tab":
      return "tab";
    case "link":
      return "link";
    case "button":
      return "button";
    case "menuitem":
      return "menu item";
    case "option":
      return "option";
    case "slider":
      return "slider";
    default:
      return "control";
  }
}

function roleToLocationHint(role: string): string | null {
  // The mapping is deliberately shallow: naming a specific corner requires
  // knowing the page layout, which is not available here.
  if (role === "button" || role === "link") return "in the toolbar";
  return null;
}

function capitalise(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const STEP_KIND_LABELS: Readonly<Record<StepKind, string>> = {
  "read-only": "Read-only action",
  write: "Write action",
  submit: "Submit action",
  destructive: "Destructive action",
  financial: "Financial action",
  outbound: "Outbound action",
};

export function stepKindLabel(kind: StepKind): string {
  return STEP_KIND_LABELS[kind];
}

/* -------------------------------------------------------------------------- */
/* Adapter prompt construction                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Prompt templates are versioned in `@zipy/llm/promptVersions` in a later
 * batch. These strings are the *request* the adapter receives; a caller who
 * has a prompt-version registry should substitute the registry's template at
 * the call site and pass an already-rendered prompt through this module's
 * lower-level `generateStepCopyFromPrompt` (not exposed in this batch).
 */
function buildSystemPrompt(context: StepCopyContext): string {
  const audience = context.audienceHint ?? "end user";
  const tone = context.toneHint ?? "neutral";
  return [
    `You write single-sentence user-guide instructions for a screenshot tutorial.`,
    `The instruction must describe exactly one UI action the reader will take.`,
    `Audience: ${audience}. Tone: ${tone}.`,
    `Output format: two lines.`,
    `Title: a short imperative title (<= 60 characters).`,
    `Instruction: one sentence starting with a verb, no emoji, no marketing copy.`,
    `Do not invent UI elements that are not in the provided step data.`,
    `If the step data is incomplete, use the placeholder phrase "the target element".`,
  ].join("\n");
}

function buildUserPrompt(context: StepCopyContext): string {
  const step = context.step;
  const lines: string[] = [];
  lines.push(`# Step ${step.ordinal}`);
  lines.push(`Action: ${step.action}`);
  lines.push(`Risk: ${step.kind}`);
  if (step.value !== null) lines.push(`Value: ${JSON.stringify(step.value)}`);
  if (step.navigateUrl !== null) lines.push(`Navigate to: ${step.navigateUrl}`);
  if (step.target !== null) {
    lines.push(`Target role: ${step.target.role}`);
    if (step.target.name.length > 0) lines.push(`Target name: ${step.target.name}`);
    if (step.target.states && Object.keys(step.target.states).length > 0) {
      lines.push(`Target states: ${JSON.stringify(step.target.states)}`);
    }
  } else {
    lines.push(`Target: <unmatched>`);
  }
  if (context.guideGoal !== undefined) lines.push(`Guide goal: ${context.guideGoal}`);
  if (context.pageTitle !== undefined) lines.push(`Page: ${context.pageTitle}`);
  lines.push("Respond with the two lines described in the system prompt.");
  return lines.join("\n");
}

function parseAdapterOutput(text: string): { readonly title: string; readonly instruction: string } {
  // Tolerant parser: the adapter may return "Title: ...\nInstruction: ...",
  // "Title ...\n\nInstruction ...", or just the instruction.
  const titleMatch = /^\s*title\s*[:\-]\s*(.+)$/im.exec(text);
  const instructionMatch = /^\s*instruction\s*[:\-]\s*(.+)$/im.exec(text);
  if (titleMatch !== null && instructionMatch !== null) {
    return {
      title: sanitiseText(titleMatch[1] ?? ""),
      instruction: sanitiseText(instructionMatch[1] ?? ""),
    };
  }
  const line = sanitiseText(text.split(/\r?\n/)[0] ?? "");
  return { title: "", instruction: line };
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function sanitiseText(s: string): string {
  if (typeof s !== "string") return "";
  // Strip control characters and collapse whitespace; keep punctuation.
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();
}

function clampBox(b: BBox, w: number, h: number): BBox {
  const x = Math.max(0, Math.min(Math.max(0, w - 1), Math.round(b.x)));
  const y = Math.max(0, Math.min(Math.max(0, h - 1), Math.round(b.y)));
  const width = Math.max(1, Math.min(w - x, Math.round(b.width)));
  const height = Math.max(1, Math.min(h - y, Math.round(b.height)));
  return { x, y, width, height };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampNonNegative(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

function clampPositive(v: number, fallback: number): number {
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return v;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateStepCopy(value: unknown): StepCopy {
  if (value === null || typeof value !== "object") {
    throw new StepCopyError("Rehydrate failed: payload is not an object.");
  }
  const r = value as Record<string, unknown>;
  const ordinal = numberOr(r["ordinal"], 1);
  const stepId = typeof r["stepId"] === "string" ? (r["stepId"] as string) : `step_${ordinal}`;
  const text = typeof r["text"] === "string" ? (r["text"] as string) : "";
  const title = typeof r["title"] === "string" ? (r["title"] as string) : "";
  const sourceRaw = r["source"];
  const source: StepCopy["source"] = sourceRaw === "adapter" ? "adapter" : "template";
  const model = typeof r["model"] === "string" ? (r["model"] as string) : null;
  const adapter = typeof r["adapter"] === "string" ? (r["adapter"] as string) : null;
  const fallbackReason =
    typeof r["fallbackReason"] === "string" ? (r["fallbackReason"] as string) : null;
  const totalTokens =
    typeof r["totalTokens"] === "number" && Number.isFinite(r["totalTokens"] as number)
      ? Math.max(0, Math.floor(r["totalTokens"] as number))
      : null;
  const layoutBBoxRaw = r["layoutBBox"];
  let layoutBBox: BBox | null = null;
  if (layoutBBoxRaw !== null && typeof layoutBBoxRaw === "object") {
    const o = layoutBBoxRaw as Record<string, unknown>;
    const x = numberOr(o["x"], NaN);
    const y = numberOr(o["y"], NaN);
    const width = numberOr(o["width"], NaN);
    const height = numberOr(o["height"], NaN);
    if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
      layoutBBox = { x, y, width, height };
    }
  }
  const generatedAt =
    typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "";
  const notes = Array.isArray(r["notes"])
    ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    ordinal,
    stepId,
    text,
    title,
    source,
    model,
    adapter,
    fallbackReason,
    totalTokens,
    layoutBBox,
    generatedAt,
    notes,
  };
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  buildTemplateCopy,
  describeAction,
  describeLocation,
  buildTitle,
  readableName,
  roleToNoun,
  estimateStepCopyLayout,
  parseAdapterOutput,
  sanitiseText,
  clampBox,
});
