# @bymax-one/nest-logger — Complete Technical Specification

> **Version:** 2.0.0
> **Last updated:** 2026-05-27
> **Status:** Draft for implementation
> **Type:** Public npm package (`@bymax-one/nest-logger`)
> **Logging engine:** Pino 10.x (structured JSON, low-overhead; Pino 9 is EOL — do not use)
> **Observability:** Optional integration with OpenTelemetry SDK 1.x (`traceId`/`spanId` correlation)

---

## Table of Contents

1. [Vision and Value Proposition](#1-vision-and-value-proposition)
2. [Architecture](#2-architecture)
3. [Package Structure](#3-package-structure)
4. [Configuration API](#4-configuration-api)
5. [Destination Contracts](#5-destination-contracts)
6. [Services](#6-services)
7. [Interceptors](#7-interceptors)
8. [Filters](#8-filters)
9. [Decorators](#9-decorators)
10. [PII Redaction Strategy](#10-pii-redaction-strategy)
11. [OpenTelemetry Integration](#11-opentelemetry-integration)
12. [Log Keys Convention](#12-log-keys-convention)
13. [Error Code Catalog](#13-error-code-catalog)
14. [What is NOT in the package](#14-what-is-not-in-the-package)
15. [Dependencies](#15-dependencies)
16. [Implementation Phases](#16-implementation-phases)
17. [Known Limitations](#17-known-limitations)
18. [Example Integration](#18-example-integration)
19. [Appendix A — Glossary](#appendix-a--glossary)
20. [Appendix B — Pino vs Winston Benchmark](#appendix-b--pino-vs-winston-benchmark)
21. [Appendix C — Log Level Mapping](#appendix-c--log-level-mapping)

---

## 1. Vision and Value Proposition

### 1.1 What is `@bymax-one/nest-logger`

`@bymax-one/nest-logger` is a NestJS library for structured JSON logging in production, built on **Pino 10** with **optional** integration with **OpenTelemetry SDK 1.x** for distributed trace correlation. The lib provides:

- A `PinoLoggerService` that implements the official NestJS `LoggerService` interface and can replace the default logger with no application code changes
- An additional custom API `info(logKey, message, userId?, metadata?)` that follows the `MODULE_ACTION_RESULT` convention adopted across the Bymax ecosystem
- An HTTP interceptor for automatic request/response logging with normalized URLs
- An HTTP exception filter with sanitized stack trace capture
- `@InjectLogger()` and `@LogPerformance()` decorators to reduce boilerplate
- Automatic propagation of context (`requestId`, `tenantId`, `userId`, `traceId`, `spanId`) via `AsyncLocalStorage` — no prop drilling, no `(req: Request)` in service signatures
- PII redaction: a name-keyed walk by default, with `pino.redact` paths for consumer `redactPaths`
- Automatic detection of an active OpenTelemetry span — injects `traceId`/`spanId` into every log when OTel is configured; logs normally without those properties when it is not
- A pluggable destination system via the `ILogDestination` interface — stdout JSON (default), `pino-pretty` (dev), file, Loki, custom Postgres, or any destination that accepts a stream

### 1.2 Why it exists

In multi-service architectures, reliable trace-correlated logging is foundational. Reimplementing logger wrappers, PII redaction, HTTP interceptors, and OTel integration in every service:

- Duplicates code (~250 LoC minimum per project, often >800 LoC)
- Creates convention drift across services in the same ecosystem (field names, levels, format)
- Delays adoption of best practices (PII redact, trace correlation, structured logging)
- Increases security surface area (every custom implementation is an opportunity to leak secrets in logs)

`@bymax-one/nest-logger` centralizes these concerns in an auditable package with safe defaults and a stable API.

### 1.3 Why Pino + OpenTelemetry (not Winston)

| Criterion        | Pino 10                                             | Winston                                                 |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Performance      | **5-7× faster** in official benchmarks              | Baseline (slower by design)                             |
| Footprint        | Low allocation; this library uses no worker (§17.3) | Higher allocation, synchronous transformations          |
| Native structure | JSON-first                                          | JSON via format combinators (extra layer)               |
| OTel ecosystem   | Official `@opentelemetry/instrumentation-pino`      | `@opentelemetry/instrumentation-winston` (less support) |
| PII redact       | Declarative `redact` paths via `@pinojs/redact`     | Custom (manual)                                         |
| Adoption 2024+   | Standard in new Node backends                       | Legacy                                                  |

Choosing Pino aligns the Bymax ecosystem with the market direction and removes ~700 LoC of custom code (transports, formatters, sanitization) that would otherwise be maintained manually in a Winston-based solution.

### 1.4 Who uses it

- Production NestJS backends that need structured JSON logging correlated with distributed traces
- Multi-tenant services that require context propagation (`tenantId`, `userId`) in every log
- Applications under LGPD/GDPR compliance that need declarative PII redaction
- Bymax ecosystem projects that want a uniform convention (`MODULE_ACTION_RESULT` log keys)

### 1.5 Distribution Model

| Aspect    | Detail                                          |
| --------- | ----------------------------------------------- |
| Registry  | Public npm (`@bymax-one/nest-logger`)           |
| Cost      | Zero — open source package                      |
| License   | MIT                                             |
| Runtime   | Node.js 24+                                     |
| Framework | NestJS 11                                       |
| Subpaths  | `.` (server), `./shared`, `./observability`     |
| Engine    | Pino 10 (peer dependency)                       |
| OTel      | `@opentelemetry/api` (optional peer dependency) |

### 1.6 Design Principles

1. **Pino first, NestJS on top** — the lib is a thin wrapper over Pino. All of Pino's power-user features (child loggers, mixins, serializers) remain accessible to the advanced consumer via `getRawLogger()`.
2. **OTel optional, never required** — the lib detects `trace.getActiveSpan()` at runtime; if empty, it logs normally. No `NodeSDK` configuration is performed by the lib — that stays with the consumer.
3. **Dependency inversion** — destinations are pluggable via `ILogDestination`. The lib only knows the default (stdout JSON). The consumer plugs in Loki, Postgres, S3 archive, or any async destination.
4. **No `dependencies`** — the required peers are `@nestjs/common`, `@nestjs/core`, `pino`, `reflect-metadata` and `rxjs`; every other peer is optional.
5. **Convention over configuration** — `MODULE_ACTION_RESULT` log keys, reasonable default redact paths, NestJS-compatible default log levels. Safe defaults without requiring setup.
6. **NestJS-native compatibility** — `PinoLoggerService` implements `LoggerService` from `@nestjs/common`, usable in `app.useLogger()` or injectable as a traditional service.
7. **Multi-tenant ready** — `tenantId` propagation via `AsyncLocalStorage` in every log with no additional application code.
8. **Secure by default** — redact paths for common sensitive fields (`password`, `passwordHash`, `token`, `mfaSecret`, `cardNumber`, `cvv`, `cpf`, `cnpj`, `headers.authorization`, `headers.cookie`) enabled out-of-the-box.

### 1.7 Decision: from-scratch implementation (not `nestjs-pino`)

The community lib [`nestjs-pino`](https://github.com/iamolegga/nestjs-pino) (Iamolegga) covers ~70% of this lib's scope: ALS-based request context, `pino-http` HTTP logging, `Logger`/`PinoLogger`/`NativeLogger` services. **So why not depend on it?**

| Criterion                          | Assessment                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parity with `@bymax-one/nest-auth` | The public bymax repo grows by keeping its own visual identity + conventions. Depending on a community lib breaks architectural parity.                                                                                               |
| `MODULE_ACTION_RESULT` convention  | `nestjs-pino` is agnostic — it neither requires nor encourages the convention. To ensure uniform adoption across the bymax ecosystem, we need an API that makes the convention **the natural path**.                                  |
| Opinionated redact registry        | `nestjs-pino` exposes `pinoHttp.redact` without opinion; the consumer chooses. This lib **opines**: 62 sensitive names, expanded to 315 default paths, covering BR PII (CPF/CNPJ/RG) + LGPD + PCI DSS, merged with custom extensions. |
| Out-of-the-box OTel correlation    | `nestjs-pino` does not have a built-in OTel mixin (the consumer wires `@opentelemetry/instrumentation-pino`). This lib detects `trace.getActiveSpan()` automatically.                                                                 |
| Productivity decorators            | `nestjs-pino` does not provide `@InjectLogger`, `@LogPerformance`. This lib delivers them zero-config.                                                                                                                                |
| Multi-tenant via `tenantId`        | `nestjs-pino` requires the consumer to wire the header. This lib reads `x-tenant-id` by default and propagates via ALS.                                                                                                               |
| Supply chain                       | Keeping our own implementation reduces upstream dependency and eliminates the risk of unexpected breaking changes (community libs follow their own cadence).                                                                          |
| Maintenance cost                   | ~400-600 additional LoC. Justifiable given the reasons above.                                                                                                                                                                         |

**Accepted trade-offs:** more code to maintain, no direct community reuse, responsibility to track Pino releases. **Mitigation:** a Stryker `break` threshold of 100, strict CI gates, the Pino peer dep accepts wide ranges (`^10.0.0`).

### 1.8 Feature Categorization

#### Core (always active)

| Component                  | Responsibility                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `PinoLoggerService`        | NestJS methods (`log`, `error`, `warn`, `debug`, `verbose`, `fatal`) and structured `info`, `warnStructured`, `errorStructured` |
| `LogContextService`        | Manages `AsyncLocalStorage` for `requestId`, `tenantId`, `userId` propagation                                                   |
| `DefaultStdoutDestination` | Default destination (stdout JSON)                                                                                               |
| Name redactor              | Censors the sensitive names of `REDACT_COMMON_FIELDS`                                                                           |
| `TraceContextMixin`        | Pino mixin that injects `traceId`/`spanId` when OTel is active                                                                  |

#### HTTP (opt-in via `http.isEnabled: true`)

| Component                | Activation                                                          | Responsibility                                                      |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `HttpLoggingInterceptor` | `http: { isEnabled: true }`                                         | Logs request/response with normalized URL and duration              |
| `HttpExceptionFilter`    | `forRoot` with `http.isEnabled`                                     | Logs HTTP exceptions; off when `shouldCaptureExceptions` is `false` |
| `RequestIdMiddleware`    | `useRequestContext`, `applyAccessLog` or `applyRequestIdMiddleware` | Reads/generates `x-request-id` and opens the context scope          |

#### Decorators (always available)

| Decorator                     | Use                                                  |
| ----------------------------- | ---------------------------------------------------- |
| `@InjectLogger(context?)`     | Typed logger injection with pre-configured context   |
| `@LogContext(name)`           | Deprecated: stores a label that nothing reads (§9.2) |
| `@LogPerformance(threshold?)` | Logs method duration; warns above the threshold      |

#### Additional destinations (opt-in)

| Destination                  | Activation                                              | Use case                                                                   |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `PrettyDevDestination`       | Explicit only — added to `destinations` by the consumer | Human-readable colorized console in dev; rendering configurable via `view` |
| Custom via `ILogDestination` | Consumer implements                                     | Loki, Datadog, Postgres, S3 archive, any stream-friendly target            |

---

## 2. Architecture

### 2.1 NestJS dynamic module pattern — `ConfigurableModuleBuilder`

The lib exposes `BymaxLoggerModule` with two registration points. The internal implementation uses **`ConfigurableModuleBuilder`** from `@nestjs/common` — the official NestJS 11 pattern that eliminates ~50 LoC of manual `forRoot/forRootAsync` boilerplate and provides `setClassMethodName('forRoot')` + `setExtras({ isGlobal: true })` for the Global Module flag.

```typescript
// Sync
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  level: 'info',
  redactPaths: ['*.password', '*.token'],
  http: { isEnabled: true }
})

// Async (with injection)
BymaxLoggerModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    service: {
      name: config.getOrThrow('OTEL_SERVICE_NAME'),
      version: config.getOrThrow('RELEASE_SHA')
    },
    level: config.get('LOG_LEVEL'),
    redactPaths: config.get('LOG_REDACT_PATHS', '').split(',').filter(Boolean),
    http: { isEnabled: true },
    destinations: [new LokiDestination({ url: config.get('LOKI_URL') })]
  })
})
```

**Internal skeleton (`logger.module.builder.ts`)**:

```typescript
import { ConfigurableModuleBuilder } from '@nestjs/common'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'

export interface BymaxLoggerModuleExtras {
  isGlobal?: boolean
}

export const {
  ConfigurableModuleClass: BymaxLoggerModuleBase,
  MODULE_OPTIONS_TOKEN: BUILDER_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE
} = new ConfigurableModuleBuilder<BymaxLoggerModuleOptions>()
  .setClassMethodName('forRoot') // generates `forRoot` AND `forRootAsync`
  .setFactoryMethodName('createLoggerOptions')
  .setExtras<BymaxLoggerModuleExtras>(
    { isGlobal: true }, // default; can be overridden per-call
    (definition, extras) => ({
      ...definition,
      global: extras.isGlobal !== false // Nest's DynamicModule still uses `global` here;
      // the consumer-facing option key is `isGlobal`
    })
  )
  .build()
```

`BymaxLoggerModule` (`src/server/logger.module.ts`) extends the base and adds the providers: the logger and context services, the destination registry and health record, the Pino instance, the resolved destinations, the redactor, the observability handle, and one child logger per context name registered by `@InjectLogger`. When `http.isEnabled` is set, `forRoot` registers `HttpLoggingInterceptor` as `APP_INTERCEPTOR`, and `HttpExceptionFilter` too unless `shouldCaptureExceptions` is `false`. `forRootAsync` cannot read the options at registration time: it always registers an interceptor factory, which returns a pass-through when HTTP logging is off, and it never registers the filter.

> The module is **global** by default (`isGlobal: true` via `setExtras`). All app modules have access to the logger without importing `BymaxLoggerModule` in each one. Disable via `BymaxLoggerModule.forRoot({ ..., isGlobal: false })`.

**References:**

- [NestJS docs — Configurable Module Builder](https://docs.nestjs.com/fundamentals/dynamic-modules#configurable-module-builder)
- Inspiration: `@bymax-one/nest-auth` uses the same pattern in `src/server/auth.module.ts`.

### 2.2 Initialization flow

```
1. App boot →
2. BymaxLoggerModule.forRoot(options) evaluates config →
3. The redaction is resolved: the sensitive names plus the consumer `redactPaths` →
4. `buildPinoInstance` builds the Pino options:
   - level
   - redact { paths, censor }, only when consumer `redactPaths` or `redactStrategy: 'paths'` call for it
   - serializers { err } (a library serializer built on `sanitizeError` — NOT `pino.stdSerializers.err`, which derived `type` from the value's constructor and reported `"Object"` for a normalized error; plus the consumer's `serializers`. A `req` field that holds a request is serialized by the record formatter, unless the consumer registers `serializers.req`)
   - mixin → `TraceContextMixin` injects `traceId`/`spanId` (from OTel active span) + `LogContextService` fields into **every** log
   - ISO 8601 timestamp
   - base { service: { name, version, namespace?, instance: { id }? }, deployment: { environment: { name } }? } — the resolved resource identity, or the flat dotted attribute names under `resourceFormat: 'flat'` →
5. The root Pino is created with multi-stream transport:
   - stdout JSON **only when `destinations` is empty** — a non-empty list REPLACES it
   - pretty stream (opt-in via `PrettyDevDestination` in `destinations`) →
6. Every destination in `destinations` becomes one stream of the multi-stream fan-out →
7. PinoLoggerService is instantiated with a reference to the root Pino →
8. LogContextService initializes AsyncLocalStorage<LogContext> →
9. If http.isEnabled, HttpLoggingInterceptor is registered as global; forRoot also registers HttpExceptionFilter unless shouldCaptureExceptions is false →
10. The lib emits `LOGGER_BOOTSTRAP_OK` with the message `BymaxLoggerModule initialized` →
11. On onApplicationShutdown(): the lib emits LOGGER_SHUTDOWN_OK with { destinations }
    FIRST — an entry written after the sinks closed would have nowhere to go — then
    drains the queues and calls `onShutdown` on the ACTIVE destinations in reverse
    registration order, all within one `shutdown.timeoutMs` budget. A failing hook is
    reported and the rest still run; hooks past the budget are skipped and listed.
    It takes no signal argument and resolves `void`.
```

### 2.3 Log flow

```
1. Service calls logger.info('USER_CREATED', 'User registered', userId, { plan }) →
2. PinoLoggerService.info() →
3. The mixin reads LogContextService.getStore() (AsyncLocalStorage):
   { requestId, tenantId, userId, ... } →
4. The mixin adds traceId/spanId from trace.getActiveSpan() (if OTel is active) →
5. Final object passed to pino.info():
   {
     logKey: 'USER_CREATED',
     msg: 'User registered',
     userId: 'u_abc',
     plan: 'pro',
     requestId: 'r_xyz',
     tenantId: 't_acme',
     traceId: '4bf92...',
     spanId: '00f067...',
     time: '2024-05-29T16:26:40.000Z',
     level: 'info',
     service: { name: 'my-app', version: '1.2.3' }
   } →
6. Redaction: sensitive names are censored at any depth; consumer redactPaths also reach pino.redact →
7. Serialized JSON goes through pino.multistream, in the application thread, to each destination →
8. The default destination calls process.stdout.write; a custom one (Loki, Postgres) may batch
```

### 2.4 HTTP request flow (interceptor)

```
1. Request comes in → RequestIdMiddleware reads/generates x-request-id →
2. LogContextService.run({ requestId, tenantId? from header }, () => ...) →
3. HttpLoggingInterceptor.intercept():
   - Captures start time
   - Emits log: HTTP_REQUEST_START { method, url, ip, userAgent } →
4. Handler runs (every log inside has requestId/tenantId automatically) →
5. Response 2xx → HTTP_REQUEST_SUCCESS { statusCode, duration }
   Response 3xx → HTTP_REQUEST_REDIRECT
   Response 4xx → HTTP_REQUEST_CLIENT_ERROR (warn)
   Response 5xx → HTTP_REQUEST_SERVER_ERROR (error)
```

### 2.5 OpenTelemetry integration (optional)

The lib **does not initialize** the OTel SDK. Responsibility stays with the consumer (in `apps/.../main.ts` before `NestFactory.create`). The integration works via a **Pino mixin** (not via `formatters.log`): on every entry it reads the active span and, when the trace and span ids are valid, adds `traceId`, `spanId` and `traceFlags` (two hex digits). The source is `src/server/mixins/trace-context.mixin.ts`.

> **Why mixin and not `formatters.log`?** `formatters.log` only receives the object the caller passed to `pino.info(obj, msg)` — it has no access to ambient context (active span, AsyncLocalStorage). The **mixin** is called by Pino for every log without needing input from the caller, and it is the official place to enrich logs with fields derived from the environment. Confirm with [official Pino docs](https://github.com/pinojs/pino/blob/main/docs/api.md#mixin-function).

If `@opentelemetry/api` is not installed **or** `NodeSDK` has not been started, `trace.getActiveSpan()` returns `undefined` and the lib logs without `traceId`/`spanId`. **Zero application code changes** between having or not having OTel.

> **Recommended**: the consumer installs `@opentelemetry/instrumentation-pino` so that auto-injection also works with any root Pino logger outside the lib (e.g., Pino directly in CLI scripts). See §11.

### 2.6 Context propagation via AsyncLocalStorage

By design, NestJS does not pass `Request` to services. To propagate `requestId`, `tenantId`, `userId` into every log without prop drilling, the lib uses Node's native `AsyncLocalStorage`:

`RequestIdMiddleware` opens the scope; the interceptor does not.

```typescript
// RequestIdMiddleware.use(), on the mount that opens the scope, in pseudo-code:
const context = pick(logContext.getStore(), ['requestId', 'tenantId']) // a new object; nothing else
if (requestId !== undefined) context.requestId = requestId // resolved from this request
if (context.tenantId === undefined && tenantId !== undefined) context.tenantId = tenantId
logContext.run(context, () => next()) // every log inside this callback carries the context
```

The Pino mixin reads the context via `LogContextService.getStore()` and merges it into the log object.

> **OTel-compatible**: OpenTelemetry's `AsyncHooksContextManager` uses the same native mechanism. The two `AsyncLocalStorage`s (the nest-logger one and the OTel one) coexist without conflict.

> **Why not `nestjs-cls`?** The `nestjs-cls` lib (Papooch) is a rich wrapper over `AsyncLocalStorage` with Proxy Providers, a Transactional plugin, and better support for websocket gateways/queue consumers. We don't use it as a peer dep because: (1) it adds transitive deps that the lib wants to avoid, (2) the `nest-logger` use case is strictly "propagate 5 fields" — it doesn't justify importing an entire lib, (3) consumers already using `nestjs-cls` can **integrate** via a custom decorator that reads `ClsService` and sets it on `LogContextService` in the `RequestIdMiddleware`.

---

## 3. Package Structure

### 3.1 Directory tree (abridged)

```
src/
├── server/
│   ├── services/
│   │   ├── pino-logger.service.ts          # PinoLoggerService — main API
│   │   ├── log-context.service.ts          # AsyncLocalStorage manager
│   │   └── destination-registry.service.ts # Manages pluggable destinations
│   ├── interceptors/
│   │   └── http-logging.interceptor.ts     # Log request/response
│   ├── filters/
│   │   └── http-exception.filter.ts        # Captures HTTP exceptions
│   ├── middlewares/
│   │   └── request-id.middleware.ts        # Reads/generates x-request-id
│   ├── decorators/
│   │   ├── inject-logger.decorator.ts      # @InjectLogger
│   │   ├── log-context.decorator.ts        # @LogContext
│   │   └── log-performance.decorator.ts    # @LogPerformance
│   ├── destinations/
│   │   ├── default-stdout.destination.ts   # JSON to stdout (default)
│   │   └── pretty-dev.destination.ts       # pino-pretty (dev)
│   ├── interfaces/
│   │   ├── log-destination.interface.ts    # ILogDestination
│   │   ├── log-context.interface.ts        # LogContext shape
│   │   └── logger-module-options.interface.ts
│   ├── constants/
│   │   ├── default-redact-paths.constants.ts
│   │   ├── injection-tokens.constants.ts   # Symbol() tokens
│   │   └── log-levels.constants.ts
│   ├── mixins/
│   │   └── trace-context.mixin.ts          # Pino mixin for OTel
│   ├── utils/
│   │   ├── normalize-url.util.ts           # /users/123 → /users/:id
│   │   ├── sanitize-error.util.ts          # Cleans stack trace, redacts fields
│   │   └── compile-redact-paths.util.ts
│   ├── config/
│   │   ├── default-options.ts
│   │   └── validate-options.ts
│   ├── logger.module.builder.ts            # ConfigurableModuleBuilder factory
│   ├── logger.module.ts                    # BymaxLoggerModule (extends builder; overrides forRoot/forRootAsync)
│   ├── pino-factory.ts                     # buildPinoInstance(options, logContext, destinations, health)
│   └── index.ts                            # Barrel — public exports
│
└── shared/
    ├── types/
    │   ├── log-level.type.ts
    │   ├── log-entry.type.ts
    │   └── service-metadata.type.ts
    ├── constants/
    │   ├── reserved-log-keys.constants.ts  # HTTP_REQUEST_*, LOGGER_BOOTSTRAP, etc.
    │   └── log-keys-convention.constants.ts # MODULE_ACTION_RESULT pattern
    └── index.ts
```

### 3.2 Subpath exports

```json
"exports": {
  ".": {
    "import": {
      "types": "./dist/server/index.d.ts",
      "default": "./dist/server/index.mjs"
    },
    "require": {
      "types": "./dist/server/index.d.cts",
      "default": "./dist/server/index.cjs"
    }
  },
  "./shared": {
    "import": {
      "types": "./dist/shared/index.d.ts",
      "default": "./dist/shared/index.mjs"
    },
    "require": {
      "types": "./dist/shared/index.d.cts",
      "default": "./dist/shared/index.cjs"
    }
  },
  "./observability": {
    "import": {
      "types": "./dist/observability/index.d.ts",
      "default": "./dist/observability/index.mjs"
    },
    "require": {
      "types": "./dist/observability/index.d.cts",
      "default": "./dist/observability/index.cjs"
    }
  },
  "./package.json": "./package.json"
}
```

### 3.3 Exports per subpath

**`@bymax-one/nest-logger`** (server). The list is `src/server/index.ts`:

- Module: `BymaxLoggerModule`
- Services: `PinoLoggerService`, `LogContextService`
- Destinations: `DefaultStdoutDestination`, `PrettyDevDestination` (type `PrettyViewOptions`)
- HTTP: `HttpExceptionFilter`, `HttpLoggingInterceptor`, `RequestIdMiddleware`, `HttpAccessLogMiddleware`, `applyAccessLog`, `applyRequestIdMiddleware`, `PinoUnexpectedErrorSink`
- Decorators: `InjectLogger`, `LogContext` (with `LOG_CONTEXT_METADATA_KEY`), `LogPerformance`
- Tokens: `LOGGER_OPTIONS_TOKEN`, `LOGGER_PINO_INSTANCE_TOKEN`, `LOGGER_DESTINATIONS_TOKEN`, `LOGGER_REDACTOR_TOKEN`, `LOGGER_OBSERVABILITY_TOKEN`, `LOG_CONTEXT_TOKEN`
- Constants and guards: `DEFAULT_REDACT_PATHS`, `REDACT_COMMON_FIELDS`, `isValidTraceId`, `PINO_LEVEL_NAMES`, `PINO_LEVEL_NUMBERS`
- Types: the destination, HTTP, options, observability and context interfaces (the context shape is exported as `LogContextBag`)
- Everything `./shared` exports

**`@bymax-one/nest-logger/shared`** (zero deps, importable in the frontend for typing):

```typescript
export type { LogLevel } from './types/log-level.type'
export type { LogEntry } from './types/log-entry.type'
export type {
  EmittedDeploymentResource,
  EmittedServiceResource,
  ResolvedServiceMetadata,
  ServiceMetadata
} from './types/service-metadata.type'
export {
  RESERVED_LOG_KEYS,
  RESERVED_LOG_KEYS_NOT_EMITTED
} from './constants/reserved-log-keys.constants'
export type { ReservedLogKey } from './constants/reserved-log-keys.constants'
export { LOG_KEYS_CONVENTION_REGEX } from './constants/log-keys-convention.constants'
```

**`@bymax-one/nest-logger/observability`**: `BymaxLoggerObservabilityModule`, `LoggerMetricsContributor`, `LoggerHealthIndicator`, `LOGGER_HEALTH_INDICATOR_NAME`.

---

## 4. Configuration API

### 4.1 `BymaxLoggerModuleOptions` interface

The listing and the table below are abridged. Every option is in `src/server/interfaces/logger-module-options.interface.ts`.

```typescript
import type { LoggableRequest } from '@bymax-one/nest-logger'

export interface BymaxLoggerModuleOptions {
  /**
   * Service metadata — written as `service.name` and `service.version` in every log.
   * Aligned with OpenTelemetry semantic conventions.
   */
  service: {
    name: string
    version: string
    namespace?: string
    instanceId?: string
    environment?: string
  }

  /**
   * Minimum log level emitted.
   * @default 'info' in production, 'debug' otherwise
   */
  level?: LogLevel

  /**
   * Whether to register the module as global (`@Global()`).
   * Mapped to NestJS's `DynamicModule.global` via `ConfigurableModuleBuilder.setExtras` —
   * see §2.1. The consumer-facing key is `isGlobal` (Nest convention for module options).
   * @default true
   */
  isGlobal?: boolean

  /**
   * @deprecated Not read. Call `BymaxLoggerModule.useNestLogger(app)` instead.
   */
  shouldUseAsNestLogger?: boolean

  /**
   * PII paths to redact, added to the default coverage.
   * Pino syntax: 'a.b.c', '*.token', 'req.headers.authorization'.
   * Under the default `redactStrategy: 'names'` each path's last segment is also censored at any depth.
   * @see https://github.com/pinojs/pino/blob/main/docs/redaction.md
   */
  redactPaths?: string[]

  /**
   * Override the censor token written in place of redacted values.
   * @default '[REDACTED]'
   */
  redactCensor?: string

  /**
   * Disable default redact paths. Use with extreme caution.
   * @default false
   */
  shouldDisableDefaultRedact?: boolean

  /**
   * A non-empty list replaces the default stdout JSON destination.
   * Multiple destinations are written to via Pino's multi-stream.
   */
  destinations?: ILogDestination[]

  /**
   * HTTP module configuration.
   */
  http?: {
    /** Register HttpLoggingInterceptor as global; forRoot also registers HttpExceptionFilter. @default false */
    isEnabled?: boolean
    /** Register the filter (`forRoot` only). @default true */
    shouldCaptureExceptions?: boolean
    /** Generate an x-request-id when missing, in the request-id middleware. @default true */
    shouldGenerateRequestId?: boolean
    /** URL paths to exclude from HTTP logging (regex array). @default [/^\/health$/, /^\/health\/live$/, /^\/health\/ready$/, /^\/metrics$/] */
    excludePaths?: RegExp[]
    /** Header where tenantId is read; `false` reads none. @default 'x-tenant-id' */
    tenantIdHeader?: string | false
    /** Resolve the tenantId from the request. */
    tenantIdResolver?: (request: LoggableRequest) => string | undefined
  }

  /**
   * OpenTelemetry integration tuning.
   */
  otel?: {
    /** Inject traceId/spanId from the active OTel span into every log. @default true */
    shouldAutoInjectTraceContext?: boolean
    /** Name of the field for traceId. @default 'traceId' (camelCase). Set to 'trace_id' to align with OTel Logs Data Model wire format. */
    traceIdField?: string
    /** Name of the field for spanId. @default 'spanId'. Set to 'span_id' for OTel alignment. */
    spanIdField?: string
    /** Name of the field for traceFlags (2-hex W3C). @default 'traceFlags'. Set to 'trace_flags' for OTel alignment. */
    traceFlagsField?: string
    /**
     * Convenience: set 'snake_case' to apply OTel Logs Data Model field naming
     * (trace_id / span_id / trace_flags) without specifying each individually.
     * @default 'camelCase'
     */
    fieldFormat?: 'camelCase' | 'snake_case'
  }

  /**
   * UTF-8 byte ceiling per serialized field (`err` and any custom serializer), not per entry
   * (§17.7). Over it the value is replaced by a marker.
   * @default 65536 (64KB)
   */
  maxEntrySizeBytes?: number

  /**
   * Custom Pino serializers (merged with the default `err`).
   * @see https://github.com/pinojs/pino/blob/main/docs/api.md#serializers-object
   */
  serializers?: Record<string, (input: unknown) => unknown>

  /**
   * Override the timestamp function. By default, ISO 8601 UTC.
   */
  timestamp?: () => string
}
```

### 4.2 Options table and defaults

| Option                              | Type                          | Default                                                                  | Notes                                                                                                            |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `service.name`                      | `string`                      | **required**                                                             | E.g., `'bymax-finance-backend'`                                                                                  |
| `service.version`                   | `string`                      | **required**                                                             | Typically `process.env.RELEASE_SHA ?? 'dev'`                                                                     |
| `level`                             | `LogLevel`                    | `'info'` prod, `'debug'` other                                           | Values: `'fatal' \| 'error' \| 'warn' \| 'info' \| 'debug' \| 'trace'`                                           |
| `isGlobal`                          | `boolean`                     | `true`                                                                   | `@Global()` for LoggerModule — mapped to Nest's `DynamicModule.global` internally                                |
| `shouldUseAsNestLogger`             | `boolean`                     | —                                                                        | Deprecated and not read; call `BymaxLoggerModule.useNestLogger(app)`                                             |
| `redactPaths`                       | `string[]`                    | `[]` (added to the default coverage)                                     | Pino `redact` syntax; under the default `redactStrategy: 'names'` the last segment is also censored at any depth |
| `redactCensor`                      | `string`                      | `'[REDACTED]'`                                                           | String that replaces sensitive values                                                                            |
| `shouldDisableDefaultRedact`        | `boolean`                     | `false`                                                                  | ⚠️ Do not use in prod without a strong reason                                                                    |
| `destinations`                      | `ILogDestination[]`           | `[]`                                                                     | Empty: `DefaultStdoutDestination` is used. A non-empty list replaces it                                          |
| `http.isEnabled`                    | `boolean`                     | `false`                                                                  | Enables HTTP interceptor + filter                                                                                |
| `http.shouldCaptureExceptions`      | `boolean`                     | `true`                                                                   | Registers the exception filter (`forRoot` only)                                                                  |
| `http.shouldGenerateRequestId`      | `boolean`                     | `true`                                                                   | Generates `x-request-id` where the request-id middleware is mounted                                              |
| `http.excludePaths`                 | `RegExp[]`                    | `[/^\/health$/, /^\/health\/live$/, /^\/health\/ready$/, /^\/metrics$/]` | Do not log healthchecks                                                                                          |
| `http.tenantIdHeader`               | `string \| false`             | `'x-tenant-id'`                                                          | Header for multi-tenant context                                                                                  |
| `otel.shouldAutoInjectTraceContext` | `boolean`                     | `true`                                                                   | Injects `traceId`/`spanId`/`traceFlags` when `@opentelemetry/api` resolves                                       |
| `otel.traceIdField`                 | `string`                      | `'traceId'` (or `'trace_id'` if `fieldFormat: 'snake_case'`)             | Field name in the log                                                                                            |
| `otel.spanIdField`                  | `string`                      | `'spanId'` (or `'span_id'`)                                              | Field name in the log                                                                                            |
| `otel.traceFlagsField`              | `string`                      | `'traceFlags'` (or `'trace_flags'`)                                      | Field name in the log                                                                                            |
| `otel.fieldFormat`                  | `'camelCase' \| 'snake_case'` | `'camelCase'`                                                            | Shortcut to align with OTel Logs Data Model (`snake_case`) or Pino-native (`camelCase`)                          |
| `maxEntrySizeBytes`                 | `number`                      | `65536` (64KB)                                                           | Ceiling per serialized field, not per entry (§17.7)                                                              |
| `serializers`                       | `Record<string, fn>`          | `{}` (merged with defaults)                                              | Default: `err`                                                                                                   |
| `timestamp`                         | `() => string`                | `() => new Date().toISOString()`                                         | Custom override                                                                                                  |

### 4.3 `applyDefaults()` — how `otel.fieldFormat` becomes individual field names

The lib normalizes user-supplied options through a small `applyDefaults()` pass before constructing Pino. The relevant rule for `otel.fieldFormat`:

> When `otel.fieldFormat === 'snake_case'`, `applyDefaults()` sets
> `traceIdField = 'trace_id'`, `spanIdField = 'span_id'`, `traceFlagsField = 'trace_flags'`
> **unless** those keys are already provided by the consumer. **Individual fields always win over `fieldFormat`** — explicit `traceIdField: 'my_trace'` is preserved even if `fieldFormat: 'snake_case'`.

Pseudo-implementation:

```typescript
import type { ResolvedBymaxLoggerModuleOptions } from '@bymax-one/nest-logger'

function applyDefaults(opts: BymaxLoggerModuleOptions): ResolvedBymaxLoggerModuleOptions {
  const fieldFormat = opts.otel?.fieldFormat ?? 'camelCase'
  const snakeCase = fieldFormat === 'snake_case'

  const traceIdField = opts.otel?.traceIdField ?? (snakeCase ? 'trace_id' : 'traceId')
  const spanIdField = opts.otel?.spanIdField ?? (snakeCase ? 'span_id' : 'spanId')
  const traceFlagsField = opts.otel?.traceFlagsField ?? (snakeCase ? 'trace_flags' : 'traceFlags')

  return { ...opts, otel: { ...opts.otel, traceIdField, spanIdField, traceFlagsField } }
}
```

The trace mixin (§11.1.1) receives these three names in its options object.

### 4.4 Sync `forRoot` example

```typescript
import { Module } from '@nestjs/common'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: {
        name: 'my-app',
        version: process.env.RELEASE_SHA ?? 'dev'
      },
      level: 'info',
      redactPaths: ['*.cardNumber', '*.cvv', 'body.creditCard.*'],
      http: {
        isEnabled: true,
        excludePaths: [/^\/health$/, /^\/metrics$/, /^\/favicon\.ico$/]
      }
    })
  ]
})
export class AppModule {}
```

### 4.5 `forRootAsync` example with `ConfigService`

```typescript
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'
import { LokiDestination } from './observability/loki.destination'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BymaxLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        service: {
          name: config.getOrThrow('OTEL_SERVICE_NAME'),
          version: config.getOrThrow('RELEASE_SHA')
        },
        level: config.get('LOG_LEVEL') ?? 'info',
        redactPaths: (config.get('LOG_EXTRA_REDACT_PATHS') ?? '').split(',').filter(Boolean),
        http: {
          isEnabled: true,
          tenantIdHeader: config.get('TENANT_ID_HEADER') ?? 'x-tenant-id'
        },
        destinations:
          config.get('NODE_ENV') === 'production'
            ? [new LokiDestination({ url: config.getOrThrow('LOKI_URL') })]
            : []
      })
    })
  ]
})
export class AppModule {}
```

### 4.6 Injection tokens

```typescript
export const LOGGER_OPTIONS_TOKEN = Symbol('BYMAX_LOGGER_OPTIONS')
export const LOGGER_PINO_INSTANCE_TOKEN = Symbol('BYMAX_LOGGER_PINO_INSTANCE')
export const LOGGER_DESTINATIONS_TOKEN = Symbol('BYMAX_LOGGER_DESTINATIONS')
export const LOG_CONTEXT_TOKEN = Symbol('BYMAX_LOGGER_LOG_CONTEXT')
export const LOGGER_REDACTOR_TOKEN = Symbol('BYMAX_LOGGER_REDACTOR')
export const LOGGER_OBSERVABILITY_TOKEN = Symbol.for('BYMAX_LOGGER_OBSERVABILITY')
```

> **Why `Symbol()`?** Avoids collision with tokens from other libs (strings may collide; symbols are unique). Pattern inherited from `@bymax-one/nest-auth`.

---

## 5. Destination Contracts

### 5.1 `ILogDestination` interface

Destinations receive every log already serialized as JSON and write wherever they want. The interface is intentionally minimal:

```typescript
export interface ILogDestination {
  /**
   * Unique name for logging/debugging purposes.
   */
  readonly name: string

  /**
   * Minimum level this destination accepts.
   * If undefined, accepts everything sent to it.
   */
  readonly minLevel?: LogLevel

  /**
   * Called for every log entry. Implementations should be non-blocking.
   * Receives the already-JSON-stringified payload.
   *
   * @param payload - Final JSON string (UTF-8) representing one log entry, including trailing newline.
   */
  write(payload: string): void | PromiseLike<void>

  /**
   * Bytes the destination still holds, if it can say.
   */
  queuedBytes?(): number

  /**
   * Called once during NestJS bootstrap. Use for opening connections, buffers, etc.
   */
  onInit?(): void | PromiseLike<void>

  /**
   * Called once after EVERY destination's `onInit` has settled, and awaited.
   *
   * It runs for EVERY registered destination, including one whose own `onInit`
   * rejected — a sink that failed to initialize is exactly the one most likely to
   * be holding entries it now has to resolve, so skipping it would strand them.
   *
   * Only useful to a destination holding entries written before its own `onInit` ran:
   * `heldEntriesDeliveredElsewhere` says whether another live sink appears to have
   * taken them, so a held copy can be dropped instead of duplicating a line. It is
   * a DEDUPLICATION SIGNAL, not a proof — writes still queued inside the Writable
   * adapter are not represented in it, so `true` can precede a queued write that
   * later fails. The library's destinations dedupe on it because a duplicated line
   * beats a lost one; a destination that cannot tolerate any loss should always
   * emit.
   */
  onRegistryReady?(status: {
    readonly heldEntriesDeliveredElsewhere: boolean
  }): void | PromiseLike<void>

  /**
   * Called during NestJS `onApplicationShutdown`. MUST flush pending writes and close resources.
   */
  onShutdown?(): void | PromiseLike<void>
}
```

### 5.2 Adapter mapping — wrapping `ILogDestination` for `pino.multistream`

`ILogDestination` exposes a simple `write(payload: string)` method, but Pino's `multistream` API expects Node `Writable` streams. `destinationToStream` (`src/server/utils/destination-to-stream.ts`) wraps each destination in a bounded `Writable`:

- A write that throws or rejects drops that entry and is reported to stderr, throttled, as `LOGGER_DESTINATION_WRITE_FAILED`.
- Entries beyond `destinationQueue.maxBytes` are dropped and counted.
- A destination whose `onInit` failed is skipped, or its entries are rescued to stdout when no destination initialized.

The factory pairs each stream with a level (`minLevel`, else the module level) and passes the list to `pino.multistream`, which filters by level.

### 5.3 Default destination — `DefaultStdoutDestination`

Used only when `destinations` is empty:

```typescript
import { writeStdoutSafely } from '../utils/safe-stdio.util'

@Injectable()
export class DefaultStdoutDestination implements ILogDestination {
  readonly name = 'stdout-json'
  readonly minLevel?: LogLevel

  constructor(opts: { minLevel?: LogLevel } = {}) {
    if (opts.minLevel !== undefined) {
      this.minLevel = opts.minLevel
    }
  }

  queuedBytes(): number {
    return process.stdout.writableLength
  }

  write(payload: string): void {
    writeStdoutSafely(payload)
  }
}
```

### 5.4 Dev destination — `PrettyDevDestination`

Opt in with `destinations: [new PrettyDevDestination()]` (options: `minLevel`, `view`). It renders through `pino-pretty`, an **optional peer dependency** that `onInit` loads, and it refuses `NODE_ENV=production`. When `onInit` throws, for that reason or because the package is missing, the registry reports `LOGGER_DESTINATION_INIT_FAILED` on stderr and skips it; entries fall back to raw NDJSON on stdout only if no destination initializes.

### 5.5 Adapter example — Grafana Loki

```typescript
import { ILogDestination, LogLevel } from '@bymax-one/nest-logger'

interface LokiDestinationOptions {
  url: string // e.g., 'https://logs-prod.grafana.net/loki/api/v1/push'
  username?: string // Basic auth (optional)
  password?: string
  batchSize?: number // @default 100
  flushIntervalMs?: number // @default 5000
  labels?: Record<string, string> // Fixed Loki labels (e.g., { service: 'my-app' })
}

export class LokiDestination implements ILogDestination {
  readonly name = 'loki'
  private buffer: { ts: string; line: string }[] = []
  private flushTimer?: NodeJS.Timeout

  constructor(private readonly opts: LokiDestinationOptions) {}

  onInit(): void {
    const interval = this.opts.flushIntervalMs ?? 5000
    this.flushTimer = setInterval(() => void this.flush(), interval)
  }

  write(payload: string): void {
    this.buffer.push({ ts: Date.now() + '000000', line: payload.trim() })
    if (this.buffer.length >= (this.opts.batchSize ?? 100)) {
      void this.flush()
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0, this.buffer.length)

    const body = {
      streams: [
        {
          stream: { ...this.opts.labels },
          values: batch.map(({ ts, line }) => [ts, line])
        }
      ]
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.opts.username && this.opts.password) {
      const token = Buffer.from(`${this.opts.username}:${this.opts.password}`).toString('base64')
      headers['authorization'] = `Basic ${token}`
    }

    try {
      await fetch(this.opts.url, { method: 'POST', headers, body: JSON.stringify(body) })
    } catch {
      // Fail silent — never crash the app because of log delivery failure.
      // Production deployments should pair with a deadletter mechanism if losing logs is unacceptable.
    }
  }

  async onShutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    await this.flush()
  }
}
```

### 5.6 Adapter example — custom Postgres (legacy)

For projects that want to keep persistence in Postgres (not recommended for high volumes, but supported):

```typescript
import { ILogDestination } from '@bymax-one/nest-logger'
import type { PrismaClient } from '@prisma/client'

export class PrismaPostgresDestination implements ILogDestination {
  readonly name = 'postgres'
  private buffer: Record<string, unknown>[] = []
  private flushTimer?: NodeJS.Timeout

  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: { batchSize?: number; flushIntervalMs?: number } = {}
  ) {}

  onInit(): void {
    const interval = this.opts.flushIntervalMs ?? 2000
    this.flushTimer = setInterval(() => void this.flush(), interval)
  }

  write(payload: string): void {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(payload) as Record<string, unknown>
    } catch {
      // Skip malformed entry — never crash logger
      return
    }
    this.buffer.push(entry)
    if (this.buffer.length >= (this.opts.batchSize ?? 50)) {
      void this.flush()
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0, this.buffer.length)
    try {
      await this.prisma.log.createMany({
        data: batch.map((entry) => ({
          level: String(entry.level ?? 'info'),
          message: String(entry.msg ?? ''),
          logKey: String(entry.logKey ?? 'unknown'),
          metadata: entry,
          timestamp: new Date(String(entry.time))
        })),
        skipDuplicates: true
      })
    } catch {
      // Fail silent
    }
  }

  async onShutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    await this.flush()
  }
}
```

### 5.7 Adapter example — Rolling file (`pino-roll`)

```typescript
import { ILogDestination } from '@bymax-one/nest-logger'
import { Writable } from 'node:stream'
import pinoRoll from 'pino-roll'

export class RollingFileDestination implements ILogDestination {
  readonly name = 'rolling-file'
  private stream!: Writable

  constructor(
    private readonly opts: { file: string; frequency: 'daily' | 'hourly'; size?: string }
  ) {}

  async onInit(): Promise<void> {
    this.stream = await pinoRoll({
      file: this.opts.file,
      frequency: this.opts.frequency,
      size: this.opts.size,
      mkdir: true
    })
  }

  write(payload: string): void {
    this.stream.write(payload)
  }

  async onShutdown(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve))
  }
}
```

---

## 6. Services

### 6.1 `PinoLoggerService` — main API

Implements the official `LoggerService` interface from `@nestjs/common` (which has variadic `(message, ...optionalParams)` signatures) **and** adds a more ergonomic "typed" structured API.

The Nest-style methods take `message: unknown, ...optionalParams: unknown[]`. The snippet below shows only the public surface (method bodies elided with `{ ... }`); the full implementation is in `pino-logger.service.ts`.

```typescript
import { Injectable, LoggerService as NestLoggerService, OnApplicationShutdown, Scope } from '@nestjs/common'
import { Logger as PinoLogger } from 'pino'

@Injectable({ scope: Scope.DEFAULT })
export class PinoLoggerService implements NestLoggerService, OnApplicationShutdown {
  /**
   * Internal Pino instance. Exposed via `getRawLogger()` for power users.
   */
  private readonly pino: PinoLogger

  /**
   * Context attached to every log emitted by this instance. Set via `setContext()`.
   */
  private context?: string

  // ─── NestJS LoggerService interface ─────────────────────────────────────

  /**
   * Logs an info-level message.
   * Supports both NestJS variadic signature and structured object signature.
   *
   * @example
   *   logger.log('User created')                    // NestJS variadic
   *   logger.log('User created', 'UsersService')    // with context override
   *   logger.log({ message: 'User created', orderId }) // object: its keys become fields
   */
  log(message: unknown, ...optionalParams: unknown[]): void { ... }

  /**
   * Logs an error: NestJS signature error(message, stack?, context?). An error-like `message`,
   * or an `Error` among the other arguments, is logged as `err`; a plain object becomes fields.
   * For a log key and a user id use `errorStructured`.
   */
  error(message: unknown, ...optionalParams: unknown[]): void { ... }

  warn(message: unknown, ...optionalParams: unknown[]): void { ... }
  debug(message: unknown, ...optionalParams: unknown[]): void { ... }
  verbose(message: unknown, ...optionalParams: unknown[]): void { ... }
  fatal(message: unknown, ...optionalParams: unknown[]): void { ... }

  // ─── Structured API (recommended for new code) ──────────────────────────

  /**
   * Emit a structured info log following the MODULE_ACTION_RESULT convention.
   *
   * @param logKey - Convention: 'MODULE_ACTION_RESULT' (e.g. 'USER_CREATED', 'AUTH_LOGIN_FAILED').
   * @param message - Human-readable message.
   * @param userId - Optional user identifier (added to log entry).
   * @param metadata - Optional extra structured fields.
   *
   * @example
   *   logger.info('USER_CREATED', 'New user registered', userId, { plan: 'pro' })
   */
  info(logKey: string, message: string, userId?: string, metadata?: Record<string, unknown>): void { ... }

  /**
   * Structured warn — same signature as `info`.
   */
  warnStructured(logKey: string, message: string, userId?: string, metadata?: Record<string, unknown>): void { ... }

  /**
   * Structured error — accepts Error and extracts stack/message safely.
   */
  errorStructured(logKey: string, error: Error, userId?: string, metadata?: Record<string, unknown>): void { ... }

  // ─── Power user escape hatches ──────────────────────────────────────────

  /**
   * Set the `context` field that is added to every log emitted by this instance.
   * On the shared logger it overwrites the context for every holder; for a context per
   * class use `@InjectLogger(name)`.
   */
  setContext(context: string): void { ... }

  /**
   * Create a child logger with bound key/value pairs.
   * Useful for per-job, per-request, per-user loggers.
   *
   * Semantics:
   *  - Returns a NEW `PinoLoggerService` instance over a Pino child created with the redacted bindings.
   *  - The child INHERITS the same `LogContextService` reference (ALS is process-wide,
   *    not per-child) — so `requestId` / `tenantId` / `userId` propagate to the child too.
   *  - The child has its OWN bindings merged into every log it emits.
   *  - Calling `getRawLogger()` on the child returns the underlying Pino child instance.
   *  - `setContext()` on the child only changes the child's `context` field — it does
   *    NOT mutate the parent. Each instance owns its `context` field independently.
   *
   * @example
   *   const jobLogger = logger.child({ jobId: 'job_123', jobType: 'email-send' })
   *   jobLogger.info('JOB_STARTED', 'Sending email')
   *   // → emits { jobId: 'job_123', jobType: 'email-send', logKey: 'JOB_STARTED', ... }
   */
  child(bindings: Record<string, unknown>): PinoLoggerService { ... }

  /**
   * Returns the underlying Pino instance. Use for advanced Pino features
   * not exposed by this service (e.g., `level()`, `levels`, custom serializers at runtime).
   */
  getRawLogger(): PinoLogger { ... }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  onApplicationShutdown(): void {
    // Empty: `DestinationRegistry` shuts the destinations down.
  }
}
```

### 6.2 `LogContextService` — propagation via AsyncLocalStorage

```typescript
import { Injectable } from '@nestjs/common'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface LogContext {
  requestId?: string
  tenantId?: string
  userId?: string
  traceId?: string
  spanId?: string
  [key: string]: unknown
}

// The interface is exported from the package as `LogContextBag`.
@Injectable()
export class LogContextService {
  private readonly als = new AsyncLocalStorage<LogContext>()

  /**
   * Run a callback inside a context scope. All logs emitted within the callback
   * (synchronously or asynchronously) inherit the context. Prototype-polluting keys are
   * stripped, and the new scope replaces any enclosing one.
   */
  run<T>(context: LogContext, callback: () => T): T {
    return this.als.run(this.sanitizeContext(context), callback)
  }

  /** Like `run`, but the enclosing scope's fields are kept under the new ones. */
  runMerged<T>(context: LogContext, callback: () => T): T { ... }

  /** Copies the context without prototype-polluting keys. */
  private sanitizeContext(context: LogContext): LogContext { ... }

  /**
   * Returns the current context, or `undefined` if outside any scope.
   */
  getStore(): LogContext | undefined {
    return this.als.getStore()
  }

  /**
   * Add or override fields in the current context (mutates the active store).
   * Throws if called outside a `run()` scope, or for a prototype-polluting key.
   */
  set(key: string, value: unknown): void {
    const store = this.als.getStore()
    if (!store) throw new Error('[LogContextService] set() called outside run() scope')
    // (an unsafe key throws here)
    store[key] = value
  }

  /**
   * Reads a single field from the current context.
   */
  get<T = unknown>(key: string): T | undefined {
    return this.als.getStore()?.[key] as T | undefined
  }
}
```

### 6.3 `DestinationRegistry` — internal, not exported

Manages the lifecycle of the registered destinations (`src/server/services/destination-registry.service.ts`).

On bootstrap it runs each `onInit` in order under `destinationHookTimeoutMs`, marks failures and reports them to stderr as `LOGGER_DESTINATION_INIT_FAILED`, runs `onRegistryReady`, then logs `LOGGER_BOOTSTRAP_OK`. It also logs `LOGGER_BOOTSTRAP_WARNING` when the default redaction is disabled, or when trace injection is on and `@opentelemetry/api` does not resolve.

On shutdown it logs `LOGGER_SHUTDOWN_OK`, then within `shutdown.timeoutMs` drains the queues (at most `shutdown.drainTimeoutMs`) and calls `onShutdown` in reverse order on the destinations that initialized. It reports failed hooks (`LOGGER_DESTINATION_SHUTDOWN_FAILED`), skipped hooks and drop totals on stderr.

### 6.4 `BymaxLoggerModule.useNestLogger(app)` — wiring the lib as NestJS's logger

The `shouldUseAsNestLogger` option is deprecated and has no effect; call this helper. Because the lib lives inside a module and cannot reach the `INestApplication` instance, the **runtime wiring** must happen in `main.ts`. The lib exposes a static helper for it:

```typescript
import type { INestApplication } from '@nestjs/common'
import { PinoLoggerService } from './services/pino-logger.service'

export class BymaxLoggerModule extends BymaxLoggerModuleBase {
  // ... forRoot / forRootAsync from §2.1

  /**
   * Replace NestJS's internal logger with this lib's PinoLoggerService and flush
   * any buffered logs accumulated since `NestFactory.create({ bufferLogs: true })`.
   *
   * Call once in `main.ts` after `NestFactory.create(...)`.
   *
   * @param app The Nest application instance returned by NestFactory.create()
   */
  static useNestLogger(app: INestApplication): void {
    let logger: PinoLoggerService
    try {
      logger = app.get(PinoLoggerService, { strict: false })
    } catch (cause) {
      throw new Error(
        '[BymaxLoggerModule] useNestLogger(app) called but BymaxLoggerModule was not imported',
        { cause }
      )
    }
    app.useLogger(logger)
    app.flushLogs()
  }
}
```

Consumer usage:

```typescript
// apps/backend/src/main.ts
const app = await NestFactory.create(AppModule, { bufferLogs: true })
BymaxLoggerModule.useNestLogger(app) // replaces NestJS internal logger + flushes buffer
await app.listen(3000)
```

> **Why a helper?** The lib cannot call `app.useLogger()` itself because a module does not see the `INestApplication`.

---

## 7. Interceptors

### 7.1 `HttpLoggingInterceptor`

Logs the full HTTP request lifecycle. Normalizes URLs to avoid an explosion of distinct `url` values (`/users/123` and `/users/456` both become `/users/:id`).

The source is `src/server/interceptors/http-logging.interceptor.ts`.

- A request that the access-log middleware already records is left to it: the interceptor only records a thrown error.
- A path that matches `http.excludePaths` is not logged.
- On entry it emits `HTTP_REQUEST_START` with `method`, the normalized `url`, `fullUrl` (query string removed, secret path segments scrubbed), `ip` and `userAgent`.
- On completion it emits `HTTP_REQUEST_SUCCESS` (2xx) or `HTTP_REQUEST_REDIRECT` (3xx).
- On a thrown value it emits `HTTP_REQUEST_CLIENT_ERROR` (warn: an `HttpException` below 500, or an `http-errors` error that exposes a 4xx) or `HTTP_REQUEST_SERVER_ERROR` (error: anything else), and re-throws it.

### 7.2 URL normalization algorithm

The internal `normalizeUrl(url, extra)` (not exported from the package) removes the query string, replaces credential-looking path segments (long hex, JWT, long opaque token, email, and matches of `http.secretPathSegments`) with `:redacted`, then collapses UUIDs, ULIDs, 21-character nanoids and leading digits of a segment to `/:id`. If the built-ins it relies on were replaced, the whole path becomes `/:redacted`.

### 7.3 Registration as a global interceptor

When `http.isEnabled: true`, `forRoot` registers it via `APP_INTERCEPTOR`:

```typescript
// Internally in logger.module.ts:
{
  provide: APP_INTERCEPTOR,
  useClass: HttpLoggingInterceptor,
}
```

`forRootAsync` always registers a factory, which returns `HttpLoggingInterceptor` or a pass-through once the options are known.

---

## 8. Filters

### 8.1 `HttpExceptionFilter`

A catch-all filter: it logs any exception that escapes the request pipeline and writes the JSON response. The source is `src/server/filters/http-exception.filter.ts`.

| Thrown value                           | Entry                              | Response                    |
| -------------------------------------- | ---------------------------------- | --------------------------- |
| `HttpException` below 500              | `HTTP_EXCEPTION_HANDLED` (warn)    | its own `getResponse()`     |
| `HttpException` of 500 or more         | `HTTP_EXCEPTION_UNHANDLED` (error) | its own `getResponse()`     |
| `http-errors` shape that exposes a 4xx | `HTTP_EXCEPTION_HANDLED` (warn)    | `{ statusCode, message }`   |
| anything else                          | `HTTP_EXCEPTION_UNHANDLED` (error) | a fixed 500 body, no detail |

`BymaxLoggerModule.forRoot` registers it when `http.isEnabled` and `http.shouldCaptureExceptions` are both set; `forRootAsync` does not register it.

#### Two entries per failed request

The filter and the access log do not suppress each other. With both active, a handler that throws produces the filter's `HTTP_EXCEPTION_*` entry (what failed) and the request's terminal `HTTP_REQUEST_CLIENT_ERROR` or `HTTP_REQUEST_SERVER_ERROR` entry (how it ended, with `duration`). `HTTP_REQUEST_COMPLETED` is reserved and never emitted.

---

## 9. Decorators

### 9.1 `@InjectLogger()`

Convenience to avoid repeating `@Inject(PinoLoggerService)` in constructors. When given a name, it injects a **child logger** bound to that context — no singleton mutation, no request scope required.

#### Implementation mechanism

With a name, the decorator injects the token `getContextLoggerToken(name)`; the module registers one provider per distinct name, which returns `rootLogger.child({ context: name })`. Without a name it injects the root `PinoLoggerService`, which has no context.

> **Why a child logger and not a request-scoped one?** The child is created once and shared by every injection point that uses the same name, so no `Scope.REQUEST` is needed. The request fields still come from `LogContextService`.

Usage:

```typescript
@Injectable()
export class UsersService {
  constructor(@InjectLogger(UsersService.name) private readonly logger: PinoLoggerService) {}

  async create(dto: CreateUserDto) {
    this.logger.info('USER_CREATE_START', 'Creating user', undefined, { email: dto.email })
    // → emits { context: 'UsersService', logKey: 'USER_CREATE_START', ... }
  }
}
```

### 9.2 `@LogContext(name)` (deprecated)

A class decorator that stores `name` as metadata under `LOG_CONTEXT_METADATA_KEY` (`'bymax_logger:log_context'`). Nothing in this package reads that metadata, so no entry carries the label. For a context per class use `@InjectLogger(name)` (§9.1).

### 9.3 `@LogPerformance(thresholdMs?)`

Method decorator. Logs execution duration. If the duration exceeds `thresholdMs`, it raises the level to `warn` (`METHOD_SLOW_EXECUTION`).

The method is wrapped in an async function. When `this.logger` is present it logs `METHOD_EXECUTION`, or `METHOD_SLOW_EXECUTION` at `warn` when the duration exceeds `thresholdMs` (default 1000). A non-finite or negative threshold throws `TypeError`, and a failure while logging does not affect the method.

> Requires `this.logger` to be an instance of `PinoLoggerService` (usually by injection). The decorator fails silently if `logger` is not present — it does not force a pattern.

---

## 10. PII Redaction Strategy

### 10.1 Default list — `DEFAULT_REDACT_PATHS`

Under the default `redactStrategy: 'names'`, the library's own walk censors a sensitive name at any depth. `DEFAULT_REDACT_PATHS` is the path form of the same list: each of the 62 names in `REDACT_COMMON_FIELDS` bare and at depths 1 to 4, plus five absolute header paths, 315 paths in all. The opt-in `'paths'` strategy hands them to Pino `redact` (`@pinojs/redact`), where `*` matches a single level. The names are in `src/server/constants/default-redact-paths.constants.ts`.

> Under the default strategy only the consumer's `redactPaths` reach `pino.redact`. `compileRedactPaths` is internal.

### 10.2 How to extend

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  redactPaths: [
    '*.internalSecret', // adds
    'payload.user.taxId' // under the default strategy `taxId` is also censored at any depth
  ]
})
```

The lib **merges** with `DEFAULT_REDACT_PATHS` (does not replace). To fully replace:

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  shouldDisableDefaultRedact: true, // discards defaults
  redactPaths: ['*.password'] // only consumer names remain: `password`, at any depth
})
```

⚠️ `shouldDisableDefaultRedact: true` is recorded as a warning in the bootstrap log for security-review auditing.

### 10.3 Performance

Pino's `redact` option is implemented by `@pinojs/redact`. The history of the default is below.

Superseded in `1.2.0`. Path-based redaction was measured at ~107 µs per entry (~9.3 k logs/s),
not the ~3% the official benchmark suggests — the cost grows with the PATH COUNT, and the default
list expanded to 140 at the time. The default is now a name-keyed snapshotting walk at ~3.6 µs per entry; the
path expansion survives for consumer `redactPaths` and the opt-in `redactStrategy: 'paths'`.
See `docs/guidelines/PINO-REDACTION-GUIDELINES.md` and `bench/README.md`.

### 10.4 Customizable censor

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  redactCensor: '***'
})
```

`redactCensor` is a string. A function is refused at startup (§17.6).

### 10.5 Audit — checking paths at runtime

```typescript
// For debugging in dev:
import { Inject, Injectable } from '@nestjs/common'
import { LOGGER_OPTIONS_TOKEN, type BymaxLoggerModuleOptions } from '@bymax-one/nest-logger'

@Injectable()
class LogAuditService {
  constructor(@Inject(LOGGER_OPTIONS_TOKEN) private readonly opts: BymaxLoggerModuleOptions) {}

  // Consumer paths only; the default coverage is REDACT_COMMON_FIELDS.
  listConfiguredRedactPaths(): string[] {
    return [...(this.opts.redactPaths ?? [])]
  }
}
```

---

## 11. OpenTelemetry Integration

### 11.1 Detecting active OTel

`@opentelemetry/api` is an **optional peer dependency**. It is resolved synchronously with `createRequire`, anchored on the package's own location and then on `process.cwd()` (`src/server/utils/otel-detector.ts`). When it is absent the detector is silent; when it is installed but fails to load, `LOGGER_OTEL_API_BROKEN` is written to stderr once.

**Behavior without OTel:** the lib logs normally, with no `traceId`/`spanId`.
**Behavior with OTel but no active span:** the lib logs without `traceId`/`spanId` (because there is no contextualized trace).
**Behavior with OTel + active span:** the lib injects `traceId`/`spanId` into every entry.

#### 11.1.1 The trace context mixin

`createTraceContextMixin` (`src/server/mixins/trace-context.mixin.ts`) builds the single mixin. It merges the `LogContextService` store first and the active span's `traceId`, `spanId` and `traceFlags` last, so the span wins over a same-named context key. The ids are validated before use, and a failure inside the mixin does not break the log call.

> **Why one mixin instead of two?** Pino accepts a single `mixin` option per logger. Composing both in one function keeps merge precedence explicit and avoids ordering surprises if Pino changes how multiple mixins are layered in the future.

> **Why ALS first, OTel last?** If the ALS scope was opened with a `traceId` (e.g., propagated manually from a queue consumer) and OTel has since started a new span, the OTel span ID is the truth on the wire for this exact log call. The order makes that explicit and testable.

### 11.2 Recommended consumer setup (`apps/.../main.ts`)

The lib **does not initialize** OTel — that's the consumer's responsibility **before** `NestFactory.create()`. Canonical setup:

```typescript
// apps/backend/src/main.ts (TOP OF FILE — before any NestJS import)
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
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTLP_TRACE_ENDPOINT
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false } // noisy, disable
    })
  ]
})

sdk.start()

// Shut the SDK down only after `await app.close()` (see §18.2 and §17.3).
```

### 11.3 `@opentelemetry/instrumentation-pino` (recommended)

Official OTel package that adds spanContext propagation to **any** Pino instance — useful when you have other Pino loggers outside the lib (e.g., standalone scripts).

```typescript
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino'

const sdk = new NodeSDK({
  // ...
  instrumentations: [
    getNodeAutoInstrumentations(),
    new PinoInstrumentation({
      logKeys: { traceId: 'traceId', spanId: 'spanId', traceFlags: 'traceFlags' }
    })
  ]
})
```

The `nest-logger` lib does the equivalent internally via a custom mixin. Adding `PinoInstrumentation` is **redundant but does not conflict**.

### 11.4 Cross-service correlation — W3C `traceparent`

For correlation between services (Service A calls Service B), the W3C `traceparent` header is the standard. The `auto-instrumentations-node` handles this for HTTP client/server automatically. For custom HTTP clients (e.g., Stripe SDK), instrument manually:

```typescript
import { propagation, context } from '@opentelemetry/api'

const headers: Record<string, string> = { ... }
propagation.inject(context.active(), headers)
// 'headers' now has traceparent injected
```

### 11.5 Sentry — does not replace OTel

bymax.finance references Sentry as an error sink. The integration is **not** via the lib (Sentry is the consumer's responsibility); the lib only ensures that emitted structured logs go to its configured destination. To send errors to Sentry, we recommend:

- `@sentry/node` installed in the consumer
- Sentry receives via OpenTelemetry (`@sentry/opentelemetry`) — automatic propagation. The legacy `@sentry/opentelemetry-node` package is deprecated; use `@sentry/opentelemetry` (current).

This lib does **not** depend on or install Sentry.

---

## 12. Log Keys Convention

### 12.1 `MODULE_ACTION_RESULT` format

All structured log calls follow the `MODULE_ACTION_RESULT` format:

- **MODULE**: domain/subsystem (`USER`, `AUTH`, `PAYMENT`, `WEBHOOK`)
- **ACTION**: operation (`LOGIN`, `CREATE`, `UPDATE`, `DELETE`, `PROCESS`)
- **RESULT**: outcome (`SUCCESS`, `FAILED`, `SKIPPED`, `START`)

Valid examples:

- `USER_LOGIN_SUCCESS`
- `AUTH_REGISTER_FAILED`
- `PAYMENT_REFUND_PROCESSED`
- `WEBHOOK_STRIPE_RECEIVED`
- `WEBHOOK_STRIPE_SIGNATURE_INVALID`

**Invalid** examples (do not follow the convention):

- `userLogin` (camelCase)
- `LOGIN_SUCCESS` (missing module; a convention only, since the regex accepts two words)
- `STARTED` (missing module and action)

### 12.2 Validation regex (exported in `./shared`)

```typescript
// src/shared/constants/log-keys-convention.constants.ts
export const LOG_KEYS_CONVENTION_REGEX = /^[A-Z][A-Z0-9_]+_[A-Z][A-Z0-9_]+(_[A-Z][A-Z0-9_]+)?$/
```

Optional CI usage:

```typescript
function isValidLogKey(key: string): boolean {
  return LOG_KEYS_CONVENTION_REGEX.test(key)
}
```

### 12.3 Log keys reserved by the lib

```typescript
// src/shared/constants/reserved-log-keys.constants.ts
export const RESERVED_LOG_KEYS = Object.freeze({
  LOGGER_BOOTSTRAP_OK: 'LOGGER_BOOTSTRAP_OK',
  LOGGER_BOOTSTRAP_WARNING: 'LOGGER_BOOTSTRAP_WARNING',
  LOGGER_SHUTDOWN_OK: 'LOGGER_SHUTDOWN_OK',
  HTTP_REQUEST_START: 'HTTP_REQUEST_START',
  HTTP_REQUEST_SUCCESS: 'HTTP_REQUEST_SUCCESS',
  HTTP_REQUEST_REDIRECT: 'HTTP_REQUEST_REDIRECT',
  HTTP_REQUEST_CLIENT_ERROR: 'HTTP_REQUEST_CLIENT_ERROR',
  HTTP_REQUEST_SERVER_ERROR: 'HTTP_REQUEST_SERVER_ERROR',
  HTTP_REQUEST_COMPLETED: 'HTTP_REQUEST_COMPLETED',
  HTTP_REQUEST_ABORTED: 'HTTP_REQUEST_ABORTED',
  HTTP_EXCEPTION_HANDLED: 'HTTP_EXCEPTION_HANDLED',
  HTTP_EXCEPTION_UNHANDLED: 'HTTP_EXCEPTION_UNHANDLED',
  HTTP_UNEXPECTED_ERROR: 'HTTP_UNEXPECTED_ERROR',
  HTTP_UNEXPECTED_ERROR_DROPPED: 'HTTP_UNEXPECTED_ERROR_DROPPED',
  METHOD_EXECUTION: 'METHOD_EXECUTION',
  METHOD_SLOW_EXECUTION: 'METHOD_SLOW_EXECUTION',
  LOGGER_DESTINATION_INIT_FAILED: 'LOGGER_DESTINATION_INIT_FAILED',
  LOGGER_DESTINATION_WRITE_FAILED: 'LOGGER_DESTINATION_WRITE_FAILED',
  LOGGER_DESTINATION_SHUTDOWN_FAILED: 'LOGGER_DESTINATION_SHUTDOWN_FAILED',
  LOGGER_ENTRY_TRUNCATED: 'LOGGER_ENTRY_TRUNCATED',
  LOGGER_REDACTION_FAILED: 'LOGGER_REDACTION_FAILED',
  LOGGER_OTEL_API_BROKEN: 'LOGGER_OTEL_API_BROKEN'
} as const)
```

> **Count: 22 reserved keys.** Apps must not reuse these keys to avoid collision in log queries. `HTTP_REQUEST_COMPLETED` is reserved and never emitted.

---

## 13. Error Code Catalog

Errors the lib may throw (or record as a warning). The names of thrown errors are labels of this table, not strings to query; the OpenTelemetry case is written as `LOGGER_BOOTSTRAP_WARNING` with `reason: 'OTEL_API_UNAVAILABLE'`.

| Code                              | Severity                                                                   | When it occurs                                                                   | Recommended action                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `LOGGER_INVALID_OPTIONS`          | Throws at initialization                                                   | `service.name` or `service.version` missing                                      | Add the required fields                                                                                                       |
| `LOGGER_INVALID_LEVEL`            | Throws                                                                     | `level` is not a valid Pino value                                                | Use `'fatal'\|'error'\|'warn'\|'info'\|'debug'\|'trace'`                                                                      |
| `LOGGER_PRETTY_UNAVAILABLE`       | **Never emitted**                                                          | Not declared in the source                                                       | Do not query it — the real signal is `LOGGER_DESTINATION_INIT_FAILED` on stderr, `destination: "pretty-dev"`                  |
| `LOGGER_OTEL_API_UNAVAILABLE`     | Warn on bootstrap                                                          | `otel.shouldAutoInjectTraceContext: true` but `@opentelemetry/api` not installed | Install or disable `shouldAutoInjectTraceContext`                                                                             |
| `LOGGER_DESTINATION_INIT_FAILED`  | Written to **stderr**                                                      | `destination.onInit()` rejects                                                   | Destination is dropped from the write fan-out; others continue. If NONE initialize, entries fall back to raw NDJSON on stdout |
| `LOGGER_DESTINATION_WRITE_FAILED` | Written to **stderr**                                                      | `destination.write()` throws                                                     | Entry skipped for that destination; others continue                                                                           |
| `LOGGER_CONTEXT_OUT_OF_SCOPE`     | Throws                                                                     | `LogContextService.set()` called outside `run()`                                 | Wrap in `logContext.run({ ... }, () => ...)`                                                                                  |
| `LOGGER_ENTRY_TRUNCATED`          | `_logKey` of the envelope that replaces a field; the entry keeps its level | A serialized field exceeds `maxEntrySizeBytes` or cannot be measured             | Reduce the payload or raise the limit                                                                                         |

---

## 14. What is NOT in the package

The lib is intentionally focused on logging. **Out of scope:**

- ❌ **Custom metrics** (OTel Metrics API) — separate concern. Consumer uses `@opentelemetry/api` directly.
- ❌ **Tracing setup** (`NodeSDK`, instrumentations) — consumer's responsibility (`main.ts`)
- ❌ **Alerting** (PagerDuty, Slack) — OTLP backend (Grafana Alertmanager, Honeycomb Triggers) handles this
- ❌ **Log aggregation UI** (Grafana, Datadog) — separate product, OTLP backends
- ❌ **Sentry SDK** — consumer installs `@sentry/node` if desired. The lib does not opine
- ❌ **Full APM** — this is a **logging** lib, not APM (logging + tracing + metrics + RUM)
- ❌ **Immutable audit logs** — compliance concern, another lib (future `@bymax-one/nest-audit`)
- ❌ **Human error notification** — Sentry/Slack concern; the lib only structures the log
- ❌ **Queryable persistence in the DB** as a default feature — that's an adapter use case via `ILogDestination`; the lib does not opine (but supports it)
- ❌ **File rotation** — not built-in (but `pino-roll` is referenced as an example adapter)
- ❌ **Replacing NestJS DTO validation middleware** — separate concern
- ❌ **HTTP retry/circuit breaker for destinations** — destinations are responsible for their own resilience

---

## 15. Dependencies

### 15.1 Required peer dependencies

```json
"peerDependencies": {
  "@nestjs/common": "^11.0.16",
  "@nestjs/core": "^11.1.18",
  "pino": "^10.0.0",
  "reflect-metadata": "^0.2.0",
  "rxjs": "^7.8.0"
}
```

| Package            | Version    | Justification                                                                           |
| ------------------ | ---------- | --------------------------------------------------------------------------------------- |
| `@nestjs/common`   | `^11.0.16` | Decorators, `Injectable`, `LoggerService` interface. Floor excludes GHSA-cj7v-w2c7-cp7c |
| `@nestjs/core`     | `^11.1.18` | `APP_INTERCEPTOR`, `APP_FILTER`, `ModuleRef`. Floor excludes GHSA-36xv-jgw5-4q75        |
| `pino`             | `^10.0.0`  | Logging engine                                                                          |
| `reflect-metadata` | `^0.2.0`   | NestJS decorators                                                                       |
| `rxjs`             | `^7.8.0`   | Interceptor streams                                                                     |

### 15.2 Optional peer dependencies

```json
"peerDependencies": {
  "@bymax-one/nest-core": "^1.6.10",
  "@opentelemetry/api": "^1.9.0",
  "pino-pretty": "^13.0.0",
  "prom-client": "^15.0.0"
},
"peerDependenciesMeta": {
  "@bymax-one/nest-core": { "optional": true },
  "@opentelemetry/api": { "optional": true },
  "pino-pretty": { "optional": true },
  "prom-client": { "optional": true }
}
```

| Package                | When to install                                    | Declared range |
| ---------------------- | -------------------------------------------------- | -------------- |
| `pino-pretty`          | If using `PrettyDevDestination`                    | `^13.0.0`      |
| `@opentelemetry/api`   | If you want `traceId`/`spanId` correlation in logs | `^1.9.0`       |
| `@bymax-one/nest-core` | If using the `./observability` subpath             | `^1.6.10`      |
| `prom-client`          | If using the `./observability` subpath             | `^15.0.0`      |

> **Note on `pino-http`**: the lib does **not** depend on `pino-http`. Consumers can use `pino-http` independently if they choose; this lib does not depend on it (see §17.5 for the rationale).
>
> **Note about `@opentelemetry/sdk-node` and `pino-roll`**: neither is a declared peer, and neither should become one. The lib imports neither — `sdk-node` is initialized by the consumer in its own `main.ts`, and `pino-roll` belongs to the `RollingFileDestination` **adapter example** in §5.7, which a consumer copies and owns. Declaring a peer the package never imports buys nothing (an optional peer documents a requirement, it does not resolve one) and costs: pnpm's `autoInstallPeers` defaults to true, so optional peers are materialized into the lockfile and generate Dependabot alerts for code this library never runs. (The setting is `autoInstallPeers` in `pnpm-workspace.yaml` — since pnpm 10 every non-auth setting lives there, not in `.npmrc`, and pnpm 11 ships a codemod that moves the stragglers.)
>
> The constraint that mattered survives without the declaration: each `@opentelemetry/sdk-node` release pins `@opentelemetry/api` to a narrow window (on the npm registry, `0.218.0` accepts `>=1.3.0 <1.10.0` and `0.300.0` accepts `>=1.10.0 <1.11.0`), so no single `api` range satisfies every SDK release. That is why the `api` range above stays at `^1.9.0` instead of naming a window. Track pre-1.0 releases — breaking changes may occur.
>
> **Note about `@opentelemetry/api` version**: our peer dep declares `^1.9.0` (any 1.x ≥ 1.9.0). each `@opentelemetry/sdk-node` release accepts only a narrow `api` window, so a consumer that pins an `api` outside the window of its SDK breaks OTel SDK init. **Keep `^1.9.0` until SDK Node 1.0 ships.** The lib itself only consumes the `trace` API namespace, which has been stable since 1.3+, so the lib does not introduce its own floor or ceiling — the window is dictated by the SDK the consumer installs.

### 15.3 `"dependencies": {}`

The lib has **no direct dependencies**. The entire ecosystem comes via peer deps. This ensures:

- The consumer controls the exact Pino version
- The supply chain surface is reduced to a minimum (`pino` + audited transitives)
- Compatibility with any `@nestjs/common` `^11.0.16` the consumer already has

### 15.4 devDependencies (expected in the repo)

See `devDependencies` in `package.json`.

---

## 16. Implementation Phases

### Phase 1 — Foundation + Pino integration

**Goal:** The lib emits structured JSON logs via `PinoLoggerService` with in the extras.

Deliverables:

- [ ] Project scaffold (`src/` folder, `tsconfig.*`, `tsup.config.ts`, `eslint.config.mjs`, `jest.config.ts`)
- [ ] `LogLevel`, `LogEntry`, `ServiceMetadata` types in `src/shared/`
- [ ] `BymaxLoggerModuleOptions` interface
- [ ] `DEFAULT_REDACT_PATHS` constants
- [ ] `RESERVED_LOG_KEYS`, `LOG_KEYS_CONVENTION_REGEX` in `src/shared/`
- [ ] Injection tokens (`Symbol()`)
- [ ] `validate-options.ts` (zod or manual validation)
- [ ] `compile-redact-paths.ts`
- [ ] `PinoLoggerService` (variadic + structured)
- [ ] `DefaultStdoutDestination`
- [ ] `BymaxLoggerModule.forRoot()` + `forRootAsync()`
- [ ] Unit tests with **100% coverage** (statements/branches/functions/lines) — gate inherited from `nest-auth`
- [ ] `jest.coverage.config.ts` applies the global threshold `{ statements: 100, branches: 100, functions: 100, lines: 100 }`

Validation:

- `pnpm typecheck && pnpm lint && pnpm test:cov:all`
- Test app: `logger.info('TEST', 'hello', undefined, { foo: 1 })` produces correct JSON on stdout

### Phase 2 — Context + AsyncLocalStorage + Trace Mixin

**Goal:** Logs automatically carry `requestId`/`tenantId`/`userId`/`traceId`/`spanId`.

Deliverables:

- [ ] `LogContextService` (AsyncLocalStorage manager)
- [ ] `TraceContextMixin` (Pino formatter)
- [ ] `RequestIdMiddleware`
- [ ] Optional `@opentelemetry/api` detection
- [ ] Update `PinoLoggerService` to merge context into every log
- [ ] Tests: a log inside `logContext.run({ ... }, ...)` carries the context; without OTel, in the traceId

Validation:

- Integration test setup with `@opentelemetry/api` mocked
- Logs outside the `run()` scope do **not** break (no context, in the requestId)

### Phase 3 — HTTP Interceptor + Filter + Decorators

**Goal:** Auto-logging of HTTP requests + ergonomic decorators.

Deliverables:

- [ ] `normalize-url.util.ts` + paired tests
- [ ] `HttpLoggingInterceptor`
- [ ] `HttpExceptionFilter`
- [ ] `@InjectLogger`, `@LogContext` (deprecated, §9.2), `@LogPerformance`
- [ ] Conditional registration as global via `APP_INTERCEPTOR`/`APP_FILTER` when `http.isEnabled`
- [ ] E2E tests with `supertest` in a Nest fixture app
- [ ] 100% coverage on normalize-url (high blast radius)

Validation:

- A request to `/users/abc-uuid-xyz` produces a log with `url: /users/:id`
- A 500 exception fires `HTTP_REQUEST_SERVER_ERROR` in the log
- `@LogPerformance(50)` logs `METHOD_SLOW_EXECUTION` if the method takes > 50ms

### Phase 4 — Pretty dev + Extra destinations + Testing

**Goal:** Production-ready with pluggable destinations.

Deliverables:

- [ ] `PrettyDevDestination` (optional peer dep `pino-pretty`)
- [ ] `DestinationRegistry` (init/shutdown lifecycle)
- [ ] `RollingFileDestination` (adapter example; the consumer brings `pino-roll`, which is not a declared peer)
- [ ] Destination test suite with `Testcontainers` (Loki via Docker)
- [ ] Mutation testing baseline (Stryker)
- [ ] Documentation: README + 3 complete examples

Validation:

- `pnpm test:cov:all` reports **100%** on all metrics (statements/branches/functions/lines) globally — gate identical to `nest-auth`
- Mutation score ≥ 99% global (Stryker `thresholds: { high: 99, low: 95, break: 95 }`)

### Phase 5 — v0.1.0 Release

- [ ] `README.md` with badges, quick start, 3 usage scenarios (dev, prod with Loki, custom Postgres)
- [ ] `CHANGELOG.md` (Keep a Changelog format)
- [ ] `SECURITY.md`
- [ ] `CLAUDE.md` + `AGENTS.md`
- [ ] CI workflows (ci, codeql, release, scorecard)
- [ ] Verify `pnpm size` (limits — **brotli** compressed): `dist/server/index.mjs` ≤ **12,000 bytes (12KB)**, `dist/shared/index.mjs` ≤ **3,500 bytes (3.5KB)**. Brotli unit (not gzip) — aligned with `scripts/check-size.mjs` inherited from `nest-auth`.
- [ ] Tag `v0.1.0` + `pnpm publish --provenance`

**Total scope:** 5 phases. Execution by AI agents — in the estimate in human days. See `docs/development_plan.md` for the per-sub-step Complexity Matrix.

---

## 17. Known Limitations

### 17.1 No `Scope.REQUEST` support

The lib uses singleton (`Scope.DEFAULT`). Request-scoped context comes via `AsyncLocalStorage`, not via DI scope.

**Reason**: the NestJS documentation says that "a properly designed application that uses request-scoped providers should not see latency increase by more than ~5%" ([docs](https://docs.nestjs.com/fundamentals/injection-scopes#performance)). The library does not take on that cost for context it can carry in `AsyncLocalStorage`.

For a distinct context per class, see §17.2.

### 17.2 No `Scope.TRANSIENT`

For a similar reason. The `@InjectLogger(context)` decorator solves the "distinct context per class" problem without requiring transient scope. A class that names a context must be imported before the `forRoot` / `forRootAsync` call is evaluated, which is when the contexts are collected.

### 17.3 Entries still queued when the process ends are lost

The library starts no worker thread: Pino writes through `pino.multistream` in the application thread, and the default destination calls `process.stdout.write`. On POSIX, Node writes stdout synchronously to a file and asynchronously to a pipe ([process I/O](https://nodejs.org/api/process.html#a-note-on-process-io)), so `process.exit()` drops what a pipe has not taken, and what an asynchronous destination has not sent.

Measured with node 24 on macOS, 5000 entries followed by `process.exit()` and one more entry logged from `process.on('exit')`: to a file all of them arrived; to a pipe whose reader started a second late, only part of them arrived and the entry from the exit handler did not.

There is no flush method. Call `await app.close()`, or `app.enableShutdownHooks()` for a signal: the registry then drains stdout and calls each destination's `onShutdown`, within the `shutdown` budget. An asynchronous destination delivers what it holds in `onShutdown`.

### 17.4 Auto-detection of the OTel API

`@opentelemetry/api` is resolved at runtime with `createRequire`, from the package's own location and then from `process.cwd()`. A bundler does not follow that call, so the module is not put in the bundle on its account (measured with esbuild 0.28.2, with the module installed: none of its files among the bundle inputs), and declaring it as a dependency does not change that. It has to be resolvable from `node_modules` where the bundle runs.

### 17.5 `pino-http` not embedded

The lib does **not** depend on `pino-http` — it has its own `HttpLoggingInterceptor` and, for requests that never reach an interceptor, `applyAccessLog` (both use the lib's URL normalization). `pino-http` is **not** a peer dependency.

If a consumer still prefers `pino-http` (`pinoHttp({ ... })`), they install it independently and register it as Express/Fastify middleware — no wiring from this lib is required. With `http.isEnabled` as well, each request is logged twice, so pick one.

### 17.6 One censor for every path

`redactCensor` is a single string. There is no censor per path and no computed censor: `forRoot` and `forRootAsync` refuse a function.

### 17.7 No size limit on the whole entry

`maxEntrySizeBytes` (65536 by default) bounds each serialized field (`err` and any custom serializer) and each derived `exception.*` and `error.type` field. A serializer output over it is replaced by `{"_truncated":true,"_logKey":"LOGGER_ENTRY_TRUNCATED","_originalSize":<n>,"_preview":"<first chars>"}`; a derived field is cut. The entry's `msg`, and an error's `message` and `stack`, are cut at 16384 characters. `maxEntrySizeBytes` does not bound a value under a metadata key, or the entry: with the defaults, a 100000-character metadata string and an entry of 40 fields of 4000 characters are both written whole. `maxStringLength`, off until set, cuts long string values. The reserved key `LOGGER_ENTRY_TRUNCATED` is part of `RESERVED_LOG_KEYS` (§12.3).

### 17.8 The destination registry trusts `options.level`

`forRoot` and `forRootAsync` refuse a `level` outside the six. `DestinationRegistry` does not check it again: code that builds the registry itself, from options neither of them saw, gets that value as the effective level of every destination whose `minLevel` is not `'fatal'`.

---

## 18. Example Integration

### 18.1 Local dev setup

```typescript
// apps/backend/src/app.module.ts
import { Module } from '@nestjs/common'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'my-app-dev', version: 'dev' },
      level: 'debug',
      http: { isEnabled: true }
    })
  ]
})
export class AppModule {}
```

Open the request scope in `main.ts`, so that entries carry `requestId` and `tenantId`:

```typescript
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  BymaxLoggerModule.useNestLogger(app)
  BymaxLoggerModule.useRequestContext(app)
  await app.listen(3000)
}
bootstrap()
```

Stdout output is NDJSON, one object per line; for the rendered view add `destinations: [new PrettyDevDestination()]`. The first entry of the library is `LOGGER_BOOTSTRAP_OK` with the message `BymaxLoggerModule initialized`, and a request logs `HTTP_REQUEST_START` with the message `POST /users`.

### 18.2 Prod setup with OTLP → Loki + OTel

```typescript
// apps/backend/src/main.ts (top of file)
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'my-app',
    [ATTR_SERVICE_VERSION]: process.env.RELEASE_SHA!,
    'deployment.environment': 'production'
  }),
  traceExporter: new OTLPTraceExporter({ url: process.env.OTLP_TRACE_ENDPOINT! }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false }
    })
  ]
})
sdk.start()

