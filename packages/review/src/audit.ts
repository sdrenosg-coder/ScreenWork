/**
 * Zipy AI — human-in-the-loop review: audit trail (phase 19, batch 1).
 *
 * The single append-only record of every review-mode transition: gate
 * decisions, handoff lifecycle events, batch overrides, and the risk
 * classification that justified each. Every entry carries a timestamp, an
 * actor (a reviewer id or the system), the workspace and workflow it belongs
 * to, and a stable id derived from its content so a duplicate delivery is
 * detectable.
 *
 * Design boundaries:
 *
 *  - The audit trail is append-only. `appendEntries` returns a new log; the
 *    module never mutates a caller's log in place. A rewrite of audit
 *    history is a bug, not a feature.
 *
 *  - No entry is fabricated. Every actor id, timestamp, and detail is
 *    supplied by the caller. The module's job is to normalise, dedupe, sort
 *    and produce a stable hash chain so a downstream verifier can detect a
 *    truncation or reorder.
 *
 *  - Entries are self-describing. Each entry carries enough information for a
 *    later compliance query to be answered without a join: the workspace, the
 *    workflow, the gate, the step ids, the reviewer, the action and the
 *    resulting routing. A compliance officer reading one row knows what
 *    happened.
 *
 *  - The chain is not adversarial-grade. Entries carry a `prevHash` pointing
 *    at the previous entry's `hash` so a truncation or reorder is detectable;
 *    the hash is FNV-1a, not a cryptographic digest, because this module is a
 *    tamper-*detection* structure for an operator reading the log, not a
 *    cryptographically-anchored ledger. Public audit exports go through the
 *    encryption path in `@zipy/security/encryption` when they leave the
 *    workspace.
 *
 *  - No IP address is invented. The module accepts an `ip` field on the
 *    caller's context and records it verbatim; when the caller does not
 *    supply one, the entry has `ip: null` and the audit reader knows the
 *    caller did not capture one.
 *
 * The module exports:
 *   - `appendEntries` — append one or many entries to a log.
 *   - `entriesForWorkflow` / `entriesForReviewer` / `entriesForGate` — filters.
 *   - `verifyChain` — detect a truncation, reorder or edit in a persisted log.
 *   - `describeEntry` — stable human text for the compliance view.
 *   - `summariseLog` — counters for the admin dashboard.
 *   - `rehydrateAuditLog` — typed load of a persisted payload.
 *   - `__internals` — the hashing and validation helpers, exported for tests.
 */

import type { CheckpointGate } from "./checkpoints.js";
import type { ReviewerDecision, DecisionLog } from "./decisions.js";
import type { Handoff, HandoffEvent } from "./handoff.js";
import type { BatchPackage } from "./batchApprove.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AuditErrorCode = "invalid-input" | "chain-broken" | "wrong-version";

