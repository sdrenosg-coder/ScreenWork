/**
 * Zipy AI — translation memory (content-generation, multilingual batch 1).
 *
 * A translation memory (TM) is a per-workspace store of previously
 * translated segments. The rest of the multilingual pipeline reads from it
 * first, so a segment translated once is not re-translated (and, crucially,
 * is not re-translated *differently*, which is what erodes consistency
 * across a long guide).
 *
 * A "segment" is a single short unit of prose — one step instruction, one
 * tip, one FAQ question — identified by a stable key (`segmentKey`) that
 * the caller derives from the content structure. Two stores are modelled
 * here:
 *
 *   1. **Exact memory** — `segmentKey + targetLocale` maps to the last
 *      approved translation. Exact-key lookups are inexpensive and are the
 *      preferred path.
 *   2. **Fuzzy memory** — when the exact source text has changed slightly
 *      (typo fix, minor rephrasing) but the segmentKey is stable, the TM
 *      can offer the previous translation with a similarity score below 1
 *      so the caller can decide whether to reuse it or re-translate. Fuzzy
 *      matching is *advisory*; it never silently substitutes a translation
 *      the caller has not opted into.
 *
 * The store is an in-memory index by default; the caller persists the
 * exported `TranslationMemorySnapshot` (JSON) to whatever backing store
 * the platform uses. This module never touches the network.
 *
 * Design rules honoured:
 *  - No invented translations. The TM only returns translations a caller
 *    previously stored; a miss returns `null`, not a placeholder.
 *  - Deterministic: the similarity score is a fixed, documented formula
 *    (a small, locale-independent token Jaccard with a character-substring
 *    tiebreak). No model is called.
 *  - The store is *scoped*. Every entry carries a `workspaceId` and the
 *    store refuses to return an entry whose workspace does not match the
 *    caller's, so a translation in one workspace cannot leak into another.
 *  - Approval status is explicit. An entry is `approved`, `draft`, or
 *    `rejected`; only `approved` entries are returned by default. A caller
 *    that wants a draft can pass `includeDrafts: true`.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TranslationMemoryErrorCode =
  | "invalid-input"
  | "workspace-mismatch"
  | "empty-segment";

export class TranslationMemoryError extends Error {
  readonly code: TranslationMemoryErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TranslationMemoryErrorCode,
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

export const TM_ENTRY_STATUSES = ["approved", "draft", "rejected"] as const;
export type TranslationMemoryEntryStatus = (typeof TM_ENTRY_STATUSES)[number];

export interface TranslationMemoryEntry {
  /** Workspace scope. Lookups never cross workspaces. */
  readonly workspaceId: string;
  /** Stable segment key. See `makeSegmentKey`. */
  readonly segmentKey: string;
  /** Source locale BCP-47 tag, e.g. `en-US`. */
  readonly sourceLocale: string;
  /** Target locale BCP-47 tag, e.g. `fr-FR`. */
  readonly targetLocale: string;
  /** The source text at the time the translation was approved. */
  readonly sourceText: string;
  /** The translated text. Never empty for an accepted entry. */
  readonly targetText: string;
  readonly status: TranslationMemoryEntryStatus;
  /** ISO timestamp of the last write. */
  readonly updatedAt: string;
  /** Optional reviewer identity who approved the translation. */
  readonly approvedBy: string | null;
  /** Optional lifecycle label (e.g. "ui-string", "guide:abc:step:3"). */
  readonly domain: string | null;
}

/**
 * A persisted snapshot of the memory. This is what the caller writes to
 * object storage (or a DB table) between requests. The index is rebuilt on
 * load; no ranking state is persisted so a formula change is not
 * incompatible with existing snapshots.
 */
export interface TranslationMemorySnapshot {
  readonly version: "tm/1";
  readonly entries: readonly TranslationMemoryEntry[];
  /** ISO timestamp of the snapshot, best-effort. */
  readonly generatedAt: string;
}

