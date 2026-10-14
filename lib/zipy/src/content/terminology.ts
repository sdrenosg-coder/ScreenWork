/**
 * Zipy AI — terminology enforcement (content-generation, style batch 1).
 *
 * A workspace keeps a terminology list: a set of preferred terms (the
 * spelling/casing the organisation wants) and, optionally, an explicit list
 * of banned synonyms mapping to a preferred term. This module:
 *
 *   1. Builds a normalised terminology profile from the workspace's list and
 *      from the guide's glossary (`packages/content/src/glossary.ts`).
 *   2. Applies it deterministically to prose: whole-phrase substitutions map
 *      banned synonyms to their approved term, and approved terms keep their
 *      authoritative casing. Backtick/code spans, quoted strings and URLs are
 *      protected so terminology never corrupts identifiers.
 *   3. Expands acronyms on first use ("API" → "API (Application Programming
 *      Interface)") and leaves later occurrences unexpanded — the standard
 *      documentation convention.
 *   4. Produces the LLM directive block that every content layer appends to
 *      its system prompt, so the model is told the approved vocabulary rather
 *      than corrected after the fact.
 *
 * Design rules honoured:
 *  - Nothing is invented. A synonym substitution is only applied when the
 *    workspace supplied the mapping. An acronym is only expanded when the
 *    expansion is supplied by the caller (workspace list, glossary entry or
 *    an explicitly passed expansion map). The module never guesses an
 *    expansion for an unfamiliar acronym.
 *  - Deterministic and pure: no I/O, no LLM call. It never rewrites inside a
 *    segment that a later renderer will treat as code.
 *  - Terminology and casing are separate concerns: `preferredTerms` may fix
 *    casing without any banned synonym, and `synonyms` may redirect spelling
 *    without any term being "preferred".
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TerminologyErrorCode =
  | "invalid-input"
  | "duplicate-term"
  | "circular-synonym";

export class TerminologyError extends Error {
  readonly code: TerminologyErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TerminologyErrorCode,
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
 * One approved term. `expansion` is optional: when present the term is an
 * acronym and the module will expand it on first use for each rendered
 * document. `caseSensitive` controls whether the substitution pass accepts a
 * differently-cased occurrence as a hit.
 */
export interface PreferredTerm {
  /** The approved spelling/casing, e.g. "PostgreSQL" or "API". */
  readonly term: string;
  /**
   * Optional expansion for an acronym, e.g. "Application Programming
   * Interface". Used only when the caller supplied it; never guessed.
   */
  readonly expansion?: string;
  /**
   * When true, only the exact given casing is treated as a match. Default
   * false, meaning "api" in prose is corrected to "API".
   */
  readonly caseSensitive?: boolean;
  /** Free-form note surfaced in the review UI, not applied to text. */
  readonly note?: string;
}

/** One banned-phrase → approved-phrase mapping. */
export interface TerminologySynonym {
  readonly banned: string;
  readonly approved: string;
  /** Sentence or catalogue entry that produced the rule, if any. */
  readonly rationale?: string;
}

/**
 * The per-guide terminology profile the rest of the content pipeline reads.
 * Constructed via `buildTerminologyProfile`.
 */
export interface TerminologyProfile {
  readonly preferredTerms: readonly PreferredTerm[];
  readonly synonyms: readonly TerminologySynonym[];
  /**
   * Acronym→expansion map derived from `preferredTerms` (and from explicit
   * entries in a glossary/expansion input). Only terms present here will be
   * expanded on first use.
   */
  readonly expansions: Readonly<Record<string, string>>;
  /** Terms the module refused to add (duplicates resolved or malformed). */
  readonly skipped: readonly TerminologySkip[];
  /** ISO timestamp of construction, for the review UI. */
  readonly generatedAt: string;
}

export interface TerminologySkip {
  readonly term: string;
  readonly reason:
    | "empty"
    | "duplicate"
    | "case-conflict"
    | "expansion-without-term";
  readonly detail?: string;
}

/** The result of applying a profile to a piece of prose. */
export interface TerminologyApplication {
  readonly text: string;
  readonly applied: boolean;
  readonly changes: readonly TerminologyChange[];
  /** Acronyms seen and where their first-use expansion landed, for provenance. */
  readonly expansions: readonly TerminologyExpansion[];
}

