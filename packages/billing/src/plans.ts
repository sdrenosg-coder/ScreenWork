/**
 * Zipy AI — billing plan model (phase 24, batch 2).
 *
 * The plan's user choices pin the billing scope: "Build billing models and
 * usage metering only, no live charges". This module is the *model*: the plan
 * tiers, their limits, their feature gates, and the arithmetic that maps a
 * raw usage figure to a limit check. It deliberately does not talk to a
 * payment gateway. `@/lib/config` exposes a `billing.provider` value that is
 * currently `"none"` or `"stripe"`, and this module respects that: a plan is
 * usable for metering regardless of whether charges are live, and a caller
 * who asks "can I charge this workspace?" receives `false` when the operator
 * has not supplied a Stripe key.
 *
 * Design boundaries honoured here:
 *
 *  - The module is *pure*. It does not read or write the database, does not
 *    read the clock, and does not call any external system. A metering layer
 *    above it (`./metering.ts`, next batch) aggregates usage from the events
 *    the platform already records and calls `checkLimit` on this module.
 *
 *  - No payment gateway is invented. The module has no concept of an active
 *    subscription; it has a `planId` assigned to a workspace, and it uses
 *    that to answer "what is this workspace allowed to do?". An operator who
 *    wires Stripe next maps their subscription state to a plan id; the
 *    module's contract does not change.
 *
 *  - No limit is silently ignored. A usage check returns a typed result with
 *    the tier, the limit, the observed usage, and whether the workspace is
 *    over. A caller that ignores the boolean still has the numbers to render
 *    a usage-alert UI, and the (next-batch) alerting layer reads them.
 *
 *  - Limits are one-sided. Every limit is a *maximum*, not a minimum; a
 *    `null` limit means "unmetered at this tier". This is the shape the
 *    metering layer wants: it never has to invent a floor.
 *
 *  - The overage policy is per-tier. Free plans hard-stop when a limit is
 *    reached (the metering layer refuses to enqueue more of that resource);
 *    paid plans record the overage and (in the next batch) trigger a usage
 *    alert. This asymmetry is a policy decision the plan documents, not an
 *    implementation detail the caller has to reverse-engineer.
 *
 * The module exports:
 *   - `PLAN_TIERS` — the ordered tier list (Free, Pro, Business, Enterprise).
 *   - `getPlan` — the definition for a plan id.
 *   - `checkLimit` — a single-resource limit check.
 *   - `checkAllLimits` — a batch check for the dashboard's usage card.
 *   - `isFeatureEnabled` — the feature gate.
 *   - `assignPlan` — a validated plan-id assignment.
 *   - `rehydratePlanAssignment` — typed load of a persisted assignment.
 *   - Typed errors, resource constants, and a human summary.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type BillingErrorCode =
  | "invalid-input"
  | "unknown-plan"
  | "unknown-resource"
  | "wrong-version";

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: BillingErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "BillingError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The plan tiers. Order matters: a caller can compare two plans with
 * `planRank(a) > planRank(b)` to answer "is b an upgrade of a?". The tier
 * *ids* are stable strings so a persisted row is not coupled to this array's
 * ordering; the ordering is a property of the module, not of the data.
 */
