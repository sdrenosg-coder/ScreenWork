/**
 * Zipy AI — quality: regression benchmark bot (phase 25, batch 2).
 *
 * The regression bot runs a fixed benchmark suite of generation cases through
 * a caller-supplied "generate" function (the pipeline the operator wants to
 * test), scores each output, and compares the current run against a stored
 * baseline. It is the mechanism behind "changes to prompts or models are
 * tested against a benchmark suite" and "regressions are caught".
 *
 * Design boundaries
 * -----------------
 *  - No model is called from this module. The caller supplies
 *    `generate(caseInput)`; the bot is pure orchestration and scoring. This
 *    keeps the benchmark runnable against a local Ollama model, a hosted
 *    provider, or a deterministic fixture in a test, with no change.
 *
 *  - No benchmark case is invented at runtime. Cases are supplied (from the
 *    repository's `tests/benchmarks` fixtures or the A/B harness). The bot
 *    validates each case's shape and refuses a malformed one rather than
 *    filling a default.
 *
 *  - Scores are deterministic given the outputs. `scoreCase` is a pure
 *    function of (case, output); no wall-clock, no random, no model.
 *
 *  - A regression is only declared on a *measured* drop. A run whose output
 *    is flaky because a model returned different wording is reported with
 *    both the baseline and current scores so the operator sees the delta
 *    rather than a bare "fail".
 *
 *  - No baseline is fabricated. `compareToBaseline` requires a baseline that
 *    the caller previously persisted from a `RegressionRun`; when the
 *    baseline is missing, the bot reports `baseline: null` and does not
 *    invent one.
 *
 * The A/B harness in `packages/llm/src/abTest.ts` measures quality between two
 * variants on the *same* cases; this bot measures the *same* variant across
 * time. Both use `scoreCase`; the shared scorer is the reason a run recorded
 * by the bot can be consumed by the A/B report without a second metric.
 */

import type {
  AbCase,
  AbCaseOutput,
  AbScore,
  ScorerFn,
} from "@zipy/llm/abTest";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type RegressionBotErrorCode =
  | "invalid-input"
  | "missing-baseline"
  | "malformed-baseline";

