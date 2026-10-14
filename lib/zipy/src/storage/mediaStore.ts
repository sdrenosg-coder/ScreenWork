import { Storage } from "@google-cloud/storage";
const sidecar = "http://127.0.0.1:1106";
const client = new Storage({
  credentials: {
    audience: "replit", subject_token_type: "access_token", token_url: `${sidecar}/token`,
    type: "external_account", credential_source: {
      url: `${sidecar}/credential`, format: { type: "json", subject_token_field_name: "access_token" },
    }, universe_domain: "googleapis.com",
  }, projectId: "",
});
function file(workspaceId: string, sourceId: string) {
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(workspaceId) || !uuid.test(sourceId)) throw new Error("Invalid media identity.");
  const directory = process.env.PRIVATE_OBJECT_DIR;
  if (!directory) throw new Error("Persistent media storage is not configured.");
  const parts = directory.replace(/^\/+/, "").split("/");
  const bucket = parts.shift()!;
  return client.bucket(bucket).file([...parts, "zipy", workspaceId, sourceId].join("/"));
}
export async function putMedia(workspaceId: string, sourceId: string, bytes: Buffer, mime: string) {
  await file(workspaceId, sourceId).save(bytes, { resumable: false, metadata: { contentType: mime } });
}
export async function getMedia(workspaceId: string, sourceId: string) {
  const object = file(workspaceId, sourceId);
  const [metadata] = await object.getMetadata();
  if (Number(metadata.size) > 16 * 1024 * 1024) throw new Error("Source exceeds the 16 MB processing limit.");
  const [bytes] = await object.download();
  return bytes;
}
export async function deleteMedia(workspaceId: string, sourceId: string) {
  await file(workspaceId, sourceId).delete({ ignoreNotFound: true });
}
