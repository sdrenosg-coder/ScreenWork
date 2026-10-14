/**
 * Zipy AI — parallel multi-source fan-out and fuse entry.
 *
 * This is the top of the ingestion graph. Given a set of sources (URL, text,
 * image, PDF, DOCX, PPTX, audio, video), it:
 *
 *   1. Runs every source's ingest pipeline **in parallel**, each on its own
 *      resolver function (`ingestUrl`, `ingestTextPrompt`, `ingestImage`, …).
 *      The per-source modules are injected via `FANOUT_RESOLVERS` so a
 *      deployment that lacks a given dependency (Playwright, ffmpeg, a VLM
 *      engine) can
 *      supply a resolver that reports a precise error rather than failing at
 *      module load.
 *   2. Collapses each resolver's result into a homogeneous `FanoutSourceResult`
 *      record carrying: kind, artifact identity, a structural summary, the
 *      raw result, and a `status` (`ok` | `error`) with a machine-readable
 *      error code. Failures are recorded per source — a missing ffmpeg does
 *      not blank a request that also had a URL.
 *   3. Reads the caller's source priority override (`sourcePriority`), merges
 *      it with the default via `@zipy/ingest/sourcePriority`, and hands the
 *      ordered results to the unified-representation builder
 *      (`@zipy/ingest/unifiedRep`).
 *
 * Crucially:
 *   - No source result is silently dropped. Every input the caller sent
 *     produces exactly one `FanoutSourceResult` — either `ok` with a
 *     structural summary, or `error` with a code and message.
 *   - When every source fails, the fanout throws `FanoutError` with code
 *     `all-sources-failed` rather than emitting an empty unified
 *     representation. The caller decides whether to surface that as a 4xx or
 *     5xx.
 *   - Video results are not stored — `ingestVideo` already discards the
 *     source bytes and returns only sampled-frame metadata. This module
 *     passes that through unchanged.
 *   - Nothing here talks to the network, a database or a queue. It is a pure
 *     coordination layer over the injected resolvers.
 *
 * Wiring the resolvers is the operator's job: `apps/worker/src/index.ts` (or a
 * wrapper module) provides the registry. `defaultFanoutResolvers()` returns a
 * registry whose every entry fails with a `resolver-not-wired` error, so the
 * worker must explicitly override the ones it supports.
 */

import { createHash } from "node:crypto";

import {
  DEFAULT_SOURCE_PRIORITY,
  SourcePriorityError,
  isSourceKind,
  orderSources,
  parseSourcePriority,
  type ResolvedSourcePriority,
  type SourceKind,
} from "@zipy/ingest/sourcePriority";
import { buildUnifiedRep, type UnifiedRep } from "@zipy/ingest/unifiedRep";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type FanoutErrorCode =
  | "invalid-input"
  | "empty-sources"
  | "all-sources-failed"
  | "source-priority"
  | "internal";

