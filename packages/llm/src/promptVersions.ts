/**
 * Zipy AI — prompt version registry.
 *
 * Prompts are versioned artefacts: every synthesis call records which version
 * produced it, so a regression can be correlated with a prompt change and an
 * A/B comparison (added in a later phase) has a stable identifier to key on.
 *
 * Design rules:
 *  - A version is (id, taskKey, template, outputSchema, notes, createdAt).
 *  - Templates use `{{variable}}` placeholders; `renderTemplate` is the only
 *    renderer, so a variable that is not supplied fails loudly rather than
 *    emitting an empty string. Optional variables use `{{?name}}`.
 *  - The built-in registry ships the versions this phase uses (workflow
 *    synthesis, a11y summarisation, text-to-action, distill). Additional
 *    prompts arrive with the content-generation phases.
 *  - The registry never reads env or the network; it is deterministic and
 *    in-process. A later phase can override a template by registering an
 *    alternative version under the same task key and changing the active id.
 */

import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface PromptVersion {
  /** Stable identifier, e.g. "synth.workflow.v1". */
  readonly id: string;
  /** Task key the version belongs to, e.g. "synth.workflow". */
  readonly taskKey: string;
  /** One-line description surfaced in admin/reporting. */
  readonly description: string;
  /** Template body; uses `{{variable}}` and `{{?optional}}` placeholders. */
  readonly template: string;
  /** Named identifiers of the variables the template requires. */
  readonly requiredVariables: readonly string[];
  /** Optional variables the template accepts but does not require. */
  readonly optionalVariables: readonly string[];
  /** ISO date the version was added. */
  readonly createdAt: string;
  /** Free-text notes for reviewers. */
  readonly notes: string;
}

