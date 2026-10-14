/**
 * Zipy AI — content hashing primitives.
 *
 * Content addressing is load-bearing for three behaviours:
 *   1. Dedupe on ingest: re-uploading identical bytes must not trigger
 *      re-ingestion or re-generation. The artifact table stores the SHA-256
 *      of every stored object; this module is the one place that computes it.
 *   2. Cache keys for LLM outputs (`packages/llm/src/cache.ts`, later phase):
 *      identical prompts must produce identical keys across processes, so the
 *      hash must be stable across Node versions and platforms.
 *   3. Versioning: `ARTIFACT_VERSIONS_TABLE.content_hash` distinguishes
 *      "same bytes, new version row" from a genuine content change.
 *
 * Design notes:
 *  - All hashes are SHA-256, hex-encoded, lowercase, 64 characters. The DB
 *    CHECK constraints on `artifacts.content_hash` and related columns expect
 *    exactly `^[0-9a-f]{64}$`; `isContentHash` mirrors that predicate so
 *    callers can validate before insert and get a useful error.
 *  - `hashBytes` is the byte-oriented alias used by the artifact upload route
 *    (returns both digest and byte size). `hashBuffer` is the buffer/string
 *    variant. Both go through the same underlying digest so a caller reading
 *    `hashBytes(buf).sha256` and `hashBuffer(buf)` receives the same value.
 *  - `hashStream` consumes a Node Readable once and returns both the digest
 *    and the byte count. Callers that need bytes as well are expected to tee
 *    the stream themselves (the local driver already does so on `put`).
 *  - `stableStringify` is mirrored from `@zipy/jobs/queue` so prompt-cache
 *    keys and enqueue idempotency keys share the same canonicalization. It is
 *    re-implemented (not imported) so `@zipy/hashing` has no dependency on
 *    `@zipy/jobs` — that package depends on Postgres and must not be dragged
 *    into the browser-side content pipeline or into SDK bundles.
 *  - No credentials, no network, no state. This module is pure.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Lowercase hex-encoded SHA-256. Kept as a regex matching the DB CHECK. */
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Algorithm name surfaced in error messages and diagnostics. */
export const CONTENT_HASH_ALGORITHM = "sha256" as const;

/** Hash of the empty byte string; useful for the "empty input" edge case. */
export const EMPTY_CONTENT_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

export class ContentHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentHashError";
  }
}

/** True when `value` is a well-formed SHA-256 hex digest, as stored in the DB. */
export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && CONTENT_HASH_PATTERN.test(value);
}

/**
 * Assert `value` is a well-formed hash, raising a descriptive error otherwise.
 * Use before inserting a hash into a column whose CHECK constraint would
 * otherwise fail with an opaque message.
 */
export function assertContentHash(value: unknown, label = "content hash"): string {
  if (!isContentHash(value)) {
    throw new ContentHashError(
      `Invalid ${label}: expected 64 lowercase hex characters, received ${JSON.stringify(
        typeof value === "string" ? value.slice(0, 80) : value,
      )}.`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Byte/buffer hashing                                                         */
/* -------------------------------------------------------------------------- */

export type HashableInput = Buffer | Uint8Array | Uint8Array[] | string;

function toBuffer(input: HashableInput, label: string): Buffer {
  if (typeof input === "string") return Buffer.from(input, "utf8");
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) {
    for (const part of input) {
      if (!(part instanceof Uint8Array) && !Buffer.isBuffer(part)) {
        throw new ContentHashError(
          `hashBuffer(${label}): array elements must be Buffers or Uint8Arrays.`,
        );
      }
    }
    return Buffer.concat(
      input.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)),
    );
  }
  throw new ContentHashError(
    `hashBuffer(${label}): unsupported input type ${Object.prototype.toString.call(input)}.`,
  );
}

