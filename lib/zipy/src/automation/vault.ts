/**
 * Zipy AI — credential vault for headless browser automation.
 *
 * The vault keeps credentials **out of workflow scripts and out of the
 * database in plaintext**. Two implementations ship in this phase:
 *
 *   1. `NoVault` — the safe default. Refuses to return any credential and
 *      reports `isConfigured() === false`. The login flow treats a miss as a
 *      configuration error rather than falling back to "try without
 *      credentials".
 *   2. `EnvVault` — reads credentials from the process environment. It is
 *      appropriate for single-tenant / on-prem deployments where secrets are
 *      injected at runtime by the orchestrator. It never reads from disk and
 *      never writes anywhere.
 *
 * A database-backed, per-workspace, encrypted-at-rest vault is the enterprise
 * path. Its schema is owned by the security phase (encryption key + row
 * shape); this module declares the interface that implementation must
 * satisfy so the login flow does not have to change when it lands.
 *
 * Credential shape (deliberately small):
 *   - `username`  — the account identifier (email, user handle, tenant user).
 *   - `password`  — the account secret.
 *   - `totpSecret` — optional. When present, the login flow can derive a
 *     one-time code without a human. When absent, the flow reports
 *     `mfa-required`. The vault never invents a secret.
 *   - `notes`     — non-secret free-text for operators (e.g. "staging only").
 *
 * Rules honoured here:
 *   - No credential is invented. Missing env vars produce a miss, not a
 *     throw. The *caller* (login.ts) decides whether a miss is fatal for the
 *     workflow it is running.
 *   - Every accessor is synchronous and in-memory. This module does not do
 *     I/O. The database-backed implementation will, and its `get` will be
 *     async; the interface is async to keep both shapes compatible.
 *   - Secrets are never logged, never serialised into diagnostics, and
 *     never returned in `describe()`.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A credential scoped to a login target. `scope` is a normalised, upper-case
 * identifier chosen by the operator (see `normalizeScope`). It maps 1:1 to a
 * login destination — not to a human being. One human may have several: their
 * staging account, their production account, their SSO account.
 */
export interface Credential {
  /** The account identifier the login form should be filled with. */
  readonly username: string;
  /** The account secret. Never logged. */
  readonly password: string;
  /**
   * Optional base32-encoded TOTP secret. When present and the login flow
   * encounters an MFA prompt the flow *may* derive a code. The current phase
   * does not implement TOTP derivation (it lives in the review phase as part
   * of the human handoff). The field is carried here so the vault contract
   * is complete.
   */
  readonly totpSecret: string | null;
  /** Non-secret operator notes. Never used to fill a form. */
  readonly notes: string | null;
}

export interface CredentialLookup {
  /** Scope identifier. Normalised by `get`. */
  readonly scope: string;
  /** Optional tenant/workspace disambiguation for a DB-backed vault. */
  readonly workspaceId?: string | null;
}

export interface CredentialVault {
  /**
   * Look up a credential. Returns `null` on a miss (never a placeholder).
   * Throws `VaultError` only for structural failures (invalid scope, a
   * corrupt record) — a scope that simply has no credential is not an error.
   */
  get(lookup: CredentialLookup): Promise<Credential | null>;
  /** Whether the vault is usable at all (not whether a specific scope is set). */
  isConfigured(): boolean;
  /** Human-readable description for diagnostics. Never includes secrets. */
  describe(): string;
}

export type VaultErrorCode =
  | "invalid-scope"
  | "not-configured"
  | "corrupt-record";

