/**
 * Zipy AI — per-modality embedding generation for cross-source fusion.
 *
 * The fusion layer needs one vector per canonical item so that evidence from
 * text, tables, layout and images can be compared in a single space and
 * fused. This module produces those vectors.
 *
 * Design rules honoured here:
 *  - Provider-agnostic. Embeddings are produced by an injected
 *    `EmbeddingBackend` (local Ollama/vLLM, or a hosted provider). This module
 *    never reads credentials and never assumes a provider is configured; a
 *    backend that is not supplied is an explicit configuration error, not a
 *    silent fake vector.
 *  - Deterministic fallback. When the caller explicitly opts into
 *    `allowDeterministicFallback`, a pure hashing-based embedder is used so
 *    development and tests can run with no model. That fallback is a real
 *    algorithm (feature hashing), not random numbers, and it is *labelled* as
 *    such on every vector it produces so downstream code can tell it apart.
 *  - Modality awareness. Each canonical item kind maps to a modality
 *    (text / table / image / layout / diagram / transcript / frame). Items are
 *    embedded with a modality-specific text projection, and a table item may
 *    additionally embed its JSON serialisation so column structure is not lost
 *    when a row is short.
 *  - No hidden state. Everything the embedder needs is in the input; caching
 *    lives in an optional injected `EmbeddingCache`, not in a module global.
 *  - Persistence-ready. Output carries `dimension`, `model`, `backend` and a
 *    `contentHash` per vector so the pgvector writer and the cache layer do
 *    not have to recompute anything.
 *
 * This module does not import `@zipy/fusion/crossModalAttention` or any other
 * fusion module; it only consumes `@zipy/processing/canonical`.
 */

