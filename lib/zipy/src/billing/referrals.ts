/**
 * Zipy AI — referral credits (phase 24, batch 3).
 *
 * The plan lists a referral program: "Users earn credits for referring new
 * customers." This module implements the credit *ledger*: who referred whom,
 * how much credit each referral earned, when a credit is *granted* (the
 * referred workspace signs up) vs *earned* (the referred workspace pays its
 * first invoice), when a credit is *applied* to a workspace (which is a
 * billing action the charging path performs), and how to reconcile the
 * credits a workspace holds.
 *
 * Design boundaries honoured here:
 *
 *  - No money is moved. This module keeps a ledger of credit *amounts* in a
 *    currency the caller supplies. `applied` credits carry a reference to
 *    the invoice or charge they were applied against; the module does not
 *    know what an invoice is beyond the reference.
 *
 *  - No credentials are invented. Referral codes are generated from a
 *    caller-supplied source of randomness or from a caller-supplied id; the
 *    module does not call out to a URL shortener, does not assume a domain
 *    is configured, and does not post to any external system.
 *
 *  - Credit is *attributed* to a workspace, not a user. A workspace on the
 *    free plan whose owner leaves can still accrue credits against its
 *    referrals; whether a credit is transferable between workspaces is a
 *    policy the module answers with `isTransferable` but does not enforce.
 *
 *  - The attribution tuple is `(referrerWorkspaceId, referredWorkspaceId)`.
 *    A referral is unique on that tuple so a replayed signup webhook does
 *    not create a second referral. A workspace that is *already* a member
 *    of the platform cannot be referred (a signup webhook for an existing
 *    workspace is a replay, not a new referral).
 *
 *  - A referral earns a credit when the referred workspace *pays*: the
 *    plan sets the amount per tier, and the referral has a distinct
 *    `granted` state (the signup happened) and `earned` state (the payment
 *    happened). The distinction exists because an operator auditing the
 *    ledger needs to see "20 signups, 8 payments, 8 credits earned" rather
 *    than "8 signups".
 *
 *  - Credits expire. The plan does not specify an expiry policy, so the
 *    module defaults to *no expiry* and exposes `expiresAt` as an optional
 *    field a caller can populate from its own policy. An operator with an
 *    expiry rule sets it on the referral; the module does not silently
 *    time-bound credits.
 *
 * The module exports:
 *   - `generateReferralCode`, `normaliseReferralCode` — the code surface.
 *   - `createReferral`, `markReferralGranted`, `markReferralEarned`,
 *     `markReferralVoided` — the lifecycle.
 *   - `applyCredit`, `reverseCredit` — credit application against an
 *     external reference.
 *   - `creditBalance` — the ledger's net credit for a workspace.
 *   - `referralProgrammeSummary` — the dashboard's referral card.
 *   - `isTransferable` — a policy predicate.
 *   - Typed errors, constants, and a description helper.
 */

import type { PlanTier } from "./plans";
import { PLANS, isPlanTier } from "./plans";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type ReferralErrorCode =
  | "invalid-input"
  | "unknown-plan"
  | "invalid-state"
  | "self-referral"
  | "duplicate-referral"
  | "credit-not-earned"
  | "credit-already-applied"
  | "credit-overdraw"
  | "wrong-version";

