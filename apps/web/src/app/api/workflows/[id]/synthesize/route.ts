/**
 * POST /api/workflows/[id]/synthesize
 *
 * Enqueues a `synth:workflow` job for the given workflow id, using the LLM
 * adapter and prompt registry introduced in this batch. The route is a thin
 * orchestrator: it validates input, checks that at least one LLM provider is
 * configured (so the caller gets a crisp 503 instead of an async job failure),
 * and hands the actual synthesis to the worker, which is where Playwright,
 * the LLM adapter and the prompt renderer run.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; returns 503 config_error
 *     otherwise (no synthesized job without persistence).
 *   - Requires at least one configured LLM provider (see
 *     `describeConfiguredProviders()`). When nothing is configured the route
 *     returns 503 with the missing-setup message so the caller does not sit
 *     on a job that is destined to fail.
 *   - Authenticates via the shared session module and asserts
 *     `PERMISSIONS.workflow_update`. A caller without it gets 403.
 *   - `[id]` is the workflow UUID. A malformed id is a 400 before any
 *     upstream call.
 *   - Optional body fields:
 *       { promptVersionId?: string, provider?: LlmProvider, model?: string,
 *         force?: boolean }
 *     `promptVersionId` when supplied must be a version registered under
 *     `synth.workflow`; any other id is a 400.
 *     `provider` / `model` are forwarded as overrides on the job payload and
 *     are honoured by the adapter's per-call resolution.
 *     `force: true` bypasses the content-addressed idempotency key so a caller
 *     can request a fresh synthesis even when the inputs are unchanged.
 *
 * Response body echoes the prompt version that will be used (or the caller's
 * explicit choice) so the resulting artifact is attributable.
 *
 * Endpoints this route explicitly does not provide:
 *   - running synthesis inline (Playwright + LLM work belongs on the worker),
 *   - resolving a specific conflict or gap (that belongs to the review phase),
 *   - distilling the plan into a deterministic script (a separate job).
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig, type LlmProvider } from "@/lib/config";
import {
  enqueueJob,
  isJobKind,
  type EnqueueResult,
  type JobKind,
} from "@zipy/jobs/queue";
import {
  activePromptVersionFor,
  listPromptVersionsForTask,
  promptTemplateHash,
  tryGetPromptVersion,
} from "@zipy/llm/promptVersions";
import { describeConfiguredProviders } from "@zipy/llm/adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYNTHESIS_TASK_KEY = "synth.workflow";
const SYNTHESIS_JOB_KIND = "synth:workflow";
const MAX_MODEL_LENGTH = 128;

const VALID_PROVIDERS: readonly LlmProvider[] = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "vllm",
];

/* -------------------------------------------------------------------------- */
/* Body parsing                                                                */
/* -------------------------------------------------------------------------- */

interface SynthesizeBody {
  readonly promptVersionId?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly force?: unknown;
}

interface ValidatedSynthesizeBody {
  readonly promptVersionId: string | null;
  readonly provider: LlmProvider | null;
  readonly model: string | null;
  readonly force: boolean;
}

function parseBody(raw: unknown): ValidatedSynthesizeBody | NextResponse {
  if (raw === null || raw === undefined) {
    return {
      promptVersionId: null,
      provider: null,
      model: null,
      force: false,
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      {
        error: "invalid_json",
        message: "Request body must be a JSON object.",
      },
      { status: 400 },
    );
  }
  const body = raw as SynthesizeBody;

  let promptVersionId: string | null = null;
  if (typeof body.promptVersionId === "string" && body.promptVersionId.trim().length > 0) {
    const id = body.promptVersionId.trim();
    const version = tryGetPromptVersion(id);
    if (version === null) {
      const available = listPromptVersionsForTask(SYNTHESIS_TASK_KEY).map(
        (v) => v.id,
      );
      return NextResponse.json(
        {
          error: "validation_error",
          field: "promptVersionId",
          message:
            `Prompt version "${id}" is not registered. ` +
            `Registered versions for this task: ${available.join(", ") || "(none)"}.`,
        },
        { status: 400 },
      );
    }
    if (version.taskKey !== SYNTHESIS_TASK_KEY) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "promptVersionId",
          message:
            `Prompt version "${id}" belongs to task "${version.taskKey}", not "${SYNTHESIS_TASK_KEY}".`,
        },
        { status: 400 },
      );
    }
    promptVersionId = id;
  }

  let provider: LlmProvider | null = null;
  if (typeof body.provider === "string" && body.provider.trim().length > 0) {
    const trimmed = body.provider.trim() as LlmProvider;
    if (!VALID_PROVIDERS.includes(trimmed)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "provider",
          message: `provider must be one of: ${VALID_PROVIDERS.join(", ")}.`,
        },
        { status: 400 },
      );
    }
    provider = trimmed;
  }

  let model: string | null = null;
  if (typeof body.model === "string" && body.model.trim().length > 0) {
    const trimmed = body.model.trim();
    if (trimmed.length > MAX_MODEL_LENGTH) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "model",
          message: `model exceeds the ${MAX_MODEL_LENGTH}-character limit.`,
        },
        { status: 400 },
      );
    }
    model = trimmed;
  }

  const force = body.force === true;

  return { promptVersionId, provider, model, force };
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