import type {
  CanonicalContent,
  CanonicalItem,
  CanonicalItemKind,
  CanonicalSource,
} from "@zipy/processing/canonical";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type EmbeddingErrorCode =
  | "invalid-input"
  | "backend-not-configured"
  | "backend-failed"
  | "dimension-mismatch"
  | "unsupported-content";

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  constructor(message: string, code: EmbeddingErrorCode) {
    super(message);
    this.name = "EmbeddingError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Backend                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What kind of model produced a vector. `"feature-hashing"` is present so a
 * deterministic fallback vector never masquerades as a model embedding.
 */
export type EmbeddingBackendKind =
  | "ollama"
  | "vllm"
  | "openai"
  | "anthropic"
  | "gemini"
  | "custom"
  | "feature-hashing";

export interface EmbeddingBackend {
  /** Short stable identifier stored on every vector, e.g. "ollama:nomic-embed-text". */
  readonly id: string;
  readonly kind: EmbeddingBackendKind;
  /** Vector dimension this backend emits. Must be > 0. */
  readonly dimension: number;
  /**
   * Embed one batch of texts. Implementations MUST return exactly one vector
   * per text, in the same order, each of length `dimension`. Implementations
   * MUST throw on failure — a partial or zero vector is not acceptable.
   */
  embed(
    texts: readonly string[],
    options: { readonly signal?: AbortSignal },
  ): Promise<readonly (readonly number[])[]>;
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

export interface EmbeddingCache {
  get(key: string): Promise<readonly number[] | null> | readonly number[] | null;
  set(key: string, value: readonly number[]): Promise<void> | void;
}

/**
 * In-memory cache. Bounded; evicts oldest insertions (FIFO) once full.
 * Suitable for a single worker process. Persistent caches (Postgres,
 * Redis) implement the same interface.
 */
export class MemoryEmbeddingCache implements EmbeddingCache {
  private readonly map = new Map<string, readonly number[]>();
  private readonly limit: number;
  constructor(limit = 5_000) {
    this.limit = Math.max(1, Math.floor(limit));
  }
  get(key: string): readonly number[] | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: readonly number[]): void {
    if (this.map.size >= this.limit) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }
}

/* -------------------------------------------------------------------------- */
/* Modalities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The modality an item belongs to. This is the axis the cross-modal attention
 * module keys on, and it determines which text projection we feed the
 * embedder. Kept as a closed union because every consumer switches on it.
 */
export type Modality =
  | "text"
  | "table"
  | "image"
  | "layout"
  | "diagram"
  | "transcript"
  | "frame";

/**
 * Mapping from canonical kind to modality. This is the single source of
 * truth — a new kind must be added here to be embeddable, which prevents an
 * unclassified item from silently being treated as text.
 */
export const KIND_TO_MODALITY: Readonly<Record<CanonicalItemKind, Modality>> = {
  "page-text": "text",
  "layout-region": "layout",
  "table": "table",
  "table-cell": "table",
  "ui-element": "image",
  "diagram-node": "diagram",
  "diagram-edge": "diagram",
  "diagram-description": "diagram",
  "transcript-segment": "transcript",
  "video-frame": "frame",
  "plain-text": "text",
};

export function modalityOf(kind: CanonicalItemKind): Modality {
  const m = KIND_TO_MODALITY[kind];
  if (m === undefined) {
    throw new EmbeddingError(
      `Canonical kind "${String(kind)}" has no modality mapping; update KIND_TO_MODALITY.`,
      "unsupported-content",
    );
  }
  return m;
}

/* -------------------------------------------------------------------------- */
/* Item → text projection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Produce the text we actually embed for one item. Each modality gets a
 * distinct projection so that a button labelled "Save" and a paragraph
 * containing the word "save" do not collide in embedding space. The
 * projection is deterministic and human-readable so it can be logged and
 * debugged without a decoder.
 *
 * Returns null when the item has no embeddable text (e.g. a diagram edge with
 * no label) — the caller then skips that item rather than embedding an empty
 * string.
 */
export function projectItemToText(item: CanonicalItem): string | null {
  const c: CanonicalContent = item.content;
  switch (c.kind) {
    case "plain-text":
      return trimOrNull(c.value.text);
    case "page-text": {
      // The page-text item is a verdict anchor; its own text is empty by
      // design. If that ever changes, prefer the text.
      return trimOrNull(c.value.text);
    }
    case "layout-region": {
      const header = `[region:${c.value.kind}]`;
      const body = c.value.text.trim();
      if (body.length === 0) return null;
      return `${header} ${body}`;
    }
    case "table": {
      // Prefer Markdown serialisation: it preserves column boundaries, which
      // a JSON dump would also do but less legibly for a text embedder.
      const md = c.value.markdown.trim();
      if (md.length === 0) return null;
      return `[table ${c.value.rowCount}x${c.value.columnCount}]\n${md}`;
    }
    case "table-cell": {
      const cell = `[cell r${c.value.row}c${c.value.column}]`;
      const body = c.value.text.trim();
      if (body.length === 0) return null;
      return `${cell} ${body}`;
    }
    case "ui-element": {
      const label = c.value.label.trim();
      const role = c.value.rawRole.length > 0 ? c.value.rawRole : c.value.kind;
      if (label.length === 0 && role.length === 0) return null;
      // Include state entries (e.g. disabled=true) — they change intent.
      const statePairs = Object.entries(c.value.states)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",");
      const stateSuffix = statePairs.length > 0 ? ` {${statePairs}}` : "";
      return `[ui:${role}] ${label}${stateSuffix}`.trim();
    }
    case "diagram-node":
      return trimOrNull(`[node:${c.value.kind}] ${c.value.label}`);
    case "diagram-edge": {
      const label = c.value.label ?? "";
      const base = `[edge] ${c.value.from} -> ${c.value.to}`;
      return trimOrNull(label.length > 0 ? `${base} if ${label}` : base);
    }
    case "diagram-description":
      return trimOrNull(c.value.text);
    case "transcript-segment": {
      const speaker = c.value.speaker.length > 0 ? `${c.value.speaker}: ` : "";
      return trimOrNull(`${speaker}${c.value.text}`);
    }
    case "video-frame": {
      const ocr = c.value.ocrText.map((t) => t.trim()).filter((t) => t.length > 0);
      const ui = c.value.uiElements.map((e) => `${e.kind}:${e.label}`);
      const parts = [...ocr, ...ui];
      if (parts.length === 0) return null;
      return `[frame] ${parts.join(" | ")}`;
    }
  }
}

function trimOrNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Content hashing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Compute the cache key for an item's embedding. Depends on the projection
 * text, the modality, and the backend id, so swapping backends invalidates
 * the cache implicitly.
 *
 * Uses Web Crypto (available in Node 20 via `globalThis.crypto`). The hash
 * itself is SHA-256 hex.
 */
