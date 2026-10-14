/**
 * Zipy AI — Jira integration adapter (phase 21, batch 3).
 *
 * Publishes a Zipy AI guide into a Jira project as an issue, and — the
 * inverse direction — turns a webhook-triggered Jira event into a
 * generation request. Both directions are needed by the product: a
 * "publish this guide as a Jira issue" action, and a "when a PRD or spec
 * issue changes, regenerate the tutorial" trigger.
 *
 * Two Jira surfaces are supported because they map to different Jira
 * provisioning paths and to different Jira Cloud / Server / Data Center
 * contract differences:
 *
 *   - Jira Cloud (REST v3): the current API. Uses Atlassian Document
 *     Format (ADF) for the body of a comment / description. The caller
 *     supplies an email + API token; the adapter does not perform OAuth.
 *
 *   - Jira Server / Data Center (REST v2): the older API, used on-prem.
 *     Accepts a plain-text and wiki-markup body. The caller supplies a
 *     personal access token (Bearer) or a basic-auth pair. This adapter
 *     does not choose for the customer; it is constructed against one of
 *     the two base URLs.
 *
 * Design boundaries
 * -----------------
 *  - No credential is invented. When nothing is configured, every send
 *    throws `IntegrationError` with `code: "not-configured"` listing the
 *    exact environment variables the operator must supply. There is no
 *    shared tenant and no fallback.
 *
 *  - No HTTP implementation is embedded. The caller supplies a
 *    `Transport` (typically `globalThis.fetch`) so the adapter is
 *    testable, routes Jira traffic through the workspace's proxy when one
 *    is configured, and makes the operator's own rate-limit policy
 *    visible in the calling code rather than hidden inside the adapter.
 *
 *  - No Jira issue is fabricated. The adapter never guesses a project
 *    key, an issue type id, or a field schema. Every field the caller
 *    wants to set is passed explicitly, and Jira's own rejection is
 *    surfaced verbatim (a 400 from Jira carries a precise per-field
 *    error list that a reviewer needs to see).
 *
 *  - No OAuth. Jira Cloud OAuth 2.0 requires an app registration,
 *    consent, and a redirect handler — that is an external setup step the
 *    customer performs against Atlassian, not something this adapter
 *    silently implements. The customer supplies either an API token (for
 *    Cloud) or a personal access token (for Server/DC); OAuth is
 *    documented as a customer-supplied credential.
 *
 *  - Inbound webhook verification is *documented*, not implemented. A
 *    Jira webhook's only signature mechanism is a shared secret in the
 *    URL, which the platform's events route compares in constant time
 *    against a value the customer configured. `describeJiraWebhook-
 *    VerificationRequirement` returns the steps the route must perform;
 *    the adapter does not verify because the route owns the raw request.
 *
 *  - Error surfaces are typed. A 401/403 is `not-configured` (the token
 *    is missing or expired); a 400 is `jira-rejected` with the field
 *    errors; a 429 is `rate-limited` with a `retryAfterMs`.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type JiraErrorCode =
  | "invalid-input"
  | "not-configured"
  | "transport-failure"
  | "jira-rejected"
  | "rate-limited";

export class JiraIntegrationError extends Error {
  readonly code: JiraErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    code: JiraErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "JiraIntegrationError";
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type JiraTransport = (input: {
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

/**
 * The API product the adapter is pointed at. Cloud uses REST v3 and ADF
 * (Atlassian Document Format) for rich text; Server/DC uses REST v2 and
 * wiki markup. The adapter dispatches document-body construction on this
 * distinction, so a caller cannot accidentally POST ADF to a v2 endpoint
 * (which Jira would silently accept as a plain string).
 */
export type JiraApiKind = "cloud" | "server";

export type JiraAuth =
  | {
      readonly kind: "cloud-api-token";
      /** The email associated with the API token. */
      readonly email: string;
      /** An Atlassian API token (from id.atlassian.com). */
      readonly apiToken: string;
      /** The site base URL, e.g. `https://acme.atlassian.net`. */
      readonly siteBaseUrl: string;
    }
  | {
      readonly kind: "server-pat";
      /** A Jira Server / Data Center personal access token. */
      readonly personalAccessToken: string;
      /** The Server base URL, e.g. `https://jira.internal.acme.com`. */
      readonly siteBaseUrl: string;
    }
  | {
      readonly kind: "server-basic";
      /** A Jira Server username (not an email). */
      readonly username: string;
      readonly password: string;
      readonly siteBaseUrl: string;
    };

