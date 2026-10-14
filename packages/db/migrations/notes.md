<!--
  Not a migration file. This directory intentionally has no new DDL for this
  batch. The conflicts route reads existing tables:

    - artifacts(id, workspace_id, kind, payload, created_at)
    - jobs(id, workspace_id, kind, status, error_message,
           idempotency_key, result_artifact_id, created_at, updated_at)

  Add a `result_artifact_id` column to `jobs` in the phase that introduces
  the fusion job kinds if it is not already present. See
  packages/jobs/src/queue.ts for the authoritative jobs DDL.
-->