/**
 * SHA-256 of a buffer/string. Returns lowercase hex.
 *
 * Note: strings are treated as UTF-8. Callers who need Unicode normalization
 * (NFC for text, NFD for compatibility comparison) must normalize first; the
 * hash function deliberately does not, so two differently-normalized strings
 * that normalize to the same value still hash differently. That is the safe
 * default for content addressing — bytes are bytes.
 */
export function hashBuffer(input: HashableInput, label = "input"): string {
  const buffer = toBuffer(input, label);
  return createHash(CONTENT_HASH_ALGORITHM).update(buffer).digest("hex");
}

/** Convenience: hash a UTF-8 string. Equivalent to `hashBuffer(str)`. */
export function hashText(text: string): string {
  if (typeof text !== "string") {
    throw new ContentHashError("hashText requires a string argument.");
  }
  return hashBuffer(text, "text");
}

/** SHA-256 and byte length for a buffer/string in one pass. */
export interface HashedPayload {
  readonly sha256: string;
  readonly size: number;
}

/**
 * SHA-256 plus byte length for a byte-oriented input. This is the primitive
 * used by `POST /api/artifacts/upload` and by the worker when it re-reads an
 * object to verify its digest before reuse. Accepts Buffer, Uint8Array, or a
 * string (hashed as UTF-8), consistent with `hashBuffer`.
 */
export function hashBytes(input: HashableInput, label = "bytes"): HashedPayload {
  const buffer = toBuffer(input, label);
  return {
    sha256: createHash(CONTENT_HASH_ALGORITHM).update(buffer).digest("hex"),
    size: buffer.byteLength,
  };
}

/** Alias kept for callers that prefer the more explicit name. */
export const hashBufferWithSize = hashBytes;

/* -------------------------------------------------------------------------- */
/* Stream hashing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Hash a Node Readable without buffering the whole thing. Returns the digest
 * and the number of bytes consumed. The stream is destroyed on error; on
 * success it has been fully consumed (i.e., ended) as normal.
 *
 * A pre-existing `sha256` hash can be supplied to continue a multipart hash.
 * Passing it is advanced usage: the digest corresponds to the *concatenation*
 * of everything hashed so far plus this stream.
 */
export async function hashStream(
  stream: Readable,
  label = "stream",
  seed?: { readonly algorithm?: "sha256"; readonly digestSoFar?: Buffer },
): Promise<HashedPayload> {
  if (
    !(stream instanceof Readable) &&
    typeof (stream as { pipe?: unknown }).pipe !== "function"
  ) {
    throw new ContentHashError(
      `hashStream(${label}): expected a Node Readable but received ${Object.prototype.toString.call(
        stream,
      )}.`,
    );
  }
  const hash = createHash(CONTENT_HASH_ALGORITHM);
  if (seed?.digestSoFar) {
    hash.update(seed.digestSoFar);
  }
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<unknown>) {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.from(chunk as ArrayBufferLike | string);
      size += buf.byteLength;
      hash.update(buf);
    }
  } catch (error) {
    throw new ContentHashError(
      `hashStream(${label}) failed after ${size} byte(s): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { sha256: hash.digest("hex"), size };
}

/**
 * Wrap a Readable so that every byte passing through is fed to a SHA-256 hash.
 * Useful for the S3 driver's streaming path (a future optimization over its
 * current full-buffer read) and for export bundling. The returned handle
 * exposes the final digest through `digest()` after the stream has ended.
 */
export interface HashingStreamHandle {
  readonly stream: Readable;
  /** Resolves once the source is exhausted; rejects if the source errors. */
  digest(): Promise<HashedPayload>;
}

export function teeHashing(source: Readable, label = "stream"): HashingStreamHandle {
  const hash = createHash(CONTENT_HASH_ALGORITHM);
  let size = 0;
  const pass = new Readable({
    read(): void {
      /* Pull mode; data is pushed from the source's data events below. */
    },
  });
  const done = new Promise<HashedPayload>((resolve, reject) => {
    source.on("data", (chunk: unknown) => {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.from(chunk as ArrayBufferLike | string);
      size += buf.byteLength;
      hash.update(buf);
      if (!pass.push(buf)) {
        source.pause();
        pass.once("drain", () => source.resume());
      }
    });
    source.on("end", () => {
      pass.push(null);
      resolve({ sha256: hash.digest("hex"), size });
    });
    source.on("error", (error) => {
      pass.destroy(error instanceof Error ? error : new Error(String(error)));
      reject(
        new ContentHashError(
          `teeHashing(${label}) source error after ${size} byte(s): ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    });
  });
  return { stream: pass, digest: () => done };
}

