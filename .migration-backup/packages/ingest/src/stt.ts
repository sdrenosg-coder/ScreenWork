/**
 * Zipy AI — Speech-to-text adapter (STT).
 *
 * A single, provider-honest STT surface used by the audio/video ingestion
 * paths. It performs real transcription when an operator has configured a
 * local or remote STT service, and it *refuses* rather than fabricating a
 * transcript when nothing is configured.
 *
 * Recognised engines (from `config.processing.stt.engine`):
 *   - "whisper-local"  → an OpenAI-compatible /v1/audio/transcriptions HTTP
 *                        service (whisper.cpp `server`, faster-whisper's
 *                        `/v1/audio/transcriptions`, or any OpenAI-compatible
 *                        local deployment).
 *   - "whisper-cpp"    → a whisper.cpp build invoked as a subprocess. Only the
 *                        binary path + model path from env are used; the raw
 *                        output JSON is parsed to segments.
 *   - "cloud"          → an OpenAI-compatible hosted endpoint (openai,
 *                        groq, together, …). An API key must be present.
 *   - "none"           → not configured. `transcribe` throws.
 *
 * The returned `SttResult` is JSON-serializable end-to-end: no Buffers leak,
 * no functions, and every segment carries a start/end time in seconds so the
 * downstream alignment step (transcript ↔ video frames ↔ UI regions) can be
 * performed without re-decoding the media.
 *
 * This module is *not* the diarization module. Speaker attribution requires a
 * separate model (pyannote, NeMo, WhisperX) and lives in `diarization.ts`.
 * The two modules compose: `transcribe` first, then `diarize`. When no
 * diarization engine is configured, `diarization.ts` explicitly reports
 * `"attribution": "none"` — it never invents speaker labels.
 *
 * Design notes honoured here:
 *  - No credentials are invented. Every remote call reads keys from the
 *    environment through `@zipy/...` config helpers and fails with a precise
 *    `SttError` when absent.
 *  - No media is stored as a *result*. The caller owns the media bytes; this
 *    module only returns text + timestamps.
 *  - The `durationSeconds` field is computed from segment ends when the
 *    underlying engine did not report a total. If no segment end exists, it
 *    is `null` — never a guess.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type SttEngine = "whisper-local" | "whisper-cpp" | "cloud" | "none";

export type SttErrorCode =
  | "invalid-input"
  | "engine-not-configured"
  | "api-key-missing"
  | "service-unreachable"
  | "binary-missing"
  | "model-missing"
  | "engine-failure"
  | "malformed-response"
  | "timeout";

export class SttError extends Error {
  readonly code: SttErrorCode;
  constructor(message: string, code: SttErrorCode) {
    super(message);
    this.name = "SttError";
    this.code = code;
  }
}

/** A single transcribed span with absolute start/end times in seconds. */
export interface SttSegment {
  /** Zero-based ordinal within the transcript. */
  readonly ordinal: number;
  /** Start time in seconds from the beginning of the media. */
  readonly start: number;
  /** End time in seconds from the beginning of the media. */
  readonly end: number;
  /** Trimmed transcript text for this segment. */
  readonly text: string;
  /**
   * Per-segment confidence when the engine reports one (whisper.cpp does via
   * `-oj`; the OpenAI-compatible API does not). `null` means the engine did
   * not produce a confidence score — the value is *not* defaulted.
   */
  readonly confidence: number | null;
}

export interface SttResult {
  /** Engine that produced the transcript. */
  readonly engine: Exclude<SttEngine, "none">;
  /** Language code as reported by the engine, e.g. "en". `null` if unknown. */
  readonly language: string | null;
  /** Concatenated full transcript text with a newline between segments. */
  readonly text: string;
  /** Segments in chronological order. */
  readonly segments: readonly SttSegment[];
  /** Duration in seconds when derivable; otherwise null (never fabricated). */
  readonly durationSeconds: number | null;
  /** Word count across all segments — convenience for cost/metrics. */
  readonly wordCount: number;
  /** Model identifier as reported by the engine, or the passed model name. */
  readonly model: string | null;
  /** ISO timestamp when the transcription completed. */
  readonly capturedAt: string;
  readonly durationMs: number;
}

