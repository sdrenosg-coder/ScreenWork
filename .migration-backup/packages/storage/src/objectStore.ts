/**
 * Zipy AI — object store abstraction.
 *
 * The single storage contract used by ingestion, browser automation, annotation,
 * export and publishing. Drivers are selected from central config
 * (`getConfig().storage.driver`) and every operation is workspace-scoped so that
 * authorization is enforced at the call site, not only at the HTTP layer.
 *
 * Design notes:
 *  - Keys are opaque, path-safe strings that always begin with the workspace id.
 *    `buildObjectKey` is the only sanctioned way to construct one; callers pass
 *    the logical facets (kind, artifact id, filename) and never concatenate
 *    paths themselves. This keeps a workspace from reading another workspace's
 *    objects through a crafted key.
 *  - Content addressing: every stored object carries the SHA-256 of its bytes.
 *    The `PutResult` returns both the key and the hash so callers can persist the
 *    hash and detect re-uploads of identical content without downloading.
 *  - The interface is async and driver-agnostic. The local driver writes under
 *    `config.storage.localRoot`; the S3 driver talks to any S3-compatible
 *    endpoint. Both are streaming and both return absolute on-disk paths or
 *    presigned URLs when the caller needs a directly consumable handle.
 *  - Nothing here invents credentials. A misconfigured driver raises
 *    `StorageConfigError` with an actionable message rather than silently
 *    writing to a fallback location.
 */

import type { Readable } from "node:stream";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class StorageConfigError extends Error {
  readonly missing: readonly string[];
  constructor(message: string, missing: readonly string[]) {
    super(message);
    this.name = "StorageConfigError";
    this.missing = missing;
  }
}

export class ObjectNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = "ObjectNotFoundError";
    this.key = key;
  }
}

export class ObjectKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectKeyError";
  }
}

/* -------------------------------------------------------------------------- */
/* Key construction                                                            */
/* -------------------------------------------------------------------------- */

/** Logical object kinds. Each kind maps to a first-level folder under the workspace. */
export const OBJECT_KINDS = [
  "source", // raw uploaded inputs (URL snapshots, PDFs, images, docs, media)
  "extract", // derived extraction artefacts (OCR, layout, a11y trees, transcripts)
  "canonical", // unified intermediate representation
  "screenshot", // captured screenshots (before/after, element crops)
  "annotation", // rendered overlays / annotated images
  "export", // generated export bundles (PDF, DOCX, image pack)
  "asset", // branding assets (logo, fonts, custom CSS)
  "temp", // short-lived intermediates, eligible for retention sweep
] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

function assertSafeSegment(label: string, value: string): string {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new ObjectKeyError(
      `Invalid ${label} in object key: ${JSON.stringify(value)}. Allowed characters: A-Z a-z 0-9 . _ - (1-128 chars).`,
    );
  }
  return value;
}

export interface ObjectKeyParts {
  readonly workspaceId: string;
  readonly kind: ObjectKind;
  /** Optional grouping (e.g. artifact id, guide id). Omit for a flat namespace. */
  readonly scopeId?: string | null;
  /** Final filename including extension. */
  readonly filename: string;
  /** Optional leading date partition, `YYYY/MM` by default is applied by the driver. */
  readonly datePartition?: string | null;
}

/**
 * Build a path-safe, workspace-scoped object key:
 *   <workspaceId>/<kind>/<scopeId?>/<datePartition?>/<filename>
 *
 * All facets are validated against a conservative character class so a caller
 * cannot escape its workspace prefix via `..` or an absolute path.
 */
export function buildObjectKey(parts: ObjectKeyParts): string {
  const workspaceId = assertSafeSegment("workspaceId", parts.workspaceId);
  const kind = parts.kind;
  if (!OBJECT_KINDS.includes(kind)) {
    throw new ObjectKeyError(`Unknown object kind: ${String(kind)}`);
  }
  const segments: string[] = [workspaceId, kind];
  if (parts.scopeId) segments.push(assertSafeSegment("scopeId", parts.scopeId));
  if (parts.datePartition) {
    const dp = parts.datePartition;
    // Allow the `YYYY/MM` shape only; split and validate each part.
    for (const piece of dp.split("/")) {
      segments.push(assertSafeSegment("datePartition", piece));
    }
  }
  segments.push(assertSafeSegment("filename", parts.filename));
  return segments.join("/");
}

