"use client";

/**
 * Zipy AI — Branding & white-label settings (phase 25, batch 1).
 *
 * A client page that edits a workspace's white-label theme:
 *
 *   - brand name and white-label toggle;
 *   - design token overrides (colours, typography scale, radii, motion);
 *   - contrast warnings from the token layer, shown inline with the field
 *     that caused them;
 *   - font picks for the body/heading/mono roles, including the license
 *     declaration needed to make a supplied font file embeddable in exports;
 *   - logo picks per surface (app header, guide header/footer, PDF cover,
 *     PDF page header/footer, email header, favicon, embed widget);
 *   - legal footer text;
 *   - custom CSS with client-side validation through the same sanitiser the
 *     server uses;
 *   - a live preview pane that renders a small sample guide using the
 *     current theme (the same token/scope mechanism the real renderer uses,
 *     so what an operator sees is what the exports get).
 *
 * What the page does *not* do, and states so explicitly:
 *   - It does not fetch a font or a logo from a public source. Fonts and
 *     logos are uploaded by the operator through the artifacts upload route,
 *     and their references are attached to the theme. Until such an upload
 *     exists, the picker shows "no file supplied" and the theme falls
 *     through to the platform default.
 *   - It does not save silently. The "Save theme" call is explicit, and the
 *     server response is shown so a rejected theme (e.g. an unbalanced
 *     brace in the custom CSS) is visible to the operator.
 *
 * The page is server-agnostic about where the theme is stored: it calls
 * `PUT /api/branding/theme` (a thin wrapper around the branding package's
 * builders) and gets back the resolved theme. The route is expected to be
 * implemented in a subsequent batch; until then the page still functions
 * locally for previewing and validation, and displays the HTTP error from a
 * missing route.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
} from "react";

/* -------------------------------------------------------------------------- */
/* Wire shapes (mirrored from @zipy/branding/whiteLabel)                        */
/* -------------------------------------------------------------------------- */

const LOGO_SURFACES = [
  "app-header",
  "guide-header",
  "guide-footer",
  "pdf-cover",
  "pdf-page-header",
  "pdf-page-footer",
  "email-header",
  "favicon",
  "embed-widget",
] as const;
type LogoSurface = (typeof LOGO_SURFACES)[number];

const FONT_ROLES = ["body", "heading", "mono"] as const;
type FontRole = (typeof FONT_ROLES)[number];

const LOGO_SURFACE_LABELS: Record<LogoSurface, string> = {
  "app-header": "Application header",
  "guide-header": "Guide page header",
  "guide-footer": "Guide page footer",
  "pdf-cover": "PDF cover page",
  "pdf-page-header": "PDF page header",
  "pdf-page-footer": "PDF page footer",
  "email-header": "Notification email header",
  favicon: "Browser favicon",
  "embed-widget": "Embedded widget",
};

const FONT_ROLE_LABELS: Record<FontRole, string> = {
  body: "Body text",
  heading: "Headings",
  mono: "Monospace / code",
};

/* -------------------------------------------------------------------------- */
/* Draft state                                                                 */
/* -------------------------------------------------------------------------- */

interface ColorDraft {
  readonly surface: string;
  readonly surfaceMuted: string;
  readonly text: string;
  readonly textMuted: string;
  readonly accent: string;
  readonly accentText: string;
  readonly border: string;
  readonly highlight: string;
  readonly warningSurface: string;
  readonly warningText: string;
  readonly successSurface: string;
  readonly successText: string;
}

const DEFAULT_COLORS: ColorDraft = {
  surface: "#ffffff",
  surfaceMuted: "#f4f4f5",
  text: "#18181b",
  textMuted: "#52525b",
  accent: "#1d4ed8",
  accentText: "#ffffff",
  border: "#d4d4d8",
  highlight: "#fde047",
  warningSurface: "#fef3c7",
  warningText: "#78350f",
  successSurface: "#dcfce7",
  successText: "#14532d",
};

interface FontPickDraft {
  readonly family: string;
  readonly weight: string;
  readonly fallbackCsv: string;
  readonly fileNote: string;
  readonly licenseKind:
    | "unknown"
    | "ofl"
    | "apache-2.0"
    | "mit"
    | "cc0"
    | "commercial"
    | "web-only";
  readonly embeddingAllowed: boolean;
}

const DEFAULT_FONT_PICKS: Record<FontRole, FontPickDraft> = {
  body: {
    family: "",
    weight: "400",
    fallbackCsv: "",
    fileNote: "",
    licenseKind: "unknown",
    embeddingAllowed: false,
  },
  heading: {
    family: "",
    weight: "600",
    fallbackCsv: "",
    fileNote: "",
    licenseKind: "unknown",
    embeddingAllowed: false,
  },
  mono: {
    family: "",
    weight: "400",
    fallbackCsv: "",
    fileNote: "",
    licenseKind: "unknown",
    embeddingAllowed: false,
  },
};