export async function POST(
  req: Request,
  context: { readonly params: { readonly id: string } },
): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Workflow synthesis cannot be enqueued.",
      },
      { status: 503 },
    );
  }
  if (!config.auth.sessionSecretConfigured) {
    return NextResponse.json(
      {
        error: "config_error",
        message: "SESSION_SECRET is not configured on this server.",
      },
      { status: 503 },
    );
  }

  // ------------------------------------------------------- LLM availability -
  // Fail fast: an unconfigured LLM provider makes the queued job useless.
  const providerState = describeConfiguredProviders();
  if (providerState.configured.length === 0) {
    return NextResponse.json(
      {
        error: "llm_unconfigured",
        message:
          "No LLM provider is configured on this server. Set a provider credential " +
          "(OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY) or a local base URL " +
          "(OLLAMA_BASE_URL / VLLM_BASE_URL) plus LLM_DEFAULT_PROVIDER before requesting synthesis.",
        configured: [],
        defaultProvider: providerState.defaultProvider,
        fallbackChain: providerState.fallbackChain,
      },
      { status: 503 },
    );
  }

  // ------------------------------------------------------------ session ----
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: true,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/workflows/[id]/synthesize] session load failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return NextResponse.json(
      { error: "session_error", message: "Could not load the caller session." },
      { status: 500 },
    );
  }
  if (session === null) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Authentication required." },
      { status: 401 },
    );
  }
  try {
    assertPermission(session, PERMISSIONS.workflow_update);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  const workspaceId = session.activeWorkspaceId;
  if (workspaceId === null) {
    return NextResponse.json(
      {
        error: "workspace_required",
        message: "An active workspace is required to synthesize a workflow.",
      },
      { status: 403 },
    );
  }

  // --------------------------------------------------------------- id ------
  const workflowId = context.params.id;
  if (typeof workflowId !== "string" || !UUID_PATTERN.test(workflowId)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "id",
        message: "Workflow id must be a UUID.",
      },
      { status: 400 },
    );
  }

  // ---------------------------------------------------------- body ---------
  let bodyJson: unknown = null;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      bodyJson = await req.json();
    } catch {
      return NextResponse.json(
        {
          error: "invalid_json",
          message: "Request body must be valid JSON when present.",
        },
        { status: 400 },
      );
    }
  }
  const body = parseBody(bodyJson);
  if (body instanceof NextResponse) return body;

  // ------------------------------------------------- prompt version --------
  const activeVersion = activePromptVersionFor(SYNTHESIS_TASK_KEY);
  const chosenVersion = body.promptVersionId ?? activeVersion.id;
  const version = tryGetPromptVersion(chosenVersion);
  // parseBody already ensured the id is registered under the right task, but
  // guard against an out-of-band registry mutation between the two reads.
  if (version === null) {
    return NextResponse.json(
      {
        error: "configuration_drift",
        message:
          "The requested prompt version disappeared from the registry between validation and dispatch. Reload and retry.",
      },
      { status: 500 },
    );
  }

  // ------------------------------------------------------------ job kind ---
  if (!isJobKind(SYNTHESIS_JOB_KIND)) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "The job queue does not expose a `synth:workflow` job kind. The queue schema and this route have drifted; redeploy the queue module.",
      },
      { status: 503 },
    );
  }
  const jobKind: JobKind = SYNTHESIS_JOB_KIND;

  // ------------------------------------------------------ idempotency ------
  // Content-addressed on (workspace, workflow, prompt version + template hash,
  // provider override, model override). `force: true` mixes in a random
  // nonce so the caller can force a re-run of identical inputs.
  const idempotencyInput = [
    workspaceId,
    workflowId,
    version.id,
    promptTemplateHash(version),
    body.provider ?? "",
    body.model ?? "",
  ].join("\u0000");
  const idempotencyHash = createHash("sha256")
    .update(idempotencyInput)
    .digest("hex")
    .slice(0, 32);
  const idempotencyKey = body.force
    ? `synth:workflow:forced:${idempotencyHash}:${createHash("sha256")
        .update(String(Date.now()))
        .update(String(Math.random()))
        .digest("hex")
        .slice(0, 12)}`
    : `synth:workflow:${idempotencyHash}`;

  // ------------------------------------------------------------- enqueue ---
  let enqueued: EnqueueResult;
  try {
    enqueued = await enqueueJob({
      workspaceId,
      kind: jobKind,
      payload: {
        workflowId,
        promptVersionId: version.id,
        promptTemplateHash: promptTemplateHash(version),
        provider: body.provider,
        model: body.model,
        forced: body.force,
        requestedAt: new Date().toISOString(),
      },
      idempotencyKey,
      correlationId: workflowId,
      enqueuedBy: session.userId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/workflows/[id]/synthesize] enqueue synth:workflow failed: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "queue_unavailable",
        message:
          "The workflow synthesis job could not be enqueued. The job queue is not reachable; check DATABASE_URL and the jobs table.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      job: {
        id: enqueued.jobId,
        kind: enqueued.kind,
        status: enqueued.status,
        created: enqueued.created,
        idempotencyKey,
      },
      workflow: {
        id: workflowId,
        workspaceId,
      },
      synthesis: {
        promptVersionId: version.id,
        promptTemplateHash: promptTemplateHash(version),
        promptVersionSelectedByCaller: body.promptVersionId !== null,
        providerOverride: body.provider,
        modelOverride: body.model,
        forced: body.force,
      },
      llm: {
        configuredProviders: providerState.configured,
        defaultProvider: providerState.defaultProvider,
        fallbackChain: providerState.fallbackChain,
      },
      message:
        enqueued.created
          ? "Workflow synthesis job enqueued. The worker renders the prompt version, calls the LLM adapter with the configured fallback chain, and persists the action plan for review."
          : "An identical synthesis request is already pending or active; the existing job will be reused. Pass force: true to run it again.",
    },
    { status: enqueued.created ? 202 : 200 },
  );
}

/* -------------------------------------------------------------------------- */
/* Methods this route refuses                                                  */
/* -------------------------------------------------------------------------- */

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "This endpoint accepts POST to enqueue a synthesis job. Read the resulting workflow via the workflow read surface.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
