// Kept in lock-step with @allstak/js@0.2.3 src/utils/redact.ts. Adding
// patterns here should be added there too (and to the PHP/Go/Nest/Fastify
// SDKs whose redactors share this list).
const DEFAULT_REDACTED_KEY_PATTERNS: RegExp[] = [
  /(^|\.)authorization$/i,
  /(^|\.)proxy-authorization$/i,
  /(^|\.)cookie$/i,
  /(^|\.)set-cookie$/i,
  /(^|\.)x-api-key$/i,
  /(^|\.)x-auth-token$/i,
  /(^|\.)x-access-token$/i,
  /(^|\.)x-allstak-key$/i,
  /(^|[._-])token$/i,
  /(^|[._-])api[._-]?key$/i,
  /(^|[._-])password$/i,
  /(^|[._-])passwd$/i,
  /(^|[._-])secret$/i,
  /(^|[._-])session[._-]?id$/i,
  /(^|[._-])csrf$/i,
  /(^|[._-])jwt$/i,
  /(^|[._-])bearer$/i,
];

const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string, extra: RegExp[] = []): boolean {
  for (const pattern of DEFAULT_REDACTED_KEY_PATTERNS) if (pattern.test(key)) return true;
  for (const pattern of extra) if (pattern.test(key)) return true;
  return false;
}

export function redactValue(value: unknown, key: string, extra: RegExp[] = []): unknown {
  if (isSensitiveKey(key, extra)) return REDACTED;
  return value;
}

export function buildExtraPatterns(extra: (string | RegExp)[] | undefined): RegExp[] {
  if (!extra) return [];
  return extra.map((p) => (p instanceof RegExp ? p : new RegExp(escapeRegex(p), 'i')));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// VALUE-PATTERN PII scrubbing (Sentry data-scrubbing parity)
//
// Key-name redaction (above) only fires when the *key* looks sensitive. This
// layer scrubs PII that leaks into free-text *values* (e.g. an exception
// message like "card 4111 1111 1111 1111 was declined"). Two tiers:
//
//   A) ALWAYS scrubbed regardless of `sendDefaultPii` — high-risk financial /
//      identity data that is never legitimately wanted in telemetry:
//        - credit-card numbers (13-19 digits, sep by space/hyphen) that PASS
//          the Luhn checksum. Digit runs that FAIL Luhn are left intact so we
//          do not nuke order ids / timestamps / phone numbers.
//        - US SSN in the hyphenated `ddd-dd-dddd` form (bare 9-digit numbers
//          are NOT matched — too ambiguous).
//   B) Scrubbed UNLESS `sendDefaultPii === true` (default false = Sentry
//      parity): email addresses and validated IPv4 addresses.
//
// Regexes are compiled once at module load. Scanning is bounded by
// MAX_SCAN_LENGTH so a pathological multi-MB string can't stall the wire path.
// ---------------------------------------------------------------------------

/** Strings longer than this are not value-scanned (returned unchanged). */
const MAX_SCAN_LENGTH = 16_384;

// A) ALWAYS-ON patterns -----------------------------------------------------

// Candidate card runs: 13-19 digits with optional single space/hyphen
// separators. Bounded by non-digit / non-separator edges so we don't slice a
// longer numeric token. Luhn-validated per-match before redacting.
const CC_CANDIDATE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d])/g;
// US SSN — hyphens REQUIRED (bare 9-digit numbers intentionally not matched).
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

// B) sendDefaultPii-gated patterns ------------------------------------------

// Standard, conservative email. Local part allows the usual RFC-ish set.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// IPv4 with each octet range-validated 0-255.
const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
// IPv6 (best-effort): full and compressed (`::`) forms. Each alternative is a
// COMPLETE address shape, ordered longest-first, and bracketed by colon-aware
// boundaries `(?<![\w:])…(?![\w:])` so we never partial-match (leaving a
// dangling `:1`) and never bite into C++-style `std::vector` scope tokens. A
// valid compressed address must contain `::`, so each alternative requires it;
// the only non-`::` form is the canonical full 8-group address. This is
// deliberately conservative — over-redaction that corrupts data is worse than
// missing an exotic IPv6 literal.
const IPV6_CORE = [
  '(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}', // full 8-group, no ::
  '(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}', // x:..:y  (one :: in middle)
  '(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}',
  '(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}',
  '(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}',
  '(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}',
  '[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}',
  '(?:[0-9A-Fa-f]{1,4}:){1,7}:', // x::  (trailing compression)
  '::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}', // ::y
].join('|');
const IPV6 = new RegExp(`(?<![\\w:])(?:${IPV6_CORE})(?![\\w:])`, 'g');

