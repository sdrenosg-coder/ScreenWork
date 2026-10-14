import { useMemo, useState, useEffect, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetWorkspaceSuite, useChangeWorkspaceSuite, getGetWorkspaceSuiteQueryKey } from "@workspace/api-client-react";
import { arr, obj, str, errMsg, fmt } from "./suite-util";
import { appHref } from "../lib/session";
import "./WorkspaceSuite.css";

type Section = "templates" | "team" | "integrations" | "governance";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "templates", label: "Templates" }, { id: "team", label: "Team" }, { id: "integrations", label: "Integrations" }, { id: "governance", label: "Governance" },
];
const ROLES = ["viewer", "commenter", "editor", "reviewer", "admin"];
type Cmd = { action: string; [k: string]: unknown };

function useSuite(section: Section) {
  const qc = useQueryClient();
  const q = useGetWorkspaceSuite(section, { query: { queryKey: getGetWorkspaceSuiteQueryKey(section), refetchOnMount: "always", refetchInterval: (query) => (section === "integrations" && query.state.dataUpdateCount < 40 ? 10000 : false) } });
  const m = useChangeWorkspaceSuite();
  const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const run = (data: Cmd, onOk?: (r: Record<string, unknown>) => void, okMsg = "") => {
    setErr(""); setMsg("");
    m.mutate({ section, data }, { onSuccess: (r) => { if (okMsg) setMsg(okMsg); onOk?.(obj(r)); void qc.invalidateQueries({ queryKey: getGetWorkspaceSuiteQueryKey(section) }); }, onError: (e) => setErr(errMsg(e)) });
  };
  return { q, m, run, err, msg, setMsg, doc: obj(q.data), items: obj(obj(q.data).items) };
}
const Box = ({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) => (
  <section className="zs-sec" aria-labelledby={id}><h2 id={id}>{title}</h2>{intro && <p>{intro}</p>}{children}</section>
);
const Msgs = ({ err, msg }: { err: string; msg: string }) => <>{err && <p role="alert" className="zs-err">{err}</p>}{msg && <p role="status" className="zs-ok">{msg}</p>}</>;
const Secret = ({ label, value, onClear }: { label: string; value: string; onClear: () => void }) => {
  const [c, setC] = useState("");
  return (<div className="zs-secret" role="status"><strong>{label}</strong><code>{value}</code><span>Shown once. Copy it now; it cannot be retrieved later.</span>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="z-btn" onClick={() => { navigator.clipboard.writeText(value).then(() => setC("Copied."), () => setC("Copy failed; select the text manually.")); }}>Copy</button>
      <button type="button" className="z-btn" onClick={onClear}>I have saved it, clear</button></div>{c && <small>{c}</small>}</div>);
};

function Templates() {
  const s = useSuite("templates"); const [, nav] = useLocation();
  const list = arr(s.q.data?.items);
  const [titles, setTitles] = useState<Record<string, string>>({});
  return (<Box id="zs-t" title="Template library" intro="Start a guide from a starter or a template saved from your own guides.">
    <Msgs err={s.err} msg={s.msg} />
    {s.q.isLoading ? <div className="zs-skel" /> : s.q.isError ? <p role="alert" className="zs-err">{errMsg(s.q.error)}</p> : list.length === 0 ? <p>No templates are available.</p> : list.map((t) => { const id = str(t.id); const steps = Array.isArray(t.steps) ? t.steps.length : 0; return (
      <div className="zs-row" key={id}><div><strong>{str(t.title)}</strong> {t.starter === true && <span className="zs-badge">starter</span>}<br /><small>{str(t.description)} {steps} steps</small></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input aria-label={`Title for new guide from ${str(t.title)}`} placeholder="Guide title (optional)" value={titles[id] ?? ""} onChange={(e) => setTitles({ ...titles, [id]: e.target.value })} style={{ padding: 8, border: "1px solid #cfc6b2", borderRadius: 9 }} />
          <button type="button" className="z-btn z-btn-primary" data-testid={`template-use-${id}`} disabled={s.m.isPending} onClick={() => s.run({ action: "use", templateId: id, ...(titles[id]?.trim() ? { title: titles[id].trim() } : {}) }, (r) => { const gid = str(r.id); if (gid) nav(`/guides/${encodeURIComponent(gid)}/edit`); else s.setMsg("Created, but no guide id returned."); })}>Use template</button>
          {t.starter !== true && <button type="button" className="z-btn zs-danger" disabled={s.m.isPending} onClick={() => { if (window.confirm("Delete this template?")) s.run({ action: "delete", templateId: id }, undefined, "Template deleted."); }}>Delete</button>}
        </div></div>); })}
  </Box>);
}

function Team() {
  const s = useSuite("team");
  const d = s.doc; const members = arr(d.items); const invs = arr(d.invitations); const wss = arr(d.workspaces);
  const myRole = str(d.role); const me = str(d.currentUserId); const wid = str(d.workspaceId);
  const [email, setEmail] = useState(""); const [role, setRole] = useState("editor");
  const [link, setLink] = useState(""); const [paste, setPaste] = useState("");
  const [acc, setAcc] = useState<{ workspaceId: string; invitationId: string; token: string } | null>(null);
  const parse = (raw: string) => { try { const h = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : raw; const p = new URLSearchParams(h); const a = { workspaceId: p.get("workspaceId") ?? "", invitationId: p.get("invitationId") ?? "", token: p.get("token") ?? "" }; return a.workspaceId && a.invitationId && a.token ? a : null; } catch { return null; } };
  useEffect(() => { const a = parse(window.location.hash); if (a) { setAcc(a); history.replaceState(null, "", window.location.pathname + window.location.search); } }, []);
  const reload = () => window.location.reload();
  const isAdmin = myRole === "admin" || myRole === "owner";
  return (<>
    <Box id="zs-inv" title="Invite a teammate" intro="No email is sent. Create a secure link and share it yourself; it works only for the invited email address.">
      <form className="zs-form" onSubmit={(e) => { e.preventDefault(); s.run({ action: "invite", email: email.trim(), role }, (r) => { setLink(`${window.location.origin}${appHref("/workspace/team")}#workspaceId=${encodeURIComponent(str(r.workspaceId))}&invitationId=${encodeURIComponent(str(r.invitationId))}&token=${encodeURIComponent(str(r.token))}`); setEmail(""); }); }}>
        <label>Email<input type="email" required data-testid="invite-email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Role<select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
        <button className="z-btn z-btn-primary" data-testid="invite-submit" disabled={s.m.isPending || !email.trim()}>Create invite link</button>
      </form>
      {link && <Secret label="Invite link" value={link} onClear={() => setLink("")} />}
      <Msgs err={s.err} msg={s.msg} />
    </Box>
    <Box id="zs-acc" title="Accept an invitation" intro="You must be signed in as the invited email. Acceptance is always explicit.">
      {acc ? <div className="zs-secret"><span>Invitation for workspace {acc.workspaceId} is ready.</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="z-btn z-btn-primary" data-testid="invitation-accept" disabled={s.m.isPending} onClick={() => s.run({ action: "accept", ...acc }, () => { setAcc(null); reload(); })}>Accept invitation</button>
          <button type="button" className="z-btn" onClick={() => setAcc(null)}>Dismiss</button></div></div> : (
        <form className="zs-form" onSubmit={(e) => { e.preventDefault(); const a = parse(paste); if (a) { setAcc(a); setPaste(""); } else s.setMsg("That link is missing workspace, invitation or token details."); }}>
          <label>Paste invite link<input value={paste} onChange={(e) => setPaste(e.target.value)} autoComplete="off" /></label>
          <button className="z-btn" disabled={!paste.trim()}>Review invitation</button></form>)}
    </Box>
    <Box id="zs-ws" title="Workspaces">
      {s.q.isLoading ? <div className="zs-skel" /> : wss.length === 0 ? <p>No other workspaces.</p> : wss.map((w) => (
        <div className="zs-row" key={str(w.id)}><div><strong>{str(w.name)}</strong> <span className="zs-badge">{str(w.role)}</span>{str(w.id) === wid && <span className="zs-badge"> current</span>}</div>
          {str(w.id) !== wid && <button type="button" className="z-btn" onClick={() => s.run({ action: "switch", workspaceId: str(w.id) }, reload)}>Switch</button>}</div>))}
    </Box>
    <Box id="zs-mem" title="Members">
      {s.q.isError ? <p role="alert" className="zs-err">{errMsg(s.q.error)} <button type="button" className="z-btn" onClick={() => void s.q.refetch()}>Retry</button></p> : s.q.isLoading ? <div className="zs-skel" /> : members.length === 0 ? <p>No members listed.</p> : members.map((u) => { const id = str(u.id); const owner = str(u.role) === "owner"; const self = id === me; return (
        <div className="zs-row" key={id}><div><strong>{str(u.name, str(u.email))}</strong> <small>{str(u.email)}</small></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isAdmin && !owner && !self ? <>
              <select aria-label={`Role for ${str(u.email)}`} value={str(u.role)} onChange={(e) => s.run({ action: "role", userId: id, role: e.target.value }, undefined, "Role updated.")}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
              <button type="button" className="z-btn zs-danger" onClick={() => { if (window.confirm("Remove this member?")) s.run({ action: "remove", userId: id }, undefined, "Member removed."); }}>Remove</button></> : <span className="zs-badge">{str(u.role)}{self ? " (you)" : ""}</span>}
          </div></div>); })}
    </Box>
    <Box id="zs-pend" title="Pending invitations">
      {invs.length === 0 ? <p>No invitations.</p> : invs.map((i) => (
        <div className="zs-row" key={str(i.id)}><div>{str(i.email)} <span className="zs-badge">{str(i.role)}</span> <span className="zs-badge">{str(i.status)}</span><br /><small>Expires {fmt(i.expiresAt)}</small></div>
          {isAdmin && <button type="button" className="z-btn" onClick={() => s.run({ action: "revoke", invitationId: str(i.id) }, undefined, "Invitation revoked.")}>Revoke</button>}</div>))}
    </Box></>);
}

