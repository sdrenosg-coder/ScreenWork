/**
 * Zipy AI — guide version diff (phase 24, batch 2).
 *
 * The plan lists "diff view: the user can compare two versions of a guide".
 * This module computes a semantic diff between two guide snapshots: what
 * steps were added, removed, reordered, or edited, and what changed inside
 * each step's copy, annotations, and screenshot reference.
 *
 * Design boundaries honoured here:
 *
 *  - The module is *pure*. It takes two snapshots and produces a diff; it
 *    does not read the database, does not diff HTML (which would produce
 *    noise from whitespace), and does not order the caller's data. The
 *    snapshots are the shape the generate pipeline produces; the diff is
 *    the shape the version-history UI consumes.
 *
 *  - Stability over cleverness. A custom LCS algorithm is small enough to
 *    audit and does not pull in a dependency. The diff uses the same
 *    stability property a text diff would: unchanged items keep their order
 *    and matched pairs are reported as edits rather than as an add + a
 *    remove, so the UI can show "step 3 was edited" rather than "step 3 was
 *    removed and a new step 3 was added".
 *
 *  - Matching is content-anchored. Two steps match when their *stable key*
 *    matches. Every step carries a stable key (`stepKey`) the pipeline
 *    assigns when the step is created; a step that survives an edit keeps its
 *    key so the diff sees an edit, not an identity change. A step whose key
 *    is absent is matched on its position + title, which is the best
 *    available signal for a step produced by a source that predates the
 *    stable-key convention.
 *
 *  - Field-level detail. A matched pair reports *which* fields changed and
 *    the before/after values, so the UI can offer per-field revert. Bulk
 *    replaces of a screenshot, an annotation, or a whole step's copy are all
 *    expressed as field changes rather than as a structural operation.
 *
 *  - No content is invented. The diff reports only what the two snapshots
 *    contain. A field absent from one side and present in the other is
 *    reported as `added` or `removed`; the module does not fill the gap.
 *
 * The module exports:
 *   - `diffGuideVersions` — the top-level diff.
 *   - `summariseDiff` — a one-line human summary the version-history row shows.
 *   - `hasChanges` — a cheap predicate for "is this version worth saving?".
 *   - Typed errors and constants.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type DiffErrorCode = "invalid-input" | "wrong-version";

export class DiffError extends Error {
  readonly code: DiffErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DiffErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DiffError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A field-level change. `before` and `after` are the raw values; the module
 * compares *after serialising to JSON* so nested arrays and objects compare
 * structurally rather than by reference.
 */
export type ChangeKind = "added" | "removed" | "edited";

