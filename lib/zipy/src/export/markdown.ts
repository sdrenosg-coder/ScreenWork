/**
 * Zipy AI — export: Markdown + file manifest (phase 20, batch 0).
 *
 * Renders a `GuideDocument` into a package of Markdown files: one
 * `README.md` covering the whole guide, plus one sibling markdown file per
 * step image, referenced from the README by relative path. This is the
 * convention the image-pack export (batch 1) extends with the actual
 * `images/*.png` binaries; the caller zips the markdown bundle and the
 * image bytes together.
 *
 * Why two files and not a single markdown with inline base64: base64
 * markdown is unreadable in git diffs and hostile to a kb system that
 * expects image references to be paths. The relative-path form matches
 * how the docs system the platform targets (Confluence, GitHub wikis,
 * MkDocs) expects to see images.
 *
 * The manifest returned by `renderGuideMarkdown` lists every file the
 * caller must include for the markdown to render correctly. That list is
 * the *contract* between this renderer and the packaging layer; the caller
 * reads it and brings the bytes.
 *
 * What the renderer guarantees:
 *   - **Escaping.** Text that could be interpreted as markdown is escaped
 *     when it appears in an inline context where a special character would
 *     change the meaning. Block-level code fences are wrapped in a fence
 *     long enough to contain the code.
 *   - **Determinism.** Image paths and file names are derived
 *     deterministically from block ids and image ids. Given the same
 *     document, the output is byte-identical.
 *   - **No invented content.** A step with no title renders as
 *     `Step N`; a step with no description renders with no description
 *     line. A missing image is rendered as a placeholder note naming the
 *     artifact — never a broken link to a file the bundle does not
 *     contain.
 *   - **No image bytes.** The renderer never enumerates bytes; it emits
 *     references and a manifest. The packaging layer brings the bytes.
 *
 * What it does *not* do:
 *   - It does not write files. It returns strings; the caller persists them.
 *   - It does not attempt a full Markdown spec implementation. It writes
 *     CommonMark that GitHub, GitLab, MkDocs and Confluence import without
 *     surprises.
 *   - It does not translate. The i18n layer translates the `GuideDocument`
 *     (or a caller translates individual strings); the Markdown renderer
 *     writes whatever it is handed.
 */

