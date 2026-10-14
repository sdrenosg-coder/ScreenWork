"use client";
/**
 * Zipy AI — ActivityFeed component (phase 20, batch 3).
 *
 * Renders a workspace activity feed for the guide/host UI. The component is
 * presentational: it fetches from a caller-supplied `endpoint` and renders
 * the returned events. It does not invent events, does not poll by default
 * (the caller decides cadence) and does not fabricate timestamps or actors.
 *
 * Design rules honoured here:
 *   - **No fabricated credentials or actors.** Every field rendered comes
 *     from the server payload. Missing fields are rendered as explicit
 *     placeholders (`"(unknown actor)"`) rather than being filled in.
 *   - **Explicit failure.** A non-OK response renders an error banner that
 *     names the HTTP status and, when the server supplied one, the reason.
 *     The feed never presents an empty state as if the workspace had no
 *     activity when the fetch failed.
 *   - **No polling by default.** `pollIntervalMs` is an explicit opt-in.
 *   - **Accessible.** The list uses `<ul role="log">`; each event's
 *     description is a proper sentence; timestamps use `<time>` with a
 *     machine-readable `dateTime`.
 *
 * What this component does *not* do:
 *   - It does not mutate. Actions like "open guide" or "open workflow" are
 *     plain anchor links to caller-supplied URLs.
 *   - It does not paginate with infinite scroll; a `hasMore` footer link is
 *     rendered when the caller passes one.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type ActivityEventKind =
  | "guide.created"
  | "guide.published"
  | "guide.updated"
  | "guide.exported"
  | "workflow.reviewed"
  | "workflow.approved"
  | "workflow.rejected"
  | "comment.created"
  | "member.joined"
  | "domain.registered"
  | "domain.verified"
  | "other";

export interface ActivityEvent {
  readonly id: string;
  readonly kind: ActivityEventKind;
  /** ISO timestamp supplied by the server; the component never synthesises one. */
  readonly at: string;
  /** The acting user, when the server knows one. */
  readonly actor: {
    readonly id: string;
    readonly displayName: string;
  } | null;
  /** The workspace the event belongs to. */
  readonly workspaceId: string;
  /** Human-readable summary; author is the server, not this component. */
  readonly summary: string;
  /** Optional resource the event concerns; a link when `href` is set. */
  readonly resource: {
    readonly kind: string;
    readonly id: string;
    readonly label: string;
    readonly href: string | null;
  } | null;
  /** Extra type-specific detail; rendered as key/value pairs when present. */
  readonly details: Readonly<Record<string, string>> | null;
}

