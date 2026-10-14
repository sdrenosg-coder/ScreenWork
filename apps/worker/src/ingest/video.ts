/**
 * Zipy AI — Video ingestion (worker side).
 *
 * Orchestrates the video branch of the ingestion phase. It:
 *   1. Probes the video for duration using ffprobe (best-effort; when ffprobe
 *      is absent the module requires the caller to supply a duration and
 *      otherwise refuses — no duration is invented).
 *   2. Builds a deterministic frame-sampling plan via
 *      `@zipy/ingest/frameSampling` (interval or scene mode).
 *   3. Extracts each sampled frame to a temporary PNG via ffmpeg.
 *   4. Hashes each frame, reads the bytes back, and hands the frame to OCR
 *      (`@zipy/ingest/ocr`) and, when configured, `@zipy/ingest/vlmElements`.
 *   5. Optionally extracts the audio track (ffmpeg -vn) and runs it through
 *      the audio ingestion pipeline (`./audio.ts`) so narratives in screen
 *      recordings contribute to the canonical representation. When the STT
 *      engine is not configured, this step is skipped and recorded as a
 *      `warnings` entry — no transcript is fabricated.
 *
 * Crucially:
 *   - No video bytes are stored on the result. Only sampled frame PNGs (fed
 *     to OCR/VLM) are touched, then removed from disk. The result carries one
 *     record per frame with a hash and the extracted on-screen text.
 *   - Failures to extract a single frame surface as a `frameErrors` entry
 *     rather than blanking the whole run. That matches the "no silent
 *     fabrication" rule: a missing frame is reported, not filled in.
 *   - Scene detection uses ffmpeg's `scdet` filter when `strategy: "scene"`
 *     is requested; if the filter is unavailable, that mode fails with a
 *     precise error rather than silently falling back to interval sampling.
 *
 * No network. No credentials. Pure local subprocess orchestration.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  FrameSamplingError,
  planFrameSamples,
  type FrameSamplingPlan,
  type FrameSamplingStrategy,
  type FrameSample,
} from "@zipy/ingest/frameSampling";
import {
  OcrError,
  runOcr,
  type OcrEngine,
  type OcrResult,
} from "@zipy/ingest/ocr";
import {
  VlmError,
  recognizeUiElements,
  type UiElement,
  type VlmEngine,
} from "@zipy/ingest/vlmElements";

import {
  AudioIngestError,
  ingestAudio,
  type AudioIngestResult,
} from "./audio";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type VideoIngestErrorCode =
  | "invalid-input"
  | "file-missing"
  | "empty-file"
  | "unsupported-format"
  | "ffprobe-missing"
  | "ffmpeg-missing"
  | "probe-failure"
  | "scene-detection-unavailable"
  | "frame-extraction-failure"
  | "internal";

export class VideoIngestError extends Error {
  readonly code: VideoIngestErrorCode;
  constructor(message: string, code: VideoIngestErrorCode) {
    super(message);
    this.name = "VideoIngestError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".m4v",
  ".wmv",
]);

const VIDEO_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
};

export interface VideoFrameResult {
  readonly ordinal: number;
  readonly timestampSeconds: number;
  readonly reason: FrameSample["reason"];
  readonly frameHash: string;
  readonly byteLength: number;
  /** Concatenated on-screen text from OCR, joined with "\n". */
  readonly onScreenText: string;
  readonly ocrBlocks: readonly {
    readonly ordinal: number;
    readonly text: string;
    readonly confidence: number | null;
    readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }[];
  readonly vlmElements: readonly {
    readonly ordinal: number;
    readonly elementType: string;
    readonly label: string;
    readonly confidence: number | null;
    readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }[];
  readonly ocrEngine: OcrResult["engine"] | null;
  readonly vlmEngine: VlmEngine | null;
  readonly extractionMs: number;
}

