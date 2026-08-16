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

- A `PinoLoggerService` that implements the official NestJS `LoggerService` interface and can replace the default logger with in the application code changes
- An additional custom API `log(logKey, message, userId?, metadata?)` that follows the `MODULE_ACTION_RESULT` convention adopted across the Bymax ecosystem
- An HTTP interceptor for automatic request/response logging with normalized URLs
- An HTTP exception filter with sanitized stack trace capture
- `@InjectLogger()`, `@LogContext()`, and `@LogPerformance()` decorators to reduce boilerplate
- Automatic propagation of context (`requestId`, `tenantId`, `userId`, `traceId`, `spanId`) via `AsyncLocalStorage` — in the prop drilling, in the `(req: Request)` in service signatures
- A declarative PII redaction system via `pino.redact` paths
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

| Criterion        | Pino 10                                              | Winston                                                 |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Performance      | **5-7× faster** in official benchmarks               | Baseline (slower by design)                             |
| Footprint        | Async via worker threads, low allocation             | Higher allocation, synchronous transformations          |
| Native structure | JSON-first                                           | JSON via format combinators (extra layer)               |
| OTel ecosystem   | Official `@opentelemetry/instrumentation-pino`       | `@opentelemetry/instrumentation-winston` (less support) |
| PII redact       | Declarative `redact` paths via builtin `fast-redact` | Custom (manual)                                         |
| Adoption 2024+   | Standard in new Node backends                        | Legacy                                                  |

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
| Framework | NestJS 11+                                      |
| Subpaths  | `.` (server), `./shared`                        |
| Engine    | Pino 10 (peer dependency)                       |
| OTel      | `@opentelemetry/api` (optional peer dependency) |

### 1.6 Design Principles

1. **Pino first, NestJS on top** — the lib is a thin wrapper over Pino. All of Pino's power-user features (child loggers, mixins, serializers, transports) remain accessible to the advanced consumer via `getRawLogger()`.
2. **OTel optional, never required** — the lib detects `trace.getActiveSpan()` at runtime; if empty, it logs normally. In the `NodeSDK` configuration is performed by the lib — that stays with the consumer.
3. **Dependency inversion** — destinations are pluggable via `ILogDestination`. The lib only knows the default (stdout JSON). The consumer plugs in Loki, Postgres, S3 archive, or any async destination.
4. **Zero critical external dependencies** — only Pino as a required peer. Everything else is an optional peer.
5. **Convention over configuration** — `MODULE_ACTION_RESULT` log keys, reasonable default redact paths, NestJS-compatible default log levels. Safe defaults without requiring setup.
6. **NestJS-native compatibility** — `PinoLoggerService` implements `LoggerService` from `@nestjs/common`, usable in `app.useLogger()` or injectable as a traditional service.
7. **Multi-tenant ready** — `tenantId` propagation via `AsyncLocalStorage` in every log with in the additional application code.
8. **Secure by default** — redact paths for common sensitive fields (`password`, `passwordHash`, `token`, `mfaSecret`, `cardNumber`, `cvv`, `cpf`, `cnpj`, `headers.authorization`, `headers.cookie`) enabled out-of-the-box.

### 1.7 Decision: from-scratch implementation (not `nestjs-pino`)

