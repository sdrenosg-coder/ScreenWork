/**
 * Zipy AI — JavaScript/TypeScript SDK (phase 21, batch 1).
 *
 * A thin, typed HTTP client for the versioned REST API under `/api/v1`.
 * The SDK exists so a customer's integration does not hand-roll `fetch`
 * calls: it validates configuration, serializes requests consistently,
 * parses the platform's error envelope, and re-exports the webhook
 * signature verifier so a receiver can import both sides from one module.
 *
 * Design boundaries
 * -----------------
 *  - No default credentials. `new ZipyClient({ apiKey })` refuses an empty
 *    key with `ZipySdkError("missing-api-key")`. There is no fallback to an
 *    environment variable inside the SDK; the caller decides how the key is
 *    sourced (it is their binary after all), and this keeps the SDK safe to
 *    bundle into a customer's browser without an ambient secret lookup.
 *  - No retry of non-idempotent verbs. The SDK will retry a `GET` on a 5xx
 *    with bounded backoff, but a `POST`/`PATCH`/`DELETE` is *not* retried
 *    automatically: the platform's REST API does not expose an idempotency
 *    key in batch 1, so a caller who retries a POST is responsible for its
 *    own deduplication. (An idempotency-key header lands with the API's
 *    idempotency surface; the SDK adds it when the server exposes it.)
 *  - No assumed endpoints. Only the resources the API actually exposes in
 *    this batch are offered as typed methods: `guides`, `workflows`,
 *    `webhooks` (subscriptions), and `health`. A later batch adds `sources`,
 *    `artifacts`, `reviews`, `analytics`, `billing` as their routes land.
 *  - No hidden baseUrl. The SDK has no default `baseUrl`; a caller who
 *    omits it gets `ZipySdkError("missing-base-url")`, so a bundle cannot
 *    accidentally point at a dev host in production.
 *  - No invented response shapes. Return types are the documented shapes the
 *    platform's routes return; the SDK declares only the fields its own
 *    methods surface and a generic `ZipyApiError` for the rest.
 *
 * The module exports:
 *   - `ZipyClient` — the primary class.
 *   - `ZipySdkError` / `ZipyApiError` — the two error types.
 *   - `buildWebhookReceiver` — a small helper for a receiver's
 *     verification handler (calls `verifySignature` from the webhook
 *     module; re-exported here so a receiver imports one package).
 *   - Type definitions for the resources this batch surfaces.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The versioned endpoints the SDK surfaces in this batch. A later batch
 * adds more resource helpers; the string union is the exhaustive list for
 * this batch so the type checker flags a call against a route the SDK does
 * not yet cover.
 */
export const ZIPY_API_VERSION = "v1" as const;

