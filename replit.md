# Zipy AI

Imported screenshot-tutorial platform. This workspace ports the original app;
it does not redesign it or complete features absent from the import.

## Run and test

- Start `artifacts/zipy-ai: web` and `artifacts/api-server: API Server` using their managed Replit workflows.
- Do not run a root `pnpm dev`: the services need workflow-provided ports and routing.
- `pnpm --filter @workspace/scripts run test:zipy` runs the port's browser and API checks.
- `pnpm --filter @workspace/scripts run worker:zipy` is the preserved worker entrypoint. It requires its original storage/provider configuration and handler registration before processing jobs.

## Structure

- `artifacts/zipy-ai`: Vite + React; original inline-styled pages and components.
- `artifacts/api-server`: Express; preserved imported API handlers using native Fetch requests/responses.
- `lib/zipy`: original domain libraries, authentication, configuration and SQL schemas.
- `scripts/src/zipy-worker`: preserved background-worker sources.
- `scripts/imported-tests`: original tests, retained separately from migration smoke tests.
- `docs/imported`: original operations documentation.
- `.migration-backup`: unchanged source snapshot. Not included in publishing.

## Migration decisions

- Preserve original markup, system fonts, inline colors, routes and authentication. Do not apply Tailwind's reset to these screens.
- There was no imported root page, so `/` renders the existing `/dashboard` page.
- The server-only public-guide loader runs through `/api/public-guides/:slug`; its React page keeps the original rendering and access restrictions.
- HTTP handlers use one storage adapter to reconcile the import's byte-oriented interface with its object-oriented drivers. Workspace prefixes are applied consistently, and the selected local/S3 driver registers automatically. Preserve tenant isolation when changing either contract.
- Keep the imported PostgreSQL/storage contracts. No external database or file-storage service has been replaced. The empty development database was initialized with the supplied schemas, without seeding product data.
- Production schema changes use Replit's Publish flow. Never add startup-time or publish-build SQL migration hooks.

## Known limitations inherited from the import

- The import contains no sign-in/sign-up UI. Its existing authentication API works and remains protected.
- Several linked screens and API endpoints are absent, including `/guides/new`, list/detail endpoints needed by portions of the editor, and workspace activity/folder/tag APIs. Absent endpoints return explicit JSON 404 errors, not fabricated data.
- Some API imports reference functions their supplied domain libraries do not export (analytics aggregators, billing readers/catalog, template lookup, redaction helpers, and DOCX/image-pack barrel exports). They remain explicitly unavailable rather than being invented during the port. Unrelated handlers can still start.
- The supplied worker bootstrap registers no handlers. The imported ingestion implementation files are preserved, but provider credentials, storage configuration, automation dependencies and handler registration are still needed for full processing.
- The imported dashboard grid overflows narrow phone viewports. This migration preserves that layout rather than introducing an unrequested mobile redesign.
- Strict type checking has inherited issues and is outside this migration's scope. Browser/API tests and bundling are the migration checks.

## Credentials and data

`SESSION_SECRET` is supplied by Replit Secrets. The app uses `DATABASE_URL` at runtime. Original provider/storage variable names remain unchanged because they are server-only. Do not print credentials or save their values in source.

Migration tests create their own temporary account and workspace, verify the real authentication/session/job APIs, and delete only their generated data afterward.

Storage checks also create a workflow and guide through the authenticated APIs, list and read the stored guide, upload and read back image bytes, render a published guide, refuse restricted access and verify workspace isolation. Fixtures are removed after each run.

Local file storage is the imported development default. Configure the original S3-compatible driver for durable production uploads; local workspace files are not a substitute for persistent production storage.
