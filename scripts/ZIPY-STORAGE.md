# Zipy guide storage

`STORAGE_DRIVER=app-storage` selects the existing private Replit bucket. It does
not replace PostgreSQL. Workspace keys and authorization stay unchanged.
The cloud driver never falls back to local files when a cloud operation fails.

## Safe local-to-cloud migration

1. Stop the API, processing worker, and any tests/scripts which write guide data.
2. From `scripts/`, run `pnpm run migrate:zipy-storage` for a local inventory.
3. Run `pnpm run migrate:zipy-storage --apply`.
   - The default source is `artifacts/api-server/.data/objects`.
   - Override with `--root=/absolute/path` if the configured local root differs.
   - Destination writes are create-only. Identical existing objects are verified;
     different objects abort the migration rather than being overwritten.
   - Every record is downloaded and SHA-256 checked, then downloaded and checked
     again through a new storage client. The local inventory is also checked for
     concurrent changes.
   - A private migration receipt records the verified inventory.
   - A timeout or error is **not** permission to switch. Re-run safely or inspect
     the conflict. Originals are never deleted.
4. Only after a successful result, set `STORAGE_DRIVER=app-storage` through the
   workspace environment settings and restart the API and worker.
5. Exercise guide editing, settings, publication and the anonymous reader.
   Restart services, then verify the saved records and published snapshot again.

## Development and production

Records are isolated under `zipy-platform/development/objects` and
`zipy-platform/production/objects` inside the private directory. `NODE_ENV`
selects the scope; both the production API and production worker must use
`NODE_ENV=production`. Raw source uploads keep their existing private media
paths; no media rewrite is needed.

Migrating development records does **not** migrate a published installation.
For an existing production installation, capture its own local inventory during
an approved maintenance window and run the migration with `NODE_ENV=production`
and its actual local root before switching that installation. Do not copy a
development inventory into production by accident. For a first publication,
decide explicitly whether existing development guides should be seeded into
production and verify they correspond to the production workspace identities.

Local originals are retained for recovery, not used as a live mirror. After
cloud writes begin, switching back to the old local directory would lose those
new writes. Recovery must export and verify the current cloud inventory first.

A development restart or a fresh-client test is not proof of published-runtime
restart behavior. That check still needs an actual approved publication.

## Remaining hardening

- SDK stream reads currently emit `MaxListenersExceededWarning` for PassThrough
  error/close listeners even though verified reads succeed. Diagnose cleanup and
  retry behavior; raising listener limits or hiding warnings is not a fix.
- Guide list filtering still scans cloud records. The 253-guide regression
  passed, but list requests took 14–29 seconds. A durable, tenant-scoped index
  with reliable write synchronization/backfill is needed for large libraries.
- These limitations do not invalidate the verified copy, but the migration is
  not a complete production-readiness sign-off.
