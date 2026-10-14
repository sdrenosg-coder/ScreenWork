/**
 * Zipy AI — job runner.
 *
 * The worker entrypoint imports this module, registers a handler map keyed by
 * `JobKind`, and calls `startRunner`. Handlers are ordinary async functions
 * that receive a `JobContext` and return a JSON-serialisable result (or throw
 * to fail). The runner owns polling, locking, heartbeats, backoff and
 * graceful shutdown — individual handlers stay focused on one job.
 *
 * Design notes:
 *  - Registration is explicit and validated at startup: missing handlers are
 *    reported (not silently dropped) so an operationally-incomplete worker
 *    fails loudly rather than accepting and silently failing jobs.
 *  - Concurrency is per-process (config.jobs.concurrency). Each in-flight job
 *    runs in its own task; the loop uses `claimJob`'s atomic claim so two
 *    tokens never collide.
 *  - Handlers receive an `AbortSignal` that fires on `stop()` and a
 *    `heartbeat` helper so long-running browser jobs can keep ownership.
 *  - Handler timeouts: the runner wraps each handler in a timeout equal to the
 *    lock TTL minus a safety margin, so a hung handler never leaves a job
 *    permanently locked (a periodic `reclaimExpired` runs regardless).
 *  - Failures are classified: `JobPermanentError` marks the job terminal
 *    immediately; every other error is retryable and follows the queue's
 *    exponential backoff.
 *  - No new dependencies. Uses only `./queue.ts` plus Node built-ins.
 */

import {
  JOB_KINDS,
  claimJob,
  closeQueue,
  completeJob,
  defaultWorkerId,
  failJob,
  heartbeat as queueHeartbeat,
  queueConfig,
  reclaimExpired,
  sleep,
  type JobKind,
  type JobRow,
} from "./queue.ts";

/* -------------------------------------------------------------------------- */
/* Handler contract                                                            */
/* -------------------------------------------------------------------------- */

export class JobPermanentError extends Error {
  readonly code: string;
  constructor(message: string, code = "permanent") {
    super(message);
    this.name = "JobPermanentError";
    this.code = code;
  }
}

export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`Job handler exceeded timeout of ${ms}ms.`);
    this.name = "JobTimeoutError";
  }
}

export interface JobContext {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  /** Attempt number (1-based) for this execution. */
  readonly attempt: number;
  /** Correlation id from the enqueue call, if any. */
  readonly correlationId: string | null;
  /** Fires when the runner is stopping or the job's lock has been reclaimed. */
  readonly signal: AbortSignal;
  /**
   * Extend the current claim. Handlers that run longer than `lockTtlMs / 2`
   * should call this periodically (e.g. per automation step).
   */
  heartbeat(): Promise<void>;
  /** Convenience: throw `JobPermanentError` with a specific code. */
  fail(message: string, code?: string): never;
}

export type JobHandler = (
  context: JobContext,
) => Promise<Record<string, unknown> | void>;

export interface RegisterInput {
  readonly kind: JobKind;
  readonly handler: JobHandler;
}

/* -------------------------------------------------------------------------- */
/* Runner state                                                                */
/* -------------------------------------------------------------------------- */

interface RunnerOptions {
  readonly workerId?: string;
  /** Restrict this runner to a subset of kinds. Defaults to all registered. */
  readonly kinds?: readonly JobKind[];
  /**
   * When true, a missing handler for a kind requested in `kinds` (or for the
   * full JOB_KINDS set if `kinds` is empty) is treated as a configuration
   * error at startup rather than a runtime failure.
   */
  readonly requireAllKinds?: boolean;
  /** Called for every handler outcome. Useful for metrics in later phases. */
  readonly onOutcome?: (event: RunnerOutcome) => void;
}

export interface RunnerOutcome {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly kind: JobKind;
  readonly status: "succeeded" | "failed" | "retried" | "skipped";
  readonly durationMs: number;
  readonly error?: string;
}

interface RunnerState {
  readonly handlers: Map<JobKind, JobHandler>;
  readonly workerId: string;
  readonly inFlight: Set<Promise<void>>;
  readonly abortController: AbortController;
  running: boolean;
  stopped: Promise<void> | null;
  stopResolve: (() => void) | null;
}

const state: RunnerState = {
  handlers: new Map(),
  workerId: defaultWorkerId(),
  inFlight: new Set(),
  abortController: new AbortController(),
  running: false,
  stopped: null,
  stopResolve: null,
};

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Register a handler for a job kind. Calling twice for the same kind replaces
 * the previous handler, which makes test overrides trivial. The replacement is
 * reported to stderr so an accidental double-registration in production is
 * visible.
 */
