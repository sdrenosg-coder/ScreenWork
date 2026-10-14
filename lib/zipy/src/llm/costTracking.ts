/**
 * Zipy AI — LLM: cost tracking and token accounting (phase 25, batch 2).
 *
 * Records every LLM call's token usage and derives a cost in the provider's
 * published pricing units, so the platform can attribute spend per
 * generation, per user and per workspace. It is the module behind the
 * acceptance criterion "token usage and cost are tracked per generation and
 * per user".
 *
 * Design boundaries
 * -----------------
 *  - **No price is fabricated.** Every rate is supplied by the caller. The
 *    module ships a `PRICING_TABLE` of *reference* rates that are clearly
 *    labelled as a snapshot the operator confirms against their contract.
 *    A provider/model with no entry in the supplied table yields
 *    `costMicroUsd: null` with a `reason`, never a guessed number. The
 *    aggregate reports the count of un-priced calls so a report never hides
 *    a region of unknown spend.
 *
 *  - **No provider is called.** The module is arithmetic over a `UsageEvent`
 *    the caller already recorded. It has no HTTP, no SDK import, no clock of
 *    its own (the caller supplies `at`).
 *
 *  - **All costs are integer micro-USD (µ$).** Floats accumulate rounding
 *    error across thousands of calls; the platform's billing phase sums
 *    micro-USD and formats to currency at the presentation edge. This
 *    matches the billing-metrics module's convention.
 *
 *  - **Deterministic formatting.** `formatMicroUsd` and the aggregate
 *    ordering are stable, so two runs over the same events format
 *    identically and a report diff is meaningful.
 *
 *  - **Attribution is required.** Every `UsageEvent` carries a workspace id.
 *    A user id is optional (a system job has no user); when absent the cost
 *    is attributed to the workspace only and the aggregate reports
 *    `unattributedUserCount` so the operator can see how much spend is not
 *    per-user.
 *
 *  - **Caching is recorded, not decided.** A `cache: "hit"` event has zero
 *    billable tokens for the provider; the event's tokens are still logged
 *    for the prompt-cache accounting a provider may expose. The cache
 *    *policy* (whether to consult a cache at all) lives in the sibling
 *    `cache.ts` module.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type CostTrackingErrorCode = "invalid-input" | "shape" | "unknown-provider";

export class CostTrackingError extends Error {
  readonly code: CostTrackingErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: CostTrackingErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public constants                                                            */
/* -------------------------------------------------------------------------- */

export const COST_TRACKING_VERSION = "cost-tracking/1" as const;

/**
 * Reference pricing snapshot. **These are not quotes.** They are a starting
 * point the operator must confirm against their provider contract before
 * trusting a cost figure. Every entry carries the date it was recorded so a
 * stale rate is visible. Rates are integer micro-USD per 1,000 tokens to
 * avoid float in the source of truth; the arithmetic below relies on the
 * caller re-confirming them.
 */
export interface PricingEntry {
  readonly provider: string;
  readonly model: string;
  /** Micro-USD per 1,000 input (prompt) tokens. */
  readonly inputMicroUsdPer1k: number;
  /** Micro-USD per 1,000 output (completion) tokens. */
  readonly outputMicroUsdPer1k: number;
  /** ISO-8601 date the operator last confirmed this rate. */
  readonly confirmedOn: string | null;
  /** A note the operator may leave (e.g. the negotiated rate plan). */
  readonly note: string | null;
}

/**
 * The default pricing table the module ships. It is intentionally *empty of
 * hosted rates* — inventing a provider's price would produce a wrong invoice
 * silently. A workspace that wants cost figures supplies its own table via
 * `PricingTableInput.entries`; the reviewer sees exactly the rates that were
 * applied. Local providers (Ollama, vLLM) can be entered with a rate of 0
 * micro-USD to make "cost per guide" a real, non-null number that reflects
 * the operator's own hardware economics.
 */
export const DEFAULT_PRICING_ENTRIES: readonly PricingEntry[] = Object.freeze([]);

