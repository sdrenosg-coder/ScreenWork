/**
 * Zipy AI — flowchart/diagram graph extraction.
 *
 * Reconstructs a directed graph (nodes, labelled edges, shapes) from a
 * diagram region and renders it as a *textual workflow description* for the
 * content layer. The graph is what the "workflow description" step of Phase 6
 * requires; the text rendering is what an LLM sees when a source PDF contains
 * a diagram.
 *
 * Inputs are pure data: the caller supplies a list of detected shape
 * primitives plus the OCR text regions that lie inside them (both produced
 * by earlier pipeline stages — `layout.ts` classifies the figure region,
 * `ocr.ts` provides text). This module does not call a vision model. When a
 * dedicated graph extractor *is* configured, the caller may pass a
 * `providedGraph` and this module normalises it; otherwise the geometric
 * assembler runs.
 *
 * Shape assembly rules (deterministic; no guessing):
 *   1. Nodes are primitives whose kind is a node-like shape
 *      (`rectangle`, `rounded-rectangle`, `diamond`, `ellipse`, `stadium`,
 *      `parallelogram`) with an area at least `minNodeArea`. Any shape the
 *      caller flags `terminal: true` (start/end) is kept regardless.
 *   2. Each OCR region whose bbox lies *inside* a node's bbox (>= 60% of its
 *      area) contributes to that node's `text`, joined by space in reading
 *      order. A region that overlaps two nodes is assigned to the node with
 *      greatest IoU and the ambiguity is recorded on both nodes as
 *      `textAmbiguity: true`.
 *   3. Edges are assembled from connector primitives (`line`, `arrow`,
 *      `polyline`) by matching their endpoints to node boundaries: an
 *      endpoint counts as attached to a node when it lies within
 *      `edgeAttachTolerance` pixels of the node's outline (not inside).
 *      Edges with fewer than two attached nodes are dropped and counted in
 *      `droppedConnectors`.
 *   4. Edge labels come from OCR regions whose bbox lies *between* the two
 *      endpoint nodes (>= 30% of the region inside the segment's bounding
 *      rectangle) and within `edgeLabelMaxDistance` of the connector.
 *
 * Text rendering produces three surfaces:
 *   - `toTextDescription`: the walk from start node(s) following edges in
 *     reading order, with branching written as "If <label> then … else …".
 *     Cycles stop after the first repeat of a node so a rendered guide never
 *     loops.
 *   - `toAsciiTree`: an indented tree from the start node; used in
 *     structured content output (code block/decision tree).
 *   - `toMarkdown`: a Markdown bullet list rendering.
 *
 * No I/O. No network. No credentials. Pure.
 */

import type { BBox, OcrRegion } from "@zipy/ingest/ocr";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DiagramErrorCode =
  | "invalid-input"
  | "empty-input"
  | "no-start-node";

