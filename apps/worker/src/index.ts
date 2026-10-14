/**
 * Zipy AI — background worker entrypoint.
 *
 * Boot order:
 *   1. Validate the worker's required configuration. Missing DATABASE_URL is a
 *      hard failure (the queue cannot function without it). Missing LLM keys,
 *      storage roots and processing-service URLs are surfaced as warnings —
 *      the worker still boots, but a job that requires them fails with an
 *      explicit error rather than silently doing nothing.
 *   2. Register job handlers. Phase 2 registers no real handlers: the queue
 *      itself (enqueue/claim/complete/fail) is exercised by the API and by
 *      tests without a worker. The handler map below is intentionally empty
 *      so that Phase 3+ adds real handlers without touching this file's
 *      lifecycle; a helper `registerHandler` import is left in place with a
 *      comment showing the intended shape. This avoids the "no handler
 *      registered" failure mode where a job kind ships but no worker claims it.
 *   3. Install graceful shutdown, then start the runner loop.
 *
 * Design notes:
 *  - Configuration is read from the environment directly (the worker is a
 *    standalone process; the web app's `@/lib/config` is not importable from
 *    a sibling workspace). The validation surface mirrors the fields the
 *    worker actually consumes: DATABASE_URL, JOBS_*, storage root, and a
 *    summary count of configured LLM providers.
 *  - The worker binds to no port. Replit runs it as a second process (a
 *    "worker" that shares the repo). Readiness is observable through the
 *    log line emitted once the runner loop has claimed its first poll.
 *  - `stopRunner` + `closeQueue` from `@zipy/jobs` are used for graceful
 *    drain. The `installShutdownHooks` helper in the runner module does this
 *    too; we call it directly and additionally wait for a clean exit here.
 *  - Behaviour on missing handlers is intentionally conservative. If
 *    `WORKER_KINDS` is set (comma-separated), the worker claims only those
 *    kinds and fails to start if it has no handler for any of them. If it is
 *    unset, the worker claims only the kinds for which a handler exists (so a
 *    bootstrap deployment with no handlers starts idle and logs a clear
 *    "no handlers registered" note instead of crashing).
 */

import {
  JOB_KINDS,
  closeQueue,
  installShutdownHooks,
  isJobKind,
  registerHandler,
  registeredKinds,
  startRunner,
  stopRunner,
  type JobHandler,
  type JobKind,
} from "@zipy/jobs";

/* -------------------------------------------------------------------------- */
/* Configuration check                                                         */
/* -------------------------------------------------------------------------- */

interface WorkerConfig {
  readonly databaseUrl: string | null;
  readonly databaseConfigured: boolean;
  readonly storageRoot: string | null;
  readonly storageConfigured: boolean;
  readonly redisUrl: string | null;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly lockTtlMs: number;
  readonly maxAttempts: number;
  readonly requestedKinds: readonly JobKind[] | null;
  readonly llmProviderCount: number;
  readonly llmProvidersConfigured: readonly string[];
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const norm = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(norm)) return true;
  if (["0", "false", "no", "off"].includes(norm)) return false;
  return fallback;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function readWorkerConfig(): WorkerConfig {
  const databaseUrl =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? null;
  const storageDriver = (process.env.STORAGE_DRIVER ?? "local").toLowerCase();
  const storageRoot =
    process.env.STORAGE_LOCAL_ROOT ??
    process.env.OBJECT_STORE_LOCAL_ROOT ??
    null;
  // s3 storage is considered configured for the worker if either a local root
  // is set (dev) or the S3 trio is complete.
  const s3Configured =
    (process.env.S3_BUCKET ?? process.env.AWS_S3_BUCKET) !== undefined &&
    (process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID) !== undefined &&
    (process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY) !== undefined;

  const requestedKindsRaw = process.env.WORKER_KINDS ?? "";
  const requestedKinds: JobKind[] = [];
  if (requestedKindsRaw.trim().length > 0) {
    for (const piece of requestedKindsRaw.split(",")) {
      const trimmed = piece.trim();
      if (trimmed.length === 0) continue;
      if (!isJobKind(trimmed)) {
        process.stderr.write(
          `[worker] WORKER_KINDS contains unknown kind "${trimmed}". Known kinds: ${JOB_KINDS.join(
            ", ",
          )}\n`,
        );
        continue;
      }
      if (!requestedKinds.includes(trimmed)) requestedKinds.push(trimmed);
    }
  }

  const llmProvidersConfigured: string[] = [];
  if (process.env.OPENAI_API_KEY) llmProvidersConfigured.push("openai");
  if (process.env.ANTHROPIC_API_KEY) llmProvidersConfigured.push("anthropic");
  if (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY) {
    llmProvidersConfigured.push("gemini");
  }
  if (process.env.OLLAMA_BASE_URL) llmProvidersConfigured.push("ollama");
  if (process.env.VLLM_BASE_URL) llmProvidersConfigured.push("vllm");

  return {
    databaseUrl,
    databaseConfigured: databaseUrl !== null && databaseUrl.trim().length > 0,
    storageRoot,
    storageConfigured:
      storageDriver === "s3" ? s3Configured : storageRoot !== null,
    redisUrl: process.env.REDIS_URL ?? null,
    concurrency: readIntEnv("JOBS_CONCURRENCY", 4),
    pollIntervalMs: readIntEnv("JOBS_POLL_INTERVAL_MS", 1_000),
    lockTtlMs: readIntEnv("JOBS_LOCK_TTL_MS", 5 * 60_000),
    maxAttempts: readIntEnv("JOBS_MAX_ATTEMPTS", 3),
    requestedKinds: requestedKinds.length > 0 ? requestedKinds : null,
    llmProviderCount: llmProvidersConfigured.length,
    llmProvidersConfigured,
  };
}

