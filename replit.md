# Zipy AI

Screenshot-tutorial SaaS being reconstructed from the imported app. The account
and manual guide authoring/sharing core now works, with a redesigned interface.
Several inherited automation and commercial modules remain unfinished; do not
describe the whole product as production-ready.

## Run and test

- Start `artifacts/zipy-ai: web` and `artifacts/api-server: API Server` using their managed Replit workflows.
- Do not run a root `pnpm dev`: the services need workflow-provided ports and routing.
- `pnpm --filter @workspace/scripts run test:zipy` runs the port's browser and API checks.
- `pnpm --filter @workspace/scripts run worker:zipy` runs from the API server's working directory so both share the imported guide store. Eleven handlers register: source ingestion, content generation, read-only public browser capture and signed webhook delivery. Source binaries use private App Storage. Scanned PDFs up to three pages use visual extraction; audio/video is limited to three minutes, with video speech plus three timestamped visual samples rather than exhaustive frame analysis.

## Structure

- `artifacts/zipy-ai`: Vite + React; redesigned welcome, account entry, workspace shell and dashboard, with retained domain components.
- `artifacts/api-server`: Express; preserved imported API handlers using native Fetch requests/responses.
- `lib/zipy`: original domain libraries, authentication, configuration and SQL schemas.
- `scripts/src/zipy-worker`: preserved background-worker sources.
- `scripts/imported-tests`: original tests, retained separately from migration smoke tests.
- `docs/imported`: original operations documentation.
- `.migration-backup`: unchanged source snapshot. Not included in publishing.

## Migration decisions

- Preserve imported routes, data contracts, authentication and tenant safety. The UI may be redesigned; do not apply a global reset that breaks retained domain components.
- Signed-out workspace routes show the welcome/account entry. Authenticated `/` and `/dashboard` show the guide library. Public guides do not require sign-in.
- The server-only public-guide loader runs through `/api/public-guides/:slug`; its React page keeps the original rendering and access restrictions.
- HTTP handlers use one storage adapter to reconcile the import's byte-oriented interface with its object-oriented drivers. Workspace prefixes are applied consistently, and the selected local/S3 driver registers automatically. Preserve tenant isolation when changing either contract.
- Keep the imported PostgreSQL/storage contracts. No external database or file-storage service has been replaced. The empty development database was initialized with the supplied schemas, without seeding product data.
- Production schema changes use Replit's Publish flow. Never add startup-time or publish-build SQL migration hooks.

## Known limitations inherited from the import

- Sign-up/sign-in/sign-out, manual workflow/guide creation, guide read/save, revision restore, public snapshot publishing/revocation, and Markdown/JSON downloads now have working UI/API flows.
- Workspace activity, anonymous reader sessions/completions, usage/executive reports and persistent branding now have native UI/API flows. Branding saves use optimistic version checks. Public exports read only the published snapshot, and print/PDF uses the browser print dialog.
- Folder/tag management and some workflow detail/review endpoints remain absent. Absent endpoints return explicit JSON 404 errors, not fabricated data. The `/features` page distinguishes usable core flows from unfinished integrations.
- Inherited API and worker type-contract errors are repaired; the full workspace strict typecheck passes. This does not establish that every inherited product workflow is wired. Step drop-off/search/rating telemetry remains unavailable. Paid billing stays disabled without a provider.
- Text/public-page AI drafting has a verified UI → API → job → preview → versioned save → human approval → publication journey. Drafts never overwrite saved content automatically. Any later content revision requires renewed approval; stale versions and other-workspace jobs are rejected. Managed OpenAI uses Replit AI credits, independently of customer billing. Limits are three model jobs per workspace and thirty globally per rolling 24 hours.
- Source uploads and private previews are connected. PDF and DOCX extraction passed browser verification; audio/video and scanned-PDF paths still require representative end-to-end fixtures. Browser capture is public and read-only: it does not execute authenticated workflows. Development guide storage remains local/S3 by configuration, not automatically App Storage; a durable production guide store and processing service are still required before publishing.
- The homepage lists all 26 workflow groups with explicitly illustrative demos and distinguishes available core features from unfinished advanced functionality.
- The main shell, welcome, account entry and dashboard are responsive; other retained domain screens need further design work.
- Shared libraries, frontend, API and worker/automation sources pass the workspace-wide strict typecheck. Original API and remaining worker contract failures are resolved without suppressing strict checks.
- Actual server exports and PDF source extraction pass the core regression. The new suite regression verifies starter/custom templates, copied step IDs, discussions, invitation acceptance/reuse rejection, role restrictions, tenant switching/isolation, read-only API-key revocation, real signed webhook delivery and governance records/export. A capture/annotation regression verifies real Chromium capture, private image access, unchanged original source bytes, versioned annotation/redaction and exact-version human review before publication.
- `/workspace/templates`, `/workspace/team`, `/workspace/integrations` and `/workspace/governance` are real UI/API surfaces. Discussions are threads rather than live co-editing; templates are copies rather than inherited/snippet libraries; invitations are manual secure links, not sent email. Governance records administrator actions and does not automatically erase data or certify compliance. REST access currently lists guide metadata with read-only keys; SDKs and broad third-party adapters are not finished.
- Full advanced SaaS workflow completion remains agreed scope. Do not mark all 26 groups complete while automated execution, deep media alignment/fusion, live collaboration, template inheritance, advanced quality/security operations and production durability are unfinished.

## Credentials and data

`SESSION_SECRET` is supplied by Replit Secrets. The app uses `DATABASE_URL` at runtime. Original provider/storage variable names remain unchanged because they are server-only. Do not print credentials or save their values in source.

Migration tests create their own temporary account and workspace, verify the real authentication/session/job APIs, and delete only their generated data afterward.

Storage checks also create a workflow and guide through the authenticated APIs, list and read the stored guide, upload and read back image bytes, render a published guide, refuse restricted access and verify workspace isolation. Fixtures are removed after each run.

Local file storage is the imported development default. Configure the original S3-compatible driver for durable production uploads; local workspace files are not a substitute for persistent production storage.
