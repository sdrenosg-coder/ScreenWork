/**
 * Zipy AI — workflow execution entrypoint (worker).
 *
 * This module executes a synthesized workflow plan against a live headless
 * browser. It is the integration point between the synthesis phase (which
 * produces an ordered list of actions with element references) and the
 * browser-automation + capture + resilience modules that have been built in
 * earlier batches of this phase:
 *
 *   - packages/automation/src/browser.ts   — session lifecycle
 *   - packages/automation/src/cdp.ts       — CDP access for full-page capture
 *   - packages/automation/src/login.ts     — login detection + fill
 *   - packages/automation/src/vault.ts     — credential lookup
 *   - packages/automation/src/waits.ts     — bounded wait primitives
 *   - packages/automation/src/capture.ts   — before/after + element captures
 *   - packages/automation/src/retry.ts     — retry policy + self-healing
 *   - packages/automation/src/selectors.ts — self-healing selector resolution
 *   - packages/automation/src/changeDetect.ts — UI-change detection
 *
 * Scope of this batch:
 *   - Consume a workflow plan (steps with action + target + value).
 *   - Launch a headless session and apply optional login preconditions.
 *   - For each step, in order:
 *       1. Wait for readiness using the configured strategy.
 *       2. For write/destructive/state-changing actions, capture "before".
 *       3. Resolve the target via the self-healing selector resolver, then
 *          perform the action (click / type / select / scroll / navigate).
 *       4. Capture "after" for state-changing actions.
 *       5. Record per-step outcome with a stable, PII-safe structured shape.
 *   - Classify action risk so the review phase can gate execution.
 *   - Return a `WorkflowRunResult`; never throws for a step-level failure
 *     (a step that could not be completed is recorded and the run continues
 *     unless the caller opts into strict mode).
 *
 * Explicitly NOT in this batch (queued for later):
 *   - Review-mode checkpoint gating and live-handoff (review phase).
 *   - PII detection / blurring over the captured screenshots (screenshot
 *     processing phase).
 *   - Annotation placement / step copy (annotation phase).
 *   - Persisting captures to object storage (worker job wiring phase).
 *   - LLM-based re-synthesis when change detection flags "changed" — the
 *     current signal is returned in the result for the caller to act on.
 *
 * The plan type is declared locally rather than imported from @zipy/synth
 * because this worker entrypoint must remain loadable even when a plan was
 * produced by a different synthesizer (e.g. a distilled Playwright script
 * rehydrated back into a plan). Only the fields this module consumes are
 * declared; extra fields on the input are ignored.
 */

import {
  launchBrowserSession,
  closeSession,
  type BrowserSession,
  type PlaywrightPage,
} from "@zipy/automation/browser";
import { getConfig } from "@/lib/config";
import {
  captureViewport,
  captureElement,
  withBeforeAfter,
  type CaptureResult,
} from "@zipy/automation/capture";
import {
  detectChanges,
  captureSnapshot,
  requiresResynthesis,
  shouldFlagForReview,
  type PageSnapshot,
  type ChangeReport,
} from "@zipy/automation/changeDetect";
import {
  ensureLoggedIn,
  type FillablePage,
  type LoginOutcome,
} from "@zipy/automation/login";
import { tryGetCredential } from "@zipy/automation/vault";
import {
  resolveSelector,
  toSelectorTarget,
  impliesResynthesis,
  type StepTargetFragment,
  type ResolutionResult,
} from "@zipy/automation/selectors";
import type { WaitablePage } from "@zipy/automation/waits";
import {
  waitForPageReady,
  waitForSelector,
  waitForLoadState,
} from "@zipy/automation/waits";

/* -------------------------------------------------------------------------- */
/* Plan shape (local declaration)                                              */
/* -------------------------------------------------------------------------- */

export type WorkflowActionKind =
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "wait"
  | "press";

/**
 * Risk classification, aligned with the review phase's taxonomy in the
 * overall plan. The value is descriptive — a downstream gate decides policy.
 */
export type WorkflowActionRisk =
  | "read-only"
  | "write"
  | "destructive"
  | "financial"
  | "external-communication";

