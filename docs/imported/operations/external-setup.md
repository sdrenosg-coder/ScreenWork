# External setup for a Zipy AI deployment

This document lists every capability that requires an operator to supply
credentials, accounts or infrastructure that Zipy AI does not and cannot
provide on the customer's behalf. It is written for the operator
deploying the platform (self-hosted or on a managed cloud), not for the
end user of a published guide.

The list is authoritative for the current codebase. When a capability is
not configured, the corresponding feature fails with an explicit error
(a `503` from the API route, or a thrown `not-configured`-class error
from the module). Nothing is stubbed to appear to work; a capability
that has not had its credentials supplied reports as unconfigured.

Record this document's revision alongside every deployment. A later phase
may add capabilities; this file is the source of truth for what is
required *now*.

---

## How to read this document

Each section names:

- **Capability** — the user-visible feature that consumes the credential.
- **Environment variable(s)** — exactly what to set.
- **Source of the value** — where the operator obtains it.
- **Behaviour when unset** — what the platform does. This is either
  an explicit error (a route returns `503`, a module throws) or a
  documented absence (a feature is simply not shown). It is never a
  silent fallback to a placeholder.
- **Verification** — how to confirm the credential is being used.

Values are read once at process start from `process.env`, validated, and
surfaced through `apps/web/src/lib/config.ts`. Restart the web app and
worker after changing any value. Nothing is read from disk or from a
database row; secrets live in the process environment.

---

## 1. Required on every deployment

These have no sensible platform-side default. A deployment missing them
either fails to start or has no persistence.

### 1.1 `PORT`

- **Capability** — the HTTP port the web app binds to. On Replit, the
  platform sets this.
- **Environment variable(s)** — `PORT`.
- **Source of the value** — the hosting platform. On Replit this is
  injected automatically; do not set it manually there.
- **Behaviour when unset** — falls back to `3000` for local development
  only. In production the app starts on `3000`, which the reverse proxy
  will not route to unless it is configured to match.
- **Verification** — `curl -fsS http://0.0.0.0:$PORT/` returns the app's
  landing page. Note that the server binds to `0.0.0.0`, not `127.0.0.1`;
  clients on the same host reach it via `127.0.0.1` or `localhost`.

### 1.2 `SESSION_SECRET`

- **Capability** — signing sessions. Without it, the web app refuses to
  start (`SESSION_SECRET is not set. Refusing to start web app because
  sessions cannot be issued safely.`).
- **Environment variable(s)** — `SESSION_SECRET`. Aliases accepted:
  `AUTH_SESSION_SECRET`, `JWT_SECRET`. Supply exactly one.
- **Source of the value** — generate locally. Recommended:
  `openssl rand -hex 32`. Minimum length accepted by the startup check
  is 32 characters; a shorter value causes the same startup refusal.
- **Behaviour when unset** — the process logs the refusal and exits
  non-zero. There is no development bypass.
- **Verification** — the process starts and `POST /api/auth/signup`
  (when `ALLOW_SIGNUP` is enabled) succeeds.

### 1.3 `DATABASE_URL`

- **Capability** — persistence for users, workspaces, sources,
  artifacts, jobs, canonical items, guides, analytics events, audit log
  and webhook subscriptions.
- **Environment variable(s)** — `DATABASE_URL`. Aliases accepted:
  `POSTGRES_URL`, `PG_URL`.
- **Source of the value** — a Postgres 15+ instance with the `pgvector`
  extension. `docker-compose.yml` provisions
  `pgvector/pgvector:pg16` locally; a managed Postgres (Replit's
  built-in database, RDS, Cloud SQL, Neon, Supabase, etc.) works when
  the extension is enabled.
- **Behaviour when unset** — the app starts, but any route or worker
  job that reaches persistence returns `503 config_error` with
  `DATABASE_URL is not configured on this server`. The worker's job
  loop reports an error at every poll.
- **Verification** — the migration runner exits 0:
  `npm run migrate`. Then `SELECT version FROM schema_migrations;`
  from a `psql` prompt returns the version rows the runner wrote.

Once connected, run `npm run migrate` at least once. The runner is
idempotent, so it is safe to re-run after every deployment.

---

## 2. Local infrastructure (recommended for self-host)

### 2.1 Local Postgres and Redis via Docker Compose