function logWorkerConfig(config: WorkerConfig): void {
  process.stdout.write(
    `[worker] config: database=${config.databaseConfigured ? "set" : "MISSING"} ` +
      `storage=${config.storageConfigured ? "set" : "MISSING"} ` +
      `redis=${config.redisUrl ? "set" : "absent"} ` +
      `concurrency=${config.concurrency} pollIntervalMs=${config.pollIntervalMs} ` +
      `lockTtlMs=${config.lockTtlMs} maxAttempts=${config.maxAttempts} ` +
      `requestedKinds=${config.requestedKinds ? config.requestedKinds.join(",") : "<all-registered>"} ` +
      `llmProviders=[${config.llmProvidersConfigured.join(",") || "none"}]\n`,
  );
}

/** Startup validation. Throws on hard failures; prints warnings otherwise. */
function validateWorkerStartup(config: WorkerConfig): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.databaseConfigured) {
    errors.push(
      "DATABASE_URL is not set. The worker cannot claim jobs without a database connection.",
    );
  }
  if (!config.storageConfigured) {
    warnings.push(
      "No storage backend is configured (STORAGE_LOCAL_ROOT or the S3_* trio). " +
        "Jobs that persist artifacts will fail until storage is configured.",
    );
  }
  if (config.llmProviderCount === 0) {
    warnings.push(
      "No LLM provider is configured (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / OLLAMA_BASE_URL / VLLM_BASE_URL). " +
        "Jobs that call the LLM will fail with an explicit error until one is supplied.",
    );
  }
  if (process.env.NODE_ENV === "production" && !process.env.REPL_ID) {
    // Not a hard error; just note that no platform identity was detected.
    warnings.push(
      "NODE_ENV=production but REPL_ID is not set. If this deployment is not Replit, ignore this.",
    );
  }

  for (const w of warnings) process.stderr.write(`[worker] warning: ${w}\n`);

  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`[worker] error: ${e}\n`);
    throw new Error(
      `Zipy AI worker cannot start: ${errors.length} configuration error(s). See stderr for details.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Handler registration                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Phase 2 registers no real handlers. Ingestion/automation/generation handlers
 * land in later phases and call `registerHandler` from their own modules,
 * which the worker then imports here.
 *
 * The map below is the seam. If a module produces a handler registry, wire it
 * in here; the worker's boot path does not otherwise change.
 */
function registerPhaseHandlers(): void {
  // Intentionally empty in Phase 2. Called on every boot so tests can observe
  // that the hook ran without needing a live database.
  const handlers: ReadonlyArray<{ kind: JobKind; handler: JobHandler }> = [];
  for (const entry of handlers) {
    registerHandler({ kind: entry.kind, handler: entry.handler });
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

export interface WorkerBootstrapResult {
  readonly config: WorkerConfig;
  readonly registeredKinds: readonly JobKind[];
  readonly claimedKinds: readonly JobKind[];
}

/**
 * Boot the worker: validate config, register handlers, start the runner.
 * Exported so `apps/worker/src/index.ts` can be the thin CLI wrapper and tests
 * can drive the lifecycle directly.
 *
 * Returns after the runner loop has been started ITSELF asynchronously (the
 * `startRunner` promise resolves only on shutdown). The caller is expected to
 * keep the process alive via the runner's own timers.
 */
export async function bootstrapWorker(): Promise<WorkerBootstrapResult> {
  const config = readWorkerConfig();
  logWorkerConfig(config);
  validateWorkerStartup(config);

  registerPhaseHandlers();
  const kinds = registeredKinds();

  // Determine which kinds we will claim.
  const claimedFromConfig =
    config.requestedKinds === null
      ? kinds
      : config.requestedKinds.filter((k) => kinds.includes(k));

  if (config.requestedKinds !== null) {
    const missing = config.requestedKinds.filter((k) => !kinds.includes(k));
    if (missing.length > 0) {
      throw new Error(
        `WORKER_KINDS requests kinds with no registered handler: [${missing.join(
          ", ",
        )}]. Either drop them from WORKER_KINDS or add handlers before this worker starts.`,
      );
    }
  }

  if (claimedFromConfig.length === 0) {
    // No handlers at all in this deployment. This is expected in Phase 2.
    // We do not start the runner (startRunner would throw), we log clearly and
    // return so the process stays alive for health checks. Later phases add
    // handlers and the runner starts normally.
    process.stdout.write(
      `[worker] no job handlers are registered. Worker is idle. ` +
        `All ${JOB_KINDS.length} known kinds remain unclaimed by this process. ` +
        `Register handlers in apps/worker/src/index.ts (registerPhaseHandlers) once the modules land.\n`,
    );
    return { config, registeredKinds: kinds, claimedKinds: [] };
  }

  process.stdout.write(
    `[worker] starting runner for kinds: [${claimedFromConfig.join(",")}]\n`,
  );

  // startRunner resolves when the loop exits (on stopRunner / SIGTERM). We do
  // not await it in the returned promise — the caller keeps the process alive
  // — but we attach a rejection handler so an unexpected crash is visible.
  const runnerPromise = startRunner({
    kinds: claimedFromConfig,
    requireAllKinds: true,
    onOutcome: (event) => {
      const tag =
        event.status === "succeeded"
          ? "ok"
          : event.status === "retried"
            ? "retry"
            : "fail";
      process.stdout.write(
        `[worker] job ${tag} id=${event.jobId} kind=${event.kind} ` +
          `durationMs=${event.durationMs}` +
          (event.error ? ` error=${JSON.stringify(event.error)}` : "") +
          "\n",
      );
    },
  }).catch((error) => {
    process.stderr.write(
      `[worker] runner crashed: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });

  // Let the runner complete its first poll before returning so a caller can
  // observe `running: true`.
  await sleepMs(50);

  return { config, registeredKinds: kinds, claimedKinds: claimedFromConfig };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/* -------------------------------------------------------------------------- */
