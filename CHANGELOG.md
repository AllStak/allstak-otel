# Changelog

All notable changes to @allstak/otel will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## 0.1.0-beta.5 - 2026-05-29

This release lifts `@allstak/otel` from a bare OTLP `SpanExporter` toward
`@sentry/opentelemetry`-class coverage: release-health sessions, an offline
store, value-pattern PII scrubbing, and a distributed-trace propagator/sampler.
All additions keep `@opentelemetry/*` a peer dependency — no new runtime deps.

### Added
- **Release-health session tracking** (`SessionTracker`,
  `enableAutoSessionTracking`, default on). One session per process, Sentry-style:
  POSTs `/ingest/v1/sessions/start` on init and `/ingest/v1/sessions/end` on
  shutdown so the dashboard can compute crash-free rate. Status vocabulary
  (`ok` / `errored` / `crashed` / `abnormal`) matches the backend
  `/ingest/v1/sessions/end` contract; handled errors escalate `ok → errored`
  and an unhandled/fatal error records terminal `crashed` (in-memory, no extra
  I/O). Config: `userId`, `platform` (default `node`). Exported types
  `SessionStatus`, `SessionTrackerConfig`.
- **Offline / persistent transport queue** (`OfflineQueue`, `FileSpoolAdapter`,
  `enableOfflineQueue`, default on). OTLP batches that fail to deliver (network
  error, retries exhausted, offline, or shutdown with events still buffered) are
  spooled to a filesystem store (`<tmpdir>/allstak-otel-spool` by default) and
  replayed on the next init, so buffered telemetry survives a process restart or
  outage (Sentry offline-store parity). Drop-oldest eviction with `maxEntries` /
  `maxBytes` / `maxAgeMs` caps; pluggable `adapter`. Payloads are PII-scrubbed
  before they are written; session lifecycle calls are never persisted. Degrades
  to a silent no-op when the spool dir is not writable (read-only FS, edge,
  serverless). Exported types `PersistenceAdapter`, `PersistedEntry`,
  `OfflineQueueConfig`; tunable via the `offlineQueue` config field.
- **Value-pattern PII scrubbing + `sendDefaultPii`**. In addition to the
  existing key-name deny-list, attribute *values* are now scrubbed for personal
  data that leaks into free text:
  - Always scrubbed (regardless of the flag): credit-card numbers that pass the
    Luhn checksum (Luhn-failing digit runs are left intact to avoid mangling
    order IDs), and hyphenated US SSNs (`ddd-dd-dddd`; bare 9-digit numbers are
    intentionally not matched).
  - Scrubbed unless `sendDefaultPii: true` (default `false`, Sentry parity):
    email addresses and IPv4/IPv6 addresses; auto-collected client IP is dropped.
  - Explicitly-set `user.*` fields are never value-scrubbed in either mode.
  New `scrubValueString` helper and `sendDefaultPii` config flag.