The community lib [`nestjs-pino`](https://github.com/iamolegga/nestjs-pino) (Iamolegga) covers ~70% of this lib's scope: ALS-based request context, `pino-http` HTTP logging, `Logger`/`PinoLogger`/`NativeLogger` services. **So why not depend on it?**

| Criterion                          | Assessment                                                                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parity with `@bymax-one/nest-auth` | The public bymax repo grows by keeping its own visual identity + conventions. Depending on a community lib breaks architectural parity.                                                              |
| `MODULE_ACTION_RESULT` convention  | `nestjs-pino` is agnostic — it neither requires nor encourages the convention. To ensure uniform adoption across the bymax ecosystem, we need an API that makes the convention **the natural path**. |
| Opinionated redact registry        | `nestjs-pino` exposes `pinoHttp.redact` without opinion; the consumer chooses. This lib **opines**: 140 default paths covering BR PII (CPF/CNPJ/RG) + LGPD + PCI DSS, merged with custom extensions. |
| Out-of-the-box OTel correlation    | `nestjs-pino` does not have a built-in OTel mixin (the consumer wires `@opentelemetry/instrumentation-pino`). This lib detects `trace.getActiveSpan()` automatically.                                |
| Productivity decorators            | `nestjs-pino` does not provide `@InjectLogger`, `@LogContext`, `@LogPerformance`. This lib delivers them zero-config.                                                                                |
| Multi-tenant via `tenantId`        | `nestjs-pino` requires the consumer to wire the header. This lib reads `x-tenant-id` by default and propagates via ALS.                                                                              |
| Supply chain                       | Keeping our own implementation reduces upstream dependency and eliminates the risk of unexpected breaking changes (community libs follow their own cadence).                                         |
| Maintenance cost                   | ~400-600 additional LoC (vs. ~1,500 total LoC in the lib). Justifiable given the 6 reasons above.                                                                                                    |

**Accepted trade-offs:** more code to maintain, in the direct community reuse, responsibility to track Pino releases. **Mitigation:** Stryker ≥ 99%, strict CI gates, the Pino peer dep accepts wide ranges (`^10.0.0`).

### 1.8 Feature Categorization

#### Core (always active)

| Component                  | Responsibility                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PinoLoggerService`        | Main log API (`log`, `info`, `warn`, `error`, `debug`, `trace`, `fatal`) with the `logKey` convention |
| `LogContextService`        | Manages `AsyncLocalStorage` for `requestId`, `tenantId`, `userId` propagation                         |
| `DefaultStdoutDestination` | Default destination (stdout JSON)                                                                     |
| `RedactPathsRegistry`      | Compiled list of PII paths for redaction                                                              |
| `TraceContextMixin`        | Pino mixin that injects `traceId`/`spanId` when OTel is active                                        |

#### HTTP (opt-in via `http.isEnabled: true`)

| Component                | Activation                                | Responsibility                                                        |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------- |
| `HttpLoggingInterceptor` | `http: { isEnabled: true }`               | Logs request/response with normalized URL and duration                |
| `HttpExceptionFilter`    | `http: { shouldCaptureExceptions: true }` | Logs HTTP exceptions with the appropriate status code                 |
| `RequestIdMiddleware`    | `http: { shouldGenerateRequestId: true }` | Reads/generates the `x-request-id` header and injects it into context |

#### Decorators (always available)

| Decorator                     | Use                                                |
| ----------------------------- | -------------------------------------------------- |
| `@InjectLogger(context?)`     | Typed logger injection with pre-configured context |
| `@LogContext(name)`           | Marks a class with a fixed log context             |
| `@LogPerformance(threshold?)` | Logs method duration; warns above the threshold    |

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

export const {
  ConfigurableModuleClass: BymaxLoggerModuleBase,
  MODULE_OPTIONS_TOKEN: LOGGER_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE
} = new ConfigurableModuleBuilder<BymaxLoggerModuleOptions>()
  .setClassMethodName('forRoot') // generates `forRoot` AND `forRootAsync`
  .setExtras(
    { isGlobal: true }, // default; can be overridden per-call
    (definition, extras) => ({
      ...definition,
      global: extras.isGlobal // Nest's DynamicModule still uses `global` here;
      // the consumer-facing option key is `isGlobal`
    })
  )
  .build()
```

Then `BymaxLoggerModule` inherits from the base + adds providers (`PinoLoggerService`, `LogContextService`, etc.):

```typescript
@Module({})
export class BymaxLoggerModule extends BymaxLoggerModuleBase {
  // Overrides forRoot/forRootAsync to inject lib providers
  static override forRoot(options: BymaxLoggerModuleOptions): DynamicModule {
    const base = super.forRoot(options)
    return {
      ...base,
      providers: [
        ...(base.providers ?? []),
        PinoLoggerService,
        LogContextService,
        DestinationRegistry
      ],
      exports: [PinoLoggerService, LogContextService]
    }
  }
  static override forRootAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule {
    const base = super.forRootAsync(options)
    return {
      ...base,
      providers: [
        ...(base.providers ?? []),
        PinoLoggerService,
        LogContextService,
        DestinationRegistry
      ],
      exports: [PinoLoggerService, LogContextService]
    }
  }
}
```

> The module is **global** by default (`isGlobal: true` via `setExtras`). All app modules have access to the logger without importing `BymaxLoggerModule` in each one. Disable via `BymaxLoggerModule.forRoot({ ..., isGlobal: false })`.

**References:**

- [NestJS docs — Configurable Module Builder](https://docs.nestjs.com/fundamentals/dynamic-modules#configurable-module-builder)
- Inspiration: `@bymax-one/nest-auth` uses the same pattern in `src/server/auth.module.ts`.

### 2.2 Initialization flow

```
1. App boot →
2. BymaxLoggerModule.forRoot(options) evaluates config →
3. RedactPathsRegistry compiles default paths + custom paths →
4. ConfigurationFactory builds Pino options:
   - level
   - redact { paths, censor }
   - serializers { err } (a library serializer built on `sanitizeError` — NOT `pino.stdSerializers.err`, which derived `type` from the value's constructor and reported `"Object"` for a normalized error; `req`/`res` opt-in only if the HTTP interceptor is active)
   - mixin → `TraceContextMixin` injects `traceId`/`spanId` (from OTel active span) + `LogContextService` fields into **every** log
   - ISO 8601 timestamp
   - base { service: { name, version, namespace?, instance: { id }? }, deployment: { environment: { name } }? } — the resolved resource identity, or the flat dotted attribute names under `resourceFormat: 'flat'` →
5. The root Pino is created with multi-stream transport:
   - stdout JSON **only when `destinations` is empty** — a non-empty list REPLACES it
   - pretty stream (opt-in via `PrettyDevDestination` in `destinations`) →
6. Every destination in `destinations` becomes one stream of the multi-stream fan-out →
7. PinoLoggerService is instantiated with a reference to the root Pino →
8. LogContextService initializes AsyncLocalStorage<LogContext> →
9. If http.isEnabled, HttpLoggingInterceptor + HttpExceptionFilter are registered as global →
10. The lib emits its initial log: { logKey: 'LOGGER_BOOTSTRAP_OK', level, destinations: [...] } →
11. On onApplicationShutdown(): the lib emits LOGGER_SHUTDOWN_OK with { destinations }
    FIRST — an entry written after the sinks closed would have nowhere to go — then
    flushes the ACTIVE destinations in reverse registration order, sequentially, each
    `onShutdown` wrapped in its own try/catch so one failure cannot cost the others.
    It takes no signal argument and resolves `void`.
```

### 2.3 Log flow

```
1. Service calls logger.log('USER_CREATED', 'User registered', userId, { plan }) →
2. PinoLoggerService.log() →
3. LogContextService.getStore() retrieves context from AsyncLocalStorage:
   { requestId, tenantId, userId, traceId, spanId } →
4. TraceContextMixin enriches with trace.getActiveSpan() (if OTel is active) →
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
     time: 1717000000000,
     level: 30,
     service: { name: 'my-app', version: '1.2.3' }
   } →
6. pino.redact applies censorship on configured paths →
7. Serialized JSON is written asynchronously (worker thread) to each destination →
8. Stdout receives immediately; custom destinations (Loki, Postgres) batch buffers
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

The lib **does not initialize** the OTel SDK. Responsibility stays with the consumer (in `apps/.../main.ts` before `NestFactory.create`). The integration works via a **Pino mixin** (not via `formatters.log`):

```typescript
// TraceContextMixin — official Pino signature: (mergeObject, level, logger) => object
function traceContextMixin(
  _mergeObject: Record<string, unknown>,
  _level: number,
  _logger: PinoLogger
): Record<string, string> | undefined {
  const span = trace?.getActiveSpan()
  if (!span) return undefined
  const ctx = span.spanContext()
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return undefined
  return { traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: ctx.traceFlags.toString(16) }
}
```

> **Why mixin and not `formatters.log`?** `formatters.log` only receives the object the caller passed to `pino.info(obj, msg)` — it has in the access to ambient context (active span, AsyncLocalStorage). The **mixin** is called by Pino for every log without needing input from the caller, and it is the official place to enrich logs with fields derived from the environment. Confirm with [official Pino docs](https://github.com/pinojs/pino/blob/main/docs/api.md#mixin-function).

If `@opentelemetry/api` is not installed **or** `NodeSDK` has not been started, `trace.getActiveSpan()` returns `undefined` and the lib logs without `traceId`/`spanId`. **Zero application code changes** between having or not having OTel.

> **Recommended**: the consumer installs `@opentelemetry/instrumentation-pino` so that auto-injection also works with any root Pino logger outside the lib (e.g., Pino directly in CLI scripts). See §11.

### 2.6 Context propagation via AsyncLocalStorage

By design, NestJS does not pass `Request` to services. To propagate `requestId`, `tenantId`, `userId` into every log without prop drilling, the lib uses Node's native `AsyncLocalStorage`:

```typescript
// HttpLoggingInterceptor.intercept() in pseudo-code:
LogContext.run(
  { requestId, tenantId: req.headers['x-tenant-id'], userId: req.user?.id },
  () => next.handle() // every log inside this callback automatically carries the context
)
```

The Pino mixin reads the context via `LogContextService.getStore()` and merges it into the log object.

> **OTel-compatible**: OpenTelemetry's `AsyncHooksContextManager` uses the same native mechanism. The two `AsyncLocalStorage`s (the nest-logger one and the OTel one) coexist without conflict.

> **Why not `nestjs-cls`?** The `nestjs-cls` lib (Papooch) is a rich wrapper over `AsyncLocalStorage` with Proxy Providers, a Transactional plugin, and better support for websocket gateways/queue consumers. We don't use it as a peer dep because: (1) it adds transitive deps that the lib wants to avoid, (2) the `nest-logger` use case is strictly "propagate 5 fields" — it doesn't justify importing an entire lib, (3) consumers already using `nestjs-cls` can **integrate** via a custom decorator that reads `ClsService` and sets it on `LogContextService` in the `RequestIdMiddleware`. Documented in `docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md` §troubleshooting.

---

## 3. Package Structure

### 3.1 Full directory tree

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
│   │   └── trace-context.mixin.ts          # Pino formatter for OTel
│   ├── utils/
│   │   ├── normalize-url.util.ts           # /users/abc-123 → /users/:id
│   │   ├── sanitize-error.util.ts          # Cleans stack trace, redacts fields
│   │   └── compile-redact-paths.util.ts
│   ├── errors/
│   │   └── logger-error-codes.constants.ts
│   ├── config/
│   │   ├── default-options.ts
│   │   └── validate-options.ts
│   ├── logger.module.builder.ts            # ConfigurableModuleBuilder factory
│   ├── logger.module.ts                    # BymaxLoggerModule (extends builder; overrides forRoot/forRootAsync)
│   ├── pino-factory.ts                     # buildPinoInstance(options, logContext)
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
    "types": "./dist/server/index.d.ts",
    "import": "./dist/server/index.mjs",
    "require": "./dist/server/index.cjs"
  },
  "./shared": {
    "types": "./dist/shared/index.d.ts",
    "import": "./dist/shared/index.mjs",
    "require": "./dist/shared/index.cjs"
  }
}
```

### 3.3 Exports per subpath

**`@bymax-one/nest-logger`** (server):

```typescript
// Module
export { BymaxLoggerModule } from './logger.module'

// Services
export { PinoLoggerService } from './services/pino-logger.service'
export { LogContextService } from './services/log-context.service'

// Interceptors / Filters / Middlewares
export { HttpLoggingInterceptor } from './interceptors/http-logging.interceptor'
export { HttpExceptionFilter } from './filters/http-exception.filter'
export { RequestIdMiddleware } from './middlewares/request-id.middleware'

// Decorators
export { InjectLogger } from './decorators/inject-logger.decorator'
export { LogContext } from './decorators/log-context.decorator'
export { LogPerformance } from './decorators/log-performance.decorator'

// Interfaces
export type { ILogDestination } from './interfaces/log-destination.interface'
export type {
  BymaxLoggerModuleOptions,
  BymaxLoggerModuleAsyncOptions
} from './interfaces/logger-module-options.interface'

// Destinations
export { DefaultStdoutDestination } from './destinations/default-stdout.destination'
export { PrettyDevDestination } from './destinations/pretty-dev.destination'
export type { PrettyViewOptions } from './destinations/pretty-dev.destination'

// Injection tokens
export {
  LOGGER_OPTIONS_TOKEN,
  LOGGER_PINO_INSTANCE_TOKEN,
  LOGGER_DESTINATIONS_TOKEN
} from './constants/injection-tokens.constants'

// Constants (re-exported from shared for convenience)
export { DEFAULT_REDACT_PATHS } from './constants/default-redact-paths.constants'
```

**`@bymax-one/nest-logger/shared`** (zero deps, importable in the frontend for typing):

```typescript
export type { LogLevel } from './types/log-level.type'
export type { LogEntry } from './types/log-entry.type'
export type { ResolvedServiceMetadata, ServiceMetadata } from './types/service-metadata.type'
export { RESERVED_LOG_KEYS } from './constants/reserved-log-keys.constants'
export { LOG_KEYS_CONVENTION_REGEX } from './constants/log-keys-convention.constants'
```

---

## 4. Configuration API

### 4.1 `BymaxLoggerModuleOptions` interface

```typescript
export interface BymaxLoggerModuleOptions {
  /**
   * Service metadata — written as `service.name` and `service.version` in every log.
   * Aligned with OpenTelemetry semantic conventions.
   */
  service: {
    name: string
    version: string
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
   * Whether to also expose this logger as NestJS `app.useLogger()` replacement.
   * When true, all internal NestJS logs (`Bootstrap`, `RoutesResolver`, etc.) flow through Pino.
   * @default true
   */
  shouldUseAsNestLogger?: boolean

  /**
   * PII paths to redact. Merged with `DEFAULT_REDACT_PATHS`.
   * Pino syntax: 'a.b.c', '*.token', 'req.headers.authorization'.
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
   * Custom destinations beyond the default stdout JSON.
   * Multiple destinations are written to via Pino's multi-stream.
   */
  destinations?: ILogDestination[]

  /**
   * HTTP module configuration.
   */
  http?: {
    /** Register HttpLoggingInterceptor and HttpExceptionFilter as global. @default false */
    isEnabled?: boolean
    /** Capture exceptions in filter (in addition to interceptor). @default true if enabled */
    shouldCaptureExceptions?: boolean
    /** Auto-generate x-request-id header if missing. @default true if enabled */
    shouldGenerateRequestId?: boolean
    /** URL paths to exclude from HTTP logging (regex array). @default [/^\/health$/, /^\/metrics$/] */
    excludePaths?: RegExp[]
    /** Header name where tenantId is read for context propagation. @default 'x-tenant-id' */
    tenantIdHeader?: string
    /**
     * Resolver used by the HTTP interceptor/filter to extract the user id from the
     * incoming request. Defaults to `req.user?.id`, which works with Passport-style
     * `req.user` shapes but is loosely typed. Override when your auth layer attaches
     * the user differently (e.g., a JWT claim on `req.auth.sub`).
     * @default (req) => req.user?.id
     */
    userIdResolver?: (req: unknown) => string | undefined
  }

  /**
   * OpenTelemetry integration tuning.
   */
  otel?: {
    /** Inject traceId/spanId from active OTel span into every log. @default true if @opentelemetry/api is installed */
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
   * Maximum size of a single log entry in bytes. Larger entries are truncated with a marker.
   * Protects against log explosion from huge metadata objects.
   * @default 65536 (64KB)
   */
  maxEntrySizeBytes?: number

  /**
   * Custom Pino serializers (merged with defaults err/req/res).
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

| Option                              | Type                          | Default                                                      | Notes                                                                                                                |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `service.name`                      | `string`                      | **required**                                                 | E.g., `'bymax-finance-backend'`                                                                                      |
| `service.version`                   | `string`                      | **required**                                                 | Typically `process.env.RELEASE_SHA ?? 'dev'`                                                                         |
| `level`                             | `LogLevel`                    | `'info'` prod, `'debug'` other                               | Values: `'fatal' \| 'error' \| 'warn' \| 'info' \| 'debug' \| 'trace'`                                               |
| `isGlobal`                          | `boolean`                     | `true`                                                       | `@Global()` for LoggerModule — mapped to Nest's `DynamicModule.global` internally                                    |
| `shouldUseAsNestLogger`             | `boolean`                     | `true`                                                       | Replaces NestJS internal logger                                                                                      |
| `redactPaths`                       | `string[]`                    | `[]` (merged with `DEFAULT_REDACT_PATHS`)                    | `fast-redact` syntax — wildcard `*` matches **a single level** (not recursive). List explicit depths if you need to. |
| `redactCensor`                      | `string`                      | `'[REDACTED]'`                                               | String that replaces sensitive values                                                                                |
| `shouldDisableDefaultRedact`        | `boolean`                     | `false`                                                      | ⚠️ Do not use in prod without a strong reason                                                                        |
| `destinations`                      | `ILogDestination[]`           | `[DefaultStdoutDestination]`                                 | + `PrettyDevDestination` auto in dev                                                                                 |
| `http.isEnabled`                    | `boolean`                     | `false`                                                      | Enables HTTP interceptor + filter                                                                                    |
| `http.shouldCaptureExceptions`      | `boolean`                     | `true` (if `enabled`)                                        | Enables the exception filter                                                                                         |
| `http.shouldGenerateRequestId`      | `boolean`                     | `true` (if `enabled`)                                        | Auto-generates `x-request-id`                                                                                        |
| `http.excludePaths`                 | `RegExp[]`                    | `[/^\/health$/, /^\/metrics$/]`                              | Do not log healthchecks                                                                                              |
| `http.tenantIdHeader`               | `string`                      | `'x-tenant-id'`                                              | Header for multi-tenant context                                                                                      |
| `otel.shouldAutoInjectTraceContext` | `boolean`                     | `true` (if OTel is available)                                | Injects `traceId`/`spanId`/`traceFlags`                                                                              |
| `otel.traceIdField`                 | `string`                      | `'traceId'` (or `'trace_id'` if `fieldFormat: 'snake_case'`) | Field name in the log                                                                                                |
| `otel.spanIdField`                  | `string`                      | `'spanId'` (or `'span_id'`)                                  | Field name in the log                                                                                                |
| `otel.traceFlagsField`              | `string`                      | `'traceFlags'` (or `'trace_flags'`)                          | Field name in the log                                                                                                |
| `otel.fieldFormat`                  | `'camelCase' \| 'snake_case'` | `'camelCase'`                                                | Shortcut to align with OTel Logs Data Model (`snake_case`) or Pino-native (`camelCase`)                              |
| `maxEntrySizeBytes`                 | `number`                      | `65536` (64KB)                                               | Truncates oversized entries                                                                                          |
| `serializers`                       | `Record<string, fn>`          | `{}` (merged with defaults)                                  | Defaults: `err`, `req`, `res`                                                                                        |
| `timestamp`                         | `() => string`                | `() => new Date().toISOString()`                             | Custom override                                                                                                      |

### 4.3 `applyDefaults()` — how `otel.fieldFormat` becomes individual field names

The lib normalizes user-supplied options through a small `applyDefaults()` pass before constructing Pino. The relevant rule for `otel.fieldFormat`:

> When `otel.fieldFormat === 'snake_case'`, `applyDefaults()` sets
> `traceIdField = 'trace_id'`, `spanIdField = 'span_id'`, `traceFlagsField = 'trace_flags'`
> **unless** those keys are already provided by the consumer. **Individual fields always win over `fieldFormat`** — explicit `traceIdField: 'my_trace'` is preserved even if `fieldFormat: 'snake_case'`.

Pseudo-implementation:

```typescript
function applyDefaults(opts: BymaxLoggerModuleOptions): NormalizedOptions {
  const fieldFormat = opts.otel?.fieldFormat ?? 'camelCase'
  const snakeCase = fieldFormat === 'snake_case'

  const traceIdField = opts.otel?.traceIdField ?? (snakeCase ? 'trace_id' : 'traceId')
  const spanIdField = opts.otel?.spanIdField ?? (snakeCase ? 'span_id' : 'spanId')
  const traceFlagsField = opts.otel?.traceFlagsField ?? (snakeCase ? 'trace_flags' : 'traceFlags')

  return { ...opts, otel: { ...opts.otel, traceIdField, spanIdField, traceFlagsField } }
}
```

This is what the composed mixin (§11.1.1) consumes via the `fieldNames` parameter.

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

`ILogDestination` exposes a simple `write(payload: string)` method, but Pino's `multistream` API expects Node `Writable` streams. The lib bridges the two with a small internal helper that wraps each destination in a `Writable` adapter.

```typescript
import { Writable } from 'node:stream'

import { reportDestinationFailure, safeDestinationName } from './report-destination-failure.util'
import { writeStdoutSafely } from './safe-stdio.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { DestinationHealth } from '../services/destination-health.service'

/**
 * Internal helper: wrap an ILogDestination in a Writable suitable for pino.multistream.
 *
 * - `_write(chunk, _enc, cb)` hands the payload to `dest.write()` and invokes `cb()`
 *   synchronously when the destination returns `undefined`.
 * - Size bounding is NOT done here. `createSizeBoundedSerializer` is a Pino serializer and
 *   runs before the entry is serialized, replacing an oversized payload with a synthetic
 *   envelope carrying `LOGGER_ENTRY_TRUNCATED`; by the time a chunk reaches this adapter it
 *   is already within the budget.
 * - On destination errors — thrown or rejected — the wrapper records the failure in
 *   `DestinationHealth`, reports `LOGGER_DESTINATION_WRITE_FAILED` to stderr and calls `cb()`
 *   without an error (never throws — `cb(err)` would surface as a stream `'error'` and take
 *   the host down, and an unreported rejection would crash the process).
 * - Per-destination level filtering happens at the multistream entry level (`{ stream, level }`),
 *   which the FACTORY builds; the adapter returns the `Writable` only.
 * - Backpressure: the adapter never returns a value from `_write` — deferring `cb` is the whole
 *   mechanism, and the buffer it grows is what makes the public `write()` return `false`.
 */
export function destinationToStream(dest: ILogDestination, health: DestinationHealth): Writable {
  return new Writable({
    // String chunks stay strings: Pino writes UTF-8 NDJSON, so this skips a
    // string→Buffer→string round-trip on the hot path.
    decodeStrings: false,
    write(chunk: string | Buffer, _enc, cb) {
      try {
        // NOT truncated here. Size bounding is a Pino SERIALIZER
        // (`createSizeBoundedSerializer`), applied before the entry is
        // serialized — by the time a chunk reaches this adapter it is already
        // within the budget.
        const payload = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        // A sink that failed `onInit` never became live, so it is SKIPPED rather
        // than written to — its `write()` may assume resources it never acquired.
        // The fan-out has a stream for every REGISTERED destination, so this branch
        // is what keeps a failed one out of it. When nothing initialized at all, the
        // elected rescuer emits the raw entry to stdout: without it, one bad
        // destination silences the whole application.
        if (health.isFailed(dest)) {
          if (health.shouldRescue(dest)) writeStdoutSafely(payload)
          cb()
          return
        }
        const result = dest.write(payload)
        // Branch on `undefined`, NOT on `result instanceof Promise`: `instanceof` is
        // realm-local and answers `false` for a cross-realm promise or a plain
        // thenable, which would then take the synchronous path and lose the entry.
        if (result !== undefined) {
          // Counted while IN FLIGHT: readiness can run before this settles, and a
          // pending write must read as unproven rather than as silent success.
          health.markWritePending(dest)
          Promise.resolve(result).then(
            () => {
              health.markWriteSettled(dest)
              cb()
            },
            (err: unknown) => {
              health.markWriteSettled(dest)
              // RECORDED before it is reported: without `markWriteFailed`, readiness
              // still counts this sink as having taken the entry and another
              // destination may discard the copy it was holding.
              health.markWriteFailed(dest)
              const name = safeDestinationName(dest)
              // Through `reportDestinationFailure`, not formatted inline: it does the
              // `String(cause)` and the `name`/`message` reads INSIDE its own guard,
              // so an Error with a throwing getter cannot make this handler throw
              // before `cb()`, and it escapes the control characters a terminal would
              // otherwise interpret from a remote-derived message.
              reportDestinationFailure(
                RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
                name,
                err,
                `Log destination "${name}" failed to write; the entry was dropped`
              )
              cb()
            }
          )
          return
        }
        cb()
      } catch (err) {
        health.markWriteFailed(dest)
        const name = safeDestinationName(dest)
        reportDestinationFailure(
          RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
          name,
          err,
          `Log destination "${name}" failed to write; the entry was dropped`
        )
        cb()
      }
    }
  })
}

/**
 * Size bounding, as it is actually implemented: a Pino SERIALIZER wrapper, not a
 * step inside the write adapter. It runs before the entry is serialized, so by the
 * time a chunk reaches `destinationToStream` it is already within budget.
 *
 * The oversized value is replaced by a marker OBJECT rather than a whole synthetic
 * NDJSON line, because at this point the entry is still being built — replacing the
 * finished line would discard the surrounding fields with it.
 *
 * Fail-soft twice over: an un-measurable value (circular reference, hostile
 * `toJSON`) passes through untouched rather than throwing on the logging path, and
 * so does a serializer that legitimately returns `undefined`.
 */
export function createSizeBoundedSerializer<T>(
  baseSerializer: (input: T) => unknown,
  maxBytes: number
): (input: T) => unknown {
  return (input: T): unknown => {
    const serialized = baseSerializer(input)
    let json: string | undefined
    try {
      json = JSON.stringify(serialized)
    } catch {
      return serialized
    }
    if (json === undefined) return serialized
    const byteSize = Buffer.byteLength(json, 'utf-8')
    if (byteSize > maxBytes) {
      return {
        _truncated: true,
        _logKey: RESERVED_LOG_KEYS.LOGGER_ENTRY_TRUNCATED,
        _originalSize: byteSize,
        _preview: json.slice(0, PREVIEW_LENGTH)
      }
    }
    return serialized
  }
}
```

**Multistream wiring** (in `pino-factory.ts`):

```typescript
import pino from 'pino'

// The LEVEL is attached here, not returned by the adapter: `pino.multistream`
// filters per entry, and the adapter's only job is the write fan-out.
const entries = destinations.map((d) => ({
  // Guarded: this runs at provider construction, before any lifecycle hook, so a
  // throwing `minLevel` getter would fail the factory and the application would
  // never start. The guard also pins the answer, so this level and the one the
  // registry records for the same destination cannot diverge.
  level: safeMinLevel(d) ?? options.level,
  stream: destinationToStream(d, health)
}))
const multistream = pino.multistream(entries, { dedupe: false })
const logger = pino(pinoOptions, multistream)
```

> **Why a `Writable` wrapper and not direct calls?** Pino's multistream resolves per-entry level filtering and applies backpressure based on standard stream semantics. Implementing the contract via `Writable._write` is the smallest adapter surface that gives the lib both behaviors for free.

### 5.3 Default destination — `DefaultStdoutDestination`

Canonical implementation the lib registers automatically:

```typescript
export class DefaultStdoutDestination implements ILogDestination {
  readonly name = 'stdout-json'
  readonly minLevel?: LogLevel

  constructor(opts: { minLevel?: LogLevel } = {}) {
    this.minLevel = opts.minLevel
  }

  write(payload: string): void {
    process.stdout.write(payload)
  }
}
```

### 5.4 Dev destination — `PrettyDevDestination`

When `NODE_ENV !== 'production'` or `pretty: true`, the lib also registers a destination that uses `pino-pretty` as a transport:

```typescript
import { Transform } from 'node:stream'
import pretty from 'pino-pretty'

export class PrettyDevDestination implements ILogDestination {
  readonly name = 'pretty-dev'
  private readonly stream: Transform

  constructor() {
    this.stream = pretty({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname,service',
      singleLine: false
    })
    this.stream.pipe(process.stdout)
  }

  write(payload: string): void {
    this.stream.write(payload)
  }

  onShutdown(): void {
    this.stream.end()
  }
}
```

> `pino-pretty` is an **optional peer dependency**. If not installed and `pretty: true`, the lib emits a bootstrap warning and falls back to `DefaultStdoutDestination`.

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
          timestamp: new Date(Number(entry.time))
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

> **Note about `any`:** the `log/error/warn/debug/verbose/fatal` methods accept `message: any` and `...optionalParams: any[]` **because the official NestJS interface requires it** ([source](https://github.com/nestjs/nest/blob/master/packages/common/services/logger.service.ts)). Replacing with `unknown` would break contract checking for `app.useLogger()`. This is the **only exception** to the "zero `any`" rule in §1.6 — all other methods (`info`, `warnStructured`, `errorStructured`, `child`, `setContext`, `getRawLogger`) use precise types. The snippet below shows only the public surface (method bodies elided with `{ ... }`); the full implementation lives in `pino-logger.service.ts`.

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
   * Context attached to every log emitted by this instance. Set via `setContext()` or
   * `@LogContext()` decorator.
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
   *   logger.log({ userId: 'u_1' }, 'User created') // structured (Pino-style)
   */
  log(message: any, ...optionalParams: any[]): void { ... }

  /**
   * Logs an error. Two patterns supported:
   *   1. NestJS variadic: error(message, trace?, context?)
   *   2. Structured: error(logKey: string, error: Error, userId?: string, metadata?: object)
   *
   * Pattern detection: if `secondArg instanceof Error`, switches to structured path.
   */
  error(message: any, ...optionalParams: any[]): void { ... }

  warn(message: any, ...optionalParams: any[]): void { ... }
  debug(message: any, ...optionalParams: any[]): void { ... }
  verbose(message: any, ...optionalParams: any[]): void { ... }
  fatal(message: any, ...optionalParams: any[]): void { ... }

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
   * Useful when injecting via @LogContext or in constructor.
   */
  setContext(context: string): void { ... }

  /**
   * Create a child logger with bound key/value pairs.
   * Useful for per-job, per-request, per-user loggers.
   *
   * Semantics:
   *  - Returns a NEW `PinoLoggerService` instance that wraps `getRawLogger().child(bindings)`.
   *  - The child INHERITS the same `LogContextService` reference (ALS is process-wide,
   *    not per-child) — so `requestId` / `tenantId` / `userId` propagate to the child too.
   *  - The child has its OWN bindings merged into every log it emits.
   *  - Calling `getRawLogger()` on the child returns the underlying Pino child instance.
   *  - `setContext()` on the child only changes the child's `context` binding — it does
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

  async onApplicationShutdown(): Promise<void> {
    // Flush via destination registry
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

@Injectable()
export class LogContextService {
  private readonly als = new AsyncLocalStorage<LogContext>()

  /**
   * Run a callback inside a context scope. All logs emitted within the callback
   * (synchronously or asynchronously) inherit the context.
   */
  run<T>(context: LogContext, callback: () => T): T {
    return this.als.run(context, callback)
  }

  /**
   * Returns the current context, or `undefined` if outside any scope.
   */
  getStore(): LogContext | undefined {
    return this.als.getStore()
  }

  /**
   * Add or override fields in the current context (mutates the active store).
   * Throws if called outside a `run()` scope.
   */
  set(key: string, value: unknown): void {
    const store = this.als.getStore()
    if (!store) throw new Error('LogContextService.set() called outside run() scope')
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

Manages the lifecycle of registered destinations:

```typescript
@Injectable()
class DestinationRegistry implements OnModuleInit, OnApplicationShutdown {
  /** The subset that initialized successfully — used for SHUTDOWN, not for writes.
   *  The fan-out is built from the full registered set and gates each write on
   *  `DestinationHealth.isFailed`, so a failed sink is skipped per write rather
   *  than removed from the streams. `onShutdown` runs over this subset because a
   *  destination that never initialized may have no resources to close. */
  private readonly active: ILogDestination[] = []

  // Every provider carries an explicit `@Inject`, including the class-typed one:
  // tsup strips decorator metadata, so implicit DI resolves in development and
  // fails in the published package.
  constructor(
    @Inject(LOGGER_DESTINATIONS_TOKEN) private readonly destinations: ILogDestination[],
    @Inject(PinoLoggerService) private readonly logger: PinoLoggerService,
    @Inject(DestinationHealth) private readonly health: DestinationHealth,
    @Inject(LOGGER_OPTIONS_TOKEN) private readonly options: ResolvedBymaxLoggerModuleOptions
  ) {}

  /** The severity a destination actually receives: the STRICTER of the module
   *  level and the destination's own `minLevel`. */
  private effectiveLevelOf(dest: ILogDestination): LogLevel {
    const moduleLevel = this.options.level
    // Read ONCE, through the guard: `minLevel` is consumer-defined and may be a
    // getter that throws — this runs on both branches of the init loop, including
    // the catch that keeps a failing destination from aborting bootstrap — and it
    // may be stateful, which is why the guard pins the first answer so the factory
    // and this recording cannot disagree about the same destination's level.
    const configured = safeMinLevel(dest)
    if (configured === undefined) return moduleLevel
    // `LOG_LEVEL_PRIORITY.indexOf`, mirroring the implementation. `PINO_LEVEL_NUMBERS`
    // would order identically — both run trace→fatal — but the specification exists to
    // describe the shipped code, not an equivalent way of writing it.
    return LOG_LEVEL_PRIORITY.indexOf(configured) > LOG_LEVEL_PRIORITY.indexOf(moduleLevel)
      ? configured
      : moduleLevel
  }

  async onModuleInit() {
    // Each onInit() is wrapped in try/catch. On failure the destination is recorded
    // as FAILED in `DestinationHealth`, and that recording is what keeps entries away
    // from it: the adapter checks `isFailed` on every write. Being absent from
    // `active` has nothing to do with it — `active` drives shutdown. The destination
    // stays REGISTERED so the readiness hook still reaches it.
    // `LOGGER_DESTINATION_INIT_FAILED` goes to stderr because Pino is not yet wired
    // at this point. The lib NEVER throws to abort boot — degraded mode over crash.
    for (const dest of this.destinations) {
      try {
        await dest.onInit?.()
        this.active.push(dest)
        this.health.markHealthy(dest, this.effectiveLevelOf(dest))
      } catch (err) {
        this.health.markFailed(dest, this.effectiveLevelOf(dest))
        // Guarded: reading `name` at the call site would put the throw back inside
        // this catch, which exists so a failing destination cannot abort boot.
        const name = safeDestinationName(dest)
        reportDestinationFailure(
          RESERVED_LOG_KEYS.LOGGER_DESTINATION_INIT_FAILED,
          name,
          err,
          `Log destination "${name}" failed to initialize and was skipped`
        )
      }
    }
    // The registered set is NOT truncated to the survivors, and nothing else needs
    // it to be: the fan-out covers every registered destination and `destinationToStream`
    // skips a failed one per write via `health.isFailed` (see the adapter above).
    // Keeping it registered matters because a sink that failed `onInit` is the one
    // most likely to be holding entries it now has to resolve — dropping it here
    // would strand them and silently break the guarantee below.

    // Called for EVERY registered destination, healthy and failed alike, once all
    // `onInit` calls have settled, and awaited. Isolated per destination: a hook
    // that throws is reported and skipped rather than aborting the rest.
    for (const dest of this.destinations) {
      try {
        await dest.onRegistryReady?.({
          heldEntriesDeliveredElsewhere: this.health.deliveredByHealthySink(
            dest,
            this.effectiveLevelOf(dest)
          )
        })
      } catch (err) {
        // The same key the real registry reuses for a failing readiness hook;
        // there is no separate reserved key for it.
        const name = safeDestinationName(dest)
        reportDestinationFailure(
          RESERVED_LOG_KEYS.LOGGER_DESTINATION_INIT_FAILED,
          name,
          err,
          `Log destination "${name}" failed its readiness hook`
        )
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Emitted BEFORE the sinks are torn down — an entry written after they closed
    // would have nowhere to go. It is the bookend to `LOGGER_BOOTSTRAP_OK`: its
    // absence tells an operator a graceful shutdown from a killed process.
    this.logger.info(
      RESERVED_LOG_KEYS.LOGGER_SHUTDOWN_OK,
      'BymaxLoggerModule shutting down',
      undefined,
      { destinations: this.active.length }
    )
    // Yield the event loop once: `destinationToStream` leaves the Writable callback
    // pending until an async `write()` settles, so without this barrier the loop
    // below could close a sink whose shutdown entry is still in flight. A
    // best-effort ordering nudge, not a delivery guarantee — the authoritative
    // contract is `ILogDestination.onShutdown`, which MUST flush pending writes.
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    // Reverse order — first registered closes last. Over ACTIVE, not registered:
    // a destination whose `onInit` failed may never have acquired the resources
    // `onShutdown` would close.
    //
    // Sequential and per-destination guarded, NOT `Promise.allSettled`: settling
    // every promise contains the failures but reports none of them, so a final
    // flush that lost its batch would leave no trace anywhere.
    for (const dest of [...this.active].reverse()) {
      try {
        await dest.onShutdown?.()
      } catch (err) {
        // Coercion INSIDE the guard, and the text escaped. Reading `stack`/`message`
        // on an Error with hostile getters, or `String(err)` on a value with a
        // throwing `Symbol.toPrimitive`, throws from within this catch — and the
        // throw would propagate out of `onApplicationShutdown`, skipping the flush
        // of every destination still queued behind this one.
        this.reportShutdownFailure(dest, err)
      }
    }
  }

  /**
   * Report a failing `onShutdown` without letting the report abort the teardown
   * of the destinations still queued behind it.
   *
   * The DESTINATION is passed, not its name: `readonly name: string` does not stop
   * a consumer implementing it as a getter, and reading it at the call site would
   * put the throw back inside the catch. Name and detail are guarded separately,
   * so one unreadable value does not cost the other.
   */
  private reportShutdownFailure(dest: ILogDestination, cause: unknown): void {
    const name = toSingleLineMessage(safeDestinationName(dest))
    let detail = 'UnknownError'
    try {
      // The two escapers are NOT interchangeable: `escapeControlCharacters` keeps
      // newlines because a stack is legitimately multi-line, so it may only be used
      // ON a stack. A message, or a non-Error value, is a single-line field —
      // routing it through the multi-line escaper lets `failed\n[forged entry]`
      // write a second raw line an operator reads as genuine.
      const stack = isErrorLike(cause) ? cause.stack : undefined
      detail =
        stack === undefined
          ? toSingleLineMessage(isErrorLike(cause) ? String(cause.message) : String(cause))
          : escapeControlCharacters(String(stack))
    } catch {
      // A value that cannot be read is still worth a line naming the destination.
    }
    writeStderrSafely(`[DestinationRegistry] Shutdown failed for "${name}": ${detail}\n`)
  }
}
```

### 6.4 `BymaxLoggerModule.useNestLogger(app)` — wiring the lib as NestJS's logger

The `shouldUseAsNestLogger?: boolean` option (default `true`) signals **intent**: the consumer wants this lib to replace NestJS's default internal logger (`Bootstrap`, `RoutesResolver`, `NestApplication`). However, because the lib lives inside a module and cannot reach the `INestApplication` instance, the **runtime wiring** must happen in `main.ts`. The lib exposes a static helper for it:

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
    const loggerService = app.get(PinoLoggerService, { strict: false })
    app.useLogger(loggerService)
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

> **Why the option exists if wiring is manual?** `shouldUseAsNestLogger: true` is purely a convention hint — the lib emits a bootstrap log that informs the consumer whether the helper is expected to be called. Calling `useNestLogger(app)` when `shouldUseAsNestLogger: false` is a no-op contract violation that surfaces as a warning. The lib **cannot** auto-wire `app.useLogger()` because modules don't see the `INestApplication`.

---

## 7. Interceptors

### 7.1 `HttpLoggingInterceptor`

Logs the full HTTP request lifecycle. Normalizes URLs to avoid an explosion of distinct log keys (`/users/abc-123` and `/users/def-456` both become `/users/:id`).

```typescript
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor
} from '@nestjs/common'
import { Observable, catchError, tap, throwError } from 'rxjs'
import { PinoLoggerService } from '../services/pino-logger.service'
import { LogContextService } from '../services/log-context.service'
import { normalizeUrl } from '../utils/normalize-url.util'

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly logger: PinoLoggerService,
    private readonly logContext: LogContextService
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpCtx = ctx.switchToHttp()
    const req = httpCtx.getRequest()
    const res = httpCtx.getResponse()

    const { method, url, ip } = req
    const userAgent = req.headers['user-agent'] ?? 'unknown'
    const userId = req.user?.id
    const normalizedUrl = normalizeUrl(url)
    const start = Date.now()

    this.logger.info('HTTP_REQUEST_START', `${method} ${normalizedUrl}`, userId, {
      method,
      url: normalizedUrl,
      fullUrl: url,
      ip,
      userAgent
    })

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start
        const statusCode = res.statusCode
        if (statusCode >= 200 && statusCode < 300) {
          this.logger.info(
            'HTTP_REQUEST_SUCCESS',
            `${method} ${normalizedUrl} → ${statusCode} (${duration}ms)`,
            userId,
            { method, url: normalizedUrl, statusCode, duration }
          )
        } else if (statusCode >= 300 && statusCode < 400) {
          this.logger.info(
            'HTTP_REQUEST_REDIRECT',
            `${method} ${normalizedUrl} → ${statusCode}`,
            userId,
            { method, url: normalizedUrl, statusCode, duration }
          )
        }
      }),
      catchError((err: unknown) => {
        const duration = Date.now() - start
        const statusCode =
          err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
        const logKey = statusCode >= 500 ? 'HTTP_REQUEST_SERVER_ERROR' : 'HTTP_REQUEST_CLIENT_ERROR'

        // Always emit the timing/completion log so latency observability is preserved
        // even when the HttpExceptionFilter owns the error log (see §8.1 "Double-log avoidance").
        this.logger.info(
          'HTTP_REQUEST_COMPLETED',
          `${method} ${normalizedUrl} → ${statusCode} (${duration}ms)`,
          userId,
          { method, url: normalizedUrl, statusCode, duration }
        )

        // Skip the redundant error log if the HttpExceptionFilter already logged it.
        const alreadyHandled =
          (req as { __bymax_logger_handled?: boolean }).__bymax_logger_handled === true
        if (alreadyHandled) {
          return throwError(() => err)
        }

        if (statusCode >= 500) {
          this.logger.errorStructured(
            logKey,
            err instanceof Error ? err : new Error(String(err)),
            userId,
            { method, url: normalizedUrl, statusCode, duration }
          )
        } else {
          this.logger.warnStructured(logKey, `${method} ${normalizedUrl} → ${statusCode}`, userId, {
            method,
            url: normalizedUrl,
            statusCode,
            duration,
            errorMessage: (err as Error)?.message
          })
        }
        return throwError(() => err)
      })
    )
  }
}
```

### 7.2 URL normalization algorithm

Pure function, exported as `normalizeUrl(url: string): string`:

```typescript
const UUID_REGEX = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ULID_REGEX = /\/[0-9A-HJKMNP-TV-Z]{26}/g // Crockford base32, 26 chars
const NANOID_REGEX = /\/[A-Za-z0-9_-]{21}/g // nanoid default size

