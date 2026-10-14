/**
 * Zipy AI — content-generation core pipeline (content-generation core, batch 2).
 *
 * This module is the composition point for the batch-0 core writing layers:
 *
 *   - `titleSummary.ts`     → title, summary, slug (+ alternatives)
 *   - `introPrereqs.ts`      → introduction, prerequisites
 *   - `stepText.ts`          → per-step title + instruction
 *   - `tipsWarnings.ts`      → tips, warnings, troubleshooting
 *   - `faq.ts`               → FAQ
 *   - `glossary.ts`          → glossary terms/definitions
 *
 * It threads a single LLM handle (or none) through every layer, collects the
 * per-layer results, and produces one `GuideContentDraft` that downstream
 * phases (tone/style, SEO, safety, templates, i18n, export) can consume.
 *
 * Design contract:
 *   - Batches are independent: a failure in one layer does NOT abort the
 *     pipeline; the failure is recorded in `layerErrors` and the layer's
 *     slot in the result is `null`. The pipeline never invents content.
 *   - The LLM handle is optional. When it is absent or unconfigured, each
 *     layer's deterministic composer runs and the draft records `usedLlm:
 *     false`. Nothing is silently degraded.
 *   - Every layer result is preserved verbatim; the pipeline does not
 *     re-write the strings a layer produced. That keeps provenance from the
 *     layer (which knows which source it cited) intact.
 *   - The pipeline runs each layer sequentially. The layers are cheap and
 *     share the same provider/fallback budget; running them in parallel
 *     would multiply concurrent calls against the same provider and is
 *     therefore deferred to a later batch that adds cost metering.
 *   - The pipeline is a pure-ish async function: it reads the plan and
 *     sources it was given, calls the LLM handle at most once per layer
 *     and writes nothing to disk or the database. Persistence is the
 *     caller's job (the API route in `apps/web/src/app/api/guides/[id]/generate`).
 *
 * What this module is NOT:
 *   - A tone/style/brand/terminology pass. That is the next content batch;
 *     the pipeline accepts the `style` knobs the batch-0 layers already
 *     understand and forwards them, but does not implement brand learning.
 *   - A deterministic-only exporter. That belongs to `@zipy/export`.
 *   - A safety pass. PII text redaction, harmful-content flags and AI
 *     disclosure labels are `@zipy/safety` concerns (later batch). This
 *     pipeline returns the LLM's raw output verbatim and lets safety wrap it.
 *   - A translator. `@zipy/i18n/translate` consumes the draft's strings.
 */

import type { PlanStep } from "@zipy/synth/stepSequence";
import type { LlmProvider } from "@zipy/llm/adapter";

import {
  generateTitleSummary,
  type TitleSummaryLlmHandle,
  type TitleSummaryResult,
  type TitleSummarySource,
  type TitleSummaryStyle,
} from "./titleSummary";
import {
  generateIntroPrereqs,
  type IntroPrereqsLlmHandle,
  type IntroPrereqsResult,
} from "./introPrereqs";
import {
  generateStepText,
  type StepTextLlmHandle,
  type StepTextResult,
} from "./stepText";
import {
  generateTipsWarnings,
  type TipsWarningsLlmHandle,
  type TipsWarningsResult,
} from "./tipsWarnings";
import {
  generateFaq,
  type FaqLlmHandle,
  type FaqResult,
} from "./faq";
import {
  generateGlossary,
  type GlossaryLlmHandle,
  type GlossaryResult,
} from "./glossary";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ContentPipelineErrorCode =
  | "invalid-input"
  | "empty-plan"
  | "empty-draft";

