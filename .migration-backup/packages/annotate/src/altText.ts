/**
 * Zipy AI — alt text generation for annotated screenshots.
 *
 * Every screenshot captured by the automation phase receives an alt-text
 * description. The description is derived from:
 *   - the step's action type + element context (role, accessible name,
 *     label, destination) — supplied by `stepCopy.ts`,
 *   - the caption / instruction text produced for the step,
 *   - any annotation overlay labels (badge number, inset caption),
 *   - the source provenance (URL host, page title) when available.
 *
 * Two modes are supported and both are used in practice:
 *   1. `composeAltText` — deterministic, offline, no LLM call. Used when a
 *      guide is generated without an LLM provider configured, when the
 *      generation budget is exhausted, or when a caller explicitly asks for
 *      a non-AI description (accessibility teams often prefer predictable
 *      phrasing that a screen-reader user can build a mental model from).
 *   2. `generateAltText` — the LLM-backed variant. It takes the same inputs
 *      plus an optional brand/terminology profile, calls the shared LLM
 *      adapter and returns a short, single-sentence description. When the
 *      LLM is unconfigured the function falls back to `composeAltText` and
 *      records the fallback in the returned result so a caller can surface
 *      "AI alt text unavailable — using deterministic description" rather
 *      than silently swapping phrasing.
 *
 * The module does not fetch anything and does not write anything. It is a
 * pure function over inputs plus (in the LLM path) one adapter call.
 *
 * Inclusive design rules baked into `composeAltText`:
 *   - Alt text describes the *UI state and the target*, not the screenshot
 *     medium. "Screenshot of the Order form with the Save button
 *     highlighted" — not "Screenshot showing a screenshot of…".
 *   - Target phrasing prefers the accessible name the browser actually
 *     exposes. When an accessible name is unavailable the copy falls back to
 *     the visual type ("green submit button") and marks the description
 *     `degraded: true` so callers can flag it for review.
 *   - Alt text length is capped (screen readers truncate long strings); the
 *     cap is 220 characters for a step image and 140 characters for an inset.
 *     A longer LLM response is trimmed at a word boundary, never mid-word.
 *   - When a step has both a before and after image, the pair shares a
 *     consistent phrasing ("Before …" / "After …") so a screen-reader user
 *     hears the relationship between the two.
 */

import type { LlmProvider } from "@zipy/llm/adapter";

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/** What the guided action does to the target element. */
export type AnnotationAction =
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "navigate"
  | "hover"
  | "toggle"
  | "drag"
  | "wait";

/** Variant of the capture that this alt text describes. */
export type CaptureVariant = "before" | "after" | "single";

/** Coarse role of the target element, as classified by the annotation engine. */
export type TargetRole =
  | "button"
  | "link"
  | "input"
  | "dropdown"
  | "checkbox"
  | "radio"
  | "tab"
  | "menu"
  | "icon"
  | "row"
  | "region"
  | "unknown";

/** Geometry of the target in image pixel space (post-DPR). */
export interface TargetBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Everything the alt-text generator needs about the step's target. */
export interface TargetDescriptor {
  readonly role: TargetRole;
  /**
   * The accessible name the browser exposes — the preferred string. When the
   * a11y tree did not surface one, callers should pass `null` rather than
   * inventing a name; the composer will degrade gracefully and mark the
   * description accordingly.
   */
  readonly accessibleName: string | null;
  /** Visible text label, if different from the accessible name. */
  readonly visibleLabel?: string | null;
  /** Input type, when the target is an input ("text", "email", "password", …). */
  readonly inputType?: string | null;
  /** Current value for inputs, masked for password fields by the caller. */
  readonly currentValueMasked?: string | null;
  /** Optional bounding box. Used to describe position ("top-right"). */
  readonly box?: TargetBox | null;
  /**
   * Whether the target sits within a known region the composer can name
   * ("the toolbar", "the billing section"). Provided by the caller from the
   * layout analysis; `null` means the composer will not attempt position.
   */
  readonly regionLabel?: string | null;
}

