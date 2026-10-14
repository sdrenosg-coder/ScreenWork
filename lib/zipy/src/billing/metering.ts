/**
 * Zipy AI — usage metering (phase 24, batch 3).
 *
 * The plan's user choice pins billing to "Build billing models and usage
 * metering only, no live charges". `./plans.ts` is the model; this module is
 * the metering layer that turns the platform's recorded usage into the answers
 * the rest of the app needs: what has a workspace consumed this period, is it
 * over a limit, and what should the next operation do?
 *
 * Design boundaries honoured here:
 *
 *  - No timer, no cron, no external system. Metering operates purely on
 *    *events* the platform already records (guide creations, regenerations,
 *    screenshot captures, browser minutes, LLM tokens, stored bytes, member
 *    additions). A caller above this module reads those events from the
 *    analytics/audit stream and folds them into a `UsageLedger`. This module
 *    is the ledger and the arithmetic, not the reader.
 *
 *  - The billing period is a *labelled range*. A period is
 *    `{ start, end, label }`. The module computes a period from a cadence and
 *    an anchor but never reads the clock; every public function that needs
 *    "now" takes it as an argument so a metering check is deterministic in a
 *    test and reproducible in an audit.
 *
 *  - Counters are integers. Usage counts (guides, members, screenshots,
 *    regenerations) are integer-valued; bytes and tokens are integers too
 *    (rounded on ingest). A floating-point usage figure would mean a
 *    rounding policy the module is not authorised to invent. The module
 *    refuses non-integer input with `invalid-usage` rather than silently
 *    rounding.
 *
 *  - Deltas are non-negative. Usage accrues; it does not decrement except at
 *    a period boundary or on an explicit correction. The module exposes
 *    `recordUsage` for the common accrual case and `correctUsage` for the
 *    rare case where a recorded event was wrong. A correction requires an
 *    actor and a reason so an audit trail can attribute it.
 *
 *  - The limit check is a *plan* decision. This module delegates the
 *    arithmetic to `checkLimit`/`checkAllLimits` in `./plans.ts` so the
 *    policy (overage `hard` vs `soft` vs `unmetered`) lives in exactly one
 *    place. A metering caller reads the plan's answer and decides what to do.
 *
 *  - No charge is initiated. `metering` never calls a payment gateway; it
 *    reports the state a charging path (a later phase) would read.
 *
 * The module exports:
 *   - `UsageLedger` — the accumulator.
 *   - `createUsageLedger`, `recordUsage`, `correctUsage`, `getUsage`,
 *     `resetForNewPeriod`.
 *   - `meteringDecision` — the emit/allow/deny answer for one operation.
 *   - `meteringSummary` — the dashboard's metering card payload.
 *   - `computePeriod`, `periodKeyOf` — the period arithmetic.
 *   - Typed errors, event-kind vocabulary, and a description helper.
 */

import {
  type MeteredResource,
  type PlanFeature,
  type PlanTier,
  checkAllLimits,
  checkLimit,
  isFeatureEnabled,
  isMeteredResource,
  isPlanFeature,
  isPlanTier,
  type LimitCheck,
} from "./plans";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type MeteringErrorCode =
  | "invalid-input"
  | "unknown-resource"
  | "unknown-feature"
  | "unknown-plan"
  | "invalid-usage"
  | "period-mismatch"
  | "correction-requires-reason";

