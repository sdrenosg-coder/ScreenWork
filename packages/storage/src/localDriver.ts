/**
 * Zipy AI — local filesystem object-store driver.
 *
 * Writes objects beneath `config.storage.localRoot` and treats that directory
 * as a bucket root. Every write is atomic (write to a sibling `.tmp` file, fsync
 * the directory entry, then rename over the destination) so a crashed worker
 * never leaves a partially-written object readable.
 *
 * Design notes:
 *  - Path traversal is prevented by resolving the joined path and verifying it
 *    stays under the configured root. `buildObjectKey` already restricts the
 *    character class, but the resolve-and-compare check is the hard guarantee.
 *  - SHA-256 is computed during the write; the hash is returned so callers can
 *    persist it as the dedupe/content key without re-reading the object.
 *  - `signedUrl` returns a `file://` URL. This is a development affordance only;
 *    in production the app should serve object bytes through an authenticated
 *    route. The driver emits a warning to stderr on first use in production to
 *    avoid a silent misconfiguration.
 *  - No credentials are required or invented.
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  promises as fsp,
} from "node:fs";
import { once } from "node:events";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  ObjectNotFoundError,
  StorageConfigError,
  registerObjectStoreDriver,
  type GetObjectResult,
  type GetObjectStreamResult,
  type ListObjectsInput,
  type ListObjectsResult,
  type ObjectMetadata,
  type ObjectStoreDriver,
  type PutObjectInput,
  type PutObjectResult,
  type SignedUrlInput,
} from "./objectStore.ts";

interface LocalStorageConfig {
  readonly root: string;
  readonly isProduction: boolean;
}

/** Load just the storage slice of central config without importing the whole app. */
async function loadStorageConfig(): Promise<LocalStorageConfig> {
  const root = process.env.STORAGE_LOCAL_ROOT ?? process.env.OBJECT_STORE_LOCAL_ROOT;
  if (!root || root.trim().length === 0) {
    throw new StorageConfigError(
      "Local storage driver requires STORAGE_LOCAL_ROOT (or OBJECT_STORE_LOCAL_ROOT) to be set.",
      ["STORAGE_LOCAL_ROOT"],
    );
  }
  return {
    root: resolve(root),
    isProduction: (process.env.NODE_ENV ?? "development") === "production",
  };
}

/* -------------------------------------------------------------------------- */
/* Path safety                                                                 */
/* -------------------------------------------------------------------------- */

function resolveObjectPath(root: string, key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new StorageConfigError("Object key must be a non-empty string.", []);
  }
  const candidate = isAbsolute(key) ? key : join(root, key);
  const resolved = resolve(candidate);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel === "" || rel.startsWith(`..${sep}`)) {
    throw new StorageConfigError(
      `Refusing to access path outside the storage root: ${key}`,
      [],
    );
  }
  return resolved;
}

async function ensureDirFor(filePath: string): Promise<void> {
  await fsp.mkdir(dirname(filePath), { recursive: true });
}

/* -------------------------------------------------------------------------- */
/* Body normalisation + hashing                                               */
/* -------------------------------------------------------------------------- */

