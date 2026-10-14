/**
 * Zipy AI — human-in-the-loop review: action risk classification (phase 19, batch 0).
 *
 * Classifies every synthesized plan step into one of five risk classes so the
 * checkpoint layer (`@zipy/review/checkpoints`) can decide which steps pause
 * for a human. The classifier is deterministic and rule-based: it reads the
 * action verb, the target element's accessible role/name, the URL host relative
 * to the run's origin, and the value the step would type. It never consults an
 * LLM, never invents a risk it cannot justify, and always returns a `reasons`
 * trail so a reviewer can see *why* a high-risk classification was assigned.
 *
 * Risk classes, weakest to strongest:
 *   read-only              — navigation, scrolling, opening menus/help. No state change.
 *   write                  — creating or editing application data (a form save).
 *   destructive            — delete/remove/revoke/cancel-style actions.
 *   financial              — payments, refunds, billing, plan changes, purchases.
 *   external-communication — emails, invites, messages, notifications leaving the workspace.
 *
 * Design boundaries:
 *  - The classifier does not guess. When the action verb and target are both
 *    uninformative (`scroll` on an unnamed element) it returns `read-only`,
 *    which is the safe default for *gating* purposes because a read-only step
 *    is never held; misclassifying an unnamed destructive control as read-only
 *    is a real hazard, so any step whose name matches a destructive verb —
 *    even inside an unnamed role — is escalated.
 *  - The classifier never touches the network. A URL whose host differs from
 *    the workflow origin is `external-communication` only when the step's
 *    verb or value implies a message; a bare navigation to an external host is
 *    `read-only` (a reference link the reader may follow at leisure).
 *  - The classifier is a *pure* function: same plan + same config produces the
 *    same classification. Sorting is stable by step index.
 *
 * Output shape (`RiskClassification`) is versioned for the checkpoint layer
 * and the audit trail.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type RiskClassErrorCode = "invalid-input" | "no-plan";

export class RiskClassError extends Error {
  readonly code: RiskClassErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: RiskClassErrorCode,
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

export const RISK_CLASSES = [
  "read-only",
  "write",
  "destructive",
  "financial",
  "external-communication",
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Ordinal rank; higher = more dangerous. Stable across versions. */
export const RISK_RANK: Readonly<Record<RiskClass, number>> = Object.freeze({
  "read-only": 0,
  write: 1,
  destructive: 2,
  financial: 3,
  "external-communication": 4,
});

export interface RiskReason {
  /** Short, machine-stable tag; the review UI groups by these. */
  readonly tag:
    | "verb-destructive"
    | "verb-financial"
    | "verb-external"
    | "verb-write"
    | "verb-read-only"
    | "name-destructive"
    | "name-financial"
    | "name-external"
    | "name-write"
    | "role-suggests-state-change"
    | "external-host-with-message"
    | "value-contains-email"
    | "value-contains-money"
    | "default-read-only";
  /** Human-readable sentence shown in the review panel. */
  readonly detail: string;
}

export interface RiskClassification {
  readonly version: "risk/1";
  readonly stepId: string;
  readonly stepIndex: number;
  readonly risk: RiskClass;
  /** True when the classification was reached by the conservative default. */
  readonly viaDefault: boolean;
  readonly reasons: readonly RiskReason[];
  readonly classifiedAt: string;
}

export interface RiskClassificationReport {
  readonly version: "risk-report/1";
  readonly workflowId: string | null;
  readonly classifications: readonly RiskClassification[];
  /** Highest risk present across the step list; null when the plan had no steps. */
  readonly highestRisk: RiskClass | null;
  readonly counts: Readonly<Record<RiskClass, number>>;
  /** ISO timestamp the report was produced. */
  readonly generatedAt: string;
  readonly aiGenerated: false;
}

/**
 * The subset of step shape the classifier reads. Kept narrow so this module
 * does not depend on the full `Plan`/`PlanStep` types from the synthesis phase
 * (which the review phase may be embedded in without the plan module loaded).
 */
export interface ClassifiableStep {
  readonly id: string;
  readonly action: string;
  readonly target: {
    readonly role?: string | null;
    readonly name?: string | null;
    /** Optional URL the step's `navigate` action loads. */
    readonly url?: string | null;
  } | null;
  readonly value?: string | null;
}

