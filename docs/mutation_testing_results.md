# Mutation Testing Results

> **Last run:** 2026-08-12 (`pnpm mutation:full` — cold, baseline deleted)
> **Command:** Stryker 9, jest runner, `coverageAnalysis: perTest`, `ignoreStatic: true`
> **Report:** [`reports/mutation/mutation.html`](../reports/mutation/mutation.html)

## Summary

| Metric                                                 | Value                       |
| ------------------------------------------------------ | --------------------------- |
| **Global mutation score**                              | **100.00 %**                |
| Break threshold (`thresholds.break`)                   | 95 % → **PASS (exit 0)** ✅ |
| Aspirational target (`thresholds.high`)                | 99 % → **reached**          |
| Killed                                                 | 448                         |
| Survived                                               | **0**                       |
| Timeout (counts as detected)                           | 5                           |
| Ignored via documented `// Stryker disable`            | 103                         |
| Compile/runtime errors (type-system-guarded, excluded) | 313                         |

Score = `(killed + timeout) / (killed + timeout + survived)` = `453 / 453 = 100.00 %`.

### 2026-08-12 — the P0 remediation, and what it cost before it paid

The audit-remediation release (`1.2.0`) initially DROPPED the score to **93.71 %** — 29
survivors concentrated in the new code. The cause is worth recording, because it is a
property of this repo's setup rather than of the change:

**Stryker runs the UNIT suite only** (`jest.stryker.config.ts` wraps `jest.config.ts`, not
`jest.e2e.config.ts`). Several of the new regression tests — the bootstrap warning, the
redaction strategies, the shutdown entry — were written as e2e specs, where they exercise the
real booted module but are invisible to mutation testing. Sixteen of the 29 survivors were
plain `NoCoverage`.

The fix was not to move those tests. An e2e test that boots the module is the right test for
"does the wired pipeline emit this" — so each gained a UNIT counterpart asserting the same
behaviour one layer down, and two pure helpers in `pino-factory.ts` (`resolveNameRedactor`,
`resolveRedactOption`) were exported `@internal` so their branches could be asserted directly.
That last one mattered for a reason the score alone does not show: the difference between
"`fast-redact` not configured" and "`fast-redact` configured with the full default expansion"
is a ~100× throughput difference that produces **identical log output**. No output-level
assertion can see it. Only a direct assertion on the resolved option can.

Three genuine equivalents were then removed rather than suppressed:

- Two came from an `Array.isArray` fast path in `isTraversable` that was **dead logic** — a
  plain array carries no `toJSON`, so it already answered `true` on the fall-through. Deleting
  the branch killed both mutants AND fixed a latent bug: the fast path would have traversed an
  exotic `class extends Array { toJSON() {…} }`, flattening away the method that decides its
  serialized form.
- One was an off-by-one in the TEST, not the source: the traversal-ceiling boundary case placed
  its leaf at `MAX − 1`, where `depth > MAX` and `depth >= MAX` behave identically. Moving it to
  exactly `MAX` — the only input that separates them — killed it.

The change added **no** new suppressions. Four were introduced during the remediation, on
`writable: true` / `configurable: true` property descriptors, and were then removed by the
code review of that change rather than accepted: the descriptors are written once and never
redefined, so the flags were unnecessary and the two `Reflect.defineProperty` calls now pass
`{ value, enumerable: true }` alone. Deleting a redundant literal beats documenting why no
test can kill it. The suppressions still in `src/` all predate this release.

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
| **Mutation score** | **97.42 %**  |
| Surviving mutants  | 10           |
| Break threshold    | 95 % -> PASS |

`detectOtelTraceApi` resolves `@opentelemetry/api`, and the specifier itself was pinned by
nothing: the spec mocks `createRequire`, so the resolver ignores what it is handed. Rename the
module and the detector still passes under test while every deployment silently loses trace
correlation, because a failed resolve is swallowed on purpose. The test now hands it a spy
resolver and asserts what it asked for.

`useNestLogger` also gained a feature-module case — the shape where the provider sits outside the
host module's own injector and a strict lookup would refuse it.

The score at that pass was 97.42 %, held there by a rule this package's plan used to carry: no
inline `// Stryker disable` comments, because they ship in the unminified bundle and eat the
server subpath's brotli budget. That rule was retired once the cost was measured rather than
assumed — see the re-run at the end of this file.

One of the ten is worth separating from the equivalents. `otel-detector.ts:40` is NOT equivalent
— the test added above kills it, and applying that exact mutation by hand turns the suite red.
Stryker does not attribute the test to the mutant, on a full run as well as a scoped one, so it
reports as surviving. Recorded as such rather than reclassified, because calling it equivalent
would be false.

Every equivalence claim in this section was checked by running the mutant, not by reading it.
Where a `// Stryker disable next-line` directive was found not to apply — above a `} catch {`, a
`.replace()` inside a method chain, a multi-line `sort(...)` argument, or anywhere inside a
builder chain — it was replaced with the block `disable`/`restore` form, or, where that does not
work either, with a plain comment at the line so the reasoning is visible rather than silently
ineffective.

---

## Re-run — 2026-08-07

| Metric                    | Value           |
| ------------------------- | --------------- |
| **Mutation score**        | **100.00 %**    |
| Killed                    | 370             |
| Timed out (counts killed) | 5               |
| Survived                  | 0               |
| Compile-error (excluded)  | 261             |
| Break threshold           | 95 % -> PASS    |
| High target               | 99 % -> reached |

No test changed and no production logic changed. The ten survivors argued above now carry
their reason on the line they apply to, so Stryker excludes them from the denominator rather
than counting them as mutants the suite failed to kill.

**The rule that forbade this was retired on a measurement.** It held that inline directives
would push the server subpath past its 13.5 kB brotli budget. Measured: the seven directives
took the bundle from **12.84 to 12.94 kB** — **+0.10 kB** against 0.66 kB of headroom, because
brotli compresses their repeated prefixes almost for free. The assumed cost was roughly ten
times the real one. No budget changed.

Two details are worth recording, because both were settled by running the mutants rather than
reasoning about them:

- **The `sanitize-error` directive was first placed on the wrong line.** It went above the
  call site, `if (isObject(value) && seen.has(value))`, while the four mutants live in the
  body of `isObject` itself. The run reported them still surviving, which is how the mistake
  surfaced; the directive now sits inside `isObject`. `next-line` binds to the following
  statement, so a directive above a _use_ of a function does not reach mutants in its
  _definition_.
- **`otel-detector.ts:40` is suppressed but is NOT equivalent, and its directive says so.**
  The suite kills that mutant — applying the mutation by hand turns the suite red — but
  Stryker fails to attribute the killing test to it under `perTest` coverage analysis, on a
  full run as well as a scoped one. It is ignored on that ground, named as a tool-attribution
  failure. Calling it equivalent to reach a rounder number would have been false.
