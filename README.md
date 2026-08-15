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

`@bymax-one/nest-logger` replaces ad-hoc `console.log` and legacy Winston setups with a production-grade structured logging pipeline. Every log entry is a JSON object carrying a `logKey` (`MODULE_ACTION_RESULT` convention), `requestId`, `tenantId`, and — when OpenTelemetry is active — the correlated `traceId`/`spanId`.

**Why Pino?** At ~750,000 logs/sec (vs Winston's ~110,000), Pino consumes 3× less CPU and half the RSS under load. The difference is measurable in production billing/payments backends where the logger is on the hot path for every request.

The library has **zero direct dependencies** — all packages arrive as peer dependencies, so you control exact versions and the supply chain surface stays minimal.

### Why nest-logger?

- **🎯 One module, the whole pipeline** — Logger service, HTTP interceptor, exception filter, context propagation, redaction, and destinations arrive in a single `forRoot()`. No gluing together `pino-http`, a redaction layer, and a transport by hand.
- **🔌 Your sinks, your rules** — The library defines `ILogDestination`. You implement it for Loki, Postgres, a rolling file, or anything else. No vendor lock-in, no hidden transport dependencies.
- **🔒 Redacted by default** — 32 sensitive field names are censored **down to 100 levels of nesting**, covering passwords, tokens, PCI DSS card data, MFA secrets, LGPD documents and credential-bearing HTTP headers. One recursive walk per entry, not a path list. Domain-specific names are yours to add via `redactPaths`.
- **⚡ On the hot path, so it stays cheap** — Singleton providers, one composed Pino mixin, and a single-pass redactor. No `Scope.REQUEST`, no path matching.
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
- ✅ **Pretty-Print in Dev** — opt-in `PrettyDevDestination` with a configurable `view` (single-line, hidden fields, message-only) for readable local output (requires optional `pino-pretty`)
- ✅ **Field Size Guard** — a serialized field over the ceiling (default 64 KB) is replaced by a compact truncation envelope instead of flooding the sink

### 🛡️ Security & Privacy

- ✅ **PII Redaction by Default** — 32 field names censored wherever they appear, to a 100-level nesting ceiling past which nested objects are dropped, in a single snapshotting walk
- ✅ **PCI DSS & MFA Coverage** — card data and MFA secrets redacted out of the box, with common HTTP auth headers
- ✅ **LGPD-Aware Paths** — CPF, CNPJ, and RG redacted by default for Brazilian workloads
- ✅ **Append-Only Redact List** — `DEFAULT_REDACT_PATHS` never shrinks without a major version; extend it via `redactPaths`
- ✅ **Validated Trace IDs** — OTel identifiers pass `isValidTraceId` before injection, never raw user input

### 🔍 Observability & Context

- ✅ **OpenTelemetry Correlation** — optional `@opentelemetry/api` peer; injects `traceId`/`spanId`/`traceFlags` into every log via a Pino mixin when an active span is detected. Resolution is anchored at the library's own module path, so a Docker `WORKDIR`, a pnpm workspace or a monorepo launched from the repo root cannot silently switch correlation off
- ✅ **Stable Resource Identity** — `service.name`/`.namespace`/`.version`/`.instance.id` and `deployment.environment.name`, all **Stable** in Semantic Conventions v1.44.0, resolved from one deterministic precedence shared with the OTel SDK
- ✅ **Semconv Error Fields** — opt-in `exception.type`/`.message`/`.stacktrace` and low-cardinality `error.type`, additive beside the legacy `err.*`, with full `Error.cause` chains
- ✅ **Machine-Readable Event Names** — `event.name` derived from `logKey` following OTel naming rules
- ✅ **AsyncLocalStorage Context** — `requestId`, `tenantId`, `userId` flow automatically through the request lifecycle without prop drilling
- ✅ **HTTP Access Log, before guards** — logs every request including the ones an interceptor cannot see (401/403/429 guard rejections, 404 unmatched routes), with URL normalization (UUIDs and numeric IDs replaced by `:id`) and the query string stripped
- ✅ **Exception Filter** — captures NestJS `HttpException` and unexpected errors with structured output

### 🔌 Destinations

- ✅ **Pluggable Destinations** — implement `ILogDestination` to ship logs to Loki, Postgres, rolling files, or any sink
- ✅ **Managed Lifecycle** — `onInit()` / `onShutdown()` hooks; a destination that fails `onInit()` is reported and excluded from shutdown, and boot is never aborted
- ✅ **Crash-Proof Writes** — every `write()` is wrapped in a try/catch; a failure is reported on `stderr` and swallowed, never propagated to the app

### 🧩 Developer Experience

- ✅ **Zero Runtime Dependencies** — everything arrives as a peer dependency, so you control versions and supply-chain surface
- ✅ **2 Subpath Exports** — `.` for the NestJS server API, `./shared` for zero-dependency types and constants
- ✅ **Dynamic Module** — configure via `forRoot()` or `forRootAsync()`, sensible defaults included
- ✅ **Strict TypeScript** — `strict: true`, no `any` in production code, JSDoc on every public export
- ✅ **100% Coverage + Mutation Tested** — statements, branches, functions, and lines gated at 100%, with Stryker as the deeper gate

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

> ⚠️ **Under pnpm, `-D` may not make it absent in production — measure, do not assume.** Two
> consumers who had assumed otherwise measured the peer **present** in their real production images,
> by two different build routes: `pnpm prune --prod` keeps the store entry, and a clean
> `pnpm install --prod --frozen-lockfile` in a fresh stage installs it too. In both, the peer was
> recorded in the lockfile. `PrettyDevDestination` imports it lazily, relative to the library's own
> directory under `.pnpm/`, where it is a sibling — so it resolves.
>
> That is two measurements, not a law of pnpm: whether a production install always carries an optional
> peer, however the lockfile was produced, has not been tested here. The advice below does not depend
> on it.
>
> The clean-install case is worth stating separately, because "we do a fresh prod install, not a
> prune" reads like an exemption and is not one. It is what one of those consumers concluded before
> measuring their own image.
>
> **On other package managers this is different**, and the difference cuts the other way: under npm's
> or yarn's flat `node_modules`, a pruned devDependency really is gone. If you install with those,
> do not read this warning as universal.
>
> Either way, the rule that survives both layouts: **"it is a devDependency, therefore this path
> cannot run in production" is not a safe premise, because the premise is about someone else's
> install command.** A `PrettyDevDestination` left registered in production will not crash and will
> not warn — it renders ANSI colour into a log pipeline that has silently failed to parse every line
> since the deploy, which is indistinguishable from a service that went quiet. Gate it on an explicit
> configuration value you can see, not on the packaging.

> [!NOTE]
> `@opentelemetry/api` is resolved lazily when the Pino instance is built. When it is absent the trace mixin silently steps aside — the logger never fails to start, and never warns, over an optional peer.

> [!NOTE]
> The published declarations depend on no HTTP framework's types. The HTTP interceptor, the exception filter and the request-id middleware are typed by structural contracts (`LoggableRequest`, `LoggableResponse`, `NextHandler`) that an Express request and response satisfy as-is, so nothing extra is needed even when you compile with `skipLibCheck: false`. The emitted `.d.ts` imports only `@nestjs/common`, `pino` and `rxjs`.

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
  "level": "info",
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

Enable `http.isEnabled: true` in the module options and wire `applyRequestIdMiddleware(consumer)` (see [Context propagation](#7-context-propagation-with-logcontextservice)). The access log is recorded from **middleware**, which emits:

| Log key                     | When                                                |
| --------------------------- | --------------------------------------------------- |
| `HTTP_REQUEST_START`        | Request received                                    |
| `HTTP_REQUEST_SUCCESS`      | 2xx response                                        |
| `HTTP_REQUEST_REDIRECT`     | 3xx response                                        |
| `HTTP_REQUEST_CLIENT_ERROR` | 4xx response                                        |
| `HTTP_REQUEST_SERVER_ERROR` | 5xx response                                        |
| `HTTP_REQUEST_ABORTED`      | Connection closed before the response was delivered |

`HTTP_REQUEST_START` is emitted **before guards**, so it carries no `userId` — authentication runs
in a guard, and at that point there is no principal yet. The acting user is on the **terminal**
entry, where the guard has populated it. Both entries carry the same `requestId`, so joining on
that gives the whole request.
| `HTTP_EXCEPTION_HANDLED` | `HttpException` caught by the filter |
| `HTTP_EXCEPTION_UNHANDLED` | Unexpected error caught by the filter |

URLs are automatically normalized — `/users/550e8400-e29b-41d4-a716-446655440000` becomes `/users/:id` so Loki/Grafana cardinality stays bounded. The query string is stripped from every logged URL, because a magic-link token or reset code in a query parameter is a secret no key-name redaction can scrub out of a string value.

> [!IMPORTANT]
> **Why middleware and not an interceptor.** NestJS runs middleware → guards → interceptors →
> handler, so an interceptor never observes a request a guard rejected, and never observes one that
> matched no route. Measured against a real backend: **401, 403, 429 from a throttler and 404 for an
> unknown path produced no log line at all** — not even `HTTP_REQUEST_START` — so brute force,
> credential stuffing and route enumeration were invisible, and invisible without a `requestId` to
> correlate them by. The access log therefore runs before guards.
>
> A consumer who does not wire the middleware keeps the previous interceptor-based behaviour rather
> than losing HTTP logs — including its blind spot.

**Delivery is reported separately from status.** `HTTP_REQUEST_ABORTED` is emitted when the
connection closed before the response was flushed, and it **keeps the real status the server
produced** rather than inventing one: nginx's `499` is not an HTTP status (IANA leaves 452–499
unassigned), so recording it would assert a code the protocol has no name for and break any
consumer grouping by class.

Its limit is worth stating: `writableFinished` distinguishes a response still in flight from one
handed to the operating system. A **fast handler whose client hangs up after the bytes were
flushed** is reported as the success it was — the server completed and flushed it, and whether the
peer read it is not knowable from the server side. What this catches is the case that matters
operationally: the slow upstream, the load-balancer timeout, the cancelled request.

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

**Without OpenTelemetry installed, everything above simply does not happen** — no error, no warning
on every log, no crash. The peer is optional and the logger is fully usable on its own. The one
case that _is_ reported is a misconfiguration: if trace injection is enabled and
`@opentelemetry/api` cannot be resolved, a single `LOGGER_BOOTSTRAP_WARNING` naming
`OTEL_API_UNAVAILABLE` is emitted at startup. Absence of `traceId` would otherwise be
indistinguishable from "no active span".

The logger **observes** the trace context; it never creates spans, installs a context manager, or
parses `traceparent` by hand. When the API is present but no span is active, no identifiers are
emitted — none are invented.

> [!NOTE]
> Resolution of the optional peer is anchored at the **library's own module path**, falling back to
> `process.cwd()`. Anchoring only at the working directory — as versions before this did — silently
> disabled correlation whenever the process was launched from somewhere other than the application
> root: a Docker `WORKDIR`, a pnpm/Yarn workspace with hoisted `node_modules`, a monorepo started at
> the repository root, a serverless bundle.

### 6b. Resource identity

Every entry carries the service identity, using attributes that are **Stable** in Semantic
Conventions v1.44.0:

```typescript
BymaxLoggerModule.forRoot({
  service: {
    name: 'checkout-api', // service.name
    version: '2.14.3', // service.version
    namespace: 'payments', // service.namespace
    instanceId: process.env.POD_UID, // service.instance.id
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

Set `resourceFormat: 'flat'` to emit the dotted attribute names verbatim
(`"service.instance.id": "pod-7f3a"`), which is what a collector mapping log fields onto resource
attributes reads directly.

#### Precedence

Resolved once at startup, in this order:

1. **explicit `service` options**
2. **`OTEL_SERVICE_NAME`** (name only)
3. **`OTEL_RESOURCE_ATTRIBUTES`** (`service.namespace=payments,service.version=2.14.3,…`)
4. **`NODE_ENV`** (environment only)

Explicit configuration wins because it is the most specific statement you can make. The order of
the two OpenTelemetry variables is required by the specification, not chosen: _"If `service.name` is
also provided in `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME` takes precedence."_

Reading the same variables the SDK reads is what makes **logs and traces agree** without the logger
depending on the SDK. Configure the environment once and both signals describe the same service.

> [!IMPORTANT]
> **`service.instance.id` is never generated.** The specification requires the triplet
> (`service.namespace`, `service.name`, `service.instance.id`) to be globally unique and recommends
> a random UUID — but a UUID minted by the logger would be the _logger's_, not the OpenTelemetry
> Resource's, so logs and traces would claim different instances of the same process. It would also
> change on every restart while looking authoritative. Supply it from the platform (Kubernetes pod
> UID, ECS task ARN, VM instance id) or through `OTEL_RESOURCE_ATTRIBUTES`. Omitted is honest;
> plausible-but-wrong is not.
>
> There is **no `OTEL_SERVICE_VERSION`** variable in the specification. Version comes from
> configuration or from `OTEL_RESOURCE_ATTRIBUTES`.

The deprecated `deployment.environment` spelling is **never** emitted, in any mode.

### 6c. Event names

Structured entries carry a machine-readable event name derived from `logKey`, following OTel naming
rules — lowercase, dot-namespaced:

| `logKey`                     | `event.name`                 |
| ---------------------------- | ---------------------------- |
| `PAYMENT_FAILED`             | `payment.failed`             |
| `USER_AUTHENTICATION_FAILED` | `user.authentication.failed` |

`logKey` is **never renamed or removed** — this is additive. Calls through the NestJS variadic
bridge (`logger.log`, `logger.warn`, …) carry no log key and correctly get no event name: an
ordinary diagnostic line is not an Event.

Keep event names **low cardinality**. `payment.failed` is an event; `payment.failed.918231781` is an
identifier wearing an event's clothes and will multiply your series count. Identifiers belong in
their own fields.

> [!NOTE]
> The value is meant to be mapped onto the **`EventName`** field of the OpenTelemetry LogRecord,
> which is Stable in the Logs Data Model. The same-named `event.name` **attribute** is _Deprecated_
> precisely because the value belongs in that top-level field instead. A JSON log line has no way to
> express that distinction — every key is just a key — so the carrier key is configurable via
> `eventNameField`, and your collector decides where it lands. What it must not do is carry it into
> an OTLP _attributes_ map under the deprecated name.

Set `eventNameField: false` to emit nothing.

### 6d. Error fields

`errorFormat` controls the shape:

```json
// errorFormat: 'pino'  (default — unchanged from 1.2.0)
{ "err": { "type": "PaymentDeclined", "message": "card declined", "stack": "…",
           "cause": { "name": "Error", "message": "gateway timeout" } } }

// errorFormat: 'both'  (recommended while migrating)
{ "err": { "type": "PaymentDeclined", … },
  "exception.type": "PaymentDeclined",
  "exception.message": "card declined",
  "exception.stacktrace": "…",
  "error.type": "PaymentDeclined" }

// errorFormat: 'semconv'  (explicit migration — err is removed)
{ "exception.type": "PaymentDeclined", "exception.message": "card declined",
  "exception.stacktrace": "…", "error.type": "PaymentDeclined" }
```

All four attributes are **Stable**. `error.type` carries the **class name** and is low cardinality
by construction — never a message, never an identifier — because the spec requires it to be
aggregatable.

**`Error.cause` chains are preserved**, depth- and width-bounded, circular-safe, and redacted like
any other field. `AggregateError` members reach the entry as `err.errors`. There is no
OpenTelemetry attribute for a cause chain, so these stay namespaced under `err` rather than
inventing an `exception.cause` the spec does not define.

An error's own enumerable properties (`code`, `statusCode`, domain fields) are carried through, as
Pino's standard serializer did.

### 7. Context propagation with `LogContextService`

```typescript
// request-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common'
import {
  LogContextService,
  type LoggableRequest,
  type LoggableResponse
} from '@bymax-one/nest-logger'
import { randomUUID } from 'node:crypto'

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly logContext: LogContextService) {}

  use(req: LoggableRequest, res: LoggableResponse, next: () => void) {
    // A header can arrive repeated, so its type is `string | string[]`.
    const raw = req.headers['x-request-id']
    const requestId = (Array.isArray(raw) ? raw[0] : raw) ?? `r_${randomUUID()}`
    this.logContext.run({ requestId }, next)
  }
}
```

Any log emitted inside the `run()` scope — regardless of nesting depth — automatically includes `requestId` with no prop drilling.

---

## ⚙️ Configuration

Full options reference for `BymaxLoggerModule.forRoot(options)`:

### Top-level options

| Option                       | Type                            | Default                            | Description                                                                                                                                |
| ---------------------------- | ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `service.name`               | `string`                        | **Required**                       | Service name emitted in every log entry                                                                                                    |
| `service.version`            | `string`                        | **Required**                       | Release version/SHA emitted in every log entry                                                                                             |
| `service.namespace`          | `string`                        | —                                  | OTel `service.namespace` (**Stable**) — the group the service belongs to                                                                   |
| `service.instanceId`         | `string`                        | —                                  | OTel `service.instance.id` (**Stable**). **Never generated** — supply it from the platform. See [Resource identity](#6b-resource-identity) |
| `service.environment`        | `string`                        | `NODE_ENV`                         | OTel `deployment.environment.name` (**Stable**). The deprecated `deployment.environment` is never emitted                                  |
| `resourceFormat`             | `'nested' \| 'flat'`            | `'nested'`                         | Shape of the identity fields. `'flat'` emits the dotted attribute names verbatim                                                           |
| `eventNameField`             | `string \| false`               | `'event.name'`                     | Field carrying the derived event name (`PAYMENT_FAILED` → `payment.failed`). `false` disables it                                           |
| `errorFormat`                | `'pino' \| 'semconv' \| 'both'` | `'pino'`                           | `'both'` adds `exception.*` and `error.type` beside `err.*`; `'semconv'` replaces them                                                     |
| `level`                      | `LogLevel`                      | `'info'`                           | Minimum log level. One of `fatal \| error \| warn \| info \| debug \| trace`                                                               |
| `redactPaths`                | `string[]`                      | `[]`                               | Additional `fast-redact` paths, applied on top of the default coverage                                                                     |
| `redactStrategy`             | `'names' \| 'paths'`            | `'names'`                          | Engine behind the DEFAULT set. `'paths'` restores the pre-1.2 `fast-redact` expansion (four-level ceiling, ~100× slower)                   |
| `shouldDisableDefaultRedact` | `boolean`                       | `false`                            | Skip the default PII coverage entirely. ⚠️ Emits `LOGGER_BOOTSTRAP_WARNING` at startup — document why                                      |
| `redactCensor`               | `string`                        | `'[REDACTED]'`                     | Replacement value written in place of every redacted field                                                                                 |
| `maxEntrySizeBytes`          | `number`                        | `65536`                            | UTF-8 byte ceiling per serialized field (`err` + any custom serializer); over it the value becomes a truncation envelope                   |
| `destinations`               | `ILogDestination[]`             | `[new DefaultStdoutDestination()]` | The sinks entries are written to. ⚠️ A non-empty list **replaces** that default — see [Destinations](#destinations-replace-stdout)         |

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

`LOGGER_BOOTSTRAP_OK` · `LOGGER_BOOTSTRAP_WARNING` · `LOGGER_SHUTDOWN_OK` · `HTTP_REQUEST_START` · `HTTP_REQUEST_SUCCESS` · `HTTP_REQUEST_REDIRECT` · `HTTP_REQUEST_CLIENT_ERROR` · `HTTP_REQUEST_SERVER_ERROR` · `HTTP_REQUEST_ABORTED` · `HTTP_REQUEST_COMPLETED` · `HTTP_EXCEPTION_HANDLED` · `HTTP_EXCEPTION_UNHANDLED` · `METHOD_EXECUTION` · `METHOD_SLOW_EXECUTION` · `LOGGER_DESTINATION_INIT_FAILED` · `LOGGER_DESTINATION_WRITE_FAILED` · `LOGGER_ENTRY_TRUNCATED` · `LOGGER_REDACTION_FAILED`

All reserved keys are exported as the `RESERVED_LOG_KEYS` constant from `@bymax-one/nest-logger/shared`.

`HTTP_REQUEST_COMPLETED` is reserved but deliberately never emitted — the four status-specific
terminal keys already carry the same `duration`, so a generic "completed" entry would double the
access-log volume to say nothing new. The reserved-but-unwritten set is exported as
`RESERVED_LOG_KEYS_NOT_EMITTED`, and a test asserts that every OTHER declared key has a writer in
the source, so a key can no longer be documented as a signal and then silently never emitted.

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

A non-empty `destinations` **replaces** `DefaultStdoutDestination` — it does not add to it. That is deliberate: a file-only or socket-only deployment has to be able to turn structured stdout off. To keep stdout alongside a custom sink, list it explicitly:

```typescript
destinations: [new DefaultStdoutDestination(), new LokiDestination({ ... })]
```

The consequence worth knowing: a sink you supply may be the **only** one the application has, so its failure is the application's silence. Two guarantees cover that, and neither requires anything from you:

- **A destination that fails `onInit` is reported as `LOGGER_DESTINATION_INIT_FAILED` on `stderr`** — not through the logger, whose sinks are the ones that just failed — and receives no entries.
- **If _every_ destination fails to initialize, entries fall back to raw NDJSON on `stdout`.** Degraded and ugly, but visible; nothing is lost, including the bootstrap entries.

So the common accident — adding `new PrettyDevDestination()` without installing the optional `pino-pretty` — costs you colours and a line on stderr telling you why, never your logs.

### Choosing how the dev terminal renders

`PrettyDevDestination` takes a `view`. Every field defaults to what it rendered before, so `new PrettyDevDestination()` is unchanged — the options exist because the default view is deliberately verbose, and one entry can be seven lines.

```typescript
// One line per entry, with the fields your project repeats on every line hidden.
new PrettyDevDestination({
  view: { singleLine: true, ignore: 'pid,hostname,service,deployment,event.name' }
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

> **`hideObject` hides it everywhere.** In pretty mode there is no JSON copy behind the rendering, because `destinations` **replaces** stdout — so a field hidden here, `logKey` included, is not visible anywhere. That is what the option is for; `messageFormat` is how you pull a specific field back.

The shape is exported as `PrettyViewOptions` when you want to build the view separately — it is this library's own interface, not a re-export of `pino-pretty`'s `PrettyOptions`, so type-checking without the optional peer installed still resolves.

> **`destination` is not exposed, by design.** The library owns where entries go — a redirected stream would route around the fan-out and the last-resort rescue above. It is absent from the type and applied after your options are merged, so it cannot be overridden from untyped JavaScript either.

**The first entries of a boot are held, not lost.** The transform cannot exist until `onInit` — loading the optional peer is async — so everything NestJS emits while instantiating providers arrives before it. Those entries are buffered and then rendered through the transform in arrival order. If the peer is missing, the bound is reached, or the app shuts down before init, they are written as raw NDJSON instead: degraded, never dropped.

### Postgres destination (Prisma)

```typescript
import { PINO_LEVEL_NUMBERS } from '@bymax-one/nest-logger'
import type { ILogDestination } from '@bymax-one/nest-logger'
import type { LogEntry } from '@bymax-one/nest-logger/shared'
import type { PrismaClient } from '@prisma/client'

export class PrismaLogDestination implements ILogDestination {
  readonly name = 'prisma-postgres'
  readonly minLevel = 'warn' as const // only persist warnings and above

  constructor(private readonly prisma: PrismaClient) {}

  write(payload: string): void {
    // This destination stores individual columns, so it is one of the few that
    // has to parse. A sink that forwards the line verbatim should not.
    const entry = JSON.parse(payload) as LogEntry
    void this.prisma.applicationLog.create({
      data: {
        // `entry.level` is the Pino LABEL ('info'). Map it when the column is numeric.
        level: PINO_LEVEL_NUMBERS[entry.level],
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

  write(payload: string): void {
    // Already newline-terminated JSON — re-serializing would double-encode it.
    this.stream?.write(payload)
  }
}
```

---

## 🏗️ Architecture

```
HTTP Request
    │
    ▼
RequestIdMiddleware             ← runs FIRST (NestJS middleware precedes
    │                              guards AND interceptors) and opens the
    │                              AsyncLocalStorage scope
    │                              { requestId, tenantId, userId }
    ▼
HttpAccessLogMiddleware         ← emits HTTP_REQUEST_START inside that scope, and
    │                              arms the terminal entry on the response's
    │                              'close' event. BEFORE guards, so a 401/403/429
    │                              rejection is logged too.
    ▼
Guards (consumer's auth)        ← may reject here; no interceptor ever runs
    │
    ▼
HttpLoggingInterceptor          ← records the thrown error for the terminal entry
    │
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
         name redactor           ← one recursive walk, any depth
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

| Principle                     | Description                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **🪶 Singleton Scope**        | `AsyncLocalStorage` delivers per-request context at zero latency overhead — NestJS `Scope.REQUEST` adds ~5% on the injection graph, unacceptable on a logger that runs for every request                                                                                                    |
| **🧬 One Composed Mixin**     | ALS context and OTel trace context merge into a single Pino mixin with a deterministic order: ALS first, then OTel — an active span is the authoritative trace identity, so it wins on conflicts                                                                                            |
| **⚡ Single-pass Redaction**  | One recursive walk censors any value whose key name is in the sensitive set, to a 100-level ceiling past which nested objects are dropped rather than emitted — O(nodes), the same order the serializer already pays. Replaced 140 `fast-redact` wildcard paths that cost ~107 µs per entry |
| **🔌 Interface-Driven Sinks** | `ILogDestination` is a contract — Loki, Postgres, rolling files, or anything else is a consumer implementation, never a dependency of this package                                                                                                                                          |
| **🌳 Zero Runtime Deps**      | `"dependencies": {}` — every package arrives as a peer dependency, so consumers pin exact versions and the supply-chain surface stays theirs                                                                                                                                                |

---

## 🔐 Security Model

A logger sees every payload the application handles, so the security posture is about what **never** reaches the sink — and about a sink failure never reaching the application.

### Redaction by default

The library censors **32 sensitive field names** wherever they appear in a log record — down to 100 levels of nesting, inside arrays, and inside class instances. Past that ceiling a nested OBJECT is DROPPED rather than emitted, so the limit can never become a leak. (A primitive sitting at the boundary is still emitted: its key was matched by the container at level 100, the last one walked, so it has already been through the matcher.) These cover:

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

#### How it works, and why it changed in `1.2.0`

Redaction is one **recursive, snapshotting walk** of the record: a value is censored when its KEY NAME is in the set above, wherever that key sits. Nothing the caller passed is mutated, and every value is read exactly once and pinned into a fresh structure — so what reaches the sink is guaranteed to be what was inspected, even when the payload carries accessors or a `toJSON` that could answer differently on a second read.

A value with a `toJSON` is inspected through that method's output, because that is what reaches the log. A method can also **rename** what it exposes — `{ password, toJSON: () => ({ value: this.password }) }` would emit the secret under a name nobody declared sensitive — so when the source object itself carries a sensitive key, the method is not trusted and the whole value is censored. This deliberately over-redacts an object that holds a sensitive key and correctly omits it; the alternative (running `toJSON` against a sanitized copy) throws on every method that reads an internal slot rather than an own property, which is `Date`, `Decimal` and Luxon.

> [!WARNING]
> Redaction matches **key names**. A secret placed under a name you have not declared sensitive is
> emitted — `logger.log(key, msg, userId, { renamed: user.password })` writes it in clear, and so
> does a `toJSON` that renames nested state. That is a property of name-based redaction, not a
> defect: no name matcher can follow a value through a rename. Declare the name, or keep the value
> out of the log.

Before `1.2.0` the same names were expanded into 140 `fast-redact` paths at wildcard depths 1–4 (`*.field`, `*.*.field`, …), because `fast-redact`'s `*` matches a single level and is not recursive. That approach had two problems, both measured:

|                                  |                depth-1–4 paths (pre-`1.2.0`) |                 name walk (`1.2.0`) |
| -------------------------------- | -------------------------------------------: | ----------------------------------: |
| Throughput, full production path |                             **9,311 logs/s** |                  **274,227 logs/s** |
| Cost per entry                   |                                      ~107 µs |                             ~3.6 µs |
| Nesting covered                  |                 4 levels — deeper **leaked** | 100 levels — deeper objects dropped |
| `{ headers: { authorization } }` | **leaked** (only `req.headers.*` was pinned) |                            censored |

`DEFAULT_REDACT_PATHS` is still exported at full fidelity, and `redactStrategy: 'paths'` still feeds it to `fast-redact` for anyone depending on exact path semantics — with the ceiling and the cost that implies. Expect that escape hatch to be removed in a future major.

**Not covered, by design:** a secret interpolated into the message STRING (`logger.info(key, \`token=${t}\`)`) — redaction works on structured fields, and no field-based mechanism can scrub a substring. Keep secrets out of `msg`.

**One entry, one line.** What the message string _cannot_ do is forge an entry. Every message argument passes through a line-separator normalization before it reaches Pino, so `\r`, `\n`, U+2028, U+2029 and C1 NEL (U+0085) become the literal two-character sequence `\n` — and every other control character that can drive a terminal (ESC, vertical tab, form feed, backspace, the rest of C0 except TAB, DEL and the C1 range) becomes its readable `\uXXXX` escape. This protects **two** sinks, not one. `pino-pretty` (shipped here as `PrettyDevDestination`) and any destination that re-renders the parsed message write those bytes straight to the terminal, where a raw newline **or** an `ESC E` produces something indistinguishable from a separate log entry. And the raw NDJSON line is exposed too when a human reads it in a terminal: JSON escaping covers only C0, so `JSON.stringify` and Pino's serializer emit DEL, the C1 range (U+0085 NEL included), U+2028 and U+2029 **verbatim** — measured on real bytes. Escaping at the sink neutralizes both paths. The scrubbed stack gets the same escaping (its newlines are kept, since a stack is multi-line by design), because `pino-pretty` prints it raw and its first line repeats the error message. Structured fields are untouched: `err.message` keeps the original text verbatim. That is the boundary — a control character placed in a **metadata value** still reaches a terminal, because escaping data would mean rewriting what you asked to be logged. Only `msg` and the stack carry this guarantee.

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

> [!IMPORTANT]
> A consumer path's LEAF NAME is also fed to the name walk, so `redactPaths: ['user.ssn']`
> censors `ssn` wherever it appears, not only under `user`. That is broader than the path you
> wrote, deliberately: consumer paths are applied by Pino's stringifier, which runs after the
> per-field size bound, so without this a field covered only by a path could still surface inside
> a truncation envelope's `_preview`. It errs toward redacting a name you have already declared
> secret.
>
> An **array index is not a name**, so an unquoted numeric segment is skipped and the path falls
> back to the nearest name: `redactPaths: ['tokens[0]']` censors the whole `tokens` array. The
> walk matches key names and never array positions, so feeding it `0` would cover nothing while
> censoring any object key literally named `0`. The quoted form `['obj["0"]']` stays a name,
> since an object key named `0` IS matched by the walk.

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

Every `write()` runs inside a try/catch. A destination that throws or rejects produces a `LOGGER_DESTINATION_WRITE_FAILED` line on `stderr` — never back through the logger, which would turn a broken sink into a write → log → write feedback loop — and the entry is dropped for that sink only. A destination whose `onInit()` rejects is reported as `LOGGER_DESTINATION_INIT_FAILED` and excluded from the shutdown sequence without blocking boot; it stays in the write fan-out, where the same fail-soft wrapper contains it. A logging backend going down degrades logging — it never takes the application with it.

### Bounded field size

Every serializer — the default `err` one and any you supply — is wrapped so a field whose serialized JSON exceeds `maxEntrySizeBytes` (64 KB by default) is replaced by a compact envelope: `_truncated`, `_logKey: 'LOGGER_ENTRY_TRUNCATED'`, `_originalSize`, and a 200-character `_preview`. An accidentally logged webhook payload costs a bounded number of bytes and leaves a record that truncation happened, instead of flooding the sink.

### Security Checklist

When integrating `@bymax-one/nest-logger` in production, verify each of the following:

- `shouldDisableDefaultRedact` stays `false` — if it is on, the `LOGGER_BOOTSTRAP_WARNING` must be justified in a security review
- Every custom field carrying a secret or personal document is added to `redactPaths` at the depths it actually appears
- `http.excludePaths` regexes are anchored and linear-time — an unbounded pattern runs on every request URL (ReDoS)
- Custom destinations never re-serialize the raw request object; they receive the already-redacted, already-serialized NDJSON line
- Destination credentials (Loki, Postgres, OTLP) come from the environment, never from values written into module options in source control
- Log retention at the sink matches your data-retention policy — redaction bounds what is stored, not how long

---

## 🛡️ Security Table

| Layer               | Implementation                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| PII Redaction       | 32 field names censored at ANY depth in one snapshotting walk — ~3.6 µs/entry                                      |
| Credentials         | `password`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `apiKey`, `apiSecret`, `privateKey`            |
| MFA Secrets         | `mfaSecret`, `mfaRecoveryCodes`, `totpSecret` — redacted to the 100-level ceiling                                  |
| PCI DSS             | `cardNumber`, `cardCvv`, `cvv`, `cvc`, `cardExpiry`                                                                |
| LGPD Documents      | `cpf`, `cnpj`, `rg`, plus `email` as a conservative default                                                        |
| HTTP Headers        | `authorization`, `cookie`, `x-api-key`, `x-auth-token`, `set-cookie` — absolute paths on `req` / `res`             |
| Redact List         | `DEFAULT_REDACT_PATHS` is append-only; removal requires a major version                                            |
| Trace Injection     | `isValidTraceId` / `isValidSpanId` validated before any identifier is written                                      |
| URL Cardinality     | UUIDs and numeric IDs normalized to `:id` — bounds label cardinality and keeps raw identifiers out of the path     |
| Destination Failure | Every `write()` try/catch-wrapped; a failure is reported on `stderr` and swallowed, never propagated to the caller |
| Field Size          | Per-field UTF-8 cap at `maxEntrySizeBytes` (64 KB default); oversized values become a truncation envelope          |
| Supply Chain        | `"dependencies": {}` — no transitive runtime packages of the library's own choosing                                |

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
- ✅ **100% mutation score** — verified with [Stryker](https://stryker-mutator.io/) on a cold run
  against a `break` threshold of 95, with **zero** surviving mutants. The handful that no test can
  kill are suppressed on the line they apply to and each carries its reason; a rule against those
  comments was retired once their cost was measured at **+0.10 kB brotli**, roughly a tenth of
  what it had been assumed to be (see the [report](./docs/mutation_testing_results.md))
- ✅ **Every suppression carries its reason** — each `// Stryker disable` names, after the `:` Stryker reads it from, why the mutant it silences cannot be observed; one of them is recorded as what it is, a mutant the suite kills but Stryker fails to attribute, rather than mislabelled an equivalent. `check:mutants` proves those reasons parse, so they reach the report rather than the `Ignored using a comment` fallback, and the score stays an accounting rather than a number
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

There are **two** APIs on this class, and they do not share a signature shape.

**Structured API** — the `MODULE_ACTION_RESULT` convention. The third parameter is the acting **`userId`**, not a context label (the context comes from `@InjectLogger(ctx)`), and it may be omitted: when it is, an ambient `userId` from the `LogContextService` scope is used.

| Method            | Signature                         | Notes                                                            |
| ----------------- | --------------------------------- | ---------------------------------------------------------------- |
| `info`            | `(logKey, msg, userId?, meta?)`   | Structured info log                                              |
| `warnStructured`  | `(logKey, msg, userId?, meta?)`   | Structured warn log — takes a **message string**                 |
| `errorStructured` | `(logKey, error, userId?, meta?)` | Structured error log — takes an **`Error`**, serialized to `err` |

> [!NOTE]
> `meta` carries arbitrary fields, with two reserved groups dropped on the way in. `logKey`,
> `userId` and `context` belong to the payload — the entry states who acted and where, read from
> the authenticated ALS scope, so a metadata bag cannot forge them. `__proto__`, `constructor`
> and `prototype` are dropped as well: they name a prototype chain rather than a field, and an
> own `__proto__` (what `JSON.parse` of a request body produces) would otherwise be lost anyway.

**NestJS `LoggerService` bridge** — the variadic contract NestJS itself calls, so `app.useLogger()` works. These take a message, not a log key.

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

| Method     | Signature           | Description                                                                                                                          |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `run`      | `(store, callback)` | Opens an ALS scope. Any log inside `callback` carries `store` fields                                                                 |
| `set`      | `(key, value)`      | Adds/updates a field in the current scope. Throws if called outside `run()`. Fields set here reach every subsequent log in the scope |
| `getStore` | `()`                | Returns current scope or `undefined` outside a `run()` call                                                                          |

### Decorators

| Decorator                       | Target            | Description                                                                                                                                                        |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@InjectLogger(context?)`       | Constructor param | Injects `PinoLoggerService` pre-bound to the given context string                                                                                                  |
| `@LogContext(name)`             | Class             | Records a context label as class metadata. ⚠️ Metadata only — it does NOT open a `logContext.run()` scope; use `@InjectLogger(MyClass.name)` for a per-class label |
| `@LogPerformance(thresholdMs?)` | Method            | Logs `METHOD_EXECUTION` on completion; `METHOD_SLOW_EXECUTION` if duration exceeds threshold                                                                       |

### Level maps (from `@bymax-one/nest-logger`)

`LogEntry.level` is the Pino string LABEL, not the numeric code. A destination writing a numeric
column converts with the exported maps instead of hard-coding them:

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

// What is EMITTED. Deliberately a different type: `instanceId` nests as
// `service.instance.id`, and the environment is not under `service` at all.
// Reusing the configuration type here would advertise `entry.service.instanceId`,
// which no entry carries.
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

Under `resourceFormat: 'flat'` there is no `service` object at all — the values arrive as dotted
top-level keys (`"service.instance.id"`), which the index signature already admits.

The emitted types are exported, so a helper that receives one can be typed without inlining its
shape:

```typescript
import type {
  EmittedDeploymentResource,
  EmittedServiceResource,
  LogEntry
} from '@bymax-one/nest-logger/shared'

/** Build the identity triplet a backend joins on, from a parsed entry. */
function identityOf(entry: LogEntry): string {
  const service: EmittedServiceResource | undefined = entry.service
  const deployment: EmittedDeploymentResource | undefined = entry.deployment
  if (service === undefined) {
    return 'unknown'
  }
  // `service.namespace` is part of the identity, not decoration: OTel allows two
  // services to share a name when their namespaces differ, so a key built without
  // it collapses them into one.
  const namespace = service.namespace ?? 'no-namespace'
  const instance = service.instance?.id ?? 'no-instance'
  const environment = deployment?.environment.name ?? 'no-environment'
  return `${namespace}/${service.name}@${service.version}/${instance}/${environment}`
}

/** `event.name` is declared, so it reads as a string without a cast. */
function eventOf(entry: LogEntry): string | undefined {
  return entry['event.name']
}
```

### `ILogDestination`

```typescript
interface ILogDestination {
  readonly name: string
  readonly minLevel?: LogLevel
  /** `payload` is a newline-terminated JSON entry, UTF-8 encoded — not an object. */
  write(payload: string): void | Promise<void>
  onInit?(): Promise<void>
  onShutdown?(): Promise<void>
}
```

---

## 🚨 Error Code Catalog

| Code                              | Surfaces as                  | When                                                              | Action                                                                |
| --------------------------------- | ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `LOGGER_INVALID_OPTIONS`          | Thrown `Error` at init       | `service`, `service.name`, or `service.version` missing or empty  | Add the required fields                                               |
| `LOGGER_INVALID_LEVEL`            | Thrown `Error` at init       | `level` is not a valid Pino value                                 | Use `'fatal'\|'error'\|'warn'\|'info'\|'debug'\|'trace'`              |
| `LOGGER_PRETTY_UNAVAILABLE`       | Thrown `Error` at `onInit()` | `PrettyDevDestination` registered but `pino-pretty` not installed | Install `pino-pretty` or drop the destination                         |
| `LOGGER_OTEL_API_UNAVAILABLE`     | Nothing emitted              | `@opentelemetry/api` cannot be resolved                           | None — the trace mixin steps aside silently                           |
| `LOGGER_DESTINATION_INIT_FAILED`  | Structured error log         | `destination.onInit()` rejects                                    | Sink is excluded from shutdown; boot continues, writes stay fail-soft |
| `LOGGER_DESTINATION_WRITE_FAILED` | NDJSON line on `stderr`      | `destination.write()` throws or rejects                           | Entry dropped for that destination; others continue                   |
| `LOGGER_CONTEXT_OUT_OF_SCOPE`     | Thrown `Error`               | `LogContextService.set()` called outside `run()`                  | Wrap in `logContext.run({ ... }, () => ...)`                          |
| `LOGGER_ENTRY_TRUNCATED`          | `_logKey` in the envelope    | A serialized field exceeds `maxEntrySizeBytes`                    | Reduce the payload or raise the ceiling                               |

> [!NOTE]
> The codes above name the condition, not a machine-readable field. Thrown errors carry a human-readable message prefixed with the emitting class (e.g. `[BymaxLoggerModule] options.service is required`), not the code string.

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