export interface ClassifyRiskInput {
  readonly workflowId?: string | null;
  /** The steps to classify. Order is preserved in the output. */
  readonly steps: readonly ClassifiableStep[];
  /**
   * The origin of the application under test, e.g. `https://app.example.com`.
   * Used to decide whether a `navigate` step leaves the app. Absent = every
   * navigation is treated as outside the app (conservative).
   */
  readonly workflowOrigin?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Verbs that imply destroying, removing or revoking state. Matched case-
 * insensitively against the *whole word*; partial matches do not count
 * ("annulled" is not "null"). The vocabulary is deliberately conservative —
 * adding a verb here is a code change with a test, not a config knob.
 */
const DESTRUCTIVE_VERBS: readonly string[] = [
  "delete",
  "remove",
  "revoke",
  "unlink",
  "unsubscribe",
  "cancel",
  "destroy",
  "purge",
  "terminate",
  "dismiss",
  "close-account",
  "wipe",
  "archive",
];

/** Verbs or phrases that spend money or change a plan/billing state. */
const FINANCIAL_VERBS: readonly string[] = [
  "pay",
  "purchase",
  "buy",
  "checkout",
  "refund",
  "charge",
  "subscribe",
  "upgrade",
  "downgrade",
  "invoice",
  "withdraw",
  "transfer",
];

/** Verbs that send a message, invite, or notification outside the workspace. */
const EXTERNAL_VERBS: readonly string[] = [
  "send",
  "email",
  "invite",
  "message",
  "notify",
  "publish",
  "tweet",
  "post",
  "share",
  "forward",
  "reply",
];

/** Verbs that create or mutate application data without any of the above. */
const WRITE_VERBS: readonly string[] = [
  "save",
  "create",
  "add",
  "update",
  "edit",
  "submit",
  "upload",
  "import",
  "apply",
  "confirm",
  "type",
  "select",
  "toggle",
  "enable",
  "disable",
  "assign",
];

/** Verbs that only read or move the reader; the weakest class. */
const READ_ONLY_VERBS: readonly string[] = [
  "click",
  "open",
  "view",
  "scroll",
  "navigate",
  "go",
  "expand",
  "collapse",
  "hover",
  "focus",
  "read",
];

/**
 * Accessible-role values that suggest the step interacts with a state-changing
 * control when the verb is uninformative. Used as a tie-breaker, not a primary
 * signal.
 */
const STATE_CHANGE_ROLES: readonly string[] = [
  "textbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "searchbox",
];

/** A paired destructive/positive phrase that appears in button names often. */
const NAME_WRITE_PATTERNS: readonly RegExp[] = [
  /\b(save|create|add|update|edit|submit|confirm|apply|import|upload)\b/i,
];

const NAME_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\b(delete|remove|revoke|unlink|unsubscribe|cancel|destroy|purge)\b/i,
];

const NAME_FINANCIAL_PATTERNS: readonly RegExp[] = [
  /\b(pay|purchase|buy|checkout|refund|subscribe|billing|invoice|plan)\b/i,
];

const NAME_EXTERNAL_PATTERNS: readonly RegExp[] = [
  /\b(send|e-?mail|invite|message|notify|publish|tweet|share|post|forward|reply)\b/i,
];

const EMAIL_SHAPE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/u;
const MONEY_SHAPE = /(?:\b\d[\d,.]*\s*(?:usd|eur|gbp|jpy|cad|aud|inr)|[$\u00A3\u20AC\u00A5]\s*\d[\d,.]*)/iu;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function classifyRisk(input: ClassifyRiskInput): RiskClassificationReport {
  if (input === null || typeof input !== "object") {
    throw new RiskClassError("classifyRisk requires an inputs object.", "invalid-input");
  }
  if (!Array.isArray(input.steps)) {
    throw new RiskClassError("`steps` must be an array.", "no-plan");
  }
  const now = new Date().toISOString();
  const counts: Record<RiskClass, number> = {
    "read-only": 0,
    write: 0,
    destructive: 0,
    financial: 0,
    "external-communication": 0,
  };

  const classifications: RiskClassification[] = [];
  let highest: RiskClass | null = null;
  for (let i = 0; i < input.steps.length; i += 1) {
    const step = input.steps[i]!;
    const classification = classifyOneStep(step, i, input.workflowOrigin ?? null, now);
    classifications.push(classification);
    counts[classification.risk] += 1;
    if (highest === null || RISK_RANK[classification.risk] > RISK_RANK[highest]) {
      highest = classification.risk;
    }
  }

  return {
    version: "risk-report/1",
    workflowId: nonEmpty(input.workflowId),
    classifications,
    highestRisk: highest,
    counts,
    generatedAt: now,
    aiGenerated: false,
  };
}

