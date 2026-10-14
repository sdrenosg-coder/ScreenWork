/**
 * Zipy AI — workspaces, memberships, role overrides and per-workspace policy.
 *
 * Baseline schema for Phase 1. Roles are workspace-scoped; a user's effective
 * role is the membership role, optionally narrowed by `workspace_role_overrides`
 * (used later for fine-grained, resource-scoped grants). Role strings here are
 * the canonical source of truth used by the RBAC layer (`apps/web/src/lib/rbac`).
 *
 * Design notes:
 *  - `workspaces` is soft-deleted (`deleted_at`) for a grace period before
 *    physical purge to support GDPR/CCPA erase auditing.
 *  - `workspace_members` is a hard join table with a unique (workspace_id,
 *    user_id) pair; role changes write both the membership row and an audit
 *    event (audit infrastructure ships in a later phase).
 *  - `workspace_settings` is a 1:1 JSONB policy bag for tone defaults,
 *    retention, branding pointers, allowed LLM providers, DNT glossaries, etc.
 *    Only fields with clearly-stated semantics are given dedicated columns;
 *    everything else lives in JSONB keyed by documented names.
 *  - `workspace_invitations` supports both email invites and shareable links.
 */

export const WORKSPACES_TABLE = "workspaces" as const;
export const WORKSPACE_MEMBERS_TABLE = "workspace_members" as const;
export const WORKSPACE_ROLE_OVERRIDES_TABLE = "workspace_role_overrides" as const;
export const WORKSPACE_SETTINGS_TABLE = "workspace_settings" as const;
export const WORKSPACE_INVITATIONS_TABLE = "workspace_invitations" as const;

export const WORKSPACES_SCHEMA_VERSION = 1 as const;

/**
 * Canonical workspace roles, in ascending privilege order. Consumers compare
 * against this list; adding a role requires an RBAC change and a migration.
 */
