import { SDK_NAME, SDK_VERSION } from './version';
import { toOtlpJson } from './otlp';
import { SessionTracker } from './session';
import type { SessionStatus } from './session';

export { SDK_NAME, SDK_VERSION } from './version';
export { toOtlpJson, toOtlpSpan, encodeAttributes } from './otlp';
export type { OtlpEncodeConfig } from './otlp';
export { SessionTracker } from './session';
export type { SessionStatus, SessionTrackerConfig } from './session';

const DEFAULT_HOST = 'https://api.allstak.sa';
const DEFAULT_EXPORT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 256;
const DEFAULT_MAX_QUEUE_SIZE = 2_048;
const DEFAULT_SCHEDULED_DELAY_MS = 2_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;
/** Upper bound for any honored Retry-After delay. */
const MAX_RETRY_AFTER_MS = 300_000;

/**
 * Parse an HTTP `Retry-After` header into a delay in milliseconds.
 *
 * Supports the two RFC 7231 forms:
 *   - delta-seconds: a non-negative integer (e.g. "120" → 120000ms)
 *   - HTTP-date: an absolute date; the delta from `now` is returned (clamped ≥ 0)
 *
 * Returns 0 when the header is absent, empty, or unparseable so callers can
 * fall back to their computed backoff. The result is clamped to
 * MAX_RETRY_AFTER_MS (300000). Pure and side-effect free.
 */
