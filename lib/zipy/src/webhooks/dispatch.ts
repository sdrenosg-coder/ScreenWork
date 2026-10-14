/**
 * Zipy AI — webhook dispatch (phase 21, batch 1).
 *
 * Delivers signed HTTP POSTs to a workspace's registered webhook endpoints
 * when a domain event fires (`generation.completed`, `review.requested`,
 * `guide.published`, ...). This module is the *transport*: it decides what to
 * send, attaches a signature, retries with backoff, and records the outcome.
 *
 * Design boundaries
 * -----------------
 *  - No subscription is fabricated. `dispatch` refuses to send to an endpoint
 *    that has not been persisted with an event list from the workspace's admin
 *    surface. There is no "send to everyone in the workspace" default.
 *  - No secret is fabricated. Endpoint secrets are stored per-subscription;
 *    the platform-wide `WEBHOOK_SIGNING_SECRET` in config is *only* a fallback
 *    for a workspace that has not yet provisioned per-endpoint secrets, and is
 *    itself optional. When neither is available, the delivery is recorded as
 *    `failed` with `reason: "no-secret"` — it is not sent unsigned.
 *  - Failures are recorded, not swallowed. Every attempt appends a
 *    `DeliveryAttempt`; the caller (a job) sees the full history and can page
 *    an operator when an endpoint is persistently failing.
 *  - No clock is hidden. The caller supplies `nowMs` so a test can pin it and
 *    a caller running behind a skewed host can supply an NTP-corrected value.
 *  - No queueing is embedded. Retry backoff is computed and returned as
 *    `retryAfterMs`; the caller's job runner schedules the next attempt. This
 *    keeps the module synchronous and testable, and lets the platform's queue
 *    policy (Redis vs Postgres) change without touching webhook logic.
 *
 * The module exports:
 *   - `subscribe` / `unsubscribe` — the in-memory registry the caller persists.
 *   - `dispatch` — the primary entry: validate the event, find matching
 *     subscriptions, sign, POST, retry, record.
 *   - `listDeliveries` — the delivery log for a subscription.
 *   - `verifyEndpointSignature` — the receiver-side verification helper that
 *     re-exports the signature module's verifier.
 *   - `rehydrateSubscriptions` / `rehydrateDeliveryLog` — typed load of a
 *     persisted payload.
 *   - `__internals` — the backoff and event-matching helpers.
 */

import {
  SIGNATURE_VERSION,
  SignatureError,
  computeHmac,
  parseSignatureHeader,
  signPayload,
  verifySignature,
  type VerifySignatureInput,
  type VerifySignatureResult,
} from "./signature.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DispatchErrorCode =
  | "invalid-input"
  | "no-subscriptions"
  | "no-secret"
  | "transport-failure"
  | "event-unknown"
  | "endpoint-disabled";

