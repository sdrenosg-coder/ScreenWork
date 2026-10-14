/**
 * Zipy AI — provider-agnostic LLM adapter.
 *
 * Single choke point for every text/vision generation call in the platform so
 * that provider selection, fallback chains, retries, timeouts, caching, cost
 * accounting and prompt versioning live in exactly one module.
 *
 * Design rules honoured here:
 *  - No provider is assumed to be pre-provisioned. A call to `generate()` when
 *    no provider (hosted key OR local base URL) is configured throws a
 *    descriptive `LlmConfigError`; it never silently returns an empty string
 *    or a fabricated answer.
 *  - Hosted providers (OpenAI, Anthropic, Gemini) are reachable only when the
 *    operator supplies an API key. Local providers (Ollama, vLLM) are
 *    reachable only when a base URL is supplied. Both are read through
 *    `@/lib/config` — the adapter never reads `process.env` directly except to
 *    accept a per-call override key (BYO-key path).
 *  - Deterministic fallback chain: the caller can pass `provider`, otherwise
 *    `config.llm.defaultProvider`, then `config.llm.fallbackChain`. The first
 *    provider that is *configured* wins; a provider whose HTTP call fails with
 *    a retryable error is retried up to `config.llm.maxRetries`, then the next
 *    provider in the chain is attempted.
 *  - Output caching is content-addressed on (provider, model, prompt hash,
 *    temperature). The cache never stores a provider error, only a success.
 *  - Cost accounting records tokens + estimated USD on every call. Prices are
 *    read from a table keyed by provider/model prefix; an unknown model records
 *    a null price rather than a guessed number.
 *
 * What is NOT implemented here: fine-tuning, streaming, tool calls, function
 * calling, image generation and moderation. Those belong to later phases. The
 * adapter's job is a synchronous, single-shot, text-in/text-out (optionally
 * with image attachments) call.
 */

import { createHash } from "node:crypto";

