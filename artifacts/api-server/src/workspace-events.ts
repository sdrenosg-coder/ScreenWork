import { randomUUID } from "node:crypto";
import { forWorkspace } from "@workspace/zipy/storage/routeStore";

export async function appendActivity(workspaceId: string, actorId: string, kind: string, resourceId: string, summary: string) {
  const store = await forWorkspace(workspaceId);
  const at = new Date().toISOString();
  const id = randomUUID();
  const entry = {
    id, at, kind, actorId, actorDisplay: null, summary,
    resourceType: kind.startsWith("branding.") ? "branding" : "guide",
    resourceId, metadata: {},
  };
  await store.put(`activity/${at.slice(0, 10)}/${id}.json`, Buffer.from(JSON.stringify(entry)), { contentType: "application/json" });
}
