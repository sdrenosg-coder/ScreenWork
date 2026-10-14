"use client";

/**
 * LiveSessionView — human-in-the-loop live browser handoff surface.
 *
 * Contract with the rest of the review phase:
 *   - The reviewer sees the *browser session state* the worker published for
 *     a run (URL, viewport, screenshot frames, a control-lease token and a
 *     live-channel descriptor) — the component never invents a session.
 *   - Every control-transfer action (take control, release control, send an
 *     input event, approve/reject a checkpoint, end the session) is expressed
 *     as a POST to the review API and reported verbatim. Nothing is applied
 *     locally as if it had succeeded.
 *   - When the server says a capability is unconfigured (no live channel
 *     endpoint, no session id, expired lease), the component renders that
 *     state and disables the control buttons instead of silently degrading.
 *
 * Wire contract (owned by the review API, supplied elsewhere; this file only
 * consumes it):
 *   GET  /api/workflows/{workflowId}/review/session
 *     -> 200 {
 *          workflowId, runId, sessionId, state, controlLease, liveChannel,
 *          currentUrl, viewport, frames, pendingCheckpoint, message, notes[]
 *        }
 *     -> 4xx { error, message, field? }
 *
 *   POST /api/workflows/{workflowId}/review/session
 *     body: { action, ...payload }
 *     action: "take_control" | "release_control" | "send_input"
 *           | "approve_checkpoint" | "reject_checkpoint" | "end_session"
 *     -> 200 { workflowId, sessionId, state, controlLease, message, notes[] }
 *     -> 4xx { error, message, field? }
 *
 * Deliberate non-goals, documented rather than stubbed:
 *   - No browser is launched here. The live session is owned by the worker
 *     process; this component only shows what the worker publishes.
 *   - No screenshot is captured here. Frames are the URLs the API returned;
 *     missing URLs render a labelled placeholder, never a fabricated image.
 *   - No WebSocket/SSE transport is opened here. When the server advertises a
 *     `liveChannel` descriptor with `transport: "none"`, the component shows
 *     the current frame as a still and disables continuous-stream controls.
 *   - No credentials or CDP endpoints are read from the client bundle.
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
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

export type LiveSessionState =
  | "idle"
  | "running"
  | "paused"
  | "awaiting_human"
  | "human_in_control"
  | "ended"
  | "failed"
  | "unknown";

export type LiveChannelTransport = "none" | "websocket" | "sse" | "polling";

export interface ControlLease {
  readonly heldBy: string | null;
  readonly holderDisplay: string | null;
  readonly heldByCurrentUser: boolean;
  readonly expiresAt: string | null;
  readonly expired: boolean;
}

export interface LiveChannel {
  readonly transport: LiveChannelTransport;
  readonly url: string | null;
  readonly configured: boolean;
  readonly note: string | null;
}

export interface SessionFrame {
  readonly id: string;
  readonly capturedAt: string;
  readonly url: string | null;
  readonly label: string | null;
  readonly stepKey: string | null;
}

export interface PendingCheckpoint {
  readonly id: string;
  readonly stepKey: string | null;
  readonly title: string;
  readonly riskClass: string | null;
  readonly rationale: string | null;
  readonly proposedAction: string | null;
  readonly requestedAt: string | null;
}

export interface LiveSessionSnapshot {
  readonly workflowId: string;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly state: LiveSessionState;
  readonly controlLease: ControlLease;
  readonly liveChannel: LiveChannel;
  readonly currentUrl: string | null;
  readonly viewport: { readonly width: number; readonly height: number } | null;
  readonly frames: readonly SessionFrame[];
  readonly pendingCheckpoint: PendingCheckpoint | null;
  readonly message: string;
  readonly notes: readonly string[];
}

export interface SessionActionResponse {
  readonly workflowId: string;
  readonly sessionId: string | null;
  readonly state: LiveSessionState;
  readonly controlLease: ControlLease;
  readonly message: string;
  readonly notes: readonly string[];
}

interface ApiError {
  readonly error: string;
  readonly message: string;
  readonly field?: string;
}

export interface LiveSessionViewProps {
  /** Workflow whose live run should be shown. */
  readonly workflowId: string;
  /**
   * Poll interval for the session snapshot while transport is "polling"
   * (or "none" with a running state). 0 disables polling.
   * Defaults to 3000ms.
   */
  readonly pollIntervalMs?: number;
  /** When true, control actions are disabled and a banner explains why. */
  readonly readOnly?: boolean;
  /**
   * Fires whenever the busy state toggles so the parent page can
   * coordinate (e.g. disable the review-mode toggle while a lease
   * transfer is in flight).
   */
  readonly onBusyChange?: (busy: boolean) => void;
}

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: LiveSessionSnapshot }
  | { readonly kind: "error"; readonly error: ApiError };

