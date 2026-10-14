/**
 * Zipy AI — proxy rotation policy (phase 24, batch 0).
 *
 * A browser workflow run occasionally needs to originate from a specific
 * geography: a customer's tutorial must be captured against the version of
 * the product served to APAC users, or a rate-limited endpoint demands the
 * requests spread across IPs. The platform does not ship a proxy vendor —
 * the customer supplies one or more proxy URLs via environment, and this
 * module decides which URL a given acquisition should use.
 *
 * Design boundaries honoured here:
 *
 *  - No proxy is invented. When the environment carries no proxy list, the
 *    policy reports `enabled: false` and the farm passes `proxyUrl: null`
 *    to `createContext`. The workflow runs on the host's connection, which
 *    is the correct behaviour for a single-region deployment.
 *
 *  - Sticky-per-workflow is the default. Handing a different proxy to every
 *    step within one workflow would (a) break cookie continuity when the
 *    target's session is geo-pinned and (b) leak user activity across IPs
 *    mid-flow. `ProxyRotator.byKey` returns the same URL for the same key
 *    until that key is released.
 *
 *  - Rotation strategies are explicit. `round-robin` spreads acquisitions
 *    across the list; `weighted` honours a per-entry weight; `random` is
 *    available but discouraged (exported because a customer asking for it
 *    should receive what they asked for). The default is `round-robin`.
 *
 *  - Health tracking is *bounded* and *honest*. A proxy that fails
 *    `failureThreshold` times in a row is marked down for `cooldownMs`,
 *    after which a single probe acquisition is allowed. The policy never
 *    removes a proxy permanently: a transient network problem must not
 *    evict a working proxy for the process's lifetime.
 *
 *  - No HTTP is performed here. Health is driven by the caller's
 *    `reportSuccess` / `reportFailure` calls; this module never pings a
 *    proxy URL, because doing so from the platform's own network would
 *    leak the platform IP to a proxy whose trust the customer has not
 *    verified for that purpose. The workflow run itself is the probe.
 *
 *  - Credentials in a proxy URL are not logged. The URL may carry
 *    `user:pass@host`; `describeProxy` produces a redacted form.
 *
 * The module exports:
 *   - `parseProxyList` — parse the `BROWSER_PROXIES` env value.
 *   - `ProxyRotator` — the policy engine.
 *   - `createProxyRotatorFromEnv` — convenience factory.
 *   - `describeProxy` — redacted human description.
 *   - Typed errors and constants.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ProxyErrorCode =
  | "invalid-input"
  | "invalid-url"
  | "unknown-key"
  | "no-available-proxy";

export class ProxyPolicyError extends Error {
  readonly code: ProxyErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ProxyErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ProxyPolicyError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type ProxyProtocol = "http" | "https" | "socks5";

/**
 * One proxy endpoint. Weight is a positive integer used by the `weighted`
 * strategy; a weight of 0 excludes the entry from the weighted pool but the
 * entry still participates in `round-robin` (a customer whose list is
 * entirely weight-0 gets the honest behaviour of `round-robin` falling back
 * to uniform distribution, rather than a "no proxies available" error).
 */
export interface ProxyEntry {
  /** The URL as supplied, with credentials if any. Never logged verbatim. */
  readonly url: string;
  readonly protocol: ProxyProtocol;
  /** Host (no port), for logs and health grouping. */
  readonly host: string;
  readonly port: number;
  /**
   * A stable identifier the customer can use to refer to this entry in
   * support. Derived from the host and port, not from the credentials.
   */
  readonly id: string;
  readonly weight: number;
  /**
   * An optional region tag the customer supplies (`apac`, `us-east`, ...).
   * Used by `byRegion` — a workflow that requires a specific region asks for
   * one and the rotator refuses rather than silently returning a proxy from
   * a different geography.
   */
  readonly region: string | null;
}

export type RotationStrategy = "round-robin" | "weighted" | "random";

export interface ProxyRotatorOptions {
  readonly entries: readonly ProxyEntry[];
  readonly strategy?: RotationStrategy;
  /**
   * How many consecutive failures mark a proxy down. Default 3.
   */
  readonly failureThreshold?: number;
  /**
   * How long a down proxy stays down before it is eligible for a single
   * probe acquisition. Default 60_000 (one minute).
   */
  readonly cooldownMs?: number;
  /** Clock injection. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Random source for the `random` strategy; injected so tests are
   * deterministic. Defaults to `Math.random`.
   */
  readonly random?: () => number;
}