export type LookupOutcome = "exact" | "fuzzy" | "miss";

export interface LookupResult {
  readonly outcome: LookupOutcome;
  /** The entry when `outcome` is `"exact"` or `"fuzzy"`; `null` on a miss. */
  readonly entry: TranslationMemoryEntry | null;
  /**
   * Similarity score in the range [0, 1]. `1` for an exact source-text
   * match; lower for fuzzy. `0` on a miss.
   */
  readonly score: number;
  /**
   * The caller-visible reason for the result. Matches the shape of the
   * reasons used elsewhere in the platform so the review UI can display
   * it uniformly.
   */
  readonly reason: string;
}

export interface LookupInput {
  readonly workspaceId: string;
  readonly segmentKey: string;
  readonly sourceLocale: string;
  readonly targetLocale: string;
  /** The source text as the writer is producing it now. */
  readonly sourceText: string;
  /**
   * When `true`, a `draft` entry is returned as an exact match. Defaults
   * to `false` — only `approved` entries are considered a match.
   */
  readonly includeDrafts?: boolean;
  /**
   * A fuzzy match is returned only when the similarity score meets this
   * threshold. Defaults to `0.6` (roughly two out of three tokens shared).
   */
  readonly fuzzyThreshold?: number;
}

export interface StoreInput {
  readonly workspaceId: string;
  readonly entry: Omit<TranslationMemoryEntry, "workspaceId" | "updatedAt"> & {
    readonly updatedAt?: string;
  };
}

export interface ListInput {
  readonly workspaceId: string;
  readonly sourceLocale?: string;
  readonly targetLocale?: string;
  readonly includeDrafts?: boolean;
}

/**
 * Aggregate counters a caller can show in the review UI: how much of the
 * draft was served from the TM (cost saved) versus freshly translated.
 */
export interface TranslationMemoryStats {
  readonly entries: number;
  readonly approved: number;
  readonly drafts: number;
  readonly rejected: number;
  /** Per-target-locale counts, only `approved`. */
  readonly byTargetLocale: Readonly<Record<string, number>>;
}

/* -------------------------------------------------------------------------- */
/* Segment key helper                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build a stable segment key from a guide id and a content coordinate. The
 * shape is documented so different producers (writer, editor, regression
 * bot) agree on the same id for the same logical segment. Callers may
 * supply their own keys; this helper exists so the default is stable.
 */
