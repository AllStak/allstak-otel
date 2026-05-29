# @allstak/otel

AllStak OpenTelemetry exporter for Node.js. Converts OpenTelemetry spans to OTLP JSON and sends them to AllStak.

## Install

```bash
npm install @allstak/otel @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
```

## Setup

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { AllStakOtelExporter } from '@allstak/otel';

const sdk = new NodeSDK({
  traceExporter: new AllStakOtelExporter({
    apiKey: process.env.ALLSTAK_API_KEY!,
    environment: process.env.NODE_ENV ?? 'production',
    release: process.env.ALLSTAK_RELEASE,
    serviceName: 'api',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

## Manual exporter

```ts
import { AllStakOtelExporter } from '@allstak/otel';

const exporter = new AllStakOtelExporter({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: 'production',
  serviceName: 'worker',
});

exporter.export([span], (result) => {
  if (result.code !== 0) {
    console.error(result.error);
  }
});

await exporter.forceFlush();
```

## Configuration

| Option | Description |
| --- | --- |
| `apiKey` | Project API key. |
| `serviceName` | Service name attached to resource attributes. |
| `environment` | Deployment environment. |
| `release` | App version or commit SHA. |
| `maxBatchSize` | Max spans per request. |
| `maxQueueSize` | Max buffered spans. |
| `scheduledDelayMs` | Flush interval. Set `0` for immediate export. |
| `exportTimeoutMs` | Per-request timeout. |
| `maxRetries` | Retry attempts for transient failures. |
| `redactKeys` | Extra attribute keys to redact. |
| `sendDefaultPii` | Allow personal data (email/IP) in free-text values. Default `false`. |

## Privacy

The exporter scrubs sensitive data before sending spans, in two layers:

- **Key-name redaction** — attribute keys that look sensitive (`authorization`,
  `cookie`, `*_token`, `*_password`, `*_secret`, `api_key`, `jwt`, `bearer`, …)
  have their value replaced with `[REDACTED]`. Add `redactKeys` for app-specific
  fields.
- **Value-pattern scrubbing** — PII that leaks into free-text *values* (error
  messages, breadcrumb/log data, captured HTTP fields):
  - **Always** redacted: credit-card numbers that pass the Luhn checksum, and
    hyphenated US SSNs (`ddd-dd-dddd`).
  - Redacted **unless `sendDefaultPii: true`**: email addresses and IPv4/IPv6
    addresses.

`sendDefaultPii` defaults to `false` for Sentry parity. Set it to `true` only if
you intentionally want emails/IPs in telemetry. Explicitly-set user fields
(`user.*`), stack-frame file paths, URLs, and release/version/SDK fields are
never value-scrubbed.

## Troubleshooting

- No traces: confirm your OpenTelemetry SDK is started before the app handles requests.
- Missing service name: set `serviceName` on the exporter.
- Process exits early: call `await sdk.shutdown()` or `await exporter.forceFlush()`.

## Contributing and Support

- Report bugs with the GitHub bug report template: https://github.com/AllStak/allstak-otel/issues/new/choose
- Open pull requests using the checklist in [CONTRIBUTING.md](CONTRIBUTING.md).
- Report security vulnerabilities privately through [SECURITY.md](SECURITY.md).

## License

MIT
