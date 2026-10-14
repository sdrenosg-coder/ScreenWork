/**
 * Zipy AI — on-prem packaging (phase 24, batch 1).
 *
 * A single, reviewable description of what the on-prem deployment surface
 * actually is, and a predicate the deployment tooling calls to confirm the
 * operator has supplied everything the platform cannot invent. This module
 * exists because the plan's phase 24 acceptance requires an on-prem path
 * that "builds and runs without cloud-only dependencies", and we need one
 * place that answers that honestly.
 *
 * Design boundaries:
 *
 *  - The module is a *manifest*, not a deployment. It does not build images,
 *    write compose files, or shell out to any tool. It enumerates the
 *    containers the operator must run, the environment variables each
 *    requires, the optional integrations that unlock when credentials are
 *    supplied, and the external services that the operator must supply —
 *    and it refuses to report "ready" when the mandatory items are missing.
 *    The actual `docker compose up` lives in `./docker-compose.yml` at the
 *    repo root; this module is the human-readable contract that file must
 *    satisfy.
 *
 *  - Nothing is auto-installed. LLM providers, OCR/IP/STT services, SMTP,
 *    S3, Redis and SAML IdPs are named as customer-supplied. The module
 *    never fabricates a URL, a key, or an endpoint that an operator has not
 *    provided.
 *
 *  - Cloud-only features are explicitly flagged. The scaling module already
 *    computes a policy for a single-host deployment; the manifest records
 *    which parts of the recommended setup (Kubernetes, managed autoscaling,
 *    hosted vector DB, hosted STT/OCR) are unnecessary on-prem.
 *
 *  - Readiness is a list, not a boolean. `onPremReadiness(input)` returns
 *    the list of missing mandatory items and the list of optional unlocks
 *    so an operator sees what to fix, not just that they must.
 *
 *  - No environment variable is read implicitly. The caller passes a
 *    snapshot of the relevant env keys; this makes the function usable in
 *    an admin page, in a preflight script, and in a test fixture that sets
 *    the snapshot explicitly.
 *
 * The module exports:
 *   - `ON_PREM_MANIFEST` — the frozen, reviewable manifest.
 *   - `onPremReadiness` — evaluate a caller-supplied env snapshot.
 *   - `summariseReadiness` — one-line human text for the admin UI.
 *   - `rehydrateEnvSnapshot` — typed load of a persisted snapshot.
 *   - Typed errors and constants.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type OnPremErrorCode =
  | "invalid-input"
  | "unknown-container"
  | "unknown-key";

export class OnPremError extends Error {
  readonly code: OnPremErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: OnPremErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A container the operator runs on-prem. `role` describes its function in
 * the platform so an operator reading the manifest knows why each is needed.
 * `optional` is true only for containers the platform can run without — e.g.
 * a Redis instance that is purely a wake-hint optimisation.
 */
export interface OnPremContainer {
  readonly name: string;
  readonly role:
    | "web"
    | "worker"
    | "postgres"
    | "redis"
    | "object-store"
    | "ocr-service"
    | "layout-service"
    | "stt-service"
    | "llm-service";
  readonly optional: boolean;
  /** Human text shown in the admin UI and in the compose file's comments. */
  readonly description: string;
}

/**
 * One environment variable the manifest expects. `required` means the
 * platform refuses to start without it; `optional` unlocks a named feature
 * when present.
 */
export interface OnPremEnvKey {
  readonly key: string;
  readonly required: boolean;
  /**
   * The feature this key unlocks when present. Present on both `required`
   * (where it names the container that reads the key) and `optional` (where
   * it names the capability) entries so a UI can group the list.
   */
  readonly unlocks: string;
  /** Optional hint at the value's shape, e.g. `postgres://...` or `hex 32+`. */
  readonly shape?: string;
  /**
   * Whether the value is a secret. Secrets are displayed redacted in the
   * admin UI. This module never reads the value of a key; it only records
   * presence in a caller-supplied snapshot.
   */
  readonly secret: boolean;
}

/**
 * An external capability that a self-hosted deployment may optionally
 * unlock, but which the platform never assumes is present.
 */
