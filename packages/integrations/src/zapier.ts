/**
 * Zipy AI — Zapier / Make (Integromat) integration adapter (phase 21, batch 4).
 *
 * Zapier and Make are no-code automation platforms. Their integration model
 * differs from a first-party OAuth app: a customer creates a "Zap" (Zapier)
 * or a "Scenario" (Make) inside the platform's UI and configures it to call
 * a webhook URL that Zipy AI exposes. The direction of traffic matters:
 *
 *   - Inbound: Zapier/Make POST to a Zipy AI hook URL to trigger an action
 *     (e.g. "when a Jira ticket closes, create a Zipy AI generation job").
 *     The platform receives these on a route; this adapter's job here is to
 *     describe the shape the route must accept, and to verify that the
 *     inbound request carries the shared secret the customer configured.
 *
 *   - Outbound: Zipy AI POSTs an event payload to a customer-configured
 *     Zapier/Make hook URL (e.g. "when a guide is published"). This is
 *     exactly the outbound webhook surface the `@zipy/webhooks` package
 *     already owns; the Zapier adapter reuses that signing contract rather
 *     than inventing a second one, so a receiver verifies Zipy AI events
 *     identically whether the destination is a bare HTTP endpoint or a
 *     Zapier "Catch Hook" step.
 *
 * Design boundaries
 * -----------------
 *  - No credential is invented. A Zapier "Catch Hook" URL is specific to
 *    one Zap and one user account; it cannot be a platform default. When
 *    the customer has not configured a hook URL, `notifyOutbound` throws
 *    `not-configured` listing the environment variable to supply.
 *
 *  - No HTTP implementation is embedded. The caller supplies a
 *    `Transport` (typically `globalThis.fetch`). Outbound signing is
 *    delegated to the caller's `signPayload` function — this adapter does
 *    not import `@zipy/webhooks` at runtime so it stays free of an
 *    unnecessary cross-package dependency, and the calling route already
 *    holds the signing secret in its own scope.
 *
 *  - No Zap or Scenario is fabricated. A caller cannot programmatically
 *    create a Zapier Zap via this adapter: Zapier's public API (the
 *    "Zapier Platform" REST surface) requires an app registration, an
 *    OAuth dance and per-Zap user consent, and the customer performs that
 *    at their end when they author the Zap. This adapter only processes
 *    inbound triggers and posts outbound events, which is what an
 *    integration that does not own a published Zapier app can actually do.
 *
 *  - Inbound verification is *documented* and, for the shared-secret case,
 *    implemented. Zapier's "Catch Hook" and Make's "Webhook" both support
 *    appending a query-string secret or a custom header the customer
 *    configures; `verifyZapierInboundSecret` implements the constant-time
 *    comparison for that secret. A caller that wants Zapier's own
 *    outbound IP allow-listing (Zapier publishes its source IP ranges) must
 *    perform that at the ingress layer, not here; the guidance function
 *    documents it.
 *
 *  - Errors are typed. A Zapier hook that returns a 4xx (a Zap was turned
 *    off, the URL rotated) is `destination-rejected`; a 5xx or transport
 *    failure is `transport-failure`; a 429 carries `retryAfterMs`.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ZapierErrorCode =
  | "invalid-input"
  | "not-configured"
  | "transport-failure"
  | "destination-rejected"
  | "rate-limited";

export class ZapierIntegrationError extends Error {
  readonly code: ZapierErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    code: ZapierErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ZapierIntegrationError";
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type ZapierTransport = (input: {
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
 * The event envelope Zipy AI outbound posts to a Zapier/Make hook. The
 * shape is deliberately close to the `@zipy/webhooks` delivery payload so
 * a receiver can verify either source with one code path. Only the fields
 * actually emitted by the platform are modelled here; a caller wanting a
 * field this adapter does not know about uses `extraData`.
 */