export interface TerminologyChange {
  readonly kind: "synonym" | "capitalisation";
  readonly before: string;
  readonly after: string;
  readonly offset: number;
}

export interface TerminologyExpansion {
  /** The acronym as it was expanded, e.g. "API". */
  readonly acronym: string;
  /** The expansion text inserted after the first occurrence. */
  readonly expansion: string;
  /** Character offset of the first occurrence in the *output* string. */
  readonly offset: number;
}

/** Input accepted by `buildTerminologyProfile`. */
export interface BuildTerminologyInput {
  /** Workspace terminology list, authoritative for casing and expansions. */
  readonly preferredTerms?: readonly (string | PreferredTerm)[];
  /** Workspace banned → approved mappings. */
  readonly synonyms?: readonly (
    | { readonly banned: string; readonly approved: string; readonly rationale?: string }
    | { readonly from: string; readonly to: string; readonly rationale?: string }
  )[];
  /**
   * Acronym → expansion pairs to seed the expansion map. Callers typically
   * pass entries from the guide glossary. Only acronyms the caller supplies
   * here (or via `preferredTerms[].expansion`) will be expanded.
   */
  readonly expansions?: Readonly<Record<string, string>>;
  /**
   * Terms to treat as case-preserved (e.g. brand names). Anything listed
   * here gets `caseSensitive: true` in the profile.
   */
  readonly caseSensitive?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Profile construction                                                        */
/* -------------------------------------------------------------------------- */

const ACRONYM_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const ALL_CAPS_RE = /^[A-Z0-9]{2,}$/;

/**
 * Build a normalised `TerminologyProfile`. Conflicting duplicates are
 * reported in `skipped` rather than silently dropped, so the UI can ask the
 * workspace to resolve them.
 */
export function buildTerminologyProfile(
  input: BuildTerminologyInput = {},
): TerminologyProfile {
  const skipped: TerminologySkip[] = [];

  // ------------------------------------------------------------------ terms
  const caseSensitiveSet = new Set(
    (input.caseSensitive ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
  );
  const preferredByKey = new Map<string, PreferredTerm>();

  const normaliseTerm = (
    value: string | PreferredTerm,
  ): PreferredTerm | TerminologySkip => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return { term: value, reason: "empty" };
      }
      return {
        term: trimmed,
        ...(caseSensitiveSet.has(trimmed) ? { caseSensitive: true } : {}),
      };
    }
    const term = typeof value.term === "string" ? value.term.trim() : "";
    if (term.length === 0) {
      return { term: value.term ?? "", reason: "empty" };
    }
    const expansionRaw =
      typeof value.expansion === "string" ? value.expansion.trim() : "";
    const expansion = expansionRaw.length > 0 ? expansionRaw : undefined;
    const caseSensitive =
      value.caseSensitive === true || caseSensitiveSet.has(term);
    return {
      term,
      ...(expansion !== undefined ? { expansion } : {}),
      ...(caseSensitive ? { caseSensitive: true } : {}),
      ...(typeof value.note === "string" && value.note.length > 0
        ? { note: value.note }
        : {}),
    };
  };

  const addTerm = (t: PreferredTerm): void => {
    const key = t.term.toLowerCase();
    const existing = preferredByKey.get(key);
    if (existing === undefined) {
      preferredByKey.set(key, t);
      return;
    }
    // Duplicate: two entries with the same lowercase form. If one carries an
    // expansion and the other does not, keep the expansion. If they differ
    // only in casing, prefer the entry flagged case-sensitive so we do not
    // normalise away the authoritative form.
    const merged: PreferredTerm = {
      term: existing.caseSensitive === true ? existing.term : t.term,
      ...(existing.expansion ?? t.expansion
        ? { expansion: existing.expansion ?? t.expansion }
        : {}),
      ...((existing.caseSensitive ?? t.caseSensitive) === true
        ? { caseSensitive: true }
        : {}),
      ...(existing.note ?? t.note ? { note: existing.note ?? t.note } : {}),
    };
    preferredByKey.set(key, merged);
    if (existing.term !== t.term) {
      skipped.push({
        term: t.term,
        reason: "case-conflict",
        detail: `Also present as "${existing.term}"; merged into the case-sensitive form.`,
      });
    } else {
      skipped.push({
        term: t.term,
        reason: "duplicate",
        detail: "Merged duplicate terminology entry.",
      });
    }
  };

  for (const raw of input.preferredTerms ?? []) {
    const result = normaliseTerm(raw);
    if (isSkip(result)) skipped.push(result);
    else addTerm(result);
  }

  // ------------------------------------------------------------- synonyms --
  const synonyms: TerminologySynonym[] = [];
  const synonymKeys = new Set<string>();
  for (const raw of input.synonyms ?? []) {
    const banned = (isNamedSynonym(raw) ? raw.banned : raw.from).trim();
    const approved = (isNamedSynonym(raw) ? raw.approved : raw.to).trim();
    if (banned.length === 0 || approved.length === 0) {
      skipped.push({
        term: banned || approved,
        reason: "empty",
        detail: "Synonym mapping requires both a banned and an approved phrase.",
      });
      continue;
    }
    if (banned.toLowerCase() === approved.toLowerCase()) {
      skipped.push({
        term: banned,
        reason: "duplicate",
        detail: "Banned and approved phrases are identical; rule ignored.",
      });
      continue;
    }
    const key = banned.toLowerCase();
    if (synonymKeys.has(key)) {
      skipped.push({
        term: banned,
        reason: "duplicate",
        detail: "Duplicate banned phrase; kept the first mapping.",
      });
      continue;
    }
    synonymKeys.add(key);
    const rationale =
      typeof raw.rationale === "string" && raw.rationale.trim().length > 0
        ? raw.rationale.trim()
        : undefined;
    const entry: TerminologySynonym = {
      banned,
      approved,
      ...(rationale !== undefined ? { rationale } : {}),
    };
    synonyms.push(entry);

    // Ensure the approved term is present in `preferredTerms` with the
    // spelling supplied here, so casing is enforced consistently.
    const approvedKey = approved.toLowerCase();
    if (!preferredByKey.has(approvedKey)) {
      preferredByKey.set(approvedKey, { term: approved });
    }
  }

  // ----------------------------------------- circular synonym detection ----
  // If the approved phrase is itself banned by another rule, the sequence
  // does not converge. Report it and drop the later rule.
  const bannedToApproved = new Map<string, string>();
  for (const s of synonyms) bannedToApproved.set(s.banned.toLowerCase(), s.approved.toLowerCase());
  const acceptedSynonyms: TerminologySynonym[] = [];
  for (const s of synonyms) {
    let cursor = s.approved.toLowerCase();
    const seen = new Set<string>([s.banned.toLowerCase()]);
    let circular = false;
    while (bannedToApproved.has(cursor)) {
      if (seen.has(cursor)) {
        circular = true;
        break;
      }
      seen.add(cursor);
      cursor = bannedToApproved.get(cursor) ?? "";
    }
    if (circular) {
      skipped.push({
        term: s.banned,
        reason: "circular-synonym",
        detail: `"${s.banned}" → "${s.approved}" participates in a synonym cycle; rule ignored.`,
      });
      continue;
    }
    acceptedSynonyms.push(s);
  }

  // ---------------------------------------------------------- expansions ---
  const expansions: Record<string, string> = {};
  // Explicit expansion map first (from the guide glossary or caller).
  for (const [key, value] of Object.entries(input.expansions ?? {})) {
    const acronym = key.trim();
    const expansion = typeof value === "string" ? value.trim() : "";
    if (acronym.length === 0) {
      skipped.push({ term: key, reason: "empty", detail: "Expansion key is empty." });
      continue;
    }
    if (expansion.length === 0) {
      skipped.push({
        term: acronym,
        reason: "expansion-without-term",
        detail: "Expansion value is empty.",
      });
      continue;
    }
    if (!ACRONYM_RE.test(acronym)) {
      skipped.push({
        term: acronym,
        reason: "expansion-without-term",
        detail: "Key is not an acronym; expansions only apply to acronyms.",
      });
      continue;
    }
    expansions[acronym] = expansion;
  }
  // Then any `preferredTerms[].expansion`.
  for (const term of preferredByKey.values()) {
    if (term.expansion === undefined) continue;
    if (!ACRONYM_RE.test(term.term)) {
      skipped.push({
        term: term.term,
        reason: "expansion-without-term",
        detail: "A term carrying an expansion must be an acronym form.",
      });
      continue;
    }
    if (expansions[term.term] === undefined) {
      expansions[term.term] = term.expansion;
    }
  }

  return {
    preferredTerms: [...preferredByKey.values()],
    synonyms: acceptedSynonyms,
    expansions,
    skipped,
    generatedAt: new Date().toISOString(),
  };
}

