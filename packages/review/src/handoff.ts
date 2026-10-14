/**
 * Zipy AI — human-in-the-loop review: live browser handoff (phase 19, batch 0).
 *
 * Manages the lifecycle of a live browser session a reviewer can drive. A
 * handoff exists because some gates cannot be answered from a screenshot:
 * an MFA prompt, a CAPTCHA, or a decision that requires seeing the rendered
 * state after a large form is filled. The reviewer takes control of the
 * Playwright context, performs whatever the situation requires, then returns
 * control to the automation loop.
 *
 * Design boundaries:
 *
 *  - This module does *not* itself drive a browser. It models the *handoff
 *    protocol*: opening a session, attaching an operator, accepting the
 *    operator's "I'm done" signal, and closing. The Playwright driver is
 *    owned by the automation phase (`@zipy/automation/browser`); this module
 *    accepts an opaque `BrowserSessionHandle` the automation layer supplies.
 *    The interface is the contract; the transport is the automation layer's
 *    business.
 *
 *  - No session is fabricated. Every session opens against a supplied handle;
 *    the module refuses to invent a Playwright context id, a websocket URL,
 *    or a screenshot the automation layer did not capture.
 *
 *  - The protocol is *single-operator*. Concurrent operators on the same
 *    session are rejected so the audit trail cannot record a merge of two
 *    people's actions. A future multi-operator mode is a protocol change,
 *    not a config knob.
 *
 *  - The protocol is time-bounded. A handoff has a maximum duration; when it
 *    elapses without a return signal, the session is closed and the workflow
 *    is marked abandoned so a wedged browser does not hold the worker.
 *
 *  - The module never guesses at the reviewer's intent. It produces a
 *    `HandoffEvent` log entry for each lifecycle transition; the audit layer
 *    writes them. A close without a preceding return is recorded as `abandoned`,
 *    not as a success.
 *
 * The module exports:
 *   - `openHandoff` — start a handoff against a supplied session handle.
 *   - `attachOperator` — bind the authenticated reviewer to the session.
 *   - `signalReturn` — the operator's "I am done" signal.
 *   - `closeHandoff` — end the handoff, with a reason.
 *   - `summariseHandoff` — one-line human text for the review UI.
 *   - `rehydrateHandoff` — typed load of a persisted payload.
 *   - `__internals` — the transition validators and the timeout helper.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type HandoffErrorCode =
  | "invalid-input"
  | "illegal-transition"
  | "already-attached"
  | "not-attached"
  | "expired";

export class HandoffError extends Error {
  readonly code: HandoffErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: HandoffErrorCode,
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
 * The lifecycle phases a handoff moves through. `opening` is transient and
 * only appears if the caller constructed a handoff without a session handle
 * (which `openHandoff` rejects). Production handoffs move `opening` ->
 * `awaiting-operator` -> `under-control` -> `returning` -> `closed`.
 */
export const HANDOFF_PHASES = [
  "opening",
  "awaiting-operator",
  "under-control",
  "returning",
  "closed",
] as const;
export type HandoffPhase = (typeof HANDOFF_PHASES)[number];

/** The reason a handoff reached `closed`. */
export const HANDOFF_CLOSE_REASONS = [
  "returned-control",
  "abandoned",
  "expired",
  "error",
  "cancelled-by-reviewer",
] as const;
export type HandoffCloseReason = (typeof HANDOFF_CLOSE_REASONS)[number];

/**
 * The automation layer's opaque session handle. This module never inspects
 * its fields; it passes the object through to the returned session state so
 * the caller can route the operator's browser view.
 */
export interface BrowserSessionHandle {
  /** Stable identifier for the Playwright BrowserContext. */
  readonly contextId: string;
  /**
   * A value the caller's frontend will use to render the live view. The
   * automation layer supplies this; the module does not construct one.
   */
  readonly liveViewUrl: string | null;
  /** Optional hint at which page the browser is on, for the operator's UI. */
  readonly currentUrl: string | null;
}

