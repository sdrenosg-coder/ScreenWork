/**
 * Zipy AI — image ingestion (worker side).
 *
 * Orchestrates the image-ingestion pipeline: reads the file (or accepts a
 * buffer), runs OCR to extract text with bounding boxes and confidence, calls
 * the vision-language model to recognise interactive UI elements, converts the
 * recognised elements into the same `IndexedElement` shape used by URL
 * ingestion so downstream synthesis is uniform, and returns a single
 * JSON-serializable `ImageIngestResult` the worker persists as an artifact.
 *
 * Design notes:
 *  - Neither OCR nor the VLM is optional for this module. When the OCR engine
 *    is unavailable the module throws `ImageIngestError` with code
 *    `"ocr-unavailable"`; when no VLM provider is configured it throws with
 *    code `"vlm-unavailable"`. The caller (worker job) surfaces the message
 *    verbatim. Nothing is faked to satisfy the happy path.
 *  - The VLM augmentation is not a replacement for the deterministic index:
 *    we build the `ElementIndex` from the recognised elements with the
 *    `@zipy/ingest/stableRefs` assigner so refs and ambiguity flags agree with
 *    the URL path.
 *  - The intermediate representation emitted here (`ImageIngestResult`) is
 *    phase-local; the fusion phase owns the canonical, cross-source form.
 *  - No browser, no network other than the OCR engine and the LLM provider the
 *    caller configured. No filesystem side-effects beyond reading the input.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  runOcr,
  type OcrResult,
  type OcrRegion,
} from "@zipy/ingest/ocr";
import {
  recognizeUiElements,
  type RecognizedElement,
  type VlmResult,
} from "@zipy/ingest/vlmElements";
import {
  buildElementIndex,
  type ElementIndex,
  type IndexedElement,
} from "@zipy/ingest/elementIndex";
import { createStableRefAssigner } from "@zipy/ingest/stableRefs";
import type { A11yNode } from "@zipy/ingest/a11y";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class ImageIngestError extends Error {
  readonly code:
    | "invalid-input"
    | "file-missing"
    | "ocr-unavailable"
    | "vlm-unavailable"
    | "internal";
  constructor(message: string, code: ImageIngestError["code"]) {
    super(message);
    this.name = "ImageIngestError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Options + result                                                            */
/* -------------------------------------------------------------------------- */

export interface ImageIngestOptions {
  /**
   * Either a path on disk OR a buffer. When both are provided, the buffer is
   * used for OCR submission while the path is used for engines that require a
   * file (EasyOCR). At least one of the two must be present.
   */
  readonly inputPath?: string | null;
  readonly buffer?: Buffer | null;
  /** Detected MIME type. Defaults to `image/png`. */
  readonly mimeType?: string;
  /** OCR engine override (see `@zipy/ingest/ocr`). */
  readonly ocrEngine?: "easyocr" | "tesseract" | "cloud" | "auto";
  /** OCR language hints (EasyOCR). */
  readonly ocrLanguages?: readonly string[];
  /** Tesseract language string, e.g. "eng+deu". */
  readonly tesseractLanguages?: string;
  /** VLM provider override (see `@zipy/ingest/vlmElements`). */
  readonly vlmProvider?: "openai" | "anthropic" | "gemini" | "ollama" | "vllm";
  /** VLM model override. */
  readonly vlmModel?: string | null;
  /** Hard timeout for the VLM call, ms. */
  readonly vlmTimeoutMs?: number;
  /** Hard timeout for the OCR call, ms. */
  readonly ocrTimeoutMs?: number;
  /**
   * When true, skip the VLM step and return OCR-only. The `vlm` field is then
   * `null` and `elements` is empty. Useful when the caller only wants text.
   */
  readonly ocrOnly?: boolean;
}

