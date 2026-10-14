/**
 * Zipy AI — JSON-LD schema markup generation (SEO/quality/safety phase, batch 0).
 *
 * Published guides can carry structured data so search engines understand the
 * page as a How-To, an FAQ or a general Article. This module produces one
 * `SchemaBundle` per guide containing the markup for whichever schema types
 * apply, plus the safety annotations (`@type`: schema.org) the site should
 * validate against.
 *
 * Design rules honoured:
 *  - No invented facts. Every schema field is a projection of the inputs the
 *    caller supplies (the SEO meta, the guide's steps, FAQ entries, authoring
 *    metadata). Fields the inputs do not cover are *omitted* rather than
 *    filled with a placeholder. A schema.org consumer sees only claims the
 *    guide actually makes.
 *  - The How-To schema is only produced when the plan contains at least one
 *    ordered step with text. An "Article" is always producible when the guide
 *    has a title; an "FAQPage" only when the guide has FAQ entries.
 *  - Emit-side only. This module never calls an LLM. The writer layer that
 *    composes the FAQ questions and step text is separate; this module turns
 *    those already-written strings into JSON-LD.
 *  - Deterministic given inputs. Field ordering is stable: the object is built
 *    in a fixed key order so export snapshots diff cleanly. No clock reads on
 *    the build path except `generatedAt` on the returned bundle.
 *  - The generated JSON-LD never contains a `@id`, `url`, `publisher` or
 *    `author` the caller did not supply. The platform does not invent a
 *    canonical URL; the publishing layer (a later phase) supplies one.
 *
 * The schema file is a pure function module; routes call `composeSchemaBundle`
 * and persist the resulting `SchemaBundle` alongside the guide's SEO meta.
 */

import type { SeoMeta } from "@zipy/seo/meta";
import type { AudienceProfile } from "@zipy/content/personalization/audience";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SchemaErrorCode = "invalid-input" | "shape";

export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SchemaErrorCode,
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
 * Optional page-level metadata the caller wants reflected in the schema.
 * Every field is optional; the composer only emits a property when it is
 * supplied. `null` and empty-string values are treated as absent.
 */
export interface PageMeta {
  /** The canonical URL of the published guide, when known. */
  readonly url: string | null;
  /** The language of the guide (BCP-47). Used as `inLanguage`. */
  readonly language: string | null;
  /** The publishing organisation's name. Used as `publisher.name`. */
  readonly publisherName: string | null;
  /** The publisher's logo URL. Used as `publisher.logo.url`. */
  readonly publisherLogoUrl: string | null;
  /** The date the guide was first published, ISO 8601. */
  readonly datePublished: string | null;
  /** The date the guide last changed, ISO 8601. */
  readonly dateModified: string | null;
  /** The author's display name. Used as `author.name`. */
  readonly authorName: string | null;
  /** A representative image for the guide (typically the first screenshot's annotated variant). */
  readonly imageUrl: string | null;
  /** Estimated completion time in minutes. Omitted when unknown. */
  readonly totalTimeMinutes: number | null;
}

export interface StepForSchema {
  /** 1-based position in the rendered guide. */
  readonly position: number;
  readonly name: string;
  readonly text: string;
  /** Optional canonical anchor, e.g. #step-3, when the export provides one. */
  readonly anchor: string | null;
  /** Relative path to the step's image, when one exists. */
  readonly imageUrl: string | null;
}

export interface FaqEntryForSchema {
  readonly question: string;
  readonly answer: string;
}

export interface ComposeSchemaInput {
  readonly seoMeta: SeoMeta;
  readonly steps: readonly StepForSchema[];
  readonly faq?: readonly FaqEntryForSchema[];
  readonly page?: PageMeta;
  readonly audience: AudienceProfile;
  /**
   * When false, the composer produces only the Article schema. Used when the
   * publisher has opted out of HowTo/FAQ rich results.
   */
  readonly enableRichResults?: boolean;
}

/**
 * The published schema bundle. Individual entries are the exact JSON-LD
 * objects the export layer will serialise into a `<script type="application/
 * ld+json">` block. The composer never emits an array at the top level: the
 * export layer chooses whether to emit one script per entry or one script
 * with an array, so the bundle stays serialisation-agnostic.
 */