/* Shutdown + CLI                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Install handlers that stop the runner and close the queue on SIGINT/SIGTERM.
 * The runner module exposes `installShutdownHooks` which does the same; using
 * it keeps the shutdown contract in one place. We call it here rather than at
 * module scope so a test importing this file does not install process signal
 * handlers.
 */
export function installWorkerShutdown(): void {
  installShutdownHooks();
  // Also stop the runner if the process is asked to reload (Replit sends
  // SIGTERM on restart). `installShutdownHooks` already wires SIGTERM; the
  // extra handler below is only a safety net for uncaught exceptions.
  process.once("uncaughtException", (err) => {
    process.stderr.write(
      `[worker] uncaughtException: ${err.stack ?? err.message}\n`,
    );
    void stopRunner({ timeoutMs: 15_000 }).finally(() => {
      process.exitCode = 1;
    });
  });
  process.once("unhandledRejection", (reason) => {
    process.stderr.write(
      `[worker] unhandledRejection: ${
        reason instanceof Error ? reason.stack ?? reason.message : String(reason)
      }\n`,
    );
    // Do not exit on unhandled rejection: the queue is durable and the runner
    // loop should keep making progress. But we do surface it loudly.
  });
}

/**
 * Process entrypoint. Invoked when this file runs as `node apps/worker/src/index.ts`.
 * Kept separate from `bootstrapWorker` so tests import without booting.
 */
export async function main(): Promise<void> {
  installWorkerShutdown();
  try {
    await bootstrapWorker();
  } catch (error) {
    process.stderr.write(
      `[worker] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    // Best-effort cleanup so an early boot failure does not leak a pool.
    await closeQueue().catch(() => undefined);
    process.exitCode = 1;
  }
}

// Detect direct invocation: `node --experimental-strip-types src/index.ts`.
// `import.meta.url` ends with this file when executed directly.
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  if (entry.length === 0) return false;
  try {
    const here = new URL(import.meta.url);
    return here.pathname.endsWith(entry) || here.pathname.endsWith("index.ts");
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main();
}
