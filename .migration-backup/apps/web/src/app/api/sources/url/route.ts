/**
 * POST /api/sources/url
 *
 * Accepts { url } and, in this phase, validates + normalises the request and
 * records an intent to ingest. The actual fetch, a11y extraction and element
 * indexing happen on the worker (`apps/worker/src/ingest/url.ts`) because
 * Playwright must not run inside an HTTP request handler.
 *
 * This route is the *knowledge* half of URL ingestion:
 *  - Auth + workspace RBAC (`PERMISSIONS.source_create`).
 *  - Strict URL validation with the same rules the worker applies (absolute
 *    http(s), length-bounded) so a bad URL fails at the edge with a 400 rather
 *    than becoming a failed job.
 *  - Refuses when the jobs table cannot be reached: the whole point of this
 *    endpoint is to enqueue a `ingest:url` job, so a queue misconfiguration is
 *    a hard 503 rather than a silently-accepted upload.
 *  - Returns the created job's id and (once processed) the resulting
 *    artifactId from the job row. The worker writes `payload.result` back onto
 *    the same job row the queue module manages.
 *
 * The artifact upload + `enqueueJob` mechanics are the same shape used by the
 * existing `/api/artifacts/upload` route. Rather than duplicate the SQL, this
 * route reads and writes the same `jobs` table that the shared queue uses, so
 * the two stay consistent.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

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

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

const MAX_URL_LENGTH = 2048;

/* -------------------------------------------------------------------------- */
/* Postgres client                                                             */
/* -------------------------------------------------------------------------- */

type PoolCtor = new (opts: {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean } | false;
  max?: number;
}) => {
  query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};

const require = createRequire(import.meta.url);

function requirePool(): PoolCtor {
  try {
    const mod = require("pg") as { Pool: PoolCtor };
    return mod.Pool;
  } catch {
    throw new Error(
      "Zipy AI /api/sources/url: the `pg` package is not installed. Run `npm install` at the repository root.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Request validation                                                          */
/* -------------------------------------------------------------------------- */

interface UrlBody {
  readonly url?: unknown;
  /** Optional human label shown in the UI. */
  readonly label?: unknown;
  /** Optional natural-language adjunct for the URL (parsed separately). */
  readonly prompt?: unknown;
}

interface ValidatedUrlSource {
  readonly url: string;
  readonly label: string | null;
  readonly prompt: string | null;
}

function validate(body: UrlBody): ValidatedUrlSource | NextResponse {
  const raw = typeof body.url === "string" ? body.url.trim() : "";
  if (raw.length === 0) {
    return NextResponse.json(
      { error: "validation_error", field: "url", message: "A URL is required." },
      { status: 400 },
    );
  }
  if (raw.length > MAX_URL_LENGTH) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "url",
        message: `URL exceeds the ${MAX_URL_LENGTH}-character limit.`,
      },
      { status: 400 },
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "url",
        message: "The submitted URL is not a valid absolute URL.",
      },
      { status: 400 },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "url",
        message: "Only http and https URLs are accepted for URL ingestion.",
      },
      { status: 400 },
    );
  }

  let label: string | null = null;
  if (typeof body.label === "string" && body.label.trim().length > 0) {
    label = body.label.trim().slice(0, 160);
  }

  let prompt: string | null = null;
  if (typeof body.prompt === "string" && body.prompt.trim().length > 0) {
    prompt = body.prompt.trim().slice(0, 20_000);
  }

  return { url: parsed.toString(), label, prompt };
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
          "DATABASE_URL is not configured on this server. URL ingestion cannot be enqueued.",
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
      `[/api/sources/url] session load failed: ${
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
    bodyJson && typeof bodyJson === "object" ? (bodyJson as UrlBody) : {},
  );
  if (validated instanceof NextResponse) return validated;

  const jobKindCandidate = "ingest:url";
  if (!isJobKind(jobKindCandidate)) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "The job queue does not expose an `ingest:url` job kind. The queue schema and this route have drifted; redeploy the queue module.",
      },
      { status: 503 },
    );
  }
  const jobKind: JobKind = jobKindCandidate;

  // The idempotency key for a URL is derived from (workspace, normalised URL,
  // prompt). A user resubmitting the exact same URL with the same prompt
  // collapses onto the same job, matching the identical-content rule used by
  // artifact uploads. If the user wants a genuine re-run they change the URL
  // or the accompanying prompt.
  const idempotencyInput = `${workspaceId}\u0000${validated.url}\u0000${
    validated.prompt ?? ""
  }`;
  const { createHash } = await import("node:crypto");
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
        url: validated.url,
        label: validated.label,
        // The worker validates the prompt again before persisting it; passing
        // it here lets the worker attach a text-prompt artifact to the same
        // URL ingest without a second round-trip.
        prompt: validated.prompt,
        requestedAt: new Date().toISOString(),
        correlationId: randomUUID(),
      },
      idempotencyKey: `source:url:${idempotencyHash}`,
      correlationId: null,
      enqueuedBy: session.userId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/sources/url] enqueue ingest:url failed: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "queue_unavailable",
        message:
          "The URL ingestion job could not be enqueued. The job queue is not reachable; check DATABASE_URL and the jobs table.",
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
        idempotencyKey: `source:url:${idempotencyHash}`,
      },
      source: {
        kind: "source_url",
        url: validated.url,
        label: validated.label,
        prompt: validated.prompt,
        workspaceId,
      },
      message:
        "URL ingestion job enqueued. Poll GET /api/jobs/{id} (a later endpoint) or watch the worker log for completion.",
    },
    { status: enqueued.created ? 202 : 200 },
  );
}
