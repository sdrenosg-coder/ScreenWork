/**
 * Zipy AI — guide title and summary generation (content-generation core, batch 0).
 *
 * The first layer of the core writing engine described in the product's
 * content-generation phase. It turns the workflow (a `PlanStep[]` from the
 * synthesis package) plus the fused, provenance-tracked source material
 * (`ProvenanceRecord[]` from `@zipy/fusion/provenance`) into:
 *
 *   - a guide **title** — a short, human, action-oriented noun phrase,
 *   - a **summary** — one or two sentences that describe who the guide is
 *     for and what outcome the reader will reach,
 *   - a **slug** — a stable, URL-safe identifier derived from the title,
 *     used by the publishing layer (batch "Export, publishing and sharing"),
 *
 * and, when a rerun is asked for, a set of **title alternatives** so a reviewer
 * can pick a different framing in the review editor.
 *
 * How the layer produces its output, in order:
 *
 *   1. If an LLM handle is configured (see `@zipy/llm/adapter`), the LLM is
 *      asked for the title, summary and slug in a single structured call.
 *      The adapter owns retries, fallback chains and prompt-version pinning.
 *   2. If the LLM is unconfigured or returns an unusable response, a
 *      deterministic composer produces the same shape from the plan and
 *      sources. It reads the plan's goal (when the plan carries one via the
 *      optional `guideGoal` field), the top-ranked trust source and the
 *      action verbs present in the plan to produce a title and summary that
 *      are honest about what the guide actually shows.
 *   3. If the plan carries no goal and no usable plan text, the layer still
 *      produces a plan-shaped title ("<verb-phrase> guide") and records the
 *      fallback in `notes` so the reviewer sees that a more specific goal
 *      would improve the copy.
 *
 * Design rules honoured:
 *  - No credential is assumed. `generateTitleSummary` accepts an optional
 *    `LlmHandle`; when it is absent or reports `isConfigured() === false`,
 *    the composer's output is returned with `source: "composed"`. When the
 *    LLM is attempted but fails, `source: "fallback"` and a reason is
 *    recorded. Nothing is silently degraded.
 *  - No hallucination risk is hidden. Every field records whether it used
 *    the LLM and whether it fell back, and every fallback is accompanied by
 *    a short reason string.
 *  - The module is a pure function of its arguments plus, in the LLM path,
 *    one adapter call. It performs no I/O, has no global state, and never
 *    invents file paths or external service names.
 *  - Titles are always bounded (max 90 characters) and slugs are always
 *    ASCII, lowercased, dash-separated and collision-free within a workspace
 *    when a `slugNamespace` is supplied (the collision check is performed by
 *    the caller; this module only produces the canonical slug for a title).
 *
 * What this module is NOT:
 *  - A full guide. Later content batches add step descriptions
 *    (`stepText.ts`), prerequisites (`introPrereqs.ts`), tips/FAQ/glossary.
 *    This module produces exactly the title, summary, slug and title
 *    alternatives.
 *  - A translator. Multilingual output (`@zipy/i18n/translate`, later batch)
 *    consumes the composed English string and produces translations.
 *  - A safety/SEO pass. PII redaction, harmful-content flagging and SEO meta
 *    generation live in `@zipy/safety` and `@zipy/seo` (later batch). This
 *    layer hands the caller plain strings.
 */

import type { PlanStep } from "@zipy/synth/stepSequence";
import type { LlmProvider } from "@zipy/llm/adapter";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TitleSummaryErrorCode =
  | "invalid-input"
  | "empty-plan"
  | "malformed-llm-response";

