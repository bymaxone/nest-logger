# @bymax-one/nest-logger — Agent Specification

> **Prerequisite:** Read [CLAUDE.md](./CLAUDE.md) first for critical rules. This file extends it with architecture and patterns — load on demand, not every session.

---

Project overview, architecture, build and publish steps, and the guidelines index live in
[docs/repository-orientation.md](./docs/repository-orientation.md). They are orientation, not
rules, and they are kept out of this file because every byte here is charged against the
reviewer's instruction budget on each turn. Codex does not follow that link — nothing behind
it is normative, and nothing normative should be moved behind it.

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
    // throwing here is legitimate: the sink is dropped from the fan-out and the
    // reason is reported to stderr — it never aborts application bootstrap
  }

  write(payload: string): void {
    // non-blocking; errors are contained by destinationToStream
    // not called at all if onInit() rejected
  }

  async onShutdown(): Promise<void> {
    // flush pending writes, close connection
  }
}
```

### Error Handling — Never Crash the App

Failures are contained in `destinationToStream`, the `Writable` wrapper each destination is given
in the `pino.multistream` fan-out — NOT in `DestinationRegistry`, which owns only the
`onInit`/`onShutdown` lifecycle.

```typescript
// destinationToStream wraps every write():
try {
  destination.write(payload)
} catch (cause) {
  // stderr, NEVER through the logger — a broken sink must not be able to create
  // a write → log → write feedback loop, and `destinations` REPLACES the default
  // stdout sink, so the logger's own sinks may be the ones that are broken.
  reportDestinationFailure(RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED, name, cause, msg)
}
// The stream callback is then invoked WITHOUT an error: propagating it would make
// the wrapper emit an unhandled 'error' event, which crashes the host.
```

The same reporting path serves `onInit` failures (`LOGGER_DESTINATION_INIT_FAILED`), so both stages
share one wire shape. If **no** destination initializes, entries fall back to raw NDJSON on stdout
rather than disappearing — see `DestinationHealth`.

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

The threat is log forging, and it has TWO sinks. `pino-pretty`, which this library ships as
`PrettyDevDestination`, writes the parsed text straight to the terminal, so a raw `\n` **or** an
ANSI sequence like `ESC E` (next line) prints something indistinguishable from a genuine entry.
The raw NDJSON line is exposed too: JSON escaping covers only C0, so DEL, the C1 range (U+0085
NEL included), U+2028 and U+2029 are serialized VERBATIM — measured. Do not repeat the
"NDJSON is already safe" premise; it holds for LF and CR and for nothing else in this set. Line terminators
become the literal `\n`; every other terminal-driving control character becomes `\uXXXX`.

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

## 6. Packaging invariants

`exports` declares `types` **per condition** — `import` -> `.d.ts`, `require` ->
`.d.cts`. A single shared `types` key makes CommonJS consumers resolve ESM
declarations, because `"type": "module"` marks plain `.d.ts` as ESM.

Subpaths also need a `typesVersions` entry: the `moduleResolution: node`
algorithm predates `exports` and ignores it, so without it a consumer on that
setting (the Nest CLI default when `module: commonjs` is set with no explicit
`moduleResolution`) cannot find the subpath's types. `pnpm check:exports` runs
the strict `attw` profile, which covers that mode — never weaken it with
`--profile` to silence a row.

## 7. Common Pitfalls

### Security

| Pitfall                                | Fix                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Consumer disables default redact paths | Warn in JSDoc; require explicit `shouldDisableDefaultRedact: true`                          |
| Raw OTel trace ID from HTTP headers    | Always validate with `isValidTraceId`                                                       |
| Destination `write()` that throws      | Wrapped by `destinationToStream` — contained, reported to stderr                            |
| Destination whose `onInit()` rejects   | Dropped from the fan-out, reported to stderr; if NONE init, raw NDJSON falls back to stdout |
| Logging full Error objects             | Use `sanitizeError(err)` before passing to Pino                                             |
| New sink that hands a string to Pino   | Route it through `toSingleLineMessage` — the escaping is per-sink                           |

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

## 10. Code Review Rules

<!-- shared:begin -->
<!--
  CANONICAL COPY: bymaxone/.github → agents/code-review-rules.md
  Do not edit this block in a consuming repository. It is replaced wholesale by
  the `agents-sync` reusable workflow, so a local edit is reverted on the next
  run. Change it here, cut a release, and every repository is offered the update.

  Repository-specific rules go OUTSIDE this block, below the closing marker.
  Editing notes: AGENTS.md in bymaxone/.github.
-->

These rules hold in every Bymax repository. What is specific to this one is written after this
block, and the two are read together.

The pipeline already enforces formatting, linting, dependency policy, coverage and — where the
repository has one — the mutation gate. Do not spend a review on a **violation** of one of those: it
is a red check, not a comment. What follows is what CI cannot see.

A violation of a rule in this block is reported at **P1** at minimum. Codex surfaces only P0 and P1
on a pull request, so a rule whose violations land at P2 is a rule nobody sees.

**When a rule moves from here into a check, it leaves here.** A red check is proportionate to a
correctness failure that is invisible without it, and disproportionate to style enforced at an
inconvenient moment. Never carry both: a rule stated here _and_ enforced by CI spends a reviewer's
attention on what a gate already reports.

**A change to the enforcing configuration is the opposite case, and it is in scope.** Every gate runs
the configuration from the branch under review — that branch's lint config, its coverage thresholds,
its mutation thresholds. So a pull request that deletes a rule, lowers a threshold or widens an
ignore glob turns the check **green**, because a gate reports on the rules it was handed. For those
diffs the review is the only independent check there is, and a weakened gate needs the same
justification a suppression does.

### A finding names what it read

Every factual claim in a review — about a library's API, about this repository's history, about what
a file contains — has to come from something read in the tree under review, and the finding should
say which. A claim assembled from recollection is likely to describe a previous version of whatever
it is about.

**Safe path**, by the kind of claim:

| Claim about                             | Read this                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| A library's API **shape**               | `node_modules/<pkg>/dist/**/*.d.ts` in this tree                               |
| A library's **runtime behaviour**       | that version's changelog entry, its documentation, or a test that exercises it |
| A commit's author or committer identity | out of scope: it is not text a change introduces                               |
| What a file contains                    | the file at the revision under review, not an earlier one                      |

The first two rows are separate on purpose: a `.d.ts` settles what a signature accepts and nothing
about what the implementation does with it, so a behavioural claim resting on one is unfounded.

Weight the checking by what acting on the finding would cost. A comment that asks for a reworded
sentence is cheap to be wrong about; one that asks for history to be rewritten, a merge reverted, or
a release pulled is not — verify that class before raising it, and raise it at the severity the
evidence supports rather than the severity the consequence would deserve if true.

### A bug reproduces, and a finding is this change's

Unless a rule here says to report without one, raise a bug only with its trigger: the input or
repository state, the command, the wrong result. Letting through what should be refused is P1 at
least, as is a crash an untrusted caller can trigger; a refusal, or a crash no untrusted caller can
reach, on input the project does not claim to support is not. Behaviour already present at the merge
base belongs to another change. On new commits, review what changed since the last reviewed commit,
and treat a thread resolved or answered with a reason as settled. One comment per root cause, its
siblings named in it.

### A dependency upgrade migrates every call site, not only the ones that fail to compile

When an upgrade tightens a contract, the compiler catches only the call sites whose **shape**
changed. A field that stays optional in the published type while becoming mandatory in behaviour
compiles, passes the unit suite, and fails in production.

A `@bymax-one/*` version number carries **no compatibility information** while the libraries are
pre-stable: breaking changes ship in minor and patch releases by explicit policy, so `^` and `~`
protect against nothing. The migration note under **Apply to a derived backend** in the library's own
changelog is the compatibility contract.

**Safe path:** read **every** changelog entry from the version being replaced up to the proposed
one, not only the proposed one's, and check every call site they name — not only the ones the
compiler rejected. Upgrades routinely skip releases, and the entry that matters is often not the
last one: adopting `@bymax-one/nest-cache` 1.1.0 → 1.2.1 skipped 1.2.0, whose entry holds a security
fix. Diff the `.d.ts` of the **previously adopted** version against the **proposed** one — `npm
pack` both, and name the two versions. Reaching for "the installed declarations" is the trap: in a
checkout of the branch under review the installed tree is already the new version, so that diff
compares a release with itself and shows nothing.

### Settled decisions are not review findings

Both are settled deliberately, and reopening either costs a round trip and changes nothing:

- **Do not propose a major version bump** for a breaking change in a `@bymax-one/*` library, and do
  not assert that this ecosystem follows strict SemVer. Until an API is declared stable, breaking
  changes ship in minor and patch releases; the migration note carries the compatibility information
  the number does not. If a document claims strict SemVer, the finding is that the claim is wrong —
  not that the version should be raised.
- **Do not propose pinning `bymaxone/.github` reusable workflows to a commit SHA.** They are
  referenced by the `@v1` alias on purpose: a fix has to land once and reach every repository, the
  tag is immutable and the alias moves only on a release, and pinning was measured to cost ~58
  dependency pull requests to propagate one change. Third-party actions are the opposite case and
  **are** pinned by SHA.

**Safe path:** if you believe a settled decision is now wrong, say so as a question in the pull
request rather than as a finding.

### Suppressions are refusals, not exceptions

`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable` in any form,
`as unknown as` laundering a real type error, `istanbul ignore`, and in Rust `#[allow(...)]` over a
lint gate or `unsafe` without a `// SAFETY:` comment are blocking findings.

Anything a configured gate already reports belongs to the gate, not to a review: where a repository
lints `no-explicit-any` as an error — most do — an `as any` is a red check, and raising it here only
duplicates it. Check the repository's lint configuration before reporting a suppression rather than
assuming the list is exhaustive in either direction.

A failing gate means the code is wrong, the type is wrong, or the rule is wrong. **Safe path:** fix
whichever it is. Changing a rule's configuration with a stated reason is legitimate; scattering
per-call-site silencers is not.

### A key built from more than one field keeps its boundaries

A key or digest derived from **two or more variable fields** must not let a field's content move the
boundary between them. `${tenantId}:${recipient}` makes `('a:b','c')` and `('a','b:c')` one key,
which no digest strength repairs, and one tenant's lookup then resolves another's record. Rejecting
empty fields does not fix it, and neither does a caller that validates its input — the property has
to hold in the construction. A fixed prefix beside a single field is not this shape.

**Safe path:** encode each field so it cannot contain the delimiter, or hash each to a fixed width.
Any other composition needs an argument that every boundary is recoverable, and one bounded field
does not rescue two free ones beside it. Then assert it in a test: where the property holds only
because of the values in play, the next one added takes it away and nothing says so.

### Comments state constraints, never history

A comment must read as true for whoever opens the file next. Flag any comment that narrates what a
previous version did, names a phase, task, ticket or review round, or explains a change rather than
the code. **Safe path:** state the constraint that still holds, and let `git log` carry the history.

Evidence for a constraint is not history, and how the evidence was obtained does not decide which it
is. The test is whether the fact still binds the next reader. A measurement that predicts what they
will hit on the other path — what the alternative did, what it costs in numbers — belongs beside the
constraint it supports, however it was obtained. What ages is the part that cannot recur for them:
what a previous version of this code did, a version number, a registry state, a review round, a
failure that has since been fixed. Flag those; keep the measurement.

### Size and layering

Functions over **50 lines** and nesting deeper than four levels are findings **for what a change
introduces** — a new function, or a change that pushes an existing one past the limit — in the
repository's own source and test directories. A test-suite grouping construct (`describe`, `context`,
`mod tests`, a table of cases) is not a function; the unit under the limit is the body of a single
`it`/`test`/`#[test]`. On the same terms, every non-trivial source file a change introduces opens
with a header stating its purpose and its layer, and every exported symbol a change introduces
carries a doc comment.

**The 800-line file limit applies to what a change introduces, not to what it inherits.** A
repository that already carries a file past the line — a generator, a long end-to-end suite — would
otherwise produce a finding on every pull request touching three lines of it, which the author
cannot act on and did not cause. Raise it for a **new** file over the limit, or when a change pushes
a file past it or materially grows one already over.

Markdown, generated output and lockfiles are **out of scope**: none has layers, and reporting their
length fires on every dependency bump and release note.

**Safe path:** extract by responsibility rather than by line count — the limit is a symptom, and one
file doing two jobs is the defect.

### Language and attribution

Everything published is English — source, comments, tests, commit messages, pull request titles and
bodies, `README.md`, `CHANGELOG.md` and everything under `.github/`.

Each repository states its language policy for `docs/` below this block. Report a language finding in
`docs/` only against what the repository states; where it states nothing, `docs/` is English like
everything else. A `docs/` language other than English is a repository-owner decision recorded in the
narrowings, not a convention a contributor may introduce.

No commit, pull request, comment or code may attribute authorship to an AI assistant or coding tool,
in any form. **Only text the change introduces is in scope** — a trailer, a "generated with" line, a
signature in a comment or a description.

A commit's author and committer fields are not that: they come from the contributor's git
configuration rather than from the diff, and a review reading the diff cannot see them. Never report
an identity field, and never present a command's reconstructed output as evidence for one. Measured:
twenty-six such findings, every SHA resolving nowhere and every `git log` line unrun, each asking to
rewrite published history.

<!-- shared:end -->

## Where this repository narrows a shared rule

Only the rules a reviewer gets wrong **here**. Each is a narrowing of the block above, not a
disagreement with it.

### `destinations` REPLACES stdout — it never adds to it

A non-empty `destinations` array is the complete list of sinks. `DefaultStdoutDestination` is the
default only when the array is absent or empty, so a consumer that adds a Loki or file sink and
does not restate stdout has **silently turned structured stdout off**. This is the most
consequential thing to miss on a consumer pull request and the failure is silent: no error, no
warning, a deployment that simply stops producing log lines where someone was reading them.

**Safe path:** on any diff that sets `destinations`, check whether `new DefaultStdoutDestination()`
is in the list, and ask if it is not. The replacing behaviour is deliberate — a file-only or
socket-only deployment has to be able to turn stdout off — so the finding is "was this intended",
never "this is a bug".

### `DEFAULT_REDACT_PATHS` is append-only

Paths may be added; a path is never removed or reworded without a major version bump, because
removing one silently widens what reaches a sink for every consumer that never configured
redaction. Extend coverage with the `redactPaths` option. `shouldDisableDefaultRedact` exists and
is not a normal thing to set — a diff that sets it needs a stated reason.

### Redaction is field-based, so a value interpolated into `msg` has no name to match

A secret inside a **field value** is covered. A secret pasted into the message string is not — it
has no field name for any strategy to match, so this is not an uncovered case that configuration
could close, it is outside what field-based redaction can do at all. The rule to cite is: **a value
that matters is a field, not text.**

**Safe path:** flag template literals that interpolate a token, key, password or header value into a
log message, and ask for it to be moved into the structured metadata argument.

### `run()` REPLACES the log context; `runMerged()` extends it

`LogContextService.run()` opens a scope from its argument alone, so a nested `run()` discards
everything the enclosing scope held. Nothing throws — `get()` returns `undefined` and the field is
simply missing from every entry inside — which is why this is found in production, by absence.
Replacement is the deliberate default: merging by default would let a background job started inside
a request scope inherit the caller's `userId` and attribute its entries to a user who never
triggered it.

**Safe path:** on a diff introducing a nested `run()`, check whether the enclosing scope's fields
were meant to survive; `runMerged()` is the explicit opt-in.

### Where the access log is mounted decides which requests exist

`applyAccessLog(app)` mounts from `main.ts`, ahead of the body parser, and covers every request that
reaches the process. `applyRequestIdMiddleware(consumer)` mounts through `configure(consumer)`,
which NestJS registers **after** the parser, so a request the parser refuses — malformed body,
oversized payload, unsupported content type — produces no access log and opens no correlation
scope. Neither is deprecated, and the second is the right choice for correlation scoped to a route
subtree.

**Safe path:** on a consumer diff that wires only `applyRequestIdMiddleware`, do not report it as
wrong; note the coverage difference if the change is about observability completeness.

### A Stryker suppression's reason must sit after the colon, on that one line

The grammar is `// Stryker disable next-line <Mutator>: <reason>`. Stryker captures a reason only
after the colon and only to the end of that line, so a reason written after `--`, or wrapped onto a
second comment line, is **silently dropped** and the report degrades to "Ignored using a comment".
`pnpm check:mutants` enforces this. An equivalent mutant is documented in the source, on the line it
applies to — never by lowering a threshold.

### The size budget is recalibrated from the artifact, never satisfied by minifying

The published `.mjs` ships unminified with JSDoc on purpose. When real growth pushes past the
budget, the budget is recomputed from the built artifact with modest headroom and the reason is
written into the calibration history in `scripts/check-size.mjs`. Trimming prose to fit is not a
fix and usually is not even an effect — the file-level docblock and inline comments do not survive
the build.

**Safe path:** a budget increase is a weakened gate under the shared rule above, so it needs its
justification in that history. Check that the new number was derived from the artifact rather than
set just far enough to stop the failure.

### The version line is frozen, and a stalled number is not a finding

`package.json` moves only when the maintainer asks explicitly and names the number. The current
line is **`1.4.x`**. A pull request that adds public API without bumping the version is following
this rule, not forgetting one — do not report it. The current line and the reasoning live in
`CLAUDE.md`; read it there rather than inferring the policy from the version history.

The library has real consumers, so a breaking change costs them something and the migration prose
in `CHANGELOG.md` is what they read instead of a number. A `### Breaking` heading with a migration
path is required; the version number is not the warning.

## Session memory (Obsidian vault)

Lessons from earlier sessions live outside the repository, in the owner's Obsidian vault at `~/Documents/MyApps/obsidian/Brain/`, when it is present on this machine. Before a task, find this repository's hub under `02 - Areas/`: the table in `02 - Areas/Bymax/Bymax.md` maps each Bymax repository to its folder; for any other repository, search `02 - Areas/` for the repository name. Read the hub with its `Learnings.md` and `Decisions.md`, and the relevant stack notes under `03 - Resources/`. When the vault and the code disagree, the code wins. Record each non-obvious gotcha, root cause or decision in the hub as the vault's `_meta/conventions.md` describes; a repository without a hub gets one from `_meta/templates/project-hub.md`.