export interface SchemaBundle {
  readonly version: "schema-markup/1";
  readonly article: ArticleSchema;
  readonly howTo: HowToSchema | null;
  readonly faq: FaqPageSchema | null;
  /** Advisory notes for the reviewer (e.g. "no image supplied"). */
  readonly notes: readonly SchemaNote[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface SchemaNote {
  readonly kind:
    | "no-image"
    | "no-url"
    | "no-steps"
    | "no-faq"
    | "short-description"
    | "rich-results-disabled";
  readonly detail: string;
}

export interface ArticleSchema {
  readonly "@context": "https://schema.org";
  readonly "@type": "Article";
  readonly headline: string;
  readonly description?: string;
  readonly inLanguage?: string;
  readonly datePublished?: string;
  readonly dateModified?: string;
  readonly image?: { readonly "@type": "ImageObject"; readonly url: string };
  readonly author?: { readonly "@type": "Person"; readonly name: string };
  readonly publisher?: {
    readonly "@type": "Organization";
    readonly name: string;
    readonly logo?: {
      readonly "@type": "ImageObject";
      readonly url: string;
    };
  };
  readonly mainEntityOfPage?: {
    readonly "@type": "WebPage";
    readonly "@id": string;
  };
}

export interface HowToStepSchema {
  readonly "@type": "HowToStep";
  readonly position: number;
  readonly name: string;
  readonly text: string;
  readonly url?: string;
  readonly image?: {
    readonly "@type": "ImageObject";
    readonly url: string;
  };
}

export interface HowToSchema {
  readonly "@context": "https://schema.org";
  readonly "@type": "HowTo";
  readonly name: string;
  readonly description?: string;
  readonly inLanguage?: string;
  readonly totalTime?: string;
  readonly image?: { readonly "@type": "ImageObject"; readonly url: string };
  readonly step: readonly HowToStepSchema[];
}

export interface FaqQuestionSchema {
  readonly "@type": "Question";
  readonly name: string;
  readonly acceptedAnswer: {
    readonly "@type": "Answer";
    readonly text: string;
  };
}

export interface FaqPageSchema {
  readonly "@context": "https://schema.org";
  readonly "@type": "FAQPage";
  readonly inLanguage?: string;
  readonly mainEntity: readonly FaqQuestionSchema[];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compose the schema bundle. Always produces an Article; produces HowTo when
 * `enableRichResults` is true and at least one step is present; produces
 * FAQPage when the same condition holds and at least one FAQ entry exists.
 */
export function composeSchemaBundle(input: ComposeSchemaInput): SchemaBundle {
  if (input === null || typeof input !== "object") {
    throw new SchemaError("composeSchemaBundle requires an input object.", "invalid-input");
  }
  if (input.seoMeta === null || typeof input.seoMeta !== "object") {
    throw new SchemaError("`seoMeta` is required and must be an object.", "invalid-input");
  }
  if (typeof input.seoMeta.title !== "string" || input.seoMeta.title.trim().length === 0) {
    throw new SchemaError(
      "`seoMeta.title` must be a non-empty string; the Article schema cannot be built without a headline.",
      "invalid-input",
    );
  }
  if (!Array.isArray(input.steps)) {
    throw new SchemaError("`steps` must be an array.", "invalid-input");
  }
  const faq = Array.isArray(input.faq) ? input.faq : [];
  const page: PageMeta = input.page ?? {
    url: null,
    language: null,
    publisherName: null,
    publisherLogoUrl: null,
    datePublished: null,
    dateModified: null,
    authorName: null,
    imageUrl: null,
    totalTimeMinutes: null,
  };

  const notes: SchemaNote[] = [];
  const richResults = input.enableRichResults !== false;
  if (!richResults) {
    notes.push({
      kind: "rich-results-disabled",
      detail:
        "HowTo and FAQPage rich result schemas were not produced because rich results are disabled for this guide.",
    });
  }
  if (page.url === null || page.url.trim().length === 0) {
    notes.push({
      kind: "no-url",
      detail:
        "No canonical URL was supplied; the schema omits `mainEntityOfPage` and step `url` properties rather than inventing one.",
    });
  }
  if (page.imageUrl === null || page.imageUrl.trim().length === 0) {
    notes.push({
      kind: "no-image",
      detail:
        "No representative image was supplied; the schema omits the `image` property rather than pointing at a placeholder.",
    });
  }

  const article = buildArticle(input.seoMeta, page);
  let howTo: HowToSchema | null = null;
  let faqPage: FaqPageSchema | null = null;
  if (richResults) {
    howTo = buildHowTo(input.seoMeta, input.steps, page, notes);
    faqPage = buildFaqPage(faq, page, notes);
  } else if (input.steps.length === 0) {
    notes.push({
      kind: "no-steps",
      detail: "The plan carries no steps; the HowTo schema could not be built.",
    });
  }

  return {
    version: "schema-markup/1",
    article,
    howTo,
    faq: faqPage,
    notes,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Build the JSON-LD `<script>` payload for the bundle. The export layer wraps
 * this string in `<script type="application/ld+json">...</script>`. The
 * composer never emits a top-level array; the caller chooses.
 */
export function renderSchemaScript(bundle: SchemaBundle): string {
  const parts: string[] = [];
  parts.push(JSON.stringify(bundle.article, null, 2));
  if (bundle.howTo !== null) parts.push(JSON.stringify(bundle.howTo, null, 2));
  if (bundle.faq !== null) parts.push(JSON.stringify(bundle.faq, null, 2));
  return parts.join("\n");
}

/**
 * The LLM-visible directive block. Rarely needed (the schema composer is
 * deterministic), but included for callers that ask the writer to propose the
 * FAQ questions or step names that later feed this module. The directive is
 * deliberately short: it tells the writer what the *prose* must look like for
 * the resulting schema to be valid.
 */
export function buildSchemaDirectives(): string {
  return [
    "You are producing the prose that will feed a HowTo, FAQPage and Article JSON-LD schema.",
    "The schema layer is deterministic; you do not write JSON. You write prose that satisfies the following:",
    "    - Each step's `name` is a short imperative phrase (e.g. 'Open the customer list').",
    "    - Each step's `text` is one self-contained sentence or short paragraph; do not begin with a pronoun that refers to a previous step.",
    "    - Each FAQ question is a question a real user would type. The answer is two to four sentences and stands on its own.",
    "    - Do not claim capabilities, integrations or data flows the sources do not describe.",
  ].join("\n");
}

export function rehydrateSchemaBundle(value: unknown): SchemaBundle {
  if (value === null || typeof value !== "object") {
    throw new SchemaError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "schema-markup/1") {
    throw new SchemaError(
      `Rehydrate failed: expected version "schema-markup/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  const article = readObject(r["article"]);
  if (article === null || article["@type"] !== "Article") {
    throw new SchemaError("Rehydrate failed: `article` is not an Article schema.", "shape");
  }
  const howToRaw = r["howTo"];
  const howTo: HowToSchema | null =
    howToRaw !== null && typeof howToRaw === "object" && (howToRaw as Record<string, unknown>)["@type"] === "HowTo"
      ? (howToRaw as HowToSchema)
      : null;
  const faqRaw = r["faq"];
  const faq: FaqPageSchema | null =
    faqRaw !== null && typeof faqRaw === "object" && (faqRaw as Record<string, unknown>)["@type"] === "FAQPage"
      ? (faqRaw as FaqPageSchema)
      : null;

  return {
    version: "schema-markup/1",
    article: article as unknown as ArticleSchema,
    howTo,
    faq,
    notes: readNotes(r["notes"]),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

function buildArticle(seoMeta: SeoMeta, page: PageMeta): ArticleSchema {
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: seoMeta.title,
  };
  if (seoMeta.description.trim().length > 0) out["description"] = seoMeta.description;
  if (page.language !== null && page.language.trim().length > 0) out["inLanguage"] = page.language;
  if (page.datePublished !== null && page.datePublished.trim().length > 0) {
    out["datePublished"] = page.datePublished;
  }
  if (page.dateModified !== null && page.dateModified.trim().length > 0) {
    out["dateModified"] = page.dateModified;
  }
  if (page.imageUrl !== null && page.imageUrl.trim().length > 0) {
    out["image"] = { "@type": "ImageObject", url: page.imageUrl };
  }
  if (page.authorName !== null && page.authorName.trim().length > 0) {
    out["author"] = { "@type": "Person", name: page.authorName };
  }
  if (page.publisherName !== null && page.publisherName.trim().length > 0) {
    const publisher: Record<string, unknown> = {
      "@type": "Organization",
      name: page.publisherName,
    };
    if (page.publisherLogoUrl !== null && page.publisherLogoUrl.trim().length > 0) {
      publisher["logo"] = { "@type": "ImageObject", url: page.publisherLogoUrl };
    }
    out["publisher"] = publisher;
  }
  if (page.url !== null && page.url.trim().length > 0) {
    out["mainEntityOfPage"] = { "@type": "WebPage", "@id": page.url };
  }
  return out as unknown as ArticleSchema;
}

function buildHowTo(
  seoMeta: SeoMeta,
  steps: readonly StepForSchema[],
  page: PageMeta,
  notes: SchemaNote[],
): HowToSchema | null {
  const valid = sanitiseSteps(steps);
  if (valid.length === 0) {
    notes.push({
      kind: "no-steps",
      detail: "The plan carries no usable steps; the HowTo schema was not produced.",
    });
    return null;
  }
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: seoMeta.title,
  };
  if (seoMeta.description.trim().length > 0) out["description"] = seoMeta.description;
  if (page.language !== null && page.language.trim().length > 0) out["inLanguage"] = page.language;
  if (
    page.totalTimeMinutes !== null &&
    Number.isFinite(page.totalTimeMinutes) &&
    page.totalTimeMinutes > 0
  ) {
    out["totalTime"] = toIsoDuration(page.totalTimeMinutes);
  }
  if (page.imageUrl !== null && page.imageUrl.trim().length > 0) {
    out["image"] = { "@type": "ImageObject", url: page.imageUrl };
  }
  out["step"] = valid.map((s) => buildHowToStep(s, page));
  return out as unknown as HowToSchema;
}

function buildHowToStep(step: StepForSchema, page: PageMeta): HowToStepSchema {
  const out: Record<string, unknown> = {
    "@type": "HowToStep",
    position: step.position,
    name: step.name,
    text: step.text,
  };
  if (page.url !== null && step.anchor !== null && step.anchor.trim().length > 0) {
    const base = page.url.replace(/#.*$/u, "");
    out["url"] = `${base}${step.anchor.startsWith("#") ? step.anchor : `#${step.anchor}`}`;
  }
  if (step.imageUrl !== null && step.imageUrl.trim().length > 0) {
    out["image"] = { "@type": "ImageObject", url: step.imageUrl };
  }
  return out as unknown as HowToStepSchema;
}

function buildFaqPage(
  faq: readonly FaqEntryForSchema[],
  page: PageMeta,
  notes: SchemaNote[],
): FaqPageSchema | null {
  const valid = sanitiseFaq(faq);
  if (valid.length === 0) {
    notes.push({
      kind: "no-faq",
      detail:
        "No FAQ entries were supplied; the FAQPage schema was not produced. Add FAQ entries in the content layer (packages/content/src/faq.ts) to enable it.",
    });
    return null;
  }
  const out: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
  };
  if (page.language !== null && page.language.trim().length > 0) out["inLanguage"] = page.language;
  out["mainEntity"] = valid.map((e) => ({
    "@type": "Question" as const,
    name: e.question,
    acceptedAnswer: { "@type": "Answer" as const, text: e.answer },
  }));
  return out as unknown as FaqPageSchema;
}

function sanitiseSteps(steps: readonly StepForSchema[]): readonly StepForSchema[] {
  const out: StepForSchema[] = [];
  for (const s of steps) {
    if (s === null || typeof s !== "object") continue;
    const name = typeof s.name === "string" ? s.name.trim() : "";
    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (name.length === 0 || text.length === 0) continue;
    const position = Number.isFinite(s.position) ? Math.max(1, Math.trunc(s.position)) : out.length + 1;
    out.push({
      position,
      name,
      text,
      anchor: typeof s.anchor === "string" && s.anchor.trim().length > 0 ? s.anchor.trim() : null,
      imageUrl:
        typeof s.imageUrl === "string" && s.imageUrl.trim().length > 0 ? s.imageUrl.trim() : null,
    });
  }
  out.sort((a, b) => a.position - b.position);
  // Renumber positions deterministically so a caller's sparse positions do not
  // produce gaps a search engine might interpret.
  return out.map((s, i) => ({ ...s, position: i + 1 }));
}

function sanitiseFaq(faq: readonly FaqEntryForSchema[]): readonly FaqEntryForSchema[] {
  const out: FaqEntryForSchema[] = [];
  for (const e of faq) {
    if (e === null || typeof e !== "object") continue;
    const q = typeof e.question === "string" ? e.question.trim() : "";
    const a = typeof e.answer === "string" ? e.answer.trim() : "";
    if (q.length === 0 || a.length === 0) continue;
    out.push({ question: q, answer: a });
  }
  return out;
}

/** Format a positive minute count as an ISO 8601 duration (PTxxM or PTxHxxM). */
function toIsoDuration(minutes: number): string {
  const total = Math.max(1, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total - hours * 60;
  if (hours === 0) return `PT${mins}M`;
  if (mins === 0) return `PT${hours}H`;
  return `PT${hours}H${mins}M`;
}

function readObject(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function readNotes(v: unknown): readonly SchemaNote[] {
  if (!Array.isArray(v)) return [];
  const out: SchemaNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "no-image" &&
      kind !== "no-url" &&
      kind !== "no-steps" &&
      kind !== "no-faq" &&
      kind !== "short-description" &&
      kind !== "rich-results-disabled"
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
  buildArticle,
  buildHowTo,
  buildHowToStep,
  buildFaqPage,
  sanitiseSteps,
  sanitiseFaq,
  toIsoDuration,
  readNotes,
  readObject,
});