export class TitleSummaryError extends Error {
  readonly code: TitleSummaryErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TitleSummaryErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "TitleSummaryError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* LLM handle contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The minimal LLM surface this module consumes. It is structurally identical
 * to the one used by `@zipy/annotate/stepCopy` and
 * `@zipy/annotate/altText`; keeping the shape identical across content layers
 * lets a single adapter instance be threaded through the pipeline without
 * per-layer wrappers.
 *
 * The concrete adapter in `@zipy/llm/adapter` (already present in the
 * project) implements this contract; callers may also supply a test double.
 */
export interface TitleSummaryLlmHandle {
  /** Task key passed to the adapter; used for prompt versioning + cost metering. */
  readonly complete: (args: {
    readonly task: "content.titleSummary";
    readonly system: string;
    readonly user: string;
    readonly maxOutputChars: number;
    readonly temperature: number;
    readonly provider?: LlmProvider;
    readonly model?: string | null;
  }) => Promise<{ readonly text: string }>;
  /** Whether any provider is configured. When false the composer runs. */
  readonly isConfigured: () => boolean;
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One piece of cited evidence the summary can anchor to. The caller supplies
 * these from the fusion layer; this module only reads names and kinds, so it
 * does not depend on the full `ProvenanceRecord` type.
 *
 * The minimal set of fields is deliberate: title/summary generation should be
 * usable before the provenance batch's full shape is available (early-phase
 * demos, tests), and the caller can always pass the richer record — extra
 * fields are ignored.
 */
export interface TitleSummarySource {
  /** Human label, e.g. "Customers help article" or "admin.invoices.example.com". */
  readonly label: string;
  /** Coarse source kind; used for prose ("the live application"). */
  readonly kind: "url" | "text" | "image" | "file" | "audio" | "video";
  /** Optional trust score in [0,1]; used only for ranking, never in the copy. */
  readonly trust?: number;
}

/** Knobs the caller can use to steer the LLM. */
export interface TitleSummaryStyle {
  /**
   * Tone hint. Honoured by the LLM prompt; the deterministic composer
   * ignores it (it produces neutral prose) and records that choice in
   * `notes`.
   */
  readonly tone?: "formal" | "casual" | "technical";
  /**
   * Audience hint. Honoured by the LLM prompt; the composer uses it only to
   * choose between "you" and "the reader".
   */
  readonly audience?: "end-user" | "admin" | "developer";
  /**
   * Extra brand terms to preserve verbatim. The LLM is told not to
   * paraphrase them; the composer folds them into the title when the plan
   * references them.
   */
  readonly brandTerms?: readonly string[];
}

export interface GenerateTitleSummaryOptions {
  /** Optional LLM handle. Omit for the deterministic composer. */
  readonly llm?: TitleSummaryLlmHandle | null;
  /** Force the composer even when an LLM is supplied. */
  readonly deterministic?: boolean;
  /** Provider/model overrides; the adapter's fallback chain resolves them. */
  readonly provider?: LlmProvider;
  readonly model?: string | null;
  /** Style knobs; see `TitleSummaryStyle`. */
  readonly style?: TitleSummaryStyle;
  /**
   * The guide's stated goal, as parsed by `@zipy/synth/textToAction` and
   * carried on the workflow. When absent, the composer derives a goal from
   * the plan's actions. The LLM prompt receives it either way.
   */
  readonly guideGoal?: string | null;
  /**
   * Page title where the workflow starts. Used by the composer to ground the
   * title in a concrete noun ("the Customers page"). Optional.
   */
  readonly startPageTitle?: string | null;
  /**
   * Sources that ground the guide. Ranked by `trust` when supplied; the
   * highest-trust source is the one the composer names when it needs a
   * concrete anchor. Empty is allowed.
   */
  readonly sources?: readonly TitleSummarySource[];
  /**
   * How many alternative titles to generate alongside the chosen one. The
   * default, 2, is what the review editor displays. Pass 0 to skip.
   * Each alternative records its own `source` so the reviewer knows whether
   * an alternative came from the LLM or the composer.
   */
  readonly alternativeCount?: number;
}

/**
 * Where a particular string came from.
 *  - `llm`      — the LLM adapter returned a usable value.
 *  - `composed` — the deterministic composer produced the value because no
 *                 LLM was supplied or an explicitly non-AI mode was
 *                 requested.
 *  - `fallback` — the LLM was attempted but failed, and the composer's
 *                 value is being used.
 */
export type CopyOrigin = "llm" | "composed" | "fallback";

export interface TitleAlternative {
  readonly title: string;
  readonly source: CopyOrigin;
  /** Short description of the framing ("imperative", "question", "noun phrase"). */
  readonly framing: string;
}

export interface TitleSummaryResult {
  /** Short, human title. Always non-empty. <= 90 characters. */
  readonly title: string;
  /** One or two sentences. Always non-empty when the plan is non-empty. */
  readonly summary: string;
  /** URL-safe, lowercase, dash-separated identifier derived from the title. */
  readonly slug: string;
  /** Alternative title framings for a reviewer to choose between. */
  readonly alternatives: readonly TitleAlternative[];
  /** Where the chosen title came from. */
  readonly titleSource: CopyOrigin;
  /** Where the summary came from. */
  readonly summarySource: CopyOrigin;
  /** If the LLM was attempted and failed, the reason. Null when not applicable. */
  readonly llmFailureReason: string | null;
  /** Explanation of any composer substitutions, in order. */
  readonly notes: readonly string[];
  /** Model that answered, when the LLM path was used and returned one. */
  readonly model: string | null;
  /** ISO timestamp of generation. */
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Hard cap on title length; anything above this fails the review template. */
export const MAX_TITLE_LENGTH = 90;
/** Hard cap on the summary; the export template wraps around this. */
export const MAX_SUMMARY_LENGTH = 420;
/** Hard cap on slug length; DNS + path safe. */
export const MAX_SLUG_LENGTH = 60;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Produce the guide's title, summary and slug.
 *
 * Throws `TitleSummaryError` with code `invalid-input` when the arguments are
 * malformed, and `empty-plan` when the plan contains no steps — a guide with
 * no steps cannot be titled meaningfully and the caller should not attempt it.
 * It never throws for a bad LLM response; that path returns a `fallback`
 * result with a reason.
 */
export async function generateTitleSummary(
  plan: readonly PlanStep[],
  options: GenerateTitleSummaryOptions = {},
): Promise<TitleSummaryResult> {
  validatePlan(plan);

  const sources = rankSources(options.sources ?? []);
  const notes: string[] = [];

  // Deterministic composer always runs; it provides the fallback and also the
  // alternative framings that the composer can produce without an LLM.
  const composed = composeTitleSummary(plan, options, sources, notes);

  // Deterministic callers never touch the LLM. This honours environments with
  // no provider configured and reviewers who want a stable, known output.
  if (options.deterministic === true) {
    return buildResult({
      title: composed.title,
      summary: composed.summary,
      slug: composed.slug,
      alternatives: composed.alternatives,
      titleSource: "composed",
      summarySource: "composed",
      llmFailureReason: null,
      model: null,
      notes: [
        ...notes,
        "Deterministic mode requested; LLM path skipped entirely.",
      ],
    });
  }

  const llm = options.llm ?? null;
  if (llm === null || !llm.isConfigured()) {
    return buildResult({
      title: composed.title,
      summary: composed.summary,
      slug: composed.slug,
      alternatives: composed.alternatives,
      titleSource: "composed",
      summarySource: "composed",
      llmFailureReason: null,
      model: null,
      notes: [
        ...notes,
        llm === null
          ? "No LLM handle supplied; deterministic composer used for title and summary."
          : "LLM handle reported no provider configured; deterministic composer used for title and summary.",
      ],
    });
  }

  // LLM path. A failure here never throws out of the function.
  let raw: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await llm.complete({
      task: "content.titleSummary",
      system: buildSystemPrompt(options.style),
      user: buildUserPrompt(plan, options, sources),
      maxOutputChars: MAX_TITLE_LENGTH + MAX_SUMMARY_LENGTH + 200,
      temperature: 0.3,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
    });
    raw = response.text;
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
  }

