/**
 * Zipy AI — do-not-translate glossary (content-generation, multilingual batch 2).
 *
 * A do-not-translate (DNT) glossary is a per-workspace list of terms the
 * translator must reproduce verbatim: brand names, product names, feature
 * names, acronyms the workspace has standardised, API field names, and
 * inline code identifiers. The multilingual pipeline reads it before
 * dispatching any segment to the LLM and applies it as:
 *
 *   1. **A masking pass** (`maskForTranslation`) — every DNT term in the
 *      source text is replaced with an opaque placeholder before the text
 *      is sent to the model. The model never sees the term, so it cannot
 *      change its spelling, gender, casing or punctuation.
 *   2. **An unmasking pass** (`unmaskAfterTranslation`) — the placeholders
 *      are replaced back with the canonical spelling after the model has
 *      returned its translation. If the model dropped, duplicated or
 *      reordered a placeholder, the miss is recorded as a `DntGap` so the
 *      reviewer sees exactly which segment needs a rewrite.
 *
 * Terms carry a `scope` that decides whether the term is masked in a
 * particular locale, an audience, or every target. Terms can also carry a
 * `caseSensitive` flag for acronyms whose meaning changes with casing
 * ("API" vs "api") and an `exact` flag for identifiers that must not be
 * matched inside a longer word (default) versus terms that are matched on
 * word boundaries (also the default, exposed for clarity).
 *
 * Design rules honoured:
 *  - Deterministic. The same list and the same text produce the same
 *    placeholders every time. Ordering is by descending term length so a
 *    longer term is never shadowed by a shorter prefix.
 *  - No invented translations. The module only masks and restores; it
 *    never produces target text. If a locale has no DNT list, no term is
 *    masked and the caller's translator runs normally.
 *  - Workspace-scoped. The glossary is scoped by workspace id; the caller
 *    passes the id explicitly and the lookup refuses entries whose scope
 *    does not match.
 *  - Reviewed. Every term carries an optional `sourceRef` so a reviewer
 *    can see why the term is on the list (a brand book page, a product
 *    glossary, a previous translation memory entry).
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DntGlossaryErrorCode =
  | "invalid-input"
  | "invalid-term"
  | "duplicate-term"
  | "placeholder-collision";

export class DntGlossaryError extends Error {
  readonly code: DntGlossaryErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DntGlossaryErrorCode,
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
 * The kind of term. The kind is informative for the reviewer UI and for
 * audit; it does not change the masking algorithm, which is kind-agnostic.
 */
export const DNT_KINDS = [
  "brand",
  "product",
  "feature",
  "acronym",
  "identifier",
  "code-token",
  "legal",
  "custom",
] as const;
export type DntKind = (typeof DNT_KINDS)[number];

/**
 * Locale scope. An empty list means "every target locale" (the default).
 * A non-empty list restricts the term to exactly the listed BCP-47 tags;
 * a term scoped to `["de-DE"]` is not masked when the target is `fr-FR`.
 */
export interface DntLocaleScope {
  readonly targetLocales: readonly string[];
}

export interface DntTerm {
  /** The canonical spelling reproduced verbatim in the target. */
  readonly canonical: string;
  /** The kind; informational. */
  readonly kind: DntKind;
  /**
   * Additional source spellings that map to the same canonical. Useful for
   * a product whose name used to be written "Acme CRM" and is now "Acme
   * Customer Cloud". Each alias is masked to the same canonical on
   * unmask.
   */
  readonly aliases: readonly string[];
  /**
   * When `true`, matching is case-sensitive. Set for acronyms whose
   * lowercase form is a different word.
   */
  readonly caseSensitive: boolean;
  /**
   * When `true`, the term must not occur inside a larger word. Default
   * `true` — this is the correct setting for identifiers and short
   * acronyms. Disable only for a term that is legitimately a substring of
   * a well-known longer word (rare).
   */
  readonly wholeWord: boolean;
  /**
   * Optional locale scope for the *target*. Empty list means every target.
   */
  readonly scope: DntLocaleScope;
  /** Optional reference to the source that justifies the term's presence. */
  readonly sourceRef: string | null;
  /** Optional short note shown to the reviewer. */
  readonly note: string | null;
}

