/**
 * Private, durable object storage using the existing Replit bucket.
 * Keys and the route/workspace guards stay unchanged. Never fall back to local
 * files on cloud errors: that would lose writes and resurrect stale records.
 */
import { Storage, type FileMetadata } from "@google-cloud/storage";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  ObjectKeyError, ObjectNotFoundError, StorageConfigError, registerObjectStoreDriver,
  type ObjectStoreDriver, type PutObjectInput, type PutObjectResult,
  type ObjectMetadata, type ListObjectsInput, type SignedUrlInput,
} from "./objectStore";

const sidecar = "http://127.0.0.1:1106";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => Number((error as { code?: unknown })?.code) === 404;

function safePath(value: string, prefix = false): string {
  const path = prefix ? value.replace(/\/$/, "") : value;
  if (prefix && path === "") return value;
  if (!path || path.includes("\\") || path.split("/").some(part =>
    !/^[A-Za-z0-9._-]{1,256}$/.test(part) || part === "." || part === "..")) {
    throw new ObjectKeyError("Invalid private object path.");
  }
  return value;
}

export class AppStorageDriver implements ObjectStoreDriver {
  readonly name = "app-storage";
  private readonly client = new Storage({
    credentials: {
      audience: "replit", subject_token_type: "access_token", token_url: `${sidecar}/token`,
      type: "external_account", credential_source: {
        url: `${sidecar}/credential`, format: { type: "json", subject_token_field_name: "access_token" },
      }, universe_domain: "googleapis.com",
    }, projectId: "",
  });
  private readonly bucket;
  private readonly root: string;

  constructor(options: { namespace?: string } = {}) {
    const directory = process.env.PRIVATE_OBJECT_DIR?.replace(/^\/+|\/+$/g, "");
    if (!directory) throw new StorageConfigError("Private App Storage is not configured.", ["PRIVATE_OBJECT_DIR"]);
    const [bucket, ...parts] = directory.split("/");
    if (!bucket || parts.some(part => !part || part === ".." || part === ".")) {
      throw new StorageConfigError("Invalid private storage directory.", ["PRIVATE_OBJECT_DIR"]);
    }
    // Never share guide registries/settings between development and production.
    const namespace = safePath(options.namespace ??
      `zipy-platform/${process.env.NODE_ENV === "production" ? "production" : "development"}`);
    this.bucket = this.client.bucket(bucket);
    this.root = [...parts, namespace, "objects", ""].join("/");
  }

  private file(key: string) { return this.bucket.file(this.root + safePath(key)); }

  private metadata(key: string, metadata: FileMetadata): ObjectMetadata {
    return {
      key, size: Number(metadata.size ?? 0), contentType: metadata.contentType ?? null,
      sha256: String(metadata.metadata?.sha256 ?? ""),
      lastModified: new Date(metadata.updated ?? metadata.timeCreated ?? 0),
      etag: metadata.etag ?? null,
    };
  }

  private async write(input: PutObjectInput, createOnly: boolean): Promise<PutObjectResult> {
    const object = this.file(input.key);
    const chunks: Buffer[] = [];
    let bytes: Buffer;
    if (typeof input.body === "string") bytes = Buffer.from(input.body);
    else if (input.body instanceof Readable) {
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      bytes = Buffer.concat(chunks);
    } else bytes = Buffer.from(input.body);
    const hash = sha(bytes);
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== hash) {
      throw new StorageConfigError("SHA-256 mismatch; object was not written.", []);
    }
    await object.save(bytes, {
      resumable: false,
      validation: "crc32c",
      ...(createOnly ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}),
      metadata: {
        contentType: input.contentType ?? "application/octet-stream",
        cacheControl: "private, no-store",
        metadata: { sha256: hash },
      },
    });
    return { key: input.key, size: bytes.length, sha256: hash, contentType: input.contentType ?? null };
  }

  put(input: PutObjectInput) { return this.write(input, false); }
  /** Migration only: a competing or existing object must never be overwritten. */
  putIfAbsent(input: PutObjectInput) { return this.write(input, true); }

  async get(key: string) {
    const object = this.file(key);
    try {
      // The media response carries the metadata for the same generation as its
      // bytes. Avoid a separate metadata GET on every JSON record read.
      let headers: Record<string, string | string[] | undefined> = {};
      const stream = object.createReadStream({ validation: "crc32c", decompress: false });
      stream.on("response", (response: { headers: typeof headers }) => { headers = response.headers; });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks), hash = sha(body);
      const header = (name: string) => typeof headers[name] === "string" ? headers[name] as string : null;
      const expected = header("x-goog-meta-sha256");
      if (expected && expected !== hash) throw new Error("Private object failed SHA-256 verification.");
      return { key, body, metadata: {
        key, size: body.length, sha256: hash,
        contentType: header("content-type"), etag: header("etag"),
        lastModified: new Date(header("last-modified") ?? 0),
      } };
    } catch (error) {
      if (missing(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async getStream(key: string) {
    const object = this.file(key);
    let raw: FileMetadata;
    try { [raw] = await object.getMetadata(); }
    catch (error) { if (missing(error)) throw new ObjectNotFoundError(key); throw error; }
    const metadata = this.metadata(key, raw), hash = createHash("sha256");
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
      flush(callback) {
        if (metadata.sha256 && hash.digest("hex") !== metadata.sha256) callback(new Error("Private object failed SHA-256 verification."));
        else callback();
      },
    });
    const source = this.bucket.file(object.name, { generation: raw.generation }).createReadStream();
    source.on("error", error => stream.destroy(error));
    stream.on("close", () => source.destroy());
    source.pipe(stream);
    return { key, stream, metadata };
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    try { const [raw] = await this.file(key).getMetadata(); return this.metadata(key, raw); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async exists(key: string) { return (await this.head(key)) !== null; }
  async delete(key: string) { await this.file(key).delete({ ignoreNotFound: true }); }

  async list(input: ListObjectsInput) {
    const prefix = this.root + safePath(input.prefix, true);
    const limit = Math.min(1000, Math.max(1, input.limit ?? 200));
    // Bind cursors to the exact requested prefix to prevent accidental leakage
    // when a cursor is reused for a different tenant.
    let pageToken: string | undefined;
    if (input.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (decoded.prefix !== input.prefix || typeof decoded.token !== "string") throw new Error();
        pageToken = decoded.token;
      } catch { throw new ObjectKeyError("Invalid object-list cursor."); }
    }
    const [files, next] = await this.bucket.getFiles({
      prefix, maxResults: limit, autoPaginate: false, ...(pageToken ? { pageToken } : {}),
    });
    const token = next?.pageToken;
    return {
      objects: files.map(file => this.metadata(file.name.slice(this.root.length), file.metadata)),
      cursor: token ? Buffer.from(JSON.stringify({ prefix: input.prefix, token })).toString("base64url") : null,
    };
  }

  async signedUrl(input: SignedUrlInput) {
    const object = this.file(input.key);
    const ttl = Math.max(1, Math.min(input.expiresInSeconds ?? 300, 3600));
    const response = await fetch(`${sidecar}/object-storage/signed-object-url`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket_name: this.bucket.name, object_name: object.name,
        method: input.method === "put" ? "PUT" : "GET",
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Could not sign private object URL (${response.status}).`);
    const result = await response.json() as { signed_url?: string };
    if (!result.signed_url) throw new Error("Storage signer returned no URL.");
    return result.signed_url;
  }

  async close() { /* The SDK owns and reuses its HTTP resources. */ }
}

registerObjectStoreDriver("app-storage", async () => new AppStorageDriver());
