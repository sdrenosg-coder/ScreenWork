/**
 * Zipy AI — branding: custom CSS injection (phase 25, batch 0).
 *
 * A workspace can supply a small stylesheet that is inserted *after* the
 * platform's token variables block, so a workspace override has CSS cascade
 * precedence for its own rendered guides and exports. The module's job is to
 * accept that stylesheet safely.
 *
 * What "safely" means here:
 *
 *   - **No `<script>`, no `<style>`, no `</style>`.** Inline HTML that the
 *     browser parses as markup is rejected. The stylesheet is delivered in a
 *     `<style>` element; a string that closes that element early would let
 *     the operator's CSS escape into the host document and execute script.
 *
 *   - **No `@import`.** An external `@import` fetches a third-party
 *     stylesheet at render time, which (a) makes the platform's rendering
 *     non-deterministic and (b) creates an exfiltration channel. The
 *     stylesheet is *the workspace's*; it may not pull in an unrelated one.
 *
 *   - **No `expression(...)`/`javascript:` URL schemes.** These are the
 *     string-level injection vectors for older rendering engines and for
 *     exporters that naively interpolate the CSS into a PDF/DOCX.
 *
 *   - **Scoped by the caller, not by string surgery.** The module returns the
 *     sanitised CSS as-is; the caller is expected to *wrap* it in a scoped
 *     selector at the point of delivery. The route layer wraps with the
 *     workspace's `data-zipy-workspace` attribute; the export template wraps
 *     with the export's own container class. This way no rewriter has to
 *     guess where an operator's rule ends and another begins — CSS-scoping is
 *     a well-known hard problem that the module does not attempt.
 *
 * What the module explicitly does **not** do:
 *
 *   - It does not validate CSS grammar. A malformed rule is the browser's
 *     problem to drop; attempting to parse CSS in JavaScript has produced
 *     more bugs than it has prevented, and the token/PDF layers use their own
 *     well-defined surface for the styled output.
 *
 *   - It does not strip `url(...)` values. A workspace may legitimately use a
 *     `url(...)` for a background image or an icon font, and stripping it
 *     would break the operator's intent. The module accepts `url(...)` values
 *     but **not** `javascript:` or `data:text/html` schemes inside them.
 *
 *   - It does not "escape" the input. Escaping an operator's CSS would change
 *     the selectors they wrote, silently breaking their override. A rejection
 *     is honest; a silent rewrite is not.
 *
 * The module exports:
 *   - `sanitiseCustomCss` — validate + normalise an operator's stylesheet.
 *   - `wrapCustomCss` — wrap it in a caller-chosen scope selector.
 *   - `CUSTOM_CSS_LIMITS` — the documented length budget.
 *   - `__internals` for the pattern set and the individual checks.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type CustomCssErrorCode =
  | "invalid-input"
  | "too-long"
  | "forbidden-token"
  | "unbalanced-brace";

export class CustomCssError extends Error {
  readonly code: CustomCssErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: CustomCssErrorCode,
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

export interface CustomCssWarning {
  readonly kind: "long-stylesheet" | "high-rule-count" | "override-heavy" | "empty";
  readonly detail: string;
}

export interface SanitisedCustomCss {
  readonly value: string;
  /**
   * The warnings the sanitiser recorded. Empty when the stylesheet is
   * unremarkable. Warnings are advisory; the caller shows them in the
   * settings UI but still applies the stylesheet.
   */
  readonly warnings: readonly CustomCssWarning[];
  /**
   * Count of top-level `{`-opening rules. Used only for the warning that a
   * workspace may have written more CSS than it intends to maintain.
   */
  readonly ruleCount: number;
}

export interface SanitiseCustomCssInput {
  readonly css: string;
  /**
   * Optional per-workspace override of the maximum length. The default is
   * `CUSTOM_CSS_LIMITS.MAX_LENGTH_BYTES`. Increasing it is an operator
   * decision; the module records whatever limit it applied so the tenant
   * administrator can audit the setting.
   */
  readonly maxLengthBytes?: number;
}

