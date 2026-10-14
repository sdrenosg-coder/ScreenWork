/**
 * Zipy AI — Chrome DevTools Protocol helpers.
 *
 * The Playwright driver in `browser.ts` controls the browser through its own
 * protocol binding. This module exposes the *raw* CDP surface for the cases
 * Playwright's high-level API does not cover:
 *   - Reading the uncompressed accessibility tree and, when needed, requesting
 *     the `full` variant instead of Playwright's default `interestingOnly`
 *     projection. The URL ingestion path uses this to build the a11y snapshot
 *     that the synthesizer plans against.
 *   - Capturing a screenshot with `captureBeyondViewport: true`, which is the
 *     only clean way to obtain a full-page screenshot at 2x DPR on pages
 *     taller than the viewport.
 *   - Fetching the raw `DOMSnapshot` for the UI-change-detection diff.
 *   - Emitting and clearing device-metrics overrides so the DPR and viewport
 *     can be reasserted mid-session (some SPA navigations reset them).
 *
 * Chromium is the only engine that speaks CDP. On Firefox/WebKit, every
 * function here throws `CdpUnavailableError` with a message naming the
 * engine, rather than returning empty results that would silently break
 * downstream steps.
 *
 * The `CDPSession` interface is the subset of Playwright's CDP session we
 * actually use. We do not import the playwright types at module scope so the
 * file compiles without the package installed.
 */

import type {
  BrowserSession,
  PlaywrightBrowserContext,
  PlaywrightPage,
} from "./browser.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class CdpUnavailableError extends Error {
  public readonly code = "cdp_unavailable" as const;
  public readonly engine: string;
  constructor(engine: string) {
    super(
      `The Chrome DevTools Protocol is only available on Chromium. ` +
        `This session uses "${engine}". Configure PLAYWRIGHT_BROWSER=chromium ` +
        `to use CDP-backed features, or fall back to the Playwright-only path.`,
    );
    this.name = "CdpUnavailableError";
    this.engine = engine;
  }
}

