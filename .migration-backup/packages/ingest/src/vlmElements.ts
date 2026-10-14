/**
 * Zipy AI — vision-language-model UI element recognition.
 *
 * Given an image buffer (or path) and the raw OCR output for the same image,
 * asks a vision-language model to identify interactive UI elements (buttons,
 * inputs, dropdowns, tabs, menus, links, checkboxes) with bounding boxes and a
 * short, human-readable label. The output is normalised to a shape that
 * mirrors `IndexedElement` so downstream synthesis and annotation phases can
 * consume it without a translation step.
 *
 * Backing LLM providers (provider-agnostic; no provider is assumed
 * pre-provisioned):
 *   - OpenAI Vision   (OPENAI_API_KEY)
 *   - Anthropic Claude (ANTHROPIC_API_KEY)
 *   - Google Gemini    (GEMINI_API_KEY / GOOGLE_API_KEY)
 *   - Local Ollama     (OLLAMA_BASE_URL + OLLAMA_VISION_MODEL)
 *   - Local vLLM       (VLLM_BASE_URL + VLLM_VISION_MODEL)
 *
 * The active provider is chosen by `VLM_PROVIDER` when set, otherwise the
 * first provider in the configured list is used. When none is configured this
 * module throws `VlmError` with `code: "provider-unavailable"` rather than
 * fabricating elements — the worker job fails and the user sees the reason.
 *
 * Design notes:
 *  - Prompts are versioned (`PROMPT_VERSION`) so results are attributable to a
 *    specific prompt shape; this is a precondition for the A/B and
 *    regression-testing work in later phases.
 *  - Responses are validated against a strict schema before leaving this
 *    module. Any element with an unparseable or out-of-range box is dropped
 *    (not clamped silently) and the count of dropped items is surfaced on the
 *    result so a caller can decide whether the run is usable.
 *  - The ref assigned to each element follows the same `computeStableRef`
 *    agreement used by DOM ingestion (role + slug + ordinal). It is not
 *    guaranteed to be stable if the model labels an element differently across
 *    runs; callers that need cross-run identity must deduplicate on
 *    (role, slug) before hashing.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { computeStableRef, slugifyName } from "./stableRefs.ts";
import type { OcrResult } from "./ocr.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class VlmError extends Error {
  readonly code:
    | "provider-unavailable"
    | "invalid-input"
    | "request-failed"
    | "bad-response"
    | "internal";
  constructor(message: string, code: VlmError["code"]) {
    super(message);
    this.name = "VlmError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type VlmProvider = "openai" | "anthropic" | "gemini" | "ollama" | "vllm";

export type UiElementKind =
  | "button"
  | "link"
  | "textbox"
  | "combobox"
  | "checkbox"
  | "radio"
  | "switch"
  | "tab"
  | "menuitem"
  | "option"
  | "slider"
  | "datepicker"
  | "icon"
  | "other";

export interface BBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RecognizedElement {
  /** Stable ref in the `stableRefs` format, e.g. `button-save`, `textbox-email-2`. */
  readonly ref: string;
  /** UI element category. */
  readonly kind: UiElementKind;
  /** The raw ARIA-ish role the model reported (lowercased). */
  readonly rawRole: string;
  /** Human-readable label. Empty when the model indicated no label. */
  readonly label: string;
  /** Bounding box in image pixel coordinates (top-left origin). */
  readonly bbox: BBox;
  /** 0..1 model-reported confidence, or null when the model did not provide one. */
  readonly confidence: number | null;
  /** Free-form states the model reported, e.g. { disabled: true, focused: false }. */
  readonly states: Readonly<Record<string, string | number | boolean>>;
}

export interface VlmResult {
  /** Which provider actually served the request. */
  readonly provider: VlmProvider;
  /** Model identifier as the provider reported it (best effort). */
  readonly model: string | null;
  /**
   * Prompt version used. Bumping it invalidates cache keys downstream.
   */
  readonly promptVersion: string;
  /** Ordered top-to-bottom, left-to-right by bbox.y then bbox.x. */
  readonly elements: readonly RecognizedElement[];
  /** Image width declared by the model, when it returned one. */
  readonly width: number | null;
  /** Image height declared by the model, when it returned one. */
  readonly height: number | null;
  /** Number of interactive elements the model returned. */
  readonly elementCount: number;
  /** Number of elements the parser rejected. */
  readonly droppedCount: number;
  /** Wall-clock duration of the VLM round-trip, ms. */
  readonly durationMs: number;
  /** ISO timestamp of completion. */
  readonly completedAt: string;
}

