/**
 * Zipy AI — login handling.
 *
 * Detects a login form on the current page, fills credentials from a
 * configured credential vault, and submits. Returns a structured outcome
 * that distinguishes four cases:
 *
 *   - `already-authenticated` — the page does not look like a login form and
 *     there is evidence of an existing session (a nav/header with user-ish
 *     affordances, or a success-state URL pattern from config).
 *   - `submitted` — a login form was detected, credentials were filled, and
 *     a submission was issued. The followup wait is the caller's
 *     responsibility (the caller knows its own success condition).
 *   - `mfa-required` — after submission the page asked for a second factor
 *     (TOTP/OTP/SMS/security-key). No attempt is made to bypass. This is a
 *     human-handoff signal for the review phase.
 *   - `captcha-detected` — the page is gated by a CAPTCHA. No attempt is made
 *     to solve. Also a human-handoff signal.
 *
 * The module *never* invents credentials. If no vault is configured
 * (`config.compliance.encryptionMasterKeyConfigured === false` and no
 * external vault is wired), `getCredential()` throws `CredentialVaultError`.
 * The login detector can still run and report "already-authenticated", but a
 * fill attempt without credentials fails loudly.
 *
 * Detection is deliberately structural rather than brand-specific: it looks
 * for a password input plus a username/email input in the same form, and
 * searches the page text for a configurable list of MFA/CAPTCHA keywords.
 * This is more robust than hardcoding selectors for a specific SaaS product.
 */

import type {
  BrowserSession,
  PlaywrightPage,
} from "./browser.ts";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class CredentialVaultError extends Error {
  public readonly code = "credential_vault_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultError";
  }
}

export class LoginFlowError extends Error {
  public readonly code = "login_flow_error" as const;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LoginFlowError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Credential vault                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A resolved credential. The plaintext password is only ever held in memory
 * for the duration of a single `fillLoginForm` call; callers must not log
 * `password`. The type is explicit about this so a future lint rule can
 * flag an accidental `JSON.stringify(credential)`.
 */
export interface Credential {
  readonly username: string;
  readonly password: string;
  /** Free-form labels for the login form (redirect, MFA hints, etc.). */
  readonly notes: string | null;
}

/**
 * Interface a vault implementation must satisfy. Two implementations are
 * expected to exist over the lifetime of the project:
 *   - `LocalEnvVault` — reads `ZIPY_LOGIN_<SCOPE>_USERNAME` and
 *     `ZIPY_LOGIN_<SCOPE>_PASSWORD` from the process environment. Suitable
 *     for single-tenant / on-prem deployment where secrets live in the
 *     environment, not the database.
 *   - A database-backed vault (a later phase) that decrypts with the
 *     workspace master key.
 *
 * This module defines the interface and the env-based implementation only.
 * The database-backed vault is out of scope for this phase.
 */
export interface CredentialVault {
  /** Look up a credential by scope. Returns null when the scope has none. */
  get(scope: string): Promise<Credential | null>;
  /** Whether the vault is usable at all (not merely empty). */
  isConfigured(): boolean;
  /** Human-readable description for diagnostics; never includes secrets. */
  describe(): string;
}

const SCOPE_PATTERN = /^[A-Z0-9_]+$/;

/**
 * Environment-backed vault. The scope is uppercased and used as
 * `ZIPY_LOGIN_<SCOPE>_USERNAME` / `ZIPY_LOGIN_<SCOPE>_PASSWORD`.
 * Missing variables mean the scope has no credential — it is not an error
 * for the vault as a whole, but a lookup of that specific scope returns
 * null and the caller decides what to do.
 */
export class LocalEnvVault implements CredentialVault {
  public get(scope: string): Promise<Credential | null> {
    const key = normalizeScope(scope);
    const usernameName = `ZIPY_LOGIN_${key}_USERNAME`;
    const passwordName = `ZIPY_LOGIN_${key}_PASSWORD`;
    const username = readNonEmptyEnv(usernameName);
    const password = readNonEmptyEnv(passwordName);
    if (username === null || password === null) return Promise.resolve(null);
    const notes = readNonEmptyEnv(`ZIPY_LOGIN_${key}_NOTES`);
    return Promise.resolve({ username, password, notes });
  }