export class RegressionBotError extends Error {
  readonly code: RegressionBotErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: RegressionBotErrorCode,
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

export const REGRESSION_RUN_VERSION = "regression-run/1" as const;

/** The threshold below which a delta counts as a regression, by default. */
export const DEFAULT_REGRESSION_THRESHOLD = 0.02;

/** The comparator used when a suite is scored by a single aggregate number. */
export const DEFAULT_AGGREGATE = "mean" as const;

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A benchmark case. Extends the A/B harness's `AbCase` so a case definition
 * is reused verbatim between an A/B comparison and a regression run; the bot
 * adds no fields. `tags` is used by `RegressionRunOptions.onlyTags` to run a
 * subset.
 */
export interface RegressionCase extends AbCase {
  readonly tags?: readonly string[];
}

/**
 * What the bot reports for one case. `missing` is used when the generate
 * function failed to produce an output for the case; the case is excluded
 * from the aggregate but the failure is recorded so a run does not silently
 * shrink.
 */
export interface RegressionCaseResult {
  readonly caseId: string;
  readonly tags: readonly string[];
  readonly status: "scored" | "missing" | "errored";
  readonly output: AbCaseOutput | null;
  readonly score: AbScore | null;
  /** Only present when `status === "errored"`. */
  readonly error: string | null;
  readonly durationMs: number;
}

/**
 * Aggregate over the cases that were successfully scored. Kept separate from
 * the per-case results so a caller that wants only the summary reads one
 * field.
 */
export interface RegressionAggregate {
  readonly scoredCount: number;
  readonly missingCount: number;
  readonly erroredCount: number;
  /** Aggregate over `scoredCount` cases, by `aggregateFn`. */
  readonly value: number;
  /** Mean of the scorer's `perCase` scores for explainability. */
  readonly meanScore: number;
  /** Minimum case score; a run with one bad case is not hidden by the mean. */
  readonly minScore: number;
  /** Ids of the lowest-scoring cases, ascending. */
  readonly weakestCaseIds: readonly string[];
}

export interface RegressionRun {
  readonly version: typeof REGRESSION_RUN_VERSION;
  /** Operator-supplied id, e.g. a git sha or a prompt version. */
  readonly label: string;
  /** Which variant the run tested (model + prompt version). */
  readonly variantId: string;
  readonly results: readonly RegressionCaseResult[];
  readonly aggregate: RegressionAggregate;
  /** Populated by `compareToBaseline` (the run itself always has `null` here). */
  readonly baselineComparison: RegressionComparison | null;
  readonly generatedAt: string;
}

export type RegressionVerdict = "improved" | "regressed" | "unchanged";

export interface CaseDelta {
  readonly caseId: string;
  /** Null when the case is missing from one side of the comparison. */
  readonly baselineScore: number | null;
  readonly currentScore: number | null;
  /** `current - baseline`, or null when either side is missing. */
  readonly delta: number | null;
  readonly verdict: RegressionVerdict | "case-not-in-run" | "case-not-in-baseline";
  /** Human-readable; empty when the case is unchanged. */
  readonly reason: string;
}

export interface RegressionComparison {
  readonly baselineLabel: string;
  readonly baselineVariantId: string;
  readonly threshold: number;
  readonly aggregateDelta: number;
  readonly verdict: RegressionVerdict;
  readonly regressedCaseIds: readonly string[];
  readonly improvedCaseIds: readonly string[];
  readonly caseDeltas: readonly CaseDelta[];
  /** A short, deterministic summary an operator can paste into a PR. */
  readonly summary: string;
}

export interface RegressionRunOptions {
  /** Run only the cases whose tags intersect this set. Empty = all cases. */
  readonly onlyTags?: readonly string[];
  /** Threshold below which a delta counts as a regression. */
  readonly threshold?: number;
  /** The label recorded on the run (a git sha, a version string, etc.). */
  readonly label: string;
  /** The variant id recorded on the run (model + prompt version, etc.). */
  readonly variantId: string;
  /**
   * The scorer. Reuses the A/B harness's `ScorerFn` shape; when omitted the
   * bot requires the case outputs to carry a numeric `score` field.
   */
  readonly scorer?: ScorerFn;
  /** Aggregate function over the per-case scores. Defaults to `mean`. */
  readonly aggregateFn?: "mean" | "min" | "median";
  /**
   * The generate function. `(case) => Promise<output>`; the bot calls it once
   * per case and records failures without aborting the run.
   */
  readonly generate: (testCase: RegressionCase) => Promise<AbCaseOutput>;
}

export interface RegressionBotDeps {
  /**
   * A clock. Required so a run is deterministic in tests; the module never
   * reads `Date.now()` itself. Typically `() => Date.now()` or a bound
   * `performance.now()`.
   */
  readonly now: () => number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run a benchmark suite and produce a `RegressionRun`. Cases are run
 * sequentially by default (`concurrency` is intentionally not exposed on the
 * first cut: a benchmark run is not latency-sensitive and serial execution
 * keeps a flaky provider's rate-limit behaviour deterministic).
 */
export async function runBenchmark(
  cases: readonly RegressionCase[],
  options: RegressionRunOptions,
  deps: RegressionBotDeps,
): Promise<RegressionRun> {
  if (cases === null || !Array.isArray(cases)) {
    throw new RegressionBotError("`cases` must be an array.", "invalid-input");
  }
  if (options === null || typeof options !== "object") {
    throw new RegressionBotError("`options` is required.", "invalid-input");
  }
  if (typeof options.label !== "string" || options.label.trim().length === 0) {
    throw new RegressionBotError("`options.label` is required.", "invalid-input");
  }
  if (typeof options.variantId !== "string" || options.variantId.trim().length === 0) {
    throw new RegressionBotError("`options.variantId` is required.", "invalid-input");
  }
  if (typeof options.generate !== "function") {
    throw new RegressionBotError("`options.generate` must be a function.", "invalid-input");
  }
  if (deps === null || typeof deps !== "object" || typeof deps.now !== "function") {
    throw new RegressionBotError(
      "`deps.now` is required; the bot never reads the system clock itself.",
      "invalid-input",
    );
  }

  const filteredCases = filterByTags(cases, options.onlyTags ?? []);
  const threshold = normaliseThreshold(options.threshold);

  const results: RegressionCaseResult[] = [];
  for (const testCase of filteredCases) {
    validateCase(testCase);
    const start = deps.now();
    let output: AbCaseOutput | null = null;
    let error: string | null = null;
    try {
      output = await options.generate(testCase);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const durationMs = Math.max(0, deps.now() - start);

    if (output === null && error === null) {
      error = "The generate function returned null and threw no error.";
    }

    if (output === null) {
      results.push(
        Object.freeze({
          caseId: testCase.id,
          tags: Object.freeze([...(testCase.tags ?? [])]),
          status: error === null ? "missing" : "errored",
          output: null,
          score: null,
          error,
          durationMs,
        }),
      );
      continue;
    }

    const score = scoreCase(testCase, output, options.scorer);
    results.push(
      Object.freeze({
        caseId: testCase.id,
        tags: Object.freeze([...(testCase.tags ?? [])]),
        status: "scored",
        output,
        score,
        error: null,
        durationMs,
      }),
    );
  }

  const aggregate = aggregateResults(results, options.aggregateFn ?? DEFAULT_AGGREGATE, threshold);

  return Object.freeze({
    version: REGRESSION_RUN_VERSION,
    label: options.label.trim(),
    variantId: options.variantId.trim(),
    results: Object.freeze(results),
    aggregate,
    baselineComparison: null,
    generatedAt: new Date(deps.now()).toISOString(),
  });
}

/**
 * Score one case. When the caller supplies a `ScorerFn`, that function is
 * used; otherwise the output's own `score` field is read, and a case whose
 * output carries no numeric `score` is an error rather than a fabricated 0.
 *
 * The isolated decision to accept the output's own `score` is deliberate:
 * a deterministic fixture in a test is a legitimate output shape, and the
 * fixture's authored score is more informative than any heuristic the bot
 * could apply.
 */
export function scoreCase(
  testCase: RegressionCase,
  output: AbCaseOutput,
  scorer: ScorerFn | undefined,
): AbScore {
  if (scorer !== undefined) {
    const score = scorer(testCase, output);
    return normaliseScore(testCase.id, score);
  }
  const outputScore = readOutputScore(output);
  if (outputScore === null) {
    throw new RegressionBotError(
      `Case "${testCase.id}" produced an output with no score and no scorer was supplied. Supply a scorer or give the output a numeric \`score\` field.`,
      "invalid-input",
      { caseId: testCase.id },
    );
  }
  return Object.freeze({
    value: outputScore,
    perCase: Object.freeze({ [testCase.id]: outputScore }),
  });
}

/**
 * Compare a run to a baseline. The baseline is a previously persisted
 * `RegressionRun`; the bot does not synthesize one. Regressions are declared
 * per-case *and* in aggregate; the aggregate verdict is `regressed` when
 * either the aggregate delta is below -threshold or more than one case
 * regressed, so a run that gains overall but breaks a specific workflow is
 * still flagged.
 */
export function compareToBaseline(
  current: RegressionRun,
  baseline: unknown,
  options: { readonly threshold?: number } = {},
): RegressionComparison {
  if (baseline === null || typeof baseline !== "object") {
    throw new RegressionBotError(
      "`baseline` is required; the bot never invents a baseline.",
      "missing-baseline",
    );
  }
  const b = baseline as Partial<RegressionRun>;
  if (b.version !== REGRESSION_RUN_VERSION) {
    throw new RegressionBotError(
      `Baseline has version "${String(b.version)}" (expected "${REGRESSION_RUN_VERSION}").`,
      "malformed-baseline",
      { version: b.version },
    );
  }
  if (!Array.isArray(b.results)) {
    throw new RegressionBotError(
      "Baseline has no `results` array; it cannot be compared.",
      "malformed-baseline",
    );
  }

  const threshold = normaliseThreshold(options.threshold);
  const baselineById = indexScores(b.results);
  const currentById = indexScores(current.results);

  const caseDeltas: CaseDelta[] = [];
  const regressedCaseIds: string[] = [];
  const improvedCaseIds: string[] = [];

  const allCaseIds = new Set<string>([...baselineById.keys(), ...currentById.keys()]);
  const sortedIds = [...allCaseIds].sort();

  for (const caseId of sortedIds) {
    const bScore = baselineById.get(caseId);
    const cScore = currentById.get(caseId);
    if (bScore === undefined && cScore !== undefined) {
      caseDeltas.push({
        caseId,
        baselineScore: null,
        currentScore: cScore,
        delta: null,
        verdict: "case-not-in-baseline",
        reason: "Case is present in the current run but not the baseline; add it to the baseline before relying on this comparison.",
      });
      continue;
    }
    if (bScore !== undefined && cScore === undefined) {
      caseDeltas.push({
        caseId,
        baselineScore: bScore,
        currentScore: null,
        delta: null,
        verdict: "case-not-in-run",
        reason: "Case is in the baseline but the current run did not produce a score for it; the case may have errored or been filtered out.",
      });
      continue;
    }
    if (bScore === undefined || cScore === undefined) continue;

    const delta = round4(cScore - bScore);
    const verdict: RegressionVerdict =
      delta < -threshold ? "regressed" : delta > threshold ? "improved" : "unchanged";
    if (verdict === "regressed") regressedCaseIds.push(caseId);
    if (verdict === "improved") improvedCaseIds.push(caseId);

    caseDeltas.push({
      caseId,
      baselineScore: bScore,
      currentScore: cScore,
      delta,
      verdict,
      reason:
        verdict === "unchanged"
          ? ""
          : `Case score moved from ${bScore.toFixed(3)} to ${cScore.toFixed(3)} (${delta >= 0 ? "+" : ""}${delta.toFixed(3)}).`,
    });
  }

  const baseAgg = readAggregateValue(b);
  const curAgg = current.aggregate.value;
  const aggregateDelta = round4(curAgg - baseAgg);
  const verdict: RegressionVerdict =
    aggregateDelta < -threshold || regressedCaseIds.length > 1
      ? "regressed"
      : aggregateDelta > threshold || improvedCaseIds.length > 1
        ? "improved"
        : "unchanged";

  const summary = buildSummary(
    verdict,
    aggregateDelta,
    regressedCaseIds,
    improvedCaseIds,
    current,
    b,
    threshold,
  );

  return Object.freeze({
    baselineLabel: typeof b.label === "string" ? b.label : "(unknown)",
    baselineVariantId: typeof b.variantId === "string" ? b.variantId : "(unknown)",
    threshold,
    aggregateDelta,
    verdict,
    regressedCaseIds: Object.freeze([...regressedCaseIds]),
    improvedCaseIds: Object.freeze([...improvedCaseIds]),
    caseDeltas: Object.freeze(caseDeltas),
    summary,
  });
}

/**
 * Convenience wrapper: run, compare to the supplied baseline, and return the
 * run with its `baselineComparison` populated. The result is the shape the
 * CI report serialises.
 */
export async function runAndCompare(
  cases: readonly RegressionCase[],
  options: RegressionRunOptions,
  baseline: unknown,
  deps: RegressionBotDeps,
): Promise<RegressionRun> {
  const run = await runBenchmark(cases, options, deps);
  const comparison = compareToBaseline(run, baseline, { threshold: options.threshold });
  return Object.freeze({ ...run, baselineComparison: comparison });
}

/**
 * Rehydrate a persisted `RegressionRun`. The version is asserted and every
 * field is shape-checked so a stored run with a new field cannot be consumed
 * by an older comparator without the caller seeing the mismatch.
 */
export function rehydrateRegressionRun(value: unknown): RegressionRun {
  if (value === null || typeof value !== "object") {
    throw new RegressionBotError("Rehydrate failed: payload is not an object.", "malformed-baseline");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== REGRESSION_RUN_VERSION) {
    throw new RegressionBotError(
      `Rehydrate failed: expected version "${REGRESSION_RUN_VERSION}", received "${String(r["version"])}".`,
      "malformed-baseline",
      { version: r["version"] },
    );
  }
  const resultsRaw = Array.isArray(r["results"]) ? r["results"] : [];
  const results: RegressionCaseResult[] = [];
  for (const raw of resultsRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const status = o["status"];
    const normalisedStatus: RegressionCaseResult["status"] =
      status === "scored" || status === "missing" || status === "errored" ? status : "missing";
    const score = readScore(o["score"]);
    results.push(
      Object.freeze({
        caseId: typeof o["caseId"] === "string" ? o["caseId"] : "",
        tags: Object.freeze(
          Array.isArray(o["tags"]) ? o["tags"].filter((t): t is string => typeof t === "string") : [],
        ),
        status: normalisedStatus,
        output: null,
        score,
        error: typeof o["error"] === "string" ? o["error"] : null,
        durationMs: typeof o["durationMs"] === "number" && Number.isFinite(o["durationMs"]) ? o["durationMs"] : 0,
      }),
    );
  }
  const aggregate = readAggregate(r["aggregate"]);
  return Object.freeze({
    version: REGRESSION_RUN_VERSION,
    label: typeof r["label"] === "string" ? r["label"] : "",
    variantId: typeof r["variantId"] === "string" ? r["variantId"] : "",
    results: Object.freeze(results),
    aggregate,
    baselineComparison: null,
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function validateCase(testCase: RegressionCase): void {
  if (testCase === null || typeof testCase !== "object") {
    throw new RegressionBotError("Each case must be an object.", "invalid-input");
  }
  if (typeof testCase.id !== "string" || testCase.id.trim().length === 0) {
    throw new RegressionBotError("Each case requires a non-empty string `id`.", "invalid-input");
  }
  if (testCase.tags !== undefined && !Array.isArray(testCase.tags)) {
    throw new RegressionBotError(`Case "${testCase.id}" has a non-array \`tags\`.`, "invalid-input");
  }
}

function filterByTags(
  cases: readonly RegressionCase[],
  onlyTags: readonly string[],
): readonly RegressionCase[] {
  if (onlyTags.length === 0) return cases;
  const wanted = new Set(onlyTags);
  return cases.filter((c) => {
    const tags = c.tags ?? [];
    for (const t of tags) if (wanted.has(t)) return true;
    return false;
  });
}

function normaliseThreshold(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return DEFAULT_REGRESSION_THRESHOLD;
  return v;
}

function readOutputScore(output: AbCaseOutput): number | null {
  if (output === null || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const s = o["score"];
  if (typeof s === "number" && Number.isFinite(s)) return s;
  return null;
}

function normaliseScore(caseId: string, score: AbScore): AbScore {
  if (score === null || typeof score !== "object") {
    throw new RegressionBotError(
      `Scorer returned a non-object for case "${caseId}".`,
      "invalid-input",
      { caseId },
    );
  }
  if (typeof score.value !== "number" || !Number.isFinite(score.value)) {
    throw new RegressionBotError(
      `Scorer returned a non-numeric \`value\` for case "${caseId}".`,
      "invalid-input",
      { caseId, value: score.value },
    );
  }
  const perCase = score.perCase !== null && typeof score.perCase === "object" ? score.perCase : {};
  return Object.freeze({ value: score.value, perCase: Object.freeze({ ...perCase }) });
}

function aggregateResults(
  results: readonly RegressionCaseResult[],
  aggregateFn: "mean" | "min" | "median",
  _threshold: number,
): RegressionAggregate {
  const scored = results.filter(
    (r): r is RegressionCaseResult & { score: AbScore } => r.status === "scored" && r.score !== null,
  );
  const scores = scored.map((r) => r.score.value);
  const missingCount = results.filter((r) => r.status === "missing").length;
  const erroredCount = results.filter((r) => r.status === "errored").length;

  if (scores.length === 0) {
    return Object.freeze({
      scoredCount: 0,
      missingCount,
      erroredCount,
      value: 0,
      meanScore: 0,
      minScore: 0,
      weakestCaseIds: Object.freeze([]),
    });
  }

  const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const minScore = Math.min(...scores);
  const value =
    aggregateFn === "min"
      ? minScore
      : aggregateFn === "median"
        ? computeMedian(scores)
        : meanScore;

  // The weakest case ids are the cases at the aggregate's own tail: every
  // case whose score is at or below the aggregate value. Sorted by score
  // ascending, then id ascending, so the list is stable for a given run.
  const ranked = [...scored].sort((a, b) => {
    const byScore = a.score.value - b.score.value;
    if (byScore !== 0) return byScore;
    return a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0;
  });
  const weakestCaseIds = ranked
    .filter((r) => r.score.value <= value)
    .slice(0, 5)
    .map((r) => r.caseId);

  return Object.freeze({
    scoredCount: scored.length,
    missingCount,
    erroredCount,
    value: round4(value),
    meanScore: round4(meanScore),
    minScore: round4(minScore),
    weakestCaseIds: Object.freeze(weakestCaseIds),
  });
}

function computeMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  const a = sorted[mid - 1] as number;
  const b = sorted[mid] as number;
  return (a + b) / 2;
}

function indexScores(
  results: readonly RegressionCaseResult[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of results) {
    if (r.status !== "scored" || r.score === null) continue;
    out.set(r.caseId, r.score.value);
  }
  return out;
}

function readAggregateValue(run: Partial<RegressionRun>): number {
  const agg = run.aggregate;
  if (agg !== null && typeof agg === "object" && typeof agg.value === "number" && Number.isFinite(agg.value)) {
    return agg.value;
  }
  return 0;
}

function readAggregate(v: unknown): RegressionAggregate {
  if (v === null || typeof v !== "object") {
    return Object.freeze({
      scoredCount: 0,
      missingCount: 0,
      erroredCount: 0,
      value: 0,
      meanScore: 0,
      minScore: 0,
      weakestCaseIds: Object.freeze([]),
    });
  }
  const o = v as Record<string, unknown>;
  const readFinite = (key: string): number => {
    const x = o[key];
    return typeof x === "number" && Number.isFinite(x) ? x : 0;
  };
  const weakestRaw = Array.isArray(o["weakestCaseIds"]) ? o["weakestCaseIds"] : [];
  const weakestCaseIds = weakestRaw.filter((s): s is string => typeof s === "string");
  return Object.freeze({
    scoredCount: readFinite("scoredCount"),
    missingCount: readFinite("missingCount"),
    erroredCount: readFinite("erroredCount"),
    value: readFinite("value"),
    meanScore: readFinite("meanScore"),
    minScore: readFinite("minScore"),
    weakestCaseIds: Object.freeze(weakestCaseIds),
  });
}

function readScore(v: unknown): AbScore | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o["value"] !== "number" || !Number.isFinite(o["value"])) return null;
  const perCaseRaw = o["perCase"];
  const perCase =
    perCaseRaw !== null && typeof perCaseRaw === "object"
      ? Object.fromEntries(
          Object.entries(perCaseRaw as Record<string, unknown>).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
          ),
        )
      : {};
  return Object.freeze({ value: o["value"], perCase: Object.freeze(perCase) });
}

function buildSummary(
  verdict: RegressionVerdict,
  aggregateDelta: number,
  regressedCaseIds: readonly string[],
  improvedCaseIds: readonly string[],
  current: RegressionRun,
  baseline: Partial<RegressionRun>,
  threshold: number,
): string {
  const deltaStr = `${aggregateDelta >= 0 ? "+" : ""}${aggregateDelta.toFixed(4)}`;
  const baseLabel = typeof baseline.label === "string" ? baseline.label : "(unknown)";
  const head = `Regression verdict: ${verdict.toUpperCase()} — aggregate moved ${deltaStr} (threshold ${threshold}) from baseline "${baseLabel}" to current "${current.label}" (variant "${current.variantId}").`;
  const regPart =
    regressedCaseIds.length === 0
      ? "No cases regressed."
      : `Regressed cases: ${regressedCaseIds.join(", ")}.`;
  const impPart =
    improvedCaseIds.length === 0 ? "" : ` Improved cases: ${improvedCaseIds.join(", ")}.`;
  return `${head} ${regPart}${impPart}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  validateCase,
  filterByTags,
  normaliseThreshold,
  readOutputScore,
  normaliseScore,
  aggregateResults,
  computeMedian,
  indexScores,
  readAggregateValue,
  readAggregate,
  readScore,
  buildSummary,
  round4,
  DEFAULT_REGRESSION_THRESHOLD,
  DEFAULT_AGGREGATE,
});
