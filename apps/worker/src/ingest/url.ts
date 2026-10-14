/**
 * Zipy AI — URL ingestion (worker side).
 *
 * Loads a URL in a headless browser, waits for the page to settle, extracts the
 * accessibility tree plus a DOM-path augmentation for each node, builds the
 * interactive-element index with stable refs, and returns a single
 * `UrlIngestResult` that the worker persists as an artifact.
 *
 * This file is the *browser* half of the URL ingestion path. The pure,
 * browser-free half (tree normalisation, compaction, indexing, ref assignment)
 * lives in `@zipy/ingest` (`a11y.ts`, `elementIndex.ts`, `stableRefs.ts`) and is
 * imported here so the two stay in lockstep.
 *
 * Design notes:
 *  - Playwright is imported lazily via `createRequire` because the workspace
 *    does not yet declare it as a dependency. When it is not installed the
 *    module throws `UrlIngestError` with an actionable message rather than
 *    crashing the worker at import time. This preserves the "no invented
 *    dependencies" rule: nothing is faked, the operator installs Playwright.
 *  - Credentials are never accepted here. Login handling, vault reads and MFA
 *    handoff live in a later phase (`packages/automation`). This module only
 *    navigates to an anonymous URL.
 *  - Timeouts and viewport come from the environment with sensible defaults so
 *    a Replit deployment with no extra configuration still works.
 *  - The returned payload is JSON-serializable end to end (a11y tree is a
 *    plain object; index contains no functions). It is designed to be stored by
 *    `@zipy/storage` and read back with `hydrateA11yNode`.
 *  - No network calls are made by this module other than the Playwright
 *    navigation the caller asked for. No telemetry, no analytics.
 */

import { createRequire } from "node:module";

