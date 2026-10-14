/**
 * Zipy AI — collaboration: comments and mentions (editing, collab batch 0).
 *
 * Comments are attached to a *target* (a guide section, a step, or a
 * specific span of a step's text) and can mention teammates. The module is
 * a pure transformation layer: a `Thread` groups an ordered list of
 * `Comment`s that share a target; each comment records its author, its
 * body (plain text — rendered as Markdown by the view), the parsed
 * `mentions` it contains, and a resolved/unresolved status.
 *
 * Two surfaces are carefully kept separate:
 *
 *   - `parseMentions` extracts `@username` tokens using a grammar that
 *     tolerates the common punctuation neighbours without silently
 *     swallowing a trailing period. It does **not** look up whether the
 *     handle corresponds to a real user; the caller (route + workspace
 *     membership) is responsible for resolving the handle and dropping
 *     unresolvable ones before they are turned into notifications.
 *   - `composeComment` validates the body and records the mention list the
 *     caller resolved. It does not silently strip an unresolvable mention;
 *     doing so would leave the reviewer thinking they had notified someone
 *     they had not.
 *
 * The module is deliberately unaware of email, Slack or push delivery. Those
 * integrations are separate phases; the caller reads `mentions` and
 * dispatches.
 *
 * Design rules honoured:
 *  - Nothing is invented: mention handles are parsed from the caller's
 *    body; the module never fabricates a recipient list.
 *  - Deterministic: given the same body and the same target, the parsed
 *    mention list is byte-identical (order preserved, first-occurrence).
 *  - Anchors carry provenance (`sourceRefs`) so a comment attached to a
 *    step can be shown against the artefact region the step came from.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type CommentsErrorCode =
  | "invalid-input"
  | "empty-body"
  | "unknown-comment"
  | "unknown-thread";

export class CommentsError extends Error {
  readonly code: CommentsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: CommentsErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                 */
/* -------------------------------------------------------------------------- */

export const COMMENT_TARGETS = ["guide", "section", "step", "span"] as const;
export type CommentTarget = (typeof COMMENT_TARGETS)[number];

export interface CommentAnchor {
  readonly target: CommentTarget;
  /** Only set for `target === "guide"`. */
  readonly guideId: string | null;
  /** Only set for `target === "section"` or `"span"`. */
  readonly sectionId: string | null;
  /** Only set for `target === "step"` or `"span"`. */
  readonly stepId: string | null;
  /** 0-based inclusive; only set for `target === "span"`. */
  readonly spanStart: number | null;
  /** 0-based exclusive; only set for `target === "span"`. */
  readonly spanEnd: number | null;
  /** Provenance labels carried from the source material, for reviewer reference. */
  readonly sourceRefs: readonly string[];
}

export interface CommentMention {
  /** The handle as written, without the leading `@`. */
  readonly handle: string;
  /** 0-based offset of the `@` in the raw body. */
  readonly offset: number;
  /**
   * Caller-supplied resolution. `null` when the caller did not resolve the
   * handle (e.g. the username is not a member of this workspace).
   */
  readonly userId: string | null;
}

export interface Comment {
  readonly id: string;
  readonly threadId: string;
  readonly author: string;
  /** Plain-text body; the view renders it as Markdown. */
  readonly body: string;
  readonly anchor: CommentAnchor;
  readonly mentions: readonly CommentMention[];
  readonly resolved: boolean;
  /** Who resolved the thread (only set on the comment that resolved it). */
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  /** Optional provenance list (source artefact ids, page numbers). */
  readonly sourceRefs: readonly string[];
}