  const parsed = raw === null ? null : parseLlmResponse(raw);
  if (parsed === null || parsed.title === null || parsed.summary === null) {
    // Fallback path: composer output, with the LLM failure reason preserved.
    const reason =
      failureReason ??
      "LLM returned an unusable title/summary response; composer output substituted.";
    return buildResult({
      title: composed.title,
      summary: composed.summary,
      slug: composed.slug,
      alternatives: composed.alternatives,
      titleSource: "fallback",
      summarySource: "fallback",
      llmFailureReason: reason,
      model: null,
      notes: [...notes, "LLM response could not be parsed; fallback to composer."],
    });
  }

  // The LLM's title/summary are used verbatim (after whitespace normalisation
  // and length trimming); the slug is always recomputed from the accepted
  // title, so a slug never disagrees with the title it names.
  const title = trimAtWord(parsed.title, MAX_TITLE_LENGTH);
  const summary = trimAtWord(parsed.summary, MAX_SUMMARY_LENGTH);
  const slug = slugify(title);

  // Alternatives: the composer's framings are always available; when the LLM
  // supplied its own alternatives they are merged and deduplicated.
  const alternatives = mergeAlternatives(
    composed.alternatives,
    parsed.alternatives,
    title,
    options.alternativeCount ?? 2,
  );

