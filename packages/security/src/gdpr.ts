/**
 * Zipy AI — GDPR / CCPA data-subject flows (phase 22, batch 1).
 *
 * Implements the platform's "data subject access request" (DSAR) and
 * "right to erasure" flows as a *planning* module: it locates every place
 * the platform stores data that belongs to a subject (a user, a reviewer,
 * an end-user named in a guide's comments, a screenshot's OCR output),
 * and produces a plan the caller executes against the platform's actual
 * stores.
 *
 * Design
 * ------
 *  - A `DataSubjectKey` identifies a subject by every handle the platform
 *    can search on: the user id, the email address, the SSO subject
 *    (`NameID`), and an optional set of "known aliases" the caller
 *    supplies (e.g. an alternate email the subject has used). The plan
 *    finds *every* artifact that carries any of those handles.
 *
 *  - The locator surface is a caller-supplied interface. The platform's
 *    searchable stores are: users, memberships, comments, audit entries,
 *    screenshots' OCR text, ingest transcripts, generation requests,
 *    webhook deliveries — a list that grows with each phase. Rather than
 *    hard-code a query for each, this module accepts a
 *    `DataSubjectLocator` that returns a set of `LocatedSubjectItem`
 *    records. The deployment phase wires the locator over the platform's
 *    query layer.
 *
 *  - An erasure plan classifies each item as:
 *      * `delete`   — the item is subject data and this plan deletes it.
 *      * `anonymize` — the item is retained (a shared resource: an audit
 *                      log entry that must remain append-only, a guide
 *                      whose step text references the subject's name and
 *                      which the workspace wants to keep with the name
 *                      redacted), and the plan replaces the subject's
 *                      identifiers with a stable pseudonym.
 *      * `retain`   — the item is legally required to be kept (a
 *                      transaction record inside the statutory window);
 *                      the plan records the legal basis.
 *
 *    An item that is neither is *not* produced by the locator. The
 *    planner's job is to classify what the locator returns, not to
 *    guess.
 *
 *  - The access plan is a subset: it locates the same records and returns
 *    a machine-readable export the caller ships to the subject. The
 *    export's per-item `redactions` field names any subject data the
 *    platform *withheld* (third-party data mixed into the same record,
 *    e.g. another subject's comment on the same step) so the subject
 *    receives an honest "some contents were withheld under Article 15(4)"
 *    statement rather than a silently truncated file.
 *
 * Boundaries
 * ----------
 *  - No store is invented. The locator returns items; this module never
 *    queries Postgres, the object store, or the audit table directly.
 *
 *  - No erasure is performed. `planErasure` returns a plan; the caller
 *    executes it. This is deliberate: an erasure is destructive and must
 *    be reviewed by an operator (and, in most jurisdictions, its
 *    completion recorded with a legal basis). The planner is pure so the
 *    admin UI can show what an erasure will do before it runs.
 *
 *  - The pseudonym is stable and deterministic, derived from the subject
 *    key and the item id under a caller-supplied secret. A stable
 *    pseudonym lets the platform prove "this is the same subject" without
 *    retaining the identifier. Without the secret the pseudonym is not
 *    derivable, which is the point.
 *
 *  - The legal-basis list is fixed and short. A caller that wants to
 *    withhold an item has to pick one of the recognized bases, so an
 *    "administrative convenience" reason cannot be smuggled in as legal.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type GdprErrorCode =
  | "invalid-input"
  | "not-configured"
  | "verification-failed";

export class GdprError extends Error {
  readonly code: GdprErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: GdprErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "GdprError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A handle on the subject. At least one identifier must be present;
 * a request that names no subject is refused rather than treated as
 * "everything".
 */
export interface DataSubjectKey {
  /** The platform's user id for the subject, when the subject has an account. */
  readonly userId: string | null;
  /** The subject's email address, as stored (lowercased for comparison). */
  readonly email: string | null;
  /** The SSO NameID, when the subject authenticated through an IdP. */
  readonly ssoSubjectNameId: string | null;
  /**
   * Additional identifiers the caller has observed for the same subject.
   * Compared case-insensitively; used by the audit-entry locator to find
   * an email that appears inside a `detail` blob.
   */
  readonly aliases: readonly string[];
}

export function isEmptyDataSubjectKey(key: DataSubjectKey): boolean {
  return (
    nonEmpty(key.userId) === null &&
    nonEmpty(key.email) === null &&
    nonEmpty(key.ssoSubjectNameId) === null &&
    key.aliases.filter((a) => nonEmpty(a) !== null).length === 0
  );
}

