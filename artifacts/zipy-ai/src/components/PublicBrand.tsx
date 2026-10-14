import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

interface PublicTheme {
  enabled: boolean; whiteLabel?: boolean; brandName?: string; legalFooterText?: string;
  colors?: Record<string, string>;
  fonts?: { role: string; family?: string; weight?: number; fallbackFamilies?: string[] }[];
  logo?: { alt: string } | null;
}

export default function PublicBrand({ slug, children }: { slug: string; children: ReactNode }) {
  const [theme, setTheme] = useState<PublicTheme | null>(null);
  const [error, setError] = useState("");
  const [logoError, setLogoError] = useState(false);
  useEffect(() => {
    setTheme(null); setError(""); setLogoError(false);
    const abort = new AbortController();
    fetch(`/api/public-guides/${encodeURIComponent(slug)}/theme`, { signal: abort.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error("Branding could not load. Guide content is unaffected.");
        if (!abort.signal.aborted) setTheme(data);
      }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [slug]);
  useEffect(() => {
    if (theme?.enabled && theme.whiteLabel) document.documentElement.dataset.zipyWhiteLabel = "true";
    return () => { delete document.documentElement.dataset.zipyWhiteLabel; };
  }, [theme?.enabled, theme?.whiteLabel]);
  const style: Record<string, string | number> = {};
  if (theme?.enabled) {
    const colors = theme.colors ?? {};
    for (const [key, fallback] of Object.entries({ surface: "#ffffff", text: "#18181b", textMuted: "#52525b", accent: "#1d4ed8", accentText: "#ffffff", border: "#d4d4d8" })) {
      style[`--reader-${key}`] = colors[key] ?? fallback;
    }
    for (const role of ["body", "heading", "mono"]) {
      const pick = theme.fonts?.find(font => font.role === role);
      if (pick) {
        const family = [pick.family, ...(pick.fallbackFamilies ?? [])].filter(Boolean).join(", ");
        if (family) style[`--reader-font-${role}`] = family;
        if (pick.weight) style[`--reader-weight-${role}`] = pick.weight;
      }
    }
  }
  return <div className="z-public-theme" data-enabled={theme?.enabled === true} style={style as CSSProperties}>
    {theme?.enabled && <header className="z-public-brand">
      {theme.logo && !logoError && <img src={`/api/public-guides/${encodeURIComponent(slug)}/logo`} alt={theme.logo.alt} onError={() => setLogoError(true)} />}
      {theme.brandName && <strong>{theme.brandName}</strong>}
      {logoError && <small>Brand logo unavailable</small>}
    </header>}
    {error && <p role="status">{error}</p>}
    {children}
    {theme?.enabled && theme.legalFooterText && <footer className="z-public-legal">{theme.legalFooterText}</footer>}
  </div>;
}
