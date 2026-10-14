/**
 * GET /p/[slug] — public guide view (phase 20, batch 2).
 *
 * Renders a shared guide as a static, image-only HTML page. This is the
 * surface the embed widget, shareable links, and custom-domain hosting all
 * end up pointing at.
 *
 * Slug resolution:
 *   The `[slug]` segment is resolved against a public-guide record in the
 *   object store. The record is written by the publishing phase (batch 3)
 *   and by the workspace admin when a guide is published. A missing or
 *   unconfigured record produces an explicit 404 page rather than a
 *   silent empty guide.
 *
 * Access control:
 *   Public guides are readable by anyone. Password-protected guides are
 *   gated by an access check performed by the publishing access module
 *   (`@zipy/publishing/access`) — that module is a batch 3 deliverable. Until
 *   it lands, this page treats every published guide as public-only and
 *   refuses to render a `private` or `password` guide rather than
 *   silently leaking it.
 *
 * Content source:
 *   The rendered content is the guide's current draft — the same document
 *   the export route reads. This page does not re-run the content pipeline
 *   and does not perform OCR/vision work.
 *
 * Non-goals (documented, not stubbed):
 *   - Custom-domain host detection. The batch 3 `@zipy/publishing/domains`
 *     module owns that mapping; until it lands this page uses the request's
 *     Host header as informational only and does not change its behaviour
 *     based on it.
 *   - Comments/activity feed. Those require the workspace-scoped review
 *     API and are not part of this page's rendering contract.
 *
 * Robustness:
 *   - A draft that does not carry a `sections` array renders an empty
 *     state rather than a crash.
 *   - Every image falls back to a plain alt-text placeholder when the
 *     underlying object is missing.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { forWorkspace } from "@zipy/storage/objectStore";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

type PublicGuideRecord = {
  readonly slug?: unknown;
  readonly guideId?: unknown;
  readonly workspaceId?: unknown;
  readonly title?: unknown;
  readonly access?: unknown;
  readonly publishedAt?: unknown;
  readonly passwordHash?: unknown;
};

type Access = "public" | "private" | "password";

interface GuideStep {
  readonly index: number;
  readonly title: string;
  readonly description: string;
  readonly imageRef: string | null;
  readonly altText: string | null;
}

interface GuidePageModel {
  readonly slug: string;
  readonly guideId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly introduction: string | null;
  readonly prerequisites: readonly string[];
  readonly steps: readonly GuideStep[];
  readonly tips: readonly string[];
  readonly warnings: readonly string[];
  readonly aiGenerated: boolean;
  readonly publishedAt: string | null;
}

type LoadResult =
  | { readonly kind: "rendered"; readonly model: GuidePageModel }
  | { readonly kind: "not_found" }
  | { readonly kind: "restricted"; readonly access: Access }
  | { readonly kind: "storage_error"; readonly message: string };

/* -------------------------------------------------------------------------- */
/* Data loading                                                                */
/* -------------------------------------------------------------------------- */

const PUBLIC_GUIDES_PREFIX = "public-guides";

function slugKey(slug: string): string {
  return `${PUBLIC_GUIDES_PREFIX}/${slug}.json`;
}

function guideDraftKey(guidId: string): string {
  return `guides/${guidId}/draft-current.json`;
}

function readAccess(raw: unknown): Access {
  if (raw === "private") return "private";
  if (raw === "password") return "password";
  return "public";
}