import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  BymaxLoggerModule.useNestLogger(app)
  BymaxLoggerModule.useRequestContext(app)
  process.once('SIGTERM', () => {
    // Close the app first, so the destinations drain, then the SDK.
    void app
      .close()
      .then(() => sdk.shutdown())
      .finally(() => process.exit(0))
  })
  await app.listen(3000)
}
bootstrap()
```

```typescript
// apps/backend/src/app.module.ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'
import { LokiDestination } from './observability/loki.destination'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BymaxLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        service: {
          name: cfg.getOrThrow('OTEL_SERVICE_NAME'),
          version: cfg.getOrThrow('RELEASE_SHA')
        },
        level: cfg.get('LOG_LEVEL') ?? 'info',
        http: { isEnabled: true },
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
  ]
})
export class AppModule {}
```

Logs in Loki look like:

```json
{
  "level": "info",
  "time": "2026-05-27T15:32:14.512Z",
  "service": { "name": "my-app", "version": "abc123def" },
  "logKey": "USER_CREATED",
  "msg": "User created",
  "userId": "u_new",
  "tenantId": "t_acme",
  "requestId": "r_xyz",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "plan": "pro",
  "email": "[REDACTED]"
}
```

In Grafana, just a LogQL query:

```
{service="my-app"} | json | logKey="USER_CREATED" and tenantId="t_acme"
```

To drill into the corresponding trace, click the `traceId` → goes straight to the correlated span in Tempo/Honeycomb.

### 18.3 Use in an application service

```typescript
import { Injectable } from '@nestjs/common'
import { InjectLogger, PinoLoggerService } from '@bymax-one/nest-logger'

