<p align="center">
  <img src="https://img.shields.io/badge/%40bymax--one-nest--logger-000000?style=for-the-badge&logo=nestjs&logoColor=E0234E" alt="@bymax-one/nest-logger" />
</p>

<h1 align="center">@bymax-one/nest-logger</h1>

<p align="center">
  <strong>Structured JSON logging for NestJS</strong><br />
  <sub>Pino 10 · OpenTelemetry · PII Redaction · Multi-Destination · Multi-Tenant · Zero Runtime Dependencies</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bymax-one/nest-logger"><img src="https://img.shields.io/npm/v/@bymax-one/nest-logger?style=flat-square&colorA=000000&colorB=000000" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@bymax-one/nest-logger"><img src="https://img.shields.io/npm/dm/@bymax-one/nest-logger?style=flat-square&colorA=000000&colorB=000000" alt="npm downloads" /></a>
  <a href="https://github.com/bymaxone/nest-logger/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/bymaxone/nest-logger/ci.yml?branch=main&style=flat-square&colorA=000000&label=CI" alt="CI status" /></a>
  <a href="https://github.com/bymaxone/nest-logger/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&colorA=000000" alt="coverage" /></a>
  <a href="https://github.com/bymaxone/nest-logger/blob/main/docs/mutation_testing_results.md"><img src="https://img.shields.io/badge/mutation-97.42%25-brightgreen?style=flat-square&colorA=000000" alt="mutation score" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/bymaxone/nest-logger"><img src="https://api.scorecard.dev/projects/github.com/bymaxone/nest-logger/badge?style=flat-square" alt="OpenSSF Scorecard" /></a>
  <a href="https://github.com/bymaxone/nest-logger/blob/main/LICENSE"><img src="https://img.shields.io/github/license/bymaxone/nest-logger?style=flat-square&colorA=000000&colorB=000000" alt="license" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
</p>

<p align="center">
  <a href="https://github.com/bymaxone/nest-logger">GitHub</a> ·
  <a href="https://github.com/bymaxone/nest-logger/issues">Issues</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-api-reference">API Reference</a> ·
  <a href="https://github.com/bymaxone/nest-logger-example">Example App</a>
</p>

---

## ✨ Overview

`@bymax-one/nest-logger` replaces ad-hoc `console.log` and legacy Winston setups with a production-grade structured logging pipeline. Every log entry is a JSON object carrying a `logKey` (`MODULE_ACTION_RESULT` convention), `requestId`, `tenantId`, and — when OpenTelemetry is active — the correlated `traceId`/`spanId`.