export class FanoutError extends Error {
  readonly code: FanoutErrorCode;
  constructor(message: string, code: FanoutErrorCode) {
    super(message);
    this.name = "FanoutError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One input the caller submitted. Shape mirrors the JSON bodies accepted by
 * `/api/sources/{url,text,file}` plus the audio/video variants of the file
 * route. The fanout does not re-validate these bodies — the individual
 * resolvers own the per-kind contract and report failures as `error`.
 */
export interface FanoutSourceInput {
  readonly kind: SourceKind;
  /** Anything the resolver needs. Interpreted by the resolver for this kind. */
  readonly payload: unknown;
  /** Optional human label forwarded into the unified representation. */
  readonly label?: string | null;
}

/**
 * Per-source outcome. `status === "ok"` guarantees `result` is present;
 * `status === "error"` guarantees `error` is present and `result` is null.
 */
export interface FanoutSourceResult {
  readonly kind: SourceKind;
  readonly status: "ok" | "error";
  readonly label: string | null;
  /**
   * A short structural summary built by `summarizeResult` for the kind. Kept
   * small, JSON-serializable and free of the source bytes — this is what the
   * unified representation stores on its `sources[]` entries.
   */
  readonly summary: FanoutSourceSummary | null;
  /** Raw resolver output. Never contains source bytes for audio/video. */
  readonly result: unknown;
  readonly error: FanoutSourceError | null;
  readonly durationMs: number;
}

export interface FanoutSourceError {
  readonly code: string;
  readonly message: string;
}

/**
 * Compact, JSON-friendly summary attached to every `ok` source. The fusion
 * entry only needs coarse facts about each source; the full per-source result
 * is preserved on `result` for the provenance/fusion phases.
 */
export interface FanoutSourceSummary {
  readonly kind: SourceKind;
  readonly contentHash: string;
  readonly filename: string | null;
  readonly mimeType: string | null;
  readonly byteLength: number | null;
  /** Number of text-bearing blocks extracted (OCR blocks, paragraphs, …). */
  readonly textBlockCount: number;
  /** Number of recognized UI elements when the source supported it. */
  readonly uiElementCount: number;
  /** Number of table structures extracted (PDF/DOCX). */
  readonly tableCount: number;
  /** Number of speech/transcript segments (audio/video). */
  readonly speechSegmentCount: number;
  /** Number of sampled visual frames (video). */
  readonly frameCount: number;
  /** Per-kind extras that fit in a small JSON object. */
  readonly extras: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * A resolver turns one `FanoutSourceInput` into an ingest result. Resolvers
 * must be pure with respect to the source bytes (no writes outside their own
 * module) and must throw — not return — on failure. The fanout catches,
 * records the error and moves on.
 */
export type FanoutResolver = (
  input: FanoutSourceInput,
  signal: AbortSignal,
) => Promise<FanoutResolverResult>;

export interface FanoutResolverResult {
  /** Stable identity the caller can cross-reference later. */
  readonly contentHash: string;
  readonly filename?: string | null;
  readonly mimeType?: string | null;
  readonly byteLength?: number | null;
  /** Raw resolver output, preserved verbatim. */
  readonly result: unknown;
  /** Pre-computed summary. When omitted, the fanout calls `summarizeResult`. */
  readonly summary?: FanoutSourceSummary;
}

export type FanoutResolverRegistry = Partial<
  Readonly<Record<SourceKind, FanoutResolver>>
>;

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

export interface FanoutOptions {
  readonly sources: readonly FanoutSourceInput[];
  /**
   * Comma-separated string or array of `SourceKind`. Unknown kinds and
   * duplicates are rejected with `FanoutError` code `"source-priority"`.
   */
  readonly sourcePriority?: unknown;
  /** Resolver registry. Required; missing kinds fail as `resolver-not-wired`. */
  readonly resolvers: FanoutResolverRegistry;
  /**
   * Hard timeout applied per source. Defaults to 20 minutes (the longest
   * single-source budget is the video pipeline). Not a per-frame timeout; the
   * source's own module owns those.
   */
  readonly perSourceTimeoutMs?: number;
  /**
   * When `true`, individual source failures are still recorded but the fanout
   * does **not** throw when every source fails; instead the caller receives a
   * unified representation marked `degraded: true`. Defaults to `false` so a
   * fully failed ingest surfaces loudly.
   */
  readonly allowAllFailed?: boolean;
  /** Optional workspace id forwarded to the unified representation. */
  readonly workspaceId?: string | null;
}

export interface FanoutResult {
  /** Ordered per-source results (by resolved priority, highest first). */
  readonly sources: readonly FanoutSourceResult[];
  readonly unified: UnifiedRep;
  readonly priority: ResolvedSourcePriority;
  readonly counts: {
    readonly submitted: number;
    readonly ok: number;
    readonly failed: number;
  };
  readonly durationMs: number;
  /**
   * Non-fatal notes (e.g. "video resolver not wired; source skipped"). Empty
   * when there is nothing to report.
   */
  readonly warnings: readonly string[];
}

/**
 * Run every source in parallel, capture one result per source, and build the
 * unified representation. Throws `FanoutError` for input-level problems
 * (empty source list, invalid priority override, no resolvers at all) and for
 * the all-sources-failed case unless `allowAllFailed: true`.
 */
export async function runFanout(options: FanoutOptions): Promise<FanoutResult> {
  const started = Date.now();
  const sources = options.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new FanoutError(
      "runFanout requires at least one source.",
      "empty-sources",
    );
  }

  const warnings: string[] = [];

  // Validate every source before running anything so a typo does not half-run
  // the request and then blow up.
  for (let i = 0; i < sources.length; i += 1) {
    const s = sources[i] as FanoutSourceInput | undefined;
    if (s === null || typeof s !== "object") {
      throw new FanoutError(
        `sources[${i}] is not an object.`,
        "invalid-input",
      );
    }
    if (!isSourceKind(s.kind)) {
      throw new FanoutError(
        `sources[${i}].kind is not a known source kind (got ${JSON.stringify(s.kind)}).`,
        "invalid-input",
      );
    }
  }

  let priority: ResolvedSourcePriority;
  try {
    priority = parseSourcePriority(options.sourcePriority);
  } catch (err) {
    if (err instanceof SourcePriorityError) {
      throw new FanoutError(
        `Invalid sourcePriority override (${err.code}): ${err.message}`,
        "source-priority",
      );
    }
    throw err;
  }

  if (!options.resolvers || typeof options.resolvers !== "object") {
    throw new FanoutError(
      "runFanout requires a resolvers registry.",
      "invalid-input",
    );
  }

  const perSourceTimeoutMs =
    typeof options.perSourceTimeoutMs === "number" &&
    Number.isFinite(options.perSourceTimeoutMs) &&
    options.perSourceTimeoutMs > 0
      ? options.perSourceTimeoutMs
      : 20 * 60_000;

  // ---------------------------------------------------------------- parallel
  // Each source runs on its own AbortController so a timeout kills just that
  // source. `Promise.all` is not used to avoid the whole request aborting on
  // the first failure — `Promise.allSettled` records every outcome.
  const tasks = sources.map((input, index) =>
    runOneSource({
      input,
      index,
      resolver: options.resolvers[input.kind],
      timeoutMs: perSourceTimeoutMs,
      onWarning: (w) => warnings.push(w),
    }),
  );

  const settled = await Promise.allSettled(tasks);

  const results: FanoutSourceResult[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    const input = sources[i] as FanoutSourceInput;
    if (outcome === undefined) {
      // Cannot happen (allSettled returns one entry per task), but keeps type
      // narrowing honest without inventing a placeholder result.
      results.push({
        kind: input.kind,
        status: "error",
        label: input.label ?? null,
        summary: null,
        result: null,
        error: {
          code: "internal",
          message: "Internal fanout error: no settlement recorded for source.",
        },
        durationMs: 0,
      });
      continue;
    }
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      // `runOneSource` catches internally; a rejected promise means an
      // unexpected throw escaped it. Record it as an error rather than
      // letting it take down the request.
      const reason = outcome.reason;
      results.push({
        kind: input.kind,
        status: "error",
        label: input.label ?? null,
        summary: null,
        result: null,
        error: {
          code: "internal",
          message:
            reason instanceof Error
              ? `Unexpected fanout error: ${reason.message}`
              : `Unexpected fanout error: ${String(reason)}`,
        },
        durationMs: 0,
      });
    }
  }

  // ------------------------------------------------------- order by priority
  const ordered = orderSources(results, priority);

  // ----------------------------------------------------- build unified rep
  const okResults = ordered.filter((r) => r.status === "ok");
  const failedResults = ordered.filter((r) => r.status === "error");

  if (okResults.length === 0 && options.allowAllFailed !== true) {
    const errSummary = failedResults
      .map((r) => `${r.kind}: ${r.error?.code ?? "unknown"}`)
      .join("; ");
    throw new FanoutError(
      `All ${failedResults.length} source(s) failed: ${errSummary}. Pass allowAllFailed: true to receive a degraded unified representation instead.`,
      "all-sources-failed",
    );
  }

  const unified = buildUnifiedRep({
    workspaceId: options.workspaceId ?? null,
    priority: priority.order,
    sources: ordered.map((r) => ({
      kind: r.kind,
      status: r.status,
      label: r.label,
      summary: r.summary,
      error: r.error,
    })),
    nowIso: new Date().toISOString(),
  });

  return {
    sources: ordered,
    unified,
    priority,
    counts: {
      submitted: sources.length,
      ok: okResults.length,
      failed: failedResults.length,
    },
    durationMs: Date.now() - started,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-source execution                                                        */
/* -------------------------------------------------------------------------- */

interface RunOneSourceArgs {
  readonly input: FanoutSourceInput;
  readonly index: number;
  readonly resolver: FanoutResolver | undefined;
  readonly timeoutMs: number;
  readonly onWarning: (warning: string) => void;
}

async function runOneSource(
  args: RunOneSourceArgs,
): Promise<FanoutSourceResult> {
  const { input, resolver, timeoutMs, onWarning } = args;
  const started = Date.now();
  const label = input.label ?? null;

  if (resolver === undefined) {
    const warning = `No resolver is wired for source kind "${input.kind}"; the source was skipped and recorded as an error. Provide a resolver for this kind in the fanout registry to ingest it.`;
    onWarning(warning);
    return {
      kind: input.kind,
      status: "error",
      label,
      summary: null,
      result: null,
      error: {
        code: "resolver-not-wired",
        message: warning,
      },
      durationMs: Date.now() - started,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Source "${input.kind}" exceeded the ${timeoutMs}ms fanout budget.`),
    );
  }, timeoutMs);

  try {
    const resolved = await resolver(input, controller.signal);

    // ---------------------------------------------------------- validation --
    if (
      resolved === null ||
      typeof resolved !== "object" ||
      typeof resolved.contentHash !== "string" ||
      resolved.contentHash.length === 0
    ) {
      return {
        kind: input.kind,
        status: "error",
        label,
        summary: null,
        result: null,
        error: {
          code: "invalid-resolver-output",
          message:
            "The resolver returned a result without a non-empty contentHash. Every ingest result must carry a content hash so the fusion entry can detect duplicate uploads.",
        },
        durationMs: Date.now() - started,
      };
    }

    const summary =
      resolved.summary ?? summarizeResult(input.kind, resolved.result);

    return {
      kind: input.kind,
      status: "ok",
      label,
      summary,
      result: resolved.result,
      error: null,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const { code, message } = classifyResolverError(err, input.kind);
    return {
      kind: input.kind,
      status: "error",
      label,
      summary: null,
      result: null,
      error: { code, message },
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a machine-readable error code from whatever the resolver threw. The
 * per-source modules use their own `ErrorCode` unions (`VideoIngestError`,
 * `AudioIngestError`, `OcrError`, …); we preserve their codes verbatim and
 * fall back to `"resolver-threw"` when nothing recognisable is present.
 */
function classifyResolverError(
  err: unknown,
  kind: SourceKind,
): { readonly code: string; readonly message: string } {
  if (err instanceof Error) {
    const code =
      typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : err.name && err.name !== "Error"
          ? err.name
          : "resolver-threw";
    return { code, message: err.message };
  }
  return {
    code: "resolver-threw",
    message: `Resolver for source kind "${kind}" threw a non-Error value: ${String(err)}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Structural summarization                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a `FanoutSourceSummary` from a resolver result. This function is
 * deliberately permissive — resolver results are already typed by their own
 * modules, but the summary is stored in a mixed JSON column so we read only
 * the fields we need and never assume a shape. Unknown / missing fields
 * collapse to 0 / null rather than throwing.
 *
 * If the resolver's result shape is genuinely unrecognisable (the caller
 * swapped in a resolver that returns bytes instead of the documented shape),
 * we still produce a valid summary — `extras.unrecognizedShape: true` — and
 * let the unified representation carry the raw result for the fusion phase to
 * inspect. The "no silent fabrication" rule applies to *content*, and this
 * summary is metadata, not content.
 */
export function summarizeResult(
  kind: SourceKind,
  result: unknown,
): FanoutSourceSummary {
  const extras: Record<string, string | number | boolean | null> = {};
  const base = {
    kind,
    contentHash: hashOf(result),
    filename: stringOrNull(readField(result, "filename")),
    mimeType: stringOrNull(readField(result, "mimeType")),
    byteLength: numberOrNull(readField(result, "byteLength")),
    textBlockCount: 0,
    uiElementCount: 0,
    tableCount: 0,
    speechSegmentCount: 0,
    frameCount: 0,
    extras,
  } satisfies FanoutSourceSummary;

  if (result === null || typeof result !== "object") {
    extras["unrecognizedShape"] = true;
    return base;
  }

  switch (kind) {
    case "url": {
      // url.ts: { pages[]: { elements[], a11yTree? }, url, … }
      const pages = arrayOf(readField(result, "pages"));
      let elements = 0;
      for (const p of pages) {
        elements += arrayOf(readField(p, "elements")).length;
      }
      return {
        ...base,
        textBlockCount: arrayOf(readField(result, "a11yNodes")).length,
        uiElementCount: elements,
        extras: withNumbers(extras, {
          pageCount: pages.length,
          finalUrl: stringOrNull(readField(result, "finalUrl")),
        }),
      };
    }

    case "text": {
      // textPrompt.ts: { goal, entities, subTasks[] }
      const subTasks = arrayOf(readField(result, "subTasks"));
      return {
        ...base,
        textBlockCount: subTasks.length,
        extras: withNumbers(extras, {
          subTaskCount: subTasks.length,
          grounded: booleanOrNull(readField(result, "grounded")),
        }),
      };
    }

    case "image": {
      // image.ts: { ocr: { blocks[] }, uiElements[], tables[]? }
      const ocr = readField(result, "ocr");
      const blocks = arrayOf(readField(ocr, "blocks"));
      return {
        ...base,
        textBlockCount: blocks.length,
        uiElementCount: arrayOf(readField(result, "uiElements")).length,
        tableCount: arrayOf(readField(result, "tables")).length,
        extras: withNumbers(extras, {
          ocrEngine: stringOrNull(readField(ocr, "engine")),
        }),
      };
    }

    case "pdf": {
      // pdf.ts: { pages[], tables[], regions[], embeddedImages[]? }
      const pages = arrayOf(readField(result, "pages"));
      let blocks = 0;
      for (const p of pages) blocks += arrayOf(readField(p, "textBlocks")).length;
      return {
        ...base,
        textBlockCount: blocks,
        tableCount: arrayOf(readField(result, "tables")).length,
        extras: withNumbers(extras, {
          pageCount: pages.length,
          scanned: booleanOrNull(readField(result, "scanned")),
          embeddedImageCount: arrayOf(readField(result, "embeddedImages")).length,
        }),
      };
    }

    case "docx":
    case "pptx": {
      // docx.ts / pptx.ts: { blocks[], tables[], embeddedImages[] }
      return {
        ...base,
        textBlockCount: arrayOf(readField(result, "blocks")).length,
        tableCount: arrayOf(readField(result, "tables")).length,
        extras: withNumbers(extras, {
          embeddedImageCount: arrayOf(readField(result, "embeddedImages")).length,
        }),
      };
    }

    case "audio": {
      // audio.ts: { stt: { segments[] }, diarization: { speakers[], segments[] } }
      const stt = readField(result, "stt");
      const segments = arrayOf(readField(stt, "segments"));
      const diar = readField(result, "diarization");
      const speakers = arrayOf(readField(diar, "speakers"));
      return {
        ...base,
        speechSegmentCount: segments.length,
        extras: withNumbers(extras, {
          speakerCount: speakers.length,
          attribution: stringOrNull(readField(diar, "attribution")),
        }),
      };
    }

    case "video": {
      // video.ts: { frames[], audio, frameErrors[], warnings[] }
      const frames = arrayOf(readField(result, "frames"));
      const audio = readField(result, "audio");
      const stt = readField(audio, "stt");
      const segments = arrayOf(readField(stt, "segments"));
      return {
        ...base,
        frameCount: frames.length,
        speechSegmentCount: segments.length,
        extras: withNumbers(extras, {
          frameErrorCount: arrayOf(readField(result, "frameErrors")).length,
          warningCount: arrayOf(readField(result, "warnings")).length,
        }),
      };
    }
  }
}

function withNumbers(
  extras: Record<string, string | number | boolean | null>,
  additions: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  for (const key of Object.keys(additions)) {
    extras[key] = additions[key] ?? null;
  }
  return extras;
}

function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Compute a stable hash of the resolver result for summary-level dedup.
 * The *content* hash (the one that identifies the source bytes) lives on the
 * resolver's returned `contentHash`; this one only exists so two structurally
 * identical summaries can be recognized. It is a hex sha256 of the stable
 * JSON serialization of the result.
 */
function hashOf(value: unknown): string {
  const json = stableStringify(value);
  const h = createHash("sha256");
  h.update(json);
  return h.digest("hex");
}

/**
 * JSON.stringify with object keys sorted recursively. Arrays keep their order.
 * Cycles are impossible in practice (resolver results are JSON-serializable)
 * but the function guards against value types that JSON.stringify would throw
 * on so a summary can never crash the fanout.
 */
function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
        return sorted;
      }
      if (typeof v === "bigint") return v.toString();
      return v;
    });
  } catch {
    return JSON.stringify({ _unserializable: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Default resolver registry (safe: fails loudly, never mocks)                 */
/* -------------------------------------------------------------------------- */

/**
 * A resolver that always fails with `resolver-not-wired`. Used by
 * `defaultFanoutResolvers()` so a deployment that forgets to register a
 * resolver still gets a precise error rather than a silent skip.
 *
 * This is deliberately *not* a mock: it does not return convincing-looking
 * results. It reports that the wiring is missing.
 */
export function notWiredResolver(kind: SourceKind): FanoutResolver {
  return async () => {
    throw Object.assign(
      new Error(
        `The "${kind}" ingest resolver is not wired on this worker. Register one on the fanout's resolver registry (see apps/worker/src/index.ts) after confirming the underlying engine (Playwright, OCR, VLM, ffmpeg, STT, Docling, …) is available.`,
      ),
      { code: "resolver-not-wired" },
    );
  };
}

export function defaultFanoutResolvers(): Required<FanoutResolverRegistry> {
  const registry: Record<SourceKind, FanoutResolver> = {} as Record<
    SourceKind,
    FanoutResolver
  >;
  for (const kind of [
    "url",
    "text",
    "image",
    "pdf",
    "docx",
    "pptx",
    "audio",
    "video",
  ] as const) {
    registry[kind] = notWiredResolver(kind);
  }
  return registry;
}

/* -------------------------------------------------------------------------- */
/* Priorities for reuse                                                        */
/* -------------------------------------------------------------------------- */

/** Re-exported for callers that want the shipped default without importing the module. */
export const FANOUT_DEFAULT_SOURCE_PRIORITY: readonly SourceKind[] =
  DEFAULT_SOURCE_PRIORITY;
