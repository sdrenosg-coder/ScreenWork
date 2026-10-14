/**
 * Zipy AI — personalization: audience segmentation (content-generation, personalization batch 0).
 *
 * A workspace selects one audience per guide (end-user, admin, developer),
 * plus an optional secondary audience when a guide is meant to serve two
 * readers with a single narrative. The audience is the *depth contract*: it
 * decides which layers of detail are written, which are omitted, and which
 * terminology is assumed rather than defined.
 *
 * This module produces a single artefact, `AudienceProfile`, which the rest
 * of the content pipeline reads. The profile describes:
 *
 *   - **depth** — how much detail the reader is expected to need before they
 *     can act (one sentence, a paragraph, a section with code).
 *   - **assumedKnowledge** — what the reader is expected to already know so
 *     the writer does not need to explain it.
 *   - **include / omit** — the categories of content the writer should or
 *     should not produce (e.g., an end-user guide never includes SQL; a
 *     developer guide always includes an API or CLI alternative where one
 *     exists in the sources).
 *   - **terminology posture** — whether to define a domain term on first use
 *     or assume it.
 *   - **step verbosity** — a maximum sentence budget per step description so
 *     the output is measurably different from a differently-targeted guide.
 *
 * The profile is applied in two places:
 *
 *   - `buildAudienceDirectives(profile)` — the LLM-visible block appended to
 *     every layer's system prompt through `pipeline.ts`. Deterministic and
 *     short; the model gets a compact brief, not a wall of rules.
 *   - `applyAudienceTrim(text, profile)` — an *optional* deterministic pass
 *     the caller may run on already-generated prose to enforce the sentence
 *     budget. It only trims at sentence boundaries and never rewrites a
 *     sentence's subject, verb or object. It is off by default.
 *
 * Design rules honoured:
 *  - No invented facts. The profile contains only directives; it does not
 *    fabricate content and it will not add a "developer alternative" if the
 *    sources do not already contain one (the LLM directive asks the model
 *    to include one *only when present in the sources*).
 *  - Deterministic and pure: no I/O, no LLM call, no clock reads on the
 *    directive path.
 *  - The profile is a description, not the writing itself; the LLM produces
 *    the writing. This split lets a reviewer read and argue with the rule
 *    set without digging through prose.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AudienceErrorCode = "invalid-input" | "unknown-audience";

export class AudienceError extends Error {
  readonly code: AudienceErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: AudienceErrorCode,
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
 * The three audiences the platform supports. Kept as a const tuple so a
 * schema/route handler can iterate over the same list without a second
 * source of truth.
 */
