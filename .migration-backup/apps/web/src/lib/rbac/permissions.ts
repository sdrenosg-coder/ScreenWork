/**
 * Zipy AI — workspace-scoped RBAC catalogue and guards.
 *
 * Phase 1 deliverable. Every server-side API route and server component that
 * acts on a resource in a workspace must pass through a guard declared here.
 * The role strings themselves live in `@zipy/db/schema/workspaces` — this file
 * maps roles to permissions and exposes helpers that the route handlers use.
 *
 * Design notes:
 *  - Permissions are a static, named catalogue. Nothing in the product may
 *    invent ad-hoc permission strings; adding one means adding it here.
 *  - `ROLE_PERMISSIONS` is exhaustive over `WorkspaceRole`. A compile-time
 *    `Record<WorkspaceRole, ...>` ensures a new role is a breaking change
 *    surfaced by the type checker rather than a silent runtime gap.
 *  - Guards never silently degrade: an unauthenticated caller gets
 *    `UnauthenticatedError`; an authenticated caller lacking a permission gets
 *    `ForbiddenError`. Route handlers turn those into 401/403.
 *  - Workspace-role overrides (`workspace_role_overrides`, used later for
 *    resource-scoped grants) are honoured by `effectiveRoleFor`. This phase
 *    only reads the coarse membership role; the override table exists in the
 *    schema and is consulted when the caller supplies a resource context.
 */

import type { SessionRecord } from "@/lib/auth/session";
import { UnauthenticatedError } from "@/lib/auth/session";
import {
  type WorkspaceRole,
  roleSatisfies,
} from "@zipy/db/schema/workspaces";

/* -------------------------------------------------------------------------- */
/* Permission catalogue                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every action a caller can perform against a workspace. Grouped by area so
 * the mapping table below stays readable. Namespaced strings keep the list
 * grep-able from route handlers (`PERMISSIONS.guide_publish`).
 */
export const PERMISSIONS = Object.freeze({
  // Workspace administration
  workspace_read: "workspace:read",
  workspace_update: "workspace:update",
  workspace_delete: "workspace:delete",
  workspace_settings_update: "workspace:settings:update",
  workspace_member_read: "workspace:member:read",
  workspace_member_invite: "workspace:member:invite",
  workspace_member_role_update: "workspace:member:role:update",
  workspace_member_remove: "workspace:member:remove",
  workspace_billing_read: "workspace:billing:read",
  workspace_billing_update: "workspace:billing:update",
  workspace_audit_read: "workspace:audit:read",

  // Sources and ingestion
  source_read: "source:read",
  source_create: "source:create",
  source_update: "source:update",
  source_delete: "source:delete",

  // Workflows and synthesis
  workflow_read: "workflow:read",
  workflow_create: "workflow:create",
  workflow_update: "workflow:update",
  workflow_delete: "workflow:delete",
  workflow_synthesize: "workflow:synthesize",
  workflow_run: "workflow:run",

  // Guides and generated content
  guide_read: "guide:read",
  guide_create: "guide:create",
  guide_update: "guide:update",
  guide_delete: "guide:delete",
  guide_generate: "guide:generate",
  guide_translate: "guide:translate",
  guide_comment: "guide:comment",
  guide_publish: "guide:publish",
  guide_unpublish: "guide:unpublish",
  guide_export: "guide:export",
  guide_screenshot_redact: "guide:screenshot:redact",

  // Review / human-in-the-loop
  review_read: "review:read",
  review_decide: "review:decide",
  review_batch_approve: "review:batch_approve",
  review_handoff_control: "review:handoff:control",

  // Templates / styles / snippets
  template_read: "template:read",
  template_manage: "template:manage",
  style_read: "style:read",
  style_manage: "style:manage",

  // Integrations
  integration_read: "integration:read",
  integration_manage: "integration:manage",

  // Analytics
  analytics_read: "analytics:read",

  // Moderation queue (safety phase)
  moderation_queue_read: "moderation:read",
  moderation_queue_decide: "moderation:decide",
} as const);

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export type PermissionKey = keyof typeof PERMISSIONS;

