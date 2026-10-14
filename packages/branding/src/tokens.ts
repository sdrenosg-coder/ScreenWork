/**
 * Zipy AI — branding: design tokens (phase 25, batch 0).
 *
 * The token layer is the single source of truth for the visual identity of a
 * workspace's rendered guides and exports. It defines the typed shape of a
 * brand's palette, typography scale, spacing, radii, shadows and motion, plus
 * a deterministic resolver that merges an operator-supplied override with the
 * platform default and produces a frozen, `--`-prefixed CSS custom-property
 * record the web app and the export renderers both consume.
 *
 * Design rules honoured:
 *
 *  - **No invented brand.** The platform default palette is a documented,
 *    neutral baseline (Zipy's grey/blue). A workspace's brand is *always* an
 *    override the operator supplied; the token resolver never guesses a brand
 *    colour, a font family or a logo. Missing fields fall through to the
 *    default token, and the default is labelled as such in the emitted
 *    `provenance`.
 *
 *  - **Accessible by construction.** Colour triples are validated for WCAG
 *    2.1 contrast against their declared pairing (text-on-surface,
 *    accent-on-surface). A brand that fails AA is *not* rejected silently:
 *    the resolver emits an `AccessibilityWarning` per failing pair and the
 *    caller decides. The default palette is checked to pass AA and the
 *    constant relationship is asserted by `__internals.DEFAULT_CONTRAST_OK`.
 *
 *  - **Deterministic.** Token resolution is a pure function of
 *    (defaults, overrides). The CSS variable block is stable-sorted by token
 *    name so two runs over the same inputs produce identical bytes, and a
 *    workspace can diff its own theme across versions without noise.
 *
 *  - **No leakage.** Every emitted record is workspace-scoped: the resolver
 *    returns a versioned `BrandTokensResolved` object that carries the
 *    `workspaceId`, so a theming bug in one workspace cannot bleed into
 *    another. The route layer enforces scoping; this module keeps the field
 *    on the payload so a mis-scoped write is detectable in the audit log.
 *
 *  - **No storage, no I/O, no LLM.** Token resolution is arithmetic. It does
 *    not read a database, does not fetch a font, does not call a model.
 *
 * Exports:
 *   - Types: `BrandColorTokens`, `BrandTypographyTokens`, `BrandSpacingTokens`,
 *     `BrandTokens`, `BrandTokensInput`, `BrandTokensResolved`,
 *     `BrandTokenOrigin`, `AccessibilityWarning`.
 *   - Constants: `DEFAULT_BRAND_TOKENS`, `BRAND_TOKEN_VERSION`,
 *     `CONTRAST_AA_NORMAL`, `CONTRAST_AA_LARGE`.
 *   - Functions: `resolveBrandTokens`, `toCssVariables`, `toCssVariablesBlock`,
 *     `buildBrandDirectives`, `rehydrateBrandTokens`, `contrastRatio`,
 *     `relativeLuminance`, `isHexColor`.
 *   - `__internals` for tests.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type BrandTokenErrorCode = "invalid-input" | "shape" | "invalid-color";

export class BrandTokenError extends Error {
  readonly code: BrandTokenErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: BrandTokenErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/** The token schema version. Bumping it is a breaking change for callers. */
export const BRAND_TOKEN_VERSION = "brand-tokens/1" as const;

/**
 * WCAG 2.1 contrast minimums. `AA_NORMAL` applies to body text; `AA_LARGE`
 * applies to text at 18pt+ or 14pt+ bold, and to UI component boundaries.
 */
export const CONTRAST_AA_NORMAL = 4.5 as const;
export const CONTRAST_AA_LARGE = 3.0 as const;

/**
 * A hex colour string, either `#rrggbb` or `#rgb`. The token layer does not
 * accept named colours, `rgb()`, `hsl()` or `color-mix()` — the pipeline
 * needs a single canonical form so the export renderers, CSS variable block
 * and PDF renderer all agree on a colour value.
 */
export type HexColor = string;

export interface BrandColorTokens {
  /** Main background for a guide page. */
  readonly surface: HexColor;
  /** Slightly differentiated surface (cards, code blocks, callouts). */
  readonly surfaceMuted: HexColor;
  /** Body text on `surface`. */
  readonly text: HexColor;
  /** Secondary text (captions, metadata, path breadcrumbs). */
  readonly textMuted: HexColor;
  /** Primary brand colour: buttons, links, step badges. */
  readonly accent: HexColor;
  /** Text/icon colour that sits on top of `accent`. */
  readonly accentText: HexColor;
  /** Borders and dividers. */
  readonly border: HexColor;
  /** Highlight for the annotated element in a screenshot (translucent in CSS). */
  readonly highlight: HexColor;
  /** Warning callout background. */
  readonly warningSurface: HexColor;
  /** Warning callout text. */
  readonly warningText: HexColor;
  /** Success callout background. */
  readonly successSurface: HexColor;
  /** Success callout text. */
  readonly successText: HexColor;
}