export function normalizeUrl(url: string): string {
  // Remove query string
  const path = url.split('?')[0] ?? ''

  return path
    .replace(UUID_REGEX, '/:id')
    .replace(ULID_REGEX, '/:id')
    .replace(NANOID_REGEX, '/:id')
    .replace(/\/\d+/g, '/:id') // pure numeric IDs
}
```

### 7.3 Registration as a global interceptor

When `http.isEnabled: true`, the lib automatically registers via `APP_INTERCEPTOR`:

```typescript
// Internally in logger.module.ts:
{
  provide: APP_INTERCEPTOR,
  useClass: HttpLoggingInterceptor,
}
```

---

## 8. Filters

### 8.1 `HttpExceptionFilter`

Catches `HttpException`s that escape the interceptor (rare but possible) and responds with a standard payload. Always logs, with the level based on the status code.

```typescript
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common'
import { PinoLoggerService } from '../services/pino-logger.service'
import { sanitizeError } from '../utils/sanitize-error.util'

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse()
    const req = ctx.getRequest()

    const isHttpException = exception instanceof HttpException
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR
    const body = isHttpException
      ? exception.getResponse()
      : { statusCode: status, message: 'Internal server error' }

    const logKey = status >= 500 ? 'HTTP_EXCEPTION_UNHANDLED' : 'HTTP_EXCEPTION_HANDLED'
    const userId = req.user?.id
    const metadata = { method: req.method, url: req.url, status }

    if (status >= 500) {
      this.logger.errorStructured(
        logKey,
        exception instanceof Error ? sanitizeError(exception) : new Error(String(exception)),
        userId,
        metadata
      )
    } else {
      this.logger.warnStructured(
        logKey,
        (exception as { message?: string }).message ?? 'HTTP exception',
        userId,
        metadata
      )
    }

    // Mark the request so the HttpLoggingInterceptor's catchError can detect
    // that the filter already logged this 5xx and skip its own error log.
    ;(req as { __bymax_logger_handled?: boolean }).__bymax_logger_handled = true

    res.status(status).json(body)
  }
}
```

#### Double-log avoidance

The `HttpExceptionFilter` sets `req.__bymax_logger_handled = true` after logging an exception. The `HttpLoggingInterceptor`'s `catchError` checks this flag and **skips its own error log** when set — so a single failure produces exactly one `HTTP_EXCEPTION_*` log instead of duplicating it as `HTTP_REQUEST_*_ERROR`.

The interceptor still emits `HTTP_REQUEST_COMPLETED` (with timing) so latency observability is preserved across the success and failure paths. In short: the filter owns the **what failed** log; the interceptor owns the **how long it took** log.

---

## 9. Decorators

### 9.1 `@InjectLogger()`

Convenience to avoid repeating `@Inject(PinoLoggerService)` in constructors. When given an optional name, it returns a per-injection-point **child logger** bound to that context — no singleton mutation, no request scope required.

#### Implementation mechanism (no handwave)

`@InjectLogger(context?: string)` is implemented as a custom parameter decorator that produces a NestJS provider factory token. At provider time:

- The factory resolves the root `PinoLoggerService` from the DI container.
- It calls `logger.child({ context: context ?? <className-from-reflect-metadata> })` and returns the child.
- Class context defaults to the **host class's name**, read either via `Reflect.getMetadata('design:type', target)` or via `target.constructor.name` when the metadata is unavailable.
- Each injection point gets a distinct child logger, so per-class context is **isolated** — no singleton mutation across services.
- Because the implementation uses `child(bindings)` (see §6.1), it is safe across async contexts: the ALS-managed `requestId` / `tenantId` / `userId` still flow through the inherited `LogContextService`, while only the `context` binding is per-class.

```typescript
import { Inject } from '@nestjs/common'
import { PinoLoggerService } from '../services/pino-logger.service'

