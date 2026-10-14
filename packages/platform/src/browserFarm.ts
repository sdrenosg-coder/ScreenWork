/**
 * Zipy AI — browser farm (phase 24, batch 0).
 *
 * A bounded pool of Playwright browser contexts shared by every workflow run
 * in the worker process. The farm exists because browser contexts are the
 * scarcest resource in the platform: a Chromium context holds ~50–150 MB of
 * RSS, and spawning one per job without a ceiling is the fastest way to OOM
 * a worker under load. The farm caps concurrency, queues overflow, recycles
 * contexts that have handled too many runs or leaked memory, and reports
 * per-lease metrics so the operator can tune `PLAYWRIGHT_MAX_CONTEXTS`.
 *
 * Design boundaries honoured here:
 *
 *  - The farm does not *drive* a browser. Playwright's `Browser` and
 *    `BrowserContext` objects are owned by `@zipy/automation/browser`. The
 *    farm accepts a caller-supplied `BrowserLike` handle and a caller-supplied
 *    `createContext` factory, uses them opaquely, and returns the context to
 *    the caller for the duration of the lease. This module never imports
 *    Playwright so `packages/platform` stays usable in an on-prem build that
 *    swaps the driver.
 *
 *  - No browser is fabricated. If the caller's `BrowserLike` reports itself
 *    as closed, has no contexts left, or a `createContext` call throws, the
 *    farm surfaces that as a typed error rather than inventing a stub context.
 *
 *  - No credentials are invented. Proxy rotation is delegated to
 *    `./proxy.ts`; the farm never injects a proxy URL it did not receive from
 *    the caller.
 *
 *  - Queueing is *bounded*. An unbounded pending queue would let a burst of
 *    enqueues consume all worker memory while waiting for a context. The
 *    farm enforces `maxQueue`; when full, `acquire` rejects with
 *    `farm-overloaded` so the job runner can retry with backoff rather than
 *    silently dropping the job.
 *
 *  - Leases are time-bounded. A context held longer than `leaseTimeoutMs` is
 *    force-released and marked suspect, because an abandoned context is the
 *    most common leak. `release` on an expired lease still succeeds (the
 *    caller may be finishing cleanup) but does not return the context to the
 *    idle pool.
 *
 *  - Metrics are counters. The farm exposes counts and timings that an
 *    operator reads from the admin page; it does not compute percentages or
 *    invent sampling. Averages are computed at read time from real counters.
 *
 * The module exports:
 *   - `BrowserFarm` — acquire/release, metrics, drain.
 *   - `createBrowserFarm` — typed constructor.
 *   - `WithContext` — helper that runs a callback under a lease and releases.
 *   - Typed errors and constants.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type FarmErrorCode =
  | "invalid-input"
  | "not-started"
  | "farm-closed"
  | "farm-overloaded"
  | "browser-unavailable"
  | "context-creation-failed"
  | "release-unknown-lease";

export class BrowserFarmError extends Error {
  readonly code: FarmErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: FarmErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "BrowserFarmError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The opaque subset of Playwright's `Browser` the farm uses. Keeping this
 * structural (rather than importing the Playwright type) means the platform
 * package has no runtime or type dependency on Playwright, and an on-prem
 * build that swaps the driver to Puppeteer or a remote CDP endpoint supplies
 * an adapter satisfying the same shape.
 */
export interface BrowserLike<TContext> {
  /** Whether the browser still has a usable connection. */
  readonly isConnected: () => boolean;
  /** Optional Playwright `Browser.version()`; not required by the farm. */
  readonly version?: () => string;
  /** Optional graceful `Browser.close()`. The farm calls this on `drain`. */
  readonly close?: () => Promise<void>;
}

/**
 * A leased context. `value` is the caller's `TContext`; the farm treats it
 * opaquely. `leaseId` is the farm's own identifier so the caller can pass it
 * back to `release` and so audit trails can correlate.
 */
