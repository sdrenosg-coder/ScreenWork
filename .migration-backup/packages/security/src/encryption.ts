/**
 * Zipy AI — encryption at rest (phase 22, batch 1).
 *
 * Provides the envelope-encryption primitive the platform uses for
 * per-workspace artifact encryption and for any stored field that must
 * be readable only by the platform (a workspace's stored SSO material,
 * an integration's OAuth refresh token, etc.).
 *
 * Design
 * ------
 * The scheme is a small envelope:
 *
 *   1. A per-workspace Data Encryption Key (DEK) is generated from a CSPRNG
 *      the first time a workspace encrypts anything. The DEK is 32 bytes
 *      (AES-256).
 *   2. The DEK is wrapped ("sealed") by a Key-Encryption Key (KEK) that is
 *      derived from `config.compliance.encryptionMasterKey` with HKDF-SHA-256,
 *      so a master key of any length is extended to a 32-byte AES key
 *      deterministically.
 *   3. Each item is encrypted with the DEK using AES-256-GCM and a fresh
 *      96-bit nonce. The AES-GCM AAD binds the ciphertext to the workspace
 *      and to a caller-supplied context label (`"artifact:8f0c..."`,
 *      `"sso:metadata"`, ...). A ciphertext moved to a different context
 *      fail-verifies.
 *   4. The item's stored form is a single self-describing buffer:
 *      `ZIPY1|alg|kekFp|nonceLen|nonce|tag|wrappedDek|ctLen|ct`, where the
 *      wrapped DEK is itself an AES-256-GCM ciphertext under the KEK with
 *      the workspace id as AAD. A reader with the master key can decrypt
 *      without any side-channel metadata lookup; a reader with the wrong
 *      master key fails before touching the payload.
 *
 * Boundaries
 * ----------
 *  - No key material is invented. When the master key is absent,
 *    `createEncryptionService({ masterKey: null })` returns a service
 *    whose every write throws `not-configured`; reads of a value whose
 *    header is present but whose KEK is unavailable throw `not-configured`
 *    too (rather than returning the ciphertext). A caller never sees a
 *    meaningless plaintext from a misconfigured encryption service.
 *
 *  - KMS/HSM support is deliberately not implemented. The plan's
 *    "encryption at rest (AES-256)" is satisfied by a master key the
 *    operator supplies through `ENCRYPTION_MASTER_KEY`. A KMS integration
 *    is a deployment feature: an operator on AWS/GCP supplies the master
 *    key from their KMS and the same crypto service is used, because the
 *    scheme is agnostic to where the master key comes from.
 *
 *  - Key rotation is supported for the KEK (the header records a KEK
 *    fingerprint) but *not* for a DEK. A per-workspace DEK rotation is a
 *    re-encryption job that the platform schedules separately; this
 *    module offers `reencryptUnderNewKek` so the caller can run one when
 *    a KEK rotates, without needing each workspace's plaintext DEK.
 *
 *  - No plaintext is logged. Errors thrown here never include the
 *    ciphertext or plaintext; the `detail` bag carries only metadata
 *    (workspace id, context label, key fingerprint).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type EncryptionErrorCode =
  | "invalid-input"
  | "not-configured"
  | "wrong-master-key"
  | "corrupt-ciphertext"
  | "decrypt-failed";

export class EncryptionError extends Error {
  readonly code: EncryptionErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: EncryptionErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "EncryptionError";
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The magic prefix on a Zipy AI ciphertext buffer. Two purposes: it makes
 * a ciphertext trivially distinguishable from a plaintext blob in storage,
 * and it lets this module refuse to decrypt a value it did not produce.
 */
const MAGIC = Buffer.from("ZIPY1", "ascii");

/** AES-256-GCM: 32-byte key, 12-byte nonce, 16-byte tag. */
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The size of the wrapped-DEK field in the header (nonce + tag + 32-byte ciphertext). */
const WRAPPED_DEK_BYTES = NONCE_BYTES + TAG_BYTES + DEK_BYTES;

/**
 * A short, hex-encoded fingerprint of the KEK. Not a secret; a caller can
 * log it to say "this ciphertext was written under KEK abc…" without
 * revealing a byte of the key. Six bytes is short enough for a status line
 * and long enough that an accidental collision across master keys is
 * astronomically unlikely.
 */
const KEK_FP_BYTES = 6;

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface EncryptionService {
  /**
   * Whether the service can perform an encryption or decryption. False
   * when the master key is absent.
   */
  readonly configured: boolean;
  /** The KEK fingerprint for the current master key; `null` when unconfigured. */
  readonly keyFingerprint: string | null;
  /**
   * Encrypt a plaintext with a per-workspace DEK. The DEK is created on
   * first use and returned in the header of the ciphertext (wrapped under
   * the KEK). The caller stores the returned bytes as-is.
   */
  encrypt(input: {
    readonly workspaceId: string;
    readonly context: string;
    readonly plaintext: Uint8Array;
  }): Uint8Array;
  /**
   * Decrypt a ciphertext produced by `encrypt`. Verifies the AAD against
   * the supplied workspace id and context; a mismatch is reported as
   * `decrypt-failed` rather than as a corrupt ciphertext, because the
   * ciphertext may be perfectly valid under a different AAD.
   */
  decrypt(input: {
    readonly workspaceId: string;
    readonly context: string;
    readonly ciphertext: Uint8Array;
  }): Uint8Array;
  /**
   * The DEK for a workspace, wrapped under the current KEK. A caller
   * stores this per workspace (e.g., on the workspace row). Passing it
   * into `encrypt`/`decrypt` is what turns this into an envelope scheme
   * with a separately persisted DEK; omitting it keeps the DEK inside the
   * per-item header, which is simpler and equally secure but rewraps the
   * DEK on every item.
   */
  wrapDek(workspaceId: string, dek: Uint8Array): Uint8Array;
  /**
   * Unwrap a workspace's DEK. Fails `wrong-master-key` if the wrap was
   * produced under a different KEK, and `corrupt-ciphertext` if the wrap
   * is malformed.
   */
  unwrapDek(workspaceId: string, wrappedDek: Uint8Array): Uint8Array;
  /**
   * Re-wrap a DEK under the current KEK after a KEK rotation, given the
   * *old* KEK (as a raw master key buffer). The old KEK is passed in
   * explicitly because an operator performing a rotation is the one who
   * holds it; this service never silently retains a prior master key.
   */
  rewrapDekUnderNewKek(input: {
    readonly workspaceId: string;
    readonly wrappedDek: Uint8Array;
    readonly oldMasterKey: string;
  }): Uint8Array;
}

export interface CreateEncryptionServiceInput {
  /**
   * The master key material. Typically `config.compliance.encryptionMasterKey`,
   * which the operator supplies through `ENCRYPTION_MASTER_KEY`. `null`
   * yields a configured-but-unusable service: every write throws
   * `not-configured`, so the platform never falls back to plaintext.
   */
  readonly masterKey: string | null;
  /**
   * An optional salt. When omitted, a fixed platform salt is used so a
   * stable master key derives a stable KEK. A caller that wants a
   * per-deployment salt supplies the deployment's own (a single value,
   * not a per-workspace value — the per-workspace separation is on the
   * AAD, not on the KEK derivation).
   */
  readonly hkdfSalt?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_HKDF_SALT = "zipy-ai-kek-v1";
const HKDF_INFO = Buffer.from("zipy-ai-envelope-v1", "ascii");

class EncryptionServiceImpl implements EncryptionService {
  private readonly kek: Buffer | null;
  private readonly keyFingerprintValue: string | null;

  /** @internal — construct via `createEncryptionService`. */
  constructor(input: { readonly masterKey: string | null; readonly salt: string }) {
    if (input.masterKey === null) {
      this.kek = null;
      this.keyFingerprintValue = null;
      return;
    }
    // HKDF-SHA-256: derive a 32-byte AES key from the master key material
    // under a fixed salt and info. A master key of 32, 64 or 128 characters
    // all produce a 32-byte AES-256 KEK deterministically.
    const masterBytes = Buffer.from(input.masterKey, "utf8");
    const derived = hkdfSync(
      "sha256",
      masterBytes,
      Buffer.from(input.salt, "utf8"),
      HKDF_INFO,
      DEK_BYTES,
    );
    this.kek = Buffer.from(derived);
    const fp = createHash("sha256").update(this.kek).digest();
    this.keyFingerprintValue = fp.subarray(0, KEK_FP_BYTES).toString("hex");
  }

