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
| `host` | Optional ingest host override for self-hosted AllStak. |
| `serviceName` | Service name attached to resource attributes. |
| `environment` | Deployment environment. |
| `release` | App version or commit SHA. |
| `maxBatchSize` | Max spans per request. |
| `maxQueueSize` | Max buffered spans. |
| `scheduledDelayMs` | Flush interval. Set `0` for immediate export. |
| `exportTimeoutMs` | Per-request timeout. |
| `maxRetries` | Retry attempts for transient failures. |
| `redactKeys` | Extra attribute keys to redact. |

## Privacy

The exporter redacts common sensitive attribute keys before sending spans. Add `redactKeys` for app-specific fields.

## Troubleshooting

- No traces: confirm your OpenTelemetry SDK is started before the app handles requests.
- Missing service name: set `serviceName` on the exporter.
- Process exits early: call `await sdk.shutdown()` or `await exporter.forceFlush()`.

## License

MIT
