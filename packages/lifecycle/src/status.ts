/**
 * Zipy AI — guide lifecycle status (phase 24, batch 1).
 *
 * Guides move through a small, fixed set of states: draft, review,
 * published, archived. The dashboard, the sharing layer and the retention
 * sweeps all need a single source of truth for which transitions are legal
 * and what a status change implies.
 *
 * Design boundaries:
 *
 *  - The module is a state machine and a validator, not a persistence layer.
 *    It takes a current status and a requested next status and returns a
 *    typed decision. A repository above it (in the guides/workspaces
 *    package) writes the row.
 *
 *  - Transitions are declared, not inferred. The transition table is a data
 *    structure a caller can render in the UI ("you may publish this draft")
 *    and a test can iterate over. Adding a state or a transition is a single
 *    edit; every caller gets the new rule.
 *
 *  - Publishing is a *decision*, not a side effect. `applyTransition`
 *    returns whether the transition needs a reviewer, whether it needs a
 *    non-empty changelog, and what the resulting row looks like; a repo
 *    layer that reads the return value and writes the row stays free of
 *    validation logic.
 *
 *  - Unpublish and archive are different. Returning to draft from published
 *    is `unpublish` and the shares remain in the workspace so the URLs are
 *    re-publishable. Archiving freezes a guide: shares are recorded as
 *    archived, and a transition back to another state requires an explicit
 *    unarchive-then-edit step, which is why it is modelled as its own edge
 *    rather than a re-publish.
 *
 *  - Review gating is a policy flag, not a hard rule. The review toggle
 *    lives in the workspace settings (phase 19); this module exposes
 *    `requiresReview` as a hint a caller *can* enforce or ignore. The
 *    transitions themselves are still legal to execute without a reviewer,
 *    because some workspaces turn review off and the platform must not
 *    contradict that.
 *
 * The module exports:
 *   - `GUIDE_STATUSES` — the state set.
 *   - `allowedNextStatuses` — the outgoing edges from a status.
 *   - `validateTransition` — check a request against the table.
 *   - `applyTransition` — produce the resulting row.
 *   - `summariseStatus` — one-line human text.
 *   - `statusColour` — a stable colour token for the dashboard badge.
 *   - `rehydrateGuideStatusRow` — typed load of a persisted row.
 *   - Typed errors and constants.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type StatusErrorCode =
  | "invalid-input"
  | "unknown-status"
  | "illegal-transition"
  | "changelog-required";

export class StatusError extends Error {
  readonly code: StatusErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: StatusErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "StatusError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                 */
/* -------------------------------------------------------------------------- */

export const GUIDE_STATUSES = [
  "draft",
  "review",
  "published",
  "archived",
] as const;
export type GuideStatus = (typeof GUIDE_STATUSES)[number];

export interface GuideStatusRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: GuideStatus;
  /**
   * The user id that requested the last transition into the current status.
   * Null when the row predates status tracking or when a background job
   * (auto-regenerate, auto-translate) performed the transition.
   */
  readonly statusChangedBy: string | null;
  /** ISO timestamp of the last status change. */
  readonly statusChangedAt: string | null;
  /**
   * Optional reason note the requester supplied. Present on transitions
   * that require one (`archived`, and any transition that a workspace
   * policy flags).
   */
  readonly statusNote: string | null;
}

export interface TransitionRequest {
  readonly current: GuideStatus;
  readonly next: GuideStatus;
  /** The requester. Null only for system-driven transitions. */
  readonly actorId: string | null;
  /**
   * Optional changelog text the caller may attach to the transition. The
   * transition table does not require this on any edge today; a workspace
   * policy may; callers pass whatever they have.
   */
  readonly changelog?: string | null;
  /** Free-text reason. Present on transitions that require one. */
  readonly note?: string | null;
}

export interface TransitionDecision {
  readonly version: "status-transition/1";
  readonly current: GuideStatus;
  readonly next: GuideStatus;
  readonly allowed: boolean;
  /**
   * Whether publishing from this state is exposed to reviewers only when a
   * workspace has review mode on. A hint a caller may or may not enforce;
   * see the design notes at the top of the module.
   */
  readonly requiresReview: boolean;
  /**
   * Whether the transition requires a non-empty `note`. Transitions that
   * archive a guide, or that unpublish one with shares outstanding, require
   * a note so an operator can see *why* the guide left its public state.
   */
  readonly requiresNote: boolean;
  /**
   * When `allowed` is false, a short English reason the caller can show.
   * Null when `allowed` is true.
   */
  readonly refusalReason: string | null;
}