/* -------------------------------------------------------------------------- */
/* Role -> permission mapping                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Exhaustive role/permission matrix. Read this as: "role R has permission P".
 * Read-only and commenting roles never gain write/publish/administrative
 * permissions. `owner` is a strict superset of `admin`.
 */
export const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, ReadonlySet<Permission>>> =
  Object.freeze({
    viewer: new Set<Permission>([
      PERMISSIONS.workspace_read,
      PERMISSIONS.source_read,
      PERMISSIONS.workflow_read,
      PERMISSIONS.guide_read,
      PERMISSIONS.review_read,
      PERMISSIONS.template_read,
      PERMISSIONS.style_read,
      PERMISSIONS.analytics_read,
    ]),

    commenter: new Set<Permission>([
      // viewer baseline
      PERMISSIONS.workspace_read,
      PERMISSIONS.source_read,
      PERMISSIONS.workflow_read,
      PERMISSIONS.guide_read,
      PERMISSIONS.review_read,
      PERMISSIONS.template_read,
      PERMISSIONS.style_read,
      PERMISSIONS.analytics_read,
      // commenter additions
      PERMISSIONS.guide_comment,
    ]),

    editor: new Set<Permission>([
      // commenter baseline
      PERMISSIONS.workspace_read,
      PERMISSIONS.source_read,
      PERMISSIONS.workflow_read,
      PERMISSIONS.guide_read,
      PERMISSIONS.review_read,
      PERMISSIONS.template_read,
      PERMISSIONS.style_read,
      PERMISSIONS.analytics_read,
      PERMISSIONS.guide_comment,
      // editor additions
      PERMISSIONS.source_create,
      PERMISSIONS.source_update,
      PERMISSIONS.source_delete,
      PERMISSIONS.workflow_create,
      PERMISSIONS.workflow_update,
      PERMISSIONS.workflow_delete,
      PERMISSIONS.workflow_synthesize,
      PERMISSIONS.guide_create,
      PERMISSIONS.guide_update,
      PERMISSIONS.guide_generate,
      PERMISSIONS.guide_export,
      PERMISSIONS.guide_screenshot_redact,
    ]),

    approver: new Set<Permission>([
      // editor baseline
      PERMISSIONS.workspace_read,
      PERMISSIONS.source_read,
      PERMISSIONS.workflow_read,
      PERMISSIONS.guide_read,
      PERMISSIONS.review_read,
      PERMISSIONS.template_read,
      PERMISSIONS.style_read,
      PERMISSIONS.analytics_read,
      PERMISSIONS.guide_comment,
      PERMISSIONS.source_create,
      PERMISSIONS.source_update,
      PERMISSIONS.source_delete,
      PERMISSIONS.workflow_create,
      PERMISSIONS.workflow_update,
      PERMISSIONS.workflow_delete,
      PERMISSIONS.workflow_synthesize,
      PERMISSIONS.guide_create,
      PERMISSIONS.guide_update,
      PERMISSIONS.guide_generate,
      PERMISSIONS.guide_export,
      PERMISSIONS.guide_screenshot_redact,
      // approver additions
      PERMISSIONS.guide_publish,
      PERMISSIONS.guide_unpublish,
      PERMISSIONS.workflow_run,
      PERMISSIONS.review_decide,
      PERMISSIONS.review_batch_approve,
      PERMISSIONS.review_handoff_control,
    ]),

    admin: new Set<Permission>([
      // approver baseline
      PERMISSIONS.workspace_read,
      PERMISSIONS.source_read,
      PERMISSIONS.workflow_read,
      PERMISSIONS.guide_read,
      PERMISSIONS.review_read,
      PERMISSIONS.template_read,
      PERMISSIONS.style_read,
      PERMISSIONS.analytics_read,
      PERMISSIONS.guide_comment,
      PERMISSIONS.source_create,
      PERMISSIONS.source_update,
      PERMISSIONS.source_delete,
      PERMISSIONS.workflow_create,
      PERMISSIONS.workflow_update,
      PERMISSIONS.workflow_delete,
      PERMISSIONS.workflow_synthesize,
      PERMISSIONS.guide_create,
      PERMISSIONS.guide_update,
      PERMISSIONS.guide_generate,
      PERMISSIONS.guide_export,
      PERMISSIONS.guide_screenshot_redact,
      PERMISSIONS.guide_publish,
      PERMISSIONS.guide_unpublish,
      PERMISSIONS.workflow_run,
      PERMISSIONS.review_decide,
      PERMISSIONS.review_batch_approve,
      PERMISSIONS.review_handoff_control,
      // admin additions
      PERMISSIONS.workspace_update,
      PERMISSIONS.workspace_settings_update,
      PERMISSIONS.workspace_member_read,
      PERMISSIONS.workspace_member_invite,
      PERMISSIONS.workspace_member_role_update,
      PERMISSIONS.workspace_member_remove,
      PERMISSIONS.workspace_billing_read,
      PERMISSIONS.workspace_audit_read,
      PERMISSIONS.guide_delete,
      PERMISSIONS.guide_translate,
      PERMISSIONS.template_manage,
      PERMISSIONS.style_manage,
      PERMISSIONS.integration_read,
      PERMISSIONS.integration_manage,
      PERMISSIONS.moderation_queue_read,
      PERMISSIONS.moderation_queue_decide,
    ]),

    owner: new Set<Permission>([
      // admin baseline
      PERMISSIONS.workspace_read,
      PERMISSIONS.source_read,
      PERMISSIONS.workflow_read,
      PERMISSIONS.guide_read,
      PERMISSIONS.review_read,
      PERMISSIONS.template_read,
      PERMISSIONS.style_read,
      PERMISSIONS.analytics_read,
      PERMISSIONS.guide_comment,
      PERMISSIONS.source_create,
      PERMISSIONS.source_update,
      PERMISSIONS.source_delete,
      PERMISSIONS.workflow_create,
      PERMISSIONS.workflow_update,
      PERMISSIONS.workflow_delete,
      PERMISSIONS.workflow_synthesize,
      PERMISSIONS.guide_create,
      PERMISSIONS.guide_update,
      PERMISSIONS.guide_generate,
      PERMISSIONS.guide_export,
      PERMISSIONS.guide_screenshot_redact,
      PERMISSIONS.guide_publish,
      PERMISSIONS.guide_unpublish,
      PERMISSIONS.workflow_run,
      PERMISSIONS.review_decide,
      PERMISSIONS.review_batch_approve,
      PERMISSIONS.review_handoff_control,
      PERMISSIONS.workspace_update,
      PERMISSIONS.workspace_settings_update,
      PERMISSIONS.workspace_member_read,
      PERMISSIONS.workspace_member_invite,
      PERMISSIONS.workspace_member_role_update,
      PERMISSIONS.workspace_member_remove,
      PERMISSIONS.workspace_billing_read,
      PERMISSIONS.workspace_audit_read,
      PERMISSIONS.guide_delete,
      PERMISSIONS.guide_translate,
      PERMISSIONS.template_manage,
      PERMISSIONS.style_manage,
      PERMISSIONS.integration_read,
      PERMISSIONS.integration_manage,
      PERMISSIONS.moderation_queue_read,
      PERMISSIONS.moderation_queue_decide,
      // owner additions
      PERMISSIONS.workspace_delete,
      PERMISSIONS.workspace_billing_update,
    ]),
  });