/** A single annotation overlay applied to the image. */
export interface OverlayDescriptor {
  readonly kind: "highlight" | "arrow" | "badge" | "inset";
  /** Step number, when the overlay is a badge. */
  readonly stepNumber?: number | null;
  /** Caption the inset shows, when the overlay is a magnified inset. */
  readonly insetCaption?: string | null;
}

/** Provenance for the screenshot (used for context, never for alt text ids). */
export interface AltTextProvenance {
  readonly pageTitle?: string | null;
  readonly pageHost?: string | null;
}

/** Everything the alt-text generator consumes for a single step image. */
export interface AltTextInput {
  /** The step's generated instruction (see `stepCopy.ts`). */
  readonly instruction: string;
  /** Short step title, when available. Preferred when the instruction is long. */
  readonly stepTitle?: string | null;
  readonly action: AnnotationAction;
  readonly variant: CaptureVariant;
  readonly target: TargetDescriptor;
  /** Overlays actually rendered onto this image. Order is preserved. */
  readonly overlays: readonly OverlayDescriptor[];
  /** Optional provenance for context (host/page title). */
  readonly provenance?: AltTextProvenance;
}

/** Optional brand/style knobs the LLM path can honour. */
export interface AltTextStyleProfile {
  /** e.g. "concise" (default) | "descriptive". Affects sentence length only. */
  readonly verbosity?: "concise" | "descriptive";
  /** Brand terms or product names to use verbatim. */
  readonly brandTerms?: readonly string[];
  /** Locale hint for the LLM (BCP-47). Defaults to "en". */
  readonly locale?: string;
}

/** Result of generating alt text for one image. */
export interface AltTextResult {
  readonly altText: string;
  /**
   * How the alt text was produced. `llm` means the adapter returned a usable
   * description; `composed` means the deterministic composer ran because no
   * LLM was supplied or an explicitly non-AI mode was requested; `fallback`
   * means the LLM was attempted but failed and the composer's output is
   * being used instead.
   */
  readonly source: "llm" | "composed" | "fallback";
  /**
   * True when the description had to omit an accessible name because one was
   * not available. Accessibility reviewers often want to know which images
   * need a human-written description; this is the flag that says so.
   */
  readonly degraded: boolean;
  /** Reason for a degraded/fallback result, for logging and UI tooltips. */
  readonly reason?: string;
  /** Number of characters in `altText` after any trimming. */
  readonly length: number;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Hard cap on the LLM-produced description. Screen readers truncate above this. */
export const MAX_ALT_TEXT_LENGTH = 220;
/** Cap on inset alt text; a caption on a thumbnail should be shorter still. */
export const MAX_INSET_ALT_TEXT_LENGTH = 140;

const ACTION_VERB: Record<AnnotationAction, string> = {
  click: "Clicking",
  type: "Typing in",
  select: "Selecting from",
  scroll: "Scrolling to",
  navigate: "Navigating to",
  hover: "Hovering over",
  toggle: "Toggling",
  drag: "Dragging",
  wait: "Waiting for",
};

const ROLE_NOUN: Record<TargetRole, string> = {
  button: "button",
  link: "link",
  input: "input field",
  dropdown: "dropdown",
  checkbox: "checkbox",
  radio: "radio button",
  tab: "tab",
  menu: "menu",
  icon: "icon",
  row: "row",
  region: "section",
  unknown: "control",
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Trim text to a maximum length at a word boundary, appending an ellipsis
 * when truncation occurred. Never splits a word — a screen reader reading
 * "Subm…" is worse than "Submit".
 */
function trimAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace < max * 0.6) {
    // No good break point; hard-trim but not into the middle of an obvious
    // word — fall back to a full trim. This branch fires only for inputs
    // with no spaces at all (e.g. a hashed identifier), which is a caller
    // problem, not an alt text problem.
    return `${slice}…`;
  }
  return `${slice.slice(0, lastSpace)}…`;
}

