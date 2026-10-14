/**
 * Zipy AI — Playwright browser lifecycle.
 *
 * Owns exactly one thing: how a headless browser is launched, one context is
 * derived from it, and both are torn down without leaking. Every later module
 * in this package (cdp, capture, retry, selectors, changeDetect) receives the
 * `BrowserSession` produced here rather than importing Playwright itself, so
 * there is one launch surface to reconfigure (headless mode, viewport, DPR,
 * proxy, browser kind) and one shutdown surface to get right.
 *
 * Design rules honoured here:
 *  - No credentials, no proxy and no browser binary path are invented. The
 *    launcher reads them from `@/lib/config`. When a proxy is configured, the
 *    proxy URL is passed through unchanged; when it is not, no proxy is used.
 *  - `chromium` is the default because CDP is only available there. Firefox
 *    and WebKit are usable through this module (`config.browser.browserKind`),
 *    but `cdp.ts` will refuse to attach on those engines — the caller decides
 *    whether to fall back to non-CDP control.
 *  - Playwright is imported dynamically (`await import("playwright")`), so
 *    this module is safe to compile in environments where the package is not
 *    installed. A launcher call fails with a description of the missing
 *    dependency rather than an unhelpful stack trace.
 *  - A `BrowserSession` is a small record of live handles. It is bound to the
 *    `close()` on the context, not on the browser, so a worker that pools
 *    browsers can keep one browser and open many contexts. `closeBrowser()`
 *    exists for the pooled case.
 */

import { getConfig } from "@/lib/config";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class BrowserLaunchError extends Error {
  public readonly code = "browser_launch_error" as const;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BrowserLaunchError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export class BrowserNotInstalledError extends Error {
  public readonly code = "browser_not_installed" as const;
  constructor(message: string) {
    super(message);
    this.name = "BrowserNotInstalledError";
  }
}

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A live session: browser + context + a first page. Later modules open
 * additional pages via `session.context.newPage()`; this struct also records
 * the launch options so a re-launch on browser crash can reproduce them
 * without re-reading config (config is memoized, but being explicit here
 * makes the crash path cheap and auditable).
 */
export interface BrowserSession {
  readonly kind: "chromium" | "firefox" | "webkit";
  readonly browser: PlaywrightBrowser;
  readonly context: PlaywrightBrowserContext;
  readonly page: PlaywrightPage;
  readonly launchedAt: string;
  readonly headless: boolean;
  readonly deviceScaleFactor: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly proxyUsed: string | null;
  /** True once `closeSession` has been called; later calls are no-ops. */
  closed: boolean;
}

/**
 * Minimal structural types for the Playwright objects this module touches.
 * We define them here rather than importing `playwright` at module scope so
 * the file compiles in projects where Playwright is not installed (the
 * dynamic import is the only place that needs the real package).
 */
export interface PlaywrightBrowser {
  newContext(options?: unknown): Promise<PlaywrightBrowserContext>;
  newPage(options?: unknown): Promise<PlaywrightPage>;
  close(): Promise<void>;
  isConnected(): boolean;
  contexts(): readonly PlaywrightBrowserContext[];
}

export interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
  pages(): readonly PlaywrightPage[];
  browser(): PlaywrightBrowser | null;
  addInitScript?(script: { content?: string; path?: string }): Promise<void>;
  setDefaultTimeout?(timeoutMs: number): void;
  setDefaultNavigationTimeout?(timeoutMs: number): void;
}

