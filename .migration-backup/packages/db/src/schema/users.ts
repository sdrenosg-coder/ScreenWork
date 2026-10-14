/**
 * Zipy AI — users, sessions and identity-provider links.
 *
 * Baseline schema for Phase 1. Tables are declared as raw SQL DDL strings; the
 * migration runner introduced in the next batch (`packages/db/src/migrate.ts`)
 * will execute them in order against Postgres (pgvector-enabled).
 *
 * Design notes:
 *  - IDs are UUID v4 strings generated server-side (no reliance on a DB
 *    extension this schema does not create itself).
 *  - Passwords are only stored as a scrypt hash + salt with explicit params so
 *    PBKDF params can be rotated without a schema change.
 *  - External identities (Google, GitHub, SAML) live in `user_identities` so a
 *    single user can carry multiple login methods.
 *  - Sessions are DB-backed with a SHA-256 hash of the cookie token stored
 *    (never the raw token). Session rotation and revocation are supported.
 *  - All timestamps are `timestamptz`. Deletion is soft via `deleted_at` so
 *    GDPR/CCPA erase flows can be audited before physical purge.
 */

export const USERS_TABLE = "users" as const;
export const USER_IDENTITIES_TABLE = "user_identities" as const;
export const PASSWORD_CREDENTIALS_TABLE = "password_credentials" as const;
export const SESSIONS_TABLE = "sessions" as const;
export const LOGIN_ATTEMPTS_TABLE = "login_attempts" as const;

/** Schema version this file corresponds to. Incremented by the migration runner. */
export const USERS_SCHEMA_VERSION = 1 as const;

export const CREATE_USERS_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT NOT NULL,
  email_normalized      TEXT NOT NULL,
  display_name          TEXT,
  avatar_url            TEXT,
  locale                TEXT NOT NULL DEFAULT 'en',
  timezone              TEXT NOT NULL DEFAULT 'UTC',
  is_platform_admin     BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified_at     TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  disabled_at           TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${USERS_TABLE}_email_nonempty CHECK (length(btrim(email)) > 3)
);