/* -------------------------------------------------------------------------- */
/* Canonical JSON                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic JSON serialization: object keys are sorted recursively,
 * `undefined` object values are dropped (matching JSON.stringify), and arrays
 * preserve order. Two structurally-equal values always produce identical
 * output regardless of property insertion order.
 *
 * Used for two things:
 *   - LLM output cache keys (identical prompt payloads must hash the same);
 *   - ingestion dedupe keys where the "input" is a structured request
 *     (`{url, waitFor, viewport}`) rather than a byte stream.
 *
 * This is a deliberate re-implementation of `stableStringify` in
 * `@zipy/jobs/queue` so `@zipy/hashing` stays dependency-free. Keep the two in
 * sync if the canonicalization rules ever change.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      // Non-finite numbers are not valid JSON; JSON.stringify emits "null".
      return "null";
    }
    if (typeof value === "bigint") {
      throw new ContentHashError(
        "stableStringify cannot serialize bigint without a caller-supplied encoding.",
      );
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") {
      // JSON.stringify drops these at the object level; at the top level it
      // returns undefined, which we surface as a hard error for hashing.
      throw new ContentHashError(
        `stableStringify received a non-serializable top-level ${typeof value}.`,
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/** Hash a JSON-serializable value using the canonical stringifier. */
export function hashJson(value: unknown, label = "json"): string {
  let canonical: string;
  try {
    canonical = stableStringify(value);
  } catch (error) {
    throw new ContentHashError(
      `hashJson(${label}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return hashBuffer(canonical, label);
}

/* -------------------------------------------------------------------------- */
/* Dedupe helpers for ingest requests                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute an ingestion dedupe key from the request shape. This is the value
 * the artifact ingest route compares against prior jobs/artifacts to decide
 * whether a re-upload is a no-op. It intentionally hashes the *semantic*
 * request (fields the caller can control, with optional noise removed) rather
 * than the raw multipart body, because the body bytes are hashed separately
 * once they arrive in the object store.
 *
 * Callers pass `{ source: <kind>, ...facet }` and get a hex digest. The
 * `source` field distinguishes e.g. an image upload from a PDF with the same
 * SHA-256 (which cannot actually happen, but the discipline protects against
 * a future dual-encoding). Keep this stable: changing it invalidates every
 * stored dedupe key.
 */
export interface IngestDedupeInput {
  readonly workspaceId: string;
  readonly source: string;
  /** Optional content hash when bytes are already known (uploads). */
  readonly contentHash?: string | null;
  /** Optional semantic identity (e.g. URL + waitFor + viewport). */
  readonly semantic?: Record<string, unknown> | null;
}

export function deriveIngestDedupeKey(input: IngestDedupeInput): string {
  if (!input.workspaceId) {
    throw new ContentHashError("deriveIngestDedupeKey requires a workspaceId.");
  }
  if (!input.source) {
    throw new ContentHashError("deriveIngestDedupeKey requires a source kind.");
  }
  if (input.contentHash !== undefined && input.contentHash !== null) {
    assertContentHash(input.contentHash, "contentHash");
  }
  return hashJson(
    {
      workspaceId: input.workspaceId,
      source: input.source,
      contentHash: input.contentHash ?? null,
      semantic: input.semantic ?? null,
    },
    "ingest-dedupe",
  );
}