export class DiagramError extends Error {
  readonly code: DiagramErrorCode;
  constructor(message: string, code: DiagramErrorCode) {
    super(message);
    this.name = "DiagramError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Input primitives                                                            */
/* -------------------------------------------------------------------------- */

export type ShapeKind =
  | "rectangle"
  | "rounded-rectangle"
  | "diamond"
  | "ellipse"
  | "stadium"
  | "parallelogram"
  | "circle"
  | "line"
  | "arrow"
  | "polyline"
  | "text"
  | "other";

export interface ShapePrimitive {
  /** Monotonic id within the source diagram; used only for diagnostics. */
  readonly id: string;
  readonly kind: ShapeKind;
  readonly bbox: BBox;
  /**
   * When the caller already knows a shape is a start/end terminal (typical
   * when the diagram came from a structured format), set this. The assembler
   * prefers explicit terminals; otherwise it infers the start node from
   * topology (the node with in-degree 0 whose text tokenises to a
   * start-like phrase — see `START_KEYWORDS`).
   */
  readonly terminal?: "start" | "end" | null;
  /**
   * Optional list of points for line/arrow/polyline primitives. `bbox` is
   * always used as the bounding rectangle of these points; `points` is used
   * to find endpoints exactly. When absent, endpoints are derived from the
   * bbox corners closest to each node.
   */
  readonly points?: readonly { readonly x: number; readonly y: number }[] | null;
}

export interface ProvidedGraphNode {
  readonly id: string;
  readonly label: string;
  readonly bbox: BBox;
  readonly terminal?: "start" | "end" | null;
}

export interface ProvidedGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string | null;
}

export interface ProvidedGraph {
  readonly nodes: readonly ProvidedGraphNode[];
  readonly edges: readonly ProvidedGraphEdge[];
}

export interface ExtractDiagramInput {
  readonly pageIndex: number;
  /** All shape primitives on the page (of which some form the diagram). */
  readonly shapes: readonly ShapePrimitive[];
  /** OCR text regions overlapping the diagram. */
  readonly ocrRegions: readonly OcrRegion[];
  /** Pre-built graph from a structured source, or null. */
  readonly providedGraph?: ProvidedGraph | null;
}

export interface ExtractDiagramOptions {
  /** Minimum node area in pixels squared. Default 400. */
  readonly minNodeArea?: number;
  /** Distance from a node outline (px) at which a connector endpoint is "attached". Default 12. */
  readonly edgeAttachTolerance?: number;
  /** Maximum distance from a connector to an OCR region to consider it a label. Default 30. */
  readonly edgeLabelMaxDistance?: number;
  /** IoU at or above which a label is ambiguous between nodes. Default 0.2. */
  readonly textAmbiguityIoU?: number;
}

/* -------------------------------------------------------------------------- */
/* Output graph                                                                */
/* -------------------------------------------------------------------------- */

export interface DiagramNode {
  readonly id: string;
  /** Human-readable label; joined OCR text or "Node <id>" when no OCR region landed inside. */
  readonly label: string;
  readonly kind: ShapeKind;
  readonly bbox: BBox;
  /** "start", "end" when the caller supplied a terminal or a start-keyword matched, else null. */
  readonly terminal: "start" | "end" | null;
  /** OCR region indexes whose text landed inside this node. */
  readonly ocrIndexes: readonly number[];
  /** True when a text region overlapped two nodes and this node is one of them. */
  readonly textAmbiguity: boolean;
}

export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  /** Source shape id (for provenance). */
  readonly sourceShapeId: string;
  readonly ocrIndexes: readonly number[];
}

