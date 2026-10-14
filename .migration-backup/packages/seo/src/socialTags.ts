/**
 * Zipy AI — Open Graph and Twitter Card tag generation (SEO/quality/safety phase, batch 0).
 *
 * Alongside `<title>`/`<meta name="description">` and the JSON-LD payload, a
 * published guide page needs Open Graph and Twitter Card tags so link previews
 * look correct and consistent with the guide. This module produces a
 * `SocialTags` bundle: exactly the `<meta property="og:*">` and
 * `<meta name="twitter:*">` values the export layer writes, plus the small
 * set of general tags (`description`, `canonical`, `robots`) that are trivially
 * derived from the same inputs.
 *
 * Design rules honoured:
 *  - No invented facts. `og:title` and `og:description` reuse the guide's SEO
 *    title and description; if the guide supplies a distinct social summary,
 *    that is used instead, but the composer never writes a summary the caller
 *    did not supply. The image URL must be supplied; without it, the composer
 *    emits no `og:image` tag rather than pointing at a placeholder.
 *  - Lengths are bounded per property. Open Graph and Twitter both truncate in
 *    readers of *some* clients; the composer fits at a word boundary and
 *    records the truncation so the reviewer sees it.
 *  - `og:type` is the industry-correct general type from the schema.org
 *    vocabulary ("article"). `twitter:card` defaults to
 *    "summary_large_image" when an image exists, otherwise "summary".
 *  - Deterministic given inputs. Values are emitted in a stable key order so
 *    a snapshot diff across regenerations is meaningful. The only clock read
 *    is `generatedAt`.
 *  - The composer never emits an analytics/pixel tag, a `fb:app_id` or a
 *    `twitter:site` handle the operator has not supplied. Sites that want to
 *    attribute the card must supply the handle.
 *
 * The output is a plain `SocialTags` object the export layer walks to emit the
 * `<meta>` elements. It is deliberately serialisation-agnostic so the same
 * bundle can feed HTML export, an iframe embed and a Next.js `generateMetadata`
 * call.
 */

import type { SeoMeta } from "@zipy/seo/meta";
import type { IndustryProfile } from "@zipy/content/personalization/industry";
import type { AudienceProfile } from "@zipy/content/personalization/audience";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SocialTagsErrorCode = "invalid-input" | "shape";

