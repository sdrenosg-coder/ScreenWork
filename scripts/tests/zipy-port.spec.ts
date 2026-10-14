import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import path from "node:path";
import { forWorkspace } from "@workspace/zipy/storage/routeStore";
import { registerObjectStoreDriver } from "@workspace/zipy/storage/objectStore";
import { LocalObjectStoreDriver } from "@workspace/zipy/storage/localDriver";
import { getConfig } from "@workspace/zipy/web/config";

test("SaaS guide editing, versions, publication privacy and list pagination", async ({ request }) => {
  const emails = [`saas-${randomUUID()}@example.test`, `other-${randomUUID()}@example.test`];
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const cleanup: { store: Awaited<ReturnType<typeof forWorkspace>>; keys: string[] }[] = [];
  let slug: string | undefined;
  try {
    const signup = await request.post("/api/auth/signup", { data: { email: emails[0], password: `Saas-check-${randomUUID()}` } });
    expect(signup.status(), await signup.text()).toBe(201);
    const workspaceId = (await signup.json()).workspace.id;
    const session = await request.get("/api/session");
    expect((await session.json()).workspaceId).toBe(workspaceId);
    const store = await forWorkspace(workspaceId);
    const fixture = { store, keys: [] as string[] };
    cleanup.push(fixture);
    const workflow = await request.post("/api/v1/workflows", { data: { goal: "SaaS regression" } });
    const workflowId = (await workflow.json()).workflow.id;
    fixture.keys.push(`workflows/${workflowId}.json`);
    const created = await request.post("/api/v1/guides", { data: { workflowId, title: "SaaS regression guide" } });
    expect(created.status()).toBe(201);
    const id = (await created.json()).guide.id;
    fixture.keys.push(`guides/${id}.json`, `guides/${id}/draft-current.json`);
    const loaded = await request.get(`/api/guides/${id}`);
    expect((await loaded.json()).guide).toMatchObject({ version: 1, steps: [] });
    expect((await (await request.get("/api/branding/theme")).json()).version).toBe(0);
    const brand = { expectedVersion: 0, enabled: false, brandName: "Native regression brand", legalFooterText: "Regression footer", tokenOverrides: { colors: { accent: "#5b21b6" } }, fontInput: { picks: [] }, logos: [], customCss: null };
    fixture.keys.push("settings/branding.json");
    const branded = await request.put("/api/branding/theme", { data: brand });
    expect(branded.status(), await branded.text()).toBe(200);
    expect((await (await request.get("/api/branding/theme")).json()).input.brandName).toBe(brand.brandName);
    expect((await request.put("/api/branding/theme", { data: brand })).status()).toBe(409);
    const steps = [{ id: "step-one", index: 1, title: "Visible step", description: "Published description", value: "", aiGenerated: false, screenshotRef: null }];
    const saved = await request.put(`/api/guides/${id}`, { data: { expectedVersion: 1, steps } });
    expect(saved.status(), await saved.text()).toBe(200);
    expect((await saved.json()).guide.version).toBe(2);
    const stale = await request.put(`/api/guides/${id}`, { data: { expectedVersion: 1, steps } });
    expect(stale.status()).toBe(409);
    const history = await request.get(`/api/guides/${id}/versions`);
    expect((await history.json()).versions.map((v: any) => v.version)).toEqual([2, 1]);
    const published = await request.post(`/api/guides/${id}/publish`, { data: { expectedVersion: 2 } });
    expect(published.status(), await published.text()).toBe(200);
    slug = (await published.json()).slug;
    fixture.keys.push(`guides/${id}/published/2.json`);
    const visitId = randomUUID();
    fixture.keys.push(`reader-events/${id}/${visitId}-view.json`, `reader-events/${id}/${visitId}-complete.json`);
    const views = await Promise.all([0, 1].map(() => request.post(`/api/public-guides/${slug}/events`, { data: { kind: "view", visitId } })));
    expect(views.map(response => response.status())).toEqual([200, 200]);
    expect((await Promise.all(views.map(response => response.json()))).filter(body => body.duplicate)).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect((await request.post(`/api/public-guides/${slug}/events`, { data: { kind: "complete", visitId } })).status()).toBe(200);
    const report = await (await request.get("/api/analytics/events?kind=usage&window=7")).json();
    expect(report.report).toMatchObject({ guideCount: 1, totalViews: 1, completions: 1, completionRate: 1, uniqueViewers: null });
    for (const kind of ["performance", "content-gap", "executive"]) {
      const response = await request.get(`/api/analytics/events?kind=${kind}&window=30`);
      expect(response.status(), await response.text()).toBe(200);
      expect((await response.json()).report.kind).toBe(kind);
    }
    expect(await (await request.get(`/api/public-guides/${slug}/theme`)).json()).toMatchObject({ enabled: true, whiteLabel: false, brandName: brand.brandName });
    const activity = await (await request.get("/api/v1/audit?limit=2")).json();
    expect(activity.data).toHaveLength(2);
    expect(activity.pagination.nextCursor).toEqual(expect.any(String));
    const older = await (await request.get(`/api/v1/audit?limit=2&cursor=${encodeURIComponent(activity.pagination.nextCursor)}`)).json();
    expect(older.data.every((entry: any) => !activity.data.some((first: any) => first.id === entry.id))).toBe(true);
    const changed = await request.put(`/api/guides/${id}`, { data: { expectedVersion: 2, steps: [{ ...steps[0], description: "Private unpublished edit" }] } });
    expect(changed.status()).toBe(200);
    const publicResult = await request.get(`/api/public-guides/${slug}`);
    const publicText = await publicResult.text();
    expect(publicText).toContain("Published description");
    expect(publicText).not.toContain("Private unpublished edit");
    const publicDownload = await request.get(`/api/public-guides/${slug}/download?format=markdown`);
    expect(publicDownload.status()).toBe(200);
    expect(await publicDownload.text()).toContain("Published description");
    expect(await publicDownload.text()).not.toContain("Private unpublished edit");
    expect((await request.get(`/api/guides/${id}/download?format=markdown`)).headers()["content-disposition"]).toContain("attachment;");
    const restored = await request.post(`/api/guides/${id}/versions/2/restore`, { data: { expectedVersion: 3 } });
    expect(restored.status(), await restored.text()).toBe(200);
    expect((await restored.json()).guide.version).toBe(4);
    fixture.keys.push(...[1, 2, 3].map(v => `guides/${id}/versions/${v}.json`));
    expect((await request.post(`/api/guides/${id}/unpublish`)).status()).toBe(200);
    expect((await (await request.get(`/api/public-guides/${slug}`)).json()).kind).toBe("restricted");

    // More than one native storage batch; application filtering cannot inspect
    // just the storage driver's first page.
    for (let i = 0; i < 252; i++) {
      const fixtureId = randomUUID();
      const key = `guides/${fixtureId}.json`;
      fixture.keys.push(key);
      await store.put(key, Buffer.from(JSON.stringify({
        id: fixtureId, title: `Pagination fixture ${i}`, status: "draft",
        createdAt: new Date(1700000000000 + i).toISOString(),
      })));
    }
    const first = await (await request.get("/api/v1/guides?limit=2")).json();
    expect(first.data).toHaveLength(2);
    expect(first.pagination.total).toBe(253);
    const second = await (await request.get(`/api/v1/guides?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`)).json();
    expect(second.guides.some((g: any) => first.guides.some((f: any) => f.id === g.id))).toBe(false);
    const offsetPage = await (await request.get("/api/v1/guides?limit=2&offset=2")).json();
    expect(offsetPage.data.map((g: any) => g.id)).toEqual(second.guides.map((g: any) => g.id));
    const search = await (await request.get("/api/v1/guides?q=Pagination%20fixture%20251&limit=2")).json();
    expect(search.data).toHaveLength(1);
    expect(search.pagination.total).toBe(1);

    const other = await request.post("/api/auth/signup", { data: { email: emails[1], password: `Other-check-${randomUUID()}` } });
    expect(other.status()).toBe(201);
    expect((await request.get(`/api/guides/${id}`)).status()).toBe(404);
    expect((await request.post(`/api/guides/${id}/publish`, { data: { expectedVersion: 4 } })).status()).toBe(404);
    expect((await request.get(`/api/public-guides/${slug}/download?format=markdown`)).status()).toBe(404);
    expect((await request.get(`/api/public-guides/${slug}/theme`)).status()).toBe(404);
    expect((await request.post(`/api/public-guides/${slug}/events`, { data: { kind: "view", visitId: randomUUID() } })).status()).toBe(404);
    expect((await (await request.get("/api/analytics/events?kind=usage")).json()).report.guideCount).toBe(0);
    expect((await (await request.get("/api/branding/theme")).json()).input).toBeNull();
    expect((await request.post("/api/auth/logout")).status()).toBe(204);
    expect((await request.get("/api/session")).status()).toBe(401);
  } finally {
    for (const fixture of cleanup) {
      const activities = await fixture.store.list("activity/", { limit: 250 });
      for (const entry of activities.entries) await fixture.store.delete(entry.key);
    }
    for (const fixture of cleanup) for (const key of fixture.keys) await fixture.store.delete(key);
    if (slug) await (await forWorkspace("__public__")).delete(`public-guides/${slug}.json`);
    await pool.query("DELETE FROM workspaces WHERE created_by IN (SELECT id FROM users WHERE email_normalized = ANY($1))", [emails]);
    await pool.query("DELETE FROM users WHERE email_normalized = ANY($1)", [emails]);
    await pool.end();
  }
});

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

test("signed-out workspace has clear account entry without a client crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Create your workspace", exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Create your workspace", exact: true }).first().click();
  await expect(page.getByTestId("form-signup")).toBeVisible();
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
  await expect(page.getByRole("link", { name: "Create your workspace", exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("link", { name: "I already have an account" })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Guides", level: 1 })).toBeVisible();
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
