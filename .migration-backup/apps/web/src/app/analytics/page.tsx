"use client";

/**
 * Zipy AI — Analytics & reporting dashboard (phase 23, batch 2).
 *
 * A client page that reads the four report kinds implemented in this batch
 * over the single JSON API endpoint:
 *
 *   GET /api/analytics/events?kind=usage|performance|content-gap|executive&window=7|30|90
 *
 * The page:
 *   - lets the analyst pick a report kind and a window (7 / 30 / 90 days);
 *   - renders the report using a per-kind renderer that switches on the
 *     envelope's `kind` field;
 *   - surfaces the report's own provenance + warnings so the reader knows
 *     when a metric was omitted because its input aggregation produced no
 *     data (nothing is silently defaulted to zero);
 *   - marks the executive summary as "AI-generated" when the server reported
 *     it was written by an LLM provider;
 *   - exposes "Download JSON" so an analyst can hand the exact report
 *     envelope to another tool without re-deriving it from the UI.
 *
 * Non-goals for this batch (documented so the UI does not pretend otherwise):
 *   - Charting. Numbers are shown as a labelled list, which the whole page
 *     can be read from without colour. A dedicated chart package is a
 *     later phase.
 *   - Editing or annotating a report. Reports are derived; if a metric looks
 *     wrong, the underlying guide or step must be inspected.
 *   - Real-time updates. Each "Refresh" issues a fresh request; there is no
 *     websocket push for analytics.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

/* -------------------------------------------------------------------------- */
/* Wire types (mirrored from @zipy/analytics/reports)                          */
/* -------------------------------------------------------------------------- */

const REPORT_KINDS = ["usage", "performance", "content-gap", "executive"] as const;
type ReportKind = (typeof REPORT_KINDS)[number];

const WINDOW_DAYS = [7, 30, 90] as const;
type WindowDays = (typeof WINDOW_DAYS)[number];

const REPORT_LABELS: Record<ReportKind, string> = {
  usage: "Usage",
  performance: "Performance",
  "content-gap": "Content gap",
  executive: "Executive summary",
};

interface ReportWindow {
  readonly fromIso: string;
  readonly toIso: string;
  readonly days: number;
}

interface ReportInputRef {
  readonly name: string;
  readonly generatedAt: string | null;
  readonly empty: boolean;
}

interface ReportBase {
  readonly kind: ReportKind;
  readonly generatedAt: string;
  readonly workspaceId: string;
  readonly window: ReportWindow;
  readonly inputs: readonly ReportInputRef[];
}

interface UsageRow {
  readonly guideId: string;
  readonly title: string;
  readonly views: number;
  readonly completions: number;
  readonly completionRate: number | null;
  readonly lastViewedAtIso: string | null;
}

interface UsageReport extends ReportBase {
  readonly kind: "usage";
  readonly guideCount: number;
  readonly publishedGuideCount: number | null;
  readonly totalViews: number;
  readonly uniqueViewers: number | null;
  readonly completions: number;
  readonly completionRate: number | null;
  readonly perGuide: readonly UsageRow[];
  readonly notes: readonly string[];
}

interface DropoffRow {
  readonly guideId: string;
  readonly stepIndex: number;
  readonly stepTitle: string | null;
  readonly reached: number;
  readonly dropped: number;
  readonly dropRate: number;
}

interface PerformanceReport extends ReportBase {
  readonly kind: "performance";
  readonly averageStepsCompleted: number | null;
  readonly worstDropOffSteps: readonly DropoffRow[];
  readonly goodCompletionGuides: readonly UsageRow[];
  readonly weakCompletionGuides: readonly UsageRow[];
  readonly notes: readonly string[];
}

interface GapQueryRow {
  readonly query: string;
  readonly count: number;
  readonly zeroResult: boolean;
}

interface LowRatedStepRow {
  readonly guideId: string;
  readonly stepIndex: number;
  readonly stepTitle: string | null;
  readonly averageRating: number;
  readonly negativeFeedback: number;
}

interface ContentGapReport extends ReportBase {
  readonly kind: "content-gap";
  readonly topUnmatchedQueries: readonly GapQueryRow[];
  readonly lowRatedSteps: readonly LowRatedStepRow[];
  readonly missingTopics: readonly string[];
  readonly notes: readonly string[];
}

