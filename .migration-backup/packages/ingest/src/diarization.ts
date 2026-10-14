/**
 * Zipy AI — Speaker diarization adapter.
 *
 * A provider-honest diarization surface used by the audio/video ingestion
 * paths. It accepts an `SttResult` produced by `@zipy/ingest/stt` and, when a
 * diarization engine is configured, returns segments annotated with a
 * `speaker` label. When no engine is configured, the module returns an
 * explicit `attribution: "none"` result rather than inventing speakers.
 *
 * Recognised engines (from `DIARIZATION_ENGINE`):
 *   - "pyannote"  → a local pyannote.audio HTTP service. The service is
 *                    expected to accept a POST with `{ audio_path | audio_b64 }`
 *                    and return `{ turns: [{ start, end, speaker }] }`. The
 *                    exact endpoint path is inferred from the URL: a URL
 *                    ending in `/diarize` is used as-is, otherwise `/diarize`
 *                    is appended.
 *   - "whisperx"  → a local WhisperX HTTP service exposing the same turn
 *                    schema. WhisperX produces both transcription and
 *                    diarization in one pass; when the caller already has an
 *                    `SttResult`, this module only consumes the `segments`
 *                    field from WhisperX (returns them as turns), aligning
 *                    each Stt segment to the nearest WhisperX turn.
 *   - "none"      → not configured. `diarize` returns an unannotated result
 *                    with `attribution: "none"`.
 *
 * Alignment policy (documented, not invented):
 *   - Each `SttSegment` is assigned the speaker of the diarization turn with
 *     the largest temporal overlap. When a segment overlaps no turn (which
 *     happens when engines disagree about the media duration), the segment
 *     gets `speaker: null`; the module never invents a label.
 *   - Adjacent segments with the same speaker are left untouched. Merging is
 *     a downstream rendering concern, not a data-model concern.
 *
 * Design notes honoured here:
 *  - No credentials are invented. Engine endpoints come from env; missing
 *    config is reported with a precise `DiarizationError`.
 *  - No media is stored. The adapter sends a *path* to the service (the
 *    service must share the filesystem with the worker) or, when
 *    `DIARIZATION_INLINE=true`, the base64-encoded bytes. Both are opt-in.
 *  - `attribution` is one of `"engine"` (real labels from a real engine) or
 *    `"none"` (no engine configured) — never a fabricated middle ground.
 */

import { readFile } from "node:fs/promises";

import type { SttResult, SttSegment } from "@zipy/ingest/stt";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type DiarizationEngine = "pyannote" | "whisperx" | "none";
export type DiarizationAttribution = "engine" | "none";

export type DiarizationErrorCode =
  | "invalid-input"
  | "engine-not-configured"
  | "service-unreachable"
  | "engine-failure"
  | "malformed-response"
  | "timeout";

export class DiarizationError extends Error {
  readonly code: DiarizationErrorCode;
  constructor(message: string, code: DiarizationErrorCode) {
    super(message);
    this.name = "DiarizationError";
    this.code = code;
  }
}

/** A speaker turn reported by the diarization engine. */
export interface SpeakerTurn {
  readonly speaker: string;
  readonly start: number;
  readonly end: number;
}

/** An Stt segment annotated with speaker attribution (or `null` when unlabelled). */
export interface DiarizedSegment {
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly confidence: number | null;
  /** Speaker id as reported by the engine; `null` when no turn overlapped. */
  readonly speaker: string | null;
  /** Fraction of the segment overlapped by the assigned turn (0..1). */
  readonly overlapRatio: number;
}

export interface DiarizationResult {
  /**
   * `"engine"` when a real diarization engine produced labels for at least
   * one segment; `"none"` when no engine was configured.
   */
  readonly attribution: DiarizationAttribution;
  /** The engine that produced the labels. `null` when attribution is `"none"`. */
  readonly engine: DiarizationEngine | null;
  /** The turns as returned by the engine, in chronological order. */
  readonly turns: readonly SpeakerTurn[];
  /** Distinct speaker labels seen in `turns`, in first-appearance order. */
  readonly speakers: readonly string[];
  /** Segments with the `speaker` field populated from `turns` when possible. */
  readonly segments: readonly DiarizedSegment[];
  /** ISO timestamp. */
  readonly capturedAt: string;
  readonly durationMs: number;
}

