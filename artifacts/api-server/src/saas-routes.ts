import type { Express, Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { loadSession, destroyCurrentSession } from "@workspace/zipy/web/auth/session";
import { assertPermission, PERMISSIONS, toAuthzFailure, type Permission } from "@workspace/zipy/web/rbac/permissions";
import { forWorkspace } from "@workspace/zipy/storage/routeStore";
import { appendActivity } from "./workspace-events";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RecordData = Record<string, unknown>;
type GuideRecord = RecordData & { id: string; version: number; steps: unknown[] };
type Store = Awaited<ReturnType<typeof forWorkspace>>;

class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: RecordData = {}) {
    super(message);
  }
}

function endpoint(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "GET" && req.get("sec-fetch-site") === "cross-site") {
        throw new ApiFailure(403, "forbidden", "Cross-site changes are not allowed.");
      }
      await handler(req, res);
    } catch (error) {
      const authz = toAuthzFailure(error);
      if (authz) { res.status(authz.status).json(authz.body); return; }
      if (error instanceof ApiFailure) {
        res.status(error.status).json({ error: error.code, message: error.message, ...error.details });
        return;
      }
      req.log.error({ err: error }, "Workspace operation failed");
      res.status(500).json({ error: "server_error", message: "The operation could not complete. Please try again." });
    }
  };
}

async function workspace(req: Request, permission: Permission) {
  const session = await loadSession({ cookieHeader: req.get("cookie") ?? null, touch: false });
  if (!session) throw new ApiFailure(401, "unauthenticated", "Please sign in to continue.");
  assertPermission(session, permission);
  if (!session.activeWorkspaceId) throw new ApiFailure(403, "no_workspace", "No active workspace.");
  return { session, workspaceId: session.activeWorkspaceId, store: await forWorkspace(session.activeWorkspaceId) };
}

function objectBody(req: Request): RecordData {
  try {
    const body: unknown = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) : req.body;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as RecordData;
  } catch { /* report a validation error below */ }
  throw new ApiFailure(400, "invalid_json", "A JSON object is required.");
}

function resourceId(req: Request): string {
  const id = String(req.params.id);
  if (!UUID.test(id)) throw new ApiFailure(400, "validation_error", "A valid guide ID is required.");
  return id;
}

async function read(store: Store, key: string): Promise<RecordData | null> {
  const bytes = await store.get(key);
  if (!bytes) return null;
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored document");
  return value as RecordData;
}

async function guide(store: Store, id: string): Promise<GuideRecord> {
  const record = await read(store, `guides/${id}.json`);
  if (!record) throw new ApiFailure(404, "not_found", "This guide does not exist in your workspace.");
  return {
    ...record, id,
    version: typeof record.version === "number" ? record.version : 1,
    steps: Array.isArray(record.steps) ? record.steps : [],
  };
}

async function write(store: Store, key: string, value: unknown) {
  await store.put(key, Buffer.from(JSON.stringify(value)), { contentType: "application/json" });
}

// A database advisory lock protects optimistic versions across server instances,
// while retaining the imported tenant-scoped object-store persistence.
async function locked<T>(workspaceId: string, id: string, action: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}/${id}`}, 0))`);
    return action();
  });
}

function normalizeSteps(value: unknown, workspaceId: string): RecordData[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new ApiFailure(400, "validation_error", "steps must be an array of at most 500 steps.");
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiFailure(400, "validation_error", "Every step must be an object.");
    }
    const step = raw as RecordData;
    if (typeof step.id !== "string" || !step.id || step.id.length > 200 || seen.has(step.id)) {
      throw new ApiFailure(400, "validation_error", "Step IDs must be non-empty and unique.");
    }
    seen.add(step.id);
    for (const field of ["title", "description", "value"]) {
      if (typeof step[field] !== "string" || (step[field] as string).length > 20000) {
        throw new ApiFailure(400, "validation_error", `Each step needs a valid ${field}.`);
      }
    }
    const screenshot = step.screenshotRef;
    if (screenshot != null && (typeof screenshot !== "string" ||
      (!screenshot.startsWith(`${workspaceId}/`) && !screenshot.startsWith("artifacts/")) ||
      screenshot.includes("..") || screenshot.includes("\\") || screenshot.includes("\0"))) {
      throw new ApiFailure(400, "validation_error", "Screenshot references must belong to this workspace.");
    }
    const extras = step.extraFields && typeof step.extraFields === "object" && !Array.isArray(step.extraFields)
      ? step.extraFields as RecordData : {};
    const normalized: RecordData = { ...extras, ...step, index: index + 1, screenshotRef: screenshot ?? null, aiGenerated: step.aiGenerated === true };
    delete normalized.extraFields;
    return normalized;
  });
}

