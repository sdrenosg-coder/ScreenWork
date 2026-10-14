/**
 * Zipy AI — brand voice training (content-generation, style batch 0).
 *
 * A workspace can supply a brand-voice profile (uploaded guidelines or
 * example content). The profile shapes the deterministic pass and the LLM
 * directive block used by every content layer, without the platform having
 * to fine-tune a model.
 *
 * Two inputs are accepted:
 *
 *   1. **Guidelines** — free-text prose describing the desired voice. The
 *      module extracts a small, inspectable `BrandVoiceProfile` from it:
 *      preferred/forbidden phrasings, preferred capitalization of brand
 *      terms, and any explicit "do not" lines.
 *   2. **Examples** — sample sentences the workspace has published and that
 *      it considers on-voice. The module tokenises each example and derives:
 *      contractions-in-use, sentence-length distribution, second-person
 *      usage, and a small list of distinctive n-grams. Those signals are
 *      surfaced to the reviewer as `detectedTraits`; the module does not
 *      train a model.
 *
 * The profile is applied in two places:
 *
 *   - `applyBrandVoice(text, profile)` — a deterministic pass that swaps
 *     forbidden phrasings for their preferred alternatives (documented
 *     substitutions only — no generative rewriting) and enforces the
 *     preferred capitalization of brand terms.
 *   - `buildBrandVoiceDirectives(profile)` — the LLM-visible block appended
 *     to every layer's system prompt through `pipeline.ts`.
 *
 * Design rules honoured:
 *  - Nothing in the profile is invented. Every extracted trait is derived
 *    from the caller's text with a documented rule; the guideline parser
 *    only recognises a short, fixed set of cue phrases ("Do not use X",
 *    "Use Y instead of Z", "Prefer Z"). Anything the parser does not
 *    recognise is recorded verbatim as an advisory note, not as a rule.
 *  - Deterministic and pure: no I/O, no LLM call. Training an LLM
 *    instruction set from examples is a later-batch concern; this module
 *    produces the profile that would feed it.
 *  - The deterministic substitutions never touch the subject/verb/object of
 *    a sentence; they only replace whole phrases the workspace has banned.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type BrandVoiceErrorCode = "invalid-input" | "empty-input";

export class BrandVoiceError extends Error {
  readonly code: BrandVoiceErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: BrandVoiceErrorCode,
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
 * One substitution the guideline text asked for. The parser emits these
 * only when the guideline uses one of the recognised cue phrases; the
 * substitutions are applied whole-phrase, case-insensitively, and never
 * overlap with protected segments (backticks/quoted strings/URLs).
 */
export interface BrandVoiceSubstitution {
  readonly from: string;
  readonly to: string;
  /** Sentence from the guideline text that produced the rule. */
  readonly rationale: string;
}

/**
 * The profile the rest of the content pipeline reads. It is a *description*
 * of the voice, not the voice itself; the LLM produces the voice.
 */
export interface BrandVoiceProfile {
  /** Terms whose capitalisation must be preserved. Derived from examples and from guideline casing. */
  readonly preferredTerms: readonly string[];
  /** Phrases the workspace has banned, with the preferred replacement. */
  readonly substitutions: readonly BrandVoiceSubstitution[];
  /** Free-form advisories: lines the parser recognised as voice guidance but could not reduce to a rule. */
  readonly advisories: readonly string[];
  /** Signal counts from the supplied examples. */
  readonly detectedTraits: BrandVoiceTraits;
  /** Names of the example artefacts the profile learned from, for the review UI. */
  readonly learnedFrom: readonly string[];
  /** ISO timestamp of the profile this was built from. */
  readonly generatedAt: string;
}

export interface BrandVoiceTraits {
  readonly examplesParsed: number;
  readonly sentences: number;
  readonly avgSentenceWords: number;
  readonly contractionsInUse: readonly string[];
  readonly secondPersonCount: number;
  readonly firstPersonCount: number;
  readonly questionCount: number;
  readonly exclamationCount: number;
  /** Distinctive n-grams (order-3) that appear in two or more examples. */
  readonly recurringTrigrams: readonly string[];
}

