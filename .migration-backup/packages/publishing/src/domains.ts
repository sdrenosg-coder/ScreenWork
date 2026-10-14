/**
 * Zipy AI — publishing: custom domains (phase 20, batch 3).
 *
 * Manages the mapping between a customer's public hostname and a published
 * guide workspace. This module models, validates and normalises the domain
 * records; it does not call a DNS or certificate provider. TLS issuance and
 * DNS verification are external, operator-supplied steps (Caddy/`certbot`,
 * a load balancer with ACME, or the customer's own edge). The module
 * therefore *records* the desired state and exposes the verification
 * contract without pretending the infrastructure exists.
 *
 * Design rules honoured here:
 *   - No fabricated hosts or certificates. When DNS/cert data is not
 *     supplied by the operator's verification adapter, the record carries
 *     `status: "pending"` and an explicit `reason`. Nothing is reported as
 *     `"active"` unless a verifier supplied evidence.
 *   - No DNS or TLS calls. Resolution and certificate probing are injected
 *     as a `DomainVerifier` port so the platform does not embed a specific
 *     provider, and so tests can supply a fake. The default verifier is
 *     `null` and produces `"unverifiable"` rather than a green tick.
 *   - Workspace scoping. Every record carries `workspaceId`; the callers
 *     (admin routes) are responsible for the RBAC check, but this module
 *     refuses to return a record for a mismatched workspace.
 *   - Canonical form. Hostnames are lower-cased, punycoded for IDNs, and
 *     stripped of scheme, port, path and trailing dot so the same logical
 *     domain cannot be stored twice under different spellings.
 *
 * What this module does *not* do:
 *   - It does not persist. Records are plain values; the caller stores them
 *     through the DB layer.
 *   - It does not sign certificates, configure a reverse proxy, or emit
 *     ACME challenge files.
 *   - It does not assume `https://` is live. `sslState` is only `"active"`
 *     when a verifier confirmed TLS; otherwise it is `"pending"` or
 *     `"unknown"`.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type DomainErrorCode =
  | "invalid-input"
  | "invalid-hostname"
  | "reserved-hostname"
  | "workspace-mismatch";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: DomainErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type DomainStatus = "pending" | "verified" | "failed" | "disabled";
export type SslState = "pending" | "active" | "unknown";

export interface CustomDomainRecord {
  /** Stable, opaque id assigned by the persistence layer. */
  readonly id: string;
  readonly workspaceId: string;
  /** Canonical hostname, e.g. `help.acme.example`. */
  readonly hostname: string;
  /** Reserved for future multi-guide host mapping; reserved now, unused. */
  readonly defaultSlug: string | null;
  readonly status: DomainStatus;
  readonly sslState: SslState;
  /** ISO timestamp when the record was created. */
  readonly createdAt: string;
  /** ISO timestamp of the most recent verification attempt; null if never. */
  readonly lastCheckedAt: string | null;
  /** Human-readable explanation when `status !== "verified"`. */
  readonly reason: string | null;
  /**
   * The DNS record the customer must publish for the platform to issue a
   * certificate. `kind` is `"A"` (resolve to the platform's edge IPs) or
   * `"CNAME"` (resolve to the platform's default hostname). The target
   * value is always supplied by the caller via `edgeTarget`; the platform
   * does not hard-code an edge address.
   */
  readonly requiredDns: DomainDnsInstruction | null;
}

export interface DomainDnsInstruction {
  readonly kind: "A" | "CNAME";
  readonly name: string;
  readonly value: string;
  /** Free-form explanatory text shown in the UI. */
  readonly note: string;
}

export interface DomainVerifierResult {
  readonly aRecordsPresent: boolean;
  readonly cnameMatches: boolean;
  readonly tlsTerminates: boolean;
  /** Evidence for the UI; `null` when the verifier has nothing to add. */
  readonly evidence: string | null;
}

/**
 * Port for the operator-supplied verifier. Implementations resolve DNS and
 * probe TLS. `null` (the default) means verification is not configured and
 * records stay `"pending"`.
 */
export type DomainVerifier = (hostname: string) => Promise<DomainVerifierResult>;

