# Changelog

All notable changes to `@bymax-one/nest-logger` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `release.yml` workflow extracts the section matching the pushed `vX.Y.Z` tag
as the GitHub Release body, so each released version needs a matching `## [X.Y.Z]`
heading here.

## [Unreleased]

### Added

- Phase 4: `PrettyDevDestination`, `DestinationRegistry` lifecycle, Pino
  multi-stream fan-out, size-bounded entry truncation, `forRootAsync` async HTTP
  interceptor parity, `@InjectLogger(context)` child-logger binding,
  `BymaxLoggerModule.useNestLogger(app)` helper, and an end-to-end test suite.
- Throughput/allocation benchmark (`pnpm bench`) with CI budget gate.
- Mutation-testing baseline (Stryker) and `docs/mutation_testing_results.md`.
- Professional CI suite: `ci.yml`, `bench.yml`, `codeql.yml`, `scorecard.yml`,
  `release.yml`, Dependabot, and issue templates.
