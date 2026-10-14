/**
 * Zipy AI — export: embed (phase 20, batch 1).
 *
 * Generates the snippet a customer pastes into their own site, blog, Confluence
 * page, Notion document or documentation tool so the guide renders inline.
 * Three integration surfaces are produced from one call, each appropriate to a
 * different embedding context:
 *
 *   1. **iframe** — the least invasive; a single `<iframe>` tag pointing at a
 *      published guide URL. The default width is 100% so the guide takes the
 *      container's shape; a `fixedHeightPx` variant is available when the host
 *      page demands one. The `iframe` form is the only one this module
 *      produces that has no script at all, so a customer with a
 *      Content-Security-Policy that forbids inline scripts can still use it.
 *
 *   2. **script** — a `<script>` tag that mounts the guide into a
 *      caller-supplied container `<div>` using the Zipy loader. The loader
 *      URL is a caller-supplied configuration value
 *      (`scriptsBaseUrl`), never the platform's hard-coded host; a customer
 *      hosting an on-prem mirror provides their own. When `scriptsBaseUrl`
 *      is null, the script form is *not* emitted, and the caller is warned
 *      explicitly rather than handed a script pointed at a guessed host.
 *
 *   3. **iframe-with-snippet** — a small, self-contained HTML fragment for
 *      documentation tools (Confluence macros, Notion embeds) that want a
 *      ready block of HTML including a `<noscript>` fallback. It wraps the
 *      iframe in a sized wrapper with the guide's title as an accessible
 *      `<figcaption>`.
 *
 * What this module guarantees:
 *
 *   - **Escaping.** Every user-supplied string is HTML-escaped at
 *     composition time (`title`, `slug`, `baseUrl`). The URL fields are
 *     validated against a `http`/`https` scheme before being placed in a
 *     `src` attribute; anything else throws, so a caller-supplied string
 *     cannot smuggle a `javascript:` scheme into a snippet.
 *   - **No fabricated host.** Every URL the snippet contains is composed
 *     from a caller-supplied `baseUrl`; the module never invents a domain.
 *     A relative `baseUrl` is rejected so a snippet pasted onto a third
 *     party's page cannot link back to the customer's own site by accident.
 *   - **Predictable whitespace.** The output is a single- or multi-line
 *     string with LF line endings regardless of host platform so diffs and
 *     copy-paste between Unix and Windows produce the same bytes.
 *   - **Explicit refusal for missing configuration.** When the caller asks
 *     for the `script` snippet without a `scriptsBaseUrl`, the response
 *     raises `EmbedExportError` with code `"missing-scripts-base"`, naming
 *     the exact missing option. A silent fallback to the iframe form would
 *     hide a misconfiguration, and a hard-coded default would break
 *     on-prem installs.
 *
 * What this module does *not* do:
 *   - It does not personalise the snippet to a specific user; embedding is
 *     an anonymous surface by design and the guide URL is the same for every
 *     viewer unless the caller provisions per-user links elsewhere.
 *   - It does not inject analytics or event tracking. The embed target page
 *     is the platform's concern; the snippet is a link, nothing else.
 *   - It does not load fonts, styles or scripts from the platform's CDN. The
 *     script form loads the customer-configured loader; the iframe form
 *     delegates everything to the guide URL. Nothing about the customer's
 *     host page is assumed.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type EmbedExportErrorCode =
  | "invalid-input"
  | "invalid-url"
  | "missing-scripts-base"
  | "internal";

export class EmbedExportError extends Error {
  readonly code: EmbedExportErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: EmbedExportErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "EmbedExportError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type EmbedForm = "iframe" | "script" | "iframe-with-snippet";

export interface EmbedExportOptions {
  /**
   * Absolute, scheme-qualified URL the guide is served from — the customer's
   * public host, or the platform's default public host, whichever the caller
   * has configured. Must be `http:` or `https:`. Trailing slash is optional
   * and normalised.
   */
  readonly guideBaseUrl: string;
  /**
   * The guide's slug. Combined with `guideBaseUrl` to form the embed URL.
   * Must be a non-empty string; the module does not fall back to an ID it
   * does not have.
   */
  readonly slug: string;
  /**
   * Human title of the guide. Used as the iframe's `title` attribute (for
   * screen readers) and, in the `iframe-with-snippet` form, as a visible
   * caption. Required.
   */
  readonly title: string;
  /**
   * Which surface(s) to produce. Every requested form is emitted in the
   * returned `snippets`. Default: all three that can be produced with the
   * supplied options.
   */
  readonly forms?: readonly EmbedForm[];
  /**
   * Required when the `script` form is requested (or defaulted-on). The
   * base URL of the customer's copy of the Zipy loader script — e.g.
   * `https://cdn.example-zipy-host/embed` for a hosted install, or
   * `https://zipy.internal.example.com/embed` for an on-prem mirror.
   * Must end without `/embed.js`; the module appends it.
   */
  readonly scriptsBaseUrl?: string | null;
  /**
   * Optional `fixedHeightPx` for the iframe. When supplied, the iframe has a
   * `height="<n>"` attribute and a style of the same value. When omitted,
   * `height` is `"100%"` and the style sets `min-height: 600px` so the
   * container is not crushed on a real page. Default: null.
   */
  readonly fixedHeightPx?: number | null;
  /**
   * Optional query string to append to the guide URL, e.g. `theme=dark` or
   * `lang=fr`. Values are URL-encoded. Default: null.
   */
  readonly query?: Readonly<Record<string, string>> | null;
  /**
   * Reserved for the branding phase: passes an `assetHost` prefix that will
   * be threaded into the loader script's configuration block. When null
   * (default), the loader's own configuration is used. No default is invented.
   */
  readonly assetHost?: string | null;
}

