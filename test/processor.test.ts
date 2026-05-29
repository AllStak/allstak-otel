import { describe, expect, it, vi } from 'vitest';
import { AllStakSpanProcessor } from '../src/index';
import type { SpanExporterLike } from '../src/index';

function makeExporterStub(overrides: Partial<SpanExporterLike> = {}): SpanExporterLike & {
  exported: unknown[][];
} {
  const exported: unknown[][] = [];
  return {
    exported,
    export(spans: unknown[]) {
      exported.push(spans);
    },
    async forceFlush() {},
    async shutdown() {},
    ...overrides,
  };
}

describe('@allstak/otel — AllStakSpanProcessor', () => {
  it('rejects construction without a valid exporter', () => {
    // @ts-expect-error — exercise the guard
    expect(() => new AllStakSpanProcessor(undefined)).toThrow(/export/);
    // @ts-expect-error — exercise the guard
    expect(() => new AllStakSpanProcessor({})).toThrow(/export/);
  });

  it('forwards each ended span to the exporter (one span per export)', () => {
    const exporter = makeExporterStub();
    const proc = new AllStakSpanProcessor(exporter);
    const span = { name: 'op' };
    proc.onEnd(span);
    expect(exporter.exported).toEqual([[span]]);
  });

  it('onStart is a no-op (AllStak only ships ended spans)', () => {
    const exporter = makeExporterStub();
    const proc = new AllStakSpanProcessor(exporter);
    proc.onStart({ name: 'op' }, {});
    expect(exporter.exported).toHaveLength(0);
  });

  it('onEnd is fail-open when export throws', () => {
    const exporter = makeExporterStub({
      export() {
        throw new Error('boom');
      },
    });
    const proc = new AllStakSpanProcessor(exporter);
    expect(() => proc.onEnd({ name: 'op' })).not.toThrow();
  });

  it('forceFlush delegates to the exporter and is fail-open', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const proc = new AllStakSpanProcessor(makeExporterStub({ forceFlush: flush }));
    await proc.forceFlush();
    expect(flush).toHaveBeenCalledTimes(1);

    const throwingProc = new AllStakSpanProcessor(
      makeExporterStub({ forceFlush: () => Promise.reject(new Error('x')) }),
    );
    await expect(throwingProc.forceFlush()).resolves.toBeUndefined();
  });

  it('shutdown delegates to the exporter', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const proc = new AllStakSpanProcessor(makeExporterStub({ shutdown }));
    await proc.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
