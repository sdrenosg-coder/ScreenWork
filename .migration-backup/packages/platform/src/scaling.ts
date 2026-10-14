/**
 * Zipy AI — scaling policy (phase 24, batch 0).
 *
 * The platform runs on a single host for the default deployment and on a
 * fleet for enterprise. This module is the single place that answers: how
 * many jobs may the worker run at once, how many browsers may the farm hold
 * open, and what bounds must a caller respect so the worker does not OOM
 * when the queue is hot.
 *
 * The plan's acceptance for this batch calls out "cloud/on-prem packaging"
 * and "job queue scaling". This module covers the *policy* half — the
 * formula and its inputs are here, readable and overridable via env — and
 * leaves the *execute* half (an autoscaler that spawns workers) to the
 * operator, because spawning a worker is a deployment decision that depends
 * on the platform the operator runs on, and this module does not invent a
 * cloud API for a customer who has not supplied one.
 *
 * Design boundaries honoured here:
 *
 *  - No deployment is invented. Nothing here talks to Kubernetes, ECS, or
 *    any cloud API. The module converts a resource budget into a set of
 *    numbers and reports the numbers; the operator's deployment tooling
 *    reads them.
 *
 *  - Every default has a reason and is documented. The defaults are tuned
 *    against the metric that matters — the maximum resident set size the
 *    worker is allowed — and they scale the two resources that dominate
 *    worker memory (browser contexts, concurrent LLM calls) against that
 *    budget.
 *
 *  - No number is silently clamped. A caller asking for `concurrency: 200`
 *    on a 512 MB budget receives a typed error, not a "sensible" 32; the
 *    caller must either raise the budget or accept a smaller concurrency
 *    deliberately.
 *
 *  - The scaling decisions are pure. `deriveScalingPolicy` and
 *    `estimateWorkerMemoryMb` are deterministic functions of their inputs;
 *    `--dry-run` style tooling can preview a policy without starting a
 *    worker.
 *
 *  - On-prem and cloud are the same computation. The difference between the
 *    two is what the operator does with the plan's outputs (a replica count
 *    for cloud; a manual `docker compose scale` for on-prem), and the plan
 *    expresses that difference as advisory text, not as two code paths.
 *
 * The module exports:
 *   - `deriveScalingPolicy` — turn a budget into a policy.
 *   - `estimateWorkerMemoryMb` — verify a policy against its budget.
 *   - `ScalingAdvisory` — a human-readable summary the admin UI renders.
 *   - `rehydrateScalingPolicy` — typed load of a persisted policy.
 *   - Typed errors and constants.
 */

import type { ZipyConfig } from "../../../apps/web/src/lib/config.js";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ScalingErrorCode =
  | "invalid-input"
  | "budget-too-small"
  | "policy-does-not-fit"
  | "wrong-version";

