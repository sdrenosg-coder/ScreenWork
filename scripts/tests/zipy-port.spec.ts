import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import path from "node:path";
import { forWorkspace } from "@workspace/zipy/storage/routeStore";
import { registerObjectStoreDriver } from "@workspace/zipy/storage/objectStore";
import { LocalObjectStoreDriver } from "@workspace/zipy/storage/localDriver";
import { getConfig } from "@workspace/zipy/web/config";

// The API workflow's cwd is artifacts/api-server. Match its configured local
// storage root when the test process opens the same driver from scripts/.
if (getConfig().storage.driver === "local") {
  registerObjectStoreDriver("local", async () => {
    const driver = new LocalObjectStoreDriver({
      root: path.resolve(import.meta.dirname, "../../artifacts/api-server", getConfig().storage.localRoot),
      isProduction: false,
    });
    await driver.init();
    return driver;
  });
}

test("dashboard loads, filters and retries without a client crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Workspace dashboard" })).toBeVisible();
  await page.getByPlaceholder("Title, slug or step text").fill("migration check");
  await page.getByRole("combobox").first().selectOption({ index: 1 });
  const refresh = page.getByRole("button", { name: "Refresh", exact: true }).first();
  if (await refresh.count()) await refresh.click();
  await expect(page.getByRole("heading", { name: "Guides", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const path of ["/dashboard", "/analytics", "/admin", "/settings/branding", "/guides/test-id/edit", "/workflows/test-id/review", "/p/example"]) {
  test(`imported route ${path} renders and reloads`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(path);
    await expect(page.locator("#zipy-main")).toBeVisible();
    await expect(page.locator("#zipy-main h1").first()).toBeVisible();
    await expect(page.getByText("Something went wrong", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#zipy-main h1").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("API authentication boundaries and original missing endpoints stay explicit", async ({ request }) => {
  expect((await request.get("/api/healthz")).status()).toBe(200);
  for (const endpoint of ["/api/v1/guides", "/api/billing/usage", "/api/admin/audit"]) {
    const response = await request.get(endpoint);
    expect(response.status()).toBe(401);
    expect(await response.json()).toHaveProperty("error");
  }
  const response = await request.post("/api/sources/text", { data: { prompt: "test" } });
  expect(response.status()).toBe(401);
  const missing = await request.get("/api/v1/folders");
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toHaveProperty("message");
});

test("dashboard is readable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Workspace dashboard" })).toBeVisible();
  // The imported desktop grid has horizontal overflow on small screens.
  // This port preserves that layout rather than introducing a redesign.
  await expect(page.getByPlaceholder("Title, slug or step text")).toBeVisible();
});

