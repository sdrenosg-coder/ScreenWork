/**
 * Zipy AI — PII detection and redaction in generated text (safety phase,
 * batch 2).
 *
 * Detects personally identifiable information in the writer's prose and in
 * the extraction outputs that feed it, and returns a redacted form alongside
 * a per-span finding so a reviewer sees exactly what was removed. This is the
 * text-side counterpart to `@zipy/images/piiDetect` (which handles screenshots)
 * and the shared detection vocabulary used by the moderation queue.
 *
 * Design rules honoured:
 *  - No invented PII. The detector reports only spans that match a documented
 *    pattern or that carry a checkable structural signal (Luhn checksum for a
 *    card number, RFC-5322 shape for an email, a national-format shape for a
 *    phone). It never reports "this *might be* a name" from a bare noun
 *    phrase; a name detector requires a title or a role word ('Mr', 'Ms',
 *    'Dr', 'contact', 'owner') so an ordinary sentence is not redacted.
 *  - No silent erasure. Every redaction is accompanied by a finding that
 *    names the category, the span range, the matched text and the reason.
 *    The consumer decides whether to redact inline or to reject the fragment.
 *  - Deterministic. Findings are ordered by their index in the input; the
 *    same input always produces the same redacted output.
 *  - Conservative. The default configuration redacts the strictest common
 *    PII (email, phone, credit card, IBAN, SSN, IP address) and treats
 *    names as `soft` findings that are surfaced but only redacted when the
 *    caller opts in (`redactNames: true`). This matches the safety phase's
 *    stance: a name in a tutorial describing a fictional persona is not a
 *    leak; a name next to an email is.
 *  - No outbound network. The detector is pure and offline. Any cloud
 *    moderation step is a separate module with its own explicit configuration
 *    (see the safety phase's `moderationQueue`); this module never calls it.
 *
 * The module exports:
 *   - `detectPii` — detect without modifying text.
 *   - `redactPii` — detect and produce a redacted string.
 *   - `buildPiiTextDirectives` — the LLM-visible block telling the writer how
 *     to refer to subjects without generating PII.
 *   - `rehydratePiiTextReport` — typed load of a persisted payload.
 *   - `__internals` — helpers exported for tests.
 */

import type { AudienceProfile } from "@zipy/content/personalization/audience";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type PiiTextErrorCode = "invalid-input" | "shape";