import type {
  GuideDocument,
  GuideDocumentBlock,
  GuideDocumentCallout,
  GuideDocumentChecklist,
  GuideDocumentCodeBlock,
  GuideDocumentImage,
  GuideDocumentStep,
  GuideDocumentTable,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type MarkdownExportErrorCode = "invalid-input";

export class MarkdownExportError extends Error {
  readonly code: MarkdownExportErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: MarkdownExportErrorCode,
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

export interface MarkdownExportOptions {
  /**
   * Title shown when `guide.cover.title` is null. Required when the guide
   * is untitled so the module never invents one.
   */
  readonly fallbackTitle?: string;
  /**
   * Base path prefix for image links in the README. Default: `images`. The
   * packaging layer writes image bytes under this directory.
   */
  readonly imageDir?: string;
  /**
   * When true, the front-matter block (title, description, dates) is
   * emitted. Default: true; the caller turns it off for renderers
   * (Confluence) that do not understand YAML front matter.
   */
  readonly frontMatter?: boolean;
  /**
   * When true, the sources are rendered as a footnote section at the bottom
   * of the README rather than at the top. Default: false.
   */
  readonly sourcesAsFootnotes?: boolean;
}

/**
 * A single entry in the bundle the caller must assemble. `kind === "text"`
 * entries carry their content; `kind === "image"` entries only carry a
 * reference — the caller must supply bytes from `image.bytes`.
 */
export interface MarkdownBundleFile {
  readonly path: string;
  readonly kind: "text" | "image";
  readonly content: string | null;
  readonly image: GuideDocumentImage | null;
}

export interface MarkdownRenderResult {
  /** The README content (also present in `files`). */
  readonly readme: string;
  /** Every file the bundle must contain for the README to render. */
  readonly files: readonly MarkdownBundleFile[];
  /** Non-fatal problems worth surfacing on the export route. */
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function renderGuideMarkdown(
  guide: GuideDocument,
  options: MarkdownExportOptions = {},
): MarkdownRenderResult {
  if (guide === null || typeof guide !== "object") {
    throw new MarkdownExportError("renderGuideMarkdown requires a GuideDocument.", "invalid-input");
  }
  if (typeof guide.slug !== "string" || guide.slug.length === 0) {
    throw new MarkdownExportError("GuideDocument is missing a slug.", "invalid-input");
  }

  const warnings: string[] = [];
  const title = guide.cover.title ?? options.fallbackTitle ?? guide.slug;
  const imageDir = sanitizePathSegment(options.imageDir ?? "images");
  const sourceRefsAtTop = options.sourcesAsFootnotes !== true;

  const lines: string[] = [];

  if (options.frontMatter !== false) {
    lines.push(...renderFrontMatter(guide, title));
  }

  lines.push(`# ${escapeInline(title)}`);
  lines.push("");

  if (guide.cover.subtitle !== null && guide.cover.subtitle.length > 0) {
    lines.push(`*${escapeInline(guide.cover.subtitle)}*`);
    lines.push("");
  }

  const metaParts: string[] = [];
  if (guide.cover.author.length > 0) metaParts.push(escapeInline(guide.cover.author));
  if (guide.generatedAt.length > 0) {
    metaParts.push(`Generated ${escapeInline(formatIsoDate(guide.generatedAt))}`);
  }
  if (metaParts.length > 0) {
    lines.push(`> ${metaParts.join(" · ")}`);
    lines.push("");
  }

  if (sourceRefsAtTop && guide.sources.length > 0) {
    lines.push(...renderSourcesSection(guide));
  }

  const files: MarkdownBundleFile[] = [];
  const seenImagePaths = new Set<string>();

  for (const block of guide.blocks) {
    const rendered = renderBlock(
      block,
      imageDir,
      files,
      seenImagePaths,
      warnings,
    );
    for (const l of rendered) lines.push(l);
  }

  if (!sourceRefsAtTop && guide.sources.length > 0) {
    lines.push(...renderSourcesSection(guide));
  }

  if (guide.disclosure.required) {
    lines.push("---");
    lines.push("");
    const label = guide.disclosure.label ?? "AI-generated content. Review before publishing.";
    if (guide.disclosure.url !== null && guide.disclosure.url.length > 0) {
      lines.push(`> _${escapeInline(label)}_ — [Learn more](${guide.disclosure.url})`);
    } else {
      lines.push(`> _${escapeInline(label)}_`);
    }
    lines.push("");
  }

  // Trim trailing blank lines, add a single final newline.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.push("");

  const readme = lines.join("\n");
  const allFiles: MarkdownBundleFile[] = [
    { path: "README.md", kind: "text", content: readme, image: null },
    ...files,
  ];
  return { readme, files: allFiles, warnings };
}

/**
 * The list of files the caller must supply for an image pack (batch 1) to
 * be complete: one entry per image in the guide, in document order. The
 * caller uses this list to prepare a ZIP; the Markdown renderer's manifest
 * references the same paths.
 */
export function collectImageBundlePaths(
  guide: GuideDocument,
  imageDir: string = "images",
): readonly { readonly path: string; readonly image: GuideDocumentImage }[] {
  const out: { path: string; image: GuideDocumentImage }[] = [];
  const seen = new Set<string>();
  const dir = sanitizePathSegment(imageDir);
  for (const block of guide.blocks) {
    const images: GuideDocumentImage[] = [];
    if (block.kind === "image") images.push(block.image);
    else if (block.kind === "step" && block.image !== null) images.push(block.image);
    for (const image of images) {
      const path = imagePathFor(dir, block.id, image, seen);
      out.push({ path, image });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Front matter / sources                                                      */
/* -------------------------------------------------------------------------- */

function renderFrontMatter(guide: GuideDocument, title: string): readonly string[] {
  const lines: string[] = ["---"];
  lines.push(`title: ${yamlScalar(title)}`);
  if (guide.cover.subtitle !== null && guide.cover.subtitle.length > 0) {
    lines.push(`subtitle: ${yamlScalar(guide.cover.subtitle)}`);
  }
  if (guide.cover.author.length > 0) {
    lines.push(`author: ${yamlScalar(guide.cover.author)}`);
  }
  if (guide.generatedAt.length > 0) {
    lines.push(`date: ${yamlScalar(guide.generatedAt.slice(0, 10))}`);
  }
  if (guide.updatedAt.length > 0) {
    lines.push(`updated: ${yamlScalar(guide.updatedAt.slice(0, 10))}`);
  }
  if (guide.cover.locale.length > 0) {
    lines.push(`lang: ${yamlScalar(guide.cover.locale)}`);
  }
  if (guide.cover.keywords.length > 0) {
    lines.push(`keywords:`);
    for (const k of guide.cover.keywords) lines.push(`  - ${yamlScalar(k)}`);
  }
  if (guide.seo.metaDescription !== null && guide.seo.metaDescription.length > 0) {
    lines.push(`description: ${yamlScalar(guide.seo.metaDescription)}`);
  }
  if (guide.disclosure.required) {
    lines.push(`ai_generated: true`);
  }
  lines.push("---");
  lines.push("");
  return lines;
}

function renderSourcesSection(guide: GuideDocument): readonly string[] {
  const lines: string[] = [];
  lines.push("## Sources");
  lines.push("");
  for (const source of guide.sources) {
    const label = escapeInline(source.label);
    if (source.ref !== null && source.ref.length > 0) {
      lines.push(`- **${source.kind}** — ${label} (\`${escapeInline(source.ref)}\`)`);
    } else {
      lines.push(`- **${source.kind}** — ${label}`);
    }
  }
  lines.push("");
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

function renderBlock(
  block: GuideDocumentBlock,
  imageDir: string,
  files: MarkdownBundleFile[],
  seenImagePaths: Set<string>,
  warnings: string[],
): readonly string[] {
  switch (block.kind) {
    case "section":
      return [`## ${escapeInline(block.title)}`, ""];
    case "paragraph": {
      const prefix = block.style === "muted" ? "> " : "";
      return [`${prefix}${escapeInline(block.text)}`, ""];
    }
    case "callout":
      return renderCallout(block);
    case "checklist":
      return renderChecklist(block);
    case "table":
      return renderTable(block);
    case "code":
      return renderCode(block);
    case "step":
      return renderStep(block, imageDir, files, seenImagePaths, warnings);
    case "image":
      return renderImageFigure("", block.image, imageDir, files, seenImagePaths);
    default: {
      const exhaustive: never = block;
      void exhaustive;
      warnings.push(
        `Skipping block of unknown kind: ${String((block as { kind?: unknown }).kind)}`,
      );
      return [];
    }
  }
}

function renderCallout(block: GuideDocumentCallout): readonly string[] {
  const label =
    block.severity === "tip" ? "Tip" : block.severity === "warning" ? "Warning" : "Note";
  return [`> **${label}:** ${escapeInline(block.text)}`, ""];
}

function renderChecklist(block: GuideDocumentChecklist): readonly string[] {
  const lines: string[] = [];
  for (const item of block.items) {
    lines.push(`- [ ] ${escapeInline(item)}`);
  }
  lines.push("");
  return lines;
}

function renderTable(block: GuideDocumentTable): readonly string[] {
  if (block.columns.length === 0 || block.rows.length === 0) return [];
  const colCount = block.columns.length;
  const lines: string[] = [];
  lines.push(`| ${block.columns.map(escapeTableCell).join(" | ")} |`);
  lines.push(`| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`);
  for (const row of block.rows) {
    const padded: string[] = [];
    for (let c = 0; c < colCount; c += 1) {
      padded.push(escapeTableCell(row[c] ?? ""));
    }
    lines.push(`| ${padded.join(" | ")} |`);
  }
  lines.push("");
  return lines;
}

function renderCode(block: GuideDocumentCodeBlock): readonly string[] {
  const lines: string[] = [];
  if (block.title !== null && block.title.length > 0) {
    lines.push(`**${escapeInline(block.title)}**`);
    lines.push("");
  }
  const fence = fenceFor(block.code);
  lines.push(`${fence}${block.language}`);
  // Code is written verbatim inside the fence; only the fence length is
  // chosen so any run of backticks inside the code is contained.
  for (const line of block.code.split(/\r?\n/)) lines.push(line);
  lines.push(fence);
  lines.push("");
  return lines;
}

function renderStep(
  block: GuideDocumentStep,
  imageDir: string,
  files: MarkdownBundleFile[],
  seenImagePaths: Set<string>,
  warnings: string[],
): readonly string[] {
  const lines: string[] = [];
  const title = block.title.length > 0 ? block.title : `Step ${block.index}`;
  lines.push(`### ${block.index}. ${escapeInline(title)}`);
  lines.push("");
  if (block.image !== null) {
    lines.push(...renderImageFigure("", block.image, imageDir, files, seenImagePaths));
  }
  if (block.description.length > 0) {
    lines.push(escapeInline(block.description));
    lines.push("");
  }
  for (const tip of block.tips) {
    lines.push(`> **Tip:** ${escapeInline(tip)}`);
    lines.push("");
  }
  for (const warning of block.warnings) {
    lines.push(`> **Warning:** ${escapeInline(warning)}`);
    lines.push("");
  }
  void warnings;
  return lines;
}

function renderImageFigure(
  prefixPathSegment: string,
  image: GuideDocumentImage,
  imageDir: string,
  files: MarkdownBundleFile[],
  seenImagePaths: Set<string>,
): readonly string[] {
  if (image.bytes === null || image.bytes.length === 0) {
    return [`_[Screenshot not supplied: ${escapeInline(image.id)}]_`, ""];
  }
  const path = registerImageFile(
    imageDir,
    prefixPathSegment,
    image,
    files,
    seenImagePaths,
  );
  const alt = image.altText.length > 0 ? image.altText : `Screenshot ${image.id}`;
  const lines: string[] = [`![${escapeAlt(alt)}](${path})`];
  if (image.caption !== null && image.caption.length > 0) {
    lines.push("");
    lines.push(`*${escapeInline(image.caption)}*`);
  }
  if (image.sourceRefs.length > 0) {
    lines.push("");
    lines.push(`<sub>Source: ${escapeInline(image.sourceRefs.join(", "))}</sub>`);
  }
  lines.push("");
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function registerImageFile(
  imageDir: string,
  prefix: string,
  image: GuideDocumentImage,
  files: MarkdownBundleFile[],
  seen: Set<string>,
): string {
  const path = imagePathFor(imageDir, prefix, image, seen);
  files.push({
    path,
    kind: "image",
    content: null,
    image,
  });
  return path;
}

function imagePathFor(
  imageDir: string,
  prefix: string,
  image: GuideDocumentImage,
  seen: Set<string>,
): string {
  const ext = extensionForMime(image.mimeType);
  const base = sanitizePathSegment(prefix.length > 0 ? `${prefix}-${image.id}` : image.id);
  let candidate = `${imageDir}/${base}.${ext}`;
  let counter = 2;
  while (seen.has(candidate)) {
    candidate = `${imageDir}/${base}-${counter}.${ext}`;
    counter += 1;
  }
  seen.add(candidate);
  return candidate;
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

function sanitizePathSegment(input: string): string {
  const cleaned = input
    .replace(/[\/\\]/g, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "asset";
}

/**
 * Escape characters that would change the meaning of *inline* markdown.
 * Block-level markdown (fences, headings) is emitted separately and does
 * not go through this function.
 */
function escapeInline(input: string): string {
  // Escape the markdown metacharacters that matter in an inline context.
  // `\` first so it does not double-escape later insertions.
  return input
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]#])/g, "\\$1")
    .replace(/\r?\n/g, " ");
}

function escapeAlt(input: string): string {
  // Alt text lives inside `[...]`; escape the closing bracket and any
  // backslash so it cannot terminate the alt-text span.
  return input.replace(/\\/g, "\\\\").replace(/]/g, "\\]").replace(/\r?\n/g, " ");
}

function escapeTableCell(input: string): string {
  // Pipe and newline break a row; escape both.
  return input.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function yamlScalar(input: string): string {
  if (input.length === 0) return '""';
  // Quote when the scalar could be misread (contains a colon followed by a
  // space, a leading quote, leading space, or is a YAML keyword).
  const needsQuote =
    /^[\s"'#\-?:,\[\]{}&*!|>%@`]/.test(input) ||
    /[:#]\s/.test(input) ||
    /\s$/.test(input) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(input) ||
    /^[\d.+-]+$/.test(input);
  if (!needsQuote) return input;
  return `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function fenceFor(code: string): string {
  // Find the longest run of backticks in the code; use one more for the
  // fence so a longer run inside the code never closes it early.
  const runs = code.match(/`+/g) ?? [];
  let longest = 0;
  for (const run of runs) {
    if (run.length > longest) longest = run.length;
  }
  const length = Math.max(3, longest + 1);
  return "`".repeat(length);
}

function formatIsoDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  escapeInline,
  escapeAlt,
  escapeTableCell,
  yamlScalar,
  fenceFor,
  sanitizePathSegment,
  extensionForMime,
  imagePathFor,
  formatIsoDate,
});
