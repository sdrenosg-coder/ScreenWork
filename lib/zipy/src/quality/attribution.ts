/**
 * Zipy AI — source attribution (SEO/quality/safety phase, batch 2).
 *
 * Provides the link between a generated fragment (a step, a paragraph, a
 * callout, a table cell, a code line) and the source artifact regions that
 * produced it. This is the data model behind the "Show source" affordance in
 * the review UI and the provenance panel: given a generated fragment id, the
 * reviewer can resolve exactly which document, page and region — or which URL
 * snapshot and DOM/aria element — the writer drew from.
 *
 * The module is deliberately a *surface* rather than a store. It:
 *   1. accepts a `FragmentAttribution` per generated fragment, containing the
 *      spans the writer side has already recorded (or the ones a reviewer
 *      supplies when correcting the writer);
 *   2. validates that every cited span references a source the resolver can
 *      actually reach (a `SourceRegistry` supplied by the caller), so an
 *      attribution cannot point at an invented source;
 *   3. normalises and serialises the result so exports (PDF footnote, HTML
 *      `<a>` anchor, Markdown footnote) can render the same model.
 *
 * Design rules honoured:
 *  - No invented sources. Every span must name a source id present in the
 *    registry; unresolvable spans become `broken` entries with a descriptive
 *    reason and never disappear silently.
 *  - No invented region. The module does not synthesise a page number, a
 *    timestamp or a DOM selector. If the upstream extractor did not record a
 *    locator, the span's `locator` is `null` and the review UI says so.
 *  - Deterministic serialisation. Spans are ordered by (span index, source
 *    id) so a diff across regenerations is stable.
 *  - The registry is caller-supplied and treated as read-only. The module
 *    never mutates the registry, never writes to storage, and never reads
 *    from a source the registry does not cover.
 *
 * The module exports:
 *   - `buildAttributionMap` — validate + normalise a set of fragments.
 *   - `resolveAttribution` — resolve a single fragment's spans.
 *   - `renderAttributionMarkdown` — an export-ready footnote block.
 *   - `buildAttributionDirectives` — the LLM-visible block telling the writer
 *     how to cite sources so attribution can be recorded.
 *   - `rehydrateAttributionMap` — typed load of a persisted payload.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AttributionErrorCode = "invalid-input" | "shape";

export class AttributionError extends Error {
  readonly code: AttributionErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: AttributionErrorCode,
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

/**
 * The kinds of source the registry can describe. Kept aligned with the
 * fact-check source kinds so the two layers share a vocabulary; the extra
 * `canonical-item` value lets the fusion layer's canonical representation act
 * as a source of truth for a fragment whose provenance is a fused item rather
 * than a single raw artifact.
 */
export const ATTRIBUTION_SOURCE_KINDS = [
  "url",
  "pdf",
  "docx",
  "pptx",
  "image",
  "audio",
  "video",
  "text",
  "live-url",
  "canonical-item",
] as const;
export type AttributionSourceKind = (typeof ATTRIBUTION_SOURCE_KINDS)[number];

/**
 * A single registry entry. The caller builds these from the source and
 * artifact tables; the module never queries a database itself.
 */
export interface AttributionSource {
  readonly id: string;
  readonly kind: AttributionSourceKind;
  /** Human-visible label, e.g. "Signup flow (url)" or "Onboarding PDF". */
  readonly label: string;
  /** Originating URL, file name or artifact key. Used for the export link target. */
  readonly href: string | null;
  /** ISO 8601 ingest time. */
  readonly capturedAt: string | null;
  /**
   * True when the source is currently reachable for a "jump to source" click.
   * A retained-until date passing marks this false without deleting the row;
   * a reviewer sees that the link is historical.
   */
  readonly reachable: boolean;
}

/**
 * The region classifier. The value drives how the export layer renders the
 * location: `page` becomes "p. 4", `timestamp` becomes "0:32", `selector`
 * becomes an element name, `range` becomes "characters 120–340".
 */
export const ATTRIBUTION_LOCATOR_KINDS = [
  "page",
  "region",
  "timestamp",
  "selector",
  "anchor",
  "char-range",
  "none",
] as const;
export type AttributionLocatorKind = (typeof ATTRIBUTION_LOCATOR_KINDS)[number];

/**
 * A region within a source. A span may have many locators when the writer
 * drew from a table that spans pages, or from a page region that the recogniser
 * also assigned a semantic label to.
 */
