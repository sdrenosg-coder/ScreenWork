/**
 * Zipy AI — session establishment, verification and teardown.
 *
 * Phase 1 deliverable. The signup and login routes call `establishSession`,
 * and every authenticated API route / server component calls `getSession` or
 * `requireSession` to obtain the caller's identity + active workspace.
 *
 * Design notes:
 *  - Sessions are DB-backed (table `sessions` from `packages/db/src/schema/users.ts`).
 *  - The cookie carries an opaque random token; only its SHA-256 hash is stored.
 *  - The cookie itself is signed (HMAC-SHA256, key derived from
 *    `SESSION_SECRET`) so a token that never existed short-circuits before a
 *    database round-trip — this is a cheap filter, not the authority.
 *  - Expiry, revocation and a "last seen" touch are all persisted so logout,
 *    forced revocation and admin sweeps work without a session store.
 *  - The active workspace is persisted on the row (`sessions.active_workspace_id`).
 *    The switcher route (a later phase) rewrites this column; every reader here
 *    re-derives the caller's role in that workspace on each request so a role
 *    demotion takes effect immediately.
 *  - Absence of `SESSION_SECRET` or `DATABASE_URL` throws a descriptive error
 *    instead of issuing a throwaway secret, matching the platform rule.
 *
 * Cookie attributes read from central config:
 *  - name      = config.auth.cookieName
 *  - secure    = config.auth.cookieSecure (true in production)
 *  - path      = "/"
 *  - httpOnly  = true
 *  - sameSite  = "lax"
 *  - maxAge    = config.auth.sessionTtlSeconds
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { createRequire } from "node:module";

import { getConfig } from "@/lib/config";
import type { WorkspaceRole } from "@zipy/db/schema/workspaces";
import { isWorkspaceRole } from "@zipy/db/schema/workspaces";

const require = createRequire(import.meta.url);

/* -------------------------------------------------------------------------- */
/* Postgres access (lazy, single pooled client per call)                       */
/* -------------------------------------------------------------------------- */

type PoolNode = {
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[] }>;
  connect: () => Promise<PoolClientNode>;
  end: () => Promise<void>;
};
type PoolClientNode = {
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: unknown[] }>;
  release: () => void;
};
type PoolCtorNode = new (opts: {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean } | false;
  max?: number;
}) => PoolNode;

