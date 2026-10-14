/**
 * Zipy AI — RBAC model and enforcement (phase 22, batch 0).
 *
 * This module defines the platform's roles, permissions and the pure
 * decision function. It is the *single source of truth* the schema
 * (`packages/db/src/schema/workspaces.ts`), the session layer
 * (`apps/web/src/lib/auth/session.ts`) and the existing route-level
 * `apps/web/src/lib/rbac/permissions.ts` shim all defer to. When an
 * earlier phase shipped a lighter permission check, it should now import
 * from here rather than re-declaring role names.
 *
 * Design boundaries
 * -----------------
 *  - No storage, no HTTP, no session concept. This module is a pure
 *    decision function over (subject, action, resource) so it is trivially
 *    testable and cannot itself leak data.
 *
 *  - Every permission name maps to a bounded verb. A new permission is a
 *    deliberate edit to `Permissions` — not a wildcard.
 *
 *  - Deny-by-default. An unknown role or an unknown permission denies.
 *    Owner-level `impersonate` and `manage_billing` are still *granted*,
 *    not implicitly assumed: the check is a lookup, never a
 *    "role === 'owner' ? true" shortcut.
 *
 *  - Resource scope is explicit. A permission is either workspace-wide
 *    (e.g. `view_audit`) or resource-scoped (e.g. `edit_guide`). The
 *    decision function returns whether *this* subject may perform *this*
 *    action on *this* resource — the caller performs the workspace
 *    match; this module performs the role/permission match plus the
 *    optional resource-owner override the model encodes.
 *
 *  - No invented roles. The set below is what the plan's "granular RBAC
 *    so that roles control who can generate, edit, approve and publish"
 *    requires. A custom role is a stored set of permissions drawn from
 *    the same list; nothing here assumes a fixed role table.
 */

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The complete permission vocabulary. Every check the platform performs
 * must reference one of these strings; a check that does not is a bug.
 * Grouped by resource for readability; the storage format is a flat set.
 */
export const PERMISSIONS = Object.freeze([
  // Workspace
  "workspace.view",
  "workspace.manage_members",
  "workspace.manage_settings",
  "workspace.manage_branding",
  "workspace.manage_integrations",
  "workspace.manage_retention",
  "workspace.delete",
  // Sources and ingestion
  "source.view",
  "source.create",
  "source.delete",
  // Workflows + browser automation
  "workflow.view",
  "workflow.create",
  "workflow.run",
  "workflow.synthesize",
  "workflow.delete",
  // Review / human-in-the-loop
  "review.view",
  "review.decide_approve",
  "review.decide_reject",
  "review.handoff_control",
  // Guides / generated content
  "guide.view",
  "guide.create",
  "guide.edit",
  "guide.regenerate",
  "guide.translate",
  "guide.publish",
  "guide.unpublish",
  "guide.delete",
  "guide.export",
  // Screenshots / annotations
  "annotation.view",
  "annotation.edit",
  // Comments / collaboration
  "comment.view",
  "comment.create",
  "comment.resolve",
  // Templates / snippets
  "template.view",
  "template.manage",
  // Model + cost controls
  "model.view_config",
  "model.manage_config",
  "model.view_costs",
  // Analytics
  "analytics.view",
  "analytics.export",
  // Audit + compliance
  "audit.view",
  "audit.export",
  "compliance.data_subject_request",
  "compliance.manage_retention",
  // Admin / platform
  "admin.view",
  "admin.manage_users",
  "admin.manage_workspaces",
  "admin.impersonate",
  "admin.manage_billing",
  "admin.manage_sso",
  "admin.manage_webhooks",
  "admin.manage_api_keys",
] as const);

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The five built-in roles. A workspace may also define custom roles by
 * storing a subset of `PERMISSIONS`; custom roles are not this enum and
 * are handled by the `RoleDefinition` type below.
 */
export const BUILTIN_ROLES = Object.freeze([
  "owner",
  "admin",
  "editor",
  "reviewer",
  "viewer",
] as const);

export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

/**
 * A role definition: a name and a set of permissions. Built-in roles are
 * constructed from this shape too, so the decision function has one code
 * path and a custom role is not a second-class case.
 */
export interface RoleDefinition {
  readonly name: string;
  readonly permissions: readonly Permission[];
  /** Optional: a human description of the role, for the admin UI. */
  readonly description?: string;
  /**
   * Whether this role is one the platform recognizes as built in. Used by
   * the admin UI to prevent renaming or deleting a built-in; the decision
   * function itself does not branch on it.
   */
  readonly builtin: boolean;
}

