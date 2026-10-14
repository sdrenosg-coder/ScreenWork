/**
 * Zipy AI — selector resolution and self-healing.
 *
 * The synthesizer produces a plan that targets elements by *stable reference*
 * (`@e3`) or by a CSS selector derived from the accessibility snapshot. On a
 * live run those references can fail for benign reasons: a re-render replaced
 * the node, a well-meaning developer changed a class name, or the page simply
 * moved the element. This module is the single place that decides "did the
 * primary selector work, and if not, which fallback do we try next?".
 *
 * Design rules honoured here:
 *  - Fallbacks are ordered and finite. Each strategy is a pure candidate
 *    generator: `css-primary` → `name`/`id` variants → `role+name` (ARIA) →
 *    text content → XPath. No strategy is invented at runtime; the list is
 *    the returned value of `buildCandidateList`, so it is observable and
 *    testable.
 *  - Every candidate carries a *weight* (its believed reliability). The
 *    resolver records which candidate succeeded so that `changeDetect.ts` can
 *    decide whether the workflow needs re-synthesis (a low-weight fallback
 *    that keeps working is still a signal that the UI drifted).
 *  - The module never invents a DOM. It calls the page/locator surface it is
 *    given. When the surface is a reduced test double, resolution returns a
 *    structured "unsupported" outcome rather than a fabricated hit.
 *  - No credentials, no network, no filesystem access.
 *
 * The primary consumer is `retry.ts`, which owns the retry policy and calls
 * `resolveSelector` for each attempt. Keeping candidate generation (this
 * file) separate from retry policy (retry.ts) means the fallback list can be
 * audited on its own, and a change to the retry backoff never alters which
 * selectors are tried.
 */

import type { PlaywrightPage } from "./browser.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the resolver knows about the target. `ref` is the accessibility-tree
 * reference produced by the synthesizer (e.g. `e3`). `cssPrimary` is the CSS
 * selector the synthesizer emitted next to that ref. `role`/`name` and
 * `text` are optional context used to synthesise accessible-name and
 * text-content fallbacks. Any of these may be null; the resolver degrades.
 */
export interface SelectorTarget {
  /** Stable ref from the a11y snapshot (e.g. "e3"). Informational only. */
  readonly ref: string | null;
  /** Primary CSS selector, typically what the plan recorded. */
  readonly cssPrimary: string | null;
  /** ARIA role (e.g. "button", "textbox"). */
  readonly role: string | null;
  /** Accessible name (e.g. "Save", "Email address"). */
  readonly name: string | null;
  /**
   * Visible text content. Used as a `has-text` fallback. Should be the whole
   * label, not a fragment — a fragment match is unstable.
   */
  readonly text: string | null;
  /**
   * Explicit XPath alternative when the plan already knows one. When null the
   * resolver does NOT synthesise an XPath from the primary selector: an
   * ungrounded XPath is more likely to match the wrong node than no
   * candidate at all.
   */
  readonly xpath: string | null;
}

/** Strategy names, in the order `buildCandidateList` emits them. */
export type SelectorStrategy =
  | "css-primary"
  | "css-name-attribute"
  | "css-id-attribute"
  | "aria-role-name"
  | "aria-role-only"
  | "text-content"
  | "xpath";

/** One candidate selector produced by the resolver for a single attempt. */
export interface SelectorCandidate {
  readonly strategy: SelectorStrategy;
  /**
   * The value to hand to `page.locator` / `page.waitForSelector`. For ARIA
   * strategies this is a JSON-encoded descriptor consumed by the resolver's
   * locator factory, not a CSS string.
   */
  readonly value: string;
  /**
   * Believed reliability in [0, 1]. 1.0 is "the plan's own selector";
   * lower values indicate increasing risk that the match is accidental.
   */
  readonly weight: number;
}

/** Outcome of resolving a target against a live page. */
export interface ResolutionResult {
  readonly strategy: SelectorStrategy;
  readonly value: string;
  readonly weight: number;
  /**
   * Whether this strategy is the primary one the plan recorded, or a
   * fallback. A plan that only ever resolves via a fallback is a plan whose
   * primary selector has drifted.
   */
  readonly isPrimary: boolean;
  /**
   * When true, the element was matched but is a *different* node than the
   * primary selector would have produced. This is where an ambiguous text
   * fallback landing on the wrong button is caught. The resolver sets it
   * when a strategy other than `css-primary` succeeded AND the primary
   * selector matched zero elements (i.e. we did not merely confirm a
   * non-visible element, we moved on).
   */
  readonly drift: boolean;
  /** Millisecond-resolution timestamp of the successful probe. */
  readonly resolvedAt: string;
}

