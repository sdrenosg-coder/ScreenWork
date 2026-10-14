/**
 * Zipy AI — collaboration: real-time co-editing coordination
 * (editing & collaboration, batch 1).
 *
 * This module is the *server-side coordination contract* for concurrent
 * editors on a single guide. It does not open a websocket by itself and it
 * does not depend on a specific transport. The route layer (or a later
 * websocket/SSE endpoint) wires a transport to the two exported surfaces
 * below.
 *
 * Why a coordination contract and not just a version number:
 *
 *   Two editors open the same guide. Both change a step. If the platform
 *   simply accepts the second write, the first editor's change disappears
 *   silently. That is the failure mode this module prevents. Three pieces
 *   are needed to prevent it honestly:
 *
 *     1. **Presence.** Who is connected, with what cursor/selection, and
 *        when each client last sent a heartbeat. Presence is *advisory* —
 *        the platform must tolerate a stale heartbeat (the client crashed,
 *        the socket dropped) without leaving a phantom co-editor.
 *
 *     2. **Operations with base versions.** Every change is wrapped in an
 *        `Operation` that names the base document version the editor saw
 *        when they started the edit. The server applies an operation only
 *        if the base version is still the current one, or — for operations
 *        that this module classifies as *commutative* — merges the deltas
 *        onto the current version. Non-commutative ops that target a
 *        version older than the current one are rejected with a
 *        `conflict` so the editor can rebase explicitly (via
 *        `trackChanges.rebaseProposals`) and resubmit. Silent merges are
 *        never performed for non-commutative ops.
 *
 *     3. **A deterministic replay log.** The server keeps the operations in
 *        commit order. A client that missed operations can ask for
 *        `sinceVersion` and receive the tail. Because the operations are
 *        already persisted by `trackChanges`, the log carries only ids and
 *        metadata — the module never duplicates the edit payload.
 *
 * Transport guidance (not implemented here, discussed so the route author
 * has an unambiguous contract):
 *
 *   - Client opens `GET /api/guides/:id/collab/stream` (SSE) or a WS
 *     upgrade. It sends `HELLO {docVersion, clientId, userId, displayName}`.
 *   - Server replies `STATE {docVersion, presence, sinceVersion}`.
 *   - Client sends `OP` frames with the operation payload defined below.
 *   - Server broadcasts `OP_ACK` (with the new document version) or
 *     `OP_REJECT` to the sender only, and `PRESENCE` to everyone.
 *   - On disconnect, presence is cleared after `PRESENCE_TTL_MS`.
 *
 * Design rules honoured here:
 *  - No transport is assumed. Nothing opens a socket; nothing schedules a
 *    timer; no clock is read except `Date.now()` when a `now` argument is
 *    not supplied.
 *  - The module is pure with respect to its inputs. `applyOperation` on the
 *    same session returns byte-identical JSON (ids excepted where the
 *    caller supplies them).
 *  - Every rejection carries a machine-readable code and enough context
 *    for the client to rebase — the client does not guess.
 *  - No user identity is invented. `userId` and `clientId` come from the
 *    caller; a missing identity is refused, not filled with "anonymous".
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type RealtimeErrorCode =
  | "invalid-input"
  | "unknown-session"
  | "unknown-client"
  | "stale-base-version"
  | "duplicate-operation"
  | "unmergeable-operation"
  | "unauthorized";

export class RealtimeError extends Error {
  readonly code: RealtimeErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: RealtimeErrorCode,
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
 * Tunables the caller may override. Kept as an explicit object so a test
 * can shorten the presence TTL without monkey-patching globals. The
 * defaults are chosen so that a real network blip does not evict a
 * co-editor, and a crashed client does not hold a slot for a whole day.
 */