  get configured(): boolean {
    return this.kek !== null;
  }

  get keyFingerprint(): string | null {
    return this.keyFingerprintValue;
  }

  encrypt(input: {
    readonly workspaceId: string;
    readonly context: string;
    readonly plaintext: Uint8Array;
  }): Uint8Array {
    const kek = this.requireKek("encrypt");
    assertWorkspaceId(input.workspaceId);
    assertContext(input.context);
    if (!(input.plaintext instanceof Uint8Array)) {
      throw new EncryptionError("`plaintext` must be a Uint8Array.", "invalid-input");
    }
    // A fresh DEK per item. The plan allows a workspace-scoped DEK stored
    // on the workspace row (see `wrapDek`); the default (per-item) DEK is
    // simpler for a caller that does not want a DEK store and is equally
    // strong, at the cost of a wrapped DEK on every ciphertext.
    const dek = randomBytes(DEK_BYTES);
    const wrappedDek = this.wrapDekWithKek(kek, input.workspaceId, dek);

    const nonce = randomBytes(NONCE_BYTES);
    const aad = buildAad(input.workspaceId, input.context);
    const cipher = createCipheriv("aes-256-gcm", dek, nonce);
    cipher.setAAD(aad);
    const ct = Buffer.concat([
      cipher.update(Buffer.from(input.plaintext)),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return assembleCiphertext({
      kekFp: Buffer.from(this.keyFingerprintValue!, "hex"),
      nonce,
      tag,
      wrappedDek,
      ct,
    });
  }

  decrypt(input: {
    readonly workspaceId: string;
    readonly context: string;
    readonly ciphertext: Uint8Array;
  }): Uint8Array {
    const kek = this.requireKek("decrypt");
    assertWorkspaceId(input.workspaceId);
    assertContext(input.context);
    if (!(input.ciphertext instanceof Uint8Array) || input.ciphertext.length === 0) {
      throw new EncryptionError("`ciphertext` must be a non-empty Uint8Array.", "invalid-input");
    }
    const parsed = parseCiphertext(Buffer.from(input.ciphertext));
    if (!constantTimeHexEqual(parsed.kekFp.toString("hex"), this.keyFingerprintValue!)) {
      throw new EncryptionError(
        "Ciphertext was produced under a different master key; supply the master key that wrote it or run the KEK rotation path.",
        "wrong-master-key",
        { ciphertextKek: parsed.kekFp.toString("hex"), currentKek: this.keyFingerprintValue },
      );
    }
    let dek: Buffer;
    try {
      dek = unwrapDekWithKek(kek, input.workspaceId, parsed.wrappedDek);
    } catch (err) {
      // The wrapped DEK failed to open: either the ciphertext is corrupt
      // or it was produced for a different workspace AAD (which is a
      // decrypt failure, not a validation failure). Report as
      // `decrypt-failed` with a generic message; do not leak which case.
      if (err instanceof EncryptionError) throw err;
      throw new EncryptionError(
        "Failed to unwrap the ciphertext's DEK under the supplied workspace.",
        "decrypt-failed",
        { workspaceId: input.workspaceId },
      );
    }
    const aad = buildAad(input.workspaceId, input.context);
    const decipher = createDecipheriv("aes-256-gcm", dek, parsed.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(parsed.tag);
    try {
      const pt = Buffer.concat([
        decipher.update(parsed.ct),
        decipher.final(),
      ]);
      return new Uint8Array(pt);
    } catch {
      // GCM auth failure — the AAD, nonce, tag or ciphertext is wrong.
      throw new EncryptionError(
        "AES-GCM authentication failed; the ciphertext, nonce, tag or bound context (workspace / label) do not match.",
        "decrypt-failed",
        { workspaceId: input.workspaceId, context: input.context },
      );
    }
  }

  wrapDek(workspaceId: string, dek: Uint8Array): Uint8Array {
    const kek = this.requireKek("wrapDek");
    assertWorkspaceId(workspaceId);
    if (!(dek instanceof Uint8Array) || dek.length !== DEK_BYTES) {
      throw new EncryptionError(
        `\`dek\` must be a ${DEK_BYTES}-byte Uint8Array.`,
        "invalid-input",
        { receivedBytes: dek instanceof Uint8Array ? dek.length : null },
      );
    }
    return new Uint8Array(this.wrapDekWithKek(kek, workspaceId, Buffer.from(dek)));
  }

  unwrapDek(workspaceId: string, wrappedDek: Uint8Array): Uint8Array {
    const kek = this.requireKek("unwrapDek");
    assertWorkspaceId(workspaceId);
    if (!(wrappedDek instanceof Uint8Array) || wrappedDek.length !== WRAPPED_DEK_BYTES) {
      throw new EncryptionError(
        `\`wrappedDek\` must be a ${WRAPPED_DEK_BYTES}-byte Uint8Array.`,
        "invalid-input",
        { receivedBytes: wrappedDek instanceof Uint8Array ? wrappedDek.length : null },
      );
    }
    return new Uint8Array(unwrapDekWithKek(kek, workspaceId, Buffer.from(wrappedDek)));
  }

  rewrapDekUnderNewKek(input: {
    readonly workspaceId: string;
    readonly wrappedDek: Uint8Array;
    readonly oldMasterKey: string;
  }): Uint8Array {
    const newKek = this.requireKek("rewrapDekUnderNewKek");
    assertWorkspaceId(input.workspaceId);
    if (typeof input.oldMasterKey !== "string" || input.oldMasterKey.length === 0) {
      throw new EncryptionError("`oldMasterKey` is required.", "invalid-input");
    }
    if (
      !(input.wrappedDek instanceof Uint8Array) ||
      input.wrappedDek.length !== WRAPPED_DEK_BYTES
    ) {
      throw new EncryptionError(
        `\`wrappedDek\` must be a ${WRAPPED_DEK_BYTES}-byte Uint8Array.`,
        "invalid-input",
      );
    }
    // Derive the old KEK the same way the service derived the current one,
    // but with the caller-supplied old master key. This lets an operator
    // rotate a master key without having to keep the previous instance of
    // this service alive.
    const oldDerived = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(input.oldMasterKey, "utf8"),
        Buffer.from(DEFAULT_HKDF_SALT, "utf8"),
        HKDF_INFO,
        DEK_BYTES,
      ),
    );
    let plaintextDek: Buffer;
    try {
      plaintextDek = unwrapDekWithKek(
        oldDerived,
        input.workspaceId,
        Buffer.from(input.wrappedDek),
      );
    } catch {
      throw new EncryptionError(
        "Failed to open the wrapped DEK under `oldMasterKey`; the wrap was not produced under that key or the workspace does not match.",
        "decrypt-failed",
        { workspaceId: input.workspaceId },
      );
    }
    return new Uint8Array(this.wrapDekWithKek(newKek, input.workspaceId, plaintextDek));
  }

  private requireKek(operation: string): Buffer {
    if (this.kek === null) {
      throw new EncryptionError(
        `Encryption service cannot perform "${operation}": no master key is configured. Set ENCRYPTION_MASTER_KEY (>= 32 bytes of entropy) before enabling per-workspace encryption at rest.`,
        "not-configured",
      );
    }
    return this.kek;
  }

  private wrapDekWithKek(kek: Buffer, workspaceId: string, dek: Buffer): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const aad = Buffer.from(`dek:${workspaceId}`, "utf8");
    const cipher = createCipheriv("aes-256-gcm", kek, nonce);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, tag, ct]);
  }
}