export interface PromptTemplateContext {
  readonly [name: string]: string | number | boolean | null | undefined;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class PromptRenderError extends Error {
  public readonly code = "prompt_render_error" as const;
  public readonly promptVersionId: string;
  public readonly missing: readonly string[];
  constructor(promptVersionId: string, missing: readonly string[]) {
    super(
      `Prompt "${promptVersionId}" is missing required variable(s): ${missing.join(
        ", ",
      )}. Supply them in the context; the registry refuses to emit a prompt with empty substitutions.`,
    );
    this.name = "PromptRenderError";
    this.promptVersionId = promptVersionId;
    this.missing = missing;
  }
}

export class PromptVersionNotFoundError extends Error {
  public readonly code = "prompt_version_not_found" as const;
  public readonly promptVersionId: string;
  constructor(id: string, available: readonly string[]) {
    super(
      `Prompt version "${id}" is not registered. Available versions: ${
        available.length > 0 ? available.join(", ") : "(none)"
      }.`,
    );
    this.name = "PromptVersionNotFoundError";
    this.promptVersionId = id;
  }
}

/* -------------------------------------------------------------------------- */
/* Template rendering                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Substitute `{{name}}` and `{{?name}}` placeholders.
 *  - `{{name}}` requires the context to contain `name` with a non-null,
 *    non-empty value; missing → collected in `missing`.
 *  - `{{?name}}` is optional; if absent or empty, the whole placeholder is
 *    replaced with an empty string (the template must not depend on it).
 *  - Values are coerced to strings via `String(value)`; objects/arrays are
 *    expected to have been JSON-stringified by the caller so the prompt is
 *    deterministic.
 */
function renderTemplateBody(
  template: string,
  ctx: PromptTemplateContext,
): { readonly body: string; readonly missing: readonly string[] } {
  const missing: string[] = [];
  const body = template.replace(
    /\{\{(\??)([A-Za-z0-9_.]+)\}\}/g,
    (_match, optionalMarker: string, name: string) => {
      const isOptional = optionalMarker === "?";
      const raw = ctx[name];
      if (raw === undefined || raw === null) {
        if (isOptional) return "";
        missing.push(name);
        return `{{${name}}}`;
      }
      const value = typeof raw === "string" ? raw : String(raw);
      if (value.length === 0) {
        if (isOptional) return "";
        missing.push(name);
        return `{{${name}}}`;
      }
      return value;
    },
  );
  return { body, missing };
}

/**
 * Render a registered prompt version with the supplied context. Throws
 * `PromptRenderError` when any required variable is missing so a call cannot
 * silently send an under-specified prompt to a model.
 */
export function renderTemplate(
  version: PromptVersion,
  ctx: PromptTemplateContext,
): string {
  const { body, missing } = renderTemplateBody(version.template, ctx);
  if (missing.length > 0) {
    throw new PromptRenderError(version.id, missing);
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The template strings here are the ones this phase ships. They are the
 * authoritative prompts for synthesis; workers must render them through this
 * registry, not inline their own strings, so a future version bump changes
 * behaviour in exactly one place.
 */
const BUILT_IN_VERSIONS: readonly PromptVersion[] = Object.freeze([
  {
    id: "synth.workflow.v1",
    taskKey: "synth.workflow",
    description:
      "Synthesize an ordered action plan from an accessibility snapshot and a workflow goal/entities.",
    template: [
      "You are the Zipy AI workflow synthesis engine. Given a compacted accessibility-tree snapshot",
      "of a web page and a user request, produce a strict JSON action plan.",
      "",
      "The snapshot lists interactive elements as `@eN role=<role> name=<name>` lines. Refer to",
      "elements ONLY by their `@eN` reference — never invent selectors or CSS.",
      "",
      "Return a single JSON object with this shape (no markdown, no commentary):",
      "{",
      '  "goal": string,',
      '  "subTasks": [{ "description": string, "elementRef": "@eN" | null, "kind": string }],',
      '  "actions": [{',
      '     "kind": "navigate" | "click" | "type" | "select" | "scroll" | "keypress" | "wait",',
      '     "target": "@eN" | null,',
      '     "value": string | null,',
      '     "expectedState": string | null,',
      '     "reasoning": string,',
      '     "confidence": number /* 0..1 */',
      "  }],",
      '  "conditionalEdges": [{ "fromStepId": string, "toStepId": string, "condition": string }],',
      '  "warnings": [string]',
      "}",
      "",
      "Rules:",
      "- Every `click` / `type` / `select` / `keypress` action MUST set `target` to an `@eN` reference",
      "  that appears in the snapshot. If no matching element exists, add a warning and either omit",
      "  the step or lower its confidence below 0.4.",
      "- Use `navigate` only for opening a new URL; the URL goes in `value`.",
      "- Use `type` for text entry; the text goes in `value`. Refer to the input element via `target`.",
      "- Use `select` for choosing an option in a native select or a listbox option element.",
      "- Use `wait` only when the snapshot shows an asynchronous UI (skeletons, spinners, aria-busy).",
      "- Order the actions so that the workflow is reproducible without the model: navigation first,",
      "  then goal-reachable fields, then any confirming save/commit action last.",
      "- Set `confidence` honestly:   1.0 = the element name uniquely names the target;",
      "  0.7–0.9 = the element matches by role+text;   0.4–0.6 = the match is plausible;",
      "  < 0.4 = the target is a guess and the step should be reviewed by a human.",
      "",
      "Goal: {{goal}}",
      "Entities (JSON, may be empty): {{entitiesJson}}",
      "Additional context from sources (may be empty): {{context}}",
      "",
      "Accessibility snapshot:",
      "{{a11ySnapshot}}",
    ].join("\n"),
    requiredVariables: ["goal", "entitiesJson", "a11ySnapshot"],
    optionalVariables: ["context"],
    createdAt: "2024-01-01T00:00:00.000Z",
    notes:
      "Structured JSON output. Consumers must validate against the expected shape; an invalid shape is a hard failure, not a soft one.",
  },
  {
    id: "synth.a11y-summary.v1",
    taskKey: "synth.a11y-summary",
    description:
      "Summarize a compacted accessibility snapshot into a short prose description of the page's interactive surface.",
    template: [
      "Describe the interactive surface of this web page in at most {{maxSentences}} sentences.",
      "Quote the exact accessible names of the important controls. Do not invent controls that are not",
      "listed. If the page has no interactive elements, say so.",
      "",
      "Page title: {{pageTitle}}",
      "Accessibility snapshot:",
      "{{a11ySnapshot}}",
    ].join("\n"),
    requiredVariables: ["pageTitle", "a11ySnapshot", "maxSentences"],
    optionalVariables: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    notes:
      "Used to seed a human-readable summary shown above the synthesized steps. Cheap and non-authoritative.",
  },
  {
    id: "synth.text-to-action.v1",
    taskKey: "synth.text-to-action",
    description:
      "Map a natural-language instruction to a single UI action, or return a null action when no match exists.",
    template: [
      "You are a UI-action matcher. The user instruction below refers to an element on the current page.",
      "Match the instruction against the accessibility snapshot and return ONE JSON object:",
      '{ "kind": "click" | "type" | "select" | "scroll" | "navigate" | "keypress" | "wait" | null,',
      '  "target": "@eN" | null, "value": string | null, "confidence": number, "reasoning": string }',
      "",
      "Rules:",
      "- Never invent an `@eN` reference that is not present in the snapshot.",
      "- When no element plausibly matches, return kind=null and explain why in `reasoning`.",
      "- Set `confidence` in the same 0..1 scale used by the workflow synthesizer.",
      "",
      "Instruction: {{instruction}}",
      "Accessibility snapshot:",
      "{{a11ySnapshot}}",
    ].join("\n"),
    requiredVariables: ["instruction", "a11ySnapshot"],
    optionalVariables: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    notes:
      "Single-action matcher. Used to ground each sub-task produced by synth.workflow into a concrete step.",
  },
  {
    id: "synth.distill.v1",
    taskKey: "synth.distill",
    description:
      "Distill a validated action plan into a deterministic Playwright script fragment.",
    template: [
      "Translate the following validated action plan into a deterministic Playwright (TypeScript) script",
      "fragment. The fragment must:",
      "  - Use only the locators that resolve the given `@eN` references, expressed as `page.getByRole`,`",
      "    `page.getByLabel`, `page.getByText`, `page.getByPlaceholder`, or `page.getByTestId` calls;",
      "  - Never use CSS selectors based on hashed class names;",
      "  - Await every action;",
      "  - Wait for the expected state where the plan records one;",
      "  - Be valid TypeScript that compiles against @playwright/test.",
      "",
      "Return ONLY the script body between the markers `// ===BEGIN===` and `// ===END===`. No commentary.",
      "",
      "Action plan:",
      "{{actionPlanJson}}",
      "",
      "Resolved element descriptors (JSON, `@eN` → { role, name, value, placeholder }):",
      "{{resolvedDescriptorsJson}}",
    ].join("\n"),
    requiredVariables: ["actionPlanJson", "resolvedDescriptorsJson"],
    optionalVariables: [],
    createdAt: "2024-01-01T00:00:00.000Z",
    notes:
      "The result is not executed by the adapter; the distill module validates it before persisting.",
  },
]);

const registry = new Map<string, PromptVersion>();
for (const v of BUILT_IN_VERSIONS) {
  registry.set(v.id, v);
}

/** Look up a prompt version by id; throws when unknown. */
export function getPromptVersion(id: string): PromptVersion {
  const v = registry.get(id);
  if (v === undefined) {
    throw new PromptVersionNotFoundError(id, [...registry.keys()]);
  }
  return v;
}

/** Look up a prompt version by id; returns null when unknown. */
export function tryGetPromptVersion(id: string): PromptVersion | null {
  return registry.get(id) ?? null;
}

/** List every registered prompt version. */
export function listPromptVersions(): readonly PromptVersion[] {
  return [...registry.values()];
}

/** List every version registered under a given task key. */
export function listPromptVersionsForTask(
  taskKey: string,
): readonly PromptVersion[] {
  const out: PromptVersion[] = [];
  for (const v of registry.values()) {
    if (v.taskKey === taskKey) out.push(v);
  }
  return out;
}

/**
 * The version this deployment currently uses for a given task. Only one
 * built-in version per task exists in this phase; when a task has multiple
 * registered versions, the latest `createdAt` wins. A later phase adds an
 * explicit activation switch backed by the DB.
 */
export function activePromptVersionFor(taskKey: string): PromptVersion {
  const list = listPromptVersionsForTask(taskKey);
  if (list.length === 0) {
    throw new PromptVersionNotFoundError(`<task:${taskKey}>`, [
      ...registry.keys(),
    ]);
  }
  let best = list[0]!;
  for (const v of list) {
    if (Date.parse(v.createdAt) > Date.parse(best.createdAt)) best = v;
  }
  return best;
}

/** Convenience wrapper: render the active version for a task key. */
export function renderActivePrompt(
  taskKey: string,
  ctx: PromptTemplateContext,
): { readonly version: PromptVersion; readonly prompt: string } {
  const version = activePromptVersionFor(taskKey);
  const prompt = renderTemplate(version, ctx);
  return { version, prompt };
}

/**
 * Deterministic hash of a prompt version's template body. Callers record this
 * alongside the version id so an out-of-band edit to the template is
 * detectable in the usage log even when the id was not bumped.
 */
export function promptTemplateHash(version: PromptVersion): string {
  const h = createHash("sha256");
  h.update(version.id);
  h.update("\u0000");
  h.update(version.template);
  return h.digest("hex");
}

/**
 * Test-only registration of an additional prompt version. Not used in
 * production code paths; exposed so a regression test can register a variant
 * under the same task key.
 */
export function registerPromptVersionForTests(version: PromptVersion): void {
  registry.set(version.id, version);
}
