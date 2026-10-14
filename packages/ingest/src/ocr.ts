/**
 * Zipy AI — OCR adapter.
 *
 * Produces per-region text with bounding boxes and confidence from an image
 * buffer or file. Backed by a configurable engine:
 *   - "easyocr" (default via OCR_ENGINE) — invoked as a local Python subprocess
 *     using the interpreter at `PYTHON_PATH` (default `python3`). The runner
 *     script name is `ZIPY_OCR_SCRIPT` (default `scripts/ocr_easyocr.py`);
 *     when the script is absent the adapter throws an `OcrError` with a clear
 *     message rather than fabricating results.
 *   - "tesseract" — invoked via the `tesseract` CLI with `--psm 11` and
 *     `tsv` output. Requires the binary on PATH.
 *   - "cloud" — routed to `OCR_SERVICE_URL` (Bearer auth via `OCR_SERVICE_TOKEN`).
 *   - "auto" — picks easyocr if the runner script exists, falls back to
 *     tesseract if the binary is on PATH, otherwise throws.
 *
 * Design notes:
 *  - No mocking. If no engine is usable, callers get an `OcrError` with
 *    `code: "engine-unavailable"`. The worker job fails and the user sees the
 *    message; it never silently returns empty text.
 *  - Text-layer detection (PDF) lives in the processing phase. This module's
 *    job is OCR on an image buffer.
 *  - Bounding boxes are in the coordinate system of the source image as the
 *    engine reported them, with `origin` set to `"top-left"`. Consumers that
 *    need a different origin (PDF points vs pixels) convert at their boundary.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class OcrError extends Error {
  readonly code:
    | "engine-unavailable"
    | "engine-failed"
    | "invalid-input"
    | "cloud-not-configured"
    | "internal";
  constructor(message: string, code: OcrError["code"]) {
    super(message);
    this.name = "OcrError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type OcrEngine = "easyocr" | "tesseract" | "cloud" | "auto";

export interface BBox {
  /** Left edge, pixels, from the image's top-left origin. */
  readonly x: number;
  /** Top edge, pixels, from the image's top-left origin. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OcrRegion {
  /** Recognised text, trimmed. May be the empty string for whitespace-only rows. */
  readonly text: string;
  /** 0..1 confidence from the engine. `null` when the engine did not report one. */
  readonly confidence: number | null;
  /** Bounding box for the region. */
  readonly bbox: BBox;
  /** Recognised language code, when the engine reports it. */
  readonly language: string | null;
}

export interface OcrResult {
  /** Which engine actually ran. `auto` is resolved to the concrete engine. */
  readonly engine: Exclude<OcrEngine, "auto">;
  /** Image width in pixels, as reported by the engine. */
  readonly width: number;
  /** Image height in pixels, as reported by the engine. */
  readonly height: number;
  /** Ordered top-to-bottom, left-to-right. */
  readonly regions: readonly OcrRegion[];
  /** Mean confidence across regions that reported one, or null when none did. */
  readonly meanConfidence: number | null;
  /** Number of regions with non-empty text. */
  readonly nonEmptyRegionCount: number;
  /** ISO timestamp of completion. */
  readonly completedAt: string;
  /** Wall-clock duration of the OCR call, ms. */
  readonly durationMs: number;
}

