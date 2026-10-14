import { Link } from "wouter";
import "./landing/landing.css";
import FeatureExplorer from "./landing/FeatureExplorer";
import { HowItWorks, Readiness, FinalCta } from "./landing/Sections";
import { ArrowDown, ArrowUpRight, BookOpen, Check, FileText, Globe2, Layers3, LockKeyhole, MessageSquareText, ShieldCheck, Sparkles, Zap } from "lucide-react";

export default function Welcome() {
  return (
    <div className="z-welcome">
      <header className="z-welcome-nav">
        <Link href="/" className="z-welcome-brand"><span className="z-mark"><Zap size={18} aria-hidden /></span>Zipy</Link>
        <nav aria-label="Account navigation"><Link href="/features">Capabilities</Link><Link href="/login" className="z-nav-login">Sign in <ArrowUpRight size={15} aria-hidden /></Link><Link href="/signup" className="z-btn z-btn-primary z-nav-cta">Create workspace</Link></nav>
      </header>
      <main id="zipy-main">
        <section className="z-welcome-hero" aria-labelledby="z-hero-title">
          <div className="z-hero-copy">
            <span className="z-welcome-eyebrow"><span className="z-eyebrow-dot" /> Workflow guides for the work behind the work</span>
            <h1 id="z-hero-title">Good work<br />shouldn't live<br /><em>in someone's head.</em></h1>
            <p className="z-welcome-description">Zipy turns notes, public webpages and documents into clear, editable step-by-step guides. Your team reviews every draft, keeps every version, then publishes when it is ready.</p>
            <div className="z-welcome-actions">
              <Link href="/signup" className="z-btn z-btn-primary">Start a workspace <ArrowUpRight size={17} aria-hidden /></Link>
              <a href="#how-it-works" className="z-btn z-btn-text">See how it works <ArrowDown size={15} aria-hidden /></a>
            </div>
            <p className="z-welcome-small"><ShieldCheck size={15} aria-hidden /> Private drafts. Human-reviewed publishing. Your call, every time.</p>
          </div>
          <div className="z-product-stage" aria-label="Illustrative Zipy guide editor preview">
            <div className="z-stage-caption"><span>THE GUIDE, NOT THE BUSYWORK</span><span className="z-illustrative-tag">Illustrative preview</span></div>
            <div className="z-product-window">
              <div className="z-product-topbar">
                <div className="z-window-brand"><span className="z-window-mark"><Zap size={12} aria-hidden /></span><span>Zipy</span><span className="z-window-divider">/</span><span>Operations</span></div>
                <div className="z-window-right"><span className="z-window-status"><i /> Draft</span><span className="z-avatar">AM</span></div>
              </div>
              <div className="z-editor-layout">
                <aside className="z-editor-rail" aria-hidden="true"><span className="z-rail-icon active"><BookOpen size={15} /></span><span className="z-rail-icon"><Layers3 size={15} /></span><span className="z-rail-icon"><MessageSquareText size={15} /></span></aside>
                <div className="z-editor-main">
                  <div className="z-source-chips"><span><FileText size={12} aria-hidden /> Team notes</span><span><Globe2 size={12} aria-hidden /> Help page</span><b>2 sources</b></div>
                  <span className="z-guide-kicker">CUSTOMER OPERATIONS · EXAMPLE</span>
                  <h2>Resolve a delivery<br />address change</h2>
                  <p className="z-editor-summary">A reviewed guide for support specialists handling an in-flight order.</p>
                  <div className="z-editor-step"><span>01</span><div><strong>Confirm the order is still eligible</strong><small>Check the fulfillment status before making an update.</small></div><Check size={14} aria-hidden /></div>
                  <div className="z-editor-step"><span>02</span><div><strong>Verify the customer's identity</strong><small>Use the approved account verification steps.</small></div><Check size={14} aria-hidden /></div>
                  <div className="z-editor-step muted"><span>03</span><div><strong>Update the address and confirm</strong><small>Review the new details back with the customer.</small></div><span className="z-step-more">•••</span></div>
                  <div className="z-editor-foot"><span><Sparkles size={13} aria-hidden /> Draft preview · needs human review</span><span>Version 04</span></div>
                </div>
              </div>
              <div className="z-product-bottom"><span>Example content only — not live AI output or workspace data.</span><span>Save draft <ArrowUpRight size={12} aria-hidden /></span></div>
            </div>
            <div className="z-stage-note"><span className="z-stage-note-mark"><Check size={13} aria-hidden /></span><span><strong>Review stays in the loop.</strong> Drafts are not published automatically.</span></div>
          </div>
        </section>
        <section className="z-proofline" aria-label="Built for everyday operations">
          <span>FROM THE KNOWLEDGE YOUR TEAM ALREADY HAS</span>
          <div><span><FileText size={15} aria-hidden /> Notes & documents</span><i /><span><Globe2 size={15} aria-hidden /> Public webpages</span><i /><span><BookOpen size={15} aria-hidden /> Existing guides</span></div>
        </section>
        <FeatureExplorer />
        <HowItWorks />
        <section className="z-welcome-benefits" aria-label="Why operations teams use Zipy">
          <div><span className="z-benefit-icon"><BookOpen aria-hidden /></span><span className="z-benefit-index">01 / MAKE IT USABLE</span><h2>Instructions people can follow.</h2><p>Turn scattered know-how into ordered steps with source material close at hand.</p></div>
          <div><span className="z-benefit-icon"><Layers3 aria-hidden /></span><span className="z-benefit-index">02 / KEEP IT CURRENT</span><h2>A history, not an overwrite.</h2><p>Review changes, restore a previous revision and keep the useful context intact.</p></div>
          <div><span className="z-benefit-icon"><LockKeyhole aria-hidden /></span><span className="z-benefit-index">03 / SHARE ON PURPOSE</span><h2>Publish only what is ready.</h2><p>Publish a saved snapshot, revoke access later, or export for the rest of your stack.</p></div>
        </section>
        <section className="z-audience">
          <div className="z-audience-heading"><span className="z-welcome-eyebrow">For the people holding the process together</span><h2>Make the next handoff<br />a little less fragile.</h2><p>Zipy gives teams a dependable place to shape the how-to work that keeps customers supported and operations moving.</p><Link href="/signup" className="z-inline-link">Build your first guide <ArrowUpRight size={15} aria-hidden /></Link></div>
          <div className="z-audience-list">
            <article><span>01</span><div><h3>Support teams</h3><p>Make the right answer easier to find and repeat.</p></div><MessageSquareText size={20} aria-hidden /></article>
            <article><span>02</span><div><h3>Operations leads</h3><p>Keep recurring work consistent as the process changes.</p></div><Layers3 size={20} aria-hidden /></article>
            <article><span>03</span><div><h3>Team enablement</h3><p>Give new colleagues a clearer path to confident work.</p></div><BookOpen size={20} aria-hidden /></article>
          </div>
        </section>
        <Readiness />
        <FinalCta />
      </main>
      <footer className="z-welcome-footer"><Link href="/" className="z-footer-brand"><span className="z-mark"><Zap size={14} aria-hidden /></span>Zipy</Link><span>Practical knowledge, made useful.</span><nav aria-label="Footer navigation"><Link href="/features">Capability details</Link><Link href="/login">Sign in</Link><Link href="/signup">Create workspace</Link></nav><small>Billing is not connected. See capability details for current limits.</small></footer>
    </div>
  );
}