async function saveVersion(store: Store, current: GuideRecord, next: RecordData, userId: string): Promise<GuideRecord> {
  await write(store, `guides/${current.id}/versions/${current.version}.json`, current);
  const record = {
    ...current, ...next, version: current.version + 1,
    updatedAt: new Date().toISOString(), updatedBy: userId,
  };
  await write(store, `guides/${current.id}/draft-current.json`, record);
  await write(store, `guides/${current.id}.json`, record);
  return record;
}

export function registerSaasRoutes(app: Express) {
  app.get("/api/session", endpoint(async (req, res) => {
    const { session, workspaceId } = await workspace(req, PERMISSIONS.workspace_read);
    res.json({ userId: session.userId, workspaceId, role: session.workspaceRole });
  }));
  app.post("/api/auth/logout", endpoint(async (req, res) => {
    const headers = new Headers();
    await destroyCurrentSession({ cookieHeader: req.get("cookie") ?? null }, { headers });
    res.setHeader("Set-Cookie", headers.getSetCookie());
    res.status(204).end();
  }));
  app.get("/api/guides/:id", endpoint(async (req, res) => {
    const { store } = await workspace(req, PERMISSIONS.guide_read);
    res.json({ guide: await guide(store, resourceId(req)), message: "Guide loaded." });
  }));
  app.put("/api/guides/:id", endpoint(async (req, res) => {
    const { store, session, workspaceId } = await workspace(req, PERMISSIONS.guide_update);
    const id = resourceId(req);
    const body = objectBody(req);
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
      throw new ApiFailure(400, "validation_error", "expectedVersion is required.");
    }
    const steps = normalizeSteps(body.steps, workspaceId);
    const result = await locked(workspaceId, id, async () => {
      const current = await guide(store, id);
      if (current.version !== body.expectedVersion) throw new ApiFailure(409, "version_conflict", "Someone changed this guide. Reload before saving.", { currentVersion: current.version });
      return saveVersion(store, current, { steps, stepCount: steps.length, screenshotCount: steps.filter(s => s.screenshotRef).length }, session.userId);
    });
    await appendActivity(workspaceId, session.userId, "guide.saved", id, `Saved revision ${result.version} of ${String(result.title)}`).catch(error => req.log.warn({ err: error }, "Guide saved but activity recording failed"));
    res.json({ guide: result, message: "All changes saved." });
  }));
  app.get("/api/guides/:id/versions", endpoint(async (req, res) => {
    const { store, workspaceId } = await workspace(req, PERMISSIONS.guide_read);
    const id = resourceId(req);
    const current = await guide(store, id);
    const records = [current];
    let cursor: string | null = null;
    do {
      const page = await store.list(`guides/${id}/versions/`, { limit: 250, cursor });
      for (const entry of page.entries) {
        const record = await read(store, entry.key);
        if (record) records.push(record as typeof current);
      }
      cursor = page.nextCursor;
    } while (cursor);
    res.json({
      guideId: id, workspaceId, current: current.version,
      versions: records.sort((a, b) => Number(b.version) - Number(a.version)).map(record => ({
        version: record.version, isCurrent: record.version === current.version,
        createdAt: record.updatedAt ?? record.createdAt, createdBy: record.updatedBy ?? record.createdBy,
        status: record.version === current.version ? "current" : "archived",
      })),
      message: "Version history loaded.", notes: [],
    });
  }));
  app.post("/api/guides/:id/versions/:version/restore", endpoint(async (req, res) => {
    const { store, workspaceId, session } = await workspace(req, PERMISSIONS.guide_update);
    const id = resourceId(req);
    const version = Number(req.params.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new ApiFailure(400, "validation_error", "Invalid version.");
    const body = objectBody(req);
    const restored = await locked(workspaceId, id, async () => {
      const current = await guide(store, id);
      if (current.version !== body.expectedVersion) throw new ApiFailure(409, "version_conflict", "The guide changed. Reload version history before restoring.", { currentVersion: current.version });
      const old = version === current.version ? current : await read(store, `guides/${id}/versions/${version}.json`);
      if (!old) throw new ApiFailure(404, "not_found", "This version does not exist.");
      return saveVersion(store, current, { steps: old.steps ?? [], stepCount: Array.isArray(old.steps) ? old.steps.length : 0, screenshotCount: old.screenshotCount ?? 0 }, session.userId);
    });
    await appendActivity(workspaceId, session.userId, "guide.restored", id, `Restored revision ${version} as revision ${restored.version}`).catch(error => req.log.warn({ err: error }, "Guide restored but activity recording failed"));
    res.json({ guideId: id, workspaceId, restoredFromVersion: version, newVersionIndex: restored.version, guide: restored, message: "Version restored as a new revision.", notes: [] });
  }));
  app.post("/api/guides/:id/publish", endpoint(async (req, res) => {
    const { store, workspaceId, session } = await workspace(req, PERMISSIONS.guide_publish);
    const id = resourceId(req);
    const body = objectBody(req);
    const result = await locked(workspaceId, id, async () => {
      const current = await guide(store, id);
      if (current.aiDraftJobId && current.reviewedVersion !== current.version) throw new ApiFailure(409, "review_required", "Review and approve this AI-generated revision before publishing.");
      if (current.version !== body.expectedVersion) throw new ApiFailure(409, "version_conflict", "The saved guide changed. Reload before publishing.", { currentVersion: current.version });
      if (!current.steps.length) throw new ApiFailure(400, "validation_error", "Add and save at least one step before publishing.");
      const slug = `guide-${id}`;
      const snapshotKey = `guides/${id}/published/${current.version}.json`;
      await write(store, snapshotKey, current);
      const publicStore = await forWorkspace("__public__");
      const published: GuideRecord = { ...current, status: "published", visibility: "public", slug, publishedAt: new Date().toISOString() };
      await write(store, `guides/${id}.json`, published);
      await write(publicStore, `public-guides/${slug}.json`, { guideId: id, workspaceId, access: "public", snapshotKey });
      return { slug, guide: published };
    });
    await appendActivity(workspaceId, session.userId, "guide.published", id, `Published ${String(result.guide.title)}`).catch(error => req.log.warn({ err: error }, "Guide published but activity recording failed"));
    res.json({ ...result, message: "The saved revision is now public. Unpublished edits remain private." });
  }));
  app.post("/api/guides/:id/unpublish", endpoint(async (req, res) => {
    const { store, workspaceId, session } = await workspace(req, PERMISSIONS.guide_unpublish);
    const id = resourceId(req);
    await locked(workspaceId, id, async () => {
      const current = await guide(store, id);
      const publicStore = await forWorkspace("__public__");
      await write(publicStore, `public-guides/guide-${id}.json`, { guideId: id, workspaceId, access: "private" });
      await write(store, `guides/${id}.json`, { ...current, status: "draft", visibility: "private", slug: null, publishedAt: null });
    });
    await appendActivity(workspaceId, session.userId, "guide.private", id, "Revoked public access to a guide").catch(error => req.log.warn({ err: error }, "Guide made private but activity recording failed"));
    res.json({ message: "This guide is private. The public link no longer exposes its content." });
  }));
  app.get("/api/guides/:id/download", endpoint(async (req, res) => {
    const { store } = await workspace(req, PERMISSIONS.guide_read);
    const id = resourceId(req);
    const current = await guide(store, id);
    const format = req.query.format ?? "markdown";
    if (!["markdown", "json"].includes(String(format))) throw new ApiFailure(400, "validation_error", "Choose markdown or json.");
    res.setHeader("Content-Disposition", `attachment; filename="guide-${id}.${format === "json" ? "json" : "md"}"`);
    if (format === "json") { res.type("application/json").send(JSON.stringify(current, null, 2)); return; }
    const steps = current.steps as RecordData[];
    res.type("text/markdown").send(`# ${String(current.title)}\n\n${steps.map((step, index) => `## ${index + 1}. ${String(step.title)}\n\n${String(step.description)}\n`).join("\n")}`);
  }));
}

export { ApiFailure, endpoint, workspace, objectBody, read, write, locked };
export { guide, saveVersion, normalizeSteps };
export type { RecordData, Store };
