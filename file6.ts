/**
 * Zipy AI — Microsoft Teams adapter (phase 21, batch 2).
 *
 * Two surfaces are covered:
 *
 *   1. Outbound notifications — delivered to a Teams channel via an Incoming
 *      Webhook URL the customer supplies, or via a Workflow (Power Automate)
 *      webhook URL. Teams has deprecated the legacy Office 365 Connector
 *      format in favour of Adaptive Cards; this module produces Adaptive
 *      Cards (schema `1.4`) which render in both the modern client and the
 *      web app.
 *
 *   2. Inbound verification — Teams Incoming Webhooks do not support
 *      request signing the way Slack does. There is no standard HMAC scheme
 *      for an outbound notification, so this adapter does *not* verify
 *      inbound requests; it declares that and refuses to pretend. For
 *      inbound commands from Teams (a Bot Framework activity), the customer
 *      supplies a separate adapter (or a token-checked route) that verifies
 *      the Bot Framework JWT; the platform does not implement Bot Framework
 *      auth here.
 *
 * Design boundaries honoured here:
 *
 *   - No URL is invented. The workspace persists a webhook URL the customer
 *     supplied; the adapter refuses to send when it is missing and reports
 *     `configured: false`.
 *   - No live HTTP is issued unless the caller supplies a transport. The
 *     default transport wraps `globalThis.fetch`.
 *   - The Adaptive Card is deterministic from caller inputs. No title,
 *     summary, image or channel is fabricated.
 *   - Teams returns a 200 with a body of "1" on success (legacy connector
 *     style). The adapter treats 200 as success regardless of body, but
 *     returns the body verbatim in the result so the activity feed can
 *     record what Teams said.
 *
 * The module exports:
 *   - `TeamsConfig` — the settings a workspace persists for Teams.
 *   - `sendGuideNotification` — the outbound surface.
 *   - `buildAdaptiveCard` — the card payload, exported for tests.
 *   - `describeTeamsConfig` — what the workspace has configured.
 *   - `TeamsError` — typed error.
 *   - `TEAMS_ADAPTIVE_CARD_SCHEMA` — the schema version string.
 *   - `__internals` — pure helpers, exported for tests.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type TeamsErrorCode =
  | "invalid-input"
  | "not-configured"
  | "unsupported-inbound"
  | "transport-failure";

export class TeamsError extends Error {
  readonly code: TeamsErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: TeamsErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "TeamsError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The settings a workspace persists to enable Teams. Teams supports two
 * webhook flavours: the legacy Incoming Webhook (which prefixed the payload
 * with a `summary` field) and the Workflow/Power Automate webhook (which
 * accepts a bare Adaptive Card). Both accept the same Adaptive Card body
 * today, so this adapter sends the same payload to either.
 *
 * `webhookUrl` is required for outbound. The other fields are optional and
 * reflect the customer's intent.
 */
export interface TeamsConfig {
  /** Webhook URL the customer generated. Optional per the surface contract. */
  readonly webhookUrl: string | null;
  /**
   * Optional setting describing which webhook flavour the customer used.
   * Kept for the activity feed; the adapter sends the same card either way.
   */
  readonly webhookKind: "incoming-webhook" | "workflow" | null;
}

export interface TeamsNotificationContext {
  readonly workspaceId: string;
  /** The guide title, from the content pipeline. */
  readonly guideTitle: string;
  /** The guide's public URL, when one exists. Never invented. */
  readonly guideUrl: string | null;
  /** Optional one-sentence summary, from the content pipeline. */
  readonly summary: string | null;
  /** Optional link to the reviewer queue for review-requested notifications. */
  readonly reviewUrl?: string | null;
  /**
   * Which notification kind this is. Determines the card headline text.
   * New kinds are added here, not in a free-text field.
   */
  readonly kind: "generation-completed" | "review-requested" | "guide-published";
}

export interface AdaptiveCard {
  readonly type: "AdaptiveCard";
  readonly $schema: string;
  readonly version: string;
  readonly body: readonly AdaptiveCardElement[];
  readonly actions?: readonly AdaptiveCardAction[];
  /** Teams requires a plain-text fallback for notification previews. */
  readonly fallbackText: string;
}

