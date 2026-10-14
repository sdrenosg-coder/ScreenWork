/**
 * Zipy AI — long-form: email announcement (content-generation, long-form batch 1).
 *
 * Renders a workflow as an announcement email with a subject line, a short
 * preheader, a plain-text body, and a call to action. The composer never
 * invents recipients, links, version numbers or release dates. When the
 * caller supplies a link or a call-to-action sentence the composer uses
 * them verbatim; when it does not, the composer records a gap and leaves
 * the corresponding section out rather than fabricating content.
 *
 * The email body is *plain text*. Rich HTML rendering is the export layer's
 * responsibility (it wraps the plain text in the workspace brand template
 * so the same content can be sent to a text-only client and still read
 * correctly). This module produces no HTML.
 *
 * Output shape (`EmailAnnouncement`) is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type EmailErrorCode = "invalid-input" | "no-goal";

export class EmailError extends Error {
  readonly code: EmailErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: EmailErrorCode,
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

export interface EmailSection {
  readonly kind: "lede" | "summary" | "list" | "quote" | "cta" | "signoff";
  /** Prose for `lede`/`summary`/`quote`/`cta`/`signoff`; a label for `list`. */
  readonly text: string;
  /** Only set on `list` blocks. */
  readonly items?: readonly string[];
}