/**
 * Returns a parameter decorator that injects a PinoLoggerService child bound
 * to a per-injection-point `context`. The decorator collects metadata at decoration
 * time; the module wires a provider factory at compile time that, on resolve,
 * returns `rootLogger.child({ context })`.
 */
export function InjectLogger(context?: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    // 1) Register the dependency on the root PinoLoggerService.
    Inject(PinoLoggerService)(target, propertyKey, parameterIndex)

    // 2) Record the requested context on class metadata. The module reads this
    //    list at registration time and emits one provider factory per entry:
    //
    //      {
    //        provide: INJECT_LOGGER_TOKEN(target, parameterIndex),
    //        useFactory: (root: PinoLoggerService) =>
    //          root.child({ context: context ?? target.constructor.name }),
    //        inject: [PinoLoggerService],
    //      }
    //
    //    The token returned by INJECT_LOGGER_TOKEN is what NestJS resolves at
    //    construction time, replacing the direct PinoLoggerService injection
    //    above with the bound child instance.
  }
}
```

> **Why the child-logger approach over a request-scoped interceptor?** A `LoggerContextInterceptor` that reads metadata and calls `setContext()` on a request-scoped logger also works, but forces every consumer of the logger into `Scope.REQUEST` (~5% latency penalty per §17.1) and pays the ALS overhead on every log. The child-logger approach is **zero-cost**: the child is created once at provider time, lives as a singleton tied to its host class, and emits its `context` binding for free.

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

### 9.2 `@LogContext(name)`

Class decorator — marks an entire class with a fixed context. All logs emitted by instances of that class carry `context: <name>`.

```typescript
import { SetMetadata } from '@nestjs/common'

