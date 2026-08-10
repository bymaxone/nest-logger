# Changelog

All notable changes to `@bymax-one/nest-logger` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `release.yml` workflow extracts the section matching the pushed `vX.Y.Z` tag
as the GitHub Release body, so each released version needs a matching `## [X.Y.Z]`
heading here.

## [Unreleased]

## [1.0.8] - 2026-08-10

Remediation of a local audit's redaction, attribution and correlation-id findings. No API
changed; the fixes are in the default redact set, the acting-user resolution and the docs.

### Fixed

- **Root-level metadata is redacted.** The default redact set now lists each sensitive field at
  depth 0 as well as depths 1–4, so a value spread into a log record's own root — as
  `emitStructured` does with caller metadata — is scrubbed. The depth-1-and-deeper wildcards never
  reached the root, so a field named `password` passed as metadata was written in clear.
- **Acting-user attribution reads the JWT subject first.** The HTTP logging interceptor and the
  exception filter now resolve the acting user as `sub ?? id`, so a JWT principal (every
  `@bymax-one/nest-auth` token) is attributed to its subject rather than an ORM `id` when a
  principal carries both.

### Documentation

- The advertised default redact-path count is corrected from 113 to **140** (27 fields across
  depths 0–4, plus 5 absolute header paths) across the README and the technical specification.
- The correlation-id charset comment now describes what the middleware actually does — echo
  `x-request-id` and store `requestId` in the log context — instead of a non-existent
  error-envelope `correlationId` field.

## [1.0.7] - 2026-08-07

**Documentation and tooling.** `dist/` differs from `1.0.6` only in the text of the comments
described below; no runtime code changed.

### Changed

- **Equivalent mutants are documented in the source instead of only in the report, and the
  rule against that was retired on a measurement.** The plan forbade inline
  `// Stryker disable` comments on the ground that they would push the server subpath past
  its 13.5 kB brotli budget. Measured: seven directives took the bundle from **12.84 to
  12.94 kB** — **+0.10 kB** against 0.66 kB of headroom, because brotli compresses their
  repeated prefixes almost for free. The assumed cost was roughly ten times the real one, and
  no budget changed.

  With the ten survivors now carrying their reason inline, the measured score moves from
  **97.42%** to **100%** — no test and no production logic changed; Stryker excludes an
  ignored mutant from the denominator instead of counting it as one the suite failed to kill.

- **One suppression is recorded as what it is, not as an equivalent.** `otel-detector.ts:40`
  is killed by the suite — applying the mutation by hand turns the suite red — but Stryker
  fails to attribute the killing test to it under `perTest` coverage analysis. Its directive
  says exactly that. Calling it equivalent to reach a rounder number would have been false.

- Two reasons were corrected after review. `decodeStrings: false` claimed equivalence "for
  every input"; with `true`, Node encodes the string using the write's encoding and this
  stream decodes with `toString('utf-8')`, so a `write(chunk, 'latin1')` would change
  non-ASCII bytes. Nothing writes here but Pino, which emits UTF-8 NDJSON at the default
  encoding, and the reason now says so and names where it stops being true. The
  `{ strict: false }` reason argued from a missing provider; it now gives the actual
  mechanism — `NestApplicationContext.get` branches on `!(options && options.strict)`, so the
  mutant's `{}` leaves `strict` undefined, which is falsy, and takes the same non-strict
  lookup.

### Added

- `check:mutants` gate (`scripts/check-mutation-directives.mjs`) — validates every
  `// Stryker` comment against the parser's own regular expression, rejecting a reason written
  after `--` instead of a colon, a reason wrapped onto a second comment line, a stray comma in
  the mutator list, and a mutator name Stryker does not know, which matches nothing and so
  silences nothing. Wired into CI and `prepublishOnly`.

### Fixed

- The `[Unreleased]` compare link still pointed at `v1.0.5` after `1.0.6` shipped.

## [1.0.6] - 2026-08-06

**Tests and documentation only.** `dist/` is byte-identical to `1.0.5`.

An earlier revision of this branch added inline `// Stryker disable` comments and reported a
99.73% score off the back of them. That is against this package's own plan, which forbids them
because they ship in the unminified bundle and eat the server subpath's brotli budget. They are
gone; the score is the measured 97.42% with the equivalents documented instead.

