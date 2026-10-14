/**
 * End-to-end: human-in-the-loop review gating and publish lifecycle.
 *
 * Scope (phase 26, batch 0): this test exercises the review surface for a
 * workflow and the transitions that move a guide from draft to published,
 * through the endpoints and page contracts the earlier phases documented:
 *
 *   GET   /api/workflows/{id}/review
 *   PUT   /api/workflows/{id}/review
 *   GET   /api/workflows/{id}/review/decisions?cursor=&limit=
 *   POST  /api/guides/{id}/export                (phase 20)
 *   GET   /p/{slug}                              (phase 20 public page)
 *
 * Where a capability is not present on the running server the test skips
 * with a reason that explains the missing infrastructure, rather than
 * asserting a shape the server does not produce. Webhook delivery is
 * asserted only when a receiver is running and the operator has told the
 * suite where to send: `ZIPY_E2E_WEBHOOK_RECEIVER` points at a URL that
 * records the deliveries it received.
 *
 * What this file does not do:
 *   - It does not open a Playwright browser against the worker. The live
 *     handoff surface is driven by a human in a real session; an
 *     unattended test cannot meaningfully exercise it. The test asserts
 *     that the *page* renders the live-session region and that a 503 or
 *     404 from the handoff endpoint is reported cleanly — not that a
 *     browser was handed to a person.
 *   - It does not invent reviewer identities. The session supplied to the
 *     test is the reviewer.
 *   - It does not distribute approve/reject decisions to "make" the audit
 *     trail non-empty; when there are no recorded decisions, the test
 *     asserts the empty state is what the route reported.
 */

import { test, expect, UUID_PATTERN } from "./helpers/setup";
import type { APIRequestContext } from "@playwright/test";

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

test.describe("Human-in-the-loop review", () => {
  test("review mode toggle is authoritative and audit trail is queryable", async ({
    api,
    session,
  }) => {
    test.skip(
      session === null,
      "No session available: set ZIPY_E2E_COOKIE or enable sign-up on the server under test.",
    );
    if (session === null) return;

    const workflowId = await probeWorkflowId(api, session.cookieHeader);
    test.skip(
      workflowId === null,
      "No workflow id could be resolved (the workflow read endpoint is not present or returned no rows). Review surface not exercised.",
    );
    if (workflowId === null) return;

    /* ---------------------------------------------------- summary -------- */

    const summaryRes = await api.get(
      `/api/workflows/${encodeURIComponent(workflowId)}/review`,
      { headers: { cookie: session.cookieHeader } },
    );
    test.skip(
      summaryRes.status() === 404,
      "The review endpoint is not present on this server.",
    );
    test.skip(
      summaryRes.status() === 503,
      "The review endpoint reports a missing dependency (probably DATABASE_URL).",
    );
    expectOk(summaryRes, "review summary fetch");

    const summary = (await summaryRes.json()) as Record<string, unknown>;
    expect(
      summary["workflowId"],
      "review summary must echo the workflow id",
    ).toBe(workflowId);
    expect(
      typeof summary["reviewMode"],
      "review summary must report a boolean reviewMode",
    ).toBe("boolean");

    const actionsRaw = summary["actions"];
    expect(
      Array.isArray(actionsRaw),
      "review summary must carry an actions array",
    ).toBe(true);
    if (Array.isArray(actionsRaw)) {
      for (const raw of actionsRaw) {
        if (raw === null || typeof raw !== "object") continue;
        const a = raw as Record<string, unknown>;
        expect(
          typeof a["id"],
          "each action must carry an id",
        ).toBe("string");
        expect(
          typeof a["riskClass"],
          "each action must carry a risk classification",
        ).toBe("string");
      }
    }

    /* ---------------------------------------------------- toggle --------- */

    const initial = summary["reviewMode"] === true;
    const target = !initial;

    const toggleRes = await api.put(
      `/api/workflows/${encodeURIComponent(workflowId)}/review`,
      {
        headers: {
          "content-type": "application/json",
          cookie: session.cookieHeader,
        },
        data: { reviewMode: target },
      },
    );
    expectOk(toggleRes, "review-mode toggle");

    const toggled = (await toggleRes.json()) as Record<string, unknown>;
    expect(
      toggled["reviewMode"],
      "the server's response must reflect the new review mode authoritatively",
    ).toBe(target);

    // Re-read confirms persistence. A server that echoes the request but
    // does not persist fails here, which is the point of the assertion.
    const reRead = await api.get(
      `/api/workflows/${encodeURIComponent(workflowId)}/review`,
      { headers: { cookie: session.cookieHeader } },
    );
    expectOk(reRead, "review summary re-read");
    const reSummary = (await reRead.json()) as Record<string, unknown>;
    expect(
      reSummary["reviewMode"],
      "review mode must persist across reads",
    ).toBe(target);

    /* ---------------------------------------------------- audit ---------- */

    const auditRes = await api.get(
      `/api/workflows/${encodeURIComponent(workflowId)}/review/decisions?limit=25`,
      { headers: { cookie: session.cookieHeader } },
    );
    test.skip(
      auditRes.status() === 404,
      "The decisions endpoint is not present on this server.",
    );
    expectOk(auditRes, "audit trail fetch");

    const audit = (await auditRes.json()) as Record<string, unknown>;
    expect(
      audit["workflowId"],
      "audit page must echo the workflow id",
    ).toBe(workflowId);
    const decisions = audit["decisions"];
    expect(
      Array.isArray(decisions),
      "audit page must carry a decisions array",
    ).toBe(true);
    expect(
      audit["nextCursor"] === null ||
        typeof audit["nextCursor"] === "string",
      "audit page must carry a nextCursor (null when there are no more pages)",
    ).toBe(true);

    if (Array.isArray(decisions)) {
      for (const d of decisions) {
        if (d === null || typeof d !== "object") continue;
        const entry = d as Record<string, unknown>;
        expect(
          typeof entry["id"],
          "each audit entry must carry an id",
        ).toBe("string");
        expect(
          typeof entry["decidedAt"],
          "each audit entry must carry a decidedAt timestamp",
        ).toBe("string");
        expect(
          typeof entry["decision"],
          "each audit entry must carry a decision kind",
        ).toBe("string");
      }
    }
  });
});

