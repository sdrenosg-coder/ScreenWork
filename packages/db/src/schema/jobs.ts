/**
 * Zipy AI — jobs schema re-export.
 *
 * The queue module (`@zipy/jobs/queue`) owns the DDL for the `jobs` table
 * because the claim/enqueue SQL and the schema must stay in lockstep. This
 * module exists so the migration runner has a uniform `packages/db/src/schema/*`
 * surface to import, and so downstream code (admin views, retention sweeps)
 * has a single place to import row types from.
 *
 * Nothing here invents new SQL: `CREATE_JOBS_SQL` is re-exported verbatim.
 * Keeping the DDL next to the queue's claim query prevents a drift where a
 * migration alters a column the claim query assumes exists.
 */

export {
  CREATE_JOBS_SQL,
  JOBS_TABLE,
  JOBS_SCHEMA_VERSION,
  JOB_KINDS,
  JOB_STATUSES,
  isJobKind,
  type JobKind,
  type JobStatus,
  type JobRow,
  type EnqueueInput,
  type EnqueueResult,
  type ClaimInput,
  type ListJobsInput,
} from "@zipy/jobs/queue";

/**
 * The migration runner concatenates per-schema DDL strings and executes them in
 * declared order. users -> workspaces -> artifacts -> jobs, because jobs
 * references both workspaces(id) and users(id).
 */
export const JOBS_MIGRATION_ORDER = 40 as const;
