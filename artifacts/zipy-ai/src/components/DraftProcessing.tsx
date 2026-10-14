import { useEffect, useRef, useState } from "react";
import "./DraftProcessing.css";

interface Draft {
  title: string; introduction: string;
  steps: { title: string; description: string }[];
  tips: string[]; faq: { question: string; answer: string }[];
  glossary: { term: string; definition: string }[];
  provenance: { provider: string; model: string; requiresHumanReview: boolean };
}
interface Job { jobId: string; status: string; error: string | null; draft: Draft | null; expectedVersion?: number }

export default function DraftProcessing({ guideId, version, dirty }: { guideId: string; version: number; dirty: boolean }) {
  const [sourceKind, setSourceKind] = useState("text");
  const [source, setSource] = useState("");
  const [language, setLanguage] = useState("English");
  const [tone, setTone] = useState("clear");
  const [voice, setVoice] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const revision = `${guideId}:${version}`;
  const currentRevision = useRef(revision);
  currentRevision.current = revision;
  const [confirmedRevision, setConfirmedRevision] = useState<string | null>(null);
  const [approvedRevision, setApprovedRevision] = useState<string | null>(null);
  const [loadedReviewRevision, setLoadedReviewRevision] = useState<string | null>(null);
  const confirmed = confirmedRevision === revision && loadedReviewRevision === revision;

  useEffect(() => {
    setConfirmedRevision(null);
    setApprovedRevision(null);
    setLoadedReviewRevision(null);
    setNeedsReview(false);
    setBusy(false);
    setJob(null);
    setError("");
    const abort = new AbortController();
    fetch(`/api/guides/${guideId}`, { signal: abort.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.error?.message ?? "Draft status could not load.");
      if (abort.signal.aborted) return;
      if (data.guide.version !== version) throw new Error("The saved guide changed. Reload it before reviewing.");
      setLoadedReviewRevision(`${guideId}:${version}`);
      setNeedsReview(Boolean(data.guide.aiDraftJobId) && data.guide.reviewedVersion !== version);
      if (data.guide.activeDraftJobId || data.guide.aiDraftJobId) setJob({ jobId: data.guide.activeDraftJobId ?? data.guide.aiDraftJobId, status: "pending", error: null, draft: null });
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [guideId, version]);

  useEffect(() => {
    if (!job || !["pending", "active"].includes(job.status)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/guides/${guideId}/draft-jobs/${job.jobId}`, { signal: abort.signal })
        .then(async response => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.message ?? data.error?.message ?? "Job status could not load.");
          if (!abort.signal.aborted) {
            setJob(data);
            if (data.source?.value) { setSource(data.source.value); setSourceKind(data.source.kind); }
            if (data.options?.language) setLanguage(data.options.language);
            if (data.options?.tone) setTone(data.options.tone);
            if (typeof data.options?.brandVoice === "string") setVoice(data.options.brandVoice);
          }
        }).catch(error => { if (!abort.signal.aborted) { setError(error.message); setJob(previous => previous ? { ...previous, status: "status_error" } : null); } });
    }, 1800);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [job, guideId]);

  async function request(url: string, body: object) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? data.error?.message ?? `Request failed with HTTP ${response.status}.`);
    return data;
  }
  async function generate() {
    setBusy(true); setError("");
    try {
      const queued = await request(`/api/guides/${guideId}/draft-jobs`, { expectedVersion: version, sourceKind, source, language, tone, brandVoice: voice });
      setJob({ ...queued, status: "pending", error: null, draft: null });
    } catch (error) { setError(error instanceof Error ? error.message : "Could not start drafting."); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!job) return;
    setBusy(true); setError("");
    try { await request(`/api/guides/${guideId}/draft-jobs/${job.jobId}/apply`, { expectedVersion: version }); window.location.reload(); }
    catch (error) { setError(error instanceof Error ? error.message : "The draft could not be applied."); setBusy(false); }
  }
  async function approve() {
    if (!confirmed || dirty) return;
    const submittedRevision = revision;
    setBusy(true); setError("");
    try {
      await request(`/api/guides/${guideId}/review`, { expectedVersion: version, confirmed });
      if (currentRevision.current === submittedRevision) { setNeedsReview(false); setApprovedRevision(submittedRevision); }
    } catch (error) { if (currentRevision.current === submittedRevision) setError(error instanceof Error ? error.message : "Review could not be saved."); }
    finally { if (currentRevision.current === submittedRevision) setBusy(false); }
  }
  const running = job && ["pending", "active"].includes(job.status);
  return <section className="z-panel z-draft-processing" style={{ marginBottom: 24, padding: 24 }} aria-label="AI draft processing">
    <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>Turn source material into a draft</h2>
    <p style={{ fontSize: 13, color: "var(--muted)" }}>Real AI processing—not an illustrative demo. Your saved guide stays unchanged until you apply the result. AI uses Replit credits; customer billing is disconnected. Free processing is limited to 3 AI jobs per workspace per rolling 24 hours.</p>
    {dirty && <p role="status" className="z-note">Save or discard your current step edits before generating, applying or approving a draft.</p>}
    <div className="z-field"><label htmlFor="draft-source-kind">Source</label><select id="draft-source-kind" value={sourceKind} onChange={event => setSourceKind(event.target.value)} disabled={busy || Boolean(running)}>
      <option value="text">Text / process notes</option><option value="url">Public web page URL</option>
    </select></div>
    <div className="z-field"><label htmlFor="draft-source-value">{sourceKind === "url" ? "Public page URL" : "Source instructions"}</label>
      <textarea id="draft-source-value" data-testid="input-draft-source" value={source} onChange={event => setSource(event.target.value)} maxLength={30000} rows={5} placeholder={sourceKind === "url" ? "https://example.com/help/process" : "Paste the real process notes you want to explain…"} disabled={busy || Boolean(running)} />
    </div>
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      <div className="z-field" style={{ flex: "1 1 150px" }}><label htmlFor="draft-language">Output language</label><input id="draft-language" value={language} maxLength={60} disabled={busy || Boolean(running)} onChange={event => setLanguage(event.target.value)} /></div>
      <div className="z-field" style={{ flex: "1 1 150px" }}><label htmlFor="draft-tone">Tone</label><select id="draft-tone" value={tone} disabled={busy || Boolean(running)} onChange={event => setTone(event.target.value)}><option value="clear">Clear and practical</option><option value="friendly">Friendly</option><option value="formal">Formal</option></select></div>
    </div>
    <div className="z-field"><label htmlFor="draft-brand-voice">Brand voice instructions (optional)</label><input id="draft-brand-voice" value={voice} maxLength={1000} disabled={busy || Boolean(running)} onChange={event => setVoice(event.target.value)} /></div>
    <button className="z-btn z-btn-primary" data-testid="button-generate-draft" disabled={dirty || busy || Boolean(running) || source.trim().length < 5 || !language.trim()} onClick={() => void generate()}>{running ? job.status === "active" ? "Processing source…" : "Queued for processing…" : busy ? "Starting…" : "Generate AI draft"}</button>
    {job?.status === "status_error" && <button className="z-btn" onClick={() => { setError(""); setJob({ ...job, status: "pending" }); }}>Reconnect to job status</button>}
    {job?.status === "failed" && <p role="alert" className="z-err">{job.error ?? "Processing failed."} No draft was applied. You can retry generation.</p>}
    {error && <p className="z-err" role="alert">{error}</p>}
    {job?.draft && <div style={{ marginTop: 24 }} data-testid="draft-preview">
      <span className="z-pill">AI-generated draft</span><h3>{job.draft.title}</h3><p>{job.draft.introduction}</p>
      <ol>{job.draft.steps.map((step, index) => <li key={index} style={{ marginBottom: 12 }}><strong>{step.title}</strong><p>{step.description}</p></li>)}</ol>
      {job.draft.tips?.length > 0 && <details><summary>Tips and warnings</summary><ul>{job.draft.tips.map((tip, i) => <li key={i}>{tip}</li>)}</ul></details>}
      {job.draft.faq?.length > 0 && <details><summary>FAQ</summary>{job.draft.faq.map((item, i) => <div key={i}><strong>{item.question}</strong><p>{item.answer}</p></div>)}</details>}
      {job.draft.glossary?.length > 0 && <details><summary>Glossary</summary><dl>{job.draft.glossary.map((item, i) => <div key={i}><dt>{item.term}</dt><dd>{item.definition}</dd></div>)}</dl></details>}
      <p style={{ fontSize: 12, color: "var(--muted)" }}>Generated with {job.draft.provenance.provider}, {job.draft.provenance.model}. Check every instruction before publishing.</p>
      <button type="button" className="z-btn z-btn-primary" data-testid="button-apply-draft" disabled={dirty || busy || job.expectedVersion !== version} onClick={() => void apply()}>{job.expectedVersion !== version ? "Draft belongs to an earlier revision" : "Apply as a new saved revision"}</button>
    </div>}
    {approvedRevision === revision && <p className="z-note" role="status">Revision {version} is approved. You can now publish this saved revision.</p>}
    {needsReview && loadedReviewRevision === revision && <div id="ai-review" className="z-note" style={{ marginTop: 20 }}><h3>Review this AI-generated revision</h3><p>Inspect the saved steps below. Publication is blocked until the current revision is approved.</p>
      <label style={{ display: "flex", alignItems: "start", gap: 8 }}><input type="checkbox" checked={confirmed} onChange={event => setConfirmedRevision(event.target.checked ? revision : null)} data-testid="checkbox-review-draft" /> I reviewed the saved instructions for accuracy and safety.</label>
      <button className="z-btn" data-testid="button-approve-draft" disabled={!confirmed || dirty || busy} onClick={() => void approve()}>Approve revision {version}</button>
    </div>}
  </section>;
}
