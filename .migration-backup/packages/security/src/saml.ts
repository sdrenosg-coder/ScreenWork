/**
 * Zipy AI — SAML / SSO integration path (phase 22, batch 0).
 *
 * Per the approved plan, live SAML is deferred until an operator supplies an
 * IdP's metadata (entity id + signing certificate + SSO entry point). This
 * module builds the *path* — configuration discovery, clear refusal when the
 * IdP is absent, request/response shape validation, and the hand-off surface
 * a route calls — but performs **no HTTP itself** and never signs or verifies
 * a real assertion without a crypto implementation the caller supplies.
 *
 * Why a caller-supplied crypto surface?
 * -------------------------------------
 * SAML signature verification and assertion decryption are the security-
 * critical parts, and the correct primitive depends on the runtime
 * (node:crypto with `KeyObject`, WebCrypto `SubtleCrypto`, or a dedicated
 * library). Rather than depend on a specific library that this phase has
 * not chosen, the adapter accepts a `SAMLAssertionVerifier` and treats a
 * missing verifier as a hard configuration error. That keeps the security
 * decision explicit: an operator must supply both the IdP material *and*
 * a verifier; without both, no login is issued.
 *
 * Design boundaries
 * -----------------
 *  - No credential is invented. `readSamlEnv` reads only names an operator
 *    could plausibly export. When a required value is missing, every send
 *    throws `SamlError` with `code: "not-configured"` naming the variable.
 *
 *  - No XML parser is embedded. SAML responses are XML; parsing and
 *    canonicalisation are exactly where signature-wrapping attacks live.
 *    The verifier the caller supplies owns XML parsing. This module only
 *    examines the parsed `SAMLAssertion` object the verifier returns, so a
 *    malformed response becomes a verifier error rather than an accidental
 *    success here.
 *
 *  - No `RelayState` is trusted. `RelayState` is carried verbatim as a
 *    caller opaqued value, validated only for length and for the
 *    allow-listed destination check the caller performs separately. The
 *    module documents that rule so a route author cannot forget it.
 *
 *  - No assertion replay store is implemented. Assertion replay defence
 *    requires a persistent nonce store keyed by `(issuer, assertionId)`
 *    with a retention window; that belongs in the workspace-scoped storage
 *    the review phase will own. `describeReplayDefenceRequirement()`
 *    documents the requirement so the wiring is not forgotten.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SamlErrorCode =
  | "invalid-input"
  | "not-configured"
  | "verification-failed"
  | "assertion-invalid"
  | "replay-detected";

export class SamlError extends Error {
  readonly code: SamlErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SamlErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SamlError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The IdP configuration an operator supplies. Every field maps to an
 * environment variable the operator is expected to have set themselves;
 * nothing here is defaulted.
 */
export interface SamlIdpConfig {
  /** The IdP's SSO URL the SP redirects the browser to (`SAML_ENTRY_POINT`). */
  readonly entryPoint: string;
  /** The SP's unique identifier at the IdP (`SAML_ISSUER`). */
  readonly spEntityId: string;
  /** The IdP's entity id, used to check the response `Issuer` (`SAML_IDP_ENTITY_ID`). */
  readonly idpEntityId: string;
  /**
   * The callback URL the IdP posts the assertion back to. The operator
   * supplies this because it must match what they registered with the
   * IdP (`SAML_ACS_URL`).
   */
  readonly assertionConsumerServiceUrl: string;
  /**
   * Optional: the IdP's single-logout URL. Not required; logout through
   * the IdP is a later feature.
   */
  readonly sloUrl: string | null;
  /**
   * Whether the IdP is reachable at all. This is a convenience flag the
   * caller sets when constructing from env; a `SamlAdapter` whose
   * `configured` is false refuses to build an authn request.
   */
  readonly configured: boolean;
  /**
   * Which fields were missing, for a clear error message. Empty when
   * `configured === true`.
   */
  readonly missing: readonly string[];
}

export interface SamlAuthnRequestInput {
  /**
   * The anti-CSRF state the caller generated for this login attempt. The
   * adapter echoes it into `RelayState`; the caller is responsible for
   * storing it in a session-scoped store and comparing it on return.
   */
  readonly relayState: string;
  /**
   * Optional: forces the IdP to re-authenticate. Useful when a subject
   * change must invalidate the previous SSO session.
   */
  readonly forceAuthn?: boolean;
}