export interface DiagramGraph {
  readonly pageIndex: number;
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Node id of the inferred start, or null when none was identified. */
  readonly startNodeId: string | null;
  readonly endNodeIds: readonly string[];
  /** True when the graph is connected from `startNodeId` (every node reachable). */
  readonly isConnectedFromStart: boolean;
  /** Connector shapes that did not attach to two nodes. */
  readonly droppedConnectors: number;
  /** Text regions that overlapped no node. */
  readonly orphanTextRegions: number;
  /** ISO timestamp of completion. */
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Thresholds and keyword tables                                               */
/* -------------------------------------------------------------------------- */

const DEFAULT_MIN_NODE_AREA = 400;
const DEFAULT_EDGE_ATTACH_TOLERANCE = 12;
const DEFAULT_EDGE_LABEL_MAX_DISTANCE = 30;
const DEFAULT_TEXT_AMBIGUITY_IOU = 0.2;

const NODE_SHAPES: readonly ShapeKind[] = [
  "rectangle",
  "rounded-rectangle",
  "diamond",
  "ellipse",
  "stadium",
  "parallelogram",
  "circle",
];

const CONNECTOR_SHAPES: readonly ShapeKind[] = ["line", "arrow", "polyline"];

/**
 * Text fragments that strongly suggest a start node in a flowchart. Matched
 * case-insensitively on the *first* word of the node's label. This is a
 * heuristic: the caller may override with `terminal: "start"` on a shape.
 */
const START_KEYWORDS: readonly string[] = [
  "start",
  "begin",
  "entry",
  "trigger",
  "beginning",
  "start:",
];

const END_KEYWORDS: readonly string[] = [
  "end",
  "finish",
  "done",
  "complete",
  "exit",
  "stop",
];

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Extract a diagram graph from the provided primitives. When
 * `input.providedGraph` is supplied, it is normalised and returned without
 * geometric assembly.
 *
 * Throws `DiagramError` when the inputs are structurally impossible
 * (non-positive page dims, non-array shapes). Returns a graph with
 * `nodeCount === 0` when a page simply has no diagram — that is not an
 * error, it is a page without a figure; the caller decides whether to skip.
 */
export function extractDiagramGraph(
  input: ExtractDiagramInput,
  options: ExtractDiagramOptions = {},
): DiagramGraph {
  if (input === null || typeof input !== "object") {
    throw new DiagramError("extractDiagramGraph requires an input object.", "invalid-input");
  }
  if (
    typeof input.pageIndex !== "number" ||
    !Number.isFinite(input.pageIndex) ||
    input.pageIndex < 0
  ) {
    throw new DiagramError("pageIndex must be a finite non-negative number.", "invalid-input");
  }
  if (!Array.isArray(input.shapes)) {
    throw new DiagramError("shapes must be an array.", "invalid-input");
  }
  if (!Array.isArray(input.ocrRegions)) {
    throw new DiagramError("ocrRegions must be an array.", "invalid-input");
  }

  if (input.providedGraph !== null && input.providedGraph !== undefined) {
    return normaliseProvidedGraph(input.pageIndex, input.providedGraph);
  }

  const minNodeArea = positiveOr(options.minNodeArea, DEFAULT_MIN_NODE_AREA);
  const attachTolerance = positiveOr(options.edgeAttachTolerance, DEFAULT_EDGE_ATTACH_TOLERANCE);
  const labelMaxDistance = positiveOr(options.edgeLabelMaxDistance, DEFAULT_EDGE_LABEL_MAX_DISTANCE);
  const textAmbiguityIoU = clampRatio(options.textAmbiguityIoU ?? DEFAULT_TEXT_AMBIGUITY_IOU);

  // ---------------------------------------------------------------------
  // Node detection
  // ---------------------------------------------------------------------
  interface MutableNode {
    id: string;
    kind: ShapeKind;
    bbox: BBox;
    terminal: "start" | "end" | null;
    textParts: { index: number; text: string }[];
    textAmbiguity: boolean;
  }
  const nodes: MutableNode[] = [];
  let droppedConnectors = 0;
  const connectors: ShapePrimitive[] = [];
  for (const shape of input.shapes) {
    if (shape === null || typeof shape !== "object") continue;
    if (
      typeof shape.bbox?.x !== "number" ||
      typeof shape.bbox?.y !== "number" ||
      typeof shape.bbox?.width !== "number" ||
      typeof shape.bbox?.height !== "number" ||
      shape.bbox.width <= 0 ||
      shape.bbox.height <= 0
    ) {
      continue;
    }
    if (CONNECTOR_SHAPES.includes(shape.kind)) {
      connectors.push(shape);
      continue;
    }
    if (!NODE_SHAPES.includes(shape.kind)) continue;
    const area = shape.bbox.width * shape.bbox.height;
    const explicitTerminal = shape.terminal === "start" || shape.terminal === "end" ? shape.terminal : null;
    if (area < minNodeArea && explicitTerminal === null) continue;
    nodes.push({
      id: shape.id,
      kind: shape.kind,
      bbox: roundBBox(shape.bbox),
      terminal: explicitTerminal,
      textParts: [],
      textAmbiguity: false,
    });
  }

  // ---------------------------------------------------------------------
  // Text assignment: each OCR region goes to the node whose box contains
  // the greatest fraction of its area.
  // ---------------------------------------------------------------------
  let orphanTextRegions = 0;
  for (let i = 0; i < input.ocrRegions.length; i += 1) {
    const r = input.ocrRegions[i];
    if (r === undefined || r === null) continue;
    const text = r.text.trim();
    if (text.length === 0) continue;
    const regionArea = r.bbox.width * r.bbox.height;
    if (regionArea <= 0) continue;

    // Find the node with maximum coverage.
    let bestNode: MutableNode | null = null;
    let bestIoU = 0;
    const overlaps: { node: MutableNode; ratio: number }[] = [];
    for (const node of nodes) {
      const interArea = intersectionArea(node.bbox, r.bbox);
      if (interArea === 0) continue;
      const coverage = interArea / regionArea;
      if (coverage >= 0.6) {
        const iouScore = iou(node.bbox, r.bbox);
        overlaps.push({ node, ratio: coverage });
        if (iouScore > bestIoU) {
          bestIoU = iouScore;
          bestNode = node;
        }
      }
    }
    if (bestNode === null) {
      orphanTextRegions += 1;
      continue;
    }
    bestNode.textParts.push({ index: i, text });
    // Mark ambiguity when a second node also covers this region substantially.
    if (overlaps.length > 1 && bestIoU >= textAmbiguityIoU) {
      for (const o of overlaps) o.node.textAmbiguity = true;
    }
  }

  // Finalise node text: join in reading order (by ocr y then x).
  for (const node of nodes) {
    node.textParts.sort((a, b) => {
      const ra = input.ocrRegions[a.index];
      const rb = input.ocrRegions[b.index];
      if (ra === undefined || rb === undefined) return 0;
      if (ra.bbox.y !== rb.bbox.y) return ra.bbox.y - rb.bbox.y;
      return ra.bbox.x - rb.bbox.x;
    });
  }

  // Terminal inference from keyword match.
  for (const node of nodes) {
    if (node.terminal !== null) continue;
    const joined = node.textParts.map((p) => p.text).join(" ").trim().toLowerCase();
    if (joined.length === 0) continue;
    const firstWord = joined.split(/\s+/)[0] ?? "";
    if (START_KEYWORDS.some((k) => firstWord.startsWith(k))) node.terminal = "start";
    else if (END_KEYWORDS.some((k) => firstWord.startsWith(k))) node.terminal = "end";
  }

  // ---------------------------------------------------------------------
  // Edge assembly: each connector endpoint is matched to a node boundary.
  // ---------------------------------------------------------------------
  interface MutableEdge {
    from: string;
    to: string;
    sourceShapeId: string;
    label: string | null;
    ocrIndexes: number[];
    segmentBBox: BBox;
  }
  const edges: MutableEdge[] = [];

  for (const connector of connectors) {
    const endpoints = connectorEndpoints(connector);
    if (endpoints.length < 2) {
      droppedConnectors += 1;
      continue;
    }
    const attachedA = findAttachedNode(endpoints[0] as { x: number; y: number }, nodes, attachTolerance);
    const attachedB = findAttachedNode(endpoints[1] as { x: number; y: number }, nodes, attachTolerance);
    if (attachedA === null || attachedB === null || attachedA.id === attachedB.id) {
      droppedConnectors += 1;
      continue;
    }

    // Direction: arrowheads point at the target. Heuristic: when the shape
    // is an "arrow", the second endpoint is assumed to be the head end
    // (matching svg/flowchart convention); when "line", direction is from
    // reading order (top/left → bottom/right).
    let fromNode = attachedA;
    let toNode = attachedB;
    if (connector.kind === "line" || connector.kind === "polyline") {
      if (compareReadingOrder(attachedA.bbox, attachedB.bbox) > 0) {
        fromNode = attachedB;
        toNode = attachedA;
      }
    }

    const segmentBBox = boundingBoxOfPoints(endpoints);

    // Label lookup: OCR regions overlapping segmentBBox within distance.
    const ocrIndexes: number[] = [];
    let labelText: string | null = null;
    for (let i = 0; i < input.ocrRegions.length; i += 1) {
      const r = input.ocrRegions[i];
      if (r === undefined || r === null) continue;
      const text = r.text.trim();
      if (text.length === 0) continue;
      // Region must overlap the segment bbox area (>= 30% of its own area)
      const inter = intersectionArea(segmentBBox, r.bbox);
      const regionArea = r.bbox.width * r.bbox.height;
      if (regionArea <= 0) continue;
      if (inter / regionArea < 0.3) continue;
      const distance = bboxDistance(segmentBBox, r.bbox);
      if (distance > labelMaxDistance) continue;
      ocrIndexes.push(i);
      if (labelText === null) labelText = text;
    }

    edges.push({
      from: fromNode.id,
      to: toNode.id,
      sourceShapeId: connector.id,
      label: labelText,
      ocrIndexes,
      segmentBBox,
    });
  }

  // ---------------------------------------------------------------------
  // Start-node inference: prefer explicit `terminal: "start"`, else a node
  // with in-degree 0. When multiple candidates exist, choose the one with
  // the smallest y (topmost) for determinism.
  // ---------------------------------------------------------------------
  const inDegree = new Map<string, number>();
  for (const n of nodes) inDegree.set(n.id, 0);
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }
  const explicitStarts = nodes.filter((n) => n.terminal === "start");
  let startNodeId: string | null = null;
  if (explicitStarts.length > 0) {
    explicitStarts.sort((a, b) => a.bbox.y - b.bbox.y);
    startNodeId = explicitStarts[0]?.id ?? null;
  } else {
    const candidates = nodes
      .filter((n) => (inDegree.get(n.id) ?? 0) === 0 && n.terminal !== "end")
      .sort((a, b) => {
        if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
        return a.bbox.x - b.bbox.x;
      });
    startNodeId = candidates[0]?.id ?? null;
  }