export class ReferralError extends Error {
  readonly code: ReferralErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ReferralErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ReferralError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle of a referral. `granted` fires when the referred workspace
 * signs up; `earned` fires when it first pays; `voided` fires when the
 * referral is invalidated (abuse, chargeback, or a manual admin action).
 * The distinction between granted and earned is what keeps the ledger
 * honest: a signup that never converts is not a credit.
 */
export const REFERRAL_STATUSES = ["granted", "earned", "voided"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export function isReferralStatus(value: unknown): value is ReferralStatus {
  return (
    typeof value === "string" && (REFERRAL_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The status of a credit against an external billing reference. Credits are
 * applied *in full* against an invoice; partial application is not modelled
 * because the plan's referral feature is "earn credits" not "pay down
 * invoices across many cycles", and adding partials would need a proration
 * policy the module is not authorised to invent.
 */
export const CREDIT_APPLICATIONS = ["applied", "reversed"] as const;
export type CreditApplicationStatus = (typeof CREDIT_APPLICATIONS)[number];

/* -------------------------------------------------------------------------- */
/* Referral code                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The alphabet for generated codes. Deliberately excludes the letters and
 * digits that look alike when hand-typed (`0`, `O`, `1`, `I`, `L`) because
 * a referral code is usually shared verbally or by hand.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const REFERRAL_CODE_LENGTH = 8;

/**
 * Generate a referral code. `entropy` is a caller-supplied byte source; the
 * module does not touch `crypto` so an on-prem build with a different RNG
 * can supply one, and a test can supply a deterministic byte sequence.
 *
 * The function rejects an entropy source that produces fewer bytes than
 * required, because a shorter code is less entropic than the alphabet
 * suggests and a caller who thought otherwise would be wrong.
 */
export function generateReferralCode(entropy: Uint8Array | (() => number)): string {
  const byteFor = makeByteReader(entropy);
  let out = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    const b = byteFor();
    // Rejection sampling would be ideal for uniform output; the alphabet
    // (31 characters) into a byte (0-255) is close enough for referral
    // codes that a modulo is acceptable, and the length gives ~39.6 bits of
    // entropy which comfortably exceeds a brute-force threshold for a code
    // that grants a bounded credit.
    out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return out;
}

function makeByteReader(entropy: Uint8Array | (() => number)): () => number {
  if (entropy instanceof Uint8Array) {
    if (entropy.length < REFERRAL_CODE_LENGTH) {
      throw new ReferralError(
        `Entropy source supplies ${entropy.length} bytes; ${REFERRAL_CODE_LENGTH} are required for a ${REFERRAL_CODE_LENGTH}-character code.`,
        "invalid-input",
        { provided: entropy.length, required: REFERRAL_CODE_LENGTH },
      );
    }
    let cursor = 0;
    return () => {
      const b = entropy[cursor];
      cursor += 1;
      return b === undefined ? 0 : b;
    };
  }
  if (typeof entropy === "function") {
    return () => {
      const v = entropy();
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new ReferralError(
          "The entropy function returned a non-finite value.",
          "invalid-input",
        );
      }
      return Math.abs(Math.floor(v)) % 256;
    };
  }
  throw new ReferralError(
    "generateReferralCode requires a Uint8Array or a function returning a byte.",
    "invalid-input",
  );
}

/**
 * Normalise a user-entered referral code: uppercase, and strip spaces and
 * dashes because a referral code is often copied with visual separators the
 * canonical form does not have.
 */
export function normaliseReferralCode(raw: string): string {
  if (typeof raw !== "string") {
    throw new ReferralError("Referral code must be a string.", "invalid-input");
  }
  return raw.trim().replace(/[\s-]+/g, "").toUpperCase();
}

/* -------------------------------------------------------------------------- */
/* The referral record                                                        */
/* -------------------------------------------------------------------------- */

export interface Referral {
  readonly version: "referral/1";
  readonly referralId: string;
  /** The workspace that shared the code. */
  readonly referrerWorkspaceId: string;
  /** The workspace that signed up with the code. */
  readonly referredWorkspaceId: string;
  /** The code that was used; the canonical, uppercased form. */
  readonly code: string;
  /**
   * The credit earned when the referral converts. This is captured at
   * creation time from the plan's `referralCreditUsd` so a plan-price change
   * does not retroactively change a referral's value.
   */
  readonly creditAmountUsd: number;
  readonly status: ReferralStatus;
  /** ISO timestamp the referral record was created (the code was redeemed). */
  readonly createdAt: string;
  /** ISO timestamp the referred workspace signed up. */
  readonly grantedAt: string | null;
  /** ISO timestamp the referred workspace first paid. */
  readonly earnedAt: string | null;
  /** ISO timestamp the referral was voided. */
  readonly voidedAt: string | null;
  /** Free-text reason on voiding, for the audit trail. */
  readonly voidedReason: string | null;
  /**
   * The external reference for the first completed payment that *earned*
   * this referral. Carried so an audit can tie a credit back to an invoice.
   */
  readonly earnedOnReference: string | null;
  /** Optional expiry of the credit; `null` means the credit does not expire. */
  readonly expiresAt: string | null;
}

export interface CreateReferralInput {
  readonly referralId: string;
  readonly referrerWorkspaceId: string;
  readonly referredWorkspaceId: string;
  readonly code: string;
  /** ISO timestamp the code was redeemed. */
  readonly at: string;
  readonly expiresAt?: string | null;
  /** Optional override of the plan-derived credit amount, for contract pricing. */
  readonly creditOverrideUsd?: number | null;
  /** The plan the referral amount is derived from; `free` by default. */
  readonly referrerTier?: PlanTier;
}

/**
 * Create a referral record. Refuses a self-referral; the caller is expected
 * to have already confirmed that the referred workspace is new and that the
 * code is valid. The module's job is to atomically produce the record with
 * the correct credit amount and the correct initial status.
 */
export function createReferral(input: CreateReferralInput): Referral {
  if (input === null || typeof input !== "object") {
    throw new ReferralError("createReferral requires an inputs object.", "invalid-input");
  }
  const require = (name: string, v: unknown): string => {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new ReferralError(`createReferral requires \`${name}\`.`, "invalid-input", {
        name,
      });
    }
    return v;
  };
  const referralId = require("referralId", input.referralId);
  const referrerWorkspaceId = require("referrerWorkspaceId", input.referrerWorkspaceId);
  const referredWorkspaceId = require("referredWorkspaceId", input.referredWorkspaceId);
  const code = normaliseReferralCode(require("code", input.code));
  if (code.length === 0) {
    throw new ReferralError("`code` is empty after normalisation.", "invalid-input");
  }
  if (referrerWorkspaceId === referredWorkspaceId) {
    throw new ReferralError(
      "A workspace cannot refer itself.",
      "self-referral",
      { workspaceId: referrerWorkspaceId },
    );
  }
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
    throw new ReferralError("`at` must be an ISO timestamp.", "invalid-input");
  }
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null) {
    if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
      throw new ReferralError("`expiresAt` must be an ISO timestamp or null.", "invalid-input");
    }
    if (Date.parse(expiresAt) <= Date.parse(input.at)) {
      throw new ReferralError(
        "`expiresAt` must be after `at`.",
        "invalid-input",
        { at: input.at, expiresAt },
      );
    }
  }
  const referrerTier = input.referrerTier ?? "free";
  if (!isPlanTier(referrerTier)) {
    throw new ReferralError(
      `Unknown plan tier "${String(referrerTier)}".`,
      "unknown-plan",
      { tier: referrerTier },
    );
  }
  const creditAmountUsd = resolveCreditAmount(input, referrerTier);
  return Object.freeze({
    version: "referral/1",
    referralId,
    referrerWorkspaceId,
    referredWorkspaceId,
    code,
    creditAmountUsd,
    status: "granted",
    createdAt: input.at,
    grantedAt: input.at,
    earnedAt: null,
    voidedAt: null,
    voidedReason: null,
    earnedOnReference: null,
    expiresAt,
  });
}

