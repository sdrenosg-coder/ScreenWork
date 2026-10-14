/**
 * Zipy AI — per-source trust scoring for the fusion layer.
 *
 * Fusion needs to weigh evidence. If a URL and a PDF disagree on the label of
 * a button, the resolver must not just ask "which is higher priority?" — it
 * must ask "how much do I trust each source right now?" A source's trust is
 * a function of:
 *
 *   1. Freshness       — how recently it was ingested, relative to the other
 *                        sources in the same working set.
 *   2. Modality        — an image is not the same evidence class as a text
 *                        prompt; the caller supplies per-kind base weights.
 *   3. Role            — primary / supporting / context / reference (already
 *                        classified on the `sources` table).
 *   4. Completeness    — the fraction of the working set's items the source
 *                        contributed; a source that contributed one item is
 *                        weak context, not weak evidence, but the two are
 *                        hard to distinguish so the score records both.
 *   5. Confidence      — the mean of per-item `confidence` fields (OCR
 *                        confidence, UI-element confidence, diagram node
 *                        ambiguity), when those are present.
 *   6. Penalties       — a source with `status = 'failed'` or that yielded
 *                        zero items is heavily penalised rather than dropped,
 *                        so a caller can still see it in the ranking.
 *
 * The output is a `trust ∈ [0,1]` per source plus the exact contributions to
 * that score so a reviewer can be shown *why* the fusion layer preferred one
 * source over another (this is what the provenance panel surfaces).
 *
 * The module has no I/O. Inputs are supplied by the caller (typically read
 * from the `sources` and `canonical_sources` tables), so this file is a
 * pure function of its inputs and can be unit-tested in isolation.
 */

import type { CanonicalSource } from "@zipy/processing/canonical";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TrustScoreErrorCode = "invalid-input" | "empty-input";

