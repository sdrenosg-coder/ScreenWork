/**
 * Zipy AI — stable element reference assignment.
 *
 * The workflow planner never embeds CSS selectors in a plan. Instead, each
 * indexed element receives a *stable reference* — a short, semantically-loaded
 * identifier that the planner and executor agree on. Stability means: if the
 * page renders again with the same accessible content, the element receives
 * the same ref even if a sibling was inserted above it or its pixel position
 * moved. The ref is bound to *identity*, not to layout.
 *
 * Ref scheme:
 *   - `<role>-<slug>-<n>` when the element has a non-empty accessible name.
 *       <role>  lowercased ARIA role, `[a-z][a-z0-9]*`
 *       <slug>  accessible name, lowercased, ASCII-folded, non-alphanumeric
 *               runs collapsed to single `-`, truncated to 32 characters
 *       <n>     1-based ordinal among elements with the SAME (role, slug).
 *               Omitted when 1.
 *     Examples: `button-save`, `button-save-2`, `textbox-email`,
 *               `menuitem-new-customer`.
 *   - `role-<index>` when the element has an empty accessible name (icon-only
 *     controls serve as the canonical case). <index> is 1-based among
 *     unnamed elements of that role, in document order.
 *     Examples: `button-1`, `link-3`.
 *
 * Design notes:
 *  - The ref uses only `[a-z0-9-]` so a plan file, URL fragment or JSON key
 *    can carry it safely.
 *  - Collisions across different roles are impossible (role is a prefix).
 *    Collisions within the same (role, name) are disambiguated by the ordinal,
 *    and the element-index layer marks both as `ambiguous`. The ordinals used
 *    here match the ordering produced by `buildElementIndex`, so refs and
 *    `duplicateOf` values agree.
 *  - Refs are assigned in a single pass and are collected into the index via
 *    `buildElementIndex(..., { assignRef })`. Callers who build an index
 *    without this module get surrogate refs (`e001`) — usable for display
 *    but not intended as a long-lived handle.
 *  - No credentials, no network, no I/O. Pure.
 */

import type { IndexedElement } from "./elementIndex.ts";

/* -------------------------------------------------------------------------- */
/* Slugification                                                               */
/* -------------------------------------------------------------------------- */

const MAX_SLUG_LENGTH = 32;

/**
 * Produce a deterministic, ASCII-safe slug from an arbitrary accessible name.
 * Returns an empty string when the input contains no `[A-Za-z0-9]` characters.
 *
 * The ASCII-fold step strips combining diacritics so "Déjà" → "deja", which
 * keeps refs stable across locales that differ only in accent rendering
 * (some engines emit composed characters, some decomposed — this makes both
 * hash to the same ref).
 */
export function slugifyName(name: string): string {
  if (typeof name !== "string" || name.length === 0) return "";
  // NFD-normalise then drop combining marks so accents fold regardless of the
  // source form (NFC vs NFD). Latin-1 supplement + combining diacritics block
  // are the common cases; full Unicode transliteration is out of scope.
  const folded = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const lower = folded.toLowerCase();
  const cleaned = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "";
  return cleaned.length > MAX_SLUG_LENGTH
    ? cleaned.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "")
    : cleaned;
}

/* -------------------------------------------------------------------------- */
/* Ref construction                                                            */
/* -------------------------------------------------------------------------- */

const ROLE_PATTERN = /^[a-z][a-z0-9 ]*$/;

function normalizeRole(role: string): string {
  if (typeof role !== "string" || role.length === 0) return "generic";
  const lowered = role.toLowerCase();
  if (!ROLE_PATTERN.test(lowered)) {
    // Fallback: drop anything that could break a ref format.
    return lowered.replace(/[^a-z0-9]/g, "");
  }
  return lowered.replace(/\s+/g, "-");
}

/**
 * Compute a stable ref for one element given the ordinal that `buildElementIndex`
 * will produce. Exported so tests can assert against a single source of truth.
 *
 * `sameRoleSameSlugOrdinal` is the 1-based position of this element among
 * elements with the same (role, slug) in document order. For unnamed elements,
 * `unnamedRoleOrdinal` plays the same role.
 */
export function computeStableRef(input: {
  readonly role: string;
  readonly name: string;
  /** 1-based; position among same (role, slug). */
  readonly sameRoleSameSlugOrdinal: number;
  /** 1-based; position among unnamed elements of the same role. */
  readonly unnamedRoleOrdinal: number;
}): string {
  const role = normalizeRole(input.role);
  const slug = slugifyName(input.name);
  if (slug.length === 0) {
    // Unnamed element: `role-<n>`.
    return `${role}-${Math.max(1, input.unnamedRoleOrdinal)}`;
  }
  if (input.sameRoleSameSlugOrdinal <= 1) {
    return `${role}-${slug}`;
  }
  return `${role}-${slug}-${input.sameRoleSameSlugOrdinal}`;
}