function resolveCreditAmount(
  input: CreateReferralInput,
  referrerTier: PlanTier,
): number {
  const override = input.creditOverrideUsd;
  if (override !== null && override !== undefined) {
    if (
      typeof override !== "number" ||
      !Number.isFinite(override) ||
      override < 0
    ) {
      throw new ReferralError(
        `creditOverrideUsd must be a non-negative finite number; received ${String(override)}.`,
        "invalid-input",
        { creditOverrideUsd: override },
      );
    }
    return override;
  }
  return PLANS[referrerTier].referralCreditUsd;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

export interface MarkEarnedInput {
  /** ISO timestamp the referred workspace's first payment completed. */
  readonly at: string;
  /**
   * The external billing reference for the earning payment. Required
   * because a credit application later needs to justify itself, and an
   * "earned" referral without a payment reference is an operator action
   * better expressed as a manual credit override.
   */
  readonly reference: string;
}

/**
 * Transition a granted referral to earned. Refuses to re-earn an already
 * earned referral (the caller's webhook has replayed) and refuses to earn a
 * voided referral (the operator's action takes precedence over the
 * webhook).
 */
export function markReferralEarned(
  referral: Referral,
  input: MarkEarnedInput,
): Referral {
  assertReferral(referral);
  if (input === null || typeof input !== "object") {
    throw new ReferralError("markReferralEarned requires an inputs object.", "invalid-input");
  }
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
    throw new ReferralError("`at` must be an ISO timestamp.", "invalid-input");
  }
  if (typeof input.reference !== "string" || input.reference.trim().length === 0) {
    throw new ReferralError(
      "An earning referral requires a `reference` to the payment that earned it.",
      "invalid-input",
    );
  }
  if (referral.status === "earned") {
    throw new ReferralError(
      `Referral "${referral.referralId}" is already earned.`,
      "invalid-state",
      { referralId: referral.referralId, status: referral.status },
    );
  }
  if (referral.status === "voided") {
    throw new ReferralError(
      `Referral "${referral.referralId}" is voided; a voided referral cannot be earned.`,
      "invalid-state",
      { referralId: referral.referralId },
    );
  }
  return Object.freeze({
    ...referral,
    status: "earned",
    earnedAt: input.at,
    earnedOnReference: input.reference.trim(),
  });
}

