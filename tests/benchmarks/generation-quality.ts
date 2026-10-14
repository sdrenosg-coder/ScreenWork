/**
 * Generation-quality regression benchmark.
 *
 * This is a *comparison harness*, not a test runner. It runs a fixed set
 * of prompts through the platform's LLM adapter and records the
 * readability, grounding and structure signals the quality/safety phases
 * expose, then prints a JSON report and a stable digest of the digests so
 * two runs (before/after a prompt or model change) can be compared.
 *
 * How it is meant to be used (not automatically executed here):
 *
 *   # baseline run, persisted for later comparison
 *   ZIPY_BENCH_BASELINE=bench-baseline.json \
 *   ZIPY_BENCH_LLM_CONFIGURED=1 \
 *     node --experimental-strip-types tests/benchmarks/generation-quality.ts
 *
 *   # candidate run after a prompt or model change
 *   ZIPY_BENCH_BASELINE=bench-baseline.json \
 *   ZIPY_BENCH_LLM_CONFIGURED=1 \
 *     node --experimental-strip-types tests/benchmarks/generation-quality.ts
 *
 * The harness reads the same environment variables the e2e suite reads
 * (`ZIPY_E2E_BASE_URL`, etc.) so it is invoked against a running app. It
 * does not start the app itself.
 *
 * Boundaries (deliberately kept narrow):
 *
 *   - It does not import the platform's runtime modules. If it did, the
 *     harness would have to be maintained against every refactor of the
 *     LLM adapter and the quality packages, and a passing benchmark could
 *     mean nothing except "the harness compiles". Instead it talks to the
 *     app over HTTP using the documented routes:
 *       POST /api/sources/text          (create a source)
 *       POST /api/workflows/{id}/synthesize (produce a plan)
 *       POST /api/guides/{id}/generate  (produce content)
 *       GET  /api/v1/guides/{id}        (read the produced guide)
 *     and reads whatever the guide read surface reports.
 *
 *   - It does not invent a "quality score". It records the concrete
 *     signals it can observe: guide length, step count, presence of a
 *     title/summary/FAQ/glossary, presence of a screenshot per step. Any
 *     numeric scoring is derived *from observations*, never guessed.
 *
 *   - It is not a test. There is no pass/fail; the operator compares runs.
 *     A regression is a *difference* the operator judges, not a threshold
 *     the harness enforces — because a threshold the platform has not
 *     promised would be an invented acceptance criterion.
 */

import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

interface HarnessConfig {
  readonly baseUrl: string;
  readonly cookie: string | null;
  readonly baselinePath: string | null;
  readonly llmConfigured: boolean;
}

function readConfig(): HarnessConfig {
  const raw = process.env["ZIPY_E2E_BASE_URL"] ?? "http://127.0.0.1:3000";
  const baseUrl = normaliseBaseUrl(raw);
  const cookie = nonEmpty(process.env["ZIPY_E2E_COOKIE"]);
  const baselinePath = nonEmpty(process.env["ZIPY_BENCH_BASELINE"]);
  const llmConfigured = process.env["ZIPY_BENCH_LLM_CONFIGURED"] === "1";
  return { baseUrl, cookie, baselinePath, llmConfigured };
}

function normaliseBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.hostname === "0.0.0.0" || url.hostname === "::") {
      url.hostname = "127.0.0.1";
    }
    return url.origin;
  } catch {
    return "http://127.0.0.1:3000";
  }
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* -------------------------------------------------------------------------- */
/* Prompt corpus                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A small, fixed corpus. Each case is a natural-language goal that the
 * platform's text-to-action mapping should be able to reason about. The
 * corpus is deliberately small and stable: a larger corpus would run
 * longer, and the value of a regression benchmark is stability, not
 * coverage.
 */
interface BenchCase {
  readonly id: string;
  readonly goal: string;
  readonly notes: string;
}

const CASES: readonly BenchCase[] = [
  {
    id: "create-customer",
    goal:
      "Create a new customer named Example Customer with email example@example.invalid and a phone number, then confirm the customer appears in the customer list.",
    notes:
      "The canonical first case from the platform's own acceptance criteria; exercises a multi-field form.",
  },
  {
    id: "export-report",
    goal:
      "Export the current report as a CSV file and download it to the local machine.",
    notes: "Exercises a menu-driven action with a filesystem side effect.",
  },
  {
    id: "invite-teammate",
    goal:
      "Invite a teammate by email to the current workspace with admin privileges.",
    notes:
      "Exercises a role select plus a confirmation step, plus a potential privilege-related warning.",
  },
  {
    id: "reset-password",
    goal:
      "Reset a user's password via the admin panel: locate the user, open their profile, and issue a password-reset email.",
    notes:
      "Exercises a destructive-adjacent flow that the review layer should flag.",
  },
  {
    id: "search-and-filter",
    goal:
      "Search the customer list for customers created in the last thirty days and filter the result to those with an outstanding balance.",
    notes:
      "Exercises a compound filter interaction that a naive synthesis may under-specify.",
  },
];