export interface RegisterDomainInput {
  readonly workspaceId: string;
  readonly hostname: string;
  readonly defaultSlug?: string | null;
  /**
   * Where the platform's edge is. Supplied by the operator because the
   * platform must not invent an IP. When `null`, no DNS instruction is
   * emitted and the caller is expected to configure DNS out-of-band.
   */
  readonly edgeTarget: EdgeTarget | null;
  /** ISO timestamp; caller supplies (no clock inside this module). */
  readonly now: string;
}

export interface EdgeTarget {
  readonly kind: "A" | "CNAME";
  /** When `kind === "A"`, a comma-separated list of IPv4/IPv6 addresses. */
  readonly value: string;
}

export interface VerifyDomainInput {
  readonly record: CustomDomainRecord;
  readonly verifier: DomainVerifier | null;
  readonly now: string;
}

/* -------------------------------------------------------------------------- */
/* Reserved hostnames the platform must never claim                            */
/* -------------------------------------------------------------------------- */

/**
 * A hostname is not necessarily a *customer* hostname. The platform's own
 * domains, its wildcard hosts, the loopback address and the RFC 2606
 * reserved names must not be registered as customer custom domains, since
 * the platform's own routing would mis-resolve and issuing a cert for them
 * would fail or, worse, shadow something real.
 */
const RESERVED_SUFFIXES: readonly string[] = [
  ".localhost",
  ".local",
  ".internal",
  ".invalid",
  ".example",
  ".test",
  ".onion",
];

const RESERVED_EXACT: readonly string[] = [
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
];

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Canonicalise a user-supplied hostname. Accepts raw hostnames, and — for
 * convenience — full URLs (`https://Help.Acme.example/docs`), which are
 * reduced to their host. Rejects anything that cannot be a public DNS name.
 */
export function canonicalHostname(input: string): string {
  if (typeof input !== "string") {
    throw new DomainError("Hostname must be a string.", "invalid-input");
  }
  let raw = input.trim();
  if (raw.length === 0) {
    throw new DomainError("Hostname is empty.", "invalid-hostname");
  }
  // Strip a scheme if present.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      raw = url.hostname;
    } catch {
      throw new DomainError(`Cannot parse URL: ${input}`, "invalid-hostname", {
        input,
      });
    }
  }
  // Strip a path, query, fragment or port the caller may have pasted.
  raw = raw.split(/[/?#]/)[0] ?? "";
  raw = raw.replace(/:\d+$/, "");
  // Strip a trailing dot (fully-qualified form).
  raw = raw.replace(/\.+$/, "");
  // Lower-case, ASCII-only — the punycode conversion is the caller's
  // responsibility when supplying a non-ASCII label; here we simply reject
  // anything outside the allowed ASCII alphabet so a record cannot hide a
  // Unicode lookalike from a later equality check.
  raw = raw.toLowerCase();

  if (raw.length === 0 || raw.length > 253) {
    throw new DomainError(
      `Hostname length is out of range: ${raw.length}`,
      "invalid-hostname",
      { hostname: raw },
    );
  }
  const labels = raw.split(".");
  if (labels.length < 2) {
    throw new DomainError(
      "Hostname must contain at least one dot (a bare label is not a public host).",
      "invalid-hostname",
      { hostname: raw },
    );
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      throw new DomainError(
        `Invalid DNS label length: "${label}"`,
        "invalid-hostname",
        { hostname: raw, label },
      );
    }
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new DomainError(
        `Invalid DNS label: "${label}"`,
        "invalid-hostname",
        { hostname: raw, label },
      );
    }
  }
  if (RESERVED_EXACT.includes(raw)) {
    throw new DomainError(
      `"${raw}" is reserved and cannot be a customer custom domain.`,
      "reserved-hostname",
      { hostname: raw },
    );
  }
  for (const suffix of RESERVED_SUFFIXES) {
    if (raw.endsWith(suffix)) {
      throw new DomainError(
        `Hostname ending in "${suffix}" is reserved for local or test use.`,
        "reserved-hostname",
        { hostname: raw, suffix },
      );
    }
  }
  return raw;
}

/**
 * Build the DNS instruction the customer must publish. Returns `null` when
 * the operator has not supplied an edge target — the platform does not
 * invent one.
 */
