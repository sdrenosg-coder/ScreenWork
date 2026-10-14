/**
 * Zipy AI — interactive-element index.
 *
 * Walks a compacted accessibility tree, identifies actionable elements, and
 * assigns each a *stable reference* (see `packages/ingest/src/stableRefs.ts`)
 * so a workflow plan can point at a specific element without embedding a
 * brittle CSS selector inline. The table below is the single hand-off between
 * "what the page contains" and "what the LLM plans against".
 *
 * Design notes:
 *  - This module is pure: it takes an `A11yNode` (from `a11y.ts`) and produces
 *    an ordered array of `IndexedElement`. It does not know how to talk to a
 *    browser, does not touch the network and does not persist anything.
 *  - Stability guarantee: the index is *deterministic* for a given tree. Two
 *    equivalent pages produce the same ordering, and the stable ref assigned
 *    to an element (see `stableRefs.ts`) depends on the element's *identity*
 *    (role + accessible name + ordinal among same-role-same-name peers), not
 *    its pixel position — so cosmetic reflows do not invalidate plans.
 *  - `ambiguity` is preserved rather than hidden. When two buttons both read
 *    "Save", the element's `ambiguous` flag is set and `duplicateOf` is filled.
 *    Downstream consumers widen their selectors or flag for review; they do
 *    not silently pick one.
 *  - The index is intentionally flat. Nested containers are already encoded in
 *    `depth`; hierarchy is available through `containerId` when useful.
 */

import {
  isInteractiveRole,
  walkA11y,
  type A11yNode,
} from "./a11y.ts";

/* -------------------------------------------------------------------------- */
/* Index element shape                                                         */
/* -------------------------------------------------------------------------- */

export interface IndexedElement {
  /**
   * Stable reference assigned by `stableRefs.assignStableRefs`. Format is
   * documented in that module (e.g. `e3`, `textbox-email-2`). Never a raw
   * selector.
   */
  readonly ref: string;
  /** ARIA role of the element (lowercased). */
  readonly role: string;
  /** Accessible name. May be empty for icon-only buttons — see `ambiguous`. */
  readonly name: string;
  /** Current value, when the element carries a value. */
  readonly value: string | number | boolean | null;
  /** The DOM path captured at snapshot time, if available. Opaque to this module. */
  readonly domPath: string | null;
  /** Structural depth in the accessibility tree (0-based). */
  readonly depth: number;
  /** States (checked, disabled, expanded, etc.). */
  readonly states: Readonly<Record<string, string | number | boolean>>;
  /** Whether the element is usable (not disabled, not hidden). */
  readonly enabled: boolean;
  /** Whether the element is normally visible. Not derived from styles. */
  readonly visible: boolean;
  /**
   * True when more than one element shares (role, name) in this snapshot.
   * Plans targeting an ambiguous element must disambiguate via scope.
   */
  readonly ambiguous: boolean;
  /**
   * The ref of the first identical (role, name) element, when `ambiguous` is
   * true. Used by the synthesis layer to add scope (e.g. "the second Save
   * button").
   */
  readonly duplicateOf: string | null;
  /** Nearest container role in scope at the time of capture, if any. */
  readonly containerRole: string | null;
}

export interface ElementIndex {
  /** Ordered by document order (pre-order traversal of the a11y tree). */
  readonly elements: readonly IndexedElement[];
  /** Fast lookup by ref. */
  readonly byRef: Readonly<Record<string, IndexedElement>>;
  /** (role, name) → ordered list of refs, for ambiguity lookups. */
  readonly byRoleAndName: Readonly<Record<string, readonly string[]>>;
  /** Roles present, so planners can ask "is there a combobox on this page?". */
  readonly rolesPresent: readonly string[];
  /** The dimension of the page each element lives in (only one in this phase). */
  readonly viewportCount: 1;
  /** Count of interactive elements, for cost estimation. */
  readonly count: number;
  /** Count of ambiguous elements (role+name collisions). */
  readonly ambiguityCount: number;
}

/* -------------------------------------------------------------------------- */
/* Role groups                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Roles that accept typed input. Kept here because the synthesis phase needs
 * to distinguish "click" from "type" from "select" without re-deriving the
 * classification.
 */
export const INPUT_ROLES: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
  "textfield",
]);

/** Roles that are chosen from a fixed set (select, radio, checkbox, tabs). */
export const SELECTION_ROLES: ReadonlySet<string> = new Set([
  "checkbox",
  "radio",
  "switch",
  "tab",
  "option",
  "menuitemradio",
  "menuitemcheckbox",
]);

/** Roles that submit, navigate or otherwise trigger an action. */
export const ACTION_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "option",
  "treeitem",
]);

/* -------------------------------------------------------------------------- */
/* Visibility / enablement inference                                           */
/* -------------------------------------------------------------------------- */

