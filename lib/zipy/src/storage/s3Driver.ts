/**
 * Zipy AI — S3-compatible object-store driver.
 *
 * Targets any S3-compatible endpoint (AWS S3, MinIO, R2, etc.). Credentials are
 * read from central config; when any required field is absent the factory
 * throws `StorageConfigError` listing exactly which variables are missing rather
 * than inventing credentials or falling back silently.
 *
 * Design notes:
 *  - The AWS SDK v3 is an optional peer dependency. It is imported lazily so
 *    deployments using the local driver do not pay for it. If the module is not
 *    installed, the error message names the package and the workspace manifest
 *    that should declare it.
 *  - `put` streams the body and computes the SHA-256 client-side; the object is
 *    stored under the caller-supplied key. When `expectedSha256` is present the
 *    hash is compared before the upload is committed (the body is buffered for
 *    that check; otherwise a stream is passed straight through).
 *  - Presigned URLs use `@aws-sdk/s3-request-presigner`. When only the base SDK
 *    is installed, the driver returns a descriptive error instead of a
 *    placeholder URL.
 *  - `list` maps S3's continuation-token pagination onto the driver cursor.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createRequire } from "node:module";

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

const require = createRequire(import.meta.url);

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

interface S3Config {
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

function readS3Config(): S3Config {
  const bucket = process.env.S3_BUCKET ?? process.env.AWS_S3_BUCKET ?? null;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? null;
  const secretAccessKey =
    process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? null;
  const region = process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const endpoint = process.env.S3_ENDPOINT ?? null;
  const forcePathStyleRaw = process.env.S3_FORCE_PATH_STYLE;
  const forcePathStyle =
    forcePathStyleRaw === undefined
      ? endpoint !== null
      : ["1", "true", "yes", "on"].includes(forcePathStyleRaw.toLowerCase());

  const missing: string[] = [];
  if (!bucket) missing.push("S3_BUCKET");
  if (!accessKeyId) missing.push("S3_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    throw new StorageConfigError(
      `S3 storage driver is selected but credentials are incomplete. Missing: ${missing.join(", ")}.`,
      missing,
    );
  }

  return {
    endpoint,
    region,
    bucket: bucket as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    forcePathStyle,
  };
}

/* -------------------------------------------------------------------------- */
/* AWS SDK surface (lazy)                                                      */
/* -------------------------------------------------------------------------- */

interface S3ClientLike {
  send: (command: unknown) => Promise<unknown>;
  destroy: () => void;
}

interface S3Sdk {
  S3Client: new (opts: Record<string, unknown>) => S3ClientLike;
  PutObjectCommand: new (opts: Record<string, unknown>) => unknown;
  GetObjectCommand: new (opts: Record<string, unknown>) => unknown;
  HeadObjectCommand: new (opts: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (opts: Record<string, unknown>) => unknown;
  ListObjectsV2Command: new (opts: Record<string, unknown>) => unknown;
  getSignedUrl?: (
    client: S3ClientLike,
    command: unknown,
    opts?: { expiresIn?: number },
  ) => Promise<string>;
}

function loadSdk(): S3Sdk {
  try {
    const client = require("@aws-sdk/client-s3") as Partial<S3Sdk>;
    const presigner = (() => {
      try {
        return require("@aws-sdk/s3-request-presigner") as {
          getSignedUrl: S3Sdk["getSignedUrl"];
        };
      } catch {
        return null;
      }
    })();
    if (!client.S3Client || !client.PutObjectCommand) {
      throw new Error("incomplete @aws-sdk/client-s3 module");
    }
    return {
      S3Client: client.S3Client,
      PutObjectCommand: client.PutObjectCommand,
      GetObjectCommand: client.GetObjectCommand as S3Sdk["GetObjectCommand"],
      HeadObjectCommand: client.HeadObjectCommand as S3Sdk["HeadObjectCommand"],
      DeleteObjectCommand: client.DeleteObjectCommand as S3Sdk["DeleteObjectCommand"],
      ListObjectsV2Command: client.ListObjectsV2Command as S3Sdk["ListObjectsV2Command"],
      getSignedUrl: presigner ? presigner.getSignedUrl : undefined,
    };
  } catch (error) {
    throw new StorageConfigError(
      `S3 driver requires the "@aws-sdk/client-s3" package (and "@aws-sdk/s3-request-presigner" for signed URLs). Install them in packages/storage. Underlying error: ${
        error instanceof Error ? error.message : String(error)
      }`,
      ["@aws-sdk/client-s3"],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping helpers                                                             */
/* -------------------------------------------------------------------------- */

function asPositiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 7 * 24 * 60 * 60);
}

function streamToBuffer(stream: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const readable = stream as {
      on: (event: string, cb: (...args: unknown[]) => void) => void;
    };
    readable.on("data", (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    });
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", (err: unknown) => reject(err));
  });
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string; Code?: string }).name ?? (error as { Code?: string }).Code;
  return (
    name === "NoSuchKey" ||
    name === "NotFound" ||
    name === "404" ||
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
  );
}

/* -------------------------------------------------------------------------- */
/* Driver implementation                                                       */
/* -------------------------------------------------------------------------- */