- **Capability** — a reproducible local Postgres with pgvector, and
  Redis for cross-process job-queue scaling.
- **File** — `docker-compose.yml` at the repository root.
- **Command** — `npm run infra:up` (wraps `docker compose up -d`).
- **Behaviour when unset** — the app still starts when `DATABASE_URL`
  and (optionally) `REDIS_URL` point elsewhere. Redis is optional; the
  default queue backend is the Postgres `jobs` table.

The compose file's credentials (`POSTGRES_PASSWORD=zipy_local_dev_only`)
are local-development placeholders. Override them via environment
variables before exposing the ports; do not use these values on a host
reachable from the internet.

### 2.2 `REDIS_URL`

- **Capability** — multi-process job-queue scaling. The default queue
  backend is the Postgres `jobs` table, which is correct for a single
  worker process. Redis is required only when running multiple worker
  processes against one queue.
- **Environment variable(s)** — `REDIS_URL`. Alias: `REDIS_TLS_URL`.
- **Source of the value** — the operator provisions Redis (or a
  Redis-compatible service such as KeyDB, Dragonfly, or a managed
  Redis-compatible cache).
- **Behaviour when unset** — the platform uses the Postgres job table.
  No error; this is the documented default.

---

## 3. Storage

### 3.1 Local filesystem (default)

- **Capability** — artifact and screenshot storage.
- **Environment variable(s)** — `STORAGE_DRIVER=local` (the default).
  `STORAGE_LOCAL_ROOT` optionally overrides the root path; the default
  is `./.data/objects`.
- **Behaviour when unset** — the local driver writes under the default
  root. This is appropriate for a single-host deployment and for a
  Replit deployment whose persistent volume is mounted at the
  repository root.

### 3.2 S3-compatible object storage

- **Capability** — artifact and screenshot storage in an object store.
  Required for any multi-host deployment and for any deployment whose
  ephemeral filesystem is reset on redeploy.
- **Environment variable(s)** — `STORAGE_DRIVER=s3`, `S3_BUCKET`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`. Optional:
  `S3_ENDPOINT` for a non-AWS S3-compatible service (MinIO, R2,
  Backblaze B2, Wasabi, etc.), `S3_FORCE_PATH_STYLE` (defaults to `true`
  when `S3_ENDPOINT` is set, matching most non-AWS services).
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` are
  accepted as aliases.
- **Source of the value** — the object store's console or IaC. The
  access key must have `s3:PutObject`, `s3:GetObject` and
  `s3:DeleteObject` on the bucket prefix the platform uses. Grant
  `s3:ListBucket` when you want the retention phase's orphan sweep to
  run.
- **Behaviour when unset** — with `STORAGE_DRIVER=s3`, the app refuses
  to start in production (`STORAGE_DRIVER=s3 is set but S3_BUCKET /
  S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are incomplete.`). With
  `STORAGE_DRIVER=local` (or unset), the local driver is used.
- **Verification** — upload a file via
  `POST /api/artifacts/upload` and confirm the object appears in the
  bucket under the workspace's prefix.

---

## 4. LLM providers

The platform has no working LLM unless at least one provider is
configured. Every generation, synthesis and long-form capability
depends on one. The platform ships an adapter that resolves a provider
at call time and falls back along a configurable chain.

### 4.1 Default provider selection

- **Environment variable(s)** — `LLM_DEFAULT_PROVIDER` (one of
  `openai`, `anthropic`, `gemini`, `ollama`, `vllm`).
  `LLM_FALLBACK_CHAIN` (comma-separated provider list, tried in order
  when the default fails).
- **Behaviour when unset** — the app starts with a warning
  (`No LLM_DEFAULT_PROVIDER is configured. Generation, synthesis and AI
  content layers will fail with an explicit error until a provider
  (hosted or local) is supplied.`). Every generation route returns `503
  llm_unconfigured`, naming the environment variables to supply.
- **Verification** — `POST /api/workflows/{id}/synthesize` returns a
  job id (2xx), not `503 llm_unconfigured`.

### 4.2 Hosted provider credentials (BYO key)

Each of these is optional; supply the one(s) your organisation has
contracts with. The platform does not bundle a provider.