export const LOG_CONTEXT_METADATA_KEY = Symbol('BYMAX_LOGGER_CONTEXT')

export const LogContext = (name: string) => SetMetadata(LOG_CONTEXT_METADATA_KEY, name)
```

Usage:

```typescript
@LogContext('PaymentsService')
@Injectable()
export class PaymentsService { ... }
```

### 9.3 `@LogPerformance(thresholdMs?)`

Method decorator. Logs execution duration. If the duration exceeds `thresholdMs`, it raises the level to `warn` (`SLOW_METHOD`).

```typescript
export function LogPerformance(thresholdMs = 1000): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value
    descriptor.value = async function (this: { logger?: PinoLoggerService }, ...args: unknown[]) {
      const start = Date.now()
      try {
        return await original.apply(this, args)
      } finally {
        const duration = Date.now() - start
        const method = `${target.constructor.name}.${String(propertyKey)}`
        if (this.logger) {
          if (duration > thresholdMs) {
            this.logger.warnStructured(
              'METHOD_SLOW_EXECUTION',
              `${method} took ${duration}ms`,
              undefined,
              { method, duration, thresholdMs }
            )
          } else {
            this.logger.info('METHOD_EXECUTION', `${method} completed`, undefined, {
              method,
              duration
            })
          }
        }
      }
    }
    return descriptor
  }
}
```

> Requires `this.logger` to be an instance of `PinoLoggerService` (usually by injection). The decorator fails silently if `logger` is not present — it does not force a pattern.

---

## 10. PII Redaction Strategy

### 10.1 Default list — `DEFAULT_REDACT_PATHS`

> ⚠️ **Important about `*` wildcards in `pino.redact` (powered by `fast-redact`)**: the `*` wildcard matches **a single level** of the tree — it is not recursive. `*.password` redacts `body.password`, `meta.password`, etc., but does **not** redact `body.user.password` (you need `*.*.password`). For depth coverage, we list paths for depths 1 through 4 levels. Absolute paths (`req.body.creditCard.number`) follow standard bracket/dot syntax. Source: [github.com/davidmarkclements/fast-redact](https://github.com/davidmarkclements/fast-redact#wildcards).

Pino-syntax paths. Defensive coverage at **4 levels** (sufficient for most HTTP/RPC payloads):

```typescript
/**
 * Helper: generates wildcard variants by depth. fast-redact does not support
 * recursive descent (`**`), so we list each level explicitly.
 *
 * Output: ['*.password', '*.*.password', '*.*.*.password', '*.*.*.*.password']
 */
