---
applyTo: 'src/**/*.ts'
---

# TypeScript source code standards

## TypeScript compiler flags — practical implications

`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`. Review impact:

- **`noUncheckedIndexedAccess`**: `array[0]` is `T | undefined`. Every index access must be guarded. Flag unguarded accesses.
- **`exactOptionalPropertyTypes`**: `{ prop?: string }` ≠ `{ prop: string | undefined }`. Flag conflation.
- **`noImplicitOverride`**: NestJS lifecycle hooks that override a parent must have `override`. Flag missing keyword.
- **`noImplicitReturns`**: every code path must return. Flag conditional fall-through.

## ESLint rules enforced as errors

- `no-explicit-any: error` — no `any` in source. Documented exception: NestJS `LoggerService` signatures only.
- `no-non-null-assertion: error` — never `!`. Narrow the type instead.
- `consistent-type-imports: error` — type-only imports must use `import type { ... }`.
- `explicit-function-return-type: error` — explicit return type on all functions.
- `explicit-module-boundary-types: error` — explicit types on all exported parameters.
- `import/no-cycle: error` — circular imports are forbidden.

## Types and interfaces

- **`interface`** for DI ports/contracts that classes `implement` (`ILogDestination`, `ILogContext`). `I` prefix is reserved for these only.
- **`type`** for unions, intersections, mapped types, aliases (`LogLevel`, `LogEntry`).

## NestJS patterns

- DI only — no `new ServiceClass()` outside tests.
- **Injection tokens must use `Symbol()`**, never string literals (string tokens cause silent collisions in multi-module apps). Example: `export const LOG_DESTINATION_TOKEN = Symbol('LOG_DESTINATION_TOKEN')`.
- Dynamic module requires both `forRoot(options)` and `forRootAsync({ useFactory, useClass, useExisting })`.
- `AsyncLocalStorage` for per-request context — never attach request state to class instances.
- Core logic depends only on `ILogDestination` interface — never imports concrete destination classes.
- `OnModuleDestroy` required wherever a Pino stream or file handle needs teardown.
- Unconfigured optional features (OTel, pretty transport) must not be registered in DI.

## Import ordering

`node:*` → external → internal (`@bymax-one/nest-logger`) → parent/sibling → index. Alphabetical within each group (enforced by `import/order`).

## Pino 10 patterns

- Async transport via worker threads. Sync `pino()` is only acceptable in `PrettyDevDestination` for local dev.
- Child loggers for per-request context (`logger.child({ requestId, tenantId })`) — never mutate root logger.
- PII redaction via `pino.redact` paths — never strip inline in business logic.
- No `pino` import at module scope in `src/shared/` — `shared` must not pull in `pino` as a transitive dep.

## Security and PII in internal logs

- Never log raw tokens, secrets, passwords, or API keys in internal meta-logs (destination errors, OTel init failures). The library's own logs must be manually disciplined — `pino.redact` only protects consumer log entries.
- Any secret, token, or hash comparison must use `node:crypto` `timingSafeEqual` — never `===`.