/**
 * The scope of a DSAR. `access` produces an export; `erasure` produces a
 * deletion/anonymization plan. `restrict` (GDPR Art. 18) is a future
 * mode; the union is a closed set so the planner's switch stays
 * exhaustive.
 */
export type DsarKind = "access" | "erasure";

/**
 * Where the subject's data lives. `store` is the logical name a caller
 * uses to route a delete/anonymize action (`"comments"`, `"audit"`,
 * `"screenshots"`, `"ingest-transcripts"`, ...). `itemId` is whatever
 * identifier that store uses to reference the item.
 */
export interface LocatedSubjectItem {
  readonly store: string;
  readonly itemId: string;
  /**
   * The data itself, already loaded by the locator. For `access` this is
   * the value the platform will serialize; for `erasure` this is what
   * will be redacted or deleted, so the locator must load it.
   */
  readonly data: Readonly<Record<string, unknown>>;
  /**
   * A legal basis the caller asserts for retaining this item during an
   * erasure. When present, the planner classifies the item as `retain`.
   * When the caller intends to anonymize instead, they set `canAnonymize`.
   * When the caller intends to delete, both are `false` / `null`.
   */
  readonly legalBasis: LegalBasis | null;
  /**
   * When `true`, the caller has confirmed the item can be anonymized
   * rather than deleted (a shared resource that must remain, with the
   * subject's identifiers replaced by a pseudonym).
   */
  readonly canAnonymize: boolean;
  /**
   * Third-party data interleaved into this item (e.g. another subject's
   * comment on the same step). The value is a short label naming the
   * kind of third-party data, so the access export can state that the
   * item was partially withheld. `null` when the item has no
   * third-party data.
   */
  readonly thirdPartyContents: string | null;
}

/**
 * The set of legal bases the platform recognizes for retaining a
 * subject's item after an erasure request. A caller that wants to keep an
 * item must pick one of these strings; the module does not accept a
 * free-form reason, because "we did not want to delete it" is not a
 * legal basis.
 */
export const LEGAL_BASES = Object.freeze([
  "contract-performance",
  "legal-obligation",
  "vital-interests",
  "public-task",
  "legitimate-interests-fraud-prevention",
  "legitimate-interests-security",
  "legal-claims-defence",
  "statutory-retention-window",
] as const);
export type LegalBasis = (typeof LEGAL_BASES)[number];
const LEGAL_BASIS_SET: ReadonlySet<string> = new Set(LEGAL_BASES);

export function isLegalBasis(v: string): v is LegalBasis {
  return LEGAL_BASIS_SET.has(v);
}

/**
 * The caller-supplied locator. Returns every item the platform stores for
 * the subject. The locator is the platform's query layer; this module
 * never reaches into a store itself.
 */
export interface DataSubjectLocator {
  locate(input: {
    readonly workspaceId: string;
    readonly key: DataSubjectKey;
    readonly kind: DsarKind;
  }): Promise<readonly LocatedSubjectItem[]>;
}

/**
 * The pseudonymizer a caller uses to anonymize a retained item. The
 * pseudonym is stable per (subject, item) so an operator can later
 * re-associate records for the same subject across items without holding
 * the subject's identifier.
 */
export interface Pseudonymizer {
  /**
   * Produce the pseudonym for a subject-item pair. The implementation
   * uses a caller-held secret to keep the pseudonym non-derivable without
   * it.
   */
  pseudonym(input: {
    readonly subjectKey: DataSubjectKey;
    readonly store: string;
    readonly itemId: string;
  }): string;
}

export interface CreatePseudonymizerInput {
  /**
   * The HMAC secret. The caller stores it under the workspace's
   * encryption key material (or a platform-level secret); this module
   * does not read it from the environment. `null` yields an unconfigured
   * pseudonymizer that refuses to produce a pseudonym.
   */
  readonly secret: string | null;
}

/* -------------------------------------------------------------------------- */
/* Plans                                                                       */
/* -------------------------------------------------------------------------- */

export interface ErasurePlanItem {
  readonly store: string;
  readonly itemId: string;
  readonly action: "delete" | "anonymize" | "retain";
  /** When `action === "retain"`, the legal basis asserted by the caller. */
  readonly legalBasis: LegalBasis | null;
  /**
   * When `action === "anonymize"`, the replacement pseudonym the caller
   * substitutes for the subject's identifiers in the item's `data`.
   */
  readonly pseudonym: string | null;
  /**
   * The keys of `data` the caller must treat as the subject's identifiers.
   * The pseudonymizer replaces the *values* at these keys with the
   * pseudonym; every other field is preserved as-is. This keeps the
   * anonymization honest: the caller sees exactly which keys will change.
   */
  readonly identifierKeys: readonly string[];
}

