/**
 * Zipy AI — Microsoft Teams integration adapter (phase 21, batch 2).
 *
 * Publishes Zipy AI notifications and interactive approval cards to a Teams
 * channel. Two Teams surfaces are supported because they map to different
 * tenant provisioning paths:
 *
 *   - Incoming Webhook (a channel connector URL): the simplest surface, one
 *     way, suitable for "generation complete" notifications and for tenants
 *     that have not consented to an Azure AD app.
 *   - Bot Framework / Graph via a bot connector: required for interactive
 *     approval cards (Adaptive Cards with `Action.Submit`) which surface
 *     review decisions back to the platform. The bot's app id and secret
 *     come from an Azure AD app registration the customer owns.
 *
 * Design boundaries
 * -----------------
 *  - No credential is invented. When nothing is configured, every send
 *    throws `IntegrationError` with `code: "not-configured"` listing the
 *    required variables. There is no shared dev tenant and no fallback.
 *
 *  - No HTTP implementation is embedded. The caller supplies a `Transport`
 *    (typically `globalThis.fetch`) so the adapter is testable and a
 *    customer routes Teams traffic through the workspace's proxy.
 *
 *  - Graph token acquisition is *explicit*. `acquireGraphToken` is an
 *    optional injected function. When it is absent, the caller may pass a
 *    pre-acquired token on each call via `bearerToken`; when both are
 *    absent, calls that require Graph fail with `not-configured`. The
 *    adapter refuses to make its own OAuth call because an OAuth client
 *    secret handling path belongs in a single, audited place, not inside
 *    every integration.
 *
 *  - Card shape is typed and echoable. The exact Adaptive Card JSON the
 *    adapter sends is returned on the `TeamsDelivery` so a caller logging
 *    a rejected card sees what Teams actually received.
 *
 *  - Teams errors are surfaced verbatim. A Graph or connector failure is
 *    raised as `IntegrationError` carrying the HTTP status and a truncated
 *    body; a 429 gets a `retryAfterMs` derived from `Retry-After`.
 *
 *  - Incoming requests from Teams to the platform's callback are verified
 *    by the caller (Teams posts a bearer JWT signed by Microsoft). This
 *    adapter does not verify incoming JWTs — that is the platform's events
 *    route's responsibility; the adapter's exported
 *    `describeTeamsVerificationRequirement` documents what the caller must
 *    do so a route author cannot forget.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TeamsErrorCode =
  | "invalid-input"
  | "not-configured"
  | "transport-failure"
  | "teams-rejected"
  | "rate-limited";

export class TeamsIntegrationError extends Error {
  readonly code: TeamsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    code: TeamsErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "TeamsIntegrationError";
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type TeamsTransport = (input: {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}) => Promise<{
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}>;

/**
 * The tenant's Teams authentication surface.
 *
 *   - `connector` — an Incoming Webhook connector URL. One-way only.
 *   - `bot-framework` — a Teams bot registered in the customer's Azure AD.
 *     The bot id is public (it identifies the bot); the secret is held in
 *     the customer's secret store. A bearer token may be acquired per call
 *     via `acquireToken`, or supplied by the caller on each send.
 */
export type TeamsAuth =
  | {
      readonly kind: "connector";
      /** A Teams Incoming Webhook URL. */
      readonly webhookUrl: string;
    }
  | {
      readonly kind: "bot-framework";
      /** The bot's Microsoft App ID (a GUID). Public but required. */
      readonly appId: string;
      /** An interactive channel id (Teams `19:...@thread.tacv2` or similar). */
      readonly conversationId?: string | null;
      /** The Graph API base; override for a sovereign cloud or a proxy. */
      readonly graphBaseUrl?: string;
    };

export interface TeamsAuthFromEnv {
  readonly connectorUrl: string | null;
  readonly botAppId: string | null;
  readonly botAppSecret: string | null;
  readonly defaultConversationId: string | null;
}

export interface TeamsNotification {
  /** Short notification text; also used as the card's `text` block. */
  readonly text: string;
  /** Optional deep link. */
  readonly linkUrl?: string | null;
  /** Optional short context line, e.g. "workspace acme". */
  readonly contextLine?: string | null;
}

export interface TeamsApprovalCard {
  readonly workflowId: string;
  readonly gateId: string;
  readonly risk: "read-only" | "write" | "destructive" | "financial" | "external-communication";
  readonly summary: string;
  readonly actions: readonly string[];
  readonly reviewUrl: string | null;
  readonly requestedBy?: string | null;
}

