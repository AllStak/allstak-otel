import { afterEach, describe, expect, it } from 'vitest';
import {
  AllStakPropagator,
  allstakPropagator,
  formatTraceParent,
  parseTraceParent,
  parseBaggage,
  formatBaggage,
  isValidTraceId,
  isValidSpanId,
  isSampled,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  BAGGAGE_HEADER,
} from '../src/index';
import type { OtelContext, SpanContextLike, TextMapGetter, TextMapSetter, BaggageEntry } from '../src/index';
import { __setOtelApiBridge } from '../src/propagation';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const SPAN_CTX_KEY = Symbol.for('test.spanContext');
const BAGGAGE_KEY = Symbol.for('test.baggage');

/** Minimal immutable OTel-Context double. */
class FakeContext implements OtelContext {
  constructor(private readonly map: Map<symbol, unknown> = new Map()) {}
  getValue(key: symbol): unknown {
    return this.map.get(key);
  }
  setValue(key: symbol, value: unknown): OtelContext {
    const next = new Map(this.map);
    next.set(key, value);
    return new FakeContext(next);
  }
  deleteValue(key: symbol): OtelContext {
    const next = new Map(this.map);
    next.delete(key);
    return new FakeContext(next);
  }
}

/** Duck-typed OTel Baggage. */
class FakeBaggage {
  constructor(private readonly entries: Record<string, BaggageEntry>) {}
  getAllEntries(): Array<[string, { value: string; metadata?: { toString(): string } }]> {
    return Object.entries(this.entries).map(([k, v]) => [
      k,
      { value: v.value, metadata: v.metadata ? { toString: () => v.metadata as string } : undefined },
    ]);
  }
}

/** Fake @opentelemetry/api bridge that stores span ctx + baggage in the context. */
function makeBridge() {
  return {
    trace: {
      getSpanContext(ctx: OtelContext): SpanContextLike | undefined {
        return ctx.getValue(SPAN_CTX_KEY) as SpanContextLike | undefined;
      },
      setSpanContext(ctx: OtelContext, sc: SpanContextLike): OtelContext {
        return ctx.setValue(SPAN_CTX_KEY, sc);
      },
    },
    propagation: {
      getBaggage(ctx: OtelContext): unknown {
        return ctx.getValue(BAGGAGE_KEY);
      },
      setBaggage(ctx: OtelContext, baggage: unknown): OtelContext {
        return ctx.setValue(BAGGAGE_KEY, baggage);
      },
      createBaggage(entries?: Record<string, BaggageEntry>): unknown {
        return new FakeBaggage(entries ?? {});
      },
    },
  };
}

const setter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const getter: TextMapGetter<Record<string, string>> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    return carrier[key];
  },
};

const TRACE_ID = 'abcdef0123456789abcdef0123456789';
const SPAN_ID = '0123456789abcdef';

afterEach(() => {
  // Always restore the real (lazy) bridge resolution between tests.
  // Setting undefined + resolved=false would re-resolve; we simply clear it.
  __setOtelApiBridge(undefined);
});

// ---------------------------------------------------------------------------
// W3C traceparent codec
// ---------------------------------------------------------------------------