export class TrustScoreError extends Error {
  readonly code: TrustScoreErrorCode;
  constructor(message: string, code: TrustScoreErrorCode) {
    super(message);
    this.name = "TrustScoreError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The source role on the `sources` table. Declared here to keep this module
 * free of a dependency on the DB schema (which imports jobs, which imports
 * pg — this file must stay importable from worker-side tests without pulling
 * the DB driver in). The literal set matches `SOURCE_ROLES` in
 * `packages/db/src/schema/sources.ts`; a compile-time assertion in the test
 * suite guards against drift.
 */
export type SourceRole = "primary" | "supporting" | "context" | "reference";

/**
 * The source kind on the `sources` table. Matches `SOURCE_KINDS` in the DB
 * schema.
 */
export type SourceKind = "url" | "text" | "image" | "file";

/** The status on the `sources` table. Matches `SOURCE_STATUSES`. */
export type SourceStatus = "pending" | "ingesting" | "ready" | "failed" | "superseded";

/**
 * Everything the scorer needs about one source. Callers typically construct
 * this from a `sources` row plus the canonical source it produced.
 */
export interface SourceTrustInput {
  /** Row id from the `sources` table (not the artifact id). */
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly role: SourceRole;
  readonly status: SourceStatus;
  /**
   * When the source was last successfully ingested. `null` when the source
   * has never completed ingestion.
   */
  readonly ingestedAt: Date | null;
  /**
   * The `source_priority` column: lower is higher priority within a role.
   * Kept as a tie-break signal, not as the primary driver.
   */
  readonly sourcePriority: number;
  /**
   * The canonical items this source produced. May be `null` when the source
   * has not been canonicalised yet (status pending/ingesting/failed) — in
   * that case completeness and confidence contributions are disabled and
   * a penalty is applied.
   */
  readonly canonical: CanonicalSource | null;
  /**
   * Per-item confidences extracted by the caller. When `null`, per-item
   * confidences are derived from the canonical content itself (OCR
   * confidence on text regions, UI-element confidence, etc.). Kept as an
   * override so a caller with a different confidence source (e.g. the STT
   * confidence on transcript segments) can supply it directly.
   */
  readonly perItemConfidence?: readonly number[] | null;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Per-source-kind base weights. Higher = more trusted as evidence of "what
 * the user should actually do". These are *priors*, not learned weights:
 *
 *   - url  : the live application is the ground truth for the current UI.
 *   - text : a natural-language instruction from the operator is explicit
 *            intent, not a description of an existing system; it is trusted
 *            for *goal* but not for *current state*.
 *   - image: a single screenshot shows exactly one state with high fidelity.
 *   - file : a document; trusted as authored procedure, tolerant to staleness.
 */
export const DEFAULT_KIND_BASE_WEIGHT: Readonly<Record<SourceKind, number>> = Object.freeze({
  url: 1.00,
  text: 0.85,
  image: 0.75,
  file: 0.70,
});

/**
 * Multiplier applied to `kindBase` for each source role. A "context" source
 * is present in the working set but should not win a conflict on its own; a
 * "primary" source should.
 */
export const DEFAULT_ROLE_MULTIPLIER: Readonly<Record<SourceRole, number>> = Object.freeze({
  primary: 1.00,
  supporting: 0.90,
  reference: 0.80,
  context: 0.60,
});

/**
 * Multiplier applied per source status. Failed sources stay in the ranking
 * but rank very low; superseded sources are penalised because a newer
 * version is available elsewhere in the working set.
 */
export const DEFAULT_STATUS_MULTIPLIER: Readonly<Record<SourceStatus, number>> = Object.freeze({
  ready: 1.00,
  ingesting: 0.75,
  pending: 0.75,
  failed: 0.20,
  superseded: 0.50,
});

export interface TrustScoreOptions {
  /** Wall clock used for freshness. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Freshness half-life in days. Scores halve every N days. Defaults to 30. */
  readonly freshnessHalfLifeDays?: number;
  /**
   * The full working set (all source inputs) so completeness can be computed
   * as "fraction of items this source contributed". When omitted, every
   * source's completeness is 1 (no way to normalise).
   */
  readonly workingSet?: readonly SourceTrustInput[];
  readonly kindBaseWeight?: Readonly<Record<SourceKind, number>>;
  readonly roleMultiplier?: Readonly<Record<SourceRole, number>>;
  readonly statusMultiplier?: Readonly<Record<SourceStatus, number>>;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every component of a source's trust score, in the range [0,1] except the
 * multipliers. The `components` object is what the provenance panel renders
 * so a reviewer can inspect why one source outranked another.
 */
export interface TrustScoreComponents {
  /** Freshness ∈ (0,1]. 1 = ingested today. */
  readonly freshness: number;
  /** Base per-kind weight, copied through for visibility. */
  readonly kindBase: number;
  /** Role multiplier in (0,1]. */
  readonly roleMultiplier: number;
  /** Status multiplier in (0,1]. */
  readonly statusMultiplier: number;
  /**
   * Completeness ∈ [0,1]: this source's item count / total item count in the
   * working set.
   */
  readonly completeness: number;
  /** Mean per-item confidence ∈ [0,1], or 1 when no confidences were available. */
  readonly meanConfidence: number;
  /** How many items this source contributed. */
  readonly itemCount: number;
  /** How many items the working set contributed, when known. */
  readonly workingSetItemCount: number;
}

export interface SourceTrustScore {
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly role: SourceRole;
  readonly status: SourceStatus;
  /** Final score ∈ [0,1]. */
  readonly trust: number;
  readonly components: TrustScoreComponents;
  /** Human-readable notes for the provenance panel, e.g. warnings. */
  readonly notes: readonly string[];
}

export interface WorkingSetTrustRanking {
  readonly scores: readonly SourceTrustScore[];
  readonly ranking: readonly {
    readonly rank: number;
    readonly sourceId: string;
    readonly trust: number;
  }[];
  readonly generatedAt: string;
  readonly parameters: {
    readonly freshnessHalfLifeDays: number;
    readonly nowIso: string;
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Score one source in isolation (no cross-source normalisation). Completeness
 * is set to 1. Used when a caller wants a per-source trust without a working
 * set; the working-set variant computes completeness as a normalised share.
 */
export function scoreSourceTrust(
  input: SourceTrustInput,
  options: TrustScoreOptions = {},
): SourceTrustScore {
  return scoreSourceWithWorkingSet(input, options, null);
}

/**
 * Score every source in a working set. The returned `scores` array is in the
 * same order as `inputs`. The `ranking` array is the same scores sorted by
 * descending trust with rank 1 = highest trust.
 */
export function scoreWorkingSetTrust(
  inputs: readonly SourceTrustInput[],
  options: TrustScoreOptions = {},
): WorkingSetTrustRanking {
  if (!Array.isArray(inputs)) {
    throw new TrustScoreError("scoreWorkingSetTrust requires an array.", "invalid-input");
  }
  const totalItems = inputs.reduce((acc, s) => {
    const n = s.canonical?.itemCount ?? 0;
    return acc + (Number.isFinite(n) && n >= 0 ? n : 0);
  }, 0);
  const scores: SourceTrustScore[] = inputs.map((s) =>
    scoreSourceWithWorkingSet(s, options, { totalItems, workingSet: inputs }),
  );
  const ranked = scores
    .map((s, index) => ({ sourceId: s.sourceId, trust: s.trust, index }))
    .sort((a, b) => b.trust - a.trust || a.index - b.index);
  const ranking = ranked.map((entry, i) => ({
    rank: i + 1,
    sourceId: entry.sourceId,
    trust: entry.trust,
  }));
  const now = options.now ?? new Date();
  const half = validatePositive(options.freshnessHalfLifeDays ?? 30, "freshnessHalfLifeDays");
  return {
    scores,
    ranking,
    generatedAt: new Date().toISOString(),
    parameters: {
      freshnessHalfLifeDays: half,
      nowIso: now.toISOString(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

interface WorkingSetContext {
  readonly totalItems: number;
  readonly workingSet: readonly SourceTrustInput[];
}

function scoreSourceWithWorkingSet(
  input: SourceTrustInput,
  options: TrustScoreOptions,
  context: WorkingSetContext | null,
): SourceTrustScore {
  validateInput(input);
  const now = options.now ?? new Date();
  const halfLifeDays = validatePositive(
    options.freshnessHalfLifeDays ?? 30,
    "freshnessHalfLifeDays",
  );
  const kindBase = options.kindBaseWeight ?? DEFAULT_KIND_BASE_WEIGHT;
  const roleMul = options.roleMultiplier ?? DEFAULT_ROLE_MULTIPLIER;
  const statusMul = options.statusMultiplier ?? DEFAULT_STATUS_MULTIPLIER;

  const notes: string[] = [];

  // ---- Freshness ---------------------------------------------------------
  let freshness = 1.0;
  if (input.ingestedAt === null) {
    freshness = 0.5; // never completed; not zero so it can still be ranked
    notes.push("Source has no completed ingestion; freshness neutralised to 0.5.");
  } else {
    const ageMs = Math.max(0, now.getTime() - input.ingestedAt.getTime());
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
    // Exponential decay: 2^(-ageDays/halfLife). Bounded at 1 for age 0 and
    // approaches 0 as age grows, but never negative.
    freshness = Math.pow(2, -(ageMs / halfLifeMs));
    // Guard against a future-dated timestamp producing > 1.
    if (freshness > 1) freshness = 1;
    if (freshness < 0) freshness = 0;
  }

  // ---- Base, role, status ------------------------------------------------
  const base = readNumber(kindBase, input.kind, DEFAULT_KIND_BASE_WEIGHT[input.kind]);
  const role = readNumber(roleMul, input.role, DEFAULT_ROLE_MULTIPLIER[input.role]);
  const status = readNumber(statusMul, input.status, DEFAULT_STATUS_MULTIPLIER[input.status]);

  // ---- Items and completeness -------------------------------------------
  const itemCount = input.canonical?.itemCount ?? 0;
  let completeness = 1.0;
  let workingSetItemCount = itemCount;
  if (context !== null) {
    workingSetItemCount = context.totalItems;
    if (context.totalItems === 0) {
      completeness = 0;
      notes.push("Working set has zero items; completeness is 0 for every source.");
    } else {
      completeness = itemCount / context.totalItems;
    }
  }
  if (itemCount === 0) {
    notes.push(
      "Source contributed zero canonical items; it cannot ground any claim and is heavily down-weighted.",
    );
  }

  // ---- Mean confidence ---------------------------------------------------
  const meanConfidence = meanPerItemConfidence(input, notes);

  // ---- Compose ----------------------------------------------------------
  // The composite is a weighted geometric mean of {freshness, completeness,
  // meanConfidence} (each in [0,1)), then multiplied by the three linear
  // multipliers (base, role, status). A geometric mean keeps a component
  // close to 0 from being rescued by the others, which matches the intent:
  // a source that saw nothing cannot win on freshness alone.
  const eps = 1e-6;
  const geom = Math.pow(
    Math.max(eps, freshness) *
      Math.max(eps, completeness) *
      Math.max(eps, meanConfidence),
    1 / 3,
  );
  const composite = geom * base * role * status;

  // A zero-item source is not merely low; it is useless as evidence. Apply a
  // hard down-weight so it never wins a conflict over any source with items.
  const finalTrust = itemCount === 0 ? composite * 0.1 : composite;

  const trust = clamp01(finalTrust);

  return {
    sourceId: input.sourceId,
    kind: input.kind,
    role: input.role,
    status: input.status,
    trust,
    components: {
      freshness,
      kindBase: base,
      roleMultiplier: role,
      statusMultiplier: status,
      completeness,
      meanConfidence,
      itemCount,
      workingSetItemCount,
    },
    notes,
  };
}

function meanPerItemConfidence(
  input: SourceTrustInput,
  notes: string[],
): number {
  const override = input.perItemConfidence;
  if (Array.isArray(override) && override.length > 0) {
    let sum = 0;
    let count = 0;
    for (const v of override) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      sum += clamp01(v);
      count += 1;
    }
    if (count > 0) return sum / count;
    notes.push("perItemConfidence array was empty; falling back to canonical-derived confidence.");
  }
  const canonical = input.canonical;
  if (canonical === null) return 1.0;

  // Derive per-item confidence from the canonical items where they carry
  // one. Not every kind does; when none do, return 1.0 so the composite is
  // not artificially penalised.
  let sum = 0;
  let count = 0;
  for (const item of canonical.items) {
    const c = item.content;
    let v: number | null = null;
    switch (c.kind) {
      case "ui-element":
        v = c.value.confidence;
        break;
      case "layout-region":
        v = c.value.confidence;
        break;
      case "transcript-segment":
        v = c.value.confidence;
        break;
      case "diagram-node":
        // Recognised nodes carry a boolean ambiguity flag rather than a
        // numeric confidence; treat ambiguity as a mild penalty.
        v = c.value.textAmbiguity ? 0.6 : 1.0;
        break;
      case "table":
        // A ragged table is a mild signal, not a per-row confidence.
        v = c.value.isComplete ? 1.0 : 0.7;
        break;
      case "table-cell":
      case "plain-text":
      case "page-text":
      case "video-frame":
      case "diagram-edge":
      case "diagram-description":
        v = null;
        break;
    }
    if (v !== null) {
      sum += clamp01(v);
      count += 1;
    }
  }
  if (count === 0) {
    notes.push(
      "No canonical item carried a per-item confidence; meanConfidence defaulted to 1.0.",
    );
    return 1.0;
  }
  return sum / count;
}

function readNumber<K extends string>(
  table: Readonly<Record<K, number>>,
  key: K,
  fallback: number,
): number {
  const v = table[key];
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return fallback;
}

function validateInput(input: SourceTrustInput): void {
  if (input === null || typeof input !== "object") {
    throw new TrustScoreError("SourceTrustInput must be an object.", "invalid-input");
  }
  if (typeof input.sourceId !== "string" || input.sourceId.length === 0) {
    throw new TrustScoreError("SourceTrustInput.sourceId must be a non-empty string.", "invalid-input");
  }
  if (
    input.kind !== "url" &&
    input.kind !== "text" &&
    input.kind !== "image" &&
    input.kind !== "file"
  ) {
    throw new TrustScoreError(
      `SourceTrustInput.kind must be one of url|text|image|file (got ${String(input.kind)}).`,
      "invalid-input",
    );
  }
  if (
    input.role !== "primary" &&
    input.role !== "supporting" &&
    input.role !== "context" &&
    input.role !== "reference"
  ) {
    throw new TrustScoreError(
      `SourceTrustInput.role must be one of primary|supporting|context|reference (got ${String(input.role)}).`,
      "invalid-input",
    );
  }
  if (
    input.status !== "pending" &&
    input.status !== "ingesting" &&
    input.status !== "ready" &&
    input.status !== "failed" &&
    input.status !== "superseded"
  ) {
    throw new TrustScoreError(
      `SourceTrustInput.status must be one of pending|ingesting|ready|failed|superseded (got ${String(input.status)}).`,
      "invalid-input",
    );
  }
  if (!(input.ingestedAt instanceof Date) && input.ingestedAt !== null) {
    throw new TrustScoreError(
      "SourceTrustInput.ingestedAt must be a Date or null.",
      "invalid-input",
    );
  }
  if (
    typeof input.sourcePriority !== "number" ||
    !Number.isFinite(input.sourcePriority)
  ) {
    throw new TrustScoreError(
      "SourceTrustInput.sourcePriority must be a finite number.",
      "invalid-input",
    );
  }
}

function validatePositive(v: number, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new TrustScoreError(`${field} must be a positive finite number.`, "invalid-input");
  }
  return v;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/* -------------------------------------------------------------------------- */
/* Convenience                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Map a `scoreWorkingSetTrust` result into a lookup from sourceId → trust.
 * The conflict resolver and gap detector need O(1) access by source id.
 */
export function trustBySourceId(
  ranking: WorkingSetTrustRanking,
): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  for (const s of ranking.scores) m.set(s.sourceId, s.trust);
  return m;
}