export interface RecognizeOptions {
  /** Explicit provider override. Otherwise `VLM_PROVIDER` or first configured. */
  readonly provider?: VlmProvider;
  /** Explicit model id override. Otherwise per-provider env vars / defaults. */
  readonly model?: string | null;
  /** Hard timeout for the request. Defaults to `VLM_TIMEOUT_MS` / 90s. */
  readonly timeoutMs?: number;
  /**
   * Optional image path. When supplied the file is read from disk; otherwise
   * `input` must be a Buffer.
   */
  readonly inputPath?: string | null;
  /** MIME type of the image. Defaults to `image/png`. */
  readonly mimeType?: string;
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                      */
/* -------------------------------------------------------------------------- */

export const PROMPT_VERSION = "vlm-elements/2024-11-01";

const SYSTEM_PROMPT = `You are a meticulous UI element extractor.
Given a single screenshot together with the OCR text regions that belong to it,
identify every *interactive* UI element visible in the screenshot. Focus on
buttons, links, text inputs, dropdowns/selects, checkboxes, radio buttons,
switches, tabs, menu items, and date pickers. Do not return decorative icons or
plain headings unless they are clearly interactive (e.g. a heading-styled
"Save" link).

Return STRICT JSON in this exact shape and nothing else:
{
  "width": <integer image width in pixels>,
  "height": <integer image height in pixels>,
  "elements": [
    {
      "role": "<one of: button, link, textbox, combobox, checkbox, radio, switch, tab, menuitem, option, slider, datepicker, icon, other>",
      "label": "<short human-readable label>",
      "bbox": { "x": <int>, "y": <int>, "width": <int>, "height": <int> },
      "confidence": <number between 0 and 1>,
      "states": { "<key>": <string|number|boolean> }
    }
  ]
}

Rules:
- Bounding boxes MUST be in the screenshot's pixel coordinate system with a
  top-left origin.
- Coordinates MUST be inside the image bounds; do not emit boxes that go past
  the edges.
- If you are not confident about a region, still include it but set
  "confidence" below 0.5.
- Do not invent elements. If you cannot identify any interactive element,
  return an empty "elements" array.
- Do not include any prose, commentary, or markdown fences. JSON only.`;

function buildUserPrompt(ocr: OcrResult | null): string {
  if (ocr === null || ocr.regions.length === 0) {
    return "No OCR text regions were supplied for this image. Identify interactive UI elements from the image alone.";
  }
  // Cap OCR lines so the prompt stays bounded even on very text-dense images.
  const max = 120;
  const lines: string[] = [];
  for (let i = 0; i < ocr.regions.length && i < max; i += 1) {
    const r = ocr.regions[i];
    if (r === undefined) continue;
    const conf = r.confidence === null ? "" : ` conf=${r.confidence.toFixed(2)}`;
    lines.push(
      `- text=${JSON.stringify(r.text.slice(0, 160))} x=${r.bbox.x} y=${r.bbox.y} w=${r.bbox.width} h=${r.bbox.height}${conf}`,
    );
  }
  const more = ocr.regions.length > max ? `\n(…${ocr.regions.length - max} more regions omitted)` : "";
  return `OCR text regions on the image (source: ${ocr.engine}):\n${lines.join("\n")}${more}\n\nNow return the strict JSON described in the system message.`;
}

/* -------------------------------------------------------------------------- */
/* Provider resolution                                                         */
/* -------------------------------------------------------------------------- */

interface ProviderAvailability {
  readonly provider: VlmProvider;
  readonly configured: boolean;
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
}

function providerAvailability(): readonly ProviderAvailability[] {
  const openaiKey = envOrNull("OPENAI_API_KEY");
  const anthropicKey = envOrNull("ANTHROPIC_API_KEY");
  const geminiKey = envOrNull("GEMINI_API_KEY") ?? envOrNull("GOOGLE_API_KEY");
  const ollamaBase = envOrNull("OLLAMA_BASE_URL");
  const vllmBase = envOrNull("VLLM_BASE_URL");
  return [
    {
      provider: "openai",
      configured: openaiKey !== null,
      apiKey: openaiKey,
      baseUrl: envOrNull("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
      model: envOrNull("OPENAI_VISION_MODEL") ?? envOrNull("OPENAI_MODEL") ?? "gpt-4o-mini",
    },
    {
      provider: "anthropic",
      configured: anthropicKey !== null,
      apiKey: anthropicKey,
      baseUrl: envOrNull("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com/v1",
      model: envOrNull("ANTHROPIC_VISION_MODEL") ?? envOrNull("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-latest",
    },
    {
      provider: "gemini",
      configured: geminiKey !== null,
      apiKey: geminiKey,
      baseUrl: envOrNull("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta",
      model: envOrNull("GEMINI_VISION_MODEL") ?? envOrNull("GEMINI_MODEL") ?? "gemini-1.5-flash",
    },
    {
      provider: "ollama",
      configured: ollamaBase !== null,
      apiKey: null,
      baseUrl: ollamaBase,
      model: envOrNull("OLLAMA_VISION_MODEL") ?? "llama3.2-vision",
    },
    {
      provider: "vllm",
      configured: vllmBase !== null,
      apiKey: envOrNull("VLLM_API_KEY"),
      baseUrl: vllmBase,
      model: envOrNull("VLLM_VISION_MODEL"),
    },
  ];
}

function envOrNull(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

function resolveProvider(override: VlmProvider | undefined): ProviderAvailability {
  const avail = providerAvailability();
  if (override !== undefined) {
    const found = avail.find((a) => a.provider === override);
    if (found === undefined || !found.configured) {
      throw new VlmError(
        `Requested VLM provider "${override}" is not configured. Set the corresponding ` +
          `environment variable(s) before retrying.`,
        "provider-unavailable",
      );
    }
    return found;
  }
  const preferred = envOrNull("VLM_PROVIDER");
  if (preferred !== null) {
    const p = preferred.toLowerCase();
    if (p === "openai" || p === "anthropic" || p === "gemini" || p === "ollama" || p === "vllm") {
      return resolveProvider(p);
    }
    throw new VlmError(
      `VLM_PROVIDER="${preferred}" is not a recognised provider. Use one of: openai, anthropic, gemini, ollama, vllm.`,
      "provider-unavailable",
    );
  }
  const first = avail.find((a) => a.configured);
  if (first === undefined) {
    throw new VlmError(
      "No vision-language-model provider is configured. Set one of OPENAI_API_KEY, " +
        "ANTHROPIC_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY), OLLAMA_BASE_URL, " +
        "or VLLM_BASE_URL. Zipy AI does not pre-provision any provider.",
      "provider-unavailable",
    );
  }
  return first;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

interface FetchOutcome {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed, raw };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Provider adapters                                                           */
/* -------------------------------------------------------------------------- */

interface AdapterOutcome {
  readonly rawContent: string;
  readonly model: string | null;
}

async function callOpenAiCompatible(
  avail: ProviderAvailability,
  imageBase64: string,
  mimeType: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<AdapterOutcome> {
  const base = (avail.baseUrl ?? "").replace(/\/+$/, "");
  const model = avail.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    authorization: `Bearer ${avail.apiKey ?? ""}`,
  };
  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
        ],
      },
    ],
    temperature: 0,
  };
  const res = await postJson(`${base}/chat/completions`, headers, body, timeoutMs);
  if (!res.ok) {
    throw new VlmError(
      `VLM provider "${avail.provider}" returned HTTP ${res.status}. Body: ${res.raw.slice(0, 400)}`,
      "request-failed",
    );
  }
  const content = extractOpenAiContent(res.body);
  return { rawContent: content, model };
}

function extractOpenAiContent(body: unknown): string {
  if (body === null || typeof body !== "object") {
    throw new VlmError("OpenAI-compatible response was not a JSON object.", "bad-response");
  }
  const choices = (body as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new VlmError("OpenAI-compatible response contained no choices.", "bad-response");
  }
  const first = choices[0];
  if (first === null || typeof first !== "object") {
    throw new VlmError("OpenAI-compatible first choice was not an object.", "bad-response");
  }
  const message = (first as Record<string, unknown>)["message"];
  if (message === null || typeof message !== "object") {
    throw new VlmError("OpenAI-compatible choice had no message.", "bad-response");
  }
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  // Some providers return content as parts.
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (typeof p["text"] === "string") out += p["text"] as string;
    }
    return out;
  }
  throw new VlmError("OpenAI-compatible message had no textual content.", "bad-response");
}

async function callAnthropic(
  avail: ProviderAvailability,
  imageBase64: string,
  mimeType: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<AdapterOutcome> {
  const base = (avail.baseUrl ?? "").replace(/\/+$/, "");
  const model = avail.model ?? "claude-3-5-sonnet-latest";
  const headers: Record<string, string> = {
    "x-api-key": avail.apiKey ?? "",
    "anthropic-version": "2023-06-01",
  };
  const body = {
    model,
    max_tokens: 4096,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType, data: imageBase64 },
          },
          { type: "text", text: userPrompt },
        ],
      },
    ],
  };
  const res = await postJson(`${base}/messages`, headers, body, timeoutMs);
  if (!res.ok) {
    throw new VlmError(
      `Anthropic returned HTTP ${res.status}. Body: ${res.raw.slice(0, 400)}`,
      "request-failed",
    );
  }
  if (res.body === null || typeof res.body !== "object") {
    throw new VlmError("Anthropic response was not a JSON object.", "bad-response");
  }
  const contentRaw = (res.body as Record<string, unknown>)["content"];
  if (!Array.isArray(contentRaw)) {
    throw new VlmError("Anthropic response had no content array.", "bad-response");
  }
  let out = "";
  for (const part of contentRaw) {
    if (part === null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p["type"] === "text" && typeof p["text"] === "string") {
      out += p["text"] as string;
    }
  }
  return { rawContent: out, model };
}

