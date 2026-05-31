import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  AllStakOtelExporter,
  SDK_NAME,
  SDK_VERSION,
  toOtlpJson,
  toOtlpSpan,
  encodeAttributes,
  parseRetryAfter,
} from '../src/index';
import { __test as redactTest } from '../src/redaction';
import pkg from '../package.json';

const { scrubValueString, passesLuhn, isValueScrubExemptKey, MAX_SCAN_LENGTH } = redactTest;

function makeSpan(overrides: Record<string, unknown> = {}) {
  return {
    name: 'GET /test',
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '1'.repeat(16) }),
    startTime: [1, 0] as [number, number],
    endTime: [1, 10_000_000] as [number, number],
    attributes: { 'http.method': 'GET' },
    status: { code: 1 },
    kind: 1, // OTel JS SERVER
    ...overrides,
  };
}

function makeExporter(overrides: Partial<ConstructorParameters<typeof AllStakOtelExporter>[0]> = {}) {
  const fetchImpl = (overrides.fetch as typeof fetch) ?? (vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch);
  return new AllStakOtelExporter({
    apiKey: 'ask_dev_test',
    host: 'https://api.allstak.sa',
    serviceName: 'otel-test',
    environment: 'development',
    release: 'tier1-test',
    scheduledDelayMs: 0, // synchronous flush in tests
    maxRetries: 0,
    fetch: fetchImpl,
    ...overrides,
  });
}

describe('@allstak/otel — version consistency', () => {
  it('exposes SDK_NAME and SDK_VERSION', () => {
    expect(SDK_NAME).toBe('@allstak/otel');
    expect(SDK_VERSION).toBe((pkg as { version: string }).version);
  });

  it('matches package.json version', () => {
    expect(SDK_VERSION).toBe((pkg as { version: string }).version);
  });

  it('embeds telemetry.sdk.* in resource attributes', () => {
    const json = toOtlpJson([makeSpan()], { serviceName: 'svc' }) as Record<string, unknown>;
    const rs = (json.resourceSpans as unknown[])[0] as Record<string, unknown>;
    const attrs = (rs.resource as { attributes: { key: string; value: { stringValue: string } }[] }).attributes;
    expect(attrs).toContainEqual({ key: 'telemetry.sdk.name', value: { stringValue: SDK_NAME } });
    expect(attrs).toContainEqual({ key: 'telemetry.sdk.version', value: { stringValue: SDK_VERSION } });
    expect(attrs).toContainEqual({ key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } });
  });
});