function Integrations() {
  const s = useSuite("integrations");
  const d = s.doc; const hooks = arr(d.hooks ?? obj(d.items).hooks); const keys = arr(d.keys ?? obj(d.items).keys); const dels = arr(d.deliveries ?? obj(d.items).deliveries);
  const apiBase = str(d.apiBase ?? obj(d.items).apiBase, "/api/external/guides");
  const [kn, setKn] = useState(""); const [hn, setHn] = useState(""); const [hu, setHu] = useState("");
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  useEffect(() => () => setSecret(null), []);
  return (<>
    <Box id="zs-k" title="Read-only API keys" intro={`Send as Authorization: Bearer <key> to GET ${apiBase}. Keys are read-only.`}>
      <form className="zs-form" onSubmit={(e) => { e.preventDefault(); s.run({ action: "create-key", name: kn.trim() }, (r) => { setSecret({ label: "API key", value: str(r.token) }); setKn(""); }); }}>
        <label>Key name<input value={kn} onChange={(e) => setKn(e.target.value)} required /></label>
        <button className="z-btn z-btn-primary" data-testid="create-api-key" disabled={s.m.isPending || !kn.trim()}>Create key</button></form>
      {secret?.label === "API key" && <Secret {...secret} onClear={() => setSecret(null)} />}
      {keys.length === 0 ? <p>No API keys.</p> : keys.map((k) => <div className="zs-row" key={str(k.id)}><div><strong>{str(k.name)}</strong><br /><small>Created {fmt(k.createdAt)}</small></div><button type="button" className="z-btn zs-danger" onClick={() => { if (window.confirm("Revoke this key? Clients using it will fail.")) s.run({ action: "revoke-key", id: str(k.id) }, undefined, "Key revoked."); }}>Revoke</button></div>)}
    </Box>
    <Box id="zs-h" title="Webhooks" intro="Each delivery is a signed POST. X-Zipy-Signature is sha256 HMAC (hex) of the X-Zipy-Timestamp value, a dot, and the raw body, keyed with the endpoint secret. Reject stale timestamps. HTTPS URLs only.">
      <form className="zs-form" onSubmit={(e) => { e.preventDefault(); s.run({ action: "hook", name: hn.trim(), url: hu.trim() }, (r) => { setSecret({ label: "Signing secret", value: str(r.secret) }); setHn(""); setHu(""); }); }}>
        <label>Name<input value={hn} onChange={(e) => setHn(e.target.value)} required /></label>
        <label>HTTPS URL<input type="url" pattern="https://.*" data-testid="webhook-url" value={hu} onChange={(e) => setHu(e.target.value)} required /></label>
        <button className="z-btn z-btn-primary" data-testid="webhook-submit" disabled={s.m.isPending || !hn.trim() || !hu.trim()}>Add webhook</button></form>
      {secret?.label === "Signing secret" && <Secret {...secret} onClear={() => setSecret(null)} />}
      {hooks.length === 0 ? <p>No webhooks configured.</p> : hooks.map((h) => <div className="zs-row" key={str(h.id)}><div><strong>{str(h.name)}</strong> <span className="zs-badge">{h.enabled === false ? "disabled" : "enabled"}</span><br /><small>{str(h.url)}</small></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button type="button" className="z-btn" disabled={s.m.isPending} onClick={() => s.run({ action: "test-hook", id: str(h.id) }, undefined, "Test delivery queued. Check the log for the actual result.")}>Send test</button>
          <button type="button" className="z-btn zs-danger" onClick={() => { if (window.confirm("Delete this webhook?")) s.run({ action: "delete-hook", id: str(h.id) }, undefined, "Webhook deleted."); }}>Delete</button></div></div>)}
      <Msgs err={s.err} msg={s.msg} />
    </Box>
    <Box id="zs-d" title="Delivery log" intro="Only recorded delivery results are shown. A webhook is verified only once a delivery succeeds.">
      {s.q.isError ? <p role="alert" className="zs-err">{errMsg(s.q.error)}</p> : dels.length === 0 ? <p>No deliveries recorded yet.</p> : dels.map((x) => <div className="zs-row" key={str(x.id)}><div><span className="zs-badge">{str(x.status)}</span> {str(x.kind)} {str(x.httpStatus) && `HTTP ${str(x.httpStatus)}`}<br /><small>{fmt(x.at)} {str(x.error)}</small></div></div>)}
    </Box></>);
}

