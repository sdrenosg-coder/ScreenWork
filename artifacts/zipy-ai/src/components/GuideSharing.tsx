import { useEffect, useState } from "react";
import { Link } from "wouter";

export default function GuideSharing({ guideId, currentVersion, dirty }: { guideId: string; currentVersion: number; dirty: boolean }) {
  const [slug, setSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/guides/${encodeURIComponent(guideId)}`, { signal: abort.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? "Sharing status could not load.");
        if (!abort.signal.aborted) setSlug(data.guide.visibility === "public" ? data.guide.slug : null);
      })
      .catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [guideId, currentVersion]);

  async function changePublication(publish: boolean) {
    if (!publish && !window.confirm("Make this guide private? People with its public link will no longer be able to read it. Your guide and version history will be kept.")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/guides/${encodeURIComponent(guideId)}/${publish ? "publish" : "unpublish"}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: currentVersion }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Sharing settings could not be saved.");
      setSlug(publish ? data.slug : null);
      setMessage(data.message);
    } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  }

  async function copyLink() {
    try {
      const path = import.meta.env.BASE_URL + `p/${encodeURIComponent(slug!)}`;
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      setMessage("Public link copied.");
    } catch { setError("Copy was blocked by your browser. Open the public guide and copy its address."); }
  }
  return (
    <section className="z-panel" style={{ marginBottom: 20 }} aria-label="Sharing and export" data-testid="guide-sharing">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>Share your knowledge</h2>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
            {slug ? "A published snapshot is public. New edits stay private until you publish again." : "Only your workspace can read this draft."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <a className="z-btn" href={`/api/guides/${encodeURIComponent(guideId)}/download?format=markdown`}>Export Markdown</a>
          <a className="z-btn" href={`/api/guides/${encodeURIComponent(guideId)}/download?format=json`}>Export JSON</a>
          <button className="z-btn z-btn-primary" data-testid="button-publish-guide" disabled={busy || dirty} onClick={() => void changePublication(true)}>
            {busy ? "Updating…" : slug ? "Publish saved changes" : "Publish guide"}
          </button>
          {slug && <>
            <Link className="z-btn" href={`/p/${encodeURIComponent(slug)}`}>Open public guide</Link>
            <button className="z-btn" onClick={() => void copyLink()}>Copy link</button>
            <button className="z-btn" disabled={busy} onClick={() => void changePublication(false)}>Make private</button>
          </>}
        </div>
      </div>
      {dirty && <p style={{ fontSize: 13 }}>Save your changes before publishing. Exports contain the last saved version.</p>}
      {message && <p role="status" style={{ fontSize: 13 }}>{message}</p>}
      {error && <p role="alert" style={{ color: "#b42318", fontSize: 13 }}>{error}</p>}
    </section>
  );
}
