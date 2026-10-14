/**
 * Zipy AI — screenshot capture for the automated tutorial.
 *
 * Responsibilities:
 *   1. Capture consistent-vieport screenshots at the configured device pixel
 *      ratio. The viewport and DPR are read from `@/lib/config` once and
 *      asserted on every capture so a mid-run emulation reset cannot produce
 *      a mismatched image.
 *   2. Offer four capture modes used by the tutorial UI:
 *        * `viewport`    — the current visual state, clipped to the viewport.
 *        * `fullPage`    — the entire scrollable page (best-effort on non-
 *                          Chromium engines via the Playwright API).
 *        * `element`     — a single element, orthogonally clipped with a
 *                          configurable padding, useful for zoom insets.
 *        * `beforeAfter` — a structured pairing of two states (before/after
 *                          an action), used by the annotate phase to draw a
 *                          diff-aware highlight.
 *   3. Record provenance alongside every capture: URL (query string stripped
 *      unless explicitly retained), viewport, DPR, and the CSS selector used
 *      when the capture was scoped to an element.
 *
 * Design rules honoured here:
 *  - Bytes are returned to the caller. No filesystem writes, no object-store
 *    calls, no persistence decisions. Persistence is the caller's job and the
 *    storage abstraction belongs to `@zipy/storage`.
 *  - Format is a parameter, not a default that silently changes. PNG is the
 *    default because it is lossless; WebP/JPEG are opt-in (the compress
 *    module applies policies AFTER capture so the annotated image has a
 *    predictable pipeline).
 *  - A capture failure produces a structured `CaptureResult` with `bytes:
 *    null` and a `failure` reason. It does not throw for a closed page — the
 *    step executor needs to record "no screenshot available" and continue,
 *    not blow up the run.
 *  - Chromium uses CDP when available (via `cdp.ts`) because
 *    `captureBeyondViewport` is the only reliable full-page primitive; other
 *    engines fall back to `page.screenshot({ fullPage: true })`.
 */

import { getConfig } from "@/lib/config";

import type { BrowserSession, PlaywrightPage } from "./browser.ts";
import {
  captureScreenshotViaCdp,
  openCdpSession,
  overrideDeviceMetrics,
  CdpUnavailableError,
  type CdpSession,
} from "./cdp.ts";
import { sleep, type WaitablePage } from "./waits.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class CaptureError extends Error {
  public readonly code = "capture_error" as const;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CaptureError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type CaptureFormat = "png" | "webp" | "jpeg";
export type CaptureScope = "viewport" | "fullPage" | "element";

export interface CaptureProvenance {
  /** Page URL with the query string stripped unless `redactQuery` is false. */
  readonly url: string;
  /** ISO timestamp of when the capture started. */
  readonly capturedAt: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly kind: "chromium" | "firefox" | "webkit";
  readonly scope: CaptureScope;
  /** Present only for `scope === "element"`. */
  readonly selector: string | null;
  /** Present only for full-page captures. */
  readonly fullPage: boolean;
  /** Format the driver produced the bytes in. */
  readonly format: CaptureFormat;
  /** Native pixel dimensions when the driver supplied them; else null. */
  readonly pixelWidth: number | null;
  readonly pixelHeight: number | null;
}

export type CaptureFailureReason =
  | "page-closed"
  | "element-not-found"
  | "timeout"
  | "unsupported"
  | "internal";

export interface CaptureResult {
  /** Base64-free raw bytes; null when the capture failed. */
  readonly bytes: Buffer | null;
  readonly format: CaptureFormat;
  /** Byte length for quick bookkeeping; 0 when `bytes` is null. */
  readonly byteLength: number;
  /** Provenance recorded regardless of capture success. */
  readonly provenance: CaptureProvenance;
  /** Null on success; a reason on failure. */
  readonly failure: CaptureFailureReason | null;
  /** Human-readable detail when `failure !== null`. */
  readonly failureDetail: string | null;
}

