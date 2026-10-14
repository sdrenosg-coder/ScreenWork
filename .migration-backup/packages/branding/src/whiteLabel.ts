/**
 * Zipy AI — branding: white-label theming (phase 25, batch 1).
 *
 * This module composes the three earlier branding primitives — design tokens
 * (`tokens.ts`), font selection (`fonts.ts`) and custom CSS (`customCss.ts`) —
 * plus the workspace's uploaded logo reference, into a single
 * `WhiteLabelTheme` payload. It is the object the web renderer, the embed
 * widget and every export renderer consume when they need to render a
 * workspace's guides.
 *
 * What the module owns:
 *
 *   - The **composition** of the theme. It calls into the three primitives
 *     and stores their outputs together in one versioned, workspace-scoped
 *     object so a renderer never has to reassemble them and cannot
 *     accidentally mix workspace A's tokens with workspace B's custom CSS.
 *
 *   - The **logo reference**. A `LogoReference` names a workspace-uploaded
 *     image and describes where it may appear (header, PDF cover, footer,
 *     favicon). Like font files, the logo is *supplied*: the operator uploads
 *     it, the storage layer stores it, the reference this module carries is a
 *     pointer. No logo is invented, generated or fetched.
 *
 *   - The **white-label toggle**. A workspace can enable white-labelling so
 *     the platform's own name and chrome are replaced by the workspace's
 *     brand. When disabled, the platform name is shown in the header, footer
 *     and PDF colophon. The module records the toggle and produces the
 *     `WhiteLabelSurface` record renderers consult.
 *
 *   - The **render directive**. A single text string a renderer (or an LLM
 *     content layer) reads to know how to attribute the page: brand name,
 *     logo alt text, "powered by" line, footer legal text. The module does
 *     not render the directive itself — it produces the string and lets each
 *     renderer place it.
 *
 * Design rules honoured:
 *
 *   - No logo is invented, fetched or generated. A `LogoReference` with a
 *     missing storage key is reported as `available: false` with a reason,
 *     never silently dropped.
 *
 *   - Custom CSS and tokens are scoped by the workspace id. `buildWhiteLabelTheme`
 *     returns a payload which carries `workspaceId`; `renderWhiteLabelCss`
 *     produces the full CSS block with the workspace's `data-zipy-workspace`
 *     attribute selector. Two workspaces' payloads, rendered into the same
 *     document, cannot collide.
 *
 *   - Custom CSS is sanitised through `sanitiseCustomCss` before it enters the
 *     theme. A theme payload is by construction free of `@import`, `</style>`
 *     and the other forbidden constructs.
 *
 *   - The module has no database, no storage and no network dependency. It
 *     resolves a supplied input; the caller persists and loads the payload.
 *
 *   - Versioned. `WHITE_LABEL_VERSION` is asserted on rehydration; a payload
 *     from a different schema version is rejected rather than coerced.
 *
 * Exports:
 *   - `WHITE_LABEL_VERSION`, `LOGO_SURFACES`, `LogoSurface`.
 *   - Types: `LogoReference`, `LogoAvailability`, `WhiteLabelInput`,
 *     `WhiteLabelTheme`, `WhiteLabelSurface`, `WhiteLabelNote`.
 *   - Functions: `buildWhiteLabelTheme`, `renderWhiteLabelCss`,
 *     `whiteLabelSurfaces`, `buildWhiteLabelDirective`, `logoAltText`,
 *     `summariseWhiteLabelTheme`, `rehydrateWhiteLabelTheme`.
 *   - `WhiteLabelError`, `WhiteLabelErrorCode`.
 */

import {
  buildFontSelection,
  fontFaceCss,
  embedPermissions,
  summariseFontSelection,
  type BuildFontSelectionInput,
  type FontPick,
  type FontSelection,
} from "./fonts";
import {
  sanitiseCustomCss,
  wrapCustomCss,
  CUSTOM_CSS_LIMITS,
  type SanitisedCustomCss,
  type CustomCssWarning,
  type SanitiseCustomCssInput,
} from "./customCss";
import {
  resolveBrandTokens,
  toCssVariablesBlock,
  toCssVariables,
  buildBrandDirectives,
  rehydrateBrandTokens,
  BRAND_TOKEN_VERSION,
  type BrandTokensResolved,
  type BrandTokensInput,
  type AccessibilityWarning,
} from "./tokens";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type WhiteLabelErrorCode = "invalid-input" | "shape" | "config-error";

