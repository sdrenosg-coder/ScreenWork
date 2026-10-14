/**
 * Zipy AI — source-priority configuration for multi-source fusion entry.
 *
 * The fusion entry (`apps/worker/src/ingest/fanout.ts`) ingests every input in
 * a request in parallel and then merges the per-source intermediate
 * representations into a single unified representation. When two sources
 * disagree (e.g. the URL says "Click Save", a PDF says "Click Submit") the
 * merge must know which source wins by default, and the user must be able to
 * override that ordering per request.
 *
 * This module is deliberately small and pure:
 *  - `SourceKind` — the closed set of input kinds that can appear in a request.
 *  - `DEFAULT_SOURCE_PRIORITY` — the shipped default ordering.
 *  - `parseSourcePriority` / `resolveSourcePriority` — accept user overrides
 *    from an HTTP body (unknown values are rejected with a precise error, not
 *    silently dropped) and produce a total order over `SourceKind`.
 *  - `compareSources` / `orderSources` — apply the order to a working set.
 *
 * No credentials, no I/O, no DB. The fanout calls into this module; nothing
 * else needs to.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SourcePriorityErrorCode =
  | "invalid-input"
  | "empty-priority"
  | "unknown-source-kind"
  | "duplicate-source-kind";

export class SourcePriorityError extends Error {
  readonly code: SourcePriorityErrorCode;
  constructor(message: string, code: SourcePriorityErrorCode) {
    super(message);
    this.name = "SourcePriorityError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Source kinds                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The set of source kinds the fanout understands. This must stay in sync with
 * the `source_*` artifact kinds written by the per-source ingest modules:
 *
 *   - "url"      apps/worker/src/ingest/url.ts
 *   - "text"     apps/worker/src/ingest/textPrompt.ts
 *   - "image"    apps/worker/src/ingest/image.ts
 *   - "pdf"      apps/worker/src/ingest/pdf.ts
 *   - "docx"     apps/worker/src/ingest/docx.ts
 *   - "pptx"     apps/worker/src/ingest/pptx.ts
 *   - "audio"    apps/worker/src/ingest/audio.ts
 *   - "video"    apps/worker/src/ingest/video.ts
 */
export const SOURCE_KINDS = [
  "url",
  "text",
  "image",
  "pdf",
  "docx",
  "pptx",
  "audio",
  "video",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

const SOURCE_KIND_SET: ReadonlySet<string> = new Set(SOURCE_KINDS);

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && SOURCE_KIND_SET.has(value);
}

/* -------------------------------------------------------------------------- */
/* Default priority                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Default ordering, highest priority first. Rationale, kept here so the choice
 * is reviewable rather than an implicit side-effect of import order:
 *
 *   1. `url`   — the live application is the ground truth for the current UI.
 *   2. `text`  — an explicit natural-language instruction from the operator.
 *   3. `pdf`   — authored procedure documentation, near-ground-truth but
 *                occasionally stale relative to a live product.
 *   4. `docx` / `pptx` — authored documents; same trust class as PDF, ordered
 *                after PDF purely so text-heavy procedure docs beat decks.
 *   5. `image` — a single screenshot: high fidelity for what it shows, but
 *                no temporal or state coverage.
 *   6. `video` — sampled frames + transcript; broad coverage, lowest
 *                per-claim precision because frames are sampled.
 *   7. `audio` — narrative only; no visual ground truth at all.
 *
 * This is a *default*. It is not a correctness claim: the user may reorder.
 */
export const DEFAULT_SOURCE_PRIORITY: readonly SourceKind[] = [
  "url",
  "text",
  "pdf",
  "docx",
  "pptx",
  "image",
  "video",
  "audio",
];

/** Numeric rank per source kind, derived from `DEFAULT_SOURCE_PRIORITY`. */
export const DEFAULT_SOURCE_RANK: Readonly<Record<SourceKind, number>> =
  buildRankMap(DEFAULT_SOURCE_PRIORITY);

function buildRankMap(
  order: readonly SourceKind[],
): Readonly<Record<SourceKind, number>> {
  const map = {} as Record<SourceKind, number>;
  order.forEach((kind, idx) => {
    map[kind] = idx;
  });
  return map;
}

/* -------------------------------------------------------------------------- */
/* Parsing user overrides                                                      */
/* -------------------------------------------------------------------------- */

export interface ResolvedSourcePriority {
  /**
   * Total order over every `SourceKind`, highest priority first. Always
   * contains exactly `SOURCE_KINDS.length` entries.
   */
  readonly order: readonly SourceKind[];
  /** Rank per kind (lower = higher priority). */
  readonly rank: Readonly<Record<SourceKind, number>>;
  /**
   * Kinds the caller explicitly listed, in the order they gave. The remaining
   * kinds are appended from `DEFAULT_SOURCE_PRIORITY`; `appended` records
   * which ones those were so the caller can surface the choice.
   */
  readonly explicit: readonly SourceKind[];
  readonly appended: readonly SourceKind[];
  /** True when the caller supplied no override (pure default order). */
  readonly isDefault: boolean;
}