export async function computeContentHash(
  projection: string,
  modality: Modality,
  backendId: string,
): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${backendId}\n${modality}\n${projection}`);
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new EmbeddingError(
      "Web Crypto (globalThis.crypto.subtle) is unavailable; cannot hash embedding cache keys.",
      "backend-not-configured",
    );
  }
  const digest = await subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export interface EmbeddedItem {
  readonly itemId: string;
  readonly kind: CanonicalItemKind;
  readonly modality: Modality;
  /** Vector of length `dimension`. Never contains NaN/Infinity. */
  readonly vector: readonly number[];
  /** Which text projection produced this vector. */
  readonly projection: string;
  /** SHA-256 of (backendId, modality, projection). */
  readonly contentHash: string;
  /** True when this vector came from the deterministic fallback backend. */
  readonly fallback: boolean;
  readonly backend: {
    readonly id: string;
    readonly kind: EmbeddingBackendKind;
    readonly dimension: number;
  };
}

export interface SourceEmbedding {
  readonly artifactId: string;
  readonly sourceType: string;
  readonly items: readonly EmbeddedItem[];
  /** Modalities present in this source, in first-seen order. */
  readonly modalities: readonly Modality[];
  readonly itemCount: number;
  readonly dimension: number;
  /** Wall-clock at embed completion, ISO. */
  readonly generatedAt: string;
}

export interface EmbedSourceOptions {
  /**
   * Batch size to send to the backend in one `embed` call. Larger batches are
   * cheaper but increase peak memory. Defaults to 32.
   */
  readonly batchSize?: number;
  /**
   * Abort signal to cancel an in-flight embed. Passed to the backend.
   */
  readonly signal?: AbortSignal;
  /**
   * When a backend is not supplied, use the deterministic feature-hashing
   * embedder. The caller must opt in explicitly; without it, a missing
   * backend is an error so nothing is silently faked.
   */
  readonly allowDeterministicFallback?: boolean;
  /** When supplied, cached vectors are reused across runs. */
  readonly cache?: EmbeddingCache;
  /** Max number of concurrent backend calls. Defaults to 1 (backends are often serial). */
  readonly concurrency?: number;
}

/**
 * Embed every item in a canonical source. Items with no embeddable text
 * (e.g. an unlabelled diagram edge) are skipped rather than embedded as a
 * zero vector; the caller sees `itemCount` and can reconcile against
 * `source.itemCount`.
 */
export async function embedCanonicalSource(
  source: CanonicalSource,
  backend: EmbeddingBackend | null,
  options: EmbedSourceOptions = {},
): Promise<SourceEmbedding> {
  if (source === null || typeof source !== "object") {
    throw new EmbeddingError("embedCanonicalSource requires a CanonicalSource.", "invalid-input");
  }
  if (typeof source.artifactId !== "string" || source.artifactId.length === 0) {
    throw new EmbeddingError("CanonicalSource.artifactId is missing.", "invalid-input");
  }
  const effectiveBackend = resolveBackend(backend, options.allowDeterministicFallback === true);
  validateBackend(effectiveBackend);

  const batchSize =
    typeof options.batchSize === "number" && Number.isFinite(options.batchSize) && options.batchSize > 0
      ? Math.floor(options.batchSize)
      : 32;
  const concurrency =
    typeof options.concurrency === "number" && Number.isFinite(options.concurrency) && options.concurrency > 0
      ? Math.floor(options.concurrency)
      : 1;

  // Build the projection list first so we can batch by modality-independent
  // strings and detect empty projections early.
  interface Projected {
    readonly item: CanonicalItem;
    readonly modality: Modality;
    readonly projection: string;
    readonly contentHash: string;
    /** Index into the eventual `items` output. -1 until assigned. */
    outIndex: number;
  }
  const projected: Projected[] = [];
  const cache = options.cache;

  for (const item of source.items) {
    const modality = modalityOf(item.kind);
    const projection = projectItemToText(item);
    if (projection === null) continue;
    // Compute the content hash up-front so cache lookups can happen
    // before any backend call.
    const contentHash = await computeContentHash(projection, modality, effectiveBackend.id);
    projected.push({ item, modality, projection, contentHash, outIndex: -1 });
  }

  // Cache pass: reuse anything we already have.
  const results: (EmbeddedItem | null)[] = projected.map(() => null);
  const pendingIndexes: number[] = [];
  for (let i = 0; i < projected.length; i += 1) {
    const p = projected[i] as Projected;
    const key = cacheKey(effectiveBackend.id, p.contentHash);
    let hit: readonly number[] | null = null;
    if (cache !== undefined) {
      hit = await cache.get(key);
    }
    if (hit !== null && hit !== undefined) {
      if (hit.length !== effectiveBackend.dimension) {
        throw new EmbeddingError(
          `Cached embedding for item ${p.item.itemId} has length ${hit.length} but backend "${effectiveBackend.id}" emits ${effectiveBackend.dimension}. ` +
            `Clear the cache after changing embedding backends or dimensions.`,
          "dimension-mismatch",
        );
      }
      results[i] = buildEmbeddedItem(p.item, p.modality, hit, p.projection, p.contentHash, effectiveBackend);
      p.outIndex = i;
    } else {
      pendingIndexes.push(i);
    }
  }

  // Backend pass: embed the rest in batches, honouring concurrency.
  if (pendingIndexes.length > 0) {
    const batches: number[][] = [];
    for (let i = 0; i < pendingIndexes.length; i += batchSize) {
      batches.push(pendingIndexes.slice(i, i + batchSize));
    }
    const runBatch = async (batch: readonly number[]): Promise<void> => {
      const texts = batch.map((idx) => (projected[idx] as Projected).projection);
      let vectors: readonly (readonly number[])[];
      try {
        vectors = await effectiveBackend.embed(texts, { signal: options.signal });
      } catch (err) {
        throw new EmbeddingError(
          `Embedding backend "${effectiveBackend.id}" failed: ${(err as Error).message ?? String(err)}`,
          "backend-failed",
        );
      }
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new EmbeddingError(
          `Embedding backend "${effectiveBackend.id}" returned ${vectors?.length ?? 0} vectors for ${texts.length} texts. Backends MUST return one vector per input.`,
          "backend-failed",
        );
      }
      for (let j = 0; j < batch.length; j += 1) {
        const idx = batch[j] as number;
        const p = projected[idx] as Projected;
        const vec = vectors[j];
        if (!Array.isArray(vec) || vec.length !== effectiveBackend.dimension) {
          throw new EmbeddingError(
            `Embedding backend "${effectiveBackend.id}" returned a vector of length ${vec?.length ?? 0} for item ${p.item.itemId}; expected ${effectiveBackend.dimension}.`,
            "dimension-mismatch",
          );
        }
        for (const v of vec) {
          if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new EmbeddingError(
              `Embedding backend "${effectiveBackend.id}" returned a non-finite component for item ${p.item.itemId}.`,
              "backend-failed",
            );
          }
        }
        results[idx] = buildEmbeddedItem(p.item, p.modality, vec, p.projection, p.contentHash, effectiveBackend);
        p.outIndex = idx;
        if (cache !== undefined) {
          await cache.set(cacheKey(effectiveBackend.id, p.contentHash), vec);
        }
      }
    };
    if (concurrency <= 1) {
      for (const batch of batches) {
        await runBatch(batch);
      }
    } else {
      // Simple worker pool over the batch list.
      let cursor = 0;
      const workers: Promise<void>[] = [];
      const n = Math.min(concurrency, batches.length);
      for (let w = 0; w < n; w += 1) {
        workers.push(
          (async () => {
            while (true) {
              const i = cursor;
              cursor += 1;
              if (i >= batches.length) return;
              const batch = batches[i] as number[];
              await runBatch(batch);
            }
          })(),
        );
      }
      await Promise.all(workers);
    }
  }

  const items: EmbeddedItem[] = [];
  const modalitySeen = new Set<Modality>();
  const modalities: Modality[] = [];
  for (const r of results) {
    if (r === null) continue;
    items.push(r);
    if (!modalitySeen.has(r.modality)) {
      modalitySeen.add(r.modality);
      modalities.push(r.modality);
    }
  }

  return {
    artifactId: source.artifactId,
    sourceType: source.sourceType,
    items,
    modalities,
    itemCount: items.length,
    dimension: effectiveBackend.dimension,
    generatedAt: new Date().toISOString(),
  };
}

function buildEmbeddedItem(
  item: CanonicalItem,
  modality: Modality,
  vector: readonly number[],
  projection: string,
  contentHash: string,
  backend: EmbeddingBackend,
): EmbeddedItem {
  return {
    itemId: item.itemId,
    kind: item.kind,
    modality,
    vector: vector.slice(),
    projection,
    contentHash,
    fallback: backend.kind === "feature-hashing",
    backend: {
      id: backend.id,
      kind: backend.kind,
      dimension: backend.dimension,
    },
  };
}

function cacheKey(backendId: string, contentHash: string): string {
  // Namespaced so two backends with the same hash never collide.
  return `${backendId}::${contentHash}`;
}

/* -------------------------------------------------------------------------- */
/* Backend resolution and validation                                           */
/* -------------------------------------------------------------------------- */

function resolveBackend(
  backend: EmbeddingBackend | null,
  allowFallback: boolean,
): EmbeddingBackend {
  if (backend !== null && backend !== undefined) return backend;
  if (!allowFallback) {
    throw new EmbeddingError(
      "No embedding backend was supplied. Provide an EmbeddingBackend (e.g. an Ollama/vLLM adapter) or set `allowDeterministicFallback: true` to use the deterministic feature-hashing embedder for development.",
      "backend-not-configured",
    );
  }
  return createFeatureHashingBackend();
}

function validateBackend(b: EmbeddingBackend): void {
  if (typeof b.id !== "string" || b.id.length === 0) {
    throw new EmbeddingError("EmbeddingBackend.id must be a non-empty string.", "invalid-input");
  }
  if (
    typeof b.dimension !== "number" ||
    !Number.isFinite(b.dimension) ||
    b.dimension <= 0 ||
    !Number.isInteger(b.dimension)
  ) {
    throw new EmbeddingError(
      `EmbeddingBackend.dimension must be a positive integer (got ${String(b.dimension)}).`,
      "invalid-input",
    );
  }
  if (typeof b.embed !== "function") {
    throw new EmbeddingError("EmbeddingBackend.embed must be a function.", "invalid-input");
  }
}

/* -------------------------------------------------------------------------- */
/* Deterministic fallback backend                                              */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic feature-hashing embedder. Converts a text into a bag of
 * character n-grams (n=2..4) and word tokens, hashes each into a bucket in
 * a fixed-dimensional vector, applies sublinear term-frequency scaling and
 * L2 normalisation. This is the standard "hashing trick" projection, not a
 * model — it produces the *same* vector for the *same* text every run and
 * meaningful lexical similarity (not semantic).
 *
 * It is intended for tests and for development without a local model, and it
 * is labelled `kind: "feature-hashing"` on every vector so it cannot be
 * mistaken for a real embedding in stored data.
 *
 * Determinism is achieved by a fixed 32-bit FNV-1a hash; the JS engine's
 * `Math.random` is never used.
 */
export function createFeatureHashingBackend(dimension = 256): EmbeddingBackend {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new EmbeddingError(
      `createFeatureHashingBackend requires a positive integer dimension (got ${String(dimension)}).`,
      "invalid-input",
    );
  }
  return {
    id: `feature-hashing:d${dimension}`,
    kind: "feature-hashing",
    dimension,
    async embed(texts) {
      const out: number[][] = [];
      for (const text of texts) {
        out.push(hashEmbed(text, dimension));
      }
      return out;
    },
  };
}

function hashEmbed(text: string, dimension: number): number[] {
  const vec = new Array<number>(dimension).fill(0);
  const normalized = text.toLowerCase();
  // Words.
  for (const tok of normalized.split(/\s+/)) {
    if (tok.length === 0) continue;
    addFeature(vec, `w:${tok}`, 1, dimension);
  }
  // Character n-grams (2..4) for sub-word robustness.
  const compact = normalized.replace(/\s+/g, " ");
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i + n <= compact.length; i += 1) {
      addFeature(vec, `c${n}:${compact.slice(i, i + n)}`, 0.5, dimension);
    }
  }
  // Sublinear term-frequency scaling + L2 normalise.
  let sumSquares = 0;
  for (let i = 0; i < dimension; i += 1) {
    const v = vec[i] as number;
    const scaled = v > 0 ? 1 + Math.log(v) : 0;
    vec[i] = scaled;
    sumSquares += scaled * scaled;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm > 0) {
    for (let i = 0; i < dimension; i += 1) {
      vec[i] = (vec[i] as number) / norm;
    }
  }
  return vec;
}

function addFeature(vec: number[], feature: string, weight: number, dimension: number): void {
  const h = fnv1a32(feature);
  // Signed hashing reduces collision bias.
  const idx = h % dimension;
  const sign = ((h >>> 31) & 1) === 0 ? 1 : -1;
  vec[idx] = (vec[idx] as number) + sign * weight;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // FNV prime = 16777619; use Math.imul for 32-bit multiply.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Vector utilities (used by callers and tests)                                */
/* -------------------------------------------------------------------------- */

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new EmbeddingError(
      `Cosine similarity requires equal-length vectors (${a.length} vs ${b.length}).`,
      "dimension-mismatch",
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