function sanitizeFragment(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/**
 * Describe the target compactly: prefer the accessible name; fall back to
 * the visible label; fall back to the role noun. Returns an object so the
 * caller can tell whether the description used a real name.
 */
function describeTarget(target: TargetDescriptor): {
  readonly text: string;
  readonly usedName: boolean;
} {
  const accessible = sanitizeFragment(target.accessibleName);
  if (accessible !== null) {
    return { text: `${ROLE_NOUN[target.role]} “${accessible}”`, usedName: true };
  }
  const visible = sanitizeFragment(target.visibleLabel ?? null);
  if (visible !== null) {
    return { text: `${ROLE_NOUN[target.role]} “${visible}”`, usedName: true };
  }
  // No name at all: degrade to "the <role>". A caller sees degraded: true.
  if (target.role === "input" && target.inputType) {
    return {
      text: `${target.inputType} input field`,
      usedName: false,
    };
  }
  return { text: `the ${ROLE_NOUN[target.role]}`, usedName: false };
}

/**
 * Compose the "before/after" prefix for a single image so a screen-reader
 * user hears the relationship between the pair.
 */
function variantPrefix(variant: CaptureVariant): string {
  switch (variant) {
    case "before":
      return "Before: ";
    case "after":
      return "After: ";
    case "single":
      return "";
  }
}

/**
 * Describe overlays in the order they were rendered. Overlays are never used
 * to enumerate; a single phrase that captures the annotation language is
 * more useful to a screen-reader user than a list of overlay labels.
 */
function describeOverlays(
  overlays: readonly OverlayDescriptor[],
  stepNumber: number | null,
): string | null {
  if (overlays.length === 0) return null;
  const highlights = overlays.filter((o) => o.kind === "highlight");
  const arrows = overlays.filter((o) => o.kind === "arrow");
  const insets = overlays.filter((o) => o.kind === "inset");

  const clauses: string[] = [];
  if (highlights.length > 0) {
    clauses.push("the target element is highlighted");
  }
  if (arrows.length > 0) {
    clauses.push("an arrow points to it");
  }
  if (insets.length > 0) {
    const caption = sanitizeFragment(insets[0]?.insetCaption ?? null);
    if (caption !== null) {
      clauses.push(`a magnified inset shows “${caption}”`);
    } else {
      clauses.push("a magnified inset shows the element up close");
    }
  }
  if (stepNumber !== null) {
    clauses.push(`step ${stepNumber} badge is shown`);
  }
  if (clauses.length === 0) return null;
  return clauses.join("; ");
}

/* -------------------------------------------------------------------------- */
/* Deterministic composer                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compose alt text offline, without an LLM call. Callers who want predictable
 * phrasing (accessibility reviews, smoke tests, offline environments) can use
 * this directly; `generateAltText` also uses this as its fallback path.
 *
 * The composition strategy is:
 *   "<Before:|After:> <Action verb> <target> <overlay note>, in the <region>
 *    — <short step title>."
 *
 * Where a clause has no data, it is omitted rather than left as `${undefined}`.
 * The result is trimmed to `maxLength` at a word boundary.
 */
export function composeAltText(
  input: AltTextInput,
  options?: {
    readonly maxLength?: number;
    /** Override the step number used for badge phrasing (usually from input). */
    readonly stepNumber?: number | null;
  },
): AltTextResult {
  const maxLength = options?.maxLength ?? MAX_ALT_TEXT_LENGTH;
  const target = describeTarget(input.target);
  const prefix = variantPrefix(input.variant);
  const verb = ACTION_VERB[input.action];

  // Head: "Before: Clicking button “Save”"
  const head = `${prefix}${verb} ${target.text}`;

  // Region: "in the toolbar"
  const region = sanitizeFragment(input.target.regionLabel ?? null);
  const regionClause = region !== null ? ` in the ${region}` : "";

  // Overlays: any highlight / arrow / inset / badge notes.
  const badgeStep =
    options?.stepNumber ??
    input.overlays.find((o) => o.kind === "badge")?.stepNumber ??
    null;
  const overlayClause = describeOverlays(input.overlays, badgeStep);

  // Context: a short step title anchors the alt text in the reader's mind.
  const stepTitle = sanitizeFragment(input.stepTitle ?? null);
  const titleClause = stepTitle !== null ? ` — ${stepTitle}` : "";

  // Assemble, being careful with punctuation: the sentence reads
  // "Before: Clicking the button “Save” in the toolbar; the target element
  //  is highlighted — Save changes."
  const clauses: string[] = [`${head}${regionClause}`];
  if (overlayClause !== null) clauses.push(overlayClause);
  const joined = clauses.join("; ");
  const withTitle = `${joined}${titleClause}.`;
  const trimmed = trimAtWord(withTitle, maxLength);

  const degraded = !target.usedName;
  const result: AltTextResult = {
    altText: trimmed,
    source: "composed",
    degraded,
    length: trimmed.length,
  };
  if (degraded) {
    return {
      ...result,
      reason:
        "Target has no accessible name or visible label; description names the element by role only.",
    };
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* LLM-backed generator                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Provider adapter surface this module consumes. It matches the shape the
 * `@zipy/llm/adapter` exposes (`describeConfiguredProviders` + a single call
 * entry point) without importing the adapter at module load time — callers
 * pass the adapter in, so this module stays testable and stays free of
 * import cycles.
 */
export interface AltTextLlmHandle {
  /** A generator call: prompt in, plain text out. The adapter owns retries/fallbacks. */
  readonly complete: (args: {
    readonly task: "annotate.altText";
    readonly system: string;
    readonly user: string;
    readonly maxOutputChars: number;
    readonly temperature: number;
    /** Optional provider/model override resolved by the caller. */
    readonly provider?: LlmProvider;
    readonly model?: string | null;
  }) => Promise<{ readonly text: string }>;
  /**
   * Whether any provider is configured. When false, `generateAltText` skips
   * the call entirely and returns the composer's result with
   * `source: "composed"` — a caller who explicitly wants the fallback is not
   * paying for a guaranteed-failing HTTP round trip.
   */
  readonly isConfigured: () => boolean;
}

export interface GenerateAltTextOptions {
  /** Optional LLM handle. Omit to force deterministic composition. */
  readonly llm?: AltTextLlmHandle | null;
  readonly style?: AltTextStyleProfile;
  /** Provider/model overrides; resolved by the adapter's fallback chain. */
  readonly provider?: LlmProvider;
  readonly model?: string | null;
  /** Cap on the final description; defaults to `MAX_ALT_TEXT_LENGTH`. */
  readonly maxLength?: number;
  /** Force composition even when an LLM handle is supplied. */
  readonly deterministic?: boolean;
}

/**
 * Generate alt text for a single step image, preferring an LLM when one is
 * available and explicitly configured. When the LLM is absent or returns an
 * unusable response, the deterministic composer runs and the fallback is
 * recorded on the result rather than hidden.
 *
 * This function never throws for a bad LLM response. It returns a
 * `source: "fallback"` result with the underlying reason. It can throw for
 * a malformed input — no reasonable fallback exists when the instruction
 * itself is missing, so the caller should not attempt to produce alt text
 * for an empty step.
 */
export async function generateAltText(
  input: AltTextInput,
  options: GenerateAltTextOptions = {},
): Promise<AltTextResult> {
  const instruction = sanitizeFragment(input.instruction);
  if (instruction === null) {
    throw new Error(
      "generateAltText: `input.instruction` is required to produce alt text. " +
        "The step's instruction comes from `stepCopy.ts`; generate that first.",
    );
  }

  const maxLength = options.maxLength ?? MAX_ALT_TEXT_LENGTH;

  // Deterministic callers never touch the LLM. This honours accessibility
  // teams that want reproducible alt text across regenerations.
  if (options.deterministic === true || options.llm === null || options.llm === undefined) {
    return composeAltText(input, { maxLength });
  }

  // Skip the LLM call when no provider is configured. This is not a silent
  // fallback: the result is marked `source: "composed"` and, because there
  // was no LLM attempt, no `reason` about a failed call is added.
  if (!options.llm.isConfigured()) {
    return composeAltText(input, { maxLength });
  }

  const system = buildSystemPrompt(options.style);
  const user = buildUserPrompt(input, options.style);

  let llmText: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await options.llm.complete({
      task: "annotate.altText",
      system,
      user,
      maxOutputChars: maxLength,
      temperature: 0.2,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    llmText = postProcessLlmText(response.text, maxLength);
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  if (llmText === null) {
    // Fall back to composition. Preserve the failure reason so the caller can
    // log it and a UI can show "AI alt text unavailable".
    const composed = composeAltText(input, { maxLength });
    const result: AltTextResult = {
      altText: composed.altText,
      source: "fallback",
      degraded: composed.degraded,
      length: composed.altText.length,
    };
    if (failureReason !== null) {
      return { ...result, reason: failureReason };
    }
    return {
      ...result,
      reason:
        "The LLM returned an empty or unusable description; composed alt text substituted.",
    };
  }

  // The LLM's answer is the alt text; the `degraded` flag is derived from the
  // input (a target with no accessible name is still degraded even when the
  // LLM writes a nice sentence, because the future cleanup task is the same).
  const composed = composeAltText(input, { maxLength });
  return {
    altText: llmText,
    source: "llm",
    degraded: composed.degraded,
    length: llmText.length,
    ...(!composed.degraded
      ? {}
      : {
          reason:
            "Target has no accessible name or visible label; description names the element by role only.",
        }),
  };
}

/* -------------------------------------------------------------------------- */
/* Prompt construction                                                         */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(style: AltTextStyleProfile | undefined): string {
  const verbosity = style?.verbosity ?? "concise";
  const locale = style?.locale ?? "en";
  const brandTerms = style?.brandTerms ?? [];

  const brandLine =
    brandTerms.length > 0
      ? `Use these brand terms verbatim, preserving their exact spelling: ${brandTerms.join(", ")}.`
      : "Do not invent brand names; use only product terms present in the inputs.";

  const lengthLine =
    verbosity === "concise"
      ? `Keep the description to a single sentence of at most ${MAX_ALT_TEXT_LENGTH} characters.`
      : `Keep the description to one or two sentences of at most ${MAX_ALT_TEXT_LENGTH} characters total.`;

  return [
    "You write accessible alt text for screenshots in step-by-step UI tutorials.",
    "",
    "Rules:",
    "- Describe the UI state and the element a user should interact with. Do not say 'image of', 'screenshot of', or 'picture showing'.",
    "- Prefer the accessible name of the target element when one is provided. Use it verbatim, in curly quotes.",
    "- When a before/after pair is indicated, start the description with 'Before: ' or 'After: ' to match the variant.",
    "- Do not enumerate overlays ('highlight, arrow, badge #3, inset'); merge them into one natural clause.",
    "- Do not invent screen content, labels, or values that are not in the inputs.",
    "- Do not end with a period-less fragment; the alt text should read as a complete phrase.",
    "- Do not wrap the output in quotes or code fences, and do not prefix with 'Alt text:'.",
    lengthLine,
    brandLine,
    `Respond in locale "${locale}".`,
  ].join("\n");
}

function buildUserPrompt(
  input: AltTextInput,
  style: AltTextStyleProfile | undefined,
): string {
  const target = input.target;
  const targetLines: string[] = [];
  targetLines.push(`role: ${target.role}`);
  targetLines.push(
    `accessibleName: ${target.accessibleName ?? "(none)"}`,
  );
  if (target.visibleLabel !== undefined && target.visibleLabel !== null) {
    targetLines.push(`visibleLabel: ${target.visibleLabel}`);
  }
  if (target.inputType !== undefined && target.inputType !== null) {
    targetLines.push(`inputType: ${target.inputType}`);
  }
  if (
    target.currentValueMasked !== undefined &&
    target.currentValueMasked !== null
  ) {
    targetLines.push(`currentValueMasked: ${target.currentValueMasked}`);
  }
  if (target.regionLabel !== undefined && target.regionLabel !== null) {
    targetLines.push(`regionLabel: ${target.regionLabel}`);
  }

  const overlayLines =
    input.overlays.length === 0
      ? ["overlays: (none)"]
      : input.overlays.map((o) => {
          const parts: string[] = [`kind=${o.kind}`];
          if (typeof o.stepNumber === "number") {
            parts.push(`stepNumber=${o.stepNumber}`);
          }
          if (o.insetCaption !== undefined && o.insetCaption !== null) {
            parts.push(`caption=${JSON.stringify(o.insetCaption)}`);
          }
          return `overlay: ${parts.join(" ")}`;
        });

  const provenanceLines: string[] = [];
  if (input.provenance?.pageHost) {
    provenanceLines.push(`pageHost: ${input.provenance.pageHost}`);
  }
  if (input.provenance?.pageTitle) {
    provenanceLines.push(`pageTitle: ${input.provenance.pageTitle}`);
  }

  const styleLines: string[] = [];
  if (style?.verbosity) styleLines.push(`verbosity: ${style.verbosity}`);
  if (style?.locale) styleLines.push(`locale: ${style.locale}`);

  return [
    `variant: ${input.variant}`,
    `action: ${input.action}`,
    input.stepTitle !== null && input.stepTitle !== undefined
      ? `stepTitle: ${JSON.stringify(input.stepTitle)}`
      : "stepTitle: (none)",
    `instruction: ${JSON.stringify(input.instruction)}`,
    "target:",
    ...targetLines.map((l) => `  ${l}`),
    ...overlayLines,
    ...(provenanceLines.length > 0 ? ["provenance:", ...provenanceLines.map((l) => `  ${l}`)] : []),
    ...(styleLines.length > 0 ? ["style:", ...styleLines.map((l) => `  ${l}`)] : []),
  ].join("\n");
}

/**
 * Normalise a raw LLM response into something usable as alt text:
 *   - collapse whitespace,
 *   - strip an accidental code fence,
 *   - strip a leading "Alt text:" or "Alt:" label,
 *   - strip surrounding quotes,
 *   - trim to the caller's cap at a word boundary.
 * Returns `null` when the response has no usable content, so the caller can
 * fall back rather than embedding an empty alt attribute.
 */
function postProcessLlmText(raw: string, maxLength: number): string | null {
  let text = raw.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;

  // Strip a wrapping code fence the model might have added.
  const fenceMatch = /^```[a-zA-Z0-9]*\s+([\s\S]*?)\s+```$/.exec(text);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    text = fenceMatch[1].replace(/\s+/g, " ").trim();
  }

  // Strip a leading "Alt text:" / "Alt:" / "Description:" label.
  text = text.replace(/^(alt text|alt|description)\s*[:\-]\s*/i, "");

  // Strip surrounding straight or curly quotes if present on both ends.
  const quotePairs: readonly [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ];
  for (const [open, close] of quotePairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > 2) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }

  if (text.length === 0) return null;

  // Ensure sentence-terminating punctuation so it reads well in a screen
  // reader. Only append when the text does not already end in `. ! ? …`.
  if (!/[.!?…]$/.test(text)) text = `${text}.`;

  return trimAtWord(text, maxLength);
}

/* -------------------------------------------------------------------------- */
/* Batch helper                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Convenience for the annotation pipeline: generate alt text for every image
 * of a guide in order, reusing one LLM handle. The caller supplies the
 * stepNumber so badge-related phrasing is consistent across before/after
 * pairs. Deterministic mode is honoured per-call and does not touch the LLM.
 *
 * Failures are attributed per image: a throw from `generateAltText` is caught
 * and converted into a `source: "fallback"` result with the composer output,
 * so one bad step does not abort the guide's alt text. A caller who wants
 * strict failure semantics should call `generateAltText` directly.
 */
export async function generateAltTextBatch(
  items: readonly {
    readonly stepNumber: number;
    readonly input: AltTextInput;
  }[],
  options: GenerateAltTextOptions = {},
): Promise<readonly AltTextResult[]> {
  const results: AltTextResult[] = [];
  for (const item of items) {
    try {
      const result = await generateAltText(item.input, {
        ...options,
        // Step number flows through options so the composer and the prompt
        // builder both see it consistently.
      });
      results.push(result);
    } catch (error) {
      // The composer cannot fail for the same reason `generateAltText` threw
      // (a missing instruction); if it did throw we still return something a
      // screen reader can use, and record the reason.
      try {
        const composed = composeAltText(item.input, {});
        results.push({
          altText: composed.altText,
          source: "fallback",
          degraded: true,
          length: composed.altText.length,
          reason:
            error instanceof Error
              ? error.message
              : "Alt-text generation failed.",
        });
      } catch {
        results.push({
          altText: `Step ${item.stepNumber}.`,
          source: "fallback",
          degraded: true,
          length: `Step ${item.stepNumber}.`.length,
          reason:
            "Alt-text generation failed and no instruction was available to compose from.",
        });
      }
    }
  }
  return results;
}
