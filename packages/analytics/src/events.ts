/**
 * Zipy AI — analytics: event schema, ingestion and validation (phase 23, batch 0).
 *
 * The analytics layer records *what a reader did with a published guide* —
 * page views, step views, step completions, abandons, searches within a
 * guide and per-step feedback. It is deliberately separate from the audit
 * log (`@zipy/security/auditLog`), which records *who changed what*: the
 * audit log is a compliance record an admin must be able to read back
 * verbatim; the analytics store is an append-heavy time-series whose
 * aggregates drive dashboards and reports.
 *
 * Design rules honoured:
 *
 *  - **Nothing is invented.** The recorder accepts only the event kinds the
 *    schema enumerates. An unknown kind is rejected with a diagnostic, not
 *    coerced to a known one. A malformed timestamp is rejected, not replaced
 *    with `Date.now()`.
 *
 *  - **Workspace-scoped.** Every event carries a `workspaceId` and a
 *    `guideId`. The recorder refuses an event without a non-empty string for
 *    either; a caller in workspace A cannot write an event tagged for
 *    workspace B without the caller passing B's id, at which point the
 *    scoping is the caller's responsibility (the route layer enforces it).
 *
 *  - **PII discipline.** The event payload is a small key/value bag whose
 *    keys are restricted to a known allowlist. The recorder refuses a
 *    payload key outside that allowlist so a caller cannot smuggle a full
 *    search term that contains a customer email into the analytics store:
 *    the search event carries a *hashed* query key plus a *length*, not the
 *    raw query, and the searcher's own consent flag decides whether the raw
 *    query is also stored (it defaults to off; the caller must opt in).
 *
 *  - **Append-only, idempotent by event id.** The same `eventId` submitted
 *    twice is a no-op the second time. The recorder is a pure function of
 *    the event and the store snapshot it is given; the actual persistence is
 *    owned by the route/worker layer, so this module is unit-testable with
 *    an in-memory store.
 *
 *  - **Deterministic.** No randomness, no clock reads outside the single
 *    `receivedAt` stamp the recorder normally supplies from the caller; a
 *    caller that supplies its own `occurredAt` and `receivedAt` gets
 *    identical output on a replay.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AnalyticsEventErrorCode =
  | "invalid-input"
  | "unknown-event-kind"
  | "unknown-payload-key"
  | "missing-scope"
  | "invalid-timestamp"
  | "duplicate-event-id"
  | "invalid-feedback";

export class AnalyticsEventError extends Error {
  readonly code: AnalyticsEventErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: AnalyticsEventErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The event kinds the analytics layer recognises. Adding a kind is a schema
 * change; the enum lives here so the recorder, the aggregators and the
 * route handler all read one list.
 */
export const ANALYTICS_EVENT_KINDS = [
  "guide-view",
  "guide-complete",
  "step-view",
  "step-complete",
  "step-drop-off",
  "guide-search",
  "step-feedback",
  "guide-feedback",
  "generation-run",
] as const;
export type AnalyticsEventKind = (typeof ANALYTICS_EVENT_KINDS)[number];

/**
 * The allowlist of payload keys a caller may attach to an event. Deliberately
 * tiny: an analytics payload is a small key/value bag for aggregation, not a
 * general-purpose sink. Anything that does not belong here belongs in the
 * audit log or in a source artefact, not in this store.
 */
export const ANALYTICS_PAYLOAD_KEYS = [
  "stepId",
  "stepIndex",
  "stepCount",
  "durationMs",
  "reachedIndex",
  "queryHash",
  "queryLength",
  "queryText",
  "rating",
  "reason",
  "device",
  "locale",
] as const;
export type AnalyticsPayloadKey = (typeof ANALYTICS_PAYLOAD_KEYS)[number];

export interface AnalyticsPayload {
  readonly stepId?: string;
  readonly stepIndex?: number;
  readonly stepCount?: number;
  readonly durationMs?: number;
  readonly reachedIndex?: number;
  /** A caller-computed hash of the search query, e.g. sha256 hex truncated. */
  readonly queryHash?: string;
  /** Length in code points; enough to aggregate "short vs long queries". */
  readonly queryLength?: number;
  /**
   * The raw search string. The recorder keeps this *only* when the caller
   * passes `searchConsent: true`. When consent is omitted, the recorder
   * strips this key before storing and records a diagnostic.
   */
  readonly queryText?: string;
  /** 1..5 for step/guide feedback. */
  readonly rating?: number;
  /** Short machine-readable reason for a drop-off or a negative rating. */
  readonly reason?: string;
  readonly device?: "desktop" | "tablet" | "mobile";
  /** BCP-47 language tag. */
  readonly locale?: string;
}

