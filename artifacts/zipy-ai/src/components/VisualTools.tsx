import { useEffect, useMemo, useRef, useState, type PointerEvent as RPE } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetGuideVisuals, useChangeGuideVisuals, getGetGuideVisualsQueryKey, getListGuideSourcesQueryKey } from "@workspace/api-client-react";
import { arr, str, errMsg } from "./suite-util";
import "./WorkspaceSuite.css";
import "./VisualTools.css";

type Kind = "box" | "arrow" | "label" | "redact";
interface Mark { kind: Kind; x: number; y: number; w: number; h: number; text?: string }
const clamp = (n: number) => Math.min(1, Math.max(0, n));
const PENDING = ["pending", "active", "queued", "running", "processing"];

function MarkSvg({ m }: { m: Mark }) {
  if (m.kind === "redact") return <rect x={m.x} y={m.y} width={m.w} height={m.h} fill="#000" />;
  if (m.kind === "box") return <rect x={m.x} y={m.y} width={m.w} height={m.h} fill="none" stroke="#d9583b" strokeWidth={0.006} />;
  if (m.kind === "arrow") return <g stroke="#d9583b" strokeWidth={0.006} fill="none"><line x1={m.x} y1={m.y} x2={m.x + m.w} y2={m.y + m.h} /><circle cx={m.x + m.w} cy={m.y + m.h} r={0.012} fill="#d9583b" /></g>;
  return <g><rect x={m.x} y={m.y} width={m.w} height={m.h} fill="#fffdf8" stroke="#0f5c63" strokeWidth={0.004} /><text x={m.x + 0.006} y={m.y + Math.min(m.h, 0.04) * 0.8} fontSize={0.03} fill="#14272b">{m.text}</text></g>;
}