export interface VoidReferralInput {
  readonly at: string;
  readonly reason: string;
}

export function markReferralVoided(
  referral: Referral,
  input: VoidReferralInput,
): Referral {
  assertReferral(referral);
  if (input === null || typeof input !== "object") {
    throw new ReferralError("markReferralVoided requires an inputs object.", "invalid-input");
  }
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
    throw new ReferralError("`at` must be an ISO timestamp.", "invalid-input");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new ReferralError(
      "Voiding a referral requires a non-empty `reason` for the audit trail.",
      "invalid-input",
    );
  }
  if (referral.status === "voided") {
    throw new ReferralError(
      `Referral "${referral.referralId}" is already voided.`,
      "invalid-state",
      { referralId: referral.referralId },
    );
  }
  return Object.freeze({
    ...referral,
    status: "voided",
    voidedAt: input.at,
    voidedReason: input.reason.trim(),
  });
}

/* -------------------------------------------------------------------------- */
/* Credit applications                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One application of a referral's credit against an external billing
 * reference. The `reference` is opaque to this module — an invoice id, a
 * subscription id, an internal charge id — and is required so the ledger can
 * be reconciled against whatever system the operator is using.
 */
export interface CreditApplication {
  readonly version: "credit-application/1";
  readonly applicationId: string;
  readonly referralId: string;
  readonly workspaceId: string;
  readonly amountUsd: number;
  /** The billing reference the credit was applied against. */
  readonly reference: string;
  readonly status: CreditApplicationStatus;
  /** ISO timestamp the credit was applied. */
  readonly appliedAt: string;
  /** ISO timestamp the application was reversed; null while applied. */
  readonly reversedAt: string | null;
  readonly reversedReason: string | null;
}

export interface ApplyCreditInput {
  readonly applicationId: string;
  readonly reference: string;
  readonly amountUsd: number;
  readonly at: string;
}

/**
 * Apply a referral's credit against a billing reference. Refuses to apply
 * before the referral has earned its credit; the check exists because
 * applying a referral is a *billing* action and its precondition is
 * "we've been paid", not "someone signed up".
 *
 * Refuses to apply more than the referral's credit amount because partial
 * applications across multiple invoices would need a proration policy.
 */