**Why Pino?** At ~750,000 logs/sec (vs Winston's ~110,000), Pino consumes 3× less CPU and half the RSS under load. The difference is measurable in production billing/payments backends where the logger is on the hot path for every request.

The library has **zero direct dependencies** — all packages arrive as peer dependencies, so you control exact versions and the supply chain surface stays minimal.

### Why nest-logger?

- **🎯 One module, the whole pipeline** — Logger service, HTTP interceptor, exception filter, context propagation, redaction, and destinations arrive in a single `forRoot()`. No gluing together `pino-http`, a redaction layer, and a transport by hand.
- **🔌 Your sinks, your rules** — The library defines `ILogDestination`. You implement it for Loki, Postgres, a rolling file, or anything else. No vendor lock-in, no hidden transport dependencies.
- **🔒 Private by default** — 113 redact paths compile at bootstrap covering passwords, tokens, PCI DSS card data, MFA secrets, and LGPD documents. Leaking a secret requires opting out, not opting in.
- **⚡ On the hot path, so it stays cheap** — Singleton providers, one composed Pino mixin, and a pre-compiled redactor. No `Scope.REQUEST`, no per-log regex matching.
- **🔭 Correlated when you need it** — When an OpenTelemetry span is active, `traceId`/`spanId`/`traceFlags` land in every entry. When the peer is absent, the mixin steps aside at zero cost.

```
pnpm add @bymax-one/nest-logger
```

---

## 🔥 Features

### 📝 Core Logging

- ✅ **Structured JSON** — every entry has `level`, `time`, `service`, `logKey`, `msg`, and arbitrary metadata fields
- ✅ **`MODULE_ACTION_RESULT` Log Keys** — a naming convention enforced by an exported regex for CI validation
- ✅ **NestJS `LoggerService` Bridge** — drop-in replacement; all NestJS internal logs flow through Pino
- ✅ **Pretty-Print in Dev** — opt-in `PrettyDevDestination` for readable local output (requires optional `pino-pretty`)
- ✅ **Entry Size Guard** — truncates oversized entries (default 64 KB) with a structured warning instead of silently dropping them

### 🛡️ Security & Privacy

- ✅ **PII Redaction by Default** — 113 paths covering passwords, tokens, and generic secrets — powered by `fast-redact`
- ✅ **PCI DSS & MFA Coverage** — card data and MFA secrets redacted out of the box, with common HTTP auth headers
- ✅ **LGPD-Aware Paths** — CPF, CNPJ, and RG redacted by default for Brazilian workloads
- ✅ **Append-Only Redact List** — `DEFAULT_REDACT_PATHS` never shrinks without a major version; extend it via `redactPaths`
- ✅ **Validated Trace IDs** — OTel identifiers pass `isValidTraceId` before injection, never raw user input

### 🔍 Observability & Context

- ✅ **OpenTelemetry Correlation** — optional `@opentelemetry/api` peer; injects `traceId`/`spanId`/`traceFlags` into every log via a Pino mixin when an active span is detected
- ✅ **AsyncLocalStorage Context** — `requestId`, `tenantId`, `userId` flow automatically through the request lifecycle without prop drilling
- ✅ **HTTP Logging Interceptor** — auto-logs all HTTP requests/responses with URL normalization (UUIDs and numeric IDs replaced by `:id`)
- ✅ **Exception Filter** — captures NestJS `HttpException` and unexpected errors with structured output

### 🔌 Destinations

- ✅ **Pluggable Destinations** — implement `ILogDestination` to ship logs to Loki, Postgres, rolling files, or any sink
- ✅ **Zero-Downtime Lifecycle** — `onInit()` / `onShutdown()` hooks; a failing destination is removed without affecting others
- ✅ **Crash-Proof Writes** — every `write()` is wrapped in a try/catch and reported as a meta-log, never propagated to the app

### 🧩 Developer Experience

- ✅ **Zero Runtime Dependencies** — everything arrives as a peer dependency, so you control versions and supply-chain surface
- ✅ **2 Subpath Exports** — `.` for the NestJS server API, `./shared` for zero-dependency types and constants
- ✅ **Dynamic Module** — configure via `forRoot()` or `forRootAsync()`, sensible defaults included
- ✅ **Strict TypeScript** — `strict: true`, no `any` in production code, JSDoc on every public export
- ✅ **100% Coverage + Mutation Tested** — statements, branches, functions, and lines gated at 100%, with Stryker as the deeper gate

---

## 📦 Subpath Exports

One package, two entry points — import only what your app needs:

| Subpath    | Import                          | Purpose                                                                         |  Dependencies   |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------- | :-------------: |
| **Server** | `@bymax-one/nest-logger`        | NestJS module, logger service, interceptor, filter, decorators, destinations    | NestJS 11, pino |
| **Shared** | `@bymax-one/nest-logger/shared` | Types, constants, the log-key regex — `LogLevel`, `LogEntry`, `ServiceMetadata` |      None       |

```
shared (zero deps)
     ↑
  server
```

The `/shared` subpath is safe to import in isomorphic code, test helpers, CLI scripts, or shared packages that must not pull in NestJS.

---

> [!TIP]
> Prefer to learn from a working app? See the [nest-logger-example](https://github.com/bymaxone/nest-logger-example) — a full NestJS project wired with this library.

## 🚀 Quick Start

### 1. Install

```bash
# Using pnpm (recommended)
pnpm add @bymax-one/nest-logger

# Using npm
npm install @bymax-one/nest-logger

# Using yarn
yarn add @bymax-one/nest-logger
```

> [!IMPORTANT]
> You must also install the required **peer dependencies**. The library ships `"dependencies": {}`, so nothing arrives implicitly:

```bash
# Server subpath (required)
pnpm add @nestjs/common @nestjs/core pino reflect-metadata rxjs

# Optional — pretty local output via PrettyDevDestination
pnpm add -D pino-pretty

# Optional — OpenTelemetry trace correlation
pnpm add @opentelemetry/api @opentelemetry/sdk-node
```

> [!NOTE]
> `@opentelemetry/api` is detected at bootstrap. When it is absent the trace mixin steps aside and logs a single `LOGGER_OTEL_API_UNAVAILABLE` info entry — the logger never fails to start over an optional peer.

### 2. Register the module

```typescript
// app.module.ts
import { Module } from '@nestjs/common'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'my-app', version: '1.0.0' },
      level: 'info',
      http: { isEnabled: true }
    })
  ]
})
export class AppModule {}
```

Stdout is wired automatically — `DefaultStdoutDestination` is always active, so this is all you need to be logging structured JSON.

### 3. Async configuration with `ConfigService`

```typescript
// app.module.ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BymaxLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        service: {
          name: cfg.getOrThrow<string>('OTEL_SERVICE_NAME'),
          version: cfg.getOrThrow<string>('RELEASE_SHA')
        },
        level: cfg.get('LOG_LEVEL') ?? 'info',
        http: { isEnabled: true }
      })
    })
  ]
})
export class AppModule {}
```

### 4. Inject the logger in a service

```typescript
// payments.service.ts
import { Injectable } from '@nestjs/common'
import { InjectLogger, PinoLoggerService } from '@bymax-one/nest-logger'

@Injectable()
export class PaymentsService {
  constructor(
    @InjectLogger(PaymentsService.name)
    private readonly logger: PinoLoggerService
  ) {}

  async refund(paymentId: string, amount: number, requestedBy: string) {
    this.logger.info('PAYMENT_REFUND_REQUESTED', 'Refund requested', requestedBy, {
      paymentId,
      amount
    })

    try {
      const result = await this.stripe.refunds.create({ payment_intent: paymentId, amount })
      this.logger.info('PAYMENT_REFUND_SUCCESS', 'Refund processed', requestedBy, {
        paymentId,
        stripeRefundId: result.id
      })
      return result
    } catch (err) {
      this.logger.errorStructured(
        'PAYMENT_REFUND_FAILED',
        err instanceof Error ? err : new Error(String(err)),
        requestedBy,
        { paymentId, amount }
      )
      throw err
    }
  }
}
```

Output (JSON, production):

```json
{
  "level": 30,
  "time": "2026-05-28T10:12:44.512Z",
  "service": { "name": "my-app", "version": "abc123" },
  "logKey": "PAYMENT_REFUND_SUCCESS",
  "msg": "Refund processed",
  "context": "PaymentsService",
  "requestId": "r_7f3a9b",
  "tenantId": "t_acme",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "paymentId": "pi_xyz",
  "stripeRefundId": "re_abc"
}
```

Output (pretty-print, development):

```
[10:12:44.512] INFO (my-app): PAYMENT_REFUND_SUCCESS
    requestId: "r_7f3a9b"
    tenantId: "t_acme"
    paymentId: "pi_xyz"
    stripeRefundId: "re_abc"
```

### 5. HTTP logging (automatic)

Enable `http.isEnabled: true` in the module options. The `HttpLoggingInterceptor` is registered globally and emits:

| Log key                     | When                                  |
| --------------------------- | ------------------------------------- |
| `HTTP_REQUEST_START`        | Request received                      |
| `HTTP_REQUEST_SUCCESS`      | 2xx response                          |
| `HTTP_REQUEST_REDIRECT`     | 3xx response                          |
| `HTTP_REQUEST_CLIENT_ERROR` | 4xx response                          |
| `HTTP_REQUEST_SERVER_ERROR` | 5xx response                          |
| `HTTP_EXCEPTION_HANDLED`    | `HttpException` caught by the filter  |
| `HTTP_EXCEPTION_UNHANDLED`  | Unexpected error caught by the filter |

URLs are automatically normalized — `/users/550e8400-e29b-41d4-a716-446655440000` becomes `/users/:id` so Loki/Grafana cardinality stays bounded.

### 6. OpenTelemetry correlation

Initialize the OTel SDK **before** importing NestJS — this is critical:

```typescript
// main.ts (top of file — before any NestJS import)
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
      '@opentelemetry/instrumentation-fs': { isEnabled: false } // noisy
    })
  ]
})

sdk.start()

process.on('SIGTERM', () => {
  void sdk.shutdown().finally(() => process.exit(0))
})

// NestJS imports come AFTER sdk.start()
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  await app.listen(3000)
}

void bootstrap()
```

Once active, every log entry automatically carries `traceId`, `spanId`, and `traceFlags`. Click the `traceId` in Grafana to jump directly to the correlated span in Tempo or Honeycomb.

### 7. Context propagation with `LogContextService`

```typescript
// request-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common'
import { LogContextService } from '@bymax-one/nest-logger'
import { randomUUID } from 'node:crypto'

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly logContext: LogContextService) {}

  use(req: Request, res: Response, next: () => void) {
    const requestId = req.headers['x-request-id'] ?? `r_${randomUUID()}`
    this.logContext.run({ requestId }, next)
  }
}
```

Any log emitted inside the `run()` scope — regardless of nesting depth — automatically includes `requestId` with no prop drilling.

---

## ⚙️ Configuration

Full options reference for `BymaxLoggerModule.forRoot(options)`:

### Top-level options

| Option                       | Type                | Default         | Description                                                                                                              |
| ---------------------------- | ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `service.name`               | `string`            | **Required**    | Service name emitted in every log entry                                                                                  |
| `service.version`            | `string`            | **Required**    | Release version/SHA emitted in every log entry                                                                           |
| `level`                      | `LogLevel`          | `'info'`        | Minimum log level. One of `fatal \| error \| warn \| info \| debug \| trace`                                             |
| `isPretty`                   | `boolean`           | `!isProduction` | ⚠️ Reserved — not auto-wired. For pretty output add `new PrettyDevDestination()` to `destinations` (needs `pino-pretty`) |
| `redactPaths`                | `string[]`          | `[]`            | Additional `fast-redact` paths merged with the defaults                                                                  |
| `shouldDisableDefaultRedact` | `boolean`           | `false`         | Skip the 113 default PII paths. ⚠️ Emits a bootstrap warning — document why                                              |
| `redactCensor`               | `string`            | `'[REDACTED]'`  | Replacement value written in place of every redacted field                                                               |
| `maxEntrySizeBytes`          | `number`            | `65536`         | Entries larger than this are replaced by a structured `LOGGER_ENTRY_TRUNCATED` warning                                   |
| `destinations`               | `ILogDestination[]` | `[]`            | Additional sinks (Loki, Postgres, rolling file, …) alongside default stdout                                              |

### `http` options

| Option                         | Type       | Default                         | Description                                                                           |
| ------------------------------ | ---------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `http.isEnabled`               | `boolean`  | `false`                         | Register `HttpLoggingInterceptor` (and, on `forRoot`, `HttpExceptionFilter`) globally |
| `http.shouldCaptureExceptions` | `boolean`  | `true`                          | Capture unhandled HTTP exceptions and emit `HTTP_EXCEPTION_UNHANDLED`                 |
| `http.shouldGenerateRequestId` | `boolean`  | `true`                          | Generate a `requestId` when the inbound request header is absent                      |
| `http.excludePaths`            | `RegExp[]` | `[/^\/health$/, /^\/metrics$/]` | Paths that bypass HTTP logging. Use anchored, linear-time regexes (ReDoS-safe)        |
| `http.tenantIdHeader`          | `string`   | `'x-tenant-id'`                 | Request header carrying the tenant identifier                                         |

### `otel` options

| Option                              | Type                          | Default       | Description                                                              |
| ----------------------------------- | ----------------------------- | ------------- | ------------------------------------------------------------------------ |
| `otel.shouldAutoInjectTraceContext` | `boolean`                     | `true`        | Detect `@opentelemetry/api` and inject `traceId`/`spanId` via Pino mixin |
| `otel.fieldFormat`                  | `'camelCase' \| 'snake_case'` | `'camelCase'` | Field names in log entries: `traceId`/`spanId` vs `trace_id`/`span_id`   |

---

## 🔑 Log Key Convention

All structured log calls must use the `MODULE_ACTION_RESULT` format:

```
USER_LOGIN_SUCCESS         AUTH_REGISTER_FAILED
PAYMENT_REFUND_PROCESSED   WEBHOOK_STRIPE_RECEIVED
HTTP_REQUEST_CLIENT_ERROR  METHOD_SLOW_EXECUTION
```

The regex is exported from the `/shared` entry for CI validation:

```typescript
import { LOG_KEYS_CONVENTION_REGEX } from '@bymax-one/nest-logger/shared'

function assertValidLogKey(key: string) {
  if (!LOG_KEYS_CONVENTION_REGEX.test(key)) {
    throw new Error(`Invalid log key: "${key}". Expected MODULE_ACTION_RESULT format.`)
  }
}
```

### Reserved keys

The following keys are used internally by the library — do not reuse them in application code:

`LOGGER_BOOTSTRAP_OK` · `LOGGER_BOOTSTRAP_WARNING` · `LOGGER_SHUTDOWN_OK` · `HTTP_REQUEST_START` · `HTTP_REQUEST_SUCCESS` · `HTTP_REQUEST_REDIRECT` · `HTTP_REQUEST_CLIENT_ERROR` · `HTTP_REQUEST_SERVER_ERROR` · `HTTP_REQUEST_COMPLETED` · `HTTP_EXCEPTION_HANDLED` · `HTTP_EXCEPTION_UNHANDLED` · `METHOD_EXECUTION` · `METHOD_SLOW_EXECUTION` · `LOGGER_DESTINATION_INIT_FAILED` · `LOGGER_DESTINATION_WRITE_FAILED` · `LOGGER_ENTRY_TRUNCATED`

All reserved keys are exported as the `RESERVED_LOG_KEYS` constant from `@bymax-one/nest-logger/shared`.

---

## 🧩 Custom Destinations

Implement `ILogDestination` to ship logs to any sink:

```typescript
import type { ILogDestination } from '@bymax-one/nest-logger'
import type { LogEntry } from '@bymax-one/nest-logger/shared'

export class LokiDestination implements ILogDestination {
  readonly name = 'loki'
  readonly minLevel = 'info' as const

  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly labels: Record<string, string>
  private buffer: LogEntry[] = []
  private flushTimer?: NodeJS.Timeout

  constructor(opts: {
    url: string
    username: string
    password: string
    labels: Record<string, string>
  }) {
    this.url = `${opts.url}/loki/api/v1/push`
    this.labels = opts.labels
    const credentials = Buffer.from(`${opts.username}:${opts.password}`).toString('base64')
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Basic ${credentials}`
    }
  }

  async onInit(): Promise<void> {
    this.flushTimer = setInterval(() => void this.flush(), 5_000)
  }

  async onShutdown(): Promise<void> {
    clearInterval(this.flushTimer)
    await this.flush()
  }

  write(entry: LogEntry): void {
    this.buffer.push(entry)
    if (this.buffer.length >= 100) void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0)
    const body = JSON.stringify({
      streams: [
        {
          stream: this.labels,
          values: batch.map((e) => [String(BigInt(e.time) * 1_000_000n), JSON.stringify(e)])
        }
      ]
    })
    await fetch(this.url, { method: 'POST', headers: this.headers, body })
  }
}
```

Then pass it via `destinations`:

```typescript
BymaxLoggerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    service: { name: cfg.getOrThrow('OTEL_SERVICE_NAME'), version: cfg.getOrThrow('RELEASE_SHA') },
    level: 'info',
    destinations: [
      new LokiDestination({
        url: cfg.getOrThrow('LOKI_URL'),
        username: cfg.getOrThrow('LOKI_USER'),
        password: cfg.getOrThrow('LOKI_PASSWORD'),
        labels: { service: cfg.getOrThrow('OTEL_SERVICE_NAME') }
      })
    ]
  })
})
```

### Postgres destination (Prisma)

```typescript
import type { ILogDestination } from '@bymax-one/nest-logger'
import type { LogEntry } from '@bymax-one/nest-logger/shared'
import type { PrismaClient } from '@prisma/client'

