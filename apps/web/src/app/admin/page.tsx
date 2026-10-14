"use client";

/**
 * Zipy AI — workspace administration surface (phase 22, batch 2).
 *
 * Scope of this page:
 *   - Retention policy: read + update the workspace compliance record through
 *     `/api/admin/retention` so operators can set artifact/guide/log retention
 *     windows and dry-run the sweep.
 *   - Audit log: query `/api/admin/audit` with pagination and filters, show IP,
 *     user, action, target and timestamp for each entry.
 *
 * Deliberate non-goals (documented, not stubbed):
 *   - This page does not perform SSO/SAML login. SAML is handled by the auth
 *     surface; the page read-only displays whether an IdP is configured via the
 *     server's public config.
 *   - It does not run GDPR data-subject exports or deletions itself — those are
 *     executed by the security package's gdpr module and surfaced on the
 *     workspace-scoped member view. The admin page links to that surface.
 *   - It does not read or write audit logs directly. Every read is a signed,
 *     session-authenticated request against the audit API, so the page cannot
 *     show anything a caller is not authorized to see.
 *
 * Wire contract (owned by the batch-2 routes):
 *   GET  /api/admin/retention     -> 200 RestentionView | 4xx {error,message,field?}
 *   PUT  /api/admin/retention     -> 200 RestentionView
 *                                    body: { artifactDays?, guideDays?, logDays?, dryRun? }
 *   GET  /api/admin/audit?cursor=&limit=&action=&actorId=&from=&to=
 *                                 -> 200 { entries, nextCursor, total, message, notes[] }
 *
 * The page never assumes a value: every field it renders is either echoed by
 * the server or shown as "not configured".
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

export interface RetentionView {
  readonly workspaceId: string;
  readonly artifactDays: number;
  readonly guideDays: number;
  readonly logDays: number;
  readonly lastSweepAt: string | null;
  readonly lastSweep: {
    readonly deletedArtifacts: number;
    readonly deletedGuides: number;
    readonly deletedLogs: number;
    readonly dryRun: boolean;
    readonly ranAt: string;
  } | null;
  readonly encryption: {
    readonly atRestConfigured: boolean;
    readonly keyVersion: string | null;
    readonly algorithm: string;
  };
  readonly message: string;
  readonly notes: readonly string[];
}

export interface AuditEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly actorId: string | null;
  readonly actorDisplay: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly at: string;
  readonly outcome: "allowed" | "denied" | "error" | "unknown";
  readonly detail: string | null;
}

export interface AuditPage {
  readonly entries: readonly AuditEntry[];
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly message: string;
  readonly notes: readonly string[];
}

interface ApiError {
  readonly error: string;
  readonly message: string;
  readonly field?: string;
}

type Load<T> =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "error"; readonly error: ApiError };

interface Outcome {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
  readonly details: readonly string[];
}

interface AuditState {
  readonly entries: readonly AuditEntry[];
  readonly nextCursor: string | null;
  readonly total: number | null;
  readonly loading: boolean;
  readonly loadedOnce: boolean;
  readonly error: ApiError | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUDIT_PAGE_SIZE = 50;

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function AdminPage() {
  const [retention, setRetention] = useState<Load<RetentionView>>({
    kind: "idle",
  });
  const [savingRetention, setSavingRetention] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const [audit, setAudit] = useState<AuditState>({
    entries: [],
    nextCursor: null,
    total: null,
    loading: false,
    loadedOnce: false,
    error: null,
  });
  const [auditFilters, setAuditFilters] = useState<{
    readonly action: string;
    readonly actorId: string;
    readonly from: string;
    readonly to: string;
  }>({ action: "", actorId: "", from: "", to: "" });

  const requestedOnceRef = useRef(false);

  /* ------------------------------ retention ------------------------------- */

  const loadRetention = useCallback(async (signal: AbortSignal): Promise<void> => {
    setRetention((prev) =>
      prev.kind === "ready" ? prev : { kind: "loading" },
    );
    try {
      const res = await fetch("/api/admin/retention", {
        signal,
        headers: { accept: "application/json" },
      });
      const json: unknown = await res.json().catch(() => null);
      if (signal.aborted) return;
      if (!res.ok) {
        setRetention({
          kind: "error",
          error: normaliseError(json, `Request failed with HTTP ${res.status}.`),
        });
        return;
      }
      const parsed = parseRetentionView(json);
      if (parsed === null) {
        setRetention({
          kind: "error",
          error: {
            error: "unexpected_response",
            message:
              "The server returned a retention payload this page does not recognise. Check server logs.",
          },
        });
        return;
      }
      setRetention({ kind: "ready", data: parsed });
    } catch (err) {
      if (signal.aborted) return;
      setRetention({
        kind: "error",
        error: {
          error: "network_error",
          message:
            err instanceof Error
              ? `Could not reach the server: ${err.message}`
              : "Could not reach the server.",
        },
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadRetention(controller.signal);
    return () => controller.abort();
  }, [loadRetention]);

  const updateRetention = useCallback(
    async (
      body: Readonly<{
        artifactDays?: number;
        guideDays?: number;
        logDays?: number;
        dryRun?: boolean;
      }>,
    ): Promise<void> => {
      setSavingRetention(true);
      setOutcome(null);
      try {
        const res = await fetch("/api/admin/retention", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const err = normaliseError(
            json,
            `Update failed with HTTP ${res.status}.`,
          );
          setOutcome({
            kind: "error",
            message: `${err.error}: ${err.message}`,
            details: err.field !== undefined ? [`field: ${err.field}`] : [],
          });
          return;
        }
        const parsed = parseRetentionView(json);
        if (parsed === null) {
          setOutcome({
            kind: "error",
            message:
              "The server accepted the change but returned an unrecognised payload. Refresh to confirm.",
            details: [],
          });
          return;
        }
        setRetention({ kind: "ready", data: parsed });
        setOutcome({
          kind: "success",
          message: parsed.message,
          details: [
            `artifacts: ${parsed.artifactDays}d`,
            `guides: ${parsed.guideDays}d`,
            `logs: ${parsed.logDays}d`,
            ...parsed.notes,
          ],
        });
      } catch (err) {
        setOutcome({
          kind: "error",
          message:
            err instanceof Error
              ? `Could not reach the server: ${err.message}`
              : "Could not reach the server.",
          details: [],
        });
      } finally {
        setSavingRetention(false);
      }
    },
    [],
  );

  /* --------------------------------- audit -------------------------------- */

  const buildAuditUrl = useCallback(
    (cursor: string | null): string => {
      const sp = new URLSearchParams();
      sp.set("limit", String(AUDIT_PAGE_SIZE));
      if (cursor !== null) sp.set("cursor", cursor);
      if (auditFilters.action.trim().length > 0) {
        sp.set("action", auditFilters.action.trim());
      }
      if (auditFilters.actorId.trim().length > 0) {
        sp.set("actorId", auditFilters.actorId.trim());
      }
      if (auditFilters.from.trim().length > 0) {
        sp.set("from", auditFilters.from.trim());
      }
      if (auditFilters.to.trim().length > 0) {
        sp.set("to", auditFilters.to.trim());
      }
      return `/api/admin/audit?${sp.toString()}`;
    },
    [auditFilters],
  );

  const loadAuditPage = useCallback(
    async (cursor: string | null): Promise<void> => {
      setAudit((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const res = await fetch(buildAuditUrl(cursor), {
          headers: { accept: "application/json" },
        });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          setAudit((prev) => ({
            ...prev,
            loading: false,
            loadedOnce: true,
            error: normaliseError(
              json,
              `Audit request failed with HTTP ${res.status}.`,
            ),
          }));
          return;
        }
        const parsed = parseAuditPage(json);
        if (parsed === null) {
          setAudit((prev) => ({
            ...prev,
            loading: false,
            loadedOnce: true,
            error: {
              error: "unexpected_response",
              message:
                "The server returned an audit payload this page does not recognise. Check server logs.",
            },
          }));
          return;
        }
        setAudit((prev) => ({
          entries:
            cursor === null
              ? parsed.entries
              : [...prev.entries, ...parsed.entries],
          nextCursor: parsed.nextCursor,
          total: parsed.total,
          loading: false,
          loadedOnce: true,
          error: null,
        }));
      } catch (err) {
        setAudit((prev) => ({
          ...prev,
          loading: false,
          loadedOnce: true,
          error: {
            error: "network_error",
            message:
              err instanceof Error
                ? `Could not reach the server: ${err.message}`
                : "Could not reach the server.",
          },
        }));
      }
    },
    [buildAuditUrl],
  );

  useEffect(() => {
    if (requestedOnceRef.current) return;
    requestedOnceRef.current = true;
    void loadAuditPage(null);
    // loadAuditPage is stable because buildAuditUrl depends only on filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = useCallback(
    (e: React.FormEvent<HTMLFormElement>): void => {
      e.preventDefault();
      void loadAuditPage(null);
    },
    [loadAuditPage],
  );

  const clearFilters = useCallback((): void => {
    setAuditFilters({ action: "", actorId: "", from: "", to: "" });
  }, []);

  /* -------------------------------- derived ------------------------------- */

  const retentionView = retention.kind === "ready" ? retention.data : null;

  const totalPages = useMemo(() => {
    if (audit.total === null) return null;
    return Math.ceil(audit.total / AUDIT_PAGE_SIZE);
  }, [audit.total]);

  /* -------------------------------- render -------------------------------- */

  return (
    <main style={pageStyle}>
      <nav style={breadcrumbStyle} aria-label="Breadcrumb">
        <Link href="/dashboard" style={linkStyle}>
          Dashboard
        </Link>
        <span aria-hidden="true">›</span>
        <span style={{ color: "#0f172a", fontWeight: 500 }}>Admin</span>
      </nav>

      <header style={{ margin: "8px 0 20px" }}>
        <h1 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 700 }}>
          Workspace administration
        </h1>
        <p style={{ margin: 0, color: "#475569", fontSize: 13 }}>
          Retention policy, audit trail and security posture for the active
          workspace. All reads and writes are session-authenticated and
          permission-checked server-side.
        </p>
      </header>

      {/* --------------------------- retention ------------------------------- */}

      <section
        style={cardStyle}
        aria-labelledby="zipy-retention-heading"
      >
        <header style={headerRowStyle}>
          <div>
            <h2
              id="zipy-retention-heading"
              style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
            >
              Retention policy
            </h2>
            <p style={{ margin: "2px 0 0", color: "#475569", fontSize: 12 }}>
              Artifacts, guides and audit logs are deleted after the configured
              window. Sweeps run on the worker schedule; you can also request a
              dry-run from here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadRetention(new AbortController().signal)}
            disabled={retention.kind === "loading"}
            style={linkButtonStyle}
          >
            {retention.kind === "loading" ? "Loading…" : "Reload"}
          </button>
        </header>

        {retention.kind === "idle" || retention.kind === "loading" ? (
          <p style={mutedStyle}>Loading retention policy…</p>
        ) : retention.kind === "error" ? (
          <div role="alert" style={errorStyle}>
            <strong style={{ display: "block", marginBottom: 4 }}>
              {retention.error.error}
            </strong>
            <span>{retention.error.message}</span>
          </div>
        ) : (
          <RetentionEditor
            view={retention.data}
            busy={savingRetention}
            onSubmit={updateRetention}
          />
        )}
      </section>

      {/* ------------------------------ audit -------------------------------- */}

      <section
        style={{ ...cardStyle, marginTop: 16 }}
        aria-labelledby="zipy-audit-heading"
      >
        <header style={headerRowStyle}>
          <div>
            <h2
              id="zipy-audit-heading"
              style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
            >
              Audit log
            </h2>
            <p style={{ margin: "2px 0 0", color: "#475569", fontSize: 12 }}>
              Every allowed, denied and failed action is recorded with actor,
              IP, user agent and timestamp.
            </p>
          </div>
          {totalPages !== null && (
            <span style={{ fontSize: 12, color: "#475569" }}>
              {audit.total} entr{audit.total === 1 ? "y" : "ies"} ·{" "}
              {totalPages} page{totalPages === 1 ? "" : "s"}
            </span>
          )}
        </header>

        <form onSubmit={applyFilters} style={filterRowStyle}>
          <label style={filterFieldStyle}>
            <span style={filterLabelStyle}>Action</span>
            <input
              type="text"
              value={auditFilters.action}
              onChange={(e) =>
                setAuditFilters((p) => ({ ...p, action: e.target.value }))
              }
              placeholder="e.g. guide.publish"
              style={inputStyle}
              maxLength={120}
            />
          </label>
          <label style={filterFieldStyle}>
            <span style={filterLabelStyle}>Actor id</span>
            <input
              type="text"
              value={auditFilters.actorId}
              onChange={(e) =>
                setAuditFilters((p) => ({ ...p, actorId: e.target.value }))
              }
              placeholder="UUID or blank"
              style={inputStyle}
              maxLength={64}
            />
          </label>
          <label style={filterFieldStyle}>
            <span style={filterLabelStyle}>From</span>
            <input
              type="datetime-local"
              value={auditFilters.from}
              onChange={(e) =>
                setAuditFilters((p) => ({ ...p, from: e.target.value }))
              }
              style={inputStyle}
            />
          </label>
          <label style={filterFieldStyle}>
            <span style={filterLabelStyle}>To</span>
            <input
              type="datetime-local"
              value={auditFilters.to}
              onChange={(e) =>
                setAuditFilters((p) => ({ ...p, to: e.target.value }))
              }
              style={inputStyle}
            />
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <button
              type="submit"
              disabled={audit.loading}
              style={primaryButtonStyle(audit.loading)}
            >
              {audit.loading ? "Querying…" : "Apply"}
            </button>
            <button
              type="button"
              onClick={() => {
                clearFilters();
                void loadAuditPage(null);
              }}
              disabled={audit.loading}
              style={secondaryButtonStyle(audit.loading)}
            >
              Reset
            </button>
          </div>
        </form>

        {audit.error !== null && (
          <div role="alert" style={errorStyle}>
            <strong style={{ display: "block", marginBottom: 4 }}>
              {audit.error.error}
            </strong>
            <span>{audit.error.message}</span>
          </div>
        )}

        {!audit.loadedOnce && audit.loading ? (
          <p style={mutedStyle}>Loading audit entries…</p>
        ) : audit.entries.length === 0 && !audit.loading ? (
          <p style={mutedStyle}>
            No audit entries match the current filters.
          </p>
        ) : (
          <ul style={listStyle}>
            {audit.entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}

        {audit.nextCursor !== null && (
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={() => void loadAuditPage(audit.nextCursor)}
              disabled={audit.loading}
              style={secondaryButtonStyle(audit.loading)}
            >
              {audit.loading ? "Loading more…" : "Load more"}
            </button>
          </div>
        )}
      </section>

      {/* ----------------------- security posture ---------------------------- */}

      {retentionView !== null && (
        <section
          style={{ ...cardStyle, marginTop: 16 }}
          aria-labelledby="zipy-security-heading"
        >
          <header style={headerRowStyle}>
            <h2
              id="zipy-security-heading"
              style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
            >
              Security posture
            </h2>
          </header>
          <div style={metaGridStyle}>
            <Meta
              label="Encryption at rest"
              value={
                retentionView.encryption.atRestConfigured
                  ? `${retentionView.encryption.algorithm}${retentionView.encryption.keyVersion !== null ? ` · key ${retentionView.encryption.keyVersion}` : ""}`
                  : "not configured — set ENCRYPTION_MASTER_KEY"
              }
            />
            <Meta
              label="Last sweep"
              value={
                retentionView.lastSweep === null
                  ? "never run"
                  : `${formatIso(retentionView.lastSweep.ranAt)} (deleted ${retentionView.lastSweep.deletedArtifacts} artifacts, ${retentionView.lastSweep.deletedGuides} guides, ${retentionView.lastSweep.deletedLogs} log entries${retentionView.lastSweep.dryRun ? ", dry run" : ""})`
              }
            />
            <Meta
              label="Data-subject requests"
              value="Handled through the workspace member surface; this page does not perform exports or deletions"
            />
            <Meta
              label="SSO / SAML"
              value="Configured by the deployment operator via SAML_ENTRY_POINT and SAML_IDP_CERT; see the operations docs"
            />
          </div>
          {retentionView.notes.length > 0 && (
            <ul style={{ ...listStyle, marginTop: 8 }}>
              {retentionView.notes.map((n, i) => (
                <li key={i} style={{ fontSize: 12, color: "#475569" }}>
                  {n}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {outcome !== null && (
        <div
          role={outcome.kind === "error" ? "alert" : "status"}
          style={
            outcome.kind === "error"
              ? errorStyle
              : outcome.kind === "info"
                ? infoStyle
                : successStyle
          }
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            {outcome.kind === "error"
              ? "Update failed"
              : outcome.kind === "info"
                ? "No change made"
                : "Update accepted"}
          </strong>
          <span>{outcome.message}</span>
          {outcome.details.length > 0 && (
            <ul style={{ margin: "6px 0 0 16px", padding: 0, fontSize: 12 }}>
              {outcome.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Subcomponents                                                               */
/* -------------------------------------------------------------------------- */

function RetentionEditor({
  view,
  busy,
  onSubmit,
}: {
  readonly view: RetentionView;
  readonly busy: boolean;
  readonly onSubmit: (
    body: Readonly<{
      artifactDays?: number;
      guideDays?: number;
      logDays?: number;
      dryRun?: boolean;
    }>,
  ) => Promise<void>;
}) {
  const [artifactDays, setArtifactDays] = useState(String(view.artifactDays));
  const [guideDays, setGuideDays] = useState(String(view.guideDays));
  const [logDays, setLogDays] = useState(String(view.logDays));
  const [dryRun, setDryRun] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // If the server view changed (e.g. after a successful update) reset local
  // inputs to the authoritative values.
  useEffect(() => {
    setArtifactDays(String(view.artifactDays));
    setGuideDays(String(view.guideDays));
    setLogDays(String(view.logDays));
  }, [view.artifactDays, view.guideDays, view.logDays]);

  const parseDays = (
    raw: string,
    label: string,
  ): number | { readonly error: string } => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { error: `${label} is required.` };
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      return {
        error: `${label} must be an integer between 1 and 3650 days.`,
      };
    }
    return n;
  };

  const submit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setLocalError(null);
    const a = parseDays(artifactDays, "Artifact retention");
    if (typeof a !== "number") {
      setLocalError(a.error);
      return;
    }
    const g = parseDays(guideDays, "Guide retention");
    if (typeof g !== "number") {
      setLocalError(g.error);
      return;
    }
    const l = parseDays(logDays, "Log retention");
    if (typeof l !== "number") {
      setLocalError(l.error);
      return;
    }
    void onSubmit({
      artifactDays: a,
      guideDays: g,
      logDays: l,
      dryRun,
    });
  };

  return (
    <form onSubmit={submit}>
      <div style={fieldRowStyle}>
        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>Artifact retention (days)</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={artifactDays}
            onChange={(e) => setArtifactDays(e.target.value)}
            style={inputStyle}
            disabled={busy}
          />
        </label>
        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>Guide retention (days)</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={guideDays}
            onChange={(e) => setGuideDays(e.target.value)}
            style={inputStyle}
            disabled={busy}
          />
        </label>
        <label style={fieldStyle}>
          <span style={fieldLabelStyle}>Audit log retention (days)</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={logDays}
            onChange={(e) => setLogDays(e.target.value)}
            style={inputStyle}
            disabled={busy}
          />
        </label>
      </div>

      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={dryRun}
          disabled={busy}
          onChange={(e) => setDryRun(e.target.checked)}
        />
        <span style={{ fontSize: 13 }}>
          Dry run — record what a sweep would delete without deleting.
        </span>
      </label>

      {localError !== null && (
        <div role="alert" style={errorStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            validation_error
          </strong>
          <span>{localError}</span>
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <button type="submit" disabled={busy} style={primaryButtonStyle(busy)}>
          {busy
            ? dryRun
              ? "Running dry sweep…"
              : "Saving…"
            : dryRun
              ? "Save and record a dry sweep"
              : "Save retention policy"}
        </button>
      </div>
    </form>
  );
}

function AuditRow({ entry }: { readonly entry: AuditEntry }) {
  return (
    <li style={auditRowStyle}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span style={outcomeBadgeStyle(entry.outcome)}>{entry.outcome}</span>
        <code style={monoStyle}>{entry.action}</code>
        <span style={{ fontSize: 12, color: "#0f172a", fontWeight: 600 }}>
          {formatIso(entry.at)}
        </span>
        {entry.actorDisplay !== null ? (
          <span style={{ fontSize: 12, color: "#475569" }}>
            by {entry.actorDisplay}
          </span>
        ) : entry.actorId !== null ? (
          <span style={{ fontSize: 12, color: "#475569" }}>
            by <code style={monoStyle}>{entry.actorId}</code>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#64748b" }}>
            actor unknown
          </span>
        )}
      </div>
      {(entry.targetType !== null || entry.targetId !== null) && (
        <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
          Target:{" "}
          {entry.targetType !== null ? (
            <code style={monoStyle}>{entry.targetType}</code>
          ) : (
            "(unnamed)"
          )}{" "}
          {entry.targetId !== null && (
            <code style={monoStyle}>{entry.targetId}</code>
          )}
        </div>
      )}
      {entry.ip !== null && (
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
          IP: <code style={monoStyle}>{entry.ip}</code>
        </div>
      )}
      {entry.userAgent !== null && (
        <div style={{ fontSize: 11, color: "#64748b" }}>
          UA: {entry.userAgent}
        </div>
      )}
      {entry.detail !== null && (
        <pre style={preStyle}>{entry.detail}</pre>
      )}
    </li>
  );
}

function Meta({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <div style={{ color: "#64748b", fontSize: 11 }}>{label}</div>
      <div style={{ color: "#0f172a", fontSize: 12, fontWeight: 500 }}>
        {value}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function parseRetentionView(value: unknown): RetentionView | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["workspaceId"] !== "string" ||
    typeof v["artifactDays"] !== "number" ||
    typeof v["guideDays"] !== "number" ||
    typeof v["logDays"] !== "number" ||
    typeof v["message"] !== "string" ||
    !isStringArray(v["notes"])
  ) {
    return null;
  }
  const encRaw = v["encryption"];
  const encryption =
    encRaw !== null && typeof encRaw === "object"
      ? {
          atRestConfigured:
            (encRaw as Record<string, unknown>)["atRestConfigured"] === true,
          keyVersion:
            typeof (encRaw as Record<string, unknown>)["keyVersion"] === "string"
              ? ((encRaw as Record<string, unknown>)["keyVersion"] as string)
              : null,
          algorithm:
            typeof (encRaw as Record<string, unknown>)["algorithm"] === "string"
              ? ((encRaw as Record<string, unknown>)["algorithm"] as string)
              : "AES-256-GCM",
        }
      : { atRestConfigured: false, keyVersion: null, algorithm: "AES-256-GCM" };

  let lastSweep: RetentionView["lastSweep"] = null;
  const lsRaw = v["lastSweep"];
  if (lsRaw !== null && typeof lsRaw === "object") {
    const ls = lsRaw as Record<string, unknown>;
    if (
      typeof ls["deletedArtifacts"] === "number" &&
      typeof ls["deletedGuides"] === "number" &&
      typeof ls["deletedLogs"] === "number" &&
      typeof ls["ranAt"] === "string"
    ) {
      lastSweep = {
        deletedArtifacts: Math.trunc(ls["deletedArtifacts"]),
        deletedGuides: Math.trunc(ls["deletedGuides"]),
        deletedLogs: Math.trunc(ls["deletedLogs"]),
        dryRun: ls["dryRun"] === true,
        ranAt: ls["ranAt"],
      };
    }
  }

  const lastSweepAt =
    typeof v["lastSweepAt"] === "string" ? v["lastSweepAt"] : null;

  return {
    workspaceId: v["workspaceId"],
    artifactDays: Math.trunc(v["artifactDays"]),
    guideDays: Math.trunc(v["guideDays"]),
    logDays: Math.trunc(v["logDays"]),
    lastSweepAt,
    lastSweep,
    encryption,
    message: v["message"],
    notes: v["notes"],
  };
}

function parseAuditEntry(value: unknown): AuditEntry | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["id"] !== "string" ||
    typeof v["workspaceId"] !== "string" ||
    typeof v["action"] !== "string" ||
    typeof v["at"] !== "string"
  ) {
    return null;
  }
  const outcomeRaw = v["outcome"];
  const outcome: AuditEntry["outcome"] =
    outcomeRaw === "allowed" ||
    outcomeRaw === "denied" ||
    outcomeRaw === "error"
      ? outcomeRaw
      : "unknown";
  return {
    id: v["id"],
    workspaceId: v["workspaceId"],
    actorId: typeof v["actorId"] === "string" ? v["actorId"] : null,
    actorDisplay:
      typeof v["actorDisplay"] === "string" ? v["actorDisplay"] : null,
    action: v["action"],
    targetType:
      typeof v["targetType"] === "string" ? v["targetType"] : null,
    targetId: typeof v["targetId"] === "string" ? v["targetId"] : null,
    ip: typeof v["ip"] === "string" ? v["ip"] : null,
    userAgent:
      typeof v["userAgent"] === "string" ? v["userAgent"] : null,
    at: v["at"],
    outcome,
    detail: typeof v["detail"] === "string" ? v["detail"] : null,
  };
}

function parseAuditPage(value: unknown): AuditPage | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    !Array.isArray(v["entries"]) ||
    typeof v["message"] !== "string" ||
    !isStringArray(v["notes"])
  ) {
    return null;
  }
  const entries: AuditEntry[] = [];
  for (const e of v["entries"]) {
    const parsed = parseAuditEntry(e);
    if (parsed === null) return null;
    entries.push(parsed);
  }
  return {
    entries,
    nextCursor:
      typeof v["nextCursor"] === "string" ? v["nextCursor"] : null,
    total: typeof v["total"] === "number" ? Math.trunc(v["total"]) : null,
    message: v["message"],
    notes: v["notes"],
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

function normaliseError(value: unknown, fallback: string): ApiError {
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

function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace("Z", " UTC");
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const pageStyle: CSSProperties = {
  maxWidth: 1040,
  margin: "0 auto",
  padding: "24px 16px 48px",
  fontFamily:
    "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  color: "#0f172a",
  background: "#ffffff",
};

const breadcrumbStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  fontSize: 12,
  color: "#64748b",
};

const linkStyle: CSSProperties = {
  color: "#1d4ed8",
  textDecoration: "none",
};

const cardStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 8,
};

const fieldRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: 12,
  marginBottom: 8,
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const fieldLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "#475569",
  fontWeight: 500,
};

const inputStyle: CSSProperties = {
  padding: "6px 8px",
  fontSize: 13,
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#ffffff",
  color: "#0f172a",
};

const checkboxLabelStyle: CSSProperties = {
  display: "inline-flex",
  gap: 8,
  alignItems: "center",
  cursor: "pointer",
  margin: "4px 0 8px",
};

const filterRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 8,
  alignItems: "end",
  padding: 10,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  marginBottom: 10,
};

const filterFieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const filterLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "#475569",
  fontWeight: 500,
};

const metaGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 8,
  padding: 8,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const auditRowStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "8px 10px",
  marginBottom: 6,
  background: "#ffffff",
};

const mutedStyle: CSSProperties = {
  color: "#64748b",
  fontSize: 12,
  margin: "4px 0",
};

const monoStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
};

const preStyle: CSSProperties = {
  margin: "4px 0 0",
  padding: "6px 8px",
  background: "#0f172a",
  color: "#e2e8f0",
  borderRadius: 4,
  fontSize: 11,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const errorStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
  fontSize: 13,
};

const infoStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  background: "#eff6ff",
  color: "#1e3a8a",
  fontSize: 13,
};

const successStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #bbf7d0",
  borderRadius: 6,
  background: "#f0fdf4",
  color: "#14532d",
  fontSize: 13,
};

const linkButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#1d4ed8",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
  textDecoration: "underline",
};

function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 6,
    border: "1px solid #1d4ed8",
    background: disabled ? "#93c5fd" : "#1d4ed8",
    color: "#ffffff",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function secondaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    background: disabled ? "#f1f5f9" : "#ffffff",
    color: disabled ? "#94a3b8" : "#1d4ed8",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function outcomeBadgeStyle(outcome: AuditEntry["outcome"]): CSSProperties {
  const palette = (() => {
    switch (outcome) {
      case "allowed":
        return { bg: "#dcfce7", fg: "#166534" };
      case "denied":
        return { bg: "#fee2e2", fg: "#7f1d1d" };
      case "error":
        return { bg: "#fef3c7", fg: "#92400e" };
      case "unknown":
      default:
        return { bg: "#e2e8f0", fg: "#334155" };
    }
  })();
  return {
    display: "inline-block",
    padding: "1px 8px",
    borderRadius: 4,
    background: palette.bg,
    color: palette.fg,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  };
}
