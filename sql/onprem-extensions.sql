-- Zipy AI — extensions the schema depends on.
--
-- The migration runner creates these itself when the application role has
-- CREATE EXTENSION privileges. On a least-privilege host that role cannot,
-- so a superuser runs this once before `npm run migrate`.
--
-- Idempotent: the CREATE EXTENSION IF NOT EXISTS statements are safe to
-- re-run. pgvector is required for the embedding columns; pg_trgm backs the
-- search/index predicates; pgcrypto provides gen_random_uuid() used across
-- the baseline schema.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Sanity check: the extensions must be present in the database the
-- application will use. Uncomment and run interactively to confirm.
-- SELECT extname, extversion FROM pg_extension
--   WHERE extname IN ('vector','pg_trgm','pgcrypto')
--   ORDER BY extname;