async function loadGuide(slug: string): Promise<LoadResult> {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 128) {
    return { kind: "not_found" };
  }
  // Slugs are lowercase alphanumeric with dashes; a slug that does not
  // match is a 404 rather than an object-store lookup, so we do not accept
  // arbitrary user input as a storage key.
  if (!/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/.test(slug) && !/^[a-z0-9]{1,128}$/.test(slug)) {
    return { kind: "not_found" };
  }

  // The public-guide registry lives at the *root* of the object store, not
  // inside any workspace scope: it is what maps a public slug to a
  // workspace. We therefore open the root scope to read it. The scope is
  // the same store the workspace helper returns but with no workspace
  // prefix, which the storage abstraction allows.
  let rootStore: { readonly get: (key: string) => Promise<Buffer | null> };
  try {
    rootStore = (await forWorkspace("__public__")) as unknown as {
      readonly get: (key: string) => Promise<Buffer | null>;
    };
  } catch (error) {
    return {
      kind: "storage_error",
      message:
        error instanceof Error
          ? error.message
          : "The object store is not available.",
    };
  }

  let registryBytes: Buffer | null;
  try {
    registryBytes = await rootStore.get(slugKey(slug));
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(m)) return { kind: "not_found" };
    return { kind: "storage_error", message: m };
  }
  if (registryBytes === null) return { kind: "not_found" };

  let record: PublicGuideRecord;
  try {
    record = JSON.parse(registryBytes.toString("utf8")) as PublicGuideRecord;
  } catch {
    return {
      kind: "storage_error",
      message: `Public-guide registry entry for "${slug}" is not valid JSON.`,
    };
  }

  const guideId = typeof record.guideId === "string" ? record.guideId : null;
  const workspaceId =
    typeof record.workspaceId === "string" ? record.workspaceId : null;
  if (guideId === null || workspaceId === null) {
    return {
      kind: "storage_error",
      message: `Public-guide registry entry for "${slug}" is missing guideId or workspaceId.`,
    };
  }

  const access = readAccess(record.access);
  if (access !== "public") {
    // The publishing access module (@zipy/publishing/access, batch 3) will
    // handle password and per-tenant access. Until that lands we refuse to
    // render non-public content rather than leak it.
    return { kind: "restricted", access };
  }

  let store: { readonly get: (key: string) => Promise<Buffer | null> };
  try {
    store = (await forWorkspace(workspaceId)) as unknown as {
      readonly get: (key: string) => Promise<Buffer | null>;
    };
  } catch (error) {
    return {
      kind: "storage_error",
      message:
        error instanceof Error
          ? error.message
          : "The object store is not available.",
    };
  }

  let draftBytes: Buffer | null;
  try {
    draftBytes = await store.get(guideDraftKey(guideId));
  } catch (error) {
    const m = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(m)) return { kind: "not_found" };
    return { kind: "storage_error", message: m };
  }
  if (draftBytes === null) return { kind: "not_found" };

  let draft: Readonly<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(draftBytes.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        kind: "storage_error",
        message: "The published guide draft is not a JSON object.",
      };
    }
    draft = parsed as Readonly<Record<string, unknown>>;
  } catch {
    return {
      kind: "storage_error",
      message: "The published guide draft is not valid JSON.",
    };
  }

  const title =
    typeof draft["title"] === "string" && draft["title"].length > 0
      ? (draft["title"] as string)
      : typeof record.title === "string" && record.title.length > 0
        ? (record.title as string)
        : "Untitled guide";

  const summary =
    typeof draft["summary"] === "string" && draft["summary"].length > 0
      ? (draft["summary"] as string)
      : null;
  const introduction =
    typeof draft["introduction"] === "string" &&
    draft["introduction"].length > 0
      ? (draft["introduction"] as string)
      : null;

  const prerequisites = parseStringList(draft["prerequisites"]);
  const tips = parseStringList(draft["tips"]);
  const warnings = parseStringList(draft["warnings"]);
  const steps = parseSteps(draft["steps"]);
  const aiGenerated = draft["aiGenerated"] === true;
  const publishedAt =
    typeof record.publishedAt === "string" && record.publishedAt.length > 0
      ? record.publishedAt
      : null;

  const model: GuidePageModel = {
    slug,
    guideId,
    title,
    summary,
    introduction,
    prerequisites,
    steps,
    tips,
    warnings,
    aiGenerated,
    publishedAt,
  };
  return { kind: "rendered", model };
}

function parseStringList(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") return raw.trim().length === 0 ? [] : [raw.trim()];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push(item.trim());
      continue;
    }
    if (item !== null && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const text =
        typeof o["text"] === "string"
          ? o["text"]
          : typeof o["description"] === "string"
            ? o["description"]
            : typeof o["title"] === "string"
              ? o["title"]
              : null;
      if (text !== null && text.trim().length > 0) out.push(text.trim());
    }
  }
  return out;
}

