# Zipy AI

Screenshot-tutorial SaaS being reconstructed from the imported app. The account
and manual guide authoring/sharing core now works, with a redesigned interface.
Several inherited automation and commercial modules remain unfinished; do not
describe the whole product as production-ready.

## Run and test

- Start `artifacts/zipy-ai: web` and `artifacts/api-server: API Server` using their managed Replit workflows.
- Do not run a root `pnpm dev`: the services need workflow-provided ports and routing.
- `pnpm --filter @workspace/scripts run test:zipy` runs the port's browser and API checks.
- `pnpm --filter @workspace/scripts run worker:zipy` is the preserved worker entrypoint. It requires its original storage/provider configuration and handler registration before processing jobs.

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
- Some inherited API imports reference functions their supplied domain libraries do not export (advanced analytics aggregators, billing readers/catalog, template lookup, redaction helpers, and DOCX/image-pack barrel exports). Native analytics routes supersede the unfinished imported analytics endpoint; step drop-off/search/rating telemetry remains unavailable. Paid billing stays disabled without a provider.
- The supplied worker bootstrap registers no handlers. The imported ingestion implementation files are preserved, but provider credentials, storage configuration, automation dependencies and handler registration are still needed for full processing.
- The main shell, welcome, account entry and dashboard are responsive; other retained domain screens need further design work.
- Shared-library and frontend strict checks pass. The API server still has inherited type/contract errors in unfinished analytics, billing, annotation and redaction modules; bundling and the implemented core's browser/API checks pass.

## Credentials and data

`SESSION_SECRET` is supplied by Replit Secrets. The app uses `DATABASE_URL` at runtime. Original provider/storage variable names remain unchanged because they are server-only. Do not print credentials or save their values in source.

Migration tests create their own temporary account and workspace, verify the real authentication/session/job APIs, and delete only their generated data afterward.

Storage checks also create a workflow and guide through the authenticated APIs, list and read the stored guide, upload and read back image bytes, render a published guide, refuse restricted access and verify workspace isolation. Fixtures are removed after each run.

Local file storage is the imported development default. Configure the original S3-compatible driver for durable production uploads; local workspace files are not a substitute for persistent production storage.
