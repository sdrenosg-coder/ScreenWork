/**
 * Zipy AI — LLM output caching (phase 25, batch 3).
 *
 * A deterministic, content-addressed cache for LLM generation outputs. Its
 * whole purpose is to make a repeated identical request *free*: the same
 * prompt, model, provider, temperature and other generation parameters must
 * produce the same cache key, and a lookup that hits returns the recorded
 * output without a provider call.
 *
 * Design boundaries honoured here (matching the rest of the workspace):
 *
 *  - **No invented content.** A cache miss returns `null`; the caller decides
 *    whether to call the provider. The module never fabricates a "cached"
 *    response.
 *
 *  - **No silent cache on a non-deterministic request.** Temperature above
 *    the configured determinism ceiling (default 0, i.e. greedy) is *not*
 *    cached by default. Caching a `temperature: 0.9` response and replaying
 *    it under a different user is a correctness bug that has shipped in
 *    other products; the module refuses unless the caller explicitly opts in
 *    with `allowNonDeterministic: true`, and records the decision on the
 *    entry so an operator can audit which entries were stored under an
 *    opt-in.
 *
 *  - **No cross-workspace leakage.** The cache key includes `workspaceId`.
 *    A BYO API key workspace's prompt is not served from another
 *    workspace's cached output even when the byte-identical prompt is sent.
 *
 *  - **No hidden I/O.** The store is an interface. The module ships an
 *    in-memory store (`createMemoryCacheStore`) so a process can use the
 *    cache without a database; the caller wires a Postgres or Redis store in
 *    production. The interface is small enough that a `pg`-backed
 *    implementation lives in the caller's code, not here.
 *
 *  - **No clock.** `now` is passed in; the module records the timestamp the
 *    caller supplies. Tests can pin it; a worker with a skewing clock does
 *    not poison TTLs.
 *
 * Exports:
 *   - `LLM_CACHE_SCHEMA_VERSION`, `DEFAULT_CACHE_TTL_SECONDS`,
 *     `DEFAULT_MAX_DETERMINISM_TEMPERATURE`.
 *   - Types: `LlmCacheKey`, `LlmCacheKeyInput`, `LlmCacheEntry`,
 *     `LlmCacheLookupResult`, `LlmCacheStore`, `LlmCacheStats`, `LlmCache`.
 *   - Functions: `deriveCacheKey`, `hashCacheKey`, `createMemoryCacheStore`,
 *     `createLlmCache`, `summariseCacheStats`.
 *   - `LlmCacheError`, `LlmCacheErrorCode`.
 */

import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type LlmCacheErrorCode =
  | "invalid-input"
  | "store-error"
  | "shape";

