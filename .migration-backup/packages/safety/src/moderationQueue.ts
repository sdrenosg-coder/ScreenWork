/**
 * Zipy AI — moderation queue (SEO/quality/safety phase, batch 3).
 *
 * The layer between the safety classifiers (`@zipy/safety/harmful`,
 * `@zipy/safety/piiText`) and a human reviewer. It:
 *
 *   1. accepts the findings each classifier produced against a guide;
 *   2. decides, per finding, whether the guide can be published without a
 *      reviewer, whether it must be held pending a reviewer, or whether it
 *      must be withdrawn from publication;
 *   3. records every decision with a stable, deduplicated entry the review
 *      UI and the audit trail consume.
 *
 * Design rules honoured:
 *  - No silent drops. Every finding the caller supplies produces exactly one
 *    queue entry. A finding whose category is suppressed for the deployment,
 *    a finding that a human already reviewed, a finding in an ingested source
 *    rather than generated prose — all still produce an entry, marked with the
 *    reason the entry does not gate publication.
 *  - No automatic withdrawal. The module never *performs* a withdrawal; it
 *    emits an entry whose `routing` is `withdraw`. The actual publication
 *    state change is performed by the publishing phase, which has the
 *    workspace's SLO context this module does not.
 *  - Deterministic given inputs. Sorting and dedup are stable.
 *  - The queue does *not* itself persist. The caller (route/job) writes the
 *    returned entries where it stores query state; this module returns them.
 *    This keeps the module testable without a database and prevents it from
 *    becoming an implicit dependency of the web app.
 *  - No invented reviewer identity. A `ModerationDecision` supplied by the
 *    caller records an actor the caller authenticated; this module never
 *    fabricates an approver.
 *
 * The module exports:
 *   - `buildModerationQueue` — the primary entry point.
 *   - `applyDecision` — record a reviewer's decision against an entry.
 *   - `summariseQueue` — counters for the review dashboard.
 *   - `buildModerationDirectives` — the LLM-visible block, when a reviewer
 *     wants the writer to know its output is under human moderation.
 *   - `rehydrateModerationQueue` — typed load of a persisted payload.
 *   - `__internals` — routing helpers, exported for tests.
 */

import type { AudienceProfile } from "@zipy/content/personalization/audience";
import type { IndustryProfile } from "@zipy/content/personalization/industry";
import type {
  HarmfulContentReport,
  HarmfulCategory,
  HarmfulSeverity,
} from "@zipy/safety/harmful";
import type { PiiTextReport, PiiTextCategory } from "@zipy/safety/piiText";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ModerationQueueErrorCode = "invalid-input" | "shape" | "state";