async function callGemini(
  avail: ProviderAvailability,
  imageBase64: string,
  mimeType: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<AdapterOutcome> {
  const base = (avail.baseUrl ?? "").replace(/\/+$/, "");
  const model = avail.model ?? "gemini-1.5-flash";
  const apiKey = avail.apiKey ?? "";
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: userPrompt },
          { inlineData: { mimeType, data: imageBase64 } },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  };
  const res = await postJson(url, {}, body, timeoutMs);
  if (!res.ok) {
    throw new VlmError(
      `Gemini returned HTTP ${res.status}. Body: ${res.raw.slice(0, 400)}`,
      "request-failed",
    );
  }
  if (res.body === null || typeof res.body !== "object") {
    throw new VlmError("Gemini response was not a JSON object.", "bad-response");
  }
  const candidates = (res.body as Record<string, unknown>)["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new VlmError("Gemini response contained no candidates.", "bad-response");
  }
  const first = candidates[0];
  if (first === null || typeof first !== "object") {
    throw new VlmError("Gemini first candidate was not an object.", "bad-response");
  }
  const content = (first as Record<string, unknown>)["content"];
  if (content === null || typeof content !== "object") {
    throw new VlmError("Gemini candidate had no content.", "bad-response");
  }
  const parts = (content as Record<string, unknown>)["parts"];
  if (!Array.isArray(parts)) {
    throw new VlmError("Gemini content had no parts array.", "bad-response");
  }
  let out = "";
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p["text"] === "string") out += p["text"] as string;
  }
  return { rawContent: out, model };
}