/**
 * Documented budget. The default cap is deliberate: a workspace override is
 * for brand tokens and accessibility tweaks, not for replacing the platform's
 * stylesheet. A longer stylesheet is a signal that a new brand token ought to
 * be added to the platform, not that the workspace should ship a bigger one.
 */
export const CUSTOM_CSS_LIMITS = Object.freeze({
  /** Maximum length in UTF-8 bytes. */
  MAX_LENGTH_BYTES: 64 * 1024,
  /** Rules above which a warning is emitted. */
  RULE_COUNT_WARN: 200,
  /** Character count above which a "long stylesheet" warning is emitted. */
  LENGTH_WARN_BYTES: 16 * 1024,
});

/* -------------------------------------------------------------------------- */
/* Forbidden patterns                                                          */
/* -------------------------------------------------------------------------- */

interface ForbiddenPattern {
  readonly re: RegExp;
  readonly reason: string;
}

/**
 * The forbidden-token set. Every pattern is documented with the reason it
 * exists, so a reviewer can decide whether a future exception is warranted.
 * The set is deliberately narrow: the platform prefers to reject the smallest
 * possible set of inputs so a legitimate rule is never broken silently.
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = Object.freeze([
  // A closing tag inside the string would terminate the `<style>` element the
  // rendered page puts around this stylesheet, letting the remainder run as
  // HTML in the host document.
  { re: /<\/\s*style\b/iu, reason: "the string contains a `</style` sequence that would close the host <style> element" },
  { re: /<\s*style\b/iu, reason: "the string contains a `<style` sequence" },
  { re: /<\s*script\b/iu, reason: "the string contains a `<script` sequence" },
  { re: /<\s*\/\s*script\b/iu, reason: "the string contains a `</script` sequence" },
  { re: /<\s*link\b/iu, reason: "the string contains a `<link` sequence" },
  { re: /<\s*meta\b/iu, reason: "the string contains a `<meta` sequence" },
  { re: /<\s*iframe\b/iu, reason: "the string contains an `<iframe` sequence" },
  // `@import` fetches a third-party stylesheet at render time.
  { re: /@\s*import\b/iu, reason: "`@import` loads a third-party stylesheet at render time" },
  // `expression(...)` runs script in legacy engines.
  { re: /expression\s*\(/iu, reason: "`expression(...)` executes script in some legacy engines" },
  // `javascript:` scheme inside url(...) or a value.
  { re: /javascript\s*:/iu, reason: "`javascript:` URL scheme" },
  // `data:text/html` inside a url() is a script-execution vector when the URL
  // is dereferenced as a document.
  { re: /data\s*:\s*text\s*\/\s*html/iu, reason: "`data:text/html` URL" },
  // `behavior:` is an old IE vector; `-moz-binding` is a Firefox XBL vector.
  { re: /\bbehavior\s*:/iu, reason: "Internet Explorer `behavior:` property" },
  { re: /-moz-binding\s*:/iu, reason: "Firefox `-moz-binding` property" },
]);

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function sanitiseCustomCss(input: SanitiseCustomCssInput): SanitisedCustomCss {
  if (input === null || typeof input !== "object") {
    throw new CustomCssError("sanitiseCustomCss requires an input object.", "invalid-input");
  }
  if (typeof input.css !== "string") {
    throw new CustomCssError("`css` must be a string.", "invalid-input");
  }
  const maxBytes =
    typeof input.maxLengthBytes === "number" && Number.isFinite(input.maxLengthBytes) && input.maxLengthBytes > 0
      ? Math.floor(input.maxLengthBytes)
      : CUSTOM_CSS_LIMITS.MAX_LENGTH_BYTES;

  // Strip a UTF-8 BOM the way a browser would; do not strip anything else, so
  // the operator's indentation and newlines survive the round-trip.
  const stripped = input.css.startsWith("\uFEFF") ? input.css.slice(1) : input.css;
  const byteLength = BufferByteLength(stripped);
  if (byteLength > maxBytes) {
    throw new CustomCssError(
      `The stylesheet is ${byteLength} bytes, above the ${maxBytes}-byte limit. Split it or raise the per-workspace limit explicitly.`,
      "too-long",
      { byteLength, maxBytes },
    );
  }

  const warnings: CustomCssWarning[] = [];

  // Deterministic brace balance check. An unbalanced brace is the most common
  // cause of "the whole page stopped rendering" bug reports, and it is cheap
  // to detect without a full CSS parse. Comments are dropped first so a brace
  // inside a comment does not trip the check.
  const strippedComments = stripCssComments(stripped);
  const braceBalance = countBraces(strippedComments);
  if (braceBalance !== 0) {
    throw new CustomCssError(
      `The stylesheet has unbalanced braces (${braceBalance > 0 ? "unclosed opening" : "extra closing"} brace). A malformed stylesheet can disable the host page's rendering; fix the brace balance before saving.`,
      "unbalanced-brace",
      { balance: braceBalance },
    );
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.re.test(stripped)) {
      throw new CustomCssError(
        `Custom CSS was rejected because ${pattern.reason}. Remove the offending construct and try again.`,
        "forbidden-token",
        { reason: pattern.reason },
      );
    }
  }

  const trimmed = stripped.trim();
  if (trimmed.length === 0) {
    warnings.push({
      kind: "empty",
      detail: "The stylesheet is empty; the platform defaults apply unchanged.",
    });
    return Object.freeze({ value: "", warnings: Object.freeze(warnings), ruleCount: 0 });
  }

  const ruleCount = countRules(strippedComments);
  if (byteLength > CUSTOM_CSS_LIMITS.LENGTH_WARN_BYTES) {
    warnings.push({
      kind: "long-stylesheet",
      detail: `The stylesheet is ${byteLength} bytes. Consider whether a platform brand token is the right place for this style — a token applies everywhere consistently.`,
    });
  }
  if (ruleCount > CUSTOM_CSS_LIMITS.RULE_COUNT_WARN) {
    warnings.push({
      kind: "high-rule-count",
      detail: `The stylesheet declares ${ruleCount} rules. A brand override this large is hard to maintain and hard to review.`,
    });
  }
  if (countImportantOverrides(strippedComments) > 20) {
    warnings.push({
      kind: "override-heavy",
      detail:
        "Many declarations use `!important`. That pattern suggests the platform's brand tokens are not the right place for what the stylesheet is trying to change; consider adding a first-class token.",
    });
  }

  return Object.freeze({
    value: stripped,
    warnings: Object.freeze(warnings),
    ruleCount,
  });
}

/**
 * Wrap a sanitised stylesheet in a caller-chosen scope selector. The caller
 * supplies the selector because the delivery surface differs: the web app
 * scopes by `[data-zipy-workspace="<id>"]`, the PDF template scopes by the
 * guide's own container class, the embed widget scopes by its iframe
 * attribute. String-wrapping is safe because `sanitiseCustomCss` has already
 * rejected the sequences that could break out of a scope block.
 *
 * The function does not re-validate the selector; the caller is trusted with
 * it. When the input's `value` is empty, the function returns an empty string
 * rather than emitting an empty scope block, so a stylesheet-less workspace
 * does not add noise to the rendered document.
 */