export interface ActivityFeedProps {
  /**
   * Endpoint returning `{ events: ActivityEvent[], nextCursor: string | null }`.
   * The endpoint must enforce workspace scoping itself; this component
   * forwards cookies but adds no tenant filter.
   */
  readonly endpoint: string;
  /**
   * When set, poll on this interval (milliseconds). When `undefined` or
   * `null`, the component fetches once and does not poll.
   */
  readonly pollIntervalMs?: number | null;
  /** Optional heading; when omitted, no heading is rendered. */
  readonly title?: string;
  /** Optional cap on rendered events; unknown server-side larger lists are truncated client-side. */
  readonly limit?: number;
  /** Rendered as an empty-state line when the server returns zero events. */
  readonly emptyMessage?: string;
  /**
   * When set, a "Load older" link is rendered that appends the previous
   * page (the server supplies `nextCursor`).
   */
  readonly nextPageHref?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Server response shape                                                       */
/* -------------------------------------------------------------------------- */

interface FeedResponse {
  readonly events: readonly ActivityEvent[];
  readonly nextCursor: string | null;
}

function isFeedResponse(value: unknown): value is FeedResponse {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v["events"]);
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export function ActivityFeed({
  endpoint,
  pollIntervalMs = null,
  title,
  limit,
  emptyMessage = "No activity yet in this workspace.",
  nextPageHref = null,
}: ActivityFeedProps): JSX.Element {
  const [state, setState] = useState<
    | { readonly phase: "loading" }
    | { readonly phase: "error"; readonly status: number | null; readonly message: string }
    | { readonly phase: "ready"; readonly events: readonly ActivityEvent[]; readonly nextCursor: string | null }
  >({ phase: "loading" });

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      try {
        const res = await fetch(endpoint, {
          method: "GET",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal,
        });
        if (!res.ok) {
          let detail = "";
          try {
            const body = (await res.json()) as unknown;
            if (body !== null && typeof body === "object") {
              const b = body as Record<string, unknown>;
              if (typeof b["error"] === "string") detail = b["error"];
              else if (typeof b["message"] === "string") detail = b["message"];
            }
          } catch {
            // Non-JSON error body; nothing to extract.
          }
          setState({
            phase: "error",
            status: res.status,
            message:
              detail.length > 0
                ? `Activity could not be loaded (HTTP ${res.status}): ${detail}`
                : `Activity could not be loaded (HTTP ${res.status}).`,
          });
          return;
        }
        const body = (await res.json()) as unknown;
        if (!isFeedResponse(body)) {
          setState({
            phase: "error",
            status: res.status,
            message: "Activity could not be loaded: unexpected response shape.",
          });
          return;
        }
        const events = limit !== undefined && limit > 0
          ? body.events.slice(0, limit)
          : body.events;
        setState({
          phase: "ready",
          events,
          nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({
          phase: "error",
          status: null,
          message:
            err instanceof Error
              ? `Activity could not be loaded: ${err.message}`
              : "Activity could not be loaded.",
        });
      }
    },
    [endpoint, limit],
  );

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    void load(controller.signal);
    if (pollIntervalMs === null || pollIntervalMs === undefined || pollIntervalMs <= 0) {
      return () => {
        controller.abort();
      };
    }
    const handle = window.setInterval(() => {
      // A polling load reuses the same abort controller so unmount cancels
      // both the in-flight fetch and the timer's next attempt.
      if (controller.signal.aborted) return;
      void load(controller.signal);
    }, pollIntervalMs);
    return () => {
      window.clearInterval(handle);
      controller.abort();
    };
  }, [load, pollIntervalMs]);

  if (state.phase === "loading") {
    return (
      <section aria-busy="true" style={sectionStyle}>
        {title !== undefined ? <h2 style={headingStyle}>{title}</h2> : null}
        <p style={{ color: "#6b7280", fontSize: 13 }}>Loading activity…</p>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section style={sectionStyle} role="alert">
        {title !== undefined ? <h2 style={headingStyle}>{title}</h2> : null}
        <p
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "8px 10px",
            borderRadius: 6,
            fontSize: 13,
            margin: 0,
          }}
        >
          {state.message}
        </p>
      </section>
    );
  }

  if (state.events.length === 0) {
    return (
      <section style={sectionStyle}>
        {title !== undefined ? <h2 style={headingStyle}>{title}</h2> : null}
        <p style={{ color: "#6b7280", fontSize: 13 }}>{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section style={sectionStyle}>
      {title !== undefined ? <h2 style={headingStyle}>{title}</h2> : null}
      <ul
        role="log"
        aria-live="polite"
        style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}
      >
        {state.events.map((event) => (
          <li key={event.id} style={itemStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13, color: "#0f172a", wordBreak: "break-word" }}>
                  {event.summary}
                </span>
                <span style={{ fontSize: 12, color: "#6b7280" }}>
                  {actorLabel(event.actor)}
                  {event.resource !== null ? (
                    <>
                      {" · "}
                      {event.resource.href !== null ? (
                        <a
                          href={event.resource.href}
                          style={{ color: "#1d4ed8", textDecoration: "none" }}
                        >
                          {event.resource.label}
                        </a>
                      ) : (
                        event.resource.label
                      )}
                    </>
                  ) : null}
                </span>
                {event.details !== null && Object.keys(event.details).length > 0 ? (
                  <dl style={detailsStyle}>
                    {Object.entries(event.details).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", gap: 6 }}>
                        <dt style={{ color: "#6b7280" }}>{k}:</dt>
                        <dd style={{ margin: 0, color: "#0f172a" }}>{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
              <time
                dateTime={event.at}
                title={event.at}
                style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}
              >
                {formatRelative(event.at)}
              </time>
            </div>
          </li>
        ))}
      </ul>
      {nextPageHref !== null && nextPageHref.length > 0 ? (
        <p style={{ marginTop: 10, fontSize: 13 }}>
          <a href={nextPageHref} style={{ color: "#1d4ed8" }}>
            Load older activity
          </a>
        </p>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                          */
/* -------------------------------------------------------------------------- */

function actorLabel(actor: ActivityEvent["actor"]): string {
  if (actor === null) return "(unknown actor)";
  const name = actor.displayName.trim();
  return name.length > 0 ? name : `(user ${actor.id})`;
}

/**
 * Render a relative time from an ISO timestamp. Falls back to the raw
 * string when the timestamp cannot be parsed rather than guessing a value;
 * the `<time>` element's `dateTime` and `title` still carry the canonical
 * value for assistive technology.
 */
function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const now = Date.now();
  const deltaSeconds = Math.round((now - t) / 1000);
  if (Math.abs(deltaSeconds) < 45) return "just now";
  const units: readonly { readonly limit: number; readonly seconds: number; readonly label: string }[] = [
    { limit: 60, seconds: 1, label: "s" },
    { limit: 60, seconds: 60, label: "m" },
    { limit: 24, seconds: 3600, label: "h" },
    { limit: 7, seconds: 86_400, label: "d" },
    { limit: 5, seconds: 604_800, label: "w" },
    { limit: Number.POSITIVE_INFINITY, seconds: 2_592_000, label: "mo" },
  ];
  const value = deltaSeconds < 0 ? -deltaSeconds : deltaSeconds;
  let prevLimit = 1;
  for (const unit of units) {
    const count = Math.round(value / unit.seconds);
    if (count < unit.limit * prevLimit || unit.limit === Number.POSITIVE_INFINITY) {
      if (deltaSeconds >= 0) return `${count}${unit.label} ago`;
      return `in ${count}${unit.label}`;
    }
    prevLimit = unit.limit;
  }
  // Unreachable given the terminal `Infinity` bucket; returned for clarity.
  return iso;
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const sectionStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "12px 14px",
  background: "#ffffff",
};

const headingStyle: React.CSSProperties = {
  margin: "0 0 8px 0",
  fontSize: 14,
  fontWeight: 600,
  color: "#0f172a",
};

const itemStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #eef2f6",
  borderRadius: 6,
  background: "#fbfcfe",
};

const detailsStyle: React.CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: 12,
  display: "grid",
  gap: 2,
};

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  actorLabel,
  formatRelative,
  isFeedResponse,
});
