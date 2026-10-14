/**
 * Zipy AI — recurring regeneration policy (phase 24, batch 2).
 *
 * Guides and workflows can be regenerated on a schedule (the plan lists
 * "recurring regeneration" and "scheduled generation" as separate features
 * that share this mechanism). This module is the *policy*: it models a
 * schedule, computes the next due time from a cadence, and reports whether a
 * guide is currently due. It deliberately does not own a timer — a schedule
 * is a deployment concern (cron on the host, a scheduled job in the worker,
 * or a container-platform scheduler), and this module produces the answer
 * that mechanism reads.
 *
 * Design boundaries honoured here:
 *
 *  - The module is *pure*. It does not query the database, does not read the
 *    clock unless a caller passes it, and does not enqueue jobs. A
 *    persistence layer above it stores schedules, and the worker's bootstrap
 *    calls `dueSchedules(rows, now)` to decide what to enqueue. This keeps
 *    the cadence arithmetic testable without a database.
 *
 *  - Cadences are computed in UTC. Anchoring on UTC keeps a weekly schedule
 *    stable regardless of the deployment's local time zone, and it keeps the
 *    DST arithmetic unambiguous. To schedule "every Monday at 09:00 local"
 *    the operator configures a daily cadence with an anchor and filters with
 *    `dayOfWeek` — a shift would need a time-zone library, and this module
 *    does not pull one in because the plan does not request time-zone-aware
 *    scheduling.
 *
 *  - No timer is invented. `nextRunAfter` computes one timestamp; it does
 *    not schedule anything. The worker's poll loop owns the timing.
 *
 *  - The module refuses to guess. A cadence of `custom` requires a
 *    `customIntervalMs`; an operator who leaves it blank receives a typed
 *    error rather than a silent fallback to daily.
 *
 *  - Deletion is a first-class close: a schedule can be `paused` (skipped
 *    without advancing) or `cancelled` (terminal). The distinction matters
 *    because pausing then resuming must not regenerate for every interval
 *    that elapsed while paused.
 *
 * The module exports:
 *   - `computeNextRun` — the next due time from a cadence and an anchor.
 *   - `isDue` — whether a schedule is due at a given instant.
 *   - `dueSchedules` — filter a list to those due, for the worker's sweep.
 *   - `advanceSchedule` — the post-run transition (records the run, computes
 *     the next due time, or terminates on `maxRuns`/`endAt`).
 *   - `rehydrateSchedule` — typed load of a persisted row.
 *   - Typed errors, cadence constants, and a description helper.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type ScheduleErrorCode =
  | "invalid-input"
  | "unknown-cadence"
  | "custom-interval-missing"
  | "custom-interval-too-small"
  | "invalid-anchor"
  | "end-before-start"
  | "wrong-version";

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ScheduleErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The cadence vocabulary. Each cadence maps to a fixed interval in
 * milliseconds; `custom` uses a caller-supplied interval so a deployment can
 * express "every 90 minutes" without adding a new enum member.
 */
export const SCHEDULE_CADENCES = [
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "custom",
] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

export type ScheduleStatus = "active" | "paused" | "cancelled";

/**
 * A recurring regeneration schedule. This is the persisted row shape; the
 * module treats every field as data, never as a source of side effects.
 */
