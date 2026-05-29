import { describe, expect, it } from 'vitest';
import {
  SamplingDecision,
  AllStakTraceRatioSampler,
  AllStakParentBasedSampler,
  AlwaysOnSampler,
  AlwaysOffSampler,
  allstakSampler,
  alwaysOnSampler,
  alwaysOffSampler,
  normalizeSampleRate,
  traceIdInSampleRatio,
} from '../src/index';
import type { OtelContext } from '../src/index';

// A bare context double — the parent-based sampler reaches the OTel API lazily;
// when @opentelemetry/api is absent it treats every span as a root, which is
// exactly the behavior these tests assert (no parent inheritance available).
class FakeContext implements OtelContext {
  constructor(private readonly map = new Map<symbol, unknown>()) {}
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

const CTX = new FakeContext();
const KIND = 1;
const ATTRS = {};
const LINKS: unknown[] = [];

// Trace ids chosen by their upper-32-bit fraction:
//  - LOW  starts 0x00... → fraction ~0   (sampled at almost any rate)
//  - HIGH starts 0xff... → fraction ~1   (dropped at almost any rate)
const TRACE_LOW = '00000000ffffffffffffffffffffffff';
const TRACE_HIGH = 'ffffffff00000000000000000000000000'.slice(0, 32);

function decide(sampler: { shouldSample: Function }, traceId: string): SamplingDecision {
  return sampler.shouldSample(CTX, traceId, 'op', KIND, ATTRS, LINKS).decision;
}

describe('@allstak/otel — normalizeSampleRate', () => {
  it('clamps to [0,1]', () => {
    expect(normalizeSampleRate(0.25)).toBe(0.25);
    expect(normalizeSampleRate(2)).toBe(1);
    expect(normalizeSampleRate(-1)).toBe(0);
    expect(normalizeSampleRate(0)).toBe(0);
    expect(normalizeSampleRate(1)).toBe(1);
  });

  it('fails closed (0) on non-finite / garbage', () => {
    expect(normalizeSampleRate(NaN)).toBe(0);
    expect(normalizeSampleRate(Infinity)).toBe(0); // non-finite → fail closed
    expect(normalizeSampleRate(-Infinity)).toBe(0);
    expect(normalizeSampleRate('nope')).toBe(0);
    expect(normalizeSampleRate(undefined)).toBe(0);
    expect(normalizeSampleRate('0.5')).toBe(0.5);
  });
});

describe('@allstak/otel — traceIdInSampleRatio (deterministic)', () => {
  it('rate 0 → never, rate 1 → always', () => {
    expect(traceIdInSampleRatio(TRACE_LOW, 0)).toBe(false);
    expect(traceIdInSampleRatio(TRACE_HIGH, 1)).toBe(true);
  });

  it('low-prefix trace id is sampled, high-prefix is dropped at 0.5', () => {
    expect(traceIdInSampleRatio(TRACE_LOW, 0.5)).toBe(true);
    expect(traceIdInSampleRatio(TRACE_HIGH, 0.5)).toBe(false);
  });

  it('is deterministic for the same id + rate', () => {
    expect(traceIdInSampleRatio(TRACE_LOW, 0.3)).toBe(traceIdInSampleRatio(TRACE_LOW, 0.3));
  });

  it('returns false for an invalid trace id at a fractional rate', () => {
    // rate 1 short-circuits to true (sample all); a fractional rate exercises
    // the id-validity guard, which fails closed on a malformed trace id.
    expect(traceIdInSampleRatio('not-a-trace', 0.5)).toBe(false);
  });
});

describe('@allstak/otel — AllStakTraceRatioSampler', () => {
  it('rate 0 drops everything', () => {
    const s = new AllStakTraceRatioSampler(0);
    expect(decide(s, TRACE_LOW)).toBe(SamplingDecision.NOT_RECORD);
  });

  it('rate 1 samples everything', () => {
    const s = new AllStakTraceRatioSampler(1);
    expect(decide(s, TRACE_HIGH)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('fractional rate splits by trace id', () => {
    const s = new AllStakTraceRatioSampler(0.5);
    expect(decide(s, TRACE_LOW)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(s, TRACE_HIGH)).toBe(SamplingDecision.NOT_RECORD);
  });

  it('exposes a clamped sampleRate + toString', () => {
    expect(new AllStakTraceRatioSampler(5).sampleRate).toBe(1);
    expect(new AllStakTraceRatioSampler(0.2).toString()).toContain('0.2');
  });
});

describe('@allstak/otel — Always on/off samplers', () => {
  it('AlwaysOnSampler always records+samples', () => {
    expect(decide(new AlwaysOnSampler(), TRACE_HIGH)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(alwaysOnSampler(), TRACE_HIGH)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('AlwaysOffSampler always drops', () => {
    expect(decide(new AlwaysOffSampler(), TRACE_LOW)).toBe(SamplingDecision.NOT_RECORD);
    expect(decide(alwaysOffSampler(), TRACE_LOW)).toBe(SamplingDecision.NOT_RECORD);
  });
});

describe('@allstak/otel — AllStakParentBasedSampler (root fallback)', () => {
  // Without @opentelemetry/api the sampler sees no parent and applies the ratio.
  it('root span uses the ratio decision', () => {
    const s = new AllStakParentBasedSampler(0.5);
    expect(decide(s, TRACE_LOW)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(s, TRACE_HIGH)).toBe(SamplingDecision.NOT_RECORD);
  });

  it('rate 0 drops all roots, rate 1 samples all roots', () => {
    expect(decide(new AllStakParentBasedSampler(0), TRACE_LOW)).toBe(SamplingDecision.NOT_RECORD);
    expect(decide(new AllStakParentBasedSampler(1), TRACE_HIGH)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('toString reflects the wrapped root sampler', () => {
    expect(new AllStakParentBasedSampler(0.3).toString()).toContain('AllStakTraceRatioSampler');
  });
});

describe('@allstak/otel — allstakSampler factory (allstakTracesSampleRate)', () => {
  it('rate 1 (default) → always-on', () => {
    const s = allstakSampler();
    expect(s).toBeInstanceOf(AlwaysOnSampler);
    expect(decide(s, TRACE_HIGH)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('rate 0 → always-off', () => {
    const s = allstakSampler({ allstakTracesSampleRate: 0 });
    expect(s).toBeInstanceOf(AlwaysOffSampler);
    expect(decide(s, TRACE_LOW)).toBe(SamplingDecision.NOT_RECORD);
  });

  it('fractional rate → parent-based ratio sampler', () => {
    const s = allstakSampler({ allstakTracesSampleRate: 0.5 });
    expect(s).toBeInstanceOf(AllStakParentBasedSampler);
    expect(decide(s, TRACE_LOW)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(s, TRACE_HIGH)).toBe(SamplingDecision.NOT_RECORD);
  });

  it('garbage rate fails closed to always-off', () => {
    const s = allstakSampler({ allstakTracesSampleRate: NaN });
    expect(s).toBeInstanceOf(AlwaysOffSampler);
  });
});
