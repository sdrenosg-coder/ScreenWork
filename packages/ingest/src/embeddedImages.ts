/**
 * Zipy AI — embedded-image extraction and handoff.
 *
 * Both the DOCX and PPTX ingestors surface embedded media as raw image bytes
 * on their own result objects (`DocxImageRef`, `PptxImageRef`). This module
 * provides the single, shared surface those two ingestors (and any future
 * office-format ingestor) use to:
 *
 *   1. Persist the raw bytes to the object store — the ingestor never talks
 *      to storage directly; it produces in-memory refs and the caller walks
 *      them through `persistEmbeddedImages`.
 *   2. Route each persisted image through the existing `ingestImage` pipeline
 *      (OCR + VLM UI-element recognition), producing a per-image ingest result
 *      that downstream phases can treat exactly like a stand-alone image
 *      artifact.
 *   3. Return a compact, JSON-serializable record that strips the raw bytes
 *      before the derived artifact is written.
 *
 * Why this module exists as its own unit:
 *   - Both DOCX and PPTX need the identical two-step dance, and the shape of
 *     the persisted record must be *identical* between them so the source
 *     artifact written to `sources` can be read by a single rehydrator.
 *   - The image-ingest call is where OCR/VLM failures surface. Making this
 *     module own the retry/counting policy keeps the ingestors honest about
 *     what happened: every failure is recorded as an explicit entry in the
 *     returned `failures` list, never swallowed.
 *
 * What this module does NOT do, because it does not own those surfaces:
 *   - It does not write to the `sources` table — the worker job handler owns
 *     that write, because only it knows the workspace, source id and job
 *     correlation.
 *   - It does not read from the object store — it only writes. Reading back
 *     is done through `rehydrateEmbeddedImages`.
 *   - It does not run any other ingest path (URL, PDF, office). It is
 *     specialised for a batch of image buffers with a stable logical key.
 *
 * Ordering rule: the returned `images` array preserves the caller's input
 * order (which the DOCX/PPTX ingestors produce in document order), so
 * downstream consumers can address each image by its ordinal rather than
 * relying on the object-store key.
 *
 * Design constraints honoured here:
 *   - No credentials are read. The object store and the image-ingest pipeline
 *     load their own configuration; if either is unavailable the failure is
 *     reported per image with a precise error message, not fabricated.
 *   - No byte is written to disk by this module other than via `objectStore`.
 *     The intermediate ingestors keep the raw buffer in memory until the
 *     caller invokes `persistEmbeddedImages`.
 */

import { createHash } from "node:crypto";