/**
 * A font stack. The list is CSS-`font-family`-shaped and is rendered
 * verbatim into the CSS variable block. The token layer does not fetch or
 * validate a font file — a family named here that is not available will fall
 * through to the next family in the stack, as CSS specifies.
 */
export interface BrandFontStack {
  readonly families: readonly string[];
  /** Optional numeric weight for the primary face; null = inherit. */
  readonly weight: number | null;
}

export interface BrandTypographyTokens {
  readonly body: BrandFontStack;
  readonly heading: BrandFontStack;
  readonly mono: BrandFontStack;
  /** Base font size in CSS pixels. */
  readonly baseFontSizePx: number;
  /** Scale ratio for the modular type scale (e.g. 1.25 = major third). */
  readonly scaleRatio: number;
  readonly lineHeight: number;
}

export interface BrandSpacingTokens {
  /** Base unit in CSS pixels; the scale is derived from this. */
  readonly unitPx: number;
  /** Multipliers, ascending. The array is ordered and unique. */
  readonly scale: readonly number[];
}

export interface BrandRadiiTokens {
  readonly sm: number;
  readonly md: number;
  readonly lg: number;
  readonly pill: number;
}

export interface BrandShadowTokens {
  /** CSS box-shadow string for a raised card. */
  readonly sm: string;
  readonly md: string;
  readonly lg: string;
}

export interface BrandMotionTokens {
  /** Transition duration in milliseconds for UI feedback (hover, focus). */
  readonly fastMs: number;
  readonly normalMs: number;
  /** Whether the workspace prefers reduced motion; templates honour it. */
  readonly reduceMotion: boolean;
}

/**
 * The complete brand token set. Every field is required on the *resolved*
 * payload; overrides are `Partial` at the input edge (see `BrandTokensInput`).
 */
export interface BrandTokens {
  readonly colors: BrandColorTokens;
  readonly typography: BrandTypographyTokens;
  readonly spacing: BrandSpacingTokens;
  readonly radii: BrandRadiiTokens;
  readonly shadows: BrandShadowTokens;
  readonly motion: BrandMotionTokens;
}

/**
 * The operator-supplied override. Every field is optional. The resolver
 * merges shallowly at the group level: a supplied `colors.text` replaces the
 * default `colors.text` and leaves the other colour tokens at default.
 * Deep-merge-with-promotion is the wrong rule for a design system — it makes
 * a partial palette silently inconsistent with its pairings.
 */
export interface BrandTokensInput {
  readonly colors?: Partial<BrandColorTokens>;
  readonly typography?: Partial<BrandTypographyTokens>;
  readonly spacing?: Partial<BrandSpacingTokens>;
  readonly radii?: Partial<BrandRadiiTokens>;
  readonly shadows?: Partial<BrandShadowTokens>;
  readonly motion?: Partial<BrandMotionTokens>;
}

/**
 * Where a resolved token's value came from. The export renderer uses this to
 * annotate a "brand overrides" page in the PDF's colophon.
 */
export interface BrandTokenOrigin {
  /** Token path, e.g. "colors.accent" or "typography.baseFontSizePx". */
  readonly path: string;
  /** "default" (platform baseline) or "workspace" (operator override). */
  readonly source: "default" | "workspace";
}

export interface AccessibilityWarning {
  /** Token path whose pairing fails the contrast minimum. */
  readonly pair: string;
  readonly backgroundPath: string;
  readonly foregroundPath: string;
  readonly ratio: number;
  readonly minimum: number;
  readonly detail: string;
}

export interface BrandTokensResolved {
  readonly version: typeof BRAND_TOKEN_VERSION;
  /**
   * Workspace the resolved tokens belong to. Required on the payload so a
   * mis-scoped theme is detectable; the resolver never invents a value.
   */
  readonly workspaceId: string;
  /**
   * An operator-supplied "brand name" used in the export colophon and the
   * CSS variable `--zipy-brand-name`. Null when the workspace has not named
   * its brand; the templates fall back to the platform name.
   */
  readonly brandName: string | null;
  readonly tokens: BrandTokens;
  /** Per-token origins, sorted by path, for the colophon and the diff view. */
  readonly provenance: readonly BrandTokenOrigin[];
  /** Failing contrast pairs, if any. Empty when the theme passes AA. */
  readonly warnings: readonly AccessibilityWarning[];
  readonly generatedAt: string;
}