async function materializeBody(
  body: PutObjectInput["body"],
): Promise<{ buffer: Buffer; sha256: string; size: number }> {
  let buffer: Buffer;
  if (typeof body === "string") {
    buffer = Buffer.from(body, "utf8");
  } else if (Buffer.isBuffer(body)) {
    buffer = body;
  } else if (body instanceof Uint8Array) {
    buffer = Buffer.from(body);
  } else if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    buffer = Buffer.concat(chunks);
  } else {
    throw new StorageConfigError(
      "Unsupported body type for object store put.",
      [],
    );
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return { buffer, sha256, size: buffer.byteLength };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Driver implementation                                                       */
/* -------------------------------------------------------------------------- */

class LocalObjectStoreDriver implements ObjectStoreDriver {
  readonly name = "local";
  private readonly root: string;
  private readonly isProduction: boolean;
  private warnedAboutSignedUrl = false;

  constructor(config: LocalStorageConfig) {
    this.root = config.root;
    this.isProduction = config.isProduction;
  }

  /** Ensure the root exists on first use rather than at construction time. */
  async init(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const { buffer, sha256, size } = await materializeBody(input.body);
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
      throw new StorageConfigError(
        `SHA-256 mismatch on put: expected ${input.expectedSha256}, computed ${sha256}.`,
        [],
      );
    }
    const target = resolveObjectPath(this.root, input.key);
    await ensureDirFor(target);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, buffer);
    // fsync the temporary file so the rename publishes fully-durable bytes.
    const handle = await fsp.open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, target);
    return {
      key: input.key,
      size,
      sha256,
      contentType: input.contentType ?? null,
    };
  }

  async get(key: string): Promise<GetObjectResult> {
    const target = resolveObjectPath(this.root, key);
    let buffer: Buffer;
    try {
      buffer = await fsp.readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObjectNotFoundError(key);
      }
      throw error;
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const stat = await fsp.stat(target);
    return {
      key,
      body: buffer,
      metadata: {
        key,
        size: stat.size,
        contentType: null,
        sha256,
        lastModified: stat.mtime,
        etag: sha256,
      },
    };
  }

  async getStream(key: string): Promise<GetObjectStreamResult> {
    const target = resolveObjectPath(this.root, key);
    try {
      await fsp.access(target);
    } catch {
      throw new ObjectNotFoundError(key);
    }
    const stat = await fsp.stat(target);
    const sha256 = stat.size > 0 ? await hashFile(target) : createHash("sha256").update("").digest("hex");
    return {
      key,
      stream: createReadStream(target),
      metadata: {
        key,
        size: stat.size,
        contentType: null,
        sha256,
        lastModified: stat.mtime,
        etag: sha256,
      },
    };
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    const target = resolveObjectPath(this.root, key);
    try {
      const stat = await fsp.stat(target);
      const sha256 =
        stat.size > 0
          ? await hashFile(target)
          : createHash("sha256").update("").digest("hex");
      return {
        key,
        size: stat.size,
        contentType: null,
        sha256,
        lastModified: stat.mtime,
        etag: sha256,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const target = resolveObjectPath(this.root, key);
    try {
      await fsp.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const target = resolveObjectPath(this.root, key);
    try {
      await fsp.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async list(input: ListObjectsInput): Promise<ListObjectsResult> {
    const base = resolveObjectPath(this.root, input.prefix);
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 1000) : 200;
    const offset = input.cursor ? Number(input.cursor) : 0;
    const collected: ObjectMetadata[] = [];
    let seen = 0;
    let truncated = false;

    let stack: string[] = [base];
    while (stack.length > 0 && !truncated) {
      const dir = stack.pop() as string;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (seen++ < offset) continue;
        if (collected.length >= limit) {
          truncated = true;
          break;
        }
        const stat = await fsp.stat(full);
        const relKey = relative(this.root, full).split(sep).join("/");
        const sha256 =
          stat.size > 0
            ? await hashFile(full)
            : createHash("sha256").update("").digest("hex");
        collected.push({
          key: relKey,
          size: stat.size,
          contentType: null,
          sha256,
          lastModified: stat.mtime,
          etag: sha256,
        });
      }
    }

    return {
      objects: collected,
      cursor: truncated ? String(offset + collected.length) : null,
    };
  }

  async signedUrl(input: SignedUrlInput): Promise<string> {
    if (this.isProduction && !this.warnedAboutSignedUrl) {
      this.warnedAboutSignedUrl = true;
      process.stderr.write(
        "[storage:local] signedUrl() is used in production; local file URLs are not authenticated. Serve objects through an authenticated route instead.\n",
      );
    }
    const target = resolveObjectPath(this.root, input.key);
    return pathToFileURL(target).toString();
  }

  async close(): Promise<void> {
    // Nothing to release for the local driver.
    await Promise.resolve();
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

registerObjectStoreDriver("local", async () => {
  const config = await loadStorageConfig();
  const driver = new LocalObjectStoreDriver(config);
  await driver.init();
  return driver;
});

export { LocalObjectStoreDriver };
