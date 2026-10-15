import { useEffect, useRef, useState } from "react";

const volatileVisits = new Map<string, string>();
function visitId(slug: string) {
  const key = `zipy-reader:${slug}`;
  try {
    const id = sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key, id); return id;
  } catch {
    const id = volatileVisits.get(slug) ?? crypto.randomUUID();
    volatileVisits.set(slug, id); return id;
  }
}

const pendingViews = new Map<string, Promise<{ completed: boolean }>>();
async function postEvent(slug: string, visit: string, event: Record<string, unknown>, signal?: AbortSignal) {
  if (event.kind === "view") {
    const key = `${slug}:${visit}`;
    const previous = pendingViews.get(key);
    if (previous) return previous;
    // All controls in one reader share a single accepted view, rather than
    // queuing duplicate cloud requests and advisory locks for each click.
    const pending = sendEvent(slug, visit, event).catch(error => {
      pendingViews.delete(key); throw error;
    });
    if (pendingViews.size >= 200) pendingViews.delete(pendingViews.keys().next().value!);
    pendingViews.set(key, pending);
    return pending;
  }
  const result = await sendEvent(slug, visit, event, signal);
  if (event.kind === "complete") {
    pendingViews.set(`${slug}:${visit}`, Promise.resolve(result));
  }
  return result;
}
async function sendEvent(slug: string, visit: string, event: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(`/api/public-guides/${encodeURIComponent(slug)}/events`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...event, visitId: visit }), signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "Reader progress could not be recorded.");
  return data as { completed: boolean };
}

export function ReaderSearch({ slug, steps }: { slug: string; steps: readonly { index: number; title: string; description: string }[] }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<typeof steps | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function search() {
    const phrase = query.trim();
    if (!phrase) return;
    setMatches(steps.filter(step => `${step.title} ${step.description}`.toLocaleLowerCase().includes(phrase.toLocaleLowerCase())));
    setBusy(true); setError("");
    try {
      const visit = visitId(slug);
      await postEvent(slug, visit, { kind: "view" });
      await postEvent(slug, visit, { kind: "search", query: phrase });
    } catch { setError("Search results remain available, but search analytics could not be saved."); }
    finally { setBusy(false); }
  }
  return <section className="z-panel" aria-label="Search this guide" style={{ marginBottom: 20 }}>
    <form onSubmit={event => { event.preventDefault(); void search(); }} style={{ display: "flex", gap: 8 }}>
      <label style={{ flex: 1 }}>Search this guide
        <input className="z-input" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Find a step…" />
      </label>
      <button className="z-btn" style={{ alignSelf: "end" }} disabled={!query.trim() || busy}>Search</button>
    </form>
    <p style={{ fontSize: 12, color: "var(--muted)" }}>Search phrases are not stored. Only anonymous counts and query hashes are recorded.</p>
    {matches && <div role="status">{matches.length ? <ul>{matches.map(step => <li key={step.index}><a href={`#reader-step-${step.index}`}>{step.index}. {step.title}</a></li>)}</ul> : <p>No steps match this search. Try another phrase.</p>}</div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function ReaderStepActions({ slug, index }: { slug: string; index: number }) {
  const [completed, setCompleted] = useState(false);
  const [rating, setRating] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  async function record(kind: "step-complete" | "feedback", value?: string) {
    setBusy(true); setStatus("");
    try {
      const visit = visitId(slug);
      await postEvent(slug, visit, { kind: "view" });
      await postEvent(slug, visit, { kind, stepIndex: index, ...(value ? { rating: Number(value) } : {}) });
      if (kind === "step-complete") setCompleted(true);
      else setRating(value!);
      setStatus(kind === "step-complete" ? "Step completion recorded." : "Step rating saved anonymously.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save. Please try again."); }
    finally { setBusy(false); }
  }
  return <div style={{ marginTop: 12 }}>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      <button className="z-btn" disabled={busy || completed} onClick={() => void record("step-complete")}>{completed ? "Step completed" : busy ? "Saving…" : "I completed this step"}</button>
      <label style={{ fontSize: 13 }}>Rate this step{" "}
        <select className="z-input" style={{ width: "auto" }} disabled={busy} value={rating} onChange={event => void record("feedback", event.target.value)}>
          <option value="" disabled>Choose a rating</option>
          {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} / 5</option>)}
        </select>
      </label>
    </div>
    {status && <p role="status" style={{ fontSize: 12 }}>{status}</p>}
  </div>;
}

