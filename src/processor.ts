// ---------------------------------------------------------------------------
// AllStakSpanProcessor — optional convenience SpanProcessor
//
// The OTel SDK pipeline is `SpanProcessor → SpanExporter`. Users normally wire
// the AllStak exporter into the core `BatchSpanProcessor`. This thin processor
// is a one-liner alternative that forwards ended spans straight to the
// exporter, so a minimal setup is just:
//
//   provider.addSpanProcessor(new AllStakSpanProcessor(exporter));
//
// It deliberately does NOT re-implement batching/retry/persistence — the
// exporter already owns all of that (bounded queue, backoff, offline spool).
// `@opentelemetry/*` stays a peer dependency; the SpanProcessor contract is
// reproduced structurally and nothing is imported at runtime.
// ---------------------------------------------------------------------------

/** Minimal structural view of the AllStak exporter the processor drives. */
export interface SpanExporterLike {
  export(spans: unknown[], resultCallback?: (result: { code: number; error?: Error }) => void): void;
  forceFlush?(): Promise<void>;
  shutdown(): Promise<void>;
}

/** OTel `SpanProcessor` (structural). */
export interface SpanProcessor {
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: unknown): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Forwards each ended span to the supplied exporter. Fail-open: an exporter
 * that throws synchronously on `export` must never break span finalization in
 * the host app, so `onEnd` swallows errors (the exporter itself reports
 * delivery failures via its own callback / offline spool).
 */
export class AllStakSpanProcessor implements SpanProcessor {
  private readonly exporter: SpanExporterLike;

  constructor(exporter: SpanExporterLike) {
    if (!exporter || typeof exporter.export !== 'function') {
      throw new Error('AllStakSpanProcessor: a SpanExporter with export() is required');
    }
    this.exporter = exporter;
  }

  onStart(_span: unknown, _parentContext: unknown): void {
    // No-op: AllStak only ships ended spans (it relies on final span data).
  }

  onEnd(span: unknown): void {
    try {
      this.exporter.export([span]);
    } catch {
      // Fail-open: delivery problems are the exporter's concern, not the
      // hot span-finalization path.
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.exporter.forceFlush?.();
    } catch {
      // Fail-open.
    }
  }

  async shutdown(): Promise<void> {
    await this.exporter.shutdown();
  }
}
