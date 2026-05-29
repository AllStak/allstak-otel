// ---------------------------------------------------------------------------
// Distributed-tracing propagation (W3C traceparent + baggage)
//
// Parity with @sentry/opentelemetry: this package previously shipped only a
// SpanExporter, so cross-service trace continuity relied entirely on the host
// app's upstream OTel propagator setup. `AllStakPropagator` implements the
// OpenTelemetry `TextMapPropagator` contract so users can register it directly
// and get W3C `traceparent` + `baggage` inject/extract out of the box.
//
// Design constraints (match the rest of this SDK):
//   - `@opentelemetry/*` stays a PEER dependency — no hard import, no new
//     runtime dep. The propagator is structurally typed against the OTel API
//     and reaches the real `@opentelemetry/api` lazily *only* to read/write the
//     active span context + baggage on the OTel Context object. When the API is
//     absent (or any call throws) it degrades fail-open: inject/extract become
//     no-ops or return the input context unchanged, never throwing.
//   - The W3C header format itself (parse/format `traceparent`, `baggage`) is
//     implemented locally so the wire behavior is identical regardless of
//     whether `@opentelemetry/api` is installed — that part is what the tests
//     exercise directly.
// ---------------------------------------------------------------------------

/** Structural view of an OTel `Context` (opaque key/value bag). */
export interface OtelContext {
  getValue(key: symbol): unknown;
  setValue(key: symbol, value: unknown): OtelContext;
  deleteValue(key: symbol): OtelContext;
}

/** Structural view of an OTel `TextMapSetter`. */
export interface TextMapSetter<Carrier = unknown> {
  set(carrier: Carrier, key: string, value: string): void;
}

/** Structural view of an OTel `TextMapGetter`. */
export interface TextMapGetter<Carrier = unknown> {
  keys(carrier: Carrier): string[];
  get(carrier: Carrier, key: string): string | string[] | undefined;
}

/** Structural view of an OTel `TextMapPropagator`. */
export interface TextMapPropagator<Carrier = unknown> {
  inject(context: OtelContext, carrier: Carrier, setter: TextMapSetter<Carrier>): void;
  extract(context: OtelContext, carrier: Carrier, getter: TextMapGetter<Carrier>): OtelContext;
  fields(): string[];
}

/** Minimal SpanContext shape (subset of the OTel `SpanContext`). */
export interface SpanContextLike {
  traceId: string;
  spanId: string;
  /** Bit field; bit 0 (`0x1`) is the W3C "sampled" flag. */
  traceFlags: number;
  /** Optional W3C `tracestate` header value. */
  traceStateText?: string;
  /** True when reconstructed from an incoming header (vs. locally created). */
  isRemote?: boolean;
}

export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';
export const BAGGAGE_HEADER = 'baggage';

const TRACE_FLAG_SAMPLED = 0x1;
const VERSION = '00';
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);
// W3C: a single member should stay well under 8192 bytes; total baggage is
// capped at 8192 bytes / 180 members. We apply the conservative defaults.
const MAX_BAGGAGE_BYTES = 8192;
const MAX_BAGGAGE_MEMBERS = 180;

const VALID_TRACE_ID = /^[0-9a-f]{32}$/i;
const VALID_SPAN_ID = /^[0-9a-f]{16}$/i;
// version-traceid-spanid-flags, version "00" (or any future version we still
// parse the first 4 fields of, per W3C forward-compat rules).
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/i;

// --- W3C traceparent (pure string codec) -----------------------------------

/** Format a {@link SpanContextLike} into a W3C `traceparent` header value. */
export function formatTraceParent(sc: SpanContextLike): string | null {
  if (!isValidTraceId(sc.traceId) || !isValidSpanId(sc.spanId)) return null;
  const flags = ((sc.traceFlags ?? 0) & 0xff).toString(16).padStart(2, '0');
  return `${VERSION}-${sc.traceId.toLowerCase()}-${sc.spanId.toLowerCase()}-${flags}`;
}

/**
 * Parse a W3C `traceparent` header value into a {@link SpanContextLike}.
 * Returns null when the header is missing, malformed, or carries an
 * all-zero (invalid) trace/span id. Pure and never throws.
 */
export function parseTraceParent(value: string | undefined | null): SpanContextLike | null {
  if (typeof value !== 'string') return null;
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return null;
  const [, version, traceId, spanId, flagsHex] = m;
  // Reject the reserved "ff" version and the all-zero ids.
  if (version.toLowerCase() === 'ff') return null;
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return null;
  const traceFlags = parseInt(flagsHex, 16) & 0xff;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags,
    isRemote: true,
  };
}

export function isValidTraceId(id: unknown): id is string {
  return typeof id === 'string' && VALID_TRACE_ID.test(id) && id !== INVALID_TRACE_ID;
}

export function isValidSpanId(id: unknown): id is string {
  return typeof id === 'string' && VALID_SPAN_ID.test(id) && id !== INVALID_SPAN_ID;
}