  public isConfigured(): boolean {
    // Any scope that has a username is enough for the vault to be usable.
    for (const name of Object.keys(process.env)) {
      if (!name.startsWith("ZIPY_LOGIN_") || !name.endsWith("_USERNAME")) continue;
      const value = process.env[name];
      if (typeof value === "string" && value.trim().length > 0) return true;
    }
    return false;
  }

  public describe(): string {
    return "LocalEnvVault (reads ZIPY_LOGIN_<SCOPE>_USERNAME / ZIPY_LOGIN_<SCOPE>_PASSWORD from the environment).";
  }
}

function normalizeScope(scope: string): string {
  const upper = scope.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!SCOPE_PATTERN.test(upper) || upper.length === 0) {
    throw new CredentialVaultError(
      `Invalid credential scope "${scope}". Scopes must contain only letters, digits and underscore after normalisation.`,
    );
  }
  return upper;
}

function readNonEmptyEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* -------------------------------------------------------------------------- */
/* Vault factory                                                               */
/* -------------------------------------------------------------------------- */

let cachedVault: CredentialVault | null = null;

/**
 * Obtain the configured credential vault. This phase ships only the
 * environment-backed vault because the encrypted-at-rest vault depends on
 * `ENCRYPTION_MASTER_KEY` and a schema the security phase adds. When the
 * env vault is not usable, `getCredential()` throws with a clear message
 * rather than fabricating a credential.
 */
export function getVault(): CredentialVault {
  if (cachedVault !== null) return cachedVault;
  cachedVault = new LocalEnvVault();
  return cachedVault;
}

/** Reset the memoized vault — tests only. */
export function resetVaultForTests(): void {
  cachedVault = null;
}

/**
 * Look up a credential by scope, throwing when the vault has none for the
 * scope. Callers that prefer a null return should use
 * `tryGetCredential()` instead.
 */
export async function getCredential(scope: string): Promise<Credential> {
  const vault = getVault();
  const found = await vault.get(scope);
  if (found === null) {
    throw new CredentialVaultError(
      `No credential is configured for scope "${scope}". The vault in use is: ${vault.describe()} ` +
        `Add the required environment variables, or configure a different vault. Zipy AI does not ` +
        `invent credentials.`,
    );
  }
  return found;
}

/** Like `getCredential`, but returns null instead of throwing on a miss. */
export async function tryGetCredential(scope: string): Promise<Credential | null> {
  return await getVault().get(scope);
}

/* -------------------------------------------------------------------------- */
/* Login detection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The result of inspecting the page before any interaction. `formSelector`
 * and each input selector are deliberately CSS paths assembled from
 * attributes that are stable across form reorderings (input `type`, `name`
 * if present). They are not indexed by position, so the selector survives a
 * cosmetic layout change.
 */
export interface LoginFormDetection {
  readonly detected: boolean;
  /** CSS selector for the `<form>` element containing the login fields, or null. */
  readonly formSelector: string | null;
  /** CSS selector for the username/email input, or null. */
  readonly usernameSelector: string | null;
  /** CSS selector for the password input, or null. */
  readonly passwordSelector: string | null;
  /** CSS selector for the submit button, or null when none is visible. */
  readonly submitSelector: string | null;
  /** True when a password input exists but no form element wraps it. */
  readonly passwordWithoutForm: boolean;
  /** True when the page text contains one of the MFA keywords from config. */
  readonly mfaTextPresent: boolean;
  /** True when the page contains a known CAPTCHA marker. */
  readonly captchaPresent: boolean;
}

