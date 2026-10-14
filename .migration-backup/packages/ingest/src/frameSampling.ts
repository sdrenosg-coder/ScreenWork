/**
 * Zipy AI — Video frame sampling + OCR alignment.
 *
 * Pure frame-planning module used by `apps/worker/src/ingest/video.ts`. It
 * computes a deterministic, budgeted list of frame timestamps for a video of
 * a given duration, given a sampling strategy. The strategy is *structural*:
 * this module never invents frame content, it only decides when to sample.
 * The worker then extracts frames (via ffmpeg) and hands each frame to the
 * OCR pipeline (`@zipy/ingest/ocr`) and, when configured, the VLM UI-element
 * pipeline (`@zipy/ingest/vlmElements`).
 *
 * Two modes are supported, both real:
 *   - "interval": sample every `intervalSeconds` seconds between `startSeconds`
 *     and `endSeconds`, bounded by `maxFrames`.
 *   - "scene":   use a caller-supplied list of scene-change timestamps
 *     (typically produced by `ffprobe -show_frames` / `scdet` filtered output),
 *     then merge, dedupe within `minGapSeconds`, and bound by `maxFrames`.
 *
 * Additionally, `chooseIntervalForBudget` derives an interval that respects a
 * max-frame budget for a known duration — used when the caller only knows the
 * duration and wants a sensible sampling rate without scene detection.
 *
 * No frames are read or decoded here. No network. No credentials.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type FrameSamplingErrorCode =
  | "invalid-input"
  | "empty-plan";

export class FrameSamplingError extends Error {
  readonly code: FrameSamplingErrorCode;
  constructor(message: string, code: FrameSamplingErrorCode) {
    super(message);
    this.name = "FrameSamplingError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type FrameSamplingStrategy = "interval" | "scene";

export interface FrameSample {
  /** 0-based ordinal in the plan. */
  readonly ordinal: number;
  /** Timestamp in seconds from the start of the media. */
  readonly timestampSeconds: number;
  /** How this sample was chosen: "interval" for regular grid, "scene" for a scene-change timestamp, "start", "end" for boundary anchors. */
  readonly reason: "interval" | "scene" | "start" | "end";
}

export interface FrameSamplingPlan {
  readonly strategy: FrameSamplingStrategy;
  readonly durationSeconds: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly intervalSeconds: number | null;
  readonly minGapSeconds: number;
  readonly maxFrames: number;
  readonly samples: readonly FrameSample[];
  /** True when maxFrames clipped the plan; caller should be aware coverage is not exhaustive. */
  readonly truncated: boolean;
  /** Number of candidate timestamps seen before dedup/clipping (interval mode = grid size; scene mode = input scene count). */
  readonly candidateCount: number;
}

export interface SampleOptions {
  /** Total media duration in seconds. Required. */
  readonly durationSeconds: number;
  /** Sample strategy. Default "interval". */
  readonly strategy?: FrameSamplingStrategy;
  /** Interval mode: seconds between samples. Default 3. */
  readonly intervalSeconds?: number;
  /** Window start; default 0. */
  readonly startSeconds?: number;
  /** Window end; default durationSeconds. */
  readonly endSeconds?: number;
  /** Hard cap on returned samples. Default 240. */
  readonly maxFrames?: number;
  /** Scene mode: scene-change timestamps in seconds, pre-sorted by the caller. */
  readonly sceneTimestamps?: readonly number[];
  /** Minimum gap between adjacent samples (seconds). Default half the interval (interval mode) or 0.5 (scene mode). */
  readonly minGapSeconds?: number;
  /** When true, force-include 0 as the first sample and durationSeconds as the last (subject to maxFrames). Default true. */
  readonly anchorEndpoints?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Defaults + validation                                                       */
/* -------------------------------------------------------------------------- */

const DEFAULT_INTERVAL_SECONDS = 3;
const DEFAULT_MAX_FRAMES = 240;
const DEFAULT_SCENE_MIN_GAP_SECONDS = 0.5;
const MAX_REASONABLE_FRAMES = 2_000;
const MAX_INTERVAL_SECONDS = 3_600;

function requireFinitePositive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new FrameSamplingError(
      `${name} must be a positive finite number; received ${String(value)}.`,
      "invalid-input",
    );
  }
  return value;
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/* -------------------------------------------------------------------------- */
/* Interval sampling                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a plan by walking a regular grid over the requested window. When
 * `anchorEndpoints` is true and the grid does not naturally land on `start` or
 * `end`, the endpoints are included as samples labelled "start"/"end". Grid
 * samples that fall within `minGapSeconds` of an already-accepted timestamp
 * are dropped.
 */
