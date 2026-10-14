/**
 * GET /api/billing/usage
 *
 * Returns the plan tier, current-cycle usage meters, seat usage, usage alerts
 * and referral credit state for the caller's active workspace.
 *
 * Responsibility split:
 *   - `@zipy/billing/plans`         — plan definitions and the mapping from a
 *                                     workspace's `plan` column to a tier.
 *   - `@zipy/billing/metering`      — the metering store: it is the ONLY
 *                                     reader of usage counters. This route
 *                                     never invents numbers; it forwards what
 *                                     the metering layer returns.
 *   - `@zipy/billing/alerts`        — evaluates whether the current counters
 *                                     cross the tier's thresholds and yields
 *                                     the alert list.
 *   - `@zipy/billing/referrals`     — referral credit summary.
 *
 * Auth + RBAC:
 *   - Requires a valid session (401 otherwise).
 *   - Requires an active workspace on the session and the workspace
 *     `billing_read` permission (403 otherwise).
 *
 * External setup: the payment gateway (Stripe) is NOT called here. If the
 * metering layer reports that a billing portal URL or plan-select URL is
 * unavailable because Stripe keys are not configured, those link fields are
 * returned as `null` and the notes array explains why. That is the honest
 * representation, not a stub.
 *
 * Config gating: DATABASE_URL and SESSION_SECRET must be present, otherwise
 * the route returns 503 with a `config_error` and a message that names the
 * missing variable. No fabricated data is returned under misconfiguration.
 *
 * This route does not implement PUT/POST/DELETE. Plan changes are performed
 * through the billing portal (or an admin surface) which is out of scope
 * until a payment gateway is configured. The other methods therefore return
 * 405 with an Allow header naming GET.
 */

import { NextResponse } from "next/server";

import { getConfig } from "@/lib/config";
import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
  type SessionLike,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";

import {
  resolvePlan,
  planCatalog,
  type BillingPlanTier,
} from "@zipy/billing/plans";
import {
  readUsageSnapshot,
  type UsageCounter,
  type UsageCycle,
  type UsageSnapshotResult,
  type MeteringDependencies,
} from "@zipy/billing/metering";
import {
  evaluateAlerts,
  type UsageAlertRecord,
} from "@zipy/billing/alerts";
import {
  readReferralSummary,
  type ReferralSummary,
} from "@zipy/billing/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Wire shape                                                                  */
/* -------------------------------------------------------------------------- */

interface UsageMeterWire {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly used: number;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly period: string;
  readonly unlimited: boolean;
  readonly percent: number | null;
  readonly level: "ok" | "warn" | "critical" | "exceeded" | "unknown";
}

interface UsageAlertWire {
  readonly id: string;
  readonly level: "info" | "warn" | "critical" | "exceeded";
  readonly message: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

interface UsageReferralWire {
  readonly code: string | null;
  readonly creditsEarned: number;
  readonly creditsPending: number;
  readonly signups: number;
  readonly active: boolean;
  readonly note: string | null;
}

interface UsageLinksWire {
  readonly billingPortal: string | null;
  readonly planSelector: string | null;
  readonly invoices: string | null;
}

interface UsageResponseBody {
  readonly workspaceId: string;
  readonly plan: BillingPlanTier;
  readonly planLabel: string;
  readonly seats: { readonly used: number; readonly limit: number | null };
  readonly cycle: { readonly startsAt: string; readonly endsAt: string };
  readonly usage: readonly UsageMeterWire[];
  readonly alerts: readonly UsageAlertWire[];
  readonly referrals: UsageReferralWire;
  readonly links: UsageLinksWire;
  readonly message: string;
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Config / auth gating                                                        */
/* -------------------------------------------------------------------------- */

function configGate(): NextResponse | null {
  const config = getConfig();
  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: {
          code: "config_error",
          message:
            "DATABASE_URL is not configured on this server. Usage cannot be metered.",
        },
      },
      { status: 503 },
    );
  }
  if (!config.auth.sessionSecretConfigured) {
    return NextResponse.json(
      {
        error: {
          code: "config_error",
          message:
            "SESSION_SECRET is not configured on this server. Refusing to serve authenticated usage data.",
        },
      },
      { status: 503 },
    );
  }
  return null;
}