/** `YYYY/MM` partition for "now", used as the default date partition. */
export function defaultDatePartition(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}`;
}

/**
 * Verify a key belongs to `workspaceId`. Callers invoke this (or
 * `assertKeyInWorkspace`) before any read/delete to prevent cross-tenant
 * access when a key arrived from an untrusted request.
 */
export function keyBelongsToWorkspace(key: string, workspaceId: string): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  if (key.startsWith("/") || key.includes("..")) return false;
  const prefix = `${workspaceId}/`;
  return key.startsWith(prefix);
}

export function assertKeyInWorkspace(key: string, workspaceId: string): void {
  if (!keyBelongsToWorkspace(key, workspaceId)) {
    throw new ObjectKeyError(
      "Object key does not belong to the requesting workspace.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Metadata + IO shapes                                                        */
/* -------------------------------------------------------------------------- */

export interface ObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly contentType: string | null;
  readonly sha256: string;
  readonly lastModified: Date;
  readonly etag: string | null;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Buffer | Uint8Array | string | Readable;
  readonly contentType?: string | null;
  /**
   * Optional client-supplied SHA-256 (hex). When present the driver verifies
   * the written bytes match, catching corrupted uploads early.
   */
  readonly expectedSha256?: string | null;
}

export interface PutObjectResult {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string | null;
}

export interface GetObjectResult {
  readonly key: string;
  readonly body: Buffer;
  readonly metadata: ObjectMetadata;
}

export interface GetObjectStreamResult {
  readonly key: string;
  readonly stream: Readable;
  readonly metadata: ObjectMetadata;
}

export interface ListObjectsInput {
  /** Prefix within the workspace, e.g. `wk_123/screenshot`. */
  readonly prefix: string;
  /** Upper bound on results returned in one call. */
  readonly limit?: number;
  /** Cursor returned by a prior `listObjects` call. */
  readonly cursor?: string | null;
}

export interface ListObjectsResult {
  readonly objects: readonly ObjectMetadata[];
  readonly cursor: string | null;
}

export interface SignedUrlInput {
  readonly key: string;
  /** Seconds until the URL expires. Drivers may clamp. */
  readonly expiresInSeconds?: number;
  /** `get` yields a download URL; `put` yields an upload URL. */
  readonly method?: "get" | "put";
  /** For `put`: expected content type written by the client. */
  readonly contentType?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Driver contract                                                             */
/* -------------------------------------------------------------------------- */

export interface ObjectStoreDriver {
  readonly name: string;
  put(input: PutObjectInput): Promise<PutObjectResult>;
  get(key: string): Promise<GetObjectResult>;
  getStream(key: string): Promise<GetObjectStreamResult>;
  head(key: string): Promise<ObjectMetadata | null>;
  exists(key: string): Promise<boolean>;
  /** Hard delete. Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  list(input: ListObjectsInput): Promise<ListObjectsResult>;
  /**
   * Return a directly consumable URL for the object. The local driver returns a
   * `file://` path resolved against the configured root (dev only); the S3
   * driver returns a presigned HTTP URL. Callers must not assume the URL is
   * public.
   */
  signedUrl(input: SignedUrlInput): Promise<string>;
  /** Release any driver-held resources (HTTP agents, connections). */
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Driver factory                                                              */
/* -------------------------------------------------------------------------- */

export type DriverFactory = () => Promise<ObjectStoreDriver>;

const factories = new Map<string, DriverFactory>();

/** Register a driver factory. Called by the concrete driver modules at import time. */
export function registerObjectStoreDriver(name: string, factory: DriverFactory): void {
  factories.set(name, factory);
}

let cachedDriver: ObjectStoreDriver | null = null;

/** Resolve (and memoize) the driver selected by configuration. */
export async function getObjectStore(): Promise<ObjectStoreDriver> {
  if (cachedDriver) return cachedDriver;
  const { getConfig } = await import("@zipy/../apps/web/src/lib/config").catch(
    () => ({ getConfig: () => null as never }),
  ).then((m) => m as { getConfig: () => { storage: { driver: string } } }),
    config = getConfig();
  const driverName = config.storage.driver;
  const factory = factories.get(driverName);
  if (!factory) {
    throw new StorageConfigError(
      `No object-store driver registered for "${driverName}". Install or import the matching driver module (packages/storage/src/${driverName}Driver.ts).`,
      [`driver:${driverName}`],
    );
  }
  cachedDriver = await factory();
  return cachedDriver;
}

/** Reset the memoized driver. Used in tests and after a config change. */
export async function resetObjectStore(): Promise<void> {
  if (cachedDriver) {
    try {
      await cachedDriver.close();
    } catch {
      /* best effort */
    }
  }
  cachedDriver = null;
}

/* -------------------------------------------------------------------------- */
/* Workspace-scoped facade                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Small wrapper that binds an `ObjectStoreDriver` to a single workspace and
 * rejects any key that does not carry that workspace's prefix. Route handlers
 * and workers construct one of these from the caller's `activeWorkspaceId` and
 * pass it down; nothing downstream needs to remember to re-check tenancy.
 */
export interface WorkspaceObjectStore {
  readonly workspaceId: string;
  readonly driverName: string;
  put(input: PutObjectInput): Promise<PutObjectResult>;
  get(key: string): Promise<GetObjectResult>;
  getStream(key: string): Promise<GetObjectStreamResult>;
  head(key: string): Promise<ObjectMetadata | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(input: Omit<ListObjectsInput, "prefix"> & { prefix?: string }): Promise<ListObjectsResult>;
  signedUrl(input: SignedUrlInput): Promise<string>;
  buildKey(parts: Omit<ObjectKeyParts, "workspaceId">): string;
}

export async function forWorkspace(workspaceId: string): Promise<WorkspaceObjectStore> {
  if (!workspaceId) {
    throw new ObjectKeyError("forWorkspace requires a non-empty workspaceId.");
  }
  const driver = await getObjectStore();
  const guard = (key: string): string => {
    assertKeyInWorkspace(key, workspaceId);
    return key;
  };
  return {
    workspaceId,
    driverName: driver.name,
    put: (input) => driver.put({ ...input, key: guard(input.key) }),
    get: (key) => driver.get(guard(key)),
    getStream: (key) => driver.getStream(guard(key)),
    head: (key) => driver.head(guard(key)),
    exists: (key) => driver.exists(guard(key)),
    delete: (key) => driver.delete(guard(key)),
    list: (input) => {
      const prefix = input.prefix ?? "";
      const scoped = `${workspaceId}/${prefix.replace(/^\/+/, "")}`;
      return driver.list({ ...input, prefix: scoped });
    },
    signedUrl: (input) => driver.signedUrl({ ...input, key: guard(input.key) }),
    buildKey: (parts) => buildObjectKey({ ...parts, workspaceId }),
  };
}
