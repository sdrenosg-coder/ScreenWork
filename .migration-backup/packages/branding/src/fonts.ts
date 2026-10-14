/**
 * Zipy AI — branding: font selection (phase 25, batch 0).
 *
 * The fonts module owns the *font selection and licensing* concern that sits
 * between the operator (who picks a family) and the token layer (`tokens.ts`)
 * and export renderers (which need to know whether a font is embeddable).
 *
 * Two facts drive the design:
 *
 *   1. **Fonts are licensed.** A workspace may pick any CSS family name for
 *      the on-screen theme — the platform does not fetch or ship a font file
 *      in that case; the browser resolves the family against the OS or a
 *      stylesheet the workspace supplies. But when the workspace supplies a
 *      *font file* (a `.woff2`, `.ttf`, `.otf`) that the platform embeds into
 *      a PDF or DOCX export, the platform must know the license terms. This
 *      module records the license, persists the file reference through the
 *      caller, and refuses to mark a font embeddable when the operator has
 *      not declared the license.
 *
 *   2. **Fonts are not fetched here.** This module does not download a font
 *      from Google Fonts, a CDN, or any third-party service. It accepts a
 *      `FontFileReference` (an id and a storage key) that the caller resolved
 *      through the storage layer. The file is the workspace's responsibility,
 *      as is the license.
 *
 * The module exports:
 *   - `buildFontSelection` — turn an operator's font picks into a typed
 *     `FontSelection` that the token layer and export layer consume.
 *   - `embedPermissions` — a per-family decision about whether a PDF/DOCX
 *     renderer may embed the font file, based on the recorded license.
 *   - `fontFaceCss` — an `@font-face` block scoped to a workspace, ready to
 *     be concatenated *before* the token CSS variables block so the token
 *     block's `font-family` values resolve to the loaded faces.
 *   - `summariseFontSelection` — a one-line human summary for the settings UI.
 *   - `rehydrateFontSelection` — typed load of a persisted payload.
 *
 * Design rules honoured:
 *  - No file is downloaded, generated or invented. A `FontFileReference`
 *    must name a key the caller is willing to serve; a missing reference is
 *    reported as `notEmbeddable` with a reason, never fabricated.
 *  - License terms are the operator's declaration. The module records the
 *    declaration and refuses to embed when the declaration is missing or
 *    explicitly forbids embedding. It does not validate the declaration
 *    against an upstream license database — it cannot, and pretending
 *    otherwise would be misinformation.
 *  - `family` and `weight` are validated against the CSS-shaped rules so a
 *    malicious family name cannot inject CSS.
 *  - Selection is workspace-scoped: the returned object carries the
 *    `workspaceId`, and the `@font-face` block's scope selector uses that id
 *    so a font declared for one workspace cannot load into another.
 */

import type { BrandFontStack, HexColor } from "./tokens";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type FontSelectionErrorCode = "invalid-input" | "shape" | "invalid-license";

