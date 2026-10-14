/**
 * Zipy AI — harmful, unsafe and policy-violating content detection
 * (SEO/quality/safety phase, batch 3).
 *
 * A reviewer-facing classifier. It inspects generated fragments — and,
 * optionally, user-supplied source text — and flags the ones that:
 *
 *   - incite violence, self-harm, or harm against a protected group;
 *   - provide operational instructions for wrongdoing (malware, weapons,
 *     drugs, fraud, credential theft) without a legitimate framing;
 *   - sexualise minors;
 *   - leak or solicit secrets/credentials in a tutorial where a real value
 *     belong instead;
 *   - contain targeted harassment or dehumanising language;
 *   - assert a professional conclusion (medical, legal, financial, security)
 *     that requires a licensed reviewer and that the sources do not support.
 *
 * This is a *decision-support* surface. It never blocks publication on its
 * own. It returns a `HarmfulContentReport` and a `ModerationQueueEntry` list
 * the review UI consumes. The final routing is performed by the moderation
 * queue module (`@zipy/safety/moderationQueue`), not here.
 *
 * Design rules honoured:
 *  - No model call. The classifier is a deterministic pattern + lexicon pass
 *    so it runs during generation without an additional latency budget and
 *    so its behaviour is reproducible. A VLM/LLM re-check can be layered on
 *    top by the orchestration phase; this module deliberately exposes the
 *    primitive rule results so the higher layer's prompts have something
 *    concrete to reason about.
 *  - No invented evidence. Each `HarmfulFinding` cites the exact matched span
 *    and offset so a reviewer can see the substring that triggered the flag.
 *    The classifier never paraphrases the fragment to justify a flag.
 *  - No silent drops. A flagged fragment that the reviewer must look at is
 *    always emitted; the report never suppresses a finding because the
 *    category is "low severity".
 *  - Severity is a three-level enum, not a numeric score, so the routing
 *    layer's thresholds cannot drift by silently tuning a weight.
 *  - Context is honoured. A legitimate security-tutorial phrase ("generate a
 *    strong random password") is not flagged when the surrounding text marks
 *    the fragment as instructional-for-authorised-administrators. The
 *    classifier exposes this as a per-fragment `context` field supplied by the
 *    caller; it does not infer intent on its own.
 *
 * The module exports:
 *   - `classifyHarmfulContent` — the primary entry point.
 *   - `classifyFragment` — classify a single fragment.
 *   - `buildHarmfulContentDirectives` — the LLM-visible block.
 *   - `rehydrateHarmfulContentReport` — typed load of a persisted payload.
 *   - `__internals` — pattern tables and helpers, exported for tests.
 */

import type { AudienceProfile } from "@zipy/content/personalization/audience";
import type { IndustryProfile } from "@zipy/content/personalization/industry";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type HarmfulContentErrorCode = "invalid-input" | "shape";