export function applyCredit(
  referral: Referral,
  input: ApplyCreditInput,
  existing: readonly CreditApplication[],
): CreditApplication {
  assertReferral(referral);
  if (input === null || typeof input !== "object") {
    throw new ReferralError("applyCredit requires an inputs object.", "invalid-input");
  }
  if (referral.status !== "earned") {
    throw new ReferralError(
      `Referral "${referral.referralId}" has not earned its credit yet (status: "${referral.status}").`,
      "credit-not-earned",
      { referralId: referral.referralId, status: referral.status },
    );
  }
  if (typeof input.applicationId !== "string" || input.applicationId.length === 0) {
    throw new ReferralError("applyCredit requires `applicationId`.", "invalid-input");
  }
  if (typeof input.reference !== "string" || input.reference.trim().length === 0) {
    throw new ReferralError("applyCredit requires a billing `reference`.", "invalid-input");
  }
  if (
    typeof input.amountUsd !== "number" ||
    !Number.isFinite(input.amountUsd) ||
    input.amountUsd <= 0
  ) {
    throw new ReferralError(
      `\`amountUsd\` must be a positive finite number; received ${String(input.amountUsd)}.`,
      "invalid-input",
      { amountUsd: input.amountUsd },
    );
  }
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
    throw new ReferralError("`at` must be an ISO timestamp.", "invalid-input");
  }
  if (input.amountUsd > referral.creditAmountUsd) {
    throw new ReferralError(
      `Credit application of ${input.amountUsd} exceeds the referral's credit of ${referral.creditAmountUsd}.`,
      "credit-overdraw",
      { requested: input.amountUsd, available: referral.creditAmountUsd },
    );
  }
  const alreadyApplied = existing.find(
    (a) => a !== null && typeof a === "object" && a.version === "credit-application/1" &&
      a.referralId === referral.referralId && a.status === "applied",
  );
  if (alreadyApplied !== undefined) {
    throw new ReferralError(
      `Referral "${referral.referralId}" already has an applied credit "${alreadyApplied.applicationId}". Reverse the existing application before applying a new one.`,
      "credit-already-applied",
      {
        referralId: referral.referralId,
        existingApplicationId: alreadyApplied.applicationId,
      },
    );
  }
  return Object.freeze({
    version: "credit-application/1",
    applicationId: input.applicationId,
    referralId: referral.referralId,
    workspaceId: referral.referrerWorkspaceId,
    amountUsd: input.amountUsd,
    reference: input.reference.trim(),
    status: "applied",
    appliedAt: input.at,
    reversedAt: null,
    reversedReason: null,
  });
}

export interface ReverseCreditInput {
  readonly at: string;
  readonly reason: string;
}

export function reverseCredit(
  application: CreditApplication,
  input: ReverseCreditInput,
): CreditApplication {
  if (
    application === null ||
    typeof application !== "object" ||
    application.version !== "credit-application/1"
  ) {
    throw new ReferralError("reverseCredit requires a CreditApplication.", "invalid-input");
  }
  if (application.status === "reversed") {
    throw new ReferralError(
      `Credit application "${application.applicationId}" is already reversed.`,
      "invalid-state",
      { applicationId: application.applicationId },
    );
  }
  if (input === null || typeof input !== "object") {
    throw new ReferralError("reverseCredit requires an inputs object.", "invalid-input");
  }
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
    throw new ReferralError("`at` must be an ISO timestamp.", "invalid-input");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new ReferralError(
      "Reversing a credit application requires a non-empty `reason` for the audit trail.",
      "invalid-input",
    );
  }
  return Object.freeze({
    ...application,
    status: "reversed",
    reversedAt: input.at,
    reversedReason: input.reason.trim(),
  });
}

/* -------------------------------------------------------------------------- */
/* Balance                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The net credit a workspace holds. `earnedUsd` is the sum of credits from
 * referrals of the workspace as referrer; `appliedUsd` is the sum of
 * applications still in the `applied` state; `availableUsd` is the
 * difference, clamped at zero because a reversed application can leave a
 * small negative that is not a meaningful number.
 */
