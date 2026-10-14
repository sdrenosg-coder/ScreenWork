/**
 * GET /api/styles/[id]
 * PUT /api/styles/[id]
 *
 * Reviewer-facing surface for a guide's style profile — the single document
 * that decides tone, reading level, audience, industry, personalization,
 * language, branding, SEO, terminology and brand voice for every content
 * layer. It is the persistence layer for `packages/content/src/styleProfile.ts`
 * and it is what the `StylePanel` component (batch 2) reads and writes.
 *
 * Idempotency and mutual exclusion:
 *   - GET always returns a profile. When the guide has no stored profile yet,
 *     a syntactically valid empty profile is returned with `state: "empty"`.
 *     A genuinely non-existent guide (or a guide owned by another workspace)
 *     is a 404 — decided by reading the guide record, not by the profile's
 *     absence. This is the same authorization boundary used by
 *     `/api/guides/[id]/generate`.
 *   - PUT replaces the entire profile. The body must be a full profile
 *     shape (unknown fields are rejected with a descriptive 400 field path);
 *     partial updates are not supported here, because the profile is a
 *     coherent document that a stale merge would corrupt. The `PUT` request
 *     may set `updatedBy`/`updatedAt`, in which case the values are
 *     overwritten by the server; they are server-owned fields.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; returns 503 config_error
 *     otherwise.
 *   - Authenticates via the shared session module. GET requires
 *     `PERMISSIONS.workspace_read`; PUT requires `PERMISSIONS.guide_update`.
 *     A caller without it gets 403 via `toAuthzFailure`.
 *   - `[id]` is the guide UUID. A malformed id is a 400 before any
 *     upstream call.
 *
 * Storage layout (workspace-scoped by `forWorkspace`):
 *   - `styles/{guideId}.json`         → the current style profile
 *   - `styles/{guideId}.meta.json`    → the profile's run metadata (hash,
 *                                        version, updatedAt, updatedBy)
 *
 * What this route does NOT do:
 *   - Run brand-voice training. `packages/content/src/brandVoice.ts` builds a
 *     `BrandVoiceProfile` from uploaded guidelines/examples; the caller
 *     obtains that profile elsewhere (a later batch's upload surface) and
 *     stores it in the `brandVoice` field of the profile.
 *   - Validate terminology internals beyond structural shape. The
 *     `terminology` field is rehydrated and validated by its own module
 *     when the content pipeline reads it; this route accepts the object and
 *     stores it verbatim, but requires it to be an object.
 *   - Touch other resources. Editing the style does not enqueue a
 *     regeneration. A subsequent POST to `/api/guides/[id]/generate`
 *     (`force: true`) picks up the new profile; a scheduled re-generation
 *     (a later phase) can be configured to do the same.
 *
 * External setup: none for this route. It reads and writes the workspace's
 * object store (S3 or local, selected by STORAGE_DRIVER) through the shared
 * `forWorkspace` helper, and requires DATABASE_URL only for session lookup.
 */

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { forWorkspace } from "@zipy/storage/objectStore";

import {
  StyleProfileError,
  validateStyleProfile,
  type StyleProfile,
} from "@zipy/content/styleProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Workspace-relative storage key prefix for style profiles. */
const STYLES_PREFIX = "styles";

/** Workspace-relative storage key prefix for guide records (used for authz). */
const GUIDES_PREFIX = "guides";

/* -------------------------------------------------------------------------- */
/* Storage helpers                                                             */
/* -------------------------------------------------------------------------- */

type StoreLike = {
  readonly get: (key: string) => Promise<Buffer | null>;
  readonly put: (
    key: string,
    data: Buffer,
    opts?: {
      readonly contentType?: string;
      readonly contentLength?: number;
      readonly metadata?: Readonly<Record<string, string>>;
    },
  ) => Promise<void>;
};

function styleKey(guideId: string): string {
  return `${STYLES_PREFIX}/${guideId}.json`;
}

function styleMetaKey(guideId: string): string {
  return `${STYLES_PREFIX}/${guideId}.meta.json`;
}

function guideKey(guideId: string): string {
  return `${GUIDES_PREFIX}/${guideId}.json`;
}