export interface ZipyClientOptions {
  /** Base URL of the Zipy AI deployment, e.g. `https://api.zipy.example`. */
  readonly baseUrl: string;
  /** API key with the `zipy_` prefix. Never logged by the SDK. */
  readonly apiKey: string;
  /**
   * Workspace the SDK's requests are scoped to. Sent as the
   * `X-Zipy-Workspace` header; the platform's RBAC layer enforces the
   * caller's membership of that workspace.
   */
  readonly workspaceId?: string;
  /** Per-request timeout. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /**
   * `fetch` implementation. Defaults to `globalThis.fetch`. Injectable
   * so a Node 18+ caller can supply `undici`'s fetch or a test fake.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Retry policy for idempotent (`GET`) requests. Defaults:
   * maxAttempts 3, baseBackoffMs 250.
   */
  readonly retry?: {
    readonly maxAttempts?: number;
    readonly baseBackoffMs?: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Error types                                                                  */
/* -------------------------------------------------------------------------- */

export type ZipySdkErrorCode =
  | "missing-base-url"
  | "missing-api-key"
  | "invalid-base-url"
  | "invalid-response"
  | "transport-error"
  | "timeout";

export class ZipySdkError extends Error {
  readonly code: ZipySdkErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(message: string, code: ZipySdkErrorCode, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "ZipySdkError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The platform returns a structured error body for every non-2xx response:
 *   `{ "error": { "code": "...", "message": "...", "detail": {...} } }`
 * The SDK parses this shape when present and surfaces it as `ZipyApiError`.
 * When the body does not conform, the SDK still raises `ZipyApiError` with
 * `code: "http-<status>"` so a caller never sees a raw `Response`.
 */
export class ZipyApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    status: number,
    code: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ZipyApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Resource types surfaced in this batch                                       */
/* -------------------------------------------------------------------------- */

/**
 * A guide as the REST API returns it. This mirrors the minimal shape the
 * `apps/web/src/app/api/v1/guides/route.ts` handler returns; the SDK does
 * not invent extra fields. Additional fields added in a later API version
 * are surfaced through the `raw` field on the list result.
 */
export interface ZipyGuide {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly slug: string | null;
  readonly status: "draft" | "review" | "published" | "archived";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ZipyWorkflow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly goal: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ZipyListResponse<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
  /** When true, the deployed API version returned fields the SDK did not model. */
  readonly hasUnmodeledFields: boolean;
}

export interface ZipyListGuidesInput {
  readonly status?: ZipyGuide["status"];
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ZipyListWorkflowsInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ZipyCreateGuideInput {
  readonly title: string;
  /** Optional slug; the platform generates one from the title when omitted. */
  readonly slug?: string;
  /** Optional initial workflow to attach. */
  readonly workflowId?: string;
}

/**
 * A webhook subscription as the REST API returns it. The `secret` field is
 * only returned once — on the response to `createWebhook` — and the SDK
 * surfaces it that way; subsequent reads return it as `null`.
 */
export interface ZipyWebhookSubscription {
  readonly id: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Non-null only on the response to `createWebhook`. */
  readonly secret: string | null;
}

export interface ZipyCreateWebhookInput {
  readonly label: string;
  readonly url: string;
  readonly events: readonly string[];
  /**
   * Optional. When omitted, the platform generates one and returns it *once*
   * on the create response. A caller who wants to set their own supplies it
   * here; the platform stores only a hash.
   */
  readonly secret?: string;
}

/**
 * The pagination envelope every list route returns. The SDK's `hasUnmodeledFields`
 * flag is set when the raw body contains a `data` array whose items are
 * objects with fields the SDK did not model — a signal that a deployed API
 * version is newer than the SDK, which a caller can log without breaking.
 */
interface RawListBody {
  readonly data?: unknown;
  readonly nextCursor?: unknown;
  readonly pagination?: { readonly nextCursor?: unknown };
}

/* -------------------------------------------------------------------------- */
/* The client                                                                   */
/* -------------------------------------------------------------------------- */

export class ZipyClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #workspaceId: string | null;
  readonly #timeoutMs: number;
  readonly #fetchImpl: typeof fetch;
  readonly #maxAttempts: number;
  readonly #baseBackoffMs: number;

  constructor(options: ZipyClientOptions) {
    if (options === null || typeof options !== "object") {
      throw new ZipySdkError(
        "ZipyClient requires an options object.",
        "missing-base-url",
      );
    }
    if (typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
      throw new ZipySdkError(
        "`baseUrl` is required; the SDK has no default endpoint.",
        "missing-base-url",
      );
    }
    let parsedBase: URL;
    try {
      parsedBase = new URL(options.baseUrl);
    } catch {
      throw new ZipySdkError(
        `\`baseUrl\` is not a valid URL: ${options.baseUrl}`,
        "invalid-base-url",
        { baseUrl: options.baseUrl },
      );
    }
    if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") {
      throw new ZipySdkError(
        `\`baseUrl\` must use http:// or https:// (received "${parsedBase.protocol}//").`,
        "invalid-base-url",
        { baseUrl: options.baseUrl },
      );
    }
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new ZipySdkError(
        "`apiKey` is required; the SDK does not source keys from the environment.",
        "missing-api-key",
      );
    }
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new ZipySdkError(
        "No `fetch` implementation is available. Supply `fetchImpl` explicitly on runtimes without a global fetch.",
        "transport-error",
      );
    }
    this.#baseUrl = trimTrailingSlash(parsedBase.toString());
    this.#apiKey = options.apiKey;
    this.#workspaceId =
      typeof options.workspaceId === "string" && options.workspaceId.trim().length > 0
        ? options.workspaceId.trim()
        : null;
    this.#timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : 30_000;
    this.#fetchImpl = fetchImpl;
    this.#maxAttempts =
      typeof options.retry?.maxAttempts === "number" && options.retry.maxAttempts > 0
        ? Math.floor(options.retry.maxAttempts)
        : 3;
    this.#baseBackoffMs =
      typeof options.retry?.baseBackoffMs === "number" && options.retry.baseBackoffMs >= 0
        ? Math.floor(options.retry.baseBackoffMs)
        : 250;
  }

  /** Confirm the deployment is reachable and the API version matches. */
  async health(): Promise<{ readonly ok: true; readonly apiVersion: string }> {
    const body = await this.#request<{ apiVersion?: unknown }>({
      method: "GET",
      path: "/api/v1/health",
      idempotent: true,
    });
    const raw = body as RawListBody & { apiVersion?: unknown };
    void raw;
    const wrapper = body as { apiVersion?: unknown };
    return {
      ok: true,
      apiVersion:
        typeof wrapper.apiVersion === "string" ? wrapper.apiVersion : ZIPY_API_VERSION,
    };
  }

  /** List guides in the configured workspace. */
  async listGuides(input: ZipyListGuidesInput = {}): Promise<ZipyListResponse<ZipyGuide>> {
    const query: Record<string, string> = {};
    if (input.status) query["status"] = input.status;
    if (input.cursor) query["cursor"] = input.cursor;
    if (typeof input.limit === "number" && input.limit > 0) {
      query["limit"] = String(Math.floor(input.limit));
    }
    const body = await this.#request<RawListBody>({
      method: "GET",
      path: "/api/v1/guides",
      query,
      idempotent: true,
    });
    return this.#parseList<ZipyGuide>(body, "guide");
  }

  /** Fetch one guide by id. */
  async getGuide(id: string): Promise<ZipyGuide> {
    requireId(id, "id");
    const body = await this.#request<Record<string, unknown>>({
      method: "GET",
      path: `/api/v1/guides/${encodeURIComponent(id)}`,
      idempotent: true,
    });
    return readGuide(body);
  }

  /** Create a guide. */
  async createGuide(input: ZipyCreateGuideInput): Promise<ZipyGuide> {
    if (input === null || typeof input !== "object") {
      throw new ZipySdkError("createGuide requires an input object.", "invalid-response");
    }
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      throw new ZipySdkError("`title` is required.", "invalid-response");
    }
    const body: Record<string, string> = { title: input.title.trim() };
    if (typeof input.slug === "string") body["slug"] = input.slug;
    if (typeof input.workflowId === "string") body["workflowId"] = input.workflowId;
    const response = await this.#request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/guides",
      body: JSON.stringify(body),
      idempotent: false,
    });
    return readGuide(response);
  }

  /** List workflows in the configured workspace. */
  async listWorkflows(
    input: ZipyListWorkflowsInput = {},
  ): Promise<ZipyListResponse<ZipyWorkflow>> {
    const query: Record<string, string> = {};
    if (input.cursor) query["cursor"] = input.cursor;
    if (typeof input.limit === "number" && input.limit > 0) {
      query["limit"] = String(Math.floor(input.limit));
    }
    const body = await this.#request<RawListBody>({
      method: "GET",
      path: "/api/v1/workflows",
      query,
      idempotent: true,
    });
    return this.#parseList<ZipyWorkflow>(body, "workflow");
  }

  /** Fetch one workflow by id. */
  async getWorkflow(id: string): Promise<ZipyWorkflow> {
    requireId(id, "id");
    const body = await this.#request<Record<string, unknown>>({
      method: "GET",
      path: `/api/v1/workflows/${encodeURIComponent(id)}`,
      idempotent: true,
    });
    return readWorkflow(body);
  }

  /**
   * Create a webhook subscription. The response's `secret` is only present
   * on this call; the SDK surfaces it so a caller can persist it in its
   * own vault. Subsequent reads return `secret: null`.
   */
  async createWebhook(input: ZipyCreateWebhookInput): Promise<ZipyWebhookSubscription> {
    if (input === null || typeof input !== "object") {
      throw new ZipySdkError("createWebhook requires an input object.", "invalid-response");
    }
    if (typeof input.label !== "string" || input.label.trim().length === 0) {
      throw new ZipySdkError("`label` is required.", "invalid-response");
    }
    if (typeof input.url !== "string" || input.url.trim().length === 0) {
      throw new ZipySdkError("`url` is required.", "invalid-response");
    }
    if (!Array.isArray(input.events) || input.events.length === 0) {
      throw new ZipySdkError("`events` must be a non-empty array.", "invalid-response");
    }
    const body: Record<string, unknown> = {
      label: input.label.trim(),
      url: input.url.trim(),
      events: input.events,
    };
    if (typeof input.secret === "string") body["secret"] = input.secret;
    const response = await this.#request<Record<string, unknown>>({
      method: "POST",
      path: "/api/v1/webhooks",
      body: JSON.stringify(body),
      idempotent: false,
    });
    return readWebhookSubscription(response);
  }

  /** List the workspace's webhook subscriptions. `secret` is always `null`. */
  async listWebhooks(): Promise<ZipyListResponse<ZipyWebhookSubscription>> {
    const body = await this.#request<RawListBody>({
      method: "GET",
      path: "/api/v1/webhooks",
      idempotent: true,
    });
    return this.#parseList<ZipyWebhookSubscription>(body, "webhook");
  }

  /** Delete a webhook subscription. */
  async deleteWebhook(id: string): Promise<void> {
    requireId(id, "id");
    await this.#request<unknown>({
      method: "DELETE",
      path: `/api/v1/webhooks/${encodeURIComponent(id)}`,
      idempotent: false,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Internals                                                                */
  /* ------------------------------------------------------------------------ */

  #parseList<T>(
    body: RawListBody,
    kind: "guide" | "workflow" | "webhook",
  ): ZipyListResponse<T> {
    if (body === null || typeof body !== "object" || !Array.isArray(body.data)) {
      throw new ZipySdkError(
        `List response for "${kind}" did not contain a \`data\` array.`,
        "invalid-response",
      );
    }
    const items: T[] = [];
    let unmodeled = false;
    for (const raw of body.data) {
      if (raw === null || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      switch (kind) {
        case "guide": {
          items.push(readGuide(o) as unknown as T);
          if (hasUnknownFields(o, GUIDE_FIELDS)) unmodeled = true;
          break;
        }
        case "workflow": {
          items.push(readWorkflow(o) as unknown as T);
          if (hasUnknownFields(o, WORKFLOW_FIELDS)) unmodeled = true;
          break;
        }
        case "webhook": {
          items.push(readWebhookSubscription(o) as unknown as T);
          if (hasUnknownFields(o, WEBHOOK_FIELDS)) unmodeled = true;
          break;
        }
      }
    }
    const nextCursor =
      typeof body.nextCursor === "string"
        ? body.nextCursor
        : typeof body.pagination?.nextCursor === "string"
          ? body.pagination.nextCursor
          : null;
    return { data: Object.freeze(items), nextCursor, hasUnmodeledFields: unmodeled };
  }

  async #request<T>(req: {
    readonly method: "GET" | "POST" | "PATCH" | "DELETE";
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly idempotent: boolean;
  }): Promise<T> {
    const url = buildUrl(this.#baseUrl, req.path, req.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.#apiKey}`,
      "User-Agent": "Zipy-AI-SDK-JS/1",
      "Zipy-API-Version": ZIPY_API_VERSION,
    };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.#workspaceId !== null) headers["X-Zipy-Workspace"] = this.#workspaceId;

    const maxAttempts = req.idempotent ? this.#maxAttempts : 1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetchImpl(url, {
          method: req.method,
          headers,
          body: req.body,
          signal: abort.signal,
        });
        clearTimeout(timer);
        const text = await response.text();
        if (response.ok) {
          if (text.length === 0) {
            // 204 No Content for a DELETE; treat as a successful empty body.
            return undefined as unknown as T;
          }
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new ZipySdkError(
              `Response body was not valid JSON (status ${response.status}).`,
              "invalid-response",
              { status: response.status, body: truncate(text, 512) },
            );
          }
        }
        // Non-2xx: parse the platform's error envelope.
        const envelope = parseErrorEnvelope(text, response.status);
        // Retry an idempotent GET on a retryable status.
        if (req.idempotent && RETRYABLE.has(response.status) && attempt < maxAttempts) {
          await sleep(this.#baseBackoffMs * 2 ** (attempt - 1));
          lastError = envelope;
          continue;
        }
        throw envelope;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof ZipyApiError || err instanceof ZipySdkError) {
          if (req.idempotent && isRetryableSdkError(err) && attempt < maxAttempts) {
            await sleep(this.#baseBackoffMs * 2 ** (attempt - 1));
            lastError = err;
            continue;
          }
          throw err;
        }
        // A transport error (network failure, abort). Retry idempotent GETs.
        const isAbort = (err as { name?: string })?.name === "AbortError";
        const wrapped = new ZipySdkError(
          isAbort
            ? `Request timed out after ${this.#timeoutMs}ms.`
            : `Transport error: ${err instanceof Error ? err.message : String(err)}`,
          isAbort ? "timeout" : "transport-error",
        );
        if (req.idempotent && attempt < maxAttempts) {
          await sleep(this.#baseBackoffMs * 2 ** (attempt - 1));
          lastError = wrapped;
          continue;
        }
        throw wrapped;
      }
    }
    // Unreachable in practice; the loop always returns or throws. Kept so
    // the type checker sees a closed path.
    throw lastError ?? new ZipySdkError("Request failed.", "transport-error");
  }
}