- **Distributed-tracing propagator + sampler** (parity with
  `@sentry/opentelemetry`):
  - `AllStakPropagator` — an OpenTelemetry `TextMapPropagator` for W3C
    `traceparent` + `baggage` inject/extract, so trace continuity survives
    process/service boundaries without relying solely on the host's upstream
    OTel setup. Structurally typed (no hard `@opentelemetry/api` import) and
    fully fail-open.
  - `allstakSampler` / `AllStakTraceRatioSampler` — a parent-respecting ratio
    sampler honoring `allstakTracesSampleRate` (root-trace ratio decision;
    children inherit the parent's sampled flag). Includes `alwaysOnSampler` /
    `alwaysOffSampler` helpers.
  - `AllStakSpanProcessor` — a thin convenience `SpanProcessor` that forwards
    ended spans to the `AllStakOtelExporter` (and `forceFlush` / `shutdown`).
  Exported so users can register propagation + sampling alongside the exporter.

### Notes
- Tests grew to 152 passing across 6 files: session lifecycle/status,
  offline-spool persist/replay/eviction, value-pattern scrubbing (Luhn/SSN/
  email/IP + `sendDefaultPii`), propagator inject/extract roundtrip, and sampler
  decisions. `npm run build` (tsup CJS+ESM+dts) and `npm test` (vitest) green.
- Not yet on npm. As of 2026-05-29, the registry has `0.1.0-beta.1`,
  `0.1.0-beta.2`, `0.1.0-beta.4`; `beta.3` and this `beta.5` are unpublished.
  The `latest` dist-tag points at the prerelease `0.1.0-beta.4` and `beta` at
  `0.1.0-beta.2` — dist-tag realignment is owned by the release pipeline, not
  this commit.

## 0.1.0-beta.4 - 2026-05-18

### Added
- Deny-list parity with `@allstak/js@0.2.3`: `*jwt` and `*bearer` key-suffix patterns are now redacted alongside the existing `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-access-token`, `x-allstak-key`, `*token`, `*api_key`, `*password`, `*passwd`, `*secret`, `*session_id`, `*csrf`. Source-of-truth comment in `src/redaction.ts` calls out the lock-step requirement with sibling SDKs.
- New unit test asserts `user_jwt`, `auth_bearer`, `x-bearer` are redacted to `[REDACTED]` in span attributes while unrelated keys (`plain`) survive.

### Notes
- Test suite: 37 → 38 tests, all green.
- Not yet on npm (`latest=0.1.0-beta.1`, `beta=0.1.0-beta.2` per `npm view`). Realignment + publish gated on maintainer 2FA — see `docs/reports/npm-release-governance-2026-05-18.md`.

## 0.1.0-beta.3 - 2026-05-17

OTLP wire-format correctness pass and runtime hardening. Still **beta** — pending live dashboard certification.

### Wire format (breaking-fix vs beta.2)
- `status.code` is now numeric per OTLP spec: `0` UNSET, `1` OK, `2` ERROR. Previously emitted strings `STATUS_CODE_OK` / `STATUS_CODE_ERROR`.
- Span attributes are now type-encoded: `stringValue`, `boolValue`, `intValue`, `doubleValue`, `arrayValue`, `kvlistValue`. Previously all values were coerced to `stringValue`.
- Added span `kind` (numeric per OTLP), `events`, `links`, `droppedAttributesCount`, `droppedEventsCount`, `droppedLinksCount`.
- Resource now carries `telemetry.sdk.name`, `telemetry.sdk.version`, `telemetry.sdk.language=nodejs`.
- `parentSpanId` now falls back to `parentSpanContext.spanId` for newer `@opentelemetry/sdk-trace-base` releases.

### Runtime
- New: bounded batching transport. Spans are batched up to `maxBatchSize` (default 256) on a `scheduledDelayMs` interval (default 2000 ms). Queue is bounded by `maxQueueSize` (default 2048) with drop-oldest. `forceFlush()` and `shutdown()` drain.
- New: retry with exponential backoff + jitter for retryable failures (HTTP 408, 429, 5xx, network errors). Up to `maxRetries` (default 3).
- New: per-attribute redaction. Default deny-list matches `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-allstak-key`, and key suffixes `token`, `api_key`, `password`, `secret`, `session_id`, `csrf`. Extra patterns via `redactKeys`.
- New: exported runtime constants `SDK_NAME`, `SDK_VERSION`. Exporter instances expose `sdkName` and `sdkVersion`.
- New: `User-Agent: @allstak/otel/<version>` header on every request.
- Debug logging is **off by default** and gated behind `debug: true` config flag.

### Notes
- Local version `0.1.0-beta.3` corresponds to runtime `SDK_VERSION` constant and this CHANGELOG entry. Pre-release; not pushed to npm.
- AllStak ingest (`/ingest/v1/otel/v1/traces`) parses both string and numeric `status.code` forms; this release moves to numeric to comply with the OTLP JSON specification.
- npm `latest` dist-tag is still pointing at `0.1.0-beta.1` from the prior audit. Realignment is owned by the release pipeline, not this commit.

## 0.1.0-beta.2 - 2026-05-11

- Experimental beta package for OpenTelemetry OTLP JSON export to AllStak.
- npm `beta` points at this version; npm `latest` still pointed at `0.1.0-beta.1` during the 2026-05-17 audit.

## [0.1.0-beta.1] - 2026-04-25

### Added
- Initial public release.
