import { Link } from "wouter";

type Level = "working" | "setup" | "unfinished";
interface Item { name: string; level: Level; note: string; href?: string }
const LABEL: Record<Level, [string, string]> = { working: ["Core API working", "z-pill-ok"], setup: ["Setup required", "z-pill-setup"], unfinished: ["Unfinished", "z-pill-todo"] };

const GROUPS: { title: string; items: Item[] }[] = [
  { title: "Accounts and workspaces", items: [
    { name: "Sign up (email and password)", level: "working", note: "Create an account and private workspace. Database and session configuration are present.", href: "/signup" },
    { name: "Sign in and sign out", level: "working", note: "Database-backed cookie sessions with real session revocation on sign out.", href: "/login" },
    { name: "Personal workspace per account", level: "working", note: "Created with the account at sign-up." },
    { name: "Team invitations", level: "unfinished", note: "No invitation flow exists." },
    { name: "Password reset", level: "unfinished", note: "Not implemented." } ] },
  { title: "Inputs: text, URL, file", items: [
    { name: "Source ingestion form", level: "setup", note: "Available inside the guide editor; depends on storage configuration." },
    { name: "Text, URL and file sources", level: "setup", note: "Accepted as sources; processing relies on the worker, which has no registered handlers." } ] },
  { title: "Workflows and review", items: [
    { name: "Create workflow (goal, start URL)", level: "working", note: "Metadata record only; used by New guide." },
    { name: "Workflow review", level: "setup", note: "Opens from a guide; needs a synthesized plan.", href: "/dashboard" },
    { name: "Plan synthesis and automated runs", level: "unfinished", note: "Needs an LLM provider and worker handlers." } ] },
  { title: "Guide editor and annotations", items: [
    { name: "Guide records (create, list, filter)", level: "working", note: "Dashboard search, status, folder and tag filters.", href: "/dashboard" },
    { name: "Step editor and version history", level: "working", note: "Add, reorder, edit and save steps. Restore revisions with protection against conflicting changes." },
    { name: "Style panel and annotations", level: "setup", note: "Imported controls need further contract reconciliation and validation." },
    { name: "AI draft generation", level: "unfinished", note: "Worker has no registered handlers." } ] },
  { title: "Publishing, sharing and exports", items: [
    { name: "Publish and read public guides", level: "working", note: "Publish a saved snapshot and copy a public reader link. Later unpublished edits do not change the shared snapshot." },
    { name: "Make a guide private", level: "working", note: "Revoke public access without deleting the guide or its history." },
    { name: "Markdown and JSON exports", level: "working", note: "Owners download saved guides; public Markdown downloads contain only the published snapshot." },
    { name: "Print / Save PDF", level: "working", note: "The public reader opens the browser's print / save-to-PDF dialog." },
    { name: "Password-protected sharing, server PDF and DOCX exports", level: "unfinished", note: "The imported libraries are not fully connected to working product flows." } ] },
  { title: "Analytics", items: [
    { name: "Reader sessions and completions", level: "working", note: "Real, anonymous public reader activity with duplicate protection and 7 / 30 / 90 day reports.", href: "/analytics" },
    { name: "Executive summary", level: "working", note: "A deterministic summary of the actual workspace and recorded reader activity. No AI service required." },
    { name: "Step drop-off and content gaps", level: "unfinished", note: "Step reach, search and rating telemetry are not yet instrumented. The reports explicitly identify unavailable data." } ] },
  { title: "Branding", items: [
    { name: "Saved workspace branding", level: "working", note: "Reloadable brand name, palette, font picks and legal footer apply to the public reader. White-labelling also removes Zipy branding; conflicting saves are rejected.", href: "/settings/branding" },
    { name: "Public header logo", level: "setup", note: "Connect an existing workspace-uploaded PNG, JPEG, WebP or GIF image key. Logo file upload is not yet available in this form." },
    { name: "Custom CSS, PDF, email and embed branding", level: "unfinished", note: "These surfaces are not enabled; custom CSS editing is disabled." } ] },
  { title: "Administration and audit", items: [
    { name: "Administration page", level: "setup", note: "Requires an admin role.", href: "/admin" },
    { name: "Workspace activity feed", level: "working", note: "Records new guide creation, saves, restores, publishing, revocation and branding updates. Historical actions are not reconstructed.", href: "/dashboard" } ] },
  { title: "Subscriptions and usage", items: [
    { name: "Usage and plan summary", level: "unfinished", note: "Billing contracts are missing; shown as unavailable on the dashboard." },
    { name: "Payments", level: "unfinished", note: "No payment provider is connected." } ] },
];

export default function Features() {
  return (
    <div>
      <h1 style={{ fontSize: 34, margin: "0 0 6px" }}>Feature inventory</h1>
      <p style={{ color: "var(--muted)", maxWidth: 640 }}>An honest map of what exists. Nothing here is marked finished unless its core API works end to end; most areas still depend on server setup.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0 24px" }}>
        {(Object.keys(LABEL) as Level[]).map((l) => <span key={l} className={`z-pill ${LABEL[l][1]}`}>{LABEL[l][0]}</span>)}
      </div>
      {GROUPS.map((g) => (
        <section key={g.title} style={{ marginBottom: 28 }} aria-label={g.title}>
          <h2 style={{ fontSize: 20 }}>{g.title}</h2>
          <div className="z-grid">
            {g.items.map((it) => (
              <div key={it.name} className="z-panel" data-testid={`card-feature-${it.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
                <span className={`z-pill ${LABEL[it.level][1]}`}>{LABEL[it.level][0]}</span>
                <h3 style={{ margin: "10px 0 4px", fontSize: 16 }}>{it.name}</h3>
                <p style={{ margin: 0, fontSize: 14, color: "var(--muted)" }}>{it.note}</p>
                {it.href && <p style={{ margin: "10px 0 0" }}><Link href={it.href}>Open</Link></p>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
