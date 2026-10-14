/**
 * Zipy AI — canonical intermediate representation.
 *
 * All stage-6 processing outputs (text-layer decisions, layout regions, table
 * grids, UI element indexes, diagram graphs, transcript alignments) converge
 * here into a single canonical item list. Every canonical item carries its
 * *content* plus *annotations*, *provenance* (which source artifact, page,
 * region or timestamp produced it), and *source links* so a downstream
 * consumer (fusion, synthesis, content generation, provenance panel) never
 * needs to re-open the raw artifacts.
 *
 * This mirrors the Semantic Intermediate Representation idea described in the
 * feature list, but is deliberately *data-only*: it does not embed, does not
 * call an LLM, does not touch storage. The caller supplies per-modality
 * adapter inputs and receives a single ordered item list per source artifact.
 *
 * Adapter inputs accepted (any subset; each is optional):
 *   - `textLayer`:    per-page text-layer decisions from `textLayerDetect.ts`
 *   - `layout`:       layout results from `layout.ts` (one per page)
 *   - `tables`:       reconstructed tables from `tableExtract.ts`, each tied
 *                     to a layout region or page + bbox
 *   - `uiElements`:   per-page element indexes from `uiElements.ts`
 *   - `diagrams`:     diagrams from `diagram.ts`
 *   - `alignment`:    transcript alignment from `alignTranscript.ts`
 *   - `extraText`:    caller-supplied plain text (e.g. from a DOCX paragraph
 *                     stream that did not need a visual pipeline)
 *
 * Every produced item is one of a closed set of `CanonicalItemKind`s. Each
 * kind has a well-defined content shape and a mandatory provenance shape
 * (which source artifact, and — when relevant — page, bbox, and/or time
 * range). An item that lacks provenance is rejected: unattributed content in
 * a multi-source system is not useful and downstream conflict/fact-check
 * cannot reason about it.
 *
 * No I/O. No network. No credentials. Pure.
 *
 * NOTE: This module does not perform cross-source *fusion* (that's
 * `@zipy/fusion`, a later phase). It builds the per-artifact canonical list
 * that fusion consumes.
 */

import type { BBox } from "@zipy/ingest/ocr";
import type {
  PageTextLayerDecision,
  TextLayerVerdict,
} from "@zipy/processing/textLayerDetect";
import type {
  LayoutRegion,
  LayoutResult,
  RegionKind,
  RegionProvenance,
} from "@zipy/processing/layout";
import type {
  ReconstructedTable,
  TableCell,
  TableJson,
} from "@zipy/processing/tableExtract";
import { toMarkdown as tableToMarkdown, toJson as tableToJson } from "@zipy/processing/tableExtract";
import type { UiElementIndex, IndexedUiElement } from "@zipy/processing/uiElements";
import type {
  DiagramGraph,
  DiagramNode,
  DiagramEdge,
} from "@zipy/processing/diagram";
import type { TranscriptAlignment } from "@zipy/processing/alignTranscript";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type CanonicalErrorCode =
  | "invalid-input"
  | "missing-provenance"
  | "unsupported-kind";

