/**
 * Zipy AI — webhook signatures (phase 21, batch 1).
 *
 * Produces and verifies the HMAC-SHA256 signature attached to every outbound
 * webhook delivery. The format follows the widely-adopted `t=<unix>,v1=<hex>`
 * scheme so a receiver can implement verification with any HMAC library.
 *
 * Signing contract
 * ----------------
 * The signed payload is the concatenation `${timestamp}.${rawBody}`. Signing
 * only the body would let a captured delivery be replayed indefinitely;
 * including the timestamp lets the receiver enforce a freshness window, and
 * the receiver is expected to do so using `verifySignature`.
 *
 * Design boundaries
 * -----------------
 *  - No secret is invented. When `WEBHOOK_SIGNING_SECRET` is absent the
 *    config layer reports `webhooks.signingSecretConfigured === false` and
 *    `dispatch.ts` refuses to send an unsigned delivery rather than
 *    silently omitting the header.
 *  - Constant-time comparison via `crypto.timingSafeEqual`. Signature
 *    verification is a security boundary: a length-dependent comparison is a
 *    timing oracle.
 *  - No structured payload is signed. The caller passes the exact bytes it
 *    will send on the wire, so a receiver that hashes the raw request body
 *    computes a matching digest regardless of JSON key ordering.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SignatureErrorCode =
  | "invalid-input"
  | "missing-secret"
  | "malformed-header"
  | "signature-mismatch"
  | "timestamp-out-of-range";

export class SignatureError extends Error {
  readonly code: SignatureErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: SignatureErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SignatureError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The signature scheme version. Bumping this string is how a future
 * algorithm change is rolled out without breaking existing receivers: a
 * receiver accepts `v1` while the sender emits `v2`, then the receiver
 * removes `v1` once its own receivers have migrated.
 */
export const SIGNATURE_VERSION = "v1" as const;

/**
 * Replay window the *verifier* is expected to enforce. The sender is
 * permitted to send a delivery later than this (a retry can be hours after
 * the first attempt); a receiver that rejects a delivery must state that it
 * did, and the dispatcher records that as a failed attempt. Five minutes is
 * the conventional HTTP signature window (IETF draft-cavage-http-signatures
 * and the Stripe convention); it is exported so both sides agree on the
 * default.
 */
export const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;

export interface SignatureHeaderParts {
  readonly version: typeof SIGNATURE_VERSION;
  readonly timestamp: string;
  readonly signatureHex: string;
}

export interface VerifySignatureInput {
  /** The exact bytes the receiver read from the request body. */
  readonly body: string | Buffer;
  /** The `Zipy-Signature` header value. */
  readonly header: string;
  /** The shared secret. */
  readonly secret: string;
  /**
   * A verifier-supplied "current time" in unix seconds. Required so the
   * module has no hidden clock: tests can pin it, and a receiver with a
   * clock-skewing host can use an NTP-derived time.
   */
  readonly nowSeconds: number;
  /** Override the default replay window. */
  readonly maxSkewMs?: number;
}

export type VerifySignatureResult =
  | { readonly ok: true; readonly timestamp: string }
  | {
      readonly ok: false;
      readonly reason:
        | "malformed-header"
        | "timestamp-out-of-range"
        | "signature-mismatch";
      readonly detail: string;
    };

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the `Zipy-Signature` header value for a delivery. `timestampSeconds`
 * is the caller's clock reading (unix seconds); the module does not read the
 * system clock so the caller controls the value recorded in the receipt.
 */
export function signPayload(
  body: string | Buffer,
  secret: string,
  timestampSeconds: number,
): string {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new SignatureError(
      "signPayload requires a non-empty shared secret.",
      "missing-secret",
    );
  }
  if (typeof timestampSeconds !== "number" || !Number.isFinite(timestampSeconds)) {
    throw new SignatureError(
      "`timestampSeconds` must be a finite unix-seconds number.",
      "invalid-input",
      { received: timestampSeconds },
    );
  }
  const t = Math.floor(timestampSeconds);
  if (t < 0) {
    throw new SignatureError(
      "`timestampSeconds` must not be negative.",
      "invalid-input",
      { received: t },
    );
  }
  const bodyString = typeof body === "string" ? body : body.toString("utf8");
  const signatureHex = computeHmac(bodyString, t, secret);
  return `t=${t},${SIGNATURE_VERSION}=${signatureHex}`;
}

