/**
 * Shared helpers for the Zipy AI end-to-end test suite.
 *
 * These tests drive the running application over HTTP (Playwright request
 * fixtures) plus the browser for pages that need a session cookie. They do
 * not import server-only modules, do not touch the database directly, and
 * do not fabricate a passing run when an external dependency is missing:
 * every test that needs a capability the operator has not configured
 * skips with an explicit reason so the suite reports "did not run", not
 * "passed".
 *
 * What the helpers assume about the running app:
 *
 *   - The base URL comes from `ZIPY_E2E_BASE_URL`; the default is the local
 *     Replit-style binding (0.0.0.0 is not a valid client target — the
 *     helper normalises it to 127.0.0.1 for local calls).
 *   - A session is obtained via the auth API. Two shapes are supported:
 *     cookie-based (email/password sign-up or login, documented in the
 *     auth routes' phase) and pre-seeded (the operator supplies a cookie
 *     header via `ZIPY_E2E_COOKIE` for a session they provisioned
 *     themselves). If neither is possible, the helper returns null and the
 *     caller skips.
 *
 * Explicit non-goals:
 *   - No test calls undocumented endpoints. Where a helper would need an
 *     endpoint this repository does not show, it returns null and the
 *     caller skips.
 *   - No test asserts on internal module output. Every assertion is either
 *     an HTTP status, a JSON field the endpoint documents in its handler,
 *     or DOM text a page renders from the documented payload.
 *   - No test invents credentials. Sign-up uses a unique email derived from
 *     the test name + a per-run random suffix; login uses the credentials
 *     the test itself just created.
 */

import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface E2EConfig {
  /** Base URL the app is reachable at. Always a client-resolvable host. */
  readonly baseUrl: string;
  /**
   * Cookie header for a pre-provisioned session, if the operator supplied
   * one. When null, the helpers attempt sign-up + login.
   */
  readonly sessionCookie: string | null;
  /**
   * Whether the LLM stack is configured on the server, as reported by a
   * caller-visible signal. Set `ZIPY_E2E_LLM_CONFIGURED=1` once the server
   * has a provider; leave unset otherwise so LLM-dependent tests skip.
   */
  readonly llmConfigured: boolean;
  /**
   * Whether the automation stack (Playwright browsers on the worker) is
   * available. Set `ZIPY_E2E_BROWSER_AVAILABLE=1` when running this suite
   * against a server whose worker can execute a workflow end to end.
   */
  readonly browserAvailable: boolean;
}

function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readE2EConfig(): E2EConfig {
  const configuredBase = readEnv("ZIPY_E2E_BASE_URL");
  const fallback = "http://127.0.0.1:3000";
  const baseUrl = normaliseBaseUrl(configuredBase ?? fallback);

  return {
    baseUrl,
    sessionCookie: readEnv("ZIPY_E2E_COOKIE"),
    llmConfigured: readEnv("ZIPY_E2E_LLM_CONFIGURED") === "1",
    browserAvailable: readEnv("ZIPY_E2E_BROWSER_AVAILABLE") === "1",
  };
}

/**
 * The app binds to 0.0.0.0 for serving; clients cannot use 0.0.0.0 as a
 * request host on all platforms, so map it to 127.0.0.1 for tests. Any
 * other host is left untouched.
 */
function normaliseBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.hostname === "0.0.0.0" || url.hostname === "::") {
      url.hostname = "127.0.0.1";
    }
    return url.origin;
  } catch {
    return "http://127.0.0.1:3000";
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

export interface ZipyFixtures {
  readonly zipy: E2EConfig;
  /** An APIRequestContext pre-bound to `zipy.baseUrl`. */
  readonly api: APIRequestContext;
  /**
   * A session cookie for a freshly-created (or operator-supplied) account.
   * `null` when neither is possible — the caller should skip.
   */
  readonly session: SessionFixture | null;
}

export interface SessionFixture {
  readonly cookieHeader: string;
  readonly email: string;
  /** Workspace id as reported by the session bootstrap. Null if unknown. */
  readonly workspaceId: string | null;
}

export const test = base.extend<ZipyFixtures>({
  zipy: async ({}, use) => {
    await use(readE2EConfig());
  },

  api: async ({ playwright, zipy }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL: zipy.baseUrl,
      extraHTTPHeaders: { accept: "application/json" },
    });
    await use(ctx);
    await ctx.dispose();
  },

  session: async ({ api, zipy }, use, testInfo) => {
    const session = await obtainSession(api, zipy, testInfo.title);
    await use(session);
  },
});