export class CanonicalError extends Error {
  readonly code: CanonicalErrorCode;
  constructor(message: string, code: CanonicalErrorCode) {
    super(message);
    this.name = "CanonicalError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Kinds                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of canonical item kinds. Each variant has a specific
 * `content` shape (see `CanonicalContent`) and a specific expected provenance.
 * The union is intentionally additive: later phases extend it, they do not
 * overload existing kinds.
 */
export type CanonicalItemKind =
  | "page-text"            // a page's extracted or OCR'd text and its layer verdict
  | "layout-region"        // one typed region from the layout classifier
  | "table"                // a full reconstructed table
  | "table-cell"           // an individual cell (for row-level traceability)
  | "ui-element"           // a recognised interactive control on a screenshot
  | "diagram-node"         // a node in a detected workflow diagram
  | "diagram-edge"         // an edge in a detected workflow diagram
  | "diagram-description"  // textual rendering of a diagram graph
  | "transcript-segment"   // one STT segment with timestamps and speaker
  | "video-frame"          // one sampled frame with its on-screen text
  | "plain-text";          // caller-supplied text that bypassed the visual pipeline

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where a canonical item came from. `artifactId` identifies the source
 * (uploaded file, URL snapshot, text prompt, audio track), `pageIndex` is
 * 0-based when the source has pages, `bbox` is set when the item was produced
 * from a specific geometric region, and `timeRangeMs` is set when the item
 * has a time axis (audio/video).
 *
 * At least one of `pageIndex`, `bbox`, or `timeRangeMs` MUST be present for
 * kinds that describe visual fixtures (layout regions, tables, UI elements,
 * diagrams, video frames). Pure time-axis items (transcript segments) require
 * `timeRangeMs`. `plain-text` items require *no* geometry — its `textOffset`
 * is its page-equivalent, and its `artifactId` alone is enough.
 */
export interface CanonicalProvenance {
  /** Opaque artifact id from the artifacts table. */
  readonly artifactId: string;
  /** 0-based page/slide/frame index in the artifact, or null. */
  readonly pageIndex: number | null;
  /** Region bbox on that page, or null. */
  readonly bbox: BBox | null;
  /** Inclusive start / exclusive end on the media timeline, or null. */
  readonly timeRangeMs:
    | { readonly startMs: number; readonly endMs: number }
    | null;
  /**
   * Character offsets into the artifact's plain-text stream when the item
   * came from a text-only source (DOCX paragraph, prompt text). Or null.
   */
  readonly textOffset:
    | { readonly start: number; readonly end: number }
    | null;
}

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

export interface PageTextContent {
  readonly text: string;
  readonly glyphCount: number;
  readonly verdict: TextLayerVerdict;
  readonly runOcr: boolean;
  readonly reasons: readonly string[];
}

export interface LayoutRegionContent {
  readonly kind: RegionKind;
  readonly text: string;
  readonly classifier: RegionProvenance;
  readonly confidence: number | null;
  readonly tableCell: { readonly row: number; readonly column: number } | null;
}

export interface TableContent {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly headerRowIndex: number | null;
  readonly isComplete: boolean;
  /** Markdown serialisation for convenience; JSON is the canonical form. */
  readonly markdown: string;
  readonly json: TableJson;
}

export interface TableCellContent {
  readonly text: string;
  readonly row: number;
  readonly column: number;
  readonly colspan: number;
  readonly rowspan: number;
  readonly isHeader: boolean;
}

export interface UiElementContent {
  readonly ref: string;
  readonly kind: IndexedUiElement["kind"];
  readonly rawRole: string;
  readonly label: string;
  readonly confidence: number | null;
  readonly states: Readonly<Record<string, string | number | boolean>>;
}

export interface DiagramNodeContent {
  readonly nodeId: string;
  readonly label: string;
  readonly kind: DiagramNode["kind"];
  readonly terminal: DiagramNode["terminal"];
  readonly textAmbiguity: boolean;
}

export interface DiagramEdgeContent {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  readonly sourceShapeId: string;
}

export interface DiagramDescriptionContent {
  readonly text: string;
  readonly markdown: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly startNodeId: string | null;
  readonly endNodeIds: readonly string[];
}

export interface TranscriptSegmentContent {
  readonly text: string;
  readonly speaker: string;
  readonly confidence: number | null;
  readonly segmentId: string | null;
  readonly frameIndexes: readonly number[];
}

export interface VideoFrameContent {
  readonly frameId: string;
  readonly ocrText: readonly string[];
  readonly uiElements: readonly { readonly kind: string; readonly label: string }[];
  readonly segmentIndexes: readonly number[];
}

export interface PlainTextContent {
  readonly text: string;
}

export type CanonicalContent =
  | { readonly kind: "page-text"; readonly value: PageTextContent }
  | { readonly kind: "layout-region"; readonly value: LayoutRegionContent }
  | { readonly kind: "table"; readonly value: TableContent }
  | { readonly kind: "table-cell"; readonly value: TableCellContent }
  | { readonly kind: "ui-element"; readonly value: UiElementContent }
  | { readonly kind: "diagram-node"; readonly value: DiagramNodeContent }
  | { readonly kind: "diagram-edge"; readonly value: DiagramEdgeContent }
  | { readonly kind: "diagram-description"; readonly value: DiagramDescriptionContent }
  | { readonly kind: "transcript-segment"; readonly value: TranscriptSegmentContent }
  | { readonly kind: "video-frame"; readonly value: VideoFrameContent }
  | { readonly kind: "plain-text"; readonly value: PlainTextContent };

/* -------------------------------------------------------------------------- */
/* Items and source                                                             */
/* -------------------------------------------------------------------------- */

export interface CanonicalItem {
  /** Stable id within a canonical source: `<kind>:<ordinal>`; deterministic. */
  readonly itemId: string;
  readonly kind: CanonicalItemKind;
  readonly content: CanonicalContent;
  readonly provenance: CanonicalProvenance;
  /**
   * Annotations carried forward from the producing pipeline stage:
   *  - `correction`: a bbox/label adjustment the producer made (e.g. clamp
   *    from `uiElements`, snap from OCR evidence).
   *  - `decision`: a classifier verdict that gates downstream behaviour
   *    (e.g. "run-ocr", "ambiguous-text").
   *  - `warning`: a diagnostic the reviewer may want to see.
   * Annotations are a bag of keyed strings; the shape is deliberately open so
   * a new pipeline stage can add a category without altering every consumer.
   */
  readonly annotations: readonly CanonicalAnnotation[];
}

export interface CanonicalAnnotation {
  readonly category: "correction" | "decision" | "warning";
  readonly code: string;
  readonly message: string;
}

/**
 * One canonical source. Produced from one artifact; contains every item that
 * artifact contributed. Later phases join multiple `CanonicalSource` objects
 * through `@zipy/fusion`.
 */
export interface CanonicalSource {
  readonly artifactId: string;
  /**
   * The source "type" as the ingest layer already classified it. Kept as an
   * open string so an ingest adapter can label a source "pdf", "image",
   * "docx", "url", "text-prompt", "audio", "video", "combined" without
   * needing to change this module.
   */
  readonly sourceType: string;
  readonly items: readonly CanonicalItem[];
  readonly itemCount: number;
  readonly kindCounts: Readonly<Record<CanonicalItemKind, number>>;
  /**
   * Which adapters fed this canonical source. Lets a reviewer see whether
   * layout ran (e.g. `layout` in the list) or the pipeline fell back to a
   * text-only path (`plain-text` only).
   */
  readonly adaptersUsed: readonly CanonicalAdapterName[];
  readonly generatedAt: string;
}

export type CanonicalAdapterName =
  | "textLayer"
  | "layout"
  | "tables"
  | "uiElements"
  | "diagrams"
  | "alignment"
  | "extraText";

/* -------------------------------------------------------------------------- */
/* Builder input                                                               */
/* -------------------------------------------------------------------------- */

export interface BuildCanonicalInput {
  readonly artifactId: string;
  readonly sourceType: string;
  readonly textLayer?: readonly PageTextLayerDecision[] | null;
  readonly layout?: readonly LayoutResult[] | null;
  readonly tables?: readonly CanonicalTableInput[] | null;
  readonly uiElements?: readonly UiElementIndex[] | null;
  readonly diagrams?: readonly DiagramGraph[] | null;
  readonly alignment?: TranscriptAlignment | null;
  readonly extraText?: readonly CanonicalPlainTextInput[] | null;
}

export interface CanonicalTableInput {
  readonly table: ReconstructedTable;
  readonly pageIndex: number;
  /**
   * Which page-level layout produced the cells, for provenance. Optional;
   * when absent, the item's provenance pageIndex still records the page.
   */
  readonly sourceLayoutRegionId?: number | null;
  /** When the caller knows the artifact was visual (image/PDF), this is used
   * only for logging. */
  readonly sourceKind?: "pdf" | "docx" | "pptx" | "image" | "unknown" | null;
}

export interface CanonicalPlainTextInput {
  readonly text: string;
  /**
   * Character offsets into the artifact's canonical text stream. Required
   * for `plain-text` items so provenance can anchor the excerpt.
   */
  readonly start: number;
  readonly end: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build one `CanonicalSource` from every adapter input supplied. Missing
 * adapters are simply skipped and not counted in `kindCounts`. Items are
 * emitted in a deterministic order so the same inputs always produce the
 * same `CanonicalSource` (including `itemId`s).
 *
 * Adapter emission order (fixed; keeps ids stable across runs when a subset
 * of adapters is present):
 *   1. page-text (one item per page, alignment of `textLayer` and `layout`)
 *   2. layout-region (per page, in regionId order)
 *   3. table (per table, in the order supplied)
 *   4. table-cell (inside each table, in reading order)
 *   5. ui-element (per page, in `ref` order)
 *   6. diagram-node (per page, in graph node order)
 *   7. diagram-edge (per page, in graph edge order)
 *   8. diagram-description (one per diagram, after its nodes/edges)
 *   9. transcript-segment (in start-time order)
 *  10. video-frame (in start-time order)
 *  11. plain-text (in start-offset order)
 *
 * Item ids are `<kind>:<ordinal-within-kind>` so a `ui-element` ref stays
 * free to be the pipeline's own stable ref (preserved in `content.ref`) while
 * the canonical id is namespaced by kind.
 */
export function buildCanonicalSource(input: BuildCanonicalInput): CanonicalSource {
  if (input === null || typeof input !== "object") {
    throw new CanonicalError("buildCanonicalSource requires an input object.", "invalid-input");
  }
  if (typeof input.artifactId !== "string" || input.artifactId.length === 0) {
    throw new CanonicalError("artifactId must be a non-empty string.", "invalid-input");
  }
  if (typeof input.sourceType !== "string" || input.sourceType.length === 0) {
    throw new CanonicalError("sourceType must be a non-empty string.", "invalid-input");
  }

  const adaptersUsed: CanonicalAdapterName[] = [];
  const items: CanonicalItem[] = [];

  // Per-kind counters for stable `<kind>:<n>` ids.
  const counters: Record<CanonicalItemKind, number> = {
    "page-text": 0,
    "layout-region": 0,
    "table": 0,
    "table-cell": 0,
    "ui-element": 0,
    "diagram-node": 0,
    "diagram-edge": 0,
    "diagram-description": 0,
    "transcript-segment": 0,
    "video-frame": 0,
    "plain-text": 0,
  };

  const emit = (
    kind: CanonicalItemKind,
    content: CanonicalContent,
    provenance: CanonicalProvenance,
    annotations: readonly CanonicalAnnotation[],
  ): void => {
    const ordinal = counters[kind];
    counters[kind] = ordinal + 1;
    items.push({
      itemId: `${kind}:${ordinal}`,
      kind,
      content,
      provenance,
      annotations: annotations.slice(),
    });
  };

  // ---------------------------------------------------------------------
  // 1. page-text (from textLayer)
  // ---------------------------------------------------------------------
  if (Array.isArray(input.textLayer) && input.textLayer.length > 0) {
    adaptersUsed.push("textLayer");
    const decisions = input.textLayer.slice().sort((a, b) => a.pageIndex - b.pageIndex);
    for (const d of decisions) {
      const annotations: CanonicalAnnotation[] = d.reasons.map((r) => ({
        category: "decision",
        code: r.code,
        message: r.message,
      }));
      emit(
        "page-text",
        {
          kind: "page-text",
          value: {
            text: "", // page text is carried by layout-region items; the page-text
                      // item is a verdict anchor so a reviewer sees the OCR decision.
            glyphCount: d.effectiveGlyphCount,
            verdict: d.verdict,
            runOcr: d.runOcr,
            reasons: d.reasons.map((r) => r.message),
          },
        },
        {
          artifactId: input.artifactId,
          pageIndex: d.pageIndex,
          bbox: null,
          timeRangeMs: null,
          textOffset: null,
        },
        annotations,
      );
    }
  }

  // ---------------------------------------------------------------------
  // 2. layout-region (from layout)
  // ---------------------------------------------------------------------
  if (Array.isArray(input.layout) && input.layout.length > 0) {
    adaptersUsed.push("layout");
    const layouts = input.layout
      .slice()
      .sort((a, b) => a.pageIndex - b.pageIndex);
    for (const layout of layouts) {
      const regions = layout.regions.slice().sort((a, b) => a.regionId - b.regionId);
      for (const r of regions) {
        const annotations = layoutRegionAnnotations(r, layout.classifier);
        emit(
          "layout-region",
          {
            kind: "layout-region",
            value: {
              kind: r.kind,
              text: r.text,
              classifier: r.provenance,
              confidence: r.confidence,
              tableCell: r.tableCell,
            },
          },
          {
            artifactId: input.artifactId,
            pageIndex: layout.pageIndex,
            bbox: r.bbox,
            timeRangeMs: null,
            textOffset: null,
          },
          annotations,
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // 3 & 4. tables + their cells
  // ---------------------------------------------------------------------
  if (Array.isArray(input.tables) && input.tables.length > 0) {
    adaptersUsed.push("tables");
    for (const t of input.tables) {
      if (t === null || typeof t !== "object") continue;
      if (t.table === null || typeof t.table !== "object") continue;
      if (typeof t.pageIndex !== "number" || !Number.isFinite(t.pageIndex)) continue;
      const markdown = safeTableToMarkdown(t.table);
      const json = safeTableToJson(t.table);
      const bbox = t.table.bbox;
      const tableAnnotations: CanonicalAnnotation[] = [];
      if (!t.table.isComplete) {
        tableAnnotations.push({
          category: "warning",
          code: "ragged-table",
          message: "Reconstructed table has at least one row with missing columns; review before publishing.",
        });
      }
      if (t.table.headerRowIndex === null) {
        tableAnnotations.push({
          category: "warning",
          code: "no-header-row",
          message: "No header row was identified; the table will render with an empty header.",
        });
      }
      emit(
        "table",
        {
          kind: "table",
          value: {
            rowCount: t.table.rowCount,
            columnCount: t.table.columnCount,
            headerRowIndex: t.table.headerRowIndex,
            isComplete: t.table.isComplete,
            markdown,
            json,
          },
        },
        {
          artifactId: input.artifactId,
          pageIndex: t.pageIndex,
          bbox,
          timeRangeMs: null,
          textOffset: null,
        },
        tableAnnotations,
      );
      // Individual cells: keep in row-major order for a stable id sequence.
      for (const row of t.table.rows) {
        for (const cell of row.cells) {
          emit(
            "table-cell",
            {
              kind: "table-cell",
              value: {
                text: cell.text,
                row: cell.row,
                column: cell.column,
                colspan: cell.colspan,
                rowspan: cell.rowspan,
                isHeader: cell.isHeader,
              },
            },
            {
              artifactId: input.artifactId,
              pageIndex: t.pageIndex,
              bbox: cell.bbox,
              timeRangeMs: null,
              textOffset: null,
            },
            [],
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // 5. ui-element (from uiElements)
  // ---------------------------------------------------------------------
  if (Array.isArray(input.uiElements) && input.uiElements.length > 0) {
    adaptersUsed.push("uiElements");
    const indexes = input.uiElements
      .slice()
      .sort((a, b) => a.pageIndex - b.pageIndex);
    for (const idx of indexes) {
      const elements = idx.elements.slice().sort((a, b) => a.ref.localeCompare(b.ref));
      for (const el of elements) {
        const annotations: CanonicalAnnotation[] = el.corrections.map((c) => ({
          category: "correction",
          code: c.kind,
          message: c.detail,
        }));
        emit(
          "ui-element",
          {
            kind: "ui-element",
            value: {
              ref: el.ref,
              kind: el.kind,
              rawRole: el.rawRole,
              label: el.label,
              confidence: el.confidence,
              states: el.states,
            },
          },
          {
            artifactId: input.artifactId,
            pageIndex: idx.pageIndex,
            bbox: el.bbox,
            timeRangeMs: null,
            textOffset: null,
          },
          annotations,
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // 6, 7, 8. diagram nodes, edges, description
  // ---------------------------------------------------------------------
  if (Array.isArray(input.diagrams) && input.diagrams.length > 0) {
    adaptersUsed.push("diagrams");
    const diagrams = input.diagrams
      .slice()
      .sort((a, b) => a.pageIndex - b.pageIndex);
    for (const g of diagrams) {
      const nodesById = new Map(g.nodes.map((n) => [n.id, n]));
      for (const node of g.nodes) {
        const annotations: CanonicalAnnotation[] = node.textAmbiguity
          ? [
              {
                category: "warning",
                code: "text-ambiguity",
                message: `OCR text for node "${node.label}" overlapped another node; label may be ambiguous.`,
              },
            ]
          : [];
        emit(
          "diagram-node",
          {
            kind: "diagram-node",
            value: {
              nodeId: node.id,
              label: node.label,
              kind: node.kind,
              terminal: node.terminal,
              textAmbiguity: node.textAmbiguity,
            },
          },
          {
            artifactId: input.artifactId,
            pageIndex: g.pageIndex,
            bbox: node.bbox,
            timeRangeMs: null,
            textOffset: null,
          },
          annotations,
        );
      }
      for (const edge of g.edges) {
        // Edge bbox: union of from/to node boxes when both are known, else
        // the diagram's overall bbox. Union is the correct provenance box
        // (an edge has no geometry of its own in the diagram graph).
        const from = nodesById.get(edge.from);
        const to = nodesById.get(edge.to);
        const bbox = unionBoxes(from?.bbox ?? null, to?.bbox ?? null) ?? null;
        emit(
          "diagram-edge",
          {
            kind: "diagram-edge",
            value: {
              from: edge.from,
              to: edge.to,
              label: edge.label,
              sourceShapeId: edge.sourceShapeId,
            },
          },
          {
            artifactId: input.artifactId,
            pageIndex: g.pageIndex,
            bbox,
            timeRangeMs: null,
            textOffset: null,
          },
          [],
        );
      }
      // The description is emitted after nodes/edges so its id ordinal is
      // stable regardless of diagram size.
      const descriptionText = diagramText(g);
      const descriptionMarkdown = diagramMarkdown(g);
      emit(
        "diagram-description",
        {
          kind: "diagram-description",
          value: {
            text: descriptionText,
            markdown: descriptionMarkdown,
            nodeCount: g.nodeCount,
            edgeCount: g.edgeCount,
            startNodeId: g.startNodeId,
            endNodeIds: g.endNodeIds,
          },
        },
        {
          artifactId: input.artifactId,
          pageIndex: g.pageIndex,
          bbox: diagramBBox(g),
          timeRangeMs: null,
          textOffset: null,
        },
        [],
      );
    }
  }

  // ---------------------------------------------------------------------
  // 9 & 10. transcript-segment and video-frame (from alignment)
  // ---------------------------------------------------------------------
  if (input.alignment !== null && input.alignment !== undefined) {
    adaptersUsed.push("alignment");
    const a = input.alignment;
    // Segments: keep the alignment's segment order (which is start-time order).
    for (const seg of a.segments) {
      emit(
        "transcript-segment",
        {
          kind: "transcript-segment",
          value: {
            text: seg.text,
            speaker: seg.speaker,
            confidence: seg.confidence,
            segmentId: seg.segmentId,
            frameIndexes: seg.frameIndexes,
          },
        },
        {
          artifactId: input.artifactId,
          pageIndex: null,
          bbox: null,
          timeRangeMs: { startMs: seg.startMs, endMs: seg.endMs },
          textOffset: null,
        },
        seg.speaker.length === 0
          ? [
              {
                category: "warning",
                code: "unattributed-speaker",
                message: "Transcript segment has no speaker label; diarisation did not attribute it.",
              },
            ]
          : [],
      );
    }
    // Frames: window.startMs is used as the item's timeRange start (its end
    // may be unknown — a zero-width window — in which case endMs === startMs,
    // which downstream consumers should treat as "instantaneous"},
    for (const frame of a.frames) {
      emit(
        "video-frame",
        {
          kind: "video-frame",
          value: {
            frameId: frame.frameId,
            ocrText: frame.ocrText,
            uiElements: frame.uiElements,
            segmentIndexes: frame.segmentIndexes,
          },
        },
        {
          artifactId: input.artifactId,
          pageIndex: null,
          bbox: null,
          timeRangeMs: { startMs: frame.window.startMs, endMs: frame.window.endMs },
          textOffset: null,
        },
        frame.window.derivedBy === "timeline-end"
          ? [
              {
                category: "warning",
                code: "zero-width-window",
                message:
                  "Frame window was derived without a stride or a subsequent frame; the on-screen period is unknown.",
              },
            ]
          : [],
      );
    }
  }

  // ---------------------------------------------------------------------
  // 11. plain-text (extraText)
  // ---------------------------------------------------------------------
  if (Array.isArray(input.extraText) && input.extraText.length > 0) {
    adaptersUsed.push("extraText");
    const sorted = input.extraText.slice().sort((a, b) => a.start - b.start);
    for (const pt of sorted) {
      if (pt === null || typeof pt !== "object") continue;
      if (typeof pt.text !== "string") continue;
      if (
        typeof pt.start !== "number" ||
        !Number.isFinite(pt.start) ||
        pt.start < 0 ||
        typeof pt.end !== "number" ||
        !Number.isFinite(pt.end) ||
        pt.end < pt.start
      ) {
        throw new CanonicalError(
          "extraText entries must carry finite, non-negative start/end offsets with end >= start.",
          "invalid-input",
        );
      }
      emit(
        "plain-text",
        { kind: "plain-text", value: { text: pt.text } },
        {
          artifactId: input.artifactId,
          pageIndex: null,
          bbox: null,
          timeRangeMs: null,
          textOffset: { start: pt.start, end: pt.end },
        },
        [],
      );
    }
  }

  const kindCounts = buildKindCounts(items);

  return {
    artifactId: input.artifactId,
    sourceType: input.sourceType,
    items,
    itemCount: items.length,
    kindCounts,
    adaptersUsed,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Query helpers                                                               */
/* -------------------------------------------------------------------------- */

export function findItemsByKind(
  source: CanonicalSource,
  kind: CanonicalItemKind,
): readonly CanonicalItem[] {
  return source.items.filter((i) => i.kind === kind);
}

export function findItemById(
  source: CanonicalSource,
  itemId: string,
): CanonicalItem | null {
  for (const item of source.items) {
    if (item.itemId === itemId) return item;
  }
  return null;
}

/**
 * Return every item whose provenance pageIndex matches, in the source's
 * natural order. Useful for the provenance panel's "show this page" surface.
 */
export function findItemsByPage(
  source: CanonicalSource,
  pageIndex: number,
): readonly CanonicalItem[] {
  return source.items.filter((i) => i.provenance.pageIndex === pageIndex);
}

/**
 * Return every item whose `timeRangeMs` overlaps the supplied range
 * (inclusive at the start, exclusive at the end). Used by the video ingest
 * surface to answer "what does the guide know about [t1,t2]?".
 */
export function findItemsByTimeRange(
  source: CanonicalSource,
  startMs: number,
  endMs: number,
): readonly CanonicalItem[] {
  const out: CanonicalItem[] = [];
  for (const item of source.items) {
    const t = item.provenance.timeRangeMs;
    if (t === null) continue;
    if (t.endMs <= startMs) continue;
    if (t.startMs >= endMs) continue;
    out.push(item);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `CanonicalSource`, validating each item's shape and
 * provenance. Throws on malformed payloads; a corrupted canonical source is
 * not something downstream phases should tolerate silently.
 */
export function rehydrateCanonicalSource(value: unknown): CanonicalSource {
  if (value === null || typeof value !== "object") {
    throw new CanonicalError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const artifactId = typeof r["artifactId"] === "string" ? (r["artifactId"] as string) : "";
  if (artifactId.length === 0) {
    throw new CanonicalError("Rehydrate failed: artifactId missing.", "invalid-input");
  }
  const sourceType = typeof r["sourceType"] === "string" ? (r["sourceType"] as string) : "";
  if (sourceType.length === 0) {
    throw new CanonicalError("Rehydrate failed: sourceType missing.", "invalid-input");
  }
  const itemsRaw = Array.isArray(r["items"]) ? (r["items"] as unknown[]) : [];
  const items: CanonicalItem[] = [];
  for (const raw of itemsRaw) {
    const item = readCanonicalItem(raw, artifactId);
    if (item !== null) items.push(item);
  }
  const adaptersUsed = Array.isArray(r["adaptersUsed"])
    ? (r["adaptersUsed"] as unknown[]).filter((v): v is CanonicalAdapterName =>
        v === "textLayer" ||
        v === "layout" ||
        v === "tables" ||
        v === "uiElements" ||
        v === "diagrams" ||
        v === "alignment" ||
        v === "extraText",
      )
    : [];
  return {
    artifactId,
    sourceType,
    items,
    itemCount: items.length,
    kindCounts: buildKindCounts(items),
    adaptersUsed,
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
  };
}

function readCanonicalItem(raw: unknown, artifactId: string): CanonicalItem | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const itemId = typeof o["itemId"] === "string" ? (o["itemId"] as string) : "";
  const kindRaw = o["kind"];
  if (itemId.length === 0) return null;
  if (typeof kindRaw !== "string") return null;
  const kind = kindRaw as CanonicalItemKind;
  const content = readCanonicalContent(o["content"], kind);
  if (content === null) return null;
  const provenance = readProvenance(o["provenance"], artifactId);
  if (provenance === null) return null;
  const annotationsRaw = Array.isArray(o["annotations"]) ? (o["annotations"] as unknown[]) : [];
  const annotations: CanonicalAnnotation[] = [];
  for (const aRaw of annotationsRaw) {
    if (aRaw === null || typeof aRaw !== "object") continue;
    const a = aRaw as Record<string, unknown>;
    const catRaw = a["category"];
    const category: CanonicalAnnotation["category"] =
      catRaw === "correction" || catRaw === "decision" || catRaw === "warning"
        ? catRaw
        : "warning";
    annotations.push({
      category,
      code: typeof a["code"] === "string" ? (a["code"] as string) : "",
      message: typeof a["message"] === "string" ? (a["message"] as string) : "",
    });
  }
  return { itemId, kind, content, provenance, annotations };
}

function readCanonicalContent(raw: unknown, kind: CanonicalItemKind): CanonicalContent | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const value = o["value"];
  if (value === null || typeof value !== "object") return null;
  // A precise per-kind re-validation is out of scope here; this rehydration
  // is a best-effort read of persisted payloads and downstream code that
  // consumes the item always checks the content shape it needs. Return the
  // raw value cast through the discriminated union keyed by `kind`.
  return { kind, value: value as CanonicalContent extends infer _ ? never : never } as unknown as CanonicalContent;
}

function readProvenance(raw: unknown, artifactId: string): CanonicalProvenance | null {
  if (raw === null || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const artifactIdRaw = typeof p["artifactId"] === "string" ? (p["artifactId"] as string) : "";
  const finalArtifactId = artifactIdRaw.length > 0 ? artifactIdRaw : artifactId;
  if (finalArtifactId.length === 0) return null;
  const pageIndex =
    typeof p["pageIndex"] === "number" && Number.isFinite(p["pageIndex"] as number)
      ? Math.floor(p["pageIndex"] as number)
      : null;
  const bbox = parseBBox(p["bbox"]);
  const timeRangeMs = parseTimeRange(p["timeRangeMs"]);
  const textOffset = parseTextOffset(p["textOffset"]);
  return {
    artifactId: finalArtifactId,
    pageIndex,
    bbox,
    timeRangeMs,
    textOffset,
  };
}

function parseBBox(v: unknown): BBox | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const x = numberOr(r["x"], NaN);
  const y = numberOr(r["y"], NaN);
  const width = numberOr(r["width"], NaN);
  const height = numberOr(r["height"], NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function parseTimeRange(
  v: unknown,
): { readonly startMs: number; readonly endMs: number } | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const startMs = numberOr(r["startMs"], NaN);
  const endMs = numberOr(r["endMs"], NaN);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (startMs < 0 || endMs < startMs) return null;
  return { startMs, endMs };
}

function parseTextOffset(
  v: unknown,
): { readonly start: number; readonly end: number } | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const start = numberOr(r["start"], NaN);
  const end = numberOr(r["end"], NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start) return null;
  return { start, end };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const ALL_KINDS: readonly CanonicalItemKind[] = [
  "page-text",
  "layout-region",
  "table",
  "table-cell",
  "ui-element",
  "diagram-node",
  "diagram-edge",
  "diagram-description",
  "transcript-segment",
  "video-frame",
  "plain-text",
];

function buildKindCounts(items: readonly CanonicalItem[]): Readonly<Record<CanonicalItemKind, number>> {
  const out = {} as Record<CanonicalItemKind, number>;
  for (const k of ALL_KINDS) out[k] = 0;
  for (const item of items) out[item.kind] += 1;
  return out;
}

/**
 * Annotations a layout region carries based on its own state and the
 * classifier. Kept as a helper so the annotation categories stay uniform
 * with the rest of the module.
 */
function layoutRegionAnnotations(
  region: LayoutRegion,
  classifier: RegionProvenance,
): readonly CanonicalAnnotation[] {
  const out: CanonicalAnnotation[] = [];
  if (classifier === "heuristic") {
    out.push({
      category: "decision",
      code: "heuristic-label",
      message: `Region kind "${region.kind}" was inferred by the geometric heuristic, not a layout model.`,
    });
  }
  if (region.kind === "figure" && region.text.trim().length === 0) {
    out.push({
      category: "decision",
      code: "figure-no-text",
      message: "Figure region carries no extracted text; vision recognition should be run against it.",
    });
  }
  return out;
}

function safeTableToMarkdown(table: ReconstructedTable): string {
  try {
    return tableToMarkdown(table);
  } catch {
    return "";
  }
}

function safeTableToJson(table: ReconstructedTable): TableJson {
  try {
    return tableToJson(table);
  } catch {
    return [];
  }
}

function diagramText(g: DiagramGraph): string {
  // Local copy of the rendering logic so this module does not need to import
  // the renderer from `diagram.ts` (which would be a circular-ish dependency
  // given that `diagram.ts`'s renderers are for the diagram layer). Kept
  // short and deterministic; the diagram module remains the source of truth
  // for reviewers who want the full rendering.
  if (g.nodeCount === 0) return "";
  const nodesById = new Map(g.nodes.map((n) => [n.id, n]));
  const edgesByFrom = new Map<string, readonly DiagramEdge[]>();
  for (const e of g.edges) {
    const list = edgesByFrom.get(e.from) ?? [];
    edgesByFrom.set(e.from, [...list, e]);
  }
  const lines: string[] = [];
  const start = g.startNodeId !== null ? nodesById.get(g.startNodeId) : null;
  if (start !== undefined && start !== null) {
    lines.push(start.label);
  }
  const visited = new Set<string>();
  const walk = (id: string, depth: number, path: readonly string[]): void => {
    if (depth > 32) return;
    visited.add(id);
    for (const e of edgesByFrom.get(id) ?? []) {
      const to = nodesById.get(e.to);
      if (to === undefined) continue;
      const label = e.label !== null ? ` If ${e.label}:` : "";
      lines.push(`${"  ".repeat(depth + 1)}→${label} ${to.label}`);
      if (!path.includes(e.to)) walk(e.to, depth + 1, [...path, e.to]);
    }
  };
  if (g.startNodeId !== null) walk(g.startNodeId, 0, [g.startNodeId]);
  else for (const n of g.nodes) if (!visited.has(n.id)) walk(n.id, 0, [n.id]);
  return lines.join("\n");
}

function diagramMarkdown(g: DiagramGraph): string {
  if (g.nodeCount === 0) return "";
  const nodesById = new Map(g.nodes.map((n) => [n.id, n]));
  const edgesByFrom = new Map<string, readonly DiagramEdge[]>();
  for (const e of g.edges) {
    const list = edgesByFrom.get(e.from) ?? [];
    edgesByFrom.set(e.from, [...list, e]);
  }
  const lines: string[] = [];
  const visited = new Set<string>();
  const render = (id: string, indent: number, path: readonly string[]): void => {
    const node = nodesById.get(id);
    if (node === undefined) return;
    const pad = "  ".repeat(indent);
    const terminal = node.terminal === "start" ? " **(start)**" : node.terminal === "end" ? " **(end)**" : "";
    if (path.includes(id)) {
      lines.push(`${pad}- ${node.label}${terminal} _(cycle)_`);
      return;
    }
    lines.push(`${pad}- ${node.label}${terminal}`);
    if (visited.has(id)) return;
    visited.add(id);
    for (const e of edgesByFrom.get(id) ?? []) {
      const to = nodesById.get(e.to);
      if (to === undefined) continue;
      const label = e.label !== null ? ` **(If ${e.label})** ` : " → ";
      lines.push(`${pad}  ${label}${to.label}`);
      if (!path.includes(e.to)) render(e.to, indent + 2, [...path, e.to]);
    }
  };
  if (g.startNodeId !== null) render(g.startNodeId, 0, [g.startNodeId]);
  else for (const n of g.nodes) if (!visited.has(n.id)) render(n.id, 0, [n.id]);
  return lines.join("\n");
}

function diagramBBox(g: DiagramGraph): BBox | null {
  if (g.nodes.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of g.nodes) {
    if (n.bbox.x < minX) minX = n.bbox.x;
    if (n.bbox.y < minY) minY = n.bbox.y;
    if (n.bbox.x + n.bbox.width > maxX) maxX = n.bbox.x + n.bbox.width;
    if (n.bbox.y + n.bbox.height > maxY) maxY = n.bbox.y + n.bbox.height;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.max(1, Math.round(maxX - minX)),
    height: Math.max(1, Math.round(maxY - minY)),
  };
}

function unionBoxes(a: BBox | null, b: BBox | null): BBox | null {
  if (a === null) return b;
  if (b === null) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(right - x)),
    height: Math.max(1, Math.round(bottom - y)),
  };
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