/* -------------------------------------------------------------------------- */
/* Transition table                                                             */
/* -------------------------------------------------------------------------- */

interface TransitionEdge {
  readonly from: GuideStatus;
  readonly to: GuideStatus;
  readonly requiresNote: boolean;
  readonly requiresReview: boolean;
}

/**
 * Legal transitions. The table is exhaustive; any pair not listed is
 * refused by `validateTransition`. Kept in sync with the plan's lifecycle
 * acceptance text: draft/review/published/archived with an explicit
 * unarchive edge.
 */
const TRANSITIONS: readonly TransitionEdge[] = Object.freeze([
  // draft -> review: submit for review. No note required, review is the point.
  Object.freeze({
    from: "draft",
    to: "review",
    requiresNote: false,
    requiresReview: true,
  }),
  // draft -> published: skip review. Allowed; some workspaces run without
  // review mode and forcing a draft->review step would contradict that.
  Object.freeze({
    from: "draft",
    to: "published",
    requiresNote: false,
    requiresReview: true,
  }),
  // review -> draft: send back for edits.
  Object.freeze({
    from: "review",
    to: "draft",
    requiresNote: false,
    requiresReview: false,
  }),
  // review -> published: approve.
  Object.freeze({
    from: "review",
    to: "published",
    requiresNote: false,
    requiresReview: false,
  }),
  // published -> review: re-open for another review round without
  // unpublishing; the guide stays reachable by URL.
  Object.freeze({
    from: "published",
    to: "review",
    requiresNote: false,
    requiresReview: true,
  }),
  // published -> draft: unpublish. Note required.
  Object.freeze({
    from: "published",
    to: "draft",
    requiresNote: true,
    requiresReview: false,
  }),
  // published -> archived: the terminal state. Note required.
  Object.freeze({
    from: "published",
    to: "archived",
    requiresNote: true,
    requiresReview: false,
  }),
  // draft -> archived: discard an unpublished draft. Note required.
  Object.freeze({
    from: "draft",
    to: "archived",
    requiresNote: true,
    requiresReview: false,
  }),
  // review -> archived: reject-and-archive. Note required.
  Object.freeze({
    from: "review",
    to: "archived",
    requiresNote: true,
    requiresReview: false,
  }),
  // archived -> draft: restore. Note required so the operator's log shows
  // why a frozen guide is coming back.
  Object.freeze({
    from: "archived",
    to: "draft",
    requiresNote: true,
    requiresReview: false,
  }),
]);

/* -------------------------------------------------------------------------- */
/* Lookup                                                                       */
/* -------------------------------------------------------------------------- */