export type AdaptiveCardElement =
  | { readonly type: "TextBlock"; readonly text: string; readonly weight?: "Bolder"; readonly size?: "Medium" | "Large"; readonly wrap?: boolean; readonly spacing?: "Medium" }
  | { readonly type: "FactSet"; readonly facts: readonly { readonly title: string; readonly value: string }[] };

export interface AdaptiveCardAction {
  readonly type: "Action.OpenUrl";
  readonly title: string;
  readonly url: string;
}

export interface TeamsSendResult {
  readonly ok: true;
  /** Raw response body from Teams, echoed for the activity feed. */
  readonly rawResponse: string;
  readonly status: number;
}

export interface TeamsSendErrorResult {
  readonly ok: false;
  /** HTTP status, or 0 on a transport failure. */
  readonly status: number;
  readonly reason: string;
  readonly rawResponse: string;
}

export type TeamsSendOutcome = TeamsSendResult | TeamsSendErrorResult;

/**
 * The HTTP transport port. Defaults to `globalThis.fetch`; a test supplies
 * a fake. The port is injected so this module has no hidden network
 * dependency.
 */
export type TeamsTransport = (input: {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}) => Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}>;

export interface SendGuideNotificationInput {
  readonly config: TeamsConfig;
  readonly context: TeamsNotificationContext;
  /** The HTTP transport. Defaults to a `fetch` wrapper; tests pass a fake. */
  readonly transport?: TeamsTransport;
  readonly timeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

export const TEAMS_ADAPTIVE_CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
export const TEAMS_ADAPTIVE_CARD_VERSION = "1.4";

/* -------------------------------------------------------------------------- */
/* Public API                                                                  #
/* -------------------------------------------------------------------------- */

export async function sendGuideNotification(
  input: SendGuideNotificationInput,
): Promise<TeamsSendOutcome> {
  if (input === null || typeof input !== "object") {
    throw new TeamsError("sendGuideNotification requires an inputs object.", "invalid-input");
  }
  const url = nonEmpty(input.config.webhookUrl);
  if (url === null) {
    throw new TeamsError(
      "Teams is not configured for this workspace. Supply a webhook URL (an Incoming Webhook or a Workflow/Power Automate webhook).",
      "not-configured",
      { webhookKind: input.config.webhookKind },
    );
  }
  // A webhook URL is a public endpoint with an embedded secret in the path.
  // Reject anything not HTTPS: a Teams webhook over HTTP would leak the
  // embedded credential to any network observer.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new TeamsError(
        `Teams webhook URLs must use https:// (received ${parsed.protocol}//).`,
        "invalid-input",
      );
    }
  } catch (err) {
    if (err instanceof TeamsError) throw err;
    throw new TeamsError(`Teams webhook URL is not a valid URL: ${url}`, "invalid-input");
  }

  if (typeof input.context.guideTitle !== "string" || input.context.guideTitle.trim().length === 0) {
    throw new TeamsError("`context.guideTitle` is required.", "invalid-input");
  }
  if (input.context.guideUrl !== null && input.context.guideUrl !== undefined) {
    try {
      new URL(input.context.guideUrl);
    } catch {
      throw new TeamsError(
        `\`context.guideUrl\` is not a valid URL: ${input.context.guideUrl}`,
        "invalid-input",
      );
    }
  }

  const card = buildAdaptiveCard(input.context);
  // The legacy Incoming Webhook wraps the card with a `summary` and `type`
  // field. Sending the wrapper is accepted by both flavours today, so this
  // adapter always sends it; a future Teams API change would add a branch
  // here keyed on `config.webhookKind`.
  const body = JSON.stringify({
    type: "message",
    summary: card.fallbackText,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: card,
      },
    ],
  });

  const transport = input.transport ?? defaultTeamsTransport;
  const timeoutMs = input.timeoutMs ?? 10_000;
  let response: { status: number; headers: Readonly<Record<string, string>>; body: string };
  try {
    response = await transport({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Zipy-AI-Teams/1",
      },
      body,
      timeoutMs,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: `Transport failure: ${err instanceof Error ? err.message : String(err)}`,
      rawResponse: "",
    };
  }
  if (response.status >= 200 && response.status < 300) {
    return { ok: true, status: response.status, rawResponse: response.body };
  }
  return {
    ok: false,
    status: response.status,
    reason: `Teams webhook returned ${response.status}.`,
    rawResponse: response.body,
  };
}