export interface RegenerationSchedule {
  readonly version: "regeneration-schedule/1";
  readonly scheduleId: string;
  readonly workspaceId: string;
  /**
   * The target of the regeneration: a guide id, a workflow id, or a source
   * bundle id. The `targetKind` says which so the worker routes correctly.
   */
  readonly targetId: string;
  readonly targetKind: "guide" | "workflow" | "source-bundle";
  readonly cadence: ScheduleCadence;
  /**
   * For `custom`, the interval in milliseconds. Absent for the named
   * cadences. Bounded below by `MIN_CUSTOM_INTERVAL_MS`.
   */
  readonly customIntervalMs: number | null;
  /**
   * The first instant the schedule becomes eligible to run. The schedule
   * advances from here; a schedule created at T with a daily cadence and an
   * anchor of T is due at T, T + 1d, T + 2d, ...
   */
  readonly anchorAt: string;
  /**
   * The most recent time the schedule fired. Null before the first run.
   * Persisted because it is the source of truth for "what is next"; the
   * `anchorAt` + cadence arithmetic is only used to initialise it.
   */
  readonly lastRunAt: string | null;
  /**
   * A precomputed next-due timestamp. Kept alongside `lastRunAt` because the
   * worker's sweep is a range query on `nextDueAt`; recomputing from
   * `lastRunAt` per row would defeat the index. `advanceSchedule` keeps them
   * consistent.
   */
  readonly nextDueAt: string | null;
  readonly status: ScheduleStatus;
  /**
   * Optional upper bound: the schedule does not fire at or after this time.
   * Set by an operator who is running a migration and does not want the
   * schedule to keep firing afterwards.
   */
  readonly endAt: string | null;
  /**
   * Optional maximum number of firings. A schedule that has fired this many
   * times terminates (`status: "cancelled"`) on the next advance.
   */
  readonly maxRuns: number | null;
  /** How many times the schedule has fired. Incremented by `advanceSchedule`. */
  readonly runCount: number;
  /**
   * Optional restriction: only fire when the UTC day-of-week is one of these.
   * 0 = Sunday, 1 = Monday, ..., 6 = Saturday. Empty means "any day".
   */
  readonly dayOfWeek: readonly number[];
  /**
   * The set of sections the regeneration should refresh. An empty array
   * means "everything the target produces". A non-empty array narrows the
   * regeneration to the named sections (e.g. [`"step-copy"`, `"annotations"`]).
   */
  readonly scope: readonly string[];
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One firing the worker needs to perform. The sweep returns these; the
 * worker enqueues a job per item and then calls `advanceSchedule` with the
 * new row from the database.
 */
export interface DueFiring {
  readonly scheduleId: string;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly targetKind: RegenerationSchedule["targetKind"];
  /** The instant the firing is due for. Equal to `nextDueAt` (or `anchorAt`). */
  readonly dueAt: string;
  /** The scope the regeneration should honour. */
  readonly scope: readonly string[];
  /** How many times this schedule has fired before, counting this firing. */
  readonly runNumber: number;
}

/** The post-run transition. Callers persist the returned schedule. */
export interface AdvancedSchedule {
  readonly schedule: RegenerationSchedule;
  /** Whether the schedule terminated as a result of this advance. */
  readonly terminated: boolean;
  readonly terminateReason: "max-runs" | "end-at" | null;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const CADENCE_INTERVAL_MS: Readonly<Record<Exclude<ScheduleCadence, "custom">, number>> =
  Object.freeze({
    hourly: 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    monthly: 30 * 24 * 60 * 60 * 1000,
  });

/**
 * A `monthly` cadence is approximated as 30 days. Anchoring a *calendar*
 * month would require a date library and would produce different intervals
 * across months; the plan's regeneration feature wants a predictable drift
 * rather than a true calendar month, so the fixed interval is the honest
 * choice and this constant documents that.
 */
export const MONTHLY_IS_THIRTY_DAYS = true;

/**
 * The floor for a custom interval. Anything below five minutes produces more
 * regeneration load than the platform's browser farm can service without
 * starving interactive workflows, so the schedule refuses to accept it.
 */
export const MIN_CUSTOM_INTERVAL_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Cadence arithmetic                                                         */
/* -------------------------------------------------------------------------- */

function intervalFor(schedule: Pick<RegenerationSchedule, "cadence" | "customIntervalMs">): number {
  if (schedule.cadence === "custom") {
    const v = schedule.customIntervalMs;
    if (v === null || typeof v !== "number" || !Number.isFinite(v)) {
      throw new ScheduleError(
        'A schedule with cadence "custom" requires a numeric `customIntervalMs`.',
        "custom-interval-missing",
      );
    }
    if (v < MIN_CUSTOM_INTERVAL_MS) {
      throw new ScheduleError(
        `Custom interval ${v} ms is below the ${MIN_CUSTOM_INTERVAL_MS} ms minimum.`,
        "custom-interval-too-small",
        { customIntervalMs: v, minimum: MIN_CUSTOM_INTERVAL_MS },
      );
    }
    return Math.floor(v);
  }
  if (
    schedule.cadence === "hourly" ||
    schedule.cadence === "daily" ||
    schedule.cadence === "weekly" ||
    schedule.cadence === "monthly"
  ) {
    return CADENCE_INTERVAL_MS[schedule.cadence];
  }
  throw new ScheduleError(
    `Unknown cadence "${String(schedule.cadence)}".`,
    "unknown-cadence",
    { cadence: schedule.cadence },
  );
}

/**
 * Compute the next due time strictly after `afterMs`. The function steps in
 * whole intervals from the anchor, which keeps a weekly schedule pinned to
 * the same day-of-week it started on even if a firing was skipped.
 *
 * The loop is bounded: an anchor far in the past with an hourly cadence
 * would otherwise iterate thousands of times in the common case where a
 * deployment has just been restarted after a long outage. The bound is
 * reached by jumping: if the anchor is more than 1000 intervals behind, the
 * function leaps forward by the exact multiple that brings the schedule
 * within one interval of `afterMs`. This is the same result as iterating,
 * just faster.
 */
export function computeNextRun(
  schedule: Pick<
    RegenerationSchedule,
    "cadence" | "customIntervalMs" | "anchorAt" | "dayOfWeek"
  >,
  afterMs: number,
): number {
  if (typeof afterMs !== "number" || !Number.isFinite(afterMs)) {
    throw new ScheduleError("computeNextRun requires a finite `afterMs`.", "invalid-input");
  }
  const interval = intervalFor(schedule);
  const anchorMs = Date.parse(schedule.anchorAt);
  if (!Number.isFinite(anchorMs)) {
    throw new ScheduleError(
      `Schedule anchor "${String(schedule.anchorAt)}" is not a valid ISO timestamp.`,
      "invalid-anchor",
      { anchorAt: schedule.anchorAt },
    );
  }
  if (afterMs < anchorMs) {
    // A timestamp before the anchor: the first run is at the anchor itself,
    // unless the day-of-week filter excludes it, in which case the search
    // continues forward.
    return findFirstAllowed(anchorMs, interval, schedule.dayOfWeek);
  }
  // Jump directly to the anchor-relative index that is <= afterMs, then step
  // forward by one. This keeps a schedule pinned to its phase even when the
  // worker has been down for a long time, without looping for every missed
  // firing.
  const elapsed = afterMs - anchorMs;
  const indexAtOrBefore = Math.floor(elapsed / interval);
  const candidate = anchorMs + (indexAtOrBefore + 1) * interval;
  return findFirstAllowed(candidate, interval, schedule.dayOfWeek);
}

function findFirstAllowed(startMs: number, interval: number, dayOfWeek: readonly number[]): number {
  const hasFilter = dayOfWeek.length > 0;
  if (!hasFilter) return startMs;
  // The filter is a week-long cycle, so at most seven steps are needed.
  let candidate = startMs;
  for (let i = 0; i < 7; i += 1) {
    const dow = new Date(candidate).getUTCDay();
    if (dayOfWeek.includes(dow)) return candidate;
    candidate += interval;
  }
  // Reaching here means the cadence's interval never lands on an allowed
  // day-of-week (e.g. a two-day interval and a single allowed day). Fail
  // loudly rather than looping or returning a time the operator did not ask
  // for.
  throw new ScheduleError(
    "No occurrence of this schedule lands on an allowed day-of-week. Adjust the cadence or the day-of-week filter.",
    "invalid-input",
    { dayOfWeek, interval },
  );
}

/**
 * Whether a schedule fires at `nowMs`. A schedule fires when it is `active`,
 * its anchor is in the past, its next due time has arrived, it is not past
 * `endAt`, its `maxRuns` (if set) has not been reached, and the day-of-week
 * filter (if set) includes the current UTC day.
 */
export function isDue(schedule: RegenerationSchedule, nowMs: number): boolean {
  if (schedule === null || typeof schedule !== "object") return false;
  if (schedule.version !== "regeneration-schedule/1") return false;
  if (schedule.status !== "active") return false;
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return false;
  if (schedule.maxRuns !== null && schedule.runCount >= schedule.maxRuns) return false;
  if (schedule.endAt !== null) {
    const endMs = Date.parse(schedule.endAt);
    if (Number.isFinite(endMs) && nowMs >= endMs) return false;
  }
  const anchorMs = Date.parse(schedule.anchorAt);
  if (!Number.isFinite(anchorMs) || nowMs < anchorMs) return false;
  const nextMs = nextDueMs(schedule);
  if (nextMs === null) return false;
  if (nowMs < nextMs) return false;
  if (schedule.dayOfWeek.length > 0) {
    const dow = new Date(nextMs).getUTCDay();
    if (!schedule.dayOfWeek.includes(dow)) return false;
  }
  return true;
}

function nextDueMs(schedule: RegenerationSchedule): number | null {
  if (schedule.nextDueAt !== null) {
    const v = Date.parse(schedule.nextDueAt);
    return Number.isFinite(v) ? v : null;
  }
  // A schedule that has never run has no persisted `nextDueAt`; compute the
  // first run from the anchor. This is the one case where the arithmetic
  // falls back to the anchor rather than the stored next-due.
  if (schedule.lastRunAt === null) {
    const anchorMs = Date.parse(schedule.anchorAt);
    if (!Number.isFinite(anchorMs)) return null;
    return computeNextRun(schedule, anchorMs - 1);
  }
  const lastMs = Date.parse(schedule.lastRunAt);
  if (!Number.isFinite(lastMs)) return null;
  return computeNextRun(schedule, lastMs);
}

/**
 * Filter a list of schedules to those due at `nowMs`. The worker's sweep
 * calls this on the rows whose `nextDueAt <= now` (the index bounds the
 * scan); this function exists so a small deployment can sweep by reading
 * every row when the index has not been built yet.
 */
export function dueSchedules(
  schedules: readonly RegenerationSchedule[],
  nowMs: number,
): readonly DueFiring[] {
  if (!Array.isArray(schedules)) {
    throw new ScheduleError("dueSchedules requires an array.", "invalid-input");
  }
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new ScheduleError("dueSchedules requires a finite `nowMs`.", "invalid-input");
  }
  const out: DueFiring[] = [];
  for (const schedule of schedules) {
    if (!isDue(schedule, nowMs)) continue;
    const dueMs = nextDueMs(schedule);
    if (dueMs === null) continue;
    out.push({
      scheduleId: schedule.scheduleId,
      workspaceId: schedule.workspaceId,
      targetId: schedule.targetId,
      targetKind: schedule.targetKind,
      dueAt: new Date(dueMs).toISOString(),
      scope: schedule.scope,
      runNumber: schedule.runCount + 1,
    });
  }
  return Object.freeze(out);
}

/**
 * Transition a schedule after a firing. The schedule records the run,
 * computes the next due time, and terminates when the run count reaches
 * `maxRuns` or the next due time crosses `endAt`. The caller persists the
 * returned schedule; a schedule that terminated has `status: "cancelled"`
 * and `nextDueAt: null`.
 */
export function advanceSchedule(
  schedule: RegenerationSchedule,
  firedAtMs: number,
  options: { readonly status?: ScheduleStatus } = {},
): AdvancedSchedule {
  if (schedule === null || typeof schedule !== "object" || schedule.version !== "regeneration-schedule/1") {
    throw new ScheduleError(
      'advanceSchedule requires a RegenerationSchedule (version "regeneration-schedule/1").',
      "invalid-input",
    );
  }
  if (typeof firedAtMs !== "number" || !Number.isFinite(firedAtMs)) {
    throw new ScheduleError("advanceSchedule requires a finite `firedAtMs`.", "invalid-input");
  }
  // A pause or cancel transitions the schedule without advancing the run
  // counter. Callers use this for "pause for a maintenance window" without
  // triggering a catch-up burst when the schedule resumes.
  if (options.status === "paused" || options.status === "cancelled") {
    return {
      schedule: {
        ...schedule,
        status: options.status,
        updatedAt: new Date(firedAtMs).toISOString(),
      },
      terminated: options.status === "cancelled",
      terminateReason: null,
    };
  }

  const runCount = schedule.runCount + 1;
  const firedIso = new Date(firedAtMs).toISOString();

  // Terminate at `maxRuns`.
  if (schedule.maxRuns !== null && runCount >= schedule.maxRuns) {
    return {
      schedule: {
        ...schedule,
        status: "cancelled",
        runCount,
        lastRunAt: firedIso,
        nextDueAt: null,
        updatedAt: firedIso,
      },
      terminated: true,
      terminateReason: "max-runs",
    };
  }

  const nextMs = computeNextRun(schedule, firedAtMs);

  // Terminate when the next run is past `endAt`.
  if (schedule.endAt !== null) {
    const endMs = Date.parse(schedule.endAt);
    if (Number.isFinite(endMs) && nextMs >= endMs) {
      return {
        schedule: {
          ...schedule,
          status: "cancelled",
          runCount,
          lastRunAt: firedIso,
          nextDueAt: null,
          updatedAt: firedIso,
        },
        terminated: true,
        terminateReason: "end-at",
      };
    }
  }

  return {
    schedule: {
      ...schedule,
      status: "active",
      runCount,
      lastRunAt: firedIso,
      nextDueAt: new Date(nextMs).toISOString(),
      updatedAt: firedIso,
    },
    terminated: false,
    terminateReason: null,
  };
}

/**
 * One-line human summary the dashboard renders on the schedule row.
 */
export function describeSchedule(schedule: RegenerationSchedule): string {
  const cadenceText =
    schedule.cadence === "custom"
      ? `every ${Math.round((schedule.customIntervalMs ?? 0) / 60_000)} minutes`
      : schedule.cadence === "hourly"
        ? "hourly"
        : schedule.cadence === "daily"
          ? "daily"
          : schedule.cadence === "weekly"
            ? "weekly"
            : "monthly (30 days)";
  const statusText =
    schedule.status === "active"
      ? schedule.nextDueAt !== null
        ? `next run ${schedule.nextDueAt}`
        : "next run pending"
      : schedule.status === "paused"
        ? "paused"
        : "cancelled";
  const scopeText = schedule.scope.length > 0 ? ` (scope: ${schedule.scope.join(", ")})` : "";
  return `Regenerate ${cadenceText}${scopeText} — ${statusText}; ${schedule.runCount} run(s) so far.`;
}

/* -------------------------------------------------------------------------- */
/* Validation + rehydration                                                   */
/* -------------------------------------------------------------------------- */

export interface CreateScheduleInput {
  readonly scheduleId: string;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly targetKind: RegenerationSchedule["targetKind"];
  readonly cadence: ScheduleCadence;
  readonly customIntervalMs?: number | null;
  readonly anchorAt: string;
  readonly endAt?: string | null;
  readonly maxRuns?: number | null;
  readonly dayOfWeek?: readonly number[];
  readonly scope?: readonly string[];
  readonly createdBy?: string | null;
  readonly createdAt: string;
}

/**
 * Validate and normalise a new schedule. Returns the row the caller persists
 * with `status: "active"`, `runCount: 0`, and `nextDueAt` precomputed from
 * the anchor so the worker's first sweep sees the schedule through the same
 * indexed predicate as subsequent firings.
 */
export function createSchedule(input: CreateScheduleInput): RegenerationSchedule {
  if (input === null || typeof input !== "object") {
    throw new ScheduleError("createSchedule requires an inputs object.", "invalid-input");
  }
  const require = (name: string, v: unknown): string => {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new ScheduleError(`createSchedule requires \`${name}\`.`, "invalid-input", { name });
    }
    return v;
  };
  const scheduleId = require("scheduleId", input.scheduleId);
  const workspaceId = require("workspaceId", input.workspaceId);
  const targetId = require("targetId", input.targetId);
  const anchorAt = require("anchorAt", input.anchorAt);
  const createdAt = require("createdAt", input.createdAt);