export class PiiTextError extends Error {
  readonly code: PiiTextErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    code: PiiTextErrorCode,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * PII categories. `name` and `address` are "soft" (structural signal
 * required); every other category is "hard" (a matched pattern is enough to
 * classify). The distinction drives `redactNames` defaults and the review
 * UI's default disposition.
 */
export const PII_TEXT_CATEGORIES = [
  "email",
  "phone",
  "credit-card",
  "iban",
  "ssn",
  "national-id",
  "ip-address",
  "api-key",
  "password",
  "address",
  "name",
  "date-of-birth",
  "url-with-token",
] as const;
export type PiiTextCategory = (typeof PII_TEXT_CATEGORIES)[number];

export interface PiiTextFinding {
  readonly category: PiiTextCategory;
  /**
   * True when a bare match is enough. A soft finding requires a structural
   * signal (a title, a role word, a field label) to avoid false positives.
   */
  readonly hard: boolean;
  /** 0-based start offset in the input string. */
  readonly start: number;
  /** Exclusive end offset in the input string. */
  readonly end: number;
  /** The matched text, verbatim. */
  readonly matched: string;
  /**
   * The text to substitute when redacting. `null` means "use the category
   * default" (`[REDACTED:EMAIL]`); when set, the value is used verbatim.
   */
  readonly replacement: string | null;
  /**
   * One-line reason shown in the review UI, e.g. "matched an RFC-5322 email
   * shape" or "Luhn checksum passed".
   */
  readonly reason: string;
  /** 0..1. Both the pattern's specificity and the structural signal. */
  readonly confidence: number;
}

export interface PiiTextOptions {
  /**
   * When true, `name` findings are redacted alongside the hard categories.
   * Default false: a tutorial describing fictional personas carries names
   * without leaking PII; a reviewer opts in when the guide handles real
   * customer data.
   */
  readonly redactNames?: boolean;
  /**
   * Extra regex patterns the caller supplies. The patterns are used alongside
   * the built-in set; a match records category "api-key" so downstream code
   * sees a single classification. Callers are responsible for ensuring their
   * patterns are safe to run (no catastrophic backtracking) — the module
   * compiles them once and rejects an invalid pattern with a descriptive
   * error rather than silently dropping it.
   */
  readonly extraPatterns?: readonly {
    readonly id: string;
    readonly pattern: RegExp;
    readonly replacement?: string;
    readonly category?: PiiTextCategory;
  }[];
  /**
   * When true, the detector also runs the "url with token" pattern, which
   * catches a long-lived credential embedded in a URL query string
   * (`?access_token=...`). Default true.
   */
  readonly detectUrlTokens?: boolean;
}

export interface PiiTextReport {
  readonly version: "pii-text/1";
  /** The input length, so a consumer can verify offsets. */
  readonly inputLength: number;
  /** Findings ordered by `start`; ties broken by `end`. */
  readonly findings: readonly PiiTextFinding[];
  /** The redacted form. Equal to the input when no findings match. */
  readonly redacted: string;
  /** True when any hard finding was recorded. */
  readonly hasHardFinding: boolean;
  /** True when any soft finding was recorded. */
  readonly hasSoftFinding: boolean;
  /** Per-category counts. Always present, even when zero. */
  readonly counts: Readonly<Record<PiiTextCategory, number>>;
  /** Caller-visible notes for the review UI. */
  readonly notes: readonly PiiTextNote[];
  readonly generatedAt: string;
  readonly aiGenerated: true;
}

export interface PiiTextNote {
  readonly kind:
    | "empty-input"
    | "soft-names-suppressed"
    | "overlap-resolved"
    | "extra-pattern-applied"
    | "extra-pattern-invalid"
    | "url-token-detection-disabled";
  readonly detail: string;
}

export interface PiiTextInput {
  readonly text: string;
  readonly options?: PiiTextOptions;
  readonly audience: AudienceProfile;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Default replacement for a category. Kept short and consistent so the
 * redacted string reads cleanly in an exported PDF.
 */
const DEFAULT_REPLACEMENTS: Readonly<Record<PiiTextCategory, string>> = Object.freeze({
  email: "[REDACTED:EMAIL]",
  phone: "[REDACTED:PHONE]",
  "credit-card": "[REDACTED:CARD]",
  iban: "[REDACTED:IBAN]",
  ssn: "[REDACTED:SSN]",
  "national-id": "[REDACTED:ID]",
  "ip-address": "[REDACTED:IP]",
  "api-key": "[REDACTED:KEY]",
  password: "[REDACTED:PASSWORD]",
  address: "[REDACTED:ADDRESS]",
  name: "[REDACTED:NAME]",
  "date-of-birth": "[REDACTED:DOB]",
  "url-with-token": "[REDACTED:URL]",
});

/**
 * Categories for which a bare pattern is enough to classify ("hard"). The
 * rest are "soft": the detector requires a contextual signal.
 */
const HARD_CATEGORIES: ReadonlySet<PiiTextCategory> = new Set([
  "email",
  "phone",
  "credit-card",
  "iban",
  "ssn",
  "national-id",
  "ip-address",
  "api-key",
  "password",
  "url-with-token",
]);

/**
 * Title/role words whose *appearance immediately before* a capitalised word
 * is a strong enough signal to record a `name` finding. Deliberately short;
 * adding a title here is a deliberate loosening of the false-positive rate.
 */
const NAME_SIGNALS: readonly string[] = [
  "Mr.",
  "Mrs.",
  "Ms.",
  "Dr.",
  "Prof.",
  "contact",
  "owner",
  "manager",
  "administrator",
  "admin",
  "supervisor",
  "author",
  "reviewer",
  "approver",
  "signatory",
  "beneficiary",
];

/**
 * Field labels whose appearance immediately before a value is a signal that
 * the value is a date of birth. Kept lowercase for case-insensitive matching.
 */
const DOB_LABELS: readonly string[] = [
  "dob",
  "date of birth",
  "birthdate",
  "birth date",
  "born",
];

/**
 * Field labels whose appearance immediately before a value is a signal that
 * the value is a password. This catches the writer accidentally quoting a
 * literal password from a source snippet.
 */
const PASSWORD_LABELS: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "passphrase",
];

/**
 * Address-line signals. The detector requires both a number and a street
 * suffix to avoid matching an ordinary sentence fragment.
 */
const STREET_SUFFIXES: readonly string[] = [
  "street",
  "st",
  "avenue",
  "ave",
  "road",
  "rd",
  "boulevard",
  "blvd",
  "lane",
  "ln",
  "drive",
  "dr",
  "court",
  "ct",
  "way",
  "place",
  "pl",
  "terrace",
  "ter",
  "suite",
  "ste",
  "apt",
  "unit",
];

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function detectPii(input: PiiTextInput): PiiTextReport {
  if (input === null || typeof input !== "object") {
    throw new PiiTextError("detectPii requires an input object.", "invalid-input");
  }
  if (typeof input.text !== "string") {
    throw new PiiTextError("`text` must be a string.", "invalid-input");
  }
  const text = input.text;
  const options = readOptions(input.options);
  const notes: PiiTextNote[] = [];

  if (text.length === 0) {
    notes.push({
      kind: "empty-input",
      detail: "The input string is empty; no findings were produced.",
    });
  }

  const findings: PiiTextFinding[] = [];

  // Structured patterns. Each returns zero or more findings; the helper
  // tries every pattern even when a span overlaps another — overlaps are
  // resolved in a later pass so a reviewer can see both signals.
  scanEmail(text, findings);
  scanPhone(text, findings);
  scanCreditCard(text, findings);
  scanIban(text, findings);
  scanSsn(text, findings);
  scanNationalId(text, findings);
  scanIpAddress(text, findings);
  scanApiKeyLike(text, findings);
  scanUrlWithToken(text, findings, options.detectUrlTokens !== false);
  scanPasswordField(text, findings);
  scanAddress(text, findings);
  scanDateOfBirth(text, findings);
  scanName(text, findings);

  // Extra caller-supplied patterns.
  if (options.extraPatterns.length > 0) {
    for (const extra of options.extraPatterns) {
      try {
        // Guard against a pattern without the global flag: re-run with the
        // flag cloned so the `lastIndex` behaviour is deterministic.
        const re = ensureGlobal(extra.pattern);
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const matched = m[0] ?? "";
          if (matched.length === 0) {
            // Guard against an infinite loop on a zero-width match.
            re.lastIndex += 1;
            continue;
          }
          findings.push({
            category: extra.category ?? "api-key",
            hard: HARD_CATEGORIES.has(extra.category ?? "api-key"),
            start: m.index,
            end: m.index + matched.length,
            matched,
            replacement:
              typeof extra.replacement === "string" && extra.replacement.length > 0
                ? extra.replacement
                : null,
            reason: `matched caller-supplied pattern "${extra.id}"`,
            confidence: 0.7,
          });
        }
        notes.push({
          kind: "extra-pattern-applied",
          detail: `Caller-supplied pattern "${extra.id}" was applied to the input.`,
        });
      } catch (err) {
        notes.push({
          kind: "extra-pattern-invalid",
          detail: `Caller-supplied pattern "${extra.id}" could not be executed: ${
            err instanceof Error ? err.message : String(err)
          }.`,
        });
      }
    }
  }

