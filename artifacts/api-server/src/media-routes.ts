import { randomUUID } from "node:crypto";
import type { Express } from "express";
import multer from "multer";
import { enqueueJob, getJob, type JobKind } from "@workspace/zipy/jobs/queue";
import { putMedia, deleteMedia } from "@workspace/zipy/storage/mediaStore";
import { PERMISSIONS } from "@workspace/zipy/web/rbac/permissions";
import { ApiFailure, endpoint, workspace, guide, locked, write, read } from "./saas-routes";

const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 16 * 1024 * 1024, fields: 0 } }).single("file");
const kinds: Record<string, JobKind> = {
  pdf: "ingest:pdf", docx: "ingest:docx", pptx: "ingest:pptx", xlsx: "ingest:docx",
  mp3: "ingest:audio", wav: "ingest:audio", m4a: "ingest:audio", ogg: "ingest:audio",
  mp4: "ingest:video", webm: "ingest:video", mov: "ingest:video",
  png: "ingest:image", jpg: "ingest:image", jpeg: "ingest:image", webp: "ingest:image",
};
const uuid = /^[0-9a-f-]{36}$/i;
export function registerMediaRoutes(app: Express) {
  app.post("/api/guides/:id/sources", endpoint(async (req, res) => {
    const { store, workspaceId, session } = await workspace(req, PERMISSIONS.guide_update);
    const guideId = String(req.params.id);
    if (!uuid.test(guideId)) throw new ApiFailure(400, "validation_error", "Invalid guide identity.");
    await guide(store, guideId);
    await new Promise<void>((resolve, reject) => upload(req, res, error => error ? reject(new ApiFailure(400, "upload_invalid", "Upload one file of at most 16 MB.")) : resolve()));
    const file = req.file;
    if (!file?.buffer?.length) throw new ApiFailure(400, "upload_required", "Choose a file.");
    const extension = file.originalname.split(".").at(-1)?.toLowerCase() ?? "";
    if (!kinds[extension]) throw new ApiFailure(400, "unsupported_file", "Use PDF, DOCX, PPTX, XLSX, PNG/JPEG/WebP, or a supported audio/video file.");
    const sourceId = randomUUID();
    await putMedia(workspaceId, sourceId, file.buffer, file.mimetype);
    try {
      const job = await locked(workspaceId, guideId, async () => {
        const current = await guide(store, guideId);
        const previous = Array.isArray(current.sourceJobIds) ? current.sourceJobIds.filter(value => typeof value === "string") : [];
        if (previous.length >= 20) throw new ApiFailure(400, "source_limit", "This guide has reached its 20-source limit.");
        const queued = await enqueueJob({
          workspaceId, kind: kinds[extension], payload: { sourceId, extension, filename: file.originalname.slice(0, 200), guideId },
          enqueuedBy: session.userId, idempotencyKey: `upload:${sourceId}`,
        });
        await write(store, `guides/${guideId}.json`, { ...current, sourceJobIds: [...previous, queued.jobId] });
        return queued;
      });
      res.status(202).json({ jobId: job.jobId, status: job.status, filename: file.originalname.slice(0, 200) });
    } catch (error) { await deleteMedia(workspaceId, sourceId).catch(() => {}); throw error; }
  }));
  app.get("/api/guides/:id/sources", endpoint(async (req, res) => {
    const { store, workspaceId } = await workspace(req, PERMISSIONS.guide_read);
    const current = await guide(store, String(req.params.id));
    const ids = Array.isArray(current.sourceJobIds) ? current.sourceJobIds.filter((value): value is string => typeof value === "string").slice(0, 20) : [];
    const sources = await Promise.all(ids.map(async jobId => {
      const job = await getJob(workspaceId, jobId);
      if (!job || job.payload.guideId !== current.id || !job.kind.startsWith("ingest:")) return null;
      const result = job.result as Record<string, unknown> | null;
      const extracted = job.status === "succeeded" && typeof result?.storageKey === "string" ? await read(store, result.storageKey) : null;
      return { jobId, filename: job.payload.filename, kind: job.payload.extension, status: job.status, error: job.last_error ?? null, text: extracted?.text ?? null };
    }));
    res.json({ sources: sources.filter(Boolean) });
  }));
}
