/**
 * Zipy AI — provenance graph over canonical items.
 *
 * Every generated step, sentence and annotation must be traceable back to a
 * specific source artifact region / page / timestamp. This module is the
 * bookkeeping layer that makes that possible: it aggregates the provenance
 * records carried by canonical items (produced by
 * `@zipy/processing/canonical`) into a queryable, deterministic graph, and it
 * provides the reverse-index lookup the UI and the conflict/gap detectors
 * use.
 *
 * What this module is, precisely:
 *  - Pure. It takes already-built `CanonicalSource` values (or, more
 *    generically, anything that carries a `provenance` and an `itemId`) and
 *    produces an index. No I/O, no network, no credentials, no DB.
 *  - Read-only over its inputs. It never mutates the supplied canonical
 *    sources or their items.
 *  - Deterministic. Two identical working sets produce identical indexes
 *    (apart from the ISO timestamp, which is generated once).
 *  - Honest about missing data. An item whose provenance references an
 *    artifact that is not present in the working set is recorded with the
 *    artifact id but marked `resolved: false`; callers can decide whether that
 *    is a hard error (broken reference in a persisted guide) or benign (a
 *    partial view over a larger store).
 *
 * What this module is NOT:
 *  - A resolver against external storage. It does not fetch artifacts; it
 *    records artifact ids, region descriptors and timestamps only. Opening the
 *    bytes is the caller's job (via `@zipy/storage`).
 *  - A claim-attribution engine. It answers "which canonical items sit inside
 *    this region / page / time window?" and "which regions does this item
 *    refer to?", not "does this sentence follow from that evidence?" — the
 *    latter belongs to `@zipy/quality/attribution`, which consumes this
 *    module's index.
 *
 * Cross-module contract:
 *  - Input items are structurally the ones produced by
 *    `@zipy/processing/canonical`: they carry `itemId` (string) and
 *    `provenance` (an opaque object with `artifactId`, optional `pageIndex`,
 *    optional `bbox`, optional `timeRange`). This module reads only those
 *    fields; anything else is preserved verbatim so downstream consumers do
 *    not need a second lookup.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ProvenanceErrorCode =
  | "invalid-input"
  | "duplicate-item-id"
  | "duplicate-artifact-id"
  | "missing-provenance";

export class ProvenanceError extends Error {
  readonly code: ProvenanceErrorCode;
  constructor(message: string, code: ProvenanceErrorCode) {
    super(message);
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Shape of a provenance record                                                */
/* -------------------------------------------------------------------------- */

/**
 * Normalised provenance, kept structurally compatible with
 * `@zipy/processing/canonical`'s item-level `provenance`. Every field other
 * than `artifactId` is optional; absence is recorded as `null` rather than
 * being guessed.
 *
 * Axis semantics (documented once, relied on by every consumer):
 *  - `pageIndex`  0-based page number inside a document-like artifact
 *                 (PDF/DOCX/PPTX). `null` for URL snapshots and image inputs,
 *                 which are single-page by definition. URL snapshots use
 *                 `pageIndex = 0` so a "band of pages" query is still valid.
 *  - `bbox`       pixel coordinates inside the page raster, if the pipeline
 *                 knew them (OCR regions, UI elements, layout regions). `null`
 *                 when the item is text-only with no geometry.
 *  - `timeRange`  milliseconds on the artifact's media timeline (audio/video).
 *                 `null` for non-media items. `endMs` is exclusive.
 */
export interface NormalizedProvenance {
  readonly artifactId: string;
  readonly pageIndex: number | null;
  readonly bbox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly timeRange: {
    readonly startMs: number;
    readonly endMs: number;
  } | null;
}

/**
 * One canonical item as this module receives it. Widened from the exact
 * `CanonicalItem` type so callers can supply a superset (e.g. an item read
 * back from the `canonical_items` table) without a shape conflict.
 */
export interface ProvenanceItemInput {
  readonly itemId: string;
  /** Optional kind, if present. Not interpreted here. */
  readonly kind?: string | null;
  /** Raw provenance as produced by the canonical builder (opaque to TS). */
  readonly provenance: unknown;
}

/**
 * One canonical source as this module receives it. Same widening rationale as
 * `ProvenanceItemInput`.
 */