export interface AttributionLocator {
  readonly kind: AttributionLocatorKind;
  /**
   * The human-readable form the export renders, e.g. "p. 4, table 2, row 3".
   * Populated by the extractor; the module never fabricates one.
   */
  readonly display: string;
  /**
   * Structural payload, shape varies by kind. Never invented: for
   * `char-range` it is `{ start, end }`; for `page` it is `{ page }`;
   * for `selector` it is `{ role?, name?, xpath? }`; the module stores it
   * opaque and validates only that it is an object.
   */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface AttributionSpan {
  /** The source the fragment drew from. Must be present in the registry. */
  readonly sourceId: string;
  /** Zero or more locators within that source. Empty array = source-level. */
  readonly locators: readonly AttributionLocator[];
  /**
   * Optional verbatim excerpt of the source that the writer relied on. When
   * present, the export layer shows it in the "Show source" panel; when
   * absent, the export shows the locator only.
   */
  readonly excerpt: string | null;
  /**
   * Whether the writer derived the fragment (a synthesis) or copied it
   * (a quote). A `paraphrase` derived span is not a claim of verbatim
   * reporting; the review UI uses this to decide whether to whisper the
   * excerpt.
   */
  readonly derivation: "verbatim" | "paraphrase" | "derived" | "uncertain";
}

export interface FragmentAttribution {
  /** Stable fragment id, e.g. `step-3.description` or `title`. */
  readonly fragmentId: string;
  /** Human-visible location. */
  readonly location: string;
  /**
   * Text of the fragment the attribution applies to. Carried so the export
   * can pair the fragment with its sources without a second lookup.
   */
  readonly fragmentText: string;
  /** Ordered spans. Empty is legal — a fragment with no sources is `unattributed`. */
  readonly spans: readonly AttributionSpan[];
}

/**
 * The caller-supplied source registry. A map keeps lookups O(1) and makes
 * "does this source exist?" a single comparison; the module never invents an
 * entry to satisfy an attribution.
 */
export interface SourceRegistry {
  readonly sources: ReadonlyMap<string, AttributionSource>;
}

/**
 * A single resolved span. Always has a `source` when the source resolved, and
 * a `broken` flag with a reason when it did not.
 */
export interface ResolvedSpan {
  readonly sourceId: string;
  readonly source: AttributionSource | null;
  readonly locators: readonly AttributionLocator[];
  readonly excerpt: string | null;
  readonly derivation: AttributionSpan["derivation"];
  /**
   * True when the source id did not resolve against the registry. The
   * `brokenReason` field is always set when this is true.
   */
  readonly broken: boolean;
  readonly brokenReason: string | null;
  /**
   * True when the source resolved but is marked unreachable in the registry
   * (e.g. its retention window has elapsed). The export layer renders such a
   * link as historical rather than missing.
   */
  readonly historical: boolean;
}

export const ATTRIBUTION_STATUSES = [
  "attributed",
  "partially-attributed",
  "unattributed",
  "broken",
] as const;
export type AttributionStatus = (typeof ATTRIBUTION_STATUSES)[number];

export interface ResolvedFragment {
  readonly fragmentId: string;
  readonly location: string;
  readonly fragmentText: string;
  readonly status: AttributionStatus;
  readonly spans: readonly ResolvedSpan[];
  /** Human-readable explanation shown alongside the fragment. */
  readonly summary: string;
  /** Serialised "N sources, M broken" for telemetry. */
  readonly counts: {
    readonly total: number;
    readonly resolved: number;
    readonly historical: number;
    readonly broken: number;
  };
}

export interface AttributionNote {
  readonly kind:
    | "no-registry"
    | "duplicate-fragment"
    | "empty-fragment"
    | "unattributed-fragment"
    | "broken-source"
    | "historical-source"
    | "empty-locators"
    | "verbatim-without-excerpt";
  readonly detail: string;
}

export interface AttributionMap {
  readonly version: "attribution/1";
  readonly fragments: readonly ResolvedFragment[];
  readonly notes: readonly AttributionNote[];
  readonly summary: {
    readonly total: number;
    readonly attributed: number;
    readonly partiallyAttributed: number;
    readonly unattributed: number;
    readonly broken: number;
  };
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface BuildAttributionMapInput {
  readonly fragments: readonly FragmentAttribution[];
  readonly registry: SourceRegistry;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build an attribution map from a set of fragments and a source registry.
 * Validates every span against the registry; unresolvable spans are recorded
 * as broken and never silently dropped.
 */
export function buildAttributionMap(input: BuildAttributionMapInput): AttributionMap {
  if (input === null || typeof input !== "object") {
    throw new AttributionError("buildAttributionMap requires an input object.", "invalid-input");
  }
  if (!Array.isArray(input.fragments)) {
    throw new AttributionError("`fragments` must be an array.", "invalid-input");
  }
  if (
    input.registry === null ||
    typeof input.registry !== "object" ||
    !(input.registry.sources instanceof Map)
  ) {
    throw new AttributionError(
      "`registry.sources` must be a Map (even an empty one). The module never fabricates a registry.",
      "invalid-input",
    );
  }

  const notes: AttributionNote[] = [];
  if (input.registry.sources.size === 0) {
    notes.push({
      kind: "no-registry",
      detail:
        "The supplied source registry is empty. Every span is recorded as broken; no attribution can resolve without a registry.",
    });
  }

  const seenFragments = new Set<string>();
  const fragments: ResolvedFragment[] = [];
  let attributed = 0;
  let partiallyAttributed = 0;
  let unattributed = 0;
  let brokenFragments = 0;

  for (const raw of input.fragments) {
    if (raw === null || typeof raw !== "object") continue;
    const fragmentId = typeof raw.fragmentId === "string" ? raw.fragmentId : "";
    const location = typeof raw.location === "string" ? raw.location : "";
    const fragmentText = typeof raw.fragmentText === "string" ? raw.fragmentText : "";
    const rawSpans = Array.isArray(raw.spans) ? raw.spans : [];

    if (seenFragments.has(fragmentId)) {
      notes.push({
        kind: "duplicate-fragment",
        detail: `Fragment id "${fragmentId}" appears more than once; later entries override nothing and are skipped.`,
      });
      continue;
    }
    seenFragments.add(fragmentId);

    if (fragmentText.trim().length === 0) {
      notes.push({
        kind: "empty-fragment",
        detail: `Fragment "${fragmentId}" has no text; it is skipped rather than attributed.`,
      });
      continue;
    }

    const resolvedSpans: ResolvedSpan[] = [];
    for (const s of rawSpans) {
      if (s === null || typeof s !== "object") continue;
      const sourceId = typeof s.sourceId === "string" ? s.sourceId : "";
      const locators = readLocators(s.locators);
      const excerpt =
        typeof s.excerpt === "string" && s.excerpt.trim().length > 0 ? s.excerpt : null;
      const derivation = readDerivation(s.derivation);

      if (sourceId.length === 0) {
        resolvedSpans.push({
          sourceId,
          source: null,
          locators,
          excerpt,
          derivation,
          broken: true,
          brokenReason: "The span has no source id.",
          historical: false,
        });
        notes.push({
          kind: "broken-source",
          detail: `Fragment "${fragmentId}" has a span without a source id.`,
        });
        continue;
      }

      const source = input.registry.sources.get(sourceId) ?? null;
      if (source === null) {
        resolvedSpans.push({
          sourceId,
          source: null,
          locators,
          excerpt,
          derivation,
          broken: true,
          brokenReason: `The source "${sourceId}" is not present in the registry.`,
          historical: false,
        });
        notes.push({
          kind: "broken-source",
          detail: `Fragment "${fragmentId}" cites source "${sourceId}", which is not in the registry.`,
        });
        continue;
      }

      if (derivation === "verbatim" && excerpt === null) {
        notes.push({
          kind: "verbatim-without-excerpt",
          detail: `Fragment "${fragmentId}" is marked verbatim but has no excerpt; the review UI cannot show what was quoted.`,
        });
      }
      if (locators.length === 0) {
        notes.push({
          kind: "empty-locators",
          detail: `Fragment "${fragmentId}" cites source "${sourceId}" without a locator; the export shows a source-level link.`,
        });
      }
      if (!source.reachable) {
        notes.push({
          kind: "historical-source",
          detail: `Fragment "${fragmentId}" cites source "${sourceId}", which is marked unreachable in the registry.`,
        });
      }

      resolvedSpans.push({
        sourceId,
        source,
        locators,
        excerpt,
        derivation,
        broken: false,
        brokenReason: null,
        historical: !source.reachable,
      });
    }

    // Deterministic span ordering: by source id, then by the first locator's
    // display string so the export renders in a stable order.
    resolvedSpans.sort(compareResolvedSpans);

    const resolvedCount = resolvedSpans.filter((s) => !s.broken).length;
    const brokenCount = resolvedSpans.filter((s) => s.broken).length;
    const historicalCount = resolvedSpans.filter((s) => !s.broken && s.historical).length;

    let status: AttributionStatus;
    let summary: string;
    if (resolvedSpans.length === 0) {
      status = "unattributed";
      summary =
        "This fragment cites no sources. A reviewer must confirm the claim is either a synthesis the sources support together, or a gap.";
      unattributed += 1;
      notes.push({
        kind: "unattributed-fragment",
        detail: `Fragment "${fragmentId}" has no spans.`,
      });
    } else if (resolvedCount === 0) {
      status = "broken";
      summary =
        "Every source this fragment cites could not be resolved against the registry. The attribution is unusable until the registry is corrected.";
      brokenFragments += 1;
    } else if (brokenCount > 0) {
      status = "partially-attributed";
      summary = `${resolvedCount} of ${resolvedSpans.length} source(s) resolved; ${brokenCount} could not be resolved against the registry.`;
      partiallyAttributed += 1;
    } else {
      status = "attributed";
      summary =
        resolvedSpans.length === 1
          ? `Attributed to "${resolvedSpans[0]?.source?.label ?? resolvedSpans[0]?.sourceId ?? ""}".`
          : `Attributed to ${resolvedSpans.length} sources.`;
      attributed += 1;
    }

    fragments.push({
      fragmentId,
      location,
      fragmentText,
      status,
      spans: resolvedSpans,
      summary,
      counts: {
        total: resolvedSpans.length,
        resolved: resolvedCount,
        historical: historicalCount,
        broken: brokenCount,
      },
    });
  }

  return {
    version: "attribution/1",
    fragments,
    notes,
    summary: {
      total: fragments.length,
      attributed,
      partiallyAttributed,
      unattributed,
      broken: brokenFragments,
    },
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Resolve a single fragment's spans without building a full map. Useful for
 * the review UI's per-fragment popover, which only has one fragment in hand.
 */
export function resolveAttribution(
  fragment: FragmentAttribution,
  registry: SourceRegistry,
): ResolvedFragment {
  if (fragment === null || typeof fragment !== "object") {
    throw new AttributionError("resolveAttribution requires a fragment object.", "invalid-input");
  }
  if (
    registry === null ||
    typeof registry !== "object" ||
    !(registry.sources instanceof Map)
  ) {
    throw new AttributionError(
      "`registry.sources` must be a Map (even an empty one).",
      "invalid-input",
    );
  }
  const map = buildAttributionMap({ fragments: [fragment], registry });
  const first = map.fragments[0];
  if (first === undefined) {
    throw new AttributionError(
      "Fragment did not resolve; see the map's notes for the cause.",
      "invalid-input",
      { fragmentId: fragment.fragmentId },
    );
  }
  return first;
}

/**
 * Render an attribution map as a Markdown footnote block. The fragments are
 * emitted in the order they appear in `map.fragments`; the footnote numbering
 * is derived from that order and is therefore stable across regenerations
 * given an identical input.
 *
 * Exports do not depend on the LLM: the footnote text is a deterministic
 * composition of the resolver's output.
 */
export function renderAttributionMarkdown(map: AttributionMap): string {
  if (map === null || typeof map !== "object" || map.version !== "attribution/1") {
    throw new AttributionError(
      "renderAttributionMarkdown requires an AttributionMap (version \"attribution/1\").",
      "invalid-input",
    );
  }
  const lines: string[] = [];
  lines.push("## Sources");
  lines.push("");
  lines.push(
    "Every fragment below is attributed to the sources the writer drew from. Broken or historical entries are marked inline.",
  );
  lines.push("");
  let counter = 1;
  for (const frag of map.fragments) {
    const heading = frag.location.trim().length > 0 ? frag.location : frag.fragmentId;
    lines.push(`${counter}. **${heading}**`);
    if (frag.status === "unattributed") {
      lines.push("   - _No sources cited._");
    } else {
      for (const span of frag.spans) {
        const label = span.source !== null ? span.source.label : span.sourceId;
        const bits: string[] = [`"${escapeInline(label)}"`];
        if (span.locators.length > 0) {
          bits.push(span.locators.map((l) => escapeInline(l.display)).join("; "));
        }
        if (span.broken) {
          bits.push(`**broken — ${escapeInline(span.brokenReason ?? "unresolved")}**`);
        } else if (span.historical) {
          bits.push("_(historical)_");
        }
        if (span.derivation !== "verbatim" && span.derivation !== "paraphrase") {
          bits.push(`_(${span.derivation})_`);
        }
        lines.push(`   - ${bits.join(" — ")}`);
        if (span.excerpt !== null && span.derivation === "verbatim") {
          lines.push(`     > ${escapeQuote(span.excerpt)}`);
        }
      }
    }
    counter += 1;
  }
  return lines.join("\n");
}

/**
 * The LLM-visible directive block. Append to the writer's system prompt when
 * attribution is required. Short and imperative; the writer does not need to
 * know about the registry, only how to phrase a claim so its source is
 * recoverable by the extracting pass.
 */
export function buildAttributionDirectives(input: {
  readonly requireVerbatimQuote: boolean;
}): string {
  const lines: string[] = [];
  lines.push(
    "Every fragment you write will be attributed to the sources the workflow was captured from.",
  );
  lines.push(
    "- Name the source of a specific fact when the source is a document and not the live URL. 'According to the onboarding PDF, ...' is attributable; an unattributed assertion is not.",
  );
  lines.push(
    "- Do not restate a source document's sentence in your own words and then attribute it as a quote. If the fragment is a paraphrase, mark it as such in your head; the extracting pass records the derivation separately.",
  );
  if (input.requireVerbatimQuote) {
    lines.push(
      "- When you quote a source verbatim, reproduce the string exactly, including capitalisation and punctuation. The extracting pass matches the quote against the source and will flag a mismatch.",
    );
  }
  lines.push(
    "- Do not invent a page number, a timestamp or a file name. The attribution layer records the locator from the extractor; a fabricated locator is treated as a broken span.",
  );
  return lines.join("\n");
}

export function rehydrateAttributionMap(value: unknown): AttributionMap {
  if (value === null || typeof value !== "object") {
    throw new AttributionError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "attribution/1") {
    throw new AttributionError(
      `Rehydrate failed: expected version "attribution/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  return {
    version: "attribution/1",
    fragments: readResolvedFragments(r["fragments"]),
    notes: readNotes(r["notes"]),
    summary: readSummary(r["summary"]),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/**
 * Register a source into a caller-supplied mutable map. Exported so tests
 * and the route layer can build a registry from its own persistence reads
 * with a single call, without this module inventing database access.
 */
export function registerSource(
  registry: { readonly sources: Map<string, AttributionSource> },
  source: AttributionSource,
): void {
  if (registry === null || typeof registry !== "object" || !(registry.sources instanceof Map)) {
    throw new AttributionError("`registry.sources` must be a Map.", "invalid-input");
  }
  if (source === null || typeof source !== "object" || typeof source.id !== "string" || source.id.length === 0) {
    throw new AttributionError("A source must have a non-empty string id.", "invalid-input");
  }
  registry.sources.set(source.id, source);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function readSourceKind(v: unknown): AttributionSourceKind {
  return v === "url" ||
    v === "pdf" ||
    v === "docx" ||
    v === "pptx" ||
    v === "image" ||
    v === "audio" ||
    v === "video" ||
    v === "text" ||
    v === "live-url" ||
    v === "canonical-item"
    ? v
    : "text";
}

function readLocatorKind(v: unknown): AttributionLocatorKind {
  return v === "page" ||
    v === "region" ||
    v === "timestamp" ||
    v === "selector" ||
    v === "anchor" ||
    v === "char-range" ||
    v === "none"
    ? v
    : "none";
}

function readDerivation(v: unknown): AttributionSpan["derivation"] {
  return v === "verbatim" || v === "paraphrase" || v === "derived" || v === "uncertain"
    ? v
    : "uncertain";
}

function readLocators(v: unknown): readonly AttributionLocator[] {
  if (!Array.isArray(v)) return [];
  const out: AttributionLocator[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const detail =
      o["detail"] !== null && typeof o["detail"] === "object" && !Array.isArray(o["detail"])
        ? (o["detail"] as Record<string, unknown>)
        : {};
    out.push({
      kind: readLocatorKind(o["kind"]),
      display: typeof o["display"] === "string" ? o["display"] : "",
      detail,
    });
  }
  return out;
}

function readResolvedSpan(v: unknown): ResolvedSpan | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const sourceRaw = o["source"];
  let source: AttributionSource | null = null;
  if (sourceRaw !== null && typeof sourceRaw === "object") {
    const s = sourceRaw as Record<string, unknown>;
    source = {
      id: typeof s["id"] === "string" ? s["id"] : "",
      kind: readSourceKind(s["kind"]),
      label: typeof s["label"] === "string" ? s["label"] : "",
      href: typeof s["href"] === "string" ? s["href"] : null,
      capturedAt: typeof s["capturedAt"] === "string" ? s["capturedAt"] : null,
      reachable: s["reachable"] === true,
    };
  }
  return {
    sourceId: typeof o["sourceId"] === "string" ? o["sourceId"] : "",
    source,
    locators: readLocators(o["locators"]),
    excerpt: typeof o["excerpt"] === "string" ? o["excerpt"] : null,
    derivation: readDerivation(o["derivation"]),
    broken: o["broken"] === true,
    brokenReason: typeof o["brokenReason"] === "string" ? o["brokenReason"] : null,
    historical: o["historical"] === true,
  };
}

function readResolvedFragments(v: unknown): readonly ResolvedFragment[] {
  if (!Array.isArray(v)) return [];
  const out: ResolvedFragment[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const spansRaw = Array.isArray(o["spans"]) ? o["spans"] : [];
    const spans: ResolvedSpan[] = [];
    for (const s of spansRaw) {
      const parsed = readResolvedSpan(s);
      if (parsed !== null) spans.push(parsed);
    }
    const statusRaw = o["status"];
    const status: AttributionStatus =
      statusRaw === "attributed" ||
      statusRaw === "partially-attributed" ||
      statusRaw === "unattributed" ||
      statusRaw === "broken"
        ? statusRaw
        : "broken";
    const countsRaw = o["counts"];
    const counts =
      countsRaw !== null && typeof countsRaw === "object"
        ? {
            total: readInt((countsRaw as Record<string, unknown>)["total"]),
            resolved: readInt((countsRaw as Record<string, unknown>)["resolved"]),
            historical: readInt((countsRaw as Record<string, unknown>)["historical"]),
            broken: readInt((countsRaw as Record<string, unknown>)["broken"]),
          }
        : {
            total: spans.length,
            resolved: spans.filter((s) => !s.broken).length,
            historical: spans.filter((s) => !s.broken && s.historical).length,
            broken: spans.filter((s) => s.broken).length,
          };
    out.push({
      fragmentId: typeof o["fragmentId"] === "string" ? o["fragmentId"] : "",
      location: typeof o["location"] === "string" ? o["location"] : "",
      fragmentText: typeof o["fragmentText"] === "string" ? o["fragmentText"] : "",
      status,
      spans,
      summary: typeof o["summary"] === "string" ? o["summary"] : "",
      counts,
    });
  }
  return out;
}

function readNotes(v: unknown): readonly AttributionNote[] {
  if (!Array.isArray(v)) return [];
  const out: AttributionNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "no-registry" &&
      kind !== "duplicate-fragment" &&
      kind !== "empty-fragment" &&
      kind !== "unattributed-fragment" &&
      kind !== "broken-source" &&
      kind !== "historical-source" &&
      kind !== "empty-locators" &&
      kind !== "verbatim-without-excerpt"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

function readSummary(v: unknown): AttributionMap["summary"] {
  const fallback = {
    total: 0,
    attributed: 0,
    partiallyAttributed: 0,
    unattributed: 0,
    broken: 0,
  };
  if (v === null || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  return {
    total: readInt(o["total"]),
    attributed: readInt(o["attributed"]),
    partiallyAttributed: readInt(o["partiallyAttributed"]),
    unattributed: readInt(o["unattributed"]),
    broken: readInt(o["broken"]),
  };
}

function readInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  return 0;
}

function compareResolvedSpans(a: ResolvedSpan, b: ResolvedSpan): number {
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  const la = a.locators[0]?.display ?? "";
  const lb = b.locators[0]?.display ?? "";
  if (la !== lb) return la < lb ? -1 : 1;
  return 0;
}

function escapeInline(s: string): string {
  return s.replace(/\|/gu, "\\|");
}

function escapeQuote(s: string): string {
  return s.replace(/\n{2,}/gu, " ").replace(/\n/gu, " ").replace(/^/u, "").trim();
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  readLocatorKind,
  readSourceKind,
  readDerivation,
  readLocators,
  readResolvedSpan,
  readResolvedFragments,
  readNotes,
  readSummary,
  compareResolvedSpans,
  escapeInline,
  escapeQuote,
});
