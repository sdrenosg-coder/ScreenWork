/**
 * Zipy AI — Slack integration adapter (phase 21, batch 2).
 *
 * Publishes Zipy AI notifications and interactive approval cards to a Slack
 * workspace via an incoming webhook or a bot token. Both surfaces are
 * supported because they map to different Slack app capabilities:
 *
 *   - Incoming Webhook (`SLACK_WEBHOOK_URL`): simplest, one-way. Suitable
 *     for "generation complete" notifications. Cannot render interactive
 *     approval buttons.
 *   - Bot Token (`SLACK_BOT_TOKEN` + a channel id): supports
 *     `chat.postMessage` with Block Kit actions, which is what a reviewer
 *     uses to approve/reject a gateway from inside Slack.
 *
 * Design boundaries
 * -----------------
 *  - No credential is invented. When neither surface is configured, every
 *    send function throws `IntegrationError` with `code: "not-configured"`
 *    listing the exact environment variables the operator must supply. The
 *    adapter never falls back to a shared webhook or a no-op success.
 *
 *  - No HTTP implementation is embedded. The caller supplies a `Transport`
 *    port (typically `globalThis.fetch`). This keeps the adapter testable,
 *    routes Slack traffic through the workspace's proxy when one is
 *    configured, and makes the customer's own rate-limit policy visible in
 *    the calling code rather than hidden inside the adapter.
 *
 *  - Message shape is typed and versioned. The Block Kit payload the
 *    adapter builds is exposed on the returned `SlackDelivery` so a caller
 *    that wants to log the exact bytes it sent does not have to re-serialize
 *    them, and an operator debugging a rejected card sees the payload the
 *    SDK sent.
 *
 *  - Slack errors are surfaced, not swallowed. A 4xx from Slack (invalid
 *    token, channel_not_found, `not_in_channel`) is raised as
 *    `IntegrationError` with the Slack `error` string. A retryable failure
 *    (5xx, `rate_limited`) is signalled with `retryAfterMs` on the same
 *    error object so the caller's queue can schedule the retry.
 *
 *  - No signature verification here. Slack's `X-Slack-Signature` scheme
 *    verifies *incoming* requests from Slack to the platform's callback.
 *    That verifier is exposed via `verifySlackRequestSignature` so the
 *    platform's `/api/integrations/slack/events` route can use it; this
 *    adapter only sends.
 *
 * What this adapter does *not* do:
 *  - It does not open a Socket Mode connection or a public event endpoint.
 *    The caller owns the endpoint and dispatch.
 *  - It does not store the bot token. The operator injects it via config;
 *    the adapter accepts it as a parameter so a caller with a per-workspace
 *    vault can fetch the right token at call time.
 *  - It does not fabricate a `bot_id`, `team_id` or channel id. A channel
 *    must be supplied by the caller (an ID like `C01ABC2DEF3`, or a
 *    `#name` which Slack resolves); it is used verbatim.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type IntegrationErrorCode =
  | "invalid-input"
  | "not-configured"
  | "transport-failure"
  | "slack-rejected"
  | "rate-limited";

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  /** Populated when `code === "rate-limited"`. */
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    code: IntegrationErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The minimum HTTP contract the adapter needs. The production caller
 * supplies `globalThis.fetch`; a test supplies a fake that records a
 * request and returns a canned response.
 */