  if (options.redactNames === false && findings.some((f) => f.category === "name")) {
    notes.push({
      kind: "soft-names-suppressed",
      detail:
        "`name` findings were recorded but not redacted because `redactNames` is false (the default). Pass `redactNames: true` to redact them.",
    });
  }

  if (options.detectUrlTokens === false) {
    notes.push({
      kind: "url-token-detection-disabled",
      detail:
        "URL-with-token detection was disabled by the caller. URLs with embedded credentials will not be redacted.",
    });
  }

  // Sort by start (then by descending length so the longer span wins a tie).
  findings.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const la = a.end - a.start;
    const lb = b.end - b.start;
    if (la !== lb) return lb - la;
    return 0;
  });

  // Resolve overlaps: for two findings that overlap, keep the one with the
  // higher confidence; ties go to the earlier start. Every drop is recorded
  // in a note so the reviewer sees what was suppressed.
  const accepted: PiiTextFinding[] = [];
  for (const f of findings) {
    const collide = accepted.find((a) => a.start < f.end && f.start < a.end);
    if (collide === undefined) {
      accepted.push(f);
      continue;
    }
    if (f.confidence > collide.confidence) {
      const idx = accepted.indexOf(collide);
      accepted.splice(idx, 1, f);
      notes.push({
        kind: "overlap-resolved",
        detail: `Finding at [${collide.start}, ${collide.end}) (${collide.category}) was replaced by the higher-confidence finding at [${f.start}, ${f.end}) (${f.category}).`,
      });
    } else {
      notes.push({
        kind: "overlap-resolved",
        detail: `Finding at [${f.start}, ${f.end}) (${f.category}) was suppressed in favour of the higher-confidence finding at [${collide.start}, ${collide.end}) (${collide.category}).`,
      });
    }
  }
  accepted.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));

  const counts: Record<PiiTextCategory, number> = {
    email: 0,
    phone: 0,
    "credit-card": 0,
    iban: 0,
    ssn: 0,
    "national-id": 0,
    "ip-address": 0,
    "api-key": 0,
    password: 0,
    address: 0,
    name: 0,
    "date-of-birth": 0,
    "url-with-token": 0,
  };
  for (const f of accepted) {
    counts[f.category] += 1;
  }

  const redacted = composeRedacted(text, accepted, options);

  return {
    version: "pii-text/1",
    inputLength: text.length,
    findings: accepted,
    redacted,
    hasHardFinding: accepted.some((f) => f.hard),
    hasSoftFinding: accepted.some((f) => !f.hard),
    counts,
    notes,
    generatedAt: new Date().toISOString(),
    aiGenerated: true,
  };
}

