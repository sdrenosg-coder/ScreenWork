import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getJob } from "@workspace/zipy/jobs/queue";
import { ApiFailure, endpoint, workspace, guide, objectBody, locked, read, write, saveVersion } from "./saas-routes";
import { PERMISSIONS } from "@workspace/zipy/web/rbac/permissions";
import { appendActivity } from "./workspace-events";
import { validatePublicUrlSyntax } from "@workspace/zipy/jobs/sourceReader";

type Doc = Record<string, unknown>;
type Store = Awaited<ReturnType<typeof workspace>>["store"];
const roles = ["viewer", "commenter", "editor", "reviewer", "admin"] as const;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const idPattern = /^[0-9a-f-]{36}$/i;
const clean = (value: unknown, label: string, max = 200) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ApiFailure(400, "invalid_input", `${label} is required (maximum ${max} characters).`);
  return value.trim();
};
const identity = (value: unknown) => { const id = clean(value, "ID", 36); if (!idPattern.test(id)) throw new ApiFailure(400, "invalid_id", "A valid ID is required."); return id; };
async function rows(store: Store, prefix: string, limit = 200): Promise<Doc[]> {
  const listing = await store.list(prefix, { limit });
  const records = await Promise.all(listing.entries.filter(entry => entry.key.endsWith(".json")).map(entry => read(store, entry.key)));
  return records.filter((record): record is Doc => Boolean(record));
}
const starters = [
  { id: "starter-sop", title: "Standard operating procedure", description: "Purpose, responsibilities, steps and verification.", steps: ["Purpose and scope", "Roles and prerequisites", "Perform the procedure", "Verify the result", "Exceptions and escalation"] },
  { id: "starter-onboarding", title: "Employee onboarding", description: "A consistent first week for every new teammate.", steps: ["Before the first day", "Set up accounts and equipment", "Meet the team", "Complete role training", "Confirm readiness"] },
  { id: "starter-troubleshooting", title: "Troubleshooting runbook", description: "Diagnose, repair, verify and escalate safely.", steps: ["Confirm the symptoms", "Check prerequisites", "Run diagnostic checks", "Apply the approved fix", "Verify recovery and document"] },
  { id: "starter-release", title: "Release checklist", description: "Repeatable deployment and rollback checks.", steps: ["Confirm approval", "Back up and prepare rollback", "Run pre-release checks", "Release", "Monitor and verify"] },
];
function step(title: string, index: number) {
  return { id: randomUUID(), index, title, description: "", value: "", screenshotRef: null, aiGenerated: false };
}
export function registerSuiteRoutes(app: Express) {
  app.get("/api/suite/:section", endpoint(async (req, res) => {
    const section = String(req.params.section);
    const permission = section === "team" ? PERMISSIONS.workspace_member_read : section === "governance" ? PERMISSIONS.workspace_audit_read : section === "integrations" ? PERMISSIONS.workspace_settings_update : PERMISSIONS.guide_read;
    const { store, workspaceId, session } = await workspace(req, permission);
    if (section === "templates") {
      res.json({ items: [...starters.map(item => ({ ...item, starter: true })), ...await rows(store, "templates/")], message: "Reusable starters and saved guide templates." }); return;
    }
    if (section === "team") {
      const members = await db.execute(sql`select m.user_id as id, m.role, u.email, u.display_name as name, m.joined_at from workspace_members m join users u on u.id=m.user_id where m.workspace_id=${workspaceId} order by m.joined_at`);
      const invitations = (await rows(store, "team-invites/")).map(({ tokenHash, ...item }) => item);
      const available = await db.execute(sql`select w.id,w.name,m.role from workspace_members m join workspaces w on w.id=m.workspace_id where m.user_id=${session.userId}`);
      res.json({ items: members.rows, invitations, workspaces: available.rows, currentUserId: session.userId, role: session.workspaceRole, workspaceId }); return;
    }
    if (section === "integrations") {
      const hooks = (await rows(store, "webhooks/config/")).map(({ secretCipher, ...item }) => item);
      const keys = (await rows(store, "api-keys/")).map(({ tokenHash, ...item }) => item);
      res.json({ items: hooks, hooks, keys, deliveries: await rows(store, "webhooks/deliveries/", 50), apiBase: "/api/external/guides", message: "API keys are read-only. Webhooks are signed and dispatched by the processing worker." }); return;
    }
    if (section === "governance") {
      res.json({ items: await rows(store, "activity/", 250), policy: await read(store, "governance/policy.json") ?? { retentionDays: null, note: "No automatic deletion policy configured." }, requests: await rows(store, "governance/requests/"), message: "Operational controls—not a certification of GDPR, SOC 2 or HIPAA compliance." }); return;
    }
    throw new ApiFailure(404, "not_found", "Unknown workspace section.");
  }));

  app.post("/api/suite/:section", endpoint(async (req, res) => {
    const section = String(req.params.section), body = objectBody(req), action = clean(body.action, "Action", 40);
    const permission = section === "templates" ? PERMISSIONS.guide_create : section === "team" ? (action === "accept" || action === "switch" ? PERMISSIONS.workspace_read : PERMISSIONS.workspace_member_invite) : PERMISSIONS.workspace_settings_update;
    const { store, workspaceId, session } = await workspace(req, permission);
    const at = new Date().toISOString();
    if (section === "templates") {
      if (action === "save") {
        const current = await guide(store, identity(body.guideId));
        const templateId = randomUUID(), title = clean(body.title, "Template title");
        await write(store, `templates/${templateId}.json`, { id: templateId, title, description: typeof body.description === "string" ? body.description.slice(0, 2000) : "", steps: current.steps, createdAt: at, createdBy: session.userId, starter: false });
        await appendActivity(workspaceId, session.userId, "template.created", templateId, `Saved template ${title}`);
        res.json({ id: templateId, message: "Template saved." }); return;
      }
      const templateId = clean(body.templateId, "Template ID");
      if (action === "delete") {
        await store.delete(`templates/${identity(templateId)}.json`);
        await appendActivity(workspaceId, session.userId, "template.deleted", templateId, "Deleted a saved template");
        res.json({ message: "Saved template deleted. Guides already created from it are unchanged." }); return;
      }
      if (action === "use") {
        const template = starters.find(item => item.id === templateId) ?? await read(store, `templates/${identity(templateId)}.json`);
        if (!template) throw new ApiFailure(404, "not_found", "Template not found.");
        const id = randomUUID(), title = clean(body.title ?? template.title, "Guide title");
        const steps = (template.steps as unknown[]).map((raw, index) => typeof raw === "string" ? step(raw, index + 1) : { ...(raw as Doc), id: randomUUID(), index: index + 1, screenshotRef: null, aiGenerated: (raw as Doc).aiGenerated === true });
        const record = { id, workspaceId, title, version: 1, status: "draft", visibility: "private", steps, templateId, needsReview: steps.some(item => item.aiGenerated), createdAt: at, updatedAt: at, createdBy: session.userId, updatedBy: session.userId };
        await write(store, `guides/${id}.json`, record); await write(store, `guides/${id}/draft-current.json`, record);
        await appendActivity(workspaceId, session.userId, "guide.created", id, `Created ${title} from a template`);
        res.json({ id, message: "Guide created from template." }); return;
      }
    }
    if (section === "team") {
      if (action === "switch") {
        const target = identity(body.workspaceId);
        const member = await db.execute(sql`select 1 from workspace_members where workspace_id=${target} and user_id=${session.userId}`);
        if (!member.rows.length) throw new ApiFailure(404, "not_found", "Workspace not found.");
        await db.execute(sql`update sessions set active_workspace_id=${target} where id=${session.sessionId} and user_id=${session.userId}`);
        res.json({ message: "Active workspace changed." }); return;
      }
      if (action === "accept") {
        const target = identity(body.workspaceId), inviteId = identity(body.invitationId), token = clean(body.token, "Invitation token", 100);
        const targetStore = (await import("@workspace/zipy/storage/routeStore")).forWorkspace;
        const invitedStore = await targetStore(target);
        await locked(target, inviteId, async () => {
          const invite = await read(invitedStore, `team-invites/${inviteId}.json`);
          if (!invite || invite.status !== "pending" || Date.parse(String(invite.expiresAt)) < Date.now() || typeof invite.tokenHash !== "string" || !timingSafeEqual(Buffer.from(digest(token)), Buffer.from(invite.tokenHash))) throw new ApiFailure(400, "invalid_invitation", "Invitation is invalid, expired or already used.");
          const users = await db.execute(sql`select email_normalized from users where id=${session.userId}`);
          if (String(users.rows[0]?.email_normalized) !== invite.email) throw new ApiFailure(403, "wrong_account", "Sign in using the invited email address.");
          await db.execute(sql`insert into workspace_members(workspace_id,user_id,role,invited_by) values(${target},${session.userId},${String(invite.role)},${String(invite.createdBy)}) on conflict(workspace_id,user_id) do nothing`);
          await write(invitedStore, `team-invites/${inviteId}.json`, { ...invite, status: "accepted", acceptedAt: at });
          await db.execute(sql`update sessions set active_workspace_id=${target} where id=${session.sessionId} and user_id=${session.userId}`);
        });
        await appendActivity(target, session.userId, "team.joined", session.userId, "Accepted workspace invitation");
        res.json({ message: "You joined the workspace." }); return;
      }
      if (!["owner", "admin"].includes(String(session.workspaceRole))) throw new ApiFailure(403, "forbidden", "Workspace administrator required.");
      if (action === "invite") {
        const email = clean(body.email, "Email", 254).toLowerCase(), role = String(body.role ?? "editor");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !roles.includes(role as typeof roles[number])) throw new ApiFailure(400, "invalid_input", "Choose a valid email and workspace role.");
        if (role === "admin" && session.workspaceRole !== "owner") throw new ApiFailure(403, "forbidden", "Only the owner may invite administrators.");
        const id = randomUUID(), token = randomBytes(32).toString("base64url");
        await write(store, `team-invites/${id}.json`, { id, email, role, status: "pending", tokenHash: digest(token), createdBy: session.userId, createdAt: at, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
        await appendActivity(workspaceId, session.userId, "team.invited", id, `Created invitation for ${email}`);
        res.json({ invitationId: id, workspaceId, token, message: "Share the invitation link securely. No email was sent." }); return;
      }
      if (action === "revoke") {
        const id = identity(body.invitationId), invite = await read(store, `team-invites/${id}.json`);
        if (!invite) throw new ApiFailure(404, "not_found", "Invitation not found.");
        await write(store, `team-invites/${id}.json`, { ...invite, status: "revoked" }); res.json({ message: "Invitation revoked." }); return;
      }
      if (action === "role" || action === "remove") {
        const userId = identity(body.userId);
        if (userId === session.userId) throw new ApiFailure(400, "invalid_input", "You cannot remove or change your own access here.");
        const members = await db.execute(sql`select role from workspace_members where workspace_id=${workspaceId} and user_id=${userId}`);
        const oldRole = members.rows[0]?.role;
        if (!oldRole) throw new ApiFailure(404, "not_found", "Member not found.");
        if (oldRole === "owner" || (oldRole === "admin" && session.workspaceRole !== "owner")) throw new ApiFailure(403, "forbidden", "This membership is protected.");
        if (action === "remove") await db.execute(sql`delete from workspace_members where workspace_id=${workspaceId} and user_id=${userId}`);
        else {
          const role = String(body.role);
          if (!roles.includes(role as typeof roles[number]) || (role === "admin" && session.workspaceRole !== "owner")) throw new ApiFailure(400, "invalid_role", "Invalid role.");
          await db.execute(sql`update workspace_members set role=${role},updated_at=now() where workspace_id=${workspaceId} and user_id=${userId}`);
        }
        await appendActivity(workspaceId, session.userId, `team.${action}`, userId, `Updated member access: ${action}`);
        res.json({ message: "Member access updated." }); return;
      }
    }
    if (section === "integrations") {
      if (action === "create-key") {
        const id = randomUUID(), secret = randomBytes(32).toString("base64url"), token = `zipy_${workspaceId}_${id}_${secret}`;
        await write(store, `api-keys/${id}.json`, { id, name: clean(body.name, "Key name"), tokenHash: digest(token), createdAt: at, createdBy: session.userId });
        res.json({ token, id, message: "Copy this read-only API key now; it will not be shown again." }); return;
      }
      if (action === "revoke-key") { await store.delete(`api-keys/${identity(body.id)}.json`); res.json({ message: "API key revoked." }); return; }
      if (action === "hook") {
        let url: URL;
        try { url = validatePublicUrlSyntax(clean(body.url, "Webhook URL", 2048)); }
        catch { throw new ApiFailure(400, "invalid_url", "Use a public HTTPS webhook URL on a standard port."); }
        if (url.protocol !== "https:") throw new ApiFailure(400, "invalid_url", "Webhook endpoints must use HTTPS.");
        const id = randomUUID(), secret = randomBytes(32).toString("base64url");
        const { encryptHookSecret } = await import("@workspace/zipy/jobs/webhookDelivery");
        await write(store, `webhooks/config/${id}.json`, { id, name: clean(body.name, "Webhook name"), url: url.href, events: ["guide.created", "guide.saved", "guide.published", "guide.private"], enabled: true, secretCipher: encryptHookSecret(secret), createdAt: at });
        res.json({ id, secret, message: "Webhook created. Copy the signing secret now." }); return;
      }
      if (action === "delete-hook") { await store.delete(`webhooks/config/${identity(body.id)}.json`); res.json({ message: "Webhook removed." }); return; }
      if (action === "test-hook") {
        const id = identity(body.id), hook = await read(store, `webhooks/config/${id}.json`);
        if (!hook) throw new ApiFailure(404, "not_found", "Webhook not found.");
        const { enqueueWorkspaceHooks } = await import("@workspace/zipy/jobs/webhookDelivery");
        await enqueueWorkspaceHooks(workspaceId, { id: randomUUID(), kind: "webhook.test", at, data: { message: "Zipy connection test" } }, id);
        res.json({ message: "Signed test delivery queued. Refresh to inspect the delivery result." }); return;
      }
    }
    if (section === "governance") {
      if (action === "policy") {
        const retentionDays = body.retentionDays === null ? null : Number(body.retentionDays);
        if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)) throw new ApiFailure(400, "invalid_input", "Retention must be null or 1–3650 days.");
        await write(store, "governance/policy.json", { retentionDays, updatedAt: at, updatedBy: session.userId, enforcement: "Explicit review and purge only; no automatic deletion." });
        await appendActivity(workspaceId, session.userId, "governance.policy", workspaceId, "Changed retention review policy");
        res.json({ message: "Retention review policy saved. Nothing was deleted." }); return;
      }
      if (action === "request") {
        const type = String(body.type);
        if (!["export", "erasure", "correction"].includes(type)) throw new ApiFailure(400, "invalid_type", "Choose export, erasure or correction.");
        const id = randomUUID();
        await write(store, `governance/requests/${id}.json`, { id, type, subject: clean(body.subject, "Subject", 254), details: clean(body.details, "Details", 4000), status: "open", createdAt: at, createdBy: session.userId });
        res.json({ id, message: "Request recorded for workspace administrator review." }); return;
      }
      if (action === "resolve-request") {
        const id = identity(body.id), request = await read(store, `governance/requests/${id}.json`);
        if (!request) throw new ApiFailure(404, "not_found", "Request not found.");
        const resolution = clean(body.resolution, "Resolution evidence", 4000);
        await write(store, `governance/requests/${id}.json`, { ...request, status: "resolved", resolution, resolvedBy: session.userId, resolvedAt: at });
        await appendActivity(workspaceId, session.userId, "governance.request.resolved", id, resolution);
        res.json({ message: "Resolution recorded. This does not perform or certify data erasure." }); return;
      }
      if (action === "export") {
        const files = await rows(store, "guides/", 1000);
        await appendActivity(workspaceId, session.userId, "governance.export", workspaceId, "Exported workspace guide records");
        res.json({ items: files, workspaceId, exportedAt: at, message: "Workspace guide records exported; original binary uploads and account credentials are excluded." }); return;
      }
    }
    throw new ApiFailure(400, "invalid_action", "Unsupported operation for this section.");
  }));

  app.get("/api/guides/:id/discussion", endpoint(async (req, res) => {
    const { store } = await workspace(req, PERMISSIONS.guide_read), current = await guide(store, identity(req.params.id));
    res.json({ items: await rows(store, `discussion/${current.id}/`), guideVersion: current.version });
  }));
  app.post("/api/guides/:id/discussion", endpoint(async (req, res) => {
    const body = objectBody(req), { store, session, workspaceId } = await workspace(req, PERMISSIONS.guide_comment);
    const guideId = identity(req.params.id); await guide(store, guideId);
    if (body.action === "comment") {
      const id = randomUUID();
      await write(store, `discussion/${guideId}/${id}.json`, { id, text: clean(body.text, "Comment", 4000), stepId: typeof body.stepId === "string" ? body.stepId : null, authorId: session.userId, createdAt: new Date().toISOString(), resolved: false });
      await appendActivity(workspaceId, session.userId, "guide.commented", guideId, "Added a guide review comment");
      res.json({ id, message: "Comment added." }); return;
    }
    const id = identity(body.id);
    await locked(workspaceId, `${guideId}/${id}`, async () => {
      const current = await read(store, `discussion/${guideId}/${id}.json`);
      if (!current) throw new ApiFailure(404, "not_found", "Comment not found.");
      if (body.action === "delete") {
        if (current.authorId !== session.userId && !["owner", "admin"].includes(String(session.workspaceRole))) throw new ApiFailure(403, "forbidden", "Only the author or an administrator can delete this comment.");
        await store.delete(`discussion/${guideId}/${id}.json`);
      } else if (body.action === "resolve") {
        if (current.authorId !== session.userId && !["editor", "reviewer", "admin", "owner"].includes(String(session.workspaceRole))) throw new ApiFailure(403, "forbidden", "Only the author or a guide editor/reviewer can resolve this thread.");
        await write(store, `discussion/${guideId}/${id}.json`, { ...current, resolved: body.resolved === true, resolvedBy: session.userId });
      }
      else throw new ApiFailure(400, "invalid_action", "Unknown discussion action.");
    });
    res.json({ message: "Discussion updated." });
  }));

  app.get("/api/external/guides", endpoint(async (req, res) => {
    const token = req.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const match = /^zipy_([a-f0-9-]{36})_([a-f0-9-]{36})_([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) throw new ApiFailure(401, "invalid_key", "A workspace read-only bearer API key is required.");
    const store = await (await import("@workspace/zipy/storage/routeStore")).forWorkspace(match[1]);
    const key = await read(store, `api-keys/${match[2]}.json`);
    if (!key || typeof key.tokenHash !== "string" || !timingSafeEqual(Buffer.from(digest(token)), Buffer.from(key.tokenHash))) throw new ApiFailure(401, "invalid_key", "API key is invalid or revoked.");
    const listing = await store.list("guides/", { limit: 2000 });
    const roots = listing.entries.filter(entry => /^guides\/[a-f0-9-]{36}\.json$/i.test(entry.key)).slice(0, 200);
    const guides = await Promise.all(roots.map(entry => read(store, entry.key)));
    const items = guides.filter((item): item is Doc => Boolean(item)).map(({ id, title, status, version, updatedAt }) => ({ id, title, status, version, updatedAt }));
    res.json({ items });
  }));
}
