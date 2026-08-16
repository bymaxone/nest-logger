# Mutation Testing Results

> **Last run:** 2026-08-16 (`pnpm mutation:full` — cold, baseline deleted)
> **Command:** Stryker 9, jest runner, `coverageAnalysis: perTest`, `ignoreStatic: true`
> **Report:** [`reports/mutation/mutation.html`](../reports/mutation/mutation.html)

## Summary

| Metric                                                 | Value                       |
| ------------------------------------------------------ | --------------------------- |
| **Global mutation score**                              | **100.00 %**                |
| Break threshold (`thresholds.break`)                   | 95 % → **PASS (exit 0)** ✅ |
| Aspirational target (`thresholds.high`)                | 99 % → **reached**          |
| Killed                                                 | 838                         |
| Survived                                               | **0**                       |
| Timeout (counts as detected)                           | 11                          |
| Ignored — documented `// Stryker disable`              | 17                          |
| Ignored — static mutants (`ignoreStatic: true`)        | 128                         |
| Compile/runtime errors (type-system-guarded, excluded) | 515                         |

Score = `(killed + timeout) / (killed + timeout + survived)` = `849 / 849 = 100.00 %`.

Last measured on 2026-08-16 with `pnpm mutation:full` semantics under Node 24.18.0, after the
destination-name guards were added: the three files they touch report 49 / 19 / 9 killed with no
survivor and no uncovered mutant.

### 2026-08-15 — the descriptor flags nobody could kill, deleted rather than excused

The `__proto__` hardening (also `1.2.7`) replaced an assignment with
`Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })`,
and the cold run dropped to **99.75 %** with two survivors — `BooleanLiteral` on `writable` and
`configurable`. Neither is observable: the node is built once and handed on.

**The precedent for this exact shape already existed in this file** (2026-08-12, property descriptors
in the redaction work), and it says delete the redundant literal rather than document why no test can
kill it. What made applying it a decision rather than a reflex is the consequence: omitting `writable`
leaves the property read-only, and under the module's strict mode a later in-place write would
**throw** — inside the never-crash path.

So it was verified rather than assumed, on the built artifact and not only in the suite: a nested
`password` still comes out `[REDACTED]`, which means the redaction walk is copy-on-write and never
writes to the node. The descriptor is now `{ value, enumerable: true }`, back to 100.00 % with 0
survivors, and the comment states the invariant so a future change that needs an in-place write knows
it has to add `writable` back.

---

### 2026-08-16 — the fourth time the question came up, deleting was the wrong answer

Three times this week "is this mutant equivalent?" was better answered by "why does this code need
this branch?", and the branch went away. The fourth time it did not, and the difference is worth
recording so the pattern is not applied as a reflex.

`effectiveLevelOf` picks the stricter of the module level and a destination's `minLevel`, and
`>` → `>=` survived: the two differ only when the indices are EQUAL, and then both branches return
the same level string. Genuinely equivalent.

The delete-the-branch move was tried first, as the three entries below did. Every formulation trades
this mutant for a worse artefact: `LOG_LEVEL_PRIORITY[Math.max(a, b)]` is `LogLevel | undefined`
under `noUncheckedIndexedAccess`, so it needs a fallback that nothing can reach — an unreachable
branch instead of an equivalent mutant — and it is the value-keyed index the object-injection rule
flags, which the codebase already avoids elsewhere for that reason.

So this one is suppressed, with the whole comparison in the reason. **The rule is not "always delete
the branch" — it is "ask whether the branch is load-bearing before writing the suppression".** Here
it is: the comparison is what makes the function correct for every non-tied input.

---

### 2026-08-15 — the third branch deleted rather than suppressed, in the same week

The readiness-hook work dropped the cold run to **99.64 %** with three survivors, and two of them
were one compare-and-assign branch:

```
destination-health.service.ts:83  [ConditionalExpression]  if (level < lowest) → true/false
destination-health.service.ts:83  [EqualityOperator]       `<` → `<=`
```

`<` → `<=` reassigns the identical value, so no test can distinguish it. The branch existed only to
keep the smallest level, and `Math.min` says that directly — the branch stops existing, and both
mutants with it. **Third time this week the answer to "is this mutant equivalent?" was "why does
this code need this branch?"**, and the third time deleting beat documenting.

The third survivor was different and worth separating: a `StringLiteral` in the hook-failure message.
Not equivalent at all — the assertions simply covered the FIRST half of a concatenation and left the
second, the half carrying the operator-facing consequence, unasserted. A survivor on a string literal
is almost always a missing assertion rather than an equivalent mutant, and treating the two the same
way is how a suppression gets written for a real gap.

---

### 2026-08-15 — a simplification deleted a suppression instead of moving it