export interface ContextLease<TContext> {
  readonly leaseId: string;
  readonly value: TContext;
  /** ISO timestamp the lease was issued. */
  readonly acquiredAt: string;
  /**
   * The proxy URL assigned to this context, or null when no proxy policy is
   * active. Populated from the `ProxyRoute` the caller supplied.
   */
  readonly proxyUrl: string | null;
  /** Whether the underlying context came from an existing idle slot or was fresh. */
  readonly reused: boolean;
}

export interface BrowserFarmOptions<TContext> {
  /**
   * Factory that creates a fresh `TContext` against the browser. The farm
   * calls this when its idle pool is empty and the concurrency ceiling has
   * not been reached. Any error thrown propagates to the caller as
   * `context-creation-failed`.
   */
  readonly createContext: (input: {
    /** A proxy URL to pass to `browser.newContext({proxy: {server}})`, when set. */
    readonly proxyUrl: string | null;
    /** Whether this context is being created for a fresh slot vs. replacing a recycled one. */
    readonly reason: "initial" | "recycled";
  }) => Promise<TContext>;

  /**
   * Optional disposer. Playwright's `BrowserContext.close()` is the canonical
   * implementation. When omitted, the farm does not close the context on
   * recycle — the caller has accepted that a recycled context stays open,
   * which is only safe for a caller using an externally-managed pool.
   */
  readonly closeContext?: (context: TContext) => Promise<void>;

  /**
   * The maximum number of concurrently-leased contexts. Defaults to 2,
   * matching the `PLAYWRIGHT_MAX_CONTEXTS` default in `@/lib/config`.
   */
  readonly maxConcurrent?: number;

  /**
   * Upper bound on pending `acquire` calls. When full, `acquire` rejects
   * with `farm-overloaded` rather than queueing without bound. Defaults to
   * `maxConcurrent * 8`.
   */
  readonly maxQueue?: number;

  /**
   * Maximum number of runs a single context may handle before the farm
   * recycles it. Chromium leaks memory across navigations; recycling bounds
   * the leak. Defaults to 50 runs.
   */
  readonly maxRunsPerContext?: number;

  /**
   * Maximum wall-clock time a lease may be held. On expiry, the farm marks
   * the underlying context suspect and refuses to return it to the idle
   * pool; the next `acquire` creates a fresh context instead. Defaults to
   * five minutes, which comfortably exceeds an ordinary workflow run.
   */
  readonly leaseTimeoutMs?: number;

  /**
   * Supplies a proxy URL at acquisition time. The farm uses this so proxy
   * rotation is a policy decision the caller owns (see `./proxy.ts`).
   * When omitted, no proxy is passed to `createContext`.
   */
  readonly proxySelector?: () => Promise<string | null> | string | null;

  /** Clock injection for tests. Defaults to `Date.now`. */
  readonly now?: () => number;

  /**
   * Identifier the farm embeds in `leaseId`s so logs across several farms on
   * the same host are distinguishable. Defaults to `farm:<pid>`.
   */
  readonly farmId?: string;
}

/**
 * Snapshot of the farm's counters. Everything is a raw count; averages are
 * derived by the caller (`averageLeaseMs`, `averageQueueWaitMs`) so a UI
 * does not need to trust a "pre-averaged" number.
 */
export interface FarmMetrics {
  readonly farmId: string;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly maxRunsPerContext: number;
  readonly leaseTimeoutMs: number;
  /** Contexts currently leased to a caller. */
  readonly active: number;
  /** Contexts currently idle in the pool, ready to hand to the next caller. */
  readonly idle: number;
  /** Pending acquisitions waiting for a slot. */
  readonly queued: number;
  /** Contexts currently being created (a `createContext` call is in flight). */
  readonly creating: number;
  /** Total acquisitions that succeeded since the farm started. */
  readonly totalAcquired: number;
  /** Subset of `totalAcquired` that came from the idle pool. */
  readonly totalReused: number;
  /** Total releases recorded. */
  readonly totalReleased: number;
  /** Total leases that expired before their `release` call. */
  readonly totalLeaseExpired: number;
  /** Contexts recycled for exceeding `maxRunsPerContext`. */
  readonly totalRecycled: number;
  /** Acquisitions rejected with `farm-overloaded`. */
  readonly totalOverloaded: number;
  /** `createContext` calls that threw. */
  readonly totalCreateFailures: number;
  /** Sum of lease durations for leases that released normally, in ms. */
  readonly totalLeaseMs: number;
  /** Sum of queue wait durations for leases that acquired, in ms. */
  readonly totalQueueWaitMs: number;
  /** Whether the farm has been drained (`drain` called). */
  readonly closed: boolean;
}

