import { SDK_NAME } from './version';

/**
 * Offline / persistent event queue for the OTLP exporter.
 *
 * GOAL: make already-scrubbed OTLP trace batches survive a process restart or a
 * network outage. When a batch cannot be delivered (network error, retries
 * exhausted, offline, or shutdown with events still buffered) the *serialized,
 * already-PII-scrubbed* payload is written to a persistent store; on the next
 * init the store is drained and each entry is re-sent through the existing
 * transport (so existing retry / backoff / Retry-After handling still applies).
 *
 * Mechanism for THIS repo (a Node OTLP exporter) is a filesystem spool
 * directory: one JSON file per batch. The store is pluggable via
 * {@link PersistenceAdapter} so other runtimes (React Native AsyncStorage,
 * browser localStorage, an in-memory fake for tests) can be swapped in without
 * touching the exporter. If no adapter is supplied a {@link FileSpoolAdapter}
 * is created lazily; if the filesystem is unavailable / unwritable (edge
 * runtimes, read-only FS, sandboxes) every method degrades to a silent no-op so
 * the exporter falls back to its existing in-memory behavior. Nothing here ever
 * throws into the host application.
 *
 * IMPORTANT: only error/log/span/http/db telemetry (i.e. OTLP trace batches)
 * flows through this store. Session lifecycle calls (/sessions/start,
 * /sessions/end) are best-effort live-only and are handled entirely by
 * SessionTracker — they never reach this layer, so a stale session is never
 * replayed.
 */

/** A single persisted entry: an id plus the serialized scrubbed payload. */
export interface PersistedEntry {
  /** Stable id used to remove the entry once it is accepted / undeliverable. */
  id: string;
  /** Already PII-scrubbed, JSON-serialized OTLP trace batch body. */
  body: string;
  /** Epoch ms the entry was written (used for max-age eviction). */
  createdAt: number;
}

/**
 * Pluggable persistence backend. Implementations MUST be fail-open: any I/O
 * error should be swallowed (the exporter degrades to in-memory), never thrown.
 * Async so a filesystem / AsyncStorage / IndexedDB backend all fit.
 */
export interface PersistenceAdapter {
  /** Persist one already-scrubbed entry. Returns false if it could not be stored. */
  append(entry: PersistedEntry): Promise<boolean>;
  /** Load all persisted entries, oldest first. Returns [] on any failure. */
  list(): Promise<PersistedEntry[]>;
  /** Remove a single entry by id. Best-effort. */
  remove(id: string): Promise<void>;
  /** Whether this adapter can actually persist (false → exporter stays in-memory). */
  isAvailable(): boolean;
}

export interface OfflineQueueConfig {
  /** Master switch. When false the queue is a no-op. */
  enabled: boolean;
  /** Max number of persisted batches retained; oldest dropped past this. */
  maxEntries: number;
  /** Max total bytes across persisted bodies; oldest dropped past this. */
  maxBytes: number;
  /** Max age in ms; entries older than this are dropped on drain / append. */
  maxAgeMs: number;
  /** Filesystem spool directory (used only by the default FileSpoolAdapter). */
  dir?: string;
  /** Inject a custom backend (React Native, browser, tests). */
  adapter?: PersistenceAdapter;
  /** Debug logging via console.warn. */
  debug: boolean;
}

/** Sane server defaults: ~64 batches, ~4 MB, 48h. */
export const DEFAULT_MAX_ENTRIES = 64;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Filename prefix/suffix for spooled batch files. */
const FILE_PREFIX = 'batch-';
const FILE_SUFFIX = '.json';

/**
 * Minimal structural view of the bits of `node:fs` we use. Declared locally so
 * the package keeps zero dependency on `@types/node` (parity with the rest of
 * the SDK, which reaches `process` via `globalThis`).
 */
interface FsLike {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  readdirSync(path: string): string[];
  readFileSync(path: string, enc: string): string;
  writeFileSync(path: string, data: string): void;
  unlinkSync(path: string): void;
  statSync(path: string): { size: number; mtimeMs: number };
  existsSync(path: string): boolean;
}

interface PathLike {
  join(...parts: string[]): string;
}

/**
 * Default Node filesystem spool: one JSON file per batch under the spool dir.
 *
 * `node:fs`/`node:path`/`node:os` are resolved lazily via a dynamic `import()`
 * on first use. esbuild keeps this as a native dynamic import in the ESM build
 * and rewrites it to `require` in the CJS build, so the package ships as both
 * without a static Node-builtin import (which would break browser/edge
 * bundlers) and without an `@types/node` dependency. If the builtins are
 * missing (edge / browser) or the directory cannot be created,
 * {@link isAvailable} flips to false and every method is a silent no-op. All
 * I/O is guarded — failures degrade to the exporter's in-memory behavior.
 */