/**
 * Luhn (mod-10) checksum. Returns true only for a syntactically plausible card
 * (13-19 digits) that passes the checksum. Pure; never throws.
 */
function passesLuhn(digits: string): boolean {
  const len = digits.length;
  if (len < 13 || len > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = len - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Apply value-pattern PII scrubbing to a single string. Always-on (A) tier is
 * applied unconditionally; the (B) tier (email + IP) is applied only when
 * `sendDefaultPii` is false. Returns the input unchanged when nothing matches
 * or the string exceeds MAX_SCAN_LENGTH. Pure and fail-open: any unexpected
 * error returns the original string.
 */
export function scrubValueString(input: string, sendDefaultPii: boolean): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  // Skip pathologically large strings entirely (perf guard).
  if (input.length > MAX_SCAN_LENGTH) return input;
  try {
    let out = input;
    // A) Credit cards — redact only Luhn-valid runs (preserve the rest).
    if (out.length >= 13) {
      out = out.replace(CC_CANDIDATE, (match) => {
        const digits = match.replace(/[ -]/g, '');
        return passesLuhn(digits) ? REDACTED : match;
      });
    }
    // A) SSN (hyphenated only).
    out = out.replace(SSN, REDACTED);
    // B) Email + IP — only when the caller has NOT opted into PII.
    if (!sendDefaultPii) {
      out = out.replace(EMAIL, REDACTED);
      out = out.replace(IPV4, REDACTED);
      out = out.replace(IPV6, REDACTED);
    }
    return out;
  } catch {
    // Fail-open: never break the wire path over a scrubber error.
    return input;
  }
}

/**
 * Attribute keys whose string values must NOT be value-scrubbed:
 *   - explicit user / end-user identity (`user.*`, `enduser.*`) — set
 *     deliberately by the app, ships as-is (matches Sentry: sendDefaultPii does
 *     not strip explicitly-set user data),
 *   - code locations / file paths / functions (stack-frame fields),
 *   - URLs and paths (covered by their own URL redactor upstream),
 *   - release / version / sdk identity fields.
 * Matching is case-insensitive and anchored on the dotted key segment so it is
 * conservative (won't accidentally exempt unrelated keys).
 */
const VALUE_SCRUB_EXEMPT_KEY_PATTERNS: RegExp[] = [
  /(^|\.)user(\.|_id$|name$|$)/i, // user, user.id, user.email, user_id, username
  /(^|\.)enduser\./i, // OTel enduser.id / enduser.* convention
  /(^|\.)(code\.)?(filepath|filename|file|function|namespace|lineno|line|column|colno)$/i,
  /(^|\.)abs_?path$/i,
  /(^|\.)(url|uri|path|route|endpoint|target|location|referer|referrer)(\.|$)/i,
  /(^|\.)(release|version)$/i,
  /(^|\.)(service|telemetry)\.(name|version)$/i,
  /(^|\.)(sdk)(\.|_)/i,
  /(^|\.)session(\.|_)?id$/i,
];

/**
 * Whether value-pattern scrubbing should be SKIPPED for the given attribute
 * key (explicit-user identity, code locations, URLs, release/sdk fields).
 */
export function isValueScrubExemptKey(key: string): boolean {
  for (const pattern of VALUE_SCRUB_EXEMPT_KEY_PATTERNS) if (pattern.test(key)) return true;
  return false;
}

export const __test = {
  DEFAULT_REDACTED_KEY_PATTERNS,
  REDACTED,
  passesLuhn,
  scrubValueString,
  isValueScrubExemptKey,
  MAX_SCAN_LENGTH,
};