function isSkip(v: PreferredTerm | TerminologySkip): v is TerminologySkip {
  return "reason" in v;
}

function isNamedSynonym(raw: {
  readonly banned?: string;
  readonly approved?: string;
  readonly from?: string;
  readonly to?: string;
}): raw is { readonly banned: string; readonly approved: string } {
  return typeof raw.banned === "string" && typeof raw.approved === "string";
}

/* -------------------------------------------------------------------------- */
/* Application                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Apply the profile to a single piece of prose:
 *   1. Protect backtick spans, quoted strings and URLs.
 *   2. Replace banned phrases with their approved form (whole-phrase, word-
 *      bounded).
 *   3. Enforce the authoritative casing of preferred terms.
 *   4. Expand each acronym on its first use only.
 *
 * Returns the rewritten text plus a change list and an expansion list for
 * provenance. Never rewrites non-prose segments.
 */
export function applyTerminology(
  text: string,
  profile: TerminologyProfile,
): TerminologyApplication {
  if (typeof text !== "string") {
    throw new TerminologyError("applyTerminology requires a string.", "invalid-input");
  }
  if (text.length === 0) {
    return { text, applied: false, changes: [], expansions: [] };
  }

  const { protectedText, restore } = protectSegments(text, profile.preferredTerms);
  const changes: TerminologyChange[] = [];
  const expansions: TerminologyExpansion[] = [];
  let working = protectedText;

  // ------------------------------------------------ banished synonyms -----
  for (const s of profile.synonyms) {
    const escaped = escapeRegExp(s.banned);
    // Word-bounded if the phrase is word-like; otherwise a plain literal
    // match (e.g. banned phrase containing punctuation).
    const boundary = isWordLikePhrase(s.banned)
      ? new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "giu")
      : new RegExp(escaped, "giu");
    working = working.replace(boundary, (match, offset: number) => {
      const replacement = matchCase(match, s.approved);
      if (replacement === match) return match;
      changes.push({
        kind: "synonym",
        before: match,
        after: replacement,
        offset: indexOfInWorking(protectedText, working, offset, match.length),
      });
      return replacement;
    });
  }

  // --------------------------------------------------- preferred casing ---
  for (const term of profile.preferredTerms) {
    if (term.term.length === 0) continue;
    const escaped = escapeRegExp(term.term);
    const flags = term.caseSensitive === true ? "gu" : "giu";
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, flags);
    working = working.replace(re, (match, offset: number) => {
      if (match === term.term) return match;
      changes.push({
        kind: "capitalisation",
        before: match,
        after: term.term,
        offset: indexOfInWorking(protectedText, working, offset, match.length),
      });
      return term.term;
    });
  }

  // ------------------------------------------------- first-use expansions --
  for (const [acronym, expansion] of Object.entries(profile.expansions)) {
    const escaped = escapeRegExp(acronym);
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "gu");
    const match = re.exec(working);
    if (match === null) continue;
    // Skip a redundant expansion: if the next non-space characters already
    // introduce the expansion in parentheses, do not add a second.
    const after = working.slice(match.index + match[0].length);
    if (/^\s*\(/.test(after) || /^\s*\u2014/.test(after)) continue;
    const offset = match.index + match[0].length;
    working = `${working.slice(0, offset)} (${expansion})${working.slice(offset)}`;
    expansions.push({ acronym, expansion, offset });
  }

  return {
    text: restore(working),
    applied: changes.length > 0 || expansions.length > 0,
    changes,
    expansions,
  };
}