export interface OnPremExternalCapability {
  readonly id:
    | "hosted-llm"
    | "local-llm"
    | "cloud-ocr"
    | "cloud-stt"
    | "smtp"
    | "s3"
    | "redis"
    | "saml"
    | "stripe";
  readonly label: string;
  readonly required: false;
  /** The keys whose presence unlocks this capability. All must be present. */
  readonly envKeys: readonly string[];
  /** What the platform does while the capability is absent. */
  readonly fallbackBehaviour: string;
}

export interface OnPremManifest {
  readonly version: "on-prem-manifest/1";
  readonly containers: readonly OnPremContainer[];
  readonly envKeys: readonly OnPremEnvKey[];
  readonly externalCapabilities: readonly OnPremExternalCapability[];
  /**
   * Cloud-only capabilities the on-prem path does not need. Present so an
   * operator comparing the on-prem and cloud deployment pages sees the same
   * list scoped to their deployment.
   */
  readonly cloudOnly:
    | {
        readonly label: string;
        readonly onPremReplacement: string;
      }[]
    | readonly {
        readonly label: string;
        readonly onPremReplacement: string;
      }[];
  readonly generatedNote: string;
}

/**
 * A caller-supplied snapshot of the relevant environment keys. Values
 * themselves are not inspected beyond presence — this module never reads
 * a secret's contents, and callers must not pass them.
 */
export interface EnvSnapshot {
  readonly [key: string]: boolean | null;
}

export interface ReadinessItem {
  readonly key: string;
  readonly unlocks: string;
  readonly secret: boolean;
  readonly state: "present" | "missing";
}