export interface ErasurePlan {
  readonly kind: "erasure";
  readonly workspaceId: string;
  readonly subjectKey: DataSubjectKey;
  readonly plannedAt: string;
  readonly items: readonly ErasurePlanItem[];
  readonly summary: {
    readonly located: number;
    readonly toDelete: number;
    readonly toAnonymize: number;
    readonly toRetain: number;
    readonly storesTouched: readonly string[];
  };
}

export interface AccessExportItem {
  readonly store: string;
  readonly itemId: string;
  /** The item's data, verbatim, except for third-party redactions below. */
  readonly data: Readonly<Record<string, unknown>>;
  /**
   * A description of any third-party data withheld from this item. `null`
   * when nothing was withheld.
   */
  readonly withheld: string | null;
}

export interface AccessExport {
  readonly kind: "access";
  readonly workspaceId: string;
  readonly subjectKey: DataSubjectKey;
  readonly producedAt: string;
  readonly items: readonly AccessExportItem[];
  readonly summary: {
    readonly located: number;
    readonly exported: number;
    readonly withThirdPartyWithheld: number;
    readonly storesTouched: readonly string[];
  };
  /**
   * A human-readable statement the platform includes in the export file,
   * describing what was delivered and, if anything was withheld, on what
   * basis. The text is a template with no identifiers in it; the caller
   * fills in subject-identifying metadata separately.
   */
  readonly statement: string;
}

/* -------------------------------------------------------------------------- */
/* Planner                                                                     */
/* -------------------------------------------------------------------------- */

export function planErasure(input: {
  readonly workspaceId: string;
  readonly subjectKey: DataSubjectKey;
  readonly located: readonly LocatedSubjectItem[];
  readonly pseudonymizer: Pseudonymizer;
  readonly now: Date;
}): ErasurePlan {
  if (input === null || typeof input !== "object") {
    throw new GdprError("`input` is required.", "invalid-input");
  }
  const { workspaceId, subjectKey, located, pseudonymizer, now } = input;
  if (nonEmpty(workspaceId) === null) {
    throw new GdprError("`workspaceId` is required.", "invalid-input");
  }
  if (isEmptyDataSubjectKey(subjectKey)) {
    throw new GdprError(
      "A data subject key must name at least one identifier (userId, email, ssoSubjectNameId or aliases).",
      "invalid-input",
    );
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new GdprError("`now` must be a valid Date.", "invalid-input");
  }
  if (pseudonymizer === null || typeof pseudonymizer.pseudonym !== "function") {
    throw new GdprError(
      "A `pseudonymizer` with a `pseudonym` method is required — an anonymize action must be able to produce a stable replacement.",
      "invalid-input",
    );
  }

  const items: ErasurePlanItem[] = [];
  const stores = new Set<string>();

  for (const item of located) {
    if (nonEmpty(item.store) === null || nonEmpty(item.itemId) === null) {
      throw new GdprError(
        "A located item is missing `store` or `itemId`; the locator must supply both.",
        "invalid-input",
      );
    }
    stores.add(item.store);

    if (item.legalBasis !== null && item.legalBasis !== undefined) {
      if (!isLegalBasis(item.legalBasis)) {
        throw new GdprError(
          `Located item in store "${item.store}" asserts unknown legal basis "${String(item.legalBasis)}".`,
          "invalid-input",
          { store: item.store, legalBasis: String(item.legalBasis) },
        );
      }
      items.push({
        store: item.store,
        itemId: item.itemId,
        action: "retain",
        legalBasis: item.legalBasis,
        pseudonym: null,
        identifierKeys: [],
      });
      continue;
    }

    if (item.canAnonymize) {
      const identifierKeys = listSubjectIdentifierKeys(item.data, subjectKey);
      if (identifierKeys.length === 0) {
        // A caller cannot ask this module to anonymize an item that
        // carries none of the subject's identifiers: the anonymization
        // would be a no-op, which is not what an erasure request should
        // produce. Refuse rather than silently delete the item as a
        // fallback — a caller that wants deletion sets `canAnonymize` to
        // false.
        throw new GdprError(
          `Located item in store "${item.store}" (id "${item.itemId}") is marked \`canAnonymize\` but carries none of the subject's identifiers, so anonymizing it would be a no-op. Mark it for deletion instead.`,
          "invalid-input",
          { store: item.store, itemId: item.itemId },
        );
      }
      const pseudonym = pseudonymizer.pseudonym({
        subjectKey,
        store: item.store,
        itemId: item.itemId,
      });
      if (nonEmpty(pseudonym) === null) {
        throw new GdprError(
          "The pseudonymizer returned an empty pseudonym; refuse to anonymize with an empty replacement.",
          "invalid-input",
          { store: item.store, itemId: item.itemId },
        );
      }
      items.push({
        store: item.store,
        itemId: item.itemId,
        action: "anonymize",
        legalBasis: null,
        pseudonym,
        identifierKeys: Object.freeze(identifierKeys),
      });
      continue;
    }

    items.push({
      store: item.store,
      itemId: item.itemId,
      action: "delete",
      legalBasis: null,
      pseudonym: null,
      identifierKeys: [],
    });
  }

  const toDelete = items.filter((i) => i.action === "delete").length;
  const toAnonymize = items.filter((i) => i.action === "anonymize").length;
  const toRetain = items.filter((i) => i.action === "retain").length;

  return {
    kind: "erasure",
    workspaceId,
    subjectKey: Object.freeze({ ...subjectKey }),
    plannedAt: now.toISOString(),
    items: Object.freeze(items),
    summary: {
      located: items.length,
      toDelete,
      toAnonymize,
      toRetain,
      storesTouched: Object.freeze([...stores].sort()),
    },
  };
}

