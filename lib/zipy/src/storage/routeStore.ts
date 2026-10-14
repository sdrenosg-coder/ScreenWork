/**
 * HTTP route storage adapter.
 *
 * The supplied routes use byte-oriented get(), positional put(), relative
 * tenant keys and entries-oriented list(). The supplied drivers use objects.
 * Keep this reconciliation in one place; retain the drivers and their safety
 * guards, and never expose a tenant's unprefixed key to the underlying driver.
 */
import {
  forWorkspace as scopedStore,
  ObjectNotFoundError,
  ObjectKeyError,
  type PutObjectInput,
} from "./objectStore";
export * from "./objectStore";

type PutOptions = { contentType?: string; expectedSha256?: string; metadata?: Readonly<Record<string, string>> };
function validateKey(key: string, allowEmpty = false): string {
  if (typeof key !== "string" || (!allowEmpty && !key) ||
      key.startsWith("/") || key.includes("..") || key.includes("\\") || key.includes("\0")) {
    throw new ObjectKeyError("Invalid object key.");
  }
  return key;
}

export async function forWorkspace(workspaceId: string) {
  const underlying = await scopedStore(workspaceId);
  const prefix = `${workspaceId}/`;
  const relative = (key: string, allowEmpty = false) => {
    validateKey(key, allowEmpty);
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  };
  const absolute = (key: string) => prefix + relative(key);
  return {
    workspaceId, driverName: underlying.driverName,
    buildKey: underlying.buildKey,
    async put(input: string | PutObjectInput, bytes?: Buffer, options?: PutOptions) {
      const object = typeof input === "string"
        ? { key: input, body: bytes!, ...options } : input;
      return underlying.put({ ...object, key: absolute(object.key) });
    },
    async get(key: string): Promise<Buffer | null> {
      try { return (await underlying.get(absolute(key))).body; }
      catch (error) { if (error instanceof ObjectNotFoundError) return null; throw error; }
    },
    getStream: (key: string) => underlying.getStream(absolute(key)),
    head: (key: string) => underlying.head(absolute(key)),
    exists: (key: string) => underlying.exists(absolute(key)),
    delete: (key: string) => underlying.delete(absolute(key)),
    signedUrl: (input: Parameters<typeof underlying.signedUrl>[0]) =>
      underlying.signedUrl({ ...input, key: absolute(input.key) }),
    async list(input: string | { prefix?: string; limit?: number; cursor?: string | null } = "", options?: { limit?: number; cursor?: string | null }) {
      const params = typeof input === "string" ? { prefix: input, ...options } : input;
      const result = await underlying.list({ ...params, prefix: relative(params.prefix ?? "", true) });
      const entries = result.objects.map(object => ({
        ...object, key: relative(object.key), contentLength: object.size,
        lastModified: object.lastModified.toISOString(),
      }));
      return { entries, objects: entries, cursor: result.cursor, nextCursor: result.cursor };
    },
  };
}

export type ObjectStore = Awaited<ReturnType<typeof forWorkspace>>;