describe('@allstak/otel — OTLP wire format', () => {
  it('emits numeric status.code per OTLP spec', () => {
    const errorSpan = toOtlpSpan(makeSpan({ status: { code: 2, message: 'oops' } }));
    expect(errorSpan.status).toEqual({ code: 2, message: 'oops' });
    const okSpan = toOtlpSpan(makeSpan({ status: { code: 1 } }));
    expect(okSpan.status).toEqual({ code: 1 });
    const unsetSpan = toOtlpSpan(makeSpan({ status: {} }));
    expect(unsetSpan.status).toEqual({ code: 0 });
  });

  it('accepts string status.code forms for back-compat', () => {
    expect(toOtlpSpan(makeSpan({ status: { code: 'STATUS_CODE_ERROR' } })).status).toEqual({ code: 2 });
    expect(toOtlpSpan(makeSpan({ status: { code: 'STATUS_CODE_OK' } })).status).toEqual({ code: 1 });
  });

  it('encodes string attributes as stringValue', () => {
    const attrs = encodeAttributes({ 'http.method': 'POST' });
    expect(attrs).toEqual([{ key: 'http.method', value: { stringValue: 'POST' } }]);
  });

  it('encodes boolean attributes as boolValue', () => {
    const attrs = encodeAttributes({ 'cache.hit': true });
    expect(attrs).toEqual([{ key: 'cache.hit', value: { boolValue: true } }]);
  });

  it('encodes integer attributes as intValue (stringified)', () => {
    const attrs = encodeAttributes({ 'http.status_code': 201 });
    expect(attrs).toEqual([{ key: 'http.status_code', value: { intValue: '201' } }]);
  });

  it('encodes float attributes as doubleValue', () => {
    const attrs = encodeAttributes({ 'load.avg': 1.5 });
    expect(attrs).toEqual([{ key: 'load.avg', value: { doubleValue: 1.5 } }]);
  });

  it('encodes array attributes as arrayValue', () => {
    const attrs = encodeAttributes({ tags: ['a', 'b'] });
    expect(attrs[0]).toEqual({
      key: 'tags',
      value: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } },
    });
  });

  it('encodes mixed-type array', () => {
    const attrs = encodeAttributes({ mix: [1, 'two', true] });
    expect(attrs[0].value).toEqual({
      arrayValue: { values: [{ intValue: '1' }, { stringValue: 'two' }, { boolValue: true }] },
    });
  });

  it('emits span.kind as numeric per OTLP enum (OTel JS SERVER=1 → OTLP=2)', () => {
    expect(toOtlpSpan(makeSpan({ kind: 0 })).kind).toBe(1); // INTERNAL
    expect(toOtlpSpan(makeSpan({ kind: 1 })).kind).toBe(2); // SERVER
    expect(toOtlpSpan(makeSpan({ kind: 2 })).kind).toBe(3); // CLIENT
    expect(toOtlpSpan(makeSpan({ kind: 'PRODUCER' })).kind).toBe(4);
    expect(toOtlpSpan(makeSpan({ kind: undefined })).kind).toBe(0);
  });

  it('emits events with timeUnixNano, name, attributes', () => {
    const span = makeSpan({
      events: [{ time: [2, 500_000_000], name: 'cache.miss', attributes: { 'key.name': 'user:42' } }],
    });
    const mapped = toOtlpSpan(span);
    expect(mapped.events).toEqual([
      {
        timeUnixNano: '2500000000',
        name: 'cache.miss',
        attributes: [{ key: 'key.name', value: { stringValue: 'user:42' } }],
        droppedAttributesCount: 0,
      },
    ]);
  });

  it('emits links with traceId, spanId, attributes', () => {
    const span = makeSpan({
      links: [{ context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }, attributes: { rel: 'follows' } }],
    });
    const mapped = toOtlpSpan(span);
    expect(mapped.links).toEqual([
      {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        attributes: [{ key: 'rel', value: { stringValue: 'follows' } }],
        droppedAttributesCount: 0,
      },
    ]);
  });

  it('emits dropped counts', () => {
    const span = makeSpan({ droppedAttributesCount: 3, droppedEventsCount: 1, droppedLinksCount: 2 });
    const mapped = toOtlpSpan(span);
    expect(mapped.droppedAttributesCount).toBe(3);
    expect(mapped.droppedEventsCount).toBe(1);
    expect(mapped.droppedLinksCount).toBe(2);
  });

  it('reads parentSpanId from parentSpanContext when parentSpanId absent', () => {
    const span = makeSpan({ parentSpanId: undefined, parentSpanContext: { spanId: 'c'.repeat(16), traceId: '' } });
    expect(toOtlpSpan(span).parentSpanId).toBe('c'.repeat(16));
  });

  it('converts hrtime to nanoseconds with BigInt precision', () => {
    const span = makeSpan({ startTime: [1_700_000_000, 123_456_789], endTime: [1_700_000_000, 999_999_999] });
    const mapped = toOtlpSpan(span);
    expect(mapped.startTimeUnixNano).toBe('1700000000123456789');
    expect(mapped.endTimeUnixNano).toBe('1700000000999999999');
  });
});