export function makeSegmentKey(input: {
  readonly guideId: string;
  readonly kind: "title" | "summary" | "introduction" | "step" | "tip" | "warning" | "question" | "answer" | "section" | "custom";
  /** For `step`/`section` the numeric index; for `question`/`answer` the question index. */
  readonly index?: number;
  /** For `custom` a short identifier the caller chooses. */
  readonly custom?: string;
}): string {
  if (input === null || typeof input !== "object") {
    throw new TranslationMemoryError("makeSegmentKey requires an input object.", "invalid-input");
  }
  const guideId = String(input.guideId ?? "").trim();
  if (guideId.length === 0) {
    throw new TranslationMemoryError("makeSegmentKey requires a non-empty guideId.", "invalid-input");
  }
  if (input.kind === "custom") {
    const c = String(input.custom ?? "").trim();
    if (c.length === 0) {
      throw new TranslationMemoryError("makeSegmentKey with kind=custom requires a non-empty custom id.", "invalid-input");
    }
    return `${guideId}:${input.kind}:${c}`;
  }
  if (input.kind === "title" || input.kind === "summary" || input.kind === "introduction") {
    return `${guideId}:${input.kind}`;
  }
  const index = input.index;
  if (typeof index !== "number" || !Number.isFinite(index) || index < 1) {
    throw new TranslationMemoryError(
      `makeSegmentKey with kind=${input.kind} requires a positive 1-based index.`,
      "invalid-input",
    );
  }
  return `${guideId}:${input.kind}:${Math.trunc(index)}`;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The in-memory store. Construct one per process and share it across
 * requests; the caller serialises it with `snapshot()` and restores it with
 * `fromSnapshot()`.
 */
export class TranslationMemoryStore {
  /** `workspaceId \u0001 sourceLocale \u0001 targetLocale \u0001 segmentKey` → entry */
  private readonly byKey: Map<string, TranslationMemoryEntry> = new Map();
  /**
   * `workspaceId \u0001 sourceLocale \u0001 targetLocale` → list of
   * entries. Used by the fuzzy lookup; the list is kept short (a few
   * hundred entries per locale) because the TM is looked up at write time
   * on a hot path.
   */
  private readonly byScope: Map<string, TranslationMemoryEntry[]> = new Map();

  static fromSnapshot(snapshot: TranslationMemorySnapshot): TranslationMemoryStore {
    const store = new TranslationMemoryStore();
    for (const entry of snapshot.entries) {
      try {
        store.put(entry);
      } catch {
        // A malformed row is skipped; the caller can log it. We do not
        // throw here so a single bad row cannot make the guide unopenable.
      }
    }
    return store;
  }

  /**
   * Insert or replace an entry. When a previous entry with the same key
   * exists, the newer `updatedAt` wins; equal timestamps keep the
   * existing entry so a re-import is idempotent.
   */
  put(entry: TranslationMemoryEntry): TranslationMemoryEntry {
    if (entry === null || typeof entry !== "object") {
      throw new TranslationMemoryError("put requires an entry object.", "invalid-input");
    }
    if (typeof entry.workspaceId !== "string" || entry.workspaceId.trim().length === 0) {
      throw new TranslationMemoryError("Entry is missing `workspaceId`.", "invalid-input");
    }
    const key = scopeKey(entry.workspaceId, entry.sourceLocale, entry.targetLocale) + "\u0001" + entry.segmentKey;
    const existing = this.byKey.get(key);
    if (existing !== undefined && existing.updatedAt >= entry.updatedAt) {
      return existing;
    }
    const normalised: TranslationMemoryEntry = {
      workspaceId: entry.workspaceId,
      segmentKey: entry.segmentKey,
      sourceLocale: entry.sourceLocale,
      targetLocale: entry.targetLocale,
      sourceText: entry.sourceText,
      targetText: entry.targetText,
      status: entry.status,
      updatedAt: entry.updatedAt,
      approvedBy: entry.approvedBy ?? null,
      domain: entry.domain ?? null,
    };
    this.byKey.set(key, normalised);

    const scope = scopeKey(entry.workspaceId, entry.sourceLocale, entry.targetLocale);
    const list = this.byScope.get(scope);
    if (list === undefined) {
      this.byScope.set(scope, [normalised]);
    } else {
      const idx = list.findIndex((e) => e.segmentKey === normalised.segmentKey);
      if (idx >= 0) list[idx] = normalised;
      else list.push(normalised);
    }
    return normalised;
  }

  /** Remove an entry by workspace + key. Returns `true` if a row was removed. */
  remove(input: {
    readonly workspaceId: string;
    readonly segmentKey: string;
    readonly sourceLocale: string;
    readonly targetLocale: string;
  }): boolean {
    const key = scopeKey(input.workspaceId, input.sourceLocale, input.targetLocale) + "\u0001" + input.segmentKey;
    const existed = this.byKey.delete(key);
    if (!existed) return false;
    const scope = scopeKey(input.workspaceId, input.sourceLocale, input.targetLocale);
    const list = this.byScope.get(scope);
    if (list !== undefined) {
      const next = list.filter((e) => e.segmentKey !== input.segmentKey);
      if (next.length === 0) this.byScope.delete(scope);
      else this.byScope.set(scope, next);
    }
    return true;
  }

  /**
   * Look up a segment. Returns the exact-key match first; if none, and the
   * caller's text is within the fuzzy threshold of a stored source text
   * under the same key, returns the fuzzy match. Fuzzy results are
   * advisory: the caller decides whether to accept them.
   */
  lookup(input: LookupInput): LookupResult {
    this.assertLookupInput(input);
    const key = scopeKey(input.workspaceId, input.sourceLocale, input.targetLocale) + "\u0001" + input.segmentKey;
    const exact = this.byKey.get(key);
    if (exact !== undefined && this.isAcceptable(exact, input.includeDrafts ?? false)) {
      if (normaliseText(exact.sourceText) === normaliseText(input.sourceText)) {
        return {
          outcome: "exact",
          entry: exact,
          score: 1,
          reason: "segment key and source text match a stored translation",
        };
      }
    }

    const scope = scopeKey(input.workspaceId, input.sourceLocale, input.targetLocale);
    const candidates = this.byScope.get(scope) ?? [];
    const threshold = typeof input.fuzzyThreshold === "number" ? input.fuzzyThreshold : 0.6;
    let best: { entry: TranslationMemoryEntry; score: number } | null = null;
    for (const entry of candidates) {
      if (entry.segmentKey !== input.segmentKey) continue;
      if (!this.isAcceptable(entry, input.includeDrafts ?? false)) continue;
      const score = similarity(input.sourceText, entry.sourceText);
      if (score >= threshold && (best === null || score > best.score)) {
        best = { entry, score };
      }
    }
    if (best !== null) {
      return {
        outcome: "fuzzy",
        entry: best.entry,
        score: best.score,
        reason: `fuzzy match at ${best.score.toFixed(2)}; reuse requires reviewer confirmation`,
      };
    }

    return {
      outcome: "miss",
      entry: null,
      score: 0,
      reason: "no stored translation for this segment key and source text",
    };
  }

  /** Enumerate entries for a workspace; stable order by key then locale. */
  list(input: ListInput): readonly TranslationMemoryEntry[] {
    if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
      throw new TranslationMemoryError("list requires a workspaceId.", "invalid-input");
    }
    const includeDrafts = input.includeDrafts ?? false;
    const out: TranslationMemoryEntry[] = [];
    for (const entry of this.byKey.values()) {
      if (entry.workspaceId !== input.workspaceId) continue;
      if (!this.isAcceptable(entry, includeDrafts)) continue;
      if (input.sourceLocale !== undefined && entry.sourceLocale !== input.sourceLocale) continue;
      if (input.targetLocale !== undefined && entry.targetLocale !== input.targetLocale) continue;
      out.push(entry);
    }
    out.sort((a, b) => {
      if (a.segmentKey !== b.segmentKey) return a.segmentKey < b.segmentKey ? -1 : 1;
      if (a.targetLocale !== b.targetLocale) return a.targetLocale < b.targetLocale ? -1 : 1;
      return a.sourceLocale < b.sourceLocale ? -1 : a.sourceLocale > b.sourceLocale ? 1 : 0;
    });
    return out;
  }

  /** Aggregate counters for the workspace (optionally per target locale). */
  stats(workspaceId: string): TranslationMemoryStats {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      throw new TranslationMemoryError("stats requires a workspaceId.", "invalid-input");
    }
    let approved = 0;
    let drafts = 0;
    let rejected = 0;
    const byTargetLocale: Record<string, number> = {};
    for (const entry of this.byKey.values()) {
      if (entry.workspaceId !== workspaceId) continue;
      if (entry.status === "approved") {
        approved += 1;
        byTargetLocale[entry.targetLocale] = (byTargetLocale[entry.targetLocale] ?? 0) + 1;
      } else if (entry.status === "draft") {
        drafts += 1;
      } else {
        rejected += 1;
      }
    }
    return {
      entries: approved + drafts + rejected,
      approved,
      drafts,
      rejected,
      byTargetLocale,
    };
  }

  snapshot(): TranslationMemorySnapshot {
    const entries = [...this.byKey.values()].slice().sort((a, b) => {
      if (a.workspaceId !== b.workspaceId) return a.workspaceId < b.workspaceId ? -1 : 1;
      if (a.segmentKey !== b.segmentKey) return a.segmentKey < b.segmentKey ? -1 : 1;
      if (a.targetLocale !== b.targetLocale) return a.targetLocale < b.targetLocale ? -1 : 1;
      return a.sourceLocale < b.sourceLocale ? -1 : a.sourceLocale > b.sourceLocale ? 1 : 0;
    });
    return {
      version: "tm/1",
      entries,
      generatedAt: new Date().toISOString(),
    };
  }

  get size(): number {
    return this.byKey.size;
  }

  private assertLookupInput(input: LookupInput): void {
    if (input === null || typeof input !== "object") {
      throw new TranslationMemoryError("lookup requires an input object.", "invalid-input");
    }
    if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
      throw new TranslationMemoryError("lookup requires a workspaceId.", "invalid-input");
    }
    if (typeof input.segmentKey !== "string" || input.segmentKey.trim().length === 0) {
      throw new TranslationMemoryError("lookup requires a segmentKey.", "invalid-input");
    }
    if (typeof input.sourceLocale !== "string" || input.sourceLocale.trim().length === 0) {
      throw new TranslationMemoryError("lookup requires a sourceLocale.", "invalid-input");
    }
    if (typeof input.targetLocale !== "string" || input.targetLocale.trim().length === 0) {
      throw new TranslationMemoryError("lookup requires a targetLocale.", "invalid-input");
    }
    if (typeof input.sourceText !== "string" || input.sourceText.trim().length === 0) {
      throw new TranslationMemoryError("lookup requires non-empty sourceText.", "empty-segment");
    }
  }

  private isAcceptable(entry: TranslationMemoryEntry, includeDrafts: boolean): boolean {
    if (entry.status === "approved") return true;
    if (entry.status === "draft" && includeDrafts) return true;
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Similarity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Token-Jaccard similarity with a substring tiebreak. The formula is kept
 * small and documented because the fuzzy threshold is user-visible:
 *
 *   - Tokenise both texts (unicode letters/digits, lowercase).
 *   - Jaccard = |A ∩ B| / |A ∪ B|.
 *   - If one text (case/space-normalised) is a substring of the other,
 *     take the larger of the two scores.
 *
 * Two sentences that share most words score above 0.8; a light rephrasing
 * of a step lands around 0.6–0.8; two unrelated sentences fall below 0.2.
 * The default fuzzy threshold (0.6) is chosen to reject unrelated steps.
 */
export function similarity(a: string, b: string): number {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  const na = normaliseText(a);
  const nb = normaliseText(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;

  const tokensA = tokenise(na);
  const tokensB = tokenise(nb);
  let jaccard = 0;
  if (tokensA.size > 0 && tokensB.size > 0) {
    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection += 1;
    }
    const union = tokensA.size + tokensB.size - intersection;
    jaccard = union === 0 ? 0 : intersection / union;
  }

  // Substring tiebreak — relevant for very short segments where Jaccard is
  // degenerate (e.g. a step whose text differs only by a trailing period).
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  const substringScore = shorter.length >= 4 && longer.includes(shorter)
    ? Math.max(0.9, jaccard)
    : jaccard;

  return Math.max(jaccard, substringScore);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function scopeKey(workspaceId: string, sourceLocale: string, targetLocale: string): string {
  return `${workspaceId}\u0001${sourceLocale}\u0001${targetLocale}`;
}

function normaliseText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokenise(text: string): Set<string> {
  const out = new Set<string>();
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const t of tokens) out.add(t);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  scopeKey,
  normaliseText,
  tokenise,
  TM_ENTRY_STATUSES,
});