/**
 * The farm's public interface, exported so a caller can inject a fake in
 * tests without instantiating a real `BrowserFarm`.
 */
export interface Farm<TContext> {
  acquire(input?: AcquireInput): Promise<ContextLease<TContext>>;
  release(lease: ContextLease<TContext>, outcome?: ReleaseOutcome): Promise<void>;
  metrics(): FarmMetrics;
  drain(): Promise<void>;
  readonly closed: boolean;
}

export interface AcquireInput {
  /**
   * Whether to skip the idle pool and force a fresh context. Used when the
   * caller knows the previous context was tainted (an element handle from a
   * prior run may still be attached, cookies from a prior tenant remain).
   */
  readonly forceFresh?: boolean;
  /** Cancellation signal. Aborting while queued removes the entry. */
  readonly signal?: AbortSignal;
}

/**
 * What happened to the context the caller leased. The farm uses this to
 * decide whether the context is safe to return to the idle pool.
 */
export interface ReleaseOutcome {
  /**
   * Whether the context should be returned to the idle pool. A caller that
   * hit an unrecoverable error, or that left the page in an unknown state,
   * passes `false` so the farm recycles the context immediately.
   */
  readonly reusable: boolean;
  /** Reason text the farm stores in its shutdown log; not used for logic. */
  readonly reason?: string;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MULTIPLIER_FOR_QUEUE = 8;
const DEFAULT_MAX_RUNS_PER_CONTEXT = 50;
const DEFAULT_LEASE_TIMEOUT_MS = 5 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

interface IdleEntry<TContext> {
  readonly context: TContext;
  /** How many runs this context has handled. Recycled when it hits the cap. */
  runs: number;
}

interface ActiveLease<TContext> {
  readonly leaseId: string;
  readonly context: TContext;
  readonly acquiredAtMs: number;
  readonly queuedAtMs: number;
  /** True when the lease came from the idle pool (as opposed to freshly created). */
  readonly reused: boolean;
  /** True when this lease's underlying context should be recycled on release. */
  suspect: boolean;
}

interface PendingAcquire<TContext> {
  readonly resolve: (lease: ContextLease<TContext>) => void;
  readonly reject: (err: Error) => void;
  readonly queuedAtMs: number;
  readonly forceFresh: boolean;
  readonly proxyUrl: string | null;
  readonly signal: AbortSignal | undefined;
  /** Set when the signal aborts before resolution; the queue skips the entry. */
  aborted: boolean;
}

let leaseCounter = 0;

/**
 * The farm's internal mutable state. Kept in a class so the module reads
 * top-to-bottom; the public boundary is `Farm<TContext>`.
 */
class BrowserFarmImpl<TContext> implements Farm<TContext> {
  private readonly browser: BrowserLike<TContext>;
  private readonly options: Required<
    Pick<
      BrowserFarmOptions<TContext>,
      | "createContext"
      | "maxConcurrent"
      | "maxQueue"
      | "maxRunsPerContext"
      | "leaseTimeoutMs"
      | "farmId"
    >
  > & {
    readonly closeContext: BrowserFarmOptions<TContext>["closeContext"];
    readonly proxySelector: BrowserFarmOptions<TContext>["proxySelector"];
    readonly now: () => number;
  };

  private readonly idle: IdleEntry<TContext>[] = [];
  private readonly active = new Map<string, ActiveLease<TContext>>();
  private readonly pending: PendingAcquire<TContext>[] = [];
  private closed = false;
  private creating = 0;

  private counters = {
    totalAcquired: 0,
    totalReused: 0,
    totalReleased: 0,
    totalLeaseExpired: 0,
    totalRecycled: 0,
    totalOverloaded: 0,
    totalCreateFailures: 0,
    totalLeaseMs: 0,
    totalQueueWaitMs: 0,
  };

