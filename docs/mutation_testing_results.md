# Mutation Testing Results

> **Last run:** 2026-05-29
> **Command:** `pnpm mutation` (Stryker 9, jest runner, `coverageAnalysis: perTest`, `ignoreStatic: true`)
> **Report:** [`reports/mutation/mutation.html`](../reports/mutation/mutation.html)

## Summary

| Metric                                                 | Value                                              |
| ------------------------------------------------------ | -------------------------------------------------- |
| **Global mutation score**                              | **95.93 %**                                        |
| Break threshold (`thresholds.break`)                   | 95 % → **PASS (exit 0)** ✅                        |
| Aspirational target (`thresholds.high`)                | 99 % → not reached (residual artifacts, see below) |
| Killed                                                 | 357                                                |
| Survived                                               | 15                                                 |
| Timeout (counts as detected)                           | 2                                                  |
| Compile/runtime errors (type-system-guarded, excluded) | 251                                                |

Score = `(killed + timeout) / (killed + timeout + survived)` = `359 / 374 = 95.93 %`.

Up from the **86 %** first baseline. `pnpm mutation` passes its break gate (exit 0).

> An intermediate run reached **97.5 %** using inline `// Stryker disable` comments
> for the equivalent mutants. Those comments are NOT stripped from the published,
> deliberately-unminified `.mjs` bundle and pushed it past the 12 KiB size budget,
> so they were removed (the equivalents are documented in this file instead) — the
> 6 equivalent mutants now count as "Survived", giving 95.93 %. Both numbers pass
> the 95 % break gate.

## Hardening performed

Targeted assertions were added to kill ~30 runtime survivors across the tree
(both Phase 1–3 and Phase 4 code), e.g.:

- **pretty-dev**: assert `pino-pretty.build()` is called with the exact options; assert `onShutdown` ends the stream + registers an `'error'` listener.
- **default-options**: assert the anchored `excludePaths` regex behavior + OTel field-name defaults.
- **sanitize-error**: assert absent-cause, newline-preserved stack, aggregate-member depth budget.
- **otel-detector**: trace/span-id regex anchor boundaries (prefix/border-zero cases).
- **log-performance**: `Date.now`-mocked exact-threshold boundary + message content.
- **http-logging.interceptor**: message content, sane-duration bounds, 300/400 status boundaries.
- **pino-logger**: `error()` stack-key branches (jest equality was hiding `stack: undefined`).
- **request-id**: 256-char correlation-id boundary.
- **truncate / validate-options / inject-logger**: exact byte ceiling, level message, symbol description.

**Equivalent mutants** (documented here rather than with inline `// Stryker
disable`, which would ship in the unminified bundle — see the size note above):

- `destination-to-stream.ts` `decodeStrings: false` → `true`: the `true` variant
  re-encodes the string to a Buffer that `write()` decodes back to the identical
  string; output is indistinguishable (only the internal branch differs).
- `otel-detector.ts` `createRequire(join(cwd, 'noop.cjs'))` → `''`: the anchor
  filename is arbitrary; resolution happens from the same cwd either way.
- `sanitize-error.ts` `isObject` `ConditionalExpression`/`LogicalOperator` (×4):
  the guard only gates `seen.has(value)` (a `WeakSet`), which is always `false`
  for primitives, so mutating it cannot change the output for any input.

**`ignoreStatic: true`** was enabled — the Stryker-documented fix for `perTest`
static mutants, which are module-load literals that perTest cannot attribute to a
killing test and are a well-known false-positive source. This excluded 89 such
mutants that are nonetheless covered behaviorally by the suite.

## Critical paths

| File                           | Score        | Note                                  |
| ------------------------------ | ------------ | ------------------------------------- |
| `normalize-url.util.ts`        | **100 %** ✅ |                                       |
| `compile-redact-paths.util.ts` | **100 %** ✅ |                                       |
| `validate-options.ts`          | 89.66 %      | residual perTest artifact (see below) |
| `trace-context.mixin.ts`       | 92.86 %      | residual perTest artifact (see below) |

## Residual survivors (15)

**6 are equivalent mutants** (listed above) — not killable by definition.

**9 are Stryker artifacts**, not genuine coverage gaps — the affected code is
exercised by explicit tests (302 unit+e2e tests, 100 % line/branch coverage):

- **2 × `http-logging.interceptor` (`ConditionalExpression`)** — the success/redirect
  range `if`s. The killing tests exist (418, 300, 400 boundary tests), but the
  supertest-driven HTTP suite is flaky under Stryker's instrumented runtime (the
  "socket hang up" seen on the initial run), so the kills aren't reliably attributed.
- **3 × `validate-options` + 1 × `trace-context.mixin` + 3 × `logger.module`** — a
  `perTest` coverage-attribution artifact: the test fixtures (e.g.
  `request-id.middleware.spec`, `logger.module.async.spec`) run `forRoot` (→
  `validateOptions`, → the mixin) at module-LOAD with valid options, so Stryker
  attributes only the load-time coverage and does not run the runtime tests
  (e.g. the empty-name / store-present tests) that would kill them.

**Path to 99 % / critical-paths-100 %** (follow-up): refactor the unit test
fixtures so no `@Module` runs `forRoot` at file-load (move it into `beforeAll`),
and/or unit-test the interceptor with a mocked `ExecutionContext` instead of
supertest so the kills run outside Stryker's flaky HTTP path. Tracked as a
follow-up — the enforced gate (break 95) already passes.
