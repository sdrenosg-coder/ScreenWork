/**
 * Zipy AI — structured content: code blocks (content-generation, structured batch 3).
 *
 * Produces syntax-highlighted code blocks with copy-button metadata from the
 * workflow's source material. A code block is only emitted when the caller
 * supplies the code text verbatim: the composer never invents commands,
 * environment variables, tokens, file paths or API endpoints. Where a
 * workflow step appears to involve code (a `type` action into a field whose
 * target name matches a code-ish pattern, or a caller-supplied code hint)
 * but no code text accompanies it, a `CodeGap` is recorded instead of a
 * fabricated snippet.
 *
 * The concrete language grammar for highlighting is decided by the export
 * layer; this module only normalises a language identifier and passes the
 * code text through verbatim. A small set of language aliases is normalised
 * to a canonical id (`bash`, `json`, `yaml`, `sql`, `http`, `javascript`,
 * `typescript`, `python`, `shell`, `text`) so the export templates do not
 * need to special-case aliases.
 *
 * Output shape (`CodeBlockSet`) is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type CodeBlockErrorCode = "invalid-input";

export class CodeBlockError extends Error {
  readonly code: CodeBlockErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: CodeBlockErrorCode,
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

/**
 * Canonical language ids understood by the export layer. Any other value
 * supplied by a caller is normalised to `"text"` so highlighting never
 * fails on an unknown grammar.
 */