export interface ImageIngestResult {
  /** Absolute path the file was read from, when one was supplied. */
  readonly sourcePath: string | null;
  /** SHA-256 hash of the raw bytes, hex-encoded. */
  readonly contentHash: string;
  /** Byte length of the source image. */
  readonly byteLength: number;
  /** Detected MIME type, best-effort from the extension when not supplied. */
  readonly mimeType: string;
  /** Full OCR result. */
  readonly ocr: OcrResult;
  /** VLM result, or null when `ocrOnly` was requested. */
  readonly vlm: VlmResult | null;
  /**
   * The interactive-element index. Built from VLM-recognised elements when the
   * VLM ran, otherwise empty (OCR text alone is not interactive).
   */
  readonly elements: ElementIndex;
  /** Convenience: the flat list of indexed elements (equals `elements.elements`). */
  readonly indexedElements: readonly IndexedElement[];
  /**
   * A synthetic a11y tree built from the OCR regions. This is a *text view* of
   * the image: unnamed textboxes do not appear, only regions with text do.
   * Downstream synthesis can use it just as it uses a real a11y tree, but must
   * remember that roles here are synthetic ("text" for OCR blocks) — they are
   * not ARIA roles the browser would report.
   */
  readonly syntheticA11y: A11yNode;
  /** ISO timestamp of completion. */
  readonly capturedAt: string;
  /** Wall-clock duration of the whole ingest, ms. */
  readonly durationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

import { createHash } from "node:crypto";

function sha256Hex(bytes: Buffer): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

/* -------------------------------------------------------------------------- */
/* MIME + validation                                                           */
/* -------------------------------------------------------------------------- */

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

function inferMimeType(inputPath: string | null, override: string | undefined): string {
  if (override !== undefined && override.length > 0) return override;
  if (inputPath === null) return "image/png";
  const ext = path.extname(inputPath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function isSupportedImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/* -------------------------------------------------------------------------- */
/* Synthetic a11y tree from OCR regions                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build a small, honest accessibility shape from the OCR regions: one
 * `generic` root wrapping a `text` node per non-empty region, in reading
 * order. Each node carries the region's bbox in its `states` so downstream
 * annotation can place overlays using the same coordinate space as the image.
 */
function syntheticA11yFromOcr(ocr: OcrResult): A11yNode {
  const children: A11yNode[] = [];
  ocr.regions.forEach((region: OcrRegion, i) => {
    if (region.text.length === 0) return;
    const states: Record<string, string | number | boolean> = {
      x: region.bbox.x,
      y: region.bbox.y,
      width: region.bbox.width,
      height: region.bbox.height,
    };
    if (region.confidence !== null) states["ocrConfidence"] = region.confidence;
    if (region.language !== null) states["language"] = region.language;
    children.push({
      id: null,
      role: "text",
      name: region.text,
      description: null,
      value: region.text,
      states,
      focusable: false,
      interactive: false,
      expanded: null,
      depth: 1,
      children: [],
      domPath: null,
    });
    void i;
  });
  return {
    id: null,
    role: "image",
    name: null === null ? "" : "",
    description: null,
    value: null,
    states: {
      ocrEngine: ocr.engine,
      width: ocr.width,
      height: ocr.height,
    },
    focusable: false,
    interactive: false,
    expanded: null,
    depth: 0,
    children,
    domPath: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Recognised element → IndexedElement                                         */
/* -------------------------------------------------------------------------- */

const ROLE_FROM_KIND: Readonly<Record<RecognizedElement["kind"], string>> = {
  button: "button",
  link: "link",
  textbox: "textbox",
  combobox: "combobox",
  checkbox: "checkbox",
  radio: "radio",
  switch: "switch",
  tab: "tab",
  menuitem: "menuitem",
  option: "option",
  slider: "slider",
  datepicker: "textbox",
  icon: "img",
  other: "generic",
};

function preIndexedFromRecognized(
  elements: readonly RecognizedElement[],
): readonly Omit<IndexedElement, "ref">[] {
  return elements
    .map((el) => {
      const role = ROLE_FROM_KIND[el.kind];
      const states: Record<string, string | number | boolean> = {
        x: el.bbox.x,
        y: el.bbox.y,
        width: el.bbox.width,
        height: el.bbox.height,
        source: "vlm",
      };
      if (el.confidence !== null) states["vlmConfidence"] = el.confidence;
      for (const [k, v] of Object.entries(el.states)) states[k] = v;
      // Interactive flag mirrors whether the role accepts an input.
      const interactive = role !== "generic" && role !== "img";
      return {
        role,
        name: el.label,
        value: null,
        domPath: null,
        depth: 1,
        states,
        enabled: el.states["disabled"] === true ? false : true,
        visible: true,
        ambiguous: false,
        duplicateOf: null,
        containerRole: "image",
        // We use this below only to carry the original ref across the
        // index-build; kept out of the IndexedElement union by casting at the
        // boundary. See `collectRecognizedRefs` for how it is read.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _recognizedRef: el.ref,
      } as unknown as Omit<IndexedElement, "ref"> & { _recognizedRef: string };
    })
    // Sort by reading order so the stable-ref ordinals match the run's order.
    .sort((a, b) => {
      const ay = Number(a.states["y"] ?? 0);
      const by = Number(b.states["y"] ?? 0);
      if (ay !== by) return ay - by;
      const ax = Number(a.states["x"] ?? 0);
      const bx = Number(b.states["x"] ?? 0);
      return ax - bx;
    });
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ingest a single image: OCR + VLM element recognition + indexed elements.
 * Throws `ImageIngestError` on missing input, unavailable OCR engine or
 * unavailable VLM provider.
 *
 * The caller (worker job handler) persists the result. This function does not
 * write any artifacts itself.
 */
export async function ingestImage(
  options: ImageIngestOptions,
): Promise<ImageIngestResult> {
  const started = Date.now();

  // ---------------------------------------------------------------- input --
  const inputPath = options.inputPath ?? null;
  if (inputPath !== null && !existsSync(inputPath)) {
    throw new ImageIngestError(
      `Image file does not exist: ${inputPath}`,
      "file-missing",
    );
  }
  const hasBuffer = options.buffer !== null && options.buffer !== undefined && options.buffer.length > 0;
  if (inputPath === null && !hasBuffer) {
    throw new ImageIngestError(
      "ingestImage requires either `inputPath` (an existing file) or a non-empty `buffer`.",
      "invalid-input",
    );
  }
  const bytes: Buffer =
    hasBuffer && options.buffer !== null && options.buffer !== undefined
      ? options.buffer
      : await readFile(inputPath as string);

  const mimeType = inferMimeType(inputPath, options.mimeType);
  if (!isSupportedImageMime(mimeType)) {
    throw new ImageIngestError(
      `Unsupported MIME type "${mimeType}". ingestImage accepts image/* only.`,
      "invalid-input",
    );
  }
  const contentHash = sha256Hex(bytes);

  // ------------------------------------------------------------------ OCR --
  let ocr: OcrResult;
  try {
    ocr = await runOcr(bytes, {
      engine: options.ocrEngine,
      languages: options.ocrLanguages,
      tesseractLanguages: options.tesseractLanguages,
      timeoutMs: options.ocrTimeoutMs,
      inputPath,
    });
  } catch (err) {
    // Surface OCR failures with a stable error code so job handlers can retry
    // on engine-failed but not on engine-unavailable.
    const code = isOcrErrorCode(err) ? err.code : "internal";
    const message = err instanceof Error ? err.message : String(err);
    throw new ImageIngestError(
      `OCR failed (${code}): ${message}`,
      code === "engine-unavailable" || code === "cloud-not-configured"
        ? "ocr-unavailable"
        : "internal",
    );
  }

  // --------------------------------------------------------- Synthetic a11y -
  const syntheticA11y = syntheticA11yFromOcr(ocr);

  // --------------------------------------------------------------- VLM -----
  let vlm: VlmResult | null = null;
  let indexed: readonly IndexedElement[] = [];
  let elements: ElementIndex = buildElementIndex(
    // Empty root: no interactive elements (OCR-only path).
    {
      id: null,
      role: "image",
      name: "",
      description: null,
      value: null,
      states: {},
      focusable: false,
      interactive: false,
      expanded: null,
      depth: 0,
      children: [],
      domPath: null,
    },
    { assignRef: createStableRefAssigner(), includeDisabled: true, includeUnnamed: true },
  );

  if (options.ocrOnly !== true) {
    try {
      vlm = await recognizeUiElements(
        { image: bytes, ocr },
        {
          provider: options.vlmProvider,
          model: options.vlmModel,
          timeoutMs: options.vlmTimeoutMs,
          inputPath,
          mimeType,
        },
      );
    } catch (err) {
      const code = isVlmErrorCode(err) ? err.code : "internal";
      const message = err instanceof Error ? err.message : String(err);
      throw new ImageIngestError(
        `VLM element recognition failed (${code}): ${message}`,
        code === "provider-unavailable" ? "vlm-unavailable" : "internal",
      );
    }

    // Build the element index in the same scheme the URL path uses.
    const preIndexed = preIndexedFromRecognized(vlm.elements);
    // Synthesize a wrapper root whose children are the pre-indexed entries.
    // `buildElementIndex` walks in pre-order and records `depth`, so we place
    // them at depth 1 beneath a depth-0 root.
    const wrapperRoot: A11yNode = {
      id: null,
      role: "image",
      name: "",
      description: null,
      value: null,
      states: {},
      focusable: false,
      interactive: false,
      expanded: null,
      depth: 0,
      children: preIndexed.map((pre) => preIndexedToA11yNode(pre, 1)),
      domPath: null,
    };
    // We need to preserve the model's own ref (it already used the same slug
    // scheme), so we re-assign refs with a determinstic local assigner that
    // passes through the model ref we stashed on each pre-indexed entry. That
    // keeps refs consistent with the recognizer's own assignment above.
    const refsByOrdinal = new Map<number, string>();
    preIndexed.forEach((pre, i) => {
      const recognised = (pre as unknown as { _recognizedRef?: string })._recognizedRef;
      if (typeof recognised === "string" && recognised.length > 0) {
        refsByOrdinal.set(i, recognised);
      }
    });
    elements = buildElementIndex(wrapperRoot, {
      includeDisabled: true,
      includeUnnamed: true,
      assignRef: (element, ordinal, all) => {
        // Prefer the recognizer's own ref so the two views agree.
        const fromRecogniser = refsByOrdinal.get(ordinal);
        if (fromRecogniser !== undefined) return fromRecogniser;
        // Fall back to the canonical stable-ref assigner for any element the
        // recognizer did not assign (should not happen in practice).
        return createStableRefAssigner()(element, ordinal, all);
      },
    });
    indexed = elements.elements;
  }

  return {
    sourcePath: inputPath,
    contentHash,
    byteLength: bytes.length,
    mimeType,
    ocr,
    vlm,
    elements,
    indexedElements: indexed,
    syntheticA11y,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

function preIndexedToA11yNode(
  pre: Omit<IndexedElement, "ref">,
  depth: number,
): A11yNode {
  return {
    id: null,
    role: pre.role,
    name: pre.name,
    description: null,
    value: pre.value,
    states: pre.states,
    focusable: false,
    interactive: pre.role !== "generic" && pre.role !== "img",
    expanded: null,
    depth,
    children: [],
    domPath: pre.domPath,
  };
}

/* -------------------------------------------------------------------------- */
/* Error guards                                                                */
/* -------------------------------------------------------------------------- */

function isOcrErrorCode(
  err: unknown,
): err is { readonly code: "engine-unavailable" | "engine-failed" | "invalid-input" | "cloud-not-configured" | "internal" } {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "engine-unavailable" ||
    code === "engine-failed" ||
    code === "invalid-input" ||
    code === "cloud-not-configured" ||
    code === "internal"
  );
}

function isVlmErrorCode(
  err: unknown,
): err is { readonly code: "provider-unavailable" | "invalid-input" | "request-failed" | "bad-response" | "internal" } {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "provider-unavailable" ||
    code === "invalid-input" ||
    code === "request-failed" ||
    code === "bad-response" ||
    code === "internal"
  );
}

/* -------------------------------------------------------------------------- */
/* Rehydration (used when reading a stored artifact back)                      */
/* -------------------------------------------------------------------------- */

export interface RehydratedImageIngest {
  readonly sourcePath: string | null;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly ocr: OcrResult;
  readonly vlm: VlmResult | null;
  readonly indexedElements: readonly IndexedElement[];
  readonly syntheticA11y: A11yNode;
  readonly capturedAt: string;
}

export function rehydrateImageIngest(value: unknown): RehydratedImageIngest {
  if (value === null || typeof value !== "object") {
    throw new ImageIngestError("Rehydrate failed: payload is not an object.", "internal");
  }
  const r = value as Record<string, unknown>;
  // Ocr + VLM reuse their own rehydrators so validation lives once.
  const ocr = rehydrateOcrResult(r["ocr"]);
  let vlm: VlmResult | null = null;
  if (r["vlm"] !== null && r["vlm"] !== undefined) {
    vlm = rehydrateVlmResult(r["vlm"]);
  }
  const synthetic = rehydrateSyntheticA11y(r["syntheticA11y"]);
  const indexed: IndexedElement[] = [];
  if (Array.isArray(r["indexedElements"])) {
    for (const item of r["indexedElements"] as unknown[]) {
      if (item === null || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const ref = typeof e["ref"] === "string" ? (e["ref"] as string) : null;
      const role = typeof e["role"] === "string" ? (e["role"] as string) : null;
      if (ref === null || role === null) continue;
      const states: Record<string, string | number | boolean> = {};
      if (e["states"] !== null && typeof e["states"] === "object") {
        for (const [k, v] of Object.entries(e["states"] as Record<string, unknown>)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            states[k] = v;
          }
        }
      }
      indexed.push({
        ref,
        role,
        name: typeof e["name"] === "string" ? (e["name"] as string) : "",
        value:
          typeof e["value"] === "string" || typeof e["value"] === "number" || typeof e["value"] === "boolean"
            ? (e["value"] as string | number | boolean)
            : null,
        domPath: typeof e["domPath"] === "string" ? (e["domPath"] as string) : null,
        depth: typeof e["depth"] === "number" ? (e["depth"] as number) : 0,
        states,
        enabled: e["enabled"] !== false,
        visible: e["visible"] !== false,
        ambiguous: e["ambiguous"] === true,
        duplicateOf: typeof e["duplicateOf"] === "string" ? (e["duplicateOf"] as string) : null,
        containerRole: typeof e["containerRole"] === "string" ? (e["containerRole"] as string) : null,
      });
    }
  }
  return {
    sourcePath: typeof r["sourcePath"] === "string" ? (r["sourcePath"] as string) : null,
    contentHash: typeof r["contentHash"] === "string" ? (r["contentHash"] as string) : "",
    mimeType: typeof r["mimeType"] === "string" ? (r["mimeType"] as string) : "image/png",
    ocr,
    vlm,
    indexedElements: indexed,
    syntheticA11y: synthetic,
    capturedAt: typeof r["capturedAt"] === "string" ? (r["capturedAt"] as string) : "",
  };
}

function rehydrateSyntheticA11y(value: unknown): A11yNode {
  // Reuse the ingest a11y hydrator so the shape contract stays in one place.
  // Imported lazily to avoid a circular looking import at file top (nothing
  // actually cycles, but this keeps the a11y contract visible at the call).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { hydrateA11yNode } = requireA11yHydrate();
  const node = hydrateA11yNode(value);
  if (node === null) {
    throw new ImageIngestError(
      "Rehydrate failed: syntheticA11y is missing or malformed.",
      "internal",
    );
  }
  return node;
}

function requireA11yHydrate(): { hydrateA11yNode: (v: unknown) => A11yNode | null } {
  // Static import already at top of file; this indirection only exists to keep
  // the rehydrate helper self-contained for tests that import the module in
  // isolation.
  return { hydrateA11yNode: (v: unknown) => hydrateA11yInternal(v) };
}

/* Re-export the ingest a11y `hydrateA11yNode` through a local shim so callers
 * do not need to know the module layout. Kept here rather than at module top
 * to keep the import graph obvious. */
import { hydrateA11yNode as hydrateA11yInternal } from "@zipy/ingest/a11y";
import { rehydrateOcrResult } from "@zipy/ingest/ocr";
import { rehydrateVlmResult } from "@zipy/ingest/vlmElements";