| Provider | Environment variable(s) | Optional overrides |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, `OPENAI_MODEL` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` |
| Google Gemini | `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`) | `GEMINI_BASE_URL`, `GEMINI_MODEL` |

- **Source of the value** — the provider's own console. The key must
  have access to the models the workspace will select.
- **Behaviour when unset** — the provider is reported as unconfigured
  and is not attempted. If no other provider is configured, generation
  routes return `503 llm_unconfigured`.
- **Verification** — run `POST /api/workflows/{id}/synthesize` and
  inspect the response's `llm.configuredProviders` array.

### 4.3 Local open-source models (Ollama or vLLM)

- **Environment variable(s)** — `OLLAMA_BASE_URL` (e.g.
  `http://127.0.0.1:11434`) and optionally `OLLAMA_MODEL`; or
  `VLLM_BASE_URL` (e.g. `http://127.0.0.1:8000/v1`) and optionally
  `VLLM_MODEL`.
- **Source of the value** — a locally-run Ollama or vLLM server. The
  operator provisions and runs it; there is no bundled model.
- **Behaviour when unset** — the local provider is reported as
  unconfigured and is not attempted.
- **Notes** — for a self-hosted deployment this is the default mode in
  the platform's design notes. The platform treats the endpoint as
  OpenAI-compatible; vLLM's `--served-model-name` must match the model
  the workspace selects.

### 4.4 Cost, cache and prompt versions

- **`LLM_MAX_RETRIES`** — defaults to `2`. Increase cautiously for a
  local provider whose cold start is slow.
- **Prompt versions** — the platform stores a registry of prompt
  versions in `packages/llm/src/promptVersions.ts`. Selecting a version
  is a runtime concern exposed via the synthesis route's
  `promptVersionId` body field; no environment variable is required
  unless you are A/B testing, in which case the A/B configuration lives
  in the database (see `packages/llm/src/abTest.ts`).

---

## 5. Local open-source processing services

The platform's OCR, layout/table parsing and speech-to-text pipelines
are backed by local open-source components or an HTTP service that
wraps them. Each is selected by an environment variable; the default is
"auto" for OCR and "none" for the others, meaning the corresponding
capability is not attempted when a service is not running.

### 5.1 OCR (EasyOCR / Tesseract / cloud)

- **Environment variable(s)** — `OCR_ENGINE` (`auto`, `easyocr`,
  `tesseract`, `cloud`), `PYTHON_PATH` (default `python3`),
  `OCR_SERVICE_URL` (an HTTP wrapper exposing a compatible API).
- **Source of the value** — a Python environment with EasyOCR or
  Tesseract installed, or a hosted OCR service the operator has
  configured an adapter for.
- **Behaviour when unset** — `auto` probes for a working engine at call
  time; when none is available the OCR step records the absence and the
  downstream step is reported as having no OCR output, not as having
  empty output. The routes that depend on OCR return a `503` naming
  `OCR_SERVICE_URL`.

### 5.2 Layout / table parsing (Docling + TableFormer)

- **Environment variable(s)** — `LAYOUT_ENGINE` (`docling` or `none`),
  `DOCLING_SERVICE_URL`.
- **Source of the value** — a running Docling service. The platform
  does not ship a Docling binary.
- **Behaviour when unset** — `LAYOUT_ENGINE=none` is the default. PDF
  layout-region detection and table-structure extraction are recorded
  as unavailable. Text-only PDF extraction continues via the fallback
  reader, and the absence of layout is reported in the extraction
  metadata rather than silently producing an empty region list.

### 5.3 Speech-to-text (Whisper family)

- **Environment variable(s)** — `STT_ENGINE` (`whisper-local`,
  `whisper-cpp`, `cloud`, `none`), `STT_SERVICE_URL`.
- **Behaviour when unset** — audio/video ingestion records the
  transcript as unavailable. The rest of the ingestion (frame sampling
  with OCR, for example) continues; the missing transcript is surfaced
  in the fused representation's notes.

---

## 6. Authentication and identity

### 6.1 Email/password (default)

- **Environment variable(s)** — `ALLOW_SIGNUP` (default `true`).
  Set `false` after the initial onboarding to close public sign-up.
- **Behaviour when unset** — public sign-up is enabled. This is
  appropriate for the initial install; disable it in production.

### 6.2 OAuth (Google, GitHub)

- **Environment variable(s)** — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`;
  `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
- **Source of the value** — Google Cloud Console / GitHub OAuth Apps.
  The redirect URI is `${PUBLIC_BASE_URL}/api/auth/oauth/<provider>/callback`.
