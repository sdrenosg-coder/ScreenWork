import { createHash } from "node:crypto";
import type { Express, Request } from "express";
import { enqueueJob, getJob } from "@workspace/zipy/jobs/index";
import { validatePublicUrlSyntax } from "@workspace/zipy/jobs/sourceReader";
import { PERMISSIONS } from "@workspace/zipy/web/rbac/permissions";
import { ApiFailure, endpoint, workspace, objectBody, locked, read, write, guide, saveVersion, normalizeSteps } from "./saas-routes";
import { appendActivity } from "./workspace-events";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(req: Request, name = "id") {
  const value = String(req.params[name]);
  if (!UUID.test(value)) throw new ApiFailure(400, "validation_error", `Invalid ${name}.`);
  return value;
}

export function registerDraftRoutes(app: Express) {
  app.post("/api/guides/:id/draft-jobs", endpoint(async (req, res) => {
    const { store, workspaceId, session } = await workspace(req, PERMISSIONS.guide_update);
    const guideId = id(req);
    const current = await guide(store, guideId);
    const body = objectBody(req);
    let sourceValue = body.source;
    const sourceIds = body.sourceIds ?? [];
    if (!Array.isArray(sourceIds) || sourceIds.length > 4 || sourceIds.some(value => typeof value !== "string" || !UUID.test(value))) throw new ApiFailure(400, "validation_error", "Choose at most four processed sources.");
    if (sourceIds.length) {
      const texts: string[] = [];
      for (const sourceId of sourceIds) {
        const sourceJob = await getJob(workspaceId, sourceId);
        if (!sourceJob || sourceJob.payload.guideId !== guideId || !sourceJob.kind.startsWith("ingest:")) throw new ApiFailure(404, "not_found", "Source does not belong to this guide.");
        if (sourceJob.status !== "succeeded") throw new ApiFailure(409, "source_not_ready", "Wait for every selected source to finish processing.");
        const key = sourceJob.result?.storageKey;
        if (typeof key !== "string") throw new ApiFailure(409, "source_not_ready", "Source text is unavailable.");
        const processed = await read(store, key);
        if (typeof processed?.text !== "string") throw new ApiFailure(409, "source_not_ready", "Source text is unavailable.");
        texts.push(`SOURCE ${texts.length + 1}: ${String(sourceJob.payload.filename)}\n${processed.text}`);
      }
      if (body.sourceKind !== "text") throw new ApiFailure(400, "validation_error", "Combine processed files with text notes, not a URL field.");
      sourceValue = [typeof body.source === "string" ? body.source : "", ...texts].join("\n\n");
    }
    if (body.expectedVersion !== current.version) throw new ApiFailure(409, "version_conflict", "Reload this guide before generating a draft.");
    if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY || !process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) throw new ApiFailure(503, "ai_not_configured", "AI processing is not configured.");
    if (!["text", "url"].includes(String(body.sourceKind)) || typeof sourceValue !== "string" || sourceValue.trim().length < 5 || sourceValue.length > 30000) throw new ApiFailure(400, "validation_error", "Provide combined source material of 5–30,000 characters.");
    if (body.sourceKind === "url") {
      try { validatePublicUrlSyntax(sourceValue); }
      catch { throw new ApiFailure(400, "validation_error", "Use a public page URL of at most 2,048 characters without credentials or internal network addresses."); }
    }
    const options = { language: body.language ?? "English", tone: body.tone ?? "clear", brandVoice: body.brandVoice ?? "", terminology: body.terminology ?? "" };
    for (const [name, value] of Object.entries(options)) {
      const max = name === "language" ? 60 : name === "tone" ? 30 : 1000;
      if (typeof value !== "string" || value.length > max || (["language", "tone"].includes(name) && !value.trim())) throw new ApiFailure(400, "validation_error", `Invalid ${name} option.`);
    }
    const payload = { guideId, expectedVersion: current.version, source: { kind: body.sourceKind, value: sourceValue, notes: body.source, sourceIds }, options, goal: current.title };
    const key = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const job = await locked(workspaceId, guideId, async () => {
      const latest = await guide(store, guideId);
      if (latest.version !== current.version) throw new ApiFailure(409, "version_conflict", "The guide changed. Reload before generating.");
      const previous = typeof latest.activeDraftJobId === "string" ? await getJob(workspaceId, latest.activeDraftJobId) : null;
      if (previous && ["pending", "active"].includes(previous.status)) return { jobId: previous.id, status: previous.status, created: false };
      const retry = previous && ["failed", "cancelled"].includes(previous.status) ? `:${previous.id}` : "";
      const queued = await enqueueJob({ workspaceId, kind: "content:generate", payload, enqueuedBy: session.userId, idempotencyKey: `draft:${key}${retry}` });
      await write(store, `guides/${guideId}.json`, { ...latest, activeDraftJobId: queued.jobId });
      return queued;
    });
    res.status(202).json({ jobId: job.jobId, status: job.status, created: job.created });
  }));
  app.get("/api/guides/:id/draft-jobs/:jobId", endpoint(async (req, res) => {
    const { store, workspaceId } = await workspace(req, PERMISSIONS.guide_read);
    const job = await getJob(workspaceId, id(req, "jobId"));
    if (!job || job.kind !== "content:generate" || job.payload.guideId !== id(req)) throw new ApiFailure(404, "not_found", "Draft job not found.");
    const draft = job.status === "succeeded" ? await read(store, `drafts/${job.id}.json`) : null;
    res.json({ jobId: job.id, status: job.status, error: job.last_error, draft, expectedVersion: job.payload.expectedVersion, source: job.payload.source, options: job.payload.options });
  }));
  app.post("/api/guides/:id/draft-jobs/:jobId/apply", endpoint(async (req, res) => {
    const { store, workspaceId, session } = await workspace(req, PERMISSIONS.guide_update);
    const guideId = id(req);
    const job = await getJob(workspaceId, id(req, "jobId"));
    if (!job || job.kind !== "content:generate" || job.payload.guideId !== guideId || job.status !== "succeeded") throw new ApiFailure(404, "not_found", "Completed draft job not found.");
    const body = objectBody(req);
    const draft = await read(store, `drafts/${job.id}.json`);
    if (!draft) throw new ApiFailure(404, "not_found", "Draft result not found.");
    const saved = await locked(workspaceId, guideId, async () => {
      const current = await guide(store, guideId);
      if (body.expectedVersion !== current.version || current.version !== job.payload.expectedVersion) throw new ApiFailure(409, "version_conflict", "The guide changed while generation was running. Your existing changes have been preserved.");
      const steps = normalizeSteps(draft.steps, workspaceId);
      return saveVersion(store, current, { title: draft.title, introduction: draft.introduction, prerequisites: draft.prerequisites, tips: draft.tips, faq: draft.faq, glossary: draft.glossary, steps, aiDraftJobId: job.id, activeDraftJobId: null, aiProvenance: draft.provenance, reviewedVersion: null }, session.userId);
    });
    await appendActivity(workspaceId, session.userId, "guide.ai_draft_applied", guideId, "Applied an AI draft awaiting human review").catch(error => req.log.warn({ err: error }, "Draft applied but activity recording failed"));
    res.json({ guide: saved });
  }));
  app.post("/api/guides/:id/review", endpoint(async (req, res) => {
    const { store, workspaceId, session } = await workspace(req, PERMISSIONS.review_decide);
    const guideId = id(req);
    const body = objectBody(req);
    if (body.confirmed !== true) throw new ApiFailure(400, "review_required", "Confirm that you reviewed the instructions.");
    const reviewed = await locked(workspaceId, guideId, async () => {
      const current = await guide(store, guideId);
      if (body.expectedVersion !== current.version) throw new ApiFailure(409, "version_conflict", "The guide changed. Review its current revision.");
      const updated = { ...current, reviewedVersion: current.version, reviewedBy: session.userId, reviewedAt: new Date().toISOString() };
      await write(store, `guides/${guideId}.json`, updated);
      return updated;
    });
    await appendActivity(workspaceId, session.userId, "guide.reviewed", guideId, `Approved revision ${reviewed.version} after human review`).catch(error => req.log.warn({ err: error }, "Review saved but activity recording failed"));
    res.json({ guide: reviewed });
  }));
  app.get("/api/jobs/:jobId", endpoint(async (req, res) => {
    const { workspaceId } = await workspace(req, PERMISSIONS.guide_read);
    const job = await getJob(workspaceId, id(req, "jobId"));
    if (!job) throw new ApiFailure(404, "not_found", "Job not found.");
    res.json({ job: { id: job.id, kind: job.kind, status: job.status, result: job.result, error: job.last_error } });
  }));
}
