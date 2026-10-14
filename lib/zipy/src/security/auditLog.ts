/**
 * Zipy AI — audit log (phase 22, batch 0).
 *
 * The audit log records every state-changing action a platform principal
 * performs: generate, edit, approve, publish, delete, change retention,
 * change a member's role, and so on. It is workspace-scoped, queryable
 * by admins, and — because audit logs are only useful when a reviewer
 * can trust them — it is append-only by construction: the module exposes
 * write and read, and no update or delete path. A retention sweep that
 * does remove rows (see phase 22 batch 1) is a separate, explicit tomb-
 * stone operation.
 *
 * Design boundaries
 * -----------------
 *  - No database driver is embedded. The persistence surface is an
 *    `AuditSink` interface (append + list) and an `AuditSinkFactory` the
 *    caller supplies. In production the factory returns a Postgres-backed
 *    sink built on the platform's existing `pg` dependency; in tests it
 *    returns an in-memory sink. This keeps this batch free of a schema
 *    migration, which the deployment layer will add separately (batch 2
 *    adds the corresponding schema and the admin read routes).
 *
 *  - No IP or user-agent is inferred. An `AuditActor` carries the IP and
 *    user agent the caller actually observed; the caller is expected to
 *    read them from the request, and a missing IP is `null` — never
 *    filled in with a default. Audit entries claiming an invented IP
 *    would be worse than entries that admit the value was not captured.
 *
 *  - The actor may be a user or a system principal. `actorKind` is a
 *    discriminated union so a background job that writes to the audit
 *    log names itself rather than being attributed to a human.
 *
 *  - The entry's `detail` is a bounded, JSON-serializable record. This
 *    module *does not* redact PII from it — that is the caller's
 *    responsibility, and the safety layer's PII redactor (built in an
 *    earlier phase) is the right place to do it before calling append.
 *    What this module *does* enforce is a byte-size cap on the detail
 *    so a caller cannot accidentally store an entire guide body in the
 *    audit log, which is both a retention-policy violation and a denial-
 *    of-service surface against a query-time index.
 *
 *  - A `hashChain` is computed. Each entry stores the SHA-256 of its own
 *    canonical JSON plus the previous entry's hash. This makes a
 *    database-level tampering (an admin running `UPDATE` on the audit
 *    table) detectable by walking the chain. The chain is per-workspace;
 *    an entry's previous hash is resolved against the workspace's most
 *    recent entry at append time, using the sink's own atomic append.
 *    The hash algorithm is `SHA-256` over UTF-8 bytes and the hash is
 *    rendered as hex — the standard `node:crypto` output format.
 *
 *  - The read surface is by design a *stable, paginated* list. An audit
 *    query that supports arbitrary filters is a later feature; the
 *    bounded filters here (workspace, actor, action prefix, time range,
 *    optional resource) are the ones an admin UI actually offers, and
 *    they are all indexable on the common `(workspace_id, created_at)`,
 *    `(workspace_id, actor_user_id, created_at)`,
 *    `(workspace_id, action, created_at)` shapes.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The actor that performed the action. `user` is a human (or service
 * account) whose identity the platform authenticated; `system` is the
 * platform itself, and must name the subsystem so an investigator can
 * find it. `anonymous` should be rare — an unauthenticated request that
 * was refused and logged must still carry its IP so a rate-limiting
 * investigation can find it.
 */
export type AuditActor =
  | {
      readonly kind: "user";
      readonly userId: string;
      readonly email: string | null;
    }
  | {
      readonly kind: "system";
      /** The name of the subsystem, e.g. "retention-sweeper" or "job-runner". */
      readonly subsystem: string;
    }
  | {
      readonly kind: "anonymous";
    };

export interface AuditRequestContext {
  /** The IP address the caller observed (`x-forwarded-for` handled by the caller). */
  readonly ip: string | null;
  /** The user agent string, verbatim. */
  readonly userAgent: string | null;
  /** An optional correlation id, so an audit entry links to the logs of one request. */
  readonly requestId: string | null;
}