function requirePoolCtor(): PoolCtorNode {
  try {
    const mod = require("pg") as { Pool: PoolCtorNode };
    return mod.Pool;
  } catch {
    throw new Error(
      "Zipy AI session: the `pg` package is not installed. Run `npm install` at the repository root.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

export interface EstablishedSession {
  /** Raw token placed in the cookie. Never persisted in plaintext. */
  readonly token: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId: string | null;
  readonly expiresAt: Date;
  /** Attach the session cookie (and matching clear-cookie helper) to a response. */
  readonly applyCookie: (response: CookieTarget) => void;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly activeWorkspaceId: string | null;
  /** Caller's role in the active workspace, re-derived each request. */
  readonly workspaceRole: WorkspaceRole | null;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
}

/** Anything with a mutable `headers` collection that accepts `append`. */
export interface CookieTarget {
  headers: {
    append: (name: string, value: string) => void;
  };
}

/* -------------------------------------------------------------------------- */
/* Cookie helpers                                                              */
/* -------------------------------------------------------------------------- */

function cookieValueFor(token: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(token).digest("base64url");
  return `${token}.${sig}`;
}

/**
 * Verify the cookie's HMAC signature. Returns the raw token on success or
 * `null` when the value is absent/malformed/forged. This is a fast filter only;
 * the DB row remains the authority on revocation/expiry.
 */
export function readSessionToken(cookieValue: string | null, secret: string): string | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0 || dot === cookieValue.length - 1) return null;
  const token = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  if (token.length < 32 || sig.length < 16) return null;
  const expected = createHmac("sha256", secret).update(token).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? token : null;
}

function buildCookieHeader(opts: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
}): string {
  const parts = [
    `${opts.name}=${opts.value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

function buildClearCookieHeader(opts: { name: string; secure: boolean }): string {
  const parts = [
    `${opts.name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/* -------------------------------------------------------------------------- */
/* Session establishment                                                       */
/* -------------------------------------------------------------------------- */

export interface EstablishSessionInput {
  readonly userId: string;
  readonly workspaceId: string | null;
  readonly userAgent?: string | null;
  readonly ipAddress?: string | null;
}

/**
 * Create a session row and return a helper that attaches the signed cookie to
 * a response. Throws when required configuration is missing — callers surface
 * that as `config_error` to the client instead of issuing an unsigned cookie.
 */
export async function establishSession(
  input: EstablishSessionInput,
): Promise<EstablishedSession> {
  const config = getConfig();

  if (!config.auth.sessionSecretConfigured || config.auth.sessionSecret === null) {
    throw new Error(
      "Zipy AI session: SESSION_SECRET is not configured. Refusing to establish a session.",
    );
  }
  if (!config.database.configured || config.database.url === null) {
    throw new Error(
      "Zipy AI session: DATABASE_URL is not configured. Refusing to establish a session.",
    );
  }

  const secret = config.auth.sessionSecret;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const csrfToken = randomBytes(24).toString("base64url");
  const csrfHash = createHash("sha256").update(csrfToken).digest("hex");
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlSeconds * 1000);

  const Pool = requirePoolCtor();
  const pool = new Pool({
    connectionString: config.database.url,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    max: 1,
  });

  try {
    const result = await pool.query(
      `INSERT INTO sessions
         (user_id, token_hash, csrf_hash, user_agent, ip_address, expires_at, active_workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.userId,
        tokenHash,
        csrfHash,
        input.userAgent ?? null,
        input.ipAddress ?? null,
        expiresAt,
        input.workspaceId,
      ],
    );
    const sessionId = (result.rows[0] as { id: string }).id;

    const cookieHeaderValue = cookieValueFor(token, secret);
    const secure = config.auth.cookieSecure;

    return {
      token,
      sessionId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      expiresAt,
      applyCookie(response: CookieTarget): void {
        response.headers.append(
          "Set-Cookie",
          buildCookieHeader({
            name: config.auth.cookieName,
            value: cookieHeaderValue,
            maxAgeSeconds: config.auth.sessionTtlSeconds,
            secure,
          }),
        );
      },
    };
  } finally {
    await pool.end();
  }
}

/** Attach a cookie that clears the session cookie on a response. */
export function clearSessionCookie(response: CookieTarget): void {
  const config = getConfig();
  response.headers.append(
    "Set-Cookie",
    buildClearCookieHeader({
      name: config.auth.cookieName,
      secure: config.auth.cookieSecure,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Session verification                                                        */
/* -------------------------------------------------------------------------- */

export interface LoadSessionInput {
  /** Raw `Cookie` header value from the request. */
  readonly cookieHeader: string | null;
  /** Optional: touch `sessions.last_seen_at` (defaults to true). */
  readonly touch?: boolean;
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const segment of cookieHeader.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name.length === 0) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Resolve the caller's session from a raw `Cookie` header. Returns null when
 * the cookie is missing/invalid, the row is revoked or the row has expired.
 * Re-derives the caller's workspace role each call so RBAC changes take effect
 * without waiting for a token refresh.
 */
export async function loadSession(
  input: LoadSessionInput,
): Promise<SessionRecord | null> {
  const config = getConfig();
  if (!config.auth.sessionSecretConfigured || config.auth.sessionSecret === null) {
    return null;
  }
  if (!config.database.configured || config.database.url === null) {
    return null;
  }

  const cookies = parseCookies(input.cookieHeader);
  const raw = cookies[config.auth.cookieName] ?? null;
  const token = readSessionToken(raw, config.auth.sessionSecret);
  if (token === null) return null;

  const tokenHash = createHash("sha256").update(token).digest("hex");

  const Pool = requirePoolCtor();
  const pool = new Pool({
    connectionString: config.database.url,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    max: 1,
  });

  try {
    const result = await pool.query(
      `SELECT s.id                AS session_id,
              s.user_id           AS user_id,
              s.active_workspace_id AS active_workspace_id,
              s.expires_at        AS expires_at,
              s.last_seen_at      AS last_seen_at,
              u.disabled_at       AS user_disabled_at,
              u.deleted_at        AS user_deleted_at,
              m.role              AS workspace_role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
    LEFT JOIN workspace_members m
           ON m.user_id = s.user_id
          AND m.workspace_id = s.active_workspace_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > NOW()
        LIMIT 1`,
      [tokenHash],
    );

    const row = result.rows[0] as
      | {
          session_id: string;
          user_id: string;
          active_workspace_id: string | null;
          expires_at: Date;
          last_seen_at: Date;
          user_disabled_at: Date | null;
          user_deleted_at: Date | null;
          workspace_role: string | null;
        }
      | undefined;

    if (!row) return null;
    if (row.user_disabled_at !== null || row.user_deleted_at !== null) {
      // Session exists but the principal is no longer usable; revoke and stop.
      await pool.query(
        `UPDATE sessions
            SET revoked_at = NOW(), revoked_reason = 'principal_disabled'
          WHERE id = $1 AND revoked_at IS NULL`,
        [row.session_id],
      );
      return null;
    }

    if (input.touch !== false) {
      // Fire-and-forget: best-effort activity marker. We await so the pooled
      // connection closes cleanly; failure here does not invalidate the session.
      try {
        await pool.query(
          `UPDATE sessions SET last_seen_at = NOW() WHERE id = $1`,
          [row.session_id],
        );
      } catch {
        /* ignore — non-fatal */
      }
    }

    const workspaceRole: WorkspaceRole | null =
      isWorkspaceRole(row.workspace_role) ? row.workspace_role : null;

    return {
      sessionId: row.session_id,
      userId: row.user_id,
      activeWorkspaceId: row.active_workspace_id,
      workspaceRole,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
    };
  } finally {
    await pool.end();
  }
}

/** Thrown by `requireSession` when the caller has no usable session. */
export class UnauthenticatedError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/** Convenience wrapper that throws instead of returning null. */
export async function requireSession(
  input: LoadSessionInput,
): Promise<SessionRecord> {
  const session = await loadSession(input);
  if (session === null) throw new UnauthenticatedError();
  return session;
}

/* -------------------------------------------------------------------------- */
/* Revocation                                                                  */
/* -------------------------------------------------------------------------- */

export interface RevokeSessionInput {
  readonly sessionId: string;
  readonly reason: string;
}

/** Revoke a single session row by ID. Returns true when a row was updated. */
export async function revokeSession(input: RevokeSessionInput): Promise<boolean> {
  const config = getConfig();
  if (!config.database.configured || config.database.url === null) {
    throw new Error(
      "Zipy AI session: DATABASE_URL is not configured. Cannot revoke session.",
    );
  }

  const Pool = requirePoolCtor();
  const pool = new Pool({
    connectionString: config.database.url,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    max: 1,
  });
  try {
    const result = await pool.query(
      `UPDATE sessions
          SET revoked_at = NOW(),
              revoked_reason = $2
        WHERE id = $1
          AND revoked_at IS NULL
        RETURNING id`,
      [input.sessionId, input.reason],
    );
    return result.rows.length > 0;
  } finally {
    await pool.end();
  }
}

/**
 * Log the caller out: revoke the current session row (if any) and emit a
 * clear-cookie header on the response.
 */
export async function destroyCurrentSession(
  input: LoadSessionInput,
  response: CookieTarget,
): Promise<void> {
  const session = await loadSession({ ...input, touch: false });
  if (session !== null) {
    await revokeSession({ sessionId: session.sessionId, reason: "logout" });
  }
  clearSessionCookie(response);
}
