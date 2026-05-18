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

export const __test = { DEFAULT_REDACTED_KEY_PATTERNS, REDACTED };