export class ModerationQueueError extends Error {
  readonly code: ModerationQueueErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ModerationQueueErrorCode,
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
 * What the routing layer decided the entry requires. `withdraw` indicates the
 * publishing layer must not make the guide publicly visible; the module is
 * advisory, the publishing layer obeys.
 */
export const MODERATION_ROUTINGS = [
  "auto-pass",
  "human-review",
  "human-review-urgent",
  "withdraw",
  "informational",
] as const;
export type ModerationRouting = (typeof MODERATION_ROUTINGS)[number];

/**
 * The reason a routing decision was taken. Kept open-ended as a string so the
 * routing layer can name new heuristics without a schema change; the review
 * UI groups by the common prefixes.
 */
export type ModerationReason =
  | "critical-harmful-category"
  | "high-harmful-category"
  | "moderate-advisory-overreach"
  | "pii-detected"
  | "pii-in-source"
  | "context-softened"
  | "category-suppressed-by-deployment"
  | "below-threshold"
  | "empty-finding";

export interface ModerationQueueInput {
  readonly guideId: string;
  readonly workspaceId: string;
  readonly harmful: HarmfulContentReport | null;
  readonly pii: PiiTextReport | null;
  readonly audience: AudienceProfile;
  readonly industry: IndustryProfile;
  /**
   * Categories the deployment has declared as suppressed. A suppressed
   * category still produces an entry (informational) but does not gate.
   * This mirrors the field on `classifyHarmfulContent`.
   */
  readonly suppressedHarmfulCategories?: readonly HarmfulCategory[];
  /**
   * Categories the deployment has declared as suppressed for PII. Used the
   * same way.
   */
  readonly suppressedPiiCategories?: readonly PiiTextCategory[];
  /**
   * True when the guide is in a review-required configuration. When false,
   * the queue is still built and every entry is `informational`, because the
   * audit trail must still record that the safety layers ran.
   */
  readonly reviewModeEnabled: boolean;
}

/**
 * A decision recorded against a queue entry. Reviewer identity and time are
 * always supplied by the caller; the module never invents them.
 */
export interface ModerationDecision {
  readonly entryId: string;
  readonly decision: "approved" | "edited" | "rejected" | "deferred";
  /** Reviewer identity, from the workspace's authenticated session. */
  readonly reviewerId: string;
  /** ISO 8601 timestamp the caller recorded the decision. */
  readonly decidedAt: string;
  /** Free-form note the reviewer wrote alongside the decision. */
  readonly note: string | null;
  /**
   * The edited text, when the decision is `edited`. `null` otherwise.
   */
  readonly editedText: string | null;
}

export interface ModerationEntry {
  /** Stable, deduped id derived from the finding's identifying tuple. */
  readonly entryId: string;
  readonly guideId: string;
  readonly workspaceId: string;
  /**
   * Which layer produced the finding. `harmful` and `pii` are the two
   * classifier outputs; a future layer (e.g. an LLM-based recheck) adds a new
   * value.
   */
  readonly source: "harmful" | "pii";
  /** The fragment identifier the finding applies to. */
  readonly fragmentId: string;
  /** Human-visible location, e.g. "Step 3 — description". */
  readonly location: string;
  /** Category value from the originating layer's taxonomy. */
  readonly category: HarmfulCategory | PiiTextCategory;
  /** Severity, when the originating layer produced one. */
  readonly severity: HarmfulSeverity | null;
  /** The exact matched substring, verbatim. */
  readonly matchedText: string;
  /** Human-readable reason. */
  readonly reason: string;
  /** The routing decision. */
  readonly routing: ModerationRouting;
  readonly reasonKind: ModerationReason;
  /** True when a reviewer decision has already been recorded. */
  readonly decided: boolean;
  readonly decision: ModerationDecision | null;
}

export interface ModerationQueueNote {
  readonly kind:
    | "review-mode-disabled"
    | "no-inputs"
    | "no-findings"
    | "suppressed-category"
    | "source-origin-finding"
    | "context-softened"
    | "awaiting-reviewer";
  readonly detail: string;
}

export interface ModerationQueue {
  readonly version: "moderation-queue/1";
  readonly guideId: string;
  readonly workspaceId: string;
  readonly entries: readonly ModerationEntry[];
  readonly notes: readonly ModerationQueueNote[];
  readonly summary: {
    readonly total: number;
    readonly autoPass: number;
    readonly humanReview: number;
    readonly humanReviewUrgent: number;
    readonly withdraw: number;
    readonly informational: number;
    readonly decided: number;
    readonly pending: number;
  };
  /**
   * True when at least one entry's routing is `withdraw`. The publishing
   * layer must refuse to publicly expose the guide while this is true and no
   * reviewer has overridden it.
   */
  readonly blocksPublication: boolean;
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildModerationQueue(input: ModerationQueueInput): ModerationQueue {
  if (input === null || typeof input !== "object") {
    throw new ModerationQueueError(
      "buildModerationQueue requires an input object.",
      "invalid-input",
    );
  }
  if (typeof input.guideId !== "string" || input.guideId.length === 0) {
    throw new ModerationQueueError("`guideId` is required.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new ModerationQueueError("`workspaceId` is required.", "invalid-input");
  }
  const notes: ModerationQueueNote[] = [];

  const suppressedHarmful = new Set<HarmfulCategory>(
    Array.isArray(input.suppressedHarmfulCategories)
      ? input.suppressedHarmfulCategories.filter((c): c is HarmfulCategory =>
          typeof c === "string",
        )
      : [],
  );
  const suppressedPii = new Set<PiiTextCategory>(
    Array.isArray(input.suppressedPiiCategories)
      ? input.suppressedPiiCategories.filter((c): c is PiiTextCategory =>
          typeof c === "string",
        )
      : [],
  );

  const reviewMode = input.reviewModeEnabled === true;
  if (!reviewMode) {
    notes.push({
      kind: "review-mode-disabled",
      detail:
        "Review mode is disabled. Every entry is recorded as informational; the queue does not gate publication.",
    });
  }

  const entries: ModerationEntry[] = [];
  const seen = new Set<string>();

  /* ---------- Harmful classifier findings ------------------------------ */
  if (input.harmful !== null && input.harmful !== undefined) {
    for (const fragment of input.harmful.fragments) {
      for (const finding of fragment.findings) {
        const tuple = `${"harmful"}|${fragment.fragmentId}|${finding.category}|${finding.matchStart}|${finding.matchEnd}`;
        if (seen.has(tuple)) continue;
        seen.add(tuple);
        const suppressed = suppressedHarmful.has(finding.category);
        if (suppressed) {
          notes.push({
            kind: "suppressed-category",
            detail: `Harmful category "${finding.category}" on fragment "${fragment.fragmentId}" is suppressed for this deployment.`,
          });
        }
        if (finding.contextSoftened) {
          notes.push({
            kind: "context-softened",
            detail: `Harmful finding on fragment "${fragment.fragmentId}" was softened by the caller's context.`,
          });
        }
        const routing = routeHarmful(finding.severity, suppressed, reviewMode);
        entries.push({
          entryId: stableEntryId(tuple),
          guideId: input.guideId,
          workspaceId: input.workspaceId,
          source: "harmful",
          fragmentId: fragment.fragmentId,
          location: finding.location,
          category: finding.category,
          severity: finding.severity,
          matchedText: finding.matchedText,
          reason: finding.reason,
          routing: routing.routing,
          reasonKind: routing.reason,
          decided: false,
          decision: null,
        });
      }
    }
  }

  /* ---------- PII classifier findings ---------------------------------- */
  if (input.pii !== null && input.pii !== undefined) {
    // The PII report shape is owned by piiText.ts. Read its fragments and
    // findings with an eye to the common shape: fragmentId, location, and a
    // findings array whose entries carry a category, matchedText and offset.
    const piiFragments = readPiiFragments(input.pii);
    for (const fragment of piiFragments) {
      for (const finding of fragment.findings) {
        const tuple = `${"pii"}|${fragment.fragmentId}|${finding.category}|${finding.matchStart}|${finding.matchEnd}`;
        if (seen.has(tuple)) continue;
        seen.add(tuple);
        const suppressed = suppressedPii.has(finding.category);
        if (suppressed) {
          notes.push({
            kind: "suppressed-category",
            detail: `PII category "${finding.category}" on fragment "${fragment.fragmentId}" is suppressed for this deployment.`,
          });
        }
        if (fragment.origin === "source") {
          notes.push({
            kind: "source-origin-finding",
            detail: `PII finding on fragment "${fragment.fragmentId}" came from source material; it is routed to review rather than gating on its own.`,
          });
        }
        const routing = routePii(suppressed, reviewMode, fragment.origin === "source");
        entries.push({
          entryId: stableEntryId(tuple),
          guideId: input.guideId,
          workspaceId: input.workspaceId,
          source: "pii",
          fragmentId: fragment.fragmentId,
          location: fragment.location,
          category: finding.category,
          severity: null,
          matchedText: finding.matchedText,
          reason: finding.reason,
          routing: routing.routing,
          reasonKind: routing.reason,
          decided: false,
          decision: null,
        });
      }
    }
  }

  if (
    (input.harmful === null || input.harmful === undefined) &&
    (input.pii === null || input.pii === undefined)
  ) {
    notes.push({
      kind: "no-inputs",
      detail:
        "Neither the harmful-content report nor the PII report were supplied. The queue is empty; the safety layers did not run.",
    });
  } else if (entries.length === 0) {
    notes.push({
      kind: "no-findings",
      detail: "The safety layers ran and produced no findings.",
    });
  }

  // Deduplicate by entryId (stable ids already dedupe by tuple; the second
  // pass is defensive against a future layer emitting the same tuple).
  const deduped: ModerationEntry[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.entryId)) continue;
    ids.add(e.entryId);
    deduped.push(e);
  }