export interface ProvenanceSourceInput {
  readonly artifactId: string;
  /** Optional; propagated to the index for display. */
  readonly sourceType?: string | null;
  readonly items: readonly ProvenanceItemInput[];
}

/* -------------------------------------------------------------------------- */
/* Index output                                                                */
/* -------------------------------------------------------------------------- */

export interface ProvenanceItemIndexEntry {
  readonly sourceIndex: number;
  readonly itemIndex: number;
  readonly sourceIndexInWorkingSet: number;
  readonly itemId: string;
  readonly kind: string | null;
  readonly normalized: NormalizedProvenance;
  /**
   * True when the `provenance` object was present and well-formed; false
   * when required fields were missing and defaults were applied. Callers
   * surface this via the provenance panel so a reviewer can see that the
   * reference is approximate.
   */
  readonly resolved: boolean;
  /** Reasons `resolved` is false; empty when resolved. */
  readonly notes: readonly string[];
}

export interface ProvenanceSourceIndex {
  readonly sourceIndex: number;
  readonly artifactId: string;
  readonly sourceType: string | null;
  readonly itemCount: number;
  /**
   * Distinct pages referenced by items of this source, ascending. Empty when
   * the source has no page axis (e.g. an audio-only artifact).
   */
  readonly pageIndexes: readonly number[];
  /**
   * Overall time axis span (min startMs, max endMs) across items that carry a
   * time range. `null` when no item carries one.
   */
  readonly timeSpanMs: { readonly startMs: number; readonly endMs: number } | null;
}

export interface ProvenanceIndex {
  readonly items: readonly ProvenanceItemIndexEntry[];
  readonly sources: readonly ProvenanceSourceIndex[];
  /**
   * Lookup by itemId → entry. Every itemId across all sources appears once;
   * a duplicate id is rejected at build time (see `duplicate-item-id`).
   */
  readonly byItemId: ReadonlyMap<string, ProvenanceItemIndexEntry>;
  /**
   * Reverse index: artifactId → entries that reference it. Entries are in
   * (sourceIndex, itemIndex) order.
   */
  readonly byArtifactId: ReadonlyMap<string, readonly ProvenanceItemIndexEntry[]>;
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build a provenance index over a set of canonical sources.
 *
 * Rejections (each with a precise code):
 *  - a source without an `artifactId` or an `items` array,
 *  - two sources with the same `artifactId` in the same working set,
 *  - an item whose `itemId` collides with an item in any source,
 *  - an item with `provenance == null`.
 *
 * Duplicate item ids are rejected rather than merged because the fusion
 * pipeline relies on itemId being a key across the whole working set; a
 * collision means either the caller concatenated two different stores or the
 * canonical builder produced a non-deterministic id. Silently picking one is
 * exactly how a provenance panel would later display the *wrong* source.
 */
export function buildProvenanceIndex(
  sources: readonly ProvenanceSourceInput[],
): ProvenanceIndex {
  if (!Array.isArray(sources)) {
    throw new ProvenanceError("buildProvenanceIndex requires an array.", "invalid-input");
  }

  const seenArtifacts = new Set<string>();
  const byItemId = new Map<string, ProvenanceItemIndexEntry>();
  const byArtifactIdMutable = new Map<string, ProvenanceItemIndexEntry[]>();
  const items: ProvenanceItemIndexEntry[] = [];
  const sourceIndexes: ProvenanceSourceIndex[] = [];

  for (let s = 0; s < sources.length; s += 1) {
    const src = sources[s];
    if (src === null || typeof src !== "object") {
      throw new ProvenanceError(
        `ProvenanceSourceInput at index ${s} is not an object.`,
        "invalid-input",
      );
    }
    if (typeof src.artifactId !== "string" || src.artifactId.length === 0) {
      throw new ProvenanceError(
        `ProvenanceSourceInput at index ${s} is missing a non-empty artifactId.`,
        "invalid-input",
      );
    }
    if (seenArtifacts.has(src.artifactId)) {
      throw new ProvenanceError(
        `Duplicate artifactId "${src.artifactId}" in working set. Each source must be distinct.`,
        "duplicate-artifact-id",
      );
    }
    seenArtifacts.add(src.artifactId);
    if (!Array.isArray(src.items)) {
      throw new ProvenanceError(
        `ProvenanceSourceInput "${src.artifactId}" has a non-array items field.`,
        "invalid-input",
      );
    }

    const pageSet = new Set<number>();
    let timeMin = Number.POSITIVE_INFINITY;
    let timeMax = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < src.items.length; i += 1) {
      const item = src.items[i];
      if (item === null || typeof item !== "object") {
        throw new ProvenanceError(
          `Item at ${src.artifactId}[${i}] is not an object.`,
          "invalid-input",
        );
      }
      if (typeof item.itemId !== "string" || item.itemId.length === 0) {
        throw new ProvenanceError(
          `Item at ${src.artifactId}[${i}] is missing a non-empty itemId.`,
          "invalid-input",
        );
      }
      if (item.provenance === null || item.provenance === undefined) {
        throw new ProvenanceError(
          `Item ${item.itemId} is missing a provenance record.`,
          "missing-provenance",
        );
      }
      if (byItemId.has(item.itemId)) {
        throw new ProvenanceError(
          `Duplicate itemId "${item.itemId}" in working set.`,
          "duplicate-item-id",
        );
      }

      const { normalized, resolved, notes } = normalizeProvenance(
        item.provenance,
        src.artifactId,
      );

      const entry: ProvenanceItemIndexEntry = {
        sourceIndex: sourceIndexes.length,
        itemIndex: i,
        sourceIndexInWorkingSet: s,
        itemId: item.itemId,
        kind: typeof item.kind === "string" ? item.kind : null,
        normalized,
        resolved,
        notes,
      };

      items.push(entry);
      byItemId.set(item.itemId, entry);

      let bucket = byArtifactIdMutable.get(normalized.artifactId);
      if (bucket === undefined) {
        bucket = [];
        byArtifactIdMutable.set(normalized.artifactId, bucket);
      }
      bucket.push(entry);

      if (normalized.pageIndex !== null) pageSet.add(normalized.pageIndex);
      if (normalized.timeRange !== null) {
        if (normalized.timeRange.startMs < timeMin) timeMin = normalized.timeRange.startMs;
        if (normalized.timeRange.endMs > timeMax) timeMax = normalized.timeRange.endMs;
      }
    }

    const pages = Array.from(pageSet).sort((a, b) => a - b);
    const timeSpan =
      timeMin === Number.POSITIVE_INFINITY || timeMax === Number.NEGATIVE_INFINITY
        ? null
        : { startMs: timeMin, endMs: timeMax };

    sourceIndexes.push({
      sourceIndex: sourceIndexes.length,
      artifactId: src.artifactId,
      sourceType: typeof src.sourceType === "string" ? src.sourceType : null,
      itemCount: src.items.length,
      pageIndexes: pages,
      timeSpanMs: timeSpan,
    });
  }