describe('@allstak/otel — redaction', () => {
  it('redacts default-sensitive keys in span attributes', () => {
    const span = makeSpan({ attributes: { authorization: 'Bearer abc', 'http.method': 'GET' } });
    const mapped = toOtlpSpan(span);
    const attrs = mapped.attributes as { key: string; value: { stringValue: string } }[];
    expect(attrs).toContainEqual({ key: 'authorization', value: { stringValue: '[REDACTED]' } });
    expect(attrs).toContainEqual({ key: 'http.method', value: { stringValue: 'GET' } });
  });

  it('redacts cookie, set-cookie, x-api-key, x-allstak-key', () => {
    const span = makeSpan({
      attributes: {
        cookie: 'session=xyz',
        'set-cookie': 'session=xyz',
        'x-api-key': 'k',
        'x-allstak-key': 'k',
      },
    });
    const attrs = toOtlpSpan(span).attributes as { key: string; value: { stringValue: string } }[];
    for (const a of attrs) expect(a.value.stringValue).toBe('[REDACTED]');
  });

  it('redacts jwt and bearer key suffixes (parity with @allstak/js v0.2.3+)', () => {
    const span = makeSpan({
      attributes: { user_jwt: 'eyJhbGciOi...', auth_bearer: 'tok', 'x-bearer': 'tok', plain: 'ok' },
    });
    const attrs = toOtlpSpan(span).attributes as { key: string; value: { stringValue: string } }[];
    const get = (k: string) => attrs.find((a) => a.key === k)?.value.stringValue;
    expect(get('user_jwt')).toBe('[REDACTED]');
    expect(get('auth_bearer')).toBe('[REDACTED]');
    expect(get('x-bearer')).toBe('[REDACTED]');
    expect(get('plain')).toBe('ok');
  });

  it('redacts password, secret, token, api_key by key-name pattern', () => {
    const span = makeSpan({
      attributes: { user_password: 'p', client_secret: 's', refresh_token: 't', stripe_api_key: 'k' },
    });
    const attrs = toOtlpSpan(span).attributes as { key: string; value: { stringValue: string } }[];
    for (const a of attrs) expect(a.value.stringValue).toBe('[REDACTED]');
  });

  it('honors custom redactKeys (string + RegExp)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter({
      fetch: fetchSpy as unknown as typeof fetch,
      redactKeys: ['custom_field', /^private_/],
    });
    const span = makeSpan({ attributes: { custom_field: 'x', private_data: 'y', public_field: 'z' } });
    exporter.export([span]);
    await exporter.forceFlush();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const mapped = body.resourceSpans[0].scopeSpans[0].spans[0].attributes as { key: string; value: { stringValue: string } }[];
    const get = (k: string) => mapped.find((a) => a.key === k)?.value.stringValue;
    expect(get('custom_field')).toBe('[REDACTED]');
    expect(get('private_data')).toBe('[REDACTED]');
    expect(get('public_field')).toBe('z');
  });

  it('redacts inside event attributes', () => {
    const span = makeSpan({
      events: [{ time: [1, 0], name: 'auth', attributes: { password: 'p', user: 'alice' } }],
    });
    const events = toOtlpSpan(span).events as Array<{ attributes: { key: string; value: { stringValue: string } }[] }>;
    const passAttr = events[0].attributes.find((a) => a.key === 'password');
    expect(passAttr?.value.stringValue).toBe('[REDACTED]');
    const userAttr = events[0].attributes.find((a) => a.key === 'user');
    expect(userAttr?.value.stringValue).toBe('alice');
  });
});