export const WORKSPACE_ROLES = [
  "viewer",
  "commenter",
  "editor",
  "approver",
  "admin",
  "owner",
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Numeric weight for privilege comparison — higher wins. */
export const ROLE_WEIGHT: Readonly<Record<WorkspaceRole, number>> = Object.freeze(
  WORKSPACE_ROLES.reduce<Record<WorkspaceRole, number>>((acc, role, idx) => {
    acc[role] = idx;
    return acc;
  }, {} as Record<WorkspaceRole, number>),
);

/** True when `candidate` has at least the privilege of `required`. */
export function roleSatisfies(
  candidate: WorkspaceRole,
  required: WorkspaceRole,
): boolean {
  return ROLE_WEIGHT[candidate] >= ROLE_WEIGHT[required];
}

export const CREATE_WORKSPACES_SQL = `
CREATE TABLE IF NOT EXISTS ${WORKSPACES_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  plan                  TEXT NOT NULL DEFAULT 'free',
  -- Region hint for on-prem/regional deployments; informational.
  region                TEXT NOT NULL DEFAULT 'default',
  -- Optional pointer to a custom publishing domain (used in the publishing phase).
  custom_domain         TEXT,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${WORKSPACES_TABLE}_slug_format
    CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  CONSTRAINT ${WORKSPACES_TABLE}_name_nonempty
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT ${WORKSPACES_TABLE}_plan_allowed
    CHECK (plan IN ('free','pro','business','enterprise'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ${WORKSPACES_TABLE}_slug_uq
  ON ${WORKSPACES_TABLE} (slug)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ${WORKSPACES_TABLE}_created_at_idx
  ON ${WORKSPACES_TABLE} (created_at DESC);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${WORKSPACE_MEMBERS_TABLE} (
  workspace_id          UUID NOT NULL REFERENCES ${WORKSPACES_TABLE}(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL,
  invited_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT ${WORKSPACE_MEMBERS_TABLE}_role_allowed
    CHECK (role IN ('viewer','commenter','editor','approver','admin','owner'))
);

CREATE INDEX IF NOT EXISTS ${WORKSPACE_MEMBERS_TABLE}_user_idx
  ON ${WORKSPACE_MEMBERS_TABLE} (user_id);

CREATE INDEX IF NOT EXISTS ${WORKSPACE_MEMBERS_TABLE}_workspace_role_idx
  ON ${WORKSPACE_MEMBERS_TABLE} (workspace_id, role);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${WORKSPACE_ROLE_OVERRIDES_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES ${WORKSPACES_TABLE}(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Resource kinds this override applies to (e.g. 'guide','workflow','export').
  resource_kind         TEXT NOT NULL,
  -- Optional resource ID; NULL means "any resource of this kind in this workspace".
  resource_id           UUID,
  role                  TEXT NOT NULL,
  granted_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${WORKSPACE_ROLE_OVERRIDES_TABLE}_role_allowed
    CHECK (role IN ('viewer','commenter','editor','approver','admin','owner')),
  CONSTRAINT ${WORKSPACE_ROLE_OVERRIDES_TABLE}_kind_nonempty
    CHECK (length(btrim(resource_kind)) > 0)
);

CREATE INDEX IF NOT EXISTS ${WORKSPACE_ROLE_OVERRIDES_TABLE}_lookup_idx
  ON ${WORKSPACE_ROLE_OVERRIDES_TABLE} (workspace_id, user_id, resource_kind);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${WORKSPACE_SETTINGS_TABLE} (
  workspace_id          UUID PRIMARY KEY REFERENCES ${WORKSPACES_TABLE}(id) ON DELETE CASCADE,
  -- Content defaults. All fields are optional; unset fields fall back to the
  -- platform defaults documented in the content/branding phases.
  default_tone          TEXT,
  default_audience      TEXT,
  default_industry      TEXT,
  default_reading_grade NUMERIC(4,2),
  default_locale        TEXT NOT NULL DEFAULT 'en',
  -- Compliance.
  retention_days        INTEGER,
  pii_redaction_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  human_review_required BOOLEAN NOT NULL DEFAULT FALSE,
  -- Free-form, documented bags.
  allowed_llm_providers JSONB NOT NULL DEFAULT '[]'::jsonb,
  do_not_translate      JSONB NOT NULL DEFAULT '[]'::jsonb,
  branding              JSONB NOT NULL DEFAULT '{}'::jsonb,
  snippets              JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${WORKSPACE_SETTINGS_TABLE}_retention_range
    CHECK (retention_days IS NULL OR (retention_days BETWEEN 1 AND 3650))
);

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ${WORKSPACE_INVITATIONS_TABLE} (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES ${WORKSPACES_TABLE}(id) ON DELETE CASCADE,
  invited_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Either an email invite or a shareable link (email NULL + token set).
  email_normalized      TEXT,
  role                  TEXT NOT NULL,
  -- SHA-256 hash of the invitation token; the raw value is only sent to the recipient.
  token_hash            TEXT NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  accepted_at           TIMESTAMPTZ,
  accepted_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ${WORKSPACE_INVITATIONS_TABLE}_role_allowed
    CHECK (role IN ('viewer','commenter','editor','approver','admin','owner')),
  CONSTRAINT ${WORKSPACE_INVITATIONS_TABLE}_token_hash_nonempty
    CHECK (length(token_hash) = 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS ${WORKSPACE_INVITATIONS_TABLE}_token_hash_uq
  ON ${WORKSPACE_INVITATIONS_TABLE} (token_hash);

CREATE INDEX IF NOT EXISTS ${WORKSPACE_INVITATIONS_TABLE}_email_pending_idx
  ON ${WORKSPACE_INVITATIONS_TABLE} (workspace_id, email_normalized)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- `updated_at` triggers ---------------------------------------------------

DROP TRIGGER IF EXISTS trg_${WORKSPACES_TABLE}_updated_at ON ${WORKSPACES_TABLE};
CREATE TRIGGER trg_${WORKSPACES_TABLE}_updated_at
  BEFORE UPDATE ON ${WORKSPACES_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();

DROP TRIGGER IF EXISTS trg_${WORKSPACE_MEMBERS_TABLE}_updated_at ON ${WORKSPACE_MEMBERS_TABLE};
CREATE TRIGGER trg_${WORKSPACE_MEMBERS_TABLE}_updated_at
  BEFORE UPDATE ON ${WORKSPACE_MEMBERS_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();

DROP TRIGGER IF EXISTS trg_${WORKSPACE_SETTINGS_TABLE}_updated_at ON ${WORKSPACE_SETTINGS_TABLE};
CREATE TRIGGER trg_${WORKSPACE_SETTINGS_TABLE}_updated_at
  BEFORE UPDATE ON ${WORKSPACE_SETTINGS_TABLE}
  FOR EACH ROW EXECUTE FUNCTION zipy_set_updated_at();

-- The sessions table from the users migration gains its active-workspace FK
-- now that workspaces exist. Nullable so a session can exist before selecting
-- a workspace.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS active_workspace_id UUID
    REFERENCES ${WORKSPACES_TABLE}(id) ON DELETE SET NULL;
`;

/** TypeScript-side shape of a `workspaces` row. */
export interface WorkspaceRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly created_by: string | null;
  readonly plan: "free" | "pro" | "business" | "enterprise";
  readonly region: string;
  readonly custom_domain: string | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface WorkspaceMemberRow {
  readonly workspace_id: string;
  readonly user_id: string;
  readonly role: WorkspaceRole;
  readonly invited_by: string | null;
  readonly joined_at: Date;
  readonly last_active_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface WorkspaceRoleOverrideRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly resource_kind: string;
  readonly resource_id: string | null;
  readonly role: WorkspaceRole;
  readonly granted_by: string | null;
  readonly expires_at: Date | null;
  readonly created_at: Date;
}

export interface WorkspaceSettingsRow {
  readonly workspace_id: string;
  readonly default_tone: string | null;
  readonly default_audience: string | null;
  readonly default_industry: string | null;
  readonly default_reading_grade: string | null;
  readonly default_locale: string;
  readonly retention_days: number | null;
  readonly pii_redaction_enabled: boolean;
  readonly human_review_required: boolean;
  readonly allowed_llm_providers: readonly string[];
  readonly do_not_translate: readonly string[];
  readonly branding: Record<string, unknown>;
  readonly snippets: Record<string, unknown>;
  readonly updated_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface WorkspaceInvitationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly invited_by: string | null;
  readonly email_normalized: string | null;
  readonly role: WorkspaceRole;
  readonly token_hash: string;
  readonly expires_at: Date;
  readonly accepted_at: Date | null;
  readonly accepted_by: string | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

/** Convert a display name to a URL-safe workspace slug. */
export function slugifyWorkspaceName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return base.length > 0 ? base : "workspace";
}

/** True when the supplied role string is one of the canonical workspace roles. */
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}
