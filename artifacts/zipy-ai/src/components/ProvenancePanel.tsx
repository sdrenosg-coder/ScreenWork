"use client";

/**
 * ProvenancePanel — reviewer-facing panel that shows, for one fusion run,
 * every cross-source conflict and coverage gap with direct links back to the
 * source artifact, region and timestamp that produced each side.
 *
 * The panel is intentionally presentation-only: it fetches
 * `/api/fusion/{id}/conflicts`, renders conflicts/gaps, and exposes the
 * provenance refs the API returned. It does not attempt to resolve conflicts,
 * rerun reconciliation, or fetch source bytes — those belong to the editing
 * and review surfaces.
 *
 * The layout mirrors the inline-styles convention used by SourceIngestForm so
 * it can be dropped onto any page under `apps/web/src/app` without a design
 * system.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

type FusionState = "pending" | "succeeded" | "failed" | "unknown";

interface ConflictSide {
  readonly sourceIds: readonly string[];
  readonly regionKeys: readonly string[];
  readonly excerpt: string | null;
  readonly provenance: Readonly<Record<string, unknown>>;
}

interface Conflict {
  readonly id: string;
  readonly summary: string;
  readonly kind: string;
  readonly candidateResolution: string | null;
  readonly sides: readonly ConflictSide[];
  readonly regionKeys: readonly string[];
  readonly detectedAt: string | null;
}

interface Gap {
  readonly id: string;
  readonly summary: string;
  readonly stepKey: string | null;
  readonly severity: string;
  readonly detectedAt: string | null;
}

interface ReconciliationSummary {
  readonly totalClaims: number;
  readonly supportedClaims: number;
  readonly conflictingClaims: number;
  readonly unsupportedClaims: number;
  readonly parametricOnlyClaims: number;
  readonly meanConfidence: number;
}

interface FusionConflictsResponse {
  readonly fusionId: string;
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly state: FusionState;
  readonly jobId: string | null;
  readonly conflicts: readonly Conflict[];
  readonly gaps: readonly Gap[];
  readonly reconciliation: ReconciliationSummary | null;
  readonly parametricUsed: boolean;
  readonly parametricModel: string | null;
  readonly generatedAt: string | null;
  readonly conflictsCount: number;
  readonly gapsCount: number;
  readonly message: string;
  readonly notes: readonly string[];
}

interface ErrorPayload {
  readonly error: string;
  readonly message: string;
}

export interface ProvenancePanelProps {
  /** Fusion artifact id (the `id` path segment). */
  readonly fusionId: string;
  /**
   * Optional polling interval in milliseconds while the fusion job is still
   * pending. Set to 0 to disable polling. Defaults to 5000ms.
   */
  readonly pollIntervalMs?: number;
}

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: FusionConflictsResponse }
  | { readonly kind: "error"; readonly error: ErrorPayload };