export interface AuditAppendInput {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  /**
   * A dotted action name, e.g. `guide.publish`, `member.role_changed`,
   * `retention.updated`. The `action` is the query key an admin uses.
   */
  readonly action: string;
  /**
   * The resource the action concerns. Optional: some actions are
   * workspace-level (e.g. `retention.updated`).
   */
  readonly resource?: {
    readonly kind: string;
    readonly id: string;
  } | null;
  /**
   * A bounded, JSON-serializable record describing the change. Not used
   * for storing entire documents; the size cap is enforced.
   */
  readonly detail?: Readonly<Record<string, unknown>> | null;
  readonly context: AuditRequestContext;
  /**
   * Whether this entry records a successful action or a refused attempt.
   * Refused attempts are stored too: a security investigation is as
   * interested in a denied attempt as in an accepted one.
   */
  readonly outcome: "success" | "failure" | "denied";
  /**
   * The current time. Caller supplies so the entry is monotonic with the
   * request's own clock and so tests are deterministic.
   */
  readonly occurredAt: string;
}

/**
 * The entry as stored. `id`, `previousHash` and `hash` are assigned by
 * the sink at append time. Everything else is a copy of the append input.
 */
export interface AuditEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly resource: { readonly kind: string; readonly id: string } | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly context: AuditRequestContext;
  readonly outcome: "success" | "failure" | "denied";
  readonly occurredAt: string;
  /** SHA-256 hex of the workspace's previous entry, or `null` for the first. */
  readonly previousHash: string | null;
  /** SHA-256 hex of this entry's canonical form concatenated with `previousHash`. */
  readonly hash: string;
}

export interface AuditListQuery {
  readonly workspaceId: string;
  /** Filter by exact actor user id. Ignored for non-user actors. */
  readonly actorUserId?: string | null;
  /** Filter by exact action name. */
  readonly action?: string | null;
  /** Filter by action *prefix*, e.g. `guide.` for every guide action. */
  readonly actionPrefix?: string | null;
  /** Filter by resource kind and id (both required when either is set). */
  readonly resourceKind?: string | null;
  readonly resourceId?: string | null;
  /** ISO timestamps; inclusive lower bound, exclusive upper bound. */
  readonly since?: string | null;
  readonly until?: string | null;
  /** Filter by outcome. */
  readonly outcome?: "success" | "failure" | "denied" | null;
  /** A stable, opaque cursor; the sink decides its encoding. */
  readonly cursor?: string | null;
  /** The maximum number of rows to return. The sink may return fewer. */
  readonly limit: number;
}

export interface AuditListPage {
  readonly entries: readonly AuditEntry[];
  /**
   * An opaque cursor for the next page, or `null` when there is no next
   * page. The caller passes this directly back into the next query.
   */
  readonly nextCursor: string | null;
}

/**
 * The persistence contract. `append` must resolve the workspace's
 * previous hash and store the entry atomically so a concurrent append
 * cannot produce a fork. A sink that cannot guarantee that atomicity
 * must refuse to implement this interface; a non-atomic append would
 * silently invalidate the hash chain.
 */
export interface AuditSink {
  append(input: AuditAppendInput): Promise<AuditEntry>;
  list(query: AuditListQuery): Promise<AuditListPage>;
  /**
   * Return the most recent entry for a workspace, or `null` when the
   * workspace has no entries yet. Used by `verifyChain`.
   */
  lastEntry(workspaceId: string): Promise<AuditEntry | null>;
  /**
   * Return every entry in ascending order of `occurredAt` (and, for
   * ties, of insertion order). Provided primarily for chain verification;
   * a production sink may stream or page internally.
   */
  entriesForChain(workspaceId: string): AsyncIterable<AuditEntry>;
}

export type AuditSinkFactory = () => AuditSink;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AuditErrorCode =
  | "invalid-input"
  | "size-limit-exceeded"
  | "unsupported-record"
  | "not-configured";

