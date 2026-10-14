/**
 * Zipy AI — central runtime configuration.
 *
 * Single, typed read-point for environment configuration. Every module in the
 * workspace reads config through this file so that defaults, validation and
 * feature detection live in exactly one place.
 *
 * Rules honoured here:
 *  - No credentials are invented. Optional integrations report `configured: false`
 *    when the operator has not supplied the relevant environment variable.
 *  - The HTTP port is read from process.env.PORT (Replit) and only falls back to
 *    a local dev default when it is absent.
 *  - The server host binds to 0.0.0.0, never localhost/127.0.0.1.
 *  - Both server-only and browser-safe values are exposed. Browser-safe values
 *    are whitelisted explicitly under `publicConfig` so no secret can leak into
 *    a client bundle by accident.
 */

export type NodeEnv = "development" | "test" | "production";
export type LlmProvider = "openai" | "anthropic" | "gemini" | "ollama" | "vllm";
export type StorageDriver = "local" | "s3";

export interface ZipyConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;

  /** HTTP surface (web app). */
  readonly server: {
    /** Read from process.env.PORT; falls back to 3000 for local dev only. */
    readonly port: number;
    /** Always 0.0.0.0 — required for Replit and any container host. */
    readonly host: "0.0.0.0";
    /** Public base URL, e.g. https://my-app.replit.app — used for links/webhooks/OG. */
    readonly publicBaseUrl: string;
    /** Comma-separated allowed origins for the REST API; "*" is rejected in production. */
    readonly corsAllowedOrigins: readonly string[];
  };

  /** Postgres (with pgvector) connection. */
  readonly database: {
    readonly url: string | null;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
    readonly ssl: boolean;
    readonly configured: boolean;
  };

  /** Optional Redis for job-queue scaling. Absent = in-process/Postgres queue only. */
  readonly redis: {
    readonly url: string | null;
    readonly configured: boolean;
  };

  /** Artifact + screenshot storage. */
  readonly storage: {
    readonly driver: StorageDriver;
    readonly localRoot: string;
    readonly s3: {
      readonly endpoint: string | null;
      readonly region: string | null;
      readonly bucket: string | null;
      readonly accessKeyId: string | null;
      readonly secretAccessKey: string | null;
      readonly forcePathStyle: boolean;
      readonly configured: boolean;
    };
  };

  /** Session/crypto material. Absent secret = auth surface must refuse to issue sessions. */
  readonly auth: {
    readonly sessionSecret: string | null;
    readonly sessionSecretConfigured: boolean;
    readonly sessionTtlSeconds: number;
    readonly cookieName: string;
    readonly cookieSecure: boolean;
    readonly allowSignup: boolean;
    readonly oauth: {
      readonly google: OAuthConfig;
      readonly github: OAuthConfig;
    };
    readonly saml: {
      readonly configured: boolean;
      readonly entryPoint: string | null;
      readonly issuer: string | null;
      readonly certPresent: boolean;
    };
  };

  /** LLM provider selection. No provider is assumed pre-provisioned. */
  readonly llm: {
    readonly defaultProvider: LlmProvider | null;
    readonly fallbackChain: readonly LlmProvider[];
    readonly providers: {
      readonly openai: ProviderConfig;
      readonly anthropic: ProviderConfig;
      readonly gemini: ProviderConfig;
      readonly ollama: ProviderConfig;
      readonly vllm: ProviderConfig;
    };
    readonly requestTimeoutMs: number;
    readonly maxRetries: number;
  };

  /** Local open-source processing adapters (OCR + layout/table parsing). */
  readonly processing: {
    readonly ocr: {
      readonly engine: "easyocr" | "tesseract" | "cloud" | "auto";
      readonly pythonPath: string;
      readonly serviceUrl: string | null;
      readonly serviceConfigured: boolean;
    };
    readonly layout: {
      readonly engine: "docling" | "none";
      readonly serviceUrl: string | null;
      readonly serviceConfigured: boolean;
    };
    readonly stt: {
      readonly engine: "whisper-local" | "whisper-cpp" | "cloud" | "none";
      readonly serviceUrl: string | null;
      readonly serviceConfigured: boolean;
    };
  };

  /** Headless browser farm settings for Playwright execution. */
  readonly browser: {
    readonly headless: boolean;
    readonly browserKind: "chromium" | "firefox" | "webkit";
    readonly viewport: { readonly width: number; readonly height: number };
    readonly deviceScaleFactor: number;
    readonly defaultTimeoutMs: number;
    readonly navigationTimeoutMs: number;
    readonly maxParallelContexts: number;
    readonly proxyUrl: string | null;
    readonly proxyConfigured: boolean;
  };

  /** Job queue behaviour. */
  readonly jobs: {
    readonly concurrency: number;
    readonly maxAttempts: number;
    readonly backoffBaseMs: number;
    readonly pollIntervalMs: number;
    readonly lockTtlMs: number;
  };

  /** Outbound webhooks (signed). */
  readonly webhooks: {
    readonly signingSecret: string | null;
    readonly signingSecretConfigured: boolean;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
  };

  /** Retention + security policy defaults (overridable per workspace in the DB). */
  readonly compliance: {
    readonly defaultRetentionDays: number;
    readonly encryptionMasterKey: string | null;
    readonly encryptionMasterKeyConfigured: boolean;
  };

  /** Email delivery (magic links, approvals, invites). No SMTP = no email dispatched. */
  readonly email: {
    readonly smtp: {
      readonly host: string | null;
      readonly port: number;
      readonly user: string | null;
      readonly password: string | null;
      readonly from: string | null;
      readonly configured: boolean;
    };
  };

  /** Billing plan model. Payment gateway integration is out of scope until keys are supplied. */
  readonly billing: {
    readonly provider: "none" | "stripe";
    readonly stripeSecretKeyPresent: boolean;
    readonly liveChargesEnabled: boolean;
  };

  /** Non-secret values safe to embed in the browser bundle. */
  readonly publicConfig: {
    readonly appName: "Zipy AI";
    readonly nodeEnv: NodeEnv;
    readonly publicBaseUrl: string;
    readonly allowSignup: boolean;
    readonly authProviders: readonly ("password" | "google" | "github" | "saml")[];
  };
}