import { getConfig, type LlmProvider } from "@/lib/config";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** Raised when no LLM provider is configured — nothing to call. */
export class LlmConfigError extends Error {
  public readonly code = "llm_config_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** Raised when a provider responded but the response shape was unusable. */
export class LlmResponseError extends Error {
  public readonly code = "llm_response_error" as const;
  public readonly provider: LlmProvider;
  public readonly status: number | null;
  constructor(provider: LlmProvider, message: string, status: number | null) {
    super(message);
    this.name = "LlmResponseError";
    this.provider = provider;
    this.status = status;
  }
}

/** Raised when every provider in the chain failed. Carries the per-provider reasons. */
export class LlmChainError extends Error {
  public readonly code = "llm_chain_error" as const;
  public readonly attempts: readonly { provider: LlmProvider; error: string }[];
  constructor(attempts: readonly { provider: LlmProvider; error: string }[]) {
    super(
      `Every configured LLM provider failed: ${attempts
        .map((a) => `${a.provider}: ${a.error}`)
        .join("; ")}`,
    );
    this.name = "LlmChainError";
    this.attempts = attempts;
  }
}

/* -------------------------------------------------------------------------- */
/* Request / response types                                                    */
/* -------------------------------------------------------------------------- */

export interface LlmImageAttachment {
  /** MIME type, e.g. "image/png". */
  readonly mediaType: string;
  /** Raw bytes of the image (not base64 — the adapter encodes). */
  readonly bytes: Buffer;
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  /**
   * Optional images attached to this message. Only honoured when the selected
   * provider supports vision; a vision-incapable provider throws a
   * `LlmResponseError` with a clear message rather than dropping the images.
   */
  readonly images?: readonly LlmImageAttachment[];
}

export interface LlmGenerateRequest {
  readonly messages: readonly LlmMessage[];
  /** Override the provider for this call. */
  readonly provider?: LlmProvider;
  /** Override the model for this call. */
  readonly model?: string;
  /** Determinism: 0 is greedy. Defaults to 0.2 (light sampling). */
  readonly temperature?: number;
  /** Upper bound on tokens to emit. Defaults to 2048. */
  readonly maxTokens?: number;
  /** When true, respect any cached response. Defaults to true. */
  readonly useCache?: boolean;
  /**
   * Caller-supplied API key (BYO-key path). When present for a hosted provider
   * this supersedes the server-configured key for this call only. Never logged.
   */
  readonly apiKeyOverride?: string;
  /**
   * Prompt version identifier for call attribution (see promptVersions.ts).
   * Recorded on the cost entry, never sent to the provider.
   */
  readonly promptVersionId?: string;
  /** End-to-end deadline in ms for the whole chain. Defaults to 90_000. */
  readonly deadlineMs?: number;
}

export interface LlmUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface LlmGenerateResult {
  readonly text: string;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly usage: LlmUsage;
  /** Estimated cost in USD, or null when the model price is unknown. */
  readonly costUsd: number | null;
  /** True when served from the cache. */
  readonly cached: boolean;
  /** Provenance for the caller: which provider in the chain answered. */
  readonly chainIndex: number;
  /** Present when the caller passed `promptVersionId`. */
  readonly promptVersionId: string | null;
  /** All providers that were attempted before this one succeeded, in order. */
  readonly preAttempts: readonly {
    provider: LlmProvider;
    error: string;
  }[];
}

/* -------------------------------------------------------------------------- */
/* Per-provider capabilities + price table                                     */
/* -------------------------------------------------------------------------- */

interface ProviderBehaviour {
  readonly supportsVision: boolean;
  readonly defaultModel: string;
  /** Some providers need an explicit path; most use a base URL. */
  readonly defaultBaseUrl: string | null;
}

const PROVIDER_BEHAVIOUR: Readonly<Record<LlmProvider, ProviderBehaviour>> =
  Object.freeze({
    openai: {
      supportsVision: true,
      defaultModel: "gpt-4o-mini",
      defaultBaseUrl: "https://api.openai.com/v1",
    },
    anthropic: {
      supportsVision: true,
      defaultModel: "claude-3-5-sonnet-latest",
      defaultBaseUrl: "https://api.anthropic.com/v1",
    },
    gemini: {
      supportsVision: true,
      defaultModel: "gemini-1.5-flash",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    },
    ollama: {
      supportsVision: false,
      defaultModel: "llama3.1:8b-instruct",
      defaultBaseUrl: null,
    },
    vllm: {
      supportsVision: false,
      defaultModel: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      defaultBaseUrl: null,
    },
  });

/**
 * Prices in USD per 1 000 tokens. Kept deliberately small and explicit: a
 * model that is not present here records `costUsd: null` rather than a
 * plausible-looking fabricated number. Operators can extend this via
 * `LLM_PRICE_TABLE_JSON` (parsed as `{ "<provider>/<modelPrefix>":
 * { in: <usd per 1k>, out: <usd per 1k> } }`) without a code change.
 */
const DEFAULT_PRICE_TABLE: Readonly<
  Record<string, { readonly in: number; readonly out: number }>
> = Object.freeze({
  "openai/gpt-4o-mini": { in: 0.00015, out: 0.0006 },
  "openai/gpt-4o": { in: 0.0025, out: 0.01 },
  "anthropic/claude-3-5-sonnet": { in: 0.003, out: 0.015 },
  "anthropic/claude-3-haiku": { in: 0.00025, out: 0.00125 },
  "gemini/gemini-1.5-flash": { in: 0.000075, out: 0.0003 },
  "gemini/gemini-1.5-pro": { in: 0.00125, out: 0.005 },
  // Local models are free at the API boundary; the operator pays for compute
  // out-of-band (GPU rental / on-prem). Recording 0 is honest and lets usage
  // reports combine local and hosted without special-casing null.
  "ollama/*": { in: 0, out: 0 },
  "vllm/*": { in: 0, out: 0 },
});

let priceTableCache: Readonly<
  Record<string, { readonly in: number; readonly out: number }>
> | null = null;

function priceTable(): Readonly<
  Record<string, { readonly in: number; readonly out: number }>
> {
  if (priceTableCache !== null) return priceTableCache;
  const raw = process.env["LLM_PRICE_TABLE_JSON"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, { in: number; out: number }> = {
          ...DEFAULT_PRICE_TABLE,
        };
        for (const [key, value] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (
            value !== null &&
            typeof value === "object" &&
            typeof (value as { in?: unknown }).in === "number" &&
            typeof (value as { out?: unknown }).out === "number"
          ) {
            out[key] = {
              in: (value as { in: number }).in,
              out: (value as { out: number }).out,
            };
          }
        }
        priceTableCache = Object.freeze(out);
        return priceTableCache;
      }
    } catch {
      /* fall through to the built-in table */
    }
  }
  priceTableCache = DEFAULT_PRICE_TABLE;
  return priceTableCache;
}