export const CODE_LANGUAGES = [
  "bash",
  "shell",
  "json",
  "yaml",
  "sql",
  "http",
  "javascript",
  "typescript",
  "python",
  "go",
  "java",
  "csharp",
  "html",
  "css",
  "xml",
  "text",
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/**
 * Where a code block appears. Exactly one of `stepId` or `sectionId` is set
 * on a well-formed block; the composer enforces this.
 */
export interface CodeBlockAnchor {
  readonly stepId: string | null;
  readonly stepIndex: number | null;
  readonly sectionId: string | null;
}

export interface CodeBlock {
  readonly id: string;
  /** Short heading shown above the block; never empty. */
  readonly title: string;
  /** The code itself. Emitted verbatim, never reformatted by this module. */
  readonly code: string;
  readonly language: CodeLanguage;
  /** True when the export layer should render a copy button for this block. */
  readonly copyable: boolean;
  /**
   * Optional explainer line rendered beneath the block. Caller-supplied;
   * the composer does not generate prose here (the core-writing layers
   * already do that at the step level).
   */
  readonly explanation: string | null;
  readonly anchor: CodeBlockAnchor;
}

export interface CodeGap {
  readonly stepId: string | null;
  readonly reason:
    | "no-code-supplied"
    | "step-target-looks-like-code"
    | "empty-code-text";
  readonly detail: string;
}

export interface CodeBlockSet {
  readonly version: "code-blocks/1";
  readonly blocks: readonly CodeBlock[];
  readonly gaps: readonly CodeGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface CodeBlockInput {
  /** The code text. Required; empty strings are rejected with a gap. */
  readonly code: string;
  /** Optional hint for the language; normalised to a canonical id. */
  readonly language?: string | null;
  /** Optional short heading; falls back to an auto-generated one. */
  readonly title?: string | null;
  readonly stepId?: string | null;
  readonly sectionId?: string | null;
  readonly explanation?: string | null;
}

export interface CodeBlockInputs {
  /** Optional plan; used to derive step index and to detect code-ish steps. */
  readonly plan?: Plan | null;
  /** Caller-supplied code blocks. */
  readonly blocks?: readonly CodeBlockInput[];
  /**
   * Plan step ids that the caller has determined involve executable or
   * config-like text. Steps in this list with no matching code block
   * produce a gap so reviewers can fill them in.
   */
  readonly stepsExpectedToContainCode?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeCodeBlocks(inputs: CodeBlockInputs): CodeBlockSet {
  if (inputs === null || typeof inputs !== "object") {
    throw new CodeBlockError("composeCodeBlocks requires an inputs object.", "invalid-input");
  }

  const gaps: CodeGap[] = [];
  const blocks: CodeBlock[] = [];
  const idSeen = new Set<string>();

  // Build a plan-step index for step-index resolution.
  const stepIndex = new Map<string, number>();
  const plan = inputs.plan ?? null;
  let planSteps: readonly PlanStep[] = [];
  if (plan !== null && typeof plan === "object") {
    const raw = (plan as { steps?: unknown }).steps;
    if (Array.isArray(raw)) {
      planSteps = raw as readonly PlanStep[];
      for (let i = 0; i < raw.length; i += 1) {
        const s = raw[i];
        if (s === null || typeof s !== "object") continue;
        const id = (s as { id?: unknown }).id;
        if (typeof id === "string" && id.length > 0) stepIndex.set(id, i + 1);
      }
    }
  }

  const callerStepsWithBlocks = new Set<string>();

  for (const raw of inputs.blocks ?? []) {
    if (raw === null || typeof raw !== "object") continue;
    const stepId = typeof raw.stepId === "string" && raw.stepId.trim().length > 0
      ? raw.stepId.trim()
      : null;
    const sectionId = typeof raw.sectionId === "string" && raw.sectionId.trim().length > 0
      ? raw.sectionId.trim()
      : null;
    if (stepId === null && sectionId === null) {
      gaps.push({
        stepId: null,
        reason: "no-code-supplied",
        detail: "A code block was supplied without a stepId or sectionId anchor.",
      });
      continue;
    }
    if (stepId !== null) callerStepsWithBlocks.add(stepId);

    const code = typeof raw.code === "string" ? raw.code : "";
    if (code.trim().length === 0) {
      gaps.push({
        stepId,
        reason: "empty-code-text",
        detail: "A code block was supplied for this anchor with empty code text.",
      });
      continue;
    }

    const language = normaliseLanguage(raw.language ?? null);
    const title =
      typeof raw.title === "string" && raw.title.trim().length > 0
        ? raw.title.trim()
        : defaultTitleFor(language, blocks.length + 1);
    const id = makeId("code", stepId ?? sectionId ?? "x", blocks.length + 1, idSeen);
    const index = stepId !== null ? stepIndex.get(stepId) ?? null : null;
    const explanation =
      typeof raw.explanation === "string" && raw.explanation.trim().length > 0
        ? raw.explanation.trim()
        : null;

    blocks.push({
      id,
      title,
      code,
      language,
      // Copy buttons are only offered for languages that are safe to paste
      // into a shell/config context. A plain prose block does not need one.
      copyable: language !== "text",
      explanation,
      anchor: { stepId, stepIndex: index, sectionId },
    });
  }

  // Gaps for plan steps the caller expected to contain code but which did not.
  for (const stepId of inputs.stepsExpectedToContainCode ?? []) {
    if (typeof stepId !== "string") continue;
    const id = stepId.trim();
    if (id.length === 0) continue;
    if (callerStepsWithBlocks.has(id)) continue;
    gaps.push({
      stepId: id,
      reason: "no-code-supplied",
      detail: `Step ${stepIndex.get(id) ?? "?"} was expected to contain code but no code text was supplied.`,
    });
  }

  // Light inspection for steps that *look* like they involve code and are
  // not in the caller's expectation list. This is advisory: it never
  // produces a block, only a gap, so no code is invented.
  if (planSteps.length > 0) {
    for (let i = 0; i < planSteps.length; i += 1) {
      const step = planSteps[i]!;
      const id = typeof (step as { id?: unknown }).id === "string"
        ? ((step as { id: string }).id)
        : `step-${i + 1}`;
      if (callerStepsWithBlocks.has(id)) continue;
      if ((inputs.stepsExpectedToContainCode ?? []).includes(id)) continue;
      if (looksLikeCodeStep(step)) {
        gaps.push({
          stepId: id,
          reason: "step-target-looks-like-code",
          detail: `Step ${i + 1} names a target that looks like a code or config field ("${step.target?.name ?? ""}"); if the workflow requires a code snippet, supply it so a code block can be emitted.`,
        });
      }
    }
  }

  return {
    version: "code-blocks/1",
    blocks: sortBlocks(blocks),
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the set as GitHub-flavoured Markdown with the code text written
 * verbatim. The export layer strips the placeholder fences when emitting a
 * non-Markdown format.
 */
export function renderCodeBlocksMarkdown(set: CodeBlockSet): string {
  const parts: string[] = [];
  for (const block of set.blocks) {
    parts.push(`### ${block.title}`);
    parts.push("");
    parts.push("```" + block.language);
    parts.push(block.code.replace(/\s+$/u, ""));
    parts.push("```");
    if (block.explanation !== null) {
      parts.push("");
      parts.push(block.explanation);
    }
    parts.push("");
  }
  if (set.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Code-block gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of set.gaps) {
      parts.push(
        `- ${gap.stepId !== null ? `Step ${gap.stepId}: ` : ""}${gap.detail}`,
      );
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildCodeBlocksDirectives(): string {
  return [
    "You are producing code blocks for an already approved workflow guide.",
    "Emit a code block only when the source material contains that exact code — a URL query string from a config page, a curl command from a docs page, a SQL snippet from a runbook. Never write code from prior knowledge.",
    "Write the code verbatim; do not reformat it, change quotes, add spacing or 'tidy' the indentation.",
    "Supported language ids: bash, shell, json, yaml, sql, http, javascript, typescript, python, go, java, csharp, html, css, xml, text.",
    "Each block has a short title and, optionally, one explainer sentence that names the exact element the reader copies from.",
    "If a workflow step would require code but the source does not supply it, do not invent a snippet — flag the step as a gap so a reviewer can add it.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

const LANGUAGE_ALIASES: Readonly<Record<string, CodeLanguage>> = Object.freeze({
  bash: "bash",
  sh: "bash",
  "sh-session": "bash",
  shell: "shell",
  zsh: "shell",
  fish: "shell",
  powershell: "shell",
  ps1: "shell",
  json: "json",
  json5: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  postgres: "sql",
  postgresql: "sql",
  psql: "sql",
  http: "http",
  https: "http",
  rest: "http",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  py: "python",
  python: "python",
  python3: "python",
  go: "go",
  golang: "go",
  java: "java",
  kt: "java",
  kotlin: "java",
  cs: "csharp",
  csharp: "csharp",
  "c#": "csharp",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  xml: "xml",
  svg: "xml",
  text: "text",
  plaintext: "text",
  txt: "text",
});

function normaliseLanguage(raw: string | null): CodeLanguage {
  if (typeof raw !== "string") return "text";
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return "text";
  const mapped = LANGUAGE_ALIASES[key];
  return mapped ?? "text";
}

function defaultTitleFor(language: CodeLanguage, position: number): string {
  switch (language) {
    case "bash":
    case "shell":
      return `Command ${position}`;
    case "sql":
      return `Query ${position}`;
    case "http":
      return `Request ${position}`;
    case "json":
    case "yaml":
    case "xml":
      return `Configuration ${position}`;
    case "javascript":
    case "typescript":
    case "python":
    case "go":
    case "java":
    case "csharp":
      return `Snippet ${position}`;
    case "html":
    case "css":
      return `Markup ${position}`;
    case "text":
    default:
      return `Block ${position}`;
  }
}

/**
 * A cheap heuristic for "this step probably needs a code block". It only
 * checks the *target name* for a small set of tokens that recur in
 * developer-facing UI; it never inspects the plan's action or value, and
 * it never produces a code block by itself.
 */
const CODE_HINT_TOKENS: readonly string[] = Object.freeze([
  "api key",
  "apikey",
  "token",
  "secret",
  "endpoint",
  "webhook url",
  "connection string",
  "dsn",
  "command",
  "cli",
  "config",
  "configuration",
  "snippet",
  "query",
  "script",
]);

function looksLikeCodeStep(step: PlanStep): boolean {
  const name =
    step !== null && typeof step === "object" && step.target !== null && typeof step.target === "object"
      ? typeof step.target.name === "string"
        ? step.target.name
        : ""
      : "";
  const haystack = name.toLowerCase();
  if (haystack.length === 0) return false;
  for (const token of CODE_HINT_TOKENS) {
    if (haystack.includes(token)) return true;
  }
  return false;
}

function sortBlocks(blocks: readonly CodeBlock[]): CodeBlock[] {
  return blocks.slice().sort((a, b) => {
    const aSec = a.anchor.sectionId !== null ? 0 : 1;
    const bSec = b.anchor.sectionId !== null ? 0 : 1;
    if (aSec !== bSec) return aSec - bSec;
    if (aSec === 0) {
      const sa = a.anchor.sectionId ?? "";
      const sb = b.anchor.sectionId ?? "";
      if (sa !== sb) return sa < sb ? -1 : 1;
    } else {
      const ai = a.anchor.stepIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.anchor.stepIndex ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function makeId(prefix: string, suffix: string, n: number, seen: Set<string>): string {
  const base = `${prefix}-${slugifyId(suffix)}-${n}`;
  let id = base;
  let counter = 2;
  while (seen.has(id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  seen.add(id);
  return id;
}

function slugifyId(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "x";
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  LANGUAGE_ALIASES,
  CODE_HINT_TOKENS,
  normaliseLanguage,
  defaultTitleFor,
  looksLikeCodeStep,
  sortBlocks,
  slugifyId,
});
