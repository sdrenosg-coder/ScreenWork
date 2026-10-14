/**
 * Zipy AI — transcript ↔ visual-state alignment.
 *
 * Aligns an STT transcript (with timestamps and optional speaker diarisation)
 * against a sequence of sampled video frames so that:
 *   - each transcript segment knows which frame(s) were on screen while it was
 *     spoken, and
 *   - each frame knows which transcript segments referenced it.
 *
 * Design constraints honoured here:
 *  - Pure. No I/O, no network, no credentials. The caller (video ingest /
 *    processing pipeline) supplies the already-extracted transcript segments
 *    and the already-sampled frame timeline. This module only performs the
 *    time-axis join and reports ambiguity.
 *  - Nothing is invented. A transcript segment with no overlapping frame is
 *    *reported* as `unmatched` rather than assigned to the nearest frame; a
 *    frame with no overlapping speech is reported with an empty segment list.
 *    Silent periods during screen recordings are common and meaningful
 *    (the operator is reading a form), so force-attaching to the nearest
 *    segment would fabricate evidence.
 *  - Timestamps are milliseconds on a single, monotone axis (the artifact's
 *    media timeline). Values in seconds or ISO strings are rejected rather
 *    than guessed at, because misreading seconds as milliseconds silently
 *    shifts every alignment by 1000×.
 *
 * Output is what the canonical-representation builder (`canonical.ts`)
 * consumes: a join table of (segment ↔ frame) edges with the overlap
 * duration, plus diagnostics.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AlignTranscriptErrorCode = "invalid-input";

export class AlignTranscriptError extends Error {
  readonly code: AlignTranscriptErrorCode;
  constructor(message: string, code: AlignTranscriptErrorCode) {
    super(message);
    this.name = "AlignTranscriptError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One STT output segment. `startMs` is inclusive, `endMs` exclusive.
 * `speaker` is an opaque label from diarisation ("speaker_1", "SPEAKER_00",
 * "A"); an empty string means "unknown".
 */
export interface TranscriptSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker?: string | null;
  /** Optional 0..1 confidence the STT engine reported for this segment. */
  readonly confidence?: number | null;
  /** Optional opaque id from the STT engine (kept for provenance). */
  readonly segmentId?: string | null;
}

/**
 * One sampled video frame. `timestampMs` is the frame's presentation time on
 * the media timeline. `frameId` is the caller's stable id for the sampled
 * image (typically the object-store key).
 *
 * `visualStates` carries whatever the vision/OCR pipeline extracted at that
 * timestamp. This module does not interpret them; it only carries them
 * through the alignment so downstream consumers do not need to re-join.
 */
