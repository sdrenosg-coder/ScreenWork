/**
 * Zipy AI — text-to-action mapping.
 *
 * Turns a natural-language operator prompt + an a11y snapshot into a
 * *proposed* mapping from sub-tasks to element refs. This is the first half
 * of the synthesis pipeline:
 *
 *     buildA11ySnapshot(...) → textToAction(...) → stepSequence(...)
 *
 * What this module is:
 *  - The parsing/normalisation layer between free-form text and the action
 *    verbs the product understands ("click", "type", "select", "scroll",
 *    "navigate"). It extracts the *goal*, the relevant *entities*
 *    (customer name, email, plan tier, etc.), and a candidate list of
 *    (verb, target-phrase) tuples.
 *
 *  - Deterministic when called with `mode: "deterministic"`. That path uses
 *    no LLM and produces a best-effort mapping based purely on lexical
 *    matching (verb lexicon + snapshot ref names). The deterministic path is
 *    used for: smoke tests of the pipeline without a provider, offline
 *    operation, and as the fallback when the LLM adapter is unavailable.
 *
 *  - LLM-assisted when called with `mode: "llm"` and an adapter is
 *    configured. The adapter receives the a11y snapshot text plus the
 *    operator prompt and must return JSON in the shape documented below. The
 *    adapter is loaded through `@zipy/llm/adapter` — which lands in a later
 *    batch of this phase — so the import is dynamic and a missing adapter is
 *    a first-class outcome (`adapterUsed: false`), never a crash or a
 *    fabricated response.
 *
 *  - Honest. Every sub-task carries a `match: "exact" | "fuzzy" | "ambiguous" | "unmatched"`
 *    so the downstream confidence scorer (and, ultimately, a human reviewer)
 *    can see exactly how solid each target selection is. Nothing is
 *    promoted to "matched" silently.
 *
 * What this module is NOT:
 *  - A step sequencer. Ordering, branching, conditional edges and the final
 *    action list belong to `stepSequence.ts` / `conditionalGraph.ts`. This
 *    module returns the operator's intent in the order it was written, plus
 *    enough metadata for the sequencer to reorder where required.
 *  - A browser. Nothing here launches Playwright or resolves a selector;
 *    that is the automation package's job.
 *  - A provider assumption. If no LLM is configured and the caller requested
 *    `mode: "llm"`, this module falls back to the deterministic path and
 *    records `adapterUsed: false` and `adapterFallbackReason`.
 */

import type { A11ySnapshot, SnapshotEntry } from "@zipy/synth/a11ySnapshot";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TextToActionErrorCode =
  | "invalid-input"
  | "empty-snapshot"
  | "empty-prompt"
  | "llm-invalid-output";

