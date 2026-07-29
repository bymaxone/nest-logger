# Changelog

All notable changes to `@bymax-one/nest-logger` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `release.yml` workflow extracts the section matching the pushed `vX.Y.Z` tag
as the GitHub Release body, so each released version needs a matching `## [X.Y.Z]`
heading here.

## [Unreleased]

## [1.0.1] - 2026-07-29

Supply-chain and tooling hardening only. `src/` is unchanged since 1.0.0, so the
published `dist/` is identical — no runtime behaviour changes for consumers.

### Security

- Force patched `brace-expansion` on every major line still present in the dev
  tree (`1.1.17`, `2.1.3`, `5.0.8`, via `pnpm.overrides`) to clear GHSA-mh99-v99m-4gvg
  (unbounded expansion length → out-of-memory crash). The 1.x and 2.x lines are
  kept on their maintenance releases because `minimatch` 3 and 9 consume
  `brace-expansion` as a default export, which the 5.x line no longer provides.
  Dev-only: the published package has zero runtime dependencies.
- Force `qs` to `^6.15.3` (via `pnpm.overrides`) to clear GHSA-q8mj-m7cp-5q26
  (`qs.stringify` DoS). `typed-rest-client`, pulled in by Stryker, pins `qs` at
  the affected `6.15.1` exactly, so no dependency refresh could resolve it
- Pin every third-party and GitHub-owned action to a full commit SHA, with the
  release tag kept as a trailing comment so Dependabot can still bump them. The
  org's own `bymaxone/.github` reusable workflows and composite action stay on
  the `@v1` moving tag by design, so shared-pipeline fixes keep propagating

### Changed

- Refresh dev dependencies (NestJS 11.1.28, typescript-eslint 8.65, prettier 3.9.6,
  lint-staged 17.2, tsx 4.23.1, ts-jest 29.4.12, tinybench 6.1.2, globals 17.8, and
  their transitive closure)

## [1.0.0] - 2026-06-18

### Security

- Pin `esbuild` to `^0.28.1` (via `pnpm.overrides`) to clear CVE alerts in the
  transitive dependency brought in by `tsup`

### Fixed

- Benchmark harness (`bench/throughput.bench.ts`) migrated to the tinybench v6 API:
  result access changed from the `result.hz` scalar to `result.throughput.mean`
  (Statistics object); `.run()` is now async

### Changed

- Mutation score improved from 95.93 % → **97.42 %** (theoretical maximum); all 7
  previously-unresolved `perTest` attribution survivors eliminated via targeted test
  assertions — see [`docs/mutation_testing_results.md`](docs/mutation_testing_results.md)
- Dev dependencies bumped: commitlint 21, lint-staged 17, `@types/node` 25,
  TypeScript 5.9, Jest 30, and the full dev-dependencies group

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

[Unreleased]: https://github.com/bymaxone/nest-logger/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/bymaxone/nest-logger/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bymaxone/nest-logger/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/bymaxone/nest-logger/releases/tag/v0.1.0