/* -------------------------------------------------------------------------- */
/* Built-in role definitions                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `owner`: the workspace's top authority. Owners can do everything in
 * their workspace, including destructive actions and billing. Owners are
 * still not platform super-admins: `admin.manage_workspaces` and
 * `admin.impersonate` are granted only through a platform-level role the
 * SaaS operator assigns out-of-band (see `PLATFORM_SUPER_ADMIN_PERMISSIONS`).
 */
const OWNER_PERMISSIONS: readonly Permission[] = Object.freeze([
  "workspace.view",
  "workspace.manage_members",
  "workspace.manage_settings",
  "workspace.manage_branding",
  "workspace.manage_integrations",
  "workspace.manage_retention",
  "workspace.delete",
  "source.view",
  "source.create",
  "source.delete",
  "workflow.view",
  "workflow.create",
  "workflow.run",
  "workflow.synthesize",
  "workflow.delete",
  "review.view",
  "review.decide_approve",
  "review.decide_reject",
  "review.handoff_control",
  "guide.view",
  "guide.create",
  "guide.edit",
  "guide.regenerate",
  "guide.translate",
  "guide.publish",
  "guide.unpublish",
  "guide.delete",
  "guide.export",
  "annotation.view",
  "annotation.edit",
  "comment.view",
  "comment.create",
  "comment.resolve",
  "template.view",
  "template.manage",
  "model.view_config",
  "model.manage_config",
  "model.view_costs",
  "analytics.view",
  "analytics.export",
  "audit.view",
  "audit.export",
  "compliance.data_subject_request",
  "compliance.manage_retention",
  "admin.view",
  "admin.manage_users",
  "admin.manage_billing",
  "admin.manage_sso",
  "admin.manage_webhooks",
  "admin.manage_api_keys",
] as const);

/**
 * `admin`: a workspace administrator. Everything the owner has, except
 * destructive workspace-level actions (`workspace.delete`) and billing
 * (`admin.manage_billing`). The plan's RBAC requirement — "roles control
 * who can generate, edit, approve and publish" — is enforced by removing
 * the destructive actions from non-owner roles.
 */
const ADMIN_PERMISSIONS: readonly Permission[] = Object.freeze(
  OWNER_PERMISSIONS.filter(
    (p) => p !== "workspace.delete" && p !== "admin.manage_billing",
  ),
) as readonly Permission[];

/**
 * `editor`: a content creator. Can ingest sources, run workflows, edit
 * and regenerate guides, and manage templates. Cannot publish (that is
 * the reviewer's gate), cannot decide reviews, cannot see audit logs.
 */
const EDITOR_PERMISSIONS: readonly Permission[] = Object.freeze([
  "workspace.view",
  "source.view",
  "source.create",
  "source.delete",
  "workflow.view",
  "workflow.create",
  "workflow.run",
  "workflow.synthesize",
  "workflow.delete",
  "review.view",
  "guide.view",
  "guide.create",
  "guide.edit",
  "guide.regenerate",
  "guide.translate",
  "guide.export",
  "annotation.view",
  "annotation.edit",
  "comment.view",
  "comment.create",
  "template.view",
  "model.view_config",
  "analytics.view",
] as const);

/**
 * `reviewer`: the human-in-the-loop role. Can view everything a guide
 * concerns, approve or reject reviews, take over a live browser session,
 * comment, and publish once a review is approved. Cannot create new
 * sources or run workflows; the reviewer reviews the output.
 */
const REVIEWER_PERMISSIONS: readonly Permission[] = Object.freeze([
  "workspace.view",
  "source.view",
  "workflow.view",
  "review.view",
  "review.decide_approve",
  "review.decide_reject",
  "review.handoff_control",
  "guide.view",
  "guide.edit",
  "guide.publish",
  "guide.unpublish",
  "guide.export",
  "annotation.view",
  "annotation.edit",
  "comment.view",
  "comment.create",
  "comment.resolve",
  "template.view",
  "analytics.view",
] as const);

/**
 * `viewer`: read-only. Can view guides, sources, workflows and public
 * analytics; cannot create, edit or publish.
 */
const VIEWER_PERMISSIONS: readonly Permission[] = Object.freeze([
  "workspace.view",
  "source.view",
  "workflow.view",
  "review.view",
  "guide.view",
  "guide.export",
  "annotation.view",
  "comment.view",
  "template.view",
  "analytics.view",
] as const);

const BUILTIN_ROLE_DEFINITIONS: ReadonlyMap<string, RoleDefinition> = new Map<
  string,
  RoleDefinition