export interface Thread {
  readonly id: string;
  readonly anchor: CommentAnchor;
  readonly comments: readonly Comment[];
  readonly resolved: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadCollection {
  readonly version: "threads/1";
  readonly threads: readonly Thread[];
  /** Non-fatal problems surfaced to the editor (e.g. mention unresolvable). */
  readonly gaps: readonly CommentGap[];
  readonly updatedAt: string;
}

export type CommentGapReason =
  | "unresolved-mention"
  | "duplicate-thread-anchor"
  | "empty-thread";

export interface CommentGap {
  readonly threadId: string | null;
  readonly commentId: string | null;
  readonly reason: CommentGapReason;
  readonly detail: string;
}

export interface ComposeAnchorInput {
  readonly target: CommentTarget;
  readonly guideId?: string | null;
  readonly sectionId?: string | null;
  readonly stepId?: string | null;
  readonly spanStart?: number | null;
  readonly spanEnd?: number | null;
  readonly sourceRefs?: readonly string[];
}

/**
 * The viewer-side record of "who can be mentioned". The caller resolves
 * handles to user ids *before* calling `composeComment`. The map is
 * case-insensitive on the handle.
 */
export type MentionResolver = (handle: string) => string | null;

export interface ComposeCommentInput {
  readonly author: string;
  readonly body: string;
  readonly anchor: ComposeAnchorInput;
  /** Case-insensitive handle→user-id resolver. A handle with no resolution stays `null`. */
  readonly resolveMention?: MentionResolver | null;
  /** Supplied to make the test suite deterministic. */
  readonly now?: Date | null;
  readonly id?: string | null;
  readonly threadId?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Normalise and validate an anchor. Throws when the anchor's shape does not
 * match its target — e.g. a `"span"` anchor without a span range, a
 * `"step"` anchor without a step id.
 */
export function composeAnchor(input: ComposeAnchorInput): CommentAnchor {
  if (input === null || typeof input !== "object") {
    throw new CommentsError("composeAnchor requires an anchor object.", "invalid-input");
  }
  if (!isCommentTarget(input.target)) {
    throw new CommentsError(
      `Unknown comment target "${String(input.target)}".`,
      "invalid-input",
      { target: input.target },
    );
  }
  const guideId = pruneString(input.guideId);
  const sectionId = pruneString(input.sectionId);
  const stepId = pruneString(input.stepId);
  const sourceRefs = Array.isArray(input.sourceRefs)
    ? input.sourceRefs.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];

  switch (input.target) {
    case "guide":
      if (guideId === null) {
        throw new CommentsError("A guide anchor requires a guideId.", "invalid-input");
      }
      return {
        target: "guide",
        guideId,
        sectionId: null,
        stepId: null,
        spanStart: null,
        spanEnd: null,
        sourceRefs,
      };
    case "section":
      if (sectionId === null) {
        throw new CommentsError("A section anchor requires a sectionId.", "invalid-input");
      }
      return {
        target: "section",
        guideId,
        sectionId,
        stepId: null,
        spanStart: null,
        spanEnd: null,
        sourceRefs,
      };
    case "step":
      if (stepId === null) {
        throw new CommentsError("A step anchor requires a stepId.", "invalid-input");
      }
      return {
        target: "step",
        guideId,
        sectionId,
        stepId,
        spanStart: null,
        spanEnd: null,
        sourceRefs,
      };
    case "span": {
      const start = input.spanStart;
      const end = input.spanEnd;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        start >= end
      ) {
        throw new CommentsError(
          "A span anchor requires integer spanStart < spanEnd.",
          "invalid-input",
          { spanStart: start, spanEnd: end },
        );
      }
      if (stepId === null && sectionId === null) {
        throw new CommentsError(
          "A span anchor requires a stepId or sectionId to anchor the offsets against.",
          "invalid-input",
        );
      }
      return {
        target: "span",
        guideId,
        sectionId,
        stepId,
        spanStart: start,
        spanEnd: end,
        sourceRefs,
      };
    }
  }
}

/**
 * Parse `@handle` tokens from a body. The handle grammar is: a Unicode
 * letter or digit, followed by letters, digits or `-_`. `@` is recognised
 * only when preceded by start-of-string, whitespace or one of the opening
 * punctuation characters `([{'">` — so `email@host` is not parsed as a
 * mention. Handles shorter than 2 characters are skipped.
 */