/* -------------------------------------------------------------------------- */
/* Batch assignment (used as `assignRef` in buildElementIndex)                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a ref assigner that is aware of the entire element list, so the
 * ordinals computed here exactly match the document-ordered list produced by
 * `buildElementIndex`.
 *
 * Usage:
 *   const assignRef = createStableRefAssigner();
 *   const index = buildElementIndex(root, { assignRef });
 */
export function createStableRefAssigner(): (
  element: Omit<IndexedElement, "ref">,
  ordinal: number,
  all: readonly Omit<IndexedElement, "ref">[],
) => string {
  return (element, ordinal, all) => {
    const role = normalizeRole(element.role);
    const slug = slugifyName(element.name);

    if (slug.length === 0) {
      // Unnamed: position among *unnamed* elements of this role in document
      // order (i.e. in `all` before this ordinal).
      let unnamedRoleOrdinal = 0;
      for (let i = 0; i <= ordinal && i < all.length; i += 1) {
        const peer = all[i];
        if (peer === undefined) continue;
        if (normalizeRole(peer.role) !== role) continue;
        if (slugifyName(peer.name).length > 0) continue;
        unnamedRoleOrdinal += 1;
      }
      return computeStableRef({
        role: element.role,
        name: element.name,
        sameRoleSameSlugOrdinal: 1,
        unnamedRoleOrdinal: Math.max(1, unnamedRoleOrdinal),
      });
    }

    let sameRoleSameSlugOrdinal = 0;
    for (let i = 0; i <= ordinal && i < all.length; i += 1) {
      const peer = all[i];
      if (peer === undefined) continue;
      if (normalizeRole(peer.role) !== role) continue;
      if (slugifyName(peer.name) !== slug) continue;
      sameRoleSameSlugOrdinal += 1;
    }
    return computeStableRef({
      role: element.role,
      name: element.name,
      sameRoleSameSlugOrdinal: Math.max(1, sameRoleSameSlugOrdinal),
      unnamedRoleOrdinal: 1,
    });
  };
}

/* -------------------------------------------------------------------------- */
/* Parsing + validation                                                        */
/* -------------------------------------------------------------------------- */

/** Matches the ref format produced by `computeStableRef`. */
export const STABLE_REF_PATTERN =
  /^[a-z][a-z0-9-]*(-[a-z0-9-]+)(-\d+)?$/;

/** True when `value` looks like a stable ref (used to validate plan steps). */
export function isStableRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 96) return false;
  if (!STABLE_REF_PATTERN.test(value)) return false;
  // Reject the surrogate form (`e001`), which never contains a hyphen but will
  // pass the pattern because the leading class allows a full word. We require
  // at least one hyphen, which corresponds to `role-name` or `role-name-n`.
  return value.includes("-");
}

/**
 * Extract the (role, slug, ordinal) triple from a ref. Returns `null` when the
 * ref does not match the expected shape. Used by the change detector to reason
 * about "the same element, different page" and by the UI to render a
 * user-facing name when the full IndexedElement is not to hand.
 */
export interface ParsedRef {
  readonly role: string;
  readonly slug: string;
  readonly ordinal: number;
  readonly unnamed: boolean;
}

export function parseStableRef(ref: string): ParsedRef | null {
  if (!isStableRef(ref)) return null;
  // Split off a trailing ordinal if it exists.
  const ordinalMatch = /-(\d+)$/.exec(ref);
  let base = ref;
  let ordinal = 1;
  if (ordinalMatch !== null) {
    ordinal = Number(ordinalMatch[1]);
    base = ref.slice(0, ref.length - ordinalMatch[0].length);
  }
  const hyphen = base.indexOf("-");
  if (hyphen <= 0 || hyphen === base.length - 1) return null;
  const role = base.slice(0, hyphen);
  const slug = base.slice(hyphen + 1);
  if (slug.length === 0) return null;
  // An `unnamed` ref has no alphabetic characters after the last hyphen (just
  // an ordinal). Distinguish from a name like "button-2024" by checking if the
  // slug itself contains any letters.
  const unnamed = !/[a-z]/.test(slug);
  return { role, slug, ordinal, unnamed };
}

/* -------------------------------------------------------------------------- */
/* Determinism guard                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Assign refs to `elements` in document order using `createStableRefAssigner`.
 * Exported for callers that already have `Omit<IndexedElement, "ref">[]` (for
 * example, when re-indexing a snapshot that was stored without refs) and want
 * the canonical output. The output is deterministic and matches what
 * `buildElementIndex` would have produced for the same input.
 */
export function assignStableRefs(
  elements: readonly Omit<IndexedElement, "ref">[],
): readonly IndexedElement[] {
  const assign = createStableRefAssigner();
  const preRefs = elements.slice();
  const out: IndexedElement[] = [];
  for (let i = 0; i < preRefs.length; i += 1) {
    const pre = preRefs[i] as Omit<IndexedElement, "ref">;
    const ref = assign(pre, i, preRefs);
    out.push({ ...pre, ref });
  }
  return out;
}
