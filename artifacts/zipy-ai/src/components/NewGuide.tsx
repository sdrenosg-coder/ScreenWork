import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Plus } from "lucide-react";

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => null)) as Record<string, any> | null;
  return { ok: r.ok, status: r.status, json: j };
}

export function NewGuideButton() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflowId = useRef<string | null>(null);
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fail = (r: { status: number; json: Record<string, any> | null }) =>
      r.status === 401 ? "Sign in to create guides." : (r.json?.message as string) ?? `Request failed (HTTP ${r.status}).`;
    try {
      if (workflowId.current === null) {
        const w = await post("/api/v1/workflows", { goal, ...(startUrl.trim() ? { startUrl: startUrl.trim() } : {}) });
        if (!w.ok) { setError(fail(w)); return; }
        workflowId.current = w.json?.workflow?.id ?? null;
        if (!workflowId.current) { setError("The server did not return a workflow id."); return; }
      }
      const g = await post("/api/v1/guides", { workflowId: workflowId.current, title });
      if (!g.ok) { setError(fail(g) + " The workflow was kept; retry to finish creating the guide."); return; }
      const id = g.json?.guide?.id;
      if (!id) { setError("The server did not return a guide id."); return; }
      setOpen(false);
      navigate(`/guides/${encodeURIComponent(id)}/edit`);
    } catch { setError("Could not reach the server."); } finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" className="z-btn z-btn-primary" data-testid="button-new-guide" onClick={() => setOpen(true)}><Plus size={16} aria-hidden />New guide</button>
      {open && (
        <div className="z-modal" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="z-dialog" role="dialog" aria-modal="true" aria-labelledby="ng-h">
            <form onSubmit={submit} data-testid="form-create-guide">
              <h2 id="ng-h" style={{ marginTop: 0 }}>New guide</h2>
              {error && <div role="alert" className="z-err" data-testid="text-create-error">{error}</div>}
              <label className="z-field">Title<input data-testid="input-guide-title" required maxLength={300} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              <label className="z-field">Goal<textarea data-testid="input-workflow-goal" required rows={3} maxLength={2000} value={goal} onChange={(e) => setGoal(e.target.value)} /><small>What should the finished guide teach?</small></label>
              <label className="z-field">Start URL (optional)<input data-testid="input-start-url" type="url" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder="https://" /></label>
              <p className="z-note">Start with an empty guide. In the editor, write your own steps or generate a draft from text or a public webpage. Preview AI suggestions before saving, then review the saved revision before publishing.</p>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
                <button type="button" className="z-btn" data-testid="button-cancel-guide" onClick={() => setOpen(false)}>Cancel</button>
                <button type="submit" className="z-btn z-btn-primary" disabled={busy} data-testid="button-submit-guide">{busy ? "Creating..." : "Create guide"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