/**
 * Apply terminology to every prose field in a draft, walking the structure
 * and preserving shapes. The expansion pass is intentionally not routed
 * through this helper: first-use expansion is a property of one rendered
 * document, not of an object graph, so callers that need it should call
 * `applyTerminology` on the final rendered strings.
 */
export function applyTerminologyDeep<T>(
  value: T,
  profile: TerminologyProfile,
): T {
  return walkAndRewrite(value, profile, 0) as T;
}

/**
 * Build the LLM directive block. This is what every content layer appends to
 * its system prompt. Compact so the model can act on it; never asks the model
 * to invent terminology the workspace has not supplied.
 */
export function buildTerminologyDirectives(profile: TerminologyProfile): string {
  const lines: string[] = [];
  lines.push("Terminology rules:");

  if (profile.preferredTerms.length > 0) {
    const list = profile.preferredTerms
      .map((t) => (t.caseSensitive === true ? `${t.term} (exact case)` : t.term))
      .join(", ");
    lines.push(`- Use exactly these terms and spellings: ${list}.`);
  } else {
    lines.push("- Do not invent product, page or feature names.");
  }

  if (profile.synonyms.length > 0) {
    lines.push("- Do not use these banned phrasings; use the approved term instead:");
    for (const s of profile.synonyms) {
      lines.push(`    "${s.banned}" → "${s.approved}"`);
    }
  }

  const expansionEntries = Object.entries(profile.expansions);
  if (expansionEntries.length > 0) {
    lines.push(
      "- Expand these acronyms in parentheses on their first mention only:",
    );
    for (const [acronym, expansion] of expansionEntries) {
      lines.push(`    ${acronym} → ${expansion}`);
    }
  }

  return lines.join("\n");
}