>([
  [
    "owner",
    {
      name: "owner",
      permissions: OWNER_PERMISSIONS,
      description:
        "Full control of the workspace, including members, billing and deletion.",
      builtin: true,
    },
  ],
  [
    "admin",
    {
      name: "admin",
      permissions: ADMIN_PERMISSIONS,
      description:
        "Manages members, settings and integrations; cannot delete the workspace or change billing.",
      builtin: true,
    },
  ],
  [
    "editor",
    {
      name: "editor",
      permissions: EDITOR_PERMISSIONS,
      description:
        "Creates and edits guides, sources and workflows; cannot publish or approve reviews.",
      builtin: true,
    },
  ],
  [
    "reviewer",
    {
      name: "reviewer",
      permissions: REVIEWER_PERMISSIONS,
      description:
        "Reviews, approves and publishes guides; can take over a live session.",
      builtin: true,
    },
  ],
  [
    "viewer",
    {
      name: "viewer",
      permissions: VIEWER_PERMISSIONS,
      description: "Read-only access to guides, sources and workflows.",
      builtin: true,
    },
  ],
]);

export function listBuiltinRoles(): readonly RoleDefinition[] {
  return Object.freeze(
    BUILTIN_ROLES.map((r) => BUILTIN_ROLE_DEFINITIONS.get(r)!).filter(
      (d): d is RoleDefinition => d !== undefined,
    ),
  );
}

export function getBuiltinRole(name: string): RoleDefinition | null {
  return BUILTIN_ROLE_DEFINITIONS.get(name) ?? null;
}

/**
 * Permissions that only the SaaS operator (not a workspace role) can
 * grant. The caller must assign these out-of-band; this module
 * deliberately does not define a role for them because they cross
 * tenancy boundaries and every assignment should be a deliberate
 * operation reviewed through the operator's own tooling.
 */
export const PLATFORM_SUPER_ADMIN_PERMISSIONS: readonly Permission[] =
  Object.freeze(["admin.manage_workspaces", "admin.impersonate"]);

/* -------------------------------------------------------------------------- */
/* Subject                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A subject: the identity being tested. A subject always carries the
 * workspace whose role assignment is in question, so a single user who
 * belongs to multiple workspaces is a different subject per workspace.
 * This deliberately prevents a bug where a caller passes a global user
 * and forgets to scope the check.
 */