export interface ZapierOutboundEvent {
  /** A stable event name, e.g. `guide.published` or `review.requested`. */
  readonly event: string;
  /** The event's unique id, for the receiver to deduplicate on. */
  readonly id: string;
  /** ISO-8601 timestamp the event was produced. */
  readonly occurredAt: string;
  /** The workspace this event belongs to. */
  readonly workspaceId: string;
  /** The resource (guide, workflow, review) the event concerns. */
  readonly resource: {
    readonly kind: "guide" | "workflow" | "review";
    readonly id: string;
    readonly url: string | null;
  };
  /** The event's structured body. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ZapierDelivery {
  readonly ok: boolean;
  /** Any id the destination returned; Zapier hooks normally return `{"status":"success"}` with no id. */
  readonly destinationId: string | null;
  /** The exact JSON body the adapter sent. */
  readonly payloadJson: string;
  readonly httpStatus: number;
}

/**
 * A caller-supplied signing function. The outbound delivery must be signed
 * with the workspace's `WEBHOOK_SIGNING_SECRET`; the caller (the webhook
 * dispatch route) already holds that secret, and this adapter accepts a
 * function rather than importing a signing implementation so the contract
 * lives in one place (`@zipy/webhooks/signature`) and the two are not
 * allowed to drift.
 */
export type SignZapierPayload = (input: {
  readonly body: string;
  readonly timestampSeconds: number;
}) => string;

export interface ZapierVerificationResult {
  readonly ok: boolean;
  readonly reason:
    | "ok"
    | "missing-configured-secret"
    | "missing-received-secret"
    | "secret-mismatch";
  readonly detail: string;
}

/**
 * A single trigger description: what the platform registers with Zapier
 * (the "Trigger" a user picks from the Zap editor's list). This is metadata
 * for a published Zapier app; the customer's Zap associates this trigger
 * with the platform's inbound hook URL. The adapter does not publish a
 * Zapier app, so this is guidance the platform surfaces in its UI.
 */
export interface ZapierTriggerDescriptor {
  readonly key: string;
  readonly noun: string;
  readonly label: string;
  readonly helpText: string;
  /** The inbound path the Zapier trigger posts to. */
  readonly hookPath: string;
  /** The JSON keys the caller's inbound route will read. */
  readonly sampleKeys: readonly string[];
}

/**
 * The action descriptor: what the platform registers as an "Action" a Zap
 * step can invoke (e.g. "Generate a Zipy AI Tutorial"). Same boundary as
 * the trigger: metadata for the platform's UI, not a Zapier app publish.
 */
export interface ZapierActionDescriptor {
  readonly key: string;
  readonly noun: string;
  readonly label: string;
  readonly helpText: string;
  readonly requiredFields: readonly ZapierActionField[];
  readonly optionalFields: readonly ZapierActionField[];
}