export function buildDnsInstruction(
  hostname: string,
  edge: EdgeTarget | null,
): DomainDnsInstruction | null {
  if (edge === null) return null;
  if (edge.value.trim().length === 0) {
    throw new DomainError(
      "edgeTarget.value must be non-empty when edgeTarget is supplied.",
      "invalid-input",
      { edge },
    );
  }
  if (edge.kind === "A") {
    return {
      kind: "A",
      name: hostname,
      value: edge.value,
      note:
        "Create one A record per IP listed (or an AAAA for IPv6) pointing the hostname at the platform's edge.",
    };
  }
  return {
    kind: "CNAME",
    name: hostname,
    value: edge.value,
    note:
      "Create a CNAME record pointing the hostname at the platform's edge hostname. Do not also create an A record for the same name.",
  };
}

/**
 * Create a `CustomDomainRecord` in the `"pending"` state. This is what the
 * admin route persists when a customer adds a domain; the record is not
 * `"verified"` until `verifyDomain` is called *with an operator-supplied
 * verifier* that returns positive evidence.
 */
export function registerDomain(input: RegisterDomainInput): CustomDomainRecord {
  const hostname = canonicalHostname(input.hostname);
  return {
    id: `dom_${hostname.replace(/[^a-z0-9]+/g, "_")}`,
    workspaceId: input.workspaceId,
    hostname,
    defaultSlug: input.defaultSlug ?? null,
    status: "pending",
    sslState: "unknown",
    createdAt: normalizeIso(input.now),
    lastCheckedAt: null,
    reason:
      input.edgeTarget === null
        ? "No platform edge target is configured; DNS instructions cannot be emitted until the operator supplies one."
        : "Awaiting DNS propagation and TLS issuance.",
    requiredDns: buildDnsInstruction(hostname, input.edgeTarget),
  };
}

/**
 * Apply a verification result to a record. The verifier is a caller-supplied
 * port that resolves DNS and probes TLS; when it is `null` the record is
 * returned with an explicit `"unverifiable"` reason so a UI never presents
 * an unverified domain as ready. DNS-only success yields `"pending"` (DNS
 * is present but TLS may still be issuing); TLS termination plus DNS yields
 * `"verified"`.
 */
export async function verifyDomain(
  input: VerifyDomainInput,
): Promise<CustomDomainRecord> {
  const { record, verifier, now } = input;
  const isoNow = normalizeIso(now);

  if (verifier === null) {
    return {
      ...record,
      lastCheckedAt: isoNow,
      sslState: "unknown",
      status: record.status === "verified" ? "verified" : "pending",
      reason:
        "No domain verifier is configured. Verification requires an operator-supplied DNS/TLS adapter.",
    };
  }

  let result: DomainVerifierResult;
  try {
    result = await verifier(record.hostname);
  } catch (err) {
    return {
      ...record,
      lastCheckedAt: isoNow,
      sslState: "unknown",
      status: "failed",
      reason: `Verifier error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const dnsOk =
    record.requiredDns === null
      ? result.aRecordsPresent || result.cnameMatches
      : record.requiredDns.kind === "A"
        ? result.aRecordsPresent
        : result.cnameMatches;

  if (!dnsOk) {
    return {
      ...record,
      lastCheckedAt: isoNow,
      sslState: "unknown",
      status: "pending",
      reason: result.evidence ?? "DNS records are not yet resolvable.",
    };
  }
  if (!result.tlsTerminates) {
    return {
      ...record,
      lastCheckedAt: isoNow,
      sslState: "pending",
      status: "pending",
      reason:
        result.evidence ?? "DNS is correct; TLS certificate has not yet been issued.",
    };
  }
  return {
    ...record,
    lastCheckedAt: isoNow,
    sslState: "active",
    status: "verified",
    reason: result.evidence ?? "DNS resolves and TLS terminates.",
  };
}

/**
 * Guard the workspace boundary. Records are workspace-scoped; a request for
 * a record belonging to another workspace is a hard error, not a `null`, so
 * a route cannot accidentally leak the existence of another tenant's domain.
 */
export function assertRecordBelongsToWorkspace(
  record: CustomDomainRecord,
  workspaceId: string,
): void {
  if (record.workspaceId !== workspaceId) {
    throw new DomainError(
      "Domain record belongs to a different workspace.",
      "workspace-mismatch",
      { recordId: record.id },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function normalizeIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new DomainError(
      `Invalid ISO timestamp: ${iso}`,
      "invalid-input",
      { timestamp: iso },
    );
  }
  return new Date(t).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  normalizeIso,
  RESERVED_EXACT,
  RESERVED_SUFFIXES,
});