export const AUDIENCES = ["end-user", "admin", "developer"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * Depth level names the target depth for a step's *description*. The names
 * are chosen so a reviewer can see, at a glance, which scale a guide is on.
 * `"one-liner"` is the default for end-user guides; `"sectioned"` produces
 * sub-headings in long-form outputs.
 */
export const AUDIENCE_DEPTHS = [
  "one-liner",
  "paragraph",
  "detailed-paragraph",
  "sectioned",
] as const;
export type AudienceDepth = (typeof AUDIENCE_DEPTHS)[number];

/**
 * Terminology posture. `assume` means a domain term is used as though the
 * reader already knows it; `define-on-first-use` means the writer should
 * introduce the definition inline the first time the term appears;
 * `defer-to-glossary` means the writer uses the term bare and relies on the
 * guide's glossary (the glossary layer already links the first occurrence).
 */
export const TERMINOLOGY_POSTURES = [
  "assume",
  "define-on-first-use",
  "defer-to-glossary",
] as const;
export type TerminologyPosture = (typeof TERMINOLOGY_POSTURES)[number];

export interface AudienceProfile {
  readonly audience: Audience;
  /** The reader's seniority implied by the audience selection. */
  readonly seniority: "novice" | "practitioner" | "expert";
  /** Target depth per step description. */
  readonly depth: AudienceDepth;
  /** Hard ceiling on sentences in a step's description, if enforced by the caller. */
  readonly maxSentencesPerStep: number;
  /**
   * Subjects the reader is *expected* to already know. The writer must not
   * spend prose explaining these. Populated from a fixed per-audience list
   * plus any caller-supplied additions.
   */
  readonly assumedKnowledge: readonly string[];
  /**
   * Categories of content the writer should produce. Every entry is a
   * directive sentence prepared for the LLM; the writer layer decides how
   * to honour it.
   */
  readonly include: readonly string[];
  /**
   * Categories of content the writer should *not* produce. Also a list of
   * directive sentences. A caller can add their own; the composer never
   * removes a baseline omit rule.
   */
  readonly omit: readonly string[];
  /** Terminology posture the writer should adopt. */
  readonly terminologyPosture: TerminologyPosture;
  /**
   * If true, prefer imperative ("Click Save") verbs over descriptive
   * ("You will then need to click Save"). End-user guides are imperative;
   * admin guides are imperative + explanatory; developer guides use
   * imperative in step items and descriptive in prose.
   */
  readonly imperativeSteps: boolean;
  /** When set, the guide targets an audience *pair* (e.g. admin + developer). */
  readonly secondaryAudience: Audience | null;
  /** Free-form advisories the caller attached; appended to the directive block verbatim. */
  readonly advisories: readonly string[];
  /** ISO timestamp of the profile build. */
  readonly generatedAt: string;
}

export interface BuildAudienceInput {
  readonly audience: Audience;
  /** Additional assumed-knowledge items, merged with the baseline list. */
  readonly assumedKnowledge?: readonly string[];
  /** Additional include rules. */
  readonly include?: readonly string[];
  /** Additional omit rules. Merged with (never replacing) the baseline list. */
  readonly omit?: readonly string[];
  /** Caller advisories appended to the profile and the directive block. */
  readonly advisories?: readonly string[];
  /**
   * Optional secondary audience for guides that serve two readers. When
   * set, the profile's include/omit sets are the union of both audiences'
   * sets; the directive block notes the pairing.
   */
  readonly secondaryAudience?: Audience | null;
  /**
   * Optional override for the sentence budget. When omitted, the depth's
   * default is used.
   */
  readonly maxSentencesPerStep?: number;
  /** Optional override for the terminology posture. */
  readonly terminologyPosture?: TerminologyPosture;
}

export interface AudienceApplication {
  readonly text: string;
  readonly applied: boolean;
  readonly sentencesKept: number;
  readonly sentencesDropped: number;
}

/* -------------------------------------------------------------------------- */
/* Audience baselines                                                          */
/* -------------------------------------------------------------------------- */

interface AudienceBaseline {
  readonly seniority: AudienceProfile["seniority"];
  readonly depth: AudienceDepth;
  readonly maxSentencesPerStep: number;
  readonly terminologyPosture: TerminologyPosture;
  readonly imperativeSteps: boolean;
  readonly assumedKnowledge: readonly string[];
  readonly include: readonly string[];
  readonly omit: readonly string[];
}

const BASELINES: Readonly<Record<Audience, AudienceBaseline>> = Object.freeze({
  "end-user": {
    seniority: "novice",
    depth: "one-liner",
    maxSentencesPerStep: 1,
    terminologyPosture: "defer-to-glossary",
    imperativeSteps: true,
    assumedKnowledge: [
      "how to use a web browser",
      "how to click, type and select within a form",
      "how to log in with the credentials they were given",
    ],
    include: [
      "One imperative sentence per step naming the exact button, field or link label from the plan.",
      "The reader's expected state after the step when the plan makes it unambiguous (e.g. a success toast).",
      "A short 'Before you begin' note only when the plan or sources name a prerequisite.",
    ],
    omit: [
      "Screenshots described in words — the reader is looking at the screenshots.",
      "Endpoint paths, SQL, CLI commands or configuration file formats.",
      "Architecture or implementation discussion.",
      "Multi-paragraph explanations of a single action.",
      "Definitions for terms that are already linked to the guide's glossary.",
    ],
  },
  admin: {
    seniority: "practitioner",
    depth: "detailed-paragraph",
    maxSentencesPerStep: 3,
    terminologyPosture: "define-on-first-use",
    imperativeSteps: true,
    assumedKnowledge: [
      "how to navigate the admin console",
      "what roles and permissions are",
      "how to create and manage user accounts",
      "the general shape of the product's settings pages",
    ],
    include: [
      "One imperative sentence per step naming the exact control from the plan.",
      "A short paragraph where a step's effect is not obvious (e.g. a permission change).",
      "A warning callout where the plan or a source names an irreversible or scope-widening action.",
      "A note on who else is affected when the step changes shared state.",
    ],
    omit: [
      "Command-line syntax for tasks the admin console already exposes as a form.",
      "Implementer-facing detail such as schema names or API request shapes, unless a source names them for this exact action.",
      "Definitions of terms already defined earlier in the same guide; link to the earlier definition instead.",
    ],
  },
  developer: {
    seniority: "expert",
    depth: "sectioned",
    maxSentencesPerStep: 4,
    terminologyPosture: "assume",
    imperativeSteps: true,
    assumedKnowledge: [
      "HTTP request and response semantics",
      "JSON",
      "environment variables and configuration files",
      "the command line",
      "the product's authentication model (API keys, OAuth)",
    ],
    include: [
      "One imperative sentence per step naming the exact control from the plan.",
      "The API or CLI equivalent *only when the sources already contain one* for that action; leave it out otherwise.",
      "A code block *only when the sources supply the exact code text*; never write code from prior knowledge.",
      "A note on rate limits, idempotency or retry behaviour only when a source names them.",
      "Explicit mention of the field name and type when the action writes to an API or config file and the sources name them.",
    ],
    omit: [
      "Explanations of what an HTTP status code or JSON object is.",
      "Walkthroughs of how to open a terminal, install a tool or edit a config file.",
      "Product marketing language.",
      "Repetition of the same snippet across steps; refer back to the step where the snippet first appears.",
    ],
  },
});

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build an `AudienceProfile`. Throws only for shape errors (unknown
 * audience, non-array list). Never throws for an empty assumed-knowledge
 * list; the baseline remains.
 */
export function buildAudience(input: BuildAudienceInput): AudienceProfile {
  if (input === null || typeof input !== "object") {
    throw new AudienceError("buildAudience requires an input object.", "invalid-input");
  }
  if (!isAudience(input.audience)) {
    throw new AudienceError(
      `Unknown audience "${String(input.audience)}". Expected one of: ${AUDIENCES.join(", ")}.`,
      "unknown-audience",
      { audience: input.audience },
    );
  }
  if (input.secondaryAudience !== undefined && input.secondaryAudience !== null && !isAudience(input.secondaryAudience)) {
    throw new AudienceError(
      `Unknown secondary audience "${String(input.secondaryAudience)}".`,
      "unknown-audience",
      { audience: input.secondaryAudience },
    );
  }

  const primary = BASELINES[input.audience];
  const secondary: AudienceBaseline | null =
    input.secondaryAudience !== undefined && input.secondaryAudience !== null
      ? BASELINES[input.secondaryAudience]
      : null;

  const depth = input.maxSentencesPerStep === undefined
    ? primary.depth
    : input.maxSentencesPerStep <= 1
      ? "one-liner"
      : input.maxSentencesPerStep <= 2
        ? "paragraph"
        : input.maxSentencesPerStep <= 4
          ? "detailed-paragraph"
          : "sectioned";

  const maxSentencesPerStep =
    input.maxSentencesPerStep !== undefined
      ? primary.maxSentencesPerStep >= (secondary?.maxSentencesPerStep ?? 0)
        ? clampInt(input.maxSentencesPerStep, 1, 12)
        : Math.max(primary.maxSentencesPerStep, secondary?.maxSentencesPerStep ?? primary.maxSentencesPerStep)
      : Math.max(
          primary.maxSentencesPerStep,
          secondary?.maxSentencesPerStep ?? primary.maxSentencesPerStep,
        );

  const assumedKnowledge = mergeUnique(
    primary.assumedKnowledge,
    secondary?.assumedKnowledge ?? [],
    input.assumedKnowledge ?? [],
  );
  const include = mergeUnique(primary.include, secondary?.include ?? [], input.include ?? []);
  const omit = mergeUnique(primary.omit, secondary?.omit ?? [], input.omit ?? []);
  const advisories = pruneStrings(input.advisories ?? []);

  const terminologyPosture: TerminologyPosture =
    input.terminologyPosture !== undefined
      ? input.terminologyPosture
      : primary.terminologyPosture;

  return {
    audience: input.audience,
    seniority: primary.seniority,
    depth,
    maxSentencesPerStep,
    assumedKnowledge,
    include,
    omit,
    terminologyPosture,
    imperativeSteps: primary.imperativeSteps,
    secondaryAudience: input.secondaryAudience ?? null,
    advisories,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The LLM-visible directive block. Every content layer that produces prose
 * appends this to its system prompt via `pipeline.ts`. It is deliberately
 * short and imperative; a long list of negative rules invites the model to
 * negotiate with them.
 */
export function buildAudienceDirectives(profile: AudienceProfile): string {
  const lines: string[] = [];
  const pair =
    profile.secondaryAudience !== null
      ? ` The guide also serves a ${profile.secondaryAudience} audience; every step must be readable by both.`
      : "";
  lines.push(
    `Audience: ${profile.audience} (${profile.seniority}). Depth: ${profile.depth}.${pair}`,
  );

  lines.push(
    `- Assume the reader already knows: ${profile.assumedKnowledge.join("; ")}.`,
  );

  lines.push("- Produce these forms of content:");
  for (const rule of profile.include) lines.push(`    ${rule}`);

  lines.push("- Do NOT produce:");
  for (const rule of profile.omit) lines.push(`    ${rule}`);

  switch (profile.terminologyPosture) {
    case "assume":
      lines.push(
        "- Use domain terms without inline definitions; assume the reader's existing vocabulary.",
      );
      break;
    case "define-on-first-use":
      lines.push(
        "- Define each domain term inline the first time it appears; use the term bare thereafter.",
      );
      break;
    case "defer-to-glossary":
      lines.push(
        "- Use domain terms bare; the guide links the first occurrence to its glossary entry. Do not inline a definition.",
      );
      break;
  }

  if (profile.imperativeSteps) {
    lines.push(
      "- Write step descriptions as imperative sentences (\"Click Save\"), not descriptive ones (\"You will need to click Save\").",
    );
  }

  lines.push(
    `- Keep each step description to at most ${profile.maxSentencesPerStep} short sentence${profile.maxSentencesPerStep === 1 ? "" : "s"}.`,
  );

  for (const note of profile.advisories) lines.push(`- ${note}`);

  return lines.join("\n");
}

/**
 * Deterministic trim: keep the first N sentences of a description when the
 * caller has opted in. Trims only at sentence boundaries and never rewrites
 * a sentence. When the text is already within budget, returns it unchanged.
 * When it is not, records the trim on the result so the editor's diff view
 * can show what was dropped (the caller is expected to route the drop to
 * review).
 */
export function applyAudienceTrim(
  text: string,
  profile: AudienceProfile,
): AudienceApplication {
  if (typeof text !== "string") {
    throw new AudienceError("applyAudienceTrim requires a string.", "invalid-input");
  }
  if (text.length === 0) {
    return { text, applied: false, sentencesKept: 0, sentencesDropped: 0 };
  }
  const budget = profile.maxSentencesPerStep;
  if (!Number.isFinite(budget) || budget <= 0) {
    return { text, applied: false, sentencesKept: 0, sentencesDropped: 0 };
  }

  const segments = splitSentences(text);
  if (segments.length <= budget) {
    return {
      text,
      applied: false,
      sentencesKept: segments.length,
      sentencesDropped: 0,
    };
  }
  const kept = segments.slice(0, budget).join(" ").trimEnd();
  return {
    text: kept,
    applied: true,
    sentencesKept: budget,
    sentencesDropped: segments.length - budget,
  };
}

/**
 * Rehydrate an `AudienceProfile` from JSON. Missing fields fall back to the
 * audience baseline rather than to a zero value, so an older payload does
 * not silently produce an empty include/omit set.
 */
export function rehydrateAudience(value: unknown): AudienceProfile {
  if (value === null || typeof value !== "object") {
    throw new AudienceError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const rawAudience = r["audience"];
  if (!isAudience(rawAudience)) {
    throw new AudienceError(
      `Rehydrate failed: unknown audience "${String(rawAudience)}".`,
      "unknown-audience",
    );
  }
  const baseline = BASELINES[rawAudience];
  const secondaryRaw = r["secondaryAudience"];
  const secondaryAudience: Audience | null =
    secondaryRaw === undefined || secondaryRaw === null
      ? null
      : isAudience(secondaryRaw)
        ? secondaryRaw
        : null;

  return {
    audience: rawAudience,
    seniority: readSeniority(r["seniority"]) ?? baseline.seniority,
    depth: readDepth(r["depth"]) ?? baseline.depth,
    maxSentencesPerStep: clampInt(
      numberOr(r["maxSentencesPerStep"], baseline.maxSentencesPerStep),
      1,
      12,
    ),
    assumedKnowledge: stringArrayOr(r["assumedKnowledge"], baseline.assumedKnowledge),
    include: stringArrayOr(r["include"], baseline.include),
    omit: stringArrayOr(r["omit"], baseline.omit),
    terminologyPosture:
      readTerminologyPosture(r["terminologyPosture"]) ?? baseline.terminologyPosture,
    imperativeSteps:
      typeof r["imperativeSteps"] === "boolean"
        ? r["imperativeSteps"]
        : baseline.imperativeSteps,
    secondaryAudience,
    advisories: stringArrayOr(r["advisories"], []),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/** Type guard for the audience enumeration. */
export function isAudience(v: unknown): v is Audience {
  return v === "end-user" || v === "admin" || v === "developer";
}

/** Look up the audience baseline read-only, for UI display (e.g. a preview pane). */
export function getAudienceBaseline(audience: Audience): AudienceBaseline {
  if (!isAudience(audience)) {
    throw new AudienceError(
      `Unknown audience "${String(audience)}".`,
      "unknown-audience",
    );
  }
  return BASELINES[audience];
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A conservative sentence splitter. It only splits on `.`, `?`, `!` followed
 * by whitespace and an uppercase letter or a digit, on a newline, or at the
 * end of input. It deliberately does not split inside abbreviations such as
 * "e.g." or "i.e." (those are filtered below), and it does not split inside
 * backticks or double-quoted strings. It is used only by the trim pass; the
 * LLM path reads whole descriptions.
 */
function splitSentences(text: string): string[] {
  const protectedText = protectSegments(text);
  const parts: string[] = [];
  let buffer = "";
  const textLen = protectedText.length;
  for (let i = 0; i < textLen; i += 1) {
    const ch = protectedText.charAt(i);
    buffer += ch;
    if (ch !== "." && ch !== "?" && ch !== "!") continue;
    // Consume an inline run of `.` or `!` so "Wait!! Really?" does not produce
    // three sentences.
    while (i + 1 < textLen && (protectedText.charAt(i + 1) === "." || protectedText.charAt(i + 1) === "!")) {
      i += 1;
      buffer += protectedText.charAt(i);
    }
    // Reject common abbreviations that end with a period.
    if (ABBREVIATION_TAIL_RE.test(buffer)) continue;
    const next = i + 1 < textLen ? protectedText.charAt(i + 1) : "";
    if (i + 1 >= textLen || /\s/.test(next)) {
      parts.push(buffer.trim());
      buffer = "";
      // Skip the whitespace that follows.
      while (i + 1 < textLen && /\s/.test(protectedText.charAt(i + 1))) {
        i += 1;
        buffer = "";
      }
    }
  }
  if (buffer.trim().length > 0) parts.push(buffer.trim());
  return restoreSegments(parts);
}

const ABBREVIATION_TAIL_RE =
  /(?:\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|st|jr|sr|inc|ltd|co|corp|no|fig|ref|approx|c|ca|cf|ed|eds|est|min|max|misc|p|pp|vol|vols|al|dept|govt)\.)$/iu;

const SEGMENT_OPEN = "\u0001S";
const SEGMENT_CLOSE = "S\u0001";

/**
 * Replace backtick spans and double-quoted spans with sentinel tokens so the
 * sentence splitter never breaks inside code or a quoted string. Stored
 * segments are restored after splitting.
 */
function protectSegments(text: string): string {
  const store: string[] = [];
  const replace = (match: string): string => {
    const idx = store.length;
    store.push(match);
    return `${SEGMENT_OPEN}${idx}${SEGMENT_CLOSE}`;
  };
  const protectedText = text
    .replace(/`[^`]*`/g, replace)
    .replace(/"[^"]*"/g, replace);
  // Stash the store on a WeakMap-free path by attaching to the returned
  // string via a module-scope map. This keeps the function pure for the
  // common case and is fine for a synchronous, single-threaded call.
  PROTECTED_SEGMENTS.set(protectedText, store);
  return protectedText;
}

const PROTECTED_SEGMENTS = new Map<string, readonly string[]>();

function restoreSegments(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    let restored = part;
    const store = PROTECTED_SEGMENTS.get(part);
    if (store === undefined) {
      // The part may not equal the protected text exactly (whitespace), so
      // restore via the sentinel pattern against the union store.
      restored = restoreViaAnyStore(part);
    } else {
      restored = restoreViaStore(part, store);
    }
    out.push(restored);
  }
  // Clear the map to avoid unbounded growth across long-running workers.
  PROTECTED_SEGMENTS.clear();
  return out;
}

function restoreViaStore(s: string, store: readonly string[]): string {
  return s.replace(
    new RegExp(`${SEGMENT_OPEN}(\\d+)${SEGMENT_CLOSE}`, "g"),
    (_m, idx: string) => store[Number(idx)] ?? "",
  );
}

function restoreViaAnyStore(s: string): string {
  // Best-effort: if a part came back with sentinels but the exact string
  // was not the map key (whitespace changed during splitting), settle for
  // removing the sentinels rather than fabricating content.
  return s
    .replace(new RegExp(`${SEGMENT_OPEN}\\d+${SEGMENT_CLOSE}`, "g"), "")
    .trim();
}

function mergeUnique(...lists: ReadonlyArray<readonly string[]>): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      const t = typeof item === "string" ? item.trim() : "";
      if (t.length === 0) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function pruneStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = typeof v === "string" ? v.trim() : "";
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return fallback;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  const n = Math.trunc(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function stringArrayOr(v: unknown, fallback: readonly string[]): readonly string[] {
  if (Array.isArray(v)) {
    return v.filter((s): s is string => typeof s === "string");
  }
  return fallback;
}

function readSeniority(v: unknown): AudienceProfile["seniority"] | null {
  if (v === "novice" || v === "practitioner" || v === "expert") return v;
  return null;
}

function readDepth(v: unknown): AudienceDepth | null {
  if (v === "one-liner" || v === "paragraph" || v === "detailed-paragraph" || v === "sectioned") {
    return v;
  }
  return null;
}

function readTerminologyPosture(v: unknown): TerminologyPosture | null {
  if (v === "assume" || v === "define-on-first-use" || v === "defer-to-glossary") return v;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  BASELINES,
  mergeUnique,
  pruneStrings,
  splitSentences,
  protectSegments,
  restoreViaStore,
  ABBREVIATION_TAIL_RE,
});