/**
 * Parse a user-supplied priority override from an HTTP body field.
 *
 * Accepts:
 *  - `undefined` / `null` → the default order.
 *  - a comma-separated string (`"url,pdf,image"`).
 *  - an array of strings (`["url", "pdf", "image"]`).
 *
 * Rejects with a precise `SourcePriorityError`:
 *  - an empty string / empty array,
 *  - any element that is not a known `SourceKind`,
 *  - duplicates.
 *
 * Partial lists are legal: any kinds the caller does not mention are appended
 * from the default order (so the resolved `order` is always a total order).
 */
export function parseSourcePriority(raw: unknown): ResolvedSourcePriority {
  if (raw === undefined || raw === null) {
    return makeResolved(DEFAULT_SOURCE_PRIORITY, []);
  }

  let pieces: readonly string[];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new SourcePriorityError(
        "sourcePriority was provided as an empty string. Omit the field to use the default order, or list at least one source kind.",
        "empty-priority",
      );
    }
    pieces = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new SourcePriorityError(
        "sourcePriority was provided as an empty array. Omit the field to use the default order, or list at least one source kind.",
        "empty-priority",
      );
    }
    pieces = raw.map((entry) => {
      if (typeof entry !== "string") {
        throw new SourcePriorityError(
          `sourcePriority entries must be strings; got ${describeValue(entry)}.`,
          "invalid-input",
        );
      }
      return entry.trim();
    });
  } else {
    throw new SourcePriorityError(
      `sourcePriority must be a comma-separated string or an array of strings; got ${describeValue(raw)}.`,
      "invalid-input",
    );
  }

  const explicit: SourceKind[] = [];
  const seen = new Set<SourceKind>();
  for (const piece of pieces) {
    if (!isSourceKind(piece)) {
      throw new SourcePriorityError(
        `Unknown source kind "${piece}". Known kinds: ${SOURCE_KINDS.join(", ")}.`,
        "unknown-source-kind",
      );
    }
    if (seen.has(piece)) {
      throw new SourcePriorityError(
        `Duplicate source kind "${piece}" in sourcePriority.`,
        "duplicate-source-kind",
      );
    }
    seen.add(piece);
    explicit.push(piece);
  }

  return makeResolved(explicit, explicit);
}

/**
 * Merge an explicit partial order over the default order, yielding a total
 * order. Exposed separately so callers who already validated their input can
 * build a resolved order without re-running the parser.
 */
export function resolveSourcePriority(
  explicitOrder: readonly SourceKind[],
): ResolvedSourcePriority {
  const explicit = [...explicitOrder];
  const seen = new Set<SourceKind>();
  for (const kind of explicit) {
    if (!isSourceKind(kind)) {
      throw new SourcePriorityError(
        `Unknown source kind "${String(kind)}". Known kinds: ${SOURCE_KINDS.join(", ")}.`,
        "unknown-source-kind",
      );
    }
    if (seen.has(kind)) {
      throw new SourcePriorityError(
        `Duplicate source kind "${kind}" in priority order.`,
        "duplicate-source-kind",
      );
    }
    seen.add(kind);
  }
  return makeResolved(explicit, explicit);
}

function makeResolved(
  explicit: readonly SourceKind[],
  _explicitCopy: readonly SourceKind[],
): ResolvedSourcePriority {
  const order: SourceKind[] = [...explicit];
  const appended: SourceKind[] = [];
  for (const kind of DEFAULT_SOURCE_PRIORITY) {
    if (!order.includes(kind)) {
      order.push(kind);
      appended.push(kind);
    }
  }
  return {
    order,
    rank: buildRankMap(order),
    explicit: [...explicit],
    appended,
    isDefault: explicit.length === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Ordering helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Compare two source kinds by the resolved priority order. Stable for equal
 * ranks (cannot happen with a resolved total order, but kept for safety).
 */
export function compareSources(
  a: SourceKind,
  b: SourceKind,
  resolved: ResolvedSourcePriority,
): number {
  const ra = resolved.rank[a];
  const rb = resolved.rank[b];
  return ra - rb;
}

/**
 * Return a new array sorted by the resolved priority order. Does not mutate the
 * input. When two items share a kind (rare — a request could include two
 * images) their relative order from the input is preserved via index tie-break.
 */
export function orderSources<T extends { readonly kind: SourceKind }>(
  items: readonly T[],
  resolved: ResolvedSourcePriority,
): readonly T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => {
      const cmp = compareSources(x.item.kind, y.item.kind, resolved);
      return cmp !== 0 ? cmp : x.index - y.index;
    })
    .map(({ item }) => item);
}

/**
 * Return the higher-priority of two source kinds. Convenience for the merge
 * loop; `null` inputs are treated as lowest priority so callers can express
 * "no winner yet" without a separate branch.
 */
export function pickHigherPriority(
  a: SourceKind | null,
  b: SourceKind | null,
  resolved: ResolvedSourcePriority,
): SourceKind | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareSources(a, b, resolved) <= 0 ? a : b;
}

/* -------------------------------------------------------------------------- */
/* Descriptions (shared)                                                       */
/* -------------------------------------------------------------------------- */

export function describeSourcePriority(resolved: ResolvedSourcePriority): string {
  if (resolved.isDefault) {
    return `default order: ${DEFAULT_SOURCE_PRIORITY.join(" > ")}`;
  }
  const tail = resolved.appended.length > 0
    ? ` (then default: ${resolved.appended.join(", ")})`
    : "";
  return `explicit order: ${resolved.explicit.join(" > ")}${tail}`;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  return `${typeof value}(${JSON.stringify(value)})`;
}
