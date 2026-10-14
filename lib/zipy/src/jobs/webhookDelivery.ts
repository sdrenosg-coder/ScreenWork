import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { forWorkspace } from "../storage/routeStore";
import { enqueueJob } from "./queue";
import { publicIPv4, validatePublicUrlSyntax } from "./sourceReader";
import type { JobHandler } from "./runner";

type Doc = Record<string, unknown>;
function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Session encryption is not configured.");
  return createHash("sha256").update(`zipy-webhooks:${secret}`).digest();
}
export function encryptHookSecret(secret: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const bytes = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${bytes.toString("base64")}`;
}
function decrypt(value: string) {
  const [iv, tag, bytes] = value.split(".").map(part => Buffer.from(part, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8");
}
export async function enqueueWorkspaceHooks(workspaceId: string, event: Doc, onlyHookId?: string) {
  const store = await forWorkspace(workspaceId);
  const list = await store.list("webhooks/config/", { limit: 50 });
  for (const entry of list.entries) {
    const bytes = await store.get(entry.key); if (!bytes) continue;
    const hook = JSON.parse(bytes.toString()) as Doc;
    if (!hook.enabled || (onlyHookId ? hook.id !== onlyHookId : !Array.isArray(hook.events) || !hook.events.includes(event.kind))) continue;
    const id = randomUUID();
    await store.put(`webhooks/deliveries/${id}.json`, Buffer.from(JSON.stringify({ id, hookId: hook.id, kind: event.kind, status: "queued", at: new Date().toISOString() })), { contentType: "application/json" });
    await enqueueJob({ workspaceId, kind: "webhooks:dispatch", payload: { deliveryId: id, hookId: hook.id, event }, idempotencyKey: `webhook:${hook.id}:${event.id}`, enqueuedBy: null });
  }
}
export const webhookHandler: JobHandler = async context => {
  const store = await forWorkspace(context.workspaceId), hookId = String(context.payload.hookId), id = String(context.payload.deliveryId);
  if (!/^[a-f0-9-]{36}$/i.test(hookId) || !/^[a-f0-9-]{36}$/i.test(id)) context.fail("Invalid webhook identity.", "invalid_webhook");
  const raw = await store.get(`webhooks/config/${hookId}.json`);
  if (!raw) context.fail("Webhook was removed before delivery.", "webhook_removed");
  const hook = JSON.parse(raw!.toString()) as Doc;
  let httpStatus: number | null = null, error: string | null = null;
  try {
    const url = validatePublicUrlSyntax(String(hook.url));
    if (url.protocol !== "https:") throw new Error("Only HTTPS webhook delivery is permitted.");
    const addresses = await lookup(url.hostname, { all: true, family: 4 });
    if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) throw new Error("Webhook resolved to a blocked network address.");
    const data = JSON.stringify({ ...context.payload.event as Doc, workspaceId: context.workspaceId });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", decrypt(String(hook.secretCipher))).update(`${timestamp}.${data}`).digest("hex");
    httpStatus = await new Promise<number>((resolve, reject) => {
      const req = request(url, {
        method: "POST", family: 4, signal: context.signal,
        lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, 4),
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-zipy-id": id, "x-zipy-timestamp": timestamp, "x-zipy-signature": `sha256=${signature}` },
      }, response => {
        response.resume(); resolve(response.statusCode ?? 0);
      });
      req.setTimeout(10000, () => req.destroy(new Error("Webhook delivery timed out.")));
      req.on("error", reject); req.end(data);
    });
    if (httpStatus < 200 || httpStatus >= 300) error = `Receiver returned HTTP ${httpStatus}; redirects are not followed.`;
  } catch (failure) { error = failure instanceof Error ? failure.message : "Delivery failed."; }
  const result = { id, hookId, kind: (context.payload.event as Doc)?.kind, status: error ? "failed" : "delivered", httpStatus, error, at: new Date().toISOString() };
  await store.put(`webhooks/deliveries/${id}.json`, Buffer.from(JSON.stringify(result)), { contentType: "application/json" });
  // Persist receiver failures without an automatic duplicate outbound POST.
  return result;
};