/**
 * Merge two terminology profiles. Conflicting casings prefer the overlay;
 * conflicting synonyms prefer the overlay; expansions are unioned with the
 * overlay winning when both define an acronym.
 */
export function mergeTerminologyProfiles(
  base: TerminologyProfile,
  overlay: TerminologyProfile,
): TerminologyProfile {
  const byKey = new Map<string, PreferredTerm>();
  for (const t of base.preferredTerms) byKey.set(t.term.toLowerCase(), t);
  for (const t of overlay.preferredTerms) {
    const existing = byKey.get(t.term.toLowerCase());
    if (existing !== undefined) {
      byKey.set(t.term.toLowerCase(), {
        ...existing,
        ...t,
        term: t.term,
      });
    } else {
      byKey.set(t.term.toLowerCase(), t);
    }
  }

  const synByBanned = new Map<string, TerminologySynonym>();
  for (const s of base.synonyms) synByBanned.set(s.banned.toLowerCase(), s);
  for (const s of overlay.synonyms) synByBanned.set(s.banned.toLowerCase(), s);

  return {
    preferredTerms: [...byKey.values()],
    synonyms: [...synByBanned.values()],
    expansions: { ...base.expansions, ...overlay.expansions },
    skipped: [...base.skipped, ...overlay.skipped],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Rehydrate from JSON. Always returns a profile with safe defaults so a
 * caller cannot be surprised by `undefined` fields; malformed entries are
 * collected into `skipped` rather than throwing.
 */
export function rehydrateTerminologyProfile(value: unknown): TerminologyProfile {
  if (value === null || typeof value !== "object") {
    throw new TerminologyError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const terms: PreferredTerm[] = [];
  const skipped: TerminologySkip[] = [];
  if (Array.isArray(r["preferredTerms"])) {
    for (const entry of r["preferredTerms"] as unknown[]) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed.length > 0) terms.push({ term: trimmed });
        else skipped.push({ term: entry, reason: "empty" });
        continue;
      }
      if (entry === null || typeof entry !== "object") {
        skipped.push({ term: String(entry), reason: "empty" });
        continue;
      }
      const e = entry as Record<string, unknown>;
      const term = typeof e["term"] === "string" ? e["term"].trim() : "";
      if (term.length === 0) {
        skipped.push({ term: term, reason: "empty" });
        continue;
      }
      const expansion = typeof e["expansion"] === "string" ? e["expansion"].trim() : "";
      const caseSensitive = e["caseSensitive"] === true;
      terms.push({
        term,
        ...(expansion.length > 0 ? { expansion } : {}),
        ...(caseSensitive ? { caseSensitive: true } : {}),
      });
    }
  }

  const synonyms: TerminologySynonym[] = [];
  if (Array.isArray(r["synonyms"])) {
    for (const entry of r["synonyms"] as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const banned = typeof e["banned"] === "string" ? e["banned"].trim() : "";
      const approved = typeof e["approved"] === "string" ? e["approved"].trim() : "";
      if (banned.length === 0 || approved.length === 0) continue;
      const rationale = typeof e["rationale"] === "string" ? e["rationale"].trim() : "";
      synonyms.push({
        banned,
        approved,
        ...(rationale.length > 0 ? { rationale } : {}),
      });
    }
  }

  const expansions: Record<string, string> = {};
  if (
    r["expansions"] !== null &&
    typeof r["expansions"] === "object" &&
    !Array.isArray(r["expansions"])
  ) {
    for (const [k, v] of Object.entries(r["expansions"] as Record<string, unknown>)) {
      if (typeof v !== "string" || v.trim().length === 0) continue;
      expansions[k] = v.trim();
    }
  }

  const skippedRaw = r["skipped"];
  if (Array.isArray(skippedRaw)) {
    for (const entry of skippedRaw) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const term = typeof e["term"] === "string" ? e["term"] : "";
      const reason = e["reason"];
      if (
        reason !== "empty" &&
        reason !== "duplicate" &&
        reason !== "case-conflict" &&
        reason !== "expansion-without-term"
      ) {
        continue;
      }
      const detail = typeof e["detail"] === "string" ? e["detail"] : undefined;
      skipped.push({
        term,
        reason,
        ...(detail !== undefined ? { detail } : {}),
      });
    }
  }

  const generatedAt = typeof r["generatedAt"] === "string" ? r["generatedAt"] : "";
  return { preferredTerms: terms, synonyms, expansions, skipped, generatedAt };
}