/**
 * Single-step helper. Exposed because the checkpoint layer evaluates one step
 * at a time during a live run and should not build a whole report for that.
 */
export function classifyOneStep(
  step: ClassifiableStep,
  index: number,
  workflowOrigin: string | null,
  classifiedAt?: string,
): RiskClassification {
  if (step === null || typeof step !== "object") {
    throw new RiskClassError("classifyOneStep requires a step object.", "invalid-input");
  }
  const stepId = nonEmpty(step.id) ?? `step-${index + 1}`;
  const action = typeof step.action === "string" ? step.action.toLowerCase() : "";
  const targetRole = step.target !== null && step.target !== undefined && typeof step.target.role === "string"
    ? step.target.role.toLowerCase()
    : "";
  const targetName = step.target !== null && step.target !== undefined && typeof step.target.name === "string"
    ? step.target.name
    : "";
  const targetUrl = step.target !== null && step.target !== undefined && typeof step.target.url === "string"
    ? step.target.url
    : "";
  const value = typeof step.value === "string" ? step.value : "";

  const reasons: RiskReason[] = [];

  // Highest-risk signal first: destructive verbs and names.
  if (hasVerb(action, DESTRUCTIVE_VERBS)) {
    reasons.push({
      tag: "verb-destructive",
      detail: `The step's action verb "${action}" performs a destructive change.`,
    });
  }
  if (matchesAny(targetName, NAME_DESTRUCTIVE_PATTERNS)) {
    reasons.push({
      tag: "name-destructive",
      detail: `The target's name "${targetName}" indicates a destructive control.`,
    });
  }
  if (reasons.length > 0) {
    return emit(stepId, index, "destructive", false, reasons, classifiedAt);
  }

  // Financial signals.
  if (hasVerb(action, FINANCIAL_VERBS)) {
    reasons.push({
      tag: "verb-financial",
      detail: `The step's action verb "${action}" initiates a financial operation.`,
    });
  }
  if (matchesAny(targetName, NAME_FINANCIAL_PATTERNS)) {
    reasons.push({
      tag: "name-financial",
      detail: `The target's name "${targetName}" indicates a billing or payment control.`,
    });
  }
  if (MONEY_SHAPE.test(value)) {
    reasons.push({
      tag: "value-contains-money",
      detail: `The value "${truncate(value, 60)}" contains a monetary amount.`,
    });
  }
  if (reasons.length > 0) {
    return emit(stepId, index, "financial", false, reasons, classifiedAt);
  }

  // External communication signals.
  if (hasVerb(action, EXTERNAL_VERBS)) {
    reasons.push({
      tag: "verb-external",
      detail: `The step's action verb "${action}" may leave the workspace as an outbound message.`,
    });
  }
  if (matchesAny(targetName, NAME_EXTERNAL_PATTERNS)) {
    reasons.push({
      tag: "name-external",
      detail: `The target's name "${targetName}" indicates a message or notification control.`,
    });
  }
  if (EMAIL_SHAPE.test(value)) {
    reasons.push({
      tag: "value-contains-email",
      detail: `The value contains an email address; the step appears to send a message.`,
    });
  }
  // A navigate to a host different from the workflow origin is only external
  // when the step also carries a message-imperative (checked above). A single
  // external navigation is read-only (a link the reader may follow).
  if (
    action === "navigate" &&
    targetUrl.length > 0 &&
    workflowOrigin !== null &&
    isExternalUrl(targetUrl, workflowOrigin) &&
    (hasVerb(action, EXTERNAL_VERBS) || matchesAny(targetName, NAME_EXTERNAL_PATTERNS))
  ) {
    reasons.push({
      tag: "external-host-with-message",
      detail: `The step navigates to an external host "${safeHost(targetUrl)}" while performing a message action.`,
    });
  }
  if (reasons.length > 0) {
    return emit(stepId, index, "external-communication", false, reasons, classifiedAt);
  }

  // Write signals.
  if (hasVerb(action, WRITE_VERBS)) {
    reasons.push({
      tag: "verb-write",
      detail: `The step's action verb "${action}" changes application state.`,
    });
  }
  if (matchesAny(targetName, NAME_WRITE_PATTERNS)) {
    reasons.push({
      tag: "name-write",
      detail: `The target's name "${targetName}" indicates a state-changing control.`,
    });
  }
  if (reasons.length === 0 && STATE_CHANGE_ROLES.includes(targetRole) && value.trim().length > 0) {
    reasons.push({
      tag: "role-suggests-state-change",
      detail: `The step types into a "${targetRole}" control, which normally changes state on submit.`,
    });
  }
  if (reasons.length > 0) {
    return emit(stepId, index, "write", false, reasons, classifiedAt);
  }

  // Read-only signals (or the conservative default).
  if (hasVerb(action, READ_ONLY_VERBS) || action === "") {
    reasons.push({
      tag: "verb-read-only",
      detail: action === ""
        ? "The step has no recorded action verb; it is assumed to be a reading step."
        : `The step's action verb "${action}" does not change state.`,
    });
    return emit(stepId, index, "read-only", false, reasons, classifiedAt);
  }

  // Unknown verb: default to read-only, and say so explicitly.
  reasons.push({
    tag: "default-read-only",
    detail: `The step verb "${action}" is not in any recognised risk vocabulary; classified read-only.`,
  });
  return emit(stepId, index, "read-only", true, reasons, classifiedAt);
}