  // Deterministic ordering: withdraw first, then human-review-urgent, then
  // human-review, then auto-pass, then informational. Ties fall back to the
  // entry id so a rerun of an unchanged input is stable.
  const rank: Record<ModerationRouting, number> = {
    withdraw: 0,
    "human-review-urgent": 1,
    "human-review": 2,
    "auto-pass": 3,
    informational: 4,
  };
  deduped.sort((a, b) => {
    const ra = rank[a.routing];
    const rb = rank[b.routing];
    if (ra !== rb) return ra - rb;
    if (a.entryId < b.entryId) return -1;
    if (a.entryId > b.entryId) return 1;
    return 0;
  });

  const summary = {
    total: deduped.length,
    autoPass: deduped.filter((e) => e.routing === "auto-pass").length,
    humanReview: deduped.filter((e) => e.routing === "human-review").length,
    humanReviewUrgent: deduped.filter((e) => e.routing === "human-review-urgent").length,
    withdraw: deduped.filter((e) => e.routing === "withdraw").length,
    informational: deduped.filter((e) => e.routing === "informational").length,
    decided: deduped.filter((e) => e.decided).length,
    pending: deduped.filter((e) => !e.decided && e.routing !== "auto-pass" && e.routing !== "informational").length,
  };

  const blocksPublication =
    reviewMode &&
    deduped.some((e) => e.routing === "withdraw" && !e.decided);

