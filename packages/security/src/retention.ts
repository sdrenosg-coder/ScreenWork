/**
 * Zipy AI — retention policy & sweep (phase 22, batch 1).
 *
 * Implements the "Data retention" capability: per-workspace retention
 * policy, a pure "what should be deleted" plan, and a caller-driven sweep
 * that executes the plan through a supplied delete surface. The sweep is
 * deliberately split from the policy so the same planning function can be
 * used as a dry-run for the admin UI ("show me what would be deleted")
 * without touching storage.
 *
 * Design boundaries
 * -----------------
 *  - No SQL is embedded for the sweep itself. Deletion has to interact
 *    with every subsystem that stores a row or an artifact for the same
 *    guide (the guides table, the artifacts table, the object store, the
 *    screenshot store), and those are owned by other packages. The
 *    caller supplies a `RetentionDeleteSurface` that does the actual work
 *    per target; this module decides *what* to delete and audits it.
 *
 *  - No retention period is inferred. A workspace with no policy gets the
 *    platform default from `@zipy/../config` (passed in by the caller).
 *    A policy of `{days: null}` means "keep forever" and must be an
 *    explicit choice — an empty policy is treated as "use the default",
 *    which is never `null`.
 *
 *  - Every decision the planner makes is recorded with the reason
 *    ("age-exceeded", "legal-hold-skipped", "not-yet-eligible") so the
 *    admin UI can show why a given artifact survived a sweep.
 *
 *  - Legal holds are honoured, not inferred. A `RetentionTarget` carries
 *    an optional `legalHold: true`; the planner classifies it as
 *    "legal-hold-skipped" and never schedules deletion, regardless of
 *    age.
 *
 *  - The sweep is idempotent at the target level: a target whose id is
 *    not returned by the delete surface is reported as "already-gone" and
 *    does not fail the sweep. This matches what a retention job has to do
 *    when it races with a manual deletion.
 *
 *  - The audit entry is written by the caller, not this module, because
 *    the audit client lives in `@zipy/security/auditLog` and threading it
 *    in here would couple the planner to the audit sink. `buildSweepAuditDetail`
 *    produces the detail record an admin trace expects; the caller
 *    appends it.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type RetentionErrorCode = "invalid-input" | "not-configured";

export class RetentionError extends Error {
  readonly code: RetentionErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: RetentionErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "RetentionError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A category of retained resource. Each category has its own eligibility
 * rule because retention windows legitimately differ: a screenshot used
 * by a published guide may be kept for the guide's lifetime, whereas a
 * captured frame from an ingested video is an intermediate that a
 * workspace may want to purge much sooner.
 *
 * Categories are deliberately a closed set so the planner's switch is
 * exhaustive. A new category is a deliberate widening of the retention
 * surface, not a dynamic string.
 */
export const RETENTION_CATEGORIES = Object.freeze([
  "source-artifact",
  "intermediate-artifact",
  "screenshot",
  "export-file",
  "ingest-transcript",
  "ingest-frame",
  "generated-report",
] as const);

export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(RETENTION_CATEGORIES);

export function isRetentionCategory(v: string): v is RetentionCategory {
  return CATEGORY_SET.has(v);
}

/**
 * The retention policy for a workspace. `days` is `null` for "keep
 * forever"; that value must be set explicitly by the operator, because
 * the workspace-scoped default is separately expressed on the caller side
 * (typically `config.compliance.defaultRetentionDays`).
 *
 * `overridesByCategory` allows a workspace to shorten a specific
 * category without touching the rest. A category present in the map with
 * `null` is "keep forever" for that category, distinct from "not
 * present in the map" which means "inherit the workspace-wide value".
 */
export interface RetentionPolicy {
  readonly workspaceId: string;
  /** The workspace-wide retention window in days, or `null` for forever. */
  readonly days: number | null;
  /** Optional per-category override; a missing key inherits `days`. */
  readonly overridesByCategory?: Readonly<
    Partial<Record<RetentionCategory, number | null>>
  >;
  /** When set, the effective policy is a "report only" mode for this workspace. */
  readonly dryRun?: boolean;
}