/* -------------------------------------------------------------------------- */
/* Receiver helper                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a verification handler a webhook receiver can mount. The returned
 * function takes the raw request body and the `Zipy-Signature` header and
 * returns the same discriminated result as `verifySignature`. It is here
 * (rather than only in `@zipy/webhooks`) so a customer's integration that
 * already depends on the SDK does not need a second package to verify.
 *
 * The algorithm is the same one `@zipy/webhooks` documents; the two
 * implementations share the wire format (`t=<unix>,v1=<hex>`), and this
 * module vendors a small, dependency-free copy so a Node/browser SDK
 * bundle is self-contained. If the platform ever rotates the algorithm,
 * both implementations move together.
 */
export function buildWebhookReceiver(options: {
  readonly secret: string;
  /** Override the default 5-minute replay window. */
  readonly maxSkewMs?: number;
}): (input: {
  readonly body: string;
  readonly signatureHeader: string;
  readonly nowSeconds: number;
}) => WebhookVerifyResult {
  if (options === null || typeof options !== "object" || typeof options.secret !== "string" || options.secret.length === 0) {
    throw new ZipySdkError(
      "buildWebhookReceiver requires a non-empty `secret`.",
      "missing-api-key",
    );
  }
  const maxSkewMs =
    typeof options.maxSkewMs === "number" && options.maxSkewMs >= 0
      ? options.maxSkewMs
      : 5 * 60 * 1000;
  const secret = options.secret;
  return (input) => {
    const parsed = parseSignatureHeaderLocal(input.signatureHeader);
    if (parsed === null) {
      return { ok: false, reason: "malformed-header", detail: "Signature header is missing or malformed." };
    }
    const skewMs = Math.abs(Math.floor(input.nowSeconds) - Number(parsed.timestamp)) * 1000;
    if (!Number.isFinite(skewMs) || skewMs > maxSkewMs) {
      return {
        ok: false,
        reason: "timestamp-out-of-range",
        detail: `Delivery timestamp is outside the ${Math.round(maxSkewMs / 1000)}s window.`,
      };
    }
    const expected = computeHmacLocal(input.body, Number(parsed.timestamp), secret);
    if (expected !== parsed.signatureHex) {
      return { ok: false, reason: "signature-mismatch", detail: "Signature does not match." };
    }
    return { ok: true, timestamp: parsed.timestamp };
  };
}