export const PLAN_TIERS = ["free", "pro", "business", "enterprise"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

/**
 * The metered resources. Every entry is a *count* the platform records as it
 * is consumed; the metering layer aggregates the count per workspace and
 * period and calls `checkLimit`. Kept as an enum for the same reason the job
 * kinds are: a resource added to a plan without a corresponding event
 * stream is a design error the type system should catch.
 */
export const METERED_RESOURCES = [
  "guides",
  "regenerations-per-month",
  "screenshots",
  "browser-minutes",
  "llm-tokens",
  "storage-bytes",
  "workspace-members",
] as const;
export type MeteredResource = (typeof METERED_RESOURCES)[number];

/** The feature flags a plan can enable or disable. */
export const PLAN_FEATURES = [
  "custom-branding",
  "custom-domain",
  "white-label",
  "sso-saml",
  "api-access",
  "webhooks",
  "priority-generation",
  "review-workflow",
  "translation",
  "advanced-analytics",
  "audit-log-export",
  "on-prem-deployment",
  "byo-api-keys",
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/**
 * The overage policy for a resource at a tier:
 *  - `hard` — the metering layer refuses the operation when the limit is
 *    reached. Used on the free tier so a user who has not paid is not
 *    surprised by a bill.
 *  - `soft` — the metering layer records the usage and triggers a usage
 *    alert; the operation still succeeds. Used on paid tiers.
 *  - `unmetered` — the resource has no limit at this tier.
 */
export type OveragePolicy = "hard" | "soft" | "unmetered";

export interface PlanLimit {
  /** The maximum usage in the billing period; `null` means unmetered. */
  readonly limit: number | null;
  readonly overage: OveragePolicy;
  /** Human-readable unit for the UI, e.g. "guides", "minutes". */
  readonly unit: string;
}

export interface PlanDefinition {
  readonly tier: PlanTier;
  readonly displayName: string;
  /** One-paragraph marketing description the pricing page renders. */
  readonly description: string;
  /**
   * The limit for each metered resource. Every plan defines every resource so
   * the metering layer never has to special-case a missing key.
   */
  readonly limits: Readonly<Record<MeteredResource, PlanLimit>>;
  /** The features this plan enables. Absence from the set means disabled. */
  readonly features: readonly PlanFeature[];
  /**
   * The referral credit awarded when a workspace on this plan refers a new
   * customer who signs up. Free plans award a smaller credit; enterprise
   * plans award credits in a negotiated amount and the value here is the
   * default the referral module uses in the absence of a contract.
   */
  readonly referralCreditUsd: number;
  /**
   * Whether a workspace on this plan may be charged. `false` on the free
   * tier; `true` on the paid tiers. A caller must still consult
   * `canChargeWorkspace` before initiating a live charge, because the
   * operator's gateway configuration is a separate gate.
   */
  readonly billable: boolean;
}

/* -------------------------------------------------------------------------- */
/* The plan catalogue                                                         */
/* -------------------------------------------------------------------------- */

const GB = 1024 * 1024 * 1024;

export const PLANS: Readonly<Record<PlanTier, PlanDefinition>> = Object.freeze({
  free: {
    tier: "free",
    displayName: "Free",
    description:
      "Try the platform end-to-end. Local models only, a small monthly allowance, and no live charges — a workspace on this tier is never billed.",
    limits: {
      guides: { limit: 5, overage: "hard", unit: "guides" },
      "regenerations-per-month": {
        limit: 20,
        overage: "hard",
        unit: "regenerations",
      },
      screenshots: { limit: 500, overage: "hard", unit: "screenshots" },
      "browser-minutes": { limit: 120, overage: "hard", unit: "minutes" },
      "llm-tokens": { limit: 500_000, overage: "hard", unit: "tokens" },
      "storage-bytes": { limit: 1 * GB, overage: "hard", unit: "bytes" },
      "workspace-members": { limit: 3, overage: "hard", unit: "members" },
    },
    features: ["api-access"],
    referralCreditUsd: 5,
    billable: false,
  },
  pro: {
    tier: "pro",
    displayName: "Pro",
    description:
      "For a single team producing a steady stream of guides. Higher allowances, webhooks, translation and the review workflow are enabled.",
    limits: {
      guides: { limit: 100, overage: "soft", unit: "guides" },
      "regenerations-per-month": {
        limit: 500,
        overage: "soft",
        unit: "regenerations",
      },
      screenshots: { limit: 10_000, overage: "soft", unit: "screenshots" },
      "browser-minutes": { limit: 1_500, overage: "soft", unit: "minutes" },
      "llm-tokens": { limit: 20_000_000, overage: "soft", unit: "tokens" },
      "storage-bytes": { limit: 20 * GB, overage: "soft", unit: "bytes" },
      "workspace-members": { limit: 15, overage: "soft", unit: "members" },
    },
    features: [
      "api-access",
      "webhooks",
      "review-workflow",
      "translation",
      "byo-api-keys",
    ],
    referralCreditUsd: 25,
    billable: true,
  },
  business: {
    tier: "business",
    displayName: "Business",
    description:
      "For a product team with several concurrent workflows. Priority generation, custom branding, advanced analytics and a larger team are enabled.",
    limits: {
      guides: { limit: 1_000, overage: "soft", unit: "guides" },
      "regenerations-per-month": {
        limit: 5_000,
        overage: "soft",
        unit: "regenerations",
      },
      screenshots: { limit: 100_000, overage: "soft", unit: "screenshots" },
      "browser-minutes": { limit: 20_000, overage: "soft", unit: "minutes" },
      "llm-tokens": { limit: 200_000_000, overage: "soft", unit: "tokens" },
      "storage-bytes": { limit: 200 * GB, overage: "soft", unit: "bytes" },
      "workspace-members": { limit: 100, overage: "soft", unit: "members" },
    },
    features: [
      "api-access",
      "webhooks",
      "review-workflow",
      "translation",
      "advanced-analytics",
      "custom-branding",
      "custom-domain",
      "priority-generation",
      "audit-log-export",
      "byo-api-keys",
    ],
    referralCreditUsd: 50,
    billable: true,
  },
  enterprise: {
    tier: "enterprise",
    displayName: "Enterprise",
    description:
      "For a large organisation with compliance obligations. SSO/SAML, white-label theming, on-premise deployment and audit-log export are available; metered resources are unmetered at this tier so a large month does not surprise anyone.",
    limits: {
      guides: { limit: null, overage: "unmetered", unit: "guides" },
      "regenerations-per-month": {
        limit: null,
        overage: "unmetered",
        unit: "regenerations",
      },
      screenshots: { limit: null, overage: "unmetered", unit: "screenshots" },
      "browser-minutes": { limit: null, overage: "unmetered", unit: "minutes" },
      "llm-tokens": { limit: null, overage: "unmetered", unit: "tokens" },
      "storage-bytes": { limit: null, overage: "unmetered", unit: "bytes" },
      "workspace-members": { limit: null, overage: "unmetered", unit: "members" },
    },
    features: [
      "api-access",
      "webhooks",
      "review-workflow",
      "translation",
      "advanced-analytics",
      "custom-branding",
      "custom-domain",
      "white-label",
      "sso-saml",
      "priority-generation",
      "audit-log-export",
      "on-prem-deployment",
      "byo-api-keys",
    ],
    referralCreditUsd: 100,
    billable: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function getPlan(tier: string): PlanDefinition {
  if (!isPlanTier(tier)) {
    throw new BillingError(
      `Unknown plan tier "${String(tier)}". Expected one of: ${PLAN_TIERS.join(", ")}.`,
      "unknown-plan",
      { tier },
    );
  }
  return PLANS[tier];
}

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === "string" && (PLAN_TIERS as readonly string[]).includes(value);
}

export function isMeteredResource(value: unknown): value is MeteredResource {
  return (
    typeof value === "string" && (METERED_RESOURCES as readonly string[]).includes(value)
  );
}

export function isPlanFeature(value: unknown): value is PlanFeature {
  return typeof value === "string" && (PLAN_FEATURES as readonly string[]).includes(value);
}

/** The numeric rank of a tier, for upgrade/downgrade comparison. */
export function planRank(tier: PlanTier): number {
  return PLAN_TIERS.indexOf(tier);
}

/**
 * The outcome of a single limit check. `allowed` is the answer the metering
 * layer acts on; `overage` describes what should happen next. `remaining` is
 * `null` when the resource is unmetered.
 */
export interface LimitCheck {
  readonly resource: MeteredResource;
  readonly tier: PlanTier;
  readonly limit: number | null;
  readonly used: number;
  readonly remaining: number | null;
  readonly allowed: boolean;
  readonly overage: OveragePolicy;
  /** Percentage of the limit used, in [0, 100]; 0 when unmetered. Rounded. */
  readonly percentUsed: number;
}

/**
 * Check one resource against a plan. `used` is the aggregate the metering
 * layer computed for the current period; the module does not read it. A
 * negative `used` is rejected as invalid rather than clamped, because a
 * negative aggregate almost always indicates a bug upstream.
 */
export function checkLimit(
  tier: PlanTier,
  resource: MeteredResource,
  used: number,
): LimitCheck {
  if (!isPlanTier(tier)) {
    throw new BillingError(`Unknown plan tier "${String(tier)}".`, "unknown-plan", { tier });
  }
  if (!isMeteredResource(resource)) {
    throw new BillingError(
      `Unknown metered resource "${String(resource)}". Expected one of: ${METERED_RESOURCES.join(", ")}.`,
      "unknown-resource",
      { resource },
    );
  }
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) {
    throw new BillingError(
      `checkLimit requires a non-negative finite \`used\`; received ${String(used)}.`,
      "invalid-input",
      { used },
    );
  }
  const limit = PLANS[tier].limits[resource];
  if (limit.limit === null) {
    return {
      resource,
      tier,
      limit: null,
      used,
      remaining: null,
      allowed: true,
      overage: "unmetered",
      percentUsed: 0,
    };
  }
  const remaining = Math.max(0, limit.limit - used);
  const allowed = used < limit.limit;
  const percentUsed = limit.limit > 0
    ? Math.min(100, Math.round((used / limit.limit) * 100))
    : 100;
  return {
    resource,
    tier,
    limit: limit.limit,
    used,
    remaining,
    allowed,
    overage: limit.overage,
    percentUsed,
  };
}

/**
 * Check every metered resource in one call. `usage` may be a partial map;
 * any resource not present is checked with `used: 0`. This is the shape the
 * dashboard's usage card wants, and it matches the metering layer's
 * `getUsage(workspaceId)` return type.
 */
export function checkAllLimits(
  tier: PlanTier,
  usage: Partial<Readonly<Record<MeteredResource, number>>>,
): readonly LimitCheck[] {
  if (!isPlanTier(tier)) {
    throw new BillingError(`Unknown plan tier "${String(tier)}".`, "unknown-plan", { tier });
  }
  if (usage === null || typeof usage !== "object") {
    throw new BillingError("checkAllLimits requires a usage map.", "invalid-input");
  }
  const out: LimitCheck[] = [];
  for (const resource of METERED_RESOURCES) {
    const value = usage[resource];
    const used = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    out.push(checkLimit(tier, resource, used));
  }
  return Object.freeze(out);
}

/** Whether a plan enables a feature. */
export function isFeatureEnabled(tier: PlanTier, feature: PlanFeature): boolean {
  if (!isPlanTier(tier)) {
    throw new BillingError(`Unknown plan tier "${String(tier)}".`, "unknown-plan", { tier });
  }
  if (!isPlanFeature(feature)) {
    throw new BillingError(
      `Unknown plan feature "${String(feature)}". Expected one of: ${PLAN_FEATURES.join(", ")}.`,
      "unknown-resource",
      { feature },
    );
  }
  return PLANS[tier].features.includes(feature);
}

/* -------------------------------------------------------------------------- */
/* Plan assignment                                                            */
/* -------------------------------------------------------------------------- */

export interface PlanAssignment {
  readonly version: "plan-assignment/1";
  readonly workspaceId: string;
  readonly tier: PlanTier;
  /**
   * The operator's chosen "current" status of the assignment. `active` means
   * the plan is in force; `trialing` means the workspace is on the plan's
   * limits for a limited window; `past-due` means the plan's *features* are
   * still enabled but the operator should not iterate on the plan without a
   * payment; `canceled` means the plan is being wound down and the assignment
   * no longer grants new operations.
   */
  readonly status: "active" | "trialing" | "past-due" | "canceled";
  /** ISO timestamp the assignment began. */
  readonly startedAt: string;
  /** ISO timestamp the trial or current period ends; null for active plans. */
  readonly currentPeriodEnd: string | null;
  /**
   * The operator's reference to their billing system (a Stripe subscription
   * id or a contract number). The platform stores this value opaquely; the
   * module does not interpret it and does not use it to make decisions.
   */
  readonly externalReference: string | null;
  readonly updatedAt: string;
}

export interface AssignPlanInput {
  readonly workspaceId: string;
  readonly tier: PlanTier;
  readonly status?: PlanAssignment["status"];
  readonly startedAt: string;
  readonly currentPeriodEnd?: string | null;
  readonly externalReference?: string | null;
  readonly updatedAt: string;
}

/**
 * Validate and normalise a plan assignment. The module does not persist it;
 * a caller above it (the billing route, next batch) writes the row.
 */
export function assignPlan(input: AssignPlanInput): PlanAssignment {
  if (input === null || typeof input !== "object") {
    throw new BillingError("assignPlan requires an inputs object.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new BillingError("`workspaceId` is required.", "invalid-input");
  }
  if (!isPlanTier(input.tier)) {
    throw new BillingError(
      `Unknown plan tier "${String(input.tier)}".`,
      "unknown-plan",
      { tier: input.tier },
    );
  }
  const status = input.status ?? "active";
  if (
    status !== "active" &&
    status !== "trialing" &&
    status !== "past-due" &&
    status !== "canceled"
  ) {
    throw new BillingError(
      `Unknown assignment status "${String(status)}".`,
      "invalid-input",
      { status },
    );
  }
  if (typeof input.startedAt !== "string" || !Number.isFinite(Date.parse(input.startedAt))) {
    throw new BillingError(
      `\`startedAt\` must be an ISO timestamp; received "${String(input.startedAt)}".`,
      "invalid-input",
      { startedAt: input.startedAt },
    );
  }
  const currentPeriodEnd = input.currentPeriodEnd ?? null;
  if (currentPeriodEnd !== null) {
    if (typeof currentPeriodEnd !== "string" || !Number.isFinite(Date.parse(currentPeriodEnd))) {
      throw new BillingError(
        `\`currentPeriodEnd\` must be an ISO timestamp or null; received "${String(currentPeriodEnd)}".`,
        "invalid-input",
        { currentPeriodEnd },
      );
    }
    if (Date.parse(currentPeriodEnd) <= Date.parse(input.startedAt)) {
      throw new BillingError(
        "`currentPeriodEnd` must be after `startedAt`.",
        "invalid-input",
        { startedAt: input.startedAt, currentPeriodEnd },
      );
    }
  }
  if (typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) {
    throw new BillingError(
      `\`updatedAt\` must be an ISO timestamp; received "${String(input.updatedAt)}".`,
      "invalid-input",
      { updatedAt: input.updatedAt },
    );
  }
  return {
    version: "plan-assignment/1",
    workspaceId: input.workspaceId,
    tier: input.tier,
    status,
    startedAt: input.startedAt,
    currentPeriodEnd,
    externalReference: input.externalReference ?? null,
    updatedAt: input.updatedAt,
  };
}

export function rehydratePlanAssignment(value: unknown): PlanAssignment {
  if (value === null || typeof value !== "object") {
    throw new BillingError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "plan-assignment/1") {
    throw new BillingError(
      `Rehydrate failed: expected version "plan-assignment/1", received "${String(r["version"])}".`,
      "wrong-version",
    );
  }
  const tier = isPlanTier(r["tier"]) ? r["tier"] : "free";
  const statusRaw = r["status"];
  const status: PlanAssignment["status"] =
    statusRaw === "trialing" || statusRaw === "past-due" || statusRaw === "canceled"
      ? statusRaw
      : "active";
  return {
    version: "plan-assignment/1",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    tier,
    status,
    startedAt: typeof r["startedAt"] === "string" ? r["startedAt"] : "",
    currentPeriodEnd:
      typeof r["currentPeriodEnd"] === "string" ? r["currentPeriodEnd"] : null,
    externalReference:
      typeof r["externalReference"] === "string" ? r["externalReference"] : null,
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
  };
}

/**
 * Whether the platform may *attempt* a live charge for a workspace. The
 * answer is false when either condition is missing:
 *
 *   1. The plan is billable (the free tier is never charged), and
 *   2. The operator has supplied a payment-gateway credential (which
 *      `@/lib/config` reports as `billing.liveChargesEnabled`).
 *
 * This function does not initiate a charge; it is the gate a charging code
 * path (next batch) reads first.
 */
export function canChargeWorkspace(
  assignment: PlanAssignment,
  liveChargesEnabled: boolean,
): { readonly allowed: boolean; readonly reason: string | null } {
  if (assignment === null || typeof assignment !== "object" || assignment.version !== "plan-assignment/1") {
    throw new BillingError(
      'canChargeWorkspace requires a PlanAssignment (version "plan-assignment/1").',
      "invalid-input",
    );
  }
  if (!PLANS[assignment.tier].billable) {
    return {
      allowed: false,
      reason: `The ${PLANS[assignment.tier].displayName} plan is not billable.`,
    };
  }
  if (assignment.status === "canceled") {
    return {
      allowed: false,
      reason: "The workspace's plan assignment is canceled.",
    };
  }
  if (!liveChargesEnabled) {
    return {
      allowed: false,
      reason:
        "No payment-gateway credential is configured. The operator must supply a Stripe secret key before charges can be attempted.",
    };
  }
  return { allowed: true, reason: null };
}

/**
 * One-line human summary the workspace settings page renders.
 */
export function describeAssignment(assignment: PlanAssignment): string {
  const plan = PLANS[assignment.tier];
  switch (assignment.status) {
    case "active":
      return `On the ${plan.displayName} plan since ${assignment.startedAt}.`;
    case "trialing":
      return `Trialing ${plan.displayName} until ${assignment.currentPeriodEnd ?? "an unset date"}.`;
    case "past-due":
      return `On the ${plan.displayName} plan, payment past due since ${assignment.updatedAt}.`;
    case "canceled":
      return `${plan.displayName} plan canceled on ${assignment.updatedAt}.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Persistence DDL — declared here so the migration runner registers it once  */
/* -------------------------------------------------------------------------- */

export const PLAN_ASSIGNMENTS_TABLE = "plan_assignments" as const;
export const PLAN_ASSIGNMENTS_SCHEMA_VERSION = 1 as const;

export const CREATE_PLAN_ASSIGNMENTS_SQL = `
CREATE TABLE IF NOT EXISTS ${PLAN_ASSIGNMENTS_TABLE} (
  workspace_id          UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  tier                  TEXT NOT NULL DEFAULT 'free',
  status                TEXT NOT NULL DEFAULT 'active',
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end    TIMESTAMPTZ,
  external_reference    TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${PLAN_ASSIGNMENTS_TABLE}_tier_allowed
    CHECK (tier IN ('free','pro','business','enterprise')),
  CONSTRAINT ${PLAN_ASSIGNMENTS_TABLE}_status_allowed
    CHECK (status IN ('active','trialing','past-due','canceled')),
  CONSTRAINT ${PLAN_ASSIGNMENTS_TABLE}_period_end_after_start
    CHECK (current_period_end IS NULL OR current_period_end > started_at)
);

DROP TRIGGER IF EXISTS trg_${PLAN_ASSIGNMENTS_TABLE}_updated_at ON ${PLAN_ASSIGNMENTS_TABLE};
CREATE TRIGGER trg_${PLAN_ASSIGNMENTS_TABLE}_updated_at
  BEFORE UPDATE ON ${PLAN_ASSIGNMENTS_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();
`;

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                        */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  GB,
  planRankImpl: planRank,
});