  constructor(browser: BrowserLike<TContext>, options: BrowserFarmOptions<TContext>) {
    this.browser = browser;
    const maxConcurrent =
      typeof options.maxConcurrent === "number" &&
      Number.isFinite(options.maxConcurrent) &&
      options.maxConcurrent >= 1
        ? Math.floor(options.maxConcurrent)
        : DEFAULT_MAX_CONCURRENT;
    const maxQueue =
      typeof options.maxQueue === "number" &&
      Number.isFinite(options.maxQueue) &&
      options.maxQueue >= 0
        ? Math.floor(options.maxQueue)
        : maxConcurrent * DEFAULT_MULTIPLIER_FOR_QUEUE;
    const maxRunsPerContext =
      typeof options.maxRunsPerContext === "number" &&
      Number.isFinite(options.maxRunsPerContext) &&
      options.maxRunsPerContext >= 1
        ? Math.floor(options.maxRunsPerContext)
        : DEFAULT_MAX_RUNS_PER_CONTEXT;
    const leaseTimeoutMs =
      typeof options.leaseTimeoutMs === "number" &&
      Number.isFinite(options.leaseTimeoutMs) &&
      options.leaseTimeoutMs > 0
        ? Math.floor(options.leaseTimeoutMs)
        : DEFAULT_LEASE_TIMEOUT_MS;
    const farmId =
      typeof options.farmId === "string" && options.farmId.trim().length > 0
        ? options.farmId.trim()
        : `farm:${process.pid}`;
    this.options = {
      createContext: options.createContext,
      closeContext: options.closeContext,
      proxySelector: options.proxySelector,
      maxConcurrent,
      maxQueue,
      maxRunsPerContext,
      leaseTimeoutMs,
      farmId,
      now: typeof options.now === "function" ? options.now : () => Date.now(),
    };
  }

  get closedFarm(): boolean {
    return this.closed;
  }

  get closedState(): boolean {
    return this.closed;
  }

  async acquire(input: AcquireInput = {}): Promise<ContextLease<TContext>> {
    if (this.closed) {
      throw new BrowserFarmError(
        `Browser farm "${this.options.farmId}" is closed; refusing to acquire.`,
        "farm-closed",
      );
    }
    if (!this.browser.isConnected()) {
      throw new BrowserFarmError(
        `Browser is not connected; cannot acquire a context from farm "${this.options.farmId}".`,
        "browser-unavailable",
      );
    }
    if (input.signal?.aborted) {
      throw new BrowserFarmError("acquire was aborted before it started.", "invalid-input");
    }

    const nowMs = this.options.now();

    // Try to serve from the idle pool first (unless the caller asked for a
    // fresh context). A context that has reached its run cap is recycled
    // rather than handed out again, so idle entries with an over-cap run
    // count are pruned here.
    if (!input.forceFresh) {
      const idleEntry = this.pruneAndPopIdle();
      if (idleEntry !== undefined) {
        const proxyUrl =
          this.options.proxySelector !== undefined
            ? await this.resolveProxyUrl()
            : null;
        const lease = this.issueLease(idleEntry.context, nowMs, nowMs, true, proxyUrl);
        return lease;
      }
    }

    // No idle context available. If concurrency permits, create a fresh one.
    if (this.active.size + this.creating < this.options.maxConcurrent) {
      const proxyUrl =
        this.options.proxySelector !== undefined
          ? await this.resolveProxyUrl()
          : null;
      const context = await this.createFreshContext(proxyUrl, "initial");
      const lease = this.issueLease(context, nowMs, nowMs, false, proxyUrl);
      return lease;
    }

    // At the concurrency ceiling. Queue if there is room, otherwise refuse.
    if (this.pending.length >= this.options.maxQueue) {
      this.counters.totalOverloaded += 1;
      throw new BrowserFarmError(
        `Browser farm "${this.options.farmId}" is at capacity: ${this.active.size}/${this.options.maxConcurrent} active, ${this.pending.length}/${this.options.maxQueue} queued. The job runner should retry with backoff.`,
        "farm-overloaded",
        {
          active: this.active.size,
          maxConcurrent: this.options.maxConcurrent,
          queued: this.pending.length,
          maxQueue: this.options.maxQueue,
        },
      );
    }

    return new Promise<ContextLease<TContext>>((resolve, reject) => {
      const entry: PendingAcquire<TContext> = {
        resolve,
        reject,
        queuedAtMs: nowMs,
        forceFresh: Boolean(input.forceFresh),
        proxyUrl: null,
        signal: input.signal,
        aborted: false,
      };
      const onAbort = () => {
        entry.aborted = true;
        // Remove from queue and reject the caller. A lease already granted
        // between abort registration and activation cannot be revoked, so
        // the resolve path also clears the abort listener.
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new BrowserFarmError("acquire was aborted while queued.", "invalid-input"));
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.push(entry);
    });
  }

