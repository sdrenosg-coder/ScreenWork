/**
 * POST /api/screenshots/[id]/redact
 *
 * Reviewer-facing surface for PII redaction of a captured screenshot. The
 * worker performs redaction automatically as part of the capture pipeline
 * (`packages/images/src/piiDetect.ts` + `redact.ts`); this endpoint lets a
 * reviewer *re-run* redaction with an adjusted policy — for example to add a
 * custom pattern the auto pass missed, or to redact a region the detector
 * flagged as "review" but did not blur.
 *
 * Contract:
 *   - Requires DATABASE_URL + SESSION_SECRET; returns 503 config_error
 *     otherwise (no re-redaction without persistence and without a session
 *     key to authorise the caller).
 *   - Authenticates via the shared session module and asserts
 *     `PERMISSIONS.screenshot_update`. A caller without it gets 403 via
 *     `toAuthzFailure`.
 *   - The `[id]` path segment is the screenshot artifact id. It is validated
 *     as a UUID before touching storage, so a malformed id is a 400 rather
 *     than a storage read.
 *   - The request body is optional. When omitted the route re-runs redaction
 *     with the *existing* persisted policy under which the screenshot was
 *     originally captured (the policy the worker recorded alongside the
 *     screenshot). When supplied, the body overrides: `policy`, `customPatterns`
 *     and `mode` (blur / pixelate / solid). Supplying a body always wins over
 *     the stored policy for this invocation only; the stored policy is not
 *     mutated by this route (that belongs to the settings surface, not a
 *     one-shot redact).
 *
 * Response contract:
 *   - `redacted` is the storage key of the newly-written redacted image. It
 *     is written alongside — not replacing — the original, so a reviewer can
 *     compare and so no destructive write can ever lose the only copy.
 *   - `detections` is the normalized list of PII regions with their category,
 *     source (pattern / detector / reviewer), confidence and bounding box.
 *     A `"review"` entry means the detector saw a candidate but did not blur
 *     it under the current policy; the reviewer can re-run with the entry's
 *     category added to `policy.mustRedact` to force a blur.
 *   - `stats` reflects what was actually redacted vs. left untouched, so the
 *     UI can show "3 emails redacted, 1 candidate left visible for review".
 *
 * The actual detection and redaction live in `@zipy/images/*`; this route does
 * not re-implement them. It resolves the input image, calls the modules, and
 * persists the result. If those modules throw a configuration error (e.g. no
 * VLM provider reachable for the vision pass), the route surfaces a 503 with
 * a clear message rather than silently falling back to a pattern-only pass.
 *
 * External setup the operator must supply for the vision-assisted pass to
 * detect non-pattern PII (names, addresses, ID photos) in an image:
 *   - A VLM: a hosted provider key (OPENAI_API_KEY / ANTHROPIC_API_KEY /
 *     GEMINI_API_KEY) or a local server (OLLAMA_BASE_URL / VLLM_BASE_URL).
 *   - The image rasteriser used by the redactor (`@napi-rs/canvas` +
 *     `sharp`) installed in the server runtime.
 *
 * What is NOT implemented here: manual region selection. The UI's reviewer
 * draw-a-box flow calls this route with an explicit `customRegions` array
 * (see `customPatterns` for the pattern form) — the drawing tool is a later
 * deliverable; this route already accepts a region list so the tool can land
 * without a route change.
 */

import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";

import {
  PERMISSIONS,
  assertPermission,
  toAuthzFailure,
} from "@/lib/rbac/permissions";
import { loadSession, type SessionRecord } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { forWorkspace } from "@zipy/storage/objectStore";
import {
  detectPiiRegionsFromBytes,
  type DetectionBox,
  type DetectorCategory,
  type PiiDetection,
  type RedactionPolicy,
  type VisionAdapterHandle,
} from "@zipy/images/piiDetect";
import {
  redactImage,
  type RedactionMode,
} from "@zipy/images/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Storage namespace of screenshots written by the automation capture phase. */
const SCREENSHOT_PREFIX = "screenshots";

/** Storage namespace for redacted derivatives. A sibling, not a replacement. */
const REDACTED_PREFIX = "screenshots-redacted";

/** Cap on custom regex patterns accepted in a single request. */
const MAX_CUSTOM_PATTERNS = 200;
/** Cap on a single custom pattern's source length. */
const MAX_PATTERN_SOURCE_LENGTH = 500;
/** Cap on a human label per custom pattern. */
const MAX_PATTERN_LABEL_LENGTH = 80;
/** Cap on explicit reviewer-supplied regions. */
const MAX_CUSTOM_REGIONS = 500;

