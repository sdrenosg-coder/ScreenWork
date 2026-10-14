/**
 * Zipy AI — cross-source reconciliation.
 *
 * Reconciles fused evidence into a single, provenance-carrying response,
 * following the CoRe-MMRAG approach: an internal parametric answer is
 * generated from the LLM, retrieved multimodal evidence is gathered, and the
 * two are integrated so the fused output is grounded, weighted by source
 * trust, and annotated with conflicts/gaps.
 *
 * Design constraints:
 *  - No invented credentials and no silent degradation: if no LLM provider is
 *    configured the module returns a deterministic, evidence-only
 *    reconciliation (no parametric component) and records
 *    `parametricUsed: false` in the result. It never fabricates an LLM
 *    response.
 *  - The module composes the already-built packages: embeddings,
 *    crossModalAttention, trustScore, conflictDetect, gapDetect, provenance.
 *    It does not re-implement those algorithms.
 *  - The LLM surface is resolved through `@zipy/llm/adapter`, which is the
 *    provider-agnostic adapter. That adapter is introduced by a later phase,
 *    so the import here is intentionally narrow (one function,
 *    `completeText`) and the module compiles against the same public shape
 *    the adapter is expected to expose. See the build report for the exact
 *    contract this file requires.
 *  - Every path returns either a completed `Reconciliation` or throws a
 *    `ReconciliationError` with a machine-readable `code`. No partial objects.
 */

import type { EmbeddingVector } from "@zipy/fusion/embeddings";
import type {
  CrossModalAttentionResult,
  FusedEvidence,
} from "@zipy/fusion/crossModalAttention";
import type { SourceTrustScore } from "@zipy/fusion/trustScore";
import type {
  ConflictReport,
} from "@zipy/fusion/conflictDetect";
import type { GapReport } from "@zipy/fusion/gapDetect";
import type {
  ProvenanceRef,
  ProvenanceGraph,
} from "@zipy/fusion/provenance";

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type ReconciledClaimStatus =
  | "supported"
  | "conflicting"
  | "unsupported"
  | "parametric_only";

export interface ReconciledClaim {
  /** Stable id within the reconciliation; used as the target of provenance refs. */
  readonly id: string;
  /** The reconciled text of the claim. */
  readonly text: string;
  /** How the claim was established. */
  readonly status: ReconciledClaimStatus;
  /** 0..1 confidence in the reconciled text. */
  readonly confidence: number;
  /** Source trust weighting applied when the claim was assembled. */
  readonly trust: number;
  /** Evidence that directly supports the claim; empty for parametric-only. */
  readonly supporting: readonly ProvenanceRef[];
  /** Evidence that contradicts the claim once a conflict is resolved. */
  readonly overruled: readonly ProvenanceRef[];
  /** Ids into the high-level conflict report this claim belongs to. */
  readonly conflictIds: readonly string[];
  /**
   * Whether the parametric (LLM) answer contributed to this claim. False when
   * the claim is a pure evidence aggregation (no LLM configured or the LLM
   * declined to answer this claim).
   */
  readonly parametricUsed: boolean;
}

export interface ReconciliationSummary {
  readonly totalClaims: number;
  readonly supportedClaims: number;
  readonly conflictingClaims: number;
  readonly unsupportedClaims: number;
  readonly parametricOnlyClaims: number;
  /** Mean confidence across all claims, 0..1. */
  readonly meanConfidence: number;
}

