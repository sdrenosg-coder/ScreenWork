/**
 * Zipy AI — long-form: social media post (content-generation, long-form batch 1).
 *
 * Extracts the *key points* of a workflow and renders them as a short social
 * post for one of the supported channels. A social post is not a tutorial:
 * it is a teaser that names the goal, states the payoff and points the
 * reader at the full guide. The composer never invents statistics,
 * customer quotes, links or hashtags with factual claims; every claim is
 * derived from the plan, the goal, or the caller-supplied artefacts.
 *
 * Channel differences are expressed as `SocialChannelProfile`:
 *   - the maximum body length (character budget, not word budget),
 *   - the acceptable hashtag count,
 *   - whether a link line is expected,
 *   - the recommended tone register.
 *
 * Where a field is missing from the inputs the composer records a
 * `SocialGap` rather than inventing one. The composer is pure.
 *
 * Output shape (`SocialPost`) is versioned for the export layer.
 */

import type { Plan, PlanStep } from "@zipy/synth/stepSequence";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SocialErrorCode = "invalid-input" | "no-goal" | "unknown-channel";

export class SocialError extends Error {
  readonly code: SocialErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SocialErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Channels                                                                    */
/* -------------------------------------------------------------------------- */

export const SOCIAL_CHANNELS = [
  "linkedin",
  "x",
  "facebook",
  "instagram",
  "mastodon",
  "threads",
  "bluesky",
] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

export interface SocialChannelProfile {
  readonly channel: SocialChannel;
  /** Hard character budget for the body (excluding the link line). */
  readonly bodyBudget: number;
  /** Recommended hashtag count range; the composer targets the lower bound. */
  readonly hashtagRange: readonly [number, number];
  /** Whether the channel conventionally shows a link preview. */
  readonly expectsLink: boolean;
  /** Human-readable tone register for the LLM directive block. */
  readonly register: string;
}

const CHANNEL_PROFILES: Readonly<Record<SocialChannel, SocialChannelProfile>> =
  Object.freeze({
    linkedin: {
      channel: "linkedin",
      bodyBudget: 1300,
      hashtagRange: [3, 5],
      expectsLink: true,
      register: "professional, insight-led, first person plural ('we')",
    },
    x: {
      channel: "x",
      bodyBudget: 240,
      hashtagRange: [1, 3],
      expectsLink: true,
      register: "terse, direct, sentence fragments acceptable",
    },
    facebook: {
      channel: "facebook",
      bodyBudget: 500,
      hashtagRange: [1, 3],
      expectsLink: true,
      register: "warm, second person ('you')",
    },
    instagram: {
      channel: "instagram",
      bodyBudget: 800,
      hashtagRange: [5, 10],
      expectsLink: false,
      register: "visual-first, second person, one emoji per paragraph at most",
    },
    mastodon: {
      channel: "mastodon",
      bodyBudget: 480,
      hashtagRange: [2, 4],
      expectsLink: true,
      register: "conversational, no marketing voice, hashtags inline",
    },
    threads: {
      channel: "threads",
      bodyBudget: 480,
      hashtagRange: [0, 2],
      expectsLink: false,
      register: "casual, second person, short sentences",
    },
    bluesky: {
      channel: "bluesky",
      bodyBudget: 290,
      hashtagRange: [0, 2],
      expectsLink: true,
      register: "conversational, precise, no marketing voice",
    },
  });

export function getSocialChannelProfile(channel: SocialChannel): SocialChannelProfile {
  const profile = CHANNEL_PROFILES[channel];
  if (profile === undefined) {
    throw new SocialError(`Unknown social channel "${String(channel)}".`, "unknown-channel", {
      channel,
    });
  }
  return profile;
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface SocialPost {
  readonly version: "social/1";
  readonly channel: SocialChannel;
  /** The post body, already trimmed to fit the channel budget. */
  readonly body: string;
  /** Hashtags without a leading '#', in the order they should appear. */
  readonly hashtags: readonly string[];
  /** Optional link line; null when the channel does not expect one or none was supplied. */
  readonly link: string | null;
  /** Character count of `body`; the reviewer uses this to verify the budget. */
  readonly bodyLength: number;
  /** Headline used in the caller's UI so the reviewer can find it later. */
  readonly headline: string;
  /** Declared gaps for the reviewer. */
  readonly gaps: readonly SocialGap[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface SocialGap {
  readonly field: "headline" | "body" | "link" | "hashtags";
  readonly reason:
    | "no-source"
    | "no-goal"
    | "no-plan-steps"
    | "channel-has-no-link"
    | "no-hashtags";
  readonly detail: string;
}

export interface SocialInputs {
  readonly plan: Plan;
  readonly channel: SocialChannel;
  /** Optional title artefact from the core-writing layers. */
  readonly title?: string | null;
  /** Optional one-line summary; used as the lede. */
  readonly summary?: string | null;
  /**
   * Optional key-point bullets supplied by the caller. When absent the
   * composer derives candidate points from the plan's goal and steps.
   */
  readonly keyPoints?: readonly string[];
  /** Optional link. Never invented; when absent and the channel expects one a gap is recorded. */
  readonly link?: string | null;
  /** Caller-supplied hashtags; when absent, tags derived from the title/goal are used. */
  readonly hashtags?: readonly string[];
  /** Optional call-to-action sentence; appended verbatim when supplied. */
  readonly callToAction?: string | null;
  /**
   * Optional style directives block (from `buildStyleDirectives`). Echoed
   * into the payload so a reviewer can see what shaped the post.
   */
  readonly styleDirectives?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function composeSocialPost(inputs: SocialInputs): SocialPost {
  if (inputs === null || typeof inputs !== "object") {
    throw new SocialError("composeSocialPost requires an inputs object.", "invalid-input");
  }
  const plan = inputs.plan;
  if (plan === null || typeof plan !== "object") {
    throw new SocialError("A plan object is required.", "invalid-input");
  }
  const goalRaw = (plan as { goal?: unknown }).goal;
  if (typeof goalRaw !== "string" || goalRaw.trim().length === 0) {
    throw new SocialError("The plan does not expose a goal.", "no-goal");
  }
  const goal = goalRaw.trim();
  const profile = getSocialChannelProfile(inputs.channel);
  const gaps: SocialGap[] = [];

  const steps = readSteps(plan);

  // Headline
  const headline = nonEmpty(inputs.title) ?? defaultHeadline(goal);
  if (inputs.title === undefined || inputs.title === null) {
    gaps.push({
      field: "headline",
      reason: "no-source",
      detail: "No title artefact was supplied; a deterministic headline was used.",
    });
  }

  // Key points
  const keyPoints = (() => {
    const fromCaller = pruneStrings(inputs.keyPoints ?? []);
    if (fromCaller.length > 0) return fromCaller;
    if (steps.length === 0) {
      gaps.push({
        field: "body",
        reason: "no-plan-steps",
        detail: "No key points or plan steps were available; the body states the goal only.",
      });
      return [];
    }
    gaps.push({
      field: "body",
      reason: "no-source",
      detail: "No key points were supplied; the composer derived candidate points from the plan.",
    });
    return steps.slice(0, 4).map((s) => defaultKeyPoint(s.planStep));
  })();

  // Body
  const summary = nonEmpty(inputs.summary);
  if (summary === null) {
    gaps.push({
      field: "body",
      reason: "no-source",
      detail: "No summary artefact was supplied; the body uses a deterministic lede.",
    });
  }
  const lede = summary ?? defaultLede(goal);
  const cta = nonEmpty(inputs.callToAction);
  const body = fitBody(
    profile,
    lede,
    keyPoints,
    cta,
  );

  // Link
  const link = nonEmpty(inputs.link);
  if (link === null && profile.expectsLink) {
    gaps.push({
      field: "link",
      reason: "no-source",
      detail: `The ${profile.channel} channel conventionally includes a link, but none was supplied.`,
    });
  }
  if (link !== null && !profile.expectsLink) {
    gaps.push({
      field: "link",
      reason: "channel-has-no-link",
      detail: `A link was supplied but ${profile.channel} posts do not conventionally carry one; the link is recorded but not placed in the body.`,
    });
  }

  // Hashtags
  const hashtags = (() => {
    const explicit = pruneStrings(inputs.hashtags ?? []);
    const source = explicit.length > 0 ? explicit : deriveHashtags(headline, goal);
    if (source.length === 0 && profile.hashtagRange[0] > 0) {
      gaps.push({
        field: "hashtags",
        reason: "no-hashtags",
        detail: "No hashtags were supplied and none could be derived; the post has no hashtags.",
      });
    }
    return source.map((t) => normaliseHashtag(t)).filter((t) => t.length > 0).slice(0, profile.hashtagRange[1]);
  })();

  return {
    version: "social/1",
    channel: profile.channel,
    body,
    hashtags,
    link: profile.expectsLink ? link : null,
    bodyLength: body.length,
    headline,
    gaps,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Render the post as plain text suitable for the clipboard. The link is
 * placed on its own line at the end (per channel convention for every
 * profile that expects one).
 */
export function renderSocialPostText(post: SocialPost): string {
  const parts: string[] = [post.body];
  if (post.hashtags.length > 0) {
    parts.push(post.hashtags.map((t) => `#${t}`).join(" "));
  }
  if (post.link !== null) {
    parts.push(post.link);
  }
  return parts.join("\n\n").trimEnd() + "\n";
}

export function buildSocialDirectives(profile: SocialChannelProfile): string {
  return [
    `You are writing a ${profile.channel} post announcing a workflow guide.`,
    `Channel budget: at most ${profile.bodyBudget} characters for the body (excluding hashtags and link).`,
    `Channel register: ${profile.register}.`,
    `Hashtag conventions: target ${profile.hashtagRange[0]}–${profile.hashtagRange[1]} hashtags; they must be topical, not vanity.`,
    profile.expectsLink
      ? "The post ends with a link on its own line; the workspace supplies the link and you must use it verbatim."
      : "Do not include a link; this channel does not surface link previews.",
    "Do not invent statistics, customer quotes, awards, version numbers, release dates or URLs.",
    "Do not promise an outcome the plan does not support. Do not use the word 'simply'.",
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

function defaultHeadline(goal: string): string {
  const stripped = goal.replace(/^how\s+to\s+/i, "").trim();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function defaultLede(goal: string): string {
  const stripped = goal.replace(/^how\s+to\s+/i, "").trim();
  return `A new walkthrough covers how to ${stripped.charAt(0).toLowerCase() + stripped.slice(1)}.`;
}

function defaultKeyPoint(step: PlanStep): string {
  const name = step.target !== null && step.target.name.trim().length > 0 ? step.target.name.trim() : null;
  switch (step.action) {
    case "click":
      return name !== null ? `Click ${name}` : "Click the next control";
    case "type":
      return name !== null ? `Fill in ${name}` : "Fill in the next field";
    case "select":
      return name !== null ? `Choose from ${name}` : "Choose the next option";
    case "navigate":
      return "Move to the next page";
    case "scroll":
      return "Scroll to continue";
    default:
      return name !== null ? `Interact with ${name}` : "Continue the workflow";
  }
}

/**
 * Assemble the body under the channel budget. The budget is applied to
 * characters — a social composer's readers care about the visible length,
 * not the word count. When the assembled body exceeds the budget, drop the
 * least-important subsection first (key points), then truncate the lede at
 * a word boundary as a last resort.
 */
function fitBody(
  profile: SocialChannelProfile,
  lede: string,
  keyPoints: readonly string[],
  cta: string | null,
): string {
  const build = (lead: string, points: readonly string[], closing: string | null): string => {
    const parts: string[] = [lead];
    if (points.length > 0) parts.push(points.map((p) => `• ${p}`).join("\n"));
    if (closing !== null) parts.push(closing);
    return parts.join("\n\n");
  };

  let points = keyPoints.slice();
  let body = build(lede, points, cta);
  while (body.length > profile.bodyBudget && points.length > 0) {
    points = points.slice(0, points.length - 1);
    body = build(lede, points, cta);
  }
  if (body.length <= profile.bodyBudget) return body;

  // Even the lede is too long; truncate at a word boundary.
  const hardCap = profile.bodyBudget;
  const cut = lede.slice(0, hardCap);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > hardCap * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return trimmed;
}

function deriveHashtags(headline: string, goal: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const consider = (s: string): void => {
    for (const token of s.split(/\s+/)) {
      const cleaned = token.replace(/[^\p{L}\p{N}]/gu, "");
      if (cleaned.length < 4) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
    }
  };
  consider(headline);
  consider(goal);
  return out.slice(0, 6);
}

/**
 * Normalise a hashtag to the characters that survive in every supported
 * channel: letters, digits and underscores. Rejects an empty result so
 * callers do not ship a bare '#'.
 */
function normaliseHashtag(raw: string): string {
  const trimmed = raw.replace(/^#+/, "").replace(/\s+/g, "");
  const cleaned = trimmed.replace(/[^\p{L}\p{N}_]/gu, "");
  return cleaned;
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
  CHANNEL_PROFILES,
  CHANNEL_PROFILES_COUNT: Object.keys(CHANNEL_PROFILES).length,
  defaultHeadline,
  defaultLede,
  defaultKeyPoint,
  fitBody,
  deriveHashtags,
  normaliseHashtag,
  pruneStrings,
});