const VALID_MODES: readonly RedactionMode[] = ["blur", "pixelate", "solid"];

/**
 * Detector categories as persisted by the capture phase. This mirrors the
 * enum exported by `@zipy/images/piiDetect`; if the module adds a category,
 * the type-checker (via the `DetectorCategory` union below) will flag the
 * validation gap rather than silently dropping the new value.
 */
const KNOWN_CATEGORIES: readonly DetectorCategory[] = [
  "email",
  "phone",
  "name",
  "address",
  "credit-card",
  "ssn",
  "iban",
  "ip-address",
  "api-key",
  "access-token",
  "password",
  "date-of-birth",
  "id-number",
  "custom",
];

/* -------------------------------------------------------------------------- */
/* Request body                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The request body is intentionally minimal: policy + optional overrides.
 * Every field is optional. A body that is `{}` is equivalent to "re-run with
 * the stored policy" — the same behaviour as requesting with no body at all.
 */
interface RawBody {
  /** Override which categories MUST be redacted. */
  readonly mustRedact?: unknown;
  /** Categories the caller explicitly wants left readable (reviewed-safe). */
  readonly allowlist?: unknown;
  /** Detection sensitivity in [0, 1]; higher = more candidates surfaced. */
  readonly sensitivity?: unknown;
  /** Redaction mode: blur (default) | pixelate | solid. */
  readonly mode?: unknown;
  /** Optional custom regex patterns added for this run. */
  readonly customPatterns?: unknown;
  /**
   * Optional reviewer-supplied regions ({x, y, width, height}) in the image's
   * native pixel space. Every region is redacted regardless of detection.
   */
  readonly customRegions?: unknown;
  /**
   * When true, run the vision-assisted pass even if the pattern pass already
   * flagged an image as "review". Defaults to whatever the stored policy used.
   * A caller can set this to `false` to run a fast pattern-only pass.
   */
  readonly useVision?: unknown;
}

interface ValidatedBody {
  readonly policy: Partial<RedactionPolicy> | null;
  readonly customPatterns: readonly {
    readonly label: string;
    readonly source: string;
    readonly flags: string;
  }[];
  readonly customRegions: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
  readonly mode: RedactionMode | null;
  readonly useVision: boolean | null;
}

interface ValidationErrorBody {
  readonly error: "validation_error";
  readonly field: string;
  readonly message: string;
}

function badRequest(field: string, message: string): NextResponse {
  const body: ValidationErrorBody = {
    error: "validation_error",
    field,
    message,
  };
  return NextResponse.json(body, { status: 400 });
}