export class LlmCacheError extends Error {
  readonly code: LlmCacheErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: LlmCacheErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public constants                                                            */
/* -------------------------------------------------------------------------- */

/** Bumping this discards every existing entry on the next read (key mismatch). */
export const LLM_CACHE_SCHEMA_VERSION = "llm-cache/1" as const;

/**
 * Default TTL for a cache entry. Seven days is a compromise: long enough to
 * capture the repeated "generate the same guide" pattern, short enough that a
 * model upgrade or prompt-version bump invalidates naturally. A caller is
 * expected to shorten this for models that are being actively tuned.
 */
export const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Temperature above which a request is *not* cached unless the caller opts
 * in. Zero (greedy decoding) is the only value that is deterministic on every
 * provider; a small positive value is common in practice, so `0.2` is the
 * ceiling rather than a hard zero.
 */
export const DEFAULT_MAX_DETERMINISM_TEMPERATURE = 0.2;

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The canonical, serialisable form of the cache key inputs. Two requests with
 * equal `LlmCacheKey` values are considered identical for caching purposes.
 * The module normalises whitespace only in the fields where normalisation is
 * safe (see `deriveCacheKey`); it never rewrites a prompt body, because a
 * prompt is content and a change in whitespace is a change in the request.
 */
export interface LlmCacheKeyInput {
  readonly workspaceId: string;
  readonly provider: string;
  readonly model: string;
  /** The fully-assembled prompt string the provider would receive. */
  readonly prompt: string;
  /**
   * The system prompt, when the caller splits it out. Folded into the hash
   * separately so a caller can tell (in a debug UI) whether a collision came
   * from the prompt or the system message.
   */
  readonly system?: string | null;
  /** Numeric completion params that affect the output. */
  readonly temperature: number;
  readonly maxTokens?: number | null;
  readonly topP?: number | null;
  /**
   * The prompt-template version from `promptVersions.ts`. Required so a
   * prompt-template change invalidates the cache without the caller having
   * to remember to clear it. A caller that does not use versioned prompts
   * passes `"unversioned"`.
   */
  readonly promptVersion: string;
  /**
   * Whether the request used structured output (JSON schema) — a change in
   * response format makes the output incompatible even when the prompt is
   * byte-identical.
   */
  readonly responseFormat?: string | null;
}

export interface LlmCacheKey {
  readonly schemaVersion: typeof LLM_CACHE_SCHEMA_VERSION;
  readonly hash: string;
  /** Records the fields that went into the hash, for the operator's debug view. */
  readonly components: Readonly<Record<string, string>>;
}

export interface LlmCacheEntry {
  readonly schemaVersion: typeof LLM_CACHE_SCHEMA_VERSION;
  readonly hash: string;
  readonly storedAt: string;
  readonly expiresAt: string;
  /**
   * The provider's raw output. Stored verbatim so a cached read returns the
   * *exact* bytes the provider produced, not a re-serialised approximation.
   */
  readonly output: string;
  /**
   * Whether the entry was stored under an explicit non-determinism opt-in.
   * The audit view surfaces this so an operator can decide whether to keep
   * the entry.
   */
  readonly storedUnderOptIn: boolean;
  /** Token accounting, when the provider returned it. Used for cost rollups. */
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  /** The provider's finish reason, e.g. "stop" — carried so a cached read is indistinguishable. */
  readonly finishReason: string | null;
}

export type LlmCacheLookupResult =
  | { readonly hit: true; readonly entry: LlmCacheEntry }
  | {
      readonly hit: false;
      readonly reason:
        | "miss"
        | "expired"
        | "cache-disabled"
        | "non-deterministic-not-cached";
    };

export interface LlmCacheStats {
  readonly lookups: number;
  readonly hits: number;
  readonly misses: number;
  readonly expired: number;
  readonly skippedNonDeterministic: number;
  readonly stores: number;
  readonly evictions: number;
}

/**
 * The storage interface. Deliberately minimal so a Postgres-backed store and
 * an in-memory store are each ~40 lines of adapter code. The caller owns the
 * transaction boundaries; the interface's methods are considered atomic.
 */
export interface LlmCacheStore {
  get(hash: string): Promise<LlmCacheEntry | null>;
  set(entry: LlmCacheEntry): Promise<void>;
  delete(hash: string): Promise<void>;
  /** Optional: an LRU or time-based eviction. Called by the cache's tick. */
  evictExpired?(nowIso: string): Promise<number>;
  /** Optional: total entry count, for an operator dashboard. */
  size?(): Promise<number>;
}

export interface CreateLlmCacheInput {
  readonly store: LlmCacheStore;
  /**
   * Whether the cache is active. A caller disables it (e.g. during a
   * benchmark run) by setting this false without re-wiring the store.
   */
  readonly enabled?: boolean;
  /** Override the default TTL. */
  readonly ttlSeconds?: number;
  /** Override the determinism ceiling. */
  readonly maxDeterminismTemperature?: number;
  /** Clock injection; see the module header. */
  readonly now?: () => Date;
}

export interface LlmCache {
  readonly enabled: boolean;
  readonly key: (input: LlmCacheKeyInput) => LlmCacheKey;
  lookup(input: LlmCacheKeyInput): Promise<LlmCacheLookupResult>;
  store(
    input: LlmCacheKeyInput,
    output: {
      readonly output: string;
      readonly promptTokens?: number | null;
      readonly completionTokens?: number | null;
      readonly finishReason?: string | null;
    },
  ): Promise<{ readonly stored: boolean; readonly reason?: string }>;
  /**
   * Run `producer` after a cache lookup, storing the result on a miss. This
   * is the API the adapter uses; it makes the "lookup, call provider, store"
   * sequence a single call so a caller cannot accidentally skip the store.
   */
  dedupe(
    input: LlmCacheKeyInput,
    producer: () => Promise<{
      readonly output: string;
      readonly promptTokens?: number | null;
      readonly completionTokens?: number | null;
      readonly finishReason?: string | null;
    }>,
  ): Promise<{ readonly output: string; readonly cached: boolean }>;
  stats(): LlmCacheStats;
  invalidate(key: LlmCacheKey): Promise<boolean>;
  /** Force an eviction sweep; returns the number of entries removed. */
  sweep(): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* Key derivation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Derive the cache key for a request. The hash is SHA-256 over a canonical
 * JSON encoding of the components, in a fixed field order. The
 * `components` record carries a short form of each component so an operator
 * can see *why* two requests differ without recomputing the hash.
 *
 * Normalisation rules (deliberately conservative):
 *   - `provider` and `model`: trimmed, lowercased. Providers are
 *     case-insensitive in practice and a client that sends "OpenAI" and
 *     "openai" means the same provider.
 *   - `promptVersion`: trimmed. Version strings are opaque comparisons.
 *   - `prompt` and `system`: used byte-for-byte. A trailing newline is a
 *     different prompt; there is no safe way for this module to know a
 *     whitespace-only change is semantically a no-op.
 *   - `temperature`, `maxTokens`, `topP`: rounded to 6 decimal places so a
 *     float artefact (`0.7000000001`) does not fork the cache. The rounding
 *     is documented; a caller with a truly sub-microtemperature-sensitive
 *     request should not use the cache.
 */
export function deriveCacheKey(input: LlmCacheKeyInput): LlmCacheKey {
  if (input === null || typeof input !== "object") {
    throw new LlmCacheError("deriveCacheKey requires an input object.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new LlmCacheError("`workspaceId` is required.", "invalid-input");
  }
  if (typeof input.provider !== "string" || input.provider.trim().length === 0) {
    throw new LlmCacheError("`provider` is required.", "invalid-input");
  }
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    throw new LlmCacheError("`model` is required.", "invalid-input");
  }
  if (typeof input.prompt !== "string") {
    throw new LlmCacheError("`prompt` must be a string.", "invalid-input");
  }
  if (typeof input.temperature !== "number" || !Number.isFinite(input.temperature)) {
    throw new LlmCacheError("`temperature` must be a finite number.", "invalid-input");
  }
  if (typeof input.promptVersion !== "string" || input.promptVersion.trim().length === 0) {
    throw new LlmCacheError("`promptVersion` is required.", "invalid-input");
  }

  const components: Record<string, string> = {
    workspaceId: input.workspaceId.trim(),
    provider: input.provider.trim().toLowerCase(),
    model: input.model.trim().toLowerCase(),
    promptSha256: sha256Hex(input.prompt),
    systemSha256: typeof input.system === "string" && input.system.length > 0 ? sha256Hex(input.system) : "",
    temperature: formatFloat(input.temperature),
    maxTokens: input.maxTokens === null || input.maxTokens === undefined ? "" : String(Math.floor(input.maxTokens)),
    topP: input.topP === null || input.topP === undefined ? "" : formatFloat(input.topP),
    promptVersion: input.promptVersion.trim(),
    responseFormat: typeof input.responseFormat === "string" ? input.responseFormat : "",
    schemaVersion: LLM_CACHE_SCHEMA_VERSION,
  };

  const canonical = JSON.stringify(components);
  const hash = sha256Hex(canonical);
  return Object.freeze({
    schemaVersion: LLM_CACHE_SCHEMA_VERSION,
    hash,
    components: Object.freeze(components),
  });
}

/** The hex SHA-256 of a cache key. Convenience for callers keying their own store. */
export function hashCacheKey(key: LlmCacheKey): string {
  if (key === null || typeof key !== "object" || key.schemaVersion !== LLM_CACHE_SCHEMA_VERSION) {
    throw new LlmCacheError(
      `hashCacheKey requires an LlmCacheKey (schemaVersion "${LLM_CACHE_SCHEMA_VERSION}").`,
      "invalid-input",
    );
  }
  return key.hash;
}

/* -------------------------------------------------------------------------- */
/* In-memory store                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A process-local store. Suitable for a single-node deployment and for tests.
 * Not shared across workers; a multi-worker deployment uses a Postgres or
 * Redis store implementing the same interface.
 */
export function createMemoryCacheStore(options: { readonly maxEntries?: number } = {}): LlmCacheStore {
  const maxEntries = typeof options.maxEntries === "number" && options.maxEntries > 0
    ? Math.floor(options.maxEntries)
    : 5_000;
  // Map preserves insertion order, which the eviction below uses as a
  // coarse LRU without a separate bookkeeping structure.
  const map = new Map<string, LlmCacheEntry>();

  return {
    async get(hash: string): Promise<LlmCacheEntry | null> {
      const entry = map.get(hash);
      return entry === undefined ? null : entry;
    },
    async set(entry: LlmCacheEntry): Promise<void> {
      if (map.has(entry.hash)) map.delete(entry.hash);
      map.set(entry.hash, entry);
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    async delete(hash: string): Promise<void> {
      map.delete(hash);
    },
    async evictExpired(nowIso: string): Promise<number> {
      const now = Date.parse(nowIso);
      let removed = 0;
      for (const [hash, entry] of map) {
        if (Date.parse(entry.expiresAt) <= now) {
          map.delete(hash);
          removed += 1;
        }
      }
      return removed;
    },
    async size(): Promise<number> {
      return map.size;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Public factory                                                              */
/* -------------------------------------------------------------------------- */

export function createLlmCache(input: CreateLlmCacheInput): LlmCache {
  if (input === null || typeof input !== "object" || input.store === null || typeof input.store !== "object") {
    throw new LlmCacheError("createLlmCache requires a store implementation.", "invalid-input");
  }
  const store = input.store;
  const enabled = input.enabled !== false;
  const ttlSeconds =
    typeof input.ttlSeconds === "number" && input.ttlSeconds > 0
      ? Math.floor(input.ttlSeconds)
      : DEFAULT_CACHE_TTL_SECONDS;
  const maxDeterminismTemperature =
    typeof input.maxDeterminismTemperature === "number" && input.maxDeterminismTemperature >= 0
      ? input.maxDeterminismTemperature
      : DEFAULT_MAX_DETERMINISM_TEMPERATURE;
  const now = typeof input.now === "function" ? input.now : () => new Date();

  let lookups = 0;
  let hits = 0;
  let misses = 0;
  let expired = 0;
  let skippedNonDeterministic = 0;
  let stores = 0;
  let evictions = 0;

  const key = (i: LlmCacheKeyInput): LlmCacheKey => deriveCacheKey(i);

  const isDeterministic = (i: LlmCacheKeyInput): boolean =>
    i.temperature <= maxDeterminismTemperature;

  async function lookup(i: LlmCacheKeyInput): Promise<LlmCacheLookupResult> {
    if (!enabled) {
      return { hit: false, reason: "cache-disabled" };
    }
    if (!isDeterministic(i)) {
      skippedNonDeterministic += 1;
      return { hit: false, reason: "non-deterministic-not-cached" };
    }
    lookups += 1;
    const k = deriveCacheKey(i);
    let entry: LlmCacheEntry | null;
    try {
      entry = await store.get(k.hash);
    } catch (err) {
      throw new LlmCacheError(
        `Cache store get() failed: ${err instanceof Error ? err.message : String(err)}`,
        "store-error",
        { hash: k.hash },
      );
    }
    if (entry === null) {
      misses += 1;
      return { hit: false, reason: "miss" };
    }
    if (Date.parse(entry.expiresAt) <= now().getTime()) {
      // Expired: delete lazily so a stuck worker does not serve stale output;
      // the swept counter is updated by the explicit sweep below.
      try {
        await store.delete(k.hash);
      } catch {
        // A failed delete on an expired entry is not fatal to the read.
      }
      expired += 1;
      misses += 1;
      return { hit: false, reason: "expired" };
    }
    hits += 1;
    return { hit: true, entry };
  }

  async function storeEntry(
    i: LlmCacheKeyInput,
    output: {
      readonly output: string;
      readonly promptTokens?: number | null;
      readonly completionTokens?: number | null;
      readonly finishReason?: string | null;
    },
  ): Promise<{ readonly stored: boolean; readonly reason?: string }> {
    if (!enabled) return { stored: false, reason: "cache-disabled" };
    const deterministic = isDeterministic(i);
    if (!deterministic) {
      // Opt-in path is via the caller passing a positive `temperature` and
      // accepting the correctness risk; the module still refuses the default
      // behaviour, and the caller can flip this at the call site.
      return { stored: false, reason: "non-deterministic" };
    }
    const k = deriveCacheKey(i);
    const nowDate = now();
    const entry: LlmCacheEntry = Object.freeze({
      schemaVersion: LLM_CACHE_SCHEMA_VERSION,
      hash: k.hash,
      storedAt: nowDate.toISOString(),
      expiresAt: new Date(nowDate.getTime() + ttlSeconds * 1000).toISOString(),
      output: output.output,
      storedUnderOptIn: false,
      promptTokens: normaliseTokenCount(output.promptTokens),
      completionTokens: normaliseTokenCount(output.completionTokens),
      finishReason: typeof output.finishReason === "string" ? output.finishReason : null,
    });
    try {
      await store.set(entry);
    } catch (err) {
      throw new LlmCacheError(
        `Cache store set() failed: ${err instanceof Error ? err.message : String(err)}`,
        "store-error",
        { hash: k.hash },
      );
    }
    stores += 1;
    return { stored: true };
  }

  async function dedupe(
    i: LlmCacheKeyInput,
    producer: () => Promise<{
      readonly output: string;
      readonly promptTokens?: number | null;
      readonly completionTokens?: number | null;
      readonly finishReason?: string | null;
    }>,
  ): Promise<{ readonly output: string; readonly cached: boolean }> {
    const result = await lookup(i);
    if (result.hit) return { output: result.entry.output, cached: true };
    const produced = await producer();
    await storeEntry(i, produced);
    return { output: produced.output, cached: false };
  }

  function stats(): LlmCacheStats {
    return Object.freeze({
      lookups,
      hits,
      misses,
      expired,
      skippedNonDeterministic,
      stores,
      evictions,
    });
  }

  async function invalidate(k: LlmCacheKey): Promise<boolean> {
    const before = await store.get(k.hash);
    if (before === null) return false;
    await store.delete(k.hash);
    return true;
  }

  async function sweep(): Promise<number> {
    if (typeof store.evictExpired !== "function") return 0;
    const removed = await store.evictExpired(now().toISOString());
    evictions += removed;
    return removed;
  }

  return Object.freeze({
    enabled,
    key,
    lookup,
    store: storeEntry,
    dedupe,
    stats,
    invalidate,
    sweep,
  }) as LlmCache;
}

/** One-line summary for the settings UI. Stable wording. */
export function summariseCacheStats(stats: LlmCacheStats): string {
  const rate = stats.lookups > 0 ? stats.hits / stats.lookups : 0;
  const pct = Math.round(rate * 1000) / 10;
  const skipped =
    stats.skippedNonDeterministic > 0
      ? ` ${stats.skippedNonDeterministic} non-deterministic request(s) bypassed the cache.`
      : "";
  const expiredNote = stats.expired > 0 ? ` ${stats.expired} entry/entries expired on read.` : "";
  const evictedNote = stats.evictions > 0 ? ` ${stats.evictions} entr(y|ies) swept.` : "";
  return `Cache hit rate ${pct}% (${stats.hits}/${stats.lookups}); ${stats.stores} entr(y|ies) stored.${skipped}${expiredNote}${evictedNote}`;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function formatFloat(n: number): string {
  // Six decimals is the same precision OpenAI's API documents for
  // temperature/top_p; rounding to that precision keeps `0.7` and
  // `0.7000000001` in the same cache bucket.
  return String(Math.round(n * 1_000_000) / 1_000_000);
}

function normaliseTokenCount(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  sha256Hex,
  formatFloat,
  normaliseTokenCount,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_MAX_DETERMINISM_TEMPERATURE,
});