/* -------------------------------------------------------------------------- */
/* Guard errors                                                               */
/* -------------------------------------------------------------------------- */

export class ForbiddenError extends Error {
  readonly permission: Permission;
  readonly role: WorkspaceRole | null;
  constructor(permission: Permission, role: WorkspaceRole | null) {
    super(
      `Permission denied: role ${role ?? "<none>"} lacks ${permission}.`,
    );
    this.name = "ForbiddenError";
    this.permission = permission;
    this.role = role;
  }
}

export class WorkspaceScopeError extends Error {
  constructor(message = "A workspace-scoped action requires an active workspace.") {
    super(message);
    this.name = "WorkspaceScopeError";
  }
}

/* -------------------------------------------------------------------------- */
/* Pure role/permission checks                                                 */
/* -------------------------------------------------------------------------- */

/** True when the given role holds the requested permission. */
export function roleHasPermission(
  role: WorkspaceRole | null,
  permission: Permission,
): boolean {
  if (role === null) return false;
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * Compute the caller's effective role in the active workspace.
 *
 * The coarse membership role comes from the session loader. Resource-scoped
 * overrides live in `workspace_role_overrides` and are only consulted when the
 * caller supplies a resource context; the override table is populated by later
 * phases, so with no context this simply returns the membership role.
 *
 * The rule for overrides is: the *higher* of the membership role and any
 * applicable override wins. (An override cannot demote a member — demotion is
 * a membership change, which is auditable.)
 */
export interface ResourceContext {
  readonly resourceKind: string;
  readonly resourceId: string | null;
}

export function effectiveRoleFor(
  session: Pick<SessionRecord, "workspaceRole">,
  overrides: readonly { readonly role: WorkspaceRole }[] = [],
): WorkspaceRole | null {
  const membership = session.workspaceRole;
  if (overrides.length === 0) return membership;
  let best: WorkspaceRole | null = membership;
  for (const override of overrides) {
    if (best === null || !roleSatisfies(best, override.role)) {
      best = override.role;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Guards (throw instead of returning a boolean)                               */
/* -------------------------------------------------------------------------- */

/**
 * Assert that the caller holds the given permission in the active workspace.
 * Throws:
 *  - `UnauthenticatedError` when the session or active workspace is missing;
 *  - `ForbiddenError` when the caller's role lacks the permission.
 *
 * The function is intentionally synchronous for ergonomics inside route
 * handlers that already have a loaded session; use `assertPermissionFromHeader`
 * when the route needs to load the session from the request.
 */
export function assertPermission(
  session: Pick<SessionRecord, "activeWorkspaceId" | "workspaceRole"> | null,
  permission: Permission,
): void {
  if (session === null) throw new UnauthenticatedError();
  if (session.activeWorkspaceId === null) throw new WorkspaceScopeError();
  if (!roleHasPermission(session.workspaceRole, permission)) {
    throw new ForbiddenError(permission, session.workspaceRole);
  }
}

/** Same as `assertPermission`, but does not require an active workspace. */
export function assertPermissionNoWorkspace(
  session: Pick<SessionRecord, "workspaceRole"> | null,
  permission: Permission,
): void {
  if (session === null) throw new UnauthenticatedError();
  if (!roleHasPermission(session.workspaceRole, permission)) {
    throw new ForbiddenError(permission, session.workspaceRole);
  }
}

/**
 * Convenience: true when the caller may perform the permission in the active
 * workspace. Use this when computing UI affordances and never as the sole
 * enforcement point — enforcement happens with `assertPermission`.
 */
export function can(
  session: Pick<SessionRecord, "activeWorkspaceId" | "workspaceRole"> | null,
  permission: Permission,
): boolean {
  if (session === null) return false;
  if (session.activeWorkspaceId === null) return false;
  return roleHasPermission(session.workspaceRole, permission);
}

/* -------------------------------------------------------------------------- */
/* HTTP response helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Map an authorization exception to `{status, body}` for a JSON response.
 * Preserves the distinction between unauthenticated (401) and forbidden (403)
 * so the client can prompt for sign-in versus showing a permissions message.
 */
export interface AuthzFailure {
  readonly status: 401 | 403;
  readonly body: {
    readonly error: "unauthenticated" | "forbidden" | "workspace_required";
    readonly message: string;
    readonly permission?: Permission;
    readonly role?: WorkspaceRole | null;
  };
}

export function toAuthzFailure(error: unknown): AuthzFailure | null {
  if (error instanceof UnauthenticatedError) {
    return {
      status: 401,
      body: { error: "unauthenticated", message: error.message },
    };
  }
  if (error instanceof ForbiddenError) {
    return {
      status: 403,
      body: {
        error: "forbidden",
        message: error.message,
        permission: error.permission,
        role: error.role,
      },
    };
  }
  if (error instanceof WorkspaceScopeError) {
    return {
      status: 403,
      body: {
        error: "workspace_required",
        message: error.message,
      },
    };
  }
  return null;
}