-- Case-insensitive uniqueness on the normalized form; the raw email preserves
-- the user's original casing for display.
CREATE UNIQUE INDEX IF NOT EXISTS ${USERS_TABLE}_email_normalized_uq
  ON ${USERS_TABLE} (email_normalized)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ${USERS_TABLE}_created_at_idx
  ON ${USERS_TABLE} (created_at DESC);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${PASSWORD_CREDENTIALS_TABLE} (
  user_id               UUID PRIMARY KEY REFERENCES ${USERS_TABLE}(id) ON DELETE CASCADE,
  password_hash         TEXT NOT NULL,
  password_salt         TEXT NOT NULL,
  kdf                   TEXT NOT NULL DEFAULT 'scrypt',
  kdf_params            JSONB NOT NULL,
  must_rotate           BOOLEAN NOT NULL DEFAULT FALSE,
  last_rotated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${USER_IDENTITIES_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES ${USERS_TABLE}(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  provider_account_id   TEXT NOT NULL,
  -- Per-identity email as asserted by the IdP; informational only.
  provider_email        TEXT,
  profile               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${USER_IDENTITIES_TABLE}_provider_allowed
    CHECK (provider IN ('google','github','saml')),
  CONSTRAINT ${USER_IDENTITIES_TABLE}_provider_account_nonempty
    CHECK (length(btrim(provider_account_id)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ${USER_IDENTITIES_TABLE}_provider_account_uq
  ON ${USER_IDENTITIES_TABLE} (provider, provider_account_id);

CREATE INDEX IF NOT EXISTS ${USER_IDENTITIES_TABLE}_user_id_idx
  ON ${USER_IDENTITIES_TABLE} (user_id);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES ${USERS_TABLE}(id) ON DELETE CASCADE,
  -- SHA-256 (hex) of the opaque session token placed in the cookie.
  token_hash            TEXT NOT NULL,
  -- Rotated on privilege change; stored as a hash for the same reason.
  csrf_hash             TEXT,
  user_agent            TEXT,
  ip_address            INET,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  revoked_reason        TEXT,
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Optional FK constraint to the active workspace at login is added in the
  -- workspaces migration (schema ordering: users -> workspaces -> memberships).
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ${SESSIONS_TABLE}_token_hash_uq
  ON ${SESSIONS_TABLE} (token_hash);

CREATE INDEX IF NOT EXISTS ${SESSIONS_TABLE}_user_active_idx
  ON ${SESSIONS_TABLE} (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS ${SESSIONS_TABLE}_expires_at_idx
  ON ${SESSIONS_TABLE} (expires_at);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${LOGIN_ATTEMPTS_TABLE} (
  id                    BIGSERIAL PRIMARY KEY,
  email_normalized      TEXT,
  ip_address            INET,
  succeeded             BOOLEAN NOT NULL,
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ${LOGIN_ATTEMPTS_TABLE}_email_created_idx
  ON ${LOGIN_ATTEMPTS_TABLE} (email_normalized, created_at DESC);

CREATE INDEX IF NOT EXISTS ${LOGIN_ATTEMPTS_TABLE}_ip_created_idx
  ON ${LOGIN_ATTEMPTS_TABLE} (ip_address, created_at DESC);

-- `updated_at` triggers ---------------------------------------------------

CREATE OR REPLACE FUNCTION zipy_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_${USERS_TABLE}_updated_at ON ${USERS_TABLE};
CREATE TRIGGER trg_${USERS_TABLE}_updated_at
  BEFORE UPDATE ON ${USERS_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();

DROP TRIGGER IF EXISTS trg_${PASSWORD_CREDENTIALS_TABLE}_updated_at ON ${PASSWORD_CREDENTIALS_TABLE};
CREATE TRIGGER trg_${PASSWORD_CREDENTIALS_TABLE}_updated_at
  BEFORE UPDATE ON ${PASSWORD_CREDENTIALS_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();

DROP TRIGGER IF EXISTS trg_${USER_IDENTITIES_TABLE}_updated_at ON ${USER_IDENTITIES_TABLE};
CREATE TRIGGER trg_${USER_IDENTITIES_TABLE}_updated_at
  BEFORE UPDATE ON ${USER_IDENTITIES_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();
`;

/** TypeScript-side shape of a `users` row. */
export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly email_normalized: string;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly is_platform_admin: boolean;
  readonly email_verified_at: Date | null;
  readonly last_login_at: Date | null;
  readonly disabled_at: Date | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface PasswordCredentialRow {
  readonly user_id: string;
  readonly password_hash: string;
  readonly password_salt: string;
  readonly kdf: string;
  readonly kdf_params: Record<string, unknown>;
  readonly must_rotate: boolean;
  readonly last_rotated_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface UserIdentityRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider: "google" | "github" | "saml";
  readonly provider_account_id: string;
  readonly provider_email: string | null;
  readonly profile: Record<string, unknown>;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly token_hash: string;
  readonly csrf_hash: string | null;
  readonly user_agent: string | null;
  readonly ip_address: string | null;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_reason: string | null;
  readonly last_seen_at: Date;
  readonly created_at: Date;
}

export interface LoginAttemptRow {
  readonly id: string;
  readonly email_normalized: string | null;
  readonly ip_address: string | null;
  readonly succeeded: boolean;
  readonly failure_reason: string | null;
  readonly created_at: Date;
}

/** Normalize an email for case-insensitive storage and lookups. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Minimal shape guard for an email string; identity is proven by verification, not this regex. */
export function isPlausibleEmail(email: string): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return false;
  if (trimmed.indexOf("@", at + 1) !== -1) return false;
  if (!trimmed.includes(".")) return false;
  return !/\s/.test(trimmed);
}