export interface CreditBalance {
  readonly workspaceId: string;
  readonly earnedUsd: number;
  readonly appliedUsd: number;
  readonly availableUsd: number;
  readonly currency: "USD";
  readonly referralCounts: {
    readonly granted: number;
    readonly earned: number;
    readonly voided: number;
  };
}

export function creditBalance(
  workspaceId: string,
  referrals: readonly Referral[],
  applications: readonly CreditApplication[],
): CreditBalance {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new ReferralError("creditBalance requires a workspaceId.", "invalid-input");
  }
  if (!Array.isArray(referrals) || !Array.isArray(applications)) {
    throw new ReferralError("creditBalance requires arrays of referrals and applications.", "invalid-input");
  }
  let earnedUsd = 0;
  const counts = { granted: 0, earned: 0, voided: 0 };
  for (const r of referrals) {
    if (r === null || typeof r !== "object" || r.version !== "referral/1") continue;
    if (r.referrerWorkspaceId !== workspaceId) continue;
    if (r.status === "earned") {
      earnedUsd += r.creditAmountUsd;
      counts.earned += 1;
    } else if (r.status === "granted") {
      counts.granted += 1;
    } else if (r.status === "voided") {
      counts.voided += 1;
    }
  }
  let appliedUsd = 0;
  for (const a of applications) {
    if (a === null || typeof a !== "object" || a.version !== "credit-application/1") continue;
    if (a.workspaceId !== workspaceId) continue;
    if (a.status !== "applied") continue;
    appliedUsd += a.amountUsd;
  }
  const availableUsd = Math.max(0, round2(earnedUsd - appliedUsd));
  return Object.freeze({
    workspaceId,
    earnedUsd: round2(earnedUsd),
    appliedUsd: round2(appliedUsd),
    availableUsd,
    currency: "USD",
    referralCounts: Object.freeze(counts),
  });
}

/**
 * Whether a credit is transferable. The plan does not specify transfer
 * policy; the module answers the question with a *default* ("no; a credit
 * stays with the workspace it was earned for") and lets a caller override it
 * with a policy object. This keeps the semantics explicit rather than a
 * silent permissive default.
 */
export interface TransferPolicy {
  readonly allow: boolean;
}

export const DEFAULT_TRANSFER_POLICY: TransferPolicy = Object.freeze({ allow: false });

export function isTransferable(
  balance: CreditBalance,
  policy: TransferPolicy = DEFAULT_TRANSFER_POLICY,
): boolean {
  if (balance === null || typeof balance !== "object") return false;
  if (!policy.allow) return false;
  return balance.availableUsd > 0;
}

/* -------------------------------------------------------------------------- */
/* Programme summary                                                          */
/* -------------------------------------------------------------------------- */

export interface ReferralProgrammeSummary {
  readonly workspaceId: string;
  readonly balance: CreditBalance;
  /** The referral code the workspace shares; may be null when not generated. */
  readonly code: string | null;
  /** The set of referrals this workspace has made. */
  readonly referrals: readonly Referral[];
  /** One-line description for the dashboard card. */
  readonly headline: string;
}

export function referralProgrammeSummary(
  workspaceId: string,
  code: string | null,
  referrals: readonly Referral[],
  applications: readonly CreditApplication[],
): ReferralProgrammeSummary {
  const filtered = referrals.filter(
    (r) =>
      r !== null &&
      typeof r === "object" &&
      r.version === "referral/1" &&
      r.referrerWorkspaceId === workspaceId,
  );
  const balance = creditBalance(workspaceId, filtered, applications);
  const headline =
    balance.referralCounts.earned === 0 && balance.referralCounts.granted === 0
      ? "No referrals yet. Share your code to start earning credit."
      : `${balance.referralCounts.earned} earned of ${balance.referralCounts.earned + balance.referralCounts.granted} referral${balance.referralCounts.earned + balance.referralCounts.granted === 1 ? "" : "s"} — $${balance.availableUsd.toFixed(2)} available credit.`;
  return Object.freeze({
    workspaceId,
    balance,
    code,
    referrals: Object.freeze(filtered),
    headline,
  });
}