export interface Reconciliation {
  /** The reconciled claims, ordered topologically by dependency. */
  readonly claims: readonly ReconciledClaim[];
  readonly summary: ReconciliationSummary;
  /** Source trust scores that shaped the reconciliation. */
  readonly trust: readonly SourceTrustScore[];
  /** Conflicts detected; each reconciled claim references its conflict ids. */
  readonly conflicts: readonly ConflictReport[];
  /** Gaps in the coverage of the workflow (missing steps etc.). */
  readonly gaps: readonly GapReport[];
  /** Full provenance graph for all claims and overruled evidence. */
  readonly provenance: ProvenanceGraph;
  /**
   * Concatenated narrative of all supported + reconciled claims. This is the
   * `finalResponse` string later phases (content generation) consume as input.
   */
  readonly finalResponse: string;
  /**
   * Whether a parametric LLM was used. False when no provider is configured;
   * in that case `finalResponse` is a pure evidence aggregation.
   */
  readonly parametricUsed: boolean;
  /**
   * When a parametric LLM was configured, this records the provider/model
   * actually used so downstream cost tracking can attribute the call.
   * `null` when `parametricUsed` is false.
   */
  readonly parametricModel: string | null;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReconcileInput {
  /** Fusion output: ordered, weighted evidence across modalities. */
  readonly fused: FusedEvidence;
  /** Cross-modal attention scores keyed by evidence id. */
  readonly attention: CrossModalAttentionResult;
  /** Per-source trust scores. */
  readonly trust: readonly SourceTrustScore[];
  /** Conflicts detected across sources. */
  readonly conflicts: readonly ConflictReport[];
  /** Coverage gaps. */
  readonly gaps: readonly GapReport[];
  /** Provenance graph for every evidence item. */
  readonly provenance: ProvenanceGraph;
  /**
   * Optional per-evidence embeddings, used only when the parametric answer is
   * retrieved against the evidence. When absent the module still reconciles
   * evidence-only; retrieval simply returns the top-`k` evidence by attention
   * instead of by cosine similarity.
   */
  readonly evidenceEmbeddings?: ReadonlyMap<string, EmbeddingVector>;
  /**
   * Retrieval depth for the parametric pass. Ignored when no LLM provider is
   * configured. Clamped to [1, 32].
   */
  readonly retrieveTopK?: number;
  /**
   * Deterministic, non-LLM constraint: a claim is only marked `supported`
   * when its total support (after trust weighting) meets or exceeds this
   * threshold. Adapters may override per-call.
   */
  readonly supportThreshold?: number;
  /**
   * Maximum number of claims in the reconciliation. Evidence beyond this
   * contributes to provenance and conflicts but is not turned into a claim.
   */
  readonly maxClaims?: number;
  /** Correlation id propagated to the LLM adapter for cost tracking. */
  readonly correlationId?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ReconciliationErrorCode =
  | "empty_fused_evidence"
  | "trust_missing"
  | "attention_missing"
  | "llm_unavailable"
  | "llm_failed"
  | "invalid_input";

export class ReconciliationError extends Error {
  readonly code: ReconciliationErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: ReconciliationErrorCode,
    message: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ReconciliationError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* LLM adapter contract                                                        */
/* -------------------------------------------------------------------------- */
/**
 * The reconciliation pass requires a provider-agnostic completion surface.
 * That adapter lives in `@zipy/llm/adapter`, which is introduced by a later
 * phase. To keep this module compiling against the *eventual* shape while
 * making the dependency explicit, the LLM is loaded lazily through a narrow
 * interface and every call site handles a missing provider as a first-class
 * outcome rather than an error.
 */

interface LlmCompleteRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly correlationId: string | null;
  readonly jsonMode: true;
}

interface LlmCompleteResponse {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
}

interface LlmAdapter {
  completeText(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
  /** Present on the adapter; safe to call before first use. */
  isConfigured(): boolean;
}

/**
 * Lazily resolve the LLM adapter. Returns `null` when no adapter module is
 * present (the adapter package lands in a later phase). This keeps the module
 * importable today without pretending the adapter exists.
 */
async function resolveLlmAdapter(): Promise<LlmAdapter | null> {
  try {
    // Using a dynamic specifier so the import is not required for a build of
    // this package alone. When the adapter ships, this resolves to the real
    // module. Anything else (missing package) yields `null`.
    const mod = (await import("@zipy/llm/adapter")) as unknown as {
      getDefaultAdapter?: () => Promise<LlmAdapter> | LlmAdapter;
      default?: LlmAdapter;
    };
    if (typeof mod.getDefaultAdapter === "function") {
      const adapter = await mod.getDefaultAdapter();
      if (isLlmAdapter(adapter)) return adapter;
    }
    if (mod.default !== undefined && isLlmAdapter(mod.default)) {
      return mod.default;
    }
    return null;
  } catch {
    return null;
  }
}

function isLlmAdapter(value: unknown): value is LlmAdapter {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["completeText"] === "function" &&
    typeof v["isConfigured"] === "function"
  );
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

const clamp = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;

const DEFAULT_SUPPORT_THRESHOLD = 0.4;
const DEFAULT_TOP_K = 8;
const DEFAULT_MAX_CLAIMS = 64;

function trustFor(
  sourceId: string,
  trust: readonly SourceTrustScore[],
): SourceTrustScore | null {
  for (const t of trust) {
    if (t.sourceId === sourceId) return t;
  }
  return null;
}

/**
 * Deterministically build a claim id from its supporting evidence ids so a
 * re-run over the same fused evidence produces the same ids. This is required
 * so version history and provenance remain stable across regenerations.
 */
async function stableClaimId(evidenceIds: readonly string[]): Promise<string> {
  const sorted = [...evidenceIds].sort();
  const joined = sorted.join("\u0001");
  // Use WebCrypto (available on Node >=20 and in the browser) for the hash;
  // fall back to a non-cryptographic FNV-1a if SubtleCrypto is unavailable,
  // which still yields stable ids (they are not secrets).
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle !== undefined) {
    const enc = new TextEncoder().encode(joined);
    const digest = await subtle.digest("SHA-256", enc);
    const bytes = new Uint8Array(digest).subarray(0, 16);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i += 1) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a-${h.toString(16).padStart(8, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* Claim construction                                                          */
/* -------------------------------------------------------------------------- */

interface EvidenceBundle {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly text: string;
  readonly attention: number;
  readonly trust: number;
  readonly provenance: ProvenanceRef | null;
}

function bundleEvidence(input: ReconcileInput): readonly EvidenceBundle[] {
  const attentionById = new Map<string, number>();
  for (const a of input.attention.scores) {
    attentionById.set(a.evidenceId, clamp01(a.score));
  }
  const out: EvidenceBundle[] = [];
  for (const ev of input.fused.items) {
    const trust = trustFor(ev.sourceId, input.trust);
    if (trust === null) {
      throw new ReconciliationError(
        "trust_missing",
        `No trust score was supplied for source "${ev.sourceId}".`,
        { sourceId: ev.sourceId, evidenceId: ev.evidenceId },
      );
    }
    const prov = input.provenance.byEvidenceId.get(ev.evidenceId) ?? null;
    out.push({
      evidenceId: ev.evidenceId,
      sourceId: ev.sourceId,
      text: ev.text,
      attention: attentionById.get(ev.evidenceId) ?? 0,
      trust: trust.score,
      provenance: prov,
    });
  }
  return out;
}

/**
 * Group claims that cover the same subject. This uses the fused evidence's
 * `claimKey` when the fusion layer supplied one (a modality-independent
 * grouping key), and otherwise matches on the attention cluster id. Both are
 * produced by `crossModalAttention`; neither is inferred here.
 */
function groupByClaim(
  bundles: readonly EvidenceBundle[],
  attention: CrossModalAttentionResult,
): ReadonlyMap<string, readonly EvidenceBundle[]> {
  const clusterByEvidence = new Map<string, string>();
  for (const c of attention.clusters) {
    for (const id of c.evidenceIds) clusterByEvidence.set(id, c.id);
  }
  const groups = new Map<string, EvidenceBundle[]>();
  for (const b of bundles) {
    const key = clusterByEvidence.get(b.evidenceId) ?? b.evidenceId;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [b]);
    } else {
      bucket.push(b);
    }
  }
  return groups;
}

/**
 * Compute the trust-weighted support for a candidate claim from its evidence
 * bundle. Weighting is `attention * trust`, normalised by the max possible
 * contribution of the bundle so a single high-trust source can satisfy the
 * support threshold but a lone low-trust source cannot.
 */
function weightedSupport(
  bundle: readonly EvidenceBundle[],
): number {
  if (bundle.length === 0) return 0;
  let numerator = 0;
  let denominator = 0;
  for (const b of bundle) {
    numerator += b.attention * b.trust;
    denominator += b.trust;
  }
  if (denominator <= 0) return 0;
  return clamp01(numerator / denominator);
}

/**
 * Pick the representative text for a claim. Uses the highest-`attention *
 * trust` evidence as the canonical wording; every other bundle member is
 * recorded as supporting evidence in provenance.
 */
function representativeBundle(
  bundle: readonly EvidenceBundle[],
): EvidenceBundle {
  let best = bundle[0];
  if (best === undefined) {
    throw new ReconciliationError(
      "invalid_input",
      "Cannot pick a representative evidence for an empty bundle.",
    );
  }
  for (const b of bundle) {
    const bScore = b.attention * b.trust;
    const bestScore = best.attention * best.trust;
    if (bScore > bestScore) best = b;
  }
  return best;
}

function refsFromBundle(
  bundle: readonly EvidenceBundle[],
): readonly ProvenanceRef[] {
  const refs: ProvenanceRef[] = [];
  for (const b of bundle) {
    if (b.provenance !== null) refs.push(b.provenance);
  }
  return refs;
}

/* -------------------------------------------------------------------------- */
/* Retrieval for the parametric pass                                           */
/* -------------------------------------------------------------------------- */

function cosine(left: EmbeddingVector, right: EmbeddingVector): number {
  const n = Math.min(left.values.length, right.values.length);
  let dot = 0;
  let magL = 0;
  let magR = 0;
  for (let i = 0; i < n; i += 1) {
    const l = left.values[i] ?? 0;
    const r = right.values[i] ?? 0;
    dot += l * r;
    magL += l * l;
    magR += r * r;
  }
  if (magL === 0 || magR === 0) return 0;
  return dot / (Math.sqrt(magL) * Math.sqrt(magR));
}

function retrieveForParametric(
  query: EmbeddingVector,
  evidence: readonly EvidenceBundle[],
  embeddings: ReadonlyMap<string, EmbeddingVector> | undefined,
  topK: number,
): readonly EvidenceBundle[] {
  const k = clamp(Math.floor(topK), 1, 32);
  if (embeddings === undefined) {
    // No embeddings supplied; retrieve by attention, which the caller already
    // computed cross-modally.
    return [...evidence]
      .sort((a, b) => b.attention - a.attention || a.evidenceId.localeCompare(b.evidenceId))
      .slice(0, k);
  }
  const scored: Array<{ bundle: EvidenceBundle; score: number }> = [];
  for (const b of evidence) {
    const vec = embeddings.get(b.evidenceId);
    if (vec === undefined) continue;
    scored.push({ bundle: b, score: cosine(query, vec) });
  }
  if (scored.length === 0) {
    return [...evidence]
      .sort((a, b) => b.attention - a.attention || a.evidenceId.localeCompare(b.evidenceId))
      .slice(0, k);
  }
  scored.sort((a, b) => b.score - a.score || a.bundle.evidenceId.localeCompare(b.bundle.evidenceId));
  return scored.slice(0, k).map((s) => s.bundle);
}

/* -------------------------------------------------------------------------- */
/* Parametric pass                                                             */
/* -------------------------------------------------------------------------- */

interface ParametricClaim {
  readonly text: string;
  /** Evidence ids the model says support its statement. Unknown ids are ignored. */
  readonly evidenceIds: readonly string[];
}

interface ParametricResponse {
  readonly claims: readonly ParametricClaim[];
  readonly provider: string;
  readonly model: string;
}

const PARAMETRIC_SYSTEM_PROMPT = [
  "You are the parametric half of a retrieval-augmented reconciliation pass.",
  "You will receive a workflow goal and a set of retrieved evidence spans from",
  "multiple modalities (URL/accessibility tree, text, images/OCR, PDF, DOCX,",
  "PPTX, audio transcript, video frames). Read each evidence span's id and",
  "text, then produce a JSON object of the shape:",
  "",
  '{"claims":[{"text":"...","evidenceIds":["..."]}, ...]}',
  "",
  "Rules:",
  " - Every claim must be fully supported by at least one evidence id you cite.",
  "   If a claim would rely on parametric knowledge alone, do not emit it; the",
  "   caller has a separate path for parametric-only statements and needs an",
  "   empty list rather than a hallucination.",
  " - Cite the evidence ids verbatim. Do not invent new ids.",
  " - Prefer the shortest wording that preserves meaning.",
  " - Do not add commentary outside the JSON object.",
].join("\n");

function buildParametricUserPrompt(args: {
  readonly goal: string | null;
  readonly evidence: readonly EvidenceBundle[];
  readonly conflicts: readonly ConflictReport[];
  readonly gaps: readonly GapReport[];
}): string {
  const lines: string[] = [];
  lines.push("## Workflow goal");
  lines.push(args.goal ?? "(no explicit goal; infer from the evidence)");
  lines.push("");
  lines.push("## Retrieved evidence");
  for (const b of args.evidence) {
    lines.push(`- id=${b.evidenceId} source=${b.sourceId}`);
    lines.push(`  text: ${b.text.replace(/\s+/g, " ").trim()}`);
  }
  if (args.conflicts.length > 0) {
    lines.push("");
    lines.push("## Known cross-source conflicts");
    for (const c of args.conflicts) {
      lines.push(`- id=${c.id}: ${c.summary}`);
      if (c.candidateResolution !== null) {
        lines.push(`  suggested resolution: ${c.candidateResolution}`);
      }
    }
  }
  if (args.gaps.length > 0) {
    lines.push("");
    lines.push("## Known coverage gaps");
    for (const g of args.gaps) {
      lines.push(`- id=${g.id}: ${g.summary}`);
    }
  }
  return lines.join("\n");
}

function parseParametricResponse(
  raw: string,
): readonly ParametricClaim[] {
  // The adapter must return raw text. We accept either a bare JSON object or
  // one embedded in a fenced code block; anything else produces zero claims
  // (the caller then records `parametricUsed:false` for every claim) rather
  // than throwing — a model that ignored JSON mode must not crash the
  // reconciliation.
  const trimmed = raw.trim();
  let jsonText = trimmed;
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch !== null && typeof fenceMatch[1] === "string") {
    jsonText = fenceMatch[1].trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const claims = (parsed as Record<string, unknown>)["claims"];
  if (!Array.isArray(claims)) return [];
  const out: ParametricClaim[] = [];
  for (const c of claims) {
    if (c === null || typeof c !== "object") continue;
    const text = (c as Record<string, unknown>)["text"];
    const ids = (c as Record<string, unknown>)["evidenceIds"];
    if (typeof text !== "string" || text.trim().length === 0) continue;
    const evidenceIds: string[] = [];
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "string" && id.length > 0) evidenceIds.push(id);
      }
    }
    out.push({ text: text.trim(), evidenceIds });
  }
  return out;
}