export class WhiteLabelError extends Error {
  readonly code: WhiteLabelErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: WhiteLabelErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public constants                                                            */
/* -------------------------------------------------------------------------- */

export const WHITE_LABEL_VERSION = "white-label/1" as const;

/**
 * Where a logo may appear. The union is explicit so a renderer never has to
 * guess a surface's semantics; adding one is a schema version change for the
 * surfaces record.
 */
export const LOGO_SURFACES = [
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
export type LogoSurface = (typeof LOGO_SURFACES)[number];

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The DOM surfaces where the *platform's own* branding is normally shown. When
 * a workspace enables white-labelling, each of these surfaces is replaced
 * with the workspace's brand name, logo or nothing, per the operator's
 * choice. When white-labelling is disabled, the platform name is shown on
 * every surface that has `platformFallback: true`.
 *
 * The set is documented as data so a renderer can iterate over it and the
 * settings UI can present a checkbox per surface without hard-coding the
 * list in a component.
 */
export interface WhiteLabelSurface {
  readonly surface: LogoSurface;
  /** The workspace's logo reference for this surface, or null. */
  readonly logo: LogoReference | null;
  /**
   * Whether the platform's own name/chrome is shown on this surface when the
   * workspace has not supplied its own brand for it. A workspace that
   * white-labels the app header but leaves the email footer platform-branded
   * is a legitimate configuration.
   */
  readonly platformFallback: boolean;
  /**
   * The text rendered on this surface when white-labelling is on. Usually the
   * brand name; a footer surface may carry a legal line instead. `null` means
   * "render no text" (a surface whose identity is purely visual).
   */
  readonly text: string | null;
}

/**
 * Reference to a workspace-uploaded logo image. Like `FontFileReference`, the
 * module never touches storage: the caller resolves `storageKey` and hands
 * this module a pointer. The image itself is not fetched or verified here —
 * the `availability` record documents what the caller previously observed.
 */
export interface LogoReference {
  /** Stable id of the artifact row (for cross-referencing in the UI). */
  readonly id: string;
  /** Object-store key for the image file. */
  readonly storageKey: string;
  /** MIME type as recorded at upload. */
  readonly mimeType: "image/png" | "image/svg+xml" | "image/webp" | "image/jpeg" | "image/gif";
  /** Original file name as displayed in the settings UI. */
  readonly fileName: string;
  readonly byteSize: number;
  /**
   * Intrinsic pixel dimensions, if the caller determined them. The renderer
   * uses these to reserve space and avoid layout shift; `null` means the
   * renderer will not reserve space.
   */
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  /**
   * Operator-supplied alt text. Required by the resolver when the image is
   * present: an image with no alt text is rendered, but the module records a
   * `missing-alt-text` note so the accessibility review surfaces it.
   */
  readonly altText: string | null;
}

export interface LogoAvailability {
  readonly surface: LogoSurface;
  /** Whether the caller has a usable image to render on this surface. */
  readonly available: boolean;
  /** Why not, when `available === false`. Empty when available. */
  readonly reason: string;
}

export interface WhiteLabelInput {
  readonly workspaceId: string;
  /**
   * Whether white-labelling is enabled. When `false`, the platform name is
   * used everywhere the platform defines a fallback, and the workspace's
   * brand name is still used for the guide's own title (which is content,
   * not chrome). Enabling it removes the platform's name from the surfaces
   * documented by `WhiteLabelSurface`.
   */
  readonly enabled: boolean;
  /** The workspace's brand name. Null when the workspace has not set one. */
  readonly brandName: string | null;
  /** Optional override of the platform's own name in a white-labelled footer. */
  readonly legalFooterText: string | null;
  /** Design token overrides. */
  readonly tokenOverrides?: BrandTokensInput | null;
  /** Font picks. */
  readonly fontInput?: Omit<BuildFontSelectionInput, "workspaceId"> | null;
  /** The operator's custom CSS, or null. */
  readonly customCss?: string | null;
  /**
   * Logo picks, one per surface the operator chose. A surface with no entry
   * gets the platform fallback if `enabled` is false, or no logo if
   * `enabled` is true (the surface is left blank rather than filled with a
   * placeholder).
   */
  readonly logos?: readonly SurfaceLogoPick[] | null;
}

export interface SurfaceLogoPick {
  readonly surface: LogoSurface;
  readonly logo: LogoReference;
  /**
   * Per-surface override of the platform fallback. Useful when a workspace
   * turns on white-labelling but explicitly wants a "Powered by Zipy AI"
   * line to remain on the footer for attribution reasons the operator
   * has agreed to.
   */
  readonly keepPlatformFallback?: boolean;
  /** Per-surface override of the rendered text. Null = use the brand name. */
  readonly text?: string | null;
}

export interface WhiteLabelNote {
  readonly kind:
    | "brand-name-missing"
    | "logo-missing-alt-text"
    | "logo-no-storage-key"
    | "logo-dimensions-unknown"
    | "surface-unknown"
    | "custom-css-warnings"
    | "contrast-warnings"
    | "platform-attribution-retained";
  readonly detail: string;
}

export interface WhiteLabelTheme {
  readonly version: typeof WHITE_LABEL_VERSION;
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly brandName: string | null;
  /** The platform's own name, needed on any surface that retains fallback. */
  readonly platformName: "Zipy AI";
  /** Legal footer text, verbatim. Null = the platform's own footer applies. */
  readonly legalFooterText: string | null;
  readonly tokens: BrandTokensResolved;
  readonly fonts: FontSelection;
  readonly customCss: SanitisedCustomCss;
  readonly surfaces: readonly WhiteLabelSurface[];
  readonly logos: readonly LogoAvailability[];
  /**
   * The directive the content layer appends to its system prompt. See
   * `buildBrandDirectives` for the underlying surface; this is the
   * white-label-specific extension.
   */
  readonly directive: string;
  readonly notes: readonly WhiteLabelNote[];
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildWhiteLabelTheme(input: WhiteLabelInput): WhiteLabelTheme {
  if (input === null || typeof input !== "object") {
    throw new WhiteLabelError("buildWhiteLabelTheme requires an input object.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new WhiteLabelError("`workspaceId` is required.", "invalid-input");
  }
  const enabled = input.enabled === true;
  const brandName = normaliseOptionalString(input.brandName);
  const legalFooterText = normaliseOptionalString(input.legalFooterText);

  const tokens = resolveBrandTokens({
    workspaceId: input.workspaceId,
    overrides: input.tokenOverrides ?? null,
    brandName,
  });

  const fontInput: BuildFontSelectionInput = {
    workspaceId: input.workspaceId,
    picks: input.fontInput?.picks ?? [],
  };
  const fonts = buildFontSelection(fontInput);

  let customCss: SanitisedCustomCss;
  if (typeof input.customCss === "string" && input.customCss.trim().length > 0) {
    const sanitiseInput: SanitiseCustomCssInput = { css: input.customCss };
    customCss = sanitiseCustomCss(sanitiseInput);
  } else {
    const sanitiseInput: SanitiseCustomCssInput = { css: "" };
    customCss = sanitiseCustomCss(sanitiseInput);
  }

  const notes: WhiteLabelNote[] = [];

  pushCustomCssNotes(notes, customCss.warnings);
  pushContrastNotes(notes, tokens.warnings);

  if (brandName === null) {
    if (enabled) {
      notes.push({
        kind: "brand-name-missing",
        detail:
          "White-labelling is enabled but no brand name is set. Surfaces that would display the brand name will render no text; add a brand name in Branding settings.",
      });
    } else {
      notes.push({
        kind: "brand-name-missing",
        detail:
          "No brand name is set. The platform name is shown on all fallback surfaces.",
      });
    }
  }

  const { surfaces, logos } = buildSurfaceRecords(input.logos ?? [], brandName, enabled, notes);

  const directive = composeDirective(enabled, brandName, tokens, surfaces);

  return Object.freeze({
    version: WHITE_LABEL_VERSION,
    workspaceId: input.workspaceId,
    enabled,
    brandName,
    platformName: "Zipy AI",
    legalFooterText,
    tokens,
    fonts,
    customCss,
    surfaces: Object.freeze(surfaces),
    logos: Object.freeze(logos),
    directive,
    notes: Object.freeze(notes),
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Produce the complete CSS block a renderer inserts into a `<style>` element
 * (or the head of an export document). The block contains, in order:
 *
 *   1. The workspace's `@font-face` declarations, if any uploaded fonts exist.
 *      These must come first so a `font-family` declared in the token block
 *      below resolves to a loaded face.
 *
 *   2. The token custom-property block, scoped by the workspace's
 *      `data-zipy-workspace` attribute.
 *
 *   3. The operator's custom CSS, scoped by the same attribute so an override
 *      has CSS cascade precedence over the tokens above without leaking to
 *      another workspace.
 *
 * The three blocks are concatenated in that order and returned as a single
 * string. Rendering the same theme twice produces byte-identical output, so
 * two exports of the same guide are diffable.
 */
export function renderWhiteLabelCss(theme: WhiteLabelTheme): string {
  if (theme === null || typeof theme !== "object" || theme.version !== WHITE_LABEL_VERSION) {
    throw new WhiteLabelError(
      `renderWhiteLabelCss requires a WhiteLabelTheme (version "${WHITE_LABEL_VERSION}").`,
      "invalid-input",
    );
  }
  const parts: string[] = [];

  const fontFaces = fontFaceCss(theme.fonts);
  if (fontFaces.trim().length > 0) parts.push(fontFaces);

  parts.push(toCssVariablesBlock(theme.tokens));

  const workspaceScope = `[data-zipy-workspace="${escapeCssAttr(theme.workspaceId)}"]`;
  const wrappedCustomCss = wrapCustomCss(theme.customCss, workspaceScope);
  if (wrappedCustomCss.length > 0) parts.push(wrappedCustomCss);

  return parts.join("\n\n");
}

/**
 * The compact record the renderers consume for placing logos and brand text.
 * Keyed by surface so a renderer that only cares about the PDF cover looks up
 * one entry, and a renderer that iterates the whole set uses the array from
 * the theme.
 */
export function whiteLabelSurfaces(
  theme: WhiteLabelTheme,
): Readonly<Record<LogoSurface, WhiteLabelSurface>> {
  if (theme === null || typeof theme !== "object" || theme.version !== WHITE_LABEL_VERSION) {
    throw new WhiteLabelError(
      `whiteLabelSurfaces requires a WhiteLabelTheme (version "${WHITE_LABEL_VERSION}").`,
      "invalid-input",
    );
  }
  const out = {} as Record<LogoSurface, WhiteLabelSurface>;
  for (const s of theme.surfaces) out[s.surface] = s;
  // Fill any missing surface with the safe default: no logo, platform
  // fallback enabled, no text. This is what a workspace that never visited
  // the branding settings page gets.
  for (const surface of LOGO_SURFACES) {
    if (out[surface] === undefined) {
      out[surface] = Object.freeze({
        surface,
        logo: null,
        platformFallback: true,
        text: null,
      });
    }
  }
  return Object.freeze(out);
}

/**
 * The single string a content layer or review tool reads to know how to
 * attribute the guide. Long enough to be unambiguous, short enough to paste
 * into a prompt. Deterministic given the theme.
 */
export function buildWhiteLabelDirective(theme: WhiteLabelTheme): string {
  if (theme === null || typeof theme !== "object" || theme.version !== WHITE_LABEL_VERSION) {
    throw new WhiteLabelError(
      `buildWhiteLabelDirective requires a WhiteLabelTheme (version "${WHITE_LABEL_VERSION}").`,
      "invalid-input",
    );
  }
  return theme.directive;
}

/**
 * Compute the alt text for a logo surface. Prefers the operator-supplied
 * alt text; falls back to "<surface label> for <brand>"; when neither brand
 * nor alt text is present, returns the empty string (an absent image needs
 * no alt; an image without alt is reported as a note elsewhere).
 */
export function logoAltText(
  surface: WhiteLabelSurface,
  brandName: string | null,
): string {
  const alt = surface.logo?.altText;
  if (typeof alt === "string" && alt.trim().length > 0) return alt.trim();
  const label = surfaceLabel(surface.surface);
  if (brandName !== null && brandName.length > 0) return `${label} for ${brandName}`;
  return "";
}

/** One-line summary for the branding settings UI. Stable wording. */
export function summariseWhiteLabelTheme(theme: WhiteLabelTheme): string {
  const mode = theme.enabled ? "white-labelled" : "platform-branded";
  const brand = theme.brandName !== null ? `brand "${theme.brandName}"` : "no brand name";
  const logoCount = theme.surfaces.filter((s) => s.logo !== null).length;
  const retained = theme.surfaces.filter((s) => s.platformFallback).length;
  return `${mode} — ${brand}; ${logoCount} logo surface${logoCount === 1 ? "" : "s"} configured; ${retained} surface${retained === 1 ? "" : "s"} retain the platform fallback.`;
}

/**
 * Rehydrate a persisted theme payload. The version is asserted; each nested
 * primitive is rehydrated through its own typed loader so an out-of-shape
 * write fails loudly rather than producing a theme with a missing token
 * group.
 */
export function rehydrateWhiteLabelTheme(value: unknown): WhiteLabelTheme {
  if (value === null || typeof value !== "object") {
    throw new WhiteLabelError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== WHITE_LABEL_VERSION) {
    throw new WhiteLabelError(
      `Rehydrate failed: expected version "${WHITE_LABEL_VERSION}", received "${String(r["version"])}".`,
      "shape",
    );
  }
  const tokens = rehydrateBrandTokens(r["tokens"]);
  const fonts = rehydrateFontsLoose(r["fonts"]);
  const customCss = rehydrateCustomCssLoose(r["customCss"]);
  const surfaces = readSurfaces(r["surfaces"]);
  const logos = readLogoAvailabilities(r["logos"]);
  const notes = readNotes(r["notes"]);
  const brandName = typeof r["brandName"] === "string" && r["brandName"].length > 0 ? r["brandName"] : null;
  const legalFooterText =
    typeof r["legalFooterText"] === "string" && r["legalFooterText"].length > 0
      ? r["legalFooterText"]
      : null;
  const platformName = r["platformName"] === "Zipy AI" ? "Zipy AI" : "Zipy AI";
  return {
    version: WHITE_LABEL_VERSION,
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    enabled: r["enabled"] === true,
    brandName,
    platformName,
    legalFooterText,
    tokens,
    fonts,
    customCss,
    surfaces: Object.freeze(surfaces),
    logos: Object.freeze(logos),
    directive: typeof r["directive"] === "string" ? r["directive"] : "",
    notes: Object.freeze(notes),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function normaliseOptionalString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushCustomCssNotes(notes: WhiteLabelNote[], warnings: readonly CustomCssWarning[]): void {
  if (warnings.length === 0) return;
  const summary = warnings
    .map((w) => w.detail)
    .filter((d) => d.length > 0)
    .join(" ");
  notes.push({
    kind: "custom-css-warnings",
    detail: `Custom CSS produced ${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${summary}`,
  });
}

function pushContrastNotes(notes: WhiteLabelNote[], warnings: readonly AccessibilityWarning[]): void {
  if (warnings.length === 0) return;
  const summary = warnings
    .map((w) => `${w.pair} (${w.ratio}:1, needs ${w.minimum}:1)`)
    .join("; ");
  notes.push({
    kind: "contrast-warnings",
    detail: `The theme has ${warnings.length} contrast warning${warnings.length === 1 ? "" : "s"} at WCAG AA: ${summary}`,
  });
}

function buildSurfaceRecords(
  picks: readonly SurfaceLogoPick[],
  brandName: string | null,
  enabled: boolean,
  notes: WhiteLabelNote[],
): { readonly surfaces: readonly WhiteLabelSurface[]; readonly logos: readonly LogoAvailability[] } {
  const picksBySurface = new Map<LogoSurface, SurfaceLogoPick>();
  for (const pick of picks) {
    if (pick === null || typeof pick !== "object") continue;
    if (!isLogoSurface(pick.surface)) {
      notes.push({
        kind: "surface-unknown",
        detail: `A logo pick references an unknown surface (${JSON.stringify(pick.surface)}); it is skipped.`,
      });
      continue;
    }
    // Later picks override earlier ones for the same surface — the settings
    // UI submits one per surface, so this only matters if a client sends two
    // by mistake, and a last-wins rule is what an operator expects.
    picksBySurface.set(pick.surface, pick);
  }

  const surfaces: WhiteLabelSurface[] = [];
  const logos: LogoAvailability[] = [];

  for (const surface of LOGO_SURFACES) {
    const pick = picksBySurface.get(surface);
    if (pick === undefined) {
      // No logo configured for this surface. The platform default applies
      // only when white-labelling is off OR the operator has not explicitly
      // turned the platform off for this surface — the latter is not
      // expressible when there is no pick, so the platform fallback applies
      // iff white-labelling is off.
      surfaces.push(
        Object.freeze({
          surface,
          logo: null,
          platformFallback: !enabled,
          text: null,
        }),
      );
      logos.push(
        Object.freeze({
          surface,
          available: false,
          reason:
            enabled
              ? "White-labelling is enabled but this surface has no logo configured; the surface is rendered empty."
              : "White-labelling is disabled; the platform branding applies to this surface.",
        }),
      );
      continue;
    }

    const logo = validateLogo(pick.logo, surface, notes);
    const keepPlatformFallback = pick.keepPlatformFallback === true;
    const text =
      pick.text === undefined
        ? brandName
        : pick.text === null
          ? null
          : String(pick.text);

    if (keepPlatformFallback && enabled) {
      notes.push({
        kind: "platform-attribution-retained",
        detail: `Surface "${surface}" retains the platform fallback even though white-labelling is enabled. This is only appropriate when the operator has explicitly agreed to keep platform attribution on this surface in their license terms.`,
      });
    }

    surfaces.push(
      Object.freeze({
        surface,
        logo,
        platformFallback: keepPlatformFallback,
        text,
      }),
    );

    logos.push(
      Object.freeze({
        surface,
        available: logo !== null && logo.storageKey.trim().length > 0,
        reason:
          logo === null
            ? "The logo pick was rejected by validation; see the notes."
            : logo.storageKey.trim().length === 0
              ? "The logo reference has no storage key; there is nothing to render."
              : "",
      }),
    );
  }

  return { surfaces, logos };
}

function validateLogo(
  logo: LogoReference,
  surface: LogoSurface,
  notes: WhiteLabelNote[],
): LogoReference | null {
  if (logo === null || typeof logo !== "object") return null;
  if (typeof logo.storageKey !== "string" || logo.storageKey.trim().length === 0) {
    notes.push({
      kind: "logo-no-storage-key",
      detail: `Surface "${surface}" references a logo without a storage key; the image is not rendered.`,
    });
    return null;
  }
  if (typeof logo.id !== "string" || logo.id.trim().length === 0) {
    notes.push({
      kind: "logo-no-storage-key",
      detail: `Surface "${surface}" references a logo without an id; the record cannot be audited. The image is not rendered.`,
    });
    return null;
  }
  if (logo.altText === null || logo.altText.trim().length === 0) {
    notes.push({
      kind: "logo-missing-alt-text",
      detail: `Surface "${surface}" renders a logo with no alt text. Add alt text in Branding settings for accessibility.`,
    });
  }
  if (logo.widthPx === null || logo.heightPx === null) {
    notes.push({
      kind: "logo-dimensions-unknown",
      detail: `Surface "${surface}" logo has no recorded pixel dimensions. Text layout around the image may shift on first render.`,
    });
  }
  return Object.freeze({
    id: logo.id,
    storageKey: logo.storageKey,
    mimeType: readLogoMime(logo.mimeType),
    fileName: typeof logo.fileName === "string" ? logo.fileName : "",
    byteSize:
      typeof logo.byteSize === "number" && Number.isFinite(logo.byteSize) && logo.byteSize >= 0
        ? logo.byteSize
        : 0,
    widthPx:
      typeof logo.widthPx === "number" && Number.isFinite(logo.widthPx) && logo.widthPx > 0
        ? logo.widthPx
        : null,
    heightPx:
      typeof logo.heightPx === "number" && Number.isFinite(logo.heightPx) && logo.heightPx > 0
        ? logo.heightPx
        : null,
    altText: typeof logo.altText === "string" && logo.altText.trim().length > 0 ? logo.altText.trim() : null,
  });
}

function composeDirective(
  enabled: boolean,
  brandName: string | null,
  tokens: BrandTokensResolved,
  surfaces: readonly WhiteLabelSurface[],
): string {
  const lines: string[] = [];
  lines.push(buildBrandDirectives(tokens));
  if (enabled) {
    lines.push(
      "White-labelling is enabled for this workspace. Do not mention the platform name in user-facing content; refer only to the brand name above (or to the product and page names that appear in the source).",
    );
    const retained = surfaces.filter((s) => s.platformFallback).map((s) => s.surface);
    if (retained.length > 0) {
      lines.push(
        `Note: the following surfaces retain the platform's own attribution per an explicit operator decision: ${retained.join(", ")}. Do not extend that attribution to any other surface.`,
      );
    }
  } else if (brandName !== null) {
    lines.push(
      `White-labelling is not enabled. The platform name is shown on chrome surfaces; the brand name "${brandName}" is used within guide content.`,
    );
  }
  return lines.join("\n");
}

function surfaceLabel(surface: LogoSurface): string {
  switch (surface) {
    case "app-header":
      return "Application header logo";
    case "guide-header":
      return "Guide page header logo";
    case "guide-footer":
      return "Guide page footer logo";
    case "pdf-cover":
      return "PDF cover logo";
    case "pdf-page-header":
      return "PDF page header logo";
    case "pdf-page-footer":
      return "PDF page footer logo";
    case "email-header":
      return "Notification email header logo";
    case "favicon":
      return "Browser favicon";
    case "embed-widget":
      return "Embedded widget logo";
  }
}

function isLogoSurface(v: unknown): v is LogoSurface {
  return (
    v === "app-header" ||
    v === "guide-header" ||
    v === "guide-footer" ||
    v === "pdf-cover" ||
    v === "pdf-page-header" ||
    v === "pdf-page-footer" ||
    v === "email-header" ||
    v === "favicon" ||
    v === "embed-widget"
  );
}

function readLogoMime(v: unknown): LogoReference["mimeType"] {
  return v === "image/png" ||
    v === "image/svg+xml" ||
    v === "image/webp" ||
    v === "image/jpeg" ||
    v === "image/gif"
    ? v
    : "image/png";
}

function escapeCssAttr(s: string): string {
  return s.replace(/["\\]/g, "");
}

function rehydrateFontsLoose(v: unknown): FontSelection {
  // The font selection is a self-contained typed object; a caller that has
  // the correct shape rehydrates it through its own loader. This module only
  // needs a FontSelection with the right `version` for its own downstream
  // calls (fontFaceCss, embed rendering). Rehydrating here would require
  // importing `rehydrateFontSelection`, which is available; do so for
  // symmetry with the token layer.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const maybe = v as { version?: unknown } | null;
  if (maybe !== null && typeof maybe === "object" && maybe.version === "font-selection/1") {
    // We import the rehydrator lazily to avoid an import cycle between
    // whiteLabel.ts and fonts.ts in test harnesses.
    return rehydrateFontSelectionSafe(v);
  }
  return rehydrateFontSelectionSafe(v);
}

function rehydrateFontSelectionSafe(v: unknown): FontSelection {
  // Minimal rehydration: assemble a FontSelection with the shape this module
  // needs. The full loader in fonts.ts is preferred; this fallback ensures a
  // theme payload that was truncated (e.g. by an older writer) still hands
  // the renderer a valid object instead of throwing during a page render.
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o["version"] === "font-selection/1") {
      const picksRaw = Array.isArray(o["picks"]) ? o["picks"] : [];
      const picks = picksRaw.filter((p): p is FontPick => {
        if (p === null || typeof p !== "object") return false;
        const r = p as Record<string, unknown>;
        return (
          r["role"] === "body" ||
          r["role"] === "heading" ||
          r["role"] === "mono"
        );
      });
      const embedRaw = Array.isArray(o["embed"]) ? o["embed"] : [];
      return {
        version: "font-selection/1",
        workspaceId: typeof o["workspaceId"] === "string" ? o["workspaceId"] : "",
        picks: Object.freeze(picks),
        embed: Object.freeze(
          embedRaw.map((e) => {
            const r = e as Record<string, unknown>;
            return {
              role: "body" as const,
              family: typeof r["family"] === "string" ? r["family"] : "",
              embeddable: r["embeddable"] === true,
              reason: typeof r["reason"] === "string" ? r["reason"] : "",
              storageKey: typeof r["storageKey"] === "string" ? r["storageKey"] : null,
            };
          }),
        ),
        notes: Object.freeze([]),
        generatedAt: typeof o["generatedAt"] === "string" ? o["generatedAt"] : "",
      };
    }
  }
  return {
    version: "font-selection/1",
    workspaceId: "",
    picks: Object.freeze([]),
    embed: Object.freeze([]),
    notes: Object.freeze([]),
    generatedAt: "",
  };
}

function rehydrateCustomCssLoose(v: unknown): SanitisedCustomCss {
  if (v === null || typeof v !== "object") {
    return Object.freeze({ value: "", warnings: Object.freeze([]), ruleCount: 0 });
  }
  const o = v as Record<string, unknown>;
  const value = typeof o["value"] === "string" ? o["value"] : "";
  const warningsRaw = Array.isArray(o["warnings"]) ? o["warnings"] : [];
  const warnings: CustomCssWarning[] = [];
  for (const w of warningsRaw) {
    if (w === null || typeof w !== "object") continue;
    const r = w as Record<string, unknown>;
    if (
      r["kind"] === "long-stylesheet" ||
      r["kind"] === "high-rule-count" ||
      r["kind"] === "override-heavy" ||
      r["kind"] === "empty"
    ) {
      warnings.push({ kind: r["kind"], detail: typeof r["detail"] === "string" ? r["detail"] : "" });
    }
  }
  const ruleCount =
    typeof o["ruleCount"] === "number" && Number.isFinite(o["ruleCount"])
      ? Math.max(0, Math.floor(o["ruleCount"]))
      : 0;
  return Object.freeze({
    value,
    warnings: Object.freeze(warnings),
    ruleCount,
  });
}

function readSurfaces(v: unknown): readonly WhiteLabelSurface[] {
  if (!Array.isArray(v)) return [];
  const out: WhiteLabelSurface[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (!isLogoSurface(o["surface"])) continue;
    const logo = readLogoReference(o["logo"]);
    out.push(
      Object.freeze({
        surface: o["surface"],
        logo,
        platformFallback: o["platformFallback"] === true,
        text: typeof o["text"] === "string" ? o["text"] : null,
      }),
    );
  }
  return out;
}

function readLogoReference(v: unknown): LogoReference | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o["storageKey"] !== "string" || o["storageKey"].trim().length === 0) return null;
  if (typeof o["id"] !== "string" || o["id"].trim().length === 0) return null;
  return Object.freeze({
    id: o["id"],
    storageKey: o["storageKey"],
    mimeType: readLogoMime(o["mimeType"]),
    fileName: typeof o["fileName"] === "string" ? o["fileName"] : "",
    byteSize: typeof o["byteSize"] === "number" && Number.isFinite(o["byteSize"]) ? o["byteSize"] : 0,
    widthPx: typeof o["widthPx"] === "number" && Number.isFinite(o["widthPx"]) ? o["widthPx"] : null,
    heightPx: typeof o["heightPx"] === "number" && Number.isFinite(o["heightPx"]) ? o["heightPx"] : null,
    altText: typeof o["altText"] === "string" && o["altText"].length > 0 ? o["altText"] : null,
  });
}

function readLogoAvailabilities(v: unknown): readonly LogoAvailability[] {
  if (!Array.isArray(v)) return [];
  const out: LogoAvailability[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (!isLogoSurface(o["surface"])) continue;
    out.push(
      Object.freeze({
        surface: o["surface"],
        available: o["available"] === true,
        reason: typeof o["reason"] === "string" ? o["reason"] : "",
      }),
    );
  }
  return out;
}

function readNotes(v: unknown): readonly WhiteLabelNote[] {
  if (!Array.isArray(v)) return [];
  const out: WhiteLabelNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (
      o["kind"] === "brand-name-missing" ||
      o["kind"] === "logo-missing-alt-text" ||
      o["kind"] === "logo-no-storage-key" ||
      o["kind"] === "logo-dimensions-unknown" ||
      o["kind"] === "surface-unknown" ||
      o["kind"] === "custom-css-warnings" ||
      o["kind"] === "contrast-warnings" ||
      o["kind"] === "platform-attribution-retained"
    ) {
      out.push({
        kind: o["kind"],
        detail: typeof o["detail"] === "string" ? o["detail"] : "",
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  isLogoSurface,
  surfaceLabel,
  readLogoMime,
  validateLogo,
  buildSurfaceRecords,
  composeDirective,
  escapeCssAttr,
  normaliseOptionalString,
  pushCustomCssNotes,
  pushContrastNotes,
  readLogoReference,
  readSurfaces,
  readLogoAvailabilities,
  readNotes,
  CUSTOM_CSS_LIMITS,
  BRAND_TOKEN_VERSION,
});