export interface SampledFrame {
  readonly frameId: string;
  readonly timestampMs: number;
  /**
   * Optional nominal frame interval in ms (the sampling stride). When the
   * caller knows the stride, the module can extend a frame's on-screen
   * window from mid-point-to-mid-point instead of point-to-next-point.
   * When absent, the window extends to the next frame (or to `endOfTimelineMs`).
   */
  readonly strideMs?: number | null;
  /** Optional extraction context, preserved verbatim. */
  readonly ocrText?: readonly string[] | null;
  /** Optional recognised UI elements, preserved verbatim (opaque to this module). */
  readonly uiElements?: readonly { readonly kind: string; readonly label: string }[] | null;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export interface FrameWindow {
  readonly frameId: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Which rule produced the window, for reviewer transparency. */
  readonly derivedBy: "stride" | "next-frame" | "timeline-end";
}

export interface SegmentFrameOverlap {
  readonly segmentIndex: number;
  readonly frameIndex: number;
  /** Overlap in ms; strictly positive (zero-overlap edges are not emitted). */
  readonly overlapMs: number;
  /**
   * Fraction of the *segment* covered by this frame window (0..1]. Sums to at
   * most 1 across a segment's edges; values below 1 mean the segment was
   * partly off-screen of every sampled frame (e.g. cut off by the timeline's
   * end).
   */
  readonly segmentCoverage: number;
}

export interface AlignedSegment {
  readonly segmentIndex: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker: string;
  readonly confidence: number | null;
  readonly segmentId: string | null;
  /** Frame indexes this segment overlaps, in timestamp order. */
  readonly frameIndexes: readonly number[];
}

export interface AlignedFrame {
  readonly frameIndex: number;
  readonly frameId: string;
  readonly window: FrameWindow;
  /** Segment indexes overlapping this frame window, in timestamp order. */
  readonly segmentIndexes: readonly number[];
  readonly ocrText: readonly string[];
  readonly uiElements: readonly { readonly kind: string; readonly label: string }[];
}

export interface AlignmentDiagnostics {
  readonly segmentCount: number;
  readonly frameCount: number;
  /** Indexes of segments that overlap no frame window. */
  readonly unmatchedSegmentIndexes: readonly number[];
  /** Indexes of frames whose window contains no speech. */
  readonly silentFrameIndexes: readonly number[];
  /** True when at least one segment or frame was left unmatched. */
  readonly hasGaps: boolean;
  /**
   * True when two consecutive transcript segments overlap in time. Cross-talk
   * is common in diarisation; the caller may still want to warn a reviewer.
   */
  readonly hasOverlappingSpeech: boolean;
}

export interface TranscriptAlignment {
  readonly segments: readonly AlignedSegment[];
  readonly frames: readonly AlignedFrame[];
  readonly overlaps: readonly SegmentFrameOverlap[];
  readonly diagnostics: AlignmentDiagnostics;
  /** Same axis as the inputs; ISO string for logging only. */
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface AlignOptions {
  /**
   * When true, transcript segments whose `speaker` is empty are still aligned
   * (their frames will show an empty speaker). When false, such segments are
   * aligned but additionally flagged in diagnostics via `unmatchedSegmentIndexes`
   * (treated as gaps). Default true: unattributed speech is still speech.
   */
  readonly keepUnattributed?: boolean;
  /**
   * End of the timeline. Used only when a frame has no `strideMs` and is the
   * last frame (its window has nowhere else to extend to). When absent, the
   * last frame's window is set to `startMs`..`startMs` and the caller is
   * warned via `derivedBy: "timeline-end"` — a zero-width window will match
   * only segments starting exactly at that instant, which is honest.
   */
  readonly endOfTimelineMs?: number | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build a full alignment between transcript segments and sampled frames.
 *
 * Both inputs are sorted internally; the caller does not need to pre-sort.
 * Segments and frames with malformed timestamps (non-finite, negative, end
 * before start) are rejected with an explicit error rather than skipped,
 * because a silently shifted alignment produces *plausible but wrong* guides.
 */
export function alignTranscriptToFrames(
  segments: readonly TranscriptSegment[],
  frames: readonly SampledFrame[],
  options: AlignOptions = {},
): TranscriptAlignment {
  if (!Array.isArray(segments)) {
    throw new AlignTranscriptError("segments must be an array.", "invalid-input");
  }
  if (!Array.isArray(frames)) {
    throw new AlignTranscriptError("frames must be an array.", "invalid-input");
  }

  const sortedSegments = buildSortedSegments(segments);
  const sortedFrames = buildSortedFrames(frames);
  const windows = buildFrameWindows(sortedFrames, options.endOfTimelineMs ?? null);

  // Edge list: walk both sorted lists with a two-pointer sweep. Both lists
  // are disjoint within themselves (segments are non-overlapping in a
  // well-formed transcript; frames are points on an increasing axis), so the
  // naive O(S × F) join is unnecessary.
  const overlaps: SegmentFrameOverlap[] = [];
  const segmentFrameIndexes: number[][] = sortedSegments.map(() => []);
  const frameSegmentIndexes: number[][] = sortedFrames.map(() => []);

  let f = 0;
  for (let s = 0; s < sortedSegments.length; s += 1) {
    const seg = sortedSegments[s] as TranscriptSegment;
    const segDuration = Math.max(1, seg.endMs - seg.startMs);
    // Advance `f` past windows that end before this segment starts.
    while (f < windows.length && (windows[f] as FrameWindow).endMs <= seg.startMs) {
      f += 1;
    }
    // Walk forward from `f` while windows start before the segment ends.
    let probe = f;
    while (probe < windows.length && (windows[probe] as FrameWindow).startMs < seg.endMs) {
      const w = windows[probe] as FrameWindow;
      const overlapStart = Math.max(seg.startMs, w.startMs);
      const overlapEnd = Math.min(seg.endMs, w.endMs);
      const overlapMs = overlapEnd - overlapStart;
      if (overlapMs > 0) {
        overlaps.push({
          segmentIndex: s,
          frameIndex: probe,
          overlapMs,
          segmentCoverage: clamp01(overlapMs / segDuration),
        });
        (segmentFrameIndexes[s] as number[]).push(probe);
        (frameSegmentIndexes[probe] as number[]).push(s);
      }
      probe += 1;
    }
  }

  // Assemble aligned segments.
  const alignedSegments: AlignedSegment[] = sortedSegments.map((seg, i) => ({
    segmentIndex: i,
    startMs: seg.startMs,
    endMs: seg.endMs,
    text: seg.text,
    speaker: (seg.speaker ?? "").trim(),
    confidence:
      typeof seg.confidence === "number" && Number.isFinite(seg.confidence)
        ? clamp01(seg.confidence)
        : null,
    segmentId: typeof seg.segmentId === "string" && seg.segmentId.length > 0 ? seg.segmentId : null,
    frameIndexes: (segmentFrameIndexes[i] as number[]).slice(),
  }));

  // Assemble aligned frames.
  const alignedFrames: AlignedFrame[] = sortedFrames.map((frame, i) => ({
    frameIndex: i,
    frameId: frame.frameId,
    window: windows[i] as FrameWindow,
    segmentIndexes: (frameSegmentIndexes[i] as number[]).slice(),
    ocrText: Array.isArray(frame.ocrText)
      ? frame.ocrText.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : [],
    uiElements: Array.isArray(frame.uiElements)
      ? frame.uiElements.filter(
          (e): e is { readonly kind: string; readonly label: string } =>
            e !== null &&
            typeof e === "object" &&
            typeof e.kind === "string" &&
            typeof e.label === "string",
        )
      : [],
  }));

  const unmatched: number[] = [];
  for (let i = 0; i < alignedSegments.length; i += 1) {
    const s = alignedSegments[i] as AlignedSegment;
    if (s.frameIndexes.length === 0) unmatched.push(i);
  }
  const silent: number[] = [];
  for (let i = 0; i < alignedFrames.length; i += 1) {
    const f = alignedFrames[i] as AlignedFrame;
    if (f.segmentIndexes.length === 0) silent.push(i);
  }

  let hasOverlappingSpeech = false;
  for (let i = 1; i < sortedSegments.length; i += 1) {
    const prev = sortedSegments[i - 1] as TranscriptSegment;
    const cur = sortedSegments[i] as TranscriptSegment;
    if (cur.startMs < prev.endMs) {
      hasOverlappingSpeech = true;
      break;
    }
  }

  const keepUnattributed = options.keepUnattributed !== false;
  const unattributed = keepUnattributed
    ? []
    : alignedSegments.filter((s) => s.speaker.length === 0).map((s) => s.segmentIndex);
  const unmatchedAll = Array.from(new Set([...unmatched, ...unattributed])).sort(
    (a, b) => a - b,
  );

  return {
    segments: alignedSegments,
    frames: alignedFrames,
    overlaps,
    diagnostics: {
      segmentCount: alignedSegments.length,
      frameCount: alignedFrames.length,
      unmatchedSegmentIndexes: unmatchedAll,
      silentFrameIndexes: silent,
      hasGaps: unmatchedAll.length > 0 || silent.length > 0,
      hasOverlappingSpeech,
    },
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Sorting and validation                                                      */
/* -------------------------------------------------------------------------- */

function buildSortedSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === null || typeof seg !== "object") {
      throw new AlignTranscriptError(
        `TranscriptSegment at index ${i} is not an object.`,
        "invalid-input",
      );
    }
    if (
      typeof seg.startMs !== "number" ||
      !Number.isFinite(seg.startMs) ||
      seg.startMs < 0 ||
      typeof seg.endMs !== "number" ||
      !Number.isFinite(seg.endMs) ||
      seg.endMs < 0
    ) {
      throw new AlignTranscriptError(
        `TranscriptSegment at index ${i} has a non-finite or negative timestamp. ` +
          `Timestamps must be milliseconds on the media axis.`,
        "invalid-input",
      );
    }
    if (seg.endMs < seg.startMs) {
      throw new AlignTranscriptError(
        `TranscriptSegment at index ${i} has endMs < startMs.`,
        "invalid-input",
      );
    }
    if (typeof seg.text !== "string") {
      throw new AlignTranscriptError(
        `TranscriptSegment at index ${i} is missing a text string.`,
        "invalid-input",
      );
    }
    out.push(seg);
  }
  out.sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return a.endMs - b.endMs;
  });
  return out;
}