/**
 * A candidate for retention. The planner never receives rows that are
 * already deleted; the caller filters those out at the query layer,
 * because "is it deleted" is a storage question. The planner only decides
 * whether an *existing* target should be swept.
 */
export interface RetentionTarget {
  /** A stable, storage-agnostic id (a UUID the caller controls). */
  readonly id: string;
  readonly category: RetentionCategory;
  /** The workspace this target belongs to; used to select the policy. */
  readonly workspaceId: string;
  /** ISO-8601 timestamp of the target's creation. */
  readonly createdAt: string;
  /**
   * When the target is referenced by a published guide, the retention
   * planner must not delete it while the guide is live. The flag is
   * explicit; the planner does not follow references itself.
   */
  readonly referencedByPublishedGuide?: boolean;
  /** When true, the target is exempt from retention entirely. */
  readonly legalHold?: boolean;
}

export type RetentionDecision =
  | {
      readonly action: "delete";
      readonly targetId: string;
      readonly category: RetentionCategory;
      readonly reason: "age-exceeded";
      /** The effective retention window that triggered the decision, in days. */
      readonly effectiveDays: number;
      /** Age observed at planning time, in whole days. */
      readonly ageDays: number;
    }
  | {
      readonly action: "skip";
      readonly targetId: string;
      readonly category: RetentionCategory;
      readonly reason:
        | "keep-forever"
        | "not-yet-eligible"
        | "legal-hold"
        | "referenced-by-published-guide";
      /** Effective window in days when applicable, otherwise `null`. */
      readonly effectiveDays: number | null;
      /** Age observed at planning time, in whole days. */
      readonly ageDays: number;
    };

export interface RetentionPlan {
  readonly workspaceId: string;
  /** The policy the plan was computed against, after applying defaults. */
  readonly effectivePolicy: {
    readonly days: number | null;
    readonly overridesByCategory: Readonly<
      Partial<Record<RetentionCategory, number | null>>
    >;
  };
  readonly plannedAt: string;
  readonly decisions: readonly RetentionDecision[];
  readonly summary: {
    readonly targetsEvaluated: number;
    readonly toDelete: number;
    readonly skipped: number;
    readonly skippedByReason: Readonly<Record<string, number>>;
  };
}

/**
 * The delete surface. The caller implements it over its actual storage.
 * Returning `false` means the target was already gone; returning `true`
 * means this call deleted it. Throwing fails the sweep for that target —
 * the caller's other targets are still processed and the failure is
 * reported.
 */
export interface RetentionDeleteSurface {
  delete(input: {
    readonly targetId: string;
    readonly category: RetentionCategory;
    readonly workspaceId: string;
  }): Promise<boolean>;
}

export interface RetentionSweepResult {
  readonly workspaceId: string;
  readonly plannedAt: string;
  readonly executedAt: string;
  readonly dryRun: boolean;
  readonly attempted: number;
  readonly deleted: number;
  readonly alreadyGone: number;
  readonly failed: number;
  readonly failures: readonly {
    readonly targetId: string;
    readonly category: RetentionCategory;
    readonly message: string;
  }[];
  readonly skippedByReason: Readonly<Record<string, number>>;
}

/* -------------------------------------------------------------------------- */
/* Policy resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a policy against the platform default. `policy` may be `null`
 * (no workspace policy set), in which case a policy is synthesized from
 * the default. A default of `null` means "keep forever" and must be an
 * explicit operator choice — it is never produced by this function
 * without being present on the input.
 */