/** One lifecycle transition the audit layer will write. */
export interface HandoffEvent {
  /** ISO timestamp the transition was recorded. */
  readonly at: string;
  readonly phase: HandoffPhase;
  readonly actorType: "system" | "reviewer";
  /** Reviewer id when `actorType` is "reviewer"; null otherwise. */
  readonly actorId: string | null;
  readonly detail: string;
}

export interface Handoff {
  readonly version: "handoff/1";
  readonly handoffId: string;
  readonly workflowId: string;
  readonly workspaceId: string;
  /** The gate whose approval is waiting on this handoff. Null if opened manually. */
  readonly gateId: string | null;
  readonly session: BrowserSessionHandle;
  readonly phase: HandoffPhase;
  /** Reviewer currently attached; null until `attachOperator` is called. */
  readonly operatorId: string | null;
  /** Reviewer user-agent string as the browser reported; used for audit only. */
  readonly operatorUserAgent: string | null;
  /** ISO timestamp the handoff opened. */
  readonly openedAt: string;
  /** ISO timestamp of the last transition; equals `openedAt` initially. */
  readonly updatedAt: string;
  /** ISO timestamp the handoff's maximum duration elapses. */
  readonly expiresAt: string;
  /** ISO timestamp the handoff closed; null while open. */
  readonly closedAt: string | null;
  readonly closeReason: HandoffCloseReason | null;
  readonly events: readonly HandoffEvent[];
}

export interface OpenHandoffInput {
  readonly workflowId: string;
  readonly workspaceId: string;
  readonly gateId?: string | null;
  readonly session: BrowserSessionHandle;
  /** Maximum duration of the handoff in milliseconds. Default 15 minutes. */
  readonly maxDurationMs?: number;
}

export interface AttachOperatorInput {
  readonly handoff: Handoff;
  readonly reviewerId: string;
  readonly userAgent?: string | null;
}

export interface SignalReturnInput {
  readonly handoff: Handoff;
  readonly reviewerId: string;
  /** Free-text note from the reviewer describing what they did. */
  readonly note?: string | null;
}