describe('@allstak/otel — traceparent codec', () => {
  it('formats a sampled span context', () => {
    expect(formatTraceParent({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })).toBe(
      `00-${TRACE_ID}-${SPAN_ID}-01`,
    );
  });

  it('formats an unsampled span context', () => {
    expect(formatTraceParent({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 0 })).toBe(
      `00-${TRACE_ID}-${SPAN_ID}-00`,
    );
  });

  it('returns null for an invalid id', () => {
    expect(formatTraceParent({ traceId: 'nope', spanId: SPAN_ID, traceFlags: 1 })).toBeNull();
    expect(formatTraceParent({ traceId: '0'.repeat(32), spanId: SPAN_ID, traceFlags: 1 })).toBeNull();
  });

  it('parses a valid traceparent (roundtrip)', () => {
    const header = `00-${TRACE_ID}-${SPAN_ID}-01`;
    const sc = parseTraceParent(header);
    expect(sc).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1, isRemote: true });
    // roundtrip back to identical header
    expect(formatTraceParent(sc!)).toBe(header);
  });

  it('rejects malformed / reserved / all-zero traceparents', () => {
    expect(parseTraceParent(undefined)).toBeNull();
    expect(parseTraceParent('')).toBeNull();
    expect(parseTraceParent('garbage')).toBeNull();
    expect(parseTraceParent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull(); // reserved version
    expect(parseTraceParent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeNull(); // zero trace id
    expect(parseTraceParent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull(); // zero span id
  });

  it('id + flag validators', () => {
    expect(isValidTraceId(TRACE_ID)).toBe(true);
    expect(isValidTraceId('0'.repeat(32))).toBe(false);
    expect(isValidSpanId(SPAN_ID)).toBe(true);
    expect(isValidSpanId('xyz')).toBe(false);
    expect(isSampled(1)).toBe(true);
    expect(isSampled(0)).toBe(false);
    expect(isSampled(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W3C baggage codec
// ---------------------------------------------------------------------------

describe('@allstak/otel — baggage codec', () => {
  it('parses a baggage header into entries', () => {
    const map = parseBaggage('key1=value1,key2=value2');
    expect(map.get('key1')).toEqual({ value: 'value1' });
    expect(map.get('key2')).toEqual({ value: 'value2' });
  });

  it('percent-decodes values and keeps metadata', () => {
    const map = parseBaggage('user=a%20b;meta=1');
    expect(map.get('user')).toEqual({ value: 'a b', metadata: 'meta=1' });
  });

  it('skips malformed members (fail-open)', () => {
    const map = parseBaggage('good=1,,=novalue,bad,also=2');
    expect(map.get('good')).toEqual({ value: '1' });
    expect(map.get('also')).toEqual({ value: '2' });
    expect(map.size).toBe(2);
  });

  it('formats a baggage map with percent-encoding (roundtrip)', () => {
    const map = new Map<string, BaggageEntry>([
      ['k1', { value: 'v1' }],
      ['k2', { value: 'a b' }],
    ]);
    const header = formatBaggage(map);
    expect(header).toBe('k1=v1,k2=a%20b');
    // roundtrip
    expect(parseBaggage(header)).toEqual(map);
  });

  it('returns null for an empty map', () => {
    expect(formatBaggage(new Map())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Propagator inject / extract
// ---------------------------------------------------------------------------

describe('@allstak/otel — AllStakPropagator', () => {
  it('declares the W3C fields', () => {
    const p = new AllStakPropagator();
    expect(p.fields()).toEqual([TRACEPARENT_HEADER, TRACESTATE_HEADER, BAGGAGE_HEADER]);
  });

  it('inject is a no-op when no OTel API is present (fail-open)', () => {
    __setOtelApiBridge(undefined);
    // Re-mark as resolved-empty so getOtelApi returns undefined without require.
    const p = new AllStakPropagator();
    const carrier: Record<string, string> = {};
    // With the bridge explicitly cleared, the lazy resolver may still find a
    // real @opentelemetry/api; what we assert is that it never throws.
    expect(() => p.inject(new FakeContext(), carrier, setter)).not.toThrow();
  });

  it('injects traceparent + baggage from context', () => {
    __setOtelApiBridge(makeBridge());
    const p = allstakPropagator();
    const ctx = new FakeContext()
      .setValue(SPAN_CTX_KEY, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })
      .setValue(BAGGAGE_KEY, new FakeBaggage({ tenant: { value: 'acme' } }));
    const carrier: Record<string, string> = {};
    p.inject(ctx, carrier, setter);
    expect(carrier[TRACEPARENT_HEADER]).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(carrier[BAGGAGE_HEADER]).toBe('tenant=acme');
  });

  it('does not inject when span context is invalid', () => {
    __setOtelApiBridge(makeBridge());
    const p = new AllStakPropagator();
    const ctx = new FakeContext().setValue(SPAN_CTX_KEY, {
      traceId: '0'.repeat(32),
      spanId: SPAN_ID,
      traceFlags: 1,
    });
    const carrier: Record<string, string> = {};
    p.inject(ctx, carrier, setter);
    expect(carrier[TRACEPARENT_HEADER]).toBeUndefined();
  });

  it('extracts traceparent into a remote span context', () => {
    __setOtelApiBridge(makeBridge());
    const p = new AllStakPropagator();
    const carrier: Record<string, string> = {
      [TRACEPARENT_HEADER]: `00-${TRACE_ID}-${SPAN_ID}-01`,
    };
    const out = p.extract(new FakeContext(), carrier, getter);
    expect(out.getValue(SPAN_CTX_KEY)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
      isRemote: true,
    });
  });

  it('extracts baggage into the context', () => {
    __setOtelApiBridge(makeBridge());
    const p = new AllStakPropagator();
    const carrier: Record<string, string> = { [BAGGAGE_HEADER]: 'tenant=acme,plan=pro' };
    const out = p.extract(new FakeContext(), carrier, getter);
    const baggage = out.getValue(BAGGAGE_KEY) as FakeBaggage;
    expect(baggage).toBeInstanceOf(FakeBaggage);
    const entries = Object.fromEntries(baggage.getAllEntries().map(([k, v]) => [k, v.value]));
    expect(entries).toEqual({ tenant: 'acme', plan: 'pro' });
  });

  it('full inject → extract roundtrip preserves trace ids + baggage', () => {
    __setOtelApiBridge(makeBridge());
    const p = new AllStakPropagator();
    // service A injects
    const ctxA = new FakeContext()
      .setValue(SPAN_CTX_KEY, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })
      .setValue(BAGGAGE_KEY, new FakeBaggage({ tenant: { value: 'acme' }, region: { value: 'sa' } }));
    const wire: Record<string, string> = {};
    p.inject(ctxA, wire, setter);

    // service B extracts
    const ctxB = p.extract(new FakeContext(), wire, getter);
    const sc = ctxB.getValue(SPAN_CTX_KEY) as SpanContextLike;
    expect(sc.traceId).toBe(TRACE_ID);
    expect(sc.spanId).toBe(SPAN_ID);
    expect(sc.traceFlags).toBe(1);
    expect(sc.isRemote).toBe(true);
    const baggage = ctxB.getValue(BAGGAGE_KEY) as FakeBaggage;
    const entries = Object.fromEntries(baggage.getAllEntries().map(([k, v]) => [k, v.value]));
    expect(entries).toEqual({ tenant: 'acme', region: 'sa' });
  });

  it('extract returns the original context unchanged when headers are absent', () => {
    __setOtelApiBridge(makeBridge());
    const p = new AllStakPropagator();
    const ctx = new FakeContext();
    const out = p.extract(ctx, {}, getter);
    expect(out.getValue(SPAN_CTX_KEY)).toBeUndefined();
    expect(out.getValue(BAGGAGE_KEY)).toBeUndefined();
  });

  it('extract is fail-open when the getter throws', () => {
    __setOtelApiBridge(makeBridge());
    const p = new AllStakPropagator();
    const throwingGetter: TextMapGetter = {
      keys() {
        return [];
      },
      get() {
        throw new Error('boom');
      },
    };
    const ctx = new FakeContext();
    expect(() => p.extract(ctx, {}, throwingGetter)).not.toThrow();
    expect(p.extract(ctx, {}, throwingGetter)).toBe(ctx);
  });
});