interface Outcome {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
  readonly details: readonly string[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export default function LiveSessionView({
  workflowId,
  pollIntervalMs = 3000,
  readOnly = false,
  onBusyChange,
}: LiveSessionViewProps) {
  const idValid = UUID_PATTERN.test(workflowId);

  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [action, setAction] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [inputLine, setInputLine] = useState("");

  /* ----------------------------- busy reporting -------------------------- */

  const busyRef = useRef(false);
  useEffect(() => {
    const busy = action !== null;
    if (busy === busyRef.current) return;
    busyRef.current = busy;
    onBusyChange?.(busy);
  }, [action, onBusyChange]);
  useEffect(() => {
    return () => {
      if (busyRef.current) onBusyChange?.(false);
    };
  }, [onBusyChange]);

  /* --------------------------------- load -------------------------------- */

  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      if (!idValid) {
        setState({
          kind: "error",
          error: {
            error: "invalid_workflow_id",
            field: "workflowId",
            message:
              "workflowId must be a UUID. The live session view will not call the API with a malformed id.",
          },
        });
        return;
      }
      setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
      try {
        const res = await fetch(
          `/api/workflows/${encodeURIComponent(workflowId)}/review/session`,
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
        const parsed = parseSnapshot(json);
        if (parsed === null) {
          setState({
            kind: "error",
            error: {
              error: "unexpected_response",
              message:
                "The server returned a live-session payload this view does not recognise. Check server logs.",
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
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /* ------------------------------- polling ------------------------------- */

  const shouldPoll = useMemo(() => {
    if (pollIntervalMs <= 0) return false;
    if (state.kind !== "ready") return false;
    const s = state.data.state;
    if (s === "ended" || s === "failed") return false;
    const transport = state.data.liveChannel.transport;
    return transport === "polling" || transport === "none";
  }, [pollIntervalMs, state]);

  useEffect(() => {
    if (!shouldPoll) return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      void load(controller.signal);
    }, pollIntervalMs);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [shouldPoll, pollIntervalMs, load, state]);

  /* ------------------------------- actions ------------------------------- */

  const runAction = useCallback(
    async (actionName: string, payload: Record<string, unknown>): Promise<void> => {
      if (readOnly) {
        setOutcome({
          kind: "info",
          message:
            "Review is disabled for this workflow; control actions are not sent.",
          details: [],
        });
        return;
      }
      setAction(actionName);
      setOutcome(null);
      try {
        const res = await fetch(
          `/api/workflows/${encodeURIComponent(workflowId)}/review/session`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ action: actionName, ...payload }),
          },
        );
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const err = normaliseError(json, `Action failed with HTTP ${res.status}.`);
          setOutcome({
            kind: "error",
            message: `${err.error}: ${err.message}`,
            details: err.field !== undefined ? [`field: ${err.field}`] : [],
          });
          return;
        }
        const parsed = parseActionResponse(json);
        if (parsed === null) {
          setOutcome({
            kind: "error",
            message:
              "The server accepted the action but returned an unrecognised payload. Refresh to confirm the session state.",
            details: [],
          });
          return;
        }
        setOutcome({
          kind: "success",
          message: parsed.message,
          details: [
            `state: ${parsed.state}`,
            ...parsed.notes,
          ],
        });
        // Refresh the snapshot after every action so control lease + pending
        // checkpoint are re-read from the server, never assumed.
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
        setAction(null);
      }
    },
    [workflowId, readOnly, load],
  );

  const onTakeControl = useCallback(() => {
    void runAction("take_control", {});
  }, [runAction]);

  const onReleaseControl = useCallback(() => {
    void runAction("release_control", {});
  }, [runAction]);

  const onSendInput = useCallback(() => {
    const value = inputLine.trim();
    if (value.length === 0) return;
    void runAction("send_input", { input: value });
  }, [inputLine, runAction]);

  const onApprove = useCallback(
    (checkpointId: string) => {
      void runAction("approve_checkpoint", { checkpointId });
    },
    [runAction],
  );

  const onReject = useCallback(
    (checkpointId: string, reason: string) => {
      void runAction("reject_checkpoint", { checkpointId, reason });
    },
    [runAction],
  );

  const onEndSession = useCallback(() => {
    void runAction("end_session", {});
  }, [runAction]);

  /* ------------------------------- derived ------------------------------- */

  const latestFrame = useMemo(() => {
    if (state.kind !== "ready") return null;
    const frames = state.data.frames;
    if (frames.length === 0) return null;
    // Frames are ordered oldest-to-newest by the API.
    return frames[frames.length - 1]!;
  }, [state]);

  const control = useMemo(() => {
    if (state.kind !== "ready") {
      return {
        canTake: false,
        canRelease: false,
        canSendInput: false,
        canEnd: false,
        canApprove: false,
        canReject: false,
        notice: "Session snapshot is not loaded.",
      };
    }
    const s = state.data;
    if (readOnly) {
      return {
        canTake: false,
        canRelease: false,
        canSendInput: false,
        canEnd: false,
        canApprove: false,
        canReject: false,
        notice: "Review is disabled for this workflow.",
      };
    }
    if (s.sessionId === null) {
      return {
        canTake: false,
        canRelease: false,
        canSendInput: false,
        canEnd: false,
        canApprove: false,
        canReject: false,
        notice:
          "No live session has been published for this run. Start a run with review mode on to obtain one.",
      };
    }
    if (s.state === "ended" || s.state === "failed") {
      return {
        canTake: false,
        canRelease: false,
        canSendInput: false,
        canEnd: false,
        canApprove: false,
        canReject: false,
        notice: `Session is ${s.state}; control actions are unavailable.`,
      };
    }
    const lease = s.controlLease;
    const heldByMe = lease.heldByCurrentUser && !lease.expired;
    const heldByOther =
      lease.heldBy !== null && !lease.heldByCurrentUser && !lease.expired;
    const hasCheckpoint = s.pendingCheckpoint !== null;
    return {
      canTake: !heldByMe && !heldByOther && s.state !== "human_in_control",
      canRelease: heldByMe,
      canSendInput: heldByMe,
      canEnd: heldByMe,
      canApprove: hasCheckpoint,
      canReject: hasCheckpoint,
      notice:
        heldByOther
          ? `Control is currently held by ${
              lease.holderDisplay ?? lease.heldBy ?? "another reviewer"
            }.`
          : lease.expired && lease.heldBy !== null
            ? "The previous control lease has expired; take control to continue."
            : null,
    };
  }, [state, readOnly]);

  /* ------------------------------- render -------------------------------- */

  return (
    <section aria-labelledby="zipy-live-session-heading" style={cardStyle}>
      <header style={headerRowStyle}>
        <div>
          <h2
            id="zipy-live-session-heading"
            style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
          >
            Live browser session
          </h2>
          <p style={{ margin: "2px 0 0", color: "#475569", fontSize: 12 }}>
            Workflow <code style={monoStyle}>{workflowId}</code>
            {readOnly ? " · read-only" : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {state.kind === "ready" && <StateBadge state={state.data.state} />}
          <button
            type="button"
            onClick={() => {
              const controller = new AbortController();
              void load(controller.signal);
            }}
            disabled={action !== null}
            style={linkButtonStyle}
          >
            Refresh
          </button>
        </div>
      </header>

      {state.kind === "idle" || state.kind === "loading" ? (
        <p style={mutedStyle}>Loading live session…</p>
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
        <ReadyBody
          data={state.data}
          latestFrame={latestFrame}
          control={control}
          busyAction={action}
          inputLine={inputLine}
          onInputLineChange={setInputLine}
          onTakeControl={onTakeControl}
          onReleaseControl={onReleaseControl}
          onSendInput={onSendInput}
          onApprove={onApprove}
          onReject={onReject}
          onEndSession={onEndSession}
        />
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
              ? "Action failed"
              : outcome.kind === "info"
                ? "Action not sent"
                : "Action accepted"}
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
/* Ready-state rendering                                                       */
/* -------------------------------------------------------------------------- */

interface ReadyBodyProps {
  readonly data: LiveSessionSnapshot;
  readonly latestFrame: SessionFrame | null;
  readonly control: {
    readonly canTake: boolean;
    readonly canRelease: boolean;
    readonly canSendInput: boolean;
    readonly canEnd: boolean;
    readonly canApprove: boolean;
    readonly canReject: boolean;
    readonly notice: string | null;
  };
  readonly busyAction: string | null;
  readonly inputLine: string;
  readonly onInputLineChange: (value: string) => void;
  readonly onTakeControl: () => void;
  readonly onReleaseControl: () => void;
  readonly onSendInput: () => void;
  readonly onApprove: (checkpointId: string) => void;
  readonly onReject: (checkpointId: string, reason: string) => void;
  readonly onEndSession: () => void;
}

function ReadyBody({
  data,
  latestFrame,
  control,
  busyAction,
  inputLine,
  onInputLineChange,
  onTakeControl,
  onReleaseControl,
  onSendInput,
  onApprove,
  onReject,
  onEndSession,
}: ReadyBodyProps) {
  const [rejectReason, setRejectReason] = useState("");
  const busy = busyAction !== null;

  return (
    <>
      <div style={statusRowStyle}>
        <span style={{ fontSize: 12, color: "#475569" }}>{data.message}</span>
      </div>

      <div style={metaGridStyle}>
        <Meta label="Run id" value={data.runId ?? "—"} mono />
        <Meta label="Session id" value={data.sessionId ?? "—"} mono />
        <Meta label="Current URL" value={data.currentUrl ?? "—"} mono />
        <Meta
          label="Viewport"
          value={
            data.viewport === null
              ? "—"
              : `${data.viewport.width}×${data.viewport.height}`
          }
          mono
        />
        <Meta
          label="Live channel"
          value={
            data.liveChannel.configured
              ? data.liveChannel.transport
              : "not configured"
          }
        />
      </div>

      {data.liveChannel.note !== null && !data.liveChannel.configured && (
        <div style={noticeStyle}>
          {data.liveChannel.note}
        </div>
      )}

      {/* ---------------------------- live frame --------------------------- */}
      <div style={{ marginTop: 12 }}>
        <h3 style={sectionHeadingStyle}>Current frame</h3>
        {latestFrame === null ? (
          <p style={mutedStyle}>
            The worker has not published a frame for this session yet.
          </p>
        ) : latestFrame.url === null ? (
          <p style={mutedStyle}>
            Latest frame ({latestFrame.id}) has no reachable URL. The worker
            recorded it at {formatIso(latestFrame.capturedAt)}
            {latestFrame.label !== null ? ` — ${latestFrame.label}` : ""}.
          </p>
        ) : (
          <figure style={{ margin: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={latestFrame.url}
              alt={
                latestFrame.label !== null
                  ? latestFrame.label
                  : `Live browser frame captured at ${formatIso(
                      latestFrame.capturedAt,
                    )}`
              }
              style={frameImageStyle}
            />
            <figcaption style={{ ...mutedStyle, marginTop: 4 }}>
              Frame {latestFrame.id}
              {latestFrame.stepKey !== null
                ? ` · step ${latestFrame.stepKey}`
                : ""}
              {" · "}
              {formatIso(latestFrame.capturedAt)}
            </figcaption>
          </figure>
        )}
      </div>

      {/* --------------------------- control lease -------------------------- */}
      <div style={{ marginTop: 16 }}>
        <h3 style={sectionHeadingStyle}>Control</h3>
        <div style={leaseRowStyle}>
          <LeaseBadge lease={data.controlLease} />
          <div style={{ fontSize: 12, color: "#475569" }}>
            {data.controlLease.heldBy === null
              ? "No reviewer currently holds control."
              : data.controlLease.heldByCurrentUser
                ? `You hold control${
                    data.controlLease.expiresAt !== null
                      ? ` (expires ${formatIso(data.controlLease.expiresAt)})`
                      : ""
                  }.`
                : `Held by ${
                    data.controlLease.holderDisplay ??
                    data.controlLease.heldBy
                  }${
                    data.controlLease.expiresAt !== null
                      ? ` (expires ${formatIso(data.controlLease.expiresAt)})`
                      : ""
                  }.`}
          </div>
        </div>

        {control.notice !== null && (
          <div style={noticeStyle}>{control.notice}</div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onTakeControl}
            disabled={busy || !control.canTake}
            style={toggleButtonStyle(busy || !control.canTake, "primary")}
          >
            {busyAction === "take_control" ? "Taking control…" : "Take control"}
          </button>
          <button
            type="button"
            onClick={onReleaseControl}
            disabled={busy || !control.canRelease}
            style={toggleButtonStyle(busy || !control.canRelease, "neutral")}
          >
            {busyAction === "release_control"
              ? "Releasing…"
              : "Release control"}
          </button>
          <button
            type="button"
            onClick={onEndSession}
            disabled={busy || !control.canEnd}
            style={toggleButtonStyle(busy || !control.canEnd, "danger")}
          >
            {busyAction === "end_session" ? "Ending…" : "End session"}
          </button>
        </div>

        <div style={{ marginTop: 10 }}>
          <label style={fieldStyle}>
            <span style={fieldLabelStyle}>
              Send an input event to the live browser (only available while you
              hold control)
            </span>
            <input
              type="text"
              value={inputLine}
              onChange={(e) => onInputLineChange(e.target.value)}
              disabled={!control.canSendInput || busy}
              placeholder='e.g. click #save-button or type "Jane Doe"'
              style={inputStyle}
            />
          </label>
          <button
            type="button"
            onClick={onSendInput}
            disabled={
              busy || !control.canSendInput || inputLine.trim().length === 0
            }
            style={toggleButtonStyle(
              busy || !control.canSendInput || inputLine.trim().length === 0,
              "primary",
            )}
          >
            {busyAction === "send_input" ? "Sending…" : "Send input"}
          </button>
          <p style={{ ...mutedStyle, marginTop: 4 }}>
            The event string is forwarded verbatim to the worker; this view
            does not parse or execute it.
          </p>
        </div>
      </div>

      {/* ----------------------------- checkpoint -------------------------- */}
      <div style={{ marginTop: 16 }}>
        <h3 style={sectionHeadingStyle}>Pending checkpoint</h3>
        {data.pendingCheckpoint === null ? (
          <p style={mutedStyle}>
            No checkpoint is currently awaiting a reviewer decision.
          </p>
        ) : (
          <div style={checkpointCardStyle}>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "baseline",
                flexWrap: "wrap",
              }}
            >
              <strong style={{ fontSize: 13 }}>
                {data.pendingCheckpoint.title}
              </strong>
              {data.pendingCheckpoint.riskClass !== null && (
                <span style={riskBadgeStyle(data.pendingCheckpoint.riskClass)}>
                  {data.pendingCheckpoint.riskClass}
                </span>
              )}
              {data.pendingCheckpoint.stepKey !== null && (
                <code style={{ ...monoStyle, color: "#475569" }}>
                  step {data.pendingCheckpoint.stepKey}
                </code>
              )}
            </div>
            {data.pendingCheckpoint.rationale !== null && (
              <p style={{ ...mutedStyle, marginTop: 4 }}>
                {data.pendingCheckpoint.rationale}
              </p>
            )}
            {data.pendingCheckpoint.proposedAction !== null && (
              <pre style={preStyle}>
                {data.pendingCheckpoint.proposedAction}
              </pre>
            )}
            {data.pendingCheckpoint.requestedAt !== null && (
              <p style={{ ...mutedStyle, marginTop: 4 }}>
                Requested {formatIso(data.pendingCheckpoint.requestedAt)}
              </p>
            )}

            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={() => onApprove(data.pendingCheckpoint!.id)}
                disabled={busy || !control.canApprove}
                style={toggleButtonStyle(
                  busy || !control.canApprove,
                  "primary",
                )}
              >
                {busyAction === "approve_checkpoint"
                  ? "Approving…"
                  : "Approve"}
              </button>
              <button
                type="button"
                onClick={() =>
                  onReject(data.pendingCheckpoint!.id, rejectReason.trim())
                }
                disabled={
                  busy ||
                  !control.canReject ||
                  rejectReason.trim().length === 0
                }
                style={toggleButtonStyle(
                  busy ||
                    !control.canReject ||
                    rejectReason.trim().length === 0,
                  "danger",
                )}
              >
                {busyAction === "reject_checkpoint" ? "Rejecting…" : "Reject"}
              </button>
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                disabled={busy || !control.canReject}
                placeholder="Reason for rejection (required)"
                style={{ ...inputStyle, flex: 1, minWidth: 200 }}
              />
            </div>
          </div>
        )}
      </div>

      {/* -------------------------------- frames --------------------------- */}
      <div style={{ marginTop: 16 }}>
        <h3 style={sectionHeadingStyle}>
          Recent frames ({data.frames.length})
        </h3>
        {data.frames.length === 0 ? (
          <p style={mutedStyle}>No frames recorded for this session.</p>
        ) : (
          <ul style={frameListStyle}>
            {data.frames
              .slice()
              .reverse()
              .slice(0, 12)
              .map((f) => (
                <li key={f.id} style={frameItemStyle}>
                  <div style={{ fontSize: 12, color: "#475569" }}>
                    <code style={monoStyle}>{f.id}</code>
                    {f.stepKey !== null ? ` · step ${f.stepKey}` : ""}
                    {" · "}
                    {formatIso(f.capturedAt)}
                  </div>
                  {f.url !== null ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={f.url}
                      alt={f.label ?? `Frame ${f.id}`}
                      style={frameThumbStyle}
                    />
                  ) : (
                    <span style={{ ...mutedStyle, fontStyle: "italic" }}>
                      no reachable URL
                    </span>
                  )}
                </li>
              ))}
          </ul>
        )}
      </div>

      {/* -------------------------------- notes ---------------------------- */}
      {data.notes.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={sectionHeadingStyle}>Notes</h3>
          <ul style={{ ...listStyle, color: "#475569" }}>
            {data.notes.map((n, i) => (
              <li key={i} style={{ fontSize: 12 }}>
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Subcomponents                                                               */
/* -------------------------------------------------------------------------- */

function StateBadge({ state }: { readonly state: LiveSessionState }) {
  const palette = (() => {
    switch (state) {
      case "running":
        return { bg: "#dbeafe", fg: "#1e3a8a", label: "running" };
      case "paused":
        return { bg: "#fef9c3", fg: "#854d0e", label: "paused" };
      case "awaiting_human":
        return { bg: "#fef3c7", fg: "#92400e", label: "awaiting human" };
      case "human_in_control":
        return { bg: "#ede9fe", fg: "#4c1d95", label: "human in control" };
      case "ended":
        return { bg: "#e2e8f0", fg: "#334155", label: "ended" };
      case "failed":
        return { bg: "#fee2e2", fg: "#7f1d1d", label: "failed" };
      case "idle":
        return { bg: "#e2e8f0", fg: "#334155", label: "idle" };
      case "unknown":
        return { bg: "#f1f5f9", fg: "#475569", label: "unknown" };
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
        whiteSpace: "nowrap",
      }}
    >
      {palette.label}
    </span>
  );
}

function LeaseBadge({ lease }: { readonly lease: ControlLease }) {
  const palette = (() => {
    if (lease.expired) {
      return { bg: "#f1f5f9", fg: "#475569", label: "lease expired" };
    }
    if (lease.heldByCurrentUser) {
      return { bg: "#dcfce7", fg: "#166534", label: "you hold control" };
    }
    if (lease.heldBy !== null) {
      return { bg: "#dbeafe", fg: "#1e3a8a", label: "held by another" };
    }
    return { bg: "#e2e8f0", fg: "#334155", label: "unclaimed" };
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
        whiteSpace: "nowrap",
      }}
    >
      {palette.label}
    </span>
  );
}

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

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

const SESSION_STATES: readonly LiveSessionState[] = [
  "idle",
  "running",
  "paused",
  "awaiting_human",
  "human_in_control",
  "ended",
  "failed",
  "unknown",
];

const TRANSPORTS: readonly LiveChannelTransport[] = [
  "none",
  "websocket",
  "sse",
  "polling",
];

function asSessionState(v: unknown): LiveSessionState {
  return typeof v === "string" &&
    (SESSION_STATES as readonly string[]).includes(v)
    ? (v as LiveSessionState)
    : "unknown";
}

function asTransport(v: unknown): LiveChannelTransport {
  return typeof v === "string" &&
    (TRANSPORTS as readonly string[]).includes(v)
    ? (v as LiveChannelTransport)
    : "none";
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseControlLease(v: unknown): ControlLease | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return {
    heldBy: typeof r["heldBy"] === "string" ? r["heldBy"] : null,
    holderDisplay:
      typeof r["holderDisplay"] === "string" ? r["holderDisplay"] : null,
    heldByCurrentUser: r["heldByCurrentUser"] === true,
    expiresAt: typeof r["expiresAt"] === "string" ? r["expiresAt"] : null,
    expired: r["expired"] === true,
  };
}

function parseLiveChannel(v: unknown): LiveChannel | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return {
    transport: asTransport(r["transport"]),
    url: typeof r["url"] === "string" ? r["url"] : null,
    configured: r["configured"] === true,
    note: typeof r["note"] === "string" ? r["note"] : null,
  };
}

function parseFrame(v: unknown): SessionFrame | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r["id"] !== "string" || typeof r["capturedAt"] !== "string") {
    return null;
  }
  return {
    id: r["id"],
    capturedAt: r["capturedAt"],
    url: typeof r["url"] === "string" ? r["url"] : null,
    label: typeof r["label"] === "string" ? r["label"] : null,
    stepKey: typeof r["stepKey"] === "string" ? r["stepKey"] : null,
  };
}

function parsePendingCheckpoint(v: unknown): PendingCheckpoint | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r["id"] !== "string" || typeof r["title"] !== "string") {
    return null;
  }
  return {
    id: r["id"],
    stepKey: typeof r["stepKey"] === "string" ? r["stepKey"] : null,
    title: r["title"],
    riskClass: typeof r["riskClass"] === "string" ? r["riskClass"] : null,
    rationale: typeof r["rationale"] === "string" ? r["rationale"] : null,
    proposedAction:
      typeof r["proposedAction"] === "string" ? r["proposedAction"] : null,
    requestedAt: typeof r["requestedAt"] === "string" ? r["requestedAt"] : null,
  };
}

function parseSnapshot(value: unknown): LiveSessionSnapshot | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["workflowId"] !== "string" ||
    typeof v["message"] !== "string"
  ) {
    return null;
  }
  if (!isStringArray(v["notes"])) return null;
  const lease = parseControlLease(v["controlLease"]);
  const channel = parseLiveChannel(v["liveChannel"]);
  if (lease === null || channel === null) return null;

  const framesRaw = v["frames"];
  if (!Array.isArray(framesRaw)) return null;
  const frames: SessionFrame[] = [];
  for (const f of framesRaw) {
    const parsed = parseFrame(f);
    if (parsed === null) return null;
    frames.push(parsed);
  }

  const viewportRaw = v["viewport"];
  let viewport: { width: number; height: number } | null = null;
  if (viewportRaw !== null && typeof viewportRaw === "object") {
    const vp = viewportRaw as Record<string, unknown>;
    if (
      typeof vp["width"] === "number" &&
      Number.isFinite(vp["width"]) &&
      typeof vp["height"] === "number" &&
      Number.isFinite(vp["height"])
    ) {
      viewport = {
        width: Math.trunc(vp["width"] as number),
        height: Math.trunc(vp["height"] as number),
      };
    }
  }

  return {
    workflowId: v["workflowId"],
    runId: typeof v["runId"] === "string" ? v["runId"] : null,
    sessionId: typeof v["sessionId"] === "string" ? v["sessionId"] : null,
    state: asSessionState(v["state"]),
    controlLease: lease,
    liveChannel: channel,
    currentUrl: typeof v["currentUrl"] === "string" ? v["currentUrl"] : null,
    viewport,
    frames,
    pendingCheckpoint: parsePendingCheckpoint(v["pendingCheckpoint"]),
    message: v["message"],
    notes: v["notes"],
  };
}

function parseActionResponse(value: unknown): SessionActionResponse | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["workflowId"] !== "string" || typeof v["message"] !== "string") {
    return null;
  }
  if (!isStringArray(v["notes"])) return null;
  const lease = parseControlLease(v["controlLease"]);
  if (lease === null) return null;
  return {
    workflowId: v["workflowId"],
    sessionId: typeof v["sessionId"] === "string" ? v["sessionId"] : null,
    state: asSessionState(v["state"]),
    controlLease: lease,
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

function riskBadgeStyle(riskClass: string): CSSProperties {
  const palette = (() => {
    switch (riskClass) {
      case "destructive":
      case "financial":
      case "external_communication":
        return { bg: "#fee2e2", fg: "#7f1d1d" };
      case "write":
        return { bg: "#fef3c7", fg: "#92400e" };
      case "read_only":
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

function toggleButtonStyle(
  disabled: boolean,
  tone: "primary" | "neutral" | "danger",
): CSSProperties {
  const palette = (() => {
    switch (tone) {
      case "primary":
        return { bg: "#1d4ed8", bgDisabled: "#93c5fd", border: "#1d4ed8" };
      case "danger":
        return { bg: "#b91c1c", bgDisabled: "#fca5a5", border: "#b91c1c" };
      case "neutral":
        return { bg: "#ffffff", bgDisabled: "#f1f5f9", border: "#cbd5e1" };
    }
  })();
  return {
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 6,
    border: `1px solid ${palette.border}`,
    background: disabled ? palette.bgDisabled : palette.bg,
    color: disabled
      ? "#64748b"
      : tone === "neutral"
        ? "#1d4ed8"
        : "#ffffff",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const cardStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
  maxWidth: 860,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 8,
};

const statusRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
  marginBottom: 8,
};

const metaGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 8,
  padding: 8,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
};

const sectionHeadingStyle: CSSProperties = {
  margin: "0 0 6px",
  fontSize: 13,
  fontWeight: 600,
  color: "#0f172a",
};

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const frameListStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: 6,
};

const frameItemStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: 6,
  background: "#ffffff",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const frameImageStyle: CSSProperties = {
  display: "block",
  maxWidth: "100%",
  maxHeight: 420,
  border: "1px solid #e2e8f0",
  borderRadius: 4,
  background: "#f8fafc",
  objectFit: "contain",
};

const frameThumbStyle: CSSProperties = {
  display: "block",
  width: "100%",
  height: 90,
  objectFit: "cover",
  border: "1px solid #e2e8f0",
  borderRadius: 4,
  background: "#f8fafc",
};

const leaseRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};

const checkpointCardStyle: CSSProperties = {
  border: "1px solid #fde68a",
  borderRadius: 8,
  padding: "10px 12px",
  background: "#fffbeb",
};

const fieldStyle: CSSProperties = {
  display: "block",
  marginBottom: 6,
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

const mutedStyle: CSSProperties = {
  color: "#64748b",
  fontSize: 12,
  margin: "4px 0",
};

const noticeStyle: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  background: "#eff6ff",
  color: "#1e3a8a",
  fontSize: 12,
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

const monoStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
};

const preStyle: CSSProperties = {
  margin: "6px 0 0",
  padding: "6px 8px",
  background: "#0f172a",
  color: "#e2e8f0",
  borderRadius: 4,
  fontSize: 11,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
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
