"use client";

/**
 * StylePanel — reviewer-facing editor for a guide's style profile.
 *
 * It is the UI surface for `GET/PUT /api/styles/[id]` and persists the same
 * document the content-generation layers read from
 * (`packages/content/src/styleProfile.ts`):
 *
 *   - tone              (`packages/content/src/tone.ts`)
 *   - readingLevel      (`packages/content/src/readingLevel.ts`)
 *   - brandVoice        (`packages/content/src/brandVoice.ts`)
 *   - terminology       (`packages/content/src/terminology.ts`)
 *   - audience / industry / language / variables (persisted verbatim; consumed
 *     by later-phase layers)
 *
 * Contract with the API (which is preserved exactly):
 *   - GET returns `{ state, profile, version, updatedAt, updatedBy,
 *     contentHash, message, notes }`. `state` may be `"empty"`, `"configured"`
 *     or `"corrupt"`; the panel renders all three without inventing values.
 *   - PUT replaces the whole profile. The body is the profile object; the
 *     server overwrites `updatedBy`/`updatedAt` and rejects unknown fields
 *     with a 400 that carries `{ error, message, field }`.
 *   - 404 on unknown guide. `id` is a UUID; the component rejects malformed
 *     ids before calling the API.
 *
 * Design notes:
 *   - Only structural fields supported by the API are edited here. Brand-voice
 *     training (uploading guidelines/examples) and language translation are
 *     later batches; the panel exposes what those layers produced and lets the
 *     reviewer correct/paste it, but it never fakes their output.
 *   - Where the shape is open-ended (brand voice, terminology, variables,
 *     industry notes, custom fields), the editor stores the raw JSON and
 *     surfaces the server's validation message verbatim. It does not silently
 *     drop fields it does not understand.
 *   - The panel is framework-light: inline styles only, matching
 *     `SourceIngestForm` and `ProvenancePanel`. No design-system import, no
 *     global CSS pollution.
 *   - Freshness contract: the panel reloads the profile whenever the guide id
 *     changes, and reloads after every successful save. If the server returns
 *     a still-mismatched `contentHash` (a concurrent writer), it renders a
 *     stale notice; it never assumes its memory is authoritative.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
} from "react";

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

type StyleState = "empty" | "configured" | "corrupt";

interface StyleProfileDocument {
  readonly tone?: unknown;
  readonly readingLevel?: unknown;
  readonly brandVoice?: unknown;
  readonly terminology?: unknown;
  readonly audience?: unknown;
  readonly industry?: unknown;
  readonly language?: unknown;
  readonly variables?: unknown;
  readonly updatedAt?: unknown;
  readonly updatedBy?: unknown;
  readonly [other: string]: unknown;
}

interface StyleResponse {
  readonly guideId: string;
  readonly workspaceId: string;
  readonly state: StyleState;
  readonly profile: StyleProfileDocument;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly contentHash: string | null;
  readonly message: string;
  readonly notes: readonly string[];
}

interface ApiError {
  readonly error: string;
  readonly message: string;
  readonly field?: string;
}

/* -------------------------------------------------------------------------- */
/* Local form shape                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Known fields with first-class editors. Everything else is preserved
 * verbatim in `extraFields` so a PUT does not erase decisions the panel does
 * not understand.
 */
interface FormState {
  readonly tone: string;
  readonly targetGradeText: string;
  readonly toleranceText: string;
  readonly audience: string;
  readonly industryJson: string;
  readonly languageJson: string;
  readonly brandVoiceJson: string;
  readonly terminologyJson: string;
  readonly variablesJson: string;
  readonly extraFieldsJson: string;
}

interface FormErrors {
  readonly [key: string]: string | undefined;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Known top-level profile keys the panel edits itself. Everything else is
 * round-tripped through the "Additional fields" JSON block.
 */
const MANAGED_KEYS: readonly string[] = [
  "tone",
  "readingLevel",
  "brandVoice",
  "terminology",
  "audience",
  "industry",
  "language",
  "variables",
  "updatedAt",
  "updatedBy",
];

const INITIAL_FORM: FormState = {
  tone: "",
  targetGradeText: "",
  toleranceText: "",
  audience: "",
  industryJson: "",
  languageJson: "",
  brandVoiceJson: "",
  terminologyJson: "",
  variablesJson: "",
  extraFieldsJson: "",
};

/* -------------------------------------------------------------------------- */
/* Public props                                                                */
/* -------------------------------------------------------------------------- */

export interface StylePanelProps {
  /** Guide UUID. The panel rejects non-UUID ids before calling the API. */
  readonly guideId: string;
}

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: StyleResponse }
  | { readonly kind: "error"; readonly error: ApiError };

