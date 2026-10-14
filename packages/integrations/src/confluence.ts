/**
 * Zipy AI — Confluence integration adapter (phase 21, batch 3).
 *
 * Publishes a Zipy AI guide into Confluence as a new page in a space, or
 * updates an existing page when the workspace has configured a
 * "same title means update" policy or supplied the page id explicitly.
 *
 * Two Confluence surfaces are supported because they map to different
 * provisioning paths and different storage-format contracts:
 *
 *   - Confluence Cloud (REST v2): uses `storage` format XHTML for the
 *     page body; the Confluence cloud base URL is the site's `*.atlassian.net`
 *     host. Auth is a basic-auth pair of (email, API token) — same
 *     Atlassian API token the Jira Cloud adapter uses, but the two
 *     integrations are kept independent so a workspace can authorize one
 *     without the other.
 *
 *   - Confluence Server / Data Center (REST v1): uses the older REST path
 *     and accepts a personal access token (Bearer) or a username +
 *     password pair. The base URL is the operator's internal host.
 *
 * Design boundaries
 * -----------------
 *  - No credential is invented. When nothing is configured, every send
 *    throws `IntegrationError` with `code: "not-configured"` listing the
 *    exact environment variables the operator must supply.
 *
 *  - No HTTP implementation is embedded. The caller supplies a
 *    `Transport` (typically `globalThis.fetch`).
 *
 *  - No page is fabricated. The caller supplies the space key and title.
 *    When updating, the caller supplies the numeric page id and the
 *    current version number; the adapter never guesses the version by
 *    fetching the page first, because a fetch-then-update cycle races a
 *    concurrent edit and would silently overwrite a reviewer's change.
 *    The caller (typically a job that has just fetched the page for an
 *    unrelated reason) supplies the version it saw.
 *
 *  - Bodies are supplied as XHTML in `storage` format. The adapter does
 *    not invent a Markdown-to-storage converter, because Confluence's
 *    storage format is XHTML with a macro language and a naive converter
 *    would produce a page that renders wrong. A caller that has a
 *    `GuideDocument` uses the export layer's HTML renderer (which
 *    produces a compatible fragment) and passes it here.
 *
 *  - Errors are surfaced verbatim. Confluence returns a JSON error body
 *    with `statusCode`, `message` and, on a validation failure, a
 *    `data.errors` list; the adapter re-raises them so a reviewer sees
 *    what Confluence actually said.
 *
 *  - No OAuth. Confluence Cloud *does* support OAuth 2.0 for marketplace
 *    apps; that requires an app registration and a redirect, which is an
 *    external setup the customer performs, not something this adapter
 *    silently implements. The customer supplies an API token.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ConfluenceErrorCode =
  | "invalid-input"
  | "not-configured"
  | "transport-failure"
  | "confluence-rejected"
  | "rate-limited"
  | "conflict";

export class ConfluenceIntegrationError extends Error {
  readonly code: ConfluenceErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    code: ConfluenceErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ConfluenceIntegrationError";
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type ConfluenceTransport = (input: {
  readonly url: string;
  readonly method: "POST" | "PUT" | "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}) => Promise<{
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}>;

export type ConfluenceApiKind = "cloud" | "server";

export type ConfluenceAuth =
  | {
      readonly kind: "cloud-api-token";
      readonly email: string;
      readonly apiToken: string;
      /** The site base URL, e.g. `https://acme.atlassian.net`. */
      readonly siteBaseUrl: string;
    }
  | {
      readonly kind: "server-pat";
      readonly personalAccessToken: string;
      readonly siteBaseUrl: string;
    }
  | {
      readonly kind: "server-basic";
      readonly username: string;
      readonly password: string;
      readonly siteBaseUrl: string;
    };

export interface ConfluenceAuthFromEnv {
  readonly cloudEmail: string | null;
  readonly cloudApiToken: string | null;
  readonly cloudSiteUrl: string | null;
  readonly serverPat: string | null;
  readonly serverBasicUsername: string | null;
  readonly serverBasicPassword: string | null;
  readonly serverSiteUrl: string | null;
}

