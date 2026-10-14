"use client";

/**
 * SourceIngestForm — the multi-modal entry surface for this phase.
 *
 * Two tabs, both wired to the routes delivered in this phase:
 *   - URL: POSTs { url, label } to /api/sources/url.
 *   - Text: POSTs { prompt, label, urlArtifactId } to /api/sources/text.
 *
 * Design notes:
 *  - This component talks only to the endpoints delivered in this phase. It
 *    does not pre-empt later phases (no image/PDF/DOCX/PPTX/audio upload UI,
 *    no review UI, no live job streaming).
 *  - Error and success responses include a `message` string from the server in
 *    every code path that can fail (validation, auth, queue). The UI displays
 *    that message verbatim; it never synthesises its own "success" copy when
 *    the server did not return one.
 *  - On 202, the returned `job.id` is surfaced so an operator can correlate a
 *    worker log line to the UI action. The URL-ingest variant additionally
 *    accepts an optional `prompt` field which is forwarded to the same URL job
 *    so the worker can attach a grounded text plan.
 *  - The component is deliberately framework-light: no design-system imports,
 *    inline styles only. It can be embedded in any page that renders under
 *    `apps/web/src/app`.
 */

import { useCallback, useMemo, useState } from "react";

type Tab = "url" | "text";

interface JobEnqueued {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly created: boolean;
  readonly idempotencyKey: string;
}

interface SuccessPayload {
  readonly job: JobEnqueued;
  readonly message?: string;
}

interface ErrorPayload {
  readonly error: string;
  readonly message: string;
  readonly field?: string;
}

interface FormState {
  readonly url: string;
  readonly urlLabel: string;
  readonly urlPrompt: string;
  readonly textPrompt: string;
  readonly textLabel: string;
  readonly urlArtifactId: string;
}