export default function ReaderEngagement({ slug }: { slug: string }) {
  const visit = useRef("");
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rating, setRating] = useState(0);
  const reached = useRef(new Set<number>());
  useEffect(() => {
    const abort = new AbortController();
    setReady(false); setError("");
    if (!visit.current) visit.current = visitId(slug);
    postEvent(slug, visit.current, { kind: "view" }, abort.signal).then(data => {
      if (!abort.signal.aborted) { setReady(true); setCompleted(data.completed === true); }
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [slug, attempt]);

  useEffect(() => {
    if (!ready || typeof IntersectionObserver === "undefined") return;
    const abort = new AbortController();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.readerStepIndex);
        if (!entry.isIntersecting || reached.current.has(index)) continue;
        reached.current.add(index);
        void postEvent(slug, visit.current, { kind: "step-view", stepIndex: index }, abort.signal)
          .catch(() => {
            reached.current.delete(index);
            if (!abort.signal.aborted) setError("Some reading progress could not be recorded.");
          });
      }
    }, { rootMargin: "-10% 0px -20% 0px", threshold: 0 });
    document.querySelectorAll("[data-reader-step-index]").forEach(element => observer.observe(element));
    return () => { observer.disconnect(); abort.abort(); };
  }, [slug, ready]);

  async function complete() {
    setBusy(true); setError("");
    try {
      await postEvent(slug, visit.current, { kind: "complete" });
      setCompleted(true);
    } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function rate(value: number) {
    setBusy(true); setError("");
    try {
      await postEvent(slug, visit.current, { kind: "feedback", rating: value });
      setRating(value);
    } catch (error) { setError(error instanceof Error ? error.message : "Rating could not be saved."); }
    finally { setBusy(false); }
  }
  return <section className="z-panel z-reader-progress" aria-label="Reading progress">
    <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Finished this guide?</h2>
    <p style={{ color: "var(--muted)", fontSize: 13 }}>Let the author know this guide helped you complete the process. Your progress is anonymous.</p>
    <button className="z-btn z-btn-primary" data-testid="button-complete-guide" disabled={!ready || busy || completed} onClick={() => void complete()}>
      {completed ? "Marked complete" : busy ? "Saving…" : "Mark this guide complete"}
    </button>
    {completed && <p role="status" style={{ fontSize: 13 }}>Completion recorded. Thank you.</p>}
    <fieldset style={{ border: 0, padding: 0, marginTop: 16 }}>
      <legend style={{ fontSize: 14, marginBottom: 8 }}>How useful was this guide?</legend>
      <div style={{ display: "flex", gap: 8 }}>
        {[1, 2, 3, 4, 5].map(value => <button key={value} className={`z-btn ${rating === value ? "z-btn-primary" : ""}`} aria-pressed={rating === value} aria-label={`Rate guide ${value} out of 5`} disabled={!ready || busy} onClick={() => void rate(value)}>{value} / 5</button>)}
      </div>
      {rating > 0 && <p role="status" style={{ fontSize: 12 }}>Your anonymous rating was saved. You can change it.</p>}
    </fieldset>
    {error && <div role="alert" className="z-err" style={{ marginTop: 12 }}>
      {error} Your guide remains readable.
      <button className="z-btn" onClick={() => setAttempt(value => value + 1)}>Retry progress tracking</button>
    </div>}
  </section>;
}