export interface ReadinessReport {
  readonly version: "on-prem-readiness/1";
  /** Mandatory keys missing from the snapshot. Empty means "ready to start". */
  readonly missingRequired: readonly ReadinessItem[];
  /** Mandatory keys present in the snapshot. */
  readonly presentRequired: readonly ReadinessItem[];
  /**
   * Optional keys present. Each entry names the capability the operator has
   * unlocked by supplying it.
   */
  readonly unlockedOptional: readonly ReadinessItem[];
  /**
   * Optional keys absent. Each entry names the capability the operator has
   * *not* unlocked, so the operator knows what the platform will do
   * without it (see `externalCapabilities[].fallbackBehaviour`).
   */
  readonly unavailableOptional: readonly ReadinessItem[];
  /** True when every mandatory key is present. */
  readonly ready: boolean;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The canonical containers. This list matches the root `docker-compose.yml`
 * service names; adding a container here without adding it there (or vice
 * versa) is the class of drift the phase 26 integration pass catches.
 */
const CONTAINERS: readonly OnPremContainer[] = Object.freeze([
  Object.freeze({
    name: "web",
    role: "web",
    optional: false,
    description:
      "Next.js production server. Serves the UI, the REST API and the export/publishing surface.",
  }),
  Object.freeze({
    name: "worker",
    role: "worker",
    optional: false,
    description:
      "Node worker. Ingestion, browser automation, content generation, exports and webhooks.",
  }),
  Object.freeze({
    name: "postgres",
    role: "postgres",
    optional: false,
    description:
      "Postgres with the pgvector extension. Source of truth for users, workspaces, artifacts, jobs, embeddings and analytics.",
  }),
  Object.freeze({
    name: "object-store",
    role: "object-store",
    optional: true,
    description:
      "S3-compatible object store (MinIO or the operator's own). Optional: the platform's local-filesystem driver is the default.",
  }),
  Object.freeze({
    name: "redis",
    role: "redis",
    optional: true,
    description:
      "Optional fast-path wake channel for the job queue. Absent, the worker polls Postgres at JOBS_POLL_INTERVAL_MS.",
  }),
  Object.freeze({
    name: "ocr-service",
    role: "ocr-service",
    optional: true,
    description:
      "OCR adapter service. Optional: EasyOCR runs in-process on CPU when the operator has not supplied OCR_SERVICE_URL.",
  }),
  Object.freeze({
    name: "layout-service",
    role: "layout-service",
    optional: true,
    description:
      "Docling/TableFormer adapter service. Optional: PDF text-with-layout and table extraction degrade to the text-layer-only path when DOCLING_SERVICE_URL is absent.",
  }),
  Object.freeze({
    name: "stt-service",
    role: "stt-service",
    optional: true,
    description:
      "Speech-to-text adapter service. Optional: audio and video ingestion refuse with an explicit error when STT_ENGINE=none.",
  }),
  Object.freeze({
    name: "llm-service",
    role: "llm-service",
    optional: true,
    description:
      "Local OpenAI-compatible LLM server (Ollama/vLLM). Optional if the operator supplies hosted provider keys instead.",
  } as OnPremContainer),
]);

/**
 * Environment keys the platform reads. `required` entries are the minimum a
 * deployment must set to start; the rest unlock named capabilities. This
 * list is intentionally short — the platform's full config surface is much
 * larger, but the phase 24 acceptance calls only for the on-prem default,
 * so this manifest names what a default deployment touches.
 */
const ENV_KEYS: readonly OnPremEnvKey[] = Object.freeze([
  Object.freeze({
    key: "DATABASE_URL",
    required: true,
    unlocks: "postgres",
    shape: "postgres://user:pass@host:5432/dbname",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "SESSION_SECRET",
    required: true,
    unlocks: "web",
    shape: "hex string, 32+ characters (openssl rand -hex 32)",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "PUBLIC_BASE_URL",
    required: true,
    unlocks: "web",
    shape: "https://tutorials.example.com",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "ENCRYPTION_MASTER_KEY",
    required: false,
    unlocks: "compliance:encryption-at-rest",
    shape: "base64 or hex, 32 bytes",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "WEBHOOK_SIGNING_SECRET",
    required: false,
    unlocks: "webhooks",
    shape: "random 32+ byte string",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "REDIS_URL",
    required: false,
    unlocks: "redis",
    shape: "redis://host:6379",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "S3_BUCKET",
    required: false,
    unlocks: "object-store",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "S3_ACCESS_KEY_ID",
    required: false,
    unlocks: "object-store",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "S3_SECRET_ACCESS_KEY",
    required: false,
    unlocks: "object-store",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "OCR_SERVICE_URL",
    required: false,
    unlocks: "cloud-ocr",
    shape: "http(s)://host:port",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "DOCLING_SERVICE_URL",
    required: false,
    unlocks: "layout-service",
    shape: "http(s)://host:port",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "STT_SERVICE_URL",
    required: false,
    unlocks: "stt-service",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "OLLAMA_BASE_URL",
    required: false,
    unlocks: "local-llm",
    shape: "http://ollama:11434",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "VLLM_BASE_URL",
    required: false,
    unlocks: "local-llm",
    shape: "http://vllm:8000",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "OPENAI_API_KEY",
    required: false,
    unlocks: "hosted-llm",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "ANTHROPIC_API_KEY",
    required: false,
    unlocks: "hosted-llm",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "GEMINI_API_KEY",
    required: false,
    unlocks: "hosted-llm",
    secret: true,
  } as OnPremEnvKey),
  Object.freeze({
    key: "LLM_DEFAULT_PROVIDER",
    required: false,
    unlocks: "hosted-llm",
    shape: "openai | anthropic | gemini | ollama | vllm",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "SMTP_HOST",
    required: false,
    unlocks: "smtp",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "SMTP_FROM",
    required: false,
    unlocks: "smtp",
    shape: "no-reply@example.com",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "SAML_ENTRY_POINT",
    required: false,
    unlocks: "saml",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "SAML_IDP_CERT",
    required: false,
    unlocks: "saml",
    secret: false,
  } as OnPremEnvKey),
  Object.freeze({
    key: "STRIPE_SECRET_KEY",
    required: false,
    unlocks: "stripe",
    secret: true,
  } as OnPremEnvKey),
]);

const EXTERNAL_CAPABILITIES: readonly OnPremExternalCapability[] = Object.freeze([
  Object.freeze({
    id: "local-llm",
    label: "Local open-source LLM (Ollama/vLLM)",
    required: false,
    envKeys: ["OLLAMA_BASE_URL", "VLLM_BASE_URL"],
    fallbackBehaviour:
      "Without a local LLM endpoint and without a hosted provider key, generation, synthesis and translation refuse with an explicit configuration error (no placeholder text is produced).",
  } as OnPremExternalCapability),
  Object.freeze({
    id: "hosted-llm",
    label: "Hosted LLM provider (OpenAI/Anthropic/Gemini)",
    required: false,
    envKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
    fallbackBehaviour:
      "Without a hosted provider key, the platform falls back to the configured local provider if any; otherwise generation refuses with an explicit error.",
  } as OnPremExternalCapability),
  Object.freeze({
    id: "cloud-ocr",
    label: "External OCR service",
    required: false,
    envKeys: ["OCR_SERVICE_URL"],
    fallbackBehaviour:
      "Without OCR_SERVICE_URL, EasyOCR in-process handling is used; when the python toolchain is unavailable the image pipeline reports the missing dependency rather than producing empty text.",
  } as OnPremExternalCapability),
  Object.freeze({
    id: "cloud-stt",
    label: "External speech-to-text service",
    required: false,
    envKeys: ["STT_SERVICE_URL"],
    fallbackBehaviour:
      "Without STT_SERVICE_URL, audio/video ingestion is refused with an explicit error unless STT_ENGINE picks a local engine.",
  } as OnPremExternalCapability),
  Object.freeze({
    id: "smtp",
    label: "Outbound email (SMTP)",
    required: false,
    envKeys: ["SMTP_HOST", "SMTP_FROM"],
    fallbackBehaviour:
      "Without SMTP, invites, approval notifications and magic-link emails are queued as failed jobs that an admin can retrieve; nothing is sent.",
  } as OnPremExternalCapability),
  Object.freeze({
    id: "s3",
    label: "S3-compatible object store",
    required: false,
    envKeys: ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
    fallbackBehaviour:
      "Without the S3 trio, the storage layer uses the local filesystem driver; screenshots and artifacts live under STORAGE_LOCAL_ROOT.",
  } as OnPremExternalCapability),
  Object.freeze({
    id: "redis",
    label: "Redis (job-queue fast path)",
    required: false,
    envKeys: ["REDIS_URL"],
    fallbackBehaviour:
      "Without Redis, the worker polls Postgres at JOBS_POLL_INTERVAL_MS. Functionally identical; adds up to one poll interval of latency to job pickup.",
  } as OnPremExternalCapability),
  Object.freeze({
    id: "saml",
    label: "SAML identity provider",
    required: false,
    envKeys: ["SAML_ENTRY_POINT", "SAML_IDP_CERT"],
    fallbackBehaviour:
      "Without an IdP entry point and certificate, the SAML login surface reports a configuration error and the password/OAuth paths remain available.",
  } as OnPremExternalCapability),
  Object.freeze({
    id: "stripe",
    label: "Payment gateway (Stripe)",
    required: false,
    envKeys: ["STRIPE_SECRET_KEY"],
    fallbackBehaviour:
      "Without STRIPE_SECRET_KEY, billing runs in metered-only mode: usage is tracked and plans are assignable by an admin, but no charge is created.",
  } as OnPremExternalCapability),
]);

const CLOUD_ONLY: readonly {
  readonly label: string;
  readonly onPremReplacement: string;
}[] = Object.freeze([
  Object.freeze({
    label: "Managed autoscaling (Kubernetes/ECS)",
    onPremReplacement:
      "Run one web and one worker container per host; scale horizontally by adding hosts with docker compose -f docker-compose.yml --profile on-prem up.",
  }),
  Object.freeze({
    label: "Hosted vector store (Pinecone/Weaviate)",
    onPremReplacement:
      "Postgres with the pgvector extension, shipped in the same container the platform already runs.",
  }),
  Object.freeze({
    label: "Cloud object storage (S3, GCS)",
    onPremReplacement:
      "S3-compatible object store (MinIO) as an optional container, or the local filesystem driver by default.",
  }),
  Object.freeze({
    label: "Cloud CDN",
    onPremReplacement:
      "A reverse proxy of the operator's choice in front of the web container.",
  }),
  Object.freeze({
    label: "Hosted email relay (SES/SendGrid)",
    onPremReplacement:
      "SMTP via the operator's mail server or an on-prem relay; the SMTP_HOST and SMTP_FROM keys are unchanged.",
  }),
  Object.freeze({
    label: "Cloud-hosted speech-to-text and OCR",
    onPremReplacement:
      "Local adapters (EasyOCR in-process, Whisper via STT_SERVICE_URL) or the operator's own cloud keys.",
  }),
]);

export const ON_PREM_MANIFEST: OnPremManifest = Object.freeze({
  version: "on-prem-manifest/1",
  containers: CONTAINERS,
  envKeys: ENV_KEYS,
  externalCapabilities: EXTERNAL_CAPABILITIES,
  cloudOnly: CLOUD_ONLY,
  generatedNote:
    "This manifest matches the root docker-compose.yml service names. Adding a container there without adding it here is caught by the phase 26 integration pass. Values, endpoints and credentials are supplied by the operator; nothing is auto-installed or fabricated.",
} as OnPremManifest);

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate an env snapshot against the manifest. A key is "present" when the
 * snapshot has a truthy value at that key. Passing the value instead of a
 * boolean is tolerated so a deployment script can hand in `process.env`
 * directly without filtering; a value of `""` counts as missing, as does
 * `null` and `undefined`.
 */
export function onPremReadiness(snapshot: EnvSnapshot): ReadinessReport {
  if (snapshot === null || typeof snapshot !== "object") {
    throw new OnPremError(
      "onPremReadiness requires an env snapshot object.",
      "invalid-input",
    );
  }
  const missingRequired: ReadinessItem[] = [];
  const presentRequired: ReadinessItem[] = [];
  const unlockedOptional: ReadinessItem[] = [];
  const unavailableOptional: ReadinessItem[] = [];

  for (const entry of ON_PREM_MANIFEST.envKeys) {
    const present = snapshotValuePresent(snapshot[entry.key]);
    const item: ReadinessItem = {
      key: entry.key,
      unlocks: entry.unlocks,
      secret: entry.secret,
      state: present ? "present" : "missing",
    };
    if (entry.required) {
      if (present) presentRequired.push(item);
      else missingRequired.push(item);
    } else if (present) {
      unlockedOptional.push(item);
    } else {
      unavailableOptional.push(item);
    }
  }

  return Object.freeze({
    version: "on-prem-readiness/1",
    missingRequired: Object.freeze(missingRequired),
    presentRequired: Object.freeze(presentRequired),
    unlockedOptional: Object.freeze(unlockedOptional),
    unavailableOptional: Object.freeze(unavailableOptional),
    ready: missingRequired.length === 0,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * One-line human summary for an admin UI. The wording is stable so a
 * screenshot in a KB article does not drift between releases.
 */
export function summariseReadiness(report: ReadinessReport): string {
  if (report.ready) {
    const unlockedCount = report.unlockedOptional.length;
    return `On-prem configuration is ready to start: every required key is present and ${unlockedCount} optional capabilit${
      unlockedCount === 1 ? "y is" : "ies are"
    } unlocked.`;
  }
  const missing = report.missingRequired.map((m) => m.key).join(", ");
  return `On-prem configuration is not ready: ${report.missingRequired.length} required key${
    report.missingRequired.length === 1 ? "" : "s"
  } missing (${missing}). The platform refuses to start until these are set.`;
}

/**
 * The capability ids the snapshot has unlocked. Each capability is unlocked
 * when *any* of its `envKeys` is present — that is the platform's actual
 * behaviour (e.g. any of the three hosted-LLM keys unlocks the hosted
 * provider path). Containerised in a function so callers do not reimplement
 * the any/all rule.
 */
export function unlockedCapabilityIds(snapshot: EnvSnapshot): readonly string[] {
  if (snapshot === null || typeof snapshot !== "object") {
    throw new OnPremError("unlockedCapabilityIds requires an env snapshot.", "invalid-input");
  }
  const out: string[] = [];
  for (const cap of ON_PREM_MANIFEST.externalCapabilities) {
    const anyPresent = cap.envKeys.some((k) => snapshotValuePresent(snapshot[k]));
    if (anyPresent) out.push(cap.id);
  }
  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

export function rehydrateEnvSnapshot(value: unknown): EnvSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OnPremError("Rehydrate failed: expected a JSON object.", "invalid-input");
  }
  const out: Record<string, boolean | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
    else if (v === null) out[k] = null;
    else if (typeof v === "string") out[k] = v.length > 0;
    // Numbers, arrays and nested objects are rejected: an env snapshot is
    // boolean-or-string presence, and anything else is a caller bug.
  }
  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function snapshotValuePresent(v: boolean | null | undefined): boolean {
  if (v === true) return true;
  if (v === null || v === undefined) return false;
  // `snapshotValuePresent` is also called with a raw string when a caller
  // hands in process.env directly, so treat a non-empty string as present.
  if (typeof v === "string") return v.length > 0;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  CONTAINERS,
  ENV_KEYS,
  EXTERNAL_CAPABILITIES,
  CLOUD_ONLY,
  snapshotValuePresent,
});