const INITIAL_STATE: FormState = {
  url: "",
  urlLabel: "",
  urlPrompt: "",
  textPrompt: "",
  textLabel: "",
  urlArtifactId: "",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function SourceIngestForm() {
  const [tab, setTab] = useState<Tab>("url");
  const [state, setState] = useState<FormState>(INITIAL_STATE);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [success, setSuccess] = useState<SuccessPayload | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);

  const update = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const urlValid = useMemo(() => {
    const raw = state.url.trim();
    if (raw.length === 0) return false;
    try {
      const u = new URL(raw);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, [state.url]);

  const urlArtifactValid = useMemo(() => {
    const raw = state.urlArtifactId.trim();
    if (raw.length === 0) return true; // optional
    return UUID_PATTERN.test(raw);
  }, [state.urlArtifactId]);

  const textValid = state.textPrompt.trim().length > 0;

  const submitUrl = useCallback(async () => {
    setSubmitting(true);
    setSuccess(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = { url: state.url.trim() };
      if (state.urlLabel.trim().length > 0) payload.label = state.urlLabel.trim();
      if (state.urlPrompt.trim().length > 0) payload.prompt = state.urlPrompt.trim();

      const res = await fetch("/api/sources/url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(normaliseError(json, `URL ingestion failed with HTTP ${res.status}.`));
        return;
      }
      if (!isSuccess(json)) {
        setError({
          error: "unexpected_response",
          message:
            "The server accepted the request but returned an unrecognised payload. Check server logs.",
        });
        return;
      }
      setSuccess(json);
    } catch (err) {
      setError({
        error: "network_error",
        message:
          err instanceof Error
            ? `Could not reach the server: ${err.message}`
            : "Could not reach the server.",
      });
    } finally {
      setSubmitting(false);
    }
  }, [state.url, state.urlLabel, state.urlPrompt]);

  const submitText = useCallback(async () => {
    setSubmitting(true);
    setSuccess(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        prompt: state.textPrompt.trim(),
      };
      if (state.textLabel.trim().length > 0) payload.label = state.textLabel.trim();
      if (state.urlArtifactId.trim().length > 0) {
        payload.urlArtifactId = state.urlArtifactId.trim();
      }

      const res = await fetch("/api/sources/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          normaliseError(json, `Text ingestion failed with HTTP ${res.status}.`),
        );
        return;
      }
      if (!isSuccess(json)) {
        setError({
          error: "unexpected_response",
          message:
            "The server accepted the request but returned an unrecognised payload. Check server logs.",
        });
        return;
      }
      setSuccess(json);
    } catch (err) {
      setError({
        error: "network_error",
        message:
          err instanceof Error
            ? `Could not reach the server: ${err.message}`
            : "Could not reach the server.",
      });
    } finally {
      setSubmitting(false);
    }
  }, [state.textPrompt, state.textLabel, state.urlArtifactId]);

  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) return;
      if (tab === "url") {
        if (!urlValid) return;
        void submitUrl();
      } else {
        if (!textValid || !urlArtifactValid) return;
        void submitText();
      }
    },
    [submitting, tab, urlValid, textValid, urlArtifactValid, submitUrl, submitText],
  );

  return (
    <section
      aria-labelledby="zipy-source-ingest-heading"
      style={cardStyle}
    >
      <h2
        id="zipy-source-ingest-heading"
        style={{ margin: 0, fontSize: 18, fontWeight: 600 }}
      >
        Add a source
      </h2>
      <p style={{ marginTop: 6, marginBottom: 16, color: "#475569", fontSize: 13 }}>
        Ingest a URL to capture its accessibility tree and interactive elements,
        or describe the workflow in plain language. The worker extracts structure
        asynchronously; the returned job id can be correlated with worker logs.
      </p>

      <div
        role="tablist"
        aria-label="Source type"
        style={{ display: "flex", gap: 4, marginBottom: 16 }}
      >
        <TabButton
          active={tab === "url"}
          onClick={() => setTab("url")}
          label="URL"
        />
        <TabButton
          active={tab === "text"}
          onClick={() => setTab("text")}
          label="Text prompt"
        />
      </div>

      <form onSubmit={onSubmit} noValidate>
        {tab === "url" && (
          <>
            <Field
              label="URL"
              required
              hint="Absolute http(s) URL. The worker loads it headlessly with Playwright."
            >
              <input
                type="url"
                name="url"
                autoComplete="off"
                inputMode="url"
                placeholder="https://app.example.com/customers"
                required
                value={state.url}
                onChange={(e) => update("url", e.target.value)}
                disabled={submitting}
                style={inputStyle}
                aria-invalid={state.url.length > 0 && !urlValid}
              />
            </Field>
            <Field label="Label" hint="Optional. Shown in the sources list.">
              <input
                type="text"
                name="urlLabel"
                autoComplete="off"
                value={state.urlLabel}
                onChange={(e) => update("urlLabel", e.target.value)}
                disabled={submitting}
                style={inputStyle}
              />
            </Field>
            <Field
              label="Prompt (optional)"
              hint="Natural-language description of the goal, e.g. “Create a new customer with name Jane Doe”."
            >
              <textarea
                name="urlPrompt"
                rows={4}
                value={state.urlPrompt}
                onChange={(e) => update("urlPrompt", e.target.value)}
                disabled={submitting}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </Field>
            <SubmitButton
              disabled={!urlValid || submitting}
              submitting={submitting}
              label="Enqueue URL ingestion"
            />
          </>
        )}

        {tab === "text" && (
          <>
            <Field
              label="Prompt"
              required
              hint="Describe the workflow in plain language. The worker extracts the goal, entities and ordered sub-tasks."
            >
              <textarea
                name="textPrompt"
                rows={6}
                required
                value={state.textPrompt}
                onChange={(e) => update("textPrompt", e.target.value)}
                disabled={submitting}
                style={{ ...inputStyle, resize: "vertical" }}
                aria-invalid={state.textPrompt.length > 0 && !textValid}
              />
            </Field>
            <Field label="Label" hint="Optional. Shown in the sources list.">
              <input
                type="text"
                name="textLabel"
                autoComplete="off"
                value={state.textLabel}
                onChange={(e) => update("textLabel", e.target.value)}
                disabled={submitting}
                style={inputStyle}
              />
            </Field>
            <Field
              label="Ground against URL artifact id (optional)"
              hint="UUID of a previously-ingested URL artifact. When supplied, the worker attaches candidate element refs from that page’s index."
            >
              <input
                type="text"
                name="urlArtifactId"
                autoComplete="off"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={state.urlArtifactId}
                onChange={(e) => update("urlArtifactId", e.target.value)}
                disabled={submitting}
                style={inputStyle}
                aria-invalid={!urlArtifactValid}
              />
            </Field>
            <SubmitButton
              disabled={!textValid || !urlArtifactValid || submitting}
              submitting={submitting}
              label="Enqueue text ingestion"
            />
          </>
        )}
      </form>

      {error !== null && (
        <div role="alert" style={errorStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            {error.error}
          </strong>
          <span>{error.message}</span>
          {typeof error.field === "string" && (
            <span style={{ marginLeft: 6, color: "#7f1d1d" }}>
              (field: {error.field})
            </span>
          )}
        </div>
      )}

      {success !== null && (
        <div role="status" style={successStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            {success.job.created ? "Job enqueued" : "Existing job reused"}
          </strong>
          <div style={{ fontSize: 13 }}>
            <div>
              <span style={metaLabelStyle}>Job id:</span>{" "}
              <code style={monoStyle}>{success.job.id}</code>
            </div>
            <div>
              <span style={metaLabelStyle}>Kind:</span>{" "}
              <code style={monoStyle}>{success.job.kind}</code>
            </div>
            <div>
              <span style={metaLabelStyle}>Status:</span>{" "}
              <code style={monoStyle}>{success.job.status}</code>
            </div>
            <div>
              <span style={metaLabelStyle}>Idempotency key:</span>{" "}
              <code style={monoStyle}>{success.job.idempotencyKey}</code>
            </div>
            {typeof success.message === "string" && (
              <p style={{ marginTop: 8, marginBottom: 0, color: "#166534" }}>
                {success.message}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Subcomponents                                                               */
/* -------------------------------------------------------------------------- */

interface TabButtonProps {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
}

function TabButton({ active, label, onClick }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: "6px 12px",
        fontSize: 13,
        borderRadius: 6,
        border: "1px solid",
        borderColor: active ? "#1d4ed8" : "#cbd5e1",
        background: active ? "#eff6ff" : "#ffffff",
        color: active ? "#1d4ed8" : "#334155",
        cursor: "pointer",
        fontWeight: active ? 600 : 500,
      }}
    >
      {label}
    </button>
  );
}

interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly children: React.ReactNode;
}

function Field({ label, hint, required, children }: FieldProps) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 500,
          color: "#0f172a",
          marginBottom: 4,
        }}
      >
        {label}
        {required === true && (
          <span style={{ color: "#b91c1c", marginLeft: 4 }} aria-hidden="true">
            *
          </span>
        )}
      </span>
      {children}
      {typeof hint === "string" && hint.length > 0 && (
        <span
          style={{
            display: "block",
            fontSize: 12,
            color: "#64748b",
            marginTop: 4,
          }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

interface SubmitButtonProps {
  readonly disabled: boolean;
  readonly submitting: boolean;
  readonly label: string;
}

function SubmitButton({ disabled, submitting, label }: SubmitButtonProps) {
  return (
    <button
      type="submit"
      disabled={disabled}
      style={{
        marginTop: 4,
        padding: "8px 16px",
        fontSize: 14,
        fontWeight: 600,
        borderRadius: 6,
        border: "1px solid #1d4ed8",
        background: disabled ? "#93c5fd" : "#1d4ed8",
        color: "#ffffff",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {submitting ? "Submitting…" : label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Response helpers                                                            */
/* -------------------------------------------------------------------------- */

function isSuccess(value: unknown): value is SuccessPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const job = v["job"];
  if (job === null || typeof job !== "object") return false;
  const j = job as Record<string, unknown>;
  return (
    typeof j["id"] === "string" &&
    typeof j["kind"] === "string" &&
    typeof j["status"] === "string" &&
    typeof j["created"] === "boolean"
  );
}

function normaliseError(value: unknown, fallback: string): ErrorPayload {
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const code = typeof v["error"] === "string" ? v["error"] : "request_failed";
    const message =
      typeof v["message"] === "string" && v["message"].length > 0
        ? v["message"]
        : fallback;
    const field = typeof v["field"] === "string" ? v["field"] : undefined;
    return field !== undefined
      ? { error: code, message, field }
      : { error: code, message };
  }
  return { error: "request_failed", message: fallback };
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const cardStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
  maxWidth: 640,
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  fontSize: 14,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  boxSizing: "border-box",
};

const errorStyle: React.CSSProperties = {
  marginTop: 16,
  padding: "10px 12px",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
  fontSize: 13,
};

const successStyle: React.CSSProperties = {
  marginTop: 16,
  padding: "10px 12px",
  border: "1px solid #bbf7d0",
  borderRadius: 6,
  background: "#f0fdf4",
  color: "#14532d",
  fontSize: 13,
};

const metaLabelStyle: React.CSSProperties = {
  display: "inline-block",
  minWidth: 120,
  color: "#166534",
};

const monoStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
};