/**
 * Convenience wrapper. Equivalent to `detectPii(input).redacted`. Provided
 * because the route layer's most common call is "give me the safe form".
 */
export function redactPii(input: PiiTextInput): string {
  return detectPii(input).redacted;
}

/**
 * The LLM-visible directive block. Append to the writer's system prompt to
 * reduce the volume of PII that the detector must catch.
 */
export function buildPiiTextDirectives(input: {
  readonly audience: AudienceProfile;
  readonly industryDisclaimerCategories: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(
    "Do not produce personally identifiable information (PII) in the guide's prose.",
  );
  lines.push(
    "- Refer to a subject by role, not by name: 'the account owner', not the person's name. If a source uses a real name, use the role the source's example implies.",
  );
  lines.push(
    "- Never produce a real email address, phone number, postal address, credit-card number, IBAN, national ID, or the value of any API key, token or password. Use placeholders such as `<email>`, `<phone>` or `{{customer_email}}` where a value is required for the step to read.",
  );
  lines.push(
    "- Do not reproduce a query string that contains a token. If a source contains one, describe the parameter name rather than the value ('a signed URL with an access_token parameter').",
  );
  lines.push(
    "- Do not fabricate a realistic-looking identifier; a placeholder that looks real is itself a defect that the safety layer will flag.",
  );
  if (input.audience.seniority === "expert") {
    lines.push(
      "- Expert audiences supply their own test data; refer to inputs by field name rather than by example value.",
    );
  }
  if (input.industryDisclaimerCategories.length > 0) {
    lines.push(
      `- Where regulatory data is involved (${input.industryDisclaimerCategories.join(", ")}), use the field labels the source uses and no sample values.`,
    );
  }
  return lines.join("\n");
}

export function rehydratePiiTextReport(value: unknown): PiiTextReport {
  if (value === null || typeof value !== "object") {
    throw new PiiTextError("Rehydrate failed: payload is not an object.", "shape");
  }
  const r = value as Record<string, unknown>;
  if (r["version"] !== "pii-text/1") {
    throw new PiiTextError(
      `Rehydrate failed: expected version "pii-text/1", received "${String(r["version"])}".`,
      "shape",
    );
  }
  const findings = readFindings(r["findings"]);
  const counts = readCounts(r["counts"]);
  const inputLength =
    typeof r["inputLength"] === "number" && Number.isFinite(r["inputLength"])
      ? Math.max(0, Math.floor(r["inputLength"]))
      : 0;
  return {
    version: "pii-text/1",
    inputLength,
    findings,
    redacted: typeof r["redacted"] === "string" ? r["redacted"] : "",
    hasHardFinding: r["hasHardFinding"] === true || findings.some((f) => f.hard),
    hasSoftFinding: r["hasSoftFinding"] === true || findings.some((f) => !f.hard),
    counts,
    notes: readNotes(r["notes"]),
    generatedAt: typeof r["generatedAt"] === "string" ? r["generatedAt"] : "",
    aiGenerated: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Pattern scanners                                                            */
/* -------------------------------------------------------------------------- */

function scanEmail(text: string, out: PiiTextFinding[]): void {
  const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    // Reject obvious documentation placeholders (the angle brackets around
    // the local part already break the pattern; this matches a bare
    // example@example.com shape which is *not* a real leak).
    if (isDocumentationEmail(matched)) continue;
    out.push({
      category: "email",
      hard: true,
      start: m.index,
      end: m.index + matched.length,
      matched,
      replacement: null,
      reason: "matched an RFC-5322 email shape",
      confidence: 0.95,
    });
  }
}

function scanPhone(text: string, out: PiiTextFinding[]): void {
  // International and North American shapes. Requires at least 7 digits to
  // avoid matching a year or a small ID.
  const re = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-]?){1,3}\d{2,4}(?:[\s.-]?\d{2,4}){0,2}/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    const digits = matched.replace(/\D/gu, "");
    if (digits.length < 7 || digits.length > 15) continue;
    // Reject plain ISO dates (YYYY-MM-DD or YYYYMMDD) and years.
    if (/^[12]\d{3}[\-.\/]?\d{2}[\-.\/]?\d{2}$/u.test(matched)) continue;
    // Reject an isolated short number that only looks like a phone because
    // of surrounding digits.
    if (/^\d{1,4}$/u.test(matched)) continue;
    out.push({
      category: "phone",
      hard: true,
      start: m.index,
      end: m.index + matched.length,
      matched,
      replacement: null,
      reason: `matched a phone-number shape with ${digits.length} digits`,
      confidence: digits.length >= 10 ? 0.85 : 0.6,
    });
  }
}