function parseSteps(raw: unknown): readonly GuideStep[] {
  if (!Array.isArray(raw)) return [];
  const out: GuideStep[] = [];
  let auto = 1;
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const title =
      typeof e["title"] === "string" && e["title"].length > 0
        ? e["title"]
        : `Step ${auto}`;
    const description =
      typeof e["description"] === "string" ? e["description"] : "";
    const imageRef =
      typeof e["screenshotRef"] === "string"
        ? e["screenshotRef"]
        : typeof e["imageRef"] === "string"
          ? e["imageRef"]
          : null;
    const altText = typeof e["altText"] === "string" ? e["altText"] : null;
    const idxRaw = e["index"];
    const index =
      typeof idxRaw === "number" && Number.isFinite(idxRaw)
        ? Math.trunc(idxRaw)
        : auto;
    out.push({ index, title, description, imageRef, altText });
    auto += 1;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Image URL builder                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Step screenshots live in the workspace-scoped object store. This page has
 * no public image CDN; the URL it emits points at the shared artefacts
 * endpoint that the artifacts phase exposes. When that endpoint is not
 * reachable, the `<img>` element falls back to the alt text rendered below
 * it — this page does not silently show a broken image.
 */
function imageUrlFor(guideId: string, imageRef: string | null): string | null {
  if (imageRef === null || imageRef.length === 0) return null;
  const encoded = encodeURIComponent(imageRef);
  return `/api/guides/${encodeURIComponent(guideId)}/images/${encoded}`;
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                    */
/* -------------------------------------------------------------------------- */

export async function generateMetadata({
  params,
}: {
  readonly params: { readonly slug: string };
}): Promise<Metadata> {
  const result = await loadGuide(params.slug);
  if (result.kind !== "rendered") {
    return { title: "Guide not found" };
  }
  return {
    title: result.model.title,
    description:
      result.model.summary ??
      `Image-only tutorial generated by Zipy AI: ${result.model.title}.`,
    robots: { index: true, follow: true },
  };
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default async function PublicGuidePage({
  params,
}: {
  readonly params: { readonly slug: string };
}) {
  const result = await loadGuide(params.slug);

  if (result.kind === "not_found") {
    return (
      <main style={pageStyle}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>Guide not found</h1>
        <p style={{ color: "#475569", fontSize: 14 }}>
          No published guide exists at <code style={monoStyle}>{params.slug}</code>.
        </p>
      </main>
    );
  }

  if (result.kind === "restricted") {
    return (
      <main style={pageStyle}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>
          This guide is not publicly accessible
        </h1>
        <p style={{ color: "#475569", fontSize: 14 }}>
          The published guide at <code style={monoStyle}>{params.slug}</code> is
          configured as <strong>{result.access}</strong>. Password and per-tenant
          access are handled by the publishing access module
          (<code style={monoStyle}>@zipy/publishing/access</code>), which has not
          been enabled on this deployment. Ask the guide's owner for an
          authenticated share link.
        </p>
      </main>
    );
  }

  if (result.kind === "storage_error") {
    return (
      <main style={pageStyle}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>
          Guide cannot be loaded
        </h1>
        <p style={{ color: "#475569", fontSize: 14 }}>{result.message}</p>
        <p style={{ color: "#64748b", fontSize: 12, marginTop: 12 }}>
          The public guide registry is served from the platform object store.
          If the store is unavailable, retry once the deployment recovers.
        </p>
      </main>
    );
  }

  const { model } = result;

  return (
    <main style={pageStyle}>
      <article>
        <header style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 28, margin: "0 0 6px", fontWeight: 700 }}>
            {model.title}
          </h1>
          {model.summary !== null && (
            <p style={{ margin: "0 0 6px", color: "#334155", fontSize: 15 }}>
              {model.summary}
            </p>
          )}
          {model.publishedAt !== null && (
            <p style={{ margin: 0, color: "#64748b", fontSize: 12 }}>
              Published {formatIso(model.publishedAt)}
            </p>
          )}
          <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 12 }}>
            <Link
              href={`/api/guides/${encodeURIComponent(model.guideId)}/export?format=pdf`}
              style={{ color: "#1d4ed8", textDecoration: "none" }}
            >
              Download as PDF
            </Link>
            {" · "}
            <Link
              href={`/api/guides/${encodeURIComponent(model.guideId)}/export?format=markdown`}
              style={{ color: "#1d4ed8", textDecoration: "none" }}
            >
              Markdown
            </Link>
          </p>
        </header>

        {model.introduction !== null && (
          <section style={{ marginBottom: 20 }}>
            <h2 style={sectionHeadingStyle}>Introduction</h2>
            <p style={paragraphStyle}>{model.introduction}</p>
          </section>
        )}

        {model.prerequisites.length > 0 && (
          <section style={{ marginBottom: 20 }}>
            <h2 style={sectionHeadingStyle}>Prerequisites</h2>
            <ul style={listStyle}>
              {model.prerequisites.map((p, i) => (
                <li key={i} style={listItemStyle}>
                  {p}
                </li>
              ))}
            </ul>
          </section>
        )}

        {model.steps.length > 0 && (
          <section style={{ marginBottom: 20 }}>
            <h2 style={sectionHeadingStyle}>Steps</h2>
            <ol style={stepListStyle}>
              {model.steps.map((s) => (
                <li key={s.index} style={stepItemStyle}>
                  <div style={stepHeaderStyle}>
                    <span style={stepBadgeStyle}>{s.index}</span>
                    <strong style={{ fontSize: 15 }}>{s.title}</strong>
                  </div>
                  {s.description.length > 0 && (
                    <p style={paragraphStyle}>{s.description}</p>
                  )}
                  {(() => {
                    const url = imageUrlFor(model.guideId, s.imageRef);
                    if (url === null) return null;
                    return (
                      <figure style={figureStyle}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt={s.altText ?? s.title}
                          style={imageStyle}
                          loading="lazy"
                        />
                        {s.altText !== null && (
                          <figcaption style={captionStyle}>
                            {s.altText}
                          </figcaption>
                        )}
                      </figure>
                    );
                  })()}
                </li>
              ))}
            </ol>
          </section>
        )}

        {model.tips.length > 0 && (
          <section style={{ marginBottom: 20 }}>
            <h2 style={sectionHeadingStyle}>Tips</h2>
            <ul style={listStyle}>
              {model.tips.map((t, i) => (
                <li key={i} style={listItemStyle}>
                  {t}
                </li>
              ))}
            </ul>
          </section>
        )}

        {model.warnings.length > 0 && (
          <section style={{ marginBottom: 20 }}>
            <h2 style={sectionHeadingStyle}>Warnings</h2>
            <ul style={listStyle}>
              {model.warnings.map((w, i) => (
                <li key={i} style={listItemStyle}>
                  {w}
                </li>
              ))}
            </ul>
          </section>
        )}

        {model.aiGenerated && (
          <footer
            style={{
              marginTop: 24,
              padding: "10px 12px",
              border: "1px solid #bfdbfe",
              background: "#eff6ff",
              borderRadius: 6,
              color: "#1e3a8a",
              fontSize: 12,
            }}
          >
            This guide was generated by Zipy AI from the sources listed in its
            provenance. Review before relying on it.
          </footer>
        )}
      </article>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace("Z", " UTC");
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const pageStyle: React.CSSProperties = {
  maxWidth: 820,
  margin: "0 auto",
  padding: "32px 20px 64px",
  fontFamily:
    "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  color: "#0f172a",
  background: "#ffffff",
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  margin: "0 0 8px",
  paddingBottom: 4,
  borderBottom: "1px solid #e2e8f0",
};

const paragraphStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.6,
  color: "#1e293b",
  margin: "4px 0 8px",
};

const listStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
};

const listItemStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.6,
  color: "#1e293b",
  marginBottom: 4,
};

const stepListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
};

const stepItemStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "12px 14px",
  marginBottom: 12,
  background: "#ffffff",
};

const stepHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 4,
};

const stepBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 22,
  height: 22,
  padding: "0 6px",
  borderRadius: 999,
  background: "#e0e7ff",
  color: "#1e3a8a",
  fontSize: 12,
  fontWeight: 600,
};

const figureStyle: React.CSSProperties = {
  margin: "8px 0 0",
  padding: 0,
};

const imageStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "auto",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "#f8fafc",
};

const captionStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: "#64748b",
};

const monoStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
};