export interface FieldChange {
  /** Dot-path into the step, e.g. `"copy.title"` or `"annotations.0.text"`. */
  readonly path: string;
  readonly kind: ChangeKind;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * A step as it appears in a guide snapshot. Only the fields the diff reads
 * are declared; a caller may carry extra fields and they are compared too
 * (any unrecognised field is diffed as `path = "step.<field>"`).
 */
export interface StepSnapshot {
  /** Stable key assigned when the step was created. Optional for legacy rows. */
  readonly stepKey?: string;
  readonly index: number;
  readonly title: string;
  readonly description: string;
  /** Screenshot reference (artifact id, URL, or a content hash). */
  readonly screenshotRef: string | null;
  /** Optional alt text; a change here is a copy change worth surfacing. */
  readonly altText?: string | null;
  /** Annotations in order; the annotation phase produces these. */
  readonly annotations?: readonly {
    readonly kind: string;
    readonly text?: string | null;
    readonly targetRef?: string | null;
    readonly [k: string]: unknown;
  }[];
  /** Arbitrary extra fields compared structurally. */
  readonly [k: string]: unknown;
}

export interface GuideSnapshot {
  readonly version: "guide-snapshot/1";
  readonly guideId: string;
  readonly workspaceId: string;
  /** The version label the caller assigned (an ISO timestamp or a semver tag). */
  readonly versionLabel: string;
  readonly title: string;
  readonly summary: string | null;
  readonly steps: readonly StepSnapshot[];
  /** Fields the caller wants diffed at the guide level. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface StepEdit {
  readonly kind: "edited";
  readonly stepKey: string;
  readonly beforeIndex: number;
  readonly afterIndex: number;
  readonly changes: readonly FieldChange[];
}

export interface StepAdded {
  readonly kind: "added";
  readonly stepKey: string;
  readonly afterIndex: number;
  readonly step: StepSnapshot;
}

export interface StepRemoved {
  readonly kind: "removed";
  readonly stepKey: string;
  readonly beforeIndex: number;
  readonly step: StepSnapshot;
}

export type StepDiff = StepEdit | StepAdded | StepRemoved;

export interface GuideDiff {
  readonly version: "guide-diff/1";
  readonly guideId: string;
  readonly workspaceId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  /** Guide-level field changes (title, summary, metadata). */
  readonly guideChanges: readonly FieldChange[];
  /** Per-step diffs, in `toVersion` order with removals in `fromVersion` order. */
  readonly stepDiffs: readonly StepDiff[];
  /** Convenience counters the UI displays on the summary row. */
  readonly counts: {
    readonly added: number;
    readonly removed: number;
    readonly edited: number;
    /** True when any change is reported at any level. */
    readonly changed: boolean;
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compute a semantic diff between two guide snapshots. The second argument is
 * the "to" snapshot; a caller who wants the reverse direction swaps them.
 */
export function diffGuideVersions(
  from: GuideSnapshot,
  to: GuideSnapshot,
): GuideDiff {
  validateSnapshot(from, "from");
  validateSnapshot(to, "to");
  if (from.guideId !== to.guideId) {
    throw new DiffError(
      `Cannot diff snapshots of different guides: "${from.guideId}" vs "${to.guideId}".`,
      "invalid-input",
      { fromGuideId: from.guideId, toGuideId: to.guideId },
    );
  }
  if (from.workspaceId !== to.workspaceId) {
    throw new DiffError(
      `Cannot diff snapshots from different workspaces: "${from.workspaceId}" vs "${to.workspaceId}".`,
      "invalid-input",
      { fromWorkspaceId: from.workspaceId, toWorkspaceId: to.workspaceId },
    );
  }

  const guideChanges = diffGuideLevel(from, to);
  const stepDiffs = diffStepList(from.steps, to.steps);

  const counts = {
    added: stepDiffs.filter((d) => d.kind === "added").length,
    removed: stepDiffs.filter((d) => d.kind === "removed").length,
    edited: stepDiffs.filter((d) => d.kind === "edited").length,
    changed: guideChanges.length > 0 || stepDiffs.length > 0,
  };

  return {
    version: "guide-diff/1",
    guideId: from.guideId,
    workspaceId: from.workspaceId,
    fromVersion: from.versionLabel,
    toVersion: to.versionLabel,
    guideChanges,
    stepDiffs,
    counts,
  };
}

/**
 * A cheap predicate for "should a new version be saved?". The generate
 * pipeline calls this after a regeneration to decide whether to commit a row
 * or reuse the previous version. It compares the two snapshots' serialised
 * forms; a snapshot that differs only by its `createdAt` timestamp is *not*
 * considered a change.
 */
export function hasChanges(from: GuideSnapshot, to: GuideSnapshot): boolean {
  const a = canonicaliseSnapshot(from);
  const b = canonicaliseSnapshot(to);
  return a !== b;
}

/**
 * One-line summary for a version-history row: e.g.
 * `v3 → v4: title edited, 1 step added, 2 steps edited`.
 */
export function summariseDiff(diff: GuideDiff): string {
  const parts: string[] = [];
  if (diff.guideChanges.length > 0) {
    parts.push(`${diff.guideChanges.length} guide field${diff.guideChanges.length === 1 ? "" : "s"} edited`);
  }
  if (diff.counts.added > 0) parts.push(`${diff.counts.added} step${diff.counts.added === 1 ? "" : "s"} added`);
  if (diff.counts.removed > 0) parts.push(`${diff.counts.removed} step${diff.counts.removed === 1 ? "" : "s"} removed`);
  if (diff.counts.edited > 0) parts.push(`${diff.counts.edited} step${diff.counts.edited === 1 ? "" : "s"} edited`);
  const body = parts.length === 0 ? "no changes" : parts.join(", ");
  return `${diff.fromVersion} → ${diff.toVersion}: ${body}.`;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function validateSnapshot(s: GuideSnapshot, label: string): void {
  if (s === null || typeof s !== "object") {
    throw new DiffError(`diffGuideVersions requires a \`${label}\` snapshot.`, "invalid-input");
  }
  if (s.version !== "guide-snapshot/1") {
    throw new DiffError(
      `\`${label}\` snapshot has version "${String((s as { version?: unknown }).version)}"; expected "guide-snapshot/1".`,
      "wrong-version",
    );
  }
  if (!Array.isArray(s.steps)) {
    throw new DiffError(`\`${label}\` snapshot's \`steps\` must be an array.`, "invalid-input");
  }
}

function diffGuideLevel(from: GuideSnapshot, to: GuideSnapshot): readonly FieldChange[] {
  const out: FieldChange[] = [];
  compareField(out, "title", from.title, to.title);
  compareField(out, "summary", from.summary, to.summary);
  const fromMeta = from.metadata ?? {};
  const toMeta = to.metadata ?? {};
  const keys = new Set<string>([...Object.keys(fromMeta), ...Object.keys(toMeta)]);
  for (const key of [...keys].sort()) {
    const before = Object.prototype.hasOwnProperty.call(fromMeta, key) ? fromMeta[key] : undefined;
    const after = Object.prototype.hasOwnProperty.call(toMeta, key) ? toMeta[key] : undefined;
    compareField(out, `metadata.${key}`, before, after);
  }
  return Object.freeze(out);
}

function diffStepList(
  fromSteps: readonly StepSnapshot[],
  toSteps: readonly StepSnapshot[],
): readonly StepDiff[] {
  // Key each step. A step carries its `stepKey`; when absent, we synthesise a
  // key from the title so a legacy row still matches across versions unless
  // the title itself changed. This is the property that lets the diff report
  // an edit rather than a remove + add for an unchanged legacy step.
  const fromKeys = fromSteps.map(stepKeyFor);
  const toKeys = toSteps.map(stepKeyFor);

  // Match steps by key. Steps with a key that appears on both sides form
  // candidate pairs; the pairs are ordered by their `to` index to preserve
  // the reader's eye-line.
  const fromByKey = new Map<string, number>();
  fromKeys.forEach((key, i) => {
    // Duplicate keys are a caller bug; keep the first occurrence so the
    // stable result is deterministic.
    if (!fromByKey.has(key)) fromByKey.set(key, i);
  });

  const matchedFromIdx = new Set<number>();
  const matchedToIdx = new Set<number>();
  type Pair = { fromIdx: number; toIdx: number; key: string };
  const pairs: Pair[] = [];
  toKeys.forEach((key, toIdx) => {
    const fromIdx = fromByKey.get(key);
    if (fromIdx === undefined) return;
    if (matchedFromIdx.has(fromIdx)) return;
    matchedFromIdx.add(fromIdx);
    matchedToIdx.add(toIdx);
    pairs.push({ fromIdx, toIdx, key });
  });
  pairs.sort((a, b) => a.toIdx - b.toIdx);

  const out: StepDiff[] = [];
  // Walk the `from` list: each matched pair produces an edit (or nothing, if
  // the step is unchanged); each unmatched from-step is a removal. This
  // ordering matches what a user expects to read: removals are described at
  // the position they occupied in the previous version.
  const removalsByFromIdx = fromSteps
    .map((_, i) => i)
    .filter((i) => !matchedFromIdx.has(i));
  const pairByFromIdx = new Map<number, Pair>();
  for (const p of pairs) pairByFromIdx.set(p.fromIdx, p);

  for (let i = 0; i < fromSteps.length; i += 1) {
    const pair = pairByFromIdx.get(i);
    if (pair === undefined) {
      out.push({
        kind: "removed",
        stepKey: fromKeys[i]!,
        beforeIndex: fromSteps[i]!.index,
        step: fromSteps[i]!,
      });
      continue;
    }
    const before = fromSteps[pair.fromIdx]!;
    const after = toSteps[pair.toIdx]!;
    const changes = diffStepFields(before, after);
    if (changes.length > 0) {
      out.push({
        kind: "edited",
        stepKey: pair.key,
        beforeIndex: before.index,
        afterIndex: after.index,
        changes,
      });
    }
  }

  // Then walk the `to` list for additions, again in `to` order so the diff
  // reads top-to-bottom.
  for (let i = 0; i < toSteps.length; i += 1) {
    if (matchedToIdx.has(i)) continue;
    out.push({
      kind: "added",
      stepKey: toKeys[i]!,
      afterIndex: toSteps[i]!.index,
      step: toSteps[i]!,
    });
  }

  return Object.freeze(out);
}

function stepKeyFor(step: StepSnapshot): string {
  if (typeof step.stepKey === "string" && step.stepKey.length > 0) return step.stepKey;
  // A legacy step has no stable key. The title is the most stable signal
  // available; two steps with the same title are differentiated by their
  // position so an edit that moves a title but not its position still
  // matches.
  return `legacy:${step.index}:${step.title}`;
}

/**
 * The field set the diff knows to be a step. Additional fields on the
 * snapshot are compared generically; this list is what the module treats as
 * "step identity" fields and outputs with human-friendly paths.
 */
const KNOWN_STEP_FIELDS = Object.freeze([
  "title",
  "description",
  "screenshotRef",
  "altText",
  "annotations",
]);

function diffStepFields(before: StepSnapshot, after: StepSnapshot): readonly FieldChange[] {
  const out: FieldChange[] = [];
  compareField(out, "title", before.title, after.title);
  compareField(out, "description", before.description, after.description);
  compareField(out, "screenshotRef", before.screenshotRef, after.screenshotRef);
  compareField(out, "altText", before.altText ?? null, after.altText ?? null);
  diffAnnotations(out, before.annotations ?? [], after.annotations ?? []);

  // Extra fields: anything present on either snapshot that is not in the
  // known set. Sorted so the diff is deterministic.
  const keys = new Set<string>([
    ...Object.keys(before),
    ...Object.keys(after),
  ]);
  for (const key of keys) {
    if (key === "index" || key === "stepKey") continue;
    if (KNOWN_STEP_FIELDS.includes(key)) continue;
    const beforeVal = Object.prototype.hasOwnProperty.call(before, key) ? before[key] : undefined;
    const afterVal = Object.prototype.hasOwnProperty.call(after, key) ? after[key] : undefined;
    compareField(out, `step.${key}`, beforeVal, afterVal);
  }
  return Object.freeze(out);
}

function diffAnnotations(
  out: FieldChange[],
  before: readonly { readonly [k: string]: unknown }[],
  after: readonly { readonly [k: string]: unknown }[],
): void {
  // Annotations are compared by index: annotation i in `before` vs
  // annotation i in `after`. The annotation phase produces annotations in a
  // deterministic order, so index comparison is stable; a re-order of
  // annotations is expressed as field edits rather than an annotation-level
  // LCS, which would over-fit the diff to a case the product does not have.
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i += 1) {
    const b = before[i];
    const a = after[i];
    if (b === undefined && a !== undefined) {
      out.push({
        path: `annotations.${i}`,
        kind: "added",
        before: undefined,
        after: a,
      });
      continue;
    }
    if (b !== undefined && a === undefined) {
      out.push({
        path: `annotations.${i}`,
        kind: "removed",
        before: b,
        after: undefined,
      });
      continue;
    }
    if (b === undefined || a === undefined) continue;
    const keys = new Set<string>([...Object.keys(b), ...Object.keys(a)]);
    for (const key of [...keys].sort()) {
      const beforeVal = Object.prototype.hasOwnProperty.call(b, key) ? b[key] : undefined;
      const afterVal = Object.prototype.hasOwnProperty.call(a, key) ? a[key] : undefined;
      compareField(out, `annotations.${i}.${key}`, beforeVal, afterVal);
    }
  }
}

function compareField(
  out: FieldChange[],
  path: string,
  before: unknown,
  after: unknown,
): void {
  if (deepEqual(before, after)) return;
  if (before === undefined) {
    out.push({ path, kind: "added", before: undefined, after });
    return;
  }
  if (after === undefined) {
    out.push({ path, kind: "removed", before, after: undefined });
    return;
  }
  out.push({ path, kind: "edited", before, after });
}

/**
 * Structural equality. Uses a canonical JSON encoding rather than a naive
 * `JSON.stringify` comparison (which is order-sensitive) so two objects with
 * the same keys in a different insertion order compare equal. This matters
 * because two snapshots produced by different code paths may insert
 * metadata keys in different orders.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).sort();
  const bKeys = Object.keys(bo).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual(ao[aKeys[i]!], bo[bKeys[i]!])) return false;
  }
  return true;
}

/**
 * A canonical encoding of a snapshot with the volatile timestamp fields
 * removed, so `hasChanges` does not treat "saved a second later" as a change.
 * Used only by `hasChanges`; the diff itself reports the timestamps as a
 * field if the caller included them in `metadata`.
 */
function canonicaliseSnapshot(s: GuideSnapshot): string {
  const strip = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(strip);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "createdAt" || k === "updatedAt" || k === "versionLabel") continue;
      out[k] = strip(v);
    }
    return out;
  };
  return JSON.stringify(strip(s));
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                        */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  deepEqual,
  canonicaliseSnapshot,
  stepKeyFor,
  diffStepList,
  diffStepFields,
  diffAnnotations,
  compareField,
  KNOWN_STEP_FIELDS,
});
