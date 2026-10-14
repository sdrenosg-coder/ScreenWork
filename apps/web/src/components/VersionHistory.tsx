"use client";

/**
 * VersionHistory — reviewer-facing panel listing a guide's saved versions.
 *
 * Read model (this file owns the contract; API routes are supplied elsewhere):
 *   GET  /api/guides/{guideId}/versions
 *     -> 200 {
 *          guideId, workspaceId, current: number,
 *          versions: VersionSummary[], message, notes: string[]
 *        }
 *     -> 4xx { error, message, field? }
 *
 *   POST /api/guides/{guideId}/versions/{version}/restore
 *     -> 200 {
 *          guideId, workspaceId, restoredFromVersion, newVersionIndex,
 *          guide, message, notes[]
 *        }
 *     -> 4xx { error, message, field? }
 *
 * VersionSummary is parsed defensively; unknown fields are preserved under
 * `extra`. Fields the panel does not understand are still rendered where
 * they carry a string value, so a server that adds fields stays legible.
 *
 * Deliberate non-goals:
 *   - This panel does not compute diffs. The server supplies
 *     `changeSummary` when it has one; the panel never invents it.
 *   - It does not mutate step arrays. After a successful restore it hands
 *     the entire parsed `guide` document to the parent via `onRestored` so
 *     the parent editor controls the reload.
 *   - Screenshot bytes are not fetched here. If the API supplies a
 *     thumbnail URL, it is rendered as an image; otherwise the panel says
 *     "no thumbnail supplied".
 *   - It never assumes a version is safe to restore silently. A confirmation
 *     step gates every restore.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

type VersionStatus = "current" | "review" | "auto" | "archived";

interface ChangeSummary {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly title: string | null;
  readonly note: string | null;
}

interface VersionSummary {
  readonly version: number;
  readonly isCurrent: boolean;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly createdByDisplay: string | null;
  readonly note: string | null;
  readonly status: VersionStatus | null;
  readonly contentHash: string | null;
  readonly changeSummary: ChangeSummary | null;
  readonly thumbnailUrl: string | null;
  /** Any extra fields the server supplied, rendered read-only. */
  readonly extra: Readonly<Record<string, unknown>>;
}

interface VersionsResponse {
  readonly guideId: string;
  readonly workspaceId: string;
  readonly current: number;
  readonly versions: readonly VersionSummary[];
  readonly message: string;
  readonly notes: readonly string[];
}

interface RestoreResponse {
  readonly guideId: string;
  readonly workspaceId: string;
  readonly restoredFromVersion: number;
  readonly newVersionIndex: number;
  readonly guide: unknown;
  readonly message: string;
  readonly notes: readonly string[];
}

interface ApiError {
  readonly error: string;
  readonly message: string;
  readonly field?: string;
}

export interface VersionHistoryProps {
  /** Guide UUID. Malformed ids short-circuit without an API call. */
  readonly guideId: string;
  /** When true the restore action is disabled and a banner explains why. */
  readonly readOnly?: boolean;
  /**
   * Called with the new guide document after a successful restore. The
   * parent uses this to refresh its editor state; this panel does not
   * mutate the parent's state directly.
   */
  readonly onRestored?: (
    guide: unknown,
    restoredFrom: number,
    newVersionIndex: number,
  ) => void;
  /**
   * Fires whenever the panel's busy state toggles so the parent can
   * coordinate (e.g. disable its Save button during a restore).
   */
  readonly onBusyChange?: (busy: boolean) => void;
}

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: VersionsResponse }
  | { readonly kind: "error"; readonly error: ApiError };