export interface DiarizeOptions {
  /**
   * Path to the media file the `stt` result was produced from. Required for
   * engine-backed diarization (the service reads it by path or the module
   * reads it for base64 inlining when `inline` is true).
   */
  readonly inputPath: string;
  /** The transcription to annotate. */
  readonly stt: SttResult;
  /** Override the configured engine. */
  readonly engine?: DiarizationEngine;
  /** Override the configured service URL. */
  readonly serviceUrl?: string;
  /** Hard timeout for the whole diarization call (ms). Default 10 min. */
  readonly timeoutMs?: number;
  /**
   * When true, the media bytes are base64-encoded and sent inline. When false
   * (default), only the path is sent; the service must share the filesystem.
   */
  readonly inline?: boolean;
  /**
   * Optional hint for the engine (e.g. known speaker count). Passed through
   * unchanged; interpretation is the engine's.
   */
  readonly speakerCountHint?: number;
}

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

interface ResolvedConfig {
  readonly engine: DiarizationEngine;
  readonly serviceUrl: string | null;
  readonly timeoutMs: number;
  readonly inline: boolean;
}

function resolveConfig(options: DiarizeOptions): ResolvedConfig {
  const raw = options.engine ?? envString("DIARIZATION_ENGINE") ?? "none";
  const engine: DiarizationEngine =
    raw === "pyannote" || raw === "whisperx" ? raw : "none";
  return {
    engine,
    serviceUrl: options.serviceUrl ?? envString("DIARIZATION_SERVICE_URL") ?? null,
    timeoutMs: options.timeoutMs ?? envInt("DIARIZATION_TIMEOUT_MS", 10 * 60_000),
    inline: options.inline ?? envBool("DIARIZATION_INLINE", false),
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

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* HTTP call                                                                   */
/* -------------------------------------------------------------------------- */

interface EngineResponse {
  readonly turns: readonly SpeakerTurn[];
  /**
   * WhisperX may return its own segments; when the caller asked for
   * alphabetisation against an external `SttResult` we ignore this and rely
   * purely on `turns`.
   */
  readonly segments: readonly SttSegment[] | null;
}

async function callEngine(
  engine: Exclude<DiarizationEngine, "none">,
  opts: {
    readonly serviceUrl: string;
    readonly timeoutMs: number;
    readonly inputPath: string;
    readonly language: string | null;
    readonly speakerCountHint: number | undefined;
    readonly inline: boolean;
  },
): Promise<EngineResponse> {
  const endpoint = resolveEndpoint(opts.serviceUrl, engine);
  const body: Record<string, unknown> = { language: opts.language };
  if (opts.speakerCountHint !== undefined) {
    body["num_speakers"] = opts.speakerCountHint;
  }
  if (opts.inline) {
    const bytes = await readFile(opts.inputPath).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new DiarizationError(
        `Could not read media for inline diarization at ${opts.inputPath}: ${message}`,
        "invalid-input",
      );
    });
    body["audio_b64"] = bytes.toString("base64");
  } else {
    body["audio_path"] = opts.inputPath;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new DiarizationError(
        `Diarization request timed out after ${opts.timeoutMs}ms.`,
        "timeout",
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new DiarizationError(
      `Diarization service at ${endpoint} is unreachable: ${message}`,
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
    throw new DiarizationError(
      `Diarization service returned HTTP ${response.status}: ${trimmed || response.statusText}`,
      "engine-failure",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DiarizationError(
      `Diarization response was not valid JSON: ${message}`,
      "malformed-response",
    );
  }
  return parseEngineResponse(payload);
}

function resolveEndpoint(base: string, engine: Exclude<DiarizationEngine, "none">): string {
  const trimmed = base.replace(/\/+$/, "");
  if (/\/(diarize|segment|speakers)$/.test(trimmed)) return trimmed;
  if (engine === "whisperx") return `${trimmed}/diarize`;
  return `${trimmed}/diarize`;
}

function parseEngineResponse(payload: unknown): EngineResponse {
  if (payload === null || typeof payload !== "object") {
    throw new DiarizationError(
      "Diarization response was not an object.",
      "malformed-response",
    );
  }
  const root = payload as Record<string, unknown>;
  const turnsRaw = Array.isArray(root["turns"])
    ? (root["turns"] as unknown[])
    : Array.isArray(root["segments"])
      ? (root["segments"] as unknown[])
      : null;
  if (turnsRaw === null) {
    throw new DiarizationError(
      "Diarization response did not contain `turns` (or `segments`).",
      "malformed-response",
    );
  }
  const turns: SpeakerTurn[] = [];
  for (const raw of turnsRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const speaker = typeof t["speaker"] === "string" ? (t["speaker"] as string).trim() : "";
    const start = numberOrNull(t["start"]);
    const end = numberOrNull(t["end"]);
    if (speaker.length === 0 || start === null || end === null || end < start) continue;
    turns.push({ speaker, start, end });
  }
  turns.sort((a, b) => a.start - b.start);

  let segments: SttSegment[] | null = null;
  if (Array.isArray(root["segments"])) {
    segments = [];
    for (const raw of root["segments"] as unknown[]) {
      if (raw === null || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      const start = numberOrNull(s["start"]);
      const end = numberOrNull(s["end"]);
      const text = typeof s["text"] === "string" ? (s["text"] as string) : "";
      if (start === null || end === null || text.length === 0) continue;
      segments.push({
        ordinal: segments.length,
        start,
        end,
        text,
        confidence: numberOrNull(s["confidence"]),
      });
    }
  }
  return { turns, segments };
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
/* Alignment                                                                   */
/* -------------------------------------------------------------------------- */

interface SegmentAlignment {
  readonly speaker: string | null;
  readonly overlapRatio: number;
}

/**
 * For each Stt segment, find the speaker turn with the largest positive
 * overlap. Ties are broken in favour of the turn that appears first in the
 * chronological ordering returned by the engine; this makes the result
 * deterministic and reproducible.
 */
function alignSegments(
  segments: readonly SttSegment[],
  turns: readonly SpeakerTurn[],
): readonly SegmentAlignment[] {
  const out: SegmentAlignment[] = [];
  for (const seg of segments) {
    const segLen = seg.end - seg.start;
    let bestSpeaker: string | null = null;
    let bestOverlap = 0;
    for (const turn of turns) {
      const overlapStart = Math.max(seg.start, turn.start);
      const overlapEnd = Math.min(seg.end, turn.end);
      const overlap = overlapEnd - overlapStart;
      if (overlap <= 0) continue;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = turn.speaker;
      }
    }
    const ratio = segLen > 0 ? bestOverlap / segLen : 0;
    out.push({
      speaker: bestSpeaker,
      overlapRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Annotate an `SttResult` with speaker labels. When no diarization engine is
 * configured the result carries `attribution: "none"` and every segment's
 * `speaker` is `null`; no labels are invented.
 */
export async function diarize(options: DiarizeOptions): Promise<DiarizationResult> {
  const started = Date.now();
  if (options.stt === null || typeof options.stt !== "object") {
    throw new DiarizationError(
      "diarize requires an SttResult in `stt`.",
      "invalid-input",
    );
  }
  if (typeof options.inputPath !== "string" || options.inputPath.trim().length === 0) {
    throw new DiarizationError(
      "diarize requires a non-empty media inputPath.",
      "invalid-input",
    );
  }
  const config = resolveConfig(options);
  const sttResult = options.stt;

  if (config.engine === "none") {
    // Unannotated but structurally identical result.
    const segments: DiarizedSegment[] = sttResult.segments.map((s) => ({
      ordinal: s.ordinal,
      start: s.start,
      end: s.end,
      text: s.text,
      confidence: s.confidence,
      speaker: null,
      overlapRatio: 0,
    }));
    return {
      attribution: "none",
      engine: null,
      turns: [],
      speakers: [],
      segments,
      capturedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  }

  if (config.serviceUrl === null) {
    throw new DiarizationError(
      `DIARIZATION_ENGINE=${config.engine} requires DIARIZATION_SERVICE_URL to be set.`,
      "engine-not-configured",
    );
  }

  const engineResponse = await callEngine(config.engine, {
    serviceUrl: config.serviceUrl,
    timeoutMs: config.timeoutMs,
    inputPath: options.inputPath,
    language: sttResult.language,
    speakerCountHint: options.speakerCountHint,
    inline: config.inline,
  });

  const alignments = alignSegments(sttResult.segments, engineResponse.turns);
  const segments: DiarizedSegment[] = sttResult.segments.map((s, i) => {
    const a = alignments[i] ?? { speaker: null, overlapRatio: 0 };
    return {
      ordinal: s.ordinal,
      start: s.start,
      end: s.end,
      text: s.text,
      confidence: s.confidence,
      speaker: a.speaker,
      overlapRatio: a.overlapRatio,
    };
  });

  const speakers: string[] = [];
  for (const turn of engineResponse.turns) {
    if (!speakers.includes(turn.speaker)) speakers.push(turn.speaker);
  }

  const anyLabelled = segments.some((s) => s.speaker !== null);
  const attribution: DiarizationAttribution = anyLabelled ? "engine" : "none";

  return {
    attribution,
    engine: config.engine,
    turns: engineResponse.turns,
    speakers,
    segments,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export interface RehydratedDiarizationResult {
  readonly attribution: DiarizationAttribution;
  readonly engine: DiarizationEngine | null;
  readonly turns: readonly SpeakerTurn[];
  readonly speakers: readonly string[];
  readonly segments: readonly DiarizedSegment[];
  readonly capturedAt: string;
}

/**
 * Read a persisted `DiarizationResult` back. Throws `DiarizationError` with
 * code `"malformed-response"` on payloads that are not recognisable.
 */
export function rehydrateDiarizationResult(value: unknown): RehydratedDiarizationResult {
  if (value === null || typeof value !== "object") {
    throw new DiarizationError(
      "Rehydrate failed: payload is not an object.",
      "malformed-response",
    );
  }
  const r = value as Record<string, unknown>;
  const attribution: DiarizationAttribution =
    r["attribution"] === "engine" ? "engine" : "none";

  const engineRaw = r["engine"];
  const engine: DiarizationEngine | null =
    engineRaw === "pyannote" || engineRaw === "whisperx"
      ? engineRaw
      : null;

  const turnsRaw = Array.isArray(r["turns"]) ? (r["turns"] as unknown[]) : [];
  const turns: SpeakerTurn[] = [];
  for (const tRaw of turnsRaw) {
    if (tRaw === null || typeof tRaw !== "object") continue;
    const t = tRaw as Record<string, unknown>;
    const speaker = typeof t["speaker"] === "string" ? (t["speaker"] as string) : "";
    const start = numberOrNull(t["start"]);
    const end = numberOrNull(t["end"]);
    if (speaker.length === 0 || start === null || end === null) continue;
    turns.push({ speaker, start, end });
  }

  const speakersRaw = Array.isArray(r["speakers"])
    ? (r["speakers"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const speakers: string[] = [...speakersRaw];

  const segmentsRaw = Array.isArray(r["segments"]) ? (r["segments"] as unknown[]) : [];
  const segments: DiarizedSegment[] = [];
  for (const sRaw of segmentsRaw) {
    if (sRaw === null || typeof sRaw !== "object") continue;
    const s = sRaw as Record<string, unknown>;
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
      speaker: typeof s["speaker"] === "string" ? (s["speaker"] as string) : null,
      overlapRatio:
        typeof s["overlapRatio"] === "number" &&
        Number.isFinite(s["overlapRatio"] as number)
          ? Math.max(0, Math.min(1, s["overlapRatio"] as number))
          : 0,
    });
  }

  return {
    attribution,
    engine,
    turns,
    speakers,
    segments,
    capturedAt: typeof r["capturedAt"] === "string" ? (r["capturedAt"] as string) : "",
  };
}