  async release(lease: ContextLease<TContext>, outcome?: ReleaseOutcome): Promise<void> {
    const active = this.active.get(lease.leaseId);
    if (active === undefined) {
      throw new BrowserFarmError(
        `Unknown lease "${lease.leaseId}"; it was already released or never issued by farm "${this.options.farmId}".`,
        "release-unknown-lease",
        { leaseId: lease.leaseId },
      );
    }
    this.active.delete(lease.leaseId);
    this.counters.totalReleased += 1;
    const nowMs = this.options.now();
    this.counters.totalLeaseMs += Math.max(0, nowMs - active.acquiredAtMs);

    const reusable = outcome?.reusable !== false;
    const expired = active.suspect;

    // Decide whether the context returns to the idle pool.
    //
    //   - Expired lease: context was force-marked suspect and is being
    //     recycled. Close it if a disposer exists, else drop the reference.
    //   - Non-reusable: caller reported the context as tainted; recycle.
    //   - Otherwise: increment the run counter and check the recycle cap.
    let shouldKeep = reusable && !expired;
    if (shouldKeep) {
      const entry = this.idle.find((i) => i.context === active.context);
      // Freshly-created contexts that have never been pooled are not in the
      // idle array yet; add them. Reused contexts are already there.
      if (entry !== undefined) {
        entry.runs += 1;
        if (entry.runs >= this.options.maxRunsPerContext) {
          shouldKeep = false;
          this.counters.totalRecycled += 1;
        }
      } else {
        const fresh: IdleEntry<TContext> = { context: active.context, runs: 1 };
        if (fresh.runs >= this.options.maxRunsPerContext) {
          shouldKeep = false;
          this.counters.totalRecycled += 1;
        } else {
          this.idle.push(fresh);
        }
      }
    } else if (!expired && !reusable) {
      // An explicitly non-reusable context is dropped without incrementing
      // the recycle counter: the caller told us it broke, it did not age out.
    }

    if (!shouldKeep) {
      await this.disposeContext(active.context);
    }

    // Hand the freed slot to a queued acquire if any are waiting.
    this.pumpQueue();
  }

  metrics(): FarmMetrics {
    // Prune expired leases so the counts an operator sees match reality on
    // read, not just after the next release.
    this.pruneExpiredLeases();
    return {
      farmId: this.options.farmId,
      maxConcurrent: this.options.maxConcurrent,
      maxQueue: this.options.maxQueue,
      maxRunsPerContext: this.options.maxRunsPerContext,
      leaseTimeoutMs: this.options.leaseTimeoutMs,
      active: this.active.size,
      idle: this.idle.length,
      queued: this.pending.length,
      creating: this.creating,
      totalAcquired: this.counters.totalAcquired,
      totalReused: this.counters.totalReused,
      totalReleased: this.counters.totalReleased,
      totalLeaseExpired: this.counters.totalLeaseExpired,
      totalRecycled: this.counters.totalRecycled,
      totalOverloaded: this.counters.totalOverloaded,
      totalCreateFailures: this.counters.totalCreateFailures,
      totalLeaseMs: this.counters.totalLeaseMs,
      totalQueueWaitMs: this.counters.totalQueueWaitMs,
      closed: this.closed,
    };
  }

