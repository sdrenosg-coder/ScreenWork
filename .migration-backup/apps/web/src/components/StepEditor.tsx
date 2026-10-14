"use client";

/**
 * StepEditor — presentation-only editor for the ordered steps of one guide.
 *
 * Scope (editing & collaboration, batch 2):
 *   - Renders the ordered step list for a guide.
 *   - Lets the reviewer re-order steps by drag-and-drop or by the
 *     keyboard-accessible Move up/Move down buttons.
 *   - Lets the reviewer inline-edit each step's title, description and
 *     target value, and toggle "AI label" (the per-step AI-generated
 *     disclosure flag).
 *   - Lets the reviewer delete a step and insert a new blank step at a
 *     chosen index.
 *   - Tracks a local dirty set so the caller can decide when to persist
 *     (the save flow itself lives in the page, which calls the guide API
 *     and produces a new version — this component only emits the intended
 *     state).
 *   - Emits `onChange` with the full new steps array and a `changedIds`
 *     set of step ids whose post-save state differs from the editor's
 *     initial prop — the page uses that set to attribute the change in the
 *     version-history entry.
 *
 * What this component deliberately does NOT do:
 *   - It does not fetch. The parent page (or a data hook) supplies the
 *     initial `steps` prop from the guide API. That keeps the component
 *     useful for the "new unsaved guide" flow.
 *   - It does not persist. Persistence happens via the parent's save
 *     action, so the same component can power both save-draft and
 *     save-and-publish flows.
 *   - It does not capture screenshots. Re-capture is wired later; the
 *     placeholder action just calls the parent's optional
 *     `onRecaptureStep(stepId)` so the parent can decide.
 *   - It does not edit annotations. Annotation editing is a separate
 *     editor delivered in a later batch.
 *   - It does not reorder by dragging on touch devices beyond what native
 *     HTML5 DnD supports (see the keyboard buttons as the primary path;
 *     drag-and-drop is an enhancement).
 *
 * State model:
 *   - `steps` is the single source of truth, held by the parent.
 *   - The editor owns only *transient* UI state: the id of the step being
 *     dragged, the id of the step currently expanded, the open/closed
 *     state of the delete-confirm dialog. It does not duplicate the steps
 *     array.
 *   - `changedIds` is derived (compared field-by-field against the initial
 *     prop) on every render; the parent receives it in every `onChange`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from "react";

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Minimal, self-contained shape of one editable step. It matches the
 * fields the guide API persists for a step today; unknown fields are
 * preserved through the round trip via `extraFields`.
 *
 * The shape is intentionally small: any additional data (annotations,
 * screenshots, provenance refs) is stored under `extraFields` so no
 * existing field is dropped when the reviewer edits step copy.
 */
export interface EditableStep {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly description: string;
  /** Sample value (for `type`/`select` steps) — free-form text. */
  readonly value: string;
  /** Whether this step's copy is currently flagged as AI-generated. */
  readonly aiGenerated: boolean;
  /**
   * Optional screenshot reference for this step. `null` when the step has
   * no screenshot yet; the parent uses this to render a thumbnail or a
   * "capture screenshot" placeholder.
   */
  readonly screenshotRef: string | null;
  /**
   * Everything else the guide API returns for this step, preserved so a
   * save round-trips without dropping fields this editor does not know.
   */
  readonly extraFields: Readonly<Record<string, unknown>>;
}

export interface StepEditorChange {
  readonly steps: readonly EditableStep[];
  /** Step ids whose post-edit state differs from the initial prop. */
  readonly changedIds: ReadonlySet<string>;
  /** Step ids added during this edit session. */
  readonly addedIds: ReadonlySet<string>;
  /** Step ids removed during this edit session. */
  readonly removedIds: ReadonlySet<string>;
}