export interface WorkflowStep {
  /** 1-based step index, matching the plan order. */
  readonly step: number;
  readonly action: WorkflowActionKind;
  /** Target element, when the action requires one. */
  readonly target: StepTargetFragment | null;
  /** Value to type or select. Null for actions without a value. */
  readonly value: string | null;
  /** URL to navigate to (navigate action only). */
  readonly url: string | null;
  /** Coarse risk hint from the synthesizer. Optional; the runner refines it. */
  readonly riskHint?: WorkflowActionRisk | null;
  /**
   * Human-readable description of the step, produced by the synthesizer.
   * Carried through to the result so downstream annotations can reference it.
   */
  readonly description?: string | null;
  /**
   * When true, the step is a state-changing action whose before/after pair
   * should be captured. When undefined, the runner infers it from the action
   * (click / type / select on a non-trivial target).
   */
  readonly captureBeforeAfter?: boolean | null;
  /** Optional single-line condition for a conditional workflow edge. */
  readonly condition?: string | null;
}

export interface WorkflowPlan {
  /** Stable id for this plan; used for logging and re-run bookkeeping. */
  readonly id: string;
  /** The URL the workflow should start from. */
  readonly startUrl: string;
  /**
   * Optional login precondition. When present, the runner performs login
   * before executing step 1. `credentialScope` names the vault entry; when
   * the vault has nothing for that scope, the run fails with a
   * `credential-missing` outcome and does not proceed.
   */
  readonly login: WorkflowLogin | null;
  /** Ordered steps. */
  readonly steps: readonly WorkflowStep[];
  /**
   * Whether to pass `--insecure` when the target uses a self-signed cert.
   * Defaults to false (secure).
   */
  readonly ignoreHTTPSErrors?: boolean;
}

export interface WorkflowLogin {
  readonly credentialScope: string;
  /** When true, credentials are looked up via the vault before launching. */
  readonly required: boolean;
}

/* -------------------------------------------------------------------------- */
/* Result shape                                                                */
/* -------------------------------------------------------------------------- */

export type StepOutcomeStatus =
  | "completed"
  | "failed-selector"
  | "failed-timeout"
  | "failed-action"
  | "skipped-condition"
  | "unsupported-action";

export interface StepOutcome {
  readonly step: number;
  readonly action: WorkflowActionKind;
  readonly status: StepOutcomeStatus;
  readonly risk: WorkflowActionRisk;
  /** Milliseconds spent on this step (from wait-start to after-capture end). */
  readonly elapsedMs: number;
  /** Selector strategy that ultimately resolved the target, when applicable. */
  readonly resolvedStrategy: string | null;
  /** True when the plan's primary selector was replaced by a fallback. */
  readonly drifted: boolean;
  /** Before/after captures, when the step captured them. Null otherwise. */
  readonly before: CaptureResult | null;
  readonly after: CaptureResult | null;
  /** Element-crop capture of the target, when the step scoped to an element. */
  readonly crop: CaptureResult | null;
  /** Reason for a non-"completed" status, for the reviewer. */
  readonly detail: string | null;
}

export type WorkflowRunStatus =
  | "completed"
  | "completed-with-failures"
  | "aborted-login-failed"
  | "aborted-credential-missing"
  | "aborted-launch-failed"
  | "aborted-page-closed"
  | "aborted-before-start";

export interface WorkflowRunResult {
  readonly planId: string;
  readonly status: WorkflowRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly login: LoginOutcome | null;
  readonly steps: readonly StepOutcome[];
  /** URL where the run finished (query string stripped unless opted in). */
  readonly finalUrl: string;
  /** Change-detection report when the caller supplied a prior snapshot. */
  readonly changeReport: ChangeReport | null;
  /** True when change-detection recommends re-synthesis before next run. */
  readonly resynthesisRequired: boolean;
  /** True when the run should be flagged for human review before publishing. */
  readonly reviewRecommended: boolean;
  /** Top-level failure detail when the run aborted before completing all steps. */
  readonly abortDetail: string | null;
}