/**
 * A persisted analytics event. Fields are all non-optional once recorded so
 * an aggregator can read a single canonical shape.
 */
export interface AnalyticsEvent {
  readonly version: "analytics/1";
  /** Caller-supplied idempotency key. Unique per workspace. */
  readonly eventId: string;
  readonly workspaceId: string;
  readonly guideId: string;
  /** Optional slug; used for the public view counter and the published-page route. */
  readonly slug: string | null;
  readonly kind: AnalyticsEventKind;
  /**
   * An opaque session identifier. Not a cookie value and not a user id: the
   * caller's renderer computes a per-load random id so the pipeline can
   * count sessions without tracking a person across guides. The recorder
   * does not derive one.
   */
  readonly sessionId: string;
  /** User id when the reader is signed in; null for anonymous reads. */
  readonly userId: string | null;
  /** ISO timestamp the reader's browser reported the action occurred. */
  readonly occurredAt: string;
  /** ISO timestamp the recorder accepted the event. */
  readonly receivedAt: string;
  /** The small key/value bag. Validated against `ANALYTICS_PAYLOAD_KEYS`. */
  readonly payload: AnalyticsPayload;
  /**
   * Set to true when the caller opted in to storing the raw search query for
   * a `guide-search` event. Always false for every other kind.
   */
  readonly searchConsentStored: boolean;
  /** Non-fatal notes (e.g. a key stripped because consent was not given). */
  readonly notes: readonly string[];
}

export interface RecordEventInput {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly guideId: string;
  readonly slug?: string | null;
  readonly kind: AnalyticsEventKind;
  readonly sessionId: string;
  readonly userId?: string | null;
  /** ISO timestamp; when omitted the recorder reads the clock. */
  readonly occurredAt?: string;
  /** ISO timestamp; when omitted the recorder reads the clock. */
  readonly receivedAt?: string;
  readonly payload?: AnalyticsPayload;
  /** Opt-in for storing the raw search query on a `guide-search` event. */
  readonly searchConsent?: boolean;
}

/**
 * The minimal store interface the recorder persists to. Kept as an interface
 * so the unit tests can supply an in-memory implementation and the production
 * route can hand in the Postgres-backed one. `append` must be atomic and
 * must reject a duplicate `eventId` for the same workspace.
 */
export interface AnalyticsEventStore {
  append(event: AnalyticsEvent): void;
  has(eventId: string, workspaceId: string): boolean;
  all(): readonly AnalyticsEvent[];
}

export interface InMemoryEventStoreOptions {
  /**
   * Optional hard cap so an accidental double-submit loop cannot grow the
   * process's memory without bound. When the cap is hit the oldest event is
   * dropped; the record is still returned to the caller so the aggregator
   * sees a consistent view.
   */
  readonly maxEvents?: number;
}

export interface InMemoryEventStore extends AnalyticsEventStore {
  /** Convenience for tests: a copy of the current events, oldest first. */
  snapshot(): readonly AnalyticsEvent[];
  clear(): void;
}

/* -------------------------------------------------------------------------- */
/* Public API — recorder                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Validate and stamp one event. Pure: the same `input` (including a supplied
 * `occurredAt` and `receivedAt`) produces byte-identical output. The store is
 * not consulted here — that is the caller's job, so a batch of events can be
 * validated up front and only the valid ones are persisted.
 */
