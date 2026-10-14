import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getJob } from "@workspace/zipy/jobs/queue";
import { deleteMedia } from "@workspace/zipy/storage/mediaStore";

test("workspace templates, discussion, invitations, key revocation and governance", async ({ playwright, baseURL }) => {
  const owner = await playwright.request.newContext({ baseURL });
  const member = await playwright.request.newContext({ baseURL });
  const emails = [`suite-owner-${randomUUID()}@example.test`, `suite-member-${randomUUID()}@example.test`];
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let keyId: string | undefined;
  try {
    const signed = await owner.post("/api/auth/signup", { data: { email: emails[0], password: `Fixture-${randomUUID()}-A1!` } });
    expect(signed.status()).toBe(201);
    const workspaceId = (await signed.json()).workspace.id;
    expect((await member.post("/api/auth/signup", { data: { email: emails[1], password: `Fixture-${randomUUID()}-B1!` } })).status()).toBe(201);
    const otherWorkspace = (await (await member.get("/api/session")).json()).workspaceId;
    const created = await owner.post("/api/suite/templates", { data: { action: "use", templateId: "starter-sop", title: "Suite fixture procedure" } });
    expect(created.status(), await created.text()).toBe(200);
    const guideId = (await created.json()).id;
    const current = (await (await owner.get(`/api/guides/${guideId}`)).json()).guide;
    expect(current.steps).toHaveLength(5);
    const savedTemplate = await owner.post("/api/suite/templates", { data: { action: "save", guideId, title: "Reusable fixture" } });
    expect(savedTemplate.status()).toBe(200);
    const templateId = (await savedTemplate.json()).id;
    const copied = await owner.post("/api/suite/templates", { data: { action: "use", templateId } });
    expect(copied.status()).toBe(200);
    const copyId = (await copied.json()).id;
    expect(copyId).not.toBe(guideId);
    const copy = (await (await owner.get(`/api/guides/${copyId}`)).json()).guide;
    expect(copy.steps[0].id).not.toBe(current.steps[0].id);
    const posted = await owner.post(`/api/guides/${guideId}/discussion`, { data: { action: "comment", text: "Review the fixture prerequisites." } });
    expect(posted.status()).toBe(200);
    const commentId = (await posted.json()).id;
    expect((await owner.post(`/api/guides/${guideId}/discussion`, { data: { action: "resolve", id: commentId, resolved: true } })).status()).toBe(200);
    expect((await (await owner.get(`/api/guides/${guideId}/discussion`)).json()).items[0].resolved).toBe(true);
    expect((await member.get(`/api/guides/${guideId}`)).status()).toBe(404);
    const invited = await owner.post("/api/suite/team", { data: { action: "invite", email: emails[1], role: "commenter" } });
    expect(invited.status()).toBe(200);
    const invite = await invited.json();
    expect((await member.post("/api/suite/team", { data: { action: "accept", invitationId: invite.invitationId, workspaceId, token: invite.token } })).status()).toBe(200);
    expect((await (await member.get("/api/session")).json()).role).toBe("commenter");
    expect((await member.get(`/api/guides/${guideId}`)).status()).toBe(200);
    expect((await member.post(`/api/guides/${guideId}/discussion`, { data: { action: "comment", text: "Commenter can participate." } })).status()).toBe(200);
    expect((await member.put(`/api/guides/${guideId}`, { data: { expectedVersion: 1, steps: current.steps } })).status()).toBe(403);
    expect((await member.get("/api/suite/integrations")).status()).toBe(403);
    expect((await member.post("/api/suite/integrations", { data: { action: "create-key", name: "Forbidden key" } })).status()).toBe(403);
    expect((await member.post("/api/suite/team", { data: { action: "accept", invitationId: invite.invitationId, workspaceId, token: invite.token } })).status()).toBe(400);
    expect((await member.post("/api/suite/team", { data: { action: "switch", workspaceId: otherWorkspace } })).status()).toBe(200);
    expect((await member.get(`/api/guides/${guideId}`)).status()).toBe(404);
    const members = (await (await owner.get("/api/suite/team")).json()).items;
    const commenter = members.find((row: { email: string }) => row.email === emails[1]);
    expect((await owner.post("/api/suite/team", { data: { action: "role", userId: commenter.id, role: "editor" } })).status()).toBe(200);
    const ownerId = (await (await owner.get("/api/session")).json()).userId;
    expect((await owner.post("/api/suite/team", { data: { action: "role", userId: ownerId, role: "viewer" } })).status()).toBe(400);
    const key = await owner.post("/api/suite/integrations", { data: { action: "create-key", name: "Temporary fixture reader" } });
    expect(key.status()).toBe(200);
    const credential = await key.json(); keyId = credential.id;
    const external = await member.get("/api/external/guides", { headers: { authorization: `Bearer ${credential.token}` } });
    expect(external.status()).toBe(200);
    expect((await external.json()).items.some((row: { id: string }) => row.id === guideId)).toBe(true);
    expect((await owner.post("/api/suite/integrations", { data: { action: "revoke-key", id: keyId } })).status()).toBe(200); keyId = undefined;
    expect((await member.get("/api/external/guides", { headers: { authorization: `Bearer ${credential.token}` } })).status()).toBe(401);
    expect((await owner.post("/api/suite/integrations", { data: { action: "hook", name: "Blocked", url: "http://127.0.0.1" } })).status()).toBe(400);
    const hook = await owner.post("/api/suite/integrations", { data: { action: "hook", name: "Synthetic delivery receiver", url: "https://httpbin.org/anything" } });
    expect(hook.status()).toBe(200);
    const hookId = (await hook.json()).id;
    expect((await owner.post("/api/suite/integrations", { data: { action: "test-hook", id: hookId } })).status()).toBe(200);
    await expect.poll(async () => {
      const data = await (await owner.get("/api/suite/integrations")).json();
      return data.deliveries.find((delivery: { hookId: string }) => delivery.hookId === hookId)?.status;
    }, { timeout: 20000 }).toBe("delivered");
    expect((await owner.post("/api/suite/integrations", { data: { action: "delete-hook", id: hookId } })).status()).toBe(200);
    expect((await owner.post("/api/suite/governance", { data: { action: "policy", retentionDays: 30 } })).status()).toBe(200);
    const request = await owner.post("/api/suite/governance", { data: { action: "request", type: "correction", subject: "Synthetic fixture", details: "Correct the fixture guide." } });
    expect(request.status()).toBe(200);
    const requestId = (await request.json()).id;
    expect((await owner.post("/api/suite/governance", { data: { action: "resolve-request", id: requestId, resolution: "Verified synthetic fixture corrected by administrator." } })).status()).toBe(200);
    const governance = (await (await owner.get("/api/suite/governance")).json());
    expect(governance.requests.find((row: { id: string }) => row.id === requestId).status).toBe("resolved");
    const exported = await owner.post("/api/suite/governance", { data: { action: "export" } });
    expect(exported.status()).toBe(200);
    expect((await exported.json()).items.some((row: { id: string }) => row.id === guideId)).toBe(true);
    expect((await owner.post(`/api/guides/${guideId}/visuals`, { data: { action: "capture", url: "http://127.0.0.1" } })).status()).toBe(400);
  } finally {
    if (keyId) await owner.post("/api/suite/integrations", { data: { action: "revoke-key", id: keyId } });
    // Only these unique synthetic accounts/workspaces are removed.
    for (const email of emails) {
      await pool.query("DELETE FROM workspaces WHERE created_by IN (SELECT id FROM users WHERE email_normalized = $1)", [email]);
      await pool.query("DELETE FROM users WHERE email_normalized = $1", [email]);
    }
    await pool.end(); await owner.dispose(); await member.dispose();
  }
});