const depth = (field: string): readonly string[] =>
  ['*', '*.*', '*.*.*', '*.*.*.*'].map((prefix) => `${prefix}.${field}`)

export const DEFAULT_REDACT_PATHS: readonly string[] = [
  // Passwords — depth 1-4
  ...depth('password'),
  ...depth('passwordHash'),
  ...depth('passwordConfirm'),
  ...depth('newPassword'),
  ...depth('oldPassword'),

  // Tokens
  ...depth('token'),
  ...depth('accessToken'),
  ...depth('refreshToken'),
  ...depth('idToken'),
  ...depth('apiKey'),
  ...depth('apiSecret'),

  // MFA
  ...depth('mfaSecret'),
  ...depth('mfaRecoveryCodes'),
  ...depth('totpSecret'),

  // Payment (PCI DSS)
  ...depth('cardNumber'),
  ...depth('cardCvv'),
  ...depth('cvv'),
  ...depth('cvc'),
  ...depth('cardExpiry'),

  // Personal documents (BR — LGPD)
  ...depth('cpf'),
  ...depth('cnpj'),
  ...depth('rg'),

  // Common headers with secrets (absolute paths — in the wildcard)
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]',

  // Conservative PII — email can be disabled if the app justifies logging
  ...depth('email')
] as const
```

> **Performance:** with 140 generated paths (27 root fields + 27 × 4 levels = 108 + 5 absolute header paths), `fast-redact` compiles everything into a single JS function at initialization. Pino benchmark: redacting 100 paths impacts ~3% on throughput. There is no per-log regex matching overhead.

> **Auditing the redact registry:** the consumer can inspect via `LOGGER_OPTIONS_TOKEN` (see §10.5). In test environments, expose `compileRedactPaths(opts).effectivePaths` for CI assertions that expected paths are active.

### 10.2 How to extend

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  redactPaths: [
    '*.internalSecret', // adds
    'body.creditCard.*', // deep redaction inside subobject
    'payload.user.taxId' // specific path
  ]
})
```

The lib **merges** with `DEFAULT_REDACT_PATHS` (does not replace). To fully replace:

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  shouldDisableDefaultRedact: true, // discards defaults
  redactPaths: ['*.password'] // only these
})
```

⚠️ `shouldDisableDefaultRedact: true` is recorded as a warning in the bootstrap log for security-review auditing.

### 10.3 Performance — builtin `fast-redact`

`pino.redact` uses `fast-redact` internally, which **compiles** paths at initialization time into a specialized JavaScript function built via `new Function(...)`. There is in the per-log overhead from regex matching or object tree traversal.

**Recommended limits:**

- ≤ 200 total paths: < 5% throughput impact
- > 200 paths: evaluate grouping by depth or a custom serializer

Superseded in `1.2.0`. Path-based redaction was measured at ~107 µs per entry (~9.3 k logs/s),
not the ~3% the official benchmark suggests — the cost grows with the PATH COUNT, and the default
list expands to 140. The default is now a name-keyed snapshotting walk at ~3.6 µs per entry; the
path expansion survives for consumer `redactPaths` and the opt-in `redactStrategy: 'paths'`.
See `docs/guidelines/PINO-REDACTION-GUIDELINES.md` and `bench/README.md`.

### 10.4 Customizable censor

```typescript
BymaxLoggerModule.forRoot({
  service: { name: 'my-app', version: '1.0.0' },
  redactCensor: '***' // or function: (value) => '<' + typeof value + '>'
})
```

A custom function enables **typed** redaction (preserving the type: number becomes `0`, string becomes `''`) — useful when the type schema is validated downstream.

### 10.5 Audit — checking paths at runtime

```typescript
// For debugging in dev:
import { LOGGER_OPTIONS_TOKEN } from '@bymax-one/nest-logger'

@Injectable()
class LogAuditService {
  constructor(@Inject(LOGGER_OPTIONS_TOKEN) private readonly opts: BymaxLoggerModuleOptions) {}