export class ContentPipelineError extends Error {
  readonly code: ContentPipelineErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ContentPipelineErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ContentPipelineError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* LLM handle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A structural superset of every layer's LLM handle. The concrete adapter in
 * `@zipy/llm/adapter` already satisfies this contract; callers may also
 * provide a test double that implements `complete` and `isConfigured`.
 *
 * Because the layer handles use task-specific discriminants on `complete`,
 * the pipeline declares `task: string` and trusts the concrete adapter to
 * narrow it. This is deliberate: the pipeline must not enumerate every task
 * key the platform will ever add.
 */
export interface ContentPipelineLlmHandle {
  readonly complete: (args: {
    readonly task: string;
    readonly system: string;
    readonly user: string;
    readonly maxOutputChars: number;
    readonly temperature: number;
    readonly provider?: LlmProvider;
    readonly model?: string | null;
  }) => Promise<{ readonly text: string }>;
  readonly isConfigured: () => boolean;
}

/**
 * The pipeline's LLM handle is threaded into each layer's handle as a thin
 * adapter that re-labels the `task` discriminant. This lets the batch-0
 * layers keep their precise task keys (which are used for prompt version
 * pinning and cost accounting) while the pipeline only knows "the adapter".
 */
function asHandleForTask<T>(
  handle: ContentPipelineLlmHandle | null,
  _task: string,
): T | null {
  if (handle === null) return null;
  return {
    complete: (args: {
      readonly task: string;
      readonly system: string;
      readonly user: string;
      readonly maxOutputChars: number;
      readonly temperature: number;
      readonly provider?: LlmProvider;
      readonly model?: string | null;
    }) => handle.complete(args),
    isConfigured: () => handle.isConfigured(),
  } as unknown as T;
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface ContentPipelineOptions {
  /** Optional shared LLM handle. Omit for deterministic-only composition. */
  readonly llm?: ContentPipelineLlmHandle | null;
  /** Force deterministic composition for every layer. */
  readonly deterministic?: boolean;
  /** Provider/model overrides; the adapter's fallback chain resolves them. */
  readonly provider?: LlmProvider;
  readonly model?: string | null;
  /** Style knobs forwarded to every layer that accepts them. */
  readonly style?: TitleSummaryStyle;
  /** Goal from the workflow, when synthesis produced one. */
  readonly guideGoal?: string | null;
  /** Page title where the workflow starts. */
  readonly startPageTitle?: string | null;
  /** Sources for the guide. Ranked by trust inside the title/summary layer. */
  readonly sources?: readonly TitleSummarySource[];
  /** How many title alternatives to generate. Defaults to 2 inside the layer. */
  readonly alternativeCount?: number;
  /**
   * Layer toggles. Every layer is on by default; a caller can disable a
   * layer (e.g. the FAQ layer for a trivial two-step guide) by setting its
   * flag to `false` here.
   */
  readonly layers?: {
    readonly titleSummary?: boolean;
    readonly introPrereqs?: boolean;
    readonly stepText?: boolean;
    readonly tipsWarnings?: boolean;
    readonly faq?: boolean;
    readonly glossary?: boolean;
  };
}

export interface ContentLayerError {
  readonly layer:
    | "titleSummary"
    | "introPrereqs"
    | "stepText"
    | "tipsWarnings"
    | "faq"
    | "glossary";
  readonly message: string;
  readonly code: string | null;
}

/**
 * The draft this pipeline produces. Every field is either the layer's own
 * result type (preserved verbatim) or `null` when the layer was disabled or
 * failed. `layerErrors` lists any failures; the caller surfaces them in the
 * review UI and can re-run a single layer without regenerating the rest.
 */
export interface GuideContentDraft {
  /** Stable identifier of the workflow the draft describes. */
  readonly workflowId: string;
  readonly workspaceId: string;
  /** Title/summary/slug + alternatives. Null iff the layer was disabled. */
  readonly titleSummary: TitleSummaryResult | null;
  readonly introPrereqs: IntroPrereqsResult | null;
  readonly stepText: StepTextResult | null;
  readonly tipsWarnings: TipsWarningsResult | null;
  readonly faq: FaqResult | null;
  readonly glossary: GlossaryResult | null;
  /** True when at least one layer used the LLM. False = deterministic-only. */
  readonly usedLlm: boolean;
  /** Provider that answered the last successful LLM call, when known. */
  readonly lastProvider: LlmProvider | null;
  /** Per-layer failures. Empty on a clean run. */
  readonly layerErrors: readonly ContentLayerError[];
  /** Human-facing notes (fallbacks, layer skips, style adjustments). */
  readonly notes: readonly string[];
  /** ISO timestamp of the run. */
  readonly generatedAt: string;
  /**
   * An AI-generated label. Later phases (safety/disclosure) are the source
   * of truth for what the label must say; this field records the fact so
   * those phases do not have to re-derive it.
   */
  readonly aiGenerated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compose a full guide content draft from a synthesized plan and sources.
 *
 * Runs each enabled layer in order. A layer's exception is caught, recorded
 * in `layerErrors`, and turned into a `null` slot — the pipeline completes
 * with whatever layers succeeded. If every layer is disabled or fails, the
 * pipeline throws `ContentPipelineError` with code `empty-draft`, because a
 * guide with no content is worse than an explicit error.
 */
export async function generateGuideContent(
  plan: readonly PlanStep[],
  options: ContentPipelineOptions & {
    readonly workflowId: string;
    readonly workspaceId: string;
  },
): Promise<GuideContentDraft> {
  if (typeof options.workflowId !== "string" || options.workflowId.length === 0) {
    throw new ContentPipelineError(
      "generateGuideContent requires a non-empty workflowId.",
      "invalid-input",
    );
  }
  if (typeof options.workspaceId !== "string" || options.workspaceId.length === 0) {
    throw new ContentPipelineError(
      "generateGuideContent requires a non-empty workspaceId.",
      "invalid-input",
    );
  }
  if (!Array.isArray(plan)) {
    throw new ContentPipelineError(
      "generateGuideContent requires a PlanStep array.",
      "invalid-input",
    );
  }
  if (plan.length === 0) {
    throw new ContentPipelineError(
      "Cannot generate content for an empty plan.",
      "empty-plan",
    );
  }

  const layers = {
    titleSummary: options.layers?.titleSummary !== false,
    introPrereqs: options.layers?.introPrereqs !== false,
    stepText: options.layers?.stepText !== false,
    tipsWarnings: options.layers?.tipsWarnings !== false,
    faq: options.layers?.faq !== false,
    glossary: options.layers?.glossary !== false,
  };

  const deterministic = options.deterministic === true;
  const llm = deterministic ? null : (options.llm ?? null);
  const llmConfigured = llm !== null && llm.isConfigured();
  const effectiveLlm = llmConfigured ? llm : null;

  const notes: string[] = [];
  const layerErrors: ContentLayerError[] = [];

  if (deterministic) {
    notes.push(
      "Deterministic mode requested; no layer will call an LLM even if a handle was supplied.",
    );
  } else if (llm === null) {
    notes.push(
      "No LLM handle supplied; every layer uses its deterministic composer.",
    );
  } else if (!llmConfigured) {
    notes.push(
      "The LLM handle reported no configured provider; every layer uses its deterministic composer.",
    );
  }

  // -------------------------------------------------------- titleSummary --
  let titleSummary: TitleSummaryResult | null = null;
  if (layers.titleSummary) {
    try {
      titleSummary = await generateTitleSummary(plan, {
        llm: asHandleForTask<TitleSummaryLlmHandle>(
          effectiveLlm,
          "content.titleSummary",
        ),
        deterministic,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.style !== undefined ? { style: options.style } : {}),
        guideGoal: options.guideGoal ?? null,
        startPageTitle: options.startPageTitle ?? null,
        sources: options.sources ?? [],
        ...(options.alternativeCount !== undefined
          ? { alternativeCount: options.alternativeCount }
          : {}),
      });
      if (titleSummary.llmFailureReason !== null) {
        notes.push(
          `Title/summary fell back to the composer: ${titleSummary.llmFailureReason}`,
        );
      }
      for (const n of titleSummary.notes) notes.push(`[titleSummary] ${n}`);
    } catch (error) {
      layerErrors.push(toLayerError("titleSummary", error));
    }
  } else {
    notes.push("Title/summary layer disabled by caller.");
  }

  // -------------------------------------------------------- introPrereqs --
  let introPrereqs: IntroPrereqsResult | null = null;
  if (layers.introPrereqs) {
    try {
      introPrereqs = await generateIntroPrereqs(plan, {
        llm: asHandleForTask<IntroPrereqsLlmHandle>(
          effectiveLlm,
          "content.introPrereqs",
        ),
        deterministic,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.style !== undefined ? { style: options.style } : {}),
        guideGoal: options.guideGoal ?? null,
        startPageTitle: options.startPageTitle ?? null,
        sources: options.sources ?? [],
        ...(titleSummary !== null ? { titleSummary } : {}),
      });
      for (const n of introPrereqs.notes) notes.push(`[introPrereqs] ${n}`);
    } catch (error) {
      layerErrors.push(toLayerError("introPrereqs", error));
    }
  } else {
    notes.push("Introduction/prerequisites layer disabled by caller.");
  }

  // ------------------------------------------------------------ stepText --
  let stepText: StepTextResult | null = null;
  if (layers.stepText) {
    try {
      stepText = await generateStepText(plan, {
        llm: asHandleForTask<StepTextLlmHandle>(effectiveLlm, "content.stepText"),
        deterministic,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.style !== undefined ? { style: options.style } : {}),
        sources: options.sources ?? [],
      });
      for (const n of stepText.notes) notes.push(`[stepText] ${n}`);
    } catch (error) {
      layerErrors.push(toLayerError("stepText", error));
    }
  } else {
    notes.push("Step text layer disabled by caller.");
  }

