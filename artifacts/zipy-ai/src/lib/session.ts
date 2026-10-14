import { useCallback, useEffect, useState } from "react";

export interface SessionInfo { userId: string; workspaceId: string; role: string }
export type SessionState = { status: "loading" } | { status: "anon" } | { status: "authed"; session: SessionInfo } | { status: "error" };

export const appHref = (p: string) => import.meta.env.BASE_URL + p.replace(/^\//, "");

export function useSession() {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/session", { credentials: "include", headers: { accept: "application/json" } });
      if (r.status === 401) return setState({ status: "anon" });
      if (!r.ok) return setState({ status: "error" });
      setState({ status: "authed", session: (await r.json()) as SessionInfo });
    } catch { setState({ status: "error" }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const logout = useCallback(async () => {
    const response = await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    if (!response.ok) throw new Error("Sign out failed. Your session is still active; please try again.");
    setState({ status: "anon" });
    window.location.href = appHref("login");
  }, []);
  return { state, logout, reload: load };
}
