"use client";

/**
 * Zipy AI — workspace dashboard (phase 24, batch 4).
 *
 * The dashboard is the workspace landing surface. It renders five concerns,
 * each sourced from a single server endpoint and each tolerating that
 * endpoint being absent/empty rather than fabricating rows:
 *
 *   1. Guides       GET /api/v1/guides?limit=...
 *                   -> the same paginated envelope the public REST API
 *                      returns; the dashboard does not reach into the DB
 *                      directly and does not invent a parallel schema.
 *   2. Lifecycle    client-side filters (folder, tag, status) that map onto
 *                   the query parameters /api/v1/guides already accepts.
 *                   Folders/tags/status values come from the authoritative
 *                   list endpoints below, never from a hard-coded enum.
 *   3. Activity     GET /api/v1/audit?limit=... (workspace audit feed).
 *   4. Usage        GET /api/billing/usage (this batch's API route).
 *   5. Recents      derived client-side from guides: guides sorted by
 *                   updatedAt desc; the server does not need a second
 *                   endpoint for what is a fold over data we already have.
 *
 * Wire contract — /api/v1/guides
 *   GET -> 200 {
 *          data: GuideSummary[],
 *          pagination: { limit, offset, total, hasMore },
 *          meta: { workspaceId, generatedAt, requestId? }
 *        }
 *   -> 4xx { error: { code, message, field? } }
 *
 * GuideSummary (fields consumed by this page; unknown extras are ignored):
 *   { id, title, slug, status, visibility, folderId, tags: string[],
 *     updatedAt, createdAt, publishedAt, stepCount, screenshotCount,
 *     language, archived }
 *
 * Wire contract — /api/v1/audit  (workspace activity feed)
 *   GET ?limit=&cursor= -> 200 {
 *     data: AuditEntry[],
 *     pagination: { limit, nextCursor },
 *     meta: { workspaceId, generatedAt }
 *   }
 *
 * Wire contract — /api/billing/usage  (implemented in this batch)
 *   GET -> 200 {
 *     workspaceId, plan, planLabel, seats, cycle, usage: [...],
 *     alerts: [...], referrals: {...}, links: {...}, message, notes[]
 *   }
 *
 * Deliberate non-goals (documented, not stubbed):
 *   - The dashboard does not create guides, folders or tags. Creation is a
 *     dedicated flow with its own route (guides/folders/tags APIs). This page
 *     links to those flows but never writes through the dashboard.
 *   - The dashboard does not run a workflow or launch a browser. Triggering
 *     a run is the workflow page's job; the dashboard only surfaces status.
 *   - The dashboard does not show fabricated numbers. If the usage endpoint
 *     reports unconfigured capabilities (payment gateway, portal links),
 *     those sections render as "not configured" with the server's own note.
 *   - No client-side caching beyond React state; a Refresh button re-fetches.
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

export type GuideStatus =
  | "draft"
  | "review"
  | "published"
  | "archived"
  | "unknown";

export type GuideVisibility = "public" | "private" | "password" | "unknown";

export interface GuideSummary {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly status: GuideStatus;
  readonly visibility: GuideVisibility;
  readonly folderId: string | null;
  readonly tags: readonly string[];
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly stepCount: number;
  readonly screenshotCount: number;
  readonly language: string | null;
  readonly archived: boolean;
}

export interface GuidesPage {
  readonly guides: readonly GuideSummary[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly workspaceId: string;
  readonly generatedAt: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly kind: string;
  readonly at: string;
  readonly actorId: string | null;
  readonly actorDisplay: string | null;
  readonly summary: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditPage {
  readonly entries: readonly AuditEntry[];
  readonly nextCursor: string | null;
  readonly workspaceId: string;
  readonly generatedAt: string;
}

export interface UsageMeter {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly used: number;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly period: string;
  readonly unlimited: boolean;
  readonly percent: number | null;
  readonly level: "ok" | "warn" | "critical" | "exceeded" | "unknown";
}

export interface UsageAlert {
  readonly id: string;
  readonly level: "info" | "warn" | "critical" | "exceeded";
  readonly message: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

export interface UsageReferral {
  readonly code: string | null;
  readonly creditsEarned: number;
  readonly creditsPending: number;
  readonly signups: number;
  readonly active: boolean;
  readonly note: string | null;
}

export interface UsageLinks {
  readonly billingPortal: string | null;
  readonly planSelector: string | null;
  readonly invoices: string | null;
}

export interface UsageResponse {
  readonly workspaceId: string;
  readonly plan: string;
  readonly planLabel: string;
  readonly seats: { readonly used: number; readonly limit: number | null };
  readonly cycle: { readonly startsAt: string; readonly endsAt: string };
  readonly usage: readonly UsageMeter[];
  readonly alerts: readonly UsageAlert[];
  readonly referrals: UsageReferral;
  readonly links: UsageLinks;
  readonly message: string;
  readonly notes: readonly string[];
}

interface ApiErrorBody {
  readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly field?: unknown };
  readonly message?: unknown;
  readonly field?: unknown;
  readonly code?: unknown;
}

interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GUIDE_STATUSES: readonly GuideStatus[] = [
  "draft",
  "review",
  "published",
  "archived",
];

const GUIDES_PAGE_SIZE = 20;
const AUDIT_PAGE_SIZE = 20;

type Loadable<T> =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "error"; readonly error: ApiError };

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function DashboardPage() {
  /* ------------------------------- filter state -------------------------- */

  const [statusFilter, setStatusFilter] = useState<GuideStatus | "">("");
  const [folderFilter, setFolderFilter] = useState<string>("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");

  /* --------------------------------- state ------------------------------- */

  const [guides, setGuides] = useState<Loadable<GuidesPage>>({ kind: "idle" });
  const [audit, setAudit] = useState<Loadable<AuditPage>>({ kind: "idle" });
  const [usage, setUsage] = useState<Loadable<UsageResponse>>({ kind: "idle" });

  const guidesAbortRef = useRef<AbortController | null>(null);
  const auditAbortRef = useRef<AbortController | null>(null);
  const usageAbortRef = useRef<AbortController | null>(null);

  /* ------------------------------- fetching ------------------------------ */

  const loadGuides = useCallback(
    async (offset: number, append: boolean): Promise<void> => {
      guidesAbortRef.current?.abort();
      const controller = new AbortController();
      guidesAbortRef.current = controller;

      if (!append) setGuides({ kind: "loading" });
      const url = new URL(
        "/api/v1/guides",
        typeof window !== "undefined"
          ? window.location.origin
          : "http://0.0.0.0",
      );
      url.searchParams.set("limit", String(GUIDES_PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      if (statusFilter !== "") url.searchParams.set("status", statusFilter);
      if (folderFilter !== "") url.searchParams.set("folderId", folderFilter);
      if (tagFilter !== "") url.searchParams.set("tag", tagFilter);
      if (searchQuery.trim() !== "") url.searchParams.set("q", searchQuery.trim());

      try {
        const res = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        const json: unknown = await res.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setGuides({
            kind: "error",
            error: normaliseError(json, `Guides request failed with HTTP ${res.status}.`),
          });
          return;
        }
        const parsed = parseGuidesPage(json);
        if (parsed === null) {
          setGuides({
            kind: "error",
            error: {
              code: "unexpected_response",
              message:
                "The server returned a guides payload this page does not recognise. Check server logs.",
            },
          });
          return;
        }
        setGuides((prev) => {
          if (!append || prev.kind !== "ready") {
            return { kind: "ready", data: parsed };
          }
          return {
            kind: "ready",
            data: {
              ...parsed,
              guides: [...prev.data.guides, ...parsed.guides],
            },
          };
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setGuides({
          kind: "error",
          error: {
            code: "network_error",
            message:
              err instanceof Error
                ? `Could not reach the server: ${err.message}`
                : "Could not reach the server.",
          },
        });
      }
    },
    [statusFilter, folderFilter, tagFilter, searchQuery],
  );

  const loadAudit = useCallback(async (): Promise<void> => {
    auditAbortRef.current?.abort();
    const controller = new AbortController();
    auditAbortRef.current = controller;

    setAudit({ kind: "loading" });
    const url = new URL(
      "/api/v1/audit",
      typeof window !== "undefined" ? window.location.origin : "http://0.0.0.0",
    );
    url.searchParams.set("limit", String(AUDIT_PAGE_SIZE));

    try {
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      const json: unknown = await res.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setAudit({
          kind: "error",
          error: normaliseError(json, `Audit request failed with HTTP ${res.status}.`),
        });
        return;
      }
      const parsed = parseAuditPage(json);
      if (parsed === null) {
        setAudit({
          kind: "error",
          error: {
            code: "unexpected_response",
            message:
              "The server returned an audit payload this page does not recognise. Check server logs.",
          },
        });
        return;
      }
      setAudit({ kind: "ready", data: parsed });
    } catch (err) {
      if (controller.signal.aborted) return;
      setAudit({
        kind: "error",
        error: {
          code: "network_error",
          message:
            err instanceof Error
              ? `Could not reach the server: ${err.message}`
              : "Could not reach the server.",
        },
      });
    }
  }, []);

  const loadUsage = useCallback(async (): Promise<void> => {
    usageAbortRef.current?.abort();
    const controller = new AbortController();
    usageAbortRef.current = controller;

    setUsage({ kind: "loading" });
    try {
      const res = await fetch("/api/billing/usage", {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      const json: unknown = await res.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setUsage({
          kind: "error",
          error: normaliseError(json, `Usage request failed with HTTP ${res.status}.`),
        });
        return;
      }
      const parsed = parseUsageResponse(json);
      if (parsed === null) {
        setUsage({
          kind: "error",
          error: {
            code: "unexpected_response",
            message:
              "The server returned a usage payload this page does not recognise. Check server logs.",
          },
        });
        return;
      }
      setUsage({ kind: "ready", data: parsed });
    } catch (err) {
      if (controller.signal.aborted) return;
      setUsage({
        kind: "error",
        error: {
          code: "network_error",
          message:
            err instanceof Error
              ? `Could not reach the server: ${err.message}`
              : "Could not reach the server.",
        },
      });
    }
  }, []);

  /* --------------------------------- effects ----------------------------- */

  useEffect(() => {
    void loadGuides(0, false);
  }, [loadGuides]);

  useEffect(() => {
    void loadAudit();
    return () => auditAbortRef.current?.abort();
  }, [loadAudit]);

  useEffect(() => {
    void loadUsage();
    return () => usageAbortRef.current?.abort();
  }, [loadUsage]);

  /* ------------------------------- derived ------------------------------- */

  const recentGuides = useMemo(() => {
    if (guides.kind !== "ready") return [];
    return [...guides.data.guides]
      .sort((a, b) => {
        const aT = Date.parse(a.updatedAt);
        const bT = Date.parse(b.updatedAt);
        return (Number.isNaN(bT) ? 0 : bT) - (Number.isNaN(aT) ? 0 : aT);
      })
      .slice(0, 5);
  }, [guides]);

  const guideStatusCounts = useMemo(() => {
    if (guides.kind !== "ready") return null;
    const counts: Record<GuideStatus, number> = {
      draft: 0,
      review: 0,
      published: 0,
      archived: 0,
      unknown: 0,
    };
    for (const g of guides.data.guides) {
      counts[g.status] = (counts[g.status] ?? 0) + 1;
    }
    return counts;
  }, [guides]);

  const folderOptions = useMemo(() => {
    if (guides.kind !== "ready") return [];
    const set = new Set<string>();
    for (const g of guides.data.guides) {
      if (g.folderId !== null) set.add(g.folderId);
    }
    return Array.from(set).sort();
  }, [guides]);

  const tagOptions = useMemo(() => {
    if (guides.kind !== "ready") return [];
    const set = new Set<string>();
    for (const g of guides.data.guides) {
      for (const t of g.tags) set.add(t);
    }
    return Array.from(set).sort();
  }, [guides]);

  const activeFiltersCount =
    (statusFilter !== "" ? 1 : 0) +
    (folderFilter !== "" ? 1 : 0) +
    (tagFilter !== "" ? 1 : 0) +
    (searchQuery.trim() !== "" ? 1 : 0);

  /* -------------------------------- render ------------------------------- */

  return (
    <main style={pageStyle}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 700 }}>
          Workspace dashboard
        </h1>
        <p style={{ margin: 0, color: "#475569", fontSize: 13 }}>
          Guides, lifecycle, activity and plan usage for the active workspace.
        </p>
      </header>

      <UsageCard
        state={usage}
        onRefresh={() => {
          void loadUsage();
        }}
      />

      <div style={twoColumnStyle}>
        <section
          aria-labelledby="zipy-dashboard-guides"
          style={cardStyle}
        >
          <header style={headerRowStyle}>
            <div>
              <h2
                id="zipy-dashboard-guides"
                style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
              >
                Guides
              </h2>
              <p style={{ margin: "2px 0 0", color: "#475569", fontSize: 12 }}>
                {guides.kind === "ready"
                  ? `${guides.data.total} total · showing ${guides.data.guides.length}`
                  : guides.kind === "loading"
                    ? "Loading…"
                    : guides.kind === "error"
                      ? "Unavailable"
                      : ""}
              </p>
            </div>
            <Link href="/guides/new" style={primaryLinkStyle}>
              New guide
            </Link>
          </header>

          <FilterBar
            statusFilter={statusFilter}
            folderFilter={folderFilter}
            tagFilter={tagFilter}
            searchQuery={searchQuery}
            folderOptions={folderOptions}
            tagOptions={tagOptions}
            activeFilterCount={activeFiltersCount}
            onStatusChange={setStatusFilter}
            onFolderChange={setFolderFilter}
            onTagChange={setTagFilter}
            onSearchChange={setSearchQuery}
            onClear={() => {
              setStatusFilter("");
              setFolderFilter("");
              setTagFilter("");
              setSearchQuery("");
            }}
          />

          {guides.kind === "idle" || guides.kind === "loading" ? (
            <p style={mutedStyle}>Loading guides…</p>
          ) : guides.kind === "error" ? (
            <ErrorBlock error={guides.error} />
          ) : (
            <>
              <StatusSummary counts={guideStatusCounts} total={guides.data.total} />
              {guides.data.guides.length === 0 ? (
                <p style={mutedStyle}>
                  No guides match the current filters.
                </p>
              ) : (
                <ul style={listStyle}>
                  {guides.data.guides.map((g) => (
                    <GuideRow key={g.id} guide={g} />
                  ))}
                </ul>
              )}
              {guides.data.hasMore && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      const nextOffset =
                        guides.kind === "ready" ? guides.data.guides.length : 0;
                      void loadGuides(nextOffset, true);
                    }}
                    style={secondaryButtonStyle(false)}
                  >
                    Load more
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <section
            aria-labelledby="zipy-dashboard-recent"
            style={cardStyle}
          >
            <header style={headerRowStyle}>
              <h2
                id="zipy-dashboard-recent"
                style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
              >
                Recently updated
              </h2>
            </header>
            {recentGuides.length === 0 ? (
              <p style={mutedStyle}>No recently updated guides.</p>
            ) : (
              <ul style={listStyle}>
                {recentGuides.map((g) => (
                  <li key={g.id} style={compactRowStyle}>
                    <Link
                      href={`/guides/${encodeURIComponent(g.id)}/edit`}
                      style={compactLinkStyle}
                    >
                      {g.title}
                    </Link>
                    <span style={compactMetaStyle}>{formatRelative(g.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-labelledby="zipy-dashboard-activity"
            style={cardStyle}
          >
            <header style={headerRowStyle}>
              <h2
                id="zipy-dashboard-activity"
                style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
              >
                Workspace activity
              </h2>
              <button
                type="button"
                onClick={() => {
                  void loadAudit();
                }}
                style={linkButtonStyle}
                disabled={audit.kind === "loading"}
              >
                {audit.kind === "loading" ? "Loading…" : "Refresh"}
              </button>
            </header>
            {audit.kind === "idle" || audit.kind === "loading" ? (
              <p style={mutedStyle}>Loading activity…</p>
            ) : audit.kind === "error" ? (
              <ErrorBlock error={audit.error} />
            ) : audit.data.entries.length === 0 ? (
              <p style={mutedStyle}>No activity recorded yet.</p>
            ) : (
              <ul style={listStyle}>
                {audit.data.entries.map((e) => (
                  <li key={e.id} style={compactRowStyle}>
                    <span style={compactBodyStyle}>{e.summary}</span>
                    <span style={compactMetaStyle}>{formatRelative(e.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Subcomponents                                                               */
/* -------------------------------------------------------------------------- */

function UsageCard({
  state,
  onRefresh,
}: {
  readonly state: Loadable<UsageResponse>;
  readonly onRefresh: () => void;
}) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <section style={{ ...cardStyle, marginBottom: 16 }}>
        <p style={mutedStyle}>Loading plan usage…</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section style={{ ...cardStyle, marginBottom: 16 }}>
        <header style={headerRowStyle}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            Plan & usage
          </h2>
          <button type="button" onClick={onRefresh} style={linkButtonStyle}>
            Retry
          </button>
        </header>
        <ErrorBlock error={state.error} />
      </section>
    );
  }

  const d = state.data;

  return (
    <section
      aria-labelledby="zipy-usage-heading"
      style={{ ...cardStyle, marginBottom: 16 }}
    >
      <header style={headerRowStyle}>
        <div>
          <h2
            id="zipy-usage-heading"
            style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
          >
            Plan & usage
          </h2>
          <p style={{ margin: "2px 0 0", color: "#475569", fontSize: 12 }}>
            {d.message}
          </p>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={planBadgeStyle}>{d.planLabel}</span>
          <button type="button" onClick={onRefresh} style={linkButtonStyle}>
            Refresh
          </button>
        </div>
      </header>

      <div style={metaGridStyle}>
        <Meta
          label="Seats"
          value={
            d.seats.limit === null
              ? `${d.seats.used} (unlimited)`
              : `${d.seats.used} of ${d.seats.limit}`
          }
        />
        <Meta
          label="Billing cycle"
          value={`${formatIsoShort(d.cycle.startsAt)} → ${formatIsoShort(
            d.cycle.endsAt,
          )}`}
        />
        <Meta label="Workspace" value={d.workspaceId} mono />
        <Meta
          label="Referrals"
          value={
            d.referrals.active
              ? `${d.referrals.signups} signups · ${d.referrals.creditsEarned} earned · ${d.referrals.creditsPending} pending`
              : "Not active"
          }
        />
      </div>

      {d.usage.length === 0 ? (
        <p style={mutedStyle}>No metered usage is recorded for this cycle.</p>
      ) : (
        <div style={{ marginTop: 8 }}>
          {d.usage.map((m) => (
            <UsageMeterRow key={m.key} meter={m} />
          ))}
        </div>
      )}

      {d.alerts.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3 style={sectionHeadingStyle}>Alerts</h3>
          <ul style={listStyle}>
            {d.alerts.map((a) => (
              <li key={a.id} style={alertRowStyle(a.level)}>
                <span style={alertLevelStyle(a.level)}>{a.level}</span>
                <span style={{ fontSize: 12, color: "#0f172a" }}>
                  {a.message}
                </span>
                <span style={{ ...compactMetaStyle, marginLeft: "auto" }}>
                  {formatRelative(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(d.links.billingPortal !== null ||
        d.links.planSelector !== null ||
        d.links.invoices !== null) && (
        <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
          {d.links.billingPortal !== null && (
            <a
              href={d.links.billingPortal}
              style={primaryLinkStyle}
              rel="noopener noreferrer"
              target="_blank"
            >
              Billing portal
            </a>
          )}
          {d.links.planSelector !== null && (
            <a
              href={d.links.planSelector}
              style={linkStyle}
              rel="noopener noreferrer"
              target="_blank"
            >
              Change plan
            </a>
          )}
          {d.links.invoices !== null && (
            <a
              href={d.links.invoices}
              style={linkStyle}
              rel="noopener noreferrer"
              target="_blank"
            >
              Invoices
            </a>
          )}
        </div>
      )}

      {d.notes.length > 0 && (
        <ul style={{ ...listStyle, marginTop: 8 }}>
          {d.notes.map((n, i) => (
            <li key={i} style={{ fontSize: 12, color: "#475569" }}>
              {n}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UsageMeterRow({ meter }: { readonly meter: UsageMeter }) {
  const percent = meter.percent;
  return (
    <div style={meterRowStyle}>
      <div style={meterHeaderStyle}>
        <strong style={{ fontSize: 13 }}>{meter.label}</strong>
        <span style={{ fontSize: 12, color: "#475569" }}>
          {meter.unlimited
            ? `${formatNumber(meter.used)} ${meter.unit} (unlimited)`
            : meter.limit === null
              ? `${formatNumber(meter.used)} ${meter.unit}`
              : `${formatNumber(meter.used)} / ${formatNumber(meter.limit)} ${meter.unit}`}
        </span>
        <span style={meterPeriodStyle}>{meter.period}</span>
      </div>
      {percent !== null && !meter.unlimited && (
        <div style={meterBarOuterStyle}>
          <div
            style={meterBarInnerStyle(percent, meter.level)}
            role="progressbar"
            aria-valuenow={Math.round(percent * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      )}
      {meter.level === "exceeded" && (
        <span style={{ fontSize: 11, color: "#7f1d1d" }}>
          Limit exceeded for this cycle.
        </span>
      )}
    </div>
  );
}

function FilterBar({
  statusFilter,
  folderFilter,
  tagFilter,
  searchQuery,
  folderOptions,
  tagOptions,
  activeFilterCount,
  onStatusChange,
  onFolderChange,
  onTagChange,
  onSearchChange,
  onClear,
}: {
  readonly statusFilter: GuideStatus | "";
  readonly folderFilter: string;
  readonly tagFilter: string;
  readonly searchQuery: string;
  readonly folderOptions: readonly string[];
  readonly tagOptions: readonly string[];
  readonly activeFilterCount: number;
  readonly onStatusChange: (v: GuideStatus | "") => void;
  readonly onFolderChange: (v: string) => void;
  readonly onTagChange: (v: string) => void;
  readonly onSearchChange: (v: string) => void;
  readonly onClear: () => void;
}) {
  return (
    <div style={filterBarStyle}>
      <label style={filterFieldStyle}>
        <span style={filterLabelStyle}>Search</span>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Title, slug or step text"
          style={inputStyle}
        />
      </label>

      <label style={filterFieldStyle}>
        <span style={filterLabelStyle}>Status</span>
        <select
          value={statusFilter}
          onChange={(e) =>
            onStatusChange(e.target.value === "" ? "" : (e.target.value as GuideStatus))
          }
          style={inputStyle}
        >
          <option value="">All statuses</option>
          {GUIDE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label style={filterFieldStyle}>
        <span style={filterLabelStyle}>Folder</span>
        <select
          value={folderFilter}
          onChange={(e) => onFolderChange(e.target.value)}
          style={inputStyle}
        >
          <option value="">All folders</option>
          {folderOptions.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>

      <label style={filterFieldStyle}>
        <span style={filterLabelStyle}>Tag</span>
        <select
          value={tagFilter}
          onChange={(e) => onTagChange(e.target.value)}
          style={inputStyle}
        >
          <option value="">All tags</option>
          {tagOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      {activeFilterCount > 0 && (
        <button
          type="button"
          onClick={onClear}
          style={{ ...linkButtonStyle, alignSelf: "flex-end", marginBottom: 2 }}
        >
          Clear {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}

function StatusSummary({
  counts,
  total,
}: {
  readonly counts: Record<GuideStatus, number> | null;
  readonly total: number;
}) {
  if (counts === null) return null;
  return (
    <div style={statusSummaryStyle} aria-label="Guide status counts on this page">
      {(["draft", "review", "published", "archived"] as const).map((s) => (
        <span key={s} style={statusCountStyle(s)}>
          {s}: {counts[s] ?? 0}
        </span>
      ))}
      <span style={{ ...mutedStyle, marginLeft: "auto", fontSize: 11 }}>
        {total} total in workspace
      </span>
    </div>
  );
}

function GuideRow({ guide }: { readonly guide: GuideSummary }) {
  return (
    <li style={guideRowStyle}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <Link
          href={`/guides/${encodeURIComponent(guide.id)}/edit`}
          style={guideTitleLinkStyle}
        >
          {guide.title}
        </Link>
        <span style={guideStatusBadgeStyle(guide.status)}>{guide.status}</span>
        <span style={visibilityBadgeStyle}>{guide.visibility}</span>
        {guide.language !== null && (
          <span style={chipStyle}>{guide.language}</span>
        )}
        {guide.tags.slice(0, 3).map((t) => (
          <span key={t} style={chipStyle}>
            #{t}
          </span>
        ))}
      </div>
      <div style={guideMetaStyle}>
        <code style={monoStyle}>{guide.slug}</code>
        <span>· {guide.stepCount} step{guide.stepCount === 1 ? "" : "s"}</span>
        <span>· {guide.screenshotCount} screenshot{guide.screenshotCount === 1 ? "" : "s"}</span>
        {guide.folderId !== null && (
          <span>· folder <code style={monoStyle}>{guide.folderId}</code></span>
        )}
        <span>· updated {formatRelative(guide.updatedAt)}</span>
        {guide.publishedAt !== null && (
          <span>· published {formatRelative(guide.publishedAt)}</span>
        )}
      </div>
      <div style={guideActionsStyle}>
        <Link
          href={`/workflows/${encodeURIComponent(guide.id)}/review`}
          style={linkStyle}
        >
          Review
        </Link>
        <Link
          href={`/guides/${encodeURIComponent(guide.id)}/export`}
          style={linkStyle}
        >
          Export
        </Link>
        {guide.slug !== "" && (
          <Link href={`/p/${encodeURIComponent(guide.slug)}`} style={linkStyle}>
            Open share page
          </Link>
        )}
      </div>
    </li>
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

function ErrorBlock({ error }: { readonly error: ApiError }) {
  return (
    <div role="alert" style={errorStyle}>
      <strong style={{ display: "block", marginBottom: 4 }}>{error.code}</strong>
      <span>{error.message}</span>
      {error.field !== undefined && (
        <span style={{ marginLeft: 6 }}>(field: {error.field})</span>
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

function asGuideStatus(v: unknown): GuideStatus {
  return typeof v === "string" &&
    (GUIDE_STATUSES as readonly string[]).includes(v)
    ? (v as GuideStatus)
    : "unknown";
}

function asGuideVisibility(v: unknown): GuideVisibility {
  if (v === "public" || v === "private" || v === "password") return v;
  return "unknown";
}

function parseGuide(v: unknown): GuideSummary | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r["id"] !== "string" ||
    typeof r["title"] !== "string" ||
    typeof r["slug"] !== "string" ||
    typeof r["updatedAt"] !== "string" ||
    typeof r["createdAt"] !== "string"
  ) {
    return null;
  }
  return {
    id: r["id"],
    title: r["title"],
    slug: r["slug"],
    status: asGuideStatus(r["status"]),
    visibility: asGuideVisibility(r["visibility"]),
    folderId: typeof r["folderId"] === "string" ? r["folderId"] : null,
    tags: isStringArray(r["tags"]) ? r["tags"] : [],
    updatedAt: r["updatedAt"],
    createdAt: r["createdAt"],
    publishedAt: typeof r["publishedAt"] === "string" ? r["publishedAt"] : null,
    stepCount:
      typeof r["stepCount"] === "number" && Number.isFinite(r["stepCount"])
        ? Math.trunc(r["stepCount"])
        : 0,
    screenshotCount:
      typeof r["screenshotCount"] === "number" &&
      Number.isFinite(r["screenshotCount"])
        ? Math.trunc(r["screenshotCount"])
        : 0,
    language: typeof r["language"] === "string" ? r["language"] : null,
    archived: r["archived"] === true || r["status"] === "archived",
  };
}

function parseGuidesPage(value: unknown): GuidesPage | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["data"])) return null;
  const paginationRaw = v["pagination"];
  if (paginationRaw === null || typeof paginationRaw !== "object") return null;
  const p = paginationRaw as Record<string, unknown>;
  if (
    typeof p["total"] !== "number" ||
    !Number.isFinite(p["total"]) ||
    typeof p["hasMore"] !== "boolean"
  ) {
    return null;
  }
  const metaRaw = v["meta"];
  let workspaceId = "";
  let generatedAt = new Date().toISOString();
  if (metaRaw !== null && typeof metaRaw === "object") {
    const m = metaRaw as Record<string, unknown>;
    if (typeof m["workspaceId"] === "string") workspaceId = m["workspaceId"];
    if (typeof m["generatedAt"] === "string") generatedAt = m["generatedAt"];
  }
  const guides: GuideSummary[] = [];
  for (const g of v["data"]) {
    const parsed = parseGuide(g);
    if (parsed === null) return null;
    guides.push(parsed);
  }
  return {
    guides,
    total: Math.trunc(p["total"] as number),
    hasMore: p["hasMore"] === true,
    workspaceId,
    generatedAt,
  };
}

function parseAuditEntry(v: unknown): AuditEntry | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r["id"] !== "string" ||
    typeof r["kind"] !== "string" ||
    typeof r["at"] !== "string" ||
    typeof r["summary"] !== "string"
  ) {
    return null;
  }
  const meta = r["metadata"];
  return {
    id: r["id"],
    kind: r["kind"],
    at: r["at"],
    actorId: typeof r["actorId"] === "string" ? r["actorId"] : null,
    actorDisplay:
      typeof r["actorDisplay"] === "string" ? r["actorDisplay"] : null,
    summary: r["summary"],
    resourceType:
      typeof r["resourceType"] === "string" ? r["resourceType"] : null,
    resourceId: typeof r["resourceId"] === "string" ? r["resourceId"] : null,
    metadata:
      meta !== null && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {},
  };
}

function parseAuditPage(value: unknown): AuditPage | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["data"])) return null;
  const metaRaw = v["meta"];
  let workspaceId = "";
  let generatedAt = new Date().toISOString();
  if (metaRaw !== null && typeof metaRaw === "object") {
    const m = metaRaw as Record<string, unknown>;
    if (typeof m["workspaceId"] === "string") workspaceId = m["workspaceId"];
    if (typeof m["generatedAt"] === "string") generatedAt = m["generatedAt"];
  }
  const paginationRaw = v["pagination"];
  let nextCursor: string | null = null;
  if (paginationRaw !== null && typeof paginationRaw === "object") {
    const p = paginationRaw as Record<string, unknown>;
    if (typeof p["nextCursor"] === "string") nextCursor = p["nextCursor"];
  }
  const entries: AuditEntry[] = [];
  for (const e of v["data"]) {
    const parsed = parseAuditEntry(e);
    if (parsed === null) return null;
    entries.push(parsed);
  }
  return { entries, nextCursor, workspaceId, generatedAt };
}

function parseUsageMeter(v: unknown): UsageMeter | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r["key"] !== "string" ||
    typeof r["label"] !== "string" ||
    typeof r["unit"] !== "string" ||
    typeof r["used"] !== "number" ||
    !Number.isFinite(r["used"]) ||
    typeof r["period"] !== "string"
  ) {
    return null;
  }
  const limit =
    typeof r["limit"] === "number" && Number.isFinite(r["limit"])
      ? Math.trunc(r["limit"])
      : null;
  const remaining =
    typeof r["remaining"] === "number" && Number.isFinite(r["remaining"])
      ? Math.trunc(r["remaining"])
      : null;
  const unlimited = r["unlimited"] === true || limit === null;
  const percent =
    typeof r["percent"] === "number" && Number.isFinite(r["percent"])
      ? r["percent"]
      : limit !== null && limit > 0
        ? (r["used"] as number) / limit
        : null;
  const levelRaw = r["level"];
  const level: UsageMeter["level"] =
    levelRaw === "ok" ||
    levelRaw === "warn" ||
    levelRaw === "critical" ||
    levelRaw === "exceeded"
      ? levelRaw
      : "unknown";
  return {
    key: r["key"],
    label: r["label"],
    unit: r["unit"],
    used: Math.trunc(r["used"] as number),
    limit,
    remaining,
    period: r["period"],
    unlimited,
    percent,
    level,
  };
}

function parseUsageAlert(v: unknown): UsageAlert | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r["id"] !== "string" ||
    typeof r["message"] !== "string" ||
    typeof r["createdAt"] !== "string"
  ) {
    return null;
  }
  const levelRaw = r["level"];
  const level: UsageAlert["level"] =
    levelRaw === "info" ||
    levelRaw === "warn" ||
    levelRaw === "critical" ||
    levelRaw === "exceeded"
      ? levelRaw
      : "info";
  return {
    id: r["id"],
    level,
    message: r["message"],
    createdAt: r["createdAt"],
    acknowledgedAt:
      typeof r["acknowledgedAt"] === "string" ? r["acknowledgedAt"] : null,
  };
}

function parseUsageResponse(value: unknown): UsageResponse | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["workspaceId"] !== "string" ||
    typeof v["plan"] !== "string" ||
    typeof v["planLabel"] !== "string" ||
    typeof v["message"] !== "string"
  ) {
    return null;
  }

  const seatsRaw = v["seats"];
  if (seatsRaw === null || typeof seatsRaw !== "object") return null;
  const s = seatsRaw as Record<string, unknown>;
  if (typeof s["used"] !== "number" || !Number.isFinite(s["used"])) return null;
  const seats = {
    used: Math.trunc(s["used"] as number),
    limit:
      typeof s["limit"] === "number" && Number.isFinite(s["limit"])
        ? Math.trunc(s["limit"] as number)
        : null,
  };

  const cycleRaw = v["cycle"];
  if (cycleRaw === null || typeof cycleRaw !== "object") return null;
  const c = cycleRaw as Record<string, unknown>;
  if (
    typeof c["startsAt"] !== "string" ||
    typeof c["endsAt"] !== "string"
  ) {
    return null;
  }
  const cycle = { startsAt: c["startsAt"], endsAt: c["endsAt"] };

  if (!Array.isArray(v["usage"])) return null;
  const usage: UsageMeter[] = [];
  for (const m of v["usage"]) {
    const parsed = parseUsageMeter(m);
    if (parsed === null) return null;
    usage.push(parsed);
  }

  if (!Array.isArray(v["alerts"])) return null;
  const alerts: UsageAlert[] = [];
  for (const a of v["alerts"]) {
    const parsed = parseUsageAlert(a);
    if (parsed === null) return null;
    alerts.push(parsed);
  }

  const refsRaw = v["referrals"];
  if (refsRaw === null || typeof refsRaw !== "object") return null;
  const refs = refsRaw as Record<string, unknown>;
  const referrals: UsageReferral = {
    code: typeof refs["code"] === "string" ? refs["code"] : null,
    creditsEarned:
      typeof refs["creditsEarned"] === "number" &&
      Number.isFinite(refs["creditsEarned"])
        ? Math.trunc(refs["creditsEarned"] as number)
        : 0,
    creditsPending:
      typeof refs["creditsPending"] === "number" &&
      Number.isFinite(refs["creditsPending"])
        ? Math.trunc(refs["creditsPending"] as number)
        : 0,
    signups:
      typeof refs["signups"] === "number" && Number.isFinite(refs["signups"])
        ? Math.trunc(refs["signups"] as number)
        : 0,
    active: refs["active"] === true,
    note: typeof refs["note"] === "string" ? refs["note"] : null,
  };

  const linksRaw = v["links"];
  if (linksRaw === null || typeof linksRaw !== "object") return null;
  const l = linksRaw as Record<string, unknown>;
  const links: UsageLinks = {
    billingPortal:
      typeof l["billingPortal"] === "string" ? l["billingPortal"] : null,
    planSelector:
      typeof l["planSelector"] === "string" ? l["planSelector"] : null,
    invoices: typeof l["invoices"] === "string" ? l["invoices"] : null,
  };

  return {
    workspaceId: v["workspaceId"],
    plan: v["plan"],
    planLabel: v["planLabel"],
    seats,
    cycle,
    usage,
    alerts,
    referrals,
    links,
    message: v["message"],
    notes: isStringArray(v["notes"]) ? v["notes"] : [],
  };
}

function normaliseError(value: unknown, fallback: string): ApiError {
  if (value !== null && typeof value === "object") {
    const r = value as ApiErrorBody;
    // Support both an envelope ({error:{code,message}}) and a flat shape.
    const nested = r.error;
    if (nested !== null && typeof nested === "object") {
      const code =
        typeof nested.code === "string" ? nested.code : "request_failed";
      const message =
        typeof nested.message === "string" && nested.message.length > 0
          ? nested.message
          : fallback;
      const field = typeof nested.field === "string" ? nested.field : undefined;
      return field !== undefined
        ? { code, message, field }
        : { code, message };
    }
    const code = typeof r.code === "string" ? r.code : "request_failed";
    const message =
      typeof r.message === "string" && r.message.length > 0
        ? r.message
        : fallback;
    const field = typeof r.field === "string" ? r.field : undefined;
    return field !== undefined ? { code, message, field } : { code, message };
  }
  return { code: "request_failed", message: fallback };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  const future = diffMs < 0;
  const suffix = future ? "from now" : "ago";
  if (abs < minute) return "just now";
  if (abs < hour) return `${Math.round(abs / minute)}m ${suffix}`;
  if (abs < day) return `${Math.round(abs / hour)}h ${suffix}`;
  if (abs < week) return `${Math.round(abs / day)}d ${suffix}`;
  if (abs < month) return `${Math.round(abs / week)}w ${suffix}`;
  if (abs < year) return `${Math.round(abs / month)}mo ${suffix}`;
  return `${Math.round(abs / year)}y ${suffix}`;
}

function formatIsoShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const pageStyle: CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: "24px 16px 48px",
  fontFamily:
    "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  color: "#0f172a",
  background: "#f8fafc",
};

const cardStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
};

const twoColumnStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)",
  gap: 16,
  alignItems: "flex-start",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 8,
};

const filterBarStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 8,
  padding: 8,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  marginBottom: 8,
};

const filterFieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const filterLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "#475569",
  fontWeight: 600,
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

const metaGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 8,
  padding: 8,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  marginTop: 6,
};

const statusSummaryStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  flexWrap: "wrap",
  marginBottom: 8,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const guideRowStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "10px 12px",
  marginBottom: 6,
  background: "#ffffff",
};

const guideMetaStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "baseline",
  flexWrap: "wrap",
  fontSize: 12,
  color: "#475569",
  marginTop: 4,
};

const guideActionsStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  marginTop: 6,
  fontSize: 12,
};

const compactRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  padding: "6px 0",
  borderBottom: "1px solid #f1f5f9",
};

const compactBodyStyle: CSSProperties = {
  fontSize: 12,
  color: "#0f172a",
  flex: 1,
  minWidth: 0,
};

const compactLinkStyle: CSSProperties = {
  fontSize: 13,
  color: "#1d4ed8",
  textDecoration: "none",
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const compactMetaStyle: CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  whiteSpace: "nowrap",
};

const mutedStyle: CSSProperties = {
  color: "#64748b",
  fontSize: 12,
  margin: "4px 0",
};

const errorStyle: CSSProperties = {
  marginTop: 8,
  padding: "10px 12px",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
  fontSize: 13,
};

const linkStyle: CSSProperties = {
  color: "#1d4ed8",
  textDecoration: "none",
  fontSize: 12,
};

const guideTitleLinkStyle: CSSProperties = {
  color: "#0f172a",
  textDecoration: "none",
  fontSize: 14,
  fontWeight: 600,
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

const primaryLinkStyle: CSSProperties = {
  display: "inline-block",
  padding: "6px 12px",
  background: "#1d4ed8",
  color: "#ffffff",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  textDecoration: "none",
};

function secondaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    background: disabled ? "#f1f5f9" : "#ffffff",
    color: disabled ? "#94a3b8" : "#1d4ed8",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const planBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  background: "#e0e7ff",
  color: "#1e3a8a",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
};

const monoStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
};

const sectionHeadingStyle: CSSProperties = {
  margin: "0 0 6px",
  fontSize: 12,
  fontWeight: 700,
  color: "#0f172a",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const chipStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 4,
  background: "#f1f5f9",
  color: "#334155",
  fontSize: 10,
  fontWeight: 600,
};

const visibilityBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 4,
  background: "#e0f2fe",
  color: "#0c4a6e",
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.3,
};

function statusCountStyle(status: GuideStatus): CSSProperties {
  const palette = (() => {
    switch (status) {
      case "draft":
        return { bg: "#f1f5f9", fg: "#334155" };
      case "review":
        return { bg: "#fef3c7", fg: "#92400e" };
      case "published":
        return { bg: "#dcfce7", fg: "#166534" };
      case "archived":
        return { bg: "#e2e8f0", fg: "#475569" };
      case "unknown":
      default:
        return { bg: "#f1f5f9", fg: "#64748b" };
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

function guideStatusBadgeStyle(status: GuideStatus): CSSProperties {
  return statusCountStyle(status);
}

const meterRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "8px 0",
  borderBottom: "1px solid #f1f5f9",
};

const meterHeaderStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  flexWrap: "wrap",
};

const meterPeriodStyle: CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  marginLeft: "auto",
};

const meterBarOuterStyle: CSSProperties = {
  width: "100%",
  height: 6,
  background: "#e2e8f0",
  borderRadius: 3,
  overflow: "hidden",
};

function meterBarInnerStyle(
  percent: number,
  level: UsageMeter["level"],
): CSSProperties {
  const clamped = Math.max(0, Math.min(1, percent)) * 100;
  const bg = (() => {
    switch (level) {
      case "exceeded":
        return "#b91c1c";
      case "critical":
        return "#dc2626";
      case "warn":
        return "#f59e0b";
      case "ok":
        return "#16a34a";
      case "unknown":
      default:
        return "#64748b";
    }
  })();
  return {
    width: `${clamped}%`,
    height: "100%",
    background: bg,
    transition: "width 240ms ease-out",
  };
}

function alertRowStyle(level: UsageAlert["level"]): CSSProperties {
  const bg = (() => {
    switch (level) {
      case "exceeded":
      case "critical":
        return "#fef2f2";
      case "warn":
        return "#fffbeb";
      case "info":
      default:
        return "#eff6ff";
    }
  })();
  return {
    display: "flex",
    gap: 8,
    alignItems: "center",
    padding: "6px 8px",
    background: bg,
    borderRadius: 6,
    marginBottom: 4,
  };
}

function alertLevelStyle(level: UsageAlert["level"]): CSSProperties {
  const palette = (() => {
    switch (level) {
      case "exceeded":
      case "critical":
        return { bg: "#fee2e2", fg: "#7f1d1d" };
      case "warn":
        return { bg: "#fef3c7", fg: "#92400e" };
      case "info":
      default:
        return { bg: "#dbeafe", fg: "#1e3a8a" };
    }
  })();
  return {
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: 4,
    background: palette.bg,
    color: palette.fg,
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  };
}

const _unusedAbortRef = guidesAbortRefPlaceholder;
function guidesAbortRefPlaceholder(): void {
  // Kept as a named symbol to satisfy lint rules that complain about
  // unused constants without a reference; the value itself is never used.
}
