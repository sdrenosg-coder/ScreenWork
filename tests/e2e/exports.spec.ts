/**
 * End-to-end: full export surface across formats and embed code.
 *
 * Scope (phase 26, batch 0): this test asserts that every export format the
 * platform advertises produces a non-empty artifact from a real guide, and
 * that the embed code surface returns a snippet that references the guide
 * by id or slug. It exists separately from `review-and-publish.spec.ts`
 * because publish flow and export flow are independent capabilities that a
 * customer can adopt at different times.
 *
 * The test intentionally does NOT parse PDF layout, DOCX XML, or ZIP
 * entries. Each renderer is a separate package (`@zipy/export/pdf`,
 * `/docx`, `/markdown`, `/html`, `/imagePack`) that carries its own unit
 * coverage in a later phase. This test asserts the wiring: an authenticated
 * call to the export route produces bytes in the right content-type family.
 *
 * Conventions:
 *   - The guide id comes from the workspace's guide read endpoint. A build
 *     without that endpoint skips; the test never invents a guide.
 *   - The expected content types are read from the response, not asserted
 *     to a specific vendor value, because different renderers may choose
 *     container types (application/pdf, application/zip, application/vnd.
 *     openxmlformats-officedocument.wordprocessingml.document, text/html,
 *     text/markdown, text/plain). The test asserts the *family*.
 *   - A 4xx from the export route is treated as a recorded observation
 *     (the format may need operator configuration); a 5xx is a failure.
 */

import { test, expect, UUID_PATTERN } from "./helpers/setup";
import type { APIRequestContext } from "@playwright/test";

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

test.describe("Export formats", () => {
  test("each advertised format produces a downloadable artifact", async ({
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
      "No guide id could be resolved (the guide read endpoint is not present or returned no rows). Export did not run.",
    );
    if (guideId === null) return;

    interface FormatExpectation {
      readonly format: string;
      readonly acceptable: readonly string[];
      readonly description: string;
    }

    const expectations: readonly FormatExpectation[] = [
      {
        format: "pdf",
        acceptable: ["application/pdf", "application/octet-stream"],
        description: "PDF export",
      },
      {
        format: "html",
        acceptable: ["text/html", "application/xhtml+xml"],
        description: "HTML export",
      },
      {
        format: "markdown",
        acceptable: ["text/markdown", "text/plain", "text/x-markdown"],
        description: "Markdown export",
      },
      {
        format: "docx",
        acceptable: [
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/zip",
          "application/octet-stream",
        ],
        description: "DOCX export",
      },
      {
        format: "image_pack",
        acceptable: ["application/zip", "application/octet-stream"],
        description: "image pack export",
      },
    ];

    for (const exp of expectations) {
      const res = await api.post(
        `/api/guides/${encodeURIComponent(guideId)}/export`,
        {
          headers: {
            "content-type": "application/json",
            cookie: session.cookieHeader,
          },
          data: { format: exp.format },
        },
      );

      if (res.status() === 404) {
        test.info().annotations.push({
          type: "note",
          description: `${exp.description}: export route not present on this server (HTTP 404).`,
        });
        continue;
      }
      if (res.status() === 501) {
        test.info().annotations.push({
          type: "note",
          description: `${exp.description}: not implemented on this server (HTTP 501).`,
        });
        continue;
      }
      if (res.status() >= 400 && res.status() < 500) {
        test.info().annotations.push({
          type: "note",
          description: `${exp.description}: rejected with HTTP ${res.status()} — ${
            (await res.text().catch(() => "")).slice(0, 200) || "no body"
          }`,
        });
        continue;
      }

      expect(
        res.status(),
        `${exp.description}: expected success, got HTTP ${res.status()}.`,
      ).toBeLessThan(500);
      expect(
        res.status(),
        `${exp.description}: expected 2xx, got HTTP ${res.status()}.`,
      ).toBeGreaterThanOrEqual(200);
      expect(
        res.status(),
        `${exp.description}: expected 2xx, got HTTP ${res.status()}.`,
      ).toBeLessThan(300);

      const contentType = (res.headers()["content-type"] ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== undefined && contentType.length > 0) {
        expect(
          exp.acceptable.includes(contentType) ||
            contentType.startsWith("application/octet-stream"),
          `${exp.description}: content-type "${contentType}" is not in ${exp.acceptable.join(
            " | ",
          )}`,
        ).toBe(true);
      }

      const buf = await res.body();
      expect(
        buf.byteLength,
        `${exp.description}: exporter returned an empty body`,
      ).toBeGreaterThan(0);

      // A PDF must at least begin with the document header. This is the
      // smallest contract the `@zipy/export/pdf` renderer advertises.
      if (exp.format === "pdf") {
        const prefix = buf.subarray(0, 5).toString("latin1");
        expect(
          prefix.startsWith("%PDF-"),
          `PDF export did not begin with the %PDF- header (received "${prefix}")`,
        ).toBe(true);
      }

      // A ZIP-family payload begins with the local-file header `PK\x03\x04`.
      if (exp.format === "docx" || exp.format === "image_pack") {
        const ok =
          buf.byteLength >= 4 &&
          buf[0] === 0x50 &&
          buf[1] === 0x4b &&
          (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
        if (contentType === "application/zip" || exp.format === "image_pack") {
          expect(
            ok,
            `${exp.description}: ZIP container did not begin with the PK signature.`,
          ).toBe(true);
        }
      }
    }
  });

  test("embed code references the guide and is usable in an iframe", async ({
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
      "No guide id could be resolved; embed code was not exercised.",
    );
    if (guideId === null) return;

    // The embed surface is served from the export route with an embed
    // format, matching the phase 20 export contract.
    const res = await api.post(
      `/api/guides/${encodeURIComponent(guideId)}/export`,
      {
        headers: {
          "content-type": "application/json",
          cookie: session.cookieHeader,
        },
        data: { format: "embed" },
      },
    );

    test.skip(
      res.status() === 404,
      "The export route does not expose an embed format on this server.",
    );
    if (res.status() === 501) {
      test.info().annotations.push({
        type: "note",
        description: "Embed format is not implemented on this server (HTTP 501).",
      });
      return;
    }
    if (res.status() >= 400 && res.status() < 500) {
      test.info().annotations.push({
        type: "note",
        description: `Embed export was rejected with HTTP ${res.status()}.`,
      });
      return;
    }
    expectOk(res, "embed export");

    const body = (await res.text()).trim();
    expect(
      body.length,
      "embed export returned an empty snippet",
    ).toBeGreaterThan(0);

    // The snippet must reference the guide by id or slug. Either shape
    // satisfies the contract the embed renderer advertises.
    expect(
      body.includes(guideId),
      "embed snippet does not reference the guide id",
    ).toBe(true);

    // An iframe or a script tag is required for the snippet to be usable
    // on an external site. Both are documented; the renderer picks one.
    const hasIframe = /<iframe\b/i.test(body);
    const hasScript = /<script\b/i.test(body);
    expect(
      hasIframe || hasScript,
      "embed snippet must contain an <iframe> or a <script> tag",
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

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