function isEnabled(states: Readonly<Record<string, string | number | boolean>>): boolean {
  const disabled = states["disabled"];
  return !(disabled === true || disabled === "true");
}

function isVisible(node: A11yNode): boolean {
  // Playwright omits nodes it considers hidden when `interestingOnly: true`
  // (the default). When a caller disables that filter we still honour an
  // explicit `hidden` state if the engine supplies one.
  const hiddenState = node.states["hidden"];
  if (hiddenState === true) return false;
  // A collapsed section contains hidden descendants, but the section itself is
  // visible. Only drop a node when it is explicitly marked hidden above.
  return true;
}

/** A role/name pair that is safe as an ambiguity key. */
function ambiguityKey(role: string, name: string): string {
  return `${role}\u0000${name}`;
}

/* -------------------------------------------------------------------------- */
/* Index construction                                                          */
/* -------------------------------------------------------------------------- */

export interface BuildIndexOptions {
  /**
   * When true (default), disabled elements appear in the index but are marked
   * `enabled: false`. This lets plans explain "the Save button is present but
   * disabled until the form is complete" without re-running the browser.
   */
  readonly includeDisabled?: boolean;
  /**
   * When true, elements whose accessible name is empty are still included.
   * Defaults to true because icon-only controls are common; consumers can
   * filter them out with `hasName`.
   */
  readonly includeUnnamed?: boolean;
  /**
   * Assign refs with the provided assigner. When omitted, `elementIndex`
   * uses the deterministic surrogate ref `e<ordinal>` so callers that do not
   * need stable refs (e.g. quick page summaries) get a working index without
   * importing `stableRefs`.
   */
  readonly assignRef?: (element: Omit<IndexedElement, "ref">, ordinal: number, all: readonly Omit<IndexedElement, "ref">[]) => string;
}

/**
 * Build an `ElementIndex` from a compacted accessibility tree. Pure and
 * deterministic.
 *
 * The traversal is pre-order over the tree, so `elements` is in document order
 * (or close to it, given that accessibility trees preserve DOM order for
 * siblings). That ordering is what `stableRefs` keys on for its ordinal
 * fallback, so both modules agree on which element "is" the second Save button.
 */