export interface SttOptions {
  /** Absolute or relative path to a media file (mp3, wav, mp4, m4a, …). */
  readonly inputPath: string;
  /** Optional MIME type for the HTTP engines; inferred from extension if absent. */
  readonly mimeType?: string;
  /**
   * Language hint (ISO 639-1). When omitted, the engine will auto-detect on
   * models that support it. The value is passed through unchanged.
   */
  readonly language?: string;
  /**
   * Override the configured engine. Normally the caller lets the config decide;
   * this exists so the worker can honour per-job overrides without touching
   * process env.
   */
  readonly engine?: SttEngine;
  /**
   * Override the service URL (HTTP engines) or the binary path (whisper-cpp).
   */
  readonly serviceUrl?: string;
  /** Hard timeout for the whole transcription (ms). Default 15 min. */
  readonly timeoutMs?: number;
  /** Model identifier. Defaults to whatever the environment specifies. */
  readonly model?: string;
}

/* -------------------------------------------------------------------------- */
/* Environment config reading                                                  */
/* -------------------------------------------------------------------------- */

interface ResolvedSttConfig {
  readonly engine: SttEngine;
  readonly serviceUrl: string | null;
  readonly binaryPath: string | null;
  readonly modelPath: string | null;
  readonly model: string | null;
  readonly apiKey: string | null;
  readonly language: string | null;
  readonly timeoutMs: number;
}

/**
 * Read STT settings straight from process.env. This is deliberately *not*
 * routed through `@zipy/web` — the worker must not depend on the web app's
 * config module. The env names are documented in `docs/operations/external-setup.md`.
 */
function resolveConfig(options: SttOptions): ResolvedSttConfig {
  const engineRaw =
    options.engine ??
    envString("STT_ENGINE") ??
    "none";
  const engine: SttEngine =
    engineRaw === "whisper-local" ||
    engineRaw === "whisper-cpp" ||
    engineRaw === "cloud"
      ? engineRaw
      : "none";

  const serviceUrl =
    options.serviceUrl ??
    envString("STT_SERVICE_URL") ??
    null;

  const binaryPath = envString("WHISPER_CPP_BINARY") ?? null;
  const modelPath = envString("WHISPER_CPP_MODEL") ?? null;
  const model = options.model ?? envString("STT_MODEL") ?? null;
  const apiKey =
    envString("STT_API_KEY") ??
    envString("OPENAI_API_KEY") ??
    null;
  const language = options.language ?? envString("STT_LANGUAGE") ?? null;
  const timeoutMs = options.timeoutMs ?? envInt("STT_TIMEOUT_MS", 15 * 60_000);

  return {
    engine,
    serviceUrl,
    binaryPath,
    modelPath,
    model,
    apiKey,
    language,
    timeoutMs,
  };
}