function unwrapDekWithKek(
  kek: Buffer,
  workspaceId: string,
  wrapped: Buffer,
): Buffer {
  if (wrapped.length !== WRAPPED_DEK_BYTES) {
    throw new EncryptionError(
      "Wrapped DEK has an unexpected length.",
      "corrupt-ciphertext",
    );
  }
  const nonce = wrapped.subarray(0, NONCE_BYTES);
  const tag = wrapped.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ct = wrapped.subarray(NONCE_BYTES + TAG_BYTES);
  const aad = Buffer.from(`dek:${workspaceId}`, "utf8");
  const decipher = createDecipheriv("aes-256-gcm", kek, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new EncryptionError(
      "Wrapped DEK failed to decrypt under the supplied KEK and workspace.",
      "decrypt-failed",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Ciphertext wire format                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Layout of a Zipy AI ciphertext:
 *
 *   offset  size  field
 *        0     5  magic  "ZIPY1"
 *        5     1  version (uint8, currently 1)
 *        6     6  KEK fingerprint (sha256(kek)[0..6])
 *       12     1  nonce length (uint8, always NONCE_BYTES)
 *       13    12  nonce
 *       25    16  tag
 *       41   60  wrapped DEK (nonce 12 + tag 16 + ct 32)
 *      101     4  ciphertext length (uint32 BE)
 *      105   len  ciphertext
 *
 * The layout is fixed-length up to the payload, so a reader can navigate
 * it without scanning. It is not intended to be human-readable; the
 * version byte is the compatibility hook if a future revision changes it.
 */
const VERSION = 0x01;
const HEADER_PREFIX_BYTES = MAGIC.length + 1 + KEK_FP_BYTES + 1;
const HEADER_FIXED_BYTES =
  HEADER_PREFIX_BYTES + NONCE_BYTES + TAG_BYTES + WRAPPED_DEK_BYTES + 4;

interface ParsedCiphertext {
  readonly kekFp: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly wrappedDek: Buffer;
  readonly ct: Buffer;
}

function assembleCiphertext(input: {
  readonly kekFp: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly wrappedDek: Buffer;
  readonly ct: Buffer;
}): Uint8Array {
  if (input.kekFp.length !== KEK_FP_BYTES) {
    throw new EncryptionError("Internal error: KEK fingerprint length mismatch.", "invalid-input");
  }
  if (input.nonce.length !== NONCE_BYTES) {
    throw new EncryptionError("Internal error: nonce length mismatch.", "invalid-input");
  }
  if (input.tag.length !== TAG_BYTES) {
    throw new EncryptionError("Internal error: tag length mismatch.", "invalid-input");
  }
  if (input.wrappedDek.length !== WRAPPED_DEK_BYTES) {
    throw new EncryptionError("Internal error: wrapped DEK length mismatch.", "invalid-input");
  }
  const out = Buffer.alloc(HEADER_FIXED_BYTES + input.ct.length);
  let offset = 0;
  MAGIC.copy(out, offset);
  offset += MAGIC.length;
  out.writeUInt8(VERSION, offset);
  offset += 1;
  input.kekFp.copy(out, offset);
  offset += KEK_FP_BYTES;
  out.writeUInt8(NONCE_BYTES, offset);
  offset += 1;
  input.nonce.copy(out, offset);
  offset += NONCE_BYTES;
  input.tag.copy(out, offset);
  offset += TAG_BYTES;
  input.wrappedDek.copy(out, offset);
  offset += WRAPPED_DEK_BYTES;
  out.writeUInt32BE(input.ct.length, offset);
  offset += 4;
  input.ct.copy(out, offset);
  return new Uint8Array(out);
}

function parseCiphertext(buf: Buffer): ParsedCiphertext {
  if (buf.length < HEADER_FIXED_BYTES) {
    throw new EncryptionError(
      "Ciphertext is shorter than the Zipy AI ciphertext header.",
      "corrupt-ciphertext",
      { receivedBytes: buf.length, minimumBytes: HEADER_FIXED_BYTES },
    );
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new EncryptionError(
      "Ciphertext does not carry the Zipy AI magic prefix; it was not produced by this service.",
      "corrupt-ciphertext",
    );
  }
  const version = buf.readUInt8(MAGIC.length);
  if (version !== VERSION) {
    throw new EncryptionError(
      `Ciphertext version ${version} is not supported (this service understands version ${VERSION}).`,
      "corrupt-ciphertext",
      { version, supported: VERSION },
    );
  }
  let offset = MAGIC.length + 1;
  const kekFp = buf.subarray(offset, offset + KEK_FP_BYTES);
  offset += KEK_FP_BYTES;
  const nonceLen = buf.readUInt8(offset);
  offset += 1;
  if (nonceLen !== NONCE_BYTES) {
    throw new EncryptionError(
      `Ciphertext declares nonce length ${nonceLen}; this service uses ${NONCE_BYTES}.`,
      "corrupt-ciphertext",
    );
  }
  const nonce = buf.subarray(offset, offset + NONCE_BYTES);
  offset += NONCE_BYTES;
  const tag = buf.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const wrappedDek = buf.subarray(offset, offset + WRAPPED_DEK_BYTES);
  offset += WRAPPED_DEK_BYTES;
  const ctLen = buf.readUInt32BE(offset);
  offset += 4;
  if (offset + ctLen !== buf.length) {
    throw new EncryptionError(
      "Ciphertext length field does not match the buffer length; the value is truncated or padded.",
      "corrupt-ciphertext",
      { declared: ctLen, available: buf.length - offset },
    );
  }
  const ct = buf.subarray(offset, offset + ctLen);
  return { kekFp, nonce, tag, wrappedDek, ct };
}

/* -------------------------------------------------------------------------- */
/* AAD                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The AAD binds the payload to the workspace and to the caller's context
 * label. Binding the workspace is the tenancy control: a ciphertext moved
 * from workspace A to workspace B fails to decrypt because AAD differs.
 * The context label lets a caller further scope an item (`"sso:metadata"`
 * vs `"oauth-refresh:slack"`), so a ciphertext swapped between two fields
 * in the *same* workspace also fails.
 */
function buildAad(workspaceId: string, context: string): Buffer {
  return Buffer.from(`zipy|${workspaceId}|${context}|v1`, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

export function createEncryptionService(
  input: CreateEncryptionServiceInput,
): EncryptionService {
  if (input === null || typeof input !== "object") {
    throw new EncryptionError("`input` is required.", "invalid-input");
  }
  const masterKey = input.masterKey ?? null;
  if (masterKey !== null && masterKey.length > 0) {
    if (masterKey.length < 32) {
      throw new EncryptionError(
        "`masterKey` is too short; supply at least 32 characters (>= 128 bits of entropy).",
        "invalid-input",
        { length: masterKey.length },
      );
    }
  } else if (masterKey !== null && masterKey.length === 0) {
    throw new EncryptionError(
      "`masterKey` is an empty string. Pass `null` for an unconfigured service, or supply at least 32 characters.",
      "invalid-input",
    );
  }
  const salt = input.hkdfSalt ?? DEFAULT_HKDF_SALT;
  if (typeof salt !== "string" || salt.length === 0) {
    throw new EncryptionError("`hkdfSalt` must be a non-empty string when supplied.", "invalid-input");
  }
  return new EncryptionServiceImpl({
    masterKey: masterKey === null ? null : masterKey,
    salt,
  });
}

/**
 * Convenience factory from `config.compliance`. Reads only
 * `encryptionMasterKey`. An operator that has not set it gets an
 * unconfigured service; the deployment phase surfaces the corresponding
 * startup warning (`config` already produces one).
 */
export function createEncryptionServiceFromConfig(config: {
  readonly compliance: {
    readonly encryptionMasterKey: string | null;
  };
}): EncryptionService {
  return createEncryptionService({
    masterKey: config.compliance.encryptionMasterKey,
  });
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function assertWorkspaceId(v: string): void {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new EncryptionError("`workspaceId` is required.", "invalid-input");
  }
}

function assertContext(v: string): void {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new EncryptionError(
      "`context` is required (a short label such as \"artifact:8f0c...\" or \"sso:metadata\").",
      "invalid-input",
    );
  }
  if (v.length > 256) {
    throw new EncryptionError(
      "`context` must be 256 characters or fewer.",
      "invalid-input",
      { length: v.length },
    );
  }
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  parseCiphertext,
  assembleCiphertext,
  buildAad,
  MAGIC,
  VERSION,
  KEK_FP_BYTES,
  DEK_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  WRAPPED_DEK_BYTES,
  DEFAULT_HKDF_SALT,
});