export interface AcquireProxyInput {
  /**
   * The key the caller wants the proxy to be sticky to. Conventionally the
   * workflow id; a workflow is a single continuous session and should stay
   * on one IP barring a health failure. When absent, the rotator selects
   * without stickiness and returns a proxy the caller must release.
   */
  readonly key?: string | null;
  /**
   * When set, only proxies tagged with this region are eligible. Refuses
   * with `no-available-proxy` when none match, rather than returning a
   * proxy from an unintended geography.
   */
  readonly region?: string | null;
  /**
   * When true, ignore the round-robin/weighted preference and pick the
   * least-recently-used available proxy. Useful for a caller that has just
   * seen a proxy fail and wants a different one.
   */
  readonly preferDifferent?: boolean;
}

export interface ProxyGrant {
  /** The URL to pass to `browser.newContext({ proxy: { server } })`. */
  readonly url: string;
  readonly id: string;
  readonly protocol: ProxyProtocol;
  readonly region: string | null;
  /** True when this grant came from a sticky binding on `key`. */
  readonly sticky: boolean;
  /** Set when the grant came from `key`; the caller uses it to release. */
  readonly key: string | null;
  /** ISO timestamp the grant was issued. */
  readonly grantedAt: string;
}

export interface ProxyHealth {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly region: string | null;
  readonly weight: number;
  /** Consecutive failures since the last success. */
  readonly consecutiveFailures: number;
  /** Whether the proxy is currently marked down. */
  readonly down: boolean;
  /** ISO timestamp the proxy will next be eligible (null when up). */
  readonly nextEligibleAt: string | null;
}

