/**
 * Zipy AI — cross-modal fusion of per-modality embeddings.
 *
 * Given the vectors produced by `embeddings.ts` for one or more canonical
 * sources, this module fuses them into a single "evidence vector" per item
 * that mixes information from the other items in the same working set. The
 * purpose is *ranking*: when a downstream step asks "which items support this
 * claim?", fused vectors are more discriminating than raw per-modality
 * vectors because they implicitly encode which other items were present
 * alongside them.
 *
 * What this is, precisely:
 *  - A learned-at-runtime, parameter-light attention mechanism over the full
 *    set of items in a working set. Each item is a query; every item is a
 *    key/value. Attention weights are computed from raw cosine similarity
 *    scaled by learned modality-pair biases, then normalised per query row.
 *
 * What this is NOT:
 *  - A trained transformer. There is no gradient step here, no optimiser, no
 *    backprop. Parameters are the small, explicit `ModalityPairBiases` table
 *    (per modality-pair affinity), and they are supplied by the caller — the
 *    fusion phase's trust score / conflict detector is where empirical tuning
 *    happens, if at all.
 *  - A semantic embedder. It does not call a model. It only mixes what it was
 *    given.
 *
 * Properties the caller can rely on:
 *  - Deterministic: same inputs, same parameters → same output, bit for bit.
 *  - No global state. All configuration is passed in.
 *  - No network, no credentials, no I/O.
 *  - Complexity O(N^2 * D) for N items with D-dimensional vectors. Guarded by
 *    an explicit `maxItems` cap so a pathological source cannot cause a
 *    surprise multi-hour run.
 */

import type { EmbeddedItem, Modality, SourceEmbedding } from "@zipy/fusion/embeddings";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type CrossModalErrorCode =
  | "invalid-input"
  | "dimension-mismatch"
  | "too-many-items"
  | "empty-input";

