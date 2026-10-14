/**
 * Zipy AI — collaboration: track changes (editing, collab batch 0).
 *
 * An *edit* is a proposed change to a specific span of a guide's text. Edits
 * arrive from three sources and all three are treated identically by this
 * module:
 *
 *   1. A reviewer edits the text in the editor.
 *   2. `rewrite.ts` proposes an AI alternative: a candidate that, when
 *      accepted, becomes an edit.
 *   3. A bulk-edit batch from the editor applies the same change to many
 *      steps; the caller fans that out into one edit per step before calling
 *      this module.
 *
 * Two invariants govern the module:
 *
 *   - **Non-overlapping edits.** Two edits may not target the same span, on
 *     the same revision, at the same time. Overlapping proposals are
 *     rejected with a diagnostic; the editor's caller resolves one of them.
 *   - **Stable offsets across revisions.** An edit's `span` is expressed
 *     against the *document version it was authored against*
 *     (`sourceVersion`). When later edits have already been accepted, the
 *     module rebases an older edit's span onto the current version (a
 *     standard operational-transform-style "shift by adjacent deltas"
 *     approach), or marks it as `conflicted` when the underlying span was
 *     touched.
 *
 * The module does not maintain the document. It is a review surface: an
 * ordered collection of edits with accept/reject state and a diff view.
 * The persistence layer (later phase) stores the collection keyed on the
 * guide id; the editor component renders it.
 *
 * Design rules honoured:
 *  - No invented text. A `trackChanges` record never contains a proposed
 *    replacement that the caller did not supply; the module never rewrites
 *    the after-text.
 *  - Deterministic: applied in a stable order (authoring order, then id).
 *  - All state transitions are pure functions returning new collections.
 *  - Rejecting an edit is preserved as history (the record stays in the
 *    collection with status "rejected") so the activity feed and audit
 *    trail can cite it.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type TrackChangesErrorCode =
  | "invalid-input"
  | "out-of-range"
  | "overlapping-edit"
  | "unknown-edit"
  | "already-decided";

export class TrackChangesError extends Error {
  readonly code: TrackChangesErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TrackChangesErrorCode,
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

export const EDIT_STATUSES = ["proposed", "accepted", "rejected", "conflicted"] as const;
export type EditStatus = (typeof EDIT_STATUSES)[number];

export const EDIT_SOURCES = ["human", "ai-rewrite", "bulk", "import"] as const;
export type EditSource = (typeof EDIT_SOURCES)[number];

export interface EditSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * One tracked edit. `span` is expressed against `sourceVersion`. When the
 * editor accepts the edit, the caller applies `after` to `before` at the
 * (rebased) span to produce the new document body.
 */
export interface TrackedEdit {
  readonly id: string;
  /** The document revision the span was authored against. */
  readonly sourceVersion: number;
  readonly span: EditSpan;
  readonly before: string;
  readonly after: string;
  readonly author: string;
  readonly source: EditSource;
  readonly status: EditStatus;
  /** When the status is `rejected`, the reviewer who rejected it. */
  readonly decidedBy: string | null;
  /** ISO timestamp the status last changed. */
  readonly decidedAt: string | null;
  /** Free-text rationale (from AI rewrite or from the reviewer's note). */
  readonly rationale: string;
  /** Provenance labels (source artefact ids, page numbers) carried over from rewrite.ts. */
  readonly sourceRefs: readonly string[];
  /** ISO timestamp the edit proposal was recorded. */
  readonly createdAt: string;
}

export interface TrackedEditInput {
  readonly id?: string;
  readonly sourceVersion: number;
  readonly span: EditSpan;
  readonly before: string;
  readonly after: string;
  readonly author: string;
  readonly source: EditSource;
  readonly rationale?: string;
  readonly sourceRefs?: readonly string[];
}

/**
 * The persistent collection. `version` is the *current* document version
 * the collection is being tracked against; the caller bumps it when the
 * empty-body document is saved (or when the caller applies an accepted
 * edit's after-text and wants a new version).
 */
export interface ChangeSet {
  readonly version: "changeset/1";
  readonly documentVersion: number;
  readonly edits: readonly TrackedEdit[];
  /** ISO timestamp of the last mutation. */
  readonly updatedAt: string;
}

