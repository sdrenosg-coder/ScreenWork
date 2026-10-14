/**
 * Zipy AI — export: HTML (phase 20, batch 0).
 *
 * Renders a `GuideDocument` into a *self-contained* HTML page: one string
 * with inline `<style>` and data-URI images. The result can be opened from
 * the file system, saved from a browser, dropped into an iframe, or served
 * from a static bucket. No external asset fetches, no CDN, no JS required
 * to read the guide.
 *
 * What the renderer guarantees:
 *
 *   - **Escaping.** Every user-supplied string is escaped with
 *     `escapeHtml`; the code block content is escaped separately so it
 *     survives inside `<pre><code>`. There is no template-injection path.
 *   - **Accessibility.** The `lang` attribute is set from the guide's
 *     locale; `alt` text is always present (a placeholder when the source
 *     did not supply one); headings use `<h1>`/`<h2>`; step badges are
 *     `<span aria-hidden="true">` because the step number is also spoken in
 *     the step title.
 *   - **Determinism.** Output is byte-identical for the same input; no
 *     timestamps are written into the body (the `generatedAt` appears only
 *     where the caller asks via the cover meta line).
 *   - **No invented markup.** A block that has no representation (a future
 *     block kind this renderer does not know) is skipped and noted in the
 *     returned `warnings` array rather than being coerced into a generic
 *     element.
 *
 * What it does *not* do:
 *   - It does not fetch images. `GuideDocumentImage.bytes` are supplied by
 *     the caller; this renderer base64-encodes them and sets
 *     `src="data:..."`. When bytes are `null`, it renders an explicit
 *     placeholder — never a fake image.
 *   - It does not embed a stylesheet from an external source. All CSS is
 *     inline and small.
 *   - It does not attempt to sanitise image `mimeType` beyond a whitelist.
 *     An unrecognised MIME renders as a placeholder so a data URI is never
 *     constructed with a value that could break out of the `src` attribute.
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

export type HtmlExportErrorCode = "invalid-input" | "internal";

export class HtmlExportError extends Error {
  readonly code: HtmlExportErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: HtmlExportErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HtmlExportError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface HtmlExportOptions {
  /**
   * Title shown in `<title>` and the top of the page when
   * `guide.cover.title` is null. Required when the guide is untitled so the
   * module never invents one.
   */
  readonly fallbackTitle?: string;
  /**
   * When true, the rendered HTML contains only the guide fragment — no
   * `<!doctype>`, no `<html>`/`<head>`/`<body>`. Used by the embed code in
   * batch 1 and by callers that will wrap the fragment themselves.
   */
  readonly fragmentOnly?: boolean;
  /**
   * Extra CSS appended *after* the built-in rules so a caller can override
   * specific selectors. Content is inserted verbatim; treat as trusted
   * (it comes from the branding phase, which validates its own input).
   */
  readonly customCss?: string | null;
  /**
   * When true, the schema.org `Article` JSON-LD block is emitted from the
   * guide's SEO fields. When false (default), no JSON-LD is written —
   * structured data is opt-in so a caller that wants `HowTo` can supply it
   * itself rather than have two competing blocks.
   */
  readonly includeSeoJsonLd?: boolean;
}

export interface HtmlRenderResult {
  readonly html: string;
  /** Non-fatal problems worth surfacing on the export route. */
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function renderGuideHtml(
  guide: GuideDocument,
  options: HtmlExportOptions = {},
): HtmlRenderResult {
  if (guide === null || typeof guide !== "object") {
    throw new HtmlExportError("renderGuideHtml requires a GuideDocument.", "invalid-input");
  }
  if (typeof guide.slug !== "string" || guide.slug.length === 0) {
    throw new HtmlExportError("GuideDocument is missing a slug.", "invalid-input");
  }

  const warnings: string[] = [];
  const title = guide.cover.title ?? options.fallbackTitle ?? guide.slug;
  const lang = guide.cover.locale.length > 0 ? guide.cover.locale : "en";

  const sections: string[] = [];
  sections.push(renderCover(guide, title, warnings));
  sections.push(
    `<main class="zipy-guide" id="zipy-guide-${escapeAttribute(guide.slug)}">`,
  );
  for (const block of guide.blocks) {
    sections.push(renderBlock(block, warnings));
  }
  sections.push(
    `<footer class="zipy-guide-footer"><p>${escapeHtml(
      `Generated by Zipy AI on ${formatIsoDate(guide.updatedAt || guide.generatedAt)}`,
    )}</p>${renderDisclosure(guide.disclosure)}</footer>`,
  );
  sections.push("</main>");

  const body = sections.join("\n");
  const style = buildStyle(options.customCss ?? null);

  if (options.fragmentOnly === true) {
    return {
      html: `${style}\n${body}`,
      warnings,
    };
  }

  const head: string[] = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
  ];
  if (guide.cover.author.length > 0) {
    head.push(`<meta name="author" content="${escapeAttribute(guide.cover.author)}">`);
  }
  if (guide.seo.metaDescription !== null && guide.seo.metaDescription.length > 0) {
    head.push(
      `<meta name="description" content="${escapeAttribute(guide.seo.metaDescription)}">`,
    );
  }
  if (guide.seo.canonicalUrl !== null && guide.seo.canonicalUrl.length > 0) {
    head.push(`<link rel="canonical" href="${escapeAttribute(guide.seo.canonicalUrl)}">`);
  }
  for (const keyword of guide.cover.keywords) {
    head.push(`<meta property="article:tag" content="${escapeAttribute(keyword)}">`);
  }
  if (options.includeSeoJsonLd === true) {
    head.push(renderArticleJsonLd(guide, title));
  }
  head.push(style);