export interface VideoIngestOptions {
  /** Absolute or relative path to the video file. */
  readonly inputPath: string;
  /** MIME override; inferred from extension if omitted. */
  readonly mimeType?: string;
  /** Sampling strategy. Default "interval". */
  readonly strategy?: FrameSamplingStrategy;
  /** Interval in seconds (interval mode). Default 3. */
  readonly intervalSeconds?: number;
  /** Window start; default 0. */
  readonly startSeconds?: number;
  /** Window end; default probed duration. */
  readonly endSeconds?: number;
  /** Hard cap on sampled frames. Default 240. */
  readonly maxFrames?: number;
  /** Minimum gap between samples. */
  readonly minGapSeconds?: number;
  /**
   * When `durationSeconds` is supplied, ffprobe is skipped. When omitted, the
   * module probes with ffprobe; if ffprobe is missing, the module throws.
   */
  readonly durationSeconds?: number;
  /** Frame OCR language hint forwarded to the OCR adapter. */
  readonly ocrLanguage?: string;
  /** Override OCR engine. */
  readonly ocrEngine?: OcrEngine;
  /** Override OCR service URL. */
  readonly ocrServiceUrl?: string;
  /** Override VLM engine. */
  readonly vlmEngine?: VlmEngine;
  /** Override VLM service URL. */
  readonly vlmServiceUrl?: string;
  /**
   * When true, run VLM UI-element recognition on each frame. When VLM is not
   * configured, frames still run OCR and the result records `vlmEngine: null`.
   * Default true.
   */
  readonly runVlm?: boolean;
  /**
   * When true, extract the video's audio track (ffmpeg -vn) and run it through
   * the audio ingestion pipeline. Default true. Missing STT configuration is a
   * warning, not a failure.
   */
  readonly transcribeAudio?: boolean;
  /** Language hint for the STT pass on the extracted audio. */
  readonly audioLanguage?: string;
  /** Hard timeout for the whole video ingest (ms). Default: 20 min + interval * maxFrames. */
  readonly timeoutMs?: number;
  /** Override the ffmpeg binary path. */
  readonly ffmpegPath?: string;
  /** Override the ffprobe binary path. */
  readonly ffprobePath?: string;
}