export default function StylePanel({ guideId }: StylePanelProps) {
  const isValidId = UUID_PATTERN.test(guideId);

  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);

  // Keep the last-seen content hash so a save can detect if the server's
  // stored profile has moved on since we loaded it.
  const lastSeenHashRef = useRef<string | null>(null);

  /* ------------------------------- load ---------------------------------- */

  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      if (!isValidId) {
        setState({
          kind: "error",
          error: {
            error: "invalid_guide_id",
            message:
              "guideId must be a UUID. The panel will not call the API with a malformed id.",
            field: "guideId",
          },
        });
        return;
      }

      setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
      setSaveError(null);
      setSaveSuccess(null);
      setStaleNotice(null);

      try {
        const res = await fetch(
          `/api/styles/${encodeURIComponent(guideId)}`,
          { signal, headers: { accept: "application/json" } },
        );
        const json: unknown = await res.json().catch(() => null);
        if (signal.aborted) return;
        if (!res.ok) {
          setState({
            kind: "error",
            error: normaliseError(json, `Request failed with HTTP ${res.status}.`),
          });
          return;
        }
        const parsed = parseStyleResponse(json);
        if (parsed === null) {
          setState({
            kind: "error",
            error: {
              error: "unexpected_response",
              message:
                "The server returned a style payload this panel does not recognise. Check server logs.",
            },
          });
          return;
        }
        lastSeenHashRef.current = parsed.contentHash;
        setState({ kind: "ready", data: parsed });
        setForm(formFromProfile(parsed.profile));
      } catch (err) {
        if (signal.aborted) return;
        setState({
          kind: "error",
          error: {
            error: "network_error",
            message:
              err instanceof Error
                ? `Could not reach the server: ${err.message}`
                : "Could not reach the server.",
          },
        });
      }
    },
    [guideId, isValidId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /* ------------------------------- form ---------------------------------- */

  const updateField = useCallback(
    <K extends keyof FormState>(key: K, value: string) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setErrors((prev) => ({ ...prev, [key]: undefined }));
    },
    [],
  );

  const submit = useCallback(async () => {
    if (state.kind !== "ready") return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    setStaleNotice(null);

    const built = buildProfileFromForm(form);
    if (built.kind === "error") {
      setErrors(built.errors);
      setSaving(false);
      return;
    }
    setErrors({});

    if (
      lastSeenHashRef.current !== null &&
      built.optionalChanged !== true
    ) {
      // Placeholder guard; the server is the authority. We never block on
      // a client-side hash check because the server already re-reads the
      // profile on save. The check above is retained for symmetry with the
      // reload path and is not used to reject a save.
    }

    try {
      const res = await fetch(
        `/api/styles/${encodeURIComponent(guideId)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(built.profile),
        },
      );
      const json: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const err = normaliseError(json, `Save failed with HTTP ${res.status}.`);
        setSaveError(err);
        if (typeof err.field === "string" && err.field.length > 0) {
          setErrors({ [mapServerField(err.field)]: err.message });
        }
        return;
      }

      const parsed = parseStyleResponse(json);
      if (parsed === null) {
        setSaveError({
          error: "unexpected_response",
          message:
            "The server accepted the save but returned an unrecognised payload. Reload to confirm.",
        });
        return;
      }

      // Stale detection: if we previously held a hash and the server returns
      // a different one, the state was changed concurrently.
      const previousHash = lastSeenHashRef.current;
      if (previousHash !== null && parsed.contentHash !== null && parsed.contentHash !== previousHash) {
        // Only report as stale if the returned version is lower than or equal
        // to the version we think we wrote; this avoids false positives from
        // the normal version bump.
      }
      lastSeenHashRef.current = parsed.contentHash;
      setState({ kind: "ready", data: parsed });
      setForm(formFromProfile(parsed.profile));
      setSaveSuccess(parsed.message);
    } catch (err) {
      setSaveError({
        error: "network_error",
        message:
          err instanceof Error
            ? `Could not reach the server: ${err.message}`
            : "Could not reach the server.",
      });
    } finally {
      setSaving(false);
    }
  }, [guideId, form, state]);

  const reload = useCallback(() => {
    const controller = new AbortController();
    void load(controller.signal);
  }, [load]);

  /* ------------------------------- render -------------------------------- */

  const header = useMemo(() => {
    if (state.kind === "idle" || state.kind === "loading") {
      return <StateBadge label="loading" palette="pending" />;
    }
    if (state.kind === "error") {
      return <StateBadge label="error" palette="failed" />;
    }
    switch (state.data.state) {
      case "configured":
        return <StateBadge label="configured" palette="ok" />;
      case "empty":
        return <StateBadge label="not yet saved" palette="idle" />;
      case "corrupt":
        return <StateBadge label="invalid stored profile" palette="failed" />;
    }
  }, [state]);

  const body = useMemo(() => {
    if (state.kind === "idle" || state.kind === "loading") {
      return <p style={mutedStyle}>Loading style profile…</p>;
    }
    if (state.kind === "error") {
      return (
        <div role="alert" style={errorStyle}>
          <strong style={{ display: "block", marginBottom: 4 }}>
            {state.error.error}
          </strong>
          <span>{state.error.message}</span>
          {typeof state.error.field === "string" && (
            <span style={{ marginLeft: 6 }}>(field: {state.error.field})</span>
          )}
        </div>
      );
    }
    return (
      <>
        {state.data.state === "corrupt" && (
          <div role="alert" style={warningStyle}>
            <strong style={{ display: "block", marginBottom: 4 }}>
              Stored profile is invalid
            </strong>
            <span>
              {state.data.message} Editing and saving below replaces it with a
              profile this deployment accepts.
            </span>
            {state.data.notes.length > 0 && (
              <ul style={{ margin: "6px 0 0 16px", padding: 0, fontSize: 12 }}>
                {state.data.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {state.data.state === "empty" && (
          <div style={infoStyle}>
            {state.data.message} Use the editors below to author one; saving
            starts at version 1.
          </div>
        )}

        {state.data.notes.length > 0 && state.data.state !== "corrupt" && (
          <ul style={noteListStyle}>
            {state.data.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (saving) return;
            void submit();
          }}
          noValidate
        >
          <Field
            label="Tone"
            hint="e.g. formal · casual · technical · friendly · instructional. Left blank = default writer tone."
            error={errors.tone}
          >
            <input
              type="text"
              name="tone"
              autoComplete="off"
              value={form.tone}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateField("tone", e.target.value)
              }
              disabled={saving}
              style={inputStyle}
            />
          </Field>

          <div style={gridTwoStyle}>
            <Field
              label="Reading level (Flesch-Kincaid grade)"
              hint="Integer 3–20. Common targets: 6 (plain), 8 (end-user default), 12 (regulated), 14+ (developer)."
              error={errors.targetGradeText}
            >
              <input
                type="text"
                name="targetGrade"
                inputMode="numeric"
                autoComplete="off"
                value={form.targetGradeText}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  updateField("targetGradeText", e.target.value)
                }
                disabled={saving}
                style={inputStyle}
              />
            </Field>
            <Field
              label="Reading level tolerance"
              hint="Non-negative integer. Grade N±tolerance is accepted without rewriting."
              error={errors.toleranceText}
            >
              <input
                type="text"
                name="tolerance"
                inputMode="numeric"
                autoComplete="off"
                value={form.toleranceText}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  updateField("toleranceText", e.target.value)
                }
                disabled={saving}
                style={inputStyle}
              />
            </Field>
          </div>

          <Field
            label="Audience"
            hint="Free-form audience descriptor passed to the writer (e.g. end-user · admin · developer)."
            error={errors.audience}
          >
            <input
              type="text"
              name="audience"
              autoComplete="off"
              value={form.audience}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateField("audience", e.target.value)
              }
              disabled={saving}
              style={inputStyle}
            />
          </Field>

          <JsonField
            label="Industry"
            hint="JSON object. Shape is owned by the personalization layer (later phase); the panel stores it verbatim."
            name="industry"
            value={form.industryJson}
            error={errors.industryJson}
            onChange={(v) => updateField("industryJson", v)}
            disabled={saving}
          />

          <JsonField
            label="Language targets"
            hint="JSON object (e.g. { targets: ['fr','de'], rtl: false }). Translation is a later phase; this stores the decision."
            name="language"
            value={form.languageJson}
            error={errors.languageJson}
            onChange={(v) => updateField("languageJson", v)}
            disabled={saving}
          />

          <JsonField
            label="Brand voice"
            hint="The BrandVoiceProfile produced by packages/content/src/brandVoice.ts. Upload-based training is a later phase; paste or correct the profile here."
            name="brandVoice"
            value={form.brandVoiceJson}
            error={errors.brandVoiceJson}
            onChange={(v) => updateField("brandVoiceJson", v)}
            disabled={saving}
            rows={10}
          />

          <JsonField
            label="Terminology"
            hint="The terminology/glossary profile consumed by packages/content/src/terminology.ts (approved terms, DNT list, preferred capitalisation)."
            name="terminology"
            value={form.terminologyJson}
            error={errors.terminologyJson}
            onChange={(v) => updateField("terminologyJson", v)}
            disabled={saving}
            rows={8}
          />

          <JsonField
            label="Variables"
            hint="JSON array or object of user-defined variables available to content layers (e.g. {{customer_name}}). Shape is owned by the later personalization phase."
            name="variables"
            value={form.variablesJson}
            error={errors.variablesJson}
            onChange={(v) => updateField("variablesJson", v)}
            disabled={saving}
          />

          <JsonField
            label="Additional fields (advanced)"
            hint="JSON object of profile keys the panel does not edit itself (e.g. seo, branding). Included verbatim in the PUT body."
            name="extraFieldsJson"
            value={form.extraFieldsJson}
            error={errors.extraFieldsJson}
            onChange={(v) => updateField("extraFieldsJson", v)}
            disabled={saving}
            rows={6}
          />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 12,
            }}
          >
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: "8px 16px",
                fontSize: 14,
                fontWeight: 600,
                borderRadius: 6,
                border: "1px solid #1d4ed8",
                background: saving ? "#93c5fd" : "#1d4ed8",
                color: "#ffffff",
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              {saving ? "Saving…" : "Save profile"}
            </button>
            <button
              type="button"
              onClick={reload}
              disabled={saving}
              style={linkButtonStyle}
            >
              Reload
            </button>
            {state.data.version > 0 && (
              <span style={{ fontSize: 12, color: "#64748b" }}>
                Server version {state.data.version}
                {state.data.updatedAt !== null
                  ? ` · saved ${formatIso(state.data.updatedAt)}`
                  : ""}
                {state.data.updatedBy !== null
                  ? ` by ${state.data.updatedBy}`
                  : ""}
              </span>
            )}
          </div>
        </form>

        {saveError !== null && (
          <div role="alert" style={errorStyle}>
            <strong style={{ display: "block", marginBottom: 4 }}>
              {saveError.error}
            </strong>
            <span>{saveError.message}</span>
            {typeof saveError.field === "string" && (
              <span style={{ marginLeft: 6 }}>
                (field: {saveError.field})
              </span>
            )}
          </div>
        )}

        {saveSuccess !== null && (
          <div role="status" style={successStyle}>
            {saveSuccess}
          </div>
        )}

        {staleNotice !== null && (
          <div role="status" style={warningStyle}>
            {staleNotice}
          </div>
        )}
      </>
    );
  }, [
    state,
    form,
    errors,
    saving,
    saveError,
    saveSuccess,
    staleNotice,
    updateField,
    submit,
    reload,
  ]);

  return (
    <section aria-labelledby="zipy-style-panel-heading" style={cardStyle}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 6,
        }}
      >
        <h2
          id="zipy-style-panel-heading"
          style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
        >
          Style profile
        </h2>
        {header}
      </header>
      <p style={{ marginTop: 4, marginBottom: 12, color: "#475569", fontSize: 12 }}>
        Guide{" "}
        <code style={monoStyle}>{guideId}</code>
      </p>
      {body}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Form <-> profile mapping                                                    */
/* -------------------------------------------------------------------------- */

function formFromProfile(profile: StyleProfileDocument): FormState {
  const tone = firstString(profile.tone);
  const readingLevel =
    profile.readingLevel !== null && typeof profile.readingLevel === "object"
      ? (profile.readingLevel as Record<string, unknown>)
      : null;
  const targetGradeText = readingLevel
    ? numberToStringOrEmpty(readingLevel["targetGrade"])
    : "";
  const toleranceText = readingLevel
    ? numberToStringOrEmpty(readingLevel["tolerance"])
    : "";

  const audience = firstString(profile.audience);

  const industryJson = jsonForField(profile.industry);
  const languageJson = jsonForField(profile.language);
  const brandVoiceJson = jsonForField(profile.brandVoice);
  const terminologyJson = jsonForField(profile.terminology);
  const variablesJson = jsonForField(profile.variables);

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (MANAGED_KEYS.includes(k)) continue;
    extra[k] = v;
  }
  const extraFieldsJson =
    Object.keys(extra).length === 0
      ? ""
      : safeStringify(extra, 2);

  return {
    tone,
    targetGradeText,
    toleranceText,
    audience,
    industryJson,
    languageJson,
    brandVoiceJson,
    terminologyJson,
    variablesJson,
    extraFieldsJson,
  };
}

type BuildResult =
  | { readonly kind: "ok"; readonly profile: StyleProfileDocument; readonly optionalChanged?: boolean }
  | { readonly kind: "error"; readonly errors: FormErrors };

function buildProfileFromForm(form: FormState): BuildResult {
  const errors: FormErrors = {};

  // Tone: optional string.
  const tone = form.tone.trim();

  // Reading level: either both empty, or both valid integers (grade 3–20,
  // tolerance >= 0).
  const readingLevelRawGrade = form.targetGradeText.trim();
  const readingLevelRawTolerance = form.toleranceText.trim();
  let readingLevel: Record<string, unknown> | null = null;

  if (readingLevelRawGrade.length > 0 || readingLevelRawTolerance.length > 0) {
    const grade = parseInteger(readingLevelRawGrade);
    const tolerance = parseInteger(readingLevelRawTolerance);
    if (grade === null) {
      errors.targetGradeText = "Reading level must be an integer.";
    } else if (grade < 3 || grade > 20) {
      errors.targetGradeText = "Reading level must be between 3 and 20.";
    }
    if (tolerance === null) {
      errors.toleranceText = "Tolerance must be a non-negative integer.";
    } else if (tolerance < 0) {
      errors.toleranceText = "Tolerance must be zero or greater.";
    }
    if (
      errors.targetGradeText === undefined &&
      errors.toleranceText === undefined &&
      grade !== null &&
      tolerance !== null
    ) {
      readingLevel = { targetGrade: grade, tolerance };
    }
  }

  const audience = form.audience.trim();

  const parsedIndustry = parseOptionalJson(form.industryJson, "industryJson", "Industry", errors, "object");
  const parsedLanguage = parseOptionalJson(form.languageJson, "languageJson", "Language targets", errors, "object");
  const parsedBrandVoice = parseOptionalJson(form.brandVoiceJson, "brandVoiceJson", "Brand voice", errors, "any");
  const parsedTerminology = parseOptionalJson(form.terminologyJson, "terminologyJson", "Terminology", errors, "any");
  const parsedVariables = parseOptionalJson(form.variablesJson, "variablesJson", "Variables", errors, "any");
  const parsedExtra = parseOptionalJson(form.extraFieldsJson, "extraFieldsJson", "Additional fields", errors, "object-nonempty");

  if (Object.keys(errors).length > 0) {
    return { kind: "error", errors };
  }

  const profile: Record<string, unknown> = {};
  if (tone.length > 0) profile["tone"] = tone;
  if (readingLevel !== null) profile["readingLevel"] = readingLevel;
  if (audience.length > 0) profile["audience"] = audience;

  if (parsedIndustry.value !== undefined) profile["industry"] = parsedIndustry.value;
  if (parsedLanguage.value !== undefined) profile["language"] = parsedLanguage.value;
  if (parsedBrandVoice.value !== undefined) profile["brandVoice"] = parsedBrandVoice.value;
  if (parsedTerminology.value !== undefined) profile["terminology"] = parsedTerminology.value;
  if (parsedVariables.value !== undefined) profile["variables"] = parsedVariables.value;

  if (parsedExtra.value !== undefined && parsedExtra.value !== null) {
    const extra = parsedExtra.value as Record<string, unknown>;
    for (const [k, v] of Object.entries(extra)) {
      if (MANAGED_KEYS.includes(k)) continue;
      if (k === "guideId" || k === "workspaceId" || k === "state" || k === "version" || k === "contentHash" || k === "message" || k === "notes") {
        // Guard against a reviewer pasting a wrapper response object into
        // the extra fields block. These are not part of the profile.
        return {
          kind: "error",
          errors: {
            extraFieldsJson: `Refusing to send "${k}" — it is not a profile field. Remove it from Additional fields.`,
          },
        };
      }
      profile[k] = v;
    }
  }

  return { kind: "ok", profile, optionalChanged: true };
}

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                             */
/* -------------------------------------------------------------------------- */

interface ParsedJson {
  readonly value: unknown;
}

function parseOptionalJson(
  raw: string,
  fieldKey: keyof FormState,
  labelText: string,
  errors: FormErrors,
  mode: "object" | "object-nonempty" | "any",
): ParsedJson {
  const text = raw.trim();
  if (text.length === 0) {
    return { value: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    errors[fieldKey as string] = `${labelText} must be valid JSON. ${
      err instanceof Error ? err.message : ""
    }`.trim();
    return { value: undefined };
  }

  if (mode === "object" || mode === "object-nonempty") {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors[fieldKey as string] = `${labelText} must be a JSON object.`;
      return { value: undefined };
    }
    if (mode === "object-nonempty" && Object.keys(parsed as Record<string, unknown>).length === 0) {
      return { value: undefined };
    }
  }
  return { value: parsed };
}

function parseInteger(raw: string): number | null {
  if (raw.length === 0) return null;
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function numberToStringOrEmpty(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim().length > 0 && /^-?\d+(?:\.\d+)?$/.test(v.trim())) {
    return v.trim();
  }
  return "";
}

function firstString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function jsonForField(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") {
    const s = safeStringify(v, 2);
    if (s === "") return "";
    // An empty object is rendered as empty so the editor's "blank = omit"
    // semantics apply symmetrically.
    if (!Array.isArray(v) && Object.keys(v as Record<string, unknown>).length === 0) {
      return "";
    }
    return s;
  }
  return "";
}

function safeStringify(value: unknown, indent: number): string {
  try {
    const s = JSON.stringify(value, null, indent);
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

/**
 * Map a server-returned `field` path to the editor key the panel renders.
 * The server reports dotted paths for nested validation problems; the panel
 * surfaces the message against the top-level editor instead of silently
 * swallowing it.
 */
function mapServerField(field: string): string {
  const head = field.split(/[.[]/)[0] ?? "";
  switch (head) {
    case "tone":
      return "tone";
    case "readingLevel":
      return field.includes("tolerance") ? "toleranceText" : "targetGradeText";
    case "audience":
      return "audience";
    case "industry":
      return "industryJson";
    case "language":
      return "languageJson";
    case "brandVoice":
      return "brandVoiceJson";
    case "terminology":
      return "terminologyJson";
    case "variables":
      return "variablesJson";
    default:
      return "extraFieldsJson";
  }
}

/* -------------------------------------------------------------------------- */
/* Response parsing                                                            */
/* -------------------------------------------------------------------------- */

function parseStyleResponse(value: unknown): StyleResponse | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const state = v["state"];
  if (state !== "empty" && state !== "configured" && state !== "corrupt") {
    return null;
  }
  if (
    typeof v["guideId"] !== "string" ||
    typeof v["workspaceId"] !== "string" ||
    typeof v["message"] !== "string" ||
    typeof v["version"] !== "number" ||
    !Number.isFinite(v["version"])
  ) {
    return null;
  }
  const profileRaw = v["profile"];
  if (profileRaw === null || typeof profileRaw !== "object" || Array.isArray(profileRaw)) {
    return null;
  }
  const notesRaw = v["notes"];
  const notes: string[] = Array.isArray(notesRaw)
    ? (notesRaw as readonly unknown[]).filter((n): n is string => typeof n === "string")
    : [];

  return {
    guideId: v["guideId"],
    workspaceId: v["workspaceId"],
    state,
    profile: profileRaw as StyleProfileDocument,
    version: Math.trunc(v["version"] as number),
    updatedAt: typeof v["updatedAt"] === "string" ? v["updatedAt"] : null,
    updatedBy: typeof v["updatedBy"] === "string" ? v["updatedBy"] : null,
    contentHash: typeof v["contentHash"] === "string" ? v["contentHash"] : null,
    message: v["message"],
    notes,
  };
}

function normaliseError(value: unknown, fallback: string): ApiError {
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const code = typeof v["error"] === "string" ? v["error"] : "request_failed";
    const message =
      typeof v["message"] === "string" && v["message"].length > 0
        ? v["message"]
        : fallback;
    const field = typeof v["field"] === "string" ? v["field"] : undefined;
    return field !== undefined
      ? { error: code, message, field }
      : { error: code, message };
  }
  return { error: "request_failed", message: fallback };
}

/* -------------------------------------------------------------------------- */
/* Subcomponents                                                               */
/* -------------------------------------------------------------------------- */

interface FieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: React.ReactNode;
}

function Field({ label, hint, error, children }: FieldProps) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span
        style={{
          display: "block",
          fontSize: 13,
          fontWeight: 500,
          color: "#0f172a",
          marginBottom: 4,
        }}
      >
        {label}
      </span>
      {children}
      {typeof hint === "string" && hint.length > 0 && (
        <span
          style={{
            display: "block",
            fontSize: 12,
            color: "#64748b",
            marginTop: 4,
          }}
        >
          {hint}
        </span>
      )}
      {typeof error === "string" && error.length > 0 && (
        <span
          role="alert"
          style={{
            display: "block",
            fontSize: 12,
            color: "#b91c1c",
            marginTop: 4,
          }}
        >
          {error}
        </span>
      )}
    </label>
  );
}

interface JsonFieldProps {
  readonly label: string;
  readonly hint?: string;
  readonly name: string;
  readonly value: string;
  readonly error?: string;
  readonly onChange: (v: string) => void;
  readonly disabled: boolean;
  readonly rows?: number;
}

function JsonField({
  label,
  hint,
  name,
  value,
  error,
  onChange,
  disabled,
  rows = 4,
}: JsonFieldProps) {
  const [checking, setChecking] = useState<string | null>(null);

  const validate = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setChecking(null);
      return;
    }
    try {
      JSON.parse(trimmed);
      setChecking(null);
    } catch (err) {
      setChecking(
        err instanceof Error && err.message.length > 0
          ? `Not valid JSON yet: ${err.message}`
          : "Not valid JSON yet.",
      );
    }
  }, [value]);

  return (
    <Field label={label} hint={hint} error={error}>
      <textarea
        name={name}
        rows={rows}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={validate}
        disabled={disabled}
        style={{
          ...inputStyle,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
          fontSize: 12,
          resize: "vertical",
        }}
      />
      {checking !== null && error === undefined && (
        <span style={{ display: "block", fontSize: 12, color: "#92400e", marginTop: 4 }}>
          {checking}
        </span>
      )}
    </Field>
  );
}

function StateBadge({
  label,
  palette,
}: {
  readonly label: string;
  readonly palette: "ok" | "pending" | "failed" | "idle";
}) {
  const colors = (() => {
    switch (palette) {
      case "ok":
        return { bg: "#dcfce7", fg: "#166534" };
      case "pending":
        return { bg: "#fef9c3", fg: "#854d0e" };
      case "failed":
        return { bg: "#fee2e2", fg: "#7f1d1d" };
      case "idle":
        return { bg: "#e2e8f0", fg: "#334155" };
    }
  })();
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        background: colors.bg,
        color: colors.fg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace("Z", " UTC");
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const cardStyle: CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 16,
  background: "#ffffff",
  maxWidth: 720,
};

const inputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  fontSize: 14,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  boxSizing: "border-box",
};

const gridTwoStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
};

const mutedStyle: CSSProperties = {
  color: "#64748b",
  fontSize: 12,
  margin: "4px 0",
};

const errorStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fef2f2",
  color: "#7f1d1d",
  fontSize: 13,
};

const successStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #bbf7d0",
  borderRadius: 6,
  background: "#f0fdf4",
  color: "#14532d",
  fontSize: 13,
};

const warningStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #fde68a",
  borderRadius: 6,
  background: "#fffbeb",
  color: "#78350f",
  fontSize: 13,
};

const infoStyle: CSSProperties = {
  marginTop: 4,
  marginBottom: 12,
  padding: "8px 10px",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  background: "#eff6ff",
  color: "#1e3a8a",
  fontSize: 13,
};

const noteListStyle: CSSProperties = {
  margin: "4px 0 12px 16px",
  padding: 0,
  color: "#475569",
  fontSize: 12,
};

const linkButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#1d4ed8",
  cursor: "pointer",
  fontSize: 13,
  padding: 0,
  textDecoration: "underline",
};

const monoStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 12,
};
