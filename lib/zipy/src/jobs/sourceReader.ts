import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

function publicIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51)) && !(a === 203 && b === 0);
}

export function validatePublicUrlSyntax(value: string): URL {
  const url = new URL(value);
  if (value.length > 2048 || !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    (url.port && !["80", "443"].includes(url.port)) || url.hostname.endsWith(".local") ||
    url.hostname === "localhost" || !/^[a-z0-9.-]+$/i.test(url.hostname) ||
    (/^[0-9.]+$/.test(url.hostname) && !publicIPv4(url.hostname))) {
    throw new Error("Provide a public HTTP/HTTPS page URL without embedded credentials, internal addresses or non-standard ports.");
  }
  return url;
}

/** Resolve, validate and pin DNS for every redirect. Never fetch internal hosts. */
export async function readPublicUrl(value: string, signal: AbortSignal): Promise<string> {
  let url = validatePublicUrlSyntax(value);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port)) || url.hostname.endsWith(".local") || url.hostname === "localhost") {
      throw new Error("Only public HTTP/HTTPS pages on standard ports can be ingested.");
    }
    const addresses = await lookup(url.hostname, { all: true, family: 4 });
    if (!addresses.length || addresses.some(record => !publicIPv4(record.address))) throw new Error("Private, reserved and internal network addresses are blocked.");
    const pinned = addresses[0].address;
    const result = await new Promise<{ redirect?: string; text?: string }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        signal,
        headers: { "user-agent": "ZipySourceReader/1.0", accept: "text/html,text/plain", "accept-encoding": "identity" },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: pinned, family: 4 }]);
          else callback(null, pinned, 4);
        },
      }, response => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume(); resolve({ redirect: response.headers.location }); return;
        }
        if (status < 200 || status > 299) { response.resume(); reject(new Error(`Source page returned HTTP ${status}.`)); return; }
        if (!/^(text\/html|text\/plain|application\/xhtml\+xml)/i.test(String(response.headers["content-type"]))) {
          response.resume(); reject(new Error("The URL must return an HTML or plain-text page.")); return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2097152) { request.destroy(new Error("Source page exceeds the 2 MB limit.")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      });
      request.setTimeout(20000, () => request.destroy(new Error("Source page timed out.")));
      request.on("error", reject);
      request.end();
    });
    if (result.redirect) { url = validatePublicUrlSyntax(new URL(result.redirect, url).href); continue; }
    return String(result.text ?? "").replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/\s+/g, " ").trim().slice(0, 30000);
  }
  throw new Error("The source page redirected too many times.");
}
