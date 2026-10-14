/**
 * Zipy AI — user-defined PII patterns (custom redaction rules).
 *
 * `piiDetect.ts` accepts a caller-supplied `customPatterns` list; this module
 * owns the *registry* of those patterns — validation, persistence-shaped
 * serialisation, scope resolution (workspace vs global), and per-pattern
 * enumeration for the workspace settings UI.
 *
 * The redaction feature list calls out "custom patterns" alongside the
 * built-in categories: a customer's internal account IDs, patient IDs, or
 * tenant codes are all worth blurring but none are guessed at by the built-ins.
 * This module exists so a workspace owner can define and share those rules
 * without changing the detection engine.
 *
 * Design rules honoured:
 *  - **No global mutable state.** The registry is a value; a caller merges a
 *    workspace registry with a global one explicitly. The default global list
 *    is empty — patterns are workspace-scoped by construction.
 *  - **Validated at every boundary.** A pattern is validated when it enters
 *    the registry (`registerPatterns`), when it is deserialised from a DB
 *    row (`rehydratePatternRegistry`), and when it is exported to be consumed
 *    by the detector (`toDetectorPatterns`). Silent acceptance of a broken
 *    rule is worse than a loud refusal, because a broken rule means PII
 *    appears unredacted in a published guide.
 *  - **Regex safety.** Backtracking-heavy constructions (nested unbounded
 *    quantifiers) are rejected at registration where detectable; a rule that
 *    would hang the worker is worse than a rule that does not exist. The
 *    detector still enforces a per-region match cap as a second line of
 *    defence.
 *  - **Strategy is explicit.** A custom pattern chooses `blur`, `pixelate`,
 *    or `solid`. The default `solid` is chosen because a customer-defined
 *    pattern almost always names a value whose exact characters matter
 *    ("account-id"), and `solid` is irreversible from a single output pixel.
 */

import type {
  CustomPiiPattern,
  PiiCategory,
  PiiStrategy,
} from "./piiDetect.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type PatternErrorCode =
  | "invalid-input"
  | "invalid-regex"
  | "unsafe-regex"
  | "duplicate-id"
  | "empty-registry";