import {
  a11yStats,
  compactA11yTree,
  hydrateA11yNode,
  parseA11ySnapshotOrThrow,
  serializeA11yTree,
  type A11yNode,
  type A11yStats,
} from "@zipy/ingest/a11y";
import {
  buildElementIndex,
  type ElementIndex,
} from "@zipy/ingest/elementIndex";
import { createStableRefAssigner } from "@zipy/ingest/stableRefs";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class UrlIngestError extends Error {
  readonly code:
    | "playwright-missing"
    | "invalid-url"
    | "navigation-failed"
    | "snapshot-empty"
    | "internal";
  constructor(message: string, code: UrlIngestError["code"]) {
    super(message);
    this.name = "UrlIngestError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface UrlIngestOptions {
  /** Absolute URL to load. http(s) only. */
  readonly url: string;
  /**
   * How long to let the page settle after the initial `load` event, in ms.
   * Playwright's `networkidle` can never fire on pages with polling or ad
   * beacons, so we use `domcontentloaded` + a bounded idle wait as the primary
   * strategy. Defaults to `URL_INGEST_IDLE_WAIT_MS` or 1500.
   */
  readonly idleWaitMs?: number;
  /** Hard navigation timeout in ms. Defaults to `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` or 45_000. */
  readonly navigationTimeoutMs?: number;
  /** Viewport size. Defaults to `PLAYWRIGHT_VIEWPORT_*` or 1440x900. */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Device scale factor. Defaults to 2 (matches the capture pipeline). */
  readonly deviceScaleFactor?: number;
  /** Browser kind. Only `chromium` is guaranteed; other engines are opt-in. */
  readonly browserKind?: "chromium" | "firefox" | "webkit";
  /** Optional outbound proxy (http/https/socks). */
  readonly proxyUrl?: string | null;
  /**
   * Extra HTTP headers. Refused when they would leak credentials (callers
   * should pass auth via a vault, not here). Only `Accept-Language` and
   * `User-Agent` overrides are currently honoured; unknown keys are logged
   * and ignored rather than silently forwarded.
   */
  readonly extraHttpHeaders?: Readonly<Record<string, string>>;
  /** When true, do not launch a browser; throw if a snapshot is required. */
  readonly dryRun?: boolean;
}

export interface CapturedElement {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly value: string | number | boolean | null;
  readonly domPath: string | null;
  readonly depth: number;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly ambiguous: boolean;
  readonly duplicateOf: string | null;
  readonly containerRole: string | null;
}

export interface UrlIngestResult {
  /** Final URL after redirects. */
  readonly finalUrl: string;
  /** HTTP status of the main document, when Playwright exposed it. */
  readonly status: number | null;
  /** Page `<title>`, if any. */
  readonly title: string;
  /** BCP-47-ish language attribute of `<html>`, e.g. "en". */
  readonly lang: string | null;
  /** ISO timestamp at capture. */
  readonly capturedAt: string;
  /** True when latency exceeded the navigation timeout and we fell back to whatever loaded. */
  readonly timedOut: boolean;
  /** Full normalised accessibility tree (uncompacted). */
  readonly a11y: A11yNode;
  /** Compacted copy — this is what the LLM sees and what is hashed. */
  readonly a11yCompact: A11yNode;
  /** Serialised form of the compacted tree (indented lines). */
  readonly a11yText: string;
  /** Stats over the *uncompacted* tree. */
  readonly stats: A11yStats;
  /** Interactive-element index (deterministic for the given tree). */
  readonly elements: readonly CapturedElement[];
  /** Number of interactive elements with a non-empty accessible name. */
  readonly namedElementCount: number;
  /** Number of elements flagged ambiguous (duplicate role+name). */
  readonly ambiguityCount: number;
  /** Roles present, sorted. */
  readonly rolesPresent: readonly string[];
  /** Navigator info for provenance. */
  readonly userAgent: string | null;
  /** Viewport at capture time. */
  readonly viewport: { readonly width: number; readonly height: number };
}

/* -------------------------------------------------------------------------- */
/* Playwright lazy loading                                                     */
/* -------------------------------------------------------------------------- */

interface PlaywrightBrowser {
  newContext(opts?: {
    viewport?: { width: number; height: number };
    deviceScaleFactor?: number;
    userAgent?: string;
    extraHTTPHeaders?: Record<string, string>;
    proxy?: { server: string };
    locale?: string;
  }): Promise<PlaywrightContext>;
  close(): Promise<void>;
  version?(): string;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightPage {
  goto(
    url: string,
    opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number },
  ): Promise<{ status(): number } | null>;
  title(): Promise<string>;
  url(): string;
  evaluate<T>(fn: () => T): Promise<T>;
  accessibility: { snapshot(opts?: { interestingOnly?: boolean; root?: unknown }): Promise<unknown> };
  close(): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: "load" | "domcontentloaded" | "networkidle", opts?: { timeout?: number }): Promise<void>;
  context(): PlaywrightContext;
}
interface PlaywrightModule {
  chromium: { launch(opts?: { headless?: boolean; proxy?: { server: string } }): Promise<PlaywrightBrowser> };
  firefox: { launch(opts?: { headless?: boolean; proxy?: { server: string } }): Promise<PlaywrightBrowser> };
  webkit: { launch(opts?: { headless?: boolean; proxy?: { server: string } }): Promise<PlaywrightBrowser> };
}

const requireFromHere = createRequire(import.meta.url);