export interface ViewportCaptureOptions {
  readonly format?: CaptureFormat;
  /** JPEG/WebP quality 0..100. Ignored for PNG. */
  readonly quality?: number;
  /**
   * When true, keep the full query string in provenance. When false (the
   * default) only scheme + host + pathname are recorded so tokens embedded in
   * query strings do not end up in stored metadata.
   */
  readonly keepQueryString?: boolean;
  /** Settle delay before capture, ms. Bounded to 500 ms. Default 0. */
  readonly settleMs?: number;
}

export interface FullPageCaptureOptions extends ViewportCaptureOptions {
  /**
   * When true, request a full-page capture through CDP
   * (`captureBeyondViewport: true`). Only Chromium supports this; on other
   * engines the module silently falls back to the Playwright API, which is
   * best-effort on Firefox/WebKit.
   */
  readonly preferCdp?: boolean;
}

export interface ElementCaptureOptions extends ViewportCaptureOptions {
  /** Padding, in CSS pixels, to add around the element's bounding box. */
  readonly paddingPx?: number;
  /**
   * When true and the element is outside the viewport, scroll it into view
   * before capturing. When false (the default) the element is captured as-is
   * — the caller is responsible for scrolling if it needs the element
   * visible in a viewport-scoped image.
   */
  readonly scrollIntoView?: boolean;
  /** Time to wait for the element to reach a visible state. Default 5s. */
  readonly waitTimeoutMs?: number;
}

export interface BeforeAfterCaptureOptions {
  /** The state-changing action whose result this pair documents. */
  readonly action: string;
  /** Options applied to both captures. */
  readonly viewport?: ViewportCaptureOptions;
  /**
   * Delay, in ms, between the "before" capture and the caller's action, and
   * again between the action and the "after" capture. Only used when the
   * action has no observable readiness signal — the caller may pass 0 and
   * use its own wait logic instead.
   */
  readonly settleMs?: number;
}

export interface BeforeAfterResult {
  readonly action: string;
  readonly before: CaptureResult;
  readonly after: CaptureResult;
  /** True when both captures succeeded. */
  readonly complete: boolean;
}

/* -------------------------------------------------------------------------- */
/* Extended page surface                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The Playwright methods this module uses. Declared locally, like
 * `waits.ts` does, so `browser.ts` is not widened with methods unrelated to
 * launching. Playwright's real Page satisfies all of them.
 */
interface LocatorLike {
  boundingBox(options?: { timeout?: number }): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
}

export interface CaptureablePage extends WaitablePage {
  screenshot?(options?: {
    type?: "png" | "jpeg";
    quality?: number;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
    animations?: "disabled" | "allow";
    caret?: "hide" | "initial";
    scale?: "css" | "device";
    timeout?: number;
  }): Promise<Buffer>;
  locator?(selector: string): LocatorLike;
}

/* -------------------------------------------------------------------------- */
/* Canonical geometry                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The canonical capture geometry, read from config so a single env var
 * changes both the browser launch and every capture in the tutorial.
 */
export interface CaptureGeometry {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
}

export function getCaptureGeometry(): CaptureGeometry {
  const browser = getConfig().browser;
  return {
    viewport: { width: browser.viewport.width, height: browser.viewport.height },
    deviceScaleFactor: browser.deviceScaleFactor,
  };
}

/* -------------------------------------------------------------------------- */
/* URL provenance                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Produce a URL string suitable for provenance. Credentials in the userinfo
 * portion are always stripped; the query string is stripped unless the caller
 * asks to keep it. Fragments are preserved because they commonly identify the
 * section a tutorial step is anchored to.
 */
export function provenanceUrl(rawUrl: string, keepQueryString: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Not a URL (empty, relative, or a data: string). Return an empty string
    // rather than echo something that might contain a token.
    return "";
  }
  parsed.username = "";
  parsed.password = "";
  if (!keepQueryString) {
    parsed.search = "";
  }
  return parsed.toString();
}

/* -------------------------------------------------------------------------- */
/* Frame-scoped capture helpers                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read the page's current URL via the optional `url()` accessor. Returns an
 * empty string when the page does not expose it — provenance is informational,
 * not the basis for a decision, so absence is not fatal.
 */
function readUrl(page: PlaywrightPage): string {
  if (typeof page.url === "function") {
    try {
      return page.url();
    } catch {
      return "";
    }
  }
  return "";
}

