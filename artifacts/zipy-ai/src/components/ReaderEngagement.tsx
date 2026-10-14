import { useEffect, useRef, useState } from "react";

export default function ReaderEngagement({ slug }: { slug: string }) {
  const visit = useRef("");
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setReady(false); setError("");
    const key = `zipy-reader:${slug}`;
    try {
      visit.current = sessionStorage.getItem(key) ?? crypto.randomUUID();
      sessionStorage.setItem(key, visit.current);
    } catch { if (!visit.current) visit.current = crypto.randomUUID(); }
    fetch(`/api/public-guides/${encodeURIComponent(slug)}/events`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "view", visitId: visit.current }), signal: abort.signal,
    }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Reader progress could not be recorded.");
      if (!abort.signal.aborted) { setReady(true); setCompleted(data.completed === true); }
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [slug, attempt]);

  async function complete() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/public-guides/${encodeURIComponent(slug)}/events`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "complete", visitId: visit.current }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Completion could not be saved.");
      setCompleted(true);
    } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <section className="z-panel z-reader-progress" aria-label="Reading progress">
    <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Finished this guide?</h2>
    <p style={{ color: "var(--muted)", fontSize: 13 }}>Let the author know this guide helped you complete the process. Your progress is anonymous.</p>
    <button className="z-btn z-btn-primary" data-testid="button-complete-guide" disabled={!ready || busy || completed} onClick={() => void complete()}>
      {completed ? "Marked complete" : busy ? "Saving…" : "Mark this guide complete"}
    </button>
    {completed && <p role="status" style={{ fontSize: 13 }}>Completion recorded. Thank you.</p>}
    {error && <div role="alert" className="z-err" style={{ marginTop: 12 }}>
      {error} Your guide remains readable.
      {!ready && <button className="z-btn" onClick={() => setAttempt(value => value + 1)}>Retry progress tracking</button>}
    </div>}
  </section>;
}
