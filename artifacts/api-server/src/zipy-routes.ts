import type { Express, Request as ExpressRequest, Response as ExpressResponse } from "express";
import { loadGuide } from "@workspace/zipy/web/public-guide";
import * as route0 from "./imported/admin/audit/route";
import * as route1 from "./imported/admin/retention/route";
import * as route2 from "./imported/analytics/events/route";
import * as route3 from "./imported/annotations/[id]/route";
import * as route4 from "./imported/artifacts/upload/route";
import * as route5 from "./imported/auth/login/route";
import * as route6 from "./imported/auth/signup/route";
import * as route7 from "./imported/billing/usage/route";
import * as route8 from "./imported/fusion/[id]/conflicts/route";
import * as route9 from "./imported/guides/[id]/export/route";
import * as route10 from "./imported/guides/[id]/generate/route";
import * as route11 from "./imported/screenshots/[id]/redact/route";
import * as route12 from "./imported/sources/combine/route";
import * as route13 from "./imported/sources/file/route";
import * as route14 from "./imported/sources/text/route";
import * as route15 from "./imported/sources/url/route";
import * as route16 from "./imported/styles/[id]/route";
import * as route17 from "./imported/v1/guides/route";
import * as route18 from "./imported/v1/workflows/route";
import * as route19 from "./imported/workflows/[id]/synthesize/route";

type Handler = (request: Request, context: { params: Record<string, string> }) => Promise<Response>;
function register(app: Express, url: string, handlers: Record<string, unknown>) {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const handler = handlers[method] as Handler | undefined;
    if (!handler) continue;
    (app as any)[method.toLowerCase()](url, async (req: ExpressRequest, res: ExpressResponse) => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const request = new Request("http://replit.internal" + req.originalUrl, {
          method, headers,
          ...(method !== "GET" && method !== "HEAD" && req.body?.length ? { body: req.body } : {}),
        });
        const response = await handler(request, { params: req.params as Record<string, string> });
        res.status(response.status);
        response.headers.forEach((value, key) => { if (key !== "set-cookie") res.setHeader(key, value); });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) res.setHeader("set-cookie", cookies);
        res.send(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        req.log.error({ err: error }, "Imported route failed");
        res.status(500).json({ error: "server_error", message: "The request could not complete. Check server logs." });
      }
    });
  }
}
export function registerZipyRoutes(app: Express) {
  register(app, "/api/admin/audit", route0);
  register(app, "/api/admin/retention", route1);
  register(app, "/api/analytics/events", route2);
  register(app, "/api/annotations/:id", route3);
  register(app, "/api/artifacts/upload", route4);
  register(app, "/api/auth/login", route5);
  register(app, "/api/auth/signup", route6);
  register(app, "/api/billing/usage", route7);
  register(app, "/api/fusion/:id/conflicts", route8);
  register(app, "/api/guides/:id/export", route9);
  register(app, "/api/guides/:id/generate", route10);
  register(app, "/api/screenshots/:id/redact", route11);
  register(app, "/api/sources/combine", route12);
  register(app, "/api/sources/file", route13);
  register(app, "/api/sources/text", route14);
  register(app, "/api/sources/url", route15);
  register(app, "/api/styles/:id", route16);
  register(app, "/api/v1/guides", route17);
  register(app, "/api/v1/workflows", route18);
  register(app, "/api/workflows/:id/synthesize", route19);
  app.get("/api/public-guides/:slug", async (req, res) => { res.json(await loadGuide(req.params.slug)); });
  app.use("/api", (_req, res) => { res.status(404).json({ error: "not_found", message: "This endpoint was not included in the imported app." }); });
}