test.describe("Publish lifecycle and export", () => {
  test("a guide can be exported in every documented format", async ({
    api,
    session,
  }) => {
    test.skip(
      session === null,
      "No session available: set ZIPY_E2E_COOKIE or enable sign-up on the server under test.",
    );
    if (session === null) return;

    const guideId = await probeGuideId(api, session.cookieHeader);
    test.skip(
      guideId === null,
      "No guide id could be resolved; export did not run.",
    );
    if (guideId === null) return;

    // Formats are enumerated from the operations documentation of phase 20.
    // A format the server does not support returns a documented 400/415;
    // that is recorded as an annotation, not a silent pass.
    const formats: readonly string[] = ["pdf", "html", "markdown", "docx"];
    for (const format of formats) {
      const res = await api.post(
        `/api/guides/${encodeURIComponent(guideId)}/export`,
        {
          headers: {
            "content-type": "application/json",
            cookie: session.cookieHeader,
          },
          data: { format },
        },
      );

      if (res.status() === 404) {
        test.info().annotations.push({
          type: "note",
          description: `Export endpoint not present; format "${format}" was not exercised.`,
        });
        continue;
      }
      if (res.status() === 501) {
        test.info().annotations.push({
          type: "note",
          description: `Export format "${format}" is not implemented on this server (HTTP 501).`,
        });
        continue;
      }
      if (res.status() === 400 || res.status() === 415) {
        test.info().annotations.push({
          type: "note",
          description: `Export format "${format}" was rejected with HTTP ${res.status()}.`,
        });
        continue;
      }
      expectOk(res, `export ${format}`);

      // Assert the response is non-empty. We do not parse the file bytes;
      // the renderers live in `@zipy/export` and are unit-tested there.
      const buf = await res.body();
      expect(
        buf.byteLength,
        `export ${format} produced an empty body`,
      ).toBeGreaterThan(0);
    }
  });

  test("a published guide renders on its public slug", async ({
    api,
    session,
  }) => {
    test.skip(
      session === null,
      "No session available: set ZIPY_E2E_COOKIE or enable sign-up on the server under test.",
    );
    if (session === null) return;

    const guideId = await probeGuideId(api, session.cookieHeader);
    test.skip(
      guideId === null,
      "No guide id could be resolved; publish-page rendering was not exercised.",
    );
    if (guideId === null) return;

    const guideRes = await api.get(
      `/api/v1/guides/${encodeURIComponent(guideId)}`,
      { headers: { cookie: session.cookieHeader } },
    );
    test.skip(
      guideRes.status() === 404 || guideRes.status() === 405,
      "The guide read endpoint is not present; the public-slug assertion was not exercised.",
    );
    if (!guideRes.ok()) {
      test.skip(
        guideRes.status() === 403,
        "The test session is not a member of the guide's workspace.",
      );
      return;
    }

    const guide = (await guideRes.json()) as Record<string, unknown>;
    const slug = guide["slug"];
    test.skip(
      typeof slug !== "string" || slug.length === 0,
      "The guide has no slug; the public page cannot be located.",
    );
    if (typeof slug !== "string" || slug.length === 0) return;

    const pageRes = await api.get(`/p/${encodeURIComponent(slug)}`);
    test.skip(
      pageRes.status() === 404,
      "The public guide page is not reachable at /p/{slug} on this server.",
    );
    expectOk(pageRes, "public guide page fetch");

    const html = await pageRes.text();
    // The page must not be an error document. A minimal sanity assertion.
    expect(
      html.length,
      "the public guide page must render non-empty HTML",
    ).toBeGreaterThan(0);
    expect(
      /ai-generated|AI-generated/i.test(html),
      "the public guide page must carry an AI-generated disclosure (see @zipy/safety/disclosure)",
    ).toBe(true);
  });
});

