import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListGuideSources, useUploadGuideSource, getListGuideSourcesQueryKey } from "@workspace/api-client-react";
import "./MediaSources.css";

const MAX_SELECTED = 4;
const MAX_CHARS = 30000;
const MAX_BYTES = 16 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg,.mp4,.webm,.mov";
const isRunning = (s: string) => s === "pending" || s === "active";
const label = (s: string) => s === "succeeded" ? "Ready" : s === "pending" ? "Queued" : s === "active" ? "Processing" : s === "failed" ? "Failed" : s;

export default function MediaSources({ guideId, selected, onSelected, disabled }: { guideId: string; selected: string[]; onSelected: (ids: string[]) => void; disabled: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const list = useListGuideSources(guideId, { query: {
    queryKey: getListGuideSourcesQueryKey(guideId),
    refetchOnMount: "always",
    refetchInterval: query => {
      const items = query.state.data?.sources ?? [];
      const n = query.state.dataUpdateCount;
      return items.some(s => isRunning(s.status)) && n < 200 ? 2500 : false;
    },
  } });
  const upload = useUploadGuideSource();
  const sources = list.data?.sources ?? [];
  const chosen = sources.filter(s => selected.includes(s.jobId));
  const total = chosen.reduce((sum, s) => sum + (s.text?.length ?? 0), 0);

  function pick(files: FileList | null) {
    setError("");
    const f = files?.[0] ?? null;
    if (f && f.size > MAX_BYTES) { setError("That file is over 16 MB. Choose a smaller file."); setFile(null); if (input.current) input.current.value = ""; return; }
    setFile(f);
  }
  function send() {
    if (!file) return;
    setError("");
    upload.mutate({ id: guideId, data: { file } }, {
      onSuccess: () => { setFile(null); if (input.current) input.current.value = ""; void qc.invalidateQueries({ queryKey: getListGuideSourcesQueryKey(guideId) }); },
      onError: e => setError(e instanceof Error ? e.message : "Upload failed."),
    });
  }
  function toggle(id: string, on: boolean) { onSelected(on ? [...selected, id] : selected.filter(x => x !== id)); }

  return <section className="z-ms" aria-label="Source files">
    <h3>Source files</h3>
    <ul className="z-ms-help">
      <li>PDF: searchable text only. Scanned pages are not read (no OCR or layout analysis).</li>
      <li>DOCX, PPTX, XLSX: modern Office files, text extracted.</li>
      <li>PNG, JPEG, WebP: up to 8 MB per image.</li>
      <li>MP3, WAV, M4A, OGG audio and MP4, WebM, MOV video: speech transcription only, up to 3 minutes. Video visuals are not interpreted.</li>
      <li>Max 16 MB per file, 20 sources per guide. Images and audio use Replit AI credits; failed jobs are not retried automatically.</li>
    </ul>
    <div className="z-ms-bar">
      <label htmlFor="ms-file" style={{ fontSize: 13, fontWeight: 600 }}>Choose one file</label>
      <input id="ms-file" ref={input} type="file" accept={ACCEPT} data-testid="source-file-input" disabled={disabled || upload.isPending} onChange={e => pick(e.target.files)} />
      <button type="button" className="z-btn" data-testid="source-upload-button" disabled={disabled || upload.isPending || !file} onClick={send}>{upload.isPending ? "Uploading…" : "Upload source"}</button>
    </div>
    {error && <p className="z-err" role="alert">{error}</p>}
    {list.isError && <p className="z-err" role="alert">Sources could not load. <button type="button" className="z-btn" onClick={() => void list.refetch()}>Retry</button></p>}
    <div aria-live="polite">
      {list.isLoading ? <div className="z-ms-skel" aria-busy="true" /> : sources.length === 0 && !list.isError ? <p className="z-note">No source files yet. Uploaded files appear here after processing.</p> :
      <ul className="z-ms-list">{sources.map(s => {
        const on = selected.includes(s.jobId);
        const len = s.text?.length ?? 0;
        const ok = s.status === "succeeded" && len > 0;
        const blocked = !on && (!ok || selected.length >= MAX_SELECTED || total + len > MAX_CHARS);
        return <li key={s.jobId} className="z-ms-item" data-sel={on} data-testid={`source-item-${s.jobId}`}>
          <div className="z-ms-head">
            <label><input type="checkbox" data-testid={`source-select-${s.jobId}`} checked={on} disabled={disabled || blocked} onChange={e => toggle(s.jobId, e.target.checked)} /><span className="z-ms-name">{s.filename}</span></label>
            <span className={`z-pill ${s.status === "succeeded" ? "z-pill-ok" : s.status === "failed" ? "z-pill-setup" : "z-pill-todo"}`} role="status">{label(s.status)}</span>
          </div>
          <p className="z-ms-meta">{s.kind}{ok ? `, ${len.toLocaleString()} characters` : ""}{ok && !on && total + len > MAX_CHARS ? ", too long to add" : ""}</p>
          {s.status === "failed" && <p className="z-err" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>{s.error ?? "Processing failed."}</p>}
          {ok && <details><summary style={{ fontSize: 12, cursor: "pointer", marginTop: 8 }}>Text preview</summary><p className="z-ms-prev">{s.text!.slice(0, 600)}{len > 600 ? "…" : ""}</p></details>}
        </li>;
      })}</ul>}
    </div>
    <p className="z-ms-sum" data-testid="source-selected-total">{selected.length} of {MAX_SELECTED} selected, {total.toLocaleString()} of {MAX_CHARS.toLocaleString()} characters. Source notes plus extracted text must total {MAX_CHARS.toLocaleString()} or fewer.</p>
  </section>;
}