async function callOllama(
  avail: ProviderAvailability,
  imageBase64: string,
  _mimeType: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<AdapterOutcome> {
  const base = (avail.baseUrl ?? "").replace(/\/+$/, "");
  const model = avail.model ?? "llama3.2-vision";
  const headers: Record<string, string> = {};
  if (avail.apiKey !== null) headers["authorization"] = `Bearer ${avail.apiKey}`;
  const body = {
    model,
    stream: false,
    format: "json",
    options: { temperature: 0 },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt, images: [imageBase64] },
    ],
  };
  const res = await postJson(`${base}/api/chat`, headers, body, timeoutMs);
  if (!res.ok) {
    throw new VlmError(
      `Ollama returned HTTP ${res.status}. Body: ${res.raw.slice(0, 400)}`,
      "request-failed",
    );
  }
  if (res.body === null || typeof res.body !== "object") {
    throw new VlmError("Ollama response was not a JSON object.", "bad-response");
  }
  const message = (res.body as Record<string, unknown>)["message"];
  if (message === null || typeof message !== "object") {
    throw new VlmError("Ollama response had no message.", "bad-response");
  }
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content !== "string") {
    throw new VlmError("Ollama message had no textual content.", "bad-response");
  }
  return { rawContent: content, model };
}

async function callVllm(
  avail: ProviderAvailability,
  imageBase64: string,
  mimeType: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<AdapterOutcome> {
  // vLLM's OpenAI-compatible server is the supported surface.
  return callOpenAiCompatible(avail, imageBase64, mimeType, userPrompt, timeoutMs);
}

/* -------------------------------------------------------------------------- */
/* Response parsing                                                            */
/* -------------------------------------------------------------------------- */

interface ParsedResponse {
  readonly width: number | null;
  readonly height: number | null;
  readonly elements: readonly RecognizedElement[];
  readonly dropped: number;
}

const KIND_FROM_ROLE: Readonly<Record<string, UiElementKind>> = {
  button: "button",
  link: "link",
  textbox: "textbox",
  "text field": "textbox",
  textfield: "textbox",
  input: "textbox",
  searchbox: "textbox",
  combobox: "combobox",
  combobox_search: "combobox",
  select: "combobox",
  dropdown: "combobox",
  listbox: "combobox",
  checkbox: "checkbox",
  radio: "radio",
  radiobutton: "radio",
  switch: "switch",
  toggle: "switch",
  tab: "tab",
  menuitem: "menuitem",
  menu: "menuitem",
  option: "option",
  slider: "slider",
  datepicker: "datepicker",
  "date picker": "datepicker",
  icon: "icon",
};

function normalizeKind(rawRole: string): UiElementKind {
  const key = rawRole.toLowerCase().trim();
  const direct = KIND_FROM_ROLE[key];
  if (direct !== undefined) return direct;
  // Try a contains-match, longest-first so "radiobutton" beats "button".
  const keys = Object.keys(KIND_FROM_ROLE).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (key.includes(k)) {
      const v = KIND_FROM_ROLE[k];
      if (v !== undefined) return v;
    }
  }
  return "other";
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseIntegerPair(v: unknown): { x: number; y: number; width: number; height: number } | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const x = coerceNumber(r["x"]);
  const y = coerceNumber(r["y"]);
  const w = coerceNumber(r["width"]);
  const h = coerceNumber(r["height"]);
  if (x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  // Tolerate accidental markdown fences.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/m.exec(trimmed);
  if (fence !== null && typeof fence[1] === "string") return fence[1].trim();
  return trimmed;
}

function parseVlmJson(
  raw: string,
  bounds: { readonly width: number | null; readonly height: number | null },
): ParsedResponse {
  const cleaned = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new VlmError(
      `VLM response was not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `First 200 chars: ${cleaned.slice(0, 200)}`,
      "bad-response",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new VlmError("VLM response JSON was not an object.", "bad-response");
  }
  const root = parsed as Record<string, unknown>;
  const width = coerceNumber(root["width"]);
  const height = coerceNumber(root["height"]);
  const effectiveWidth =
    width !== null ? Math.round(width) : bounds.width;
  const effectiveHeight =
    height !== null ? Math.round(height) : bounds.height;

  const rawElements = Array.isArray(root["elements"]) ? (root["elements"] as unknown[]) : [];
  const preRefs: Omit<RecognizedElement, "ref">[] = [];
  let dropped = 0;

  for (const item of rawElements) {
    if (item === null || typeof item !== "object") {
      dropped += 1;
      continue;
    }
    const r = item as Record<string, unknown>;
    const rawRole = typeof r["role"] === "string" ? (r["role"] as string) : "";
    const kind = normalizeKind(rawRole);
    const label = typeof r["label"] === "string" ? (r["label"] as string).trim() : "";
    const bbox = parseIntegerPair(r["bbox"]);
    if (bbox === null) {
      dropped += 1;
      continue;
    }
    if (effectiveWidth !== null && (bbox.x < 0 || bbox.x + bbox.width > effectiveWidth + 2)) {
      dropped += 1;
      continue;
    }
    if (effectiveHeight !== null && (bbox.y < 0 || bbox.y + bbox.height > effectiveHeight + 2)) {
      dropped += 1;
      continue;
    }
    const conf = coerceNumber(r["confidence"]);
    const confidence =
      conf === null ? null : Math.max(0, Math.min(1, conf));
    const states: Record<string, string | number | boolean> = {};
    if (r["states"] !== null && typeof r["states"] === "object") {
      for (const [k, v] of Object.entries(r["states"] as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          states[k] = v;
        }
      }
    }
    preRefs.push({
      kind,
      rawRole: rawRole.toLowerCase(),
      label,
      bbox,
      confidence,
      states,
    });
  }

  // Assign stable refs in the same scheme used by DOM ingestion.
  const elements: RecognizedElement[] = [];
  for (let i = 0; i < preRefs.length; i += 1) {
    const pre = preRefs[i] as Omit<RecognizedElement, "ref">;
    let sameRoleSameSlugOrdinal = 0;
    let unnamedRoleOrdinal = 0;
    const slug = slugifyName(pre.label);
    for (let j = 0; j <= i; j += 1) {
      const peer = preRefs[j];
      if (peer === undefined) continue;
      if (peer.rawRole !== pre.rawRole) continue;
      if (slug.length > 0) {
        if (peer.label.length > 0 && slugifyName(peer.label) === slug) {
          sameRoleSameSlugOrdinal += 1;
        }
      } else if (peer.label.length === 0) {
        unnamedRoleOrdinal += 1;
      }
    }
    const ref = computeStableRef({
      role: pre.rawRole.length > 0 ? pre.rawRole : pre.kind,
      name: pre.label,
      sameRoleSameSlugOrdinal: Math.max(1, sameRoleSameSlugOrdinal),
      unnamedRoleOrdinal: Math.max(1, unnamedRoleOrdinal),
    });
    elements.push({ ...pre, ref });
  }

  elements.sort((a, b) => {
    if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });

  return {
    width: effectiveWidth,
    height: effectiveHeight,
    elements,
    dropped,
  };
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

export interface RecognizeInput {
  /** Image buffer. */
  readonly image: Buffer;
  /** OCR result for the same image, or null to rely on the model alone. */
  readonly ocr: OcrResult | null;
}

/**
 * Recognise interactive UI elements in an image using a configured
 * vision-language model. Throws `VlmError` when no provider is available or
 * the request/response fails validation.
 */
export async function recognizeUiElements(
  input: RecognizeInput,
  options: RecognizeOptions = {},
): Promise<VlmResult> {
  if (input.image.length === 0) {
    const pathAlt = options.inputPath;
    if (pathAlt === null || pathAlt === undefined || !existsSync(pathAlt)) {
      throw new VlmError(
        "recognizeUiElements requires a non-empty image buffer or a valid inputPath.",
        "invalid-input",
      );
    }
  }

  const avail = resolveProvider(options.provider);
  const timeoutMs = options.timeoutMs ?? readIntEnv("VLM_TIMEOUT_MS", 90_000);
  const mimeType = options.mimeType ?? "image/png";

  // Read the image bytes: prefer the supplied buffer, otherwise load from path.
  let bytes: Buffer = input.image;
  if (bytes.length === 0 && options.inputPath !== null && options.inputPath !== undefined) {
    bytes = await readFile(options.inputPath);
  }
  const imageBase64 = bytes.toString("base64");
  const userPrompt = buildUserPrompt(input.ocr);

  // Allow an explicit model override by cloning the availability object.
  const effective: ProviderAvailability =
    options.model !== undefined
      ? { ...avail, model: options.model }
      : avail;

  const started = Date.now();
  let outcome: AdapterOutcome;
  switch (effective.provider) {
    case "openai":
      outcome = await callOpenAiCompatible(effective, imageBase64, mimeType, userPrompt, timeoutMs);
      break;
    case "anthropic":
      outcome = await callAnthropic(effective, imageBase64, mimeType, userPrompt, timeoutMs);
      break;
    case "gemini":
      outcome = await callGemini(effective, imageBase64, mimeType, userPrompt, timeoutMs);
      break;
    case "ollama":
      outcome = await callOllama(effective, imageBase64, mimeType, userPrompt, timeoutMs);
      break;
    case "vllm":
      outcome = await callVllm(effective, imageBase64, mimeType, userPrompt, timeoutMs);
      break;
  }

  const parsed = parseVlmJson(outcome.rawContent, {
    width: input.ocr?.width ?? null,
    height: input.ocr?.height ?? null,
  });

  return {
    provider: effective.provider,
    model: outcome.model,
    promptVersion: PROMPT_VERSION,
    elements: parsed.elements,
    width: parsed.width,
    height: parsed.height,
    elementCount: parsed.elements.length,
    droppedCount: parsed.dropped,
    durationMs: Date.now() - started,
    completedAt: new Date().toISOString(),
  };
}

function readIntEnv(name: string, fallback: number): number {
  const raw = envOrNull(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Rehydrate a stored `VlmResult`. Throws on malformed payloads.
 */
export function rehydrateVlmResult(value: unknown): VlmResult {
  if (value === null || typeof value !== "object") {
    throw new VlmError("Rehydrate failed: payload is not an object.", "internal");
  }
  const r = value as Record<string, unknown>;
  const provider = r["provider"];
  if (
    provider !== "openai" &&
    provider !== "anthropic" &&
    provider !== "gemini" &&
    provider !== "ollama" &&
    provider !== "vllm"
  ) {
    throw new VlmError("Rehydrate failed: unknown provider.", "internal");
  }
  const rows = Array.isArray(r["elements"]) ? (r["elements"] as unknown[]) : [];
  const elements: RecognizedElement[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const rr = row as Record<string, unknown>;
    const ref = typeof rr["ref"] === "string" ? (rr["ref"] as string) : null;
    const bbox = parseIntegerPair(rr["bbox"]);
    if (ref === null || bbox === null) continue;
    const kindRaw = typeof rr["kind"] === "string" ? (rr["kind"] as string) : "other";
    const validKinds: readonly UiElementKind[] = [
      "button",
      "link",
      "textbox",
      "combobox",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "menuitem",
      "option",
      "slider",
      "datepicker",
      "icon",
      "other",
    ];
    const kind: UiElementKind = (validKinds as readonly string[]).includes(kindRaw)
      ? (kindRaw as UiElementKind)
      : "other";
    const states: Record<string, string | number | boolean> = {};
    if (rr["states"] !== null && typeof rr["states"] === "object") {
      for (const [k, v] of Object.entries(rr["states"] as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          states[k] = v;
        }
      }
    }
    elements.push({
      ref,
      kind,
      rawRole: typeof rr["rawRole"] === "string" ? (rr["rawRole"] as string) : kind,
      label: typeof rr["label"] === "string" ? (rr["label"] as string) : "",
      bbox,
      confidence:
        typeof rr["confidence"] === "number" && Number.isFinite(rr["confidence"] as number)
          ? Math.max(0, Math.min(1, rr["confidence"] as number))
          : null,
      states,
    });
  }
  const width = coerceNumber(r["width"]);
  const height = coerceNumber(r["height"]);
  return {
    provider,
    model: typeof r["model"] === "string" ? (r["model"] as string) : null,
    promptVersion:
      typeof r["promptVersion"] === "string" ? (r["promptVersion"] as string) : PROMPT_VERSION,
    elements,
    width: width === null ? null : Math.round(width),
    height: height === null ? null : Math.round(height),
    elementCount: elements.length,
    droppedCount: typeof r["droppedCount"] === "number" ? (r["droppedCount"] as number) : 0,
    durationMs: typeof r["durationMs"] === "number" ? (r["durationMs"] as number) : 0,
    completedAt: typeof r["completedAt"] === "string" ? (r["completedAt"] as string) : "",
  };
}
