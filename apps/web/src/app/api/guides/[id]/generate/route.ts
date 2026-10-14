/**
 * POST /api/guides/[id]/generate
 *
 * Kicks off the core content-generation pipeline for a guide. This route is
 * the surface the review editor calls after a workflow has been synthesized
 * and screenshots have been captured; it composes the batch-0 core writing
 * layers (title/summary, intro/prereqs, step copy, tips/warnings, FAQ,
 * glossary) into one draft and persists it.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; returns 503 config_error
 *     otherwise (no draft without persistence).
 *   - Requires at least one configured LLM provider, OR the caller passes
 *     `{"deterministic": true}` in the body to explicitly request a
 *     composer-only draft. Without either condition the route returns 503
 *     with the missing-setup message so the caller does not wait on a draft
 *     that cannot be produced.
 *   - Authenticates via the shared session module and asserts
 *     `PERMISSIONS.guide_update`. A caller without it gets 403 via
 *     `toAuthzFailure`.
 *   - `[id]` is the guide UUID, validated as such before any upstream call.
 *   - Optional body:
 *       { promptVersionId?: string,         // reserved for later prompt-pinning batches
 *         provider?: LlmProvider,
 *         model?: string,
 *         deterministic?: boolean,
 *         force?: boolean,
 *         style?: { tone, audience, brandTerms },
 *         layers?: { titleSummary | introPrereqs | stepText | tipsWarnings | faq | glossary: boolean } }
 *     Unknown fields are a 400 so a client cannot smuggle a shape the
 *     pipeline will silently ignore.
 *
 * Storage layout (all keys are workspace-scoped by `forWorkspace`):
 *   - `workflows/{workflowId}.json`         → the workflow + synthesized plan
 *   - `guides/{guideId}.json`               → the guide record (title, status)
 *   - `guides/{guideId}/drafts/{runId}.json` → one draft per generation run
 *   - `guides/{guideId}/draft-current.json` → pointer to the latest draft
 *   - `guides/{guideId}/draft-current.meta.json` → the draft's run metadata
 *
 * Idempotency: when the body does NOT set `force: true`, the route reuses the
 * current draft when its `inputsHash` matches the (workflow plan revision +
 * provider + model + style + layer toggles) combination. `force: true` always
 * produces a new draft. Idempotent responses return 200; a new draft returns
 * 201.
 *
 * What this route does NOT do:
 *   - Run Playwright. Capture belongs to the automation worker; this route
 *     consumes the resulting plan and screenshot metadata.
 *   - Run OCR/layout extraction. That is ingestion, earlier in the pipeline.
 *   - Perform tone/brand/terminology training. That is the next content
 *     batch; the route forwards `style` verbatim and the layers honour what
 *     they recognise.
 *   - Perform safety redaction or SEO meta generation. Those are later
 *     phases; this route hands the draft off unredacted with the AI label
 *     set, and the safety/SEO layers wrap the string fields.
 */

import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig, type LlmProvider } from "@/lib/config";
import { forWorkspace } from "@zipy/storage/objectStore";
import { describeConfiguredProviders } from "@zipy/llm/adapter";
import type { PlanStep } from "@zipy/synth/stepSequence";

import {
  generateGuideContent,
  type ContentPipelineLlmHandle,
  type GuideContentDraft,
} from "@zipy/content/pipeline";
import type { TitleSummaryStyle } from "@zipy/content/titleSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Storage namespace for guides; the workspace scoping is applied upstream. */
const GUIDES_PREFIX = "guides";
const WORKFLOWS_PREFIX = "workflows";

const MAX_MODEL_LENGTH = 128;
const MAX_BRAND_TERMS = 64;
const MAX_BRAND_TERM_LENGTH = 80;

const VALID_PROVIDERS: readonly LlmProvider[] = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "vllm",
];

const VALID_TONES: readonly NonNullable<TitleSummaryStyle["tone"]>[] = [
  "formal",
  "casual",
  "technical",
];

const VALID_AUDIENCES: readonly NonNullable<TitleSummaryStyle["audience"]>[] = [
  "end-user",
  "admin",
  "developer",
];

/* -------------------------------------------------------------------------- */
/* Body parsing                                                                */
/* -------------------------------------------------------------------------- */