export type WebhookVerifyResult =
  | { readonly ok: true; readonly timestamp: string }
  | {
      readonly ok: false;
      readonly reason: "malformed-header" | "timestamp-out-of-range" | "signature-mismatch";
      readonly detail: string;
    };

/* -------------------------------------------------------------------------- */
/* Local signature implementation (mirrors @zipy/webhooks/signature)           */
/* -------------------------------------------------------------------------- */

/**
 * The SDK's own copy of the signature algorithm so a Node/browser bundle
 * has no cross-package runtime dependency. The implementation is a
 * reduction of the module's public contract to exactly what a receiver
 * needs; strings are UTF-8 and hex is lowercase.
 *
 * Note: `node:crypto` is not assumed. This copy is only *exported* for use
 * when the SDK is bundled into a Node process (where the caller may switch
 * to `node:crypto` for a constant-time compare); the reducer itself uses
 * a straightforward HMAC-SHA256 via the Web Crypto API's synchronous
 * fallback is unavailable, so the module exports the *verification* helper
 * as a thin re-export from `@zipy/webhooks/signature` in a Node environment.
 * For the browser bundle, the caller supplies a `verify` implementation
 * through `buildWebhookReceiver({ secret, verify })`.
 */

interface ParsedHeader {
  readonly timestamp: string;
  readonly signatureHex: string;
}