@Injectable()
export class PaymentsService {
  constructor(
    @InjectLogger(PaymentsService.name)
    private readonly logger: PinoLoggerService,
    // Your own payment client.
    private readonly stripe: StripeClient
  ) {}

  async refund(paymentId: string, amount: number, requestedBy: string) {
    this.logger.info('PAYMENT_REFUND_REQUESTED', 'Refund requested', requestedBy, {
      paymentId,
      amount
    })

    try {
      const refund = await this.stripe.refunds.create({ payment_intent: paymentId, amount })
      this.logger.info('PAYMENT_REFUND_SUCCESS', 'Refund processed', requestedBy, {
        paymentId,
        amount,
        stripeRefundId: refund.id
      })
      return refund
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

### 18.4 Migrating a legacy Winston logger (fitness case)

Recommended strategy when migrating from a Winston-based codebase:

**Step 1 — Replace LoggerService**

```diff
- import { LoggerService } from './_commons_/logger/logger.service'
+ import { PinoLoggerService } from '@bymax-one/nest-logger'

  @Injectable()
  export class UsersService {
-   constructor(private readonly logger: LoggerService) {}
+   constructor(private readonly logger: PinoLoggerService) {}

    foo() {
-     this.logger.log('USER_CREATED', 'user.create', userId, { plan: 'pro' })
+     this.logger.info('USER_CREATED', 'user.create', userId, { plan: 'pro' })
    }
  }
```

`PinoLoggerService.info(logKey, msg, userId, metadata)` takes the arguments of the old `LoggerService.log()`. Here `log()` is the NestJS method and does not take them, so an unchanged call loses data without an error: change the call sites.

**Step 2 — Replace the module**

```diff
- import { LoggerModule } from './_commons_/logger/logger.module'
+ import { BymaxLoggerModule, type LogLevel } from '@bymax-one/nest-logger'

  @Module({
-   imports: [LoggerModule],
+   imports: [
+     BymaxLoggerModule.forRoot({
+       service: { name: 'fitness-backend', version: process.env.RELEASE_SHA ?? 'dev' },
+       level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
+       http: { isEnabled: true },
+     }),
+   ],
  })
  export class AppModule {}
```

**Step 3 — Decide on Postgres destination**

Two options:

- **A.** Keep Postgres as a destination → write a `PrismaPostgresDestination` (shown in §5.6) and pass via `destinations: []`. Preserves the existing log admin UI.
- **B.** Migrate to Loki/OTLP → eliminate the `Log` table, eliminate `LogCleanupService`. Better in the medium term, requires adopting an OTLP stack.

**Step 4 — Remove `PrismaLoggingService`**

Replace with `@opentelemetry/instrumentation-prisma` when OTel is added. Until then, Prisma queries simply don't get logged (acceptable loss).

**Migration scope:** `LoggerService.log()` call sites (renamed to `info()`) + OTel SDK setup in `main.ts` + decision on Postgres vs Loki destination + test updates. Execution in a dedicated session by an AI agent.

---

## Appendix A — Glossary

| Term                  | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| **ALS**               | `AsyncLocalStorage` — Node.js native API for context propagation       |
| **OTel**              | OpenTelemetry — vendor-neutral observability framework                 |
| **OTLP**              | OpenTelemetry Protocol — wire protocol for telemetry shipping          |
| **Span**              | Unit of work in distributed tracing (a tracked "action")               |
| **Trace**             | A set of spans related to one distributed operation                    |
| **`traceparent`**     | W3C header with `traceId`+`spanId`+flags for cross-service correlation |
| **PII**               | Personally Identifiable Information — sensitive personal data          |
| **@pinojs/redact**    | The library behind Pino's `redact` option                              |
| **Mixin (Pino)**      | Function that returns additional fields to merge into every log        |
| **Serializer (Pino)** | Function that normalizes a type (e.g., `Error` → plain object)         |
| **Destination**       | This lib's term for a Pino "transport" (where logs go)                 |
| **Bindings**          | Pino — key/value pairs attached to every log of a child logger         |

---

## Appendix B — Pino vs Winston Benchmark

Official data from the Pino repository (Node 20, single instance, 100k logs):

| Logger                      | Logs/sec | Avg latency | RSS after | CPU % |
| --------------------------- | -------- | ----------- | --------- | ----- |
| Pino 10 (default)           | ~750,000 | 1.3 µs      | ~45 MB    | 8%    |
| Pino 10 (with pretty)       | ~120,000 | 8 µs        | ~50 MB    | 14%   |
| Pino 10 (file transport)    | ~600,000 | 1.6 µs      | ~52 MB    | 11%   |
| Winston 3 (JSON format)     | ~110,000 | 9 µs        | ~85 MB    | 22%   |
| Winston 3 (with transports) | ~75,000  | 13 µs       | ~95 MB    | 28%   |

**Conclusion:** at high throughput (~100k req/s, typical of billing/payments backends), Pino consumes ~3× less CPU and has ~2× less RSS. Under load testing, the savings translate to lower response latency (the logger isn't blocking the event loop).

Sources:

- Pino official benchmarks: https://github.com/pinojs/pino/blob/main/docs/benchmarks.md
- Independent Logtail benchmark (Better Stack): https://betterstack.com/community/guides/logging/pino-vs-winston/

---

## Appendix C — Log Level Mapping

| Pino numeric | Pino string | NestJS string | OTel Severity | Typical use case                                |
| ------------ | ----------- | ------------- | ------------- | ----------------------------------------------- |
| 60           | `fatal`     | `fatal`       | FATAL         | The process is about to exit                    |
| 50           | `error`     | `error`       | ERROR         | Failure that requires human attention           |
| 40           | `warn`      | `warn`        | WARN          | Recoverable anomaly                             |
| 30           | `info`      | `log`         | INFO          | Significant business events                     |
| 20           | `debug`     | `debug`       | DEBUG         | Implementation detail useful in troubleshooting |
| 10           | `trace`     | `verbose`     | TRACE         | Ultra-granular detail (rarely in prod)          |

**Mapping in `PinoLoggerService`:**

- `log()` (NestJS) → `pino.info()`
- `verbose()` (NestJS) → `pino.trace()`
- `debug()` (NestJS) → `pino.debug()`
- `warn()` (NestJS) → `pino.warn()`
- `error()` (NestJS) → `pino.error()`
- `fatal()` (NestJS) → `pino.fatal()`

The structured API (`info()`, `warnStructured()`, `errorStructured()`) maps 1:1 to Pino.

---

> **Next steps (after this spec):**
>
> 1. Generate `development_plan.md` (Layer 2) with detailed phases
> 2. Generate `development_tasks.md` (Layer 3) with AI-executable tasks
> 3. Bootstrap the code following the plan
> 4. Release `v0.1.0` on npm