function validateBody(raw: unknown): ValidatedBody | NextResponse {
  if (raw === null || raw === undefined) {
    return {
      policy: null,
      customPatterns: [],
      customRegions: [],
      mode: null,
      useVision: null,
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return badRequest("body", "Request body must be a JSON object when present.");
  }
  const body = raw as RawBody;

  // ----------------------------------------------------------- categories --
  let mustRedact: DetectorCategory[] | null = null;
  if (body.mustRedact !== undefined && body.mustRedact !== null) {
    if (!Array.isArray(body.mustRedact)) {
      return badRequest("mustRedact", "mustRedact must be an array of categories.");
    }
    const out: DetectorCategory[] = [];
    for (let i = 0; i < body.mustRedact.length; i += 1) {
      const entry = body.mustRedact[i];
      if (typeof entry !== "string" || !isCategory(entry)) {
        return badRequest(
          `mustRedact[${i}]`,
          `Unknown category. Allowed: ${KNOWN_CATEGORIES.join(", ")}.`,
        );
      }
      if (!out.includes(entry)) out.push(entry);
    }
    mustRedact = out;
  }

  let allowlist: DetectorCategory[] | null = null;
  if (body.allowlist !== undefined && body.allowlist !== null) {
    if (!Array.isArray(body.allowlist)) {
      return badRequest("allowlist", "allowlist must be an array of categories.");
    }
    const out: DetectorCategory[] = [];
    for (let i = 0; i < body.allowlist.length; i += 1) {
      const entry = body.allowlist[i];
      if (typeof entry !== "string" || !isCategory(entry)) {
        return badRequest(
          `allowlist[${i}]`,
          `Unknown category. Allowed: ${KNOWN_CATEGORIES.join(", ")}.`,
        );
      }
      if (!out.includes(entry)) out.push(entry);
    }
    allowlist = out;
  }

  if (mustRedact !== null && allowlist !== null) {
    for (const c of mustRedact) {
      if (allowlist.includes(c)) {
        return badRequest(
          "allowlist",
          `Category "${c}" appears in both mustRedact and allowlist; the intent is ambiguous.`,
        );
      }
    }
  }

  // ---------------------------------------------------------- sensitivity --
  let sensitivity: number | null = null;
  if (body.sensitivity !== undefined && body.sensitivity !== null) {
    if (typeof body.sensitivity !== "number" || !Number.isFinite(body.sensitivity)) {
      return badRequest("sensitivity", "sensitivity must be a number in [0, 1].");
    }
    if (body.sensitivity < 0 || body.sensitivity > 1) {
      return badRequest("sensitivity", "sensitivity must be a number in [0, 1].");
    }
    sensitivity = body.sensitivity;
  }

  // ----------------------------------------------------------------- mode --
  let mode: RedactionMode | null = null;
  if (body.mode !== undefined && body.mode !== null) {
    if (typeof body.mode !== "string" || !isRedactionMode(body.mode)) {
      return badRequest(
        "mode",
        `mode must be one of: ${VALID_MODES.join(", ")}.`,
      );
    }
    mode = body.mode;
  }

  // -------------------------------------------------------- custom patterns --
  const customPatterns: {
    label: string;
    source: string;
    flags: string;
  }[] = [];
  if (body.customPatterns !== undefined && body.customPatterns !== null) {
    if (!Array.isArray(body.customPatterns)) {
      return badRequest("customPatterns", "customPatterns must be an array.");
    }
    if (body.customPatterns.length > MAX_CUSTOM_PATTERNS) {
      return badRequest(
        "customPatterns",
        `At most ${MAX_CUSTOM_PATTERNS} custom patterns per request.`,
      );
    }
    for (let i = 0; i < body.customPatterns.length; i += 1) {
      const entry = body.customPatterns[i];
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return badRequest(
          `customPatterns[${i}]`,
          "Each custom pattern must be an object { label, source, flags? }.",
        );
      }
      const record = entry as Record<string, unknown>;
      const label =
        typeof record["label"] === "string" ? record["label"].trim() : "";
      const source =
        typeof record["source"] === "string" ? record["source"] : "";
      const flagsRaw =
        typeof record["flags"] === "string" ? record["flags"] : "";

      if (label.length === 0) {
        return badRequest(
          `customPatterns[${i}].label`,
          "Each custom pattern needs a non-empty `label`.",
        );
      }
      if (label.length > MAX_PATTERN_LABEL_LENGTH) {
        return badRequest(
          `customPatterns[${i}].label`,
          `label exceeds the ${MAX_PATTERN_LABEL_LENGTH}-character limit.`,
        );
      }
      if (source.length === 0) {
        return badRequest(
          `customPatterns[${i}].source`,
          "Each custom pattern needs a non-empty `source` regex.",
        );
      }
      if (source.length > MAX_PATTERN_SOURCE_LENGTH) {
        return badRequest(
          `customPatterns[${i}].source`,
          `source exceeds the ${MAX_PATTERN_SOURCE_LENGTH}-character limit.`,
        );
      }
      // Reject a pattern whose regex is invalid before it reaches the matcher,
      // so a bad pattern is a 400 with the exact field path rather than a
      // worker-time exception.
      try {
        // eslint-disable-next-line no-new
        new RegExp(source, flagsRaw);
      } catch (err) {
        return badRequest(
          `customPatterns[${i}].source`,
          `Invalid regex: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
      customPatterns.push({ label, source, flags: flagsRaw });
    }
  }

  // --------------------------------------------------------- custom regions --
  const customRegions: {
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];
  if (body.customRegions !== undefined && body.customRegions !== null) {
    if (!Array.isArray(body.customRegions)) {
      return badRequest("customRegions", "customRegions must be an array.");
    }
    if (body.customRegions.length > MAX_CUSTOM_REGIONS) {
      return badRequest(
        "customRegions",
        `At most ${MAX_CUSTOM_REGIONS} custom regions per request.`,
      );
    }
    for (let i = 0; i < body.customRegions.length; i += 1) {
      const entry = body.customRegions[i];
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return badRequest(
          `customRegions[${i}]`,
          "Each custom region must be an object { x, y, width, height }.",
        );
      }
      const r = entry as Record<string, unknown>;
      const x = readFiniteNumber(r["x"]);
      const y = readFiniteNumber(r["y"]);
      const width = readFiniteNumber(r["width"]);
      const height = readFiniteNumber(r["height"]);
      if (x === null || y === null || width === null || height === null) {
        return badRequest(
          `customRegions[${i}]`,
          "x, y, width and height must all be finite numbers.",
        );
      }
      if (width <= 0 || height <= 0) {
        return badRequest(
          `customRegions[${i}]`,
          "width and height must be positive.",
        );
      }
      if (x < 0 || y < 0) {
        return badRequest(
          `customRegions[${i}]`,
          "x and y must be non-negative (image-space pixel coordinates).",
        );
      }
      customRegions.push({ x, y, width, height });
    }
  }

  // ---------------------------------------------------------------- vision --
  let useVision: boolean | null = null;
  if (body.useVision !== undefined && body.useVision !== null) {
    if (typeof body.useVision !== "boolean") {
      return badRequest("useVision", "useVision must be a boolean when present.");
    }
    useVision = body.useVision;
  }

  const policy: Partial<RedactionPolicy> = {};
  if (mustRedact !== null) policy.mustRedact = mustRedact;
  if (allowlist !== null) policy.allowlist = allowlist;
  if (sensitivity !== null) policy.sensitivity = sensitivity;

  const hasPolicyField =
    mustRedact !== null || allowlist !== null || sensitivity !== null;

  return {
    policy: hasPolicyField ? policy : null,
    customPatterns,
    customRegions,
    mode,
    useVision,
  };
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function isCategory(value: string): value is DetectorCategory {
  return (KNOWN_CATEGORIES as readonly string[]).includes(value);
}

function isRedactionMode(value: string): value is RedactionMode {
  return (VALID_MODES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Persisted screenshot metadata                                               */
/* -------------------------------------------------------------------------- */

/**
 * Shape of the metadata sidecar the capture pipeline writes next to each
 * screenshot. Only the fields this route consumes are typed; unknown fields
 * are preserved by the passthrough write when we persist the re-redaction
 * metadata.
 */
interface ScreenshotMetadata {
  readonly kind?: unknown;
  readonly workspaceId?: unknown;
  readonly screenshotId?: unknown;
  readonly fileKey?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly deviceScaleFactor?: unknown;
  readonly capturedAt?: unknown;
  /** The policy in effect when the screenshot was captured. */
  readonly policy?: unknown;
  /** Detections recorded at capture time, for diff/compare. */
  readonly detections?: unknown;
  /** Cheap sidecar flag the UI uses to badge "needs review". */
  readonly hasReviewCandidates?: unknown;
}

interface ResolvedScreenshot {
  readonly metadata: ScreenshotMetadata;
  readonly metadataKey: string;
  readonly fileKey: string;
}

type ScreenshotLookup =
  | { readonly kind: "ok"; readonly resolved: ResolvedScreenshot }
  | { readonly kind: "not-found" }
  | { readonly kind: "corrupt" };

/* -------------------------------------------------------------------------- */
/* Storage helpers                                                             */
/* -------------------------------------------------------------------------- */

function metadataKeyFor(screenshotId: string): string {
  return `${SCREENSHOT_PREFIX}/${screenshotId}.json`;
}

function fileKeyFor(screenshotId: string): string {
  return `${SCREENSHOT_PREFIX}/${screenshotId}`;
}

function redactedKeyFor(screenshotId: string, runId: string): string {
  return `${REDACTED_PREFIX}/${screenshotId}/${runId}`;
}

function redactedMetadataKeyFor(screenshotId: string, runId: string): string {
  return `${REDACTED_PREFIX}/${screenshotId}/${runId}.json`;
}

interface StoreLike {
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
}

async function readScreenshot(
  store: StoreLike,
  screenshotId: string,
): Promise<ScreenshotLookup> {
  const metadataKey = metadataKeyFor(screenshotId);
  const fileKey = fileKeyFor(screenshotId);

  // Metadata first so we validate the sidecar before we hold an image handle.
  let metadataBytes: Buffer | null;
  try {
    metadataBytes = await store.get(metadataKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(message)) {
      return { kind: "not-found" };
    }
    throw error;
  }
  if (metadataBytes === null) return { kind: "not-found" };

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataBytes.toString("utf8"));
  } catch {
    return { kind: "corrupt" };
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { kind: "corrupt" };
  }

  // Confirm the image body exists too — a sidecar with no image is corrupt.
  let imageBytes: Buffer | null;
  try {
    imageBytes = await store.get(fileKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|enoent|no such key|404/i.test(message)) {
      return { kind: "corrupt" };
    }
    throw error;
  }
  if (imageBytes === null) return { kind: "corrupt" };

  return {
    kind: "ok",
    resolved: {
      metadata: metadata as ScreenshotMetadata,
      metadataKey,
      fileKey,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Shape normalisation                                                         */
/* -------------------------------------------------------------------------- */

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return {};
}

/**
 * Read the stored policy. We do not attempt to fully validate the persisted
 * shape — the phase that wrote it owns that contract. We only pull out the
 * fields we need, defaulting to `{}` (which the images modules treat as
 * "use built-in defaults").
 */
function readStoredPolicy(metadata: ScreenshotMetadata): Partial<RedactionPolicy> {
  return asRecord(metadata.policy) as Partial<RedactionPolicy>;
}

/* -------------------------------------------------------------------------- */
/* Response shapes                                                             */
/* -------------------------------------------------------------------------- */

interface DetectionDto {
  readonly category: DetectorCategory;
  readonly source: "pattern" | "vision" | "custom" | "reviewer";
  readonly confidence: number;
  readonly text: string | null;
  readonly box: DetectionBox;
  readonly redacted: boolean;
  /** Present when `redacted === false`; a reviewer-facing note. */
  readonly reason?: string;
}

interface StatsDto {
  readonly detectedTotal: number;
  readonly redactedTotal: number;
  readonly reviewTotal: number;
}

interface RedactResponse {
  readonly screenshotId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly mode: RedactionMode;
  readonly policyApplied: Partial<RedactionPolicy>;
  readonly useVisionApplied: boolean;
  readonly redacted: {
    readonly key: string;
    readonly metadataKey: string;
    readonly contentType: string;
    readonly byteLength: number;
    readonly contentHash: string;
  };
  readonly detections: readonly DetectionDto[];
  readonly stats: StatsDto;
  readonly message: string;
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Detection DTO mapping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Map a detection returned by `@zipy/images/piiDetect` to the response shape
 * the reviewer UI consumes. A detection whose category is in the effective
 * allowlist is emitted with `redacted: false` and a reason, so the UI can
 * show "left visible because it is on your allowlist" instead of hiding it.
 */
function toDetectionDto(
  detection: PiiDetection,
  effectiveAllowlist: readonly DetectorCategory[],
  effectiveMustRedact: readonly DetectorCategory[],
): DetectionDto {
  const allowed = effectiveAllowlist.includes(detection.category);
  const forced = effectiveMustRedact.includes(detection.category);
  const redacted = forced || !allowed;
  const dto: DetectionDto = {
    category: detection.category,
    source: detection.source,
    confidence: detection.confidence,
    text: detection.text ?? null,
    box: detection.box,
    redacted,
  };
  if (!redacted) {
    return {
      ...dto,
      reason: "Category is on your allowlist; left readable in this pass.",
    };
  }
  return dto;
}

/**
 * Turn a reviewer-supplied region into a synthetic detection. Sets
 * `source: "reviewer"` so the response is self-describing — a reviewer can
 * tell which regions were auto-detected and which they added.
 */
function customRegionToDetection(region: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): PiiDetection {
  return {
    category: "custom",
    source: "reviewer",
    confidence: 1,
    text: null,
    box: {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Route                                                                       */
/* -------------------------------------------------------------------------- */

export async function POST(
  req: Request,
  context: { readonly params: { readonly id: string } },
): Promise<NextResponse> {
  const config = getConfig();

  if (!config.database.configured) {
    return NextResponse.json(
      {
        error: "config_error",
        message:
          "DATABASE_URL is not configured on this server. Screenshot redaction cannot be recorded.",
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

  // --------------------------------------------------------- auth + RBAC ---
  let session: SessionRecord | null;
  try {
    session = await loadSession({
      cookieHeader: req.headers.get("cookie"),
      touch: true,
    });
  } catch (error) {
    process.stderr.write(
      `[/api/screenshots/[id]/redact] session load failed: ${
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
    assertPermission(session, PERMISSIONS.screenshot_update);
  } catch (error) {
    const failure = toAuthzFailure(error);
    if (failure !== null) {
      return NextResponse.json(failure.body, { status: failure.status });
    }
    throw error;
  }
  const workspaceId = session.activeWorkspaceId;
  if (workspaceId === null) {
    return NextResponse.json(
      {
        error: "workspace_required",
        message: "An active workspace is required to redact a screenshot.",
      },
      { status: 403 },
    );
  }

  // -------------------------------------------------------------- id ------
  const screenshotId = context.params.id;
  if (typeof screenshotId !== "string" || !UUID_PATTERN.test(screenshotId)) {
    return NextResponse.json(
      {
        error: "validation_error",
        field: "id",
        message: "Screenshot id must be a UUID.",
      },
      { status: 400 },
    );
  }

  // --------------------------------------------------------- body ---------
  let bodyJson: unknown = null;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      bodyJson = await req.json();
    } catch {
      return NextResponse.json(
        {
          error: "invalid_json",
          message: "Request body must be valid JSON when present.",
        },
        { status: 400 },
      );
    }
  }
  const validatedBody = validateBody(bodyJson);
  if (validatedBody instanceof NextResponse) return validatedBody;

  // --------------------------------------------------------- storage ------
  let store: Awaited<ReturnType<typeof forWorkspace>>;
  try {
    store = await forWorkspace(workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/screenshots/[id]/redact] object store unavailable: ${message}\n`,
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
  const storeLike = store as unknown as StoreLike;

  // --------------------------------------------------------- locate -------
  let lookup: ScreenshotLookup;
  try {
    lookup = await readScreenshot(storeLike, screenshotId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/screenshots/[id]/redact] storage read failed for ${screenshotId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The screenshot could not be read from the object store. Check server logs.",
      },
      { status: 503 },
    );
  }

  if (lookup.kind === "not-found") {
    return NextResponse.json(
      {
        error: "not_found",
        message:
          "No screenshot exists under this id in your active workspace. If the capture job is still running, retry once it has finished.",
      },
      { status: 404 },
    );
  }
  if (lookup.kind === "corrupt") {
    return NextResponse.json(
      {
        error: "corrupt_artifact",
        message:
          "The screenshot is missing its image body or its metadata sidecar is not a JSON object. Re-capture the step.",
      },
      { status: 500 },
    );
  }

  const { metadata, fileKey } = lookup.resolved;

  // Defence in depth: refuse to serve a screenshot whose embedded workspaceId
  // disagrees with the caller's active workspace.
  const persistedWorkspaceId = asString(metadata.workspaceId);
  if (persistedWorkspaceId !== null && persistedWorkspaceId !== workspaceId) {
    process.stderr.write(
      `[/api/screenshots/[id]/redact] workspace mismatch for ${screenshotId}: stored=${persistedWorkspaceId} caller=${workspaceId}\n`,
    );
    return NextResponse.json(
      {
        error: "not_found",
        message:
          "No screenshot exists under this id in your active workspace.",
      },
      { status: 404 },
    );
  }

  // ---------------------------------------------------------- load image ---
  let imageBytes: Buffer;
  try {
    const bytes = await storeLike.get(fileKey);
    if (bytes === null) {
      // The metadata existence check already verified the bytes existed; a
      // null here means the object was removed between reads. Treat it as a
      // concurrent mutation, not a caller error.
      return NextResponse.json(
        {
          error: "not_found",
          message:
            "The screenshot image body is no longer present. It may have been retained or deleted in another session.",
        },
        { status: 404 },
      );
    }
    imageBytes = bytes;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/screenshots/[id]/redact] image read failed for ${screenshotId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The screenshot bytes could not be read from the object store. Check server logs.",
      },
      { status: 503 },
    );
  }

  // ---------------------------------------------------- effective policy ---
  const storedPolicy = readStoredPolicy(metadata);
  const effectivePolicy: Partial<RedactionPolicy> = {
    ...storedPolicy,
    ...(validatedBody.policy ?? {}),
  };
  const effectiveMustRedact = Array.isArray(effectivePolicy.mustRedact)
    ? effectivePolicy.mustRedact
    : [];
  const effectiveAllowlist = Array.isArray(effectivePolicy.allowlist)
    ? effectivePolicy.allowlist
    : [];
  const effectiveUseVision =
    validatedBody.useVision !== null
      ? validatedBody.useVision
      : effectivePolicy.sensitivity !== undefined
        ? true // a caller who tunes sensitivity wants a full pass
        : false;

  // -------------------------------------------------------- run detect -----
  // The images module returns detections and the region boxes; redaction is
  // applied below using the same module so the two never disagree.
  let detections: readonly PiiDetection[];
  try {
    const result = await detectPiiRegionsFromBytes(imageBytes, {
      policy: effectivePolicy,
      customPatterns: validatedBody.customPatterns,
      useVision: effectiveUseVision,
      // A vision adapter handle is only acquired when useVision is true. The
      // module lazily requires the provider config; when a VLM is unconfigured
      // it throws a typed error which we translate into a 503 below.
      vision: effectiveUseVision ? makeVisionHandle(config) : null,
    });
    detections = result.detections;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingVisionError(message)) {
      return NextResponse.json(
        {
          error: "vision_unconfigured",
          message:
            "The vision-assisted pass is enabled but no VLM provider is configured. Set a hosted provider key (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY) or a local base URL (OLLAMA_BASE_URL / VLLM_BASE_URL), or re-run with useVision: false to run a pattern-only pass.",
        },
        { status: 503 },
      );
    }
    process.stderr.write(
      `[/api/screenshots/[id]/redact] detection failed for ${screenshotId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "detection_failed",
        message:
          "PII detection failed while reading the screenshot. Check server logs for the underlying error.",
      },
      { status: 500 },
    );
  }

  // ------------------------------------------------- reviewer regions ------
  const customDetections = validatedBody.customRegions.map(customRegionToDetection);
  const allDetections = [...detections, ...customDetections];

  // Compute what the response will report and what the redactor will apply.
  const dtos: DetectionDto[] = [];
  const toRedact: PiiDetection[] = [];
  for (const d of allDetections) {
    const dto = toDetectionDto(d, effectiveAllowlist, effectiveMustRedact);
    dtos.push(dto);
    if (dto.redacted) toRedact.push(d);
  }

  const redactedTotal = toRedact.length;
  const reviewTotal = dtos.length - redactedTotal;

  // ------------------------------------------------------ run redact -------
  const mode: RedactionMode = validatedBody.mode ?? effectivePolicy.mode ?? "blur";
  let redactedBytes: Buffer;
  try {
    const redacted = await redactImage(imageBytes, toRedact, {
      mode,
      // Preserve the original alpha channel and DPI; the module handles the
      // renderer-specific details. The `contentType` is inferred from the
      // input format so a PNG stays a PNG (lossless requirement) and a WebP
      // stays WebP.
      preserveFormat: true,
    });
    redactedBytes = redacted.bytes;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/screenshots/[id]/redact] redaction failed for ${screenshotId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "redaction_failed",
        message:
          "The screenshot could not be redacted. The image rasteriser may not be installed in this runtime. Check server logs.",
      },
      { status: 500 },
    );
  }

  // ------------------------------------------------------ persist result ---
  const runId = randomUUID();
  const redactedKey = redactedKeyFor(screenshotId, runId);
  const redactedMetadataKey = redactedMetadataKeyFor(screenshotId, runId);
  const contentHash = createHash("sha256").update(redactedBytes).digest("hex");
  const redactedContentType = inferRedactedContentType(fileKey, metadata);

  const persistedMetadata = {
    kind: "screenshot-redaction",
    workspaceId,
    screenshotId,
    runId,
    sourceFileKey: fileKey,
    sourceMetadataKey: lookup.resolved.metadataKey,
    contentType: redactedContentType,
    byteLength: redactedBytes.length,
    contentHash,
    mode,
    policyApplied: effectivePolicy,
    useVisionApplied: effectiveUseVision,
    customPatterns: validatedBody.customPatterns.map((p) => ({
      label: p.label,
      source: p.source,
      flags: p.flags,
    })),
    customRegions: validatedBody.customRegions,
    detections: dtos,
    stats: {
      detectedTotal: dtos.length,
      redactedTotal,
      reviewTotal,
    },
    redactedAt: new Date().toISOString(),
    redactedBy: session.userId,
  };

  try {
    await storeLike.put(redactedKey, redactedBytes, {
      contentType: redactedContentType,
      contentLength: redactedBytes.length,
      metadata: {
        "zipy-kind": "screenshot-redacted",
        "zipy-screenshot-id": screenshotId,
        "zipy-content-hash": contentHash,
      },
    });
    await storeLike.put(
      redactedMetadataKey,
      Buffer.from(JSON.stringify(persistedMetadata, null, 2), "utf8"),
      {
        contentType: "application/json",
        contentLength: Buffer.byteLength(JSON.stringify(persistedMetadata)),
        metadata: {
          "zipy-kind": "screenshot-redaction-metadata",
          "zipy-screenshot-id": screenshotId,
          "zipy-run-id": runId,
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[/api/screenshots/[id]/redact] persist failed for ${screenshotId} run ${runId}: ${message}\n`,
    );
    return NextResponse.json(
      {
        error: "storage_failed",
        message:
          "The redacted image could not be persisted to the object store. The redaction completed in memory but was not written; retry the request.",
      },
      { status: 503 },
    );
  }

  const response: RedactResponse = {
    screenshotId,
    workspaceId,
    runId,
    mode,
    policyApplied: effectivePolicy,
    useVisionApplied: effectiveUseVision,
    redacted: {
      key: redactedKey,
      metadataKey: redactedMetadataKey,
      contentType: redactedContentType,
      byteLength: redactedBytes.length,
      contentHash,
    },
    detections: dtos,
    stats: {
      detectedTotal: dtos.length,
      redactedTotal,
      reviewTotal,
    },
    message:
      redactedTotal === 0 && reviewTotal === 0
        ? "No PII candidates were detected in this screenshot under the applied policy."
        : reviewTotal === 0
          ? `${redactedTotal} PII region(s) redacted.`
          : `${redactedTotal} PII region(s) redacted; ${reviewTotal} candidate(s) left readable under the current policy. Re-run with the candidate's category in mustRedact to force a blur.`,
    notes: buildNotes(validatedBody, effectiveUseVision, dtos),
  };

  return NextResponse.json(response, { status: 201 });
}

/* -------------------------------------------------------------------------- */
/* Vision adapter handle                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Construct the vision handle the images module expects. We pass the config
 * straight through — the images module owns provider selection and uses the
 * same config object as every other module, so a provider that the LLM
 * adapter cannot reach also cannot be used here.
 *
 * The module raises a `VisionUnconfiguredError` (string-matched via
 * `isMissingVisionError` below) when no provider is reachable; this route
 * turns that into an explicit 503 rather than a silent pattern-only fallback.
 */
function makeVisionHandle(config: ReturnType<typeof getConfig>): VisionAdapterHandle {
  return {
    // The images module composes this from config itself when given the
    // adapter factory; we pass the config-derived discriminator so the module
    // does not have to re-read config.
    provider: config.llm.defaultProvider,
    logPrefix: "zipy:images:piiDetect",
  };
}

function isMissingVisionError(message: string): boolean {
  return /vision.?unconfigured|no.?vlm|provider.?unconfigured|vision provider not configured/i.test(
    message,
  );
}

/* -------------------------------------------------------------------------- */
/* Content-type inference                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Determine the content type of the redacted output. When the input was PNG
 * we keep PNG (lossless requirement for text-heavy screenshots). Otherwise
 * we prefer WebP, which is what the capture phase writes.
 */
function inferRedactedContentType(
  originalFileKey: string,
  metadata: ScreenshotMetadata,
): string {
  const declared = asString(asRecord(metadata)["contentType"]);
  if (declared !== null && declared.startsWith("image/")) return declared;
  const lower = originalFileKey.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/webp";
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

function buildNotes(
  body: ValidatedBody,
  useVision: boolean,
  detections: readonly DetectionDto[],
): readonly string[] {
  const notes: string[] = [];

  if (!useVision) {
    notes.push(
      "This pass ran without the vision-assisted detector, so non-pattern PII (names, addresses, ID photos) may not have been flagged. Re-run with useVision: true once a VLM provider is configured.",
    );
  }
  if (body.customPatterns.length > 0) {
    notes.push(
      `Applied ${body.customPatterns.length} custom pattern(s). Custom patterns run in addition to the built-in detectors.`,
    );
  }
  if (body.customRegions.length > 0) {
    notes.push(
      `Applied ${body.customRegions.length} reviewer-supplied region(s) direct to the image, regardless of detector output.`,
    );
  }
  if (detections.some((d) => !d.redacted)) {
    notes.push(
      "Some detected categories were on the allowlist and were left readable. Remove the category from allowlist, or add it to mustRedact, to force a blur.",
    );
  }
  return notes;
}

/* -------------------------------------------------------------------------- */
/* Other methods                                                               */
/* -------------------------------------------------------------------------- */

const READ_ONLY_MESSAGE =
  "This endpoint accepts POST with an optional JSON body describing the redaction policy. There is no GET: use the workflow read surface or the screenshot listing endpoint to enumerate screenshots.";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function PUT(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function PATCH(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed", message: READ_ONLY_MESSAGE },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      message:
        "A redaction run is immutable. To remove a redacted derivative, use the retention surface (admin/retention), not this route.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
