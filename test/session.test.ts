import { describe, expect, it, vi } from 'vitest';
import { SessionTracker, AllStakOtelExporter, SDK_NAME, SDK_VERSION } from '../src/index';
import type { SessionTrackerConfig } from '../src/index';

function makeTracker(overrides: Partial<SessionTrackerConfig> = {}, sessionId?: string) {
  const fetchImpl = (overrides.fetch as typeof fetch) ?? (vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch);
  const cfg: SessionTrackerConfig = {
    host: 'https://api.allstak.sa',
    apiKey: 'ask_dev_test',
    release: 'tier1-test',
    environment: 'development',
    platform: 'node',
    enabled: true,
    debug: false,
    fetch: fetchImpl,
    ...overrides,
  };
  return new SessionTracker(cfg, sessionId);
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

describe('@allstak/otel — session start payload', () => {
  it('POSTs /sessions/start with the full payload shape and ingest auth header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch, userId: 'user-42' }, 'sess-1');
    tracker.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.allstak.sa/ingest/v1/sessions/start');
    expect(init.method).toBe('POST');
    expect(init.headers['X-AllStak-Key']).toBe('ask_dev_test');
    expect(init.headers['User-Agent']).toBe(`${SDK_NAME}/${SDK_VERSION}`);
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      sessionId: 'sess-1',
      release: 'tier1-test',
      environment: 'development',
      userId: 'user-42',
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: 'node',
    });
  });

  it('falls back to the SDK version when no release is configured', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch, release: undefined }, 'sess-norel');
    tracker.start();
    await Promise.resolve();
    await Promise.resolve();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.release).toBe(SDK_VERSION);
  });

  it('generates a session id when none is supplied', () => {
    const tracker = makeTracker();
    expect(tracker.getSessionId()).toMatch(/[0-9a-f-]{36}/i);
  });

  it('start is idempotent — a second call does not re-POST', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch });
    tracker.start();
    tracker.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is fail-open — a rejected fetch never throws out of start', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('dns failed'));
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch });
    expect(() => tracker.start()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('@allstak/otel — session end payload + status transitions', () => {
  it('POSTs /sessions/end with sessionId, durationMs, and status', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch }, 'sess-end');
    tracker.start();
    tracker.end();
    await Promise.resolve();
    await Promise.resolve();

    const endCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/sessions/end'));
    expect(endCall).toBeDefined();
    expect(endCall![0]).toBe('https://api.allstak.sa/ingest/v1/sessions/end');
    const body = JSON.parse(endCall![1].body);
    expect(body.sessionId).toBe('sess-end');
    expect(body.status).toBe('ok');
    expect(typeof body.durationMs).toBe('number');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('default status is ok', () => {
    const tracker = makeTracker();
    tracker.start();
    expect(tracker.getStatus()).toBe('ok');
  });

  it('ok → errored on a handled error', () => {
    const tracker = makeTracker();
    tracker.start();
    tracker.recordError();
    expect(tracker.getStatus()).toBe('errored');
    expect(tracker.getErrorCount()).toBe(1);
  });

  it('errored → crashed on an unhandled crash (escalates)', () => {
    const tracker = makeTracker();
    tracker.start();
    tracker.recordError();
    expect(tracker.getStatus()).toBe('errored');
    tracker.recordCrash();
    expect(tracker.getStatus()).toBe('crashed');
  });

  it('crashed is terminal — a later handled error does not downgrade it', () => {
    const tracker = makeTracker();
    tracker.start();
    tracker.recordCrash();
    tracker.recordError();
    expect(tracker.getStatus()).toBe('crashed');
  });

  it('end carries the accumulated crashed status', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch }, 'sess-crash');
    tracker.start();
    tracker.recordCrash();
    tracker.end();
    await Promise.resolve();
    await Promise.resolve();
    const endCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/sessions/end'));
    expect(JSON.parse(endCall![1].body).status).toBe('crashed');
  });

  it('end is idempotent — a second call does not re-POST', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch });
    tracker.start();
    tracker.end();
    tracker.end();
    await Promise.resolve();
    await Promise.resolve();
    const endCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/sessions/end'));
    expect(endCalls).toHaveLength(1);
  });

  it('end before start is a no-op', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch });
    tracker.end();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is fail-open — a rejected end fetch never throws', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('network down'));
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch });
    tracker.start();
    expect(() => tracker.end()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('@allstak/otel — enableAutoSessionTracking opt-out', () => {
  it('disabled tracker never POSTs start or end', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const tracker = makeTracker({ fetch: fetchSpy as unknown as typeof fetch, enabled: false });
    tracker.start();
    tracker.recordError();
    tracker.end();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('@allstak/otel — exporter session integration', () => {
  it('does not POST sessions under the vitest runtime guard', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    // enableAutoSessionTracking defaults true, but isLikelyTestRuntime() is
    // true under vitest, so no lifecycle traffic should be emitted.
    new AllStakOtelExporter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      release: 'tier1-test',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await Promise.resolve();
    await Promise.resolve();
    const sessionCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/sessions/'));
    expect(sessionCalls).toHaveLength(0);
  });

  it('exposes a stable session id and attaches it to every exported trace batch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const exporter = new AllStakOtelExporter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      serviceName: 'otel-test',
      release: 'tier1-test',
      scheduledDelayMs: 0,
      maxRetries: 0,
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const sessionId = exporter.getSessionId();
    expect(sessionId).toMatch(/[0-9a-f-]{36}/i);

    exporter.export([makeSpan()]);
    await exporter.forceFlush();

    const traceCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/otel/v1/traces'));
    expect(traceCall).toBeDefined();
    const body = JSON.parse(traceCall![1].body);
    const attrs = body.resourceSpans[0].resource.attributes as { key: string; value: { stringValue: string } }[];
    expect(attrs).toContainEqual({ key: 'allstak.session.id', value: { stringValue: sessionId } });
  });

  it('exporter exposes safe recordError / recordCrash passthroughs', () => {
    const exporter = new AllStakOtelExporter({
      apiKey: 'ask_dev_test',
      host: 'https://api.allstak.sa',
      release: 'tier1-test',
      fetch: (vi.fn().mockResolvedValue({ ok: true }) as unknown) as typeof fetch,
    });
    // Under the vitest guard the auto-tracker is disabled, so these are no-ops;
    // assert they remain fail-open. Status-transition coverage lives in the
    // direct SessionTracker tests above.
    expect(() => {
      exporter.recordError();
      exporter.recordCrash();
    }).not.toThrow();
  });
});
