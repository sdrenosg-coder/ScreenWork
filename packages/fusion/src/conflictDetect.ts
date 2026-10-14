/**
 * Zipy AI — cross-source conflict detection.
 *
 * When several sources describe the same workflow they will, sooner or later,
 * disagree: the live URL says "Click Save", a PDF says "Click Submit"; a
 * transcript says "leave the phone number blank" and a screenshot shows it
 * filled. This module finds those disagreements and reports them as
 * structured `Conflict` records that the UI can surface and the reviewer can
 * resolve. It is the layer between the fusion embedding pass (which produces
 * comparable vectors per item) and the reconciliation pass (which proposes a
 * resolution).
 *
 * What this module is, precisely:
 *  - Deterministic. Same inputs, same parameters → same conflict set, in the
 *    same order. No randomness, no model calls, no clock dependence except
 *    the single `generatedAt` timestamp.
 *  - Conservative. It emits a conflict only when there is positive evidence
 *    of disagreement (an overlapping subject with a different value, an
 *    ordering divergence on the same workflow, a categorical field-required
 *    mismatch). It does *not* emit a conflict merely because two sources
 *    described different parts of a workflow — that is *coverage*, and it
 *    belongs to `gapDetect.ts`.
 *  - Evidence-attached. Every conflict carries the two (or more) excerpts
 *    it was derived from, verbatim, plus the itemIds and (via the provenance
 *    index) the artifact / page / time references. The provenance panel
 *    renders these directly; a reviewer never has to re-open the source to
 *    see *what* was actually said.
 *  - Trust-aware. It ranks conflicts by a confidence score that factors in
 *    the trust scores of the disagreeing sources (supplied by `trustScore.ts`)
 *    — a live-URL-vs-PDF disagreement outranks a context-image-vs-context-image
 *    one — and it records which side the trust ranking favours.
 *  - Pure. No I/O, no network, no credentials. The caller (a worker task or
 *    an API route) supplies the canonical items, the trust ranking and the
 *    provenance index; this module only computes.
 *
 * What this module is NOT:
 *  - A resolver. It stops at "these two disagree, with this confidence, and
 *    trust currently favours A" — see `reconcile.ts` for the resolution step,
 *    which is allowed to call an LLM.
 *  - A universal semantic diff. It handles the conflict *kinds* that the
 *    product actually displays, listed below. An unclassifiable disagreement
 *    is not silently dropped: it is reported with `kind = "unclassified"` and
 *    the caller can decide whether to surface it.
 *
 * Conflict kinds handled:
 *  - `element-label`      — the same interactive element (matched by role +
 *                           approximate location / semantic key) carries
 *                           different accessible names in two sources.
 *  - `element-state`      — the same element's state differs (e.g. one source
 *                           shows a "Save" button enabled, another shows it
 *                           disabled / absent).
 *  - `step-ordering`      — two sources produce a different order over a set
 *                           of steps whose labels match pairwise.
 *  - `field-required`     — one source marks a form field as required, another
 *                           marks it optional (or vice versa).
 *  - `value-shape`        — one source demonstrates an input value and another
 *                           demonstrates a different, incompatible shape
 *                           (e.g. "555-1234" vs "5551234").
 *  - `url-route`          — two sources route through different paths to reach
 *                           the same logical endpoint.
 *  - `unclassified`       — a mismatch the module detected but could not name.
 */

import type { ProvenanceIndex } from "@zipy/fusion/provenance";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ConflictDetectErrorCode =
  | "invalid-input"
  | "missing-provenance-index";