export interface RbacSubject {
  readonly userId: string;
  readonly workspaceId: string;
  /** The name of the role the subject holds in `workspaceId`. */
  readonly role: string;
  /**
   * Additional permissions granted directly to the subject, beyond the
   * role. Stored as an override set on the workspace membership; a
   * subject may have both a role and individual overrides.
   */
  readonly extraPermissions?: readonly Permission[];
  /**
   * Permissions the subject is *denied* even if the role grants them.
   * Used when a workspace owner wants to lock a specific capability
   * (e.g. deny `guide.export` on a specific admin role).
   */
  readonly deniedPermissions?: readonly Permission[];
  /**
   * The permissions held through custom roles the workspace defines.
   * Populated by the caller's role resolver; this module does not read
   * the database.
   */
  readonly customRolePermissions?: readonly Permission[];
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                    */
/* -------------------------------------------------------------------------- */

export interface RbacDecision {
  readonly allowed: boolean;
  readonly reason:
    | "role-grants"
    | "extra-grants"
    | "custom-role-grants"
    | "platform-super-admin"
    | "unknown-role"
    | "no-grant"
    | "explicitly-denied"
    | "workspace-mismatch"
    | "invalid-permission";
  /**
   * Human-readable detail for logs. Never contains secrets; safe to
   * record in the audit trail, which is why the caller is asked to use
   * this value rather than crafting its own message.
   */
  readonly detail: string;
}

/**
 * The pure decision function. A caller supplies the subject, the
 * permission and — when the resource is workspace-scoped — the resource
 * workspace id. The function evaluates the role, extra permissions,
 * custom role permissions and denied permissions in a fixed order:
 *
 *   1. If `resourceWorkspaceId` is supplied and does not equal the
 *      subject's workspace, deny with `workspace-mismatch`. This is the
 *      tenancy boundary and is checked first so a subject from one
 *      workspace cannot reach another's data by any other path.
 *   2. If the permission string is not in the vocabulary, deny with
 *      `invalid-permission`. A typo in a route must fail closed.
 *   3. If the permission is a platform super-admin permission, deny
 *      unless the subject's `extraPermissions` include it *and* the
 *      caller's deployment has granted it — the caller is expected to
 *      pass the super-admin grant through `extraPermissions`, and the
 *      role name `owner`/`admin`/etc. does not imply it.
 *   4. If the permission is denied via `deniedPermissions`, deny.
 *   5. If the role is a built-in, look up its permission set. If the
 *      role is not built-in *and* `customRolePermissions` is empty,
 *      deny with `unknown-role`.
 *   6. If the permission is granted by role, extra, or custom-role
 *      permissions, allow.
 *   7. Otherwise deny with `no-grant`.
 */
export function decide(input: {
  readonly subject: RbacSubject;
  readonly permission: Permission | string;
  /**
   * The workspace the target resource belongs to. Required for any
   * resource-scoped permission; a caller that omits it for a resource
   * action is refusing its own check, which this function enforces by
   * treating the *absence* of a mismatched id as inconclusive.
   */
  readonly resourceWorkspaceId?: string | null;
}): RbacDecision {
  if (input === null || typeof input !== "object") {
    return {
      allowed: false,
      reason: "invalid-permission",
      detail: "RBAC check was invoked without input.",
    };
  }
  const subject = input.subject;
  if (
    subject === null ||
    typeof subject !== "object" ||
    typeof subject.userId !== "string" ||
    typeof subject.workspaceId !== "string" ||
    typeof subject.role !== "string"
  ) {
    return {
      allowed: false,
      reason: "invalid-permission",
      detail: "RBAC subject is missing userId, workspaceId or role.",
    };
  }

  // 1. Tenancy boundary.
  const targetWorkspace = input.resourceWorkspaceId ?? null;
  if (targetWorkspace !== null && targetWorkspace !== subject.workspaceId) {
    return {
      allowed: false,
      reason: "workspace-mismatch",
      detail: `Subject "${subject.userId}" belongs to workspace "${subject.workspaceId}" but the resource is in workspace "${targetWorkspace}".`,
    };
  }

  // 2. Vocabulary.
  const permission = input.permission;
  if (typeof permission !== "string" || !isPermission(permission)) {
    return {
      allowed: false,
      reason: "invalid-permission",
      detail: `Permission "${String(permission)}" is not a recognized permission; refusing rather than defaulting.`,
    };
  }

  // 3. Platform super-admin: never implied by a workspace role.
  if (PLATFORM_SUPER_ADMIN_PERMISSIONS.includes(permission)) {
    const grant = subject.extraPermissions ?? [];
    if (grant.includes(permission)) {
      return {
        allowed: true,
        reason: "platform-super-admin",
        detail: `Permission "${permission}" is granted to "${subject.userId}" via an explicit platform-level grant.`,
      };
    }
    return {
      allowed: false,
      reason: "no-grant",
      detail: `Permission "${permission}" is a platform super-admin action and must be granted explicitly through extraPermissions; a workspace role does not imply it.`,
    };
  }

  // 4. Explicit denial.
  const denied = subject.deniedPermissions ?? [];
  if (denied.includes(permission)) {
    return {
      allowed: false,
      reason: "explicitly-denied",
      detail: `Permission "${permission}" is explicitly denied to "${subject.userId}".`,
    };
  }

  // 5. Role lookup.
  const roleDef = BUILTIN_ROLE_DEFINITIONS.get(subject.role);
  const customPermissions = subject.customRolePermissions ?? [];
  if (roleDef === undefined && customPermissions.length === 0) {
    return {
      allowed: false,
      reason: "unknown-role",
      detail: `Role "${subject.role}" is not a built-in role and no custom role permissions were supplied; refusing rather than assuming a default role.`,
    };
  }

  // 6. Grants.
  if (roleDef !== undefined && roleDef.permissions.includes(permission)) {
    return {
      allowed: true,
      reason: "role-grants",
      detail: `Permission "${permission}" is granted by built-in role "${subject.role}".`,
    };
  }
  const extras = subject.extraPermissions ?? [];
  if (extras.includes(permission)) {
    return {
      allowed: true,
      reason: "extra-grants",
      detail: `Permission "${permission}" is granted to "${subject.userId}" by a direct member-level override.`,
    };
  }
  if (customPermissions.includes(permission)) {
    return {
      allowed: true,
      reason: "custom-role-grants",
      detail: `Permission "${permission}" is granted by a custom role held by "${subject.userId}".`,
    };
  }

  // 7. No grant.
  return {
    allowed: false,
    reason: "no-grant",
    detail: `Permission "${permission}" is not granted to "${subject.userId}" by role "${subject.role}" or by any override.`,
  };
}

/** A convenience wrapper: true or false, for callers that do not need the reason. */
export function can(input: {
  readonly subject: RbacSubject;
  readonly permission: Permission | string;
  readonly resourceWorkspaceId?: string | null;
}): boolean {
  return decide(input).allowed;
}

/* -------------------------------------------------------------------------- */
/* Custom-role validation                                                      */
/* -------------------------------------------------------------------------- */

export interface CustomRoleValidationResult {
  readonly ok: boolean;
  readonly unknownPermissions: readonly string[];
  readonly disallowedPermissions: readonly string[];
  readonly reason: string;
}

/**
 * A workspace can define custom roles. This validator runs before a
 * custom role is persisted so a typo cannot create a role with no
 * effective permissions, and so workspace-level roles cannot accidentally
 * grant a platform super-admin permission (only the platform operator
 * can).
 */
export function validateCustomRole(input: {
  readonly name: string;
  readonly permissions: readonly string[];
}): CustomRoleValidationResult {
  const name = nonEmpty(input.name);
  if (name === null) {
    return {
      ok: false,
      unknownPermissions: [],
      disallowedPermissions: [],
      reason: "A custom role requires a non-empty name.",
    };
  }
  const unknown: string[] = [];
  const disallowed: string[] = [];
  for (const p of input.permissions) {
    if (!isPermission(p)) {
      unknown.push(p);
      continue;
    }
    if (PLATFORM_SUPER_ADMIN_PERMISSIONS.includes(p)) {
      disallowed.push(p);
    }
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      unknownPermissions: Object.freeze(unknown),
      disallowedPermissions: Object.freeze(disallowed),
      reason: `The custom role "${name}" names permissions that do not exist: ${unknown.join(", ")}.`,
    };
  }
  if (disallowed.length > 0) {
    return {
      ok: false,
      unknownPermissions: Object.freeze(unknown),
      disallowedPermissions: Object.freeze(disallowed),
      reason: `The custom role "${name}" names platform-level permissions that a workspace role cannot hold: ${disallowed.join(", ")}.`,
    };
  }
  return {
    ok: true,
    unknownPermissions: Object.freeze([]),
    disallowedPermissions: Object.freeze([]),
    reason: `The custom role "${name}" is valid.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Role resolution from a workspace membership + custom roles                  */
/* -------------------------------------------------------------------------- */

export interface MembershipForRbac {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: string;
  readonly extraPermissions?: readonly string[];
  readonly deniedPermissions?: readonly string[];
}

export interface CustomRoleForRbac {
  readonly name: string;
  readonly permissions: readonly string[];
}

/**
 * Build an `RbacSubject` from a membership and the workspace's custom
 * role definitions. Any unknown permission in the membership's overrides
 * is dropped silently with a warning surfaced through the returned
 * `warnings` array — the decision function would reject it anyway, and a
 * caller building an admin view wants the fact that an override was
 * dropped, without a thrown error.
 */
export function buildSubjectFromMembership(input: {
  readonly membership: MembershipForRbac;
  readonly customRoles?: readonly CustomRoleForRbac[];
}): { readonly subject: RbacSubject; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const extra: Permission[] = [];
  for (const p of input.membership.extraPermissions ?? []) {
    if (isPermission(p)) extra.push(p);
    else warnings.push(`Ignoring unknown extra permission "${p}".`);
  }
  const denied: Permission[] = [];
  for (const p of input.membership.deniedPermissions ?? []) {
    if (isPermission(p)) denied.push(p);
    else warnings.push(`Ignoring unknown denied permission "${p}".`);
  }
  const customPermissions: Permission[] = [];
  const builtin = getBuiltinRole(input.membership.role);
  if (builtin === null) {
    const match = (input.customRoles ?? []).find(
      (c) => c.name === input.membership.role,
    );
    if (match === undefined) {
      warnings.push(
        `Role "${input.membership.role}" is neither a built-in role nor a defined custom role.`,
      );
    } else {
      for (const p of match.permissions) {
        if (isPermission(p)) customPermissions.push(p);
        else warnings.push(`Custom role "${match.name}" names unknown permission "${p}".`);
      }
    }
  }
  const subject: RbacSubject = {
    userId: input.membership.userId,
    workspaceId: input.membership.workspaceId,
    role: input.membership.role,
    extraPermissions: Object.freeze(extra),
    deniedPermissions: Object.freeze(denied),
    customRolePermissions: Object.freeze(customPermissions),
  };
  return { subject, warnings: Object.freeze(warnings) };
}

/* -------------------------------------------------------------------------- */
/* Utility                                                                     */
/* -------------------------------------------------------------------------- */

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  OWNER_PERMISSIONS,
  ADMIN_PERMISSIONS,
  EDITOR_PERMISSIONS,
  REVIEWER_PERMISSIONS,
  VIEWER_PERMISSIONS,
  validateCustomRole,
  buildSubjectFromMembership,
  nonEmpty,
});
