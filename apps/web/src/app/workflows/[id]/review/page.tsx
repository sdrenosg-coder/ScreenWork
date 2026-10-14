"use client";

/**
 * Workflow review page (phase 19, batch 2) — human-in-the-loop review surface.
 *
 * Owns the reviewer's session for one workflow:
 *   - shows and toggles review mode (on/off) via the review API;
 *   - lists the actions already classified by risk, so high-risk steps are
 *     visible before control is handed to the browser worker;
 *   - embeds LiveSessionView (this batch) so a reviewer can observe the live
 *     browser, take/release control, send input and approve/reject the
 *     pending checkpoint;
 *   - surfaces the audit trail the decision endpoints returned, page by page,
 *     with a load-more that reads what the server actually sent.
 *
 * Wire contract (owned by the review API, supplied elsewhere; this page only
 * consumes it):
 *   GET  /api/workflows/{id}/review
 *     -> 200 {
 *          workflowId, workspaceId, reviewMode, riskPolicy,
 *          actions, decisionCounts, message, notes[]
 *        }
 *     -> 4xx { error, message, field? }
 *
 *   PUT  /api/workflows/{id}/review
 *     body: { reviewMode: boolean, riskPolicy?: string }
 *     -> 200 { workflowId, reviewMode, riskPolicy, message, notes[] }
 *
 *   GET  /api/workflows/{id}/review/decisions?cursor=&limit=
 *     -> 200 {
 *          workflowId, decisions: DecisionEntry[],
 *          nextCursor: string | null, message, notes[]
 *        }
 *
 * Deliberate non-goals, documented rather than stubbed:
 *   - The page does not classify actions itself. Risk classification is the
 *     worker's responsibility; the page renders the class the server sent.
 *   - The page does not run the browser. LiveSessionView renders the worker's
 *     published session; the page never opens a CDP endpoint.
 *   - The page does not resolve the pending checkpoint locally. Every
 *     approve/reject goes through the review API; the page then refreshes.
 *   - The page does not edit workflow steps. That is the guides editor.
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
import LiveSessionView from "../../../../components/LiveSessionView";

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

export type RiskClass =
  | "read_only"
  | "write"
  | "destructive"
  | "financial"
  | "external_communication"
  | "unknown";

export interface WorkflowAction {
  readonly id: string;
  readonly stepKey: string | null;
  readonly kind: string;
  readonly summary: string;
  readonly targetRef: string | null;
  readonly riskClass: RiskClass;
  readonly requiresApproval: boolean;
  readonly notes: readonly string[];
}

export interface DecisionCounts {
  readonly approved: number;
  readonly edited: number;
  readonly rejected: number;
  readonly total: number;
}

export interface ReviewSummary {
  readonly workflowId: string;
  readonly workspaceId: string;
  readonly reviewMode: boolean;
  readonly riskPolicy: string | null;
  readonly actions: readonly WorkflowAction[];
  readonly decisionCounts: DecisionCounts;
  readonly message: string;
  readonly notes: readonly string[];
}

export interface DecisionEntry {
  readonly id: string;
  readonly workflowId: string;
  readonly actionId: string | null;
  readonly stepKey: string | null;
  readonly decision: "approved" | "edited" | "rejected" | "auto_approved";
  readonly reviewerId: string | null;
  readonly reviewerDisplay: string | null;
  readonly decidedAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly reason: string | null;
  readonly diff: string | null;
  readonly checkpointId: string | null;
}

export interface DecisionsPage {
  readonly workflowId: string;
  readonly decisions: readonly DecisionEntry[];
  readonly nextCursor: string | null;
  readonly message: string;
  readonly notes: readonly string[];
}

interface ApiError {
  readonly error: string;
  readonly message: string;
  readonly field?: string;
}

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: ReviewSummary }
  | { readonly kind: "error"; readonly error: ApiError };

interface AuditState {
  readonly entries: readonly DecisionEntry[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadedOnce: boolean;
  readonly error: ApiError | null;
}

interface Outcome {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
  readonly details: readonly string[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AUDIT_PAGE_SIZE = 25;

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function WorkflowReviewPage({
  params,
}: {
  readonly params: { readonly id: string };
}) {
  const workflowId = params.id;
  const idValid = UUID_PATTERN.test(workflowId);

  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [toggling, setToggling] = useState(false);
  const [audit, setAudit] = useState<AuditState>({
    entries: [],
    nextCursor: null,
    loading: false,
    loadedOnce: false,
    error: null,
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);

  // Remember the "caller wants audit loaded" flag so we only auto-load once.
  const auditRequestedRef = useRef(false);

  /* -------------------------------- summary ------------------------------ */

  const loadSummary = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      if (!idValid) {
        setState({
          kind: "error",
          error: {
            error: "invalid_workflow_id",
            field: "workflowId",
            message:
              "workflowId must be a UUID. The review page will not call the API with a malformed id.",
          },
        });
        return;
      }
      setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
      try {
        const res = await fetch(
          `/api/workflows/${encodeURIComponent(workflowId)}/review`,
          { signal, headers: { accept: "application/json" } },
        );
        const json: unknown = await res.json().catch(() => null);
        if (signal.aborted) return;
        if (!res.ok) {
          setState({
            kind: "error",
            error: normaliseError(json, `Request failed with HTTP ${res.status}.`),
          });
          return;
        }
        const parsed = parseSummary(json);
        if (parsed === null) {
          setState({
            kind: "error",
            error: {
              error: "unexpected_response",
              message:
                "The server returned a review payload this page does not recognise. Check server logs.",
            },
          });
          return;
        }
        setState({ kind: "ready", data: parsed });
      } catch (err) {
        if (signal.aborted) return;
        setState({
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
    },
    [workflowId, idValid],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadSummary(controller.signal);
    return () => controller.abort();
  }, [loadSummary]);

  /* --------------------------------- toggle ------------------------------ */

  const setReviewMode = useCallback(
    async (next: boolean): Promise<void> => {
      if (state.kind !== "ready") return;
      setToggling(true);
      setOutcome(null);
      try {
        const res = await fetch(
          `/api/workflows/${encodeURIComponent(workflowId)}/review`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ reviewMode: next }),
          },
        );
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const err = normaliseError(json, `Update failed with HTTP ${res.status}.`);
          setOutcome({
            kind: "error",
            message: `${err.error}: ${err.message}`,
            details: err.field !== undefined ? [`field: ${err.field}`] : [],
          });
          return;
        }
        const parsed = parseUpdateResponse(json);
        if (parsed === null) {
          setOutcome({
            kind: "error",
            message:
              "The server accepted the change but returned an unrecognised payload. Refresh to confirm.",
            details: [],
          });
          return;
        }
        setOutcome({
          kind: "success",
          message: parsed.message,
          details: [
            `reviewMode: ${parsed.reviewMode ? "on" : "off"}`,
            ...(parsed.riskPolicy !== null
              ? [`riskPolicy: ${parsed.riskPolicy}`]
              : []),
            ...parsed.notes,
          ],
        });
        // Reflect the authoritative value from the server, not the local intent.
        setState((prev) =>
          prev.kind === "ready"
            ? {
                kind: "ready",
                data: {
                  ...prev.data,
                  reviewMode: parsed.reviewMode,
                  riskPolicy: parsed.riskPolicy,
                },
              }
            : prev,
        );
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
        setToggling(false);
      }
    },
    [workflowId, state],
  );

  /* --------------------------------- audit ------------------------------- */

  const loadAuditPage = useCallback(
    async (cursor: string | null): Promise<void> => {
      if (!idValid) return;
      setAudit((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const url = new URL(
          `/api/workflows/${encodeURIComponent(workflowId)}/review/decisions`,
          typeof window !== "undefined" ? window.location.origin : "http://0.0.0.0",
        );
        url.searchParams.set("limit", String(AUDIT_PAGE_SIZE));
        if (cursor !== null) url.searchParams.set("cursor", cursor);
        const res = await fetch(url.toString(), {
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
        const parsed = parseDecisionsPage(json);
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
              ? parsed.decisions
              : [...prev.entries, ...parsed.decisions],
          nextCursor: parsed.nextCursor,
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
    [workflowId, idValid],
  );

  useEffect(() => {
    if (auditRequestedRef.current) return;
    if (state.kind !== "ready") return;
    auditRequestedRef.current = true;
    void loadAuditPage(null);
  }, [state, loadAuditPage]);

  /* -------------------------------- derived ------------------------------ */

  const highRiskCount = useMemo(() => {
    if (state.kind !== "ready") return 0;
    return state.data.actions.filter((a) => isHighRisk(a.riskClass)).length;
  }, [state]);

  /* -------------------------------- render ------------------------------- */

  return (
    <main style={pageStyle}>
      <nav style={breadcrumbStyle} aria-label="Breadcrumb">
        <Link href="/dashboard" style={linkStyle}>
          Dashboard
        </Link>
        <span aria-hidden="true">›</span>
        <Link
          href={`/workflows/${encodeURIComponent(workflowId)}`}
          style={linkStyle}
        >
          Workflow
        </Link>
        <span aria-hidden="true">›</span>
        <span style={{ color: "#0f172a", fontWeight: 500 }}>Review</span>
      </nav>

      <header style={{ margin: "8px 0 16px" }}>
        <h1 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 700 }}>
          Human-in-the-loop review
        </h1>
        <p style={{ margin: 0, color: "#475569", fontSize: 13 }}>
          Workflow <code style={monoStyle}>{workflowId}</code>
        </p>
      </header>

      {state.kind === "idle" || state.kind === "loading" ? (
        <p style={mutedStyle}>Loading review summary…</p>
      ) : state.kind === "error" ? (
        <div role="alert" style={errorStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            {state.error.error}
          </strong>
          <span>{state.error.message}</span>
          {state.error.field !== undefined && (
            <span style={{ marginLeft: 6 }}>
              (field: {state.error.field})
            </span>
          )}
        </div>
      ) : (
        <>
          <section style={cardStyle} aria-labelledby="zipy-review-mode-heading">
            <header style={headerRowStyle}>
              <div>
                <h2
                  id="zipy-review-mode-heading"
                  style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
                >
                  Review mode
                </h2>
                <p style={{ margin: "2px 0 0", color: "#475569", fontSize: 12 }}>
                  {state.data.message}
                </p>
              </div>
              <label style={switchLabelStyle}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={state.data.reviewMode}
                  disabled={toggling || liveBusy}
                  onChange={(e) => void setReviewMode(e.target.checked)}
                />
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {state.data.reviewMode ? "Review on" : "Review off"}
                </span>
              </label>
            </header>

            <div style={metaGridStyle}>
              <Meta label="Workspace" value={state.data.workspaceId} mono />
              <Meta
                label="Risk policy"
                value={state.data.riskPolicy ?? "(server default)"}
                mono
              />
              <Meta
                label="High-risk actions"
                value={String(highRiskCount)}
              />
              <Meta
                label="Decisions"
                value={`${state.data.decisionCounts.total} total · ${state.data.decisionCounts.approved} approved · ${state.data.decisionCounts.edited} edited · ${state.data.decisionCounts.rejected} rejected`}
              />
            </div>

            {state.data.notes.length > 0 && (
              <ul style={{ ...listStyle, marginTop: 8 }}>
                {state.data.notes.map((n, i) => (
                  <li key={i} style={{ fontSize: 12, color: "#475569" }}>
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            style={{ ...cardStyle, marginTop: 16 }}
            aria-labelledby="zipy-risk-heading"
          >
            <header style={headerRowStyle}>
              <h2
                id="zipy-risk-heading"
                style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
              >
                Action risk classification
              </h2>
              <span style={{ fontSize: 12, color: "#475569" }}>
                {state.data.actions.length} action
                {state.data.actions.length === 1 ? "" : "s"}
              </span>
            </header>

            {state.data.actions.length === 0 ? (
              <p style={mutedStyle}>
                No classified actions are recorded for this workflow.
              </p>
            ) : (
              <ul style={listStyle}>
                {state.data.actions.map((a) => (
                  <ActionRow key={a.id} action={a} />
                ))}
              </ul>
            )}
          </section>

          <section style={{ marginTop: 16 }}>
            <LiveSessionView
              workflowId={workflowId}
              readOnly={!state.data.reviewMode}
              onBusyChange={setLiveBusy}
            />
          </section>

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
                  Audit trail
                </h2>
                <p
                  style={{ margin: "2px 0 0", color: "#475569", fontSize: 12 }}
                >
                  Every approve, edit and rejection recorded for this workflow.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadAuditPage(null)}
                disabled={audit.loading}
                style={linkButtonStyle}
              >
                {audit.loading ? "Loading…" : "Reload"}
              </button>
            </header>

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
                No decisions have been recorded for this workflow yet.
              </p>
            ) : (
              <ul style={listStyle}>
                {audit.entries.map((d) => (
                  <DecisionRow key={d.id} decision={d} />
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
        </>
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

function Meta({
  label,
  value,
  mono,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div>
      <div style={{ color: "#64748b", fontSize: 11 }}>{label}</div>
      <div
        style={{
          color: "#0f172a",
          fontSize: 12,
          fontWeight: 500,
          wordBreak: "break-word",
          ...(mono === true ? monoStyle : {}),
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ActionRow({ action }: { readonly action: WorkflowAction }) {
  return (
    <li style={actionRowStyle}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13 }}>{action.summary}</strong>
        <code style={{ ...monoStyle, color: "#475569" }}>{action.kind}</code>
        <span style={riskBadgeStyle(action.riskClass)}>
          {action.riskClass}
        </span>
        {action.requiresApproval && (
          <span style={approvalBadgeStyle}>requires approval</span>
        )}
        {action.stepKey !== null && (
          <code style={{ ...monoStyle, color: "#475569" }}>
            step {action.stepKey}
          </code>
        )}
      </div>
      {action.targetRef !== null && (
        <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
          Target:{" "}
          <code style={monoStyle}>{action.targetRef}</code>
        </div>
      )}
      {action.notes.length > 0 && (
        <ul style={{ ...listStyle, marginTop: 4 }}>
          {action.notes.map((n, i) => (
            <li key={i} style={{ fontSize: 11, color: "#64748b" }}>
              {n}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function DecisionRow({ decision }: { readonly decision: DecisionEntry }) {
  return (
    <li style={decisionRowStyle}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span style={decisionBadgeStyle(decision.decision)}>
          {decision.decision}
        </span>
        <code style={{ ...monoStyle, color: "#475569" }}>
          {decision.id}
        </code>
        <span style={{ fontSize: 12, color: "#0f172a", fontWeight: 600 }}>
          {formatIso(decision.decidedAt)}
        </span>
        {decision.reviewerDisplay !== null ? (
          <span style={{ fontSize: 12, color: "#475569" }}>
            by {decision.reviewerDisplay}
          </span>
        ) : decision.reviewerId !== null ? (
          <span style={{ fontSize: 12, color: "#475569" }}>
            by <code style={monoStyle}>{decision.reviewerId}</code>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#64748b" }}>
            reviewer unknown
          </span>
        )}
        {decision.stepKey !== null && (
          <code style={{ ...monoStyle, color: "#475569" }}>
            step {decision.stepKey}
          </code>
        )}
      </div>
      {decision.actionId !== null && (
        <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
          Action: <code style={monoStyle}>{decision.actionId}</code>
        </div>
      )}
      {decision.checkpointId !== null && (
        <div style={{ fontSize: 12, color: "#475569" }}>
          Checkpoint: <code style={monoStyle}>{decision.checkpointId}</code>
        </div>
      )}
      {decision.reason !== null && (
        <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
          Reason: {decision.reason}
        </div>
      )}
      {decision.ip !== null && (
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
          IP: <code style={monoStyle}>{decision.ip}</code>
        </div>
      )}
      {decision.userAgent !== null && (
        <div style={{ fontSize: 11, color: "#64748b" }}>
          UA: {decision.userAgent}
        </div>
      )}
      {decision.diff !== null && (
        <details style={{ marginTop: 4 }}>
          <summary
            style={{ cursor: "pointer", fontSize: 11, color: "#475569" }}
          >
            Diff / edit payload
          </summary>
          <pre style={preStyle}>{decision.diff}</pre>
        </details>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

const RISK_CLASSES: readonly RiskClass[] = [
  "read_only",
  "write",
  "destructive",
  "financial",
  "external_communication",
  "unknown",
];

function asRiskClass(v: unknown): RiskClass {
  return typeof v === "string" && (RISK_CLASSES as readonly string[]).includes(v)
    ? (v as RiskClass)
    : "unknown";
}

function isHighRisk(risk: RiskClass): boolean {
  return risk === "destructive" || risk === "financial" || risk === "external_communication";
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseAction(v: unknown): WorkflowAction | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r["id"] !== "string" ||
    typeof r["kind"] !== "string" ||
    typeof r["summary"] !== "string"
  ) {
    return null;
  }
  return {
    id: r["id"],
    stepKey: typeof r["stepKey"] === "string" ? r["stepKey"] : null,
    kind: r["kind"],
    summary: r["summary"],
    targetRef: typeof r["targetRef"] === "string" ? r["targetRef"] : null,
    riskClass: asRiskClass(r["riskClass"]),
    requiresApproval: r["requiresApproval"] === true,
    notes: isStringArray(r["notes"]) ? r["notes"] : [],
  };
}

function parseDecisionCounts(v: unknown): DecisionCounts | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const nums = ["approved", "edited", "rejected", "total"] as const;
  if (!nums.every((k) => typeof r[k] === "number" && Number.isFinite(r[k]))) {
    return null;
  }
  return {
    approved: Math.trunc(r["approved"] as number),
    edited: Math.trunc(r["edited"] as number),
    rejected: Math.trunc(r["rejected"] as number),
    total: Math.trunc(r["total"] as number),
  };
}

function parseSummary(value: unknown): ReviewSummary | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["workflowId"] !== "string" ||
    typeof v["workspaceId"] !== "string" ||
    typeof v["reviewMode"] !== "boolean" ||
    typeof v["message"] !== "string"
  ) {
    return null;
  }
  if (!Array.isArray(v["actions"]) || !isStringArray(v["notes"])) return null;
  const actions: WorkflowAction[] = [];
  for (const a of v["actions"]) {
    const parsed = parseAction(a);
    if (parsed === null) return null;
    actions.push(parsed);
  }
  const counts = parseDecisionCounts(v["decisionCounts"]);
  if (counts === null) return null;
  return {
    workflowId: v["workflowId"],
    workspaceId: v["workspaceId"],
    reviewMode: v["reviewMode"],
    riskPolicy: typeof v["riskPolicy"] === "string" ? v["riskPolicy"] : null,
    actions,
    decisionCounts: counts,
    message: v["message"],
    notes: v["notes"],
  };
}

function parseUpdateResponse(
  value: unknown,
): { readonly reviewMode: boolean; readonly riskPolicy: string | null; readonly message: string; readonly notes: readonly string[] } | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["workflowId"] !== "string" ||
    typeof v["reviewMode"] !== "boolean" ||
    typeof v["message"] !== "string" ||
    !isStringArray(v["notes"])
  ) {
    return null;
  }
  return {
    reviewMode: v["reviewMode"],
    riskPolicy: typeof v["riskPolicy"] === "string" ? v["riskPolicy"] : null,
    message: v["message"],
    notes: v["notes"],
  };
}

function parseDecisionKind(
  v: unknown,
): DecisionEntry["decision"] | null {
  if (
    v === "approved" ||
    v === "edited" ||
    v === "rejected" ||
    v === "auto_approved"
  ) {
    return v;
  }
  return null;
}

function parseDecision(v: unknown): DecisionEntry | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r["id"] !== "string" ||
    typeof r["workflowId"] !== "string" ||
    typeof r["decidedAt"] !== "string"
  ) {
    return null;
  }
  const kind = parseDecisionKind(r["decision"]);
  if (kind === null) return null;
  return {
    id: r["id"],
    workflowId: r["workflowId"],
    actionId: typeof r["actionId"] === "string" ? r["actionId"] : null,
    stepKey: typeof r["stepKey"] === "string" ? r["stepKey"] : null,
    decision: kind,
    reviewerId: typeof r["reviewerId"] === "string" ? r["reviewerId"] : null,
    reviewerDisplay:
      typeof r["reviewerDisplay"] === "string" ? r["reviewerDisplay"] : null,
    decidedAt: r["decidedAt"],
    ip: typeof r["ip"] === "string" ? r["ip"] : null,
    userAgent: typeof r["userAgent"] === "string" ? r["userAgent"] : null,
    reason: typeof r["reason"] === "string" ? r["reason"] : null,
    diff: typeof r["diff"] === "string" ? r["diff"] : null,
    checkpointId:
      typeof r["checkpointId"] === "string" ? r["checkpointId"] : null,
  };
}

function parseDecisionsPage(value: unknown): DecisionsPage | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["workflowId"] !== "string" ||
    typeof v["message"] !== "string" ||
    !Array.isArray(v["decisions"]) ||
    !isStringArray(v["notes"])
  ) {
    return null;
  }
  const decisions: DecisionEntry[] = [];
  for (const d of v["decisions"]) {
    const parsed = parseDecision(d);
    if (parsed === null) return null;
    decisions.push(parsed);
  }
  return {
    workflowId: v["workflowId"],
    decisions,
    nextCursor: typeof v["nextCursor"] === "string" ? v["nextCursor"] : null,
    message: v["message"],
    notes: v["notes"],
  };
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
  maxWidth: 960,
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

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 8,
};

const cardStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
};

const metaGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 8,
  padding: 8,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  marginTop: 6,
};

const actionRowStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "8px 10px",
  marginBottom: 6,
  background: "#ffffff",
};

const decisionRowStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "8px 10px",
  marginBottom: 6,
  background: "#ffffff",
};

const switchLabelStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
  padding: "4px 8px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#ffffff",
};

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
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

function riskBadgeStyle(risk: RiskClass): CSSProperties {
  const palette = (() => {
    switch (risk) {
      case "destructive":
      case "financial":
      case "external_communication":
        return { bg: "#fee2e2", fg: "#7f1d1d" };
      case "write":
        return { bg: "#fef3c7", fg: "#92400e" };
      case "read_only":
        return { bg: "#dcfce7", fg: "#166534" };
      case "unknown":
      default:
        return { bg: "#e2e8f0", fg: "#334155" };
    }
  })();
  return {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: 4,
    background: palette.bg,
    color: palette.fg,
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  };
}

const approvalBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 4,
  background: "#ede9fe",
  color: "#4c1d95",
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.3,
};

function decisionBadgeStyle(
  decision: DecisionEntry["decision"],
): CSSProperties {
  const palette = (() => {
    switch (decision) {
      case "approved":
        return { bg: "#dcfce7", fg: "#166534" };
      case "auto_approved":
        return { bg: "#e0e7ff", fg: "#1e3a8a" };
      case "edited":
        return { bg: "#dbeafe", fg: "#1e3a8a" };
      case "rejected":
        return { bg: "#fee2e2", fg: "#7f1d1d" };
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