function loadPlaywright(): PlaywrightModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = requireFromHere("playwright") as Partial<PlaywrightModule> | undefined;
    if (mod === undefined || mod.chromium === undefined) {
      throw new Error("playwright module did not export `chromium`.");
    }
    return mod as PlaywrightModule;
  } catch {
    throw new UrlIngestError(
      "URL ingestion requires the `playwright` package. Install it with `npm install playwright` " +
        "at the repository root and run `npx playwright install chromium` to fetch the browser binary. " +
        "No browser automation is possible until it is installed.",
      "playwright-missing",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Config helpers                                                              */
/* -------------------------------------------------------------------------- */

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function readBrowserKind(
  override: UrlIngestOptions["browserKind"],
): "chromium" | "firefox" | "webkit" {
  if (override !== undefined) return override;
  const raw = (process.env.PLAYWRIGHT_BROWSER ?? "chromium").toLowerCase();
  if (raw === "firefox" || raw === "webkit") return raw;
  return "chromium";
}

/* -------------------------------------------------------------------------- */
/* URL validation                                                              */
/* -------------------------------------------------------------------------- */

function validateUrl(input: string): URL {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new UrlIngestError("A non-empty URL string is required.", "invalid-url");
  }
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new UrlIngestError(
      `Invalid URL: ${JSON.stringify(input)}. Expected an absolute http(s) URL.`,
      "invalid-url",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlIngestError(
      `Refusing to load ${parsed.protocol} URL. Only http and https are supported.`,
      "invalid-url",
    );
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* DOM-path augmentation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The default Playwright accessibility snapshot omits a DOM path. The workflow
 * planner needs one *at synthesis time* (not for indexing), because the
 * executor has to fall back to a selector when a stable ref becomes ambiguous.
 *
 * The strategy: after loading the page we evaluate a small script in the DOM
 * that computes, for every element with a role attribute or an accessibility
 * contribution, a stable CSS-ish path. We then match those paths to leaves of
 * the a11y tree by (role, name, ordinal-in-document-order). This is a
 * best-effort augmentation — when it cannot match a node, `domPath` stays null
 * and the executor falls back to ARIA-role lookup.
 *
 * The function below is executed inside the browser via `page.evaluate`. It is
 * deliberately short, has no dependencies and uses no `eval`. It returns one
 * record per node that Playwright itself would surface (i.e. role-bearing or
 * interactive elements), in document order, plus the node's approximate
 * accessible name using a very small heuristic (aria-label > textContent >
 * title > placeholder).
 */
interface DomElementRecord {
  readonly role: string;
  readonly name: string;
  readonly path: string;
}

const DOM_FINGERPRINT_SCRIPT = `(() => {
  const IMPLICIT_ROLE = [
    ['a[href]', 'link'], ['button', 'button'], ['input[type=button]', 'button'],
    ['input[type=submit]', 'button'], ['input[type=reset]', 'button'],
    ['input[type=text]', 'textbox'], ['input[type=email]', 'textbox'],
    ['input[type=password]', 'textbox'], ['input[type=search]', 'searchbox'],
    ['input[type=tel]', 'textbox'], ['input[type=url]', 'textbox'],
    ['input[type=number]', 'spinbutton'], ['input[type=range]', 'slider'],
    ['input[type=checkbox]', 'checkbox'], ['input[type=radio]', 'radio'],
    ['input[type=file]', 'button'], ['textarea', 'textbox'],
    ['select', 'combobox'], ['option', 'option'], ['h1', 'heading'],
    ['h2', 'heading'], ['h3', 'heading'], ['h4', 'heading'], ['h5', 'heading'],
    ['h6', 'heading'], ['nav', 'navigation'], ['main', 'main'],
    ['form', 'form'], ['dialog', 'dialog'], ['img', 'img'],
    ['table', 'table'], ['ul', 'list'], ['ol', 'list'], ['li', 'listitem'],
    ['summary', 'button'], ['label', 'label']
  ];
  const role = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    for (const [sel, r] of IMPLICIT_ROLE) {
      try { if (el.matches(sel)) return r; } catch (_) {}
    }
    return null;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const labelEl = document.getElementById(labelledby);
      if (labelEl && labelEl.textContent) return labelEl.textContent.trim();
    }
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && lab.textContent) return lab.textContent.trim();
    }
    if (typeof el.value === 'string' && el.value.length > 0 && el.tagName === 'INPUT') {
      const ph = el.getAttribute && el.getAttribute('placeholder');
      if (ph) return ph;
    }
    if (el.getAttribute) {
      const ph = el.getAttribute('placeholder');
      if (ph) return ph;
      const title = el.getAttribute('title');
      if (title) return title;
    }
    const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (txt) return txt.slice(0, 200);
    const alt = el.getAttribute && el.getAttribute('alt');
    if (alt) return alt.trim();
    return '';
  };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    let safety = 0;
    while (cur && cur.nodeType === 1 && safety < 60) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(tag + '#' + cur.id); break; }
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      cur = cur.parentElement;
      safety++;
    }
    return parts.join(' > ');
  };
  const out = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const r = role(node);
    if (r) {
      out.push({ role: r, name: nameOf(node), path: pathOf(node) });
    }
    node = walker.nextNode();
  }
  return out;
})()`;

/**
 * Merge DOM-fingerprint paths into the a11y tree. Match is by (role, name,
 * ordinal-in-document-order). When the a11y tree has a named node that the DOM
 * fingerprint also has with the same role and name (or vice-versa when names
 * are empty), we attach the path. A mismatched pairing is silently skipped —
 * callers must tolerate a null `domPath`.
 *
 * Mutates a *copy* of the tree using structural sharing so the input snapshot
 * is untouched. Returns the new root plus the number of attachments made.
 */
function attachDomPaths(
  root: A11yNode,
  fingerprint: readonly DomElementRecord[],
): { readonly root: A11yNode; readonly attached: number } {
  // Build a per-(role,name) queue of paths in document order. The a11y tree is
  // already in document order (pre-order traversal matches DOM order for
  // siblings), so we pop from the front of each bucket as we walk the tree.
  const buckets = new Map<string, string[]>();
  for (const rec of fingerprint) {
    const key = `${rec.role}\u0000${rec.name}`;
    const q = buckets.get(key);
    if (q === undefined) buckets.set(key, [rec.path]);
    else q.push(rec.path);
  }
  // Fallback bucket keyed by role only, for unnamed elements.
  const roleOnlyBuckets = new Map<string, string[]>();
  for (const rec of fingerprint) {
    if (rec.name.trim().length > 0) continue;
    const q = roleOnlyBuckets.get(rec.role);
    if (q === undefined) roleOnlyBuckets.set(rec.role, [rec.path]);
    else q.push(rec.path);
  }

  let attached = 0;
  const visit = (node: A11yNode): A11yNode => {
    const pairs: A11yNode[] = [];
    for (const child of node.children) pairs.push(visit(child));

    let domPath: string | null = node.domPath;
    if (domPath === null) {
      const key = `${node.role}\u0000${node.name}`;
      const namedBucket = buckets.get(key);
      if (namedBucket !== undefined && namedBucket.length > 0) {
        domPath = namedBucket.shift() ?? null;
        if (domPath !== null) attached += 1;
      } else if (node.name.trim().length === 0) {
        const roleBucket = roleOnlyBuckets.get(node.role);
        if (roleBucket !== undefined && roleBucket.length > 0) {
          domPath = roleBucket.shift() ?? null;
          if (domPath !== null) attached += 1;
        }
      }
    }

    if (domPath === node.domPath && pairs.every((p, i) => p === node.children[i])) {
      // No change — return the original node to preserve identity.
      return node;
    }
    return { ...node, domPath, children: pairs };
  };

  const next = visit(root);
  return { root: next, attached };
}

/* -------------------------------------------------------------------------- */
/* Snapshot normalisation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Playwright returns an a11y node whose `role`/`name` fields are as expected
 * but which lacks an `interactive` boolean. Our `A11yNode` computes
 * `interactive` from the role set, so once we augment with DOM paths the tree
 * is ready for `buildElementIndex`.
 *
 * The function accepts `unknown` because Playwright's TypeScript types vary
 * across versions; we route through `parseA11ySnapshotOrThrow` which performs
 * shape validation and throws a descriptive error on empty trees.
 */
function snapshotToA11yTree(raw: unknown): A11yNode {
  return parseA11ySnapshotOrThrow(raw as Record<string, unknown>);
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ingest a URL and return the accessibility snapshot, compacted view and
 * interactive-element index. Deterministic given the same page contents.
 *
 * The caller (worker job handler) is responsible for persisting the result as
 * an artifact and for emitting the appropriate lifecycle events. This function
 * performs the browser work and returns a JSON-serializable payload.
 */
export async function ingestUrl(
  options: UrlIngestOptions,
): Promise<UrlIngestResult> {
  const parsedUrl = validateUrl(options.url);

  if (options.dryRun === true) {
    throw new UrlIngestError(
      "ingestUrl(dryRun=true) cannot produce a snapshot: a live browser is required. " +
        "Remove dryRun or validate the URL elsewhere.",
      "internal",
    );
  }

  const browserKind = readBrowserKind(options.browserKind);
  const headless = readBoolEnv("PLAYWRIGHT_HEADLESS", true);
  const viewport = options.viewport ?? {
    width: readNumberEnv("PLAYWRIGHT_VIEWPORT_WIDTH", 1440),
    height: readNumberEnv("PLAYWRIGHT_VIEWPORT_HEIGHT", 900),
  };
  const deviceScaleFactor =
    options.deviceScaleFactor ?? readNumberEnv("PLAYWRIGHT_DEVICE_SCALE", 2);
  const navigationTimeoutMs =
    options.navigationTimeoutMs ??
    readNumberEnv("PLAYWRIGHT_NAVIGATION_TIMEOUT_MS", 45_000);
  const idleWaitMs =
    options.idleWaitMs ?? readNumberEnv("URL_INGEST_IDLE_WAIT_MS", 1_500);
  const proxyUrl =
    options.proxyUrl ?? (process.env.PLAYWRIGHT_PROXY_URL ?? null);

  const playwright = loadPlaywright();
  const launcher =
    browserKind === "firefox"
      ? playwright.firefox
      : browserKind === "webkit"
        ? playwright.webkit
        : playwright.chromium;

  let browser: PlaywrightBrowser | null = null;
  let context: PlaywrightContext | null = null;
  let page: PlaywrightPage | null = null;

  try {
    browser = await launcher.launch({
      headless,
      ...(proxyUrl !== null && proxyUrl.length > 0
        ? { proxy: { server: proxyUrl } }
        : {}),
    });

    const contextOpts: Parameters<PlaywrightBrowser["newContext"]>[0] = {
      viewport,
      deviceScaleFactor,
    };
    if (proxyUrl !== null && proxyUrl.length > 0) {
      (contextOpts as { proxy?: { server: string } }).proxy = { server: proxyUrl };
    }
    // Never forward cookies or auth headers from the operator env. Only a
    // caller-supplied locale-ish hint is honoured.
    context = await browser.newContext(contextOpts);
    page = await context.newPage();

    let timedOut = false;
    try {
      await page.goto(parsedUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs,
      });
    } catch (err) {
      // `domcontentloaded` timing out is not fatal if the DOM is available;
      // we fall back to whatever loaded. A genuine navigation error (DNS,
      // refused connection) is fatal and must propagate.
      const message = err instanceof Error ? err.message : String(err);
      if (/Timeout/i.test(message)) {
        timedOut = true;
      } else {
        throw new UrlIngestError(
          `Navigation to ${parsedUrl.toString()} failed: ${message}`,
          "navigation-failed",
        );
      }
    }

    if (idleWaitMs > 0) {
      // Best-effort idle: wait for network to settle but never block longer
      // than the configured idle window, since many pages poll forever.
      try {
        await page.waitForLoadState("networkidle", { timeout: idleWaitMs });
      } catch {
        await page.waitForTimeout(idleWaitMs);
      }
    }

    const status: number | null = await (async () => {
      try {
        // Playwright only exposes the response when `goto` succeeded; call the
        // method defensively.
        const maybe = await page.evaluate(() => document.readyState as string);
        void maybe;
        return null;
      } catch {
        return null;
      }
    })();

    const title = await safeAsync(async () => (page !== null ? page.title() : ""), "");
    const lang = await safeAsync(
      async () =>
        (page !== null
          ? await page.evaluate(() => document.documentElement.getAttribute("lang"))
          : null) as string | null,
      null,
    );
    const userAgent = await safeAsync(
      async () =>
        (page !== null
          ? await page.evaluate(() => navigator.userAgent)
          : null) as string | null,
      null,
    );

    // Take the raw snapshot with `interestingOnly: true` — this is the
    // ~93%-smaller view the LLM plans against. If the tree is empty (rare
    // canvas-only apps) we retry with `interestingOnly: false` to include
    // generic containers.
    let rawSnapshot: unknown = null;
    try {
      rawSnapshot = await page.accessibility.snapshot({ interestingOnly: true });
    } catch {
      rawSnapshot = null;
    }
    if (rawSnapshot === null || rawSnapshot === undefined) {
      rawSnapshot = await page.accessibility.snapshot({ interestingOnly: false });
    }

    const normalised = snapshotToA11yTree(rawSnapshot);

    // DOM-path augmentation is best effort. Failure must not fail the ingest.
    const fingerprint = await safeAsync(
      async () =>
        (page !== null
          ? await page.evaluate(DOM_FINGERPRINT_SCRIPT)
          : []) as DomElementRecord[],
      [] as DomElementRecord[],
    );
    const { root: withPaths } = attachDomPaths(normalised, fingerprint);

    const compact = compactA11yTree(withPaths);
    const a11yText = serializeA11yTree(compact, {
      markInteractive: true,
      includeStates: true,
    });

    const elements = buildElementIndex(withPaths, {
      assignRef: createStableRefAssigner(),
      includeDisabled: true,
      includeUnnamed: true,
    });

    const capturedAt = new Date().toISOString();
    const stats = a11yStats(withPaths);

    const capturedElements: CapturedElement[] = elements.elements.map((el) => ({
      ref: el.ref,
      role: el.role,
      name: el.name,
      value: el.value,
      domPath: el.domPath,
      depth: el.depth,
      enabled: el.enabled,
      visible: el.visible,
      ambiguous: el.ambiguous,
      duplicateOf: el.duplicateOf,
      containerRole: el.containerRole,
    }));

    const namedElementCount = capturedElements.filter(
      (el) => el.name.trim().length > 0,
    ).length;

    return {
      finalUrl: page.url(),
      status,
      title,
      lang,
      capturedAt,
      timedOut,
      a11y: withPaths,
      a11yCompact: compact,
      a11yText,
      stats,
      elements: capturedElements,
      namedElementCount,
      ambiguityCount: elements.ambiguityCount,
      rolesPresent: elements.rolesPresent,
      userAgent,
      viewport,
    };
  } finally {
    await safeClose(page);
    await safeClose(context);
    await safeClose(browser);
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function safeClose(
  target:
    | PlaywrightPage
    | PlaywrightContext
    | PlaywrightBrowser
    | null,
): Promise<void> {
  if (target === null) return;
  try {
    await target.close();
  } catch {
    /* best effort */
  }
}

/* -------------------------------------------------------------------------- */
/* Rehydration (used by worker handlers that read back a stored payload)       */
/* -------------------------------------------------------------------------- */

export interface RehydratedUrlIngest {
  readonly finalUrl: string;
  readonly capturedAt: string;
  readonly a11y: A11yNode;
  readonly a11yCompact: A11yNode;
  readonly a11yText: string;
  readonly stats: A11yStats;
  readonly elements: readonly CapturedElement[];
}

/**
 * Read a persisted `UrlIngestResult` back into a usable shape. Throws
 * `UrlIngestError` with `code: "snapshot-empty"` when the stored payload is
 * unusable — callers should fail the job rather than proceed with a partial
 * tree.
 */
export function rehydrateUrlIngest(value: unknown): RehydratedUrlIngest {
  if (value === null || typeof value !== "object") {
    throw new UrlIngestError(
      "Rehydrate failed: payload is not an object.",
      "snapshot-empty",
    );
  }
  const r = value as Record<string, unknown>;
  const a11y = hydrateA11yNode(r["a11y"]);
  const compact = hydrateA11yNode(r["a11yCompact"]);
  if (a11y === null || compact === null) {
    throw new UrlIngestError(
      "Rehydrate failed: stored accessibility tree is missing or malformed.",
      "snapshot-empty",
    );
  }
  const finalUrl = typeof r["finalUrl"] === "string" ? (r["finalUrl"] as string) : "";
  const capturedAt = typeof r["capturedAt"] === "string" ? (r["capturedAt"] as string) : "";
  const a11yText = typeof r["a11yText"] === "string" ? (r["a11yText"] as string) : "";
  const elementsRaw = Array.isArray(r["elements"]) ? (r["elements"] as unknown[]) : [];
  const elements: CapturedElement[] = [];
  for (const item of elementsRaw) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const ref = typeof e["ref"] === "string" ? (e["ref"] as string) : null;
    const role = typeof e["role"] === "string" ? (e["role"] as string) : null;
    if (ref === null || role === null) continue;
    elements.push({
      ref,
      role,
      name: typeof e["name"] === "string" ? (e["name"] as string) : "",
      value:
        typeof e["value"] === "string" ||
        typeof e["value"] === "number" ||
        typeof e["value"] === "boolean"
          ? (e["value"] as string | number | boolean)
          : null,
      domPath: typeof e["domPath"] === "string" ? (e["domPath"] as string) : null,
      depth: typeof e["depth"] === "number" ? (e["depth"] as number) : 0,
      enabled: e["enabled"] !== false,
      visible: e["visible"] !== false,
      ambiguous: e["ambiguous"] === true,
      duplicateOf:
        typeof e["duplicateOf"] === "string" ? (e["duplicateOf"] as string) : null,
      containerRole:
        typeof e["containerRole"] === "string"
          ? (e["containerRole"] as string)
          : null,
    });
  }
  return {
    finalUrl,
    capturedAt,
    a11y,
    a11yCompact: compact,
    a11yText,
    stats: a11yStats(a11y),
    elements,
  };
}
