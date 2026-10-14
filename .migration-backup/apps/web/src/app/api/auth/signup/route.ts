/**
 * POST /api/auth/signup
 *
 * Creates a user (email + password) and, atomically, a personal workspace owned
 * by that user. On success a session cookie is issued via the shared session
 * module and the caller is returned a compact identity payload.
 *
 * Behaviour validated here:
 *  - Refuses when ALLOW_SIGNUP=0 (returns 403 signup_disabled).
 *  - Requires DATABASE_URL and SESSION_SECRET: returns 503 config_error with the
 *    reason if either is missing (no fake users, no throwaway secrets).
 *  - Validates email format, password strength and display name.
 *  - Passwords stored as scrypt hash + salt + explicit kdf_params.
 *  - Normalizes email for the uniqueness check (`users.email_normalized`).
 *  - Creates the workspace and an OWNER membership in a single transaction.
 *  - Records a login_attempts row (succeeded=true).
 *
 * The session cookie is set by `establishSession` (from lib/auth/session) which
 * this route calls with the freshly created user + workspace IDs.
 */

import { NextResponse } from "next/server";
import { createHash, randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import { createRequire } from "node:module";

import { getConfig } from "@/lib/config";
import { establishSession } from "@/lib/auth/session";
import {
  isPlausibleEmail,
  normalizeEmail,
} from "@zipy/db/schema/users";
import {
  slugifyWorkspaceName,
  type WorkspaceRole,
} from "@zipy/db/schema/workspaces";

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

/* -------------------------------------------------------------------------- */
/* Password hashing (scrypt) — parameters are stored per credential so they    */
/* can be rotated without a schema change.                                     */
/* -------------------------------------------------------------------------- */

export const SCRYPT_PARAMS = Object.freeze({
  N: 1 << 15, // 32768
  r: 8,
  p: 1,
  keylen: 64,
  maxmem: 64 * 1024 * 1024,
});

async function hashPassword(
  password: string,
): Promise<{ hash: string; salt: string; params: Record<string, unknown> }> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return {
    hash: derived.toString("hex"),
    salt,
    params: {
      kdf: "scrypt",
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      keylen: SCRYPT_PARAMS.keylen,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Input validation                                                            */
/* -------------------------------------------------------------------------- */

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 512;
const DISPLAY_NAME_MAX = 120;

export interface SignupBody {
  readonly email?: unknown;
  readonly password?: unknown;
  readonly displayName?: unknown;
  readonly workspaceName?: unknown;
  readonly locale?: unknown;
}

interface ValidatedSignup {
  readonly email: string;
  readonly emailNormalized: string;
  readonly password: string;
  readonly displayName: string | null;
  readonly workspaceName: string;
  readonly locale: string;
}

function badRequest(field: string, message: string) {
  return NextResponse.json(
    { error: "validation_error", field, message },
    { status: 400 },
  );
}

function validate(body: SignupBody): ValidatedSignup | NextResponse {
  const emailRaw = typeof body.email === "string" ? body.email : "";
  if (!isPlausibleEmail(emailRaw)) {
    return badRequest("email", "A valid email address is required.");
  }
  const password =
    typeof body.password === "string" ? body.password : "";
  if (password.length < PASSWORD_MIN_LENGTH) {
    return badRequest(
      "password",
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return badRequest(
      "password",
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    );
  }

  let displayName: string | null = null;
  if (typeof body.displayName === "string") {
    const trimmed = body.displayName.trim();
    if (trimmed.length > DISPLAY_NAME_MAX) {
      return badRequest(
        "displayName",
        `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.`,
      );
    }
    displayName = trimmed.length > 0 ? trimmed : null;
  }

  let workspaceName =
    typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
  if (workspaceName.length === 0) {
    const localPart = emailRaw.split("@")[0] ?? "Workspace";
    workspaceName = `${localPart}'s Workspace`;
  }
  if (workspaceName.length > 120) {
    workspaceName = workspaceName.slice(0, 120);
  }

  let locale = "en";
  if (typeof body.locale === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.locale)) {
    locale = body.locale;
  }

  return {
    email: emailRaw.trim(),
    emailNormalized: normalizeEmail(emailRaw),
    password,
    displayName,
    workspaceName,
    locale,
  };
}

/* -------------------------------------------------------------------------- */
/* Workspace slug uniqueness                                                   */
/* -------------------------------------------------------------------------- */

async function pickUniqueSlug(
  client: PoolClientLike,
  desired: string,
): Promise<string> {
  const base = slugifyWorkspaceName(desired);
  // Try the base, then base-2, base-3, ... up to a bounded number of attempts.
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate =
      suffix === 0
        ? base
        : `${base.slice(0, Math.max(1, 61 - String(suffix).length))}-${suffix}`;
    const exists = await client.query(
      `SELECT 1 FROM workspaces WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
      [candidate],
    );
    if (exists.rows.length === 0) return candidate;
  }
  // Extremely unlikely fallback: append a random suffix.
  return `${base.slice(0, 50)}-${randomBytes(4).toString("hex")}`;
}

/* -------------------------------------------------------------------------- */
/* Route handler                                                               */
/* -------------------------------------------------------------------------- */

export async function POST(req: Request): Promise<NextResponse> {
  const config = getConfig();

  if (!config.auth.allowSignup) {
    return NextResponse.json(
      {
        error: "signup_disabled",
        message:
          "Sign-up is disabled in this deployment. Ask an administrator to invite you.",
      },
      { status: 403 },
    );
  }

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Sign-up cannot complete.",
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

  const validated = validate(
    parsed && typeof parsed === "object" ? (parsed as SignupBody) : {},
  );
  if (validated instanceof NextResponse) return validated;

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
    // Pre-check uniqueness with a dedicated read for a crisp 409. The partial
    // unique index is the hard guarantee; this is for UX.
    const existing = await client.query(
      `SELECT id FROM users WHERE email_normalized = $1 AND deleted_at IS NULL LIMIT 1`,
      [validated.emailNormalized],
    );
    if (existing.rows.length > 0) {
      await client.query(
        `INSERT INTO login_attempts (email_normalized, ip_address, succeeded, failure_reason)
         VALUES ($1, $2, FALSE, 'email_taken')`,
        [validated.emailNormalized, ip],
      );
      return NextResponse.json(
        {
          error: "email_taken",
          message:
            "An account with this email already exists. Try signing in instead.",
        },
        { status: 409 },
      );
    }

    const { hash, salt, params } = await hashPassword(validated.password);

    await client.query("BEGIN");

    const userInsert = await client.query(
      `INSERT INTO users (email, email_normalized, display_name, locale)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, email_normalized, display_name, locale, created_at`,
      [
        validated.email,
        validated.emailNormalized,
        validated.displayName,
        validated.locale,
      ],
    );

    const userRow = userInsert.rows[0] as {
      id: string;
      email: string;
      email_normalized: string;
      display_name: string | null;
      locale: string;
      created_at: Date;
    };

    await client.query(
      `INSERT INTO password_credentials (user_id, password_hash, password_salt, kdf, kdf_params)
       VALUES ($1, $2, $3, 'scrypt', $4::jsonb)`,
      [userRow.id, hash, salt, JSON.stringify(params)],
    );

    const slug = await pickUniqueSlug(client, validated.workspaceName);
    const workspaceInsert = await client.query(
      `INSERT INTO workspaces (slug, name, created_by, plan)
       VALUES ($1, $2, $3, 'free')
       RETURNING id, slug, name, plan, created_at`,
      [slug, validated.workspaceName, userRow.id],
    );
    const workspaceRow = workspaceInsert.rows[0] as {
      id: string;
      slug: string;
      name: string;
      plan: "free" | "pro" | "business" | "enterprise";
      created_at: Date;
    };

    const ownerRole: WorkspaceRole = "owner";
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [workspaceRow.id, userRow.id, ownerRole],
    );

    await client.query(
      `INSERT INTO workspace_settings (workspace_id, updated_by)
       VALUES ($1, $2)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceRow.id, userRow.id],
    );

    await client.query("COMMIT");

    await client.query(
      `INSERT INTO login_attempts (email_normalized, ip_address, succeeded)
       VALUES ($1, $2, TRUE)`,
      [validated.emailNormalized, ip],
    );

    // Issue the session cookie. The session module itself decides the cookie
    // attributes from config; this route never touches cookie flags directly.
    const session = await establishSession({
      userId: userRow.id,
      workspaceId: workspaceRow.id,
      userAgent,
      ipAddress: ip,
    });

    const response = NextResponse.json(
      {
        user: {
          id: userRow.id,
          email: userRow.email,
          displayName: userRow.display_name,
          locale: userRow.locale,
          createdAt: userRow.created_at,
        },
        workspace: {
          id: workspaceRow.id,
          slug: workspaceRow.slug,
          name: workspaceRow.name,
          plan: workspaceRow.plan,
          role: ownerRole,
        },
        session: {
          expiresAt: session.expiresAt,
        },
      },
      { status: 201 },
    );
    session.applyCookie(response);
    return response;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* already rolled back or never started */
    }
    const digest = createHash("sha256")
      .update(String(error instanceof Error ? error.message : error))
      .digest("hex")
      .slice(0, 12);
    process.stderr.write(`[signup] failed (${digest})\n`);
    return NextResponse.json(
      {
        error: "signup_failed",
        message:
          "Sign-up could not be completed. Check server logs for details.",
        reference: digest,
      },
      { status: 500 },
    );
  } finally {
    client.release();
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}