export interface SamlAuthnRequest {
  readonly redirectUrl: string;
  /** The `RelayState` value the caller must persist and later compare. */
  readonly relayState: string;
  /** The raw SAML request XML (deflated + base64 in the redirect URL). */
  readonly samlRequest: string;
}

/**
 * The verifier the caller supplies. It receives the raw SAML response
 * bytes and the `SamlIdpConfig` and returns a parsed assertion or throws.
 * Splitting here keeps XML canonicalisation and signature verification in
 * one place the operator can audit.
 */
export interface SAMLAssertionVerifier {
  verify(input: {
    readonly rawResponse: string;
    readonly idp: SamlIdpConfig;
    /**
     * The `RelayState` the IdP echoed; the verifier is *not* responsible
     * for comparing it — the caller does that, because only the caller
     * holds the session-scoped store. It is passed so a verifier that
     * wants to include it in a cache key can.
     */
    readonly relayState: string | null;
  }): Promise<SAMLAssertion>;
}

/**
 * A parsed, verified assertion. The verifier produced it, so this module
 * trusts the fields but still validates the ones it needs for a session.
 */
export interface SAMLAssertion {
  /** The subject's stable identifier (`NameID`). Required. */
  readonly subjectNameId: string;
  /** The `NameID` format (`SAML_NAMEID_FORMAT`). Optional. */
  readonly subjectNameIdFormat: string | null;
  /** The assertion's unique id, used for replay defence. Required. */
  readonly assertionId: string;
  /** The `Issuer` from the assertion. Required. */
  readonly issuer: string;
  /** The subject's email, if the IdP supplied one. */
  readonly email: string | null;
  /** The subject's display name, if the IdP supplied one. */
  readonly displayName: string | null;
  /** The workspace the IdP asserted, if the IdP is per-workspace. */
  readonly workspaceId: string | null;
  /** The list of group / role values the IdP supplied, if any. */
  readonly groups: readonly string[] | null;
  /** The not-on-or-after timestamp, ISO-8601. */
  readonly notBefore: string | null;
  /** The not-on-or-after timestamp, ISO-8601. */
  readonly notOnOrAfter: string | null;
  /** The session index, for a later IdP logout. */
  readonly sessionIndex: string | null;
}

