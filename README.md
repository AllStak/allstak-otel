# @allstak/otel

**AllStak OpenTelemetry exporter for OTLP JSON traces.**

[![npm version](https://img.shields.io/npm/v/@allstak/otel.svg)](https://www.npmjs.com/package/@allstak/otel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)

AllStak OpenTelemetry exporter (preview) — sends OTLP JSON traces to the AllStak ingest API. Independently installable with no dependency on other `@allstak/*` packages at runtime.

## Installation

```sh
npm install @allstak/otel
```

## Quick Start

```ts
import { AllStakOtelExporter } from "@allstak/otel";

const exporter = new AllStakOtelExporter({
  dsn: process.env.ALLSTAK_DSN,
  endpoint: "https://api.allstak.sa",
  serviceName: "checkout-api",
  release: process.env.RELEASE,
  environment: process.env.NODE_ENV,
});
```

Register the exporter with your OpenTelemetry SDK `TracerProvider` as a span exporter.

## License

MIT © AllStak