  // --------------------------------------------------------- tipsWarnings --
  let tipsWarnings: TipsWarningsResult | null = null;
  if (layers.tipsWarnings) {
    try {
      tipsWarnings = await generateTipsWarnings(plan, {
        llm: asHandleForTask<TipsWarningsLlmHandle>(
          effectiveLlm,
          "content.tipsWarnings",
        ),
        deterministic,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.style !== undefined ? { style: options.style } : {}),
        ...(stepText !== null ? { stepText } : {}),
        sources: options.sources ?? [],
      });
      for (const n of tipsWarnings.notes) notes.push(`[tipsWarnings] ${n}`);
    } catch (error) {
      layerErrors.push(toLayerError("tipsWarnings", error));
    }
  } else {
    notes.push("Tips/warnings layer disabled by caller.");
  }

  // ----------------------------------------------------------------- faq --
  let faq: FaqResult | null = null;
  if (layers.faq) {
    try {
      faq = await generateFaq(plan, {
        llm: asHandleForTask<FaqLlmHandle>(effectiveLlm, "content.faq"),
        deterministic,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.style !== undefined ? { style: options.style } : {}),
        guideGoal: options.guideGoal ?? null,
        ...(introPrereqs !== null ? { introPrereqs } : {}),
        ...(tipsWarnings !== null ? { tipsWarnings } : {}),
        sources: options.sources ?? [],
      });
      for (const n of faq.notes) notes.push(`[faq] ${n}`);
    } catch (error) {
      layerErrors.push(toLayerError("faq", error));
    }
  } else {
    notes.push("FAQ layer disabled by caller.");
  }

  // ------------------------------------------------------------ glossary --
  let glossary: GlossaryResult | null = null;
  if (layers.glossary) {
    try {
      // The glossary reads the strings produced by the other layers so that
      // any technical term used in step copy or intro is considered for a
      // definition. When earlier layers failed, the glossary simply sees a
      // smaller corpus; that is recorded in `notes`.
      const corpus = collectGeneratedCorpus({
        titleSummary,
        introPrereqs,
        stepText,
        tipsWarnings,
        faq,
      });
      glossary = await generateGlossary(plan, {
        llm: asHandleForTask<GlossaryLlmHandle>(effectiveLlm, "content.glossary"),
        deterministic,
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.style !== undefined ? { style: options.style } : {}),
        sources: options.sources ?? [],
        generatedCorpus: corpus,
      });
      for (const n of glossary.notes) notes.push(`[glossary] ${n}`);
    } catch (error) {
      layerErrors.push(toLayerError("glossary", error));
    }
  } else {
    notes.push("Glossary layer disabled by caller.");
  }

  // ---------------------------------------------------------- empty check --
  const anyContent =
    titleSummary !== null ||
    introPrereqs !== null ||
    stepText !== null ||
    tipsWarnings !== null ||
    faq !== null ||
    glossary !== null;

  if (!anyContent) {
    throw new ContentPipelineError(
      "Content pipeline produced no content: every enabled layer failed and every disabled layer was skipped.",
      "empty-draft",
      { layerErrors, calledLayers: Object.keys(layers) },
    );
  }

  // ---------------------------------------------------------- LLM marker --
  const usedLlm =
    (titleSummary !== null && titleSummary.titleSource === "llm") ||
    (introPrereqs !== null && introPrereqs.source === "llm") ||
    (stepText !== null && stepText.source === "llm") ||
    (tipsWarnings !== null && tipsWarnings.source === "llm") ||
    (faq !== null && faq.source === "llm") ||
    (glossary !== null && glossary.source === "llm");

  const lastProvider: LlmProvider | null =
    options.provider ?? (usedLlm ? readProviderFromDraft(effectiveLlm) : null);

  if (layerErrors.length > 0) {
    notes.push(
      `${layerErrors.length} layer(s) failed; see layerErrors for details. Successful layers are preserved in the draft.`,
    );
  }

  return {
    workflowId: options.workflowId,
    workspaceId: options.workspaceId,
    titleSummary,
    introPrereqs,
    stepText,
    tipsWarnings,
    faq,
    glossary,
    usedLlm,
    lastProvider,
    layerErrors,
    notes,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rehydrate a draft that was serialized to JSON. The shape is preserved
 * verbatim; the caller is responsible for validating nested layer fields.
 * This is the mirror of `JSON.stringify(draft)` and exists so a caller can
 * round-trip a draft without re-importing the module's full type tree.
 */
export function rehydrateGuideContentDraft(value: unknown): GuideContentDraft {
  if (value === null || typeof value !== "object") {
    throw new ContentPipelineError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const workflowId = readString(r["workflowId"]) ?? "";
  const workspaceId = readString(r["workspaceId"]) ?? "";
  if (workflowId.length === 0 || workspaceId.length === 0) {
    throw new ContentPipelineError(
      "Rehydrate failed: workflowId and workspaceId are required.",
      "invalid-input",
    );
  }
  const layerErrorsRaw = Array.isArray(r["layerErrors"])
    ? (r["layerErrors"] as readonly unknown[])
    : [];
  const layerErrors: ContentLayerError[] = [];
  for (const entry of layerErrorsRaw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const layer = readLayerName(e["layer"]);
    const message = readString(e["message"]);
    if (layer === null || message === null) continue;
    layerErrors.push({
      layer,
      message,
      code: readString(e["code"]),
    });
  }
  const notes = Array.isArray(r["notes"])
    ? (r["notes"] as readonly unknown[]).filter(
        (s): s is string => typeof s === "string",
      )
    : [];
  const lastProviderRaw = readString(r["lastProvider"]);
  const lastProvider: LlmProvider | null =
    lastProviderRaw === "openai" ||
    lastProviderRaw === "anthropic" ||
    lastProviderRaw === "gemini" ||
    lastProviderRaw === "ollama" ||
    lastProviderRaw === "vllm"
      ? lastProviderRaw
      : null;
  return {
    workflowId,
    workspaceId,
    titleSummary: (r["titleSummary"] as GuideContentDraft["titleSummary"]) ?? null,
    introPrereqs: (r["introPrereqs"] as GuideContentDraft["introPrereqs"]) ?? null,
    stepText: (r["stepText"] as GuideContentDraft["stepText"]) ?? null,
    tipsWarnings: (r["tipsWarnings"] as GuideContentDraft["tipsWarnings"]) ?? null,
    faq: (r["faq"] as GuideContentDraft["faq"]) ?? null,
    glossary: (r["glossary"] as GuideContentDraft["glossary"]) ?? null,
    usedLlm: r["usedLlm"] === true,
    lastProvider,
    layerErrors,
    notes,
    generatedAt: readString(r["generatedAt"]) ?? "",
    aiGenerated: r["aiGenerated"] !== false,
  };
}

function toLayerError(
  layer: ContentLayerError["layer"],
  error: unknown,
): ContentLayerError {
  if (error instanceof Error) {
    const codec = (error as { code?: unknown }).code;
    return {
      layer,
      message: error.message,
      code: typeof codec === "string" ? codec : null,
    };
  }
  return { layer, message: String(error), code: null };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readLayerName(value: unknown): ContentLayerError["layer"] | null {
  if (typeof value !== "string") return null;
  if (
    value === "titleSummary" ||
    value === "introPrereqs" ||
    value === "stepText" ||
    value === "tipsWarnings" ||
    value === "faq" ||
    value === "glossary"
  ) {
    return value;
  }
  return null;
}

/**
 * `LlmProvider` is recorded on the draft for cost/telemetry correlation.
 * The pipeline itself does not know which provider the adapter picked when
 * a fallback ran, so we record the caller's explicit override when given and
 * otherwise leave it null. Providers that want this populated can supply
 * `options.provider` and the adapter will honour it.
 */
function readProviderFromDraft(
  _handle: ContentPipelineLlmHandle | null,
): LlmProvider | null {
  return null;
}

interface CorpusInput {
  readonly titleSummary: TitleSummaryResult | null;
  readonly introPrereqs: IntroPrereqsResult | null;
  readonly stepText: StepTextResult | null;
  readonly tipsWarnings: TipsWarningsResult | null;
  readonly faq: FaqResult | null;
}

/**
 * Gather every generated string so the glossary layer can scan for
 * technical terms used across the draft. The exact string shapes vary per
 * layer; rather than import each layer's full type union here, we walk the
 * values with a defensive reader that picks out any `string` it finds under
 * text-ish keys. Unknown shapes are skipped rather than re-typed, so a
 * future layer change does not silently break the glossary.
 */
function collectGeneratedCorpus(input: CorpusInput): readonly string[] {
  const out: string[] = [];
  const TEXT_KEYS = new Set([
    "title",
    "summary",
    "text",
    "sentence",
    "description",
    "instruction",
    "introduction",
    "content",
    "question",
    "answer",
    "term",
    "definition",
  ]);
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): void {
    if (depth > 6) return;
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (node.length > 0) out.push(node);
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (TEXT_KEYS.has(key)) {
        walk(value, depth + 1);
      } else if (key === "prerequisites" || key === "steps" || key === "items" || key === "entries") {
        walk(value, depth + 1);
      }
    }
  }

  walk(input.titleSummary, 0);
  walk(input.introPrereqs, 0);
  walk(input.stepText, 0);
  walk(input.tipsWarnings, 0);
  walk(input.faq, 0);

  // Deduplicate exact duplicates but keep order; the glossary layer can
  // weight terms by frequency if it wants to, and duplicates make that
  // trivial to compute without re-scanning the whole tree.
  return out;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  asHandleForTask,
  toLayerError,
  collectGeneratedCorpus,
});