export class FontSelectionError extends Error {
  readonly code: FontSelectionErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: FontSelectionErrorCode,
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

export const FONT_SELECTION_VERSION = "font-selection/1" as const;

/**
 * The role a font plays in the theme. Mirrors the token layer's three
 * stacks; adding a role here is a version change for both modules.
 */
export const FONT_ROLES = ["body", "heading", "mono"] as const;
export type FontRole = (typeof FONT_ROLES)[number];

/**
 * The license declaration an operator makes for a supplied font file. The
 * union is small and explicit: the module will not honour "unknown" as an
 * embed permission, because "unknown" is the answer that causes an illegal
 * embed in practice.
 */
export const FONT_LICENSE_KINDS = [
  "ofl",           // SIL Open Font License 1.1 — free to embed and redistribute.
  "apache-2.0",    // Apache 2.0 — free to embed and redistribute.
  "mit",           // MIT — free to embed and redistribute.
  "cc0",           // Public domain.
  "commercial",    // Operator-supplied commercial license; embed permission is separate.
  "web-only",      // Licensor forbids embedding in a PDF/DOCX; screen use only.
  "unknown",       // Operator has not declared the license.
] as const;
export type FontLicenseKind = (typeof FONT_LICENSE_KINDS)[number];

export interface FontLicense {
  readonly kind: FontLicenseKind;
  /**
   * The licensor's name or the license URL, when the operator supplied one.
   * Carried verbatim into the export colophon. Never fabricated.
   */
  readonly attribution: string | null;
  /**
   * Whether the operator has explicitly authorised embedding the font file
   * in the platform's PDF/DOCX exports. This is the operator's declaration,
   * not the platform's interpretation: for `web-only` or `unknown`, the
   * value is ignored and the font is not embedded.
   */
  readonly embeddingAllowed: boolean;
}

/**
 * A reference to a font file the workspace has supplied. The caller resolves
 * the `storageKey` through the storage layer; this module never touches an
 * object store.
 */
export interface FontFileReference {
  /** Stable id (e.g. the artifact row id) for cross-referencing in the UI. */
  readonly id: string;
  /**
   * Object-store key for the font file. Required when a file is present; a
   * selection with `file: null` is a family-name-only selection.
   */
  readonly storageKey: string;
  /** MIME type as recorded at upload. */
  readonly mimeType: "font/woff2" | "font/woff" | "font/ttf" | "font/otf" | "application/octet-stream";
  /** Original file name as displayed in the settings UI. */
  readonly fileName: string;
  readonly byteSize: number;
}

/**
 * A single pick. `family` is always the CSS family name; `file` is optional
 * and, when present, names the workspace's uploaded font.
 */
export interface FontPick {
  readonly role: FontRole;
  readonly family: string;
  /** Numeric weight, or null to inherit from the token default. */
  readonly weight: number | null;
  /**
   * Fallback stack appended after `family`. Operator-supplied. The module
   * does not invent a fallback; an empty array means "no fallback declared"
   * and the export renderer will use the platform's baseline fallback.
   */
  readonly fallbackFamilies: readonly string[];
  /** The supplied font file, or null for a family-name-only selection. */
  readonly file: FontFileReference | null;
  readonly license: FontLicense;
}

export interface BuildFontSelectionInput {
  readonly workspaceId: string;
  readonly picks: readonly FontPick[];
}

/**
 * The decision the export layer consults per role. `embeddable === true`
 * means the caller may pass the font file's bytes to the PDF/DOCX renderer;
 * `false` means the caller uses the family name and accepts whatever the
 * renderer's own font substitution produces.
 */
export interface EmbedDecision {
  readonly role: FontRole;
  readonly family: string;
  readonly embeddable: boolean;
  /** Why the decision came out this way; empty when embeddable === true. */
  readonly reason: string;
  /** The storage key to load, when `embeddable === true`. */
  readonly storageKey: string | null;
}

export interface FontSelection {
  readonly version: typeof FONT_SELECTION_VERSION;
  readonly workspaceId: string;
  /** Picks, in `FONT_ROLES` order; a missing role is filled with a default. */
  readonly picks: readonly FontPick[];
  readonly embed: readonly EmbedDecision[];
  /** Human-readable notes for the settings UI. Never empty when the input is empty. */
  readonly notes: readonly FontSelectionNote[];
  readonly generatedAt: string;
}

export type FontSelectionNoteKind =
  | "no-picks"
  | "duplicate-role"
  | "unknown-role"
  | "license-unknown"
  | "license-web-only"
  | "license-commercial-no-file"
  | "file-missing-for-embed"
  | "empty-fallback"
  | "family-quoted";

export interface FontSelectionNote {
  readonly kind: FontSelectionNoteKind;
  readonly detail: string;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The fallback used when a pick is missing for a role. Mirrors
 * `DEFAULT_BRAND_TOKENS.typography`: the platform does not ship a webfont, so
 * the default is the OS family stack.
 */
const DEFAULT_PICK_FOR_ROLE: Record<FontRole, FontPick> = Object.freeze({
  body: Object.freeze({
    role: "body",
    family: "system-ui",
    weight: 400,
    fallbackFamilies: Object.freeze([
      "-apple-system",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
      "sans-serif",
    ]),
    file: null,
    license: Object.freeze({ kind: "ofl", attribution: null, embeddingAllowed: false }),
  }),
  heading: Object.freeze({
    role: "heading",
    family: "system-ui",
    weight: 600,
    fallbackFamilies: Object.freeze([
      "-apple-system",
      "Segoe UI",
      "Roboto",
      "Helvetica Neue",
      "Arial",
      "sans-serif",
    ]),
    file: null,
    license: Object.freeze({ kind: "ofl", attribution: null, embeddingAllowed: false }),
  }),
  mono: Object.freeze({
    role: "mono",
    family: "ui-monospace",
    weight: 400,
    fallbackFamilies: Object.freeze([
      "SFMono-Regular",
      "Menlo",
      "Consolas",
      "Liberation Mono",
      "monospace",
    ]),
    file: null,
    license: Object.freeze({ kind: "ofl", attribution: null, embeddingAllowed: false }),
  }),
});

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildFontSelection(input: BuildFontSelectionInput): FontSelection {
  if (input === null || typeof input !== "object") {
    throw new FontSelectionError("buildFontSelection requires an input object.", "invalid-input");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    throw new FontSelectionError("`workspaceId` is required.", "invalid-input");
  }
  if (!Array.isArray(input.picks)) {
    throw new FontSelectionError("`picks` must be an array.", "invalid-input");
  }

  const notes: FontSelectionNote[] = [];
  if (input.picks.length === 0) {
    notes.push({
      kind: "no-picks",
      detail:
        "No font picks were supplied. The platform defaults are used for every role; the export renderer will resolve them against the OS/host fonts.",
    });
  }

  const byRole = new Map<FontRole, FontPick>();
  const seenRoles = new Set<FontRole>();
  for (const raw of input.picks) {
    if (raw === null || typeof raw !== "object") continue;
    const role = readRole(raw.role);
    if (role === null) {
      notes.push({
        kind: "unknown-role",
        detail: `A font pick references an unknown role (${JSON.stringify(raw.role)}); it is skipped.`,
      });
      continue;
    }
    if (seenRoles.has(role)) {
      notes.push({
        kind: "duplicate-role",
        detail: `Role "${role}" was supplied more than once; the later pick overrides the earlier.`,
      });
    }
    seenRoles.add(role);
    const validated = validatePick(raw, role, notes);
    byRole.set(role, validated);
  }

  const orderedPicks: FontPick[] = [];
  for (const role of FONT_ROLES) {
    const supplied = byRole.get(role);
    if (supplied !== undefined) {
      orderedPicks.push(supplied);
    } else {
      orderedPicks.push(DEFAULT_PICK_FOR_ROLE[role]);
    }
  }

  const embed = orderedPicks.map((p) => decideEmbed(p, notes));

  return Object.freeze({
    version: FONT_SELECTION_VERSION,
    workspaceId: input.workspaceId,
    picks: Object.freeze(orderedPicks),
    embed: Object.freeze(embed),
    notes: Object.freeze(notes),
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Compact embed-permission lookup keyed by role. This is the shape the
 * export renderers consume: a small record is easier to thread through a
 * PDF/DOCX builder than an array.
 */
export function embedPermissions(
  selection: FontSelection,
): Readonly<Record<FontRole, EmbedDecision>> {
  if (selection === null || typeof selection !== "object" || selection.version !== FONT_SELECTION_VERSION) {
    throw new FontSelectionError(
      `embedPermissions requires a FontSelection (version "${FONT_SELECTION_VERSION}").`,
      "invalid-input",
    );
  }
  const out: Partial<Record<FontRole, EmbedDecision>> = {};
  for (const d of selection.embed) out[d.role] = d;
  for (const role of FONT_ROLES) {
    if (out[role] === undefined) {
      out[role] = {
        role,
        family: DEFAULT_PICK_FOR_ROLE[role].family,
        embeddable: false,
        reason: "No decision recorded; the caller supplied a selection missing this role.",
        storageKey: null,
      };
    }
  }
  return Object.freeze(out as Record<FontRole, EmbedDecision>);
}

/**
 * Build the `@font-face` CSS block for a workspace's uploaded fonts. The
 * block is emitted before the token custom-property block so `font-family:
 * var(--zipy-font-body)` resolves to a loaded face when the workspace has
 * uploaded one, and to an OS family otherwise (which the browser resolves
 * via the fallback list).
 *
 * The selector deliberately requires the workspace's `data-zipy-workspace`
 * attribute: the loaded face cannot bleed into another workspace's DOM.
 *
 * The `src` URL is a caller-relative path: `/_fonts/<workspaceId>/<storageKey>`
 * is what the deployment serves; the module emits that path and does not
 * generate a signed URL. The caller must ensure the path is served by an
 * authenticated route; the token layer never authenticates.
 */
export function fontFaceCss(selection: FontSelection): string {
  if (selection === null || typeof selection !== "object" || selection.version !== FONT_SELECTION_VERSION) {
    throw new FontSelectionError(
      `fontFaceCss requires a FontSelection (version "${FONT_SELECTION_VERSION}").`,
      "invalid-input",
    );
  }
  const lines: string[] = [
    `/* Zipy AI font faces for workspace ${escapeCssComment(selection.workspaceId)}. */`,
  ];
  let emitted = 0;
  for (const pick of selection.picks) {
    if (pick.file === null) continue;
    const weight = pick.weight !== null ? pick.weight : 400;
    const url = `/_fonts/${encodeURIComponent(selection.workspaceId)}/${encodePath(pick.file.storageKey)}`;
    const format = formatFromMime(pick.file.mimeType);
    lines.push(
      [
        `@font-face {`,
        `  font-family: "${escapeCssString(pick.family)}";`,
        `  font-style: normal;`,
        `  font-weight: ${String(weight)};`,
        `  font-display: swap;`,
        `  src: url("${url}") format("${format}");`,
        `}`,
      ].join("\n"),
    );
    emitted += 1;
  }
  if (emitted === 0) {
    lines.push(
      "/* No uploaded font files for this workspace; the browser resolves the CSS font-family against local fonts and the declared fallback stack. */",
    );
  }
  return lines.join("\n");
}

/**
 * Turn the selection into the token layer's `BrandFontStack` shape so the
 * token layer's `typography` group can be populated from the selection
 * without a second conversion. The primary family is the pick's family,
 * followed by the pick's fallback list.
 */
export function toFontStack(pick: FontPick): BrandFontStack {
  if (pick === null || typeof pick !== "object") {
    throw new FontSelectionError("toFontStack requires a FontPick.", "invalid-input");
  }
  const families: string[] = [pick.family, ...pick.fallbackFamilies];
  return Object.freeze({
    families: Object.freeze(families),
    weight: pick.weight,
  });
}

/** One-line summary for the settings UI. Stable wording. */
export function summariseFontSelection(selection: FontSelection): string {
  if (selection.picks.length === 0) {
    return "No fonts configured; the platform defaults apply.";
  }
  const roleLabels = selection.picks.map((p) => {
    const file = p.file !== null ? " (workspace file)" : "";
    const embed = p.file !== null ? (decisionFor(selection, p.role)?.embeddable ? ", embeddable" : ", not embeddable") : "";
    return `${p.role}: ${p.family}${file}${embed}`;
  });
  const embeddable = selection.embed.filter((d) => d.embeddable).length;
  return `${roleLabels.join("; ")}. ${embeddable} of ${selection.picks.length} role(s) embed a font file in exports.`;
}

export function rehydrateFontSelection(value: unknown): FontSelection {
  if (value === null || typeof value !== "object") {
    throw new FontSelectionError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== FONT_SELECTION_VERSION) {
    throw new FontSelectionError(
      `Rehydrate failed: expected version "${FONT_SELECTION_VERSION}", received "${String(r["version"])}".`,
      "shape",
    );
  }
  const picksRaw = Array.isArray(r["picks"]) ? r["picks"] : [];
  const picks: FontPick[] = [];
  for (const raw of picksRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const role = readRole(p["role"]);
    if (role === null) continue;
    picks.push(readPick(p, role));
  }
  const embedRaw = Array.isArray(r["embed"]) ? r["embed"] : [];
  const embed: EmbedDecision[] = [];
  for (const raw of embedRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const role = readRole(e["role"]);
    if (role === null) continue;
    embed.push({
      role,
      family: typeof e["family"] === "string" ? e["family"] : "",
      embeddable: e["embeddable"] === true,
      reason: typeof e["reason"] === "string" ? e["reason"] : "",
      storageKey: typeof e["storageKey"] === "string" ? e["storageKey"] : null,
    });
  }
  const notesRaw = Array.isArray(r["notes"]) ? r["notes"] : [];
  const notes: FontSelectionNote[] = [];
  for (const raw of notesRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    if (!isNoteKind(n["kind"])) continue;
    notes.push({ kind: n["kind"], detail: typeof n["detail"] === "string" ? n["detail"] : "" });
  }
  return {
    version: FONT_SELECTION_VERSION,
    workspaceId: typeof r["workspaceId"] === "string" ? r["workspaceId"] : "",
    picks: Object.freeze(picks),
    embed: Object.freeze(embed),
    notes: Object.freeze(notes),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function validatePick(raw: FontPick, role: FontRole, notes: FontSelectionNote[]): FontPick {
  const family = readFamilyName(raw.family, `picks[${role}].family`);
  if (needsQuoting(family)) {
    notes.push({
      kind: "family-quoted",
      detail: `The family name "${family}" contains characters that require quoting; the CSS block will quote it.`,
    });
  }
  const weight = raw.weight === null || raw.weight === undefined ? null : readWeight(raw.weight, `picks[${role}].weight`);
  const fallbackFamilies = readFallback(raw.fallbackFamilies, `picks[${role}].fallbackFamilies`);
  if (fallbackFamilies.length === 0) {
    notes.push({
      kind: "empty-fallback",
      detail: `Role "${role}" declares no fallback families; a missing primary family will fall through to the renderer's own default.`,
    });
  }
  const file = readFileReference(raw.file);
  const license = readLicense(raw.license);

  if (file !== null && license.kind === "unknown") {
    notes.push({
      kind: "license-unknown",
      detail: `Role "${role}" supplies a font file but declares no license; the file is not embeddable in exports.`,
    });
  }
  if (file !== null && license.kind === "web-only") {
    notes.push({
      kind: "license-web-only",
      detail: `Role "${role}" supplies a font file licensed for web use only; the file is not embeddable in exports.`,
    });
  }
  if (file !== null && license.kind === "commercial" && license.embeddingAllowed === false) {
    notes.push({
      kind: "license-commercial-no-file",
      detail: `Role "${role}" supplies a commercial font file whose embedding permission is not granted; the file is not embeddable.`,
    });
  }
  if (file !== null && license.embeddingAllowed === false && license.kind !== "unknown" && license.kind !== "web-only") {
    notes.push({
      kind: "license-commercial-no-file",
      detail: `Role "${role}" supplies a font file whose license does not authorise embedding; the file is not embeddable in exports.`,
    });
  }

  return Object.freeze({
    role,
    family,
    weight,
    fallbackFamilies: Object.freeze(fallbackFamilies),
    file,
    license,
  });
}

function decideEmbed(pick: FontPick, notes: FontSelectionNote[]): EmbedDecision {
  if (pick.file === null) {
    return {
      role: pick.role,
      family: pick.family,
      embeddable: false,
      reason: "No font file supplied for this role; the renderer resolves the family name against its own fonts.",
      storageKey: null,
    };
  }
  if (pick.license.kind === "unknown") {
    return {
      role: pick.role,
      family: pick.family,
      embeddable: false,
      reason: "License is not declared; the platform will not embed a font file whose terms it cannot record.",
      storageKey: null,
    };
  }
  if (pick.license.kind === "web-only") {
    return {
      role: pick.role,
      family: pick.family,
      embeddable: false,
      reason: "License is web-only; embedding in a PDF or DOCX export is not permitted by the recorded terms.",
      storageKey: null,
    };
  }
  if (pick.license.embeddingAllowed !== true) {
    return {
      role: pick.role,
      family: pick.family,
      embeddable: false,
      reason: "The recorded license does not grant embedding permission.",
      storageKey: null,
    };
  }
  if (pick.file.storageKey.trim().length === 0) {
    notes.push({
      kind: "file-missing-for-embed",
      detail: `Role "${pick.role}" has license permission to embed but the file reference has no storage key.`,
    });
    return {
      role: pick.role,
      family: pick.family,
      embeddable: false,
      reason: "The file reference has no storage key; there is nothing to embed.",
      storageKey: null,
    };
  }
  return {
    role: pick.role,
    family: pick.family,
    embeddable: true,
    reason: "",
    storageKey: pick.file.storageKey,
  };
}

function readRole(v: unknown): FontRole | null {
  return v === "body" || v === "heading" || v === "mono" ? v : null;
}

function readPick(raw: Record<string, unknown>, role: FontRole): FontPick {
  const family = typeof raw["family"] === "string" && raw["family"].trim().length > 0
    ? raw["family"].trim()
    : DEFAULT_PICK_FOR_ROLE[role].family;
  const weight =
    typeof raw["weight"] === "number" && Number.isFinite(raw["weight"]) && raw["weight"] > 0
      ? raw["weight"]
      : null;
  const fallbackRaw = Array.isArray(raw["fallbackFamilies"]) ? raw["fallbackFamilies"] : [];
  const fallbackFamilies = fallbackRaw.filter((s): s is string => typeof s === "string");
  const fileRaw = raw["file"];
  let file: FontFileReference | null = null;
  if (fileRaw !== null && typeof fileRaw === "object") {
    const f = fileRaw as Record<string, unknown>;
    file = {
      id: typeof f["id"] === "string" ? f["id"] : "",
      storageKey: typeof f["storageKey"] === "string" ? f["storageKey"] : "",
      mimeType: readMimeType(f["mimeType"]),
      fileName: typeof f["fileName"] === "string" ? f["fileName"] : "",
      byteSize: typeof f["byteSize"] === "number" && Number.isFinite(f["byteSize"]) ? f["byteSize"] : 0,
    };
  }
  const licenseRaw = raw["license"];
  const license =
    licenseRaw !== null && typeof licenseRaw === "object"
      ? readLicense(licenseRaw as Partial<FontLicense>)
      : DEFAULT_PICK_FOR_ROLE[role].license;
  return Object.freeze({ role, family, weight, fallbackFamilies: Object.freeze(fallbackFamilies), file, license });
}

function readFamilyName(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new FontSelectionError(`${path} must be a non-empty string.`, "invalid-input", { path });
  }
  const trimmed = v.trim();
  // A CSS-injection attempt would carry a `;`, a `}`, or a `{`. Reject
  // rather than sanitise so the operator sees the refusal.
  if (/[;{}]/u.test(trimmed)) {
    throw new FontSelectionError(
      `${path} must not contain ";", "{", or "}"; received ${JSON.stringify(trimmed)}.`,
      "invalid-input",
      { path, value: trimmed },
    );
  }
  return trimmed;
}

function readWeight(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new FontSelectionError(`${path} must be a positive finite number.`, "invalid-input", { path });
  }
  return v;
}

function readFallback(v: unknown, path: string): readonly string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new FontSelectionError(`${path} must be an array of family names.`, "invalid-input", { path });
  }
  const out: string[] = [];
  for (const f of v) {
    if (typeof f !== "string" || f.trim().length === 0) {
      throw new FontSelectionError(
        `${path} entries must be non-empty strings; received ${JSON.stringify(f)}.`,
        "invalid-input",
        { path, value: f },
      );
    }
    if (/[;{}]/u.test(f)) {
      throw new FontSelectionError(`${path} entries must not contain ";", "{", or "}".`, "invalid-input", {
        path,
        value: f,
      });
    }
    out.push(f.trim());
  }
  return out;
}

function readFileReference(v: unknown): FontFileReference | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") {
    throw new FontSelectionError("`file` must be a FontFileReference or null.", "invalid-input");
  }
  const f = v as Record<string, unknown>;
  if (typeof f["storageKey"] !== "string" || f["storageKey"].trim().length === 0) {
    throw new FontSelectionError("`file.storageKey` is required when a file is supplied.", "invalid-input");
  }
  if (typeof f["id"] !== "string" || f["id"].trim().length === 0) {
    throw new FontSelectionError("`file.id` is required when a file is supplied.", "invalid-input");
  }
  return Object.freeze({
    id: f["id"],
    storageKey: f["storageKey"],
    mimeType: readMimeType(f["mimeType"]),
    fileName: typeof f["fileName"] === "string" ? f["fileName"] : "",
    byteSize: typeof f["byteSize"] === "number" && Number.isFinite(f["byteSize"]) ? f["byteSize"] : 0,
  });
}

function readMimeType(v: unknown): FontFileReference["mimeType"] {
  return v === "font/woff2" ||
    v === "font/woff" ||
    v === "font/ttf" ||
    v === "font/otf" ||
    v === "application/octet-stream"
    ? v
    : "application/octet-stream";
}

function readLicense(v: unknown): FontLicense {
  if (v === null || typeof v !== "object") {
    return Object.freeze({ kind: "unknown", attribution: null, embeddingAllowed: false });
  }
  const o = v as Partial<FontLicense>;
  const kind: FontLicenseKind =
    o.kind === "ofl" ||
    o.kind === "apache-2.0" ||
    o.kind === "mit" ||
    o.kind === "cc0" ||
    o.kind === "commercial" ||
    o.kind === "web-only" ||
    o.kind === "unknown"
      ? o.kind
      : "unknown";
  const attribution = typeof o.attribution === "string" && o.attribution.trim().length > 0 ? o.attribution : null;
  // The permission is only true for licenses the module knows permit
  // embedding, or when the operator explicitly declared it for a commercial
  // license. `unknown` and `web-only` never yield `true`.
  const declared = o.embeddingAllowed === true;
  const embeddingAllowed =
    kind === "ofl" || kind === "apache-2.0" || kind === "mit" || kind === "cc0"
      ? true
      : kind === "commercial"
        ? declared
        : false;
  return Object.freeze({ kind, attribution, embeddingAllowed });
}

function formatFromMime(mime: FontFileReference["mimeType"]): string {
  switch (mime) {
    case "font/woff2":
      return "woff2";
    case "font/woff":
      return "woff";
    case "font/ttf":
      return "truetype";
    case "font/otf":
      return "opentype";
    case "application/octet-stream":
      return "woff2";
  }
}

function needsQuoting(family: string): boolean {
  return !/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(family);
}

function escapeCssString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeCssComment(s: string): string {
  return s.replace(/\*\//g, "*\u200b/");
}

function encodePath(storageKey: string): string {
  // Preserve "/" segments so a nested key stays nested, but encode every
  // other character to keep the URL well-formed and path-traversal-free.
  return storageKey
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function decisionFor(selection: FontSelection, role: FontRole): EmbedDecision | undefined {
  for (const d of selection.embed) if (d.role === role) return d;
  return undefined;
}

function isNoteKind(v: unknown): v is FontSelectionNoteKind {
  return (
    v === "no-picks" ||
    v === "duplicate-role" ||
    v === "unknown-role" ||
    v === "license-unknown" ||
    v === "license-web-only" ||
    v === "license-commercial-no-file" ||
    v === "file-missing-for-embed" ||
    v === "empty-fallback" ||
    v === "family-quoted"
  );
}

/* -------------------------------------------------------------------------- */
/* Unused re-export marker                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Re-exported here so a caller importing `@zipy/branding/fonts` does not have
 * to import two files to construct a theme; kept as a type-only export to
 * avoid a runtime cycle between `tokens.ts` and `fonts.ts`.
 */
export type { BrandFontStack, HexColor };

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  DEFAULT_PICK_FOR_ROLE,
  readRole,
  readFamilyName,
  readWeight,
  readFallback,
  readFileReference,
  readMimeType,
  readLicense,
  formatFromMime,
  needsQuoting,
  escapeCssString,
  escapeCssComment,
  encodePath,
  decideEmbed,
  validatePick,
  isNoteKind,
});