export default function ProvenancePanel({
  fusionId,
  pollIntervalMs = 5000,
}: ProvenancePanelProps) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      setState((prev) =>
        prev.kind === "ready" ? prev : { kind: "loading" },
      );
      try {
        const res = await fetch(
          `/api/fusion/${encodeURIComponent(fusionId)}/conflicts`,
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
        const parsed = parseResponse(json);
        if (parsed === null) {
          setState({
            kind: "error",
            error: {
              error: "unexpected_response",
              message:
                "The server returned a payload this panel does not recognise. Check server logs.",
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
    [fusionId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (pollIntervalMs <= 0) return;
    if (state.kind !== "ready") return;
    if (state.data.state !== "pending") return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      void load(controller.signal);
    }, pollIntervalMs);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [state, pollIntervalMs, load]);

  const body = useMemo(() => {
    if (state.kind === "idle" || state.kind === "loading") {
      return <p style={mutedStyle}>Loading conflict and gap report…</p>;
    }
    if (state.kind === "error") {
      return (
        <div role="alert" style={errorStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            {state.error.error}
          </strong>
          <span>{state.error.message}</span>
        </div>
      );
    }
    return <ReadyBody data={state.data} />;
  }, [state]);

  return (
    <section aria-labelledby="zipy-provenance-heading" style={cardStyle}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <h2
          id="zipy-provenance-heading"
          style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
        >
          Provenance — conflicts &amp; gaps
        </h2>
        <button
          type="button"
          onClick={() => {
            const controller = new AbortController();
            void load(controller.signal);
          }}
          style={linkButtonStyle}
        >
          Refresh
        </button>
      </header>
      <p style={{ marginTop: 6, marginBottom: 12, color: "#475569", fontSize: 12 }}>
        Fusion id:{" "}
        <code style={monoStyle}>{fusionId}</code>
      </p>
      {body}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Ready-state rendering                                                       */
/* -------------------------------------------------------------------------- */

function ReadyBody({ data }: { readonly data: FusionConflictsResponse }) {
  return (
    <>
      <div style={statusRowStyle}>
        <StateBadge state={data.state} />
        <span style={{ fontSize: 12, color: "#475569" }}>{data.message}</span>
      </div>

      {data.reconciliation !== null && (
        <ReconciliationRow summary={data.reconciliation} />
      )}

      <div style={{ marginTop: 12 }}>
        <h3 style={sectionHeadingStyle}>
          Conflicts ({data.conflictsCount})
        </h3>
        {data.conflicts.length === 0 ? (
          <p style={mutedStyle}>No cross-source conflicts recorded.</p>
        ) : (
          <ul style={listStyle}>
            {data.conflicts.map((c) => (
              <ConflictItem key={c.id} conflict={c} />
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <h3 style={sectionHeadingStyle}>Gaps ({data.gapsCount})</h3>
        {data.gaps.length === 0 ? (
          <p style={mutedStyle}>No coverage gaps recorded.</p>
        ) : (
          <ul style={listStyle}>
            {data.gaps.map((g) => (
              <GapItem key={g.id} gap={g} />
            ))}
          </ul>
        )}
      </div>

      {data.notes.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={sectionHeadingStyle}>Notes</h3>
          <ul style={{ ...listStyle, color: "#475569" }}>
            {data.notes.map((note, idx) => (
              <li key={`${idx}-${note.slice(0, 12)}`} style={{ fontSize: 12 }}>
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer
        style={{
          marginTop: 16,
          paddingTop: 8,
          borderTop: "1px solid #e2e8f0",
          fontSize: 11,
          color: "#64748b",
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {data.generatedAt !== null && (
          <span>Generated: {formatIso(data.generatedAt)}</span>
        )}
        {data.jobId !== null && (
          <span>
            Job: <code style={monoStyle}>{data.jobId}</code>
          </span>
        )}
        <span>
          Parametric:{" "}
          {data.parametricUsed
            ? data.parametricModel ?? "yes (provider unspecified)"
            : "no — evidence-only reconciliation"}
        </span>
      </footer>
    </>
  );
}

function StateBadge({ state }: { readonly state: FusionState }) {
  const palette = (() => {
    switch (state) {
      case "succeeded":
        return { bg: "#dcfce7", fg: "#166534", label: "succeeded" };
      case "failed":
        return { bg: "#fee2e2", fg: "#7f1d1d", label: "failed" };
      case "pending":
        return { bg: "#fef9c3", fg: "#854d0e", label: "pending" };
      case "unknown":
        return { bg: "#e2e8f0", fg: "#334155", label: "unknown" };
    }
  })();
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: "uppercase",
      }}
    >
      {palette.label}
    </span>
  );
}

function ReconciliationRow({
  summary,
}: {
  readonly summary: ReconciliationSummary;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
        gap: 6,
        marginTop: 8,
        padding: 8,
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 6,
        fontSize: 12,
      }}
    >
      <Stat label="Total claims" value={summary.totalClaims} />
      <Stat label="Supported" value={summary.supportedClaims} />
      <Stat label="Conflicting" value={summary.conflictingClaims} />
      <Stat label="Unsupported" value={summary.unsupportedClaims} />
      <Stat label="Parametric only" value={summary.parametricOnlyClaims} />
      <Stat
        label="Mean confidence"
        value={`${Math.round(summary.meanConfidence * 100)}%`}
      />
    </div>
  );
}

function Stat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number | string;
}) {
  return (
    <div>
      <div style={{ color: "#64748b", fontSize: 11 }}>{label}</div>
      <div style={{ fontWeight: 600, color: "#0f172a" }}>{value}</div>
    </div>
  );
}

function ConflictItem({ conflict }: { readonly conflict: Conflict }) {
  return (
    <li style={listItemStyle}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <strong style={{ fontSize: 13 }}>{conflict.summary}</strong>
        <code style={{ ...monoStyle, color: "#475569" }}>{conflict.kind}</code>
      </div>
      {conflict.candidateResolution !== null && (
        <div style={resolutionStyle}>
          <span style={{ fontWeight: 600 }}>Suggested resolution: </span>
          {conflict.candidateResolution}{" "}
          <em style={{ color: "#64748b" }}>
            (advisory only — no source was automatically overruled)
          </em>
        </div>
      )}
      <ul style={{ ...listStyle, marginTop: 6 }}>
        {conflict.sides.map((side, idx) => (
          <li key={idx} style={{ fontSize: 12, marginBottom: 4 }}>
            <div>
              {side.excerpt !== null ? (
                <span>“{truncate(side.excerpt, 240)}”</span>
              ) : (
                <span style={{ color: "#64748b" }}>
                  (no excerpt recorded)
                </span>
              )}
            </div>
            {side.sourceIds.length > 0 && (
              <div style={{ color: "#475569" }}>
                Sources:{" "}
                {side.sourceIds.map((s) => (
                  <code key={s} style={{ ...monoStyle, marginRight: 6 }}>
                    {s}
                  </code>
                ))}
              </div>
            )}
            {side.regionKeys.length > 0 && (
              <div style={{ color: "#475569" }}>
                Regions:{" "}
                {side.regionKeys.map((k) => (
                  <code key={k} style={{ ...monoStyle, marginRight: 6 }}>
                    {k}
                  </code>
                ))}
              </div>
            )}
            {Object.keys(side.provenance).length > 0 && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: "pointer", color: "#475569" }}>
                  Provenance detail
                </summary>
                <pre style={preStyle}>
                  {JSON.stringify(side.provenance, null, 2)}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>
      {conflict.detectedAt !== null && (
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
          Detected {formatIso(conflict.detectedAt)}
        </div>
      )}
    </li>
  );
}

function GapItem({ gap }: { readonly gap: Gap }) {
  return (
    <li style={listItemStyle}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <strong style={{ fontSize: 13 }}>{gap.summary}</strong>
        <span style={severityBadgeStyle(gap.severity)}>{gap.severity}</span>
      </div>
      {gap.stepKey !== null && (
        <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>
          Step key:{" "}
          <code style={monoStyle}>{gap.stepKey}</code>
        </div>
      )}
      {gap.detectedAt !== null && (
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
          Detected {formatIso(gap.detectedAt)}
        </div>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace("Z", " UTC");
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseResponse(value: unknown): FusionConflictsResponse | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["fusionId"] !== "string" ||
    typeof v["workspaceId"] !== "string" ||
    typeof v["artifactId"] !== "string" ||
    typeof v["state"] !== "string" ||
    typeof v["message"] !== "string" ||
    typeof v["conflictsCount"] !== "number" ||
    typeof v["gapsCount"] !== "number"
  ) {
    return null;
  }
  const state = v["state"];
  if (
    state !== "pending" &&
    state !== "succeeded" &&
    state !== "failed" &&
    state !== "unknown"
  ) {
    return null;
  }
  if (!Array.isArray(v["conflicts"]) || !Array.isArray(v["gaps"])) return null;
  if (!Array.isArray(v["notes"]) || !v["notes"].every((n) => typeof n === "string")) {
    return null;
  }
  // Conflict and gap shapes are structurally validated by the server; the
  // panel accepts what the response declares here and lets the render path
  // handle optional fields.
  const conflicts: Conflict[] = [];
  for (const c of v["conflicts"] as readonly unknown[]) {
    const rec = c as Record<string, unknown>;
    if (
      typeof rec["id"] !== "string" ||
      typeof rec["summary"] !== "string" ||
      typeof rec["kind"] !== "string"
    ) {
      return null;
    }
    const sidesRaw = rec["sides"];
    const sides: ConflictSide[] = [];
    if (Array.isArray(sidesRaw)) {
      for (const s of sidesRaw as readonly unknown[]) {
        const sRec = s as Record<string, unknown>;
        sides.push({
          sourceIds: isStringArray(sRec["sourceIds"]) ? sRec["sourceIds"] : [],
          regionKeys: isStringArray(sRec["regionKeys"]) ? sRec["regionKeys"] : [],
          excerpt: typeof sRec["excerpt"] === "string" ? sRec["excerpt"] : null,
          provenance:
            sRec["provenance"] !== null && typeof sRec["provenance"] === "object"
              ? (sRec["provenance"] as Readonly<Record<string, unknown>>)
              : {},
        });
      }
    }
    conflicts.push({
      id: rec["id"],
      summary: rec["summary"],
      kind: rec["kind"],
      candidateResolution:
        typeof rec["candidateResolution"] === "string"
          ? rec["candidateResolution"]
          : null,
      sides,
      regionKeys: isStringArray(rec["regionKeys"]) ? rec["regionKeys"] : [],
      detectedAt: typeof rec["detectedAt"] === "string" ? rec["detectedAt"] : null,
    });
  }

  const gaps: Gap[] = [];
  for (const g of v["gaps"] as readonly unknown[]) {
    const rec = g as Record<string, unknown>;
    if (typeof rec["id"] !== "string" || typeof rec["summary"] !== "string") {
      return null;
    }
    gaps.push({
      id: rec["id"],
      summary: rec["summary"],
      stepKey: typeof rec["stepKey"] === "string" ? rec["stepKey"] : null,
      severity: typeof rec["severity"] === "string" ? rec["severity"] : "warning",
      detectedAt: typeof rec["detectedAt"] === "string" ? rec["detectedAt"] : null,
    });
  }

  const reconciliationRaw = v["reconciliation"];
  let reconciliation: ReconciliationSummary | null = null;
  if (reconciliationRaw !== null && typeof reconciliationRaw === "object") {
    const r = reconciliationRaw as Record<string, unknown>;
    const nums = [
      "totalClaims",
      "supportedClaims",
      "conflictingClaims",
      "unsupportedClaims",
      "parametricOnlyClaims",
      "meanConfidence",
    ] as const;
    if (nums.every((k) => typeof r[k] === "number")) {
      reconciliation = {
        totalClaims: r["totalClaims"] as number,
        supportedClaims: r["supportedClaims"] as number,
        conflictingClaims: r["conflictingClaims"] as number,
        unsupportedClaims: r["unsupportedClaims"] as number,
        parametricOnlyClaims: r["parametricOnlyClaims"] as number,
        meanConfidence: r["meanConfidence"] as number,
      };
    }
  }

  return {
    fusionId: v["fusionId"],
    workspaceId: v["workspaceId"],
    artifactId: v["artifactId"],
    state,
    jobId: typeof v["jobId"] === "string" ? v["jobId"] : null,
    conflicts,
    gaps,
    reconciliation,
    parametricUsed: v["parametricUsed"] === true,
    parametricModel:
      typeof v["parametricModel"] === "string" ? v["parametricModel"] : null,
    generatedAt:
      typeof v["generatedAt"] === "string" ? v["generatedAt"] : null,
    conflictsCount: v["conflictsCount"],
    gapsCount: v["gapsCount"],
    message: v["message"],
    notes: v["notes"] as readonly string[],
  };
}

function normaliseError(value: unknown, fallback: string): ErrorPayload {
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const code = typeof v["error"] === "string" ? v["error"] : "request_failed";
    const message =
      typeof v["message"] === "string" && v["message"].length > 0
        ? v["message"]
        : fallback;
    return { error: code, message };
  }
  return { error: "request_failed", message: fallback };
}

function severityBadgeStyle(severity: string): React.CSSProperties {
  const palette = (() => {
    switch (severity) {
      case "error":
      case "critical":
        return { bg: "#fee2e2", fg: "#7f1d1d" };
      case "warning":
      case "warn":
        return { bg: "#fef3c7", fg: "#92400e" };
      case "info":
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

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const cardStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
  maxWidth: 720,
};

const statusRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};

const sectionHeadingStyle: React.CSSProperties = {
  margin: "0 0 6px",
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const listItemStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#ffffff",
  marginBottom: 6,
};

const resolutionStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "6px 8px",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 4,
  fontSize: 12,
  color: "#1e3a8a",
};

const mutedStyle: React.CSSProperties = {
  color: "#64748b",
  fontSize: 12,
  margin: "4px 0",
};

const errorStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
  fontSize: 12,
};

const monoStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
};

const preStyle: React.CSSProperties = {
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

const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#1d4ed8",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
  textDecoration: "underline",
};