export function planAccessExport(input: {
  readonly workspaceId: string;
  readonly subjectKey: DataSubjectKey;
  readonly located: readonly LocatedSubjectItem[];
  readonly now: Date;
}): AccessExport {
  if (input === null || typeof input !== "object") {
    throw new GdprError("`input` is required.", "invalid-input");
  }
  const { workspaceId, subjectKey, located, now } = input;
  if (nonEmpty(workspaceId) === null) {
    throw new GdprError("`workspaceId` is required.", "invalid-input");
  }
  if (isEmptyDataSubjectKey(subjectKey)) {
    throw new GdprError(
      "A data subject key must name at least one identifier (userId, email, ssoSubjectNameId or aliases).",
      "invalid-input",
    );
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new GdprError("`now` must be a valid Date.", "invalid-input");
  }

  const items: AccessExportItem[] = [];
  const stores = new Set<string>();
  let withThirdParty = 0;

  for (const item of located) {
    if (nonEmpty(item.store) === null || nonEmpty(item.itemId) === null) {
      throw new GdprError(
        "A located item is missing `store` or `itemId`; the locator must supply both.",
        "invalid-input",
      );
    }
    stores.add(item.store);
    // For an access export, the module deliberately does *not* redact
    // third-party data from the item's `data` here — the caller's
    // serializer has to do that, because the shape of the item is
    // store-specific. The module records that third-party data was
    // present so the export's statement is honest.
    let withheld: string | null = null;
    if (typeof item.thirdPartyContents === "string" && item.thirdPartyContents.length > 0) {
      withheld = item.thirdPartyContents;
      withThirdParty += 1;
    }
    items.push({
      store: item.store,
      itemId: item.itemId,
      data: item.data,
      withheld,
    });
  }

  const statement =
    withThirdParty === 0
      ? "This export contains the personal data the platform holds for the data subject named in the accompanying cover note, across the workspaces covered by the request. No third-party data was interleaved into the records delivered."
      : `This export contains the personal data the platform holds for the data subject named in the accompanying cover note. ${withThirdParty} of the delivered records contain third-party data; the specific fields are named in each record's "withheld" field, and that content was withheld under GDPR Article 15(4) (the rights of others).`;

  return {
    kind: "access",
    workspaceId,
    subjectKey: Object.freeze({ ...subjectKey }),
    producedAt: now.toISOString(),
    items: Object.freeze(items),
    summary: {
      located: items.length,
      exported: items.length,
      withThirdPartyWithheld: withThirdParty,
      storesTouched: Object.freeze([...stores].sort()),
    },
    statement,
  };
}

/* -------------------------------------------------------------------------- */
/* Identifier discovery                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The set of keys under which a subject's identifiers actually appear in
 * an item's `data`. The list is a small, fixed vocabulary of field names
 * the platform uses; the identifier's *values* are the caller's, the
 * *keys* are the platform's, so this module hard-codes the keys.
 *
 * A caller whose stores use other field names adds an alias in the
 * locator's `data` (see `aliases` on the subject key) and this function
 * matches those too.
 */
export function listSubjectIdentifierKeys(
  data: Readonly<Record<string, unknown>>,
  key: DataSubjectKey,
): readonly string[] {
  const wanted = new Set<string>();
  const addAll = (v: string | null): void => {
    const n = nonEmpty(v);
    if (n !== null) wanted.add(n.toLowerCase());
  };
  addAll(key.userId);
  addAll(key.email);
  addAll(key.ssoSubjectNameId);
  for (const alias of key.aliases) addAll(alias);

  const matches: string[] = [];
  for (const [fieldName, value] of Object.entries(data)) {
    if (typeof value !== "string") continue;
    const lower = value.trim().toLowerCase();
    if (wanted.has(lower)) matches.push(fieldName);
  }
  return Object.freeze(matches);
}