export interface CloseHandoffInput {
  readonly handoff: Handoff;
  readonly reason: HandoffCloseReason;
  /** Reviewer id when a person closed the handoff; null for system closes. */
  readonly reviewerId?: string | null;
  readonly detail?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_DURATION_MS = 15 * 60 * 1000;

/**
 * The minimum amount of time the automation layer should wait before it can
 * assume the operator's browser tab has connected. Not used by this module
 * directly; exported so the automation layer and this module agree on the
 * constant.
 */
export const HANDOFF_ATTACH_GRACE_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function openHandoff(input: OpenHandoffInput): Handoff {
  if (input === null || typeof input !== "object") {
    throw new HandoffError("openHandoff requires an inputs object.", "invalid-input");
  }
  if (typeof input.workflowId !== "string" || input.workflowId.length === 0) {
    throw new HandoffError("`workflowId` is required.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new HandoffError("`workspaceId` is required.", "invalid-input");
  }
  if (input.session === null || typeof input.session !== "object") {
    throw new HandoffError(
      "`session` is required; the automation layer must supply an existing browser context handle.",
      "invalid-input",
    );
  }
  if (typeof input.session.contextId !== "string" || input.session.contextId.length === 0) {
    throw new HandoffError("`session.contextId` is required.", "invalid-input");
  }

  const now = new Date();
  const duration = typeof input.maxDurationMs === "number" && Number.isFinite(input.maxDurationMs)
    ? Math.max(HANDOFF_ATTACH_GRACE_MS, Math.floor(input.maxDurationMs))
    : DEFAULT_MAX_DURATION_MS;
  const expiresAt = new Date(now.getTime() + duration).toISOString();

  const handoffId = `handoff_${fnv1a32(`${input.workflowId}|${input.workspaceId}|${input.session.contextId}|${now.toISOString()}`)
    .toString(16)
    .padStart(8, "0")}`;

  const events: HandoffEvent[] = [
    {
      at: now.toISOString(),
      phase: "awaiting-operator",
      actorType: "system",
      actorId: null,
      detail: `Handoff opened for workflow ${input.workflowId} against context ${input.session.contextId}.`,
    },
  ];

  return {
    version: "handoff/1",
    handoffId,
    workflowId: input.workflowId,
    workspaceId: input.workspaceId,
    gateId: nonEmpty(input.gateId),
    session: {
      contextId: input.session.contextId,
      liveViewUrl: nonEmpty(input.session.liveViewUrl),
      currentUrl: nonEmpty(input.session.currentUrl),
    },
    phase: "awaiting-operator",
    operatorId: null,
    operatorUserAgent: null,
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt,
    closedAt: null,
    closeReason: null,
    events: Object.freeze(events),
  };
}

export function attachOperator(input: AttachOperatorInput): Handoff {
  const h = requireOpen(input?.handoff, "attachOperator");
  if (typeof input.reviewerId !== "string" || input.reviewerId.length === 0) {
    throw new HandoffError("`reviewerId` is required.", "invalid-input");
  }
  if (h.operatorId !== null) {
    throw new HandoffError(
      `Handoff ${h.handoffId} already has operator "${h.operatorId}" attached.`,
      "already-attached",
      { handoffId: h.handoffId, existingOperatorId: h.operatorId },
    );
  }
  if (h.phase !== "awaiting-operator") {
    throw new HandoffError(
      `Cannot attach an operator in phase "${h.phase}"; expected "awaiting-operator".`,
      "illegal-transition",
      { handoffId: h.handoffId, phase: h.phase },
    );
  }
  const now = new Date().toISOString();
  return {
    ...h,
    phase: "under-control",
    operatorId: input.reviewerId,
    operatorUserAgent: nonEmpty(input.userAgent),
    updatedAt: now,
    events: appendEvent(h.events, {
      at: now,
      phase: "under-control",
      actorType: "reviewer",
      actorId: input.reviewerId,
      detail: `Reviewer "${input.reviewerId}" attached and took control of context ${h.session.contextId}.`,
    }),
  };
}

export function signalReturn(input: SignalReturnInput): Handoff {
  const h = requireOpen(input?.handoff, "signalReturn");
  if (typeof input.reviewerId !== "string" || input.reviewerId.length === 0) {
    throw new HandoffError("`reviewerId` is required.", "invalid-input");
  }
  if (h.operatorId === null) {
    throw new HandoffError(
      `Handoff ${h.handoffId} has no attached operator; a return signal requires one.`,
      "not-attached",
      { handoffId: h.handoffId },
    );
  }
  if (h.operatorId !== input.reviewerId) {
    throw new HandoffError(
      `Only the attached operator ("${h.operatorId}") may signal return; received "${input.reviewerId}".`,
      "illegal-transition",
      { handoffId: h.handoffId, expectedOperatorId: h.operatorId, receivedReviewerId: input.reviewerId },
    );
  }
  if (h.phase !== "under-control") {
    throw new HandoffError(
      `Cannot signal return in phase "${h.phase}"; expected "under-control".`,
      "illegal-transition",
      { handoffId: h.handoffId, phase: h.phase },
    );
  }
  const now = new Date();
  if (new Date(h.expiresAt).getTime() <= now.getTime()) {
    throw new HandoffError(
      `Handoff ${h.handoffId} expired at ${h.expiresAt}; the operator must reopen a session.`,
      "expired",
      { handoffId: h.handoffId, expiresAt: h.expiresAt },
    );
  }
  const detail = nonEmpty(input.note) ?? `Reviewer "${input.reviewerId}" handed control back.`;
  // Move through the intermediate `returning` phase for a moment so the log
  // records both the return and the subsequent close; the return signal does
  // not itself close the handoff — the caller closes it (usually with reason
  // `returned-control`) so the automation loop can resume before the close.
  return {
    ...h,
    phase: "returning",
    updatedAt: now.toISOString(),
    events: appendEvent(h.events, {
      at: now.toISOString(),
      phase: "returning",
      actorType: "reviewer",
      actorId: input.reviewerId,
      detail,
    }),
  };
}

export function closeHandoff(input: CloseHandoffInput): Handoff {
  if (input === null || typeof input !== "object" || input.handoff === null || typeof input.handoff !== "object") {
    throw new HandoffError("closeHandoff requires an inputs object with a handoff.", "invalid-input");
  }
  const h = input.handoff;
  if (h.version !== "handoff/1") {
    throw new HandoffError(
      `closeHandoff requires a Handoff (version "handoff/1").`,
      "invalid-input",
    );
  }
  if (h.phase === "closed") {
    throw new HandoffError(
      `Handoff ${h.handoffId} is already closed (reason: ${String(h.closeReason)}).`,
      "illegal-transition",
      { handoffId: h.handoffId, closeReason: h.closeReason },
    );
  }
  if (!isCloseReason(input.reason)) {
    throw new HandoffError(
      `Unknown close reason "${String(input.reason)}".`,
      "invalid-input",
      { reason: input.reason },
    );
  }
  // A `returned-control` close is only valid when an operator attached and
  // signalled return. Otherwise the close reason is a lie about what happened.
  if (input.reason === "returned-control" && (h.operatorId === null || h.phase !== "returning")) {
    throw new HandoffError(
      `Cannot close handoff ${h.handoffId} with reason "returned-control": no operator has signalled return.`,
      "illegal-transition",
      { handoffId: h.handoffId, phase: h.phase, operatorId: h.operatorId },
    );
  }
  const now = new Date().toISOString();
  const actorId = input.reviewerId ?? h.operatorId;
  const actorType: HandoffEvent["actorType"] = actorId !== null ? "reviewer" : "system";
  const detail = nonEmpty(input.detail) ??
    (input.reason === "returned-control"
      ? `Reviewer "${actorId}" returned control; handoff closed.`
      : `Handoff closed: ${input.reason}.`);
  return {
    ...h,
    phase: "closed",
    updatedAt: now,
    closedAt: now,
    closeReason: input.reason,
    events: appendEvent(h.events, {
      at: now,
      phase: "closed",
      actorType,
      actorId,
      detail,
    }),
  };
}

/**
 * One-line summary for the review UI (e.g. a toast when a handoff returns).
 * Stable wording, versioned with the plan.
 */
export function summariseHandoff(handoff: Handoff): string {
  switch (handoff.phase) {
    case "opening":
      return `Handoff ${handoff.handoffId} is opening.`;
    case "awaiting-operator":
      return `Handoff ${handoff.handoffId} is waiting for a reviewer to attach.`;
    case "under-control":
      return `Reviewer "${handoff.operatorId ?? "unknown"}" is driving the workflow; the automation loop is paused.`;
    case "returning":
      return `Reviewer "${handoff.operatorId ?? "unknown"}" signalled return; the automation loop will resume.`;
    case "closed":
      switch (handoff.closeReason) {
        case "returned-control":
          return `Handoff ${handoff.handoffId} closed: control returned to the automation loop.`;
        case "abandoned":
          return `Handoff ${handoff.handoffId} abandoned; the workflow was not resumed.`;
        case "expired":
          return `Handoff ${handoff.handoffId} expired without a return signal.`;
        case "error":
          return `Handoff ${handoff.handoffId} closed due to an error.`;
        case "cancelled-by-reviewer":
          return `Handoff ${handoff.handoffId} cancelled by the reviewer.`;
        case null:
          return `Handoff ${handoff.handoffId} closed.`;
      }
  }
}

/**
 * Whether the handoff's duration has elapsed at the given time (defaults to
 * now). Callers use this to force-close a wedged session. The module does not
 * itself close on a timer; a schedule must be owned by the worker.
 */
export function isExpired(handoff: Handoff, at?: string | Date): boolean {
  const when = at === undefined
    ? Date.now()
    : typeof at === "string"
      ? Date.parse(at)
      : at.getTime();
  return new Date(handoff.expiresAt).getTime() <= when;
}

export function rehydrateHandoff(value: unknown): Handoff {
  if (value === null || typeof value !== "object") {
    throw new HandoffError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "handoff/1") {
    throw new HandoffError(
      `Rehydrate failed: expected version "handoff/1", received "${String(r["version"])}".`,
      "invalid-input",
    );
  }
  const sessionRaw = r["session"];
  if (sessionRaw === null || typeof sessionRaw !== "object") {
    throw new HandoffError("Rehydrate failed: `session` is missing.", "invalid-input");
  }
  const s = sessionRaw as Record<string, unknown>;
  const session: BrowserSessionHandle = {
    contextId: typeof s["contextId"] === "string" ? s["contextId"] : "",
    liveViewUrl: typeof s["liveViewUrl"] === "string" ? s["liveViewUrl"] : null,
    currentUrl: typeof s["currentUrl"] === "string" ? s["currentUrl"] : null,
  };
  return {
    version: "handoff/1",
    handoffId: typeof r["handoffId"] === "string" ? r["handoffId"] : "",
    workflowId: typeof r["workflowId"] === "string" ? r["workflowId"] : "",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    gateId: typeof r["gateId"] === "string" ? r["gateId"] : null,
    session,
    phase: readPhase(r["phase"]),
    operatorId: typeof r["operatorId"] === "string" ? r["operatorId"] : null,
    operatorUserAgent: typeof r["operatorUserAgent"] === "string" ? r["operatorUserAgent"] : null,
    openedAt: typeof r["openedAt"] === "string" ? r["openedAt"] : "",
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
    expiresAt: typeof r["expiresAt"] === "string" ? r["expiresAt"] : "",
    closedAt: typeof r["closedAt"] === "string" ? r["closedAt"] : null,
    closeReason: readCloseReason(r["closeReason"]),
    events: readEvents(r["events"]),
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function requireOpen(h: Handoff | null | undefined, caller: string): Handoff {
  if (h === null || h === undefined || typeof h !== "object") {
    throw new HandoffError(`${caller} requires a handoff object.`, "invalid-input");
  }
  if (h.version !== "handoff/1") {
    throw new HandoffError(
      `${caller} requires a Handoff (version "handoff/1").`,
      "invalid-input",
    );
  }
  if (h.phase === "closed") {
    throw new HandoffError(
      `${caller} cannot act on handoff ${h.handoffId}: it is already closed (${String(h.closeReason)}).`,
      "illegal-transition",
      { handoffId: h.handoffId, closeReason: h.closeReason },
    );
  }
  return h;
}

function appendEvent(events: readonly HandoffEvent[], next: HandoffEvent): readonly HandoffEvent[] {
  // Events accumulate; never truncated, so the audit trail sees the full
  // lifecycle. Frozen so the array cannot be mutated by a caller that then
  // re-reads the handoff.
  return Object.freeze([...events, next]);
}

function isCloseReason(v: unknown): v is HandoffCloseReason {
  return (
    v === "returned-control" ||
    v === "abandoned" ||
    v === "expired" ||
    v === "error" ||
    v === "cancelled-by-reviewer"
  );
}

function readCloseReason(v: unknown): HandoffCloseReason | null {
  return isCloseReason(v) ? v : null;
}

function readPhase(v: unknown): HandoffPhase {
  return (
    v === "opening" ||
    v === "awaiting-operator" ||
    v === "under-control" ||
    v === "returning" ||
    v === "closed"
  )
    ? v
    : "opening";
}

function readEvents(v: unknown): readonly HandoffEvent[] {
  if (!Array.isArray(v)) return [];
  const out: HandoffEvent[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const actorType = o["actorType"] === "reviewer" ? "reviewer" : "system";
    out.push({
      at: typeof o["at"] === "string" ? o["at"] : "",
      phase: readPhase(o["phase"]),
      actorType,
      actorId: typeof o["actorId"] === "string" ? o["actorId"] : null,
      detail: typeof o["detail"] === "string" ? o["detail"] : "",
    });
  }
  return out;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
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
  DEFAULT_MAX_DURATION_MS,
  isCloseReason,
  readCloseReason,
  readPhase,
  readEvents,
  requireOpen,
  appendEvent,
  fnv1a32,
});