export function recordEvent(input: RecordEventInput): AnalyticsEvent {
  if (input === null || typeof input !== "object") {
    throw new AnalyticsEventError("recordEvent requires an input object.", "invalid-input");
  }
  const notes: string[] = [];

  const eventId = requireNonEmpty(input.eventId, "eventId");
  const workspaceId = requireNonEmpty(input.workspaceId, "workspaceId");
  const guideId = requireNonEmpty(input.guideId, "guideId");
  const sessionId = requireNonEmpty(input.sessionId, "sessionId");

  if (!isAnalyticsEventKind(input.kind)) {
    throw new AnalyticsEventError(
      `Unknown event kind "${String(input.kind)}". Expected one of: ${ANALYTICS_EVENT_KINDS.join(", ")}.`,
      "unknown-event-kind",
      { kind: input.kind },
    );
  }

  const occurredAt = readTimestamp(input.occurredAt, "occurredAt", () => new Date().toISOString());
  const receivedAt = readTimestamp(input.receivedAt, "receivedAt", () => new Date().toISOString());

  const payload = prunePayload(input.payload ?? {}, input.kind, notes);
  const searchConsentStored =
    input.kind === "guide-search" && input.searchConsent === true;

  if (input.kind === "guide-search") {
    if (Object.prototype.hasOwnProperty.call(payload, "queryText") && !searchConsentStored) {
      // Strip the raw query; the hashed key and length remain.
      delete (payload as { queryText?: string }).queryText;
      notes.push(
        "The raw search query was stripped because `searchConsent` was not set; only the hashed query key and length were stored.",
      );
    }
    if (searchConsentStored && !Object.prototype.hasOwnProperty.call(payload, "queryText")) {
      notes.push(
        "`searchConsent` was set but no `queryText` was supplied; the search event stores only the hashed key and length.",
      );
    }
  } else if (Object.prototype.hasOwnProperty.call(payload, "queryText")) {
    delete (payload as { queryText?: string }).queryText;
    notes.push(
      "The `queryText` payload field is only valid on a `guide-search` event and was dropped.",
    );
  }

  if (input.kind === "step-feedback" || input.kind === "guide-feedback") {
    const rating = payload.rating;
    if (rating === undefined) {
      throw new AnalyticsEventError(
        `A "${input.kind}" event requires a "rating" payload field between 1 and 5.`,
        "invalid-feedback",
        { kind: input.kind },
      );
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new AnalyticsEventError(
        `The "rating" payload field must be an integer between 1 and 5; received ${String(rating)}.`,
        "invalid-feedback",
        { rating },
      );
    }
  }

  const event: AnalyticsEvent = {
    version: "analytics/1",
    eventId,
    workspaceId,
    guideId,
    slug: readOptionalNonEmpty(input.slug),
    kind: input.kind,
    sessionId,
    userId: readOptionalNonEmpty(input.userId),
    occurredAt,
    receivedAt,
    payload,
    searchConsentStored,
    notes,
  };
  return event;
}

/**
 * Record many events idempotently against a store, returning the outcome for
 * each. Duplicate `eventId`s within the same workspace are skipped (not
 * errors) so a browser retrying a failed batch does not double-count.
 */