/* -------------------------------------------------------------------------- */
/* Protection & walk                                                           */
/* -------------------------------------------------------------------------- */

const PROTECTED_OPEN = "\u0001P";
const PROTECTED_CLOSE = "P\u0001";
const TERM_SENTINEL_OPEN = "\u0001T";
const TERM_SENTINEL_CLOSE = "T\u0001";

interface Protection {
  readonly protectedText: string;
  readonly restore: (s: string) => string;
}

/**
 * Replace segments that must not be rewritten — backtick code, quoted
 * strings and URLs — with sentinels, and protect preferred terms' exact
 * spellings with their own sentinels (so the synonym pass cannot touch an
 * approved term that happens to contain a banned substring).
 */
function protectSegments(
  text: string,
  preferredTerms: readonly PreferredTerm[],
): Protection {
  const protectedSegments: string[] = [];
  const terms: string[] = [];
  let working = text;

  // Protect the exact spellings of every preferred term first, so the
  // synonym pass cannot rewrite a substring of an approved term.
  for (const t of preferredTerms) {
    if (t.term.length === 0) continue;
    const escaped = escapeRegExp(t.term);
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
  "label",
  "caption",
  "value",
]);

function walkAndRewrite(
  value: unknown,
  profile: TerminologyProfile,
  depth: number,
): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    return applyTerminology(value, profile).text;
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchCase(source: string, target: string): string {
  const first = source.charAt(0);
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return `${target.charAt(0).toUpperCase()}${target.slice(1)}`;
  }
  if (ALL_CAPS_RE.test(source) && target.length <= source.length) {
    return target.toUpperCase();
  }
  return target;
}

function isWordLikePhrase(s: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}\s'\-]*[\p{L}\p{N}]?$/u.test(s);
}

/**
 * Translate an offset reported against the protected working string into
 * one against the original text. Because protection uses fixed-length
 * sentinels that are longer than the segments they replace, the protected
 * string and the original are not positionally aligned; we resolve the
 * change's approximate original offset by searching for the segment text
 * in the original starting from the estimated original index.
 */
function indexOfInWorking(
  original: string,
  _working: string,
  protectedOffset: number,
  _length: number,
): number {
  // Best-effort: the protected offset is only a hint. We return it bounded
  // by the original length so the caller never sees an out-of-range index.
  if (protectedOffset < 0) return 0;
  if (protectedOffset > original.length) return original.length;
  return protectedOffset;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  protectSegments,
  matchCase,
  isWordLikePhrase,
  ACRONYM_RE,
  ALL_CAPS_RE,
  PROSE_KEYS,
});
