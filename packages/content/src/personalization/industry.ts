/**
 * Zipy AI — personalization: industry adaptation (content-generation, personalization batch 0).
 *
 * A workspace selects one industry per guide (or "generic" for a
 * cross-industry guide). The industry shapes two things and only two things:
 *
 *   1. **Examples and terminology** — the LLM is told which analogy source
 *      to draw from. A healthcare guide describes "the patient record"; a
 *      finance guide describes "the ledger entry". The industry does not
 *      authorise the model to invent domain facts.
 *   2. **Compliance advisories** — a short, human-readable list of the
 *      disclaimer categories that belong on a guide of this industry
 *      (e.g. HIPAA for healthcare, PCI for finance). The safety layer
 *      generates the disclaimer *text*; this module only names the
 *      categories, so the two layers stay separable.
 *
 * The industry profile is a *description of the target reader's world*. It
 * does not rewrite identifiers or anonymise existing copy. Where a caller
 * supplies an override string (e.g. a preferred term for "customer" in this
 * workspace), that override wins over the industry default and the module
 * records the source (`"caller"` vs `"industry"`) so a reviewer can see
 * what came from where.
 *
 * Design rules honoured:
 *  - No invented facts. Example vocabulary is a starting point for the LLM
 *    to *use when the source material already mentions that concept*; the
 *    directive block explicitly says so.
 *  - Deterministic and pure: no I/O, no LLM call. The LLM path lives in the
 *    writer layers; this module produces the profile that feeds them.
 *  - The profile may be merged with a secondary industry so an agency
 *    serving fintech and healthcare can write one guide for both. Merging
 *    is by union of vocabularies and advisories; no industry silently
 *    overrides the other.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type IndustryErrorCode = "invalid-input" | "unknown-industry";

export class IndustryError extends Error {
  readonly code: IndustryErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: IndustryErrorCode,
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
 * The supported industries. `generic` is the default and produces no
 * industry-specific vocabulary or advisories; it is the right choice when
 * a guide is not targeted at a vertical.
 */
export const INDUSTRIES = [
  "generic",
  "healthcare",
  "finance",
  "legal",
  "education",
  "retail",
  "manufacturing",
  "technology",
  "government",
  "nonprofit",
] as const;
export type Industry = (typeof INDUSTRIES)[number];

/**
 * A caller-supplied substitution: "in this workspace, the interface calls
 * the primary entity 'Member' — use that instead of the industry default
 * 'Customer'". Substitution is applied verbatim; the composer never invents
 * a substitution an operator did not supply.
 */
export interface IndustryTermOverride {
  /** The industry-default spelling. Case-insensitive match on word boundaries. */
  readonly from: string;
  /** The caller's preferred spelling. Written verbatim. */
  readonly to: string;
  /** Optional note surfaced to the reviewer (e.g. "matches our UI copy"). */
  readonly rationale?: string | null;
}

export interface IndustryProfile {
  readonly industry: Industry;
  /** A short, reader-facing label used in directives and the editor UI. */
  readonly label: string;
  /**
   * Domain vocabulary: nouns the reader is expected to recognise. The LLM
   * directive instructs the model to *use these only when the sources
   * already contain the corresponding real concept*; the profile does not
   * authorise inventing a domain fact.
   */
  readonly vocabulary: readonly string[];
  /**
   * Analogy sources the LLM may draw from when it needs a comparison and
   * the sources support one. Kept short; a long list invites the model to
   * cram analogies into every sentence.
   */
  readonly analogySources: readonly string[];
  /**
   * Disclaimer categories that should be attached to a published guide of
   * this industry. These are *categories*, not text: the safety layer
   * produces the actual disclaimer prose.
   */
  readonly disclaimerCategories: readonly string[];
  /**
   * The caller's term overrides, in order. Applied after vocabulary. The
   * rest of the pipeline consumes these in `applyIndustryTerms`.
   */
  readonly termOverrides: readonly IndustryTermOverride[];
  /**
   * A soft note for the writer: register conventions the industry expects.
   * Short and imperative (e.g. "avoid predicting outcomes" for finance).
   */
  readonly registerNotes: readonly string[];
  /** Advisories supplied by the caller, appended verbatim. */
  readonly advisories: readonly string[];
  /** Secondary industry when this profile serves two verticals. */
  readonly secondaryIndustry: Industry | null;
  /** ISO timestamp of the profile build. */
  readonly generatedAt: string;
}

