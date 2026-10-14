/**
 * Zipy AI — export: image pack (phase 20, batch 1).
 *
 * Produces the "all screenshots as a ZIP" export. The pack contains one
 * image per `GuideDocumentImage` in document order, plus a `manifest.json`
 * that names each file, its step index, its alt text, its caption, and its
 * provenance refs. The manifest is what makes the pack *usable*: a bare
 * archive of `image1.png`, `image2.png` is imposssible to align with a guide
 * after the fact, and the manifest also carries the disclosure record so a
 * downstream system that ingests the pack can still label it as AI-generated.
 *
 * What this module guarantees:
 *
 *   - **Determinism.** The zip entry order is document order; the filenames
 *     are derived from block id and image id. Passing the same
 *     `GuideDocument` produces byte-identical output.
 *   - **No fabricated images.** An image whose bytes are `null` is *omitted*
 *     from the pack and recorded in the manifest with `"present": false` and
 *     a `reason`. The pack never contains a placeholder PNG.
 *   - **No silent format rewriting.** Bytes are stored exactly as supplied.
 *     The MIME type is carried in the manifest. A consumer that expects
 *     PNGs and receives a WebP will see it in the manifest rather than
 *     discover it by magic-byte sniffing.
 *   - **No compression dependency.** Reuses the same stored-zip writer that
 *     the DOCX renderer uses. Screenshots are already compressed; storing
 *     instead of deflating is both simpler and faster.
 *
 * What this module does *not* do:
 *   - It does not fetch images. The caller must populate
 *     `GuideDocumentImage.bytes` from the object store before calling.
 *   - It does not re-encode. The `@zipy/images` compression phase is upstream
 *     of export; the pack is a straight passthrough so the bytes a user
 *     downloads are the bytes the pipeline produced.
 *   - It does not reorder, deduplicate or crop. Two identical images referenced
 *     by two steps appear twice in the pack (once per step) and are recorded
 *     twice in the manifest — a guide step that reused the same screenshot is
 *     a real guide step, and the reader expects one file per step.
 */

import type { GuideDocument, GuideDocumentImage } from "./types";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ImagePackErrorCode = "invalid-input" | "internal";