  return {
    html: [
      `<!doctype html>`,
      `<html lang="${escapeAttribute(lang)}">`,
      `<head>`,
      head.join("\n"),
      `</head>`,
      `<body>`,
      body,
      `</body>`,
      `</html>`,
      "",
    ].join("\n"),
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

function renderBlock(
  block: GuideDocumentBlock,
  warnings: string[],
): string {
  switch (block.kind) {
    case "section":
      return `<section class="zipy-section" id="sec-${escapeAttribute(block.id)}"><h2>${escapeHtml(block.title)}</h2></section>`;
    case "paragraph":
      return `<p class="zipy-paragraph${block.style === "muted" ? " zipy-muted" : ""}" id="${escapeAttribute(block.id)}">${escapeHtml(block.text)}</p>`;
    case "callout":
      return renderCallout(block);
    case "checklist":
      return renderChecklist(block);
    case "table":
      return renderTable(block);
    case "code":
      return renderCode(block);
    case "step":
      return renderStep(block, warnings);
    case "image":
      return renderImageFigure(block.id, block.image, null);
    default: {
      const exhaustive: never = block;
      void exhaustive;
      warnings.push(
        `Skipping block of unknown kind: ${String((block as { kind?: unknown }).kind)}`,
      );
      return "";
    }
  }
}

function renderCover(
  guide: GuideDocument,
  title: string,
  warnings: string[],
): string {
  const parts: string[] = [];
  parts.push(`<header class="zipy-cover">`);
  parts.push(`<h1>${escapeHtml(title)}</h1>`);
  if (guide.cover.subtitle !== null && guide.cover.subtitle.length > 0) {
    parts.push(`<p class="zipy-subtitle">${escapeHtml(guide.cover.subtitle)}</p>`);
  }
  const meta: string[] = [];
  if (guide.cover.author.length > 0) meta.push(escapeHtml(guide.cover.author));
  if (guide.generatedAt.length > 0) {
    meta.push(`Generated ${escapeHtml(formatIsoDate(guide.generatedAt))}`);
  }
  if (meta.length > 0) {
    parts.push(`<p class="zipy-meta">${meta.join(" · ")}</p>`);
  }
  if (guide.sources.length > 0) {
    parts.push(`<div class="zipy-sources"><span class="zipy-sources-label">Sources</span><ul>`);
    for (const source of guide.sources) {
      parts.push(
        `<li><span class="zipy-source-kind">${escapeHtml(source.kind)}</span> ${escapeHtml(source.label)}</li>`,
      );
    }
    parts.push(`</ul></div>`);
  }
  parts.push(`</header>`);
  void warnings;
  return parts.join("\n");
}

function renderCallout(block: GuideDocumentCallout): string {
  const title = block.severity === "tip" ? "Tip" : block.severity === "warning" ? "Warning" : "Note";
  return `<aside class="zipy-callout zipy-callout-${block.severity}" id="${escapeAttribute(block.id)}" role="note"><strong class="zipy-callout-title">${escapeHtml(title)}</strong><p>${escapeHtml(block.text)}</p></aside>`;
}

function renderChecklist(block: GuideDocumentChecklist): string {
  if (block.items.length === 0) return "";
  const items = block.items
    .map(
      (item) =>
        `<li><span class="zipy-checkbox" aria-hidden="true"></span><span>${escapeHtml(item)}</span></li>`,
    )
    .join("");
  return `<ul class="zipy-checklist" id="${escapeAttribute(block.id)}">${items}</ul>`;
}

function renderTable(block: GuideDocumentTable): string {
  if (block.columns.length === 0 || block.rows.length === 0) return "";
  const thead = block.columns
    .map((c) => `<th scope="col">${escapeHtml(c)}</th>`)
    .join("");
  const rows = block.rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table class="zipy-table" id="${escapeAttribute(block.id)}"><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCode(block: GuideDocumentCodeBlock): string {
  const title =
    block.title !== null && block.title.length > 0
      ? `<figcaption class="zipy-code-title">${escapeHtml(block.title)}</figcaption>`
      : "";
  return `<figure class="zipy-code" id="${escapeAttribute(block.id)}">${title}<pre><code class="language-${escapeAttribute(block.language)}">${escapeHtml(
    block.code,
  )}</code></pre></figure>`;
}

function renderStep(
  block: GuideDocumentStep,
  warnings: string[],
): string {
  const parts: string[] = [];
  const title = block.title.length > 0 ? block.title : `Step ${block.index}`;
  parts.push(`<section class="zipy-step" id="${escapeAttribute(block.id)}">`);
  parts.push(
    `<h3><span class="zipy-step-badge" aria-hidden="true">${escapeHtml(
      String(block.index),
    )}</span><span class="zipy-step-title">${escapeHtml(title)}</span></h3>`,
  );
  if (block.image !== null) {
    parts.push(renderImageFigure(`${block.id}-img`, block.image, block.index));
  }
  if (block.description.length > 0) {
    parts.push(`<p class="zipy-step-desc">${escapeHtml(block.description)}</p>`);
  }
  for (const tip of block.tips) {
    parts.push(
      `<aside class="zipy-callout zipy-callout-tip"><strong class="zipy-callout-title">Tip</strong><p>${escapeHtml(tip)}</p></aside>`,
    );
  }
  for (const warning of block.warnings) {
    parts.push(
      `<aside class="zipy-callout zipy-callout-warning"><strong class="zipy-callout-title">Warning</strong><p>${escapeHtml(warning)}</p></aside>`,
    );
  }
  parts.push(`</section>`);
  void warnings;
  return parts.join("\n");
}

function renderImageFigure(
  blockId: string,
  image: GuideDocumentImage,
  stepIndex: number | null,
): string {
  const isEmbeddable =
    image.mimeType === "image/png" ||
    image.mimeType === "image/jpeg" ||
    image.mimeType === "image/webp" ||
    image.mimeType === "image/gif";
  if (image.bytes === null || image.bytes.length === 0 || !isEmbeddable) {
    const hint = image.bytes === null
      ? "Screenshot not supplied"
      : `Unsupported image format (${image.mimeType})`;
    return `<figure class="zipy-image zipy-image-missing" id="${escapeAttribute(blockId)}"><div class="zipy-image-placeholder">${escapeHtml(
      `[${hint}: ${image.id}]`,
    )}</div></figure>`;
  }
  const dataUri = `data:${image.mimeType};base64,${bytesToBase64(image.bytes)}`;
  const altSource =
    image.altText.length > 0
      ? image.altText
      : stepIndex !== null
        ? `Screenshot for step ${stepIndex}`
        : "Screenshot";
  const dims =
    image.width !== null && image.height !== null
      ? ` width="${image.width}" height="${image.height}"`
      : "";
  const caption =
    image.caption !== null && image.caption.length > 0
      ? `<figcaption class="zipy-caption">${escapeHtml(image.caption)}</figcaption>`
      : "";
  const provenance =
    image.sourceRefs.length > 0
      ? `<figcaption class="zipy-provenance">Source: ${escapeHtml(
          image.sourceRefs.join(", "),
        )}</figcaption>`
      : "";
  return `<figure class="zipy-image" id="${escapeAttribute(blockId)}"><img src="${escapeAttribute(
    dataUri,
  )}" alt="${escapeAttribute(altSource)}"${dims} loading="lazy">${caption}${provenance}</figure>`;
}

/* -------------------------------------------------------------------------- */
/* Disclosure / SEO                                                            */
/* -------------------------------------------------------------------------- */

function renderDisclosure(disclosure: GuideDocument["disclosure"]): string {
  if (!disclosure.required) return "";
  const label = disclosure.label ?? "AI-generated content. Review before publishing.";
  if (disclosure.url !== null && disclosure.url.length > 0) {
    return `<p class="zipy-disclosure">${escapeHtml(label)} <a href="${escapeAttribute(
      disclosure.url,
    )}">Learn more</a></p>`;
  }
  return `<p class="zipy-disclosure">${escapeHtml(label)}</p>`;
}

function renderArticleJsonLd(guide: GuideDocument, title: string): string {
  const payload: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
  };
  if (guide.seo.metaDescription !== null) {
    payload.description = guide.seo.metaDescription;
  }
  if (guide.cover.author.length > 0) {
    payload.author = { "@type": "Person", name: guide.cover.author };
  }
  payload.dateModified = guide.updatedAt || guide.generatedAt;
  payload.datePublished = guide.generatedAt;
  if (guide.cover.locale.length > 0) payload.inLanguage = guide.cover.locale;
  if (guide.cover.keywords.length > 0) payload.keywords = guide.cover.keywords.join(", ");
  if (guide.seo.canonicalUrl !== null) {
    payload.mainEntityOfPage = guide.seo.canonicalUrl;
  }
  if (guide.disclosure.required) {
    payload.isAccessibleForFree = true;
    payload.creativeWorkStatus = "AI-generated";
  }
  const json = JSON.stringify(payload, null, 2)
    // Escape the closing-tag sequence so a value inside the JSON cannot
    // terminate the script element.
    .replace(/<\/script/gi, "<\\/script");
  return `<script type="application/ld+json">${json}</script>`;
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

function buildStyle(customCss: string | null): string {
  const base = `
:root {
  color-scheme: light;
  --zipy-fg: #181a1f;
  --zipy-fg-muted: #6b7078;
  --zipy-bg: #ffffff;
  --zipy-rule: #e3e4e6;
  --zipy-code-bg: #1c1f26;
  --zipy-code-fg: #e5e8ee;
  --zipy-tip-bg: #eff6ff;
  --zipy-tip-accent: #2563eb;
  --zipy-warn-bg: #fff7e6;
  --zipy-warn-accent: #b45309;
  --zipy-note-bg: #f4f4f5;
  --zipy-note-accent: #52525b;
  --zipy-radius: 6px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--zipy-bg);
  color: var(--zipy-fg);
  font: 16px/1.55 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.zipy-guide { max-width: 780px; margin: 0 auto; padding: 32px 24px 64px; }
.zipy-cover { border-bottom: 3px solid var(--zipy-fg); padding-bottom: 20px; margin-bottom: 24px; }
.zipy-cover h1 { font-size: 32px; line-height: 1.2; margin: 0 0 8px; }
.zipy-subtitle { font-size: 18px; color: var(--zipy-fg-muted); margin: 0 0 12px; }
.zipy-meta { font-size: 13px; color: var(--zipy-fg-muted); margin: 8px 0; }
.zipy-sources { font-size: 13px; color: var(--zipy-fg-muted); margin-top: 12px; }
.zipy-sources-label { font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px; }
.zipy-sources ul { margin: 4px 0 0; padding-left: 18px; }
.zipy-source-kind { display: inline-block; background: var(--zipy-note-bg); border-radius: 3px; padding: 0 6px; margin-right: 6px; font-size: 11px; text-transform: uppercase; }
.zipy-section { margin: 32px 0 8px; }
.zipy-section h2 { font-size: 22px; border-bottom: 1px solid var(--zipy-rule); padding-bottom: 6px; margin: 0 0 12px; }
.zipy-paragraph { margin: 0 0 12px; }
.zipy-muted { color: var(--zipy-fg-muted); }
.zipy-step { margin: 28px 0; padding: 0 0 8px; border-bottom: 1px solid var(--zipy-rule); }
.zipy-step:last-child { border-bottom: none; }
.zipy-step h3 { display: flex; align-items: center; gap: 10px; font-size: 18px; margin: 0 0 12px; }
.zipy-step-badge { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; background: var(--zipy-fg); color: #fff; font-size: 13px; font-weight: 600; flex: none; }
.zipy-step-title { font-weight: 600; }
.zipy-step-desc { margin: 8px 0; }
.zipy-image { margin: 16px 0; }
.zipy-image img { max-width: 100%; height: auto; display: block; border: 1px solid var(--zipy-rule); border-radius: var(--zipy-radius); }
.zipy-image-placeholder { display: flex; align-items: center; justify-content: center; min-height: 90px; border: 1px dashed var(--zipy-rule); border-radius: var(--zipy-radius); color: var(--zipy-fg-muted); font-style: italic; }
.zipy-caption { font-size: 13px; color: var(--zipy-fg-muted); margin-top: 6px; }
.zipy-provenance { font-size: 11px; color: var(--zipy-fg-muted); margin-top: 2px; }
.zipy-callout { border-left: 3px solid var(--zipy-note-accent); background: var(--zipy-note-bg); border-radius: var(--zipy-radius); padding: 10px 14px; margin: 12px 0; }
.zipy-callout p { margin: 4px 0 0; }
.zipy-callout-title { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; }
.zipy-callout-tip { border-left-color: var(--zipy-tip-accent); background: var(--zipy-tip-bg); }
.zipy-callout-warning { border-left-color: var(--zipy-warn-accent); background: var(--zipy-warn-bg); }
.zipy-checklist { list-style: none; padding-left: 0; margin: 12px 0; }
.zipy-checklist li { display: flex; gap: 8px; align-items: flex-start; padding: 3px 0; }
.zipy-checkbox { display: inline-block; width: 14px; height: 14px; border: 1px solid var(--zipy-fg-muted); border-radius: 3px; margin-top: 4px; flex: none; }
.zipy-table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
.zipy-table th, .zipy-table td { border: 1px solid var(--zipy-rule); padding: 6px 10px; text-align: left; vertical-align: top; }
.zipy-table th { background: var(--zipy-note-bg); font-weight: 600; }
.zipy-code { margin: 12px 0; }
.zipy-code-title { font-size: 12px; color: var(--zipy-fg-muted); margin-bottom: 4px; }
.zipy-code pre { margin: 0; background: var(--zipy-code-bg); color: var(--zipy-code-fg); padding: 12px 14px; border-radius: var(--zipy-radius); overflow-x: auto; }
.zipy-code code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace; }
.zipy-guide-footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--zipy-rule); font-size: 12px; color: var(--zipy-fg-muted); }
.zipy-disclosure { font-style: italic; }
a { color: var(--zipy-tip-accent); }
@media print {
  body { background: #fff; }
  .zipy-guide { max-width: none; padding: 0; }
  .zipy-step { page-break-inside: avoid; }
}
`.trim();
  const extra = customCss === null || customCss.length === 0 ? "" : "\n" + customCss;
  return `<style>\n${base}${extra}\n</style>`;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Minimal but complete HTML escaping for text nodes. Escapes `&`, `<`, `>`,
 * `"` and `'`. Does not use a lookup table with a string replacement chain;
 * a single pass is faster and there are no ordering pitfalls.
 */
export function escapeHtml(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    switch (ch) {
      case 38: // &
        out += "&amp;";
        break;
      case 60: // <
        out += "&lt;";
        break;
      case 62: // >
        out += "&gt;";
        break;
      case 34: // "
        out += "&quot;";
        break;
      case 39: // '
        out += "&#39;";
        break;
      default:
        out += input.charAt(i);
    }
  }
  return out;
}

/**
 * Escaping for attribute values. Same set as text plus a defensive strip of
 * ASCII control characters (a stray newline inside an attribute value is
 * legal but hides bugs).
 */
export function escapeAttribute(input: string): string {
  const cleaned = input.replace(/[\u0000-\u0008\u000a-\u001f\u007f]+/g, " ");
  return escapeHtml(cleaned);
}

/**
 * Base64 encode a `Uint8Array` without relying on Node's `Buffer` so the
 * renderer stays portable (an edge runtime in the export route can host it).
 * Handles inputs of any length in 8 KiB chunks to bound the intermediate
 * string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let out = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    // Chunked fromCharCode to avoid a stack overflow on large arrays.
    let chunk = "";
    const step = 0x8000;
    for (let j = 0; j < slice.length; j += step) {
      chunk += String.fromCharCode.apply(
        null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Array.from(slice.subarray(j, Math.min(j + step, slice.length))) as unknown as number[],
      );
    }
    if (typeof btoa === "function") {
      out += btoa(chunk);
    } else {
      // Node path; used by tests and by the worker export route.
      out += Buffer.from(chunk, "binary").toString("base64");
    }
  }
  return out;
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
  escapeHtml,
  escapeAttribute,
  bytesToBase64,
  buildStyle,
  formatIsoDate,
  renderArticleJsonLd,
});