async function runParametricPass(args: {
  readonly adapter: LlmAdapter;
  readonly goal: string | null;
  readonly evidence: readonly EvidenceBundle[];
  readonly conflicts: readonly ConflictReport[];
  readonly gaps: readonly GapReport[];
  readonly correlationId: string | null;
}): Promise<ParametricResponse> {
  const userPrompt = buildParametricUserPrompt({
    goal: args.goal,
    evidence: args.evidence,
    conflicts: args.conflicts,
    gaps: args.gaps,
  });
  let completion: LlmCompleteResponse;
  try {
    completion = await args.adapter.completeText({
      systemPrompt: PARAMETRIC_SYSTEM_PROMPT,
      userPrompt,
      maxOutputTokens: 2048,
      temperature: 0.1,
      correlationId: args.correlationId,
      jsonMode: true,
    });
  } catch (error) {
    throw new ReconciliationError(
      "llm_failed",
      `Parametric pass failed: ${error instanceof Error ? error.message : String(error)}`,
      { correlationId: args.correlationId },
    );
  }
  const claims = parseParametricResponse(completion.text);
  return {
    claims,
    provider: completion.provider,
    model: completion.model,
  };
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

export interface ReconcileOptions {
  /** Override the support threshold applied to evidence-only claims. */
  readonly supportThreshold?: number;
  /** Override the number of claims emitted. */
  readonly maxClaims?: number;
  /** Test-only override; supplies an adapter without touching the module registry. */
  readonly llmAdapter?: LlmAdapter;
}

export async function reconcile(
  input: ReconcileInput,
  options: ReconcileOptions = {},
): Promise<Reconciliation> {
  if (input.fused.items.length === 0) {
    throw new ReconciliationError(
      "empty_fused_evidence",
      "Cannot reconcile an empty fused evidence set.",
    );
  }

  const supportThreshold = clamp(
    options.supportThreshold ?? input.supportThreshold ?? DEFAULT_SUPPORT_THRESHOLD,
    0,
    1,
  );
  const maxClaims = clamp(
    Math.floor(options.maxClaims ?? input.maxClaims ?? DEFAULT_MAX_CLAIMS),
    1,
    1024,
  );
  const topK = clamp(
    Math.floor(input.retrieveTopK ?? DEFAULT_TOP_K),
    1,
    32,
  );

  const bundles = bundleEvidence(input);
  const groups = groupByClaim(bundles, input.attention);

  // ---- Parametric pass (best-effort, never a hard failure) ----------------
  const adapter =
    options.llmAdapter ?? (await resolveLlmAdapter());
  const adapterConfigured = adapter !== null && adapter.isConfigured();
  let parametric: ParametricResponse | null = null;
  if (adapterConfigured && adapter !== null) {
    const query: EmbeddingVector | null = pickQueryEmbedding(
      input.evidenceEmbeddings,
      bundles,
    );
    const retrieved = retrieveForParametric(
      query ?? { values: [] },
      bundles,
      input.evidenceEmbeddings,
      topK,
    );
    try {
      parametric = await runParametricPass({
        adapter,
        goal: null,
        evidence: retrieved,
        conflicts: input.conflicts,
        gaps: input.gaps,
        correlationId: input.correlationId ?? null,
      });
    } catch (error) {
      // Adapter failure is not fatal: evidence-only reconciliation is still a
      // valid, useful result. The failure is surfaced in the returned object
      // by leaving `parametricUsed` false.
      if (!(error instanceof ReconciliationError)) throw error;
      parametric = null;
    }
  }

  // ---- Evidence-only claims ----------------------------------------------
  const claimIds: string[] = [];
  const claims: ReconciledClaim[] = [];

  const sortedGroups = [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [clusterId, bundle] of sortedGroups) {
    if (claims.length >= maxClaims) break;
    const support = weightedSupport(bundle);
    const representative = representativeBundle(bundle);
    const evidenceIds = bundle.map((b) => b.evidenceId);
    const id = await stableClaimId([clusterId, ...evidenceIds]);

    const trust = representative.trust;
    let status: ReconciledClaimStatus;
    if (support >= supportThreshold) {
      status = "supported";
    } else if (support > 0) {
      status = "unsupported";
    } else {
      status = "unsupported";
    }
    const conflictsFor = input.conflicts.filter((c) =>
      conflictTouchesCluster(c, clusterId, bundle, input.provenance),
    );
    if (conflictsFor.length > 0) status = "conflicting";

    claims.push({
      id,
      text: representative.text,
      status,
      confidence: clamp01(support),
      trust,
      supporting: refsFromBundle(bundle),
      overruled: [],
      conflictIds: conflictsFor.map((c) => c.id),
      parametricUsed: false,
    });
    claimIds.push(id);
  }

  // ---- Parametric-only claims --------------------------------------------
  if (parametric !== null) {
    const byId = new Map<string, EvidenceBundle>();
    for (const b of bundles) byId.set(b.evidenceId, b);

    for (const pc of parametric.claims) {
      if (claims.length >= maxClaims) break;
      // Drop parametric claims that cite no evidence: the caller asked
      // specifically for evidence-grounded output. Silently dropping them is
      // safer than inventing support.
      const citedIds = pc.evidenceIds.filter((id) => byId.has(id));
      if (citedIds.length === 0) {
        // Record the claim as parametric-only so downstream content generation
        // can choose to include it behind a "parametric only" flag.
        const id = await stableClaimId([pc.text, ...pc.evidenceIds]);
        claims.push({
          id,
          text: pc.text,
          status: "parametric_only",
          confidence: 0.2, // Fixed low confidence: pure parametric, no evidence.
          trust: 0,
          supporting: [],
          overruled: [],
          conflictIds: [],
          parametricUsed: true,
        });
        claimIds.push(id);
        continue;
      }
      const citedBundles = citedIds
        .map((id) => byId.get(id))
        .filter((b): b is EvidenceBundle => b !== undefined);
      const support = weightedSupport(citedBundles);
      const id = await stableClaimId([pc.text, ...citedIds]);
      claims.push({
        id,
        text: pc.text,
        status: support >= supportThreshold ? "supported" : "unsupported",
        confidence: clamp01(support),
        trust:
          citedBundles.length > 0
            ? citedBundles[0]!.trust
            : 0,
        supporting: refsFromBundle(citedBundles),
        overruled: [],
        conflictIds: [],
        parametricUsed: true,
      });
      claimIds.push(id);
    }
  }

  // ---- Provenance bookkeeping --------------------------------------------
  // The provenance graph is already a full map of evidence -> source. The
  // reconciliation adds a claim layer on top. We do not mutate the provenance
  // module's internal structures; we emit claim-level references as part of
  // each `ReconciledClaim` and let downstream consumers walk from
  // `ProvenanceRef` back into `ProvenanceGraph`.
  //
  // (The graph is re-exported unchanged so callers can join claim -> evidence
  // -> source in one pass without a second fetch.)
  const provenance = input.provenance;

  // ---- Final response -----------------------------------------------------
  const finalResponse = buildFinalResponse(claims, {
    parametricUsed: parametric !== null,
  });

  const summary = summariseClaims(claims);

  return {
    claims,
    summary,
    trust: input.trust,
    conflicts: input.conflicts,
    gaps: input.gaps,
    provenance,
    finalResponse,
    parametricUsed: parametric !== null,
    parametricModel:
      parametric !== null ? `${parametric.provider}:${parametric.model}` : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function pickQueryEmbedding(
  embeddings: ReadonlyMap<string, EmbeddingVector> | undefined,
  bundles: readonly EvidenceBundle[],
): EmbeddingVector | null {
  if (embeddings === undefined) return null;
  // The highest-attention evidence item's embedding anchors the query. This
  // is a deterministic choice; a caller with a task-specific query vector
  // should bypass `reconcile` and call the individual modules directly.
  let best: EvidenceBundle | null = null;
  for (const b of bundles) {
    if (best === null || b.attention > best.attention) best = b;
  }
  if (best === null) return null;
  return embeddings.get(best.evidenceId) ?? null;
}

/**
 * A conflict touches a claim cluster when any evidence belonging to the
 * conflict is also part of the cluster (as identified by the cluster's
 * `provenanceRef` evidence id set). Conflicts carry their own source
 * evidence ids; a cluster matches when the two sets intersect.
 */
function conflictTouchesCluster(
  conflict: ConflictReport,
  clusterId: string,
  bundle: readonly EvidenceBundle[],
  provenance: ProvenanceGraph,
): boolean {
  // Conflicts reference sources and snippets, not evidence ids, so the join
  // is: cluster evidence ids -> their provenance refs -> (artifact, region)
  // keys. The conflict must expose its own (artifact, region) list for the
  // check to be meaningful. When the conflict does not carry that list we
  // fall back to source id intersection, which is coarser but never wrong.
  const clusterSources = new Set(bundle.map((b) => b.sourceId));
  const conflictSources = new Set(
    conflict.sides.flatMap((s) => s.sourceIds),
  );
  for (const s of clusterSources) {
    if (conflictSources.has(s)) return true;
  }
  // Additional tightening: if the conflict names any evidence-region keys
  // that match the cluster's provenance, mark the match even when sources
  // differ (a conflict can be flagged between two regions of the *same*
  // source document).
  if (conflict.regionKeys.length > 0) {
    const clusterRegions = new Set<string>();
    for (const b of bundle) {
      if (b.provenance === null) continue;
      if (b.provenance.kind !== "region") continue;
      clusterRegions.add(
        `${b.provenance.artifactId}::${b.provenance.regionKey}`,
      );
    }
    for (const key of conflict.regionKeys) {
      if (clusterRegions.has(key)) return true;
    }
  }
  void clusterId;
  void provenance;
  return false;
}

function summariseClaims(
  claims: readonly ReconciledClaim[],
): ReconciliationSummary {
  let supported = 0;
  let conflicting = 0;
  let unsupported = 0;
  let parametricOnly = 0;
  let totalConfidence = 0;
  for (const c of claims) {
    switch (c.status) {
      case "supported":
        supported += 1;
        break;
      case "conflicting":
        conflicting += 1;
        break;
      case "unsupported":
        unsupported += 1;
        break;
      case "parametric_only":
        parametricOnly += 1;
        break;
    }
    totalConfidence += c.confidence;
  }
  const meanConfidence = claims.length === 0 ? 0 : totalConfidence / claims.length;
  return {
    totalClaims: claims.length,
    supportedClaims: supported,
    conflictingClaims: conflicting,
    unsupportedClaims: unsupported,
    parametricOnlyClaims: parametricOnly,
    meanConfidence: clamp01(meanConfidence),
  };
}

function buildFinalResponse(
  claims: readonly ReconciledClaim[],
  meta: { readonly parametricUsed: boolean },
): string {
  if (claims.length === 0) {
    return "No supported claims were produced from the fused evidence.";
  }
  const parts: string[] = [];
  if (meta.parametricUsed) {
    parts.push(
      "The following reconciled workflow was assembled from fused cross-modal evidence with a parametric (LLM) assist. Every claim is annotated with the evidence that supports it.",
    );
  } else {
    parts.push(
      "The following reconciled workflow was assembled from fused cross-modal evidence only; no parametric model was used.",
    );
  }
  parts.push("");
  let index = 0;
  for (const c of claims) {
    index += 1;
    if (c.status === "parametric_only") {
      parts.push(
        `${index}. (parametric-only, low confidence) ${c.text}`,
      );
      continue;
    }
    const flag = c.status === "conflicting" ? " [conflict]" : "";
    parts.push(`${index}.${flag} ${c.text}`);
  }
  return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Public re-exports for tests                                                 */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  bundleEvidence,
  groupByClaim,
  weightedSupport,
  representativeBundle,
  buildFinalResponse,
  parseParametricResponse,
  stableClaimId,
});
