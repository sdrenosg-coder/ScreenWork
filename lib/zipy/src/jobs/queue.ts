/**
 * Zipy AI — durable job queue.
 *
 * A Postgres-backed queue with a Redis-optional fast path. Postgres is the
 * source of truth so a single workspace deployment needs no external service;
 * Redis, when configured, is used only to wake sleeping workers sooner (the
 * polling loop still has a bounded fallback).
 *
 * Design notes:
 *  - Jobs are workspace-scoped. The `workspace_id` column exists so RBAC and
 *    retention sweeps can filter without a join.
 *  - Exactly-once *delivery* is impossible without a broker that stores
 *    consumer offsets; this queue instead guarantees at-least-once delivery
 *    with a `job_runs` history table and a "claim via UPDATE ... RETURNING"
 *    primitive so a crashed worker's lock expires (see `lock_ttl_ms`) and the
 *    job becomes available again.
 *  - Idempotency: every enqueue carries a caller-supplied `idempotency_key`
 *    (or a hash of its inputs). Re-enqueuing with the same key inside the
 *    pending/active window is a no-op and returns the existing job id.
 *  - This module only speaks to Postgres in this batch. The Redis hint is
 *    added in a later phase via `hintWake` (declared but a no-op here) so the
 *    runner's contract stays stable.
 *  - No credentials are invented. Missing DATABASE_URL throws
 *    `QueueConfigError` at call time rather than silently no-op'ing.
 */

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class QueueConfigError extends Error {
  readonly missing: readonly string[];
  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = "QueueConfigError";
    this.missing = missing;
  }
}

export class JobNotFoundError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = "JobNotFoundError";
    this.jobId = jobId;
  }
}

/* -------------------------------------------------------------------------- */
/* Job kinds                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Canonical job kinds. Every producer in the codebase must use one of these
 * strings; later phases append new entries and gate them behind the same
 * runner contract. The suffix convention is `<phase>:<action>`.
 */