  if (summary.pending > 0) {
    notes.push({
      kind: "awaiting-reviewer",
      detail: `${summary.pending} entr${summary.pending === 1 ? "y" : "ies"} require a reviewer decision before publication.`,
    });
  }

  return {
    version: "moderation-queue/1",
    guideId: input.guideId,
    workspaceId: input.workspaceId,
    entries: deduped,
    notes,
    summary,
    blocksPublication,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Record a reviewer's decision against a queue entry. Returns a new queue
 * whose summary reflects the decision. The initial queue is not mutated.
 *
 * The decision is applied to an entry whose id matches; a decision naming an
 * entry the queue does not contain is a programming error (`state`) and
 * throws rather than silently no-op'ing.
 */
export function applyDecision(
  queue: ModerationQueue,
  decision: ModerationDecision,
): ModerationQueue {
  if (queue === null || typeof queue !== "object" || queue.version !== "moderation-queue/1") {
    throw new ModerationQueueError(
      'applyDecision requires a ModerationQueue (version "moderation-queue/1").',
      "invalid-input",
    );
  }
  if (decision === null || typeof decision !== "object") {
    throw new ModerationQueueError("`decision` is required.", "invalid-input");
  }
  if (
    decision.decision !== "approved" &&
    decision.decision !== "edited" &&
    decision.decision !== "rejected" &&
    decision.decision !== "deferred"
  ) {
    throw new ModerationQueueError(
      `Unknown decision "${String(decision.decision)}".`,
      "invalid-input",
    );
  }
  if (typeof decision.entryId !== "string" || decision.entryId.length === 0) {
    throw new ModerationQueueError("`decision.entryId` is required.", "invalid-input");
  }
  if (typeof decision.reviewerId !== "string" || decision.reviewerId.length === 0) {
    throw new ModerationQueueError(
      "`decision.reviewerId` is required and must not be empty.",
      "invalid-input",
    );
  }
  if (typeof decision.decidedAt !== "string" || decision.decidedAt.length === 0) {
    throw new ModerationQueueError(
      "`decision.decidedAt` is required (the caller records the timestamp).",
      "invalid-input",
    );
  }
  if (decision.decision === "edited" && (decision.editedText === null || decision.editedText.trim().length === 0)) {
    throw new ModerationQueueError(
      'An "edited" decision must supply the edited text.',
      "invalid-input",
    );
  }

  const index = queue.entries.findIndex((e) => e.entryId === decision.entryId);
  if (index < 0) {
    throw new ModerationQueueError(
      `The queue does not contain an entry with id "${decision.entryId}".`,
      "state",
      { entryId: decision.entryId },
    );
  }

  const updated = queue.entries.map((e, i) => {
    if (i !== index) return e;
    // An approved or edited entry no longer blocks publication; a rejected
    // entry retains its routing (the publishing layer may still need to
    // decide what to do with a rejected critical finding).
    const decidedEntry: ModerationEntry = {
      ...e,
      decided: true,
      decision: {
        entryId: decision.entryId,
        decision: decision.decision,
        reviewerId: decision.reviewerId,
        decidedAt: decision.decidedAt,
        note: decision.note,
        editedText: decision.editedText,
      },
    };
    return decidedEntry;
  });

  const summary = {
    total: updated.length,
    autoPass: updated.filter((e) => e.routing === "auto-pass").length,
    humanReview: updated.filter((e) => e.routing === "human-review").length,
    humanReviewUrgent: updated.filter((e) => e.routing === "human-review-urgent").length,
    withdraw: updated.filter((e) => e.routing === "withdraw").length,
    informational: updated.filter((e) => e.routing === "informational").length,
    decided: updated.filter((e) => e.decided).length,
    pending: updated.filter(
      (e) => !e.decided && e.routing !== "auto-pass" && e.routing !== "informational",
    ).length,
  };

  const blocksPublication = updated.some((e) => e.routing === "withdraw" && !e.decided);

  return {
    ...queue,
    entries: updated,
    summary,
    blocksPublication,
  };
}

/**
 * Counters for the review dashboard. Returned as a plain object so the
 * dashboard can render it without depending on the queue shape.
 */
export function summariseQueue(queue: ModerationQueue): ModerationQueue["summary"] {
  if (queue === null || typeof queue !== "object" || queue.version !== "moderation-queue/1") {
    throw new ModerationQueueError(
      'summariseQueue requires a ModerationQueue (version "moderation-queue/1").',
      "invalid-input",
    );
  }
  return queue.summary;
}

/**
 * The LLM-visible directive block. Append when the platform wants the writer
 * to know its output is under human moderation. The writer must not attempt
 * to pre-empt the reviewer.
 */
export function buildModerationDirectives(input: {
  readonly audience: AudienceProfile;
  readonly industry: IndustryProfile;
  readonly reviewModeEnabled: boolean;
}): string {
  const lines: string[] = [];
  if (input.reviewModeEnabled) {
    lines.push(
      "Your output will be reviewed by a human before publication. Do not write content that depends on being published unmodified.",
    );
    lines.push(
      "- If a step's correctness depends on information you are not confident about, mark it for the reviewer rather than smoothing it over.",
    );
    lines.push(
      "- Do not invent a citation, a version number, a support contact or a policy that a reviewer would have to remove.",
    );
  } else {
    lines.push(
      "Review mode is disabled for this deployment. Your output may be published without a human pass — be conservative.",
    );
    lines.push(
      "- Prefer omitting a claim over asserting one the sources do not support.",
    );
  }
  if (input.audience.seniority === "novice") {
    lines.push(
      "- A novice reader may act on the guide without confirmation. State the effect of an action before the reader performs it.",
    );
  }
  return lines.join("\n");
}

export function rehydrateModerationQueue(value: unknown): ModerationQueue {
  if (value === null || typeof value !== "object") {
    throw new ModerationQueueError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "moderation-queue/1") {
    throw new ModerationQueueError(
      `Rehydrate failed: expected version "moderation-queue/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  return {
    version: "moderation-queue/1",
    guideId: typeof r["guideId"] === "string" ? r["guideId"] : "",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    entries: readEntries(r["entries"]),
    notes: readNotes(r["notes"]),
    summary: readSummary(r["summary"]),
    blocksPublication: r["blocksPublication"] === true,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface RoutedHarmful {
  readonly routing: ModerationRouting;
  readonly reason: ModerationReason;
}

function routeHarmful(
  severity: HarmfulSeverity,
  suppressed: boolean,
  reviewMode: boolean,
): RoutedHarmful {
  if (suppressed) {
    return { routing: "informational", reason: "category-suppressed-by-deployment" };
  }
  if (!reviewMode) {
    return { routing: "informational", reason: "below-threshold" };
  }
  if (severity === "critical") {
    return { routing: "withdraw", reason: "critical-harmful-category" };
  }
  if (severity === "high") {
    return { routing: "human-review-urgent", reason: "high-harmful-category" };
  }
  return { routing: "human-review", reason: "moderate-advisory-overreach" };
}

interface RoutedPii {
  readonly routing: ModerationRouting;
  readonly reason: ModerationReason;
}

function routePii(
  suppressed: boolean,
  reviewMode: boolean,
  sourceOrigin: boolean,
): RoutedPii {
  if (suppressed) {
    return { routing: "informational", reason: "category-suppressed-by-deployment" };
  }
  if (!reviewMode) {
    return { routing: "informational", reason: "below-threshold" };
  }
  // A finding in generated prose gates more strongly than a finding in the
  // source (a source fragment may be legitimately retained by the operator).
  if (sourceOrigin) {
    return { routing: "human-review", reason: "pii-in-source" };
  }
  return { routing: "human-review-urgent", reason: "pii-detected" };
}

/**
 * Derive a stable id from the finding's identifying tuple. SHA-256 is not
 * necessary and would make the id opaque to a human reading a log; a
 * readable prefix plus the FNV-1a of the tuple is enough to keep the id
 * deterministic and short. The id is prefixed with a fixed tag so it cannot
 * collide with an id from another subsystem.
 */
function stableEntryId(tuple: string): string {
  const h = fnv1a32(tuple);
  const hex = h.toString(16).padStart(8, "0");
  return `mod_${hex}_${hashishSuffix(tuple)}`;
}

function hashishSuffix(s: string): string {
  // Short, human-recognisable suffix so a log reader can eyeball two entries
  // from the same tuple across a rerun.
  const cleaned = s.replace(/[^A-Za-z0-9]+/gu, "").slice(0, 8).toLowerCase();
  return cleaned.length > 0 ? cleaned : "entry";
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // Multiply by the FNV prime (16777619) using bit-safe arithmetic.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * A shape-tolerant reader for the PII report. The PII module owns its exact
 * shape; this reader accepts the fragments/findings structure it is expected
 * to publish and produces a local view without inventing extra fields. A
 * future shape change is caught at the type level by rehydrate, not by a
 * runtime guess.
 */
interface PiiFragmentView {
  readonly fragmentId: string;
  readonly location: string;
  readonly origin: "generated" | "source" | "unknown";
  readonly findings: readonly {
    readonly category: PiiTextCategory;
    readonly matchedText: string;
    readonly matchStart: number;
    readonly matchEnd: number;
    readonly reason: string;
  }[];
}

function readPiiFragments(report: PiiTextReport): readonly PiiFragmentView[] {
  const obj = report as unknown as Record<string, unknown>;
  const fragmentsRaw = obj["fragments"];
  if (!Array.isArray(fragmentsRaw)) return [];
  const out: PiiFragmentView[] = [];
  for (const item of fragmentsRaw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o["fragmentId"] === "string" ? o["fragmentId"] : "";
    const location = typeof o["location"] === "string" ? o["location"] : "";
    const originRaw = o["origin"];
    const origin: PiiFragmentView["origin"] =
      originRaw === "generated" || originRaw === "source" ? originRaw : "unknown";
    const findingsRaw = Array.isArray(o["findings"]) ? o["findings"] : [];
    const findings: PiiFragmentView["findings"][number][] = [];
    for (const f of findingsRaw) {
      if (f === null || typeof f !== "object") continue;
      const fo = f as Record<string, unknown>;
      const categoryRaw = fo["category"];
      if (typeof categoryRaw !== "string") continue;
      findings.push({
        category: categoryRaw as PiiTextCategory,
        matchedText: typeof fo["matchedText"] === "string" ? fo["matchedText"] : "",
        matchStart:
          typeof fo["matchStart"] === "number" && Number.isFinite(fo["matchStart"])
            ? Math.max(0, Math.floor(fo["matchStart"]))
            : 0,
        matchEnd:
          typeof fo["matchEnd"] === "number" && Number.isFinite(fo["matchEnd"])
            ? Math.max(0, Math.floor(fo["matchEnd"]))
            : 0,
        reason: typeof fo["reason"] === "string" ? fo["reason"] : "",
      });
    }
    out.push({ fragmentId: id, location, origin, findings });
  }
  return out;
}

function readDecision(v: unknown): ModerationDecision | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const decisionRaw = o["decision"];
  const decision =
    decisionRaw === "approved" ||
    decisionRaw === "edited" ||
    decisionRaw === "rejected" ||
    decisionRaw === "deferred"
      ? decisionRaw
      : null;
  if (decision === null) return null;
  return {
    entryId: typeof o["entryId"] === "string" ? o["entryId"] : "",
    decision,
    reviewerId: typeof o["reviewerId"] === "string" ? o["reviewerId"] : "",
    decidedAt: typeof o["decidedAt"] === "string" ? o["decidedAt"] : "",
    note: typeof o["note"] === "string" ? o["note"] : null,
    editedText: typeof o["editedText"] === "string" ? o["editedText"] : null,
  };
}

function readRouting(v: unknown): ModerationRouting {
  return v === "auto-pass" ||
    v === "human-review" ||
    v === "human-review-urgent" ||
    v === "withdraw" ||
    v === "informational"
    ? v
    : "informational";
}

function readReasonKind(v: unknown): ModerationReason {
  return v === "critical-harmful-category" ||
    v === "high-harmful-category" ||
    v === "moderate-advisory-overreach" ||
    v === "pii-detected" ||
    v === "pii-in-source" ||
    v === "context-softened" ||
    v === "category-suppressed-by-deployment" ||
    v === "below-threshold" ||
    v === "empty-finding"
    ? v
    : "below-threshold";
}

function readEntries(v: unknown): readonly ModerationEntry[] {
  if (!Array.isArray(v)) return [];
  const out: ModerationEntry[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const sourceRaw = o["source"];
    const source: ModerationEntry["source"] = sourceRaw === "harmful" || sourceRaw === "pii" ? sourceRaw : "harmful";
    const severityRaw = o["severity"];
    const severity: HarmfulSeverity | null =
      severityRaw === "critical" || severityRaw === "high" || severityRaw === "moderate"
        ? severityRaw
        : null;
    // Category is opaque (union of two taxonomies); carry it as a string
    // value typed to the union the interface declares.
    const category = (typeof o["category"] === "string"
      ? o["category"]
      : "general-informational") as HarmfulCategory | PiiTextCategory;
    out.push({
      entryId: typeof o["entryId"] === "string" ? o["entryId"] : "",
      guideId: typeof o["guideId"] === "string" ? o["guideId"] : "",
      workspaceId: typeof o["workspaceId"] === "string" ? o["workspaceId"] : "",
      source,
      fragmentId: typeof o["fragmentId"] === "string" ? o["fragmentId"] : "",
      location: typeof o["location"] === "string" ? o["location"] : "",
      category,
      severity,
      matchedText: typeof o["matchedText"] === "string" ? o["matchedText"] : "",
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
      routing: readRouting(o["routing"]),
      reasonKind: readReasonKind(o["reasonKind"]),
      decided: o["decided"] === true,
      decision: readDecision(o["decision"]),
    });
  }
  return out;
}

function readNotes(v: unknown): readonly ModerationQueueNote[] {
  if (!Array.isArray(v)) return [];
  const out: ModerationQueueNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "review-mode-disabled" &&
      kind !== "no-inputs" &&
      kind !== "no-findings" &&
      kind !== "suppressed-category" &&
      kind !== "source-origin-finding" &&
      kind !== "context-softened" &&
      kind !== "awaiting-reviewer"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

function readSummary(v: unknown): ModerationQueue["summary"] {
  const fallback: ModerationQueue["summary"] = {
    total: 0,
    autoPass: 0,
    humanReview: 0,
    humanReviewUrgent: 0,
    withdraw: 0,
    informational: 0,
    decided: 0,
    pending: 0,
  };
  if (v === null || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  const read = (k: string): number => {
    const val = o[k];
    return typeof val === "number" && Number.isFinite(val) ? Math.max(0, Math.floor(val)) : 0;
  };
  return {
    total: read("total"),
    autoPass: read("autoPass"),
    humanReview: read("humanReview"),
    humanReviewUrgent: read("humanReviewUrgent"),
    withdraw: read("withdraw"),
    informational: read("informational"),
    decided: read("decided"),
    pending: read("pending"),
  };
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  routeHarmful,
  routePii,
  stableEntryId,
  fnv1a32,
  readPiiFragments,
  readEntries,
  readNotes,
  readSummary,
  readRouting,
  readReasonKind,
});