interface RawBody {
  readonly promptVersionId?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly deterministic?: unknown;
  readonly force?: unknown;
  readonly style?: unknown;
  readonly layers?: unknown;
}

interface ValidatedBody {
  readonly provider: LlmProvider | null;
  readonly model: string | null;
  readonly deterministic: boolean;
  readonly force: boolean;
  readonly style: TitleSummaryStyle | null;
  readonly layers:
    | {
        readonly titleSummary?: boolean;
        readonly introPrereqs?: boolean;
        readonly stepText?: boolean;
        readonly tipsWarnings?: boolean;
        readonly faq?: boolean;
        readonly glossary?: boolean;
      }
    | null;
}

function badRequest(field: string, message: string): NextResponse {
  return NextResponse.json(
    { error: "validation_error", field, message },
    { status: 400 },
  );
}

function parseBody(raw: unknown): ValidatedBody | NextResponse {
  if (raw === null || raw === undefined) {
    return {
      provider: null,
      model: null,
      deterministic: false,
      force: false,
      style: null,
      layers: null,
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      {
        error: "invalid_json",
        message: "Request body must be a JSON object when present.",
      },
      { status: 400 },
    );
  }
  const body = raw as RawBody;
  const allowed = new Set([
    "promptVersionId",
    "provider",
    "model",
    "deterministic",
    "force",
    "style",
    "layers",
  ]);
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      return badRequest(
        key,
        `Unknown field "${key}". Allowed fields: ${Array.from(allowed).join(", ")}.`,
      );
    }
  }

  // `promptVersionId` is accepted and ignored for now — it will pin a
  // versioned prompt once the prompt registry is exposed to this task. It is
  // accepted rather than rejected so a client that already sends it does not
  // hit a 400 when the pinning lands.
  let _promptVersionId: string | null = null;
  if (typeof body.promptVersionId === "string" && body.promptVersionId.trim().length > 0) {
    _promptVersionId = body.promptVersionId.trim();
  }
  void _promptVersionId;

  let provider: LlmProvider | null = null;
  if (typeof body.provider === "string" && body.provider.trim().length > 0) {
    const candidate = body.provider.trim() as LlmProvider;
    if (!VALID_PROVIDERS.includes(candidate)) {
      return badRequest(
        "provider",
        `provider must be one of: ${VALID_PROVIDERS.join(", ")}.`,
      );
    }
    provider = candidate;
  }

  let model: string | null = null;
  if (typeof body.model === "string" && body.model.trim().length > 0) {
    const trimmed = body.model.trim();
    if (trimmed.length > MAX_MODEL_LENGTH) {
      return badRequest(
        "model",
        `model exceeds the ${MAX_MODEL_LENGTH}-character limit.`,
      );
    }
    model = trimmed;
  }

  const deterministic = body.deterministic === true;
  const force = body.force === true;

  // ------------------------------------------------------------- style ----
  let style: TitleSummaryStyle | null = null;
  if (body.style !== undefined && body.style !== null) {
    if (typeof body.style !== "object" || Array.isArray(body.style)) {
      return badRequest("style", "style must be an object.");
    }
    const s = body.style as Record<string, unknown>;
    const styleAllowed = new Set(["tone", "audience", "brandTerms"]);
    for (const key of Object.keys(s)) {
      if (!styleAllowed.has(key)) {
        return badRequest(
          `style.${key}`,
          `Unknown field "${key}". Allowed: tone, audience, brandTerms.`,
        );
      }
    }
    let tone: TitleSummaryStyle["tone"];
    if (s["tone"] !== undefined && s["tone"] !== null) {
      if (typeof s["tone"] !== "string" || !VALID_TONES.includes(s["tone"] as never)) {
        return badRequest("style.tone", `tone must be one of: ${VALID_TONES.join(", ")}.`);
      }
      tone = s["tone"] as TitleSummaryStyle["tone"];
    }
    let audience: TitleSummaryStyle["audience"];
    if (s["audience"] !== undefined && s["audience"] !== null) {
      if (
        typeof s["audience"] !== "string" ||
        !VALID_AUDIENCES.includes(s["audience"] as never)
      ) {
        return badRequest(
          "style.audience",
          `audience must be one of: ${VALID_AUDIENCES.join(", ")}.`,
        );
      }
      audience = s["audience"] as TitleSummaryStyle["audience"];
    }
    let brandTerms: string[] | undefined;
    if (s["brandTerms"] !== undefined && s["brandTerms"] !== null) {
      if (!Array.isArray(s["brandTerms"])) {
        return badRequest("style.brandTerms", "brandTerms must be an array of strings.");
      }
      if (s["brandTerms"].length > MAX_BRAND_TERMS) {
        return badRequest(
          "style.brandTerms",
          `At most ${MAX_BRAND_TERMS} brand terms per request.`,
        );
      }
      const out: string[] = [];
      for (let i = 0; i < s["brandTerms"].length; i += 1) {
        const entry = s["brandTerms"][i];
        if (typeof entry !== "string" || entry.trim().length === 0) {
          return badRequest(
            `style.brandTerms[${i}]`,
            "Each brand term must be a non-empty string.",
          );
        }
        if (entry.length > MAX_BRAND_TERM_LENGTH) {
          return badRequest(
            `style.brandTerms[${i}]`,
            `Brand term exceeds the ${MAX_BRAND_TERM_LENGTH}-character limit.`,
          );
        }
        out.push(entry.trim());
      }
      brandTerms = out;
    }
    const assembled: TitleSummaryStyle = {
      ...(tone !== undefined ? { tone } : {}),
      ...(audience !== undefined ? { audience } : {}),
      ...(brandTerms !== undefined ? { brandTerms } : {}),
    };
    style = Object.keys(assembled).length > 0 ? assembled : null;
  }

  // ------------------------------------------------------------- layers ---
  let layers: ValidatedBody["layers"] = null;
  if (body.layers !== undefined && body.layers !== null) {
    if (typeof body.layers !== "object" || Array.isArray(body.layers)) {
      return badRequest("layers", "layers must be an object of boolean flags.");
    }
    const l = body.layers as Record<string, unknown>;
    const layerNames = [
      "titleSummary",
      "introPrereqs",
      "stepText",
      "tipsWarnings",
      "faq",
      "glossary",
    ] as const;
    const out: {
      titleSummary?: boolean;
      introPrereqs?: boolean;
      stepText?: boolean;
      tipsWarnings?: boolean;
      faq?: boolean;
      glossary?: boolean;
    } = {};
    for (const key of Object.keys(l)) {
      if (!(layerNames as readonly string[]).includes(key)) {
        return badRequest(
          `layers.${key}`,
          `Unknown layer "${key}". Allowed: ${layerNames.join(", ")}.`,
        );
      }
      const v = l[key];
      if (typeof v !== "boolean") {
        return badRequest(`layers.${key}`, "Layer flags must be booleans.");
      }
      (out as Record<string, boolean>)[key] = v;
    }
    layers = Object.keys(out).length > 0 ? out : null;
  }

  return { provider, model, deterministic, force, style, layers };
}