export class PrismaLogDestination implements ILogDestination {
  readonly name = 'prisma-postgres'
  readonly minLevel = 'warn' as const // only persist warnings and above

  constructor(private readonly prisma: PrismaClient) {}

  write(entry: LogEntry): void {
    void this.prisma.applicationLog.create({
      data: {
        level: entry.level,
        logKey: entry.logKey,
        message: entry.msg,
        payload: entry,
        createdAt: new Date(entry.time)
      }
    })
  }
}
```

### Rolling file destination (`pino-roll`)

```typescript
import { createStream } from 'pino-roll'
import type { ILogDestination } from '@bymax-one/nest-logger'
import type { LogEntry } from '@bymax-one/nest-logger/shared'

export class RollingFileDestination implements ILogDestination {
  readonly name = 'rolling-file'
  private stream?: Awaited<ReturnType<typeof createStream>>

  async onInit(): Promise<void> {
    this.stream = await createStream('logs/app.log', {
      frequency: 'daily',
      mkdir: true,
      size: '50m'
    })
  }

  async onShutdown(): Promise<void> {
    await new Promise<void>((resolve) => this.stream?.end(resolve))
  }

  write(entry: LogEntry): void {
    this.stream?.write(JSON.stringify(entry) + '\n')
  }
}
```

---

## 🏗️ Architecture

```
HTTP Request
    │
    ▼