  listActiveRedactPaths(): string[] {
    return [...DEFAULT_REDACT_PATHS, ...(this.opts.redactPaths ?? [])]
  }
}
```

---

## 11. OpenTelemetry Integration

### 11.1 Detecting active OTel

The lib uses `@opentelemetry/api` as an **optional peer dependency**. Because the package ships as ESM (`"type": "module"` in `package.json`), `require` is not available by default — we use `createRequire` from `node:module` for synchronous optional resolution, or `await import()` in async modules:

```typescript
import { createRequire } from 'node:module'

// Sync (preferred — runs at module bootstrap, not in the hot path)
let trace: typeof import('@opentelemetry/api').trace | undefined
try {
  const requireFromHere = createRequire(import.meta.url)
  trace = requireFromHere('@opentelemetry/api').trace
} catch {
  trace = undefined // OTel API not installed → graceful fallback
}
```

Equivalent async alternative (for cases where the lib is loaded with top-level `await`):

```typescript
let trace: typeof import('@opentelemetry/api').trace | undefined
try {
  const otelApi = await import('@opentelemetry/api')
  trace = otelApi.trace
} catch {
  trace = undefined
}
```

For CJS builds (generated by `tsup` for the `require` subpath), `createRequire` falls back to native CommonJS `require`. Both forms converge to the same runtime behavior.

On every log, the trace context mixin (**official Pino 10 signature**: `(mergeObject, level, logger) => object`):

```typescript
import type { Logger as PinoLogger } from 'pino'

/**
 * Pino mixin invoked for every log entry. Reads:
 *   - OTel active span (if SDK started) → traceId, spanId, traceFlags
 *   - LogContextService store (if inside run() scope) → requestId, tenantId, userId
 *
 * Returns the partial object merged into the log entry.
 *
 * @param _mergeObject Object the caller passed to pino.info(obj, msg) — unused here
 * @param _level       Numeric Pino level (10..60) — unused here
 * @param _logger      The Pino instance — unused here, but part of v10 mixin contract
 */
function traceContextMixin(
  _mergeObject: Record<string, unknown>,
  _level: number,
  _logger: PinoLogger
): Record<string, string> | undefined {
  if (!trace) return undefined
  const span = trace.getActiveSpan()
  if (!span) return undefined
  const ctx = span.spanContext()
  if (!ctx.traceId || ctx.traceId === '00000000000000000000000000000000') return undefined
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    traceFlags: ctx.traceFlags.toString(16).padStart(2, '0')
  }
}
```

**Behavior without OTel:** the lib logs normally, with in the `traceId`/`spanId`.
**Behavior with OTel but in the active span:** the lib logs without `traceId`/`spanId` (because there is in the contextualized trace).
**Behavior with OTel + active span:** the lib injects `traceId`/`spanId` into every entry.

#### 11.1.1 Composed mixin (canonical implementation)

In practice the lib registers **a single** mixin that merges (i) fields from `LogContextService.getStore()` and (ii) OTel trace context derived from `trace.getActiveSpan()?.spanContext()`. This avoids registering two mixins and guarantees a deterministic merge order.

```typescript
import type { LogContextService } from '../services/log-context.service'

/**
 * Pino 10 mixin signature is `(mergeObject, level) => object`. A third argument
 * (the logger instance) is accepted by older versions but is legacy and ignored
 * in Pino 10 — we keep the 2-arg form to match the current contract.
 *
 * Merge order is intentional:
 *   1. ALS context (requestId / tenantId / userId / arbitrary fields) is written FIRST.
 *   2. OTel `traceId` / `spanId` / `traceFlags` are written LAST and OVERRIDE
 *      any same-named keys placed by ALS. Rationale: an active span is the most
 *      authoritative source of the trace identity at this exact moment.
 *
 * Performance: this runs per-log. Both lookups are O(1):
 *   - `LogContextService.getStore()` → AsyncLocalStorage read
 *   - `trace.getActiveSpan()` → context.active() then spanContext()
 */
export function buildComposedMixin(
  logContext: LogContextService,
  fieldNames: { traceId: string; spanId: string; traceFlags: string }
): (mergeObject: Record<string, unknown>, level: number) => Record<string, unknown> {
  return (_mergeObject, _level) => {
    // 1) ALS context first
    const merged: Record<string, unknown> = { ...(logContext.getStore() ?? {}) }

    // 2) OTel trace context overrides ALS-supplied same-named keys
    if (trace) {
      const span = trace.getActiveSpan()
      if (span) {
        const ctx = span.spanContext()
        if (ctx.traceId && ctx.traceId !== '00000000000000000000000000000000') {
          merged[fieldNames.traceId] = ctx.traceId
          merged[fieldNames.spanId] = ctx.spanId
          merged[fieldNames.traceFlags] = ctx.traceFlags.toString(16).padStart(2, '0')
        }
      }
    }

    return merged
  }
}
```

> **Why one mixin instead of two?** Pino accepts a single `mixin` option per logger. Composing in user code keeps merge precedence explicit and avoids ordering surprises if Pino changes how multiple mixins are layered in the future.

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

// Graceful shutdown
process.on('SIGTERM', () => {
  void sdk
    .shutdown()
    .then(() => console.log('OTel SDK shut down'))
    .catch((err) => console.error('Error shutting down OTel', err))
    .finally(() => process.exit(0))
})

// NOW import Nest
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
  // ... rest of bootstrap
}
bootstrap()
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
- `LOGIN_SUCCESS` (missing module)
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
export const RESERVED_LOG_KEYS = {
  LOGGER_BOOTSTRAP_OK: 'LOGGER_BOOTSTRAP_OK',
  LOGGER_BOOTSTRAP_WARNING: 'LOGGER_BOOTSTRAP_WARNING',
  LOGGER_SHUTDOWN_OK: 'LOGGER_SHUTDOWN_OK',
  HTTP_REQUEST_START: 'HTTP_REQUEST_START',
  HTTP_REQUEST_SUCCESS: 'HTTP_REQUEST_SUCCESS',
  HTTP_REQUEST_REDIRECT: 'HTTP_REQUEST_REDIRECT',
  HTTP_REQUEST_CLIENT_ERROR: 'HTTP_REQUEST_CLIENT_ERROR',
  HTTP_REQUEST_SERVER_ERROR: 'HTTP_REQUEST_SERVER_ERROR',
  HTTP_REQUEST_COMPLETED: 'HTTP_REQUEST_COMPLETED',
  HTTP_EXCEPTION_HANDLED: 'HTTP_EXCEPTION_HANDLED',
  HTTP_EXCEPTION_UNHANDLED: 'HTTP_EXCEPTION_UNHANDLED',
  METHOD_EXECUTION: 'METHOD_EXECUTION',
  METHOD_SLOW_EXECUTION: 'METHOD_SLOW_EXECUTION',
  LOGGER_DESTINATION_INIT_FAILED: 'LOGGER_DESTINATION_INIT_FAILED',
  LOGGER_DESTINATION_WRITE_FAILED: 'LOGGER_DESTINATION_WRITE_FAILED',
  LOGGER_ENTRY_TRUNCATED: 'LOGGER_ENTRY_TRUNCATED'
} as const
```

> **Count: 16 reserved keys.** Apps must not reuse these keys to avoid collision in log queries.

---

## 13. Error Code Catalog

Errors the lib may throw (or record as a warning):