/* -------------------------------------------------------------------------- */
/* Persistence DDL — declared here so the migration runner registers it once  */
/* -------------------------------------------------------------------------- */

export const REFERRALS_TABLE = "referrals" as const;
export const REFERRALS_SCHEMA_VERSION = 1 as const;

export const CREATE_REFERRALS_SQL = `
CREATE TABLE IF NOT EXISTS ${REFERRALS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id           TEXT NOT NULL UNIQUE,
  referrer_workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  referred_workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code                  TEXT NOT NULL,
  credit_amount_usd     NUMERIC(10, 2) NOT NULL,
  status                TEXT NOT NULL DEFAULT 'granted',
  created_at            TIMESTAMPTZ NOT NULL,
  granted_at            TIMESTAMPTZ,
  earned_at             TIMESTAMPTZ,
  voided_at             TIMESTAMPTZ,
  voided_reason         TEXT,
  earned_on_reference   TEXT,
  expires_at            TIMESTAMPTZ,
  CONSTRAINT ${REFERRALS_TABLE}_status_allowed
    CHECK (status IN ('granted','earned','voided')),
  CONSTRAINT ${REFERRALS_TABLE}_referrer_not_self
    CHECK (referrer_workspace_id <> referred_workspace_id),
  CONSTRAINT ${REFERRALS_TABLE}_credit_nonnegative
    CHECK (credit_amount_usd >= 0),
  CONSTRAINT ${REFERRALS_TABLE}_granted_consistency
    CHECK (status <> 'granted' OR granted_at IS NOT NULL),
  CONSTRAINT ${REFERRALS_TABLE}_earned_requires_reference
    CHECK (status <> 'earned' OR (earned_at IS NOT NULL AND earned_on_reference IS NOT NULL)),
  CONSTRAINT ${REFERRALS_TABLE}_voided_requires_reason
    CHECK (status <> 'voided' OR (voided_at IS NOT NULL AND voided_reason IS NOT NULL)),
  CONSTRAINT ${REFERRALS_TABLE}_identity_unique
    UNIQUE (referrer_workspace_id, referred_workspace_id)
);

CREATE INDEX IF NOT EXISTS ${REFERRALS_TABLE}_referrer_idx
  ON ${REFERRALS_TABLE} (referrer_workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ${REFERRALS_TABLE}_code_idx
  ON ${REFERRALS_TABLE} (code);
`;

export const REFERRAL_CREDIT_APPLICATIONS_TABLE = "referral_credit_applications" as const;
export const REFERRAL_CREDIT_APPLICATIONS_SCHEMA_VERSION = 1 as const;