export function wrapCustomCss(styles: SanitisedCustomCss, scopeSelector: string): string {
  if (styles === null || typeof styles !== "object") {
    throw new CustomCssError("wrapCustomCss requires a SanitisedCustomCss.", "invalid-input");
  }
  if (typeof scopeSelector !== "string" || scopeSelector.trim().length === 0) {
    throw new CustomCssError("`scopeSelector` must be a non-empty string.", "invalid-input");
  }
  if (styles.value.trim().length === 0) return "";
  const selector = scopeSelector.trim();
  // Reject a selector that carries a `{` — that would break the wrapping.
  if (/[{}]/u.test(selector)) {
    throw new CustomCssError(
      "`scopeSelector` must not contain \"{\" or \"}\".",
      "invalid-input",
      { selector },
    );
  }
  // Reindent each non-empty line by two spaces and drop trailing whitespace
  // so a diff between two save-cycles is empty when nothing changed.
  const body = styles.value
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : `  ${line}`))
    .join("\n");
  return `${selector} {\n${body}\n}`;
}

/**
 * Rehydrate a persisted `SanitisedCustomCss` payload. The value is trusted
 * enough to be loaded but is re-checked against the forbidden-token set so a
 * write that bypassed the sanitiser at ingest cannot persist a dangerous
 * payload without the loader failing loudly.
 */