async function readJsonOrNull(
  store: StoreLike,
  key: string,
): Promise<unknown | null> {
  let bytes: Buffer | null;
  try {
    bytes = await store.get(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(message)) return null;
    throw error;
  }
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Stored artifact ${key} is not valid JSON.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Response building                                                           */
/* -------------------------------------------------------------------------- */

type StyleStateDto = "empty" | "configured" | "corrupt";

interface StyleMetaRecord {
  readonly version?: unknown;
  readonly contentHash?: unknown;
  readonly updatedAt?: unknown;
  readonly updatedBy?: unknown;
}

interface StyleResponse {
  readonly guideId: string;
  readonly workspaceId: string;
  readonly state: StyleStateDto;
  readonly profile: StyleProfile;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly contentHash: string | null;
  readonly message: string;
  readonly notes: readonly string[];
}

function normaliseVersion(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  return 0;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function buildNotes(
  profile: StyleProfile,
  state: StyleStateDto,
): readonly string[] {
  const notes: string[] = [];
  if (state === "empty") {
    notes.push(
      "No style profile is stored for this guide yet. The default profile is empty; every content layer will use its own defaults.",
    );
    return notes;
  }
  if (profile.brandVoice === undefined) {
    notes.push(
      "No brand-voice profile is set. Upload brand guidelines or example content to train one (see `packages/content/src/brandVoice.ts`).",
    );
  }
  if (profile.terminology === undefined) {
    notes.push(
      "No terminology profile is set. Workspace glossary terms will not be enforced on generated text (see `packages/content/src/terminology.ts`).",
    );
  }
  if (profile.language !== undefined && profile.language.targets.length > 0) {
    notes.push(
      `Translation targets are configured (${profile.language.targets.join(", ")}); the translation phase is not wired to publish yet.`,
    );
  }
  if (
    profile.readingLevel !== undefined &&
    (profile.readingLevel.targetGrade < 4 || profile.readingLevel.targetGrade > 18)
  ) {
    notes.push(
      `readingLevel.targetGrade ${profile.readingLevel.targetGrade} is outside the common range 4–18; the writer may refuse or produce low-quality output.`,
    );
  }
  return notes;
}

/* -------------------------------------------------------------------------- */
/* Authorization helpers                                                       */
/* -------------------------------------------------------------------------- */

async function loadSessionAndAuthorize(
  req: Request,
  permission: string,
  label: string,
): Promise<SessionRecord | NextResponse> {
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: label === "PUT",
    });
  } catch (error) {
    process.stderr.write(
      `[/api/styles/[id]] session load failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return NextResponse.json(
      { error: "session_error", message: "Could not load the caller session." },
      { status: 500 },
    );
  }
  if (session === null) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Authentication required." },
      { status: 401 },
    );
  }
  try {
    assertPermission(session, permission);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  return session;
}

async function openStoreOrError(
  workspaceId: string,
  label: string,
): Promise<StoreLike | NextResponse> {
  try {
    const store = await forWorkspace(workspaceId);
    return store as unknown as StoreLike;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/styles/[id]] object store unavailable for ${label}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_unavailable",
        message:
          "The artifact object store is not configured on this server. Check STORAGE_DRIVER and the associated S3/local configuration.",
      },
      { status: 503 },
    );
  }
}

/**
 * Read the guide record to confirm it exists in the caller's workspace. The
 * workspace-scoped store already prevents cross-workspace reads, but the
 * explicit check gives a crisp 404 instead of a silent empty profile for
 * a non-existent guide.
 */
async function guideExists(
  store: StoreLike,
  guideId: string,
): Promise<boolean | NextResponse> {
  try {
    const raw = await readJsonOrNull(store, guideKey(guideId));
    return raw !== null && typeof raw === "object" && !Array.isArray(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/styles/[id]] guide lookup failed for ${guideId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The guide record could not be read from the object store. Check server logs.",
      },
      { status: 503 },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Route: GET                                                                  */
/* -------------------------------------------------------------------------- */

export async function GET(
  req: Request,
  context: { readonly params: { readonly id: string } },
): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Style profiles cannot be read.",
      },
      { status: 503 },
    );
  }
  if (!config.auth.sessionSecretConfigured) {
    return NextResponse.json(
      {
        error: "config_error",
        message: "SESSION_SECRET is not configured on this server.",
      },
      { status: 503 },
    );
  }

  const session = await loadSessionAndAuthorize(req, PERMISSIONS.workspace_read, "GET");
  if (session instanceof NextResponse) return session;
  const workspaceId = session.activeWorkspaceId;
  if (workspaceId === null) {
    return NextResponse.json(
      {
        error: "workspace_required",
        message: "An active workspace is required to read a style profile.",
      },
      { status: 403 },
    );
  }

  const guideId = context.params.id;
  if (typeof guideId !== "string" || !UUID_PATTERN.test(guideId)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "id",
        message: "Guide id must be a UUID.",
      },
      { status: 400 },
    );
  }

  const store = await openStoreOrError(workspaceId, "GET");
  if (store instanceof NextResponse) return store;

  const exists = await guideExists(store, guideId);
  if (exists instanceof NextResponse) return exists;
  if (!exists) {
    return NextResponse.json(
      {
        error: "not_found",
        message:
          "No guide exists under this id in your active workspace. Create the guide before configuring its style.",
      },
      { status: 404 },
    );
  }

  let profileRaw: unknown;
  try {
    profileRaw = await readJsonOrNull(store, styleKey(guideId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/styles/[id]] style read failed for ${guideId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The style profile could not be read from the object store. Check server logs.",
      },
      { status: 503 },
    );
  }

  let metaRaw: unknown = null;
  try {
    metaRaw = await readJsonOrNull(store, styleMetaKey(guideId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/styles/[id]] style meta read skipped: ${message}\n`,
    );
    // A missing or unreadable meta sidecar is not fatal; the profile itself
    // is authoritative. Log and continue with defaults for meta.
    metaRaw = null;
  }

  if (profileRaw === null) {
    const emptyProfile: StyleProfile = {};
    const response: StyleResponse = {
      guideId,
      workspaceId,
      state: "empty",
      profile: emptyProfile,
      version: 0,
      updatedAt: null,
      updatedBy: null,
      contentHash: null,
      message:
        "No style profile is stored for this guide. A PUT to this endpoint with a profile body will store one.",
      notes: buildNotes(emptyProfile, "empty"),
    };
    return NextResponse.json(response, { status: 200 });
  }

  let profile: StyleProfile;
  try {
    profile = validateStyleProfile(profileRaw);
  } catch (error) {
    if (error instanceof StyleProfileError) {
      process.stderr.write(
        `[/api/styles/[id]] stored profile is invalid for ${guideId}: ${error.message}\n`,
      );
      const response: StyleResponse = {
        guideId,
        workspaceId,
        state: "corrupt",
        profile: {},
        version: 0,
        updatedAt: null,
        updatedBy: null,
        contentHash: null,
        message:
          "The stored style profile does not validate against the current schema. It may have been written by an incompatible deployment; PUT a valid replacement to repair it.",
        notes: [`Validation error: ${error.message} (field: ${error.field}).`],
      };
      return NextResponse.json(response, { status: 200 });
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/styles/[id]] profile rehydrate threw for ${guideId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The stored style profile could not be decoded. Check server logs.",
      },
      { status: 503 },
    );
  }

  const meta = normaliseMeta(metaRaw);
  const response: StyleResponse = {
    guideId,
    workspaceId,
    state: "configured",
    profile,
    version: meta.version,
    updatedAt: meta.updatedAt ?? profile.updatedAt ?? null,
    updatedBy: meta.updatedBy ?? profile.updatedBy ?? null,
    contentHash: meta.contentHash,
    message: `Style profile version ${meta.version} loaded.`,
    notes: buildNotes(profile, "configured"),
  };
  return NextResponse.json(response, { status: 200 });
}