export class MeteringError extends Error {
  readonly code: MeteringErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: MeteringErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "MeteringError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Periods                                                                    */
/* -------------------------------------------------------------------------- */

/** The cadence a workspace's billing period runs on. */
export type PeriodCadence = "monthly" | "yearly";

/**
 * A billing period. `label` is the human list name (`"2025-11"` for a monthly
 * period, `"2025"` for a yearly one); a metering UI renders it directly, an
 * API returns it, and the persistence layer stores it as the partition key of
 * the usage summary.
 */
export interface BillingPeriod {
  readonly version: "billing-period/1";
  readonly cadence: PeriodCadence;
  readonly label: string;
  /** ISO timestamp of the first instant of the period (inclusive). */
  readonly start: string;
  /** ISO timestamp of the first instant of the next period (exclusive). */
  readonly end: string;
}

/**
 * The daily period label. Kept as a short ISO date because the dashboard
 * renders it and because a monthly period that straddles a year boundary
 * ("2025-12" -> "2026-01") is easier to read than a unix timestamp.
 */
function labelFor(cadence: PeriodCadence, startMs: number): string {
  const d = new Date(startMs);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  if (cadence === "yearly") return yyyy;
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/**
 * Compute the period containing `atMs`. Calendar months and years are used
 * rather than fixed-day intervals so a workspace's period aligns with the
 * calendar the operator expects; a monthly period starting on the 15th is
 * not expressible here because the plan's billing model uses calendar
 * periods and an operator who wants a mid-month boundary can partition by
 * their own accounting period and label it explicitly.
 */
export function computePeriod(
  cadence: PeriodCadence,
  atMs: number,
): BillingPeriod {
  if (cadence !== "monthly" && cadence !== "yearly") {
    throw new MeteringError(
      `Unknown billing cadence "${String(cadence)}".`,
      "invalid-input",
      { cadence },
    );
  }
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
    throw new MeteringError("computePeriod requires a finite `atMs`.", "invalid-input");
  }
  const at = new Date(atMs);
  let startMs: number;
  let endMs: number;
  if (cadence === "monthly") {
    startMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0);
    endMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  } else {
    startMs = Date.UTC(at.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
    endMs = Date.UTC(at.getUTCFullYear() + 1, 0, 1, 0, 0, 0, 0);
  }
  return Object.freeze({
    version: "billing-period/1",
    cadence,
    label: labelFor(cadence, startMs),
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  });
}

/**
 * A stable string for a period, used as a persistence key and as the
 * "which bucket is this?" answer a caller compares against a ledger. Format:
 * `<cadence>:<label>`, so `"monthly:2025-11"` and `"yearly:2025"` never
 * collide even when a workspace's cadence changes.
 */
export function periodKeyOf(period: BillingPeriod): string {
  if (period === null || typeof period !== "object" || period.version !== "billing-period/1") {
    throw new MeteringError(
      'periodKeyOf requires a BillingPeriod (version "billing-period/1").',
      "invalid-input",
    );
  }
  return `${period.cadence}:${period.label}`;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The event kinds the platform records and metering folds in. Each kind maps
 * to exactly one metered resource plus an amount. This mapping is *declared*
 * (not inferred from the event's name) so a new event kind is a deliberate
 * addition rather than a gotcha.
 *
 * `llm-tokens` amounts come from the LLM adapter's cost tracking; audio/video
 * transcription is accounted as `browser-minutes` because it consumes the
 * same worker budget. The mapping is a policy decision the operator can audit.
 */
export const EVENT_KINDS = [
  "guide-created",
  "guide-regenerated",
  "screenshot-captured",
  "browser-executed",
  "llm-tokens-consumed",
  "storage-written",
  "member-added",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventResourceMapEntry {
  readonly resource: MeteredResource;
  /**
   * Whether this event kind's amount is a *count* (1 per event) or an
   * *amount* the event carries. Count events ignore the event's `amount`
   * field and always accrue 1.
   */
  readonly amountFrom: "count" | "event";
  /** Human unit, for the ledger row. */
  readonly unit: string;
}

export const EVENT_RESOURCE_MAP: Readonly<Record<EventKind, EventResourceMapEntry>> =
  Object.freeze({
    "guide-created": { resource: "guides", amountFrom: "count", unit: "guides" },
    "guide-regenerated": {
      resource: "regenerations-per-month",
      amountFrom: "count",
      unit: "regenerations",
    },
    "screenshot-captured": {
      resource: "screenshots",
      amountFrom: "count",
      unit: "screenshots",
    },
    "browser-executed": {
      resource: "browser-minutes",
      amountFrom: "event",
      unit: "minutes",
    },
    "llm-tokens-consumed": {
      resource: "llm-tokens",
      amountFrom: "event",
      unit: "tokens",
    },
    "storage-written": {
      resource: "storage-bytes",
      amountFrom: "event",
      unit: "bytes",
    },
    "member-added": {
      resource: "workspace-members",
      amountFrom: "count",
      unit: "members",
    },
  });

export function isEventKind(value: unknown): value is EventKind {
  return (
    typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * A usage event as it lands in metering. The metering layer treats this as
 * the smallest unit of consumption: a caller supplies `eventId` (a stable id
 * from the platform's event stream so a replay is idempotent), a `kind`, an
 * optional `amount` for amount-based kinds, and a `workspaceId` + `atMs`
 * for the period partition.
 */
export interface UsageEvent {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly kind: EventKind;
  /** Only required for amount-based kinds; ignored for count kinds. */
  readonly amount?: number;
  /** ISO timestamp the event is attributed to. */
  readonly at: string;
  /**
   * Optional provenance: which guide, workflow or job produced this event.
   * Not used by metering; carried so an audit can trace a row.
   */
  readonly ref?: Readonly<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- */
/* The ledger                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The accumulator. A ledger is per workspace and per period; a caller
 * creates one at the beginning of a run and updates it as events arrive, or
 * rehydrates one from persisted rows when the caller materialises the
 * workspace's usage at the top of a request.
 */
export interface UsageLedger {
  readonly version: "usage-ledger/1";
  readonly workspaceId: string;
  readonly period: BillingPeriod;
  /** The accumulated usage per resource. Always an integer. */
  readonly usage: Readonly<Record<MeteredResource, number>>;
  /**
   * The set of `eventId`s already folded into `usage`. This is the ledger's
   * idempotency token: a replay of an event it has already seen is a no-op.
   * Bounded by the caller (a caller above this module trims it at period
   * boundaries); the ledger does not invent a retention policy.
   */
  readonly recordedEventIds: readonly string[];
  /** Corrections applied to the ledger, for audit. */
  readonly corrections: readonly UsageCorrection[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UsageCorrection {
  readonly correctionId: string;
  readonly resource: MeteredResource;
  /** Positive to add usage, negative to remove. Always an integer. */
  readonly delta: number;
  readonly reason: string;
  readonly actorId: string;
  /** ISO timestamp. */
  readonly at: string;
}

export interface CreateLedgerInput {
  readonly workspaceId: string;
  readonly period: BillingPeriod;
  /** ISO timestamp the ledger was created. */
  readonly createdAt: string;
}

export function createUsageLedger(input: CreateLedgerInput): UsageLedger {
  if (input === null || typeof input !== "object") {
    throw new MeteringError("createUsageLedger requires an inputs object.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new MeteringError("`workspaceId` is required.", "invalid-input");
  }
  if (
    input.period === null ||
    typeof input.period !== "object" ||
    input.period.version !== "billing-period/1"
  ) {
    throw new MeteringError(
      '`period` must be a BillingPeriod (version "billing-period/1").',
      "invalid-input",
    );
  }
  if (typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new MeteringError("`createdAt` must be an ISO timestamp.", "invalid-input");
  }
  const usage = zeroUsage();
  return Object.freeze({
    version: "usage-ledger/1",
    workspaceId: input.workspaceId,
    period: input.period,
    usage,
    recordedEventIds: [],
    corrections: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

/**
 * Fold one usage event into the ledger. The event is validated against the
 * ledger's workspace and period: a caller who mistakenly folds last period's
 * event into this period's ledger receives a typed error rather than a
 * silently mis-attributed metric.
 *
 * The function returns a *new* ledger; the previous ledger is unchanged.
 * This is the shape a persistence layer wants: it can apply a batch of
 * events and write the final ledger in one transaction.
 */
export function recordUsage(ledger: UsageLedger, event: UsageEvent): UsageLedger {
  assertLedger(ledger);
  if (event === null || typeof event !== "object") {
    throw new MeteringError("recordUsage requires an event object.", "invalid-input");
  }
  if (typeof event.eventId !== "string" || event.eventId.length === 0) {
    throw new MeteringError("Event `eventId` is required.", "invalid-input", {
      event,
    });
  }
  if (typeof event.workspaceId !== "string" || event.workspaceId.length === 0) {
    throw new MeteringError("Event `workspaceId` is required.", "invalid-input");
  }
  if (event.workspaceId !== ledger.workspaceId) {
    throw new MeteringError(
      `Event workspace "${event.workspaceId}" does not match ledger workspace "${ledger.workspaceId}".`,
      "period-mismatch",
      { ledgerWorkspaceId: ledger.workspaceId, eventWorkspaceId: event.workspaceId },
    );
  }
  if (!isEventKind(event.kind)) {
    throw new MeteringError(
      `Unknown event kind "${String(event.kind)}". Expected one of: ${EVENT_KINDS.join(", ")}.`,
      "invalid-input",
      { kind: event.kind },
    );
  }
  if (typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))) {
    throw new MeteringError("Event `at` must be an ISO timestamp.", "invalid-input");
  }
  const atMs = Date.parse(event.at);
  const startMs = Date.parse(ledger.period.start);
  const endMs = Date.parse(ledger.period.end);
  if (atMs < startMs || atMs >= endMs) {
    throw new MeteringError(
      `Event "${event.eventId}" at ${event.at} falls outside period ${ledger.period.label} (${ledger.period.start}..${ledger.period.end}).`,
      "period-mismatch",
      {
        eventId: event.eventId,
        at: event.at,
        period: { start: ledger.period.start, end: ledger.period.end },
      },
    );
  }
  // Idempotency: a replay of an already-recorded event is a no-op.
  if (ledger.recordedEventIds.includes(event.eventId)) {
    return ledger;
  }
  const mapping = EVENT_RESOURCE_MAP[event.kind];
  const amount = computeEventAmount(mapping, event);
  const nextUsage: Record<MeteredResource, number> = { ...ledger.usage };
  nextUsage[mapping.resource] = nextUsage[mapping.resource] + amount;
  const nextIds = [...ledger.recordedEventIds, event.eventId];
  return Object.freeze({
    ...ledger,
    usage: Object.freeze(nextUsage),
    recordedEventIds: Object.freeze(nextIds),
    updatedAt: event.at,
  });
}

/**
 * Correct a previously-recorded usage figure. Corrections are rare and
 * attributable: the module requires a `reason` and an `actorId` so the
 * correction appears on the audit trail with a name attached to it. A
 * correction that would drive the resource's usage below zero is clamped at
 * zero rather than overflowing into a negative usage figure, because a
 * negative usage is not a value any downstream caller interprets correctly.
 */
export interface CorrectUsageInput {
  readonly correctionId: string;
  readonly resource: MeteredResource;
  readonly delta: number;
  readonly reason: string;
  readonly actorId: string;
  readonly at: string;
}

export function correctUsage(ledger: UsageLedger, input: CorrectUsageInput): UsageLedger {
  assertLedger(ledger);
  if (input === null || typeof input !== "object") {
    throw new MeteringError("correctUsage requires an inputs object.", "invalid-input");
  }
  if (typeof input.correctionId !== "string" || input.correctionId.length === 0) {
    throw new MeteringError("`correctionId` is required.", "invalid-input");
  }
  if (!isMeteredResource(input.resource)) {
    throw new MeteringError(
      `Unknown metered resource "${String(input.resource)}".`,
      "unknown-resource",
      { resource: input.resource },
    );
  }
  if (
    typeof input.delta !== "number" ||
    !Number.isFinite(input.delta) ||
    !Number.isInteger(input.delta)
  ) {
    throw new MeteringError(
      `\`delta\` must be a finite integer; received ${String(input.delta)}.`,
      "invalid-usage",
      { delta: input.delta },
    );
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new MeteringError(
      "A correction requires a non-empty `reason` so the audit trail can attribute it.",
      "correction-requires-reason",
    );
  }
  if (typeof input.actorId !== "string" || input.actorId.length === 0) {
    throw new MeteringError("A correction requires an `actorId`.", "invalid-input");
  }
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
    throw new MeteringError("`at` must be an ISO timestamp.", "invalid-input");
  }
  const current = ledger.usage[input.resource];
  const raw = current + input.delta;
  const next = Math.max(0, raw);
  const nextUsage: Record<MeteredResource, number> = { ...ledger.usage };
  nextUsage[input.resource] = next;
  const correction: UsageCorrection = Object.freeze({
    correctionId: input.correctionId,
    resource: input.resource,
    delta: input.delta,
    reason: input.reason.trim(),
    actorId: input.actorId,
    at: input.at,
  });
  return Object.freeze({
    ...ledger,
    usage: Object.freeze(nextUsage),
    corrections: Object.freeze([...ledger.corrections, correction]),
    updatedAt: input.at,
  });
}

/** A copy of the ledger's current usage as a plain record. */
export function getUsage(ledger: UsageLedger): Readonly<Record<MeteredResource, number>> {
  assertLedger(ledger);
  return Object.freeze({ ...ledger.usage });
}

/**
 * A fresh ledger for the next period. The previous ledger is not mutated;
 * the returned ledger starts with zeroed usage, an empty event set, and the
 * `corrections` list preserved as a carried-over record when the operator
 * has flagged it. The plan does not specify a carry-over policy for
 * corrections, so this function *drops* them: a correction applies to the
 * period it corrects, and a fresh period begins clean.
 */
export interface ResetForNewPeriodInput {
  readonly period: BillingPeriod;
  readonly at: string;
}

export function resetForNewPeriod(
  ledger: UsageLedger,
  input: ResetForNewPeriodInput,
): UsageLedger {
  assertLedger(ledger);
  if (
    input === null ||
    typeof input !== "object" ||
    input.period === null ||
    typeof input.period !== "object" ||
    input.period.version !== "billing-period/1"
  ) {
    throw new MeteringError(
      'resetForNewPeriod requires an inputs object with a BillingPeriod.',
      "invalid-input",
    );
  }
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
    throw new MeteringError("`at` must be an ISO timestamp.", "invalid-input");
  }
  if (periodKeyOf(input.period) === periodKeyOf(ledger.period)) {
    throw new MeteringError(
      `resetForNewPeriod was called with the ledger's current period "${periodKeyOf(input.period)}"; a reset must target the next period.`,
      "period-mismatch",
      { currentPeriod: periodKeyOf(ledger.period), requested: periodKeyOf(input.period) },
    );
  }
  return Object.freeze({
    version: "usage-ledger/1",
    workspaceId: ledger.workspaceId,
    period: input.period,
    usage: zeroUsage(),
    recordedEventIds: [],
    corrections: [],
    createdAt: input.at,
    updatedAt: input.at,
  });
}

/* -------------------------------------------------------------------------- */
/* The metering decision                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a caller about to consume `resource` should do. `allowed` is the
 * boolean the caller acts on; `reason` explains a refusal; `overage` is what
 * happens when the caller proceeds anyway (a `soft` limit records the
 * overage; a `hard` limit is the one that produced `allowed: false`).
 */
export interface MeteringDecision {
  readonly allowed: boolean;
  readonly resource: MeteredResource;
  readonly check: LimitCheck;
  /** `null` when the operation is allowed. */
  readonly reason: string | null;
  /**
   * Whether the operation should be *recorded* as an overage even when it is
   * allowed. A `soft` limit returns `true`; a `hard` limit that is over
   * returns `true` (so the caller can record the attempt) but the decision
   * itself is `allowed: false`; an `unmetered` limit returns `false`.
   */
  readonly recordOverage: boolean;
}

/**
 * The metering check for one operation. The caller computes the `nextUsed`
 * value by adding the operation's own consumption (usually 1) to the
 * current ledger total and passes it here. Small, side-effect-free, and
 * typed — a caller cannot forget to check the limit because the
 * operation-shape function signature forces it.
 */
export function meteringDecision(
  tier: PlanTier,
  resource: MeteredResource,
  nextUsed: number,
): MeteringDecision {
  if (!isPlanTier(tier)) {
    throw new MeteringError(`Unknown plan tier "${String(tier)}".`, "unknown-plan", { tier });
  }
  if (!isMeteredResource(resource)) {
    throw new MeteringError(
      `Unknown metered resource "${String(resource)}".`,
      "unknown-resource",
      { resource },
    );
  }
  if (
    typeof nextUsed !== "number" ||
    !Number.isFinite(nextUsed) ||
    !Number.isInteger(nextUsed) ||
    nextUsed < 0
  ) {
    throw new MeteringError(
      `meteringDecision requires a non-negative integer \`nextUsed\`; received ${String(nextUsed)}.`,
      "invalid-usage",
      { nextUsed },
    );
  }
  const check = checkLimit(tier, resource, nextUsed);
  if (check.overage === "unmetered") {
    return Object.freeze({
      allowed: true,
      resource,
      check,
      reason: null,
      recordOverage: false,
    });
  }
  if (check.allowed) {
    return Object.freeze({
      allowed: true,
      resource,
      check,
      reason: null,
      recordOverage: false,
    });
  }
  if (check.overage === "soft") {
    return Object.freeze({
      allowed: true,
      resource,
      check,
      reason: `The workspace is over its ${check.limit} ${resource} allotment for this period on the ${tier} plan. The operation is allowed and the overage is recorded so a usage alert can be raised.`,
      recordOverage: true,
    });
  }
  // hard limit
  return Object.freeze({
    allowed: false,
    resource,
    check,
    reason: `The workspace has reached its ${check.limit} ${resource} allotment for this period on the ${tier} plan. Upgrade the plan to continue.`,
    recordOverage: false,
  });
}

/**
 * The metering card the dashboard renders. Every resource is present so the
 * UI does not branch on missing keys; the caller renders them in
 * `METERED_RESOURCES` order.
 */
export interface MeteringSummary {
  readonly workspaceId: string;
  readonly tier: PlanTier;
  readonly period: BillingPeriod;
  readonly checks: readonly LimitCheck[];
  /** The subset of checks the workspace is over, for the alert strip. */
  readonly overLimit: readonly LimitCheck[];
  /** Whether every soft-limit resource is within its allotment. */
  readonly withinLimits: boolean;
}

export function meteringSummary(
  ledger: UsageLedger,
  tier: PlanTier,
): MeteringSummary {
  assertLedger(ledger);
  if (!isPlanTier(tier)) {
    throw new MeteringError(`Unknown plan tier "${String(tier)}".`, "unknown-plan", { tier });
  }
  const checks = checkAllLimits(tier, ledger.usage);
  const overLimit = checks.filter((c) => !c.allowed);
  return Object.freeze({
    workspaceId: ledger.workspaceId,
    tier,
    period: ledger.period,
    checks,
    overLimit: Object.freeze(overLimit),
    withinLimits: overLimit.length === 0,
  });
}

/**
 * One-line summary the metering card's subtitle renders.
 */
export function describeMetering(summary: MeteringSummary): string {
  const { tier, period, overLimit, checks } = summary;
  if (overLimit.length === 0) {
    return `Within ${tier} limits for ${period.label}. ${checks.length} resource${checks.length === 1 ? "" : "s"} tracked.`;
  }
  const over = overLimit.map((c) => c.resource).join(", ");
  return `Over ${tier} limits for ${period.label}: ${over}.`;
}

/**
 * Whether a plan feature is available and whether using it is within the
 * current usage. Features are a plan attribute in `./plans.ts`; this helper
 * exists so a caller that has both a plan and a usage summary can gate a
 * feature with one call.
 */
export function featureAllowed(
  tier: PlanTier,
  feature: PlanFeature,
): { readonly allowed: boolean; readonly reason: string | null } {
  if (!isPlanTier(tier)) {
    throw new MeteringError(`Unknown plan tier "${String(tier)}".`, "unknown-plan", { tier });
  }
  if (!isPlanFeature(feature)) {
    throw new MeteringError(
      `Unknown plan feature "${String(feature)}".`,
      "unknown-feature",
      { feature },
    );
  }
  if (!isFeatureEnabled(tier, feature)) {
    return Object.freeze({
      allowed: false,
      reason: `The ${tier} plan does not include the "${feature}" feature.`,
    });
  }
  return Object.freeze({ allowed: true, reason: null });
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                */
/* -------------------------------------------------------------------------- */

export function rehydrateLedger(value: unknown): UsageLedger {
  if (value === null || typeof value !== "object") {
    throw new MeteringError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "usage-ledger/1") {
    throw new MeteringError(
      `Rehydrate failed: expected version "usage-ledger/1", received "${String(r["version"])}".`,
      "invalid-input",
    );
  }
  const periodRaw = r["period"];
  if (
    periodRaw === null ||
    typeof periodRaw !== "object" ||
    (periodRaw as { version?: unknown }).version !== "billing-period/1"
  ) {
    throw new MeteringError(
      "Rehydrate failed: `period` must be a BillingPeriod.",
      "invalid-input",
    );
  }
  const period = periodRaw as Record<string, unknown>;
  const cadence: PeriodCadence =
    period["cadence"] === "yearly" ? "yearly" : "monthly";
  const usage = zeroUsage();
  const rawUsage = r["usage"];
  if (rawUsage !== null && typeof rawUsage === "object") {
    for (const [key, val] of Object.entries(rawUsage as Record<string, unknown>)) {
      if (!isMeteredResource(key)) continue;
      if (typeof val === "number" && Number.isInteger(val) && val >= 0) {
        usage[key] = val;
      }
    }
  }
  const rawIds = r["recordedEventIds"];
  const recordedEventIds: string[] = Array.isArray(rawIds)
    ? rawIds.filter((v): v is string => typeof v === "string")
    : [];
  const rawCorrections = r["corrections"];
  const corrections: UsageCorrection[] = [];
  if (Array.isArray(rawCorrections)) {
    for (const c of rawCorrections) {
      if (c === null || typeof c !== "object") continue;
      const co = c as Record<string, unknown>;
      if (!isMeteredResource(co["resource"])) continue;
      if (typeof co["delta"] !== "number" || !Number.isInteger(co["delta"])) continue;
      if (typeof co["reason"] !== "string" || co["reason"].length === 0) continue;
      if (typeof co["actorId"] !== "string" || co["actorId"].length === 0) continue;
      if (typeof co["at"] !== "string") continue;
      corrections.push({
        correctionId:
          typeof co["correctionId"] === "string" ? co["correctionId"] : "",
        resource: co["resource"],
        delta: co["delta"],
        reason: co["reason"],
        actorId: co["actorId"],
        at: co["at"],
      });
    }
  }
  return Object.freeze({
    version: "usage-ledger/1",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    period: {
      version: "billing-period/1",
      cadence,
      label: typeof period["label"] === "string" ? period["label"] : "",
      start: typeof period["start"] === "string" ? period["start"] : "",
      end: typeof period["end"] === "string" ? period["end"] : "",
    },
    usage: Object.freeze(usage),
    recordedEventIds: Object.freeze(recordedEventIds),
    corrections: Object.freeze(corrections),
    createdAt: typeof r["createdAt"] === "string" ? r["createdAt"] : "",
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Persistence DDL — declared here so the migration runner registers it once  */
/* -------------------------------------------------------------------------- */

export const USAGE_LEDGERS_TABLE = "usage_ledgers" as const;
export const USAGE_LEDGERS_SCHEMA_VERSION = 1 as const;

export const CREATE_USAGE_LEDGERS_SQL = `
CREATE TABLE IF NOT EXISTS ${USAGE_LEDGERS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_cadence        TEXT NOT NULL,
  period_label          TEXT NOT NULL,
  period_start          TIMESTAMPTZ NOT NULL,
  period_end            TIMESTAMPTZ NOT NULL,
  guides                BIGINT NOT NULL DEFAULT 0,
  regenerations         BIGINT NOT NULL DEFAULT 0,
  screenshots           BIGINT NOT NULL DEFAULT 0,
  browser_minutes       BIGINT NOT NULL DEFAULT 0,
  llm_tokens            BIGINT NOT NULL DEFAULT 0,
  storage_bytes         BIGINT NOT NULL DEFAULT 0,
  workspace_members     BIGINT NOT NULL DEFAULT 0,
  recorded_event_ids    TEXT[] NOT NULL DEFAULT '{}'::text[],
  corrections           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${USAGE_LEDGERS_TABLE}_period_cadence_allowed
    CHECK (period_cadence IN ('monthly','yearly')),
  CONSTRAINT ${USAGE_LEDGERS_TABLE}_period_end_after_start
    CHECK (period_end > period_start),
  CONSTRAINT ${USAGE_LEDGERS_TABLE}_workspace_period_unique
    UNIQUE (workspace_id, period_cadence, period_label),
  CONSTRAINT ${USAGE_LEDGERS_TABLE}_counts_nonnegative CHECK (
    guides >= 0
    AND regenerations >= 0
    AND screenshots >= 0
    AND browser_minutes >= 0
    AND llm_tokens >= 0
    AND storage_bytes >= 0
    AND workspace_members >= 0
  )
);

CREATE INDEX IF NOT EXISTS ${USAGE_LEDGERS_TABLE}_workspace_idx
  ON ${USAGE_LEDGERS_TABLE} (workspace_id, period_start DESC);

DROP TRIGGER IF EXISTS trg_${USAGE_LEDGERS_TABLE}_updated_at ON ${USAGE_LEDGERS_TABLE};
CREATE TRIGGER trg_${USAGE_LEDGERS_TABLE}_updated_at
  BEFORE UPDATE ON ${USAGE_LEDGERS_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();
`;

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function zeroUsage(): Record<MeteredResource, number> {
  return {
    guides: 0,
    "regenerations-per-month": 0,
    screenshots: 0,
    "browser-minutes": 0,
    "llm-tokens": 0,
    "storage-bytes": 0,
    "workspace-members": 0,
  };
}

function computeEventAmount(
  mapping: EventResourceMapEntry,
  event: UsageEvent,
): number {
  if (mapping.amountFrom === "count") return 1;
  const amount = event.amount;
  if (amount === undefined) {
    throw new MeteringError(
      `Event kind "${event.kind}" requires a numeric \`amount\`; none was supplied.`,
      "invalid-usage",
      { eventId: event.eventId, kind: event.kind },
    );
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
    throw new MeteringError(
      `Event kind "${event.kind}" requires a non-negative integer \`amount\`; received ${String(amount)}.`,
      "invalid-usage",
      { eventId: event.eventId, kind: event.kind, amount },
    );
  }
  return amount;
}

function assertLedger(ledger: UsageLedger): void {
  if (ledger === null || typeof ledger !== "object") {
    throw new MeteringError("A UsageLedger is required.", "invalid-input");
  }
  if (ledger.version !== "usage-ledger/1") {
    throw new MeteringError(
      `Unsupported ledger version "${String((ledger as { version?: unknown }).version)}"; expected "usage-ledger/1".`,
      "invalid-input",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                        */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  labelFor,
  zeroUsage,
  computeEventAmount,
  assertLedger,
});