export interface VideoIngestResult {
  readonly sourcePath: string;
  readonly filename: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  /** ISO timestamp. */
  readonly capturedAt: string;
  readonly durationMs: number;
  readonly videoDurationSeconds: number;
  readonly sampling: FrameSamplingPlan;
  readonly frames: readonly VideoFrameResult[];
  /**
   * Audio ingestion result for the extracted audio track. `null` when
   * transcription was skipped (either `transcribeAudio: false` or STT not
   * configured). Never a fabricated transcript.
   */
  readonly audio: AudioIngestResult | null;
  /**
   * Frames where extraction or OCR failed. Each entry stays in this list
   * rather than inventing a placeholder frame.
   */
  readonly frameErrors: readonly {
    readonly ordinal: number;
    readonly timestampSeconds: number;
    readonly stage: "extract" | "ocr" | "vlm" | "hash";
    readonly message: string;
  }[];
  /**
   * Non-fatal notes for the operator (e.g. "STT not configured; audio track
   * extracted but not transcribed"). Empty when nothing to report.
   */
  readonly warnings: readonly string[];
  readonly counts: {
    readonly plannedFrames: number;
    readonly capturedFrames: number;
    readonly failedFrames: number;
    readonly ocrBlocks: number;
    readonly vlmElements: number;
    readonly audioSegments: number;
    readonly speakers: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Subprocess helpers                                                          */
/* -------------------------------------------------------------------------- */

function runProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1_048_576) stdout = stdout.slice(-1_048_576);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 1_048_576) stderr = stderr.slice(-1_048_576);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-800)}`));
    });
  });
}

async function probeDurationSeconds(
  ffprobePath: string,
  inputPath: string,
  timeoutMs: number,
): Promise<number> {
  try {
    const { stdout } = await runProcess(
      ffprobePath,
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
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`ffprobe returned a non-positive duration: ${stdout.trim()}`);
    }
    return n;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ENOENT")) {
      throw new VideoIngestError(
        `ffprobe is not available at "${ffprobePath}". Install ffmpeg/ffprobe or supply durationSeconds explicitly so video ingestion can proceed without probing.`,
        "ffprobe-missing",
      );
    }
    throw new VideoIngestError(
      `ffprobe failed for ${inputPath}: ${message}`,
      "probe-failure",
    );
  }
}

interface SceneTimestamp {
  readonly timestampSeconds: number;
}

/**
 * Detect scene-change timestamps using ffmpeg's `scdet` filter, parsed from
 * the filter’s log output. The `scdet` filter logs to stderr as
 * `lavfi.scd.time=NN.NNN` or `lavfi.scd.score=…` lines depending on build; we
 * accept either form and derive times from `lavfi.scd.time`. When the filter
 * is unavailable (older ffmpeg), this function throws a precise error so the
 * caller can fall back to `strategy: "interval"` explicitly.
 */
async function detectSceneTimestamps(
  ffmpegPath: string,
  inputPath: string,
  timeoutMs: number,
): Promise<readonly SceneTimestamp[]> {
  const { stderr } = await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      inputPath,
      "-filter:v",
      "scdet=threshold=10",
      "-an",
      "-f",
      "null",
      "-",
    ],
    timeoutMs,
  );
  if (/No such filter:\s*'?scdet/i.test(stderr) || /Unknown filter/i.test(stderr)) {
    throw new VideoIngestError(
      "ffmpeg build does not provide the `scdet` filter; scene-mode sampling is unavailable. Re-run with strategy \"interval\" or install an ffmpeg build with `scdet`.",
      "scene-detection-unavailable",
    );
  }
  const times: number[] = [];
  const re = /lavfi\.scd\.time=([0-9]+(?:\.[0-9]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t >= 0) times.push(t);
  }
  times.sort((a, b) => a - b);
  return times.map((t) => ({ timestampSeconds: t }));
}

async function extractFrame(
  ffmpegPath: string,
  inputPath: string,
  timestampSeconds: number,
  outputPath: string,
  timeoutMs: number,
): Promise<void> {
  await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-nostats",
      "-ss",
      timestampSeconds.toFixed(3),
      "-i",
      inputPath,
      // Grab one frame, keep aspect, no scaling (we want native resolution
      // for OCR fidelity; the caller may downscale later).
      "-frames:v",
      "1",
      "-y",
      outputPath,
    ],
    timeoutMs,
  );
}

async function extractAudioTrack(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await runProcess(
      ffmpegPath,
      [
        "-hide_banner",
        "-nostats",
        "-i",
        inputPath,
        "-vn",
        "-acodec",
        "copy",
        "-y",
        outputPath,
      ],
      timeoutMs,
    );
    // Ensure the file actually has bytes.
    const st = await stat(outputPath).catch(() => null);
    return st !== null && st.size > 0;
  } catch {
    // Some inputs have no audio stream; try a re-encode fallback that also
    // fails cleanly when there is nothing to extract.
    try {
      await runProcess(
        ffmpegPath,
        [
          "-hide_banner",
          "-nostats",
          "-i",
          inputPath,
          "-vn",
          "-acodec",
          "libmp3lame",
          "-y",
          outputPath,
        ],
        timeoutMs,
      );
      const st = await stat(outputPath).catch(() => null);
      return st !== null && st.size > 0;
    } catch {
      return false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Ingest a video: sample frames, run OCR + VLM per frame, optionally extract
 * and transcribe the audio track. Returns a JSON-serializable
 * `VideoIngestResult`. No video bytes are retained on the result.
 */
export async function ingestVideo(
  options: VideoIngestOptions,
): Promise<VideoIngestResult> {
  const started = Date.now();
  const inputPath = options.inputPath;
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new VideoIngestError(
      "ingestVideo requires a non-empty inputPath.",
      "invalid-input",
    );
  }
  if (!existsSync(inputPath)) {
    throw new VideoIngestError(
      `Video file does not exist: ${inputPath}`,
      "file-missing",
    );
  }
  const ext = path.extname(inputPath).toLowerCase();
  if (ext.length > 0 && !VIDEO_EXTENSIONS.has(ext)) {
    throw new VideoIngestError(
      `Unsupported video extension "${ext}" for ${inputPath}. Supported: ${[...VIDEO_EXTENSIONS].join(", ")}.`,
      "unsupported-format",
    );
  }
  const fileStat = await stat(inputPath).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new VideoIngestError(
      `Could not stat video ${inputPath}: ${message}`,
      "file-missing",
    );
  });
  if (fileStat.size === 0) {
    throw new VideoIngestError(
      `Video file is empty: ${inputPath}`,
      "empty-file",
    );
  }
  const bytes = await readFile(inputPath);
  const contentHash = sha256Hex(bytes);
  const mimeType = options.mimeType ?? VIDEO_MIME_BY_EXT[ext] ?? "video/mp4";
  const filename = path.basename(inputPath);

  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? "ffprobe";

  // ---------------------------------------------------------- duration ----
  const durationSeconds =
    typeof options.durationSeconds === "number" &&
    Number.isFinite(options.durationSeconds) &&
    options.durationSeconds > 0
      ? options.durationSeconds
      : await probeDurationSeconds(ffprobePath, inputPath, 20_000);

  // ----------------------------------------------------- scene detect -----
  let sceneTimestamps: readonly number[] | undefined;
  if (options.strategy === "scene") {
    const scenes = await detectSceneTimestamps(ffmpegPath, inputPath, 5 * 60_000);
    sceneTimestamps = scenes.map((s) => s.timestampSeconds);
  }

  // ------------------------------------------------------------ plan ------
  let plan: FrameSamplingPlan;
  try {
    plan = planFrameSamples({
      durationSeconds,
      strategy: options.strategy,
      intervalSeconds: options.intervalSeconds,
      startSeconds: options.startSeconds,
      endSeconds: options.endSeconds,
      maxFrames: options.maxFrames,
      minGapSeconds: options.minGapSeconds,
      sceneTimestamps,
    });
  } catch (err) {
    if (err instanceof FrameSamplingError) {
      throw new VideoIngestError(
        `Frame sampling failed (${err.code}): ${err.message}`,
        "invalid-input",
      );
    }
    throw err;
  }

  // --------------------------------------------------------- tempdir ------
  const tmp = await mkdtemp(path.join(tmpdir(), "zipy-video-"));
  const warnings: string[] = [];
  const frameErrors: VideoIngestResult["frameErrors"][number][] = [];
  const frames: VideoFrameResult[] = [];

  const frameTimeoutMs =
    options.timeoutMs ?? Math.max(60_000, 20 * 60_000);

  try {
    for (const sample of plan.samples) {
      const frameStarted = Date.now();
      const framePath = path.join(tmp, `frame-${sample.ordinal.toString().padStart(4, "0")}.png`);
      try {
        await extractFrame(ffmpegPath, inputPath, sample.timestampSeconds, framePath, frameTimeoutMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code: VideoIngestErrorCode = message.includes("ENOENT")
          ? "ffmpeg-missing"
          : "frame-extraction-failure";
        // If ffmpeg is missing entirely, fail the whole ingest — otherwise
        // every frame would need to report a phantom error.
        if (code === "ffmpeg-missing") {
          throw new VideoIngestError(
            `ffmpeg is not available at "${ffmpegPath}". Install ffmpeg before running video ingestion.`,
            "ffmpeg-missing",
          );
        }
        frameErrors.push({
          ordinal: sample.ordinal,
          timestampSeconds: sample.timestampSeconds,
          stage: "extract",
          message,
        });
        continue;
      }

      let frameBytes: Buffer;
      try {
        frameBytes = await readFile(framePath);
      } catch (err) {
        frameErrors.push({
          ordinal: sample.ordinal,
          timestampSeconds: sample.timestampSeconds,
          stage: "extract",
          message: `Could not read extracted frame at ${framePath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        continue;
      }
      if (frameBytes.length === 0) {
        frameErrors.push({
          ordinal: sample.ordinal,
          timestampSeconds: sample.timestampSeconds,
          stage: "extract",
          message: "Extracted frame is empty (0 bytes).",
        });
        continue;
      }

      let frameHash: string;
      try {
        frameHash = sha256Hex(frameBytes);
      } catch (err) {
        frameErrors.push({
          ordinal: sample.ordinal,
          timestampSeconds: sample.timestampSeconds,
          stage: "hash",
          message: `Could not hash frame: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      // OCR ----------------------------------------------------------------
      let ocrResult: OcrResult | null = null;
      if (options.ocrEngine !== "none") {
        try {
          ocrResult = await runOcr({
            inputPath: framePath,
            mimeType: "image/png",
            engine: options.ocrEngine,
            serviceUrl: options.ocrServiceUrl,
            language: options.ocrLanguage,
          });
        } catch (err) {
          if (err instanceof OcrError && err.code === "engine-not-configured") {
            // OCR is required for video on-screen text. Report once; the
            // caller can still receive frames with empty onScreenText.
            if (!warnings.some((w) => w.startsWith("OCR engine not configured"))) {
              warnings.push(
                "OCR engine not configured; video frames were sampled but no on-screen text was extracted.",
              );
            }
          } else {
            frameErrors.push({
              ordinal: sample.ordinal,
              timestampSeconds: sample.timestampSeconds,
              stage: "ocr",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // VLM (optional) -----------------------------------------------------
      let vlmElements: UiElement[] = [];
      const runVlm = options.runVlm !== false && options.vlmEngine !== "none";
      if (runVlm) {
        try {
          vlmElements = await recognizeUiElements({
            inputPath: framePath,
            mimeType: "image/png",
            engine: options.vlmEngine,
            serviceUrl: options.vlmServiceUrl,
          });
        } catch (err) {
          if (err instanceof VlmError && err.code === "engine-not-configured") {
            if (!warnings.some((w) => w.startsWith("VLM engine not configured"))) {
              warnings.push(
                "VLM UI-element recognition engine not configured; video frames were sampled but no UI elements were recognized.",
              );
            }
          } else {
            frameErrors.push({
              ordinal: sample.ordinal,
              timestampSeconds: sample.timestampSeconds,
              stage: "vlm",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const ocrBlocks: VideoFrameResult["ocrBlocks"] = ocrResult === null
        ? []
        : ocrResult.blocks.map((b, i) => ({
            ordinal: i,
            text: b.text,
            confidence: b.confidence,
            box: {
              x: b.box.x,
              y: b.box.y,
              width: b.box.width,
              height: b.box.height,
            },
          }));
      const vlmRuns: VideoFrameResult["vlmElements"] = vlmElements.map((el, i) => ({
        ordinal: i,
        elementType: el.elementType,
        label: el.label,
        confidence: el.confidence,
        box: {
          x: el.box.x,
          y: el.box.y,
          width: el.box.width,
          height: el.box.height,
        },
      }));

      const onScreenText = ocrBlocks.map((b) => b.text).join("\n").trim();

      frames.push({
        ordinal: sample.ordinal,
        timestampSeconds: sample.timestampSeconds,
        reason: sample.reason,
        frameHash,
        byteLength: frameBytes.length,
        onScreenText,
        ocrBlocks,
        vlmElements: vlmRuns,
        ocrEngine: ocrResult?.engine ?? null,
        vlmEngine: vlmEngineOrNull(options.vlmEngine, vlmRuns.length > 0),
        extractionMs: Date.now() - frameStarted,
      });
    }

    // ------------------------------------------------------------- audio --
    let audio: AudioIngestResult | null = null;
    const shouldTranscribe = options.transcribeAudio !== false;
    if (shouldTranscribe) {
      // Try an m4a first (fast copy path); fall back to mp3 re-encode.
      const audioM4a = path.join(tmp, "audio.m4a");
      const audioMp3 = path.join(tmp, "audio.mp3");
      let audioPath: string | null = null;
      const extracted = await extractAudioTrack(ffmpegPath, inputPath, audioM4a, frameTimeoutMs);
      if (extracted) {
        audioPath = audioM4a;
      } else {
        const fallback = await extractAudioTrack(ffmpegPath, inputPath, audioMp3, frameTimeoutMs);
        if (fallback) audioPath = audioMp3;
      }
      if (audioPath === null) {
        warnings.push(
          "Video has no extractable audio track; audio transcription step was skipped.",
        );
      } else {
        try {
          audio = await ingestAudio({
            inputPath: audioPath,
            language: options.audioLanguage,
          });
        } catch (err) {
          if (err instanceof AudioIngestError && err.code === "stt-not-configured") {
            warnings.push(
              "STT engine not configured; the video audio track was extracted but not transcribed. Nothing is fabricated.",
            );
          } else if (err instanceof AudioIngestError) {
            warnings.push(
              `Audio ingestion failed (${err.code}): ${err.message}`,
            );
          } else {
            warnings.push(
              `Audio ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    const ocrBlocksTotal = frames.reduce((sum, f) => sum + f.ocrBlocks.length, 0);
    const vlmTotal = frames.reduce((sum, f) => sum + f.vlmElements.length, 0);
    const audioSegments = audio?.stt.segments.length ?? 0;
    const speakers = audio?.diarization.speakers.length ?? 0;

    return {
      sourcePath: inputPath,
      filename,
      contentHash,
      byteLength: bytes.length,
      mimeType,
      capturedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      videoDurationSeconds: durationSeconds,
      sampling: plan,
      frames,
      audio,
      frameErrors,
      warnings,
      counts: {
        plannedFrames: plan.samples.length,
        capturedFrames: frames.length,
        failedFrames: frameErrors.length,
        ocrBlocks: ocrBlocksTotal,
        vlmElements: vlmTotal,
        audioSegments,
        speakers,
      },
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
}

function vlmEngineOrNull(
  requested: VlmEngine | undefined,
  producedAnything: boolean,
): VlmEngine | null {
  if (requested === "none") return null;
  if (!producedAnything) return null;
  // When the caller did not override, we can only say the VLM produced
  // elements — we do not know which engine handled the request from here, so
  // we return null rather than guess. Callers that need the engine name
  // should pass `vlmEngine` explicitly.
  return requested ?? null;
}

function sha256Hex(bytes: Buffer): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export interface RehydratedVideoIngest {
  readonly sourcePath: string | null;
  readonly filename: string | null;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly videoDurationSeconds: number;
  readonly sampling: FrameSamplingPlan;
  readonly frames: readonly VideoFrameResult[];
  readonly audio: AudioIngestResult | null;
  readonly frameErrors: readonly VideoIngestResult["frameErrors"][number][];
  readonly warnings: readonly string[];
  readonly counts: VideoIngestResult["counts"];
  readonly capturedAt: string;
}

/**
 * Read a persisted `VideoIngestResult` back. Frames are re-hydrated
 * structurally; `audio` is passed through unchanged (call
 * `rehydrateAudioIngest` for a typed sub-object when needed).
 */
export function rehydrateVideoIngest(value: unknown): RehydratedVideoIngest {
  if (value === null || typeof value !== "object") {
    throw new VideoIngestError(
      "Rehydrate failed: payload is not an object.",
      "internal",
    );
  }
  const r = value as Record<string, unknown>;
  const samplingRaw = r["sampling"];
  if (samplingRaw === null || typeof samplingRaw !== "object") {
    throw new VideoIngestError(
      "Rehydrate failed: sampling plan is missing.",
      "internal",
    );
  }
  // Reuse the frameSampling rehydrator so plan shape errors surface here.
  const sampling = rehydrateSamplingPlanOrThrow(samplingRaw);
  const framesRaw = Array.isArray(r["frames"]) ? (r["frames"] as unknown[]) : [];
  const frames: VideoFrameResult[] = [];
  for (const f of framesRaw) {
    const parsed = parseStoredFrame(f);
    if (parsed !== null) frames.push(parsed);
  }
  const frameErrorsRaw = Array.isArray(r["frameErrors"])
    ? (r["frameErrors"] as unknown[])
    : [];
  const frameErrors: VideoIngestResult["frameErrors"][number][] = [];
  for (const fe of frameErrorsRaw) {
    if (fe === null || typeof fe !== "object") continue;
    const f = fe as Record<string, unknown>;
    const stageRaw = f["stage"];
    const stage: "extract" | "ocr" | "vlm" | "hash" =
      stageRaw === "ocr" || stageRaw === "vlm" || stageRaw === "hash"
        ? stageRaw
        : "extract";
    frameErrors.push({
      ordinal: typeof f["ordinal"] === "number" ? (f["ordinal"] as number) : 0,
      timestampSeconds:
        typeof f["timestampSeconds"] === "number"
          ? (f["timestampSeconds"] as number)
          : 0,
      stage,
      message: typeof f["message"] === "string" ? (f["message"] as string) : "",
    });
  }
  const warnings: string[] = [];
  if (Array.isArray(r["warnings"])) {
    for (const w of r["warnings"] as unknown[]) {
      if (typeof w === "string") warnings.push(w);
    }
  }
  const countsRaw = r["counts"];
  const counts: VideoIngestResult["counts"] =
    countsRaw !== null && typeof countsRaw === "object"
      ? {
          plannedFrames: numField(countsRaw, "plannedFrames", frames.length),
          capturedFrames: numField(countsRaw, "capturedFrames", frames.length),
          failedFrames: numField(countsRaw, "failedFrames", frameErrors.length),
          ocrBlocks: numField(countsRaw, "ocrBlocks", 0),
          vlmElements: numField(countsRaw, "vlmElements", 0),
          audioSegments: numField(countsRaw, "audioSegments", 0),
          speakers: numField(countsRaw, "speakers", 0),
        }
      : {
          plannedFrames: frames.length,
          capturedFrames: frames.length,
          failedFrames: frameErrors.length,
          ocrBlocks: 0,
          vlmElements: 0,
          audioSegments: 0,
          speakers: 0,
        };
  return {
    sourcePath:
      typeof r["sourcePath"] === "string" ? (r["sourcePath"] as string) : null,
    filename: typeof r["filename"] === "string" ? (r["filename"] as string) : null,
    contentHash:
      typeof r["contentHash"] === "string" ? (r["contentHash"] as string) : "",
    mimeType: typeof r["mimeType"] === "string" ? (r["mimeType"] as string) : "video/mp4",
    videoDurationSeconds:
      typeof r["videoDurationSeconds"] === "number"
        ? (r["videoDurationSeconds"] as number)
        : 0,
    sampling,
    frames,
    audio: (r["audio"] ?? null) as AudioIngestResult | null,
    frameErrors,
    warnings,
    counts,
    capturedAt: typeof r["capturedAt"] === "string" ? (r["capturedAt"] as string) : "",
  };
}

function rehydrateSamplingPlanOrThrow(value: unknown): FrameSamplingPlan {
  // Local type-preserving cast; the frameSampling module owns validation.
  // We import its rehydrator lazily so this module can still be loaded in
  // environments where the rehydrator is tree-shaken away.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = tryRequireFrameSampling();
  if (mod !== null && typeof mod.rehydrateFrameSamplingPlan === "function") {
    const r = mod.rehydrateFrameSamplingPlan(value);
    // Structural round-trip: cast to FrameSamplingPlan; every field is preserved.
    return r as unknown as FrameSamplingPlan;
  }
  return value as unknown as FrameSamplingPlan;
}

function tryRequireFrameSampling(): {
  rehydrateFrameSamplingPlan?: (v: unknown) => unknown;
} | null {
  try {
    const req = (globalThis as { require?: (s: string) => unknown }).require;
    if (typeof req === "function") return req("@zipy/ingest/frameSampling") as ReturnType<typeof tryRequireFrameSampling>;
    return null;
  } catch {
    return null;
  }
}

function parseStoredFrame(raw: unknown): VideoFrameResult | null {
  if (raw === null || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const ordinal = typeof f["ordinal"] === "number" ? (f["ordinal"] as number) : -1;
  if (ordinal < 0) return null;
  const timestampSeconds =
    typeof f["timestampSeconds"] === "number"
      ? (f["timestampSeconds"] as number)
      : 0;
  const reasonRaw = f["reason"];
  const reason: FrameSample["reason"] =
    reasonRaw === "scene" || reasonRaw === "start" || reasonRaw === "end"
      ? reasonRaw
      : "interval";
  const frameHash = typeof f["frameHash"] === "string" ? (f["frameHash"] as string) : "";
  const byteLength = typeof f["byteLength"] === "number" ? (f["byteLength"] as number) : 0;
  const onScreenText = typeof f["onScreenText"] === "string" ? (f["onScreenText"] as string) : "";
  const ocrRaw = Array.isArray(f["ocrBlocks"]) ? (f["ocrBlocks"] as unknown[]) : [];
  const ocrBlocks: VideoFrameResult["ocrBlocks"][number][] = [];
  for (const b of ocrRaw) {
    if (b === null || typeof b !== "object") continue;
    const bb = b as Record<string, unknown>;
    const box = bb["box"];
    if (box === null || typeof box !== "object") continue;
    const boxObj = box as Record<string, unknown>;
    ocrBlocks.push({
      ordinal: typeof bb["ordinal"] === "number" ? (bb["ordinal"] as number) : ocrBlocks.length,
      text: typeof bb["text"] === "string" ? (bb["text"] as string) : "",
      confidence:
        typeof bb["confidence"] === "number"
          ? (bb["confidence"] as number)
          : null,
      box: {
        x: numOr(boxObj["x"], 0),
        y: numOr(boxObj["y"], 0),
        width: numOr(boxObj["width"], 0),
        height: numOr(boxObj["height"], 0),
      },
    });
  }
  const vlmRaw = Array.isArray(f["vlmElements"]) ? (f["vlmElements"] as unknown[]) : [];
  const vlmElements: VideoFrameResult["vlmElements"][number][] = [];
  for (const e of vlmRaw) {
    if (e === null || typeof e !== "object") continue;
    const ee = e as Record<string, unknown>;
    const box = ee["box"];
    if (box === null || typeof box !== "object") continue;
    const boxObj = box as Record<string, unknown>;
    vlmElements.push({
      ordinal: typeof ee["ordinal"] === "number" ? (ee["ordinal"] as number) : vlmElements.length,
      elementType:
        typeof ee["elementType"] === "string" ? (ee["elementType"] as string) : "unknown",
      label: typeof ee["label"] === "string" ? (ee["label"] as string) : "",
      confidence:
        typeof ee["confidence"] === "number"
          ? (ee["confidence"] as number)
          : null,
      box: {
        x: numOr(boxObj["x"], 0),
        y: numOr(boxObj["y"], 0),
        width: numOr(boxObj["width"], 0),
        height: numOr(boxObj["height"], 0),
      },
    });
  }
  const ocrEngineRaw = f["ocrEngine"];
  const ocrEngine: VideoFrameResult["ocrEngine"] =
    ocrEngineRaw === "easyocr" ||
    ocrEngineRaw === "tesseract" ||
    ocrEngineRaw === "cloud" ||
    ocrEngineRaw === "auto"
      ? ocrEngineRaw
      : null;
  const vlmEngineRaw = f["vlmEngine"];
  const vlmEngine: VlmEngine | null =
    vlmEngineRaw === "vllm" ||
    vlmEngineRaw === "ollama" ||
    vlmEngineRaw === "cloud"
      ? vlmEngineRaw
      : null;
  return {
    ordinal,
    timestampSeconds,
    reason,
    frameHash,
    byteLength,
    onScreenText,
    ocrBlocks,
    vlmElements,
    ocrEngine,
    vlmEngine,
    extractionMs:
      typeof f["extractionMs"] === "number" ? (f["extractionMs"] as number) : 0,
  };
}

function numOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function numField(obj: unknown, key: string, fallback: number): number {
  if (obj === null || typeof obj !== "object") return fallback;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