function Governance() {
  const s = useSuite("governance");
  const d = s.doc; const root = obj(d.items); const activity = arr(Array.isArray(d.items) ? d.items : (d.activity ?? root.activity));
  const policy = obj(d.policy ?? root.policy); const reqs = arr(d.requests ?? root.requests);
  const [days, setDays] = useState(""); const [type, setType] = useState("export"); const [subject, setSubject] = useState(""); const [details, setDetails] = useState("");
  const [res, setRes] = useState<Record<string, string>>({});
  const doExport = () => s.run({ action: "export" }, (r) => {
    if (!Array.isArray(r.items)) { s.setMsg("Export returned no data."); return; }
    const blob = new Blob([JSON.stringify({ items: r.items, workspaceId: r.workspaceId, exportedAt: r.exportedAt }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "zipy-workspace-export.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "Export downloaded.");
  return (<>
    <Box id="zs-pol" title="Retention policy" intro="Operational controls only. This is not a SOC 2 or GDPR certification. Setting a period records a review policy; nothing is deleted automatically.">
      <p>Current: {policy.retentionDays == null ? "no retention period set" : `${str(policy.retentionDays)} days`} {str(policy.enforcement) && `(${str(policy.enforcement)})`}</p>
      <form className="zs-form" onSubmit={(e) => { e.preventDefault(); const n = days.trim() === "" ? null : Number(days); if (n !== null && (!Number.isInteger(n) || n < 1 || n > 3650)) return; s.run({ action: "policy", retentionDays: n }, undefined, "Policy saved."); }}>
        <label>Retention days (1-3650, blank clears)<input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></label>
        <button className="z-btn" disabled={s.m.isPending}>Save policy</button></form>
      <button type="button" className="z-btn" data-testid="governance-export" disabled={s.m.isPending} onClick={doExport}>Export workspace data (JSON)</button>
      <Msgs err={s.err} msg={s.msg} />
    </Box>
    <Box id="zs-rq" title="Data requests" intro="Resolving records what an admin did. It does not perform the deletion or export itself.">
      <form className="zs-form" onSubmit={(e) => { e.preventDefault(); s.run({ action: "request", type, subject: subject.trim(), details: details.trim() }, () => { setSubject(""); setDetails(""); }, "Request recorded."); }}>
        <label>Type<select value={type} onChange={(e) => setType(e.target.value)}><option>export</option><option>erasure</option><option>correction</option></select></label>
        <label>Subject<input value={subject} onChange={(e) => setSubject(e.target.value)} required /></label>
        <label>Details<textarea rows={2} value={details} onChange={(e) => setDetails(e.target.value)} /></label>
        <button className="z-btn" disabled={s.m.isPending || !subject.trim()}>Log request</button></form>
      {reqs.length === 0 ? <p>No requests.</p> : reqs.map((r) => { const id = str(r.id); const open = str(r.status) !== "resolved"; return (
        <div className="zs-row" key={id}><div><span className="zs-badge">{str(r.type)}</span> <span className="zs-badge">{str(r.status)}</span> <strong>{str(r.subject)}</strong><br /><small>{str(r.details)} {str(r.resolution) && `Resolution: ${str(r.resolution)}`}</small></div>
          {open && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><input aria-label="Resolution note" placeholder="What was done" value={res[id] ?? ""} onChange={(e) => setRes({ ...res, [id]: e.target.value })} style={{ padding: 8, border: "1px solid #cfc6b2", borderRadius: 9 }} />
            <button type="button" className="z-btn" disabled={!(res[id] ?? "").trim()} onClick={() => s.run({ action: "resolve-request", id, resolution: res[id].trim() }, undefined, "Resolution recorded.")}>Record resolution</button></div>}</div>); })}
    </Box>
    <Box id="zs-act" title="Activity">
      {s.q.isLoading ? <div className="zs-skel" /> : s.q.isError ? <p role="alert" className="zs-err">{errMsg(s.q.error)}</p> : activity.length === 0 ? <p>No activity recorded.</p> : activity.slice(0, 100).map((a, i) => <div className="zs-row" key={str(a.id, String(i))}><div>{str(a.action ?? a.type ?? a.summary, "event")} <small>{str(a.actorId ?? a.userId)} {fmt(a.at ?? a.createdAt)}</small></div></div>)}
    </Box></>);
}

export default function WorkspaceSuite({ section }: { section: string }) {
  const sec = (SECTIONS.find((x) => x.id === section)?.id ?? null) as Section | null;
  const label = SECTIONS.find((x) => x.id === sec)?.label;
  const body = useMemo(() => sec === "templates" ? <Templates /> : sec === "team" ? <Team /> : sec === "integrations" ? <Integrations /> : sec === "governance" ? <Governance /> : <p role="alert">Unknown workspace section.</p>, [sec]);
  return (<div className="zs" data-testid="workspace-suite" aria-labelledby="zs-title"><h1 id="zs-title">Workspace: {label ?? "Not found"}</h1>
    <nav className="zs-tabs" aria-label="Workspace sections">{SECTIONS.map((x) => <Link key={x.id} href={`/workspace/${x.id}`} aria-current={x.id === sec ? "page" : undefined}>{x.label}</Link>)}</nav>{body}</div>);
}