  const endNodeIds = nodes
    .filter((n) => n.terminal === "end")
    .map((n) => n.id);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    adjacency.set(e.from, list);
  }
  const isConnectedFromStart =
    startNodeId !== null
      ? nodes.length === reachableFrom(startNodeId, adjacency, nodeMap).size
      : nodes.length === 0;

  const finalNodes: DiagramNode[] = nodes.map((n) => ({
    id: n.id,
    label:
      n.textParts.length > 0
        ? n.textParts.map((p) => p.text).join(" ").trim()
        : `Node ${n.id}`,
    kind: n.kind,
    bbox: n.bbox,
    terminal: n.terminal,
    ocrIndexes: n.textParts.map((p) => p.index),
    textAmbiguity: n.textAmbiguity,
  }));

  const finalEdges: DiagramEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    label: e.label,
    sourceShapeId: e.sourceShapeId,
    ocrIndexes: e.ocrIndexes.slice(),
  }));

  return {
    pageIndex: input.pageIndex,
    nodes: finalNodes,
    edges: finalEdges,
    nodeCount: finalNodes.length,
    edgeCount: finalEdges.length,
    startNodeId,
    endNodeIds,
    isConnectedFromStart,
    droppedConnectors,
    orphanTextRegions,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Provided-graph normalisation                                                */
/* -------------------------------------------------------------------------- */

function normaliseProvidedGraph(pageIndex: number, g: ProvidedGraph): DiagramGraph {
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    throw new DiagramError(
      "providedGraph must have nodes and edges arrays.",
      "invalid-input",
    );
  }
  const nodes: DiagramNode[] = [];
  const seen = new Set<string>();
  for (const n of g.nodes) {
    if (n === null || typeof n !== "object") continue;
    if (typeof n.id !== "string" || n.id.length === 0) continue;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (
      typeof n.bbox?.x !== "number" ||
      typeof n.bbox?.y !== "number" ||
      typeof n.bbox?.width !== "number" ||
      typeof n.bbox?.height !== "number"
    ) {
      continue;
    }
    const terminal: "start" | "end" | null =
      n.terminal === "start" || n.terminal === "end" ? n.terminal : null;
    nodes.push({
      id: n.id,
      label: typeof n.label === "string" && n.label.length > 0 ? n.label : `Node ${n.id}`,
      kind: "rectangle",
      bbox: roundBBox(n.bbox),
      terminal,
      ocrIndexes: [],
      textAmbiguity: false,
    });
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: DiagramEdge[] = [];
  for (const e of g.edges) {
    if (e === null || typeof e !== "object") continue;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    edges.push({
      from: e.from,
      to: e.to,
      label: typeof e.label === "string" && e.label.length > 0 ? e.label : null,
      sourceShapeId: "provided",
      ocrIndexes: [],
    });
  }
  const inDegree = new Map<string, number>();
  for (const n of nodes) inDegree.set(n.id, 0);
  for (const e of edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  const explicitStarts = nodes.filter((n) => n.terminal === "start");
  let startNodeId: string | null = null;
  if (explicitStarts.length > 0) {
    startNodeId = explicitStarts[0]?.id ?? null;
  } else {
    const candidates = nodes
      .filter((n) => (inDegree.get(n.id) ?? 0) === 0)
      .sort((a, b) => {
        if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
        return a.bbox.x - b.bbox.x;
      });
    startNodeId = candidates[0]?.id ?? null;
  }
  const endNodeIds = nodes.filter((n) => n.terminal === "end").map((n) => n.id);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from) ?? [];
    list.push(e.to);
    adjacency.set(e.from, list);
  }
  return {
    pageIndex,
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    startNodeId,
    endNodeIds,
    isConnectedFromStart:
      startNodeId !== null
        ? nodes.length === reachableFrom(startNodeId, adjacency, nodeMap).size
        : nodes.length === 0,
    droppedConnectors: 0,
    orphanTextRegions: 0,
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Connector endpoint extraction                                               */
/* -------------------------------------------------------------------------- */

function connectorEndpoints(
  shape: ShapePrimitive,
): readonly { readonly x: number; readonly y: number }[] {
  if (Array.isArray(shape.points) && shape.points.length >= 2) {
    const pts = shape.points.filter(
      (p): p is { x: number; y: number } =>
        p !== null &&
        typeof p === "object" &&
        typeof (p as { x?: unknown }).x === "number" &&
        typeof (p as { y?: unknown }).y === "number",
    );
    if (pts.length >= 2) {
      return [pts[0] as { x: number; y: number }, pts[pts.length - 1] as { x: number; y: number }];
    }
  }
  // Fall back to the bbox corners. Assume a top-left → bottom-right flow,
  // the standard orientation of screenshots and diagram tools.
  const { x, y, width, height } = shape.bbox;
  return [
    { x: x + 1, y: y + 1 },
    { x: x + width - 1, y: y + height - 1 },
  ];
}

/* -------------------------------------------------------------------------- */
/* Attachment                                                                  */
/* -------------------------------------------------------------------------- */

function findAttachedNode(
  point: { readonly x: number; readonly y: number },
  nodes: readonly { readonly id: string; readonly bbox: BBox }[],
  tolerance: number,
): { readonly id: string; readonly bbox: BBox } | null {
  let best: { readonly id: string; readonly bbox: BBox } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const distance = pointToBoxDistance(point, node.bbox);
    if (distance > tolerance) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { id: node.id, bbox: node.bbox };
    }
  }
  return best;
}

