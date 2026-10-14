import { Link } from "wouter";
import "./landing/landing.css";
import FeatureExplorer from "./landing/FeatureExplorer";
import { HowItWorks, Readiness, FinalCta } from "./landing/Sections";
import { ArrowUpRight, BookOpen, Layers3, LockKeyhole, Zap } from "lucide-react";

export default function Welcome() {
  return (
    <div className="z-welcome">
      <header className="z-welcome-nav">
        <Link href="/" className="z-welcome-brand"><span className="z-mark"><Zap size={18} aria-hidden /></span>Zipy</Link>
        <nav aria-label="Account navigation"><Link href="/features">Features & status</Link><Link href="/login" className="z-btn">Sign in <ArrowUpRight size={16} aria-hidden /></Link></nav>
      </header>
      <main id="zipy-main">
        <div className="z-welcome-hero">
          <div>
            <span className="z-welcome-eyebrow">A better way to pass on what you know</span>
            <h1>Less explaining.<br />More <em>understanding.</em></h1>
            <p className="z-welcome-description">Turn everyday processes into step-by-step guides your team can follow. Write, refine, keep every revision, and share only when you're ready.</p>
            <div className="z-welcome-actions">
              <Link href="/signup" className="z-btn z-btn-primary">Create your workspace <ArrowUpRight size={18} aria-hidden /></Link>
              <a href="#explore" className="z-btn">Explore all 26 workflows</a>
              <Link href="/login" className="z-btn">I already have an account</Link>
            </div>
            <p className="z-welcome-small">Your drafts are private. You control when they go public.</p>
          </div>
          <div className="z-welcome-demo" aria-label="Illustrative guide preview">
            <span className="z-welcome-demo-label">AN EXAMPLE OF A CLEARER HANDOFF</span>
            <article className="z-welcome-example">
              <span className="z-pill z-pill-ok">Step-by-step guide · Example</span>
              <h2>A great first day,<br />without the guesswork.</h2>
              <p>A simple onboarding guide for your next teammate.</p>
              {["Set up your workspace", "Find your team's resources", "Make your first contribution"].map((step, i) => (
                <div className="z-welcome-step" key={step}><span>{String(i + 1).padStart(2, "0")}</span><strong>{step}</strong><ArrowUpRight size={16} aria-hidden /></div>
              ))}
              <div className="z-welcome-demo-footer"><BookOpen size={16} aria-hidden /><span>Illustrative content, not your workspace data.</span></div>
            </article>
          </div>
        </div>
        <FeatureExplorer />
        <HowItWorks />
        <section className="z-welcome-benefits" aria-label="What you can do">
          <div><BookOpen aria-hidden /><h2>Write it once.</h2><p>Create and edit clear instructions. Reorder steps as your process evolves.</p></div>
          <div><Layers3 aria-hidden /><h2>Keep the progress.</h2><p>Save revisions and restore earlier work without overwriting someone else's changes.</p></div>
          <div><LockKeyhole aria-hidden /><h2>Share with intention.</h2><p>Publish a saved snapshot, or make it private again. Unpublished edits stay private.</p></div>
        </section>
        <Readiness />
        <FinalCta />
      </main>
      <footer className="z-welcome-footer">Zipy AI <span>AI generation, paid subscriptions and team invitations are still being built. <Link href="/features">View full feature status</Link></span></footer>
    </div>
  );
}