export class CrossModalError extends Error {
  readonly code: CrossModalErrorCode;
  constructor(message: string, code: CrossModalErrorCode) {
    super(message);
    this.name = "CrossModalError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Modality-pair biases                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A symmetric NxN table of affinities between modalities. A higher value
 * means "evidence from these two modalities reinforces one another more".
 *
 * The defaults encode the product's empirical priors, not learned weights:
 *   - text ↔ text: strongest (same-channel redundancy).
 *   - text ↔ transcript: strong (the transcript is text).
 *   - image ↔ layout: strong (both describe the same screenshot).
 *   - image ↔ frame: strong (a sampled frame is a screenshot).
 *   - table ↔ layout: moderate.
 *   - diagram ↔ diagram: strong.
 *   - Anything not listed: 0.5 (neutral).
 *
 * The caller may override any entry. This is exposed so the review / quality
 * phase can tune it against real conflict data without a code change to this
 * module.
 */
export type ModalityPairBiases = Readonly<Record<Modality, Readonly<Record<Modality, number>>>>;

export const DEFAULT_MODALITY_PAIR_BIASES: ModalityPairBiases = Object.freeze({
  text: Object.freeze({
    text: 1.0,
    table: 0.7,
    image: 0.6,
    layout: 0.5,
    diagram: 0.4,
    transcript: 0.9,
    frame: 0.5,
  }),
  table: Object.freeze({
    text: 0.7,
    table: 0.9,
    image: 0.5,
    layout: 0.6,
    diagram: 0.4,
    transcript: 0.4,
    frame: 0.4,
  }),
  image: Object.freeze({
    text: 0.6,
    table: 0.5,
    image: 0.9,
    layout: 0.9,
    diagram: 0.5,
    transcript: 0.4,
    frame: 0.9,
  }),
  layout: Object.freeze({
    text: 0.5,
    table: 0.6,
    image: 0.9,
    layout: 0.9,
    diagram: 0.5,
    transcript: 0.4,
    frame: 0.7,
  }),
  diagram: Object.freeze({
    text: 0.4,
    table: 0.4,
    image: 0.5,
    layout: 0.5,
    diagram: 1.0,
    transcript: 0.4,
    frame: 0.5,
  }),
  transcript: Object.freeze({
    text: 0.9,
    table: 0.4,
    image: 0.4,
    layout: 0.4,
    diagram: 0.4,
    transcript: 1.0,
    frame: 0.6,
  }),
  frame: Object.freeze({
    text: 0.5,
    table: 0.4,
    image: 0.9,
    layout: 0.7,
    diagram: 0.5,
    transcript: 0.6,
    frame: 0.9,
  }),
}) as ModalityPairBiases;

/* -------------------------------------------------------------------------- */
/* Public output                                                               */
/* -------------------------------------------------------------------------- */

export interface FusedItem {
  readonly itemId: string;
  readonly kind: EmbeddedItem["kind"];
  readonly modality: Modality;
  readonly artifactId: string;
  /** The input vector, unchanged (kept so a caller can compare pre- vs post-fusion). */
  readonly baseVector: readonly number[];
  /** The fused vector: baseVector + attention-mixed neighbourhood contribution. */
  readonly fusedVector: readonly number[];
  /** L2 norm of the fused vector, for ranking convenience. */
  readonly norm: number;
  /**
   * Item ids that contributed to this fused vector (attention weights above
   * `contributionEpsilon`), sorted by descending weight. Excludes `itemId`.
   */
  readonly topContributors: readonly { readonly itemId: string; readonly weight: number }[];
}

export interface FusedWorkingSet {
  readonly items: readonly FusedItem[];
  readonly itemCount: number;
  readonly dimension: number;
  /** Modalities that were present in the input. */
  readonly modalities: readonly Modality[];
  /** Artifact ids that contributed items, deduplicated. */
  readonly artifactIds: readonly string[];
  /** Parameters actually used (defaults resolved). */
  readonly parameters: {
    readonly selfWeight: number;
    readonly neighbourWeight: number;
    readonly temperature: number;
    readonly contributionEpsilon: number;
    readonly maxContributors: number;
  };
  readonly generatedAt: string;
}

export interface FuseOptions {
  /**
   * How much the item's own vector is preserved in the fused output.
   * `fused = selfWeight * base + neighbourWeight * attentionMix`. Defaults to 1.
   */
  readonly selfWeight?: number;
  /**
   * How much the attention-weighted neighbourhood contributes. Defaults to 0.5.
   * `0` makes fusion a pure pass-through (useful for A/B and for tests).
   */
  readonly neighbourWeight?: number;
  /**
   * Softmax temperature applied to raw similarity scores before
   * normalisation. Lower = sharper attention. Defaults to 1.
   */
  readonly temperature?: number;
  /**
   * Attention weights below this value are not recorded as contributors.
   * Defaults to 0.05.
   */
  readonly contributionEpsilon?: number;
  /** Maximum contributors recorded per item. Defaults to 8. */
  readonly maxContributors?: number;
  /** Override the modality-pair biases table. */
  readonly modalityPairBiases?: ModalityPairBiases;
  /**
   * Safety cap on working-set size. Each item causes O(N) work; N above this
   * is a sign the caller should shard. Defaults to 4096.
   */
  readonly maxItems?: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Fuse many per-source embeddings into a single working set. Items from all
 * sources are pooled; attention is computed across the pool. The pool is
 * expected to be the "everything a workflow knows" set the downstream
 * conflict/gap detector will reason over.
 */
export function fuseEmbeddings(
  sources: readonly SourceEmbedding[],
  options: FuseOptions = {},
): FusedWorkingSet {
  if (!Array.isArray(sources)) {
    throw new CrossModalError("fuseEmbeddings requires an array of SourceEmbedding.", "invalid-input");
  }
  const pooled: EmbeddedItem[] = [];
  const artifactIds: string[] = [];
  const artifactSeen = new Set<string>();
  let dimension = -1;
  for (const s of sources) {
    if (s === null || typeof s !== "object") {
      throw new CrossModalError("SourceEmbedding entries must be objects.", "invalid-input");
    }
    if (typeof s.artifactId !== "string" || s.artifactId.length === 0) {
      throw new CrossModalError("SourceEmbedding.artifactId is missing.", "invalid-input");
    }
    if (dimension === -1) dimension = s.dimension;
    else if (s.dimension !== dimension) {
      throw new CrossModalError(
        `All SourceEmbedding entries must share the same dimension. Got ${dimension} and ${s.dimension}.`,
        "dimension-mismatch",
      );
    }
    if (!artifactSeen.has(s.artifactId)) {
      artifactSeen.add(s.artifactId);
      artifactIds.push(s.artifactId);
    }
    for (const item of s.items) {
      if (item.vector.length !== dimension) {
        throw new CrossModalError(
          `EmbeddedItem ${item.itemId} has vector length ${item.vector.length}, expected ${dimension}.`,
          "dimension-mismatch",
        );
      }
      pooled.push(item);
    }
  }

  if (pooled.length === 0) {
    return {
      items: [],
      itemCount: 0,
      dimension: dimension === -1 ? 0 : dimension,
      modalities: [],
      artifactIds,
      parameters: resolveParameters(options),
      generatedAt: new Date().toISOString(),
    };
  }

  const params = resolveParameters(options);
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? 4096));
  if (pooled.length > maxItems) {
    throw new CrossModalError(
      `Working set has ${pooled.length} items, above maxItems=${maxItems}. Shard the input or raise maxItems explicitly.`,
      "too-many-items",
    );
  }

  const biases = options.modalityPairBiases ?? DEFAULT_MODALITY_PAIR_BIASES;

  // Precompute norms and pre-normalise each vector so cosine similarity
  // reduces to a dot product.
  const n = pooled.length;
  const dim = pooled[0]?.vector.length ?? 0;
  const unitVectors: number[][] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = (pooled[i] as EmbeddedItem).vector;
    let norm = 0;
    for (let d = 0; d < dim; d += 1) {
      const x = v[d] as number;
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    if (norm === 0) {
      unitVectors[i] = new Array(dim).fill(0);
    } else {
      const out = new Array<number>(dim);
      for (let d = 0; d < dim; d += 1) out[d] = (v[d] as number) / norm;
      unitVectors[i] = out;
    }
  }

  const fusedItems: FusedItem[] = new Array(n);
  const temperature = params.temperature;

  for (let i = 0; i < n; i += 1) {
    const query = pooled[i] as EmbeddedItem;
    const qUnit = unitVectors[i] as number[];

    // Scores for every other item j (j != i).
    const scores: number[] = new Array(n).fill(Number.NEGATIVE_INFINITY);
    let maxScore = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const key = pooled[j] as EmbeddedItem;
      const kUnit = unitVectors[j] as number[];
      let dot = 0;
      for (let d = 0; d < dim; d += 1) {
        dot += (qUnit[d] as number) * (kUnit[d] as number);
      }
      // Cosine ∈ [-1,1]; shift to [0,2] then scale by modality-pair bias.
      const bias = readBias(biases, query.modality, key.modality);
      const raw = (dot + 1) * bias;
      scores[j] = raw;
      if (raw > maxScore) maxScore = raw;
    }

    // Softmax with temperature; max subtraction for numerical stability.
    const weights: number[] = new Array(n).fill(0);
    if (maxScore !== Number.NEGATIVE_INFINITY) {
      let sum = 0;
      for (let j = 0; j < n; j += 1) {
        if (j === i) continue;
        const s = scores[j] as number;
        const expVal = Math.exp((s - maxScore) / temperature);
        weights[j] = expVal;
        sum += expVal;
      }
      if (sum > 0) {
        for (let j = 0; j < n; j += 1) {
          if (j === i) continue;
          weights[j] = (weights[j] as number) / sum;
        }
      }
    }

    // Attention mix: sum_j weights[j] * baseVector_j
    const mix = new Array<number>(dim).fill(0);
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const w = weights[j] as number;
      if (w === 0) continue;
      const v = (pooled[j] as EmbeddedItem).vector;
      for (let d = 0; d < dim; d += 1) {
        mix[d] = (mix[d] as number) + w * (v[d] as number);
      }
    }