export interface PlaywrightPage {
  goto(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number },
  ): Promise<unknown>;
  waitForLoadState?(state?: "load" | "domcontentloaded" | "networkidle", options?: { timeout?: number }): Promise<void>;
  gotoUrl?: string;
  url?(): string;
  close(): Promise<void>;
  isClosed?(): boolean;
  viewportSize?(): { width: number; height: number } | null;
  screenshot?(options?: unknown): Promise<Buffer>;
  setViewportSize?(size: { width: number; height: number }): Promise<void>;
  keyboard?: { press(key: string, options?: { delay?: number }): Promise<void>; type(text: string, options?: { delay?: number }): Promise<void> };
  mouse?: { click(x: number, y: number, options?: unknown): Promise<void>; move(x: number, y: number, options?: unknown): Promise<void> };
  evaluate?<T = unknown>(fn: string | ((...args: unknown[]) => T), arg?: unknown): Promise<T>;
  getByRole?(role: string, options?: { name?: string | RegExp; exact?: boolean }): unknown;
  getByLabel?(label: string | RegExp, options?: { exact?: boolean }): unknown;
  getByText?(text: string | RegExp, options?: { exact?: boolean }): unknown;
  getByPlaceholder?(placeholder: string | RegExp, options?: { exact?: boolean }): unknown;
  getByTestId?(id: string): unknown;
}

/* -------------------------------------------------------------------------- */
/* Playwright dynamic import                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Minimal structural surface of the `playwright` module that this package
 * uses. Only what is imported is named; nothing else is claimed.
 */
interface PlaywrightModule {
  readonly chromium: { launch(options?: unknown): Promise<PlaywrightBrowser> };
  readonly firefox: { launch(options?: unknown): Promise<PlaywrightBrowser> };
  readonly webkit: { launch(options?: unknown): Promise<PlaywrightBrowser> };
}