function lookupPrice(
  provider: LlmProvider,
  model: string,
): { readonly in: number; readonly out: number } | null {
  const table = priceTable();
  // Exact match wins, then longest-prefix match, then wildcard vendor match.
  const exact = table[`${provider}/${model}`];
  if (exact !== undefined) return exact;
  let bestKey: string | null = null;
  for (const key of Object.keys(table)) {
    if (!key.startsWith(`${provider}/`)) continue;
    const suffix = key.slice(provider.length + 1);
    if (!suffix.endsWith("*")) continue;
    const prefix = suffix.slice(0, -1);
    if (model.startsWith(prefix)) {
      if (bestKey === null || prefix.length > bestKey.length) {
        bestKey = prefix;
      }
    }
  }
  if (bestKey !== null) return table[`${provider}/${bestKey}*`] ?? null;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Output cache (in-process LRU)                                               */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  readonly result: Omit<LlmGenerateResult, "cached" | "preAttempts" | "chainIndex">;
  readonly insertedAt: number;
}

const CACHE_MAX_ENTRIES = 512;
const CACHE_TTL_MS = 15 * 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKeyFor(
  provider: LlmProvider,
  model: string,
  req: LlmGenerateRequest,
): string {
  const h = createHash("sha256");
  h.update(provider);
  h.update("\u0000");
  h.update(model);
  h.update("\u0000");
  h.update(String(req.temperature ?? 0.2));
  h.update("\u0000");
  h.update(String(req.maxTokens ?? 2048));
  for (const m of req.messages) {
    h.update("\u0001");
    h.update(m.role);
    h.update("\u0002");
    h.update(m.content);
    if (m.images !== undefined) {
      for (const img of m.images) {
        h.update("\u0003");
        h.update(img.mediaType);
        h.update("\u0004");
        h.update(img.bytes);
      }
    }
  }
  return h.digest("hex");
}