export class HarmfulContentError extends Error {
  readonly code: HarmfulContentErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: HarmfulContentErrorCode,
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
 * Category taxonomy. Deliberately coarse: a category names the harm; the
 * review UI groups by it. Finer subclassification (e.g. "fraud.wire-transfer"
 * vs "fraud.invoice") can be added later without changing the routing layer.
 */
export const HARMFUL_CATEGORIES = [
  "violence",
  "self-harm",
  "hate",
  "harassment",
  "sexual-minors",
  "malware",
  "weapons",
  "drugs",
  "fraud",
  "credential-theft",
  "secret-leak",
  "professional-advice-overreach",
  "regulated-product-claim",
] as const;
export type HarmfulCategory = (typeof HARMFUL_CATEGORIES)[number];

/**
 * Severity. `critical` is for categories (violence, self-harm, sexual-minors,
 * malware, weapons) where any occurrence should route to human moderation
 * regardless of context. `high` is for categories where a plausible-but-
 * illegitimate framing is present. `moderate` is for advisory overreach
 * (professional-advice-overreach, regulated-product-claim).
 */
export const HARMFUL_SEVERITIES = ["critical", "high", "moderate"] as const;
export type HarmfulSeverity = (typeof HARMFUL_SEVERITIES)[number];

/**
 * Per-fragment context supplied by the caller. This is the only signal the
 * classifier uses to widen the legitimate-instruction allowlist; it never
 * infers a context from the fragment itself.
 */
export const HARMFUL_CONTEXTS = [
  "general",
  "authorised-security-instruction",
  "clinical-guideline-reference",
  "legal-regulatory-reference",
  "internal-runbook-for-operators",
  "training-exercise",
] as const;
export type HarmfulContext = (typeof HARMFUL_CONTEXTS)[number];

export interface HarmfulFragment {
  /** Stable identifier, e.g. `step-3.description` or `title`. */
  readonly id: string;
  /** Human-visible location, e.g. "Step 3 — description". */
  readonly location: string;
  /** The fragment text. May be empty. */
  readonly text: string;
  /**
   * Context signalled by the caller. Defaults to `"general"`; the caller
   * sets one of the authorised values when a human has already confirmed the
   * fragment is legitimate instruction (e.g. a security onboarding runbook).
   */
  readonly context?: HarmfulContext;
  /** `source` marks text the platform did not write (e.g. an ingested PDF). */
  readonly origin?: "generated" | "source" | "unknown";
}

export interface HarmfulFinding {
  readonly fragmentId: string;
  readonly location: string;
  readonly category: HarmfulCategory;
  readonly severity: HarmfulSeverity;
  /** The exact substring that triggered the flag. Never paraphrased. */
  readonly matchedText: string;
  /** Character offsets of `matchedText` within the fragment, `[start, end)`. */
  readonly matchStart: number;
  readonly matchEnd: number;
  /** Human-readable reason the classifier surfaced the finding. */
  readonly reason: string;
  /**
   * True when the fragment supplied a context that legitimately narrows the
   * category (e.g. an authorised-security-instruction context reduces the
   * `credential-theft` category to `high` and turns off the `malware`
   * pattern when the pattern is the *detection* form). Callers see this so
   * the review UI can render the finding as "context-softened".
   */
  readonly contextSoftened: boolean;
}

export const HARMFUL_FRAGMENT_VERDICTS = [
  "clean",
  "flagged",
  "needs-context",
] as const;
export type HarmfulFragmentVerdict = (typeof HARMFUL_FRAGMENT_VERDICTS)[number];

export interface HarmfulFragmentResult {
  readonly fragmentId: string;
  readonly location: string;
  readonly verdict: HarmfulFragmentVerdict;
  readonly findings: readonly HarmfulFinding[];
  readonly highestSeverity: HarmfulSeverity | null;
  /** Human-readable summary for the review UI. */
  readonly summary: string;
}

export interface HarmfulContentNote {
  readonly kind:
    | "no-fragments"
    | "empty-fragment"
    | "source-origin"
    | "context-supplied"
    | "context-unknown"
    | "category-not-active-for-industry";
  readonly detail: string;
}

export interface HarmfulContentReport {
  readonly version: "harmful-content/1";
  readonly fragments: readonly HarmfulFragmentResult[];
  readonly notes: readonly HarmfulContentNote[];
  readonly summary: {
    readonly total: number;
    readonly clean: number;
    readonly flagged: number;
    readonly needsContext: number;
    readonly critical: number;
    readonly high: number;
    readonly moderate: number;
  };
  /**
   * True when at least one finding exists whose severity is `critical`,
   * independent of context. The routing layer uses this flag; the classifier
   * itself never makes the final blocking decision.
   */
  readonly requiresHumanReview: boolean;
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface ClassifyHarmfulContentInput {
  readonly fragments: readonly HarmfulFragment[];
  readonly audience: AudienceProfile;
  readonly industry: IndustryProfile;
  /**
   * Categories the operator has declared as not relevant to their deployment.
   * A category listed here is still detected (the finding is recorded), but
   * the per-fragment verdict is not upgraded to `flagged` on that category
   * alone. This is the audit-friendly way to scope the classifier: nothing is
   * silently turned off, the record simply says it was out of scope.
   */
  readonly suppressedCategories?: readonly HarmfulCategory[];
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

interface PatternRule {
  readonly category: HarmfulCategory;
  readonly severity: HarmfulSeverity;
  readonly regex: RegExp;
  readonly reason: string;
  /** Contexts that soften (or disable) this rule when supplied. */
  readonly softenedBy: readonly HarmfulContext[];
}

/**
 * The pattern table. Deliberately a small, reviewable list of high-signal
 * phrases. Broad general-purpose profanity is not in scope: the module is
 * concerned with harm categories the SaaS is legally and ethically bound to
 * route to review, not with tone policing.
 *
 * A rule's regex is applied with the `u` and `i` flags; matches are recorded
 * with their offsets. Rules do not overlap by construction (each new rule
 * targets a distinct phrase family) so the same span is not counted twice.
 */
export const HARMFUL_RULES: readonly PatternRule[] = Object.freeze([
  /* Violence / harm */
  {
    category: "violence",
    severity: "critical",
    regex: /\b(?:how to|instructions? (?:for|to))\s+(?:kill|murder|assassinate|poison|shoot|stab)\b/iu,
    reason: "Provides or solicits operational instructions for lethal violence.",
    softenedBy: [],
  },
  {
    category: "violence",
    severity: "critical",
    regex: /\b(?:build|make|assemble)\s+(?:a\s+)?(?:bomb|explosive|ied|pipe bomb)\b/iu,
    reason: "Provides instructions for constructing an explosive device.",
    softenedBy: [],
  },
  {
    category: "self-harm",
    severity: "critical",
    regex: /\b(?:how to|methods? (?:of|for))\s+(?:self[-\s]?harm|suicide|kill (?:your|my)self)\b/iu,
    reason: "Provides or solicits methods of self-harm.",
    softenedBy: [],
  },
  {
    category: "hate",
    severity: "critical",
    regex: /\b(?:exterminate|eliminate|eradicate)\s+(?:all\s+)?(?:jews|muslims|christians|blacks|whites|asians|hispanics|lgbtq?|gays?|trans(?:gender)? people)\b/iu,
    reason: "Calls for the elimination of a protected group.",
    softenedBy: [],
  },
  {
    category: "harassment",
    severity: "high",
    regex: /\b(?:dox|doxx|swat)\s+(?:this|the|him|her|them|that)\b/iu,
    reason: "Solicits targeted harassment (doxxing or swatting).",
    softenedBy: [],
  },
  {
    category: "sexual-minors",
    severity: "critical",
    regex: /\b(?:child|minor|underage|preteen|teen)\s+(?:porn|pornography|sexual|nude|nudes)\b/iu,
    reason: "Sexualises a minor.",
    softenedBy: [],
  },
  /* Malware / cyber */
  {
    category: "malware",
    severity: "critical",
    regex: /\b(?:write|create|build|develop)\s+(?:a\s+)?(?:ransomware|keylogger|rootkit|botnet|trojan|worm|virus)\b/iu,
    reason: "Solicits development of malware.",
    softenedBy: ["authorised-security-instruction"],
  },
  {
    category: "malware",
    severity: "high",
    regex: /\b(?:obfuscat(?:e|ed|ing)|evade|bypass)\s+(?:antivirus|edr|av|defender|endpoint)\b/iu,
    reason: "Describes bypassing defensive security controls.",
    softenedBy: ["authorised-security-instruction"],
  },
  /* Weapons */
  {
    category: "weapons",
    severity: "critical",
    regex: /\b(?:3d[-\s]?print|manufacture|mill|machine)\s+(?:a\s+)?(?:gun|firearm|silencer|suppressor|ghost gun)\b/iu,
    reason: "Solicits unlicensed firearm manufacturing.",
    softenedBy: [],
  },
  /* Drugs */
  {
    category: "drugs",
    severity: "critical",
    regex: /\b(?:synthesi[sz]e|manufacture|cook)\s+(?:meth|methamphetamine|fentanyl|heroin|cocaine|l[sd]d|mdma)\b/iu,
    reason: "Solicits illicit drug synthesis.",
    softenedBy: [],
  },
  /* Fraud */
  {
    category: "fraud",
    severity: "high",
    regex: /\b(?:phish|spoof|impersonate)\s+(?:a\s+)?(?:user|employee|customer|bank|vendor)\b/iu,
    reason: "Describes a fraudulent impersonation.",
    softenedBy: [],
  },
  {
    category: "fraud",
    severity: "high",
    regex: /\b(?:launder|money laundering|structur(?:e|ing) transactions? to avoid)\b/iu,
    reason: "Describes a money-laundering method.",
    softenedBy: ["legal-regulatory-reference"],
  },
  /* Credential theft / secrets */
  {
    category: "credential-theft",
    severity: "critical",
    regex: /\b(?:steal|crack|brute[-\s]?force|harvest)\s+(?:a\s+)?(?:password|credential|api key|private key|session token)\b/iu,
    reason: "Solicits credential theft.",
    softenedBy: ["authorised-security-instruction"],
  },
  {
    category: "secret-leak",
    severity: "high",
    regex: /\b(?:paste|share|post|email|send)\s+(?:your|the|their)\s+(?:api key|password|token|secret|private key|seed phrase)\b/iu,
    reason: "Suggests exfiltrating a live secret.",
    softenedBy: ["authorised-security-instruction", "internal-runbook-for-operators"],
  },
  {
    category: "secret-leak",
    severity: "high",
    regex: /\b(?:sk_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/u,
    reason: "The fragment contains a value shaped like a live credential.",
    softenedBy: [],
  },
  /* Professional advice overreach */
  {
    category: "professional-advice-overreach",
    severity: "moderate",
    regex: /\b(?:diagnos(?:e|is)|prescribe|dosage|treatment plan)\b/iu,
    reason: "Asserts a clinical conclusion without a named clinical source.",
    softenedBy: ["clinical-guideline-reference"],
  },
  {
    category: "professional-advice-overreach",
    severity: "moderate",
    regex: /\b(?:guaranteed|assured)\s+(?:return|profit|yield|tax (?:saving|benefit))\b/iu,
    reason: "Promises a financial outcome.",
    softenedBy: [],
  },
  {
    category: "professional-advice-overreach",
    severity: "moderate",
    regex: /\b(?:this|the) (?:solution|app|platform) is (?:hipaa|pci[-\s]?dss|soc[-\s]?2|gdpr|iso[-\s]?27001)[-\s]?compliant\b/iu,
    reason: "Asserts a compliance certification the guide cannot substantiate.",
    softenedBy: [],
  },
  /* Regulated product claims */
  {
    category: "regulated-product-claim",
    severity: "moderate",
    regex: /\b(?:fda[-\s]?approved|cures?|treats?|prevents?|heals?)\s+(?:cancer|diabetes|disease|infection|addiction)\b/iu,
    reason: "Makes a regulated health-claim.",
    softenedBy: [],
  },
  {
    category: "regulated-product-claim",
    severity: "moderate",
    regex: /\b(?:guaranteed income|risk[-\s]?free investment|can't lose|no[-\s]?risk return)\b/iu,
    reason: "Makes a regulated financial-claim.",
    softenedBy: [],
  },
]);

/**
 * Fragment shapes that are exempt from the professional-advice-overreach and
 * regulated-product-claim categories: a guide explicitly framed as a
 * disclaimer, a legal citation, or a definition is not itself advice.
 * Matched case-insensitively at the fragment level.
 */
const ADVISORY_EXEMPT_FRAGMENT_PATTERNS: readonly RegExp[] = Object.freeze([
  /^this is not (?:legal|medical|financial|security) advice\b/iu,
  /^the following is a definition\b/iu,
  /^for informational purposes only\b/iu,
  /^the (?:product|app|platform) (?:does not|doesn't) (?:claim|provide)\b/iu,
]);

/**
 * Industries whose disclaimers legitimately mention the categories above.
 * A finding whose category is in the industry's `disclaimerCategories` and
 * whose fragment is a disclaimer is kept as an audit record but downgraded.
 * (The industry adapter exposes `disclaimerCategories` as a string list — we
 *  treat matches loosely, by substring, to avoid inventing an enum contract.)
 */
const HEALTH_INDUSTRY_KEYS = ["health", "medical", "clinic", "pharma", "care"] as const;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function classifyHarmfulContent(
  input: ClassifyHarmfulContentInput,
): HarmfulContentReport {
  if (input === null || typeof input !== "object") {
    throw new HarmfulContentError(
      "classifyHarmfulContent requires an input object.",
      "invalid-input",
    );
  }
  if (!Array.isArray(input.fragments)) {
    throw new HarmfulContentError("`fragments` must be an array.", "invalid-input");
  }
  if (input.audience === null || typeof input.audience !== "object") {
    throw new HarmfulContentError("`audience` is required.", "invalid-input");
  }
  if (input.industry === null || typeof input.industry !== "object") {
    throw new HarmfulContentError("`industry` is required.", "invalid-input");
  }

  const suppressed = new Set<HarmfulCategory>(
    Array.isArray(input.suppressedCategories)
      ? input.suppressedCategories.filter((c): c is HarmfulCategory =>
          (HARMFUL_CATEGORIES as readonly string[]).includes(c),
        )
      : [],
  );

  const notes: HarmfulContentNote[] = [];
  if (input.fragments.length === 0) {
    notes.push({
      kind: "no-fragments",
      detail: "No fragments were supplied to classify.",
    });
  }

  const fragments: HarmfulFragmentResult[] = [];
  for (const raw of input.fragments) {
    if (raw === null || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id : "";
    const location = typeof raw.location === "string" ? raw.location : "";
    const text = typeof raw.text === "string" ? raw.text : "";
    const origin =
      raw.origin === "generated" || raw.origin === "source" ? raw.origin : "unknown";
    const context: HarmfulContext =
      typeof raw.context === "string" &&
      (HARMFUL_CONTEXTS as readonly string[]).includes(raw.context)
        ? (raw.context as HarmfulContext)
        : "general";
    if (typeof raw.context === "string" && context === "general" && raw.context !== "general") {
      notes.push({
        kind: "context-unknown",
        detail: `Fragment "${id}": supplied context "${raw.context}" is not a recognised context; treated as "general".`,
      });
    }
    if (context !== "general") {
      notes.push({
        kind: "context-supplied",
        detail: `Fragment "${id}" was classified with context "${context}".`,
      });
    }
    if (origin === "source") {
      notes.push({
        kind: "source-origin",
        detail: `Fragment "${id}" came from source material; findings are recorded as source-origin and routed to review rather than blocking.`,
      });
    }
    if (text.trim().length === 0) {
      notes.push({
        kind: "empty-fragment",
        detail: `Fragment "${id}" is empty.`,
      });
      fragments.push({
        fragmentId: id,
        location,
        verdict: "clean",
        findings: [],
        highestSeverity: null,
        summary: "The fragment is empty.",
      });
      continue;
    }

    const result = evaluateFragment({
      id,
      location,
      text,
      context,
      audience: input.audience,
      industry: input.industry,
      suppressed,
      notes,
    });
    fragments.push(result);
  }

  const summary = {
    total: fragments.length,
    clean: fragments.filter((f) => f.verdict === "clean").length,
    flagged: fragments.filter((f) => f.verdict === "flagged").length,
    needsContext: fragments.filter((f) => f.verdict === "needs-context").length,
    critical: fragments.filter((f) => f.highestSeverity === "critical").length,
    high: fragments.filter((f) => f.highestSeverity === "high").length,
    moderate: fragments.filter((f) => f.highestSeverity === "moderate").length,
  };

  const requiresHumanReview = fragments.some(
    (f) => f.highestSeverity === "critical" && f.findings.length > 0,
  );

  return {
    version: "harmful-content/1",
    fragments,
    notes,
    summary,
    requiresHumanReview,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Classify a single fragment. Thin wrapper used by the review UI's inline
 * classification, which does not need a full report.
 */
export function classifyFragment(
  fragment: HarmfulFragment,
  audience: AudienceProfile,
  industry: IndustryProfile,
  suppressedCategories: readonly HarmfulCategory[] = [],
): HarmfulFragmentResult {
  const report = classifyHarmfulContent({
    fragments: [fragment],
    audience,
    industry,
    suppressedCategories,
  });
  const first = report.fragments[0];
  if (first === undefined) {
    throw new HarmfulContentError(
      "Fragment did not produce a result.",
      "invalid-input",
      { fragmentId: fragment?.id },
    );
  }
  return first;
}

/**
 * The LLM-visible directive block. Append to the writer's system prompt when
 * the guide will run through the safety classifier. Short and imperative.
 */
export function buildHarmfulContentDirectives(input: {
  readonly audience: AudienceProfile;
  readonly industry: IndustryProfile;
}): string {
  const lines: string[] = [];
  lines.push(
    "A safety classifier will review every fragment you write. Keep the following in mind:",
  );
  lines.push(
    "- Stay within the workflow. Do not introduce instructions that are not part of the captured steps, and do not expand a step into a procedure the sources do not describe.",
  );
  lines.push(
    "- Do not describe how to defeat security controls, obtain credentials you were not issued, exfiltrate secrets, or perform a fraudulent action. A guide that legitimately discusses these topics frames them as a review or detection exercise, not as an instruction.",
  );
  lines.push(
    "- Never paste a real-looking API key, token, password or seed phrase into prose. Always write a placeholder such as `<YOUR_API_KEY>` and let the variables layer substitute sample data.",
  );
  lines.push(
    "- Do not claim that the product is compliant with a regulatory framework (HIPAA, PCI-DSS, SOC 2, GDPR, ISO 27001, FDA-approved, etc.) unless a source the guide was captured from explicitly states the certification.",
  );
  lines.push(
    "- Do not assert a clinical, legal, financial or security conclusion. Describe the workflow; let the disclaimers layer handle implications.",
  );
  if (input.audience.seniority === "novice") {
    lines.push(
      "- A novice reader may act on the guide without context. Prefer a step that hands off to an administrator over a step that tells the novice to perform an administrator action.",
    );
  }
  const industryKey = (input.industry.name ?? "").toLowerCase();
  if (HEALTH_INDUSTRY_KEYS.some((k) => industryKey.includes(k))) {
    lines.push(
      "- This guide may be read in a healthcare context. Do not describe clinical decisions as workflow outcomes.",
    );
  }
  return lines.join("\n");
}

export function rehydrateHarmfulContentReport(value: unknown): HarmfulContentReport {
  if (value === null || typeof value !== "object") {
    throw new HarmfulContentError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "harmful-content/1") {
    throw new HarmfulContentError(
      `Rehydrate failed: expected version "harmful-content/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  return {
    version: "harmful-content/1",
    fragments: readFragments(r["fragments"]),
    notes: readNotes(r["notes"]),
    summary: readSummary(r["summary"]),
    requiresHumanReview: r["requiresHumanReview"] === true,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface EvaluateInput {
  readonly id: string;
  readonly location: string;
  readonly text: string;
  readonly context: HarmfulContext;
  readonly audience: AudienceProfile;
  readonly industry: IndustryProfile;
  readonly suppressed: ReadonlySet<HarmfulCategory>;
  readonly notes: HarmfulContentNote[];
}

function evaluateFragment(input: EvaluateInput): HarmfulFragmentResult {
  const findings: HarmfulFinding[] = [];
  const isAdvisoryExempt = ADVISORY_EXEMPT_FRAGMENT_PATTERNS.some((re) => re.test(input.text));
  const industryKey = (input.industry.name ?? "").toLowerCase();
  const isHealthcare = HEALTH_INDUSTRY_KEYS.some((k) => industryKey.includes(k));

  for (const rule of HARMFUL_RULES) {
    // Skip rules that cannot match at all.
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(input.text)) !== null) {
      const matched = m[0];
      const start = m.index;
      const end = start + matched.length;

      // Apply exemptions.
      let contextSoftened = false;
      if (rule.softenedBy.includes(input.context)) contextSoftened = true;
      if (
        !contextSoftened &&
        isAdvisoryExempt &&
        (rule.category === "professional-advice-overreach" ||
          rule.category === "regulated-product-claim")
      ) {
        contextSoftened = true;
      }
      if (
        !contextSoftened &&
        isHealthcare &&
        (rule.category === "professional-advice-overreach" ||
          rule.category === "regulated-product-claim") &&
        input.context === "clinical-guideline-reference"
      ) {
        contextSoftened = true;
      }

      let severity: HarmfulSeverity = rule.severity;
      if (contextSoftened && severity === "critical") severity = "high";
      else if (contextSoftened && severity === "high") severity = "moderate";

      findings.push({
        fragmentId: input.id,
        location: input.location,
        category: rule.category,
        severity,
        matchedText: matched,
        matchStart: start,
        matchEnd: end,
        reason: rule.reason,
        contextSoftened,
      });

      if (input.suppressed.has(rule.category)) {
        input.notes.push({
          kind: "category-not-active-for-industry",
          detail: `Fragment "${input.id}": category "${rule.category}" is suppressed for this deployment; the finding is recorded but does not upgrade the verdict on its own.`,
        });
      }
      // Prevent infinite loop on zero-length matches (defensive).
      if (regex.lastIndex === m.index) regex.lastIndex = m.index + 1;
    }
  }

  // De-duplicate findings that matched the same span with the same category.
  const seen = new Set<string>();
  const unique: HarmfulFinding[] = [];
  for (const f of findings) {
    const key = `${f.category}|${f.matchStart}|${f.matchEnd}|${f.severity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }

  // Determine the verdict. A finding with a suppressed category does not
  // upgrade the fragment on its own.
  const actionable = unique.filter((f) => !input.suppressed.has(f.category));
  let verdict: HarmfulFragmentVerdict;
  if (actionable.length === 0) {
    verdict = "clean";
  } else if (
    actionable.every(
      (f) => f.severity === "moderate" && f.category === "professional-advice-overreach",
    )
  ) {
    // Moderate overreach is a "needs-context" signal, not a "flagged" one:
    // the reviewer must confirm the guide includes the disclaimers layer's
    // output for this section.
    verdict = "needs-context";
  } else {
    verdict = "flagged";
  }

  const highestSeverity: HarmfulSeverity | null =
    actionable.length === 0
      ? null
      : actionable.some((f) => f.severity === "critical")
        ? "critical"
        : actionable.some((f) => f.severity === "high")
          ? "high"
          : "moderate";

  const categories = new Set(actionable.map((f) => f.category));
  const summary =
    verdict === "clean"
      ? unique.length === 0
        ? "No harmful-content patterns were matched."
        : `Pattern matches were recorded but suppressed for this deployment (categories: ${[...new Set(unique.map((f) => f.category))].join(", ")}).`
      : verdict === "needs-context"
        ? `Advisory overreach detected (categories: ${[...categories].join(", ")}). The disclaimers layer must cover this section or a reviewer must confirm the claim.`
        : `${actionable.length} finding(s) across categories ${[...categories].join(", ")}. Highest severity: ${highestSeverity ?? "none"}.`;

  return {
    fragmentId: input.id,
    location: input.location,
    verdict,
    findings: unique,
    highestSeverity,
    summary,
  };
}

function readStringEnum<T extends readonly string[]>(
  v: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T[number])
    : fallback;
}

function readFindings(v: unknown): readonly HarmfulFinding[] {
  if (!Array.isArray(v)) return [];
  const out: HarmfulFinding[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const category = readStringEnum(o["category"], HARMFUL_CATEGORIES, "harassment");
    const severity = readStringEnum(o["severity"], HARMFUL_SEVERITIES, "moderate");
    out.push({
      fragmentId: typeof o["fragmentId"] === "string" ? o["fragmentId"] : "",
      location: typeof o["location"] === "string" ? o["location"] : "",
      category,
      severity,
      matchedText: typeof o["matchedText"] === "string" ? o["matchedText"] : "",
      matchStart:
        typeof o["matchStart"] === "number" && Number.isFinite(o["matchStart"])
          ? Math.max(0, Math.floor(o["matchStart"]))
          : 0,
      matchEnd:
        typeof o["matchEnd"] === "number" && Number.isFinite(o["matchEnd"])
          ? Math.max(0, Math.floor(o["matchEnd"]))
          : 0,
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
      contextSoftened: o["contextSoftened"] === true,
    });
  }
  return out;
}

function readFragments(v: unknown): readonly HarmfulFragmentResult[] {
  if (!Array.isArray(v)) return [];
  const out: HarmfulFragmentResult[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const severityRaw = o["highestSeverity"];
    const highestSeverity: HarmfulSeverity | null =
      severityRaw === "critical" || severityRaw === "high" || severityRaw === "moderate"
        ? severityRaw
        : null;
    out.push({
      fragmentId: typeof o["fragmentId"] === "string" ? o["fragmentId"] : "",
      location: typeof o["location"] === "string" ? o["location"] : "",
      verdict: readStringEnum(o["verdict"], HARMFUL_FRAGMENT_VERDICTS, "clean"),
      findings: readFindings(o["findings"]),
      highestSeverity,
      summary: typeof o["summary"] === "string" ? o["summary"] : "",
    });
  }
  return out;
}

function readNotes(v: unknown): readonly HarmfulContentNote[] {
  if (!Array.isArray(v)) return [];
  const out: HarmfulContentNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "no-fragments" &&
      kind !== "empty-fragment" &&
      kind !== "source-origin" &&
      kind !== "context-supplied" &&
      kind !== "context-unknown" &&
      kind !== "category-not-active-for-industry"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

function readSummary(v: unknown): HarmfulContentReport["summary"] {
  const fallback = {
    total: 0,
    clean: 0,
    flagged: 0,
    needsContext: 0,
    critical: 0,
    high: 0,
    moderate: 0,
  };
  if (v === null || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  const read = (k: string): number => {
    const val = o[k];
    return typeof val === "number" && Number.isFinite(val) ? Math.max(0, Math.floor(val)) : 0;
  };
  return {
    total: read("total"),
    clean: read("clean"),
    flagged: read("flagged"),
    needsContext: read("needsContext"),
    critical: read("critical"),
    high: read("high"),
    moderate: read("moderate"),
  };
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  HARMFUL_RULES,
  ADVISORY_EXEMPT_FRAGMENT_PATTERNS,
  evaluateFragment,
  readStringEnum,
  readFindings,
  readFragments,
  readNotes,
  readSummary,
  HEALTH_INDUSTRY_KEYS,
});
