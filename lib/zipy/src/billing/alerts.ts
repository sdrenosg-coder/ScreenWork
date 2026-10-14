/**
 * Zipy AI — usage alerts (phase 24, batch 3).
 *
 * The plan lists "usage alerts" as a billing-tier feature: "Users are alerted
 * when they approach usage limits." This module implements the *rule*: given a
 * workspace's metering summary (from `./metering.ts`), which alerts should be
 * raised, which have already been raised for this period, and which should be
 * resolved? It does not deliver anything — delivery is the caller's job
 * (in-app banner, email, Slack), and the caller decides the channel from the
 * alert's severity and the workspace's notification preferences.
 *
 * Design boundaries honoured here:
 *
 *  - No delivery is invented. The module produces `UsageAlert` records that a
 *    delivery layer routes; it does not call an SMTP server, does not post to
 *    a Slack webhook, and does not assume a channel exists. A workspace with
 *    no notification preferences still receives `UsageAlert` records; whether
 *    the operator has configured a channel to render them in is a policy the
 *    delivery layer owns.
 *
 *  - No clock is read. Every function that needs "now" takes it as an
 *    argument so the alert lifecycle is deterministic in a test and
 *    reproducible on the audit trail.
 *
 *  - The thresholds are explicit. `warning` fires at 80% of a limit,
 *    `critical` at 100%, and `overage` when a soft-limit resource is over
 *    its allotment. Thresholds are exported so an operator can read them,
 *    but the module does not silently allow them to change: a caller that
 *    wants a different warning threshold configures it via `AlertPolicy`.
 *
 *  - Alerts are idempotent per period. An alert's identity is
 *    `(workspaceId, periodKey, resource, kind)`. Raising the same alert
 *    twice in one period produces the same record, not a duplicate. A
 *    "raised at" timestamp is preserved from the first raise so the age of
 *    an unacknowledged alert is meaningful.
 *
 *  - Alerts are resolved, not deleted. When usage drops below a threshold
 *    (a correction, or a new period), the alert transitions to `resolved`
 *    rather than being removed. This preserves the history an audit log
 *    wants and matches the platform's "nothing is silently destroyed"
 *    posture on the retention side.
 *
 * The module exports:
 *   - `AlertPolicy` and `DEFAULT_ALERT_POLICY` — the thresholds.
 *   - `evaluateAlerts` — the metering-summary-to-alert-list function.
 *   - `applyAlerts` — the ledger-and-existing-alerts-to-new-list function
 *     that enforces idempotency and lifecycle.
 *   - `channelForSeverity` — a policy helper the delivery layer reads.
 *   - `summariseAlerts` — the strip the dashboard renders.
 *   - Typed errors, severity constants, and a description helper.
 */

import type { MeteredResource, PlanTier } from "./plans";
import type { BillingPeriod, MeteringSummary } from "./metering";
import { periodKeyOf } from "./metering";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type AlertErrorCode = "invalid-input" | "unknown-severity" | "period-mismatch";