export interface ZapierActionField {
  readonly key: string;
  readonly label: string;
  readonly type: "string" | "text" | "boolean" | "integer" | "datetime" | "file";
  readonly required: boolean;
  readonly helpText?: string;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface ZapierAuthFromEnv {
  /** The outbound hook URL a customer configured for one Zap/Scenario. */
  readonly outboundHookUrl: string | null;
  /**
   * The shared secret the customer set on the Zapier "Catch Hook" trigger.
   * This is the shared-secret query-string form Zapier supports natively.
   */
  readonly inboundSharedSecret: string | null;
}

export function readZapierEnv(
  source: Readonly<Record<string, string | undefined>>,
): ZapierAuthFromEnv {
  return {
    outboundHookUrl: nonEmpty(source["ZAPIER_OUTBOUND_HOOK_URL"]),
    inboundSharedSecret: nonEmpty(source["ZAPIER_INBOUND_SHARED_SECRET"]),
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class ZapierAdapter {
  private readonly outboundHookUrl: string | null;
  private readonly transport: ZapierTransport;
  private readonly signPayload: SignZapierPayload | null;
  private readonly timeoutMs: number;

  /** @internal — construct via `createZapierAdapter`. */
  constructor(input: {
    readonly outboundHookUrl: string | null;
    readonly transport: ZapierTransport;
    readonly signPayload?: SignZapierPayload | null;
    readonly timeoutMs?: number;
  }) {
    this.outboundHookUrl = input.outboundHookUrl;
    this.transport = input.transport;
    this.signPayload = input.signPayload ?? null;
    this.timeoutMs =
      typeof input.timeoutMs === "number" &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : 12_000;
  }

  /**
   * Whether the outbound hook has been configured. A caller uses this to
   * surface a "Zapier not connected" state in the UI without throwing.
   */
  get outboundConfigured(): boolean {
    return this.outboundHookUrl !== null;
  }

  /**
   * Post an event to the customer's Zapier/Make hook URL. The body is the
   * JSON envelope; when the caller supplied a `signPayload` function, the
   * adapter signs the body and attaches the signature + timestamp headers
   * the platform's own webhook receivers already understand, so a receiver
   * verifies either source with one implementation.
   */
  async notifyOutbound(event: ZapierOutboundEvent): Promise<ZapierDelivery> {
    if (event === null || typeof event !== "object") {
      throw new ZapierIntegrationError("`event` is required.", "invalid-input");
    }
    if (!nonEmpty(event.event)) {
      throw new ZapierIntegrationError("`event.event` is required.", "invalid-input");
    }
    if (!nonEmpty(event.id)) {
      throw new ZapierIntegrationError("`event.id` is required.", "invalid-input");
    }
    if (!nonEmpty(event.occurredAt)) {
      throw new ZapierIntegrationError("`event.occurredAt` is required.", "invalid-input");
    }
    if (!nonEmpty(event.workspaceId)) {
      throw new ZapierIntegrationError("`event.workspaceId` is required.", "invalid-input");
    }
    if (event.resource === null || typeof event.resource !== "object") {
      throw new ZapierIntegrationError("`event.resource` is required.", "invalid-input");
    }
    if (!nonEmpty(event.resource.id)) {
      throw new ZapierIntegrationError("`event.resource.id` is required.", "invalid-input");
    }
    if (
      event.resource.kind !== "guide" &&
      event.resource.kind !== "workflow" &&
      event.resource.kind !== "review"
    ) {
      throw new ZapierIntegrationError(
        "`event.resource.kind` must be one of \"guide\", \"workflow\", \"review\".",
        "invalid-input",
        { received: event.resource.kind },
      );
    }

    const url = this.outboundHookUrl;
    if (url === null) {
      throw new ZapierIntegrationError(
        "Zapier/Make outbound is not configured. The customer must add a \"Catch Hook\" (Zapier) or \"Webhook\" (Make) step and set ZAPIER_OUTBOUND_HOOK_URL to the URL that step generated.",
        "not-configured",
        { requiredEnv: "ZAPIER_OUTBOUND_HOOK_URL" },
      );
    }

    // Serialise once and sign the exact bytes that will be sent. A server
    // that re-serialises the body before sending would break verification
    // for receiving implementations that hash the raw bytes.
    const body = JSON.stringify({
      event: event.event,
      id: event.id,
      occurredAt: event.occurredAt,
      workspaceId: event.workspaceId,
      resource: {
        kind: event.resource.kind,
        id: event.resource.id,
        url: event.resource.url,
      },
      data: event.data,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "Zipy-AI-Zapier/1",
    };
    if (this.signPayload !== null) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      let signature: string;
      try {
        signature = this.signPayload({ body, timestampSeconds: nowSeconds });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ZapierIntegrationError(
          `The supplied signPayload function threw: ${message}`,
          "invalid-input",
          { cause: message },
        );
      }
      if (typeof signature !== "string" || signature.length === 0) {
        throw new ZapierIntegrationError(
          "The supplied signPayload function returned an empty signature.",
          "invalid-input",
        );
      }
      headers["X-Zipy-Signature"] = signature;
      headers["X-Zipy-Timestamp"] = String(nowSeconds);
    }

    let response: Awaited<ReturnType<ZapierTransport>>;
    try {
      response = await this.transport({
        url,
        method: "POST",
        headers,
        body,
        signal: abortAfter(this.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ZapierIntegrationError(
        `Zapier/Make transport error: ${message}`,
        "transport-failure",
        { url, method: "POST" },
      );
    }

    if (response.status === 429) {
      throw new ZapierIntegrationError(
        "Zapier/Make rate-limited the request.",
        "rate-limited",
        { httpStatus: 429 },
        parseRetryAfterMs(response.headers),
      );
    }
    if (response.status >= 400 && response.status < 500) {
      // A 4xx from a Zapier hook almost always means the Zap was turned
      // off, the URL rotated, or the account was disconnected. Surfacing
      // the body (Zapier returns JSON like {"status":"error","reason":"..."})
      // saves a customer debugging trip.
      throw new ZapierIntegrationError(
        `Zapier/Make hook returned HTTP ${response.status}: ${truncate(response.body, 300)}`,
        "destination-rejected",
        {
          httpStatus: response.status,
          body: truncate(response.body, 1_000),
        },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ZapierIntegrationError(
        `Zapier/Make hook returned HTTP ${response.status}: ${truncate(response.body, 300)}`,
        "transport-failure",
        {
          httpStatus: response.status,
          body: truncate(response.body, 1_000),
        },
      );
    }

    // Zapier's Response step returns `{"status": "success"}` (or similar);
    // not all configurations return an id. Parse best-effort but do not
    // fail when the body is unparseable — a 2xx is the authoritative
    // success signal here, and the body is only used to surface an id.
    let destinationId: string | null = null;
    try {
      const parsed = response.body ? JSON.parse(response.body) : null;
      if (parsed !== null && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const candidate =
          typeof obj["id"] === "string"
            ? (obj["id"] as string)
            : typeof obj["zap_run_id"] === "string"
              ? (obj["zap_run_id"] as string)
              : null;
        destinationId = candidate;
      }
    } catch {
      destinationId = null;
    }

    return {
      ok: true,
      destinationId,
      payloadJson: body,
      httpStatus: response.status,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateZapierAdapterInput {
  /**
   * The outbound hook URL. `null` is accepted: a workspace that only uses
   * Zipy AI's triggers (inbound) does not need an outbound hook, and the
   * adapter reports `outboundConfigured === false` rather than refusing to
   * be constructed.
   */
  readonly outboundHookUrl: string | null;
  readonly transport: ZapierTransport;
  readonly signPayload?: SignZapierPayload | null;
  readonly timeoutMs?: number;
}

export function createZapierAdapter(input: CreateZapierAdapterInput): ZapierAdapter {
  if (input === null || typeof input !== "object") {
    throw new ZapierIntegrationError("`input` is required.", "invalid-input");
  }
  if (typeof input.transport !== "function") {
    throw new ZapierIntegrationError(
      "A `transport` function is required (pass globalThis.fetch in production).",
      "invalid-input",
    );
  }
  const url = nonEmpty(input.outboundHookUrl);
  if (url !== null) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ZapierIntegrationError(
        "`outboundHookUrl` is not a valid URL.",
        "invalid-input",
        { url },
      );
    }
    if (parsed.protocol !== "https:") {
      // Zapier's Catch Hook is always https; Make's webhook is always
      // https. An http:// URL is a misconfiguration that would leak event
      // bodies, so refuse rather than silently sending.
      throw new ZapierIntegrationError(
        "`outboundHookUrl` must use https://; Zapier and Make both issue https hook URLs.",
        "invalid-input",
        { url, protocol: parsed.protocol },
      );
    }
  }
  if (input.signPayload !== undefined && input.signPayload !== null) {
    if (typeof input.signPayload !== "function") {
      throw new ZapierIntegrationError(
        "`signPayload` must be a function when supplied.",
        "invalid-input",
      );
    }
  }
  return new ZapierAdapter({
    outboundHookUrl: url,
    transport: input.transport,
    signPayload: input.signPayload ?? null,
    timeoutMs: input.timeoutMs,
  });
}

/**
 * Convenience factory: read the outbound hook URL from the environment.
 * When the URL is absent, the returned adapter still constructs — the
 * caller can inspect `outboundConfigured` and present a setup hint —
 * and any `notifyOutbound` call throws `not-configured`.
 */
export function createZapierAdapterFromEnv(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly transport: ZapierTransport;
  readonly signPayload?: SignZapierPayload | null;
  readonly timeoutMs?: number;
}): ZapierAdapter {
  const env = readZapierEnv(input.env);
  return createZapierAdapter({
    outboundHookUrl: env.outboundHookUrl,
    transport: input.transport,
    signPayload: input.signPayload ?? null,
    timeoutMs: input.timeoutMs,
  });
}

/* -------------------------------------------------------------------------- */
/* Inbound verification                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Verify the shared secret a customer's Zapier "Catch Hook" trigger (or
 * Make "Webhook") appended to the inbound URL. Zapier and Make both let a
 * customer add fixed query parameters to the hook URL, so a customer sets
 * `?zipy_secret=<random>` and the route compares that value in constant
 * time. The verification is symmetric with the Jira webhook verifier: it
 * never assumes the secret is present, and it never logs the received
 * value.
 *
 * A caller worried about replay should also store the inbound body's hash
 * per delivery id; this adapter does not implement that, because the
 * delivery id is inside the JSON body the route owns, and a nonce store
 * belongs in the route (or the platform's job queue) where it can be
 * scoped to the workspace.
 */
export function verifyZapierInboundSecret(input: {
  /** The secret taken from the request's query string (e.g. `?zipy_secret=...`). */
  readonly receivedSecret: string | null;
  /** The secret the customer configured for this Zip/Scenario. */
  readonly configuredSecret: string | null;
}): ZapierVerificationResult {
  if (input.configuredSecret === null || input.configuredSecret.length === 0) {
    return {
      ok: false,
      reason: "missing-configured-secret",
      detail:
        "No shared secret is configured for the Zapier inbound trigger. Refuse the request rather than accept an unauthenticated trigger.",
    };
  }
  if (input.receivedSecret === null || input.receivedSecret.length === 0) {
    return {
      ok: false,
      reason: "missing-received-secret",
      detail:
        "The inbound request did not carry a `zipy_secret` query parameter; Zapier/Make appends the parameter the customer configured, so its absence means the request did not originate from the configured hook.",
    };
  }
  if (!constantTimeStringEqual(input.receivedSecret, input.configuredSecret)) {
    return {
      ok: false,
      reason: "secret-mismatch",
      detail:
        "The received shared secret does not match the value configured for this hook.",
    };
  }
  return { ok: true, reason: "ok", detail: "Shared secret matches." };
}

/**
 * The verification steps the platform's inbound Zapier/Make route must
 * perform *before* trusting a trigger. The adapter performs the secret
 * comparison; the remaining steps belong in the route and are documented
 * here so a route author cannot forget one.
 */
export function describeZapierVerificationRequirement(): readonly string[] {
  return [
    "Read the `zipy_secret` query parameter from the raw request and refuse the request when it is absent.",
    "Compare the received secret against the workspace's configured value using `verifyZapierInboundSecret` (constant time); never log the received value.",
    "Apply a raw-body size limit (Zapier bodies are typically small; a proxy compromise could send any size) before JSON parsing.",
    "Optionally, restrict the request's source IP to Zapier's published outbound ranges, maintained separately and refreshed when Zapier publishes an updated list. This belongs at the ingress layer, not in this adapter.",
    "Resolve the workspace from the secret, never from the body: a body claiming a workspace id must not be trusted to select one, because the secret is the only authentication channel.",
    "Persist the delivery id from the parsed body (falling back to a hash of the raw body when no id is present) alongside the audit entry so a duplicate POST from Zapier's retry machinery is deduplicated rather than run twice.",
    "Bound the number of steps the inbound trigger can generate per unit time, independent of per-workspace quotas, so a compromised Zap cannot drive unlimited generations.",
  ];
}

/* -------------------------------------------------------------------------- */
/* Trigger and action descriptors                                              */
/* -------------------------------------------------------------------------- */

/**
 * The platform's discoverable trigger and action set. These descriptors are
 * metadata; the adapter does not publish a Zapier app or a Make app, so a
 * customer who wants pre-built Zaps authors them against these
 * descriptions. `hookPath` is the path on the platform the inbound
 * Zapier/Make trigger posts to; the caller mounts the route at that path.
 */
export function listZapierTriggers(): readonly ZapierTriggerDescriptor[] {
  return [
    {
      key: "generation.completed",
      noun: "Generation",
      label: "Generation completed",
      helpText:
        "Triggers when a Zipy AI generation job finishes. The payload includes the workflow, the produced guide and a link to the review UI.",
      hookPath: "/api/integrations/zapier/generation-completed",
      sampleKeys: ["event", "id", "occurredAt", "workspaceId", "resource", "data"],
    },
    {
      key: "review.requested",
      noun: "Review",
      label: "Review requested",
      helpText:
        "Triggers when a workflow pauses at a human-in-the-loop checkpoint and awaits an approval decision.",
      hookPath: "/api/integrations/zapier/review-requested",
      sampleKeys: ["event", "id", "occurredAt", "workspaceId", "resource", "data"],
    },
    {
      key: "guide.published",
      noun: "Guide",
      label: "Guide published",
      helpText:
        "Triggers when a guide is published, with the public URL, the export formats produced and the workspace branding applied.",
      hookPath: "/api/integrations/zapier/guide-published",
      sampleKeys: ["event", "id", "occurredAt", "workspaceId", "resource", "data"],
    },
  ];
}

export function listZapierActions(): readonly ZapierActionDescriptor[] {
  return [
    {
      key: "generate.tutorial",
      noun: "Zipy AI",
      label: "Generate a Zipy AI tutorial",
      helpText:
        "Create a new generation job from a URL, a text prompt, or a hosted file URL. The job runs on the platform's worker.",
      requiredFields: [
        {
          key: "sourceKind",
          label: "Source kind",
          type: "string",
          required: true,
          helpText: 'One of "url", "text", "image", "pdf", "docx", "pptx", "audio", "video".',
        },
        {
          key: "goal",
          label: "Goal",
          type: "text",
          required: true,
          helpText: "The natural-language goal for the tutorial (e.g. \"how to create a customer\").",
        },
      ],
      optionalFields: [
        {
          key: "sourceUrl",
          label: "Source URL",
          type: "string",
          required: false,
          helpText: "Required when sourceKind is \"url\" or a hosted file URL.",
        },
        {
          key: "sourceText",
          label: "Source text",
          type: "text",
          required: false,
          helpText: "Used when sourceKind is \"text\".",
        },
        {
          key: "tone",
          label: "Tone",
          type: "string",
          required: false,
          helpText: 'One of "formal", "casual", "technical".',
        },
        {
          key: "audience",
          label: "Audience",
          type: "string",
          required: false,
          helpText: 'One of "end-user", "admin", "developer".',
        },
        {
          key: "languages",
          label: "Languages",
          type: "string",
          required: false,
          helpText: "Comma-separated BCP-47 language tags for translation.",
        },
      ],
    },
    {
      key: "review.decide",
      noun: "Zipy AI",
      label: "Submit a review decision",
      helpText:
        "Approve, edit or reject a pending human-in-the-loop review from a Zap step.",
      requiredFields: [
        {
          key: "workflowId",
          label: "Workflow id",
          type: "string",
          required: true,
        },
        {
          key: "gateId",
          label: "Gate id",
          type: "string",
          required: true,
        },
        {
          key: "decision",
          label: "Decision",
          type: "string",
          required: true,
          helpText: 'One of "approve", "reject".',
        },
      ],
      optionalFields: [
        {
          key: "note",
          label: "Reviewer note",
          type: "text",
          required: false,
        },
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Inbound payload parsing                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse an inbound Zapier/Make trigger body into a typed envelope. The
 * body shape a customer's Zap posts is up to the customer, so this parser
 * is tolerant: it pulls the fields this adapter cares about and returns
 * `null` for any that are absent, leaving the route to decide whether a
 * missing field is fatal. It never invents a workspace id or a trigger key.
 */
export interface ZapierInboundEvent {
  /** The trigger key (as in `listZapierTriggers`), when the body supplies it. */
  readonly triggerKey: string | null;
  /** The delivery id, when the body supplies one. */
  readonly deliveryId: string | null;
  /** The workspace id, when the body supplies one. This is data, not authentication. */
  readonly workspaceId: string | null;
  /** The resource this delivery concerns, when the body supplies one. */
  readonly resource: {
    readonly kind: string | null;
    readonly id: string | null;
  } | null;
  /** The event's data, passed through unchanged for the caller to read. */
  readonly data: Readonly<Record<string, unknown>> | null;
  /** The raw body, so the route can hash it for dedup/audit. */
  readonly rawJson: string;
}

export function parseZapierInboundEvent(rawBody: string): ZapierInboundEvent {
  if (typeof rawBody !== "string" || rawBody.length === 0) {
    throw new ZapierIntegrationError("Inbound body is empty.", "invalid-input");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ZapierIntegrationError(
      "Inbound body is not valid JSON.",
      "invalid-input",
      { byteLength: rawBody.length },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ZapierIntegrationError(
      "Inbound body is not a JSON object.",
      "invalid-input",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const triggerKey = firstNonEmptyString([
    obj["triggerKey"],
    obj["trigger_key"],
    obj["event"],
  ]);
  const deliveryId = firstNonEmptyString([
    obj["id"],
    obj["deliveryId"],
    obj["delivery_id"],
  ]);
  const workspaceId = firstNonEmptyString([
    obj["workspaceId"],
    obj["workspace_id"],
  ]);
  const resourceRaw = obj["resource"];
  const resource =
    resourceRaw !== null && typeof resourceRaw === "object"
      ? {
          kind: firstNonEmptyString([
            (resourceRaw as Record<string, unknown>)["kind"],
            (resourceRaw as Record<string, unknown>)["type"],
          ]),
          id: firstNonEmptyString([
            (resourceRaw as Record<string, unknown>)["id"],
          ]),
        }
      : null;
  const dataRaw = obj["data"];
  const data =
    dataRaw !== null && typeof dataRaw === "object" && !Array.isArray(dataRaw)
      ? (dataRaw as Record<string, unknown>)
      : null;
  return { triggerKey, deliveryId, workspaceId, resource, data, rawJson: rawBody };
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

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

function firstNonEmptyString(
  candidates: readonly unknown[],
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const t = candidate.trim();
      if (t.length > 0) return t;
    }
  }
  return null;
}

/**
 * Constant-time string compare without node:crypto, so a caller running
 * this code on an edge runtime does not need a Node built-in. Returns
 * false on unequal lengths; the lengths are not secret in the shared-secret
 * channel because the operator configured exactly one secret.
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
  parseZapierInboundEvent,
  verifyZapierInboundSecret,
  constantTimeStringEqual,
  firstNonEmptyString,
  abortAfter,
  parseRetryAfterMs,
  truncate,
});