HttpLoggingInterceptor          ← emits HTTP_REQUEST_START
    │
    ▼
RequestIdMiddleware             ← opens AsyncLocalStorage scope
    │                              { requestId, tenantId, userId }
    ▼
Application Service
    │
    └── PinoLoggerService.info(logKey, msg, context, metadata)
              │
              ▼
         Pino logger
              │
         composedMixin()         ← runs per-log (O(1))
              ├── ALS store      → { requestId, tenantId, userId }
              └── OTel span      → { traceId, spanId, traceFlags }
              │
              ▼
         fast-redact             ← compiled redact function (113 paths)
              │
              ▼
    ┌─────────────────────────────┐
    │  DefaultStdoutDestination   │  ← always active
    │  LokiDestination            │  ← optional
    │  PrismaLogDestination       │  ← optional
    │  RollingFileDestination     │  ← optional
    └─────────────────────────────┘
```

### Design Principles

| Principle                     | Description                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **🪶 Singleton Scope**        | `AsyncLocalStorage` delivers per-request context at zero latency overhead — NestJS `Scope.REQUEST` adds ~5% on the injection graph, unacceptable on a logger that runs for every request         |
| **🧬 One Composed Mixin**     | ALS context and OTel trace context merge into a single Pino mixin with a deterministic order: ALS first, then OTel — an active span is the authoritative trace identity, so it wins on conflicts |
| **⚡ Compiled Redaction**     | 113 `fast-redact` paths compile once at module bootstrap into a specialized function; no per-log regex matching, under 3% throughput impact                                                      |
| **🔌 Interface-Driven Sinks** | `ILogDestination` is a contract — Loki, Postgres, rolling files, or anything else is a consumer implementation, never a dependency of this package                                               |
| **🌳 Zero Runtime Deps**      | `"dependencies": {}` — every package arrives as a peer dependency, so consumers pin exact versions and the supply-chain surface stays theirs                                                     |

---

## 🔐 Security Model

A logger sees every payload the application handles, so the security posture is about what **never** reaches the sink — and about a sink failure never reaching the application.

### Redaction by default

The library ships **113 redact paths** compiled at initialization into a single `fast-redact` function (< 3% throughput impact). These cover:

| Category                  | Fields                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords                 | `password`, `passwordHash`, `passwordConfirm`, `newPassword`, `oldPassword`                                                               |
| Tokens                    | `token`, `accessToken`, `refreshToken`, `idToken`, `apiKey`, `apiSecret`                                                                  |
| MFA                       | `mfaSecret`, `mfaRecoveryCodes`, `totpSecret`                                                                                             |
| Generic secrets           | `secret`, `clientSecret`, `signingSecret`, `privateKey`                                                                                   |
| Payment / PCI DSS         | `cardNumber`, `cardCvv`, `cvv`, `cvc`, `cardExpiry`                                                                                       |
| Personal documents (LGPD) | `cpf`, `cnpj`, `rg`                                                                                                                       |
| Conservative PII          | `email`                                                                                                                                   |
| HTTP headers (absolute)   | `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-api-key"]`, `req.headers["x-auth-token"]`, `res.headers["set-cookie"]` |