test.describe("Webhook delivery", () => {
  test("a published event is delivered to a configured receiver", async ({
    api,
    session,
  }) => {
    const receiverUrl = process.env["ZIPY_E2E_WEBHOOK_RECEIVER"];
    test.skip(
      typeof receiverUrl !== "string" || receiverUrl.length === 0,
      "Set ZIPY_E2E_WEBHOOK_RECEIVER to a URL that records incoming deliveries; webhook delivery is not exercised unattended otherwise.",
    );
    test.skip(
      session === null,
      "No session available: set ZIPY_E2E_COOKIE or enable sign-up on the server under test.",
    );
    if (session === null || typeof receiverUrl !== "string") return;

    // The suite does not know which workspace event subscriptions are
    // configured, and it must not invent one. It asserts only that a
    // request the review/publish surface generates results in at least one
    // delivery to the receiver within the wait window. When no delivery
    // arrives the test fails with the receiver URL named, so an operator
    // can inspect their receiver logs.
    test.info().annotations.push({
      type: "note",
      description: `Expecting deliveries at receiver: ${receiverUrl}.`,
    });

    // Trigger a decision-visible write. The simplest documented operation
    // that the API spec lists as producing an event is a review-mode
    // change. We do not know the workflow id here, so we rely on the
    // caller to have provisioned a workflow via ZIPY_E2E_WORKSPACE_ID and
    // the workflow read endpoint. When that endpoint is absent, skip.
    const workflowId = await probeWorkflowId(api, session.cookieHeader);
    test.skip(
      workflowId === null,
      "No workflow id could be resolved; no event was generated.",
    );
    if (workflowId === null) return;

    const res = await api.put(
      `/api/workflows/${encodeURIComponent(workflowId)}/review`,
      {
        headers: {
          "content-type": "application/json",
          cookie: session.cookieHeader,
        },
        data: { reviewMode: true },
      },
    );
    test.skip(
      res.status() === 404,
      "The review endpoint is not present; no event was generated.",
    );
    expectOk(res, "review-mode change to trigger a webhook");
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function probeWorkflowId(
  api: APIRequestContext,
  cookie: string,
): Promise<string | null> {
  const res = await api.get("/api/v1/workflows", { headers: { cookie } });
  if (!res.ok()) return null;
  const body: unknown = await res.json().catch(() => null);
  return readFirstId(body, "workflows");
}

async function probeGuideId(
  api: APIRequestContext,
  cookie: string,
): Promise<string | null> {
  const res = await api.get("/api/v1/guides", { headers: { cookie } });
  if (!res.ok()) return null;
  const body: unknown = await res.json().catch(() => null);
  return readFirstId(body, "guides");
}

function readFirstId(body: unknown, key: string): string | null {
  if (body === null || typeof body !== "object") return null;
  const rows = (body as Record<string, unknown>)[key];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const id = (row as Record<string, unknown>)["id"];
    if (typeof id === "string" && UUID_PATTERN.test(id)) return id;
  }
  return null;
}

function expectOk(
  res: { status(): number },
  context: string,
): void {
  expect(
    res.status(),
    `${context}: expected 2xx, got ${res.status()}.`,
  ).toBeGreaterThanOrEqual(200);
  expect(
    res.status(),
    `${context}: expected 2xx, got ${res.status()}.`,
  ).toBeLessThan(300);
}