- **Behaviour when unset** — the provider is not offered on the sign-in
  page. No error; the password flow continues to work.

### 6.3 SSO / SAML (enterprise)

The RBAC and workspace schema support SSO. The live SAML handshake is a
configuration path that requires a customer-supplied IdP; it is
documented here rather than silently enabled.

- **Environment variable(s)** — `SAML_ENTRY_POINT` (the IdP's SSO URL),
  `SAML_ISSUER` (the SP entity id the platform presents),
  `SAML_IDP_CERT` **or** `SAML_IDP_METADATA_URL` (the signing
  certificate, or a URL from which the platform fetches it).
- **Source of the value** — the customer's IdP (Okta, Entra ID,
  OneLogin, Ping, Google Workspace, etc.). The platform does not know
  your IdP's details.
- **Behaviour when unset** — the SAML provider is reported as
  unconfigured and is not offered on the sign-in page. If a request
  reaches a SAML route without a configured IdP the route returns
  `503` with the missing variable's name; the platform does not pretend
  to have authenticated the user.
- **Verification** — after configuring, the sign-in page offers the
  SAML provider, and signing in returns to `${PUBLIC_BASE_URL}/` with a
  session cookie set.

---

## 7. Email (SMTP)

- **Capability** — magic links, approval notifications, invites.
- **Environment variable(s)** — `SMTP_HOST`, `SMTP_PORT` (default
  `587`), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`.
- **Source of the value** — an SMTP relay (Postmark, SendGrid, Mailgun,
  SES SMTP, your own MTA). The platform does not bundle one.
- **Behaviour when unset** — `config.email.smtp.configured` is
  `false`. Routes that would send mail return `503` with the missing
  variable's name, and the review or invite action is recorded in the
  audit trail as a *requested but not delivered* event, so a human can
  act on it out of band.

---

## 8. Billing (Stripe)

- **Capability** — live charges. The plan model and usage metering are
  built into the platform and work without a payment gateway; only the
  actual charge surface is gated.
- **Environment variable(s)** — `STRIPE_SECRET_KEY`.
- **Source of the value** — Stripe Dashboard → Developers → API keys.
  Use a restricted key with the minimum scopes required for the
  operations you have enabled (subscriptions, customers, invoices).
- **Behaviour when unset** — `config.billing.liveChargesEnabled` is
  `false`. The billing routes return `503 payment_gateway_unconfigured`.
  Usage metering, plan limits and alerts continue to run: the platform
  can enforce a plan limit without ever charging a card.
- **Notes** — this project’s scope for the first phase excludes live
  charges; the plan model and metering are the deliverables. Configure
  a Stripe key when the customer decides to enable charging.

---

## 9. Integrations (Slack / Teams / Jira / Notion / Confluence / Zapier / Make)

Every integration in this section requires an application to be
registered with the target platform's developer programme, and a
customer to authorise it into their tenant. The platform ships the
adapter code and the webhook surfaces; it does **not** ship registered
applications. Provisioning a registered app is an external, per-customer
step that requires the platform operator's own application credentials
from each vendor.

### 9.1 Slack

- **Environment variable(s)** — `SLACK_CLIENT_ID`,
  `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`
  (single-workspace install), `SLACK_APP_TOKEN` (Sockets Mode, when
  used instead of an HTTP endpoint).
- **Source of the value** — the operator's Slack app (api.slack.com/apps),
  installed into the customer workspace.
- **Behaviour when unset** — the Slack adapter's constructor reports
  `configured: false`. Notifications fail with a `not-configured` error
  that names `SLACK_BOT_TOKEN`; they are not silently dropped.

### 9.2 Microsoft Teams

- **Environment variable(s)** — `TEAMS_CLIENT_ID`,
  `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID`,
  `TEAMS_INCOMING_WEBHOOK_URL` (simplest form: a per-channel webhook).
- **Source of the value** — Azure AD app registration plus an
  Incoming Webhook configured in Teams by the customer.
- **Behaviour when unset** — described as in Slack.

### 9.3 Atlassian (Jira / Confluence)

- **Environment variable(s)** — `ATLASSIAN_CLIENT_ID`,
  `ATLASSIAN_CLIENT_SECRET`, `ATLASSIAN_SCOPES` (space-separated),
  `ATLASSIAN_WEBHOOK_SECRET` (the shared secret used to verify inbound
  webhooks).
- **Source of the value** — the operator's Atlassian Connect app or
  OAuth 2.0 (3LO) integration, installed into the customer's site.
- **Behaviour when unset** — the Jira and Confluence adapters report
  `configured: false`. The publish routes return `not-configured` with
  the missing variable's name. Inbound Jira webhooks are refused (the
  shared secret is not configured to compare against), so an
  unauthenticated POST to the Jira trigger route is never accepted.

### 9.4 Notion

- **Environment variable(s)** — `NOTION_CLIENT_ID`,
  `NOTION_CLIENT_SECRET`, `NOTION_REDIRECT_URI`.
- **Source of the value** — the operator's Notion integration
  (notion.so/my-integrations), authorised by the customer into the
  destination workspace.
- **Behaviour when unset** — as above.

### 9.5 Zapier / Make (no-code integrations)

- **Environment variable(s)** — `ZAPIER_OUTBOUND_HOOK_URL` (the hook a
  customer configured to receive Zipy AI events), and
  `ZAPIER_INBOUND_SHARED_SECRET` (the shared secret the customer
  appended to their Zapier Catch Hook).
- **Source of the value** — the customer's Zap / Scenario configuration.
  There is no platform-wide default: each Zap has its own hook URL.
- **Behaviour when unset** — outbound events are refused with a
  `not-configured` error that names `ZAPIER_OUTBOUND_HOOK_URL`.
  Inbound triggers are refused because there is no shared secret to
  verify against. Neither path invents a hook URL.
- **Notes** — see the module comment in
  `packages/integrations/src/zapier.ts` for the full boundary. The
  platform does not publish a Zapier app; a customer authors Zaps
  against the descriptors the module exposes.

---

## 10. Outbound webhooks

- **Capability** — delivering platform events (`guide.published`,
  `review.requested`, `generation.completed`) to a customer-controlled
  HTTP endpoint.
- **Environment variable(s)** — `WEBHOOK_SIGNING_SECRET` (used to sign
  every delivery). `WEBHOOK_TIMEOUT_MS` (default `10000`),
  `WEBHOOK_MAX_ATTEMPTS` (default `5`).
- **Source of the value** — generate locally:
  `openssl rand -hex 32`. The customer receives the value out of band
  and configures its receiver to verify against it.
- **Behaviour when unset** — outbound deliveries are **refused, not
  sent unsigned**. The dispatch module throws `not-configured` naming
  `WEBHOOK_SIGNING_SECRET`. A receiver cannot accidentally accept an
  unauthenticated delivery from a deployment that forgot the secret.
- **Verification** — point a receiver you control at the deployment,
  configure a subscription, and observe the request carrying the
  signature and timestamp headers the receiver verifies against.

### 10.1 E2E receiver

The end-to-end test suite and the benchmark harness expect to observe
webhook deliveries when `ZIPY_E2E_WEBHOOK_RECEIVER` is set. The
receiver must:

- Accept POST requests at any path under its base URL.
- Record, for each delivery, the raw body and all headers, plus a
  `receivedAt` timestamp.
- Expose a `GET /_deliveries` endpoint returning
  `{ "deliveries": [ { "receivedAt": "...", "headers": {...}, "body": "..." } ] }`.

This is the contract the test suite documents. It is not a platform
capability; it is a contract for a receiver the operator writes.

---

## 11. Compliance and encryption

### 11.1 Per-workspace encryption at rest

- **Environment variable(s)** — `ENCRYPTION_MASTER_KEY`.
- **Source of the value** — generate locally:
  `openssl rand -hex 32`. Store it in the deployment's secret store,
  **not** in `.env` checked into version control. Rotating this key
  requires re-encrypting the affected rows; see
  `packages/security/src/encryption.ts` for the migration helper.
- **Behaviour when unset** — per-workspace encryption is not enabled.
  The app starts with a warning
  (`ENCRYPTION_MASTER_KEY is not set. Per-workspace encryption-at-rest
  cannot be enabled.`). Artifacts are stored unencrypted, which is
  acceptable only when the underlying storage is encrypted at rest
  (S3 with SSE, an encrypted Postgres volume).

### 11.2 Retention

- **Environment variable(s)** — `DEFAULT_RETENTION_DAYS` (default
  `180`). Per-workspace overrides are configurable through the admin
  UI and take precedence.
- **Behaviour when unset** — the platform default applies. `0` means
  retain indefinitely; document the choice in the deployment's privacy
  notice.

### 11.3 GDPR / CCPA data-subject flows

- **Capability** — export and deletion of a data subject's data.
- **Environment variable(s)** — none. The flows are exposed by the
  admin API and are permission-gated.
- **Behaviour when unset** — the flows work against persisted data.
  They rely on `DATABASE_URL` and (for artifact deletion) the storage
  driver's delete capability; a driver without delete permission will
  report the failure rather than silently leave data behind.

---

## 12. Browser automation

### 12.1 Playwright

- **Capability** — URL ingestion, workflow execution, screenshot
  capture.
- **Environment variable(s)** — `PLAYWRIGHT_BROWSER`
  (`chromium` | `firefox` | `webkit`; default `chromium`),
  `PLAYWRIGHT_HEADLESS` (default `true`),
  `PLAYWRIGHT_VIEWPORT_WIDTH` / `PLAYWRIGHT_VIEWPORT_HEIGHT` (default
  `1440`×`900`), `PLAYWRIGHT_DEVICE_SCALE` (default `2`),
  `PLAYWRIGHT_DEFAULT_TIMEOUT_MS` (default `15000`),
  `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` (default `45000`),
  `PLAYWRIGHT_MAX_CONTEXTS` (default `2`).
- **Source of the value** — the deployment's own choices. Playwright
  installs browsers on first use via `npx playwright install`.
- **Behaviour when unset** — the defaults above apply. If the browser
  binaries are not installed, Playwright fails with its own error at
  launch; the platform does not mask it.

### 12.2 Proxy rotation

- **Environment variable(s)** — `PLAYWRIGHT_PROXY_URL` (alias
  `PROXY_URL`).
- **Source of the value** — the operator's proxy provider.
- **Behaviour when unset** — no proxy is used. URL ingestion and
  workflow execution run from the platform's own egress IP.

---

## 13. Platform

### 13.1 `PUBLIC_BASE_URL`

- **Capability** — links in generated guides, webhook payloads, OAuth
  redirect URIs, and the Open Graph metadata on public guide pages.
- **Environment variable(s)** — `PUBLIC_BASE_URL`. Aliases: `APP_URL`,
  and on Replit, `REPLIT_DEV_DOMAIN` (the platform prefixes it with
  `https://` when it does not already start with a scheme).
