import { createHash } from "node:crypto";
import type { Express, Request } from "express";
import { forWorkspace } from "@workspace/zipy/storage/routeStore";
import { ApiFailure, endpoint, objectBody, locked, read, write, type RecordData } from "./saas-routes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rateBuckets = new Map<string, { count: number; expires: number }>();

async function published(req: Request) {
  const slug = String(req.params.slug);
  if (!/^[a-z0-9][a-z0-9-]{0,159}$/i.test(slug)) throw new ApiFailure(404, "not_found", "Published guide not found.");
  const registry = await forWorkspace("__public__");
  const pointer = await read(registry, `public-guides/${slug}.json`);
  if (!pointer || pointer.access !== "public" || !UUID.test(String(pointer.guideId)) || !UUID.test(String(pointer.workspaceId))) {
    throw new ApiFailure(404, "not_found", "This guide is not publicly available.");
  }
  const guideId = String(pointer.guideId);
  const workspaceId = String(pointer.workspaceId);
  const key = pointer.snapshotKey ?? `guides/${guideId}/draft-current.json`;
  if (typeof key !== "string" || (key !== `guides/${guideId}/draft-current.json` && !new RegExp(`^guides/${guideId}/published/[1-9][0-9]*\\.json$`).test(key))) {
    throw new ApiFailure(404, "not_found", "Published guide not found.");
  }
  const store = await forWorkspace(workspaceId);
  const snapshot = await read(store, key);
  if (!snapshot) throw new ApiFailure(404, "not_found", "Published guide not found.");
  return { slug, guideId, workspaceId, store, snapshot };
}

function rateLimit(req: Request, guideId: string) {
  const now = Date.now();
  if (rateBuckets.size > 2000) for (const [key, value] of rateBuckets) if (value.expires <= now) rateBuckets.delete(key);
  const key = `${guideId}:${createHash("sha256").update(req.ip ?? "proxy").digest("hex")}`;
  const existing = rateBuckets.get(key);
  const bucket = existing && existing.expires > now ? existing : { count: 0, expires: now + 60000 };
  if (rateBuckets.size >= 10000 || ++bucket.count > 120) throw new ApiFailure(429, "rate_limited", "Progress tracking is busy. Please try again shortly.");
  rateBuckets.set(key, bucket);
}

export function registerReaderRoutes(app: Express) {
  app.post("/api/public-guides/:slug/events", endpoint(async (req, res) => {
    if (Buffer.isBuffer(req.body) && req.body.length > 1024) throw new ApiFailure(413, "validation_error", "The tracking event is too large.");
    const body = objectBody(req);
    if (!["view", "complete"].includes(String(body.kind)) || !UUID.test(String(body.visitId))) {
      throw new ApiFailure(400, "validation_error", "A valid anonymous visit and event kind are required.");
    }
    const { store, guideId, workspaceId } = await published(req);
    rateLimit(req, guideId);
    const viewKey = `reader-events/${guideId}/${body.visitId}-view.json`;
    const completeKey = `reader-events/${guideId}/${body.visitId}-complete.json`;
    const result = await locked(workspaceId, `reader/${guideId}/${body.visitId}`, async () => {
      const view = await read(store, viewKey);
      const complete = await read(store, completeKey);
      if (body.kind === "complete" && !view) throw new ApiFailure(409, "view_required", "Open the guide before marking it complete.");
      const duplicate = body.kind === "view" ? view !== null : complete !== null;
      if (!duplicate) await write(store, body.kind === "view" ? viewKey : completeKey, {
        kind: body.kind, guideId, visitId: body.visitId, at: new Date().toISOString(),
      });
      return { recorded: true, duplicate, completed: body.kind === "complete" || complete !== null };
    });
    res.json(result);
  }));

  app.get("/api/public-guides/:slug/download", endpoint(async (req, res) => {
    const { slug, snapshot } = await published(req);
    const format = String(req.query.format ?? "markdown");
    if (!["markdown", "json"].includes(format)) throw new ApiFailure(400, "validation_error", "Choose markdown or json.");
    const steps = (Array.isArray(snapshot.steps) ? snapshot.steps : []).map((value, i) => {
      const step = value as RecordData;
      return { index: i + 1, title: String(step.title ?? ""), description: String(step.description ?? "") };
    });
    const document = { title: String(snapshot.title ?? "Guide"), summary: snapshot.summary ?? null, steps };
    res.setHeader("Content-Disposition", `attachment; filename="${slug}.${format === "json" ? "json" : "md"}"`);
    if (format === "json") res.type("application/json").send(JSON.stringify(document, null, 2));
    else res.type("text/markdown").send(`# ${document.title}\n\n${steps.map(step => `## ${step.index}. ${step.title}\n\n${step.description}\n`).join("\n")}`);
  }));

  app.get("/api/public-guides/:slug/theme", endpoint(async (req, res) => {
    const { store } = await published(req);
    const saved = await read(store, "settings/branding.json");
    const input = saved?.input as RecordData | undefined;
    // The imported enabled flag means white-labelling (remove platform branding),
    // not whether a saved palette and brand identity should be applied.
    if (!input) { res.json({ enabled: false }); return; }
    const colors = ((input.tokenOverrides as RecordData | null)?.colors ?? {}) as RecordData;
    const fonts = (input.fontInput as { picks?: RecordData[] } | null)?.picks ?? [];
    const logos = Array.isArray(input.logos) ? input.logos as RecordData[] : [];
    const logo = logos.find(pick => pick.surface === "guide-header")?.logo as RecordData | undefined;
    res.json({
      enabled: true, whiteLabel: input.enabled === true, brandName: input.brandName, legalFooterText: input.legalFooterText,
      colors: Object.fromEntries(Object.entries(colors).filter(([, value]) => typeof value === "string" && /^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/i.test(value))),
      fonts: fonts.map(font => ({ role: font.role, family: font.family, weight: font.weight, fallbackFamilies: font.fallbackFamilies })),
      logo: logo ? { alt: String(logo.altText ?? input.brandName ?? "Brand logo") } : null,
    });
  }));

  app.get("/api/public-guides/:slug/logo", endpoint(async (req, res) => {
    const { store } = await published(req);
    const saved = await read(store, "settings/branding.json");
    const input = saved?.input as RecordData | undefined;
    const pick = input && Array.isArray(input.logos)
      ? input.logos.find((value: RecordData) => value.surface === "guide-header") : null;
    const logo = pick?.logo as RecordData | undefined;
    if (!logo || typeof logo.storageKey !== "string") throw new ApiFailure(404, "not_found", "No published logo.");
    const bytes = await store.get(logo.storageKey);
    if (!bytes || bytes.length > 2097152) throw new ApiFailure(404, "not_found", "Logo is unavailable.");
    const mime = String(logo.mimeType);
    const valid = mime === "image/png" ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
      : mime === "image/jpeg" ? bytes.subarray(0, 3).toString("hex") === "ffd8ff"
      : mime === "image/webp" ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
      : mime === "image/gif" ? /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)) : false;
    if (!valid) throw new ApiFailure(404, "not_found", "Use a valid PNG, JPEG, WebP or GIF logo.");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    res.type(mime).send(bytes);
  }));
}