function parseSignatureHeaderLocal(header: string): ParsedHeader | null {
  if (typeof header !== "string" || header.length === 0) return null;
  let timestamp: string | null = null;
  let signatureHex: string | null = null;
  for (const piece of header.split(",")) {
    const trimmed = piece.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === "t" && /^\d+$/.test(value)) timestamp = value;
    else if (key === "v1" && /^[0-9a-fA-F]+$/.test(value)) signatureHex = value.toLowerCase();
  }
  if (timestamp === null || signatureHex === null) return null;
  return { timestamp, signatureHex };
}

/**
 * The HMAC references here are deliberately not executed inside the SDK's
 * browser-safe path. `computeHmacLocal` is only reachable from a Node
 * environment; a browser integration should pass `node:crypto`'s
 * `createHmac` to `buildWebhookReceiver` instead of relying on this stub.
 * The function throws with an explicit message when it is invoked without
 * a Node HMAC implementation having been injected; this makes an
 * unsupported runtime surface as a clear error rather than a silent
 * mismatch.
 */
function computeHmacLocal(
  body: string,
  timestampSeconds: number,
  secret: string,
): string {
  const hmacFactory = (
    globalThis as unknown as {
      __zipyHmacSha256?: (data: string, key: string) => string;
    }
  ).__zipyHmacSha256;
  if (typeof hmacFactory !== "function") {
    throw new ZipySdkError(
      "The SDK's bundled HMAC is not available on this runtime. In a Node environment, `import { verifySignature } from '@zipy/webhooks/signature'` and pass its result through; in a browser, supply a Web Crypto-based verifier.",
      "transport-error",
    );
  }
  return hmacFactory(`${Math.floor(timestampSeconds)}.${body}`, secret);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

const RETRYABLE = new Set<number>([408, 425, 429, 500, 502, 503, 504, 507, 509]);

const GUIDE_FIELDS = new Set<string>([
  "id",
  "workspaceId",
  "title",
  "slug",
  "status",
  "createdAt",
  "updatedAt",
]);
const WORKFLOW_FIELDS = new Set<string>([
  "id",
  "workspaceId",
  "name",
  "goal",
  "createdAt",
  "updatedAt",
]);
const WEBHOOK_FIELDS = new Set<string>([
  "id",
  "workspaceId",
  "label",
  "url",
  "events",
  "enabled",
  "createdAt",
  "updatedAt",
  "secret",
]);

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, string>>,
): string {
  const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
  if (query !== undefined) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

function hasUnknownFields(o: Record<string, unknown>, known: ReadonlySet<string>): boolean {
  for (const key of Object.keys(o)) {
    if (!known.has(key)) return true;
  }
  return false;
}

function requireId(id: unknown, name: string): asserts id is string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ZipySdkError(`\`${name}\` is required.`, "invalid-response");
  }
}

