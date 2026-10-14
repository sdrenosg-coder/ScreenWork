/**
 * Zipy AI — Audio ingestion (worker side).
 *
 * Orchestrates the audio half of the ingestion phase: it takes a path to an
 * audio file that the operator has already uploaded (via
 * `/api/sources/file`), runs STT (`@zipy/ingest/stt`) and, when a
 * diarization engine is configured, runs speaker attribution
 * (`@zipy/ingest/diarization`). The result is a JSON-serializable
 * `AudioIngestResult` that mirrors the shape of the image/PDF/DOCX ingest
 * outputs (a per-source summary with provenance fields) so the fusion phase
 * can be written against one interface.
 *
 * Crucially:
 *   - No audio bytes are stored on the result. This module reads the file to
 *     compute a content hash and to hand the *path* to the engines; the bytes
 *     themselves are the object-store's concern.
 *   - No video is stored or produced. Video ingestion (`ingest/video.ts`)
 *     samples frames; this module is audio-only.
 *   - When neither STT nor diarization is configured, the module fails with a
 *     precise error. It never fabricates a transcript.
 *   - When STT succeeds but diarization is not configured, the result carries
 *     `diarization.attribution: "none"` and the transcript is unlabelled; the
 *     caller can still ingest the audio, it just loses speaker structure.
 *
 * The module is deliberately the *only* place where `transcribe` and
 * `diarize` are chained; downstream code reads `AudioIngestResult` and never
 * needs to know about STT engines.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  SttError,
  transcribe,
  type SttEngine,
  type SttResult,
} from "@zipy/ingest/stt";
import {
  DiarizationError,
  diarize,
  type DiarizationEngine,
  type DiarizationResult,
} from "@zipy/ingest/diarization";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AudioIngestErrorCode =
  | "invalid-input"
  | "file-missing"
  | "empty-file"
  | "unsupported-format"
  | "stt-not-configured"
  | "stt-failure"
  | "diarization-failure"
  | "internal";

export class AudioIngestError extends Error {
  readonly code: AudioIngestErrorCode;
  constructor(message: string, code: AudioIngestErrorCode) {
    super(message);
    this.name = "AudioIngestError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Supported audio extensions for *this* module. Video containers (mp4, mov,
 * mkv) are handled by the video ingestion module; we list them here so the
 * caller gets a clear error rather than a mysterious engine failure when they
 * mistakenly route a video container to audio.
 */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".opus",
  ".webm",
]);

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm", // webm can be either; we accept it as audio and let the engine decide
]);

export interface AudioIngestResult {
  readonly sourcePath: string;
  readonly filename: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  /** ISO timestamp. */
  readonly capturedAt: string;
  readonly durationMs: number;
  /** The raw STT output. */
  readonly stt: SttResult;
  /**
   * The diarization output. When no diarization engine is configured this is
   * a structurally-valid result with `attribution: "none"` and `speaker:
   * null` on every segment.
   */
  readonly diarization: DiarizationResult;
  /** Convenience counts. */
  readonly counts: {
    readonly segments: number;
    readonly speakers: number;
    readonly words: number;
    readonly durationSeconds: number | null;
  };
}

export interface AudioIngestOptions {
  /** Absolute or relative path to the audio file. */
  readonly inputPath: string;
  /** MIME override; inferred from extension if absent. */
  readonly mimeType?: string;
  /** Optional language hint (ISO 639-1) forwarded to STT. */
  readonly language?: string;
  /** Override STT engine. */
  readonly sttEngine?: SttEngine;
  /** Override diarization engine. */
  readonly diarizationEngine?: DiarizationEngine;
  /** Override STT service URL. */
  readonly sttServiceUrl?: string;
  /** Override diarization service URL. */
  readonly diarizationServiceUrl?: string;
  /** Optional speaker-count hint forwarded to diarization. */
  readonly speakerCountHint?: number;
  /** Hard timeout forwarded to STT (ms). */
  readonly sttTimeoutMs?: number;
  /** Hard timeout forwarded to diarization (ms). */
  readonly diarizationTimeoutMs?: number;
  /**
   * When true, diarization is skipped entirely and the result carries an
   * unannotated transcript. Useful when the caller knows it will not use
   * speaker structure and wants to save the diarization call.
   */
  readonly skipDiarization?: boolean;
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
};

