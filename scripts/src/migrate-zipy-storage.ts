/**
 * Run with API and worker stopped. Never deletes local files or overwrites a
 * different destination object. Re-running is safe only for identical records.
 */
import { promises as fs } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { AppStorageDriver } from "@workspace/zipy/storage/appStorageDriver";

const root = resolve(process.argv.find(arg => arg.startsWith("--root="))?.slice(7) ??
  "../artifacts/api-server/.data/objects");
const apply = process.argv.includes("--apply");
const destination = new AppStorageDriver();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function inventory(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error("Migration refuses symbolic links.");
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await inventory(path));
    else if (entry.isFile()) {
      if (entry.name.includes(".tmp-")) throw new Error("Incomplete local write found. Inspect it before migrating.");
      result.push(path);
    } else throw new Error("Unexpected filesystem entry.");
  }
  return result;
}

const files = await inventory(root);
const manifest: Array<{ key: string; sha256: string; size: number }> = [];
let copied = 0, existing = 0, totalBytes = 0;
async function bounded<T>(items: T[], action: (item: T) => Promise<void>) {
  let index = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (index < items.length && !failure) {
      const item = items[index++]!;
      try { await action(item); } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
}
await bounded(files, async file => {
  const key = relative(root, file).split("\\").join("/");
  const bytes = await fs.readFile(file), digest = hash(bytes);
  if (apply) {
    try {
      await destination.putIfAbsent({
        key, body: bytes, expectedSha256: digest,
        contentType: key.endsWith(".json") ? "application/json" : "application/octet-stream",
      });
      copied++;
    } catch (error) {
      if (Number((error as { code?: unknown }).code) !== 412) throw error;
      existing++;
    }
    if (hash((await destination.get(key)).body) !== digest) {
      throw new Error("Destination conflict or content mismatch. No switch is safe; originals retained.");
    }
  }
  manifest.push({ key, sha256: digest, size: bytes.length });
  totalBytes += bytes.length;
  if (manifest.length % 25 === 0) process.stdout.write(`Copied/read-back checked ${manifest.length}/${files.length}\n`);
});
if (apply) {
  // A fresh client reads every object again; a changed/new/deleted local file
  // during the copy invalidates the entire verification.
  const verifier = new AppStorageDriver();
  const after = await inventory(root);
  if (JSON.stringify(after) !== JSON.stringify(files)) throw new Error("Local inventory changed; do not switch.");
  process.stdout.write(`Verifying ${manifest.length} records again with a fresh storage client\n`);
  await bounded(manifest, async entry => {
    if (hash(await fs.readFile(resolve(root, entry.key))) !== entry.sha256 ||
      hash((await verifier.get(entry.key)).body) !== entry.sha256) {
      throw new Error("Content changed during migration; do not switch.");
    }
  });
  await verifier.close();
  // Record a private, read-back-verified migration receipt outside tenant keys.
  const receipt = { at: new Date().toISOString(), objects: files.length, totalBytes, manifest };
  const receiptKey = `_storage-migration/${Date.now()}.json`;
  await destination.putIfAbsent({ key: receiptKey, body: JSON.stringify(receipt), contentType: "application/json" });
}
await destination.close();
process.stdout.write(JSON.stringify({ applied: apply, verifiedObjects: apply ? files.length : 0, copied, existing, totalBytes, originalsRetained: true }) + "\n");
