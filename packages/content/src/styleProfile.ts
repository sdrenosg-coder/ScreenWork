/**
 * Zipy AI — style profile (content-generation, style batch 1).
 *
 * A `StyleProfile` is the single, per-guide configuration object that the
 * content pipeline reads to shape every layer's output: tone, reading level,
 * audience, industry, branding, terminology, translation preferences and
 * SEO keywords. It is persisted alongside the guide so a reviewer can see
 * exactly what style decisions produced a draft, and it is the payload the
 * `/api/styles/[id]` route validates and stores.
 *
 * This module does NOT generate content. It defines the profile shape, the
 * validation rules, the defaults, and a single composed directive builder
 * that every content layer uses to render its system prompt. By centralising
 * the directive build here, the pipeline cannot drift: a layer that forgets
 * the brand-voice directive, or the terminology directive, or the audience
 * directive, is impossible — the composed block always contains whatever
 * sub-modules were configured.
 *
 * Design rules honoured:
 *  - Every field is optional; the profile is meaningful at any fill level.
 *    Defaults are conservative and derived from the config system (no
 *    invented values). An empty profile is a valid profile.
 *  - Validation is structural: unknown fields, wrong types and out-of-range
 *    values all produce a descriptive error. The route returns them
 *    verbatim to the caller; the UI uses them to annotate the form.
 *  - Composition, not inheritance: the directive builder calls
 *    `buildBrandVoiceDirectives` and `buildTerminologyDirectives` when their
 *    sub-profiles are present, and produces a per-tone/per-level block for
 *    the scalar settings. Ordering is fixed so two runs that produce the
 *    same profile produce the same directive string (deterministic).
 *  - No external state, no LLM call, no I/O. Pure.
 */

import type {
  BrandVoiceProfile,
} from "./brandVoice";
import {
  buildBrandVoiceDirectives,
} from "./brandVoice";
import type { TerminologyProfile } from "./terminology";
import { buildTerminologyDirectives } from "./terminology";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type StyleProfileErrorCode =
  | "invalid-input"
  | "unknown-field"
  | "invalid-value";