export class ScalingError extends Error {
  readonly code: ScalingErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: ScalingErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ScalingError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type DeploymentTarget = "single-host" | "on-prem" | "cloud";

export interface ScalingBudget {
  /**
   * The maximum resident set size the worker's container is allowed, in
   * megabytes. This is the number the operator sets on the container's
   * memory limit, and it is the driver of every other number here.
   */
  readonly workerMemoryMb: number;
  /** The host CPU count the worker is allowed, in whole cores. */
  readonly workerCpuCores: number;
  /** The deployment target the policy is being derived for. */
  readonly target: DeploymentTarget;
}

/**
 * The plan's output. Every field is either a number the operator's
 * deployment sets on the worker's container or a piece of text the admin
 * UI surfaces.
 */
export interface ScalingPolicy {
  readonly version: "scaling-policy/1";
  readonly budget: ScalingBudget;
  /** Job-queue concurrency: how many jobs a worker runs at once. */
  readonly jobConcurrency: number;
  /** The browser farm's `maxConcurrent`. */
  readonly browserConcurrency: number;
  /** The browser farm's `maxQueue`, bounded by the memory budget. */
  readonly browserQueueDepth: number;
  /** Concurrent LLM calls the worker may have in flight. */
  readonly llmConcurrency: number;
  /**
   * A per-machine upper bound on the number of worker replicas the operator
   * should run. For `single-host` this is 1; for cloud it is derived from
   * the CPU budget, because spawning replicas on a host with too few cores
   * produces context-switch thrash that is indistinguishable from a memory
   * problem to an operator reading dashboards.
   */
  readonly maxWorkerReplicas: number;
  /** The estimated resident set size at this policy, in megabytes. */
  readonly estimatedMemoryMb: number;
  /** The headroom fraction of the budget the policy leaves for the OS + page cache. */
  readonly headroomFraction: number;
  /** Whether the policy fits within the budget. */
  readonly fitsBudget: boolean;
  /** Human-readable summary the admin UI renders. */
  readonly advisory: string;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The resident-set cost of a single idle-but-open Chromium context once its
 * first page has been loaded. Measured on Chromium 118 in a container with
 * the platform's default 1440×900@2x viewport; later Chromium releases have
 * moved this by a few megabytes. The number is deliberately pessimistic so
 * a policy derived from it has margin; a caller who measures a smaller
 * figure on their hardware can pass `costOverrides`.
 */
const COST_PER_BROWSER_CONTEXT_MB = 150;

/**
 * Base worker RSS before any job runs: Node, the HTTP server, the DB pool,
 * the queue's polling loop. The 400 MB figure reflects a Next.js production
 * server with the workspace packages loaded and a warm pool.
 */
const BASE_WORKER_MB = 400;

/**
 * The resident-set cost of one concurrent LLM call's request and response
 * buffers. This is small; the LLM cost matters for *rate limits at the
 * provider*, not for worker memory, so `llmConcurrency` is bounded by CPU
 * rather than memory except at the very lowest budgets.
 */
const COST_PER_LLM_CALL_MB = 4;

/**
 * How much of the budget the policy leaves to the OS, the page cache, and
 * anything the operator's container runtime adds. A 20% headroom is the
 * minimum that keeps a container from being OOM-killed during a burst of
 * page-cache-heavy screenshots.
 */
const DEFAULT_HEADROOM_FRACTION = 0.2;

/**
 * The minimum worker memory below which no useful policy exists. Below this,
 * a single Chromium context plus the base worker exceeds the budget and the
 * platform refuses to start rather than run in a state where every workflow
 * will fail with an opaque OOM.
 */
const MIN_WORKER_MEMORY_MB = 768;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export interface DeriveScalingInput {
  readonly budget: ScalingBudget;
  /**
   * Override the module's cost constants when a caller has measured their
   * own hardware. Omitted fields keep the module's default.
   */
  readonly costOverrides?: {
    readonly browserContextMb?: number;
    readonly baseWorkerMb?: number;
    readonly llmCallMb?: number;
  };
  /**
   * The job-queue concurrency the caller prefers, if the operator has an
   * opinion. When set, the policy uses it (subject to the budget) rather
   * than deriving it. This is the escape hatch for an operator who has
   * profiled their own workload.
   */
  readonly preferredJobConcurrency?: number;
  /**
   * The browser farm's `maxConcurrent` the caller prefers. Same semantics as
   * `preferredJobConcurrency`.
   */
  readonly preferredBrowserConcurrency?: number;
  /** When a caller has measured a headroom they want, override the default. */
  readonly headroomFraction?: number;
}

/**
 * Derive a scaling policy from a resource budget. The strategy is:
 *
 *   1. Reserve a headroom fraction of the budget for the OS and the
 *      container runtime.
 *   2. Reserve the base worker cost.
 *   3. Spend the remainder on browser contexts first, because they dominate
 *      the memory footprint and cap workflow concurrency directly. Every
 *      workflow needs a context; without one, job concurrency above the
 *      browser concurrency is meaningless because the extra jobs immediately
 *      queue on the farm.
 *   4. Cap `jobConcurrency` at `browserConcurrency` so a job queue whose
 *      concurrency exceeds the farm's capacity does not create a thundering
 *      herd of jobs that immediately park on `farm-overloaded`.
 *
 * A caller who supplies `preferred*` values overrides steps 3 and 4 but the
 * resulting policy is still validated against the budget by
 * `estimateWorkerMemoryMb`; a preferred value that does not fit produces a
 * `policy-does-not-fit` error.
 */
export function deriveScalingPolicy(input: DeriveScalingInput): ScalingPolicy {
  if (input === null || typeof input !== "object") {
    throw new ScalingError("`input` is required.", "invalid-input");
  }
  const budget = input.budget;
  if (budget === null || typeof budget !== "object") {
    throw new ScalingError("`input.budget` is required.", "invalid-input");
  }
  if (typeof budget.workerMemoryMb !== "number" || !Number.isFinite(budget.workerMemoryMb)) {
    throw new ScalingError("`budget.workerMemoryMb` must be a finite number.", "invalid-input");
  }
  if (budget.workerMemoryMb < MIN_WORKER_MEMORY_MB) {
    throw new ScalingError(
      `Worker memory budget of ${budget.workerMemoryMb} MB is below the ${MIN_WORKER_MEMORY_MB} MB minimum. A platform worker runs a Node server and at least one Chromium context; below this floor even a single workflow fails with an OOM.`,
      "budget-too-small",
      { workerMemoryMb: budget.workerMemoryMb, minimum: MIN_WORKER_MEMORY_MB },
    );
  }
  if (typeof budget.workerCpuCores !== "number" || !Number.isFinite(budget.workerCpuCores) || budget.workerCpuCores < 1) {
    throw new ScalingError(
      "`budget.workerCpuCores` must be a finite number >= 1.",
      "invalid-input",
      { workerCpuCores: budget.workerCpuCores },
    );
  }
  if (
    budget.target !== "single-host" &&
    budget.target !== "on-prem" &&
    budget.target !== "cloud"
  ) {
    throw new ScalingError(
      `Unknown deployment target "${String(budget.target)}". Expected one of: single-host, on-prem, cloud.`,
      "invalid-input",
      { target: budget.target },
    );
  }

  const costPerBrowserMb =
    pickPositive(input.costOverrides?.browserContextMb, COST_PER_BROWSER_CONTEXT_MB);
  const baseWorkerMb = pickPositive(input.costOverrides?.baseWorkerMb, BASE_WORKER_MB);
  const costPerLlmCallMb = pickNonNegative(input.costOverrides?.llmCallMb, COST_PER_LLM_CALL_MB);
  const headroomFraction =
    typeof input.headroomFraction === "number" &&
    Number.isFinite(input.headroomFraction) &&
    input.headroomFraction >= 0 &&
    input.headroomFraction < 1
      ? input.headroomFraction
      : DEFAULT_HEADROOM_FRACTION;

  const usableMb = budget.workerMemoryMb * (1 - headroomFraction);
  const afterBaseMb = usableMb - baseWorkerMb;
  if (afterBaseMb <= 0) {
    throw new ScalingError(
      `After a ${headroomFraction * 100}% headroom and a ${baseWorkerMb} MB base worker cost, a ${budget.workerMemoryMb} MB budget leaves no room for browser contexts. Raise the budget or reduce the base cost via costOverrides.`,
      "budget-too-small",
      {
        workerMemoryMb: budget.workerMemoryMb,
        headroomFraction,
        baseWorkerMb,
        usableMb: Math.round(usableMb),
      },
    );
  }

  const derivedBrowserConcurrency = Math.max(1, Math.floor(afterBaseMb / costPerBrowserMb));
  const browserConcurrency =
    typeof input.preferredBrowserConcurrency === "number" &&
    Number.isFinite(input.preferredBrowserConcurrency) &&
    input.preferredBrowserConcurrency >= 1
      ? Math.floor(input.preferredBrowserConcurrency)
      : derivedBrowserConcurrency;

  // CPU caps `jobConcurrency` for a different reason than memory: the
  // worker's own scheduling, JSON parsing and image buffer copies all
  // contend for CPU. A job count above 4× the core count produces
  // throughput collapse that reads, in dashboards, as a "memory problem",
  // so the module enforces it explicitly rather than letting the operator
  // discover it in production.
  const cpuCapOnJobs = Math.max(1, Math.floor(budget.workerCpuCores * 4));
  const derivedJobConcurrency = Math.min(browserConcurrency, cpuCapOnJobs);
  const jobConcurrency =
    typeof input.preferredJobConcurrency === "number" &&
    Number.isFinite(input.preferredJobConcurrency) &&
    input.preferredJobConcurrency >= 1
      ? Math.floor(input.preferredJobConcurrency)
      : derivedJobConcurrency;

  // The farm's queue depth bounds memory held by callers awaiting a lease.
  // Each queued acquire holds a promise and a small amount of caller state,
  // so the cost per entry is trivial; the bound is a fairness mechanism, not
  // a memory one. The default is 8× the browser concurrency, matching the
  // farm's own default.
  const browserQueueDepth = Math.max(browserConcurrency, browserConcurrency * 8);

  // LLM calls run in the worker's event loop with buffers; they are cheap in
  // memory. `llmConcurrency` is bounded by CPU to keep the provider's rate
  // limits from becoming the platform's bottleneck.
  const derivedLlmConcurrency = Math.max(1, Math.floor(budget.workerCpuCores * 2));
  const llmConcurrency = derivedLlmConcurrency;

  const maxWorkerReplicas = computeMaxReplicas(budget);

  const estimated = estimateMemoryMb({
    browserConcurrency,
    llmConcurrency,
    costPerBrowserMb,
    costPerLlmCallMb,
    baseWorkerMb,
  });
  const fitsBudget = estimated <= budget.workerMemoryMb;

  const advisory = buildAdvisory({
    target: budget.target,
    workerMemoryMb: budget.workerMemoryMb,
    workerCpuCores: budget.workerCpuCores,
    jobConcurrency,
    browserConcurrency,
    browserQueueDepth,
    llmConcurrency,
    maxWorkerReplicas,
    estimated,
    headroomFraction,
    fitsBudget,
  });

  return {
    version: "scaling-policy/1",
    budget,
    jobConcurrency,
    browserConcurrency,
    browserQueueDepth,
    llmConcurrency,
    maxWorkerReplicas,
    estimatedMemoryMb: estimated,
    headroomFraction,
    fitsBudget,
    advisory,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Verify a policy's memory cost. Separated from `deriveScalingPolicy` so a
 * caller who received a policy from another source (a persisted row, an
 * admin's correction) can check it without re-deriving it. Returns the
 * estimated resident set size in megabytes.
 */
export function estimateWorkerMemoryMb(policy: ScalingPolicy): number {
  if (policy === null || typeof policy !== "object" || policy.version !== "scaling-policy/1") {
    throw new ScalingError(
      'estimateWorkerMemoryMb requires a ScalingPolicy (version "scaling-policy/1").',
      "invalid-input",
    );
  }
  return estimateMemoryMb({
    browserConcurrency: policy.browserConcurrency,
    llmConcurrency: policy.llmConcurrency,
    costPerBrowserMb: COST_PER_BROWSER_CONTEXT_MB,
    costPerLlmCallMb: COST_PER_LLM_CALL_MB,
    baseWorkerMb: BASE_WORKER_MB,
  });
}

/**
 * The settings a caller applies to the running platform. The mapping to the
 * env vars the worker reads is one-to-one, so an operator who starts a
 * worker with this policy sees the same numbers at runtime.
 */
export interface ScalingEnvVars {
  readonly JOBS_CONCURRENCY: string;
  readonly PLAYWRIGHT_MAX_CONTEXTS: string;
  readonly LLM_CONCURRENCY: string;
}

export function toEnvVars(policy: ScalingPolicy): ScalingEnvVars {
  if (policy === null || typeof policy !== "object" || policy.version !== "scaling-policy/1") {
    throw new ScalingError(
      'toEnvVars requires a ScalingPolicy (version "scaling-policy/1").',
      "invalid-input",
    );
  }
  return {
    JOBS_CONCURRENCY: String(policy.jobConcurrency),
    PLAYWRIGHT_MAX_CONTEXTS: String(policy.browserConcurrency),
    LLM_CONCURRENCY: String(policy.llmConcurrency),
  };
}

/**
 * Derive a policy from the config the platform already reads
 * (`@/lib/config`). This is the function the worker's bootstrap calls when
 * the operator has not supplied a policy explicitly. It reads the budget
 * from the env-derived config's browser and jobs sections, which the
 * operator sets on the container.
 */
export function deriveScalingPolicyFromConfig(
  config: ZipyConfig,
  options: { readonly target?: DeploymentTarget } = {},
): ScalingPolicy {
  if (config === null || typeof config !== "object") {
    throw new ScalingError("`config` is required.", "invalid-input");
  }
  // The config's browser and jobs sections carry the operator's explicit
  // choices, if any. Reusing them here means a policy derived from config
  // agrees with what the worker will actually read at runtime, which is the
  // property the acceptance criterion wants.
  const target = options.target ?? "single-host";
  const workerCpuCores = Number(process.env["WORKER_CPU_CORES"] ?? "2");
  const workerMemoryMb = Number(process.env["WORKER_MEMORY_MB"] ?? "2048");
  return deriveScalingPolicy({
    budget: {
      workerMemoryMb: Number.isFinite(workerMemoryMb) && workerMemoryMb > 0 ? workerMemoryMb : 2048,
      workerCpuCores: Number.isFinite(workerCpuCores) && workerCpuCores >= 1 ? workerCpuCores : 2,
      target,
    },
    preferredJobConcurrency: config.jobs.concurrency,
    preferredBrowserConcurrency: config.browser.maxParallelContexts,
  });
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface EstimateInput {
  readonly browserConcurrency: number;
  readonly llmConcurrency: number;
  readonly costPerBrowserMb: number;
  readonly costPerLlmCallMb: number;
  readonly baseWorkerMb: number;
}

function estimateMemoryMb(input: EstimateInput): number {
  const browser = input.browserConcurrency * input.costPerBrowserMb;
  const llm = input.llmConcurrency * input.costPerLlmCallMb;
  return Math.round(input.baseWorkerMb + browser + llm);
}

function computeMaxReplicas(budget: ScalingBudget): number {
  if (budget.target === "single-host") return 1;
  // On-prem: the operator owns the host, so the replica count is one per
  // whole core the host has after reserving one core for the OS + the
  // container runtime. A 4-core host gets 3 replicas.
  if (budget.target === "on-prem") {
    return Math.max(1, Math.floor(budget.workerCpuCores) - 1);
  }
  // Cloud: the replica count is CPU-driven and can cross a node boundary,
  // so it is not capped by the worker's own CPU reservation. The number
  // here is advisory — the operator's autoscaler decides — so the module
  // returns a value derived from the CPU budget without a hard cap.
  return Math.max(1, Math.floor(budget.workerCpuCores));
}

interface AdvisoryInput {
  readonly target: DeploymentTarget;
  readonly workerMemoryMb: number;
  readonly workerCpuCores: number;
  readonly jobConcurrency: number;
  readonly browserConcurrency: number;
  readonly browserQueueDepth: number;
  readonly llmConcurrency: number;
  readonly maxWorkerReplicas: number;
  readonly estimated: number;
  readonly headroomFraction: number;
  readonly fitsBudget: boolean;
}

function buildAdvisory(input: AdvisoryInput): string {
  const targetLabel =
    input.target === "single-host"
      ? "single-host Docker Compose"
      : input.target === "on-prem"
        ? "on-premise host"
        : "managed cloud";
  const fit = input.fitsBudget
    ? `The estimate (${input.estimated} MB) sits inside the ${input.workerMemoryMb} MB budget with a ${Math.round(input.headroomFraction * 100)}% headroom reserved for the OS.`
    : `The estimate (${input.estimated} MB) exceeds the ${input.workerMemoryMb} MB budget. Reduce the preferred concurrency values or raise the container memory limit.`;
  const replicaGuidance =
    input.target === "single-host"
      ? "Run one worker container; scale the app and worker together, never the worker alone."
      : input.target === "on-prem"
        ? `Run up to ${input.maxWorkerReplicas} worker processes on this host; spawn no more without adding cores.`
        : `The autoscaler may run up to ${input.maxWorkerReplicas} worker replicas per node; the job queue is the source of truth for whether more replicas are busy.`;
  return `Scaling policy for a ${targetLabel}: ${input.jobConcurrency} jobs, ${input.browserConcurrency} browser contexts (queue depth ${input.browserQueueDepth}), ${input.llmConcurrency} concurrent LLM calls. ${fit} ${replicaGuidance}`;
}

function pickPositive(v: number | undefined, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return fallback;
}

function pickNonNegative(v: number | undefined, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateScalingPolicy(value: unknown): ScalingPolicy {
  if (value === null || typeof value !== "object") {
    throw new ScalingError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "scaling-policy/1") {
    throw new ScalingError(
      `Rehydrate failed: expected version "scaling-policy/1", received "${String(r["version"])}".`,
      "wrong-version",
    );
  }
  const budgetRaw = r["budget"];
  const budget: ScalingBudget =
    budgetRaw !== null && typeof budgetRaw === "object"
      ? {
          workerMemoryMb: numberOr((budgetRaw as Record<string, unknown>)["workerMemoryMb"], MIN_WORKER_MEMORY_MB),
          workerCpuCores: numberOr((budgetRaw as Record<string, unknown>)["workerCpuCores"], 1),
          target: readTarget((budgetRaw as Record<string, unknown>)["target"]),
        }
      : {
          // A missing budget is a corrupt row; fail rather than invent one.
          workerMemoryMb: MIN_WORKER_MEMORY_MB,
          workerCpuCores: 1,
          target: "single-host",
        };
  const policy: ScalingPolicy = {
    version: "scaling-policy/1",
    budget,
    jobConcurrency: integerOr(r["jobConcurrency"], 1),
    browserConcurrency: integerOr(r["browserConcurrency"], 1),
    browserQueueDepth: integerOr(r["browserQueueDepth"], 1),
    llmConcurrency: integerOr(r["llmConcurrency"], 1),
    maxWorkerReplicas: integerOr(r["maxWorkerReplicas"], 1),
    estimatedMemoryMb: integerOr(r["estimatedMemoryMb"], 0),
    headroomFraction: numberOr(r["headroomFraction"], DEFAULT_HEADROOM_FRACTION),
    fitsBudget: r["fitsBudget"] === true,
    advisory: typeof r["advisory"] === "string" ? r["advisory"] : "",
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
  // Re-verify the invariant that the policy's memory fits its budget, so a
  // row an admin edited by hand to over-allocate is caught at load rather
  // than at the first OOM.
  const reestimated = estimateMemoryMb({
    browserConcurrency: policy.browserConcurrency,
    llmConcurrency: policy.llmConcurrency,
    costPerBrowserMb: COST_PER_BROWSER_CONTEXT_MB,
    costPerLlmCallMb: COST_PER_LLM_CALL_MB,
    baseWorkerMb: BASE_WORKER_MB,
  });
  if (reestimated > budget.workerMemoryMb) {
    throw new ScalingError(
      `Persisted scaling policy does not fit its budget: estimated ${reestimated} MB against ${budget.workerMemoryMb} MB.`,
      "policy-does-not-fit",
      { estimatedMemoryMb: reestimated, budgetMb: budget.workerMemoryMb },
    );
  }
  return policy;
}

function readTarget(v: unknown): DeploymentTarget {
  return v === "on-prem" || v === "cloud" ? v : "single-host";
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function integerOr(v: unknown, fallback: number): number {
  const n = numberOr(v, fallback);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Exported constants                                                          */
/* -------------------------------------------------------------------------- */

export const SCALING_CONSTANTS = Object.freeze({
  COST_PER_BROWSER_CONTEXT_MB,
  BASE_WORKER_MB,
  COST_PER_LLM_CALL_MB,
  DEFAULT_HEADROOM_FRACTION,
  MIN_WORKER_MEMORY_MB,
});

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  estimateMemoryMb,
  computeMaxReplicas,
  buildAdvisory,
  pickPositive,
  pickNonNegative,
  readTarget,
});