function scanCreditCard(text: string, out: PiiTextFinding[]): void {
  // 13-19 digits with optional separators between groups of 4.
  const re = /\b(?:\d[ \-]?){12,18}\d\b/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    const digits = matched.replace(/\D/gu, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;
    // Reject a single repeated digit (a placeholder like 0000…).
    if (/^(\d)\1+$/u.test(digits)) continue;
    out.push({
      category: "credit-card",
      hard: true,
      start: m.index,
      end: m.index + matched.length,
      matched,
      replacement: null,
      reason: "Luhn checksum passed on a 13-19 digit sequence",
      confidence: 0.98,
    });
  }
}

function scanIban(text: string, out: PiiTextFinding[]): void {
  // Two uppercase letters, two digits, 11-30 alphanumerics; no separators.
  const re = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    // Reject common documentation placeholders like "GB00TEST...".
    if (/^(GB00|DE00|FR00|US00)/u.test(matched) && /TEST|EXAMPLE/iu.test(matched)) continue;
    if (!ibanShapeValid(matched)) continue;
    out.push({
      category: "iban",
      hard: true,
      start: m.index,
      end: m.index + matched.length,
      matched,
      replacement: null,
      reason: "matches the IBAN shape (2-letter country + 2-digit checksum + 11-30 alphanumerics)",
      confidence: 0.9,
    });
  }
}

function scanSsn(text: string, out: PiiTextFinding[]): void {
  // US SSN: NNN-NN-NNNN. Requires the hyphens so a plain 9-digit number is
  // not classified as an SSN.
  const re = /\b\d{3}-\d{2}-\d{4}\b/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    // Reject obviously fake patterns.
    if (matched === "000-00-0000" || matched === "123-45-6789") continue;
    out.push({
      category: "ssn",
      hard: true,
      start: m.index,
      end: m.index + matched.length,
      matched,
      replacement: null,
      reason: "matches the US SSN shape NNN-NN-NNNN",
      confidence: 0.9,
    });
  }
}

function scanNationalId(text: string, out: PiiTextFinding[]): void {
  // National ID numbers the detector recognises beyond the SSN. Kept narrow
  // so an ordinary numeric string is not classified: the labels are required.
  const labelled: readonly { readonly re: RegExp; readonly label: string }[] = [
    { re: /\b(?:national[\s-]?id|nino|nif|nie|social[\s-]?security[\s-]?number|passport[\s-]?(?:number|no|#)|tax[\s-]?id)\b[:\s]+([A-Z0-9\-]{6,20})/giu, label: "national id label" },
  ];
  for (const { re, label } of labelled) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const value = m[1];
      if (typeof value !== "string" || value.length < 6) continue;
      const valueStart = m.index + m[0].length - value.length;
      out.push({
        category: "national-id",
        hard: true,
        start: valueStart,
        end: valueStart + value.length,
        matched: value,
        replacement: null,
        reason: `matched a value preceded by a ${label}`,
        confidence: 0.75,
      });
    }
  }
}

function scanIpAddress(text: string, out: PiiTextFinding[]): void {
  // IPv4 dotted quad. Reject loopback and RFC-1918 ranges only when they
  // are the sole occurrence (they are not PII but they are also not
  // sensitive; the detector still records them under a lower confidence so
  // the reviewer sees them and can ignore).
  const re = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,2})\b/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    const isPrivate = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.)/u.test(matched);
    out.push({
      category: "ip-address",
      hard: true,
      start: m.index,
      end: m.index + matched.length,
      matched,
      replacement: null,
      reason: isPrivate
        ? "matched an IPv4 dotted quad from a private range"
        : "matched an IPv4 dotted quad",
      confidence: isPrivate ? 0.4 : 0.8,
    });
  }
}