export interface EmbedSnippet {
  readonly form: EmbedForm;
  /** The snippet itself. LF line endings. */
  readonly html: string;
  /** The composed guide URL the snippet renders. */
  readonly resolvedUrl: string;
  /** One-line description of what the snippet is for, for the UI. */
  readonly description: string;
}

export interface EmbedRenderResult {
  readonly snippets: readonly EmbedSnippet[];
  /** Non-fatal problems worth surfacing on the export route. */
  readonly warnings: readonly string[];
  /** The canonical guide URL that every snippet resolves to (without query). */
  readonly canonicalUrl: string;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function renderGuideEmbed(options: EmbedExportOptions): EmbedRenderResult {
  if (options === null || typeof options !== "object") {
    throw new EmbedExportError("renderGuideEmbed requires an options object.", "invalid-input");
  }
  if (typeof options.slug !== "string" || options.slug.trim().length === 0) {
    throw new EmbedExportError("`slug` is required and must be non-empty.", "invalid-input");
  }
  if (typeof options.title !== "string" || options.title.trim().length === 0) {
    throw new EmbedExportError("`title` is required and must be non-empty.", "invalid-input");
  }
  const base = normalizeBaseUrl(options.guideBaseUrl);
  const canonicalUrl = joinUrl(base, options.slug.trim());

  const query = options.query ?? null;
  const resolvedUrl = query === null ? canonicalUrl : appendQuery(canonicalUrl, query);

  const scriptsBase =
    options.scriptsBaseUrl === null || options.scriptsBaseUrl === undefined
      ? null
      : normalizeBaseUrl(options.scriptsBaseUrl);

  const requestedForms = options.forms !== undefined && options.forms !== null
    ? options.forms
    : null;

  const willEmitScript = requestedForms === null
    ? scriptsBase !== null
    : requestedForms.includes("script");
  const willEmitIframe = requestedForms === null
    ? true
    : requestedForms.includes("iframe");
  const willEmitSnippet = requestedForms === null
    ? true
    : requestedForms.includes("iframe-with-snippet");

  if (willEmitScript && scriptsBase === null) {
    throw new EmbedExportError(
      "The `script` embed form was requested but `scriptsBaseUrl` was not supplied. The loader's location is customer-specific (hosted CDN vs. on-prem mirror) and cannot be guessed.",
      "missing-scripts-base",
      { requestedForms: requestedForms ?? ["script"] },
    );
  }

  const fixedHeight = readFixedHeight(options.fixedHeightPx);

  const warnings: string[] = [];
  if (requestedForms !== null) {
    const unique = new Set(requestedForms);
    if (unique.size !== requestedForms.length) {
      warnings.push("Duplicate embed forms were requested; duplicates were ignored.");
    }
    if (willEmitScript === false && unique.has("script")) {
      // Defence in depth: the throw above catches this; the warning is for
      // callers reading the result without a try/catch.
      warnings.push("The `script` embed form was requested but produced no snippet.");
    }
  }

  const snippets: EmbedSnippet[] = [];
  if (willEmitIframe) {
    snippets.push({
      form: "iframe",
      html: buildIframeSnippet({
        url: resolvedUrl,
        title: options.title,
        fixedHeightPx: fixedHeight,
      }),
      resolvedUrl,
      description: "Inline iframe; no JavaScript required on the host page.",
    });
  }
  if (willEmitSnippet) {
    snippets.push({
      form: "iframe-with-snippet",
      html: buildIframeWithSnippet({
        url: resolvedUrl,
        title: options.title,
        fixedHeightPx: fixedHeight,
      }),
      resolvedUrl,
      description:
        "Ready HTML block for docs tools that accept markup (Confluence, Notion). Includes a noscript fallback.",
    });
  }
  if (willEmitScript && scriptsBase !== null) {
    snippets.push({
      form: "script",
      html: buildScriptSnippet({
        url: canonicalUrl,
        slug: options.slug.trim(),
        title: options.title,
        scriptsBaseUrl: scriptsBase,
        query,
        assetHost: options.assetHost ?? null,
      }),
      resolvedUrl,
      description: "Loader script that mounts the guide into a container div.",
    });
  }

  return {
    snippets,
    warnings,
    canonicalUrl,
  };
}

/* -------------------------------------------------------------------------- */
/* Snippet builders                                                            */
/* -------------------------------------------------------------------------- */

interface IframeInput {
  readonly url: string;
  readonly title: string;
  readonly fixedHeightPx: number | null;
}

function buildIframeSnippet(input: IframeInput): string {
  const height = input.fixedHeightPx === null ? "100%" : String(input.fixedHeightPx);
  const styleHeight = input.fixedHeightPx === null
    ? "min-height:600px"
    : `height:${input.fixedHeightPx}px`;
  // Attributes: `loading="lazy"` and `referrerpolicy` are defensive
  // defaults; neither leaks visitor information to the host page beyond
  // what a normal iframe would.
  const lines = [
    `<iframe`,
    `  src="${escapeAttr(input.url)}"`,
    `  title="${escapeAttr(input.title)}"`,
    `  width="100%"`,
    `  height="${escapeAttr(height)}"`,
    `  style="border:0;${styleHeight};width:100%"`,
    `  loading="lazy"`,
    `  referrerpolicy="strict-origin-when-cross-origin"`,
    `  allowfullscreen`,
    `></iframe>`,
  ];
  return lines.join("\n");
}

interface IframeWithSnippetInput {
  readonly url: string;
  readonly title: string;
  readonly fixedHeightPx: number | null;
}

function buildIframeWithSnippet(input: IframeWithSnippetInput): string {
  const height = input.fixedHeightPx === null ? "640" : String(input.fixedHeightPx);
  const caption = escapeHtml(input.title);
  const url = escapeAttr(input.url);
  // The <figure>/<figcaption> structure is what Confluence and Notion's
  // custom-HTML blocks accept without stripping; a bare <iframe> often gets
  // wrapped in a paragraph by those editors and then rejected for nesting.
  const lines = [
    `<figure class="zipy-guide-embed" style="margin:0;padding:0">`,
    `  <iframe`,
    `    src="${url}"`,
    `    title="${escapeAttr(input.title)}"`,
    `    width="100%"`,
    `    height="${escapeAttr(height)}"`,
    `    style="border:0;width:100%;max-width:100%;display:block"`,
    `    loading="lazy"`,
    `    referrerpolicy="strict-origin-when-cross-origin"`,
    `    allowfullscreen`,
    `  ></iframe>`,
    `  <figcaption style="font-size:0.85em;color:#6b7078;margin-top:0.4em">${caption}</figcaption>`,
    `  <noscript>`,
    `    <p style="font-size:0.9em;color:#6b7078">`,
    `      Enable JavaScript to view the walkthrough inline, or open it directly:`,
    `      <a href="${url}">${caption}</a>.`,
    `    </p>`,
    `  </noscript>`,
    `</figure>`,
  ];
  return lines.join("\n");
}

interface ScriptInput {
  readonly url: string;
  readonly slug: string;
  readonly title: string;
  readonly scriptsBaseUrl: string;
  readonly query: Readonly<Record<string, string>> | null;
  readonly assetHost: string | null;
}

function buildScriptSnippet(input: ScriptInput): string {
  const loaderSrc = `${input.scriptsBaseUrl}/embed.js`;
  // A nonce-less script tag is the safest cross-host form: we do not inject
  // a nonce the host page does not own. The customer's CSP must allow the
  // configured scriptsBaseUrl origin; the comment notes this.
  const config: Record<string, unknown> = {
    slug: input.slug,
    baseUrl: input.url,
  };
  if (input.query !== null && Object.keys(input.query).length > 0) {
    config.query = { ...input.query };
  }
  if (input.assetHost !== null) {
    config.assetHost = input.assetHost;
  }
  const configJson = JSON.stringify(config, null, 2)
    // Preserve the `</script>` safety property; a `</script` sequence in a
    // string value would otherwise terminate the config script block.
    .replace(/<\/script/gi, "<\\/script");

  const lines = [
    `<!-- Zipy AI guide embed: ${escapeHtml(input.title)} -->`,
    `<!-- The host page's Content-Security-Policy must allow script-src from ${escapeAttr(input.scriptsBaseUrl)}. -->`,
    `<div id="zipy-embed-${escapeAttr(input.slug)}" data-zipy-guide="${escapeAttr(input.slug)}"></div>`,
    `<script type="application/json" id="zipy-embed-${escapeAttr(input.slug)}-config">`,
    configJson,
    `</script>`,
    `<script async src="${escapeAttr(loaderSrc)}"></script>`,
  ];
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* URL + escaping helpers                                                      */
/* -------------------------------------------------------------------------- */

function normalizeBaseUrl(input: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new EmbedExportError(
      "A non-empty absolutue base URL is required.",
      "invalid-url",
      { input: input },
    );
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch (err) {
    throw new EmbedExportError(
      `Invalid URL: ${input}`,
      "invalid-url",
      { input, cause: err instanceof Error ? err.message : String(err) },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EmbedExportError(
      `URL scheme must be http or https; received "${url.protocol}".`,
      "invalid-url",
      { input, protocol: url.protocol },
    );
  }
  // Normalise: drop trailing slash on the path so `joinUrl` can add one.
  let out = url.toString();
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function joinUrl(base: string, slug: string): string {
  // Slugs are stored without a leading slash; encode each path segment so a
  // slug with unusual characters still forms a valid URL.
  const encodedSlug = slug
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/p/${encodedSlug}`;
}

function appendQuery(url: string, query: Readonly<Record<string, string>>): string {
  const pairs: string[] = [];
  // Sort for determinism: two callers with the same logical query get the
  // same string.
  const keys = Object.keys(query).sort();
  for (const k of keys) {
    const v = query[k];
    if (v === undefined) continue;
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  if (pairs.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${pairs.join("&")}`;
}

function readFixedHeight(input: number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new EmbedExportError(
      "`fixedHeightPx` must be a finite number when supplied.",
      "invalid-input",
      { fixedHeightPx: input },
    );
  }
  const clamped = Math.min(10_000, Math.max(80, Math.round(input)));
  return clamped;
}

function escapeAttr(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    if (ch === 38) { out += "&amp;"; continue; }
    if (ch === 60) { out += "&lt;"; continue; }
    if (ch === 62) { out += "&gt;"; continue; }
    if (ch === 34) { out += "&quot;"; continue; }
    if (ch === 39) { out += "&#39;"; continue; }
    // Defence: strip control characters that are illegal in HTML attributes.
    if (ch < 0x20 && ch !== 9 && ch !== 10 && ch !== 13) continue;
    out += input.charAt(i);
  }
  return out;
}

function escapeHtml(input: string): string {
  // Same character set; the split exists so a future read of this module
  // sees the intent (an HTML *text* context vs. an attribute context).
  return escapeAttr(input);
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateEmbedResult(value: unknown): EmbedRenderResult {
  if (value === null || typeof value !== "object") {
    throw new EmbedExportError(
      "Rehydrate failed: payload is not an object.",
      "internal",
    );
  }
  const r = value as Record<string, unknown>;
  const snippetsRaw = Array.isArray(r["snippets"]) ? (r["snippets"] as unknown[]) : [];
  const snippets: EmbedSnippet[] = [];
  for (const item of snippetsRaw) {
    if (item === null || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const form = readForm(s["form"]);
    if (form === null) continue;
    snippets.push({
      form,
      html: typeof s["html"] === "string" ? (s["html"] as string) : "",
      resolvedUrl: typeof s["resolvedUrl"] === "string" ? (s["resolvedUrl"] as string) : "",
      description: typeof s["description"] === "string" ? (s["description"] as string) : "",
    });
  }
  const warningsRaw = Array.isArray(r["warnings"]) ? (r["warnings"] as unknown[]) : [];
  const warnings = warningsRaw.filter((w): w is string => typeof w === "string");
  return {
    snippets,
    warnings,
    canonicalUrl: typeof r["canonicalUrl"] === "string" ? (r["canonicalUrl"] as string) : "",
  };
}

function readForm(v: unknown): EmbedForm | null {
  return v === "iframe" || v === "script" || v === "iframe-with-snippet" ? v : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  escapeAttr,
  escapeHtml,
  normalizeBaseUrl,
  joinUrl,
  appendQuery,
  readFixedHeight,
  buildIframeSnippet,
  buildIframeWithSnippet,
  buildScriptSnippet,
  readForm,
});