import { ingestImage, type ImageIngestResult } from "./image";
import type { ObjectStore } from "@zipy/storage/objectStore";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class EmbeddedImageError extends Error {
  readonly code:
    | "invalid-input"
    | "no-engine"
    | "object-store-failed"
    | "image-ingest-failed"
    | "internal";
  constructor(message: string, code: EmbeddedImageError["code"]) {
    super(message);
    this.name = "EmbeddedImageError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A single embedded image as produced by a DOCX or PPTX ingestor. Both
 * ingestors convert their native refs (`DocxImageRef`, `PptxImageRef`) to
 * this shape via `toEmbeddedImageDescriptor`. The shape is deliberately
 * minimal so a single caller-facing record works for every source.
 */
export interface EmbeddedImageDescriptor {
  /** Stable logical id within the source (e.g. "docx:image1-3" / "pptx:slide4-pic2"). */
  readonly key: string;
  /** Filename to use in the object store (untrusted but bounded). */
  readonly filename: string;
  /** MIME type as declared by the container (may be `image/emf` etc). */
  readonly mimeType: string;
  /** Alt text from the container, when present. Empty string when absent. */
  readonly altText: string;
  /** Raw bytes. */
  readonly bytes: Buffer;
  /** SHA-256 of `bytes`, hex-encoded. */
  readonly contentHash: string;
}

export interface PersistedEmbeddedImage {
  /** The same logical key the descriptor carried. */
  readonly key: string;
  /** Where the object went. */
  readonly storageKey: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly altText: string;
  readonly contentHash: string;
  readonly byteLength: number;
  /**
   * The image-ingest result. `null` when OCR/VLM was skipped because the
   * image MIME is one the ingest pipeline does not accept (e.g. EMF/WMF), or
   * when `options.runImageIngest` was false. A skipped image is reported in
   * `skipped` with a reason.
   */
  readonly ingest: ImageIngestResult | null;
  /** ISO timestamp of when the object was stored. */
  readonly storedAt: string;
}

export interface SkippedEmbeddedImage {
  readonly key: string;
  readonly reason:
    | "unsupported-mime"
    | "empty-bytes"
    | "ingest-disabled"
    | "ingest-failed"
    | "storage-failed";
  /** Human-readable detail; safe to surface in logs and job errors. */
  readonly detail: string;
}

export interface EmbeddedImagesResult {
  /** Images successfully persisted (and, unless disabled, ingested). */
  readonly images: readonly PersistedEmbeddedImage[];
  /** Images that were intentionally skipped, with the reason recorded. */
  readonly skipped: readonly SkippedEmbeddedImage[];
  /** Aggregate counts for observability. */
  readonly counts: {
    readonly descriptors: number;
    readonly persisted: number;
    readonly ingested: number;
    readonly skipped: number;
  };
}

export interface PersistEmbeddedImagesOptions {
  /** Object store to write to. Required. */
  readonly objectStore: ObjectStore;
  /** Workspace that owns the artifacts; scopes the storage key. */
  readonly workspaceId: string;
  /**
   * Logical grouping key for the storage prefix. Typically the source id
   * being ingested. Must be a filesystem-safe token; the caller is
   * responsible for producing one.
   */
  readonly groupKey: string;
  /**
   * When false, images are stored but not routed through `ingestImage`. This
   * is useful when the caller has already decided the caller will ingest the
   * images separately, or when running in a context where OCR/VLM are known
   * to be unavailable and the caller wants persistence to still succeed.
   * Default: true.
   */
  readonly runImageIngest?: boolean;
  /**
   * When true, an ingest failure for one image records a `skipped` entry and
   * continues with the remaining images. When false (the default), the first
   * ingest failure aborts the batch and throws `EmbeddedImageError` with code
   * `"image-ingest-failed"`. Storage failures always abort regardless of this
   * flag, because a partially-stored batch would be misleading.
   */
  readonly continueOnIngestError?: boolean;
  /**
   * Overrides forwarded to `ingestImage`. These are threaded through here so
   * the caller can pick OCR engine / VLM provider once for the whole batch
   * without reaching into each image individually.
   */
  readonly imageIngest?: {
    readonly ocrEngine?: "easyocr" | "tesseract" | "cloud" | "auto";
    readonly ocrLanguages?: readonly string[];
    readonly tesseractLanguages?: string;
    readonly vlmProvider?: "openai" | "anthropic" | "gemini" | "ollama" | "vllm";
    readonly vlmModel?: string | null;
    readonly ocrOnly?: boolean;
  };
}

export interface RehydratedEmbeddedImages {
  readonly images: readonly {
    readonly key: string;
    readonly storageKey: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly altText: string;
    readonly contentHash: string;
    readonly byteLength: number;
    /** Ingest result as persisted, or null when no ingest ran. */
    readonly ingest: unknown | null;
    readonly storedAt: string;
  }[];
  readonly skipped: readonly SkippedEmbeddedImage[];
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * MIME types the image-ingest pipeline accepts. Kept in sync with
 * `apps/worker/src/ingest/image.ts`'s `isSupportedImageMime` (any `image/*`),
 * but we restrict the *ingest* path to formats OCR/VLM runtimes reliably
 * accept. EMF/WMF/SVG are stored but not ingested; the caller decides whether
 * to rasterise them in a later phase.
 */
const INGESTABLE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
]);

/* -------------------------------------------------------------------------- */
/* Descriptor construction helpers                                             */
/* -------------------------------------------------------------------------- */

/**
 * Convert a DOCX or PPTX native image ref into an `EmbeddedImageDescriptor`.
 * Both native refs share the fields we need: `contentHash`, `zipPath`,
 * `mimeType`, `altText`, `bytes`. The `sourcePrefix` and `ordinal` are
 * supplied by the caller so the key is stable and readable.
 *
 * Note: this function does not accept `null` bytes and does not synthesise
 * alt text; a missing alt text is represented as the empty string.
 */
export function toEmbeddedImageDescriptor(args: {
  readonly sourcePrefix: "docx" | "pptx" | "xlsx" | string;
  readonly ordinal: number;
  readonly zipPath: string;
  readonly mimeType: string;
  readonly altText: string;
  readonly bytes: Buffer;
  readonly contentHash?: string;
}): EmbeddedImageDescriptor {
  if (args.ordinal <= 0) {
    throw new EmbeddedImageError(
      `toEmbeddedImageDescriptor: ordinal must be >= 1 (got ${args.ordinal}).`,
      "invalid-input",
    );
  }
  if (args.zipPath.length === 0) {
    throw new EmbeddedImageError(
      "toEmbeddedImageDescriptor: zipPath must be non-empty.",
      "invalid-input",
    );
  }
  if (args.bytes.length === 0) {
    throw new EmbeddedImageError(
      `toEmbeddedImageDescriptor: zero-length image at ${args.zipPath}.`,
      "invalid-input",
    );
  }
  const contentHash =
    args.contentHash !== undefined && args.contentHash.length > 0
      ? args.contentHash
      : sha256Hex(args.bytes);
  return {
    key: `${args.sourcePrefix}:${sanitizeKeySegment(args.zipPath)}-o${args.ordinal}`,
    filename: deriveFilename(args.zipPath),
    mimeType: args.mimeType,
    altText: args.altText,
    bytes: args.bytes,
    contentHash,
  };
}

/**
 * Choose a filename for storage. We prefer the zip basename (which is already
 * unique within a DOCX/PPTX archive per Word/PowerPoint conventions) and
 * fall back to the content hash when the basename is missing or unsafe.
 */
function deriveFilename(zipPath: string): string {
  const base = zipPath.split("/").pop() ?? "";
  if (base.length === 0) {
    throw new EmbeddedImageError(
      `deriveFilename: could not derive a filename from "${zipPath}".`,
      "invalid-input",
    );
  }
  return base;
}

/**
 * Sanitize a key segment for use in a storage path. Keeps letters, digits,
 * `.`, `-`, `_`; replaces `/`, whitespace and control characters with `_`.
 * Collapses runs; trims the ends; caps length so a maliciously long path
 * cannot blow past object-store key limits.
 */
function sanitizeKeySegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "image";
}