let playwrightModule: PlaywrightModule | null = null;

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (playwrightModule !== null) return playwrightModule;
  try {
    const mod = (await import("playwright")) as unknown as PlaywrightModule;
    if (
      mod === null ||
      typeof mod !== "object" ||
      mod.chromium === undefined ||
      typeof mod.chromium.launch !== "function"
    ) {
      throw new BrowserNotInstalledError(
        "The 'playwright' package did not expose a `chromium.launch` function. " +
          "Install it with `npm install playwright` and run `npx playwright install` " +
          "to fetch browser binaries.",
      );
    }
    playwrightModule = mod;
    return mod;
  } catch (error) {
    throw new BrowserNotInstalledError(
      "The 'playwright' package is not available. Install it in the worker " +
        "workspace (`npm install playwright`) and download the browser binaries " +
        "(`npx playwright install chromium`). " +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Reset the dynamic import cache — tests only. */
export function resetPlaywrightImportForTests(): void {
  playwrightModule = null;
}

/* -------------------------------------------------------------------------- */
/* Launch options                                                              */
/* -------------------------------------------------------------------------- */

export interface LaunchOptions {
  /** Override headless mode. Default: config.browser.headless. */
  readonly headless?: boolean;
  /** Override browser kind. Default: config.browser.browserKind. */
  readonly kind?: "chromium" | "firefox" | "webkit";
  /** Override viewport. Default: config.browser.viewport. */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Override device pixel ratio. Default: config.browser.deviceScaleFactor. */
  readonly deviceScaleFactor?: number;
  /** Override the proxy URL. Default: config.browser.proxyUrl. */
  readonly proxyUrl?: string | null;
  /**
   * User-data-dir. Optional; when supplied the context is persistent rather
   * than ephemeral. Use with care: persistent contexts carry state across
   * runs, which breaks the "fresh context" assumption the capture phase
   * relies on. Default: undefined (ephemeral).
   */
  readonly userDataDir?: string;
}

interface ResolvedLaunch {
  readonly kind: "chromium" | "firefox" | "webkit";
  readonly headless: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly proxyUrl: string | null;
  readonly arguments: readonly string[];
}

/**
 * Chromium-specific arguments that are *always* set. These are the minimum
 * needed for a containerised runtime (Replit, Docker) where `/dev/shm` is
 * small and the sandbox is off:
 *   - `--disable-dev-shm-usage` prevents crashes when Chromium exhausts /dev/shm
 *   - `--no-sandbox` is required in most managed container environments;
 *     a caller running on a host with working sandboxing can override.
 *   - `--disable-gpu` avoids the headless GPU path, which is unstable in
 *     ARM containers.
 *   - `--hide-scrollbars` makes the captured screenshots deterministic in
 *     width — the scrollbar would otherwise shift the content region by
 *     ~15px depending on the page.
 * Firefox and WebKit are launched with no extra args; those engines do not
 * need the Chromium workarounds.
 */
function defaultChromiumArgs(): readonly string[] {
  return [
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
}

function resolveLaunchOptions(opts: LaunchOptions): ResolvedLaunch {
  const config = getConfig();
  const kind = opts.kind ?? config.browser.browserKind;
  const headless = opts.headless ?? config.browser.headless;
  const viewport = opts.viewport ?? config.browser.viewport;
  const deviceScaleFactor = opts.deviceScaleFactor ?? config.browser.deviceScaleFactor;
  const proxyUrl = opts.proxyUrl !== undefined ? opts.proxyUrl : config.browser.proxyUrl;
  return {
    kind,
    headless,
    viewport,
    deviceScaleFactor,
    proxyUrl,
    arguments: kind === "chromium" ? defaultChromiumArgs() : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Launch a browser and open one context + one page. The returned session owns
 * the context and page; the browser is also owned by the session — this is
 * the non-pooled case. A worker that pools browsers should call
 * `launchBrowserOnly` and `newContextFrom` separately.
 */
export async function launchSession(opts: LaunchOptions = {}): Promise<BrowserSession> {
  const resolved = resolveLaunchOptions(opts);

  const playwright = await loadPlaywright();
  const launcher = playwright[resolved.kind];

  const launchArgs: Record<string, unknown> = {
    headless: resolved.headless,
    args: resolved.arguments,
  };
  if (resolved.proxyUrl !== null) {
    // Playwright expects `{ server: "http://proxyname:port", username?, password? }`.
    // The URL as provided by the operator is passed through unchanged; the
    // username/password, when embedded in the URL, are parsed by Playwright.
    launchArgs.proxy = { server: resolved.proxyUrl };
  }
  if (opts.userDataDir !== undefined) {
    launchArgs.userDataDir = opts.userDataDir;
  }

  let browser: PlaywrightBrowser;
  try {
    browser = await launcher.launch(launchArgs);
  } catch (error) {
    throw new BrowserLaunchError(
      `Failed to launch ${resolved.kind}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }

  let context: PlaywrightBrowserContext;
  try {
    context = await browser.newContext({
      viewport: resolved.viewport,
      deviceScaleFactor: resolved.deviceScaleFactor,
      // Capture both the main frame and iframes off-screen so screenshots
      // are not blank when the page scrolls.
      isMobile: false,
      hasTouch: false,
    });
  } catch (error) {
    await safeClose(browser);
    throw new BrowserLaunchError(
      `Browser launched but context creation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }

  // Apply timeouts so the caller does not have to set them on every action.
  if (typeof context.setDefaultTimeout === "function") {
    context.setDefaultTimeout(configDefaultTimeoutMs());
  }
  if (typeof context.setDefaultNavigationTimeout === "function") {
    context.setDefaultNavigationTimeout(configNavigationTimeoutMs());
  }

  let page: PlaywrightPage;
  try {
    page = await context.newPage();
  } catch (error) {
    await safeClose(context);
    await safeClose(browser);
    throw new BrowserLaunchError(
      `Context created but page creation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }

  // Ensure the page has the requested viewport even if the context default
  // drifted; this is what the capture phase relies on for consistent widths.
  if (typeof page.setViewportSize === "function") {
    try {
      await page.setViewportSize(resolved.viewport);
    } catch {
      /* best effort; a context-level viewport setting is authoritative */
    }
  }

  const session: BrowserSession = {
    kind: resolved.kind,
    browser,
    context,
    page,
    launchedAt: new Date().toISOString(),
    headless: resolved.headless,
    deviceScaleFactor: resolved.deviceScaleFactor,
    viewport: resolved.viewport,
    proxyUsed: resolved.proxyUrl,
    closed: false,
  };
  return session;
}

/**
 * Close a session in the safe order (page → context → browser). Any step that
 * fails does not prevent the following steps from being attempted. The
 * session's `closed` flag is set regardless; calling twice is a no-op.
 */
export async function closeSession(session: BrowserSession): Promise<void> {
  if (session.closed) return;
  await safeClose(session.page);
  await safeClose(session.context);
  await safeClose(session.browser);
  session.closed = true;
}

/**
 * Close just a page (leave context and browser open). Used by the review
 * phase when it detaches from a session but the worker keeps the context for
 * the next step.
 */
export async function closePage(page: PlaywrightPage): Promise<void> {
  await safeClose(page);
}

/**
 * Close just a context. Used by the pooled browser-farm path (later phase).
 */
export async function closeContext(context: PlaywrightBrowserContext): Promise<void> {
  await safeClose(context);
}

/**
 * Launch a browser without creating a context. Used by browser-farm pooling.
 */
export async function launchBrowserOnly(
  opts: LaunchOptions = {},
): Promise<{ readonly kind: "chromium" | "firefox" | "webkit"; readonly browser: PlaywrightBrowser; readonly headless: boolean; readonly proxyUsed: string | null }> {
  const resolved = resolveLaunchOptions(opts);
  const playwright = await loadPlaywright();
  const launcher = playwright[resolved.kind];
  const launchArgs: Record<string, unknown> = {
    headless: resolved.headless,
    args: resolved.arguments,
  };
  if (resolved.proxyUrl !== null) launchArgs.proxy = { server: resolved.proxyUrl };
  if (opts.userDataDir !== undefined) launchArgs.userDataDir = opts.userDataDir;

  let browser: PlaywrightBrowser;
  try {
    browser = await launcher.launch(launchArgs);
  } catch (error) {
    throw new BrowserLaunchError(
      `Failed to launch ${resolved.kind}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
  return {
    kind: resolved.kind,
    browser,
    headless: resolved.headless,
    proxyUsed: resolved.proxyUrl,
  };
}

/**
 * Derive a new context + page from an existing browser. Use with
 * `launchBrowserOnly` to pool browsers across workflows.
 */
export async function newContextFrom(
  browser: PlaywrightBrowser,
  opts: LaunchOptions = {},
): Promise<{ readonly context: PlaywrightBrowserContext; readonly page: PlaywrightPage }> {
  const resolved = resolveLaunchOptions(opts);
  const context = await browser.newContext({
    viewport: resolved.viewport,
    deviceScaleFactor: resolved.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
  });
  if (typeof context.setDefaultTimeout === "function") {
    context.setDefaultTimeout(configDefaultTimeoutMs());
  }
  if (typeof context.setDefaultNavigationTimeout === "function") {
    context.setDefaultNavigationTimeout(configNavigationTimeoutMs());
  }
  const page = await context.newPage();
  if (typeof page.setViewportSize === "function") {
    try {
      await page.setViewportSize(resolved.viewport);
    } catch {
      /* best effort */
    }
  }
  return { context, page };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function configDefaultTimeoutMs(): number {
  return getConfig().browser.defaultTimeoutMs;
}

function configNavigationTimeoutMs(): number {
  return getConfig().browser.navigationTimeoutMs;
}

async function safeClose(target: { close(): Promise<void> } | null | undefined): Promise<void> {
  if (target === null || target === undefined) return;
  try {
    await target.close();
  } catch {
    /* closing twice, or closing an already-closed target, is expected */
  }
}

/**
 * Report whether CDP is available for the given session — a pure function of
 * the browser kind, kept here so callers do not re-derive the rule.
 */
export function supportsCdp(sessionOrKind: BrowserSession | "chromium" | "firefox" | "webkit"): boolean {
  const kind = typeof sessionOrKind === "string" ? sessionOrKind : sessionOrKind.kind;
  return kind === "chromium";
}
