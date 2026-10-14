/**
 * Zipy AI — disclaimer generation (SEO/quality/safety phase, batch 3).
 *
 * Produces the legal, medical, financial and security disclaimers that must
 * accompany a generated guide (or long-form article, SOP, blog post, email,
 * social post) depending on:
 *
 *   - the guide's industry profile (healthcare, finance, legal, education,
 *     etc.);
 *   - the guide's audience profile (a novice end-user receives a stronger
 *     caution than an expert administrator, for the same operation);
 *   - the guide's action risk profile — as classified by the review phase —
 *     including destructive, financial and PII-adjacent actions;
 *   - the target content type (a DOCX exported runbook carries the same
 *     disclaimer as the PDF export, but a social post does not, because the
 *     disclaimer cannot fit within the post's character budget and the
 *     platform's terms preclude it).
 *
 * This module is deliberately *not* a lawyer. It composes from a
 * reviewable, versioned catalogue of templates and records, per disclaimer,
 * the template id and version it used — so an operator who edits the
 * catalogue can see exactly which fragments changed, and a legal reviewer who
 * approves a template can point at a stable id. It does not invent a legal
 * conclusion, does not claim compliance with any framework, and never
 * supersedes a human legal review.
 *
 * Design rules honoured:
 *  - Deterministic given inputs. The same input parameters always produce the
 *    same catalogue selection in the same order.
 *  - Every disclaimer is source-attributed to a template. The `templateId`
 *    and `templateVersion` fields let the review UI show "this disclaimer
 *    came from the healthcare-v2 catalogue", so a legal change is traceable.
 *  - No placeholder text is emitted at render time. A template whose
 *    variables are not resolvable at build time is skipped, and the skip is
 *    recorded as a note rather than emitting a `{{company_name}}` sentinel.
 *  - The catalogue is a data table, not an LLM call. The LLM does not write
 *    disclaimers; it composes them from the catalogue. `buildDisclaimers`
 *    returns `Disclaimers` which the pipeline inserts into the generated
 *    content.
 *
 * The module exports:
 *   - `buildDisclaimers` — the primary entry point.
 *   - `renderDisclaimersHtml` — an export-ready HTML fragment.
 *   - `renderDisclaimersMarkdown` — an export-ready Markdown block.
 *   - `buildDisclaimerDirectives` — the LLM-visible block.
 *   - `rehydrateDisclaimers` — typed load of a persisted payload.
 *   - `__internals` — the catalogue, exported for tests.
 */

import type { AudienceProfile } from "@zipy/content/personalization/audience";
import type { IndustryProfile } from "@zipy/content/personalization/industry";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DisclaimersErrorCode = "invalid-input" | "shape" | "unknown-template";