export function isSampled(traceFlags: number | undefined): boolean {
  return ((traceFlags ?? 0) & TRACE_FLAG_SAMPLED) === TRACE_FLAG_SAMPLED;
}

// --- W3C baggage (pure string codec) ---------------------------------------

/** A single decoded baggage entry. `metadata` is the raw `;`-suffix, if any. */
export interface BaggageEntry {
  value: string;
  metadata?: string;
}

/**
 * Parse a W3C `baggage` header into a key→entry map. Malformed members are
 * skipped (fail-open). Values are percent-decoded; keys are kept verbatim.
 */
export function parseBaggage(header: string | undefined | null): Map<string, BaggageEntry> {
  const out = new Map<string, BaggageEntry>();
  if (typeof header !== 'string' || header.length === 0) return out;
  const members = header.split(',');
  for (const member of members) {
    if (out.size >= MAX_BAGGAGE_MEMBERS) break;
    const trimmed = member.trim();
    if (trimmed.length === 0) continue;
    // Split metadata (everything after the first ';') off first.
    const semi = trimmed.indexOf(';');
    const kvPart = semi === -1 ? trimmed : trimmed.slice(0, semi);
    const metadata = semi === -1 ? undefined : trimmed.slice(semi + 1).trim() || undefined;
    const eq = kvPart.indexOf('=');
    if (eq <= 0) continue; // missing key or value
    const key = kvPart.slice(0, eq).trim();
    const rawValue = kvPart.slice(eq + 1).trim();
    if (key.length === 0) continue;
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      value = rawValue; // fail-open on bad percent-encoding
    }
    out.set(key, metadata ? { value, metadata } : { value });
  }
  return out;
}

/**
 * Serialize a baggage map into a W3C `baggage` header. Values are
 * percent-encoded. Output is bounded by byte size + member count; entries that
 * would overflow are dropped (fail-open, never throws). Returns null when there
 * is nothing to emit.
 */
export function formatBaggage(entries: Map<string, BaggageEntry>): string | null {
  if (!entries || entries.size === 0) return null;
  const parts: string[] = [];
  let bytes = 0;
  let count = 0;
  for (const [key, entry] of entries) {
    if (count >= MAX_BAGGAGE_MEMBERS) break;
    if (!key) continue;
    const encodedValue = encodeURIComponent(entry.value);
    let member = `${key}=${encodedValue}`;
    if (entry.metadata) member += `;${entry.metadata}`;
    const addBytes = member.length + (parts.length > 0 ? 1 : 0); // +1 for ','
    if (bytes + addBytes > MAX_BAGGAGE_BYTES) continue;
    parts.push(member);
    bytes += addBytes;
    count += 1;
  }
  return parts.length > 0 ? parts.join(',') : null;
}

// --- OTel API bridge (lazy, optional) --------------------------------------
//
// We only need three things from `@opentelemetry/api` to thread the decoded
// span context + baggage through the OTel Context object: `trace`,
// `propagation`, and `createContextKey`. They are resolved lazily and cached.
// If the module is not installed (peer dep absent) every accessor returns
// undefined and the propagator degrades to a no-op without throwing.

interface OtelApiBridge {
  trace?: {
    getSpanContext?(ctx: OtelContext): SpanContextLike | undefined;
    setSpanContext?(ctx: OtelContext, sc: SpanContextLike): OtelContext;
    wrapSpanContext?(sc: SpanContextLike): unknown;
    setSpan?(ctx: OtelContext, span: unknown): OtelContext;
  };
  propagation?: {
    getBaggage?(ctx: OtelContext): unknown;
    setBaggage?(ctx: OtelContext, baggage: unknown): OtelContext;
    createBaggage?(entries?: Record<string, BaggageEntry>): unknown;
  };
  TraceFlags?: { SAMPLED: number; NONE: number };
}

let bridgeResolved = false;
let bridge: OtelApiBridge | undefined;

/**
 * Best-effort `require` lookup that works under CJS without taking a hard
 * dependency on `@types/node` (the package reaches all Node globals via
 * `globalThis`, mirroring `process`/`crypto` access elsewhere in the SDK).
 * Shared with the sampler so the optional `@opentelemetry/api` peer dep is
 * resolved the same fail-open way everywhere.
 */
export function resolveOptionalRequire(): ((id: string) => unknown) | undefined {
  return resolveRequire();
}

function resolveRequire(): ((id: string) => unknown) | undefined {
  const g = globalThis as { require?: (id: string) => unknown; module?: { require?: (id: string) => unknown } };
  if (typeof g.require === 'function') return g.require;
  if (g.module && typeof g.module.require === 'function') return g.module.require;
  return undefined;
}