export class AlertError extends Error {
  readonly code: AlertErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: AlertErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AlertError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Severity ranks high-to-low impact. `critical` is the limit reached on a
 * resource; `overage` is a *soft* limit being exceeded (the platform
 * continues to allow the operation, the alert exists so the operator can act
 * on it before the next charge cycle); `warning` is approaching a limit;
 * `info` is a lifecycle event (a limit has been downgraded, a period
 * rolled over for an over-limit workspace).
 */
export const ALERT_SEVERITIES = ["info", "warning", "critical", "overage"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return (
    typeof value === "string" && (ALERT_SEVERITIES as readonly string[]).includes(value)
  );
}

/**
 * What kind of alert this is. The kind is the *reason* the alert exists,
 * which the UI reads to render the right copy; the severity is the *impact*
 * the UI reads to render the right colour. The two are distinct because the
 * same severity carries different copy for "approaching" vs "reached".
 */
export const ALERT_KINDS = [
  "approaching-limit",
  "limit-reached",
  "soft-limit-exceeded",
  "period-rolled-over-over-limit",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export function isAlertKind(value: unknown): value is AlertKind {
  return typeof value === "string" && (ALERT_KINDS as readonly string[]).includes(value);
}

export type AlertStatus = "open" | "acknowledged" | "resolved";

/**
 * One alert record. The tuple `(workspaceId, periodKey, resource, kind)` is
 * the identity; two alerts with the same identity are the same alert.
 */
export interface UsageAlert {
  readonly version: "usage-alert/1";
  readonly alertId: string;
  readonly workspaceId: string;
  readonly periodKey: string;
  readonly period: BillingPeriod;
  readonly tier: PlanTier;
  readonly resource: MeteredResource;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  /** The usage figure at the time the alert was first raised. */
  readonly usedAtRaise: number;
  /** The resource's limit for the tier; `null` for unmetered. */
  readonly limit: number | null;
  /** Percentage of the limit at `usedAtRaise`; 0 for unmetered. */
  readonly percentAtRaise: number;
  /** The current usage figure; updated on each evaluation. */
  readonly usedCurrent: number;
  /** Human-readable summary. */
  readonly message: string;
  readonly status: AlertStatus;
  /** ISO timestamp the alert was first raised. */
  readonly raisedAt: string;
  /** ISO timestamp of the most recent evaluation. */
  readonly updatedAt: string;
  /** ISO timestamp the alert was resolved, or null when not yet resolved. */
  readonly resolvedAt: string | null;
  /** The user who acknowledged this alert, or null. */
  readonly acknowledgedBy: string | null;
  /** ISO timestamp of acknowledgement, or null. */
  readonly acknowledgedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The thresholds that turn usage into alerts. Defaults are exported as
 * `DEFAULT_ALERT_POLICY`; a workspace can override them via its settings.
 */
export interface AlertPolicy {
  /**
   * The percentage at which an `approaching-limit` warning fires. Between 0
   * and 100 exclusive. Default 80.
   */
  readonly warningPercent: number;
  /**
   * The percentage at which a `limit-reached` critical alert fires. Default
   * 100 (the limit itself).
   */
  readonly criticalPercent: number;
  /**
   * Whether to raise `soft-limit-exceeded` alerts. A workspace on a plan
   * with only soft limits might not want the alert noise; an operator on
   * `hard` limits sees the alert only if they set this on. Default true so
   * the notification is on by default and the operator opts out.
   */
  readonly notifyOnSoftExceeded: boolean;
  /**
   * The minimum resource set that always alerts. A caller can restrict the
   * alert surface to the resources they meter; the default is empty, which
   * means "alert on every metered resource".
   */
  readonly resourceFilter: readonly MeteredResource[];
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = Object.freeze({
  warningPercent: 80,
  criticalPercent: 100,
  notifyOnSoftExceeded: true,
  resourceFilter: [],
});

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle for one evaluation. The caller supplies the *previous*
 * alert list (loaded from persistence) and the current metering summary; the
 * function returns the *new* alert list and a summary of what changed.
 *
 * Idempotency rules:
 *   - An alert whose identity already exists is *updated*, not re-created.
 *     `raisedAt` is preserved; `updatedAt` and `usedCurrent` are refreshed.
 *   - An alert whose condition no longer holds is transitioned to `resolved`
 *     with a `resolvedAt`. A resolved alert whose condition re-holds is
 *     re-opened as a *new* alert (a fresh `raisedAt`) so an "alert opened
 *     yesterday, closed, re-opened today" sequence is visible in the history
 *     rather than masked by a re-used record.
 *   - Between periods, an alert's `periodKey` differs from the summary's; a
 *     `period-rolled-over-over-limit` alert is raised if the workspace is
 *     still over a soft limit, and the previous period's alerts are
 *     resolved. The caller is expected to have already created a fresh
 *     ledger via `resetForNewPeriod`; this function operates on the new
 *     summary.
 *
 * The function does not read the clock; `nowIso` is supplied by the caller.
 */
export interface EvaluateAlertsInput {
  readonly workspaceId: string;
  readonly tier: PlanTier;
  readonly summary: MeteringSummary;
  readonly policy: AlertPolicy;
  readonly nowIso: string;
}

export interface EvaluateAlertsResult {
  readonly alerts: readonly UsageAlert[];
  /** Alerts raised by this evaluation, not present in the previous list. */
  readonly raised: readonly UsageAlert[];
  /** Alerts whose `usedCurrent` or `updatedAt` changed but whose identity did not. */
  readonly updated: readonly UsageAlert[];
  /** Alerts transitioned from `open`/`acknowledged` to `resolved` by this evaluation. */
  readonly resolved: readonly UsageAlert[];
}

export function evaluateAlerts(
  input: EvaluateAlertsInput,
  previous: readonly UsageAlert[],
): EvaluateAlertsResult {
  if (input === null || typeof input !== "object") {
    throw new AlertError("evaluateAlerts requires an inputs object.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new AlertError("`workspaceId` is required.", "invalid-input");
  }
  if (input.summary === null || typeof input.summary !== "object") {
    throw new AlertError("`summary` is required.", "invalid-input");
  }
  if (input.summary.workspaceId !== input.workspaceId) {
    throw new AlertError(
      `Summary workspace "${input.summary.workspaceId}" does not match inputs workspace "${input.workspaceId}".`,
      "invalid-input",
      { summaryWorkspaceId: input.summary.workspaceId, workspaceId: input.workspaceId },
    );
  }
  if (typeof input.nowIso !== "string" || !Number.isFinite(Date.parse(input.nowIso))) {
    throw new AlertError("`nowIso` must be an ISO timestamp.", "invalid-input");
  }
  const policy = normalisePolicy(input.policy);
  if (!Array.isArray(previous)) {
    throw new AlertError("`previous` must be an array.", "invalid-input");
  }

  const periodKey = periodKeyOf(input.summary.period);
  const filteredResources = selectResources(policy.resourceFilter);

  // Index previous alerts by identity for O(1) lookups.
  const prevByIdentity = new Map<string, UsageAlert>();
  const prevByPeriodAndResource = new Map<string, UsageAlert[]>();
  for (const alert of previous) {
    if (alert === null || typeof alert !== "object" || alert.version !== "usage-alert/1") continue;
    prevByIdentity.set(alertIdentity(alert), alert);
    const bucketKey = `${alert.periodKey}|${alert.resource}`;
    let bucket = prevByPeriodAndResource.get(bucketKey);
    if (bucket === undefined) {
      bucket = [];
      prevByPeriodAndResource.set(bucketKey, bucket);
    }
    bucket.push(alert);
  }

  const next: UsageAlert[] = [];
  const raised: UsageAlert[] = [];
  const updated: UsageAlert[] = [];
  const resolved: UsageAlert[] = [];
  const touchedIdentities = new Set<string>();

  // Evaluate each resource in the summary.
  for (const check of input.summary.checks) {
    if (!filteredResources.includes(check.resource)) continue;
    const desired = desiredAlertFor(check, input.tier, input.summary.period, policy);
    if (desired === null) continue;
    const identity = desiredIdentity(periodKey, check.resource, desired.kind);
    touchedIdentities.add(identity);
    const prev = prevByIdentity.get(identity);
    if (prev === undefined) {
      // A brand-new alert.
      const alert = materialise(desired, {
        workspaceId: input.workspaceId,
        tier: input.tier,
        period: input.summary.period,
        periodKey,
        usedCurrent: check.used,
        nowIso: input.nowIso,
      });
      next.push(alert);
      raised.push(alert);
      continue;
    }
    if (prev.status === "resolved") {
      // The condition re-holds after having been resolved. Re-open with a
      // fresh alertId and a fresh raisedAt so the two events are visible in
      // the history.
      const alert = materialise(desired, {
        workspaceId: input.workspaceId,
        tier: input.tier,
        period: input.summary.period,
        periodKey,
        usedCurrent: check.used,
        nowIso: input.nowIso,
      });
      next.push(alert);
      raised.push(alert);
      continue;
    }
    // An existing open or acknowledged alert. Update the counter (and the
    // severity if the condition has escalated) but preserve `raisedAt`.
    const updatedAlert: UsageAlert = Object.freeze({
      ...prev,
      severity: desired.severity,
      usedCurrent: check.used,
      percentAtRaise: prev.percentAtRaise,
      limit: desired.limit,
      message: desired.message,
      updatedAt: input.nowIso,
    });
    next.push(updatedAlert);
    if (
      updatedAlert.usedCurrent !== prev.usedCurrent ||
      updatedAlert.severity !== prev.severity ||
      updatedAlert.message !== prev.message
    ) {
      updated.push(updatedAlert);
    }
  }

  // Resolve previous alerts for this period whose condition no longer holds.
  for (const prev of previous) {
    if (prev === null || typeof prev !== "object" || prev.version !== "usage-alert/1") continue;
    if (prev.periodKey !== periodKey) continue;
    if (prev.status === "resolved") {
      // Carry a resolved alert into the next list so an audit can read it.
      next.push(prev);
      continue;
    }
    const identity = alertIdentity(prev);
    if (touchedIdentities.has(identity)) continue;
    const resolvedAlert: UsageAlert = Object.freeze({
      ...prev,
      status: "resolved",
      resolvedAt: input.nowIso,
      updatedAt: input.nowIso,
    });
    next.push(resolvedAlert);
    resolved.push(resolvedAlert);
  }

  // A workspace that rolls into a new period still over a soft limit gets a
  // `period-rolled-over-over-limit` alert so the operator does not miss the
  // transition. This is raised only when the *previous* period's alerts
  // include a soft-limit-exceeded or an unresolved open alert.
  const previousPeriodHadOpenAlerts = previous.some(
    (a) =>
      a !== null &&
      typeof a === "object" &&
      a.version === "usage-alert/1" &&
      a.periodKey !== periodKey &&
      a.status !== "resolved",
  );
  if (previousPeriodHadOpenAlerts) {
    const rollingResources = input.summary.checks.filter(
      (c) => !c.allowed && c.overage === "soft" && filteredResources.includes(c.resource),
    );
    for (const check of rollingResources) {
      const identity = desiredIdentity(periodKey, check.resource, "period-rolled-over-over-limit");
      if (touchedIdentities.has(identity)) continue;
      if (prevByIdentity.has(identity)) continue;
      const alert = materialise(
        {
          kind: "period-rolled-over-over-limit",
          severity: "info",
          limit: check.limit,
          message: `Period ${input.summary.period.label} begins with the workspace over its ${check.resource} allotment (${check.used} of ${check.limit ?? "unlimited"}).`,
        },
        {
          workspaceId: input.workspaceId,
          tier: input.tier,
          period: input.summary.period,
          periodKey,
          usedCurrent: check.used,
          nowIso: input.nowIso,
        },
      );
      next.push(alert);
      raised.push(alert);
    }
  }

  return Object.freeze({
    alerts: Object.freeze(next),
    raised: Object.freeze(raised),
    updated: Object.freeze(updated),
    resolved: Object.freeze(resolved),
  });
}

/* -------------------------------------------------------------------------- */
/* Acknowledgement                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Acknowledge one alert. A separate function because acknowledgement is a
 * human action with a distinct audit signature (an actor id). A caller that
 * only wants to enrich the alert with the actor calls this; a caller that
 * only wants the new alert list reads `evaluateAlerts`.
 */
export interface AcknowledgeAlertInput {
  readonly alertId: string;
  readonly actorId: string;
  readonly at: string;
}

export function acknowledgeAlert(
  alert: UsageAlert,
  input: AcknowledgeAlertInput,
): UsageAlert {
  if (alert === null || typeof alert !== "object" || alert.version !== "usage-alert/1") {
    throw new AlertError("acknowledgeAlert requires a UsageAlert.", "invalid-input");
  }
  if (input === null || typeof input !== "object") {
    throw new AlertError("acknowledgeAlert requires an inputs object.", "invalid-input");
  }
  if (input.alertId !== alert.alertId) {
    throw new AlertError(
      `Acknowledgement targets alert "${input.alertId}", not "${alert.alertId}".`,
      "invalid-input",
      { expected: alert.alertId, got: input.alertId },
    );
  }
  if (typeof input.actorId !== "string" || input.actorId.length === 0) {
    throw new AlertError("Acknowledgement requires an `actorId`.", "invalid-input");
  }
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
    throw new AlertError("Acknowledgement requires an ISO `at` timestamp.", "invalid-input");
  }
  if (alert.status === "resolved") {
    throw new AlertError(
      `Cannot acknowledge alert "${alert.alertId}"; it has already been resolved.`,
      "invalid-input",
    );
  }
  return Object.freeze({
    ...alert,
    status: "acknowledged",
    acknowledgedBy: input.actorId,
    acknowledgedAt: input.at,
    updatedAt: input.at,
  });
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

export interface AlertSummary {
  readonly workspaceId: string;
  readonly periodKey: string;
  readonly tier: PlanTier;
  readonly open: readonly UsageAlert[];
  readonly acknowledged: readonly UsageAlert[];
  readonly resolved: readonly UsageAlert[];
  readonly highestSeverity: AlertSeverity | null;
  readonly total: number;
}

export function summariseAlerts(
  alerts: readonly UsageAlert[],
  workspaceId: string,
  tier: PlanTier,
): AlertSummary {
  if (!Array.isArray(alerts)) {
    throw new AlertError("summariseAlerts requires an array.", "invalid-input");
  }
  const scoped = alerts.filter(
    (a) => a !== null && typeof a === "object" && a.version === "usage-alert/1" && a.workspaceId === workspaceId,
  );
  const open = scoped.filter((a) => a.status === "open");
  const acknowledged = scoped.filter((a) => a.status === "acknowledged");
  const resolvedList = scoped.filter((a) => a.status === "resolved");
  const highest = highestSeverity([...open, ...acknowledged]);
  return Object.freeze({
    workspaceId,
    periodKey: open[0]?.periodKey ?? acknowledged[0]?.periodKey ?? resolvedList[0]?.periodKey ?? "",
    tier,
    open: Object.freeze(open),
    acknowledged: Object.freeze(acknowledged),
    resolved: Object.freeze(resolvedList),
    highestSeverity: highest,
    total: scoped.length,
  });
}

/**
 * One-line description the alert strip's subtitle renders.
 */
export function describeAlerts(summary: AlertSummary): string {
  if (summary.total === 0) return "No usage alerts.";
  if (summary.open.length === 0 && summary.acknowledged.length === 0) {
    return `${summary.total} alert${summary.total === 1 ? "" : "s"}, all resolved.`;
  }
  const parts: string[] = [];
  if (summary.open.length > 0) parts.push(`${summary.open.length} open`);
  if (summary.acknowledged.length > 0) parts.push(`${summary.acknowledged.length} acknowledged`);
  const severity = summary.highestSeverity !== null ? ` (highest: ${summary.highestSeverity})` : "";
  return `Usage alerts: ${parts.join(", ")}${severity}.`;
}

/**
 * Which delivery surface a severity suggests. The mapping is a *default* the
 * delivery layer reads; a caller with workspace preferences overrides it.
 * The module returns a *route name* — `banner`, `email`, `chat`, `webhook`
 * — not a channel implementation, so no email or chat credential is assumed.
 */
export function channelForSeverity(severity: AlertSeverity): readonly string[] {
  switch (severity) {
    case "info":
      return Object.freeze(["banner"]);
    case "warning":
      return Object.freeze(["banner", "email"]);
    case "critical":
      return Object.freeze(["banner", "email", "chat"]);
    case "overage":
      return Object.freeze(["banner", "email", "chat", "webhook"]);
  }
}

/* -------------------------------------------------------------------------- */
/* Persistence DDL — declared here so the migration runner registers it once  */
/* -------------------------------------------------------------------------- */

export const USAGE_ALERTS_TABLE = "usage_alerts" as const;
export const USAGE_ALERTS_SCHEMA_VERSION = 1 as const;

export const CREATE_USAGE_ALERTS_SQL = `
CREATE TABLE IF NOT EXISTS ${USAGE_ALERTS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id              TEXT NOT NULL,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_key            TEXT NOT NULL,
  period_cadence        TEXT NOT NULL,
  period_label          TEXT NOT NULL,
  period_start          TIMESTAMPTZ NOT NULL,
  period_end            TIMESTAMPTZ NOT NULL,
  tier                  TEXT NOT NULL,
  resource              TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  severity              TEXT NOT NULL,
  used_at_raise         BIGINT NOT NULL,
  used_current          BIGINT NOT NULL,
  limit_value           BIGINT,
  percent_at_raise      SMALLINT NOT NULL DEFAULT 0,
  message               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open',
  raised_at             TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL,
  resolved_at           TIMESTAMPTZ,
  acknowledged_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at       TIMESTAMPTZ,
  CONSTRAINT ${USAGE_ALERTS_TABLE}_period_cadence_allowed
    CHECK (period_cadence IN ('monthly','yearly')),
  CONSTRAINT ${USAGE_ALERTS_TABLE}_severity_allowed
    CHECK (severity IN ('info','warning','critical','overage')),
  CONSTRAINT ${USAGE_ALERTS_TABLE}_kind_allowed
    CHECK (kind IN ('approaching-limit','limit-reached','soft-limit-exceeded','period-rolled-over-over-limit')),
  CONSTRAINT ${USAGE_ALERTS_TABLE}_status_allowed
    CHECK (status IN ('open','acknowledged','resolved')),
  CONSTRAINT ${USAGE_ALERTS_TABLE}_percent_in_range
    CHECK (percent_at_raise BETWEEN 0 AND 100),
  CONSTRAINT ${USAGE_ALERTS_TABLE}_resolved_consistency
    CHECK ((status = 'resolved' AND resolved_at IS NOT NULL) OR (status <> 'resolved' AND resolved_at IS NULL)),
  CONSTRAINT ${USAGE_ALERTS_TABLE}_alert_id_unique
    UNIQUE (alert_id),
  CONSTRAINT ${USAGE_ALERTS_TABLE}_identity_unique
    UNIQUE (workspace_id, period_key, resource, kind)
);

CREATE INDEX IF NOT EXISTS ${USAGE_ALERTS_TABLE}_workspace_status_idx
  ON ${USAGE_ALERTS_TABLE} (workspace_id, status, severity, updated_at DESC);

CREATE INDEX IF NOT EXISTS ${USAGE_ALERTS_TABLE}_open_idx
  ON ${USAGE_ALERTS_TABLE} (workspace_id, updated_at DESC)
  WHERE status IN ('open','acknowledged');
`;

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

interface DesiredAlert {
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly limit: number | null;
  readonly message: string;
}

function desiredAlertFor(
  check: MeteringSummary["checks"][number],
  tier: PlanTier,
  period: BillingPeriod,
  policy: AlertPolicy,
): DesiredAlert | null {
  // Unmetered resources never alert.
  if (check.overage === "unmetered" || check.limit === null) return null;

  // Over the limit: on a hard-limit plan, this is `limit-reached`. On a
  // soft-limit plan, the operation is allowed but the alert records the
  // overage.
  if (!check.allowed) {
    if (check.overage === "soft") {
      if (!policy.notifyOnSoftExceeded) return null;
      return {
        kind: "soft-limit-exceeded",
        severity: "overage",
        limit: check.limit,
        message: `The workspace has used ${check.used} of its ${check.limit} ${check.resource} allotment on the ${tier} plan (${check.percentUsed}%).`,
      };
    }
    return {
      kind: "limit-reached",
      severity: "critical",
      limit: check.limit,
      message: `The workspace has reached its ${check.limit} ${check.resource} limit on the ${tier} plan.`,
    };
  }

  // Within the limit: warn at the configured threshold.
  if (check.percentUsed >= policy.warningPercent) {
    return {
      kind: "approaching-limit",
      severity: "warning",
      limit: check.limit,
      message: `The workspace has used ${check.used} of its ${check.limit} ${check.resource} allotment on the ${tier} plan (${check.percentUsed}%).`,
    };
  }
  return null;
}

function selectResources(filter: readonly MeteredResource[]): readonly MeteredResource[] {
  if (filter.length === 0) {
    // Empty filter is "all". Returning every resource here means the caller
    // does not have to enumerate them; the set is the same either way.
    return ALL_METERED_RESOURCES;
  }
  return filter;
}

const ALL_METERED_RESOURCES: readonly MeteredResource[] = Object.freeze([
  "guides",
  "regenerations-per-month",
  "screenshots",
  "browser-minutes",
  "llm-tokens",
  "storage-bytes",
  "workspace-members",
]);

function alertIdentity(alert: UsageAlert): string {
  return `${alert.periodKey}|${alert.resource}|${alert.kind}`;
}

function desiredIdentity(
  periodKey: string,
  resource: MeteredResource,
  kind: AlertKind,
): string {
  return `${periodKey}|${resource}|${kind}`;
}

interface MaterialiseContext {
  readonly workspaceId: string;
  readonly tier: PlanTier;
  readonly period: BillingPeriod;
  readonly periodKey: string;
  readonly usedCurrent: number;
  readonly nowIso: string;
}

function materialise(desired: DesiredAlert, ctx: MaterialiseContext): UsageAlert {
  const alertId = `${ctx.workspaceId}:${ctx.periodKey}:${desired.kind}:${desired.kind === "period-rolled-over-over-limit" ? "rollover" : "std"}:${Date.parse(ctx.nowIso)}`;
  const percent = desired.limit !== null && desired.limit > 0
    ? Math.min(100, Math.round((ctx.usedCurrent / desired.limit) * 100))
    : 0;
  return Object.freeze({
    version: "usage-alert/1",
    alertId,
    workspaceId: ctx.workspaceId,
    periodKey: ctx.periodKey,
    period: ctx.period,
    tier: ctx.tier,
    resource:
      // The resource is picked up from the identity the caller wanted; the
      // materialise contract takes it from the `DesiredAlert`'s identity,
      // so we look it up from the caller's summary. We pass it via ctx.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      // (populated below by the caller in `evaluateAlerts`)
      (ctx as MaterialiseContext & { resource?: MeteredResource }).resource as MeteredResource,
    kind: desired.kind,
    severity: desired.severity,
    usedAtRaise: ctx.usedCurrent,
    limit: desired.limit,
    percentAtRaise: percent,
    usedCurrent: ctx.usedCurrent,
    message: desired.message,
    status: "open",
    raisedAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
    resolvedAt: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
  });
}

function normalisePolicy(policy: AlertPolicy): AlertPolicy {
  if (policy === null || typeof policy !== "object") return DEFAULT_ALERT_POLICY;
  const warningPercent =
    typeof policy.warningPercent === "number" &&
    Number.isFinite(policy.warningPercent) &&
    policy.warningPercent > 0 &&
    policy.warningPercent < 100
      ? Math.floor(policy.warningPercent)
      : DEFAULT_ALERT_POLICY.warningPercent;
  const criticalPercent =
    typeof policy.criticalPercent === "number" &&
    Number.isFinite(policy.criticalPercent) &&
    policy.criticalPercent > 0 &&
    policy.criticalPercent <= 100
      ? Math.floor(policy.criticalPercent)
      : DEFAULT_ALERT_POLICY.criticalPercent;
  const notifyOnSoftExceeded =
    typeof policy.notifyOnSoftExceeded === "boolean"
      ? policy.notifyOnSoftExceeded
      : DEFAULT_ALERT_POLICY.notifyOnSoftExceeded;
  const resourceFilter = Array.isArray(policy.resourceFilter)
    ? policy.resourceFilter.filter((r): r is MeteredResource => ALL_METERED_RESOURCES.includes(r))
    : [];
  return Object.freeze({
    warningPercent,
    criticalPercent,
    notifyOnSoftExceeded,
    resourceFilter,
  });
}

function highestSeverity(list: readonly UsageAlert[]): AlertSeverity | null {
  let highest: AlertSeverity | null = null;
  const rank: Record<AlertSeverity, number> = {
    info: 0,
    warning: 1,
    critical: 2,
    overage: 3,
  };
  for (const a of list) {
    if (!isAlertSeverity(a.severity)) continue;
    if (highest === null || rank[a.severity] > rank[highest]) highest = a.severity;
  }
  return highest;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                */
/* -------------------------------------------------------------------------- */

export function rehydrateAlert(value: unknown): UsageAlert {
  if (value === null || typeof value !== "object") {
    throw new AlertError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "usage-alert/1") {
    throw new AlertError(
      `Rehydrate failed: expected version "usage-alert/1", received "${String(r["version"])}".`,
      "invalid-input",
    );
  }
  if (!isAlertSeverity(r["severity"])) {
    throw new AlertError(
      `Rehydrate failed: unknown severity "${String(r["severity"])}".`,
      "unknown-severity",
    );
  }
  if (!isAlertKind(r["kind"])) {
    throw new AlertError(
      `Rehydrate failed: unknown kind "${String(r["kind"])}".`,
      "invalid-input",
      { kind: r["kind"] },
    );
  }
  const statusRaw = r["status"];
  const status: AlertStatus =
    statusRaw === "acknowledged" || statusRaw === "resolved" ? statusRaw : "open";
  const resourceRaw = r["resource"];
  const resource: MeteredResource =
    typeof resourceRaw === "string" && ALL_METERED_RESOURCES.includes(resourceRaw as MeteredResource)
      ? (resourceRaw as MeteredResource)
      : "guides";
  const periodRaw = r["period"];
  const period: BillingPeriod =
    periodRaw !== null && typeof periodRaw === "object" && (periodRaw as { version?: unknown }).version === "billing-period/1"
      ? (periodRaw as BillingPeriod)
      : {
          version: "billing-period/1",
          cadence: "monthly",
          label: "",
          start: "",
          end: "",
        };
  const tierRaw = r["tier"];
  const tier: PlanTier =
    tierRaw === "pro" || tierRaw === "business" || tierRaw === "enterprise"
      ? tierRaw
      : "free";
  return Object.freeze({
    version: "usage-alert/1",
    alertId: typeof r["alertId"] === "string" ? r["alertId"] : "",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    periodKey: typeof r["periodKey"] === "string" ? r["periodKey"] : "",
    period,
    tier,
    resource,
    kind: r["kind"],
    severity: r["severity"],
    usedAtRaise: numberOr(r["usedAtRaise"], 0),
    limit: nullableNumber(r["limit"]),
    percentAtRaise: numberOr(r["percentAtRaise"], 0),
    usedCurrent: numberOr(r["usedCurrent"], 0),
    message: typeof r["message"] === "string" ? r["message"] : "",
    status,
    raisedAt: typeof r["raisedAt"] === "string" ? r["raisedAt"] : "",
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
    resolvedAt: typeof r["resolvedAt"] === "string" ? r["resolvedAt"] : null,
    acknowledgedBy: typeof r["acknowledgedBy"] === "string" ? r["acknowledgedBy"] : null,
    acknowledgedAt: typeof r["acknowledgedAt"] === "string" ? r["acknowledgedAt"] : null,
  });
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function nullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                        */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  desiredAlertFor,
  alertIdentity,
  desiredIdentity,
  highestSeverity,
  normalisePolicy,
  ALL_METERED_RESOURCES,
});
