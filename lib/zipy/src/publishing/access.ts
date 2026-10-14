/**
 * Zipy AI — publishing: guide access (phase 20, batch 3).
 *
 * Decides whether a request may read a published guide, and — for
 * password-protected guides — hashes and checks the password. The module is
 * deliberately small and side-effect free: it is a policy function plus a
 * password primitive. Persistence, session binding and rate limiting live
 * with the caller (the `apps/web/src/app/p/[slug]` page and its route
 * handlers), which own the request context.
 *
 * Access models supported:
 *
 *   - `"public"` — anyone may read.
 *   - `"private"` — only members of the owning workspace, verified by the
 *     caller-supplied `SessionContext`, may read.
 *   - `"password"` — a password hash is stored on the guide; the reader
 *     supplies a `passwordAttempt`. One correct attempt (checked by
 *     `verifyGuidePassword`) grants access for the caller's session; this
 *     module does not mint or persist that session, it just answers
 *     "does this attempt match".
 *
 * Password hashing:
 *
 *   - Uses `node:crypto.scrypt` with a per-hash random salt stored alongside
 *     the derived key in a single self-describing string
 *     (`scrypt$N$r$p$saltBase64$hashBase64`). Parameters are embedded so a
 *     future upgrade of defaults does not invalidate existing hashes.
 *   - Comparison is `crypto.timingSafeEqual` on equal-length buffers; the
 *     module refuses to compare unequal-length buffers (it returns `false`
 *     rather than `timingSafeEqual`'s throw).
 *   - No plaintext password is stored or logged anywhere.
 *
 * What this module does *not* do:
 *   - It does not persist a record; the caller stores the hash produced by
 *     `hashGuidePassword`.
 *   - It does not enforce rate limiting or lockout. Those are policy
 *     decisions the route owns, because the correct threshold depends on
 *     the deployment's proxy and abuse profile.
 *   - It does not assume a session exists. A session is passed in by the
 *     caller and never invented.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AccessErrorCode = "invalid-input" | "hash-format" | "internal";

export class AccessError extends Error {
  readonly code: AccessErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: AccessErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AccessError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type GuideAccessMode = "public" | "private" | "password";

export interface GuideAccessPolicy {
  readonly mode: GuideAccessMode;
  /**
   * Password hash produced by `hashGuidePassword`. Non-null exactly when
   * `mode === "password"`; a `"password"` guide with a null hash is refused
   * at decision time (`"misconfigured"`), never treated as public.
   */
  readonly passwordHash: string | null;
}

export interface SessionContext {
  readonly userId: string;
  readonly workspaceIds: readonly string[];
  /** Optional per-user role, used by callers that also enforce RBAC. */
  readonly roles?: readonly string[];
}

export interface AccessRequest {
  readonly policy: GuideAccessPolicy;
  /** The workspace that owns the guide. */
  readonly owningWorkspaceId: string;
  /** The requester's session, or `null` when unauthenticated. */
  readonly session: SessionContext | null;
  /**
   * The reader's password attempt, when the guide is password-protected.
   * Never persisted by this module.
   */
  readonly passwordAttempt?: string | null;
}

export type AccessDecision =
  | { readonly allowed: true; readonly via: "public" | "workspace-membership" | "password" }
  | {
      readonly allowed: false;
      readonly reason:
        | "private-requires-session"
        | "not-a-member"
        | "password-required"
        | "password-incorrect"
        | "misconfigured";
    };

/* -------------------------------------------------------------------------- */
/* Password hashing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * scrypt parameters. The chosen `logN = 15` (N = 32768) with `r = 8`, `p = 1`
 * targets roughly 100 ms per derivation on a modern server CPU — slow enough
 * to make an offline dictionary attack on a stolen hash expensive, fast
 * enough that a login is imperceptible. The parameters are embedded in the
 * hash string so they can be raised for new hashes without invalidating
 * existing ones.
 */
const SCRYPT_LOG_N = 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;

const MAX_PASSWORD_LENGTH = 1024;