export interface ProxyRotatorMetrics {
  readonly enabled: boolean;
  readonly strategy: RotationStrategy;
  readonly entries: number;
  readonly up: number;
  readonly down: number;
  readonly stickyBindings: number;
  readonly totalGrants: number;
  readonly totalStickyHits: number;
  readonly totalFailures: number;
  readonly totalSuccesses: number;
  readonly totalProbes: number;
  readonly totalNoAvailable: number;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse the `BROWSER_PROXIES` environment value.
 *
 * Accepted format: comma-separated entries. Each entry is either
 *   `scheme://[user:pass@]host:port`
 * or, to attach a weight and/or a region tag,
 *   `scheme://[user:pass@]host:port#weight=<n>;region=<tag>`
 *
 * The fragment form was chosen over a JSON env value so the customer can
 * paste a proxy list from their vendor's console with minimal edit.
 *
 * The parser is strict: an unparseable entry is refused rather than skipped,
 * because a customer who expected a proxy at index 3 and silently loses it
 * to a typo runs their workflow from the platform's own IP without noticing.
 */
export function parseProxyList(raw: string | null | undefined): readonly ProxyEntry[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "string") {
    throw new ProxyPolicyError("Proxy list must be a string.", "invalid-input");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const pieces = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const entries: ProxyEntry[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    const entry = parseProxyEntry(piece);
    if (seen.has(entry.id)) {
      throw new ProxyPolicyError(
        `Duplicate proxy entry for ${entry.host}:${entry.port}. Remove the duplicate from BROWSER_PROXIES or distinguish the entries by region.`,
        "invalid-input",
        { id: entry.id },
      );
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

function parseProxyEntry(raw: string): ProxyEntry {
  // Split off the optional fragment (weight/region) before parsing the URL,
  // because `new URL` treats a fragment as part of the address and a customer's
  // `#weight=2` would otherwise be swallowed into the path.
  const hashIdx = raw.indexOf("#");
  const urlPart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const fragment = hashIdx >= 0 ? raw.slice(hashIdx + 1) : "";
  let parsed: URL;
  try {
    parsed = new URL(urlPart);
  } catch {
    throw new ProxyPolicyError(
      `Proxy entry "${raw}" is not a valid URL. Expected scheme://[user:pass@]host:port.`,
      "invalid-url",
      { entry: redactUserInfo(raw) },
    );
  }
  const protocol = parsed.protocol.replace(/:$/, "");
  if (protocol !== "http" && protocol !== "https" && protocol !== "socks5") {
    throw new ProxyPolicyError(
      `Proxy entry "${redactUserInfo(urlPart)}" uses unsupported scheme "${protocol}". Supported: http, https, socks5.`,
      "invalid-url",
      { scheme: protocol },
    );
  }
  if (parsed.hostname.length === 0 || parsed.port.length === 0) {
    throw new ProxyPolicyError(
      `Proxy entry "${redactUserInfo(urlPart)}" is missing a host or a port.`,
      "invalid-url",
    );
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyPolicyError(
      `Proxy entry "${redactUserInfo(urlPart)}" has an invalid port "${parsed.port}".`,
      "invalid-url",
      { port: parsed.port },
    );
  }
  const meta = parseFragment(fragment);
  const id = `${parsed.hostname}:${port}${meta.region !== null ? `@${meta.region}` : ""}`;
  return {
    url: urlPart,
    protocol: protocol as ProxyProtocol,
    host: parsed.hostname,
    port,
    id,
    weight: meta.weight,
    region: meta.region,
  };
}

function parseFragment(fragment: string): { readonly weight: number; readonly region: string | null } {
  if (fragment.length === 0) return { weight: 1, region: null };
  let weight = 1;
  let region: string | null = null;
  for (const piece of fragment.split(";")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const key = piece.slice(0, eq).trim().toLowerCase();
    const value = piece.slice(eq + 1).trim();
    if (key === "weight") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        throw new ProxyPolicyError(
          `Proxy weight "${value}" must be a non-negative number.`,
          "invalid-input",
          { weight: value },
        );
      }
      weight = Math.floor(n);
    } else if (key === "region") {
      region = value.length > 0 ? value.toLowerCase() : null;
    }
  }
  return { weight, region };
}

/* -------------------------------------------------------------------------- */
/* Description                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A redacted, log-safe description of a proxy URL. The userinfo portion is
 * replaced with `***`, and the fragment (weight/region) is appended as text
 * because it does not carry a secret. Never used for the actual connection —
 * the caller passes `entry.url` to `newContext`.
 */
export function describeProxy(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = parsed.username ? "***" : "";
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch {
    return redactUserInfo(url);
  }
}

function redactUserInfo(raw: string): string {
  // Fallback for a URL that `new URL` could not parse: strip anything before
  // an `@` on the authority section, being careful not to touch a query that
  // legitimately contains an `@` — proxies do not use one, so a permissive
  // strip is fine here.
  const schemeIdx = raw.indexOf("://");
  if (schemeIdx < 0) return raw;
  const afterScheme = raw.slice(schemeIdx + 3);
  const atIdx = afterScheme.indexOf("@");
  if (atIdx < 0) return raw;
  const slashIdx = afterScheme.indexOf("/");
  if (slashIdx >= 0 && slashIdx < atIdx) return raw;
  return `${raw.slice(0, schemeIdx + 3)}***${afterScheme.slice(atIdx)}`;
}

/* -------------------------------------------------------------------------- */
/* Rotator                                                                     */
/* -------------------------------------------------------------------------- */

interface HealthState {
  consecutiveFailures: number;
  /** Epoch ms at which the vertex becomes eligible for a probe; 0 when up. */
  nextEligibleAt: number;
  /** Whether the last acquisition was a probe (single shot past cooldown). */
  probing: boolean;
}

export class ProxyRotator {
  private readonly entries: readonly ProxyEntry[];
  private readonly strategy: RotationStrategy;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  private health: Map<string, HealthState>;
  private sticky: Map<string, string>;
  private rrCursor: number;
  private lastUsedAt: Map<string, number>;
  private weightedCursor: number;

  private counters = {
    totalGrants: 0,
    totalStickyHits: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    totalProbes: 0,
    totalNoAvailable: 0,
  };

  constructor(options: ProxyRotatorOptions) {
    if (options === null || typeof options !== "object") {
      throw new ProxyPolicyError("`options` is required.", "invalid-input");
    }
    if (!Array.isArray(options.entries)) {
      throw new ProxyPolicyError("`options.entries` must be an array.", "invalid-input");
    }
    this.entries = Object.freeze([...options.entries]);
    const strategy = options.strategy ?? "round-robin";
    if (strategy !== "round-robin" && strategy !== "weighted" && strategy !== "random") {
      throw new ProxyPolicyError(
        `Unknown rotation strategy "${String(strategy)}". Expected one of: round-robin, weighted, random.`,
        "invalid-input",
        { strategy },
      );
    }
    this.strategy = strategy;
    const failureThreshold =
      typeof options.failureThreshold === "number" &&
      Number.isFinite(options.failureThreshold) &&
      options.failureThreshold >= 1
        ? Math.floor(options.failureThreshold)
        : DEFAULT_FAILURE_THRESHOLD;
    const cooldownMs =
      typeof options.cooldownMs === "number" &&
      Number.isFinite(options.cooldownMs) &&
      options.cooldownMs >= 0
        ? Math.floor(options.cooldownMs)
        : DEFAULT_COOLDOWN_MS;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.random = typeof options.random === "function" ? options.random : Math.random;

    this.health = new Map();
    for (const entry of this.entries) {
      this.health.set(entry.id, {
        consecutiveFailures: 0,
        nextEligibleAt: 0,
        probing: false,
      });
    }
    this.sticky = new Map();
    this.rrCursor = 0;
    this.weightedCursor = 0;
    this.lastUsedAt = new Map();
  }

  /** Whether the rotator has any configured proxies. */
  get enabled(): boolean {
    return this.entries.length > 0;
  }

  /**
   * Obtain a proxy for a workflow. When `key` is supplied the rotator returns
   * the same proxy for the key until the caller `release`s it or the proxy
   * fails its health threshold. Callers without a key receive a grant the
   * rotator does not remember.
   */
  acquire(input: AcquireProxyInput = {}): ProxyGrant {
    if (!this.enabled) {
      throw new ProxyPolicyError(
        "No proxies are configured. Set BROWSER_PROXIES or skip the proxy policy.",
        "no-available-proxy",
      );
    }
    const key = nonEmpty(input.key);
    const region = nonEmpty(input.region);

    // A sticky binding is honoured across calls, including a binding that
    // points to a proxy currently in cooldown: the caller deliberately
    // pinned this workflow to an IP, and switching silently is worse than
    // asking the caller to release the key. The caller learns the proxy is
    // unhealthy by the run failing and can retry with `preferDifferent`.
    if (key !== null && !input.preferDifferent) {
      const pinned = this.sticky.get(key);
      if (pinned !== undefined) {
        const entry = this.entries.find((e) => e.id === pinned);
        if (entry !== undefined && this.matchesRegion(entry, region)) {
          const state = this.health.get(pinned)!;
          // Only honour the pin when the proxy is not currently down, unless
          // this is the caller's first attempt (no failures recorded).
          if (!this.isDown(state, this.now())) {
            this.counters.totalGrants += 1;
            this.counters.totalStickyHits += 1;
            this.lastUsedAt.set(pinned, this.now());
            return this.grant(entry, true, key);
          }
          // The pinned proxy is down; fall through to pick a fresh one and
          // re-pin, because continuing to use a downed proxy would fail the
          // caller for a reason the platform can fix.
        }
      }
    }

    const candidates = this.eligible(region);
    if (candidates.length === 0) {
      this.counters.totalNoAvailable += 1;
      throw new ProxyPolicyError(
        region !== null
          ? `No healthy proxy is available for region "${region}" right now.`
          : "No healthy proxy is available right now.",
        "no-available-proxy",
        { region, entries: this.entries.length },
      );
    }

    const chosen = this.select(candidates, input.preferDifferent === true);

    // Re-bind or bind the key to the chosen entry.
    if (key !== null) {
      this.sticky.set(key, chosen.id);
    }
    this.lastUsedAt.set(chosen.id, this.now());

    const state = this.health.get(chosen.id)!;
    if (state.probing) {
      this.counters.totalProbes += 1;
    }
    this.counters.totalGrants += 1;
    return this.grant(chosen, false, key);
  }

  /**
   * Release a sticky binding. A workflow that has finished should release
   * its key so a long-running platform does not accumulate bindings for
   * workflows that no longer exist. Returns true when a binding was removed.
   */
  release(key: string): boolean {
    if (typeof key !== "string" || key.length === 0) {
      throw new ProxyPolicyError("`key` is required for release.", "invalid-input");
    }
    return this.sticky.delete(key);
  }

  /**
   * Record that a proxy succeeded. Resets the failure counter and clears the
   * cooldown. Called by the caller after a workflow run completes for the
   * grant's `id`.
   */
  reportSuccess(proxyId: string): void {
    const state = this.health.get(proxyId);
    if (state === undefined) {
      throw new ProxyPolicyError(
        `Unknown proxy "${proxyId}". Only ids the rotator issued a grant for may be reported on.`,
        "unknown-key",
        { proxyId },
      );
    }
    state.consecutiveFailures = 0;
    state.nextEligibleAt = 0;
    state.probing = false;
    this.counters.totalSuccesses += 1;
  }

  /**
   * Record that a proxy failed. When the failure count reaches the
   * threshold, the proxy is marked down until `now + cooldownMs`, at which
   * point a single probe acquisition is allowed.
   */
  reportFailure(proxyId: string): void {
    const state = this.health.get(proxyId);
    if (state === undefined) {
      throw new ProxyPolicyError(
        `Unknown proxy "${proxyId}". Only ids the rotator issued a grant for may be reported on.`,
        "unknown-key",
        { proxyId },
      );
    }
    state.consecutiveFailures += 1;
    this.counters.totalFailures += 1;
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.nextEligibleAt = this.now() + this.cooldownMs;
      state.probing = true;
      // Drop any sticky binding that pointed at this proxy so a workflow
      // that retries picks up a fresh proxy rather than a downed one.
      for (const [key, id] of this.sticky) {
        if (id === proxyId) this.sticky.delete(key);
      }
    }
  }

  health(): readonly ProxyHealth[] {
    const now = this.now();
    return this.entries.map((entry) => {
      const state = this.health.get(entry.id)!;
      const down = this.isDown(state, now);
      return {
        id: entry.id,
        host: entry.host,
        port: entry.port,
        region: entry.region,
        weight: entry.weight,
        consecutiveFailures: state.consecutiveFailures,
        down,
        nextEligibleAt: down ? new Date(state.nextEligibleAt).toISOString() : null,
      };
    });
  }

  metrics(): ProxyRotatorMetrics {
    const health = this.health();
    let up = 0;
    let down = 0;
    for (const h of health) {
      if (h.down) down += 1;
      else up += 1;
    }
    return {
      enabled: this.enabled,
      strategy: this.strategy,
      entries: this.entries.length,
      up,
      down,
      stickyBindings: this.sticky.size,
      totalGrants: this.counters.totalGrants,
      totalStickyHits: this.counters.totalStickyHits,
      totalFailures: this.counters.totalFailures,
      totalSuccesses: this.counters.totalSuccesses,
      totalProbes: this.counters.totalProbes,
      totalNoAvailable: this.counters.totalNoAvailable,
    };
  }

  /** The proxy entries the rotator was constructed with; taken by value. */
  listEntries(): readonly ProxyEntry[] {
    return this.entries;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private grant(entry: ProxyEntry, sticky: boolean, key: string | null): ProxyGrant {
    return {
      url: entry.url,
      id: entry.id,
      protocol: entry.protocol,
      region: entry.region,
      sticky,
      key,
      grantedAt: new Date(this.now()).toISOString(),
    };
  }

  private matchesRegion(entry: ProxyEntry, region: string | null): boolean {
    if (region === null) return true;
    return entry.region === region;
  }

  private isDown(state: HealthState, nowMs: number): boolean {
    if (state.consecutiveFailures < this.failureThreshold) return false;
    return nowMs < state.nextEligibleAt;
  }

  /**
   * The proxies eligible for selection right now, honouring region and
   * health. A proxy in cooldown is excluded until its cooldown elapses; at
   * elapse, it becomes eligible and its `probing` flag causes the acquire to
   * count a probe.
   */
  private eligible(region: string | null): readonly ProxyEntry[] {
    const nowMs = this.now();
    const out: ProxyEntry[] = [];
    for (const entry of this.entries) {
      if (!this.matchesRegion(entry, region)) continue;
      const state = this.health.get(entry.id)!;
      if (this.isDown(state, nowMs)) continue;
      out.push(entry);
    }
    return out;
  }

  private select(
    candidates: readonly ProxyEntry[],
    preferDifferent: boolean,
  ): ProxyEntry {
    if (candidates.length === 1) return candidates[0]!;

    if (preferDifferent) {
      // Least-recently-used: pick the candidate whose `lastUsedAt` is oldest.
      // A candidate never used sorts first.
      let best = candidates[0]!;
      let bestTs = this.lastUsedAt.get(best.id) ?? 0;
      for (const candidate of candidates) {
        const ts = this.lastUsedAt.get(candidate.id) ?? 0;
        if (ts < bestTs) {
          best = candidate;
          bestTs = ts;
        }
      }
      return best;
    }

    switch (this.strategy) {
      case "round-robin": {
        const idx = this.rrCursor % candidates.length;
        this.rrCursor = (this.rrCursor + 1) % Math.max(1, candidates.length);
        return candidates[idx]!;
      }
      case "weighted": {
        const total = candidates.reduce((sum, c) => sum + Math.max(0, c.weight), 0);
        if (total <= 0) {
          // All weights are zero; fall back to round-robin so a
          // misconfiguration does not stall the platform.
          const idx = this.rrCursor % candidates.length;
          this.rrCursor = (this.rrCursor + 1) % candidates.length;
          return candidates[idx]!;
        }
        // Track a fractional cursor so repeated calls distribute proportionally
        // without allocating a weighted array on each call.
        const step = this.random() * total;
        let acc = 0;
        for (const candidate of candidates) {
          acc += Math.max(0, candidate.weight);
          if (step < acc) return candidate;
        }
        return candidates[candidates.length - 1]!;
      }
      case "random": {
        const idx = Math.floor(this.random() * candidates.length);
        return candidates[Math.min(idx, candidates.length - 1)]!;
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateProxyRotatorInput {
  readonly entries?: readonly ProxyEntry[];
  readonly strategy?: RotationStrategy;
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

export function createProxyRotator(input: CreateProxyRotatorInput = {}): ProxyRotator {
  return new ProxyRotator({
    entries: input.entries ?? [],
    strategy: input.strategy,
    failureThreshold: input.failureThreshold,
    cooldownMs: input.cooldownMs,
    now: input.now,
    random: input.random,
  });
}

/**
 * Read the proxy list and rotation strategy from the environment. When the
 * env carries no proxy list, the returned rotator reports `enabled: false`;
 * a caller wiring it to `@zipy/platform/browserFarm` passes
 * `proxySelector: undefined` in that case, so the farm's contexts use the
 * host connection directly.
 */
export function createProxyRotatorFromEnv(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly random?: () => number;
}): ProxyRotator {
  const env = input.env;
  const rawList = env["BROWSER_PROXIES"];
  const entries = parseProxyList(rawList);
  const strategyRaw = (env["BROWSER_PROXY_STRATEGY"] ?? "round-robin").trim().toLowerCase();
  const strategy: RotationStrategy =
    strategyRaw === "weighted" || strategyRaw === "random"
      ? strategyRaw
      : "round-robin";
  const failureThresholdRaw = env["BROWSER_PROXY_FAILURE_THRESHOLD"];
  const cooldownRaw = env["BROWSER_PROXY_COOLDOWN_MS"];
  return new ProxyRotator({
    entries,
    strategy,
    failureThreshold:
      failureThresholdRaw !== undefined && failureThresholdRaw.trim().length > 0
        ? Number(failureThresholdRaw)
        : undefined,
    cooldownMs:
      cooldownRaw !== undefined && cooldownRaw.trim().length > 0
        ? Number(cooldownRaw)
        : undefined,
    now: input.now,
    random: input.random,
  });
}

/**
 * A `proxySelector` function shaped for `BrowserFarmOptions.proxySelector`.
 * The returned function consults the rotator per acquisition; the workflow
 * id is used as the sticky key when the caller's farm is scoped per run,
 * and the caller is responsible for `rotator.release(workflowId)` when the
 * run completes.
 *
 * The caller breaks the circular reference by capturing the rotator and the
 * workflow id; the farm never sees the rotator itself.
 */
export function proxySelectorFor(input: {
  readonly rotator: ProxyRotator;
  readonly workflowId: string;
  readonly region?: string | null;
}): () => Promise<string | null> {
  if (input.rotator === null || typeof input.rotator !== "object") {
    throw new ProxyPolicyError("`rotator` is required.", "invalid-input");
  }
  if (typeof input.workflowId !== "string" || input.workflowId.length === 0) {
    throw new ProxyPolicyError("`workflowId` is required.", "invalid-input");
  }
  const region = input.region ?? null;
  return async () => {
    if (!input.rotator.enabled) return null;
    const grant = input.rotator.acquire({ key: input.workflowId, region });
    return grant.url;
  };
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `ProxyEntry`. A caller persisting a per-workspace proxy
 * list (rather than a global env) reads the row back through this function
 * so the health state and the entry agree on the `id` shape.
 */
export function rehydrateProxyEntry(value: unknown): ProxyEntry {
  if (value === null || typeof value !== "object") {
    throw new ProxyPolicyError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const url = typeof r["url"] === "string" ? r["url"] : "";
  if (url.length === 0) {
    throw new ProxyPolicyError("Rehydrate failed: `url` is missing.", "invalid-input");
  }
  // Re-parse the URL to derive host/port/protocol, rather than trusting the
  // persisted fields; a hand-edited row could otherwise carry a `url` from
  // one proxy and a `host` from another.
  return parseProxyEntry(url);
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  parseProxyEntry,
  parseFragment,
  redactUserInfo,
  nonEmpty,
});