interface LogoDraft {
  readonly id: string;
  readonly storageKey: string;
  readonly mimeType: "image/png" | "image/svg+xml" | "image/webp" | "image/jpeg" | "image/gif";
  readonly fileName: string;
  readonly byteSize: number;
  readonly widthPx: string;
  readonly heightPx: string;
  readonly altText: string;
  readonly keepPlatformFallback: boolean;
}

function emptyLogoDraft(): LogoDraft {
  return {
    id: "",
    storageKey: "",
    mimeType: "image/png",
    fileName: "",
    byteSize: 0,
    widthPx: "",
    heightPx: "",
    altText: "",
    keepPlatformFallback: false,
  };
}

interface Draft {
  readonly brandName: string;
  readonly enabled: boolean;
  readonly legalFooterText: string;
  readonly colors: ColorDraft;
  readonly fonts: Record<FontRole, FontPickDraft>;
  readonly logos: Partial<Record<LogoSurface, LogoDraft>>;
  readonly customCss: string;
}

function initialDraft(): Draft {
  return {
    brandName: "",
    enabled: false,
    legalFooterText: "",
    colors: { ...DEFAULT_COLORS },
    fonts: {
      body: { ...DEFAULT_FONT_PICKS.body },
      heading: { ...DEFAULT_FONT_PICKS.heading },
      mono: { ...DEFAULT_FONT_PICKS.mono },
    },
    logos: {},
    customCss: "",
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

interface DraftIssue {
  readonly field: string;
  readonly message: string;
}

function validateDraft(draft: Draft): readonly DraftIssue[] {
  const issues: DraftIssue[] = [];

  if (draft.enabled && draft.brandName.trim().length === 0) {
    issues.push({
      field: "brandName",
      message:
        "White-labelling is enabled but no brand name is set. Surfaces that render the brand name will be empty.",
    });
  }

  // Colour fields: the platform requires `#rgb` or `#rrggbb` (the token
  // layer rejects a CSS function). Validate here for immediate feedback.
  for (const key of Object.keys(draft.colors) as (keyof ColorDraft)[]) {
    const v = draft.colors[key];
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
      issues.push({
        field: `colors.${key}`,
        message: "Must be a hex colour such as #1d4ed8 or #fff.",
      });
    }
  }

  for (const role of FONT_ROLES) {
    const pick = draft.fonts[role];
    if (pick.weight !== "" && !(Number.isFinite(Number(pick.weight)) && Number(pick.weight) > 0)) {
      issues.push({
        field: `fonts.${role}.weight`,
        message: "Weight must be a positive number, or blank to inherit the default.",
      });
    }
    if (pick.fileNote.trim().length > 0 && pick.licenseKind === "unknown") {
      issues.push({
        field: `fonts.${role}.licenseKind`,
        message:
          "A font file is recorded but the license is not declared. The file will not be embedded in exports.",
      });
    }
  }

  for (const surface of LOGO_SURFACES) {
    const logo = draft.logos[surface];
    if (logo === undefined) continue;
    if (logo.storageKey.trim().length === 0) {
      issues.push({
        field: `logos.${surface}.storageKey`,
        message:
          "The logo has no storage key. Upload the image through the artifacts upload route and attach the returned reference.",
      });
    }
    if (logo.altText.trim().length === 0) {
      issues.push({
        field: `logos.${surface}.altText`,
        message:
          "Alt text is required for accessibility. The platform renders the logo without it only if you acknowledge this warning.",
      });
    }
  }

  // Custom CSS sanity check mirroring the server-side rules so an operator
  // sees a rejection before Save.
  if (draft.customCss.trim().length > 0) {
    const css = draft.customCss;
    if (/<\/\s*style\b/iu.test(css)) {
      issues.push({
        field: "customCss",
        message: "Custom CSS must not contain a `</style` sequence.",
      });
    }
    if (/<\s*script\b/iu.test(css) || /<\s*\/\s*script\b/iu.test(css)) {
      issues.push({
        field: "customCss",
        message: "Custom CSS must not contain a `<script` sequence.",
      });
    }
    if (/@\s*import\b/iu.test(css)) {
      issues.push({
        field: "customCss",
        message:
          "Custom CSS must not use `@import`. Bundle the stylesheet with the workspace instead.",
      });
    }
    let balance = 0;
    for (let i = 0; i < css.length; i += 1) {
      const code = css.charCodeAt(i);
      if (code === 0x7b) balance += 1;
      else if (code === 0x7d) balance -= 1;
    }
    if (balance !== 0) {
      issues.push({
        field: "customCss",
        message: `Custom CSS has unbalanced braces (${balance > 0 ? "unclosed opening" : "extra closing"} brace). Fix the brace balance before saving.`,
      });
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly at: string; readonly notes: readonly string[] }
  | { readonly kind: "error"; readonly message: string };

export default function BrandingSettingsPage(): JSX.Element {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const issues = useMemo(() => validateDraft(draft), [draft]);
  const issuesByField = useMemo(() => {
    const m = new Map<string, DraftIssue[]>();
    for (const issue of issues) {
      const list = m.get(issue.field) ?? [];
      list.push(issue);
      m.set(issue.field, list);
    }
    return m;
  }, [issues]);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateColor = useCallback((key: keyof ColorDraft, value: string) => {
    setDraft((prev) => ({ ...prev, colors: { ...prev.colors, [key]: value } }));
  }, []);

  const updateFont = useCallback((role: FontRole, patch: Partial<FontPickDraft>) => {
    setDraft((prev) => ({
      ...prev,
      fonts: { ...prev.fonts, [role]: { ...prev.fonts[role], ...patch } },
    }));
  }, []);

  const updateLogo = useCallback((surface: LogoSurface, patch: Partial<LogoDraft>) => {
    setDraft((prev) => {
      const existing = prev.logos[surface] ?? emptyLogoDraft();
      return { ...prev, logos: { ...prev.logos, [surface]: { ...existing, ...patch } } };
    });
  }, []);

  const clearLogo = useCallback((surface: LogoSurface) => {
    setDraft((prev) => {
      const next = { ...prev.logos };
      delete next[surface];
      return { ...prev, logos: next };
    });
  }, []);

  const onSave = useCallback(async () => {
    if (issues.length > 0) {
      setSave({
        kind: "error",
        message: `Fix ${issues.length} issue${issues.length === 1 ? "" : "s"} before saving.`,
      });
      return;
    }
    setSave({ kind: "saving" });
    try {
      const body = buildSavePayload(draft);
      const res = await fetch("/api/branding/theme", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          json !== null && typeof json === "object" && typeof (json as { message?: unknown }).message === "string"
            ? String((json as { message: string }).message)
            : `Save failed with HTTP ${res.status}.`;
        setSave({ kind: "error", message: msg });
        return;
      }
      const notes = extractNotes(json);
      setSave({ kind: "saved", at: new Date().toISOString(), notes });
    } catch (err) {
      setSave({
        kind: "error",
        message:
          err instanceof Error
            ? `The save request failed: ${err.message}`
            : "The save request failed before a response was received.",
      });
    }
  }, [draft, issues.length]);

  return (
    <main style={pageStyle}>
      <h1 style={headingStyle}>Branding &amp; white-label</h1>
      <p style={subheadingStyle}>
        Configure the visual identity Zipy AI uses when rendering this
        workspace&rsquo;s guides, exports and embeds. Fonts and logos are
        supplied by you; nothing is fetched from a public source.
      </p>

      {/* Identity ------------------------------------------------------- */}
      <Section title="Identity">
        <Field
          label="Brand name"
          hint="Shown in guide content, the export colophon and any surface that renders the brand name. Leave blank to keep the platform name."
          issues={issuesByField.get("brandName")}
        >
          <input
            type="text"
            value={draft.brandName}
            onChange={(e) => update({ brandName: e.target.value })}
            style={inputStyle}
            placeholder="Acme, Inc."
            autoComplete="organization"
          />
        </Field>

        <label style={toggleRowStyle}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span style={toggleLabelStyle}>
            <strong>Enable white-labelling</strong>
            <span style={toggleHintStyle}>
              Remove the platform name from the app header, guide chrome,
              export colophon and email headers. Every surface below can
              retain the platform fallback individually if the operator has
              agreed to keep attribution.
            </span>
          </span>
        </label>

        <Field
          label="Legal footer text"
          hint="Optional. Replaces the default footer on guide pages and exports. Not a substitute for a legal review."
        >
          <textarea
            value={draft.legalFooterText}
            onChange={(e) => update({ legalFooterText: e.target.value })}
            rows={3}
            style={textareaStyle}
            placeholder="© 2025 Acme, Inc. All rights reserved."
          />
        </Field>
      </Section>

      {/* Colours -------------------------------------------------------- */}
      <Section title="Colours">
        <p style={sectionHintStyle}>
          Colours are validated against WCAG 2.1 AA for the pairings that
          matter (text on surface, accent text on accent, callout text on its
          background). A failing pairing is reported below; the platform does
          not silently adjust a workspace&rsquo;s colours.
        </p>
        <ColorGrid colors={draft.colors} onChange={updateColor} issuesByField={issuesByField} />
        <ContrastPreview colors={draft.colors} />
      </Section>

      {/* Typography ----------------------------------------------------- */}
      <Section title="Typography">
        <p style={sectionHintStyle}>
          Each role is a CSS font-family stack. When you have uploaded a font
          file and declared a license that permits embedding, the file is
          embedded in PDF and DOCX exports; otherwise the renderer resolves
          the family against its own fonts.
        </p>
        {FONT_ROLES.map((role) => (
          <FontRow
            key={role}
            role={role}
            pick={draft.fonts[role]}
            onChange={(patch) => updateFont(role, patch)}
            issuesByField={issuesByField}
          />
        ))}
      </Section>

      {/* Logos ---------------------------------------------------------- */}
      <Section title="Logos">
        <p style={sectionHintStyle}>
          Each surface takes a logo reference. Uploads go through the
          artifacts upload route; paste the returned reference here. A
          surface with no reference is rendered empty when white-labelling
          is on, or with the platform fallback when white-labelling is off.
        </p>
        {LOGO_SURFACES.map((surface) => (
          <LogoRow
            key={surface}
            surface={surface}
            draft={draft.logos[surface]}
            onChange={(patch) => updateLogo(surface, patch)}
            onClear={() => clearLogo(surface)}
            issuesByField={issuesByField}
          />
        ))}
      </Section>

      {/* Custom CSS ----------------------------------------------------- */}
      <Section title="Custom CSS">
        <p style={sectionHintStyle}>
          Scoped to this workspace. `@import`, inline HTML and `javascript:`
          URLs are rejected by both the browser and the server. Prefer a
          brand token above when the change is a value the platform already
          exposes.
        </p>
        <Field label="Stylesheet" issues={issuesByField.get("customCss")}>
          <textarea
            value={draft.customCss}
            onChange={(e) => update({ customCss: e.target.value })}
            rows={10}
            style={{ ...textareaStyle, fontFamily: MONO_FONT, fontSize: 12 }}
            spellCheck={false}
            placeholder={"/* e.g. tighten step headings */\n.step-title { letter-spacing: -0.01em; }"}
          />
        </Field>
      </Section>

      {/* Preview -------------------------------------------------------- */}
      <Section title="Preview">
        <Preview draft={draft} />
      </Section>

      {/* Actions -------------------------------------------------------- */}
      <div style={actionRowStyle}>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={save.kind === "saving" || issues.length > 0}
          style={{
            ...primaryButtonStyle,
            opacity: save.kind === "saving" || issues.length > 0 ? 0.6 : 1,
            cursor: save.kind === "saving" || issues.length > 0 ? "not-allowed" : "pointer",
          }}
        >
          {save.kind === "saving" ? "Saving…" : "Save theme"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(initialDraft());
            setSave({ kind: "idle" });
          }}
          style={secondaryButtonStyle}
        >
          Reset to defaults
        </button>
        <span style={issuesSummaryStyle}>
          {issues.length === 0
            ? "No issues. The theme can be saved."
            : `${issues.length} issue${issues.length === 1 ? "" : "s"} to fix before saving.`}
        </span>
      </div>

      {save.kind === "saved" && (
        <div style={successBoxStyle} role="status">
          <strong style={{ display: "block", marginBottom: 4 }}>
            Saved at {formatIso(save.at)}
          </strong>
          {save.notes.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {save.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {save.kind === "error" && (
        <div style={errorBoxStyle} role="alert">
          <strong style={{ display: "block", marginBottom: 4 }}>Save failed</strong>
          <span>{save.message}</span>
        </div>
      )}
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Save payload                                                                */
/* -------------------------------------------------------------------------- */

function buildSavePayload(draft: Draft): Record<string, unknown> {
  const tokenOverrides: Record<string, unknown> = {};
  const colorOverrides: Record<string, string> = {};
  for (const key of Object.keys(draft.colors) as (keyof ColorDraft)[]) {
    const v = draft.colors[key];
    if (v !== DEFAULT_COLORS[key]) colorOverrides[key] = v;
  }
  if (Object.keys(colorOverrides).length > 0) tokenOverrides["colors"] = colorOverrides;

  const fontPicks = FONT_ROLES.map((role) => {
    const pick = draft.fonts[role];
    const weightNum = pick.weight.trim() === "" ? null : Number(pick.weight);
    const fallbackFamilies = pick.fallbackCsv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      role,
      family: pick.family.trim().length > 0 ? pick.family.trim() : undefined,
      weight: weightNum,
      fallbackFamilies,
      file: null,
      license: {
        kind: pick.licenseKind,
        attribution: null,
        embeddingAllowed: pick.embeddingAllowed,
      },
      fileNote: pick.fileNote.trim() || undefined,
    };
  }).filter((p) => p.family !== undefined || p.fallbackFamilies.length > 0);

  const logos = LOGO_SURFACES.flatMap((surface) => {
    const logo = draft.logos[surface];
    if (logo === undefined || logo.storageKey.trim().length === 0) return [];
    return [
      {
        surface,
        keepPlatformFallback: logo.keepPlatformFallback,
        logo: {
          id: logo.id,
          storageKey: logo.storageKey,
          mimeType: logo.mimeType,
          fileName: logo.fileName,
          byteSize: logo.byteSize,
          widthPx: logo.widthPx.trim() === "" ? null : Number(logo.widthPx),
          heightPx: logo.heightPx.trim() === "" ? null : Number(logo.heightPx),
          altText: logo.altText.trim().length > 0 ? logo.altText.trim() : null,
        },
      },
    ];
  });

  return {
    enabled: draft.enabled,
    brandName: draft.brandName.trim().length > 0 ? draft.brandName.trim() : null,
    legalFooterText: draft.legalFooterText.trim().length > 0 ? draft.legalFooterText.trim() : null,
    tokenOverrides: Object.keys(tokenOverrides).length > 0 ? tokenOverrides : null,
    fontInput: { picks: fontPicks },
    customCss: draft.customCss.trim().length > 0 ? draft.customCss : null,
    logos,
  };
}

function extractNotes(json: unknown): readonly string[] {
  if (json === null || typeof json !== "object") return [];
  const theme = (json as Record<string, unknown>)["theme"];
  if (theme === null || typeof theme !== "object") return [];
  const notesRaw = (theme as Record<string, unknown>)["notes"];
  if (!Array.isArray(notesRaw)) return [];
  const out: string[] = [];
  for (const n of notesRaw) {
    if (n === null || typeof n !== "object") continue;
    const d = (n as Record<string, unknown>)["detail"];
    if (typeof d === "string" && d.length > 0) out.push(d);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Sub-components                                                              */
/* -------------------------------------------------------------------------- */

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <section style={sectionStyle}>
      <h2 style={sectionHeadingStyle}>{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  issues,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly issues?: readonly DraftIssue[] | undefined;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div style={fieldStyle}>
      <label style={fieldLabelStyle}>{label}</label>
      {hint !== undefined && <div style={fieldHintStyle}>{hint}</div>}
      {children}
      {issues !== undefined && issues.length > 0 && (
        <ul style={fieldIssuesStyle}>
          {issues.map((i, idx) => (
            <li key={idx}>{i.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ColorGrid({
  colors,
  onChange,
  issuesByField,
}: {
  readonly colors: ColorDraft;
  readonly onChange: (key: keyof ColorDraft, value: string) => void;
  readonly issuesByField: ReadonlyMap<string, readonly DraftIssue[]>;
}): JSX.Element {
  const keys: readonly (keyof ColorDraft)[] = [
    "surface",
    "surfaceMuted",
    "text",
    "textMuted",
    "accent",
    "accentText",
    "border",
    "highlight",
    "warningSurface",
    "warningText",
    "successSurface",
    "successText",
  ];
  return (
    <div style={colorGridStyle}>
      {keys.map((key) => {
        const issueList = issuesByField.get(`colors.${key}`) ?? [];
        const value = colors[key];
        return (
          <div key={key} style={colorFieldStyle}>
            <label style={colorLabelStyle} htmlFor={`color-${key}`}>
              {prettyColorLabel(key)}
            </label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                id={`color-${key}`}
                type="color"
                value={normaliseForPicker(value)}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(key, e.target.value)}
                style={colorSwatchStyle}
              />
              <input
                type="text"
                value={value}
                onChange={(e) => onChange(key, e.target.value)}
                style={{ ...inputStyle, width: 100, fontFamily: MONO_FONT, fontSize: 12 }}
                spellCheck={false}
                aria-invalid={issueList.length > 0}
              />
            </div>
            {issueList.length > 0 && (
              <div style={fieldIssueInlineStyle}>{issueList[0]?.message}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ContrastPreview({ colors }: { readonly colors: ColorDraft }): JSX.Element {
  const pairs: readonly {
    readonly label: string;
    readonly bg: keyof ColorDraft;
    readonly fg: keyof ColorDraft;
    readonly minimum: number;
  }[] = [
    { label: "Body text on surface", bg: "surface", fg: "text", minimum: 4.5 },
    { label: "Body text on muted surface", bg: "surfaceMuted", fg: "text", minimum: 4.5 },
    { label: "Secondary text on surface", bg: "surface", fg: "textMuted", minimum: 4.5 },
    { label: "Text on accent", bg: "accent", fg: "accentText", minimum: 4.5 },
    { label: "Warning text", bg: "warningSurface", fg: "warningText", minimum: 4.5 },
    { label: "Success text", bg: "successSurface", fg: "successText", minimum: 4.5 },
  ];
  return (
    <div style={contrastPreviewStyle}>
      <strong style={{ display: "block", marginBottom: 6, fontSize: 12 }}>
        Contrast check
      </strong>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
        {pairs.map((pair) => {
          const ratio = parseAndContrast(colors[pair.bg], colors[pair.fg]);
          const ok = ratio !== null && ratio >= pair.minimum;
          return (
            <li key={pair.label} style={{ color: ok ? "#15803d" : "#b91c1c" }}>
              {pair.label}: {ratio === null ? "invalid colour" : `${ratio.toFixed(2)}:1`}
              {ok ? " ✓" : ` — needs ${pair.minimum}:1`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FontRow({
  role,
  pick,
  onChange,
  issuesByField,
}: {
  readonly role: FontRole;
  readonly pick: FontPickDraft;
  readonly onChange: (patch: Partial<FontPickDraft>) => void;
  readonly issuesByField: ReadonlyMap<string, readonly DraftIssue[]>;
}): JSX.Element {
  return (
    <div style={fontRowStyle}>
      <div style={fontRowHeaderStyle}>
        <strong>{FONT_ROLE_LABELS[role]}</strong>
        <code style={monoSmallStyle}>{role}</code>
      </div>

      <div style={fontGridStyle}>
        <Field label="Primary family" hint="A CSS font family name, e.g. Inter or Acme Sans.">
          <input
            type="text"
            value={pick.family}
            onChange={(e) => onChange({ family: e.target.value })}
            style={inputStyle}
            placeholder="inherit platform default"
            spellCheck={false}
          />
        </Field>

        <Field label="Weight">
          <input
            type="text"
            value={pick.weight}
            onChange={(e) => onChange({ weight: e.target.value })}
            style={{ ...inputStyle, width: 90 }}
            placeholder="400"
            inputMode="numeric"
          />
        </Field>

        <Field label="Fallback families" hint="Comma-separated, appended after the primary family.">
          <input
            type="text"
            value={pick.fallbackCsv}
            onChange={(e) => onChange({ fallbackCsv: e.target.value })}
            style={inputStyle}
            placeholder="Helvetica, Arial, sans-serif"
            spellCheck={false}
          />
        </Field>

        <Field
          label="Uploaded file reference"
          hint="Paste the storage key returned by the artifacts upload route. Leave blank for a family-name-only selection."
          issues={issuesByField.get(`fonts.${role}.licenseKind`)}
        >
          <input
            type="text"
            value={pick.fileNote}
            onChange={(e) => onChange({ fileNote: e.target.value })}
            style={{ ...inputStyle, fontFamily: MONO_FONT, fontSize: 12 }}
            placeholder="objects/ws-…/fonts/inter.woff2"
            spellCheck={false}
          />
        </Field>

        <Field label="License">
          <select
            value={pick.licenseKind}
            onChange={(e) =>
              onChange({ licenseKind: e.target.value as FontPickDraft["licenseKind"] })
            }
            style={selectStyle}
          >
            <option value="unknown">Not declared</option>
            <option value="ofl">SIL Open Font License 1.1</option>
            <option value="apache-2.0">Apache 2.0</option>
            <option value="mit">MIT</option>
            <option value="cc0">Public domain (CC0)</option>
            <option value="commercial">Commercial (embedding granted)</option>
            <option value="web-only">Web-only (no embedding)</option>
          </select>
        </Field>

        {(pick.licenseKind === "commercial" || pick.licenseKind === "web-only") && (
          <label style={inlineCheckboxStyle}>
            <input
              type="checkbox"
              checked={pick.embeddingAllowed}
              onChange={(e) => onChange({ embeddingAllowed: e.target.checked })}
              disabled={pick.licenseKind === "web-only"}
            />
            <span>
              {pick.licenseKind === "web-only"
                ? "Web-only licenses never permit embedding."
                : "The licensor has authorised embedding in exported PDF/DOCX files."}
            </span>
          </label>
        )}
      </div>
    </div>
  );
}

function LogoRow({
  surface,
  draft,
  onChange,
  onClear,
  issuesByField,
}: {
  readonly surface: LogoSurface;
  readonly draft: LogoDraft | undefined;
  readonly onChange: (patch: Partial<LogoDraft>) => void;
  readonly onClear: () => void;
  readonly issuesByField: ReadonlyMap<string, readonly DraftIssue[]>;
}): JSX.Element {
  const current = draft ?? emptyLogoDraft();
  const hasDraft = draft !== undefined && (current.storageKey.length > 0 || current.id.length > 0);
  const logoIssues = issuesByField.get(`logos.${surface}.storageKey`) ?? [];
  const altIssues = issuesByField.get(`logos.${surface}.altText`) ?? [];

  return (
    <div style={logoRowStyle}>
      <div style={logoRowHeaderStyle}>
        <strong>{LOGO_SURFACE_LABELS[surface]}</strong>
        <code style={monoSmallStyle}>{surface}</code>
        {hasDraft && (
          <button type="button" onClick={onClear} style={linkButtonStyle}>
            Clear
          </button>
        )}
      </div>
      <div style={logoGridStyle}>
        <Field
          label="Logo id"
          hint="The artifact id returned by the artifacts upload route."
          issues={logoIssues}
        >
          <input
            type="text"
            value={current.id}
            onChange={(e) => onChange({ id: e.target.value })}
            style={{ ...inputStyle, fontFamily: MONO_FONT, fontSize: 12 }}
            placeholder="art_01H…"
            spellCheck={false}
          />
        </Field>
        <Field label="Storage key">
          <input
            type="text"
            value={current.storageKey}
            onChange={(e) => onChange({ storageKey: e.target.value })}
            style={{ ...inputStyle, fontFamily: MONO_FONT, fontSize: 12 }}
            placeholder="objects/ws-…/logos/logo.svg"
            spellCheck={false}
          />
        </Field>
        <Field label="MIME type">
          <select
            value={current.mimeType}
            onChange={(e) => onChange({ mimeType: e.target.value as LogoDraft["mimeType"] })}
            style={selectStyle}
          >
            <option value="image/png">PNG</option>
            <option value="image/svg+xml">SVG</option>
            <option value="image/webp">WebP</option>
            <option value="image/jpeg">JPEG</option>
            <option value="image/gif">GIF</option>
          </select>
        </Field>
        <Field label="File name" hint="Shown in the settings UI, not in the rendered page.">
          <input
            type="text"
            value={current.fileName}
            onChange={(e) => onChange({ fileName: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="Width (px)">
          <input
            type="text"
            value={current.widthPx}
            onChange={(e) => onChange({ widthPx: e.target.value })}
            style={{ ...inputStyle, width: 90 }}
            inputMode="numeric"
            placeholder="240"
          />
        </Field>
        <Field label="Height (px)">
          <input
            type="text"
            value={current.heightPx}
            onChange={(e) => onChange({ heightPx: e.target.value })}
            style={{ ...inputStyle, width: 90 }}
            inputMode="numeric"
            placeholder="48"
          />
        </Field>
        <Field
          label="Alt text"
          hint="Required for accessibility."
          issues={altIssues}
        >
          <input
            type="text"
            value={current.altText}
            onChange={(e) => onChange({ altText: e.target.value })}
            style={inputStyle}
            placeholder="Acme Inc. logo"
          />
        </Field>
        <label style={inlineCheckboxStyle}>
          <input
            type="checkbox"
            checked={current.keepPlatformFallback}
            onChange={(e) => onChange({ keepPlatformFallback: e.target.checked })}
          />
          <span>
            Retain the platform fallback on this surface even when
            white-labelling is on.
          </span>
        </label>
      </div>
    </div>
  );
}

function Preview({ draft }: { readonly draft: Draft }): JSX.Element {
  const style = useMemo(() => {
    const c = draft.colors;
    const bodyFamily =
      draft.fonts.body.family.trim().length > 0 ? draft.fonts.body.family.trim() : undefined;
    const headingFamily =
      draft.fonts.heading.family.trim().length > 0 ? draft.fonts.heading.family.trim() : undefined;
    return {
      background: c.surface,
      color: c.text,
      border: `1px solid ${c.border}`,
      borderRadius: 8,
      padding: "16px 18px",
      fontFamily: bodyFamily,
    } satisfies CSSProperties;
  }, [draft.colors, draft.fonts]);

  const headingStyle: CSSProperties = {
    color: draft.colors.text,
    fontFamily:
      draft.fonts.heading.family.trim().length > 0 ? draft.fonts.heading.family.trim() : undefined,
    fontWeight: draft.fonts.heading.weight.trim() === "" ? 600 : Number(draft.fonts.heading.weight),
    margin: "0 0 6px",
    fontSize: 22,
  };

  const accentButtonStyle: CSSProperties = {
    background: draft.colors.accent,
    color: draft.colors.accentText,
    border: "none",
    borderRadius: 6,
    padding: "6px 12px",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  };

  const calloutStyle: CSSProperties = {
    background: draft.colors.warningSurface,
    color: draft.colors.warningText,
    borderRadius: 6,
    padding: "8px 10px",
    marginTop: 10,
    fontSize: 13,
  };

  const highlightStyle: CSSProperties = {
    background: draft.colors.highlight,
    padding: "1px 4px",
    borderRadius: 3,
  };

  const footerBrand =
    draft.enabled && draft.brandName.trim().length > 0
      ? draft.brandName.trim()
      : draft.enabled
        ? null
        : "Zipy AI";

  const previewBrandName =
    draft.brandName.trim().length > 0 ? draft.brandName.trim() : "Product name";

  return (
    <div style={style}>
      <h3 style={headingStyle}>{previewBrandName} — Create a customer</h3>
      <p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.55 }}>
        This is a preview of a guide page using the current theme. The body
        text uses the body font; headings use the heading font; highlights
        use the highlight colour.
      </p>
      <ol style={{ margin: "0 0 12px", paddingLeft: 20, fontSize: 14, lineHeight: 1.55 }}>
        <li>
          Click the <span style={highlightStyle}>New customer</span> button in
          the top-right corner.
        </li>
        <li>Fill in the customer&rsquo;s name, email and phone number.</li>
        <li>
          Click <button type="button" style={accentButtonStyle}>Save</button>{" "}
          to create the record.
        </li>
      </ol>
      <div style={calloutStyle}>
        This action cannot be undone. The customer record will be created
        immediately.
      </div>
      <div
        style={{
          marginTop: 14,
          paddingTop: 10,
          borderTop: `1px solid ${draft.colors.border}`,
          fontSize: 12,
          color: draft.colors.textMuted,
        }}
      >
        {draft.legalFooterText.trim().length > 0
          ? draft.legalFooterText.trim()
          : footerBrand !== null
            ? `Powered by ${footerBrand}.`
            : "(no footer — brand name is empty and the platform fallback is off)"}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: draft.colors.textMuted }}>
        This preview is a theme check, not a rendered export. The PDF and DOCX
        renderers use the same token values but their own layout engines.
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Colour + contrast helpers                                                   */
/* -------------------------------------------------------------------------- */

function prettyColorLabel(key: keyof ColorDraft): string {
  const map: Record<keyof ColorDraft, string> = {
    surface: "Surface",
    surfaceMuted: "Muted surface",
    text: "Text",
    textMuted: "Muted text",
    accent: "Accent",
    accentText: "Accent text",
    border: "Border",
    highlight: "Highlight",
    warningSurface: "Warning background",
    warningText: "Warning text",
    successSurface: "Success background",
    successText: "Success text",
  };
  return map[key];
}

function normaliseForPicker(hex: string): string {
  if (/^#([0-9a-fA-F]{6})$/.test(hex)) return hex;
  if (/^#([0-9a-fA-F]{3})$/.test(hex)) {
    const body = hex.slice(1);
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  return "#000000";
}

function parseAndContrast(bg: string, fg: string): number | null {
  const b = parseHex(bg);
  const f = parseHex(fg);
  if (b === null || f === null) return null;
  const lb = relativeLuminance(b);
  const lf = relativeLuminance(f);
  const lighter = Math.max(lb, lf);
  const darker = Math.min(lb, lf);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseHex(hex: string): readonly [number, number, number] | null {
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return null;
  const body = hex.slice(1);
  const full = body.length === 3 ? body.split("").map((c) => `${c}${c}`).join("") : body;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function relativeLuminance(rgb: readonly [number, number, number]): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace("Z", " UTC");
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

const MONO_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace";

const pageStyle: CSSProperties = {
  maxWidth: 960,
  margin: "0 auto",
  padding: "8px 4px 48px",
  fontFamily:
    "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  color: "#0f172a",
};

const headingStyle: CSSProperties = {
  margin: "8px 0 4px",
  fontSize: 22,
  fontWeight: 700,
};

const subheadingStyle: CSSProperties = {
  margin: "0 0 20px",
  color: "#475569",
  fontSize: 13,
  maxWidth: 720,
};

const sectionStyle: CSSProperties = {
  margin: "24px 0",
  padding: "16px 18px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
};

const sectionHeadingStyle: CSSProperties = {
  margin: "0 0 8px",
  fontSize: 15,
  fontWeight: 600,
  color: "#0f172a",
};

const sectionHintStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 12,
  color: "#475569",
  maxWidth: 720,
  lineHeight: 1.55,
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginBottom: 12,
};

const fieldLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "#334155",
};

const fieldHintStyle: CSSProperties = {
  fontSize: 11,
  color: "#64748b",
  maxWidth: 640,
  lineHeight: 1.45,
};

const fieldIssuesStyle: CSSProperties = {
  margin: "4px 0 0",
  paddingLeft: 18,
  fontSize: 11,
  color: "#b91c1c",
};

const fieldIssueInlineStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 11,
  color: "#b91c1c",
};

const inputStyle: CSSProperties = {
  padding: "6px 8px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  width: "100%",
  boxSizing: "border-box",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  lineHeight: 1.55,
};

const selectStyle: CSSProperties = {
  padding: "6px 8px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
};

const toggleRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#f8fafc",
  marginBottom: 12,
  cursor: "pointer",
};

const toggleLabelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
};

const toggleHintStyle: CSSProperties = {
  fontSize: 12,
  color: "#475569",
  lineHeight: 1.5,
  maxWidth: 640,
};

const colorGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: 10,
  marginBottom: 16,
};

const colorFieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const colorLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "#475569",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const colorSwatchStyle: CSSProperties = {
  width: 36,
  height: 28,
  padding: 0,
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  cursor: "pointer",
};

const contrastPreviewStyle: CSSProperties = {
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#f8fafc",
  color: "#334155",
};

const fontRowStyle: CSSProperties = {
  padding: "12px 0",
  borderTop: "1px dashed #e2e8f0",
};

const fontRowHeaderStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "baseline",
  marginBottom: 8,
};

const monoSmallStyle: CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 11,
  color: "#64748b",
};

const fontGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: 10,
};

const inlineCheckboxStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  fontSize: 12,
  color: "#334155",
  gridColumn: "1 / -1",
};

const logoRowStyle: CSSProperties = {
  padding: "12px 0",
  borderTop: "1px dashed #e2e8f0",
};

const logoRowHeaderStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "baseline",
  marginBottom: 8,
};

const logoGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
  gap: 10,
};

const linkButtonStyle: CSSProperties = {
  marginLeft: "auto",
  border: "none",
  background: "none",
  color: "#1d4ed8",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
  textDecoration: "underline",
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginTop: 12,
};

const primaryButtonStyle: CSSProperties = {
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid #1d4ed8",
  background: "#1d4ed8",
  color: "#ffffff",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  cursor: "pointer",
};

const issuesSummaryStyle: CSSProperties = {
  fontSize: 12,
  color: "#475569",
};

const successBoxStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #bbf7d0",
  borderRadius: 8,
  background: "#f0fdf4",
  color: "#14532d",
  fontSize: 12,
};

const errorBoxStyle: CSSProperties = {
  marginTop: 12,
  padding: "10px 12px",
  border: "1px solid #fecaca",
  borderRadius: 8,
  background: "#fef2f2",
  color: "#7f1d1d",
  fontSize: 12,
};