export class PatternError extends Error {
  readonly code: PatternErrorCode;
  constructor(message: string, code: PatternErrorCode, cause?: unknown) {
    super(message);
    this.name = "PatternError";
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A pattern as the workspace settings UI presents it. The `pattern` is stored
 * as `source` + `flags` strings (never as a `RegExp` object) so it can be
 * serialised into a DB row or a JSON API response without depending on the
 * regex-flavoured serialisation quirks of any particular store.
 */
export interface StoredPattern {
  readonly id: string;
  readonly description: string;
  /** Regex source text, e.g. `\\bACCT-\\d{6}\\b`. */
  readonly source: string;
  /** Regex flags, e.g. "gi". Empty string for none. */
  readonly flags: string;
  readonly strategy: PiiStrategy;
  /** Default confidence 0..1 assigned to a match of this pattern. */
  readonly confidence: number;
  /**
   * Category this pattern's detections belong to. "custom" (the default) is
   * used for a workspace-specific concept; a canonical category is used when
   * the workspace is pinning its own regex for a category the built-ins
   * already name.
   */
  readonly category: PiiCategory;
  /** Scope it was registered at. The detector does not care, the UI does. */
  readonly scope: PatternScope;
  /** ISO timestamp of registration/update. */
  readonly updatedAt: string;
}

export type PatternScope = "workspace" | "global";

export interface PatternRegistry {
  readonly patterns: readonly StoredPattern[];
  /** Workspace the registry was loaded for; null for the built-in/global registry. */
  readonly workspaceId: string | null;
  readonly loadedAt: string;
}

export interface RegisterOptions {
  /**
   * When true, re-registering an id that already exists (in the same scope)
   * replaces the previous entry instead of throwing. Default false: an
   * accidental collision is a bug the caller should see.
   */
  readonly replace?: boolean;
  /** Scope the patterns are being registered at. Default "workspace". */
  readonly scope?: PatternScope;
  /** Workspace the registry is being built for. Null = global registry. */
  readonly workspaceId?: string | null;
  /** Override clock for tests. */
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const MAX_ID_LENGTH = 120;
const MAX_SOURCE_LENGTH = 2_000;
const MIN_CONFIDENCE = 0.1;
const MAX_CONFIDENCE = 1.0;

/**
 * Allowed regex flags for a custom PII pattern. Deliberately narrow:
 *  - `i`  — case-insensitive. Common and safe.
 *  - `m`  — multiline. Safe.
 *  - `s`  — dot-all. Rarely needed but safe, and avoids a "why doesn't my
 *            pattern match newlines?" support ticket.
 *  - `u`  — unicode. Safe and improves character-class correctness.
 *  - `g`  — global. *Required* by the detector; the registry adds it
 *            automatically if omitted.
 *  - `y`  — sticky. Rejected; unnecessary and changes the match contract.
 *  - `d`  — indices. Rejected; the detector only needs `m[0]` and `m.index`.
 */
const ALLOWED_FLAGS = new Set(["i", "m", "s", "u", "g"]);

/**
 * Ids are opaque, but they are also written into audit logs and query
 * parameters; keeping them to `[A-Za-z0-9._:-]` avoids percent-encoding
 * surprises and log-injection risk.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/* -------------------------------------------------------------------------- */
/* Public API — registration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Register a set of patterns into a registry. Returns a *new* registry; the
 * input registry is not mutated. This keeps the module free of the shared-
 * mutable-state bug that makes audit logs impossible to reconstruct.
 */
export function registerPatterns(
  registry: PatternRegistry | null,
  definitions: readonly Omit<StoredPattern, "updatedAt" | "scope">[],
  options: RegisterOptions = {},
): PatternRegistry {
  const scope: PatternScope = options.scope ?? "workspace";
  const workspaceId = options.workspaceId ?? registry?.workspaceId ?? null;
  const now = options.now ?? (() => new Date());
  const loadedAt = now().toISOString();

  const base: StoredPattern[] = registry === null ? [] : [...registry.patterns];
  const existingById = new Map<string, number>();
  for (let i = 0; i < base.length; i += 1) {
    const p = base[i] as StoredPattern;
    existingById.set(p.id, i);
  }

  const replace = options.replace === true;
  const added: StoredPattern[] = [];
  const seenThisBatch = new Set<string>();

  for (const def of definitions) {
    const validated = validateDefinition(def, scope, loadedAt);
    if (seenThisBatch.has(validated.id)) {
      throw new PatternError(
        `Pattern id "${validated.id}" appears twice in the same registration batch.`,
        "duplicate-id",
      );
    }
    seenThisBatch.add(validated.id);
    const existingIdx = existingById.get(validated.id);
    if (existingIdx !== undefined) {
      if (!replace) {
        throw new PatternError(
          `Pattern id "${validated.id}" is already registered. Pass { replace: true } to overwrite.`,
          "duplicate-id",
        );
      }
      base[existingIdx] = validated;
      continue;
    }
    base.push(validated);
    existingById.set(validated.id, base.length - 1);
    added.push(validated);
  }
  void added; // retained for a future "only added" return shape

  return {
    patterns: base,
    workspaceId,
    loadedAt,
  };
}

/**
 * Remove patterns by id. Returns the trimmed registry. Ids that are not
 * present are ignored (removal is idempotent, which is what a UI delete
 * button needs).
 */
export function removePatterns(
  registry: PatternRegistry,
  ids: readonly string[],
  options: { readonly now?: () => Date } = {},
): PatternRegistry {
  if (registry === null || typeof registry !== "object") {
    throw new PatternError("removePatterns requires a registry.", "invalid-input");
  }
  const removeSet = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) removeSet.add(id);
  }
  const now = options.now ?? (() => new Date());
  return {
    patterns: registry.patterns.filter((p) => !removeSet.has(p.id)),
    workspaceId: registry.workspaceId,
    loadedAt: now().toISOString(),
  };
}

/**
 * Merge a workspace registry with the global registry. Workspace wins on id
 * collision: a workspace-specific override of a global rule is exactly the
 * case this exists for.
 *
 * The returned registry keeps the workspace scope for its own patterns and
 * the global scope for the rest; the detector treats them identically.
 */
export function mergeRegistries(
  workspace: PatternRegistry | null,
  global: PatternRegistry | null,
  options: { readonly now?: () => Date } = {},
): PatternRegistry {
  const now = options.now ?? (() => new Date());
  const byId = new Map<string, StoredPattern>();
  if (global !== null && Array.isArray(global.patterns)) {
    for (const p of global.patterns) byId.set(p.id, p);
  }
  if (workspace !== null && Array.isArray(workspace.patterns)) {
    for (const p of workspace.patterns) byId.set(p.id, p);
  }
  // Preserve insertion order for stable display: global first, then workspace
  // replacements in their global slot, then any entirely-workspace-only ids.
  const out: StoredPattern[] = [];
  const emitted = new Set<string>();
  for (const p of global?.patterns ?? []) {
    const winner = byId.get(p.id);
    if (winner !== undefined && !emitted.has(winner.id)) {
      out.push(winner);
      emitted.add(winner.id);
    }
  }
  for (const p of workspace?.patterns ?? []) {
    if (!emitted.has(p.id)) {
      out.push(p);
      emitted.add(p.id);
    }
  }
  return {
    patterns: out,
    workspaceId: workspace?.workspaceId ?? global?.workspaceId ?? null,
    loadedAt: now().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Public API — detector bridge                                                */
/* -------------------------------------------------------------------------- */

/**
 * Convert the stored patterns into the `CustomPiiPattern` shape the detection
 * engine accepts. A pattern with an invalid regex should never reach this
 * function (registration and rehydration both validate), so a failure here
 * indicates a corrupted registry and throws loudly.
 *
 * `g` is added (or left alone) on every emitted regex so the detector's
 * `exec` loop sees a stateful regex.
 */
export function toDetectorPatterns(
  registry: PatternRegistry | null,
  enabledCategories?: readonly PiiCategory[],
): CustomPiiPattern[] {
  if (registry === null) return [];
  const filter = enabledCategories !== undefined && enabledCategories.length > 0
    ? new Set(enabledCategories)
    : null;

  const out: CustomPiiPattern[] = [];
  for (const p of registry.patterns) {
    if (filter !== null && !filter.has(p.category)) continue;
    let re: RegExp;
    try {
      re = new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`);
    } catch (error) {
      throw new PatternError(
        `Stored pattern "${p.id}" has an invalid source/flags combination: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "invalid-regex",
        error,
      );
    }
    out.push({
      id: p.id,
      description: p.description,
      pattern: re,
      strategy: p.strategy,
      confidence: p.confidence,
      category: p.category,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public API — validation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Validate a pattern definition. Returns a fully-formed `StoredPattern` with
 * `scope` and `updatedAt` filled in. Throws `PatternError` on any problem;
 * the caller is expected to surface the message to the workspace owner.
 */
export function validateDefinition(
  def: Omit<StoredPattern, "updatedAt" | "scope">,
  scope: PatternScope,
  updatedAt: string,
): StoredPattern {
  if (def === null || typeof def !== "object") {
    throw new PatternError("Pattern definition is not an object.", "invalid-input");
  }
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new PatternError("Pattern id must be a non-empty string.", "invalid-input");
  }
  if (def.id.length > MAX_ID_LENGTH || !ID_PATTERN.test(def.id)) {
    throw new PatternError(
      `Pattern id "${def.id}" is invalid. IDs must start with an alphanumeric character and contain only A–Z, a–z, 0–9, ".", "_", ":", or "-" (max ${MAX_ID_LENGTH} characters).`,
      "invalid-input",
    );
  }
  if (typeof def.description !== "string") {
    throw new PatternError(`Pattern "${def.id}" description must be a string.`, "invalid-input");
  }
  if (typeof def.source !== "string" || def.source.length === 0) {
    throw new PatternError(`Pattern "${def.id}" has no regex source.`, "invalid-input");
  }
  if (def.source.length > MAX_SOURCE_LENGTH) {
    throw new PatternError(
      `Pattern "${def.id}" source exceeds the maximum of ${MAX_SOURCE_LENGTH} characters.`,
      "invalid-input",
    );
  }
  const flags = typeof def.flags === "string" ? dedupeFlags(def.flags) : "";
  for (const f of flags) {
    if (!ALLOWED_FLAGS.has(f)) {
      throw new PatternError(
        `Pattern "${def.id}" uses flag "${f}", which is not allowed. Allowed flags: ${[...ALLOWED_FLAGS].join("")}.`,
        "invalid-input",
      );
    }
  }
  // Compile once to catch syntax errors now, and again for the safety check.
  let compiled: RegExp;
  try {
    compiled = new RegExp(def.source, flags);
  } catch (error) {
    throw new PatternError(
      `Pattern "${def.id}" is not a valid regex: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "invalid-regex",
      error,
    );
  }
  ensureRegexSafe(def.id, def.source);

  const strategy: PiiStrategy =
    def.strategy === "blur" || def.strategy === "pixelate" || def.strategy === "solid"
      ? def.strategy
      : "solid";
  const confidence =
    typeof def.confidence === "number" && Number.isFinite(def.confidence)
      ? clampRange(def.confidence, MIN_CONFIDENCE, MAX_CONFIDENCE)
      : 0.85;
  const category: PiiCategory =
    typeof def.category === "string" && def.category.length > 0
      ? (def.category as PiiCategory)
      : "custom";

  void compiled; // compiled for its side-effect of validating syntax

  return {
    id: def.id,
    description: def.description,
    source: def.source,
    flags,
    strategy,
    confidence,
    category,
    scope,
    updatedAt,
  };
}

/**
 * Very small regex-safety check. Rejects patterns that contain an unbounded
 * quantifier immediately followed by a construct that starts another
 * unbounded repetition:
 *
 *   - `(...)*` where the inner group also ends in `*`, `+`, `{n,}`
 *   - `(a+)+`, `(a*)*`, `(a{1,})*`, etc.
 *
 * This is not a full ReDoS analyser; it catches the constructions that are
 * commonly typed by hand and lets the detector's per-region match cap
 * (`guard < 32` in `piiDetect.ts`) handle the rest. A pattern that fails this
 * check is refused rather than run with a timeout, because a timeout in a
 * worker thread still burns CPU and fleet capacity.
 */
export function ensureRegexSafe(patternId: string, source: string): void {
  // Look for a group ending in an unbounded quantifier that is itself
  // quantified: `(...X+)+`, `(...X*)*`, `(...X{1,}){1,}`.
  const dangerousGroup = /\([^)]*[*+][^)]*\)\s*(?:[*+]|\{\d+,\})/;
  if (dangerousGroup.test(source)) {
    throw new PatternError(
      `Pattern "${patternId}" appears to contain nested unbounded repetition, which can cause catastrophic backtracking. Rewrite the pattern to bound the inner quantifier (e.g. use a {1,64} bound).`,
      "unsafe-regex",
    );
  }
  // Quantifier chained directly on another quantifier: `a++`, `a**`, `a+*`,
  // `a{2,}+`. These are either invalid (regex will refuse them) or a typo
  // for a bounded repetition; refuse them here so the caller sees a clear
  // message rather than the regex engine's.
  const chained = /([*+?{][^,}]*)\1{2,}/;
  if (chained.test(source)) {
    throw new PatternError(
      `Pattern "${patternId}" contains a chained quantifier such as "++" or "*?"+; use a single bounded repetition instead.`,
      "unsafe-regex",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Public API — serialisation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Serialise the registry to a JSON-safe object. Every value that goes out is
 * a primitive or an array of primitives; the caller stores the result in a
 * `JSONB` column or returns it from the REST API without further work.
 */
export interface SerialisedPatternRegistry {
  readonly patterns: readonly {
    readonly id: string;
    readonly description: string;
    readonly source: string;
    readonly flags: string;
    readonly strategy: PiiStrategy;
    readonly confidence: number;
    readonly category: PiiCategory;
    readonly scope: PatternScope;
    readonly updatedAt: string;
  }[];
  readonly workspaceId: string | null;
  readonly loadedAt: string;
}

export function serialiseRegistry(registry: PatternRegistry): SerialisedPatternRegistry {
  if (registry === null || typeof registry !== "object") {
    throw new PatternError("serialiseRegistry requires a registry.", "invalid-input");
  }
  return {
    patterns: registry.patterns.map((p) => ({
      id: p.id,
      description: p.description,
      source: p.source,
      flags: p.flags,
      strategy: p.strategy,
      confidence: p.confidence,
      category: p.category,
      scope: p.scope,
      updatedAt: p.updatedAt,
    })),
    workspaceId: registry.workspaceId,
    loadedAt: registry.loadedAt,
  };
}

/**
 * Read a persisted registry. Throws on structurally invalid payloads
 * (matching the rehydration contract shared across the images package), and
 * re-validates every definition so a hand-edited database row cannot inject
 * an unsafe pattern into the detector.
 *
 * A pattern that fails validation is *skipped* only when
 * `{ strict: false }` is passed; the default is to throw because the caller
 * is usually the settings UI, which should see the exact mistake.
 */
export interface RehydrateOptions {
  readonly strict?: boolean;
  /** When false, a pattern whose `pattern` compiles but is 'unsafe' is dropped. Default true (throws). */
  readonly rejectUnsafe?: boolean;
}

export function rehydratePatternRegistry(
  value: unknown,
  options: RehydrateOptions = {},
): PatternRegistry {
  if (value === null || typeof value !== "object") {
    throw new PatternError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const patternsRaw = Array.isArray(r["patterns"]) ? (r["patterns"] as unknown[]) : [];
  const strict = options.strict !== false;
  const rejectUnsafe = options.rejectUnsafe !== false;

  const patterns: StoredPattern[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < patternsRaw.length; i += 1) {
    const p = patternsRaw[i];
    if (p === null || typeof p !== "object") {
      if (strict) {
        throw new PatternError(
          `Rehydrate failed: patterns[${i}] is not an object.`,
          "invalid-input",
        );
      }
      continue;
    }
    const o = p as Record<string, unknown>;
    const def: Omit<StoredPattern, "updatedAt" | "scope"> = {
      id: typeof o["id"] === "string" ? (o["id"] as string) : "",
      description: typeof o["description"] === "string" ? (o["description"] as string) : "",
      source: typeof o["source"] === "string" ? (o["source"] as string) : "",
      flags: typeof o["flags"] === "string" ? (o["flags"] as string) : "",
      strategy: normaliseStrategy(o["strategy"]),
      confidence:
        typeof o["confidence"] === "number" && Number.isFinite(o["confidence"] as number)
          ? (o["confidence"] as number)
          : 0.85,
      category: typeof o["category"] === "string" ? (o["category"] as PiiCategory) : "custom",
    };
    const scope: PatternScope = o["scope"] === "global" ? "global" : "workspace";
    const updatedAt =
      typeof o["updatedAt"] === "string" && o["updatedAt"].length > 0
        ? (o["updatedAt"] as string)
        : new Date().toISOString();

    try {
      if (!rejectUnsafe) {
        // Compile-only check when the caller has opted out of the safety scan.
        new RegExp(def.source, def.flags);
      }
      const validated = validateDefinition(def, scope, updatedAt);
      if (seenIds.has(validated.id)) {
        throw new PatternError(
          `Rehydrate failed: duplicate pattern id "${validated.id}" in payload.`,
          "duplicate-id",
        );
      }
      seenIds.add(validated.id);
      patterns.push(validated);
    } catch (error) {
      if (strict) throw error;
      continue;
    }
  }

  return {
    patterns,
    workspaceId: typeof r["workspaceId"] === "string" ? (r["workspaceId"] as string) : null,
    loadedAt:
      typeof r["loadedAt"] === "string" && r["loadedAt"].length > 0
        ? (r["loadedAt"] as string)
        : new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Public API — enumeration                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Patterns grouped by category, for the settings UI. Deterministic ordering:
 * within a category, patterns appear in the registry's order.
 */
export function groupByCategory(
  registry: PatternRegistry,
): Readonly<Record<string, readonly StoredPattern[]>> {
  const out: Record<string, StoredPattern[]> = {};
  for (const p of registry.patterns) {
    const list = out[p.category] ?? [];
    list.push(p);
    out[p.category] = list;
  }
  return out;
}

/**
 * Return the ids of patterns whose `source`/`flags` compile to the same
 * RegExp as another entry. This is informational — two patterns with the
 * same regex but different strategies are legal (one blurs, one paints
 * solid) — but the settings UI can warn about a likely copy/paste mistake.
 */
export function findDuplicateRegexes(registry: PatternRegistry): readonly string[][] {
  const groups = new Map<string, string[]>();
  for (const p of registry.patterns) {
    const key = `${p.flags}\u0000${p.source}`;
    const list = groups.get(key) ?? [];
    list.push(p.id);
    groups.set(key, list);
  }
  const out: string[][] = [];
  for (const ids of groups.values()) {
    if (ids.length > 1) out.push(ids.slice());
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public API — invariants                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Asserts that a registry is not empty. Callers that expect a workspace to
 * have defined at least one custom pattern (a compliance policy, a regulated
 * customer) can use this to fail loudly rather than silently redacting only
 * the built-in categories.
 */
export function assertNonEmpty(registry: PatternRegistry): void {
  if (registry === null || typeof registry !== "object") {
    throw new PatternError("assertNonEmpty requires a registry.", "invalid-input");
  }
  if (registry.patterns.length === 0) {
    const where = registry.workspaceId === null ? "global" : `workspace ${registry.workspaceId}`;
    throw new PatternError(
      `No custom PII patterns are registered for the ${where} scope. Register at least one or remove the assertNonEmpty gate.`,
      "empty-registry",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function dedupeFlags(raw: string): string {
  const seen = new Set<string>();
  let out = "";
  for (const ch of raw) {
    if (!seen.has(ch)) {
      seen.add(ch);
      out += ch;
    }
  }
  return out;
}

function clampRange(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function normaliseStrategy(v: unknown): PiiStrategy {
  if (v === "blur" || v === "pixelate" || v === "solid") return v;
  return "solid";
}