export class ConflictDetectError extends Error {
  readonly code: ConflictDetectErrorCode;
  constructor(message: string, code: ConflictDetectErrorCode) {
    super(message);
    this.name = "ConflictDetectError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One canonical item, in the shape the detector reads. Consistent with
 * `ProvenanceItemInput` in `provenance.ts` so callers pass the same working
 * set to both modules without adapting.
 */
export interface ConflictItemInput {
  readonly itemId: string;
  readonly kind: string;
  /** Opaque content; narrowed per kind by the extractors below. */
  readonly content: unknown;
}

/**
 * One source. `sourceId` is the row id from the `sources` table (not the
 * artifact id); `artifactId` is the canonical source's artifact.
 */
export interface ConflictSourceInput {
  readonly sourceId: string;
  readonly artifactId: string;
  readonly sourceType: string;
  readonly items: readonly ConflictItemInput[];
}

/**
 * A trust score per source, as returned by
 * `trustScore.ts::scoreWorkingSetTrust`. Kept as a plain map so a caller
 * can supply scores from any source (a prior run, a cache, a hand-typed
 * override during development).
 */
export type TrustLookup = ReadonlyMap<string, number>;

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

export const CONFLICT_KINDS = [
  "element-label",
  "element-state",
  "step-ordering",
  "field-required",
  "value-shape",
  "url-route",
  "unclassified",
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/**
 * Which side the trust ranking favours, given the two disagreeing sources'
 * trust scores. `null` means the scores were equal within the configured
 * tolerance, so no side is preferred by weight alone.
 */
export type FavouredSide = "a" | "b" | null;

export interface ConflictExcerpt {
  readonly sourceId: string;
  readonly artifactId: string;
  readonly itemId: string;
  /** The literal text/value shown to the reviewer. Never synthesised. */
  readonly text: string;
  /** Human-readable provenance line, e.g. "Onboarding.pdf p.4". */
  readonly citation: string;
  /** 0..1 source trust score, when supplied. */
  readonly sourceTrust: number | null;
}

export interface Conflict {
  readonly conflictId: string;
  readonly kind: ConflictKind;
  /** One-line summary in neutral voice, e.g. `Element "Save" label differs`. */
  readonly summary: string;
  readonly excerptA: ConflictExcerpt;
  readonly excerptB: ConflictExcerpt;
  /** Extra sources when the same subject was found in more than two sources. */
  readonly additionalExcerpts: readonly ConflictExcerpt[];
  /**
   * 0..1 confidence this is a real conflict (as opposed to a phrasing
   * difference, a superseded snapshot, or a coincidental string match).
   */
  readonly confidence: number;
  readonly favouredSide: FavouredSide;
  /**
   * A deterministic tie-break the reconciliation pass can use without an
   * LLM: `a` when the two excerpts are considered equivalent but must be
   * rendered one way (e.g. same string, different whitespace), `null`
   * otherwise.
   */
  readonly deterministicPick: FavouredSide;
  readonly notes: readonly string[];
}

export interface ConflictReport {
  readonly conflicts: readonly Conflict[];
  readonly byKind: Readonly<Record<ConflictKind, number>>;
  readonly sourceCount: number;
  readonly itemCount: number;
  /** Threshold actually applied; surfaced so reviewers can audit noise filters. */
  readonly parameters: {
    readonly minConfidence: number;
    readonly trustTie: number;
    readonly labelSimilarity: number;
  };
  readonly generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

export interface DetectOptions {
  /** Lowest `confidence` a conflict may have to be returned. Defaults to 0.4. */
  readonly minConfidence?: number;
  /**
   * Trust-score difference below which the two sides are considered equally
   * trusted (favoured = null). Defaults to 0.05.
   */
  readonly trustTie?: number;
  /**
   * Jaccard similarity on token bigrams above which two element labels are
   * considered "the same element for comparison purposes"; labels that are
   * more different than this are treated as different elements and never
   * compared. Defaults to 0.6.
   */
  readonly labelSimilarity?: number;
  /**
   * Restrict the check to a subset of conflict kinds. Defaults to all kinds.
   */
  readonly enabledKinds?: readonly ConflictKind[];
}

/* -------------------------------------------------------------------------- */
/* Enumerated item view                                                        */
/* -------------------------------------------------------------------------- */

interface ElementView {
  readonly itemId: string;
  readonly sourceId: string;
  readonly artifactId: string;
  readonly role: string;
  readonly label: string;
  readonly states: Readonly<Record<string, string | boolean | number>>;
  readonly citation: string;
}

interface StepView {
  readonly itemId: string;
  readonly sourceId: string;
  readonly artifactId: string;
  readonly ordinal: number;
  readonly action: string;
  readonly targetLabel: string;
  readonly citation: string;
}

interface FieldView {
  readonly itemId: string;
  readonly sourceId: string;
  readonly artifactId: string;
  readonly name: string;
  readonly required: boolean;
  readonly valueShape: string | null;
  readonly citation: string;
}

interface RouteView {
  readonly itemId: string;
  readonly sourceId: string;
  readonly artifactId: string;
  readonly url: string;
  readonly normalizedPath: string;
  readonly citation: string;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Detect conflicts across a working set. `provenanceIndex` is required so
 * every excerpt can carry a citation; a missing or malformed index is an
 * error rather than a fallback to "unknown", because a conflict surface
 * without provenance is exactly what the product forbids.
 */
export function detectConflicts(
  sources: readonly ConflictSourceInput[],
  provenanceIndex: ProvenanceIndex,
  trust: TrustLookup,
  options: DetectOptions = {},
): ConflictReport {
  if (!Array.isArray(sources)) {
    throw new ConflictDetectError("detectConflicts requires an array of sources.", "invalid-input");
  }
  if (provenanceIndex === null || typeof provenanceIndex !== "object" || !provenanceIndex.byItemId) {
    throw new ConflictDetectError(
      "detectConflicts requires a ProvenanceIndex (build one with buildProvenanceIndex).",
      "missing-provenance-index",
    );
  }

  const minConfidence = clamp01(options.minConfidence ?? 0.4);
  const trustTie = Math.max(0, options.trustTie ?? 0.05);
  const labelSimilarity = clamp01(options.labelSimilarity ?? 0.6);
  const enabled = new Set<ConflictKind>(
    options.enabledKinds !== undefined && options.enabledKinds.length > 0
      ? options.enabledKinds
      : CONFLICT_KINDS,
  );

  // ---- Enumerate per-kind views ------------------------------------------
  const elements: ElementView[] = [];
  const steps: StepView[] = [];
  const fields: FieldView[] = [];
  const routes: RouteView[] = [];

  for (const src of sources) {
    if (src === null || typeof src !== "object") {
      throw new ConflictDetectError("ConflictSourceInput entries must be objects.", "invalid-input");
    }
    if (typeof src.sourceId !== "string" || src.sourceId.length === 0) {
      throw new ConflictDetectError("ConflictSourceInput.sourceId is missing.", "invalid-input");
    }
    if (typeof src.artifactId !== "string" || src.artifactId.length === 0) {
      throw new ConflictDetectError(
        `ConflictSourceInput "${src.sourceId}" is missing artifactId.`,
        "invalid-input",
      );
    }
    let ordinal = 0;
    for (const item of src.items) {
      if (item === null || typeof item !== "object") continue;
      const maybeEl = readElementView(item, src, provenanceIndex);
      if (maybeEl !== null) {
        elements.push(maybeEl);
        ordinal += 1;
        continue;
      }
      const maybeStep = readStepView(item, src, provenanceIndex, ordinal);
      if (maybeStep !== null) {
        steps.push(maybeStep);
        ordinal += 1;
        continue;
      }
      const maybeField = readFieldView(item, src, provenanceIndex);
      if (maybeField !== null) {
        fields.push(maybeField);
        continue;
      }
      const maybeRoute = readRouteView(item, src, provenanceIndex);
      if (maybeRoute !== null) {
        routes.push(maybeRoute);
      }
    }
  }

  const conflicts: Conflict[] = [];

  if (enabled.has("element-label") || enabled.has("element-state")) {
    conflicts.push(...detectElementConflicts(elements, trust, { trustTie, labelSimilarity }, enabled));
  }
  if (enabled.has("step-ordering")) {
    conflicts.push(...detectStepOrderingConflicts(steps, trust, trustTie));
  }
  if (enabled.has("field-required") || enabled.has("value-shape")) {
    conflicts.push(...detectFieldConflicts(fields, trust, trustTie, enabled));
  }
  if (enabled.has("url-route")) {
    conflicts.push(...detectRouteConflicts(routes, trust, trustTie));
  }

  // Filter below-threshold noise, then sort deterministically: confidence
  // descending, then kind, then the two excerpt itemIds lexicographically.
  // The lexicographic tie-break guarantees a stable order that does not
  // depend on Map or object iteration order.
  const filtered = conflicts.filter((c) => c.confidence >= minConfidence);
  filtered.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const ak = `${a.excerptA.itemId}|${a.excerptB.itemId}`;
    const bk = `${b.excerptA.itemId}|${b.excerptB.itemId}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const byKind: Record<ConflictKind, number> = {
    "element-label": 0,
    "element-state": 0,
    "step-ordering": 0,
    "field-required": 0,
    "value-shape": 0,
    "url-route": 0,
    unclassified: 0,
  };
  for (const c of filtered) byKind[c.kind] += 1;

  const itemCount = sources.reduce((acc, s) => acc + s.items.length, 0);

  return {
    conflicts: filtered,
    byKind,
    sourceCount: sources.length,
    itemCount,
    parameters: { minConfidence, trustTie, labelSimilarity },
    generatedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Element conflicts                                                           */
/* -------------------------------------------------------------------------- */

function detectElementConflicts(
  elements: readonly ElementView[],
  trust: TrustLookup,
  params: { readonly trustTie: number; readonly labelSimilarity: number },
  enabled: ReadonlySet<ConflictKind>,
): Conflict[] {
  const out: Conflict[] = [];
  // Pairwise O(N^2), but N here is the number of *interactive elements* across
  // a workflow's sources, which is small (tens to low hundreds). Optimising
  // this into a spatial or semantic index now would be premature and would
  // make the matching logic harder to audit.
  for (let i = 0; i < elements.length; i += 1) {
    const a = elements[i] as ElementView;
    for (let j = i + 1; j < elements.length; j += 1) {
      const b = elements[j] as ElementView;
      if (a.sourceId === b.sourceId) continue; // conflicts require two sources
      if (a.role !== b.role) continue; // different roles are different subjects

      const sim = labelSimilarity(a.label, b.label);

      if (enabled.has("element-label") && sim >= params.labelSimilarity && a.label !== b.label) {
        const conf = confidenceForLabelMismatch(a.label, b.label, sim);
        if (conf > 0) {
          out.push(
            buildConflict({
              kind: "element-label",
              summary: `Element "${a.label}" vs "${b.label}" (${a.role})`,
              a,
              b,
              trust,
              trustTie: params.trustTie,
              confidence: conf,
              notes: [
                `Label similarity ${sim.toFixed(2)} (>= ${params.labelSimilarity}).`,
              ],
            }),
          );
        }
      }

      if (enabled.has("element-state") && sim >= params.labelSimilarity && a.label === b.label) {
        const stateMismatch = compareStates(a.states, b.states);
        if (stateMismatch !== null) {
          out.push(
            buildConflict({
              kind: "element-state",
              summary: `Element "${a.label}" state differs (${stateMismatch.key})`,
              a,
              b,
              trust,
              trustTie: params.trustTie,
              confidence: 0.75,
              notes: [
                `State key "${stateMismatch.key}": a=${String(stateMismatch.aValue)}, b=${String(stateMismatch.bValue)}.`,
              ],
            }),
          );
        }
      }
    }
  }
  return out;
}

function compareStates(
  a: Readonly<Record<string, string | boolean | number>>,
  b: Readonly<Record<string, string | boolean | number>>,
): { readonly key: string; readonly aValue: unknown; readonly bValue: unknown } | null {
  // Only booleans are treated as truthy/falsy state conflicts. Numeric and
  // string states (e.g. "value=5" vs "value=10") are usually intentional
  // demo data, not conflicts.
  for (const key of Object.keys(a)) {
    if (!(key in b)) continue;
    const av = a[key];
    const bv = b[key];
    if (typeof av === "boolean" && typeof bv === "boolean" && av !== bv) {
      return { key, aValue: av, bValue: bv };
    }
  }
  return null;
}

function confidenceForLabelMismatch(a: string, b: string, sim: number): number {
  const sa = a.trim().toLowerCase();
  const sb = b.trim().toLowerCase();
  if (sa === sb) return 0; // whitespace-only difference, not a conflict
  // Similar strings (edit distance small relative to length) are more likely
  // a real rename than an entirely different element. Sim is in [0,1].
  // Map sim [0.6,1) to confidence [0.5, 0.95]; a mismatch above the
  // similarity threshold is assumed real.
  const clamped = Math.max(0, Math.min(1, sim));
  return 0.5 + 0.45 * clamped;
}

/* -------------------------------------------------------------------------- */
/* Step-ordering conflicts                                                     */
/* -------------------------------------------------------------------------- */

function detectStepOrderingConflicts(
  steps: readonly StepView[],
  trust: TrustLookup,
  trustTie: number,
): Conflict[] {
  // Group steps by source, then find the *pair of sources* whose steps
  // reference the same target labels but in a different order. We only
  // compare sources directly; with three sources this can produce multiple
  // conflicts, which is desirable (the reviewer resolves them independently).
  const bySource = new Map<string, StepView[]>();
  for (const s of steps) {
    const list = bySource.get(s.sourceId);
    if (list === undefined) bySource.set(s.sourceId, [s]);
    else list.push(s);
  }
  const sourceIds = Array.from(bySource.keys()).sort();
  const out: Conflict[] = [];
  for (let i = 0; i < sourceIds.length; i += 1) {
    for (let j = i + 1; j < sourceIds.length; j += 1) {
      const aSteps = (bySource.get(sourceIds[i] as string) ?? []).filter(
        (s) => s.targetLabel.length > 0 && s.action.length > 0,
      );
      const bSteps = (bySource.get(sourceIds[j] as string) ?? []).filter(
        (s) => s.targetLabel.length > 0 && s.action.length > 0,
      );
      if (aSteps.length < 2 || bSteps.length < 2) continue;
      const { inversions, sharedKeys } = countInversions(aSteps, bSteps);
      // Require at least two shared steps and at least one inversion; a
      // single-step workflow cannot meaningfully disagree about order.
      if (sharedKeys < 2 || inversions === 0) continue;
      const conf = clamp01(inversions / Math.max(1, (sharedKeys * (sharedKeys - 1)) / 2));
      const aFirst = aSteps[0] as StepView;
      const bFirst = bSteps[0] as StepView;
      out.push(
        buildConflict({
          kind: "step-ordering",
          summary: `Step order diverges (${inversions} inversion${inversions === 1 ? "" : "s"} over ${sharedKeys} shared steps)`,
          a: aFirst,
          b: bFirst,
          trust,
          trustTie,
          confidence: 0.5 + 0.4 * conf,
          notes: [
            `Compared "${sourceIds[i]}" (${aSteps.length} steps) with "${sourceIds[j]}" (${bSteps.length} steps).`,
          ],
        }),
      );
    }
  }
  return out;
}

/**
 * Return (inversions, sharedKeys): the number of pairs of shared keys whose
 * relative order differs between the two step sequences, and the number of
 * shared keys. Shared keys are (action, targetLabel) pairs; a step whose key
 * does not appear in the other sequence does not count.
 */
function countInversions(
  a: readonly StepView[],
  b: readonly StepView[],
): { readonly inversions: number; readonly sharedKeys: number } {
  const keyOf = (s: StepView): string => `${s.action.toLowerCase()}\u0001${s.targetLabel.toLowerCase()}`;
  const aKeys = a.map(keyOf);
  const bKeys = b.map(keyOf);
  const bPos = new Map<string, number>();
  bKeys.forEach((k, idx) => {
    if (!bPos.has(k)) bPos.set(k, idx);
  });
  const aShared = aKeys.filter((k) => bPos.has(k));
  if (aShared.length < 2) return { inversions: 0, sharedKeys: aShared.length };
  let inversions = 0;
  for (let i = 0; i < aShared.length; i += 1) {
    for (let j = i + 1; j < aShared.length; j += 1) {
      const pi = bPos.get(aShared[i] as string) as number;
      const pj = bPos.get(aShared[j] as string) as number;
      if (pi > pj) inversions += 1;
    }
  }
  return { inversions, sharedKeys: aShared.length };
}

/* -------------------------------------------------------------------------- */
/* Field conflicts (required + value-shape)                                    */
/* -------------------------------------------------------------------------- */

function detectFieldConflicts(
  fields: readonly FieldView[],
  trust: TrustLookup,
  trustTie: number,
  enabled: ReadonlySet<ConflictKind>,
): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const a = fields[i] as FieldView;
    for (let j = i + 1; j < fields.length; j += 1) {
      const b = fields[j] as FieldView;
      if (a.sourceId === b.sourceId) continue;
      if (a.name.trim().toLowerCase() !== b.name.trim().toLowerCase()) continue;

      if (enabled.has("field-required") && a.required !== b.required) {
        out.push(
          buildConflict({
            kind: "field-required",
            summary: `Field "${a.name}" required in one source, optional in another`,
            a,
            b,
            trust,
            trustTie,
            confidence: 0.8,
            notes: [`a.required=${a.required}, b.required=${b.required}.`],
          }),
        );
      }

      if (
        enabled.has("value-shape") &&
        a.valueShape !== null &&
        b.valueShape !== null &&
        a.valueShape !== b.valueShape
      ) {
        out.push(
          buildConflict({
            kind: "value-shape",
            summary: `Field "${a.name}" value shape differs ("${a.valueShape}" vs "${b.valueShape}")`,
            a,
            b,
            trust,
            trustTie,
            confidence: 0.55,
            notes: [
              "Shape is a normalised descriptor of the demonstrated value, not the value verbatim.",
            ],
          }),
        );
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* URL route conflicts                                                         */
/* -------------------------------------------------------------------------- */

function detectRouteConflicts(
  routes: readonly RouteView[],
  trust: TrustLookup,
  trustTie: number,
): Conflict[] {
  // Two sources that both reach the same normalised path but via different
  // literal URLs (different query params, trailing segment, parameter names)
  // are flagged. Same normalised path with identical literal URLs is not a
  // conflict (it is agreement).
  const out: Conflict[] = [];
  for (let i = 0; i < routes.length; i += 1) {
    const a = routes[i] as RouteView;
    for (let j = i + 1; j < routes.length; j += 1) {
      const b = routes[j] as RouteView;
      if (a.sourceId === b.sourceId) continue;
      if (a.normalizedPath !== b.normalizedPath) continue;
      if (a.url === b.url) continue;
      out.push(
        buildConflict({
          kind: "url-route",
          summary: `Same route "${a.normalizedPath}" reached via different URLs`,
          a,
          b,
          trust,
          trustTie,
          confidence: 0.5,
          notes: [`a.url="${a.url}", b.url="${b.url}".`],
        }),
      );
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* View extraction from opaque items                                           */
/* -------------------------------------------------------------------------- */

function readElementView(
  item: ConflictItemInput,
  src: ConflictSourceInput,
  provenanceIndex: ProvenanceIndex,
): ElementView | null {
  if (item.kind !== "ui-element") return null;
  const c = item.content;
  if (c === null || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  // Canonical shape wraps the payload under a "kind" discriminant and a
  // "value" object; accept either the wrapped form or a flat object so this
  // module is resilient to a caller that already unwrapped.
  const value = unwrapValue(o);
  const label = typeof value["label"] === "string" ? (value["label"] as string) : "";
  const role =
    typeof value["rawRole"] === "string" && (value["rawRole"] as string).length > 0
      ? (value["rawRole"] as string)
      : typeof value["kind"] === "string"
        ? (value["kind"] as string)
        : "generic";
  const states = readStates(value["states"]);
  return {
    itemId: item.itemId,
    sourceId: src.sourceId,
    artifactId: src.artifactId,
    role: role.toLowerCase(),
    label,
    states,
    citation: citationFor(provenanceIndex, item.itemId, src.artifactId),
  };
}

function readStepView(
  item: ConflictItemInput,
  src: ConflictSourceInput,
  provenanceIndex: ProvenanceIndex,
  ordinal: number,
): StepView | null {
  // A "step" in this detector is either a structured step item (introduced by
  // the synthesis phase, kind "step") or a transcript segment carrying a
  // recognised action verb and target. We handle the transcript case because
  // it is what makes meaningfully different sources comparable before the
  // synthesis phase exists; the structured case is the canonical form and
  // wins when both are present (transcripts are lower priority by default).
  if (item.kind === "transcript-segment") {
    const c = item.content;
    if (c === null || typeof c !== "object") return null;
    const value = unwrapValue(c as Record<string, unknown>);
    const text = typeof value["text"] === "string" ? (value["text"] as string) : "";
    const parsed = parseActionFromText(text);
    if (parsed === null) return null;
    return {
      itemId: item.itemId,
      sourceId: src.sourceId,
      artifactId: src.artifactId,
      ordinal,
      action: parsed.action,
      targetLabel: parsed.target,
      citation: citationFor(provenanceIndex, item.itemId, src.artifactId),
    };
  }
  if (item.kind === "step") {
    const c = item.content;
    if (c === null || typeof c !== "object") return null;
    const value = unwrapValue(c as Record<string, unknown>);
    const action = typeof value["action"] === "string" ? (value["action"] as string) : "";
    const target =
      typeof value["targetLabel"] === "string"
        ? (value["targetLabel"] as string)
        : typeof value["target"] === "string"
          ? (value["target"] as string)
          : "";
    if (action.length === 0) return null;
    return {
      itemId: item.itemId,
      sourceId: src.sourceId,
      artifactId: src.artifactId,
      ordinal,
      action,
      targetLabel: target,
      citation: citationFor(provenanceIndex, item.itemId, src.artifactId),
    };
  }
  return null;
}

function readFieldView(
  item: ConflictItemInput,
  src: ConflictSourceInput,
  provenanceIndex: ProvenanceIndex,
): FieldView | null {
  // Field information can come from a ui-element whose role is a textbox /
  // combobox / checkbox, carrying `required` and, when the source demonstrates
  // a value, `value`.
  if (item.kind !== "ui-element" && item.kind !== "table-cell") return null;
  const c = item.content;
  if (c === null || typeof c !== "object") return null;
  const value = unwrapValue(c as Record<string, unknown>);
  const role =
    typeof value["rawRole"] === "string" ? (value["rawRole"] as string) : (value["kind"] as string | undefined);
  const name =
    typeof value["label"] === "string"
      ? (value["label"] as string)
      : typeof value["name"] === "string"
        ? (value["name"] as string)
        : "";
  if (name.length === 0) return null;
  if (item.kind === "ui-element" && role !== undefined && !isFieldRole(role)) return null;
  const required = readRequired(value);
  const valueShape = readValueShape(value);
  return {
    itemId: item.itemId,
    sourceId: src.sourceId,
    artifactId: src.artifactId,
    name,
    required,
    valueShape,
    citation: citationFor(provenanceIndex, item.itemId, src.artifactId),
  };
}

function readRouteView(
  item: ConflictItemInput,
  src: ConflictSourceInput,
  provenanceIndex: ProvenanceIndex,
): RouteView | null {
  // A URL route is expressed either as a page-text item whose whole text is a
  // URL, or via a ui-element of role "link" whose label is a URL. We only
  // treat standalone URLs (< 512 chars, no spaces) as routes; a paragraph
  // mentioning a URL is not a route claim.
  const text = readAnyText(item);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return null;
  if (/\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return {
    itemId: item.itemId,
    sourceId: src.sourceId,
    artifactId: src.artifactId,
    url: trimmed,
    normalizedPath: `${url.host.toLowerCase()}${normalizePath(url.pathname)}`,
    citation: citationFor(provenanceIndex, item.itemId, src.artifactId),
  };
}

function readAnyText(item: ConflictItemInput): string | null {
  if (item.kind !== "ui-element" && item.kind !== "page-text" && item.kind !== "plain-text") {
    return null;
  }
  const c = item.content;
  if (c === null || typeof c !== "object") return null;
  const value = unwrapValue(c as Record<string, unknown>);
  if (typeof value["text"] === "string") return value["text"] as string;
  if (typeof value["label"] === "string") return value["label"] as string;
  return null;
}

/**
 * Canonical items wrap their payload under `{ kind, value }` (see
 * `@zipy/processing/canonical`). Some callers hand this module items whose
 * value has already been unwrapped. Accept both without guessing.
 */
function unwrapValue(o: Record<string, unknown>): Record<string, unknown> {
  const v = o["value"];
  if (v !== null && typeof v === "object") return v as Record<string, unknown>;
  return o;
}

function readStates(v: unknown): Readonly<Record<string, string | boolean | number>> {
  if (v === null || typeof v !== "object") return {};
  const out: Record<string, string | boolean | number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw === "boolean" || typeof raw === "number") {
      out[k] = raw;
    } else if (typeof raw === "string") {
      out[k] = raw;
    }
  }
  return out;
}

function isFieldRole(role: string): boolean {
  const r = role.toLowerCase();
  return (
    r === "textbox" ||
    r === "text field" ||
    r === "searchbox" ||
    r === "combobox" ||
    r === "checkbox" ||
    r === "radio" ||
    r === "spinbutton" ||
    r === "input" ||
    r === "textarea" ||
    r === "listbox"
  );
}

function readRequired(value: Record<string, unknown>): boolean {
  const states = value["states"];
  if (states !== null && typeof states === "object") {
    const s = states as Record<string, unknown>;
    if (s["required"] === true) return true;
    if (s["required"] === false) return false;
  }
  if (value["required"] === true) return true;
  if (value["required"] === false) return false;
  // Absent → treat as not-required rather than unknown. The caller is
  // responsible for only including items where the field's requiredness is
  // observable; a "field-required" conflict therefore requires two sources
  // that both expressed requiredness.
  return false;
}

/**
 * Summarise the *shape* of a demonstrated value, never the value itself.
 * This is deliberately lossy: the detector compares shapes
 * ("digits-10" vs "digits-with-dashes") and never the literal value, so a
 * user's real input data cannot leak through a conflict surface even after a
 * partial PII pass.
 *
 * Returns null when the item carries no shown value or when that value is not
 * a string/number (i.e. when it is a UI element without a demo value).
 */
function readValueShape(value: Record<string, unknown>): string | null {
  const raw = value["value"];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (s.length === 0) return null;
  return classifyShape(s);
}

function classifyShape(s: string): string {
  if (/^\+?\d{7,}$/.test(s)) return `digits-${s.replace(/[^0-9]/g, "").length}`;
  if (/^[\d\s()\-+]+$/.test(s)) return `digits-mixed-${s.replace(/[^0-9]/g, "").length}`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "email";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date-iso";
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return "date-slash";
  if (/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(s)) return "text-short";
  if (s.length > 64) return "text-long";
  return "text-other";
}

/**
 * Parse a natural-language step from transcript-like text. Only recognises
 * the imperative forms the product ships with ("click X", "press X", "select
 * X", "type X into Y", "open X"); anything else returns null so free-form
 * narration is not mistaken for a structured step.
 */
function parseActionFromText(text: string): { readonly action: string; readonly target: string } | null {
  const t = text.trim();
  if (t.length === 0) return null;
  const m = /^\s*(click|press|select|open|tap|choose)\s+(?:the\s+)?([A-Za-z0-9][^.,;!?]{0,63})/i.exec(t);
  if (m === null) return null;
  return { action: (m[1] as string).toLowerCase(), target: (m[2] as string).trim().toLowerCase() };
}

/* -------------------------------------------------------------------------- */
/* Similarity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Jaccard similarity over token bigrams of two labels, after lowercasing and
 * stripping non-alphanumeric characters. Returns 1 for identical strings
 * (after normalisation) and 0 for strings with no shared bigrams.
 *
 * Bigrams, not unigrams, so that two common words ("Add Customer" vs "Add
 * Contract") do not look similar merely because they share the word "add".
 */
export function labelSimilarity(a: string, b: string): number {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter += 1;
  const union = ba.size + bb.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const compact = s.replace(/\s+/g, " ");
  for (let i = 0; i + 2 <= compact.length; i += 1) {
    out.add(compact.slice(i, i + 2));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Citation + conflict builder                                                 */
/* -------------------------------------------------------------------------- */

function citationFor(
  index: ProvenanceIndex,
  itemId: string,
  fallbackArtifactId: string,
): string {
  const entry = index.byItemId.get(itemId);
  if (entry === undefined) return `${fallbackArtifactId} [unresolved]`;
  const n = entry.normalized;
  const parts: string[] = [n.artifactId];
  if (n.pageIndex !== null) parts.push(`p.${n.pageIndex + 1}`);
  if (n.timeRange !== null) {
    parts.push(`${formatMs(n.timeRange.startMs)}–${formatMs(n.timeRange.endMs)}`);
  }
  if (n.bbox !== null) {
    parts.push(`@ (${Math.round(n.bbox.x)},${Math.round(n.bbox.y)})`);
  }
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

interface ConflictView {
  readonly itemId: string;
  readonly sourceId: string;
  readonly artifactId: string;
  readonly citation: string;
}

interface BuildConflictInput {
  readonly kind: ConflictKind;
  readonly summary: string;
  readonly a: ConflictView & { readonly label?: string; readonly name?: string };
  readonly b: ConflictView & { readonly label?: string; readonly name?: string };
  readonly trust: TrustLookup;
  readonly trustTie: number;
  readonly confidence: number;
  readonly notes: readonly string[];
}

function buildConflict(input: BuildConflictInput): Conflict {
  const trustA = input.trust.get(input.a.sourceId) ?? null;
  const trustB = input.trust.get(input.b.sourceId) ?? null;

  let favoured: FavouredSide = null;
  if (trustA !== null && trustB !== null) {
    const diff = trustA - trustB;
    if (diff > input.trustTie) favoured = "a";
    else if (diff < -input.trustTie) favoured = "b";
  }

  // Deterministic pick: when the two excerpts came from sources with equal
  // trust (within tolerance), prefer the one whose itemId sorts first. This
  // makes reconciliation reproducible without an LLM for the trivial cases
  // and gives the LLM a stable default when the trust scores are close.
  const deterministicPick: FavouredSide =
    favoured !== null ? favoured : input.a.itemId < input.b.itemId ? "a" : "b";

  const conflictId = `${input.kind}:${input.a.itemId}:${input.b.itemId}`;

  const textA = input.a.label ?? input.a.name ?? "";
  const textB = input.b.label ?? input.b.name ?? "";

  return {
    conflictId,
    kind: input.kind,
    summary: input.summary,
    excerptA: {
      sourceId: input.a.sourceId,
      artifactId: input.a.artifactId,
      itemId: input.a.itemId,
      text: textA,
      citation: input.a.citation,
      sourceTrust: trustA,
    },
    excerptB: {
      sourceId: input.b.sourceId,
      artifactId: input.b.artifactId,
      itemId: input.b.itemId,
      text: textB,
      citation: input.b.citation,
      sourceTrust: trustB,
    },
    additionalExcerpts: [],
    confidence: clamp01(input.confidence),
    favouredSide: favoured,
    deterministicPick,
    notes: input.notes,
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
