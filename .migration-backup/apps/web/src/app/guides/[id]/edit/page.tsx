"use client";

/**
 * Guide post-generation editor page (phase 18, batch 3 — final).
 *
 * Owns the editing session for one guide. It:
 *   - loads the guide's steps via GET /api/guides/{id};
 *   - embeds StepEditor to edit the step list;
 *   - embeds VersionHistory (this batch) to list and restore previous
 *     versions, wiring `onRestored` back to its own editor state;
 *   - hosts the Save action, PUTting the edited steps array to
 *     /api/guides/{id} and producing a new version;
 *   - exposes a bulk-edit panel that applies a bounded transform to a
 *     chosen set of steps through the same change-emit contract as the
 *     per-step editor.
 *
 * Wire contract (mirrors StepEditor + VersionHistory):
 *   GET  /api/guides/{id}                → { guide, message }
 *   PUT  /api/guides/{id}                → { guide, message } | 409 { error: "version_conflict", currentVersion }
 *   GET  /api/guides/{id}/versions       → see VersionHistory.tsx
 *   POST /api/guides/{id}/versions/{v}/restore → see VersionHistory.tsx
 *
 * Non-goals (documented, not silently stubbed):
 *   - Screenshot *re-capture* is not performed here. The button surfaces a
 *     notice; the automation phase owns the browser run.
 *   - Annotation editing is delivered in a later phase.
 *   - Live co-editing over WebSocket is not wired in this page; the REST
 *     API remains the write path and the co-editing channel
 *     (packages/collab/src/realtime.ts) is a separate transport.
 *
 * Defensive parsing: a payload this page does not recognise renders an
 * explicit "unexpected response" error rather than a silently empty guide.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import StepEditor, {
  type EditableStep,
  type StepEditorChange,
} from "../../../../components/StepEditor";
import VersionHistory from "../../../../components/VersionHistory";

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

interface GuidePayload {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly steps: readonly EditableStep[];
}

interface GuideResponse {
  readonly guide: GuidePayload;
  readonly message: string;
}

interface ApiError {
  readonly error: string;
  readonly message: string;
  readonly field?: string;
  readonly currentVersion?: number;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly response: GuideResponse }
  | { readonly kind: "error"; readonly error: ApiError }
  | { readonly kind: "conflict"; readonly response: GuideResponse | null; readonly error: ApiError };

interface BulkEditForm {
  readonly appendText: string;
  readonly prependText: string;
  readonly setValue: string;
  readonly setAiGenerated: "unchanged" | "true" | "false";
}

const EMPTY_BULK: BulkEditForm = {
  appendText: "",
  prependText: "",
  setValue: "",
  setAiGenerated: "unchanged",
};

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function GuideEditPage({
  params,
}: {
  readonly params: { readonly id: string };
}) {
  const guideId = params.id;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [steps, setSteps] = useState<readonly EditableStep[]>([]);
  const [editing, setEditing] = useState<StepEditorChange | null>(null);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [recaptureNotice, setRecaptureNotice] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState<BulkEditForm>(EMPTY_BULK);
  const [bulkTargets, setBulkTargets] = useState<ReadonlySet<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(true);

  /* ------------------------------- load ---------------------------------- */

  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      setState({ kind: "loading" });
      setSaveError(null);
      setSaveSuccess(null);
      try {
        const res = await fetch(`/api/guides/${encodeURIComponent(guideId)}`, {
          signal,
          headers: { accept: "application/json" },
        });
        const json: unknown = await res.json().catch(() => null);
        if (signal.aborted) return;
        if (!res.ok) {
          setState({
            kind: "error",
            error: normaliseError(json, `Loading the guide failed with HTTP ${res.status}.`),
          });
          return;
        }
        const parsed = parseGuideResponse(json);
        if (parsed === null) {
          setState({
            kind: "error",
            error: {
              error: "unexpected_response",
              message:
                "The server returned a guide payload this page does not recognise. Check server logs.",
            },
          });
          return;
        }
        setState({ kind: "ready", response: parsed });
        setSteps(parsed.guide.steps);
        setEditing(null);
        setBulkTargets(new Set());
        setBulkForm(EMPTY_BULK);
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
    [guideId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /* ---------------------------- change handler --------------------------- */

  const onEditorChange = useCallback((change: StepEditorChange) => {
    setSteps(change.steps);
    setEditing(change);
  }, []);

  /* ------------------------------ restore hook --------------------------- */

  /**
   * Called by VersionHistory after a successful restore. The parent takes
   * the restored guide document, parses it through the same defensive
   * pipeline as a load, and swaps its editor state. It intentionally does
   * NOT immediately re-save: the newly-created version already exists on
   * the server, and the reviewer must explicitly Save to make further
   * changes.
   */
  const onRestored = useCallback(
    (guideDoc: unknown, restoredFrom: number, newVersionIndex: number) => {
      const parsed = parseGuideResponse({ guide: guideDoc, message: "" });
      if (parsed === null) {
        setSaveError({
          error: "unexpected_response",
          message:
            "The restore succeeded but the returned guide document could not be parsed. Reload the guide to sync.",
        });
        return;
      }
      setState({ kind: "ready", response: parsed });
      setSteps(parsed.guide.steps);
      setEditing(null);
      setBulkTargets(new Set());
      setSaveSuccess(
        `Restored from version ${restoredFrom}; server now at version ${newVersionIndex}.`,
      );
    },
    [],
  );

  /* ------------------------------- save ---------------------------------- */

  const canSave = useCallback((): boolean => {
    if (state.kind !== "ready") return false;
    if (saving || restoring) return false;
    if (editing === null) return false;
    return (
      editing.changedIds.size > 0 ||
      editing.addedIds.size > 0 ||
      editing.removedIds.size > 0
    );
  }, [state, saving, restoring, editing]);

  const save = useCallback(async () => {
    if (state.kind !== "ready") return;
    if (!canSave()) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const res = await fetch(`/api/guides/${encodeURIComponent(guideId)}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          steps,
          expectedVersion: state.response.guide.version,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const err = normaliseError(json, `Save failed with HTTP ${res.status}.`);
        if (err.error === "version_conflict" || res.status === 409) {
          setState({ kind: "conflict", response: state.response, error: err });
          setSaveError(err);
          return;
        }
        setSaveError(err);
        return;
      }
      const parsed = parseGuideResponse(json);
      if (parsed === null) {
        setSaveError({
          error: "unexpected_response",
          message:
            "The server accepted the save but returned an unrecognised payload. Reload to confirm.",
        });
        return;
      }
      setState({ kind: "ready", response: parsed });
      setSteps(parsed.guide.steps);
      setEditing(null);
      setSaveSuccess(parsed.message);
    } catch (err) {
      setSaveError({
        error: "network_error",
        message:
          err instanceof Error
            ? `Could not reach the server: ${err.message}`
            : "Could not reach the server.",
      });
    } finally {
      setSaving(false);
    }
  }, [guideId, steps, state, canSave]);

  /* --------------------------- recapture placeholder --------------------- */

  const onRecaptureStep = useCallback((stepId: string) => {
    setRecaptureNotice(
      `Screenshot re-capture for step ${stepId} is owned by the browser-automation phase; this editor does not run a browser and has not queued a request.`,
    );
  }, []);

  /* ------------------------------ bulk edit ------------------------------ */

  const toggleBulkTarget = useCallback((id: string) => {
    setBulkTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllBulkTargets = useCallback(() => {
    setBulkTargets(new Set(steps.map((s) => s.id)));
  }, [steps]);

  const clearBulkTargets = useCallback(() => setBulkTargets(new Set()), []);

  const applyBulk = useCallback(() => {
    if (state.kind !== "ready") return;
    if (bulkTargets.size === 0) return;
    const appendText = bulkForm.appendText.trim();
    const prependText = bulkForm.prependText.trim();
    const setValue = bulkForm.setValue;
    const aiFlag = bulkForm.setAiGenerated;
    if (
      appendText.length === 0 &&
      prependText.length === 0 &&
      setValue.length === 0 &&
      aiFlag === "unchanged"
    ) {
      return;
    }
    const next = steps.map((s) => {
      if (!bulkTargets.has(s.id)) return s;
      let description = s.description;
      if (prependText.length > 0) {
        description = description.length > 0 ? `${prependText} ${description}` : prependText;
      }
      if (appendText.length > 0) {
        description = description.length > 0 ? `${description} ${appendText}` : appendText;
      }
      const nextValue = setValue.length > 0 ? setValue : s.value;
      const nextAi =
        aiFlag === "unchanged" ? s.aiGenerated : aiFlag === "true";
      return {
        ...s,
        description,
        value: nextValue,
        aiGenerated: nextAi,
      };
    });
    const initialById = new Map<string, EditableStep>();
    for (const before of state.response.guide.steps) initialById.set(before.id, before);
    const changed = new Set<string>();
    for (const after of next) {
      const before = initialById.get(after.id);
      if (before === undefined) {
        changed.add(after.id);
        continue;
      }
      if (
        before.title !== after.title ||
        before.description !== after.description ||
        before.value !== after.value ||
        before.aiGenerated !== after.aiGenerated ||
        before.index !== after.index
      ) {
        changed.add(after.id);
      }
    }
    setSteps(next);
    setEditing({
      steps: next,
      changedIds: changed,
      addedIds: new Set(),
      removedIds: new Set(),
    });
  }, [state, steps, bulkTargets, bulkForm]);

  /* ------------------------------ rendering ------------------------------ */

  const heading = useMemo(() => {
    switch (state.kind) {
      case "loading":
        return "Loading guide…";
      case "error":
        return "Could not load guide";
      case "conflict":
        return state.response?.guide.title ?? "Guide (conflict)";
      case "ready":
        return state.response.guide.title;
    }
  }, [state]);

  const versionLabel = useMemo(() => {
    if (state.kind !== "ready" && state.kind !== "conflict") return null;
    const g = state.response?.guide;
    if (g === undefined) return null;
    return `Version ${g.version}${
      g.updatedAt !== null ? ` · last saved ${formatIso(g.updatedAt)}` : ""
    }${g.updatedBy !== null ? ` by ${g.updatedBy}` : ""}`;
  }, [state]);

  return (
    <main style={pageStyle}>
      <nav style={breadcrumbStyle} aria-label="Breadcrumb">
        <Link href="/dashboard" style={linkStyle}>
          Dashboard
        </Link>
        <span aria-hidden="true">›</span>
        <Link href={`/guides/${encodeURIComponent(guideId)}`} style={linkStyle}>
          Guide
        </Link>
        <span aria-hidden="true">›</span>
        <span style={{ color: "#0f172a", fontWeight: 500 }}>Edit</span>
      </nav>

      <h1 style={{ margin: "8px 0 4px", fontSize: 22, fontWeight: 700 }}>
        {heading}
      </h1>
      {versionLabel !== null && (
        <p style={{ margin: "0 0 16px", color: "#475569", fontSize: 12 }}>
          {versionLabel}
          {" · "}
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            style={linkButtonStyle}
          >
            {historyOpen ? "Hide version history" : "Show version history"}
          </button>
        </p>
      )}

      {state.kind === "conflict" && (
        <div role="alert" style={conflictBannerStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            Version conflict
          </strong>
          <div>
            {state.error.message ||
              "Your edits are based on a version that has since changed on the server."}
          </div>
          {typeof state.error.currentVersion === "number" && (
            <div style={{ marginTop: 4 }}>
              Current server version:{" "}
              <code style={monoStyle}>{state.error.currentVersion}</code>
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            Reload to see the latest version, then re-apply your edits. This page
            does not auto-merge.
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                const controller = new AbortController();
                void load(controller.signal);
              }}
              style={primaryButtonStyle}
            >
              Reload guide
            </button>
          </div>
        </div>
      )}

      {historyOpen && (
        <section style={{ marginBottom: 16 }}>
          <VersionHistory
            guideId={guideId}
            onRestored={onRestored}
            onBusyChange={setRestoring}
          />
        </section>
      )}

      {state.kind === "error" && (
        <div role="alert" style={errorStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            {state.error.error}
          </strong>
          <span>{state.error.message}</span>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <StepEditor
            guideId={guideId}
            steps={steps}
            onChange={onEditorChange}
            onRecaptureStep={onRecaptureStep}
            readOnly={restoring}
          />

          <section style={bulkCardStyle} aria-labelledby="zipy-bulk-heading">
            <header style={headerRowStyle}>
              <h2 id="zipy-bulk-heading" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                Bulk edit
              </h2>
              <button
                type="button"
                onClick={() => setBulkOpen((v) => !v)}
                style={linkButtonStyle}
              >
                {bulkOpen ? "Close" : "Open"}
              </button>
            </header>
            <p style={{ margin: "4px 0 8px", color: "#475569", fontSize: 12 }}>
              Applies to the selected steps only. Changes flow through the same save
              action as the per-step editor and produce a single new version.
            </p>

            {bulkOpen && (
              <>
                <div style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "#475569", marginRight: 8 }}>
                    Targeted steps: {bulkTargets.size} of {steps.length}
                  </span>
                  <button type="button" onClick={selectAllBulkTargets} style={linkButtonStyle}>
                    Select all
                  </button>
                  <span style={{ margin: "0 6px", color: "#94a3b8" }}>·</span>
                  <button type="button" onClick={clearBulkTargets} style={linkButtonStyle}>
                    Clear
                  </button>
                </div>
                <ul style={targetListStyle}>
                  {steps.map((s, idx) => (
                    <li key={s.id} style={targetItemStyle}>
                      <label
                        style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}
                      >
                        <input
                          type="checkbox"
                          checked={bulkTargets.has(s.id)}
                          onChange={() => toggleBulkTarget(s.id)}
                        />
                        <span style={stepIndexBadgeStyle}>{idx + 1}</span>
                        <span>{s.title.trim().length > 0 ? s.title : "(untitled step)"}</span>
                      </label>
                    </li>
                  ))}
                </ul>

                <label style={fieldStyle}>
                  <span style={fieldLabelStyle}>Prepend to description</span>
                  <input
                    type="text"
                    value={bulkForm.prependText}
                    onChange={(e) =>
                      setBulkForm((f) => ({ ...f, prependText: e.target.value }))
                    }
                    style={inputStyle}
                  />
                </label>
                <label style={fieldStyle}>
                  <span style={fieldLabelStyle}>Append to description</span>
                  <input
                    type="text"
                    value={bulkForm.appendText}
                    onChange={(e) =>
                      setBulkForm((f) => ({ ...f, appendText: e.target.value }))
                    }
                    style={inputStyle}
                  />
                </label>
                <label style={fieldStyle}>
                  <span style={fieldLabelStyle}>
                    Set sample value (leave blank to keep existing)
                  </span>
                  <input
                    type="text"
                    value={bulkForm.setValue}
                    onChange={(e) =>
                      setBulkForm((f) => ({ ...f, setValue: e.target.value }))
                    }
                    style={inputStyle}
                  />
                </label>
                <label style={fieldStyle}>
                  <span style={fieldLabelStyle}>AI-generated flag</span>
                  <select
                    value={bulkForm.setAiGenerated}
                    onChange={(e) =>
                      setBulkForm((f) => ({
                        ...f,
                        setAiGenerated: e.target.value as BulkEditForm["setAiGenerated"],
                      }))
                    }
                    style={inputStyle}
                  >
                    <option value="unchanged">Leave unchanged</option>
                    <option value="true">Mark all as AI-generated</option>
                    <option value="false">Mark all as human-reviewed</option>
                  </select>
                </label>

                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={applyBulk}
                    disabled={bulkTargets.size === 0 || restoring}
                    style={{
                      ...primaryButtonStyle,
                      background:
                        bulkTargets.size === 0 || restoring ? "#93c5fd" : "#1d4ed8",
                      cursor:
                        bulkTargets.size === 0 || restoring ? "not-allowed" : "pointer",
                    }}
                  >
                    Apply to selected steps
                  </button>
                </div>
              </>
            )}
          </section>

          <footer style={footerStyle}>
            <div>
              {editing !== null &&
                (editing.changedIds.size > 0 ||
                  editing.addedIds.size > 0 ||
                  editing.removedIds.size > 0) && (
                  <span style={{ fontSize: 12, color: "#475569" }}>
                    {editing.changedIds.size} changed
                    {editing.addedIds.size > 0 ? ` · ${editing.addedIds.size} added` : ""}
                    {editing.removedIds.size > 0
                      ? ` · ${editing.removedIds.size} removed`
                      : ""}
                  </span>
                )}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                onClick={() => {
                  const controller = new AbortController();
                  void load(controller.signal);
                }}
                disabled={saving || restoring}
                style={linkButtonStyle}
              >
                Reload
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!canSave()}
                style={{
                  ...primaryButtonStyle,
                  background: canSave() ? "#1d4ed8" : "#93c5fd",
                  cursor: canSave() ? "pointer" : "not-allowed",
                }}
              >
                {saving ? "Saving…" : "Save new version"}
              </button>
            </div>
          </footer>
        </>
      )}

      {saveError !== null && (
        <div role="alert" style={errorStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>{saveError.error}</strong>
          <span>{saveError.message}</span>
          {typeof saveError.field === "string" && (
            <span style={{ marginLeft: 6 }}>(field: {saveError.field})</span>
          )}
        </div>
      )}
      {saveSuccess !== null && (
        <div role="status" style={successStyle}>
          {saveSuccess}
        </div>
      )}
      {recaptureNotice !== null && (
        <div role="status" style={noticeStyle}>
          {recaptureNotice}
          <button
            type="button"
            onClick={() => setRecaptureNotice(null)}
            style={{ ...linkButtonStyle, marginLeft: 8 }}
          >
            Dismiss
          </button>
        </div>
      )}
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Response parsing                                                            */
/* -------------------------------------------------------------------------- */

function parseGuideResponse(value: unknown): GuideResponse | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const guide = v["guide"];
  if (guide === null || typeof guide !== "object") return null;
  const g = guide as Record<string, unknown>;
  if (
    typeof g["id"] !== "string" ||
    typeof g["title"] !== "string" ||
    typeof g["version"] !== "number" ||
    !Number.isFinite(g["version"]) ||
    !Array.isArray(g["steps"])
  ) {
    return null;
  }
  const steps: EditableStep[] = [];
  for (const raw of g["steps"] as readonly unknown[]) {
    const parsed = parseEditableStep(raw);
    if (parsed === null) return null;
    steps.push(parsed);
  }
  const message = typeof v["message"] === "string" ? v["message"] : "";
  return {
    guide: {
      id: g["id"],
      title: g["title"],
      version: Math.trunc(g["version"] as number),
      updatedAt: typeof g["updatedAt"] === "string" ? g["updatedAt"] : null,
      updatedBy: typeof g["updatedBy"] === "string" ? g["updatedBy"] : null,
      steps,
    },
    message,
  };
}

function parseEditableStep(value: unknown): EditableStep | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["id"] !== "string") return null;
  const title = typeof v["title"] === "string" ? v["title"] : "";
  const description = typeof v["description"] === "string" ? v["description"] : "";
  const value_ = typeof v["value"] === "string" ? v["value"] : "";
  const aiGenerated = v["aiGenerated"] === true;
  const screenshotRef =
    typeof v["screenshotRef"] === "string" ? v["screenshotRef"] : null;
  const indexRaw = v["index"];
  const index =
    typeof indexRaw === "number" && Number.isFinite(indexRaw)
      ? Math.trunc(indexRaw)
      : 0;
  const known = new Set([
    "id",
    "index",
    "title",
    "description",
    "value",
    "aiGenerated",
    "screenshotRef",
  ]);
  const extraFields: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (known.has(k)) continue;
    extraFields[k] = val;
  }
  return {
    id: v["id"],
    index,
    title,
    description,
    value: value_,
    aiGenerated,
    screenshotRef,
    extraFields,
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
    const currentVersion =
      typeof v["currentVersion"] === "number" && Number.isFinite(v["currentVersion"])
        ? Math.trunc(v["currentVersion"])
        : undefined;
    const out: { error: string; message: string; field?: string; currentVersion?: number } = {
      error: code,
      message,
    };
    if (field !== undefined) out.field = field;
    if (currentVersion !== undefined) out.currentVersion = currentVersion;
    return out;
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

const bulkCardStyle: CSSProperties = {
  marginTop: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
};

const targetListStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "0 0 8px",
  maxHeight: 200,
  overflowY: "auto",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
};

const targetItemStyle: CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid #f1f5f9",
};

const stepIndexBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 20,
  height: 20,
  padding: "0 6px",
  borderRadius: 999,
  background: "#e0e7ff",
  color: "#1e3a8a",
  fontSize: 11,
  fontWeight: 600,
};

const fieldStyle: CSSProperties = {
  display: "block",
  marginBottom: 8,
};

const fieldLabelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#0f172a",
  marginBottom: 4,
  fontWeight: 500,
};

const inputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  boxSizing: "border-box",
};

const footerStyle: CSSProperties = {
  marginTop: 16,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
};

const primaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
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
  fontSize: 13,
  padding: 0,
  textDecoration: "underline",
};

const errorStyle: CSSProperties = {
  marginTop: 16,
  padding: "10px 12px",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
  fontSize: 13,
};

const successStyle: CSSProperties = {
  marginTop: 16,
  padding: "10px 12px",
  border: "1px solid #bbf7d0",
  borderRadius: 6,
  background: "#f0fdf4",
  color: "#14532d",
  fontSize: 13,
};

const noticeStyle: CSSProperties = {
  marginTop: 12,
  padding: "8px 10px",
  border: "1px solid #fde68a",
  borderRadius: 6,
  background: "#fffbeb",
  color: "#78350f",
  fontSize: 12,
};

const conflictBannerStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #fde68a",
  borderRadius: 6,
  background: "#fffbeb",
  color: "#78350f",
  fontSize: 13,
};

const monoStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
};