interface Outcome {
  readonly kind: "success" | "error";
  readonly message: string;
  readonly details: readonly string[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export default function VersionHistory({
  guideId,
  readOnly = false,
  onRestored,
  onBusyChange,
}: VersionHistoryProps) {
  const idValid = UUID_PATTERN.test(guideId);

  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [confirmingVersion, setConfirmingVersion] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Busy reporting: driven by an effect so a mid-flight unmount still
  // flushes a final `false` to the parent.
  const busyRef = useRef(false);
  useEffect(() => {
    const busy = restoringVersion !== null;
    if (busy === busyRef.current) return;
    busyRef.current = busy;
    onBusyChange?.(busy);
  }, [restoringVersion, onBusyChange]);
  useEffect(() => {
    return () => {
      if (busyRef.current) onBusyChange?.(false);
    };
  }, [onBusyChange]);

  /* ------------------------------- load ---------------------------------- */

  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      if (!idValid) {
        setState({
          kind: "error",
          error: {
            error: "invalid_guide_id",
            field: "guideId",
            message:
              "guideId must be a UUID. The panel will not call the API with a malformed id.",
          },
        });
        return;
      }
      setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
      setOutcome(null);
      try {
        const res = await fetch(
          `/api/guides/${encodeURIComponent(guideId)}/versions`,
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
        const parsed = parseVersionsResponse(json);
        if (parsed === null) {
          setState({
            kind: "error",
            error: {
              error: "unexpected_response",
              message:
                "The server returned a versions payload this panel does not recognise. Check server logs.",
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
    [guideId, idValid],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /* ------------------------------ restore -------------------------------- */

  const submitRestore = useCallback(
    async (version: number) => {
      if (readOnly) {
        setConfirmingVersion(null);
        return;
      }
      setConfirmingVersion(null);
      setRestoringVersion(version);
      setOutcome(null);
      try {
        const res = await fetch(
          `/api/guides/${encodeURIComponent(guideId)}/versions/${version}/restore`,
          {
            method: "POST",
            headers: { accept: "application/json" },
          },
        );
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const err = normaliseError(json, `Restore failed with HTTP ${res.status}.`);
          setOutcome({
            kind: "error",
            message: `${err.error}: ${err.message}`,
            details:
              err.field !== undefined
                ? [`field: ${err.field}`]
                : [],
          });
          return;
        }
        const parsed = parseRestoreResponse(json);
        if (parsed === null) {
          setOutcome({
            kind: "error",
            message:
              "The server accepted the restore but returned an unrecognised payload. Reload to confirm.",
            details: [],
          });
          return;
        }
        setOutcome({
          kind: "success",
          message: parsed.message,
          details: [
            `Restored from version ${parsed.restoredFromVersion}.`,
            `New version index: ${parsed.newVersionIndex}.`,
            ...parsed.notes,
          ],
        });
        onRestored?.(
          parsed.guide,
          parsed.restoredFromVersion,
          parsed.newVersionIndex,
        );
        // Refresh the version list so the newly-created version appears
        // and the "current" flag moves.
        const controller = new AbortController();
        void load(controller.signal);
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
        setRestoringVersion(null);
      }
    },
    [guideId, readOnly, onRestored, load],
  );

  /* ------------------------------- render -------------------------------- */

  const header = useMemo(() => {
    if (state.kind === "idle" || state.kind === "loading") {
      return <span style={pendingBadgeStyle}>loading</span>;
    }
    if (state.kind === "error") {
      return <span style={failedBadgeStyle}>error</span>;
    }
    const n = state.data.versions.length;
    return (
      <span style={okBadgeStyle}>
        {n} version{n === 1 ? "" : "s"}
      </span>
    );
  }, [state]);

  const body = useMemo(() => {
    if (state.kind === "idle" || state.kind === "loading") {
      return <p style={mutedStyle}>Loading version history…</p>;
    }
    if (state.kind === "error") {
      return (
        <div role="alert" style={errorStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            {state.error.error}
          </strong>
          <span>{state.error.message}</span>
          {state.error.field !== undefined && (
            <span style={{ marginLeft: 6 }}>(field: {state.error.field})</span>
          )}
        </div>
      );
    }
    const { data } = state;
    if (data.versions.length === 0) {
      return (
        <p style={mutedStyle}>
          No saved versions yet. Saving the guide creates the first version.
        </p>
      );
    }
    return (
      <>
        <p style={{ margin: "4px 0 8px", color: "#475569", fontSize: 12 }}>
          {data.message}
        </p>
        <ol style={listStyle}>
          {data.versions.map((v) => (
            <VersionRow
              key={v.version}
              version={v}
              isCurrentIndex={v.version === data.current}
              readOnly={readOnly}
              restoring={restoringVersion === v.version}
              confirming={confirmingVersion === v.version}
              onAskRestore={() => setConfirmingVersion(v.version)}
              onCancelRestore={() => setConfirmingVersion(null)}
              onConfirmRestore={() => void submitRestore(v.version)}
            />
          ))}
        </ol>
        {data.notes.length > 0 && (
          <ul style={noteListStyle}>
            {data.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </>
    );
  }, [state, readOnly, restoringVersion, confirmingVersion, submitRestore]);

  return (
    <section aria-labelledby="zipy-version-history-heading" style={cardStyle}>
      <header style={headerRowStyle}>
        <div>
          <h2
            id="zipy-version-history-heading"
            style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
          >
            Version history
          </h2>
          <p style={{ margin: "2px 0 0", color: "#475569", fontSize: 12 }}>
            Guide <code style={monoStyle}>{guideId}</code>
            {readOnly ? " · read-only" : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {header}
          <button
            type="button"
            onClick={() => {
              const controller = new AbortController();
              void load(controller.signal);
            }}
            disabled={restoringVersion !== null}
            style={linkButtonStyle}
          >
            Reload
          </button>
        </div>
      </header>

      {body}

      {outcome !== null && (
        <div
          role={outcome.kind === "error" ? "alert" : "status"}
          style={outcome.kind === "error" ? errorStyle : successStyle}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            {outcome.kind === "error" ? "Restore failed" : "Restored"}
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
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Row                                                                         */
/* -------------------------------------------------------------------------- */

interface VersionRowProps {
  readonly version: VersionSummary;
  readonly isCurrentIndex: boolean;
  readonly readOnly: boolean;
  readonly restoring: boolean;
  readonly confirming: boolean;
  readonly onAskRestore: () => void;
  readonly onCancelRestore: () => void;
  readonly onConfirmRestore: () => void;
}

function VersionRow({
  version,
  isCurrentIndex,
  readOnly,
  restoring,
  confirming,
  onAskRestore,
  onCancelRestore,
  onConfirmRestore,
}: VersionRowProps) {
  const isCurrent = version.isCurrent || isCurrentIndex;
  const disabled = readOnly || restoring || isCurrent;
  const extraEntries = Object.entries(version.extra);
  return (
    <li style={rowStyle}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={versionBadgeStyle}>v{version.version}</span>
        <span style={{ fontSize: 13, color: "#0f172a", fontWeight: 600 }}>
          {formatIso(version.createdAt)}
        </span>
        {version.createdByDisplay !== null ? (
          <span style={{ fontSize: 12, color: "#475569" }}>
            by {version.createdByDisplay}
          </span>
        ) : version.createdBy !== null ? (
          <span style={{ fontSize: 12, color: "#475569" }}>
            by <code style={monoStyle}>{version.createdBy}</code>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#64748b" }}>author unknown</span>
        )}
        {isCurrent && <span style={currentBadgeStyle}>current</span>}
        {version.status !== null && version.status !== "current" && (
          <span style={statusBadgeStyle(version.status)}>{version.status}</span>
        )}
        <span style={{ flex: 1 }} />
        {!isCurrent && (
          <button
            type="button"
            onClick={onAskRestore}
            disabled={disabled}
            style={{
              ...restoreButtonStyle,
              background: disabled ? "#f1f5f9" : "#ffffff",
              color: disabled ? "#94a3b8" : "#1d4ed8",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
            title={
              readOnly
                ? "Restore is disabled in read-only mode."
                : "Restore this version. Creates a new version with the same content."
            }
          >
            {restoring ? "Restoring…" : "Restore"}
          </button>
        )}
      </div>

      {version.note !== null && (
        <p style={{ ...mutedStyle, marginTop: 4 }}>Note: {version.note}</p>
      )}

      {version.changeSummary !== null && (
        <ChangeSummaryView summary={version.changeSummary} />
      )}

      {version.contentHash !== null && (
        <p style={{ ...mutedStyle, marginTop: 4 }}>
          Hash: <code style={monoStyle}>{version.contentHash}</code>
        </p>
      )}

      {version.thumbnailUrl !== null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={version.thumbnailUrl}
          alt={`Thumbnail for version ${version.version}`}
          style={thumbnailStyle}
        />
      ) : (
        <p style={{ ...mutedStyle, marginTop: 4 }}>No thumbnail supplied.</p>
      )}

      {extraEntries.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 12, color: "#475569", cursor: "pointer" }}>
            Additional fields ({extraEntries.length})
          </summary>
          <dl style={extraListStyle}>
            {extraEntries.map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 6 }}>
                <dt style={{ color: "#64748b", minWidth: 120 }}>{k}</dt>
                <dd style={{ margin: 0, wordBreak: "break-word" }}>
                  {renderExtraValue(v)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {confirming && (
        <div role="dialog" aria-modal="true" style={confirmStyle}>
          <p style={{ margin: "0 0 8px", fontSize: 13 }}>
            Restore version {version.version}? This appends a new version with
            the same content; existing versions are not removed.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onConfirmRestore} style={primaryButtonStyle}>
              Confirm restore
            </button>
            <button type="button" onClick={onCancelRestore} style={linkButtonStyle}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function ChangeSummaryView({ summary }: { readonly summary: ChangeSummary }) {
  const hasAny =
    summary.added.length > 0 ||
    summary.changed.length > 0 ||
    summary.removed.length > 0 ||
    (summary.title !== null && summary.title.length > 0) ||
    (summary.note !== null && summary.note.length > 0);
  if (!hasAny) {
    return (
      <p style={{ ...mutedStyle, marginTop: 4 }}>
        No change summary was recorded for this version.
      </p>
    );
  }
  return (
    <div style={summaryBlockStyle}>
      {summary.title !== null && summary.title.length > 0 && (
        <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600, color: "#0f172a" }}>
          {summary.title}
        </p>
      )}
      <div style={summaryGridStyle}>
        <SummaryBucket label="Added" ids={summary.added} tone="add" />
        <SummaryBucket label="Changed" ids={summary.changed} tone="change" />
        <SummaryBucket label="Removed" ids={summary.removed} tone="remove" />
      </div>
      {summary.note !== null && summary.note.length > 0 && (
        <p style={{ ...mutedStyle, marginTop: 4 }}>{summary.note}</p>
      )}
    </div>
  );
}

function SummaryBucket({
  label,
  ids,
  tone,
}: {
  readonly label: string;
  readonly ids: readonly string[];
  readonly tone: "add" | "change" | "remove";
}) {
  const palette = (() => {
    switch (tone) {
      case "add":
        return { bg: "#dcfce7", fg: "#166534" };
      case "change":
        return { bg: "#dbeafe", fg: "#1e3a8a" };
      case "remove":
        return { bg: "#fee2e2", fg: "#7f1d1d" };
    }
  })();
  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ color: "#64748b", marginBottom: 2 }}>
        {label} ({ids.length})
      </div>
      {ids.length === 0 ? (
        <span style={{ color: "#94a3b8" }}>—</span>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {ids.map((id) => (
            <code
              key={id}
              style={{
                background: palette.bg,
                color: palette.fg,
                padding: "1px 6px",
                borderRadius: 4,
                fontSize: 11,
              }}
            >
              {id}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseVersionsResponse(value: unknown): VersionsResponse | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["guideId"] !== "string" ||
    typeof v["workspaceId"] !== "string" ||
    typeof v["message"] !== "string" ||
    typeof v["current"] !== "number" ||
    !Number.isFinite(v["current"])
  ) {
    return null;
  }
  if (!Array.isArray(v["versions"])) return null;
  const notesRaw = v["notes"];
  if (!isStringArray(notesRaw)) return null;

  const versions: VersionSummary[] = [];
  for (const raw of v["versions"] as readonly unknown[]) {
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (
      typeof r["version"] !== "number" ||
      !Number.isFinite(r["version"]) ||
      typeof r["createdAt"] !== "string"
    ) {
      return null;
    }
    versions.push(parseVersionSummary(r));
  }
  return {
    guideId: v["guideId"],
    workspaceId: v["workspaceId"],
    current: Math.trunc(v["current"] as number),
    versions,
    message: v["message"],
    notes: notesRaw,
  };
}

const KNOWN_VERSION_KEYS = new Set([
  "version",
  "isCurrent",
  "createdAt",
  "createdBy",
  "createdByDisplay",
  "note",
  "status",
  "contentHash",
  "changeSummary",
  "thumbnailUrl",
]);

function parseVersionSummary(r: Record<string, unknown>): VersionSummary {
  const statusRaw = r["status"];
  const status: VersionStatus | null =
    statusRaw === "current" ||
    statusRaw === "review" ||
    statusRaw === "auto" ||
    statusRaw === "archived"
      ? statusRaw
      : null;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (!KNOWN_VERSION_KEYS.has(k)) extra[k] = v;
  }
  return {
    version: Math.trunc(r["version"] as number),
    isCurrent: r["isCurrent"] === true,
    createdAt: r["createdAt"] as string,
    createdBy: typeof r["createdBy"] === "string" ? r["createdBy"] : null,
    createdByDisplay:
      typeof r["createdByDisplay"] === "string" ? r["createdByDisplay"] : null,
    note: typeof r["note"] === "string" ? r["note"] : null,
    status,
    contentHash:
      typeof r["contentHash"] === "string" ? r["contentHash"] : null,
    changeSummary: parseChangeSummary(r["changeSummary"]),
    thumbnailUrl:
      typeof r["thumbnailUrl"] === "string" ? r["thumbnailUrl"] : null,
    extra,
  };
}

function parseChangeSummary(value: unknown): ChangeSummary | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    added: isStringArray(v["added"]) ? v["added"] : [],
    changed: isStringArray(v["changed"]) ? v["changed"] : [],
    removed: isStringArray(v["removed"]) ? v["removed"] : [],
    title: typeof v["title"] === "string" ? v["title"] : null,
    note: typeof v["note"] === "string" ? v["note"] : null,
  };
}

function parseRestoreResponse(value: unknown): RestoreResponse | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["guideId"] !== "string" ||
    typeof v["workspaceId"] !== "string" ||
    typeof v["restoredFromVersion"] !== "number" ||
    !Number.isFinite(v["restoredFromVersion"]) ||
    typeof v["newVersionIndex"] !== "number" ||
    !Number.isFinite(v["newVersionIndex"]) ||
    typeof v["message"] !== "string"
  ) {
    return null;
  }
  if (!isStringArray(v["notes"])) return null;
  return {
    guideId: v["guideId"],
    workspaceId: v["workspaceId"],
    restoredFromVersion: Math.trunc(v["restoredFromVersion"] as number),
    newVersionIndex: Math.trunc(v["newVersionIndex"] as number),
    guide: v["guide"],
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

function renderExtraValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "[unrenderable]";
  }
}

function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace("Z", " UTC");
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const cardStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
  maxWidth: 760,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 8,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const rowStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "8px 10px",
  marginBottom: 6,
  background: "#ffffff",
};

const versionBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 8px",
  borderRadius: 4,
  background: "#e0e7ff",
  color: "#1e3a8a",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
  fontWeight: 600,
};

const currentBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 4,
  background: "#dcfce7",
  color: "#166534",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.3,
  textTransform: "uppercase",
};

const okBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  background: "#dcfce7",
  color: "#166534",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.3,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

const pendingBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  background: "#fef9c3",
  color: "#854d0e",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.3,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

const failedBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  background: "#fee2e2",
  color: "#7f1d1d",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.3,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

function statusBadgeStyle(status: VersionStatus): CSSProperties {
  const palette = (() => {
    switch (status) {
      case "review":
        return { bg: "#fef9c3", fg: "#854d0e" };
      case "auto":
        return { bg: "#e0e7ff", fg: "#1e3a8a" };
      case "archived":
        return { bg: "#e2e8f0", fg: "#334155" };
      case "current":
        return { bg: "#dcfce7", fg: "#166534" };
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
    letterSpacing: 0.3,
    textTransform: "uppercase",
  };
}

const restoreButtonStyle: CSSProperties = {
  padding: "3px 10px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#1d4ed8",
};

const primaryButtonStyle: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid #1d4ed8",
  background: "#1d4ed8",
  color: "#ffffff",
  cursor: "pointer",
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

const summaryBlockStyle: CSSProperties = {
  marginTop: 6,
  padding: "6px 8px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
};

const summaryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 6,
};

const confirmStyle: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
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

const successStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #bbf7d0",
  borderRadius: 6,
  background: "#f0fdf4",
  color: "#14532d",
  fontSize: 13,
};

const noteListStyle: CSSProperties = {
  margin: "6px 0 0 16px",
  padding: 0,
  color: "#475569",
  fontSize: 12,
};

const thumbnailStyle: CSSProperties = {
  display: "block",
  marginTop: 6,
  maxWidth: 240,
  maxHeight: 140,
  border: "1px solid #e2e8f0",
  borderRadius: 4,
  objectFit: "contain",
  background: "#f8fafc",
};

const extraListStyle: CSSProperties = {
  margin: "4px 0 0",
  padding: "6px 8px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 11,
  display: "grid",
  gap: 2,
};