Every field is listed at wildcard depths 1–4 (`*.field`, `*.*.field`, `*.*.*.field`, `*.*.*.*.field`) because `fast-redact`'s `*` matches a single level only — not recursive.

### Extending the defaults

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  redactPaths: [
    '*.internalSecret', // depth-1 wildcard
    'body.creditCard.*', // all fields inside a subobject
    'payload.user.taxId' // exact path
  ]
})
```

The extra paths are **merged** with the defaults — never replacing them.

### Disabling defaults (not recommended)

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  shouldDisableDefaultRedact: true, // ⚠️ emits LOGGER_BOOTSTRAP_WARNING
  redactPaths: ['*.password'] // you own the full list
})
```

A `LOGGER_BOOTSTRAP_WARNING` entry is emitted on startup so security reviews can audit when PII protection was intentionally reduced.

### An append-only default list

`DEFAULT_REDACT_PATHS` is append-only by contract: a path may be added in a minor release, but removing one requires a major version bump. A field that stopped being redacted silently is a leak that no consumer would notice — the version number is what makes it visible.

### Validated trace identifiers

Trace context is never copied verbatim into a log entry. The OTel mixin reads the active span and passes its identifiers through `isValidTraceId` / `isValidSpanId` before injecting them, so a malformed or attacker-influenced value cannot be written into the correlation fields your dashboards and alerts key on.