/* -------------------------------------------------------------------------- */
/* Route: PUT                                                                  */
/* -------------------------------------------------------------------------- */

export async function PUT(
  req: Request,
  context: { readonly params: { readonly id: string } },
): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Style profiles cannot be written.",
      },
      { status: 503 },
    );
  }
  if (!config.auth.sessionSecretConfigured) {
    return NextResponse.json(
      {
        error: "config_error",
        message: "SESSION_SECRET is not configured on this server.",
      },
      { status: 503 },
    );
  }

  const session = await loadSessionAndAuthorize(req, PERMISSIONS.guide_update, "PUT");
  if (session instanceof NextResponse) return session;
  const workspaceId = session.activeWorkspaceId;
  if (workspaceId === null) {
    return NextResponse.json(
      {
        error: "workspace_required",
        message: "An active workspace is required to write a style profile.",
      },
      { status: 403 },
    );
  }

  const guideId = context.params.id;
  if (typeof guideId !== "string" || !UUID_PATTERN.test(guideId)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "id",
        message: "Guide id must be a UUID.",
      },
      { status: 400 },
    );
  }

  // --------------------------------------------------------------- body -----
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  let profile: StyleProfile;
  try {
    profile = validateStyleProfile(bodyJson);
  } catch (error) {
    if (error instanceof StyleProfileError) {
      return NextResponse.json(
        {
          error:
            error.code === "unknown-field"
              ? "validation_error"
              : "validation_error",
          field: error.field,
          message: error.message,
        },
        { status: 400 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/styles/[id]] style validation threw unexpectedly for ${guideId}: ${message}\n`,
    );
    return NextResponse.json(
      { error: "validation_error", message: "Style profile could not be parsed." },
      { status: 400 },
    );
  }

  // ------------------------------------------------------------ storage -----
  const store = await openStoreOrError(workspaceId, "PUT");
  if (store instanceof NextResponse) return store;

  const exists = await guideExists(store, guideId);
  if (exists instanceof NextResponse) return exists;
  if (!exists) {
    return NextResponse.json(
      {
        error: "not_found",
        message:
          "No guide exists under this id in your active workspace. Create the guide before configuring its style.",
      },
      { status: 404 },
    );
  }

  // Read the previous meta so we can increment the version. A failure to
  // read the meta is treated as a first-write (version 1).
  let previousVersion = 0;
  try {
    const metaRaw = await readJsonOrNull(store, styleMetaKey(guideId));
    previousVersion = normaliseMeta(metaRaw).version;
  } catch (error) {
    process.stderr.write(
      `[/api/styles/[id]] meta read (pre-write) skipped for ${guideId}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    previousVersion = 0;
  }

  const nextVersion = previousVersion + 1;
  const nowIso = new Date().toISOString();

  // Server-owned provenance: overwrite anything the caller sent.
  const persistedProfile: StyleProfile = {
    ...profile,
    updatedBy: session.userId,
    updatedAt: nowIso,
  };

  const profileBytes = Buffer.from(
    JSON.stringify(persistedProfile, null, 2),
    "utf8",
  );
  const contentHash = createHash("sha256").update(profileBytes).digest("hex");

  const metaPersisted = {
    kind: "style-profile-meta",
    workspaceId,
    guideId,
    version: nextVersion,
    contentHash,
    updatedAt: nowIso,
    updatedBy: session.userId,
  };
  const metaBytes = Buffer.from(JSON.stringify(metaPersisted, null, 2), "utf8");

  try {
    await store.put(styleKey(guideId), profileBytes, {
      contentType: "application/json",
      contentLength: profileBytes.length,
      metadata: {
        "zipy-kind": "style-profile",
        "zipy-guide-id": guideId,
        "zipy-version": String(nextVersion),
        "zipy-content-hash": contentHash,
      },
    });
    await store.put(styleMetaKey(guideId), metaBytes, {
      contentType: "application/json",
      contentLength: metaBytes.length,
      metadata: {
        "zipy-kind": "style-profile-meta",
        "zipy-guide-id": guideId,
        "zipy-version": String(nextVersion),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/styles/[id]] persist failed for ${guideId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The style profile could not be persisted. Retry the request; no partial profile was written.",
      },
      { status: 503 },
    );
  }

  const response: StyleResponse = {
    guideId,
    workspaceId,
    state: "configured",
    profile: persistedProfile,
    version: nextVersion,
    updatedAt: nowIso,
    updatedBy: session.userId,
    contentHash,
    message: `Style profile saved at version ${nextVersion}. Re-run the guide generation endpoint with force: true to apply the new decisions.`,
    notes: buildNotes(persistedProfile, "configured"),
  };
  return NextResponse.json(response, { status: previousVersion === 0 ? 201 : 200 });
}

/* -------------------------------------------------------------------------- */
/* Meta normalisation                                                          */
/* -------------------------------------------------------------------------- */

function normaliseMeta(raw: unknown): {
  readonly version: number;
  readonly contentHash: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { version: 0, contentHash: null, updatedAt: null, updatedBy: null };
  }
  const m = raw as StyleMetaRecord;
  return {
    version: normaliseVersion(m.version),
    contentHash: asStringOrNull(m.contentHash),
    updatedAt: normaliseIso(m.updatedAt),
    updatedBy: asStringOrNull(m.updatedBy),
  };
}

function normaliseIso(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString();
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

const READ_ONLY_MESSAGE =
  "This endpoint accepts GET (read the style profile) and PUT (replace the profile). Partial-merge with PATCH is not supported; the profile is a coherent document.";

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "GET, PUT" } },
  );
}

export async function PATCH(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message: `${READ_ONLY_MESSAGE} Use PUT with a full profile body.`,
    },
    { status: 405, headers: { Allow: "GET, PUT" } },
  );
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "To reset the style profile, PUT an empty profile `{}`. Deletion is handled by the retention surface (admin/retention), not this route.",
    },
    { status: 405, headers: { Allow: "GET, PUT" } },
  );
}
