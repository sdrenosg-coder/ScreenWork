# Zipy AI — On-premise deployment operations

This document describes how to run Zipy AI on a customer-controlled host
(bare metal, a private VM, or a customer-managed Kubernetes cluster) instead
of the managed cloud deployment. It is written for the operator who is
responsible for the running service; it does not assume any cloud-specific
service is available.

The on-prem path shares the same code and schema as the cloud path. There is
no "on-prem build". The differences are entirely in which dependencies the
operator supplies and which deployment wiring the operator writes.

---

## 1. What the operator must supply

Nothing in this repository invents credentials. Every external dependency
is either optional (the platform degrades with a clear error) or a
customer-supplied configuration that must be present before the dependent
feature is usable.

### 1.1 Required for any on-prem install

| Capability              | Environment variable(s)                                          | Notes |
|-------------------------|------------------------------------------------------------------|-------|
| Postgres 16 + pgvector  | `DATABASE_URL`                                                   | The schema uses `vector` columns and `pg_trgm`. Run `npm run migrate` after the database is reachable. |
| Session secret          | `SESSION_SECRET`                                                 | ≥ 32 random characters. Generate with `openssl rand -hex 32`. The web app refuses to boot without it. |
| Public base URL         | `PUBLIC_BASE_URL`                                                | Absolute https URL an end user can reach. Used for links, Open Graph tags, signed webhook URLs and the public guide pages. |
| Storage driver          | `STORAGE_DRIVER` (`local` or `s3`)                               | `local` writes to `STORAGE_LOCAL_ROOT`; `s3` requires the four S3_* values in §1.4. |
| At least one LLM provider | `LLM_DEFAULT_PROVIDER` + one of: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_BASE_URL`, `VLLM_BASE_URL` | The generation and synthesis features fail with HTTP 503 (`llm_unconfigured`) when none is configured. See §3. |

### 1.2 Required for browser automation (URL ingestion, workflow execution)

Zipy AI uses Playwright. On-prem, the operator must install the browser
binaries once per host:
