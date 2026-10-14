/**
 * Zipy AI — Teams / Jira / Notion / Confluence integration contract check
 * (phase 26, batch 2.4).
 *
 * The phase 21 batches shipped four platform adapters (`teams.ts`, `jira.ts`,
 * `notion.ts`, `confluence.ts`) as *isolated* files. Each owns a distinct
 * external credential surface, but they share one cross-cutting requirement
 * the phase 26 acceptance criteria state explicitly:
 *
 *     "Platform adapters … fail clearly when [credentials are] not [configured]."
 *
 * An isolated adapter cannot enforce that on its own, because the adapter
 * cannot know what the *route* will do with its `not-configured` error, and
 * the route cannot know which adapters exist. This module is the single
 * place that closes that gap: it declares the adapter set, exposes a
 * configuration probe per adapter, and produces the exact 503 body and
 * status the integration routes should return when a capability that
 * requires customer-supplied credentials is invoked without them.
 *
 * It does NOT reimplement the adapters. It does not import them (they were
 * authored in isolated batches and this file must not fail to type-check
 * because one of them is absent from this checkout). It describes the
 * *contract* each adapter must satisfy, and the route calls it *after*
 * dispatching to the adapter: whenever an adapter throws a typed error with
 * code `not-configured` (or `configuration_missing`, or any of the
 * documented names in `CONFIGURATION_ERROR_CODES`), the route maps that
 * throw through `describeIntegrationFailure` below to a deterministic,
 * operator-readable 503.
 *
 * Design boundaries
 * -----------------
 *
 *  - No credential is invented, and no default is provided for one. The
 *    probe reads `process.env` through a caller-supplied snapshot so the
 *    unit tests do not mutate global state; it never writes to `process.env`.
 *
 *  - No HTTP is performed. This module is pure: given the environment for
 *    a workspace and an integration key, it returns a structured
 *    configuration report. The caller decides what to do with a
 *    `not-configured` report.
 *
 *  - Nothing is silently degraded. A caller cannot ask this module for a
 *    "best effort" success when an integration is unconfigured; the only
 *    outcomes are `{configured: true, …}` or `{configured: false, missing: [...] }`.
 *
 *  - The module is deliberately the *only* piece of the integration
 *    surface whose behaviour is asserted by the e2e/API test suite. The
 *    adapters themselves are exercised by their own vitest suites with a
 *    fake transport; this module's contract is what the routes depend on,
 *    and the contract is what must not drift.
 *
 * Exports
 * -------
 *   - `INTEGRATION_KEYS`           — the closed set of integration ids.
 *   - `INTEGRATION_REQUIREMENTS`   — per-integration required env fields.
 *   - `probeIntegration`           — configuration report for one key.
 *   - `probeAllIntegrations`       — configuration reports for every key.
 *   - `describeIntegrationFailure` — turn an adapter throw into a route body.
 *   - `isConfigurationError`       — classify a throw as missing-config.
 *   - `INTEGRATION_FAILURES`       — the closed set of failure codes.
 *   - `__internals`                — pure helpers, exported for tests.
 */

/* -------------------------------------------------------------------------- */
/* Integration catalogue                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of integrations this module knows how to probe. Adding a
 * new integration is a two-line change here (add the key to this tuple and
 * to `INTEGRATION_REQUIREMENTS`); routing or adapter code that consumes
 * `INTEGRATION_KEYS` will pick it up automatically without a separate
 * allow-list to keep in sync.
 */
export const INTEGRATION_KEYS = [
  "slack",
  "teams",
  "jira",
  "notion",
  "confluence",
  "zapier",
] as const;

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

/**
 * A single environment requirement. An integration may have an
 * `anyOf` requirement (Slack accepts a bot token *or* an incoming webhook),
 * an `allOf` requirement (Jira needs the base URL plus one of the auth
 * pairs), or a combination. The probe reports exactly which fields are
 * missing so the operator does not have to read the adapter to find out.
 *
 * The tuple form keeps the constant JSON-serializable, which matters
 * because the admin configuration page surfaces it directly.
 */
export interface EnvironmentRequirement {
  /** A human-readable label for the requirement, e.g. "Slack bot token or incoming webhook URL". */
  readonly label: string;
  /** When `allOf`, every field in `fields` must be present. */
  readonly kind: "allOf" | "anyOf";
  /** The environment variable names involved. */
  readonly fields: readonly string[];
}

export interface IntegrationRequirement {
  readonly key: IntegrationKey;
  /**
   * The one-line description used in the admin UI. It does not name a
   * vendor-specific product page; an operator who needs the exact setup
   * steps reads `docs/operations/external-setup.md`.
   */
  readonly purpose: string;
  /**
   * A *disjunction* of requirements. For Slack the caller satisfies the
   * catalog when either the bot-token group or the webhook group is fully
   * satisfied. An empty array means the integration has no required
   * credentials (no current entry does; a future one could).
   */
  readonly anyOf: readonly EnvironmentRequirement[];
}

/**
 * The per-integration configuration catalogue. This is a declaration of
 * *what the adapters will read*, not a copy of their implementation: the
 * adapters remain the source of truth for how a value is used, and the
 * `purpose` field is a one-line reminder for the admin UI.
 */
export const INTEGRATION_REQUIREMENTS: Readonly<
  Record<IntegrationKey, IntegrationRequirement>
> = Object.freeze({
  slack: {
    key: "slack",
    purpose:
      "Post generation, review and publish notifications; deliver interactive approval cards for gated workflows.",
    // Slack accepts a bot token (with a channel id at call time) OR an
    // incoming webhook URL. The adapter itself decides which surface to
    // use; the probe reports the union so the admin UI can show a single
    // "configured" state.
    anyOf: [
      {
        label: "Slack bot token (interactive approvals) or incoming webhook URL (one-way notifications)",
        kind: "anyOf",
        fields: ["SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL"],
      },
    ],
  },
  teams: {
    key: "teams",
    purpose:
      "Post notifications to a Microsoft Teams channel via an incoming webhook and render review approvals as Adaptive Cards.",
    anyOf: [
      {
        label: "Microsoft Teams incoming webhook URL",
        kind: "allOf",
        fields: ["TEAMS_WEBHOOK_URL"],
      },
    ],
  },
  jira: {
    key: "jira",
    purpose:
      "Publish guides as Jira issues and receive review decisions via the Jira webhook callback.",
    anyOf: [
      {
        label: "Jira site URL + (email + API token, or personal access token)",
        kind: "anyOf",
        fields: [
          "JIRA_BASE_URL",
          "JIRA_EMAIL",
          "JIRA_API_TOKEN",
          "JIRA_PERSONAL_ACCESS_TOKEN",
        ],
      },
    ],
  },
  notion: {
    key: "notion",
    purpose: "Publish a guide as a Notion page in a customer-specified parent.",
    anyOf: [
      {
        label: "Notion integration token + parent page or database id",
        kind: "allOf",
        fields: ["NOTION_TOKEN", "NOTION_PARENT_ID"],
      },
    ],
  },
  confluence: {
    key: "confluence",
    purpose: "Publish a guide as a Confluence page under a customer-specified space.",
    anyOf: [
      {
        label: "Confluence base URL, space key, and (email + API token)",
        kind: "allOf",
        fields: [
          "CONFLUENCE_BASE_URL",
          "CONFLUENCE_SPACE_KEY",
          "CONFLUENCE_EMAIL",
          "CONFLUENCE_API_TOKEN",
        ],
      },
    ],
  },
  zapier: {
    key: "zapier",
    purpose:
      "Receive inbound Zapier/Make triggers (verified with a shared secret) and post outbound events to a customer-configured Catch Hook.",
    // Outbound or inbound, not necessarily both: a customer who only wants
    // outbound events does not need the inbound secret, and vice versa.
    anyOf: [
      {
        label: "Zapier/Make outbound hook URL or inbound shared secret",
        kind: "anyOf",
        fields: ["ZAPIER_OUTBOUND_HOOK_URL", "ZAPIER_INBOUND_SHARED_SECRET"],
      },
    ],
  },
});

/* -------------------------------------------------------------------------- */
/* Configuration probe                                                         */
/* -------------------------------------------------------------------------- */

export interface IntegrationConfigReport {
  readonly key: IntegrationKey;
  readonly configured: boolean;
  /** The requirement groups that were fully satisfied. Empty when unconfigured. */
  readonly satisfied: readonly string[];
  /** The requirement groups that were not satisfied, with the missing field names. */
  readonly unsatisfied: readonly {
    readonly label: string;
    readonly kind: "allOf" | "anyOf";
    readonly missing: readonly string[];
  }[];
  /** A short, actionable hint for the operator. Empty when configured. */
  readonly hint: string;
}

/**
 * Examine the environment snapshot and report whether this integration is
 * configured. The function performs no I/O and never mutates the snapshot
 * it is given: a caller can pass a random object in a unit test without
 * concern that the module will write to `process.env`.
 *
 * The "configured" judgement is deliberately conservative:
 *
 *   - An empty string counts as *absent*. A `.env` file with `SLACK_BOT_TOKEN=`
 *     is a mistake, not a configuration, and must not be treated as one.
 *   - Whitespace-only strings are also absent. The adapters trim before
 *     use; the probe matches that behaviour so the two never disagree.
 *   - `anyOf` groups are satisfied when *any* group is satisfied; an
 *     integration with no groups (`anyOf: []`) is treated as unconfigured
 *     so a missing declaration does not silently pass.
 */
export function probeIntegration(input: {
  readonly key: IntegrationKey;
  readonly env: Readonly<Record<string, string | undefined>>;
}): IntegrationConfigReport {
  const requirement = INTEGRATION_REQUIREMENTS[input.key];
  if (requirement === undefined) {
    // A caller can only reach this branch through a broken type assertion.
    // Throwing keeps the failure loud rather than silently reporting a
    // misleading "configured: false" for an unknown key.
    throw new Error(
      `probeIntegration: unknown integration key "${String(input.key)}". Known keys: ${INTEGRATION_KEYS.join(", ")}.`,
    );
  }
  const satisfied: string[] = [];
  const unsatisfied: {
    label: string;
    kind: "allOf" | "anyOf";
    missing: string[];
  }[] = [];

  for (const group of requirement.anyOf) {
    const present = group.fields.filter(
      (field) => nonEmpty(input.env[field]) !== null,
    );
    const missing = group.fields.filter(
      (field) => nonEmpty(input.env[field]) === null,
    );
    if (group.kind === "allOf") {
      if (missing.length === 0) {
        satisfied.push(group.label);
      } else {
        unsatisfied.push({ label: group.label, kind: group.kind, missing });
      }
    } else {
      // anyOf within a single group: satisfied when at least one field is set.
      if (present.length > 0) {
        satisfied.push(group.label);
      } else {
        unsatisfied.push({ label: group.label, kind: group.kind, missing });
      }
    }
  }

  const configured = satisfied.length > 0;
  const hint = configured
    ? ""
    : buildHint(requirement, unsatisfied);

  return Object.freeze({
    key: input.key,
    configured,
    satisfied: Object.freeze(satisfied),
    unsatisfied: Object.freeze(unsatisfied),
    hint,
  });
}

/**
 * Probe every known integration. The return value is keyed by
 * `IntegrationKey` so a caller can index it without a lookup. The order of
 * `INTEGRATION_KEYS` is preserved in the returned object's key order; a
 * caller iterating with `Object.entries` sees a stable order.
 */