function cacheGet(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (entry === undefined) return null;
  if (Date.now() - entry.insertedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // touch LRU order
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

/** Reset the in-process cache — used by tests. */
export function resetLlmCacheForTests(): void {
  cache.clear();
  priceTableCache = null;
}

/* -------------------------------------------------------------------------- */
/* Cost meter (in-process accumulator; persistence belongs to a later phase)   */
/* -------------------------------------------------------------------------- */

export interface LlmCostEntry {
  readonly recordedAt: string;
  readonly workspaceId: string | null;
  readonly userId: string | null;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly cached: boolean;
  readonly promptVersionId: string | null;
  readonly chainIndex: number;
}

const costLog: LlmCostEntry[] = [];
const COST_LOG_MAX = 10_000;

export interface LlmCallContext {
  readonly workspaceId?: string | null;
  readonly userId?: string | null;
}

function recordCost(
  entry: LlmCostEntry,
  ctx: LlmCallContext | undefined,
): void {
  const withContext: LlmCostEntry = {
    ...entry,
    workspaceId: ctx?.workspaceId ?? entry.workspaceId,
    userId: ctx?.userId ?? entry.userId,
  };
  costLog.push(withContext);
  if (costLog.length > COST_LOG_MAX) costLog.splice(0, costLog.length - COST_LOG_MAX);
}

/** Snapshot the accumulated call log. The persistence layer (later phase) reads this. */
export function llmCostLog(): readonly LlmCostEntry[] {
  return [...costLog];
}

/** Clear the cost log — tests only. */
export function resetLlmCostLogForTests(): void {
  costLog.length = 0;
}

/* -------------------------------------------------------------------------- */
/* Provider configuration gate                                                 */
/* -------------------------------------------------------------------------- */

interface ResolvedProvider {
  readonly provider: LlmProvider;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string | null;
}

function resolveProvider(
  provider: LlmProvider,
  requestModel: string | undefined,
  requestKey: string | undefined,
): ResolvedProvider | null {
  const config = getConfig();
  const behaviour = PROVIDER_BEHAVIOUR[provider];
  const cfg = config.llm.providers[provider];

  const keyFromConfig = cfg.apiKey;
  const apiKey = requestKey ?? keyFromConfig;

  // Hosted providers require a key. Local providers require a base URL.
  if (provider === "openai" || provider === "anthropic" || provider === "gemini") {
    if (apiKey === null || apiKey.length === 0) return null;
  } else {
    // ollama / vllm
    if (cfg.baseUrl === null || cfg.baseUrl.length === 0) return null;
  }

  const baseUrl =
    cfg.baseUrl ?? behaviour.defaultBaseUrl;
  if (baseUrl === null) return null;

  const model =
    requestModel ??
    cfg.model ??
    behaviour.defaultModel;

  return { provider, baseUrl, model, apiKey: apiKey ?? null };
}

/**
 * Determine the ordered list of providers to attempt. Priority:
 *   1. explicit `request.provider`
 *   2. `config.llm.defaultProvider`
 *   3. `config.llm.fallbackChain` (in order)
 * Duplicates are removed while preserving order.
 */
function providerOrder(request: LlmGenerateRequest): readonly LlmProvider[] {
  const config = getConfig();
  const ordered: LlmProvider[] = [];
  const push = (p: LlmProvider | null | undefined): void => {
    if (p === null || p === undefined) return;
    if (!ordered.includes(p)) ordered.push(p);
  };
  push(request.provider ?? undefined);
  push(config.llm.defaultProvider);
  for (const p of config.llm.fallbackChain) push(p);
  return ordered;
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                                */
/* -------------------------------------------------------------------------- */

interface FetchOutcome {
  readonly ok: true;
  readonly text: string;
  readonly usage: LlmUsage;
  readonly model: string;
}
interface FetchFailure {
  readonly ok: false;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly message: string;
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* OpenAI (also the shape used by vLLM's OpenAI-compatible server)             */
/* -------------------------------------------------------------------------- */

function encodeOpenAiContent(
  msg: LlmMessage,
  supportsVision: boolean,
): unknown {
  if (msg.images === undefined || msg.images.length === 0) {
    return msg.content;
  }
  if (!supportsVision) {
    throw new LlmResponseError(
      "openai",
      `Provider selected does not support images but ${msg.images.length} were attached. Configure a vision-capable model or remove the attachments.`,
      null,
    );
  }
  const parts: unknown[] = [];
  if (msg.content.length > 0) {
    parts.push({ type: "text", text: msg.content });
  }
  for (const img of msg.images) {
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${img.mediaType};base64,${img.bytes.toString("base64")}`,
      },
    });
  }
  return parts;
}

async function callOpenAiCompatible(
  resolved: ResolvedProvider,
  req: LlmGenerateRequest,
  timeoutMs: number,
  supportsVision: boolean,
  extraHeaders: Record<string, string> = {},
): Promise<FetchOutcome | FetchFailure> {
  const body = {
    model: resolved.model,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: encodeOpenAiContent(m, supportsVision),
    })),
    temperature: req.temperature ?? 0.2,
    max_tokens: req.maxTokens ?? 2048,
    stream: false,
  };
  let response: Response;
  try {
    response = await timedFetch(
      `${resolved.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(resolved.apiKey !== null
            ? { authorization: `Bearer ${resolved.apiKey}` }
            : {}),
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      status: null,
      message: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    const text = await safeText(response);
    return {
      ok: false,
      retryable: RETRYABLE_STATUSES.has(response.status),
      status: response.status,
      message: `${response.status} ${response.statusText}: ${text.slice(0, 400)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response was not valid JSON",
    };
  }
  const choice = (
    parsed as {
      choices?: readonly { message?: { content?: unknown } }[];
    }
  ).choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== "string") {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response did not include choices[0].message.content",
    };
  }
  const usage = (parsed as { usage?: Record<string, unknown> }).usage ?? {};
  return {
    ok: true,
    text,
    model:
      typeof (parsed as { model?: unknown }).model === "string"
        ? ((parsed as { model: string }).model)
        : resolved.model,
    usage: {
      promptTokens: asNumberOrNull(usage["prompt_tokens"]),
      completionTokens: asNumberOrNull(usage["completion_tokens"]),
      totalTokens: asNumberOrNull(usage["total_tokens"]),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Anthropic /v1/messages                                                      */
/* -------------------------------------------------------------------------- */

async function callAnthropic(
  resolved: ResolvedProvider,
  req: LlmGenerateRequest,
  timeoutMs: number,
): Promise<FetchOutcome | FetchFailure> {
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const convo = req.messages.filter((m) => m.role !== "system");
  const system =
    systemMessages.map((m) => m.content).join("\n\n").trim() || undefined;

  const body = {
    model: resolved.model,
    max_tokens: req.maxTokens ?? 2048,
    temperature: req.temperature ?? 0.2,
    system,
    messages: convo.map((m) => {
      if (m.images === undefined || m.images.length === 0) {
        return { role: m.role, content: m.content };
      }
      const parts: unknown[] = [];
      if (m.content.length > 0) parts.push({ type: "text", text: m.content });
      for (const img of m.images) {
        parts.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.bytes.toString("base64"),
          },
        });
      }
      return { role: m.role, content: parts };
    }),
  };
  let response: Response;
  try {
    response = await timedFetch(
      `${resolved.baseUrl.replace(/\/+$/, "")}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(resolved.apiKey !== null
            ? { "x-api-key": resolved.apiKey }
            : {}),
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      status: null,
      message: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    const text = await safeText(response);
    return {
      ok: false,
      retryable: RETRYABLE_STATUSES.has(response.status),
      status: response.status,
      message: `${response.status} ${response.statusText}: ${text.slice(0, 400)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response was not valid JSON",
    };
  }
  const content = (parsed as { content?: readonly { type?: unknown; text?: unknown }[] }).content;
  if (!Array.isArray(content)) {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response did not include a content array",
    };
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  if (textParts.length === 0) {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response contained no text block",
    };
  }
  const usage = (parsed as { usage?: Record<string, unknown> }).usage ?? {};
  const promptTokens = asNumberOrNull(usage["input_tokens"]);
  const completionTokens = asNumberOrNull(usage["output_tokens"]);
  return {
    ok: true,
    text: textParts.join(""),
    model:
      typeof (parsed as { model?: unknown }).model === "string"
        ? ((parsed as { model: string }).model)
        : resolved.model,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens:
        promptTokens !== null && completionTokens !== null
          ? promptTokens + completionTokens
          : null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Gemini generateContent                                                      */
/* -------------------------------------------------------------------------- */

async function callGemini(
  resolved: ResolvedProvider,
  req: LlmGenerateRequest,
  timeoutMs: number,
): Promise<FetchOutcome | FetchFailure> {
  if (resolved.apiKey === null) {
    return {
      ok: false,
      retryable: false,
      status: null,
      message: "Gemini requires an API key",
    };
  }
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const contents = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const parts: unknown[] = [];
      if (m.content.length > 0) parts.push({ text: m.content });
      if (m.images !== undefined) {
        for (const img of m.images) {
          parts.push({
            inline_data: {
              mime_type: img.mediaType,
              data: img.bytes.toString("base64"),
            },
          });
        }
      }
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts,
      };
    });

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: req.temperature ?? 0.2,
      maxOutputTokens: req.maxTokens ?? 2048,
    },
  };
  if (systemMessages.length > 0) {
    body["systemInstruction"] = {
      parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
    };
  }

  const url =
    `${resolved.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(resolved.model)}:generateContent` +
    `?key=${encodeURIComponent(resolved.apiKey)}`;

  let response: Response;
  try {
    response = await timedFetch(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      status: null,
      message: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    const text = await safeText(response);
    return {
      ok: false,
      retryable: RETRYABLE_STATUSES.has(response.status),
      status: response.status,
      message: `${response.status} ${response.statusText}: ${text.slice(0, 400)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response was not valid JSON",
    };
  }
  const candidates = (parsed as { candidates?: readonly unknown[] }).candidates;
  const first = Array.isArray(candidates) ? (candidates[0] as { content?: { parts?: readonly { text?: unknown }[] } }) : undefined;
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response did not include candidates[0].content.parts",
    };
  }
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
  if (text.length === 0) {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response contained no text parts",
    };
  }
  const usageMeta =
    (parsed as { usageMetadata?: Record<string, unknown> }).usageMetadata ?? {};
  const promptTokens = asNumberOrNull(usageMeta["promptTokenCount"]);
  const completionTokens = asNumberOrNull(usageMeta["candidatesTokenCount"]);
  return {
    ok: true,
    text,
    model: resolved.model,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens:
        asNumberOrNull(usageMeta["totalTokenCount"]) ??
        (promptTokens !== null && completionTokens !== null
          ? promptTokens + completionTokens
          : null),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Ollama /api/chat (also the shape used by some vLLM deployments)             */
/* -------------------------------------------------------------------------- */

async function callOllama(
  resolved: ResolvedProvider,
  req: LlmGenerateRequest,
  timeoutMs: number,
): Promise<FetchOutcome | FetchFailure> {
  const body = {
    model: resolved.model,
    stream: false,
    options: {
      temperature: req.temperature ?? 0.2,
      num_predict: req.maxTokens ?? 2048,
    },
    messages: req.messages.map((m) => {
      if (m.images === undefined || m.images.length === 0) {
        return { role: m.role, content: m.content };
      }
      // Ollama's image support takes base64 strings in an `images` array
      // alongside the message.
      return {
        role: m.role,
        content: m.content,
        images: m.images.map((img) => img.bytes.toString("base64")),
      };
    }),
  };
  let response: Response;
  try {
    response = await timedFetch(
      `${resolved.baseUrl.replace(/\/+$/, "")}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      status: null,
      message: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    const text = await safeText(response);
    return {
      ok: false,
      retryable: RETRYABLE_STATUSES.has(response.status),
      status: response.status,
      message: `${response.status} ${response.statusText}: ${text.slice(0, 400)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response was not valid JSON",
    };
  }
  const message = (parsed as { message?: { content?: unknown } }).message;
  const text = message?.content;
  if (typeof text !== "string") {
    return {
      ok: false,
      retryable: false,
      status: response.status,
      message: "response did not include message.content",
    };
  }
  // Ollama reports token counts in prompt_eval_count / eval_count.
  const promptTokens = asNumberOrNull(
    (parsed as { prompt_eval_count?: unknown }).prompt_eval_count,
  );
  const completionTokens = asNumberOrNull(
    (parsed as { eval_count?: unknown }).eval_count,
  );
  return {
    ok: true,
    text,
    model: resolved.model,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens:
        promptTokens !== null && completionTokens !== null
          ? promptTokens + completionTokens
          : null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Provider dispatch                                                           */
/* -------------------------------------------------------------------------- */

async function callProvider(
  provider: LlmProvider,
  requestModel: string | undefined,
  req: LlmGenerateRequest,
  timeoutMs: number,
  requestKey: string | undefined,
): Promise<FetchOutcome | FetchFailure> {
  const resolved = resolveProvider(provider, requestModel, requestKey);
  if (resolved === null) {
    return {
      ok: false,
      retryable: false,
      status: null,
      message: "provider is not configured (missing API key or base URL)",
    };
  }
  switch (provider) {
    case "openai":
      return callOpenAiCompatible(resolved, req, timeoutMs, true);
    case "vllm":
      return callOpenAiCompatible(resolved, req, timeoutMs, false);
    case "anthropic":
      return callAnthropic(resolved, req, timeoutMs);
    case "gemini":
      return callGemini(resolved, req, timeoutMs);
    case "ollama":
      return callOllama(resolved, req, timeoutMs);
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Execute a single-shot generation, respecting the configured fallback chain.
 * Returns a structured result; throws `LlmConfigError` when nothing is
 * configured, `LlmChainError` when every attempt failed.
 */
export async function generate(
  req: LlmGenerateRequest,
  ctx?: LlmCallContext,
): Promise<LlmGenerateResult> {
  const config = getConfig();
  const order = providerOrder(req);
  if (order.length === 0) {
    throw new LlmConfigError(
      "No LLM provider is configured. Set LLM_DEFAULT_PROVIDER plus a provider credential " +
        "(OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY) or a local base URL " +
        "(OLLAMA_BASE_URL / VLLM_BASE_URL). Zipy AI will not fabricate a response without a provider.",
    );
  }

  const useCache = req.useCache !== false;
  const deadlineMs = req.deadlineMs ?? 90_000;
  const deadline = Date.now() + deadlineMs;
  const attempts: { provider: LlmProvider; error: string }[] = [];

  for (let i = 0; i < order.length; i += 1) {
    const provider = order[i]!;
    const resolved = resolveProvider(provider, req.model, req.apiKeyOverride);

    // Cache lookup is provider-scoped so a hosted/fallback split cannot
    // serve a cached response under a different provider's name.
    if (useCache && resolved !== null) {
      const key = cacheKeyFor(provider, resolved.model, req);
      const cached = cacheGet(key);
      if (cached !== null) {
        recordCost(
          {
            recordedAt: new Date().toISOString(),
            workspaceId: null,
            userId: null,
            provider,
            model: resolved.model,
            promptTokens: cached.result.usage.promptTokens,
            completionTokens: cached.result.usage.completionTokens,
            totalTokens: cached.result.usage.totalTokens,
            costUsd: 0,
            cached: true,
            promptVersionId: cached.result.promptVersionId,
            chainIndex: i,
          },
          ctx,
        );
        return {
          ...cached.result,
          cached: true,
          chainIndex: i,
          preAttempts: attempts,
        };
      }
    }

    // Per-attempt timeout is whatever remains in the deadline, at most the
    // configured request timeout.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      attempts.push({ provider, error: "deadline exceeded before attempt" });
      break;
    }
    const attemptTimeout = Math.min(
      remaining,
      config.llm.requestTimeoutMs,
    );

    // Try each provider up to `maxRetries + 1` times, retrying only on
    // retryable failures (5xx / 429 / network), never on 4xx validation.
    const maxAttempts = config.llm.maxRetries + 1;
    let lastFailure: FetchFailure | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (Date.now() >= deadline) {
        lastFailure = {
          ok: false,
          retryable: true,
          status: null,
          message: "deadline exceeded",
        };
        break;
      }
      const outcome = await callProvider(
        provider,
        req.model,
        req,
        attemptTimeout,
        req.apiKeyOverride,
      );
      if (outcome.ok) {
        const price = lookupPrice(provider, outcome.model);
        const cost =
          price !== null &&
          outcome.usage.promptTokens !== null &&
          outcome.usage.completionTokens !== null
            ? (outcome.usage.promptTokens / 1000) * price.in +
              (outcome.usage.completionTokens / 1000) * price.out
            : null;

        const result: LlmGenerateResult = {
          text: outcome.text,
          provider,
          model: outcome.model,
          usage: outcome.usage,
          costUsd: cost,
          cached: false,
          chainIndex: i,
          promptVersionId: req.promptVersionId ?? null,
          preAttempts: attempts,
        };

        if (useCache) {
          cacheSet(cacheKeyFor(provider, outcome.model, req), {
            result: {
              text: result.text,
              provider: result.provider,
              model: result.model,
              usage: result.usage,
              costUsd: result.costUsd,
              promptVersionId: result.promptVersionId,
            },
            insertedAt: Date.now(),
          });
        }

        recordCost(
          {
            recordedAt: new Date().toISOString(),
            workspaceId: null,
            userId: null,
            provider,
            model: outcome.model,
            promptTokens: outcome.usage.promptTokens,
            completionTokens: outcome.usage.completionTokens,
            totalTokens: outcome.usage.totalTokens,
            costUsd: cost,
            cached: false,
            promptVersionId: req.promptVersionId ?? null,
            chainIndex: i,
          },
          ctx,
        );

        return result;
      }

      lastFailure = outcome;
      if (!outcome.retryable || attempt === maxAttempts - 1) break;
      // Exponential backoff, capped at 2s.
      const backoff = Math.min(2_000, 250 * 2 ** attempt);
      await sleep(backoff);
    }

    attempts.push({
      provider,
      error: lastFailure?.message ?? "unknown error",
    });
  }

  throw new LlmChainError(attempts);
}

/**
 * Convenience: single-message generate. Kept separate so callers that only
 * send one system + one user message do not have to build the array. This is
 * a thin wrapper and does not do anything `generate()` does not.
 */
export async function generateText(
  args: {
    readonly system?: string;
    readonly prompt: string;
    readonly images?: readonly LlmImageAttachment[];
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly provider?: LlmProvider;
    readonly model?: string;
    readonly promptVersionId?: string;
    readonly apiKeyOverride?: string;
  },
  ctx?: LlmCallContext,
): Promise<LlmGenerateResult> {
  const messages: LlmMessage[] = [];
  if (args.system !== undefined && args.system.length > 0) {
    messages.push({ role: "system", content: args.system });
  }
  messages.push({
    role: "user",
    content: args.prompt,
    ...(args.images !== undefined && args.images.length > 0
      ? { images: args.images }
      : {}),
  });
  const request: LlmGenerateRequest = {
    messages,
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    ...(args.promptVersionId !== undefined
      ? { promptVersionId: args.promptVersionId }
      : {}),
    ...(args.apiKeyOverride !== undefined
      ? { apiKeyOverride: args.apiKeyOverride }
      : {}),
  };
  return generate(request, ctx);
}

/**
 * Ask the adapter which providers are configured right now. Used by the
 * synthesize route to fail fast with a crisp 503 rather than letting the
 * worker discover the misconfiguration later.
 */
export function describeConfiguredProviders(): {
  readonly configured: readonly LlmProvider[];
  readonly defaultProvider: LlmProvider | null;
  readonly fallbackChain: readonly LlmProvider[];
} {
  const config = getConfig();
  const all: readonly LlmProvider[] = [
    "openai",
    "anthropic",
    "gemini",
    "ollama",
    "vllm",
  ];
  const configured: LlmProvider[] = [];
  for (const p of all) {
    if (resolveProvider(p, undefined, undefined) !== null) configured.push(p);
  }
  return {
    configured,
    defaultProvider: config.llm.defaultProvider,
    fallbackChain: config.llm.fallbackChain,
  };
}