export class CdpCallError extends Error {
  public readonly code = "cdp_call_error" as const;
  public readonly method: string;
  constructor(method: string, message: string, cause?: unknown) {
    super(`CDP method "${method}" failed: ${message}`);
    this.name = "CdpCallError";
    this.method = method;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Minimal CDP types                                                           */
/* -------------------------------------------------------------------------- */

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
}

/**
 * Playwright's `context.newCDPSession(page)` returns an object that satisfies
 * `CdpSession`. This interface declares the surface rather than importing
 * the concrete type, so the module stays import-safe without Playwright.
 */
interface ContextWithCdp extends PlaywrightBrowserContext {
  newCDPSession?(page: PlaywrightPage): Promise<CdpSession>;
}

/* -------------------------------------------------------------------------- */
/* Session acquisition                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Acquire a CDP session for a page. Throws `CdpUnavailableError` on non-
 * Chromium engines, and `CdpCallError` when the context does not expose
 * `newCDPSession` (older or non-standard drivers).
 *
 * The caller is responsible for calling `detach()` on the returned session
 * when done. `withCdpSession` wraps that for the common case.
 */
export async function openCdpSession(
  session: BrowserSession,
  page: PlaywrightPage = session.page,
): Promise<CdpSession> {
  if (session.kind !== "chromium") {
    throw new CdpUnavailableError(session.kind);
  }
  const ctx = session.context as ContextWithCdp;
  if (typeof ctx.newCDPSession !== "function") {
    throw new CdpCallError(
      "newCDPSession",
      "the current Playwright context does not expose CDP session creation",
    );
  }
  try {
    return await ctx.newCDPSession(page);
  } catch (error) {
    throw new CdpCallError(
      "newCDPSession",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

/**
 * Run `fn` with a CDP session, guaranteeing `detach()` even when `fn` throws.
 * Use this in transaction-style access; use `openCdpSession` when the session
 * must outlive a single function (event subscriptions).
 */
export async function withCdpSession<T>(
  session: BrowserSession,
  fn: (cdp: CdpSession) => Promise<T>,
  page: PlaywrightPage = session.page,
): Promise<T> {
  const cdp = await openCdpSession(session, page);
  try {
    return await fn(cdp);
  } finally {
    try {
      await cdp.detach();
    } catch {
      /* detaching an already-detached session is not an error */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* DOM / Accessibility                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Enable the DOM and Accessibility domains. Some CDP calls require explicit
 * enablement; we enable once per session and it stays on until detach.
 */
export async function enableDomains(cdp: CdpSession): Promise<void> {
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");
}

/** Result shape of `Accessibility.getFullAXTree`. */
export interface CdpAxNode {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly role?: { readonly type: "role"; readonly value: string };
  readonly name?: { readonly type: "computedString"; readonly value: string };
  readonly description?: { readonly type: "computedString"; readonly value: string };
  readonly value?: { readonly type: "computedString"; readonly value: string } | { readonly type: "number"; readonly value: number } | { readonly type: "boolean"; readonly value: boolean };
  readonly childIds?: readonly string[];
  readonly properties?: readonly { readonly name: string; readonly value: { readonly type: string; readonly value: unknown } }[];
}

interface AxFullTreeResponse {
  readonly nodes: readonly CdpAxNode[];
}

/**
 * Fetch the full accessibility tree for the page's main frame. Unlike
 * Playwright's `page.accessibility.snapshot()` this does not apply the
 * "interesting only" filter, so it includes headings, container roles and
 * structural nodes. The URL ingestion path compacts it down to the shape
 * consumed by the synthesizer.
 *
 * The current browser target is assumed — we do not resolve a frame id. If
 * multi-frame support is needed, the caller will have to pass a frameId
 * explicitly via a future parameter; this function intentionally stays
 * simple and answers the main-frame case only.
 */
export async function getFullAccessibilityTree(
  cdp: CdpSession,
): Promise<AxFullTreeResponse> {
  try {
    const raw = await cdp.send("Accessibility.getFullAXTree");
    if (raw === null || typeof raw !== "object") {
      throw new CdpCallError(
        "Accessibility.getFullAXTree",
        "returned a non-object response",
      );
    }
    const nodes = (raw as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) {
      throw new CdpCallError(
        "Accessibility.getFullAXTree",
        "response did not contain a `nodes` array",
      );
    }
    return { nodes: nodes as readonly CdpAxNode[] };
  } catch (error) {
    if (error instanceof CdpCallError) throw error;
    throw new CdpCallError(
      "Accessibility.getFullAXTree",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

/**
 * Fetch the DOM snapshot (used by UI-change detection, which owns the diff)
 * together with structural metadata. The snapshot is large; the caller is
 * expected to reduce it before persisting.
 */
export interface CdpDomSnapshot {
  readonly strings: readonly string[];
  readonly documents: readonly unknown[];
}

export async function getDomSnapshot(cdp: CdpSession): Promise<CdpDomSnapshot> {
  try {
    const raw = await cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: false,
      includeDOMRects: false,
    });
    if (raw === null || typeof raw !== "object") {
      throw new CdpCallError(
        "DOMSnapshot.captureSnapshot",
        "returned a non-object response",
      );
    }
    const strings = (raw as { strings?: unknown }).strings;
    const documents = (raw as { documents?: unknown }).documents;
    if (!Array.isArray(strings) || !Array.isArray(documents)) {
      throw new CdpCallError(
        "DOMSnapshot.captureSnapshot",
        "response did not contain `strings` and `documents` arrays",
      );
    }
    return {
      strings: strings as readonly string[],
      documents: documents as readonly unknown[],
    };
  } catch (error) {
    if (error instanceof CdpCallError) throw error;
    throw new CdpCallError(
      "DOMSnapshot.captureSnapshot",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Screenshots                                                                 */
/* -------------------------------------------------------------------------- */

export interface CdpScreenshotOptions {
  /** "png" for lossless, "webp"/"jpeg" for compressed. Default: "png". */
  readonly format?: "png" | "webp" | "jpeg";
  /** JPEG/WebP quality 0..100. Ignored for PNG. */
  readonly quality?: number;
  /** When true, capture the full scrollable page. Default: true. */
  readonly captureBeyondViewport?: boolean;
  /** CSS-pixel clip rect. When supplied, the screenshot is limited to it. */
  readonly clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly scale?: number };
}

export interface CdpScreenshotResult {
  readonly bytes: Buffer;
  readonly format: "png" | "webp" | "jpeg";
  readonly capturedAt: string;
}

/**
 * Take a screenshot through CDP. `captureBeyondViewport` is honoured by
 * Chromium only; other engines route through the Playwright API (which does
 * not support it, so the caller's later capture.ts treats full-page as best
 * effort). Since CDP is Chromium-only, this function never crosses engines.
 */
export async function captureScreenshotViaCdp(
  cdp: CdpSession,
  opts: CdpScreenshotOptions = {},
): Promise<CdpScreenshotResult> {
  const format: "png" | "webp" | "jpeg" = opts.format ?? "png";
  const params: Record<string, unknown> = {
    format,
    captureBeyondViewport: opts.captureBeyondViewport ?? true,
  };
  if (format !== "png" && typeof opts.quality === "number") {
    params.quality = Math.max(0, Math.min(100, Math.round(opts.quality)));
  }
  if (opts.clip !== undefined) {
    params.clip = { ...opts.clip, scale: opts.clip.scale ?? 1 };
  }
  try {
    const raw = await cdp.send("Page.captureScreenshot", params);
    if (raw === null || typeof raw !== "object") {
      throw new CdpCallError("Page.captureScreenshot", "returned a non-object response");
    }
    const data = (raw as { data?: unknown }).data;
    if (typeof data !== "string" || data.length === 0) {
      throw new CdpCallError(
        "Page.captureScreenshot",
        "response did not contain a base64 `data` string",
      );
    }
    return {
      bytes: Buffer.from(data, "base64"),
      format,
      capturedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof CdpCallError) throw error;
    throw new CdpCallError(
      "Page.captureScreenshot",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Emulation (device metrics)                                                  */
/* -------------------------------------------------------------------------- */

export interface DeviceMetricsOverride {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile?: boolean;
}

/**
 * Reassert viewport + device pixel ratio at the CDP level. Necessary in two
 * cases:
 *   - a page navigated and the browser reset the emulation (rare but real on
 *     Chrome for some SPA navigations);
 *   - a spec set a different override earlier and the current step needs the
 *     canonical capture geometry.
 * Calling it is idempotent.
 */
export async function overrideDeviceMetrics(
  cdp: CdpSession,
  override: DeviceMetricsOverride,
): Promise<void> {
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: override.width,
      height: override.height,
      deviceScaleFactor: override.deviceScaleFactor,
      mobile: override.mobile ?? false,
    });
  } catch (error) {
    throw new CdpCallError(
      "Emulation.setDeviceMetricsOverride",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

/** Clear any device-metrics override previously set on the session. */
export async function clearDeviceMetricsOverride(cdp: CdpSession): Promise<void> {
  try {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  } catch (error) {
    throw new CdpCallError(
      "Emulation.clearDeviceMetricsOverride",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Navigation events                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Wait for a lifecycle event (`load`, `DOMContentLoaded`, `networkIdle`).
 * `networkIdle` is the event Playwright's `waitUntil: "networkidle"` maps to;
 * some long-polling apps never fire it, so the caller must set a timeout.
 */
export async function waitForLifecycle(
  cdp: CdpSession,
  lifecycle: "load" | "DOMContentLoaded" | "networkIdle" | "firstContentfulPaint",
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off("Page.lifecycleEvent", handler);
      reject(
        new CdpCallError(
          "Page.lifecycleEvent",
          `timed out after ${timeoutMs}ms waiting for "${lifecycle}"`,
        ),
      );
    }, timeoutMs);
    const handler = (params: unknown): void => {
      if (params === null || typeof params !== "object") return;
      const name = (params as { name?: unknown }).name;
      if (name === lifecycle) {
        clearTimeout(timer);
        cdp.off("Page.lifecycleEvent", handler);
        resolve();
      }
    };
    cdp.on("Page.lifecycleEvent", handler);
    cdp.send("Page.enable").catch((error: unknown) => {
      clearTimeout(timer);
      cdp.off("Page.lifecycleEvent", handler);
      reject(
        new CdpCallError(
          "Page.enable",
          error instanceof Error ? error.message : String(error),
          error,
        ),
      );
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Convenience: full pipeline in one call                                      */
/* -------------------------------------------------------------------------- */

/**
 * Enable the domains this package needs and override the device metrics to
 * the values `browser.ts` launched with. Call once per CDP session; a caller
 * that opens multiple short-lived sessions should call this at the start of
 * each. Returning the session is deliberate so this composes with
 * `withCdpSession`.
 */
export async function prepareCdpSession(
  session: BrowserSession,
  cdp: CdpSession,
): Promise<CdpSession> {
  await enableDomains(cdp);
  await overrideDeviceMetrics(cdp, {
    width: session.viewport.width,
    height: session.viewport.height,
    deviceScaleFactor: session.deviceScaleFactor,
    mobile: false,
  });
  return cdp;
}