export class FileSpoolAdapter implements PersistenceAdapter {
  /** Explicit dir; when undefined it is resolved to <tmpdir>/allstak-otel-spool. */
  private readonly explicitDir: string | undefined;
  private dir = '';
  private readonly debug: boolean;
  private fs: FsLike | null = null;
  private path: PathLike | null = null;
  private available = false;
  private probed = false;
  private readyPromise: Promise<void> | null = null;

  constructor(dir?: string, debug = false) {
    this.explicitDir = dir;
    this.debug = debug;
  }

  /**
   * Resolve the Node builtins (one-shot, cached) and create the spool dir.
   * On any platform without fs (edge / browser) the import rejects and the
   * adapter stays permanently unavailable. Never throws.
   */
  private async ensureReady(): Promise<void> {
    if (this.probed) return;
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        try {
          // @ts-ignore - node builtins; the package ships no @types/node.
          const fsMod: any = await import('node:fs');
          // @ts-ignore - node builtins; the package ships no @types/node.
          const pathMod: any = await import('node:path');
          const fs = (fsMod.default ?? fsMod) as FsLike;
          const path = (pathMod.default ?? pathMod) as PathLike;
          if (this.explicitDir) {
            this.dir = this.explicitDir;
          } else {
            // @ts-ignore - node builtins; the package ships no @types/node.
            const osMod: any = await import('node:os');
            const os = (osMod.default ?? osMod) as { tmpdir(): string };
            this.dir = path.join(os.tmpdir(), 'allstak-otel-spool');
          }
          fs.mkdirSync(this.dir, { recursive: true });
          this.fs = fs;
          this.path = path;
          this.available = true;
        } catch (err) {
          this.available = false;
          if (this.debug) warn(`spool dir not writable (${this.explicitDir ?? '<tmpdir>'}): ${msg(err)}`);
        } finally {
          this.probed = true;
        }
      })();
    }
    await this.readyPromise;
  }

  isAvailable(): boolean {
    // Optimistic until the async probe runs: the builtins resolve on first I/O
    // (ensureReady), so reporting `false` before that would wrongly disable the
    // queue. Once probed, report the real result. Edge / browser bundles fail
    // the probe and flip this to false (permanent no-op).
    if (!this.probed) return true;
    return this.available && this.fs != null && this.path != null;
  }

  async append(entry: PersistedEntry): Promise<boolean> {
    await this.ensureReady();
    if (!this.isAvailable()) return false;
    try {
      const file = this.path!.join(this.dir, `${FILE_PREFIX}${entry.id}${FILE_SUFFIX}`);
      this.fs!.writeFileSync(file, JSON.stringify({ id: entry.id, body: entry.body, createdAt: entry.createdAt }));
      return true;
    } catch (err) {
      if (this.debug) warn(`spool append failed: ${msg(err)}`);
      return false;
    }
  }

  async list(): Promise<PersistedEntry[]> {
    await this.ensureReady();
    if (!this.isAvailable()) return [];
    try {
      const names = this.fs!.readdirSync(this.dir)
        .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX));
      const entries: PersistedEntry[] = [];
      for (const name of names) {
        const file = this.path!.join(this.dir, name);
        try {
          const raw = this.fs!.readFileSync(file, 'utf8');
          const parsed = JSON.parse(raw) as PersistedEntry;
          if (parsed && typeof parsed.id === 'string' && typeof parsed.body === 'string') {
            entries.push({ id: parsed.id, body: parsed.body, createdAt: numberOr(parsed.createdAt, 0) });
          } else {
            // Corrupt / unexpected shape — drop it so it can't wedge the drain.
            this.fs!.unlinkSync(file);
          }
        } catch {
          // Unreadable / non-JSON file — best-effort cleanup, keep going.
          try { this.fs!.unlinkSync(file); } catch { /* ignore */ }
        }
      }
      entries.sort((a, b) => a.createdAt - b.createdAt);
      return entries;
    } catch (err) {
      if (this.debug) warn(`spool list failed: ${msg(err)}`);
      return [];
    }
  }

  async remove(id: string): Promise<void> {
    await this.ensureReady();
    if (!this.isAvailable()) return;
    try {
      const file = this.path!.join(this.dir, `${FILE_PREFIX}${id}${FILE_SUFFIX}`);
      if (this.fs!.existsSync(file)) this.fs!.unlinkSync(file);
    } catch (err) {
      if (this.debug) warn(`spool remove failed: ${msg(err)}`);
    }
  }
}