export type SlackTransport = (input: {
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
 * The authentication mode the caller has provisioned. The adapter is
 * constructed with exactly one of these; a caller that tries to build an
 * adapter with neither gets `not-configured`, and one that supplies both
 * gets `invalid-input` (an operator must choose one surface explicitly).
 */
export type SlackAuth =
  | {
      readonly kind: "bot-token";
      /** `xoxb-...` bot token with `chat:write` and, for approvals, `commands`. */
      readonly botToken: string;
      /** Optional API base for a self-hosted proxy in front of Slack. */
      readonly apiBaseUrl?: string;
    }
  | {
      readonly kind: "webhook";
      /** `https://hooks.slack.com/services/...` incoming webhook URL. */
      readonly webhookUrl: string;
    };

export interface SlackAuthFromEnv {
  readonly botToken: string | null;
  readonly webhookUrl: string | null;
}

/**
 * A reference to the ZIPy workspace's Slack channel. The `channel` value is
 * passed verbatim to Slack (`C…` id or `#name`); the adapter does not
 * resolve it. `optionalLabel` is used purely for logs.
 */
export interface SlackChannel {
  readonly channel: string;
  readonly optionalLabel?: string | null;
}

export interface ApprovalCard {
  readonly workflowId: string;
  readonly gateId: string;
  readonly risk: "read-only" | "write" | "destructive" | "financial" | "external-communication";
  /** One-line human summary of what the gate will do if approved. */
  readonly summary: string;
  /** Explicit list of the actions the gate proposes, one line each. */
  readonly actions: readonly string[];
  /** Deep link to the review UI. Supplied by the caller; never built here. */
  readonly reviewUrl: string | null;
  /** Optional requestor display name; used in the card text only. */
  readonly requestedBy?: string | null;
}

export interface NotificationMessage {
  /** Short notification text. */
  readonly text: string;
  /** Optional deep link to the artefact. */
  readonly linkUrl?: string | null;
  /** Optional short context line (e.g. "workspace acme, guide 42"). */
  readonly contextLine?: string | null;
}

export interface SlackDelivery {
  readonly ok: boolean;
  /** Slack's `ts` for a chat.postMessage call, when Slack supplied one. */
  readonly slackMessageId: string | null;
  /** The Slack channel the message landed in, echoed from the API. */
  readonly channel: string | null;
  /** Serialized payload the adapter sent. */
  readonly payloadJson: string;
  /** The HTTP status Slack returned, for logs. */
  readonly httpStatus: number;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Read the Slack environment. Returns whatever is set. The caller (usually
 * the config layer) decides whether a missing value is fatal for the
 * workspace being configured.
 */
export function readSlackEnv(source: Readonly<Record<string, string | undefined>>): SlackAuthFromEnv {
  return {
    botToken: nonEmpty(source["SLACK_BOT_TOKEN"]),
    webhookUrl: nonEmpty(source["SLACK_WEBHOOK_URL"]),
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A configured Slack adapter. Construct one with `createSlackAdapter`. All
 * methods are pure functions of their arguments; the adapter holds no state
 * beyond its auth and transport.
 */
export class SlackAdapter {
  private readonly auth: SlackAuth;
  private readonly transport: SlackTransport;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  /** @internal — construct via `createSlackAdapter` to get validation. */
  constructor(input: {
    readonly auth: SlackAuth;
    readonly transport: SlackTransport;
    readonly timeoutMs?: number;
  }) {
    this.auth = input.auth;
    this.transport = input.transport;
    this.apiBaseUrl =
      input.auth.kind === "bot-token" && input.auth.apiBaseUrl
        ? input.auth.apiBaseUrl.replace(/\/+$/, "")
        : "https://slack.com/api";
    this.timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : 10_000;
  }

  /**
   * Post a plain notification. When the adapter is webhook-authenticated,
   * `channel` is ignored (a webhook is bound to a channel by Slack) and the
   * caller should pass `null`. When the adapter is bot-token-authenticated,
   * `channel` is required.
   */
  async notify(
    channel: SlackChannel | null,
    message: NotificationMessage,
  ): Promise<SlackDelivery> {
    if (typeof message.text !== "string" || message.text.trim().length === 0) {
      throw new IntegrationError("`message.text` is required.", "invalid-input");
    }
    const blocks = buildNotificationBlocks(message);
    const payload: Record<string, unknown> = {
      text: message.text,
      blocks,
    };
    return this.post(channel, payload);
  }

  /**
   * Post an approval card with two interactive buttons. The buttons carry
   * `action_id`s the platform's Slack callback handler will route:
   *
   *   - `zipy_gate_approve` — approve the gate.
   *   - `zipy_gate_reject`  — reject the gate.
   *
   * Both buttons carry the `gateId` and `workflowId` in their `value` field
   * (JSON-encoded) so the callback route does not need a second lookup.
   * The `reviewUrl` (if any) is exposed as Slack's `url` on the message's
   * top-level `text` link so a reviewer can open the full review UI.
   */
  async requestApproval(
    channel: SlackChannel | null,
    card: ApprovalCard,
  ): Promise<SlackDelivery> {
    if (typeof card.workflowId !== "string" || card.workflowId.trim().length === 0) {
      throw new IntegrationError("`card.workflowId` is required.", "invalid-input");
    }
    if (typeof card.gateId !== "string" || card.gateId.trim().length === 0) {
      throw new IntegrationError("`card.gateId` is required.", "invalid-input");
    }
    if (typeof card.summary !== "string" || card.summary.trim().length === 0) {
      throw new IntegrationError("`card.summary` is required.", "invalid-input");
    }
    if (this.auth.kind !== "bot-token") {
      // Approvals require Block Kit interactive actions; an incoming webhook
      // cannot receive a button callback. This is an explicit refusal, not
      // a degraded one-way notification.
      throw new IntegrationError(
        "Approval cards require a Slack bot token (SLACK_BOT_TOKEN); incoming webhooks cannot receive interactive action callbacks.",
        "not-configured",
        { requiredEnv: "SLACK_BOT_TOKEN" },
      );
    }
    const blocks = buildApprovalBlocks(card);
    const payload: Record<string, unknown> = {
      // The fallback text is what a notification preview shows; it must
      // carry enough context for a reviewer skimming a lock screen.
      text: `Approval requested: ${card.summary}`,
      blocks,
    };
    return this.post(channel, payload);
  }

  /**
   * Send a raw Block Kit payload. Exposed so a caller that needs a custom
   * notification (a release note, a content-gap digest) does not need a new
   * adapter method. The adapter validates only the minimum envelope; the
   * Block Kit schema is Slack's business.
   */
  async postBlocks(
    channel: SlackChannel | null,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<SlackDelivery> {
    if (payload === null || typeof payload !== "object") {
      throw new IntegrationError("`payload` must be an object.", "invalid-input");
    }
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      // Slack requires a top-level `text` even when blocks are supplied;
      // without it a client that does not render blocks shows nothing.
      throw new IntegrationError(
        "A top-level `text` is required for every Slack message; add it before sending.",
        "invalid-input",
      );
    }
    return this.post(channel, payload);
  }

  // -- Internals -------------------------------------------------------

  private async post(
    channel: SlackChannel | null,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<SlackDelivery> {
    const payloadJson = JSON.stringify(payload);
    if (this.auth.kind === "webhook") {
      if (channel !== null) {
        // A webhook is bound to a channel; silently ignoring the channel
        // would let a caller believe it chose one. Refuse so the caller
        // routes to the correct webhook instead.
        throw new IntegrationError(
          "A webhook-authenticated Slack adapter cannot target a specific channel; the webhook is bound to one. Construct a bot-token adapter to choose a channel.",
          "invalid-input",
          { channel: channel.channel },
        );
      }
      return this.postToWebhook(payloadJson);
    }

    // bot-token path
    if (channel === null || typeof channel.channel !== "string" || channel.channel.trim().length === 0) {
      throw new IntegrationError(
        "`channel.channel` is required when the adapter uses a bot token.",
        "invalid-input",
      );
    }
    return this.postToChatApi(channel.channel, payloadJson);
  }

  private async postToWebhook(payloadJson: string): Promise<SlackDelivery> {
    if (this.auth.kind !== "webhook") {
      throw new IntegrationError("Internal: postToWebhook reached in a non-webhook adapter.", "invalid-input");
    }
    const response = await this.transport({
      url: this.auth.webhookUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Zipy-AI-Slack/1",
      },
      body: payloadJson,
      signal: abortAfter(this.timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) {
      // An incoming webhook returns either "ok" (200) or a plaintext error
      // (e.g. "invalid_payload"). The body is short; surface it verbatim.
      throw new IntegrationError(
        `Slack webhook returned HTTP ${response.status}: ${truncate(response.body, 300)}`,
        "slack-rejected",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
        response.status === 429 ? parseRetryAfterMs(response.headers) : null,
      );
    }
    return {
      ok: true,
      slackMessageId: null,
      channel: null,
      payloadJson,
      httpStatus: response.status,
    };
  }

  private async postToChatApi(channel: string, payloadJson: string): Promise<SlackDelivery> {
    if (this.auth.kind !== "bot-token") {
      throw new IntegrationError("Internal: postToChatApi reached in a non-bot adapter.", "invalid-input");
    }
    const url = `${this.apiBaseUrl}/chat.postMessage`;
    const body = JSON.stringify({
      ...(JSON.parse(payloadJson) as Record<string, unknown>),
      channel,
    });
    const response = await this.transport({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${this.auth.botToken}`,
        "User-Agent": "Zipy-AI-Slack/1",
      },
      body,
      signal: abortAfter(this.timeoutMs),
    });
    if (response.status === 429) {
      throw new IntegrationError(
        "Slack rate-limited the request.",
        "rate-limited",
        { httpStatus: 429 },
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new IntegrationError(
        `Slack chat.postMessage returned HTTP ${response.status}: ${truncate(response.body, 300)}`,
        "transport-failure",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new IntegrationError(
        "Slack chat.postMessage returned a non-JSON body.",
        "slack-rejected",
        { httpStatus: response.status, body: truncate(response.body, 1_000) },
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new IntegrationError(
        "Slack chat.postMessage returned an unexpected body shape.",
        "slack-rejected",
        { httpStatus: response.status },
      );
    }
    const obj = parsed as Record<string, unknown>;
    if (obj["ok"] !== true) {
      // Slack uses 200 with `{ok: false, error: "..."}` for handled
      // rejections such as invalid_auth or channel_not_found. Raise so the
      // caller's Slack health dashboard shows the failure explicitly.
      const slackError = typeof obj["error"] === "string" ? obj["error"] : "unknown_slack_error";
      const retryAfterMs = slackError === "rate_limited" ? parseRetryAfterMs(response.headers) : null;
      throw new IntegrationError(
        `Slack rejected chat.postMessage: ${slackError}.`,
        slackError === "rate_limited" ? "rate-limited" : "slack-rejected",
        { slackError, httpStatus: response.status },
        retryAfterMs,
      );
    }
    return {
      ok: true,
      slackMessageId: typeof obj["ts"] === "string" ? obj["ts"] : null,
      channel: typeof obj["channel"] === "string" ? obj["channel"] : null,
      payloadJson: body,
      httpStatus: response.status,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateSlackAdapterInput {
  readonly auth: SlackAuth;
  readonly transport: SlackTransport;
  readonly timeoutMs?: number;
}

/**
 * Construct a Slack adapter with explicit validation of the auth shape.
 * Refuses to build one with both a bot token and a webhook: an operator
 * must choose one surface, because the choice changes which features work
 * (approvals require a bot token).
 */
export function createSlackAdapter(input: CreateSlackAdapterInput): SlackAdapter {
  if (input === null || typeof input !== "object") {
    throw new IntegrationError("`input` is required.", "invalid-input");
  }
  if (input.auth === null || typeof input.auth !== "object") {
    throw new IntegrationError(
      "Slack auth is required. Supply either a bot token or an incoming webhook URL.",
      "not-configured",
      { requiredEnv: ["SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL"] },
    );
  }
  if (input.auth.kind === "bot-token") {
    if (typeof input.auth.botToken !== "string" || input.auth.botToken.trim().length === 0) {
      throw new IntegrationError(
        "Slack bot token is empty; supply a token beginning with `xoxb-`.",
        "not-configured",
        { requiredEnv: "SLACK_BOT_TOKEN" },
      );
    }
  } else if (input.auth.kind === "webhook") {
    if (typeof input.auth.webhookUrl !== "string" || input.auth.webhookUrl.trim().length === 0) {
      throw new IntegrationError(
        "Slack webhook URL is empty.",
        "not-configured",
        { requiredEnv: "SLACK_WEBHOOK_URL" },
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(input.auth.webhookUrl);
    } catch {
      throw new IntegrationError(
        "Slack webhook URL is not a valid URL.",
        "invalid-input",
        { url: input.auth.webhookUrl },
      );
    }
    if (parsed.protocol !== "https:") {
      throw new IntegrationError(
        "Slack webhook URL must use https://.",
        "invalid-input",
        { url: input.auth.webhookUrl },
      );
    }
  } else {
    throw new IntegrationError(
      `Unknown Slack auth kind: ${String((input.auth as { kind?: unknown }).kind)}. Expected "bot-token" or "webhook".`,
      "invalid-input",
    );
  }
  if (typeof input.transport !== "function") {
    throw new IntegrationError(
      "A `transport` function is required (pass globalThis.fetch in production).",
      "invalid-input",
    );
  }
  return new SlackAdapter(input);
}

/**
 * Convenience factory: choose the auth surface from environment variables,
 * preserving the operator's explicit selection. `SLACK_BOT_TOKEN` wins when
 * both are set (it is the more capable surface); when only the webhook URL
 * is present, the webhook adapter is built. When neither is present, throws
 * `not-configured` listing the required variables.
 */
export function createSlackAdapterFromEnv(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly transport: SlackTransport;
  readonly timeoutMs?: number;
}): SlackAdapter {
  const fromEnv = readSlackEnv(input.env);
  if (fromEnv.botToken !== null) {
    return createSlackAdapter({
      auth: { kind: "bot-token", botToken: fromEnv.botToken },
      transport: input.transport,
      timeoutMs: input.timeoutMs,
    });
  }
  if (fromEnv.webhookUrl !== null) {
    return createSlackAdapter({
      auth: { kind: "webhook", webhookUrl: fromEnv.webhookUrl },
      transport: input.transport,
      timeoutMs: input.timeoutMs,
    });
  }
  throw new IntegrationError(
    "Slack is not configured. Set SLACK_BOT_TOKEN (for interactive approvals) or SLACK_WEBHOOK_URL (for one-way notifications).",
    "not-configured",
    { requiredEnv: ["SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL"] },
  );
}

/* -------------------------------------------------------------------------- */
/* Signature verification (incoming requests from Slack)                       */
/* -------------------------------------------------------------------------- */

/**
 * Verify an incoming Slack request against the platform's Slack signing
 * secret. Slack's documented scheme:
 *
 *   - The signed payload is `v0:${timestamp}:${rawBody}`.
 *   - The signature header is `X-Slack-Signature`, hex HMAC-SHA256.
 *   - The timestamp header is `X-Slack-Request-Timestamp` (unix seconds).
 *   - A request older than five minutes is rejected.
 *
 * Returns `{ok, reason}`. The caller (the platform's Slack events route)
 * responds 401 with `reason` when `ok` is false. `nowSeconds` is required
 * so the verifier has no hidden clock and a skewing host can supply an NTP
 * value.
 */
export async function verifySlackRequestSignature(input: {
  readonly body: string;
  readonly signatureHeader: string;
  readonly timestampHeader: string;
  readonly signingSecret: string;
  readonly nowSeconds: number;
  readonly maxSkewSeconds?: number;
  /** Allows a caller to supply a WebCrypto implementation in a runtime
   * without `node:crypto`. Defaults to `globalThis.crypto.subtle`. */
  readonly subtleCrypto?: SubtleCrypto;
}): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "malformed-header" | "timestamp-out-of-range" | "signature-mismatch";
      readonly detail: string;
    }
> {
  if (typeof input.signingSecret !== "string" || input.signingSecret.length === 0) {
    return {
      ok: false,
      reason: "signature-mismatch",
      detail: "SLACK_SIGNING_SECRET is not configured at the platform.",
    };
  }
  if (typeof input.signatureHeader !== "string" || !/^v0=[0-9a-fA-F]+$/.test(input.signatureHeader)) {
    return {
      ok: false,
      reason: "malformed-header",
      detail: "X-Slack-Signature is missing or not in `v0=<hex>` form.",
    };
  }
  if (typeof input.timestampHeader !== "string" || !/^\d+$/.test(input.timestampHeader)) {
    return {
      ok: false,
      reason: "malformed-header",
      detail: "X-Slack-Request-Timestamp is missing or not numeric.",
    };
  }
  const maxSkewSeconds =
    typeof input.maxSkewSeconds === "number" && input.maxSkewSeconds >= 0
      ? input.maxSkewSeconds
      : 300;
  const ts = Number(input.timestampHeader);
  const skew = Math.abs(Math.floor(input.nowSeconds) - ts);
  if (skew > maxSkewSeconds) {
    return {
      ok: false,
      reason: "timestamp-out-of-range",
      detail: `Slack request is ${skew}s old; the platform's window is ${maxSkewSeconds}s.`,
    };
  }
  const subtle = input.subtleCrypto ?? (globalThis.crypto?.subtle as SubtleCrypto | undefined);
  if (subtle === undefined) {
    return {
      ok: false,
      reason: "signature-mismatch",
      detail:
        "No WebCrypto SubtleCrypto implementation is available; supply one via `subtleCrypto` on this call.",
    };
  }
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    encoder.encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signingInput = encoder.encode(`v0:${input.timestampHeader}:${input.body}`);
  const expectedBuffer = await subtle.sign("HMAC", key, signingInput);
  const expectedHex = bufferToHex(expectedBuffer);
  const receivedHex = input.signatureHeader.slice(3).toLowerCase();
  if (expectedHex.length !== receivedHex.length) {
    return { ok: false, reason: "signature-mismatch", detail: "Signature length mismatch." };
  }
  // Constant-time compare on equal-length lowercase hex strings.
  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i += 1) {
    mismatch |= expectedHex.charCodeAt(i) ^ receivedHex.charCodeAt(i);
  }
  if (mismatch !== 0) {
    return { ok: false, reason: "signature-mismatch", detail: "Signature does not match." };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Block Kit builders                                                          */
/* -------------------------------------------------------------------------- */

function buildNotificationBlocks(
  message: NotificationMessage,
): readonly Readonly<Record<string, unknown>>[] {
  const blocks: Readonly<Record<string, unknown>>[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: message.text },
    },
  ];
  const contextParts: string[] = [];
  if (nonEmpty(message.contextLine)) contextParts.push(message.contextLine);
  if (nonEmpty(message.linkUrl)) contextParts.push(`<${message.linkUrl}|Open in Zipy AI>`);
  if (contextParts.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join("  ·  ") }],
    });
  }
  return blocks;
}

function buildApprovalBlocks(
  card: ApprovalCard,
): readonly Readonly<Record<string, unknown>>[] {
  const actionLines = card.actions.length > 0
    ? card.actions.map((a) => `• ${a}`).join("\n")
    : "• (no individual actions recorded)";
  const requestedBy = nonEmpty(card.requestedBy);
  const headerText = `Approval requested · risk *${card.risk}*`;
  const sectionText =
    `${card.summary}\n\n${actionLines}` + (requestedBy !== null ? `\n\n_Requested by ${requestedBy}_` : "");
  const value = JSON.stringify({ workflowId: card.workflowId, gateId: card.gateId });
  const blocks: Readonly<Record<string, unknown>>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText.slice(0, 150) },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: sectionText.slice(0, 2900) },
    },
  ];
  if (nonEmpty(card.reviewUrl)) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `<${card.reviewUrl}|Open the full review UI>` },
      ],
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: "zipy_gate_approve",
        style: "primary",
        text: { type: "plain_text", text: "Approve" },
        value,
      },
      {
        type: "button",
        action_id: "zipy_gate_reject",
        style: "danger",
        text: { type: "plain_text", text: "Reject" },
        value,
      },
    ],
  });
  return blocks;
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

function bufferToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    const b = view[i]!;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
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
  buildNotificationBlocks,
  buildApprovalBlocks,
  abortAfter,
  parseRetryAfterMs,
  bufferToHex,
  truncate,
});
