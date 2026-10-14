import { useState } from "react";
import { Link } from "wouter";
import { ArrowUpRight, Play, RotateCcw } from "lucide-react";
import { GROUPS, STATUS_LABEL } from "./data";

const PILL = { available: "z-pill-ok", connecting: "z-pill-setup", notconnected: "z-pill-todo" } as const;

export default function FeatureExplorer() {
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(0);
  const g = GROUPS[i];
  const select = (n: number) => { setI(n); setShown(0); };
  return (
    <section className="zl-explorer" id="explore" aria-labelledby="zl-explore-h">
      <span className="z-welcome-eyebrow">All 26 workflow groups</span>
      <h2 id="zl-explore-h">Pick a workflow. See what it produces.</h2>
      <p className="zl-lead">These examples are illustrative, not your workspace data. They do not run AI jobs; sign in to process your own sources and generate a real draft.</p>
      <div className="zl-ex-grid">
        <ul className="zl-list" aria-label="Workflow groups">
          {GROUPS.map((x, n) => (
            <li key={x.id}>
              <button type="button" aria-pressed={n === i} className="zl-item" onClick={() => select(n)} data-testid={`button-group-${x.id}`}>
                <span className="zl-num">{String(n + 1).padStart(2, "0")}</span>
                <span className="zl-name">{x.title}</span>
                <span className={`zl-dot zl-dot-${x.status}`} aria-label={STATUS_LABEL[x.status]} />
              </button>
            </li>
          ))}
        </ul>
        <article className="zl-demo" aria-live="polite" data-testid={`panel-group-${g.id}`}>
          <div className="zl-demo-head">
            <span className={`z-pill ${PILL[g.status]}`}>{STATUS_LABEL[g.status]}</span>
            <span className="zl-tag">Illustrative example</span>
          </div>
          <h3>{g.title}</h3>
          <p className="zl-blurb">{g.blurb}</p>
          <div className="zl-io">
            <div className="zl-in"><small>Example input</small><code>{g.input}</code></div>
            <div className="zl-out">
              <small>Example output: {g.format}</small>
              {shown === 0 ? <p className="zl-empty">Run the example to preview the shape of the result.</p> :
                <ol>{g.output.slice(0, shown).map((l) => <li key={l}>{l}</li>)}</ol>}
            </div>
          </div>
          <div className="zl-actions">
            <button type="button" className="z-btn" onClick={() => setShown((s) => Math.min(s + 1, g.output.length))} disabled={shown >= g.output.length} data-testid="button-run-example"><Play size={14} aria-hidden /> {shown === 0 ? "Run illustrative example" : "Show next"}</button>
            {shown > 0 && <button type="button" className="z-btn" onClick={() => setShown(0)}><RotateCcw size={14} aria-hidden /> Reset</button>}
          </div>
          <p className="z-note">Readiness: {g.note}</p>
          <Link href="/features" className="zl-more">Full readiness details <ArrowUpRight size={14} aria-hidden /></Link>
        </article>
      </div>
    </section>
  );
}
