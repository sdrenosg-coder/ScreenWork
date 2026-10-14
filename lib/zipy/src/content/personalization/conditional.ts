/**
 * Zipy AI — personalization: conditional content blocks (content-generation, personalization batch 0).
 *
 * A guide can carry content that is only shown to some readers. A
 * *conditional block* is a small, self-describing record:
 *
 *   {
 *     id, key,
 *     predicate: { role? plan? device? locale? industry? audience? custom? },
 *     body,          // the prose shown when the predicate matches
 *     alternative,   // optional prose shown when it does not
 *     anchor: { stepId?, stepIndex?, sectionId? },
 *     sourceRefs,    // provenance labels from the caller
 *   }
 *
 * The composer **never invents the predicate's branches**. It accepts a
 * caller-authored set of blocks (typically produced by an upstream LLM pass
 * that has seen the plan and the sources) and validates them so the writer
 * and export layers can trust the shape.
 *
 * The module also provides the deterministic *evaluator* the runtime uses to
 * decide which body a given reader sees: `evaluateConditions(blocks, context)`
 * returns, for each block, the resolved string and a decision record
 * explaining *why* the branch was chosen. The decision record is what the
 * reviewer UI shows ("shown because role=admin"), so an operator can debug a
 * surprising render without reading the predicate code.
 *
 * Design rules honoured:
 *  - No invented rules. Every predicate is authored by the caller; a
 *    predicate with no keys is a *gap* (a block that will always render the
 *    body), not a silent default.
 *  - Deterministic: given the same blocks and context, the decision is
 *    byte-identical. No randomness, no clock reads on the evaluator path.
 *  - The evaluator never fetches a reader's role, plan or device from the
 *    network. The context must be supplied by the caller (session, request
 *    headers, workspace settings) so this module stays testable.
 *  - Unknown keys and unknown enum values are rejected at compose time with
 *    a diagnostic, never silently coerced.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ConditionalErrorCode =
  | "invalid-input"
  | "unknown-predicate-key"
  | "unknown-predicate-value"
  | "duplicate-key";

export class ConditionalError extends Error {
  readonly code: ConditionalErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ConditionalErrorCode,
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
 * Supported predicate keys. Adding a key is a schema change; the enum is
 * kept here so the route handler and the renderer agree.
 */
export const CONDITION_KEYS = [
  "role",
  "plan",
  "device",
  "locale",
  "audience",
  "industry",
  "custom",
] as const;
export type ConditionKey = (typeof CONDITION_KEYS)[number];

/**
 * The predicate. Each key maps to a *list* of accepted values. A predicate
 * matches when, for every key that is present, the reader's context value
 * for that key is in the list. Keys absent from the predicate are not
 * evaluated. An empty predicate matches every reader — the composer records
 * this as a gap so a reviewer notices.
 */
export type ConditionPredicate = {
  readonly [K in ConditionKey]?: readonly string[];
};

/**
 * One conditional block. `alternative` is optional: when omitted and the
 * predicate does not match, the block is hidden entirely (the renderer
 * emits nothing). The presence of `alternative` is the difference between
 * "this sentence is shown to some readers" and "one of these two sentences
 * is always shown".
 */
export interface ConditionalBlock {
  readonly id: string;
  /** Caller-supplied stable key. Unique within a compose call. */
  readonly key: string;
  readonly predicate: ConditionPredicate;
  /** The prose shown when the predicate matches. Never empty. */
  readonly body: string;
  /** Optional prose shown when the predicate does not match. */
  readonly alternative: string | null;
  readonly anchor: ConditionalAnchor;
  /** Provenance labels (source artefact ids, page numbers, etc.). */
  readonly sourceRefs: readonly string[];
}

export interface ConditionalAnchor {
  readonly stepId: string | null;
  readonly stepIndex: number | null;
  readonly sectionId: string | null;
}

export interface ConditionalGap {
  readonly blockKey: string | null;
  readonly reason:
    | "empty-predicate"
    | "no-anchor"
    | "no-alternative"
    | "unknown-key"
    | "unknown-value"
    | "duplicate-key";
  readonly detail: string;
}

