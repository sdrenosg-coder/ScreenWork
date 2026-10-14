/**
 * POST /api/auth/login
 *
 * Verifies email + password against `password_credentials`, records the
 * attempt, and (on success) issues a session and returns the user's workspaces.
 *
 * Behaviour validated here:
 *  - Requires DATABASE_URL + SESSION_SECRET (returns 503 config_error otherwise).
 *  - Constant-ish-time response: always runs one scrypt derivation on miss so a
 *    missing user does not get a distinguishable timing side channel.
 *  - Uses `timingSafeEqual` to compare hashes.
 *  - Records a `login_attempts` row for every call.
 *  - On success, selects the user's first workspace as the active one. The
 *    workspace switcher (a later phase) will let the user change this.
 */

import { NextResponse } from "next/server";
import { scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createRequire } from "node:module";

import { getConfig } from "@/lib/config";
import { establishSession } from "@/lib/auth/session";
import {
  isPlausibleEmail,
  normalizeEmail,
} from "@zipy/db/schema/users";
import type { WorkspaceRole } from "@zipy/db/schema/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const require = createRequire(import.meta.url);
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  opts?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

type PoolLike = {
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[] }>;
  connect: () => Promise<PoolClientLike>;
};
type PoolClientLike = {
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[] }>;
  release: () => void;
};
type PoolCtor = new (opts: {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean } | false;
  max?: number;
}) => PoolLike;

interface KdfParams {
  N?: number;
  r?: number;
  p?: number;
  keylen?: number;
}

async function derive(
  password: string,
  salt: string,
  params: KdfParams,
): Promise<Buffer> {
  const N = Number.isFinite(params.N) ? (params.N as number) : 1 << 15;
  const r = Number.isFinite(params.r) ? (params.r as number) : 8;
  const p = Number.isFinite(params.p) ? (params.p as number) : 1;
  const keylen = Number.isFinite(params.keylen) ? (params.keylen as number) : 64;
  return scrypt(password, salt, keylen, {
    N,
    r,
    p,
    maxmem: 128 * 1024 * 1024,
  });
}

/** A stable dummy salt so lookups that miss still pay one derivation cost. */
const DUMMY_SALT = "00000000000000000000000000000000";

export interface LoginBody {
  readonly email?: unknown;
  readonly password?: unknown;
}

export async function POST(req: Request): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Sign-in cannot complete.",
      },
      { status: 503 },
    );
  }
  if (!config.auth.sessionSecretConfigured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "SESSION_SECRET is not configured on this server. Refusing to issue sessions.",
      },
      { status: 503 },
    );
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const body = (parsed && typeof parsed === "object" ? parsed : {}) as LoginBody;
  const emailRaw = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!isPlausibleEmail(emailRaw) || password.length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        message: "Email and password are required.",
      },
      { status: 400 },
    );
  }

  const emailNormalized = normalizeEmail(emailRaw);

  const { Pool } = require("pg") as { Pool: PoolCtor };
  const pool = new Pool({
    connectionString: config.database.url as string,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    max: config.database.poolMax,
  });

  const client = await pool.connect();
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;
  const userAgent = req.headers.get("user-agent");

  try {
    const lookup = await client.query(
      `SELECT u.id                AS user_id,
              u.email             AS email,
              u.email_normalized  AS email_normalized,
              u.display_name      AS display_name,
              u.locale            AS locale,
              u.disabled_at       AS disabled_at,
              p.password_hash     AS password_hash,
              p.password_salt     AS password_salt,
              p.kdf_params        AS kdf_params
         FROM users u
         LEFT JOIN password_credentials p ON p.user_id = u.id
        WHERE u.email_normalized = $1
          AND u.deleted_at IS NULL
        LIMIT 1`,
      [emailNormalized],
    );

    const row = lookup.rows[0] as
      | {
          user_id: string;
          email: string;
          email_normalized: string;
          display_name: string | null;
          locale: string;
          disabled_at: Date | null;
          password_hash: string | null;
          password_salt: string | null;
          kdf_params: KdfParams | null;
        }
      | undefined;

    // Always derive once. Uses a dummy salt when the user is missing so both
    // paths pay comparable work.
    const expectedHashHex =
      row?.password_hash ?? "0".repeat(64);
    const salt = row?.password_salt ?? DUMMY_SALT;
    const derived = await derive(password, salt, row?.kdf_params ?? {});

    let matches = false;
    try {
      const expected = Buffer.from(expectedHashHex, "hex");
      matches =
        expected.length === derived.length &&
        timingSafeEqual(expected, derived);
    } catch {
      matches = false;
    }

    const reason: string | null = !row
      ? "unknown_email"
      : row.disabled_at
        ? "account_disabled"
        : row.password_hash === null
          ? "no_password"
          : matches
            ? null
            : "bad_password";

    if (reason !== null) {
      await client.query(
        `INSERT INTO login_attempts (email_normalized, ip_address, succeeded, failure_reason)
         VALUES ($1, $2, FALSE, $3)`,
        [emailNormalized, ip, reason],
      );
      return NextResponse.json(
        {
          error: "invalid_credentials",
          message: "Email or password is incorrect.",
        },
        { status: 401 },
      );
    }

    const userId = (row as { user_id: string }).user_id;

    // Pick the most recently joined workspace as the active one.
    const workspaceLookup = await client.query(
      `SELECT w.id AS id, w.slug AS slug, w.name AS name, w.plan AS plan,
              m.role AS role, m.joined_at AS joined_at
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1
          AND w.deleted_at IS NULL
        ORDER BY m.joined_at DESC
        LIMIT 1`,
      [userId],
    );

    const workspaceRow = workspaceLookup.rows[0] as
      | {
          id: string;
          slug: string;
          name: string;
          plan: "free" | "pro" | "business" | "enterprise";
          role: WorkspaceRole;
          joined_at: Date;
        }
      | undefined;

    const session = await establishSession({
      userId,
      workspaceId: workspaceRow?.id ?? null,
      userAgent,
      ipAddress: ip,
    });

    await client.query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
      [userId],
    );
    await client.query(
      `INSERT INTO login_attempts (email_normalized, ip_address, succeeded)
       VALUES ($1, $2, TRUE)`,
      [emailNormalized, ip],
    );

    const response = NextResponse.json(
      {
        user: {
          id: userId,
          email: (row as { email: string }).email,
          displayName: (row as { display_name: string | null }).display_name,
          locale: (row as { locale: string }).locale,
        },
        activeWorkspace: workspaceRow
          ? {
              id: workspaceRow.id,
              slug: workspaceRow.slug,
              name: workspaceRow.name,
              plan: workspaceRow.plan,
              role: workspaceRow.role,
            }
          : null,
        session: { expiresAt: session.expiresAt },
      },
      { status: 200 },
    );
    session.applyCookie(response);
    return response;
  } catch (error) {
    process.stderr.write(
      `[login] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return NextResponse.json(
      {
        error: "login_failed",
        message:
          "Sign-in could not be completed. Check server logs for details.",
      },
      { status: 500 },
    );
  } finally {
    client.release();
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}