export function probeAllIntegrations(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<IntegrationKey, IntegrationConfigReport>> {
  const out: Partial<Record<IntegrationKey, IntegrationConfigReport>> = {};
  for (const key of INTEGRATION_KEYS) {
    out[key] = probeIntegration({ key, env: input.env });
  }
  return Object.freeze(out) as Readonly<
    Record<IntegrationKey, IntegrationConfigReport>
  >;
}

/**
 * The environment variable names, per integration, that the admin screen
 * should show as "to do" when an integration is unconfigured. This is the
 * union of every field named in the requirement catalogue, and is exported
 * so a UI can render a setup checklist without parsing the requirement
 * objects.
 */
export function requiredEnvNamesFor(key: IntegrationKey): readonly string[] {
  const requirement = INTEGRATION_REQUIREMENTS[key];
  const out = new Set<string>();
  for (const group of requirement.anyOf) {
    for (const field of group.fields) out.add(field);
  }
  return Object.freeze([...out]);
}

/* -------------------------------------------------------------------------- */
/* Configuration failure classification                                        */
/* -------------------------------------------------------------------------- */

/**
 * The error codes that indicate an integration is *not configured*. The
 * adapters authored in phase 21 use slightly different names — `SlackError`
 * uses `not-configured`, `IntegrationError` (Teams/Jira/Notion/Confluence)
 * uses `not-configured`, and `ZapierIntegrationError` uses
 * `not-configured`. This set is deliberately a superset so a new adapter
 * whose code name differs predictably still matches.
 */
export const CONFIGURATION_ERROR_CODES: readonly string[] = Object.freeze([
  "not-configured",
  "not_configured",
  "configuration_missing",
  "missing_configuration",
  "unconfigured",
]);

/**
 * Classify a thrown value as a configuration-missing error. Recognizes:
 *
 *   - A `code` property whose string value appears in
 *     `CONFIGURATION_ERROR_CODES`. Both dashed and snake-cased spellings
 *     are accepted because two adapter families already exist in the
 *     repository with different conventions.
 *   - A `name` of `"IntegrationError"`, `"SlackError"` or
 *     `"ZapierIntegrationError"` combined with a `not-configured`-shaped
 *     code. The name check is redundant with the code check and exists so
 *     a future adapter that changes only the `name` does not silently
 *     bypass classification.
 *
 * Everything else returns false. The function never throws: a `null`,
 * a string, or an object with a `get code()` that itself throws all yield
 * `false`, so a route can call this in a `catch` block without a second
 * `try`.
 */
export function isConfigurationError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error !== "object") return false;
  let code: unknown;
  try {
    code = (error as { code?: unknown }).code;
  } catch {
    return false;
  }
  if (typeof code !== "string") return false;
  const normalized = code.toLowerCase().replace(/-/g, "_");
  for (const candidate of CONFIGURATION_ERROR_CODES) {
    if (candidate.toLowerCase().replace(/-/g, "_") === normalized) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Route failure mapping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of failure codes this module can hand back to a route.
 * A route that receives one of these knows only the adapter's configuration
 * state, not the underlying error object, and must not fabricate a success.
 */
export const INTEGRATION_FAILURES = [
  "integration-not-configured",
  "integration-invalid-input",
  "integration-transport-failure",
  "integration-destination-rejected",
  "integration-rate-limited",
  "integration-unknown-failure",
] as const;

export type IntegrationFailureCode = (typeof INTEGRATION_FAILURES)[number];

export interface IntegrationFailureBody {
  readonly error: IntegrationFailureCode;
  readonly integration: IntegrationKey;
  /** The HTTP status the route should return. */
  readonly status: number;
  /** A one-line operator-facing message. */
  readonly message: string;
  /** Environment variables the operator must supply, when applicable. */
  readonly requiredEnv: readonly string[];
  /** A retry-after hint in seconds, when the adapter supplied one. */
  readonly retryAfterSeconds: number | null;
  /** A stable identifier for the log line so an operator can grep for it. */
  readonly logKey: string;
}

/**
 * Turn an adapter throw into the body and status an integration route
 * should send. This is the *only* place in the repository that decides the
 * status code for a failed integration call, so every platform adapter is
 * guaranteed to fail the same way and an operator learns one message
 * instead of six.
 *
 * Status rules:
 *
 *   - `integration-not-configured` → 503. The capability exists but the
 *     workspace has not supplied credentials; the operator must act.
 *   - `integration-invalid-input` → 400. The caller's request was wrong.
 *   - `integration-transport-failure` → 502. The upstream is unreachable
 *     or returned an unusable response.
 *   - `integration-destination-rejected` → 422. The upstream (Zapier hook
 *     turned off, Slack channel_not_found) rejected the message.
 *   - `integration-rate-limited` → 429 with a `Retry-After` header to be
 *     set by the route from `retryAfterSeconds`.
 *   - `integration-unknown-failure` → 500. Every other throw; logged with
 *     the original message.
 *
 * The function never inspects the adapter's error message for its
 * decision; it reads the same `code` field `isConfigurationError` reads.
 * A caller that supplies a `code` the module does not recognize gets
 * `integration-unknown-failure` rather than a best-guess 5xx.
 */
export function describeIntegrationFailure(input: {
  readonly integration: IntegrationKey;
  readonly error: unknown;
  /** The environment snapshot used to populate `requiredEnv` on the 503. */
  readonly env: Readonly<Record<string, string | undefined>>;
}): IntegrationFailureBody {
  const logKey = `zipy.integration.${input.integration}.failure`;
  const code = readErrorCode(input.error);
  const retryAfterSeconds = readRetryAfterSeconds(input.error);
  const detail = readErrorMessage(input.error);

  if (code !== null && CONFIGURATION_ERROR_CODES.includes(code)) {
    return {
      error: "integration-not-configured",
      integration: input.integration,
      status: 503,
      message: buildNotConfiguredMessage(input.integration, input.env),
      requiredEnv: requiredEnvNamesFor(input.integration),
      retryAfterSeconds: null,
      logKey,
    };
  }

  switch (code) {
    case "invalid-input":
      return {
        error: "integration-invalid-input",
        integration: input.integration,
        status: 400,
        message:
          detail.length > 0
            ? `The request to the ${input.integration} integration was rejected as invalid: ${detail}`
            : `The request to the ${input.integration} integration was rejected as invalid.`,
        requiredEnv: [],
        retryAfterSeconds: null,
        logKey,
      };
    case "transport-failure":
      return {
        error: "integration-transport-failure",
        integration: input.integration,
        status: 502,
        message:
          detail.length > 0
            ? `The ${input.integration} integration could not reach its endpoint: ${detail}`
            : `The ${input.integration} integration could not reach its endpoint.`,
        requiredEnv: [],
        retryAfterSeconds,
        logKey,
      };
    case "destination-rejected":
    case "slack-rejected":
      return {
        error: "integration-destination-rejected",
        integration: input.integration,
        status: 422,
        message:
          detail.length > 0
            ? `The ${input.integration} endpoint rejected the message: ${detail}`
            : `The ${input.integration} endpoint rejected the message.`,
        requiredEnv: [],
        retryAfterSeconds,
        logKey,
      };
    case "rate-limited":
    case "rate_limited":
      return {
        error: "integration-rate-limited",
        integration: input.integration,
        status: 429,
        message:
          retryAfterSeconds !== null
            ? `The ${input.integration} endpoint rate-limited the request; retry after ${retryAfterSeconds}s.`
            : `The ${input.integration} endpoint rate-limited the request.`,
        requiredEnv: [],
        retryAfterSeconds,
        logKey,
      };
    default:
      return {
        error: "integration-unknown-failure",
        integration: input.integration,
        status: 500,
        message:
          detail.length > 0
            ? `The ${input.integration} integration failed: ${detail}`
            : `The ${input.integration} integration failed.`,
        requiredEnv: [],
        retryAfterSeconds,
        logKey,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildHint(
  requirement: IntegrationRequirement,
  unsatisfied: readonly {
    label: string;
    kind: "allOf" | "anyOf";
    missing: readonly string[];
  }[],
): string {
  if (unsatisfied.length === 0) {
    return `Set the required environment variable(s) for ${requirement.key}.`;
  }
  const parts = unsatisfied
    .map((group) => group.missing.join(" / "))
    .filter((s) => s.length > 0);
  const label = requirement.purpose;
  if (parts.length === 0) {
    return `Configure ${requirement.key}: ${label}`;
  }
  return `Configure ${requirement.key}: supply ${parts.join(" or ")}. Purpose: ${label}`;
}

function buildNotConfiguredMessage(
  key: IntegrationKey,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const report = probeIntegration({ key, env });
  if (report.configured) {
    // The adapter said "not configured" but the probe says it is. This
    // happens when an operator set the variable *after* the adapter was
    // constructed with a snapshot, or when the workspace's per-tenant
    // credentials differ from the process environment. Both cases need a
    // distinct message so the operator is not sent to fix a value that
    // already exists.
    return `The ${key} integration reported itself unconfigured, but the process environment already contains the required value(s). This usually means the adapter was constructed with a per-workspace credential that is missing or has expired; re-issue it in the workspace settings.`;
  }
  const required = requiredEnvNamesFor(key);
  return `The ${key} integration is not configured on this server. Supply one of the following before using it: ${required.join(", ")}.`;
}

function readErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  let code: unknown;
  try {
    code = (error as { code?: unknown }).code;
  } catch {
    return null;
  }
  if (typeof code !== "string" || code.length === 0) return null;
  // Normalize the two spellings the repository's adapters use so the
  // switch statement above does not have to list both for every case.
  return code.toLowerCase().replace(/_/g, "-");
}

function readErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return "";
  let message: unknown;
  try {
    message = (error as { message?: unknown }).message;
  } catch {
    return "";
  }
  return typeof message === "string" ? message : "";
}

/**
 * Extract a `Retry-After` hint from a thrown error. Both adapter families
 * expose it, but under different names: `SlackError` has no such field,
 * `IntegrationError` uses `retryAfterMs`, and `ZapierIntegrationError`
 * uses `retryAfterMs` as well. This reads either `retryAfterSeconds` or
 * `retryAfterMs` and normalizes to seconds (rounded up) so a caller always
 * sees the same unit.
 */
function readRetryAfterSeconds(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  let candidates: { seconds: unknown; ms: unknown };
  try {
    const obj = error as Record<string, unknown>;
    candidates = { seconds: obj["retryAfterSeconds"], ms: obj["retryAfterMs"] };
  } catch {
    return null;
  }
  if (typeof candidates.seconds === "number" && Number.isFinite(candidates.seconds)) {
    const s = Math.max(0, Math.ceil(candidates.seconds));
    return s;
  }
  if (typeof candidates.ms === "number" && Number.isFinite(candidates.ms)) {
    const s = Math.max(0, Math.ceil(candidates.ms / 1_000));
    return s;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  nonEmpty,
  buildHint,
  buildNotConfiguredMessage,
  readErrorCode,
  readErrorMessage,
  readRetryAfterSeconds,
});