export const CREATE_REFERRAL_CREDIT_APPLICATIONS_SQL = `
CREATE TABLE IF NOT EXISTS ${REFERRAL_CREDIT_APPLICATIONS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        TEXT NOT NULL UNIQUE,
  referral_id           TEXT NOT NULL REFERENCES ${REFERRALS_TABLE}(referral_id) ON DELETE CASCADE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount_usd            NUMERIC(10, 2) NOT NULL,
  reference             TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'applied',
  applied_at            TIMESTAMPTZ NOT NULL,
  reversed_at           TIMESTAMPTZ,
  reversed_reason       TEXT,
  CONSTRAINT ${REFERRAL_CREDIT_APPLICATIONS_TABLE}_status_allowed
    CHECK (status IN ('applied','reversed')),
  CONSTRAINT ${REFERRAL_CREDIT_APPLICATIONS_TABLE}_amount_positive
    CHECK (amount_usd > 0),
  CONSTRAINT ${REFERRAL_CREDIT_APPLICATIONS_TABLE}_reversed_consistency
    CHECK ((status = 'reversed' AND reversed_at IS NOT NULL AND reversed_reason IS NOT NULL)
        OR (status <> 'reversed' AND reversed_at IS NULL AND reversed_reason IS NULL)),
  -- A referral may only have one applied (not reversed) credit at a time.
  CONSTRAINT ${REFERRAL_CREDIT_APPLICATIONS_TABLE}_single_applied_per_referral
    EXCLUDE USING btree (referral_id WITH =)
    WHERE (status = 'applied')
);

CREATE INDEX IF NOT EXISTS ${REFERRAL_CREDIT_APPLICATIONS_TABLE}_workspace_idx
  ON ${REFERRAL_CREDIT_APPLICATIONS_TABLE} (workspace_id, applied_at DESC);
`;

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function assertReferral(referral: Referral): void {
  if (referral === null || typeof referral !== "object") {
    throw new ReferralError("A Referral is required.", "invalid-input");
  }
  if (referral.version !== "referral/1") {
    throw new ReferralError(
      `Unsupported referral version "${String((referral as { version?: unknown }).version)}"; expected "referral/1".`,
      "wrong-version",
    );
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                */
/* -------------------------------------------------------------------------- */

export function rehydrateReferral(value: unknown): Referral {
  if (value === null || typeof value !== "object") {
    throw new ReferralError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "referral/1") {
    throw new ReferralError(
      `Rehydrate failed: expected version "referral/1", received "${String(r["version"])}".`,
      "wrong-version",
    );
  }
  if (!isReferralStatus(r["status"])) {
    throw new ReferralError(
      `Rehydrate failed: unknown status "${String(r["status"])}".`,
      "invalid-input",
      { status: r["status"] },
    );
  }
  return Object.freeze({
    version: "referral/1",
    referralId: typeof r["referralId"] === "string" ? r["referralId"] : "",
    referrerWorkspaceId:
      typeof r["referrerWorkspaceId"] === "string" ? r["referrerWorkspaceId"] : "",
    referredWorkspaceId:
      typeof r["referredWorkspaceId"] === "string" ? r["referredWorkspaceId"] : "",
    code: typeof r["code"] === "string" ? normaliseReferralCode(r["code"]) : "",
    creditAmountUsd: numberOr(r["creditAmountUsd"], 0),
    status: r["status"],
    createdAt: stringOr(r["createdAt"], ""),
    grantedAt: stringOrNull(r["grantedAt"]),
    earnedAt: stringOrNull(r["earnedAt"]),
    voidedAt: stringOrNull(r["voidedAt"]),
    voidedReason: stringOrNull(r["voidedReason"]),
    earnedOnReference: stringOrNull(r["earnedOnReference"]),
    expiresAt: stringOrNull(r["expiresAt"]),
  });
}

export function rehydrateCreditApplication(value: unknown): CreditApplication {
  if (value === null || typeof value !== "object") {
    throw new ReferralError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "credit-application/1") {
    throw new ReferralError(
      `Rehydrate failed: expected version "credit-application/1", received "${String(r["version"])}".`,
      "wrong-version",
    );
  }
  const statusRaw = r["status"];
  const status: CreditApplicationStatus = statusRaw === "reversed" ? "reversed" : "applied";
  return Object.freeze({
    version: "credit-application/1",
    applicationId: typeof r["applicationId"] === "string" ? r["applicationId"] : "",
    referralId: typeof r["referralId"] === "string" ? r["referralId"] : "",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    amountUsd: numberOr(r["amountUsd"], 0),
    reference: typeof r["reference"] === "string" ? r["reference"] : "",
    status,
    appliedAt: stringOr(r["appliedAt"], ""),
    reversedAt: stringOrNull(r["reversedAt"]),
    reversedReason: stringOrNull(r["reversedReason"]),
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

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                        */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  CODE_ALPHABET,
  assertReferral,
  round2,
  resolveCreditAmount,
  makeByteReader,
});
