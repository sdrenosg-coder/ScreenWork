import { Link } from "wouter";
import { ArrowUpRight } from "lucide-react";
import { GROUPS } from "./data";

export function HowItWorks() {
  const s = [["01", "Gather", "Bring notes, pages, files, recordings or start from a blank guide."], ["02", "Shape", "Turn material into ordered steps with screenshots and annotations."], ["03", "Review", "A person checks wording, safety and accuracy before anything goes out."], ["04", "Share", "Publish a snapshot, export it, and see whether people finish it."]];
  return (
    <section className="zl-how" aria-labelledby="zl-how-h">
      <span className="z-welcome-eyebrow">From mess to guide</span>
      <h2 id="zl-how-h">Four moves, in your control.</h2>
      <div className="zl-steps">{s.map(([n, t, d]) => <div key={n}><b>{n}</b><h3>{t}</h3><p>{d}</p></div>)}</div>
    </section>
  );
}

export function Readiness() {
  const by = (k: string) => GROUPS.filter((g) => g.status === k);
  const cols: [string, string, string][] = [["available", "Core available", "Core parts are usable today with a real account. Advanced parts of these groups are still unfinished."], ["connecting", "Being connected", "Partly working; advanced portions are not finished. Examples on this page are illustrative, not production results."], ["notconnected", "Not connected", "No payments or paid plans are active."]];
  return (
    <section className="zl-ready" aria-labelledby="zl-ready-h">
      <span className="z-welcome-eyebrow">Honest status</span>
      <h2 id="zl-ready-h">What works today, and what does not yet.</h2>
      <div className="zl-ready-grid">
        {cols.map(([k, t, d]) => (
          <div key={k}><h3>{t} ({by(k).length})</h3><p style={{ color: "var(--muted)", fontSize: 13, margin: "6px 0 0" }}>{d}</p>
            <ul>{by(k).map((g) => <li key={g.id}>{g.title}</li>)}</ul></div>
        ))}
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="zl-cta">
      <h2>Start with a guide you write yourself.</h2>
      <p>Guides, version history, AI drafts with human review, document and media sources, publishing and exports, templates, discussion, team invites, webhooks and analytics work now; advanced parts of several are not finished. Billing is not connected. The rest is being connected, and the status page tells you exactly where.</p>
      <div className="z-welcome-actions">
        <Link href="/signup" className="z-btn z-btn-primary">Create your workspace <ArrowUpRight size={18} aria-hidden /></Link>
        <Link href="/login" className="z-btn">Sign in</Link>
        <Link href="/features" className="z-btn">Feature status</Link>
      </div>
    </section>
  );
}