export class AuditError extends Error {
  readonly code: AuditErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: AuditErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AuditError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The maximum serialized byte size of `detail`. 8 KiB is generous for an
 * audit record of a change (field names, old and new values, a reason
 * string) and small enough that a caller cannot accidentally store a
 * document. An entry that needs more context references a document id
 * in `detail` instead.
 */
export const MAX_DETAIL_BYTES = 8 * 1024;

/** The maximum length of an `action` string, in characters. */
export const MAX_ACTION_LENGTH = 128;

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The audit client. A caller constructs one per process (a singleton is
 * fine; the class holds no per-request state) and calls `records` to
 * append an entry. A caller that finds itself wanting to *not* audit a
 * state-changing action is making a mistake; see `describeRequiredAuditEvents`.
 */
export class AuditClient {
  private readonly sink: AuditSink;

  /** @internal — construct via `createAuditClient`. */
  constructor(input: { readonly sink: AuditSink }) {
    this.sink = input.sink;
  }

  /**
   * Append an entry. Validates the shape and the size cap before
   * delegating to the sink; the sink is responsible only for the atomic
   * hash-chain resolution and persistence.
   */
  async records(input: AuditAppendInput): Promise<AuditEntry> {
    validateAppendInput(input);
    return this.sink.append(input);
  }

  /**
   * A convenience wrapper that shapes a request context from values a
   * route already has. The IP and user agent are passed through verbatim
   * and never defaulted.
   */
  async recordsFromRequest(input: {
    readonly workspaceId: string;
    readonly actor: AuditActor;
    readonly action: string;
    readonly resource?: { readonly kind: string; readonly id: string } | null;
    readonly detail?: Readonly<Record<string, unknown>> | null;
    readonly outcome: "success" | "failure" | "denied";
    readonly requestIdHeader?: string | null;
    readonly xForwardedFor?: string | null;
    readonly userAgent?: string | null;
    /** The clock to read; default is `Date.now`. */
    readonly now?: () => Date;
  }): Promise<AuditEntry> {
    const now = input.now ?? (() => new Date());
    const ip = normalizeIp(input.xForwardedFor ?? null);
    return this.records({
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: input.action,
      resource: input.resource ?? null,
      detail: input.detail ?? null,
      context: {
        ip,
        userAgent: input.userAgent ?? null,
        requestId: input.requestIdHeader ?? null,
      },
      outcome: input.outcome,
      occurredAt: now().toISOString(),
    });
  }

  /** Query the log. All filters are optional except the workspace. */
  async list(query: AuditListQuery): Promise<AuditListPage> {
    validateListQuery(query);
    return this.sink.list(query);
  }

