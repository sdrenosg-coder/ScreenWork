import { useEffect, useState } from "react";
import { Link } from "wouter";
import ReaderEngagement, { ReaderSearch, ReaderStepActions } from "../../../components/ReaderEngagement";
import PublicBrand from "../../../components/PublicBrand";
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

function imageUrlFor(guideId: string, imageRef: string | null): string | null {
  if (imageRef === null || imageRef.length === 0) return null;
  const encoded = encodeURIComponent(imageRef);
  return `/api/guides/${encodeURIComponent(guideId)}/images/${encoded}`;
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                    */
/* -------------------------------------------------------------------------- */

export default function PublicGuidePage({
  params,
}: {
  readonly params: { readonly slug: string };
}) {
  const [result, setResult] = useState<LoadResult | null>(null);
  useEffect(() => {
    setResult(null);
    const controller = new AbortController();
    setResult(null);
    fetch("/api/public-guides/" + encodeURIComponent(params.slug), { signal: controller.signal })
      .then(r => r.json()).then(data => { if (!controller.signal.aborted) setResult(data); })
      .catch(error => { if (!controller.signal.aborted) setResult({ kind: "storage_error", message: error.message }); });
    return () => controller.abort();
  }, [params.slug]);
  useEffect(() => { if (result?.kind === "rendered") document.title = result.model.title + " · Zipy AI"; }, [result]);
  if (!result) return <p role="status">Loading guide…</p>;

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
      <PublicBrand slug={params.slug}><article>
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
            <button type="button" className="z-btn" onClick={() => window.print()}>Print / Save PDF</button>
            {" · "}
            <a
              href={`/api/public-guides/${encodeURIComponent(params.slug)}/download?format=markdown`}
              style={{ color: "#1d4ed8", textDecoration: "none" }}
            >
              Markdown
            </a>
          </p>
        </header>
        <ReaderSearch slug={params.slug} steps={model.steps} />

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
                <li key={s.index} id={`reader-step-${s.index}`} data-reader-step-index={s.index} style={stepItemStyle}>
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
                  <ReaderStepActions slug={params.slug} index={s.index} />
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
        <ReaderEngagement key={params.slug} slug={params.slug} />
      </article></PublicBrand>
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