function pointToBoxDistance(
  p: { readonly x: number; readonly y: number },
  b: BBox,
): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
  return Math.sqrt(dx * dx + dy * dy);
}

function bboxDistance(a: BBox, b: BBox): number {
  const dx = Math.max(b.x - (a.x + a.width), 0, a.x - (b.x + b.width));
  const dy = Math.max(b.y - (a.y + a.height), 0, a.y - (b.y + b.height));
  return Math.sqrt(dx * dx + dy * dy);
}

function boundingBoxOfPoints(
  points: readonly { readonly x: number; readonly y: number }[],
): BBox {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.max(1, Math.round(maxX - minX)),
    height: Math.max(1, Math.round(maxY - minY)),
  };
}

/* -------------------------------------------------------------------------- */
/* Geometry primitives reused across the module                                */
/* -------------------------------------------------------------------------- */

function intersectionArea(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function iou(a: BBox, b: BBox): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function roundBBox(b: BBox): BBox {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(1, Math.round(b.width)),
    height: Math.max(1, Math.round(b.height)),
  };
}

function compareReadingOrder(a: BBox, b: BBox): number {
  if (a.y !== b.y) return a.y - b.y;
  return a.x - b.x;
}

/* -------------------------------------------------------------------------- */
/* Graph traversal                                                             */
/* -------------------------------------------------------------------------- */