/**
 * Report whether Teams is configured at all. A caller uses this to decide
 * whether to surface the Teams destination in the publish UI.
 */
export function describeTeamsConfig(config: TeamsConfig): {
  readonly configured: boolean;
  readonly kind: "incoming-webhook" | "workflow" | null;
} {
  const url = nonEmpty(config.webhookUrl);
  return {
    configured: url !== null,
    kind: url !== null ? config.webhookKind : null,
  };
}

/**
 * Refuse to verify inbound Teams requests from this adapter. Teams Incoming
 * Webhooks do not carry a request signature; the correct verification
 * surface for Teams interactions is the Bot Framework JWT, which is
 * implemented by the customer's bot registration. This function exists so
 * a caller that mistakenly looks for verification here is told exactly what
 * to do instead.
 */
export function verifyTeamsRequest(): never {
  throw new TeamsError(
    "Teams Incoming Webhooks are not signed. For inbound Teams commands, verify the Bot Framework JWT on the customer's bot route — this adapter is outbound only.",
    "unsupported-inbound",
  );
}

/**
 * The Adaptive Card for a guide notification. Deterministic from the
 * context so a test can assert on the card without a network call. Slack
 * and Teams cards carry the same fields (headline, title, summary, action
 * links); the two renderers differ in shape only.
 */
export function buildAdaptiveCard(context: TeamsNotificationContext): AdaptiveCard {
  const headline = (() => {
    switch (context.kind) {
      case "generation-completed":
        return "Tutorial ready for review";
      case "review-requested":
        return "Review requested";
      case "guide-published":
        return "Guide published";
    }
  })();
  const body: AdaptiveCardElement[] = [
    {
      type: "TextBlock",
      text: headline,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
    {
      type: "TextBlock",
      text: context.guideTitle,
      size: "Large",
      weight: "Bolder",
      wrap: true,
    },
  ];
  const facts: { title: string; value: string }[] = [];
  if (nonEmpty(context.summary) !== null) {
    facts.push({ title: "Summary", value: (context.summary as string).trim() });
  }
  if (nonEmpty(context.guideUrl) !== null) {
    facts.push({ title: "Guide", value: context.guideUrl as string });
  }
  if (nonEmpty(context.reviewUrl) !== null) {
    facts.push({ title: "Review", value: context.reviewUrl as string });
  }
  if (facts.length > 0) {
    body.push({ type: "FactSet", facts });
  }

  const actions: AdaptiveCardAction[] = [];
  if (nonEmpty(context.guideUrl) !== null) {
    actions.push({
      type: "Action.OpenUrl",
      title: "Open the guide",
      url: context.guideUrl as string,
    });
  }
  if (nonEmpty(context.reviewUrl) !== null) {
    actions.push({
      type: "Action.OpenUrl",
      title: "Review in Zipy AI",
      url: context.reviewUrl as string,
    });
  }

  const card: AdaptiveCard = {
    type: "AdaptiveCard",
    $schema: TEAMS_ADAPTIVE_CARD_SCHEMA,
    version: TEAMS_ADAPTIVE_CARD_VERSION,
    body,
    fallbackText: fallbackTextFor(context),
    ...(actions.length > 0 ? { actions } : {}),
  };
  return card;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   #
/* -------------------------------------------------------------------------- */

const defaultTeamsTransport: TeamsTransport = async (input) => {
  const abort = new AbortController();
  const handle = setTimeout(() => abort.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: { ...input.headers },
      body: input.body,
      signal: abort.signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value: string, key: string) => {
      headers[key.toLowerCase()] = value;
    });
    const text = await response.text();
    return { status: response.status, headers, body: text };
  } finally {
    clearTimeout(handle);
  }
};

function fallbackTextFor(context: TeamsNotificationContext): string {
  switch (context.kind) {
    case "generation-completed":
      return `Tutorial ready for review: ${context.guideTitle}`;
    case "review-requested":
      return `Review requested: ${context.guideTitle}`;
    case "guide-published":
      return `Guide published: ${context.guideTitle}`;
  }
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         #
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  defaultTeamsTransport,
  fallbackTextFor,
  nonEmpty,
});