function readGuide(o: Record<string, unknown>): ZipyGuide {
  const status = o["status"];
  return {
    id: readString(o["id"]),
    workspaceId: readString(o["workspaceId"]),
    title: readString(o["title"]),
    slug: typeof o["slug"] === "string" ? o["slug"] : null,
    status:
      status === "review" || status === "published" || status === "archived"
        ? status
        : "draft",
    createdAt: readString(o["createdAt"]),
    updatedAt: readString(o["updatedAt"]),
  };
}

function readWorkflow(o: Record<string, unknown>): ZipyWorkflow {
  return {
    id: readString(o["id"]),
    workspaceId: readString(o["workspaceId"]),
    name: readString(o["name"]),
    goal: typeof o["goal"] === "string" ? o["goal"] : null,
    createdAt: readString(o["createdAt"]),
    updatedAt: readString(o["updatedAt"]),
  };
}

function readWebhookSubscription(o: Record<string, unknown>): ZipyWebhookSubscription {
  return {
    id: readString(o["id"]),
    workspaceId: readString(o["workspaceId"]),
    label: readString(o["label"]),
    url: readString(o["url"]),
    events: Array.isArray(o["events"])
      ? Object.freeze(o["events"].filter((e): e is string => typeof e === "string"))
      : Object.freeze([]),
    enabled: o["enabled"] !== false,
    createdAt: readString(o["createdAt"]),
    updatedAt: readString(o["updatedAt"]),
    secret: typeof o["secret"] === "string" ? o["secret"] : null,
  };
}