describe('@allstak/otel — transport / fail-open / retry / batching', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('rejects construction without apiKey', () => {
    expect(() => new AllStakOtelExporter({ apiKey: '' as unknown as string })).toThrow(/apiKey/);
  });

  it('sends OTLP JSON to the configured endpoint with User-Agent', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch });
    exporter.export([makeSpan({ name: 'GET /otel' })]);
    await exporter.forceFlush();
    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.allstak.sa/ingest/v1/otel/v1/traces');
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers['X-AllStak-Key']).toBe('ask_dev_test');
    expect(init.headers['User-Agent']).toBe(`${SDK_NAME}/${SDK_VERSION}`);
    const body = JSON.parse(init.body);
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('GET /otel');
  });

  it('successful export → callback code 0', async () => {
    const exporter = makeExporter();
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
      exporter.export([makeSpan()], resolve);
    });
    expect(result.code).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('network failure → callback code 1 with error (fail-open: never throws)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('dns failed'));
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch });
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
      exporter.export([makeSpan()], resolve);
    });
    expect(result.code).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('non-2xx → callback code 1 with HTTP status in message', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch });
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
      exporter.export([makeSpan()], resolve);
    });
    expect(result.code).toBe(1);
    expect(result.error!.message).toContain('503');
  });

  it('retries 5xx up to maxRetries then surfaces failure', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch, maxRetries: 2 });
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
      exporter.export([makeSpan()], resolve);
    });
    expect(result.code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 4xx (non-429)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch, maxRetries: 3 });
    await new Promise<void>((resolve) => exporter.export([makeSpan()], () => resolve()));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and 408', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: false, status: 408 })
      .mockResolvedValueOnce({ ok: true });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch, maxRetries: 2 });
    await new Promise<void>((resolve) => exporter.export([makeSpan()], () => resolve()));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('shutdown prevents further exports', async () => {
    const exporter = makeExporter();
    await exporter.shutdown();
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
      exporter.export([makeSpan()], resolve);
    });
    expect(result.code).toBe(1);
    expect(result.error!.message).toMatch(/shut down/i);
  });

  it('forceFlush resolves and drains queue', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch, scheduledDelayMs: 60_000 });
    exporter.export([makeSpan()]);
    expect(fetchSpy).not.toHaveBeenCalled();
    await exporter.forceFlush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('batches multiple spans into one HTTP request', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter({
      fetch: fetchSpy as unknown as typeof fetch,
      scheduledDelayMs: 60_000,
      maxBatchSize: 100,
    });
    exporter.export([makeSpan({ name: 'a' }), makeSpan({ name: 'b' }), makeSpan({ name: 'c' })]);
    await exporter.forceFlush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(3);
  });

  it('splits exports across batches when over maxBatchSize', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter({
      fetch: fetchSpy as unknown as typeof fetch,
      scheduledDelayMs: 60_000,
      maxBatchSize: 2,
    });
    exporter.export([makeSpan(), makeSpan(), makeSpan(), makeSpan(), makeSpan()]);
    await exporter.forceFlush();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('drops oldest when queue exceeds maxQueueSize', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter({
      fetch: fetchSpy as unknown as typeof fetch,
      scheduledDelayMs: 60_000,
      maxQueueSize: 3,
      maxBatchSize: 100,
    });
    exporter.export([makeSpan({ name: 'a' }), makeSpan({ name: 'b' })]);
    exporter.export([makeSpan({ name: 'c' }), makeSpan({ name: 'd' }), makeSpan({ name: 'e' })]);
    expect(exporter.getDroppedSpansCount()).toBe(2);
    await exporter.forceFlush();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const names = body.resourceSpans[0].scopeSpans[0].spans.map((s: { name: string }) => s.name);
    expect(names).toEqual(['c', 'd', 'e']);
  });

  it('timeout aborts the in-flight request', async () => {
    const fetchSpy = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch, exportTimeoutMs: 50, maxRetries: 0 });
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
      exporter.export([makeSpan()], resolve);
    });
    expect(result.code).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
  }, 5_000);

  it('does not emit debug logs by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch });
    exporter.export([makeSpan()]);
    await exporter.forceFlush();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('@allstak/otel — parseRetryAfter', () => {
  const NOW = 1_700_000_000_000;

  it('parses delta-seconds: "2" → 2000', () => {
    expect(parseRetryAfter('2', NOW)).toBe(2000);
  });

  it('parses HTTP-date into a delta-from-now in ms', () => {
    const future = new Date(NOW + 5000).toUTCString();
    expect(parseRetryAfter(future, NOW)).toBe(5000);
  });

  it('returns 0 for null and empty string', () => {
    expect(parseRetryAfter(null, NOW)).toBe(0);
    expect(parseRetryAfter('', NOW)).toBe(0);
    expect(parseRetryAfter('   ', NOW)).toBe(0);
  });

  it('returns 0 for garbage', () => {
    expect(parseRetryAfter('soon', NOW)).toBe(0);
    expect(parseRetryAfter('12.5', NOW)).toBe(0);
    expect(parseRetryAfter('-3', NOW)).toBe(0);
  });

  it('clamps anything over 300s to 300000', () => {
    expect(parseRetryAfter('400', NOW)).toBe(300_000);
    expect(parseRetryAfter('301', NOW)).toBe(300_000);
    expect(parseRetryAfter('300', NOW)).toBe(300_000);
    const farFuture = new Date(NOW + 600_000).toUTCString();
    expect(parseRetryAfter(farFuture, NOW)).toBe(300_000);
  });

  it('treats a past HTTP-date as 0', () => {
    const past = new Date(NOW - 5000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBe(0);
  });
});

// Helper: pull a span attribute's stringValue by key from an encoded span.
function attrStr(attrs: { key: string; value: { stringValue?: string } }[], key: string): string | undefined {
  return attrs.find((a) => a.key === key)?.value.stringValue;
}

describe('@allstak/otel — value-pattern scrubbing: Luhn / credit cards', () => {
  // 4111 1111 1111 1111 is the canonical Luhn-valid Visa test number.
  it('passesLuhn validates a real card and rejects a bad one', () => {
    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false); // last digit broken
    expect(passesLuhn('1234567890123456')).toBe(false);
  });

  it('redacts a Luhn-valid card embedded in a free-text value (default PII off)', () => {
    const attrs = encodeAttributes({ note: 'paid with card 4111 1111 1111 1111 today' });
    expect(attrStr(attrs, 'note')).toBe('paid with card [REDACTED] today');
  });

  it('redacts a hyphen-separated Luhn-valid card', () => {
    const attrs = encodeAttributes({ note: 'card=4111-1111-1111-1111' });
    expect(attrStr(attrs, 'note')).toBe('card=[REDACTED]');
  });

  it('PRESERVES a 16-digit run that FAILS Luhn (does not nuke order ids)', () => {
    // 16 digits, Luhn-invalid → must be left intact.
    const orderId = '1234567812345678';
    expect(passesLuhn(orderId)).toBe(false);
    const attrs = encodeAttributes({ 'order.ref': `order ${orderId} shipped` });
    expect(attrStr(attrs, 'order.ref')).toBe(`order ${orderId} shipped`);
  });

  it('PRESERVES short numeric runs (timestamps, ids < 13 digits)', () => {
    const attrs = encodeAttributes({ ts: 'epoch 1700000000000 ms' });
    expect(attrStr(attrs, 'ts')).toBe('epoch 1700000000000 ms');
  });

  it('redacts cards regardless of sendDefaultPii (always-on tier)', () => {
    const attrs = encodeAttributes({ note: 'card 4111111111111111' }, [], true);
    expect(attrStr(attrs, 'note')).toBe('card [REDACTED]');
  });
});

describe('@allstak/otel — value-pattern scrubbing: SSN', () => {
  it('redacts a hyphenated US SSN (always-on)', () => {
    expect(scrubValueString('ssn 123-45-6789 on file', false)).toBe('ssn [REDACTED] on file');
    // Still scrubbed even when PII is allowed (tier A).
    expect(scrubValueString('ssn 123-45-6789', true)).toBe('ssn [REDACTED]');
  });

  it('does NOT redact a bare 9-digit number (hyphens required)', () => {
    expect(scrubValueString('id 123456789 here', false)).toBe('id 123456789 here');
  });
});

describe('@allstak/otel — value-pattern scrubbing: email + IPv4 gated by sendDefaultPii', () => {
  it('redacts email + IPv4 in free-text values when sendDefaultPii=false (default)', () => {
    const attrs = encodeAttributes({
      msg: 'user alice@example.com from 192.168.1.42 failed login',
    });
    expect(attrStr(attrs, 'msg')).toBe('user [REDACTED] from [REDACTED] failed login');
  });

  it('PRESERVES email + IPv4 when sendDefaultPii=true', () => {
    const attrs = encodeAttributes(
      { msg: 'user alice@example.com from 192.168.1.42 failed login' },
      [],
      true,
    );
    expect(attrStr(attrs, 'msg')).toBe('user alice@example.com from 192.168.1.42 failed login');
  });

  it('validates IPv4 octet ranges (256 is not an IP → preserved)', () => {
    expect(scrubValueString('host 256.1.1.1 down', false)).toBe('host 256.1.1.1 down');
    expect(scrubValueString('host 10.0.0.1 down', false)).toBe('host [REDACTED] down');
  });

  it('redacts IPv6 (best-effort) when sendDefaultPii=false', () => {
    const out = scrubValueString('peer 2001:db8::1 closed', false);
    expect(out).toBe('peer [REDACTED] closed');
  });

  it('the full wire path honors sendDefaultPii from exporter config', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch, sendDefaultPii: true });
    exporter.export([makeSpan({ attributes: { 'log.message': 'login from bob@corp.io / 10.1.2.3' } })]);
    await exporter.forceFlush();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attrStr(attrs, 'log.message')).toBe('login from bob@corp.io / 10.1.2.3');
  });

  it('the full wire path scrubs email/IP by default (sendDefaultPii unset)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter({ fetch: fetchSpy as unknown as typeof fetch });
    exporter.export([makeSpan({ attributes: { 'log.message': 'login from bob@corp.io / 10.1.2.3' } })]);
    await exporter.forceFlush();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attrStr(attrs, 'log.message')).toBe('login from [REDACTED] / [REDACTED]');
  });
});