export interface StepEditorProps {
  readonly guideId: string;
  readonly steps: readonly EditableStep[];
  readonly onChange: (change: StepEditorChange) => void;
  /**
   * Optional parent hook for the "Re-capture screenshot" button. When
   * omitted, the button is not rendered.
   */
  readonly onRecaptureStep?: (stepId: string) => void;
  /** When true the editor renders as read-only (review mode off). */
  readonly readOnly?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export default function StepEditor({
  guideId,
  steps,
  onChange,
  onRecaptureStep,
  readOnly = false,
}: StepEditorProps) {
  const [expandedId, setExpandedId] = useState<string | null>(
    steps.length > 0 ? steps[0]!.id : null,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // The editor remembers every step id it has added during this session,
  // so `addedIds` can be reported. Removed ids are remembered too.
  const addedIdsRef = useRef<Set<string>>(new Set());
  const removedIdsRef = useRef<Set<string>>(new Set());

  // Remember the initial array so we can diff field-by-field.
  const initialRef = useRef<readonly EditableStep[]>(steps);

  // Whenever the parent passes a *different* initial array (e.g. after a
  // save or a version restore), reset the added/removed bookkeeping.
  useEffect(() => {
    initialRef.current = steps;
    addedIdsRef.current = new Set();
    removedIdsRef.current = new Set();
  }, [steps]);

  /* ------------------------------ diffing -------------------------------- */

  const changedIds = useMemo(() => {
    const out = new Set<string>();
    const initialById = new Map<string, EditableStep>();
    for (const s of initialRef.current) initialById.set(s.id, s);
    for (const s of steps) {
      const before = initialById.get(s.id);
      if (before === undefined) {
        out.add(s.id);
        continue;
      }
      if (
        before.title !== s.title ||
        before.description !== s.description ||
        before.value !== s.value ||
        before.aiGenerated !== s.aiGenerated ||
        before.index !== s.index
      ) {
        out.add(s.id);
      }
    }
    // Any step present initially but absent now is a removal; the removed
    // id is not in the steps array, so it is not in `out` yet — but the
    // parent tracks these via `removedIds`. The changedIds set only names
    // steps that are still present.
    return out;
  }, [steps]);

  const emit = useCallback(
    (next: readonly EditableStep[]) => {
      onChange({
        steps: next,
        changedIds,
        addedIds: new Set(addedIdsRef.current),
        removedIds: new Set(removedIdsRef.current),
      });
    },
    [changedIds, onChange],
  );

  /* --------------------------- step mutations ---------------------------- */

  const updateStep = useCallback(
    (id: string, patch: Partial<Pick<EditableStep, "title" | "description" | "value" | "aiGenerated">>) => {
      if (readOnly) return;
      const next = steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
      emit(reindex(next));
    },
    [steps, emit, readOnly],
  );

  const insertStepAt = useCallback(
    (atIndex: number) => {
      if (readOnly) return;
      const id = generateStepId(steps);
      const zero: EditableStep = {
        id,
        index: 0,
        title: "",
        description: "",
        value: "",
        aiGenerated: true,
        screenshotRef: null,
        extraFields: {},
      };
      const clamped = Math.max(0, Math.min(atIndex, steps.length));
      const next = [...steps.slice(0, clamped), zero, ...steps.slice(clamped)];
      addedIdsRef.current.add(id);
      setExpandedId(id);
      emit(reindex(next));
    },
    [steps, emit, readOnly],
  );

  const duplicateStep = useCallback(
    (sourceId: string) => {
      if (readOnly) return;
      const sourceIndex = steps.findIndex((s) => s.id === sourceId);
      if (sourceIndex < 0) return;
      const source = steps[sourceIndex]!;
      const id = generateStepId(steps);
      const clone: EditableStep = {
        ...source,
        id,
        title: `${source.title} (copy)`,
      };
      const next = [...steps.slice(0, sourceIndex + 1), clone, ...steps.slice(sourceIndex + 1)];
      addedIdsRef.current.add(id);
      setExpandedId(id);
      emit(reindex(next));
    },
    [steps, emit, readOnly],
  );

  const confirmDelete = useCallback(() => {
    if (readOnly) return;
    const id = pendingDeleteId;
    if (id === null) return;
    const next = steps.filter((s) => s.id !== id);
    removedIdsRef.current.add(id);
    // Also remove from addedIds in case a step was added and then removed
    // in the same session.
    addedIdsRef.current.delete(id);
    if (expandedId === id) {
      setExpandedId(next.length > 0 ? next[0]!.id : null);
    }
    setPendingDeleteId(null);
    emit(reindex(next));
  }, [pendingDeleteId, steps, expandedId, emit, readOnly]);

  const cancelDelete = useCallback(() => setPendingDeleteId(null), []);

  /* ------------------------------- reorder ------------------------------- */

  const moveStep = useCallback(
    (id: string, direction: -1 | 1) => {
      if (readOnly) return;
      const idx = steps.findIndex((s) => s.id === id);
      if (idx < 0) return;
      const target = idx + direction;
      if (target < 0 || target >= steps.length) return;
      const next = steps.slice();
      const a = next[idx]!;
      const b = next[target]!;
      next[idx] = b;
      next[target] = a;
      emit(reindex(next));
    },
    [steps, emit, readOnly],
  );

  const beginDrag = useCallback(
    (event: DragEvent<HTMLLIElement>, id: string) => {
      if (readOnly) return;
      setDraggingId(id);
      try {
        event.dataTransfer.setData("text/zipy-step-id", id);
        event.dataTransfer.effectAllowed = "move";
      } catch {
        // Some browsers reject setData outside a user gesture; the buttons
        // remain the primary path, so swallowing here is safe.
      }
    },
    [readOnly],
  );

  const overDrag = useCallback(
    (event: DragEvent<HTMLLIElement>, id: string) => {
      if (readOnly) return;
      if (draggingId === null || draggingId === id) return;
      event.preventDefault();
      setDragOverId(id);
    },
    [draggingId, readOnly],
  );

  const dropDrag = useCallback(
    (event: DragEvent<HTMLLIElement>, targetId: string) => {
      if (readOnly) return;
      event.preventDefault();
      const dragging = draggingId;
      setDraggingId(null);
      setDragOverId(null);
      if (dragging === null || dragging === targetId) return;
      const from = steps.findIndex((s) => s.id === dragging);
      const to = steps.findIndex((s) => s.id === targetId);
      if (from < 0 || to < 0) return;
      const next = steps.slice();
      const [moved] = next.splice(from, 1);
      if (moved === undefined) return;
      next.splice(to, 0, moved);
      emit(reindex(next));
    },
    [draggingId, steps, emit, readOnly],
  );

  const endDrag = useCallback(() => {
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  /* ------------------------------- render -------------------------------- */

  return (
    <section aria-labelledby="zipy-step-editor-heading" style={cardStyle}>
      <header style={headerRowStyle}>
        <div>
          <h2
            id="zipy-step-editor-heading"
            style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
          >
            Steps
          </h2>
          <p style={{ margin: "2px 0 0", color: "#475569", fontSize: 12 }}>
            {steps.length} step{steps.length === 1 ? "" : "s"}
            {changedIds.size > 0
              ? ` · ${changedIds.size} unsaved change${changedIds.size === 1 ? "" : "s"}`
              : ""}
            {readOnly ? " · read-only" : ""}
          </p>
        </div>
        {!readOnly && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => insertStepAt(steps.length)}
              style={primaryButtonStyle}
            >
              Add step
            </button>
          </div>
        )}
      </header>

      {steps.length === 0 ? (
        <p style={mutedStyle}>No steps yet. Add the first step to begin.</p>
      ) : (
        <ol style={listStyle} aria-label={`Steps for guide ${guideId}`}>
          {steps.map((step, idx) => {
            const expanded = expandedId === step.id;
            const dragging = draggingId === step.id;
            const dragOver = dragOverId === step.id && draggingId !== step.id;
            return (
              <li
                key={step.id}
                style={{
                  ...stepCardStyle,
                  opacity: dragging ? 0.5 : 1,
                  borderColor: dragOver ? "#1d4ed8" : "#e2e8f0",
                }}
                draggable={!readOnly}
                onDragStart={(e) => beginDrag(e, step.id)}
                onDragOver={(e) => overDrag(e, step.id)}
                onDrop={(e) => dropDrag(e, step.id)}
                onDragEnd={endDrag}
              >
                <div style={stepHeaderRowStyle}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : step.id)}
                    aria-expanded={expanded}
                    style={stepToggleStyle}
                  >
                    <span style={stepIndexBadgeStyle}>{idx + 1}</span>
                    <span style={{ fontWeight: 600, color: "#0f172a" }}>
                      {step.title.trim().length > 0 ? step.title : "(untitled step)"}
                    </span>
                    {step.aiGenerated && (
                      <span style={aiBadgeStyle} title="AI-generated copy">
                        AI
                      </span>
                    )}
                  </button>
                  {!readOnly && (
                    <div style={stepActionsRowStyle}>
                      <IconButton
                        label="Move up"
                        disabled={idx === 0}
                        onClick={() => moveStep(step.id, -1)}
                      >
                        ↑
                      </IconButton>
                      <IconButton
                        label="Move down"
                        disabled={idx === steps.length - 1}
                        onClick={() => moveStep(step.id, 1)}
                      >
                        ↓
                      </IconButton>
                      <IconButton
                        label="Duplicate step"
                        onClick={() => duplicateStep(step.id)}
                      >
                        ⧉
                      </IconButton>
                      {onRecaptureStep !== undefined && (
                        <IconButton
                          label="Re-capture screenshot"
                          onClick={() => onRecaptureStep(step.id)}
                        >
                          ⌾
                        </IconButton>
                      )}
                      <IconButton
                        label="Delete step"
                        onClick={() => setPendingDeleteId(step.id)}
                      >
                        ✕
                      </IconButton>
                    </div>
                  )}
                </div>

                {expanded && (
                  <div style={expandedBodyStyle}>
                    <Field label="Title">
                      <input
                        type="text"
                        value={step.title}
                        disabled={readOnly}
                        onChange={(e) => updateStep(step.id, { title: e.target.value })}
                        style={inputStyle}
                      />
                    </Field>
                    <Field label="Description">
                      <textarea
                        rows={3}
                        value={step.description}
                        disabled={readOnly}
                        onChange={(e) => updateStep(step.id, { description: e.target.value })}
                        style={{ ...inputStyle, resize: "vertical" }}
                      />
                    </Field>
                    <Field
                      label="Sample value"
                      hint="The literal value the workflow enters or selects at this step. Leave blank when the step does not set a value."
                    >
                      <input
                        type="text"
                        value={step.value}
                        disabled={readOnly}
                        onChange={(e) => updateStep(step.id, { value: e.target.value })}
                        style={inputStyle}
                      />
                    </Field>
                    <label style={checkboxRowStyle}>
                      <input
                        type="checkbox"
                        checked={step.aiGenerated}
                        disabled={readOnly}
                        onChange={(e) => updateStep(step.id, { aiGenerated: e.target.checked })}
                      />
                      <span style={{ fontSize: 13, color: "#0f172a" }}>
                        Mark copy as AI-generated
                      </span>
                    </label>
                    {step.screenshotRef !== null && (
                      <p style={{ ...mutedStyle, marginTop: 4 }}>
                        Screenshot: <code style={monoStyle}>{step.screenshotRef}</code>
                      </p>
                    )}
                  </div>
                )}

                {pendingDeleteId === step.id && (
                  <div role="dialog" aria-modal="true" style={confirmStyle}>
                    <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                      Delete step {idx + 1}? The change is not saved until you save the guide.
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={confirmDelete}
                        style={dangerButtonStyle}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={cancelDelete}
                        style={linkButtonStyle}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {!readOnly && steps.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => insertStepAt(steps.length)}
            style={linkButtonStyle}
          >
            + Append step
          </button>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Subcomponents                                                               */
/* -------------------------------------------------------------------------- */

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 500,
          color: "#0f172a",
          marginBottom: 4,
        }}
      >
        {label}
      </span>
      {children}
      {typeof hint === "string" && hint.length > 0 && (
        <span style={{ display: "block", fontSize: 11, color: "#64748b", marginTop: 2 }}>
          {hint}
        </span>
      )}
    </label>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick();
      }
    },
    [onClick],
  );
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled === true}
      onClick={onClick}
      onKeyDown={handleKey}
      style={{
        width: 28,
        height: 28,
        padding: 0,
        fontSize: 13,
        borderRadius: 4,
        border: "1px solid #cbd5e1",
        background: disabled === true ? "#f1f5f9" : "#ffffff",
        color: disabled === true ? "#94a3b8" : "#0f172a",
        cursor: disabled === true ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Re-number `index` sequentially from 1. This is a pure function; the
 * parent is the source of truth for the persisted indices, and re-running
 * this on already-normalised input is idempotent.
 */
function reindex(steps: readonly EditableStep[]): readonly EditableStep[] {
  return steps.map((s, i) => (s.index === i + 1 ? s : { ...s, index: i + 1 }));
}

/**
 * Build a step id that is unique in the current set and visually
 * distinguishable from generated ids (all upstream-step ids begin with
 * "step-"). Editors use "new-<counter>" so that a diff against persisted
 * ids tells apart "was generated" from "was added here".
 */
function generateStepId(existing: readonly EditableStep[]): string {
  const used = new Set(existing.map((s) => s.id));
  let n = 1;
  while (used.has(`new-${n}`)) n += 1;
  return `new-${n}`;
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const cardStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
  maxWidth: 840,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 12,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const stepCardStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  marginBottom: 8,
  background: "#ffffff",
  padding: 8,
};

const stepHeaderRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const stepToggleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flex: 1,
  minWidth: 0,
  padding: "4px 6px",
  background: "transparent",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  fontSize: 13,
  color: "#0f172a",
};

const stepIndexBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 999,
  background: "#e0e7ff",
  color: "#1e3a8a",
  fontSize: 11,
  fontWeight: 600,
  flexShrink: 0,
};

const aiBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  border: "1px solid #bfdbfe",
  background: "#eff6ff",
  color: "#1e3a8a",
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.3,
};

const stepActionsRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  flexShrink: 0,
};

const expandedBodyStyle: CSSProperties = {
  marginTop: 10,
  paddingTop: 10,
  borderTop: "1px solid #f1f5f9",
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

const checkboxRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 4,
};

const confirmStyle: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
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

const dangerButtonStyle: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid #b91c1c",
  background: "#b91c1c",
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