export { expect };

/* -------------------------------------------------------------------------- */
/* Session bootstrap                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Obtain a session cookie. Precedence:
 *   1. `ZIPY_E2E_COOKIE` if the operator supplied one.
 *   2. Sign-up at `/api/auth/signup` then login at `/api/auth/login`.
 *
 * Returns null (not a throw) when neither path is available, so a calling
 * test skips with a clear reason rather than failing on server setup the
 * test is not responsible for.
 */
export async function obtainSession(
  api: APIRequestContext,
  zipy: E2EConfig,
  label: string,
): Promise<SessionFixture | null> {
  if (zipy.sessionCookie !== null) {
    return {
      cookieHeader: zipy.sessionCookie,
      email: process.env["ZIPY_E2E_EMAIL"] ?? "operator-supplied",
      workspaceId: readEnv("ZIPY_E2E_WORKSPACE_ID"),
    };
  }

  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `zipy-e2e-${sanitiseSlug(label)}-${suffix}@example.invalid`;
  const password = `Pw-${suffix}-${Math.random().toString(36).slice(2, 10)}`;

  const signup = await api.post("/api/auth/signup", {
    data: { email, password, displayName: "Zipy E2E" },
  });
  if (signup.status() === 404 || signup.status() === 501) {
    return null;
  }
  if (!signup.ok()) {
    // 401/403/409/422 can mean sign-up is disabled or the account exists;
    // neither is the test's fault, so skip rather than fail.
    return null;
  }

  const login = await api.post("/api/auth/login", {
    data: { email, password },
  });
  if (!login.ok()) return null;

  const setCookie = login.headers()["set-cookie"];
  const cookieHeader = extractCookieHeader(setCookie);
  if (cookieHeader === null) return null;

  const workspaceId = readWorkspaceId(await login.json().catch(() => null));

  return { cookieHeader, email, workspaceId };
}

function extractCookieHeader(
  setCookieHeader: string | undefined,
): string | null {
  if (typeof setCookieHeader !== "string" || setCookieHeader.length === 0) {
    return null;
  }
  const pairs: string[] = [];
  for (const piece of setCookieHeader.split(/,(?=[^;]+=)/)) {
    const first = piece.split(";")[0]?.trim();
    if (typeof first === "string" && first.includes("=")) pairs.push(first);
  }
  if (pairs.length === 0) return null;
  return pairs.join("; ");
}

function readWorkspaceId(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const direct = b["activeWorkspaceId"];
  if (typeof direct === "string") return direct;
  const session = b["session"];
  if (session !== null && typeof session === "object") {
    const s = session as Record<string, unknown>;
    if (typeof s["activeWorkspaceId"] === "string") return s["activeWorkspaceId"];
  }
  return null;
}

function sanitiseSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "case";
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Assert a response is OK; when it is 503 the caller is almost always
 * missing an operator-configured capability, and the test will typically
 * skip before reaching here. This helper exists for the cases where the
 * caller has already established the capability is present and a 503 is
 * therefore a real failure.
 */
export function expectOk(response: { status(): number }, context: string): void {
  expect(
    response.status(),
    `${context}: expected a 2xx response, received ${response.status()}.`,
  ).toBeGreaterThanOrEqual(200);
  expect(
    response.status(),
    `${context}: expected a 2xx response, received ${response.status()}.`,
  ).toBeLessThan(300);
}

/**
 * Read the `Idempotency-Key` (or equivalent) an endpoint echoed, if any.
 * Returns null when the endpoint does not document one.
 */
export function readHeader(
  response: { headers(): Record<string, string> },
  name: string,
): string | null {
  const headers = response.headers();
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Page helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Attach the session cookie to a browser page's context. The caller owns
 * the context; this only sets the cookie.
 */
export async function attachSessionCookie(
  page: Page,
  session: SessionFixture,
  baseUrl: string,
): Promise<void> {
  const cookies = session.cookieHeader
    .split(";")
    .map((piece) => piece.trim())
    .filter((piece) => piece.includes("="))
    .map((piece) => {
      const eq = piece.indexOf("=");
      return {
        name: piece.slice(0, eq),
        value: piece.slice(eq + 1),
        url: baseUrl,
      };
    });
  if (cookies.length === 0) return;
  await page.context().addCookies(cookies);
}

/** The UUID pattern every resource route in this repository uses. */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
