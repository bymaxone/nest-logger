# Changelog

All notable changes to `@bymax-one/nest-logger` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `release.yml` workflow extracts the section matching the pushed `vX.Y.Z` tag
as the GitHub Release body, so each released version needs a matching `## [X.Y.Z]`
heading here.

## [Unreleased]

## [0.1.0] - 2026-05-30

### Added

- `PinoLoggerService` — NestJS `LoggerService` interface compatibility plus
  structured API following the `MODULE_ACTION_RESULT` convention
  (`info`, `warnStructured`, `errorStructured`)
- Optional OpenTelemetry trace context injection (`traceId`, `spanId`,
  `traceFlags`) via Pino `mixin` with `camelCase` / `snake_case` field format
  shortcut
- `AsyncLocalStorage` context propagation — `requestId`, `tenantId`, `userId`
  automatically included in every log entry within a request scope
- HTTP logging interceptor (`HttpLoggingInterceptor`) + global exception filter
  (`HttpExceptionFilter`) + `RequestIdMiddleware` with `x-request-id` header
  support
- `PrettyDevDestination` — colorized human-readable output for development,
  auto-disabled in production
- `DefaultStdoutDestination` — JSON output to `process.stdout`
- `DestinationRegistry` — lifecycle-aware fan-out to multiple pluggable
  destinations via `ILogDestination`; destinations that throw never crash the app
- Decorators: `@InjectLogger(context?)`, `@LogContext`, `@LogPerformance`
- `BymaxLoggerModule.useNestLogger(app)` convenience helper
- `forRootAsync` support via `ConfigurableModuleBuilder` (standard NestJS
  async dynamic module pattern)
- PII redaction: 97-path default set covering passwords, tokens, MFA,
  payment card data, Brazilian documents (CPF/CNPJ/RG), and HTTP headers;
  consumer-extensible via `redactPaths`
- Size-bounded entry truncation at `maxEntrySizeBytes` (default 64 KiB) with
  `LOGGER_ENTRY_TRUNCATED` meta-log
- `sanitizeError` utility for safe Error serialization before logging
- E2E test suite (`test/e2e/`) exercising the full NestJS module lifecycle
- Throughput/allocation benchmark (`pnpm bench`) with CI budget gate
- Mutation-testing baseline (Stryker, `break: 95`) and
  `docs/mutation_testing_results.md`
- Professional CI suite: `ci.yml`, `bench.yml`, `codeql.yml`, `scorecard.yml`,
  `release.yml`, Dependabot, and issue templates

[Unreleased]: https://github.com/bymaxone/nest-logger/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bymaxone/nest-logger/releases/tag/v0.1.0