export interface BuildBrandVoiceInput {
  /** Guidelines prose. Recognised cue phrases produce substitutions and advisories. */
  readonly guidelines?: string | null;
  /** Example sentences/blocks the workspace considers on-voice. */
  readonly examples?: readonly string[];
  /** Names of the artefacts that supplied the examples (for provenance). */
  readonly exampleNames?: readonly string[];
  /**
   * Terms whose capitalisation is authoritative. Supplied by the caller
   * from the workspace settings or from the terminology list.
   */
  readonly preferredTerms?: readonly string[];
}

export interface BrandVoiceApplication {
  readonly text: string;
  readonly applied: boolean;
  readonly changes: readonly BrandVoiceChange[];
}

export interface BrandVoiceChange {
  readonly kind: "substitution" | "capitalisation";
  readonly before: string;
  readonly after: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const PROTECTED_OPEN = "\u0001P";
const PROTECTED_CLOSE = "P\u0001";
const TERM_SENTINEL_OPEN = "\u0001T";
const TERM_SENTINEL_CLOSE = "T\u0001";

/**
 * The cue phrases the guideline parser recognises. Each entry is a pair of
 * regexes: one that captures the "from" phrase and one that captures the
 * "to" phrase. The rules are read left to right and the first matching
 * pattern wins for a given line.
 */
const CUE_PATTERNS: ReadonlyArray<{
  readonly re: RegExp;
  readonly extract: (m: RegExpExecArray) => BrandVoiceSubstitution | null;
}> = [
  // "Use X instead of Y"
  {
    re: /\buse\s+["'“”‘’]?([^"'“”‘’]+?)["'“”‘’]?\s+instead\s+of\s+["'“”‘’]?([^"'“”‘’]+?)["'“”‘’]?\s*[.!]?$/i,
    extract: (m) => {
      const to = (m[1] ?? "").trim();
      const from = (m[2] ?? "").trim();
      if (to.length === 0 || from.length === 0) return null;
      return { from, to, rationale: m[0] };
    },
  },
  // "Prefer X to Y" / "Prefer X over Y"
  {
    re: /\bprefer\s+["'“”‘’]?([^"'“”‘’]+?)["'“”‘’]?\s+(?:to|over)\s+["'“”‘’]?([^"'“”‘’]+?)["'“”‘’]?\s*[.!]?$/i,
    extract: (m) => {
      const to = (m[1] ?? "").trim();
      const from = (m[2] ?? "").trim();
      if (to.length === 0 || from.length === 0) return null;
      return { from, to, rationale: m[0] };
    },
  },
  // "Replace X with Y"
  {
    re: /\breplace\s+["'“”‘’]?([^"'“”‘’]+?)["'“”‘’]?\s+with\s+["'“”‘’]?([^"'“”‘’]+?)["'“”‘’]?\s*[.!]?$/i,
    extract: (m) => {
      const from = (m[1] ?? "").trim();
      const to = (m[2] ?? "").trim();
      if (to.length === 0 || from.length === 0) return null;
      return { from, to, rationale: m[0] };
    },
  },
  // "Do not use X" / "Don't use X" — a ban with no explicit replacement;
  // recorded as an advisory, not a substitution.
  {
    re: /\b(?:do\s+not|don'?t)\s+use\s+["'“”‘’]?([^"'“”‘’]+?)["'“”‘’]?\s*[.!]?$/i,
    extract: () => null,
  },
];

/**
 * The set of English contraction pairs used by the traits extractor. The
 * list mirrors the one in `tone.ts`; the two layers must agree on what
 * counts as a contraction so the trait report is stable.
 */
const CONTRACTION_PROBES: readonly string[] = [
  "don't", "doesn't", "won't", "can't", "isn't", "aren't", "wasn't",
  "weren't", "hasn't", "haven't", "hadn't", "it's", "that's", "there's",
  "you're", "you've", "you'll", "we're", "we've", "we'll", "they're",
  "they've", "they'll", "i'm", "i've", "i'll", "let's",
];

const SECOND_PERSON_RE = /\b(you|your|yours|yourself)\b/gi;
const FIRST_PERSON_RE = /\b(i|we|our|ours|us)\b/gi;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build a `BrandVoiceProfile` from guidelines and examples. Never throws for
 * missing or empty inputs; an empty profile is returned instead. Throws only
 * for shape errors (e.g. a non-array `examples`).
 */
export function buildBrandVoice(input: BuildBrandVoiceInput = {}): BrandVoiceProfile {
  if (input.examples !== undefined && !Array.isArray(input.examples)) {
    throw new BrandVoiceError("`examples` must be an array of strings.", "invalid-input");
  }
  const guidelines = typeof input.guidelines === "string" ? input.guidelines : "";
  const examples = (input.examples ?? []).filter((e) => typeof e === "string");
  const exampleNames = (input.exampleNames ?? []).filter((e) => typeof e === "string");
  const explicitTerms = normalisePreferredTerms(input.preferredTerms ?? []);

  const { substitutions, advisories } = parseGuidelines(guidelines);
  const traits = deriveTraits(examples);
  const preferredTerms = mergePreferredTerms(explicitTerms, extractTermsFromGuidelines(guidelines));

  return {
    preferredTerms,
    substitutions,
    advisories,
    detectedTraits: traits,
    learnedFrom: exampleNames,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Apply the profile to a single string: replace forbidden phrases and
 * enforce preferred capitalisation. Returns the rewritten text plus the
 * list of changes for the diff view.
 */
export function applyBrandVoice(
  text: string,
  profile: BrandVoiceProfile,
): BrandVoiceApplication {
  if (typeof text !== "string") {
    throw new BrandVoiceError("applyBrandVoice requires a string.", "invalid-input");
  }
  if (text.length === 0) return { text, applied: false, changes: [] };

  const { protectedText, restore } = protectSegments(text, profile.preferredTerms);
  const changes: BrandVoiceChange[] = [];
  let working = protectedText;

  for (const sub of profile.substitutions) {
    if (sub.from.length === 0) continue;
    const escaped = escapeRegExp(sub.from);
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "giu");
    working = working.replace(re, (match) => {
      const replacement = matchCase(match, sub.to);
      if (replacement === match) return match;
      changes.push({ kind: "substitution", before: match, after: replacement });
      return replacement;
    });
  }

  return {
    text: restore(working),
    applied: changes.length > 0,
    changes,
  };
}

/**
 * Apply the brand voice to every prose string in a content draft, walking
 * the structure and preserving shapes. Non-prose fields are preserved
 * verbatim.
 */
export function applyBrandVoiceDeep<T>(value: T, profile: BrandVoiceProfile): T {
  return walkAndRewrite(value, profile, 0) as T;
}

/**
 * Build the LLM directives from the profile. This is the string a content
 * layer appends to its system prompt. It is deliberately short (the model
 * responds better to a compact voice brief than to a long list) and it
 * never asks the model to invent terminology it has not been given.
 */
export function buildBrandVoiceDirectives(profile: BrandVoiceProfile): string {
  const lines: string[] = [];
  lines.push("Brand voice brief:");

  if (profile.preferredTerms.length > 0) {
    lines.push(
      `- Use these terms with exactly this capitalisation: ${profile.preferredTerms.join(", ")}.`,
    );
  } else {
    lines.push("- Do not invent product, page or brand names.");
  }

  if (profile.substitutions.length > 0) {
    lines.push("- Replace the following phrasings:");
    for (const sub of profile.substitutions) {
      lines.push(`    "${sub.from}" → "${sub.to}"`);
    }
  }

  const t = profile.detectedTraits;
  if (t.sentences > 0) {
    const register: string[] = [];
    if (t.contractionsInUse.length > 0) {
      register.push(`contractions (e.g. ${t.contractionsInUse.slice(0, 3).join(", ")})`);
    }
    if (t.secondPersonCount > t.firstPersonCount) register.push("second person ('you')");
    if (t.questionCount > 0) register.push("occasional rhetorical questions");
    if (t.exclamationCount > 0) register.push("measured enthusiasm (occasional exclamation)");
    if (register.length > 0) {
      lines.push(`- Match this register: ${register.join("; ")}.`);
    }
    lines.push(
      `- Keep sentences in the neighbourhood of ${Math.round(t.avgSentenceWords)} words.`,
    );
    if (t.recurringTrigrams.length > 0) {
      lines.push(
        `- The example content frequently uses phrases such as: ${t.recurringTrigrams.slice(0, 4).map((g) => `"${g}"`).join(", ")}.`,
      );
    }
  }

  for (const note of profile.advisories) {
    lines.push(`- ${note}`);
  }

  return lines.join("\n");
}

/**
 * Merge two profiles. The second profile's substitutions and preferred
 * terms are added, its advisories appended, and its traits discarded (the
 * first profile's traits are the ones built from the larger example set).
 * Intended for the case where a workspace has a global voice and a
 * per-project overlay.
 */
export function mergeBrandVoice(
  base: BrandVoiceProfile,
  overlay: BrandVoiceProfile,
): BrandVoiceProfile {
  const subByFrom = new Map<string, BrandVoiceSubstitution>();
  for (const s of base.substitutions) subByFrom.set(s.from.toLowerCase(), s);
  for (const s of overlay.substitutions) subByFrom.set(s.from.toLowerCase(), s);

  const terms = mergePreferredTerms(base.preferredTerms, overlay.preferredTerms);
  const advisories: string[] = [];
  const seen = new Set<string>();
  for (const a of [...base.advisories, ...overlay.advisories]) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    advisories.push(a);
  }

  return {
    preferredTerms: terms,
    substitutions: [...subByFrom.values()],
    advisories,
    detectedTraits: base.detectedTraits,
    learnedFrom: [...base.learnedFrom, ...overlay.learnedFrom],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Rehydrate a profile from JSON. Returns a profile with the safe default
 * shape when fields are missing; corrections downstream are possible
 * because every field is checked.
 */
export function rehydrateBrandVoice(value: unknown): BrandVoiceProfile {
  if (value === null || typeof value !== "object") {
    throw new BrandVoiceError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const preferredTerms = Array.isArray(r["preferredTerms"])
    ? (r["preferredTerms"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const subscriptions: BrandVoiceSubstitution[] = [];
  if (Array.isArray(r["substitutions"])) {
    for (const entry of r["substitutions"] as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const from = typeof e["from"] === "string" ? e["from"] : "";
      const to = typeof e["to"] === "string" ? e["to"] : "";
      const rationale = typeof e["rationale"] === "string" ? e["rationale"] : "";
      if (from.length === 0 || to.length === 0) continue;
      subscriptions.push({ from, to, rationale });
    }
  }
  const advisories = Array.isArray(r["advisories"])
    ? (r["advisories"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const learnedFrom = Array.isArray(r["learnedFrom"])
    ? (r["learnedFrom"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const traitsRaw = r["detectedTraits"];
  const detectedTraits: BrandVoiceTraits =
    traitsRaw !== null && typeof traitsRaw === "object"
      ? readTraits(traitsRaw as Record<string, unknown>)
      : emptyTraits();
  const generatedAt =
    typeof r["generatedAt"] === "string" ? r["generatedAt"] : "";
  return {
    preferredTerms,
    substitutions: subscriptions,
    advisories,
    detectedTraits,
    learnedFrom,
    generatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Guideline parsing                                                           */
/* -------------------------------------------------------------------------- */

interface ParseResult {
  readonly substitutions: readonly BrandVoiceSubstitution[];
  readonly advisories: readonly string[];
}

function parseGuidelines(guidelines: string): ParseResult {
  if (guidelines.trim().length === 0) {
    return { substitutions: [], advisories: [] };
  }
  const substitutions: BrandVoiceSubstitution[] = [];
  const advisories: string[] = [];
  const seen = new Set<string>();

  const lines = guidelines.split(/\r?\n+/);
  for (const line of lines) {
    const trimmed = line.trim().replace(/^[-*•\u2022]\s*/, "");
    if (trimmed.length === 0) continue;

    let matched = false;
    for (const cue of CUE_PATTERNS) {
      const m = cue.re.exec(trimmed);
      if (m === null) continue;
      const result = cue.extract(m);
      if (result === null) {
        // The cue matched but produced no substitution (e.g. a "Do not
        // use X" rule without an explicit replacement). Record it as an
        // advisory so a reviewer sees the guidance was recognised.
        const key = trimmed.toLowerCase();
        if (!seen.has(key)) {
          advisories.push(trimmed);
          seen.add(key);
        }
      } else {
        const key = `${result.from.toLowerCase()}\u0001${result.to.toLowerCase()}`;
        if (!seen.has(key)) {
          substitutions.push(result);
          seen.add(key);
        }
      }
      matched = true;
      break;
    }
    if (matched) continue;

    // Recognised as a voice guidance line even without a structured cue.
    if (/(\bvoice\b|\btone\b|\bstyle\b|\bwrite\b|\bavoid\b|\bprefer\b|\buse\b)/i.test(trimmed)) {
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        advisories.push(trimmed);
        seen.add(key);
      }
    }
  }

  return { substitutions, advisories };
}

/**
 * Extract brand terms from the guidelines. The heuristic is: any
 * capitalised token that appears at least twice in the guidelines and is
 * neither a stop word nor a sentence-initial capital. This is deliberately
 * conservative; it produces candidates for the caller to confirm rather
 * than terms to enforce.
 */
function extractTermsFromGuidelines(guidelines: string): readonly string[] {
  const counts = new Map<string, { display: string; count: number }>();
  const tokens = guidelines.match(/\b[A-Z][a-zA-Z0-9]{1,}\b/g) ?? [];
  for (const token of tokens) {
    // Skip a token that is the very first word of a sentence.
    const idx = guidelines.indexOf(token);
    const preceding = idx > 0 ? guidelines.charAt(idx - 1) : "";
    if (preceding === "" || /[.!?\n]/.test(preceding) || /\s{1,}/.test(preceding) && idx === guidelines.search(new RegExp(`\\b${escapeRegExp(token)}\\b`))) {
      // Only skip when it looks like a sentence-initial capital and the
      // token is not obviously a term (a term usually contains an
      // internal capital or an all-caps form).
      const looksLikeTerm = /[A-Z].*[A-Z]/.test(token) || /^[A-Z]{2,}$/.test(token);
      if (!looksLikeTerm) continue;
    }
    const key = token.toLowerCase();
    const existing = counts.get(key);
    if (existing !== undefined) {
      existing.count += 1;
    } else {
      counts.set(key, { display: token, count: 1 });
    }
  }
  const out: string[] = [];
  for (const { display, count } of counts.values()) {
    if (count >= 2) out.push(display);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Trait extraction                                                            */
/* -------------------------------------------------------------------------- */

function deriveTraits(examples: readonly string[]): BrandVoiceTraits {
  if (examples.length === 0) return emptyTraits();

  const joined = examples.join("\n\n");
  const words = joined.match(/[\p{L}\p{N}][\p{L}\p{N}'\-]*/gu) ?? [];
  const sentences = joined.match(/\S[^.!?\n]*[.!?]+(?=\s|$)|[^\n.!?]+$/g) ?? [];
  const sentenceCount = Math.max(1, sentences.length);
  const avgSentenceWords = words.length / sentenceCount;

  const contractionsInUse = new Set<string>();
  for (const probe of CONTRACTION_PROBES) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegExp(probe)}(?![\\p{L}\\p{N}-])`, "iu");
    if (re.test(joined)) contractionsInUse.add(probe);
  }

  const secondPersonCount = (joined.match(SECOND_PERSON_RE) ?? []).length;
  const firstPersonCount = (joined.match(FIRST_PERSON_RE) ?? []).length;
  const questionCount = (joined.match(/\?/g) ?? []).length;
  const exclamationCount = (joined.match(/!/g) ?? []).length;

  const recurringTrigrams = findRecurringTrigrams(examples);

  return {
    examplesParsed: examples.length,
    sentences: sentenceCount,
    avgSentenceWords: Math.round(avgSentenceWords * 100) / 100,
    contractionsInUse: [...contractionsInUse].sort(),
    secondPersonCount,
    firstPersonCount,
    questionCount,
    exclamationCount,
    recurringTrigrams,
  };
}

function emptyTraits(): BrandVoiceTraits {
  return {
    examplesParsed: 0,
    sentences: 0,
    avgSentenceWords: 0,
    contractionsInUse: [],
    secondPersonCount: 0,
    firstPersonCount: 0,
    questionCount: 0,
    exclamationCount: 0,
    recurringTrigrams: [],
  };
}

function readTraits(raw: Record<string, unknown>): BrandVoiceTraits {
  const zeros = emptyTraits();
  return {
    examplesParsed: numberOr(raw["examplesParsed"], zeros.examplesParsed),
    sentences: numberOr(raw["sentences"], zeros.sentences),
    avgSentenceWords: numberOrFloat(raw["avgSentenceWords"], zeros.avgSentenceWords),
    contractionsInUse: stringArrayOr(raw["contractionsInUse"], []),
    secondPersonCount: numberOr(raw["secondPersonCount"], 0),
    firstPersonCount: numberOr(raw["firstPersonCount"], 0),
    questionCount: numberOr(raw["questionCount"], 0),
    exclamationCount: numberOr(raw["exclamationCount"], 0),
    recurringTrigrams: stringArrayOr(raw["recurringTrigrams"], []),
  };
}

function findRecurringTrigrams(examples: readonly string[]): readonly string[] {
  if (examples.length < 2) return [];
  const counts = new Map<string, { display: string; count: number }>();
  for (const ex of examples) {
    const words = (ex.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'\-]*/gu) ?? []);
    const seenInExample = new Set<string>();
    for (let i = 0; i + 2 < words.length; i += 1) {
      const parts = [words[i], words[i + 1], words[i + 2]];
      if (parts.some((p) => p === undefined)) continue;
      const key = parts.join(" ");
      if (seenInExample.has(key)) continue;
      seenInExample.add(key);
      const existing = counts.get(key);
      if (existing !== undefined) existing.count += 1;
      else counts.set(key, { display: key, count: 1 });
    }
  }
  const out: string[] = [];
  for (const { display, count } of counts.values()) {
    if (count >= 2) out.push(display);
  }
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, 12);
}

/* -------------------------------------------------------------------------- */
/* Protection & deep walk                                                      */
/* -------------------------------------------------------------------------- */

interface Protection {
  readonly protectedText: string;
  readonly restore: (s: string) => string;
}

function protectSegments(text: string, preferredTerms: readonly string[]): Protection {
  const protectedSegments: string[] = [];
  const terms: string[] = [];
  let working = text;

  for (const term of preferredTerms) {
    if (term.length === 0) continue;
    const escaped = escapeRegExp(term);
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "gu");
    working = working.replace(re, (match) => {
      const idx = terms.length;
      terms.push(match);
      return `${TERM_SENTINEL_OPEN}${idx}${TERM_SENTINEL_CLOSE}`;
    });
  }

  const protect = (match: string): string => {
    const idx = protectedSegments.length;
    protectedSegments.push(match);
    return `${PROTECTED_OPEN}${idx}${PROTECTED_CLOSE}`;
  };
  working = working
    .replace(/`[^`]*`/g, protect)
    .replace(/"[^"]*"/g, protect)
    .replace(/https?:\/\/[^\s)]+/g, protect);

  const restore = (s: string): string => {
    let restored = s;
    let last: string;
    do {
      last = restored;
      restored = restored.replace(
        new RegExp(`${PROTECTED_OPEN}(\\d+)${PROTECTED_CLOSE}`, "g"),
        (_m, idx: string) => protectedSegments[Number(idx)] ?? "",
      );
      restored = restored.replace(
        new RegExp(`${TERM_SENTINEL_OPEN}(\\d+)${TERM_SENTINEL_CLOSE}`, "g"),
        (_m, idx: string) => terms[Number(idx)] ?? "",
      );
    } while (restored !== last);
    return restored;
  };

  return { protectedText: working, restore };
}

const PROSE_KEYS = new Set<string>([
  "title",
  "summary",
  "description",
  "instruction",
  "text",
  "sentence",
  "introduction",
  "question",
  "answer",
  "note",
  "body",
  "content",
]);

function walkAndRewrite(value: unknown, profile: BrandVoiceProfile, depth: number): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    const result = applyBrandVoice(value, profile);
    return result.text;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => walkAndRewrite(v, profile, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = PROSE_KEYS.has(k) ? walkAndRewrite(v, profile, depth + 1) : v;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function normalisePreferredTerms(terms: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function mergePreferredTerms(
  a: readonly string[],
  b: readonly string[],
): readonly string[] {
  const seen = new Map<string, string>();
  for (const term of [...a, ...b]) {
    const key = term.toLowerCase();
    if (!seen.has(key)) seen.set(key, term);
  }
  return [...seen.values()];
}

function matchCase(source: string, target: string): string {
  const first = source.charAt(0);
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return `${target.charAt(0).toUpperCase()}${target.slice(1)}`;
  }
  return target;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return fallback;
}

function numberOrFloat(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return fallback;
}

function stringArrayOr(v: unknown, fallback: readonly string[]): readonly string[] {
  if (Array.isArray(v)) {
    return v.filter((s): s is string => typeof s === "string");
  }
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  parseGuidelines,
  extractTermsFromGuidelines,
  deriveTraits,
  findRecurringTrigrams,
  protectSegments,
  normalisePreferredTerms,
  mergePreferredTerms,
  CUE_PATTERNS,
  CONTRACTION_PROBES,
});