interface ExecutiveReport extends ReportBase {
  readonly kind: "executive";
  readonly headline: string;
  readonly summary: string;
  readonly bullets: readonly string[];
  readonly generatedBy: "deterministic" | "llm";
  readonly usedProvider: string | null;
  readonly usedModel: string | null;
  readonly layerError: string | null;
}

type AnyReport = UsageReport | PerformanceReport | ContentGapReport | ExecutiveReport;

interface ScanInfo {
  readonly segmentsRead: number;
  readonly eventsRead: number;
  readonly truncated: boolean;
}

interface ProvenanceSummary {
  readonly sources: readonly ReportInputRef[];
  readonly missing: readonly string[];
  readonly aggregationErrors: readonly string[];
}

interface ReportEnvelope {
  readonly report: AnyReport;
  readonly provenance: ProvenanceSummary;
  readonly scan: ScanInfo;
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Load state                                                                  */
/* -------------------------------------------------------------------------- */

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly envelope: ReportEnvelope }
  | { readonly kind: "error"; readonly message: string; readonly code: string };

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function AnalyticsPage() {
  const [reportKind, setReportKind] = useState<ReportKind>("usage");
  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  const load = useCallback(
    async (signal: AbortSignal, kind: ReportKind, days: WindowDays): Promise<void> => {
      setState({ kind: "loading" });
      try {
        const url = `/api/analytics/events?kind=${encodeURIComponent(
          kind,
        )}&window=${encodeURIComponent(String(days))}`;
        const res = await fetch(url, {
          signal,
          headers: { accept: "application/json" },
        });
        const json: unknown = await res.json().catch(() => null);
        if (signal.aborted) return;
        if (!res.ok) {
          const error = json && typeof json === "object"
            ? (json as { error?: unknown; message?: unknown })
            : {};
          setState({
            kind: "error",
            code: typeof error.error === "string" ? error.error : "request_failed",
            message:
              typeof error.message === "string"
                ? error.message
                : `The report request failed with HTTP ${res.status}.`,
          });
          return;
        }
        const parsed = parseEnvelope(json);
        if (parsed === null) {
          setState({
            kind: "error",
            code: "unexpected_response",
            message:
              "The server returned a payload this page does not recognise. Check server logs.",
          });
          return;
        }
        setState({ kind: "ready", envelope: parsed });
      } catch (err) {
        if (signal.aborted) return;
        setState({
          kind: "error",
          code: "network_error",
          message:
            err instanceof Error
              ? `Could not reach the server: ${err.message}`
              : "Could not reach the server.",
        });
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal, reportKind, windowDays);
    return () => controller.abort();
  }, [load, reportKind, windowDays]);

  const downloadJson = useCallback(() => {
    if (state.kind !== "ready") return;
    const blob = new Blob([JSON.stringify(state.envelope, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zipy-${state.envelope.report.kind}-report.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [state]);

  const heading = useMemo(() => {
    if (state.kind !== "ready") return REPORT_LABELS[reportKind];
    const r = state.envelope.report;
    return `${REPORT_LABELS[r.kind]} · last ${r.window.days} days`;
  }, [state, reportKind]);

  return (
    <main style={pageStyle}>
      <h1 style={headingStyle}>Analytics</h1>
      <p style={subheadingStyle}>
        Reports are computed on demand from this workspace's recorded analytics
        events. No metric is a placeholder; missing inputs are surfaced in the
        provenance panel rather than shown as zero.
      </p>

      <section style={controlBarStyle} aria-label="Report controls">
        <label style={controlStyle}>
          <span style={controlLabelStyle}>Report</span>
          <select
            value={reportKind}
            onChange={(e) => setReportKind(e.target.value as ReportKind)}
            style={selectStyle}
          >
            {REPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {REPORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>

        <label style={controlStyle}>
          <span style={controlLabelStyle}>Window</span>
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value) as WindowDays)}
            style={selectStyle}
          >
            {WINDOW_DAYS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>

        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          <button
            type="button"
            onClick={() => {
              const controller = new AbortController();
              void load(controller.signal, reportKind, windowDays);
            }}
            disabled={state.kind === "loading"}
            style={secondaryButtonStyle}
          >
            {state.kind === "loading" ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={downloadJson}
            disabled={state.kind !== "ready"}
            style={{
              ...secondaryButtonStyle,
              cursor: state.kind !== "ready" ? "not-allowed" : "pointer",
              opacity: state.kind !== "ready" ? 0.6 : 1,
            }}
          >
            Download JSON
          </button>
        </div>
      </section>

      {state.kind === "loading" && (
        <div style={infoBoxStyle} role="status">
          Loading the {REPORT_LABELS[reportKind].toLowerCase()} report for the
          last {windowDays} days…
        </div>
      )}

      {state.kind === "error" && (
        <div style={errorBoxStyle} role="alert">
          <strong style={{ display: "block", marginBottom: 4 }}>{state.code}</strong>
          <span>{state.message}</span>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <h2 style={sectionHeadingStyle}>{heading}</h2>
          <ReportHeader report={state.envelope.report} scan={state.envelope.scan} />

          {state.envelope.warnings.length > 0 && (
            <div style={warnBoxStyle} role="alert">
              <strong style={{ display: "block", marginBottom: 4 }}>
                Partial data
              </strong>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {state.envelope.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <ReportBody report={state.envelope.report} />

          <ProvenancePanel provenance={state.envelope.provenance} />
        </>
      )}
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Header block                                                                */
/* -------------------------------------------------------------------------- */

function ReportHeader({
  report,
  scan,
}: {
  readonly report: AnyReport;
  readonly scan: ScanInfo;
}): JSX.Element {
  return (
    <dl style={metaGridStyle}>
      <MetaItem label="Generated at" value={formatIso(report.generatedAt)} />
      <MetaItem
        label="Window"
        value={`${formatIso(report.window.fromIso)} → ${formatIso(report.window.toIso)}`}
      />
      <MetaItem
        label="Events read"
        value={`${scan.eventsRead} event${scan.eventsRead === 1 ? "" : "s"} across ${scan.segmentsRead} segment${scan.segmentsRead === 1 ? "" : "s"}${scan.truncated ? " (truncated)" : ""}`}
      />
    </dl>
  );
}

function MetaItem({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div style={metaItemStyle}>
      <dt style={metaLabelStyle}>{label}</dt>
      <dd style={metaValueStyle}>{value}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Body dispatcher                                                             */
/* -------------------------------------------------------------------------- */

function ReportBody({ report }: { readonly report: AnyReport }): JSX.Element {
  switch (report.kind) {
    case "usage":
      return <UsageReportView report={report} />;
    case "performance":
      return <PerformanceReportView report={report} />;
    case "content-gap":
      return <ContentGapReportView report={report} />;
    case "executive":
      return <ExecutiveReportView report={report} />;
  }
}

/* -------------------------------------------------------------------------- */
/* Usage                                                                       */
/* -------------------------------------------------------------------------- */

function UsageReportView({ report }: { readonly report: UsageReport }): JSX.Element {
  return (
    <section>
      <StatRow
        items={[
          { label: "Guides with activity", value: String(report.guideCount) },
          {
            label: "Published guides",
            value:
              report.publishedGuideCount === null
                ? "not available"
                : String(report.publishedGuideCount),
          },
          { label: "Total views", value: String(report.totalViews) },
          {
            label: "Unique viewers",
            value:
              report.uniqueViewers === null
                ? "not available"
                : String(report.uniqueViewers),
          },
          { label: "Completions", value: String(report.completions) },
          {
            label: "Completion rate",
            value:
              report.completionRate === null
                ? "not available"
                : formatPercent(report.completionRate),
          },
        ]}
      />

      {report.perGuide.length === 0 ? (
        <EmptyState
          text="No guide recorded any activity in this window."
        />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Guide</th>
              <th style={thNumStyle}>Views</th>
              <th style={thNumStyle}>Completions</th>
              <th style={thNumStyle}>Completion rate</th>
              <th style={thStyle}>Last viewed</th>
            </tr>
          </thead>
          <tbody>
            {report.perGuide.map((row) => (
              <tr key={row.guideId}>
                <td style={tdStyle}>
                  <div style={guideTitleStyle}>{row.title}</div>
                  <div style={guideIdStyle}>{shortId(row.guideId)}</div>
                </td>
                <td style={tdNumStyle}>{row.views}</td>
                <td style={tdNumStyle}>{row.completions}</td>
                <td style={tdNumStyle}>
                  {row.completionRate === null
                    ? "—"
                    : formatPercent(row.completionRate)}
                </td>
                <td style={tdStyle}>
                  {row.lastViewedAtIso === null
                    ? "—"
                    : formatIso(row.lastViewedAtIso)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {report.notes.length > 0 && <NoteList notes={report.notes} />}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Performance                                                                 */
/* -------------------------------------------------------------------------- */

function PerformanceReportView({
  report,
}: {
  readonly report: PerformanceReport;
}): JSX.Element {
  return (
    <section>
      <StatRow
        items={[
          {
            label: "Average step reached",
            value:
              report.averageStepsCompleted === null
                ? "not available"
                : report.averageStepsCompleted.toFixed(1),
          },
          {
            label: "Guides with high completion",
            value: String(report.goodCompletionGuides.length),
          },
          {
            label: "Guides with low completion",
            value: String(report.weakCompletionGuides.length),
          },
          {
            label: "Worst drop-off points",
            value: String(report.worstDropOffSteps.length),
          },
        ]}
      />

      <h3 style={subHeadingStyle}>Worst drop-off steps</h3>
      {report.worstDropOffSteps.length === 0 ? (
        <EmptyState text="No per-step drop-off was recorded in this window." />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Guide</th>
              <th style={thStyle}>Step</th>
              <th style={thNumStyle}>Reached</th>
              <th style={thNumStyle}>Dropped</th>
              <th style={thNumStyle}>Drop rate</th>
            </tr>
          </thead>
          <tbody>
            {report.worstDropOffSteps.map((row) => (
              <tr key={`${row.guideId}-${row.stepIndex}`}>
                <td style={tdStyle}>
                  <div style={guideIdStyle}>{shortId(row.guideId)}</div>
                </td>
                <td style={tdStyle}>
                  {row.stepIndex}
                  {row.stepTitle !== null && (
                    <span style={{ color: "#475569" }}> — {row.stepTitle}</span>
                  )}
                </td>
                <td style={tdNumStyle}>{row.reached}</td>
                <td style={tdNumStyle}>{row.dropped}</td>
                <td style={tdNumStyle}>{formatPercent(row.dropRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={subHeadingStyle}>Guides with the strongest completion</h3>
      {report.goodCompletionGuides.length === 0 ? (
        <EmptyState text="No guide met the high-completion threshold in this window." />
      ) : (
        <ul style={listStyle}>
          {report.goodCompletionGuides.map((g) => (
            <li key={g.guideId}>
              <span style={guideTitleStyle}>{g.title}</span>{" "}
              <span style={{ color: "#475569" }}>
                {g.completionRate === null
                  ? ""
                  : `(${formatPercent(g.completionRate)})`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {report.weakCompletionGuides.length > 0 && (
        <>
          <h3 style={subHeadingStyle}>Guides needing attention</h3>
          <ul style={listStyle}>
            {report.weakCompletionGuides.map((g) => (
              <li key={g.guideId}>
                <span style={guideTitleStyle}>{g.title}</span>{" "}
                <span style={{ color: "#475569" }}>
                  {g.completionRate === null
                    ? ""
                    : `(${formatPercent(g.completionRate)})`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {report.notes.length > 0 && <NoteList notes={report.notes} />}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Content gap                                                                 */
/* -------------------------------------------------------------------------- */

function ContentGapReportView({
  report,
}: {
  readonly report: ContentGapReport;
}): JSX.Element {
  return (
    <section>
      <StatRow
        items={[
          {
            label: "Unmatched searches",
            value: String(report.topUnmatchedQueries.length),
          },
          {
            label: "Low-rated steps",
            value: String(report.lowRatedSteps.length),
          },
          {
            label: "Distinct missing topics",
            value: String(report.missingTopics.length),
          },
        ]}
      />

      <h3 style={subHeadingStyle}>Unmatched searches</h3>
      {report.topUnmatchedQueries.length === 0 ? (
        <EmptyState text="No search returned zero results in this window." />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Query</th>
              <th style={thNumStyle}>Times searched</th>
            </tr>
          </thead>
          <tbody>
            {report.topUnmatchedQueries.map((row) => (
              <tr key={row.query}>
                <td style={tdStyle}>{row.query}</td>
                <td style={tdNumStyle}>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={subHeadingStyle}>Low-rated steps</h3>
      {report.lowRatedSteps.length === 0 ? (
        <EmptyState text="No step was rated below the low-rating threshold." />
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Guide</th>
              <th style={thStyle}>Step</th>
              <th style={thNumStyle}>Avg. rating</th>
              <th style={thNumStyle}>Negative feedback</th>
            </tr>
          </thead>
          <tbody>
            {report.lowRatedSteps.map((row) => (
              <tr key={`${row.guideId}-${row.stepIndex}`}>
                <td style={tdStyle}>
                  <div style={guideIdStyle}>{shortId(row.guideId)}</div>
                </td>
                <td style={tdStyle}>
                  {row.stepIndex}
                  {row.stepTitle !== null && (
                    <span style={{ color: "#475569" }}> — {row.stepTitle}</span>
                  )}
                </td>
                <td style={tdNumStyle}>{row.averageRating.toFixed(1)}</td>
                <td style={tdNumStyle}>{row.negativeFeedback}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {report.missingTopics.length > 0 && (
        <>
          <h3 style={subHeadingStyle}>Suggested new topics</h3>
          <ul style={listStyle}>
            {report.missingTopics.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </>
      )}

      {report.notes.length > 0 && <NoteList notes={report.notes} />}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Executive                                                                   */
/* -------------------------------------------------------------------------- */

function ExecutiveReportView({
  report,
}: {
  readonly report: ExecutiveReport;
}): JSX.Element {
  return (
    <section>
      <h3 style={subHeadingStyle}>{report.headline}</h3>
      <p style={paragraphStyle}>{report.summary}</p>

      <dl style={metaGridStyle}>
        <MetaItem
          label="Written by"
          value={
            report.generatedBy === "llm"
              ? `LLM${report.usedProvider ? ` (${report.usedProvider}${report.usedModel ? ` / ${report.usedModel}` : ""})` : ""}`
              : "Deterministic composer"
          }
        />
        <MetaItem
          label="AI disclosure"
          value={
            report.generatedBy === "llm"
              ? "AI-generated. Review before acting on it."
              : "Deterministic summary from recorded metrics; no AI text was produced."
          }
        />
      </dl>

      <h3 style={subHeadingStyle}>Metrics referenced</h3>
      <ul style={listStyle}>
        {report.bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>

      {report.layerError !== null && (
        <div style={warnBoxStyle} role="alert">
          <strong style={{ display: "block", marginBottom: 4 }}>
            LLM layer
          </strong>
          <span>{report.layerError}</span>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

function ProvenancePanel({
  provenance,
}: {
  readonly provenance: ProvenanceSummary;
}): JSX.Element {
  return (
    <section style={provenanceStyle}>
      <h3 style={subHeadingStyle}>Provenance</h3>
      <p style={{ margin: "0 0 8px", color: "#475569", fontSize: 12 }}>
        Every report is derived only from the aggregations below. An input
        marked &ldquo;empty&rdquo; contributed no events in the selected window;
        a metric that depends on an empty input is shown as unavailable rather
        than as zero.
      </p>
      <ul style={listStyle}>
        {provenance.sources.map((s) => (
          <li key={s.name}>
            <code style={codeStyle}>{s.name}</code>{" "}
            {s.empty ? (
              <span style={{ color: "#b45309" }}>empty</span>
            ) : (
              <span style={{ color: "#15803d" }}>present</span>
            )}
            {s.generatedAt !== null && (
              <span style={{ color: "#64748b" }}> · {formatIso(s.generatedAt)}</span>
            )}
          </li>
        ))}
      </ul>
      {provenance.aggregationErrors.length > 0 && (
        <div style={warnBoxStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            Aggregation errors
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {provenance.aggregationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared widgets                                                              */
/* -------------------------------------------------------------------------- */

function StatRow({
  items,
}: {
  readonly items: readonly { readonly label: string; readonly value: string }[];
}): JSX.Element {
  return (
    <div style={statRowStyle}>
      {items.map((i) => (
        <div key={i.label} style={statCardStyle}>
          <div style={statLabelStyle}>{i.label}</div>
          <div style={statValueStyle}>{i.value}</div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ text }: { readonly text: string }): JSX.Element {
  return <div style={emptyStateStyle}>{text}</div>;
}

function NoteList({ notes }: { readonly notes: readonly string[] }): JSX.Element {
  return (
    <div style={noteStyle}>
      <strong style={{ display: "block", marginBottom: 4 }}>Notes</strong>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Envelope parsing                                                            */
/* -------------------------------------------------------------------------- */

function parseEnvelope(value: unknown): ReportEnvelope | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const reportRaw = v["report"];
  if (reportRaw === null || typeof reportRaw !== "object") return null;
  const report = parseReport(reportRaw);
  if (report === null) return null;

  const provenance = parseProvenance(v["provenance"]);
  const scan = parseScan(v["scan"]);
  const warningsRaw = v["warnings"];
  const warnings = Array.isArray(warningsRaw)
    ? warningsRaw.filter((x): x is string => typeof x === "string")
    : [];
  return { report, provenance, scan, warnings };
}

function parseReport(value: unknown): AnyReport | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const kind = v["kind"];
  if (kind !== "usage" && kind !== "performance" && kind !== "content-gap" && kind !== "executive") {
    return null;
  }
  const base = parseBase(v, kind);
  if (base === null) return null;

  if (kind === "usage") {
    const perGuideRaw = v["perGuide"];
    if (!Array.isArray(perGuideRaw)) return null;
    const perGuide: UsageRow[] = [];
    for (const row of perGuideRaw) {
      const parsed = parseUsageRow(row);
      if (parsed === null) return null;
      perGuide.push(parsed);
    }
    return {
      ...base,
      kind: "usage",
      guideCount: readNum(v, "guideCount") ?? 0,
      publishedGuideCount: readNullableNum(v, "publishedGuideCount"),
      totalViews: readNum(v, "totalViews") ?? 0,
      uniqueViewers: readNullableNum(v, "uniqueViewers"),
      completions: readNum(v, "completions") ?? 0,
      completionRate: readNullableNum(v, "completionRate"),
      perGuide,
      notes: readStringArray(v, "notes"),
    };
  }

  if (kind === "performance") {
    const worstRaw = v["worstDropOffSteps"];
    if (!Array.isArray(worstRaw)) return null;
    const worst: DropoffRow[] = [];
    for (const row of worstRaw) {
      const parsed = parseDropoffRow(row);
      if (parsed === null) return null;
      worst.push(parsed);
    }
    const good = parseUsageRows(v["goodCompletionGuides"]);
    const weak = parseUsageRows(v["weakCompletionGuides"]);
    if (good === null || weak === null) return null;
    return {
      ...base,
      kind: "performance",
      averageStepsCompleted: readNullableNum(v, "averageStepsCompleted"),
      worstDropOffSteps: worst,
      goodCompletionGuides: good,
      weakCompletionGuides: weak,
      notes: readStringArray(v, "notes"),
    };
  }

  if (kind === "content-gap") {
    const queriesRaw = v["topUnmatchedQueries"];
    if (!Array.isArray(queriesRaw)) return null;
    const queries: GapQueryRow[] = [];
    for (const row of queriesRaw) {
      const parsed = parseGapQuery(row);
      if (parsed === null) return null;
      queries.push(parsed);
    }
    const ratedRaw = v["lowRatedSteps"];
    if (!Array.isArray(ratedRaw)) return null;
    const rated: LowRatedStepRow[] = [];
    for (const row of ratedRaw) {
      const parsed = parseLowRatedStep(row);
      if (parsed === null) return null;
      rated.push(parsed);
    }
    return {
      ...base,
      kind: "content-gap",
      topUnmatchedQueries: queries,
      lowRatedSteps: rated,
      missingTopics: readStringArray(v, "missingTopics"),
      notes: readStringArray(v, "notes"),
    };
  }

  // executive
  const generatedBy = v["generatedBy"] === "llm" ? "llm" : "deterministic";
  return {
    ...base,
    kind: "executive",
    headline: readString(v, "headline") ?? "",
    summary: readString(v, "summary") ?? "",
    bullets: readStringArray(v, "bullets"),
    generatedBy,
    usedProvider: readNullableString(v, "usedProvider"),
    usedModel: readNullableString(v, "usedModel"),
    layerError: readNullableString(v, "layerError"),
  };
}

function parseBase(
  v: Readonly<Record<string, unknown>>,
  kind: ReportKind,
): ReportBase | null {
  const generatedAt = readString(v, "generatedAt");
  const workspaceId = readString(v, "workspaceId");
  const window = parseWindow(v["window"]);
  const inputs = parseInputRefs(v["inputs"]);
  if (generatedAt === null || workspaceId === null || window === null || inputs === null) {
    return null;
  }
  return { kind, generatedAt, workspaceId, window, inputs };
}

function parseWindow(value: unknown): ReportWindow | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const fromIso = readString(v, "fromIso");
  const toIso = readString(v, "toIso");
  const days = readNum(v, "days");
  if (fromIso === null || toIso === null || days === null) return null;
  return { fromIso, toIso, days };
}

function parseInputRefs(value: unknown): readonly ReportInputRef[] | null {
  if (!Array.isArray(value)) return null;
  const out: ReportInputRef[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const v = entry as Record<string, unknown>;
    const name = readString(v, "name");
    if (name === null) return null;
    out.push({
      name,
      generatedAt: readNullableString(v, "generatedAt"),
      empty: v["empty"] === true,
    });
  }
  return out;
}

function parseUsageRow(value: unknown): UsageRow | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const guideId = readString(v, "guideId");
  const title = readString(v, "title") ?? "";
  const views = readNum(v, "views");
  const completions = readNum(v, "completions");
  if (guideId === null || views === null || completions === null) return null;
  return {
    guideId,
    title,
    views,
    completions,
    completionRate: readNullableNum(v, "completionRate"),
    lastViewedAtIso: readNullableString(v, "lastViewedAtIso"),
  };
}

function parseUsageRows(value: unknown): readonly UsageRow[] | null {
  if (!Array.isArray(value)) return null;
  const out: UsageRow[] = [];
  for (const row of value) {
    const parsed = parseUsageRow(row);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function parseDropoffRow(value: unknown): DropoffRow | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const guideId = readString(v, "guideId");
  const stepIndex = readNum(v, "stepIndex");
  const reached = readNum(v, "reached");
  const dropped = readNum(v, "dropped");
  const dropRate = readNum(v, "dropRate");
  if (
    guideId === null ||
    stepIndex === null ||
    reached === null ||
    dropped === null ||
    dropRate === null
  ) {
    return null;
  }
  return {
    guideId,
    stepIndex,
    stepTitle: readNullableString(v, "stepTitle"),
    reached,
    dropped,
    dropRate,
  };
}

function parseGapQuery(value: unknown): GapQueryRow | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const query = readString(v, "query");
  const count = readNum(v, "count");
  if (query === null || count === null) return null;
  return { query, count, zeroResult: v["zeroResult"] === true };
}

function parseLowRatedStep(value: unknown): LowRatedStepRow | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const guideId = readString(v, "guideId");
  const stepIndex = readNum(v, "stepIndex");
  const averageRating = readNum(v, "averageRating");
  const negativeFeedback = readNum(v, "negativeFeedback");
  if (
    guideId === null ||
    stepIndex === null ||
    averageRating === null ||
    negativeFeedback === null
  ) {
    return null;
  }
  return {
    guideId,
    stepIndex,
    stepTitle: readNullableString(v, "stepTitle"),
    averageRating,
    negativeFeedback,
  };
}

function parseProvenance(value: unknown): ProvenanceSummary {
  const empty: ProvenanceSummary = {
    sources: [],
    missing: [],
    aggregationErrors: [],
  };
  if (value === null || typeof value !== "object") return empty;
  const v = value as Record<string, unknown>;
  const sources = parseInputRefs(v["sources"]) ?? [];
  const missing = readStringArray(v, "missing");
  const aggregationErrors = readStringArray(v, "aggregationErrors");
  return { sources, missing, aggregationErrors };
}

function parseScan(value: unknown): ScanInfo {
  if (value === null || typeof value !== "object") {
    return { segmentsRead: 0, eventsRead: 0, truncated: false };
  }
  const v = value as Record<string, unknown>;
  return {
    segmentsRead: readNum(v, "segmentsRead") ?? 0,
    eventsRead: readNum(v, "eventsRead") ?? 0,
    truncated: v["truncated"] === true,
  };
}

/* -------------------------------------------------------------------------- */
/* Primitive readers                                                           */
/* -------------------------------------------------------------------------- */

function readString(v: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = v[key];
  return typeof value === "string" ? value : null;
}

function readNullableString(
  v: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = v[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}

function readNum(v: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = v[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNullableNum(
  v: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = v[key];
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(
  v: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = v[key];
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace("Z", " UTC");
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const pageStyle: CSSProperties = {
  maxWidth: 1100,
  margin: "0 auto",
  padding: "8px 4px 48px",
  fontFamily:
    "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  color: "#0f172a",
};

const headingStyle: CSSProperties = {
  margin: "8px 0 4px",
  fontSize: 22,
  fontWeight: 700,
};

const subheadingStyle: CSSProperties = {
  margin: "0 0 16px",
  color: "#475569",
  fontSize: 13,
  maxWidth: 720,
};

const sectionHeadingStyle: CSSProperties = {
  margin: "24px 0 12px",
  fontSize: 16,
  fontWeight: 600,
};

const subHeadingStyle: CSSProperties = {
  margin: "20px 0 8px",
  fontSize: 14,
  fontWeight: 600,
};

const controlBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 16,
  padding: "12px 16px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  marginBottom: 16,
};

const controlStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const controlLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const selectStyle: CSSProperties = {
  padding: "6px 8px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  cursor: "pointer",
};

const infoBoxStyle: CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#f1f5f9",
  color: "#334155",
  fontSize: 13,
  marginBottom: 12,
};

const errorBoxStyle: CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
  fontSize: 13,
  marginBottom: 12,
};

const warnBoxStyle: CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #fde68a",
  borderRadius: 6,
  background: "#fffbeb",
  color: "#78350f",
  fontSize: 13,
  marginBottom: 12,
};

const noteStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#f8fafc",
  color: "#334155",
  fontSize: 12,
};

const emptyStateStyle: CSSProperties = {
  padding: "12px 14px",
  border: "1px dashed #cbd5e1",
  borderRadius: 8,
  color: "#64748b",
  fontSize: 13,
};

const statRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 10,
  marginBottom: 16,
};

const statCardStyle: CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#ffffff",
};

const statLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  marginBottom: 4,
};

const statValueStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  color: "#0f172a",
};

const metaGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 8,
  margin: 0,
  padding: 0,
  marginBottom: 16,
};

const metaItemStyle: CSSProperties = {
  padding: "6px 10px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  margin: 0,
};

const metaLabelStyle: CSSProperties = {
  fontSize: 10,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  margin: 0,
};

const metaValueStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "#0f172a",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  overflow: "hidden",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid #e2e8f0",
  background: "#f8fafc",
  fontWeight: 600,
  fontSize: 12,
  color: "#334155",
};

const thNumStyle: CSSProperties = {
  ...thStyle,
  textAlign: "right",
};

const tdStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
};

const tdNumStyle: CSSProperties = {
  ...tdStyle,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

const guideTitleStyle: CSSProperties = {
  fontWeight: 500,
};

const guideIdStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 11,
  color: "#64748b",
};

const listStyle: CSSProperties = {
  margin: "0 0 12px",
  paddingLeft: 18,
  fontSize: 13,
  lineHeight: 1.6,
};

const paragraphStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 14,
  lineHeight: 1.6,
  maxWidth: 780,
};

const provenanceStyle: CSSProperties = {
  marginTop: 24,
  padding: "12px 14px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#f8fafc",
};

const codeStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
  background: "#e2e8f0",
  padding: "1px 4px",
  borderRadius: 3,
};