### Destination failures are contained

Every `write()` runs inside a try/catch. A destination that throws produces a `LOGGER_DESTINATION_WRITE_FAILED` line on `stderr` and the entry is skipped for that sink only; a destination whose `onInit()` rejects is reported as `LOGGER_DESTINATION_INIT_FAILED` and dropped from the active set without blocking boot. A logging backend going down degrades logging — it never takes the application with it.

### Bounded entry size

Entries larger than `maxEntrySizeBytes` (64 KB by default) are replaced by a structured `LOGGER_ENTRY_TRUNCATED` warning rather than being written or silently dropped. This bounds the memory and bandwidth one oversized payload can consume, and leaves a record that truncation happened.

### Security Checklist

When integrating `@bymax-one/nest-logger` in production, verify each of the following:

- `shouldDisableDefaultRedact` stays `false` — if it is on, the `LOGGER_BOOTSTRAP_WARNING` must be justified in a security review
- Every custom field carrying a secret or personal document is added to `redactPaths` at the depths it actually appears
- `http.excludePaths` regexes are anchored and linear-time — an unbounded pattern runs on every request URL (ReDoS)
- Custom destinations never re-serialize the raw request object; they receive the already-redacted `LogEntry`
- Destination credentials (Loki, Postgres, OTLP) come from the environment, never from values written into module options in source control
- Log retention at the sink matches your data-retention policy — redaction bounds what is stored, not how long

---

## 🛡️ Security Table