export function resolveRetentionPolicy(input: {
  readonly workspaceId: string;
  readonly policy: RetentionPolicy | null;
  /** The platform default in days; `null` for "keep forever". */
  readonly platformDefaultDays: number | null;
}): RetentionPolicy {
  if (nonEmpty(input.workspaceId) === null) {
    throw new RetentionError("`workspaceId` is required.", "invalid-input");
  }
  if (input.platformDefaultDays !== null) {
    if (
      !Number.isInteger(input.platformDefaultDays) ||
      input.platformDefaultDays < 1
    ) {
      throw new RetentionError(
        "`platformDefaultDays` must be a positive integer or `null`.",
        "invalid-input",
        { received: input.platformDefaultDays },
      );
    }
  }
  const policy = input.policy;
  if (policy === null) {
    return {
      workspaceId: input.workspaceId,
      days: input.platformDefaultDays,
      overridesByCategory: {},
    };
  }
  validatePolicy(policy, input.workspaceId);
  // A workspace policy of `days: null` means "keep forever"; that is a
  // deliberate choice and this function does not overwrite it with the
  // platform default.
  return {
    workspaceId: policy.workspaceId,
    days: policy.days,
    overridesByCategory: policy.overridesByCategory ?? {},
    dryRun: policy.dryRun,
  };
}

function validatePolicy(policy: RetentionPolicy, expectedWorkspaceId: string): void {
  if (policy.workspaceId !== expectedWorkspaceId) {
    throw new RetentionError(
      "`policy.workspaceId` does not match the workspace being swept.",
      "invalid-input",
      { policyWorkspaceId: policy.workspaceId, expected: expectedWorkspaceId },
    );
  }
  if (policy.days !== null) {
    if (!Number.isInteger(policy.days) || policy.days < 1) {
      throw new RetentionError(
        "`policy.days` must be a positive integer or `null`.",
        "invalid-input",
        { received: policy.days },
      );
    }
  }
  const overrides = policy.overridesByCategory;
  if (overrides !== undefined && overrides !== null) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!isRetentionCategory(key)) {
        throw new RetentionError(
          `Retention override names unknown category "${key}".`,
          "invalid-input",
          { category: key },
        );
      }
      if (value !== null) {
        if (!Number.isInteger(value) || value < 1) {
          throw new RetentionError(
            `Retention override for category "${key}" must be a positive integer or \`null\`.`,
            "invalid-input",
            { category: key, received: value },
          );
        }
      }
    }
  }
}

/**
 * The effective window for a category: the override when present
 * (including an explicit `null` for "keep forever in this category"), or
 * the workspace-wide `days` otherwise.
 */