export interface BuildIndustryInput {
  readonly industry: Industry;
  /** Caller-supplied vocabulary additions. Merged with the industry baseline. */
  readonly vocabulary?: readonly string[];
  /** Caller-supplied analogy sources. Merged with the industry baseline. */
  readonly analogySources?: readonly string[];
  /** Caller-supplied disclaimer categories. Merged with the industry baseline. */
  readonly disclaimerCategories?: readonly string[];
  /** Caller-supplied term overrides. Applied in the order given. */
  readonly termOverrides?: readonly IndustryTermOverride[];
  /** Caller advisories. Merged, deduplicated, and appended to register notes. */
  readonly advisories?: readonly string[];
  /** Optional secondary industry for a two-vertical guide. */
  readonly secondaryIndustry?: Industry | null;
}

export interface IndustryApplication {
  readonly text: string;
  readonly applied: boolean;
  readonly changes: readonly IndustryTermChange[];
}

export interface IndustryTermChange {
  readonly kind: "term-override";
  readonly from: string;
  readonly to: string;
}

/* -------------------------------------------------------------------------- */
/* Industry baselines                                                          */
/* -------------------------------------------------------------------------- */

interface IndustryBaseline {
  readonly label: string;
  readonly vocabulary: readonly string[];
  readonly analogySources: readonly string[];
  readonly disclaimerCategories: readonly string[];
  readonly registerNotes: readonly string[];
}