/* -------------------------------------------------------------------------- */
/* Storage helpers                                                             */
/* -------------------------------------------------------------------------- */

interface StoreLike {
  readonly get: (key: string) => Promise<Buffer | null>;
  readonly put: (
    key: string,
    data: Buffer,
    opts?: {
      readonly contentType?: string;
      readonly contentLength?: number;
      readonly metadata?: Readonly<Record<string, string>>;
    },
  ) => Promise<void>;
}

function guideKey(guideId: string): string {
  return `${GUIDES_PREFIX}/${guideId}.json`;
}

function workflowKey(workflowId: string): string {
  return `${WORKFLOWS_PREFIX}/${workflowId}.json`;
}

function draftKey(guideId: string, runId: string): string {
  return `${GUIDES_PREFIX}/${guideId}/drafts/${runId}.json`;
}

function currentDraftKey(guideId: string): string {
  return `${GUIDES_PREFIX}/${guideId}/draft-current.json`;
}

function currentDraftMetaKey(guideId: string): string {
  return `${GUIDES_PREFIX}/${guideId}/draft-current.meta.json`;
}

async function readJsonOrNull(
  store: StoreLike,
  key: string,
): Promise<unknown | null> {
  let bytes: Buffer | null;
  try {
    bytes = await store.get(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(message)) return null;
    throw error;
  }
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Stored artifact ${key} is not valid JSON.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Workflow plan reading                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Workflows are written by the synthesis pipeline. The exact storage shape is
 * owned by that phase; this route only needs the plan (`PlanStep[]`) and,
 * when present, the goal + start-page metadata that the synthesis layer
 * stored alongside the plan. Extra fields are ignored.
 */
interface WorkflowRecord {
  readonly id?: unknown;
  readonly workspaceId?: unknown;
  readonly goal?: unknown;
  readonly startPageTitle?: unknown;
  readonly plan?: unknown;
  readonly planRevision?: unknown;
  readonly [key: string]: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function coercePlan(raw: unknown): PlanStep[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PlanStep[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    out.push(entry as PlanStep);
  }
  if (out.length === 0) return null;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                 */
/* -------------------------------------------------------------------------- */

interface CurrentDraftMeta {
  readonly runId?: unknown;
  readonly inputsHash?: unknown;
  readonly generatedAt?: unknown;
}

function computeInputsHash(args: {
  readonly workflowId: string;
  readonly planRevision: string | null;
  readonly plan: readonly PlanStep[];
  readonly provider: LlmProvider | null;
  readonly model: string | null;
  readonly deterministic: boolean;
  readonly style: TitleSummaryStyle | null;
  readonly layers: ValidatedBody["layers"];
  readonly guideGoal: string | null;
  readonly startPageTitle: string | null;
  readonly sources: readonly { readonly label: string; readonly kind: string }[];
}): string {
  // The plan is hashed by a stable JSON serialisation. PlanStep is a plain
  // object graph of primitives, so a sorted-key serialisation gives a stable
  // digest across runs that see the same plan.
  const canonical = stableStringify({
    workflowId: args.workflowId,
    planRevision: args.planRevision,
    plan: args.plan,
    provider: args.provider,
    model: args.model,
    deterministic: args.deterministic,
    style: args.style,
    layers: args.layers,
    guideGoal: args.guideGoal,
    startPageTitle: args.startPageTitle,
    sources: args.sources.map((s) => ({ label: s.label, kind: s.kind })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node as object)) return "[circular]";
    seen.add(node as object);
    if (Array.isArray(node)) return node.map(walk);
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = walk(obj[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/* -------------------------------------------------------------------------- */
/* LLM availability check                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `describeConfiguredProviders` returns the human-readable names of providers
 * that have credentials/base URLs. The exact shape is owned by the adapter;
 * we read `configured` defensively so a minor adapter change does not crash
 * this route.
 */
function readConfiguredProviders(): readonly string[] {
  const state = describeConfiguredProviders() as unknown;
  if (state === null || typeof state !== "object") return [];
  const configured = (state as { configured?: unknown }).configured;
  if (!Array.isArray(configured)) return [];
  return configured.filter((v): v is string => typeof v === "string");
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
          "DATABASE_URL is not configured on this server. Content generation cannot be recorded.",
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

  // --------------------------------------------------------- auth + RBAC ---
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: true,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/guides/[id]/generate] session load failed: ${
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
    assertPermission(session, PERMISSIONS.guide_update);
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
        message: "An active workspace is required to generate a guide.",
      },
      { status: 403 },
    );
  }

  // --------------------------------------------------------------- id ------
  const guideId = context.params.id;
  if (typeof guideId !== "string" || !UUID_PATTERN.test(guideId)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "id",
        message: "Guide id must be a UUID.",
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
  const parsed = parseBody(bodyJson);
  if (parsed instanceof NextResponse) return parsed;

  // ------------------------------------------------- LLM availability ------
  const configuredProviders = readConfiguredProviders();
  if (configuredProviders.length === 0 && !parsed.deterministic) {
    return NextResponse.json(
      {
        error: "llm_unconfigured",
        message:
          "No LLM provider is configured on this server. Set a provider credential " +
          "(OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY) or a local base URL " +
          "(OLLAMA_BASE_URL / VLLM_BASE_URL) plus LLM_DEFAULT_PROVIDER, or POST " +
          '{"deterministic": true} to compose the guide from templates only.',
        configured: [],
      },
      { status: 503 },
    );
  }

  // -------------------------------------------------------- storage ---------
  let store: StoreLike;
  try {
    const opened = await forWorkspace(workspaceId);
    store = opened as unknown as StoreLike;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/guides/[id]/generate] object store unavailable: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The artifact object store is not configured on this server. Check STORAGE_DRIVER and the associated S3/local configuration.",
      },
      { status: 503 },
    );
  }

  // ---------------------------------------------------- read guide ----------
  // The guide record carries the workflowId the guide was created for. We
  // refuse to generate content for an id that does not correspond to a guide
  // in the caller's workspace, which is the primary authorization boundary
  // the workspace-scoped store enforces.
  let guideRecord: Readonly<Record<string, unknown>>;
  try {
    const raw = await readJsonOrNull(store, guideKey(guideId));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json(
        {
          error: "not_found",
          message:
            "No guide exists under this id in your active workspace. Create the guide before generating its content.",
        },
        { status: 404 },
      );
    }
    guideRecord = raw as Readonly<Record<string, unknown>>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/guides/[id]/generate] guide read failed for ${guideId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The guide record could not be read from the object store. Check server logs.",
      },
      { status: 503 },
    );
  }

  const workflowId = asString(guideRecord["workflowId"]);
  if (workflowId === null || !UUID_PATTERN.test(workflowId)) {
    return NextResponse.json(
      {
        error: "guide_incomplete",
        message:
          "The guide is not linked to a workflow yet. Create the workflow and synthesize the plan before generating content.",
      },
      { status: 409 },
    );
  }

  // ---------------------------------------------------- read workflow ------
  let workflowRecord: WorkflowRecord;
  try {
    const raw = await readJsonOrNull(store, workflowKey(workflowId));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json(
        {
          error: "workflow_missing",
          message:
            "The guide's workflow record has not been persisted. Re-run synthesis before generating content.",
        },
        { status: 409 },
      );
    }
    workflowRecord = raw as WorkflowRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/guides/[id]/generate] workflow read failed for ${workflowId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The workflow record could not be read from the object store. Check server logs.",
      },
      { status: 503 },
    );
  }

  const plan = coercePlan(workflowRecord.plan);
  if (plan === null) {
    return NextResponse.json(
      {
        error: "workflow_unsynthesized",
        message:
          "The workflow has no synthesized plan yet. Run POST /api/workflows/{id}/synthesize first.",
      },
      { status: 409 },
    );
  }

  const gainGoal = asString(workflowRecord.goal);
  const startPageTitle = asString(workflowRecord.startPageTitle);
  const planRevision =
    typeof workflowRecord.planRevision === "number" ||
    typeof workflowRecord.planRevision === "string"
      ? String(workflowRecord.planRevision)
      : null;

  // Sources: read from the guide record when the guide phase recorded them;
  // otherwise empty. `TitleSummarySource` only requires label + kind.
  const sources = readSources(guideRecord["sources"]);

  // ------------------------------------------------------ idempotency ------
  const inputsHash = computeInputsHash({
    workflowId,
    planRevision,
    plan,
    provider: parsed.provider,
    model: parsed.model,
    deterministic: parsed.deterministic,
    style: parsed.style,
    layers: parsed.layers,
    guideGoal: gainGoal,
    startPageTitle,
    sources,
  });

  if (!parsed.force) {
    try {
      const metaRaw = await readJsonOrNull(store, currentDraftMetaKey(guideId));
      if (metaRaw !== null && typeof metaRaw === "object" && !Array.isArray(metaRaw)) {
        const meta = metaRaw as CurrentDraftMeta;
        const priorHash = asString(meta.inputsHash);
        if (priorHash !== null && priorHash === inputsHash) {
          // Current draft is already correct for these inputs. Read and
          // return it so the client can render without a fresh pipeline run.
          const draftRaw = await readJsonOrNull(store, currentDraftKey(guideId));
          if (draftRaw !== null) {
            return NextResponse.json(
              {
                guideId,
                workflowId,
                workspaceId,
                runId: asString(meta.runId) ?? null,
                generatedAt: asString(meta.generatedAt) ?? null,
                draft: draftRaw,
                created: false,
                inputsHash,
                message:
                  "The current draft already matches the requested inputs. Pass force: true to regenerate.",
              },
              { status: 200 },
            );
          }
        }
      }
    } catch (error) {
      // A metadata read failure should never block generation; the pipeline
      // will simply run and overwrite. Log and continue.
      process.stderr.write(
        `[/api/guides/[id]/generate] idempotency check skipped: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  // -------------------------------------------------------- LLM handle ------
  const llmHandle = parsed.deterministic
    ? null
    : makeLlmHandle(configuredProviders, config);

  // --------------------------------------------------------- pipeline -------
  let draft: GuideContentDraft;
  try {
    draft = await generateGuideContent(plan, {
      workflowId,
      workspaceId,
      llm: llmHandle,
      deterministic: parsed.deterministic,
      ...(parsed.provider !== null ? { provider: parsed.provider } : {}),
      ...(parsed.model !== null ? { model: parsed.model } : {}),
      ...(parsed.style !== null ? { style: parsed.style } : {}),
      guideGoal: gainGoal,
      startPageTitle,
      sources,
      ...(parsed.layers !== null ? { layers: parsed.layers } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown }).code;
    process.stderr.write(
      `[/api/guides/[id]/generate] pipeline failed for guide ${guideId}: ${message}\n`,
    );
    if (code === "empty-plan") {
      return NextResponse.json(
        {
          error: "empty_plan",
          message:
            "The workflow plan is empty. Nothing to generate. Re-synthesize the workflow first.",
        },
        { status: 409 },
      );
    }
    if (code === "empty-draft") {
      return NextResponse.json(
        {
          error: "empty_draft",
          message:
            "Every content layer was disabled or failed. Enable at least one layer, or supply an LLM provider, before retrying.",
          detail:
            error instanceof Error
              ? (error as { detail?: unknown }).detail ?? null
              : null,
        },
        { status: 422 },
      );
    }
    return NextResponse.json(
      {
        error: "generation_failed",
        message:
          "Content generation failed. Check server logs for the underlying error.",
      },
      { status: 500 },
    );
  }

  // --------------------------------------------------------------- persist --
  const runId = randomUUID();
  const nowIso = new Date().toISOString();
  const draftBytes = Buffer.from(JSON.stringify(draft, null, 2), "utf8");
  const draftHash = createHash("sha256").update(draftBytes).digest("hex");

  const metaPersisted = {
    kind: "guide-draft-meta",
    workspaceId,
    guideId,
    workflowId,
    runId,
    generatedAt: nowIso,
    inputsHash,
    draftHash,
    usedLlm: draft.usedLlm,
    lastProvider: draft.lastProvider,
    deterministic: parsed.deterministic,
    provider: parsed.provider,
    model: parsed.model,
    style: parsed.style,
    layers: parsed.layers,
    force: parsed.force,
    layerErrorCount: draft.layerErrors.length,
    generatedBy: session.userId,
  };

  try {
    // Write the per-run draft.
    await store.put(draftKey(guideId, runId), draftBytes, {
      contentType: "application/json",
      contentLength: draftBytes.length,
      metadata: {
        "zipy-kind": "guide-draft",
        "zipy-guide-id": guideId,
        "zipy-run-id": runId,
        "zipy-content-hash": draftHash,
      },
    });
    // Point the guide at the new run so the next read sees it.
    await store.put(currentDraftKey(guideId), draftBytes, {
      contentType: "application/json",
      contentLength: draftBytes.length,
      metadata: {
        "zipy-kind": "guide-draft-current",
        "zipy-guide-id": guideId,
        "zipy-run-id": runId,
        "zipy-content-hash": draftHash,
      },
    });
    const metaBytes = Buffer.from(JSON.stringify(metaPersisted, null, 2), "utf8");
    await store.put(currentDraftMetaKey(guideId), metaBytes, {
      contentType: "application/json",
      contentLength: metaBytes.length,
      metadata: {
        "zipy-kind": "guide-draft-meta",
        "zipy-guide-id": guideId,
        "zipy-run-id": runId,
        "zipy-inputs-hash": inputsHash,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/guides/[id]/generate] persist failed for guide ${guideId} run ${runId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The generated draft could not be persisted. Retry the request; no partial draft was recorded.",
      },
      { status: 503 },
    );
  }

  const status = 201;
  return NextResponse.json(
    {
      guideId,
      workflowId,
      workspaceId,
      runId,
      generatedAt: nowIso,
      draft,
      created: true,
      inputsHash,
      summary: {
        usedLlm: draft.usedLlm,
        lastProvider: draft.lastProvider,
        layerErrors: draft.layerErrors.length,
        notes: draft.notes.length,
        aiGenerated: draft.aiGenerated,
      },
      message:
        draft.layerErrors.length === 0
          ? "Guide content draft generated."
          : `Guide content draft generated with ${draft.layerErrors.length} layer error(s); see draft.layerErrors.`,
    },
    { status },
  );
}

/* -------------------------------------------------------------------------- */
/* LLM handle construction                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the LLM handle from the configured providers. The concrete adapter in
 * `@zipy/llm/adapter` is the right implementation; this route intentionally
 * does not re-implement provider selection. The handle returned here is a
 * thin pass-through that dynamically imports the adapter lazily so this route
 * does not hard-fail at module load when the adapter has not been built yet
 * (the adapter is present from the earlier synthesis phase; this import
 * strategy is a defensive measure and does not alter its behaviour).
 */
function makeLlmHandle(
  configuredProviders: readonly string[],
  config: ReturnType<typeof getConfig>,
): ContentPipelineLlmHandle | null {
  if (configuredProviders.length === 0) return null;

  // The `@zipy/llm/adapter` module exports a `callLlm`-style surface that
  // every earlier layer (annotate, synth) uses. We reuse it here rather than
  // calling a provider HTTP API directly. Because the adapter is imported in
  // other routes at the top level, this route could do the same; the lazy
  // import here is a compatibility hedge and does not alter the adapter's
  // behaviour.
  type AdapterModule = {
    readonly complete: (args: {
      readonly task: string;
      readonly system: string;
      readonly user: string;
      readonly maxOutputChars: number;
      readonly temperature: number;
      readonly provider?: LlmProvider;
      readonly model?: string | null;
    }) => Promise<{ readonly text: string }>;
    readonly isConfigured: () => boolean;
  };

  const handle: ContentPipelineLlmHandle = {
    complete: async (args) => {
      // Dynamic import keeps the route's top-level imports lean; the adapter
      // is otherwise imported by sibling routes without issue.
      const mod = (await import("@zipy/llm/adapter")) as unknown as AdapterModule;
      return mod.complete(args);
    },
    isConfigured: () => {
      // We already checked `configuredProviders.length > 0`; returning true
      // here avoids a second import at handle-construction time and keeps the
      // configured check in one place (the route).
      return true;
    },
  };

  // `config` is accepted so a future revision can select a default provider
  // from `config.llm.defaultProvider`; today the adapter resolves it.
  void config;
  return handle;
}

/* -------------------------------------------------------------------------- */
/* Source parsing                                                              */
/* -------------------------------------------------------------------------- */

interface ParsedSource {
  readonly label: string;
  readonly kind: "url" | "text" | "image" | "file" | "audio" | "video";
  readonly trust?: number;
}

function readSources(raw: unknown): readonly ParsedSource[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedSource[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const label = asString(obj["label"]);
    const kind = obj["kind"];
    if (label === null) continue;
    if (
      kind !== "url" &&
      kind !== "text" &&
      kind !== "image" &&
      kind !== "file" &&
      kind !== "audio" &&
      kind !== "video"
    ) {
      continue;
    }
    const trustRaw = obj["trust"];
    const trust = typeof trustRaw === "number" && Number.isFinite(trustRaw)
      ? trustRaw
      : undefined;
    out.push({
      label,
      kind,
      ...(trust !== undefined ? { trust } : {}),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

const READ_ONLY_MESSAGE =
  "This endpoint accepts POST to generate the core content draft for a guide. Read the draft via the guide read surface or the current-draft key in storage.";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function PUT(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function PATCH(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message: `${READ_ONLY_MESSAGE} Editing a draft belongs to the post-generation editor phase.`,
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "Draft runs are immutable-by-version; a version history stores each edit. To delete a draft, use the retention surface (admin/retention), not this route.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
