import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllStakOtelExporter,
  OfflineQueue,
  FileSpoolAdapter,
} from '../src/index';
import type { PersistenceAdapter, PersistedEntry } from '../src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * In-memory pluggable adapter — the same seam React Native / browser backends
 * use. Lets us exercise the persist/drain/cap logic without touching the FS.
 */
class MemoryAdapter implements PersistenceAdapter {
  store = new Map<string, PersistedEntry>();
  available = true;
  failAppend = false;

  isAvailable(): boolean {
    return this.available;
  }
  async append(entry: PersistedEntry): Promise<boolean> {
    if (!this.available || this.failAppend) return false;
    this.store.set(entry.id, { ...entry });
    return true;
  }
  async list(): Promise<PersistedEntry[]> {
    if (!this.available) return [];
    return [...this.store.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async remove(id: string): Promise<void> {
    this.store.delete(id);
  }
}

function makeSpan(overrides: Record<string, unknown> = {}) {
  return {
    name: 'GET /test',
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '1'.repeat(16) }),
    startTime: [1, 0] as [number, number],
    endTime: [1, 10_000_000] as [number, number],
    attributes: { 'http.method': 'GET' },
    status: { code: 1 },
    kind: 1,
    ...overrides,
  };
}

function makeExporter(
  fetchImpl: typeof fetch,
  adapter: PersistenceAdapter | undefined,
  overrides: Partial<ConstructorParameters<typeof AllStakOtelExporter>[0]> = {},
) {
  return new AllStakOtelExporter({
    apiKey: 'ask_dev_test',
    host: 'https://api.allstak.sa',
    serviceName: 'otel-test',
    release: 'tier1-test',
    scheduledDelayMs: 0, // synchronous flush in tests
    maxRetries: 0,
    fetch: fetchImpl,
    offlineQueue: adapter ? { adapter } : undefined,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// OfflineQueue unit behavior (cap / drop-oldest / age / drain semantics)
// ---------------------------------------------------------------------------

describe('@allstak/otel — OfflineQueue caps & eviction', () => {
  it('persist() stores an already-scrubbed body', async () => {
    const adapter = new MemoryAdapter();
    const q = new OfflineQueue({ enabled: true, maxEntries: 10, maxBytes: 1e9, maxAgeMs: 1e9, adapter, debug: false });
    expect(q.isActive()).toBe(true);
    await q.persist('{"hello":"world"}');
    const entries = await adapter.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe('{"hello":"world"}');
  });

  it('drops OLDEST when over maxEntries', async () => {
    const adapter = new MemoryAdapter();
    const q = new OfflineQueue({ enabled: true, maxEntries: 2, maxBytes: 1e9, maxAgeMs: 1e9, adapter, debug: false });
    await q.persist('a');
    await q.persist('b');
    await q.persist('c'); // pushes out 'a'
    const bodies = (await adapter.list()).map((e) => e.body);
    expect(bodies).toEqual(['b', 'c']);
  });

  it('drops OLDEST when over maxBytes', async () => {
    const adapter = new MemoryAdapter();
    // each body ~4 bytes; cap at 8 bytes → only the 2 newest survive.
    const q = new OfflineQueue({ enabled: true, maxEntries: 100, maxBytes: 8, maxAgeMs: 1e9, adapter, debug: false });
    await q.persist('aaaa');
    await q.persist('bbbb');
    await q.persist('cccc');
    const bodies = (await adapter.list()).map((e) => e.body);
    expect(bodies).toEqual(['bbbb', 'cccc']);
  });

  it('drain() discards entries older than maxAgeMs without sending', async () => {
    const adapter = new MemoryAdapter();
    // Seed a stale entry directly (created 100s ago, maxAge 1s).
    adapter.store.set('stale', { id: 'stale', body: 'old', createdAt: Date.now() - 100_000 });
    const q = new OfflineQueue({ enabled: true, maxEntries: 100, maxBytes: 1e9, maxAgeMs: 1_000, adapter, debug: false });
    const send = vi.fn().mockResolvedValue('done' as const);
    const replayed = await q.drain(send);
    expect(send).not.toHaveBeenCalled();
    expect(replayed).toBe(0);
    expect(await adapter.list()).toHaveLength(0);
  });

  it('drain() removes an entry on done, keeps it on retry', async () => {
    const adapter = new MemoryAdapter();
    adapter.store.set('1', { id: '1', body: 'one', createdAt: Date.now() });
    adapter.store.set('2', { id: '2', body: 'two', createdAt: Date.now() + 1 });
    const q = new OfflineQueue({ enabled: true, maxEntries: 100, maxBytes: 1e9, maxAgeMs: 1e9, adapter, debug: false });
    const send = vi.fn()
      .mockResolvedValueOnce('done' as const)
      .mockResolvedValueOnce('retry' as const);
    const replayed = await q.drain(send);
    expect(replayed).toBe(1);
    const left = (await adapter.list()).map((e) => e.body);
    expect(left).toEqual(['two']); // the 'retry' one stays on disk
  });

  it('is inert when disabled', async () => {
    const adapter = new MemoryAdapter();
    const q = new OfflineQueue({ enabled: false, maxEntries: 10, maxBytes: 1e9, maxAgeMs: 1e9, adapter, debug: false });
    expect(q.isActive()).toBe(false);
    expect(await q.persist('x')).toBe(false);
    expect(adapter.store.size).toBe(0);
  });

  it('is inert when the adapter reports unavailable (graceful no-op)', async () => {
    const adapter = new MemoryAdapter();
    adapter.available = false;
    const q = new OfflineQueue({ enabled: true, maxEntries: 10, maxBytes: 1e9, maxAgeMs: 1e9, adapter, debug: false });
    expect(q.isActive()).toBe(false);
    expect(await q.persist('x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exporter integration: persist-on-failure & drain-on-init
// ---------------------------------------------------------------------------

describe('@allstak/otel — exporter offline persistence', () => {
  it('persists a failed batch to the offline store (network error)', async () => {
    const adapter = new MemoryAdapter();
    const fetchSpy = vi.fn().mockRejectedValue(new Error('dns failed'));
    const exporter = makeExporter(fetchSpy as unknown as typeof fetch, adapter);
    await new Promise<void>((resolve) => exporter.export([makeSpan()], () => resolve()));
    const entries = await adapter.list();
    expect(entries).toHaveLength(1);
    // Persisted body is the OTLP JSON the transport tried to send.
    const body = JSON.parse(entries[0].body);
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('GET /test');
  });

  it('persists on retryable 5xx after retries exhausted', async () => {
    const adapter = new MemoryAdapter();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const exporter = makeExporter(fetchSpy as unknown as typeof fetch, adapter, { maxRetries: 1 });
    await new Promise<void>((resolve) => exporter.export([makeSpan()], () => resolve()));
    expect(await adapter.list()).toHaveLength(1);
  });

  it('does NOT persist a permanently-undeliverable 4xx (e.g. 401)', async () => {
    const adapter = new MemoryAdapter();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const exporter = makeExporter(fetchSpy as unknown as typeof fetch, adapter);
    await new Promise<void>((resolve) => exporter.export([makeSpan()], () => resolve()));
    expect(await adapter.list()).toHaveLength(0);
  });

  it('does NOT persist on success', async () => {
    const adapter = new MemoryAdapter();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter(fetchSpy as unknown as typeof fetch, adapter);
    await new Promise<void>((resolve) => exporter.export([makeSpan()], () => resolve()));
    expect(await adapter.list()).toHaveLength(0);
  });

  it('drains and re-sends persisted batches on the NEXT init', async () => {
    const adapter = new MemoryAdapter();

    // Run #1: network is down → the batch is persisted.
    const downFetch = vi.fn().mockRejectedValue(new Error('offline'));
    const first = makeExporter(downFetch as unknown as typeof fetch, adapter);
    await new Promise<void>((resolve) => first.export([makeSpan({ name: 'survivor' })], () => resolve()));
    expect(await adapter.list()).toHaveLength(1);

    // Run #2: network is back → init drain replays it through the transport.
    const upFetch = vi.fn().mockResolvedValue({ ok: true });
    const second = makeExporter(upFetch as unknown as typeof fetch, adapter);
    await second.whenOfflineDrainSettled();

    const traceCall = upFetch.mock.calls.find((c) => String(c[0]).endsWith('/otel/v1/traces'));
    expect(traceCall).toBeDefined();
    expect(JSON.parse(traceCall![1].body).resourceSpans[0].scopeSpans[0].spans[0].name).toBe('survivor');
    // Accepted (2xx) → removed from the store.
    expect(await adapter.list()).toHaveLength(0);
  });

  it('keeps a persisted batch on disk when the replay also fails (transient)', async () => {
    const adapter = new MemoryAdapter();
    adapter.store.set('x', {
      id: 'x',
      body: JSON.stringify({ resourceSpans: [] }),
      createdAt: Date.now(),
    });
    const downFetch = vi.fn().mockRejectedValue(new Error('still offline'));
    const exporter = makeExporter(downFetch as unknown as typeof fetch, adapter);
    await exporter.whenOfflineDrainSettled();
    expect(await adapter.list()).toHaveLength(1); // survives for a future init
  });

  it('drops a persisted batch when the replay is permanently rejected (4xx)', async () => {
    const adapter = new MemoryAdapter();
    adapter.store.set('x', {
      id: 'x',
      body: JSON.stringify({ resourceSpans: [] }),
      createdAt: Date.now(),
    });
    const rejectFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const exporter = makeExporter(rejectFetch as unknown as typeof fetch, adapter);
    await exporter.whenOfflineDrainSettled();
    expect(await adapter.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scrub-before-persist: no secret may hit the store
// ---------------------------------------------------------------------------

describe('@allstak/otel — scrub before persist', () => {
  it('persisted body is PII-scrubbed — no secret value reaches the store', async () => {
    const adapter = new MemoryAdapter();
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    const exporter = makeExporter(fetchSpy as unknown as typeof fetch, adapter);
    const span = makeSpan({
      attributes: { authorization: 'Bearer SUPER_SECRET_abc123', password: 'hunter2', 'http.method': 'GET' },
    });
    await new Promise<void>((resolve) => exporter.export([span], () => resolve()));
    const raw = (await adapter.list())[0].body;
    expect(raw).not.toContain('SUPER_SECRET_abc123');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('[REDACTED]');
    // Non-sensitive value still present.
    expect(raw).toContain('GET');
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle calls are NEVER persisted
// ---------------------------------------------------------------------------

describe('@allstak/otel — session calls excluded from the offline store', () => {
  it('a failed /sessions/* call is never written to the offline store', async () => {
    const adapter = new MemoryAdapter();
    // Force the session tracker live (it is normally suppressed under vitest),
    // and make every request fail so we can prove nothing session-shaped lands
    // in the store.
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    const exporter = makeExporter(fetchSpy as unknown as typeof fetch, adapter, {
      enableAutoSessionTracking: true,
    });
    // Trigger a trace failure too, so the store is exercised.
    await new Promise<void>((resolve) => exporter.export([makeSpan()], () => resolve()));
    await exporter.shutdown(); // fires session.end()

    const bodies = (await adapter.list()).map((e) => e.body);
    for (const b of bodies) {
      // Only OTLP trace batches (resourceSpans) — never a session payload.
      const parsed = JSON.parse(b);
      expect(parsed).toHaveProperty('resourceSpans');
      expect(b).not.toContain('durationMs');
      expect(b).not.toContain('sdkName');
    }
  });
});

// ---------------------------------------------------------------------------
// Opt-out flag
// ---------------------------------------------------------------------------

describe('@allstak/otel — enableOfflineQueue opt-out', () => {
  it('does not persist anything when enableOfflineQueue is false', async () => {
    const adapter = new MemoryAdapter();
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    const exporter = makeExporter(fetchSpy as unknown as typeof fetch, adapter, {
      enableOfflineQueue: false,
    });
    await new Promise<void>((resolve) => exporter.export([makeSpan()], () => resolve()));
    expect(await adapter.list()).toHaveLength(0);
    expect(adapter.store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Graceful no-op when the store is unavailable
// ---------------------------------------------------------------------------

describe('@allstak/otel — graceful degradation', () => {
  it('export still fails-open (callback code 1) when the store is unavailable', async () => {
    const adapter = new MemoryAdapter();
    adapter.available = false; // simulate read-only FS / no localStorage
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    const exporter = makeExporter(fetchSpy as unknown as typeof fetch, adapter);
    const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
      exporter.export([makeSpan()], resolve);
    });
    expect(result.code).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
    expect(adapter.store.size).toBe(0); // nothing persisted, nothing thrown
  });

  it('init drain is a no-op (never throws) when the store is unavailable', async () => {
    const adapter = new MemoryAdapter();
    adapter.available = false;
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = makeExporter(fetchSpy as unknown as typeof fetch, adapter);
    await expect(exporter.whenOfflineDrainSettled()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FileSpoolAdapter — exercises the real Node FS path the SDK ships with
// ---------------------------------------------------------------------------

// `require` is injected by vitest into the test module scope at runtime; the
// package ships no @types/node, so declare it locally to keep the test typed.
declare const require: (m: string) => any;

describe('@allstak/otel — FileSpoolAdapter (Node fs spool)', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allstak-spool-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('round-trips an entry through real files', async () => {
    const spool = new FileSpoolAdapter(dir);
    const stored = await spool.append({ id: 'abc', body: '{"resourceSpans":[]}', createdAt: 123 });
    expect(stored).toBe(true);
    expect(spool.isAvailable()).toBe(true); // probed after first I/O
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    const listed = await spool.list();
    expect(listed).toEqual([{ id: 'abc', body: '{"resourceSpans":[]}', createdAt: 123 }]);
    await spool.remove('abc');
    expect(await spool.list()).toHaveLength(0);
  });

  it('survives a "restart": a new adapter on the same dir sees prior entries', async () => {
    const first = new FileSpoolAdapter(dir);
    await first.append({ id: 'persisted', body: '{"resourceSpans":[1]}', createdAt: 1 });
    const second = new FileSpoolAdapter(dir); // simulates a fresh process
    const listed = await second.list();
    expect(listed.map((e: { body: string }) => e.body)).toEqual(['{"resourceSpans":[1]}']);
  });

  it('is unavailable (no-op) for an un-creatable path — never throws', async () => {
    // A path under a file (not a dir) cannot be mkdir'd.
    const filePath = path.join(dir, 'a-file');
    fs.writeFileSync(filePath, 'x');
    const spool = new FileSpoolAdapter(path.join(filePath, 'nested'));
    // An I/O call triggers the async probe; mkdir fails → permanently no-op.
    const stored = await spool.append({ id: 'x', body: '{}', createdAt: 1 });
    expect(stored).toBe(false);
    expect(spool.isAvailable()).toBe(false);
    expect(await spool.list()).toHaveLength(0);
  });

  it('end-to-end: exporter persists to a real dir and a second exporter replays it', async () => {
    const downFetch = vi.fn().mockRejectedValue(new Error('offline'));
    const first = new AllStakOtelExporter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      release: 'tier1-test',
      scheduledDelayMs: 0,
      maxRetries: 0,
      fetch: downFetch as unknown as typeof fetch,
      offlineQueue: { dir },
    });
    await new Promise<void>((resolve) => first.export([makeSpan({ name: 'fs-survivor' })], () => resolve()));
    expect(fs.readdirSync(dir).length).toBe(1);

    const upFetch = vi.fn().mockResolvedValue({ ok: true });
    const second = new AllStakOtelExporter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      release: 'tier1-test',
      scheduledDelayMs: 0,
      maxRetries: 0,
      fetch: upFetch as unknown as typeof fetch,
      offlineQueue: { dir },
    });
    await second.whenOfflineDrainSettled();
    const traceCall = upFetch.mock.calls.find((c) => String(c[0]).endsWith('/otel/v1/traces'));
    expect(traceCall).toBeDefined();
    expect(JSON.parse(traceCall![1].body).resourceSpans[0].scopeSpans[0].spans[0].name).toBe('fs-survivor');
    expect(fs.readdirSync(dir).length).toBe(0); // drained
  });
});