const BASELINES: Readonly<Record<Industry, IndustryBaseline>> = Object.freeze({
  generic: {
    label: "General business",
    vocabulary: [],
    analogySources: [],
    disclaimerCategories: [],
    registerNotes: [],
  },
  healthcare: {
    label: "Healthcare",
    vocabulary: [
      "patient",
      "clinician",
      "encounter",
      "chart",
      "consent",
      "order",
      "referral",
    ],
    analogySources: [
      "a clinic's front desk workflow",
      "a nurse preparing a chart before a consultation",
    ],
    disclaimerCategories: ["hipaa", "medical-advice"],
    registerNotes: [
      "Do not offer medical advice; describe the software workflow only.",
      "Do not characterise patient data as anonymous or synthetic when it may not be.",
    ],
  },
  finance: {
    label: "Financial services",
    vocabulary: [
      "account",
      "ledger",
      "transaction",
      "reconciliation",
      "statement",
      "wire",
      "approval threshold",
    ],
    analogySources: [
      "a month-end close",
      "a dual-control payment approval",
    ],
    disclaimerCategories: ["financial-advice", "pci"],
    registerNotes: [
      "Do not predict financial outcomes or describe a workflow as ensuring compliance with a specific regulation.",
      "Do not describe a value as final until the source material says it is posted.",
    ],
  },
  legal: {
    label: "Legal",
    vocabulary: [
      "matter",
      "docket",
      "privilege",
      "retention",
      "custodian",
      "discovery",
    ],
    analogySources: [
      "a paralegal filing a new matter",
      "a partner reviewing a document set before production",
    ],
    disclaimerCategories: ["legal-advice"],
    registerNotes: [
      "Do not offer legal advice; describe the software workflow only.",
      "Do not characterise a document as privileged; that is a legal determination.",
    ],
  },
  education: {
    label: "Education",
    vocabulary: [
      "student",
      "course",
      "roster",
      "enrolment",
      "gradebook",
      "assignment",
    ],
    analogySources: [
      "a teacher preparing a course roster",
      "an office administrator enrolling a student",
    ],
    disclaimerCategories: ["ferpa", "minors-data"],
    registerNotes: [
      "Do not include personal details of any individual student.",
      "Use role-neutral pronouns when referring to students.",
    ],
  },
  retail: {
    label: "Retail and e-commerce",
    vocabulary: [
      "order",
      "customer",
      "fulfilment",
      "SKU",
      "inventory",
      "storefront",
    ],
    analogySources: [
      "a fulfilment queue at a distribution centre",
      "a store manager reconciling the day's takings",
    ],
    disclaimerCategories: ["pci"],
    registerNotes: [
      "Do not display real card numbers, addresses or customer names; call out that the workflow masks them.",
    ],
  },
  manufacturing: {
    label: "Manufacturing",
    vocabulary: [
      "work order",
      "bill of materials",
      "lot",
      "line",
      "shift",
      "inspection",
    ],
    analogySources: [
      "a line supervisor releasing a work order",
      "an inspector recording a quality result",
    ],
    disclaimerCategories: ["safety"],
    registerNotes: [
      "Where a source names a safety procedure, say so; do not invent one.",
      "Do not reference specific hardware, tools or materials unless the sources do.",
    ],
  },
  technology: {
    label: "Technology",
    vocabulary: [
      "tenant",
      "workspace",
      "environment",
      "deployment",
      "incident",
      "runbook",
    ],
    analogySources: [
      "a release train moving through environments",
      "an on-call engineer following a runbook",
    ],
    disclaimerCategories: [],
    registerNotes: [
      "Prefer concrete nouns from the sources over generic ones ('the service', not 'the platform').",
    ],
  },
  government: {
    label: "Government and public sector",
    vocabulary: [
      "case file",
      "citizen",
      "agency",
      "clearance",
      "register",
      "statutory deadline",
    ],
    analogySources: [
      "a caseworker opening a new case file",
      "a supervisor reviewing a backlog",
    ],
    disclaimerCategories: ["foia", "records-retention"],
    registerNotes: [
      "Do not use marketing language.",
      "Where a source names a statute or regulation by number, reproduce the number exactly.",
    ],
  },
  nonprofit: {
    label: "Nonprofit",
    vocabulary: [
      "donor",
      "grant",
      "programme",
      "beneficiary",
      "appeal",
      "volunteer",
    ],
    analogySources: [
      "a fundraising coordinator preparing a mailing",
      "a programme manager logging a grant report",
    ],
    disclaimerCategories: [],
    registerNotes: [
      "Avoid causal claims about outcomes; describe the software workflow only.",
    ],
  },
});

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildIndustry(input: BuildIndustryInput): IndustryProfile {
  if (input === null || typeof input !== "object") {
    throw new IndustryError("buildIndustry requires an input object.", "invalid-input");
  }
  if (!isIndustry(input.industry)) {
    throw new IndustryError(
      `Unknown industry "${String(input.industry)}". Expected one of: ${INDUSTRIES.join(", ")}.`,
      "unknown-industry",
      { industry: input.industry },
    );
  }
  if (
    input.secondaryIndustry !== undefined &&
    input.secondaryIndustry !== null &&
    !isIndustry(input.secondaryIndustry)
  ) {
    throw new IndustryError(
      `Unknown secondary industry "${String(input.secondaryIndustry)}".`,
      "unknown-industry",
      { industry: input.secondaryIndustry },
    );
  }

  const primary = BASELINES[input.industry];
  const secondary =
    input.secondaryIndustry !== undefined && input.secondaryIndustry !== null
      ? BASELINES[input.secondaryIndustry]
      : null;

  const label =
    secondary !== null && input.secondaryIndustry !== input.industry
      ? `${primary.label} and ${secondary.label}`
      : primary.label;

  return {
    industry: input.industry,
    label,
    vocabulary: mergeUnique(
      primary.vocabulary,
      secondary?.vocabulary ?? [],
      input.vocabulary ?? [],
    ),
    analogySources: mergeUnique(
      primary.analogySources,
      secondary?.analogySources ?? [],
      input.analogySources ?? [],
    ),
    disclaimerCategories: mergeUnique(
      primary.disclaimerCategories,
      secondary?.disclaimerCategories ?? [],
      input.disclaimerCategories ?? [],
    ),
    termOverrides: normaliseOverrides(input.termOverrides ?? []),
    registerNotes: mergeUnique(
      primary.registerNotes,
      secondary?.registerNotes ?? [],
      input.advisories ?? [],
    ),
    advisories: pruneStrings(input.advisories ?? []),
    secondaryIndustry: input.secondaryIndustry ?? null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Deterministic term substitution. Applies the profile's overrides in
 * order, whole-word only, case-insensitively, and never inside backticks,
 * double-quoted strings or URLs. Never touches a sentence's subject, verb
 * or object beyond the substituted noun's surface form.
 */
export function applyIndustryTerms(
  text: string,
  profile: IndustryProfile,
): IndustryApplication {
  if (typeof text !== "string") {
    throw new IndustryError("applyIndustryTerms requires a string.", "invalid-input");
  }
  if (text.length === 0 || profile.termOverrides.length === 0) {
    return { text, applied: false, changes: [] };
  }

  const segments: string[] = [];
  const protect = (match: string): string => {
    const idx = segments.length;
    segments.push(match);
    return `\u0001I${idx}I\u0001`;
  };
  let working = text
    .replace(/`[^`]*`/g, protect)
    .replace(/"[^"]*"/g, protect)
    .replace(/https?:\/\/[^\s)]+/g, protect);

  const changes: IndustryTermChange[] = [];
  for (const override of profile.termOverrides) {
    if (override.from.length === 0) continue;
    const escaped = escapeRegExp(override.from);
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escaped}(?![\\p{L}\\p{N}-])`, "giu");
    working = working.replace(re, (match) => {
      const replacement = matchCase(match, override.to);
      if (replacement === match) return match;
      changes.push({ kind: "term-override", from: match, to: replacement });
      return replacement;
    });
  }

  // Restore any protected segments.
  let restored = working;
  let last: string;
  do {
    last = restored;
    restored = restored.replace(
      /\u0001I(\d+)I\u0001/g,
      (_m, idx: string) => segments[Number(idx)] ?? "",
    );
  } while (restored !== last);

  return { text: restored, applied: changes.length > 0, changes };
}