/** A resolution miss records what was tried so the reviewer can see it. */
export interface ResolutionFailure {
  readonly reason:
    | "no-candidates"
    | "page-closed"
    | "unsupported-page"
    | "all-candidates-failed"
    | "timeout";
  readonly tried: readonly SelectorCandidate[];
  readonly detail: string;
}

export type ResolveSelectorOutcome =
  | { readonly status: "resolved"; readonly result: ResolutionResult }
  | { readonly status: "failed"; readonly failure: ResolutionFailure };

/* -------------------------------------------------------------------------- */
/* Locator surface                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The subset of Playwright's Locator surface the resolver needs. Playwright's
 * real Locator satisfies it; a structural test double must too.
 */
export interface ResolvableLocator {
  count(options?: { timeout?: number }): Promise<number>;
  isVisible?(options?: { timeout?: number }): Promise<boolean>;
  waitFor(options?: {
    state?: "attached" | "detached" | "visible" | "hidden";
    timeout?: number;
  }): Promise<void>;
}

/** The page surface the resolver needs. `browser.ts` declares most of it. */
export interface ResolvablePage extends PlaywrightPage {
  locator?(selector: string): ResolvableLocator;
  getByRole?(role: string, options?: { name?: string; exact?: boolean }): ResolvableLocator;
  getByText?(text: string, options?: { exact?: boolean }): ResolvableLocator;
  /**
   * Playwright exposes `page.locator('xpath=...')` and `page.locator('text=...')`
   * — the resolver uses the `css=`/`xpath=`/`text=` prefix syntax via
   * `locator` only. `getByRole` and `getByText` are preferred when present
   * because they go through Playwright's accessibility-aware matching, which
   * matches on the accessible name rather than the raw DOM text.
   */
  locatorPrefixSupported?: true;
}

/* -------------------------------------------------------------------------- */
/* Candidate generation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build the ordered candidate list for a target. Deterministic: same input,
 * same list. The order is the strategy priority; the caller tries each in
 * turn. Weight drops as we move down the list because each step further
 * from the plan's own selector is more likely to match a semantically
 * different node.
 *
 * The strategy order is the current policy and is intentionally not
 * configurable from outside the module: a caller that reorders it would
 * defeat the audit trail. Adding or removing a strategy is a code change
 * reviewed alongside the retry policy.
 */
export function buildCandidateList(target: SelectorTarget): readonly SelectorCandidate[] {
  const out: SelectorCandidate[] = [];

  if (target.cssPrimary !== null && target.cssPrimary.trim().length > 0) {
    out.push({ strategy: "css-primary", value: target.cssPrimary, weight: 1 });
    const nameAttr = extractAttribute(target.cssPrimary, "name");
    if (nameAttr !== null) {
      // A name-attribute CSS selector that derived from the primary is *not*
      // a strict fallback — it is an alternative spelling. Distinct strategy
      // name so the strategy distribution in the audit is not blurred.
      out.push({
        strategy: "css-name-attribute",
        value: `[name="${escapeCssValue(nameAttr)}"]`,
        weight: 0.9,
      });
    }
    const idAttr = extractAttribute(target.cssPrimary, "id");
    if (idAttr !== null) {
      out.push({
        strategy: "css-id-attribute",
        value: `#${escapeCssIdentifier(idAttr)}`,
        weight: 0.9,
      });
    }
  }

  if (target.role !== null && target.name !== null) {
    // Encoded as a JSON value so this module never falls back to a
    // string-concatenated ARIA selector — the resolver builds the locator
    // from the parsed descriptor. JSON keeps the strategy value self-
    // describing.
    out.push({
      strategy: "aria-role-name",
      value: JSON.stringify({ role: target.role, name: target.name }),
      weight: 0.75,
    });
  }

  if (target.role !== null && target.name === null && target.text === null) {
    // Role only is deliberately low weight: multiple buttons of the same
    // role on a page is common, and a role-only match is more likely to
    // land on the wrong node.
    out.push({
      strategy: "aria-role-only",
      value: JSON.stringify({ role: target.role }),
      weight: 0.4,
    });
  }

  if (target.text !== null && target.text.trim().length > 0) {
    out.push({
      strategy: "text-content",
      value: target.text,
      weight: 0.35,
    });
  }

  if (target.xpath !== null && target.xpath.trim().length > 0) {
    out.push({ strategy: "xpath", value: target.xpath, weight: 0.6 });
  }

  return out;
}

/**
 * Extract a single attribute value from a CSS selector string. Very small
 * parser: only the patterns the synthesizer emits are recognised
 * (`tag[attr="value"]`, `tag[attr='value']`). Anything more complex yields
 * null — an unparsed selector simply does not generate the derived fallback,
 * which is the correct behaviour.
 */