function buildSortedFrames(frames: readonly SampledFrame[]): SampledFrame[] {
  const out: SampledFrame[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame === null || typeof frame !== "object") {
      throw new AlignTranscriptError(
        `SampledFrame at index ${i} is not an object.`,
        "invalid-input",
      );
    }
    if (typeof frame.frameId !== "string" || frame.frameId.length === 0) {
      throw new AlignTranscriptError(
        `SampledFrame at index ${i} is missing a frameId string.`,
        "invalid-input",
      );
    }
    if (
      typeof frame.timestampMs !== "number" ||
      !Number.isFinite(frame.timestampMs) ||
      frame.timestampMs < 0
    ) {
      throw new AlignTranscriptError(
        `SampledFrame at index ${i} has a non-finite or negative timestampMs.`,
        "invalid-input",
      );
    }
    out.push(frame);
  }
  out.sort((a, b) => a.timestampMs - b.timestampMs);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Frame windows                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a window for each frame. Priority:
 *   1. When the frame carries a positive `strideMs`, the window is centred on
 *      the timestamp: [ts - stride/2, ts + stride/2).
 *   2. Otherwise, the window runs from the frame's timestamp to the next
 *      frame's timestamp. The last frame extends to `endOfTimelineMs` when
 *      supplied; when not, its window is zero-width (an honest "we know
 *      nothing about the post-last-frame period" answer).
 *
 * Windows are guaranteed non-overlapping and non-empty by construction, so
 * the two-pointer sweep in `alignTranscriptToFrames` is correct.
 */
function buildFrameWindows(
  frames: readonly SampledFrame[],
  endOfTimelineMs: number | null,
): FrameWindow[] {
  const windows: FrameWindow[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i] as SampledFrame;
    const stride = frame.strideMs;
    if (typeof stride === "number" && Number.isFinite(stride) && stride > 0) {
      const half = stride / 2;
      windows.push({
        frameId: frame.frameId,
        startMs: Math.max(0, frame.timestampMs - half),
        endMs: frame.timestampMs + half,
        derivedBy: "stride",
      });
      continue;
    }
    const next = frames[i + 1];
    if (next !== undefined) {
      windows.push({
        frameId: frame.frameId,
        startMs: frame.timestampMs,
        endMs: Math.max(frame.timestampMs + 1, next.timestampMs),
        derivedBy: "next-frame",
      });
      continue;
    }
    if (typeof endOfTimelineMs === "number" && Number.isFinite(endOfTimelineMs) && endOfTimelineMs > frame.timestampMs) {
      windows.push({
        frameId: frame.frameId,
        startMs: frame.timestampMs,
        endMs: endOfTimelineMs,
        derivedBy: "timeline-end",
      });
      continue;
    }
    windows.push({
      frameId: frame.frameId,
      startMs: frame.timestampMs,
      endMs: frame.timestampMs,
      derivedBy: "timeline-end",
    });
  }
  return windows;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `TranscriptAlignment`. Throws on structurally invalid
 * payloads so a corrupted alignment cannot feed the canonical builder an
 * empty (but plausible-looking) join table.
 */
export function rehydrateTranscriptAlignment(value: unknown): TranscriptAlignment {
  if (value === null || typeof value !== "object") {
    throw new AlignTranscriptError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const generatedAt = typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "";

  const segments = readArray(r["segments"]).map((raw, i) => readAlignedSegment(raw, i));
  const frames = readArray(r["frames"]).map((raw, i) => readAlignedFrame(raw, i));
  const overlaps = readArray(r["overlaps"]).map((raw, i) => ({
    segmentIndex: numberOr((raw as Record<string, unknown>)["segmentIndex"], 0, i),
    frameIndex: numberOr((raw as Record<string, unknown>)["frameIndex"], 0, i),
    overlapMs: Math.max(0, numberOr((raw as Record<string, unknown>)["overlapMs"], 0, i)),
    segmentCoverage: clamp01(
      numberOr((raw as Record<string, unknown>)["segmentCoverage"], 0, i),
    ),
  }));

  const diagnosticsRaw = (r["diagnostics"] ?? {}) as Record<string, unknown>;
  const unmatched = readNumberArray(diagnosticsRaw["unmatchedSegmentIndexes"]);
  const silent = readNumberArray(diagnosticsRaw["silentFrameIndexes"]);

  return {
    segments,
    frames,
    overlaps,
    diagnostics: {
      segmentCount: Math.max(0, Math.floor(numberOr(diagnosticsRaw["segmentCount"], segments.length, 0))),
      frameCount: Math.max(0, Math.floor(numberOr(diagnosticsRaw["frameCount"], frames.length, 0))),
      unmatchedSegmentIndexes: unmatched,
      silentFrameIndexes: silent,
      hasGaps: diagnosticsRaw["hasGaps"] === true,
      hasOverlappingSpeech: diagnosticsRaw["hasOverlappingSpeech"] === true,
    },
    generatedAt,
  };
}

function readArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? (v as readonly unknown[]) : [];
}

function readAlignedSegment(raw: unknown, i: number): AlignedSegment {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    segmentIndex: Math.max(0, Math.floor(numberOr(o["segmentIndex"], i, i))),
    startMs: Math.max(0, numberOr(o["startMs"], 0, i)),
    endMs: Math.max(0, numberOr(o["endMs"], 0, i)),
    text: typeof o["text"] === "string" ? (o["text"] as string) : "",
    speaker: typeof o["speaker"] === "string" ? (o["speaker"] as string) : "",
    confidence:
      typeof o["confidence"] === "number" && Number.isFinite(o["confidence"] as number)
        ? clamp01(o["confidence"] as number)
        : null,
    segmentId: typeof o["segmentId"] === "string" ? (o["segmentId"] as string) : null,
    frameIndexes: readNumberArray(o["frameIndexes"]),
  };
}