export const JOB_KINDS = [
  "ingest:url",
  "ingest:text",
  "ingest:image",
  "ingest:pdf",
  "ingest:docx",
  "ingest:pptx",
  "ingest:audio",
  "ingest:video",
  "ingest:combine",
  "processing:extract",
  "processing:canonical",
  "fusion:embed",
  "fusion:reconcile",
  "synth:workflow",
  "automation:run",
  "capture:screenshot",
  "capture:redact",
  "annotate:render",
  "content:generate",
  "content:translate",
  "export:pdf",
  "export:html",
  "export:markdown",
  "export:docx",
  "export:image-pack",
  "webhooks:dispatch",
  "retention:sweep",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: unknown): value is JobKind {
  return (
    typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Job state machine                                                           */
/* -------------------------------------------------------------------------- */

export const JOB_STATUSES = [
  "pending",   // ready to be claimed
  "active",    // claimed by a worker, lock held
  "succeeded", // terminal: completed
  "failed",    // terminal: attempts exhausted
  "cancelled", // terminal: cancelled by user/admin
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly priority: number;
  /** Arbitrary JSON payload validated by the handler, never by the queue. */
  readonly payload: Record<string, unknown>;
  /** Idempotency key scoped to (workspace_id, kind). */
  readonly idempotency_key: string;
  readonly attempts: number;
  readonly max_attempts: number;
  /** ISO timestamp at which the job becomes eligible for a retry. */
  readonly available_at: Date;
  /** Worker that holds the current claim (null when not claimed). */
  readonly locked_by: string | null;
  readonly locked_at: Date | null;
  readonly lock_expires_at: Date | null;
  readonly last_error: string | null;
  readonly result: Record<string, unknown> | null;
  /** Caller-supplied correlation id, useful for tracing across services. */
  readonly correlation_id: string | null;
  readonly enqueued_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly finished_at: Date | null;
}

/* -------------------------------------------------------------------------- */
/* Enqueue contract                                                            */
/* -------------------------------------------------------------------------- */

export interface EnqueueInput {
  readonly workspaceId: string;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  /**
   * Idempotency key. Optional; when omitted, one is derived by hashing the
   * (kind, payload) pair. Callers who need a distinct enqueue of the same body
   * should pass an explicit key.
   */
  readonly idempotencyKey?: string;
  /** Higher runs first. Defaults to 0. Range is clamped to [-1000, 1000]. */
  readonly priority?: number;
  /** Max attempts before the job terminal-fails. Defaults from config. */
  readonly maxAttempts?: number;
  /** Delay before the job becomes claimable. Millis. Defaults to 0. */
  readonly delayMs?: number;
  readonly correlationId?: string | null;
  readonly enqueuedBy?: string | null;
}

export interface EnqueueResult {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  /** True when this call created a new row; false when an existing row matched. */
  readonly created: boolean;
}

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

interface QueueInternals {
  readonly connectionString: string;
  readonly ssl: boolean;
  readonly pollIntervalMs: number;
  readonly lockTtlMs: number;
  readonly maxAttempts: number;
}

function readQueueConfig(): QueueInternals {
  const raw = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? null;
  if (raw === null || raw.trim().length === 0) {
    throw new QueueConfigError(
      "Job queue requires DATABASE_URL (or POSTGRES_URL). Nothing was enqueued.",
      ["DATABASE_URL"],
    );
  }
  const sslRaw = process.env.DATABASE_SSL ?? process.env.PGSSL ?? "";
  const ssl = ["1", "true", "yes", "on"].includes(sslRaw.toLowerCase());
  const poll = Number(process.env.JOBS_POLL_INTERVAL_MS ?? "1000");
  const lockTtl = Number(process.env.JOBS_LOCK_TTL_MS ?? String(5 * 60_000));
  const maxAttempts = Number(process.env.JOBS_MAX_ATTEMPTS ?? "3");
  return {
    connectionString: raw.trim(),
    ssl,
    pollIntervalMs: Number.isFinite(poll) && poll > 0 ? poll : 1000,
    lockTtlMs: Number.isFinite(lockTtl) && lockTtl > 0 ? lockTtl : 5 * 60_000,
    maxAttempts:
      Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 3,
  };
}

/* -------------------------------------------------------------------------- */
/* Postgres client abstraction (lazy, no `pg` type dependency)                 */
/* -------------------------------------------------------------------------- */

type PgPool = {
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
  connect: () => Promise<PgClient>;
  end: () => Promise<void>;
};
type PgClient = {
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release: () => void;
};
type PoolCtor = new (opts: {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean } | false;
  max?: number;
  idleTimeoutMillis?: number;
}) => PgPool;

function requirePoolCtor(): PoolCtor {
  try {
    const mod = require("pg") as { Pool: PoolCtor };
    return mod.Pool;
  } catch {
    throw new QueueConfigError(
      "Job queue requires the `pg` package. Run `npm install` at the repository root.",
      ["pg"],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Pool lifecycle                                                              */
/* -------------------------------------------------------------------------- */

let cachedPool: PgPool | null = null;
let cachedConfig: QueueInternals | null = null;

/**
 * Process-wide pooled connection. Long-lived because the worker polls; route
 * handlers should call `enqueueJob` which uses the same pool rather than
 * opening a per-call connection.
 */
function getPool(): PgPool {
  if (cachedPool !== null) return cachedPool;
  const config = readQueueConfig();
  const Pool = requirePoolCtor();
  cachedPool = new Pool({
    connectionString: config.connectionString,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  cachedConfig = config;
  return cachedPool;
}

/** Close the pool (used by tests and graceful shutdown). */
export async function closeQueue(): Promise<void> {
  if (cachedPool !== null) {
    const pool = cachedPool;
    cachedPool = null;
    cachedConfig = null;
    try {
      await pool.end();
    } catch {
      /* best effort */
    }
  }
}

/** Read the current session's queue config. Throws if DATABASE_URL is absent. */
export function queueConfig(): QueueInternals {
  if (cachedConfig !== null) return cachedConfig;
  cachedConfig = readQueueConfig();
  return cachedConfig;
}

/* -------------------------------------------------------------------------- */
/* Idempotency key derivation                                                  */
/* -------------------------------------------------------------------------- */

/** Deterministic hash of the enqueue inputs used when no key is supplied. */
export function deriveIdempotencyKey(
  workspaceId: string,
  kind: JobKind,
  payload: unknown,
): string {
  const canonical = stableStringify({
    workspaceId,
    kind,
    payload: payload ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Stable JSON stringifier: object keys are sorted recursively so equivalent
 * payloads produce the same key regardless of insertion order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/* -------------------------------------------------------------------------- */
/* Enqueue                                                                     */
/* -------------------------------------------------------------------------- */

export async function enqueueJob(input: EnqueueInput): Promise<EnqueueResult> {
  if (!isJobKind(input.kind)) {
    throw new QueueConfigError(`Unknown job kind: ${String(input.kind)}`, []);
  }
  if (!input.workspaceId || typeof input.workspaceId !== "string") {
    throw new QueueConfigError("enqueueJob requires a workspaceId.", []);
  }
  const payload = input.payload ?? {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QueueConfigError(
      "enqueueJob payload must be a JSON object.",
      [],
    );
  }

  const config = queueConfig();
  const pool = getPool();
  const idempotencyKey =
    input.idempotencyKey ??
    deriveIdempotencyKey(input.workspaceId, input.kind, payload);
  const priority = clamp(input.priority ?? 0, -1000, 1000);
  const maxAttempts = input.maxAttempts ?? config.maxAttempts;
  const delayMs = Math.max(0, Math.floor(input.delayMs ?? 0));
  const correlationId = input.correlationId ?? null;
  const enqueuedBy = input.enqueuedBy ?? null;

  // Single-statement upsert with a "partial" unique index on
  // (workspace_id, kind, idempotency_key) filtered to non-terminal states.
  // A terminal row with the same key does NOT block a fresh enqueue — the
  // user may legitimately want to re-run a completed job with unchanged input.
  const sql = `
    INSERT INTO jobs (
      workspace_id, kind, status, priority, payload, idempotency_key,
      attempts, max_attempts, available_at, correlation_id, enqueued_by
    )
    VALUES (
      $1, $2, 'pending', $3, $4::jsonb, $5, 0, $6,
      NOW() + ($7::int * INTERVAL '1 millisecond'), $8, $9
    )
    ON CONFLICT (workspace_id, kind, idempotency_key)
      WHERE status IN ('pending','active')
    DO NOTHING
    RETURNING id, status
  `;

  const inserted = await pool.query(sql, [
    input.workspaceId,
    input.kind,
    priority,
    JSON.stringify(payload),
    idempotencyKey,
    maxAttempts,
    delayMs,
    correlationId,
    enqueuedBy,
  ]);

  if (inserted.rows.length > 0) {
    const row = inserted.rows[0] as { id: string; status: JobStatus };
    return { jobId: row.id, kind: input.kind, status: row.status, created: true };
  }

  // A row exists in a non-terminal state; return its id so callers can poll.
  const existing = await pool.query(
    `SELECT id, status FROM jobs
      WHERE workspace_id = $1 AND kind = $2 AND idempotency_key = $3
        AND status IN ('pending','active')
      LIMIT 1`,
    [input.workspaceId, input.kind, idempotencyKey],
  );
  if (existing.rows.length === 0) {
    // Race: the other transaction committed then the job moved terminal
    // between the INSERT and this SELECT. Retry once.
    return enqueueJob({ ...input, idempotencyKey });
  }
  const row = existing.rows[0] as { id: string; status: JobStatus };
  return { jobId: row.id, kind: input.kind, status: row.status, created: false };
}

/** Cancel a job if it has not already run. Returns true when a row was updated. */
export async function cancelJob(
  workspaceId: string,
  jobId: string,
  reason: string,
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE jobs
        SET status = 'cancelled',
            finished_at = NOW(),
            last_error = $3
      WHERE id = $1 AND workspace_id = $2
        AND status IN ('pending','active')
      RETURNING id`,
    [jobId, workspaceId, reason.slice(0, 2000)],
  );
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/* Claim                                                                       */
/* -------------------------------------------------------------------------- */

export interface ClaimInput {
  /** Stable identifier of the caller, e.g. `worker:hostname:pid`. */
  readonly workerId: string;
  /**
   * Restrict to specific kinds. Empty/absent means "any kind".
   */
  readonly kinds?: readonly JobKind[];
  /**
   * Restrict to a specific workspace. Absent means "any workspace". Workers
   * normally leave this unset; tests use it to avoid claiming unrelated jobs.
   */
  readonly workspaceId?: string;
}

/**
 * Attempt to atomically claim the next eligible job.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so multiple workers can claim concurrently
 * without contending. The bulk of the "is this eligible" predicate is in the
 * WHERE clause so a lock is only taken on rows that will be updated.
 *
 * Returns null when nothing is available.
 */
export async function claimJob(input: ClaimInput): Promise<JobRow | null> {
  const config = queueConfig();
  const pool = getPool();

  const kindFilter =
    input.kinds && input.kinds.length > 0 ? input.kinds : null;
  const workspaceFilter = input.workspaceId ?? null;

  const sql = `
    WITH next_job AS (
      SELECT id
        FROM jobs
       WHERE status = 'pending'
         AND available_at <= NOW()
         AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
         AND ($3::uuid IS NULL OR workspace_id = $3::uuid)
       ORDER BY priority DESC, available_at ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs j
       SET status = 'active',
           attempts = j.attempts + 1,
           locked_by = $1,
           locked_at = NOW(),
           lock_expires_at = NOW() + ($4::int * INTERVAL '1 millisecond')
      FROM next_job
     WHERE j.id = next_job.id
     RETURNING j.*;
  `;

  const result = await pool.query(sql, [
    input.workerId,
    kindFilter,
    workspaceFilter,
    config.lockTtlMs,
  ]);
  if (result.rows.length === 0) return null;
  return normalizeJobRow(result.rows[0]);
}

/**
 * Reclaim jobs whose lock expired before the worker finished. Called by the
 * runner on startup and periodically to guarantee forward progress when a
 * worker crashed mid-job. Returns the number of rows reclaimed.
 */
export async function reclaimExpired(now: Date = new Date()): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE jobs
        SET status = 'pending',
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            available_at = $1
      WHERE status = 'active'
        AND lock_expires_at IS NOT NULL
        AND lock_expires_at < $1
      RETURNING id`,
    [now],
  );
  return result.rowCount ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Complete / fail / heartbeat                                                 */
/* -------------------------------------------------------------------------- */

export interface CompleteInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly result?: Record<string, unknown>;
}

export async function completeJob(input: CompleteInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE jobs
        SET status = 'succeeded',
            finished_at = NOW(),
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            last_error = NULL,
            result = $3::jsonb
      WHERE id = $1 AND workspace_id = $2
        AND status = 'active'`,
    [input.jobId, input.workspaceId, JSON.stringify(input.result ?? {})],
  );
}

export interface FailInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly error: string;
  /**
   * When true, forces a terminal failure regardless of remaining attempts.
   * Used for non-retryable errors (bad input, missing config).
   */
  readonly terminal?: boolean;
}

/**
 * Mark a job failed. When attempts remain, reschedules with exponential
 * backoff (base * 2^(attempts-1), clamped to 30 minutes). Terminal failures
 * set finished_at and leave last_error for admin views.
 */
export async function failJob(input: FailInput): Promise<void> {
  const pool = getPool();
  const config = queueConfig();
  const backoffBaseRaw = Number(process.env.JOBS_BACKOFF_BASE_MS ?? "5000");
  const backoffBase =
    Number.isFinite(backoffBaseRaw) && backoffBaseRaw > 0 ? backoffBaseRaw : 5000;

  const lookup = await pool.query(
    `SELECT attempts, max_attempts FROM jobs
      WHERE id = $1 AND workspace_id = $2 AND status = 'active'
      LIMIT 1`,
    [input.jobId, input.workspaceId],
  );
  if (lookup.rows.length === 0) return;
  const { attempts, max_attempts } = lookup.rows[0] as {
    attempts: number;
    max_attempts: number;
  };

  const exhausted = attempts >= max_attempts;
  const terminal = Boolean(input.terminal) || exhausted;
  const errorMessage = input.error.slice(0, 4000);

  if (terminal) {
    await pool.query(
      `UPDATE jobs
          SET status = 'failed',
              finished_at = NOW(),
              locked_by = NULL,
              locked_at = NULL,
              lock_expires_at = NULL,
              last_error = $3
        WHERE id = $1 AND workspace_id = $2`,
      [input.jobId, input.workspaceId, errorMessage],
    );
    return;
  }

  const delayMs = Math.min(
    backoffBase * 2 ** Math.max(0, attempts - 1),
    30 * 60_000,
  );
  await pool.query(
    `UPDATE jobs
        SET status = 'pending',
            available_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
            locked_by = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            last_error = $4
      WHERE id = $1 AND workspace_id = $2`,
    [input.jobId, input.workspaceId, Math.floor(delayMs), errorMessage],
  );
}

/**
 * Extend the current claim's lock. A long-running browser-automation job can
 * call this between steps to keep ownership without re-claiming.
 */
export async function heartbeat(
  workspaceId: string,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const config = queueConfig();
  const pool = getPool();
  const result = await pool.query(
    `UPDATE jobs
        SET lock_expires_at = NOW() + ($4::int * INTERVAL '1 millisecond'),
            locked_at = NOW()
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'active'
        AND locked_by = $3
      RETURNING id`,
    [jobId, workspaceId, workerId, config.lockTtlMs],
  );
  return (result.rowCount ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/* Inspection                                                                  */
/* -------------------------------------------------------------------------- */

export async function getJob(
  workspaceId: string,
  jobId: string,
): Promise<JobRow | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM jobs WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [jobId, workspaceId],
  );
  if (result.rows.length === 0) return null;
  return normalizeJobRow(result.rows[0]);
}

export interface ListJobsInput {
  readonly workspaceId: string;
  readonly kind?: JobKind;
  readonly status?: JobStatus;
  readonly limit?: number;
}

export async function listJobs(input: ListJobsInput): Promise<readonly JobRow[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(1, input.limit ?? 50), 500);
  const result = await pool.query(
    `SELECT * FROM jobs
      WHERE workspace_id = $1
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC
      LIMIT $4`,
    [input.workspaceId, input.kind ?? null, input.status ?? null, limit],
  );
  return result.rows.map(normalizeJobRow);
}

/**
 * Sleep helper used by the runner's poll loop. Intentionally does not throw on
 * unmount; callers supply an AbortSignal for graceful shutdown.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wake hook for the Redis fast path. In this batch Redis polling is not yet
 * implemented; the runner polls at `pollIntervalMs` instead. Exposed so the
 * runner's contract does not change when the Redis hint lands.
 */
export async function hintWake(_jobKind: JobKind): Promise<void> {
  await Promise.resolve();
  return;
}

/* -------------------------------------------------------------------------- */
/* Row normalisation                                                           */
/* -------------------------------------------------------------------------- */

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.floor(n), lo), hi);
}

function normalizeJobRow(raw: unknown): JobRow {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r["id"]),
    workspace_id: String(r["workspace_id"]),
    kind: r["kind"] as JobKind,
    status: r["status"] as JobStatus,
    priority: Number(r["priority"] ?? 0),
    payload: (r["payload"] as Record<string, unknown>) ?? {},
    idempotency_key: String(r["idempotency_key"]),
    attempts: Number(r["attempts"] ?? 0),
    max_attempts: Number(r["max_attempts"] ?? 3),
    available_at: toDate(r["available_at"]),
    locked_by: (r["locked_by"] as string | null) ?? null,
    locked_at:
      r["locked_at"] === null || r["locked_at"] === undefined
        ? null
        : toDate(r["locked_at"]),
    lock_expires_at:
      r["lock_expires_at"] === null || r["lock_expires_at"] === undefined
        ? null
        : toDate(r["lock_expires_at"]),
    last_error: (r["last_error"] as string | null) ?? null,
    result: (r["result"] as Record<string, unknown> | null) ?? null,
    correlation_id: (r["correlation_id"] as string | null) ?? null,
    enqueued_by: (r["enqueued_by"] as string | null) ?? null,
    created_at: toDate(r["created_at"]),
    updated_at: toDate(r["updated_at"]),
    finished_at:
      r["finished_at"] === null || r["finished_at"] === undefined
        ? null
        : toDate(r["finished_at"]),
  };
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") return new Date(v);
  return new Date();
}

/* -------------------------------------------------------------------------- */
/* Worker id helper                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build a stable-but-unique worker identifier from the hostname and process
 * id. Used as the `locked_by` value; when two workers share a hostname the
 * pid disambiguates.
 */
export function defaultWorkerId(): string {
  const hostname =
    process.env.HOSTNAME ?? process.env.REPL_ID ?? "zipy-worker";
  return `worker:${hostname}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/* -------------------------------------------------------------------------- */
/* Schema DDL (declared here so the DB bootstrap can register it in one place) */
/* -------------------------------------------------------------------------- */

export const JOBS_TABLE = "jobs" as const;
export const JOBS_SCHEMA_VERSION = 1 as const;

export const CREATE_JOBS_SQL = `
CREATE TABLE IF NOT EXISTS ${JOBS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  priority              INTEGER NOT NULL DEFAULT 0,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key       TEXT NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 3,
  available_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by             TEXT,
  locked_at             TIMESTAMPTZ,
  lock_expires_at       TIMESTAMPTZ,
  last_error            TEXT,
  result                JSONB,
  correlation_id        TEXT,
  enqueued_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at           TIMESTAMPTZ,
  CONSTRAINT ${JOBS_TABLE}_status_allowed
    CHECK (status IN ('pending','active','succeeded','failed','cancelled')),
  CONSTRAINT ${JOBS_TABLE}_attempts_nonnegative
    CHECK (attempts >= 0),
  CONSTRAINT ${JOBS_TABLE}_max_attempts_positive
    CHECK (max_attempts >= 1),
  CONSTRAINT ${JOBS_TABLE}_priority_range
    CHECK (priority BETWEEN -1000 AND 1000),
  CONSTRAINT ${JOBS_TABLE}_idempotency_key_nonempty
    CHECK (length(btrim(idempotency_key)) > 0 AND length(idempotency_key) <= 128),
  CONSTRAINT ${JOBS_TABLE}_kind_nonempty
    CHECK (length(btrim(kind)) > 0)
);

-- Partial unique index: an idempotency key dedupes only while the job is
-- pending or active. Once terminal, a fresh enqueue with the same key is
-- allowed (callers re-run completed work deliberately).
CREATE UNIQUE INDEX IF NOT EXISTS ${JOBS_TABLE}_idempotency_active_uq
  ON ${JOBS_TABLE} (workspace_id, kind, idempotency_key)
  WHERE status IN ('pending','active');

-- Claim order: priority DESC, available_at, created_at.
CREATE INDEX IF NOT EXISTS ${JOBS_TABLE}_claim_idx
  ON ${JOBS_TABLE} (status, available_at, priority DESC, created_at)
  WHERE status = 'pending';

-- Lock reclaim scan.
CREATE INDEX IF NOT EXISTS ${JOBS_TABLE}_lock_expiry_idx
  ON ${JOBS_TABLE} (lock_expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ${JOBS_TABLE}_workspace_status_idx
  ON ${JOBS_TABLE} (workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ${JOBS_TABLE}_correlation_idx
  ON ${JOBS_TABLE} (correlation_id)
  WHERE correlation_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_${JOBS_TABLE}_updated_at ON ${JOBS_TABLE};
CREATE TRIGGER trg_${JOBS_TABLE}_updated_at
  BEFORE UPDATE ON ${JOBS_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();
`;