export class DispatchError extends Error {
  readonly code: DispatchErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DispatchErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The event names the platform emits. New events are added here explicitly;
 * a caller cannot dispatch an arbitrary string, because a receiver's routing
 * logic depends on a closed vocabulary.
 */
export const WEBHOOK_EVENTS = [
  "generation.started",
  "generation.completed",
  "generation.failed",
  "review.requested",
  "review.decided",
  "guide.published",
  "guide.unpublished",
  "guide.exported",
  "workflow.changed",
  "source.changed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * A subscription is one endpoint a workspace has registered. `secret` is the
 * per-endpoint shared secret the receiver uses to verify the `Zipy-Signature`
 * header. When `secret` is null, the dispatcher falls back to the
 * platform-wide secret passed on the dispatch call; if that too is null the
 * delivery fails with `no-secret` rather than sending unsigned.
 */
export interface WebhookSubscription {
  readonly subscriptionId: string;
  readonly workspaceId: string;
  /** Display label; the receiver sees it in the `X-Zipy-Endpoint` header. */
  readonly label: string;
  /** HTTPS endpoint the deliveries POST to. */
  readonly url: string;
  /** The events this endpoint subscribes to. `["*"]` receives all events. */
  readonly events: readonly (WebhookEvent | "*")[];
  /** Per-endpoint shared secret; null falls back to the dispatch-level secret. */
  readonly secret: string | null;
  /** When false, the dispatcher skips this endpoint without a network call. */
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebhookEventEnvelope<T = unknown> {
  /** Stable id derived from the event tuple. Used for receiver-side dedupe. */
  readonly eventId: string;
  /** The event name; drawn from `WEBHOOK_EVENTS`. */
  readonly event: WebhookEvent;
  /** ISO timestamp the event was recorded by the emitter. */
  readonly occurredAt: string;
  /** The workspace the event belongs to. Receiver verifies this matches. */
  readonly workspaceId: string;
  /** The workflow or guide the event concerns; null for workspace-scoped events. */
  readonly subjectId: string | null;
  /** The kind of `subjectId`: "workflow" | "guide" | "source" | null. */
  readonly subjectKind: "workflow" | "guide" | "source" | null;
  /** Free-form event body. Must be JSON-serializable. */
  readonly payload: T;
}

export interface DeliveryAttempt {
  /** 1-based attempt number. */
  readonly attempt: number;
  /** ISO timestamp the attempt was made (from the caller's `nowMs`). */
  readonly at: string;
  readonly status: "delivered" | "failed" | "skipped";
  /** HTTP status when a response was received; null on network error. */
  readonly httpStatus: number | null;
  /** Truncated response body (first 2 KiB) for the operator's dashboard. */
  readonly responseBody: string | null;
  /** Error message when `status !== "delivered"`. */
  readonly error: string | null;
  /** Milliseconds the request took; null when the attempt was skipped. */
  readonly durationMs: number | null;
}

export interface DeliveryReceipt {
  readonly version: "delivery-receipt/1";
  readonly deliveryId: string;
  readonly eventId: string;
  readonly event: WebhookEvent;
  readonly subscriptionId: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly attempts: readonly DeliveryAttempt[];
  readonly finalStatus: "delivered" | "failed" | "skipped";
  /** When the next attempt should run; null when the delivery is complete. */
  readonly retryAfterMs: number | null;
  readonly generatedAt: string;
  readonly aiGenerated: false;
}

export interface DeliveryLog {
  readonly version: "delivery-log/1";
  readonly workspaceId: string;
  readonly receipts: readonly DeliveryReceipt[];
  readonly generatedAt: string;
  readonly aiGenerated: false;
}

/**
 * The HTTP transport port. The production transport is `globalThis.fetch`;
 * tests supply a fake. The port is injected so this module has no hidden
 * network dependency and so a self-hosted operator can route deliveries
 * through a proxy or a signed reverse channel without editing webhook logic.
 */
export type WebhookTransport = (input: {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}) => Promise<{ readonly status: number; readonly body: string }>;

export interface DispatchInput<T = unknown> {
  readonly event: WebhookEventEnvelope<T>;
  /** Every subscription in the workspace; the module filters by event. */
  readonly subscriptions: readonly WebhookSubscription[];
  /**
   * The fallback secret for endpoints that have not provisioned their own.
   * Null means "the platform has no default secret" and any endpoint without
   * its own secret will fail with `no-secret`.
   */
  readonly fallbackSecret: string | null;
  readonly transport: WebhookTransport;
  /** Current time in ms. Required so the module has no hidden clock. */
  readonly nowMs: number;
  /** Maximum attempts per delivery. Defaults to 5. */
  readonly maxAttempts?: number;
  /** Base backoff in ms. Defaults to 5 seconds. */
  readonly backoffBaseMs?: number;
  /** Per-request timeout. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
  /** An existing log; receipts for this event are appended. */
  readonly existingLog?: DeliveryLog | null;
}

export interface DispatchResult {
  readonly log: DeliveryLog;
  readonly receipts: readonly DeliveryReceipt[];
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY_CHARS = 2 * 1024;

/**
 * HTTP status codes that are worth retrying. A 4xx (other than 408 and 429)
 * means the receiver will reject every subsequent attempt; retrying it
 * wastes the endpoint's resources and the platform's, and floods a broken
 * endpoint's access log. 5xx and network errors are transient.
 */
const RETRYABLE_STATUS = new Set<number>([408, 425, 429, 500, 502, 503, 504, 507, 509]);

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Register a subscription. This is a pure constructor; the caller persists
 * the returned value. Validates that the URL is HTTPS (or an explicit local
 * override the caller passes as `urlScheme`) and that the event list is
 * non-empty and drawn from `WEBHOOK_EVENTS` (or is exactly `["*"]`).
 */
export function subscribe(input: {
  readonly workspaceId: string;
  readonly label: string;
  readonly url: string;
  readonly events: readonly (WebhookEvent | "*")[];
  readonly secret: string | null;
  readonly nowIso: string;
  /**
   * Whether to accept an http:// URL. Defaults to false in production;
   * a local dev environment sets it true so a receiver on localhost is
   * testable. The caller supplies this so the module has no env dependency.
   */
  readonly allowInsecure?: boolean;
}): WebhookSubscription {
  if (input === null || typeof input !== "object") {
    throw new DispatchError("subscribe requires an inputs object.", "invalid-input");
  }
  if (!nonEmpty(input.workspaceId)) {
    throw new DispatchError("`workspaceId` is required.", "invalid-input");
  }
  if (!nonEmpty(input.label)) {
    throw new DispatchError("`label` is required.", "invalid-input");
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new DispatchError("`events` must be a non-empty array.", "invalid-input");
  }
  const events = normalizeEventList(input.events);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    throw new DispatchError(
      `\`url\` is not a valid URL: ${input.url}`,
      "invalid-input",
      { url: input.url },
    );
  }
  const allowInsecure = input.allowInsecure === true;
  if (parsedUrl.protocol !== "https:" && !(allowInsecure && parsedUrl.protocol === "http:")) {
    throw new DispatchError(
      `Webhook URLs must use https:// (received "${parsedUrl.protocol}//"); pass allowInsecure=true only for a local receiver.`,
      "invalid-input",
      { url: input.url, allowInsecure },
    );
  }
  return {
    subscriptionId: `sub_${fnv1a32(`${input.workspaceId}|${input.url}|${input.nowIso}`)
      .toString(16)
      .padStart(8, "0")}`,
    workspaceId: input.workspaceId,
    label: input.label.trim(),
    url: parsedUrl.toString(),
    events: Object.freeze(events),
    secret: nonEmpty(input.secret) ?? null,
    enabled: true,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}

/**
 * The primary entry point. Sends the event to every enabled subscription in
 * the workspace whose event list matches, retrying transient failures with
 * exponential backoff up to `maxAttempts`. Returns the accumulated log.
 *
 * The function is synchronous from the caller's perspective but performs
 * HTTP calls sequentially per subscription (concurrent deliveries to the
 * same endpoint from a single job would race a receiver's idempotency
 * handler). Different subscriptions are dispatched in the order the caller
 * provides them so a receiver that owns two endpoints sees events in a
 * stable order.
 */
export async function dispatch<T = unknown>(
  input: DispatchInput<T>,
): Promise<DispatchResult> {
  if (input === null || typeof input !== "object") {
    throw new DispatchError("dispatch requires an inputs object.", "invalid-input");
  }
  const envelope = input.event;
  if (envelope === null || typeof envelope !== "object") {
    throw new DispatchError("`event` is required.", "invalid-input");
  }
  if (!isWebhookEvent(envelope.event)) {
    throw new DispatchError(
      `Unknown event "${String(envelope.event)}". Add it to WEBHOOK_EVENTS before dispatching.`,
      "event-unknown",
      { event: envelope.event },
    );
  }
  if (!nonEmpty(envelope.eventId)) {
    throw new DispatchError("`event.eventId` is required.", "invalid-input");
  }
  if (!nonEmpty(envelope.workspaceId)) {
    throw new DispatchError("`event.workspaceId` is required.", "invalid-input");
  }
  if (!nonEmpty(envelope.occurredAt)) {
    throw new DispatchError("`event.occurredAt` is required.", "invalid-input");
  }
  if (typeof input.nowMs !== "number" || !Number.isFinite(input.nowMs)) {
    throw new DispatchError("`nowMs` must be a finite number.", "invalid-input");
  }
  if (typeof input.transport !== "function") {
    throw new DispatchError(
      "`transport` must be a function; supply globalThis.fetch in production or a fake in tests.",
      "invalid-input",
    );
  }
  if (!Array.isArray(input.subscriptions)) {
    throw new DispatchError("`subscriptions` must be an array.", "invalid-input");
  }

  const maxAttempts = clampPositiveInt(input.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const backoffBaseMs = clampPositiveInt(input.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS);
  const timeoutMs = clampPositiveInt(input.timeoutMs, DEFAULT_TIMEOUT_MS);

  // Filter to the subscriptions that want this event and are enabled and
  // in the right workspace.
  const eligible = input.subscriptions.filter(
    (s) =>
      s.workspaceId === envelope.workspaceId &&
      s.enabled &&
      (s.events.includes("*") || s.events.includes(envelope.event)),
  );

  const receipts: DeliveryReceipt[] = [];
  for (const sub of eligible) {
    const receipt = await dispatchOne({
      envelope,
      subscription: sub,
      fallbackSecret: input.fallbackSecret,
      transport: input.transport,
      nowMs: input.nowMs,
      maxAttempts,
      backoffBaseMs,
      timeoutMs,
    });
    receipts.push(receipt);
  }

  const baseLog =
    input.existingLog !== null && input.existingLog !== undefined
      ? validateLog(input.existingLog, envelope.workspaceId)
      : emptyLog(envelope.workspaceId);
  const log: DeliveryLog = {
    ...baseLog,
    receipts: Object.freeze([...baseLog.receipts, ...receipts]),
    generatedAt: new Date(input.nowMs).toISOString(),
    aiGenerated: false,
  };
  return { log, receipts };
}

/**
 * The delivery log for a subscription. Returns receipts in dispatch order;
 * the caller renders the operator's dashboard.
 */
export function listDeliveries(
  log: DeliveryLog | null,
  subscriptionId: string,
): readonly DeliveryReceipt[] {
  if (log === null || log === undefined) return [];
  if (log.version !== "delivery-log/1") {
    throw new DispatchError(
      'listDeliveries requires a DeliveryLog (version "delivery-log/1").',
      "invalid-input",
    );
  }
  if (!nonEmpty(subscriptionId)) {
    throw new DispatchError("`subscriptionId` is required.", "invalid-input");
  }
  return log.receipts.filter((r) => r.subscriptionId === subscriptionId);
}

/**
 * A receiver-side verification helper. Re-exported so a customer integrating
 * the platform's webhooks has a single canonical implementation to copy. The
 * caller (a receiver) supplies `nowSeconds` and the raw request body.
 */
export function verifyEndpointSignature(
  input: VerifySignatureInput,
): VerifySignatureResult {
  return verifySignature(input);
}

/**
 * Rebuild the header string a receiver sees. Exported so a customer's test
 * harness can construct the same header for its own fixtures.
 */
export function buildReceiverHeader(
  body: string,
  secret: string,
  nowSeconds: number,
): string {
  return signPayload(body, secret, nowSeconds);
}

export function rehydrateSubscriptions(value: unknown): readonly WebhookSubscription[] {
  if (!Array.isArray(value)) {
    throw new DispatchError("Rehydrate failed: expected a JSON array.", "invalid-input");
  }
  const out: WebhookSubscription[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const eventsRaw = Array.isArray(o["events"]) ? o["events"] : [];
    const events: (WebhookEvent | "*")[] = [];
    for (const e of eventsRaw) {
      if (e === "*") {
        events.push("*");
      } else if (isWebhookEvent(e)) {
        events.push(e);
      }
    }
    out.push({
      subscriptionId: typeof o["subscriptionId"] === "string" ? o["subscriptionId"] : "",
      workspaceId: typeof o["workspaceId"] === "string" ? o["workspaceId"] : "",
      label: typeof o["label"] === "string" ? o["label"] : "",
      url: typeof o["url"] === "string" ? o["url"] : "",
      events: Object.freeze(events),
      secret: typeof o["secret"] === "string" ? o["secret"] : null,
      enabled: o["enabled"] !== false,
      createdAt: typeof o["createdAt"] === "string" ? o["createdAt"] : "",
      updatedAt: typeof o["updatedAt"] === "string" ? o["updatedAt"] : "",
    });
  }
  return out;
}

export function rehydrateDeliveryLog(value: unknown): DeliveryLog {
  if (value === null || typeof value !== "object") {
    throw new DispatchError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "delivery-log/1") {
    throw new DispatchError(
      `Rehydrate failed: expected version "delivery-log/1", received "${String(r["version"])}".`,
      "invalid-input",
    );
  }
  const receiptsRaw = Array.isArray(r["receipts"]) ? r["receipts"] : [];
  const receipts: DeliveryReceipt[] = [];
  for (const item of receiptsRaw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o["version"] !== "delivery-receipt/1") continue;
    receipts.push({
      version: "delivery-receipt/1",
      deliveryId: typeof o["deliveryId"] === "string" ? o["deliveryId"] : "",
      eventId: typeof o["eventId"] === "string" ? o["eventId"] : "",
      event: isWebhookEvent(o["event"]) ? o["event"] : "generation.started",
      subscriptionId: typeof o["subscriptionId"] === "string" ? o["subscriptionId"] : "",
      workspaceId: typeof o["workspaceId"] === "string" ? o["workspaceId"] : "",
      url: typeof o["url"] === "string" ? o["url"] : "",
      attempts: readAttempts(o["attempts"]),
      finalStatus:
        o["finalStatus"] === "delivered"
          ? "delivered"
          : o["finalStatus"] === "skipped"
            ? "skipped"
            : "failed",
      retryAfterMs:
        typeof o["retryAfterMs"] === "number" && Number.isFinite(o["retryAfterMs"])
          ? Math.max(0, Math.floor(o["retryAfterMs"]))
          : null,
      generatedAt: typeof o["generatedAt"] === "string" ? o["generatedAt"] : "",
      aiGenerated: false,
    });
  }
  return {
    version: "delivery-log/1",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    receipts,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface DispatchOneInput<T> {
  readonly envelope: WebhookEventEnvelope<T>;
  readonly subscription: WebhookSubscription;
  readonly fallbackSecret: string | null;
  readonly transport: WebhookTransport;
  readonly nowMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly timeoutMs: number;
}

async function dispatchOne<T>(input: DispatchOneInput<T>): Promise<DeliveryReceipt> {
  const { envelope, subscription } = input;

  // Disabled subscription: record a `skipped` receipt without a network call
  // so an operator sees that the endpoint was not contacted and why.
  if (!subscription.enabled) {
    return finaliseReceipt({
      envelope,
      subscription,
      attempts: [
        {
          attempt: 1,
          at: new Date(input.nowMs).toISOString(),
          status: "skipped",
          httpStatus: null,
          responseBody: null,
          error: "Subscription is disabled.",
          durationMs: null,
        },
      ],
      maxAttempts: input.maxAttempts,
      backoffBaseMs: input.backoffBaseMs,
      nowMs: input.nowMs,
    });
  }

  // A workspace can provision a per-endpoint secret. If not, the platform's
  // fallback secret is used. If neither is present, the delivery fails
  // without a network call: sending unsigned would let any network observer
  // forge a delivery, and the platform refuses to do that silently.
  const secret = subscription.secret ?? input.fallbackSecret;
  if (secret === null || secret.length === 0) {
    return finaliseReceipt({
      envelope,
      subscription,
      attempts: [
        {
          attempt: 1,
          at: new Date(input.nowMs).toISOString(),
          status: "failed",
          httpStatus: null,
          responseBody: null,
          error:
            "No signing secret is configured for this endpoint and no platform fallback secret was supplied. Refusing to send an unsigned delivery.",
          durationMs: null,
        },
      ],
      maxAttempts: input.maxAttempts,
      backoffBaseMs: input.backoffBaseMs,
      nowMs: input.nowMs,
    });
  }

  const body = JSON.stringify(envelope);

  const attempts: DeliveryAttempt[] = [];
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const at = new Date(input.nowMs + (attempt - 1) * backoffFor(attempt - 1, input.backoffBaseMs)).toISOString();
    const startedAt = input.nowMs + (attempt - 1) * backoffFor(attempt - 1, input.backoffBaseMs);
    const signature = signPayload(body, secret, Math.floor(startedAt / 1000));
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "Zipy-AI-Webhooks/1",
      "Zipy-Signature": signature,
      "Zipy-Event": envelope.event,
      "Zipy-Event-Id": envelope.eventId,
      "Zipy-Delivery-Attempt": String(attempt),
      "Zipy-Signature-Version": SIGNATURE_VERSION,
      "X-Zipy-Endpoint": subscription.subscriptionId,
    };
    const abort = new AbortController();
    const timeoutHandle = setTimeout(() => abort.abort(), input.timeoutMs);
    const attemptStarted = Date.now();
    try {
      const response = await input.transport({
        url: subscription.url,
        method: "POST",
        headers,
        body,
        timeoutMs: input.timeoutMs,
        signal: abort.signal,
      });
      const duration = Date.now() - attemptStarted;
      const responseBody = truncate(response.body, MAX_RESPONSE_BODY_CHARS);
      if (response.status >= 200 && response.status < 300) {
        attempts.push({
          attempt,
          at: new Date(startedAt).toISOString(),
          status: "delivered",
          httpStatus: response.status,
          responseBody,
          error: null,
          durationMs: duration,
        });
        clearTimeout(timeoutHandle);
        return finaliseReceipt({
          envelope,
          subscription,
          attempts,
          maxAttempts: input.maxAttempts,
          backoffBaseMs: input.backoffBaseMs,
          nowMs: input.nowMs,
        });
      }
      const retryable = RETRYABLE_STATUS.has(response.status);
      attempts.push({
        attempt,
        at: new Date(startedAt).toISOString(),
        status: "failed",
        httpStatus: response.status,
        responseBody,
        error: retryable
          ? `Endpoint returned ${response.status}; will retry.`
          : `Endpoint returned ${response.status}; response is not retryable.`,
        durationMs: duration,
      });
      clearTimeout(timeoutHandle);
      if (!retryable) break;
    } catch (err) {
      clearTimeout(timeoutHandle);
      const duration = Date.now() - attemptStarted;
      const message = err instanceof Error ? err.message : String(err);
      attempts.push({
        attempt,
        at: new Date(startedAt).toISOString(),
        status: "failed",
        httpStatus: null,
        responseBody: null,
        error: `Transport error: ${message}`,
        durationMs: duration,
      });
      // A transport error is treated as transient and retried.
    }
  }
  return finaliseReceipt({
    envelope,
    subscription,
    attempts,
    maxAttempts: input.maxAttempts,
    backoffBaseMs: input.backoffBaseMs,
    nowMs: input.nowMs,
  });
}

interface FinaliseReceiptInput<T> {
  readonly envelope: WebhookEventEnvelope<T>;
  readonly subscription: WebhookSubscription;
  readonly attempts: readonly DeliveryAttempt[];
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly nowMs: number;
}

function finaliseReceipt<T>(input: FinaliseReceiptInput<T>): DeliveryReceipt {
  const last = input.attempts[input.attempts.length - 1];
  const finalStatus: DeliveryReceipt["finalStatus"] = (() => {
    if (last === undefined) return "failed";
    if (last.status === "delivered") return "delivered";
    if (last.status === "skipped") return "skipped";
    return "failed";
  })();
  // Retry only when the delivery failed and we have attempts left. The
  // backoff is computed from the *next* attempt index, so the caller knows
  // exactly when to schedule the retry.
  const usedAttempts = input.attempts.length;
  const retryAfterMs =
    finalStatus === "failed" && usedAttempts < input.maxAttempts
      ? backoffFor(usedAttempts, input.backoffBaseMs)
      : null;
  const deliveryId = `del_${fnv1a32(`${input.envelope.eventId}|${input.subscription.subscriptionId}`)
    .toString(16)
    .padStart(8, "0")}`;
  return {
    version: "delivery-receipt/1",
    deliveryId,
    eventId: input.envelope.eventId,
    event: input.envelope.event,
    subscriptionId: input.subscription.subscriptionId,
    workspaceId: input.subscription.workspaceId,
    url: input.subscription.url,
    attempts: Object.freeze([...input.attempts]),
    finalStatus,
    retryAfterMs,
    generatedAt: new Date(input.nowMs).toISOString(),
    aiGenerated: false,
  };
}

function emptyLog(workspaceId: string): DeliveryLog {
  return {
    version: "delivery-log/1",
    workspaceId,
    receipts: Object.freeze([]),
    generatedAt: new Date().toISOString(),
    aiGenerated: false,
  };
}

function validateLog(log: DeliveryLog, workspaceId: string): DeliveryLog {
  if (log.version !== "delivery-log/1") {
    throw new DispatchError(
      `Expected a DeliveryLog (version "delivery-log/1"), received "${String(log.version)}".`,
      "invalid-input",
    );
  }
  if (log.workspaceId !== workspaceId) {
    throw new DispatchError(
      `Cannot dispatch into a log for workspace "${log.workspaceId}" using an event for workspace "${workspaceId}".`,
      "invalid-input",
      { logWorkspaceId: log.workspaceId, eventWorkspaceId: workspaceId },
    );
  }
  return log;
}

function normalizeEventList(input: readonly (WebhookEvent | "*")[]): readonly (WebhookEvent | "*")[] {
  const out: (WebhookEvent | "*")[] = [];
  for (const e of input) {
    if (e === "*") {
      // `*` is exclusive: it subsumes every named event. Mixing `*` with
      // named events is a configuration smell; normalise to a single `*`.
      return Object.freeze(["*"]);
    }
    if (isWebhookEvent(e) && !out.includes(e)) out.push(e);
  }
  if (out.length === 0) {
    throw new DispatchError(
      "At least one recognised webhook event is required.",
      "invalid-input",
      { received: input },
    );
  }
  return Object.freeze(out);
}

function isWebhookEvent(v: unknown): v is WebhookEvent {
  return (
    v === "generation.started" ||
    v === "generation.completed" ||
    v === "generation.failed" ||
    v === "review.requested" ||
    v === "review.decided" ||
    v === "guide.published" ||
    v === "guide.unpublished" ||
    v === "guide.exported" ||
    v === "workflow.changed" ||
    v === "source.changed"
  );
}

/**
 * Exponential backoff with a small deterministic jitter-free term so retries
 * from a burst of subscriptions do not all fire in the same millisecond.
 * Jitter is deliberately *not* random: a deterministic backoff makes the
 * retry schedule reproducible in tests and in a replayed delivery.
 */
function backoffFor(attemptIndex: number, baseMs: number): number {
  const safeIndex = Math.max(0, Math.min(attemptIndex, 10));
  // 1x, 2x, 4x, 8x, ... capped at 1 hour.
  return Math.min(baseMs * 2 ** safeIndex, 60 * 60 * 1000);
}

function clampPositiveInt(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
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

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function readAttempts(v: unknown): readonly DeliveryAttempt[] {
  if (!Array.isArray(v)) return [];
  const out: DeliveryAttempt[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const status: DeliveryAttempt["status"] =
      o["status"] === "delivered" || o["status"] === "skipped" ? o["status"] : "failed";
    out.push({
      attempt:
        typeof o["attempt"] === "number" && Number.isFinite(o["attempt"])
          ? Math.max(1, Math.floor(o["attempt"]))
          : 1,
      at: typeof o["at"] === "string" ? o["at"] : "",
      status,
      httpStatus:
        typeof o["httpStatus"] === "number" && Number.isFinite(o["httpStatus"])
          ? Math.floor(o["httpStatus"])
          : null,
      responseBody: typeof o["responseBody"] === "string" ? o["responseBody"] : null,
      error: typeof o["error"] === "string" ? o["error"] : null,
      durationMs:
        typeof o["durationMs"] === "number" && Number.isFinite(o["durationMs"])
          ? Math.max(0, Math.floor(o["durationMs"]))
          : null,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Re-exports for consumers that only need the signature side                  */
/* -------------------------------------------------------------------------- */

export {
  SIGNATURE_VERSION,
  signPayload,
  computeHmac,
  parseSignatureHeader,
  verifySignature,
  SignatureError,
};

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  backoffFor,
  isWebhookEvent,
  normalizeEventList,
  finaliseReceipt,
  emptyLog,
  validateLog,
  clampPositiveInt,
  truncate,
  readAttempts,
  RETRYABLE_STATUS,
  MAX_RESPONSE_BODY_CHARS,
});