export interface JiraAuthFromEnv {
  readonly cloudEmail: string | null;
  readonly cloudApiToken: string | null;
  readonly cloudSiteUrl: string | null;
  readonly serverPat: string | null;
  readonly serverBasicUsername: string | null;
  readonly serverBasicPassword: string | null;
  readonly serverSiteUrl: string | null;
}

export interface JiraIssueField {
  /** The Jira field id, e.g. `summary`, `description`, `customfield_10042`. */
  readonly id: string;
  /**
   * The raw value passed to Jira. The adapter does not transform it: a
   * caller setting a custom field to an id, a string or an object passes
   * exactly what Jira expects, so an operator debugging a rejected field
   * sees the value the caller supplied.
   */
  readonly value: unknown;
}

export interface JiraIssueDraft {
  readonly projectKey: string;
  /** The issue type *name* (e.g. "Task", "Story"). Jira resolves it. */
  readonly issueTypeName: string;
  /** A short summary line; Jira requires this field. */
  readonly summary: string;
  /**
   * The body, already converted to a text representation. The adapter
   * wraps it in ADF for Cloud or passes it verbatim for Server. If the
   * caller has an ADF document already, supply it via `bodyAdf` instead.
   */
  readonly bodyText: string | null;
  /**
   * A pre-built ADF document (Cloud only). When both `bodyText` and
   * `bodyAdf` are supplied, `bodyAdf` wins and `bodyText` is ignored,
   * because a caller that took the trouble to build ADF asked for it.
   */
  readonly bodyAdf: Readonly<Record<string, unknown>> | null;
  /** Additional fields, applied after the summary/description. */
  readonly extraFields?: readonly JiraIssueField[];
  /** Labels applied to the issue. */
  readonly labels?: readonly string[];
  /** Account id (Cloud) or username (Server) of the assignee. */
  readonly assigneeId?: string | null;
}

export interface JiraIssueDelivery {
  readonly ok: true;
  /** Jira's issue key, e.g. `ENG-4271`. */
  readonly issueKey: string;
  /** Jira's numeric issue id. */
  readonly issueId: string | null;
  /** The full self URL Jira returned; the caller renders it as a link. */
  readonly selfUrl: string | null;
  /** The exact JSON body the adapter sent. */
  readonly payloadJson: string;
  readonly httpStatus: number;
}

/**
 * Jira webhook payloads are loosely typed across versions. The adapter's
 * parser pulls only the fields it needs and refuses the rest; a caller
 * that wants the raw payload uses `rawJson` on the parsed result.
 */
export interface JiraWebhookEvent {
  readonly webhookEvent: string;
  readonly issue: {
    readonly id: string;
    readonly key: string;
    readonly project: { readonly id: string; readonly key: string } | null;
    readonly issueType: string | null;
    readonly summary: string | null;
  } | null;
  /** The user who triggered the webhook, when Jira supplied one. */
  readonly userAccountId: string | null;
  /** The raw body, for audit logging alongside the parsed event. */
  readonly rawJson: string;
}

