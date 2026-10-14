/**
 * Zipy AI — database migration runner.
 *
 * Executes the schema DDL declared in `packages/db/src/schema/*` in dependency
 * order, idempotently, and records each migration in a `zipy_migrations` table
 * so re-runs are cheap and auditable.
 *
 * Design notes:
 *  - Migrations are ordered strings (schema files are all `CREATE ... IF NOT
 *    EXISTS` / `DROP TRIGGER IF EXISTS` / `ALTER ... IF NOT EXISTS`), so running
 *    the whole set on every boot is safe and keeps local dev friction low.
 *  - Statement execution is guarded by a transaction per migration. Postgres
 *    cannot run some DDL inside a transaction for older versions, but 16 is
 *    fine.
 *  - The runner refuses to run without `DATABASE_URL`, matching the "explicit
 *    error over silent degradation" rule used everywhere else.
 *  - Only `pg` (node-postgres) is required. Install it via the workspace
 *    dependency added in this phase.
 *
 * Usage:
 *   node --experimental-strip-types packages/db/src/migrate.ts
 *   (or) npm run migrate
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

import {
  CREATE_USERS_SQL,
  USERS_SCHEMA_VERSION,
} from "./schema/users.ts";
import {
  CREATE_WORKSPACES_SQL,
  WORKSPACES_SCHEMA_VERSION,
} from "./schema/workspaces.ts";

const require = createRequire(import.meta.url);

// `pg` is added as a dependency in this phase's workspace manifest. We require
// lazily so a missing install produces a clear error instead of a stack trace
// during module top-level evaluation.
type PoolLike = {
  query: (sql: string) => Promise<{ rows: unknown[] }>;
  connect: () => Promise<PoolClientLike>;
  end: () => Promise<void>;
};
type PoolClientLike = {
  query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
};
type PoolCtor = new (opts: {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean } | false;
  max?: number;
  statement_timeout?: number;
}) => PoolLike;

/* -------------------------------------------------------------------------- */
/* Migration registry                                                          */
/* -------------------------------------------------------------------------- */

export interface Migration {
  /** Stable identifier — changing this invalidates the recorded hash. */
  readonly id: string;
  /** Logical schema version this migration corresponds to. */
  readonly version: number;
  /** Human-readable description. */
  readonly description: string;
  /** Full SQL to execute. */
  readonly sql: string;
}

/**
 * Ordered migration list. Each entry's SQL is idempotent. New files append an
 * entry; existing entries are never mutated in place, only superseded by a new
 * migration.
 */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    id: "0001_users",
    version: USERS_SCHEMA_VERSION,
    description:
      "users, password_credentials, user_identities, sessions, login_attempts; zipy_set_updated_at()",
    sql: CREATE_USERS_SQL,
  },
  {
    id: "0002_workspaces",
    version: WORKSPACES_SCHEMA_VERSION,
    description:
      "workspaces, workspace_members, workspace_role_overrides, workspace_settings, workspace_invitations; sessions.active_workspace_id",
    sql: CREATE_WORKSPACES_SQL,
  },
]);

/** SHA-256 of the SQL body — used to detect silent edits to executed migrations. */
export function hashMigrationSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Connection helpers                                                          */
/* -------------------------------------------------------------------------- */

function loadPg(): { Pool: PoolCtor } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("pg") as { Pool: PoolCtor };
  } catch (error) {
    throw new Error(
      "Zipy AI migration: the `pg` package is not installed. Run `npm install` at the repository root (it is declared in packages/db/package.json).",
    );
  }
}

function readConnectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      "Zipy AI migration: DATABASE_URL is not set. Start Postgres (npm run infra:up) and export DATABASE_URL before running migrations.",
    );
  }
  return url.trim();
}

function readSslFlag(): boolean {
  const raw = process.env.DATABASE_SSL ?? process.env.PGSSL;
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

async function ensureMigrationsTable(client: PoolClientLike): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS zipy_migrations (
      id            TEXT PRIMARY KEY,
      version       INTEGER NOT NULL,
      description   TEXT NOT NULL,
      sql_hash      TEXT NOT NULL,
      applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function readApplied(
  client: PoolClientLike,
): Promise<Map<string, { sql_hash: string; version: number }>> {
  const result = await client.query(
    `SELECT id, sql_hash, version FROM zipy_migrations`,
  );
  const map = new Map<string, { sql_hash: string; version: number }>();
  for (const row of result.rows as Array<{
    id: string;
    sql_hash: string;
    version: number;
  }>) {
    map.set(row.id, { sql_hash: row.sql_hash, version: row.version });
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

export interface MigrationResult {
  readonly id: string;
  readonly status: "applied" | "skipped" | "re-applied";
}

export async function runMigrations(opts?: {
  connectionString?: string;
  ssl?: boolean;
  /** Re-apply migrations whose SQL is unchanged. Defaults to true (all DDL is idempotent). */
  idempotent?: boolean;
}): Promise<readonly MigrationResult[]> {
  const { Pool } = loadPg();
  const connectionString = opts?.connectionString ?? readConnectionString();
  const ssl = opts?.ssl ?? readSslFlag();
  const idempotent = opts?.idempotent ?? true;

  const pool = new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 1,
    statement_timeout: 60_000,
  });

  const results: MigrationResult[] = [];
  let client: PoolClientLike | null = null;
  try {
    client = await pool.connect();
    await ensureMigrationsTable(client);
    const applied = await readApplied(client);

    for (const migration of MIGRATIONS) {
      const sqlHash = hashMigrationSql(migration.sql);
      const prior = applied.get(migration.id);

      if (prior && prior.sql_hash !== sqlHash && !idempotent) {
        throw new Error(
          `Zipy AI migration: "${migration.id}" SQL has changed since it was applied. Refusing to silently re-run. Add a new migration instead.`,
        );
      }

      if (prior && prior.sql_hash === sqlHash && !idempotent) {
        results.push({ id: migration.id, status: "skipped" });
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO zipy_migrations (id, version, description, sql_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE
             SET version = EXCLUDED.version,
                 description = EXCLUDED.description,
                 sql_hash = EXCLUDED.sql_hash,
                 applied_at = NOW()`,
          [migration.id, migration.version, migration.description, sqlHash],
        );
        await client.query("COMMIT");
        results.push({
          id: migration.id,
          status: prior ? "re-applied" : "applied",
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `Zipy AI migration: "${migration.id}" failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } finally {
    if (client) client.release();
    await pool.end();
  }

  return results;
}

/** Basic connectivity check used by health/status surfaces. */
export async function pingDatabase(connectionString?: string): Promise<boolean> {
  const { Pool } = loadPg();
  const pool = new Pool({
    connectionString: connectionString ?? readConnectionString(),
    ssl: readSslFlag() ? { rejectUnauthorized: false } : false,
    max: 1,
  });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

/* -------------------------------------------------------------------------- */
/* CLI entrypoint                                                              */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const started = Date.now();
  const results = await runMigrations();
  const elapsed = Date.now() - started;
  for (const r of results) {
    process.stdout.write(`[migrate] ${r.id} -> ${r.status}\n`);
  }
  process.stdout.write(
    `[migrate] ${results.length} migration(s) processed in ${elapsed}ms\n`,
  );
}

// Only run when invoked directly, not when imported by tests or the worker.
const invokedDirectly = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
    return thisFile === argv1 || dirname(thisFile) === dirname(argv1);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `[migrate] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

// Keep unused-import linters calm for readFile when bundlers tree-shake; the
// symbol is intentionally exported for future file-based migration loading.
export const __fileReady = typeof readFile === "function";