### Tests

- `detectOtelTraceApi` resolves `@opentelemetry/api`, and the specifier was pinned by nothing —
  the spec mocks `createRequire`, so the resolver ignored what it was handed. Renaming the module
  would have kept the suite green while every deployment silently lost trace correlation, because
  a failed resolve is swallowed by design.
- `useNestLogger` gained a feature-module case, the shape where the provider sits outside the host
  module's own injector.

## [1.0.5] - 2026-07-30

### Security

- **Peer floors raised to exclude known-vulnerable NestJS versions.** `@nestjs/common ^11.0.0`
  admitted 11.0.0–11.0.15, carrying [GHSA-cj7v-w2c7-cp7c](https://github.com/advisories/GHSA-cj7v-w2c7-cp7c)
  (remote code execution via the `Content-Type` header, patched in 11.0.16), and
  `@nestjs/core ^11.0.0` admitted everything up to 11.1.17, carrying
  [GHSA-36xv-jgw5-4q75](https://github.com/advisories/GHSA-36xv-jgw5-4q75) (patched in 11.1.18).

  A peer range states which versions this library supports. A floor below a published
  advisory told a consumer a vulnerable install was supported, and nothing in their
  tooling contradicted it — the install resolved cleanly and silently. Floors are now
  `^11.0.16` and `^11.1.18`.

  Shipped as a patch, which is where a security fix belongs; a minor would reach the
  same installs anyway, since `^1.0.4` accepts `1.1.0` as readily as `1.0.5`. No
  runtime behaviour changed.

### Fixed

- **The custom-destination examples did not compile against `ILogDestination`.**
  The published interface takes a serialized line:

  ```ts
  write(payload: string): void | Promise<void>   // newline-terminated JSON, UTF-8
  ```

  All three examples in the README — `LokiDestination`, `PrismaLogDestination`,
  `RollingFileDestination` — and the API reference table declared
  `write(entry: LogEntry): void`, so anyone following the README to build a
  destination got:

  ```
  TS2416: Property 'write' in type 'LokiDestination' is not assignable to the
          same property in base type 'ILogDestination'.
  ```

  `ILogDestination` is this library's extension point, so the documentation was
  teaching the wrong shape for the one thing consumers are meant to implement.
  `RollingFileDestination` compounded it by re-serializing a payload that already
  **is** newline-terminated JSON — anyone casting past the type error would have
  written double-encoded lines to disk.

  Each example now does what its own job requires rather than all three doing the
  same thing: Loki buffers the line verbatim, Prisma parses because it stores
  individual columns, rolling-file writes it through untouched.

- **The request-id middleware typed `req` as the global DOM `Request`**, whose
  `headers` is a `Headers` instance and cannot be indexed (`TS7052`). `1.0.4`
  introduced `LoggableRequest` and `LoggableResponse` for exactly this and exports
  them; the README never adopted them. It does now, and narrows the
  `string | string[]` a repeated header produces.

### Added

- **`pnpm check:published`** — verifies that the README's links resolve, that its
  TypeScript snippets and the type tests compile against the built package, and
  that every `v*.*.*` tag has a `## [x.y.z]` CHANGELOG section. It resolves the
  package through its `exports` map into `dist/`, which `test:types` cannot do:
  that one maps the package to `./src` through tsconfig `paths` and so never
  compiles what the README claims. Both defects above were found by it.

  Runs in CI, in `release.yml`, and inside `prepublishOnly`.

## [1.0.4] - 2026-07-29

### Fixed

- **The published declarations no longer depend on Express's types.** The HTTP
  logging interceptor, the exception filter and the request-id middleware typed
  their signatures with `Request` / `Response` / `NextFunction` from `express`,
  so `dist/server/index.d.ts` imported from `express` and a consumer compiling
  with `skipLibCheck: false` and no express types installed hit
  `error TS2307: Cannot find module 'express'`. Present since 1.0.0; the imports
  were `import type` only, so runtime was never affected and no express code was
  ever bundled.

  They are now typed by structural contracts declaring exactly the members this
  package reads — `LoggableRequest` (`headers`, `method`, `url`, `ip`,
  `user?.id`), `LoggableResponse` (`statusCode`, `setHeader`, `status().json()`)
  and `NextHandler`. The emitted declarations import only `@nestjs/common`,
  `pino` and `rxjs`, all declared peers.

  **Not a breaking change:** an Express request and response satisfy the
  contracts structurally, so existing call sites keep compiling with no cast —
  the parameter types only widen what is accepted. The internal
  `RequestWithUser` alias is gone, replaced by `LoggableRequest`; it was never
  exported.

### Added

- `LoggableRequest`, `LoggableResponse`, `NextHandler` and `IncomingHeaders` are
  exported from the package root: they type `RequestIdMiddleware.use()`, so a
  consumer invoking it directly (in a test, say) can name them.

### Removed

- The `@types/express` optional peer dependency added in 1.0.3. With the
  declarations self-contained it serves no purpose — nothing in the published
  types names an express symbol. It stays a devDependency: the specs build
  express-shaped mocks deliberately, to prove a real express request and
  response still satisfy the contracts.

## [1.0.3] - 2026-07-29

### Fixed

- **Declared `@types/express` as an optional peer dependency.** The published
  declarations reference `Request` / `Response` / `NextFunction` from `express`
  (the HTTP interceptor, the exception filter and the request-id middleware all
  type their signatures with them), but the requirement was undeclared. A
  consumer compiling with `skipLibCheck: false` and no express types installed
  hit `error TS2307: Cannot find module 'express'` from inside
  `dist/server/index.d.ts` with nothing in `package.json` pointing at the cause.
  Present since 1.0.0 — the imports are `import type` only, so runtime was never
  affected and no express code is bundled.

  It is marked optional because nothing in the library needs express at runtime:
  a consumer on a non-express adapter (Fastify) can ignore it, as can anyone
  keeping `skipLibCheck: true` — the default the Nest CLI scaffolds.

## [1.0.2] - 2026-07-29

### Fixed

- **CommonJS consumers no longer receive ESM type declarations.** Both subpaths
  now declare `types` per condition, so `require()` resolves to the `.d.cts`
  declarations that match the `.cjs` runtime. Previously a single `types` entry
  pointed at the `.d.ts` files, which — with `"type": "module"` — TypeScript
  reads as ESM, so a project on `moduleResolution: node16` / `nodenext`
  importing from CommonJS got declarations for the wrong module format.
- Added top-level `main`, `module` and `types` so the root entrypoint also
  resolves under the legacy `moduleResolution: node` algorithm. The `./shared`
  subpath remains unresolvable in that mode, which is inherent to subpath
  exports and not fixable without a directory shim.
- Exposed `./package.json` through the `exports` map. Reading it previously
  failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that
  inspects an installed package's manifest.
- **The `./shared` subpath now resolves under `moduleResolution: node`.** A
  `typesVersions` map points the subpath at its `.d.cts` declarations, which is
  the only mechanism that resolution algorithm understands — it predates
  `exports` and ignores it entirely. Without this, a consumer whose tsconfig
  sets `module: commonjs` without an explicit `moduleResolution` (the default
  the Nest CLI scaffolds, which falls back to `node`) got
  `error TS2307: Cannot find module '@bymax-one/nest-logger/shared'` while the
  root entrypoint resolved fine. Runtime was never affected: Node reads
  `exports`, so `require('@bymax-one/nest-logger/shared')` always worked.

### Added

- `pnpm check:exports` (`@arethetypeswrong/cli`) — packs the tarball and
  resolves every entrypoint the way each module resolution mode would, in the
  strict profile — every entrypoint in every resolution mode. Wired into CI and
  into the release workflow ahead of the publish step.

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

[Unreleased]: https://github.com/bymaxone/nest-logger/compare/v1.0.7...HEAD
[1.0.7]: https://github.com/bymaxone/nest-logger/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/bymaxone/nest-logger/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/bymaxone/nest-logger/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/bymaxone/nest-logger/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/bymaxone/nest-logger/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/bymaxone/nest-logger/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/bymaxone/nest-logger/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bymaxone/nest-logger/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/bymaxone/nest-logger/releases/tag/v0.1.0
