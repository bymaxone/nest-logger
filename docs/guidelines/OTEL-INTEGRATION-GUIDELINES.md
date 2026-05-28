# OpenTelemetry Integration Guidelines — `@bymax-one/nest-logger`

> **Version:** 1.0.0
> **Last updated:** 2026-05-27
> **Target:** OpenTelemetry SDK Node `>=0.218.0 <1.10.0` (pre-1.0; pins `@opentelemetry/api` to `^1.9.0 <1.10.0`). Track release cadence — current is experimental v0.218.0. `@opentelemetry/api` 1.9+, Pino 10.x
> **Related document:** `docs/technical_specification.md` §11

---

## Table of Contents

1. [Philosophy: lib logs, consumer instruments](#1-philosophy)
2. [Optional detection of the OTel API](#2-optional-detection)
3. [Mixin vs `formatters.log` — where to inject trace context](#3-mixin-vs-formatters)
4. [Canonical setup in the consumer (`main.ts`)](#4-canonical-setup)
5. [Cross-service correlation via W3C `traceparent`](#5-cross-service-correlation)
6. [Field naming — OTel Logs Data Model vs Pino-native](#6-field-naming)
7. [Coexistence with `@opentelemetry/instrumentation-pino`](#7-coexistence)
8. [Integration with Sentry](#8-sentry)
9. [Test checklist](#9-test-checklist)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Philosophy

The lib **does not initialize** the OTel SDK. It only detects whether OTel is active and enriches logs with `traceId`/`spanId` when there is an active span. This means:

- ✅ Without OTel installed: the lib logs normally, with no trace fields
- ✅ With OTel installed but no active span: same (happens in CLIs, workers, jobs scheduled outside request scope)
- ✅ With OTel + active span: trace context is injected into every log

**Responsibilities:**

- **Consumer**: installs and initializes `@opentelemetry/sdk-node` in `main.ts` before `NestFactory.create()`
- **Lib**: detects `trace.getActiveSpan()` at runtime and enriches logs

---

## 2. Optional detection

`@opentelemetry/api` is an **optional** peer dependency. The lib uses `createRequire` to attempt resolution at runtime without breaking the build if it is not installed:

```typescript
// src/server/utils/otel-detector.ts
import { createRequire } from 'node:module'

export function detectOtelTraceApi(): OtelTraceApi | undefined {
  try {
    const requireFromHere = createRequire(import.meta.url)
    const mod = requireFromHere('@opentelemetry/api') as { trace?: OtelTraceApi }
    return mod.trace
  } catch {
    return undefined
  }
}
```

Works in **ESM** (via `import.meta.url`) and **CJS** (tsup injects a shim).

> ⚠️ **Bundlers (esbuild, webpack)** may omit the `require` if there is no static reference. Solution: declare the peer dep in `package.json` (`@opentelemetry/api: ^1.9.0` in `peerDependenciesMeta` as `optional`) — bundlers recognize this and preserve the lookup.
>
> If you bundle (esbuild, rollup, webpack), add `@opentelemetry/api` to `external` explicitly — the runtime peer-dep optional check only works for non-bundled imports.

---

## 3. Mixin vs `formatters.log`

The **only** correct way to inject `traceId`/`spanId` in Pino is via a **mixin**:

```typescript
// ✅ CORRECT — mixin is called on every log, no input needed from the caller
{
  mixin(_mergeObject, _level, _logger) {
    const span = trace.getActiveSpan()
    if (!span) return undefined
    const ctx = span.spanContext()
    return { traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: ctx.traceFlags.toString(16) }
  }
}
```

```typescript
// ❌ WRONG — formatters.log only sees what the caller passed to pino.info(obj, msg)
// It has no access to ambient context (active span, AsyncLocalStorage)
{
  formatters: {
    log(o) {
      const span = trace.getActiveSpan()  // 🐛 may be undefined
      return { ...o, traceId: span?.spanContext().traceId }
    }
  }
}
```

The lib combines **a single mixin function** that merges:

1. `LogContextService.getStore()` → `requestId`, `tenantId`, `userId`
2. OTel `trace.getActiveSpan().spanContext()` → `traceId`, `spanId`, `traceFlags`

### Pino 10 signature (important!)

Pino 10 mixin signature is `(mergeObject: object, level: number) => object`. The legacy 3rd arg (`logger`) from Pino 9.x is optional and ignored — do not rely on it. Composed mixin example:

```ts
const composedMixin = (_mergeObject, _level) => {
  const ctx = LogContextService.getStore() ?? {}
  const span = trace.getActiveSpan()
  if (!span) return ctx
  const sc = span.spanContext()
  if (sc.traceId === '00000000000000000000000000000000') return ctx
  // OTel trace overrides any same-named ALS keys
  return { ...ctx, traceId: sc.traceId, spanId: sc.spanId, traceFlags: sc.traceFlags }
}
```

---

## 4. Canonical setup in the consumer

```typescript
// apps/backend/src/main.ts
// TOP OF FILE — before any NestJS import
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'my-app',
    [ATTR_SERVICE_VERSION]: process.env.RELEASE_SHA ?? 'dev',
    'deployment.environment': process.env.NODE_ENV ?? 'development'
  }),
  traceExporter: new OTLPTraceExporter({ url: process.env.OTLP_TRACE_ENDPOINT }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false } // noisy
    })
  ]
})
sdk.start()

process.on('SIGTERM', () => void sdk.shutdown().finally(() => process.exit(0)))

// ONLY NOW import Nest
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  await app.listen(3000)
}
bootstrap()
```

### On Node 20+, the `--import` flag is recommended

```bash
node --import ./instrumentation.mjs ./dist/main.js
```

Where `instrumentation.mjs` is a module that just calls `sdk.start()`. Advantage: clean separation and works with hot-reload via `tsx`.

> Requires Node 20.6+ (`--import` flag landed there). For older Node, use `node --experimental-loader ./loader.mjs` (deprecated) or `register()` from `node:module`. Also enable `--enable-source-maps` for usable stack traces.

---

## 5. Cross-service correlation

For Service A → Service B to preserve the `traceId`, the W3C `traceparent` header is injected/extracted by HTTP auto-instrumentations. For custom HTTP clients (Stripe SDK, AWS SDK, etc.):

```typescript
import { propagation, context } from '@opentelemetry/api'

async function callStripe(payload: object) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  propagation.inject(context.active(), headers)
  // headers now contains traceparent + tracestate injected
  return fetch('https://api.stripe.com/...', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })
}
```

Reverse (Service B receiving):

```typescript
import { propagation, context, trace } from '@opentelemetry/api'

const parentCtx = propagation.extract(context.active(), incomingHeaders)
const span = trace.getTracer('my-handler').startSpan('handleRequest', undefined, parentCtx)
// the span is now linked to the upstream trace
```

---

## 6. Field naming

The lib accepts 2 formats via `options.otel`:

### `camelCase` (default — Pino-native)

```json
{ "traceId": "4bf...", "spanId": "00f...", "traceFlags": "01" }
```

### `snake_case` (OTel Logs Data Model)

```typescript
BymaxLoggerModule.forRoot({
  // ...
  otel: { fieldFormat: 'snake_case' }
})
```

```json
{ "trace_id": "4bf...", "span_id": "00f...", "trace_flags": "01" }
```

### Per field (selective override)

```typescript
BymaxLoggerModule.forRoot({
  // ...
  otel: {
    traceIdField: 'trace_id',
    spanIdField: 'span_id',
    traceFlagsField: 'traceFlags' // this one stays in camelCase
  }
})
```

> **When to use snake_case?** If you process logs with `@opentelemetry/instrumentation-pino` ACTIVE in parallel (it emits snake_case) OR if your log platform (Honeycomb, OTLP-native backends) expects fields in OTel Logs Data Model format.

---

## 7. Coexistence with `@opentelemetry/instrumentation-pino`

The `@bymax-one/nest-logger` lib injects trace context via its own mixin. It is **not necessary** to install `@opentelemetry/instrumentation-pino` in parallel.

Valid coexistence scenario: you have `@bymax-one/nest-logger` in the main NestJS app **and** a standalone CLI script that uses Pino directly. For the CLI script, install `@opentelemetry/instrumentation-pino` and configure `logKeys: { traceId: 'traceId', spanId: 'spanId' }` to keep the **same field format**.

> ⚠️ If you enable BOTH on the same Pino logger, `traceId`/`spanId` fields will be duplicated in some logs (once via this lib's mixin, once via the instrumentation). Disable one of them: `BymaxLoggerModule.forRoot({ otel: { autoInjectTraceContext: false } })` to leave only `PinoInstrumentation`.

---

## 8. Sentry

Sentry **does not replace** OTel — they are complementary. The lib does not depend on Sentry.

**Recommended pattern:**

```typescript
// main.ts
import * as Sentry from '@sentry/node'
import { SentryPropagator } from '@sentry/opentelemetry' // Sentry 8.x — previous `@sentry/opentelemetry-node` package is deprecated

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
  registerEsmLoaderHooks: false
})

const sdk = new NodeSDK({
  // ... as before ...
  textMapPropagator: new SentryPropagator()
})
```

Logs with `level: 'error'` automatically become Sentry issues **if** the consumer installs `@sentry/pino` (it does not ship with the lib).

> Use Sentry 8.x; previous `@sentry/opentelemetry-node` package is deprecated.

---

## 9. Test checklist

- [ ] Without `@opentelemetry/api` installed, `detectOtelTraceApi()` returns `undefined` (mock require)
- [ ] With OTel but no `sdk.start()`, logs come out without `traceId`/`spanId`
- [ ] With `sdk.start()` + active span, the log carries a `traceId` (valid 32 hex chars)
- [ ] No-op span (zeroed traceId) is **not** injected
- [ ] `otel.fieldFormat: 'snake_case'` produces `trace_id` instead of `traceId`
- [ ] **Per-field override wins over `fieldFormat`**: when `fieldFormat: 'snake_case'` AND `traceIdField: 'traceId'`, the log uses `traceId` (camelCase) for that one field; others (`span_id`, `trace_flags`) stay snake_case.
- [ ] `otel.autoInjectTraceContext: false` disables the mixin
- [ ] The mixin has signature `(mergeObject, level) => ...` (Pino 10 contract; legacy 3rd `logger` arg is optional)
- [ ] `traceFlags` is serialized as 2-hex lowercase (W3C compliance)

---

## 10. Troubleshooting

### "No traceId in logs even though OTel is installed"

Checklist:

1. Was `sdk.start()` called **before** `NestFactory.create()`?
2. Is the operation inside a span? `trace.getActiveSpan()` returns `undefined` in code outside auto-instrumentation
3. Is `options.otel.autoInjectTraceContext` set to `true` (default)?
4. Is the traceId not the "no-op" (32 zeros)?

### "Duplicate traceId in logs"

You have `@opentelemetry/instrumentation-pino` ACTIVE in parallel with this lib's mixin. Disable one of them.

### "AsyncLocalStorage does not propagate in workers"

`AsyncLocalStorage` propagates via native async hooks. **Worker threads** (`worker_threads` module) do NOT share ALS — you must pass the context explicitly via `MessagePort`.

### "Logs missing traceId on unsampled spans"

**Trap: `traceFlags === 0` does NOT mean "no span".** It means the span is unsampled by the head sampler. The span still has a valid `traceId` / `spanId` and the log MUST still be enriched — do NOT skip. The only skip condition is `traceId === '0'.repeat(32)` (no span at all). A mixin that gates on `traceFlags` will silently drop trace context on every unsampled request.

---

## References

- [OpenTelemetry JS Getting Started — Node](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/)
- [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [`@opentelemetry/instrumentation-pino`](https://www.npmjs.com/package/@opentelemetry/instrumentation-pino)
- [Sentry OTel integration](https://docs.sentry.io/platforms/node/performance/instrumentation/opentelemetry/)