/**
 * Orchestrates the adapter: enforces the count/bytes/age caps with a
 * drop-OLDEST policy on append, exposes drain() for replay-on-init, and is the
 * single fail-open seam the exporter talks to. When disabled or the adapter is
 * unavailable it behaves as an inert no-op.
 */
export class OfflineQueue {
  private readonly cfg: OfflineQueueConfig;
  private readonly adapter: PersistenceAdapter | null;

  constructor(cfg: OfflineQueueConfig) {
    this.cfg = cfg;
    if (!cfg.enabled) {
      this.adapter = null;
      return;
    }
    // Use the injected adapter (RN / browser / tests) or the default Node
    // filesystem spool, which lazily resolves its dir (cfg.dir or <tmpdir>).
    const adapter: PersistenceAdapter = cfg.adapter ?? new FileSpoolAdapter(cfg.dir, cfg.debug);
    // FileSpoolAdapter reports optimistic-true until its async probe; a custom
    // adapter reporting false (no localStorage / read-only) is treated as inert.
    this.adapter = adapter.isAvailable() ? adapter : null;
  }

  /** True when an available, enabled backend is wired up. */
  isActive(): boolean {
    return this.adapter != null;
  }

  /**
   * Persist one already-scrubbed serialized batch body, then enforce caps by
   * dropping the OLDEST entries. Fail-open: returns false (and stores nothing)
   * when inactive or on any I/O error. The caller MUST pass a body that has
   * already been run through the PII sanitizer.
   */
  async persist(body: string): Promise<boolean> {
    if (!this.adapter) return false;
    const entry: PersistedEntry = { id: makeId(), body, createdAt: Date.now() };
    const ok = await this.adapter.append(entry);
    if (!ok) return false;
    await this.enforceCaps();
    return true;
  }

  /**
   * Load every persisted entry (oldest first, stale entries pruned) and hand it
   * to {@link send}. The entry is removed only after `send` reports the batch
   * was accepted (2xx) or is permanently undeliverable (4xx other than 429);
   * a `'retry'` result leaves it on disk for the next init. Fail-open.
   */
  async drain(send: (body: string) => Promise<'done' | 'retry'>): Promise<number> {
    if (!this.adapter) return 0;
    let replayed = 0;
    let entries: PersistedEntry[];
    try {
      entries = await this.adapter.list();
    } catch {
      return 0;
    }
    const cutoff = Date.now() - this.cfg.maxAgeMs;
    for (const entry of entries) {
      if (entry.createdAt < cutoff) {
        // Too stale to be useful — discard without sending.
        await this.adapter.remove(entry.id);
        continue;
      }
      let result: 'done' | 'retry';
      try {
        result = await send(entry.body);
      } catch {
        // send() is expected to be fail-open, but guard anyway: keep on disk.
        result = 'retry';
      }
      if (result === 'done') {
        await this.adapter.remove(entry.id);
        replayed++;
      }
      // 'retry' → leave the entry on disk for a future drain.
    }
    return replayed;
  }

  /** Enforce max-age, then max-entries, then max-bytes by dropping oldest. */
  private async enforceCaps(): Promise<void> {
    if (!this.adapter) return;
    let entries: PersistedEntry[];
    try {
      entries = await this.adapter.list();
    } catch {
      return;
    }
    const cutoff = Date.now() - this.cfg.maxAgeMs;
    // Oldest first (list() already sorts ascending by createdAt).
    let live: PersistedEntry[] = [];
    for (const e of entries) {
      if (e.createdAt < cutoff) {
        await this.adapter.remove(e.id);
      } else {
        live.push(e);
      }
    }
    // Drop oldest until within the count cap.
    while (live.length > this.cfg.maxEntries) {
      const victim = live.shift()!;
      await this.adapter.remove(victim.id);
    }
    // Drop oldest until within the byte cap.
    let total = live.reduce((sum, e) => sum + byteLen(e.body), 0);
    while (live.length > 0 && total > this.cfg.maxBytes) {
      const victim = live.shift()!;
      total -= byteLen(victim.body);
      await this.adapter.remove(victim.id);
    }
  }
}

function makeId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function byteLen(s: string): number {
  // Approximate UTF-8 byte length without pulling in Buffer / TextEncoder
  // hard-deps; TextEncoder exists in Node 18+ and browsers.
  const enc = (globalThis as { TextEncoder?: new () => { encode(s: string): { length: number } } }).TextEncoder;
  if (enc) return new enc().encode(s).length;
  return s.length;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(m: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[${SDK_NAME}] ${m}`);
}
