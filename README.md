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
  <a href="https://github.com/bymaxone/nest-logger/blob/main/docs/mutation_testing_results.md"><img src="https://img.shields.io/badge/mutation-100%25-brightgreen?style=flat-square&colorA=000000" alt="mutation score" /></a>
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

`@bymax-one/nest-logger` replaces ad-hoc `console.log` and legacy Winston setups with a structured logging pipeline. Every entry is a JSON object carrying a `logKey` (`MODULE_ACTION_RESULT` convention), `requestId`, `tenantId` and, when OpenTelemetry is active, the correlated `traceId`/`spanId`.

The library has **zero direct dependencies**: every package arrives as a peer dependency, so you control exact versions and the supply chain stays small.

- **🎯 One module, the whole pipeline** — logger service, HTTP access log, exception filter, context propagation, redaction and destinations arrive in a single `forRoot()`.
- **🔌 Your sinks, your rules** — implement `ILogDestination` for Loki, Postgres, a rolling file or anything else. No hidden transport dependencies.
- **🔒 Redacted by default** — 32 sensitive field names (passwords, tokens, card data, MFA secrets, LGPD documents, credential headers) are censored down to 100 levels of nesting. Domain-specific names are yours to add via `redactPaths`.
- **⚡ Cheap on the hot path** — singleton providers, one composed Pino mixin and a single-pass redactor. The shipped configuration sustains about 274,000 entries/s (see [Performance](#-performance)).
- **🔭 Correlated when you need it** — with an active OpenTelemetry span, `traceId`/`spanId`/`traceFlags` land in every entry; without the peer the mixin steps aside at zero cost.

---

## 📦 Subpath Exports

One package, two entry points — import only what your app needs:

| Subpath    | Import                          | Purpose                                                                                                                                                           |              Dependencies               |
| ---------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------: |
| **Server** | `@bymax-one/nest-logger`        | NestJS module, logger service, interceptor, filter, decorators, destinations                                                                                      | NestJS 11, pino, rxjs, reflect-metadata |
| **Shared** | `@bymax-one/nest-logger/shared` | Types, constants, the log-key regex — `LogLevel`, `LogEntry`, `ServiceMetadata`, `ResolvedServiceMetadata`, `EmittedServiceResource`, `EmittedDeploymentResource` |                  None                   |

```
shared (zero deps)
     ↑
  server
```

The `/shared` subpath is safe to import in isomorphic code, test helpers, CLI scripts, or shared packages that must not pull in NestJS.

---

> [!TIP]
> Prefer to learn from a working app? See [nest-logger-example](https://github.com/bymaxone/nest-logger-example), a full NestJS project wired with this library.

## 🚀 Quick Start

### 1. Install

```bash
pnpm add @bymax-one/nest-logger
```

The library ships `"dependencies": {}`, so install the **peer dependencies** yourself:

```bash
# Server subpath (required)
pnpm add @nestjs/common @nestjs/core pino reflect-metadata rxjs

# Optional — pretty local output via PrettyDevDestination
pnpm add -D pino-pretty

# Optional — OpenTelemetry trace correlation
pnpm add @opentelemetry/api @opentelemetry/sdk-node
```

> [!WARNING]
> **Under pnpm, `-D` does not guarantee that a peer is absent from a production image**: it was measured present after both `pnpm prune --prod` and a clean `pnpm install --prod --frozen-lockfile`. Under npm or yarn a pruned devDependency really is gone. Do not rely on packaging to keep `PrettyDevDestination` out of production: it refuses to initialize when `NODE_ENV` is exactly `production`, but in any other environment that feeds a log pipeline (staging, an unset `NODE_ENV`) it writes ANSI colour that the pipeline cannot parse. Gate it on an explicit configuration value.

`@opentelemetry/api` is resolved lazily. When it is absent the trace mixin steps aside silently; a copy that is installed but broken is reported once on `stderr` as `LOGGER_OTEL_API_BROKEN`. The published declarations depend on no HTTP framework's types: the interceptor, filter and request-id middleware use structural contracts (`LoggableRequest`, `LoggableResponse`, `NextHandler`) that an Express request and response satisfy as-is.

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

Stdout is wired automatically — with no `destinations` configured, `DefaultStdoutDestination` is the default sink, so this is all you need to be logging structured JSON. A non-empty `destinations` list replaces it (see [Destinations](#destinations-replace-stdout)).

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

`forRootAsync` also accepts `useClass` or `useExisting` with a class implementing `BymaxLoggerModuleOptionsFactory` (see the Configuration section). Options from any form pass the same validation as `forRoot`, and an error thrown while producing them fails module initialisation.

> [!IMPORTANT]
> **`forRootAsync` does not register the exception filter.** With `http.isEnabled` it registers the access log, but `HTTP_EXCEPTION_HANDLED` and `HTTP_EXCEPTION_UNHANDLED` are not emitted and `http.shouldCaptureExceptions` has no effect. Register it yourself:
>
> ```typescript
> import { Module } from '@nestjs/common'
> import { APP_FILTER } from '@nestjs/core'
> import { HttpExceptionFilter } from '@bymax-one/nest-logger'
>
> @Module({ providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }] })
> export class LoggingFilterModule {}
> ```

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

Output (JSON, production) for the `PAYMENT_REFUND_SUCCESS` call above, with the options from step 2:

```json
{
  "level": "info",
  "time": "2026-05-28T10:12:44.512Z",
  "service": { "name": "my-app", "version": "1.0.0" },
  "deployment": { "environment": { "name": "production" } },
  "context": "PaymentsService",
  "paymentId": "pi_xyz",
  "stripeRefundId": "re_abc",
  "logKey": "PAYMENT_REFUND_SUCCESS",
  "userId": "u_42",
  "event.name": "payment.refund.success",
  "msg": "Refund processed"
}
```

`requestId` and `tenantId` are added when the call runs inside an HTTP request that passed through the request-ID middleware (`tenantId` only when the request carries the tenant header), and `traceId` and `spanId` when an OpenTelemetry span is active (see [OpenTelemetry correlation](#-opentelemetry-correlation)). Outside a request, as in the flow above, they are absent.

Output (pretty-print, development):

```
[10:12:44.512] INFO (my-app): PAYMENT_REFUND_SUCCESS
    paymentId: "pi_xyz"
    stripeRefundId: "re_abc"
```

### 5. Next steps

Wire the access log in `main.ts` with `applyAccessLog(app)` (see [HTTP Logging](#-http-logging)), enable [OpenTelemetry correlation](#-opentelemetry-correlation), and read the Configuration tables for every option.

---

## ⚙️ Configuration

Full options reference for `BymaxLoggerModule.forRoot(options)`:

### Top-level options

| Option                       | Type                                          | Default                                             | Description                                                                                                                                                                                                                                                |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.name`               | `string`                                      | **Required**                                        | Service name emitted in every log entry                                                                                                                                                                                                                    |
| `service.version`            | `string`                                      | **Required**                                        | Release version/SHA emitted in every log entry                                                                                                                                                                                                             |
| `service.namespace`          | `string`                                      | —                                                   | OTel `service.namespace` (**Stable**) — the group the service belongs to                                                                                                                                                                                   |
| `service.instanceId`         | `string`                                      | —                                                   | OTel `service.instance.id` (**Stable**). **Never generated** — supply it from the platform. See [Resource identity](#resource-identity)                                                                                                                    |
| `service.environment`        | `string`                                      | `NODE_ENV`                                          | OTel `deployment.environment.name` (**Stable**). The deprecated `deployment.environment` is never emitted                                                                                                                                                  |
| `resourceFormat`             | `'nested' \| 'flat'`                          | `'nested'`                                          | Shape of the identity fields. `'flat'` emits the dotted attribute names verbatim                                                                                                                                                                           |
| `eventNameField`             | `string \| false`                             | `'event.name'`                                      | Field carrying the derived event name (`PAYMENT_FAILED` → `payment.failed`). `false` disables it                                                                                                                                                           |
| `errorFormat`                | `'pino' \| 'semconv' \| 'both'`               | `'pino'`                                            | `'both'` adds `exception.*` and `error.type` beside `err.*`; `'semconv'` replaces them                                                                                                                                                                     |
| `level`                      | `LogLevel`                                    | `'info'` when `NODE_ENV=production`, else `'debug'` | Minimum log level. One of `fatal \| error \| warn \| info \| debug \| trace`                                                                                                                                                                               |
| `redactPaths`                | `string[]`                                    | `[]`                                                | Additional `fast-redact` paths, applied on top of the default coverage                                                                                                                                                                                     |
| `redactStrategy`             | `'names' \| 'paths'`                          | `'names'`                                           | Engine behind the DEFAULT set. `'paths'` is the legacy `fast-redact` expansion (four-level ceiling, ~100× slower)                                                                                                                                          |
| `shouldDisableDefaultRedact` | `boolean`                                     | `false`                                             | Skip the default PII coverage entirely. ⚠️ Emits `LOGGER_BOOTSTRAP_WARNING` at startup — document why                                                                                                                                                      |
| `redactCensor`               | `string`                                      | `'[REDACTED]'`                                      | Replacement value written in place of every redacted field                                                                                                                                                                                                 |
| `maxEntrySizeBytes`          | `number`                                      | `65536`                                             | UTF-8 byte ceiling per serialized field (`err` + any custom serializer); over it the value becomes a truncation envelope                                                                                                                                   |
| `errorOwnFields`             | `'all' \| 'safe'`                             | `'all'`                                             | Which own fields of an error are written. `'all'` writes every one; `'safe'` writes an allow-list of operational names plus `errorOwnFieldNames` (see [Error fields](#error-fields)). A binary value is written as its size in both. Recommended: `'safe'` |
| `errorOwnFieldNames`         | `readonly string[]`                           | `[]`                                                | Own-field names `'safe'` writes beside its default list, matched exactly; ignored under `'all'`                                                                                                                                                            |
| `isGlobal`                   | `boolean`                                     | `true`                                              | Register the module as `@Global()`                                                                                                                                                                                                                         |
| `shouldUseAsNestLogger`      | `boolean`                                     | `true`                                              | **Deprecated, not read.** Call `BymaxLoggerModule.useNestLogger(app)` in `main.ts` instead                                                                                                                                                                 |
| `serializers`                | `Record<string, (input: unknown) => unknown>` | `{}`                                                | Custom Pino serializers, merged with the defaults                                                                                                                                                                                                          |
| `timestamp`                  | `() => string`                                | `() => new Date().toISOString()`                    | Custom timestamp function                                                                                                                                                                                                                                  |
| `destinations`               | `ILogDestination[]`                           | `[new DefaultStdoutDestination()]`                  | The sinks entries are written to. ⚠️ A non-empty list **replaces** that default — see [Destinations](#destinations-replace-stdout)                                                                                                                         |

### `http` options

| Option                         | Type                           | Default                                                                  | Description                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.isEnabled`               | `boolean`                      | `false`                                                                  | Register `HttpLoggingInterceptor` (and, on `forRoot`, `HttpExceptionFilter`) globally                                                                                                                                |
| `http.shouldCaptureExceptions` | `boolean`                      | `true`                                                                   | Capture unhandled HTTP exceptions and emit `HTTP_EXCEPTION_UNHANDLED`. `forRoot` only: see the note under [Async configuration](#3-async-configuration-with-configservice)                                           |
| `http.shouldGenerateRequestId` | `boolean`                      | `true`                                                                   | Generate a `requestId` when the inbound request header is absent                                                                                                                                                     |
| `http.excludePaths`            | `RegExp[]`                     | `[/^\/health$/, /^\/health\/live$/, /^\/health\/ready$/, /^\/metrics$/]` | Paths that bypass HTTP logging. Use anchored, linear-time regexes (ReDoS-safe)                                                                                                                                       |
| `http.tenantIdHeader`          | `string \| false`              | `'x-tenant-id'`                                                          | Request header carrying the tenant identifier, or `false` to read none. A value from the header is what the client asserted: see [Inbound `x-request-id` and tenant header](#inbound-x-request-id-and-tenant-header) |
| `http.tenantIdResolver`        | `(req) => string \| undefined` | none                                                                     | Resolves the tenant id on the server side. When given it is the only source and the header is not read                                                                                                               |

### `otel` options

| Option                              | Type                          | Default        | Description                                                                                          |
| ----------------------------------- | ----------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `otel.shouldAutoInjectTraceContext` | `boolean`                     | `true`         | Detect `@opentelemetry/api` and inject `traceId`/`spanId` via Pino mixin                             |
| `otel.fieldFormat`                  | `'camelCase' \| 'snake_case'` | `'camelCase'`  | Field names in log entries: `traceId`/`spanId` vs `trace_id`/`span_id`                               |
| `otel.traceIdField`                 | `string`                      | `'traceId'`    | Field name for the trace ID; `fieldFormat: 'snake_case'` derives `trace_id` unless this is set       |
| `otel.spanIdField`                  | `string`                      | `'spanId'`     | Field name for the span ID; `fieldFormat: 'snake_case'` derives `span_id` unless this is set         |
| `otel.traceFlagsField`              | `string`                      | `'traceFlags'` | Field name for the trace flags; `fieldFormat: 'snake_case'` derives `trace_flags` unless this is set |

### Options from a class

`forRootAsync` accepts a class that produces the options, for when they depend on a provider already in the DI graph. It implements `BymaxLoggerModuleOptionsFactory`; pass it as `useClass` (the module instantiates it) or `useExisting` (an instance another module provides). `createLoggerOptions()` may return the options or a promise of them.

For example, `createLoggerOptions()` can return `{ service: { name: this.cfg.getOrThrow('OTEL_SERVICE_NAME'), version: this.cfg.getOrThrow('RELEASE_SHA') } }`, registered with `forRootAsync({ imports: [ConfigModule], useClass: LoggerOptionsFactory })`.

---

## 🌐 HTTP Logging

Set `http.isEnabled: true`, then wire the access log with `applyAccessLog(app)` in `main.ts` (recommended, see below) or `applyRequestIdMiddleware(consumer)`. The access log is recorded from **middleware** and emits six `HTTP_REQUEST_*` keys; the exception filter adds the last two:

| Log key                     | When                                                |
| --------------------------- | --------------------------------------------------- |
| `HTTP_REQUEST_START`        | Request received                                    |
| `HTTP_REQUEST_SUCCESS`      | 2xx response                                        |
| `HTTP_REQUEST_REDIRECT`     | 3xx response                                        |
| `HTTP_REQUEST_CLIENT_ERROR` | 4xx response                                        |
| `HTTP_REQUEST_SERVER_ERROR` | 5xx response                                        |
| `HTTP_REQUEST_ABORTED`      | Connection closed before the response was delivered |
| `HTTP_EXCEPTION_HANDLED`    | `HttpException` caught by the filter                |
| `HTTP_EXCEPTION_UNHANDLED`  | Unexpected error caught by the filter               |

`HTTP_REQUEST_START` is emitted **before guards**, so it carries no `userId`: authentication runs in a guard and there is no principal yet. The acting user is on the terminal entry. Both entries carry the same `requestId`.

URLs are normalized (`/users/550e8400-e29b-41d4-a716-446655440000` becomes `/users/:id`) so label cardinality stays bounded. The **query string is stripped** from every logged URL and from the message of a logged exception, because a magic-link token in a query parameter is a secret no key-name redaction can scrub out of a string. Only a literal `?` starts a query: a secret placed in the path itself (`;jsessionid=...`, a token segment) stays in `url`.

For a body that does not parse (`entity.parse.failed`), one the parser's `verify` refuses (`entity.verify.failed`), or an unsupported content encoding or charset, `HTTP_EXCEPTION_HANDLED` carries a fixed message and the parser `type` in `bodyParserType`, because the parser's message can quote part of the body. The response the client receives is the application's concern. The malformed-JSON case needs the Express adapter and a body parser mounted before `app.init()`, as Nest's default one is; with another adapter, or a parser mounted after `app.init()`, that entry keeps the parser's message.

> [!IMPORTANT]
> **Why middleware and not an interceptor.** NestJS runs middleware → guards → interceptors → handler, so an interceptor never sees a request a guard rejected or one that matched no route. Measured against a real backend, 401, 403, 429 and 404 produced no log line at all, which hid brute force and route enumeration. Without the middleware wiring, the interceptor-based behaviour remains, blind spot included.

### Requests rejected before routing

NestJS registers the body parser one line **before** it registers module middleware, so when the parser rejects a body (truncated JSON, a payload over the limit, an unsupported content type) every later handler is skipped. Through `configure(consumer)` that request produces:

| Wiring                                                 | A body the parser rejects produces                        |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `forRoot` with `shouldCaptureExceptions` (the default) | **one** `HTTP_EXCEPTION_HANDLED` line, **no `requestId`** |
| `forRootAsync`, or `shouldCaptureExceptions: false`    | **nothing at all**                                        |

`applyAccessLog(app)` closes both rows. `INestApplication.use()` delegates to the HTTP adapter and `init()` (where the parser is registered) has not run yet, so mounting from `main.ts` lands ahead of the parser, the same way `helmet` and `cookie-parser` are mounted:

```typescript
// main.ts
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, applyAccessLog } from '@bymax-one/nest-logger'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  BymaxLoggerModule.useNestLogger(app)

  // BEFORE the app initializes. init() is where the parser is mounted, and
  // listen() only triggers init() when you have not called it yourself — so a
  // serverless entry point or a test that does `await app.init()` first must
  // mount before THAT, not merely before listen().
  applyAccessLog(app)

  await app.listen(3000)
}

void bootstrap()
```

Mount it **before** `app.init()`: a serverless entry point or a test that calls `await app.init()` first must mount before that, not merely before `listen()`. The access log emits from the response's `'close'` event, so it needs no route match, handler or filter: one line in and one line out for a parser rejection, an unmatched-route 404, a guard rejection and an aborted connection alike.

To open only the correlation scope ahead of the parser, without the access log, call `BymaxLoggerModule.useRequestContext(app)` at the same point. A request the parser refuses then has its `requestId` and the `x-request-id` response header, so an exception filter that reads the id from `LogContextService` can put the same value in its envelope. Register such a filter with `app.useGlobalFilters(...)`, which answers ahead of every `APP_FILTER` provider. Where the library's own filter is registered (`forRoot` with `http.isEnabled`), the import order of modules decides between `APP_FILTER` providers: one in a module imported before `BymaxLoggerModule` was answered by the library's filter in the measurement, one imported after it answered itself.

`applyRequestIdMiddleware(consumer)` remains supported and suits correlation scoped to a route subtree. Wiring both is safe: the correlation middleware adopts an id already in scope and the access log stands down when the lifecycle is already claimed, so nothing is minted or logged twice.

**Delivery is reported separately from status.** `HTTP_REQUEST_ABORTED` is emitted when the connection closed before the response was flushed, and it keeps the real status the server produced rather than inventing one (`499` is not an HTTP status). A fast handler whose client hangs up after the bytes were flushed is reported as the success it was; whether the peer read it is not knowable server-side.

### Unexpected errors behind `@bymax-one/nest-core`

When nest-core's exception filter answers, an unexpected error becomes a fixed `500 BYMAX_INTERNAL_ERROR`, and the access-log line carries the cause only if this package's interceptor saw the error (not for an error raised in a guard or a middleware, or with HTTP logging off). With nest-core 1.6.2 or later, bind `PinoUnexpectedErrorSink` to its `BYMAX_UNEXPECTED_ERROR_SINK` token from a global module:

```typescript
import { Global, Module } from '@nestjs/common'
import { BYMAX_UNEXPECTED_ERROR_SINK } from '@bymax-one/nest-core'
import { PinoUnexpectedErrorSink } from '@bymax-one/nest-logger'

@Global()
@Module({
  providers: [{ provide: BYMAX_UNEXPECTED_ERROR_SINK, useClass: PinoUnexpectedErrorSink }],
  exports: [BYMAX_UNEXPECTED_ERROR_SINK]
})
export class UnexpectedErrorSinkModule {}
```

Import it next to `BymaxLoggerModule`. The binding resolves `PinoLoggerService` because that module is global by default; with `isGlobal: false`, add the same `forRoot`/`forRootAsync` result to the sink module's `imports`, kept in a constant (a second `forRoot` call builds a second logger). Each unexpected error then produces one `error` entry with the key `HTTP_UNEXPECTED_ERROR`:

| Field           | Content                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `err`           | The original error through the `err` serializer: type, message, scrubbed stack, cause chain, own fields |
| `method`        | HTTP method                                                                                             |
| `route`         | Matched route template (`/invoices/:id`), or `<unmatched>` before routing — never the raw URL           |
| `correlationId` | nest-core's correlation id, when one resolved                                                           |

The sink adds no body, headers or query string. The error is serialized as on every `err` entry, own fields included, so an error that itself carries request data brings it along, under the same key-name redaction. `record()` never throws, so a failing destination cannot change the response. This package does not import nest-core: the class matches its contract by shape, and `IUnexpectedErrorSink` and `UnexpectedErrorReport` are exported for reference.

---

## 🔭 OpenTelemetry Correlation

Initialize the OTel SDK **before** importing NestJS:

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

Once active, every entry carries `traceId`, `spanId` and `traceFlags`. The logger **observes** the trace context: it never creates spans, installs a context manager or parses `traceparent`. With the API present but no active span, no identifiers are emitted.

**Without OpenTelemetry installed, none of this happens** and there is no error or per-entry warning. The one reported misconfiguration is trace injection enabled while `@opentelemetry/api` cannot be resolved: a single `LOGGER_BOOTSTRAP_WARNING` with reason `OTEL_API_UNAVAILABLE` at startup, because a missing `traceId` would otherwise look like "no active span". The peer is resolved from the library's own module path, falling back to `process.cwd()`, so a Docker `WORKDIR`, a hoisted workspace or a monorepo started at its root does not switch correlation off.

## 🧭 Resource, Events and Errors

### Resource identity

Every entry carries the service identity, using attributes that are **Stable** in Semantic Conventions v1.44.0:

```typescript
BymaxLoggerModule.forRoot({
  service: {
    name: 'checkout-api', // service.name
    version: '2.14.3', // service.version
    namespace: 'payments', // service.namespace
    instanceId: process.env.POD_UID!, // service.instance.id
    environment: 'production' // deployment.environment.name
  }
})
```

```json
{
  "level": "info",
  "time": "2026-08-13T10:00:00.000Z",
  "service": {
    "name": "checkout-api",
    "version": "2.14.3",
    "namespace": "payments",
    "instance": { "id": "pod-7f3a" }
  },
  "deployment": { "environment": { "name": "production" } },
  "logKey": "PAYMENT_FAILED",
  "event.name": "payment.failed",
  "msg": "Payment failed"
}
```

Set `resourceFormat: 'flat'` to emit the dotted names verbatim (`"service.instance.id": "pod-7f3a"`), which is what a collector mapping log fields onto resource attributes reads directly. The deprecated `deployment.environment` spelling is never emitted.

Values resolve once at startup, in this order: explicit `service` options, then `OTEL_SERVICE_NAME` (name only), then `OTEL_RESOURCE_ATTRIBUTES` (`service.namespace=payments,service.version=2.14.3,…`), then `NODE_ENV` (environment only). The order of the two OpenTelemetry variables is the specification's. Reading the variables the SDK reads makes logs and traces agree without depending on the SDK.

> [!IMPORTANT]
> **`service.instance.id` is never generated.** A UUID minted by the logger would not be the OpenTelemetry Resource's, so logs and traces would claim different instances of one process. Supply it from the platform (Kubernetes pod UID, ECS task ARN) or through `OTEL_RESOURCE_ATTRIBUTES`. There is no `OTEL_SERVICE_VERSION` variable in the specification.

### Event names

Structured entries carry a machine-readable name derived from `logKey`, lowercase and dot-namespaced (`PAYMENT_FAILED` → `payment.failed`, `USER_AUTHENTICATION_FAILED` → `user.authentication.failed`). `logKey` itself is never renamed. Calls through the NestJS variadic bridge (`logger.log`, `logger.warn`) carry no log key and get no event name. Keep names low cardinality: identifiers belong in their own fields.

The value is meant for the **`EventName`** field of an OpenTelemetry LogRecord; the same-named `event.name` attribute is deprecated. A JSON line cannot express that distinction, so the carrier key is configurable through `eventNameField` and your collector decides where it lands. `eventNameField: false` emits nothing.

### Error fields

`errorFormat` controls the shape:

```json
// errorFormat: 'pino'  (default)
{ "err": { "type": "PaymentDeclined", "message": "card declined", "stack": "…",
           "cause": { "name": "Error", "message": "gateway timeout" } } }

// errorFormat: 'both'  (adds the semconv fields beside err)
{ "err": { "type": "PaymentDeclined", … },
  "exception.type": "PaymentDeclined",
  "exception.message": "card declined",
  "exception.stacktrace": "…",
  "error.type": "PaymentDeclined" }

// errorFormat: 'semconv'  (err is removed)
{ "exception.type": "PaymentDeclined", "exception.message": "card declined",
  "exception.stacktrace": "…", "error.type": "PaymentDeclined" }
```

All four attributes are **Stable**. `error.type` carries the class name, so it stays low cardinality. `Error.cause` chains are preserved (depth- and width-bounded, circular-safe, redacted like any field) and `AggregateError` members reach the entry as `err.errors`. There is no OpenTelemetry attribute for a cause chain, so these stay under `err`.

An error's own enumerable properties (`code`, `statusCode`, domain fields) travel with it at every depth, including on a nested `cause` and each `AggregateError` member, and pass through the same name-based redaction and size bound as any serializer output. They never shadow a field the serializer derives. Exceptions: the arguments of a failed driver call are not written (`args` and `parameters` are omitted, a `command` object is reduced to its `name`, and an error with a SQLSTATE `code` loses `detail`, `where` and `internalQuery`, which quote the row and the statement), because redaction matches key names and cannot see a value inside a string.

**`errorOwnFields`.** Node's own errors carry values: a failed child process has `stdout` and `stderr`, an `AssertionError` its `actual` and `expected`, a file system error its `path`. A list of names to drop cannot name them all, so the choice is yours:

- `'all'` (the default in 1.x) writes every own field as above.
- `'safe'` (recommended) writes only `code`, `errno`, `syscall`, `signal`, `status`, `statusCode`, `address`, `port`, `hostname` and the PostgreSQL `constraint`, `table`, `column`, `schema` and `routine`, plus the names in `errorOwnFieldNames` (matched exactly), at every depth. `path` is not on the list; add it if a path is not data to you. Under `'safe'` an `Error` is written from its own fields and its `toJSON` is not called (an HTTP client's `toJSON` may carry the request); any other `toJSON` is called once, as `JSON.stringify` would, and its result is censored. A serializer then receives a plain error-like object instead of an `Error` instance.

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'api', version: '1.0.0' },
  errorOwnFields: 'safe',
  errorOwnFieldNames: ['orderId']
})
```

**Binary values.** A Buffer, typed array or `DataView` anywhere in the record is written as its size (`"[Binary 42 bytes]"`), in both modes and under both redaction strategies. If you turn every redaction off (`shouldDisableDefaultRedact: true`, no `redactPaths`, and `errorOwnFields` not `'safe'`), nothing walks the record and a Buffer is written the way Pino writes it. To log bytes on purpose, convert first, for example `buffer.toString('base64')`.

Neither setting covers the `message`: Node writes the command line of a failed child process, arguments included, into it, and redaction matches key names, not text.

When an error's properties cannot be read (a Proxy whose `ownKeys` throws, a throwing getter), none are copied and the error node carries `_errorFieldsIncomplete: true`. An `Error` that cannot be read at all does not cost the record its `logKey`, `userId` or metadata: it is replaced by its sanitized form (`name` and `message`, with the same marker), or `{ type: 'SanitizeFailed' }` when even those are unreadable. Filter on those two to find such entries.

An `Error` nested in the metadata is written as its own enumerable fields, censored by name, with `type`, `message`, `stack`, `cause` and `errors` added, bounded like the root `err` and marked `_truncated` when cut. A string `cause` is logged like a `message`: do not put secrets in either. Whatever sits under a record-root key that has a serializer (`err`, or a key of `serializers`) reaches that serializer censored by name with its `Error`s still instances, and what a serializer returns is written as returned, so an `Error` in that output stays `{}`.

## 🧵 Context Propagation

`LogContextService` holds an `AsyncLocalStorage` scope. Any entry emitted inside `logContext.run({ requestId }, callback)`, at any nesting depth, carries the scope's fields with no prop drilling. `applyAccessLog(app)` and `applyRequestIdMiddleware(consumer)` open the scope for each request; the full method list is in the API Reference.

### Inbound `x-request-id` and tenant header

The bundled `RequestIdMiddleware` does not trust the headers it reads. A request id or tenant id is accepted only when it is a string of **at most 256 characters** from `A-Z a-z 0-9 . _ : / + = -`. Anything else is replaced, never truncated or cleaned.

| Header                                    | Rejected value becomes                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `x-request-id`                            | a fresh UUID, or none when `http.shouldGenerateRequestId` is `false` (an enclosing scope's `requestId`, if any, is then inherited) |
| the tenant header (`http.tenantIdHeader`) | no `tenantId` from the header; a tenant is never minted                                                                            |

**A `tenantId` read from the header is what the client asserted.** Any client can send any tenant in `x-tenant-id`; the 256-character rule keeps the value safe to write, not true. Do not use a header-derived `tenantId` to decide whose data an entry is about unless something in front of the application sets or overwrites the header. A host that authenticates its tenants has two options:

- `http: { tenantIdHeader: false }` reads no header, so no `tenantId` is taken from the request.
- `http: { tenantIdResolver: (req) => ... }` takes the tenant from what the host trusts, for example a value an earlier middleware set after verifying a token. When given, it is the only source (the header is not read even if the resolver answers nothing), its answer passes the same rule, and a resolver that throws gives no `tenantId`. The middleware runs before guards, so a tenant known only after authentication is set later with `LogContextService.set('tenantId', ...)`.

An accepted id is echoed on the response `x-request-id` header and written to every entry of the request, which is why the accepted set is narrow.

---

## 🔑 Log Key Convention

All structured log calls use the `MODULE_ACTION_RESULT` format (`USER_LOGIN_SUCCESS`, `PAYMENT_REFUND_PROCESSED`, `WEBHOOK_STRIPE_RECEIVED`). The regex is exported from `/shared` for CI validation:

```typescript
import { LOG_KEYS_CONVENTION_REGEX } from '@bymax-one/nest-logger/shared'

function assertValidLogKey(key: string) {
  if (!LOG_KEYS_CONVENTION_REGEX.test(key)) {
    throw new Error(`Invalid log key: "${key}". Expected MODULE_ACTION_RESULT format.`)
  }
}
```

### Reserved keys

These are used by the library; do not reuse them in application code. All are exported as `RESERVED_LOG_KEYS` from `@bymax-one/nest-logger/shared`.

`LOGGER_BOOTSTRAP_OK` · `LOGGER_BOOTSTRAP_WARNING` · `LOGGER_SHUTDOWN_OK` · `HTTP_REQUEST_START` · `HTTP_REQUEST_SUCCESS` · `HTTP_REQUEST_REDIRECT` · `HTTP_REQUEST_CLIENT_ERROR` · `HTTP_REQUEST_SERVER_ERROR` · `HTTP_REQUEST_ABORTED` · `HTTP_REQUEST_COMPLETED` · `HTTP_EXCEPTION_HANDLED` · `HTTP_EXCEPTION_UNHANDLED` · `HTTP_UNEXPECTED_ERROR` · `HTTP_UNEXPECTED_ERROR_DROPPED` · `METHOD_EXECUTION` · `METHOD_SLOW_EXECUTION` · `LOGGER_DESTINATION_INIT_FAILED` · `LOGGER_DESTINATION_WRITE_FAILED` · `LOGGER_ENTRY_TRUNCATED` · `LOGGER_REDACTION_FAILED` · `LOGGER_OTEL_API_BROKEN`

`HTTP_REQUEST_COMPLETED` is reserved but never emitted: the four status-specific terminal keys already carry the same `duration`. The reserved-but-unwritten set is exported as `RESERVED_LOG_KEYS_NOT_EMITTED`, and a test asserts that every other declared key has a writer in the source.

---

## 🧩 Custom Destinations

Implement `ILogDestination` to ship logs to any sink. `write` receives the entry already serialized as a newline-terminated JSON string, so a sink that forwards lines should buffer them as they arrive and parse only where a field is needed. The [destinations guide](./docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md) has further examples (database, rolling file, stream).

```typescript
import type { ILogDestination } from '@bymax-one/nest-logger'
import type { LogEntry } from '@bymax-one/nest-logger/shared'

export class LokiDestination implements ILogDestination {
  readonly name = 'loki'
  readonly minLevel = 'info' as const

  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly labels: Record<string, string>
  // Serialized lines, not objects — `write` receives the payload already encoded.
  private buffer: string[] = []
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

  // `payload` already IS the serialized entry, newline-terminated. Buffer it as
  // it arrives; parse only where a field is genuinely needed, as `flush` does.
  write(payload: string): void {
    this.buffer.push(payload)
    if (this.buffer.length >= 100) void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0)
    const body = JSON.stringify({
      streams: [
        {
          stream: this.labels,
          values: batch.map((line) => [
            // `time` is an ISO 8601 string — parse it to epoch ms, then scale to
            // the nanoseconds Loki expects. `BigInt(entry.time)` throws on an ISO string.
            String(BigInt(Date.parse((JSON.parse(line) as LogEntry).time)) * 1_000_000n),
            line.trimEnd()
          ])
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

### Destinations replace stdout

A non-empty `destinations` **replaces** `DefaultStdoutDestination`, so a file-only or socket-only deployment can turn structured stdout off. To keep stdout beside a custom sink, list it explicitly: `destinations: [new DefaultStdoutDestination(), new LokiDestination({ ... })]`.

A sink you supply may be the only one the application has, so two guarantees cover its failure: a destination that fails `onInit` is reported as `LOGGER_DESTINATION_INIT_FAILED` on `stderr` (not through the logger, whose sinks just failed) and receives no entries, and if **every** destination fails to initialize, entries fall back to raw NDJSON on `stdout`. Adding `new PrettyDevDestination()` without the optional `pino-pretty` therefore costs colours and a line on stderr, never your logs.

### Choosing how the dev terminal renders

`PrettyDevDestination` takes a `view`; every field defaults to the previous rendering, so `new PrettyDevDestination()` is unchanged. The default view is verbose (one entry can be seven lines).

```typescript
// One line per entry, with the fields your project repeats on every line hidden.
new PrettyDevDestination({
  view: { singleLine: true, ignore: 'pid,hostname,service,deployment,event\\.name' }
})

// Message only, with the context pulled back into the line.
new PrettyDevDestination({
  view: { hideObject: true, messageFormat: '[{context}] {msg}' }
})
```

| Field           | Default                  | Notes                                                                        |
| --------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `singleLine`    | `false`                  | The single biggest change to how a terminal reads                            |
| `ignore`        | `'pid,hostname,service'` | Display-only — what a real sink receives is untouched                        |
| `hideObject`    | `false`                  | Hides the record entirely; see the caveat below                              |
| `messageFormat` | —                        | e.g. `'[{context}] {msg}'`; how to keep one field visible under `hideObject` |
| `translateTime` | `'SYS:HH:MM:ss.l'`       | Or `false` for the raw timestamp                                             |
| `colorize`      | `true`                   | ANSI colour                                                                  |

- **`hideObject` hides fields from this destination only.** Other destinations still receive the complete entry. When pretty is your only destination nothing else holds the entry, because `destinations` replaces stdout; use `messageFormat` to pull a field back.
- **A dot in `ignore` means a nested path.** `event.name` is a literal top-level key, so it must be escaped (`'event\\.name'` in a TypeScript string) or nothing is hidden. `service` and `deployment` are real nested objects and need no escape.
- **`messageFormat` interpolates every placeholder except `{msg}` raw.** The library normalizes line separators and control characters in `msg` and the stack, never in metadata, so a newline in an interpolated field splits one entry into two and the second can read like a genuine record. Interpolate only fields your own code sets, never one carrying user input (`{tenantId}`, `{userId}`, a header).
- **`destination` is not exposed, by design.** The library owns where entries go; a redirected stream would route around the fan-out and the last-resort rescue.

The view type is exported as `PrettyViewOptions`. It is this library's own interface, so type-checking works without the optional peer installed. Entries emitted before `onInit` (while Nest instantiates providers) are buffered and then rendered in order; if the peer is missing, the bound is reached or the app shuts down first, they are written as raw NDJSON, never dropped.

---

## 🏗️ Architecture

```
HTTP Request
    │
    ▼
RequestIdMiddleware             ← runs first; opens the AsyncLocalStorage scope
    │                              { requestId, tenantId }
    ▼
HttpAccessLogMiddleware         ← emits HTTP_REQUEST_START in that scope and arms the
    │                              terminal entry on the response's 'close' event,
    │                              BEFORE guards, so a 401/403/429 is logged too
    ▼
Guards (consumer's auth)        ← may reject here; no interceptor ever runs
    │
    ▼
HttpLoggingInterceptor          ← records the thrown error for the terminal entry
    │
    ▼
Application Service
    │
    └── PinoLoggerService.info(logKey, message, userId?, metadata?)
              │
              ▼
         Pino logger
              │
         createTraceContextMixin()  ← per entry
              ├── ALS store      → { requestId, tenantId, userId }
              └── OTel span      → { traceId, spanId, traceFlags }
              │
              ▼
         name redactor           ← one recursive walk, any depth
              │
              ▼
    ┌─────────────────────────────┐
    │  DefaultStdoutDestination   │  ← default; replaced by `destinations`
    │  your ILogDestination(s)    │
    └─────────────────────────────┘
```

Providers are singletons: `AsyncLocalStorage` delivers per-request context without `Scope.REQUEST`. ALS context and the OTel span merge into one mixin in a fixed order (ALS first, then OTel, so an active span wins a conflict).

---

## 🔐 Security Model

A logger sees every payload the application handles, so the security posture is about what **never** reaches the sink, and about a sink failure never reaching the application.

### Redaction by default

The library censors **32 sensitive field names** wherever they appear in a record: down to 100 levels of nesting, inside arrays and inside class instances. Past that ceiling a nested object is dropped rather than emitted, so the limit cannot become a leak.

| Category                  | Fields                                                                                                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP auth headers         | `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`                                                                                                                                                                                      |
| Passwords                 | `password`, `passwordHash`, `passwordConfirm`, `newPassword`, `oldPassword`                                                                                                                                                                               |
| Tokens                    | `token`, `accessToken`, `refreshToken`, `idToken`, `apiKey`, `apiSecret`                                                                                                                                                                                  |
| MFA                       | `mfaSecret`, `mfaRecoveryCodes`, `totpSecret`                                                                                                                                                                                                             |
| Generic secrets           | `secret`, `clientSecret`, `signingSecret`, `privateKey`                                                                                                                                                                                                   |
| Payment / PCI DSS         | `cardNumber`, `cardCvv`, `cvv`, `cvc`, `cardExpiry`                                                                                                                                                                                                       |
| Personal documents (LGPD) | `cpf`, `cnpj`, `rg`                                                                                                                                                                                                                                       |
| Conservative PII          | `email`                                                                                                                                                                                                                                                   |
| HTTP headers (absolute)   | `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-api-key"]`, `req.headers["x-auth-token"]`, `res.headers["set-cookie"]` — retained for the legacy `'paths'` strategy; the by-name row above already covers these shapes and every other |

Redaction is one **recursive, snapshotting walk**: a value is censored when its key name is in the set, wherever it sits. Nothing the caller passed is mutated, and every value is read once and pinned into a fresh structure, so what reaches the sink is what was inspected even when the payload carries accessors or a `toJSON` that could answer differently on a second read. A value with a `toJSON` is inspected through that method's output; when the source object itself carries a sensitive key, the method is not trusted and the whole value is censored, because a method could rename what it exposes. `DEFAULT_REDACT_PATHS` is still exported at full fidelity, and `redactStrategy: 'paths'` feeds it to `fast-redact` for anyone depending on exact path semantics, with a four-level ceiling and roughly 100× the cost.

> [!WARNING]
> Redaction matches **key names**. A secret under a name you have not declared sensitive is emitted: `logger.log(key, msg, userId, { renamed: user.password })` writes it in clear, and so does a `toJSON` that renames nested state. No name matcher can follow a value through a rename. Declare the name, or keep the value out of the log.

**One entry, one line.** Every message argument passes through a normalization before it reaches Pino: line separators (`\r`, `\n`, U+2028, U+2029, U+0085) become the two-character sequence `\n`, and every other control character that can drive a terminal (ESC, vertical tab, form feed, backspace, the rest of C0 except TAB, DEL and the C1 range) becomes a readable `\uXXXX` escape. This keeps a message from forging an entry in `pino-pretty` and in any destination that re-renders it, and `JSON.stringify` alone would leave DEL, C1, U+2028 and U+2029 verbatim in a raw line read in a terminal. The scrubbed stack gets the same escaping (its newlines are kept). Structured fields are untouched, so `err.message` keeps the original text, and a control character in a **metadata value** still reaches a terminal: only `msg` and the stack carry this guarantee.

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

The extra paths are **merged** with the defaults, never replacing them.

> [!IMPORTANT]
> A path's **leaf name** is also fed to the name walk, so `redactPaths: ['user.ssn']` censors `ssn` wherever it appears, not only under `user`. That is deliberate: paths are applied by Pino's stringifier, after the per-field size bound, and without this a field covered only by a path could surface inside a truncation envelope's `_preview`. An **array index is not a name**: `redactPaths: ['tokens[0]']` censors the whole `tokens` array, while the quoted form `['obj["0"]']` stays a name.

### Disabling defaults (not recommended)

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  shouldDisableDefaultRedact: true, // ⚠️ emits LOGGER_BOOTSTRAP_WARNING
  redactPaths: ['*.password'] // you own the full list
})
```

A `LOGGER_BOOTSTRAP_WARNING` is emitted on startup so security reviews can audit when PII protection was reduced on purpose.

### An append-only default list

`DEFAULT_REDACT_PATHS` is append-only by contract: a path may be added in a minor release, but removing one requires a major version. A field that silently stopped being redacted is a leak nobody would notice.

### Validated trace identifiers

The OTel mixin passes the active span's identifiers through `isValidTraceId` / `isValidSpanId` before injecting them, so a malformed or attacker-influenced value cannot reach the correlation fields your dashboards key on.

### Destination failures are contained

Every `write()` runs inside a try/catch. A destination that throws or rejects produces a `LOGGER_DESTINATION_WRITE_FAILED` line on `stderr` (never back through the logger, which would loop) and the entry is dropped for that sink only. A destination whose `onInit()` rejects is reported as `LOGGER_DESTINATION_INIT_FAILED` and removed from the fan-out and shutdown, and never blocks boot.

### What redaction covers, and what it cannot

The walk is bounded: a container nested more than 100 levels deep is written as `[REDACTION_DEPTH_EXCEEDED]`, and a call that visits more than 200000 containers writes `[REDACTION_BUDGET_EXCEEDED]` in place of each further one. A stack or message is written at most 16384 characters long and ends with `…[truncated]` when cut. A string under a metadata key is the caller's own data and is written as given: `maxEntrySizeBytes` bounds what a serializer returns, not a metadata string.

Redaction matches **field names**, not values. A secret under a covered name is censored at any depth (under the legacy `'paths'` strategy the four-level ceiling applies instead), but the same secret **embedded inside a string** under an uncovered name travels intact:

```json
{
  "password": "[REDACTED]",
  "renderedBody": "Hi Ana, your reset code is 481920. Expires in 10 minutes."
}
```

No name rule reaches the second case, and scanning values for secret-shaped text would rewrite what you asked to log. **The boundary is yours to hold:** do not put rendered bodies, raw provider responses or whole request payloads into a field, and remember that an upstream error attached as `cause` carries whatever that error carries.

`redactStrategy` governs **your** payload: the record, child bindings and the output of any serializer you supply. The built-in `err` serializer is always name-walked, even under `'paths'`, because the four-level ceiling cannot reach the depth of a `cause` chain. Under `'paths'`, an `Error` anywhere in the record is converted with the default names censored in its own fields and its `cause` chain at any depth, with your paths applied on top; non-`Error` data is matched only by the configured paths.

#### A value interpolated into the message has no name to redact

```ts
// Both identifiers are message text: there is no field for any strategy to match.
logger.warn(`reissueTokens: family revoked userId=${userId} familyId=${familyId}`)

// Same facts, as fields (logKey is yours, in MODULE_ACTION_RESULT form).
logger.warnStructured('AUTH_REUSE_DETECTED', 'token family revoked after reuse detection', userId, {
  familyId
})
```

An interpolated value has no name, so no configuration can redact it. **A value that matters is a field, not text.** A field can be redacted, queried and correlated; inside `msg` it can only be read by a human. The library cannot enforce this, because the decision is made at the call site.

### A closed pipe does not kill the process

`node app | head` closes the read end of stdout while the application is still writing. Node reports the `EPIPE` asynchronously through the stream's `'error'` event, after `write()` returned, and attaches no default handler to `process.stdout`, so the emit becomes an uncaught exception and the process dies. Every write the library makes to a process stream (default stdout sink, last-resort rescue, pre-init drain, `stderr` reports) installs a swallowing `'error'` listener on first use. The one exception is the stream `pino-pretty` writes through, which attaches listeners of its own. The side effect: the listener sits on the shared `process.stdout`, so an EPIPE raised by your own writes stops being an uncaught exception too. Your own `'error'` listener is never removed or replaced. A custom `ILogDestination` that writes to `process.stdout` should do the same; the [destinations guide](./docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md) has the pattern.

### Bounded field size

Every serializer, the default `err` one and any you supply, is wrapped so a field whose serialized JSON exceeds `maxEntrySizeBytes` (64 KB by default) is replaced by an envelope with `_truncated`, `_logKey: 'LOGGER_ENTRY_TRUNCATED'`, `_originalSize` and a 200-character `_preview`.

### Security Checklist

- `shouldDisableDefaultRedact` stays `false`; if it is on, the `LOGGER_BOOTSTRAP_WARNING` must be justified in a security review.
- Every custom field carrying a secret or personal document is added to `redactPaths` at the depths where it appears. The default list covers the standard set, not your domain's.
- `http.excludePaths` regexes are anchored and linear-time: an unbounded pattern runs on every request URL (ReDoS).
- Custom destinations never re-serialize the raw request object; they receive the already-redacted NDJSON line.
- Destination credentials (Loki, Postgres, OTLP) come from the environment, never from module options in source control.
- Log retention at the sink matches your data-retention policy: redaction bounds what is stored, not how long.

---

## 🧪 Testing & Quality

A logger runs on every request of every service that installs it, so every behavior is pinned so that a regression fails a test:

- **100% coverage** (statements, branches, functions, lines), enforced as a release gate across unit and e2e tests.
- **100% mutation score** with [Stryker](https://stryker-mutator.io/) on a cold run, with a `break` threshold of 100. The few mutants no test can kill are suppressed on the line they apply to, each with its reason (`pnpm check:mutants` proves the reasons parse). See the [report](./docs/mutation_testing_results.md).
- **No real I/O in unit tests**: Pino and every destination are mocked, and e2e tests exercise the wired module through `@nestjs/testing` and supertest.

```bash
pnpm test              # unit tests (Jest)
pnpm test:e2e          # end-to-end tests
pnpm test:cov:all      # full coverage gate
pnpm mutation          # Stryker mutation testing
pnpm typecheck && pnpm lint
```

---

## 📖 API Reference

### `PinoLoggerService`

Implements NestJS `LoggerService`. All methods are available via `@InjectLogger()`.

**Structured API** — the `MODULE_ACTION_RESULT` convention. The third parameter is the acting **`userId`**, not a context label (the context comes from `@InjectLogger(ctx)`), and it may be omitted: an ambient `userId` from the `LogContextService` scope is then used.

| Method            | Signature                         | Notes                                                            |
| ----------------- | --------------------------------- | ---------------------------------------------------------------- |
| `info`            | `(logKey, msg, userId?, meta?)`   | Structured info log                                              |
| `warnStructured`  | `(logKey, msg, userId?, meta?)`   | Structured warn log — takes a **message string**                 |
| `errorStructured` | `(logKey, error, userId?, meta?)` | Structured error log — takes an **`Error`**, serialized to `err` |

`meta` carries arbitrary fields, except that `logKey`, `userId` and `context` belong to the payload (read from the authenticated ALS scope, so a metadata bag cannot forge them) and `__proto__`, `constructor` and `prototype` are dropped, since they name a prototype chain rather than a field.

**NestJS `LoggerService` bridge** — the variadic contract NestJS calls, so `app.useLogger()` works. These take a message, not a log key.

| Method    | Signature                              | Notes                                          |
| --------- | -------------------------------------- | ---------------------------------------------- |
| `log`     | `(message, ...optionalParams)`         | → Pino `info`; trailing string is the context  |
| `warn`    | `(message, ...optionalParams)`         | → Pino `warn`                                  |
| `debug`   | `(message, ...optionalParams)`         | → Pino `debug`                                 |
| `verbose` | `(message, ...optionalParams)`         | → Pino `trace`                                 |
| `fatal`   | `(message, ...optionalParams)`         | → Pino `fatal`                                 |
| `error`   | `(message \| Error, stack?, context?)` | An `Error` routes to the serialized `err` path |

**Helpers**

| Method         | Signature    | Notes                                                             |
| -------------- | ------------ | ----------------------------------------------------------------- |
| `child`        | `(bindings)` | New `PinoLoggerService` over a Pino child logger                  |
| `setContext`   | `(context)`  | Global label — ⚠️ singleton; prefer `@InjectLogger(MyClass.name)` |
| `getRawLogger` | `()`         | The underlying Pino instance                                      |

> [!NOTE]
> There is no `fatalStructured` / `debugStructured`. Structured `fatal` and `debug` helpers are out of scope until a consumer needs them; use `getRawLogger()` in the meantime.

### `LogContextService`

| Method      | Signature           | Description                                                                                                                           |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `run`       | `(store, callback)` | Opens an ALS scope. Any log inside `callback` carries `store` fields. **A nested `run()` REPLACES the enclosing context** — see below |
| `runMerged` | `(store, callback)` | Opens a scope that EXTENDS the enclosing one: outer fields are carried in, `store` overrides them key by key                          |
| `set`       | `(key, value)`      | Adds/updates a field in the current scope. Throws if called outside `run()`. Fields set here reach every subsequent log in the scope  |
| `get`       | `(key)`             | Reads one field from the current scope, or `undefined` when unset or outside a `run()` call                                           |
| `getStore`  | `()`                | Returns current scope or `undefined` outside a `run()` call                                                                           |

**A nested `run()` discards the enclosing context.** The inner scope starts from its own `store` alone, so a field an outer scope had set (a `tenantId` resolved at the edge) is absent for the whole inner scope; nothing throws and `get()` returns `undefined`. Use `runMerged()` when the inner scope should extend the outer one. Replacement is the default because the opposite leaks worse: a background job started inside a request scope would inherit the caller's `userId` and attribute its entries to a user who never triggered it.

### Decorators

| Decorator                       | Target            | Description                                                                                                                                                                                                                           |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@InjectLogger(context?)`       | Constructor param | Injects `PinoLoggerService` pre-bound to the given context string                                                                                                                                                                     |
| `@LogContext(name)`             | Class             | **Deprecated.** Records a context label as class metadata that nothing in this package reads, so the label is never applied, and it does NOT open a `logContext.run()` scope. Use `@InjectLogger(MyClass.name)` for a per-class label |
| `@LogPerformance(thresholdMs?)` | Method            | Logs `METHOD_EXECUTION` on completion; `METHOD_SLOW_EXECUTION` if duration exceeds threshold                                                                                                                                          |

### Injection tokens and helpers

Every token is a `Symbol`, never a string, so it cannot collide with one of yours. Inject with an explicit `@Inject(TOKEN)`: the package is built without decorator metadata, and so is any consumer built the same way.

| Export                       | Provides                                                                                                                                                                                           | Use it to                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOGGER_OPTIONS_TOKEN`       | the resolved `ResolvedBymaxLoggerModuleOptions`                                                                                                                                                    | read the effective configuration, defaults applied                                                                                                            |
| `LOGGER_PINO_INSTANCE_TOKEN` | the underlying Pino instance                                                                                                                                                                       | hand it to a library that wants a Pino logger                                                                                                                 |
| `LOGGER_DESTINATIONS_TOKEN`  | the destinations array, `readonly ILogDestination[]`                                                                                                                                               | inspect what is registered; do not mutate it                                                                                                                  |
| `LOGGER_REDACTOR_TOKEN`      | the by-name redaction function, `(value: unknown) => unknown`. With `redactStrategy: 'paths'` it censors no name outside an `Error`, because Pino's path redaction then runs at write time instead | apply the module's by-name redaction to a value of your own under the default `'names'` strategy; do not treat it as a sanitization boundary under `'paths'`. |
| `LOG_CONTEXT_TOKEN`          | the `LogContextService` instance (an alias of the class)                                                                                                                                           | inject the context by token                                                                                                                                   |
| `REDACT_COMMON_FIELDS`       | the default sensitive field **names**, matched at any depth                                                                                                                                        | extend the defaults by reference instead of copying the list                                                                                                  |
| `DEFAULT_REDACT_PATHS`       | the legacy path expansion of those names                                                                                                                                                           | only with `redactStrategy: 'paths'`                                                                                                                           |
| `isValidTraceId(id)`         | `true` for 32 lowercase hex characters that are not all zeros                                                                                                                                      | apply the rule the trace mixin applies before it injects an id                                                                                                |

### Level maps (from `@bymax-one/nest-logger`)

`LogEntry.level` is the Pino string label, not the numeric code. A destination writing a numeric column converts with the exported maps:

```typescript
import { PINO_LEVEL_NAMES, PINO_LEVEL_NUMBERS } from '@bymax-one/nest-logger'

PINO_LEVEL_NUMBERS['info'] // 30   — label → numeric code
PINO_LEVEL_NAMES[30] // 'info' — numeric code → label
```

### Types (from `@bymax-one/nest-logger/shared`)

```typescript
type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

// What you CONFIGURE.
type ServiceMetadata = {
  readonly name: string
  readonly version: string
  readonly namespace?: string
  readonly instanceId?: string
  readonly environment?: string
}

// What is EMITTED: `instanceId` nests as `service.instance.id`, and the environment is not under `service`.
type EmittedServiceResource = {
  readonly name: string
  readonly version: string
  readonly namespace?: string
  readonly instance?: { readonly id: string }
  readonly [key: string]: unknown
}

type EmittedDeploymentResource = { readonly environment: { readonly name: string } }

type LogEntry = {
  /** Pino string label — `'info'`, not `30`. Convert with `PINO_LEVEL_NUMBERS`. */
  level: LogLevel
  /** ISO 8601 UTC string — `Date.parse(entry.time)` for epoch milliseconds. */
  time: string
  msg: string
  logKey?: string
  /** Present under `resourceFormat: 'nested'` (the default). */
  service?: EmittedServiceResource
  /** Present when an environment resolved — `deployment.environment.name`. */
  deployment?: EmittedDeploymentResource
  /** Derived from `logKey` unless `eventNameField: false`. */
  'event.name'?: string
  context?: string
  requestId?: string
  tenantId?: string
  userId?: string
  traceId?: string
  spanId?: string
  [key: string]: unknown
}
```

Under `resourceFormat: 'flat'` there is no `service` object: the values arrive as dotted top-level keys (`"service.instance.id"`), which the index signature admits.

### `ILogDestination`

```typescript
interface ILogDestination {
  readonly name: string
  readonly minLevel?: LogLevel
  /** `payload` is a newline-terminated JSON entry, UTF-8 encoded — not an object. */
  write(payload: string): void | PromiseLike<void>
  onInit?(): void | PromiseLike<void>
  /** Called once after EVERY destination's `onInit` settled. Only useful if you buffer. */
  onRegistryReady?(status: {
    readonly heldEntriesDeliveredElsewhere: boolean
  }): void | PromiseLike<void>
  onShutdown?(): void | PromiseLike<void>
}
```

---

## 🚨 Error Code Catalog

Two kinds of failure, and they surface differently. A **thrown `Error`** carries no code string: it carries a message prefixed with the emitting class, which is what you match on. A **log key** is a code you can filter on: it is written to `stderr` as a structured line, or into the envelope as `_logKey`.

### Thrown errors

| Message starts with                                      | Thrown from                                 | When                                                                                    | Action                                                                    |
| -------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `[BymaxLoggerModule] options.`                           | `forRoot` / `forRootAsync`, at module setup | any option fails validation: a missing `service`, a `level` outside the set, a bad type | Fix the option the message names; it prints the path and what it received |
| `[BymaxLoggerModule] useNestLogger(app) called but`      | `BymaxLoggerModule.useNestLogger`           | the module was never imported into the application                                      | Import `BymaxLoggerModule` before calling it                              |
| `[BymaxLoggerModule] applyAccessLog(app) called but`     | `applyAccessLog`                            | the module was never imported into the application                                      | Import `BymaxLoggerModule` before calling it                              |
| `[BymaxLoggerModule] useRequestContext(app) called but`  | `useRequestContext`                         | the module was never imported into the application                                      | Import `BymaxLoggerModule` before calling it                              |
| `[PrettyDevDestination] pino-pretty is not installed`    | `PrettyDevDestination.onInit`               | the destination is registered and resolving `pino-pretty` itself fails                  | Install `pino-pretty` or drop the destination                             |
| `[PrettyDevDestination] pino-pretty failed to start`     | `PrettyDevDestination.onInit`               | `pino-pretty` is found but importing it or building the transform throws                | Read the message and the error's `cause`: it is the real failure          |
| `[PrettyDevDestination] refused in production`           | `PrettyDevDestination.onInit`               | `NODE_ENV` is exactly `production`                                                      | Use `DefaultStdoutDestination` in production                              |
| `[LogContextService] set() called outside run() scope`   | `LogContextService.set`                     | called with no active `run()`                                                           | Wrap the work in `logContext.run({ ... }, () => ...)`                     |
| `[LogContextService] Refusing to set unsafe context key` | `LogContextService.set`                     | the key is `__proto__`, `constructor` or `prototype`                                    | Use an ordinary key                                                       |

The `PrettyDevDestination` errors are thrown inside `onInit`, which the registry contains: the boot continues and the failure is reported as `LOGGER_DESTINATION_INIT_FAILED` below.

### Log keys

| Code                              | Surfaces as                                              | When                                                                                                 | Action                                                                                                                      |
| --------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `LOGGER_DESTINATION_INIT_FAILED`  | NDJSON line on `stderr`                                  | `destination.onInit()` throws or rejects                                                             | Sink is removed from the write fan-out and shutdown; boot continues                                                         |
| `LOGGER_DESTINATION_WRITE_FAILED` | NDJSON line on `stderr`                                  | `destination.write()` throws or rejects                                                              | Entry dropped for that destination; others continue                                                                         |
| `HTTP_UNEXPECTED_ERROR_DROPPED`   | NDJSON line on `stderr`                                  | `PinoUnexpectedErrorSink` could not log a report (the logger threw, or the report could not be read) | The report is dropped; the line names why. The response is unaffected                                                       |
| `LOGGER_OTEL_API_BROKEN`          | NDJSON line on `stderr`, once                            | `@opentelemetry/api` is installed but throws while loading, or exports no usable `trace` namespace   | Reinstall it, or turn `otel.shouldAutoInjectTraceContext` off; until then `traceId` and `spanId` are absent                 |
| `LOGGER_BOOTSTRAP_WARNING`        | log entry with `reason: 'OTEL_API_UNAVAILABLE'`          | `otel.shouldAutoInjectTraceContext` is on and `@opentelemetry/api` cannot be resolved                | Install `@opentelemetry/api`, or turn the option off; until then `traceId` and `spanId` are absent                          |
| `LOGGER_ENTRY_TRUNCATED`          | `_logKey` in the envelope                                | a serialized field exceeds `maxEntrySizeBytes`                                                       | Reduce the payload or raise the ceiling                                                                                     |
| `LOGGER_REDACTION_FAILED`         | `_logKey` in the envelope, with `_redactionFailed: true` | a record cannot be walked by the redactor (a throwing getter, a hostile proxy in the metadata)       | The record is dropped whole, never partly emitted; the message and ambient context stay. Find the value that broke the walk |

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

Measured by this repository's own benchmark (`pnpm bench`, see [bench/README.md](./bench/README.md)) on the shipped configuration, which is what `forRoot({ service })` builds with nothing else set: name-walk redaction and the composed ALS/OTel mixin, inside an active request context, writing to a no-op sink.

- **About 274,000 entries/s** through the full production path, which retains 0.345× of the throughput of the bare wrapper (no redaction, no mixin) measured the same way.
- The legacy `redactStrategy: 'paths'` measures about 7,900 entries/s in the same bench.

Absolute figures depend on the machine; the benchmark gates the ratio so a regression fails CI.

---

## 🚫 What This Library Does NOT Do

- ❌ **OTel SDK initialization** — consumer's responsibility in `main.ts`
- ❌ **Custom metrics** (OTel Metrics API) — use `@opentelemetry/api` directly
- ❌ **Alerting** — configure your OTLP backend
- ❌ **Log aggregation UI** — Grafana, Datadog, Honeycomb
- ❌ **Sentry SDK** — install `@sentry/node` in the consumer if desired
- ❌ **Immutable audit logs**
- ❌ **File rotation built in** — write a destination on `pino-roll` (see the [destinations guide](./docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md))
- ❌ **Fastify** — the HTTP integration targets the Express adapter (`@nestjs/platform-express`)
- ❌ **`pino-http`** — `HttpLoggingInterceptor` is a NestJS-native replacement; running both produces duplicate logs

---

## 🤝 Contributing

Development follows the Bymax coding standards: TypeScript strict (`noImplicitAny`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), a 100% coverage gate, Conventional Commits (commitlint + husky), peer dependencies only, boolean identifiers prefixed `is`/`has`/`should`/`can`, and log keys in `MODULE_ACTION_RESULT` form.

```bash
git clone https://github.com/bymaxone/nest-logger.git
cd nest-logger
pnpm install
pnpm test && pnpm typecheck && pnpm build
```

---

## 🔒 Security Policy

If you discover a security vulnerability, please **do not** open a public issue. Email **support@bymax.one** with details.

---

## 📄 License

[MIT](./LICENSE) © [Bymax One](https://github.com/bymaxone)

---

<p align="center">
  <sub>Built with ❤️ by <a href="https://github.com/bymaxone">Bymax One</a></sub>
</p>