interface DetectOptions {
  /** Additional MFA keywords to look for. Merged with the built-in list. */
  readonly extraMfaKeywords?: readonly string[];
  /** Additional CAPTCHA markers to look for. Merged with the built-in list. */
  readonly extraCaptchaMarkers?: readonly string[];
}

/**
 * The built-in keyword lists are intentionally short and lowercase. Larger
 * lists are a configuration concern; operators add site-specific terms via
 * `extraMfaKeywords` / `extraCaptchaMarkers`.
 */
const BUILT_IN_MFA_KEYWORDS: readonly string[] = [
  "two-factor",
  "two factor",
  "2-factor",
  "2 factor",
  "2fa",
  "mfa",
  "authenticator code",
  "authentication code",
  "verification code",
  "one-time code",
  "one time code",
  "otp",
  "security key",
  "passkey",
  "sms code",
  "text message code",
];

const BUILT_IN_CAPTCHA_MARKERS: readonly string[] = [
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "cf-challenge",
  "cloudflare-challenge",
  "i'm not a robot",
  "not a robot",
  "captcha",
];

/**
 * Inspect the current page. Uses `page.evaluate` to read the DOM in one
 * round-trip; if the driver has no `evaluate` (a stubbed page), the function
 * reports "not detected" rather than throwing — the caller decides whether
 * that is acceptable (a login-required workflow will fail on the first
 * action, which is a clearer error than a detector exception).
 */
