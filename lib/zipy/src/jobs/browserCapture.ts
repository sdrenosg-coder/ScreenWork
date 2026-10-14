import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { readdir, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { publicIPv4, validatePublicUrlSyntax } from "./sourceReader";
import { forWorkspace } from "../storage/routeStore";
import { putMedia } from "../storage/mediaStore";
import type { JobHandler } from "./runner";

async function resolvePublic(value: string) {
  const url = validatePublicUrlSyntax(value);
  const records = await lookup(url.hostname, { all: true, family: 4 });
  if (!records.length || records.some(record => !publicIPv4(record.address))) throw new Error("Private and reserved network addresses are blocked.");
  return { url, address: records[0].address };
}
async function executable() {
  if (await access("/repl/tools/bin/chromium").then(() => true, () => false)) return "/repl/tools/bin/chromium";
  const names = (await readdir("/nix/store").catch(() => [])).filter(name => /-chromium-(?:unwrapped-)?\d/.test(name));
  names.sort((a, b) => Number(b.match(/chromium-(?:unwrapped-)?(\d+)/)?.[1] ?? 0) - Number(a.match(/chromium-(?:unwrapped-)?(\d+)/)?.[1] ?? 0));
  for (const name of names) {
    const file = `/nix/store/${name}/bin/chromium`;
    if (await access(file).then(() => true, () => false)) return file;
  }
  return undefined;
}
// All browser HTTP and CONNECT traffic goes through DNS-pinned public-IP
// validation, including subresources and redirects. No authenticated sessions.
export const browserCaptureHandler: JobHandler = async context => {
  const target = await resolvePublic(String(context.payload.url)).catch(error => context.fail(error instanceof Error ? error.message : "Invalid URL.", "invalid_url"));
  const sockets = new Set<import("node:net").Socket>();
  let requests = 0;
  const proxy = createServer(async (incoming, outgoing) => {
    try {
      if (++requests > 120 || !["GET", "HEAD"].includes(incoming.method ?? "")) throw new Error("Capture network limit reached.");
      const { url, address } = await resolvePublic(incoming.url ?? "");
      if (url.protocol !== "http:") throw new Error("HTTPS must use CONNECT.");
      const upstream = httpRequest(url, { method: incoming.method, headers: { host: url.host }, lookup: (_h, _o, callback) => callback(null, address, 4) }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        let bytes = 0;
        response.on("data", chunk => { bytes += chunk.length; if (bytes > 4_000_000) response.destroy(); });
        response.pipe(outgoing);
      });
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); upstream.end();
    } catch { outgoing.writeHead(403); outgoing.end(); }
  });
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  proxy.on("connect", async (incoming, client, head) => {
    try {
      if (++requests > 120) throw new Error("Capture network limit reached.");
      const { url, address } = await resolvePublic(`https://${incoming.url}/`);
      if (url.port && url.port !== "443") throw new Error("Blocked CONNECT port.");
      const upstream = connect(443, address);
      sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
      upstream.setTimeout(20000, () => upstream.destroy());
      upstream.on("connect", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
      let count = 0;
      upstream.on("data", chunk => { count += chunk.length; if (count > 16_000_000) upstream.destroy(); });
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
    } catch { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); }
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const address = proxy.address();
  if (!address || typeof address === "string") context.fail("Capture proxy failed to start.", "browser_unavailable");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: await executable(), headless: true,
      proxy: { server: `http://127.0.0.1:${(address as import("node:net").AddressInfo).port}` },
      args: ["--no-sandbox", "--disable-quic", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", acceptDownloads: false });
    await page.route("**/*", async route => {
      const request = route.request();
      if (!["GET", "HEAD"].includes(request.method())) { await route.abort(); return; }
      try { validatePublicUrlSyntax(request.url()); await route.continue(); } catch { await route.abort(); }
    });
    const onAbort = () => { void browser?.close(); };
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await page.goto(target.url.href, { waitUntil: "domcontentloaded", timeout: 25000 });
      if (!response || !response.ok()) throw new Error(`Public page returned HTTP ${response?.status() ?? "no response"}.`);
      const observed = await page.evaluate(() => ({
        title: document.title, text: document.body?.innerText.slice(0, 18000) ?? "",
        elements: Array.from(document.querySelectorAll("button,a,input,select,textarea,[role]")).slice(0, 120).map(element => ({
          role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
          name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 150),
        })),
      }));
      if (!observed.text.trim()) throw new Error("The public page returned no readable content.");
      const image = await page.screenshot({ type: "jpeg", quality: 80, timeout: 10000 });
      const sourceId = randomUUID();
      await putMedia(context.workspaceId, sourceId, image, "image/jpeg");
      const text = `Public browser observation: ${page.url()}\nPage title: ${observed.title}\n${observed.text}\n\nObserved accessibility/UI labels:\n${observed.elements.map(element => `${element.role}: ${element.name}`).join("\n")}\n\nRead-only capture; no controls were clicked and no workflow execution was verified.`;
      const storageKey = `sources/processed/${context.jobId}.json`, store = await forWorkspace(context.workspaceId);
      await store.put(storageKey, Buffer.from(JSON.stringify({ text, kind: "browser", sourceId, url: page.url(), title: observed.title, elements: observed.elements })), { contentType: "application/json" });
      return { storageKey, sourceId, kind: "browser", title: observed.title };
    } finally { context.signal.removeEventListener("abort", onAbort); }
  } catch (error) { return context.fail(error instanceof Error ? error.message : "Browser capture failed.", "capture_failed"); }
  finally {
    await browser?.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
};