export interface EmailAnnouncement {
  readonly version: "email/1";
  /** Subject line, at most 78 characters (RFC 5322 header convention). */
  readonly subject: string;
  /** Preheader text shown by most clients; at most 140 characters. */
  readonly preheader: string;
  /** Body sections in the order they should be rendered. */
  readonly sections: readonly EmailSection[];
  /** Optional single call-to-action URL. Null when none was supplied. */
  readonly callToActionUrl: string | null;
  /** Optional label for the CTA link. Null when no CTA was supplied. */
  readonly callToActionLabel: string | null;
  /** Plain-text rendering of the whole email, ready for transport. */
  readonly plainText: string;
  /** Declared gaps for the reviewer. */
  readonly gaps: readonly EmailGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface EmailGap {
  readonly field: "subject" | "summary" | "link" | "signoff" | "callToAction";
  readonly reason: "no-source" | "no-goal" | "no-link" | "no-signoff";
  readonly detail: string;
}

export interface EmailInputs {
  readonly plan: Plan;
  /** Optional title artefact; falls back to a deterministic subject. */
  readonly title?: string | null;
  /** Optional one-line summary; used as the lede sentence. */
  readonly summary?: string | null;
  /**
   * Optional body bullets. When absent and a plan has steps, the composer
   * derives candidates from the steps.
   */
  readonly keyPoints?: readonly string[];
  /** Optional single call-to-action URL. Never invented. */
  readonly callToActionUrl?: string | null;
  /** Optional label for the CTA link. When absent the composer uses "Read the guide". */
  readonly callToActionLabel?: string | null;
  /** Optional sign-off name and line. */
  readonly signOff?: string | null;
  /**
   * Optional style directives (from `buildStyleDirectives`). Echoed into
   * the payload for the reviewer.
   */
  readonly styleDirectives?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeEmailAnnouncement(inputs: EmailInputs): EmailAnnouncement {
  if (inputs === null || typeof inputs !== "object") {
    throw new EmailError("composeEmailAnnouncement requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new EmailError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new EmailError("The plan does not expose a goal.", "no-goal");
  }
  const goal = goalRaw.trim();
  const gaps: EmailGap[] = [];

  // Subject
  const title = nonEmpty(inputs.title);
  const subject = title !== null ? truncateForHeader(title, 78) : deterministicSubject(goal);
  if (title === null) {
    gaps.push({
      field: "subject",
      reason: "no-source",
      detail: "No title artefact was supplied; a deterministic subject line was used.",
    });
  }

  // Summary / lede
  const summary = nonEmpty(inputs.summary);
  if (summary === null) {
    gaps.push({
      field: "summary",
      reason: "no-source",
      detail: "No summary artefact was supplied; the lede states the goal only.",
    });
  }
  const lede = summary ?? `A new guide covers how to ${goal.replace(/^how\s+to\s+/i, "")}.`;

  // Preheader — a hard cap. When the lede is too long we take its head.
  const preheader = truncateForHeader(lede, 140);

  // Key points
  const steps = readSteps(plan);
  const keyPoints = (() => {
    const fromCaller = pruneStrings(inputs.keyPoints ?? []);
    if (fromCaller.length > 0) return fromCaller;
    if (steps.length === 0) return [];
    return steps.slice(0, 6).map((s) => defaultKeyPoint(s.planStep));
  })();

  // CTA
  const ctaUrl = nonEmpty(inputs.callToActionUrl);
  const ctaLabel = nonEmpty(inputs.callToActionLabel) ?? "Read the guide";
  if (ctaUrl === null) {
    gaps.push({
      field: "link",
      reason: "no-link",
      detail: "No call-to-action URL was supplied; the email omits the CTA.",
    });
  }

  // Sign-off
  const signOff = nonEmpty(inputs.signOff);
  if (signOff === null) {
    gaps.push({
      field: "signoff",
      reason: "no-signoff",
      detail: "No sign-off was supplied; the email ends without a signature.",
    });
  }

  // Section composition
  const sections: EmailSection[] = [];
  sections.push({ kind: "lede", text: lede });
  if (keyPoints.length > 0) {
    sections.push({ kind: "list", text: "What the guide covers", items: keyPoints });
  }
  if (ctaUrl !== null) {
    sections.push({ kind: "cta", text: `${ctaLabel}: ${ctaUrl}` });
  }
  if (signOff !== null) {
    sections.push({ kind: "signoff", text: signOff });
  }

  const plainText = renderPlainText(sections);

  return {
    version: "email/1",
    subject,
    preheader,
    sections,
    callToActionUrl: ctaUrl,
    callToActionLabel: ctaUrl !== null ? ctaLabel : null,
    plainText,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the announcement as RFC 5322-safe plain text. The rendered text is
 * what a client shows in a text-only mailbox; a caller building HTML wraps
 * each section in its own template block.
 */
export function renderEmailPlainText(email: EmailAnnouncement): string {
  return email.plainText;
}

export function buildEmailDirectives(): string {
  return [
    "You are writing a plain-text email announcing a new workflow guide.",
    "Structure exactly: one lede sentence, an optional bulleted list of what the guide covers, an optional call-to-action line, an optional sign-off.",
    "The subject line is at most 78 characters and mentions the workflow, not the product.",
    "The preheader is the first sentence of the lede, at most 140 characters.",
    "Do not invent release dates, version numbers, seat counts, pricing, or recipient names.",
    "Do not promise outcomes the sources do not support. Do not use the word 'simply'.",
    "When the workspace supplies a call-to-action URL or label, use them verbatim and do not modify them.",
    "Subject every generated string to the workspace style, terminology and brand-voice directives supplied alongside this block.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface IndexedStep {
  readonly id: string;
  readonly index: number;
  readonly planStep: PlanStep;
}

function readSteps(plan: Plan): readonly IndexedStep[] {
  const raw = (plan as { steps?: unknown }).steps;
  if (!Array.isArray(raw)) return [];
  const out: IndexedStep[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const step = raw[i];
    if (step === null || typeof step !== "object") continue;
    const s = step as PlanStep;
    const id = typeof s.id === "string" && s.id.length > 0 ? s.id : `step-${i + 1}`;
    out.push({ id, index: i + 1, planStep: s });
  }
  return out;
}

function deterministicSubject(goal: string): string {
  const stripped = goal.replace(/^how\s+to\s+/i, "").trim();
  const lead = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return truncateForHeader(`New guide: ${lead}`, 78);
}

function defaultKeyPoint(step: PlanStep): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  switch (step.action) {
    case "click":
      return name !== null ? `Click ${name}` : "Click the next control";
    case "type":
      return name !== null ? `Enter the value in ${name}` : "Enter the value in the field";
    case "select":
      return name !== null ? `Choose from ${name}` : "Choose the required option";
    case "navigate":
      return "Move to the next page";
    case "scroll":
      return "Scroll to continue";
    default:
      return name !== null ? `Interact with ${name}` : "Continue the workflow";
  }
}

function renderPlainText(sections: readonly EmailSection[]): string {
  const blocks: string[] = [];
  for (const section of sections) {
    switch (section.kind) {
      case "lede":
      case "summary":
      case "quote":
      case "cta":
      case "signoff":
        blocks.push(section.text);
        break;
      case "list": {
        const items = section.items ?? [];
        if (items.length === 0) break;
        blocks.push(items.map((i) => `- ${i}`).join("\n"));
        break;
      }
    }
  }
  return blocks.join("\n\n").trimEnd() + "\n";
}

function truncateForHeader(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

function pruneStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = typeof v === "string" ? v.trim() : "";
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  deterministicSubject,
  defaultKeyPoint,
  renderPlainText,
  truncateForHeader,
  pruneStrings,
});