function getOtelApi(): OtelApiBridge | undefined {
  if (bridgeResolved) return bridge;
  bridgeResolved = true;
  try {
    // Indirect require so bundlers/ESM don't hard-link the optional peer dep.
    const req = resolveRequire();
    if (req) {
      bridge = req('@opentelemetry/api') as OtelApiBridge;
    }
  } catch {
    bridge = undefined;
  }
  return bridge;
}

/** Test seam: inject / clear the OTel API bridge. */
export function __setOtelApiBridge(api: OtelApiBridge | undefined): void {
  bridge = api;
  bridgeResolved = true;
}

// --- The propagator --------------------------------------------------------

/**
 * W3C `traceparent` + `baggage` propagator implementing the OpenTelemetry
 * `TextMapPropagator` contract. Drop-in for `propagation.setGlobalPropagator`
 * (parity with `@sentry/opentelemetry`'s sentry propagator), so AllStak users
 * get cross-service trace continuity without configuring the OTel core
 * `W3CTraceContextPropagator` + `W3CBaggagePropagator` themselves.
 *
 * Fully fail-open: a missing `@opentelemetry/api`, a malformed header, or any
 * thrown error degrades to a no-op rather than breaking the request path.
 */
export class AllStakPropagator implements TextMapPropagator {
  inject(context: OtelContext, carrier: unknown, setter: TextMapSetter): void {
    try {
      const api = getOtelApi();
      // 1) traceparent (+ tracestate) from the active span context.
      const sc = api?.trace?.getSpanContext?.(context);
      if (sc && isValidTraceId(sc.traceId) && isValidSpanId(sc.spanId)) {
        const traceparent = formatTraceParent(sc);
        if (traceparent) setter.set(carrier, TRACEPARENT_HEADER, traceparent);
        if (sc.traceStateText) setter.set(carrier, TRACESTATE_HEADER, sc.traceStateText);
      }
      // 2) baggage from the active context.
      const baggage = api?.propagation?.getBaggage?.(context);
      const header = serializeBaggageObject(baggage);
      if (header) setter.set(carrier, BAGGAGE_HEADER, header);
    } catch {
      // Fail-open: never let propagation break the caller's request.
    }
  }

  extract(context: OtelContext, carrier: unknown, getter: TextMapGetter): OtelContext {
    try {
      const api = getOtelApi();
      let ctx = context;

      // 1) traceparent → reconstruct a remote span context.
      const tp = singleHeader(getter.get(carrier, TRACEPARENT_HEADER));
      const sc = parseTraceParent(tp);
      if (sc && api?.trace?.setSpanContext) {
        const ts = singleHeader(getter.get(carrier, TRACESTATE_HEADER));
        if (ts) sc.traceStateText = ts;
        ctx = api.trace.setSpanContext(ctx, sc);
      }

      // 2) baggage → reconstruct an OTel Baggage and set it on the context.
      const bagHeader = singleHeader(getter.get(carrier, BAGGAGE_HEADER));
      const entries = parseBaggage(bagHeader);
      if (entries.size > 0 && api?.propagation?.createBaggage && api.propagation.setBaggage) {
        const record: Record<string, BaggageEntry> = {};
        for (const [k, v] of entries) record[k] = v;
        const baggage = api.propagation.createBaggage(record);
        ctx = api.propagation.setBaggage(ctx, baggage);
      }
      return ctx;
    } catch {
      // Fail-open: hand back the original context unchanged.
      return context;
    }
  }

  fields(): string[] {
    return [TRACEPARENT_HEADER, TRACESTATE_HEADER, BAGGAGE_HEADER];
  }
}

/** Convenience singleton, mirroring the rest of the SDK's ergonomics. */
export function allstakPropagator(): AllStakPropagator {
  return new AllStakPropagator();
}

// --- helpers ---------------------------------------------------------------

function singleHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v.length > 0 ? v[0] : undefined;
  return v ?? undefined;
}

/**
 * Read an OTel `Baggage` object (duck-typed via `getAllEntries`) into our
 * baggage map and serialize it. Returns null when empty or unreadable.
 */
function serializeBaggageObject(baggage: unknown): string | null {
  if (!baggage || typeof baggage !== 'object') return null;
  const getAll = (baggage as { getAllEntries?: () => Array<[string, { value: unknown; metadata?: { toString(): string } }]> }).getAllEntries;
  if (typeof getAll !== 'function') return null;
  let pairs: Array<[string, { value: unknown; metadata?: { toString(): string } }]>;
  try {
    pairs = getAll.call(baggage);
  } catch {
    return null;
  }
  const map = new Map<string, BaggageEntry>();
  for (const [key, entry] of pairs) {
    if (!key || entry == null) continue;
    const value = typeof entry.value === 'string' ? entry.value : String(entry.value);
    const metadata = entry.metadata != null ? String(entry.metadata.toString()) : undefined;
    map.set(key, metadata ? { value, metadata } : { value });
  }
  return formatBaggage(map);
}

// Reference the lazy bridge resolver so tree-shakers keep it; also lets the
// no-otel default path stay reachable in coverage.
void getOtelApi;