export function buildElementIndex(
  root: A11yNode,
  opts: BuildIndexOptions = {},
): ElementIndex {
  const includeDisabled = opts.includeDisabled ?? true;
  const includeUnnamed = opts.includeUnnamed ?? true;
  const assignRef = opts.assignRef ?? defaultRefAssigner;

  const preRefs: Omit<IndexedElement, "ref">[] = [];
  let containerRole: string | null = null;

  // Containers are not part of the index but we track the innermost container
  // a node lives in so plans can say "the Email field in the Signup form".
  const containerStack: (string | null)[] = [null];
  containerRole = null;

  for (const node of walkA11y(root)) {
    while (containerStack.length - 1 > node.depth) {
      containerStack.pop();
    }
    const inheritedContainer = containerStack[containerStack.length - 1] ?? null;
    const isContainer =
      !node.interactive &&
      (node.children.length > 0 || node.role === "form" || node.role === "dialog" || node.role === "navigation" || node.role === "main");

    if (node.interactive || isInteractiveRole(node.role)) {
      const enabled = isEnabled(node.states);
      const visible = isVisible(node);
      if (!includeDisabled && !enabled) continue;
      if (!includeUnnamed && node.name.trim().length === 0) continue;

      preRefs.push({
        role: node.role,
        name: node.name,
        value: node.value,
        domPath: node.domPath,
        depth: node.depth,
        states: node.states,
        enabled,
        visible,
        ambiguous: false,
        duplicateOf: null,
        containerRole: inheritedContainer,
      });
      // Interactive elements are not themselves containers in this phase; they
      // may have children in the a11y tree but those children remain siblings
      // of the interactive node in DOM order for our purposes.
      containerStack.push(inheritedContainer);
      continue;
    }

    if (isContainer) {
      containerRole = node.role;
      containerStack.push(containerRole);
    } else {
      containerStack.push(inheritedContainer);
    }
  }

  // Second pass: assign refs and detect ambiguity.
  const byRoleAndNameMutable: Record<string, string[]> = {};
  const elements: IndexedElement[] = [];
  const duplicatesByKey = new Map<string, string>(); // (role, name) → first ref

  for (let i = 0; i < preRefs.length; i += 1) {
    const pre = preRefs[i] as Omit<IndexedElement, "ref">;
    const ref = assignRef(pre, i, preRefs);
    const key = ambiguityKey(pre.role, pre.name);
    const firstRef = duplicatesByKey.get(key);
    const ambiguous = firstRef !== undefined && pre.name.trim().length > 0;

    if (pre.name.trim().length > 0) {
      const list = byRoleAndNameMutable[key] ?? (byRoleAndNameMutable[key] = []);
      list.push(ref);
      if (firstRef === undefined) duplicatesByKey.set(key, ref);
    }

    elements.push({
      ...pre,
      ref,
      ambiguous,
      duplicateOf: ambiguous ? (firstRef as string) : null,
    });
  }

  // Recompute the ambiguity flag on the *first* occurrence (which will already
  // have been pushed with ambiguous=false because duplicatesByKey was empty).
  // The first occurrence's eventual ambiguity is knowable only after the whole
  // pass, so we patch it in a final sweep.
  const finalElements: IndexedElement[] = elements.map((el) => {
    if (el.name.trim().length === 0) return el;
    const list = byRoleAndNameMutable[ambiguityKey(el.role, el.name)];
    if (list === undefined || list.length <= 1) return el;
    if (el.ref === list[0]) {
      return { ...el, ambiguous: true, duplicateOf: list[1] ?? null };
    }
    return el;
  });

  const byRef: Record<string, IndexedElement> = {};
  const byRoleAndName: Record<string, readonly string[]> = {};
  for (const el of finalElements) {
    byRef[el.ref] = el;
  }
  for (const [key, refs] of Object.entries(byRoleAndNameMutable)) {
    byRoleAndName[key] = refs.slice();
  }

  const rolesPresentSet = new Set<string>();
  for (const el of finalElements) rolesPresentSet.add(el.role);

  const ambiguityCount = finalElements.filter((el) => el.ambiguous).length;

  return {
    elements: finalElements,
    byRef,
    byRoleAndName,
    rolesPresent: Array.from(rolesPresentSet).sort(),
    viewportCount: 1,
    count: finalElements.length,
    ambiguityCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

export function findElementByRef(
  index: ElementIndex,
  ref: string,
): IndexedElement | null {
  return index.byRef[ref] ?? null;
}

export function findElementsByRole(
  index: ElementIndex,
  role: string,
): readonly IndexedElement[] {
  const lowered = role.toLowerCase();
  return index.elements.filter((el) => el.role === lowered);
}

export function findElementsByName(
  index: ElementIndex,
  name: string,
): readonly IndexedElement[] {
  const needle = name.toLowerCase();
  return index.elements.filter((el) => el.name.toLowerCase() === needle);
}

/**
 * Best-effort element lookup by an informal description (role + partial name).
 * Used by the synthesis phase as a *fallback* when the LLM's plan references
 * an element that no longer exists in the index. It does not invent a match:
 * it returns an empty list when nothing plausible is found.
 */
export function searchElements(
  index: ElementIndex,
  query: { readonly role?: string; readonly nameContains?: string; readonly enabledOnly?: boolean },
): readonly IndexedElement[] {
  const roleFilter = query.role?.toLowerCase();
  const nameFilter = query.nameContains?.toLowerCase();
  const enabledOnly = query.enabledOnly ?? false;
  const out: IndexedElement[] = [];
  for (const el of index.elements) {
    if (roleFilter !== undefined && el.role !== roleFilter) continue;
    if (nameFilter !== undefined && !el.name.toLowerCase().includes(nameFilter)) continue;
    if (enabledOnly && !el.enabled) continue;
    out.push(el);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Helpers used by synthesis and testing                                       */
/* -------------------------------------------------------------------------- */

/** True when the element accepts typed input. */
export function isInputRole(role: string): boolean {
  return INPUT_ROLES.has(role.toLowerCase());
}

/** True when the element is chosen from a fixed set. */
export function isSelectionRole(role: string): boolean {
  return SELECTION_ROLES.has(role.toLowerCase());
}

/** True when clicking the element triggers an action. */
export function isActionRole(role: string): boolean {
  return ACTION_ROLES.has(role.toLowerCase());
}

/** Filter to elements with a non-empty accessible name. */
export function namedElements(index: ElementIndex): readonly IndexedElement[] {
  return index.elements.filter((el) => el.name.trim().length > 0);
}

/** Filter to elements that are enabled and visible. */
export function actionableElements(index: ElementIndex): readonly IndexedElement[] {
  return index.elements.filter((el) => el.enabled && el.visible);
}

/**
 * Default ref assigner used when the caller does not supply one. Produces
 * `e<ordinal>` (1-based, zero-padded to 3 digits) so plans remain readable.
 * `stableRefs.ts` overrides this with a semantically-richer scheme.
 */
function defaultRefAssigner(
  _element: Omit<IndexedElement, "ref">,
  ordinal: number,
  _all: readonly Omit<IndexedElement, "ref">[],
): string {
  return `e${String(ordinal + 1).padStart(3, "0")}`;
}
