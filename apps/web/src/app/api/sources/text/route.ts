/**
 * POST /api/sources/text
 *
 * Accepts { prompt, ... } and enqueues a `ingest:text` job. Parsing of the
 * natural-language prompt into goal/entities/sub-tasks is done on the worker
 * (`apps/worker/src/ingest/textPrompt.ts`), which is pure and offline, but the
 * REST contract for this phase is deliberately simple: validate the payload,
 * persist nothing here (the worker writes the artifact), enqueue the job.
 *
 * If the caller also supplies a `urlArtifactId`, the worker will attempt to
 * ground the parsed sub-tasks against the element index of that URL ingest.
 * A missing or unprocessed URL artifact is not an error at enqueue time — the
 * worker will emit `grounded: false` in the resulting text artifact and the
 * user can supply a URL later.
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { enqueueJob, isJobKind, type EnqueueResult, type JobKind } from "@zipy/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_LENGTH = 20_000;
const MAX_LABEL_LENGTH = 160;

interface TextBody {
  readonly prompt?: unknown;
  readonly label?: unknown;
  /**
   * Optional artifact id of a previously-ingested URL. When present the worker
   * attempts to ground the parsed sub-tasks using that page's element index.
   */
  readonly urlArtifactId?: unknown;
}

interface ValidatedTextSource {
  readonly prompt: string;
  readonly label: string | null;
  readonly urlArtifactId: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(body: TextBody): ValidatedTextSource | NextResponse {
  const raw = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (raw.length === 0) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "prompt",
        message: "A text prompt is required.",
      },
      { status: 400 },
    );
  }
  if (raw.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "prompt",
        message: `Prompt exceeds the ${MAX_PROMPT_LENGTH}-character limit.`,
      },
      { status: 400 },
    );
  }

  let label: string | null = null;
  if (typeof body.label === "string" && body.label.trim().length > 0) {
    label = body.label.trim().slice(0, MAX_LABEL_LENGTH);
  }

  let urlArtifactId: string | null = null;
  if (typeof body.urlArtifactId === "string") {
    const trimmed = body.urlArtifactId.trim();
    if (trimmed.length === 0) {
      urlArtifactId = null;
    } else if (!UUID_PATTERN.test(trimmed)) {
      return NextResponse.json(
        {
          error: "validation_error",
          field: "urlArtifactId",
          message: "urlArtifactId must be a UUID string when provided.",
        },
        { status: 400 },
      );
    } else {
      urlArtifactId = trimmed;
    }
  }

  return { prompt: raw, label, urlArtifactId };
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

export async function POST(req: Request): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Text ingestion cannot be enqueued.",
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

  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: true,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/sources/text] session load failed: ${
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
    assertPermission(session, PERMISSIONS.source_create);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  const workspaceId = session.activeWorkspaceId as string;

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const validated = validate(
    bodyJson && typeof bodyJson === "object" ? (bodyJson as TextBody) : {},
  );
  if (validated instanceof NextResponse) return validated;

  const jobKindCandidate = "ingest:text";
  if (!isJobKind(jobKindCandidate)) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "The job queue does not expose an `ingest:text` job kind. The queue schema and this route have drifted; redeploy the queue module.",
      },
      { status: 503 },
    );
  }
  const jobKind: JobKind = jobKindCandidate;

  const idempotencyInput = `${workspaceId}\u0000${validated.prompt}\u0000${
    validated.urlArtifactId ?? ""
  }`;
  const idempotencyHash = createHash("sha256")
    .update(idempotencyInput)
    .digest("hex")
    .slice(0, 32);

  let enqueued: EnqueueResult;
  try {
    enqueued = await enqueueJob({
      workspaceId,
      kind: jobKind,
      payload: {
        prompt: validated.prompt,
        label: validated.label,
        urlArtifactId: validated.urlArtifactId,
        requestedAt: new Date().toISOString(),
      },
      idempotencyKey: `source:text:${idempotencyHash}`,
      correlationId: validated.urlArtifactId,
      enqueuedBy: session.userId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/sources/text] enqueue ingest:text failed: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "queue_unavailable",
        message:
          "The text-ingestion job could not be enqueued. The job queue is not reachable; check DATABASE_URL and the jobs table.",
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
        idempotencyKey: `source:text:${idempotencyHash}`,
      },
      source: {
        kind: "source_text",
        prompt: validated.prompt,
        label: validated.label,
        urlArtifactId: validated.urlArtifactId,
        workspaceId,
      },
      message:
        enqueued.created
          ? "Text ingestion job enqueued. The worker parses the prompt into goal/entities/sub-tasks and persists a source_text artifact."
          : "An identical text ingestion is already pending or active; the existing job will be reused.",
    },
    { status: enqueued.created ? 202 : 200 },
  );
}