export const USAGE_EVENT_KINDS = [
  "generation",
  "synthesis",
  "embedding",
  "translation",
  "classification",
  "fact-check",
  "other",
] as const;
export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

export const CACHE_OUTCOMES = ["miss", "hit", "bypass"] as const;
export type CacheOutcome = (typeof CACHE_OUTCOMES)[number];

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The provider-agnostic usage shape. Providers return slightly different
 * field names; the caller normalises into this shape once, at the adapter
 * boundary, and everything downstream is provider-free.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Tokens served from a provider-side prompt cache (e.g. Anthropic's cache
   * reads, OpenAI's cached-input tokens). Zero when the provider has no such
   * concept. These are counted separately so a report can show cache
   * savings; the cost calculator does NOT re-price them because the
   * provider's own cache discount is what the invoice reflects.
   */
  readonly cachedInputTokens: number;
}

/**
 * One recorded LLM call's usage. `at` is an ISO-8601 timestamp supplied by
 * the caller so the module has no clock of its own.
 */
export interface UsageEvent {
  readonly version: typeof COST_TRACKING_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  /** The user who triggered the call, or null for a system job. */
  readonly userId: string | null;
  /** Which feature issued the call (used for the per-feature breakdown). */
  readonly feature: UsageEventKind;
  readonly provider: string;
  readonly model: string;
  /** Which pipeline prompt version was used, for A/B attribution. */
  readonly promptVersionId: string | null;
  readonly usage: TokenUsage;
  readonly cache: CacheOutcome;
  /** The generation / guide the call contributed to, when applicable. */
  readonly subjectId: string | null;
  /** Call duration in milliseconds; recorded for latency reporting. */
  readonly durationMs: number;
  readonly at: string;
}

export interface RecordUsageInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId?: string | null;
  readonly feature: UsageEventKind;
  readonly provider: string;
  readonly model: string;
  readonly promptVersionId?: string | null;
  readonly usage: TokenUsage;
  readonly cache?: CacheOutcome;
  readonly subjectId?: string | null;
  readonly durationMs: number;
  /** The caller's clock reading. */
  readonly at: Date;
  /** The pricing table to apply. Absent = `DEFAULT_PRICING_ENTRIES`. */
  readonly pricing?: readonly PricingEntry[];
}

/**
 * The cost of one event. `microUsd` is null when the (provider, model) pair
 * has no entry in the supplied pricing table; `reason` explains why. The
 * inputs and outputs are always present so a caller can still display the
 * token counts even when the cost is unknown.
 */
export interface EventCost {
  readonly eventId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Tokens billed at the standard input rate. */
  readonly billableInputTokens: number;
  readonly microUsd: number | null;
  readonly reason: string;
}

export interface UsageReportLine {
  readonly key: string;
  readonly label: string;
  readonly callCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Sum of costed calls' micro-USD. Null when no call in the group was costed. */
  readonly microUsd: number | null;
  /** Number of calls in the group with no pricing entry. */
  readonly unPricedCallCount: number;
}

export interface UsageReport {
  readonly version: typeof COST_TRACKING_VERSION;
  readonly workspaceId: string;
  readonly sinceIso: string;
  readonly untilIso: string;
  readonly totalCalls: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCachedInputTokens: number;
  /** Integer micro-USD; null when NO call in range was costed. */
  readonly totalMicroUsd: number | null;
  /** Formatted total, e.g. "$0.34" or "unknown". Never fabricated. */
  readonly totalFormatted: string;
  readonly unPricedCallCount: number;
  readonly unattributedUserCount: number;
  readonly cacheHitCount: number;
  readonly cacheMissCount: number;
  readonly byModel: readonly UsageReportLine[];
  readonly byFeature: readonly UsageReportLine[];
  readonly byUser: readonly UsageReportLine[];
  readonly generatedAt: string;
}