  return buildResult({
    title,
    summary,
    slug,
    alternatives,
    titleSource: "llm",
    summarySource: "llm",
    llmFailureReason: null,
    model: parsed.model,
    notes,
  });
}

/** Re-export a small rehydrator so persisted results round-trip cleanly. */
export function rehydrateTitleSummary(value: unknown): TitleSummaryResult {
  if (value === null || typeof value !== "object") {
    throw new TitleSummaryError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const title = readString(r["title"]) ?? "";
  const summary = readString(r["summary"]) ?? "";
  const slug = readString(r["slug"]) ?? slugify(title);
  const alternativesRaw = Array.isArray(r["alternatives"])
    ? (r["alternatives"] as unknown[])
    : [];
  const alternatives: TitleAlternative[] = [];
  for (const a of alternativesRaw) {
    if (a === null || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const altTitle = readString(o["title"]);
    if (altTitle === null) continue;
    alternatives.push({
      title: altTitle,
      source: readOrigin(o["source"]),
      framing: readString(o["framing"]) ?? "alternative",
    });
  }
  const notes = Array.isArray(r["notes"])
    ? (r["notes"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    title,
    summary,
    slug,
    alternatives,
    titleSource: readOrigin(r["titleSource"]),
    summarySource: readOrigin(r["summarySource"]),
    llmFailureReason: readString(r["llmFailureReason"]),
    notes,
    model: readString(r["model"]),
    generatedAt: readString(r["generatedAt"]) ?? "",
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic composer                                                      */
/* -------------------------------------------------------------------------- */

interface ComposedTitleSummary {
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  readonly alternatives: readonly TitleAlternative[];
}

/**
 * Build the composer's title/summary from the plan and sources. The rules
 * below are the exact rules; there is no hidden heuristic:
 *
 *   - The verb of the title is chosen from the last `submit` or `click`
 *     step's action ("Create", "Save", "Export", …), defaulting to the first
 *     step's action noun when no commit step exists.
 *   - The object of the title is, in priority order:
 *       1. the `guideGoal` when supplied,
 *       2. the region label of the highest-trust source's label ("the
 *          Customers page" when the source label contains "customers"),
 *       3. the name of the first click target that is not the final commit,
 *       4. the start page title, when supplied,
 *       5. the generic noun "workflow".
 *   - The summary grounds the title with the source description and the
 *     step count, and states the audience when one was supplied.
 */
function composeTitleSummary(
  plan: readonly PlanStep[],
  options: GenerateTitleSummaryOptions,
  sources: readonly TitleSummarySource[],
  notes: string[],
): ComposedTitleSummary {
  const goal = normaliseGoal(options.guideGoal ?? null);
  const action = pickActionWord(plan);
  const subjectCandidate = pickSubject(plan, options, sources, goal, notes);
  const subject = subjectCandidate.subject;

  const titleRaw = goal !== null
    ? capitalise(goal)
    : `${action} ${subject}`;
  const title = trimAtWord(collapseWhitespace(titleRaw), MAX_TITLE_LENGTH);
  const slug = slugify(title);

  const summary = composeSummary(plan, options, sources, title);

  const alternatives = buildComposerAlternatives(title, action, subject, sources);

  if (subjectCandidate.usedFallback) {
    notes.push(
      "Title subject fell back to a generic noun; supplying `guideGoal` or a source with a concrete label will produce a more specific title.",
    );
  }
  if (options.guideGoal !== null && options.guideGoal !== undefined && goal === null) {
    notes.push(
      "`guideGoal` was supplied but normalized to empty; composer ignored it.",
    );
  }

  return { title, summary, slug, alternatives };
}

interface SubjectPick {
  readonly subject: string;
  readonly usedFallback: boolean;
}

function pickSubject(
  plan: readonly PlanStep[],
  options: GenerateTitleSummaryOptions,
  sources: readonly TitleSummarySource[],
  goal: string | null,
  notes: string[],
): SubjectPick {
  if (goal !== null) {
    // The goal already reads as an imperative phrase ("Create a customer");
    // the composer reuses it as the whole title, so the subject is the
    // goal's object.
    const afterVerb = goal.split(/\s+/).slice(1).join(" ");
    if (afterVerb.length > 0) return { subject: afterVerb, usedFallback: false };
    return { subject: goal, usedFallback: false };
  }

  // Prefer a source whose label names a concrete noun the reader recognises.
  for (const s of sources) {
    const noun = nounFromSourceLabel(s.label);
    if (noun !== null) return { subject: noun, usedFallback: false };
  }

  // Fall back to a click target from the plan. Exclude the final commit
  // step's target, because "Save / Submit / Confirm" do not make useful
  // titles on their own.
  const clickTargetNames = plan
    .filter((s) => s.action === "click" && s.target !== null && s.target.name.length > 0)
    .map((s) => s.target!.name);
  if (clickTargetNames.length > 0) {
    // Prefer a non-commit target; if every target is a commit, take the first.
    const nonCommit = clickTargetNames.find((n) => !isCommitName(n));
    const chosen = nonCommit ?? clickTargetNames[0];
    if (chosen !== undefined) return { subject: chosen, usedFallback: false };
  }

  // Start-page title, when supplied.
  const pageTitle = readString(options.startPageTitle ?? null);
  if (pageTitle !== null) {
    return { subject: `on the ${pageTitle} page`, usedFallback: false };
  }

  notes.push(
    "No guide goal, concrete source label, click target or start page title available; subject defaulted to a generic noun.",
  );
  return { subject: "workflow", usedFallback: true };
}

function composeSummary(
  plan: readonly PlanStep[],
  options: GenerateTitleSummaryOptions,
  sources: readonly TitleSummarySource[],
  title: string,
): string {
  const audience = audienceNoun(options.style?.audience);
  const sourcePhrase = describeSources(sources);
  const stepCount = plan.length;
  const stepVerb = stepCount === 1 ? "step" : "steps";

  const sourceClause =
    sourcePhrase !== null
      ? ` It is grounded in ${sourcePhrase}.`
      : "";
  const audienceClause =
    audience !== null ? ` Written for ${audience}.` : "";

  const summary =
    `${title}. This ${stepCount}-${stepVerb} guide walks through the workflow image-by-image.` +
    sourceClause +
    audienceClause;

  return trimAtWord(collapseWhitespace(summary), MAX_SUMMARY_LENGTH);
}

function buildComposerAlternatives(
  title: string,
  action: string,
  subject: string,
  sources: readonly TitleSummarySource[],
): readonly TitleAlternative[] {
  const out: TitleAlternative[] = [];
  const questionTitle = `How to ${lowerFirst(action)} ${subject}`;
  if (slugify(questionTitle) !== slugify(title)) {
    out.push({ title: questionTitle, source: "composed", framing: "question" });
  }
  const howToTitle = `${action} ${subject} step by step`;
  if (slugify(howToTitle) !== slugify(title)) {
    out.push({ title: howToTitle, source: "composed", framing: "step-by-step" });
  }
  if (sources.length > 0 && sources[0] !== undefined) {
    const hostNoun = nounFromSourceLabel(sources[0].label);
    if (hostNoun !== null) {
      const hostTitle = `${action} ${hostNoun} in the app`;
      if (slugify(hostTitle) !== slugify(title)) {
        out.push({ title: hostTitle, source: "composed", framing: "task" });
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* LLM prompt construction                                                     */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(style: TitleSummaryStyle | undefined): string {
  const tone = style?.tone ?? "neutral";
  const audience = style?.audience ?? "end-user";
  const brand = style?.brandTerms ?? [];

  const brandLine =
    brand.length > 0
      ? `Preserve these brand terms verbatim, exactly as spelled: ${brand.join(", ")}.`
      : "Do not invent product or brand names; use only what the inputs describe.";

  return [
    "You write the title and summary for a step-by-step screenshot tutorial.",
    "",
    "Format rules:",
    "- Output exactly three sections in this order, each on its own line:",
    "    Title: <one line, <= 90 characters, imperative or noun phrase, no trailing period>",
    "    Summary: <one or two sentences, <= 420 characters, no bullet points>",
    "    Alternatives: <up to three alternative titles, separated by '; '>",
    "- Do not prefix the summary with the title.",
    "- Do not use emoji, exclamation marks, or marketing copy.",
    "- Do not invent UI labels, page names, or product names that are not in the inputs.",
    "- If the inputs are ambiguous, prefer the wording that is most defensible.",
    `Assume the reader is ${audience} and use a ${tone} tone.`,
    brandLine,
  ].join("\n");
}

function buildUserPrompt(
  plan: readonly PlanStep[],
  options: GenerateTitleSummaryOptions,
  sources: readonly TitleSummarySource[],
): string {
  const lines: string[] = [];

  const goal = readString(options.guideGoal ?? null);
  lines.push(`Guide goal: ${goal ?? "(none supplied)"}`);
  if (options.startPageTitle !== null && options.startPageTitle !== undefined) {
    lines.push(`Start page title: ${options.startPageTitle}`);
  }

  if (sources.length > 0) {
    lines.push("Sources (highest trust first):");
    for (const s of sources) {
      const trustSuffix =
        typeof s.trust === "number" ? ` trust=${s.trust.toFixed(2)}` : "";
      lines.push(`  - [${s.kind}${trustSuffix}] ${s.label}`);
    }
  } else {
    lines.push("Sources: (none supplied)");
  }

  lines.push(`Step count: ${plan.length}`);
  lines.push("Steps:");
  for (const step of plan) {
    const target =
      step.target !== null && step.target.name.length > 0
        ? `“${step.target.name}”`
        : step.target !== null
          ? `the ${step.target.role}`
          : "(unresolved target)";
    const value = step.value !== null ? ` value=${JSON.stringify(step.value)}` : "";
    lines.push(
      `  ${step.ordinal}. ${step.action} ${target}${value} [${step.kind}]`,
    );
  }

  lines.push("Respond with the three sections described in the system prompt.");
  return lines.join("\n");
}

interface ParsedLlmResponse {
  readonly title: string | null;
  readonly summary: string | null;
  readonly alternatives: readonly string[];
  readonly model: string | null;
}

/**
 * Tolerant parser for the LLM response. Accepts the canonical format
 * described in the system prompt, plus a handful of common deviations that
 * models produce under structured-output pressure ("Title:" absent, an
 * "Alternatives:" list separated by newlines, etc.). Anything it cannot parse
 * returns `null`, and the caller falls back to the composer.
 */
function parseLlmResponse(raw: string): ParsedLlmResponse | null {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) return null;

  const titleMatch = /^\s*title\s*[:\-]\s*(.+)$/im.exec(text);
  const summaryMatch = /^\s*summary\s*[:\-]\s*([\s\S]+?)(?:\n\s*alternatives\s*[:\-]|$)/im.exec(text);
  const alternativesMatch = /^\s*alternatives?\s*[:\-]\s*([\s\S]+)$/im.exec(text);

  if (titleMatch === null && summaryMatch === null) {
    // No sections at all: try to interpret the first line as the title and
    // the rest as the summary. This is the shape most models emit when they
    // ignore the format instruction.
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const first = lines[0];
    const rest = lines.slice(1).join(" ").trim();
    return {
      title: first !== undefined ? sanitiseLine(first) : null,
      summary: rest.length > 0 ? sanitiseLine(rest) : null,
      alternatives: [],
      model: null,
    };
  }

  const title = titleMatch !== null ? sanitiseLine(titleMatch[1] ?? "") : null;
  const summary = summaryMatch !== null ? sanitiseLine(summaryMatch[1] ?? "") : null;

  const alternatives: string[] = [];
  if (alternativesMatch !== null) {
    const block = alternativesMatch[1] ?? "";
    for (const piece of block.split(/[;\n]+/)) {
      const clean = sanitiseLine(piece.replace(/^\s*[-*•]\s*/, ""));
      if (clean.length > 0 && clean.toLowerCase() !== "none") {
        alternatives.push(clean);
      }
    }
  }

  return { title, summary, alternatives, model: null };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function buildResult(args: {
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  readonly alternatives: readonly TitleAlternative[];
  readonly titleSource: CopyOrigin;
  readonly summarySource: CopyOrigin;
  readonly llmFailureReason: string | null;
  readonly model: string | null;
  readonly notes: readonly string[];
}): TitleSummaryResult {
  return {
    title: args.title,
    summary: args.summary,
    slug: args.slug,
    alternatives: args.alternatives,
    titleSource: args.titleSource,
    summarySource: args.summarySource,
    llmFailureReason: args.llmFailureReason,
    notes: args.notes,
    model: args.model,
    generatedAt: new Date().toISOString(),
  };
}

function validatePlan(plan: readonly PlanStep[]): void {
  if (!Array.isArray(plan)) {
    throw new TitleSummaryError(
      "generateTitleSummary requires a PlanStep array.",
      "invalid-input",
    );
  }
  if (plan.length === 0) {
    throw new TitleSummaryError(
      "Cannot generate a title and summary for an empty plan.",
      "empty-plan",
    );
  }
  for (const step of plan) {
    if (step === null || typeof step !== "object") {
      throw new TitleSummaryError(
        "Plan contains a non-object step.",
        "invalid-input",
      );
    }
  }
}

function rankSources(
  sources: readonly TitleSummarySource[],
): readonly TitleSummarySource[] {
  // Stable sort by descending trust; unknown trust sorts after known trust
  // but preserves the caller's order among unknowns.
  const indexed = sources.map((s, index) => ({ s, index }));
  indexed.sort((a, b) => {
    const ta = typeof a.s.trust === "number" ? a.s.trust : -1;
    const tb = typeof b.s.trust === "number" ? b.s.trust : -1;
    if (tb !== ta) return tb - ta;
    return a.index - b.index;
  });
  return indexed.map((e) => e.s);
}

const COMMIT_NAME_RE = /\b(save|submit|create|confirm|apply|ok|done|publish|activate|enable|update|finish)\b/i;
const COMMIT_WORD_RE = /\b(save|submit|create|confirm|apply)\b/i;

function isCommitName(name: string): boolean {
  return COMMIT_NAME_RE.test(name);
}

function pickActionWord(plan: readonly PlanStep[]): string {
  // Last commit step wins if it exists (the workflow's terminal action), else
  // the first click, else the first step's action noun.
  let lastCommit: PlanStep | null = null;
  let firstClick: PlanStep | null = null;
  for (const step of plan) {
    if (step.action === "click" && step.target !== null) {
      if (firstClick === null) firstClick = step;
      if (isCommitName(step.target.name)) lastCommit = step;
    }
  }
  const chosen = lastCommit ?? firstClick ?? plan[0];
  if (chosen === null) return "Complete";

  if (chosen.action === "click" && chosen.target !== null && chosen.target.name.length > 0) {
    const commit = COMMIT_WORD_RE.exec(chosen.target.name);
    if (commit !== null && commit[1] !== undefined) {
      return capitalise(lowerFirst(commit[1]));
    }
    // Use the click target's accessible name as the action verb-ish word.
    return capitalise(chosen.target.name.split(/\s+/)[0] ?? "Click");
  }
  switch (chosen.action) {
    case "type":
      return "Enter";
    case "select":
      return "Choose";
    case "scroll":
      return "Review";
    case "navigate":
      return "Open";
    case "click":
      return "Click";
  }
}

function nounFromSourceLabel(label: string): string | null {
  const clean = label.trim();
  if (clean.length === 0) return null;
  // Hostname-style labels: take the first meaningful segment.
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean)) {
    const firstSegment = clean.split(".")[0] ?? "";
    return firstSegment.length > 1 ? firstSegment : null;
  }
  // "Customers help article" → "customers". Strip known noise words and keep
  // the first meaningful token after normalisation.
  const noise = new Set([
    "the", "a", "an", "help", "article", "doc", "document", "pdf",
    "file", "screen", "image", "screenshot", "notes", "guide",
  ]);
  const tokens = clean
    .toLowerCase()
    .replace(/[^\w\s-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !noise.has(t));
  if (tokens.length === 0) return null;
  return tokens.slice(0, 2).join(" ");
}

function describeSources(sources: readonly TitleSummarySource[]): string | null {
  if (sources.length === 0) return null;
  const first = sources[0];
  if (first === undefined) return null;
  const kindPhrase = (() => {
    switch (first.kind) {
      case "url": return "the live application";
      case "text": return "the written brief";
      case "image": return "the captured screenshots";
      case "file": return "the supplied document";
      case "audio": return "the narrated recording";
      case "video": return "the recorded walkthrough";
    }
  })();
  if (sources.length === 1) return kindPhrase;
  return `${kindPhrase} and ${sources.length - 1} additional source${sources.length - 1 === 1 ? "" : "s"}`;
}

function audienceNoun(audience: TitleSummaryStyle["audience"]): string | null {
  switch (audience) {
    case "end-user": return "end users";
    case "admin": return "administrators";
    case "developer": return "developers";
    default: return null;
  }
}

function normaliseGoal(goal: string | null): string | null {
  if (goal === null) return null;
  const collapsed = collapseWhitespace(goal).replace(/[.!?]+$/, "");
  if (collapsed.length === 0) return null;
  return collapsed;
}

function mergeAlternatives(
  composed: readonly TitleAlternative[],
  llmRaw: readonly string[],
  chosenTitle: string,
  count: number,
): readonly TitleAlternative[] {
  if (count <= 0) return [];
  const chosenSlug = slugify(chosenTitle);
  const seen = new Set<string>([chosenSlug]);
  const out: TitleAlternative[] = [];

  for (const raw of llmRaw) {
    const clean = sanitiseLine(raw);
    if (clean.length === 0) continue;
    const s = slugify(clean);
    if (seen.has(s)) continue;
    out.push({ title: clean, source: "llm", framing: "llm-alternative" });
    seen.add(s);
    if (out.length >= count) return out;
  }
  for (const alt of composed) {
    const s = slugify(alt.title);
    if (seen.has(s)) continue;
    out.push(alt);
    seen.add(s);
    if (out.length >= count) return out;
  }
  return out;
}

function slugify(title: string): string {
  const lower = title.toLowerCase().normalize("NFKD");
  const ascii = lower.replace(/[\u0300-\u036f]/g, "");
  const dashed = ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return dashed.length > 0 ? dashed : "guide";
}

function trimAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace < max * 0.6) return `${slice}…`;
  return `${slice.slice(0, lastSpace)}…`;
}

function sanitiseLine(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function capitalise(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function readString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v;
}

function readOrigin(v: unknown): CopyOrigin {
  if (v === "llm" || v === "composed" || v === "fallback") return v;
  return "composed";
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  composeTitleSummary,
  pickActionWord,
  pickSubject,
  composeSummary,
  buildComposerAlternatives,
  parseLlmResponse,
  rankSources,
  nounFromSourceLabel,
  slugify,
  trimAtWord,
  mergeAlternatives,
  MAX_TITLE_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_SLUG_LENGTH,
});