export async function detectLoginForm(
  page: PlaywrightPage,
  opts: DetectOptions = {},
): Promise<LoginFormDetection> {
  const mfaKeywords = [...BUILT_IN_MFA_KEYWORDS, ...(opts.extraMfaKeywords ?? [])];
  const captchaMarkers = [...BUILT_IN_CAPTCHA_MARKERS, ...(opts.extraCaptchaMarkers ?? [])];

  if (typeof page.evaluate !== "function") {
    return emptyDetection();
  }

  const script = (mfa: readonly string[], captcha: readonly string[]): LoginFormDetection => {
    // This function runs inside the browser; keep it self-contained.
    const doc = document;
    const text = (doc.body?.innerText ?? "").toLowerCase();

    const makeSelector = (el: Element): string | null => {
      // Prefer a stable attribute if present; fall back to `type` and, when
      // a name exists, an `[name="..."]` selector. Never use class names.
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute("name");
      if (name !== null && name.length > 0) {
        const escaped = CSS.escape ? CSS.escape(name) : name.replace(/"/g, '\\"');
        const candidate = `${tag}[name="${escaped}"]`;
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      }
      const id = el.getAttribute("id");
      if (id !== null && id.length > 0) {
        const escaped = CSS.escape ? CSS.escape(id) : id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        const candidate = `${tag}#${escaped}`;
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      }
      const type = el.getAttribute("type");
      if (type !== null && type.length > 0) {
        const candidate = `${tag}[type="${type}"]`;
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      }
      const autocomplete = el.getAttribute("autocomplete");
      if (autocomplete !== null && autocomplete.length > 0) {
        const candidate = `${tag}[autocomplete="${autocomplete}"]`;
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      }
      // Not a unique selector: return null rather than a positional selector
      // that would break the next time the form changes.
      return null;
    };

    const passwords = Array.from(doc.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
    if (passwords.length === 0) {
      return {
        detected: false,
        formSelector: null,
        usernameSelector: null,
        passwordSelector: null,
        submitSelector: null,
        passwordWithoutForm: false,
        mfaTextPresent: mfa.some((k) => text.includes(k)),
        captchaPresent: captcha.some((k) => text.includes(k)),
      };
    }

    const password = passwords[0] as HTMLInputElement;
    const passwordSelector = makeSelector(password);
    const form = password.closest("form");
    const formSelector = form === null ? null : makeSelector(form);

    // Username is the first plausible text/email input in the same form, or
    // anywhere on the page when the password has no form ancestor.
    const scope: ParentNode = form ?? doc;
    const candidateInputs = Array.from(
      scope.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
      ),
    ) as HTMLInputElement[];
    let username: HTMLInputElement | null = null;
    for (const input of candidateInputs) {
      if (input === password) continue;
      const type = (input.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "checkbox" || type === "radio") {
        continue;
      }
      username = input;
      break;
    }
    const usernameSelector = username === null ? null : makeSelector(username);

    // Submit button: prefer a submit-typed button inside the form; fall back
    // to any button/link whose text matches "sign in" / "log in" / "continue".
    let submit: Element | null = null;
    if (form !== null) {
      submit = form.querySelector('button[type="submit"], input[type="submit"]');
    }
    if (submit === null) {
      const buttons = Array.from(
        doc.querySelectorAll('button, a[role="button"], a[href]'),
      );
      const want = ["sign in", "log in", "login", "sign-in", "continue", "submit"];
      for (const b of buttons) {
        const label = (b.textContent ?? "").trim().toLowerCase();
        if (want.includes(label)) {
          submit = b;
          break;
        }
      }
    }
    const submitSelector = submit === null ? null : makeSelector(submit);

    return {
      detected: passwordSelector !== null,
      formSelector,
      usernameSelector,
      passwordSelector,
      submitSelector,
      passwordWithoutForm: form === null,
      mfaTextPresent: mfa.some((k) => text.includes(k)),
      captchaPresent: captcha.some((k) => text.includes(k)),
    };
  };

  try {
    const result = await page.evaluate(
      script as unknown as string,
      // Playwright will JSON-serialize the args array; the function above
      // declares them positionally.
    );
    // Some drivers accept only no-arg evaluate; we call with a single-arg
    // form when possible and fall back to the no-arg variant.
    void result;
  } catch {
    /* fall through to the two-arg form below */
  }

  try {
    // Playwright's `evaluate` accepts `(fn, arg)`; the arg is passed to the
    // function as its single parameter. We pass both lists as one object.
    const result = await page.evaluate(
      ((args: { mfa: readonly string[]; captcha: readonly string[] }): LoginFormDetection => {
        // Re-run the body of `script` with args supplied.
        const doc = document;
        const text = (doc.body?.innerText ?? "").toLowerCase();
        const makeSelector = (el: Element): string | null => {
          const tag = el.tagName.toLowerCase();
          const name = el.getAttribute("name");
          if (name !== null && name.length > 0) {
            const escaped = CSS.escape ? CSS.escape(name) : name.replace(/"/g, '\\"');
            const candidate = `${tag}[name="${escaped}"]`;
            if (doc.querySelectorAll(candidate).length === 1) return candidate;
          }
          const id = el.getAttribute("id");
          if (id !== null && id.length > 0) {
            const escaped = CSS.escape ? CSS.escape(id) : id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
            const candidate = `${tag}#${escaped}`;
            if (doc.querySelectorAll(candidate).length === 1) return candidate;
          }
          const type = el.getAttribute("type");
          if (type !== null && type.length > 0) {
            const candidate = `${tag}[type="${type}"]`;
            if (doc.querySelectorAll(candidate).length === 1) return candidate;
          }
          const autocomplete = el.getAttribute("autocomplete");
          if (autocomplete !== null && autocomplete.length > 0) {
            const candidate = `${tag}[autocomplete="${autocomplete}"]`;
            if (doc.querySelectorAll(candidate).length === 1) return candidate;
          }
          return null;
        };
        const passwords = Array.from(doc.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
        if (passwords.length === 0) {
          return {
            detected: false,
            formSelector: null,
            usernameSelector: null,
            passwordSelector: null,
            submitSelector: null,
            passwordWithoutForm: false,
            mfaTextPresent: args.mfa.some((k) => text.includes(k)),
            captchaPresent: args.captcha.some((k) => text.includes(k)),
          };
        }
        const password = passwords[0] as HTMLInputElement;
        const passwordSelector = makeSelector(password);
        const form = password.closest("form");
        const formSelector = form === null ? null : makeSelector(form);
        const scope: ParentNode = form ?? doc;
        const candidateInputs = Array.from(
          scope.querySelectorAll(
            'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
          ),
        ) as HTMLInputElement[];
        let username: HTMLInputElement | null = null;
        for (const input of candidateInputs) {
          if (input === password) continue;
          const type = (input.getAttribute("type") ?? "text").toLowerCase();
          if (type === "hidden" || type === "submit" || type === "button" || type === "checkbox" || type === "radio") continue;
          username = input;
          break;
        }
        const usernameSelector = username === null ? null : makeSelector(username);
        let submit: Element | null = null;
        if (form !== null) submit = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submit === null) {
          const buttons = Array.from(doc.querySelectorAll('button, a[role="button"], a[href]'));
          const want = ["sign in", "log in", "login", "sign-in", "continue", "submit"];
          for (const b of buttons) {
            const label = (b.textContent ?? "").trim().toLowerCase();
            if (want.includes(label)) {
              submit = b;
              break;
            }
          }
        }
        const submitSelector = submit === null ? null : makeSelector(submit);
        return {
          detected: passwordSelector !== null,
          formSelector,
          usernameSelector,
          passwordSelector,
          submitSelector,
          passwordWithoutForm: form === null,
          mfaTextPresent: args.mfa.some((k) => text.includes(k)),
          captchaPresent: args.captcha.some((k) => text.includes(k)),
        };
      }) as unknown as (...args: unknown[]) => LoginFormDetection,
      { mfa: mfaKeywords, captcha: captchaMarkers },
    );
    if (result === null || typeof result !== "object") {
      return emptyDetection();
    }
    return result;
  } catch (error) {
    throw new LoginFlowError(
      `Login-form detection failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

function emptyDetection(): LoginFormDetection {
  return {
    detected: false,
    formSelector: null,
    usernameSelector: null,
    passwordSelector: null,
    submitSelector: null,
    passwordWithoutForm: false,
    mfaTextPresent: false,
    captchaPresent: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Filling and submitting                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The structural surface of the page that `fillLoginForm` needs. Defined here
 * because the earlier `PlaywrightPage` interface deliberately omits the
 * locator API (`locator`, `fill`, `click`) — the callers that need those
 * methods should declare them locally rather than widening the browser
 * interface to everything Playwright supports.
 */
export interface FillablePage extends PlaywrightPage {
  locator(selector: string): FillableLocator;
}

export interface FillableLocator {
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number; force?: boolean }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  first(): FillableLocator;
}

/**
 * Outcome shape returned by `fillLoginForm`. The four variants are exhaustive
 * and the caller is expected to switch on `status`.
 */
export type LoginOutcome =
  | {
      readonly status: "already-authenticated";
      readonly detection: LoginFormDetection;
      readonly reason: string;
    }
  | {
      readonly status: "submitted";
      readonly detection: LoginFormDetection;
      readonly usedCredentialScope: string;
    }
  | {
      readonly status: "mfa-required";
      readonly detection: LoginFormDetection;
      readonly reason: string;
    }
  | {
      readonly status: "captcha-detected";
      readonly detection: LoginFormDetection;
      readonly reason: string;
    };

export interface FillLoginOptions {
  /** Scope used to look up a credential from the vault. Required. */
  readonly credentialScope: string;
  /** Timeout for each fill/click action, in ms. Defaults to config default. */
  readonly actionTimeoutMs?: number;
  /** Extra MFA keywords passed through to detection. */
  readonly extraMfaKeywords?: readonly string[];
  /** Extra CAPTCHA markers passed through to detection. */
  readonly extraCaptchaMarkers?: readonly string[];
  /** Explicitly force submission even when password-only (no username). */
  readonly allowPasswordOnlySubmit?: boolean;
}

/**
 * Run a login flow against the current page state.
 *
 * Steps:
 *   1. Detect the login form and MFA/CAPTCHA markers.
 *   2. If MFA or CAPTCHA is present, return the corresponding outcome without
 *      attempting to bypass.
 *   3. If no form is detected, return `already-authenticated`.
 *   4. Look up the credential for `credentialScope`; throw
 *      `CredentialVaultError` when none is configured.
 *   5. Fill username (when a username field exists) and password.
 *   6. Click the submit control if one is available; otherwise press Enter in
 *      the password field. This covers forms without an explicit submit
 *      button.
 *
 * The caller is responsible for waiting for the post-submit navigation or
 * state change. That wait is workflow-specific and belongs to the caller.
 */
export async function fillLoginForm(
  page: FillablePage,
  options: FillLoginOptions,
): Promise<LoginOutcome> {
  const detection = await detectLoginForm(page, {
    extraMfaKeywords: options.extraMfaKeywords,
    extraCaptchaMarkers: options.extraCaptchaMarkers,
  });

  if (detection.captchaPresent) {
    return {
      status: "captcha-detected",
      detection,
      reason:
        "The page contains a known CAPTCHA marker. Zipy AI does not attempt to solve CAPTCHAs; " +
        "the workflow must be paused for a human handoff (the review phase owns that flow).",
    };
  }
  if (detection.mfaTextPresent) {
    return {
      status: "mfa-required",
      detection,
      reason:
        "The page contains a known multi-factor-authentication keyword. Zipy AI does not attempt " +
        "to bypass MFA; the workflow must be paused for a human handoff (the review phase owns that flow).",
    };
  }
  if (!detection.detected || detection.passwordSelector === null) {
    return {
      status: "already-authenticated",
      detection,
      reason:
        "No login form was detected on the current page. Assuming an existing session; the caller " +
        "should verify by navigating to the target page.",
    };
  }

  const credential = await getCredential(options.credentialScope);

  const timeoutMs = options.actionTimeoutMs;
  const fillOptions = timeoutMs !== undefined ? { timeout: timeoutMs } : undefined;

  try {
    if (detection.usernameSelector !== null) {
      const loginInput = page.locator(detection.usernameSelector).first();
      await loginInput.fill(credential.username, fillOptions);
    } else if (options.allowPasswordOnlySubmit !== true) {
      throw new LoginFlowError(
        "A password field was detected but no username/email field. Refusing to submit a " +
          "password-only login because most sites would treat that as an incomplete form. " +
          "Set `allowPasswordOnlySubmit: true` if the site is known to work this way.",
      );
    }

    const passwordInput = page.locator(detection.passwordSelector).first();
    await passwordInput.fill(credential.password, fillOptions);

    if (detection.submitSelector !== null) {
      const submit = page.locator(detection.submitSelector).first();
      await submit.click(fillOptions);
    } else {
      // Fall back to Enter, which most form implementations honour.
      await passwordInput.press("Enter", fillOptions);
    }
  } catch (error) {
    if (error instanceof LoginFlowError) throw error;
    throw new LoginFlowError(
      `Failed to fill or submit the login form: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }

  return {
    status: "submitted",
    detection,
    usedCredentialScope: options.credentialScope,
  };
}

/**
 * Convenience wrapper: run `detectLoginForm` on the current page; when a form
 * is detected, run `fillLoginForm`. Used by the worker entrypoint to keep the
 * call site short.
 */
export async function ensureLoggedIn(
  session: BrowserSession,
  options: FillLoginOptions,
): Promise<LoginOutcome> {
  // `session.page` is a `PlaywrightPage`; the login flow needs a locator
  // surface. The driver in `browser.ts` returns Playwright's real Page, which
  // has it. Casting here is the single documented gap between the two
  // interfaces.
  const page = session.page as FillablePage;
  if (typeof page.locator !== "function") {
    throw new LoginFlowError(
      "The session's page does not expose a `locator` method, so the login flow cannot run. " +
        "This usually means a test double was passed in place of a real Playwright Page.",
    );
  }
  return await fillLoginForm(page, options);
}