function envString(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/* -------------------------------------------------------------------------- */
/* MIME inference                                                              */
/* -------------------------------------------------------------------------- */

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".webm": "audio/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

function inferMime(inputPath: string): string {
  const ext = path.extname(inputPath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/* -------------------------------------------------------------------------- */
/* HTTP engine (whisper-local, cloud)                                          */
/* -------------------------------------------------------------------------- */

interface HttpSttOptions {
  readonly serviceUrl: string;
  readonly apiKey: string | null;
  readonly model: string | null;
  readonly language: string | null;
  readonly mimeType: string;
  readonly filename: string;
  readonly timeoutMs: number;
  readonly bytes: Buffer;
}

/**
 * POST a multipart/form-data request to an OpenAI-compatible transcription
 * endpoint. Node 20's global `FormData` + `Blob` handle the multipart body
 * without a dependency. The response contract we accept:
 *
 *   { "text": "…",
 *     "language": "en",
 *     "segments": [ { "start": 0.0, "end": 2.3, "text": "…" } ] }
 *
 * `segments` is present on whisper.cpp's `/v1/audio/transcriptions` but *not*
 * on the plain OpenAI endpoint, which returns only `text`. When segments are
 * absent we emit one covering segment spanning the reported duration or the
 * inferred audio duration from ffprobe (see `probeDurationSeconds`).
 */
async function transcribeViaHttp(
  opts: HttpSttOptions,
): Promise<{
  readonly text: string;
  readonly language: string | null;
  readonly segments: readonly SttSegment[];
  readonly model: string | null;
}> {
  const base = opts.serviceUrl.replace(/\/+$/, "");
  const endpoint = base.endsWith("/v1")
    ? `${base}/audio/transcriptions`
    : `${base}/v1/audio/transcriptions`;

  const form = new FormData();
  // `Uint8Array` (a view of the Buffer) is accepted as a BlobPart everywhere
  // in Node 20's global Blob implementation; we pass a fresh copy to avoid
  // slicing surprises when the caller keeps mutating the original Buffer.
  const bytesCopy = new Uint8Array(opts.bytes.byteLength);
  bytesCopy.set(opts.bytes);
  form.append(
    "file",
    new Blob([bytesCopy], { type: opts.mimeType }),
    opts.filename,
  );
  if (opts.model !== null) form.append("model", opts.model);
  if (opts.language !== null) form.append("language", opts.language);
  form.append("response_format", "verbose_json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response: Response;
  try {
    const headers: Record<string, string> = {};
    if (opts.apiKey !== null) headers["authorization"] = `Bearer ${opts.apiKey}`;
    response = await fetch(endpoint, {
      method: "POST",
      body: form,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new SttError(
        `STT request timed out after ${opts.timeoutMs}ms.`,
        "timeout",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new SttError(
      `STT service at ${endpoint} is unreachable: ${message}`,
      "service-unreachable",
    );
  }
  clearTimeout(timer);

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      /* ignore */
    }
    const trimmed = detail.length > 800 ? `${detail.slice(0, 800)}…` : detail;
    throw new SttError(
      `STT service returned HTTP ${response.status}: ${trimmed || response.statusText}`,
      response.status === 401 || response.status === 403
        ? "api-key-missing"
        : "engine-failure",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SttError(
      `STT response was not valid JSON: ${message}`,
      "malformed-response",
    );
  }

  if (payload === null || typeof payload !== "object") {
    throw new SttError(
      "STT response was not an object.",
      "malformed-response",
    );
  }
  const obj = payload as Record<string, unknown>;
  const text = typeof obj["text"] === "string" ? (obj["text"] as string) : "";
  if (text.length === 0 && !Array.isArray(obj["segments"])) {
    throw new SttError(
      "STT response contained neither `text` nor `segments`.",
      "malformed-response",
    );
  }
  const language =
    typeof obj["language"] === "string" ? (obj["language"] as string) : null;
  const model =
    typeof obj["model"] === "string" ? (obj["model"] as string) : opts.model;

  const rawSegments = Array.isArray(obj["segments"])
    ? (obj["segments"] as unknown[])
    : [];
  const segments: SttSegment[] = [];
  for (let i = 0; i < rawSegments.length; i += 1) {
    const raw = rawSegments[i];
    if (raw === null || typeof raw !== "object") continue;
    const seg = raw as Record<string, unknown>;
    const start = numberOrNull(seg["start"]);
    const end = numberOrNull(seg["end"]);
    const segText = typeof seg["text"] === "string" ? (seg["text"] as string).trim() : "";
    if (start === null || end === null || segText.length === 0) continue;
    segments.push({
      ordinal: segments.length,
      start,
      end,
      text: segText,
      confidence: null,
    });
  }

  return { text, language, segments, model: model ?? null };
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* whisper.cpp subprocess engine                                               */
/* -------------------------------------------------------------------------- */

interface WhisperCppOptions {
  readonly binaryPath: string;
  readonly modelPath: string;
  readonly language: string | null;
  readonly inputPath: string;
  readonly timeoutMs: number;
}

/**
 * Run `whisper-cli` (or `main`) and ask for JSON output. We invoke with `-oj`
 * and read the JSON file from a temp directory so we do not have to parse
 * stdout formats across whisper.cpp versions. The temp directory is removed
 * on both success and failure.
 *
 * Supported flag forms vary slightly across whisper.cpp releases; we use the
 * minimal, stable set:
 *   -m <model>   model file
 *   -f <input>   input audio/video (whisper.cpp shells out to ffmpeg)
 *   -oj          emit JSON
 *   -of <out>    output file stem (no extension)
 *   -l <lang>    optional language code
 */
async function transcribeViaWhisperCpp(
  opts: WhisperCppOptions,
): Promise<{
  readonly text: string;
  readonly language: string | null;
  readonly segments: readonly SttSegment[];
  readonly model: string | null;
}> {
  await access(opts.binaryPath).catch(() => {
    throw new SttError(
      `whisper.cpp binary is not accessible at ${opts.binaryPath}. Set WHISPER_CPP_BINARY to a valid path.`,
      "binary-missing",
    );
  });
  await access(opts.modelPath).catch(() => {
    throw new SttError(
      `whisper.cpp model file is not accessible at ${opts.modelPath}. Set WHISPER_CPP_MODEL to a valid path.`,
      "model-missing",
    );
  });

  const tmp = await mkdtemp(path.join(tmpdir(), "zipy-stt-"));
  const outStem = path.join(tmp, "out");
  try {
    const args: string[] = [
      "-m",
      opts.modelPath,
      "-f",
      opts.inputPath,
      "-oj",
      "-of",
      outStem,
    ];
    if (opts.language !== null) {
      args.push("-l", opts.language);
    }

    await runSubprocess(opts.binaryPath, args, opts.timeoutMs);

    const jsonPath = `${outStem}.json`;
    if (!existsSync(jsonPath)) {
      throw new SttError(
        `whisper.cpp did not produce ${jsonPath}. The binary exited 0 but no JSON output was found; this usually means the invoked binary is not whisper.cpp or the argument form is unsupported by this version.`,
        "engine-failure",
      );
    }
    let parsed: unknown;
    try {
      const raw = await readFile(jsonPath, "utf8");
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SttError(
        `whisper.cpp JSON output at ${jsonPath} could not be read or parsed: ${message}`,
        "malformed-response",
      );
    }
    return parseWhisperCppJson(parsed);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
}

function runSubprocess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      // Cap captured stderr so a chatterbox binary cannot blow memory.
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    // Drain stdout; some whisper.cpp builds print progress there.
    child.stdout.on("data", () => {
      /* drained; output read from the JSON file */
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new SttError(
          `whisper.cpp timed out after ${timeoutMs}ms. Last stderr: ${stderr.slice(-400)}`,
          "timeout",
        ),
      );
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new SttError(
          `Failed to spawn whisper.cpp binary "${command}": ${err.message}`,
          "binary-missing",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new SttError(
          `whisper.cpp exited with code ${code ?? "null"}. ${stderr.slice(-800)}`,
          "engine-failure",
        ),
      );
    });
  });
}

/**
 * whisper.cpp `-oj` output shape:
 *   {
 *     "systeminfo": "...",
 *     "model": { "type": "...", "multilingual": true, ... },
 *     "params":  { "language": "en", ... },
 *     "result":  { "language": "en" },
 *     "transcription": [ { "timestamps": { "from": "00:00:00,000",
 *                                          "to":   "00:00:02,340" },
 *                          "offsets":   { "from": 0, "to": 2340 },
 *                          "text": "Hello…" } ]
 *   }
 *
 * `offsets` are milliseconds. Some versions also include `confidence`.
 */
function parseWhisperCppJson(parsed: unknown): {
  readonly text: string;
  readonly language: string | null;
  readonly segments: readonly SttSegment[];
  readonly model: string | null;
} {
  if (parsed === null || typeof parsed !== "object") {
    throw new SttError(
      "whisper.cpp JSON output was not an object.",
      "malformed-response",
    );
  }
  const root = parsed as Record<string, unknown>;
  const result = isRecord(root["result"]) ? root["result"] : null;
  const params = isRecord(root["params"]) ? root["params"] : null;
  const modelObj = isRecord(root["model"]) ? root["model"] : null;

  const language =
    (result !== null && typeof result["language"] === "string"
      ? (result["language"] as string)
      : null) ??
    (params !== null && typeof params["language"] === "string"
      ? (params["language"] as string)
      : null);

  const modelName =
    modelObj !== null && typeof modelObj["type"] === "string"
      ? (modelObj["type"] as string)
      : null;

  const transcription = Array.isArray(root["transcription"])
    ? (root["transcription"] as unknown[])
    : [];
  const segments: SttSegment[] = [];
  for (const raw of transcription) {
    if (!isRecord(raw)) continue;
    const text = typeof raw["text"] === "string" ? (raw["text"] as string).trim() : "";
    if (text.length === 0) continue;
    const offsets = isRecord(raw["offsets"]) ? raw["offsets"] : null;
    let start: number | null = null;
    let end: number | null = null;
    if (offsets !== null) {
      const fromMs = numberOrNull(offsets["from"]);
      const toMs = numberOrNull(offsets["to"]);
      if (fromMs !== null) start = fromMs / 1000;
      if (toMs !== null) end = toMs / 1000;
    }
    if (start === null || end === null) {
      const ts = isRecord(raw["timestamps"]) ? raw["timestamps"] : null;
      if (ts !== null) {
        const from = typeof ts["from"] === "string" ? ts["from"] : null;
        const to = typeof ts["to"] === "string" ? ts["to"] : null;
        if (from !== null) start = parseHmsMs(from);
        if (to !== null) end = parseHmsMs(to);
      }
    }
    if (start === null || end === null) continue;
    const confidence = numberOrNull(raw["confidence"]);
    segments.push({
      ordinal: segments.length,
      start,
      end,
      text,
      confidence,
    });
  }

  const text = segments.map((s) => s.text).join("\n");
  return { text, language, segments, model: modelName };
}

function parseHmsMs(value: string): number | null {
  // Accept "HH:MM:SS,mmm" / "HH:MM:SS.mmm" / "MM:SS.mmm".
  const normalised = value.replace(",", ".");
  const parts = normalised.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [mm, ss] = nums as [number, number];
    return mm * 60 + ss;
  }
  const [hh, mm, ss] = nums as [number, number, number];
  return hh * 3600 + mm * 60 + ss;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/* -------------------------------------------------------------------------- */
/* Duration probing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Probe duration using `ffprobe` when available. This is best-effort: when
 * ffprobe is missing we return `null` rather than guessing. Duration is only
 * used to synthesise a single covering segment for engines that omit
 * per-segment timings (the plain OpenAI endpoint), and callers that never see
 * a covering segment do not need it at all.
 */
async function probeDurationSeconds(
  inputPath: string,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const stdout = await captureStdout(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        inputPath,
      ],
      timeoutMs,
    );
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function captureStdout(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr}`));
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Transcribe a media file. Throws `SttError` when no engine is configured or
 * the engine reports a failure. The caller is responsible for reconciling the
 * returned transcript with other ingestion sources.
 */
export async function transcribe(options: SttOptions): Promise<SttResult> {
  const started = Date.now();
  const inputPath = options.inputPath;
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new SttError(
      "transcribe requires a non-empty inputPath.",
      "invalid-input",
    );
  }
  const config = resolveConfig(options);
  if (config.engine === "none") {
    throw new SttError(
      "No speech-to-text engine is configured. Set STT_ENGINE to \"whisper-local\", " +
        "\"whisper-cpp\" or \"cloud\" and supply the corresponding service URL, binary " +
        "path or API key. Zipy AI refuses to fabricate a transcript.",
      "engine-not-configured",
    );
  }

  const bytes = await readFile(inputPath).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new SttError(
      `Could not read media file at ${inputPath}: ${message}`,
      "invalid-input",
    );
  });
  if (bytes.length === 0) {
    throw new SttError(
      `Media file at ${inputPath} is empty.`,
      "invalid-input",
    );
  }
  const mimeType = options.mimeType ?? inferMime(inputPath);
  const filename = path.basename(inputPath);

  let raw: {
    readonly text: string;
    readonly language: string | null;
    readonly segments: readonly SttSegment[];
    readonly model: string | null;
  };

  if (config.engine === "whisper-cpp") {
    if (config.binaryPath === null || config.modelPath === null) {
      throw new SttError(
        "STT_ENGINE=whisper-cpp requires WHISPER_CPP_BINARY and WHISPER_CPP_MODEL to be set.",
        "engine-not-configured",
      );
    }
    raw = await transcribeViaWhisperCpp({
      binaryPath: config.binaryPath,
      modelPath: config.modelPath,
      language: config.language,
      inputPath,
      timeoutMs: config.timeoutMs,
    });
  } else {
    // whisper-local and cloud both speak the OpenAI-compatible form.
    if (config.serviceUrl === null) {
      throw new SttError(
        `STT_ENGINE=${config.engine} requires STT_SERVICE_URL to be set.`,
        "engine-not-configured",
      );
    }
    if (config.engine === "cloud" && config.apiKey === null) {
      throw new SttError(
        "STT_ENGINE=cloud requires STT_API_KEY (or OPENAI_API_KEY) to be set. " +
          "Zipy AI never sends unauthenticated requests to a hosted STT provider.",
        "api-key-missing",
      );
    }
    raw = await transcribeViaHttp({
      serviceUrl: config.serviceUrl,
      apiKey: config.apiKey,
      model: config.model,
      language: config.language,
      mimeType,
      filename,
      timeoutMs: config.timeoutMs,
      bytes,
    });
  }

  // Normalise segments: some engines omit segment timings entirely. When
  // segments are missing we try to build one covering segment from ffprobe.
  let segments = raw.segments;
  if (segments.length === 0 && raw.text.length > 0) {
    const duration = await probeDurationSeconds(inputPath, 15_000);
    if (duration !== null) {
      segments = [
        {
          ordinal: 0,
          start: 0,
          end: duration,
          text: raw.text.trim(),
          confidence: null,
        },
      ];
    }
  }

  const text = raw.text.length > 0 ? raw.text : segments.map((s) => s.text).join("\n");
  const wordCount = countWords(text);
  const durationSeconds =
    segments.length > 0
      ? Math.max(...segments.map((s) => s.end))
      : await probeDurationSeconds(inputPath, 15_000);

  return {
    engine: config.engine,
    language: raw.language,
    text,
    segments,
    durationSeconds,
    wordCount,
    model: raw.model,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // Unicode-aware split on whitespace runs; conservative word count.
  return trimmed.split(/\s+/u).length;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export interface RehydratedSttResult {
  readonly engine: SttResult["engine"];
  readonly language: string | null;
  readonly text: string;
  readonly segments: readonly SttSegment[];
  readonly durationSeconds: number | null;
  readonly wordCount: number;
  readonly model: string | null;
  readonly capturedAt: string;
}

/**
 * Read a persisted `SttResult` back. Throws `SttError` with code
 * `"malformed-response"` on payloads that are not recognisable.
 */
export function rehydrateSttResult(value: unknown): RehydratedSttResult {
  if (value === null || typeof value !== "object") {
    throw new SttError(
      "Rehydrate failed: payload is not an object.",
      "malformed-response",
    );
  }
  const r = value as Record<string, unknown>;
  const engineRaw = r["engine"];
  if (
    engineRaw !== "whisper-local" &&
    engineRaw !== "whisper-cpp" &&
    engineRaw !== "cloud"
  ) {
    throw new SttError(
      "Rehydrate failed: engine is missing or unrecognised.",
      "malformed-response",
    );
  }
  const segmentsRaw = Array.isArray(r["segments"]) ? (r["segments"] as unknown[]) : [];
  const segments: SttSegment[] = [];
  for (const segRaw of segmentsRaw) {
    if (segRaw === null || typeof segRaw !== "object") continue;
    const s = segRaw as Record<string, unknown>;
    const start = numberOrNull(s["start"]);
    const end = numberOrNull(s["end"]);
    const text = typeof s["text"] === "string" ? (s["text"] as string) : "";
    if (start === null || end === null || text.length === 0) continue;
    segments.push({
      ordinal: typeof s["ordinal"] === "number" ? (s["ordinal"] as number) : segments.length,
      start,
      end,
      text,
      confidence: numberOrNull(s["confidence"]),
    });
  }
  return {
    engine: engineRaw,
    language: typeof r["language"] === "string" ? (r["language"] as string) : null,
    text: typeof r["text"] === "string" ? (r["text"] as string) : "",
    segments,
    durationSeconds: numberOrNull(r["durationSeconds"]),
    wordCount:
      typeof r["wordCount"] === "number" && Number.isFinite(r["wordCount"] as number)
        ? (r["wordCount"] as number)
        : countWords(typeof r["text"] === "string" ? (r["text"] as string) : ""),
    model: typeof r["model"] === "string" ? (r["model"] as string) : null,
    capturedAt: typeof r["capturedAt"] === "string" ? (r["capturedAt"] as string) : "",
  };
}