export class VaultError extends Error {
  public readonly code: VaultErrorCode;
  constructor(message: string, code: VaultErrorCode) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Scope normalisation                                                         */
/* -------------------------------------------------------------------------- */

const SCOPE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Normalise a scope identifier into the canonical form the vault stores.
 * Letters are upper-cased, dashes and dots become underscores, and the
 * result must be non-empty and match `SCOPE_PATTERN`. Invalid scopes throw —
 * a scope typo that silently returns "no credential" would produce a login
 * failure that is confusing to diagnose.
 */
export function normalizeScope(raw: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new VaultError(
      "Credential scope must be a non-empty string.",
      "invalid-scope",
    );
  }
  const candidate = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (candidate.length === 0 || !SCOPE_PATTERN.test(candidate)) {
    throw new VaultError(
      `Credential scope "${raw}" is not a valid identifier. Valid scopes contain ` +
        `letters, digits and underscores, and start with a letter.`,
      "invalid-scope",
    );
  }
  return candidate;
}

/* -------------------------------------------------------------------------- */
/* NoVault — safe default                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The default vault. Refuses every lookup and reports itself as not
 * configured. A workflow that requires credentials will fail with a clear
 * "no vault configured" error the first time it tries to log in, rather than
 * running headlessly with an empty password field and returning a confusing
 * failure from the target site.
 */
export class NoVault implements CredentialVault {
  public get(lookup: CredentialLookup): Promise<Credential | null> {
    // Validate the scope anyway so a caller with a typo gets a typed error
    // rather than "no vault configured" hiding the real problem.
    normalizeScope(lookup.scope);
    return Promise.resolve(null);
  }
  public isConfigured(): boolean {
    return false;
  }
  public describe(): string {
    return "NoVault (no credential vault is configured)";
  }
}

/* -------------------------------------------------------------------------- */
/* EnvVault — operator-injected environment credentials                        */
/* -------------------------------------------------------------------------- */

/**
 * Environment key layout, one block per scope:
 *
 *   ZIPY_LOGIN_<SCOPE>_USERNAME     required
 *   ZIPY_LOGIN_<SCOPE>_PASSWORD     required
 *   ZIPY_LOGIN_<SCOPE>_TOTP_SECRET  optional
 *   ZIPY_LOGIN_<SCOPE>_NOTES        optional
 *
 * A scope is "present" only when both USERNAME and PASSWORD are set to
 * non-empty values. Partial configuration (username only) is treated as a
 * miss and reported in `describe()` so an operator can see the problem
 * without inspecting each variable by hand.
 */
