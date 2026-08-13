# @bymax-one/nest-logger — Agent Specification

> **Prerequisite:** Read [CLAUDE.md](./CLAUDE.md) first for critical rules. This file extends it with architecture and patterns — load on demand, not every session.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Backend Patterns](#3-backend-patterns)
4. [Security Specification](#4-security-specification)
5. [Testing Strategy](#5-testing-strategy)
6. [Build and Publish](#6-build-and-publish)
7. [Common Pitfalls](#7-common-pitfalls)
8. [Pre-Task Checklist](#8-pre-task-checklist)
9. [Guidelines Reference](#9-guidelines-reference)

---

## 1. Project Overview

`@bymax-one/nest-logger` is a **public npm library** — not an application. It provides structured JSON logging for the Bymax SaaS ecosystem and any NestJS 11 consumer.

**Features:** `PinoLoggerService` with NestJS `LoggerService` interface compatibility, structured API following `MODULE_ACTION_RESULT` convention, optional OpenTelemetry trace context injection, `AsyncLocalStorage` context propagation (`requestId`, `tenantId`, `userId`), HTTP logging interceptor + exception filter, `PrettyDevDestination` + `DefaultStdoutDestination`, pluggable destinations via `ILogDestination`, decorators `@InjectLogger` / `@LogContext` / `@LogPerformance`, PII redaction with `DEFAULT_REDACT_PATHS`.

**What it does NOT do:** No database connections, no network I/O, no opinion on log aggregation backend — consumers plug in their own destinations.

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
│   ├── destinations?: ILogDestination[]  (optional — defaults to stdout JSON)
│   └── level?, redactPaths?, http?, otel?, ...
```

### Initialization

1. `BymaxLoggerModule.forRootAsync()` → `ConfigurableModuleBuilder` resolves options
2. `validateOptions()` → `applyDefaults()` → `buildPinoInstance()` (with mixin for ALS + OTel)
3. `DestinationRegistry.onModuleInit()` → calls `onInit()` on all destinations
4. Bootstrap log: `LOGGER_BOOTSTRAP_OK` emitted

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

## 3. Backend Patterns

### Injection Tokens (4 Symbols)

| Token                        | Type                       | Required |
| ---------------------------- | -------------------------- | -------- |
| `LOGGER_OPTIONS_TOKEN`       | `BymaxLoggerModuleOptions` | Always   |
| `LOGGER_PINO_INSTANCE_TOKEN` | `pino.Logger`              | Always   |
| `LOGGER_DESTINATIONS_TOKEN`  | `ILogDestination[]`        | Always   |
| `LOG_CONTEXT_TOKEN`          | `LogContextService`        | Always   |

All tokens must be injected with explicit `@Inject(TOKEN)` — tsup drops decorator metadata.

### Structured Log Method Pattern

```typescript
// Convention: MODULE_ACTION_RESULT
logger.info('USER_PROFILE_FETCHED', 'Profile retrieved', userId, { plan: 'pro' })
logger.warnStructured('AUTH_RATE_LIMIT_APPROACHING', 'Near limit', userId, { attempts: 8 })
logger.errorStructured('PAYMENT_CHARGE_FAILED', error, userId, { amount: 99 })
```

### Destination Pattern

```typescript
class MyDestination implements ILogDestination {
  readonly name = 'my-destination'
  readonly minLevel: LogLevel = 'warn'

  async onInit(): Promise<void> {
    // open connection / allocate buffer
  }

  write(payload: string): void {
    // non-blocking; errors are caught by DestinationRegistry
  }

  async onShutdown(): Promise<void> {
    // flush pending writes, close connection
  }
}
```

### Error Handling — Never Crash the App

```typescript
// DestinationRegistry wraps every write():
try {
  await destination.write(payload)
} catch (err) {
  metaLogger.error(
    { logKey: LOGGER_ERROR_CODES.LOGGER_DESTINATION_WRITE_FAILED, err },
    'Destination write failed'
  )
}
```

---

## 4. Security Specification

### PII Redaction

| Category      | Fields (each redacted at depths 1-4 via `fast-redact` wildcard)             |
| ------------- | --------------------------------------------------------------------------- |
| Passwords     | `password`, `passwordHash`, `passwordConfirm`, `newPassword`, `oldPassword` |
| Tokens        | `token`, `accessToken`, `refreshToken`, `idToken`, `apiKey`, `apiSecret`    |
| MFA           | `mfaSecret`, `mfaRecoveryCodes`, `totpSecret`                               |
| Payment (PCI) | `cardNumber`, `cardCvv`, `cvv`, `cvc`, `cardExpiry`                         |
| BR documents  | `cpf`, `cnpj`, `rg`                                                         |
| PII           | `email`                                                                     |
| HTTP headers  | `authorization`, `cookie`, `x-api-key`, `x-auth-token`, `set-cookie`        |

`DEFAULT_REDACT_PATHS` contains 97 entries total. See `src/server/constants/default-redact-paths.constants.ts`.

### Trace ID Validation

`isValidTraceId(id)` enforces: 32 hex chars, non-zero (rejects `00000000000000000000000000000000`). Never inject trace context from user-controlled input without this check.

### Error Serialization

`sanitizeError(err)` strips sensitive fields from Error objects before logging. See `src/server/utils/sanitize-error.util.ts`.

### Log Text Escaping

`toSingleLineMessage(text)` runs on EVERY string that becomes Pino's message argument, and
`escapeControlCharacters(text)` runs on the scrubbed stack. Both live in
`src/server/utils/escape-log-text.util.ts`.

The threat is log forging in a re-rendering destination, not in NDJSON — JSON escaping already
keeps the record on one line. `pino-pretty`, which this library ships as `PrettyDevDestination`,
writes the parsed text straight to the terminal, so a raw `\n` **or** an ANSI sequence like
`ESC E` (next line) prints something indistinguishable from a genuine entry. Line terminators
become the literal `\n`; every other terminal-driving control character becomes `\xNN`.

Two rules when touching this:

- **Escape at the sink, never in the destination.** Sanitizing `PrettyDevDestination` would
  protect only the destination this library ships and leave every third-party `ILogDestination`
  that re-renders exposed.
- **The stack needs it too.** `pino-pretty` prints `err.stack` RAW rather than as a JSON string,
  and a stack's first line repeats the error message — escaping only `msg` leaves the identical
  attack working through `err.stack` and `exception.stacktrace`. Its newlines stay: a stack is
  legitimately multi-line, so only `msg` carries the one-line guarantee.

---

## 5. Testing Strategy

### Coverage Gate

**100% statements / branches / functions / lines — every layer, no exceptions.**
Enforced by `jest.config.ts` (`pnpm test:cov`) and `jest.coverage.config.ts`
(`pnpm test:cov:all`); both fail below 100%. A hard pre-publish gate, not a
target. Mutation testing (Stryker `break: 95`) is the deeper gate against weak tests.

### Mocking Strategy

| Dependency          | Approach                                                      |
| ------------------- | ------------------------------------------------------------- |
| Pino instance       | `jest.fn()` for all log methods                               |
| Destinations        | `jest.fn()` implementing `ILogDestination`                    |
| `process.stdout`    | Spy on `write` — never real I/O in unit tests                 |
| `AsyncLocalStorage` | Real ALS — it has no I/O; mock only when testing out-of-scope |
| OTel API            | Optional; spy on `detectOtelTraceApi()` return value          |

### Mutation Testing (Stryker)

Line coverage proves code _executes_; mutation testing proves the tests would _fail_ if the code regressed. Run `pnpm mutation` (Node 24) before tagging a release. Survivors are either real gaps (add a test) or equivalent mutants — document the latter in `docs/mutation_testing_results.md` (§Residual survivors), **not** with inline `// Stryker disable` comments, which ship in the unminified `.mjs` bundle and push the server subpath past its size budget. See [docs/mutation_testing_plan.md](./docs/mutation_testing_plan.md).

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

`exports` declares `types` **per condition** — `import` -> `.d.ts`, `require` ->
`.d.cts`. A single shared `types` key makes CommonJS consumers resolve ESM
declarations, because `"type": "module"` marks plain `.d.ts` as ESM.

Subpaths also need a `typesVersions` entry: the `moduleResolution: node`
algorithm predates `exports` and ignores it, so without it a consumer on that
setting (the Nest CLI default when `module: commonjs` is set with no explicit
`moduleResolution`) cannot find the subpath's types. `pnpm check:exports` runs
the strict `attw` profile, which covers that mode — never weaken it with
`--profile` to silence a row.

---

## 7. Common Pitfalls

### Security

| Pitfall                                | Fix                                                                |
| -------------------------------------- | ------------------------------------------------------------------ |
| Consumer disables default redact paths | Warn in JSDoc; require explicit `shouldDisableDefaultRedact: true` |
| Raw OTel trace ID from HTTP headers    | Always validate with `isValidTraceId`                              |
| Destination `write()` that throws      | Wrapped by `DestinationRegistry` — safe, logs meta-error           |
| Logging full Error objects             | Use `sanitizeError(err)` before passing to Pino                    |
| New sink that hands a string to Pino   | Route it through `toSingleLineMessage` — the escaping is per-sink  |

### Architecture

| Pitfall                                                 | Fix                                                  |
| ------------------------------------------------------- | ---------------------------------------------------- |
| Missing `@Inject(TOKEN)` on provider                    | Always explicit — tsup drops decorator metadata      |
| String injection tokens                                 | `Symbol()` only                                      |
| Direct `pino.info()` instead of service                 | Use `PinoLoggerService` — ensures ALS + OTel context |
| Cross-subpath import (server → shared OK; reverse → no) | Only `shared` can be imported by `server`            |

### TypeScript

| Pitfall                           | Fix                                   |
| --------------------------------- | ------------------------------------- |
| Using `any` outside LoggerService | `unknown`, generics, explicit types   |
| Missing `export type`             | Separate `export type` for interfaces |
| Barrel re-exporting internals     | Export only public API                |

### Testing

| Pitfall                        | Fix                                           |
| ------------------------------ | --------------------------------------------- |
| Real Pino I/O in unit tests    | Mock Pino instance via `jest.fn()`            |
| Testing implementation details | Test behavior and output shape, not internals |
| Shared mutable state           | Fresh mocks in `beforeEach`                   |

---

## 8. Pre-Task Checklist

**Before starting:**

- [ ] Read CLAUDE.md critical rules
- [ ] Identify 1-2 relevant guidelines → load only those
- [ ] Check `docs/development_tasks.md` for dependencies and status

**Before finishing:**

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all pass
- [ ] Barrel export (`src/server/index.ts`) updated if new public API added
- [ ] JSDoc on new public exports
- [ ] All text in English
- [ ] `@Inject(TOKEN)` explicit on every new provider

---

## 9. Guidelines Reference

> Load **only** the 1-2 files relevant to your task. Never preload all.

| Domain        | File                                                        | Load when...                         |
| ------------- | ----------------------------------------------------------- | ------------------------------------ |
| Pino          | `docs/guidelines/PINO-REDACTION-GUIDELINES.md`              | Modifying redact paths, Pino config  |
| OpenTelemetry | `docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md`            | OTel mixin, trace context, detection |
| Destinations  | `docs/guidelines/DESTINATIONS-IMPLEMENTATION-GUIDELINES.md` | Writing or reviewing destinations    |