export class ImagePackError extends Error {
  readonly code: ImagePackErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ImagePackErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface ImagePackOptions {
  /**
   * Directory inside the zip where image files live. Default: `images`.
   * The manifest paths are prefixed with this value; consumers read the
   * manifest and reconstruct paths without guessing.
   */
  readonly imageDir?: string;
  /**
   * When true, include a `manifest.json` entry in the zip. Default: true.
   * A caller that intends to re-embed the images into a system that
   * understands guide shape can disable it to save bytes.
   */
  readonly includeManifest?: boolean;
  /**
   * When true, include a plain-text `README.txt` at the pack root that names
   * the guide, names the tool that produced the pack, and repeats the AI
   * disclosure if the guide requires one. Default: true.
   */
  readonly includeReadme?: boolean;
  /**
   * ISO timestamp written to the `generatedAt` field of the README and
   * manifest. When omitted, the caller's caller (the export route) has the
   * real clock; this module never invents one. Required when `includeReadme`
   * or `includeManifest` is true and a `generatedAt` is desired; when it is
   * absent and the pack includes those files, the string `"unknown"` is
   * written rather than a fabricated timestamp.
   */
  readonly generatedAt?: string | null;
}

export interface ImagePackManifestEntry {
  /** Path inside the zip. */
  readonly path: string;
  /** `true` when the file has bytes and is present in the zip. */
  readonly present: boolean;
  /** Reason the entry is not present; null when present. */
  readonly reason: string | null;
  /** The block this image belongs to. */
  readonly blockId: string;
  readonly imageId: string;
  /** 1-based step index when the block is a step; null for stand-alone images. */
  readonly stepIndex: number | null;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly altText: string;
  readonly caption: string | null;
  readonly sourceRefs: readonly string[];
}

export interface ImagePackManifest {
  readonly version: "image-pack/1";
  readonly guideSlug: string;
  readonly guideTitle: string;
  readonly generatedAt: string;
  readonly aiGenerated: boolean;
  readonly disclosureLabel: string | null;
  readonly imageDir: string;
  readonly entries: readonly ImagePackManifestEntry[];
}

export interface ImagePackResult {
  readonly bytes: Uint8Array;
  readonly manifest: ImagePackManifest;
  readonly warnings: readonly string[];
  readonly fileCount: number;
  readonly totalImageBytes: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function renderGuideImagePack(
  guide: GuideDocument,
  options: ImagePackOptions = {},
): ImagePackResult {
  if (guide === null || typeof guide !== "object") {
    throw new ImagePackError("renderGuideImagePack requires a GuideDocument.", "invalid-input");
  }
  if (typeof guide.slug !== "string" || guide.slug.length === 0) {
    throw new ImagePackError("GuideDocument is missing a slug.", "invalid-input");
  }

  const warnings: string[] = [];
  const imageDir = sanitizeSegment(options.imageDir ?? "images");
  const includeManifest = options.includeManifest !== false;
  const includeReadme = options.includeReadme !== false;

  const guideTitle = guide.cover.title ?? guide.slug;
  const generatedAt = options.generatedAt !== null && options.generatedAt !== undefined
    ? normalizeIso(options.generatedAt)
    : "unknown";

  const entries: ZipEntry[] = [];
  const manifestEntries: ImagePackManifestEntry[] = [];
  let totalImageBytes = 0;

  const walked = walkImages(guide);
  const seenPaths = new Set<string>();

  for (const ref of walked) {
    const path = uniqueImagePath(imageDir, ref.blockId, ref.image.id, ref.image.mimeType, seenPaths);
    const hasBytes = ref.image.bytes !== null && ref.image.bytes.length > 0;
    if (hasBytes && ref.image.bytes !== null) {
      const bytes = ref.image.bytes;
      entries.push(binaryEntry(path, bytes));
      totalImageBytes += bytes.length;
      manifestEntries.push({
        path,
        present: true,
        reason: null,
        blockId: ref.blockId,
        imageId: ref.image.id,
        stepIndex: ref.stepIndex,
        mimeType: ref.image.mimeType,
        byteLength: bytes.length,
        altText: ref.image.altText,
        caption: ref.image.caption,
        sourceRefs: ref.image.sourceRefs,
      });
    } else {
      const reason = ref.image.bytes === null ? "no-bytes-supplied" : "zero-length";
      manifestEntries.push({
        path,
        present: false,
        reason,
        blockId: ref.blockId,
        imageId: ref.image.id,
        stepIndex: ref.stepIndex,
        mimeType: ref.image.mimeType,
        byteLength: 0,
        altText: ref.image.altText,
        caption: ref.image.caption,
        sourceRefs: ref.image.sourceRefs,
      });
      warnings.push(
        `Image "${ref.image.id}" (block "${ref.blockId}") has no bytes and was omitted from the pack (${reason}).`,
      );
    }
  }

  const manifest: ImagePackManifest = {
    version: "image-pack/1",
    guideSlug: guide.slug,
    guideTitle,
    generatedAt,
    aiGenerated: guide.disclosure.required,
    disclosureLabel: guide.disclosure.label,
    imageDir,
    entries: manifestEntries,
  };

  if (includeManifest) {
    entries.push(textEntry("manifest.json", JSON.stringify(manifest, null, 2)));
  }
  if (includeReadme) {
    entries.push(textEntry("README.txt", buildReadme(guide, guideTitle, manifest, warnings)));
  }

  const bytes = buildStoredZip(entries, DOS_EPOCH);
  return {
    bytes,
    manifest,
    warnings,
    fileCount: entries.length,
    totalImageBytes,
  };
}

/* -------------------------------------------------------------------------- */
/* Walking                                                                     */
/* -------------------------------------------------------------------------- */

interface ImageRef {
  readonly blockId: string;
  readonly stepIndex: number | null;
  readonly image: GuideDocumentImage;
}

function walkImages(guide: GuideDocument): readonly ImageRef[] {
  const out: ImageRef[] = [];
  for (const block of guide.blocks) {
    if (block.kind === "image") {
      out.push({ blockId: block.id, stepIndex: null, image: block.image });
    } else if (block.kind === "step" && block.image !== null) {
      out.push({ blockId: block.id, stepIndex: block.index, image: block.image });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* README                                                                      */
/* -------------------------------------------------------------------------- */

function buildReadme(
  guide: GuideDocument,
  title: string,
  manifest: ImagePackManifest,
  warnings: readonly string[],
): string {
  const lines: string[] = [];
  lines.push(`Zipy AI — image pack`);
  lines.push(`===================`);
  lines.push("");
  lines.push(`Guide: ${title}`);
  if (guide.cover.subtitle !== null && guide.cover.subtitle.length > 0) {
    lines.push(`Subtitle: ${guide.cover.subtitle}`);
  }
  lines.push(`Slug: ${guide.slug}`);
  lines.push(`Generated: ${manifest.generatedAt}`);
  lines.push("");
  lines.push(`Images: ${manifest.entries.filter((e) => e.present).length} of ${manifest.entries.length} step(s) include a screenshot.`);
  lines.push(`Directory: ${manifest.imageDir}/`);
  if (manifest.aiGenerated) {
    lines.push("");
    lines.push(
      `AI DISCLOSURE: ${manifest.disclosureLabel ?? "This content was generated by Zipy AI and should be reviewed before publication."}`,
    );
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of warnings) lines.push(`  - ${w}`);
  }
  if (guide.sources.length > 0) {
    lines.push("");
    lines.push("Sources:");
    for (const s of guide.sources) {
      const refSuffix = s.ref !== null ? ` (${s.ref})` : "";
      lines.push(`  - ${s.kind}: ${s.label}${refSuffix}`);
    }
  }
  lines.push("");
  lines.push("Files in this pack are named to align with the guide's step order.");
  lines.push("See manifest.json for the exact per-image mapping.");
  lines.push("");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Filenames                                                                   */
/* -------------------------------------------------------------------------- */

function uniqueImagePath(
  dir: string,
  blockId: string,
  imageId: string,
  mimeType: string,
  seen: Set<string>,
): string {
  const ext = extensionForMime(mimeType);
  const base = sanitizeSegment(`${blockId}_${imageId}`);
  let candidate = `${dir}/${base}.${ext}`;
  let counter = 2;
  while (seen.has(candidate)) {
    candidate = `${dir}/${base}-${counter}.${ext}`;
    counter += 1;
  }
  seen.add(candidate);
  return candidate;
}

function extensionForMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m === "image/png") return "png";
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  if (m === "image/bmp") return "bmp";
  if (m === "image/tiff") return "tiff";
  if (m === "image/svg+xml") return "svg";
  return "bin";
}

/* -------------------------------------------------------------------------- */
/* Zip writer (same stored format as DOCX)                                     */
/* -------------------------------------------------------------------------- */

const DOS_EPOCH: { readonly date: number; readonly time: number } = {
  date: 0x0021,
  time: 0x0000,
};

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly crc32: number;
}

function textEntry(name: string, content: string): ZipEntry {
  const bytes = textEncoder.encode(content);
  return { name, data: bytes, crc32: crc32(bytes) };
}

function binaryEntry(name: string, bytes: Uint8Array): ZipEntry {
  return { name, data: bytes, crc32: crc32(bytes) };
}

function buildStoredZip(
  entries: readonly ZipEntry[],
  timestamp: { readonly date: number; readonly time: number },
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lh = new DataView(localHeader.buffer);
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, timestamp.time, true);
    lh.setUint16(12, timestamp.date, true);
    lh.setUint32(14, entry.crc32, true);
    lh.setUint32(18, entry.data.length, true);
    lh.setUint32(22, entry.data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    chunks.push(localHeader);
    chunks.push(entry.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, timestamp.time, true);
    cdv.setUint16(14, timestamp.date, true);
    cdv.setUint32(16, entry.crc32, true);
    cdv.setUint32(20, entry.data.length, true);
    cdv.setUint32(24, entry.data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    centralDir.push(cd);

    offset += localHeader.length + entry.data.length;
  }

  const cdLength = centralDir.reduce((sum, cd) => sum + cd.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdLength, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + cdLength + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const c of chunks) { out.set(c, cursor); cursor += c.length; }
  for (const cd of centralDir) { out.set(cd, cursor); cursor += cd.length; }
  out.set(end, cursor);
  return out;
}

/* -------------------------------------------------------------------------- */
/* CRC-32                                                                      */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ b) & 0xff] ?? 0)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

const textEncoder = new TextEncoder();

function sanitizeSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "asset";
}

function normalizeIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new ImagePackError(
      `Invalid ISO timestamp: ${iso}`,
      "invalid-input",
      { timestamp: iso },
    );
  }
  return new Date(t).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  crc32,
  buildStoredZip,
  extensionForMime,
  sanitizeSegment,
  uniqueImagePath,
  walkImages,
});