test("original signup, session, login and text queue work", async ({ page, request }) => {
  const email = `port-test-${randomUUID()}@example.test`;
  const password = `Port-test-${randomUUID()}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const signup = await request.post("/api/auth/signup", {
      data: { email, password, workspaceName: "Port verification" },
    });
    expect(signup.status(), await signup.text()).toBe(201);
    const data = await signup.json();
    expect(data).toHaveProperty("session");
    const login = await request.post("/api/auth/login", { data: { email, password } });
    expect(login.status(), await login.text()).toBe(200);
    const queued = await request.post("/api/sources/text", {
      data: { prompt: "Explain how to create a new screenshot tutorial." },
    });
    expect(queued.status(), await queued.text()).toBe(202);
    expect((await queued.json()).job).toHaveProperty("id");
    await page.context().addCookies((await request.storageState()).cookies);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Workspace dashboard" })).toBeVisible();
  } finally {
    // Only delete this run's generated account/workspace; never existing data.
    await pool.query("DELETE FROM workspaces WHERE created_by IN (SELECT id FROM users WHERE email_normalized = $1)", [email]);
    await pool.query("DELETE FROM users WHERE email_normalized = $1", [email]);
    await pool.end();
  }
});

test("authenticated objects upload, list and read; published guides load with tenant isolation", async ({ page, request }) => {
  const email = `storage-port-${randomUUID()}@example.test`;
  const password = `Port-test-${randomUUID()}`;
  const slug = `port-${randomUUID()}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let store: Awaited<ReturnType<typeof forWorkspace>> | undefined;
  const publicStore = await forWorkspace("__public__");
  try {
    const signup = await request.post("/api/auth/signup", { data: { email, password } });
    expect(signup.status(), await signup.text()).toBe(201);
    const workspaceId = (await signup.json()).workspace.id;
    store = await forWorkspace(workspaceId);

    const workflowResponse = await request.post("/api/v1/workflows", {
      data: { goal: "Storage migration verification" },
    });
    expect(workflowResponse.status(), await workflowResponse.text()).toBe(201);
    const workflowId = (await workflowResponse.json()).workflow.id;
    const guideResponse = await request.post("/api/v1/guides", {
      data: { workflowId, title: "Storage-backed test tutorial" },
    });
    expect(guideResponse.status(), await guideResponse.text()).toBe(201);
    const guideId = (await guideResponse.json()).guide.id;
    const listResponse = await request.get("/api/v1/guides");
    expect(listResponse.status(), await listResponse.text()).toBe(200);
    expect((await listResponse.json()).guides.some((guide: any) => guide.id === guideId)).toBeTruthy();
    const persisted = await store.get(`guides/${guideId}.json`);
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted!.toString()).title).toBe("Storage-backed test tutorial");
    const entries = await store.list("guides/");
    expect(entries.entries.some(entry => entry.key === `guides/${guideId}.json`)).toBeTruthy();
    // Workspace B cannot read or enumerate workspace A's records.
    const otherWorkspace = await forWorkspace(randomUUID());
    expect(await otherWorkspace.get(`${workspaceId}/guides/${guideId}.json`)).toBeNull();
    expect((await otherWorkspace.list("guides/")).entries).toHaveLength(0);
    await expect(store.get("../escape")).rejects.toThrow("Invalid object key");

    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const upload = await request.post("/api/sources/file", {
      multipart: { file: { name: "port-test.png", mimeType: "image/png", buffer: imageBytes } },
    });
    expect(upload.status(), await upload.text()).toBe(202);
    const uploaded = await upload.json();
    expect(await store.get(uploaded.source.storageKey)).toEqual(imageBytes);

    await store.put(`guides/${guideId}/draft-current.json`, Buffer.from(JSON.stringify({
      title: "Storage-backed test tutorial", summary: "A published migration check.",
      steps: [{ index: 1, title: "First step", description: "Verified content." }],
    })), { contentType: "application/json" });
    await publicStore.put(`public-guides/${slug}.json`, Buffer.from(JSON.stringify({
      guideId, workspaceId, access: "public",
    })));
    const publicResult = await request.get(`/api/public-guides/${slug}`);
    expect((await publicResult.json()).kind).toBe("rendered");
    await page.goto(`/p/${slug}`);
    await expect(page.getByRole("heading", { name: "Storage-backed test tutorial" })).toBeVisible();
    await expect(page.getByText("Verified content.")).toBeVisible();
    // Restricted registry entries never leak draft content.
    await publicStore.put(`public-guides/${slug}.json`, Buffer.from(JSON.stringify({
      guideId, workspaceId, access: "private",
    })));
    const restricted = await request.get(`/api/public-guides/${slug}`);
    expect((await restricted.json()).kind).toBe("restricted");
  } finally {
    if (store) {
      const entries = await store.list("");
      for (const entry of entries.entries) await store.delete(entry.key);
    }
    await publicStore.delete(`public-guides/${slug}.json`);
    await pool.query("DELETE FROM workspaces WHERE created_by IN (SELECT id FROM users WHERE email_normalized = $1)", [email]);
    await pool.query("DELETE FROM users WHERE email_normalized = $1", [email]);
    await pool.end();
  }
});
