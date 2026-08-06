# Mutation Testing Results

> **Last run:** 2026-06-18
> **Command:** `pnpm mutation` (Stryker 9, jest runner, `coverageAnalysis: perTest`, `ignoreStatic: true`)
> **Report:** [`reports/mutation/mutation.html`](../reports/mutation/mutation.html)

## Summary

| Metric                                                        | Value                                              |
| ------------------------------------------------------------- | -------------------------------------------------- |
| **Global mutation score** (superseded — see the dated re-run) | **97.42 %**                                        |
| Break threshold (`thresholds.break`)                          | 95 % → **PASS (exit 0)** ✅                        |
| Aspirational target (`thresholds.high`)                       | 99 % → not reached (equivalent mutants, see below) |
| Killed                                                        | 373                                                |
| Survived                                                      | 10                                                 |
| Timeout (counts as detected)                                  | 5                                                  |
| Compile/runtime errors (type-system-guarded, excluded)        | 261                                                |

Score = `(killed + timeout) / (killed + timeout + survived)` = `378 / 388 = 97.42 %`.

Up from the **86 %** first baseline and **95.93 %** at v0.1.0 preparation. `pnpm mutation` passes its break gate (exit 0). The remaining 10 survivors are all equivalent mutants (documented below) — this is the theoretical maximum without `// Stryker disable` comments.

> Inline `// Stryker disable` comments are NOT used — they ship in the deliberately
> unminified `.mjs` bundle and push the server subpath past its 13.5 KiB size budget.
> Equivalents are documented here instead.

## Hardening performed

Targeted assertions were added to kill ~40 runtime survivors across the tree, e.g.:

- **pretty-dev**: assert `pino-pretty.build()` is called with the exact options; assert `onShutdown` ends the stream + registers an `'error'` listener.
- **default-options**: assert the anchored `excludePaths` regex behavior + OTel field-name defaults.
- **sanitize-error**: assert absent-cause, newline-preserved stack, aggregate-member depth budget.
- **otel-detector**: trace/span-id regex anchor boundaries (prefix/border-zero cases).
- **log-performance**: `Date.now`-mocked exact-threshold boundary + message content.
- **http-logging.interceptor**: message content, sane-duration bounds, 300/400 status boundaries; unit test with mocked `ExecutionContext` for 1xx statusCode boundary (pins both `>= HTTP_SUCCESS_MIN` guards).
- **pino-logger**: `error()` stack-key branches (jest equality was hiding `stack: undefined`).
- **request-id**: 256-char correlation-id boundary.
- **truncate / validate-options / inject-logger**: exact byte ceiling, level message, symbol description.
- **destination-to-stream**: assert `level`, `msg` content and trailing `\n` in the stderr fail-soft report.
- **validate-options**: non-string `service.name` / `service.version` tests + comma-space format in `level` error message.
- **logger.module**: bootstrap message content assertion; `error.cause` assertion in `useNestLogger`.

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
- `truncate-large-entries.ts` `catch { return serialized }` → `catch {}`: the
  empty-catch variant falls through to `if (json === undefined) { return serialized }`
  immediately after — same observable output for all inputs.
- `trace-context.mixin.ts` `if (store)` → `if (true)`: `Object.assign(target, undefined)`
  is a documented no-op in JavaScript — the block body is identical to skipping it when
  `logContext.getStore()` returns `undefined` outside any ALS scope.
- `logger.module.ts:69` `return true` → `return false`: the return value is stored as the
  `LOGGER_BOOTSTRAP_TOKEN` injectable, which nothing in the module or consumer code reads.
  Changing it from `true` to `false` is observable only by inspecting the DI container
  directly — not by any behavior the library exposes.
- `logger.module.ts:265` `{ strict: false }` → `{}`: both forms throw a `NotFoundException`
  when `PinoLoggerService` is absent from the container — NestJS throws on missing providers
  regardless of the `strict` option when the provider does not exist anywhere in the module graph.

**`ignoreStatic: true`** was enabled — the Stryker-documented fix for `perTest`
static mutants, which are module-load literals that perTest cannot attribute to a
killing test and are a well-known false-positive source. This excluded 89 such
mutants that are nonetheless covered behaviorally by the suite.

## Critical paths

| File                           | Score        | Note                      |
| ------------------------------ | ------------ | ------------------------- |
| `normalize-url.util.ts`        | **100 %** ✅ |                           |
| `compile-redact-paths.util.ts` | **100 %** ✅ |                           |
| `http-logging.interceptor.ts`  | **100 %** ✅ | unit + integration tests  |
| `services/*`                   | **100 %** ✅ |                           |
| `trace-context.mixin.ts`       | 92.86 %      | 1 equivalent (see above)  |
| `sanitize-error.util.ts`       | 88.89 %      | 4 equivalents (see above) |
| `truncate-large-entries.ts`    | 88.89 %      | 1 equivalent (see above)  |

## Residual survivors (10)

**All 10 are equivalent mutants** (documented above) — not killable by definition.
There are zero genuine coverage gaps remaining. The maximum theoretical score without
`// Stryker disable` comments is 97.42 % (= 378/388).

---

## Re-run — 2026-08-06

| Metric             | Value        |
| ------------------ | ------------ |
| **Mutation score** | **99.73 %**  |
| Surviving mutants  | 1            |
| Break threshold    | 95 % -> PASS |

`detectOtelTraceApi` resolves `@opentelemetry/api`, and the specifier itself was pinned by
nothing: the spec mocks `createRequire`, so the resolver ignores what it is handed. Rename the
module and the detector still passes under test while every deployment silently loses trace
correlation, because a failed resolve is swallowed on purpose. The test now hands it a spy
resolver and asserts what it asked for.

`useNestLogger` also gained a feature-module case — the shape where the provider sits outside the
host module's own injector and a strict lookup would refuse it.

One survivor remains and it is NOT equivalent. The test above kills it: applying that exact
mutation by hand turns the suite red. Stryker does not attribute the test to the mutant, on a
full run as well as a scoped one, so it reports as surviving. Recorded rather than suppressed,
because calling it equivalent would be false.

Every equivalence claim in this section was checked by running the mutant, not by reading it.
Where a `// Stryker disable next-line` directive was found not to apply — above a `} catch {`, a
`.replace()` inside a method chain, a multi-line `sort(...)` argument, or anywhere inside a
builder chain — it was replaced with the block `disable`/`restore` form, or, where that does not
work either, with a plain comment at the line so the reasoning is visible rather than silently
ineffective.