    // Combine.
    const base = query.vector;
    const fused = new Array<number>(dim);
    let fusedNormSq = 0;
    for (let d = 0; d < dim; d += 1) {
      const val = params.selfWeight * (base[d] as number) + params.neighbourWeight * (mix[d] as number);
      fused[d] = val;
      fusedNormSq += val * val;
    }

    // Top contributors: weights above epsilon, descending, capped.
    const contributors: { itemId: string; weight: number }[] = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const w = weights[j] as number;
      if (w >= params.contributionEpsilon && w > 0) {
        contributors.push({ itemId: (pooled[j] as EmbeddedItem).itemId, weight: w });
      }
    }
    contributors.sort((a, b) => b.weight - a.weight);
    const topContributors = contributors.slice(0, params.maxContributors);

    fusedItems[i] = {
      itemId: query.itemId,
      kind: query.kind,
      modality: query.modality,
      artifactId: artifactOf(query, sources),
      baseVector: base.slice(),
      fusedVector: fused,
      norm: Math.sqrt(fusedNormSq),
      topContributors,
    };
  }

  // Modalities present, in first-seen order.
  const modalitiesSeen = new Set<Modality>();
  const modalities: Modality[] = [];
  for (const item of pooled) {
    if (!modalitiesSeen.has(item.modality)) {
      modalitiesSeen.add(item.modality);
      modalities.push(item.modality);
    }
  }

  return {
    items: fusedItems,
    itemCount: fusedItems.length,
    dimension: dim,
    modalities,
    artifactIds,
    parameters: params,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function readBias(
  table: ModalityPairBiases,
  a: Modality,
  b: Modality,
): number {
  const row = table[a];
  const raw = row?.[b];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0.5;
  return raw;
}

function resolveParameters(options: FuseOptions): FusedWorkingSet["parameters"] {
  const selfWeight = finiteOr(options.selfWeight, 1);
  const neighbourWeight = finiteOr(options.neighbourWeight, 0.5);
  const temperature = Math.max(1e-6, finiteOr(options.temperature, 1));
  const contributionEpsilon = Math.max(0, finiteOr(options.contributionEpsilon, 0.05));
  const maxContributors = Math.max(0, Math.floor(finiteOr(options.maxContributors, 8)));
  return { selfWeight, neighbourWeight, temperature, contributionEpsilon, maxContributors };
}

function finiteOr(v: number | undefined, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return fallback;
}

/**
 * Attach artifactId to each fused item. Embeddings carry the artifact on the
 * enclosing SourceEmbedding, not on each item, so we look it up by walking
 * the sources until we find the item. This is O(N * S) but runs once per
 * source ingestion and S is small.
 */
function artifactOf(item: EmbeddedItem, sources: readonly SourceEmbedding[]): string {
  for (const s of sources) {
    for (const candidate of s.items) {
      if (candidate.itemId === item.itemId && candidate.contentHash === item.contentHash) {
        return s.artifactId;
      }
    }
  }
  return "";
}

/**
 * Rank fused items by cosine similarity to a query vector. Used by the
 * reconciliation step to fetch the top-K supporting items for a claim.
 */
export function rankBySimilarity(
  items: readonly FusedItem[],
  query: readonly number[],
): readonly { readonly item: FusedItem; readonly similarity: number }[] {
  if (items.length === 0) return [];
  const dim = query.length;
  let qNorm = 0;
  for (const x of query) qNorm += x * x;
  qNorm = Math.sqrt(qNorm);
  if (qNorm === 0) {
    return items.map((item) => ({ item, similarity: 0 }));
  }
  const scored = items.map((item) => {
    const v = item.fusedVector;
    if (v.length !== dim) {
      throw new CrossModalError(
        `Query vector length ${dim} does not match fused vector length ${v.length}.`,
        "dimension-mismatch",
      );
    }
    let dot = 0;
    let norm = 0;
    for (let d = 0; d < dim; d += 1) {
      const x = v[d] as number;
      dot += x * (query[d] as number);
      norm += x * x;
    }
    const denom = Math.sqrt(norm) * qNorm;
    return { item, similarity: denom === 0 ? 0 : dot / denom };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored;
}