export interface TeamsDelivery {
  readonly ok: boolean;
  /** The Graph/connector's message id, when the surface returns one. */
  readonly messageId: string | null;
  /** The exact JSON body the adapter sent. */
  readonly payloadJson: string;
  readonly httpStatus: number;
}

/**
 * An optional Graph token provider. Teams bot callbacks cannot POST to
 * Teams with a static token; a bearer token is issued by Microsoft and
 * expires. The customer supplies this function so their own credential
 * acquisition (client credentials flow, managed identity, a vault) is the
 * single source of tokens and the adapter does not implement OAuth.
 */
export type AcquireGraphToken = () => Promise<string>;

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export function readTeamsEnv(
  source: Readonly<Record<string, string | undefined>>,
): TeamsAuthFromEnv {
  return {
    connectorUrl: nonEmpty(source["TEAMS_CONNECTOR_URL"]),
    botAppId: nonEmpty(source["TEAMS_BOT_APP_ID"]),
    botAppSecret: nonEmpty(source["TEAMS_BOT_APP_SECRET"]),
    defaultConversationId: nonEmpty(source["TEAMS_DEFAULT_CONVERSATION_ID"]),
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class TeamsAdapter {
  private readonly auth: TeamsAuth;
  private readonly transport: TeamsTransport;
  private readonly graphBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly acquireToken: AcquireGraphToken | null;

  /** @internal — construct via `createTeamsAdapter`. */
  constructor(input: {
    readonly auth: TeamsAuth;
    readonly transport: TeamsTransport;
    readonly timeoutMs?: number;
    readonly acquireToken?: AcquireGraphToken | null;
  }) {
    this.auth = input.auth;
    this.transport = input.transport;
    this.graphBaseUrl =
      input.auth.kind === "bot-framework" && input.auth.graphBaseUrl
        ? input.auth.graphBaseUrl.replace(/\/+$/, "")
        : "https://graph.microsoft.com/v1.0";
    this.timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : 15_000;
    this.acquireToken = input.acquireToken ?? null;
  }

  /**
   * Post a notification. Uses the connector when the adapter is
   * connector-authenticated; uses Graph (with a bearer token) when the
   * adapter is bot-authenticated.
   */
  async notify(
    target: TeamsTarget | null,
    message: TeamsNotification,
  ): Promise<TeamsDelivery> {
    if (typeof message.text !== "string" || message.text.trim().length === 0) {
      throw new TeamsIntegrationError("`message.text` is required.", "invalid-input");
    }
    const card = buildNotificationCard(message);
    return this.sendCard(target, card);
  }

  /**
   * Post an approval Adaptive Card with `Action.Submit` buttons. The
   * buttons carry an `Action.Submit` payload the platform's Teams callback
   * route will receive; the payload includes the `gateId` and `workflowId`
   * so routing does not need a second lookup. Requires a bot-framework
   * adapter: a connector URL cannot deliver action callbacks.
   */
  async requestApproval(
    target: TeamsTarget | null,
    card: TeamsApprovalCard,
  ): Promise<TeamsDelivery> {
    if (typeof card.workflowId !== "string" || card.workflowId.trim().length === 0) {
      throw new TeamsIntegrationError("`card.workflowId` is required.", "invalid-input");
    }
    if (typeof card.gateId !== "string" || card.gateId.trim().length === 0) {
      throw new TeamsIntegrationError("`card.gateId` is required.", "invalid-input");
    }
    if (typeof card.summary !== "string" || card.summary.trim().length === 0) {
      throw new TeamsIntegrationError("`card.summary` is required.", "invalid-input");
    }
    if (this.auth.kind !== "bot-framework") {
      throw new TeamsIntegrationError(
        "Approval cards require a Teams bot registration (TEAMS_BOT_APP_ID + TEAMS_BOT_APP_SECRET). A connector webhook cannot deliver Adaptive Card action callbacks.",
        "not-configured",
        { requiredEnv: ["TEAMS_BOT_APP_ID", "TEAMS_BOT_APP_SECRET"] },
      );
    }
    const adaptiveCard = buildApprovalAdaptiveCard(card);
    return this.sendCard(target, adaptiveCard);
  }

  /**
   * Send a raw Adaptive Card. Exposed so a caller rendering a custom card
   * does not need a new adapter method. The adapter checks the card has the
   * `type: "AdaptiveCard"` envelope so a caller cannot accidentally post a
   * bare element that Teams will reject.
   */
  async postAdaptiveCard(
    target: TeamsTarget | null,
    card: Readonly<Record<string, unknown>>,
  ): Promise<TeamsDelivery> {
    if (card === null || typeof card !== "object") {
      throw new TeamsIntegrationError("`card` must be an object.", "invalid-input");
    }
    if (card["type"] !== "AdaptiveCard") {
      throw new TeamsIntegrationError(
        "`card.type` must be \"AdaptiveCard\"; Teams rejects a bare element as the message body.",
        "invalid-input",
        { receivedType: card["type"] },
      );
    }
    return this.sendCard(target, card);
  }

  // -- Internals -------------------------------------------------------

  private async sendCard(
    target: TeamsTarget | null,
    card: Readonly<Record<string, unknown>>,
  ): Promise<TeamsDelivery> {
    if (this.auth.kind === "connector") {
      if (target !== null) {
        // A connector webhook is bound to a channel; silently ignoring the
        // target would let the caller believe it chose one. Refuse so the
        // caller routes to the correct connector (or moves to the bot
        // surface to pick a conversation at send time).
        throw new TeamsIntegrationError(
          "A connector-authenticated Teams adapter cannot target a specific conversation; the connector is bound to one. Construct a bot-framework adapter to choose a conversation.",
          "invalid-input",
          { target },
        );
      }
      return this.postConnector(card);
    }
    return this.postGraph(target, card);
  }

  private async postConnector(card: Readonly<Record<string, unknown>>): Promise<TeamsDelivery> {
    if (this.auth.kind !== "connector") {
      throw new TeamsIntegrationError("Internal: postConnector reached in a non-connector adapter.", "invalid-input");
    }
    // Teams connector expects a `{type, attachments: [{contentType, content}]}`
    // envelope around an Adaptive Card.
    const envelope = {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: card,
        },
      ],
    };
    const body = JSON.stringify(envelope);
    const response = await this.transport({
      url: this.auth.webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Zipy-AI-Teams/1",
      },
      body,
      signal: abortAfter(this.timeoutMs),
    });
    if (response.status === 429) {
      throw new TeamsIntegrationError(
        "The Teams connector rate-limited the request.",
        "rate-limited",
        { httpStatus: 429 },
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TeamsIntegrationError(
        `Teams connector returned HTTP ${response.status}: ${truncate(response.body, 300)}`,
        "teams-rejected",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
      );
    }
    return {
      ok: true,
      messageId: null,
      payloadJson: body,
      httpStatus: response.status,
    };
  }

  private async postGraph(
    target: TeamsTarget | null,
    card: Readonly<Record<string, unknown>>,
  ): Promise<TeamsDelivery> {
    if (this.auth.kind !== "bot-framework") {
      throw new TeamsIntegrationError("Internal: postGraph reached in a non-bot adapter.", "invalid-input");
    }
    const conversationId = nonEmpty(target?.conversationId) ?? nonEmpty(this.auth.conversationId);
    if (conversationId === null) {
      throw new TeamsIntegrationError(
        "A `conversationId` is required for a bot-framework Teams send. Pass one via `target.conversationId` or set TEAMS_DEFAULT_CONVERSATION_ID.",
        "not-configured",
        { requiredEnv: "TEAMS_DEFAULT_CONVERSATION_ID" },
      );
    }
    const token = await this.resolveToken(target?.bearerToken ?? null);

    // The adaptive card envelope Teams' bot API expects when posting into a
    // conversation: a `message` activity with an `adaptiveCard` attachment.
    const activity = {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: card,
        },
      ],
    };
    const body = JSON.stringify(activity);
    const url = `${this.graphBaseUrl}/teams/${encodeURIComponent(conversationId)}/messages`;
    const response = await this.transport({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Zipy-AI-Teams/1",
      },
      body,
      signal: abortAfter(this.timeoutMs),
    });
    if (response.status === 429) {
      throw new TeamsIntegrationError(
        "Microsoft Graph rate-limited the request.",
        "rate-limited",
        { httpStatus: 429 },
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new TeamsIntegrationError(
        `Microsoft Graph rejected the bearer token (HTTP ${response.status}). Verify the bot app's tenant consent and that the acquireToken function returns a fresh token.`,
        "not-configured",
        { httpStatus: response.status, body: truncate(response.body, 500) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TeamsIntegrationError(
        `Microsoft Graph returned HTTP ${response.status}: ${truncate(response.body, 300)}`,
        "teams-rejected",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
      );
    }
    let parsed: unknown = null;
    try {
      parsed = response.body ? JSON.parse(response.body) : null;
    } catch {
      // A 202 Accepted (used by some Graph sends) has no body; a parse
      // failure is only a problem when the body was non-empty.
      parsed = null;
    }
    const messageId =
      parsed !== null && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)["id"] === "string"
        ? ((parsed as Record<string, unknown>)["id"] as string)
        : null;
    return {
      ok: true,
      messageId,
      payloadJson: body,
      httpStatus: response.status,
    };
  }

  private async resolveToken(explicit: string | null): Promise<string> {
    if (explicit !== null && explicit.length > 0) return explicit;
    if (this.acquireToken !== null) {
      const token = await this.acquireToken();
      if (typeof token !== "string" || token.length === 0) {
        throw new TeamsIntegrationError(
          "The supplied acquireToken function returned an empty token.",
          "not-configured",
        );
      }
      return token;
    }
    throw new TeamsIntegrationError(
      "No Teams bearer token is available. Supply `acquireToken` when constructing the adapter, or pass a fresh `target.bearerToken` on each send. The adapter does not perform OAuth itself.",
      "not-configured",
      { requiredEnv: ["TEAMS_BOT_APP_ID", "TEAMS_BOT_APP_SECRET"] },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface TeamsTarget {
  /** The bot-framework conversation id; ignored by a connector adapter. */
  readonly conversationId?: string | null;
  /** A pre-acquired bearer token; ignored by a connector adapter. */
  readonly bearerToken?: string | null;
}

export interface CreateTeamsAdapterInput {
  readonly auth: TeamsAuth;
  readonly transport: TeamsTransport;
  readonly timeoutMs?: number;
  readonly acquireToken?: AcquireGraphToken | null;
}

export function createTeamsAdapter(input: CreateTeamsAdapterInput): TeamsAdapter {
  if (input === null || typeof input !== "object") {
    throw new TeamsIntegrationError("`input` is required.", "invalid-input");
  }
  if (input.auth === null || typeof input.auth !== "object") {
    throw new TeamsIntegrationError(
      "Teams auth is required. Supply either a connector URL or a bot registration.",
      "not-configured",
      { requiredEnv: ["TEAMS_CONNECTOR_URL", "TEAMS_BOT_APP_ID"] },
    );
  }
  if (input.auth.kind === "connector") {
    if (typeof input.auth.webhookUrl !== "string" || input.auth.webhookUrl.trim().length === 0) {
      throw new TeamsIntegrationError(
        "Teams connector URL is empty.",
        "not-configured",
        { requiredEnv: "TEAMS_CONNECTOR_URL" },
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(input.auth.webhookUrl);
    } catch {
      throw new TeamsIntegrationError(
        "Teams connector URL is not a valid URL.",
        "invalid-input",
        { url: input.auth.webhookUrl },
      );
    }
    if (parsed.protocol !== "https:") {
      throw new TeamsIntegrationError(
        "Teams connector URL must use https://.",
        "invalid-input",
        { url: input.auth.webhookUrl },
      );
    }
  } else if (input.auth.kind === "bot-framework") {
    if (typeof input.auth.appId !== "string" || input.auth.appId.trim().length === 0) {
      throw new TeamsIntegrationError(
        "Teams bot app id is empty; supply the Microsoft App ID of the registered bot.",
        "not-configured",
        { requiredEnv: "TEAMS_BOT_APP_ID" },
      );
    }
  } else {
    throw new TeamsIntegrationError(
      `Unknown Teams auth kind: ${String((input.auth as { kind?: unknown }).kind)}. Expected "connector" or "bot-framework".`,
      "invalid-input",
    );
  }
  if (typeof input.transport !== "function") {
    throw new TeamsIntegrationError(
      "A `transport` function is required (pass globalThis.fetch in production).",
      "invalid-input",
    );
  }
  return new TeamsAdapter(input);
}

/**
 * Convenience factory: pick the auth surface from environment variables.
 * A connector URL wins when both are present (it is the least-privilege
 * surface and needs no tenant consent); a bot registration is used only
 * when no connector URL is set but an app id is. When neither is present,
 * throws `not-configured` listing the variables the operator must supply.
 */
export function createTeamsAdapterFromEnv(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly transport: TeamsTransport;
  readonly timeoutMs?: number;
  readonly acquireToken?: AcquireGraphToken | null;
}): TeamsAdapter {
  const env = readTeamsEnv(input.env);
  if (env.connectorUrl !== null) {
    return createTeamsAdapter({
      auth: { kind: "connector", webhookUrl: env.connectorUrl },
      transport: input.transport,
      timeoutMs: input.timeoutMs,
    });
  }
  if (env.botAppId !== null) {
    return createTeamsAdapter({
      auth: {
        kind: "bot-framework",
        appId: env.botAppId,
        conversationId: env.defaultConversationId,
      },
      transport: input.transport,
      timeoutMs: input.timeoutMs,
      acquireToken: input.acquireToken ?? null,
    });
  }
  throw new TeamsIntegrationError(
    "Microsoft Teams is not configured. Set TEAMS_CONNECTOR_URL (one-way notifications) or TEAMS_BOT_APP_ID + TEAMS_BOT_APP_SECRET (interactive approvals).",
    "not-configured",
    { requiredEnv: ["TEAMS_CONNECTOR_URL", "TEAMS_BOT_APP_ID", "TEAMS_BOT_APP_SECRET"] },
  );
}

/* -------------------------------------------------------------------------- */
/* Incoming-request guidance                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Returns the verification steps the platform's Teams callback route must
 * perform before trusting an inbound payload. The adapter does not perform
 * these steps (they belong in the route, where the raw request and the
 * caller's trusted tenant list are available); it documents them so a
 * route author cannot forget one. The route should *throw* on any failure
 * rather than log and continue.
 */
export function describeTeamsVerificationRequirement(): readonly string[] {
  return [
    "Verify the inbound `Authorization: Bearer <jwt>` is a Microsoft-issued token whose signature validates against Microsoft's OpenID Connect metadata (https://login.botframework.com/v1/.well-known/openidconfiguration).",
    "Confirm the token's `iss` claim equals `https://api.botframework.com` (or the sovereign-cloud equivalent).",
    "Confirm the token's `aud` claim equals the platform's TEAMS_BOT_APP_ID.",
    "Reject requests whose `iat` is more than five minutes old, to bound replay.",
    "Bind the inbound `conversation.id` and `serviceUrl` to a record the customer's tenant previously registered; refuse a callback for an unregistered conversation.",
    "Never trust the payload body's own claims of workflowId/gateId without checking the workspace binding for the resolved conversation.",
    "Store the raw inbound body hash alongside the audit entry so a reviewer's action can be replayed against the exact bytes Microsoft delivered.",
  ];
}

/* -------------------------------------------------------------------------- */
/* Adaptive Card builders                                                      */
/* -------------------------------------------------------------------------- */

function buildNotificationCard(
  message: TeamsNotification,
): Readonly<Record<string, unknown>> {
  const body: Readonly<Record<string, unknown>>[] = [
    { type: "TextBlock", text: message.text, wrap: true },
  ];
  const contextParts: string[] = [];
  if (nonEmpty(message.contextLine)) contextParts.push(message.contextLine);
  if (nonEmpty(message.linkUrl)) contextParts.push(`[Open in Zipy AI](${message.linkUrl})`);
  if (contextParts.length > 0) {
    body.push({
      type: "TextBlock",
      text: contextParts.join("  ·  "),
      wrap: true,
      isSubtle: true,
      spacing: "small",
    });
  }
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
  };
}

function buildApprovalAdaptiveCard(
  card: TeamsApprovalCard,
): Readonly<Record<string, unknown>> {
  const actionLines = card.actions.length > 0
    ? card.actions.map((a) => `- ${a}`).join("\n\n")
    : "- (no individual actions recorded)";
  const requestedBy = nonEmpty(card.requestedBy);
  const actionPayload = {
    zipy_action: "gate_decision",
    workflowId: card.workflowId,
    gateId: card.gateId,
  };
  const body: Readonly<Record<string, unknown>>[] = [
    {
      type: "TextBlock",
      size: "Medium",
      weight: "Bolder",
      text: `Approval requested · risk ${card.risk}`,
      wrap: true,
    },
    {
      type: "TextBlock",
      text: card.summary,
      wrap: true,
    },
    {
      type: "TextBlock",
      text: actionLines,
      wrap: true,
      spacing: "small",
    },
  ];
  if (requestedBy !== null) {
    body.push({
      type: "TextBlock",
      text: `Requested by ${requestedBy}`,
      wrap: true,
      isSubtle: true,
      spacing: "small",
    });
  }
  if (nonEmpty(card.reviewUrl)) {
    body.push({
      type: "TextBlock",
      text: `[Open the full review UI](${card.reviewUrl})`,
      wrap: true,
      spacing: "small",
    });
  }

  const actions: Readonly<Record<string, unknown>>[] = [
    {
      type: "Action.Submit",
      title: "Approve",
      style: "positive",
      data: { ...actionPayload, decision: "approve" },
    },
    {
      type: "Action.Submit",
      title: "Reject",
      style: "destructive",
      data: { ...actionPayload, decision: "reject" },
    },
  ];

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    actions,
  };
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function parseRetryAfterMs(headers: Readonly<Record<string, string>> | undefined): number | null {
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

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  buildNotificationCard,
  buildApprovalAdaptiveCard,
  abortAfter,
  parseRetryAfterMs,
  truncate,
});