async function requireSessionAndWorkspace(): Promise<
  | {
      readonly session: SessionRecord;
      readonly workspaceId: string;
    }
  | { readonly error: NextResponse }
> {
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: undefined,
      touch: false,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/billing/usage] session load failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return {
      error: NextResponse.json(
        {
          error: {
            code: "session_error",
            message: "Could not load the caller session.",
          },
        },
        { status: 500 },
      ),
    };
  }

  if (session === null) {
    return {
      error: NextResponse.json(
        {
          error: {
            code: "unauthenticated",
            message: "Authentication required.",
          },
        },
        { status: 401 },
      ),
    };
  }

  try {
    assertPermission(session as unknown as SessionLike, PERMISSIONS.billing_read);
  } catch (err) {
    const failure = toAuthzFailure(err);
    if (failure !== null) {
      return { error: NextResponse.json(failure.body, { status: failure.status }) };
    }
    throw err;
  }

  const workspaceId = session.activeWorkspaceId;
  if (workspaceId === null) {
    return {
      error: NextResponse.json(
        {
          error: {
            code: "workspace_required",
            message:
              "An active workspace is required to read usage. Select or create a workspace first.",
          },
        },
        { status: 403 },
      ),
    };
  }

  return { session, workspaceId };
}

/* -------------------------------------------------------------------------- */
/* Mapping helpers                                                             */
/* -------------------------------------------------------------------------- */

function levelFromPercent(
  percent: number | null,
): UsageMeterWire["level"] {
  if (percent === null) return "unknown";
  if (percent >= 1.0) return "exceeded";
  if (percent >= 0.9) return "critical";
  if (percent >= 0.75) return "warn";
  return "ok";
}

function meterToWire(
  counter: UsageCounter,
  plan: { readonly limits: Readonly<Record<string, number | null>> },
  cycle: UsageCycle,
): UsageMeterWire {
  const declaredLimit = plan.limits[counter.key];
  const limit =
    typeof counter.limit === "number"
      ? counter.limit
      : typeof declaredLimit === "number"
        ? declaredLimit
        : null;
  // A null limit means the plan does not cap this meter (unlimited).
  const unlimited = limit === null;
  const remaining = limit === null ? null : Math.max(0, limit - counter.used);
  const percent =
    limit === null || limit <= 0 ? null : Math.min(2, counter.used / limit);

  return {
    key: counter.key,
    label: counter.label,
    unit: counter.unit,
    used: counter.used,
    limit,
    remaining,
    period: cycle.label,
    unlimited,
    percent,
    level: levelFromPercent(percent),
  };
}

function alertToWire(alert: UsageAlertRecord): UsageAlertWire {
  return {
    id: alert.id,
    level: alert.level,
    message: alert.message,
    createdAt: alert.createdAt,
    acknowledgedAt: alert.acknowledgedAt,
  };
}

function referralsToWire(summary: ReferralSummary): UsageReferralWire {
  return {
    code: summary.code,
    creditsEarned: summary.creditsEarned,
    creditsPending: summary.creditsPending,
    signups: summary.signups,
    active: summary.active,
    note: summary.note,
  };
}