function scanApiKeyLike(text: string, out: PiiTextFinding[]): void {
  // A "value assignment" is the strongest signal for a key: the pattern
  // requires a labelled key on the left and a high-entropy string on the
  // right.
  const labelled: readonly RegExp[] = [
    /\b(?:api[\s_-]?key|access[\s_-]?token|secret[\s_-]?key|client[\s_-]?secret|bearer[\s_-]?token|auth[\s_-]?token)\b[=:\s]+([A-Za-z0-9._\-]{16,})/giu,
  ];
  for (const re of labelled) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const value = m[1];
      if (typeof value !== "string" || value.length < 16) continue;
      const start = m.index + m[0].length - value.length;
      out.push({
        category: "api-key",
        hard: true,
        start,
        end: start + value.length,
        matched: value,
        replacement: null,
        reason: "matched a value preceded by a key/token label",
        confidence: 0.9,
      });
    }
  }

  // A bare JWT (three base64url segments, first two look like JSON with
  // "alg" for the header). The structural check on the header is enough to
  // avoid false positives on ordinary base64 strings.
  const jwt = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
  let jm: RegExpExecArray | null;
  while ((jm = jwt.exec(text)) !== null) {
    const matched = jm[0];
    out.push({
      category: "api-key",
      hard: true,
      start: jm.index,
      end: jm.index + matched.length,
      matched,
      replacement: null,
      reason: "matched a JWT shape (three base64url segments, JSON header prefix)",
      confidence: 0.95,
    });
  }

  // GitHub/Stripe-style prefixes seen in the wild — a conservative list. A
  // match does not imply the token is valid; the string is treated as a
  // credential regardless.
  const prefixed: readonly { readonly prefix: string; readonly label: string }[] = [
    { prefix: "ghp_", label: "GitHub personal-access token" },
    { prefix: "gho_", label: "GitHub OAuth token" },
    { prefix: "ghs_", label: "GitHub server-to-server token" },
    { prefix: "ghu_", label: "GitHub user-to-server token" },
    { prefix: "sk_live_", label: "Stripe live secret key" },
    { prefix: "sk_test_", label: "Stripe test secret key" },
    { prefix: "rk_live_", label: "Stripe live restricted key" },
    { prefix: "AKIA", label: "AWS access-key id" },
    { prefix: "ASIA", label: "AWS STS access-key id" },
    { prefix: "AIza", label: "Google API key" },
  ];
  for (const { prefix, label } of prefixed) {
    const re = new RegExp(`\\b${escapeRegex(prefix)}[A-Za-z0-9_\\-]{8,}`, "gu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const matched = m[0];
      out.push({
        category: "api-key",
        hard: true,
        start: m.index,
        end: m.index + matched.length,
        matched,
        replacement: null,
        reason: `matched a value with the ${prefix} prefix (${label})`,
        confidence: 0.95,
      });
    }
  }
}

function scanUrlWithToken(text: string, out: PiiTextFinding[], enabled: boolean): void {
  if (!enabled) return;
  // A URL with an access_token / api_key / sig / signature / jwt query
  // parameter carrying a non-trivial value.
  const re = /\bhttps?:\/\/[^\s<>"')\]]+\?(?:[^\s<>"')\]]*&)?(?:access_token|api_key|apikey|sig|signature|token|jwt|auth|key)=([A-Za-z0-9._\-~%+/]{8,})[^\s<>"')\]]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    out.push({
      category: "url-with-token",
      hard: true,
      start: m.index,
      end: m.index + matched.length,
      matched,
      replacement: null,
      reason: "matched a URL carrying a token-like query parameter",
      confidence: 0.9,
    });
  }
}

function scanPasswordField(text: string, out: PiiTextFinding[]): void {
  for (const label of PASSWORD_LABELS) {
    const re = new RegExp(
      `\\b${escapeRegex(label)}\\b[=:\\s]+["']?([^\\s"'<>]{4,})["']?`,
      "giu",
    );
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const value = m[1];
      if (typeof value !== "string" || value.length < 4) continue;
      // Skip a placeholder-style value.
      if (/^[<[{].*[>\]}]$/u.test(value)) continue;
      if (/^(?:\*+|x+|X+|\.+)$/u.test(value)) continue;
      const start = m.index + m[0].length - value.length - (m[0].endsWith("'") || m[0].endsWith('"') ? 1 : 0);
      out.push({
        category: "password",
        hard: true,
        start,
        end: start + value.length,
        matched: value,
        replacement: null,
        reason: `matched a value preceded by the label "${label}"`,
        confidence: 0.7,
      });
    }
  }
}

function scanAddress(text: string, out: PiiTextFinding[]): void {
  // Require a number followed by a street suffix word. The pair is a strong
  // enough signal; a lone number or a lone suffix is not.
  const suffixAlt = STREET_SUFFIXES.map(escapeRegex).join("|");
  const re = new RegExp(
    `\\b\\d{1,6}\\s+(?:[A-Z][A-Za-z0-9'\\-]*\\s+){0,3}(?:${suffixAlt})\\b\\.?`,
    "gu",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    if (/^\d{4}$/u.test(matched)) continue;
    out.push({
      category: "address",
      hard: false,
      start: m.index,
      end: m.index + matched.length,
      matched,
      replacement: null,
      reason: "matched a number followed by a street suffix",
      confidence: 0.55,
    });
  }
}