/**
 * A human-readable sentence a reviewer sees next to the classification badge.
 * Used by the review UI directly; the wording is stable so screenshots in a
 * help article do not drift between releases.
 */
export function describeRisk(classification: RiskClassification): string {
  switch (classification.risk) {
    case "read-only":
      return "Read-only: this step changes nothing in the application.";
    case "write":
      return "Write: this step creates or changes application data.";
    case "destructive":
      return "Destructive: this step removes or revokes something and may not be reversible.";
    case "financial":
      return "Financial: this step moves money or changes a billing plan.";
    case "external-communication":
      return "External communication: this step sends a message outside the workspace.";
  }
}

/**
 * True when the classification is at or above the given threshold. The
 * checkpoint layer uses this to decide which steps to gate.
 */
export function isAtLeast(classification: RiskClassification, threshold: RiskClass): boolean {
  return RISK_RANK[classification.risk] >= RISK_RANK[threshold];
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function emit(
  stepId: string,
  stepIndex: number,
  risk: RiskClass,
  viaDefault: boolean,
  reasons: readonly RiskReason[],
  classifiedAt?: string,
): RiskClassification {
  return {
    version: "risk/1",
    stepId,
    stepIndex,
    risk,
    viaDefault,
    reasons: Object.freeze([...reasons]),
    classifiedAt: classifiedAt ?? new Date().toISOString(),
  };
}

/** Case-insensitive whole-word membership check against a vocabulary list. */
function hasVerb(action: string, vocabulary: readonly string[]): boolean {
  if (action.length === 0) return false;
  for (const v of vocabulary) {
    if (v.includes("-")) {
      // Multi-word verbs use a phrase match.
      if (action.includes(v)) return true;
      continue;
    }
    // Word-boundary match so "annulled" is not "null".
    const re = new RegExp(`(?:^|\\W)${escapeRegex(v)}(?:$|\\W)`, "i");
    if (re.test(action)) return true;
  }
  return false;
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  if (text.length === 0) return false;
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}

function isExternalUrl(url: string, origin: string): boolean {
  const aHost = safeHost(url);
  const bHost = safeHost(origin);
  if (aHost === null || bHost === null) return false;
  return aHost !== bHost;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max).trimEnd() + "…";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  DESTRUCTIVE_VERBS,
  FINANCIAL_VERBS,
  EXTERNAL_VERBS,
  WRITE_VERBS,
  READ_ONLY_VERBS,
  STATE_CHANGE_ROLES,
  hasVerb,
  matchesAny,
  isExternalUrl,
  safeHost,
  truncate,
  escapeRegex,
  emit,
});