export class StyleProfileError extends Error {
  readonly code: StyleProfileErrorCode;
  /** A JSON-pointer-like path to the offending field, e.g. "tone" or "audience". */
  readonly field: string;
  constructor(message: string, code: StyleProfileErrorCode, field: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export const TONES = ["formal", "casual", "technical"] as const;
export type Tone = (typeof TONES)[number];

export const AUDIENCES = ["end-user", "admin", "developer"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * Reading levels are expressed on the standard Flesch-Kincaid grade scale.
 * `targetGrade` is advisory: the LLM is told the target and the
 * `packages/content/src/readingLevel.ts` module measures the result.
 */
export interface ReadingLevelConfig {
  /** Flesch-Kincaid grade, typically 6–16. */
  readonly targetGrade: number;
  /** When true, the LLM is told to prefer shorter sentences at the cost of nuance. */
  readonly preferConcise?: boolean;
}

/**
 * Audience depth. `end-user` presumes familiarity with the product but not
 * with its internals; `admin` presumes the operator knows the configuration
 * model; `developer` presumes the reader may want to extend the workflow.
 */
export interface AudienceConfig {
  readonly audience: Audience;
  /** Free-form hints the workspace wants the writer to keep in mind. */
  readonly hints?: readonly string[];
}

/** Optional industry adaptation used to bias examples and terminology. */
export interface IndustryConfig {
  /** e.g. "healthcare", "finance", "retail", "education", "government". */
  readonly industry: string;
  /** Domains to avoid (e.g. "patient data", "PCI tokens") for compliance. */
  readonly avoidDomains?: readonly string[];
}

/**
 * Personalization directives: any of role, plan tier, or device can
 * partition the guide so dynamic content blocks are meaningful. Stored
 * verbatim; the personalization module reads them.
 */
export interface PersonalizationConfig {
  readonly roles?: readonly string[];
  readonly planTiers?: readonly string[];
  readonly devices?: readonly string[];
}

/**
 * Multilingual settings. The list is a target set — translation itself runs
 * in a later phase. RTL handling is a property of the target language and is
 * resolved by the i18n module, not stored here.
 */
export interface LanguageConfig {
  /** Source language of the guide ("en", "fr", etc). */
  readonly source: string;
  /** Target languages to produce on publish. */
  readonly targets: readonly string[];
  /** Terms that must not be translated (brand names, API names). */
  readonly doNotTranslate?: readonly string[];
}

/**
 * Branding tokens: these are the values that steer the export templates and
 * the on-page style, not the LLM. Kept here so the profile is a single
 * document.
 */
export interface BrandingConfig {
  readonly logoUrl?: string;
  readonly primaryColor?: string;
  readonly secondaryColor?: string;
  readonly fontFamily?: string;
  readonly customCss?: string;
}

/** SEO settings. The keyword list drives the meta/schema generation phase. */
export interface SeoConfig {
  readonly primaryKeyword?: string;
  readonly secondaryKeywords?: readonly string[];
  readonly canonicalSlug?: string;
}

/**
 * The full style profile. Every field is optional so partial profiles are
 * valid; a profile with nothing set is a valid profile that produces an
 * empty directive block.
 */
export interface StyleProfile {
  readonly tone?: Tone;
  readonly readingLevel?: ReadingLevelConfig;
  readonly audienceConfig?: AudienceConfig;
  readonly industry?: IndustryConfig;
  readonly personalization?: PersonalizationConfig;
  readonly language?: LanguageConfig;
  readonly branding?: BrandingConfig;
  readonly seo?: SeoConfig;
  /** Populated from `packages/content/src/brandVoice.ts`. */
  readonly brandVoice?: BrandVoiceProfile;
  /** Populated from `packages/content/src/terminology.ts`. */
  readonly terminology?: TerminologyProfile;
  /**
   * Optional LLM selection. When present, the layers prefer these overrides
   * over the server's default provider.
   */
  readonly llm?: {
    readonly provider?: string;
    readonly model?: string;
  };
  /**
   * The user id that last edited the profile, for the review UI. Not used
   * for authorization; RBAC is enforced by the route.
   */
  readonly updatedBy?: string;
  /** ISO timestamp of the last save, set by the API route. */
  readonly updatedAt?: string;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const PROVIDER_NAMES = ["openai", "anthropic", "gemini", "ollama", "vllm"] as const;
type ProviderName = (typeof PROVIDER_NAMES)[number];

const MAX_TERMS = 256;
const MAX_SHORT_STRING = 160;
const MAX_MEDIUM_STRING = 2000;
const MAX_CSS_LENGTH = 20_000;
const MAX_LANGUAGES = 24;

const LANGUAGE_TAG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate and normalise a raw payload into a `StyleProfile`. Throws a
 * `StyleProfileError` for the first problem encountered. Never invents
 * values: an absent field stays absent; a present but invalid field is an
 * error, not a defaulting.
 */
export function validateStyleProfile(raw: unknown): StyleProfile {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new StyleProfileError(
      "Style profile must be a JSON object.",
      "invalid-input",
      "(root)",
    );
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set<keyof StyleProfile | string>([
    "tone",
    "readingLevel",
    "audienceConfig",
    "industry",
    "personalization",
    "language",
    "branding",
    "seo",
    "brandVoice",
    "terminology",
    "llm",
    "updatedBy",
    "updatedAt",
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new StyleProfileError(
        `Unknown style field "${key}".`,
        "unknown-field",
        key,
      );
    }
  }

  const profile: {
    -readonly [K in keyof StyleProfile]: StyleProfile[K];
  } = {};

  // ---------------------------------------------------------------- tone --
  if (obj["tone"] !== undefined && obj["tone"] !== null) {
    const v = obj["tone"];
    if (typeof v !== "string" || !(TONES as readonly string[]).includes(v)) {
      throw new StyleProfileError(
        `tone must be one of: ${TONES.join(", ")}.`,
        "invalid-value",
        "tone",
      );
    }
    profile.tone = v as Tone;
  }

  // -------------------------------------------------------- readingLevel --
  if (obj["readingLevel"] !== undefined && obj["readingLevel"] !== null) {
    const v = obj["readingLevel"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError(
        "readingLevel must be an object.",
        "invalid-value",
        "readingLevel",
      );
    }
    const rl = v as Record<string, unknown>;
    for (const key of Object.keys(rl)) {
      if (key !== "targetGrade" && key !== "preferConcise") {
        throw new StyleProfileError(
          `Unknown readingLevel field "${key}".`,
          "unknown-field",
          `readingLevel.${key}`,
        );
      }
    }
    const tg = rl["targetGrade"];
    if (typeof tg !== "number" || !Number.isFinite(tg) || tg < 1 || tg > 20) {
      throw new StyleProfileError(
        "readingLevel.targetGrade must be a number between 1 and 20.",
        "invalid-value",
        "readingLevel.targetGrade",
      );
    }
    const preferConcise = rl["preferConcise"];
    if (preferConcise !== undefined && typeof preferConcise !== "boolean") {
      throw new StyleProfileError(
        "readingLevel.preferConcise must be a boolean when present.",
        "invalid-value",
        "readingLevel.preferConcise",
      );
    }
    profile.readingLevel = {
      targetGrade: tg,
      ...(typeof preferConcise === "boolean" ? { preferConcise } : {}),
    };
  }

  // ------------------------------------------------------- audienceConfig --
  if (obj["audienceConfig"] !== undefined && obj["audienceConfig"] !== null) {
    const v = obj["audienceConfig"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError(
        "audienceConfig must be an object.",
        "invalid-value",
        "audienceConfig",
      );
    }
    const ac = v as Record<string, unknown>;
    for (const key of Object.keys(ac)) {
      if (key !== "audience" && key !== "hints") {
        throw new StyleProfileError(
          `Unknown audienceConfig field "${key}".`,
          "unknown-field",
          `audienceConfig.${key}`,
        );
      }
    }
    const aud = ac["audience"];
    if (
      typeof aud !== "string" ||
      !(AUDIENCES as readonly string[]).includes(aud)
    ) {
      throw new StyleProfileError(
        `audienceConfig.audience must be one of: ${AUDIENCES.join(", ")}.`,
        "invalid-value",
        "audienceConfig.audience",
      );
    }
    let hints: string[] | undefined;
    if (ac["hints"] !== undefined && ac["hints"] !== null) {
      hints = readStringArray(ac["hints"], "audienceConfig.hints", MAX_TERMS);
    }
    profile.audienceConfig = {
      audience: aud as Audience,
      ...(hints !== undefined ? { hints } : {}),
    };
  }

  // -------------------------------------------------------------- industry --
  if (obj["industry"] !== undefined && obj["industry"] !== null) {
    const v = obj["industry"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError(
        "industry must be an object.",
        "invalid-value",
        "industry",
      );
    }
    const ind = v as Record<string, unknown>;
    for (const key of Object.keys(ind)) {
      if (key !== "industry" && key !== "avoidDomains") {
        throw new StyleProfileError(
          `Unknown industry field "${key}".`,
          "unknown-field",
          `industry.${key}`,
        );
      }
    }
    const name = ind["industry"];
    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      name.length > MAX_SHORT_STRING
    ) {
      throw new StyleProfileError(
        `industry.industry must be a non-empty string up to ${MAX_SHORT_STRING} characters.`,
        "invalid-value",
        "industry.industry",
      );
    }
    let avoidDomains: string[] | undefined;
    if (ind["avoidDomains"] !== undefined && ind["avoidDomains"] !== null) {
      avoidDomains = readStringArray(ind["avoidDomains"], "industry.avoidDomains", MAX_TERMS);
    }
    profile.industry = {
      industry: name.trim(),
      ...(avoidDomains !== undefined ? { avoidDomains } : {}),
    };
  }

  // ------------------------------------------------------- personalization --
  if (obj["personalization"] !== undefined && obj["personalization"] !== null) {
    const v = obj["personalization"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError(
        "personalization must be an object.",
        "invalid-value",
        "personalization",
      );
    }
    const p = v as Record<string, unknown>;
    for (const key of Object.keys(p)) {
      if (key !== "roles" && key !== "planTiers" && key !== "devices") {
        throw new StyleProfileError(
          `Unknown personalization field "${key}".`,
          "unknown-field",
          `personalization.${key}`,
        );
      }
    }
    const roles =
      p["roles"] !== undefined && p["roles"] !== null
        ? readStringArray(p["roles"], "personalization.roles", MAX_TERMS)
        : undefined;
    const planTiers =
      p["planTiers"] !== undefined && p["planTiers"] !== null
        ? readStringArray(p["planTiers"], "personalization.planTiers", MAX_TERMS)
        : undefined;
    const devices =
      p["devices"] !== undefined && p["devices"] !== null
        ? readStringArray(p["devices"], "personalization.devices", MAX_TERMS)
        : undefined;
    profile.personalization = {
      ...(roles !== undefined ? { roles } : {}),
      ...(planTiers !== undefined ? { planTiers } : {}),
      ...(devices !== undefined ? { devices } : {}),
    };
  }

  // -------------------------------------------------------------- language --
  if (obj["language"] !== undefined && obj["language"] !== null) {
    const v = obj["language"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError(
        "language must be an object.",
        "invalid-value",
        "language",
      );
    }
    const l = v as Record<string, unknown>;
    for (const key of Object.keys(l)) {
      if (key !== "source" && key !== "targets" && key !== "doNotTranslate") {
        throw new StyleProfileError(
          `Unknown language field "${key}".`,
          "unknown-field",
          `language.${key}`,
        );
      }
    }
    const source = l["source"];
    if (
      typeof source !== "string" ||
      !LANGUAGE_TAG_RE.test(source) ||
      source.length > MAX_SHORT_STRING
    ) {
      throw new StyleProfileError(
        "language.source must be a BCP-47-style language tag (e.g. \"en\", \"zh-Hans\").",
        "invalid-value",
        "language.source",
      );
    }
    if (!Array.isArray(l["targets"])) {
      throw new StyleProfileError(
        "language.targets must be an array of language tags.",
        "invalid-value",
        "language.targets",
      );
    }
    const targets: string[] = [];
    if (l["targets"].length > MAX_LANGUAGES) {
      throw new StyleProfileError(
        `language.targets supports at most ${MAX_LANGUAGES} entries.`,
        "invalid-value",
        "language.targets",
      );
    }
    for (let i = 0; i < l["targets"].length; i += 1) {
      const t = l["targets"][i];
      if (typeof t !== "string" || !LANGUAGE_TAG_RE.test(t) || t.length > MAX_SHORT_STRING) {
        throw new StyleProfileError(
          `language.targets[${i}] must be a BCP-47-style language tag.`,
          "invalid-value",
          `language.targets[${i}]`,
        );
      }
      if (!targets.includes(t)) targets.push(t);
    }
    const dnt =
      l["doNotTranslate"] !== undefined && l["doNotTranslate"] !== null
        ? readStringArray(l["doNotTranslate"], "language.doNotTranslate", MAX_TERMS)
        : undefined;
    profile.language = {
      source,
      targets,
      ...(dnt !== undefined ? { doNotTranslate: dnt } : {}),
    };
  }

  // -------------------------------------------------------------- branding --
  if (obj["branding"] !== undefined && obj["branding"] !== null) {
    const v = obj["branding"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError(
        "branding must be an object.",
        "invalid-value",
        "branding",
      );
    }
    const b = v as Record<string, unknown>;
    for (const key of Object.keys(b)) {
      if (
        key !== "logoUrl" &&
        key !== "primaryColor" &&
        key !== "secondaryColor" &&
        key !== "fontFamily" &&
        key !== "customCss"
      ) {
        throw new StyleProfileError(
          `Unknown branding field "${key}".`,
          "unknown-field",
          `branding.${key}`,
        );
      }
    }
    const branding: BrandingConfig = {};
    if (b["logoUrl"] !== undefined && b["logoUrl"] !== null) {
      const u = b["logoUrl"];
      if (typeof u !== "string" || !isHttpUrl(u) || u.length > MAX_MEDIUM_STRING) {
        throw new StyleProfileError(
          "branding.logoUrl must be an http(s) URL.",
          "invalid-value",
          "branding.logoUrl",
        );
      }
      (branding as { logoUrl?: string }).logoUrl = u;
    }
    for (const key of ["primaryColor", "secondaryColor"] as const) {
      if (b[key] === undefined || b[key] === null) continue;
      const c = b[key];
      if (typeof c !== "string" || !isHexColor(c)) {
        throw new StyleProfileError(
          `branding.${key} must be a hex colour like "#0a5cff".`,
          "invalid-value",
          `branding.${key}`,
        );
      }
      (branding as Record<string, string>)[key] = c;
    }
    if (b["fontFamily"] !== undefined && b["fontFamily"] !== null) {
      const f = b["fontFamily"];
      if (typeof f !== "string" || f.length === 0 || f.length > MAX_SHORT_STRING) {
        throw new StyleProfileError(
          `branding.fontFamily must be a non-empty string up to ${MAX_SHORT_STRING} characters.`,
          "invalid-value",
          "branding.fontFamily",
        );
      }
      (branding as { fontFamily?: string }).fontFamily = f;
    }
    if (b["customCss"] !== undefined && b["customCss"] !== null) {
      const c = b["customCss"];
      if (typeof c !== "string" || c.length > MAX_CSS_LENGTH) {
        throw new StyleProfileError(
          `branding.customCss must be a string up to ${MAX_CSS_LENGTH} characters.`,
          "invalid-value",
          "branding.customCss",
        );
      }
      (branding as { customCss?: string }).customCss = c;
    }
    profile.branding = branding;
  }

  // ------------------------------------------------------------------- seo --
  if (obj["seo"] !== undefined && obj["seo"] !== null) {
    const v = obj["seo"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError("seo must be an object.", "invalid-value", "seo");
    }
    const s = v as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (
        key !== "primaryKeyword" &&
        key !== "secondaryKeywords" &&
        key !== "canonicalSlug"
      ) {
        throw new StyleProfileError(
          `Unknown seo field "${key}".`,
          "unknown-field",
          `seo.${key}`,
        );
      }
    }
    const seo: SeoConfig = {};
    if (s["primaryKeyword"] !== undefined && s["primaryKeyword"] !== null) {
      const k = s["primaryKeyword"];
      if (typeof k !== "string" || k.trim().length === 0 || k.length > MAX_SHORT_STRING) {
        throw new StyleProfileError(
          "seo.primaryKeyword must be a non-empty string.",
          "invalid-value",
          "seo.primaryKeyword",
        );
      }
      (seo as { primaryKeyword?: string }).primaryKeyword = k.trim();
    }
    if (s["secondaryKeywords"] !== undefined && s["secondaryKeywords"] !== null) {
      (seo as { secondaryKeywords?: readonly string[] }).secondaryKeywords =
        readStringArray(s["secondaryKeywords"], "seo.secondaryKeywords", MAX_TERMS);
    }
    if (s["canonicalSlug"] !== undefined && s["canonicalSlug"] !== null) {
      const slug = s["canonicalSlug"];
      if (typeof slug !== "string" || !SLUG_RE.test(slug) || slug.length > MAX_SHORT_STRING) {
        throw new StyleProfileError(
          "seo.canonicalSlug must be a lowercase URL slug like \"add-a-customer\".",
          "invalid-value",
          "seo.canonicalSlug",
        );
      }
      (seo as { canonicalSlug?: string }).canonicalSlug = slug;
    }
    profile.seo = seo;
  }

  // ------------------------------------------------------------ brandVoice --
  if (obj["brandVoice"] !== undefined && obj["brandVoice"] !== null) {
    // The concrete shape is validated by the brandVoice module's own
    // rehydrate; here we only require that it is an object. Deeper
    // validation runs when the sub-module reads it.
    const v = obj["brandVoice"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError(
        "brandVoice must be an object (or omit it).",
        "invalid-value",
        "brandVoice",
      );
    }
    profile.brandVoice = v as BrandVoiceProfile;
  }

  // ----------------------------------------------------------- terminology --
  if (obj["terminology"] !== undefined && obj["terminology"] !== null) {
    const v = obj["terminology"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError(
        "terminology must be an object (or omit it).",
        "invalid-value",
        "terminology",
      );
    }
    profile.terminology = v as TerminologyProfile;
  }

  // ------------------------------------------------------------------- llm --
  if (obj["llm"] !== undefined && obj["llm"] !== null) {
    const v = obj["llm"];
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new StyleProfileError("llm must be an object.", "invalid-value", "llm");
    }
    const l = v as Record<string, unknown>;
    for (const key of Object.keys(l)) {
      if (key !== "provider" && key !== "model") {
        throw new StyleProfileError(
          `Unknown llm field "${key}".`,
          "unknown-field",
          `llm.${key}`,
        );
      }
    }
    const llm: { provider?: string; model?: string } = {};
    if (l["provider"] !== undefined && l["provider"] !== null) {
      const p = l["provider"];
      if (typeof p !== "string" || !(PROVIDER_NAMES as readonly string[]).includes(p)) {
        throw new StyleProfileError(
          `llm.provider must be one of: ${PROVIDER_NAMES.join(", ")}.`,
          "invalid-value",
          "llm.provider",
        );
      }
      llm.provider = p as ProviderName;
    }
    if (l["model"] !== undefined && l["model"] !== null) {
      const m = l["model"];
      if (typeof m !== "string" || m.trim().length === 0 || m.length > MAX_SHORT_STRING) {
        throw new StyleProfileError(
          "llm.model must be a non-empty string.",
          "invalid-value",
          "llm.model",
        );
      }
      llm.model = m.trim();
    }
    profile.llm = llm;
  }

  // ------------------------------------------------------------ provenance --
  if (obj["updatedBy"] !== undefined && obj["updatedBy"] !== null) {
    const u = obj["updatedBy"];
    if (typeof u !== "string" || u.length === 0 || u.length > MAX_SHORT_STRING) {
      throw new StyleProfileError(
        "updatedBy must be a non-empty string.",
        "invalid-value",
        "updatedBy",
      );
    }
    profile.updatedBy = u;
  }
  if (obj["updatedAt"] !== undefined && obj["updatedAt"] !== null) {
    const u = obj["updatedAt"];
    if (typeof u !== "string" || Number.isNaN(Date.parse(u))) {
      throw new StyleProfileError(
        "updatedAt must be an ISO timestamp string.",
        "invalid-value",
        "updatedAt",
      );
    }
    profile.updatedAt = u;
  }

  return profile as StyleProfile;
}

/* -------------------------------------------------------------------------- */
/* Directive composition                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the LLM system-prompt block for a style profile. Fixed ordering:
 *
 *   1. Tone
 *   2. Reading level
 *   3. Audience + industry
 *   4. Personalization
 *   5. Language
 *   6. Terminology (from `packages/content/src/terminology.ts`)
 *   7. Brand voice (from `packages/content/src/brandVoice.ts`)
 *
 * The two sub-module directives have their own preamble, so they are
 * appended verbatim; the scalar sections are generated here.
 *
 * An empty profile yields an empty string. Callers append this block (with
 * a blank line separator) to their own system prompt; the block never
 * assumes a specific layer name.
 */
export function buildStyleDirectives(profile: StyleProfile): string {
  const blocks: string[] = [];

  // ------------------------------------------------------------------ tone
  if (profile.tone !== undefined) {
    blocks.push(`Tone: ${TONE_DIRECTIVES[profile.tone]}`);
  }

  // --------------------------------------------------------- readingLevel
  if (profile.readingLevel !== undefined) {
    const rl = profile.readingLevel;
    const parts = [
      `Target the reading level of a US grade ${formatGrade(rl.targetGrade)} reader.`,
    ];
    if (rl.preferConcise === true) {
      parts.push("Prefer short sentences over elaborate ones.");
    }
    blocks.push(parts.join(" "));
  }

  // ------------------------------------------- audience + industry
  if (profile.audienceConfig !== undefined) {
    const a = profile.audienceConfig;
    const lines = [`Audience: ${AUDIENCE_DIRECTIVES[a.audience]}`];
    if (a.hints !== undefined && a.hints.length > 0) {
      lines.push(`Audience hints: ${a.hints.join("; ")}.`);
    }
    blocks.push(lines.join(" "));
  }
  if (profile.industry !== undefined) {
    const i = profile.industry;
    const parts = [
      `Adapt examples and terminology to the ${i.industry} industry.`,
    ];
    if (i.avoidDomains !== undefined && i.avoidDomains.length > 0) {
      parts.push(
        `Do not write examples that touch these topics: ${i.avoidDomains.join(", ")}.`,
      );
    }
    parts.push("Do not invent regulatory or legal claims.");
    blocks.push(parts.join(" "));
  }

  // -------------------------------------------------------- personalization
  if (profile.personalization !== undefined) {
    const p = profile.personalization;
    const parts: string[] = [];
    if (p.roles !== undefined && p.roles.length > 0) {
      parts.push(
        `Where it clarifies the workflow, indicate which roles can perform each step (roles in scope: ${p.roles.join(", ")}).`,
      );
    }
    if (p.planTiers !== undefined && p.planTiers.length > 0) {
      parts.push(
        `Note where availability depends on a plan tier (tiers in scope: ${p.planTiers.join(", ")}).`,
      );
    }
    if (p.devices !== undefined && p.devices.length > 0) {
      parts.push(
        `Mention device-specific differences when they exist (devices in scope: ${p.devices.join(", ")}).`,
      );
    }
    if (parts.length > 0) {
      parts.push(
        "Do not invent entitlement rules; state only differences the sources support.",
      );
      blocks.push(parts.join(" "));
    }
  }

  // -------------------------------------------------------------- language
  if (profile.language !== undefined) {
    const l = profile.language;
    const parts = [
      `Write the guide in "${l.source}" (BCP-47).`,
    ];
    if (l.targets.length > 0) {
      parts.push(
        `Translations will be produced for: ${l.targets.join(", ")}. Keep sentences translation-friendly.`,
      );
    }
    if (l.doNotTranslate !== undefined && l.doNotTranslate.length > 0) {
      parts.push(
        `Do not translate these terms: ${l.doNotTranslate.join(", ")}.`,
      );
    }
    blocks.push(parts.join(" "));
  }

  // ----------------------------------------------------------- terminology
  if (profile.terminology !== undefined) {
    const termBlock = buildTerminologyDirectives(profile.terminology);
    if (termBlock.length > 0) blocks.push(termBlock);
  }

  // ------------------------------------------------------------ brandVoice
  if (profile.brandVoice !== undefined) {
    const voiceBlock = buildBrandVoiceDirectives(profile.brandVoice);
    if (voiceBlock.length > 0) blocks.push(voiceBlock);
  }

  return blocks.join("\n\n");
}

const TONE_DIRECTIVES: Readonly<Record<Tone, string>> = Object.freeze({
  formal:
    "Write in a formal, professional register. Use complete sentences. Avoid contractions and exclamation marks.",
  casual:
    "Write in a friendly, conversational register. Contractions are welcome. Keep the tone encouraging but never vague.",
  technical:
    "Write in a precise, technical register. Name UI elements by their exact labels. Prefer specific instructions over general guidance.",
});

const AUDIENCE_DIRECTIVES: Readonly<Record<Audience, string>> = Object.freeze({
  "end-user":
    "The reader uses the product but does not administer or extend it. Do not describe configuration internals or APIs.",
  admin:
    "The reader configures the product for a team and understands its configuration model. Include settings, permissions and administrative consequences.",
  developer:
    "The reader may want to extend or integrate the workflow. Include exact field names, endpoints or code identifiers where the sources support them, but do not invent them.",
});

/* -------------------------------------------------------------------------- */
/* Public helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Return the number of non-empty top-level fields in a profile. The UI uses
 * this to indicate fill level without duplicating the field list.
 */
export function countPopulatedFields(profile: StyleProfile): number {
  let count = 0;
  for (const key of Object.keys(profile) as (keyof StyleProfile)[]) {
    const v = profile[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      if (Object.keys(v as object).length > 0) count += 1;
    } else {
      count += 1;
    }
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function readStringArray(
  value: unknown,
  field: string,
  maxEntries: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new StyleProfileError(
      `${field} must be an array of strings.`,
      "invalid-value",
      field,
    );
  }
  if (value.length > maxEntries) {
    throw new StyleProfileError(
      `${field} supports at most ${maxEntries} entries.`,
      "invalid-value",
      field,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new StyleProfileError(
        `${field}[${i}] must be a non-empty string.`,
        "invalid-value",
        `${field}[${i}]`,
      );
    }
    if (entry.length > MAX_SHORT_STRING) {
      throw new StyleProfileError(
        `${field}[${i}] exceeds the ${MAX_SHORT_STRING}-character limit.`,
        "invalid-value",
        `${field}[${i}]`,
      );
    }
    out.push(entry.trim());
  }
  return out;
}

function isHttpUrl(s: string): boolean {
  try {
    const url = new URL(s);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isHexColor(s: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s);
}

function formatGrade(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  isHttpUrl,
  isHexColor,
  formatGrade,
  readStringArray,
  TONE_DIRECTIVES,
  AUDIENCE_DIRECTIVES,
  PROVIDER_NAMES,
  LANGUAGE_TAG_RE,
  SLUG_RE,
});