function pageIsClosed(page: CaptureablePage): boolean {
  if (typeof page.isClosed !== "function") return false;
  try {
    return page.isClosed();
  } catch {
    return false;
  }
}

function clampSettleMs(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(500, Math.floor(ms));
}

/* -------------------------------------------------------------------------- */
/* Failure constructor                                                         */
/* -------------------------------------------------------------------------- */

function failed(
  format: CaptureFormat,
  provenance: CaptureProvenance,
  reason: CaptureFailureReason,
  detail: string,
): CaptureResult {
  return {
    bytes: null,
    format,
    byteLength: 0,
    provenance,
    failure: reason,
    failureDetail: detail,
  };
}

function succeeded(
  format: CaptureFormat,
  provenance: CaptureProvenance,
  bytes: Buffer,
): CaptureResult {
  return {
    bytes,
    format,
    byteLength: bytes.length,
    provenance,
    failure: null,
    failureDetail: null,
  };
}

function makeProvenance(args: {
  readonly sessionOrKind: BrowserSession | { kind: "chromium" | "firefox" | "webkit" };
  readonly page: PlaywrightPage;
  readonly scope: CaptureScope;
  readonly selector: string | null;
  readonly format: CaptureFormat;
  readonly keepQueryString: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly startedAt: number;
  readonly pixelWidth?: number | null;
  readonly pixelHeight?: number | null;
}): CaptureProvenance {
  return {
    url: provenanceUrl(readUrl(args.page), args.keepQueryString),
    capturedAt: new Date(args.startedAt).toISOString(),
    viewport: args.viewport,
    deviceScaleFactor: args.deviceScaleFactor,
    kind: args.sessionOrKind.kind,
    scope: args.scope,
    selector: args.selector,
    fullPage: args.scope === "fullPage",
    format: args.format,
    pixelWidth: args.pixelWidth ?? null,
    pixelHeight: args.pixelHeight ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Viewport capture                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Capture the current visual state, clipped to the viewport. The clip makes
 * the output deterministic even on pages whose content is taller than the
 * configured viewport — a "viewport" capture should be exactly the viewport.
 */
export async function captureViewport(
  session: BrowserSession,
  options: ViewportCaptureOptions = {},
): Promise<CaptureResult> {
  const geometry = getCaptureGeometry();
  const format = options.format ?? "png";
  const keepQueryString = options.keepQueryString ?? false;
  const startedAt = Date.now();
  const page = session.page as CaptureablePage;

  const provenance = makeProvenance({
    sessionOrKind: session,
    page: session.page,
    scope: "viewport",
    selector: null,
    format,
    keepQueryString,
    viewport: geometry.viewport,
    deviceScaleFactor: geometry.deviceScaleFactor,
    startedAt,
    pixelWidth: geometry.viewport.width * geometry.deviceScaleFactor,
    pixelHeight: geometry.viewport.height * geometry.deviceScaleFactor,
  });

  if (pageIsClosed(page)) {
    return failed(format, provenance, "page-closed", "The page was closed before capture.");
  }
  if (typeof page.screenshot !== "function") {
    return failed(
      format,
      provenance,
      "unsupported",
      "The page does not expose `screenshot`; it is not a real Playwright Page.",
    );
  }

  const settleMs = clampSettleMs(options.settleMs);
  if (settleMs > 0) await sleep(settleMs);

  // Chromium: prefer CDP with an explicit viewport clip so the real viewport
  // and the captured rectangle cannot diverge. Non-Chromium: fall back to the
  // Playwright API's clip.
  if (session.kind === "chromium") {
    const cdpResult = await tryCaptureViaCdp(session, {
      format,
      quality: options.quality,
      clip: {
        x: 0,
        y: 0,
        width: geometry.viewport.width,
        height: geometry.viewport.height,
        scale: 1,
      },
      fullPage: false,
    });
    if (cdpResult !== null) {
      return succeeded(format, provenance, cdpResult.bytes);
    }
    // fall through to Playwright API
  }

  const playwrightOptions: {
    type: "png" | "jpeg";
    quality?: number;
    clip: { x: number; y: number; width: number; height: number };
    scale: "css";
    animations: "disabled";
    caret: "hide";
  } = {
    type: format === "png" ? "png" : "jpeg",
    clip: {
      x: 0,
      y: 0,
      width: geometry.viewport.width,
      height: geometry.viewport.height,
    },
    // `scale: "css"` keeps the capture at CSS pixels; the DPR is applied by
    // the context and produces the expected device-pixel image.
    scale: "css",
    animations: "disabled",
    caret: "hide",
  };
  if (format !== "png" && typeof options.quality === "number") {
    playwrightOptions.quality = clampQuality(options.quality);
  }
  try {
    const buffer = await (page.screenshot as NonNullable<CaptureablePage["screenshot"]>)(playwrightOptions);
    return succeeded(format, provenance, toBuffer(buffer));
  } catch (error) {
    return classifyScreenshotError(error, format, provenance);
  }
}

/* -------------------------------------------------------------------------- */
/* Full-page capture                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Capture the entire scrollable page. On Chromium this uses CDP
 * (`captureBeyondViewport: true`) which is the only fully reliable mechanism;
 * on Firefox/WebKit it delegates to the Playwright API and records the
 * fallback in the failure detail when the engine cannot honour the request.
 */
export async function captureFullPage(
  session: BrowserSession,
  options: FullPageCaptureOptions = {},
): Promise<CaptureResult> {
  const geometry = getCaptureGeometry();
  const format = options.format ?? "png";
  const keepQueryString = options.keepQueryString ?? false;
  const startedAt = Date.now();
  const page = session.page as CaptureablePage;

  const provenanceBase = makeProvenance({
    sessionOrKind: session,
    page: session.page,
    scope: "fullPage",
    selector: null,
    format,
    keepQueryString,
    viewport: geometry.viewport,
    deviceScaleFactor: geometry.deviceScaleFactor,
    startedAt,
  });

  if (pageIsClosed(page)) {
    return failed(format, provenanceBase, "page-closed", "The page was closed before capture.");
  }
  if (typeof page.screenshot !== "function") {
    return failed(
      format,
      provenanceBase,
      "unsupported",
      "The page does not expose `screenshot`; it is not a real Playwright Page.",
    );
  }

  const settleMs = clampSettleMs(options.settleMs);
  if (settleMs > 0) await sleep(settleMs);

  const preferCdp = options.preferCdp ?? true;
  if (preferCdp && session.kind === "chromium") {
    const cdpResult = await tryCaptureViaCdp(session, {
      format,
      quality: options.quality,
      captureBeyondViewport: true,
    });
    if (cdpResult !== null) {
      return succeeded(format, provenanceBase, cdpResult.bytes);
    }
  }

  const playwrightOptions: {
    type: "png" | "jpeg";
    quality?: number;
    fullPage: true;
    animations: "disabled";
    caret: "hide";
  } = {
    type: format === "png" ? "png" : "jpeg",
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  };
  if (format !== "png" && typeof options.quality === "number") {
    playwrightOptions.quality = clampQuality(options.quality);
  }
  try {
    const buffer = await (page.screenshot as NonNullable<CaptureablePage["screenshot"]>)(playwrightOptions);
    return succeeded(format, provenanceBase, toBuffer(buffer));
  } catch (error) {
    return classifyScreenshotError(error, format, provenanceBase);
  }
}

/* -------------------------------------------------------------------------- */
/* Element capture                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Capture a single element, optionally padded. Useful for building the
 * "magnified inset" the annotate phase places on a step screenshot when the
 * target control is small.
 *
 * The element is located by CSS selector. When the selector matches nothing,
 * the function returns a structured `element-not-found` failure rather than
 * attempting a fallback (retry.ts owns fallback selectors; the capture path
 * must stay honest about what it found).
 */
export async function captureElement(
  session: BrowserSession,
  selector: string,
  options: ElementCaptureOptions = {},
): Promise<CaptureResult> {
  const geometry = getCaptureGeometry();
  const format = options.format ?? "png";
  const keepQueryString = options.keepQueryString ?? false;
  const startedAt = Date.now();
  const page = session.page as CaptureablePage;

  const provenanceBase = (pixelWidth: number | null, pixelHeight: number | null): CaptureProvenance =>
    makeProvenance({
      sessionOrKind: session,
      page: session.page,
      scope: "element",
      selector,
      format,
      keepQueryString,
      viewport: geometry.viewport,
      deviceScaleFactor: geometry.deviceScaleFactor,
      startedAt,
      pixelWidth,
      pixelHeight,
    });

  if (pageIsClosed(page)) {
    return failed(format, provenanceBase(null, null), "page-closed", "The page was closed before capture.");
  }
  if (typeof page.locator !== "function" || typeof page.screenshot !== "function") {
    return failed(
      format,
      provenanceBase(null, null),
      "unsupported",
      "The page does not expose `locator` / `screenshot`; it is not a real Playwright Page.",
    );
  }

  const locator = page.locator(selector);
  const waitTimeoutMs = typeof options.waitTimeoutMs === "number" && options.waitTimeoutMs > 0
    ? Math.floor(options.waitTimeoutMs)
    : 5_000;

  try {
    if (options.scrollIntoView === true) {
      await locator.scrollIntoViewIfNeeded({ timeout: waitTimeoutMs });
    }
    const box = await locator.boundingBox({ timeout: waitTimeoutMs });
    if (box === null) {
      return failed(
        format,
        provenanceBase(null, null),
        "element-not-found",
        `Locator "${selector}" did not resolve to a visible element with a bounding box.`,
      );
    }
    const padding = typeof options.paddingPx === "number" && Number.isFinite(options.paddingPx)
      ? Math.max(0, Math.floor(options.paddingPx))
      : 0;

    // Clamp the clip rect to the page's document bounds. Playwright returns
    // boxes relative to the page (not the viewport) for full-page captures,
    // but for viewport-scoped screenshots the clip must be within the
    // viewport. We therefore clip to the viewport here.
    const clipX = Math.max(0, Math.floor(box.x - padding));
    const clipY = Math.max(0, Math.floor(box.y - padding));
    const clipW = Math.min(
      geometry.viewport.width - clipX,
      Math.max(1, Math.ceil(box.width + padding * 2)),
    );
    const clipH = Math.min(
      geometry.viewport.height - clipY,
      Math.max(1, Math.ceil(box.height + padding * 2)),
    );

    const pixelWidth = clipW * geometry.deviceScaleFactor;
    const pixelHeight = clipH * geometry.deviceScaleFactor;
    const provenance = provenanceBase(pixelWidth, pixelHeight);

    const settleMs = clampSettleMs(options.settleMs);
    if (settleMs > 0) await sleep(settleMs);

    if (session.kind === "chromium") {
      const cdpResult = await tryCaptureViaCdp(session, {
        format,
        quality: options.quality,
        clip: { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 },
        captureBeyondViewport: false,
      });
      if (cdpResult !== null) {
        return succeeded(format, provenance, cdpResult.bytes);
      }
    }

    const playwrightOptions: {
      type: "png" | "jpeg";
      quality?: number;
      clip: { x: number; y: number; width: number; height: number };
      scale: "css";
      animations: "disabled";
      caret: "hide";
    } = {
      type: format === "png" ? "png" : "jpeg",
      clip: { x: clipX, y: clipY, width: clipW, height: clipH },
      scale: "css",
      animations: "disabled",
      caret: "hide",
    };
    if (format !== "png" && typeof options.quality === "number") {
      playwrightOptions.quality = clampQuality(options.quality);
    }
    const buffer = await (page.screenshot as NonNullable<CaptureablePage["screenshot"]>)(playwrightOptions);
    return succeeded(format, provenance, toBuffer(buffer));
  } catch (error) {
    return classifyScreenshotError(error, format, provenanceBase(null, null));
  }
}

/* -------------------------------------------------------------------------- */
/* Before/after                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Capture a before/after pair around a caller-supplied action. The action is
 * performed by the caller between the two captures — the shape is:
 *
 *   const pair = await withBeforeAfter(session, "Click Save", async () => {
 *     await clickSave();
 *   });
 *
 * If the action throws, the function records the "after" capture as failed
 * and re-throws the action error so the caller sees the original failure.
 */
export async function withBeforeAfter<T>(
  session: BrowserSession,
  action: string,
  run: () => Promise<T>,
  options: BeforeAfterCaptureOptions = {},
): Promise<{ readonly result: T; readonly pair: BeforeAfterResult }> {
  const viewportOptions: ViewportCaptureOptions = options.viewport ?? {};
  const settleMs = clampSettleMs(options.settleMs);

  const before = await captureViewport(session, {
    ...viewportOptions,
    settleMs: settleMs > 0 ? settleMs : viewportOptions.settleMs,
  });

  let result: T;
  try {
    result = await run();
  } catch (error) {
    // Even on action failure, attempt the after capture so the reviewer can
    // see what state the page ended in. Then re-throw the original error.
    const afterOnFailure = await captureViewport(session, {
      ...viewportOptions,
      settleMs: settleMs > 0 ? settleMs : viewportOptions.settleMs,
    });
    throw Object.assign(
      new CaptureError(
        `Action "${action}" failed during before/after capture: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      ),
      {
        before,
        after: afterOnFailure,
      },
    );
  }

  const after = await captureViewport(session, {
    ...viewportOptions,
    settleMs: settleMs > 0 ? settleMs : viewportOptions.settleMs,
  });

  return {
    result,
    pair: {
      action,
      before,
      after,
      complete: before.failure === null && after.failure === null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* CDP helper                                                                  */
/* -------------------------------------------------------------------------- */

interface CdpCaptureArgs {
  readonly format: CaptureFormat;
  readonly quality?: number;
  readonly captureBeyondViewport?: boolean;
  readonly clip?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly scale?: number;
  };
}

/**
 * Attempt a CDP screenshot; return null when CDP is unavailable (non-
 * Chromium, or the context does not expose `newCDPSession`) so the caller can
 * fall back to the Playwright API. CDP *call* failures (a real error from a
 * real Chromium session) are surfaced as null too, because the caller has a
 * working fallback and a CDP-specific error would be less useful than the
 * Playwright result.
 */
async function tryCaptureViaCdp(
  session: BrowserSession,
  args: CdpCaptureArgs,
): Promise<{ readonly bytes: Buffer } | null> {
  let cdp: CdpSession;
  try {
    cdp = await openCdpSession(session);
  } catch (error) {
    if (error instanceof CdpUnavailableError) return null;
    return null;
  }
  try {
    // Reassert device metrics so a mid-run emulation reset cannot silently
    // change the DPR. This is idempotent on a correctly-configured session.
    const geometry = getCaptureGeometry();
    try {
      await overrideDeviceMetrics(cdp, {
        width: geometry.viewport.width,
        height: geometry.viewport.height,
        deviceScaleFactor: geometry.deviceScaleFactor,
        mobile: false,
      });
    } catch {
      /* best effort; the session's own launch defaults may already be correct */
    }
    const result = await captureScreenshotViaCdp(cdp, {
      format: args.format,
      quality: args.quality,
      captureBeyondViewport: args.captureBeyondViewport ?? true,
      clip: args.clip,
    });
    return { bytes: result.bytes };
  } catch {
    return null;
  } finally {
    try {
      await cdp.detach();
    } catch {
      /* detaching twice is not an error */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Error classification                                                        */
/* -------------------------------------------------------------------------- */

function classifyScreenshotError(
  error: unknown,
  format: CaptureFormat,
  provenance: CaptureProvenance,
): CaptureResult {
  if (error === null || typeof error !== "object") {
    return failed(format, provenance, "internal", String(error));
  }
  const e = error as { name?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  if (e.name === "TimeoutError" || message.includes("Timeout ")) {
    return failed(format, provenance, "timeout", message);
  }
  if (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Page closed") ||
    message.includes("been closed")
  ) {
    return failed(format, provenance, "page-closed", message);
  }
  return failed(format, provenance, "internal", message.length > 0 ? message : "unknown error");
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 80;
  return Math.max(0, Math.min(100, Math.round(quality)));
}

/**
 * Normalise the screenshot return into a Buffer. Playwright returns a Buffer;
 * a reduced driver might return a Uint8Array. This is the single place that
 * coercion happens.
 */
function toBuffer(value: Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value);
}