  if (
    input.targetKind !== "guide" &&
    input.targetKind !== "workflow" &&
    input.targetKind !== "source-bundle"
  ) {
    throw new ScheduleError(
      `Unknown targetKind "${String(input.targetKind)}".`,
      "invalid-input",
      { targetKind: input.targetKind },
    );
  }
  if (
    input.cadence !== "hourly" &&
    input.cadence !== "daily" &&
    input.cadence !== "weekly" &&
    input.cadence !== "monthly" &&
    input.cadence !== "custom"
  ) {
    throw new ScheduleError(
      `Unknown cadence "${String(input.cadence)}".`,
      "unknown-cadence",
      { cadence: input.cadence },
    );
  }
  const anchorMs = Date.parse(anchorAt);
  if (!Number.isFinite(anchorMs)) {
    throw new ScheduleError(
      `anchorAt "${anchorAt}" is not a valid ISO timestamp.`,
      "invalid-anchor",
      { anchorAt },
    );
  }
  const endAt = input.endAt ?? null;
  if (endAt !== null) {
    const endMs = Date.parse(endAt);
    if (!Number.isFinite(endMs)) {
      throw new ScheduleError(
        `endAt "${endAt}" is not a valid ISO timestamp.`,
        "invalid-anchor",
        { endAt },
      );
    }
    if (endMs <= anchorMs) {
      throw new ScheduleError(
        `endAt "${endAt}" must be after anchorAt "${anchorAt}".`,
        "end-before-start",
        { anchorAt, endAt },
      );
    }
  }
  const maxRuns = input.maxRuns ?? null;
  if (maxRuns !== null) {
    if (typeof maxRuns !== "number" || !Number.isInteger(maxRuns) || maxRuns < 1) {
      throw new ScheduleError(
        `maxRuns must be a positive integer or null; received ${String(maxRuns)}.`,
        "invalid-input",
        { maxRuns },
      );
    }
  }
  const customIntervalMs = input.customIntervalMs ?? null;
  if (input.cadence === "custom") {
    if (customIntervalMs === null) {
      throw new ScheduleError(
        'A schedule with cadence "custom" requires `customIntervalMs`.',
        "custom-interval-missing",
      );
    }
    if (customIntervalMs < MIN_CUSTOM_INTERVAL_MS) {
      throw new ScheduleError(
        `Custom interval ${customIntervalMs} ms is below the ${MIN_CUSTOM_INTERVAL_MS} ms minimum.`,
        "custom-interval-too-small",
        { customIntervalMs, minimum: MIN_CUSTOM_INTERVAL_MS },
      );
    }
  } else if (customIntervalMs !== null) {
    throw new ScheduleError(
      `customIntervalMs is only valid when cadence is "custom"; received a value for cadence "${input.cadence}".`,
      "invalid-input",
      { cadence: input.cadence, customIntervalMs },
    );
  }

