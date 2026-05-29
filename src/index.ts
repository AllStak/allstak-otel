import { SDK_NAME, SDK_VERSION } from './version';
import { toOtlpJson } from './otlp';
import { SessionTracker } from './session';
import type { SessionStatus } from './session';
import {
  OfflineQueue,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_AGE_MS,
} from './persistence';
import type { PersistenceAdapter, OfflineQueueConfig } from './persistence';

export { SDK_NAME, SDK_VERSION } from './version';
export { toOtlpJson, toOtlpSpan, encodeAttributes } from './otlp';
export type { OtlpEncodeConfig } from './otlp';
export { SessionTracker } from './session';
export type { SessionStatus, SessionTrackerConfig } from './session';
export { OfflineQueue, FileSpoolAdapter } from './persistence';
export type { PersistenceAdapter, PersistedEntry, OfflineQueueConfig } from './persistence';

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
  /**
   * Sentry-style PII toggle. Default **false** (Sentry parity). Controls only
   * the value-pattern scrubbers for personal data that leaks into free-text
   * attribute values:
   *   - false → email addresses and IPv4/IPv6 addresses in attribute values are
   *     replaced with `[REDACTED]`, and any auto-collected client IP is dropped.
   *   - true  → the caller has opted into PII; those value scrubbers are
   *     disabled and auto-collected client IP is allowed through.
   * Always-on scrubbing (credit-card numbers that pass Luhn, hyphenated US SSNs)
   * and key-name redaction apply regardless of this flag. Explicitly-set user
   * fields (`user.*`) are never value-scrubbed in either mode.
   */
  sendDefaultPii?: boolean;
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
  /**
   * Persist OTLP trace batches that fail to deliver (network error, retries
   * exhausted, offline, or shutdown with events still buffered) to a filesystem
   * spool and replay them on the next init, so buffered telemetry survives a
   * process restart or a network outage (Sentry offline-store parity). Payloads
   * are already PII-scrubbed before they are written. Default true; degrades to
   * a silent no-op when the spool dir is not writable (read-only FS, edge,
   * serverless). Session lifecycle calls are never persisted. */
  enableOfflineQueue?: boolean;
  /** Tune the offline spool (dir, caps, or a custom persistence adapter). */
  offlineQueue?: Partial<Pick<OfflineQueueConfig, 'dir' | 'maxEntries' | 'maxBytes' | 'maxAgeMs' | 'adapter'>>;
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
  private readonly cfg: Required<Omit<AllStakOtelExporterConfig, 'fetch' | 'redactKeys' | 'host' | 'serviceName' | 'environment' | 'release' | 'userId' | 'offlineQueue'>> &
    Pick<AllStakOtelExporterConfig, 'fetch' | 'redactKeys' | 'serviceName' | 'environment' | 'release' | 'userId' | 'offlineQueue'>;
  private readonly releaseEndpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly session: SessionTracker;
  private readonly offlineQueue: OfflineQueue;
  private offlineDrainPromise: Promise<void> = Promise.resolve();
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
      enableOfflineQueue: config.enableOfflineQueue ?? true,
      offlineQueue: config.offlineQueue,
      sendDefaultPii: config.sendDefaultPii ?? false,
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
    const oq = this.cfg.offlineQueue ?? {};
    // Under a unit-test runtime the default filesystem spool is suppressed so
    // suites don't share <tmpdir>/allstak-otel-spool across exporters (parity
    // with the session-tracking and release-registration test guards). Tests
    // that opt into persistence pass an explicit `adapter` or `dir`, which
    // re-enables it deterministically.
    const explicitStore = oq.adapter != null || oq.dir != null;
    const offlineEnabled = this.cfg.enableOfflineQueue && (explicitStore || !isLikelyTestRuntime());
    this.offlineQueue = new OfflineQueue({
      enabled: offlineEnabled,
      maxEntries: oq.maxEntries ?? DEFAULT_MAX_ENTRIES,
      maxBytes: oq.maxBytes ?? DEFAULT_MAX_BYTES,
      maxAgeMs: oq.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      dir: oq.dir,
      adapter: oq.adapter as PersistenceAdapter | undefined,
      debug: this.cfg.debug,
    });
    this.registerRuntimeRelease();
    this.session.start();
    // Replay any batches persisted by a previous run. Async + fail-open so it
    // never blocks init; runs after start() so the live session is set up first.
    this.offlineDrainPromise = this.drainOfflineQueue();
  }

  /**
   * Resolves when the replay of any batches persisted by a previous run has
   * finished. Init never blocks on this; it is exposed for graceful shutdown
   * and tests. Always resolves (the drain is fail-open).
   */
  whenOfflineDrainSettled(): Promise<void> {
    return this.offlineDrainPromise;
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
    // Let any in-progress replay of previously-persisted batches settle (it
    // becomes a no-op once shuttingDown is set) so it cannot race the drain.
    await this.offlineDrainPromise.catch(() => {});
    // Flush whatever is still buffered; failures here are persisted to the
    // offline spool by sendBatch so they survive the restart.
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
    // toOtlpJson runs the PII sanitizer (encodeAttributes → isSensitiveKey), so
    // `body` below is already scrubbed and safe to persist to disk on failure.
    const payload = toOtlpJson(spans, {
      serviceName: this.cfg.serviceName,
      environment: this.cfg.environment,
      release: this.cfg.release,
      redactKeys: this.cfg.redactKeys,
      sessionId: this.session.getSessionId(),
      sendDefaultPii: this.cfg.sendDefaultPii,
    });
    const body = JSON.stringify(payload);
    this.inflight++;
    try {
      await this.sendWithRetry(body);
      for (const cb of callbacks) cb({ code: 0 });
      originatingCallback?.({ code: 0 });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.cfg.debug) this.log(`export failed after retries: ${error.message}`);
      // Persist the already-scrubbed body unless the failure is permanent
      // (4xx other than 429) — those would never succeed on replay either.
      if (!isPermanentlyUndeliverable(error)) {
        await this.persistFailedBody(body);
      }
      for (const cb of callbacks) cb({ code: 1, error });
      originatingCallback?.({ code: 1, error });
    } finally {
      this.inflight--;
    }
  }

  /** Fail-open persist of a scrubbed batch body to the offline spool. */
  private async persistFailedBody(body: string): Promise<void> {
    try {
      const stored = await this.offlineQueue.persist(body);
      if (stored && this.cfg.debug) this.log('persisted failed batch to offline spool');
    } catch (err) {
      // Never let persistence failures escape the export path.
      if (this.cfg.debug) this.log(`offline persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Replay persisted batches on init. Each body is re-sent through the existing
   * transport (retry/backoff/Retry-After preserved). An entry is dropped only
   * when accepted (2xx → resolve) or permanently undeliverable (4xx non-429);
   * a transient failure leaves it on disk for a later run. Fully fail-open.
   */
  private async drainOfflineQueue(): Promise<void> {
    if (!this.offlineQueue.isActive()) return;
    try {
      const replayed = await this.offlineQueue.drain(async (body) => {
        if (this.shuttingDown) return 'retry';
        try {
          await this.sendWithRetry(body);
          return 'done';
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          // Permanently undeliverable → drop it; transient → keep for next init.
          return isPermanentlyUndeliverable(error) ? 'done' : 'retry';
        }
      });
      if (replayed > 0 && this.cfg.debug) this.log(`replayed ${replayed} persisted batch(es) from offline spool`);
    } catch (err) {
      if (this.cfg.debug) this.log(`offline drain failed: ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * A 4xx response other than 429 is a permanent rejection (bad key, malformed
 * payload, etc.): replaying it would never succeed, so it must NOT be persisted
 * and, if already persisted, should be evicted rather than retried forever.
 * Network errors and 5xx/408/429 are transient → safe to persist & replay.
 */
function isPermanentlyUndeliverable(err: Error): boolean {
  const status = (err as Error & { status?: number }).status;
  if (typeof status !== 'number') return false; // network / abort → transient
  return status >= 400 && status < 500 && status !== 429;
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
