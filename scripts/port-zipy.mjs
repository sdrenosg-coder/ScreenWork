// One-time, reproducible import conversion. The original remains in .migration-backup.
import fs from "node:fs";
import path from "node:path";

const backup = ".migration-backup";
const web = "artifacts/zipy-ai";
const api = "artifacts/api-server";
const shared = "lib/zipy";
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
function imports(text) {
  return text.replaceAll('-- `updated_at` triggers', '-- updated_at triggers')
    .replaceAll('-- The order in which the user attached the source. Ties on `source_priority`',
      '-- The order in which the user attached the source. Ties on source_priority')
    .replaceAll('@/lib/config', '@workspace/zipy/web/config')
    .replaceAll('@zipy/../apps/web/src/lib/config', '@workspace/zipy/web/config')
    .replace(/@zipy\/([^/"']+)(?=["'])/g, '@workspace/zipy/$1/index')
    .replaceAll('@zipy/', '@workspace/zipy/');
}
// Preserve the imported domain code in one shared workspace package.
for (const dir of fs.readdirSync(`${backup}/packages`, { withFileTypes: true })) {
  if (!dir.isDirectory() || !fs.existsSync(`${backup}/packages/${dir.name}/src`)) continue;
  for (const source of files(`${backup}/packages/${dir.name}/src`)) {
    const relative = path.relative(`${backup}/packages/${dir.name}/src`, source);
    write(`${shared}/src/${dir.name}/${relative}`, imports(fs.readFileSync(source, 'utf8')));
  }
}
write(`${shared}/package.json`, JSON.stringify({
  name: '@workspace/zipy', version: '0.1.0', private: true, type: 'module',
  exports: { './*': './src/*.ts' },
  dependencies: { pg: '^8.16.3', 'pdf-lib': '^1.17.1', sharp: '^0.34.5' }
}, null, 2) + '\n');
for (const source of files(`${backup}/apps/web/src/lib`)) {
  write(`${shared}/src/web/${path.relative(`${backup}/apps/web/src/lib`, source)}`,
    imports(fs.readFileSync(source, 'utf8')).replaceAll('@/lib/', '@workspace/zipy/web/'));
}
const routeImports = [];
const registrations = [];
for (const source of files(`${backup}/apps/web/src/app/api`)) {
  const relative = path.relative(`${backup}/apps/web/src/app/api`, source);
  const text = imports(fs.readFileSync(source, 'utf8'))
    .replaceAll('NextResponse', 'HttpResponse')
    .replaceAll('from "next/server"', 'from "@/lib/http-response"')
    .replaceAll('@/lib/auth/', '@workspace/zipy/web/auth/')
    .replaceAll('@/lib/rbac/', '@workspace/zipy/web/rbac/')
    .replaceAll('@/lib/config', '@workspace/zipy/web/config');
  write(`${api}/src/imported/${relative}`, text);
  if (!relative.endsWith('route.ts')) continue;
  const name = `route${routeImports.length}`;
  routeImports.push(`import * as ${name} from "./imported/${relative.replace(/\.ts$/, '')}";`);
  const url = '/api/' + path.dirname(relative).split(path.sep)
    .map(segment => segment.replace(/^\[(.+)\]$/, ':$1')).join('/');
  registrations.push(`  register(app, ${JSON.stringify(url)}, ${name});`);
}
// Move the server-only public guide loader out of the browser.
const publicPath = `${web}/src/app/p/[slug]/page.tsx`;
let publicPage = fs.readFileSync(publicPath, 'utf8');
const dataStart = publicPage.indexOf('const PUBLIC_GUIDES_PREFIX');
const dataEnd = publicPage.indexOf('/* -------------------------------------------------------------------------- */\n/* Image URL builder');
const types = publicPage.slice(publicPage.indexOf('type PublicGuideRecord'), dataStart);
write(`${shared}/src/web/public-guide.ts`,
  'import { forWorkspace } from "@workspace/zipy/storage/objectStore";\n' +
  types + publicPage.slice(dataStart, dataEnd).replace('async function loadGuide', 'export async function loadGuide'));
publicPage = publicPage.replace('import type { Metadata } from "next";',
  'import { useEffect, useState } from "react";')
  .replace('import Link from "next/link";', 'import { Link } from "wouter";')
  .replace('import { forWorkspace } from "@zipy/storage/objectStore";', '')
  .slice(0, dataStart - ('import type { Metadata } from "next";'.length - 'import { useEffect, useState } from "react";'.length));
// Use positions from the unchanged original for the rendering half.
const original = fs.readFileSync(publicPath, 'utf8');
const imageStart = original.indexOf('function imageUrlFor');
const metadataStart = original.indexOf('export async function generateMetadata');
const componentStart = original.indexOf('export default async function PublicGuidePage');
publicPage = 'import { useEffect, useState } from "react";\nimport { Link } from "wouter";\n' +
  types + original.slice(imageStart, metadataStart) +
  original.slice(componentStart).replace('export default async function', 'export default function')
    .replace('const result = await loadGuide(params.slug);', `const [result, setResult] = useState<LoadResult | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    fetch("/api/public-guides/" + encodeURIComponent(params.slug), { signal: controller.signal })
      .then(r => r.json()).then(setResult)
      .catch(error => { if (!controller.signal.aborted) setResult({ kind: "storage_error", message: error.message }); });
    return () => controller.abort();
  }, [params.slug]);
  useEffect(() => { if (result?.kind === "rendered") document.title = result.model.title + " · Zipy AI"; }, [result]);
  if (!result) return <p role="status">Loading guide…</p>;`);
write(publicPath, publicPage);
// Keep the inline-styled layout, without nested document elements.
let layout = fs.readFileSync(`${web}/src/app/layout.tsx`, 'utf8');
layout = layout.slice(layout.indexOf('export default function'))
  .replace(/<html lang="en">[\s\S]*?<\/head>/, '<>')
  .replace('<body', '<div').replace('</body>', '</div>').replace('</html>', '</>');
write(`${web}/src/app/layout.tsx`, 'import type { ReactNode } from "react";\n' + layout);
for (const source of files(`${web}/src/app`).filter(f => f.endsWith('.tsx') && !f.endsWith('layout.tsx') && f !== publicPath)) {
  write(source, fs.readFileSync(source, 'utf8').replace('import Link from "next/link";', 'import { Link } from "wouter";'));
}
// Remove server-only copies from the static frontend.
fs.rmSync(`${web}/src/app/api`, { recursive: true, force: true });
fs.rmSync(`${web}/src/lib/auth`, { recursive: true, force: true });
fs.rmSync(`${web}/src/lib/rbac`, { recursive: true, force: true });
fs.rmSync(`${web}/src/lib/config.ts`, { force: true });
write(`${api}/src/zipy-routes.ts`, `import type { Express, Request as ExpressRequest, Response as ExpressResponse } from "express";
import { loadGuide } from "@workspace/zipy/web/public-guide";
${routeImports.join('\n')}

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
${registrations.join('\n')}
  app.get("/api/public-guides/:slug", async (req, res) => { res.json(await loadGuide(req.params.slug)); });
  app.use("/api", (_req, res) => { res.status(404).json({ error: "not_found", message: "This endpoint was not included in the imported app." }); });
}
`);
console.info('Preserved domain libraries, converted API handlers, and separated browser/server code.');
// Preserve the separate worker entrypoint; it remains idle until its original
// job handlers and required services are configured.
for (const source of files(`${backup}/apps/worker/src`)) {
  write(`scripts/src/zipy-worker/${path.relative(`${backup}/apps/worker/src`, source)}`,
    imports(fs.readFileSync(source, 'utf8')));
}