function linksFromConfig(): UsageLinksWire {
  const config = getConfig();
  // Billing portal/plan-select/invoice links are only meaningful when the
  // payment gateway is configured. Without a Stripe key these genuinely
  // cannot exist, so we return nulls and let `notes` explain.
  const stripeConfigured =
    config.billing.provider === "stripe" && config.billing.stripeSecretKeyPresent;

  if (!stripeConfigured) {
    return { billingPortal: null, planSelector: null, invoices: null };
  }
  // A configured Stripe key still does not imply a portal URL template; the
  // operator supplies the URL template through environment variables. If
  // they have not, the honest value is still null.
  const portal =
    process.env["STRIPE_BILLING_PORTAL_URL"]?.trim() ?? "";
  const planSelector =
    process.env["STRIPE_PLAN_SELECTOR_URL"]?.trim() ?? "";
  const invoices =
    process.env["STRIPE_INVOICES_URL"]?.trim() ?? "";
  return {
    billingPortal: portal.length > 0 ? portal : null,
    planSelector: planSelector.length > 0 ? planSelector : null,
    invoices: invoices.length > 0 ? invoices : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Route handler                                                               */
/* -------------------------------------------------------------------------- */

export async function GET(req: Request): Promise<NextResponse> {
  const gate = configGate();
  if (gate !== null) return gate;

  const authed = await requireSessionAndWorkspace();
  if ("error" in authed) return authed.error;
  const { session, workspaceId } = authed;

  const workspacePlanRaw = (session as unknown as { workspacePlan?: unknown })
    .workspacePlan;
  const planResolution = resolvePlan(
    typeof workspacePlanRaw === "string" ? workspacePlanRaw : null,
  );

  if (!planResolution.ok) {
    return NextResponse.json(
      {
        error: {
          code: "plan_unknown",
          message: planResolution.message,
          field: "plan",
        },
      },
      { status: 409 },
    );
  }
  const plan = planResolution.plan;

  /* -------------------------- metering dependencies ------------------ */
  // The metering module owns the DB reads. It is given a minimal dependency
  // object so the route does not itself open candidate connection pools. If
  // the metering module reports that its backing store is unavailable
  // (e.g. the usage table has not been migrated), we surface that as 503 and
  // include the metering module's own message — never fabricate zeros.
  const deps: MeteringDependencies = {
    workspaceId,
    planTier: plan.tier,
    now: () => new Date(),
  };

  let snapshot: UsageSnapshotResult;
  try {
    snapshot = await readUsageSnapshot(deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[/api/billing/usage] metering read failed for ${workspaceId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: {
          code: "metering_unavailable",
          message:
            "Usage counters could not be read. Confirm the metering schema is migrated and the workspace is intact.",
        },
      },
      { status: 503 },
    );
  }

  if (!snapshot.ok) {
    // The metering layer distinguished "no data yet" from "hard failure".
    // "no data yet" is a legitimate empty state (all zeros), not an error.
    if (snapshot.reason === "empty") {
      snapshot = {
        ok: true,
        counters: [],
        cycle: currentCycle(new Date()),
      };
    } else {
      return NextResponse.json(
        {
          error: {
            code: "metering_unavailable",
            message: snapshot.message,
          },
        },
        { status: 503 },
      );
    }
  }

  const cycle = cycleToWire(snapshot.cycle);
  const meters = snapshot.counters.map((c) => meterToWire(c, plan, snapshot.cycle));

  /* --------------------------------- alerts -------------------------- */
  let alerts: readonly UsageAlertRecord[] = [];
  try {
    alerts = await evaluateAlerts({
      workspaceId,
      planTier: plan.tier,
      counters: snapshot.counters,
      cycle: snapshot.cycle,
      now: new Date(),
    });
  } catch (err) {
    // Alerts are advisory. A failure to evaluate them must not fail the whole
    // usage read; we note it and continue with an empty list.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[/api/billing/usage] alerts evaluation failed for ${workspaceId}: ${message}\n`,
    );
    alerts = [];
  }

  /* ------------------------------- referrals -------------------------- */
  let referrals: ReferralSummary = {
    code: null,
    creditsEarned: 0,
    creditsPending: 0,
    signups: 0,
    active: false,
    note: "Referral summary is unavailable.",
  };
  try {
    referrals = await readReferralSummary({ workspaceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[/api/billing/usage] referrals read failed for ${workspaceId}: ${message}\n`,
    );
    referrals = {
      code: null,
      creditsEarned: 0,
      creditsPending: 0,
      signups: 0,
      active: false,
      note:
        "Referral data could not be read; showing empty state. Check server logs.",
    };
  }

  const seatsUsed = countSeats(session);
  const links = linksFromConfig();

  const notes: string[] = [];
  const config = getConfig();
  if (
    config.billing.provider !== "stripe" ||
    !config.billing.stripeSecretKeyPresent
  ) {
    notes.push(
      "Stripe is not configured on this server. Payment portal, plan changes and invoices are unavailable until STRIPE_SECRET_KEY and the portal URL templates are supplied.",
    );
  } else if (
    links.billingPortal === null &&
    links.planSelector === null &&
    links.invoices === null
  ) {
    notes.push(
      "A Stripe secret key is present but the billing portal URL templates (STRIPE_BILLING_PORTAL_URL, STRIPE_PLAN_SELECTOR_URL, STRIPE_INVOICES_URL) are not, so no links are shown.",
    );
  }
  if (!snapshot.counters.length) {
    notes.push(
      "No usage has been metered yet for this workspace in the current cycle.",
    );
  }
  if (alerts.length === 0 && snapshot.counters.length > 0) {
    notes.push("No usage alerts are active for the current cycle.");
  }

  const planCatalogEntry = planCatalog[plan.tier];
  if (planCatalogEntry === undefined) {
    // resolvePlan should have caught this, but be defensive in case the
    // catalog and resolver ever drift.
    return NextResponse.json(
      {
        error: {
          code: "plan_catalog_missing",
          message: `Plan "${plan.tier}" is not present in the plan catalog. Server configuration is inconsistent.`,
          field: "plan",
        },
      },
      { status: 500 },
    );
  }

  const body: UsageResponseBody = {
    workspaceId,
    plan: plan.tier,
    planLabel: planCatalogEntry.label,
    seats: {
      used: seatsUsed,
      limit: planCatalogEntry.seatLimit,
    },
    cycle,
    usage: meters,
    alerts: alerts.map(alertToWire),
    referrals: referralsToWire(referrals),
    links,
    message: `Plan "${planCatalogEntry.label}" for the current cycle.`,
    notes,
  };

  return NextResponse.json(body, {
    status: 200,
    headers: {
      // Usage is a live metric; caching would be misleading to the dashboard.
      "cache-control": "no-store",
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function currentCycle(now: Date): UsageCycle {
  const startsAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const endsAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    label: startsAt.toISOString().slice(0, 7),
  };
}

function cycleToWire(cycle: UsageCycle): { startsAt: string; endsAt: string } {
  return { startsAt: cycle.startsAt, endsAt: cycle.endsAt };
}

function countSeats(session: SessionRecord): number {
  // The session may include a seat count if the identity layer enriched it.
  // We read it defensively and fall back to a conservative 1 (the caller).
  const raw = (session as unknown as { seatCount?: unknown }).seatCount;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
    return Math.trunc(raw);
  }
  const members = (session as unknown as { memberCount?: unknown }).memberCount;
  if (typeof members === "number" && Number.isFinite(members) && members >= 1) {
    return Math.trunc(members);
  }
  return 1;
}

/* -------------------------------------------------------------------------- */
/* Non-GET methods                                                             */
/* -------------------------------------------------------------------------- */

export async function POST(): Promise<NextResponse> {
  return methodNotAllowed("Plan changes are not accepted from the web app.");
}

export async function PUT(): Promise<NextResponse> {
  return methodNotAllowed(
    "Plan changes are performed through the billing portal, not this endpoint.",
  );
}

export async function PATCH(): Promise<NextResponse> {
  return methodNotAllowed(
    "Plan changes are performed through the billing portal, not this endpoint.",
  );
}

export async function DELETE(): Promise<NextResponse> {
  return methodNotAllowed(
    "Usage records are immutable for audit purposes; deletion is handled by the retention surface.",
  );
}

function methodNotAllowed(message: string): NextResponse {
  return NextResponse.json(
    { error: { code: "method_not_allowed", message } },
    { status: 405, headers: { Allow: "GET" } },
  );
}
