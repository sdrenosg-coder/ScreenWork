import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetGuideDiscussion, useChangeGuideDiscussion, useChangeWorkspaceSuite, getGetGuideDiscussionQueryKey, getGetWorkspaceSuiteQueryKey } from "@workspace/api-client-react";
import { useSession } from "../lib/session";
import { arr, str, errMsg, fmt } from "./suite-util";
import "./WorkspaceSuite.css";

export default function GuideDiscussion({ guideId }: { guideId: string }) {
  const qc = useQueryClient();
  const { state } = useSession();
  const me = state.status === "authed" ? state.session : null;
  const q = useGetGuideDiscussion(guideId, { query: { queryKey: getGetGuideDiscussionQueryKey(guideId), refetchOnMount: "always", refetchInterval: (query) => (query.state.dataUpdateCount < 40 ? 15000 : false) } });
  const mut = useChangeGuideDiscussion();
  const tpl = useChangeWorkspaceSuite();
  const [text, setText] = useState("");
  const [stepId, setStepId] = useState("");
  const [showResolved, setShowResolved] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [tTitle, setTTitle] = useState("");
  const [tDesc, setTDesc] = useState("");
  const items = useMemo(() => arr(q.data?.items), [q.data]);
  const version = q.data ? str(q.data.guideVersion) : "";
  const canModerate = me?.role === "admin" || me?.role === "owner";
  const run = (data: { action: string; [k: string]: unknown }, done?: () => void) => {
    setErr(""); setMsg("");
    mut.mutate({ id: guideId, data }, { onSuccess: () => { done?.(); void qc.invalidateQueries({ queryKey: getGetGuideDiscussionQueryKey(guideId) }); }, onError: (e) => setErr(errMsg(e)) });
  };
  const shown = items.filter((c) => showResolved || c.resolved !== true);
  return (
    <section className="zs-sec" aria-labelledby="zd-h" data-testid="guide-discussion" style={{ marginTop: 16 }}>
      <h2 id="zd-h">Discussion{version && ` on version ${version}`}</h2>
      <p>Comments refresh every 15 seconds for a limited time; reload the page to resume.</p>
      <form className="zs-form" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; run({ action: "comment", text: text.trim(), ...(stepId.trim() ? { stepId: stepId.trim() } : {}) }, () => setText("")); }}>
        <label>New comment<textarea data-testid="comment-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} /></label>
        <label>Step id (optional)<input value={stepId} onChange={(e) => setStepId(e.target.value)} /></label>
        <button className="z-btn z-btn-primary" data-testid="comment-submit" disabled={mut.isPending || !text.trim()}>{mut.isPending ? "Posting" : "Post comment"}</button>
      </form>
      <label style={{ fontSize: 14 }}><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved threads</label>
      {q.isLoading ? <div className="zs-skel" aria-busy="true" /> : q.isError ? (
        <div role="alert" className="zs-err">Could not load comments: {errMsg(q.error)} <button type="button" className="z-btn" onClick={() => void q.refetch()}>Retry</button></div>
      ) : shown.length === 0 ? <p>{items.length ? "All threads are resolved and hidden." : "No comments on this guide yet."}</p> : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {shown.map((c) => { const id = str(c.id); const mine = me && str(c.authorId) === me.userId; return (
            <li key={id} className="zs-row" data-testid={`comment-${id}`}>
              <div><strong>{str(c.authorId, "unknown")}</strong> <small>{fmt(c.createdAt)}</small>{str(c.stepId) && <span className="zs-badge"> step {str(c.stepId)}</span>}{c.resolved === true && <span className="zs-badge"> resolved</span>}<br />{str(c.text)}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="z-btn" disabled={mut.isPending} onClick={() => run({ action: "resolve", id, resolved: c.resolved !== true })}>{c.resolved === true ? "Reopen" : "Resolve"}</button>
                {(mine || canModerate) && <button type="button" className="z-btn zs-danger" disabled={mut.isPending} onClick={() => { if (window.confirm("Delete this comment?")) run({ action: "delete", id }); }}>Delete</button>}
              </div>
            </li>); })}
        </ul>
      )}
      {err && <p role="alert" className="zs-err">{err}</p>}
      <hr style={{ border: 0, borderTop: "1px solid var(--line)", width: "100%" }} />
      <h3 style={{ margin: 0, fontSize: 15 }}>Save this guide as a template</h3>
      <form className="zs-form" onSubmit={(e) => { e.preventDefault(); setErr(""); setMsg(""); tpl.mutate({ section: "templates", data: { action: "save", guideId, title: tTitle.trim(), ...(tDesc.trim() ? { description: tDesc.trim() } : {}) } }, { onSuccess: () => { setMsg("Template saved."); setTTitle(""); setTDesc(""); void qc.invalidateQueries({ queryKey: getGetWorkspaceSuiteQueryKey("templates") }); }, onError: (x) => setErr(errMsg(x)) }); }}>
        <label>Template title<input value={tTitle} onChange={(e) => setTTitle(e.target.value)} required /></label>
        <label>Description<input value={tDesc} onChange={(e) => setTDesc(e.target.value)} /></label>
        <button className="z-btn" data-testid="template-save" disabled={tpl.isPending || !tTitle.trim()}>Save template</button>
      </form>
      {msg && <p role="status" className="zs-ok">{msg}</p>}
    </section>
  );
}