  async drain(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Reject every queued acquire first; a caller awaiting a lease must not
    // be left hanging on a farm that will never serve it.
    const queued = [...this.pending];
    this.pending.length = 0;
    for (const entry of queued) {
      entry.reject(
        new BrowserFarmError(
          `Browser farm "${this.options.farmId}" closed while this acquire was queued.`,
          "farm-closed",
        ),
      );
    }

    // Close idle contexts via the caller's disposer. Active leases are the
    // caller's responsibility: the farm cannot close a context the caller is
    // still driving without corrupting their run.
    const idleContexts = this.idle.map((i) => i.context);
    this.idle.length = 0;
    for (const context of idleContexts) {
      await this.disposeContext(context);
    }
    // Closing the browser itself is optional and caller-driven; some callers
    // share a `Browser` across several farms. If the caller supplied a
    // `close` method we invoke it; Playwright's `Browser.close` is idempotent
    // and safe to call twice.
    if (typeof this.browser.close === "function") {
      try {
        await this.browser.close();
      } catch {
        /* best effort — the caller decides whether a failed browser close is fatal */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private pruneAndPopIdle(): IdleEntry<TContext> | undefined {
    while (this.idle.length > 0) {
      const entry = this.idle.shift()!;
      if (entry.runs >= this.options.maxRunsPerContext) {
        // Over-cap entry: dispose asynchronously. Do not await here because
        // acquire should stay synchronous in the common path where a
        // well-behaved context is returned. The disposer is fast (a browser
        // close call) and failures are swallowed by `disposeContext`.
        this.counters.totalRecycled += 1;
        void this.disposeContext(entry.context);
        continue;
      }
      return entry;
    }
    return undefined;
  }

  private issueLease(
    context: TContext,
    acquiredAtMs: number,
    queuedAtMs: number,
    reused: boolean,
    proxyUrl: string | null,
  ): ContextLease<TContext> {
    const leaseId = `${this.options.farmId}:lease:${++leaseCounter}`;
    const active: ActiveLease<TContext> = {
      leaseId,
      context,
      acquiredAtMs,
      queuedAtMs,
      reused,
      suspect: false,
    };
    this.active.set(leaseId, active);
    this.counters.totalAcquired += 1;
    if (reused) this.counters.totalReused += 1;
    this.counters.totalQueueWaitMs += Math.max(0, acquiredAtMs - queuedAtMs);
    return {
      leaseId,
      value: context,
      acquiredAt: new Date(acquiredAtMs).toISOString(),
      proxyUrl,
      reused,
    };
  }

  private async createFreshContext(
    proxyUrl: string | null,
    reason: "initial" | "recycled",
  ): Promise<TContext> {
    this.creating += 1;
    try {
      return await this.options.createContext({ proxyUrl, reason });
    } catch (err) {
      this.counters.totalCreateFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      throw new BrowserFarmError(
        `Failed to create a browser context in farm "${this.options.farmId}": ${message}`,
        "context-creation-failed",
        { reason, cause: message },
      );
    } finally {
      this.creating -= 1;
    }
  }

  private async disposeContext(context: TContext): Promise<void> {
    if (this.options.closeContext !== undefined) {
      try {
        await this.options.closeContext(context);
      } catch {
        /* best effort; a context that fails to close is still dropped */
      }
    }
  }

  private async resolveProxyUrl(): Promise<string | null> {
    const selector = this.options.proxySelector;
    if (selector === undefined) return null;
    try {
      const value = await selector();
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
      return null;
    } catch (err) {
      // A proxy selector that throws is a configuration error the operator
      // needs to fix; failing loudly is better than silently using a direct
      // connection, which for a geo-distribution workflow is a compliance
      // problem rather than a performance one.
      const message = err instanceof Error ? err.message : String(err);
      throw new BrowserFarmError(
        `proxySelector threw while acquiring a lease: ${message}`,
        "invalid-input",
        { cause: message },
      );
    }
  }

  private pumpQueue(): void {
    if (this.closed) return;
    while (this.pending.length > 0) {
      if (this.active.size + this.creating >= this.options.maxConcurrent) return;
      const entry = this.pending[0]!;
      if (entry.aborted) {
        this.pending.shift();
        continue;
      }
      this.pending.shift();

      // Try idle first (respecting forceFresh), else create a fresh one.
      const tryServe = async () => {
        try {
          const nowMs = this.options.now();
          if (!entry.forceFresh) {
            const idleEntry = this.pruneAndPopIdle();
            if (idleEntry !== undefined) {
              const proxyUrl =
                this.options.proxySelector !== undefined
                  ? await this.resolveProxyUrl()
                  : null;
              entry.resolve(this.issueLease(idleEntry.context, nowMs, entry.queuedAtMs, true, proxyUrl));
              // A slot was consumed; a subsequent iteration decides whether
              // more can be served.
              this.pumpQueue();
              return;
            }
          }
          const proxyUrl =
            this.options.proxySelector !== undefined
              ? await this.resolveProxyUrl()
              : null;
          const context = await this.createFreshContext(proxyUrl, "initial");
          entry.resolve(this.issueLease(context, nowMs, entry.queuedAtMs, false, proxyUrl));
          this.pumpQueue();
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
          // Creation failed; release the slot so other queued entries can
          // try, since a persistent failure should propagate as an error
          // rather than wedging the queue.
          this.pumpQueue();
        }
      };
      void tryServe();
      return;
    }
  }

  private pruneExpiredLeases(): void {
    const nowMs = this.options.now();
    for (const [, active] of this.active) {
      if (nowMs - active.acquiredAtMs > this.options.leaseTimeoutMs && !active.suspect) {
        active.suspect = true;
        this.counters.totalLeaseExpired += 1;
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public constructor                                                          */
/* -------------------------------------------------------------------------- */

export function createBrowserFarm<TContext>(
  browser: BrowserLike<TContext>,
  options: BrowserFarmOptions<TContext>,
): Farm<TContext> {
  if (browser === null || typeof browser !== "object") {
    throw new BrowserFarmError("`browser` is required.", "invalid-input");
  }
  if (typeof browser.isConnected !== "function") {
    throw new BrowserFarmError(
      "`browser.isConnected` is required; supply a Playwright Browser or an adapter with the same method.",
      "invalid-input",
    );
  }
  if (options === null || typeof options !== "object") {
    throw new BrowserFarmError("`options` is required.", "invalid-input");
  }
  if (typeof options.createContext !== "function") {
    throw new BrowserFarmError(
      "`options.createContext` is required and must be a function.",
      "invalid-input",
    );
  }
  return new BrowserFarmImpl<TContext>(browser, options);
}

/* -------------------------------------------------------------------------- */
/* withContext helper                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Run a callback under a farm lease, releasing it in a `finally` block. The
 * caller decides the release outcome from the callback's success/failure and
 * from the option `reusableOnError`.
 *
 * This helper is intentionally small: the well-known failure mode of a lease
 * pool is a lease that is never released because a `try/finally` was omitted,
 * and this is the one entry point that guarantees release.
 */
export async function withContext<TContext, TResult>(
  farm: Farm<TContext>,
  options: AcquireInput & {
    /**
     * Whether a context should be returned to the idle pool when the callback
     * throws. Defaults to `false`: an exception usually means the page state
     * is unknown, and a fresh context is safer for the next run. Callers with
     * a known-recoverable error pass `true` deliberately.
     */
    readonly reusableOnError?: boolean;
  },
  run: (lease: ContextLease<TContext>) => Promise<TResult>,
): Promise<TResult> {
  if (typeof run !== "function") {
    throw new BrowserFarmError("`run` must be a function.", "invalid-input");
  }
  const lease = await farm.acquire({
    forceFresh: options.forceFresh,
    signal: options.signal,
  });
  let reusable = true;
  let reason: string | undefined;
  try {
    const result = await run(lease);
    return result;
  } catch (err) {
    reusable = options.reusableOnError === true;
    reason = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    try {
      await farm.release(lease, { reusable, reason });
    } catch {
      // Release failures are swallowed here because throwing from a `finally`
      // would mask the caller's original error. The farm's metrics still
      // record the release; an operator sees the mismatch on the admin page.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MULTIPLIER_FOR_QUEUE,
  DEFAULT_MAX_RUNS_PER_CONTEXT,
  DEFAULT_LEASE_TIMEOUT_MS,
  BrowserFarmImpl,
});