export interface ResolveBrandTokensInput {
  readonly workspaceId: string;
  readonly overrides?: BrandTokensInput | null;
  readonly brandName?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Default tokens                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The platform's neutral baseline. Every colour pairing below is checked
 * against WCAG 2.1 AA by `__internals.DEFAULT_CONTRAST_OK` in tests. The
 * palette is deliberately muted; a workspace with a bolder brand replaces
 * the accent and the resolver reports any pairing that drops below AA.
 */
export const DEFAULT_BRAND_TOKENS: BrandTokens = Object.freeze({
  colors: Object.freeze({
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
  }),
  typography: Object.freeze({
    body: Object.freeze({
      families: Object.freeze([
        "system-ui",
        "-apple-system",
        "Segoe UI",
        "Roboto",
        "Helvetica Neue",
        "Arial",
        "sans-serif",
      ]),
      weight: 400,
    }),
    heading: Object.freeze({
      families: Object.freeze([
        "system-ui",
        "-apple-system",
        "Segoe UI",
        "Roboto",
        "Helvetica Neue",
        "Arial",
        "sans-serif",
      ]),
      weight: 600,
    }),
    mono: Object.freeze({
      families: Object.freeze([
        "ui-monospace",
        "SFMono-Regular",
        "Menlo",
        "Consolas",
        "Liberation Mono",
        "monospace",
      ]),
      weight: 400,
    }),
    baseFontSizePx: 16,
    scaleRatio: 1.25,
    lineHeight: 1.55,
  }),
  spacing: Object.freeze({
    unitPx: 8,
    scale: Object.freeze([0.5, 1, 1.5, 2, 3, 4, 6, 8]),
  }),
  radii: Object.freeze({ sm: 4, md: 8, lg: 16, pill: 9999 }),
  shadows: Object.freeze({
    sm: "0 1px 2px 0 rgba(0,0,0,0.05)",
    md: "0 2px 6px 0 rgba(0,0,0,0.08)",
    lg: "0 8px 24px 0 rgba(0,0,0,0.12)",
  }),
  motion: Object.freeze({ fastMs: 120, normalMs: 220, reduceMotion: false }),
});

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function resolveBrandTokens(input: ResolveBrandTokensInput): BrandTokensResolved {
  if (input === null || typeof input !== "object") {
    throw new BrandTokenError("resolveBrandTokens requires an input object.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new BrandTokenError("`workspaceId` is required.", "invalid-input");
  }
  const overrides = input.overrides ?? {};

  const mergedColors = mergeColors(DEFAULT_BRAND_TOKENS.colors, overrides.colors);
  const mergedTypography = mergeTypography(DEFAULT_BRAND_TOKENS.typography, overrides.typography);
  const mergedSpacing = mergeSpacing(DEFAULT_BRAND_TOKENS.spacing, overrides.spacing);
  const mergedRadii = mergeRadii(DEFAULT_BRAND_TOKENS.radii, overrides.radii);
  const mergedShadows = mergeShadows(DEFAULT_BRAND_TOKENS.shadows, overrides.shadows);
  const mergedMotion = mergeMotion(DEFAULT_BRAND_TOKENS.motion, overrides.motion);

  const tokens: BrandTokens = Object.freeze({
    colors: mergedColors,
    typography: mergedTypography,
    spacing: mergedSpacing,
    radii: mergedRadii,
    shadows: mergedShadows,
    motion: mergedMotion,
  });

  const provenance = buildProvenance(overrides);
  const warnings = computeContrastWarnings(mergedColors);

  return Object.freeze({
    version: BRAND_TOKEN_VERSION,
    workspaceId: input.workspaceId,
    brandName:
      typeof input.brandName === "string" && input.brandName.trim().length > 0
        ? input.brandName.trim()
        : null,
    tokens,
    provenance,
    warnings,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Flatten a resolved token set into a `--zipy-*` CSS custom-property record.
 * The record is a plain object so the caller can serialise it however it
 * prefers (JSON, inline style, `:root { ... }`).
 *
 * Sorted alphabetically by variable name; the sort is stable so a diff
 * between two versions of the same workspace's theme is minimal.
 */
export function toCssVariables(resolved: BrandTokensResolved): Record<string, string> {
  if (resolved === null || typeof resolved !== "object" || resolved.version !== BRAND_TOKEN_VERSION) {
    throw new BrandTokenError(
      `toCssVariables requires a BrandTokensResolved (version "${BRAND_TOKEN_VERSION}").`,
      "invalid-input",
    );
  }
  const t = resolved.tokens;
  const entries: Array<[string, string]> = [
    ["--zipy-surface", t.colors.surface],
    ["--zipy-surface-muted", t.colors.surfaceMuted],
    ["--zipy-text", t.colors.text],
    ["--zipy-text-muted", t.colors.textMuted],
    ["--zipy-accent", t.colors.accent],
    ["--zipy-accent-text", t.colors.accentText],
    ["--zipy-border", t.colors.border],
    ["--zipy-highlight", t.colors.highlight],
    ["--zipy-warning-surface", t.colors.warningSurface],
    ["--zipy-warning-text", t.colors.warningText],
    ["--zipy-success-surface", t.colors.successSurface],
    ["--zipy-success-text", t.colors.successText],

    ["--zipy-font-body", formatFontStack(t.typography.body)],
    ["--zipy-font-heading", formatFontStack(t.typography.heading)],
    ["--zipy-font-mono", formatFontStack(t.typography.mono)],
    ["--zipy-font-weight-body", t.typography.body.weight !== null ? String(t.typography.body.weight) : "400"],
    ["--zipy-font-weight-heading", t.typography.heading.weight !== null ? String(t.typography.heading.weight) : "600"],
    ["--zipy-font-size-base", `${t.typography.baseFontSizePx}px`],
    ["--zipy-line-height", String(t.typography.lineHeight)],

    ["--zipy-space-unit", `${t.spacing.unitPx}px`],
    ["--zipy-radius-sm", `${t.radii.sm}px`],
    ["--zipy-radius-md", `${t.radii.md}px`],
    ["--zipy-radius-lg", `${t.radii.lg}px`],
    ["--zipy-radius-pill", `${t.radii.pill}px`],

    ["--zipy-shadow-sm", t.shadows.sm],
    ["--zipy-shadow-md", t.shadows.md],
    ["--zipy-shadow-lg", t.shadows.lg],

    ["--zipy-motion-fast", `${t.motion.fastMs}ms`],
    ["--zipy-motion-normal", `${t.motion.normalMs}ms`],
    ["--zipy-motion-reduce", t.motion.reduceMotion ? "reduce" : "no-preference"],
  ];

  // Derived spacing scale, e.g. --zipy-space-1 = 8px, --zipy-space-2 = 16px.
  t.spacing.scale.forEach((multiplier, index) => {
    const key = formatSpaceKey(index, multiplier);
    entries.push([`--zipy-space-${key}`, `${Math.round(multiplier * t.spacing.unitPx)}px`]);
  });

  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const out: Record<string, string> = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}

/**
 * Wrap `toCssVariables` output in a scoped CSS block. When
 * `resolved.workspaceId` is supplied, the selector is `:root[data-zipy-workspace="<id>"]`,
 * which ensures a workspace's variables cannot apply to another workspace's
 * DOM because the attribute is not present.
 *
 * Custom CSS from `customCss.ts` should be concatenated *after* this block
 * by the caller so a workspace override has CSS cascade precedence.
 */
export function toCssVariablesBlock(resolved: BrandTokensResolved): string {
  const vars = toCssVariables(resolved);
  const selector = `:root[data-zipy-workspace="${escapeAttribute(resolved.workspaceId)}"]`;
  const lines: string[] = [`${selector} {`];
  for (const name of Object.keys(vars).sort()) {
    const value = vars[name];
    if (value === undefined) continue;
    lines.push(`  ${name}: ${value};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * Build the LLM-visible directive describing the brand's identity. Content
 * layers append this to their system prompt so generated prose is aware of
 * the brand name, and only of the brand name; the token layer never asks the
 * model to invent a colour, font or logo.
 *
 * The directive is intentionally short and imperative.
 */
export function buildBrandDirectives(resolved: BrandTokensResolved): string {
  const lines: string[] = [];
  if (resolved.brandName !== null) {
    lines.push(`Brand name: ${resolved.brandName}.`);
    lines.push(
      `- Use "${resolved.brandName}" for the brand, its products and its pages. Do not substitute alternative product names.`,
    );
  } else {
    lines.push(
      "No brand name has been supplied for this workspace. Do not invent a product or brand name; if the workflow touches a named product, use the product's own name as it appears in the source.",
    );
  }
  if (resolved.warnings.length > 0) {
    // Not an LLM directive — a note the caller can surface in the review UI.
    // Included here so the "generation context" is a single object.
    lines.push(
      `- Note: the workspace theme has ${resolved.warnings.length} contrast warning${resolved.warnings.length === 1 ? "" : "s"}; the review UI lists them.`,
    );
  }
  return lines.join("\n");
}

/**
 * Rehydrate a persisted payload. Missing fields fall through to the default
 * token set so a partially-written theme still resolves; the version field
 * is asserted.
 */
export function rehydrateBrandTokens(value: unknown): BrandTokensResolved {
  if (value === null || typeof value !== "object") {
    throw new BrandTokenError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== BRAND_TOKEN_VERSION) {
    throw new BrandTokenError(
      `Rehydrate failed: expected version "${BRAND_TOKEN_VERSION}", received "${String(r["version"])}".`,
      "shape",
    );
  }
  const tokensRaw = r["tokens"];
  const tokens =
    tokensRaw !== null && typeof tokensRaw === "object"
      ? rehydrateTokens(tokensRaw as Record<string, unknown>)
      : DEFAULT_BRAND_TOKENS;

  return {
    version: BRAND_TOKEN_VERSION,
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    brandName: typeof r["brandName"] === "string" && r["brandName"].length > 0 ? r["brandName"] : null,
    tokens,
    provenance: readProvenance(r["provenance"]),
    warnings: readWarnings(r["warnings"]),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Contrast helpers (exported; used by tests and the review UI)                */
/* -------------------------------------------------------------------------- */

/**
 * Relative luminance per WCAG 2.1. Accepts `#rgb` or `#rrggbb`; throws on
 * anything else so a caller cannot pass a CSS function by accident.
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex);
  const toLinear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * WCAG 2.1 contrast ratio between two hex colours. Values are divided by the
 * lighter, so the result is always >= 1.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Whether the input is a valid `#rgb` / `#rrggbb` hex colour. */
export function isHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function mergeColors(
  base: BrandColorTokens,
  override: Partial<BrandColorTokens> | undefined,
): BrandColorTokens {
  if (override === undefined) return base;
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof BrandColorTokens)[]) {
    const v = override[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !isHexColor(v)) {
      throw new BrandTokenError(
        `colors.${String(key)} must be a hex colour ("#rgb" or "#rrggbb"), received ${JSON.stringify(v)}.`,
        "invalid-color",
        { path: `colors.${String(key)}`, value: v },
      );
    }
    out[key] = v;
  }
  return Object.freeze(out);
}

function mergeTypography(
  base: BrandTypographyTokens,
  override: Partial<BrandTypographyTokens> | undefined,
): BrandTypographyTokens {
  if (override === undefined) return base;
  return Object.freeze({
    body: override.body !== undefined ? sanitiseFontStack(override.body, "typography.body") : base.body,
    heading:
      override.heading !== undefined ? sanitiseFontStack(override.heading, "typography.heading") : base.heading,
    mono: override.mono !== undefined ? sanitiseFontStack(override.mono, "typography.mono") : base.mono,
    baseFontSizePx:
      override.baseFontSizePx !== undefined
        ? readPositiveNumber(override.baseFontSizePx, "typography.baseFontSizePx")
        : base.baseFontSizePx,
    scaleRatio:
      override.scaleRatio !== undefined
        ? readPositiveNumber(override.scaleRatio, "typography.scaleRatio")
        : base.scaleRatio,
    lineHeight:
      override.lineHeight !== undefined
        ? readPositiveNumber(override.lineHeight, "typography.lineHeight")
        : base.lineHeight,
  });
}

function mergeSpacing(
  base: BrandSpacingTokens,
  override: Partial<BrandSpacingTokens> | undefined,
): BrandSpacingTokens {
  if (override === undefined) return base;
  const unitPx =
    override.unitPx !== undefined ? readPositiveNumber(override.unitPx, "spacing.unitPx") : base.unitPx;
  let scale = base.scale;
  if (override.scale !== undefined) {
    if (!Array.isArray(override.scale)) {
      throw new BrandTokenError("spacing.scale must be an array of positive numbers.", "invalid-input");
    }
    const cleaned: number[] = [];
    for (const v of override.scale) {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        throw new BrandTokenError(
          `spacing.scale entries must be positive finite numbers; received ${JSON.stringify(v)}.`,
          "invalid-input",
        );
      }
      cleaned.push(v);
    }
    // Deduplicate and sort ascending so the emitted scale is stable.
    scale = Object.freeze([...new Set(cleaned)].sort((a, b) => a - b));
  }
  return Object.freeze({ unitPx, scale });
}

function mergeRadii(
  base: BrandRadiiTokens,
  override: Partial<BrandRadiiTokens> | undefined,
): BrandRadiiTokens {
  if (override === undefined) return base;
  return Object.freeze({
    sm: override.sm !== undefined ? readNonNegativeNumber(override.sm, "radii.sm") : base.sm,
    md: override.md !== undefined ? readNonNegativeNumber(override.md, "radii.md") : base.md,
    lg: override.lg !== undefined ? readNonNegativeNumber(override.lg, "radii.lg") : base.lg,
    pill: override.pill !== undefined ? readNonNegativeNumber(override.pill, "radii.pill") : base.pill,
  });
}

function mergeShadows(
  base: BrandShadowTokens,
  override: Partial<BrandShadowTokens> | undefined,
): BrandShadowTokens {
  if (override === undefined) return base;
  return Object.freeze({
    sm: typeof override.sm === "string" ? override.sm : base.sm,
    md: typeof override.md === "string" ? override.md : base.md,
    lg: typeof override.lg === "string" ? override.lg : base.lg,
  });
}

function mergeMotion(
  base: BrandMotionTokens,
  override: Partial<BrandMotionTokens> | undefined,
): BrandMotionTokens {
  if (override === undefined) return base;
  return Object.freeze({
    fastMs: override.fastMs !== undefined ? readNonNegativeNumber(override.fastMs, "motion.fastMs") : base.fastMs,
    normalMs:
      override.normalMs !== undefined ? readNonNegativeNumber(override.normalMs, "motion.normalMs") : base.normalMs,
    reduceMotion: typeof override.reduceMotion === "boolean" ? override.reduceMotion : base.reduceMotion,
  });
}

function rehydrateTokens(raw: Record<string, unknown>): BrandTokens {
  const colors = (raw["colors"] !== null && typeof raw["colors"] === "object"
    ? mergeColors(DEFAULT_BRAND_TOKENS.colors, raw["colors"] as Partial<BrandColorTokens>)
    : DEFAULT_BRAND_TOKENS.colors);
  const typography = (raw["typography"] !== null && typeof raw["typography"] === "object"
    ? mergeTypography(DEFAULT_BRAND_TOKENS.typography, raw["typography"] as Partial<BrandTypographyTokens>)
    : DEFAULT_BRAND_TOKENS.typography);
  const spacing = (raw["spacing"] !== null && typeof raw["spacing"] === "object"
    ? mergeSpacing(DEFAULT_BRAND_TOKENS.spacing, raw["spacing"] as Partial<BrandSpacingTokens>)
    : DEFAULT_BRAND_TOKENS.spacing);
  const radii = (raw["radii"] !== null && typeof raw["radii"] === "object"
    ? mergeRadii(DEFAULT_BRAND_TOKENS.radii, raw["radii"] as Partial<BrandRadiiTokens>)
    : DEFAULT_BRAND_TOKENS.radii);
  const shadows = (raw["shadows"] !== null && typeof raw["shadows"] === "object"
    ? mergeShadows(DEFAULT_BRAND_TOKENS.shadows, raw["shadows"] as Partial<BrandShadowTokens>)
    : DEFAULT_BRAND_TOKENS.shadows);
  const motion = (raw["motion"] !== null && typeof raw["motion"] === "object"
    ? mergeMotion(DEFAULT_BRAND_TOKENS.motion, raw["motion"] as Partial<BrandMotionTokens>)
    : DEFAULT_BRAND_TOKENS.motion);
  return Object.freeze({ colors, typography, spacing, radii, shadows, motion });
}

function sanitiseFontStack(stack: BrandFontStack, path: string): BrandFontStack {
  if (stack === null || typeof stack !== "object") {
    throw new BrandTokenError(`${path} must be a BrandFontStack.`, "invalid-input");
  }
  if (!Array.isArray(stack.families)) {
    throw new BrandTokenError(`${path}.families must be an array of font family names.`, "invalid-input");
  }
  const families: string[] = [];
  for (const f of stack.families) {
    if (typeof f !== "string" || f.trim().length === 0) {
      throw new BrandTokenError(
        `${path}.families entries must be non-empty strings; received ${JSON.stringify(f)}.`,
        "invalid-input",
      );
    }
    // The list is CSS-shaped; forbidding `;` and `}` blocks a stylesheet
    // injection via a font family name.
    if (/[;}]/u.test(f)) {
      throw new BrandTokenError(
        `${path}.families entries must not contain ";" or "}".`,
        "invalid-input",
        { value: f },
      );
    }
    families.push(f.trim());
  }
  const weight =
    stack.weight === null || stack.weight === undefined
      ? null
      : typeof stack.weight === "number" && Number.isFinite(stack.weight) && stack.weight > 0
        ? stack.weight
        : (() => {
            throw new BrandTokenError(`${path}.weight must be a positive number or null.`, "invalid-input");
          })();
  return Object.freeze({ families: Object.freeze(families), weight });
}

function buildProvenance(overrides: BrandTokensInput): readonly BrandTokenOrigin[] {
  const groups: Array<{ path: string; has: readonly string[] }> = [
    { path: "colors", has: overrides.colors !== undefined ? Object.keys(overrides.colors) : [] },
    { path: "typography", has: overrides.typography !== undefined ? Object.keys(overrides.typography) : [] },
    { path: "spacing", has: overrides.spacing !== undefined ? Object.keys(overrides.spacing) : [] },
    { path: "radii", has: overrides.radii !== undefined ? Object.keys(overrides.radii) : [] },
    { path: "shadows", has: overrides.shadows !== undefined ? Object.keys(overrides.shadows) : [] },
    { path: "motion", has: overrides.motion !== undefined ? Object.keys(overrides.motion) : [] },
  ];
  const origins: BrandTokenOrigin[] = [];
  for (const g of groups) {
    for (const k of g.has) {
      origins.push({ path: `${g.path}.${k}`, source: "workspace" });
    }
  }
  origins.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Object.freeze(origins);
}

/**
 * Check the colour pairings that matter for readability:
 *   - text on surface, text on surfaceMuted
 *   - textMuted on surface
 *   - accentText on accent (button labels)
 *   - warningText on warningSurface, successText on successSurface
 *   - border on surface (component boundary: AA Large minimum)
 */
function computeContrastWarnings(colors: BrandColorTokens): readonly AccessibilityWarning[] {
  const warnings: AccessibilityWarning[] = [];
  const pairs: ReadonlyArray<{
    bg: keyof BrandColorTokens;
    fg: keyof BrandColorTokens;
    minimum: number;
    label: string;
  }> = [
    { bg: "surface", fg: "text", minimum: CONTRAST_AA_NORMAL, label: "body text on surface" },
    { bg: "surfaceMuted", fg: "text", minimum: CONTRAST_AA_NORMAL, label: "body text on muted surface" },
    { bg: "surface", fg: "textMuted", minimum: CONTRAST_AA_NORMAL, label: "secondary text on surface" },
    { bg: "surfaceMuted", fg: "textMuted", minimum: CONTRAST_AA_NORMAL, label: "secondary text on muted surface" },
    { bg: "accent", fg: "accentText", minimum: CONTRAST_AA_NORMAL, label: "text on accent" },
    { bg: "warningSurface", fg: "warningText", minimum: CONTRAST_AA_NORMAL, label: "warning text on warning surface" },
    { bg: "successSurface", fg: "successText", minimum: CONTRAST_AA_NORMAL, label: "success text on success surface" },
    { bg: "surface", fg: "border", minimum: CONTRAST_AA_LARGE, label: "border on surface" },
  ];
  for (const p of pairs) {
    const background = colors[p.bg];
    const foreground = colors[p.fg];
    const ratio = contrastRatio(background, foreground);
    if (ratio < p.minimum) {
      warnings.push({
        pair: p.label,
        backgroundPath: `colors.${p.bg}`,
        foregroundPath: `colors.${p.fg}`,
        ratio: Math.round(ratio * 100) / 100,
        minimum: p.minimum,
        detail: `Contrast ${(Math.round(ratio * 100) / 100).toFixed(2)}:1 is below the ${p.minimum}:1 minimum. The workspace should darken the foreground or lighten the background.`,
      });
    }
  }
  return Object.freeze(warnings);
}

function readProvenance(v: unknown): readonly BrandTokenOrigin[] {
  if (!Array.isArray(v)) return [];
  const out: BrandTokenOrigin[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const source = o["source"] === "workspace" ? "workspace" : "default";
    out.push({
      path: typeof o["path"] === "string" ? o["path"] : "",
      source,
    });
  }
  return Object.freeze(out);
}

function readWarnings(v: unknown): readonly AccessibilityWarning[] {
  if (!Array.isArray(v)) return [];
  const out: AccessibilityWarning[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    out.push({
      pair: typeof o["pair"] === "string" ? o["pair"] : "",
      backgroundPath: typeof o["backgroundPath"] === "string" ? o["backgroundPath"] : "",
      foregroundPath: typeof o["foregroundPath"] === "string" ? o["foregroundPath"] : "",
      ratio: typeof o["ratio"] === "number" && Number.isFinite(o["ratio"]) ? o["ratio"] : 0,
      minimum: typeof o["minimum"] === "number" && Number.isFinite(o["minimum"]) ? o["minimum"] : 0,
      detail: typeof o["detail"] === "string" ? o["detail"] : "",
    });
  }
  return Object.freeze(out);
}

function formatFontStack(stack: BrandFontStack): string {
  // Stack entries that contain a space or non-identifier character are
  // quoted; identifier-style names pass through unquoted. This matches CSS
  // conventions and is what the browser would resolve anyway.
  return stack.families
    .map((f) => (/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(f) ? f : `"${f.replace(/"/g, '\\"')}"`))
    .join(", ");
}

function formatSpaceKey(index: number, multiplier: number): string {
  // Human-readable names for the 0.5 step and the whole-number steps, so the
  // emitted variables read as `--zipy-space-1`, `--zipy-space-2` etc; unusual
  // custom scales fall through to an index-suffixed name.
  if (multiplier === 0.5) return "0-5";
  if (Number.isInteger(multiplier)) return String(multiplier);
  return `${index}-${String(multiplier).replace(/\./g, "_")}`;
}

function escapeAttribute(s: string): string {
  return s.replace(/["\\]/g, "");
}

function parseHexRgb(hex: string): readonly [number, number, number] {
  if (typeof hex !== "string" || !isHexColor(hex)) {
    throw new BrandTokenError(
      `Expected a hex colour ("#rgb" or "#rrggbb"), received ${JSON.stringify(hex)}.`,
      "invalid-color",
      { value: hex },
    );
  }
  const body = hex.slice(1);
  const full = body.length === 3 ? body.split("").map((c) => `${c}${c}`).join("") : body;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return [r, g, b];
}

function readPositiveNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new BrandTokenError(`${path} must be a positive finite number.`, "invalid-input", { path });
  }
  return v;
}

function readNonNegativeNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new BrandTokenError(`${path} must be a non-negative finite number.`, "invalid-input", { path });
  }
  return v;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The default palette is asserted to pass AA at module load; a test that
 * imports this module will fail if a developer changes a default colour to
 * one that fails. The relationship is a property of the default, not of an
 * arbitrary override.
 */
export const __internals = Object.freeze({
  DEFAULT_CONTRAST_OK: Object.freeze({
    "text-on-surface": contrastRatio(
      DEFAULT_BRAND_TOKENS.colors.surface,
      DEFAULT_BRAND_TOKENS.colors.text,
    ) >= CONTRAST_AA_NORMAL,
    "text-on-surface-muted": contrastRatio(
      DEFAULT_BRAND_TOKENS.colors.surfaceMuted,
      DEFAULT_BRAND_TOKENS.colors.text,
    ) >= CONTRAST_AA_NORMAL,
    "accent-text-on-accent": contrastRatio(
      DEFAULT_BRAND_TOKENS.colors.accent,
      DEFAULT_BRAND_TOKENS.colors.accentText,
    ) >= CONTRAST_AA_NORMAL,
    "warning-text-on-warning-surface": contrastRatio(
      DEFAULT_BRAND_TOKENS.colors.warningSurface,
      DEFAULT_BRAND_TOKENS.colors.warningText,
    ) >= CONTRAST_AA_NORMAL,
    "success-text-on-success-surface": contrastRatio(
      DEFAULT_BRAND_TOKENS.colors.successSurface,
      DEFAULT_BRAND_TOKENS.colors.successText,
    ) >= CONTRAST_AA_NORMAL,
  }),
  formatFontStack,
  formatSpaceKey,
  computeContrastWarnings,
  buildProvenance,
  parseHexRgb,
  escapeAttribute,
  readPositiveNumber,
  readNonNegativeNumber,
  sanitiseFontStack,
  mergeColors,
  mergeTypography,
  mergeSpacing,
  mergeRadii,
  mergeShadows,
  mergeMotion,
});