function planInterval(opts: {
  readonly durationSeconds: number;
  readonly intervalSeconds: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly maxFrames: number;
  readonly minGapSeconds: number;
  readonly anchorEndpoints: boolean;
}): FrameSamplingPlan {
  const span = opts.endSeconds - opts.startSeconds;
  if (span <= 0) {
    throw new FrameSamplingError(
      `endSeconds (${opts.endSeconds}) must be strictly greater than startSeconds (${opts.startSeconds}).`,
      "invalid-input",
    );
  }
  const candidates: number[] = [];
  // Use integer stepping in seconds*1000 to avoid float drift on long videos.
  const startMs = Math.round(opts.startSeconds * 1000);
  const endMs = Math.round(opts.endSeconds * 1000);
  const stepMs = Math.max(1, Math.round(opts.intervalSeconds * 1000));
  for (let t = startMs; t <= endMs; t += stepMs) {
    candidates.push(t / 1000);
  }
  if (candidates.length === 0 || candidates[candidates.length - 1] !== opts.endSeconds) {
    candidates.push(opts.endSeconds);
  }
  if (opts.anchorEndpoints && (candidates[0] ?? 0) !== opts.startSeconds) {
    candidates.unshift(opts.startSeconds);
  }

  const accepted = dedupeByGap(candidates, opts.minGapSeconds);
  const truncated = accepted.length > opts.maxFrames;
  const bounded = truncated ? accepted.slice(0, opts.maxFrames) : accepted;

  return {
    strategy: "interval",
    durationSeconds: opts.durationSeconds,
    startSeconds: opts.startSeconds,
    endSeconds: opts.endSeconds,
    intervalSeconds: opts.intervalSeconds,
    minGapSeconds: opts.minGapSeconds,
    maxFrames: opts.maxFrames,
    samples: bounded.map((t, i): FrameSample => ({
      ordinal: i,
      timestampSeconds: round3(t),
      reason: reasonFor(t, opts.startSeconds, opts.endSeconds),
    })),
    truncated,
    candidateCount: candidates.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Scene sampling                                                              */
/* -------------------------------------------------------------------------- */

function planScene(opts: {
  readonly durationSeconds: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly maxFrames: number;
  readonly minGapSeconds: number;
  readonly anchorEndpoints: boolean;
  readonly sceneTimestamps: readonly number[];
}): FrameSamplingPlan {
  const inWindow: number[] = [];
  for (const raw of opts.sceneTimestamps) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    if (raw < opts.startSeconds || raw > opts.endSeconds) continue;
    inWindow.push(raw);
  }
  inWindow.sort((a, b) => a - b);
  const candidates: number[] = [...inWindow];
  if (opts.anchorEndpoints) {
    if ((candidates[0] ?? Number.POSITIVE_INFINITY) !== opts.startSeconds) {
      candidates.unshift(opts.startSeconds);
    }
    const last = candidates[candidates.length - 1];
    if (last !== opts.endSeconds) {
      candidates.push(opts.endSeconds);
    }
  }
  if (candidates.length === 0) {
    throw new FrameSamplingError(
      "Scene sampling produced no candidates: no scene timestamps fell inside the requested window and anchorEndpoints was disabled.",
      "empty-plan",
    );
  }

  const accepted = dedupeByGap(candidates, opts.minGapSeconds);
  const truncated = accepted.length > opts.maxFrames;
  const bounded = truncated ? accepted.slice(0, opts.maxFrames) : accepted;

  return {
    strategy: "scene",
    durationSeconds: opts.durationSeconds,
    startSeconds: opts.startSeconds,
    endSeconds: opts.endSeconds,
    intervalSeconds: null,
    minGapSeconds: opts.minGapSeconds,
    maxFrames: opts.maxFrames,
    samples: bounded.map((t, i): FrameSample => {
      const reason: FrameSample["reason"] =
        t === opts.startSeconds
          ? "start"
          : t === opts.endSeconds
            ? "end"
            : inWindow.includes(t)
              ? "scene"
              : "interval";
      return {
        ordinal: i,
        timestampSeconds: round3(t),
        reason,
      };
    }),
    truncated,
    candidateCount: candidates.length,
  };
}

function reasonFor(
  t: number,
  startSeconds: number,
  endSeconds: number,
): FrameSample["reason"] {
  if (t === startSeconds) return "start";
  if (t === endSeconds) return "end";
  return "interval";
}

function dedupeByGap(candidates: readonly number[], minGap: number): number[] {
  const accepted: number[] = [];
  const gap = Math.max(0, minGap);
  for (const t of candidates) {
    const last = accepted[accepted.length - 1];
    if (last === undefined || t - last >= gap) {
      accepted.push(t);
    }
  }
  return accepted;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build a frame-sampling plan. `durationSeconds` is the only hard requirement;
 * everything else has documented defaults.
 *
 * Throws `FrameSamplingError` for structurally impossible inputs (non-positive
 * duration, window inverted, scene mode with no candidates). The caller is
 * expected to surface this to the operator, not paper over it.
 */
export function planFrameSamples(options: SampleOptions): FrameSamplingPlan {
  const duration = requireFinitePositive(options.durationSeconds, "durationSeconds");
  const start = clamp(
    typeof options.startSeconds === "number" && Number.isFinite(options.startSeconds)
      ? options.startSeconds
      : 0,
    0,
    duration,
  );
  const end = clamp(
    typeof options.endSeconds === "number" && Number.isFinite(options.endSeconds)
      ? options.endSeconds
      : duration,
    start + 0.001,
    duration,
  );

  const strategy: FrameSamplingStrategy =
    options.strategy === "scene" ? "scene" : "interval";

  const intervalSeconds = clamp(
    typeof options.intervalSeconds === "number" &&
      Number.isFinite(options.intervalSeconds) &&
      options.intervalSeconds > 0
      ? options.intervalSeconds
      : DEFAULT_INTERVAL_SECONDS,
    0.05,
    MAX_INTERVAL_SECONDS,
  );

  const maxFrames = clamp(
    typeof options.maxFrames === "number" &&
      Number.isFinite(options.maxFrames) &&
      options.maxFrames > 0
      ? Math.floor(options.maxFrames)
      : DEFAULT_MAX_FRAMES,
    1,
    MAX_REASONABLE_FRAMES,
  );

  const defaultGap =
    strategy === "scene" ? DEFAULT_SCENE_MIN_GAP_SECONDS : intervalSeconds / 2;
  const minGapSeconds = clamp(
    typeof options.minGapSeconds === "number" &&
      Number.isFinite(options.minGapSeconds) &&
      options.minGapSeconds >= 0
      ? options.minGapSeconds
      : defaultGap,
    0,
    60,
  );

  const anchorEndpoints = options.anchorEndpoints !== false;

  if (strategy === "scene") {
    if (options.sceneTimestamps === undefined) {
      throw new FrameSamplingError(
        "scene strategy requires sceneTimestamps to be supplied. Scene timestamps come from ffprobe/scdet output; nothing is invented here.",
        "invalid-input",
      );
    }
    return planScene({
      durationSeconds: duration,
      startSeconds: start,
      endSeconds: end,
      maxFrames,
      minGapSeconds,
      anchorEndpoints,
      sceneTimestamps: options.sceneTimestamps,
    });
  }

  return planInterval({
    durationSeconds: duration,
    intervalSeconds,
    startSeconds: start,
    endSeconds: end,
    maxFrames,
    minGapSeconds,
    anchorEndpoints,
  });
}

/**
 * Derive an interval that keeps the plan under `maxFrames` for a known
 * duration. Returns the interval in seconds; the caller can then call
 * `planFrameSamples` with that interval. The value is never below
 * `minIntervalSeconds`.
 */
export function chooseIntervalForBudget(
  durationSeconds: number,
  maxFrames: number,
  minIntervalSeconds = 0.5,
): number {
  const dur = requireFinitePositive(durationSeconds, "durationSeconds");
  const budget = Math.max(
    1,
    Number.isFinite(maxFrames) && maxFrames > 0
      ? Math.floor(maxFrames)
      : DEFAULT_MAX_FRAMES,
  );
  const minInterval = Math.max(0.05, minIntervalSeconds);
  const raw = dur / budget;
  return Math.max(minInterval, Math.round(raw * 1000) / 1000);
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export interface RehydratedFrameSamplingPlan {
  readonly strategy: FrameSamplingStrategy;
  readonly durationSeconds: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly intervalSeconds: number | null;
  readonly minGapSeconds: number;
  readonly maxFrames: number;
  readonly samples: readonly FrameSample[];
  readonly truncated: boolean;
  readonly candidateCount: number;
}

/**
 * Read a persisted `FrameSamplingPlan`. Throws on malformed payloads so the
 * video ingest path fails loudly rather than producing an empty plan.
 */
export function rehydrateFrameSamplingPlan(value: unknown): RehydratedFrameSamplingPlan {
  if (value === null || typeof value !== "object") {
    throw new FrameSamplingError(
      "Rehydrate failed: payload is not an object.",
      "invalid-input",
    );
  }
  const r = value as Record<string, unknown>;
  const strategy: FrameSamplingStrategy =
    r["strategy"] === "scene" ? "scene" : "interval";
  const durationSeconds = numberOr(r["durationSeconds"], 0);
  const startSeconds = numberOr(r["startSeconds"], 0);
  const endSeconds = numberOr(r["endSeconds"], durationSeconds);
  const intervalRaw = r["intervalSeconds"];
  const intervalSeconds =
    typeof intervalRaw === "number" && Number.isFinite(intervalRaw)
      ? intervalRaw
      : null;
  const minGapSeconds = numberOr(r["minGapSeconds"], 0);
  const maxFrames = numberOr(r["maxFrames"], 0);
  const truncated = r["truncated"] === true;
  const candidateCount = numberOr(r["candidateCount"], 0);
  const samplesRaw = Array.isArray(r["samples"]) ? (r["samples"] as unknown[]) : [];
  const samples: FrameSample[] = [];
  for (const sRaw of samplesRaw) {
    if (sRaw === null || typeof sRaw !== "object") continue;
    const s = sRaw as Record<string, unknown>;
    const ordinal = numberOr(s["ordinal"], samples.length);
    const timestampSeconds = numberOr(s["timestampSeconds"], NaN);
    if (!Number.isFinite(timestampSeconds)) continue;
    const reasonRaw = s["reason"];
    const reason: FrameSample["reason"] =
      reasonRaw === "scene" || reasonRaw === "start" || reasonRaw === "end"
        ? reasonRaw
        : "interval";
    samples.push({ ordinal, timestampSeconds, reason });
  }
  return {
    strategy,
    durationSeconds,
    startSeconds,
    endSeconds,
    intervalSeconds,
    minGapSeconds,
    maxFrames,
    samples,
    truncated,
    candidateCount,
  };
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