export class AuditError extends Error {
  readonly code: AuditErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: AuditErrorCode,
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
 * The kind of review-mode transition an entry records. Every entry's `kind`
 * is one of these; a caller with a new event type adds it here, not to a
 * free-text field.
 */
export const AUDIT_KINDS = [
  "review-mode-changed",
  "risk-classified",
  "gate-decided",
  "batch-decided",
  "handoff-opened",
  "handoff-attached",
  "handoff-returned",
  "handoff-closed",
  "override-recorded",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/**
 * Who performed the action. `system` entries are created by the automation
 * loop with no reviewer; `reviewer` entries always carry a reviewer id. The
 * module never fabricates a reviewer id for an actorType of `system` and
 * never sets `system` on an entry that carries a reviewer id.
 */
export interface AuditActor {
  readonly type: "system" | "reviewer";
  /** Required when `type` is "reviewer"; null otherwise. */
  readonly id: string | null;
  /**
   * IP address as the caller captured it, verbatim. The module never invents
   * one. Null when the caller did not record one.
   */
  readonly ip: string | null;
  /** Optional user agent as the caller captured it. */
  readonly userAgent: string | null;
}

/**
 * The details of a decision entry. A `gate-decided` entry carries the
 * reviewer's decision; a `batch-decided` entry carries the same shape for
 * the underlying gate plus the package id.
 */
export interface AuditDecisionDetail {
  readonly gateId: string;
  readonly stepIds: readonly string[];
  readonly action: ReviewerDecision["action"];
  readonly risk: ReviewerDecision["risk"];
  readonly note: string | null;
  readonly targetStepId: string | null;
  readonly editedValue: string | null;
  /** For `batch-decided`; null otherwise. */
  readonly packageId: string | null;
  /** Set when the caller accepted an invalid batch package; null otherwise. */
  readonly overrideReason: string | null;
}

/**
 * The details of a handoff entry. `handoff-closed` entries carry the reason.
 */
export interface AuditHandoffDetail {
  readonly handoffId: string;
  readonly phase: Handoff["phase"];
  readonly closeReason: Handoff["closeReason"];
  readonly contextId: string;
}

/**
 * One audit entry. Every field is either supplied by the caller or derived
 * deterministically from the caller's inputs by the module. No field is
 * invented.
 */
export interface AuditEntry {
  readonly version: "audit-entry/1";
  /** Deterministic id derived from the entry's identifying tuple. */
  readonly entryId: string;
  readonly kind: AuditKind;
  /** The workspace the action belongs to. Never null. */
  readonly workspaceId: string;
  /** The workflow the action applies to, when the caller knows it. */
  readonly workflowId: string | null;
  readonly actor: AuditActor;
  /** ISO 8601 timestamp the caller recorded. */
  readonly at: string;
  /** Human summary of what happened. */
  readonly detail: string;
  /** Decision-specific detail; null for non-decision kinds. */
  readonly decision: AuditDecisionDetail | null;
  /** Handoff-specific detail; null for non-handoff kinds. */
  readonly handoff: AuditHandoffDetail | null;
  /** FNV-1a hash of the entry's canonical JSON (excluding `hash`/`prevHash`). */
  readonly hash: string;
  /** The previous entry's `hash`, or the empty chain seed for the first entry. */
  readonly prevHash: string;
}

export interface AuditLog {
  readonly version: "audit-log/1";
  readonly workspaceId: string;
  readonly entries: readonly AuditEntry[];
  /** The chain tip; an append verifies against this before writing. */
  readonly head: string;
  readonly generatedAt: string;
  readonly aiGenerated: false;
}

export interface AuditContext {
  readonly workspaceId: string;
  readonly workflowId?: string | null;
  readonly actor: AuditActor;
  /** ISO 8601 timestamp the caller recorded. */
  readonly at: string;
  /** Settings the caller's policy recorded, e.g. review mode on/off. */
  readonly reviewModeEnabled?: boolean;
  /** When policy changed, the previous value. Only used for review-mode-changed. */
  readonly reviewModePrevious?: boolean | null;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The seed hash for the first entry in a log. Its value is a fixed, non-secret
 * string hashed by the same routine as an entry, so a log's first `prevHash`
 * is stable across a fresh database and a hash written by an older version of
 * this module.
 */
const CHAIN_SEED = fnv1a32("zipy-audit-chain/1");

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Append one or more entries to the log. The caller constructs the entries by
 * supplying context and details; this function normalises them, derives ids
 * and hashes, and links them to `log.head` so the chain verifies.
 */
export function appendEntries(
  log: AuditLog | null,
  context: AuditContext,
  entries: readonly PendingEntry[],
): AuditLog {
  if (context === null || typeof context !== "object") {
    throw new AuditError("`context` is required.", "invalid-input");
  }
  if (typeof context.workspaceId !== "string" || context.workspaceId.length === 0) {
    throw new AuditError("`context.workspaceId` is required.", "invalid-input");
  }
  if (context.actor === null || typeof context.actor !== "object") {
    throw new AuditError("`context.actor` is required.", "invalid-input");
  }
  if (
    (context.actor.type === "reviewer" &&
      (typeof context.actor.id !== "string" || context.actor.id.trim().length === 0)) ||
    (context.actor.type !== "reviewer" &&
      context.actor.id !== null &&
      typeof context.actor.id !== "string")
  ) {
    throw new AuditError(
      'A "reviewer" actor must carry a non-empty id; a "system" actor must carry null.',
      "invalid-input",
      { actorType: context.actor.type, actorId: context.actor.id },
    );
  }
  if (typeof context.at !== "string" || context.at.trim().length === 0) {
    throw new AuditError("`context.at` (ISO timestamp) is required.", "invalid-input");
  }
  if (!Array.isArray(entries)) {
    throw new AuditError("`entries` must be an array.", "invalid-input");
  }

  const baseLog: AuditLog =
    log === null || log === undefined
      ? emptyLog(context.workspaceId)
      : (() => {
          if (log.version !== "audit-log/1") {
            throw new AuditError(
              `Expected an AuditLog (version "audit-log/1"), received "${String(log.version)}".`,
              "wrong-version",
            );
          }
          if (log.workspaceId !== context.workspaceId) {
            throw new AuditError(
              `Cannot append to a log for workspace "${log.workspaceId}" using a context for workspace "${context.workspaceId}".`,
              "invalid-input",
              { logWorkspaceId: log.workspaceId, contextWorkspaceId: context.workspaceId },
            );
          }
          return log;
        })();

  const appended: AuditEntry[] = [];
  let prevHash = baseLog.head;
  for (const pending of entries) {
    if (pending === null || typeof pending !== "object") continue;
    if (!isAuditKind(pending.kind)) {
      throw new AuditError(
        `Unknown audit kind "${String(pending.kind)}".`,
        "invalid-input",
        { kind: pending.kind },
      );
    }
    const partial = normalisePending(pending, context);
    const decided = finaliseEntry(partial, prevHash);
    appended.push(decided);
    prevHash = decided.hash;
  }

  return {
    version: "audit-log/1",
    workspaceId: baseLog.workspaceId,
    entries: Object.freeze([...baseLog.entries, ...appended]),
    head: prevHash,
    generatedAt: new Date().toISOString(),
    aiGenerated: false,
  };
}

/**
 * Convenience wrapper: append a `gate-decided` entry from a decided gate
 * produced by `@zipy/review/decisions`. The reviewer id and timestamp come
 * from the decision; the audit context may add an IP and user agent.
 */
export function appendGateDecision(
  log: AuditLog | null,
  context: Omit<AuditContext, "actor" | "at"> & { readonly ip?: string | null; readonly userAgent?: string | null },
  gate: CheckpointGate,
  decision: ReviewerDecision,
): AuditLog {
  const actor: AuditActor = {
    type: "reviewer",
    id: decision.reviewerId,
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
  };
  return appendEntries(log, {
    workspaceId: context.workspaceId,
    workflowId: context.workflowId ?? null,
    actor,
    at: decision.decidedAt,
  }, [
    {
      kind: "gate-decided",
      detail: buildGateDecisionDetail(gate, decision),
      decision: {
        gateId: gate.gateId,
        stepIds: decision.stepIds,
        action: decision.action,
        risk: decision.risk,
        note: decision.note,
        targetStepId: decision.targetStepId,
        editedValue: decision.editedValue,
        packageId: null,
        overrideReason: null,
      },
      handoff: null,
    },
  ]);
}

/**
 * Convenience wrapper: append a `batch-decided` entry from a batch package's
 * approval. `overrideReason` is the caller-supplied override note (or null).
 */
export function appendBatchDecision(
  log: AuditLog | null,
  context: Omit<AuditContext, "actor" | "at"> & { readonly ip?: string | null; readonly userAgent?: string | null },
  pkg: BatchPackage,
  decision: ReviewerDecision,
  overrideReason: string | null,
): AuditLog {
  const actor: AuditActor = {
    type: "reviewer",
    id: decision.reviewerId,
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
  };
  return appendEntries(log, {
    workspaceId: context.workspaceId,
    workflowId: context.workflowId ?? null,
    actor,
    at: decision.decidedAt,
  }, [
    {
      kind: "batch-decided",
      detail: `Batch package ${pkg.packageId} (${pkg.fields.length} fields) was ${decision.action === "approve" ? "approved" : "rejected"}.`,
      decision: {
        gateId: pkg.gateId,
        stepIds: pkg.fields.map((f) => f.stepId),
        action: decision.action,
        risk: decision.risk,
        note: decision.note,
        targetStepId: decision.targetStepId,
        editedValue: decision.editedValue,
        packageId: pkg.packageId,
        overrideReason,
      },
      handoff: null,
    },
  ]);
}

/**
 * Convenience wrapper: append every event the handoff module accumulated to
 * the log. The handoff module's `events` array is the source of truth its
 * transitions produced; this function copies each event's timestamp and
 * detail verbatim (it does not invent additional events).
 */
export function appendHandoffEvents(
  log: AuditLog | null,
  context: Omit<AuditContext, "actor" | "at"> & { readonly ip?: string | null; readonly userAgent?: string | null },
  handoff: Handoff,
): AuditLog {
  // Handoff events carry their own timestamps and actor ids. The context's
  // `at` is only used for validation (a caller with a stale clock should see
  // the mismatch, not silently accept it).
  const now = new Date().toISOString();
  const pending: PendingEntry[] = handoff.events.map((e) => ({
    kind: kindForHandoffPhase(e),
    detail: e.detail,
    decision: null,
    handoff: {
      handoffId: handoff.handoffId,
      phase: e.phase,
      closeReason: handoff.closeReason,
      contextId: handoff.session.contextId,
    },
    // The handoff event's own timestamp overrides the context's, which is why
    // the normaliser reads this field with precedence.
    at: e.at,
    // The handoff event's own actor id overrides the context's, similarly.
    actorIdOverride: e.actorId,
    actorTypeOverride: e.actorType,
  }));
  return appendEntries(
    log,
    {
      workspaceId: context.workspaceId,
      workflowId: handoff.workflowId,
      actor: {
        type: "system",
        id: null,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      at: now,
    },
    pending,
  );
}

export function entriesForWorkflow(log: AuditLog, workflowId: string): readonly AuditEntry[] {
  if (log === null || typeof log !== "object" || log.version !== "audit-log/1") {
    throw new AuditError(
      'entriesForWorkflow requires an AuditLog (version "audit-log/1").',
      "invalid-input",
    );
  }
  if (typeof workflowId !== "string" || workflowId.length === 0) {
    throw new AuditError("`workflowId` is required.", "invalid-input");
  }
  return log.entries.filter((e) => e.workflowId === workflowId);
}

export function entriesForReviewer(log: AuditLog, reviewerId: string): readonly AuditEntry[] {
  if (log === null || typeof log !== "object" || log.version !== "audit-log/1") {
    throw new AuditError(
      'entriesForReviewer requires an AuditLog (version "audit-log/1").',
      "invalid-input",
    );
  }
  if (typeof reviewerId !== "string" || reviewerId.length === 0) {
    throw new AuditError("`reviewerId` is required.", "invalid-input");
  }
  return log.entries.filter(
    (e) => e.actor.type === "reviewer" && e.actor.id === reviewerId,
  );
}

export function entriesForGate(log: AuditLog, gateId: string): readonly AuditEntry[] {
  if (log === null || typeof log !== "object" || log.version !== "audit-log/1") {
    throw new AuditError(
      'entriesForGate requires an AuditLog (version "audit-log/1").',
      "invalid-input",
    );
  }
  if (typeof gateId !== "string" || gateId.length === 0) {
    throw new AuditError("`gateId` is required.", "invalid-input");
  }
  return log.entries.filter((e) => e.decision !== null && e.decision.gateId === gateId);
}

/**
 * Verify a log's hash chain end to end. Returns `{ ok: true }` when intact;
 * returns a diagnostic when a truncation, reorder or edit is detected. A
 * caller that has just loaded a log from storage should call this before
 * trusting it; a handler that just appended entries may skip the check.
 */
export function verifyChain(log: AuditLog): {
  readonly ok: boolean;
  readonly brokenAt: number | null;
  readonly detail: string | null;
} {
  if (log === null || typeof log !== "object" || log.version !== "audit-log/1") {
    throw new AuditError(
      'verifyChain requires an AuditLog (version "audit-log/1").',
      "invalid-input",
    );
  }
  let prev = CHAIN_SEED;
  for (let i = 0; i < log.entries.length; i += 1) {
    const e = log.entries[i]!;
    if (e.prevHash !== prev) {
      return {
        ok: false,
        brokenAt: i,
        detail: `Entry at index ${i} (${e.entryId}) claims prevHash "${e.prevHash}", expected "${prev}".`,
      };
    }
    const recomputed = hashEntry(entryHashPayload(e));
    if (recomputed !== e.hash) {
      return {
        ok: false,
        brokenAt: i,
        detail: `Entry at index ${i} (${e.entryId}) hash mismatch: recorded "${e.hash}", recomputed "${recomputed}".`,
      };
    }
    prev = e.hash;
  }
  if (log.entries.length > 0 && log.head !== prev) {
    return {
      ok: false,
      brokenAt: log.entries.length,
      detail: `Log head "${log.head}" does not match the last entry's hash "${prev}".`,
    };
  }
  return { ok: true, brokenAt: null, detail: null };
}

/**
 * Stable human text an admin reading the log sees next to an entry. The
 * wording is versioned with the log so a screenshot in a help article does
 * not drift between releases.
 */
export function describeEntry(entry: AuditEntry): string {
  const actor = entry.actor.type === "reviewer"
    ? `Reviewer "${entry.actor.id ?? ""}"`
    : "The system";
  switch (entry.kind) {
    case "review-mode-changed":
      return `${actor} changed review mode. ${entry.detail}`;
    case "risk-classified":
      return `${actor} classified actions. ${entry.detail}`;
    case "gate-decided": {
      const d = entry.decision;
      if (d === null) return `${actor} recorded a gate decision.`;
      return `${actor} ${d.action === "approve" ? "approved" : d.action === "edit" ? "edited" : d.action === "reject" ? "rejected" : "skipped"} gate "${d.gateId}" (risk "${d.risk}"). ${entry.detail}`;
    }
    case "batch-decided": {
      const d = entry.decision;
      if (d === null) return `${actor} recorded a batch decision.`;
      const pkg = d.packageId !== null ? ` package "${d.packageId}"` : "";
      return `${actor} ${d.action === "approve" ? "approved" : "rejected"} batch${pkg} of ${d.stepIds.length} steps. ${entry.detail}`;
    }
    case "handoff-opened":
      return `${actor} opened a live handoff. ${entry.detail}`;
    case "handoff-attached":
      return `${actor} attached to the live browser session. ${entry.detail}`;
    case "handoff-returned":
      return `${actor} returned control of the live browser session. ${entry.detail}`;
    case "handoff-closed":
      return `${actor} closed the live handoff. ${entry.detail}`;
    case "override-recorded":
      return `${actor} recorded an override. ${entry.detail}`;
  }
}

export function summariseLog(log: AuditLog): {
  readonly total: number;
  readonly byKind: Readonly<Record<AuditKind, number>>;
  readonly byReviewer: Readonly<Record<string, number>>;
  readonly withIp: number;
} {
  if (log === null || typeof log !== "object" || log.version !== "audit-log/1") {
    throw new AuditError(
      'summariseLog requires an AuditLog (version "audit-log/1").',
      "invalid-input",
    );
  }
  const byKind: Record<AuditKind, number> = {
    "review-mode-changed": 0,
    "risk-classified": 0,
    "gate-decided": 0,
    "batch-decided": 0,
    "handoff-opened": 0,
    "handoff-attached": 0,
    "handoff-returned": 0,
    "handoff-closed": 0,
    "override-recorded": 0,
  };
  const byReviewer: Record<string, number> = {};
  let withIp = 0;
  for (const e of log.entries) {
    byKind[e.kind] += 1;
    if (e.actor.type === "reviewer" && e.actor.id !== null) {
      byReviewer[e.actor.id] = (byReviewer[e.actor.id] ?? 0) + 1;
    }
    if (e.actor.ip !== null) withIp += 1;
  }
  return { total: log.entries.length, byKind, byReviewer, withIp };
}

export function rehydrateAuditLog(value: unknown): AuditLog {
  if (value === null || typeof value !== "object") {
    throw new AuditError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "audit-log/1") {
    throw new AuditError(
      `Rehydrate failed: expected version "audit-log/1", received "${String(r["version"])}".`,
      "wrong-version",
    );
  }
  const entriesRaw = Array.isArray(r["entries"]) ? r["entries"] : [];
  const entries: AuditEntry[] = [];
  for (const item of entriesRaw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o["version"] !== "audit-entry/1") continue;
    entries.push({
      version: "audit-entry/1",
      entryId: typeof o["entryId"] === "string" ? o["entryId"] : "",
      kind: readKind(o["kind"]),
      workspaceId: typeof o["workspaceId"] === "string" ? o["workspaceId"] : "",
      workflowId: typeof o["workflowId"] === "string" ? o["workflowId"] : null,
      actor: readActor(o["actor"]),
      at: typeof o["at"] === "string" ? o["at"] : "",
      detail: typeof o["detail"] === "string" ? o["detail"] : "",
      decision: readDecisionDetail(o["decision"]),
      handoff: readHandoffDetail(o["handoff"]),
      hash: typeof o["hash"] === "string" ? o["hash"] : "",
      prevHash: typeof o["prevHash"] === "string" ? o["prevHash"] : "",
    });
  }
  return {
    version: "audit-log/1",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    entries,
    head: typeof r["head"] === "string" ? r["head"] : "",
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Pending entry shape                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The caller-supplied shape that `appendEntries` normalises into an
 * `AuditEntry`. Two fields (`at` and `actorIdOverride`) let a caller with
 * the timestamp and actor of an inner event (a handoff event) override the
 * context's values without a separate call.
 */
export interface PendingEntry {
  readonly kind: AuditKind;
  readonly detail: string;
  readonly decision: AuditDecisionDetail | null;
  readonly handoff: AuditHandoffDetail | null;
  /** Overrides `context.at` when present. */
  readonly at?: string;
  /** When set, replaces the context's actor id. */
  readonly actorIdOverride?: string | null;
  /** When set, replaces the context's actor type. */
  readonly actorTypeOverride?: "system" | "reviewer";
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface PartialEntry {
  readonly version: "audit-entry/1";
  readonly kind: AuditKind;
  readonly workspaceId: string;
  readonly workflowId: string | null;
  readonly actor: AuditActor;
  readonly at: string;
  readonly detail: string;
  readonly decision: AuditDecisionDetail | null;
  readonly handoff: AuditHandoffDetail | null;
}

function emptyLog(workspaceId: string): AuditLog {
  return {
    version: "audit-log/1",
    workspaceId,
    entries: [],
    head: CHAIN_SEED,
    generatedAt: new Date().toISOString(),
    aiGenerated: false,
  };
}

function normalisePending(pending: PendingEntry, context: AuditContext): PartialEntry {
  const at = typeof pending.at === "string" && pending.at.length > 0 ? pending.at : context.at;
  const actorType =
    pending.actorTypeOverride === "reviewer" || pending.actorTypeOverride === "system"
      ? pending.actorTypeOverride
      : context.actor.type;
  const actorId =
    pending.actorIdOverride !== undefined ? pending.actorIdOverride : context.actor.id;
  // A "reviewer" actor with no id is a programming error; catch it here so
  // the resulting entry never appears in a compliance view with a missing
  // actor.
  if (actorType === "reviewer" && (actorId === null || actorId.trim().length === 0)) {
    throw new AuditError(
      `An audit entry of kind "${pending.kind}" requires a reviewer id, but none was supplied.`,
      "invalid-input",
      { kind: pending.kind },
    );
  }
  return {
    version: "audit-entry/1",
    kind: pending.kind,
    workspaceId: context.workspaceId,
    workflowId: context.workflowId ?? null,
    actor: {
      type: actorType,
      id: actorType === "reviewer" ? actorId : null,
      ip: context.actor.ip,
      userAgent: context.actor.userAgent,
    },
    at,
    detail: typeof pending.detail === "string" ? pending.detail : "",
    decision: pending.decision ?? null,
    handoff: pending.handoff ?? null,
  };
}

function finaliseEntry(partial: PartialEntry, prevHash: string): AuditEntry {
  const payload = entryHashPayload({ ...partial, entryId: "", hash: "", prevHash });
  const entryId = entryIdFor(partial);
  const hash = hashEntry(entryHashPayload({ ...partial, entryId, hash: "", prevHash }));
  void payload;
  return {
    version: "audit-entry/1",
    entryId,
    kind: partial.kind,
    workspaceId: partial.workspaceId,
    workflowId: partial.workflowId,
    actor: partial.actor,
    at: partial.at,
    detail: partial.detail,
    decision: partial.decision,
    handoff: partial.handoff,
    hash,
    prevHash,
  };
}

function entryIdFor(partial: PartialEntry): string {
  const tuple = [
    partial.workspaceId,
    partial.workflowId ?? "",
    partial.kind,
    partial.at,
    partial.actor.type,
    partial.actor.id ?? "",
    partial.decision?.gateId ?? "",
    partial.handoff?.handoffId ?? "",
    partial.handoff?.phase ?? "",
  ].join("|");
  const h = fnv1a32(tuple).toString(16).padStart(8, "0");
  return `aud_${h}`;
}

/**
 * The canonical payload that `hash` is computed over. Every field a reorder
 * or edit would touch must be in here; omitting one lets a tamperer change it
 * without detection. `hash` and `prevHash` are excluded because they are the
 * chain's links, not the entry's content.
 */
function entryHashPayload(
  e: PartialEntry & { readonly entryId: string; readonly hash: string; readonly prevHash: string },
): string {
  return JSON.stringify({
    workspaceId: e.workspaceId,
    workflowId: e.workflowId,
    kind: e.kind,
    at: e.at,
    actorType: e.actor.type,
    actorId: e.actor.id,
    actorIp: e.actor.ip,
    actorUserAgent: e.actor.userAgent,
    detail: e.detail,
    decision: e.decision,
    handoff: e.handoff,
    prevHash: e.prevHash,
    entryId: e.entryId,
  });
}

function hashEntry(payloadJson: string): string {
  // Two FNV-1a passes with different seeds give a 64-bit-ish digest. This is
  // a tamper-detection aid for an operator reading the log; it is not a
  // cryptographic MAC. Public exports go through @zipy/security/encryption.
  const a = fnv1a32(payloadJson).toString(16).padStart(8, "0");
  const b = fnv1a32(`zipy|2|${payloadJson}`).toString(16).padStart(8, "0");
  return `h_${a}${b}`;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function isAuditKind(v: unknown): v is AuditKind {
  return (
    v === "review-mode-changed" ||
    v === "risk-classified" ||
    v === "gate-decided" ||
    v === "batch-decided" ||
    v === "handoff-opened" ||
    v === "handoff-attached" ||
    v === "handoff-returned" ||
    v === "handoff-closed" ||
    v === "override-recorded"
  );
}

function readKind(v: unknown): AuditKind {
  return isAuditKind(v) ? v : "override-recorded";
}

function kindForHandoffPhase(event: HandoffEvent): AuditKind {
  switch (event.phase) {
    case "awaiting-operator":
      return "handoff-opened";
    case "under-control":
      return "handoff-attached";
    case "returning":
      return "handoff-returned";
    case "closed":
      return "handoff-closed";
    case "opening":
      // `opening` is transient; a handoff never persists in this phase. Record
      // it as `handoff-opened` so a log reader sees the attempt.
      return "handoff-opened";
  }
}

function readActor(v: unknown): AuditActor {
  if (v === null || typeof v !== "object") {
    return { type: "system", id: null, ip: null, userAgent: null };
  }
  const o = v as Record<string, unknown>;
  const type = o["type"] === "reviewer" ? "reviewer" : "system";
  return {
    type,
    id: type === "reviewer" && typeof o["id"] === "string" ? o["id"] : null,
    ip: typeof o["ip"] === "string" ? o["ip"] : null,
    userAgent: typeof o["userAgent"] === "string" ? o["userAgent"] : null,
  };
}

function readDecisionDetail(v: unknown): AuditDecisionDetail | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const action: ReviewerDecision["action"] =
    o["action"] === "edit" || o["action"] === "reject" || o["action"] === "skip"
      ? o["action"]
      : "approve";
  const risk: ReviewerDecision["risk"] =
    o["risk"] === "write" ||
    o["risk"] === "destructive" ||
    o["risk"] === "financial" ||
    o["risk"] === "external-communication"
      ? o["risk"]
      : "read-only";
  return {
    gateId: typeof o["gateId"] === "string" ? o["gateId"] : "",
    stepIds: readStringArray(o["stepIds"]),
    action,
    risk,
    note: typeof o["note"] === "string" ? o["note"] : null,
    targetStepId: typeof o["targetStepId"] === "string" ? o["targetStepId"] : null,
    editedValue: typeof o["editedValue"] === "string" ? o["editedValue"] : null,
    packageId: typeof o["packageId"] === "string" ? o["packageId"] : null,
    overrideReason: typeof o["overrideReason"] === "string" ? o["overrideReason"] : null,
  };
}

function readHandoffDetail(v: unknown): AuditHandoffDetail | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const phaseRaw = o["phase"];
  const phase: Handoff["phase"] =
    phaseRaw === "opening" ||
    phaseRaw === "awaiting-operator" ||
    phaseRaw === "under-control" ||
    phaseRaw === "returning" ||
    phaseRaw === "closed"
      ? phaseRaw
      : "closed";
  const reasonRaw = o["closeReason"];
  const closeReason: Handoff["closeReason"] =
    reasonRaw === "returned-control" ||
    reasonRaw === "abandoned" ||
    reasonRaw === "expired" ||
    reasonRaw === "error" ||
    reasonRaw === "cancelled-by-reviewer"
      ? reasonRaw
      : null;
  return {
    handoffId: typeof o["handoffId"] === "string" ? o["handoffId"] : "",
    phase,
    closeReason,
    contextId: typeof o["contextId"] === "string" ? o["contextId"] : "",
  };
}

function readStringArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((i): i is string => typeof i === "string" && i.length > 0);
}

function buildGateDecisionDetail(gate: CheckpointGate, decision: ReviewerDecision): string {
  const subject = gate.batched
    ? `batched gate (${gate.stepIds.length} steps)`
    : `gate`;
  return `${subject} "${gate.gateId}" risk "${gate.risk}" was ${decision.action}ed by reviewer "${decision.reviewerId}".`;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  CHAIN_SEED,
  emptyLog,
  normalisePending,
  finaliseEntry,
  entryIdFor,
  entryHashPayload,
  hashEntry,
  fnv1a32,
  isAuditKind,
  readKind,
  kindForHandoffPhase,
  readActor,
  readDecisionDetail,
  readHandoffDetail,
  buildGateDecisionDetail,
});