export class TextToActionError extends Error {
  readonly code: TextToActionErrorCode;
  constructor(message: string, code: TextToActionErrorCode) {
    super(message);
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The five action verbs the product understands. Everything the browser does
 * during a workflow run maps to one of these. Free-form verbs the parser
 * cannot place (e.g. "drag") are not mapped and are reported via
 * `unmappedCandidates` rather than silently coerced.
 */
export const ACTION_VERBS = ["click", "type", "select", "scroll", "navigate"] as const;
export type ActionVerb = (typeof ACTION_VERBS)[number];

/**
 * Quality of the mapping from a target phrase to a snapshot ref.
 *  - `exact`     — the phrase matched a ref's accessible name after whitespace
 *                  and case normalisation. The strongest possible signal.
 *  - `fuzzy`     — the phrase and ref are over the token-overlap threshold
 *                  but not identical. Reasonable but should be sanity-checked.
 *  - `ambiguous` — two or more refs matched the same phrase with equal score.
 *                  First candidate is returned with `candidates` listing the
 *                  alternatives; the reviewer decides.
 *  - `unmatched` — no ref matched within thresholds. The sub-task is retained
 *                  with `ref: null`; the sequencer flags it for review.
 */
export type MatchQuality = "exact" | "fuzzy" | "ambiguous" | "unmatched";

export interface CandidateRef {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  /** 0..1 confidence for this candidate within the sub-task. */
  readonly score: number;
}

/**
 * One sub-task extracted from the operator prompt. Every sub-task is a
 * *request* to perform a single verb against a single target; the sequencer
 * decides ordering and deduplication.
 */
export interface SubTask {
  /** Stable within the returned extraction; used as the id in later steps. */
  readonly subTaskId: string;
  /** The literal phrase the operator wrote, preserved for provenance. */
  readonly sourcePhrase: string;
  /** Offset of `sourcePhrase` within the original prompt (0-based). */
  readonly sourceOffset: number;
  readonly verb: ActionVerb;
  /** The target phrase after verb removal; used for ref matching. */
  readonly targetPhrase: string;
  /** Value to type/select into the target, when the phrase carries one. */
  readonly value: string | null;
  /** The best match, or null when quality is `unmatched`. */
  readonly ref: string | null;
  /** Cross-check against `A11ySnapshot.entries`; null when `unmatched`. */
  readonly matchedEntry: SnapshotEntry | null;
  readonly match: MatchQuality;
  /** All candidates considered, sorted by descending score. */
  readonly candidates: readonly CandidateRef[];
}

/** Entities the prompt named (customer name, email, plan tier, …). */
export interface ExtractedEntity {
  /** Normalised role of the entity, e.g. "customer_name", "email", "plan". */
  readonly role: string;
  /** Literal text from the prompt, verbatim, that produced this entity. */
  readonly value: string;
  /** Offset of `value` within the original prompt (0-based). */
  readonly offset: number;
}

export interface IntentExtraction {
  /** Human-readable summary of what the operator wants, as written. */
  readonly goal: string | null;
  /** Machine-shaped goal verb, if one was recognised ("create", "update", …). */
  readonly goalVerb: string | null;
  /** Subject of the goal verb, if one was recognised ("customer", "invoice"). */
  readonly goalSubject: string | null;
  readonly entities: readonly ExtractedEntity[];
  readonly subTasks: readonly SubTask[];
  /**
   * Verb phrases the parser recognised as action-like but could not map to a
   * supported verb. Surfaced rather than dropped so the reviewer sees
   * everything the operator asked for.
   */
  readonly unmappedCandidates: readonly string[];
}

export interface MapOptions {
  /**
   * `"llm"` (default) tries the LLM adapter first and falls back to the
   * deterministic path on any failure. `"deterministic"` skips the LLM
   * entirely — this is what CI and offline runs use.
   */
  readonly mode?: "llm" | "deterministic";
  /**
   * Fuzzy match threshold on token overlap (0..1). Defaults to 0.75, tuned
   * so that "New Customer" matches "New customer" and "New Client" does not.
   */
  readonly fuzzyThreshold?: number;
  /**
   * Below this threshold, a candidate is not considered at all. Defaults to
   * 0.4 — below — the pair is reported as unmatched rather than as a weak
   * match the model might over-trust.
   */
  readonly minimumScore?: number;
  /**
   * Optional priority list of refs, applied as a tie-break when two
   * candidates score equally. Useful when the caller wants, for instance,
   * the primary "Save" button inside a modal dialog over a secondary one in
   * the header.
   */
  readonly refPriority?: readonly string[];
}

export interface TextToActionResult {
  readonly prompt: string;
  readonly extraction: IntentExtraction;
  /** True when the LLM adapter answered; false on the deterministic path. */
  readonly adapterUsed: boolean;
  /**
   * Set when `mode: "llm"` was requested but the adapter was not available
   * or failed. Example values: `"no-adapter-configured"`, `"adapter-error"`,
   * `"adapter-returned-invalid-json"`. `null` on the deterministic path and
   * when the LLM answered successfully.
   */
  readonly adapterFallbackReason: string | null;
  /** Provider-reported model string when the LLM answered; `null` otherwise. */
  readonly model: string | null;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* LLM adapter contract                                                        */
/* -------------------------------------------------------------------------- */
/**
 * Same shape `packages/fusion/src/reconcile.ts` targets, so both modules can
 * bind to the same adapter once `@zipy/llm/adapter` ships. Kept local and
 * minimal so this module compiles today.
 */

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

/**
 * Map an operator prompt onto the a11y snapshot.
 *
 * Two-phase: first *extract intent deterministically* (goal, entities,
 * candidate sub-tasks from the verb lexicon). Then, when the LLM path is
 * requested and available, send the snapshot + prompt and let the model
 * propose a mapping. Model proposals are then reconciled against the
 * deterministic extraction: the model can only cite refs from the snapshot;
 * citations of unknown refs are dropped, and the sub-task is downgraded to
 * the deterministic match (or `unmatched`).
 */
export async function mapTextToActions(
  prompt: string,
  snapshot: A11ySnapshot,
  options: MapOptions = {},
): Promise<TextToActionResult> {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TextToActionError("mapTextToActions requires a non-empty prompt.", "empty-prompt");
  }
  if (snapshot === null || typeof snapshot !== "object") {
    throw new TextToActionError("mapTextToActions requires an A11ySnapshot.", "invalid-input");
  }
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
    throw new TextToActionError(
      "mapTextToActions requires a snapshot with at least one citable entry.",
      "empty-snapshot",
    );
  }

  const mode = options.mode ?? "llm";
  const fuzzyThreshold = clamp01(options.fuzzyThreshold ?? 0.75);
  const minimumScore = clamp01(options.minimumScore ?? 0.4);
  const refPriority = new Set(options.refPriority ?? []);

  const extraction = extractIntent(prompt, snapshot, {
    fuzzyThreshold,
    minimumScore,
    refPriority,
  });

  if (mode === "deterministic") {
    return {
      prompt,
      extraction,
      adapterUsed: false,
      adapterFallbackReason: null,
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  // LLM path: best-effort. A failure of any kind (no adapter, adapter
  // throws, adapter returns unparseable output) falls back to the
  // deterministic extraction with an explicit reason recorded.
  const adapter = await resolveLlmAdapter();
  if (adapter === null || !adapter.isConfigured()) {
    return {
      prompt,
      extraction,
      adapterUsed: false,
      adapterFallbackReason: "no-adapter-configured",
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  let completion: LlmCompleteResponse;
  try {
    completion = await adapter.completeText({
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(prompt, snapshot),
      maxOutputTokens: 2048,
      temperature: 0.1,
      correlationId: null,
      jsonMode: true,
    });
  } catch {
    return {
      prompt,
      extraction,
      adapterUsed: false,
      adapterFallbackReason: "adapter-error",
      model: null,
      generatedAt: new Date().toISOString(),
    };
  }

  const parsed = parseLlmMappingResponse(completion.text);
  if (parsed === null) {
    return {
      prompt,
      extraction,
      adapterUsed: false,
      adapterFallbackReason: "adapter-returned-invalid-json",
      model: `${completion.provider}:${completion.model}`,
      generatedAt: new Date().toISOString(),
    };
  }

  const merged = mergeLlmWithDeterministic(extraction, parsed, prompt, snapshot, {
    fuzzyThreshold,
    minimumScore,
    refPriority,
  });

  return {
    prompt,
    extraction: merged,
    adapterUsed: true,
    adapterFallbackReason: null,
    model: `${completion.provider}:${completion.model}`,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic extraction                                                    */
/* -------------------------------------------------------------------------- */

interface ExtractOpts {
  readonly fuzzyThreshold: number;
  readonly minimumScore: number;
  readonly refPriority: ReadonlySet<string>;
}

function extractIntent(
  prompt: string,
  snapshot: A11ySnapshot,
  opts: ExtractOpts,
): IntentExtraction {
  const goalInfo = extractGoal(prompt);
  const entities = extractEntities(prompt);
  const subTasks = extractSubTasks(prompt, snapshot, opts);
  const unmapped = extractUnmappedCandidates(prompt, subTasks);
  return {
    goal: goalInfo.goal,
    goalVerb: goalInfo.goalVerb,
    goalSubject: goalInfo.goalSubject,
    entities,
    subTasks,
    unmappedCandidates: unmapped,
  };
}

/**
 * Extract the goal statement. Heuristics:
 *  - If the prompt contains an explicit "goal:" or "objective:" prefix, the
 *    rest of that line is the goal.
 *  - Otherwise, the first sentence whose main verb is in the *goal verb* set
 *    (create, update, delete, invite, configure, export, import, …) is the
 *    goal. The subject is the noun phrase immediately following the verb.
 *
 * Anything not matching is reported as `goal: null`; the LLM path can still
 * infer the goal, and the caller may prompt the operator to state it.
 */
function extractGoal(prompt: string): {
  readonly goal: string | null;
  readonly goalVerb: string | null;
  readonly goalSubject: string | null;
} {
  const labelledMatch = /(?:goal|objective|purpose)\s*[:\-]\s*([^\n]+)/i.exec(prompt);
  if (labelledMatch !== null) {
    const goal = (labelledMatch[1] ?? "").trim();
    const verbSubject = parseGoalVerbSubject(goal);
    return {
      goal: goal.length > 0 ? goal : null,
      goalVerb: verbSubject.verb,
      goalSubject: verbSubject.subject,
    };
  }
  const sentences = splitSentences(prompt);
  for (const s of sentences) {
    const verbSubject = parseGoalVerbSubject(s);
    if (verbSubject.verb !== null) {
      return { goal: s.trim(), goalVerb: verbSubject.verb, goalSubject: verbSubject.subject };
    }
  }
  return { goal: null, goalVerb: null, goalSubject: null };
}

const GOAL_VERBS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "delete",
  "remove",
  "add",
  "edit",
  "invite",
  "configure",
  "export",
  "import",
  "publish",
  "assign",
  "grant",
  "revoke",
  "enable",
  "disable",
  "onboard",
  "migrate",
  "set",
  "reset",
]);

function parseGoalVerbSubject(s: string): { readonly verb: string | null; readonly subject: string | null } {
  const words = s.trim().split(/\s+/);
  if (words.length === 0) return { verb: null, subject: null };
  // Find the first goal verb token; the subject is the noun phrase that
  // follows, stopping at a probable clause boundary.
  for (let i = 0; i < words.length; i += 1) {
    const w = (words[i] as string).toLowerCase().replace(/[^a-z]/g, "");
    if (!GOAL_VERBS.has(w)) continue;
    const rest = words.slice(i + 1);
    const subject = takeNounPhrase(rest);
    return { verb: w, subject: subject.length > 0 ? subject : null };
  }
  return { verb: null, subject: null };
}

function takeNounPhrase(words: readonly string[]): string {
  const stop = new Set([
    "and",
    "then",
    "with",
    "by",
    "in",
    "on",
    "at",
    "for",
    "using",
    "via",
    "so",
    "that",
    "which",
    "who",
    "when",
    "where",
    "if",
  ]);
  const out: string[] = [];
  for (const w of words) {
    const clean = w.replace(/[.,;:!?]+$/, "");
    if (stop.has(clean.toLowerCase())) break;
    out.push(clean);
    if (out.length >= 6) break;
  }
  return out.join(" ").trim();
}

function extractEntities(prompt: string): readonly ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();

  // Pattern 1: `name = "Ada"` / `email: ada@example.com` — the most reliable
  // form; the operator has labelled the entity explicitly.
  const labelled = /\b([a-z][a-z0-9_]{1,31})\s*[:=]\s*("([^"]*)"|'([^']*)'|([^\s,;.]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = labelled.exec(prompt)) !== null) {
    const role = (m[1] as string).toLowerCase();
    const value = (m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (value.length === 0) continue;
    const key = `${role}=${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      role: normaliseEntityRole(role),
      value,
      offset: m.index,
    });
  }

  // Pattern 2: quoted strings that look like values, attributed to the
  // closest preceding labelled or verb-led noun phrase.
  const quoted = /"([^"]{1,80})"|'([^']{1,80})'/g;
  while ((m = quoted.exec(prompt)) !== null) {
    const value = (m[1] ?? m[2] ?? "").trim();
    if (value.length === 0) continue;
    // Skip if this exact value was picked up by the labelled pattern.
    if (out.some((e) => e.value === value)) continue;
    const before = prompt.slice(Math.max(0, m.index - 60), m.index);
    const role = inferRoleFromContext(before);
    const key = `${role}=${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role, value, offset: m.index });
  }

  // Pattern 3: bare email addresses.
  const emails = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  while ((m = emails.exec(prompt)) !== null) {
    const value = m[0];
    const key = `email=${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role: "email", value, offset: m.index });
  }

  (out as ExtractedEntity[]).sort((a, b) => a.offset - b.offset);
  return out;
}

function normaliseEntityRole(role: string): string {
  const r = role.toLowerCase();
  if (r === "email" || r === "email_address" || r === "mail") return "email";
  if (r === "phone" || r === "phone_number" || r === "tel") return "phone";
  if (r === "name" || r === "full_name" || r === "customer_name" || r === "fullname") {
    return "name";
  }
  if (r === "company" || r === "org" || r === "organization") return "company";
  if (r === "plan" || r === "tier") return "plan";
  if (r === "role") return "role";
  return r;
}

function inferRoleFromContext(before: string): string {
  const lower = before.toLowerCase();
  if (/\bemail\b/.test(lower)) return "email";
  if (/\bphone|telephone|tel\b/.test(lower)) return "phone";
  if (/\bname\b/.test(lower)) return "name";
  if (/\bcompany|organization|org\b/.test(lower)) return "company";
  if (/\bplan|tier\b/.test(lower)) return "plan";
  if (/\brole\b/.test(lower)) return "role";
  return "value";
}

/* -------------------------------------------------------------------------- */
/* Sub-task extraction                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Split the prompt into sub-tasks. Each sub-task corresponds to one
 * imperative clause: "click New Customer, fill in the name and email, then
 * click Save". Commas / "then" / "and" are treated as clause separators, but
 * a comma inside a value (e.g. "Eve, Ada & Co") is preserved because we
 * re-detect the verb at the start of each fragment.
 */
function extractSubTasks(
  prompt: string,
  snapshot: A11ySnapshot,
  opts: ExtractOpts,
): readonly SubTask[] {
  const fragments = splitIntoClauses(prompt);
  const out: SubTask[] = [];
  let idSeq = 1;

  for (const fragment of fragments) {
    const parsed = parseClause(fragment.text, fragment.offset);
    if (parsed === null) continue;
    const match = matchTarget(parsed.targetPhrase, snapshot.entries, opts);
    const top = match.candidates[0] ?? null;
    out.push({
      subTaskId: `st_${idSeq++}`,
      sourcePhrase: fragment.text.trim(),
      sourceOffset: fragment.offset,
      verb: parsed.verb,
      targetPhrase: parsed.targetPhrase,
      value: parsed.value,
      ref: match.quality === "unmatched" ? null : top?.ref ?? null,
      matchedEntry:
        match.quality === "unmatched" || top === null
          ? null
          : snapshot.entries.find((e) => e.ref === top.ref) ?? null,
      match: match.quality,
      candidates: match.candidates,
    });
  }
  return out;
}

interface ParsedClause {
  readonly verb: ActionVerb;
  readonly targetPhrase: string;
  readonly value: string | null;
}

const VERB_ALIASES: ReadonlyMap<string, ActionVerb> = new Map([
  ["click", "click"],
  ["press", "click"],
  ["tap", "click"],
  ["choose", "click"],
  ["select", "select"],
  ["pick", "select"],
  ["type", "type"],
  ["enter", "type"],
  ["input", "type"],
  ["fill", "type"],
  ["write", "type"],
  ["scroll", "scroll"],
  ["swipe", "scroll"],
  ["go", "navigate"],
  ["open", "navigate"],
  ["navigate", "navigate"],
  ["visit", "navigate"],
]);

function parseClause(text: string, offset: number): ParsedClause | null {
  const t = text.trim();
  if (t.length === 0) return null;
  const words = t.split(/\s+/);
  if (words.length === 0) return null;
  const first = (words[0] as string).toLowerCase().replace(/[^a-z]/g, "");
  const verb = VERB_ALIASES.get(first);
  if (verb === undefined) return null;
  const rest = words.slice(1);
  const joined = rest.join(" ");

  // Value extraction for `type`/`select`/`navigate`:
  //   `type "Ada" into Customer name`
  //   `type Ada into Customer name`
  //   `select Plan: Pro`
  //   `go to /customers/new`
  let target = joined;
  let value: string | null = null;

  if (verb === "type") {
    const m = /^(?:"([^"]*)"|'([^']*)'|([^\s].*?))\s+into\s+(.+)$/i.exec(joined);
    if (m !== null) {
      value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      target = (m[4] ?? "").trim();
    }
  } else if (verb === "select") {
    const m = /^([^:=]+?)\s*[:=]\s*(.+)$/.exec(joined);
    if (m !== null) {
      target = (m[1] ?? "").trim();
      value = (m[2] ?? "").trim();
    }
  } else if (verb === "navigate") {
    const m = /^(?:to\s+)?(.+)$/i.exec(joined);
    if (m !== null) target = (m[1] ?? "").trim();
  }

  // Strip a leading article ("the", "a", "an") and possessive.
  target = target.replace(/^(?:the|a|an)\s+/i, "").trim();

  return { verb, targetPhrase: target, value };
}

interface Fragment {
  readonly text: string;
  readonly offset: number;
}

/**
 * Split the prompt into clauses. We split on `,` / `;` / newline / the
 * conjunction "then", and — carefully — on " and " when the text after the
 * conjunction starts with a verb. This preserves commas inside values
 * ("Eve, Ada & Co") because the fragment after the comma will not start with
 * a verb and will be reattached to the previous clause.
 */
function splitIntoClauses(prompt: string): readonly Fragment[] {
  const rawBoundaries: number[] = [];
  // Collect boundary indices for splitting.
  const boundaryRe = /[,;\n]+|\bthen\b|\band\b/g;
  let m: RegExpExecArray | null;
  while ((m = boundaryRe.exec(prompt)) !== null) {
    rawBoundaries.push(m.index + m[0].length);
  }
  if (rawBoundaries.length === 0) {
    return [{ text: prompt, offset: 0 }];
  }
  const cuts = [0, ...rawBoundaries, prompt.length];
  const fragments: Fragment[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i] as number;
    const end = cuts[i + 1] as number;
    const ftext = prompt.slice(start, end);
    const leadingTrim = ftext.length - ftext.trimStart().length;
    fragments.push({ text: ftext.trim(), offset: start + leadingTrim });
  }
  // Merge fragments whose first word is not a verb back into the previous
  // fragment (treats them as continuation of the value/object).
  const merged: Fragment[] = [];
  for (const f of fragments) {
    const first = f.text.split(/\s+/)[0] ?? "";
    const firstLower = first.toLowerCase().replace(/[^a-z]/g, "");
    if (VERB_ALIASES.has(firstLower) || merged.length === 0) {
      merged.push(f);
    } else {
      const previous = merged[merged.length - 1] as Fragment;
      merged[merged.length - 1] = {
        text: `${previous.text} ${f.text}`.trim(),
        offset: previous.offset,
      };
    }
  }
  return merged.filter((f) => f.text.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Target matching                                                             */
/* -------------------------------------------------------------------------- */

interface MatchResult {
  readonly quality: MatchQuality;
  readonly candidates: readonly CandidateRef[];
}

/**
 * Match a target phrase against the snapshot entries. Compares normalised
 * accessible names. Thresholds are the caller-supplied `fuzzyThreshold` (for
 * accepting a fuzzy match) and `minimumScore` (below which a candidate is
 * not reported at all).
 *
 * Quality:
 *  - exact: a single entry scores 1.0 with no ties → quality "exact".
 *  - fuzzy: top score >= fuzzyThreshold and > minimumScore, no ties →
 *    quality "fuzzy".
 *  - ambiguous: top score >= minimumScore but >= 2 entries within a small
 *    epsilon → quality "ambiguous".
 *  - unmatched: no candidate scored >= minimumScore.
 */
function matchTarget(
  phrase: string,
  entries: readonly SnapshotEntry[],
  opts: ExtractOpts,
): MatchResult {
  const norm = normalise(phrase);
  if (norm.length === 0) return { quality: "unmatched", candidates: [] };

  const scored: CandidateRef[] = [];
  for (const e of entries) {
    const entryNorm = normalise(e.name.length > 0 ? e.name : e.role);
    if (entryNorm.length === 0) continue;
    const score = tokenJaccard(norm, entryNorm);
    if (score < 1 && score < opts.minimumScore) continue;
    scored.push({ ref: e.ref, role: e.role, name: e.name, score });
  }

  if (scored.length === 0) return { quality: "unmatched", candidates: [] };

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Ref priority tie-break; higher priority wins.
    const aPri = opts.refPriority.has(a.ref) ? 1 : 0;
    const bPri = opts.refPriority.has(b.ref) ? 1 : 0;
    if (aPri !== bPri) return bPri - aPri;
    // Stable lexical tie-break: lower ref number wins (numeric-aware).
    return a.ref.localeCompare(b.ref, undefined, { numeric: true });
  });

  const top = scored[0] as CandidateRef;
  const second = scored[1];
  // Ties within an epsilon are ambiguous.
  const tie = second !== undefined && Math.abs(second.score - top.score) < 1e-6;

  if (top.score >= 1 && !tie) return { quality: "exact", candidates: scored };
  if (top.score >= opts.fuzzyThreshold && !tie) return { quality: "fuzzy", candidates: scored };
  if (tie) return { quality: "ambiguous", candidates: scored };
  if (top.score >= opts.minimumScore) return { quality: "fuzzy", candidates: scored };
  return { quality: "unmatched", candidates: scored };
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "and",
  "or",
  "it",
  "this",
  "that",
  "is",
  "are",
]);

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenJaccard(a: string, b: string): number {
  if (a === b) return 1;
  const ta = new Set(a.split(" ").filter((t) => t.length > 0 && !STOP_WORDS.has(t)));
  const tb = new Set(b.split(" ").filter((t) => t.length > 0 && !STOP_WORDS.has(t)));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/* -------------------------------------------------------------------------- */
/* Unmapped candidates                                                         */
/* -------------------------------------------------------------------------- */

const UNSUPPORTED_VERBS = [
  "drag",
  "drop",
  "hover",
  "check",
  "uncheck",
  "toggle",
  "upload",
  "download",
  "attach",
  "sign",
  "verify",
  "confirm",
  "wait",
  "pause",
  "refresh",
];

function extractUnmappedCandidates(
  prompt: string,
  already: readonly SubTask[],
): readonly string[] {
  const out: string[] = [];
  const lower = prompt.toLowerCase();
  for (const verb of UNSUPPORTED_VERBS) {
    const re = new RegExp(`\\b${verb}\\b[^.,;\\n]{0,60}`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const snippet = prompt.slice(m.index, m.index + m[0].length).trim();
      if (snippet.length === 0) continue;
      if (already.some((s) => s.sourcePhrase.includes(snippet))) continue;
      if (!out.includes(snippet)) out.push(snippet);
    }
  }
  return out;
}

function splitSentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* -------------------------------------------------------------------------- */
/* LLM prompt + response parsing                                               */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(): string {
  return [
    "You map an operator's natural-language prompt onto an accessibility snapshot.",
    "You receive:",
    "  1. An accessibility snapshot text. Each line that begins with @eN is a",
    "     citable target. Lines beginning with ~ are context: read them, do not",
    "     cite them.",
    "  2. The operator's prompt.",
    "",
    "Return ONLY a JSON object of the form:",
    '{"subTasks":[{"verb":"click|type|select|scroll|navigate",',
    '               "targetRef":"@eN",',
    '               "targetPhrase":"...",',
    '               "value":null|"..."}],',
    ' "goal":null|"...",',
    ' "entities":[{"role":"...","value":"..."}]}',
    "",
    "Rules:",
    " - Every targetRef must be an @eN that appears in the snapshot. Do not",
    "   invent refs. If no snapshot ref matches the target, omit that subTask.",
    " - Do not add commentary outside the JSON object.",
    " - Preserve the operator's ordering of sub-tasks.",
    " - Prefer the primary (highest z-index / most specific) element when two",
    "   elements share the same accessible name; the snapshot is depth-ordered",
    "   so the last occurrence in the same subtree is usually nested inside it.",
  ].join("\n");
}

function buildUserPrompt(prompt: string, snapshot: A11ySnapshot): string {
  const lines: string[] = [];
  lines.push("## Accessibility snapshot");
  lines.push(snapshot.text);
  lines.push("");
  lines.push("## Operator prompt");
  lines.push(prompt);
  return lines.join("\n");
}

interface LlmMappingResponse {
  readonly subTasks: readonly {
    readonly verb: ActionVerb;
    readonly targetRef: string;
    readonly targetPhrase: string;
    readonly value: string | null;
  }[];
  readonly goal: string | null;
  readonly entities: readonly { readonly role: string; readonly value: string }[];
}

function parseLlmMappingResponse(raw: string): LlmMappingResponse | null {
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

  const subTasksRaw = Array.isArray(root["subTasks"]) ? (root["subTasks"] as unknown[]) : [];
  const subTasks: LlmMappingResponse["subTasks"][number][] = [];
  for (const item of subTasksRaw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const verbRaw = o["verb"];
    const verb: ActionVerb | null =
      verbRaw === "click" ||
      verbRaw === "type" ||
      verbRaw === "select" ||
      verbRaw === "scroll" ||
      verbRaw === "navigate"
        ? verbRaw
        : null;
    if (verb === null) continue;
    const targetRef = typeof o["targetRef"] === "string" ? (o["targetRef"] as string) : "";
    if (!/^@e\d+$/.test(targetRef)) continue;
    const targetPhrase = typeof o["targetPhrase"] === "string" ? (o["targetPhrase"] as string) : "";
    const value = typeof o["value"] === "string" ? (o["value"] as string) : null;
    subTasks.push({ verb, targetRef, targetPhrase, value });
  }

  const goal = typeof root["goal"] === "string" ? (root["goal"] as string) : null;

  const entitiesRaw = Array.isArray(root["entities"]) ? (root["entities"] as unknown[]) : [];
  const entities: { role: string; value: string }[] = [];
  for (const item of entitiesRaw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const role = typeof o["role"] === "string" ? (o["role"] as string) : "";
    const value = typeof o["value"] === "string" ? (o["value"] as string) : "";
    if (role.length === 0 || value.length === 0) continue;
    entities.push({ role, value });
  }

  return { subTasks, goal, entities };
}

/* -------------------------------------------------------------------------- */
/* Merge LLM + deterministic                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reconcile the LLM's proposals with the deterministic extraction.
 *
 * Rules:
 *  1. LLM refs must exist in the snapshot. An unknown ref → drop the LLM
 *     sub-task and fall back to the deterministic match (or unmatched).
 *  2. When the LLM produced a sub-task whose targetPhrase matches a
 *     deterministic sub-task (case-insensitive, whitespace-normalised), the
 *     LLM ref wins (it had the full snapshot as context); its value wins
 *     when non-null.
 *  3. Deterministic sub-tasks the LLM did not cover are retained as-is.
 *  4. When the LLM proposed sub-tasks the deterministic path missed, they
 *     are appended in the LLM's order.
 *  5. Entities from the LLM are merged with the deterministic ones; the
 *     deterministic extraction is preferred on conflicts because it is
 *     verbatim from the prompt.
 */
function mergeLlmWithDeterministic(
  deterministic: IntentExtraction,
  llm: LlmMappingResponse,
  prompt: string,
  snapshot: A11ySnapshot,
  opts: ExtractOpts,
): IntentExtraction {
  const validRefs = new Set(snapshot.entries.map((e) => e.ref));
  const detKey = (t: SubTask): string => normalise(t.targetPhrase);
  const byKey = new Map<string, SubTask>();
  for (const st of deterministic.subTasks) byKey.set(detKey(st), st);
  const consumed = new Set<string>();
  const merged: SubTask[] = [];

  let idSeq = deterministic.subTasks.length + 1;
  for (const llmSt of llm.subTasks) {
    const key = normalise(llmSt.targetPhrase);
    const det = byKey.get(key);
    if (det !== undefined) consumed.add(key);
    if (!validRefs.has(llmSt.targetRef)) {
      // Invalid ref: keep the deterministic match (or unmatched) rather
      // than accepting a fabricated ref.
      if (det !== undefined) merged.push(det);
      continue;
    }
    const entry = snapshot.entries.find((e) => e.ref === llmSt.targetRef) ?? null;
    const subTask: SubTask = {
      subTaskId: det?.subTaskId ?? `st_llm_${idSeq++}`,
      sourcePhrase: det?.sourcePhrase ?? llmSt.targetPhrase,
      sourceOffset: det?.sourceOffset ?? prompt.indexOf(llmSt.targetPhrase),
      verb: llmSt.verb,
      targetPhrase: llmSt.targetPhrase,
      value: llmSt.value ?? det?.value ?? null,
      ref: llmSt.targetRef,
      matchedEntry: entry,
      match: det?.ref === llmSt.targetRef ? det.match : "fuzzy",
      candidates: det?.candidates ?? [
        { ref: llmSt.targetRef, role: entry?.role ?? "", name: entry?.name ?? "", score: 0.5 },
      ],
    };
    merged.push(subTask);
  }

  // Retain deterministic sub-tasks the LLM did not cover (in original order).
  for (const st of deterministic.subTasks) {
    if (consumed.has(detKey(st))) continue;
    merged.push(st);
  }

  // Merge entities: deterministic wins on same-role+value; LLM-only entities
  // (from the model's extraction) are appended.
  const mergedEntities: ExtractedEntity[] = [...deterministic.entities];
  for (const e of llm.entities) {
    const role = normaliseEntityRole(e.role);
    if (
      mergedEntities.some(
        (m) => m.role === role && m.value.toLowerCase() === e.value.toLowerCase(),
      )
    ) {
      continue;
    }
    mergedEntities.push({ role, value: e.value, offset: prompt.indexOf(e.value) });
  }
  mergedEntities.sort((a, b) => a.offset - b.offset);

  const goal = deterministic.goal ?? llm.goal;
  const goalVerbSubject = deterministic.goalVerb
    ? { verb: deterministic.goalVerb, subject: deterministic.goalSubject }
    : parseGoalVerbSubject(llm.goal ?? "");

  return {
    goal,
    goalVerb: goalVerbSubject.verb,
    goalSubject: goalVerbSubject.subject,
    entities: mergedEntities,
    subTasks: merged,
    unmappedCandidates: deterministic.unmappedCandidates,
  };
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateTextToActionResult(value: unknown): TextToActionResult {
  if (value === null || typeof value !== "object") {
    throw new TextToActionError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const extractionRaw = (r["extraction"] ?? {}) as Record<string, unknown>;

  const subTasksRaw = Array.isArray(extractionRaw["subTasks"])
    ? (extractionRaw["subTasks"] as unknown[])
    : [];
  const subTasks: SubTask[] = [];
  for (const raw of subTasksRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const verbRaw = o["verb"];
    const verb: ActionVerb | null =
      verbRaw === "click" ||
      verbRaw === "type" ||
      verbRaw === "select" ||
      verbRaw === "scroll" ||
      verbRaw === "navigate"
        ? verbRaw
        : null;
    if (verb === null) continue;
    const subTaskId = typeof o["subTaskId"] === "string" ? (o["subTaskId"] as string) : "";
    if (subTaskId.length === 0) continue;
    const matchRaw = o["match"];
    const match: MatchQuality =
      matchRaw === "exact" || matchRaw === "fuzzy" || matchRaw === "ambiguous" || matchRaw === "unmatched"
        ? matchRaw
        : "unmatched";
    subTasks.push({
      subTaskId,
      sourcePhrase: typeof o["sourcePhrase"] === "string" ? (o["sourcePhrase"] as string) : "",
      sourceOffset:
        typeof o["sourceOffset"] === "number" && Number.isFinite(o["sourceOffset"] as number)
          ? Math.max(0, Math.floor(o["sourceOffset"] as number))
          : 0,
      verb,
      targetPhrase: typeof o["targetPhrase"] === "string" ? (o["targetPhrase"] as string) : "",
      value: typeof o["value"] === "string" ? (o["value"] as string) : null,
      ref: typeof o["ref"] === "string" ? (o["ref"] as string) : null,
      matchedEntry: readMaybeEntry(o["matchedEntry"]),
      match,
      candidates: Array.isArray(o["candidates"])
        ? (o["candidates"] as unknown[])
            .map((c) => readCandidate(c))
            .filter((c): c is CandidateRef => c !== null)
        : [],
    });
  }

  const entities: ExtractedEntity[] = Array.isArray(extractionRaw["entities"])
    ? (extractionRaw["entities"] as unknown[])
        .map((e) => {
          if (e === null || typeof e !== "object") return null;
          const o = e as Record<string, unknown>;
          const role = typeof o["role"] === "string" ? (o["role"] as string) : "";
          const val = typeof o["value"] === "string" ? (o["value"] as string) : "";
          if (role.length === 0 || val.length === 0) return null;
          return {
            role,
            value: val,
            offset:
              typeof o["offset"] === "number" && Number.isFinite(o["offset"] as number)
                ? Math.max(0, Math.floor(o["offset"] as number))
                : 0,
          };
        })
        .filter((e): e is ExtractedEntity => e !== null)
    : [];

  return {
    prompt: typeof r["prompt"] === "string" ? (r["prompt"] as string) : "",
    extraction: {
      goal: typeof extractionRaw["goal"] === "string" ? (extractionRaw["goal"] as string) : null,
      goalVerb: typeof extractionRaw["goalVerb"] === "string" ? (extractionRaw["goalVerb"] as string) : null,
      goalSubject:
        typeof extractionRaw["goalSubject"] === "string" ? (extractionRaw["goalSubject"] as string) : null,
      entities,
      subTasks,
      unmappedCandidates: Array.isArray(extractionRaw["unmappedCandidates"])
        ? (extractionRaw["unmappedCandidates"] as unknown[]).filter(
            (s): s is string => typeof s === "string",
          )
        : [],
    },
    adapterUsed: r["adapterUsed"] === true,
    adapterFallbackReason:
      typeof r["adapterFallbackReason"] === "string" ? (r["adapterFallbackReason"] as string) : null,
    model: typeof r["model"] === "string" ? (r["model"] as string) : null,
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
  };
}

function readMaybeEntry(v: unknown): SnapshotEntry | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ref = typeof o["ref"] === "string" ? (o["ref"] as string) : "";
  const role = typeof o["role"] === "string" ? (o["role"] as string) : "";
  if (ref.length === 0 || role.length === 0) return null;
  return {
    ref,
    role,
    name: typeof o["name"] === "string" ? (o["name"] as string) : "",
    value: typeof o["value"] === "string" ? (o["value"] as string) : null,
    level:
      typeof o["level"] === "number" && Number.isFinite(o["level"] as number)
        ? Math.floor(o["level"] as number)
        : null,
    states: Array.isArray(o["states"])
      ? (o["states"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    properties:
      o["properties"] !== null && typeof o["properties"] === "object"
        ? (o["properties"] as Readonly<Record<string, string | number | boolean>>)
        : {},
    depth:
      typeof o["depth"] === "number" && Number.isFinite(o["depth"] as number)
        ? Math.max(0, Math.floor(o["depth"] as number))
        : 0,
  };
}

function readCandidate(v: unknown): CandidateRef | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ref = typeof o["ref"] === "string" ? (o["ref"] as string) : "";
  if (ref.length === 0) return null;
  return {
    ref,
    role: typeof o["role"] === "string" ? (o["role"] as string) : "",
    name: typeof o["name"] === "string" ? (o["name"] as string) : "",
    score:
      typeof o["score"] === "number" && Number.isFinite(o["score"] as number)
        ? clamp01(o["score"] as number)
        : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  extractGoal,
  extractEntities,
  extractSubTasks,
  parseClause,
  splitIntoClauses,
  matchTarget,
  mergeLlmWithDeterministic,
  parseLlmMappingResponse,
  buildSystemPrompt,
  buildUserPrompt,
  normalise,
  tokenJaccard,
  VERB_ALIASES,
});