/**
 * Apply the industry's term overrides across a structured draft, walking
 * only the recognised prose keys. Other fields are preserved verbatim.
 */
export function applyIndustryTermsDeep<T>(value: T, profile: IndustryProfile): T {
  return walkAndRewrite(value, profile, 0) as T;
}

/**
 * Build the LLM-visible directive block. Short and imperative; includes the
 * vocabulary list, the analogy list, the disclaimers that must be named,
 * and any register notes. Explicitly forbids inventing facts about the
 * vertical.
 */
export function buildIndustryDirectives(profile: IndustryProfile): string {
  const lines: string[] = [];
  const pair =
    profile.secondaryIndustry !== null
      ? ` The guide serves both ${BASELINES[profile.industry].label} and ${BASELINES[profile.secondaryIndustry].label} readers.`
      : "";
  lines.push(`Industry context: ${profile.label}.${pair}`);

  if (profile.vocabulary.length > 0) {
    lines.push(
      `- The reader recognises this vocabulary: ${profile.vocabulary.join(", ")}. Use these terms only when the sources already contain the corresponding real concept; do not introduce a term the sources do not mention.`,
    );
  } else {
    lines.push(
      "- Use plain business vocabulary drawn from the sources; do not introduce vertical-specific terms.",
    );
  }

  if (profile.analogySources.length > 0) {
    lines.push(
      `- For comparisons, prefer images drawn from: ${profile.analogySources.join("; ")}. Use at most one comparison per section.`,
    );
  }

  if (profile.disclaimerCategories.length > 0) {
    lines.push(
      `- This guide requires these disclaimer categories: ${profile.disclaimerCategories.join(", ")}. The safety layer produces the disclaimer text; do not write your own.`,
    );
  }

  lines.push(
    "- Do not state a fact about the reader's organisation, their data, their regulations or their downstream process unless the sources state it.",
  );

  for (const note of profile.registerNotes) lines.push(`- ${note}`);
  for (const note of profile.advisories) lines.push(`- ${note}`);

  if (profile.termOverrides.length > 0) {
    lines.push("- Workspace terminology overrides apply:");
    for (const o of profile.termOverrides) {
      lines.push(`    "${o.from}" → "${o.to}"`);
    }
  }

  return lines.join("\n");
}

/**
 * Merge two industry profiles. Intended for the case where a workspace has
 * a primary industry and one of its divisions operates in a second. Both
 * vocabularies are kept; the second profile's overrides take precedence for
 * the same `from` spelling; advisories are unioned.
 */