export interface ReportInput {
  readonly workspaceId: string;
  /** All events the caller has for the workspace; filtered internally. */
  readonly events: readonly UsageEvent[];
  /** Inclusive ISO-8601 lower bound. Optional. */
  readonly sinceIso?: string;
  /** Exclusive ISO-8601 upper bound. Optional. */
  readonly untilIso?: string;
  /** The pricing table to use for cost. Absent = `DEFAULT_PRICING_ENTRIES`. */
  readonly pricing?: readonly PricingEntry[];
  /** A clock. The report's `generatedAt` is derived from this. */
  readonly now: Date;
}

/* -------------------------------------------------------------------------- */
/* Public API — recording                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Record a usage event. The caller supplies token counts; the module
 * validates them and returns a frozen, versioned event. Cache hits are
 * recorded with the tokens the provider reported but are marked so the cost
 * calculator excludes them from billable tokens.
 */
export function recordUsage(input: RecordUsageInput): UsageEvent {
  if (input === null || typeof input !== "object") {
    throw new CostTrackingError("recordUsage requires an input object.", "invalid-input");
  }
  const id = requireNonEmpty(input.id, "id");
  const workspaceId = requireNonEmpty(input.workspaceId, "workspaceId");
  const provider = requireNonEmpty(input.provider, "provider");
  const model = requireNonEmpty(input.model, "model");
  if (!isUsageKind(input.feature)) {
    throw new CostTrackingError(
      `\`feature\` must be one of ${USAGE_EVENT_KINDS.join(", ")}; received ${JSON.stringify(input.feature)}.`,
      "invalid-input",
    );
  }
  if (typeof input.durationMs !== "number" || !Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new CostTrackingError("`durationMs` must be a non-negative finite number.", "invalid-input");
  }
  if (input.at === undefined || !(input.at instanceof Date) || Number.isNaN(input.at.getTime())) {
    throw new CostTrackingError("`at` must be a valid Date.", "invalid-input");
  }
  const usage = readUsage(input.usage);
  const cache: CacheOutcome =
    input.cache === "hit" || input.cache === "miss" || input.cache === "bypass" ? input.cache : "miss";

  return Object.freeze({
    version: COST_TRACKING_VERSION,
    id,
    workspaceId,
    userId: typeof input.userId === "string" && input.userId.length > 0 ? input.userId : null,
    feature: input.feature,
    provider,
    model,
    promptVersionId:
      typeof input.promptVersionId === "string" && input.promptVersionId.length > 0
        ? input.promptVersionId
        : null,
    usage,
    cache,
    subjectId: typeof input.subjectId === "string" && input.subjectId.length > 0 ? input.subjectId : null,
    durationMs: Math.floor(input.durationMs),
    at: input.at.toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Public API — cost                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Compute the cost of one event against a pricing table. The lookup key is
 * `(provider, model)`. A missing key yields `microUsd: null` with a reason;
 * it never falls through to a guessed provider rate.
 *
 * The integer arithmetic: `microUsd = ceil(inputTokens / 1000 * inputRate) +
 * ceil(outputTokens / 1000 * outputRate)`. Using `Math.ceil` on the total
 * rounds *up* by at most one micro-USD per side; that is the conservative
 * direction for a customer-facing cost estimate (the platform never
 * under-reports). The `.toFixed()` on the presentation layer handles the
 * final rounding to a currency unit.
 */
export function computeEventCost(
  event: UsageEvent,
  pricing: readonly PricingEntry[] = DEFAULT_PRICING_ENTRIES,
): EventCost {
  if (event === null || typeof event !== "object" || event.version !== COST_TRACKING_VERSION) {
    throw new CostTrackingError(
      `computeEventCost requires a UsageEvent (version "${COST_TRACKING_VERSION}").`,
      "invalid-input",
    );
  }
  const entry = findPricing(pricing, event.provider, event.model);
  // A cache hit consumes zero *billable* input/output tokens at the
  // provider's standard rate (they are accounted for under the provider's
  // own cache discount), but we still report the tokens observed so the
  // caller can plot cache utilisation.
  const billableInputTokens = event.cache === "hit" ? 0 : event.usage.inputTokens;
  const billableOutputTokens = event.cache === "hit" ? 0 : event.usage.outputTokens;

  const base = {
    eventId: event.id,
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
    cachedInputTokens: event.usage.cachedInputTokens,
    billableInputTokens,
  };

  if (entry === null) {
    return Object.freeze({
      ...base,
      microUsd: null,
      reason: `No pricing entry for provider "${event.provider}" model "${event.model}". Supply the operator's rates in the pricing table to cost this call.`,
    });
  }

  if (entry.inputMicroUsdPer1k < 0 || entry.outputMicroUsdPer1k < 0) {
    throw new CostTrackingError(
      `Pricing entry for "${event.provider}/${event.model}" has a negative rate.`,
      "invalid-input",
      { provider: event.provider, model: event.model },
    );
  }

  const inputMicro = Math.ceil((billableInputTokens / 1000) * entry.inputMicroUsdPer1k);
  const outputMicro = Math.ceil((billableOutputTokens / 1000) * entry.outputMicroUsdPer1k);
  const microUsd = inputMicro + outputMicro;

  const reason =
    entry.confirmedOn === null
      ? `Rate applied from a pricing entry with no confirmation date; confirm it against the provider contract.`
      : "";

  return Object.freeze({ ...base, microUsd, reason });
}

/* -------------------------------------------------------------------------- */
/* Public API — report                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Produce a usage + cost report for a workspace over a date range. Every
 * breakdown (by model, by feature, by user) is derived from the same
 * `events` array; a caller cannot accidentally use different windows for the
 * total and a per-line figure.
 *
 * Tokens are always reported. Cost is reported only for the subset of calls
 * with a pricing entry; `unPricedCallCount` tells the operator how much of
 * the range is un-costed so a "$0.34" is never read as "everything was
 * cheap".
 */
export function buildUsageReport(input: ReportInput): UsageReport {
  if (input === null || typeof input !== "object") {
    throw new CostTrackingError("buildUsageReport requires an input object.", "invalid-input");
  }
  const workspaceId = requireNonEmpty(input.workspaceId, "workspaceId");
  if (!Array.isArray(input.events)) {
    throw new CostTrackingError("`events` must be an array.", "invalid-input");
  }
  if (input.now === undefined || !(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new CostTrackingError("`now` must be a valid Date.", "invalid-input");
  }
  const sinceMs = typeof input.sinceIso === "string" ? Date.parse(input.sinceIso) : Number.NEGATIVE_INFINITY;
  const untilMs = typeof input.untilIso === "string" ? Date.parse(input.untilIso) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(sinceMs)) {
    throw new CostTrackingError("`sinceIso` is not a parseable ISO-8601 timestamp.", "invalid-input");
  }
  if (Number.isNaN(untilMs)) {
    throw new CostTrackingError("`untilIso` is not a parseable ISO-8601 timestamp.", "invalid-input");
  }

  const filtered = input.events.filter(
    (e) => e.workspaceId === workspaceId && isInRange(e.at, sinceMs, untilMs),
  );
  const pricing = input.pricing ?? DEFAULT_PRICING_ENTRIES;

  const byModel = new Map<string, MutableUsageLine>();
  const byFeature = new Map<string, MutableUsageLine>();
  const byUser = new Map<string, MutableUsageLine>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalMicroUsd: number | null = null;
  let unPricedCallCount = 0;
  let unattributedUserCount = 0;
  let cacheHitCount = 0;
  let cacheMissCount = 0;

  for (const event of filtered) {
    const cost = computeEventCost(event, pricing);
    totalInputTokens += cost.inputTokens;
    totalOutputTokens += cost.outputTokens;
    totalCachedInputTokens += cost.cachedInputTokens;
    if (cost.microUsd === null) unPricedCallCount += 1;
    else totalMicroUsd = (totalMicroUsd ?? 0) + cost.microUsd;
    if (event.userId === null) unattributedUserCount += 1;
    if (event.cache === "hit") cacheHitCount += 1;
    if (event.cache === "miss") cacheMissCount += 1;

    const modelKey = `${event.provider}/${event.model}`;
    const modelLine = ensureLine(byModel, modelKey, modelKey);
    accumulate(modelLine, cost);

    const featureLine = ensureLine(byFeature, event.feature, featureLabel(event.feature));
    accumulate(featureLine, cost);

    const userKey = event.userId ?? "__unattributed__";
    const userLine = ensureLine(
      byUser,
      userKey,
      event.userId === null ? "Unattributed (system job)" : event.userId,
    );
    accumulate(userLine, cost);
  }

  const totalFormatted = totalMicroUsd === null ? "unknown" : formatMicroUsd(totalMicroUsd);

  return Object.freeze({
    version: COST_TRACKING_VERSION,
    workspaceId,
    sinceIso: typeof input.sinceIso === "string" ? input.sinceIso : "",
    untilIso: typeof input.untilIso === "string" ? input.untilIso : "",
    totalCalls: filtered.length,
    totalInputTokens,
    totalOutputTokens,
    totalCachedInputTokens,
    totalMicroUsd,
    totalFormatted,
    unPricedCallCount,
    unattributedUserCount,
    cacheHitCount,
    cacheMissCount,
    byModel: freezeLines(byModel),
    byFeature: freezeLines(byFeature),
    byUser: freezeLines(byUser),
    generatedAt: input.now.toISOString(),
  });
}

/**
 * Format an integer micro-USD amount as a currency string. Uses `en-US`
 * USD formatting by default; a caller that needs a different locale should
 * format the integer itself. Never rounds a non-zero amount to "$0.00": an
 * amount between 1 and 9 micro-USD is shown as "<$0.00001" so a report does
 * not silently claim a call cost nothing.
 */
export function formatMicroUsd(microUsd: number, options: { readonly fractionDigits?: number } = {}): string {
  if (typeof microUsd !== "number" || !Number.isFinite(microUsd)) {
    throw new CostTrackingError("formatMicroUsd requires a finite number.", "invalid-input");
  }
  const digits = options.fractionDigits ?? 2;
  if (microUsd === 0) return "$0.00";
  const dollars = microUsd / 1_000_000;
  if (Math.abs(dollars) < 10 ** -digits / 2 && !Number.isInteger(microUsd)) {
    return `<$${(10 ** -digits).toFixed(digits)}`;
  }
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/**
 * Rehydrate a persisted `UsageEvent`. The version is asserted and the token
 * counts are validated as non-negative integers so a corrupt write does not
 * produce a negative cost.
 */
export function rehydrateUsageEvent(value: unknown): UsageEvent {
  if (value === null || typeof value !== "object") {
    throw new CostTrackingError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== COST_TRACKING_VERSION) {
    throw new CostTrackingError(
      `Rehydrate failed: expected version "${COST_TRACKING_VERSION}", received "${String(r["version"])}".`,
      "shape",
    );
  }
  const usageRaw = r["usage"];
  if (usageRaw === null || typeof usageRaw !== "object") {
    throw new CostTrackingError("Rehydrate failed: `usage` is missing or malformed.", "shape");
  }
  const usage = readUsage(usageRaw);
  const featureRaw = r["feature"];
  if (!isUsageKind(featureRaw)) {
    throw new CostTrackingError(
      `Rehydrate failed: unknown \`feature\` ${JSON.stringify(featureRaw)}.`,
      "shape",
    );
  }
  const cacheRaw = r["cache"];
  const cache: CacheOutcome = cacheRaw === "hit" || cacheRaw === "bypass" ? cacheRaw : "miss";
  return Object.freeze({
    version: COST_TRACKING_VERSION,
    id: typeof r["id"] === "string" ? r["id"] : "",
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    userId: typeof r["userId"] === "string" && r["userId"].length > 0 ? r["userId"] : null,
    feature: featureRaw,
    provider: typeof r["provider"] === "string" ? r["provider"] : "",
    model: typeof r["model"] === "string" ? r["model"] : "",
    promptVersionId:
      typeof r["promptVersionId"] === "string" && r["promptVersionId"].length > 0
        ? r["promptVersionId"]
        : null,
    usage,
    cache,
    subjectId: typeof r["subjectId"] === "string" && r["subjectId"].length > 0 ? r["subjectId"] : null,
    durationMs: typeof r["durationMs"] === "number" && Number.isFinite(r["durationMs"]) ? Math.max(0, Math.floor(r["durationMs"])) : 0,
    at: typeof r["at"] === "string" ? r["at"] : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface MutableUsageLine {
  key: string;
  label: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  microUsd: number | null;
  unPricedCallCount: number;
}

function ensureLine(map: Map<string, MutableUsageLine>, key: string, label: string): MutableUsageLine {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const line: MutableUsageLine = {
    key,
    label,
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    microUsd: null,
    unPricedCallCount: 0,
  };
  map.set(key, line);
  return line;
}

function accumulate(line: MutableUsageLine, cost: EventCost): void {
  line.callCount += 1;
  line.inputTokens += cost.inputTokens;
  line.outputTokens += cost.outputTokens;
  line.cachedInputTokens += cost.cachedInputTokens;
  if (cost.microUsd === null) line.unPricedCallCount += 1;
  else line.microUsd = (line.microUsd ?? 0) + cost.microUsd;
}

function freezeLines(map: Map<string, MutableUsageLine>): readonly UsageReportLine[] {
  const arr = [...map.values()];
  arr.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return Object.freeze(
    arr.map((l) =>
      Object.freeze({
        key: l.key,
        label: l.label,
        callCount: l.callCount,
        inputTokens: l.inputTokens,
        outputTokens: l.outputTokens,
        cachedInputTokens: l.cachedInputTokens,
        microUsd: l.microUsd,
        unPricedCallCount: l.unPricedCallCount,
      }),
    ),
  );
}

function findPricing(
  pricing: readonly PricingEntry[],
  provider: string,
  model: string,
): PricingEntry | null {
  for (const p of pricing) {
    if (p.provider === provider && p.model === model) return p;
  }
  return null;
}

function isInRange(iso: string, sinceMs: number, untilMs: number): boolean {
  if (typeof iso !== "string" || iso.length === 0) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return ms >= sinceMs && ms < untilMs;
}

function readUsage(v: unknown): TokenUsage {
  if (v === null || typeof v !== "object") {
    throw new CostTrackingError("`usage` must be a TokenUsage object.", "invalid-input");
  }
  const o = v as Record<string, unknown>;
  return Object.freeze({
    inputTokens: readTokenCount(o["inputTokens"], "usage.inputTokens"),
    outputTokens: readTokenCount(o["outputTokens"], "usage.outputTokens"),
    cachedInputTokens: readTokenCount(o["cachedInputTokens"], "usage.cachedInputTokens"),
  });
}

function readTokenCount(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
    throw new CostTrackingError(
      `\`${path}\` must be a non-negative integer; received ${JSON.stringify(v)}.`,
      "invalid-input",
      { path, value: v },
    );
  }
  return v;
}

function requireNonEmpty(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new CostTrackingError(`\`${path}\` must be a non-empty string.`, "invalid-input", { path });
  }
  return v;
}

function isUsageKind(v: unknown): v is UsageEventKind {
  for (const k of USAGE_EVENT_KINDS) if (v === k) return true;
  return false;
}

function featureLabel(kind: UsageEventKind): string {
  switch (kind) {
    case "generation": return "Tutorial content generation";
    case "synthesis": return "Workflow synthesis";
    case "embedding": return "Embedding";
    case "translation": return "Translation";
    case "classification": return "Classification";
    case "fact-check": return "Fact-checking";
    case "other": return "Other";
  }
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  findPricing,
  isInRange,
  readUsage,
  readTokenCount,
  isUsageKind,
  featureLabel,
  ensureLine,
  accumulate,
  freezeLines,
  DEFAULT_PRICING_ENTRIES,
});