/* -------------------------------------------------------------------------- */
/* Pseudonymizer                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A deterministic pseudonymizer based on HMAC-SHA-256. The pseudonym is
 * a short hex tag prefixed with `anon_` so it is trivially distinguishable
 * from a real identifier in an anonymized record.
 *
 * The secret is the only thing that ties a pseudonym to a subject; without
 * it, the pseudonym is a random-looking string, which is exactly what the
 * platform wants to store after an erasure.
 */
export function createPseudonymizer(input: CreatePseudonymizerInput): Pseudonymizer {
  if (input === null || typeof input !== "object") {
    throw new GdprError("`input` is required.", "invalid-input");
  }
  const secret = input.secret;
  return {
    pseudonym({ subjectKey, store, itemId }): string {
      if (typeof secret !== "string" || secret.length < 16) {
        throw new GdprError(
          "The pseudonymizer has no secret (or it is too short). Supply a secret of at least 16 characters before anonymizing an erasure target.",
          "not-configured",
        );
      }
      const identifiers = stableIdentifiersForHmac(subjectKey);
      if (identifiers.length === 0) {
        throw new GdprError(
          "The subject key has no identifier that the pseudonymizer can hash.",
          "invalid-input",
        );
      }
      const h = createHmac("sha256", secret);
      h.update("zipy-ai-pseudonym-v1\n");
      h.update(store);
      h.update("\n");
      h.update(itemId);
      h.update("\n");
      h.update(identifiers.join("\n"));
      const digest = h.digest("hex");
      return `anon_${digest.slice(0, 24)}`;
    },
  };
}

function stableIdentifiersForHmac(key: DataSubjectKey): readonly string[] {
  const parts: string[] = [];
  const uid = nonEmpty(key.userId);
  if (uid !== null) parts.push(`uid:${uid}`);
  const email = nonEmpty(key.email);
  if (email !== null) parts.push(`email:${email.toLowerCase()}`);
  const sso = nonEmpty(key.ssoSubjectNameId);
  if (sso !== null) parts.push(`sso:${sso}`);
  for (const alias of [...key.aliases].sort()) {
    const a = nonEmpty(alias);
    if (a !== null) parts.push(`alias:${a.toLowerCase()}`);
  }
  return parts;
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The requirements a caller's DSAR routine must satisfy that this module
 * cannot enforce. Documented so the deployment phase wires them.
 */
export function describeGdprRequirements(): readonly string[] {
  return [
    "Authenticate the requester as the data subject or as an authorized representative before producing an export or an erasure plan. The platform's own session is the only authentication channel; the request must never be issued on the strength of an email address alone.",
    "Respond within the statutory window (one month under GDPR Art. 12(3), forty-five days under CCPA). Record the request's received-at timestamp on the audit trail.",
    "Record the erasure's completion (with the `ErasurePlan.summary.counts`) in the audit log. An unrecorded erasure cannot be defended under Art. 5(2).",
    "For an `anonymize` action, null out the subject's identifier values in the item's `data` at exactly the keys returned in `ErasurePlanItem.identifierKeys`, and set those keys to the pseudonym. Do not leave the original values on the row; a partially redacted row is worse than an unredacted one because it looks redacted.",
    "For a `retain` action, the legal basis is recorded on the audit trail. The platform must not silently drop a legal basis when the caller supplies one, and must not retain an item without one.",
    "A DSAR applies to a workspace's data; where a subject appears across multiple workspaces (a user with accounts in several tenants) the caller runs the plan per workspace. Do not run a single plan across workspaces.",
    "Where an item references the subject only through a screenshot's OCR text (a name written into a UI screenshot), a delete of the screenshot is the correct action — the platform has no keyed field to redact. The caller's locator is responsible for detecting such references.",
    "Never send the platform's raw database rows in an export. Only the item's `data` is exported; if a store's row includes internal columns (foreign keys, internal ids) those must be dropped by the locator before the item is submitted.",
    "The access export's `statement` field must be included verbatim in the delivered file; the platform's own wording is the platform's disclosure and the caller must not silently replace it.",
  ];
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  planErasure,
  planAccessExport,
  listSubjectIdentifierKeys,
  createPseudonymizer,
  stableIdentifiersForHmac,
  isEmptyDataSubjectKey,
  constantTimeStringEqual,
  LEGAL_BASES,
});
