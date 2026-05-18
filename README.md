# @allstak/otel

**Send OpenTelemetry traces to AllStak with a single exporter.**

[![npm version](https://img.shields.io/npm/v/@allstak/otel.svg)](https://www.npmjs.com/package/@allstak/otel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)

> **Beta** -- actively evolving. API may change between minor versions.

AllStak OpenTelemetry exporter -- converts OTel spans to OTLP JSON and sends them to the AllStak ingest API. Zero `@allstak/*` runtime dependencies.

## Installation

```sh
npm install @allstak/otel @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
```

## Quick Start

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { AllStakOtelExporter } from "@allstak/otel";

const sdk = new NodeSDK({
  traceExporter: new AllStakOtelExporter({
    apiKey: process.env.ALLSTAK_API_KEY!,
    serviceName: "my-api",
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.RELEASE,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

Traces appear in your [AllStak dashboard](https://app.allstak.sa) within seconds.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | *required* | AllStak project API key |
| `host` | `string` | `https://api.allstak.sa` | Ingest API base URL |
| `serviceName` | `string` | `""` | Logical service name for filtering |
| `environment` | `string` | `""` | Environment tag (`production`, `staging`, etc.) |
| `release` | `string` | `""` | Release/version identifier |
| `redactKeys` | `(string \| RegExp)[]` | `[]` | Extra attribute key patterns to redact in addition to the default deny-list |
| `maxBatchSize` | `number` | `256` | Max spans per HTTP request |
| `maxQueueSize` | `number` | `2048` | Max spans buffered before drop-oldest |
| `scheduledDelayMs` | `number` | `2000` | Batch flush interval (set `0` for synchronous flush) |
| `exportTimeoutMs` | `number` | `5000` | Per-request timeout |
| `maxRetries` | `number` | `3` | Retries on transient failures (HTTP 408/429/5xx, network errors) |
| `debug` | `boolean` | `false` | Enable diagnostic warnings on `console.warn` |

## Privacy & Redaction

Span and event attributes whose keys match the default deny-list are replaced with `[REDACTED]` before leaving the process:

- Header-style: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-access-token`, `x-allstak-key`
- Suffix match: `*token`, `*api_key` / `*api-key`, `*password`, `*passwd`, `*secret`, `*session_id`, `*csrf`

Add custom patterns via `redactKeys: ['custom_field', /^private_/]`. Request and response bodies are **never** captured by this SDK — only span attributes you (or your instrumentation) set.

## How It Works

The exporter implements the OpenTelemetry `SpanExporter` interface:

1. Your OTel SDK calls `export(spans)`.
2. Spans are converted to spec-compliant OTLP JSON (typed attribute values, numeric `status.code`, span kind, events, links, dropped counts).
3. Spans are buffered up to `maxBatchSize` and flushed every `scheduledDelayMs`; `forceFlush()` and `shutdown()` drain immediately.
4. Each batch POSTs to `{host}/ingest/v1/otel/v1/traces` with retry + exponential backoff on transient failures.
5. The exporter never throws — failures are reported via the OTel callback (`code: 1`).

## Fail-Open

Network failures, timeouts, and HTTP errors are caught and reported to the OTel SDK via the export callback. Retries only apply to `408`, `429`, and `5xx`. Your application is never affected by exporter failures.

## Version Compatibility

- Node.js `>= 18`
- `@opentelemetry/sdk-trace-base` `>= 1.0.0` (peer, optional)

## Limitations

- Beta release — no live dashboard certification has been recorded yet.
- npm `latest` dist-tag may lag the highest published `beta` version until the release pipeline realigns it.

## Standalone Usage

If you already have OTel spans as objects, you can convert them directly:

```ts
import { toOtlpJson } from "@allstak/otel";

const payload = toOtlpJson(spans, {
  apiKey: "...",
  serviceName: "my-api",
  environment: "production",
});
```

## License

MIT

## Production readiness

### Install

`npm install @allstak/otel`

### Quick Start

Use the minimal setup shown above in this README, set an AllStak API key through environment/configuration, and verify telemetry in a non-production project before enabling it for users. Do not hardcode API keys in source code.

### Configuration

Configure the API key, ingest host, environment, release, service name, sample rates, and optional capture settings explicitly for each deployment. Default production host is `https://api.allstak.sa` unless this SDK documents otherwise.

### Environment Variables

Prefer environment variables for secrets and deployment-specific values: `ALLSTAK_API_KEY`, `ALLSTAK_HOST`, `ALLSTAK_ENVIRONMENT`, `ALLSTAK_RELEASE`, and SDK-specific build/source-map tokens where applicable. Client-side frameworks must only expose public client keys using their framework-specific public env var conventions.

### Framework Compatibility

OpenTelemetry SDK trace-base >=1.0 is declared. OTLP JSON exporter behavior is unit-tested; dashboard span mapping is not live-certified.

### What Data Is Captured

Depending on the SDK and enabled integrations, AllStak can capture exceptions, logs, breadcrumbs, HTTP request metadata, traces/spans, release/environment tags, user context supplied by the application, cron/job heartbeat status, and source-map artifact metadata. Body/header capture is optional where supported and should stay disabled unless explicitly needed.

### Privacy / PII / Redaction

Do not send secrets, passwords, tokens, payment data, national IDs, or raw request/response bodies unless the SDK documentation for this package explicitly says the field is redacted and the behavior has been verified in your app. Authorization, cookie, token, password, secret, API key, and similar fields should be masked by default where capture is implemented. Add `beforeSend`/filter hooks or equivalent application-side scrubbing for domain-specific PII.

### Production Safety

The SDK must fail open: telemetry failures must not crash or materially block the host application. Keep queues bounded, retries bounded, debug logging off in production, and capture rates conservative until overhead is measured in your application. Live dashboard certification was **not verified** in the 2026-05-17 release-gate audit because live credentials were not available.

### Troubleshooting

If telemetry is missing, verify the package version, API key, ingest host, environment, release, network access to `https://api.allstak.sa`, sampling settings, framework integration order, and whether the SDK is disabled after an auth failure. For source maps, verify release/dist values and artifact upload responses.

### Release / Source Map Setup

Not applicable to this exporter.

### Version Compatibility

Keep the package manifest version, runtime SDK version constant, changelog entry, git tag, and registry version aligned. Do not publish from a dirty checkout.

### Known Limitations

npm beta tag has newer 0.1.0-beta.2 than latest 0.1.0-beta.1 as of the audit. Fix dist-tags only during an explicit publish/release step. Live dashboard proof, performance overhead, retry-storm behavior, and full production hardening must be revalidated before claiming production-stable readiness.

### Stability Status

Current status: **experimental beta**. This SDK is not production-stable unless a later certification report explicitly says so with live dashboard evidence.