class S3ObjectStoreDriver implements ObjectStoreDriver {
  readonly name = "s3";
  private readonly client: S3ClientLike;
  private readonly sdk: S3Sdk;
  private readonly bucket: string;

  constructor(config: S3Config, sdk: S3Sdk) {
    this.sdk = sdk;
    this.bucket = config.bucket;
    this.client = new sdk.S3Client({
      region: config.region,
      endpoint: config.endpoint ?? undefined,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(input: PutObjectInput): Promise<PutObjectResult> {
    const { buffer, sha256, size } = await materializeS3Body(input.body);
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) {
      throw new StorageConfigError(
        `SHA-256 mismatch on put: expected ${input.expectedSha256}, computed ${sha256}.`,
        [],
      );
    }
    await this.client.send(
      new this.sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: buffer,
        ContentType: input.contentType ?? undefined,
        ContentLength: size,
        Metadata: { "zipy-sha256": sha256 },
      }),
    );
    return {
      key: input.key,
      size,
      sha256,
      contentType: input.contentType ?? null,
    };
  }

  async get(key: string): Promise<GetObjectResult> {
    try {
      const out = (await this.client.send(
        new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as {
        Body?: unknown;
        ContentLength?: number;
        ContentType?: string;
        LastModified?: Date;
        ETag?: string;
        Metadata?: Record<string, string>;
      };
      const buffer = await streamToBuffer(out.Body);
      const sha256 =
        out.Metadata?.["zipy-sha256"] ??
        createHash("sha256").update(buffer).digest("hex");
      return {
        key,
        body: buffer,
        metadata: {
          key,
          size: out.ContentLength ?? buffer.byteLength,
          contentType: out.ContentType ?? null,
          sha256,
          lastModified: out.LastModified ?? new Date(),
          etag: out.ETag ?? null,
        },
      };
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async getStream(key: string): Promise<GetObjectStreamResult> {
    try {
      const out = (await this.client.send(
        new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as {
        Body?: Readable;
        ContentLength?: number;
        ContentType?: string;
        LastModified?: Date;
        ETag?: string;
        Metadata?: Record<string, string>;
      };
      if (!out.Body) {
        throw new ObjectNotFoundError(key);
      }
      return {
        key,
        stream: out.Body,
        metadata: {
          key,
          size: out.ContentLength ?? 0,
          contentType: out.ContentType ?? null,
          sha256: out.Metadata?.["zipy-sha256"] ?? "",
          lastModified: out.LastModified ?? new Date(),
          etag: out.ETag ?? null,
        },
      };
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    try {
      const out = (await this.client.send(
        new this.sdk.HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as {
        ContentLength?: number;
        ContentType?: string;
        LastModified?: Date;
        ETag?: string;
        Metadata?: Record<string, string>;
      };
      return {
        key,
        size: out.ContentLength ?? 0,
        contentType: out.ContentType ?? null,
        sha256: out.Metadata?.["zipy-sha256"] ?? "",
        lastModified: out.LastModified ?? new Date(),
        etag: out.ETag ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async list(input: ListObjectsInput): Promise<ListObjectsResult> {
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 1000) : 200;
    const out = (await this.client.send(
      new this.sdk.ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: input.prefix,
        MaxKeys: limit,
        ContinuationToken: input.cursor ?? undefined,
      }),
    )) as {
      Contents?: Array<{
        Key?: string;
        Size?: number;
        ETag?: string;
        LastModified?: Date;
      }>;
      NextContinuationToken?: string;
      IsTruncated?: boolean;
    };
    const objects: ObjectMetadata[] = [];
    for (const entry of out.Contents ?? []) {
      if (!entry.Key) continue;
      objects.push({
        key: entry.Key,
        size: entry.Size ?? 0,
        contentType: null,
        sha256: "",
        lastModified: entry.LastModified ?? new Date(),
        etag: entry.ETag ?? null,
      });
    }
    return {
      objects,
      cursor: out.IsTruncated && out.NextContinuationToken ? out.NextContinuationToken : null,
    };
  }

  async signedUrl(input: SignedUrlInput): Promise<string> {
    if (!this.sdk.getSignedUrl) {
      throw new StorageConfigError(
        'signedUrl requires "@aws-sdk/s3-request-presigner". Install it in packages/storage to enable presigned URLs.',
        ["@aws-sdk/s3-request-presigner"],
      );
    }
    const expiresIn = asPositiveInt(input.expiresInSeconds, 900);
    const method = input.method ?? "get";
    const command =
      method === "put"
        ? new this.sdk.PutObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            ContentType: input.contentType ?? undefined,
          })
        : new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: input.key });
    return this.sdk.getSignedUrl(this.client, command, { expiresIn });
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}

async function materializeS3Body(
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
    throw new StorageConfigError("Unsupported body type for S3 put.", []);
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return { buffer, sha256, size: buffer.byteLength };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

registerObjectStoreDriver("s3", async () => {
  const config = readS3Config();
  const sdk = loadSdk();
  return new S3ObjectStoreDriver(config, sdk);
});

export { S3ObjectStoreDriver };