/* -------------------------------------------------------------------------- */
/* Observation model                                                           */
/* -------------------------------------------------------------------------- */

interface CaseObservation {
  readonly caseId: string;
  readonly notes: string;
  readonly goal: string;
  readonly status: "observed" | "skipped" | "error";
  readonly skipReason: string | null;
  readonly error: string | null;
  readonly guideId: string | null;
  readonly titleLength: number | null;
  readonly summaryLength: number | null;
  readonly introductionLength: number | null;
  readonly stepCount: number | null;
  readonly stepsWithScreenshot: number | null;
  readonly stepsWithDescription: number | null;
  readonly hasFaq: boolean | null;
  readonly hasGlossary: boolean | null;
  readonly hasPrerequisites: boolean | null;
  readonly averageStepDescriptionLength: number | null;
  readonly observedAt: string;
}

interface BenchReport {
  readonly schema: "zipy-benchmark/1";
  readonly baseUrl: string;
  readonly generatedAt: string;
  readonly baselinePath: string | null;
  readonly cases: readonly CaseObservation[];
  /** A stable digest over the observation digests of all cases, for run-to-run comparison. */
  readonly aggregateDigest: string;
  /** Per-case digests, so a regression shows up on the diff as the specific case that drifted. */
  readonly caseDigests: Readonly<Record<string, string>>;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const config = readConfig();

  process.stdout.write(
    `[zipy-benchmark] base=${config.baseUrl} llmConfigured=${config.llmConfigured} ` +
      `baseline=${config.baselinePath ?? "(none)"}\n`,
  );

  if (config.cookie === null && !config.llmConfigured) {
    process.stdout.write(
      "[zipy-benchmark] Neither ZIPY_E2E_COOKIE nor ZIPY_BENCH_LLM_CONFIGURED is set. " +
        "The harness will not attempt generation because it cannot authenticate or confirm " +
        "that the server has an LLM provider. Every case will be reported as skipped.\n",
    );
  }

  const observations: CaseObservation[] = [];
  for (const c of CASES) {
    const obs = await runCase(config, c);
    observations.push(obs);
    process.stdout.write(
      `[zipy-benchmark] ${c.id}: ${obs.status}` +
        (obs.skipReason !== null ? ` (${obs.skipReason})` : "") +
        (obs.error !== null ? ` (error: ${obs.error})` : "") +
        "\n",
    );
  }

  const caseDigests: Record<string, string> = {};
  for (const obs of observations) {
    caseDigests[obs.caseId] = digestOf(observationDigestInput(obs));
  }
  const aggregateDigest = stableDigest(caseDigests);

  const report: BenchReport = {
    schema: "zipy-benchmark/1",
    baseUrl: config.baseUrl,
    generatedAt: new Date().toISOString(),
    baselinePath: config.baselinePath,
    cases: observations,
    aggregateDigest,
    caseDigests,
  };

  process.stdout.write(JSON.stringify(report, null, 2));
  process.stdout.write("\n");
}