The `1.2.7` fix (an error's own fields at every depth of the `cause` chain) unified into one function
the copy that existed twice — in the `err` serializer and in the sanitizer's node walk. The side
effect shows up in the table above: documented suppressions fell from **20 mutants to 15**.

The five that went were a single `// Stryker disable next-line ConditionalExpression` over the guard
`typeof source === 'object' && source !== null && !Array.isArray(source)`. With both call sites now
handing over an object, the parameter is typed `object` and the guard shrank to `Array.isArray(source)`
— the `null` and non-object branches stopped existing, and with them the need to explain why no test
kills them.

**Worth recording because it is the better outcome and the rarer one:** the answer to "this mutant is
equivalent" almost always becomes a well-written suppression comment. Here the right question was a
different one — _why does this code need this branch?_ — and the answer deleted the branch. One fewer
suppression beats one more justified suppression, because the type system now guarantees what the
prose was guaranteeing.

---

### 2026-08-15 — the incremental run was reporting a score the cold run did not

Refreshing this document is what caught it. Every mutation run during the `1.2.3`–`1.2.6` work
was `pnpm mutation` (incremental), and every one reported **100.00 %**. The cold run reported
**99.62 %** — three survivors, all in code added hours earlier:

```
pretty-dev.destination.ts:237  [BooleanLiteral]        this.initFailed = true → false
pretty-dev.destination.ts:292  [ConditionalExpression] if (this.initFailed)   → false
pretty-dev.destination.ts:292  [BlockStatement]        the drop branch        → {}
```

All three are one gap, and the gap was **introduced by a fix**. The pre-init buffer added in
`1.2.6` made "dropped" and "held" observationally identical: an existing case asserted only that
a write after a failed init produced nothing on stdout, and after the buffer existed, buffering
produced nothing on stdout either. Flipping `initFailed` to `false` left that case passing.

So a change that added a guarantee quietly weakened the test protecting a different one, and the
incremental baseline — which had those mutants recorded as killed from a run before the buffer
existed — did not re-test them.

Fixed by making the case distinguish the two states rather than assert their shared symptom: after
the failed init it now also shuts down, which drains anything still held. A merely-buffered entry
surfaces there; a dropped one does not. Cold run back to 100.00 % with 0 survivors.

**The operating lesson, which is why this is recorded rather than just fixed:** an incremental
score is a claim about the mutants Stryker chose to re-run, not about the suite. `CLAUDE.md`
already says `mutation:full` "measures the truth" — this is what that sentence costs when the
distinction is treated as a performance note. Any score quoted as a result, in a release note or
to a reviewer, should come from a cold run.

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

**Equivalent mutants.** The list below is the record of what was found and why. The
**canonical** justification now lives in the source, on the line each one applies to, as
`// Stryker disable next-line <Mutator>: <reason>` — the policy in
[`mutation_testing_plan.md`](./mutation_testing_plan.md), shared across the `@bymax-one/nest-*`
libraries. That reverses the note this paragraph used to carry: the comments do ship in the
unminified bundle, the measured cost is +0.10 kB brotli for seven of them, and a justification
sitting only in a document is one an editor never sees.

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
killing test and are a well-known false-positive source. This excluded 128 such
mutants that are nonetheless covered behaviorally by the suite.

## Critical paths

Every file below is at **100 %** in the 2026-08-15 cold run. The `Equivalents` column counts
mutants excluded by a documented `// Stryker disable` comment, not survivors — the score is the
same either way, but the number says how much of the file's protection rests on a suppression
someone has to keep honest.

| File                           | Score        | Equivalents | Note                     |
| ------------------------------ | ------------ | ----------- | ------------------------ |
| `normalize-url.util.ts`        | **100 %** ✅ | 23          |                          |
| `compile-redact-paths.util.ts` | **100 %** ✅ | 0           |                          |
| `http-logging.interceptor.ts`  | **100 %** ✅ | 0           | unit + integration tests |
| `services/*`                   | **100 %** ✅ | 4           |                          |
| `trace-context.mixin.ts`       | **100 %** ✅ | 2           | was 92.86 % as survivors |
| `sanitize-error.util.ts`       | **100 %** ✅ | 6           | was 88.89 % as survivors |
| `truncate-large-entries.ts`    | **100 %** ✅ | 2           | was 88.89 % as survivors |
| `safe-stdio.util.ts`           | **100 %** ✅ | 0           | new in `1.2.6`           |
| `pretty-dev.destination.ts`    | **100 %** ✅ | 0           |                          |

## Residual survivors (0)

There are none, and there are no genuine coverage gaps. The equivalent mutants that used to be
counted here as 10 survivors are now excluded at the line they apply to, by a
`// Stryker disable next-line <Mutator>: <reason>` comment carrying its justification — the
suppression policy in [`mutation_testing_plan.md`](./mutation_testing_plan.md). 15 mutants are excluded that way
across the tree; the other 128 of the 143 ignored are static mutants dropped by
`ignoreStatic: true`, which is a `perTest` attribution limit rather than a judgment about any
of them.

The three rows above marked "was …" are the visible half of that move: nothing about those files
got safer when their score went from 88.89 % to 100 %, the equivalents simply stopped being
reported as failures. Read the score as "no gap the suite could close", never as "every mutant
died".

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