export interface RunWorkflowOptions {
  /**
   * When true, the run stops at the first non-"completed" step. When false
   * (the default), the runner records the failure and continues — the
   * reviewer sees the failing steps in the result and can fix them.
   */
  readonly stopOnFirstFailure?: boolean;
  /**
   * A previously captured page snapshot. When supplied, the runner performs
   * change detection BEFORE executing the plan: if the report says re-synthesis
   * is required, the run aborts with `aborted-before-start` and the report is
   * returned. When the report says the plan has drifted but is still usable,
   * the run proceeds and `reviewRecommended` is set.
   */
  readonly previousSnapshot?: PageSnapshot | null;
  /**
   * Emit a `console.error` line per step (never includes values or URLs with
   * query strings). Defaults to false.
   */
  readonly trace?: boolean;
  /** Passed through to per-step probes; default 15s. */
  readonly stepTimeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Risk classification                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Refine the risk for a step. When the synthesizer already classified the
 * step, that value is honoured — the runner only infers risk for the cases
 * the synthesizer did not specify (e.g. a distilled script re-run). The
 * classifier is intentionally conservative: a `click` on a button whose
 * accessible name mentions "delete", "remove", "cancel subscription",
 * "pay", "send" and similar markers is classified accordingly so the
 * review phase can gate it.
 */
export function classifyRisk(step: WorkflowStep): WorkflowActionRisk {
  if (step.riskHint !== undefined && step.riskHint !== null) return step.riskHint;

  if (step.action === "navigate" || step.action === "scroll" || step.action === "wait") {
    return "read-only";
  }
  if (step.action === "select" || step.action === "press") return "read-only";

  const descriptor = [step.target?.name, step.target?.text, step.description]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase();

  if (descriptor.length === 0) return "write";

  const destructive = [
    "delete",
    "remove",
    "destroy",
    "cancel",
    "reset",
    "revoke",
    "deactivate",
    "archive",
    "wipe",
    "clear all",
  ];
  const financial = [
    "pay",
    "checkout",
    "purchase",
    "buy",
    "charge",
    "billing",
    "subscription",
    "invoice",
    "refund",
  ];
  const external = [
    "send",
    "post",
    "publish",
    "invite",
    "share",
    "email",
    "tweet",
    "forward",
    "reply",
  ];

  for (const k of financial) if (descriptor.includes(k)) return "financial";
  for (const k of destructive) if (descriptor.includes(k)) return "destructive";
  for (const k of external) if (descriptor.includes(k)) return "external-communication";
  return "write";
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Execute a plan against a live headless session. The function's contract is
 * deliberately rigid:
 *   - It never throws for a step-level failure.
 *   - It throws only for a programmer error in the plan (e.g. a step with an
 *     action this module does not recognise is *reported*, not thrown —
 *     the `unsupported-action` status covers that case).
 *   - The session it opens is always closed before the function returns,
 *     including on an early abort.
 */
export async function runWorkflow(
  plan: WorkflowPlan,
  options: RunWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  // Validate the plan before touching a browser so a broken plan does not
  // leave a session behind.
  const validation = validatePlan(plan);
  if (validation !== null) {
    return abortedResult({
      plan,
      startedAt,
      startedMs,
      status: "aborted-before-start",
      detail: validation,
    });
  }

  // When login is required, look up the credential *before* launching so a
  // missing vault entry fails fast without spinning up a browser.
  if (plan.login !== null && plan.login.required) {
    const credential = await tryGetCredential(plan.login.credentialScope);
    if (credential === null) {
      return abortedResult({
        plan,
        startedAt,
        startedMs,
        status: "aborted-credential-missing",
        detail:
          `No credential is configured for scope "${plan.login.credentialScope}". ` +
          `The workflow cannot log in and will not run headlessly without it.`,
      });
    }
  }

  const config = getConfig();
  let session: BrowserSession | null = null;
  try {
    session = await launchBrowserSession({
      headless: config.browser.headless,
      ignoreHTTPSErrors: plan.ignoreHTTPSErrors ?? false,
    });
  } catch (error) {
    return abortedResult({
      plan,
      startedAt,
      startedMs,
      status: "aborted-launch-failed",
      detail: `Failed to launch the browser session: ${describeError(error)}`,
    });
  }

  const steps: StepOutcome[] = [];
  let login: LoginOutcome | null = null;
  let changeReport: ChangeReport | null = null;
  let resynthesisRequired = false;
  let reviewRecommended = false;

  try {
    const page = session.page as unknown as WaitablePage & FillablePage;

    // 1) Optional login precondition.
    if (plan.login !== null) {
      try {
        login = await ensureLoggedIn(session, {
          credentialScope: plan.login.credentialScope,
        });
      } catch (error) {
        return abortedResult({
          plan,
          startedAt,
          startedMs,
          status: "aborted-login-failed",
          detail: `Login flow failed: ${describeError(error)}`,
        });
      }
      if (login.status === "mfa-required" || login.status === "captcha-detected") {
        return abortedResult({
          plan,
          startedAt,
          startedMs,
          status: "aborted-login-failed",
          detail:
            login.status === "mfa-required"
              ? "The target requires multi-factor authentication. Zipy AI will not bypass MFA; " +
                "the workflow must be handed off to a human reviewer (review phase)."
              : "The target is gated by a CAPTCHA. Zipy AI will not attempt to solve CAPTCHAs; " +
                "the workflow must be handed off to a human reviewer (review phase).",
          login,
        });
      }
    }

    // 2) Start page navigation.
    if (typeof (page as unknown as { goto?: (u: string, o?: unknown) => Promise<unknown> }).goto !== "function") {
      return abortedResult({
        plan,
        startedAt,
        startedMs,
        status: "aborted-launch-failed",
        detail:
          "The opened page does not expose a `goto` method, so the workflow cannot navigate to its start URL.",
        login,
      });
    }
    try {
      await (page as unknown as { goto: (u: string, o?: unknown) => Promise<unknown> }).goto(
        plan.startUrl,
        { waitUntil: "domcontentloaded", timeout: config.browser.navigationTimeoutMs },
      );
    } catch (error) {
      return abortedResult({
        plan,
        startedAt,
        startedMs,
        status: "aborted-launch-failed",
        detail: `Navigation to the start URL failed: ${describeError(error)}`,
        login,
      });
    }

    // 3) Optional pre-run change detection.
    if (options.previousSnapshot !== undefined && options.previousSnapshot !== null) {
      try {
        changeReport = await detectChanges(
          page as unknown as Parameters<typeof detectChanges>[0],
          options.previousSnapshot,
        );
        resynthesisRequired = requiresResynthesis(changeReport);
        reviewRecommended = shouldFlagForReview(changeReport);
      } catch (error) {
        changeReport = null;
        // A change-detection failure is not fatal; log into the trace if
        // asked and continue with the plan.
        if (options.trace === true) {
          // eslint-disable-next-line no-console
          console.error(
            `[zipy/worker] change detection failed: ${describeError(error)}`,
          );
        }
      }

      if (resynthesisRequired) {
        return {
          planId: plan.id,
          status: "aborted-before-start",
          startedAt,
          finishedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedMs,
          login,
          steps,
          finalUrl: safePageUrl(page, false),
          changeReport,
          resynthesisRequired: true,
          reviewRecommended: true,
          abortDetail:
            "Change detection reported that the plan's recorded selectors no longer match the live page. " +
            "Re-synthesize before re-running.",
        };
      }
    }

    // 4) Execute steps in order.
    for (const step of plan.steps) {
      const outcome = await runOneStep(page, step, options);
      steps.push(outcome);

      if (outcome.status !== "completed" && options.stopOnFirstFailure === true) {
        break;
      }
      // A closed page aborts the rest of the run — there is nothing to
      // continue against.
      if (isPageClosed(page)) {
        return {
          planId: plan.id,
          status: "aborted-page-closed",
          startedAt,
          finishedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedMs,
          login,
          steps,
          finalUrl: safePageUrl(page, false),
          changeReport,
          resynthesisRequired,
          reviewRecommended: true,
          abortDetail: "The page was closed during the run; remaining steps were not executed.",
        };
      }
    }

    const failed = steps.filter((s) => s.status !== "completed").length;
    const status: WorkflowRunStatus = failed === 0 ? "completed" : "completed-with-failures";
    if (failed > 0) reviewRecommended = true;

    return {
      planId: plan.id,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedMs,
      login,
      steps,
      finalUrl: safePageUrl(page, false),
      changeReport,
      resynthesisRequired,
      reviewRecommended,
      abortDetail: null,
    };
  } finally {
    if (session !== null) {
      try {
        await closeSession(session);
      } catch {
        /* closing twice is not an error worth surfacing */
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Single-step execution                                                       */
/* -------------------------------------------------------------------------- */

async function runOneStep(
  page: WaitablePage & FillablePage,
  step: WorkflowStep,
  options: RunWorkflowOptions,
): Promise<StepOutcome> {
  const started = Date.now();
  const risk = classifyRisk(step);

  // Handle non-locator actions first.
  if (step.action === "navigate") {
    return await runNavigate(page, step, risk, started, options);
  }
  if (step.action === "wait") {
    return await runWait(page, step, risk, started, options);
  }

  // Locator-scoped actions: resolve the target with self-healing selectors.
  const target = toSelectorTarget(step.target ?? {});
  const resolution = await resolveSelector(page as never, target, {
    probeTimeoutMs: options.stepTimeoutMs,
  });

  if (resolution.status !== "resolved") {
    return {
      step: step.step,
      action: step.action,
      status:
        resolution.failure.reason === "page-closed" ? "failed-action" : "failed-selector",
      risk,
      elapsedMs: Date.now() - started,
      resolvedStrategy: null,
      drifted: false,
      before: null,
      after: null,
      crop: null,
      detail: resolution.failure.detail,
    };
  }

  const resolved: ResolutionResult = resolution.result;

  // Capture the "before" state for state-changing actions before we act.
  const capturePair = shouldCaptureBeforeAfter(step);
  const beforeCapture = capturePair
    ? await captureViewport(
        { kind: "chromium", page: page as unknown as PlaywrightPage } as BrowserSession,
        { format: "png", settleMs: 100 },
      )
    : null;

  try {
    const actionOutcome = await performAction(page, step, resolved);
    if (actionOutcome !== null) {
      return actionOutcome;
    }
  } catch (error) {
    return {
      step: step.step,
      action: step.action,
      status: "failed-action",
      risk,
      elapsedMs: Date.now() - started,
      resolvedStrategy: resolved.strategy,
      drifted: resolved.drift,
      before: beforeCapture,
      after: null,
      crop: null,
      detail: `Action execution failed: ${describeError(error)}`,
    };
  }

  // Capture the "after" state for state-changing actions.
  const afterCapture = capturePair
    ? await captureViewport(
        { kind: "chromium", page: page as unknown as PlaywrightPage } as BrowserSession,
        { format: "png", settleMs: 100 },
      )
    : null;

  // Element-crop of the target, using the primary selector when it still
  // resolves. This is what the annotate phase draws its highlight onto.
  const crop = await tryCrop(page, step, options);

  const drifted = resolved.drift || impliesResynthesis(resolved);
  return {
    step: step.step,
    action: step.action,
    status: "completed",
    risk,
    elapsedMs: Date.now() - started,
    resolvedStrategy: resolved.strategy,
    drifted,
    before: beforeCapture,
    after: afterCapture,
    crop,
    detail: drifted
      ? "The plan's primary selector did not match; a fallback selector was used. The step completed but the plan should be reviewed."
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Individual action executors                                                 */
/* -------------------------------------------------------------------------- */

async function runNavigate(
  page: WaitablePage & FillablePage,
  step: WorkflowStep,
  risk: WorkflowActionRisk,
  started: number,
  options: RunWorkflowOptions,
): Promise<StepOutcome> {
  if (step.url === null || step.url.trim().length === 0) {
    return {
      step: step.step,
      action: step.action,
      status: "unsupported-action",
      risk,
      elapsedMs: Date.now() - started,
      resolvedStrategy: null,
      drifted: false,
      before: null,
      after: null,
      crop: null,
      detail: "A navigate action requires a non-empty `url`.",
    };
  }
  const goto = (page as unknown as { goto?: (u: string, o?: unknown) => Promise<unknown> }).goto;
  if (typeof goto !== "function") {
    return {
      step: step.step,
      action: step.action,
      status: "unsupported-action",
      risk,
      elapsedMs: Date.now() - started,
      resolvedStrategy: null,
      drifted: false,
      before: null,
      after: null,
      crop: null,
      detail: "The page does not expose `goto`.",
    };
  }
  const config = getConfig();
  try {
    await goto.call(page, step.url, {
      waitUntil: "domcontentloaded",
      timeout: options.stepTimeoutMs ?? config.browser.navigationTimeoutMs,
    });
  } catch (error) {
    return {
      step: step.step,
      action: step.action,
      status: "failed-timeout",
      risk,
      elapsedMs: Date.now() - started,
      resolvedStrategy: null,
      drifted: false,
      before: null,
      after: null,
      crop: null,
      detail: `Navigation failed: ${describeError(error)}`,
    };
  }
  // Best-effort readiness wait after navigation.
  await waitForPageReady(page, { networkTimeoutMs: options.stepTimeoutMs });
  return {
    step: step.step,
    action: step.action,
    status: "completed",
    risk,
    elapsedMs: Date.now() - started,
    resolvedStrategy: null,
    drifted: false,
    before: null,
    after: null,
    crop: null,
    detail: null,
  };
}

async function runWait(
  page: WaitablePage & FillablePage,
  step: WorkflowStep,
  risk: WorkflowActionRisk,
  started: number,
  options: RunWorkflowOptions,
): Promise<StepOutcome> {
  // A wait step waits for a selector when a target is given, otherwise it
  // waits for network idle. The synthesizer emits waits whenever the plan
  // needs to give the app time to settle.
  const hasTarget =
    step.target !== null &&
    typeof step.target.selector === "string" &&
    step.target.selector.trim().length > 0;

  if (hasTarget && step.target !== null && typeof step.target.selector === "string") {
    const outcome = await waitForSelector(page, step.target.selector, {
      state: "visible",
      timeoutMs: options.stepTimeoutMs,
      trace: options.trace,
    });
    if (outcome.status === "ready") {
      return completedStepOutcome(step, risk, started);
    }
    return {
      step: step.step,
      action: step.action,
      status: outcome.status === "closed" ? "failed-action" : "failed-timeout",
      risk,
      elapsedMs: Date.now() - started,
      resolvedStrategy: null,
      drifted: false,
      before: null,
      after: null,
      crop: null,
      detail: outcome.detail ?? "Wait did not complete within the deadline.",
    };
  }

  const outcome = await waitForLoadState(page, "networkidle", {
    timeoutMs: options.stepTimeoutMs,
    trace: options.trace,
  });
  if (outcome.status === "ready") {
    return completedStepOutcome(step, risk, started);
  }
  return {
    step: step.step,
    action: step.action,
    status: outcome.status === "closed" ? "failed-action" : "failed-timeout",
    risk,
    elapsedMs: Date.now() - started,
    resolvedStrategy: null,
    drifted: false,
    before: null,
    after: null,
    crop: null,
    detail: outcome.detail ?? "networkidle did not settle within the deadline.",
  };
}

function completedStepOutcome(
  step: WorkflowStep,
  risk: WorkflowActionRisk,
  started: number,
): StepOutcome {
  return {
    step: step.step,
    action: step.action,
    status: "completed",
    risk,
    elapsedMs: Date.now() - started,
    resolvedStrategy: null,
    drifted: false,
    before: null,
    after: null,
    crop: null,
    detail: null,
  };
}

/**
 * Perform a locator-scoped action using the resolution that already
 * succeeded. The strategy name is carried on `resolved`; the locator factory
 * mirrors the one in `selectors.ts` — we re-derive the locator here instead
 * of exporting the internal one because the resolver's public API returns
 * the resolution value, not the locator.
 *
 * Returns a StepOutcome on failure, null on success.
 */
async function performAction(
  page: WaitablePage & FillablePage,
  step: WorkflowStep,
  resolved: ResolutionResult,
): Promise<StepOutcome | null> {
  const locator = buildActionLocator(page, resolved);
  if (locator === null) {
    return {
      step: step.step,
      action: step.action,
      status: "unsupported-action",
      risk: classifyRisk(step),
      elapsedMs: 0,
      resolvedStrategy: resolved.strategy,
      drifted: resolved.drift,
      before: null,
      after: null,
      crop: null,
      detail: `The resolution strategy "${resolved.strategy}" cannot be turned into a locator on this page.`,
    };
  }

  const actionTimeout = undefined; // defaults through config

  switch (step.action) {
    case "click": {
      if (typeof locator.click !== "function") {
        return unsupportedOutcome(step, resolved, "The resolved locator does not support click.");
      }
      await locator.click({ timeout: actionTimeout });
      return null;
    }
    case "type": {
      if (typeof locator.fill !== "function") {
        return unsupportedOutcome(step, resolved, "The resolved locator does not support type/fill.");
      }
      if (step.value === null) {
        return unsupportedOutcome(step, resolved, "A type action requires a non-null `value`.");
      }
      await locator.fill(step.value, { timeout: actionTimeout });
      return null;
    }
    case "select": {
      if (typeof locator.selectOption !== "function") {
        return unsupportedOutcome(step, resolved, "The resolved locator does not support select.");
      }
      if (step.value === null) {
        return unsupportedOutcome(step, resolved, "A select action requires a non-null `value`.");
      }
      await locator.selectOption(step.value, { timeout: actionTimeout });
      return null;
    }
    case "press": {
      if (typeof locator.press !== "function") {
        return unsupportedOutcome(step, resolved, "The resolved locator does not support press.");
      }
      if (step.value === null) {
        return unsupportedOutcome(step, resolved, "A press action requires a non-null `value` (key name).");
      }
      await locator.press(step.value, { timeout: actionTimeout });
      return null;
    }
    case "scroll": {
      if (typeof locator.scrollIntoViewIfNeeded !== "function") {
        return unsupportedOutcome(step, resolved, "The resolved locator does not support scrollIntoViewIfNeeded.");
      }
      await locator.scrollIntoViewIfNeeded({ timeout: actionTimeout });
      return null;
    }
    case "navigate":
    case "wait":
      // Handled earlier by runNavigate / runWait; reaching this branch means
      // the caller dispatched incorrectly. Report rather than throw.
      return unsupportedOutcome(
        step,
        resolved,
        `Action "${step.action}" should not reach performAction.`,
      );
    default:
      return unsupportedOutcome(
        step,
        resolved,
        `Unsupported action: ${String((step as { action: unknown }).action)}`,
      );
  }
}

function unsupportedOutcome(
  step: WorkflowStep,
  resolved: ResolutionResult,
  detail: string,
): StepOutcome {
  return {
    step: step.step,
    action: step.action,
    status: "unsupported-action",
    risk: classifyRisk(step),
    elapsedMs: 0,
    resolvedStrategy: resolved.strategy,
    drifted: resolved.drift,
    before: null,
    after: null,
    crop: null,
    detail,
  };
}

/* -------------------------------------------------------------------------- */
/* Locator construction for the chosen resolution                              */
/* -------------------------------------------------------------------------- */

interface ActionLocator {
  click?(options?: { timeout?: number; force?: boolean }): Promise<void>;
  fill?(value: string, options?: { timeout?: number }): Promise<void>;
  selectOption?(value: string, options?: { timeout?: number }): Promise<void>;
  press?(key: string, options?: { timeout?: number }): Promise<void>;
  scrollIntoViewIfNeeded?(options?: { timeout?: number }): Promise<void>;
}

/**
 * Build a locator from the resolution value. Mirrors the locator factory in
 * `selectors.ts` — ARIA and text strategies use Playwright's accessible-name
 * aware helpers, CSS strategies use `page.locator`. XPath uses the `xpath=`
 * prefix Playwright recognises.
 */
function buildActionLocator(
  page: WaitablePage & FillablePage,
  resolved: ResolutionResult,
): ActionLocator | null {
  const p = page as unknown as {
    locator?: (s: string) => ActionLocator;
    getByRole?: (r: string, opts?: { name?: string; exact?: boolean }) => ActionLocator;
    getByText?: (t: string, opts?: { exact?: boolean }) => ActionLocator;
  };

  switch (resolved.strategy) {
    case "css-primary":
    case "css-name-attribute":
    case "css-id-attribute": {
      if (typeof p.locator !== "function") return null;
      return p.locator(resolved.value);
    }
    case "aria-role-name": {
      if (typeof p.getByRole !== "function") return null;
      const parsed = parseJson(resolved.value);
      if (parsed === null) return null;
      const role = parsed["role"];
      const name = parsed["name"];
      if (typeof role !== "string" || typeof name !== "string") return null;
      return p.getByRole(role, { name, exact: true });
    }
    case "aria-role-only": {
      if (typeof p.getByRole !== "function") return null;
      const parsed = parseJson(resolved.value);
      if (parsed === null) return null;
      const role = parsed["role"];
      if (typeof role !== "string") return null;
      return p.getByRole(role);
    }
    case "text-content": {
      if (typeof p.getByText !== "function") return null;
      return p.getByText(resolved.value, { exact: true });
    }
    case "xpath": {
      if (typeof p.locator !== "function") return null;
      return p.locator(`xpath=${resolved.value}`);
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Capture helpers                                                             */
/* -------------------------------------------------------------------------- */

function shouldCaptureBeforeAfter(step: WorkflowStep): boolean {
  if (step.captureBeforeAfter === true) return true;
  if (step.captureBeforeAfter === false) return false;
  // Default: capture for click / type / select because those are the actions
  // whose effect is most useful to show as a diff.
  return step.action === "click" || step.action === "type" || step.action === "select";
}

/**
 * Capture an element-crop of the target. Best-effort: when the primary
 * selector no longer resolves to a visible element (drift case) this uses the
 * accessible role+name fallback only if `selectors.ts` produced one — but the
 * crop is enhanced output, so a miss is not a step failure.
 */
async function tryCrop(
  page: WaitablePage & FillablePage,
  step: WorkflowStep,
  options: RunWorkflowOptions,
): Promise<CaptureResult | null> {
  if (step.action === "navigate" || step.action === "wait") return null;
  const selector = step.target?.selector;
  if (typeof selector !== "string" || selector.trim().length === 0) return null;
  try {
    // captureElement takes a BrowserSession; reuse the page we were handed
    // by constructing the minimal session shape it needs.
    const stubSession = {
      kind: "chromium",
      page: page as unknown as PlaywrightPage,
    } as BrowserSession;
    return await captureElement(stubSession, selector, {
      format: "png",
      paddingPx: 8,
      waitTimeoutMs: options.stepTimeoutMs ?? 5_000,
    });
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Validation and helpers                                                      */
/* -------------------------------------------------------------------------- */

function validatePlan(plan: WorkflowPlan): string | null {
  if (typeof plan.id !== "string" || plan.id.trim().length === 0) {
    return "The workflow plan is missing an `id`.";
  }
  if (typeof plan.startUrl !== "string" || plan.startUrl.trim().length === 0) {
    return "The workflow plan is missing a `startUrl`.";
  }
  try {
    const parsed = new URL(plan.startUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `The workflow plan's startUrl uses "${parsed.protocol}"; only http/https are supported.`;
    }
  } catch {
    return `The workflow plan's startUrl "${plan.startUrl}" is not a valid absolute URL.`;
  }
  if (plan.login !== null) {
    const scope = plan.login.credentialScope;
    if (typeof scope !== "string" || scope.trim().length === 0) {
      return "The workflow plan's login precondition is missing a credentialScope.";
    }
  }
  const seen = new Set<number>();
  for (const step of plan.steps) {
    if (!Number.isInteger(step.step) || step.step < 1) {
      return `Every step must have a positive integer step number; found ${String(step.step)}.`;
    }
    if (seen.has(step.step)) {
      return `The workflow plan contains duplicate step number ${step.step}.`;
    }
    seen.add(step.step);
  }
  return null;
}

function abortedResult(args: {
  readonly plan: WorkflowPlan;
  readonly startedAt: string;
  readonly startedMs: number;
  readonly status: WorkflowRunStatus;
  readonly detail: string;
  readonly login?: LoginOutcome | null;
}): WorkflowRunResult {
  return {
    planId: args.plan.id,
    status: args.status,
    startedAt: args.startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - args.startedMs,
    login: args.login ?? null,
    steps: [],
    finalUrl: "",
    changeReport: null,
    resynthesisRequired: false,
    reviewRecommended: true,
    abortDetail: args.detail,
  };
}

function safePageUrl(page: unknown, keepQueryString: boolean): string {
  const p = page as { url?: () => string };
  if (typeof p.url !== "function") return "";
  let raw: string;
  try {
    raw = p.url();
  } catch {
    return "";
  }
  if (raw.length === 0) return "";
  if (keepQueryString) return raw;
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isPageClosed(page: unknown): boolean {
  const p = page as { isClosed?: () => boolean };
  if (typeof p.isClosed !== "function") return false;
  try {
    return p.isClosed();
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience wrapper: dry-run capture (no actions)                           */
/* -------------------------------------------------------------------------- */

export interface DryRunOptions {
  readonly trace?: boolean;
}

/**
 * Execute the plan's *probes* only — resolve every step target against the
 * live page and report which selectors matched. No clicks, no typing, no
 * navigation. Used by the plan-quality path in the synthesis phase and by
 * the reviewer's "preview" affordance.
 */
export async function dryRunPlan(
  plan: WorkflowPlan,
  options: DryRunOptions = {},
): Promise<WorkflowRunResult> {
  const { trace: _trace, ...rest } = options;
  return await runWorkflow(
    {
      ...plan,
      // Force every state-changing step to skip the before/after captures by
      // rewriting the step's capture flag. This keeps the dry-run cheap.
      steps: plan.steps.map((s) => ({ ...s, captureBeforeAfter: false })),
    },
    { ...rest, stopOnFirstFailure: false, trace: options.trace },
  );
}

/**
 * Re-export the change snapshot helper so a caller of this module does not
 * need to import `@zipy/automation/changeDetect` directly when they only want
 * to snapshot a plan's targets.
 */
export async function snapshotPlanTargets(
  session: BrowserSession,
  plan: WorkflowPlan,
): Promise<PageSnapshot | null> {
  return await captureSnapshot(
    session.page as unknown as Parameters<typeof captureSnapshot>[0],
    {
      steps: plan.steps
        .filter((s) => s.target !== null && typeof s.target.selector === "string")
        .map((s) => ({
          step: s.step,
          cssSelector: (s.target as StepTargetFragment).selector as string,
          role: (s.target as StepTargetFragment).role ?? null,
          accessibleName: (s.target as StepTargetFragment).name ?? null,
        })),
    },
  );
}