export function isGuideStatus(value: unknown): value is GuideStatus {
  return (
    typeof value === "string" &&
    (GUIDE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The outgoing edges from `status`. A caller renders these as buttons on a
 * guide's detail view; a transition not in the returned list is illegal
 * from that state.
 */
export function allowedNextStatuses(status: GuideStatus): readonly GuideStatus[] {
  if (!isGuideStatus(status)) {
    throw new StatusError(
      `Unknown guide status "${String(status)}".`,
      "unknown-status",
      { status },
    );
  }
  const out: GuideStatus[] = [];
  for (const edge of TRANSITIONS) {
    if (edge.from === status) out.push(edge.to);
  }
  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                   */
/* -------------------------------------------------------------------------- */

export function validateTransition(request: TransitionRequest): TransitionDecision {
  if (request === null || typeof request !== "object") {
    throw new StatusError("validateTransition requires a request object.", "invalid-input");
  }
  if (!isGuideStatus(request.current)) {
    throw new StatusError(
      `Unknown current status "${String(request.current)}".`,
      "unknown-status",
      { status: request.current },
    );
  }
  if (!isGuideStatus(request.next)) {
    throw new StatusError(
      `Unknown next status "${String(request.next)}".`,
      "unknown-status",
      { status: request.next },
    );
  }

  // A "no-op" transition (current === next) is technically not in the table
  // because the table is a transition graph; treat it as an illegal request
  // rather than silently succeeding, because a caller who asked for a no-op
  // either has stale UI or intends something this module does not model.
  const edge = TRANSITIONS.find(
    (e) => e.from === request.current && e.to === request.next,
  );
  if (edge === undefined) {
    return Object.freeze({
      version: "status-transition/1",
      current: request.current,
      next: request.next,
      allowed: false,
      requiresReview: false,
      requiresNote: false,
      refusalReason:
        request.current === request.next
          ? `Guide is already "${request.current}"; no transition is needed.`
          : `Transition "${request.current}" -> "${request.next}" is not permitted. Allowed from "${request.current}": ${allowedNextStatuses(request.current).join(", ") || "none"}.`,
    });
  }

  // When the edge requires a note, the caller must supply a non-empty one.
  const note = typeof request.note === "string" ? request.note.trim() : "";
  if (edge.requiresNote && note.length === 0) {
    return Object.freeze({
      version: "status-transition/1",
      current: request.current,
      next: request.next,
      allowed: false,
      requiresReview: edge.requiresReview,
      requiresNote: true,
      refusalReason: `Transition "${request.current}" -> "${request.next}" requires a non-empty note.`,
    });
  }

  return Object.freeze({
    version: "status-transition/1",
    current: request.current,
    next: request.next,
    allowed: true,
    requiresReview: edge.requiresReview,
    requiresNote: edge.requiresNote,
    refusalReason: null,
  });
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Produce the resulting row given a validated transition. Throws a typed
 * error when the transition is not allowed, so a caller that skipped
 * `validateTransition` cannot accidentally persist an illegal state.
 *
 * The caller is expected to persist any change to `statusChangedAt` and to
 * write an audit entry separately; this module only produces the row shape.
 */
export function applyTransition(
  row: GuideStatusRow,
  request: TransitionRequest,
  now: Date = new Date(),
): GuideStatusRow {
  if (row === null || typeof row !== "object" || typeof row.id !== "string") {
    throw new StatusError(
      "applyTransition requires a guide status row with an id.",
      "invalid-input",
    );
  }
  if (row.status !== request.current) {
    throw new StatusError(
      `Guide "${row.id}" is currently "${row.status}"; the request expects "${request.current}". Refresh before applying a transition.`,
      "illegal-transition",
      { guideId: row.id, current: row.status, requested: request.current },
    );
  }
  const decision = validateTransition(request);
  if (!decision.allowed) {
    throw new StatusError(
      decision.refusalReason ?? `Transition refused without a reason.`,
      decision.requiresNote && decision.refusalReason?.includes("requires a non-empty note")
        ? "changelog-required"
        : "illegal-transition",
      { current: request.current, next: request.next },
    );
  }
  const note = typeof request.note === "string" ? request.note.trim() : "";
  return Object.freeze({
    ...row,
    status: request.next,
    statusChangedBy: request.actorId,
    statusChangedAt: now.toISOString(),
    statusNote: note.length > 0 ? note : row.statusNote,
  });
}

/* -------------------------------------------------------------------------- */
/* Human text                                                                  */
/* -------------------------------------------------------------------------- */

export function summariseStatus(status: GuideStatus): string {
  switch (status) {
    case "draft":
      return "Draft — visible only to the workspace.";
    case "review":
      return "In review — visible to the workspace; awaiting approval.";
    case "published":
      return "Published — reachable by shareable links.";
    case "archived":
      return "Archived — frozen and hidden from the dashboard's default view.";
  }
}

/**
 * Stable colour token for the dashboard badge. Semantic names rather than
 * hex values so the branding layer maps them to the workspace's palette
 * without this module knowing about colours.
 */
export function statusColour(
  status: GuideStatus,
): "neutral" | "info" | "success" | "muted" {
  switch (status) {
    case "draft":
      return "neutral";
    case "review":
      return "info";
    case "published":
      return "success";
    case "archived":
      return "muted";
  }
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateGuideStatusRow(value: unknown): GuideStatusRow {
  if (value === null || typeof value !== "object") {
    throw new StatusError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? r["id"] : "";
  if (id.length === 0) {
    throw new StatusError("Rehydrate failed: `id` is required.", "invalid-input");
  }
  const workspaceId = typeof r["workspaceId"] === "string" ? r["workspaceId"] : "";
  const status = isGuideStatus(r["status"]) ? r["status"] : "draft";
  return Object.freeze({
    id,
    workspaceId,
    status,
    statusChangedBy:
      typeof r["statusChangedBy"] === "string" ? r["statusChangedBy"] : null,
    statusChangedAt:
      typeof r["statusChangedAt"] === "string" ? r["statusChangedAt"] : null,
    statusNote: typeof r["statusNote"] === "string" ? r["statusNote"] : null,
  });
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  TRANSITIONS,
});