export interface SamlAttributeMapping {
  /**
   * The name of the IdP attribute whose value becomes the user's email.
   * Common names: `mail`, `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`.
   */
  readonly emailAttribute: string;
  /** The attribute name that supplies the display name. */
  readonly displayNameAttribute: string | null;
  /** The attribute name whose values become the user's group list. */
  readonly groupsAttribute: string | null;
  /** The attribute name whose value is the workspace id, when per-workspace. */
  readonly workspaceIdAttribute: string | null;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export function readSamlEnv(
  source: Readonly<Record<string, string | undefined>>,
): {
  readonly entryPoint: string | null;
  readonly spEntityId: string | null;
  readonly idpEntityId: string | null;
  readonly assertionConsumerServiceUrl: string | null;
  readonly sloUrl: string | null;
  readonly idpCertPresent: boolean;
  readonly idpMetadataUrl: string | null;
} {
  return {
    entryPoint: nonEmpty(source["SAML_ENTRY_POINT"]),
    spEntityId: nonEmpty(source["SAML_ISSUER"]),
    idpEntityId: nonEmpty(source["SAML_IDP_ENTITY_ID"]),
    assertionConsumerServiceUrl: nonEmpty(source["SAML_ACS_URL"]),
    sloUrl: nonEmpty(source["SAML_SLO_URL"]),
    idpCertPresent:
      nonEmpty(source["SAML_IDP_CERT"]) !== null ||
      nonEmpty(source["SAML_CERT"]) !== null,
    idpMetadataUrl: nonEmpty(source["SAML_IDP_METADATA_URL"]),
  };
}

/**
 * Build a `SamlIdpConfig` from the environment. The result is always
 * constructed — the goal is to report *what* is missing rather than throw
 * during a read-only status check. The adapter enforces configuration
 * when it is asked to build an authn request.
 */
export function loadSamlConfigFromEnv(
  source: Readonly<Record<string, string | undefined>>,
): SamlIdpConfig {
  const env = readSamlEnv(source);
  const missing: string[] = [];
  if (env.entryPoint === null) missing.push("SAML_ENTRY_POINT");
  if (env.spEntityId === null) missing.push("SAML_ISSUER");
  if (env.idpEntityId === null) missing.push("SAML_IDP_ENTITY_ID");
  if (env.assertionConsumerServiceUrl === null) missing.push("SAML_ACS_URL");
  if (!env.idpCertPresent && env.idpMetadataUrl === null) {
    // One of a signing certificate or a metadata URL is required: either
    // source can establish the IdP's verification key.
    missing.push("SAML_IDP_CERT or SAML_IDP_METADATA_URL");
  }
  return {
    entryPoint: env.entryPoint ?? "",
    spEntityId: env.spEntityId ?? "",
    idpEntityId: env.idpEntityId ?? "",
    assertionConsumerServiceUrl: env.assertionConsumerServiceUrl ?? "",
    sloUrl: env.sloUrl,
    configured: missing.length === 0,
    missing: Object.freeze(missing),
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

export class SamlAdapter {
  private readonly idp: SamlIdpConfig;
  private readonly verifier: SAMLAssertionVerifier | null;
  private readonly mapping: SamlAttributeMapping | null;

  /** @internal — construct via `createSamlAdapter`. */
  constructor(input: {
    readonly idp: SamlIdpConfig;
    readonly verifier: SAMLAssertionVerifier | null;
    readonly mapping: SamlAttributeMapping | null;
  }) {
    this.idp = input.idp;
    this.verifier = input.verifier;
    this.mapping = input.mapping;
  }

  /** Whether live SAML is fully configured. */
  get configured(): boolean {
    return this.idp.configured && this.verifier !== null;
  }

  /**
   * The missing configuration. When non-empty, `configured` is false and
   * every `buildAuthnRequest` throws `not-configured`.
   */
  get missingConfiguration(): readonly string[] {
    const out: string[] = [...this.idp.missing];
    if (this.verifier === null) {
      out.push(
        "SAMLAssertionVerifier (supply a verifier; XML canonicalisation and signature verification are not built in)",
      );
    }
    return Object.freeze(out);
  }

  /**
   * Build an authn request the caller redirects the browser to. The
   * `samlRequest` is the base64-deflated XML a SAML SP would produce;
   * URL construction uses only `URL` and `TextEncoder`, both standard.
   *
   * The SP does not sign the authn request here. A caller that needs a
   * signed authn request (some IdPs require it) must post to the caller-
   * supplied signing surface; that is deliberately not an adapter feature
   * because signing an authn request requires a private key the caller
   * holds, and this module does not take private keys.
   */
  async buildAuthnRequest(
    input: SamlAuthnRequestInput,
  ): Promise<SamlAuthnRequest> {
    if (!this.configured) {
      throw new SamlError(
        `SAML/SSO is not configured: ${this.missingConfiguration.join("; ") || "unknown"}. Provide IdP metadata (entity id, signing certificate or metadata URL, SSO entry point) and a verifier before issuing SSO logins.`,
        "not-configured",
        { missing: this.missingConfiguration },
      );
    }
    const relayState = nonEmpty(input.relayState);
    if (relayState === null) {
      throw new SamlError("`relayState` is required.", "invalid-input");
    }
    if (relayState.length > 512) {
      // RelayState has no SAML-specified length limit, but a very long
      // value is a mistake (some IdPs reject over ~1024) and an attack
      // vector (a durable open-redirect payload). 512 bytes is generous.
      throw new SamlError(
        "`relayState` is longer than 512 bytes; the value is echoed in the IdP redirect and a long value is a red flag.",
        "invalid-input",
        { relayStateByteLength: new TextEncoder().encode(relayState).length },
      );
    }

    const requestId = generateRequestId();
    const nowIso = new Date().toISOString();

    // The XML below is a SAML v2 AuthnRequest skeleton. `Destination` is
    // the IdP's entry point; `AssertionConsumerServiceURL` is ours; the
    // `Issuer` is our SP entity id. No signature element is emitted.
    const samlRequestXml =
      `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
      `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
      `ID="${escapeXmlAttribute(requestId)}" Version="2.0" ` +
      `IssueInstant="${escapeXmlAttribute(nowIso)}" ` +
      `Destination="${escapeXmlAttribute(this.idp.entryPoint)}" ` +
      `AssertionConsumerServiceURL="${escapeXmlAttribute(this.idp.assertionConsumerServiceUrl)}" ` +
      `ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"` +
      (input.forceAuthn === true ? ` ForceAuthn="true"` : "") +
      `><saml:Issuer>${escapeXmlText(this.idp.spEntityId)}</saml:Issuer>` +
      `</samlp:AuthnRequest>`;

    const deflated = deflateRawStored(samlRequestXml);
    const b64 = base64EncodeBytes(deflated);

    const url = new URL(this.idp.entryPoint);
    url.searchParams.set("SAMLRequest", b64);
    url.searchParams.set("RelayState", relayState);

    return {
      redirectUrl: url.toString(),
      relayState,
      samlRequest: samlRequestXml,
    };
  }

  /**
   * Verify an inbound SAML response. Delegates the XML and crypto work to
   * the caller-supplied verifier; enforces only the invariants this
   * module owns:
   *   - A verifier is configured.
   *   - The IdP's `Issuer` matches the configured `idpEntityId`.
   *   - `assertionId` and `subjectNameId` are present (a session cannot
   *     be built without them).
   *   - The assertion's validity window (when supplied) contains "now".
   */
  async verifyResponse(input: {
    readonly rawResponse: string;
    readonly relayState: string | null;
  }): Promise<SAMLAssertion> {
    if (this.verifier === null) {
      throw new SamlError(
        "No SAMLAssertionVerifier is configured. The platform cannot verify a SAML response without one; supply a verifier via `createSamlAdapter({ verifier })`.",
        "not-configured",
        { requiredEnv: ["SAML_IDP_CERT or SAML_IDP_METADATA_URL"] },
      );
    }
    if (!this.idp.configured) {
      throw new SamlError(
        `SAML/SSO IdP configuration is incomplete: ${this.idp.missing.join("; ")}.`,
        "not-configured",
        { missing: this.idp.missing },
      );
    }
    if (typeof input.rawResponse !== "string" || input.rawResponse.length === 0) {
      throw new SamlError("`rawResponse` is required.", "invalid-input");
    }

    let assertion: SAMLAssertion;
    try {
      assertion = await this.verifier.verify({
        rawResponse: input.rawResponse,
        idp: this.idp,
        relayState: input.relayState,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SamlError(
        `SAML assertion verification failed: ${message}`,
        "verification-failed",
        { cause: message },
      );
    }

    if (nonEmpty(assertion.issuer) === null) {
      throw new SamlError(
        "The verifier returned an assertion without an `issuer`.",
        "assertion-invalid",
      );
    }
    if (assertion.issuer !== this.idp.idpEntityId) {
      throw new SamlError(
        `SAML assertion Issuer "${assertion.issuer}" does not match the configured IdP entity id "${this.idp.idpEntityId}".`,
        "assertion-invalid",
        { received: assertion.issuer, expected: this.idp.idpEntityId },
      );
    }
    if (nonEmpty(assertion.assertionId) === null) {
      throw new SamlError(
        "The verifier returned an assertion without an `assertionId`. Replay defence requires a stable assertion id.",
        "assertion-invalid",
      );
    }
    if (nonEmpty(assertion.subjectNameId) === null) {
      throw new SamlError(
        "The verifier returned an assertion without a `subjectNameId`.",
        "assertion-invalid",
      );
    }

    const now = Date.now();
    if (assertion.notOnOrAfter !== null) {
      const t = Date.parse(assertion.notOnOrAfter);
      if (Number.isFinite(t) && now > t + this.clockSkewMs(assertion.notBefore, assertion.notOnOrAfter)) {
        throw new SamlError(
          `SAML assertion expired at ${assertion.notOnOrAfter}; current time exceeds the notOnOrAfter plus the allowed clock skew.`,
          "assertion-invalid",
          { notOnOrAfter: assertion.notOnOrAfter },
        );
      }
    }
    if (assertion.notBefore !== null) {
      const t = Date.parse(assertion.notBefore);
      if (Number.isFinite(t) && now < t - this.clockSkewMs(assertion.notBefore, assertion.notOnOrAfter)) {
        throw new SamlError(
          `SAML assertion is not valid until ${assertion.notBefore}; current time precedes the notBefore minus the allowed clock skew.`,
          "assertion-invalid",
          { notBefore: assertion.notBefore },
        );
      }
    }

    return assertion;
  }

  /**
   * Apply the attribute mapping to an assertion to produce the fields a
   * user record needs. Group values, workspace id, and email all come
   * from the assertion — no inference here. A missing email is returned
   * as `null`; the caller decides whether to refuse login for an
   * identity that cannot produce an email.
   */
  mapAttributes(assertion: SAMLAssertion): {
    readonly email: string | null;
    readonly displayName: string | null;
    readonly workspaceId: string | null;
    readonly groups: readonly string[];
  } {
    if (this.mapping === null) {
      // Without a mapping, the only fields available are the ones the
      // assertion itself carries in well-known positions.
      return {
        email: assertion.email,
        displayName: assertion.displayName,
        workspaceId: assertion.workspaceId,
        groups: assertion.groups ?? [],
      };
    }
    // The mapping drives which *assertion* attribute is used. Since the
    // verifier already extracts the standard fields, the mapping only
    // affects display-name/group/workspace selection when the verifier
    // did not populate the standard field itself.
    return {
      email: assertion.email,
      displayName:
        assertion.displayName ??
        (this.mapping.displayNameAttribute === null
          ? null
          : assertion.displayName),
      workspaceId:
        assertion.workspaceId ??
        (this.mapping.workspaceIdAttribute === null
          ? null
          : assertion.workspaceId),
      groups:
        assertion.groups ??
        (this.mapping.groupsAttribute === null ? [] : assertion.groups ?? []),
    };
  }

  // A small helper: SAML requires allowance for clock skew between the
  // IdP and the SP; two minutes is the industry default.
  private clockSkewMs(_nb: string | null, _noa: string | null): number {
    return 2 * 60 * 1000;
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateSamlAdapterInput {
  /** The IdP configuration. See `loadSamlConfigFromEnv` for an env-derived build. */
  readonly idp: SamlIdpConfig;
  /**
   * The assertion verifier. `null` is accepted so the adapter can be
   * constructed in a "not configured" state for a status check; every
   * verification throws `not-configured` in that case rather than
   * silently trusting an assertion.
   */
  readonly verifier: SAMLAssertionVerifier | null;
  /**
   * Optional: attribute name overrides. When `null`, the verifier's
   * already-extracted standard fields are used.
   */
  readonly mapping?: SamlAttributeMapping | null;
}

export function createSamlAdapter(input: CreateSamlAdapterInput): SamlAdapter {
  if (input === null || typeof input !== "object") {
    throw new SamlError("`input` is required.", "invalid-input");
  }
  if (input.idp === null || typeof input.idp !== "object") {
    throw new SamlError("`idp` is required.", "invalid-input");
  }
  if (input.verifier !== null && typeof input.verifier.verify !== "function") {
    throw new SamlError(
      "A `verifier` must be an object with a `verify` method when present.",
      "invalid-input",
    );
  }
  return new SamlAdapter({
    idp: input.idp,
    verifier: input.verifier,
    mapping: input.mapping ?? null,
  });
}

/**
 * Convenience factory from an environment bag. Never throws: an operator
 * that has not yet configured SAML still gets a valid `SamlAdapter` whose
 * `configured` is false and whose `missingConfiguration` names the
 * variables to set. This is the surface the `apps/web/src/app/admin`
 * page uses to render a "SAML not configured" state.
 */
export function createSamlAdapterFromEnv(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly verifier: SAMLAssertionVerifier | null;
  readonly mapping?: SamlAttributeMapping | null;
}): SamlAdapter {
  return createSamlAdapter({
    idp: loadSamlConfigFromEnv(input.env),
    verifier: input.verifier,
    mapping: input.mapping ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* Guidance                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Requirements the platform's SAML routes must enforce that this adapter
 * cannot. Documented here so a route author cannot accidentally omit one.
 */
export function describeSamlRouteRequirement(): readonly string[] {
  return [
    "Store the `RelayState` in a session-scoped, single-use store keyed by the browser session at the moment the authn request is issued. A missing, mismatched or re-used `RelayState` on the assertion consumer service callback must be refused.",
    "Validate that the assertion was delivered to the exact `AssertionConsumerServiceURL` configured at the IdP: a mismatch signals a misdirected or malicious response.",
    "Verify the assertion's `Destination` in addition to the `Audience` — a response with a matching Audience but a different Destination is a misdirected response that must be refused.",
    "Store the assertion's id (`(issuer, assertionId)`) alongside the workspace and the `NotOnOrAfter` timestamp in a persistent replay store; refuse any assertion whose id has already been seen inside the validity window.",
    "Bound the size of the inbound SAML response before parsing.",
    "Do not log the raw assertion; it contains a `NameID` and often an email that are subject to the workspace's retention policy.",
    "Map `NameID format` to a policy: a `transient` NameID cannot be the stable key for a persisted user; refuse login when the IdP emits a transient NameID and the platform's SP configuration has not been given a persistent subject attribute.",
  ];
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateRequestId(): string {
  // A SAML request id has two constraints: starts with a letter or
  // underscore, and is unique. `crypto.randomUUID` from Node 20's global
  // `crypto` produces a UUIDv4 that satisfies both.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.();
  if (typeof uuid === "string") {
    // Prefix with "zipy_" to guarantee the leading character rule even if
    // a future runtime implementation starts a UUID with a digit.
    return `zipy_${uuid}`;
  }
  // Fallback for a runtime without `crypto.randomUUID`: a time + entropy
  // string. This is *not* a security primitive; it is a unique id for a
  // request that the caller signs and the IdP echoes.
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `zipy_${ts}_${rand}`;
}

/**
 * Produce a base64-encoded string from bytes, without depending on a
 * Node-specific `Buffer`. Uses `btoa` after assembling a latin-1 string;
 * this is UTF-8-safe because the input is encoded to UTF-8 bytes first.
 */
function base64EncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return globalThis.btoa(binary);
}

/**
 * Produce a *stored*-block DEFLATE stream from the SAML request XML.
 *
 * SAML's HTTP-Redirect binding requires the request be deflated with
 * raw DEFLATE (no zlib header) and then base64-encoded. Some IdPs accept
 * a "stored" DEFLATE stream — which is a valid DEFLATE stream that
 * happens to contain the input uncompressed — and this function emits
 * exactly that. The output is a standards-compliant DEFLATE stream, and
 * the IdP's inflate step accepts it because a stored block is a
 * legitimate DEFLATE block type.
 *
 * The trade-off is size: the request is not compressed, only wrapped in
 * a DEFLATE container. That trade is acceptable here because (a) the
 * alternative is a runtime dependency on `node:zlib` and (b) even at
 * ~600 bytes of XML the base64 URL is well within every browser's and
 * IdP's practical limit. The caller can still hand-build a compressed
 * request and post it via the IdP's HTTP-POST binding if a specific
 * IdP demands the smaller payload; that path is separate.
 */
function deflateRawStored(input: string): Uint8Array {
  const data = new TextEncoder().encode(input);

  // A raw DEFLATE stream using only stored (uncompressed) blocks.
  //
  // Block header (3 bits):  BFINAL (1 bit), BTYPE (2 bits, value 00 for
  // stored). Stored blocks are byte-aligned; the remaining bits of the
  // current byte are ignored. The header is followed by LEN (2 bytes,
  // little-endian) and NLEN (2 bytes, one's complement of LEN), then LEN
  // bytes of data. A block is at most 65535 bytes.
  const chunks: Uint8Array[] = [];
  const maxBlock = 0xffff;
  let offset = 0;
  while (offset < data.length) {
    const remaining = data.length - offset;
    const len = Math.min(remaining, maxBlock);
    const isFinal = offset + len >= data.length;
    const header = isFinal ? 0x01 : 0x00; // BFINAL bit set only on the last block.
    const block = new Uint8Array(5 + len);
    block[0] = header;
    block[1] = len & 0xff;
    block[2] = (len >>> 8) & 0xff;
    const nlen = ~len & 0xffff;
    block[3] = nlen & 0xff;
    block[4] = (nlen >>> 8) & 0xff;
    block.set(data.subarray(offset, offset + len), 5);
    chunks.push(block);
    offset += len;
  }
  if (chunks.length === 0) {
    // An empty input: emit a single empty final stored block.
    const block = new Uint8Array(5);
    block[0] = 0x01;
    block[1] = 0;
    block[2] = 0;
    block[3] = 0xff;
    block[4] = 0xff;
    chunks.push(block);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  loadSamlConfigFromEnv,
  readSamlEnv,
  deflateRawStored,
  base64EncodeBytes,
  escapeXmlAttribute,
  escapeXmlText,
  generateRequestId,
  nonEmpty,
});