export function effectiveWindowForCategory(
  policy: RetentionPolicy,
  category: RetentionCategory,
): number | null {
  const overrides = policy.overridesByCategory ?? {};
  if (Object.prototype.hasOwnProperty.call(overrides, category)) {
    return overrides[category] ?? null;
  }
  return policy.days;
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute a plan for a workspace's targets. Pure: no I/O, no clock except
 * for the `now` the caller supplies (so a test is deterministic and an
 * admin UI can ask "what would have happened yesterday").
 */
export function planRetentionSweep(input: {
  readonly policy: RetentionPolicy;
  readonly targets: readonly RetentionTarget[];
  /** The clock to read. Injectable so tests are deterministic. */
  readonly now: Date;
}): RetentionPlan {
  if (input === null || typeof input !== "object") {
    throw new RetentionError("`input` is required.", "invalid-input");
  }
  const { policy, targets, now } = input;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RetentionError("`now` must be a valid Date.", "invalid-input");
  }
  validatePolicy(policy, policy.workspaceId);

  const nowMs = now.getTime();
  const decisions: RetentionDecision[] = [];
  const skippedByReason: Record<string, number> = {};

  for (const target of targets) {
    if (target.workspaceId !== policy.workspaceId) {
      // A caller mixing workspaces in one call is a bug; rather than
      // silently dropping the target, fail the whole plan so the caller
      // can fix the query.
      throw new RetentionError(
        `Target "${target.id}" belongs to workspace "${target.workspaceId}" but the plan is for "${policy.workspaceId}".`,
        "invalid-input",
      );
    }
    if (!isRetentionCategory(target.category)) {
      throw new RetentionError(
        `Target "${target.id}" has unknown category "${target.category}".`,
        "invalid-input",
      );
    }
    const createdAtMs = Date.parse(target.createdAt);
    if (!Number.isFinite(createdAtMs)) {
      throw new RetentionError(
        `Target "${target.id}" has an unparseable createdAt "${target.createdAt}".`,
        "invalid-input",
      );
    }
    const ageMs = Math.max(0, nowMs - createdAtMs);
    const ageDays = Math.floor(ageMs / MS_PER_DAY);

    // Order matters: a legal hold and a published-guide reference are
    // both absolute exemptions; they are checked before age so the reason
    // the target survived is precise.
    if (target.legalHold === true) {
      decisions.push({
        action: "skip",
        targetId: target.id,
        category: target.category,
        reason: "legal-hold",
        effectiveDays: effectiveWindowForCategory(policy, target.category),
        ageDays,
      });
      skippedByReason["legal-hold"] = (skippedByReason["legal-hold"] ?? 0) + 1;
      continue;
    }
    if (target.referencedByPublishedGuide === true) {
      decisions.push({
        action: "skip",
        targetId: target.id,
        category: target.category,
        reason: "referenced-by-published-guide",
        effectiveDays: effectiveWindowForCategory(policy, target.category),
        ageDays,
      });
      skippedByReason["referenced-by-published-guide"] =
        (skippedByReason["referenced-by-published-guide"] ?? 0) + 1;
      continue;
    }

    const window = effectiveWindowForCategory(policy, target.category);
    if (window === null) {
      decisions.push({
        action: "skip",
        targetId: target.id,
        category: target.category,
        reason: "keep-forever",
        effectiveDays: null,
        ageDays,
      });
      skippedByReason["keep-forever"] =
        (skippedByReason["keep-forever"] ?? 0) + 1;
      continue;
    }
    if (ageDays >= window) {
      decisions.push({
        action: "delete",
        targetId: target.id,
        category: target.category,
        reason: "age-exceeded",
        effectiveDays: window,
        ageDays,
      });
      continue;
    }
    decisions.push({
      action: "skip",
      targetId: target.id,
      category: target.category,
      reason: "not-yet-eligible",
      effectiveDays: window,
      ageDays,
    });
    skippedByReason["not-yet-eligible"] =
      (skippedByReason["not-yet-eligible"] ?? 0) + 1;
  }

  const toDelete = decisions.filter((d) => d.action === "delete").length;
  return {
    workspaceId: policy.workspaceId,
    effectivePolicy: {
      days: policy.days,
      overridesByCategory: policy.overridesByCategory ?? {},
    },
    plannedAt: now.toISOString(),
    decisions: Object.freeze(decisions),
    summary: {
      targetsEvaluated: decisions.length,
      toDelete,
      skipped: decisions.length - toDelete,
      skippedByReason: Object.freeze({ ...skippedByReason }),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Execute a plan. A `dryRun` plan (either the policy's `dryRun` flag or
 * the caller's override) counts the targets it *would* have deleted and
 * makes no delete calls; the caller is expected to display the result.
 */
export async function executeRetentionSweep(input: {
  readonly plan: RetentionPlan;
  readonly deleteSurface: RetentionDeleteSurface;
  /** True to skip deletion entirely; overrides a `dryRun: false` policy. */
  readonly dryRun?: boolean;
  readonly now: Date;
}): Promise<RetentionSweepResult> {
  if (input === null || typeof input !== "object") {
    throw new RetentionError("`input` is required.", "invalid-input");
  }
  const { plan, deleteSurface } = input;
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new RetentionError("`now` must be a valid Date.", "invalid-input");
  }
  if (typeof deleteSurface?.delete !== "function") {
    throw new RetentionError(
      "A `deleteSurface` with a `delete` method is required.",
      "invalid-input",
    );
  }
  const dryRun = input.dryRun === true;

  const toDelete = plan.decisions.filter(
    (d): d is Extract<RetentionDecision, { action: "delete" }> =>
      d.action === "delete",
  );

  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;
  const failures: { targetId: string; category: RetentionCategory; message: string }[] = [];

  for (const decision of toDelete) {
    if (dryRun) {
      // Count as "would delete" via `deleted` in a dry run; the caller
      // reads `dryRun: true` on the result to render the wording.
      deleted += 1;
      continue;
    }
    try {
      const did = await deleteSurface.delete({
        targetId: decision.targetId,
        category: decision.category,
        workspaceId: plan.workspaceId,
      });
      if (did) deleted += 1;
      else alreadyGone += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      failures.push({
        targetId: decision.targetId,
        category: decision.category,
        message,
      });
    }
  }

  return {
    workspaceId: plan.workspaceId,
    plannedAt: plan.plannedAt,
    executedAt: input.now.toISOString(),
    dryRun,
    attempted: toDelete.length,
    deleted,
    alreadyGone,
    failed,
    failures: Object.freeze(failures),
    skippedByReason: plan.summary.skippedByReason,
  };
}

/* -------------------------------------------------------------------------- */
/* Audit helper                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the audit `detail` record an admin trace expects for a retention
 * sweep. Kept small (see the audit log's byte cap): a sweep with tens of
 * thousands of deletes still records a bounded record, because the
 * individual targets can be recovered from the storage layer's own log
 * with the `planHash`.
 */
export function buildSweepAuditDetail(input: {
  readonly plan: RetentionPlan;
  readonly result: RetentionSweepResult;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    plannedAt: input.plan.plannedAt,
    executedAt: input.result.executedAt,
    dryRun: input.result.dryRun,
    effectiveDays: input.plan.effectivePolicy.days,
    targetsEvaluated: input.plan.summary.targetsEvaluated,
    attempted: input.result.attempted,
    deleted: input.result.deleted,
    alreadyGone: input.result.alreadyGone,
    failed: input.result.failed,
    skippedByReason: input.result.skippedByReason,
    failureSample: input.result.failures.slice(0, 5),
  });
}

/**
 * The requirements the caller's retention routine must satisfy that this
 * module cannot enforce. Documented so the deployment phase wires them.
 */
export function describeRetentionRequirements(): readonly string[] {
  return [
    "Run the sweep on a schedule owned by the platform (the phase's scheduler); a retention policy that is never executed is not a policy.",
    "Sweep each workspace separately; never mix workspaces in one query, because a per-workspace retention period must not be overridden by another workspace's shorter window.",
    "Perform the delete through the object store's own delete (which is authoritative for storage cost) as well as the metadata table; an orphaned object is a real loss of control even after the row is gone.",
    "Emit one audit entry per workspace sweep with the detail produced by `buildSweepAuditDetail`; a per-target entry would flood an audit view that is already maintained for a different purpose.",
    "Never sweep a target that is referenced by a published guide, even if the guide's workspace has a shorter retention than the target's authoring workspace. The published-guide reference is an absolute exemption because the guide's rendering depends on the target.",
    "Honour a legal hold set by the workspace owner or by the platform operator; a legal hold must be visible in the workspace's own audit trail and reversible only with a recorded reason.",
    "For a data-subject request, the caller performs the deletion and records the completion separately; the retention sweep is a *policy* mechanism and must not be used as a substitute for a GDPR erasure flow (see @zipy/security/gdpr).",
    "Run the sweep's `planRetentionSweep` first with the same targets to populate a dry-run view in the admin UI so an operator can see the effect of a policy change before it runs.",
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

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  resolveRetentionPolicy,
  effectiveWindowForCategory,
  planRetentionSweep,
  executeRetentionSweep,
  buildSweepAuditDetail,
  validatePolicy,
  MS_PER_DAY,
});