export class SocialTagsError extends Error {
  readonly code: SocialTagsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SocialTagsErrorCode,
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

/**
 * The card family. `summary` is the compact layout (uses a square or wide
 * small image); `summary_large_image` is the wide, prominent layout used when
 * the guide has a good hero image; `player` and `app` are deliberately not
 * offered because the platform publishes documents, not media.
 */
export const TWITTER_CARD_TYPES = ["summary", "summary_large_image"] as const;
export type TwitterCardType = (typeof TWITTER_CARD_TYPES)[number];

export interface SocialImage {
  /** Absolute URL of the image. Required when present. */
  readonly url: string;
  /** Alt text for the image. Recommended by both Open Graph and Twitter. */
  readonly alt: string;
  /** Width in pixels, when known. */
  readonly width: number | null;
  /** Height in pixels, when known. */
  readonly height: number | null;
}

export interface SocialTagsInput {
  readonly seoMeta: SeoMeta;
  /** A social-specific summary. Falls back to `seoMeta.description` when absent. */
  readonly socialSummary?: string | null;
  /** The canonical URL of the published guide, when known. */
  readonly canonicalUrl?: string | null;
  /** The image to embed. Omitted from the output entirely when null. */
  readonly image?: SocialImage | null;
  /** The site's primary X handle, including the leading @. Omitted when absent. */
  readonly twitterSite?: string | null;
  /** The guide author's X handle, including the leading @. Omitted when absent. */
  readonly twitterCreator?: string | null;
  /**
   * Overrides for `og:type`. Defaults to "article" (correct for a tutorial
   * guide); a caller that publishes a product page might pass "website".
   */
  readonly ogType?: string | null;
  /** Content locale, e.g. "en_US". Omitted when absent. */
  readonly ogLocale?: string | null;
  /** ISO 8601 date for `article:published_time`. Omitted when absent. */
  readonly articlePublishedTime?: string | null;
  /** ISO 8601 date for `article:modified_time`. Omitted when absent. */
  readonly articleModifiedTime?: string | null;
  /** Section label, e.g. "Onboarding". Omitted when absent. */
  readonly articleSection?: string | null;
  /** Keyword list for `article:tag`. Omitted when empty. */
  readonly articleTags?: readonly string[];
  /** When true, emit a `robots` meta with `noindex`. */
  readonly noIndex?: boolean;
  readonly audience: AudienceProfile;
  readonly industry: IndustryProfile;
}

export interface SocialTags {
  readonly version: "social-tags/1";
  /** Open Graph properties, keyed by the property suffix (e.g. `og:title`). */
  readonly openGraph: Readonly<Record<string, string>>;
  /** Twitter Card properties, keyed by the name suffix (e.g. `twitter:card`). */
  readonly twitter: Readonly<Record<string, string>>;
  /** General `<meta name="...">` tags: description, canonical, robots. */
  readonly general: Readonly<Record<string, string>>;
  /** Provenance of the summary (from the guide's SEO meta or a distinct social summary). */
  readonly summarySource: "social-summary" | "seo-description";
  readonly twitterCardType: TwitterCardType;
  readonly notes: readonly SocialTagsNote[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface SocialTagsNote {
  readonly kind:
    | "summary-truncated"
    | "title-truncated"
    | "no-image"
    | "no-image-alt"
    | "no-canonical"
    | "no-twitter-handle"
    | "image-dimensions-unknown";
  readonly detail: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const OG_TITLE_MAX = 70;
const OG_DESCRIPTION_MAX = 200;
const TWITTER_TITLE_MAX = 70;
const TWITTER_DESCRIPTION_MAX = 200;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeSocialTags(input: SocialTagsInput): SocialTags {
  if (input === null || typeof input !== "object") {
    throw new SocialTagsError("composeSocialTags requires an input object.", "invalid-input");
  }
  if (input.seoMeta === null || typeof input.seoMeta !== "object") {
    throw new SocialTagsError("`seoMeta` is required and must be an object.", "invalid-input");
  }
  const title = input.seoMeta.title.trim();
  if (title.length === 0) {
    throw new SocialTagsError(
      "`seoMeta.title` must be non-empty; social tags cannot be built without a title.",
      "invalid-input",
    );
  }

  const notes: SocialTagsNote[] = [];

  // Summary selection: prefer a distinct social summary, otherwise fall back
  // to the SEO description. Both are then fitted to the property-specific
  // length budget.
  const summaryCandidate =
    typeof input.socialSummary === "string" && input.socialSummary.trim().length > 0
      ? { text: input.socialSummary.trim(), source: "social-summary" as const }
      : { text: input.seoMeta.description.trim(), source: "seo-description" as const };

  const fittedTitle = fitTagValue(title, OG_TITLE_MAX);
  if (fittedTitle.truncated) {
    notes.push({
      kind: "title-truncated",
      detail: `Open Graph title truncated to ${OG_TITLE_MAX} characters.`,
    });
  }
  const fittedSummary = fitTagValue(summaryCandidate.text, OG_DESCRIPTION_MAX);
  if (fittedSummary.truncated) {
    notes.push({
      kind: "summary-truncated",
      detail: `Open Graph description truncated to ${OG_DESCRIPTION_MAX} characters.`,
    });
  }

  const twitterCardType: TwitterCardType = chooseCardType(input.image);
  const twitterTitle = fitTagValue(title, TWITTER_TITLE_MAX).text;
  const twitterDescription = fitTagValue(summaryCandidate.text, TWITTER_DESCRIPTION_MAX).text;

  const openGraph: Record<string, string> = {
    "og:title": fittedTitle.text,
    "og:type": typeof input.ogType === "string" && input.ogType.trim().length > 0 ? input.ogType.trim() : "article",
  };
  if (fittedSummary.text.length > 0) openGraph["og:description"] = fittedSummary.text;
  if (input.canonicalUrl !== null && input.canonicalUrl !== undefined && input.canonicalUrl.trim().length > 0) {
    openGraph["og:url"] = input.canonicalUrl.trim();
  }
  if (input.ogLocale !== null && input.ogLocale !== undefined && input.ogLocale.trim().length > 0) {
    openGraph["og:locale"] = input.ogLocale.trim();
  }
  if (input.image !== undefined && input.image !== null) {
    openGraph["og:image"] = input.image.url;
    if (input.image.alt.trim().length > 0) {
      openGraph["og:image:alt"] = input.image.alt.trim();
    } else {
      notes.push({
        kind: "no-image-alt",
        detail:
          "An image was supplied without alt text; the `og:image:alt` tag was omitted rather than guessed.",
      });
    }
    if (
      input.image.width !== null &&
      Number.isFinite(input.image.width) &&
      input.image.width > 0
    ) {
      openGraph["og:image:width"] = String(Math.floor(input.image.width));
    }
    if (
      input.image.height !== null &&
      Number.isFinite(input.image.height) &&
      input.image.height > 0
    ) {
      openGraph["og:image:height"] = String(Math.floor(input.image.height));
    }
    if (input.image.width === null || input.image.height === null) {
      notes.push({
        kind: "image-dimensions-unknown",
        detail:
          "Image width or height was not supplied; the `og:image:width`/`og:image:height` tags were omitted. Some clients use these to reserve layout space.",
      });
    }
  } else {
    notes.push({
      kind: "no-image",
      detail:
        "No image was supplied; the `og:image` tag was omitted. A link preview will use the client's default layout.",
    });
  }
  if (input.articlePublishedTime !== null && input.articlePublishedTime !== undefined && input.articlePublishedTime.trim().length > 0) {
    openGraph["article:published_time"] = input.articlePublishedTime.trim();
  }
  if (input.articleModifiedTime !== null && input.articleModifiedTime !== undefined && input.articleModifiedTime.trim().length > 0) {
    openGraph["article:modified_time"] = input.articleModifiedTime.trim();
  }
  if (input.articleSection !== null && input.articleSection !== undefined && input.articleSection.trim().length > 0) {
    openGraph["article:section"] = input.articleSection.trim();
  }
  if (Array.isArray(input.articleTags) && input.articleTags.length > 0) {
    // Open Graph's article:tag is repeated per tag; the bundle records the
    // tags as a pipe-separated string to keep the record type uniform. The
    // export layer splits on the separator when emitting the metatags.
    const tags = input.articleTags
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t) => t.trim());
    if (tags.length > 0) openGraph["article:tag"] = tags.join("|");
  }

  const twitter: Record<string, string> = {
    "twitter:card": twitterCardType,
    "twitter:title": twitterTitle,
  };
  if (twitterDescription.length > 0) twitter["twitter:description"] = twitterDescription;
  if (input.image !== undefined && input.image !== null) {
    twitter["twitter:image"] = input.image.url;
    if (input.image.alt.trim().length > 0) {
      twitter["twitter:image:alt"] = input.image.alt.trim();
    }
  }
  if (input.twitterSite !== null && input.twitterSite !== undefined && input.twitterSite.trim().length > 0) {
    twitter["twitter:site"] = normaliseHandle(input.twitterSite);
  } else {
    notes.push({
      kind: "no-twitter-handle",
      detail:
        "No site X handle was supplied; the `twitter:site` tag was omitted. The guide will not be attributed to a handle in card previews.",
    });
  }
  if (input.twitterCreator !== null && input.twitterCreator !== undefined && input.twitterCreator.trim().length > 0) {
    twitter["twitter:creator"] = normaliseHandle(input.twitterCreator);
  }

  const general: Record<string, string> = {};
  if (input.seoMeta.description.trim().length > 0) {
    general["description"] = fitTagValue(input.seoMeta.description.trim(), OG_DESCRIPTION_MAX).text;
  }
  if (input.canonicalUrl !== null && input.canonicalUrl !== undefined && input.canonicalUrl.trim().length > 0) {
    general["canonical"] = input.canonicalUrl.trim();
  } else {
    notes.push({
      kind: "no-canonical",
      detail:
        "No canonical URL was supplied; the `canonical` link was omitted. Publish step will not be able to reference this guide by URL.",
    });
  }
  general["robots"] = input.noIndex === true ? "noindex, nofollow" : "index, follow";

  return {
    version: "social-tags/1",
    openGraph,
    twitter,
    general,
    summarySource: summaryCandidate.source,
    twitterCardType,
    notes,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the bundle as `<meta>` and `<link>` elements. The export layer
 * embeds the returned string inside the guide's `<head>` (HTML export) or
 * converts it to a `Metadata` object (Next.js). Emitted in a stable order so
 * a diff across regenerations is meaningful.
 */
export function renderSocialTagsHtml(tags: SocialTags): string {
  const lines: string[] = [];
  lines.push('<meta charset="utf-8" />');
  // General first, then Open Graph, then Twitter — matches the conventional
  // ordering search engines and previewers expect.
  for (const [name, value] of Object.entries(tags.general)) {
    if (name === "canonical") {
      lines.push(`<link rel="canonical" href="${escapeAttr(value)}" />`);
    } else {
      lines.push(`<meta name="${escapeAttr(name)}" content="${escapeAttr(value)}" />`);
    }
  }
  for (const [prop, value] of Object.entries(tags.openGraph)) {
    if (prop === "article:tag") {
      // Split back into one meta per tag — that is what consumers expect.
      for (const tag of value.split("|")) {
        lines.push(`<meta property="article:tag" content="${escapeAttr(tag)}" />`);
      }
      continue;
    }
    lines.push(`<meta property="${escapeAttr(prop)}" content="${escapeAttr(value)}" />`);
  }
  for (const [name, value] of Object.entries(tags.twitter)) {
    lines.push(`<meta name="${escapeAttr(name)}" content="${escapeAttr(value)}" />`);
  }
  return lines.join("\n");
}

/**
 * Convert the bundle into a map suitable for a Next.js `Metadata` return
 * value. The caller merges this into the page's `generateMetadata` result.
 * Kept as a plain object so the module does not depend on the `next` package.
 */
export function socialTagsToNextMetadata(tags: SocialTags): {
  readonly openGraph: Readonly<Record<string, string>>;
  readonly twitter: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly alternates?: { readonly canonical: string };
  readonly robots?: string;
} {
  const description = tags.general["description"];
  const canonical = tags.general["canonical"];
  const robots = tags.general["robots"];
  const out: {
    openGraph: Record<string, string>;
    twitter: Record<string, string>;
    description?: string;
    alternates?: { canonical: string };
    robots?: string;
  } = {
    openGraph: { ...tags.openGraph },
    twitter: { ...tags.twitter },
  };
  if (description !== undefined) out.description = description;
  if (canonical !== undefined) out.alternates = { canonical };
  if (robots !== undefined) out.robots = robots;
  return out;
}

/**
 * The LLM-visible directive block. Used when the route asks the writer for a
 * distinct social summary separate from the guide's meta description. Short
 * and imperative.
 */
export function buildSocialTagsDirectives(input: {
  readonly seoMeta: SeoMeta;
  readonly audience: AudienceProfile;
  readonly industry: IndustryProfile;
}): string {
  const lines: string[] = [];
  lines.push("You are writing a short social-media summary for a published guide.");
  lines.push(
    `- Target ~150 characters; the hard limit is ${OG_DESCRIPTION_MAX} characters.`,
  );
  lines.push(
    "- One or two sentences. Active voice. The first sentence stands on its own when the card truncates the second.",
  );
  lines.push("- Do not use exclamation marks, emoji, hashtags or @-mentions.");
  lines.push(
    "- Do not restate the guide's title verbatim; the preview shows the title above the summary.",
  );
  if (input.audience.seniority === "expert") {
    lines.push("- Assume a technical reader; name the operation rather than the benefit.");
  } else if (input.audience.seniority === "novice") {
    lines.push("- Assume a new user; name the outcome, not the mechanism.");
  }
  if (input.seoMeta.keywordsPlaced.length > 0) {
    lines.push(
      `- You may repeat these keywords if they read naturally: ${input.seoMeta.keywordsPlaced.join(", ")}.`,
    );
  }
  lines.push(
    "- Do not claim capabilities, integrations or outcomes the guide's sources do not describe.",
  );
  if (input.industry.disclaimerCategories.length > 0) {
    lines.push(
      `- Do not promise a regulatory or compliance outcome; this guide's disclaimers (${input.industry.disclaimerCategories.join(", ")}) are produced by the safety layer.`,
    );
  }
  return lines.join("\n");
}

export function rehydrateSocialTags(value: unknown): SocialTags {
  if (value === null || typeof value !== "object") {
    throw new SocialTagsError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "social-tags/1") {
    throw new SocialTagsError(
      `Rehydrate failed: expected version "social-tags/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  const summarySource = r["summarySource"];
  const twitterCardType = r["twitterCardType"];
  return {
    version: "social-tags/1",
    openGraph: readStringRecord(r["openGraph"]),
    twitter: readStringRecord(r["twitter"]),
    general: readStringRecord(r["general"]),
    summarySource:
      summarySource === "social-summary" || summarySource === "seo-description"
        ? summarySource
        : "seo-description",
    twitterCardType:
      twitterCardType === "summary" || twitterCardType === "summary_large_image"
        ? twitterCardType
        : "summary",
    notes: readNotes(r["notes"]),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function chooseCardType(image: SocialImage | null | undefined): TwitterCardType {
  if (image === null || image === undefined) return "summary";
  const w = image.width;
  const h = image.height;
  if (w !== null && h !== null && Number.isFinite(w) && Number.isFinite(h) && h > 0) {
    // summary_large_image works best with a landscape image (aspect ≥ 2:1).
    return w / h >= 2 ? "summary_large_image" : "summary";
  }
  // Without dimensions, prefer the richer layout when an image exists at all.
  return "summary_large_image";
}

function fitTagValue(s: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = s.replace(/\s+/gu, " ").trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  // Cut at the last word boundary at or before maxChars.
  const slice = trimmed.slice(0, maxChars);
  let cut = slice.lastIndexOf(" ");
  if (cut < Math.floor(maxChars * 0.6)) cut = slice.length;
  const out = slice.slice(0, cut).replace(/[ ,;:.\-—–]+$/u, "");
  return { text: out, truncated: true };
}

function normaliseHandle(s: string): string {
  const t = s.trim();
  return t.startsWith("@") ? t : `@${t}`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readStringRecord(v: unknown): Readonly<Record<string, string>> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && val.length > 0) out[k] = val;
  }
  return out;
}

function readNotes(v: unknown): readonly SocialTagsNote[] {
  if (!Array.isArray(v)) return [];
  const out: SocialTagsNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "summary-truncated" &&
      kind !== "title-truncated" &&
      kind !== "no-image" &&
      kind !== "no-image-alt" &&
      kind !== "no-canonical" &&
      kind !== "no-twitter-handle" &&
      kind !== "image-dimensions-unknown"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  fitTagValue,
  normaliseHandle,
  escapeAttr,
  chooseCardType,
  readStringRecord,
  readNotes,
  OG_TITLE_MAX,
  OG_DESCRIPTION_MAX,
  TWITTER_TITLE_MAX,
  TWITTER_DESCRIPTION_MAX,
});