- **Behaviour when unset** — defaults to `http://0.0.0.0:${PORT}`,
  which is not useful for email links or OAuth. Set it in production;
  the app warns when it starts with `http://` in production.

### 13.2 `CORS_ALLOWED_ORIGINS`

- **Capability** — cross-origin access to the REST API.
- **Environment variable(s)** — `CORS_ALLOWED_ORIGINS` (comma-separated).
- **Behaviour when unset** — production mode allows only
  `PUBLIC_BASE_URL`. Development mode also allows
  `http://0.0.0.0:${PORT}` and `http://localhost:${PORT}`. The value
  `*` is refused in production at startup.

---

## 14. Secrets handling

- Secrets are read from the process environment only. Do not commit
  them to a `.env` file that is checked in; Replit's secret manager (or
  your hosting platform's equivalent) is the right place.
- Rotate `SESSION_SECRET` and `WEBHOOK_SIGNING_SECRET` on a schedule
  appropriate to your threat model. Rotating `ENCRYPTION_MASTER_KEY`
  requires a re-encryption step.
- Every `not-configured` error surfaced by the platform names the missing
  environment variable. Treat each as a deployment checklist item, not
  as an incidental error.

---

## 15. What this document does *not* cover

- **Per-customer data setup** — brand assets, glossary terms,
  terminology lists, template library entries, and workspace members are
  configured through the UI or the REST API; they are not environment
  variables.
- **Legal review** — the platform generates disclaimers per content
  type, but the operator is responsible for confirming the wording
  their jurisdiction requires.
- **Model fine-tuning** — the platform's feedback loop produces
  correction data; turning that data into a fine-tuned model is an
  operator-side step that this document does not prescribe.
- **Regional data residency** — deploying Postgres, storage and the
  browser farm in a specific region is an infrastructure concern that
  the operator configures when choosing the platform. The code itself
  is region-agnostic.