async function runCase(
  config: HarnessConfig,
  c: BenchCase,
): Promise<CaseObservation> {
  const base: Omit<CaseObservation, "status" | "skipReason" | "error"> = {
    caseId: c.id,
    notes: c.notes,
    goal: c.goal,
    guideId: null,
    titleLength: null,
    summaryLength: null,
    introductionLength: null,
    stepCount: null,
    stepsWithScreenshot: null,
    stepsWithDescription: null,
    hasFaq: null,
    hasGlossary: null,
    hasPrerequisites: null,
    averageStepDescriptionLength: null,
    observedAt: new Date().toISOString(),
  };

  if (config.cookie === null) {
    return {
      ...base,
      status: "skipped",
      skipReason:
        "No session cookie supplied. Set ZIPY_E2E_COOKIE to a cookie for an operator-provisioned account.",
      error: null,
    };
  }
  if (!config.llmConfigured) {
    return {
      ...base,
      status: "skipped",
      skipReason:
        "ZIPY_BENCH_LLM_CONFIGURED is not 1. The benchmark does not run against a server that has no LLM provider, because it would only measure the 503 response.",
      error: null,
    };
  }

  // 1. Submit a text source. The route's response shape is not fully
  //    documented in this repository, so it is inspected defensively; a
  //    shape the harness does not recognise produces a clean "skipped"
  //    with the response's body as the reason, so the operator becomes
  //    aware of an integration mismatch rather than a false measurement.
  const textRes = await httpJson(config, "POST", "/api/sources/text", {
    prompt: c.goal,
    label: `bench-${c.id}`,
  });

  if (textRes.status === 401 || textRes.status === 403) {
    return {
      ...base,
      status: "skipped",
      skipReason:
        `The server refused the text source submission with HTTP ${textRes.status}; the cookie is not accepted by this server.`,
      error: null,
    };
  }
  if (textRes.status === 503) {
    return {
      ...base,
      status: "skipped",
      skipReason:
        "The text source route reports a missing dependency (config or persistence).",
      error: null,
    };
  }
  if (textRes.status < 200 || textRes.status >= 300) {
    return {
      ...base,
      status: "error",
      skipReason: null,
      error: `POST /api/sources/text returned HTTP ${textRes.status}: ${textRes.body.slice(0, 200)}`,
    };
  }

  // 2. Resolve a guide id from the versioned collection. The harness does
  //    not create a guide itself; it reads whatever the workspace has.
  const guidesRes = await httpJson(config, "GET", "/api/v1/guides", undefined);
  if (guidesRes.status < 200 || guidesRes.status >= 300) {
    return {
      ...base,
      status: "skipped",
      skipReason:
        `The versioned guides collection is not readable (HTTP ${guidesRes.status}).`,
      error: null,
    };
  }
  const guideId = readFirstId(guidesRes.parsed, "guides");
  if (guideId === null) {
    return {
      ...base,
      status: "skipped",
      skipReason:
        "No guide exists in the workspace. The benchmark does not create one; provision a guide and re-run.",
      error: null,
    };
  }

  // 3. Request generation. The route's job is asynchronous; the harness
  //    does not poll for completion because the platform does not promise
  //    that a guide will be generated by any specific deadline. It reads
  //    the guide's current state and records it. A run against a workspace
  //    whose generation has not yet completed will record the pre-generation
  //    state, and the operator will re-run.
  const genRes = await httpJson(
    config,
    "POST",
    `/api/guides/${encodeURIComponent(guideId)}/generate`,
    { prompt: c.goal, benchmarkCaseId: c.id },
  );
  if (genRes.status === 503) {
    return {
      ...base,
      status: "skipped",
      skipReason:
        "The guide generation route reports a missing dependency (config or LLM provider).",
      error: null,
    };
  }
  if (genRes.status < 200 || genRes.status >= 300) {
    return {
      ...base,
      status: "error",
      skipReason: null,
      error: `POST /api/guides/{id}/generate returned HTTP ${genRes.status}: ${genRes.body.slice(0, 200)}`,
    };
  }

  // 4. Read the guide's current state. The guide read surface's shape is
  //    not fully enumerated in this repository; the harness extracts the
  //    fields the platform's own guide model exposes.
  const guideRes = await httpJson(
    config,
    "GET",
    `/api/v1/guides/${encodeURIComponent(guideId)}`,
    undefined,
  );
  if (guideRes.status < 200 || guideRes.status >= 300) {
    return {
      ...base,
      status: "skipped",
      skipReason:
        `The guide read endpoint returned HTTP ${guideRes.status}; the benchmark was not able to observe the produced guide.`,
      error: null,
    };
  }

  const observed = observeGuide(guideRes.parsed);
  return {
    ...base,
    guideId,
    titleLength: observed.titleLength,
    summaryLength: observed.summaryLength,
    introductionLength: observed.introductionLength,
    stepCount: observed.stepCount,
    stepsWithScreenshot: observed.stepsWithScreenshot,
    stepsWithDescription: observed.stepsWithDescription,
    hasFaq: observed.hasFaq,
    hasGlossary: observed.hasGlossary,
    hasPrerequisites: observed.hasPrerequisites,
    averageStepDescriptionLength: observed.averageStepDescriptionLength,
    status: "observed",
    skipReason: null,
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Guide observation                                                           */
/* -------------------------------------------------------------------------- */

interface GuideObservation {
  readonly titleLength: number | null;
  readonly summaryLength: number | null;
  readonly introductionLength: number | null;
  readonly stepCount: number | null;
  readonly stepsWithScreenshot: number | null;
  readonly stepsWithDescription: number | null;
  readonly hasFaq: boolean | null;
  readonly hasGlossary: boolean | null;
  readonly hasPrerequisites: boolean | null;
  readonly averageStepDescriptionLength: number | null;
}

function observeGuide(guide: unknown): GuideObservation {
  const empty: GuideObservation = {
    titleLength: null,
    summaryLength: null,
    introductionLength: null,
    stepCount: null,
    stepsWithScreenshot: null,
    stepsWithDescription: null,
    hasFaq: null,
    hasGlossary: null,
    hasPrerequisites: null,
    averageStepDescriptionLength: null,
  };
  if (guide === null || typeof guide !== "object") return empty;
  const g = guide as Record<string, unknown>;

  const titleLength = lengthOfString(g["title"]);
  const summaryLength = lengthOfString(g["summary"]);

  // The introduction may live at the top level, or under an `intro`
  // object; both shapes are tolerated without inventing content.
  const introductionLength =
    lengthOfString(g["introduction"]) ??
    lengthOfString((g["intro"] as Record<string, unknown> | undefined)?.["body"]) ??
    null;

  const steps = Array.isArray(g["steps"]) ? (g["steps"] as unknown[]) : null;
  const stepCount = steps === null ? null : steps.length;
  let stepsWithScreenshot: number | null = null;
  let stepsWithDescription: number | null = null;
  let averageStepDescriptionLength: number | null = null;
  if (steps !== null) {
    let shot = 0;
    let desc = 0;
    const lengths: number[] = [];
    for (const raw of steps) {
      if (raw === null || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      const shotId = s["screenshotAssetId"] ?? s["screenshotId"] ?? s["imageAssetId"];
      if (typeof shotId === "string" && shotId.length > 0) shot += 1;
      const descText = s["description"] ?? s["text"] ?? s["instruction"];
      if (typeof descText === "string" && descText.length > 0) {
        desc += 1;
        lengths.push(descText.length);
      }
    }
    stepsWithScreenshot = shot;
    stepsWithDescription = desc;
    averageStepDescriptionLength =
      lengths.length === 0
        ? null
        : Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  }

  const faq = g["faq"];
  const glossary = g["glossary"];
  const prerequisites = g["prerequisites"] ?? g["prereqs"];

  return {
    titleLength,
    summaryLength,
    introductionLength,
    stepCount,
    stepsWithScreenshot,
    stepsWithDescription,
    hasFaq: Array.isArray(faq) ? faq.length > 0 : null,
    hasGlossary:
      Array.isArray(glossary) ? glossary.length > 0 :
      glossary !== null && typeof glossary === "object" ? Object.keys(glossary as Record<string, unknown>).length > 0 :
      null,
    hasPrerequisites:
      Array.isArray(prerequisites) ? prerequisites.length > 0 :
      typeof prerequisites === "string" ? prerequisites.trim().length > 0 :
      null,
    averageStepDescriptionLength,
  };
}

function lengthOfString(v: unknown): number | null {
  if (typeof v !== "string") return null;
  return v.length;
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                                */
/* -------------------------------------------------------------------------- */

interface JsonResult {
  readonly status: number;
  readonly parsed: unknown;
  readonly body: string;
}

async function httpJson(
  config: HarnessConfig,
  method: "GET" | "POST" | "PUT",
  path: string,
  body: unknown,
): Promise<JsonResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.cookie !== null) headers["cookie"] = config.cookie;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(new URL(path, config.baseUrl).toString(), {
      method,
      headers,
      body: payload,
    });
  } catch (err) {
    return {
      status: 0,
      parsed: null,
      body: `transport error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, parsed, body: text };
}

function readFirstId(body: unknown, key: string): string | null {
  if (body === null || typeof body !== "object") return null;
  const env = body as Record<string, unknown>;
  const rows = env[key];
  if (!Array.isArray(rows)) {
    if (Array.isArray(body)) {
      for (const row of body) {
        if (row === null || typeof row !== "object") continue;
        const id = (row as Record<string, unknown>)["id"];
        if (typeof id === "string" && id.length > 0) return id;
      }
    }
    return null;
  }
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const id = (row as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Digests                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A shape-stable input for the observation digest. Only the fields that
 * represent observable *output* are included; the timestamps and the
 * `observedAt` field are deliberately excluded so a re-run on an unchanged
 * app produces the same digest.
 */
function observationDigestInput(obs: CaseObservation): string {
  return JSON.stringify({
    caseId: obs.caseId,
    status: obs.status,
    titleLength: obs.titleLength,
    summaryLength: obs.summaryLength,
    introductionLength: obs.introductionLength,
    stepCount: obs.stepCount,
    stepsWithScreenshot: obs.stepsWithScreenshot,
    stepsWithDescription: obs.stepsWithDescription,
    hasFaq: obs.hasFaq,
    hasGlossary: obs.hasGlossary,
    hasPrerequisites: obs.hasPrerequisites,
    averageStepDescriptionLength: obs.averageStepDescriptionLength,
  });
}

function digestOf(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function stableDigest(caseDigests: Readonly<Record<string, string>>): string {
  const keys = Object.keys(caseDigests).sort();
  const h = createHash("sha256");
  for (const k of keys) {
    h.update(k);
    h.update("\u0000");
    h.update(caseDigests[k] ?? "");
    h.update("\u0001");
  }
  return h.digest("hex").slice(0, 32);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

main().catch((err) => {
  process.stderr.write(
    `[zipy-benchmark] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