export class DisclaimersError extends Error {
  readonly code: DisclaimersErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DisclaimersErrorCode,
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
 * Where the disclaimer ends up. The export layer dispatches on this to
 * choose the correct render surface.
 */
export const DISCLAIMER_PLACEMENTS = [
  "guide-top",
  "guide-footer",
  "step-inline",
  "article-footer",
  "email-footer",
  "social-post-omitted",
] as const;
export type DisclaimerPlacement = (typeof DISCLAIMER_PLACEMENTS)[number];

/**
 * The taxonomy. Categories are stable identifiers; the actual wording is a
 * catalogue entry. Categories are referenced by the industry and audience
 * profiles so a new industry can reuse existing categories.
 */
export const DISCLAIMER_CATEGORIES = [
  "general-informational",
  "no-warranty",
  "professional-advice-medical",
  "professional-advice-legal",
  "professional-advice-financial",
  "professional-advice-security",
  "ai-generated",
  "data-handling",
  "regulated-product",
  "regulated-product-health",
  "regulated-product-financial",
  "destructive-action-warning",
  "financial-action-warning",
  "pii-handling-warning",
  "beta-feature",
  "third-party-integration",
  "compliance-not-certification",
] as const;
export type DisclaimerCategory = (typeof DISCLAIMER_CATEGORIES)[number];

export interface DisclaimerCatalogueEntry {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly category: DisclaimerCategory;
  /**
   * Templates are functions so the caller can supply the deployment's legal
   * entity name, jurisdiction and contact. A `null` return value means the
   * template cannot be rendered with the supplied context — its placeholders
   * are unresolved — and the entry will be skipped with a note.
   */
  readonly render: (ctx: DisclaimerContext) => string | null;
  /** Categories this template is a substitute for (e.g. general-informational when no-warranty is present). */
  readonly supersedes?: readonly DisclaimerCategory[];
}

export interface DisclaimerContext {
  /** Legal name of the publisher. `null` when not supplied by the operator. */
  readonly publisherLegalName: string | null;
  /** Public contact for the guide, e.g. a support email. `null` when not supplied. */
  readonly supportContact: string | null;
  /** Jurisdiction label for jurisdiction-specific warnings. `null` when not supplied. */
  readonly jurisdiction: string | null;
  /** True when the target content is an AI-generated guide (as opposed to an ingested source re-published). */
  readonly aiGenerated: boolean;
  /** True when the guide's workflow includes a destructive action. */
  readonly includesDestructiveAction: boolean;
  /** True when the guide's workflow includes a financial action (payment, transfer, refund). */
  readonly includesFinancialAction: boolean;
  /** True when the guide's workflow handles identifiable personal data. */
  readonly includesPiiHandling: boolean;
  /** True when the guide's workflow calls a third-party integration. */
  readonly includesThirdPartyIntegration: boolean;
  /** True when the guide documents a beta feature. */
  readonly includesBetaFeature: boolean;
  /** True when the guide asserts a framework certification (HIPAA, PCI-DSS, SOC 2, ...). */
  readonly assertsCertification: boolean;
  /** Placement the disclaimer will occupy. */
  readonly placement: DisclaimerPlacement;
}

export interface Disclaimer {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly category: DisclaimerCategory;
  readonly placement: DisclaimerPlacement;
  /** Fully rendered text with all variables resolved. */
  readonly text: string;
}

export interface Disclaimers {
  readonly version: "disclaimers/1";
  readonly disclaimers: readonly Disclaimer[];
  /**
   * Categories requested by the profile that could not be rendered because
   * their template's context was incomplete (e.g. no publisher legal name).
   * Recorded so an operator sees the gap rather than a silently shorter block.
   */
  readonly skipped: readonly { readonly category: DisclaimerCategory; readonly reason: string }[];
  readonly notes: readonly DisclaimersNote[];
  readonly summary: {
    readonly total: number;
    readonly skipped: number;
    readonly categories: readonly DisclaimerCategory[];
  };
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface DisclaimersNote {
  readonly kind:
    | "no-publisher-legal-name"
    | "no-support-contact"
    | "no-jurisdiction"
    | "placement-social-omitted"
    | "certification-assertion-flagged"
    | "financial-action-flagged"
    | "destructive-action-flagged"
    | "pii-handling-flagged"
    | "third-party-integration-flagged"
    | "beta-feature-flagged"
    | "category-unmatched";
  readonly detail: string;
}

export interface BuildDisclaimersInput {
  readonly audience: AudienceProfile;
  readonly industry: IndustryProfile;
  readonly placement: DisclaimerPlacement;
  readonly publisherLegalName?: string | null;
  readonly supportContact?: string | null;
  readonly jurisdiction?: string | null;
  readonly aiGenerated?: boolean;
  readonly includesDestructiveAction?: boolean;
  readonly includesFinancialAction?: boolean;
  readonly includesPiiHandling?: boolean;
  readonly includesThirdPartyIntegration?: boolean;
  readonly includesBetaFeature?: boolean;
  readonly assertsCertification?: boolean;
}

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The catalogue is versioned as a whole with the `templateVersion` field on
 * each entry. Adding an entry is a data change; deprecating one is a data
 * change that keeps the `templateId` (so an export rendered with the old
 * version can be diffed against an export rendered with the new one).
 */
export const DEFAULT_CATALOGUE: readonly DisclaimerCatalogueEntry[] = Object.freeze([
  /* ------------------------------------------------------------------ */
  /* General informational                                              */
  /* ------------------------------------------------------------------ */
  {
    templateId: "general.informational.v1",
    templateVersion: "1",
    category: "general-informational",
    render: () =>
      "This guide is provided for informational purposes. It describes a workflow and is not a substitute for the product's own documentation or a professional's advice.",
  },
  {
    templateId: "general.no-warranty.v1",
    templateVersion: "1",
    category: "no-warranty",
    render: (ctx) => {
      const who =
        ctx.publisherLegalName !== null
          ? `"${ctx.publisherLegalName}"`
          : "the publisher of this guide";
      return `${who} makes no warranty, express or implied, regarding the accuracy of this guide or the workflow it describes. Steps in the product may change without notice.`;
    },
    supersedes: ["general-informational"],
  },
  {
    templateId: "general.ai-generated.v1",
    templateVersion: "1",
    category: "ai-generated",
    render: (ctx) => {
      if (!ctx.aiGenerated) return null;
      return "This guide was generated by Zipy AI from the sources the author provided and is labelled as AI-generated. A human reviewer approved the published version; the platform does not claim the guide is free of inaccuracies.";
    },
  },
  {
    templateId: "general.data-handling.v1",
    templateVersion: "1",
    category: "data-handling",
    render: (ctx) => {
      if (!ctx.includesPiiHandling) return null;
      const contact =
        ctx.supportContact !== null
          ? ` Contact ${ctx.supportContact} for data-subject requests.`
          : "";
      return `This workflow handles personal data. Follow your organisation's data-handling policy and any applicable data-protection law.${contact}`;
    },
  },
  /* ------------------------------------------------------------------ */
  /* Professional-advice overreach                                      */
  /* ------------------------------------------------------------------ */
  {
    templateId: "professional.medical.v1",
    templateVersion: "1",
    category: "professional-advice-medical",
    render: () =>
      "This guide does not constitute medical advice. Clinical decisions must be made by a licensed professional with the complete patient record.",
  },
  {
    templateId: "professional.legal.v1",
    templateVersion: "1",
    category: "professional-advice-legal",
    render: () =>
      "This guide does not constitute legal advice. Consult qualified counsel before acting on anything described here.",
  },
  {
    templateId: "professional.financial.v1",
    templateVersion: "1",
    category: "professional-advice-financial",
    render: () =>
      "This guide does not constitute financial advice. Investment, tax and accounting decisions require a qualified professional and a review of your own circumstances.",
  },
  {
    templateId: "professional.security.v1",
    templateVersion: "1",
    category: "professional-advice-security",
    render: () =>
      "This guide does not constitute a security audit or assurance. Perform your own security review before deploying anything described here in a production environment.",
  },
  /* ------------------------------------------------------------------ */
  /* Regulated product                                                  */
  /* ------------------------------------------------------------------ */
  {
    templateId: "regulated.health.v1",
    templateVersion: "1",
    category: "regulated-product-health",
    render: () =>
      "Nothing in this guide claims a therapeutic benefit, an FDA clearance, a CE mark, or any other regulatory approval. Refer to the product's regulatory documentation for its cleared use.",
  },
  {
    templateId: "regulated.financial.v1",
    templateVersion: "1",
    category: "regulated-product-financial",
    render: () =>
      "Nothing in this guide is an offer or solicitation to buy or sell any security or financial instrument, and no outcome described here is guaranteed.",
  },
  {
    templateId: "regulated.not-certification.v1",
    templateVersion: "1",
    category: "compliance-not-certification",
    render: (ctx) => {
      if (!ctx.assertsCertification) return null;
      return "Any reference to a compliance framework (HIPAA, PCI-DSS, SOC 2, GDPR, ISO 27001, or similar) in this guide is not a claim of certification or attestation. The product's certifications are stated only in its official compliance documentation.";
    },
  },
  /* ------------------------------------------------------------------ */
  /* Action-specific warnings                                           */
  /* ------------------------------------------------------------------ */
  {
    templateId: "action.destructive.v1",
    templateVersion: "1",
    category: "destructive-action-warning",
    render: (ctx) => {
      if (!ctx.includesDestructiveAction) return null;
      return "This workflow includes an action that cannot be undone through the interface. Confirm you are operating on the intended record before proceeding, and verify that your backup or retention policy covers the operation.";
    },
  },
  {
    templateId: "action.financial.v1",
    templateVersion: "1",
    category: "financial-action-warning",
    render: (ctx) => {
      if (!ctx.includesFinancialAction) return null;
      return "This workflow moves money or changes a financial record. Verify the amount, the destination account and the currency before confirming, and retain the confirmation for reconciliation.";
    },
  },
  {
    templateId: "action.pii.v1",
    templateVersion: "1",
    category: "pii-handling-warning",
    render: (ctx) => {
      if (!ctx.includesPiiHandling) return null;
      return "This workflow displays or transmits personal data. Follow the organisation's data-handling policy, and confirm that any sample data used while following this guide is synthetic.";
    },
  },
  {
    templateId: "action.third-party.v1",
    templateVersion: "1",
    category: "third-party-integration",
    render: (ctx) => {
      if (!ctx.includesThirdPartyIntegration) return null;
      return "This workflow relies on a third-party service. The third party's own terms and privacy policy apply to data the workflow sends to it, and the third party's interface may change without notice.";
    },
  },
  {
    templateId: "action.beta.v1",
    templateVersion: "1",
    category: "beta-feature",
    render: (ctx) => {
      if (!ctx.includesBetaFeature) return null;
      return "This workflow documents a beta feature. Beta features may change or be withdrawn without notice, and their behaviour is not covered by a service-level agreement.";
    },
  },
]);

/* -------------------------------------------------------------------------- */
/* Category selection                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Determine the categories a profile and a workflow require. The result is a
 * set ordered by insertion, matching the phase's audit expectations: an
 * operator reading a report can see which categories the workflow triggered.
 *
 * The function is exported so the pipeline can log the category set without
 * building the disclaimers.
 */
export function requiredCategories(input: BuildDisclaimersInput): readonly DisclaimerCategory[] {
  const out: DisclaimerCategory[] = [];
  const add = (c: DisclaimerCategory): void => {
    if (!out.includes(c)) out.push(c);
  };

  // Always required.
  add("general-informational");
  add("ai-generated");

  const industry = normaliseIndustryKeys(input.industry);
  const isHealth = industry.some((k) =>
    ["health", "medical", "clinic", "pharma", "care"].some((h) => k.includes(h)),
  );
  const isLegal = industry.some((k) => ["legal", "law"].some((h) => k.includes(h)));
  const isFinance = industry.some((k) =>
    ["financ", "bank", "insurance", "fintech"].some((h) => k.includes(h)),
  );
  const isSecurity = industry.some((k) =>
    ["security", "infosec", "cyber"].some((h) => k.includes(h)),
  );

  if (isHealth) add("professional-advice-medical");
  if (isHealth || isFinance || isLegal) add("regulated-product");
  if (isHealth) add("regulated-product-health");
  if (isFinance) add("regulated-product-financial");
  if (isLegal) add("professional-advice-legal");
  if (isFinance) add("professional-advice-financial");
  if (isSecurity) add("professional-advice-security");

  // Audience: an expert administrator receives the security primer only when
  // the workflow itself is security-relevant; a novice end-user receives a
  // mild caution on every destructive workflow.
  if (input.audience.seniority === "expert" && isSecurity) {
    add("professional-advice-security");
  }

  // Action-triggered.
  if (input.includesDestructiveAction === true) add("destructive-action-warning");
  if (input.includesFinancialAction === true) {
    add("financial-action-warning");
    if (!isFinance) add("professional-advice-financial");
  }
  if (input.includesPiiHandling === true) {
    add("pii-handling-warning");
    add("data-handling");
  }
  if (input.includesThirdPartyIntegration === true) add("third-party-integration");
  if (input.includesBetaFeature === true) add("beta-feature");
  if (input.assertsCertification === true) add("compliance-not-certification");

  return out;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildDisclaimers(input: BuildDisclaimersInput): Disclaimers {
  if (input === null || typeof input !== "object") {
    throw new DisclaimersError("buildDisclaimers requires an input object.", "invalid-input");
  }
  if (input.audience === null || typeof input.audience !== "object") {
    throw new DisclaimersError("`audience` is required.", "invalid-input");
  }
  if (input.industry === null || typeof input.industry !== "object") {
    throw new DisclaimersError("`industry` is required.", "invalid-input");
  }
  if (
    typeof input.placement !== "string" ||
    !(DISCLAIMER_PLACEMENTS as readonly string[]).includes(input.placement)
  ) {
    throw new DisclaimersError(
      `\`placement\` must be one of ${DISCLAIMER_PLACEMENTS.join(", ")}.`,
      "invalid-input",
    );
  }

  const notes: DisclaimersNote[] = [];

  const ctx: DisclaimerContext = {
    publisherLegalName: readNonEmptyString(input.publisherLegalName),
    supportContact: readNonEmptyString(input.supportContact),
    jurisdiction: readNonEmptyString(input.jurisdiction),
    aiGenerated: input.aiGenerated !== false,
    includesDestructiveAction: input.includesDestructiveAction === true,
    includesFinancialAction: input.includesFinancialAction === true,
    includesPiiHandling: input.includesPiiHandling === true,
    includesThirdPartyIntegration: input.includesThirdPartyIntegration === true,
    includesBetaFeature: input.includesBetaFeature === true,
    assertsCertification: input.assertsCertification === true,
    placement: input.placement,
  };

  if (ctx.publisherLegalName === null) {
    notes.push({
      kind: "no-publisher-legal-name",
      detail:
        "No publisher legal name was supplied; the no-warranty disclaimer renders with a generic publisher reference.",
    });
  }
  if (ctx.supportContact === null && ctx.includesPiiHandling) {
    notes.push({
      kind: "no-support-contact",
      detail:
        "No support contact was supplied; the data-handling disclaimer omits the contact sentence.",
    });
  }
  if (ctx.jurisdiction === null && input.audience.seniority !== "expert") {
    notes.push({
      kind: "no-jurisdiction",
      detail: "No jurisdiction was supplied; jurisdiction-specific warnings are omitted.",
    });
  }
  if (ctx.placement === "social-post-omitted") {
    notes.push({
      kind: "placement-social-omitted",
      detail:
        "The social-post placement cannot carry a disclaimer within its character budget. Only the ai-generated category is embedded at the source.",
    });
  }
  if (ctx.assertsCertification) {
    notes.push({
      kind: "certification-assertion-flagged",
      detail:
        "The guide asserts a compliance framework. The compliance-not-certification disclaimer was added; the fact-check layer must still verify the assertion.",
    });
  }
  if (ctx.includesFinancialAction) {
    notes.push({
      kind: "financial-action-flagged",
      detail: "The guide includes a financial action; the financial-action warning was added.",
    });
  }
  if (ctx.includesDestructiveAction) {
    notes.push({
      kind: "destructive-action-flagged",
      detail: "The guide includes a destructive action; the destructive-action warning was added.",
    });
  }
  if (ctx.includesPiiHandling) {
    notes.push({
      kind: "pii-handling-flagged",
      detail: "The guide handles personal data; the PII-handling warning was added.",
    });
  }
  if (ctx.includesThirdPartyIntegration) {
    notes.push({
      kind: "third-party-integration-flagged",
      detail: "The guide calls a third-party integration; its disclaimer was added.",
    });
  }
  if (ctx.includesBetaFeature) {
    notes.push({
      kind: "beta-feature-flagged",
      detail: "The guide documents a beta feature; its disclaimer was added.",
    });
  }

  const wanted = requiredCategories(input);

  // Social post: only the AI-generated disclosure survives. The rest is
  // recorded as skipped, not silently dropped.
  if (ctx.placement === "social-post-omitted") {
    const rendered: Disclaimer[] = [];
    for (const entry of DEFAULT_CATALOGUE) {
      if (entry.category !== "ai-generated") continue;
      if (!wanted.includes(entry.category)) continue;
      const text = entry.render(ctx);
      if (text === null || text.trim().length === 0) continue;
      rendered.push({
        templateId: entry.templateId,
        templateVersion: entry.templateVersion,
        category: entry.category,
        placement: ctx.placement,
        text: text.trim(),
      });
    }
    const skipped = wanted
      .filter((c) => c !== "ai-generated")
      .map((c) => ({
        category: c,
        reason: "Social-post placement cannot carry this disclaimer within its character budget.",
      }));
    return {
      version: "disclaimers/1",
      disclaimers: rendered,
      skipped,
      notes,
      summary: {
        total: rendered.length,
        skipped: skipped.length,
        categories: rendered.map((d) => d.category),
      },
      generatedAt: new Date().toISOString(),
      aiGenerated: true,
    };
  }

  // Compute the effective wanted set, honouring `supersedes`.
  const effective = new Set<DisclaimerCategory>(wanted);
  for (const entry of DEFAULT_CATALOGUE) {
    if (!wanted.includes(entry.category)) continue;
    if (entry.supersedes === undefined) continue;
    for (const sup of entry.supersedes) effective.delete(sup);
  }

  const rendered: Disclaimer[] = [];
  const skipped: { category: DisclaimerCategory; reason: string }[] = [];

  for (const entry of DEFAULT_CATALOGUE) {
    if (!effective.has(entry.category)) continue;
    const text = entry.render(ctx);
    if (text === null || text.trim().length === 0) {
      skipped.push({
        category: entry.category,
        reason:
          entry.category === "data-handling" && ctx.supportContact === null
            ? "The template needs a support contact that the deployment has not supplied."
            : `Template "${entry.templateId}" could not be rendered with the supplied context.`,
      });
      continue;
    }
    rendered.push({
      templateId: entry.templateId,
      templateVersion: entry.templateVersion,
      category: entry.category,
      placement: ctx.placement,
      text: text.trim(),
    });
  }

  // Detect catalogued categories that the required set names but no template
  // provides. Recorded so a missing template is not silent.
  const provided = new Set(DEFAULT_CATALOGUE.map((e) => e.category));
  for (const c of wanted) {
    if (!provided.has(c)) {
      notes.push({
        kind: "category-unmatched",
        detail: `Category "${c}" was requested by the profile but has no template in the catalogue.`,
      });
    }
  }

  return {
    version: "disclaimers/1",
    disclaimers: rendered,
    skipped,
    notes,
    summary: {
      total: rendered.length,
      skipped: skipped.length,
      categories: rendered.map((d) => d.category),
    },
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the block as an HTML fragment. Emits a `<section>` with one `<p>`
 * per disclaimer, each carrying a `data-disclaimer-category` attribute so the
 * styling layer (callouts module) can style it consistently.
 */
export function renderDisclaimersHtml(disclaimers: Disclaimers): string {
  if (disclaimers === null || typeof disclaimers !== "object" || disclaimers.version !== "disclaimers/1") {
    throw new DisclaimersError(
      'renderDisclaimersHtml requires a Disclaimers object (version "disclaimers/1").',
      "invalid-input",
    );
  }
  if (disclaimers.disclaimers.length === 0) return "";
  const lines: string[] = [];
  lines.push(`<section class="zipy-disclaimers" data-count="${disclaimers.disclaimers.length}">`);
  for (const d of disclaimers.disclaimers) {
    lines.push(
      `  <p class="zipy-disclaimer" data-disclaimer-category="${escapeHtmlAttr(d.category)}" data-disclaimer-template="${escapeHtmlAttr(d.templateId)}">${escapeHtmlText(d.text)}</p>`,
    );
  }
  lines.push("</section>");
  return lines.join("\n");
}

/**
 * Render the block as a Markdown section. Headings are only emitted when the
 * placement is a footer or article footer; inline placement renders a single
 * blockquote per disclaimer so it reads as an aside in an export.
 */
export function renderDisclaimersMarkdown(disclaimers: Disclaimers): string {
  if (disclaimers === null || typeof disclaimers !== "object" || disclaimers.version !== "disclaimers/1") {
    throw new DisclaimersError(
      'renderDisclaimersMarkdown requires a Disclaimers object (version "disclaimers/1").',
      "invalid-input",
    );
  }
  if (disclaimers.disclaimers.length === 0) return "";
  const lines: string[] = [];
  const isFooter = disclaimers.disclaimers.some(
    (d) => d.placement === "guide-footer" || d.placement === "article-footer" || d.placement === "email-footer",
  );
  if (isFooter) {
    lines.push("## Disclaimers");
    lines.push("");
  }
  for (const d of disclaimers.disclaimers) {
    lines.push(`> ${d.text}`);
    lines.push("");
  }
  // Remove trailing blank line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * The LLM-visible directive block. Append to the writer's system prompt when
 * a guide will carry disclaimers. The writer must not attempt to write the
 * disclaimer itself — that is what the catalogue renders — but must avoid
 * contradicting it.
 */
export function buildDisclaimerDirectives(input: {
  readonly audience: AudienceProfile;
  readonly industry: IndustryProfile;
  readonly placement: DisclaimerPlacement;
}): string {
  const lines: string[] = [];
  lines.push(
    "The guide will carry disclaimers rendered from a template catalogue. Do not write the disclaimer text yourself.",
  );
  lines.push(
    "- Do not assert a professional conclusion (medical, legal, financial, security). Describe the workflow; let the disclaimers layer handle implications.",
  );
  lines.push(
    "- Do not claim the guide is compliant with a framework (HIPAA, PCI-DSS, SOC 2, GDPR, ISO 27001, FDA-approved).",
  );
  lines.push(
    "- Do not promise an outcome (a curing effect, a guaranteed return, a security guarantee).",
  );
  if (input.audience.seniority === "novice") {
    lines.push(
      "- A novice reader may act without context. Add a short reminder to confirm the operation before it cannot be undone, rather than assuming the reader will check.",
    );
  }
  const keys = normaliseIndustryKeys(input.industry);
  if (keys.some((k) => ["health", "medical", "clinic", "pharma", "care"].some((h) => k.includes(h)))) {
    lines.push(
      "- This guide may be read in a clinical context. Never describe a workflow outcome as a clinical effect.",
    );
  }
  if (keys.some((k) => ["financ", "bank", "insurance", "fintech"].some((h) => k.includes(h)))) {
    lines.push(
      "- This guide may be read in a financial context. Never describe a workflow outcome as a financial guarantee.",
    );
  }
  if (input.placement === "social-post-omitted") {
    lines.push(
      "- The summary will be published on a social platform that cannot carry the full disclaimer set. Do not make a claim in the summary that the guide's disclaimers contradict.",
    );
  }
  return lines.join("\n");
}

export function rehydrateDisclaimers(value: unknown): Disclaimers {
  if (value === null || typeof value !== "object") {
    throw new DisclaimersError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "disclaimers/1") {
    throw new DisclaimersError(
      `Rehydrate failed: expected version "disclaimers/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  return {
    version: "disclaimers/1",
    disclaimers: readDisclaimers(r["disclaimers"]),
    skipped: readSkipped(r["skipped"]),
    notes: readNotes(r["notes"]),
    summary: readSummary(r["summary"]),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/**
 * Validate that every disclaimer in the block points at a catalogue entry
 * whose `templateVersion` matches what the entry declares today. Returns a
 * list of drift records so the export layer can flag a guide whose
 * disclaimers were rendered against an out-of-date template. The function is
 * exported so a build-time check can iterate the catalogue.
 */
export function checkCatalogueDrift(
  disclaimers: Disclaimers,
  catalogue: readonly DisclaimerCatalogueEntry[] = DEFAULT_CATALOGUE,
): readonly { readonly templateId: string; readonly rendered: string; readonly current: string }[] {
  const current = new Map(catalogue.map((e) => [e.templateId, e.templateVersion]));
  const out: { templateId: string; rendered: string; current: string }[] = [];
  for (const d of disclaimers.disclaimers) {
    const cur = current.get(d.templateId);
    if (cur === undefined) continue;
    if (cur !== d.templateVersion) {
      out.push({ templateId: d.templateId, rendered: d.templateVersion, current: cur });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function readNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function normaliseIndustryKeys(industry: IndustryProfile): readonly string[] {
  const keys: string[] = [];
  const pushIfString = (v: unknown): void => {
    if (typeof v === "string" && v.trim().length > 0) keys.push(v.trim().toLowerCase());
  };
  // The IndustryProfile shape is owned by the personalization phase; read a
  // broad set of likely fields without inventing a contract.
  const obj = industry as unknown as Record<string, unknown>;
  pushIfString(obj["id"]);
  pushIfString(obj["name"]);
  pushIfString(obj["label"]);
  pushIfString(obj["industry"]);
  if (Array.isArray(obj["tags"])) {
    for (const t of obj["tags"]) pushIfString(t);
  }
  return keys;
}

function readDisclaimerCategory(v: unknown): DisclaimerCategory {
  return typeof v === "string" && (DISCLAIMER_CATEGORIES as readonly string[]).includes(v)
    ? (v as DisclaimerCategory)
    : "general-informational";
}

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readDisclaimers(v: unknown): readonly Disclaimer[] {
  if (!Array.isArray(v)) return [];
  const out: Disclaimer[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const placementRaw = o["placement"];
    const placement: DisclaimerPlacement =
      typeof placementRaw === "string" && (DISCLAIMER_PLACEMENTS as readonly string[]).includes(placementRaw)
        ? (placementRaw as DisclaimerPlacement)
        : "guide-footer";
    out.push({
      templateId: typeof o["templateId"] === "string" ? o["templateId"] : "",
      templateVersion: typeof o["templateVersion"] === "string" ? o["templateVersion"] : "",
      category: readDisclaimerCategory(o["category"]),
      placement,
      text: typeof o["text"] === "string" ? o["text"] : "",
    });
  }
  return out;
}

function readSkipped(v: unknown): readonly { category: DisclaimerCategory; reason: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { category: DisclaimerCategory; reason: string }[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    out.push({
      category: readDisclaimerCategory(o["category"]),
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
    });
  }
  return out;
}

function readNotes(v: unknown): readonly DisclaimersNote[] {
  if (!Array.isArray(v)) return [];
  const out: DisclaimersNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "no-publisher-legal-name" &&
      kind !== "no-support-contact" &&
      kind !== "no-jurisdiction" &&
      kind !== "placement-social-omitted" &&
      kind !== "certification-assertion-flagged" &&
      kind !== "financial-action-flagged" &&
      kind !== "destructive-action-flagged" &&
      kind !== "pii-handling-flagged" &&
      kind !== "third-party-integration-flagged" &&
      kind !== "beta-feature-flagged" &&
      kind !== "category-unmatched"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

function readSummary(v: unknown): Disclaimers["summary"] {
  const fallback: Disclaimers["summary"] = {
    total: 0,
    skipped: 0,
    categories: [],
  };
  if (v === null || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  const cats: DisclaimerCategory[] = [];
  if (Array.isArray(o["categories"])) {
    for (const c of o["categories"]) cats.push(readDisclaimerCategory(c));
  }
  const total = typeof o["total"] === "number" && Number.isFinite(o["total"]) ? Math.max(0, Math.floor(o["total"])) : 0;
  const skipped =
    typeof o["skipped"] === "number" && Number.isFinite(o["skipped"]) ? Math.max(0, Math.floor(o["skipped"])) : 0;
  return { total, skipped, categories: cats };
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  DEFAULT_CATALOGUE,
  requiredCategories,
  normaliseIndustryKeys,
  readNonEmptyString,
  readDisclaimerCategory,
  readDisclaimers,
  readSkipped,
  readNotes,
  readSummary,
  escapeHtmlText,
  escapeHtmlAttr,
});