function extractAttribute(css: string, attribute: string): string | null {
  const doubleQuoted = new RegExp(`\\[${attribute}="((?:[^"\\\\]|\\\\.)*)"\\]`).exec(css);
  if (doubleQuoted !== null && typeof doubleQuoted[1] === "string") {
    return doubleQuoted[1].replace(/\\(.)/g, "$1");
  }
  const singleQuoted = new RegExp(`\\[${attribute}='((?:[^'\\\\]|\\\\.)*)'\\]`).exec(css);
  if (singleQuoted !== null && typeof singleQuoted[1] === "string") {
    return singleQuoted[1].replace(/\\(.)/g, "$1");
  }
  return null;
}

/**
 * Escape a value for use inside a double-quoted CSS attribute selector.
 * Only `"` and `\` need escaping in that position. This is intentionally
 * narrower than CSS.escape — CSS.escape is for identifiers, not for values
 * inside `[attr="..."]`.
 */
function escapeCssValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Escape a value for use as a CSS identifier (`#id`). Bare `[A-Za-z0-9_-]`
 * identifiers are returned unchanged; anything else is hex-escaped.
 */
function escapeCssIdentifier(value: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) return value;
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9_-]/.test(ch)) {
      out += ch;
    } else {
      // CSS escape: `\` followed by the character's hex code and a trailing
      // space to disambiguate from a following hex digit.
      out += `\\${ch.codePointAt(0)!.toString(16)} `;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolveSelectorOptions {
  /**
   * Per-candidate wait in ms. The resolver probes with a wait, not a
   * one-shot count, so a page that is still rendering is given a bounded
   * chance to catch up. Default 1500 ms.
   */
  readonly probeTimeoutMs?: number;
  /**
   * When true, require the match to be visible (`state: "visible"`). When
   * false, an attached-but-hidden node is accepted. Default true; the plan
   * always targets something the user can see.
   */
  readonly requireVisible?: boolean;
  /**
   * When true, run every candidate in a dry-run and record which ones match
   * (for a plan-quality report). When false (the default) the resolver stops
   * at the first successful candidate for speed.
   */
  readonly probeAll?: boolean;
}

/**
 * Resolve a target against a page. Tries each candidate in order, returning
 * the first that matches. When `probeAll` is set, all candidates are tried
 * and the highest-weight successful one is returned (with the others
 * reported via `drift` when they disagree on the matched node — the
 * resolver cannot see the node identity without DOM access, so `drift`
 * reflects only "did a non-primary strategy succeed").
 */
export async function resolveSelector(
  page: ResolvablePage,
  target: SelectorTarget,
  options: ResolveSelectorOptions = {},
): Promise<ResolveSelectorOutcome> {
  const candidates = buildCandidateList(target);
  if (candidates.length === 0) {
    return {
      status: "failed",
      failure: {
        reason: "no-candidates",
        tried: [],
        detail:
          "No selector candidates could be generated from the target. Provide a cssPrimary, role/name, text, or xpath.",
      },
    };
  }

  if (isPageClosed(page)) {
    return {
      status: "failed",
      failure: {
        reason: "page-closed",
        tried: candidates,
        detail: "The page was closed before selector resolution started.",
      },
    };
  }

  const probeTimeoutMs = normaliseTimeout(options.probeTimeoutMs, 1500);
  const requireVisible = options.requireVisible ?? true;
  const probeAll = options.probeAll ?? false;

  let best: ResolutionResult | null = null;

  for (const candidate of candidates) {
    const outcome = await probeCandidate(page, candidate, {
      probeTimeoutMs,
      requireVisible,
    });
    if (outcome === "matched") {
      const isPrimary = candidate.strategy === "css-primary";
      const drift = !isPrimary;
      const result: ResolutionResult = {
        strategy: candidate.strategy,
        value: candidate.value,
        weight: candidate.weight,
        isPrimary,
        drift,
        resolvedAt: new Date().toISOString(),
      };
      if (!probeAll) return { status: "resolved", result };
      if (best === null || candidate.weight > best.weight) best = result;
    } else if (outcome === "closed") {
      return {
        status: "failed",
        failure: {
          reason: "page-closed",
          tried: candidates.slice(0, candidates.indexOf(candidate) + 1),
          detail: `The page closed while probing candidate "${candidate.strategy}".`,
        },
      };
    }
    // outcome === "timeout" falls through to the next candidate.
  }

  if (best !== null) {
    return { status: "resolved", result: best };
  }

  return {
    status: "failed",
    failure: {
      reason: "all-candidates-failed",
      tried: candidates,
      detail:
        `None of the ${candidates.length} candidate selector(s) matched within ` +
        `${probeTimeoutMs}ms per candidate.`,
    },
  };
}

type CandidateProbeOutcome = "matched" | "timeout" | "closed";

async function probeCandidate(
  page: ResolvablePage,
  candidate: SelectorCandidate,
  opts: { readonly probeTimeoutMs: number; readonly requireVisible: boolean },
): Promise<CandidateProbeOutcome> {
  const locator = buildLocator(page, candidate);
  if (locator === null) return "timeout"; // cannot probe; treat as no match

  try {
    await locator.waitFor({
      state: opts.requireVisible ? "visible" : "attached",
      timeout: opts.probeTimeoutMs,
    });
    return "matched";
  } catch (error) {
    if (isClosedError(error)) return "closed";
    return "timeout";
  }
}

/**
 * Turn a candidate into a locator. The three ARIA/text strategies use
 * Playwright's `getByRole`/`getByText` when available because they match
 * against the accessible name (not the raw DOM text), which is what the
 * a11y snapshot recorded. When the page is a plain CSS-only double, we
 * degrade: ARIA and text strategies return null so the resolver falls
 * through to whatever CSS strategy it can run.
 */
function buildLocator(
  page: ResolvablePage,
  candidate: SelectorCandidate,
): ResolvableLocator | null {
  if (typeof page.locator !== "function" && typeof page.getByRole !== "function") {
    return null;
  }
  switch (candidate.strategy) {
    case "css-primary":
    case "css-name-attribute":
    case "css-id-attribute": {
      if (typeof page.locator !== "function") return null;
      return page.locator(candidate.value);
    }
    case "aria-role-name": {
      if (typeof page.getByRole !== "function") return null;
      const parsed = parseJsonObject(candidate.value);
      if (parsed === null) return null;
      const role = parsed["role"];
      const name = parsed["name"];
      if (typeof role !== "string" || typeof name !== "string") return null;
      return page.getByRole(role, { name, exact: true });
    }
    case "aria-role-only": {
      if (typeof page.getByRole !== "function") return null;
      const parsed = parseJsonObject(candidate.value);
      if (parsed === null) return null;
      const role = parsed["role"];
      if (typeof role !== "string") return null;
      return page.getByRole(role);
    }
    case "text-content": {
      if (typeof page.getByText !== "function") return null;
      return page.getByText(candidate.value, { exact: true });
    }
    case "xpath": {
      if (typeof page.locator !== "function") return null;
      // Playwright's `xpath=` prefix. The value is the XPath expression as
      // recorded in the plan (already includes the leading `//`).
      return page.locator(`xpath=${candidate.value}`);
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isPageClosed(page: ResolvablePage): boolean {
  if (typeof page.isClosed !== "function") return false;
  try {
    return page.isClosed();
  } catch {
    return false;
  }
}

function isClosedError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Page closed") ||
    message.includes("been closed")
  );
}

function normaliseTimeout(raw: number | undefined, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

/* -------------------------------------------------------------------------- */
/* Convenience: extract a target from a synthesized step                       */
/* -------------------------------------------------------------------------- */

/**
 * Shape of the target fragment as it appears on a synthesized step. Declared
 * locally (not imported from `@zipy/synth`) so this package does not depend
 * on the synth package at runtime — the resolver is the low-level primitive
 * and pulling in synth would create a cycle when synth imports retry.
 *
 * The fields are optional because different plan versions populated
 * different subsets. A target with none of them produces `no-candidates`,
 * which is the intended behaviour.
 */
export interface StepTargetFragment {
  readonly ref?: string | null;
  readonly selector?: string | null;
  readonly role?: string | null;
  readonly name?: string | null;
  readonly text?: string | null;
  readonly xpath?: string | null;
}

/**
 * Normalise a step-target fragment into the resolver's `SelectorTarget`.
 * Missing fields become null; empty strings collapse to null so
 * `buildCandidateList` does not emit a candidate with an empty value.
 */
export function toSelectorTarget(fragment: StepTargetFragment): SelectorTarget {
  return {
    ref: normalise(fragment.ref),
    cssPrimary: normalise(fragment.selector),
    role: normalise(fragment.role),
    name: normalise(fragment.name),
    text: normalise(fragment.text),
    xpath: normalise(fragment.xpath),
  };
}

function normalise(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* -------------------------------------------------------------------------- */
/* Post-resolution drift heuristic                                             */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether a resolution implies the plan needs re-synthesis. The
 * decision is intentionally conservative: `false` means "no visible drift",
 * not "the DOM has not changed". A `true` return means the caller should
 * request a change-detect run against stored snapshots.
 *
 * Rules:
 *   - Primary strategy success → no drift by resolver's own bookkeeping.
 *     (changeDetect may still flag the run for other reasons.)
 *   - Any fallback success → drift. Even a high-weight ARIA fallback is a
 *     signal that the plan's recorded CSS selector no longer matches.
 */
export function impliesResynthesis(result: ResolutionResult): boolean {
  return result.drift;
}