| Layer               | Implementation                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| PII Redaction       | 113 `fast-redact` paths compiled once at bootstrap — no per-log regex matching                                 |
| Credentials         | `password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `apiKey`, `apiSecret`, `privateKey`        |
| MFA Secrets         | `mfaSecret`, `mfaRecoveryCodes`, `totpSecret` — redacted at wildcard depths 1–4                                |
| PCI DSS             | `cardNumber`, `cardCvv`, `cvv`, `cvc`, `cardExpiry`                                                            |
| LGPD Documents      | `cpf`, `cnpj`, `rg`, plus `email` as a conservative default                                                    |
| HTTP Headers        | `authorization`, `cookie`, `x-api-key`, `x-auth-token`, `set-cookie` — absolute paths on `req` / `res`         |
| Redact List         | `DEFAULT_REDACT_PATHS` is append-only; removal requires a major version                                        |
| Trace Injection     | `isValidTraceId` / `isValidSpanId` validated before any identifier is written                                  |
| URL Cardinality     | UUIDs and numeric IDs normalized to `:id` — bounds label cardinality and keeps raw identifiers out of the path |
| Destination Failure | Every `write()` try/catch-wrapped; a failing sink is skipped or dropped, never propagated to the caller        |
| Entry Size          | Hard cap at `maxEntrySizeBytes` (64 KB default) with a structured truncation warning                           |
| Supply Chain        | `"dependencies": {}` — no transitive runtime packages of the library's own choosing                            |

> [!IMPORTANT]
> Redaction protects the fields it knows about. Any new field carrying a secret or a personal document must be added to `redactPaths` — the default list covers the standard set, not your domain's.

---

## 🧱 Tech Stack

[![Pino](https://img.shields.io/badge/Pino-10-green?style=flat-square)](https://getpino.io)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs)](https://nestjs.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Jest](https://img.shields.io/badge/Jest-30-C21325?style=flat-square&logo=jest)](https://jestjs.io)
[![Stryker](https://img.shields.io/badge/Stryker-Mutation_Testing-red?style=flat-square)](https://stryker-mutator.io)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io)
[![tsup](https://img.shields.io/badge/tsup-8-orange?style=flat-square)](https://tsup.egoist.dev)

---

## 🧪 Testing & Quality

A logger runs on every request of every service that installs it, so the suite is held to a bar beyond "it runs" — every behavior is pinned so that a regression **fails a test**.

- ✅ **100% line coverage** — statements, branches, functions, and lines, enforced as a release gate across unit + e2e
- ✅ **97.42% mutation score** — verified with [Stryker](https://stryker-mutator.io/) against a `break` threshold of 95; 97.42% is the theoretical maximum for this codebase
- ✅ **Every survivor documented** — the 10 remaining mutants are equivalents, each recorded in [docs/mutation_testing_results.md](./docs/mutation_testing_results.md) rather than silenced with an inline comment, so the score is an accounting rather than a number
- ✅ **No real I/O in unit tests** — the Pino instance and every destination are mocked; e2e tests exercise the wired module through `@nestjs/testing` and supertest

```bash
pnpm test              # unit tests (Jest)
pnpm test:cov          # coverage report
pnpm test:e2e          # end-to-end tests (supertest)
pnpm test:cov:all      # full coverage gate (100% statements/branches/functions/lines)
pnpm mutation          # Stryker mutation testing (95% break gate)
pnpm typecheck         # tsc strict check (all tsconfig variants)
pnpm lint              # ESLint
```

> [!NOTE]
> Line coverage proves a line _executed_ under test; mutation testing proves a test _would fail_ if that line were wrong. The full methodology and per-area breakdown are in [docs/mutation_testing_results.md](./docs/mutation_testing_results.md).

---

## 📖 API Reference

### `PinoLoggerService`

Implements NestJS `LoggerService`. All methods are available via `@InjectLogger()`.

| Method            | Signature                          | Notes                                  |
| ----------------- | ---------------------------------- | -------------------------------------- |
| `info`            | `(logKey, msg, context?, meta?)`   | Structured info log                    |
| `warn`            | `(logKey, msg, context?, meta?)`   | Structured warn log                    |
| `debug`           | `(logKey, msg, context?, meta?)`   | Structured debug log                   |
| `error`           | `(logKey, msg, context?, meta?)`   | Structured error log (string message)  |
| `fatal`           | `(logKey, msg, context?, meta?)`   | Structured fatal log                   |
| `warnStructured`  | `(logKey, error, context?, meta?)` | Warn with `Error` object (serialized)  |
| `errorStructured` | `(logKey, error, context?, meta?)` | Error with `Error` object (serialized) |
| `fatalStructured` | `(logKey, error, context?, meta?)` | Fatal with `Error` object (serialized) |
| `log`             | `(msg, context?)`                  | NestJS `LoggerService` bridge → `info` |
| `verbose`         | `(msg, context?)`                  | NestJS bridge → `trace`                |

### `LogContextService`

| Method     | Signature           | Description                                                                 |
| ---------- | ------------------- | --------------------------------------------------------------------------- |
| `run`      | `(store, callback)` | Opens an ALS scope. Any log inside `callback` carries `store` fields        |
| `set`      | `(key, value)`      | Adds/updates a field in the current scope. Throws if called outside `run()` |
| `getStore` | `()`                | Returns current scope or `undefined` outside a `run()` call                 |

### Decorators

| Decorator                       | Target            | Description                                                                                   |
| ------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `@InjectLogger(context?)`       | Constructor param | Injects `PinoLoggerService` pre-bound to the given context string                             |
| `@LogContext(store)`            | Method            | Wraps the method in `logContext.run(store, ...)` — all downstream logs carry the given fields |
| `@LogPerformance(thresholdMs?)` | Method            | Logs `METHOD_EXECUTION` on completion; `METHOD_SLOW_EXECUTION` if duration exceeds threshold  |

### Types (from `@bymax-one/nest-logger/shared`)

```typescript
type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

type ServiceMetadata = { name: string; version: string }

