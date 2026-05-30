import { SDK_NAME, SDK_VERSION } from './version';
import {
  buildExtraPatterns,
  isSensitiveKey,
  isValueScrubExemptKey,
  scrubValueString,
} from './redaction';

const REDACTED = '[REDACTED]';

export interface OtlpEncodeConfig {
  serviceName?: string;
  environment?: string;
  release?: string;
  redactKeys?: (string | RegExp)[];
  /**
   * Release-health session id, emitted as the `allstak.session.id` resource
   * attribute so the backend's error consumer can correlate events to the
   * active session (markSessionErrored / markSessionCrashed).
   */
  sessionId?: string;
  /**
   * `sendDefaultPii` toggle (default false). When false, email
   * addresses and IPv4/IPv6 addresses found in free-text attribute *values*
   * are scrubbed to `[REDACTED]`. When true, the caller has opted into PII so
   * those value scrubbers are disabled (always-on credit-card / SSN scrubbing
   * still applies). Key-name redaction is unaffected.
   */
  sendDefaultPii?: boolean;
}

/**
 * Per-encode context threaded through the span/attribute walk: the compiled
 * extra key patterns plus the resolved sendDefaultPii flag.
 */
interface EncodeCtx {
  extraRedact: RegExp[];
  sendDefaultPii: boolean;
}

export function toOtlpJson(spans: unknown[], config: OtlpEncodeConfig): Record<string, unknown> {
  const extra = buildExtraPatterns(config.redactKeys);
  const sendDefaultPii = config.sendDefaultPii === true;
  const resourceAttrs = [
    kv('service.name', config.serviceName),
    kv('deployment.environment.name', config.environment),
    kv('service.version', config.release),
    kv('allstak.session.id', config.sessionId),
    kv('telemetry.sdk.name', SDK_NAME),
    kv('telemetry.sdk.version', SDK_VERSION),
    kv('telemetry.sdk.language', 'nodejs'),
  ].filter(notNull);
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: SDK_NAME, version: SDK_VERSION },
            spans: spans.map((span) => toOtlpSpan(span, extra, sendDefaultPii)),
          },
        ],
      },
    ],
  };
}

export function toOtlpSpan(
  span: unknown,
  extraRedact: RegExp[] = [],
  sendDefaultPii = false,
): Record<string, unknown> {
  const item = span as Record<string, unknown>;
  const context = readSpanContext(item);
  const start = readHrTime(item.startTime, 'startTimeUnixNano');
  const end = readHrTime(item.endTime, 'endTimeUnixNano');
  const status = (item.status as Record<string, unknown> | undefined) ?? {};
  const ctx: EncodeCtx = { extraRedact, sendDefaultPii };
  const out: Record<string, unknown> = {
    traceId: asString(context.traceId),
    spanId: asString(context.spanId),
    parentSpanId: asString(readParentSpanId(item)),
    // Span / operation name is an identifier, not free text → not value-scrubbed.
    name: asString(item.name) || 'otel.span',
    kind: normalizeKind(item.kind),
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: encodeAttributes((item.attributes as Record<string, unknown>) || {}, extraRedact, sendDefaultPii),
    droppedAttributesCount: numberOrZero(item.droppedAttributesCount),
    events: encodeEvents(item.events, ctx),
    droppedEventsCount: numberOrZero(item.droppedEventsCount),
    links: encodeLinks(item.links, ctx),
    droppedLinksCount: numberOrZero(item.droppedLinksCount),
    status: encodeStatus(status, ctx),
  };
  const traceState = context.traceState;
  if (traceState && typeof traceState === 'string') out.traceState = traceState;
  return out;
}

function readSpanContext(item: Record<string, unknown>): Record<string, string | undefined> {
  if (typeof item.spanContext === 'function') {
    try { return (item.spanContext as () => Record<string, string>)(); } catch { return {}; }
  }
  return {};
}

function readParentSpanId(item: Record<string, unknown>): string | undefined {
  if (typeof item.parentSpanId === 'string') return item.parentSpanId;
  const psc = item.parentSpanContext as Record<string, string> | undefined;
  if (psc && typeof psc.spanId === 'string') return psc.spanId;
  return undefined;
}

function readHrTime(value: unknown, _field: string): string {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    const nanos = BigInt(value[0]) * 1_000_000_000n + BigInt(value[1]);
    return nanos.toString();
  }
  if (typeof value === 'number') return (BigInt(Math.trunc(value)) * 1_000_000n).toString();
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function normalizeKind(kind: unknown): number {
  // OTLP SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER.
  // OTel JS SpanKind enum: 0=INTERNAL, 1=SERVER, 2=CLIENT, 3=PRODUCER, 4=CONSUMER.
  if (typeof kind === 'number' && kind >= 0 && kind <= 4) return kind + 1;
  if (typeof kind === 'string') {
    const map: Record<string, number> = {
      INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5, SPAN_KIND_UNSPECIFIED: 0,
      SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2, SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5,
    };
    if (kind in map) return map[kind];
  }
  return 0;
}

