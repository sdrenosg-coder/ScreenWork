import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Express } from "express";
import { getJob, enqueueJob } from "@workspace/zipy/jobs/queue";
import { getMedia } from "@workspace/zipy/storage/mediaStore";
import { validatePublicUrlSyntax } from "@workspace/zipy/jobs/sourceReader";
import { PERMISSIONS } from "@workspace/zipy/web/rbac/permissions";
import { ApiFailure, endpoint, workspace, guide, objectBody, locked, read, write, saveVersion } from "./saas-routes";
import { appendActivity } from "./workspace-events";

type Doc = Record<string, unknown>;
type Store = Awaited<ReturnType<typeof workspace>>["store"];
const escaped = (text: string) => text.replace(/[<>&"']/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);
async function source(store: Store, workspaceId: string, guideId: string, jobId: string) {
  const current = await guide(store, guideId);
  if (!Array.isArray(current.sourceJobIds) || !current.sourceJobIds.includes(jobId)) throw new ApiFailure(404, "not_found", "Image source not found.");
  const job = await getJob(workspaceId, jobId);
  if (!job || job.payload.guideId !== guideId || job.status !== "succeeded") throw new ApiFailure(404, "not_found", "Image source is not ready.");
  const sourceId = job.kind === "capture:screenshot" ? job.result?.sourceId : job.payload.sourceId;
  if (typeof sourceId !== "string" || !(job.kind === "ingest:image" || job.kind === "capture:screenshot")) throw new ApiFailure(400, "invalid_source", "Select an image or browser screenshot.");
  return { current, job, sourceId };
}
export function registerVisualRoutes(app: Express) {
  app.get("/api/guides/:id/visuals", endpoint(async (req, res) => {
    const { store, workspaceId } = await workspace(req, PERMISSIONS.guide_read), current = await guide(store, String(req.params.id));
    const ids = Array.isArray(current.sourceJobIds) ? current.sourceJobIds.filter((id): id is string => typeof id === "string") : [];
    const items = await Promise.all(ids.map(async jobId => {
      const job = await getJob(workspaceId, jobId);
      if (!job || job.payload.guideId !== current.id || !["ingest:image", "capture:screenshot"].includes(job.kind)) return null;
      const processed = typeof job.result?.storageKey === "string" ? await read(store, job.result.storageKey) : null;
      return { jobId, status: job.status, error: job.last_error, name: job.payload.filename ?? job.payload.url, text: processed?.text, imageUrl: job.status === "succeeded" ? `/api/guides/${current.id}/visuals/${jobId}/image` : null };
    }));
    res.json({ items: items.filter(Boolean), steps: current.steps.map(raw => { const step = raw as Doc; return { id: step.id, title: step.title }; }), version: current.version });
  }));
  app.get("/api/guides/:id/visuals/:jobId/image", endpoint(async (req, res) => {
    const { store, workspaceId } = await workspace(req, PERMISSIONS.guide_read);
    const image = await source(store, workspaceId, String(req.params.id), String(req.params.jobId));
    const bytes = await getMedia(workspaceId, image.sourceId);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(await sharp(bytes, { limitInputPixels: 64_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer());
  }));
  app.post("/api/guides/:id/visuals", endpoint(async (req, res) => {
    const { store, workspaceId, session } = await workspace(req, PERMISSIONS.guide_update), body = objectBody(req), guideId = String(req.params.id);
    if (body.action === "capture") {
      if (typeof body.url !== "string") throw new ApiFailure(400, "invalid_url", "Enter a public URL.");
      try { validatePublicUrlSyntax(body.url); } catch { throw new ApiFailure(400, "invalid_url", "Only public HTTP/HTTPS URLs on standard ports are permitted."); }
      const queued = await locked(workspaceId, guideId, async () => {
        const current = await guide(store, guideId), ids = Array.isArray(current.sourceJobIds) ? current.sourceJobIds : [];
        if (ids.length >= 20) throw new ApiFailure(409, "source_limit", "This guide already has 20 sources.");
        const pending = await Promise.all(ids.map(id => getJob(workspaceId, String(id))));
        if (pending.some(job => job?.kind === "capture:screenshot" && ["pending", "active"].includes(job.status))) throw new ApiFailure(409, "capture_pending", "A capture is already pending for this guide.");
        const job = await enqueueJob({ workspaceId, kind: "capture:screenshot", payload: { url: body.url, guideId, extension: "browser", filename: body.url }, enqueuedBy: session.userId });
        await write(store, `guides/${guideId}.json`, { ...current, sourceJobIds: [...ids, job.jobId] });
        return job;
      });
      res.json({ jobId: queued.jobId, message: "Read-only public browser capture queued. No login, form submission or workflow execution is performed." }); return;
    }
    if (body.action !== "annotate" || typeof body.sourceJobId !== "string" || typeof body.stepId !== "string" || !Array.isArray(body.marks) || body.marks.length > 30 || typeof body.altText !== "string" || !body.altText.trim() || body.altText.length > 1500) throw new ApiFailure(400, "invalid_input", "Select a source and saved step, supply alt text, and at most 30 valid annotations.");
    const loaded = await source(store, workspaceId, guideId, body.sourceJobId);
    const input = await getMedia(workspaceId, loaded.sourceId);
    const image = await sharp(input, { limitInputPixels: 64_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const metadata = await sharp(image).metadata(), width = metadata.width!, height = metadata.height!;
    const marks = body.marks.map(value => {
      if (!value || typeof value !== "object") throw new ApiFailure(400, "invalid_annotation", "Invalid annotation.");
      const mark = value as Doc;
      if (!["box", "arrow", "label", "redact"].includes(String(mark.kind))) throw new ApiFailure(400, "invalid_annotation", "Choose a box, arrow, label or solid redaction.");
      const coords = ["x", "y", "w", "h"].map(key => Number(mark[key]));
      if (coords.some(number => !Number.isFinite(number) || number < 0 || number > 1) || coords[0] + coords[2] > 1.001 || coords[1] + coords[3] > 1.001) throw new ApiFailure(400, "invalid_annotation", "Coordinates must fit inside the image.");
      return { kind: String(mark.kind), x: coords[0], y: coords[1], w: coords[2], h: coords[3], text: String(mark.text ?? "").slice(0, 200) };
    });
    const overlays = marks.map(mark => {
      const x = mark.x * width, y = mark.y * height, w = Math.max(2, mark.w * width), h = Math.max(2, mark.h * height);
      if (mark.kind === "redact") return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>`;
      if (mark.kind === "arrow") return `<path d="M${x},${y} L${x+w},${y+h}" stroke="#e84932" stroke-width="5" marker-end="url(#arrow)"/>`;
      if (mark.kind === "label") return `<rect x="${x}" y="${y}" width="${Math.max(w, 60)}" height="35" rx="6" fill="#092f30"/><text x="${x+8}" y="${y+24}" font-family="sans-serif" font-size="18" fill="white">${escaped(mark.text)}</text>`;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="none" stroke="#e84932" stroke-width="5"/>`;
    });
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#e84932"/></marker></defs>${overlays.join("")}</svg>`;
    const rendered = await sharp(image).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    const key = `artifacts/${randomUUID()}.png`;
    const updated = await locked(workspaceId, guideId, async () => {
      const current = await guide(store, guideId);
      if (current.version !== body.expectedVersion) throw new ApiFailure(409, "version_conflict", "The guide changed. Refresh before saving annotations.");
      if (!current.steps.some(raw => (raw as Doc).id === body.stepId)) throw new ApiFailure(404, "not_found", "Saved step no longer exists.");
      await store.put(key, rendered, { contentType: "image/png" });
      const steps = current.steps.map(raw => {
        const step = raw as Doc;
        return step.id === body.stepId ? { ...step, screenshotRef: key, altText: body.altText, annotations: marks, needsReview: true } : step;
      });
      return saveVersion(store, current, { steps, needsReview: true, reviewedVersion: null }, session.userId);
    });
    await appendActivity(workspaceId, session.userId, "guide.annotated", guideId, "Saved annotated screenshot in a new guide version");
    res.json({ version: updated.version, message: "Annotated screenshot saved to a new version. Review it before publishing. The original private source is unchanged." });
  }));
}