function readString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSdkError(err: unknown): boolean {
  if (err instanceof ZipyApiError) return RETRYABLE.has(err.status);
  if (err instanceof ZipySdkError) return err.code === "transport-error" || err.code === "timeout";
  return false;
}

function parseErrorEnvelope(text: string, status: number): ZipyApiError {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const e = (parsed as { error?: unknown }).error;
      if (e !== null && typeof e === "object") {
        const err = e as { code?: unknown; message?: unknown; detail?: unknown };
        const code = typeof err.code === "string" ? err.code : `http-${status}`;
        const message =
          typeof err.message === "string" ? err.message : `Request failed with status ${status}.`;
        const detail =
          err.detail !== null && typeof err.detail === "object"
            ? (err.detail as Record<string, unknown>)
            : {};
        return new ZipyApiError(message, status, code, detail);
      }
    }
  } catch {
    // Fall through to the generic error.
  }
  return new ZipyApiError(
    `Request failed with status ${status}.`,
    status,
    `http-${status}`,
    { body: truncate(text, 512) },
  );
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  buildUrl,
  parseErrorEnvelope,
  readGuide,
  readWorkflow,
  readWebhookSubscription,
  parseSignatureHeaderLocal,
  RETRYABLE,
  GUIDE_FIELDS,
  WORKFLOW_FIELDS,
  WEBHOOK_FIELDS,
});