/**
 * A self-describing hash string:
 *   `scrypt$logN$r$p$saltBase64$keyBase64`
 * The parameter order is fixed, and the algorithm tag is present so a future
 * migration to argon2 can dispatch on it.
 */
export async function hashGuidePassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new AccessError("Password must be a non-empty string.", "invalid-input");
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AccessError(
      `Password exceeds ${MAX_PASSWORD_LENGTH} characters.`,
      "invalid-input",
    );
  }
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const key = (await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEY_LENGTH, {
    N: 1 << SCRYPT_LOG_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return [
    "scrypt",
    String(SCRYPT_LOG_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

interface ParsedHash {
  readonly logN: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseHash(hash: string): ParsedHash {
  const parts = hash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    throw new AccessError(
      "Password hash is not a valid Zipy AI scrypt hash.",
      "hash-format",
    );
  }
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(logN) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new AccessError("Password hash parameters are malformed.", "hash-format");
  }
  if (logN < 10 || logN > 22 || r < 1 || r > 16 || p < 1 || p > 8) {
    throw new AccessError("Password hash parameters are out of range.", "hash-format");
  }
  let salt: Buffer;
  let key: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    key = Buffer.from(parts[5]!, "base64");
  } catch {
    throw new AccessError("Password hash encoding is malformed.", "hash-format");
  }
  if (salt.length === 0 || key.length === 0 || key.length % 2 !== 0) {
    throw new AccessError("Password hash payload is malformed.", "hash-format");
  }
  return { logN, r, p, salt, key };
}

/**
 * Compare an attempt against a stored hash. Returns `false` (never throws)
 * on any parse failure — a corrupted hash must not surface as a crash to a
 * reader typing a password, and must not read as a match.
 */
export async function verifyGuidePassword(
  attempt: string,
  storedHash: string,
): Promise<boolean> {
  if (typeof attempt !== "string" || attempt.length === 0) return false;
  if (attempt.length > MAX_PASSWORD_LENGTH) return false;
  let parsed: ParsedHash;
  try {
    parsed = parseHash(storedHash);
  } catch {
    return false;
  }
  const derived = (await scrypt(
    attempt.normalize("NFKC"),
    parsed.salt,
    parsed.key.length,
    { N: 1 << parsed.logN, r: parsed.r, p: parsed.p },
  )) as Buffer;
  if (derived.length !== parsed.key.length) return false;
  return timingSafeEqual(derived, parsed.key);
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                    */
/* -------------------------------------------------------------------------- */

export async function decideGuideAccess(
  request: AccessRequest,
): Promise<AccessDecision> {
  const { policy, owningWorkspaceId, session, passwordAttempt } = request;

  switch (policy.mode) {
    case "public":
      return { allowed: true, via: "public" };
    case "private": {
      if (session === null) {
        return { allowed: false, reason: "private-requires-session" };
      }
      if (!session.workspaceIds.includes(owningWorkspaceId)) {
        return { allowed: false, reason: "not-a-member" };
      }
      return { allowed: true, via: "workspace-membership" };
    }
    case "password": {
      if (policy.passwordHash === null || policy.passwordHash.length === 0) {
        // A "password" guide without a hash is a configuration error; it must
        // not degrade to public.
        return { allowed: false, reason: "misconfigured" };
      }
      if (passwordAttempt === null || passwordAttempt === undefined) {
        return { allowed: false, reason: "password-required" };
      }
      const ok = await verifyGuidePassword(passwordAttempt, policy.passwordHash);
      return ok
        ? { allowed: true, via: "password" }
        : { allowed: false, reason: "password-incorrect" };
    }
    default: {
      const exhaustive: never = policy.mode;
      void exhaustive;
      return { allowed: false, reason: "misconfigured" };
    }
  }
}

/**
 * A stable, single-line label for a decision, suitable for the response
 * body or a log line. Never includes the password attempt.
 */
export function describeDecision(decision: AccessDecision): string {
  if (decision.allowed) {
    return `allowed:${decision.via}`;
  }
  return `denied:${decision.reason}`;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  parseHash,
  SCRYPT_LOG_N,
  SCRYPT_R,
  SCRYPT_P,
  MAX_PASSWORD_LENGTH,
});
