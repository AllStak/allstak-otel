import { SDK_NAME, SDK_VERSION } from './version';

/**
 * Lifecycle status of a release-health session.
 *
 * Vocabulary matches the AllStak backend's `/ingest/v1/sessions/end` contract
 * and Sentry's release-health conventions (mirrors the Java SDK's
 * `SessionStatus` enum):
 *
 *  - `ok`       — session ended normally with at most non-fatal logs.
 *  - `errored`  — at least one HANDLED error was captured during the session,
 *                 but the process kept running.
 *  - `crashed`  — an UNHANDLED / fatal error ended the process (only reported
 *                 when the SDK observes the crash itself).
 *  - `abnormal` — process ended without a normal flush. Reserved for future
 *                 shutdown-hook telemetry.
 */
export type SessionStatus = 'ok' | 'errored' | 'crashed' | 'abnormal';

const PATH_START = '/ingest/v1/sessions/start';
const PATH_END = '/ingest/v1/sessions/end';

/** Short, independent timeout for the best-effort session lifecycle calls. */
const SESSION_TIMEOUT_MS = 3_000;

/**
 * Minimal structural view of the Node `process` event emitter. Declared
 * locally so the package keeps zero runtime/type dependencies on `@types/node`
 * (parity with the rest of the SDK, which reaches `process` via `globalThis`).
 */
interface ProcessLike {
  once?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

/** Generate an RFC 4122 v4 UUID, falling back when `crypto.randomUUID` is absent. */
function generateSessionId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  // Fallback v4-shaped id for runtimes without WebCrypto randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface SessionTrackerConfig {
  host: string;
  apiKey: string;
  release?: string;
  environment?: string;
  userId?: string;
  platform?: string;
  /** When true (default), the tracker starts on construction and ends on shutdown. */
  enabled: boolean;
  /** Enable debug logging via console.warn. */
  debug: boolean;
  fetch: typeof fetch;
}

/**
 * Sentry-style "one session per process / app-launch" tracker.
 *
 * On {@link start} the SDK POSTs `/ingest/v1/sessions/start` with the session
 * id, the resolved release (falling back to the SDK version), and an SDK
 * identifier. Errored / crashed transitions are recorded in-memory only; the
 * terminal {@link end} POSTs `/ingest/v1/sessions/end` with the accumulated
 * status + total duration so per-error latency stays unaffected.
 *
 * Re-entrancy safe: a second {@link start} is a no-op and {@link end} fires at
 * most once. Every network call is fail-open — failures are swallowed so they
 * never throw or block the host application.
 */
export class SessionTracker {
  private readonly cfg: SessionTrackerConfig;
  private readonly resolvedRelease: string;
  private readonly sessionId: string;
  private status: SessionStatus = 'ok';
  private errorCount = 0;
  private startedAtMs = 0;
  private started = false;
  private ended = false;
  private exitHandlersBound = false;
  private readonly onProcessExit = () => this.end();

  constructor(config: SessionTrackerConfig, sessionId?: string) {
    this.cfg = config;
    // Release is required by the backend; fall back to the SDK version so the
    // session is always attributable. Sessions are NEVER sampled.
    this.resolvedRelease = (config.release && config.release.length > 0) ? config.release : SDK_VERSION;
    this.sessionId = sessionId && sessionId.length > 0 ? sessionId : generateSessionId();
  }

  /** Stable id attached to every outgoing payload so the backend can correlate. */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Current in-memory status. */
  getStatus(): SessionStatus {
    return this.status;
  }

  /** Number of errors recorded against the active session. */
  getErrorCount(): number {
    return this.errorCount;
  }

  /**
   * Idempotent. Records the session start timestamp, sets status `ok`, binds
   * graceful-shutdown handlers, and fires the `/sessions/start` POST. The POST
   * is fire-and-forget so SDK init never blocks on a network round-trip.
   */
  start(): void {
    if (!this.cfg.enabled || this.started) return;
    this.started = true;
    this.status = 'ok';
    this.startedAtMs = Date.now();
    this.bindExitHandlers();

    const body = {
      sessionId: this.sessionId,
      release: this.resolvedRelease,
      environment: this.cfg.environment,
      userId: this.cfg.userId,
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      platform: this.cfg.platform ?? 'node',
    };
    void this.post(PATH_START, body, `session started: ${this.sessionId}`);
  }

  /** Record a HANDLED error. No I/O — escalates `ok` → `errored`. */
  recordError(): void {
    if (!this.started || this.ended) return;
    this.errorCount += 1;
    if (this.status === 'ok') this.status = 'errored';
  }

  /** Record an UNHANDLED / fatal crash. No I/O — terminal `crashed` status. */
  recordCrash(): void {
    if (!this.started || this.ended) return;
    this.errorCount += 1;
    this.status = 'crashed';
  }

  /**
   * Terminate the session and POST `/sessions/end`. Idempotent. Uses the
   * accumulated status unless `finalStatus` is supplied. Best-effort with a
   * short timeout — never blocks or throws.
   */
  end(finalStatus?: SessionStatus): void {
    if (!this.started || this.ended) return;
    this.ended = true;
    this.unbindExitHandlers();

    const status = finalStatus ?? this.status;
    const durationMs = Math.max(0, Date.now() - this.startedAtMs);
    const body = {
      sessionId: this.sessionId,
      durationMs,
      status,
    };
    void this.post(PATH_END, body, `session ended: ${this.sessionId} status=${status} errors=${this.errorCount}`);
  }

  private async post(path: string, body: unknown, debugMsg: string): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);
    const t = timeoutId as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
    try {
      await this.cfg.fetch(`${this.cfg.host}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllStak-Key': this.cfg.apiKey,
          'User-Agent': `${SDK_NAME}/${SDK_VERSION}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (this.cfg.debug) this.log(debugMsg);
    } catch (err: unknown) {
      // Fail-open: a network failure must not crash app boot or shutdown.
      if (this.cfg.debug) this.log(`${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private bindExitHandlers(): void {
    if (this.exitHandlersBound) return;
    const proc = (globalThis as { process?: ProcessLike }).process;
    if (!proc || typeof proc.once !== 'function') return;
    this.exitHandlersBound = true;
    // 'exit' cannot run async work but `post` is fire-and-forget; 'beforeExit'
    // gives the best-effort flush a chance to complete before the loop drains.
    proc.once('beforeExit', this.onProcessExit);
    proc.once('SIGTERM', this.onProcessExit);
    proc.once('SIGINT', this.onProcessExit);
  }

  private unbindExitHandlers(): void {
    if (!this.exitHandlersBound) return;
    const proc = (globalThis as { process?: ProcessLike }).process;
    if (proc && typeof proc.removeListener === 'function') {
      proc.removeListener('beforeExit', this.onProcessExit);
      proc.removeListener('SIGTERM', this.onProcessExit);
      proc.removeListener('SIGINT', this.onProcessExit);
    }
    this.exitHandlersBound = false;
  }

  private log(msg: string): void {
    // eslint-disable-next-line no-console
    if (this.cfg.debug) console.warn(`[${SDK_NAME}] ${msg}`);
  }
}