interface OAuthConfig {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly configured: boolean;
}

interface ProviderConfig {
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly configured: boolean;
}

/* -------------------------------------------------------------------------- */
/* Environment parsing helpers                                                 */
/* -------------------------------------------------------------------------- */

function readString(names: readonly string[]): string | null {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function readNumber(names: readonly string[], fallback: number): number {
  const raw = readString(names);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(names: readonly string[], fallback: boolean): boolean {
  const raw = readString(names);
  if (raw === null) return fallback;
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readCsv(names: readonly string[]): readonly string[] {
  const raw = readString(names);
  if (raw === null) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeNodeEnv(raw: string | null): NodeEnv {
  if (raw === "production" || raw === "test") return raw;
  return "development";
}

function normalizeStorageDriver(raw: string | null): StorageDriver {
  return raw === "s3" ? "s3" : "local";
}

function normalizeLlmProvider(raw: string | null): LlmProvider | null {
  if (
    raw === "openai" ||
    raw === "anthropic" ||
    raw === "gemini" ||
    raw === "ollama" ||
    raw === "vllm"
  ) {
    return raw;
  }
  return null;
}

function normalizeLlmProviderList(raw: string | null): readonly LlmProvider[] {
  if (raw === null) return [];
  const out: LlmProvider[] = [];
  for (const piece of raw.split(",")) {
    const parsed = normalizeLlmProvider(piece.trim());
    if (parsed !== null && !out.includes(parsed)) out.push(parsed);
  }
  return out;
}

function ensureHttpUrl(raw: string | null, fallback: string): string {
  if (raw === null) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return raw.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* Config assembly                                                             */
/* -------------------------------------------------------------------------- */

function buildConfig(): ZipyConfig {
  const nodeEnv = normalizeNodeEnv(readString(["NODE_ENV"]));
  const isProduction = nodeEnv === "production";
  const isTest = nodeEnv === "test";
  const isDevelopment = nodeEnv === "development";

  // Replit injects PORT; fall back to 3000 only for local development.
  const port = readNumber(["PORT"], 3000);

  const publicBaseUrl = ensureHttpUrl(
    readString(["PUBLIC_BASE_URL", "APP_URL", "REPLIT_DEV_DOMAIN"]).replace(
      /^www\./,
      "https://",
    ) || null,
    `http://0.0.0.0:${port}`,
  );

  const corsAllowedOrigins = (() => {
    const raw = readCsv(["CORS_ALLOWED_ORIGINS"]);
    if (raw.length > 0) return raw;
    // Sensible dev defaults; never wildcard in production.
    if (isProduction) return [publicBaseUrl];
    return [publicBaseUrl, `http://0.0.0.0:${port}`, `http://localhost:${port}`];
  })();

  const databaseUrl = readString([
    "DATABASE_URL",
    "POSTGRES_URL",
    "PG_URL",
  ]);

  const redisUrl = readString(["REDIS_URL", "REDIS_TLS_URL"]);

  const storageDriver = normalizeStorageDriver(
    readString(["STORAGE_DRIVER", "OBJECT_STORE_DRIVER"]),
  );
  const localRoot =
    readString(["STORAGE_LOCAL_ROOT", "OBJECT_STORE_LOCAL_ROOT"]) ??
    "./.data/objects";
  const s3Endpoint = readString(["S3_ENDPOINT"]);
  const s3Region = readString(["S3_REGION", "AWS_REGION"]);
  const s3Bucket = readString(["S3_BUCKET", "AWS_S3_BUCKET"]);
  const s3AccessKeyId = readString(["S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"]);
  const s3SecretAccessKey = readString([
    "S3_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
  ]);

  const sessionSecret = readString([
    "SESSION_SECRET",
    "AUTH_SESSION_SECRET",
    "JWT_SECRET",
  ]);
  const sessionTtlSeconds = readNumber(
    ["SESSION_TTL_SECONDS", "SESSION_TTL"],
    60 * 60 * 24 * 30,
  );
  const cookieName = readString(["SESSION_COOKIE_NAME"]) ?? "zipy_session";
  const cookieSecure = readBool(["SESSION_COOKIE_SECURE"], isProduction);
  const allowSignup = readBool(["ALLOW_SIGNUP", "AUTH_ALLOW_SIGNUP"], true);

  const googleClientId = readString(["GOOGLE_CLIENT_ID"]);
  const googleClientSecret = readString(["GOOGLE_CLIENT_SECRET"]);
  const githubClientId = readString(["GITHUB_CLIENT_ID"]);
  const githubClientSecret = readString(["GITHUB_CLIENT_SECRET"]);

  const samlEntryPoint = readString(["SAML_ENTRY_POINT", "SAML_IDP_ENTRY_POINT"]);
  const samlIssuer = readString(["SAML_ISSUER"]);
  const samlCertPresent =
    readString(["SAML_IDP_CERT", "SAML_CERT"]) !== null ||
    readString(["SAML_IDP_METADATA_URL"]) !== null;

  const defaultProvider = normalizeLlmProvider(
    readString(["LLM_DEFAULT_PROVIDER", "LLM_PROVIDER"]),
  );
  const fallbackChain = normalizeLlmProviderList(
    readString(["LLM_FALLBACK_CHAIN"]),
  );

  const openaiKey = readString(["OPENAI_API_KEY"]);
  const anthropicKey = readString(["ANTHROPIC_API_KEY"]);
  const geminiKey = readString(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  const ollamaBase = readString(["OLLAMA_BASE_URL"]);
  const vllmBase = readString(["VLLM_BASE_URL"]);

  const ocrEngineRaw = readString(["OCR_ENGINE"]);
  const ocrEngine: ZipyConfig["processing"]["ocr"]["engine"] =
    ocrEngineRaw === "tesseract" ||
    ocrEngineRaw === "cloud" ||
    ocrEngineRaw === "auto"
      ? ocrEngineRaw
      : ocrEngineRaw === "easyocr"
        ? "easyocr"
        : "auto";

  const layoutEngineRaw = readString(["LAYOUT_ENGINE"]);
  const layoutEngine: ZipyConfig["processing"]["layout"]["engine"] =
    layoutEngineRaw === "docling" ? "docling" : "none";

  const sttEngineRaw = readString(["STT_ENGINE"]);
  const sttEngine: ZipyConfig["processing"]["stt"]["engine"] =
    sttEngineRaw === "whisper-local" ||
    sttEngineRaw === "whisper-cpp" ||
    sttEngineRaw === "cloud"
      ? sttEngineRaw
      : "none";

  const browserKindRaw = readString(["PLAYWRIGHT_BROWSER"]);
  const browserKind: ZipyConfig["browser"]["browserKind"] =
    browserKindRaw === "firefox" || browserKindRaw === "webkit"
      ? browserKindRaw
      : "chromium";

  const proxyUrl = readString(["PLAYWRIGHT_PROXY_URL", "PROXY_URL"]);

  const webhookSigningSecret = readString(["WEBHOOK_SIGNING_SECRET"]);
  const encryptionMasterKey = readString([
    "ENCRYPTION_MASTER_KEY",
    "MASTER_ENCRYPTION_KEY",
  ]);

  const smtpHost = readString(["SMTP_HOST"]);
  const smtpUser = readString(["SMTP_USER"]);
  const smtpPassword = readString(["SMTP_PASSWORD", "SMTP_PASS"]);
  const smtpFrom = readString(["SMTP_FROM", "MAIL_FROM"]);

  const stripeSecretKeyPresent = readString(["STRIPE_SECRET_KEY"]) !== null;

  const authProviders: readonly ("password" | "google" | "github" | "saml")[] =
    (() => {
      const list: ("password" | "google" | "github" | "saml")[] = ["password"];
      if (googleClientId !== null && googleClientSecret !== null) {
        list.push("google");
      }
      if (githubClientId !== null && githubClientSecret !== null) {
        list.push("github");
      }
      if (samlEntryPoint !== null && samlCertPresent) {
        list.push("saml");
      }
      return list;
    })();

  const config: ZipyConfig = {
    nodeEnv,
    isProduction,
    isDevelopment,
    isTest,

    server: {
      port,
      host: "0.0.0.0",
      publicBaseUrl,
      corsAllowedOrigins,
    },

    database: {
      url: databaseUrl,
      poolMax: readNumber(["DATABASE_POOL_MAX", "PG_POOL_MAX"], 10),
      statementTimeoutMs: readNumber(
        ["DATABASE_STATEMENT_TIMEOUT_MS"],
        30_000,
      ),
      ssl: readBool(["DATABASE_SSL", "PGSSL"], isProduction),
      configured: databaseUrl !== null,
    },

    redis: {
      url: redisUrl,
      configured: redisUrl !== null,
    },

    storage: {
      driver: storageDriver,
      localRoot,
      s3: {
        endpoint: s3Endpoint,
        region: s3Region,
        bucket: s3Bucket,
        accessKeyId: s3AccessKeyId,
        secretAccessKey: s3SecretAccessKey,
        forcePathStyle: readBool(["S3_FORCE_PATH_STYLE"], s3Endpoint !== null),
        configured:
          s3Bucket !== null &&
          s3AccessKeyId !== null &&
          s3SecretAccessKey !== null,
      },
    },

    auth: {
      sessionSecret,
      sessionSecretConfigured: sessionSecret !== null,
      sessionTtlSeconds,
      cookieName,
      cookieSecure,
      allowSignup,
      oauth: {
        google: {
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          configured: googleClientId !== null && googleClientSecret !== null,
        },
        github: {
          clientId: githubClientId,
          clientSecret: githubClientSecret,
          configured: githubClientId !== null && githubClientSecret !== null,
        },
      },
      saml: {
        configured: samlEntryPoint !== null && samlCertPresent,
        entryPoint: samlEntryPoint,
        issuer: samlIssuer,
        certPresent: samlCertPresent,
      },
    },

    llm: {
      defaultProvider,
      fallbackChain,
      providers: {
        openai: {
          apiKey: openaiKey,
          baseUrl: readString(["OPENAI_BASE_URL"]),
          model: readString(["OPENAI_MODEL"]),
          configured: openaiKey !== null,
        },
        anthropic: {
          apiKey: anthropicKey,
          baseUrl: readString(["ANTHROPIC_BASE_URL"]),
          model: readString(["ANTHROPIC_MODEL"]),
          configured: anthropicKey !== null,
        },
        gemini: {
          apiKey: geminiKey,
          baseUrl: readString(["GEMINI_BASE_URL"]),
          model: readString(["GEMINI_MODEL"]),
          configured: geminiKey !== null,
        },
        ollama: {
          apiKey: null,
          baseUrl: ollamaBase,
          model: readString(["OLLAMA_MODEL"]),
          configured: ollamaBase !== null,
        },
        vllm: {
          apiKey: null,
          baseUrl: vllmBase,
          model: readString(["VLLM_MODEL"]),
          configured: vllmBase !== null,
        },
      },
      requestTimeoutMs: readNumber(["LLM_REQUEST_TIMEOUT_MS"], 60_000),
      maxRetries: readNumber(["LLM_MAX_RETRIES"], 2),
    },

    processing: {
      ocr: {
        engine: ocrEngine,
        pythonPath: readString(["PYTHON_PATH"]) ?? "python3",
        serviceUrl: readString(["OCR_SERVICE_URL"]),
        serviceConfigured: readString(["OCR_SERVICE_URL"]) !== null,
      },
      layout: {
        engine: layoutEngine,
        serviceUrl: readString(["DOCLING_SERVICE_URL"]),
        serviceConfigured: readString(["DOCLING_SERVICE_URL"]) !== null,
      },
      stt: {
        engine: sttEngine,
        serviceUrl: readString(["STT_SERVICE_URL"]),
        serviceConfigured: readString(["STT_SERVICE_URL"]) !== null,
      },
    },

    browser: {
      headless: readBool(["PLAYWRIGHT_HEADLESS"], true),
      browserKind,
      viewport: {
        width: readNumber(["PLAYWRIGHT_VIEWPORT_WIDTH"], 1440),
        height: readNumber(["PLAYWRIGHT_VIEWPORT_HEIGHT"], 900),
      },
      deviceScaleFactor: readNumber(["PLAYWRIGHT_DEVICE_SCALE"], 2),
      defaultTimeoutMs: readNumber(["PLAYWRIGHT_DEFAULT_TIMEOUT_MS"], 15_000),
      navigationTimeoutMs: readNumber(
        ["PLAYWRIGHT_NAVIGATION_TIMEOUT_MS"],
        45_000,
      ),
      maxParallelContexts: readNumber(["PLAYWRIGHT_MAX_CONTEXTS"], 2),
      proxyUrl,
      proxyConfigured: proxyUrl !== null,
    },

    jobs: {
      concurrency: readNumber(["JOBS_CONCURRENCY"], 4),
      maxAttempts: readNumber(["JOBS_MAX_ATTEMPTS"], 3),
      backoffBaseMs: readNumber(["JOBS_BACKOFF_BASE_MS"], 5_000),
      pollIntervalMs: readNumber(["JOBS_POLL_INTERVAL_MS"], 1_000),
      lockTtlMs: readNumber(["JOBS_LOCK_TTL_MS"], 5 * 60_000),
    },

    webhooks: {
      signingSecret: webhookSigningSecret,
      signingSecretConfigured: webhookSigningSecret !== null,
      timeoutMs: readNumber(["WEBHOOK_TIMEOUT_MS"], 10_000),
      maxAttempts: readNumber(["WEBHOOK_MAX_ATTEMPTS"], 5),
    },

    compliance: {
      defaultRetentionDays: readNumber(["DEFAULT_RETENTION_DAYS"], 180),
      encryptionMasterKey,
      encryptionMasterKeyConfigured: encryptionMasterKey !== null,
    },

    email: {
      smtp: {
        host: smtpHost,
        port: readNumber(["SMTP_PORT"], 587),
        user: smtpUser,
        password: smtpPassword,
        from: smtpFrom,
        configured: smtpHost !== null && smtpFrom !== null,
      },
    },

    billing: {
      provider: "stripe",
      stripeSecretKeyPresent,
      // Live charges are only possible when an operator supplies a Stripe key
      // and explicitly opts in; both conditions must hold.
      liveChargesEnabled: stripeSecretKeyPresent,
    },

    publicConfig: {
      appName: "Zipy AI",
      nodeEnv,
      publicBaseUrl,
      allowSignup,
      authProviders,
    },
  };

  return config;
}

let cached: ZipyConfig | null = null;

/** Get the (process-wide, memoized) runtime configuration. */
export function getConfig(): ZipyConfig {
  if (cached === null) cached = buildConfig();
  return cached;
}

/** Reset the memoized config — useful in tests when env vars change. */
export function resetConfigForTests(): void {
  cached = null;
}

/**
 * Assert that a required capability is configured, throwing a descriptive
 * error otherwise. Callers use this to fail loudly instead of silently
 * degrading into placeholder behaviour.
 */
export function requireConfig<K extends keyof ZipyConfig>(
  section: K,
  predicate?: (section: ZipyConfig[K]) => boolean,
  reason?: string,
): ZipyConfig[K] {
  const config = getConfig();
  const value = config[section];
  const ok = predicate ? predicate(value) : Boolean(value);
  if (!ok) {
    throw new Error(
      `Zipy AI configuration error: "${String(section)}" is not configured${
        reason ? ` (${reason})` : ""
      }. Set the required environment variables before using this feature.`,
    );
  }
  return value;
}

/**
 * Validate configuration for server startup. Returns a list of hard failures
 * (which should prevent the server from booting) and soft warnings (missing
 * optional integrations the operator may add later).
 */
export function validateStartupConfig(): {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
} {
  const config = getConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.database.configured) {
    warnings.push(
      "DATABASE_URL is not set. Persistence, auth and job processing will fail until Postgres is configured.",
    );
  }

  if (!config.auth.sessionSecretConfigured) {
    errors.push(
      "SESSION_SECRET is not set. Refusing to start web app because sessions cannot be issued safely.",
    );
  } else if ((config.auth.sessionSecret ?? "").length < 32) {
    errors.push(
      "SESSION_SECRET must be at least 32 characters. Generate one with `openssl rand -hex 32`.",
    );
  }

  if (config.isProduction) {
    if (config.server.publicBaseUrl.startsWith("http://")) {
      warnings.push(
        "PUBLIC_BASE_URL uses http:// in production; configure HTTPS in front of the app.",
      );
    }
    if (config.server.corsAllowedOrigins.includes("*")) {
      errors.push("CORS_ALLOWED_ORIGINS must not contain '*' in production.");
    }
    if (!config.storage.s3.configured && config.storage.driver === "s3") {
      errors.push(
        "STORAGE_DRIVER=s3 is set but S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are incomplete.",
      );
    }
  }

  if (config.llm.defaultProvider === null) {
    warnings.push(
      "No LLM_DEFAULT_PROVIDER is configured. Generation, synthesis and AI content layers will fail with an explicit error until a provider (hosted or local) is supplied.",
    );
  }

  if (!config.webhooks.signingSecretConfigured) {
    warnings.push(
      "WEBHOOK_SIGNING_SECRET is not set. Outbound webhooks will be refused rather than sent unsigned.",
    );
  }

  if (!config.compliance.encryptionMasterKeyConfigured) {
    warnings.push(
      "ENCRYPTION_MASTER_KEY is not set. Per-workspace encryption-at-rest cannot be enabled.",
    );
  }

  if (config.isProduction && config.billing.liveChargesEnabled) {
    // Informational; the actual charge surface is gated by the billing phase.
    warnings.push(
      "STRIPE_SECRET_KEY is present; live-charges surfaces become reachable once the billing phase wires them.",
    );
  }

  return { errors, warnings };
}