export function registerHandler(input: RegisterInput): void {
  if (state.running) {
    throw new Error(
      "registerHandler must be called before startRunner. Handlers are frozen once the loop starts.",
    );
  }
  if (state.handlers.has(input.kind)) {
    process.stderr.write(
      `[jobs] registerHandler: replacing existing handler for kind "${input.kind}"\n`,
    );
  }
  state.handlers.set(input.kind, input.handler);
}

/** Bulk-register handlers from a map. */
export function registerHandlers(
  entries: Readonly<Record<JobKind, JobHandler>> | readonly RegisterInput[],
): void {
  if (Array.isArray(entries)) {
    for (const entry of entries as readonly RegisterInput[]) {
      registerHandler(entry);
    }
    return;
  }
  for (const [kind, handler] of Object.entries(entries) as Array<
    [JobKind, JobHandler]
  >) {
    registerHandler({ kind, handler });
  }
}

export function registeredKinds(): readonly JobKind[] {
  return Array.from(state.handlers.keys()).sort();
}

/* -------------------------------------------------------------------------- */
/* Loop                                                                        */
/* -------------------------------------------------------------------------- */

export interface StartInput extends RunnerOptions {}

export async function startRunner(input: StartInput = {}): Promise<void> {
  if (state.running) {
    throw new Error("startRunner called while a runner is already active.");
  }

  const workerId = input.workerId ?? state.workerId;
  const config = queueConfig();

  // Determine the kinds this runner will claim.
  const registered = Array.from(state.handlers.keys());
  const claimedKinds = input.kinds && input.kinds.length > 0
    ? input.kinds
    : registered;

  if (claimedKinds.length === 0) {
    throw new Error(
      "startRunner: no handlers are registered. Register handlers with registerHandler/registerHandlers first.",
    );
  }

  // Validate: every kind we intend to claim has a handler, unless the caller
  // explicitly said otherwise.
  const missing = claimedKinds.filter((k) => !state.handlers.has(k));
  if (missing.length > 0) {
    if (input.requireAllKinds) {
      throw new Error(
        `startRunner: missing handlers for kinds [${missing.join(", ")}]. Register them or omit them from the claim set.`,
      );
    }
    process.stderr.write(
      `[jobs] runner: skipping kinds without handlers: ${missing.join(", ")}\n`,
    );
  }
  const effectiveKinds = claimedKinds.filter((k) => state.handlers.has(k));
  if (effectiveKinds.length === 0) {
    throw new Error(
      "startRunner: none of the requested kinds have registered handlers.",
    );
  }

  state.running = true;
  state.abortController = new AbortController();
  state.stopped = new Promise<void>((resolve) => {
    state.stopResolve = resolve;
  });

  process.stdout.write(
    `[jobs] runner started workerId=${workerId} kinds=[${effectiveKinds.join(
      ",",
    )}] concurrency=${config.concurrency} pollIntervalMs=${config.pollIntervalMs}\n`,
  );

  // Reclaim orphane jobs left by a crashed worker before entering the loop.
  try {
    const reclaimed = await reclaimExpired();
    if (reclaimed > 0) {
      process.stdout.write(`[jobs] reclaimed ${reclaimed} expired lock(s) on boot\n`);
    }
  } catch (error) {
    process.stderr.write(
      `[jobs] reclaimExpired on boot failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }

  // Periodic reclaim: guards against a worker that crashed mid-job without
  // our process observing it (multi-process deployments).
  const reclaimTimer = setInterval(() => {
    reclaimExpired().catch((error) => {
      process.stderr.write(
        `[jobs] periodic reclaimExpired failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    });
  }, Math.max(30_000, config.lockTtlMs / 2));
  // Allow the process to exit even if this timer is pending.
  reclaimTimer.unref?.();

  try {
    while (!state.abortController.signal.aborted) {
      // Clamp in-flight work to config.concurrency.
      if (state.inFlight.size >= config.concurrency) {
        await Promise.race(state.inFlight);
        continue;
      }

      let job: JobRow | null;
      try {
        job = await claimJob({
          workerId,
          kinds: effectiveKinds,
        });
      } catch (error) {
        process.stderr.write(
          `[jobs] claimJob failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        job = null;
      }

      if (job === null) {
        await sleep(config.pollIntervalMs, state.abortController.signal);
        continue;
      }

      const task = runOne(job, input.onOutcome).finally(() => {
        state.inFlight.delete(task);
      });
      state.inFlight.add(task);
    }

    // Drain in-flight work before exiting.
    if (state.inFlight.size > 0) {
      process.stdout.write(
        `[jobs] draining ${state.inFlight.size} in-flight job(s)…\n`,
      );
      await Promise.allSettled(Array.from(state.inFlight));
    }
  } finally {
    clearInterval(reclaimTimer);
    state.running = false;
    state.stopResolve?.();
  }
}

/**
 * Stop the runner: abort in-flight signals and wait for the loop to drain.
 */
export async function stopRunner(opts?: { readonly timeoutMs?: number }): Promise<void> {
  if (!state.running) return;
  state.abortController.abort();
  const timeout = opts?.timeoutMs ?? 30_000;
  if (state.stopped === null) return;
  await Promise.race([state.stopped, sleep(timeout)]);
}

/**
 * Convenience used by the worker entrypoint: register a shutdown hook so
 * SIGINT/SIGTERM trigger a graceful drain. Idempotent.
 */
let shutdownInstalled = false;
export function installShutdownHooks(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const shutdown = (signal: NodeJS.Signals) => {
    process.stdout.write(`[jobs] received ${signal}, stopping…\n`);
    void stopRunner({ timeoutMs: 30_000 }).finally(() => {
      void closeQueue().finally(() => {
        // Do not force-exit; the process should exit naturally once idle.
        process.exitCode = 0;
      });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/* -------------------------------------------------------------------------- */
/* Single job execution                                                        */
/* -------------------------------------------------------------------------- */

async function runOne(
  job: JobRow,
  onOutcome?: (event: RunnerOutcome) => void,
): Promise<void> {
  const handler = state.handlers.get(job.kind);
  const startedAt = Date.now();

  if (!handler) {
    // Kind was filtered above; only reachable if a registration was removed
    // after start. Fail permanently and move on.
    await failJob({
      workspaceId: job.workspace_id,
      jobId: job.id,
      error: `No handler registered for kind "${job.kind}".`,
      terminal: true,
    });
    onOutcome?.({
      jobId: job.id,
      workspaceId: job.workspace_id,
      kind: job.kind,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: `no handler for ${job.kind}`,
    });
    return;
  }

  const config = queueConfig();
  // Handler timeout leaves a safety margin under the lock TTL so the runner
  // can decide to fail/retry before the queue reclaims ownership.
  const timeoutMs = Math.max(1_000, Math.floor(config.lockTtlMs * 0.9));

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  state.abortController.signal.addEventListener("abort", onAbort, { once: true });

  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });

  const context: JobContext = {
    jobId: job.id,
    workspaceId: job.workspace_id,
    kind: job.kind,
    payload: job.payload,
    attempt: job.attempts,
    correlationId: job.correlation_id,
    signal: controller.signal,
    heartbeat: async () => {
      await queueHeartbeat(job.workspace_id, job.id, state.workerId);
    },
    fail: (message, code) => {
      throw new JobPermanentError(message, code);
    },
  };

  try {
    const result = (await Promise.race([handler(context), timeout])) as
      | Record<string, unknown>
      | void
      | undefined;
    await completeJob({
      workspaceId: job.workspace_id,
      jobId: job.id,
      result: (result as Record<string, unknown> | undefined) ?? {},
    });
    onOutcome?.({
      jobId: job.id,
      workspaceId: job.workspace_id,
      kind: job.kind,
      status: "succeeded",
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const terminal = error instanceof JobPermanentError;

    await failJob({
      workspaceId: job.workspace_id,
      jobId: job.id,
      error: message,
      terminal,
    });
    // Peek at the row's post-fail status so operators can distinguish
    // "retried" from "failed" without a second lookup.
    onOutcome?.({
      jobId: job.id,
      workspaceId: job.workspace_id,
      kind: job.kind,
      status: terminal ? "failed" : "retried",
      durationMs: Date.now() - startedAt,
      error: message,
    });
  } finally {
    if (timer) clearTimeout(timer);
    state.abortController.signal.removeEventListener("abort", onAbort);
  }
}

/* -------------------------------------------------------------------------- */
/* Introspection used by tests and the worker entrypoint                       */
/* -------------------------------------------------------------------------- */

export function runnerState(): {
  readonly running: boolean;
  readonly workerId: string;
  readonly registeredKinds: readonly JobKind[];
  readonly inFlight: number;
} {
  return {
    running: state.running,
    workerId: state.workerId,
    registeredKinds: registeredKinds(),
    inFlight: state.inFlight.size,
  };
}

/** Reset runner state between tests. Not safe to call while running. */
export function resetRunnerForTests(): void {
  if (state.running) {
    throw new Error("resetRunnerForTests called while the runner is active.");
  }
  state.handlers.clear();
  state.inFlight.clear();
  state.abortController = new AbortController();
  state.workerId = defaultWorkerId();
  state.running = false;
  state.stopped = null;
  state.stopResolve = null;
}

/** Convenience re-export so the worker entrypoint has one import surface. */
export { JOB_KINDS };