/**
 * Parse a `Zipy-Signature` header value into its parts. Returns `null` when
 * the header does not conform; the caller decides whether that is a hard
 * failure (a webhook receiver typically responds 401 with a reason).
 */
export function parseSignatureHeader(header: string): SignatureHeaderParts | null {
  if (typeof header !== "string" || header.length === 0) return null;
  let version: typeof SIGNATURE_VERSION | null = null;
  let timestamp: string | null = null;
  let signatureHex: string | null = null;
  for (const piece of header.split(",")) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return null;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === "t") {
      if (!/^\d+$/.test(value)) return null;
      timestamp = value;
    } else if (key === SIGNATURE_VERSION) {
      // Hex, lowercase or uppercase accepted; normalised to lowercase.
      if (!/^[0-9a-fA-F]+$/.test(value)) return null;
      signatureHex = value.toLowerCase();
      version = SIGNATURE_VERSION;
    }
  }
  if (version === null || timestamp === null || signatureHex === null) return null;
  return { version, timestamp, signatureHex };
}

/**
 * Verify a delivery's signature against the exact request body. The receiver
 * is responsible for reading the raw body (not re-serialised JSON — key
 * reordering would change the hash). Returns a discriminated result rather
 * than throwing so a receiver can respond with a structured error body.
 */
export function verifySignature(input: VerifySignatureInput): VerifySignatureResult {
  if (input === null || typeof input !== "object") {
    return {
      ok: false,
      reason: "malformed-header",
      detail: "verifySignature requires an inputs object.",
    };
  }
  const parsed = parseSignatureHeader(input.header);
  if (parsed === null) {
    return {
      ok: false,
      reason: "malformed-header",
      detail: "Zipy-Signature header is missing, empty or malformed.",
    };
  }
  if (typeof input.secret !== "string" || input.secret.length === 0) {
    return {
      ok: false,
      reason: "signature-mismatch",
      detail: "No shared secret is configured at the receiver.",
    };
  }
  const skewMs =
    typeof input.maxSkewMs === "number" && input.maxSkewMs >= 0
      ? input.maxSkewMs
      : DEFAULT_MAX_SKEW_MS;
  const sentAt = Number(parsed.timestamp);
  if (!Number.isFinite(sentAt)) {
    return {
      ok: false,
      reason: "malformed-header",
      detail: `Signature timestamp "${parsed.timestamp}" is not numeric.`,
    };
  }
  if (!Number.isFinite(input.nowSeconds)) {
    return {
      ok: false,
      reason: "malformed-header",
      detail: "`nowSeconds` must be a finite number.",
    };
  }
  const skew = Math.abs(Math.floor(input.nowSeconds) - sentAt) * 1000;
  if (skew > skewMs) {
    return {
      ok: false,
      reason: "timestamp-out-of-range",
      detail: `Delivery timestamp is ${Math.round(skew / 1000)}s old; the receiver's window is ${Math.round(skewMs / 1000)}s.`,
    };
  }
  const bodyString = typeof input.body === "string" ? input.body : input.body.toString("utf8");
  const expected = computeHmac(bodyString, sentAt, input.secret);
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(parsed.signatureHex, "hex");
  if (expectedBuf.length !== receivedBuf.length) {
    return {
      ok: false,
      reason: "signature-mismatch",
      detail: "Signature length mismatch.",
    };
  }
  if (!timingSafeEqual(expectedBuf, receivedBuf)) {
    return {
      ok: false,
      reason: "signature-mismatch",
      detail: "Signature does not match the body and secret.",
    };
  }
  return { ok: true, timestamp: parsed.timestamp };
}

/**
 * The HMAC over `${timestamp}.${body}`. Exported so a receiver in another
 * language has a single, unambiguous reference implementation to port.
 */
export function computeHmac(body: string, timestampSeconds: number, secret: string): string {
  const t = Math.floor(timestampSeconds);
  return createHmac("sha256", secret)
    .update(`${t}.`)
    .update(body)
    .digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  DEFAULT_MAX_SKEW_MS,
  computeHmac,
  parseSignatureHeader,
});