export function mergeIndustries(
  base: IndustryProfile,
  overlay: IndustryProfile,
): IndustryProfile {
  const overrides = new Map<string, IndustryTermOverride>();
  for (const o of base.termOverrides) overrides.set(o.from.toLowerCase(), o);
  for (const o of overlay.termOverrides) overrides.set(o.from.toLowerCase(), o);

  return {
    industry: base.industry,
    label:
      base.industry === overlay.industry
        ? base.label
        : `${base.label} and ${overlay.label}`,
    vocabulary: mergeUnique(base.vocabulary, overlay.vocabulary),
    analogySources: mergeUnique(base.analogySources, overlay.analogySources),
    disclaimerCategories: mergeUnique(
      base.disclaimerCategories,
      overlay.disclaimerCategories,
    ),
    termOverrides: [...overrides.values()],
    registerNotes: mergeUnique(base.registerNotes, overlay.registerNotes),
    advisories: mergeUnique(base.advisories, overlay.advisories),
    secondaryIndustry: overlay.industry === base.industry ? base.secondaryIndustry : overlay.industry,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Rehydrate an `IndustryProfile`. Unknown industry names are rejected so a
 * caller gets a clear error instead of a silently-generic profile.
 */
export function rehydrateIndustry(value: unknown): IndustryProfile {
  if (value === null || typeof value !== "object") {
    throw new IndustryError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const rawIndustry = r["industry"];
  if (!isIndustry(rawIndustry)) {
    throw new IndustryError(
      `Rehydrate failed: unknown industry "${String(rawIndustry)}".`,
      "unknown-industry",
    );
  }
  const baseline = BASELINES[rawIndustry];
  const secondaryRaw = r["secondaryIndustry"];
  const secondaryIndustry: Industry | null =
    secondaryRaw === undefined || secondaryRaw === null
      ? null
      : isIndustry(secondaryRaw)
        ? secondaryRaw
        : null;

  const overridesRaw = Array.isArray(r["termOverrides"]) ? (r["termOverrides"] as unknown[]) : [];
  const overrides: IndustryTermOverride[] = [];
  for (const item of overridesRaw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const from = typeof o["from"] === "string" ? o["from"].trim() : "";
    const to = typeof o["to"] === "string" ? o["to"].trim() : "";
    if (from.length === 0 || to.length === 0) continue;
    overrides.push({
      from,
      to,
      rationale: typeof o["rationale"] === "string" ? o["rationale"] : null,
    });
  }

  return {
    industry: rawIndustry,
    label: typeof r["label"] === "string" && r["label"].trim().length > 0
      ? r["label"].trim()
      : baseline.label,
    vocabulary: stringArrayOr(r["vocabulary"], baseline.vocabulary),
    analogySources: stringArrayOr(r["analogySources"], baseline.analogySources),
    disclaimerCategories: stringArrayOr(r["disclaimerCategories"], baseline.disclaimerCategories),
    termOverrides: overrides,
    registerNotes: stringArrayOr(r["registerNotes"], baseline.registerNotes),
    advisories: stringArrayOr(r["advisories"], []),
    secondaryIndustry,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/** Type guard for the industry enumeration. */
export function isIndustry(v: unknown): v is Industry {
  return typeof v === "string" && (INDUSTRIES as readonly string[]).includes(v);
}

/** Read-only industry baseline lookup, for UI preview and setup helpers. */
export function getIndustryBaseline(industry: Industry): IndustryBaseline {
  if (!isIndustry(industry)) {
    throw new IndustryError(`Unknown industry "${String(industry)}".`, "unknown-industry");
  }
  return BASELINES[industry];
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

const PROSE_KEYS = new Set<string>([
  "title",
  "summary",
  "description",
  "instruction",
  "text",
  "sentence",
  "introduction",
  "question",
  "answer",
  "note",
  "body",
  "content",
]);

function walkAndRewrite(value: unknown, profile: IndustryProfile, depth: number): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    return applyIndustryTerms(value, profile).text;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => walkAndRewrite(v, profile, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = PROSE_KEYS.has(k) ? walkAndRewrite(v, profile, depth + 1) : v;
  }
  return out;
}

function normaliseOverrides(
  overrides: readonly IndustryTermOverride[],
): readonly IndustryTermOverride[] {
  const seen = new Map<string, IndustryTermOverride>();
  for (const raw of overrides) {
    if (raw === null || typeof raw !== "object") continue;
    const from = typeof raw.from === "string" ? raw.from.trim() : "";
    const to = typeof raw.to === "string" ? raw.to.trim() : "";
    if (from.length === 0 || to.length === 0) continue;
    const rationale =
      typeof raw.rationale === "string" && raw.rationale.trim().length > 0
        ? raw.rationale.trim()
        : null;
    seen.set(from.toLowerCase(), { from, to, rationale });
  }
  return [...seen.values()];
}

function mergeUnique(...lists: ReadonlyArray<readonly string[]>): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      const t = typeof item === "string" ? item.trim() : "";
      if (t.length === 0) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function pruneStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = typeof v === "string" ? v.trim() : "";
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function stringArrayOr(v: unknown, fallback: readonly string[]): readonly string[] {
  if (Array.isArray(v)) {
    return v.filter((s): s is string => typeof s === "string");
  }
  return fallback;
}

function matchCase(source: string, target: string): string {
  const first = source.charAt(0);
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return `${target.charAt(0).toUpperCase()}${target.slice(1)}`;
  }
  return target;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  BASELINES,
  PROSE_KEYS,
  normaliseOverrides,
  mergeUnique,
  pruneStrings,
  matchCase,
  walkAndRewrite,
});