function reachableFrom(
  startId: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  nodeMap: ReadonlyMap<string, unknown>,
): ReadonlySet<string> {
  const seen = new Set<string>();
  if (!nodeMap.has(startId)) return seen;
  const stack: string[] = [startId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const next = adjacency.get(id);
    if (next === undefined) continue;
    for (const n of next) {
      if (!seen.has(n)) stack.push(n);
    }
  }
  return seen;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Render the graph as a natural-language workflow description. Walks from
 * `startNodeId` following edges in deterministic order; cycles stop at the
 * first repeat of a node. Branching renders as "If <label> then X, else Y".
 * Blocks are prefixed with a heading identifying the page and node count so
 * the reader knows the source.
 */
export function toTextDescription(graph: DiagramGraph): string {
  if (graph.nodeCount === 0) {
    return `Page ${graph.pageIndex}: no diagram nodes were detected.`;
  }
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgesByFrom = new Map<string, DiagramEdge[]>();
  for (const e of graph.edges) {
    const list = edgesByFrom.get(e.from) ?? [];
    list.push(e);
    edgesByFrom.set(e.from, list);
  }
  for (const list of edgesByFrom.values()) {
    list.sort((a, b) => a.to.localeCompare(b.to));
  }

  const lines: string[] = [];
  const startCount = graph.startNodeId !== null ? 1 : Math.max(1, graph.nodes.filter((n) => n.terminal !== "end").length);
  lines.push(
    `Workflow diagram on page ${graph.pageIndex} with ${graph.nodeCount} node(s) and ${graph.edgeCount} edge(s)` +
      (startCount > 1 ? ` (${startCount} possible starting nodes):` : ":"),
  );

  const visited = new Set<string>();

  const walk = (nodeId: string, depth: number, path: readonly string[]): void => {
    if (depth > 64) {
      lines.push(`${"  ".repeat(depth)}[max depth reached at ${nodeId}]`);
      return;
    }
    if (visited.has(nodeId) && path.includes(nodeId)) {
      lines.push(`${"  ".repeat(depth)}[back to "${nodeMap.get(nodeId)?.label ?? nodeId}" (cycle)]`);
      return;
    }
    visited.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (node === undefined) return;
    const label = node.label;
    const terminalSuffix =
      node.terminal === "start" ? " (start)" : node.terminal === "end" ? " (end)" : "";
    if (depth === 0) {
      lines.push(`  ${label}${terminalSuffix}`);
    }
    const outgoing = edgesByFrom.get(nodeId) ?? [];
    if (outgoing.length === 0) {
      if (node.terminal !== "end") lines.push(`${"  ".repeat(depth + 1)}→ [end of path]`);
      return;
    }
    for (const e of outgoing) {
      const targetNode = nodeMap.get(e.to);
      if (targetNode === undefined) continue;
      const edgeLabel = e.label !== null ? `If ${e.label}: ` : "";
      lines.push(
        `${"  ".repeat(depth + 1)}→ ${edgeLabel}${targetNode.label}` +
          (targetNode.terminal === "end" ? " (end)" : ""),
      );
      if (!path.includes(e.to)) {
        walk(e.to, depth + 1, [...path, e.to]);
      } else {
        lines.push(`${"  ".repeat(depth + 2)}[cycle: already visited "${targetNode.label}"]`);
      }
    }
  };

  if (graph.startNodeId !== null) {
    walk(graph.startNodeId, 0, [graph.startNodeId]);
  } else {
    // No inferred start; render every node's outgoing edges once.
    for (const node of graph.nodes) {
      if (visited.has(node.id)) continue;
      walk(node.id, 0, [node.id]);
    }
  }
  return lines.join("\n");
}

/**
 * Render the graph as an indented ASCII tree from the start node. Nodes
 * visited twice are annotated as cycles.
 */
export function toAsciiTree(graph: DiagramGraph): string {
  if (graph.nodeCount === 0) return "";
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgesByFrom = new Map<string, DiagramEdge[]>();
  for (const e of graph.edges) {
    const list = edgesByFrom.get(e.from) ?? [];
    list.push(e);
    edgesByFrom.set(e.from, list);
  }
  for (const list of edgesByFrom.values()) {
    list.sort((a, b) => a.to.localeCompare(b.to));
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const render = (id: string, prefix: string, isLast: boolean): void => {
    const node = nodeMap.get(id);
    if (node === undefined) return;
    const connector = prefix.length === 0 ? "" : isLast ? "└── " : "├── ";
    const terminal = node.terminal === "start" ? " [start]" : node.terminal === "end" ? " [end]" : "";
    const cycle = seen.has(id) ? " [cycle]" : "";
    lines.push(`${prefix}${connector}${node.label}${terminal}${cycle}`);
    if (seen.has(id)) return;
    seen.add(id);
    const outgoing = edgesByFrom.get(id) ?? [];
    for (let i = 0; i < outgoing.length; i += 1) {
      const e = outgoing[i] as DiagramEdge;
      const labelPrefix = e.label !== null ? `[${e.label}] ` : "";
      const childPrefix = prefix + (prefix.length === 0 ? "" : isLast ? "    " : "│   ");
      render(e.to, childPrefix, i === outgoing.length - 1);
      if (labelPrefix.length > 0) {
        // Annotate the edge label on its own line for clarity.
        lines.splice(lines.length - 1, 0, `${childPrefix}${labelPrefix}`);
      }
    }
  };
  if (graph.startNodeId !== null) {
    render(graph.startNodeId, "", true);
  } else {
    for (const n of graph.nodes) {
      if (seen.has(n.id)) continue;
      render(n.id, "", true);
    }
  }
  return lines.join("\n");
}

/**
 * Render the graph as a Markdown bullet list. Each node is a bullet; its
 * outgoing edges are nested bullets with the edge label in bold when present.
 */
export function toMarkdown(graph: DiagramGraph): string {
  if (graph.nodeCount === 0) return "_No diagram nodes detected._";
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgesByFrom = new Map<string, DiagramEdge[]>();
  for (const e of graph.edges) {
    const list = edgesByFrom.get(e.from) ?? [];
    list.push(e);
    edgesByFrom.set(e.from, list);
  }
  for (const list of edgesByFrom.values()) {
    list.sort((a, b) => a.to.localeCompare(b.to));
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const render = (id: string, indent: number, path: readonly string[]): void => {
    const node = nodeMap.get(id);
    if (node === undefined) return;
    const pad = "  ".repeat(indent);
    const terminal = node.terminal === "start" ? " **(start)**" : node.terminal === "end" ? " **(end)**" : "";
    if (path.includes(id)) {
      lines.push(`${pad}- ${node.label}${terminal} _(cycle)_`);
      return;
    }
    lines.push(`${pad}- ${node.label}${terminal}`);
    if (seen.has(id)) return;
    seen.add(id);
    const outgoing = edgesByFrom.get(id) ?? [];
    for (const e of outgoing) {
      const target = nodeMap.get(e.to);
      if (target === undefined) continue;
      const label = e.label !== null ? ` **(If ${e.label})** ` : " → ";
      lines.push(`${pad}  ${label}${target.label}`);
      if (!path.includes(e.to)) {
        render(e.to, indent + 2, [...path, e.to]);
      }
    }
  };
  if (graph.startNodeId !== null) {
    render(graph.startNodeId, 0, [graph.startNodeId]);
  } else {
    for (const n of graph.nodes) {
      if (seen.has(n.id)) continue;
      render(n.id, 0, [n.id]);
    }
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Rehydration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a persisted `DiagramGraph`. Throws on structurally invalid payloads.
 */
export function rehydrateDiagramGraph(value: unknown): DiagramGraph {
  if (value === null || typeof value !== "object") {
    throw new DiagramError("Rehydrate failed: payload is not an object.", "invalid-input");
  }
  const r = value as Record<string, unknown>;
  const pageIndex = numberOr(r["pageIndex"], 0);
  const startNodeRaw = r["startNodeId"];
  const startNodeId = typeof startNodeRaw === "string" ? startNodeRaw : null;
  const endNodeIdsRaw = Array.isArray(r["endNodeIds"]) ? (r["endNodeIds"] as unknown[]) : [];
  const endNodeIds = endNodeIdsRaw.filter((v): v is string => typeof v === "string");
  const droppedConnectors = numberOr(r["droppedConnectors"], 0);
  const orphanTextRegions = numberOr(r["orphanTextRegions"], 0);
  const isConnectedFromStart = r["isConnectedFromStart"] === true;

  const nodesRaw = Array.isArray(r["nodes"]) ? (r["nodes"] as unknown[]) : [];
  const nodes: DiagramNode[] = [];
  for (const nRaw of nodesRaw) {
    if (nRaw === null || typeof nRaw !== "object") continue;
    const n = nRaw as Record<string, unknown>;
    const id = typeof n["id"] === "string" ? (n["id"] as string) : null;
    const bbox = parseBBox(n["bbox"]);
    if (id === null || bbox === null) continue;
    const kindRaw = typeof n["kind"] === "string" ? (n["kind"] as string) : "other";
    const validKinds: readonly ShapeKind[] = [
      "rectangle",
      "rounded-rectangle",
      "diamond",
      "ellipse",
      "stadium",
      "parallelogram",
      "circle",
      "line",
      "arrow",
      "polyline",
      "text",
      "other",
    ];
    const kind: ShapeKind = (validKinds as readonly string[]).includes(kindRaw)
      ? (kindRaw as ShapeKind)
      : "other";
    const terminalRaw = n["terminal"];
    const terminal: "start" | "end" | null =
      terminalRaw === "start" || terminalRaw === "end" ? terminalRaw : null;
    const ocrIdxsRaw = Array.isArray(n["ocrIndexes"]) ? (n["ocrIndexes"] as unknown[]) : [];
    const ocrIndexes = ocrIdxsRaw.filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
    );
    nodes.push({
      id,
      label: typeof n["label"] === "string" ? (n["label"] as string) : `Node ${id}`,
      kind,
      bbox,
      terminal,
      ocrIndexes,
      textAmbiguity: n["textAmbiguity"] === true,
    });
  }

  const edgesRaw = Array.isArray(r["edges"]) ? (r["edges"] as unknown[]) : [];
  const edges: DiagramEdge[] = [];
  for (const eRaw of edgesRaw) {
    if (eRaw === null || typeof eRaw !== "object") continue;
    const e = eRaw as Record<string, unknown>;
    if (typeof e["from"] !== "string" || typeof e["to"] !== "string") continue;
    const labelRaw = e["label"];
    const ocrIdxsRaw = Array.isArray(e["ocrIndexes"]) ? (e["ocrIndexes"] as unknown[]) : [];
    const ocrIndexes = ocrIdxsRaw.filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
    );
    edges.push({
      from: e["from"] as string,
      to: e["to"] as string,
      label: typeof labelRaw === "string" && labelRaw.length > 0 ? labelRaw : null,
      sourceShapeId:
        typeof e["sourceShapeId"] === "string" ? (e["sourceShapeId"] as string) : "unknown",
      ocrIndexes,
    });
  }

  return {
    pageIndex,
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    startNodeId,
    endNodeIds,
    isConnectedFromStart,
    droppedConnectors,
    orphanTextRegions,
    generatedAt: typeof r["generatedAt"] === "string" ? (r["generatedAt"] as string) : "",
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

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function positiveOr(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return fallback;
  return v;
}

function clampRatio(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