export interface ConditionalSet {
  readonly version: "conditional/1";
  readonly blocks: readonly ConditionalBlock[];
  readonly gaps: readonly ConditionalGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface ConditionalBlockInput {
  readonly key: string;
  /** Raw predicate, validated by the composer. */
  readonly predicate: Record<string, unknown>;
  readonly body: string;
  readonly alternative?: string | null;
  readonly stepId?: string | null;
  readonly sectionId?: string | null;
  readonly sourceRefs?: readonly string[];
}

export interface ComposeConditionalInputs {
  readonly blocks: readonly ConditionalBlockInput[];
  /** Optional plan; used to resolve step indexes for step-anchored blocks. */
  readonly plan?: { readonly steps?: readonly { readonly id?: string }[] } | null;
}

/**
 * The reader's context used to evaluate a predicate. Every field is
 * optional; an absent field cannot satisfy a predicate that names it, and
 * the evaluator records the miss in its reasoning.
 */
export interface ConditionalContext {
  readonly role?: string;
  readonly plan?: string;
  readonly device?: string;
  readonly locale?: string;
  readonly audience?: string;
  readonly industry?: string;
  /** Free-form custom bucket values, evaluated last. */
  readonly custom?: readonly string[];
}

export interface ConditionalDecision {
  readonly blockId: string;
  readonly blockKey: string;
  /** Which branch was chosen: "body", "alternative", or "hidden". */
  readonly branch: "body" | "alternative" | "hidden";
  /** The resolved string ("body" or "alternative" branch), or null when hidden. */
  readonly text: string | null;
  /** Human-readable reasoning trace for the reviewer UI. */
  readonly reasoning: readonly string[];
}

export interface ConditionalEvaluation {
  readonly decisions: readonly ConditionalDecision[];
  /** Convenience: the resolved strings in block order, with hidden entries dropped. */
  readonly visible: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compose and validate a conditional set. Throws only for shape errors
 * (non-array input). Structural problems (empty predicate, missing anchor,
 * duplicate key, unknown key/value) are recorded as gaps and the offending
 * block is dropped so downstream code never sees it.
 */
export function composeConditional(
  inputs: ComposeConditionalInputs,
): ConditionalSet {
  if (inputs === null || typeof inputs !== "object") {
    throw new ConditionalError("composeConditional requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(inputs.blocks)) {
    throw new ConditionalError("`blocks` must be an array.", "invalid-input");
  }

  const stepIndex = new Map<string, number>();
  const plan = inputs.plan ?? null;
  if (plan !== null && Array.isArray(plan.steps)) {
    for (let i = 0; i < plan.steps.length; i += 1) {
      const s = plan.steps[i];
      if (s === null || typeof s !== "object") continue;
      const id = (s as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) stepIndex.set(id, i + 1);
    }
  }

  const gaps: ConditionalGap[] = [];
  const blocks: ConditionalBlock[] = [];
  const seenKeys = new Set<string>();
  const idSeen = new Set<string>();

  for (const raw of inputs.blocks) {
    if (raw === null || typeof raw !== "object") continue;
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (key.length === 0) {
      gaps.push({
        blockKey: null,
        reason: "no-anchor",
        detail: "A conditional block was supplied without a key.",
      });
      continue;
    }
    if (seenKeys.has(key)) {
      gaps.push({
        blockKey: key,
        reason: "duplicate-key",
        detail: `Duplicate conditional block key "${key}"; the later block was dropped.`,
      });
      continue;
    }
    seenKeys.add(key);

    const body = typeof raw.body === "string" ? raw.body.trim() : "";
    if (body.length === 0) {
      gaps.push({
        blockKey: key,
        reason: "no-alternative",
        detail: `Conditional block "${key}" had no body text and was dropped.`,
      });
      continue;
    }

    const predicate = validatePredicate(raw.predicate, key, gaps);
    if (predicate === null) continue;

    const stepId = typeof raw.stepId === "string" && raw.stepId.trim().length > 0
      ? raw.stepId.trim()
      : null;
    const sectionId = typeof raw.sectionId === "string" && raw.sectionId.trim().length > 0
      ? raw.sectionId.trim()
      : null;
    if (stepId === null && sectionId === null) {
      gaps.push({
        blockKey: key,
        reason: "no-anchor",
        detail: `Conditional block "${key}" was supplied without a stepId or sectionId anchor.`,
      });
      // Not dropped: a section-less block is still renderable at the top of a
      // guide. The gap tells the reviewer to place it.
    }

    const alternative = typeof raw.alternative === "string" && raw.alternative.trim().length > 0
      ? raw.alternative.trim()
      : null;
    if (alternative === null && Object.keys(predicate).length > 0) {
      gaps.push({
        blockKey: key,
        reason: "no-alternative",
        detail: `Conditional block "${key}" has a predicate and no alternative; it will be hidden for non-matching readers.`,
      });
    }

    const sourceRefs = Array.isArray(raw.sourceRefs)
      ? (raw.sourceRefs as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

    const index = stepId !== null ? stepIndex.get(stepId) ?? null : null;
    const id = makeId("cond", key, blocks.length + 1, idSeen);

    blocks.push({
      id,
      key,
      predicate,
      body,
      alternative,
      anchor: { stepId, stepIndex: index, sectionId },
      sourceRefs,
    });
  }

  return {
    version: "conditional/1",
    blocks: sortBlocks(blocks),
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Deterministic evaluator. Returns one decision per block, in block order.
 * The reasoning trace records, for each predicate key, whether the context
 * supplied a value and whether it matched. Reason lines are stable strings a
 * reviewer can read without extra tooling.
 */
export function evaluateConditions(
  set: ConditionalSet,
  context: ConditionalContext,
): ConditionalEvaluation {
  if (set === null || typeof set !== "object") {
    throw new ConditionalError("evaluateConditions requires a set object.", "invalid-input");
  }
  const decisions: ConditionalDecision[] = [];
  const visible: string[] = [];
  for (const block of set.blocks) {
    const decision = evaluateOne(block, context);
    decisions.push(decision);
    if (decision.text !== null) visible.push(decision.text);
  }
  return { decisions, visible };
}

/**
 * Render a set to Markdown with each block's resolved branch per a supplied
 * context. Intended for the export layer's personalised view. The hidden
 * branches are omitted; the default branch is the body.
 */
export function renderConditionalMarkdown(
  set: ConditionalSet,
  context: ConditionalContext,
): string {
  const evaluation = evaluateConditions(set, context);
  const parts: string[] = [];
  for (const d of evaluation.decisions) {
    if (d.text === null) continue;
    parts.push(d.text);
    parts.push("");
  }
  if (set.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Conditional-block gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of set.gaps) {
      parts.push(`- ${gap.blockKey ?? "(no key)"}: ${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildConditionalDirectives(): string {
  return [
    "You are producing conditional content blocks for an already approved workflow guide.",
    "A conditional block has a predicate, a body shown when the predicate matches, and an optional alternative shown otherwise.",
    "Supported predicate keys and their allowed value types:",
    "    - role: customer-supplied role name (examples: 'admin', 'manager', 'analyst').",
    "    - plan: customer-supplied plan tier name (examples: 'free', 'pro', 'enterprise').",
    "    - device: 'desktop', 'tablet' or 'mobile'.",
    "    - locale: BCP-47 language tag (examples: 'en-US', 'fr-FR').",
    "    - audience: 'end-user', 'admin' or 'developer'.",
    "    - industry: the industry id from the workspace settings.",
    "    - custom: free-form bucket values the workspace defines.",
    "Every block must have a predicate with at least one key. An empty predicate is invalid.",
    "Do not invent roles, plan tiers or device types the workspace has not declared; use only values the caller supplied alongside this directive.",
    "Body and alternative are short prose that fit the surrounding step or section. Do not produce fragments that only make sense when read together with the other branch.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/** Rehydrate a `ConditionalSet` from JSON, preserving only well-formed blocks. */
export function rehydrateConditional(value: unknown): ConditionalSet {
  if (value === null || typeof value !== "object") {
    throw new ConditionalError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const rawBlocks = Array.isArray(r["blocks"]) ? (r["blocks"] as unknown[]) : [];
  const blocks: ConditionalBlock[] = [];
  const gaps: ConditionalGap[] = [];

  for (const item of rawBlocks) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const key = typeof o["key"] === "string" ? o["key"].trim() : "";
    const body = typeof o["body"] === "string" ? o["body"].trim() : "";
    if (key.length === 0 || body.length === 0) continue;

    const validateGaps: ConditionalGap[] = [];
    const predicate = validatePredicate(o["predicate"], key, validateGaps);
    if (predicate === null) {
      gaps.push(...validateGaps);
      continue;
    }
    gaps.push(...validateGaps);

    const anchorRaw = o["anchor"];
    let anchor: ConditionalAnchor = { stepId: null, stepIndex: null, sectionId: null };
    if (anchorRaw !== null && typeof anchorRaw === "object") {
      const a = anchorRaw as Record<string, unknown>;
      anchor = {
        stepId: typeof a["stepId"] === "string" ? a["stepId"] : null,
        stepIndex: typeof a["stepIndex"] === "number" && Number.isFinite(a["stepIndex"])
          ? Math.floor(a["stepIndex"])
          : null,
        sectionId: typeof a["sectionId"] === "string" ? a["sectionId"] : null,
      };
    }

    blocks.push({
      id: typeof o["id"] === "string" && o["id"].length > 0 ? o["id"] : `cond-${key}`,
      key,
      predicate,
      body,
      alternative:
        typeof o["alternative"] === "string" && o["alternative"].trim().length > 0
          ? o["alternative"].trim()
          : null,
      anchor,
      sourceRefs: Array.isArray(o["sourceRefs"])
        ? (o["sourceRefs"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    });
  }

  const rawGaps = Array.isArray(r["gaps"]) ? (r["gaps"] as unknown[]) : [];
  for (const item of rawGaps) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const reason = o["reason"];
    if (
      reason !== "empty-predicate" &&
      reason !== "no-anchor" &&
      reason !== "no-alternative" &&
      reason !== "unknown-key" &&
      reason !== "unknown-value" &&
      reason !== "duplicate-key"
    ) {
      continue;
    }
    gaps.push({
      blockKey: typeof o["blockKey"] === "string" ? o["blockKey"] : null,
      reason,
      detail: typeof o["detail"] === "string" ? o["detail"] : "",
    });
  }

  return {
    version: "conditional/1",
    blocks,
    gaps,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Predicate validation                                                        */
/* -------------------------------------------------------------------------- */

function validatePredicate(
  raw: unknown,
  blockKey: string,
  gaps: ConditionalGap[],
): ConditionPredicate | null {
  if (raw === null || typeof raw !== "object") {
    gaps.push({
      blockKey,
      reason: "empty-predicate",
      detail: `Conditional block "${blockKey}" has no predicate object.`,
    });
    return null;
  }
  const out: Partial<Record<ConditionKey, readonly string[]>> = {};
  let keys = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isConditionKey(k)) {
      gaps.push({
        blockKey,
        reason: "unknown-key",
        detail: `Conditional block "${blockKey}" uses unknown predicate key "${k}".`,
      });
      return null;
    }
    if (!Array.isArray(v)) {
      gaps.push({
        blockKey,
        reason: "unknown-value",
        detail: `Conditional block "${blockKey}" predicate key "${k}" must be an array of strings.`,
      });
      return null;
    }
    const values: string[] = [];
    for (const item of v) {
      if (typeof item !== "string" || item.trim().length === 0) {
        gaps.push({
          blockKey,
          reason: "unknown-value",
          detail: `Conditional block "${blockKey}" predicate key "${k}" contains a non-string or empty value.`,
        });
        return null;
      }
      values.push(item.trim());
    }
    if (values.length === 0) {
      // An empty list satisfies nothing; the caller probably meant to omit
      // the key. Reject rather than silently no-op.
      gaps.push({
        blockKey,
        reason: "unknown-value",
        detail: `Conditional block "${blockKey}" predicate key "${k}" has an empty value list.`,
      });
      return null;
    }
    out[k] = values;
    keys += 1;
  }
  if (keys === 0) {
    gaps.push({
      blockKey,
      reason: "empty-predicate",
      detail: `Conditional block "${blockKey}" has an empty predicate; it will match every reader.`,
    });
    return null;
  }
  return out;
}

function isConditionKey(v: string): v is ConditionKey {
  return (CONDITION_KEYS as readonly string[]).includes(v);
}

/* -------------------------------------------------------------------------- */
/* Evaluator                                                                   */
/* -------------------------------------------------------------------------- */

function evaluateOne(
  block: ConditionalBlock,
  context: ConditionalContext,
): ConditionalDecision {
  const reasoning: string[] = [];
  let matched = true;

  const keys = Object.keys(block.predicate) as ConditionKey[];
  for (const key of keys) {
    const wanted = block.predicate[key];
    if (wanted === undefined) continue;

    if (key === "custom") {
      const supplied = context.custom ?? [];
      const hit = wanted.find((w) => supplied.some((s) => s.toLowerCase() === w.toLowerCase()));
      if (hit === undefined) {
        matched = false;
        reasoning.push(
          `custom: reader context has [${supplied.join(", ") || "no values"}]; required one of [${wanted.join(", ")}]`,
        );
        break;
      }
      reasoning.push(`custom: matched "${hit}"`);
      continue;
    }

    const supplied = context[key];
    if (supplied === undefined || supplied === "") {
      matched = false;
      reasoning.push(`${key}: no value in reader context; required one of [${wanted.join(", ")}]`);
      break;
    }
    const hit = wanted.find((w) => w.toLowerCase() === supplied.toLowerCase());
    if (hit === undefined) {
      matched = false;
      reasoning.push(`${key}: reader has "${supplied}"; required one of [${wanted.join(", ")}]`);
      break;
    }
    reasoning.push(`${key}: matched "${supplied}"`);
  }

  if (matched) {
    return {
      blockId: block.id,
      blockKey: block.key,
      branch: "body",
      text: block.body,
      reasoning: reasoning.length > 0 ? reasoning : ["predicate matched"],
    };
  }
  if (block.alternative !== null) {
    return {
      blockId: block.id,
      blockKey: block.key,
      branch: "alternative",
      text: block.alternative,
      reasoning,
    };
  }
  return {
    blockId: block.id,
    blockKey: block.key,
    branch: "hidden",
    text: null,
    reasoning,
  };
}

/* -------------------------------------------------------------------------- */
/* Ordering & ids                                                              */
/* -------------------------------------------------------------------------- */

function sortBlocks(blocks: readonly ConditionalBlock[]): ConditionalBlock[] {
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
  validatePredicate,
  evaluateOne,
  isConditionKey,
  sortBlocks,
  makeId,
  slugifyId,
});