test("public browser capture, private image, annotation version and review gate", async ({ request, playwright, baseURL }) => {
  test.setTimeout(90000);
  const email = `capture-fixture-${randomUUID()}@example.test`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let workspaceId = "", captureId = "";
  try {
    const signed = await request.post("/api/auth/signup", { data: { email, password: `Fixture-${randomUUID()}-C1!` } });
    expect(signed.status()).toBe(201); workspaceId = (await signed.json()).workspace.id;
    const created = await request.post("/api/suite/templates", { data: { action: "use", templateId: "starter-sop" } });
    const guideId = (await created.json()).id;
    const queued = await request.post(`/api/guides/${guideId}/visuals`, { data: { action: "capture", url: "https://example.com" } });
    expect(queued.status()).toBe(200); captureId = (await queued.json()).jobId;
    let source: { status: string; error?: string; imageUrl: string };
    await expect.poll(async () => {
      source = (await (await request.get(`/api/guides/${guideId}/visuals`)).json()).items.find((item: { jobId: string }) => item.jobId === captureId);
      return source.status === "failed" ? `failed: ${source.error}` : source.status;
    }, { timeout: 60000 }).toBe("succeeded");
    const image = await request.get(source!.imageUrl);
    expect(image.status()).toBe(200); const original = await image.body();
    expect(original.length).toBeGreaterThan(100);
    const anon = await playwright.request.newContext({ baseURL });
    expect((await anon.get(source!.imageUrl)).status()).toBe(401); await anon.dispose();
    const current = (await (await request.get(`/api/guides/${guideId}`)).json()).guide;
    const annotated = await request.post(`/api/guides/${guideId}/visuals`, { data: {
      action: "annotate", sourceJobId: captureId, stepId: current.steps[0].id, expectedVersion: 1,
      altText: "Example public page with a deliberately redacted test area.",
      marks: [{ kind: "redact", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { kind: "box", x: 0.4, y: 0.2, w: 0.2, h: 0.1 }],
    } });
    expect(annotated.status(), await annotated.text()).toBe(200);
    expect((await annotated.json()).version).toBe(2);
    expect((await request.get(source!.imageUrl)).status()).toBe(200);
    expect((await (await request.get(source!.imageUrl)).body()).equals(original)).toBe(true);
    expect((await request.post(`/api/guides/${guideId}/publish`, { data: { expectedVersion: 2 } })).status()).toBe(409);
    const reviewed = await request.post(`/api/guides/${guideId}/review`, { data: { expectedVersion: 2, confirmed: true } });
    expect(reviewed.status(), await reviewed.text()).toBe(200);
    expect((await request.post(`/api/guides/${guideId}/publish`, { data: { expectedVersion: 2 } })).status()).toBe(200);
    expect((await request.post(`/api/guides/${guideId}/unpublish`)).status()).toBe(200);
  } finally {
    if (workspaceId && captureId) {
      const job = await getJob(workspaceId, captureId);
      if (typeof job?.result?.sourceId === "string") await deleteMedia(workspaceId, job.result.sourceId);
    }
    await pool.query("DELETE FROM workspaces WHERE created_by IN (SELECT id FROM users WHERE email_normalized=$1)", [email]);
    await pool.query("DELETE FROM users WHERE email_normalized=$1", [email]); await pool.end();
  }
});