export interface JiraWebhookVerificationResult {
  readonly ok: boolean;
  readonly reason:
    | "ok"
    | "missing-secret"
    | "missing-signature"
    | "signature-mismatch";
  readonly detail: string;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export function readJiraEnv(
  source: Readonly<Record<string, string | undefined>>,
): JiraAuthFromEnv {
  return {
    cloudEmail: nonEmpty(source["JIRA_CLOUD_EMAIL"]),
    cloudApiToken: nonEmpty(source["JIRA_CLOUD_API_TOKEN"]),
    cloudSiteUrl: nonEmpty(source["JIRA_CLOUD_SITE_URL"]),
    serverPat: nonEmpty(source["JIRA_SERVER_PAT"]),
    serverBasicUsername: nonEmpty(source["JIRA_SERVER_BASIC_USERNAME"]),
    serverBasicPassword: nonEmpty(source["JIRA_SERVER_BASIC_PASSWORD"]),
    serverSiteUrl: nonEmpty(source["JIRA_SERVER_SITE_URL"]),
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class JiraAdapter {
  private readonly auth: JiraAuth;
  private readonly transport: JiraTransport;
  private readonly apiKind: JiraApiKind;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /** @internal — construct via `createJiraAdapter`. */
  constructor(input: {
    readonly auth: JiraAuth;
    readonly transport: JiraTransport;
    readonly timeoutMs?: number;
  }) {
    this.auth = input.auth;
    this.transport = input.transport;
    this.apiKind = input.auth.kind === "cloud-api-token" ? "cloud" : "server";
    const base = input.auth.siteBaseUrl.replace(/\/+$/, "");
    // Cloud uses `/rest/api/3`; Server/DC uses `/rest/api/2`. The api
    // version is a hard contract, not a config: mixing them produces
    // subtly different field validation that a caller cannot debug.
    this.baseUrl = `${base}/rest/api/${this.apiKind === "cloud" ? "3" : "2"}`;
    this.timeoutMs =
      typeof input.timeoutMs === "number" &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : 20_000;
  }

  /** The Jira REST base the adapter is pointed at, for the operator's dashboard. */
  get restBaseUrl(): string {
    return this.baseUrl;
  }

  /** The API product this adapter speaks to. */
  get apiProduct(): JiraApiKind {
    return this.apiKind;
  }

  /**
   * Create a Jira issue from a Zipy AI guide draft. The adapter does not
   * invent a description format: for Cloud it wraps `bodyText` in an ADF
   * document, and for Server it uses `bodyText` verbatim (Jira Server's
   * wiki markup renderer handles it). A caller that already has ADF
   * supplies `bodyAdf` directly, but only when the adapter is Cloud —
   * otherwise the field is refused so a misconfigured runtime is loud.
   */
  async createIssue(draft: JiraIssueDraft): Promise<JiraIssueDelivery> {
    if (draft === null || typeof draft !== "object") {
      throw new JiraIntegrationError("`draft` is required.", "invalid-input");
    }
    if (!nonEmpty(draft.projectKey)) {
      throw new JiraIntegrationError("`draft.projectKey` is required.", "invalid-input");
    }
    if (!nonEmpty(draft.issueTypeName)) {
      throw new JiraIntegrationError("`draft.issueTypeName` is required.", "invalid-input");
    }
    if (!nonEmpty(draft.summary)) {
      throw new JiraIntegrationError("`draft.summary` is required.", "invalid-input");
    }
    if (draft.bodyAdf !== null && this.apiKind !== "cloud") {
      throw new JiraIntegrationError(
        "An ADF description is only valid on Jira Cloud (REST v3); this adapter is pointed at Jira Server / Data Center (REST v2). Supply `bodyText` instead.",
        "invalid-input",
        { apiProduct: this.apiKind },
      );
    }

    const fields: Record<string, unknown> = {
      project: { key: draft.projectKey },
      issuetype: { name: draft.issueTypeName },
      summary: draft.summary,
    };

    if (draft.bodyAdf !== null) {
      fields["description"] = draft.bodyAdf;
    } else if (nonEmpty(draft.bodyText) !== null) {
      fields["description"] =
        this.apiKind === "cloud"
          ? textToAdf(draft.bodyText!)
          : draft.bodyText;
    }

    if (draft.labels !== undefined && draft.labels.length > 0) {
      // Labels are named `labels` in Jira's issue payload. Deduplicate
      // because Jira rejects an issue whose labels list has duplicates.
      const seen = new Set<string>();
      const labels: string[] = [];
      for (const l of draft.labels) {
        const n = nonEmpty(l);
        if (n !== null && !seen.has(n)) {
          seen.add(n);
          labels.push(n);
        }
      }
      if (labels.length > 0) fields["labels"] = labels;
    }

    if (nonEmpty(draft.assigneeId) !== null) {
      // Cloud uses `accountId`; Server/DC uses `name`. The adapter
      // selects per API product so a caller does not need to branch.
      fields["assignee"] =
        this.apiKind === "cloud"
          ? { accountId: draft.assigneeId }
          : { name: draft.assigneeId };
    }

    if (draft.extraFields !== undefined) {
      for (const f of draft.extraFields) {
        if (typeof f.id !== "string" || f.id.length === 0) {
          throw new JiraIntegrationError(
            "Every `extraFields` entry requires a non-empty `id`.",
            "invalid-input",
            { received: f },
          );
        }
        // Refuse to silently overwrite `summary` or `description` with a
        // second value: a caller that supplies both a `summary` and an
        // `extraFields` entry with `id: "summary"` almost certainly has a
        // bug, and Jira's own field-list would hide the first value.
        if (Object.prototype.hasOwnProperty.call(fields, f.id)) {
          throw new JiraIntegrationError(
            `\`extraFields\` would overwrite the "${f.id}" field set by the draft; supply one source for a field.`,
            "invalid-input",
            { field: f.id },
          );
        }
        fields[f.id] = f.value;
      }
    }

    const payload = { fields };
    const body = JSON.stringify(payload);
    const response = await this.request({
      url: `${this.baseUrl}/issue`,
      method: "POST",
      body,
    });

    if (response.status === 429) {
      throw new JiraIntegrationError(
        "Jira rate-limited the request.",
        "rate-limited",
        { httpStatus: 429 },
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new JiraIntegrationError(
        `Jira rejected the credential (HTTP ${response.status}). Verify the token, its scope, and that the site URL is correct.`,
        "not-configured",
        { httpStatus: response.status, body: truncate(response.body, 500) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      // Jira's 400 responses carry `errors: { field: message }`; surfacing
      // them verbatim saves a reviewer having to reproduce the call.
      let fieldErrors: Record<string, string> | null = null;
      try {
        const parsed = JSON.parse(response.body) as Record<string, unknown>;
        if (parsed !== null && typeof parsed === "object" && parsed["errors"] !== undefined) {
          if (typeof parsed["errors"] === "object" && parsed["errors"] !== null) {
            fieldErrors = parsed["errors"] as Record<string, string>;
          }
        }
      } catch {
        fieldErrors = null;
      }
      throw new JiraIntegrationError(
        `Jira returned HTTP ${response.status} creating the issue: ${truncate(response.body, 300)}`,
        "jira-rejected",
        {
          httpStatus: response.status,
          body: truncate(response.body, 1_000),
          fieldErrors,
        },
      );
    }

    let parsed: unknown = null;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      parsed = null;
    }
    const obj =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const issueKey = obj !== null && typeof obj["key"] === "string" ? obj["key"] : null;
    if (issueKey === null || issueKey.length === 0) {
      throw new JiraIntegrationError(
        "Jira accepted the create request but did not return an issue key; the issue may or may not exist. Inspect the response body.",
        "jira-rejected",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
      );
    }
    return {
      ok: true,
      issueKey,
      issueId:
        obj !== null && typeof obj["id"] === "string" ? obj["id"] : null,
      selfUrl:
        obj !== null && typeof obj["self"] === "string" ? obj["self"] : null,
      payloadJson: body,
      httpStatus: response.status,
    };
  }

  /**
   * Add a comment to an existing issue. Useful for appending a "Zipy AI
   * regenerated this guide" note to a spec issue. Cloud builds ADF; Server
   * sends plain text.
   */
  async addComment(
    issueKey: string,
    commentText: string,
  ): Promise<{ readonly ok: true; readonly commentId: string | null }> {
    if (!nonEmpty(issueKey)) {
      throw new JiraIntegrationError("`issueKey` is required.", "invalid-input");
    }
    if (!nonEmpty(commentText)) {
      throw new JiraIntegrationError("`commentText` is required.", "invalid-input");
    }
    const payload =
      this.apiKind === "cloud"
        ? { body: textToAdf(commentText) }
        : { body: commentText };
    const response = await this.request({
      url: `${this.baseUrl}/issue/${encodeURIComponent(issueKey)}/comment`,
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (response.status === 429) {
      throw new JiraIntegrationError(
        "Jira rate-limited the comment request.",
        "rate-limited",
        { httpStatus: 429 },
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new JiraIntegrationError(
        `Jira returned HTTP ${response.status} adding a comment: ${truncate(response.body, 300)}`,
        "jira-rejected",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
      );
    }
    let parsed: unknown = null;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      parsed = null;
    }
    const obj =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    return {
      ok: true,
      commentId:
        obj !== null && typeof obj["id"] === "string" ? obj["id"] : null,
    };
  }

  // -- Internals -------------------------------------------------------

  private async request(input: {
    readonly url: string;
    readonly method: "POST" | "PUT" | "GET";
    readonly body?: string;
  }): Promise<{ readonly status: number; readonly body: string; readonly headers?: Readonly<Record<string, string>> }> {
    if (typeof this.transport !== "function") {
      throw new JiraIntegrationError(
        "The Jira adapter was constructed without a transport function.",
        "invalid-input",
      );
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Zipy-AI-Jira/1",
    };
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    // The auth header is built per auth kind. Basic auth for Cloud
    // (email + API token) and for Server basic; Bearer for Server PAT.
    headers["Authorization"] = this.buildAuthHeader();
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
      throw new JiraIntegrationError(
        `Jira transport error: ${message}`,
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
        throw new JiraIntegrationError("Unknown Jira auth kind.", "invalid-input");
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateJiraAdapterInput {
  readonly auth: JiraAuth;
  readonly transport: JiraTransport;
  readonly timeoutMs?: number;
}

export function createJiraAdapter(input: CreateJiraAdapterInput): JiraAdapter {
  if (input === null || typeof input !== "object") {
    throw new JiraIntegrationError("`input` is required.", "invalid-input");
  }
  if (input.auth === null || typeof input.auth !== "object") {
    throw new JiraIntegrationError(
      "Jira auth is required. Supply a Cloud API token + email, a Server PAT, or a Server username + password.",
      "not-configured",
      {
        requiredEnv: [
          "JIRA_CLOUD_SITE_URL + JIRA_CLOUD_EMAIL + JIRA_CLOUD_API_TOKEN",
          "JIRA_SERVER_SITE_URL + JIRA_SERVER_PAT",
          "JIRA_SERVER_SITE_URL + JIRA_SERVER_BASIC_USERNAME + JIRA_SERVER_BASIC_PASSWORD",
        ],
      },
    );
  }
  if (typeof input.transport !== "function") {
    throw new JiraIntegrationError(
      "A `transport` function is required (pass globalThis.fetch in production).",
      "invalid-input",
    );
  }
  const base = nonEmpty(input.auth.siteBaseUrl);
  if (base === null) {
    throw new JiraIntegrationError(
      "Jira `siteBaseUrl` is empty.",
      "not-configured",
      { requiredEnv: "JIRA_CLOUD_SITE_URL or JIRA_SERVER_SITE_URL" },
    );
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new JiraIntegrationError(
      "Jira `siteBaseUrl` is not a valid URL.",
      "invalid-input",
      { url: base },
    );
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new JiraIntegrationError(
      "Jira `siteBaseUrl` must use https:// (http:// is accepted only for localhost development).",
      "invalid-input",
      { url: base, protocol: url.protocol, hostname: url.hostname },
    );
  }
  switch (input.auth.kind) {
    case "cloud-api-token":
      if (!nonEmpty(input.auth.email) || !nonEmpty(input.auth.apiToken)) {
        throw new JiraIntegrationError(
          "Jira Cloud auth requires both an email and an API token.",
          "not-configured",
          { requiredEnv: ["JIRA_CLOUD_EMAIL", "JIRA_CLOUD_API_TOKEN"] },
        );
      }
      break;
    case "server-pat":
      if (!nonEmpty(input.auth.personalAccessToken)) {
        throw new JiraIntegrationError(
          "Jira Server PAT is empty.",
          "not-configured",
          { requiredEnv: "JIRA_SERVER_PAT" },
        );
      }
      break;
    case "server-basic":
      if (!nonEmpty(input.auth.username) || !nonEmpty(input.auth.password)) {
        throw new JiraIntegrationError(
          "Jira Server basic auth requires both a username and a password.",
          "not-configured",
          { requiredEnv: ["JIRA_SERVER_BASIC_USERNAME", "JIRA_SERVER_BASIC_PASSWORD"] },
        );
      }
      break;
    default: {
      const exhaustive: never = input.auth;
      void exhaustive;
      throw new JiraIntegrationError("Unknown Jira auth kind.", "invalid-input");
    }
  }
  return new JiraAdapter(input);
}

/**
 * Convenience factory: choose the auth surface from environment variables.
 * Priority is Cloud API token, then Server PAT, then Server basic — Cloud
 * first because that is the surface most customers provision, and a
 * Server credential left present after a migration should not silently
 * take precedence. When none are complete, throws `not-configured`
 * listing the variables the operator must supply.
 */
export function createJiraAdapterFromEnv(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly transport: JiraTransport;
  readonly timeoutMs?: number;
}): JiraAdapter {
  const env = readJiraEnv(input.env);
  if (
    env.cloudSiteUrl !== null &&
    env.cloudEmail !== null &&
    env.cloudApiToken !== null
  ) {
    return createJiraAdapter({
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
    return createJiraAdapter({
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
    return createJiraAdapter({
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
  throw new JiraIntegrationError(
    "Jira is not configured. Set JIRA_CLOUD_SITE_URL + JIRA_CLOUD_EMAIL + JIRA_CLOUD_API_TOKEN (Jira Cloud) or JIRA_SERVER_SITE_URL + JIRA_SERVER_PAT (Jira Server / Data Center).",
    "not-configured",
    {
      requiredEnv: [
        "JIRA_CLOUD_SITE_URL",
        "JIRA_CLOUD_EMAIL",
        "JIRA_CLOUD_API_TOKEN",
        "JIRA_SERVER_SITE_URL",
        "JIRA_SERVER_PAT",
      ],
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Inbound webhook parsing + verification                                      */
/* -------------------------------------------------------------------------- */

/**
 * Parse a Jira webhook payload into the minimal shape the platform needs.
 * Jira's webhook body is large and versioned; this parser pulls only the
 * fields the platform routes on, and refuses to invent defaults for a
 * missing issue (a Jira webhook for a user has no `issue`).
 */
export function parseJiraWebhookEvent(rawBody: string): JiraWebhookEvent {
  if (typeof rawBody !== "string" || rawBody.length === 0) {
    throw new JiraIntegrationError(
      "Webhook body is empty.",
      "invalid-input",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new JiraIntegrationError(
      "Webhook body is not valid JSON.",
      "invalid-input",
      { byteLength: rawBody.length },
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new JiraIntegrationError(
      "Webhook body is not a JSON object.",
      "invalid-input",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const webhookEvent =
    typeof obj["webhookEvent"] === "string"
      ? obj["webhookEvent"]
      : typeof obj["webhookEventType"] === "string"
        ? obj["webhookEventType"]
        : "unknown";
  const issueRaw = obj["issue"];
  const issue =
    issueRaw !== null && typeof issueRaw === "object"
      ? readIssue(issueRaw as Record<string, unknown>)
      : null;
  const userRaw = obj["user"];
  const userAccountId =
    userRaw !== null && typeof userRaw === "object"
      ? nonEmpty((userRaw as Record<string, unknown>)["accountId"] as string | undefined)
      : null;
  return {
    webhookEvent,
    issue,
    userAccountId,
    rawJson: rawBody,
  };
}

/**
 * A Jira webhook's only built-in authentication is a shared secret in the
 * URL, checked by the receiving route. This function compares the route's
 * configured secret against the value Jira sent, in constant time, to
 * avoid a timing oracle. It returns a discriminated result rather than
 * throwing so the route can respond 401 with a reason.
 *
 * A caller that has configured a reverse proxy to strip or add a secret
 * header must perform the corresponding change on the receiving side;
 * this verifier accepts only a query-string secret so there is no
 * ambiguity about which channel was checked.
 */
export function verifyJiraWebhookSecret(input: {
  /** The secret as supplied in the request URL (e.g. `?zipy_secret=...`). */
  readonly receivedSecret: string | null;
  /** The secret the operator configured for this Jira webhook. */
  readonly configuredSecret: string | null;
}): JiraWebhookVerificationResult {
  if (input.configuredSecret === null || input.configuredSecret.length === 0) {
    return {
      ok: false,
      reason: "missing-secret",
      detail:
        "No Jira webhook secret is configured at the platform; the route must refuse unverified payloads rather than accept them.",
    };
  }
  if (input.receivedSecret === null || input.receivedSecret.length === 0) {
    return {
      ok: false,
      reason: "missing-signature",
      detail: "The inbound Jira webhook did not carry a `zipy_secret` query parameter.",
    };
  }
  // Constant-time compare on equal-length strings. `timingSafe` here is a
  // local helper (see below) that does not depend on node:crypto, because
  // the platform's events route may run on an edge runtime.
  if (!constantTimeStringEqual(input.receivedSecret, input.configuredSecret)) {
    return {
      ok: false,
      reason: "signature-mismatch",
      detail: "The inbound Jira webhook secret does not match the configured value.",
    };
  }
  return { ok: true, reason: "ok", detail: "Secret matches." };
}

/**
 * The verification steps the platform's Jira events route must perform
 * *before* parsing the body. This function documents them so a route
 * author cannot forget one; the adapter itself performs none of them
 * because the route owns the raw request and the operator's secret store.
 */
export function describeJiraWebhookVerificationRequirement(): readonly string[] {
  return [
    "Read the `zipy_secret` query parameter Jira was configured to append to the webhook URL, and refuse the request when it is absent (a Jira webhook can be replayed without it, so its absence is never benign).",
    "Compare the received secret against the workspace's configured JIRA_WEBHOOK_SECRET in constant time (this adapter exposes `verifyJiraWebhookSecret` for that comparison).",
    "Bind the resolved project key to a workspace: refuse a webhook whose `issue.fields.project.key` does not correspond to a workspace this platform has registered a Jira connection for.",
    "Apply a size limit to the raw body before JSON parsing, and reject a body over the configured maximum size (Jira payloads are typically small, but a proxy compromise could send any size).",
    "Store the raw body hash alongside the audit entry so a rebuild triggered by the webhook can be replayed against the exact bytes Jira delivered.",
    "Never trust the payload's own claims of a workspace id or a guide slug: resolve the workspace from the Jira connection record, not from the body.",
  ];
}

/* -------------------------------------------------------------------------- */
/* ADF builder                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Convert a Zipy AI guide body (plain text with single newlines) into a
 * minimal Atlassian Document Format document. The conversion is
 * deliberately minimal — a paragraph per line — because a rich conversion
 * would guess at the guide's structure, and Zipy AI already has the
 * structured `GuideDocument` type for a caller that needs a richer body.
 * A caller that has a `GuideDocument` supplies a purpose-built ADF via
 * `bodyAdf` instead.
 */
export function textToAdf(text: string): Readonly<Record<string, unknown>> {
  const paragraphs: Readonly<Record<string, unknown>>[] = [];
  const lines = text.split("\n");
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join("\n");
    if (joined.trim().length === 0) {
      buffer = [];
      return;
    }
    paragraphs.push({
      type: "paragraph",
      content: [{ type: "text", text: joined }],
    });
    buffer = [];
  };
  for (const line of lines) {
    if (line.trim().length === 0) {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
  if (paragraphs.length === 0) {
    // An empty body is still a valid ADF document; Jira accepts `content: []`.
    return { type: "doc", version: 1, content: [] };
  }
  return { type: "doc", version: 1, content: paragraphs };
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function readIssue(raw: Record<string, unknown>): JiraWebhookEvent["issue"] {
  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  const key = typeof raw["key"] === "string" ? raw["key"] : "";
  if (id.length === 0 && key.length === 0) return null;
  const fields =
    raw["fields"] !== null && typeof raw["fields"] === "object"
      ? (raw["fields"] as Record<string, unknown>)
      : null;
  const projectRaw = fields !== null ? fields["project"] : undefined;
  const project =
    projectRaw !== null && typeof projectRaw === "object"
      ? {
          id:
            typeof (projectRaw as Record<string, unknown>)["id"] === "string"
              ? ((projectRaw as Record<string, unknown>)["id"] as string)
              : "",
          key:
            typeof (projectRaw as Record<string, unknown>)["key"] === "string"
              ? ((projectRaw as Record<string, unknown>)["key"] as string)
              : "",
        }
      : null;
  const issueTypeRaw = fields !== null ? fields["issuetype"] : undefined;
  const issueType =
    issueTypeRaw !== null && typeof issueTypeRaw === "object"
      ? nonEmpty(
          (issueTypeRaw as Record<string, unknown>)["name"] as string | undefined,
        )
      : null;
  const summary =
    fields !== null ? nonEmpty(fields["summary"] as string | undefined) : null;
  return { id, key, project, issueType, summary };
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
  // UTF-8 safe base64 without depending on Buffer being present at call
  // time. `btoa` accepts latin-1 only; encode to UTF-8 bytes first.
  const encoder = new TextEncoder();
  const bytes = encoder.encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return globalThis.btoa(binary);
}

/**
 * Constant-time string compare without node:crypto, so the verifier runs
 * on an edge runtime. Returns false on unequal lengths (length itself is
 * not secret here: the operator configured one specific secret and Jira
 * appends exactly that value, so a length difference is already public).
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  textToAdf,
  readIssue,
  abortAfter,
  parseRetryAfterMs,
  constantTimeStringEqual,
  base64Encode,
});
