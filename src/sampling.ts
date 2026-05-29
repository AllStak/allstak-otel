// ---------------------------------------------------------------------------
// Trace sampling helpers (parity with @sentry/opentelemetry tracesSampleRate)
//
// This package previously exposed only a SpanExporter, so the sampling decision
// lived entirely in the host's OTel `TracerProvider` config. These helpers let
// AllStak users register a sampler that honors an `allstakTracesSampleRate`
// (0..1) — the Sentry-style knob — without hand-wiring OTel's built-in
// `TraceIdRatioBasedSampler` + `ParentBasedSampler`.
//
// As with the exporter and propagator, `@opentelemetry/*` stays a PEER
// dependency: the `Sampler` interface is reproduced structurally and no
// `@opentelemetry/api` symbol is imported at runtime. The decision math is
// deterministic per trace id (same trace → same decision across services).
// ---------------------------------------------------------------------------

import { isValidTraceId, isSampled, resolveOptionalRequire } from './propagation';
import type { OtelContext, SpanContextLike } from './propagation';

/**
 * OTel `SamplingDecision`. Mirrors the enum in `@opentelemetry/sdk-trace-base`:
 *   0 NOT_RECORD          — drop the span entirely.
 *   1 RECORD              — record but do not export (not sampled).
 *   2 RECORD_AND_SAMPLED  — record and export.
 */
export enum SamplingDecision {
  NOT_RECORD = 0,
  RECORD = 1,
  RECORD_AND_SAMPLED = 2,
}

/** OTel `SamplingResult` (structural). */
export interface SamplingResult {
  decision: SamplingDecision;
  attributes?: Record<string, unknown>;
  traceState?: unknown;
}

/** OTel `Sampler` (structural). */
export interface Sampler {
  shouldSample(
    context: OtelContext,
    traceId: string,
    spanName: string,
    spanKind: number,
    attributes: Record<string, unknown>,
    links: unknown[],
  ): SamplingResult;
  toString(): string;
}

const ALWAYS_ON: SamplingResult = { decision: SamplingDecision.RECORD_AND_SAMPLED };
const ALWAYS_OFF: SamplingResult = { decision: SamplingDecision.NOT_RECORD };