function encodeStatus(status: Record<string, unknown>, ctx: EncodeCtx): Record<string, unknown> {
  const codeRaw = status.code;
  let code = 0;
  if (typeof codeRaw === 'number') code = codeRaw === 1 || codeRaw === 2 ? codeRaw : 0;
  else if (typeof codeRaw === 'string') {
    const s = codeRaw.toUpperCase();
    code = s === 'STATUS_CODE_ERROR' ? 2 : s === 'STATUS_CODE_OK' ? 1 : 0;
  }
  const out: Record<string, unknown> = { code };
  const msg = status.message;
  // status.message is the error/exception message → free text, value-scrubbed.
  if (typeof msg === 'string' && msg.length > 0) {
    out.message = scrubValueString(msg, ctx.sendDefaultPii);
  }
  return out;
}

/** Max nesting depth scanned for value scrubbing inside object/array attrs. */
const MAX_SCRUB_DEPTH = 8;

export function encodeAttributes(
  attrs: Record<string, unknown> | Array<{ key: string; value: unknown }>,
  extraRedact: RegExp[] = [],
  sendDefaultPii = false,
): Array<{ key: string; value: Record<string, unknown> }> {
  const entries: Array<[string, unknown]> = Array.isArray(attrs)
    ? attrs.map((a) => [a.key, a.value])
    : Object.entries(attrs);
  const out: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, raw] of entries) {
    if (!key) continue;
    // 1) Key-name redaction wins outright (sensitive key → fully redacted).
    if (isSensitiveKey(key, extraRedact)) {
      const enc = encodeAnyValue(REDACTED, false, sendDefaultPii, 0);
      if (enc) out.push({ key, value: enc });
      continue;
    }
    // 2) Otherwise apply value-pattern scrubbing to string values, UNLESS the
    //    key is exempt (explicit user identity, code locations, URLs, release /
    //    sdk fields — those ship intact).
    const scrub = !isValueScrubExemptKey(key);
    const encoded = encodeAnyValue(raw, scrub, sendDefaultPii, 0);
    if (encoded) out.push({ key, value: encoded });
  }
  return out;
}

function encodeAnyValue(
  value: unknown,
  scrub: boolean,
  sendDefaultPii: boolean,
  depth: number,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const v = scrub ? scrubValueString(value, sendDefaultPii) : value;
    return { stringValue: v };
  }
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    if (Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (typeof value === 'bigint') return { intValue: value.toString() };
  // Stop descending past the depth cap; encode remaining nesting without
  // further string scrubbing rather than recursing unbounded.
  const childScrub = scrub && depth < MAX_SCRUB_DEPTH;
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((v) => encodeAnyValue(v, childScrub, sendDefaultPii, depth + 1)).filter(Boolean),
      },
    };
  }
  if (typeof value === 'object') {
    const kv: Array<{ key: string; value: Record<string, unknown> }> = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Honor per-key exemptions on nested object keys too (e.g. a `user`
      // object whose `email` should not be value-scrubbed).
      const nestedScrub = childScrub && !isValueScrubExemptKey(k);
      const enc = encodeAnyValue(v, nestedScrub, sendDefaultPii, depth + 1);
      if (enc) kv.push({ key: k, value: enc });
    }
    return { kvlistValue: { values: kv } };
  }
  const coerced = String(value);
  return { stringValue: scrub ? scrubValueString(coerced, sendDefaultPii) : coerced };
}

function encodeEvents(events: unknown, ctx: EncodeCtx): Array<Record<string, unknown>> {
  if (!Array.isArray(events)) return [];
  return events.map((evt) => {
    const e = evt as Record<string, unknown>;
    return {
      timeUnixNano: readHrTime(e.time, 'timeUnixNano'),
      // Event name (e.g. breadcrumb category) is an identifier → not scrubbed.
      name: asString(e.name),
      attributes: encodeAttributes((e.attributes as Record<string, unknown>) || {}, ctx.extraRedact, ctx.sendDefaultPii),
      droppedAttributesCount: numberOrZero(e.droppedAttributesCount),
    };
  });
}

function encodeLinks(links: unknown, ctx: EncodeCtx): Array<Record<string, unknown>> {
  if (!Array.isArray(links)) return [];
  return links.map((lnk) => {
    const l = lnk as Record<string, unknown>;
    const linkCtx = (l.context || l.spanContext) as Record<string, string> | undefined;
    return {
      traceId: asString(linkCtx?.traceId),
      spanId: asString(linkCtx?.spanId),
      attributes: encodeAttributes((l.attributes as Record<string, unknown>) || {}, ctx.extraRedact, ctx.sendDefaultPii),
      droppedAttributesCount: numberOrZero(l.droppedAttributesCount),
    };
  });
}

function kv(key: string, value: string | undefined): { key: string; value: { stringValue: string } } | null {
  if (!value) return null;
  return { key, value: { stringValue: value } };
}

function notNull<T>(v: T | null): v is T { return v !== null; }
function asString(v: unknown): string { return typeof v === 'string' ? v : ''; }
function numberOrZero(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