type LogEntry = {
  level: number
  time: number
  service: ServiceMetadata
  logKey: string
  msg: string
  [key: string]: unknown
}
```

### `ILogDestination`

```typescript
interface ILogDestination {
  readonly name: string
  readonly minLevel?: LogLevel
  write(entry: LogEntry): void
  onInit?(): Promise<void>
  onShutdown?(): Promise<void>
}
```

---

## 🚨 Error Code Catalog

| Code                              | Severity          | When                                                     | Action                                                                |
| --------------------------------- | ----------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `LOGGER_INVALID_OPTIONS`          | Throws at init    | `service.name` or `service.version` missing              | Add the required fields                                               |
| `LOGGER_INVALID_LEVEL`            | Throws at init    | `level` is not a valid Pino value                        | Use `'fatal'\|'error'\|'warn'\|'info'\|'debug'\|'trace'`              |
| `LOGGER_PRETTY_UNAVAILABLE`       | Warn on bootstrap | `isPretty: true` but `pino-pretty` not installed         | Install `pino-pretty` or set `isPretty: false`                        |
| `LOGGER_OTEL_API_UNAVAILABLE`     | Info on bootstrap | OTel mixin active but `@opentelemetry/api` not installed | Install the package or set `otel.shouldAutoInjectTraceContext: false` |
| `LOGGER_DESTINATION_INIT_FAILED`  | Error (logged)    | `destination.onInit()` rejects                           | Destination is removed; other destinations continue                   |
| `LOGGER_DESTINATION_WRITE_FAILED` | Warn (logged)     | `destination.write()` throws                             | Entry skipped for that destination; others continue                   |
| `LOGGER_CONTEXT_OUT_OF_SCOPE`     | Throws            | `LogContextService.set()` called outside `run()`         | Wrap in `logContext.run({ ... }, () => ...)`                          |
| `LOGGER_ENTRY_TRUNCATED`          | Warn (meta-log)   | Entry exceeds `maxEntrySizeBytes`                        | Reduce metadata or raise the limit                                    |

---

## 🪜 Level Mapping

| Pino | Pino string | NestJS    | Typical use                               |
| ---- | ----------- | --------- | ----------------------------------------- |
| 60   | `fatal`     | —         | Process about to exit                     |
| 50   | `error`     | `error`   | Failure requiring human attention         |
| 40   | `warn`      | `warn`    | Recoverable anomaly                       |
| 30   | `info`      | `log`     | Significant business events               |
| 20   | `debug`     | `debug`   | Implementation detail for troubleshooting |
| 10   | `trace`     | `verbose` | Ultra-granular (rarely in prod)           |

---

## ⚡ Performance

Pino official benchmarks (Node 24, 100k logs):

| Logger                 | Logs/sec     | Avg latency | RSS        | CPU    |
| ---------------------- | ------------ | ----------- | ---------- | ------ |
| **Pino 10 (JSON)**     | **~750,000** | **1.3 µs**  | **~45 MB** | **8%** |
| Pino 10 (pretty)       | ~120,000     | 8 µs        | ~50 MB     | 14%    |
| Winston 3 (JSON)       | ~110,000     | 9 µs        | ~85 MB     | 22%    |
| Winston 3 (transports) | ~75,000      | 13 µs       | ~95 MB     | 28%    |

At high throughput (~100k req/s), Pino consumes 3× less CPU and ~2× less RSS than Winston.

---

## 🚫 What This Library Does NOT Do

By design, the following are out of scope:

- ❌ **OTel SDK initialization** — consumer's responsibility in `main.ts`
- ❌ **Custom metrics** (OTel Metrics API) — use `@opentelemetry/api` directly
- ❌ **Alerting** (PagerDuty, Slack) — configure your OTLP backend (Grafana Alertmanager)
- ❌ **Log aggregation UI** — Grafana, Datadog, Honeycomb
- ❌ **Sentry SDK** — install `@sentry/node` in the consumer if desired
- ❌ **Immutable audit logs** — future `@bymax-one/nest-audit`
- ❌ **File rotation built-in** — use `RollingFileDestination` with `pino-roll`
- ❌ **`pino-http`** — the `HttpLoggingInterceptor` is a NestJS-native replacement; install `pino-http` independently if you prefer it (produces duplicate logs if both are active)

---

## 🤝 Contributing

This library is part of the `@bymax-one` monorepo. Development follows the Bymax coding standards:

- TypeScript strict (`noImplicitAny`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- 100% test coverage gate
- Conventional Commits enforced by commitlint + husky
- No direct dependencies — peer deps only
- All boolean identifiers prefixed with `is / has / should / can`
- All log keys in `MODULE_ACTION_RESULT` format

```bash
# Clone the repository
git clone https://github.com/bymaxone/nest-logger.git
cd nest-logger

# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build

# Type check
pnpm typecheck
```

---

## 🔒 Security Policy

If you discover a security vulnerability, please **do not** open a public issue. Instead, email us at **support@bymax.one** with details. We take security seriously and will respond promptly.

---

## 📄 License

[MIT](./LICENSE) © [Bymax One](https://github.com/bymaxone)

---

<p align="center">
  <sub>Built with ❤️ by <a href="https://github.com/bymaxone">Bymax One</a></sub>
</p>