export function recordEvents(
  inputs: readonly RecordEventInput[],
  store: AnalyticsEventStore,
): readonly { readonly event: AnalyticsEvent; readonly accepted: boolean; readonly reason: string | null }[] {
  if (!Array.isArray(inputs)) {
    throw new AnalyticsEventError("recordEvents requires an array of inputs.", "invalid-input");
  }
  if (store === null || typeof store !== "object") {
    throw new AnalyticsEventError("recordEvents requires a store.", "invalid-input");
  }
  const out: { event: AnalyticsEvent; accepted: boolean; reason: string | null }[] = [];
  for (const input of inputs) {
    const event = recordEvent(input);
    if (store.has(event.eventId, event.workspaceId)) {
      out.push({
        event,
        accepted: false,
        reason: `Event "${event.eventId}" already recorded for workspace "${event.workspaceId}".`,
      });
      continue;
    }
    store.append(event);
    out.push({ event, accepted: true, reason: null });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* In-memory store (tests / single-process dev)                                */
/* -------------------------------------------------------------------------- */

export function createInMemoryEventStore(
  options: InMemoryEventStoreOptions = {},
): InMemoryEventStore {
  const maxEvents =
    typeof options.maxEvents === "number" && options.maxEvents > 0
      ? Math.floor(options.maxEvents)
      : 100_000;
  const events: AnalyticsEvent[] = [];
  const keys = new Set<string>();

  return {
    append(event: AnalyticsEvent): void {
      const key = `${event.workspaceId}\u0000${event.eventId}`;
      if (keys.has(key)) {
        throw new AnalyticsEventError(
          `Event "${event.eventId}" already recorded for workspace "${event.workspaceId}".`,
          "duplicate-event-id",
          { eventId: event.eventId, workspaceId: event.workspaceId },
        );
      }
      keys.add(key);
      events.push(event);
      if (events.length > maxEvents) {
        const dropped = events.shift();
        if (dropped !== undefined) keys.delete(`${dropped.workspaceId}\u0000${dropped.eventId}`);
      }
    },
    has(eventId: string, workspaceId: string): boolean {
      return keys.has(`${workspaceId}\u0000${eventId}`);
    },
    all(): readonly AnalyticsEvent[] {
      return events.slice();
    },
    snapshot(): readonly AnalyticsEvent[] {
      return events.slice();
    },
    clear(): void {
      events.length = 0;
      keys.clear();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Type guards                                                                 */
/* -------------------------------------------------------------------------- */

export function isAnalyticsEventKind(v: unknown): v is AnalyticsEventKind {
  return typeof v === "string" && (ANALYTICS_EVENT_KINDS as readonly string[]).includes(v);
}

export function isAnalyticsPayloadKey(v: unknown): v is AnalyticsPayloadKey {
  return typeof v === "string" && (ANALYTICS_PAYLOAD_KEYS as readonly string[]).includes(v);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function requireNonEmpty(v: unknown, field: string): string {
  if (typeof v !== "string") {
    throw new AnalyticsEventError(
      `Field "${field}" is required and must be a string.`,
      "missing-scope",
      { field },
    );
  }
  const t = v.trim();
  if (t.length === 0) {
    throw new AnalyticsEventError(
      `Field "${field}" must not be empty.`,
      "missing-scope",
      { field },
    );
  }
  return t;
}

function readOptionalNonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function readTimestamp(
  v: unknown,
  field: string,
  fallback: () => string,
): string {
  if (v === undefined) return fallback();
  if (typeof v !== "string") {
    throw new AnalyticsEventError(
      `Field "${field}" must be an ISO-8601 string when supplied.`,
      "invalid-timestamp",
      { field },
    );
  }
  const t = v.trim();
  if (t.length === 0) {
    throw new AnalyticsEventError(
      `Field "${field}" must not be empty when supplied.`,
      "invalid-timestamp",
      { field },
    );
  }
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) {
    throw new AnalyticsEventError(
      `Field "${field}" is not a valid ISO-8601 timestamp: "${t}".`,
      "invalid-timestamp",
      { field, value: t },
    );
  }
  return new Date(ms).toISOString();
}

function prunePayload(
  raw: AnalyticsPayload,
  kind: AnalyticsEventKind,
  notes: string[],
): AnalyticsPayload {
  if (raw === null || typeof raw !== "object") {
    throw new AnalyticsEventError("`payload` must be an object.", "invalid-input");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!isAnalyticsPayloadKey(key)) {
      throw new AnalyticsEventError(
        `Unknown analytics payload key "${key}". Allowed keys: ${ANALYTICS_PAYLOAD_KEYS.join(", ")}.`,
        "unknown-payload-key",
        { key },
      );
    }
    out[key] = value;
  }

  // Per-key shape checks. Unknown shapes are rejected so the aggregator
  // never has to defensively coerce.
  if (out.stepIndex !== undefined && !isNonNegativeInt(out.stepIndex)) {
    throw new AnalyticsEventError(
      "Payload key \"stepIndex\" must be a non-negative integer.",
      "invalid-input",
      { value: out.stepIndex },
    );
  }
  if (out.stepCount !== undefined && !isNonNegativeInt(out.stepCount)) {
    throw new AnalyticsEventError(
      "Payload key \"stepCount\" must be a non-negative integer.",
      "invalid-input",
      { value: out.stepCount },
    );
  }
  if (out.reachedIndex !== undefined && !isNonNegativeInt(out.reachedIndex)) {
    throw new AnalyticsEventError(
      "Payload key \"reachedIndex\" must be a non-negative integer.",
      "invalid-input",
      { value: out.reachedIndex },
    );
  }
  if (out.durationMs !== undefined && (typeof out.durationMs !== "number" || !Number.isFinite(out.durationMs) || out.durationMs < 0)) {
    throw new AnalyticsEventError(
      "Payload key \"durationMs\" must be a non-negative finite number.",
      "invalid-input",
      { value: out.durationMs },
    );
  }
  if (out.queryLength !== undefined && !isNonNegativeInt(out.queryLength)) {
    throw new AnalyticsEventError(
      "Payload key \"queryLength\" must be a non-negative integer.",
      "invalid-input",
      { value: out.queryLength },
    );
  }

  // Emit a stable key order so two identical events serialise byte-identically.
  const ordered: Record<string, unknown> = {};
  for (const key of ANALYTICS_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) ordered[key] = out[key];
  }
  // The kind is validated before payload; nobody above relies on the notes
  // for anything kind-specific except the search strip, which the caller
  // performs. Nothing else to record here. Kept for a future extension.
  void kind;
  void notes;
  return ordered as AnalyticsPayload;
}

function isNonNegativeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  requireNonEmpty,
  readOptionalNonEmpty,
  readTimestamp,
  prunePayload,
  isNonNegativeInt,
});

--- end packages/analytics/src/events.ts ---
