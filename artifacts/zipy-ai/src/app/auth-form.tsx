import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { appHref } from "../lib/session";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const signup = mode === "signup";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = signup ? { email, password, displayName, workspaceName } : { email, password };
      const r = await fetch(`/api/auth/${mode}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) { window.location.href = appHref("dashboard"); return; }
      const j = (await r.json().catch(() => null)) as { message?: string } | null;
      setError(j?.message ?? `Request failed (HTTP ${r.status}).`);
    } catch { setError("Could not reach the server. Check your connection and try again."); }
    setBusy(false);
  }

  return (
    <div className="z-auth">
      <div className="z-auth-art">
        <span className="z-display" style={{ fontSize: 26, fontWeight: 700 }}>Zipy</span>
        <div>
          <h2 style={{ fontSize: 40, lineHeight: 1.05, margin: "0 0 14px" }}>Turn a process into a guide your team can follow.</h2>
          <p style={{ color: "#b9d3cf", maxWidth: 420 }}>Capture sources, review the steps, annotate screenshots and publish a reader-friendly page.</p>
        </div>
        <span style={{ fontSize: 12, color: "#8fb3ae" }}>AI-generated content is labelled until a human approves it.</span>
      </div>
      <div className="z-auth-form">
        <form onSubmit={submit} data-testid={signup ? "form-signup" : "form-signin"} aria-labelledby="auth-h">
          <h1 id="auth-h" style={{ fontSize: 30, margin: "0 0 6px" }}>{signup ? "Create your workspace" : "Welcome back"}</h1>
          <p style={{ color: "var(--muted)", margin: "0 0 22px" }}>{signup ? "Your account comes with a personal workspace." : "Sign in to your workspace."}</p>
          {error && <div role="alert" className="z-err" data-testid="text-auth-error">{error}</div>}
          {signup && (
            <>
              <label className="z-field">Display name<input data-testid="input-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" /></label>
              <label className="z-field">Workspace name<input data-testid="input-workspace-name" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} /></label>
            </>
          )}
          <label className="z-field">Email<input data-testid="input-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label className="z-field">Password
            <input data-testid="input-password" type="password" required minLength={signup ? 12 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? "new-password" : "current-password"} />
            {signup && <small>At least 12 characters.</small>}
          </label>
          <button type="submit" className="z-btn z-btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy} data-testid="button-submit-auth">{busy ? "Please wait..." : signup ? "Create account" : "Sign in"}</button>
          <p style={{ fontSize: 14, marginTop: 18 }}>
            {signup ? <>Already have an account? <Link href="/login" data-testid="link-to-login">Sign in</Link></> : <>New to Zipy? <Link href="/signup" data-testid="link-to-signup">Create an account</Link></>}
          </p>
          {!signup && <p className="z-note">Password reset is not available yet.</p>}
        </form>
      </div>
    </div>
  );
}