export default function VisualTools({ guideId }: { guideId: string }) {
  const qc = useQueryClient();
  const q = useGetGuideVisuals(guideId, { query: { queryKey: getGetGuideVisualsQueryKey(guideId), refetchOnMount: "always", refetchInterval: (query) => {
    const items = arr(obj0(query.state.data).items);
    return items.some((i) => PENDING.includes(str(i.status))) && query.state.dataUpdateCount < 120 ? 2500 : false; } } });
  const mut = useChangeGuideVisuals();
  const [url, setUrl] = useState(""); const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const [src, setSrc] = useState(""); const [tool, setTool] = useState<Kind>("box"); const [marks, setMarks] = useState<Mark[]>([]);
  const [label, setLabel] = useState(""); const [stepId, setStepId] = useState(""); const [alt, setAlt] = useState(""); const [ack, setAck] = useState(false);
  const [num, setNum] = useState({ x: "0.1", y: "0.1", w: "0.2", h: "0.1" });
  const [drag, setDrag] = useState<Mark | null>(null); const [saved, setSaved] = useState(false); const start = useRef<{ x: number; y: number } | null>(null);
  const items = useMemo(() => arr(q.data?.items), [q.data]);
  const steps = useMemo(() => arr(q.data?.steps), [q.data]);
  const version = typeof q.data?.version === "number" ? q.data.version : null;
  const ready = items.filter((i) => str(i.status) === "succeeded" && str(i.imageUrl));
  const current = ready.find((i) => str(i.jobId) === src);
  const wasPending = useRef(false);
  const anyPending = items.some((i) => PENDING.includes(str(i.status)));
  useEffect(() => { if (wasPending.current && !anyPending) void qc.invalidateQueries({ queryKey: getListGuideSourcesQueryKey(guideId) }); wasPending.current = anyPending; }, [anyPending, qc, guideId]);
  const pt = (e: RPE<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) }; };
  const build = (a: { x: number; y: number }, b: { x: number; y: number }): Mark => tool === "arrow" ? { kind: tool, x: a.x, y: a.y, w: Math.max(0, b.x - a.x), h: Math.max(0, b.y - a.y) } : { kind: tool, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), ...(tool === "label" ? { text: label } : {}) };
  const add = (m: Mark) => { if (m.w < 0.005 && m.h < 0.005) return; if (m.kind === "label" && !m.text?.trim()) { setErr("Enter label text first."); return; } setErr(""); setMarks((x) => [...x, m]); setSaved(false); };
  const onErr = (e: unknown) => { setErr(errMsg(e)); if ((e as { status?: number })?.status === 409) void q.refetch(); };
  const refresh = () => { void q.refetch(); void qc.invalidateQueries({ queryKey: getListGuideSourcesQueryKey(guideId) }); };
  const numMark = (): Mark => ({ kind: tool, x: clamp(+num.x), y: clamp(+num.y), w: clamp(+num.w), h: clamp(+num.h), ...(tool === "label" ? { text: label } : {}) });
  const capture = () => { setErr(""); setMsg(""); mut.mutate({ id: guideId, data: { action: "capture", url: url.trim() } }, { onSuccess: () => { setMsg("Capture queued. It appears below when the browser finishes."); setUrl(""); void q.refetch(); }, onError: onErr }); };
  const save = () => { if (!current || version === null) return; setErr(""); setMsg("");
    mut.mutate({ id: guideId, data: { action: "annotate", sourceJobId: src, stepId, expectedVersion: version, altText: alt.trim(), marks } }, { onSuccess: (r) => { setSaved(true); setAck(false); setMsg(`${str((r as Record<string, unknown>).message, "Annotation saved")} Version updated to ${str((r as Record<string, unknown>).version, "a new version")}. Reload the guide to see it in the editor.`); void q.refetch(); }, onError: onErr }); };
  const canSave = !!current && !!stepId && alt.trim().length > 0 && marks.length > 0 && ack && !mut.isPending && version !== null;
  return (
    <section className="zs-sec" aria-labelledby="zv-h" data-testid="visual-tools" style={{ marginTop: 16 }}>
      <h2 id="zv-h">Visual tools</h2>
      <p>Capture a public web page with a read-only browser (no sign-in, clicks or form submission), then annotate it by hand. Redaction is manual and must be reviewed by a person; Zipy does not detect personal data automatically.</p>
      <form className="zs-form" onSubmit={(e) => { e.preventDefault(); capture(); }}>
        <label>Public page URL (https)<input type="url" data-testid="browser-url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/help" /></label>
        <button className="z-btn z-btn-primary" data-testid="browser-capture" disabled={mut.isPending || !url.trim()}>Capture page</button>
      </form>
      <div><button type="button" className="z-btn" onClick={refresh}>Refresh sources and guide data</button></div>
      {q.isLoading ? <div className="zs-skel" aria-busy="true" /> : q.isError ? <p role="alert" className="zs-err">Could not load visuals: {errMsg(q.error)} <button type="button" className="z-btn" onClick={() => void q.refetch()}>Retry</button></p> : items.length === 0 ? <p>No captures yet.</p> : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>{items.map((i) => <li className="zs-row" key={str(i.jobId)}><div><strong>{str(i.name, "Capture")}</strong> <span className="zs-badge">{str(i.status)}</span>{str(i.error) && <><br /><small className="zs-err">{str(i.error)}</small></>}</div></li>)}</ul>
      )}
      {anyPending && <p role="status">Capturing... checking every 2.5 seconds, up to 120 times.</p>}
      <label style={{ display: "grid", gap: 4, fontWeight: 600, fontSize: 13 }}>Source image
        <select data-testid="visual-source" value={src} onChange={(e) => { setSrc(e.target.value); setMarks([]); setSaved(false); }}>
          <option value="">Choose a succeeded capture</option>{ready.map((i) => <option key={str(i.jobId)} value={str(i.jobId)}>{str(i.name, str(i.jobId))}</option>)}</select></label>
      {current && (<>
        <div className="zs-form" role="group" aria-label="Annotation tool">
          <label>Tool<select data-testid="annotation-tool" value={tool} onChange={(e) => setTool(e.target.value as Kind)}><option value="box">Box</option><option value="arrow">Arrow (top-left to bottom-right)</option><option value="label">Label</option><option value="redact">Redact (solid black, irreversible)</option></select></label>
          {tool === "label" && <label>Label text<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></label>}
        </div>
        <div className="zv-stage" data-testid="annotation-preview">
          <img src={str(current.imageUrl)} alt={alt.trim() || "Captured page to annotate"} draggable={false} />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Annotation drawing area. Drag to draw; or use the numeric fields below."
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = pt(e); setDrag(null); }}
            onPointerMove={(e) => { if (start.current) setDrag(build(start.current, pt(e))); }}
            onPointerUp={(e) => { if (start.current) { add(build(start.current, pt(e))); start.current = null; setDrag(null); } }}
            onPointerCancel={() => { start.current = null; setDrag(null); }}>
            {marks.map((m, i) => <MarkSvg key={i} m={m} />)}{drag && <MarkSvg m={drag} />}
          </svg>
        </div>
        <fieldset style={{ border: "1px solid var(--line)", borderRadius: 10 }}><legend>Keyboard and precise entry (0 to 1, fraction of image)</legend>
          <div className="zv-marks">{(["x", "y", "w", "h"] as const).map((k) => <label key={k} style={{ fontSize: 13, fontWeight: 600 }}>{k}<input type="number" min={0} max={1} step={0.01} value={num[k]} onChange={(e) => setNum({ ...num, [k]: e.target.value })} style={{ width: "100%", padding: 8, boxSizing: "border-box" }} /></label>)}</div>
          <button type="button" className="z-btn" style={{ marginTop: 8 }} onClick={() => add(numMark())}>Add mark from values</button></fieldset>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}><span>{marks.length} marks</span>
          <button type="button" className="z-btn" disabled={!marks.length} onClick={() => setMarks((m) => m.slice(0, -1))}>Undo</button>
          <button type="button" className="z-btn" disabled={!marks.length} onClick={() => setMarks([])}>Clear</button></div>
        <div className="zs-form">
          <label>Saved step<select data-testid="annotation-step" value={stepId} onChange={(e) => setStepId(e.target.value)}><option value="">Choose a saved step</option>{steps.map((s) => <option key={str(s.id)} value={str(s.id)}>{str(s.title, "(untitled step)")}</option>)}</select></label>
          <label>Alt text (required)<input data-testid="annotation-alt" value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={300} /></label>
        </div>
        <div className="zv-warn">Save your text changes in the editor first. Saving an annotation writes a new guide version; it does not discard unsaved text, but the editor does not reload automatically. Redaction is irreversible in the saved image and needs human review.</div>
        <label style={{ fontSize: 14 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have saved the current guide</label>
        <p style={{ fontSize: 13 }}>Server version: {version ?? "unknown"}. <button type="button" className="z-btn" onClick={refresh}>Refresh sources and guide</button></p>
        <div><button type="button" className="z-btn z-btn-primary" data-testid="annotation-save" disabled={!canSave} onClick={save}>{mut.isPending ? "Saving" : "Save annotated image"}</button></div>
      </>)}
      {err && <p role="alert" className="zs-err">{err}</p>}
      {msg && <p role="status" className="zs-ok">{msg}</p>}
      {saved && <button type="button" className="z-btn" onClick={() => { if (window.confirm("Reloading discards any unsaved text changes in the editor. Continue?")) window.location.reload(); }}>Reload guide</button>}
    </section>
  );
}
function obj0(v: unknown): Record<string, unknown> { return v && typeof v === "object" ? v as Record<string, unknown> : {}; }