export interface OcrOptions {
  /** Explicit engine override; otherwise read from `OCR_ENGINE` / config. */
  readonly engine?: OcrEngine;
  /** Eas yOCR language list (ISO 639-1). Defaults to `["en"]`. */
  readonly languages?: readonly string[];
  /** Tesseract language string, e.g. `"eng+deu"`. Defaults to `"eng"`. */
  readonly tesseractLanguages?: string;
  /** Hard timeout for the subprocess / HTTP call. Defaults to `OCR_TIMEOUT_MS` / 120s. */
  readonly timeoutMs?: number;
  /**
   * Working directory for a file-based engine (EasyOCR needs a path). When the
   * caller passes a buffer and only `tesseract`/`cloud` are usable, the buffer
   * is streamed; EasyOCR paths require `inputPath`.
   */
  readonly inputPath?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Environment helpers                                                         */
/* -------------------------------------------------------------------------- */

function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveEngine(override: OcrOptions["engine"]): OcrEngine {
  if (override !== undefined) return override;
  const raw = (readEnv("OCR_ENGINE") ?? "auto").toLowerCase();
  if (raw === "easyocr" || raw === "tesseract" || raw === "cloud" || raw === "auto") {
    return raw;
  }
  return "auto";
}

function whichSync(bin: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Runner script detection                                                     */
/* -------------------------------------------------------------------------- */

function easyocrScriptPath(): string {
  const configured = readEnv("ZIPY_OCR_SCRIPT");
  if (configured !== null) return configured;
  return path.resolve(process.cwd(), "scripts", "ocr_easyocr.py");
}

/* -------------------------------------------------------------------------- */
/* Subprocess helpers                                                          */
/* -------------------------------------------------------------------------- */

interface SubprocessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

function runSubprocess(
  cmd: string,
  args: readonly string[],
  opts: { readonly timeoutMs: number; readonly stdin?: Buffer | null },
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settleTimer: NodeJS.Timeout | null = null;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args as string[], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const deadline = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      clearTimeout(deadline);
      if (settleTimer !== null) clearTimeout(settleTimer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      // Give stdio a tick to flush.
      settleTimer = setTimeout(() => resolve({ stdout, stderr, exitCode: code, timedOut }), 0);
    });

    if (opts.stdin instanceof Buffer) {
      try {
        child.stdin?.end(opts.stdin);
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/* EasyOCR                                                                     */
/* -------------------------------------------------------------------------- */

interface EasyOcrRow {
  readonly text?: unknown;
  readonly confidence?: unknown;
  readonly bbox?: unknown;
  readonly language?: unknown;
}

function normalizeBBox(raw: unknown): BBox | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const x = Number(r["x"]);
  const y = Number(r["y"]);
  const w = Number(r["width"]);
  const h = Number(r["height"]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }
  return { x, y, width: w, height: h };
}

async function runEasyOcr(
  inputPath: string,
  options: OcrOptions,
): Promise<OcrResult> {
  const script = easyocrScriptPath();
  if (!existsSync(script)) {
    throw new OcrError(
      `EasyOCR runner script not found at ${script}. Either install the script ` +
        `(see docs) or set ZIPY_OCR_SCRIPT to its absolute path, or switch ` +
        `OCR_ENGINE to "tesseract" if the tesseract binary is available.`,
      "engine-unavailable",
    );
  }
  const python = readEnv("PYTHON_PATH") ?? "python3";
  const languages =
    options.languages !== undefined && options.languages.length > 0
      ? options.languages
      : (readEnv("OCR_LANGUAGES")?.split(",").map((s) => s.trim()).filter((s) => s.length > 0) ?? ["en"]);
  const timeoutMs = options.timeoutMs ?? readIntEnv("OCR_TIMEOUT_MS", 120_000);

  const args: string[] = [script, "--json", "--input", inputPath];
  for (const lang of languages) args.push("--lang", lang);

  const started = Date.now();
  const res = await runSubprocess(python, args, { timeoutMs });
  if (res.timedOut) {
    throw new OcrError(
      `EasyOCR subprocess exceeded ${timeoutMs}ms and was killed. Raise OCR_TIMEOUT_MS or reduce image size.`,
      "engine-failed",
    );
  }
  if (res.exitCode !== 0) {
    throw new OcrError(
      `EasyOCR subprocess exited with code ${res.exitCode}. stderr: ${res.stderr.slice(0, 800)}`,
      "engine-failed",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    throw new OcrError(
      `EasyOCR subprocess did not emit valid JSON on stdout. Parse error: ${
        err instanceof Error ? err.message : String(err)
      }. First 200 chars: ${res.stdout.slice(0, 200)}`,
      "engine-failed",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new OcrError("EasyOCR subprocess returned a non-object JSON payload.", "engine-failed");
  }
  const obj = parsed as Record<string, unknown>;
  const width = Number(obj["width"]);
  const height = Number(obj["height"]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new OcrError(
      "EasyOCR subprocess did not report image width/height. The runner script is not the expected shape.",
      "engine-failed",
    );
  }
  const rowsRaw = Array.isArray(obj["regions"]) ? (obj["regions"] as unknown[]) : [];
  const regions: OcrRegion[] = [];
  for (const row of rowsRaw) {
    if (row === null || typeof row !== "object") continue;
    const r = row as EasyOcrRow;
    const bbox = normalizeBBox(r.bbox);
    if (bbox === null) continue;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    const confidence =
      typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? Math.max(0, Math.min(1, r.confidence))
        : null;
    const language = typeof r.language === "string" ? r.language : null;
    regions.push({ text, confidence, bbox, language });
  }
  const meanConfidence = computeMeanConfidence(regions);
  return {
    engine: "easyocr",
    width,
    height,
    regions,
    meanConfidence,
    nonEmptyRegionCount: regions.filter((r) => r.text.length > 0).length,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

/* -------------------------------------------------------------------------- */
/* Tesseract                                                                   */
/* -------------------------------------------------------------------------- */

async function runTesseract(
  inputBuffer: Buffer,
  inputPath: string | null | undefined,
  options: OcrOptions,
): Promise<OcrResult> {
  const bin = whichSync("tesseract");
  if (bin === null) {
    throw new OcrError(
      "The `tesseract` binary is not on PATH. Install tesseract-ocr, or switch " +
        "OCR_ENGINE to easyocr (requires the runner script), or configure a " +
        "cloud OCR service via OCR_SERVICE_URL.",
      "engine-unavailable",
    );
  }
  const timeoutMs = options.timeoutMs ?? readIntEnv("OCR_TIMEOUT_MS", 120_000);
  const langs =
    options.tesseractLanguages ?? readEnv("TESSERACT_LANGUAGES") ?? "eng";

  // Tesseract reads a file, and (with `-`) reads stdin. For a file path we
  // pass it directly; for a buffer we stream stdin.
  const args: string[] =
    inputPath && existsSync(inputPath)
      ? [inputPath, "stdout", "--psm", "11", "-l", langs, "tsv"]
      : ["stdin", "stdout", "--psm", "11", "-l", langs, "tsv"];

  const started = Date.now();
  const res = await runSubprocess(bin, args, {
    timeoutMs,
    stdin: inputPath && existsSync(inputPath) ? null : inputBuffer,
  });
  if (res.timedOut) {
    throw new OcrError(
      `Tesseract subprocess exceeded ${timeoutMs}ms and was killed. Raise OCR_TIMEOUT_MS or reduce image size.`,
      "engine-failed",
    );
  }
  if (res.exitCode !== 0) {
    throw new OcrError(
      `Tesseract subprocess exited with code ${res.exitCode}. stderr: ${res.stderr.slice(0, 800)}`,
      "engine-failed",
    );
  }
  const parsed = parseTesseractTsv(res.stdout);
  const meanConfidence = computeMeanConfidence(parsed.regions);
  return {
    engine: "tesseract",
    width: parsed.width,
    height: parsed.height,
    regions: parsed.regions,
    meanConfidence,
    nonEmptyRegionCount: parsed.regions.filter((r) => r.text.length > 0).length,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

/**
 * Parse the TSV emitted by `tesseract ... tsv`. Column layout (tab-separated):
 *   level page_num block_num par_num line_num word_num left top width height conf text
 * `conf` is a percentage (-1 for non-text lines). We keep only level 5 (word)
 * rows and group them into lines by (block_num, par_num, line_num), so the
 * emitted regions correspond to lines rather than individual words.
 */
function parseTesseractTsv(tsv: string): {
  readonly width: number;
  readonly height: number;
  readonly regions: readonly OcrRegion[];
} {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new OcrError("Tesseract emitted no output.", "engine-failed");
  }
  const header = lines[0]?.split("\t") ?? [];
  const idx = (name: string): number => header.indexOf(name);
  const iLevel = idx("level");
  const iBlock = idx("block_num");
  const iPar = idx("par_num");
  const iLine = idx("line_num");
  const iLeft = idx("left");
  const iTop = idx("top");
  const iWidth = idx("width");
  const iHeight = idx("height");
  const iConf = idx("conf");
  const iText = idx("text");
  if (iLevel < 0 || iText < 0) {
    throw new OcrError(
      "Tesseract TSV header is missing expected columns (level, text).",
      "engine-failed",
    );
  }

  interface LineAcc {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    words: string[];
    confs: number[];
  }
  const byKey = new Map<string, LineAcc>();
  let imageWidth = 0;
  let imageHeight = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const cols = (lines[i] ?? "").split("\t");
    const level = Number(cols[iLevel]);
    const text = cols[iText] ?? "";
    // We only fold word rows; higher-level rows carry no text.
    if (level !== 5 || text.length === 0) continue;
    const left = Number(cols[iLeft]);
    const top = Number(cols[iTop]);
    const w = Number(cols[iWidth]);
    const h = Number(cols[iHeight]);
    const confPercent = Number(cols[iConf]);
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      !Number.isFinite(w) ||
      !Number.isFinite(h)
    ) {
      continue;
    }
    const block = cols[iBlock] ?? "0";
    const par = cols[iPar] ?? "0";
    const line = cols[iLine] ?? "0";
    const key = `${block}\u0000${par}\u0000${line}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        minX: left,
        minY: top,
        maxX: left + w,
        maxY: top + h,
        words: [text],
        confs: Number.isFinite(confPercent) ? [confPercent] : [],
      });
    } else {
      existing.minX = Math.min(existing.minX, left);
      existing.minY = Math.min(existing.minY, top);
      existing.maxX = Math.max(existing.maxX, left + w);
      existing.maxY = Math.max(existing.maxY, top + h);
      existing.words.push(text);
      if (Number.isFinite(confPercent)) existing.confs.push(confPercent);
    }
    imageWidth = Math.max(imageWidth, left + w);
    imageHeight = Math.max(imageHeight, top + h);
  }

  const regions: OcrRegion[] = [];
  for (const acc of byKey.values()) {
    const text = acc.words.join(" ").trim();
    const meanConf =
      acc.confs.length > 0
        ? acc.confs.reduce((a, b) => a + b, 0) / acc.confs.length / 100
        : null;
    regions.push({
      text,
      confidence: meanConf === null ? null : Math.max(0, Math.min(1, meanConf)),
      bbox: {
        x: acc.minX,
        y: acc.minY,
        width: Math.max(1, acc.maxX - acc.minX),
        height: Math.max(1, acc.maxY - acc.minY),
      },
      language: null,
    });
  }

  // Sort deterministically: top-to-bottom, then left-to-right.
  regions.sort((a, b) => {
    if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });
  return { width: imageWidth, height: imageHeight, regions };
}

/* -------------------------------------------------------------------------- */
/* Cloud OCR                                                                   */
/* -------------------------------------------------------------------------- */

async function runCloudOcr(
  inputBuffer: Buffer,
  inputPath: string | null | undefined,
  options: OcrOptions,
): Promise<OcrResult> {
  const url = readEnv("OCR_SERVICE_URL");
  if (url === null) {
    throw new OcrError(
      "OCR_ENGINE=cloud requires OCR_SERVICE_URL to be set to a reachable endpoint. " +
        "No cloud OCR is assumed pre-provisioned by Zipy AI.",
      "cloud-not-configured",
    );
  }
  const token = readEnv("OCR_SERVICE_TOKEN");
  const timeoutMs = options.timeoutMs ?? readIntEnv("OCR_TIMEOUT_MS", 120_000);
  const body =
    inputPath && existsSync(inputPath)
      ? await readFile(inputPath)
      : inputBuffer;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OcrError(
        `Cloud OCR endpoint returned HTTP ${res.status}. Body: ${text.slice(0, 400)}`,
        "engine-failed",
      );
    }
    const json: unknown = await res.json();
    if (json === null || typeof json !== "object") {
      throw new OcrError("Cloud OCR endpoint returned a non-object JSON body.", "engine-failed");
    }
    const obj = json as Record<string, unknown>;
    const width = Number(obj["width"]);
    const height = Number(obj["height"]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new OcrError(
        "Cloud OCR response is missing numeric width/height. The endpoint contract is not the expected shape.",
        "engine-failed",
      );
    }
    const rowsRaw = Array.isArray(obj["regions"]) ? (obj["regions"] as unknown[]) : [];
    const regions: OcrRegion[] = [];
    for (const row of rowsRaw) {
      if (row === null || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const bbox = normalizeBBox(r["bbox"]);
      if (bbox === null) continue;
      const text = typeof r["text"] === "string" ? r["text"].trim() : "";
      const conf =
        typeof r["confidence"] === "number" && Number.isFinite(r["confidence"])
          ? Math.max(0, Math.min(1, r["confidence"] as number))
          : null;
      regions.push({
        text,
        confidence: conf,
        bbox,
        language: typeof r["language"] === "string" ? (r["language"] as string) : null,
      });
    }
    return {
      engine: "cloud",
      width,
      height,
      regions,
      meanConfidence: computeMeanConfidence(regions),
      nonEmptyRegionCount: regions.filter((r) => r.text.length > 0).length,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                                */
/* -------------------------------------------------------------------------- */

function computeMeanConfidence(regions: readonly OcrRegion[]): number | null {
  let sum = 0;
  let n = 0;
  for (const r of regions) {
    if (r.confidence === null) continue;
    sum += r.confidence;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

/**
 * Run OCR on an image buffer (or an on-disk path). Resolves `auto` to a
 * concrete engine and throws `OcrError` when no engine is usable. Never
 * silently returns empty results: an empty OCR output is a valid result only
 * when the engine ran and reported no text, which is distinguishable from
 * "no engine".
 */
export async function runOcr(
  input: Buffer | string,
  options: OcrOptions = {},
): Promise<OcrResult> {
  const inputPath =
    options.inputPath ?? (typeof input === "string" ? input : null);
  const buffer: Buffer =
    typeof input === "string" ? Buffer.alloc(0) : input;

  if (typeof input === "string" && !existsSync(input)) {
    throw new OcrError(`OCR input file does not exist: ${input}`, "invalid-input");
  }
  if (typeof input !== "string" && input.length === 0 && (inputPath === null || !existsSync(inputPath))) {
    throw new OcrError("OCR requires a non-empty buffer or an existing file path.", "invalid-input");
  }

  const engine = resolveEngine(options.engine);

  if (engine === "easyocr") {
    if (inputPath === null) {
      throw new OcrError(
        "EasyOCR requires a filesystem path. Pass an `inputPath` or write the buffer to disk before calling.",
        "invalid-input",
      );
    }
    return runEasyOcr(inputPath, options);
  }
  if (engine === "tesseract") {
    return runTesseract(buffer, inputPath, options);
  }
  if (engine === "cloud") {
    return runCloudOcr(buffer, inputPath, options);
  }

  // `auto`: prefer easyocr when the script is present, else tesseract when the
  // binary is available, else throw. The choice is deterministic for a given
  // environment.
  if (existsSync(easyocrScriptPath()) && inputPath !== null) {
    return runEasyOcr(inputPath, options);
  }
  if (whichSync("tesseract") !== null) {
    return runTesseract(buffer, inputPath, options);
  }
  throw new OcrError(
    "OCR_ENGINE=auto found no usable engine: the EasyOCR runner script is missing " +
      "(set ZIPY_OCR_SCRIPT to its path) and `tesseract` is not on PATH. " +
      "Install one of them, or set OCR_ENGINE=cloud with OCR_SERVICE_URL.",
    "engine-unavailable",
  );
}

/**
 * Rehydrate a stored `OcrResult`. Throws on malformed payloads so callers can
 * fail a job rather than proceed with a partial result.
 */
export function rehydrateOcrResult(value: unknown): OcrResult {
  if (value === null || typeof value !== "object") {
    throw new OcrError("Rehydrate failed: payload is not an object.", "internal");
  }
  const r = value as Record<string, unknown>;
  const engine = r["engine"];
  if (engine !== "easyocr" && engine !== "tesseract" && engine !== "cloud") {
    throw new OcrError("Rehydrate failed: unknown engine.", "internal");
  }
  const width = Number(r["width"]);
  const height = Number(r["height"]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new OcrError("Rehydrate failed: width/height missing.", "internal");
  }
  const rowsRaw = Array.isArray(r["regions"]) ? (r["regions"] as unknown[]) : [];
  const regions: OcrRegion[] = [];
  for (const row of rowsRaw) {
    if (row === null || typeof row !== "object") continue;
    const rr = row as Record<string, unknown>;
    const bbox = normalizeBBox(rr["bbox"]);
    if (bbox === null) continue;
    regions.push({
      text: typeof rr["text"] === "string" ? (rr["text"] as string) : "",
      confidence:
        typeof rr["confidence"] === "number" && Number.isFinite(rr["confidence"] as number)
          ? (rr["confidence"] as number)
          : null,
      bbox,
      language: typeof rr["language"] === "string" ? (rr["language"] as string) : null,
    });
  }
  return {
    engine,
    width,
    height,
    regions,
    meanConfidence: computeMeanConfidence(regions),
    nonEmptyRegionCount: regions.filter((r) => r.text.length > 0).length,
    completedAt: typeof r["completedAt"] === "string" ? (r["completedAt"] as string) : "",
    durationMs: typeof r["durationMs"] === "number" ? (r["durationMs"] as number) : 0,
  };
}