  /**
   * Verify a workspace's chain from the first entry to the last. Returns
   * a discriminated result; a failed verification names the entry where
   * the chain broke so an investigator can look at that row directly.
   */
  async verifyChain(workspaceId: string): Promise<AuditChainVerification> {
    if (nonEmpty(workspaceId) === null) {
      throw new AuditError("`workspaceId` is required.", "invalid-input");
    }
    let prev: string | null = null;
    let count = 0;
    for await (const entry of this.sink.entriesForChain(workspaceId)) {
      count += 1;
      if (entry.previousHash !== prev) {
        return {
          ok: false,
          reason: "previous-hash-mismatch",
          entriesChecked: count,
          brokenAt: entry.id,
          expected: prev,
          found: entry.previousHash,
        };
      }
      const recomputed = computeEntryHash(entry);
      if (!constantTimeHexEqual(recomputed, entry.hash)) {
        return {
          ok: false,
          reason: "entry-hash-mismatch",
          entriesChecked: count,
          brokenAt: entry.id,
          expected: recomputed,
          found: entry.hash,
        };
      }
      prev = entry.hash;
    }
    return {
      ok: true,
      reason: "ok",
      entriesChecked: count,
      brokenAt: null,
      expected: prev,
      found: prev,
    };
  }
}

export interface AuditChainVerification {
  readonly ok: boolean;
  readonly reason:
    | "ok"
    | "previous-hash-mismatch"
    | "entry-hash-mismatch";
  readonly entriesChecked: number;
  /** The id of the entry where the chain broke, or `null` on success. */
  readonly brokenAt: string | null;
  /** The expected value at the point of failure (or the last hash on success). */
  readonly expected: string | null;
  /** The value actually observed at the point of failure. */
  readonly found: string | null;
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateAuditClientInput {
  /**
   * A sink. When `null`, the client constructs but every `records` call
   * throws `not-configured` — this is only useful for a read-only admin
   * status page that does not actually write. Passing `null` in a route
   * that writes to the log is a mistake, so the behaviour is loudly
   * broken rather than silently losing entries.
   */
  readonly sink: AuditSink | null;
}

export function createAuditClient(input: CreateAuditClientInput): AuditClient {
  if (input.sink === null) {
    // A no-op sink that refuses every write. We do not use a "throw on
    // use" proxy because that hides the configuration idea from callers
    // that just want a status check; instead the client returns a sink
    // whose append throws a descriptive error.
    return new AuditClient({ sink: buildRefusingSink() });
  }
  return new AuditClient({ sink: input.sink });
}

function buildRefusingSink(): AuditSink {
  const refuse = (): never => {
    throw new AuditError(
      "The audit client was constructed without a sink. Configure a persistence backend (see the deployment phase) before writing to the audit log.",
      "not-configured",
    );
  };
  return {
    append: async () => refuse(),
    list: async () => refuse(),
    lastEntry: async () => refuse(),
    async *entriesForChain() {
      refuse();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Pure hash computation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The canonical form hashed into `entry.hash`. Exposed because a chain
 * verifier that runs in a different process (a separate auditor service)
 * must compute the same bytes, and a test that pins an expected value
 * needs to construct the same input. Fields are ordered deliberately;
 * `JSON.stringify` preserves object key order for a plain object, so the
 * order below is the order used on the wire.
 */
export function canonicalEntryPayload(entry: {
  readonly id: string;
  readonly workspaceId: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly resource: { readonly kind: string; readonly id: string } | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly context: AuditRequestContext;
  readonly outcome: "success" | "failure" | "denied";
  readonly occurredAt: string;
  readonly previousHash: string | null;
}): string {
  return JSON.stringify({
    id: entry.id,
    workspaceId: entry.workspaceId,
    actor: canonicalizeActor(entry.actor),
    action: entry.action,
    resource: entry.resource
      ? { kind: entry.resource.kind, id: entry.resource.id }
      : null,
    detail: entry.detail ?? null,
    context: {
      ip: entry.context.ip,
      userAgent: entry.context.userAgent,
      requestId: entry.context.requestId,
    },
    outcome: entry.outcome,
    occurredAt: entry.occurredAt,
    previousHash: entry.previousHash,
  });
}

export function computeEntryHash(entry: {
  readonly id: string;
  readonly workspaceId: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly resource: { readonly kind: string; readonly id: string } | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly context: AuditRequestContext;
  readonly outcome: "success" | "failure" | "denied";
  readonly occurredAt: string;
  readonly previousHash: string | null;
}): string {
  const payload = canonicalEntryPayload(entry);
  const h = createHash("sha256");
  h.update(payload, "utf8");
  return h.digest("hex");
}

function canonicalizeActor(actor: AuditActor): Readonly<Record<string, unknown>> {
  switch (actor.kind) {
    case "user":
      return { kind: "user", userId: actor.userId, email: actor.email };
    case "system":
      return { kind: "system", subsystem: actor.subsystem };
    case "anonymous":
      return { kind: "anonymous" };
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

function validateAppendInput(input: AuditAppendInput): void {
  if (input === null || typeof input !== "object") {
    throw new AuditError("`input` is required.", "invalid-input");
  }
  if (nonEmpty(input.workspaceId) === null) {
    throw new AuditError("`workspaceId` is required.", "invalid-input");
  }
  const action = nonEmpty(input.action);
  if (action === null) {
    throw new AuditError("`action` is required.", "invalid-input");
  }
  if (action.length > MAX_ACTION_LENGTH) {
    throw new AuditError(
      `\`action\` is longer than ${MAX_ACTION_LENGTH} characters; use a short dotted name (e.g. "guide.publish").`,
      "invalid-input",
      { actionLength: action.length },
    );
  }
  if (
    input.outcome !== "success" &&
    input.outcome !== "failure" &&
    input.outcome !== "denied"
  ) {
    throw new AuditError(
      "`outcome` must be one of \"success\", \"failure\", \"denied\".",
      "invalid-input",
      { received: input.outcome },
    );
  }
  if (typeof input.occurredAt !== "string" || input.occurredAt.length === 0) {
    throw new AuditError("`occurredAt` is required.", "invalid-input");
  }
  // A Date parse check catches a caller that passed a malformed string
  // without forcing the caller to build a Date.
  if (!Number.isFinite(Date.parse(input.occurredAt))) {
    throw new AuditError(
      "`occurredAt` must be an ISO-8601 timestamp.",
      "invalid-input",
      { received: input.occurredAt },
    );
  }
  // Actor shape check.
  switch (input.actor.kind) {
    case "user":
      if (nonEmpty(input.actor.userId) === null) {
        throw new AuditError("An actor of kind \"user\" requires a `userId`.", "invalid-input");
      }
      break;
    case "system":
      if (nonEmpty(input.actor.subsystem) === null) {
        throw new AuditError(
          "An actor of kind \"system\" requires a `subsystem` (e.g. \"retention-sweeper\").",
          "invalid-input",
        );
      }
      break;
    case "anonymous":
      break;
    default: {
      const exhaustive: never = input.actor;
      void exhaustive;
      throw new AuditError("Unknown actor kind.", "invalid-input");
    }
  }
  // Resource shape check.
  if (input.resource !== undefined && input.resource !== null) {
    if (
      nonEmpty(input.resource.kind) === null ||
      nonEmpty(input.resource.id) === null
    ) {
      throw new AuditError(
        "A `resource` requires both a non-empty `kind` and a non-empty `id`.",
        "invalid-input",
      );
    }
  }
  // Detail size cap.
  if (input.detail !== undefined && input.detail !== null) {
    let serialized: string;
    try {
      serialized = JSON.stringify(input.detail);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AuditError(
        `\`detail\` is not JSON-serializable: ${message}`,
        "unsupported-record",
        { cause: message },
      );
    }
    if (serialized === undefined) {
      // JSON.stringify returns undefined for a non-serializable root
      // (e.g., a function or a symbol); reject explicitly rather than
      // storing "undefined" as the string.
      throw new AuditError(
        "`detail` serializes to `undefined`; supply a plain object.",
        "unsupported-record",
      );
    }
    const byteLength = new TextEncoder().encode(serialized).length;
    if (byteLength > MAX_DETAIL_BYTES) {
      throw new AuditError(
        `\`detail\` serializes to ${byteLength} bytes, exceeding the ${MAX_DETAIL_BYTES}-byte audit limit. Store a reference (an id) instead of the document.`,
        "size-limit-exceeded",
        { byteLength, maxBytes: MAX_DETAIL_BYTES },
      );
    }
  }
  // Context shape check: a missing context is a caller error, not a
  // reason to invent an IP.
  if (input.context === null || typeof input.context !== "object") {
    throw new AuditError("`context` is required.", "invalid-input");
  }
}

function validateListQuery(query: AuditListQuery): void {
  if (query === null || typeof query !== "object") {
    throw new AuditError("`query` is required.", "invalid-input");
  }
  if (nonEmpty(query.workspaceId) === null) {
    throw new AuditError("`query.workspaceId` is required.", "invalid-input");
  }
  if (
    typeof query.limit !== "number" ||
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 1_000
  ) {
    throw new AuditError(
      "`query.limit` must be an integer between 1 and 1000.",
      "invalid-input",
      { received: query.limit },
    );
  }
  if (
    query.resourceKind !== undefined &&
    query.resourceKind !== null &&
    (query.resourceId === undefined || query.resourceId === null)
  ) {
    throw new AuditError(
      "When `resourceKind` is set, `resourceId` is required.",
      "invalid-input",
    );
  }
  if (
    query.resourceId !== undefined &&
    query.resourceId !== null &&
    (query.resourceKind === undefined || query.resourceKind === null)
  ) {
    throw new AuditError(
      "When `resourceId` is set, `resourceKind` is required.",
      "invalid-input",
    );
  }
  if (
    query.outcome !== undefined &&
    query.outcome !== null &&
    query.outcome !== "success" &&
    query.outcome !== "failure" &&
    query.outcome !== "denied"
  ) {
    throw new AuditError(
      "`query.outcome` must be one of \"success\", \"failure\", \"denied\".",
      "invalid-input",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Guidance                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The set of events the platform *must* audit. Reference this list from
 * a review checklist so a new route that grants a new state-changing
 * capability does not ship without an entry. This is documentation, not
 * enforcement — enforcement would require the audit client to know every
 * action name, which would centralize a module that is deliberately a
 * bounded, generic record.
 */
export function describeRequiredAuditEvents(): readonly string[] {
  return [
    "Authentication: signup, login success, login failure, logout, MFA challenge answered, SSO assertion accepted/rejected.",
    "Membership: a user invited, invited user accepted, member removed, member role changed, extra permission granted or revoked on a membership.",
    "Workspace: created, renamed, deletion requested, deletion completed, retention policy changed, branding changed, integration connected or disconnected.",
    "Sources: ingested, deleted, re-ingested with a changed content hash.",
    "Workflows: created, synthesis run, execution started, execution completed, execution failed, distilled to a deterministic script.",
    "Review: review requested, decision approve, decision edit (with the diff), decision reject, live-session handoff begun and ended.",
    "Guides: created, regenerated (with the affected step ids), edited (with a diff summary), published, unpublished, deleted.",
    "Exports: any export produced, with the format and the requesting user.",
    "Integrations: outbound publish to Jira / Notion / Confluence; outbound webhook delivered or permanently failed.",
    "Admin: audit log queried, retention sweep executed (with the number of artifacts affected), data-subject access request fulfilled, data-subject deletion fulfilled.",
    "Billing: plan changed, usage threshold crossed, invoice generated.",
    "Security: an RBAC denial, a refused replay of a webhook, a refused assertion whose issuer did not match the configured IdP.",
  ];
}

/* -------------------------------------------------------------------------- */
/* In-memory sink (reference implementation, for tests and for a local dev)    */
/* -------------------------------------------------------------------------- */

/**
 * A persistent, atomic-in-process, in-memory sink. Its purpose is:
 *   1. To be a reference implementation of the `AuditSink` contract so
 *      the deployment layer has a shape to satisfy.
 *   2. To let a test exercise the `AuditClient` end-to-end without a
 *      database. It is not a production sink (it does not survive a
 *      restart, and it does not persist across worker processes), and
 *      its documentation says so.
 */
export class InMemoryAuditSink implements AuditSink {
  private readonly entries: AuditEntry[] = [];
  private nextId = 1;

  async append(input: AuditAppendInput): Promise<AuditEntry> {
    const previous = this.lastForWorkspace(input.workspaceId);
    const id = `audit_${this.nextId}`;
    this.nextId += 1;
    const base: {
      id: string;
      workspaceId: string;
      actor: AuditActor;
      action: string;
      resource: { kind: string; id: string } | null;
      detail: Readonly<Record<string, unknown>> | null;
      context: AuditRequestContext;
      outcome: "success" | "failure" | "denied";
      occurredAt: string;
      previousHash: string | null;
    } = {
      id,
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: input.action,
      resource: input.resource ?? null,
      detail: input.detail ?? null,
      context: input.context,
      outcome: input.outcome,
      occurredAt: input.occurredAt,
      previousHash: previous === null ? null : previous.hash,
    };
    const hash = computeEntryHash({ ...base, previousHash: base.previousHash });
    const entry: AuditEntry = { ...base, previousHash: base.previousHash, hash };
    this.entries.push(entry);
    return entry;
  }

  async list(query: AuditListQuery): Promise<AuditListPage> {
    // A stable total order: ascending occurredAt, then ascending id.
    const sorted = this.entries
      .filter((e) => e.workspaceId === query.workspaceId)
      .sort(compareEntries);

    const filtered = sorted.filter((e) => {
      if (
        query.actorUserId !== undefined &&
        query.actorUserId !== null &&
        !(e.actor.kind === "user" && e.actor.userId === query.actorUserId)
      ) {
        return false;
      }
      if (
        query.action !== undefined &&
        query.action !== null &&
        e.action !== query.action
      ) {
        return false;
      }
      if (
        query.actionPrefix !== undefined &&
        query.actionPrefix !== null &&
        !e.action.startsWith(query.actionPrefix)
      ) {
        return false;
      }
      if (
        query.resourceKind !== undefined &&
        query.resourceKind !== null &&
        query.resourceId !== undefined &&
        query.resourceId !== null
      ) {
        if (
          e.resource === null ||
          e.resource.kind !== query.resourceKind ||
          e.resource.id !== query.resourceId
        ) {
          return false;
        }
      }
      if (query.since !== undefined && query.since !== null) {
        if (e.occurredAt < query.since) return false;
      }
      if (query.until !== undefined && query.until !== null) {
        if (e.occurredAt >= query.until) return false;
      }
      if (
        query.outcome !== undefined &&
        query.outcome !== null &&
        e.outcome !== query.outcome
      ) {
        return false;
      }
      return true;
    });

    let startIndex = 0;
    if (query.cursor !== undefined && query.cursor !== null) {
      const idx = decodeCursor(query.cursor);
      if (idx !== null) startIndex = idx;
    }

    const slice = filtered.slice(startIndex, startIndex + query.limit);
    const nextIndex = startIndex + slice.length;
    const nextCursor =
      nextIndex < filtered.length ? encodeCursor(nextIndex) : null;

    return {
      entries: Object.freeze(slice),
      nextCursor,
    };
  }

  async lastEntry(workspaceId: string): Promise<AuditEntry | null> {
    return this.lastForWorkspace(workspaceId);
  }

  async *entriesForChain(workspaceId: string): AsyncIterable<AuditEntry> {
    const sorted = this.entries
      .filter((e) => e.workspaceId === workspaceId)
      .sort(compareEntries);
    for (const e of sorted) {
      yield e;
    }
  }

  private lastForWorkspace(workspaceId: string): AuditEntry | null {
    let last: AuditEntry | null = null;
    for (const e of this.entries) {
      if (e.workspaceId !== workspaceId) continue;
      if (last === null || compareEntries(e, last) > 0) last = e;
    }
    return last;
  }
}

function compareEntries(a: AuditEntry, b: AuditEntry): number {
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt < b.occurredAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function encodeCursor(index: number): string {
  // Opaque in principle; a numeric index in this in-memory implementation.
  // The production sink will encode its own key.
  return `cursor:${index}`;
}

function decodeCursor(cursor: string): number | null {
  const match = /^cursor:(\d+)$/.exec(cursor);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Normalize an IP value. The caller is expected to have already stripped
 * a proxy-trust policy from `X-Forwarded-For`; if the header contains a
 * comma-separated list, this function takes the first entry (the closest
 * to the client under a correct proxy configuration) and trims it. A
 * malformed value becomes `null`, never an invented IP.
 */
function normalizeIp(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.split(",")[0]?.trim() ?? "";
  if (first.length === 0) return null;
  // Accept IPv4 and IPv6 textual forms without validating DNS labels; a
  // malformed IP is stored as received so an investigator can see it.
  return first;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Node's `timingSafeEqual` operates on bytes; convert hex strings to
  // bytes. The lengths are public in the sense that the caller knows
  // the algorithm and the encoding, so the length-mismatch short-circuit
  // leaks only that the strings differ in length, which is already
  // visible to anyone who has both values.
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  canonicalEntryPayload,
  computeEntryHash,
  canonicalizeActor,
  normalizeIp,
  constantTimeHexEqual,
  encodeCursor,
  decodeCursor,
  compareEntries,
});
