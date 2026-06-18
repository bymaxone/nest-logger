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

---

## 🔥 Features

- **Structured JSON** — every entry has `level`, `time`, `service`, `logKey`, `msg`, and arbitrary metadata fields
- **PII redaction by default** — 113 paths covering passwords, tokens, generic secrets, PCI DSS card data, MFA secrets, CPF/CNPJ/RG (LGPD), and common HTTP headers — powered by `fast-redact`
- **OpenTelemetry correlation** — optional `@opentelemetry/api` peer; injects `traceId`/`spanId`/`traceFlags` into every log via a Pino mixin when an active span is detected
- **AsyncLocalStorage context** — `requestId`, `tenantId`, `userId` flow automatically through the request lifecycle without prop drilling
- **HTTP logging interceptor** — auto-logs all HTTP requests/responses with URL normalization (UUIDs and numeric IDs replaced by `:id` placeholder)
- **Exception filter** — captures NestJS `HttpException` and unexpected errors with structured output
- **Pluggable destinations** — implement `ILogDestination` to ship logs to Loki, Postgres, rolling files, or any sink
- **NestJS `LoggerService` bridge** — drop-in replacement; all NestJS internal logs flow through Pino
- **`MODULE_ACTION_RESULT` log key convention** — enforced by an exported regex for CI validation
- **Pretty-print in dev** — auto-enabled when `NODE_ENV !== 'production'` (requires optional `pino-pretty`)
- **Entry size guard** — truncates oversized entries (default 64 KB) with a structured warning instead of silently dropping them
- **Zero-downtime destination lifecycle** — `onInit()` / `onShutdown()` hooks; a failing destination is removed without affecting others

---

## 📦 Subpath Exports

The package ships two entry points:

| Import path                     | Contents                                                                                                                       | Deps                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `@bymax-one/nest-logger`        | Full server API: `BymaxLoggerModule`, `PinoLoggerService`, `LogContextService`, destinations, decorators, interceptors         | NestJS + Pino peer deps |
| `@bymax-one/nest-logger/shared` | Zero-dependency utilities: `LOG_KEYS_CONVENTION_REGEX`, `RESERVED_LOG_KEYS`, types (`LogLevel`, `LogEntry`, `ServiceMetadata`) | None                    |

The `/shared` subpath is safe to import in isomorphic code, test helpers, CLI scripts, or shared packages that must not pull in NestJS.

---

## 📥 Installation

```bash
# Install the library
pnpm add @bymax-one/nest-logger

# Required peer dependencies
pnpm add pino reflect-metadata

# Optional — pretty dev output
pnpm add -D pino-pretty

# Optional — OpenTelemetry correlation
pnpm add @opentelemetry/api @opentelemetry/sdk-node
```

---

## 🚀 Quick Start

### Step 1 — Register the module

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

`isPretty` defaults to `true` when `NODE_ENV !== 'production'` — no extra config needed in development.

### Step 2 — Async configuration with `ConfigService`

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

### Step 3 — Inject the logger in a service

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

### Step 4 — HTTP logging (automatic)

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

### Step 5 — OpenTelemetry correlation

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

### Step 6 — Context propagation with `LogContextService`

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

| Option                       | Type                 | Default         | Description                                                                                                              |
| ---------------------------- | -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `service.name`               | `string`             | **Required**    | Service name emitted in every log entry                                                                                  |
| `service.version`            | `string`             | **Required**    | Release version/SHA emitted in every log entry                                                                           |
| `level`                      | `LogLevel`           | `'info'`        | Minimum log level. One of `fatal \| error \| warn \| info \| debug \| trace`                                             |
| `isPretty`                   | `boolean`            | `!isProduction` | ⚠️ Reserved — not auto-wired. For pretty output add `new PrettyDevDestination()` to `destinations` (needs `pino-pretty`) |
| `redactPaths`                | `string[]`           | `[]`            | Additional `fast-redact` paths merged with the defaults                                                                  |
| `shouldDisableDefaultRedact` | `boolean`            | `false`         | Skip the 113 default PII paths. ⚠️ Emits a bootstrap warning — document why                                              |
| `redactCensor`               | `string \| function` | `'[REDACTED]'`  | Replacement value for redacted fields. A function receives the raw value                                                 |
| `maxEntrySizeBytes`          | `number`             | `65536`         | Entries larger than this are replaced by a structured `LOGGER_ENTRY_TRUNCATED` warning                                   |
| `destinations`               | `ILogDestination[]`  | `[]`            | Additional sinks (Loki, Postgres, rolling file, …) alongside default stdout                                              |

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

## 🔐 PII Redaction

### Default paths

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

**Key design decisions:**

- **Singleton scope, not `Scope.REQUEST`** — `AsyncLocalStorage` delivers per-request context at zero latency overhead. NestJS request scope adds ~5% latency on the injection graph; unacceptable on a logger that runs every request.
- **One Pino mixin** — ALS context and OTel trace context are composed into a single mixin. Merge order is deterministic: ALS fields first, then OTel (OTel wins on name conflicts because an active span is the authoritative trace identity).
- **Zero direct dependencies** — the library ships with `"dependencies": {}`. All packages arrive as peer dependencies so consumers control exact versions.
- **`fast-redact` compiled at init** — 113 paths compile once at module bootstrap into a specialized JS function. No per-log regex matching.

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

## 🧪 Testing & Quality

```bash
pnpm test              # unit tests (Jest)
pnpm test:cov          # coverage report
pnpm test:e2e          # end-to-end tests (supertest)
pnpm test:cov:all      # full coverage gate (100% statements/branches/functions/lines)
pnpm mutation          # Stryker mutation testing (95% break gate)
pnpm typecheck         # tsc strict check (all tsconfig variants)
pnpm lint              # ESLint
```

Coverage gate: **100%** on statements, branches, functions, and lines. Mutation: **97.42%** current vs the **95%** break gate (Stryker `thresholds.break: 95`); 97.42% is the theoretical maximum — all 10 surviving mutants are documented equivalents. See [mutation_testing_results.md](docs/mutation_testing_results.md).

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