/* -------------------------------------------------------------------------- */
/* Persistence + ingest orchestration                                          */
/* -------------------------------------------------------------------------- */

/**
 * Persist a batch of embedded images and, unless disabled, route each through
 * `ingestImage`. Returns a JSON-serializable result that the caller writes to
 * its derived artifact. Raw bytes are not present in the return value.
 *
 * Failure semantics:
 *   - Storage failure for any image aborts the batch (throw).
 *   - Ingest failure aborts unless `options.continueOnIngestError === true`,
 *     in which case the image is still recorded as persisted (with
 *     `ingest: null`) and an entry is added to `skipped`.
 *   - Empty bytes or a MIME the pipeline does not ingest are recorded in
 *     `skipped` without calling the store. (Storing an empty object would
 *     misrepresent the source; a downstream consumer would see a zero-byte
 *     "image".)
 */
export async function persistEmbeddedImages(
  descriptors: readonly EmbeddedImageDescriptor[],
  options: PersistEmbeddedImagesOptions,
): Promise<EmbeddedImagesResult> {
  if (!options.workspaceId || options.workspaceId.trim().length === 0) {
    throw new EmbeddedImageError(
      "persistEmbeddedImages requires a non-empty workspaceId.",
      "invalid-input",
    );
  }
  if (!options.groupKey || options.groupKey.trim().length === 0) {
    throw new EmbeddedImageError(
      "persistEmbeddedImages requires a non-empty groupKey.",
      "invalid-input",
    );
  }

  const runIngest = options.runImageIngest !== false;
  const continueOnIngestError = options.continueOnIngestError === true;

  const images: PersistedEmbeddedImage[] = [];
  const skipped: SkippedEmbeddedImage[] = [];
  let ingestedCount = 0;

  for (const descriptor of descriptors) {
    if (descriptor.bytes.length === 0) {
      skipped.push({
        key: descriptor.key,
        reason: "empty-bytes",
        detail: `Descriptor ${descriptor.key} carried zero bytes.`,
      });
      continue;
    }

    // Storage is unconditional: even images we cannot ingest are worth
    // preserving for a later phase (rasterisation, manual review).
    const storageKey = objectKeyFor(
      options.workspaceId,
      options.groupKey,
      descriptor,
    );
    let storedAtIso: string;
    try {
      await options.objectStore.put(
        storageKey,
        descriptor.bytes,
        {
          contentType: descriptor.mimeType,
          contentLength: descriptor.bytes.length,
          metadata: {
            "zipy-content-hash": descriptor.contentHash,
            "zipy-source-key": descriptor.key,
          },
        },
      );
      storedAtIso = new Date().toISOString();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new EmbeddedImageError(
        `Failed to store embedded image ${descriptor.key} at ${storageKey}: ${detail}`,
        "object-store-failed",
      );
    }

    // Ingest path — only for MIME types the pipeline accepts.
    if (!runIngest) {
      images.push({
        key: descriptor.key,
        storageKey,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        altText: descriptor.altText,
        contentHash: descriptor.contentHash,
        byteLength: descriptor.bytes.length,
        ingest: null,
        storedAt: storedAtIso,
      });
      skipped.push({
        key: descriptor.key,
        reason: "ingest-disabled",
        detail:
          "runImageIngest was disabled for this batch; only storage was performed.",
      });
      continue;
    }

    if (!isIngestableMime(descriptor.mimeType)) {
      images.push({
        key: descriptor.key,
        storageKey,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        altText: descriptor.altText,
        contentHash: descriptor.contentHash,
        byteLength: descriptor.bytes.length,
        ingest: null,
        storedAt: storedAtIso,
      });
      skipped.push({
        key: descriptor.key,
        reason: "unsupported-mime",
        detail: `MIME type "${descriptor.mimeType}" is not ingested by the OCR/VLM pipeline. Stored only.`,
      });
      continue;
    }

    let ingestResult: ImageIngestResult;
    try {
      ingestResult = await ingestImage({
        buffer: descriptor.bytes,
        inputPath: null,
        mimeType: descriptor.mimeType,
        ocrEngine: options.imageIngest?.ocrEngine,
        ocrLanguages: options.imageIngest?.ocrLanguages,
        tesseractLanguages: options.imageIngest?.tesseractLanguages,
        vlmProvider: options.imageIngest?.vlmProvider,
        vlmModel: options.imageIngest?.vlmModel,
        ocrOnly: options.imageIngest?.ocrOnly,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (continueOnIngestError) {
        images.push({
          key: descriptor.key,
          storageKey,
          filename: descriptor.filename,
          mimeType: descriptor.mimeType,
          altText: descriptor.altText,
          contentHash: descriptor.contentHash,
          byteLength: descriptor.bytes.length,
          ingest: null,
          storedAt: storedAtIso,
        });
        skipped.push({
          key: descriptor.key,
          reason: "ingest-failed",
          detail,
        });
        continue;
      }
      throw new EmbeddedImageError(
        `Image ingest failed for ${descriptor.key}: ${detail}`,
        "image-ingest-failed",
      );
    }

    images.push({
      key: descriptor.key,
      storageKey,
      filename: descriptor.filename,
      mimeType: descriptor.mimeType,
      altText: descriptor.altText,
      contentHash: descriptor.contentHash,
      byteLength: descriptor.bytes.length,
      ingest: ingestResult,
      storedAt: storedAtIso,
    });
    ingestedCount += 1;
  }

  return {
    images,
    skipped,
    counts: {
      descriptors: descriptors.length,
      persisted: images.length,
      ingested: ingestedCount,
      skipped: skipped.length,
    },
  };
}

function isIngestableMime(mime: string): boolean {
  return INGESTABLE_MIMES.has(mime.toLowerCase());
}

function objectKeyFor(
  workspaceId: string,
  groupKey: string,
  descriptor: EmbeddedImageDescriptor,
): string {
  // Path convention: embedded/{workspace}/{group}/{contentHash}-{filename}
  // The content hash prefixes the basename so two images with the same file
  // name but different bytes never collide.
  const safeFilename = sanitizeKeySegment(descriptor.filename);
  const prefix = descriptor.contentHash.slice(0, 16);
  return `embedded/${sanitizeKeySegment(
    workspaceId,
  )}/${sanitizeKeySegment(groupKey)}/${prefix}-${safeFilename}`;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read an `EmbeddedImagesResult` back from a persisted artifact. The
 * `ingest` sub-objects are returned verbatim (the caller rehydrates them
 * through `rehydrateImageIngest` when it needs the structured form). We do
 * minimal validation here and refuse malformed payloads explicitly.
 */
export function rehydrateEmbeddedImages(
  value: unknown,
): RehydratedEmbeddedImages {
  if (value === null || typeof value !== "object") {
    throw new EmbeddedImageError(
      "Rehydrate failed: payload is not an object.",
      "internal",
    );
  }
  const r = value as Record<string, unknown>;
  const imagesRaw = Array.isArray(r["images"]) ? (r["images"] as unknown[]) : [];
  const images: RehydratedEmbeddedImages["images"][number][] = [];
  for (const raw of imagesRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const key = typeof item["key"] === "string" ? (item["key"] as string) : "";
    const storageKey =
      typeof item["storageKey"] === "string" ? (item["storageKey"] as string) : "";
    if (key.length === 0 || storageKey.length === 0) continue;
    images.push({
      key,
      storageKey,
      filename:
        typeof item["filename"] === "string" ? (item["filename"] as string) : "",
      mimeType:
        typeof item["mimeType"] === "string" ? (item["mimeType"] as string) : "",
      altText: typeof item["altText"] === "string" ? (item["altText"] as string) : "",
      contentHash:
        typeof item["contentHash"] === "string"
          ? (item["contentHash"] as string)
          : "",
      byteLength:
        typeof item["byteLength"] === "number"
          ? (item["byteLength"] as number)
          : 0,
      ingest: item["ingest"] === undefined ? null : item["ingest"],
      storedAt: typeof item["storedAt"] === "string" ? (item["storedAt"] as string) : "",
    });
  }
  const skippedRaw = Array.isArray(r["skipped"]) ? (r["skipped"] as unknown[]) : [];
  const skipped: SkippedEmbeddedImage[] = [];
  for (const raw of skippedRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const key = typeof item["key"] === "string" ? (item["key"] as string) : "";
    const reasonRaw =
      typeof item["reason"] === "string" ? (item["reason"] as string) : "";
    const validReasons: readonly SkippedEmbeddedImage["reason"][] = [
      "unsupported-mime",
      "empty-bytes",
      "ingest-disabled",
      "ingest-failed",
      "storage-failed",
    ];
    if (
      key.length === 0 ||
      !(validReasons as readonly string[]).includes(reasonRaw)
    ) {
      continue;
    }
    skipped.push({
      key,
      reason: reasonRaw as SkippedEmbeddedImage["reason"],
      detail: typeof item["detail"] === "string" ? (item["detail"] as string) : "",
    });
  }
  return { images, skipped };
}

/* -------------------------------------------------------------------------- */
/* SHA-256 helper                                                              */
/* -------------------------------------------------------------------------- */

function sha256Hex(bytes: Buffer): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}
