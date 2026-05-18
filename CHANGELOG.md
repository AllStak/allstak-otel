# Changelog

<<<<<<< HEAD
All notable changes to @allstak/otel will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0-beta.1] - 2026-04-25

### Added
- Initial public release.
=======
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
>>>>>>> 14c2556 (feat(redact): parity with @allstak/js v0.2.3 — +jwt/+bearer deny-list)