/**
 * A new page to create. `bodyStorageXhtml` is Confluence's `storage`
 * format: a well-formed XHTML fragment. The adapter validates only that
 * the string is non-empty; Confluence itself validates the markup and
 * returns a precise error when it is wrong.
 */
export interface ConfluencePageDraft {
  readonly spaceKey: string;
  readonly title: string;
  readonly bodyStorageXhtml: string;
  /** Optional parent page id, to nest under an existing page. */
  readonly parentPageId?: string | null;
  /** Optional labels applied after creation. */
  readonly labels?: readonly string[];
}

export interface ConfluencePageDelivery {
  readonly ok: true;
  readonly pageId: string;
  readonly version: number;
  readonly pageUrl: string | null;
  /** The exact JSON body the adapter sent. */
  readonly payloadJson: string;
  readonly httpStatus: number;
}

/**
 * An update to an existing page. `previousVersion` must be the version
 * the caller most recently observed. The adapter passes
 * `previousVersion + 1` as the new version; Confluence's optimistic
 * concurrency check rejects a stale write with a 409, which the adapter
 * maps to `conflict`. Passing the observed version is a hard requirement
 * so a silent overwrite is impossible.
 */
export interface ConfluencePageUpdate {
  readonly pageId: string;
  readonly title: string;
  readonly bodyStorageXhtml: string;
  readonly previousVersion: number;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export function readConfluenceEnv(
  source: Readonly<Record<string, string | undefined>>,
): ConfluenceAuthFromEnv {
  return {
    cloudEmail: nonEmpty(source["CONFLUENCE_CLOUD_EMAIL"]),
    cloudApiToken: nonEmpty(source["CONFLUENCE_CLOUD_API_TOKEN"]),
    cloudSiteUrl: nonEmpty(source["CONFLUENCE_CLOUD_SITE_URL"]),
    serverPat: nonEmpty(source["CONFLUENCE_SERVER_PAT"]),
    serverBasicUsername: nonEmpty(source["CONFLUENCE_SERVER_BASIC_USERNAME"]),
    serverBasicPassword: nonEmpty(source["CONFLUENCE_SERVER_BASIC_PASSWORD"]),
    serverSiteUrl: nonEmpty(source["CONFLUENCE_SERVER_SITE_URL"]),
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class ConfluenceAdapter {
  private readonly auth: ConfluenceAuth;
  private readonly transport: ConfluenceTransport;
  private readonly apiKind: ConfluenceApiKind;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /** @internal — construct via `createConfluenceAdapter`. */
  constructor(input: {
    readonly auth: ConfluenceAuth;
    readonly transport: ConfluenceTransport;
    readonly timeoutMs?: number;
  }) {
    this.auth = input.auth;
    this.transport = input.transport;
    this.apiKind = input.auth.kind === "cloud-api-token" ? "cloud" : "server";
    const base = input.auth.siteBaseUrl.replace(/\/+$/, "");
    // Cloud uses `/wiki/rest/api` (v1) — Confluence Cloud's v2 REST API
    // (`/wiki/api/v2`) uses a different page shape and requires a separate
    // body-format parameter, and the v1 storage-format contract is the
    // more widely documented. The v1 path is deliberately chosen here.
    this.baseUrl = `${base}/wiki/rest/api`;
    this.timeoutMs =
      typeof input.timeoutMs === "number" &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : 20_000;
  }

  get restBaseUrl(): string {
    return this.baseUrl;
  }

  get apiProduct(): ConfluenceApiKind {
    return this.apiKind;
  }

  /**
   * Create a page. The body is sent as Confluence `storage` format. When
   * `labels` are supplied, they are applied after creation in a separate
   * call (Confluence accepts them inline only for certain API versions).
   */
  async createPage(draft: ConfluencePageDraft): Promise<ConfluencePageDelivery> {
    if (draft === null || typeof draft !== "object") {
      throw new ConfluenceIntegrationError("`draft` is required.", "invalid-input");
    }
    if (!nonEmpty(draft.spaceKey)) {
      throw new ConfluenceIntegrationError("`draft.spaceKey` is required.", "invalid-input");
    }
    if (!nonEmpty(draft.title)) {
      throw new ConfluenceIntegrationError("`draft.title` is required.", "invalid-input");
    }
    if (!nonEmpty(draft.bodyStorageXhtml)) {
      throw new ConfluenceIntegrationError(
        "`draft.bodyStorageXhtml` is required; the adapter does not invent a body.",
        "invalid-input",
      );
    }

    const payload: Record<string, unknown> = {
      type: "page",
      title: draft.title,
      space: { key: draft.spaceKey },
      body: {
        storage: {
          value: draft.bodyStorageXhtml,
          representation: "storage",
        },
      },
    };
    const parentPageId = nonEmpty(draft.parentPageId ?? null);
    if (parentPageId !== null) {
      payload["ancestors"] = [{ id: parentPageId }];
    }

    const body = JSON.stringify(payload);
    const response = await this.request({
      url: `${this.baseUrl}/content`,
      method: "POST",
      body,
    });

    if (response.status === 429) {
      throw new ConfluenceIntegrationError(
        "Confluence rate-limited the request.",
        "rate-limited",
        { httpStatus: 429 },
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ConfluenceIntegrationError(
        `Confluence rejected the credential (HTTP ${response.status}). Verify the token, its scope, and that the target space is shared with the credential.`,
        "not-configured",
        { httpStatus: response.status, body: truncate(response.body, 500) },
      );
    }
    if (response.status === 409) {
      // A 409 from a create usually means the title already exists in
      // the space and the space disallows duplicates. The caller's policy
      // decides whether to update instead; the adapter reports the raw
      // signal so the caller can.
      throw new ConfluenceIntegrationError(
        "Confluence reports a conflict (HTTP 409) creating the page; a page with this title may already exist in the space.",
        "conflict",
        { httpStatus: 409, body: truncate(response.body, 500) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const parsedError = parseConfluenceError(response.body);
      throw new ConfluenceIntegrationError(
        `Confluence returned HTTP ${response.status} creating the page: ${parsedError ?? truncate(response.body, 300)}`,
        "confluence-rejected",
        {
          httpStatus: response.status,
          body: truncate(response.body, 1_000),
          confluenceError: parsedError,
        },
      );
    }

    const parsed = parsePageResponse(response.body);
    if (parsed === null) {
      throw new ConfluenceIntegrationError(
        "Confluence accepted the create request but did not return a page id; the page may or may not exist. Inspect the response body.",
        "confluence-rejected",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
      );
    }

    if (draft.labels !== undefined && draft.labels.length > 0) {
      await this.applyLabels(parsed.pageId, draft.labels);
    }

    return {
      ok: true,
      pageId: parsed.pageId,
      version: parsed.version,
      pageUrl: parsed.pageUrl,
      payloadJson: body,
      httpStatus: response.status,
    };
  }

  /**
   * Update an existing page. The caller supplies the observed version so
   * the adapter can perform Confluence's optimistic concurrency check
   * correctly. A mismatch with the server's current version is a 409,
   * surfaced as `conflict` rather than retried, because the correct
   * recovery (refetch and re-merge) belongs to the caller.
   */
  async updatePage(update: ConfluencePageUpdate): Promise<ConfluencePageDelivery> {
    if (update === null || typeof update !== "object") {
      throw new ConfluenceIntegrationError("`update` is required.", "invalid-input");
    }
    if (!nonEmpty(update.pageId)) {
      throw new ConfluenceIntegrationError("`update.pageId` is required.", "invalid-input");
    }
    if (!nonEmpty(update.title)) {
      throw new ConfluenceIntegrationError("`update.title` is required.", "invalid-input");
    }
    if (!nonEmpty(update.bodyStorageXhtml)) {
      throw new ConfluenceIntegrationError(
        "`update.bodyStorageXhtml` is required.",
        "invalid-input",
      );
    }
    if (
      typeof update.previousVersion !== "number" ||
      !Number.isInteger(update.previousVersion) ||
      update.previousVersion < 1
    ) {
      throw new ConfluenceIntegrationError(
        "`update.previousVersion` must be a positive integer (the version most recently observed by the caller).",
        "invalid-input",
        { received: update.previousVersion },
      );
    }

    // Confluence's update contract: `id` and `type` are required; the new
    // version number is `previousVersion + 1`.
    const payload = {
      id: update.pageId,
      type: "page",
      title: update.title,
      version: {
        number: update.previousVersion + 1,
        message: "Regenerated by Zipy AI",
      },
      body: {
        storage: {
          value: update.bodyStorageXhtml,
          representation: "storage",
        },
      },
    };
    const body = JSON.stringify(payload);
    const response = await this.request({
      url: `${this.baseUrl}/content/${encodeURIComponent(update.pageId)}`,
      method: "PUT",
      body,
    });

    if (response.status === 429) {
      throw new ConfluenceIntegrationError(
        "Confluence rate-limited the update request.",
        "rate-limited",
        { httpStatus: 429 },
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status === 409) {
      throw new ConfluenceIntegrationError(
        "Confluence reports a version conflict (HTTP 409); the page has changed since the version the caller observed. Refetch and retry with the current version.",
        "conflict",
        { httpStatus: 409, previousVersion: update.previousVersion },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const parsedError = parseConfluenceError(response.body);
      throw new ConfluenceIntegrationError(
        `Confluence returned HTTP ${response.status} updating the page: ${parsedError ?? truncate(response.body, 300)}`,
        "confluence-rejected",
        {
          httpStatus: response.status,
          body: truncate(response.body, 1_000),
          confluenceError: parsedError,
        },
      );
    }
    const parsed = parsePageResponse(response.body);
    if (parsed === null) {
      throw new ConfluenceIntegrationError(
        "Confluence accepted the update request but did not return a version; inspect the response body.",
        "confluence-rejected",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
      );
    }
    return {
      ok: true,
      pageId: parsed.pageId,
      version: parsed.version,
      pageUrl: parsed.pageUrl,
      payloadJson: body,
      httpStatus: response.status,
    };
  }

  /**
   * Find a page by title within a space. Returns `null` when there is no
   * match. Used by a caller that wants a "same title means update" policy
   * so it can supply the observed version to `updatePage`. The adapter
   * does not implement the update-if-exists flow itself because that is
   * a race-prone two-step the caller must schedule deliberately.
   */
  async findPageByTitle(input: {
    readonly spaceKey: string;
    readonly title: string;
  }): Promise<{ readonly pageId: string; readonly version: number } | null> {
    if (!nonEmpty(input.spaceKey)) {
      throw new ConfluenceIntegrationError("`spaceKey` is required.", "invalid-input");
    }
    if (!nonEmpty(input.title)) {
      throw new ConfluenceIntegrationError("`title` is required.", "invalid-input");
    }
    const query = `space=${encodeURIComponent(input.spaceKey)}&title=${encodeURIComponent(input.title)}&expand=version&limit=1`;
    const url = `${this.baseUrl}/content?${query}`;
    const response = await this.request({ url, method: "GET" });
    if (response.status < 200 || response.status >= 300) {
      const parsedError = parseConfluenceError(response.body);
      throw new ConfluenceIntegrationError(
        `Confluence returned HTTP ${response.status} searching by title: ${parsedError ?? truncate(response.body, 300)}`,
        "confluence-rejected",
        {
          httpStatus: response.status,
          body: truncate(response.body, 1_000),
          confluenceError: parsedError,
        },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new ConfluenceIntegrationError(
        "Confluence search returned a non-JSON body.",
        "confluence-rejected",
        { httpStatus: response.status },
      );
    }
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const results = Array.isArray(obj["results"]) ? obj["results"] : [];
    if (results.length === 0) return null;
    const first = results[0];
    if (first === null || typeof first !== "object") return null;
    const f = first as Record<string, unknown>;
    const pageId = typeof f["id"] === "string" ? f["id"] : null;
    if (pageId === null) return null;
    const versionObj =
      f["version"] !== null && typeof f["version"] === "object"
        ? (f["version"] as Record<string, unknown>)
        : null;
    const version =
      versionObj !== null && typeof versionObj["number"] === "number"
        ? versionObj["number"]
        : 1;
    return { pageId, version };
  }

  // -- Internals -------------------------------------------------------

  private async applyLabels(pageId: string, labels: readonly string[]): Promise<void> {
    // Confluence label application is a batch POST to
    // `/content/{id}/label`, sending `[{prefix: "global", name: "..."}]`.
    const cleaned: { prefix: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const l of labels) {
      const n = nonEmpty(l);
      if (n !== null && !seen.has(n)) {
        seen.add(n);
        cleaned.push({ prefix: "global", name: n });
      }
    }
    if (cleaned.length === 0) return;
    const body = JSON.stringify(cleaned);
    const response = await this.request({
      url: `${this.baseUrl}/content/${encodeURIComponent(pageId)}/label`,
      method: "POST",
      body,
    });
    if (response.status < 200 || response.status >= 300) {
      const parsedError = parseConfluenceError(response.body);
      throw new ConfluenceIntegrationError(
        `Confluence returned HTTP ${response.status} applying labels: ${parsedError ?? truncate(response.body, 300)}`,
        "confluence-rejected",
        {
          httpStatus: response.status,
          body: truncate(response.body, 1_000),
          confluenceError: parsedError,
          pageId,
        },
      );
    }
  }

  private async request(input: {
    readonly url: string;
    readonly method: "POST" | "PUT" | "GET";
    readonly body?: string;
  }): Promise<{
    readonly status: number;
    readonly body: string;
    readonly headers?: Readonly<Record<string, string>>;
  }> {
    if (typeof this.transport !== "function") {
      throw new ConfluenceIntegrationError(
        "The Confluence adapter was constructed without a transport function.",
        "invalid-input",
      );
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Zipy-AI-Confluence/1",
      Authorization: this.buildAuthHeader(),
    };
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    try {
      return await this.transport({
        url: input.url,
        method: input.method,
        headers,
        body: input.body,
        signal: abortAfter(this.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfluenceIntegrationError(
        `Confluence transport error: ${message}`,
        "transport-failure",
        { url: input.url, method: input.method },
      );
    }
  }

  private buildAuthHeader(): string {
    switch (this.auth.kind) {
      case "cloud-api-token":
        return `Basic ${base64Encode(`${this.auth.email}:${this.auth.apiToken}`)}`;
      case "server-pat":
        return `Bearer ${this.auth.personalAccessToken}`;
      case "server-basic":
        return `Basic ${base64Encode(`${this.auth.username}:${this.auth.password}`)}`;
      default: {
        const exhaustive: never = this.auth;
        void exhaustive;
        throw new ConfluenceIntegrationError("Unknown Confluence auth kind.", "invalid-input");
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateConfluenceAdapterInput {
  readonly auth: ConfluenceAuth;
  readonly transport: ConfluenceTransport;
  readonly timeoutMs?: number;
}

export function createConfluenceAdapter(
  input: CreateConfluenceAdapterInput,
): ConfluenceAdapter {
  if (input === null || typeof input !== "object") {
    throw new ConfluenceIntegrationError("`input` is required.", "invalid-input");
  }
  if (input.auth === null || typeof input.auth !== "object") {
    throw new ConfluenceIntegrationError(
      "Confluence auth is required. Supply a Cloud API token + email, a Server PAT, or a Server username + password.",
      "not-configured",
      {
        requiredEnv: [
          "CONFLUENCE_CLOUD_SITE_URL + CONFLUENCE_CLOUD_EMAIL + CONFLUENCE_CLOUD_API_TOKEN",
          "CONFLUENCE_SERVER_SITE_URL + CONFLUENCE_SERVER_PAT",
          "CONFLUENCE_SERVER_SITE_URL + CONFLUENCE_SERVER_BASIC_USERNAME + CONFLUENCE_SERVER_BASIC_PASSWORD",
        ],
      },
    );
  }
  if (typeof input.transport !== "function") {
    throw new ConfluenceIntegrationError(
      "A `transport` function is required (pass globalThis.fetch in production).",
      "invalid-input",
    );
  }
  const base = nonEmpty(input.auth.siteBaseUrl);
  if (base === null) {
    throw new ConfluenceIntegrationError(
      "Confluence `siteBaseUrl` is empty.",
      "not-configured",
      { requiredEnv: "CONFLUENCE_CLOUD_SITE_URL or CONFLUENCE_SERVER_SITE_URL" },
    );
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConfluenceIntegrationError(
      "Confluence `siteBaseUrl` is not a valid URL.",
      "invalid-input",
      { url: base },
    );
  }
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new ConfluenceIntegrationError(
      "Confluence `siteBaseUrl` must use https:// (http:// is accepted only for localhost development).",
      "invalid-input",
      { url: base, protocol: url.protocol, hostname: url.hostname },
    );
  }
  switch (input.auth.kind) {
    case "cloud-api-token":
      if (!nonEmpty(input.auth.email) || !nonEmpty(input.auth.apiToken)) {
        throw new ConfluenceIntegrationError(
          "Confluence Cloud auth requires both an email and an API token.",
          "not-configured",
          { requiredEnv: ["CONFLUENCE_CLOUD_EMAIL", "CONFLUENCE_CLOUD_API_TOKEN"] },
        );
      }
      break;
    case "server-pat":
      if (!nonEmpty(input.auth.personalAccessToken)) {
        throw new ConfluenceIntegrationError(
          "Confluence Server PAT is empty.",
          "not-configured",
          { requiredEnv: "CONFLUENCE_SERVER_PAT" },
        );
      }
      break;
    case "server-basic":
      if (!nonEmpty(input.auth.username) || !nonEmpty(input.auth.password)) {
        throw new ConfluenceIntegrationError(
          "Confluence Server basic auth requires both a username and a password.",
          "not-configured",
          {
            requiredEnv: [
              "CONFLUENCE_SERVER_BASIC_USERNAME",
              "CONFLUENCE_SERVER_BASIC_PASSWORD",
            ],
          },
        );
      }
      break;
    default: {
      const exhaustive: never = input.auth;
      void exhaustive;
      throw new ConfluenceIntegrationError("Unknown Confluence auth kind.", "invalid-input");
    }
  }
  return new ConfluenceAdapter(input);
}

/**
 * Convenience factory: choose the auth surface from environment variables.
 * Cloud is tried first (most customers provision Atlassian Cloud), then
 * Server PAT, then Server basic. When none are complete, throws
 * `not-configured` listing the variables the operator must supply.
 */
export function createConfluenceAdapterFromEnv(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly transport: ConfluenceTransport;
  readonly timeoutMs?: number;
}): ConfluenceAdapter {
  const env = readConfluenceEnv(input.env);
  if (
    env.cloudSiteUrl !== null &&
    env.cloudEmail !== null &&
    env.cloudApiToken !== null
  ) {
    return createConfluenceAdapter({
      auth: {
        kind: "cloud-api-token",
        siteBaseUrl: env.cloudSiteUrl,
        email: env.cloudEmail,
        apiToken: env.cloudApiToken,
      },
      transport: input.transport,
      timeoutMs: input.timeoutMs,
    });
  }
  if (env.serverSiteUrl !== null && env.serverPat !== null) {
    return createConfluenceAdapter({
      auth: {
        kind: "server-pat",
        siteBaseUrl: env.serverSiteUrl,
        personalAccessToken: env.serverPat,
      },
      transport: input.transport,
      timeoutMs: input.timeoutMs,
    });
  }
  if (
    env.serverSiteUrl !== null &&
    env.serverBasicUsername !== null &&
    env.serverBasicPassword !== null
  ) {
    return createConfluenceAdapter({
      auth: {
        kind: "server-basic",
        siteBaseUrl: env.serverSiteUrl,
        username: env.serverBasicUsername,
        password: env.serverBasicPassword,
      },
      transport: input.transport,
      timeoutMs: input.timeoutMs,
    });
  }
  throw new ConfluenceIntegrationError(
    "Confluence is not configured. Set CONFLUENCE_CLOUD_SITE_URL + CONFLUENCE_CLOUD_EMAIL + CONFLUENCE_CLOUD_API_TOKEN (Confluence Cloud) or CONFLUENCE_SERVER_SITE_URL + CONFLUENCE_SERVER_PAT (Server / Data Center), or a Server username + password pair.",
    "not-configured",
    {
      requiredEnv: [
        "CONFLUENCE_CLOUD_SITE_URL",
        "CONFLUENCE_CLOUD_EMAIL",
        "CONFLUENCE_CLOUD_API_TOKEN",
        "CONFLUENCE_SERVER_SITE_URL",
        "CONFLUENCE_SERVER_PAT",
      ],
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

interface ParsedPage {
  readonly pageId: string;
  readonly version: number;
  readonly pageUrl: string | null;
}

function parsePageResponse(body: string): ParsedPage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  // The v1 content response exposes `id`, `version.number` and, on some
  // representations, `_links.webui` for the canonical page URL. The
  // adapter assembles the full URL from `_links.base` + `_links.webui`
  // when both are present; if not, it returns null and the caller
  // constructs its own navigation.
  const pageId = typeof obj["id"] === "string" ? obj["id"] : null;
  if (pageId === null) return null;
  const versionObj =
    obj["version"] !== null && typeof obj["version"] === "object"
      ? (obj["version"] as Record<string, unknown>)
      : null;
  const version =
    versionObj !== null && typeof versionObj["number"] === "number"
      ? versionObj["number"]
      : 1;
  let pageUrl: string | null = null;
  const links =
    obj["_links"] !== null && typeof obj["_links"] === "object"
      ? (obj["_links"] as Record<string, unknown>)
      : null;
  if (links !== null) {
    const base = typeof links["base"] === "string" ? links["base"] : null;
    const webui = typeof links["webui"] === "string" ? links["webui"] : null;
    if (base !== null && webui !== null) {
      try {
        pageUrl = new URL(webui, base).toString();
      } catch {
        pageUrl = null;
      }
    }
  }
  return { pageId, version, pageUrl };
}

function parseConfluenceError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object") return null;
    const message = typeof parsed["message"] === "string" ? parsed["message"] : null;
    const errors =
      Array.isArray(parsed["data"]) && parsed["data"].length > 0
        ? (parsed["data"] as unknown[])
        : Array.isArray(parsed["errors"]) && parsed["errors"].length > 0
          ? (parsed["errors"] as unknown[])
          : null;
    const errorText = errors !== null ? errors.map(String).join("; ") : null;
    if (message === null && errorText === null) return null;
    return [message, errorText].filter((x) => x !== null).join(" — ");
  } catch {
    return null;
  }
}

function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function parseRetryAfterMs(
  headers: Readonly<Record<string, string>> | undefined,
): number | null {
  if (headers === undefined) return null;
  const raw = headers["Retry-After"] ?? headers["retry-after"];
  if (typeof raw !== "string") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds * 1000) : null;
}

function truncate(s: string, max: number): string {
  if (typeof s !== "string") return "";
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function base64Encode(s: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return globalThis.btoa(binary);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  parsePageResponse,
  parseConfluenceError,
  abortAfter,
  parseRetryAfterMs,
  base64Encode,
});