describe('@allstak/otel — explicit user identity is NOT value-scrubbed', () => {
  it('preserves user.email / user.id / user.ip set explicitly (sendDefaultPii=false)', () => {
    const attrs = encodeAttributes({
      'user.email': 'alice@example.com',
      'user.id': '42',
      'user.ip_address': '192.168.1.42',
    });
    expect(attrStr(attrs, 'user.email')).toBe('alice@example.com');
    expect(attrStr(attrs, 'user.id')).toBe('42');
    expect(attrStr(attrs, 'user.ip_address')).toBe('192.168.1.42');
  });

  it('preserves email inside an explicit nested user object', () => {
    const attrs = encodeAttributes({ user: { email: 'alice@example.com', name: 'Alice' } });
    const userVal = attrs.find((a) => a.key === 'user')?.value as {
      kvlistValue: { values: { key: string; value: { stringValue: string } }[] };
    };
    const email = userVal.kvlistValue.values.find((v) => v.key === 'email')?.value.stringValue;
    expect(email).toBe('alice@example.com');
  });

  it('isValueScrubExemptKey covers user / code / url / release fields', () => {
    expect(isValueScrubExemptKey('user.email')).toBe(true);
    expect(isValueScrubExemptKey('enduser.id')).toBe(true);
    expect(isValueScrubExemptKey('code.filepath')).toBe(true);
    expect(isValueScrubExemptKey('exception.absPath')).toBe(true);
    expect(isValueScrubExemptKey('http.url')).toBe(true);
    expect(isValueScrubExemptKey('service.version')).toBe(true);
    // Free-text fields are NOT exempt.
    expect(isValueScrubExemptKey('log.message')).toBe(false);
    expect(isValueScrubExemptKey('exception.message')).toBe(false);
  });
});