export function parseRetryAfter(headerValue: string | null, now: number): number {
  if (headerValue == null) return 0;
  const raw = headerValue.trim();
  if (raw === '') return 0;

  let ms: number;
  if (/^\d+$/.test(raw)) {
    // delta-seconds: a bare non-negative integer.
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    ms = seconds * 1000;
  } else {
    // HTTP-date form.
    const when = Date.parse(raw);
    if (Number.isNaN(when)) return 0;
    const delta = when - now;
    ms = delta > 0 ? delta : 0;
  }

  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

export interface AllStakOtelExporterConfig {
  apiKey: string;
  host?: string;
  serviceName?: string;
  environment?: string;
  release?: string;
  /** Extra attribute key patterns to redact (case-insensitive). */
  redactKeys?: (string | RegExp)[];
  /** Max spans per HTTP request. Default 256. */
  maxBatchSize?: number;
  /** Max spans buffered before drop-oldest. Default 2048. */
  maxQueueSize?: number;
  /** Flush interval in ms. Default 2000. Set 0 to disable batching (per-export send). */
  scheduledDelayMs?: number;
  /** Per-request timeout in ms. Default 5000. */
  exportTimeoutMs?: number;
  /** Max retry attempts for transient failures. Default 3. */
  maxRetries?: number;
  /** Register the configured release at exporter startup. Default true. */
  autoRegisterRelease?: boolean;
  /**
   * Track one release-health session per process (Sentry-style). Posts
   * `/sessions/start` on init and `/sessions/end` on shutdown. Default true.
   */
  enableAutoSessionTracking?: boolean;
  /** Identifier of the current user, attached to the session start payload. */
  userId?: string;
  /** Platform reported on the session payload. Default "node". */
  platform?: string;
  /** Enable debug logging. Default false. */
  debug?: boolean;
  /** Override fetch (for testing). */
  fetch?: typeof fetch;
}

type ExportCallback = (result: { code: number; error?: Error }) => void;

interface QueuedSpan {
  span: unknown;
  callback?: ExportCallback;
}

export class AllStakOtelExporter {
  readonly sdkName = SDK_NAME;
  readonly sdkVersion = SDK_VERSION;

  private readonly endpoint: string;
  private readonly cfg: Required<Omit<AllStakOtelExporterConfig, 'fetch' | 'redactKeys' | 'host' | 'serviceName' | 'environment' | 'release' | 'userId'>> &
    Pick<AllStakOtelExporterConfig, 'fetch' | 'redactKeys' | 'serviceName' | 'environment' | 'release' | 'userId'>;
  private readonly releaseEndpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly session: SessionTracker;
  private queue: QueuedSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = 0;
  private shuttingDown = false;
  private droppedSpans = 0;

  constructor(config: AllStakOtelExporterConfig) {
    if (!config || typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
      throw new Error('AllStakOtelExporter: apiKey is required');
    }
    const host = (config.host || DEFAULT_HOST).replace(/\/$/, '');
    this.endpoint = `${host}/ingest/v1/otel/v1/traces`;
    this.releaseEndpoint = `${host}/ingest/v1/releases`;
    this.cfg = {
      apiKey: config.apiKey,
      serviceName: config.serviceName,
      environment: config.environment,
      release: config.release,
      redactKeys: config.redactKeys,
      maxBatchSize: config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      maxQueueSize: config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      scheduledDelayMs: config.scheduledDelayMs ?? DEFAULT_SCHEDULED_DELAY_MS,
      exportTimeoutMs: config.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      autoRegisterRelease: config.autoRegisterRelease ?? true,
      enableAutoSessionTracking: config.enableAutoSessionTracking ?? true,
      platform: config.platform ?? 'node',
      userId: config.userId,
      debug: config.debug ?? false,
      fetch: config.fetch,
    };
    this.fetchImpl = (config.fetch || globalThis.fetch) as typeof fetch;
    if (!this.fetchImpl) {
      throw new Error('AllStakOtelExporter: fetch is not available in this runtime');
    }
    // Sessions are never sampled, but they are skipped under a unit-test
    // runtime so test suites don't emit lifecycle traffic (parity with the
    // release-registration guard and the Java SDK's test guard).
    this.session = new SessionTracker({
      host,
      apiKey: this.cfg.apiKey,
      release: this.cfg.release,
      environment: this.cfg.environment,
      userId: this.cfg.userId,
      platform: this.cfg.platform,
      enabled: this.cfg.enableAutoSessionTracking && !isLikelyTestRuntime(),
      debug: this.cfg.debug,
      fetch: this.fetchImpl,
    });
    this.registerRuntimeRelease();
    this.session.start();
  }

  /** Stable session id attached to every exported trace batch. */
  getSessionId(): string {
    return this.session.getSessionId();
  }

  /** Record a HANDLED error against the active session (status `ok` → `errored`). */
  recordError(): void {
    this.session.recordError();
  }

  /** Record an UNHANDLED / fatal crash against the active session (status `crashed`). */
  recordCrash(): void {
    this.session.recordCrash();
  }

  /** OTel SpanExporter contract. */
  export(spans: unknown[], callback?: ExportCallback): void {
    if (this.shuttingDown) {
      callback?.({ code: 1, error: new Error('Exporter has been shut down') });
      return;
    }
    if (!Array.isArray(spans) || spans.length === 0) {
      callback?.({ code: 0 });
      return;
    }
    for (const span of spans) {
      if (this.queue.length >= this.cfg.maxQueueSize) {
        this.queue.shift();
        this.droppedSpans++;
        if (this.cfg.debug) this.log('queue full, dropping oldest span');
      }
      this.queue.push({ span, callback });
    }
    if (this.cfg.scheduledDelayMs <= 0 || this.queue.length >= this.cfg.maxBatchSize) {
      void this.drain(callback);
    } else {
      this.scheduleFlush();
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.drain();
    // Best-effort, fire-and-forget; never blocks or throws the shutdown path.
    this.session.end();
  }

  async forceFlush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.drain();
  }

  /** Diagnostic: number of spans dropped due to queue overflow. */
  getDroppedSpansCount(): number { return this.droppedSpans; }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.cfg.scheduledDelayMs);
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  private async drain(originatingCallback?: ExportCallback): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.cfg.maxBatchSize);
      await this.sendBatch(batch, originatingCallback);
    }
  }

  private async sendBatch(batch: QueuedSpan[], originatingCallback?: ExportCallback): Promise<void> {
    const spans = batch.map((q) => q.span);
    const callbacks = batch.map((q) => q.callback).filter((cb): cb is ExportCallback => !!cb);
    const payload = toOtlpJson(spans, {
      serviceName: this.cfg.serviceName,
      environment: this.cfg.environment,
      release: this.cfg.release,
      redactKeys: this.cfg.redactKeys,
      sessionId: this.session.getSessionId(),
    });
    this.inflight++;
    try {
      await this.sendWithRetry(JSON.stringify(payload));
      for (const cb of callbacks) cb({ code: 0 });
      originatingCallback?.({ code: 0 });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.cfg.debug) this.log(`export failed after retries: ${error.message}`);
      for (const cb of callbacks) cb({ code: 1, error });
      originatingCallback?.({ code: 1, error });
    } finally {
      this.inflight--;
    }
  }

  private async sendWithRetry(body: string): Promise<void> {
    let lastError: Error = new Error('AllStak OTLP export failed');
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        await this.sendOnce(body);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === this.cfg.maxRetries) break;
        if (!isRetryable(lastError)) break;
        // Honor a server-provided Retry-After on 429/503 when present;
        // otherwise fall back to exponential backoff with jitter.
        const retryAfterMs = (lastError as Error & { retryAfterMs?: number }).retryAfterMs ?? 0;
        if (retryAfterMs > 0) {
          await sleep(Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
        } else {
          const delay = Math.min(
            DEFAULT_RETRY_MAX_DELAY_MS,
            DEFAULT_RETRY_BASE_DELAY_MS * 2 ** attempt,
          );
          const jitter = Math.floor(Math.random() * (delay / 4));
          await sleep(delay + jitter);
        }
      }
    }
    throw lastError;
  }

  private async sendOnce(body: string): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.cfg.exportTimeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllStak-Key': this.cfg.apiKey,
          'User-Agent': `${SDK_NAME}/${SDK_VERSION}`,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = new Error(`AllStak OTLP export failed: HTTP ${response.status}`);
        (err as Error & { status?: number }).status = response.status;
        if (response.status === 429 || response.status === 503) {
          const headerValue = response.headers?.get?.('Retry-After') ?? null;
          (err as Error & { retryAfterMs?: number }).retryAfterMs = parseRetryAfter(
            headerValue,
            Date.now(),
          );
        }
        throw err;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private registerRuntimeRelease(): void {
    if (!this.cfg.autoRegisterRelease || !this.cfg.release || isLikelyTestRuntime()) return;
    const body = JSON.stringify({
      version: this.cfg.release,
      environment: this.cfg.environment,
      commitSha: undefined,
      branch: undefined,
      author: null,
      message: null,
    });
    void this.fetchImpl(this.releaseEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AllStak-Key': this.cfg.apiKey,
        'User-Agent': `${SDK_NAME}/${SDK_VERSION}`,
      },
      body,
    }).catch((err: unknown) => {
      if (this.cfg.debug) this.log(`release registration failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private log(msg: string): void {
    // eslint-disable-next-line no-console
    if (this.cfg.debug) console.warn(`[${SDK_NAME}] ${msg}`);
  }
}

function isRetryable(err: Error): boolean {
  const status = (err as Error & { status?: number }).status;
  if (typeof status === 'number') {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // Network errors, aborts → retryable.
  return true;
}

function isLikelyTestRuntime(): boolean {
  const proc = (globalThis as any).process;
  const env = proc?.env ?? {};
  const lifecycle = String(env.npm_lifecycle_event ?? '');
  return env.NODE_ENV === 'test' || lifecycle.includes('test') || Boolean(env.VITEST);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