function scanDateOfBirth(text: string, out: PiiTextFinding[]): void {
  for (const label of DOB_LABELS) {
    const re = new RegExp(
      `\\b${escapeRegex(label)}\\b[=:\\s]+((?:\\d{1,4}[\\-/.]\\d{1,2}[\\-/.]\\d{1,4})|(?:[A-Z][a-z]+\\s+\\d{1,2},?\\s+\\d{4})|(?:\\d{1,2}\\s+[A-Z][a-z]+\\s+\\d{4}))`,
      "giu",
    );
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const value = m[1];
      if (typeof value !== "string" || value.length < 6) continue;
      const start = m.index + m[0].length - value.length;
      out.push({
        category: "date-of-birth",
        hard: false,
        start,
        end: start + value.length,
        matched: value,
        replacement: null,
        reason: `matched a date preceded by the label "${label}"`,
        confidence: 0.6,
      });
    }
  }
}

function scanName(text: string, out: PiiTextFinding[]): void {
  // A title/role word followed by one to three capitalised words. The role
  // word is the structural signal; the capitalisation is the pattern. The
  // word "user" is deliberately *not* a signal because a tutorial describes
  // a role, not a person.
  for (const signal of NAME_SIGNALS) {
    const re = new RegExp(
      `\\b${escapeRegex(signal)}\\s+((?:[A-Z][a-z'\\-]+)(?:\\s+(?:[A-Z][a-z'\\-]+|[A-Z]\\.)){0,2})\\b`,
      "gu",
    );
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      if (typeof name !== "string" || name.length < 2) continue;
      // Skip an obvious role word that starts with a capital because it is
      // the first word of a sentence.
      if (/^(?:User|Customer|Admin|Owner|Company|Team|Account)$/u.test(name)) continue;
      const start = m.index + m[0].length - name.length;
      out.push({
        category: "name",
        hard: false,
        start,
        end: start + name.length,
        matched: name,
        replacement: null,
        reason: `matched a capitalised name preceded by "${signal}"`,
        confidence: 0.5,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function composeRedacted(
  text: string,
  findings: readonly PiiTextFinding[],
  options: ReadPiiTextOptions,
): string {
  if (findings.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const f of findings) {
    if (f.start < cursor) continue;
    // Skip soft findings when the caller opted out.
    if (!f.hard && !options.redactNames && f.category === "name") {
      parts.push(text.slice(cursor, f.end));
      cursor = f.end;
      continue;
    }
    parts.push(text.slice(cursor, f.start));
    const replacement =
      f.replacement !== null && f.replacement.length > 0
        ? f.replacement
        : DEFAULT_REPLACEMENTS[f.category];
    parts.push(replacement);
    cursor = f.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const c = digits.charCodeAt(i);
    if (c < 48 || c > 57) return false;
    let n = c - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanShapeValid(iban: string): boolean {
  const compact = iban.replace(/\s+/gu, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(compact)) return false;
  // Apply the ISO 13616 checksum. Move the first four characters to the end,
  // replace letters with numbers (A=10 … Z=35), and check mod 97 == 1.
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let expanded = "";
  for (let i = 0; i < rearranged.length; i += 1) {
    const ch = rearranged.charAt(i);
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) expanded += ch;
    else if (code >= 65 && code <= 90) expanded += String(code - 55);
    else return false;
  }
  // Mod 97 by chunks to avoid a BigInt dependency; keep the arithmetic
  // deterministic and correct for the full length of a valid IBAN.
  let remainder = 0;
  for (let i = 0; i < expanded.length; i += 1) {
    remainder = (remainder * 10 + (expanded.charCodeAt(i) - 48)) % 97;
  }
  return remainder === 1;
}

function isDocumentationEmail(email: string): boolean {
  const lower = email.toLowerCase();
  // local part of "example", "user", "name", "test", "you" paired with any
  // of the documentation domains (example.com, example.org, .test, .invalid,
  // .example), or a bare .example TLD — the shapes RFC 2606 reserves.
  const domain = lower.slice(lower.indexOf("@") + 1);
  const reservedDomain =
    domain === "example.com" ||
    domain === "example.org" ||
    domain === "example.net" ||
    domain.endsWith(".example") ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".localhost");
  if (!reservedDomain) return false;
  return true;
}

function ensureGlobal(re: RegExp): RegExp {
  if (re.global) return re;
  return new RegExp(re.source, re.flags + "g");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface ReadPiiTextOptions {
  readonly redactNames: boolean;
  readonly extraPatterns: readonly {
    readonly id: string;
    readonly pattern: RegExp;
    readonly replacement?: string;
    readonly category?: PiiTextCategory;
  }[];
  readonly detectUrlTokens: boolean;
}

function readOptions(raw: PiiTextOptions | undefined): ReadPiiTextOptions {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { redactNames: false, extraPatterns: [], detectUrlTokens: true };
  }
  const extraPatterns: ReadPiiTextOptions["extraPatterns"] = [];
  if (Array.isArray(raw.extraPatterns)) {
    for (const p of raw.extraPatterns) {
      if (p === null || typeof p !== "object") continue;
      if (!(p.pattern instanceof RegExp)) continue;
      if (typeof p.id !== "string" || p.id.length === 0) continue;
      const category =
        p.category !== undefined && isPiiCategory(p.category) ? p.category : undefined;
      extraPatterns.push({
        id: p.id,
        pattern: p.pattern,
        replacement: typeof p.replacement === "string" ? p.replacement : undefined,
        category,
      });
    }
  }
  return {
    redactNames: raw.redactNames === true,
    extraPatterns,
    detectUrlTokens: raw.detectUrlTokens !== false,
  };
}

function isPiiCategory(v: unknown): v is PiiTextCategory {
  return (
    typeof v === "string" &&
    (PII_TEXT_CATEGORIES as readonly string[]).includes(v)
  );
}

function readCategory(v: unknown): PiiTextCategory {
  return typeof v === "string" && (PII_TEXT_CATEGORIES as readonly string[]).includes(v)
    ? (v as PiiTextCategory)
    : "email";
}

/* -------------------------------------------------------------------------- */
/* Rehydrate readers                                                           */
/* -------------------------------------------------------------------------- */

function readFindings(v: unknown): readonly PiiTextFinding[] {
  if (!Array.isArray(v)) return [];
  const out: PiiTextFinding[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const start = readInt(o["start"]);
    const end = readInt(o["end"]);
    if (end < start) continue;
    out.push({
      category: readCategory(o["category"]),
      hard: o["hard"] === true,
      start,
      end,
      matched: typeof o["matched"] === "string" ? o["matched"] : "",
      replacement: typeof o["replacement"] === "string" ? o["replacement"] : null,
      reason: typeof o["reason"] === "string" ? o["reason"] : "",
      confidence:
        typeof o["confidence"] === "number" && Number.isFinite(o["confidence"])
          ? o["confidence"]
          : 0,
    });
  }
  return out;
}

function readNotes(v: unknown): readonly PiiTextNote[] {
  if (!Array.isArray(v)) return [];
  const out: PiiTextNote[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = o["kind"];
    if (
      kind !== "empty-input" &&
      kind !== "soft-names-suppressed" &&
      kind !== "overlap-resolved" &&
      kind !== "extra-pattern-applied" &&
      kind !== "extra-pattern-invalid" &&
      kind !== "url-token-detection-disabled"
    ) {
      continue;
    }
    out.push({ kind, detail: typeof o["detail"] === "string" ? o["detail"] : "" });
  }
  return out;
}

function readCounts(v: unknown): Readonly<Record<PiiTextCategory, number>> {
  const out: Record<PiiTextCategory, number> = {
    email: 0,
    phone: 0,
    "credit-card": 0,
    iban: 0,
    ssn: 0,
    "national-id": 0,
    "ip-address": 0,
    "api-key": 0,
    password: 0,
    address: 0,
    name: 0,
    "date-of-birth": 0,
    "url-with-token": 0,
  };
  if (v === null || typeof v !== "object") return out;
  const o = v as Record<string, unknown>;
  for (const cat of PII_TEXT_CATEGORIES) {
    out[cat] = readInt(o[cat]);
  }
  return out;
}

function readInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Test-only internals                                                         */
/* -------------------------------------------------------------------------- */

export const __internals = Object.freeze({
  luhnValid,
  ibanShapeValid,
  isDocumentationEmail,
  escapeRegex,
  ensureGlobal,
  composeRedacted,
  readOptions,
  readFindings,
  readNotes,
  readCounts,
  scanEmail,
  scanPhone,
  scanCreditCard,
  scanIban,
  scanSsn,
  scanNationalId,
  scanIpAddress,
  scanApiKeyLike,
  scanUrlWithToken,
  scanPasswordField,
  scanAddress,
  scanDateOfBirth,
  scanName,
  HARD_CATEGORIES,
  NAME_SIGNALS,
  DOB_LABELS,
  PASSWORD_LABELS,
  STREET_SUFFIXES,
  DEFAULT_REPLACEMENTS,
});