  // Freeze maps into read-only views. `ReadonlyMap` is a type-level guarantee
  // only; we clone so callers cannot obtain the mutable reference through a
  // cast from elsewhere in the module.
  const byArtifactId = new Map<string, readonly ProvenanceItemIndexEntry[]>();
  for (const [k, v] of byArtifactIdMutable) {
    // Preserve insertion order (already in (sourceIndex, itemIndex) order).
    byArtifactId.set(k, Object.freeze(v.slice()));
  }

  return {
    items,
    sources: sourceIndexes,
    byItemId,
    byArtifactId,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Normalisation of a raw provenance record                                    */
/* -------------------------------------------------------------------------- */

function normalizeProvenance(
  raw: unknown,
  defaultArtifactId: string,
): {
  readonly normalized: NormalizedProvenance;
  readonly resolved: boolean;
  readonly notes: readonly string[];
} {
  if (raw === null || typeof raw !== "object") {
    return {
      normalized: {
        artifactId: defaultArtifactId,
        pageIndex: null,
        bbox: null,
        timeRange: null,
      },
      resolved: false,
      notes: ["Provenance record is not an object; only artifactId is known."],
    };
  }
  const r = raw as Record<string, unknown>;
  const notes: string[] = [];
  let resolved = true;

  // ---- artifactId --------------------------------------------------------
  let artifactId = defaultArtifactId;
  if (typeof r["artifactId"] === "string" && (r["artifactId"] as string).length > 0) {
    artifactId = r["artifactId"] as string;
  } else {
    resolved = false;
    notes.push(`Missing artifactId in provenance; defaulted to enclosing source "${defaultArtifactId}".`);
  }

  // ---- pageIndex ---------------------------------------------------------
  const pageIndex = readOptionalNonNegativeInt(r["pageIndex"]);
  if (
    r["pageIndex"] !== undefined &&
    r["pageIndex"] !== null &&
    pageIndex === null
  ) {
    resolved = false;
    notes.push("pageIndex was present but not a non-negative integer; treated as absent.");
  }

  // ---- bbox --------------------------------------------------------------
  let bbox: NormalizedProvenance["bbox"] = null;
  const rawBbox = r["bbox"];
  if (rawBbox !== null && rawBbox !== undefined) {
    if (rawBbox !== null && typeof rawBbox === "object") {
      const b = rawBbox as Record<string, unknown>;
      const x = readFiniteNumber(b["x"]);
      const y = readFiniteNumber(b["y"]);
      const width = readFiniteNumber(b["width"]);
      const height = readFiniteNumber(b["height"]);
      if (x !== null && y !== null && width !== null && height !== null && width >= 0 && height >= 0) {
        bbox = { x, y, width, height };
      } else {
        resolved = false;
        notes.push("bbox was present but not a well-formed {x,y,width,height}; treated as absent.");
      }
    } else {
      resolved = false;
      notes.push("bbox was present but not an object; treated as absent.");
    }
  }

  // ---- timeRange ---------------------------------------------------------
  let timeRange: NormalizedProvenance["timeRange"] = null;
  const rawTime = r["timeRange"];
  if (rawTime !== null && rawTime !== undefined) {
    if (rawTime !== null && typeof rawTime === "object") {
      const t = rawTime as Record<string, unknown>;
      const startMs = readFiniteNumber(t["startMs"]);
      const endMs = readFiniteNumber(t["endMs"]);
      if (startMs !== null && endMs !== null && startMs >= 0 && endMs >= startMs) {
        timeRange = { startMs, endMs };
      } else {
        resolved = false;
        notes.push(
          "timeRange was present but not a valid {startMs,endMs} with endMs >= startMs; treated as absent.",
        );
      }
    } else {
      resolved = false;
      notes.push("timeRange was present but not an object; treated as absent.");
    }
  }

  return {
    normalized: { artifactId, pageIndex, bbox, timeRange },
    resolved,
    notes,
  };
}

function readOptionalNonNegativeInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0) return v;
  return null;
}

function readFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Queries over the index                                                      */
/* -------------------------------------------------------------------------- */

export interface ProvenanceQuery {
  /** Restrict to one artifact. Omitted = all artifacts. */
  readonly artifactId?: string;
  /** Restrict to one page. Requires `artifactId` for a well-defined answer. */
  readonly pageIndex?: number;
  /**
   * Restrict to items whose bbox contains the point. Both coordinates are in
   * page pixels, origin top-left, matching `bbox`. Only applies to items that
   * carry a bbox; bbox-less items never match a point query.
   */
  readonly point?: { readonly x: number; readonly y: number };
  /**
   * Restrict to items whose time range intersects [startMs, endMs). Only
   * applies to items that carry a time range.
   */
  readonly timeWindow?: { readonly startMs: number; readonly endMs: number };
}

/**
 * Return the entries in `index` that satisfy every provided clause. Clauses
 * combine with AND; absent clauses do not filter. Returns a new array in
 * (sourceIndex, itemIndex) order. This is a linear scan; for the sizes the
 * fusion phase operates on (hundreds to low thousands of items per workflow)
 * that is the right trade-off against maintaining four separate indexes.
 */
export function queryProvenance(
  index: ProvenanceIndex,
  query: ProvenanceQuery,
): readonly ProvenanceItemIndexEntry[] {
  if (index === null || typeof index !== "object") {
    throw new ProvenanceError("queryProvenance requires a ProvenanceIndex.", "invalid-input");
  }
  const out: ProvenanceItemIndexEntry[] = [];
  const point = query.point ?? null;
  const window = query.timeWindow ?? null;
  for (const entry of index.items) {
    if (query.artifactId !== undefined && entry.normalized.artifactId !== query.artifactId) continue;
    if (query.pageIndex !== undefined) {
      // A page-scoped query without an explicit artifactId is legal but only
      // meaningful for single-artifact working sets; we honour it literally.
      if (entry.normalized.pageIndex !== query.pageIndex) continue;
    }
    if (point !== null) {
      const b = entry.normalized.bbox;
      if (b === null) continue;
      if (
        point.x < b.x ||
        point.y < b.y ||
        point.x >= b.x + b.width ||
        point.y >= b.y + b.height
      ) {
        continue;
      }
    }
    if (window !== null) {
      const t = entry.normalized.timeRange;
      if (t === null) continue;
      // Half-open intersection: [t.start, t.end) ∩ [w.start, w.end) non-empty.
      if (t.endMs <= window.startMs || t.startMs >= window.endMs) continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Resolve one item's provenance to the enclosing artifact metadata. Returns
 * `null` when the item id is not present. `exists` on the result reflects
 * whether the artifact is one of the sources in this working set; an item can
 * legitimately reference an artifact outside the current view.
 */
export interface ResolvedProvenance {
  readonly itemId: string;
  readonly artifactId: string;
  readonly artifactInWorkingSet: boolean;
  readonly sourceType: string | null;
  readonly sourceIndex: number | null;
  readonly pageIndex: number | null;
  readonly bbox: NormalizedProvenance["bbox"];
  readonly timeRange: NormalizedProvenance["timeRange"];
  readonly resolved: boolean;
  readonly notes: readonly string[];
}

export function resolveItemProvenance(
  index: ProvenanceIndex,
  itemId: string,
): ResolvedProvenance | null {
  if (typeof itemId !== "string" || itemId.length === 0) {
    throw new ProvenanceError("resolveItemProvenance requires a non-empty itemId.", "invalid-input");
  }
  const entry = index.byItemId.get(itemId);
  if (entry === undefined) return null;
  const source = index.sources.find((s) => s.artifactId === entry.normalized.artifactId);
  return {
    itemId,
    artifactId: entry.normalized.artifactId,
    artifactInWorkingSet: source !== undefined,
    sourceType: source?.sourceType ?? null,
    sourceIndex: source?.sourceIndex ?? null,
    pageIndex: entry.normalized.pageIndex,
    bbox: entry.normalized.bbox,
    timeRange: entry.normalized.timeRange,
    resolved: entry.resolved,
    notes: entry.notes,
  };
}

/**
 * A human-readable one-line citation for an item, e.g.:
 *   "Onboarding.pdf p.4"
 *   "https://app.example.com/signup" — not fabricated; URL artifacts carry
 *     their own label outside this module, so we fall back to artifactId.
 *   "demo.mp4 00:01:12–00:01:18"
 *   "screenshot.png @ (240,180)"
 *
 * The result is deterministic and safe to show even when the artifact is not
 * in the working set; unresolved items are suffixed with " [unresolved]" so a
 * reviewer can tell at a glance.
 */
export function describeProvenance(entry: ProvenanceItemIndexEntry): string {
  const parts: string[] = [];
  const n = entry.normalized;
  parts.push(`${n.artifactId}`);
  if (n.pageIndex !== null) parts.push(`p.${n.pageIndex + 1}`);
  if (n.timeRange !== null) {
    parts.push(`${formatMs(n.timeRange.startMs)}–${formatMs(n.timeRange.endMs)}`);
  }
  if (n.bbox !== null) {
    parts.push(`@ (${Math.round(n.bbox.x)},${Math.round(n.bbox.y)})`);
  }
  if (!entry.resolved) parts.push("[unresolved]");
  return parts.join(" ");
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (v: number) => v.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `ProvenanceIndex` (as serialised by `toJSONable`). Used
 * when an API or worker loads a stored index rather than rebuilding it. The
 * read is shallow-structural: the `byItemId` and `byArtifactId` `Map`s are
 * reconstructed fresh from `items` and `sources` rather than trusted from the
 * payload, because a stored `Map` cannot be round-tripped through JSON and a
 * partial index is worse than a rebuild.
 */
export interface SerialisedProvenanceIndex {
  readonly items: readonly ProvenanceItemIndexEntry[];
  readonly sources: readonly ProvenanceSourceIndex[];
  readonly generatedAt: string;
}

export function toJSONable(index: ProvenanceIndex): SerialisedProvenanceIndex {
  return {
    items: index.items,
    sources: index.sources,
    generatedAt: index.generatedAt,
  };
}

export function rehydrateProvenanceIndex(value: unknown): ProvenanceIndex {
  if (value === null || typeof value !== "object") {
    throw new ProvenanceError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const itemsRaw = Array.isArray(r["items"]) ? (r["items"] as readonly unknown[]) : [];
  const sourcesRaw = Array.isArray(r["sources"]) ? (r["sources"] as readonly unknown[]) : [];
  const generatedAt = typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "";

  const items: ProvenanceItemIndexEntry[] = [];
  const byItemId = new Map<string, ProvenanceItemIndexEntry>();
  const byArtifactId = new Map<string, ProvenanceItemIndexEntry[]>();

  for (let i = 0; i < itemsRaw.length; i += 1) {
    const raw = itemsRaw[i];
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o["itemId"] !== "string" || o["itemId"].length === 0) continue;
    const normRaw = (o["normalized"] ?? {}) as Record<string, unknown>;
    const normalized: NormalizedProvenance = {
      artifactId:
        typeof normRaw["artifactId"] === "string" ? (normRaw["artifactId"] as string) : "",
      pageIndex:
        typeof normRaw["pageIndex"] === "number" && Number.isInteger(normRaw["pageIndex"])
          ? (normRaw["pageIndex"] as number)
          : null,
      bbox: readBboxOrNull(normRaw["bbox"]),
      timeRange: readTimeRangeOrNull(normRaw["timeRange"]),
    };
    const notes = Array.isArray(o["notes"])
      ? (o["notes"] as readonly unknown[]).filter((n): n is string => typeof n === "string")
      : [];
    const entry: ProvenanceItemIndexEntry = {
      sourceIndex: intOr(o["sourceIndex"], 0),
      itemIndex: intOr(o["itemIndex"], 0),
      sourceIndexInWorkingSet: intOr(o["sourceIndexInWorkingSet"], 0),
      itemId: o["itemId"] as string,
      kind: typeof o["kind"] === "string" ? (o["kind"] as string) : null,
      normalized,
      resolved: o["resolved"] !== false,
      notes,
    };
    items.push(entry);
    byItemId.set(entry.itemId, entry);
    const bucket = byArtifactId.get(normalized.artifactId);
    if (bucket === undefined) byArtifactId.set(normalized.artifactId, [entry]);
    else bucket.push(entry);
  }

  const sources: ProvenanceSourceIndex[] = [];
  for (const raw of sourcesRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o["artifactId"] !== "string") continue;
    const pagesRaw = Array.isArray(o["pageIndexes"]) ? (o["pageIndexes"] as readonly unknown[]) : [];
    const pageIndexes = pagesRaw
      .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0)
      .slice()
      .sort((a, b) => a - b);
    sources.push({
      sourceIndex: intOr(o["sourceIndex"], sources.length),
      artifactId: o["artifactId"] as string,
      sourceType: typeof o["sourceType"] === "string" ? (o["sourceType"] as string) : null,
      itemCount: intOr(o["itemCount"], 0),
      pageIndexes,
      timeSpanMs: readTimeRangeOrNull(o["timeSpanMs"]),
    });
  }

  const byArtifactIdFrozen = new Map<string, readonly ProvenanceItemIndexEntry[]>();
  for (const [k, v] of byArtifactId) byArtifactIdFrozen.set(k, Object.freeze(v.slice()));

  return {
    items,
    sources,
    byItemId,
    byArtifactId: byArtifactIdFrozen,
    generatedAt,
  };
}

function intOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  return fallback;
}

function readBboxOrNull(v: unknown): NormalizedProvenance["bbox"] {
  if (v === null || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const x = readFiniteNumber(b["x"]);
  const y = readFiniteNumber(b["y"]);
  const width = readFiniteNumber(b["width"]);
  const height = readFiniteNumber(b["height"]);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function readTimeRangeOrNull(v: unknown): NormalizedProvenance["timeRange"] {
  if (v === null || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  const startMs = readFiniteNumber(t["startMs"]);
  const endMs = readFiniteNumber(t["endMs"]);
  if (startMs === null || endMs === null) return null;
  return { startMs, endMs };
}