describe('@allstak/otel — value scrubbing does not corrupt stack frames / urls', () => {
  it('leaves code.filepath / url / function intact even with PII-shaped substrings', () => {
    const attrs = encodeAttributes({
      'code.filepath': '/home/alice@example.com/app/server.js',
      'http.url': 'https://api.example.com/u/4111111111111111',
      'code.function': 'handleRequest',
    });
    expect(attrStr(attrs, 'code.filepath')).toBe('/home/alice@example.com/app/server.js');
    expect(attrStr(attrs, 'http.url')).toBe('https://api.example.com/u/4111111111111111');
    expect(attrStr(attrs, 'code.function')).toBe('handleRequest');
  });

  it('key-based redaction still wins over value scrubbing', () => {
    const attrs = encodeAttributes({ password: 'alice@example.com' });
    expect(attrStr(attrs, 'password')).toBe('[REDACTED]');
  });
});

describe('@allstak/otel — value scrubbing is fail-open & bounded', () => {
  it('returns pathologically large strings unchanged (perf guard)', () => {
    const huge = 'x'.repeat(MAX_SCAN_LENGTH + 1) + ' 4111111111111111';
    // Over the scan cap → returned verbatim, never throws.
    expect(scrubValueString(huge, false)).toBe(huge);
  });

  it('never throws on odd inputs', () => {
    expect(() => scrubValueString('', false)).not.toThrow();
    // @ts-expect-error — exercise the non-string guard
    expect(scrubValueString(undefined, false)).toBe(undefined);
  });

  it('span status.message (error message) is value-scrubbed', () => {
    const span = makeSpan({ status: { code: 2, message: 'failed for user@host.com from 8.8.8.8' } });
    const mapped = toOtlpSpan(span);
    expect((mapped.status as { message: string }).message).toBe('failed for [REDACTED] from [REDACTED]');
  });
});