export function parseMentions(body: string): readonly { handle: string; offset: number }[] {
  if (typeof body !== "string") {
    throw new CommentsError("parseMentions requires a string.", "invalid-input");
  }
  const out: { handle: string; offset: number }[] = [];
  const seen = new Set<string>();
  const re = /(^|[\s([{'">])@([\p{L}\p{N}][\p{L}\p{N}_-]{1,63})/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const lead = match[1] ?? "";
    const handle = match[2] ?? "";
    if (handle.length < 2) continue;
    const offset = match.index + lead.length;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ handle, offset });
  }
  return out;
}

/**
 * Build a comment. Validates the body and, using the caller's resolver,
 * produces the mention list. Mentions the caller cannot resolve are kept
 * in the list with `userId: null` and recorded in the gaps array the
 * collection exposes.
 */
export function composeComment(
  input: ComposeCommentInput,
  threadId: string,
): { readonly comment: Comment; readonly gaps: readonly CommentGap[] } {
  if (input === null || typeof input !== "object") {
    throw new CommentsError("composeComment requires a comment object.", "invalid-input");
  }
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body.length === 0) {
    throw new CommentsError("A comment body is required.", "empty-body");
  }
  const anchor = composeAnchor(input.anchor);
  const author =
    typeof input.author === "string" && input.author.trim().length > 0
      ? input.author.trim()
      : "unknown";
  const now = input.now instanceof Date ? input.now : new Date();
  const id = pruneString(input.id) ?? `c-${threadId}-${now.getTime().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

  const mentions: CommentMention[] = [];
  const gaps: CommentGap[] = [];
  const resolver = input.resolveMention ?? null;
  for (const parsed of parseMentions(body)) {
    let userId: string | null = null;
    if (resolver !== null) {
      const resolved = resolver(parsed.handle);
      userId = typeof resolved === "string" && resolved.length > 0 ? resolved : null;
    }
    if (userId === null) {
      gaps.push({
        threadId,
        commentId: id,
        reason: "unresolved-mention",
        detail: `Mention @${parsed.handle} could not be resolved to a workspace member; no notification will be sent.`,
      });
    }
    mentions.push({ handle: parsed.handle, offset: parsed.offset, userId });
  }

  const comment: Comment = {
    id,
    threadId,
    author,
    body,
    anchor,
    mentions,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: now.toISOString(),
    sourceRefs: Array.isArray(input.sourceRefs ?? undefined)
      ? (input.sourceRefs as readonly string[])
      : anchor.sourceRefs,
  };
  return { comment, gaps };
}

/**
 * Create a new thread at an anchor and append the first comment. When a
 * thread already exists at the same anchor and is still open, this helper
 * appends to the existing thread instead of creating a duplicate; the
 * composition of a fresh anchor with an existing open thread is the
 * common case when a reviewer replies to a comment.
 */
export function upsertThread(
  collection: ThreadCollection,
  input: ComposeCommentInput,
): ThreadCollection {
  assertThreadCollection(collection);
  const anchor = composeAnchor(input.anchor);
  const existing = collection.threads.find(
    (t) => !t.resolved && threadMatchesAnchor(t.anchor, anchor),
  );
  const now = input.now instanceof Date ? input.now : new Date();
  if (existing !== undefined) {
    const { comment, gaps } = composeComment(input, existing.id);
    const updatedThread: Thread = {
      ...existing,
      comments: [...existing.comments, comment].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      ),
      updatedAt: now.toISOString(),
    };
    return {
      version: "threads/1",
      threads: collection.threads.map((t) => (t.id === existing.id ? updatedThread : t)),
      gaps: [...collection.gaps, ...gaps],
      updatedAt: now.toISOString(),
    };
  }

  const threadId = `t-${collection.threads.length + 1}-${now.getTime().toString(36)}`;
  const { comment, gaps } = composeComment(input, threadId);
  const thread: Thread = {
    id: threadId,
    anchor,
    comments: [comment],
    resolved: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return {
    version: "threads/1",
    threads: [...collection.threads, thread],
    gaps: [...collection.gaps, ...gaps],
    updatedAt: now.toISOString(),
  };
}

/**
 * Mark a thread resolved. Preserves the full comment history; the
 * resolution is recorded on the thread and on the last comment so the
 * activity feed can cite both.
 */
export function resolveThread(
  collection: ThreadCollection,
  threadId: string,
  resolver: string,
  reason?: string,
): ThreadCollection {
  assertThreadCollection(collection);
  const index = collection.threads.findIndex((t) => t.id === threadId);
  if (index < 0) {
    throw new CommentsError(
      `No thread with id "${threadId}".`,
      "unknown-thread",
      { threadId },
    );
  }
  const existing = collection.threads[index]!;
  if (existing.resolved) return collection;
  const now = new Date();
  const lastComment = existing.comments[existing.comments.length - 1];
  const updatedComments = lastComment
    ? existing.comments.map((c) =>
        c.id === lastComment.id
          ? {
              ...c,
              resolved: true,
              resolvedBy: resolver,
              resolvedAt: now.toISOString(),
              body:
                reason !== undefined && reason.trim().length > 0
                  ? `${c.body}\n\n_Resolved by ${resolver}:_ ${reason.trim()}`
                  : c.body,
            }
          : c,
      )
    : existing.comments;
  const updated: Thread = {
    ...existing,
    comments: updatedComments,
    resolved: true,
    updatedAt: now.toISOString(),
  };
  const threads = collection.threads.slice();
  threads[index] = updated;
  return {
    version: "threads/1",
    threads,
    gaps: collection.gaps,
    updatedAt: now.toISOString(),
  };
}

/**
 * Reopen a resolved thread. Records the reviewer who reopened it by adding
 * a system comment so the sequence is visible in the history.
 */
export function reopenThread(
  collection: ThreadCollection,
  threadId: string,
  reopener: string,
  reason: string,
): ThreadCollection {
  assertThreadCollection(collection);
  const index = collection.threads.findIndex((t) => t.id === threadId);
  if (index < 0) {
    throw new CommentsError(
      `No thread with id "${threadId}".`,
      "unknown-thread",
      { threadId },
    );
  }
  const existing = collection.threads[index]!;
  if (!existing.resolved) return collection;
  const now = new Date();
  const systemComment: Comment = {
    id: `c-system-${threadId}-${now.getTime().toString(36)}`,
    threadId,
    author: reopener,
    body: reason.trim().length > 0 ? `_Reopened:_ ${reason.trim()}` : "_Reopened._",
    anchor: existing.anchor,
    mentions: [],
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: now.toISOString(),
    sourceRefs: [],
  };
  const updated: Thread = {
    ...existing,
    comments: [...existing.comments, systemComment],
    resolved: false,
    updatedAt: now.toISOString(),
  };
  const threads = collection.threads.slice();
  threads[index] = updated;
  return {
    version: "threads/1",
    threads,
    gaps: collection.gaps,
    updatedAt: now.toISOString(),
  };
}

/**
 * The reviewer's inbox: every open thread whose anchor is either global or
 * mentions the reviewer (by user id). Used by the review phase's dashboard.
 */
export function inboxFor(
  collection: ThreadCollection,
  userId: string,
): readonly Thread[] {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new CommentsError("inboxFor requires a user id.", "invalid-input");
  }
  return collection.threads.filter(
    (t) =>
      !t.resolved &&
      t.comments.some((c) => c.mentions.some((m) => m.userId === userId)),
  );
}

/**
 * Create an empty collection. Provided for callers that start with no
 * comments; the schema is stable so the caller can persist this.
 */
export function emptyThreadCollection(): ThreadCollection {
  return {
    version: "threads/1",
    threads: [],
    gaps: [],
    updatedAt: new Date().toISOString(),
  };
}

export function rehydrateThreadCollection(value: unknown): ThreadCollection {
  if (value === null || typeof value !== "object") {
    throw new CommentsError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const threadsRaw = Array.isArray(r["threads"]) ? (r["threads"] as unknown[]) : [];
  const threads: Thread[] = [];
  for (const item of threadsRaw) {
    if (item === null || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const anchorRaw = t["anchor"];
    if (anchorRaw === null || typeof anchorRaw !== "object") continue;
    let anchor: CommentAnchor;
    try {
      anchor = rehydrateAnchor(anchorRaw as Record<string, unknown>);
    } catch {
      continue;
    }
    const commentsRaw = Array.isArray(t["comments"]) ? (t["comments"] as unknown[]) : [];
    const comments: Comment[] = [];
    for (const c of commentsRaw) {
      if (c === null || typeof c !== "object") continue;
      const cc = c as Record<string, unknown>;
      const id = typeof cc["id"] === "string" ? cc["id"] : "";
      const author = typeof cc["author"] === "string" ? cc["author"] : "";
      const body = typeof cc["body"] === "string" ? cc["body"] : "";
      if (id.length === 0 || body.length === 0) continue;
      const mentionsRaw = Array.isArray(cc["mentions"]) ? (cc["mentions"] as unknown[]) : [];
      const mentions: CommentMention[] = [];
      for (const m of mentionsRaw) {
        if (m === null || typeof m !== "object") continue;
        const mm = m as Record<string, unknown>;
        const handle = typeof mm["handle"] === "string" ? mm["handle"] : "";
        if (handle.length === 0) continue;
        mentions.push({
          handle,
          offset: Number(mm["offset"]) || 0,
          userId: typeof mm["userId"] === "string" ? mm["userId"] : null,
        });
      }
      comments.push({
        id,
        threadId: typeof cc["threadId"] === "string" ? cc["threadId"] : "",
        author,
        body,
        anchor,
        mentions,
        resolved: cc["resolved"] === true,
        resolvedBy: typeof cc["resolvedBy"] === "string" ? cc["resolvedBy"] : null,
        resolvedAt: typeof cc["resolvedAt"] === "string" ? cc["resolvedAt"] : null,
        createdAt: typeof cc["createdAt"] === "string" ? cc["createdAt"] : "",
        sourceRefs: Array.isArray(cc["sourceRefs"])
          ? (cc["sourceRefs"] as unknown[]).filter((s): s is string => typeof s === "string")
          : [],
      });
    }
    const id = typeof t["id"] === "string" ? t["id"] : "";
    if (id.length === 0 || comments.length === 0) continue;
    threads.push({
      id,
      anchor,
      comments,
      resolved: t["resolved"] === true,
      createdAt: typeof t["createdAt"] === "string" ? t["createdAt"] : "",
      updatedAt: typeof t["updatedAt"] === "string" ? t["updatedAt"] : "",
    });
  }
  const gaps: CommentGap[] = [];
  if (Array.isArray(r["gaps"])) {
    for (const g of r["gaps"] as unknown[]) {
      if (g === null || typeof g !== "object") continue;
      const gg = g as Record<string, unknown>;
      const reason = gg["reason"];
      if (
        reason !== "unresolved-mention" &&
        reason !== "duplicate-thread-anchor" &&
        reason !== "empty-thread"
      ) {
        continue;
      }
      gaps.push({
        threadId: typeof gg["threadId"] === "string" ? gg["threadId"] : null,
        commentId: typeof gg["commentId"] === "string" ? gg["commentId"] : null,
        reason,
        detail: typeof gg["detail"] === "string" ? gg["detail"] : "",
      });
    }
  }
  return {
    version: "threads/1",
    threads,
    gaps,
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function assertThreadCollection(value: unknown): asserts value is ThreadCollection {
  if (value === null || typeof value !== "object") {
    throw new CommentsError("Expected a thread collection object.", "invalid-input");
  }
  const v = value as Record<string, unknown>;
  if (v["version"] !== "threads/1") {
    throw new CommentsError(
      `Unknown thread collection version "${String(v["version"])}".`,
      "invalid-input",
    );
  }
  if (!Array.isArray(v["threads"])) {
    throw new CommentsError("Thread collection has no `threads` array.", "invalid-input");
  }
}

function threadMatchesAnchor(a: CommentAnchor, b: CommentAnchor): boolean {
  return (
    a.target === b.target &&
    (a.guideId ?? null) === (b.guideId ?? null) &&
    (a.sectionId ?? null) === (b.sectionId ?? null) &&
    (a.stepId ?? null) === (b.stepId ?? null) &&
    (a.spanStart ?? null) === (b.spanStart ?? null) &&
    (a.spanEnd ?? null) === (b.spanEnd ?? null)
  );
}

function rehydrateAnchor(raw: Record<string, unknown>): CommentAnchor {
  const target = raw["target"];
  if (!isCommentTarget(target)) {
    throw new CommentsError(
      `Unknown comment target "${String(target)}".`,
      "invalid-input",
    );
  }
  return composeAnchor({
    target,
    guideId: typeof raw["guideId"] === "string" ? raw["guideId"] : null,
    sectionId: typeof raw["sectionId"] === "string" ? raw["sectionId"] : null,
    stepId: typeof raw["stepId"] === "string" ? raw["stepId"] : null,
    spanStart: typeof raw["spanStart"] === "number" ? raw["spanStart"] : null,
    spanEnd: typeof raw["spanEnd"] === "number" ? raw["spanEnd"] : null,
    sourceRefs: Array.isArray(raw["sourceRefs"])
      ? (raw["sourceRefs"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
  });
}

function isCommentTarget(v: unknown): v is CommentTarget {
  return typeof v === "string" && (COMMENT_TARGETS as readonly string[]).includes(v);
}

function pruneString(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  assertThreadCollection,
  threadMatchesAnchor,
  rehydrateAnchor,
  isCommentTarget,
  pruneString,
});