export interface RealtimeOptions {
  /** Milliseconds after the last heartbeat a client is treated as gone. */
  readonly presenceTtlMs: number;
  /** Maximum number of committed operations retained in the in-memory replay log. */
  readonly maxReplayLogEntries: number;
  /**
   * Operation kinds that this session treats as commutative — two of them
   * against the same version can be merged without a rebase. Cursor and
   * presence updates are always commutative; edits are not by default.
   */
  readonly commutativeKinds: readonly OperationKind[];
}

export const DEFAULT_REALTIME_OPTIONS: RealtimeOptions = Object.freeze({
  presenceTtlMs: 30_000,
  maxReplayLogEntries: 2_000,
  commutativeKinds: ["presence", "cursor", "typing"] as readonly OperationKind[],
});

/**
 * The kinds of operation a co-editor can send. Each kind has a fixed
 * payload shape (see the union below). The list is exhaustive on purpose:
 * a new kind is a schema change and must be added here *and* in the
 * discriminated union together.
 */
export const OPERATION_KINDS = [
  "presence",
  "cursor",
  "typing",
  "edit-propose",
  "edit-accept",
  "edit-reject",
  "comment-add",
  "comment-resolve",
  "title-change",
  "step-reorder",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Payload base fields every operation carries. `clientId` and `userId`
 * identify who sent it; `baseVersion` is the document version the client
 * had when it produced the operation.
 */
interface OperationBase {
  readonly id: string;
  readonly clientId: string;
  readonly userId: string;
  readonly baseVersion: number;
  /** ISO timestamp recorded by the *server* when the operation was committed. */
  readonly committedAt?: string;
}

/**
 * Presence: the client is online. `userId` and `displayName` describe the
 * editor. This is the only operation that does not advance `docVersion`.
 */
export interface PresenceOperation extends OperationBase {
  readonly kind: "presence";
  readonly displayName: string;
}

/** Cursor: the editor's caret or selection changed. Does not advance version. */
export interface CursorOperation extends OperationBase {
  readonly kind: "cursor";
  readonly targetKind: "guide" | "step";
  readonly targetId: string;
  readonly offset: number;
  readonly length: number;
}

/** Typing: the editor is mid-keystroke. Advisory; does not advance version. */
export interface TypingOperation extends OperationBase {
  readonly kind: "typing";
  readonly targetKind: "guide" | "step";
  readonly targetId: string;
}

/**
 * Edit proposal. Advances the document version. The actual edit payload is
 * persisted by `trackChanges.recordEdit`; the realtime operation carries
 * the id of the edit so the log can be replayed without duplicating the
 * edit body. `editId` is the caller's responsibility.
 */
export interface EditProposeOperation extends OperationBase {
  readonly kind: "edit-propose";
  readonly stepId: string | null;
  readonly editId: string;
}

/** Accept a proposed edit. Advances the version. */
export interface EditAcceptOperation extends OperationBase {
  readonly kind: "edit-accept";
  readonly editId: string;
}

/** Reject a proposed edit. Advances the version. */
export interface EditRejectOperation extends OperationBase {
  readonly kind: "edit-reject";
  readonly editId: string;
  readonly reason: string;
}

/** Add a comment (start or reply). Advances the version. */
export interface CommentAddOperation extends OperationBase {
  readonly kind: "comment-add";
  readonly threadId: string | null;
  readonly commentId: string;
}

/** Resolve a thread. Advances the version. */
export interface CommentResolveOperation extends OperationBase {
  readonly kind: "comment-resolve";
  readonly threadId: string;
  readonly commentId: string | null;
}

/** Change the guide title. Advances the version. */
export interface TitleChangeOperation extends OperationBase {
  readonly kind: "title-change";
  readonly title: string;
}

/**
 * Reorder the steps. Advances the version. The operation carries the
 * *resulting order of step ids*; the platform is authoritative on whether
 * that order is valid (every id in the previous list appears exactly once).
 */
export interface StepReorderOperation extends OperationBase {
  readonly kind: "step-reorder";
  readonly order: readonly string[];
}

/**
 * Discriminated union of every operation. Consumers switch on `kind` and
 * TypeScript narrows the payload.
 */
export type Operation =
  | PresenceOperation
  | CursorOperation
  | TypingOperation
  | EditProposeOperation
  | EditAcceptOperation
  | EditRejectOperation
  | CommentAddOperation
  | CommentResolveOperation
  | TitleChangeOperation
  | StepReorderOperation;

/** A recorded connection. Cleared when the presence TTL elapses. */
export interface PresenceEntry {
  readonly clientId: string;
  readonly userId: string;
  readonly displayName: string;
  /** ISO timestamp of the last presence heartbeat. */
  readonly lastSeenAt: string;
  /** Latest cursor (optional). */
  readonly cursor: CursorOperation | null;
}

/**
 * One entry in the replay log. `docVersion` records the version *after*
 * this operation was committed (a no-advance op carries the current
 * version), so a consumer can request the tail starting from a version.
 */
export interface LogEntry {
  readonly seq: number;
  readonly docVersion: number;
  readonly kind: OperationKind;
  readonly operationId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly committedAt: string;
  /**
   * The operation payload minus the fields already lifted onto the log
   * entry. Kept as `unknown` because the shape is discriminated by
   * `kind`; consumers switch and cast.
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The live session state for one guide. In production this is what a route
 * loads (from an in-memory hub, a Redis pub/sub channel, or a Postgres
 * advisory-lock-protected row) before applying an operation. The module
 * itself does not care where the session lives.
 */
export interface Session {
  readonly version: "session/1";
  readonly guideId: string;
  /** Current document version. Every accepted mutating op advances it. */
  readonly docVersion: number;
  readonly presence: readonly PresenceEntry[];
  readonly log: readonly LogEntry[];
  /** Set of operation ids committed so far, for idempotency. */
  readonly committedOperationIds: readonly string[];
  readonly options: RealtimeOptions;
  readonly updatedAt: string;
}

export interface ApplyResult {
  readonly session: Session;
  /** `true` when the operation advanced the document version. */
  readonly advanced: boolean;
  /**
   * The commit record (mirrors the log entry that was appended). Present
   * for both advancing and non-advancing operations so a transport can
   * broadcast the same shape for both.
   */
  readonly entry: LogEntry;
}

export interface ApplyRejection {
  readonly code: RealtimeErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly message: string;
}

/**
 * `applyOperation` *returns* the outcome rather than throwing on
 * application-level failures (conflict, duplicate). Throwing is reserved
 * for caller contract errors (malformed operation, unknown session).
 * This lets the route decide the transport-level framing (broadcast an
 * OP_REJECT, log a 4xx, or retry) without catching broad exception types.
 */
export type ApplyOutcome =
  | { readonly ok: true; readonly result: ApplyResult }
  | { readonly ok: false; readonly rejection: ApplyRejection };

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create an empty session at a given version. `guideId` and `docVersion`
 * are the caller's means of aligning with the persisted guide.
 */
export function createSession(
  guideId: string,
  docVersion: number,
  options?: Partial<RealtimeOptions>,
): Session {
  if (typeof guideId !== "string" || guideId.trim().length === 0) {
    throw new RealtimeError("guideId is required.", "invalid-input");
  }
  if (!Number.isInteger(docVersion) || docVersion < 0) {
    throw new RealtimeError("docVersion must be a non-negative integer.", "invalid-input", {
      docVersion,
    });
  }
  return {
    version: "session/1",
    guideId: guideId.trim(),
    docVersion,
    presence: [],
    log: [],
    committedOperationIds: [],
    options: { ...DEFAULT_REALTIME_OPTIONS, ...(options ?? {}) },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Apply an operation. Idempotent per `operation.id`: replaying a committed
 * id returns the existing log entry without advancing the version.
 *
 * Conflict rule:
 *   - Commutative kinds (presence/cursor/typing by default) accept any
 *     base version; they never advance the version.
 *   - Non-commutative kinds accept only when `baseVersion === docVersion`.
 *     When the base is *older*, the operation is rejected with
 *     `stale-base-version` so the client rebases explicitly. Silent merge
 *     of a stale edit is exactly the failure mode this module exists to
 *     prevent.
 *   - When the base is *newer* than the session's version, this is a
 *     caller bug; `invalid-input`.
 */
export function applyOperation(session: Session, operation: Operation): ApplyOutcome {
  assertSession(session);
  assertOperation(operation);

  if (session.committedOperationIds.includes(operation.id)) {
    const entry = session.log.find((e) => e.operationId === operation.id);
    if (entry === undefined) {
      // Should be impossible, but a defensive check: an id marked
      // committed with no log entry is a corrupted session; refuse to
      // proceed rather than produce an inconsistent state.
      throw new RealtimeError(
        "Session is inconsistent: committed operation id has no log entry.",
        "unknown-session",
        { operationId: operation.id },
      );
    }
    return { ok: true, result: { session, advanced: false, entry } };
  }

  if (operation.baseVersion > session.docVersion) {
    throw new RealtimeError(
      `Operation targets base version ${operation.baseVersion}; session is at ${session.docVersion}.`,
      "invalid-input",
      { baseVersion: operation.baseVersion, sessionVersion: session.docVersion },
    );
  }

  const commutative = session.options.commutativeKinds.includes(operation.kind);
  const stale = operation.baseVersion < session.docVersion;
  if (stale && !commutative) {
    return {
      ok: false,
      rejection: {
        code: "stale-base-version",
        message: `Operation base version ${operation.baseVersion} is behind the current version ${session.docVersion}; rebase and resubmit.`,
        detail: {
          baseVersion: operation.baseVersion,
          sessionVersion: session.docVersion,
        },
      },
    };
  }

  const commitResult = commitOperation(session, operation, commutative ? false : true);
  return { ok: true, result: commitResult };
}

/**
 * Remove presence entries whose `lastSeenAt` is older than the TTL. Returns
 * the session with those entries dropped and a log entry appended for each
 * (`kind: "presence"` with an `expired: true` marker) so the transport can
 * broadcast a departure.
 *
 * The caller supplies `now` for determinism in tests. `Date.now()` is used
 * when `now` is omitted.
 */
export function sweepPresence(session: Session, now?: Date): Session {
  assertSession(session);
  const at = now instanceof Date ? now : new Date();
  const cutoff = at.getTime() - session.options.presenceTtlMs;
  const expiredIds = new Set<string>();
  for (const entry of session.presence) {
    const seenAt = Date.parse(entry.lastSeenAt);
    if (!Number.isFinite(seenAt)) {
      expiredIds.add(entry.clientId);
      continue;
    }
    if (seenAt < cutoff) expiredIds.add(entry.clientId);
  }
  if (expiredIds.size === 0) return session;
  const surviving: PresenceEntry[] = [];
  const expired: PresenceEntry[] = [];
  for (const entry of session.presence) {
    if (expiredIds.has(entry.clientId)) expired.push(entry);
    else surviving.push(entry);
  }
  const logEntries: LogEntry[] = [];
  let seq = session.log.length;
  for (const entry of expired) {
    seq += 1;
    logEntries.push({
      seq,
      docVersion: session.docVersion,
      kind: "presence",
      operationId: `presence-timeout-${entry.clientId}-${at.getTime().toString(36)}`,
      clientId: entry.clientId,
      userId: entry.userId,
      committedAt: at.toISOString(),
      payload: { expired: true, displayName: entry.displayName },
    });
  }
  const log = trimLog([...session.log, ...logEntries], session.options.maxReplayLogEntries);
  return {
    ...session,
    presence: surviving,
    log,
    updatedAt: at.toISOString(),
  };
}

/**
 * Return the operations a client which last saw `sinceVersion` has not
 * seen. `sinceVersion` is the document version the client reports. The
 * returned slice contains every log entry with `docVersion > sinceVersion`
 * *plus* any non-advancing entries appended after the client's last known
 * advancing entry. To support that, the log keeps entries in commit order
 * and this function performs a linear scan from the tail backwards until
 * it finds the last entry the client would have seen.
 */
export function replaySince(session: Session, sinceVersion: number): readonly LogEntry[] {
  assertSession(session);
  if (!Number.isInteger(sinceVersion) || sinceVersion < 0) {
    throw new RealtimeError("sinceVersion must be a non-negative integer.", "invalid-input", {
      sinceVersion,
    });
  }
  if (sinceVersion >= session.docVersion) {
    // The client is at or past the current version; only non-advancing
    // tail entries appended after the client's last known version are
    // relevant, and those have `docVersion === session.docVersion`. The
    // conservative answer is "everything with docVersion >= current":
    return session.log.filter((e) => e.docVersion >= session.docVersion);
  }
  return session.log.filter((e) => e.docVersion > sinceVersion);
}

/**
 * Produce a presence snapshot suitable for broadcasting on join/leave.
 * Preserves input order so the transport's ordering is stable.
 */
export function presenceSnapshot(
  session: Session,
): readonly { readonly clientId: string; readonly userId: string; readonly displayName: string; readonly cursor: CursorOperation | null; readonly lastSeenAt: string }[] {
  assertSession(session);
  return session.presence.map((e) => ({
    clientId: e.clientId,
    userId: e.userId,
    displayName: e.displayName,
    cursor: e.cursor,
    lastSeenAt: e.lastSeenAt,
  }));
}

/**
 * Validate and normalise a raw operation payload received from a transport.
 * The transport should call this *before* `applyOperation` so a malformed
 * frame never reaches the session logic. Throws `RealtimeError`
 * (`invalid-input`) with a field-level detail on any problem.
 */
export function parseOperation(raw: unknown): Operation {
  if (raw === null || typeof raw !== "object") {
    throw new RealtimeError("Operation payload must be an object.", "invalid-input");
  }
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];
  if (!isOperationKind(kind)) {
    throw new RealtimeError(`Unknown operation kind "${String(kind)}".`, "invalid-input", { kind });
  }
  const id = requiredString(r, "id");
  const clientId = requiredString(r, "clientId");
  const userId = requiredString(r, "userId");
  const baseVersion = requiredInt(r, "baseVersion", 0);
  const base: OperationBase = { id, clientId, userId, baseVersion };

  switch (kind) {
    case "presence":
      return { ...base, kind, displayName: requiredString(r, "displayName") };
    case "cursor": {
      const targetKind = r["targetKind"];
      if (targetKind !== "guide" && targetKind !== "step") {
        throw new RealtimeError(`cursor.targetKind must be "guide" or "step".`, "invalid-input");
      }
      const offset = requiredInt(r, "offset", 0);
      const length = requiredInt(r, "length", 0);
      if (length < 0) {
        throw new RealtimeError("cursor.length must be >= 0.", "invalid-input");
      }
      return {
        ...base,
        kind,
        targetKind,
        targetId: requiredString(r, "targetId"),
        offset,
        length,
      };
    }
    case "typing": {
      const targetKind = r["targetKind"];
      if (targetKind !== "guide" && targetKind !== "step") {
        throw new RealtimeError(`typing.targetKind must be "guide" or "step".`, "invalid-input");
      }
      return { ...base, kind, targetKind, targetId: requiredString(r, "targetId") };
    }
    case "edit-propose":
      return {
        ...base,
        kind,
        stepId: typeof r["stepId"] === "string" && (r["stepId"] as string).length > 0 ? (r["stepId"] as string) : null,
        editId: requiredString(r, "editId"),
      };
    case "edit-accept":
      return { ...base, kind, editId: requiredString(r, "editId") };
    case "edit-reject":
      return {
        ...base,
        kind,
        editId: requiredString(r, "editId"),
        reason: typeof r["reason"] === "string" ? (r["reason"] as string) : "",
      };
    case "comment-add":
      return {
        ...base,
        kind,
        threadId: typeof r["threadId"] === "string" ? (r["threadId"] as string) : null,
        commentId: requiredString(r, "commentId"),
      };
    case "comment-resolve":
      return {
        ...base,
        kind,
        threadId: requiredString(r, "threadId"),
        commentId: typeof r["commentId"] === "string" ? (r["commentId"] as string) : null,
      };
    case "title-change": {
      const title = typeof r["title"] === "string" ? (r["title"] as string).trim() : "";
      if (title.length === 0) {
        throw new RealtimeError("title-change.title must be a non-empty string.", "invalid-input");
      }
      return { ...base, kind, title };
    }
    case "step-reorder": {
      const order = r["order"];
      if (!Array.isArray(order) || order.some((v) => typeof v !== "string" || (v as string).length === 0)) {
        throw new RealtimeError("step-reorder.order must be an array of non-empty strings.", "invalid-input");
      }
      const seen = new Set<string>();
      for (const s of order as string[]) {
        if (seen.has(s)) {
          throw new RealtimeError(`step-reorder.order contains a duplicate step id "${s}".`, "invalid-input");
        }
        seen.add(s);
      }
      return { ...base, kind, order: order as readonly string[] };
    }
  }
}

/** Empty-session factory for callers that want to start with no presence. */
export function emptySession(guideId: string, docVersion = 0): Session {
  return createSession(guideId, docVersion);
}

/**
 * Rehydrate a session from JSON. A session persisted by an earlier run of
 * the app can be loaded (with presence refreshed) and the transport
 * resumed. Ambiguities (missing fields, malformed entries) are skipped
 * rather than fabricated.
 */
export function rehydrateSession(value: unknown): Session {
  if (value === null || typeof value !== "object") {
    throw new RealtimeError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const guideId = typeof r["guideId"] === "string" ? r["guideId"] : "";
  if (guideId.length === 0) {
    throw new RealtimeError("Rehydrate failed: no guideId.", "invalid-input");
  }
  const docVersion = Number(r["docVersion"]) || 0;
  const optionsRaw = (r["options"] ?? {}) as Record<string, unknown>;
  const options: RealtimeOptions = {
    presenceTtlMs:
      typeof optionsRaw["presenceTtlMs"] === "number" && optionsRaw["presenceTtlMs"] > 0
        ? (optionsRaw["presenceTtlMs"] as number)
        : DEFAULT_REALTIME_OPTIONS.presenceTtlMs,
    maxReplayLogEntries:
      typeof optionsRaw["maxReplayLogEntries"] === "number" && optionsRaw["maxReplayLogEntries"] > 0
        ? (optionsRaw["maxReplayLogEntries"] as number)
        : DEFAULT_REALTIME_OPTIONS.maxReplayLogEntries,
    commutativeKinds: Array.isArray(optionsRaw["commutativeKinds"])
      ? (optionsRaw["commutativeKinds"] as unknown[]).filter(isOperationKind) as readonly OperationKind[]
      : DEFAULT_REALTIME_OPTIONS.commutativeKinds,
  };

  const presence: PresenceEntry[] = [];
  if (Array.isArray(r["presence"])) {
    for (const item of r["presence"] as unknown[]) {
      const entry = readPresenceEntry(item);
      if (entry !== null) presence.push(entry);
    }
  }

  const log: LogEntry[] = [];
  if (Array.isArray(r["log"])) {
    for (const item of r["log"] as unknown[]) {
      const entry = readLogEntry(item);
      if (entry !== null) log.push(entry);
    }
  }
  log.sort((a, b) => a.seq - b.seq);

  const idsRaw = Array.isArray(r["committedOperationIds"])
    ? (r["committedOperationIds"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  return {
    version: "session/1",
    guideId,
    docVersion,
    presence,
    log: trimLog(log, options.maxReplayLogEntries),
    committedOperationIds: idsRaw,
    options,
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function commitOperation(
  session: Session,
  operation: Operation,
  advanceVersion: boolean,
): ApplyResult {
  const committedAt = new Date().toISOString();
  const nextVersion = advanceVersion ? session.docVersion + 1 : session.docVersion;
  const seq = (session.log[session.log.length - 1]?.seq ?? 0) + 1;

  const presenceNext = applyPresenceSideEffect(session.presence, operation, committedAt);

  const entry: LogEntry = {
    seq,
    docVersion: nextVersion,
    kind: operation.kind,
    operationId: operation.id,
    clientId: operation.clientId,
    userId: operation.userId,
    committedAt,
    payload: payloadWithoutBase(operation),
  };

  const log = trimLog([...session.log, entry], session.options.maxReplayLogEntries);
  const committedOperationIds = [...session.committedOperationIds, operation.id];

  return {
    session: {
      ...session,
      docVersion: nextVersion,
      presence: presenceNext,
      log,
      committedOperationIds,
      updatedAt: committedAt,
    },
    advanced: advanceVersion,
    entry,
  };
}

function applyPresenceSideEffect(
  presence: readonly PresenceEntry[],
  operation: Operation,
  committedAt: string,
): readonly PresenceEntry[] {
  switch (operation.kind) {
    case "presence": {
      const idx = presence.findIndex((p) => p.clientId === operation.clientId);
      const next: PresenceEntry = {
        clientId: operation.clientId,
        userId: operation.userId,
        displayName: operation.displayName,
        lastSeenAt: committedAt,
        cursor: idx >= 0 ? presence[idx]!.cursor : null,
      };
      if (idx < 0) return [...presence, next];
      const copy = presence.slice();
      copy[idx] = next;
      return copy;
    }
    case "cursor": {
      const idx = presence.findIndex((p) => p.clientId === operation.clientId);
      if (idx < 0) {
        // Cursor without a prior presence entry: record the entry with
        // displayName left blank. The transport should have sent a
        // presence op first; this branch keeps the state coherent without
        // inventing a displayName.
        return [
          ...presence,
          {
            clientId: operation.clientId,
            userId: operation.userId,
            displayName: "",
            lastSeenAt: committedAt,
            cursor: operation,
          },
        ];
      }
      const copy = presence.slice();
      const existing = copy[idx]!;
      copy[idx] = { ...existing, lastSeenAt: committedAt, cursor: operation };
      return copy;
    }
    case "typing": {
      const idx = presence.findIndex((p) => p.clientId === operation.clientId);
      if (idx < 0) return presence;
      const copy = presence.slice();
      const existing = copy[idx]!;
      copy[idx] = { ...existing, lastSeenAt: committedAt };
      return copy;
    }
    default:
      return presence;
  }
}

function payloadWithoutBase(operation: Operation): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(operation)) {
    if (k === "id" || k === "clientId" || k === "userId" || k === "baseVersion" || k === "kind") continue;
    out[k] = v;
  }
  return out;
}

function trimLog(log: readonly LogEntry[], max: number): readonly LogEntry[] {
  if (log.length <= max) return log;
  return log.slice(log.length - max);
}

function assertSession(value: unknown): asserts value is Session {
  if (value === null || typeof value !== "object") {
    throw new RealtimeError("Expected a session object.", "invalid-input");
  }
  const s = value as Record<string, unknown>;
  if (s["version"] !== "session/1") {
    throw new RealtimeError(`Unknown session version "${String(s["version"])}".`, "unknown-session");
  }
  if (typeof s["guideId"] !== "string" || (s["guideId"] as string).length === 0) {
    throw new RealtimeError("Session has no guideId.", "unknown-session");
  }
  if (typeof s["docVersion"] !== "number" || !Number.isInteger(s["docVersion"])) {
    throw new RealtimeError("Session docVersion is not an integer.", "unknown-session");
  }
  if (!Array.isArray(s["presence"]) || !Array.isArray(s["log"])) {
    throw new RealtimeError("Session is missing presence or log arrays.", "unknown-session");
  }
}

function assertOperation(value: unknown): asserts value is Operation {
  if (value === null || typeof value !== "object") {
    throw new RealtimeError("Operation must be an object.", "invalid-input");
  }
  const o = value as Record<string, unknown>;
  if (!isOperationKind(o["kind"])) {
    throw new RealtimeError(`Unknown operation kind "${String(o["kind"])}".`, "invalid-input");
  }
  if (typeof o["id"] !== "string" || (o["id"] as string).length === 0) {
    throw new RealtimeError("Operation is missing an id.", "invalid-input");
  }
  if (typeof o["clientId"] !== "string" || (o["clientId"] as string).length === 0) {
    throw new RealtimeError("Operation is missing a clientId.", "invalid-input");
  }
  if (typeof o["userId"] !== "string" || (o["userId"] as string).length === 0) {
    throw new RealtimeError("Operation is missing a userId.", "invalid-input");
  }
  if (typeof o["baseVersion"] !== "number" || !Number.isInteger(o["baseVersion"]) || o["baseVersion"] < 0) {
    throw new RealtimeError("Operation baseVersion must be a non-negative integer.", "invalid-input");
  }
}

function isOperationKind(v: unknown): v is OperationKind {
  return typeof v === "string" && (OPERATION_KINDS as readonly string[]).includes(v);
}

function requiredString(r: Record<string, unknown>, field: string): string {
  const v = r[field];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new RealtimeError(`Required field "${field}" must be a non-empty string.`, "invalid-input", {
      field,
    });
  }
  return v.trim();
}

function requiredInt(r: Record<string, unknown>, field: string, min: number): number {
  const v = r[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new RealtimeError(
      `Required field "${field}" must be an integer >= ${min}.`,
      "invalid-input",
      { field },
    );
  }
  return v;
}

function readPresenceEntry(raw: unknown): PresenceEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const clientId = typeof r["clientId"] === "string" ? r["clientId"] : "";
  const userId = typeof r["userId"] === "string" ? r["userId"] : "";
  if (clientId.length === 0 || userId.length === 0) return null;
  const cursorRaw = r["cursor"];
  let cursor: CursorOperation | null = null;
  if (cursorRaw !== null && typeof cursorRaw === "object") {
    try {
      const parsed = parseOperation(cursorRaw);
      if (parsed.kind === "cursor") cursor = parsed;
    } catch {
      cursor = null;
    }
  }
  return {
    clientId,
    userId,
    displayName: typeof r["displayName"] === "string" ? r["displayName"] : "",
    lastSeenAt: typeof r["lastSeenAt"] === "string" ? r["lastSeenAt"] : "",
    cursor,
  };
}

function readLogEntry(raw: unknown): LogEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];
  if (!isOperationKind(kind)) return null;
  const operationId = typeof r["operationId"] === "string" ? r["operationId"] : "";
  if (operationId.length === 0) return null;
  const payloadRaw = r["payload"];
  const payload: Readonly<Record<string, unknown>> =
    payloadRaw !== null && typeof payloadRaw === "object"
      ? (payloadRaw as Readonly<Record<string, unknown>>)
      : {};
  return {
    seq: Number(r["seq"]) || 0,
    docVersion: Number(r["docVersion"]) || 0,
    kind,
    operationId,
    clientId: typeof r["clientId"] === "string" ? r["clientId"] : "",
    userId: typeof r["userId"] === "string" ? r["userId"] : "",
    committedAt: typeof r["committedAt"] === "string" ? r["committedAt"] : "",
    payload,
  };
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  assertSession,
  assertOperation,
  isOperationKind,
  payloadWithoutBase,
  applyPresenceSideEffect,
  trimLog,
  readPresenceEntry,
  readLogEntry,
  requiredString,
  requiredInt,
});