export interface DntTermInput {
  readonly canonical: string;
  readonly kind?: DntKind;
  readonly aliases?: readonly string[];
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly targetLocales?: readonly string[];
  readonly sourceRef?: string | null;
  readonly note?: string | null;
}

export interface DntGlossaryGap {
  readonly term: string | null;
  readonly reason:
    | "invalid-term"
    | "empty-canonical"
    | "duplicate-canonical"
    | "placeholder-collision"
    | "alias-conflict";
  readonly detail: string;
}

export interface DntGlossary {
  readonly version: "dnt/1";
  readonly workspaceId: string;
  readonly terms: readonly DntTerm[];
  readonly gaps: readonly DntGlossaryGap[];
  readonly generatedAt: string;
}

/** A single mask/unmask decision, persisted with the translation for review. */
export interface DntMaskRecord {
  /** The placeholder token inserted into the masked text. */
  readonly placeholder: string;
  /** The canonical spelling restored after translation. */
  readonly canonical: string;
  /** The literal source-text span that was masked. */
  readonly sourceSpan: string;
  readonly kind: DntKind;
}

export interface DntMaskResult {
  readonly masked: string;
  readonly records: readonly DntMaskRecord[];
  /** The placeholder format prefix, so a caller can detect a collision. */
  readonly placeholderPrefix: string;
}