/** Clamp + sanitize a sample rate into [0, 1]. Non-finite → 0 (fail-closed). */
export function normalizeSampleRate(rate: unknown): number {
  const n = typeof rate === 'number' ? rate : Number(rate);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * Deterministic ratio check from a trace id. Uses the upper 8 hex digits (the
 * approach OTel's `TraceIdRatioBasedSampler` uses) so the same trace id yields
 * the same decision on every service — required for consistent distributed
 * sampling. Returns true when the trace should be sampled at `rate`.
 */
export function traceIdInSampleRatio(traceId: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  if (!isValidTraceId(traceId)) return false;
  // Upper 32 bits of the 128-bit trace id, normalized to [0, 1).
  const upper = parseInt(traceId.slice(0, 8), 16);
  if (!Number.isFinite(upper)) return false;
  const fraction = upper / 0x100000000; // 2^32
  return fraction < rate;
}

/**
 * Root ratio sampler: samples a fraction of traces by trace id. No notion of a
 * parent — wrap it with {@link AllStakParentBasedSampler} (or use
 * {@link allstakSampler}) for the production behavior where children inherit
 * the parent's decision.
 */
export class AllStakTraceRatioSampler implements Sampler {
  readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = normalizeSampleRate(sampleRate);
  }

  shouldSample(
    _context: OtelContext,
    traceId: string,
    _spanName?: string,
    _spanKind?: number,
    _attributes?: Record<string, unknown>,
    _links?: unknown[],
  ): SamplingResult {
    if (this.sampleRate <= 0) return ALWAYS_OFF;
    if (this.sampleRate >= 1) return ALWAYS_ON;
    return traceIdInSampleRatio(traceId, this.sampleRate) ? ALWAYS_ON : ALWAYS_OFF;
  }

  toString(): string {
    return `AllStakTraceRatioSampler{${this.sampleRate}}`;
  }
}

/** Always samples (records + exports) every span. */
export class AlwaysOnSampler implements Sampler {
  shouldSample(): SamplingResult {
    return ALWAYS_ON;
  }
  toString(): string {
    return 'AllStakAlwaysOnSampler';
  }
}

/** Never samples — every span is dropped. */
export class AlwaysOffSampler implements Sampler {
  shouldSample(): SamplingResult {
    return ALWAYS_OFF;
  }
  toString(): string {
    return 'AllStakAlwaysOffSampler';
  }
}

/**
 * Reads the parent span context off the OTel Context. Resolved lazily through
 * `@opentelemetry/api` (peer dep); when the API is absent it returns undefined
 * so the sampler treats every span as a root and falls back to the ratio.
 */
function readParentSpanContext(context: OtelContext): SpanContextLike | undefined {
  try {
    const req = resolveOptionalRequire();
    if (!req) return undefined;
    const api = req('@opentelemetry/api') as {
      trace?: { getSpanContext?(ctx: OtelContext): SpanContextLike | undefined };
    };
    return api?.trace?.getSpanContext?.(context);
  } catch {
    return undefined;
  }
}

/**
 * Parent-based sampler honoring `allstakTracesSampleRate`. Behavior matches the
 * Sentry / OTel `ParentBased(TraceIdRatioBased(rate))` composite:
 *   - If there is a valid parent span context: inherit the parent's sampled
 *     flag (sampled parent → sample child, unsampled parent → drop child).
 *   - Otherwise (root span): apply the deterministic trace-id ratio at `rate`.
 *
 * Construct directly or via {@link allstakSampler}. Fail-open: when the OTel
 * API is unavailable, every span is treated as a root.
 */
export class AllStakParentBasedSampler implements Sampler {
  readonly sampleRate: number;
  private readonly root: AllStakTraceRatioSampler;

  constructor(sampleRate: number) {
    this.sampleRate = normalizeSampleRate(sampleRate);
    this.root = new AllStakTraceRatioSampler(this.sampleRate);
  }

  shouldSample(
    context: OtelContext,
    traceId: string,
    spanName: string,
    spanKind: number,
    attributes: Record<string, unknown>,
    links: unknown[],
  ): SamplingResult {
    const parent = readParentSpanContext(context);
    if (parent && isValidTraceId(parent.traceId)) {
      // Inherit the parent's decision (distributed-trace continuity).
      return isSampled(parent.traceFlags) ? ALWAYS_ON : ALWAYS_OFF;
    }
    // Root span → ratio decision.
    return this.root.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `AllStakParentBasedSampler{root=${this.root.toString()}}`;
  }
}

export interface AllStakSamplerConfig {
  /**
   * Fraction of root traces to sample, 0..1 (Sentry parity). Values outside
   * the range are clamped; non-numeric values fail closed to 0. Default 1.0
   * (sample everything) so trace continuity is on by default once registered.
   */
  allstakTracesSampleRate?: number;
}

/**
 * Build the recommended sampler: a parent-respecting ratio sampler honoring
 * `allstakTracesSampleRate`. Register it on the OTel `TracerProvider`
 * (`{ sampler: allstakSampler({ allstakTracesSampleRate: 0.2 }) }`) for parity
 * with `@sentry/opentelemetry`'s `tracesSampleRate`.
 */
export function allstakSampler(config: AllStakSamplerConfig = {}): Sampler {
  const rate = normalizeSampleRate(config.allstakTracesSampleRate ?? 1);
  if (rate <= 0) return new AlwaysOffSampler();
  if (rate >= 1) return new AlwaysOnSampler();
  return new AllStakParentBasedSampler(rate);
}

/** Singleton always-on sampler. */
export function alwaysOnSampler(): Sampler {
  return new AlwaysOnSampler();
}

/** Singleton always-off sampler. */
export function alwaysOffSampler(): Sampler {
  return new AlwaysOffSampler();
}
