# Repository orientation

Moved out of `AGENTS.md` verbatim. Codex loads one `AGENTS.md` per directory from the
repository root down and truncates once their combined size passes
`project_doc_max_bytes`, so every byte in that file is charged against the reviewer's
budget on every turn before the diff is read. This file holds what orients a reader
rather than what decides a finding, and Codex does not follow links, so nothing here
is normative. Rules a reviewer applies stay in `AGENTS.md`.

---

## 1. Project Overview

`@bymax-one/nest-logger` is a **public npm library** — not an application. It provides structured JSON logging for the Bymax SaaS ecosystem and any NestJS 11 consumer.

**Features:** `PinoLoggerService` with NestJS `LoggerService` interface compatibility, structured API following `MODULE_ACTION_RESULT` convention, optional OpenTelemetry trace context injection, `AsyncLocalStorage` context propagation (`requestId`, `tenantId`, `userId`), HTTP logging interceptor + exception filter, `PrettyDevDestination` (configurable `view`) + `DefaultStdoutDestination`, pluggable destinations via `ILogDestination`, decorators `@InjectLogger` / `@LogContext` / `@LogPerformance`, PII redaction with `DEFAULT_REDACT_PATHS`.

**What it does NOT do:** No database connections, no network I/O, no opinion on log aggregation backend — consumers plug in their own destinations.

---

---

## 2. Architecture

### Dynamic Module — runs inside the host app

```
Host App (NestJS)
├── BymaxLoggerModule.forRootAsync({ ... })
│   ├── PinoLoggerService ←→ Pino instance ←→ DestinationRegistry
│   ├── LogContextService (AsyncLocalStorage)
│   ├── TraceContextMixin (optional OTel)
│   ├── HttpLoggingInterceptor + HttpExceptionFilter
│   ├── RequestIdMiddleware
│   └── Decorators (@InjectLogger, @LogContext, @LogPerformance)
│
├── Consumer provides (via forRootAsync options):
│   ├── service: { name, version }  (required)
│   ├── destinations?: ILogDestination[]  (optional — REPLACES the stdout JSON default)
│   └── level?, redactPaths?, http?, otel?, ...
```

### Initialization

1. `BymaxLoggerModule.forRootAsync()` → `ConfigurableModuleBuilder` resolves options
2. `validateOptions()` → `applyDefaults()` → `buildPinoInstance()` (with mixin for ALS + OTel)
3. `DestinationRegistry.onModuleInit()` → calls `onInit()` on all destinations; a rejection is recorded in `DestinationHealth` and reported to stderr, never through the logger
4. Bootstrap log: `LOGGER_BOOTSTRAP_OK` emitted — **after** step 3, so a total init failure has already elected its stdout fallback and these entries survive it

### Request Flow

```
Request
  → RequestIdMiddleware (x-request-id → ALS store)
  → HttpLoggingInterceptor (HTTP_REQUEST_START / HTTP_REQUEST_COMPLETED)
  → Controller
  → HttpExceptionFilter (HTTP_EXCEPTION_HANDLED / HTTP_EXCEPTION_UNHANDLED)
```

### Context Propagation

```
RequestIdMiddleware.use()
  → logContextService.run({ requestId, tenantId }, next)
    → [entire request scope inherits the ALS store]
      → logger.info() → Pino mixin reads ALS store → JSON includes requestId/tenantId
```

---

---

## 6. Build and Publish

tsup builds 2 entry points → `dist/{subpath}/index.{mjs,cjs,d.ts}`

```bash
pnpm clean        # rm -rf dist coverage
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint src
pnpm test:cov     # jest --coverage (100% gate)
pnpm build        # tsup
pnpm size         # check brotli budgets (server <12.5KB, shared <1KB)
pnpm check:exports # attw: resolve every entrypoint per module resolution mode
pnpm release      # pnpm publish --provenance
```

Post-build checks: both exports resolve, CJS + ESM work, `.d.ts` present, no bundled peer deps.

---

---

## 9. Guidelines Reference

> Load **only** the 1-2 files relevant to your task. Never preload all.

| Domain        | File                                                        | Load when...                         |
| ------------- | ----------------------------------------------------------- | ------------------------------------ |
| Pino          | `docs/guidelines/PINO-REDACTION-GUIDELINES.md`              | Modifying redact paths, Pino config  |
| OpenTelemetry | `docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md`            | OTel mixin, trace context, detection |
| Destinations  | `docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md` | Writing or reviewing destinations    |

---