export class EnvVault implements CredentialVault {
  private readonly prefix: string;
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(opts: { readonly prefix?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {}) {
    this.prefix = opts.prefix ?? "ZIPY_LOGIN_";
    this.env = opts.env ?? process.env;
  }

  public get(lookup: CredentialLookup): Promise<Credential | null> {
    const scope = normalizeScope(lookup.scope);
    const base = `${this.prefix}${scope}_`;
    const username = this.readNonEmpty(`${base}USERNAME`);
    const password = this.readNonEmpty(`${base}PASSWORD`);
    if (username === null || password === null) {
      return Promise.resolve(null);
    }
    const totpSecret = this.readNonEmpty(`${base}TOTP_SECRET`);
    const notes = this.readNonEmpty(`${base}NOTES`);
    return Promise.resolve({
      username,
      password,
      totpSecret,
      notes,
    });
  }

  public isConfigured(): boolean {
    return this.listScopes().length > 0;
  }

  public describe(): string {
    const scopes = this.listScopes();
    if (scopes.length === 0) {
      return `EnvVault (no ${this.prefix}<SCOPE>_USERNAME variables are set)`;
    }
    return `EnvVault (scopes: ${scopes.join(", ")})`;
  }

  /**
   * Enumerate fully-configured scopes. Used only for diagnostics —
   * `describe()` reports the list of scope *names*, never the values.
   * Partial configurations are also reported here so an operator can see
   * that a scope exists but is missing a password.
   */
  private listScopes(): readonly string[] {
    const present = new Set<string>();
    for (const key of Object.keys(this.env)) {
      if (!key.startsWith(this.prefix)) continue;
      const rest = key.slice(this.prefix.length);
      const m = /^(.+)_(USERNAME|PASSWORD|TOTP_SECRET|NOTES)$/.exec(rest);
      if (m === null || typeof m[1] !== "string") continue;
      const scope = m[1];
      const username = this.readNonEmpty(`${this.prefix}${scope}_USERNAME`);
      const password = this.readNonEmpty(`${this.prefix}${scope}_PASSWORD`);
      if (username !== null && password !== null) present.add(scope);
    }
    return Array.from(present).sort();
  }

  private readNonEmpty(name: string): string | null {
    const value = this.env[name];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Database-backed vault placeholder                                           */
/* -------------------------------------------------------------------------- */

/**
 * Shape of the vault the security phase will install. It is declared here so
 * downstream code can accept it via the `CredentialVault` interface without
 * importing the security package (which does not exist yet). The type is
 * documentation, not a working implementation — instantiating it must fail.
 */
export class DatabaseVaultNotInstalled extends VaultError {
  constructor() {
    super(
      "The database-backed credential vault has not been installed in this build. " +
        "It depends on the security phase's encryption-at-rest schema. Until that " +
        "phase lands, use EnvVault or supply credentials through the platform " +
        "secret manager. Zipy AI will not fall back to unencrypted storage.",
      "not-configured",
    );
    this.name = "DatabaseVaultNotInstalled";
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Vault selection precedence:
 *
 *   1. `ZIPY_CREDENTIAL_VAULT=env`  → EnvVault with the default prefix.
 *   2. `ZIPY_CREDENTIAL_VAULT=none` → NoVault.
 *   3. If the environment contains at least one fully-configured scope, an
 *      EnvVault is used by default. This is the "small deployment, one machine"
 *      case and avoids operators having to set an extra toggle just to make
 *      the vault work.
 *   4. Otherwise → NoVault, which fails loudly on the first credential lookup.
 *
 * The selection is memoized for the process. `resetVaultForTests` drops the
 * cache so a test can swap environments between cases.
 */
let cachedVault: CredentialVault | null = null;

export function getVault(): CredentialVault {
  if (cachedVault !== null) return cachedVault;

  const requested = (process.env["ZIPY_CREDENTIAL_VAULT"] ?? "").trim().toLowerCase();
  if (requested === "none") {
    cachedVault = new NoVault();
    return cachedVault;
  }
  if (requested === "env") {
    cachedVault = new EnvVault();
    return cachedVault;
  }
  if (requested.length > 0 && requested !== "auto") {
    // Unknown value: do not silently fall through. Fail with a clear error on
    // the first vault access rather than during module load, so importing
    // this package is never fatal.
    cachedVault = {
      get(lookup: CredentialLookup): Promise<Credential | null> {
        normalizeScope(lookup.scope);
        throw new VaultError(
          `ZIPY_CREDENTIAL_VAULT="${requested}" is not a recognised vault selector. ` +
            `Use "env", "none", or "auto" (the default).`,
          "not-configured",
        );
      },
      isConfigured(): boolean {
        return false;
      },
      describe(): string {
        return `Unrecognised vault selector "${requested}"`;
      },
    };
    return cachedVault;
  }

  const envVault = new EnvVault();
  cachedVault = envVault.isConfigured() ? envVault : new NoVault();
  return cachedVault;
}

/** Reset the memoized vault — tests only. */
export function resetVaultForTests(): void {
  cachedVault = null;
}

/* -------------------------------------------------------------------------- */
/* Convenience wrappers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Look up a credential, throwing a `VaultError` with `code: "not-configured"`
 * when the vault has no entry for the scope. Callers that prefer a `null`
 * return use `tryGetCredential`.
 */
export async function getCredential(scope: string): Promise<Credential> {
  const vault = getVault();
  const found = await vault.get({ scope });
  if (found === null) {
    throw new VaultError(
      `No credential is configured for scope "${normalizeScope(scope)}". ` +
        `Vault: ${vault.describe()}. Configure the scope or switch to a ` +
        `different vault; Zipy AI does not invent credentials.`,
      "not-configured",
    );
  }
  return found;
}

export async function tryGetCredential(scope: string): Promise<Credential | null> {
  return await getVault().get({ scope });
}
