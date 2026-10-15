import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppStorageDriver } from "@workspace/zipy/storage/appStorageDriver";
import { assertKeyInWorkspace, ObjectKeyError } from "@workspace/zipy/storage/objectStore";

test("private durable storage verifies content, pagination, isolation and a fresh-process read", async () => {
  test.setTimeout(120000);
  const namespace = `zipy-storage-tests/${randomUUID()}`;
  const driver = new AppStorageDriver({ namespace });
  const tenant = randomUUID(), other = randomUUID();
  const key = `${tenant}/guides/fixture.json`;
  const body = Buffer.from(JSON.stringify({ title: "Synthetic persistence fixture", steps: ["Open settings", "Save"] }));
  const hash = createHash("sha256").update(body).digest("hex");
  try {
    expect((await driver.put({ key, body, contentType: "application/json", expectedSha256: hash })).sha256).toBe(hash);
    await driver.put({ key: `${tenant}/guides/stream.txt`, body: Readable.from(["stream ", "fixture"]) });
    await driver.put({ key: `${other}/settings.json`, body: "isolated tenant" });
    expect((await driver.head(key))?.contentType).toBe("application/json");
    expect((await driver.get(key)).body).toEqual(body);
    const chunks: Buffer[] = [];
    for await (const chunk of (await driver.getStream(key)).stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(body);
    expect((await driver.get(`${tenant}/guides/stream.txt`)).body.toString()).toBe("stream fixture");

    await expect(driver.put({ key, body: "wrong", expectedSha256: hash })).rejects.toThrow("SHA-256 mismatch");
    await expect(driver.putIfAbsent({ key, body: "would overwrite" })).rejects.toMatchObject({ code: 412 });
    expect((await driver.get(key)).body).toEqual(body);
    await expect(driver.get("../escape")).rejects.toThrow(ObjectKeyError);
    await expect(driver.get("/absolute")).rejects.toThrow(ObjectKeyError);
    expect(() => assertKeyInWorkspace(`${other}/settings.json`, tenant)).toThrow(ObjectKeyError);

    const first = await driver.list({ prefix: `${tenant}/`, limit: 1 });
    expect(first.objects).toHaveLength(1);
    expect(first.cursor).toBeTruthy();
    const second = await driver.list({ prefix: `${tenant}/`, limit: 1, cursor: first.cursor });
    expect(new Set([...first.objects, ...second.objects].map(object => object.key)).size).toBe(2);
    expect([...first.objects, ...second.objects].every(object => object.key.startsWith(`${tenant}/`))).toBe(true);
    await expect(driver.list({ prefix: `${other}/`, cursor: first.cursor })).rejects.toThrow("cursor");
    const url = await driver.signedUrl({ key, expiresInSeconds: 30 });
    // The signed private URL itself is never printed or persisted in reports.
    expect(new URL(url).protocol).toBe("https:");

    const executable = process.execPath;
    const tsx = import.meta.resolve("tsx/cli");
    const script = `import {AppStorageDriver} from '@workspace/zipy/storage/appStorageDriver';
      const store = new AppStorageDriver({namespace:${JSON.stringify(namespace)}});
      const object = await store.get(${JSON.stringify(key)});
      process.stdout.write(object.metadata.sha256);`;
    const fresh = await promisify(execFile)(executable, [
      new URL(tsx).pathname, "--input-type=module", "--eval", script,
    ], { env: { ...process.env }, timeout: 30000 });
    expect(fresh.stdout.trim()).toBe(hash);
    await driver.delete(key);
    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
    await expect(driver.get(key)).rejects.toMatchObject({ name: "ObjectNotFoundError" });
  } finally {
    let cursor: string | null = null;
    const keys: string[] = [];
    do {
      const page = await driver.list({ prefix: "", cursor });
      keys.push(...page.objects.map(object => object.key));
      cursor = page.cursor;
    } while (cursor);
    for (const object of keys) await driver.delete(object);
    await driver.close();
  }
});