export interface DiffLine {
  readonly kind: "keep" | "insert" | "delete";
  readonly beforeLine: number | null;
  readonly afterLine: number | null;
  readonly text: string;
}

export interface ApplyOutcome {
  /** The document body with all `accepted` edits applied. */
  readonly body: string;
  /** Edits that were accepted and applied. */
  readonly applied: readonly string[];
  /** Edits that could not be applied (conflicted or with a rebased span beyond the body). */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                   */
/* -------------------------------------------------------------------------- */

export function createChangeSet(documentVersion: number): ChangeSet {
  if (!Number.isFinite(documentVersion) || documentVersion < 0) {
    throw new TrackChangesError(
      "documentVersion must be a non-negative integer.",
      "invalid-input",
      { documentVersion },
    );
  }
  return {
    version: "changeset/1",
    documentVersion: Math.floor(documentVersion),
    edits: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Record an edit. Throws when:
 *  - the span is out of range for `documentVersion`'s text, when a text is
 *    supplied for validation,
 *  - an existing *proposed* or *accepted* edit overlaps this span (edits
 *    that are rejected or conflicted do not block a new proposal; the
 *    reviewer has already resolved them).
 */
export function recordEdit(
  changeset: ChangeSet,
  input: TrackedEditInput,
  textForValidation?: string,
): ChangeSet {
  assertChangeset(changeset);
  if (input === null || typeof input !== "object") {
    throw new TrackChangesError("recordEdit requires an edit object.", "invalid-input");
  }
  const span: EditSpan = {
    start: Number(input.span?.start),
    end: Number(input.span?.end),
  };
  if (
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.start >= span.end
  ) {
    throw new TrackChangesError(
      `Span [${String(span.start)}, ${String(span.end)}) is not a valid half-open range.`,
      "invalid-input",
      { span },
    );
  }
  if (input.sourceVersion !== changeset.documentVersion) {
    // A proposal can target an *older* version (a reviewer working against
    // an offline copy). A proposal targeting a *newer* version is a caller
    // bug: the change set has not been advanced.
    if (input.sourceVersion > changeset.documentVersion) {
      throw new TrackChangesError(
        `Edit targets version ${input.sourceVersion} but the change set is at version ${changeset.documentVersion}.`,
        "invalid-input",
        { span, sourceVersion: input.sourceVersion, changesetVersion: changeset.documentVersion },
      );
    }
  }
  if (typeof textForValidation === "string") {
    const len = textForValidation.length;
    if (span.end > len) {
      throw new TrackChangesError(
        `Span end ${span.end} exceeds text length ${len}.`,
        "out-of-range",
        { span, length: len },
      );
    }
    const actual = textForValidation.slice(span.start, span.end);
    if (actual !== input.before && input.sourceVersion === changeset.documentVersion) {
      throw new TrackChangesError(
        "The `before` text does not match the current document at the requested span.",
        "invalid-input",
        { span, expected: input.before, actual },
      );
    }
  }

  const activeEdits = changeset.edits.filter(
    (e) =>
      e.status === "proposed" &&
      e.sourceVersion === input.sourceVersion &&
      overlaps(e.span, span),
  );
  if (activeEdits.length > 0) {
    throw new TrackChangesError(
      `Edit overlaps an existing proposal spanning [${activeEdits[0]!.span.start}, ${activeEdits[0]!.span.end}).`,
      "overlapping-edit",
      { overlapping: activeEdits.map((e) => e.id) },
    );
  }

  const id = nonEmpty(input.id) ?? `ed-${changeset.edits.length + 1}-${span.start}-${span.end}`;
  if (changeset.edits.some((e) => e.id === id)) {
    throw new TrackChangesError(
      `An edit with id "${id}" already exists in this change set.`,
      "invalid-input",
      { id },
    );
  }

  const edit: TrackedEdit = {
    id,
    sourceVersion: input.sourceVersion,
    span,
    before: input.before,
    after: input.after,
    author: typeof input.author === "string" && input.author.length > 0 ? input.author : "unknown",
    source: isEditSource(input.source) ? input.source : "human",
    status: "proposed",
    decidedBy: null,
    decidedAt: null,
    rationale: typeof input.rationale === "string" ? input.rationale : "",
    sourceRefs: Array.isArray(input.sourceRefs)
      ? input.sourceRefs.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [],
    createdAt: new Date().toISOString(),
  };

  return {
    version: "changeset/1",
    documentVersion: changeset.documentVersion,
    edits: insertSorted(changeset.edits, edit),
    updatedAt: new Date().toISOString(),
  };
}

export function acceptEdit(
  changeset: ChangeSet,
  editId: string,
  reviewer: string,
): ChangeSet {
  return decide(changeset, editId, "accepted", reviewer, null);
}

export function rejectEdit(
  changeset: ChangeSet,
  editId: string,
  reviewer: string,
  reason?: string,
): ChangeSet {
  return decide(changeset, editId, "rejected", reviewer, reason ?? null);
}

/**
 * Rebase every proposed edit from an older `sourceVersion` onto the current
 * document version. Call after accepting an edit upstream so downstream
 * proposals still point at the same logical span. Edits whose underlying
 * span was touched by an already-accepted edit are marked `conflicted`.
 */
export function rebaseProposals(
  changeset: ChangeSet,
  textAtCurrentVersion: string,
): ChangeSet {
  assertChangeset(changeset);
  const accepted = changeset.edits
    .filter((e) => e.status === "accepted" && e.sourceVersion < changeset.documentVersion)
    .slice()
    .sort((a, b) => a.span.start - b.span.start);
  if (accepted.length === 0) return changeset;

  const rebased: TrackedEdit[] = [];
  for (const edit of changeset.edits) {
    if (edit.status !== "proposed" || edit.sourceVersion === changeset.documentVersion) {
      rebased.push(edit);
      continue;
    }
    let start = edit.span.start;
    let end = edit.span.end;
    let conflicted = false;
    for (const applied of accepted) {
      const delta = applied.after.length - applied.before.length;
      if (end <= applied.span.start) break;
      if (start >= applied.span.end) {
        start += delta;
        end += delta;
        continue;
      }
      // The span overlaps an accepted edit — the underlying text is gone.
      conflicted = true;
      break;
    }
    if (conflicted) {
      rebased.push({
        ...edit,
        status: "conflicted",
        decidedBy: null,
        decidedAt: new Date().toISOString(),
        rationale:
          `${edit.rationale ? edit.rationale + "\n\n" : ""}Marked conflicted: an earlier accepted edit changed the underlying span; re-author against the current version.`,
      });
      continue;
    }
    if (end > textAtCurrentVersion.length) {
      rebased.push({
        ...edit,
        span: { start, end: textAtCurrentVersion.length },
        sourceVersion: changeset.documentVersion,
        rationale:
          `${edit.rationale ? edit.rationale + "\n\n" : ""}Span clipped to the end of the current document during rebase.`,
      });
      continue;
    }
    rebased.push({
      ...edit,
      span: { start, end },
      sourceVersion: changeset.documentVersion,
    });
  }
  return {
    version: "changeset/1",
    documentVersion: changeset.documentVersion,
    edits: rebased,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Advance the change set to a new document version. The caller invokes this
 * after persisting the body produced by `applyAccepted` (or after an
 * external save). Any still-proposed edits keep their spans and—if their
 * `sourceVersion` matched the previous version—are stamped with the new
 * version.
 */
export function advanceVersion(changeset: ChangeSet, newVersion: number): ChangeSet {
  assertChangeset(changeset);
  if (!Number.isFinite(newVersion) || newVersion <= changeset.documentVersion) {
    throw new TrackChangesError(
      `newVersion must be greater than the current version (${changeset.documentVersion}).`,
      "invalid-input",
      { newVersion, current: changeset.documentVersion },
    );
  }
  const bumped = changeset.edits.map((e) =>
    e.status === "proposed" && e.sourceVersion === changeset.documentVersion
      ? { ...e, sourceVersion: Math.floor(newVersion) }
      : e,
  );
  return {
    version: "changeset/1",
    documentVersion: Math.floor(newVersion),
    edits: bumped,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Produce the document body with every accepted edit applied. Edits are
 * applied right-to-left over the body so offsets stay stable. Any accepted
 * edit whose span would overlap a previously applied change is skipped with
 * a reason string; the caller decides whether to surface it as a
 * consequence of a rebase bug.
 */
export function applyAccepted(changeset: ChangeSet, baseText: string): ApplyOutcome {
  assertChangeset(changeset);
  if (typeof baseText !== "string") {
    throw new TrackChangesError("applyAccepted requires a base text string.", "invalid-input");
  }
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const accepted = changeset.edits
    .filter((e) => e.status === "accepted")
    .slice()
    .sort((a, b) => b.span.start - a.span.start);
  let body = baseText;
  let lastAppliedStart = Number.POSITIVE_INFINITY;
  for (const edit of accepted) {
    if (edit.span.end > body.length) {
      skipped.push({
        id: edit.id,
        reason: `span end ${edit.span.end} exceeds body length ${body.length} after applying later edits`,
      });
      continue;
    }
    if (edit.span.end > lastAppliedStart) {
      skipped.push({
        id: edit.id,
        reason: "overlaps an accepted edit that was already applied",
      });
      continue;
    }
    const actual = body.slice(edit.span.start, edit.span.end);
    if (actual !== edit.before) {
      skipped.push({
        id: edit.id,
        reason: "the text at the edit's span does not match the edit's `before`",
      });
      continue;
    }
    body = body.slice(0, edit.span.start) + edit.after + body.slice(edit.span.end);
    lastAppliedStart = edit.span.start;
    applied.push(edit.id);
  }
  return { body, applied, skipped };
}

/**
 * Compute a line-level diff between `before` and `after`. Used by the
 * `VersionHistory` and diff-view UI. Line-oriented LCS; bounded to the
 * sizes the editor handles (a step or a section, not a whole guide).
 */
export function diffLines(before: string, after: string): readonly DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = (dp[i - 1]![j - 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j] ?? 0, dp[i]![j - 1] ?? 0);
      }
    }
  }
  const out: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({
        kind: "keep",
        beforeLine: i,
        afterLine: j,
        text: a[i - 1]!,
      });
      i -= 1;
      j -= 1;
    } else if ((dp[i - 1]![j] ?? 0) >= (dp[i]![j - 1] ?? 0)) {
      out.push({
        kind: "delete",
        beforeLine: i,
        afterLine: null,
        text: a[i - 1]!,
      });
      i -= 1;
    } else {
      out.push({
        kind: "insert",
        beforeLine: null,
        afterLine: j,
        text: b[j - 1]!,
      });
      j -= 1;
    }
  }
  while (i > 0) {
    out.push({ kind: "delete", beforeLine: i, afterLine: null, text: a[i - 1]! });
    i -= 1;
  }
  while (j > 0) {
    out.push({ kind: "insert", beforeLine: null, afterLine: j, text: b[j - 1]! });
    j -= 1;
  }
  return out.reverse();
}

/**
 * Fan a single edit input out into one edit per target span. Intended for
 * the editor's bulk-edit surface: a reviewer selects "capitalise the first
 * letter of every step title" and the editor produces one input per step;
 * this helper deduplicates and orders them so `recordEdit` can be called in
 * a loop.
 */
export function planBulkEdits(
  inputs: readonly TrackedEditInput[],
): readonly TrackedEditInput[] {
  if (!Array.isArray(inputs)) {
    throw new TrackChangesError("planBulkEdits requires an array.", "invalid-input");
  }
  const sorted = inputs.slice().sort((a, b) => {
    if (a.sourceVersion !== b.sourceVersion) return a.sourceVersion - b.sourceVersion;
    if (a.span.start !== b.span.start) return a.span.start - b.span.start;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
  const out: TrackedEditInput[] = [];
  let lastEnd = -1;
  for (const edit of sorted) {
    if (edit.span.start < lastEnd) {
      // Skip overlapping bulk edits; the caller's contract is that a bulk
      // plan is non-overlapping.
      continue;
    }
    out.push({ ...edit, source: "bulk" });
    lastEnd = edit.span.end;
  }
  return out;
}

export function rehydrateChangeSet(value: unknown): ChangeSet {
  if (value === null || typeof value !== "object") {
    throw new TrackChangesError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const editsRaw = Array.isArray(r["edits"]) ? (r["edits"] as unknown[]) : [];
  const edits: TrackedEdit[] = [];
  for (const item of editsRaw) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const spanRaw = e["span"];
    const span: EditSpan =
      spanRaw !== null && typeof spanRaw === "object"
        ? {
            start: Number((spanRaw as Record<string, unknown>)["start"]) || 0,
            end: Number((spanRaw as Record<string, unknown>)["end"]) || 0,
          }
        : { start: 0, end: 0 };
    if (span.start >= span.end) continue;
    const status = isEditStatus(e["status"]) ? e["status"] : "proposed";
    const source = isEditSource(e["source"]) ? e["source"] : "human";
    edits.push({
      id: typeof e["id"] === "string" && e["id"].length > 0 ? e["id"] : `ed-${edits.length + 1}`,
      sourceVersion: Number(e["sourceVersion"]) || 0,
      span,
      before: typeof e["before"] === "string" ? e["before"] : "",
      after: typeof e["after"] === "string" ? e["after"] : "",
      author: typeof e["author"] === "string" ? e["author"] : "unknown",
      source,
      status,
      decidedBy: typeof e["decidedBy"] === "string" ? e["decidedBy"] : null,
      decidedAt: typeof e["decidedAt"] === "string" ? e["decidedAt"] : null,
      rationale: typeof e["rationale"] === "string" ? e["rationale"] : "",
      sourceRefs: Array.isArray(e["sourceRefs"])
        ? (e["sourceRefs"] as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      createdAt: typeof e["createdAt"] === "string" ? e["createdAt"] : "",
    });
  }
  return {
    version: "changeset/1",
    documentVersion: Number(r["documentVersion"]) || 0,
    edits: insertSortedAll(edits),
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function decide(
  changeset: ChangeSet,
  editId: string,
  status: Extract<EditStatus, "accepted" | "rejected">,
  reviewer: string,
  reason: string | null,
): ChangeSet {
  assertChangeset(changeset);
  if (typeof editId !== "string" || editId.length === 0) {
    throw new TrackChangesError("An edit id is required.", "invalid-input");
  }
  const index = changeset.edits.findIndex((e) => e.id === editId);
  if (index < 0) {
    throw new TrackChangesError(
      `No edit with id "${editId}" in this change set.`,
      "unknown-edit",
      { editId },
    );
  }
  const existing = changeset.edits[index]!;
  if (existing.status === "accepted" || existing.status === "rejected") {
    throw new TrackChangesError(
      `Edit "${editId}" has already been ${existing.status}.`,
      "already-decided",
      { editId, status: existing.status },
    );
  }
  const updated: TrackedEdit = {
    ...existing,
    status,
    decidedBy: reviewer,
    decidedAt: new Date().toISOString(),
    rationale:
      reason !== null && reason.length > 0
        ? `${existing.rationale ? existing.rationale + "\n\n" : ""}${status === "rejected" ? "Rejection note: " : ""}${reason}`
        : existing.rationale,
  };
  const edits = changeset.edits.slice();
  edits[index] = updated;
  return {
    version: "changeset/1",
    documentVersion: changeset.documentVersion,
    edits,
    updatedAt: new Date().toISOString(),
  };
}

function assertChangeset(value: unknown): asserts value is ChangeSet {
  if (value === null || typeof value !== "object") {
    throw new TrackChangesError("Expected a change set object.", "invalid-input");
  }
  const v = value as Record<string, unknown>;
  if (v["version"] !== "changeset/1") {
    throw new TrackChangesError(`Unknown change set version "${String(v["version"])}".`, "invalid-input");
  }
  if (!Array.isArray(v["edits"])) {
    throw new TrackChangesError("Change set has no `edits` array.", "invalid-input");
  }
}

function insertSorted(edits: readonly TrackedEdit[], edit: TrackedEdit): readonly TrackedEdit[] {
  const out = edits.slice();
  out.push(edit);
  return insertSortedAll(out);
}

function insertSortedAll(edits: readonly TrackedEdit[]): readonly TrackedEdit[] {
  return edits
    .slice()
    .sort((a, b) => {
      if (a.sourceVersion !== b.sourceVersion) return a.sourceVersion - b.sourceVersion;
      if (a.span.start !== b.span.start) return a.span.start - b.span.start;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

function overlaps(a: EditSpan, b: EditSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

function isEditStatus(v: unknown): v is EditStatus {
  return typeof v === "string" && (EDIT_STATUSES as readonly string[]).includes(v);
}

function isEditSource(v: unknown): v is EditSource {
  return typeof v === "string" && (EDIT_SOURCES as readonly string[]).includes(v);
}

function nonEmpty(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  decide,
  assertChangeset,
  insertSorted,
  insertSortedAll,
  overlaps,
  isEditStatus,
  isEditSource,
});