| Code                              | Severity                    | When it occurs                                                                   | Recommended action                                                                                                            |
| --------------------------------- | --------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `LOGGER_INVALID_OPTIONS`          | Throws at initialization    | `service.name` or `service.version` missing                                      | Add the required fields                                                                                                       |
| `LOGGER_INVALID_LEVEL`            | Throws                      | `level` is not a valid Pino value                                                | Use `'fatal'\|'error'\|'warn'\|'info'\|'debug'\|'trace'`                                                                      |
| `LOGGER_PRETTY_UNAVAILABLE`       | **Never emitted**           | Declared only in the unexported `logger-error-codes.constants.ts`                | Do not query it — the real signal is `LOGGER_DESTINATION_INIT_FAILED` on stderr, `destination: "pretty-dev"`                  |
| `LOGGER_OTEL_API_UNAVAILABLE`     | Info on bootstrap           | `otel.shouldAutoInjectTraceContext: true` but `@opentelemetry/api` not installed | Install or disable `shouldAutoInjectTraceContext`                                                                             |
| `LOGGER_DESTINATION_INIT_FAILED`  | Written to **stderr**       | `destination.onInit()` rejects                                                   | Destination is dropped from the write fan-out; others continue. If NONE initialize, entries fall back to raw NDJSON on stdout |
| `LOGGER_DESTINATION_WRITE_FAILED` | Written to **stderr**       | `destination.write()` throws                                                     | Entry skipped for that destination; others continue                                                                           |
| `LOGGER_CONTEXT_OUT_OF_SCOPE`     | Throws                      | `LogContextService.set()` called outside `run()`                                 | Wrap in `logContext.run({ ... }, () => ...)`                                                                                  |
| `LOGGER_ENTRY_TRUNCATED`          | Warn (logged as a meta-log) | Entry exceeds `maxEntrySizeBytes`                                                | Reduce metadata or raise the limit                                                                                            |

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
  "reflect-metadata": "^0.2.0"
}
```

| Package            | Version    | Justification                                                                           |
| ------------------ | ---------- | --------------------------------------------------------------------------------------- |
| `@nestjs/common`   | `^11.0.16` | Decorators, `Injectable`, `LoggerService` interface. Floor excludes GHSA-cj7v-w2c7-cp7c |
| `@nestjs/core`     | `^11.1.18` | `APP_INTERCEPTOR`, `APP_FILTER`, `ModuleRef`. Floor excludes GHSA-36xv-jgw5-4q75        |
| `pino`             | `^10.0.0`  | Logging engine                                                                          |
| `reflect-metadata` | `^0.2.0`   | NestJS decorators                                                                       |

### 15.2 Optional peer dependencies

```json
"peerDependencies": {
  "pino-pretty": "^13.0.0",
  "@opentelemetry/api": "^1.9.0"
},
"peerDependenciesMeta": {
  "pino-pretty": { "optional": true },
  "@opentelemetry/api": { "optional": true }
}
```

| Package              | When to install                                    | Declared range |
| -------------------- | -------------------------------------------------- | -------------- |
| `pino-pretty`        | If `pretty: true` or using `PrettyDevDestination`  | `^13.0.0`      |
| `@opentelemetry/api` | If you want `traceId`/`spanId` correlation in logs | `^1.9.0`       |

> **Note on `pino-http`**: the lib does **not** depend on `pino-http`. Consumers can use `pino-http` independently if they choose; this lib does not depend on it (see §17.5 for the rationale).
>
> **Note about `@opentelemetry/sdk-node` and `pino-roll`**: neither is a declared peer, and neither should become one. The lib imports neither — `sdk-node` is initialized by the consumer in its own `main.ts`, and `pino-roll` belongs to the `RollingFileDestination` **adapter example** in §5.7, which a consumer copies and owns. Declaring a peer the package never imports buys nothing (an optional peer documents a requirement, it does not resolve one) and costs: pnpm's `autoInstallPeers` defaults to true, so optional peers are materialized into the lockfile and generate Dependabot alerts for code this library never runs. (The setting is `autoInstallPeers` in `pnpm-workspace.yaml` — since pnpm 10 every non-auth setting lives there, not in `.npmrc`, and pnpm 11 ships a codemod that moves the stragglers.)
>
> The constraint that mattered survives without the declaration: SDK Node 0.218.x pins `@opentelemetry/api` at `>=1.3.0 <1.10.0`, which is why the `api` range above stays at `^1.9.0`. Track pre-1.0 releases — breaking changes may occur (currently `experimental/v0.218.0`).
>
> **Note about `@opentelemetry/api` version**: our peer dep declares `^1.9.0` (any 1.x ≥ 1.9.0). `@opentelemetry/sdk-node` 0.218.x caps `@opentelemetry/api` at `<1.10` — consumers pinning a newer `api` will break OTel SDK init. **Keep `^1.9.0` until SDK Node 1.0 ships.** The lib itself only consumes the `trace` API namespace, which has been stable since 1.3+, so the lib does not introduce its own ceiling — the ceiling is dictated by the SDK.

### 15.3 `"dependencies": {}`

The lib has **no direct dependencies**. The entire ecosystem comes via peer deps. This ensures:

- The consumer controls the exact Pino version
- The supply chain surface is reduced to a minimum (`pino` + audited transitives)
- Compatibility with any `@nestjs/common` 11.x the consumer already has

### 15.4 devDependencies (expected in the repo)

```json
"devDependencies": {
  "@nestjs/common": "^11",
  "@nestjs/core": "^11",
  "@nestjs/platform-express": "^11",
  "@nestjs/testing": "^11",
  "@opentelemetry/api": "^1.9",
  "@opentelemetry/sdk-trace-base": "^1.x",
  "@opentelemetry/context-async-hooks": "^1.x",
  "@types/jest": "^30",
  "@types/node": "^24",
  "@types/supertest": "^7",
  "@typescript-eslint/eslint-plugin": "^8",
  "@typescript-eslint/parser": "^8",
  "eslint": "^9",
  "eslint-config-prettier": "^10",
  "eslint-plugin-prettier": "^5",
  "eslint-plugin-security": "^4",
  "jest": "^30",
  "pino": "^10",
  "pino-pretty": "^13",
  "prettier": "^3.8",
  "reflect-metadata": "^0.2",
  "supertest": "^7",
  "ts-jest": "^29",
  "tsup": "^8.5",
  "typescript": "^5.9"
}
```

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
- [ ] `@InjectLogger`, `@LogContext`, `@LogPerformance`
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

### 17.1 In the `Scope.REQUEST` support

The lib uses singleton (`Scope.DEFAULT`). Request-scoped context comes via `AsyncLocalStorage`, not via DI scope.

**Reason**: official NestJS documentation estimates up to **~5%** additional latency for `Scope.REQUEST` ("a properly designed application that leverages request-scoped providers should not slow down by more than ~5% latency-wise" — [docs](https://docs.nestjs.com/fundamentals/injection-scopes#scope-hierarchy)). In a log path that runs thousands of times per request, that overhead compounds. `AsyncLocalStorage` is zero-cost once initialized.

For "distinct context per class" (each service has its own logger context), the `@LogContext()` decorator solves the problem without requiring transient scope (see §9.2).

### 17.2 In the `Scope.TRANSIENT`

For a similar reason. The `@InjectLogger(context)` decorator solves the "distinct context per class" problem without requiring transient scope.

### 17.3 Synchronous logging not supported

Pino is async by design (writes via worker threads). Logs emitted in a `process.on('exit')` handler may be lost. For critical scenarios (immutable audit), use `process.on('beforeExit')` + `await sdk.flush()`.

### 17.4 Auto-detection of the OTel API

Detection via `require()` at runtime. Bundlers (esbuild, webpack) may omit the module if not statically detected. Solution: declare `@opentelemetry/api` as a peer dep even if optional — the bundler resolves it.

### 17.5 `pino-http` not embedded

The lib does **not** depend on `pino-http` — we wrote our own `HttpLoggingInterceptor` instead (NestJS-native, observes lifecycle hooks, integrates with the lib's URL normalization and `LogContextService`). `pino-http` is **not** a peer dependency.

If a consumer still prefers `pino-http` (`pinoHttp({ ... })`), they install it independently and register it as Express/Fastify middleware — no wiring from this lib is required. The two can coexist but will produce duplicate HTTP logs, so pick one.

### 17.6 In the censor internationalization

`redactCensor` is a global string. There is in the built-in mechanism for a different censor per path. Workaround: use a custom function as the censor (receives the value, returns the substitute).

### 17.7 Aggressive truncation of large entries

`maxEntrySizeBytes: 64KB` by default. An oversized VALUE is replaced by the marker object `{"_truncated":true,"_logKey":"LOGGER_ENTRY_TRUNCATED","_originalSize":<n>,"_preview":"<first chars>"}`. The replacement happens in a serializer, while the entry is still being built — so the surrounding fields survive, which replacing the finished line would not allow. See §5.2 for the implementation. The reserved key `LOGGER_ENTRY_TRUNCATED` is part of `RESERVED_LOG_KEYS` (§12.3). For legitimate cases with large payloads, raise the limit explicitly.

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

Stdout output (via `pino-pretty`):

```
[15:32:14.123] INFO (my-app-dev/12345): LOGGER_BOOTSTRAP_OK
    level: "debug"
    destinations: ["stdout-json", "pretty-dev"]
[15:32:14.456] INFO (my-app-dev/12345): HTTP_REQUEST_START
    requestId: "r_abc123"
    method: "POST"
    url: "/users"
    ip: "127.0.0.1"
[15:32:14.512] INFO (my-app-dev/12345): USER_CREATED
    requestId: "r_abc123"
    userId: "u_new"
    email: "[REDACTED]"
    plan: "free"
[15:32:14.523] INFO (my-app-dev/12345): HTTP_REQUEST_SUCCESS
    requestId: "r_abc123"
    statusCode: 201
    duration: 67
```

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

process.on('SIGTERM', () => {
  void sdk.shutdown().finally(() => process.exit(0))
})

import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
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
  "level": 30,
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
    private readonly logger: PinoLoggerService
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
      this.logger.log('USER_CREATED', 'user.create', userId, { plan: 'pro' })
      // ^ The API is compatible — in the need to change call sites
    }
  }
```

The structured API of `PinoLoggerService.info(logKey, msg, userId, metadata)` is 1:1 compatible with `LoggerService.log(logKey, msg, userId, metadata)` from the old code. The `log()` method also remains (NestJS interface).

**Step 2 — Replace the module**

```diff
- import { LoggerModule } from './_commons_/logger/logger.module'
+ import { BymaxLoggerModule } from '@bymax-one/nest-logger'

  @Module({
-   imports: [LoggerModule],
+   imports: [
+     BymaxLoggerModule.forRoot({
+       service: { name: 'fitness-backend', version: process.env.RELEASE_SHA ?? 'dev' },
+       level: process.env.LOG_LEVEL as LogLevel ?? 'info',
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

**Migration scope:** `LoggerService` call sites (near 1:1 replacement) + OTel SDK setup in `main.ts` + decision on Postgres vs Loki destination + test updates. Execution in a dedicated session by an AI agent.

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
| **Fast-redact**       | Pino's builtin library that compiles redact paths into a JS fn         |
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

| Pino numeric | Pino string | NestJS string                                     | OTel Severity | Typical use case                                |
| ------------ | ----------- | ------------------------------------------------- | ------------- | ----------------------------------------------- |
| 60           | `fatal`     | (`'error'` in Nest, but fatal logged as critical) | FATAL         | The process is about to exit                    |
| 50           | `error`     | `error`                                           | ERROR         | Failure that requires human attention           |
| 40           | `warn`      | `warn`                                            | WARN          | Recoverable anomaly                             |
| 30           | `info`      | `log`                                             | INFO          | Significant business events                     |
| 20           | `debug`     | `debug`                                           | DEBUG         | Implementation detail useful in troubleshooting |
| 10           | `trace`     | `verbose`                                         | TRACE         | Ultra-granular detail (rarely in prod)          |

**Mapping in `PinoLoggerService`:**

- `log()` (NestJS) → `pino.info()`
- `verbose()` (NestJS) → `pino.trace()`
- `debug()` (NestJS) → `pino.debug()`
- `warn()` (NestJS) → `pino.warn()`
- `error()` (NestJS) → `pino.error()`
- `fatal()` (optional NestJS 11+) → `pino.fatal()`

The structured API (`info()`, `warnStructured()`, `errorStructured()`) maps 1:1 to Pino.

---

> **Next steps (after this spec):**
>
> 1. Generate `development_plan.md` (Layer 2) with detailed phases
> 2. Generate `development_tasks.md` (Layer 3) with AI-executable tasks
> 3. Bootstrap the code following the plan
> 4. Release `v0.1.0` on npm
