/**
 * Zipy AI — structured content: callout boxes (content-generation, structured batch 2).
 *
 * Collects the tips, warnings and notes that the core-writing layers already
 * produced (and any workspace-supplied notes) and turns them into styled
 * callout boxes. A callout is a small, self-describing record:
 *
 *   { kind: "tip" | "warning" | "note" | "info" | "danger",
 *     title, body, anchor: { sectionId?, stepId?, stepIndex? } }
 *
 * `anchor` tells the export layer exactly where in the guide the callout
 * should appear (next to a step, or in a named section). The composer never
 * invents a tip, a warning or a note: every callout's `body` is supplied
 * verbatim by the caller (which in practice means the `tipsWarnings`
 * artefact from `@zipy/content`). Where a callout kind has no source data,
 * a `CalloutGap` is recorded.
 *
 * Output shape (`CalloutSet`) is versioned for the export layer.
 */

import type { Plan } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type CalloutErrorCode = "invalid-input";

export class CalloutError extends Error {
  readonly code: CalloutErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: CalloutErrorCode,
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

export const CALLOUT_KINDS = ["tip", "warning", "note", "info", "danger"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/**
 * Where a callout attaches. Exactly one of `stepId` or `sectionId` is set
 * on a well-formed callout; the composer enforces this.
 */
export interface CalloutAnchor {
  /** Attach next to a specific plan step. */
  readonly stepId: string | null;
  /** 1-based step index for display and ordering. Null when section-anchored. */
  readonly stepIndex: number | null;
  /** Attach to a named section (e.g. "prerequisites", "faq"). */
  readonly sectionId: string | null;
}

export interface Callout {
  readonly id: string;
  readonly kind: CalloutKind;
  /** Short heading; the export layer styles it as the callout's title line. */
  readonly title: string;
  /** Body text. Never empty. */
  readonly body: string;
  readonly anchor: CalloutAnchor;
}

export interface CalloutGap {
  readonly kind: CalloutKind;
  readonly reason: "no-source";
  readonly detail: string;
}

export interface CalloutSet {
  readonly version: "callouts/1";
  readonly callouts: readonly Callout[];
  readonly gaps: readonly CalloutGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

/**
 * A caller-supplied callout for a section, or an override of a
 * step-derived one. Section callouts are always emitted with the caller's
 * kind; step-derived callouts are emitted from `tipsWarnings`.
 */
export interface AmbiguousCalloutInput {
  readonly kind: CalloutKind;
  readonly title?: string | null;
  readonly body: string;
  /** Attach to a plan step. */
  readonly stepId?: string | null;
  /** Attach to a named section. */
  readonly sectionId?: string | null;
}

export interface CalloutInputs {
  /**
   * Optional plan; when absent the composer still accepts section-level
   * callouts. Supplying the plan lets step-anchored callouts carry their
   * 1-based index.
   */
  readonly plan?: Plan | null;
  /** Per-step tips and warnings from `@zipy/content/tipsWarnings`. */
  readonly tipsWarnings?: Readonly<
    Record<string, { readonly tips: readonly string[]; readonly warnings: readonly string[] }>
  >;
  /** Additional section-level or caller-owned callouts. */
  readonly extraCallouts?: readonly AmbiguousCalloutInput[];
  /**
   * Optional override for whether to emit `note` callouts when neither a
   * tip nor a warning exists on a step. Defaults to false — the composer
   * does not invent notes.
   */
  readonly synthesiseNotesForSteps?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeCallouts(inputs: CalloutInputs): CalloutSet {
  if (inputs === null || typeof inputs !== "object") {
    throw new CalloutError("composeCallouts requires an inputs object.", "invalid-input");
  }
  const gaps: CalloutGap[] = [];
  const callouts: Callout[] = [];
  const idSeen = new Set<string>();

  // Build a plan-step index so a step-anchored callout can carry the index.
  const stepIndex = new Map<string, number>();
  const plan = inputs.plan ?? null;
  if (plan !== null && typeof plan === "object") {
    const raw = (plan as { steps?: unknown }).steps;
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 1) {
        const s = raw[i];
        if (s === null || typeof s !== "object") continue;
        const id = (s as { id?: unknown }).id;
        if (typeof id === "string" && id.length > 0) stepIndex.set(id, i + 1);
      }
    }
  }

  // ------------------------------------------------- step tips/warnings ---
  const tipsWarnings = inputs.tipsWarnings ?? {};
  const stepIds = Object.keys(tipsWarnings).sort((a, b) => {
    const ai = stepIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = stepIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  for (const stepId of stepIds) {
    const entry = tipsWarnings[stepId];
    if (entry === undefined) continue;
    const index = stepIndex.get(stepId) ?? null;
    for (let i = 0; i < entry.tips.length; i += 1) {
      const body = typeof entry.tips[i] === "string" ? entry.tips[i].trim() : "";
      if (body.length === 0) continue;
      const id = makeId("tip", stepId, i + 1, idSeen);
      callouts.push({
        id,
        kind: "tip",
        title: "Tip",
        body,
        anchor: { stepId, stepIndex: index, sectionId: null },
      });
    }
    for (let i = 0; i < entry.warnings.length; i += 1) {
      const body = typeof entry.warnings[i] === "string" ? entry.warnings[i].trim() : "";
      if (body.length === 0) continue;
      const id = makeId("warning", stepId, i + 1, idSeen);
      callouts.push({
        id,
        kind: "warning",
        title: "Warning",
        body,
        anchor: { stepId, stepIndex: index, sectionId: null },
      });
    }
    if (
      inputs.synthesiseNotesForSteps === true &&
      entry.tips.length === 0 &&
      entry.warnings.length === 0
    ) {
      // A caller opted in; still a caller-owned synthesised note, not an
      // invented claim. The body only states what the guide itself says.
      const id = makeId("note", stepId, 1, idSeen);
      callouts.push({
        id,
        kind: "note",
        title: "Note",
        body: "No tips or warnings were recorded for this step.",
        anchor: { stepId, stepIndex: index, sectionId: null },
      });
    }
  }

  // -------------------------------------------------- extra callouts ----
  for (const extra of inputs.extraCallouts ?? []) {
    if (extra === null || typeof extra !== "object") continue;
    if (!isCalloutKind(extra.kind)) continue;
    const body = typeof extra.body === "string" ? extra.body.trim() : "";
    if (body.length === 0) continue;
    const stepId = typeof extra.stepId === "string" && extra.stepId.trim().length > 0
      ? extra.stepId.trim()
      : null;
    const sectionId = typeof extra.sectionId === "string" && extra.sectionId.trim().length > 0
      ? extra.sectionId.trim()
      : null;
    if (stepId === null && sectionId === null) {
      gaps.push({
        kind: extra.kind,
        reason: "no-source",
        detail: `A ${extra.kind} callout was supplied without a stepId or sectionId anchor.`,
      });
      continue;
    }
    const index = stepId !== null ? stepIndex.get(stepId) ?? null : null;
    const title = typeof extra.title === "string" && extra.title.trim().length > 0
      ? extra.title.trim()
      : defaultTitleFor(extra.kind);
    const id = makeId(extra.kind, stepId ?? sectionId ?? "x", callouts.length + 1, idSeen);
    callouts.push({
      id,
      kind: extra.kind,
      title,
      body,
      anchor: { stepId, stepIndex: index, sectionId },
    });
  }

  // ------------------------------------------------------------------ gaps
  if (callouts.length === 0) {
    gaps.push({
      kind: "tip",
      reason: "no-source",
      detail: "No tips or warnings were supplied and no caller-owned callouts were added.",
    });
  }

  return {
    version: "callouts/1",
    callouts: sortCallouts(callouts),
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the callouts as Markdown block quotes with a bold kind label. The
 * export layer may instead render each callout inside its own styled
 * container; the markdown form is the terminal-friendly fallback.
 */
export function renderCalloutsMarkdown(set: CalloutSet): string {
  const parts: string[] = [];
  for (const c of set.callouts) {
    const label = labelFor(c.kind);
    parts.push(`> **${label} — ${c.title}**`);
    parts.push(`> ${c.body}`);
    parts.push("");
  }
  if (set.gaps.length > 0) {
    parts.push("---");
    parts.push("");
    parts.push("_Callout gaps recorded by Zipy AI (AI-generated):_");
    parts.push("");
    for (const gap of set.gaps) {
      parts.push(`- **${gap.kind}** — ${gap.detail}`);
    }
    parts.push("");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function buildCalloutsDirectives(): string {
  return [
    "You are producing callout boxes for an already approved workflow guide.",
    "Supported callout kinds: tip, warning, note, info, danger.",
    "Each callout has a short title and one-to-three sentence body, and is anchored either to a specific step or to a named section.",
    "Only produce a callout when the plan and its artefacts support one; never invent warnings about irreversible actions or security implications the sources do not mention.",
    "Warnings refer to consequences the sources actually describe. Tips help a reader avoid a known pitfall. Notes add clarification only when the sources already contain the clarification.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function isCalloutKind(v: unknown): v is CalloutKind {
  return (
    v === "tip" ||
    v === "warning" ||
    v === "note" ||
    v === "info" ||
    v === "danger"
  );
}

function defaultTitleFor(kind: CalloutKind): string {
  switch (kind) {
    case "tip": return "Tip";
    case "warning": return "Warning";
    case "note": return "Note";
    case "info": return "For your information";
    case "danger": return "Important";
  }
}

function labelFor(kind: CalloutKind): string {
  switch (kind) {
    case "tip": return "TIP";
    case "warning": return "WARNING";
    case "note": return "NOTE";
    case "info": return "INFO";
    case "danger": return "DANGER";
  }
}

function makeId(prefix: string, suffix: string, n: number, seen: Set<string>): string {
  const base = `${prefix}-${slugifyId(suffix)}-${n}`;
  let id = base;
  let counter = 2;
  while (seen.has(id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  seen.add(id);
  return id;
}

function slugifyId(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : "x";
}

/**
 * Deterministic order: section-anchored callouts first (alphabetical by
 * sectionId), then step-anchored callouts ordered by step index, then by
 * kind priority (danger, warning, tip, note, info), then by insertion.
 */
function sortCallouts(callouts: readonly Callout[]): Callout[] {
  const kindRank: Record<CalloutKind, number> = {
    danger: 0,
    warning: 1,
    tip: 2,
    note: 3,
    info: 4,
  };
  return callouts.slice().sort((a, b) => {
    const aSec = a.anchor.sectionId !== null ? 0 : 1;
    const bSec = b.anchor.sectionId !== null ? 0 : 1;
    if (aSec !== bSec) return aSec - bSec;
    if (aSec === 0) {
      const sa = a.anchor.sectionId ?? "";
      const sb = b.anchor.sectionId ?? "";
      if (sa !== sb) return sa < sb ? -1 : 1;
    } else {
      const ai = a.anchor.stepIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.anchor.stepIndex ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
    }
    const kr = kindRank[a.kind] - kindRank[b.kind];
    if (kr !== 0) return kr;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  isCalloutKind,
  defaultTitleFor,
  labelFor,
  slugifyId,
  sortCallouts,
});