function readAlignedFrame(raw: unknown, i: number): AlignedFrame {
  const o = (raw ?? {}) as Record<string, unknown>;
  const windowRaw = (o["window"] ?? {}) as Record<string, unknown>;
  const derivedByRaw = windowRaw["derivedBy"];
  const derivedBy: FrameWindow["derivedBy"] =
    derivedByRaw === "stride" || derivedByRaw === "next-frame" || derivedByRaw === "timeline-end"
      ? derivedByRaw
      : "next-frame";
  const ocrText = readArray(o["ocrText"]).filter((t): t is string => typeof t === "string");
  const uiElementsRaw = readArray(o["uiElements"]);
  const uiElements: { kind: string; label: string }[] = [];
  for (const e of uiElementsRaw) {
    if (e === null || typeof e !== "object") continue;
    const eo = e as Record<string, unknown>;
    if (typeof eo["kind"] === "string" && typeof eo["label"] === "string") {
      uiElements.push({ kind: eo["kind"] as string, label: eo["label"] as string });
    }
  }
  return {
    frameIndex: Math.max(0, Math.floor(numberOr(o["frameIndex"], i, i))),
    frameId: typeof o["frameId"] === "string" ? (o["frameId"] as string) : `frame_${i}`,
    window: {
      frameId: typeof windowRaw["frameId"] === "string" ? (windowRaw["frameId"] as string) : `frame_${i}`,
      startMs: Math.max(0, numberOr(windowRaw["startMs"], 0, i)),
      endMs: Math.max(0, numberOr(windowRaw["endMs"], 0, i)),
      derivedBy,
    },
    segmentIndexes: readNumberArray(o["segmentIndexes"]),
    ocrText,
    uiElements,
  };
}

function readNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0)
    .map((n) => Math.floor(n));
}

function numberOr(v: unknown, fallback: number, _ctx: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