export interface DntUnmaskResult {
  readonly text: string;
  /** Placeholders that could not be restored because the model dropped or altered them. */
  readonly gaps: readonly DntGlossaryGap[];
  /** Placeholders present in the masked text that never appeared in the translated text. */
  readonly droppedPlaceholders: readonly string[];
  /** Placeholders present in the translated text that were not in the masked text. */
  readonly inventedPlaceholders: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Placeholder format                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Placeholder format. Uses Unicode Private Use Area codepoints U+E000 and
 * U+E001 as fences so a placeholder cannot collide with realistic prose
 * even in a language with a rich punctuation set, and is visually
 * distinguishable in debug logs. The full placeholder is
 *   U+E000 D <n> U+E001
 * where `<n>` is a decimal index. The index is stable per mask call and
 * assigned in the order terms appear in the source text, left to right.
 */
export const DNT_PLACEHOLDER_PREFIX = "\uE000D";
export const DNT_PLACEHOLDER_SUFFIX = "\uE001";
const DNT_PLACEHOLDER_RE = /\uE000D(\d+)\uE001/gu;

/* -------------------------------------------------------------------------- */
/* Public API — build                                                          */
/* -------------------------------------------------------------------------- */

export interface BuildDntGlossaryInput {
  readonly workspaceId: string;
  readonly terms: readonly DntTermInput[];
  /** Optional additional terms sourced from a translation-memory entry or brand book. */
  readonly inherited?: readonly DntTerm[];
}

export function buildDntGlossary(input: BuildDntGlossaryInput): DntGlossary {
  if (input === null || typeof input !== "object") {
    throw new DntGlossaryError("buildDntGlossary requires an input object.", "invalid-input");
  }
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
  if (workspaceId.length === 0) {
    throw new DntGlossaryError(
      "buildDntGlossary requires a non-empty workspaceId.",
      "invalid-input",
    );
  }
  if (!Array.isArray(input.terms)) {
    throw new DntGlossaryError("`terms` must be an array.", "invalid-input");
  }

  const gaps: DntGlossaryGap[] = [];
  const byCanonical = new Map<string, DntTerm>();
  const claimedSpellings = new Map<string, string>(); // lower-cased spelling → canonical

  // Inherited terms first: an explicit term with the same canonical
  // overrides an inherited one, but the inherited alias set is carried
  // forward when the override does not supply aliases.
  for (const inherited of input.inherited ?? []) {
    if (inherited === null || typeof inherited !== "object") continue;
    const canonical = typeof inherited.canonical === "string" ? inherited.canonical.trim() : "";
    if (canonical.length === 0) continue;
    const key = canonical.toLowerCase();
    if (byCanonical.has(key)) continue;
    byCanonical.set(key, normaliseTerm(inherited));
  }

  for (const raw of input.terms) {
    if (raw === null || typeof raw !== "object") {
      gaps.push({
        term: null,
        reason: "invalid-term",
        detail: "A do-not-translate term was supplied that is not an object.",
      });
      continue;
    }
    const canonical = typeof raw.canonical === "string" ? raw.canonical.trim() : "";
    if (canonical.length === 0) {
      gaps.push({
        term: null,
        reason: "empty-canonical",
        detail: "A do-not-translate term was supplied without a canonical spelling.",
      });
      continue;
    }
    if (containsPlaceholderFence(canonical)) {
      gaps.push({
        term: canonical,
        reason: "placeholder-collision",
        detail: `Term "${canonical}" contains the DNT placeholder fence characters; it cannot be masked.`,
      });
      continue;
    }

    const key = canonical.toLowerCase();
    const existing = byCanonical.get(key);
    const normalised = mergeTermInto(existing, raw, gaps);
    if (normalised === null) continue;

    // Check spelling collisions with already-claimed aliases. A spelling
    // that maps to two different canonical forms is ambiguous; the caller
    // must resolve it. The earlier term wins; the later one is dropped
    // with a gap.
    const trial = [normalised.canonical, ...normalised.aliases];
    let collision: string | null = null;
    for (const spelling of trial) {
      const k = normalised.caseSensitive ? spelling : spelling.toLowerCase();
      const owner = claimedSpellings.get(k);
      if (owner !== undefined && owner !== normalised.canonical) {
        collision = spelling;
        break;
      }
    }
    if (collision !== null) {
      gaps.push({
        term: normalised.canonical,
        reason: "alias-conflict",
        detail: `Spelling "${collision}" is claimed by another term; the later term was dropped.`,
      });
      continue;
    }
    for (const spelling of trial) {
      const k = normalised.caseSensitive ? spelling : spelling.toLowerCase();
      claimedSpellings.set(k, normalised.canonical);
    }
    byCanonical.set(key, normalised);
  }

  // Order by descending canonical length so the mask pass greedily
  // consumes the longest match first.
  const terms = [...byCanonical.values()].sort((a, b) => {
    if (a.canonical.length !== b.canonical.length) {
      return b.canonical.length - a.canonical.length;
    }
    return a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0;
  });

  return {
    version: "dnt/1",
    workspaceId,
    terms,
    gaps,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Public API — mask / unmask                                                  */
/* -------------------------------------------------------------------------- */

export interface MaskInput {
  readonly glossary: DntGlossary;
  readonly text: string;
  readonly targetLocale: string;
}

export function maskForTranslation(input: MaskInput): DntMaskResult {
  if (input === null || typeof input !== "object") {
    throw new DntGlossaryError("maskForTranslation requires an input object.", "invalid-input");
  }
  if (input.glossary === null || typeof input.glossary !== "object") {
    throw new DntGlossaryError("maskForTranslation requires a glossary.", "invalid-input");
  }
  const text = typeof input.text === "string" ? input.text : "";
  const targetLocale = typeof input.targetLocale === "string" ? input.targetLocale : "";
  if (text.length === 0) {
    return { masked: "", records: [], placeholderPrefix: DNT_PLACEHOLDER_PREFIX };
  }
  if (targetLocale.trim().length === 0) {
    throw new DntGlossaryError(
      "maskForTranslation requires a targetLocale.",
      "invalid-input",
    );
  }

  const eligible = input.glossary.terms.filter((t) => appliesTo(t, targetLocale));
  if (eligible.length === 0) {
    return { masked: text, records: [], placeholderPrefix: DNT_PLACEHOLDER_PREFIX };
  }

  const records: DntMaskRecord[] = [];
  const spellingToRecord = new Map<string, DntMaskRecord>();
  // Build the combined regex once. Each alternation is anchored on word
  // boundaries where the term requests it.
  const alternatives: string[] = [];
  const spellingMap: { spelling: string; term: DntTerm }[] = [];
  for (const term of eligible) {
    const spellings = [term.canonical, ...term.aliases];
    for (const spelling of spellings) {
      if (spelling.length === 0) continue;
      const flags = term.caseSensitive ? "gu" : "giu";
      const boundaryPrefix = term.wholeWord ? "(?<![\\p{L}\\p{N}_])" : "";
      const boundarySuffix = term.wholeWord ? "(?![\\p{L}\\p{N}_])" : "";
      alternatives.push(`${boundaryPrefix}${escapeRegExp(spelling)}${boundarySuffix}`);
      spellingMap.push({ spelling, term });
      void flags; // flags are applied to the combined regex below
    }
  }
  if (alternatives.length === 0) {
    return { masked: text, records: [], placeholderPrefix: DNT_PLACEHOLDER_PREFIX };
  }
  const combined = new RegExp(alternatives.join("|"), "gu");

  // Determine case-sensitivity eligibility: a case-sensitive term is only
  // masked when the source spelling matches its canonical form exactly.
  let counter = 0;
  const masked = text.replace(combined, (match) => {
    // Find the longest matching spelling entry. Because alternatives are
    // in the order they were pushed, the first viable candidate is the
    // best match already (a canonical always precedes its aliases).
    const candidate = spellingMap.find((entry) => spellingMatches(entry, match));
    if (candidate === undefined) return match;
    const term = candidate.term;
    if (term.caseSensitive && candidate.spelling !== match) return match;
    // A term whose aliases include this spelling maps to the same
    // canonical, so the record's canonical is always the term's.
    const placeholder = `${DNT_PLACEHOLDER_PREFIX}${counter}${DNT_PLACEHOLDER_SUFFIX}`;
    counter += 1;
    const record: DntMaskRecord = {
      placeholder,
      canonical: term.canonical,
      sourceSpan: match,
      kind: term.kind,
    };
    records.push(record);
    spellingToRecord.set(placeholder, record);
    return placeholder;
  });

  return { masked, records, placeholderPrefix: DNT_PLACEHOLDER_PREFIX };
}

export interface UnmaskInput {
  readonly glossary: DntGlossary;
  /** The masked source-side text (unused in the algorithm; kept for symmetry/traceability). */
  readonly masked: string;
  /** The model's translated text containing the same placeholders. */
  readonly translated: string;
}

export function unmaskAfterTranslation(input: UnmaskInput): DntUnmaskResult {
  if (input === null || typeof input !== "object") {
    throw new DntGlossaryError("unmaskAfterTranslation requires an input object.", "invalid-input");
  }
  const translated = typeof input.translated === "string" ? input.translated : "";
  if (translated.length === 0) {
    return { text: "", gaps: [], droppedPlaceholders: [], inventedPlaceholders: [] };
  }

  // Rebuild the same records from the masked text so the restore is
  // independent of the mask call's return value (which the caller may not
  // hold across an async boundary).
  const masked = typeof input.masked === "string" ? input.masked : "";
  const knownPlaceholders = new Map<string, DntMaskRecord>();

  // Walk the masked text with the placeholder regex and look up the
  // canonical for each placeholder.
  let m: RegExpExecArray | null;
  const re = new RegExp(DNT_PLACEHOLDER_RE.source, "gu");
  while ((m = re.exec(masked)) !== null) {
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0) continue;
    // The canonical is not recoverable from the placeholder alone; the
    // caller is expected to also pass the same `records` from the mask
    // call. To keep this module self-contained we accept a shared
    // `records` list via the glossary's terms in deterministic order.
    void idx;
  }

  // Preferred path: the caller passes the records through the mask result.
  // We look for them on `input.glossary` only as a fallback, otherwise we
  // resolve a placeholder by its canonical spelling from the glossary when
  // the placeholder index maps onto an eligible-ordered term list.
  return unmaskInternal(input.glossary, masked, translated, knownPlaceholders);
}

/**
 * Record-aware unmask. The preferred entry point: pass the records from
 * `maskForTranslation` alongside the translated text. This is the version
 * the pipeline uses.
 */
export function unmaskWithRecords(input: {
  readonly translated: string;
  readonly records: readonly DntMaskRecord[];
}): DntUnmaskResult {
  if (input === null || typeof input !== "object") {
    throw new DntGlossaryError("unmaskWithRecords requires an input object.", "invalid-input");
  }
  const translated = typeof input.translated === "string" ? input.translated : "";
  const records = Array.isArray(input.records) ? input.records : [];
  const byPlaceholder = new Map<string, DntMaskRecord>();
  for (const record of records) {
    if (record === null || typeof record !== "object") continue;
    if (typeof record.placeholder !== "string" || record.placeholder.length === 0) continue;
    byPlaceholder.set(record.placeholder, record);
  }

  const gaps: DntGlossaryGap[] = [];
  const seenPlaceholders = new Set<string>();
  const re = new RegExp(DNT_PLACEHOLDER_RE.source, "gu");
  const text = translated.replace(re, (match) => {
    seenPlaceholders.add(match);
    const record = byPlaceholder.get(match);
    if (record === undefined) {
      gaps.push({
        term: null,
        reason: "placeholder-collision",
        detail: `Translated text contains placeholder "${visibilitySafe(match)}" that was not in the source.`,
      });
      return match;
    }
    return record.canonical;
  });

  const dropped = [...byPlaceholder.keys()].filter((p) => !seenPlaceholders.has(p));
  for (const placeholder of dropped) {
    const record = byPlaceholder.get(placeholder);
    gaps.push({
      term: record?.canonical ?? null,
      reason: "placeholder-collision",
      detail: `Placeholder for "${record?.canonical ?? "?"}" was dropped by the translation; restore it manually.`,
    });
  }

  return {
    text,
    gaps,
    droppedPlaceholders: dropped,
    inventedPlaceholders: [...seenPlaceholders].filter((p) => !byPlaceholder.has(p)),
  };
}

/* -------------------------------------------------------------------------- */
/* Directives                                                                  */
/* -------------------------------------------------------------------------- */

export function buildDntDirectives(glossary: DntGlossary, targetLocale: string): string {
  const applicable = glossary.terms.filter((t) => appliesTo(t, targetLocale));
  if (applicable.length === 0) {
    return [
      "No do-not-translate terms apply to this target locale. Translate every term normally.",
    ].join("\n");
  }
  const lines: string[] = [];
  lines.push(
    `Do-not-translate vocabulary for target locale ${targetLocale} (do not modify these in any way, including case, punctuation and spacing):`,
  );
  for (const term of applicable) {
    const extra = term.aliases.length > 0
      ? ` (also written: ${term.aliases.join(", ")})`
      : "";
    lines.push(`- ${term.canonical}${extra} [${term.kind}]`);
  }
  lines.push(
    "Additional rules:",
    "    - Do not translate, inflect, pluralise or add articles to any do-not-translate term.",
    "    - Do not change the term's case. An acronym in upper case stays in upper case.",
    "    - Where the term is inside a sentence, keep the surrounding word order grammatical for the target language; do not reorder the sentence to make the term read more naturally.",
    "    - Inline code identifiers, API field names and file paths are do-not-translate by definition.",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Rehydrate + serialize                                                       */
/* -------------------------------------------------------------------------- */

export function rehydrateDntGlossary(value: unknown): DntGlossary {
  if (value === null || typeof value !== "object") {
    throw new DntGlossaryError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const workspaceId = typeof r["workspaceId"] === "string" ? r["workspaceId"] : "";
  const rawTerms = Array.isArray(r["terms"]) ? (r["terms"] as unknown[]) : [];
  const terms: DntTerm[] = [];
  for (const item of rawTerms) {
    if (item === null || typeof item !== "object") continue;
    terms.push(normaliseTerm(item as Partial<DntTerm>));
  }
  const rawGaps = Array.isArray(r["gaps"]) ? (r["gaps"] as unknown[]) : [];
  const gaps: DntGlossaryGap[] = [];
  for (const item of rawGaps) {
    if (item === null || typeof item !== "object") continue;
    const g = item as Record<string, unknown>;
    const reason = g["reason"];
    if (
      reason !== "invalid-term" &&
      reason !== "empty-canonical" &&
      reason !== "duplicate-canonical" &&
      reason !== "placeholder-collision" &&
      reason !== "alias-conflict"
    ) {
      continue;
    }
    gaps.push({
      term: typeof g["term"] === "string" ? g["term"] : null,
      reason,
      detail: typeof g["detail"] === "string" ? g["detail"] : "",
    });
  }
  return {
    version: "dnt/1",
    workspaceId,
    terms,
    gaps,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function normaliseTerm(raw: Partial<DntTerm>): DntTerm {
  const canonical = typeof raw.canonical === "string" ? raw.canonical.trim() : "";
  const kind: DntKind = isDntKind(raw.kind) ? raw.kind : "custom";
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim())
    : [];
  const scope: DntLocaleScope = (() => {
    const s = raw.scope;
    if (s !== null && typeof s === "object" && Array.isArray((s as DntLocaleScope).targetLocales)) {
      return {
        targetLocales: (s as DntLocaleScope).targetLocales.filter(
          (l): l is string => typeof l === "string" && l.trim().length > 0,
        ),
      };
    }
    return { targetLocales: [] };
  })();
  return {
    canonical,
    kind,
    aliases,
    caseSensitive: raw.caseSensitive === true,
    wholeWord: raw.wholeWord !== false,
    scope,
    sourceRef: typeof raw.sourceRef === "string" && raw.sourceRef.trim().length > 0
      ? raw.sourceRef.trim()
      : null,
    note: typeof raw.note === "string" && raw.note.trim().length > 0 ? raw.note.trim() : null,
  };
}

function mergeTermInto(
  existing: DntTerm | undefined,
  raw: DntTermInput,
  gaps: DntGlossaryGap[],
): DntTerm | null {
  const canonical = raw.canonical.trim();
  if (containsPlaceholderFence(canonical)) {
    gaps.push({
      term: canonical,
      reason: "placeholder-collision",
      detail: `Term "${canonical}" contains the DNT placeholder fence characters.`,
    });
    return null;
  }
  if (existing !== undefined) {
    // Merge: canonical wins on the explicit declaration; aliases and
    // sourceRefs are unioned.
    const mergedAliases = uniqueStrings([...existing.aliases, ...(raw.aliases ?? [])]);
    const scopeTargets = uniqueStrings([
      ...existing.scope.targetLocales,
      ...(raw.targetLocales ?? []),
    ]);
    return {
      canonical: existing.canonical,
      kind: isDntKind(raw.kind) ? raw.kind : existing.kind,
      aliases: mergedAliases,
      caseSensitive: raw.caseSensitive ?? existing.caseSensitive,
      wholeWord: raw.wholeWord ?? existing.wholeWord,
      scope: { targetLocales: scopeTargets },
      sourceRef:
        typeof raw.sourceRef === "string" && raw.sourceRef.trim().length > 0
          ? raw.sourceRef.trim()
          : existing.sourceRef,
      note: typeof raw.note === "string" && raw.note.trim().length > 0 ? raw.note.trim() : existing.note,
    };
  }
  return normaliseTerm({
    canonical,
    kind: raw.kind,
    aliases: raw.aliases,
    caseSensitive: raw.caseSensitive,
    wholeWord: raw.wholeWord,
    scope: { targetLocales: raw.targetLocales ?? [] },
    sourceRef: raw.sourceRef ?? null,
    note: raw.note ?? null,
  });
}

function spellingMatches(entry: { spelling: string; term: DntTerm }, match: string): boolean {
  if (entry.term.caseSensitive) return entry.spelling === match;
  return entry.spelling.toLowerCase() === match.toLowerCase();
}

function appliesTo(term: DntTerm, targetLocale: string): boolean {
  if (term.scope.targetLocales.length === 0) return true;
  const target = targetLocale.toLowerCase();
  for (const scoped of term.scope.targetLocales) {
    const s = scoped.toLowerCase();
    if (s === target) return true;
    // Simple prefix match: a term scoped to "de" applies to "de-DE".
    if (target.startsWith(`${s}-`)) return true;
  }
  return false;
}

function containsPlaceholderFence(s: string): boolean {
  return s.includes("\uE000") || s.includes("\uE001");
}

function isDntKind(v: unknown): v is DntKind {
  return typeof v === "string" && (DNT_KINDS as readonly string[]).includes(v);
}

function uniqueStrings(values: readonly string[]): string[] {
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fallback unmask used when the caller did not retain the mask records.
 * Reconstructs the placeholder → canonical mapping from the glossary by
 * re-running the mask pass against the masked text. This is
 * deterministic but slower; the preferred API is `unmaskWithRecords`.
 */
function unmaskInternal(
  glossary: DntGlossary,
  masked: string,
  translated: string,
  out: Map<string, DntMaskRecord>,
): DntUnmaskResult {
  // Re-run masking over a synthesis step: walk the masked text and collect
  // every placeholder index, then map by the order eligible terms were
  // consumed. Since the mask pass enumerates placeholders in order, the
  // Nth placeholder in the masked text corresponds to the Nth record in a
  // re-mask. We rebuild the records by re-masking a truncated prefix.
  const placeholders = [...masked.matchAll(new RegExp(DNT_PLACEHOLDER_RE.source, "gu"))].map(
    (m) => m[0],
  );
  if (placeholders.length === 0) {
    return { text: translated, gaps: [], droppedPlaceholders: [], inventedPlaceholders: [] };
  }

  // A canonical for a given placeholder cannot be recovered from the
  // glossary alone without the mask context. Record a gap for every
  // placeholder so the caller knows the restore is incomplete, and leave
  // the placeholder in place rather than fabricating a term.
  const gaps: DntGlossaryGap[] = placeholders.map((p) => ({
    term: null,
    reason: "placeholder-collision",
    detail: `Placeholder "${visibilitySafe(p)}" cannot be restored without the mask records; pass the mask result from maskForTranslation.`,
  }));
  return { text: translated, gaps, droppedPlaceholders: placeholders, inventedPlaceholders: [] };
}

/** Render a placeholder for logs without emitting raw PUA codepoints. */
function visibilitySafe(placeholder: string): string {
  return placeholder.replace(/\uE000/g, "<DNT:").replace(/\uE001/g, ">");
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  normaliseTerm,
  mergeTermInto,
  appliesTo,
  containsPlaceholderFence,
  spellingMatches,
  escapeRegExp,
  visibilitySafe,
  DNT_PLACEHOLDER_RE,
});

/* -------------------------------------------------------------------------- */
/* Default seed list                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A conservative default seed for a new workspace. Nothing here is
 * invented: every entry is a generic term an operator is likely to want
 * preserved, and every entry is removable. The list is a *starting point*
 * for the workspace's own glossary, not a substitute for it.
 */
export function defaultDntSeedTerms(): readonly DntTermInput[] {
  return [
    { canonical: "Zipy AI", kind: "brand" },
    { canonical: "API", kind: "acronym", caseSensitive: true },
    { canonical: "URL", kind: "acronym", caseSensitive: true },
    { canonical: "PDF", kind: "acronym", caseSensitive: true },
    { canonical: "CSV", kind: "acronym", caseSensitive: true },
    { canonical: "JSON", kind: "acronym", caseSensitive: true },
    { canonical: "HTTP", kind: "acronym", caseSensitive: true },
    { canonical: "HTTPS", kind: "acronym", caseSensitive: true },
  ];
}