  const dayOfWeek = normaliseDayOfWeek(input.dayOfWeek);
  const scope = normaliseScope(input.scope);

  const base: Omit<RegenerationSchedule, "nextDueAt"> = {
    version: "regeneration-schedule/1",
    scheduleId,
    workspaceId,
    targetId,
    targetKind: input.targetKind,
    cadence: input.cadence,
    customIntervalMs,
    anchorAt,
    lastRunAt: null,
    status: "active",
    endAt,
    maxRuns,
    runCount: 0,
    dayOfWeek,
    scope,
    createdBy: input.createdBy ?? null,
    createdAt,
    updatedAt: createdAt,
  };
  const firstMs = computeNextRun(base, anchorMs - 1);
  return {
    ...base,
    nextDueAt: new Date(firstMs).toISOString(),
  };
}

export function rehydrateSchedule(value: unknown): RegenerationSchedule {
  if (value === null || typeof value !== "object") {
    throw new ScheduleError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "regeneration-schedule/1") {
    throw new ScheduleError(
      `Rehydrate failed: expected version "regeneration-schedule/1", received "${String(r["version"])}".`,
      "wrong-version",
    );
  }
  const cadence = readCadence(r["cadence"]);
  const customIntervalRaw = r["customIntervalMs"];
  const customIntervalMs =
    typeof customIntervalRaw === "number" ? customIntervalRaw : null;
  return {
    version: "regeneration-schedule/1",
    scheduleId: stringOr(r["scheduleId"], ""),
    workspaceId: stringOr(r["workspaceId"], ""),
    targetId: stringOr(r["targetId"], ""),
    targetKind: readTargetKind(r["targetKind"]),
    cadence,
    customIntervalMs,
    anchorAt: stringOr(r["anchorAt"], ""),
    lastRunAt: stringOrNull(r["lastRunAt"]),
    nextDueAt: stringOrNull(r["nextDueAt"]),
    status: readStatus(r["status"]),
    endAt: stringOrNull(r["endAt"]),
    maxRuns: integerOrNull(r["maxRuns"]),
    runCount: integerOr(r["runCount"], 0),
    dayOfWeek: normaliseDayOfWeek(r["dayOfWeek"]),
    scope: normaliseScope(r["scope"]),
    createdBy: stringOrNull(r["createdBy"]),
    createdAt: stringOr(r["createdAt"], ""),
    updatedAt: stringOr(r["updatedAt"], ""),
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence DDL — declared here so the migration runner registers it once  */
/* -------------------------------------------------------------------------- */

export const REGENERATION_SCHEDULES_TABLE = "regeneration_schedules" as const;
export const REGENERATION_SCHEDULES_SCHEMA_VERSION = 1 as const;

export const CREATE_REGENERATION_SCHEDULES_SQL = `
CREATE TABLE IF NOT EXISTS ${REGENERATION_SCHEDULES_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_key          TEXT NOT NULL UNIQUE,
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id             UUID NOT NULL,
  target_kind           TEXT NOT NULL,
  cadence               TEXT NOT NULL,
  custom_interval_ms    BIGINT,
  anchor_at             TIMESTAMPTZ NOT NULL,
  last_run_at           TIMESTAMPTZ,
  next_due_at           TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'active',
  end_at                TIMESTAMPTZ,
  max_runs              INTEGER,
  run_count             INTEGER NOT NULL DEFAULT 0,
  day_of_week           SMALLINT[] NOT NULL DEFAULT '{}'::smallint[],
  scope                 TEXT[] NOT NULL DEFAULT '{}'::text[],
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${REGENERATION_SCHEDULES_TABLE}_cadence_allowed
    CHECK (cadence IN ('hourly','daily','weekly','monthly','custom')),
  CONSTRAINT ${REGENERATION_SCHEDULES_TABLE}_cadence_custom_interval
    CHECK ((cadence = 'custom' AND custom_interval_ms IS NOT NULL AND custom_interval_ms >= 300000)
        OR (cadence <> 'custom' AND custom_interval_ms IS NULL)),
  CONSTRAINT ${REGENERATION_SCHEDULES_TABLE}_status_allowed
    CHECK (status IN ('active','paused','cancelled')),
  CONSTRAINT ${REGENERATION_SCHEDULES_TABLE}_target_kind_allowed
    CHECK (target_kind IN ('guide','workflow','source-bundle')),
  CONSTRAINT ${REGENERATION_SCHEDULES_TABLE}_run_count_nonnegative
    CHECK (run_count >= 0),
  CONSTRAINT ${REGENERATION_SCHEDULES_TABLE}_max_runs_positive
    CHECK (max_runs IS NULL OR max_runs >= 1),
  CONSTRAINT ${REGENERATION_SCHEDULES_TABLE}_end_after_anchor
    CHECK (end_at IS NULL OR end_at > anchor_at),
  CONSTRAINT ${REGENERATION_SCHEDULES_TABLE}_next_due_requires_active
    CHECK (status = 'active' OR next_due_at IS NULL)
);

-- The worker's sweep: "give me every active schedule whose next_due_at is
-- now or in the past". A partial index keeps the predicate cheap.
CREATE INDEX IF NOT EXISTS ${REGENERATION_SCHEDULES_TABLE}_due_idx
  ON ${REGENERATION_SCHEDULES_TABLE} (next_due_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ${REGENERATION_SCHEDULES_TABLE}_workspace_target_idx
  ON ${REGENERATION_SCHEDULES_TABLE} (workspace_id, target_kind, target_id);

CREATE INDEX IF NOT EXISTS ${REGENERATION_SCHEDULES_TABLE}_status_idx
  ON ${REGENERATION_SCHEDULES_TABLE} (workspace_id, status, next_due_at);

DROP TRIGGER IF EXISTS trg_${REGENERATION_SCHEDULES_TABLE}_updated_at ON ${REGENERATION_SCHEDULES_TABLE};
CREATE TRIGGER trg_${REGENERATION_SCHEDULES_TABLE}_updated_at
  BEFORE UPDATE ON ${REGENERATION_SCHEDULES_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();
`;

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function readCadence(v: unknown): ScheduleCadence {
  return v === "hourly" || v === "daily" || v === "weekly" || v === "monthly" || v === "custom"
    ? v
    : "daily";
}

function readStatus(v: unknown): ScheduleStatus {
  return v === "paused" || v === "cancelled" ? v : "active";
}

function readTargetKind(v: unknown): RegenerationSchedule["targetKind"] {
  return v === "workflow" || v === "source-bundle" ? v : "guide";
}

function normaliseDayOfWeek(v: unknown): readonly number[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<number>();
  for (const item of v) {
    const n = typeof item === "number" ? item : typeof item === "string" ? Number(item) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      throw new ScheduleError(
        `dayOfWeek entries must be integers in [0, 6]; received ${String(item)}.`,
        "invalid-input",
        { value: item },
      );
    }
    seen.add(n);
  }
  return Object.freeze([...seen].sort((a, b) => a - b));
}

function normaliseScope(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return Object.freeze(out);
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function integerOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return fallback;
}

function integerOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                        */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  intervalFor,
  findFirstAllowed,
  nextDueMs,
  DAY_MS,
  normaliseDayOfWeek,
  normaliseScope,
  readCadence,
  readStatus,
  readTargetKind,
});