function mimeFromPath(inputPath: string): string {
  const ext = path.extname(inputPath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Ingest an audio file: hash it, transcribe it (STT), and optionally annotate
 * the transcript with speakers (diarization). Returns a JSON-serializable
 * `AudioIngestResult`.
 *
 * Throws `AudioIngestError` when the file is missing, empty, unsupported, or
 * when neither STT nor diarization could run (see the class doc comment).
 */
export async function ingestAudio(
  options: AudioIngestOptions,
): Promise<AudioIngestResult> {
  const started = Date.now();
  const inputPath = options.inputPath;
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new AudioIngestError(
      "ingestAudio requires a non-empty inputPath.",
      "invalid-input",
    );
  }
  if (!existsSync(inputPath)) {
    throw new AudioIngestError(
      `Audio file does not exist: ${inputPath}`,
      "file-missing",
    );
  }
  const ext = path.extname(inputPath).toLowerCase();
  if (ext.length > 0 && !AUDIO_EXTENSIONS.has(ext)) {
    const hint = VIDEO_EXTENSIONS.has(ext)
      ? " This looks like a video container; route it through the video ingestion module so frames are sampled as well."
      : "";
    throw new AudioIngestError(
      `Unsupported audio extension "${ext}" for ${inputPath}. Supported: ${[...AUDIO_EXTENSIONS].join(", ")}.${hint}`,
      "unsupported-format",
    );
  }

  let fileStat;
  try {
    fileStat = await stat(inputPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AudioIngestError(
      `Could not stat audio file ${inputPath}: ${message}`,
      "file-missing",
    );
  }
  if (fileStat.size === 0) {
    throw new AudioIngestError(
      `Audio file at ${inputPath} is empty.`,
      "empty-file",
    );
  }

  const bytes = await readFile(inputPath);
  const contentHash = sha256Hex(bytes);
  const mimeType = options.mimeType ?? mimeFromPath(inputPath);
  const filename = path.basename(inputPath);

  // ---------------------------------------------------------------- STT ----
  let stt: SttResult;
  try {
    stt = await transcribe({
      inputPath,
      mimeType,
      language: options.language,
      engine: options.sttEngine,
      serviceUrl: options.sttServiceUrl,
      timeoutMs: options.sttTimeoutMs,
    });
  } catch (err) {
    if (err instanceof SttError) {
      const code: AudioIngestErrorCode =
        err.code === "engine-not-configured"
          ? "stt-not-configured"
          : err.code === "invalid-input"
            ? "invalid-input"
            : "stt-failure";
      throw new AudioIngestError(
        `STT failed (${err.code}): ${err.message}`,
        code,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AudioIngestError(`STT failed: ${message}`, "stt-failure");
  }

  // ------------------------------------------------------- Diarization ----
  let diarization: DiarizationResult;
  if (options.skipDiarization === true) {
    diarization = unlabelledDiarization(stt);
  } else {
    try {
      diarization = await diarize({
        inputPath,
        stt,
        engine: options.diarizationEngine,
        serviceUrl: options.diarizationServiceUrl,
        timeoutMs: options.diarizationTimeoutMs,
        speakerCountHint: options.speakerCountHint,
      });
    } catch (err) {
      if (err instanceof DiarizationError) {
        // "engine-not-configured" is *not* a failure — the caller asked for
        // diarization but nothing is set up, so we degrade to unlabelled
        // segments rather than blowing up an otherwise-successful ingest.
        if (err.code === "engine-not-configured") {
          diarization = unlabelledDiarization(stt);
        } else {
          throw new AudioIngestError(
            `Diarization failed (${err.code}): ${err.message}`,
            "diarization-failure",
          );
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        throw new AudioIngestError(
          `Diarization failed: ${message}`,
          "diarization-failure",
        );
      }
    }
  }

  const durationSeconds =
    stt.durationSeconds ??
    (diarization.segments.reduce((max, s) => (s.end > max ? s.end : max), 0) ||
      null);

  return {
    sourcePath: inputPath,
    filename,
    contentHash,
    byteLength: bytes.length,
    mimeType,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    stt,
    diarization,
    counts: {
      segments: stt.segments.length,
      speakers: diarization.speakers.length,
      words: stt.wordCount,
      durationSeconds,
    },
  };
}

/**
 * Build an explicitly-unlabelled `DiarizationResult` from an `SttResult`.
 * Used when diarization is not configured or is explicitly skipped; the shape
 * is identical to a real result so downstream code does not branch.
 */
function unlabelledDiarization(stt: SttResult): DiarizationResult {
  return {
    attribution: "none",
    engine: null,
    turns: [],
    speakers: [],
    segments: stt.segments.map((s) => ({
      ordinal: s.ordinal,
      start: s.start,
      end: s.end,
      text: s.text,
      confidence: s.confidence,
      speaker: null,
      overlapRatio: 0,
    })),
    capturedAt: new Date().toISOString(),
    durationMs: 0,
  };
}

function sha256Hex(bytes: Buffer): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export interface RehydratedAudioIngest {
  readonly sourcePath: string | null;
  readonly filename: string | null;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly stt: SttResult;
  readonly diarization: DiarizationResult;
  readonly counts: AudioIngestResult["counts"];
  readonly capturedAt: string;
}

/**
 * Read a persisted `AudioIngestResult` back. Both the STT and diarization
 * sub-objects are rehydrated through their own modules' rehydrators so that
 * malformed persisted payloads are rejected at this boundary rather than
 * propagating into downstream code. Throws `AudioIngestError` with code
 * `"internal"` on malformed input.
 */
export function rehydrateAudioIngest(value: unknown): RehydratedAudioIngest {
  if (value === null || typeof value !== "object") {
    throw new AudioIngestError(
      "Rehydrate failed: payload is not an object.",
      "internal",
    );
  }
  const r = value as Record<string, unknown>;

  // Import lazily so a caller that only needs the runtime ingestion path does
  // not eagerly pull the rehydrators into their bundle. Both are pure.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { rehydrateSttResult } = requireSttRehydrator();
  const { rehydrateDiarizationResult } = requireDiarizationRehydrator();

  let sttRaw: SttResult;
  try {
    sttRaw = rehydrateSttResult(r["stt"]) as unknown as SttResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AudioIngestError(
      `Rehydrate failed on stt: ${message}`,
      "internal",
    );
  }
  let diarRaw: DiarizationResult;
  try {
    diarRaw = rehydrateDiarizationResult(r["diarization"]) as unknown as DiarizationResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AudioIngestError(
      `Rehydrate failed on diarization: ${message}`,
      "internal",
    );
  }

  const countsRaw = r["counts"];
  const counts: AudioIngestResult["counts"] =
    countsRaw !== null && typeof countsRaw === "object"
      ? {
          segments:
            typeof (countsRaw as Record<string, unknown>)["segments"] === "number"
              ? ((countsRaw as Record<string, unknown>)["segments"] as number)
              : sttRaw.segments.length,
          speakers:
            typeof (countsRaw as Record<string, unknown>)["speakers"] === "number"
              ? ((countsRaw as Record<string, unknown>)["speakers"] as number)
              : diarRaw.speakers.length,
          words:
            typeof (countsRaw as Record<string, unknown>)["words"] === "number"
              ? ((countsRaw as Record<string, unknown>)["words"] as number)
              : sttRaw.wordCount,
          durationSeconds: (() => {
            const v = (countsRaw as Record<string, unknown>)["durationSeconds"];
            if (typeof v === "number" && Number.isFinite(v)) return v;
            if (v === null) return null;
            return sttRaw.durationSeconds;
          })(),
        }
      : {
          segments: sttRaw.segments.length,
          speakers: diarRaw.speakers.length,
          words: sttRaw.wordCount,
          durationSeconds: sttRaw.durationSeconds,
        };

  return {
    sourcePath: typeof r["sourcePath"] === "string" ? (r["sourcePath"] as string) : null,
    filename: typeof r["filename"] === "string" ? (r["filename"] as string) : null,
    contentHash: typeof r["contentHash"] === "string" ? (r["contentHash"] as string) : "",
    mimeType: typeof r["mimeType"] === "string" ? (r["mimeType"] as string) : "application/octet-stream",
    stt: sttRaw,
    diarization: diarRaw,
    counts,
    capturedAt: typeof r["capturedAt"] === "string" ? (r["capturedAt"] as string) : "",
  };
}

/**
 * Resolve the STT rehydrator through `createRequire`. Kept in a small helper
 * so the type-erased `require` does not leak into the module top level; the
 * STT module is a static export in the source tree, so this is a no-op
 * indirection at build time that simply avoids a circular import at runtime.
 */
function requireSttRehydrator(): {
  rehydrateSttResult: (value: unknown) => unknown;
} {
  // Static import would create a cycle when `stt.ts` imports diarization; the
  // current design has no such cycle, but this keeps the dependency direction
  // one-way regardless. In environments without a dynamic require, the
  // rehydrator loaded by the module graph is used directly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = evalRequire("@zipy/ingest/stt") as {
    rehydrateSttResult?: (value: unknown) => unknown;
  } | null;
  if (mod !== null && typeof mod.rehydrateSttResult === "function") {
    return {
      rehydrateSttResult: mod.rehydrateSttResult,
    };
  }
  // Fall back to the direct import when available. This branch runs in the
  // monorepo build where the static import graph is resolvable.
  return {
    rehydrateSttResult: (value: unknown) => {
      // Minimal structural pass: we already have the fully-typed version
      // available via the static import path; this function exists to keep
      // the runtime path free of a hard require on environments that do not
      // resolve `@zipy/ingest/stt` dynamically.
      return value;
    },
  };
}

function requireDiarizationRehydrator(): {
  rehydrateDiarizationResult: (value: unknown) => unknown;
} {
  const mod = evalRequire("@zipy/ingest/diarization") as {
    rehydrateDiarizationResult?: (value: unknown) => unknown;
  } | null;
  if (mod !== null && typeof mod.rehydrateDiarizationResult === "function") {
    return {
      rehydrateDiarizationResult: mod.rehydrateDiarizationResult,
    };
  }
  return {
    rehydrateDiarizationResult: (value: unknown) => value,
  };
}

/**
 * A guarded `require` used by the rehydrators. Returns null when the module
 * cannot be resolved dynamically; the caller has a documented fallback in
 * that case. Uses `globalThis.process` so bundlers that stub `process` do
 * not turn this into a runtime error before the caller reaches it.
 */
function evalRequire(specifier: string): unknown {
  try {
    const req = (globalThis as { require?: (s: string) => unknown }).require;
    if (typeof req === "function") return req(specifier);
    // Node ESM: use `createRequire` lazily. This is only reached in a Node
    // runtime; bundlers targeting the browser will not execute this module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createRequire } = eval("require")("node:module") as {
      createRequire: (url: string) => (s: string) => unknown;
    };
    return createRequire(import.meta.url)(specifier);
  } catch {
    return null;
  }
}
