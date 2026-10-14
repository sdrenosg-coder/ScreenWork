import { Link } from "wouter";
import { ArrowUpRight, Check, CircleDashed, Minus } from "lucide-react";
import { GROUPS } from "./data";

export function HowItWorks() {
  const s = [["01", "Bring the source", "Start with notes, a public webpage, a PDF or an Office document. Keep the source beside the guide."], ["02", "Shape the steps", "Draft from text or a public URL, then edit the sequence, wording and supporting details."], ["03", "Review together", "A person checks the draft, adds comments and saves a version before it is shared."], ["04", "Publish and learn", "Share a fixed snapshot, export a copy, and track reader sessions and completions."]];
  return (
    <section className="zl-how" id="how-it-works" aria-labelledby="zl-how-h">
      <div className="zl-section-heading"><div><span className="z-welcome-eyebrow">A simple path from source to shared knowledge</span><h2 id="zl-how-h">From rough notes<br />to ready-to-use.</h2></div><p>Zipy helps the people who know the process make it easier for everyone else to do it well.</p></div>
      <div className="zl-steps">{s.map(([n, t, d]) => <article key={n}><b>{n}</b><span className="zl-step-line" /><h3>{t}</h3><p>{d}</p></article>)}</div>
    </section>
  );
}

export function Readiness() {
  const by = (k: string) => GROUPS.filter((g) => g.status === k);
  const cols = [
    { key: "available", title: "Ready to use", description: "Core workflows are available now: accounts, source drafting, guide editing and versions, human review, publishing, exports, basic reader analytics and reader branding.", icon: <Check size={16} aria-hidden /> },
    { key: "connecting", title: "Available in part", description: "Some useful pieces work today; broader automation or advanced options are not complete. Check each group for exact boundaries.", icon: <CircleDashed size={16} aria-hidden /> },
    { key: "notconnected", title: "Not connected", description: "Billing is disconnected; no paid plans or payments are active. This does not affect creating and sharing guides.", icon: <Minus size={16} aria-hidden /> },
  ];
  return (
    <section className="zl-ready" aria-labelledby="zl-ready-h">
      <div className="zl-ready-intro"><span className="z-welcome-eyebrow">A clear view of what's here</span><h2 id="zl-ready-h">Useful now. Still growing.</h2><p>Zipy is an evolving product. Here is the practical split today, with all 26 capability groups represented below.</p></div>
      <div className="zl-ready-grid">
        {cols.map(({ key, title, description, icon }) => (
          <article key={key} className={`zl-ready-card zl-ready-${key}`}><div className="zl-ready-card-head"><span>{icon}</span><b>{by(key).length} groups</b></div><h3>{title}</h3><p className="zl-ready-description">{description}</p>
            <ul>{by(key).map((g) => <li key={g.id}>{g.title}</li>)}</ul></article>
        ))}
      </div>
      <div className="zl-boundaries"><span className="zl-boundary-label">Worth knowing</span><p>Automated browser actions, real-time co-editing, template inheritance, compliance certification and automatic erasure are not available. Video processing is limited rather than exhaustive, and full production durability has not been verified. <Link href="/features">See the precise capability notes <ArrowUpRight size={14} aria-hidden /></Link></p></div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="zl-cta">
      <div className="zl-cta-copy"><span className="zl-cta-kicker">Make the know-how easier to pass on</span><h2>Give your best process<br />a place to live.</h2><p>Start with the notes you already have. Shape a guide, review it with your team and choose when it is ready to share.</p></div>
      <div className="z-welcome-actions">
        <Link href="/signup" className="z-btn z-btn-primary">Create your workspace <ArrowUpRight size={18} aria-hidden /></Link>
        <Link href="/login" className="z-btn z-btn-on-dark">Sign in</Link>
        <Link href="/features" className="zl-cta-status">Explore all capabilities <ArrowUpRight size={15} aria-hidden /></Link>
      </div>
    </section>
  );
}