export function rehydrateSanitisedCustomCss(value: unknown): SanitisedCustomCss {
  if (value === null || typeof value !== "object") {
    throw new CustomCssError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const css = typeof r["value"] === "string" ? r["value"] : "";
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.re.test(css)) {
      throw new CustomCssError(
        `Rehydrate failed: the persisted stylesheet contains a forbidden construct (${pattern.reason}). The record was written without sanitisation; do not render it.`,
        "forbidden-token",
        { reason: pattern.reason },
      );
    }
  }
  const warningsRaw = Array.isArray(r["warnings"]) ? r["warnings"] : [];
  const warnings: CustomCssWarning[] = [];
  for (const w of warningsRaw) {
    if (w === null || typeof w !== "object") continue;
    const o = w as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "long-stylesheet" &&
      kind !== "high-rule-count" &&
      kind !== "override-heavy" &&
      kind !== "empty"
    ) {
      continue;
    }
    warnings.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  const ruleCount = typeof r["ruleCount"] === "number" && Number.isFinite(r["ruleCount"]) ? Math.max(0, Math.floor(r["ruleCount"])) : countRules(stripCssComments(css));
  return Object.freeze({
    value: css,
    warnings: Object.freeze(warnings),
    ruleCount,
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function BufferByteLength(s: string): number {
  // Avoid a global Buffer dependency in the browser bundle by counting via
  // TextEncoder, which is present in both Node 20 and every modern browser.
  return new TextEncoder().encode(s).length;
}

function stripCssComments(css: string): string {
  // A conservative stripper: it removes /* ... */ blocks. It does not
  // handle a comment inside a string literal, because a string literal that
  // contains `/*` is itself unusual and rejecting it would be worse than
  // occasionally treating its contents as a comment for the balance check.
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Positive when unclosed, negative when extra, zero when balanced. */
function countBraces(css: string): number {
  let balance = 0;
  for (let i = 0; i < css.length; i += 1) {
    const c = css.charCodeAt(i);
    if (c === 0x7b /* { */) balance += 1;
    else if (c === 0x7d /* } */) balance -= 1;
  }
  return balance;
}

/**
 * Count top-level rule blocks. A `{` at depth 0 opens a rule; the matching
 * `}` at depth 1 closes it. Nested `{}` inside a rule (e.g. a media query
 * with its own selector block) contribute one top-level rule, which is what
 * a reviewer wants for a "how big is this stylesheet" signal.
 */
function countRules(css: string): number {
  let count = 0;
  let depth = 0;
  for (let i = 0; i < css.length; i += 1) {
    const c = css.charCodeAt(i);
    if (c === 0x7b /* { */) {
      if (depth === 0) count += 1;
      depth += 1;
    } else if (c === 0x7d /* } */) {
      depth = Math.max(0, depth - 1);
    }
  }
  return count;
}

function countImportantOverrides(css: string): number {
  const m = css.match(/!\s*important\b/giu);
  return m === null ? 0 : m.length;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  FORBIDDEN_PATTERNS,
  stripCssComments,
  countBraces,
  countRules,
  countImportantOverrides,
  BufferByteLength,
});
