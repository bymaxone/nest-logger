# Changelog

All notable changes to `@bymax-one/nest-logger` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `release.yml` workflow extracts the section matching the pushed `vX.Y.Z` tag
as the GitHub Release body, so each released version needs a matching `## [X.Y.Z]`
heading here.

## [Unreleased]

## [1.4.0] - 2026-08-29

No breaking changes. Nothing you have wired stops working, and no export was renamed.

### Added

- **`applyAccessLog(app)` — the access log mounted ahead of the body parser.** A request the body
  parser rejects never reaches module middleware, so until now it never reached the access log
  either. NestJS registers the parser one line before it registers module middleware
  (`@nestjs/core/nest-application.js`: `registerParserMiddleware()` then `registerModules()`), and
  Express dispatches in registration order, so `next(err)` from the parser skips every remaining
  non-error handler — module middleware, guards, interceptors and the route handler alike. A `POST`
  carrying truncated JSON produced no access log at all, and the same hole covers a payload over the
  body limit and an unsupported content type: the requests a client got wrong or an attacker shaped.

  What you got before this release depended on your wiring, and neither answer was good. With
  `forRoot` and the default `shouldCaptureExceptions`, the filter **did** catch the parser rejection
  and emit one `HTTP_EXCEPTION_HANDLED` line — measured, not assumed — but with **no `requestId`**,
  because the correlation scope is mounted behind the parser too and never opened. The client could
  send `x-request-id` and the entry carried nothing to join it to. With `forRootAsync`, or with
  `shouldCaptureExceptions: false`, there was nothing at all. A 400 you cannot trace to the caller
  is the same defect as a missing 400, wearing a healthier face.

  `INestApplication.use()` delegates straight to the HTTP adapter and `init()` — where the parser is
  registered — does not run until `listen()`, so mounting from `main.ts` lands ahead of the parser,
  the same reason `helmet` and `cookie-parser` are mounted that way. `HttpAccessLogMiddleware`
  needed no new logic to work there: it already emits from the response's `'close'` event, reading
  `statusCode` and `writableFinished`, so it never depended on a route matching, a handler running
  or a filter catching anything. It was written correctly and mounted too late.

  One line in and one line out now cover the parser rejection, the unmatched-route 404, the guard
  rejection and the aborted connection alike. Call it after `NestFactory.create()` and **before the
  application initializes** — that is, before `app.init()`. `listen()` only triggers `init()` when it
  has not already run, so "before `listen()`" is the same deadline for the usual bootstrap and the
  WRONG one for a serverless entry point or an integration test that does `await app.init()` and
  wires up afterwards: that mount lands behind the parser and logs nothing extra, with no error to
  say so.

- **`HttpAccessLogMiddleware` is exported.** Without the class, an early mount was impossible to
  express — a consumer with its own bootstrap sequence had no way to reach it. It is the same class
  `applyRequestIdMiddleware` has always wired; only its visibility changed.

- **`LogContextService.runMerged(context, callback)`** — a scope that EXTENDS the enclosing one
  instead of replacing it, for the case where an inner scope is genuinely a refinement of the outer:
  adding a `userId` once authentication resolved it, without restating the `requestId` the
  middleware already set. Outside any scope it behaves exactly like `run()`. Writes inside it never
  reach the enclosing context — the merge produces a fresh object.

### Fixed

- **Two mounts of `RequestIdMiddleware` minted two different correlation ids.** `use()` sets the id
  on the RESPONSE header and never writes it back onto `req.headers`, so a second mount with no
  inbound header saw nothing and minted its own: the outer set the response header to one UUID and
  the inner overwrote the log context with another, leaving the header and the entries disagreeing
  about which id the request had. Each answer was internally consistent, which is why it survived —
  nothing looked broken from either side alone.

  The middleware is now idempotent, off two marks kept on the REQUEST rather than off a header
  write-back. Writing the minted id back onto `req.headers` would have worked and was rejected
  deliberately: it conflates "the client sent this id" with "we minted this id", and anything
  downstream treating an inbound header as client-attested would start reading our own UUID as the
  caller's.

  **What is adopted is the id this library validated for this request — not whatever the log context
  happens to hold**, and the difference decides how a gateway-provided id has to be passed. An id
  that reaches the middleware only through an enclosing `LogContextService` scope is never adopted
  and never echoed. With generation on, the request gets its own id: the inbound `x-request-id`, else
  a fresh UUID. With `shouldGenerateRequestId: false` and no inbound header, an enclosing `requestId`
  is inherited into the request's entries but no response header is set. **To have an upstream id
  echoed, send it as `x-request-id`.**

  The marks are two because they answer two questions and either can be true alone. One records that
  a scope for this request was opened, and decides whether a second mount opens another. The other
  records the validated id, and decides what may be echoed — read from the request rather than the
  store, so a value middleware replaced between the mounts (`set()` takes `unknown`) cannot reach the
  response header. The adopt path also **restores** the validated id to the active context, because
  the emitted entry reads `requestId` from the store: echoing one value while leaving another in the
  store would produce the same header/entry split this change exists to remove.

  The request's own scope now starts from the enclosing scope's fields rather than from nothing,
  which fixes a second thing in the same place: a consumer that opened its own scope upstream — a
  tenant resolved at the edge — had it **discarded** for the whole request, because `run()` replaces
  the context.

  What it inherits is an ALLOWLIST — `requestId` and `tenantId`, the library's own correlation
  fields — and that shape took three review rounds to reach. A denylist cannot be made safe here:
  `LogContext` explicitly permits arbitrary consumer keys, so an application-defined `accountId` or
  `sessionId` misattributes a request exactly the way `userId` does, and no list of forbidden names
  is ever complete. Measured on the denylist version: a request opened inside a scope holding
  `{ accountId, sessionId }` inherited both.

  The identity cases the denylist did catch are worth recording, because they are what the allowlist
  now covers by construction. `userId` is resolved by a guard that runs after this middleware, and
  the mixin copies the store onto every entry while `PinoLoggerService` deliberately does not write
  `userId: undefined` when the argument is omitted — so an anonymous request inside a scope holding
  `userId: 'admin-u1'` was logged under `admin-u1`. Trace fields leak the same way, in every naming:
  the mixin overwrites them from the active span but only when there IS one, and the field names are
  configurable (`otel.fieldFormat: 'snake_case'` renames all three), so a literal exclusion was
  wrong in both directions at once.

  Dropping a field a consumer set upstream is not a regression — before this release `run()`
  discarded all of it — and it fails in the safe direction: a missing field is visibly missing,
  where an inherited identity is wrong while looking right.

- **A `g` or `y` flag on an `excludePaths` pattern excluded the path only every other time.**
  `RegExp.prototype.test` on such a pattern advances its `lastIndex` and resumes from it, so the
  same pattern tested twice against the same path returns `true`, then `false`. Measured on
  `/^\/health$/g` against `/health`: `true, false, true, false`. The patterns live in module
  options — one frozen array shared by the access-log middleware and the HTTP interceptor for the
  lifetime of the process — so a consumer who carried a `g` flag in from a copied pattern saw
  excluded health checks reappear at half rate, with no error and nothing to suggest the config was
  not working.

  This predates `1.4.0`; mounting both wiring helpers only made it sharper, because the two mounts
  then test the same pattern twice within a single request and disagree outright. Both call sites now
  go through one matcher that clears the stored position before testing, so the answer depends only
  on the pattern and the path. Flags that say WHAT matches (`i`, `m`, `s`, `u`) are the consumer's
  expressed intent and are untouched. Raised by Codex.

  The clear happens only for a pattern that actually carries a position, and that guard is
  load-bearing: `Object.freeze` on a `RegExp` — which a deep-freeze over a config module reaches —
  makes `lastIndex` non-writable, and under ESM's strict mode assigning to it throws
  `TypeError: Cannot assign to read only property 'lastIndex'` while `.test()` on the same pattern
  works. Clearing unconditionally would have turned a working configuration into a throw on the
  request path. A frozen pattern that IS global stays broken, and not by this: `test()` writes
  `lastIndex` itself, so it throws before any of this runs.

- **A second mount of `HttpAccessLogMiddleware` doubled every access-log line.** It claims the
  request's log lifecycle so the interceptor stays silent, but never checked whether the claim was
  already made. It now stands down on an already-claimed request: one START and one terminal entry
  per request no matter how many times it is mounted. The claim is per-request state, so a
  different request is unaffected.

### Documentation

- **`run()` now says that a nested scope DISCARDS the enclosing one.** The docblock said "a fresh
  context scope", which does not tell a reader that an outer scope's fields are gone for the whole
  inner one — nothing throws, `get()` just returns `undefined`, and the field is missing from every
  entry the callback emits. Reported by a consumer that lost a `tenantId` resolved at the edge.

  Replacement remains the default, and the reason is the direction the other choice leaks: a
  background job started inside a request scope would silently inherit the caller's `userId` and
  attribute its entries to a user who never triggered it. A missing field is visibly missing; an
  inherited one is wrong while looking right. `runMerged()` is the explicit opt-in.

- **The README states what is not logged, and what a rejected request actually produces today.** The
  absence read as a misconfiguration to whoever went looking for it, and cost a consumer real time
  before it was traced to the parser. The new §5 subsection carries the ordering, the two-row table
  of what each wiring emits, and the `main.ts` snippet.

- **`applyAccessLog` names `init()` as its deadline, not `listen()`.** `listen()` only triggers
  `init()` when it has not run yet, so "before `listen()`" is true for the usual bootstrap and
  false for a serverless entry point or an integration test that does `await app.init()` and wires
  up afterwards — that mount lands behind the parser and logs nothing extra, with no error to say
  so. A late mount is not rejected at runtime because NestJS exposes no supported signal for it
  (`isInitialized` is private, and inspecting the adapter's router would break on a patch release
  while claiming to be a safety net), so the deadline is documented at the call site instead. Raised
  by Codex.

## [1.3.1] - 2026-08-18

### Documentation

- **`excludePaths` says what its defaults do not reach.** The defaults are
  `[/^\/health$/, /^\/metrics$/]`, and `@bymax-one/nest-core` serves liveness and readiness at
  `/health/live` and `/health/ready` with no bare `/health` at all — so the default excludes a
  route that does not exist while logging both probes. A consumer running both measured **8272 of
  8274** HTTP entries as the liveness probe, at one container healthcheck every ten seconds; at
  orchestrator volume it is the same shape with more zeros. There is no error and no warning, and
  the config reads as though it were handled.

  The defaults are **not** widened, and the reason is checkable rather than a preference: both
  prefixes are configurable there (`DEFAULT_HEALTH_PATH`, `DEFAULT_METRICS_PATH`). A default
  naming specific subpaths would be less wrong rather than correct, and a prefix pattern would
  silently swallow a consumer's own `/health/*` route they did want logged. Excluding a path
  decides which requests vanish from the record, so it stays explicit — the docblock now carries
  the one-line fix for the stock layout, and it ships in the `.d.ts` where someone wiring the two
  libraries reads it.

### Internal

- **The last surviving mutant is gone, by deletion rather than annotation.** A `catch` in
  `report-destination-failure` re-assigned `undefined` to a variable already `undefined` from its
  declaration, so emptying the block changed no output for any input and no test could kill it. A
  Stryker directive was tried first and was not honoured at that position. The project scores
  **100.00** on a cold run: 1515 mutants, 841 killed, zero survivors, 145 documented equivalents.

## [1.3.0] - 2026-08-18

### Fixed

- **A frozen `Error` lost every field, including its own message.** A consumer that freezes its
  errors — deliberate and documented practice, so nobody mutates an issue list after the throw —
  hands over properties that are neither writable nor configurable. The redactor's clone inherited
  those descriptors, and rewriting any key whose walked value is a fresh object (a censored secret,
  or simply the structural copy the walk makes of a nested array) could not redefine it. That
  failure reached the fail-closed guard and dropped the **whole** record, so the entry became
  `_redactionFailed: true` and nothing else — total silent loss on the error that crashed the
  process, which is the one entry worth logging.

  A frozen error carrying only scalars never showed it, because redefining a property with the same
  primitive succeeds; it took a nested object to expose it. Reported against 1.2.7 by a consumer and
  reproduced unchanged on 1.2.9.

  The clone is transient — built, serialized, discarded — so it is now built with relaxed
  descriptors and the write always lands. **The caller's error is never touched**, and freezing
  remains the caller's guarantee about the caller's own object.

  A non-configurable secret is now **censored** rather than dropped: same protection, without
  losing the surrounding fields. The frozen error also keeps its **stack** again — V8 exposes it as
  an own property bound to the original's internal state, so the clone pins a resolved copy, and on
  a frozen error that pin was failing silently too. The case that did NOT drop the record was
  therefore already reaching the sink with its trace erased, which is the same defect wearing a
  healthy face; a consumer measured that independently. `LOGGER_REDACTION_FAILED` is unchanged for the case it was written
  for — a record the walk cannot READ, such as a throwing getter or a hostile proxy.

### Documentation

- **The limit of field-based redaction now ships.** A value interpolated into the message has no
  field name for any strategy to match — not an uncovered one, none — so no configuration closes
  that gap and the rule is "a value that matters is a field, not text". It was stated only in
  `docs/OBSERVABILITY-CONTRACT.md`, which is not in `files`: it reached whoever had the repository
  and nobody who installs from npm. The decision it governs is made at a call site in a derived
  backend whose only copy of this contract is what the registry delivers, so it is in the README's
  security model now, beside the case it sharpens — that one covers a secret inside a field's
  **value**, this one a value with no field at all.

- **The `minLevel` entry below, under 1.2.9, now names the direction of its change.** The behaviour
  changed in that release and its record stays there; what shipped here is the paragraph explaining
  what upgrading does. A sink configured with an unrecognised level was silent and starts delivering
  at the module level, which arrives as a step change in ingestion cost and reads as a noise
  regression unless the note says which way it moves. Two consumers asked for this independently.

## [1.2.9] - 2026-08-16

> **`1.2.8` was merged but never published.** The defect below was found in it after the merge and
> before any tag existed, so the version was left untagged rather than released and superseded. npm
> therefore goes `1.2.7` → `1.2.9`; the `1.2.8` section stays as the record of what landed, because
> it is what `main` contains.

### Fixed

- **A destination whose `minLevel` was not one of the six levels received NOTHING, silently.**
  `readonly minLevel?: LogLevel` is a compile-time claim, and a JavaScript consumer — or a
  miscast one — can return any string; `'verbose'` is a real NestJS level name and a natural
  thing to write. `pino.multistream` does not reject an unrecognised level: it builds without
  complaint and the entry then matches nothing. Measured on a sink configured that way: **0 of 3
  emitted entries delivered**, while the registry recorded it as covering the module level,
  because `LOG_LEVEL_PRIORITY.indexOf` returned `-1` and lost the comparison. A destination
  believed healthy and receiving, receiving nothing, is the worst failure this library has.
  `safeMinLevel` now validates the value against the canonical list and treats an unrecognised
  one as absent, so the destination falls back to the module level and keeps receiving.
  `validateOptions` already held `options.level` to that same list; this is the check reaching
  the one place it had not.

  **On upgrade this changes your log volume, upward, and it will not look like a fix.** A sink
  that was configured with an unrecognised level and was therefore silent starts delivering at
  the module level the moment you install this version. Read as a graph, that is a step change in
  ingestion cost arriving with a patch; read correctly, it is entries that were always supposed
  to be delivered and never were. If you see one, check that destination's `minLevel` before
  treating it as a regression — the value has to be one of `'trace'`, `'debug'`, `'info'`,
  `'warn'`, `'error'` or `'fatal'`. `'verbose'` and `'log'` are NestJS level names, not Pino
  ones, and are the likely culprits for anyone arriving from `LoggerService`.

- **A write returning a thenable that is not `instanceof Promise` no longer takes the synchronous
  path, where its rejection escaped and its entry could be discarded.** `instanceof` is realm-local:
  it answers `false` for a promise built in another realm — a worker, a `vm` context — and for any
  structurally valid thenable. Measured, both:

  ```
  thenable instanceof Promise?                    false
  promise from another realm instanceof Promise?  false
  Promise.resolve() assimilates both?             true
  ```

  Such a write took the branch meant for synchronous sinks: the stream callback fired immediately, a
  later rejection surfaced as an **unhandled rejection** instead of a reported
  `LOGGER_DESTINATION_WRITE_FAILED`, and the write was never counted as in flight — so `1.2.8`'s
  readiness check could tell a buffering destination that delivery was proven and let it discard its
  only copy of an entry that was about to fail. Losing an entry is the one outcome this path does not
  accept.

  The branch is now on `undefined`, which is what the declared `void | PromiseLike<void>` actually
  distinguishes, and the result goes through `Promise.resolve` — which assimilates both shapes.
  Synchronous writes keep the synchronous path, so back-pressure is unchanged.

  This library learned the realm-local lesson once already, from `instanceof Error`, which is why
  `isErrorLike` exists. The same mistake sat one file away.

### Breaking

- **`ILogDestination` declares `void | PromiseLike<void>` instead of `void | Promise<void>`,** on
  `write`, `onInit`, `onRegistryReady` and `onShutdown`. The fix above handles a thenable at runtime;
  the public type still forbade one, so a TypeScript consumer could not return the very shape the
  release claims to support — the tests needed casts precisely because of that gap, and the casts are
  gone.

  **This is source-breaking for CALLERS, and an earlier draft of this note wrongly said it was not.**
  Widening what an implementation may return necessarily narrows what a caller receives: `PromiseLike`
  exposes only `then`, so code that called `.catch()` or `.finally()` on the result no longer type-checks.

  The call has to be narrowed first, in both versions: `write` has always been able to return
  `void`, so `.catch()` was never available on the bare call.

  ```ts
  const result = destination.write(payload)

  // before — `result` narrowed to `Promise<void>`, so `.catch` was there
  if (result !== undefined) result.catch(handle)

  // after — it narrows to `PromiseLike<void>`; assimilate to get `.catch` back
  if (result !== undefined) Promise.resolve(result).catch(handle)
  ```

  There is no type that gives implementations the freedom and callers a full `Promise`; this release
  chooses the implementations, because a destination that cannot be written in the first place is the
  worse failure.

### Fixed

- **A throwing `minLevel` getter could abort application bootstrap.** `effectiveLevelOf` reads the
  consumer-defined `minLevel`, and `readonly minLevel?: LogLevel` does not stop it being a getter.
  It is read on BOTH branches of the init loop — including inside the catch that exists so a failing
  destination cannot stop the application from starting — so a throw there took the app down at
  start-up and stranded every destination after it. The read is guarded inside `effectiveLevelOf`,
  which covers every call site at once, and falls back to the module level: what a destination
  without a `minLevel` gets anyway. Same defect class as the `name` getter, in the sibling property.

  The registry was not even the FIRST reader. `pino-factory` builds the multistream entry from
  `destination.minLevel` at provider-construction time, outside any guard and before any lifecycle
  hook — so a hostile getter failed the factory and the application never started, earlier than any
  fail-soft path could contain it. Found by sweeping every consumer-defined property read in
  `src/server` rather than by fixing the site that was reported: eight of the nine were already
  inside a `try`, and that ninth one made the registry fix unreachable in practice. Both sites share
  one `safeMinLevel` now, and it PINS the first answer per destination.

  Guarding the read stops the throw but not the DISAGREEMENT. Nothing makes the getter pure, and two
  independent consumers read it: the factory, which fixes the multistream entry's level, and the
  registry, which records the same destination's health level. A stateful getter answering `info` to
  one and `error` to the other would let an `error` sink be credited with covering held `info`
  entries, and a buffering destination would discard its only copy of them — a loss path, not an
  inconsistency. Pinning makes the two agree by construction; `readonly minLevel?: LogLevel` says it
  should not change anyway.

- **The shutdown reporter could be made to forge a second stderr record.** Its guard used
  `escapeControlCharacters`, which preserves newlines ON PURPOSE because a stack trace is
  legitimately multi-line — but it was applied to `cause.message` when no stack existed, and to any
  non-Error thrown value. A destination rejecting with `'failed\n[forged entry]'` therefore wrote a
  second raw line that an operator reads as a genuine record. The two escapers are not
  interchangeable: a stack goes through `escapeControlCharacters`, a message or a non-Error value
  through `toSingleLineMessage`. The regression asserts the emitted text is ONE line, not merely that
  an escape appears in it.

- **A failing `onShutdown` could abort the teardown of every destination behind it.** The registry
  built its stderr report by coercing the thrown value ABOVE the guard: reading `stack`/`message` on
  an `Error` with hostile getters, or `String(cause)` on a value with a throwing `Symbol.toPrimitive`,
  throws from inside the very `catch` that exists to keep one bad sink from mattering. The throw then
  propagated out of `onApplicationShutdown`, and every destination still queued lost its flush —
  turning one destination's bad error object into lost entries everywhere.

  The coercion is now inside its own guard, falls back to `UnknownError` when the value cannot be
  read at all, and the text is escaped like every other terminal-bound path. The regression test
  asserts that the SECOND destination still shuts down, not merely that nothing threw: continuing the
  teardown is the property that matters. Reverting the guard makes it fail — verified, not assumed.

  **The same gap existed at every other reporting call site, and the first fix only closed one of
  them.** `reportWriteFailure(destination.name, …)` in the write adapter and `reportInitFailure`
  in the registry both read the name at the call site — inside the catch — so a hostile getter turned
  a contained write failure into an unhandled rejection, and a failed `onInit` into an aborted
  bootstrap, contradicting the comment one line above it that the library never throws to abort boot.
  A shared `safeDestinationName` now performs that read under a guard, and every reporter uses it.

  The destination's own `name` is read inside a guard as well, and a separate one:
  `readonly name: string` does not stop a consumer implementing it as a getter, and reading it at the
  call site would have left it inside the `catch` with the same cost. That second gap was found by
  reviewing the fix for the first — the correction had reproduced the defect one layer up.

  The control-character escaping on this path is now asserted rather than assumed. Every shutdown
  test used plain ASCII, so replacing the escaper with an identity function would have left them all
  green — a 100% mutation score does not cover a transformation no test observes. The new case emits
  a stack containing an ANSI escape and a C1 character, and asserts that those are neutralized while
  the stack's own newlines survive.

  Found by a review comment on the DOCUMENTATION examples. The examples mirrored the implementation
  faithfully, which is exactly why the defect was worth chasing back into `src/`: a guarded writer
  never guarded the arguments handed to it, and that had been true in three places.

### Documentation

- **Snippets that referenced symbols which were not there are now caught by a parser, not by
  eye.** Five review rounds each found another documented example using `safeMinLevel`,
  `LOGGER_OPTIONS_TOKEN`, `PREVIEW_LENGTH`, `this.reportShutdownFailure` or an outright invented
  `RESERVED_LOG_KEYS.LOGGER_DESTINATION_SHUTDOWN_FAILED` with nothing to resolve them. `pnpm
check:docs` parses every TypeScript block — both `ts` and `typescript` fences — and fails on
  three things: a symbol this package declares in `src/` used without being imported or declared,
  a `this.member` the class shown does not define, and a `CONSTANT.KEY` the real constant does not
  have. It reads the syntax tree rather than the text, so a name in a comment is a mention and not
  a use. It runs in CI and in `prepublishOnly`, because a gate nothing executes is not a gate.

  The 43 pre-existing cases in the planning documents sit in a baseline that shrinks and does not
  grow: regenerating writes the intersection with what still reproduces, so a defect introduced in
  the same edit is never adopted, and an entry that stops reproducing fails too rather than
  lingering. Widening what the check looks at is the one case where the list legitimately grows,
  and it takes a separate `--adopt-new` flag so that decision is stated rather than taken
  silently.

- **The destinations guide credited the wrong component with building the fan-out.** It said
  `DestinationRegistry` wraps each destination into the `pino.multistream` array; that happens in
  `buildPinoInstance` (`src/server/pino-factory.ts:574`), and the registry owns the lifecycle hooks
  and the health record instead. The mistake was not only prose — the snippet's relative imports
  were written as `../utils/...`, which resolve only from `services/`, so following the guide gave
  paths that do not exist from where the code actually lives.

- **The specification gave the wrong reason for reporting init failures on stderr.** It said Pino
  was not yet wired at that point. It is — the instance is built during provider construction,
  which is why the same method emits `LOGGER_BOOTSTRAP_OK` through the logger a few lines later.
  The actual reason is the fan-out: the logger writes to the very set containing the sink that
  just failed. An implementer reading the old text would have inferred the wrong lifecycle order.

- **The shipped `README.md` no longer teaches the old contract.** Its `ILogDestination` reference
  still declared `Promise<void>` on `write`, `onInit` and `onShutdown`, and omitted `onRegistryReady`
  entirely — so the one document most consumers read described types incompatible with the interface
  and hid a hook from anyone who buffers. It ships inside the package, which makes it the copy that
  matters most.

- **Overflow was only reported when a later flush failed.** A request that stalls long enough to
  overflow the cap and then SUCCEEDS runs no catch at all, so the discarded entries were lost with
  nothing said — the opposite of the policy stated one paragraph above. Both examples report the
  dropped count on every settlement, not only from the failure path.

- **A guarded WRITER does not guard the arguments handed to it.** The documented adapters called
  `writeStderrSafely` with an interpolated `${String(err)}`, and that coercion runs before the call:
  an unknown rejection value with a hostile `Symbol.toPrimitive`, or an `Error` whose `message` getter
  throws, takes the handler down before `callback()` — an unhandled rejection produced from inside the
  containment. The previous release note credited the safe writer with a protection it never had.
  Every documented adapter now uses `reportDestinationFailure`, which does the coercion inside its own
  guard and escapes control characters.

- **A raced timeout is not a timeout.** The database example briefly carried a `Promise.race`
  deadline, which settles the AWAIT without cancelling the query: the batch would be requeued while
  the original `createMany` was still running, the next flush would start a second one, and a slow
  database would accumulate concurrent inserts of the same batch — duplicates, not just delay. The
  bound belongs at the driver, where it aborts the statement server-side (`statement_timeout` on the
  connection string), and the example says so instead of demonstrating a race. The HTTP example keeps
  `AbortSignal.timeout`, which does cancel.

- **Retaining a failed batch forever is a memory leak.** Requeueing on failure while `write` keeps
  appending is an unbounded queue: a sustained outage ends in an OOM, which loses every held entry
  AND the application. Both worked examples now cap the buffer and drop the OLDEST beyond it — the
  newest entries describe the incident — and report the dropped count rather than discarding
  silently. A destination that cannot lose anything is told to use a durable spool, not a buffer.

- **Four defects in the specification's own examples**, all from wiring `DestinationHealth` through
  them: the factory call site still passed the old three arguments, so a `LogLevel` landed where the
  health tracker was expected; the adapter never checked `isFailed`/`shouldRescue`, though the
  fan-out builds a stream for every registered destination and that branch is what keeps a
  failed-init sink out of it; the new provider dependency omitted the explicit `@Inject` this
  repository requires because tsup strips decorator metadata; and the shutdown loop contained
  failures with `Promise.allSettled` while reporting none of them, contradicting the guarantee the
  destination examples state.

- **The consumer-facing stderr guard reintroduced a defect the library had already fixed.** It
  remembered `guarded = true` in a boolean, which goes stale the moment anything else removes the
  listener — a test doing cleanup is enough — and every later EPIPE is uncaught again. It also
  treated ANY existing `'error'` listener as proof the stream was safe, though a consumer's handler
  may rethrow. `safe-stdio.util.ts` arrived at the right shape after exactly this: check whether OUR
  listener is in `stream.listeners('error')`, and only ever add. The documented helper now does the
  same.

- **The Loki example discarded its batch on every HTTP error.** `fetch` rejects only on a
  network-level failure; 401, 429 and 500 resolve normally, so the retention path added for it never
  ran on the failures a log sink actually sees. It checks `response.ok` and throws now. Its timer
  also still detached the flush directly, which the same commit had fixed only in the Postgres
  example.

- **A background flush was invisible to shutdown.** Both examples now chain background flushes into
  one tracked promise and `onShutdown` awaits it before the final drain: a flush that fails requeues
  its batch, and without the await those entries sit in a buffer nobody drains again.

- **The specification formatted failure reports inline instead of using `reportDestinationFailure`.**
  An `Error` with a throwing `message` getter — or a non-Error with a throwing coercion hook — makes
  an inline `String(cause)` throw from inside the very handler that exists to contain failures, and
  the inline form also skips the control-character escaping applied to remote-derived text. All four
  reporting sites in the document now go through the helper that does the coercion inside its own
  guard.

- **The batch-retention fix introduced a crash path of its own.** Making `flush()` rethrow is right
  for the shutdown caller, which awaits it — and wrong for the two background callers, which detach
  the promise. A detached rejection is an unhandled rejection, which terminates the process on
  Node 24: a loss path traded for a crash path, in the same commit that closed the loss. The two
  detached call sites now go through a `flushInBackground()` that swallows what `flush` already
  retained and reported, while `onShutdown` still awaits `flush` directly, where the rejection has
  somewhere to go.

- **The Loki example was still discarding its batch** — the same defect as the Postgres one, one
  section earlier, with `// Fail soft` written over it. Fail-soft means not crashing the host; it
  never meant dropping the entries. It retains and reports now, and the guarded stderr helper both
  examples use is defined once, ahead of its first use, instead of being named and left undefined.

- **The documented adapters recorded a failure only after the promise rejected**, leaving the
  in-flight window the implementation closes with `markWritePending`/`markWriteSettled`. Readiness
  can be computed while a write is still pending; without the pending count it reads as silent
  success, and a buffering sink discards its copy moments before that write rejects.

- **The specification's registry example referenced members it did not declare** — `this.active`,
  `this.health`, `this.effectiveLevelOf` — so the authoritative document showed an implementation
  that would not compile. It now declares them, and its shutdown loop iterates the ACTIVE subset
  rather than every registered destination, matching the implementation: a sink whose `onInit`
  failed may never have acquired what `onShutdown` would close.

- **The documented adapters reported a failed write but never RECORDED it.** The prose added with
  them says the adapter "contains it, records it and reports it"; the examples did the first and the
  third. Recording is the half that prevents the loss: without `markWriteFailed`, readiness still
  counts the sink as having taken the entry and another destination may discard the copy it was
  holding. The examples now take the health tracker and mark the sink before reporting.

- **The worked Postgres destination still lost a batch, in the example that demonstrates not losing
  one.** Removing the `try/catch` from its `write` was not enough: the flush it triggers runs after
  that `write` returned, and `flush()` ended in `catch { /* fail-soft */ }`, discarding every entry
  in the batch while the adapter had already recorded them as taken. A background flush is the one
  failure a destination must handle itself — so it now returns the batch to the buffer, reports it,
  and rethrows so the caller sees it. The stderr helper it uses is written out in full, because the
  library's guarded one is internal and a consumer cannot import it.

- **The specification contained two incompatible lifecycle contracts.** The `onRegistryReady`
  guarantee added above says the hook runs for every registered destination; the `DestinationRegistry`
  example further down truncated the registered list to the survivors of `onInit` and never called
  the hook at all. The example now keeps the registered set, writes only to the active subset, and
  awaits the hook for every destination with per-destination isolation.

- **The guide told destinations to swallow their own write failures — a loss path, in the document
  that defines the fail-soft contract.** "Catch every error in `write` and log it via
  `process.stderr.write`" reads as prudence and is the opposite: a swallowed failure looks like a
  successful write from outside, so `markWriteFailed` never runs for that sink, readiness can then
  credit it with entries it dropped, and ANOTHER destination discards the held copies it was keeping.
  The entry stops existing anywhere — exactly the outcome this release exists to prevent. The advice
  is now to let the failure reach the adapter, which contains it, RECORDS it and reports it. Two
  anti-pattern entries carried the same instruction, and the worked Postgres destination practised
  it; all three are corrected.

- **Every reporter in the documented examples wrote to `process.stderr` directly.** The guide
  explains, three sections earlier, that a closed pipe reports EPIPE asynchronously and kills the
  process — which is why `safe-stdio.util.ts` exists. The containment helpers added one commit ago
  ignored that and would have traded a contained destination failure for an uncaught exception. The
  library's own paths now route through `writeStderrSafely` in every example. The consumer-facing
  examples do not, because that helper is internal and unexported; they point at the EPIPE note
  instead, which is the honest instruction for code outside this package.

- **The technical specification did not state that `onRegistryReady` runs for a destination whose own
  `onInit` rejected.** It runs for every registered destination, verified against
  `notifyRegistryReady`, and a sink that failed to initialize is exactly the one most likely to be
  holding entries it now has to resolve. Left unstated, an implementer would reasonably assume the
  opposite and strand them.

- **The drain contract described a return value `_write` does not have.** It said the adapter signals
  backpressure by `_write` returning `false`; `_write` returns `void`. Deferring its callback is the
  actual mechanism — the chunk stays in flight, the internal buffer grows, and it is the PUBLIC
  `writable.write()` that returns `false` at `highWaterMark`. The conclusion the section drew was
  right and the model under it was not, which is the kind of text a destination author reasons from.

- **The documented adapter examples contradicted the fail-soft contract they were illustrating.**
  They routed a failed write into `callback(err)`, and the guide listed that as an advantage — "errors
  are propagated as a callback err (not as an exception that crashes the app)". A `Writable` given an
  error in its callback emits `'error'`, which with no listener terminates the host. The production
  adapter has always done the opposite, and says so in a comment one line above the code: contain the
  failure, report it on stderr, complete the write as successful. Every example, and the two prose
  lines that recommended the pattern, now match it.

- **Every documented `destinationToStream` example branched on `result instanceof Promise`** — the
  exact defect fixed above, in the snippets that teach people how to write a destination. A reader
  implementing against the guide, the specification or the plan documents would have reproduced the
  escaped rejection and the lost entry. All of them now branch on `undefined` and assimilate with
  `Promise.resolve`.

  These two were found only because a review kept pulling the same thread. Correcting the interface
  and the four excerpts that restate it still left the README and every worked example behind: a
  contract lives in more places than the ones that quote its signature.

  So the rule is now a gate rather than a habit. `check:published` compiled only README blocks that
  **import** the package, on the reasoning that naming the API is not a claim about it — which left a
  block that _re-declares_ an exported type unchecked, and that is exactly where the README drifted.
  It now compiles those too, with three assertions because each covers what the previous one cannot:
  mutual assignability catches a changed return type; key parity catches an omitted member, which is
  assignable in both directions and is how the absent `onRegistryReady` survived; per-member type
  identity catches a changed PARAMETER, which stays bivariant even under `strictFunctionTypes`.

  Both of the later assertions were added because a measured version of the gate let a real drift
  through: the first passed a README declaring `write(payload: unknown)`, and the second — comparing
  members as `T[K]` — passed one that dropped `readonly`, because indexed access discards property
  modifiers. Each hole was reproduced against the version that had it before being closed, and each
  assertion is verified the same way: introduce the drift, watch the gate name it, restore.

- **`heldEntriesDeliveredElsewhere` is documented as best-effort rather than as proof.** The JSDoc
  said `true` requires no write still in flight, which reads as complete accounting — while the
  `1.2.8` note already admitted that writes queued inside the `Writable` adapter are invisible until
  `destination.write()` is called. Both statements shipped in the same release, and they contradict
  each other.

  Calling it best-effort was not enough on its own: the surrounding prose still framed the decision
  as "discard only on proof", which is the same contradiction one paragraph up. The contract is now
  stated as what it is — a **deduplication signal**, where `true` means the smaller risk is dropping
  the held copy, not that the entry is safe. The library's own destinations dedupe on it because a
  duplicated boot line is a smaller harm than a lost one; a destination that cannot tolerate any loss
  is told to ignore the flag and always emit. The guide, the specification and the JSDoc now say the
  same thing, so a reader meets one story instead of three.

  Reframing the parameter was still not the end of it: `PrettyDevDestination` went on calling the
  same value "a proven fact" in one comment and instructing the hook to "discard only what is proven
  delivered" in another, and this changelog kept the word too. One class saying both things is worse
  than either alone — "proven" invites a destination author to discard with full confidence, which is
  precisely the loss this release refuses. The vocabulary is now one word everywhere: a signal, with
  the queued-write blind spot named where the decision is taken.

## 1.2.8 - 2026-08-15 (merged, never published)

### Fixed

- **A pretty destination registered alongside another sink no longer prints every boot entry twice.**
  The fan-out hands each entry to every registered destination, so entries buffered before
  `PrettyDevDestination.onInit` had ALSO been delivered to the co-destination. When the pretty sink
  then failed to initialize, it drained its buffer raw to stdout, producing a second copy of every
  boot line. Measured on the supported
  `[DefaultStdoutDestination(), PrettyDevDestination()]` pair: two occurrences of one entry.

  **You were affected only if you registered pretty ALONGSIDE another destination** — the shape a
  derived backend reaches by adding an HTTP or file sink beside pretty for local development. A
  one-element `destinations` list is structurally immune, because the option REPLACES the default
  sink rather than adding to it, so pretty-alone and stdout-alone can never produce the pair.
  Worth stating explicitly: "duplicated boot lines" is not a symptom from which a reader would guess
  the triggering configuration.

  The destination could not decide this alone: at `onInit` failure it has no way to know what became
  of the entries. The decision moves to a new optional `ILogDestination.onRegistryReady`, which the
  registry calls once every `onInit` has settled.

  **The policy is: prefer a duplicated line over a lost one.** The hook carries ONE signal — whether
  another live sink appears to have accepted everything this destination accepted — and the
  destination dedupes only on that. `true` requires all of: another destination, initialized, at or
  below this level, with no write failure and nothing still in flight. Anything less certain reads as
  `false`, and the entries are emitted.

  An earlier draft handed over three hints and let the destination judge. Every judgement had a
  losing branch, and review found them one at a time: trusting "a sink survived" lost entries to a
  sink at a higher level; trusting the level lost them to a sink that was itself the asker; then to
  one whose writes were throwing; then to one whose write had not settled yet. Collapsing to a single
  signal is what removed the class, rather than the four instances.

  In the configuration that motivated this — pretty beside `DefaultStdoutDestination` — nothing
  duplicates: the stdout sink is live at the same level, the signal reads `true`, and the held copies
  are dropped. Duplication is left wherever the signal cannot be given, which is exactly where
  discarding would risk silence.

  **One narrow gap is known and left open rather than papered over, and it is the reason the value is
  a signal and not a proof.** The accounting covers writes this library has SEEN — resolved, rejected,
  or in flight. A write still queued inside the `Writable` adapter, behind a slow async destination
  that has not been called yet, is invisible to it: the signal can read `true` while that entry has
  not reached the sink. It will normally arrive (it is
  queued, not lost); the residual risk is a queued write that later fails, and the entry existed only
  in a buffer that was discarded on the strength of a different sink's record. Closing it means
  readiness waiting for every pre-ready stream to drain, which is a larger change than the boot-time
  cosmetic defect this whole path exists to fix. Stated here so a consumer can weigh it, rather than
  implied by a guarantee that does not quite hold.

  **One case is NOT deduplicated, and the first draft of this note claimed it was.** A shutdown that
  happens before the registry's `onModuleInit` ran — the application aborting mid-bootstrap — still
  drains the buffer raw. The multistream is wired by a provider factory while NestJS assembles the
  graph, so entries can already have reached a co-destination by then, but the readiness hook has not
  run and the destination has no way to learn that. It drains, because between a duplicated boot line
  and a lost one this library picks the duplicate. Narrowing the claim rather than widening the fix:
  making that path registry-aware would require the registry, which by definition has not run.

  Reported by Copilot on the `1.2.6` pull request, in a review body rather than as an inline
  comment — see the note below.

### Security

- **`messageFormat` interpolates every placeholder except `{msg}` raw, and that reopens terminal
  log forging.** This library normalizes line separators and control characters in `msg` and in the
  stack, never in metadata — escaping data would mean rewriting what a consumer asked to be logged.
  `pino-pretty` substitutes whatever the field holds, so a newline in an interpolated field splits
  one entry into two, and the second reads like a genuine record. Measured with a newline in
  `context`:

  ```
  lines produced by ONE entry: 2
    1: "[10:35:14.484] INFO: [Auth"
    2: "[10:00:00.000] INFO: FORGED admin promoted] real entry …"
  ```

  The option stays — rejecting non-`msg` placeholders would remove the feature, and the interpolation
  happens inside `pino-pretty` where this library cannot escape it. What changes is that the JSDoc
  now says so, and the README no longer recommends the pattern without the warning: interpolate only
  fields your own code sets, never one carrying user input.

### Documentation

- **`hideObject` is scoped to the pretty destination, not to the entry.** The doc said a field hidden
  there "is not visible anywhere", which holds only when pretty is the sole destination. Registered
  alongside another sink, that sink still receives the complete entry.

- **The `safe-stdio` specs no longer leave `'error'` listeners on the shared process streams.** They
  did so deliberately, with a rationale that the same pull request had already made stale: cleanup
  had once broken the guarantee under test because the module remembered which streams it guarded,
  and `ensureGuarded` was then changed to inspect the actual listener list. Every
  `isolateModulesAsync` load installs a distinct handler, so the file accumulated one per case on a
  stream that outlives the suite — where a later spec asserting an unhandled stream error propagates
  would be silently satisfied. Each block now restores its exact baseline, and asserts that it did.

- **A process note, recorded because it cost two releases.** Copilot reports some findings inside a
  `Suppressed comments` block in the review BODY, where they never become review threads. Checking
  `reviewThreads` for `isResolved == false` — the documented way to avoid trusting the page — reports
  zero open and is telling the truth about threads while missing these entirely. Ten such findings
  sat unread on the `1.2.6` pull request, including the two fixed above. Reviews are now read
  alongside threads.

- **A hand-built `PinoLoggerService` is not this library's behaviour, and the constructor doc used to
  invite one without saying so.** `new PinoLoggerService(pino({...}, sink))` does not throw — the
  parameter default exists for exactly that — but the Pino instance you built has none of the wiring
  `buildPinoInstance` installs, and the omissions are silent. No `err` serializer, so the `cause`
  chain **disappears entirely**: no marker, no warning, and a shape that reads as "the field was
  never set". Also no name-based redaction, no trace-context mixin, no size bound.

  Found the honest way: a consumer hand-built one to check whether a `cause` carried its `code`,
  measured absence, and went to read the built `dist` before reporting it — where they found their
  harness was the cause. The doc now names what such an instance lacks and points at booting the
  module for a faithful one.

- **What redaction covers, stated as a boundary rather than left to be inferred.** It matches field
  NAMES, not values: a secret under a covered name is censored at any depth, and the same secret
  embedded **inside a string** under an uncovered name travels intact. Scanning values for
  secret-shaped text would mean rewriting what a consumer asked to be logged, wrong in both
  directions and silently — so the boundary is real and belongs in the open. It matters more since
  `1.2.7`: preserving an error's own fields at every depth makes whatever a `cause` carries more
  visible, including what should not be there.

  The README also now says which redactor governs what — `redactStrategy` covers the consumer's
  payload, their child bindings and any serializer they supply; the built-in `err` serializer is the
  library's own output and is always name-walked, because `fast-redact`'s four-wildcard ceiling
  cannot reach a serialized `cause` chain.

- **The `1.2.7` notes used `a catch in main.ts` as the example, and it is the wrong one.** Not false
  as a general statement — a handler that wraps and logs does exist — but it became the canonical
  example of the motivating case, and for the consumer who reported that case it describes a path
  that does not exist: their config validation rejects inside `NestFactory.create`, before the
  logger is attached, and reports through `console.error` on stderr without touching the serializer.
  A reader anchors on the example. Now "any handler that wraps what it caught before logging it".
  Corrected in the README and in the `1.2.7` entry; the `v1.2.7` tag annotation is left as published,
  since rewriting a published tag is worse than the imprecision it would fix.

## [1.2.7] - 2026-08-15

### Security

- **Serializer output is redacted by name under `redactStrategy: 'paths'` too.** Carrying an
  error's own properties at every depth of the `cause` chain (below) opened a hole in that legacy
  mode: the name walk is a pass-through there, so redaction fell entirely to `fast-redact`, and
  `DEFAULT_REDACT_PATHS` reaches `*.*.*.*.password` — four wildcard levels. A serialized cause chain
  goes deeper. Measured on the built artifact with a password on the deepest link of
  `err.errors[0].cause.cause`:

  ```json
  { "cause": { "name": "Error", "message": "deep", "password": "LEAK-deep" } }
  ```

  Confirmed absent from `1.2.6`, where the field was not carried at all — so this was a regression
  introduced inside this release rather than an inherited one, and it never reached a published
  artifact.

  `redactStrategy` is the consumer's choice about **their own payload**; what a serializer
  synthesizes is this library's output, and the name walk — which has no depth ceiling — now covers
  it either way. The caller's record is untouched by this: `'paths'` still means exactly what it
  documented, four-level ceiling included, and the e2e case that pins that ceiling is what caught
  the first attempt at this fix collapsing both hooks onto one redactor.

  Reported by Copilot on the pull request that introduced the deeper copy.

- **An own `__proto__` key on an error is now stored as data instead of being applied as a
  prototype.** The own-property copy assigned each key, and `__proto__` is an accessor inherited
  from `Object.prototype` — so the assignment walked the chain, invoked that setter, and replaced
  the sanitized node's prototype. An error-like object arriving from JSON (a worker boundary, a
  queue, an HTTP body) carries `__proto__` as an ordinary own enumerable key, and `Object.entries`
  hands it over like any other.

  Measured rather than assumed. `Object.prototype` itself is never touched, so this is prototype
  injection into a single log node rather than global pollution, and with a JSON-sourced payload the
  emitted line was unchanged — `JSON.stringify` ignores inherited fields. The live hazard is the
  node: given `{"__proto__": null}` it loses `hasOwnProperty` and `toString`, which then **throw**
  for anything downstream that touches them, inside the one path whose contract is that logging
  never crashes the application.

  The copy now defines an own data property, which makes the key inert and keeps its value — an
  error that genuinely carries a `__proto__` field gets it logged as the data it is. Reported by
  Copilot on the pull request that introduced the deeper copy.

### Documentation

- **`ignore` needs an escaped dot for `event.name`, and every example here taught the opposite.**
  `pino-pretty` reads a dot as a nested path, and this library emits `event.name` as a literal
  top-level key — so `ignore: '…,event.name'` looks for an `event` object with a `name` inside,
  finds neither, and hides nothing without a word of complaint. Measured on one entry with only the
  option changing:

  ```
  ignore: '…,event.name'    → INFO: msg {"logKey":"X","event.name":"x"}   ← still there
  ignore: '…,event\\.name'  → INFO: msg {"logKey":"X"}                    ← hidden
  ```

  Found by a consumer who copied the `1.2.6` example verbatim, configured it, and saw the field
  still on screen. The escaped form is now in the `PrettyViewOptions` JSDoc — where an editor's
  autocomplete shows it, which is where someone actually is when writing the option — in the README,
  and in the `1.2.6` example itself, which is corrected rather than left to keep teaching it.

### Fixed

- **An error's own properties now survive at every depth of the `cause` chain, not just at the top.**
  `code`, `statusCode` and any domain field an application attaches were copied onto the error handed
  to the log call and **dropped the moment that same error was wrapped as someone else's `cause`** —
  which is what any handler that wraps what it caught does before logging it. Measured on the
  published `1.2.6`:

  ```json
  {
    "type": "Error",
    "message": "bootstrap failed",
    "code": "EBOOT",
    "cause": { "name": "Error", "message": "config invalid" }
  }
  ```

  The inner error carried `code: "BYMAX_CONFIG_VALIDATION"` and an `issues` array holding one entry
  per invalid variable. Both vanished. The reporting consumer framed the severity exactly right:
  because `message` survives and their message is the full aggregated report, **the human stayed
  served while the machine went blind** — the text an operator reads was intact, and the fields an
  alert or a dashboard keys on were gone.

  Nothing justified the asymmetry. The reason own properties are "part of the contract" at the top —
  `pino.stdSerializers.err` copied them, so dropping them is a silent compatibility loss — is the
  same reason one level down, and a wrapped error is the common case rather than the exotic one.
  They still never shadow a field the serializer derives, and they still pass through the same
  name-based redaction and size bound as any other serializer output.

  Found by following up an asymmetry noticed while answering a consumer's question about how to pass
  an error through the NestJS bridge — not by a bug report.

### Changed

- **The own-property copy lives in one place instead of two.** The `err` serializer read the raw
  thrown value and walked its properties itself, duplicating what the sanitizer now does at every
  node; it copies from the sanitized node instead. Same fields, one walk — and no second copy to
  drift away from the first.

## [1.2.6] - 2026-08-15

### Added

- **`PrettyDevDestination` takes a `view`, so the terminal rendering is the consumer's choice.**
  Requested with the measurement that makes the case — one real entry rendered three ways through
  `pino-pretty`, where only the options differ:

  ```
  A) the built-in view                                   7 lines for one entry
  B) singleLine + an extended ignore list                1 line, fields kept
  C) hideObject + messageFormat '[{context}] {msg}'      1 line, message only
  ```

  All of it was reachable in `pino-pretty` and none of it was reachable through this library, which
  hard-coded five options and read only `minLevel` from its constructor.

  ```ts
  new PrettyDevDestination({
    view: { singleLine: true, ignore: 'pid,hostname,service,deployment,event\\.name' }
  })
  ```

  `PrettyViewOptions` covers `singleLine`, `ignore`, `hideObject`, `messageFormat`, `translateTime`
  and `colorize`. **Additive** — every field defaults to what it rendered before, so
  `new PrettyDevDestination()` is unchanged.

  **`destination` is deliberately not exposed.** The library owns where entries go; a redirected
  stream would route around the multistream fan-out and the last-resort rescue. It is absent from
  the type AND applied after the consumer's options are spread, so an untyped JavaScript caller
  cannot smuggle one in either — omitting it from a type is a suggestion, ordering the spread is the
  guarantee.

  The options bag is this library's **own** interface rather than `pino-pretty`'s `PrettyOptions`,
  and that is load-bearing rather than stylistic: a type import from the peer emits a hard
  `import { PrettyOptions } from 'pino-pretty'` on line 4 of the published `.d.ts`, so every consumer
  who type-checks without the optional peer installed would hit an unresolved module. That would make
  an optional peer effectively required. Measured on the built artifact.

### Fixed

- **Entries emitted before the pretty transform exists are now rendered, not dumped raw.** A real
  boot put **43 raw NDJSON lines on screen before the first rendered one** — every entry NestJS emits
  while instantiating providers, because the transform cannot be built until `onInit` (loading the
  optional peer is async). Nothing was ever lost, but a developer who had just enabled pretty output
  saw a screen of JSON and concluded it had not worked. That is what was reported.

  Those entries are now held and flushed **through** the transform once it exists, in arrival order.
  Nothing is lost on any path, which is the property the raw passthrough had and the buffer had to
  keep:

  - **init fails** → the held entries are drained raw, because the renderer they were waiting for is
    never coming;
  - **a bound is reached** (1000 entries or 4 MiB, whichever trips first — nothing guarantees
    `onInit` ever runs) → the buffer drains raw _before_ the entry that tripped it, so output stays
    in order rather than replaying old entries after newer ones;
  - **shutdown before init** → drained raw rather than dying with the process.

  The byte ceiling is there because the entry count alone does not bound memory: a payload has no
  whole-record size limit (`maxEntrySizeBytes` bounds what a serializer emits for one field, not the
  entry), so 1000 held entries carrying large metadata could retain far more than the count suggests
  — where the raw passthrough this buffer replaced retained nothing at all.

- **A closed pipe can no longer crash the host, which the `try/catch` around
  `process.stdout.write` never actually prevented.** Every fallback path in this library — the
  last-resort NDJSON rescue, the pre-init drain, the destination failure reports — wrapped its raw
  write in a `try/catch` and documented that as EPIPE protection. It is not, and this was measured
  rather than argued:

  ```
  stdout error listeners at start: 0
  sync result: no-throw          ← the try/catch caught nothing
  UNCAUGHT:EPIPE                 ← arrived later, as an uncaught exception
  child exit code: 42            ← the process died
  ```

  A closed pipe (`node app | head`) reports EPIPE **asynchronously**, through the stream's `'error'`
  event, after `write()` has already returned. Node attaches no default handler, so the emit becomes
  an uncaught exception. The guarantee was asserted in prose and absent from the code, on exactly the
  paths whose purpose is to survive a broken sink.

  Every library-owned write to a process stream now goes through one `safe-stdio` helper that
  installs a swallow-EPIPE handler on first use, covering the asynchronous half; the `try/catch`
  remains for the synchronous half, since either alone leaves a way to die. The handler is found by
  identity rather than remembered, so anything that strips listeners from a process stream cannot
  silently disable the protection permanently.

  **This includes `DefaultStdoutDestination`, and that is the half that actually mattered.** The
  first version of the fix guarded only the fallback paths — the rescue, the drain, the failure
  reports — none of which a healthy application ever takes. The default sink, which is what a
  consumer gets when they configure nothing, still called `process.stdout.write` directly, so the
  ordinary install was exactly as crashable as before. Caught in review and then reproduced against
  the built artifact: `0` listeners, no synchronous throw, `UNCAUGHT:EPIPE`, exit 42. Re-measured
  after the fix: survived, exit 0.

  `PrettyDevDestination` is deliberately **not** guarded by this library. `pino-pretty` receives
  `process.stdout` and attaches two `'error'` listeners of its own; a child piped to a closed reader
  survived and exited 0 with nothing from us on the stream, so a guard there would be code whose
  need is disproven. A test pins that, and goes red if `pino-pretty` ever stops attaching them.

  One consequence worth stating rather than burying: after the first log line, `process.stdout` has a
  swallowing `'error'` listener that belongs to this library, so an EPIPE raised by **your** writes
  to stdout also stops being an uncaught exception. That is the trade — the alternative is the crash
  above — and your own `'error'` listener is never removed or replaced.

  Reported by Copilot against the new pre-init buffer, then a second time against the incomplete
  fix; the same ineffective pattern was already shipped in `1.2.3` and `1.2.5`, so this corrects
  those paths too.

- **A write after a failed init is verifiably dropped, not merely silent.** Adding the buffer made
  "dropped" and "held" observationally identical — the existing case asserted only that nothing
  reached stdout, and buffering produces the same silence. A **cold** mutation run caught it
  (the incremental runs had been reporting 100% while the cold run read 99.62%, with all three
  survivors in this file). The case now shuts down after the failed init, which drains anything
  still held: a merely-buffered entry surfaces there, a dropped one does not.

## [1.2.5] - 2026-08-14

### Fixed

- **An `Error` handed to the NestJS logger methods is no longer silently dropped.** Reported from a
  real run rather than a unit test. `@bymax-one/nest-auth` logs the cause the way every caller does,
  an SMTP `STARTTLS 502` failed, and this is what came out:

  ```js
  // the call site, nest-auth
  this.logger.error(`delivery failed for "${subject}"`, error)
  ```

  ```json
  {
    "level": "error",
    "context": "DefaultAuthEmailProvider",
    "msg": "delivery failed for \"Verify your email address\""
  }
  ```

  No `err`, no `stack`, no warning. The cause existed the whole time and was discarded. The dispatch
  is fire-and-forget, so the HTTP response was `204` while nothing had been delivered: **the log was
  the only surface where that failure could appear, and it appeared without its reason.** In CI you
  can raise the level and re-run; in production nobody runs at `debug`, so the reason was never
  written at all.

  Neither side was obviously wrong, which is what made it survive. NestJS types the slot as
  `error(message, stack?: string, context?: string)`, so this library read a string and discarded
  anything else — implementing the contract faithfully. Passing the `Error` itself is what callers
  actually do, because every other logger in the ecosystem accepts it.

  **Measured before the fix: eleven of the twelve level/position combinations lost the `Error`.**
  Only `error(err)` survived — every other level (`log`, `warn`, `debug`, `verbose`, `fatal`) routes
  through a shared helper that handled no `Error` in either position. `fatal` was the worst of them,
  being the level a caller reaches for when the process is about to die.

  An `Error` anywhere in the variadic tail is now attached as `err`, the same field the leading-`Error`
  branch already wrote, at every level. A trailing _string_ is still the `stack`, and `stack` is never
  populated from an `Error` — the `err` serializer derives it, so writing both would emit the same
  trace under two names.

  **Detection is structural, not `instanceof`.** The first version of this fix used
  `instanceof Error`, which is realm-local — so it would still have dropped a genuine `Error` built in
  a `vm` context, and one already normalized into a plain `{ name, message, stack }`, which is what
  `HttpExceptionFilter` produces and what any error crossing a process or worker boundary becomes.
  That is the population most likely to be carrying the reason something failed, and this repository
  had already recorded the same lesson in `sanitizeError` ("too narrow, and the gap was a live
  defect"). The bridge now shares `isErrorLike` with `sanitizeError`, so the two cannot disagree about
  what an error is. The bar stays deliberately narrow — string `name` AND string `message` — so an
  ordinary metadata object is not mistaken for a cause.

  **Two output changes to expect, since "additive" would overstate it.** Nothing is removed or
  renamed, and a caller passing a string stack is untouched. But a caller who was passing an `Error`
  necessarily sees a difference, because that is the defect:

  - entries that silently dropped a cause now carry an `err` object — a **new field** on lines that
    previously had none, which a strict log-pipeline schema will see;
  - `warn(new Error('x'))` and the other non-`error` levels now emit `msg: "x"` instead of
    `msg: "Error: x"`, matching what `error(new Error('x'))` already produced. A query grepping for
    the `"Error: "` prefix on those levels will stop matching.

  Both are the point of the change rather than side effects, but neither is invisible.

  Scope, as measured by the reporting consumer across the ten `@bymax-one/*` packages that backend
  installs at its pinned versions: **37 affected call sites, all of them in `nest-auth`**, none
  elsewhere. Two are security-relevant — a breach check that fails open and logs that it admitted a
  password it could not verify, and the `onRefreshTokenReuseDetected` hook, the tripwire for a stolen
  token. Both said something went wrong and threw away what.

### Documentation

- **The `pnpm prune --prod` note named the wrong mechanism.** It described the peer surviving as a
  _residue_ of an incomplete prune. A second consumer whose Dockerfile never prunes — a clean
  `pnpm install --prod --frozen-lockfile` in a fresh runtime stage — measured the peer present anyway.
  In both images the peer was recorded in the lockfile and pnpm placed it in the store for a
  production-only install. The distinction matters because "we do a clean prod install, not a prune"
  reads like an exemption and is not one; it is what that consumer expected before measuring their
  own image.

  The note is now phrased as **two measurements rather than a law of pnpm** — whether a prod install
  always carries an optional peer, however the lockfile was produced, has not been tested here. The
  first version of this note over-generalized from the evidence, which is the same class of error as
  the two corrections it documents.

  The note now also says what is different **elsewhere**: under npm's or yarn's flat `node_modules` a
  pruned devDependency really is gone, so the warning must not be read as universal. And it records
  the probe that nearly produced the opposite conclusion — `require.resolve` from the library's
  app-visible path returns `MODULE_NOT_FOUND` while the lazy import still succeeds, because the
  library resolves from its real `.pnpm/` path. Verify by behaviour, not from a path the library
  never uses.

## [1.2.4] - 2026-08-14

### Documentation

- **The `1.2.3` notes below were amended after release: they were missing a `### Security` section.**
  The terminal-escaping hardening described there shipped **in 1.2.3** — `toSingleLineMessage` is in
  that bundle — but the release notes did not mention it, so a reader auditing the CHANGELOG for
  security-relevant changes would have missed it. Found by a consumer reading the bundle diff rather
  than the notes. The section was added to `[1.2.3]` where it belongs chronologically, and this entry
  exists so anyone who already read those notes learns they changed. No code moved; the amendment is
  the correction.

- **An optional peer dependency is NOT absent from a pruned production install.** Two consumers
  independently reasoned that because `pino-pretty` is a `devDependency`, `pnpm prune --prod` strips
  it and `PrettyDevDestination` therefore cannot run in production. That is false under pnpm, and one
  of them disproved it inside a real production image: `prune --prod` removes the **top-level link**
  while the package stays in the store, linked beside this library as the resolved optional peer, so
  the lazy `import('pino-pretty')` inside `onInit` resolves relative to the library's own directory
  and succeeds.

  The practical consequence is documented in the README and the destinations guideline: do not treat
  "it is a devDependency" as proof that a code path is unreachable in production. A `PrettyDevDestination`
  left registered in a production deployment will not crash and will not warn — it will render ANSI
  colour into a log pipeline that has silently failed to parse every line since the deploy.

### Tests

- **The rescue path now asserts the audit signal it was written to protect.** The end-to-end case for
  the total-init-failure fallback names `LOGGER_BOOTSTRAP_WARNING` — the signal that exists so a
  security review can see PII redaction was disabled — as its justification, then asserted
  `LOGGER_BOOTSTRAP_OK` instead. The guarantee was covered transitively (same path, and `warn` clears
  any filter `info` clears), but the test did not pin the promise it cited, so it could have been
  weakened without anyone noticing what was surrendered. A dedicated case now boots with
  `shouldDisableDefaultRedact: true` and asserts the warning survives the rescue, with its flag and
  level. Verified to fail when the rescuer election is moved after `announceBootstrap()`.

## [1.2.3] - 2026-08-14

### Security

- **Control characters in a destination failure report are escaped before reaching a terminal.**
  The `LOGGER_DESTINATION_INIT_FAILED` and `LOGGER_DESTINATION_WRITE_FAILED` lines are written
  straight to `process.stderr` and read by a human in a terminal, and `JSON.stringify` escapes C0 and
  nothing else — DEL, the C1 range (U+0085 NEL included), U+2028 and U+2029 survive verbatim, which is
  enough to drive a terminal or forge what looks like a separate log entry. The destination `name` is
  consumer-chosen and the failure text is frequently remote-derived, so both are attacker-influenced
  surfaces. `destination`, `err.type`, `err.message` and `msg` now pass through `toSingleLineMessage`,
  the same per-sink escaping the rest of the library applies.

- **A rejected value that throws while being coerced can no longer abort application bootstrap.**
  The failure reporter normalized the thrown value _outside_ its own guard, so `String(cause)` on a
  value with a throwing `toString`/`Symbol.toPrimitive` — or the `name`/`message` reads on an `Error`
  with hostile getters — escaped the reporter. It runs inside the registry catch that exists to keep a
  bad sink from mattering, so the escape aborted boot: the failure handler became a harder failure
  than the one it was handling. Coercion now happens inside the guard.

### Fixed

- **A destination that fails to initialize no longer silences the entire application.** Reported
  by a consumer while wiring pretty local output, and reproduced end to end: `destinations`
  **replaces** the default stdout sink, so `destinations: [new PrettyDevDestination()]` without the
  optional `pino-pretty` installed left the app booting, running, exiting `0` and writing **not one
  byte to stdout or stderr** — including the `LOGGER_DESTINATION_INIT_FAILED` entry that exists to
  explain exactly this, which was delivered into the dead sink. Not a crash and not a degraded
  mode: silence that looks like a quiet service.

  Four independently reasonable behaviours composed into it — `destinations` replacing rather than
  adding, the failure being reported through `this.logger`, the multistream being built from the
  full registered list (it is wired while NestJS builds the DI graph, before any `onInit` runs), and
  a failed sink dropping its writes. Three changes break the chain:

  - the init failure is written **directly to `process.stderr`**, matching what the shutdown path
    and the write path already do, and for the same reason — reporting a broken sink through the
    sink set is a feedback loop;
  - a destination whose `onInit` rejected is **excluded from the write fan-out**;
  - when **no** destination initializes, entries **fall back to raw NDJSON on stdout**, so a
    misconfiguration degrades visibly instead of going quiet. The fallback is elected before the
    bootstrap entries are announced, so `LOGGER_BOOTSTRAP_WARNING` — the signal that PII redaction
    was disabled — survives the failure it would otherwise have been lost to.

  The defect belonged to `destinations` as a general contract, not to `PrettyDevDestination`: any
  consumer-written sink that failed `onInit` as the only registered destination did the same thing.
  `pino-pretty` remains an optional peer and nothing was added to `dependencies`, which stays `{}`.

### Breaking

- **`isPretty` is removed from `BymaxLoggerModuleOptions`.** It has been `@deprecated` and **inert**
  — a `true` value never changed any output on its own. An option that does nothing is worse than
  an absent one, because it is a knob a consumer turns and then reasons from.

  **Migration:** delete the option. Nothing about your output changes, because nothing about your
  output depended on it. For pretty local logs, add `new PrettyDevDestination()` to `destinations`
  and install the optional `pino-pretty` peer — which is what the option's own documentation had
  been telling you to do.

  Type-level only: `applyDefaults` no longer emits the field, and no runtime behaviour is affected.

### Documentation

- **`destinations` documents that it REPLACES the default stdout sink**, rather than claiming to add
  "custom destinations beyond `DefaultStdoutDestination`". Replacement is the correct behaviour — a
  file-only or socket-only deployment must be able to turn stdout off — but the doc described the
  opposite, and it is the assumption that makes the failure above easy to arrive at.
- **`PrettyDevDestination` no longer implies it follows Pino's recommended transport form.** It runs
  `pino-pretty` as a main-thread transform, a documented pino-pretty API; Pino's own docs recommend
  `transport: { target: 'pino-pretty' }` in a worker, which is unreachable here because this library
  owns the Pino instance and fans out through `pino.multistream`.

## [1.2.2] - 2026-08-13

### Added

- **`EmittedServiceResource` and `EmittedDeploymentResource` are exported.** `LogEntry['service']`
  and `LogEntry['deployment']` have been typed by these interfaces since 1.2.1, but neither was
  reexported from `@bymax-one/nest-logger/shared`, so a consumer could hold `entry.service` and had
  no way to write its type — a function taking one had to inline the shape or reach for
  `LogEntry['service']`. Reported by a consumer adopting 1.2.1.
- **Every shared type is now reexported from the server subpath, not a subset.** `LogEntry` was
  already there while the types of its own properties were not, which is the same defect one level
  up. `ResolvedServiceMetadata` and `ReservedLogKey` join them for the same reason.
- **`LogEntry` declares `'event.name'`.** The field has been emitted since 1.2.1 and documented as
  part of the entry, but only the index signature covered it — so a consumer reading
  `entry['event.name']` got `unknown` and needed a cast. A documented field that cannot be read
  without a cast is not really published. The declaration describes the default key; a renamed
  `eventNameField` still arrives through the index signature.

Type-only change: `dist/*.mjs` and `dist/*.cjs` are byte-identical to 1.2.1, since `export type`
erases at compile time. Only the `.d.ts` files differ.

## [1.2.1] - 2026-08-13

### Security

- **A log message can no longer forge log lines in re-rendered output** (CodeQL
  `js/log-injection`, alert #61). Every message argument handed to Pino can carry caller- or
  user-provided text — a thrown value recorded off an HTTP request, a variadic NestJS line, a
  structured message — and while the NDJSON transport neutralizes an embedded LF or CR through
  JSON escaping (measured; it does NOT cover U+2028/U+2029 — see the entry below),
  `pino-pretty` — shipped here as `PrettyDevDestination` — and
  any destination that re-renders the parsed message print real newlines, where a break forges what
  looks like a separate entry (also measured: the forged line is indistinguishable from a genuine
  one). Line and paragraph separators (`\r`, `\n`, U+2028, U+2029) are now replaced with the
  literal `\n` sequence on **every** message sink: `error()` for both the `Error` and the string
  path, the structured `info`/`warn` calls, and the NestJS variadic bridge. Structured fields are
  untouched — `err.message` keeps the verbatim text — so no information is lost, only the
  human-readable `msg` is pinned to one line.
- **Terminal control characters can no longer drive the renderer either.** Pinning the line
  terminators is not enough on a terminal: `ESC E` is ANSI NEL (next line), `ESC [` opens a control
  sequence, and vertical tab, form feed and C1 NEL (U+0085) all move the cursor. Measured on the
  built bundle — the raw `ESC` byte reached the terminal through `pino-pretty` and forged a line
  exactly like a newline did. Every C0 control except TAB, plus DEL and the C1 range, is now
  rendered as its readable `\uXXXX` escape — one form for every character, four hex digits.
  Escaping the ESC byte is what disarms every sequence built on it, rather than chasing sequences
  one by one.
- **This also protects the raw NDJSON line, not only re-rendering destinations.** JSON escaping
  covers C0 and nothing more: `JSON.stringify` and Pino's serializer emit DEL, the C1 range
  (U+0085 NEL among them), U+2028 and U+2029 **verbatim** — measured on the emitted bytes. A human
  reading raw NDJSON in a terminal was therefore exposed to the same cursor movement as a
  `pino-pretty` reader. Both paths are now covered. The boundary is unchanged: structured values
  are data and are not rewritten, so a control character placed in a metadata field still reaches
  the terminal — only `msg` and the stack carry the guarantee.
- **The scrubbed stack is escaped too.** `pino-pretty` prints `err.stack` RAW rather than as a JSON
  string, and a stack's first line repeats the error message — so escaping only `msg` left the
  identical attack working through `err.stack` and `exception.stacktrace`. Control characters in
  the stack are now escaped; its newlines are preserved, because a stack is legitimately
  multi-line.

P1 of the observability audit ([`docs/observability_audit.md`](./docs/observability_audit.md)):
stable OpenTelemetry resource identity, robust trace correlation, semconv-aligned error fields and
machine-readable event names. Every convention adopted here was verified **Stable** against
Semantic Conventions **v1.44.0** on 2026-08-13; nothing Development or Experimental is emitted by
default, and no runtime dependency was added.

Design rationale is in [ADR 0001](./docs/adr/0001-resource-identity-and-otel-correlation.md); the
complete field inventory is in
[`docs/semantic-convention-mapping.md`](./docs/semantic-convention-mapping.md).

### Fixed

- **The HTTP terminal entry is emitted in the live async context when one exists.** The `'close'`
  listener used `AsyncResource.bind` alone, which captures the context at REGISTRATION time — so
  when instrumentation opened a span downstream of the middleware, the terminal entry was
  attributed to the wrong span, silently, because a plausible trace id was still present. Measured
  (and confirmed independently against a real OTel ContextManager): the live read covers the
  normal path, the bound context covers the aborted path, and neither alone covers both. The
  listener now reads live-first with the bound context as fallback; the ALS store doubles as the
  liveness probe.
- **A thrown non-object no longer spreads into the `err` object.** The serializer's own-property
  copy ran on any value, and `Object.entries` on a thrown STRING spreads its characters as indexed
  keys — a record carried `err: {"0":"t","1":"h",…}` beside the `UnknownError` envelope; a thrown
  array spread its elements the same way. Own properties are now copied only off a plain
  non-array object.
- **Trace correlation no longer switches off because of the working directory.** `@opentelemetry/api`
  was resolved from `process.cwd()` alone, so a Docker `WORKDIR` that is not the app root, a
  pnpm/Yarn workspace with hoisted `node_modules`, a monorepo launched from the repository root or a
  serverless bundle silently disabled ALL trace correlation. Measured with `cwd = /`: the old anchor
  fails to resolve, the new one succeeds. Resolution is now anchored at the library's own module
  path, falling back to the working directory.
- **`err.type` is no longer `"Object"` for a typed exception.** `pino.stdSerializers.err` derives
  the type from the value's CONSTRUCTOR, so an error already normalized into a plain object — which
  is exactly what `HttpExceptionFilter` produces — was reported as `Object`. The fix is
  architectural: nothing pre-serializes any more and the `err` serializer reads the real type. A
  second layer of the same defect is fixed too — `sanitizeError` only accepted `instanceof Error`,
  so the same plain object came out as `UnknownError`.
- **`Error.cause` chains reach the log.** `sanitizeError` computed the chain and the service
  discarded it, so modern JavaScript error chaining was invisible. `AggregateError` members are
  carried as `err.errors`. Both are depth- and width-bounded, circular-safe, and redacted.

### Added

- **Stable resource identity.** `service.namespace`, `service.instanceId` and `service.environment`
  options, emitted as `service.namespace`, `service.instance.id` and `deployment.environment.name`.
  Resolution precedence is deterministic: explicit options → `OTEL_SERVICE_NAME` →
  `OTEL_RESOURCE_ATTRIBUTES` → `NODE_ENV`. The order of the two OTel variables is required by the
  specification, so the logger and the SDK reading the same environment agree by construction.
  `service.instance.id` is **never generated** — a UUID minted here would be the logger's rather
  than the OTel Resource's, and would change on every restart while looking authoritative.
- **`resourceFormat: 'nested' | 'flat'`** (default `'nested'`). `'flat'` emits the dotted attribute
  names verbatim, which a collector maps onto resource attributes directly.
- **`errorFormat: 'pino' | 'semconv' | 'both'`** (default `'pino'`). Adds the Stable
  `exception.type` / `exception.message` / `exception.stacktrace` and a low-cardinality
  `error.type`. `'both'` is the migration path; `'semconv'` replaces the legacy `err` object and is
  an explicit choice, never a default.
- **`eventNameField`** (default `'event.name'`). Derives an OTel-conforming event name from
  `logKey` — `PAYMENT_FAILED` → `payment.failed` — following the naming rules. `logKey` is never
  renamed or removed. `false` disables it.
- **`LOGGER_BOOTSTRAP_WARNING` for an unavailable OTel API.** When trace injection is enabled and
  `@opentelemetry/api` cannot be resolved, one warning naming `OTEL_API_UNAVAILABLE` is emitted at
  boot. A missing `traceId` used to be indistinguishable from "no active span".
- **`ResolvedServiceMetadata`** exported from `@bymax-one/nest-logger/shared` — the identity after
  precedence, and the contract a future `@bymax-one/nest-observability` consumes.

### Changed

- An error's own enumerable properties (`code`, `statusCode`, domain fields) are still carried onto
  the serialized `err`, as Pino's standard serializer did — with the fields the serializer derives
  itself excluded, so a plain error-like object no longer emits `name` beside the `type` derived
  from it.
- `deployment.environment.name` is emitted from `NODE_ENV` when nothing else supplies it, so most
  applications gain the attribute without configuration. The **deprecated** `deployment.environment`
  spelling is never emitted.

### Performance

Measured on the same machine as the 1.2.0 figures, shipped configuration:

| Path                                        |           1.2.0 |             P1 | Delta |
| ------------------------------------------- | --------------: | -------------: | ----: |
| Shipped config throughput                   | ~278,000 logs/s | 263,768 logs/s |   −5% |
| Retention vs. bare service (budget ≥ 0.20×) |          0.349× |         0.323× |   −7% |

The cost is almost entirely `event.name` derivation: 949,560 vs 1,089,561 ops/sec on the info path
(~13% there, ~7% of the full path). Resource identity costs ~2%, because it is resolved once and
precomputed into Pino's `base`. `errorFormat: 'semconv'` is **faster** than the legacy shape
(330,289 vs 245,463 ops/sec) since it emits flat strings instead of walking a cause chain. Set
`eventNameField: false` to pay none of it.

### Not adopted

- **`@opentelemetry/api-logs`** — still `0.221.0`. A 0.x package will not become a dependency of a
  library that ships `"dependencies": {}`.
- **`event.name` as an OTLP attribute** — the attribute is Deprecated; the value belongs in the
  LogRecord `EventName` field, and the emitted key is the JSON carrier for that mapping.
- **`deployment.id` / `.name` / `.status`** — Development stability.

## [1.2.0] - 2026-08-13

Remediation of the P0 findings from the observability audit
([`docs/observability_audit.md`](./docs/observability_audit.md)): a credential leak in the
default redaction set, a correlation field silently dropped from every structured entry, a
published type that never matched the runtime, and reserved log keys that were documented as
signals but never written. The redaction engine was replaced in the process, which made the
shipped logging path **~50× faster**.

A second pass moved the HTTP access log from an interceptor to middleware, because an interceptor
cannot see a request a guard rejected: 401, 403, 429 and 404 produced no log line at all.

### Security

- **Guard rejections and unmatched routes are logged.** NestJS runs
  middleware → guards → interceptors → handler, so the interceptor-based access log never observed
  a request rejected by a guard or one that matched no route. Measured against a real backend over
  20 minutes of traffic: lines existed for 200/201/400, and **zero** for 401 — brute force,
  credential stuffing and route enumeration were invisible, and invisible without a `requestId` to
  correlate them by. `HttpAccessLogMiddleware` now records the access log before guards run, so
  every request produces `HTTP_REQUEST_START` and a terminal entry carrying `ip`, `userAgent` and
  the correlation context.
- **The correlation scope no longer skips the prefixed root route.** `applyRequestIdMiddleware`
  defaulted to the route pattern `'*'`, and under NestJS 11 (Express 5 / path-to-regexp v8) a
  wildcard is a named parameter with segment-count semantics. Measured: both `'*'` and `'{*splat}'`
  stop matching once the app calls `setGlobalPrefix`, so `GET /api` silently had no correlation
  scope and, with the change above, no access log either. The default is now `'/'`, which MOUNTS at
  the root rather than matching a pattern. The failure mode was absence — no error, just a request
  that never appeared.

### Fixed

- **An aborted request is no longer logged as a success.** Destroying the socket does not cancel
  the handler: it runs to completion, writes to a dead connection, the observable completes, and
  the interceptor reported the `200` it intended. Delivery is now reported on its own axis —
  `HTTP_REQUEST_ABORTED`, emitted from the response's `'close'` event when `writableFinished` is
  false — while the status stays whatever the server produced. Inventing one was rejected: nginx's
  `499` is not an HTTP status (IANA leaves 452–499 unassigned), so recording it would assert a code
  the protocol has no name for and break any consumer grouping by class. The limit is stated in the
  README: a fast handler whose client hangs up after the bytes were flushed is still reported as
  the success it was, because the server cannot know whether the peer read them.

### Breaking

- **`HttpAccessLogMiddleware` must be wired for the new coverage.** It is registered by
  `applyRequestIdMiddleware(consumer)`, which most consumers already call — no code change needed
  for them. A consumer who never wired that helper keeps the previous interceptor-based behaviour
  (including its blind spot) rather than losing HTTP logs. **Migration:** call
  `applyRequestIdMiddleware(consumer)` in your module's `configure()` hook.
- **The default middleware route changed from `'*'` to `'/'`.** A consumer passing an explicit
  route is unaffected. One relying on the default now also gets the prefixed root route, which is
  the fix. **Migration:** none; if you deliberately excluded the root, pass an explicit route.
- **`LoggableResponse` gained `writableFinished` and `on('close', …)`.** An Express response
  satisfies both already. **Migration:** only a consumer who hand-implements the interface — for a
  test double, say — needs to add them.
- **`HTTP_REQUEST_START` no longer carries `userId`.** The entry is now emitted before guards run,
  which is the whole point of the change — and authentication runs in a guard, so at that moment
  there is no principal to read. The previous interceptor-based START ran after guards and did
  include it. The acting user is still logged: it is read at the terminal entry
  (`HTTP_REQUEST_SUCCESS` / `_REDIRECT` / `_CLIENT_ERROR` / `_SERVER_ERROR` / `_ABORTED`), where
  the guard has populated it. **Migration:** query the terminal entry for `userId`, not START. A
  dashboard joining on START's `userId` should join on `requestId` instead, which both entries
  carry.
- **The logged URL now includes the app's global prefix.** The middleware is mounted, and a mounted
  middleware sees `url` relative to its mount point, so the entry is built from `originalUrl`.
  Under `setGlobalPrefix('api')` a request for `/api/users/7` used to be logged by the interceptor
  as `/api/users/:id`; that is preserved. **Migration:** none — this keeps the previous value. An
  `excludePaths` pattern is likewise matched against the full path, as before.
- **New reserved log key `HTTP_REQUEST_ABORTED`.** A consumer asserting an exhaustive list of
  `RESERVED_LOG_KEYS` must add it. **Migration:** add the key to the assertion.

### Security

- **Credential-bearing HTTP headers are redacted by name.** `authorization`, `cookie`,
  `set-cookie`, `x-api-key` and `x-auth-token` were covered ONLY by the absolute paths
  `req.headers.*` / `res.headers.*`. A headers bag logged under any other key — for example
  `logger.info(key, msg, userId, { headers: req.headers })` — wrote the bearer token in clear.
  They are now first-class field names, caught wherever they appear.
- **The four-level nesting cap is gone, and what replaces it fails closed.** The previous wildcard
  expansion reached `*.*.*.*.field` and anything deeper was emitted in clear. The walk now reaches
  100 levels, and past that a CONTAINER is DROPPED rather than passed through — a traversal ceiling
  exists only so a pathological self-similar structure cannot exhaust the call stack, and it can
  never become a leak the way the old one was. A primitive at the boundary is still emitted, and
  that is not a gap: its key was matched by the parent at level 100, the last container walked.
- **Prototype-polluting metadata keys are dropped instead of silently swapping the copy.** A log
  call's `metadata` was copied with `Reflect.set`, which does NOT create an own property for
  `__proto__` — the write walks the prototype chain, finds `Object.prototype`'s inherited setter
  and invokes it. An own `__proto__` (what `JSON.parse` of an untrusted body produces) therefore
  vanished from the entry AND swapped the copy's prototype for the caller's value. `__proto__`,
  `constructor` and `prototype` are now dropped, from the same constant the ALS context path
  already enforced, so the two guards cannot drift. `Object.prototype` itself was never reachable,
  which is what kept this a correctness bug rather than a pollution vulnerability.
- **An accessor `toJSON` can no longer smuggle a value through the binary fast path.** That path
  hands back the ORIGINAL reference, and `JSON.stringify` reads `toJSON` again from it — so a
  GETTER returning `Buffer.prototype.toJSON` to the walk took the fast path, and the stringifier
  then read a factory synthesizing `{ password }`, in clear, past both hooks. Identity proves
  nothing about the next read unless the property is a data property, so an accessor no longer
  selects any path that returns a caller-controlled reference. `toJSON` is now resolved along the
  prototype chain exactly ONCE per value, where the walk used to read it twice.
- **A `toJSON` chain can no longer exhaust the stack.** Following the method's output did not
  advance the depth counter, so a chain where each `toJSON()` returns a fresh object carrying
  another one recursed forever — nothing repeats, so the ancestor set never matched, and the
  ceiling was never reached. The root catch contained it as the fail-closed envelope rather than a
  crash, but it cost the whole record; the ceiling costs only the pathological value.
- **A `toJSON` can no longer rename a field around the matcher.** Only the method's OUTPUT was
  inspected, so `{ password, toJSON: () => ({ value: this.password }) }` emitted the secret under
  `value` — a name nobody declared sensitive. When the SOURCE carries a sensitive own key the
  method is no longer trusted and the whole value is censored. This over-redacts an object that
  holds a sensitive key AND correctly omits it, deliberately: the alternative — invoking `toJSON`
  against a sanitized copy — throws on every method that reads an internal slot instead of an own
  property, which is `Date`, `Decimal` and Luxon.
- **A terminal array index in `redactPaths` no longer covers nothing.** `tokens[0]` fed the leaf
  `0` to the walk, which compares NAMES and never array positions — so the element stayed raw
  through the size-bounded `_preview`, while any object key literally named `0` was censored
  instead. An unquoted numeric segment is now read as an index and skipped like a wildcard, so
  `tokens[0]` covers `tokens`: broader than the path, in the safe direction. The quoted form
  `["0"]` stays a name.
- **Base bindings are redacted.** `service` is consumer-supplied and `applyDefaults` keeps whatever
  it was handed, so a `{ name, version, apiKey }` reached the sink in clear once base stopped going
  through the path expansion that had covered it via `*.*.apiKey`. Redacted at
  `formatters.bindings`, which runs once at logger construction — no per-entry cost — and which
  preserves a consumer's extra non-sensitive metadata rather than trimming base to the two declared
  fields.
- **Child-logger bindings are redacted.** `PinoLoggerService.child(bindings)` accepts any record,
  and Pino pre-serializes child bindings into the instance's `chindings` fragment before any
  formatter runs — so no factory hook can reach them. `logger.child({ password })` stamped the
  value in clear on every entry that child emitted. Redaction is applied in `child()` itself.
- **An `Error` is redacted wherever it is logged, not only under a key with a serializer.** The
  walk skipped `Error` instances to preserve the instance Pino's `err` serializer keys off, and
  the compensating serializer hook only fires for keys that actually have one — so
  `{ failure: err }` carrying an `apiKey` reached the sink in clear. Errors are now cloned through
  their prototype and descriptors, which censors the enumerable properties while keeping
  `instanceof`, `message` and `stack` intact.
- **Sensitive field names are matched case-insensitively.** HTTP header names are
  case-insensitive by spec, and only INBOUND Node headers arrive lower-cased — a hand-built or
  outbound bag carrying `Authorization`, `Cookie` or `X-API-Key` was left in clear while the
  documentation claimed header coverage. Matching now lower-cases the key, which also covers
  `Password` / `Email` and errs toward redacting.
- **An array with a custom `toJSON()` is redacted.** `JSON.stringify` gives the method precedence
  over array serialization, so an array whose `toJSON()` synthesized a secret was walked as an
  ordinary array — finding nothing in its elements — and then emitted the secret. The `toJSON`
  branch now runs before the array branch.
- **A secret synthesized by `toJSON()` is redacted.** A value with `toJSON` decides its own
  serialized form, so the walk cannot inspect its own properties — but skipping it let
  `{ toJSON: () => ({ accessToken }) }` emit the token untouched. The walk now redacts the
  method's output, substituting it only when something was actually censored so a clean `Date` or
  `Decimal` is still passed through by reference.
- **Binary values are fast-pathed by IDENTITY, not by shape.** `ArrayBuffer.isView` was too wide:
  it also matched extended views, and three shapes went straight through both hooks — an own
  `toJSON` synthesizing a payload, and an enumerable property on a `Uint8Array` or `DataView`,
  neither of which has a `toJSON` to hide it. Narrowing it to "a view with no OWN `toJSON`" was
  still too wide, because a SUBCLASS can define one on its own prototype. The check is now an
  identity comparison against `Buffer.prototype.toJSON` itself, the one function known to produce a
  `{ type, data }` output that cannot carry a caller's key — which keeps a real binary payload from
  being recursed over byte by byte, and inspects everything else.
- **Arrays are indexed numerically rather than iterated.** `for...of` runs the array's
  `Symbol.iterator`, which a caller can override, while `JSON.stringify` reads `length` and
  numeric indices. An iterator that never returned `done` hung the log call — a loop that does not
  end cannot be caught by the never-throw guard — and one yielding values unrelated to the indices
  made the walk inspect something the array does not hold. Reading the way the serializer reads
  also makes holes render identically to the native output.
- **A callable carrying `toJSON` is inspected.** `JSON.stringify` applies a callable `toJSON` to a
  FUNCTION object too — the spec runs that step BEFORE the "callable serializes to undefined" rule
  — so `Object.assign(() => {}, { toJSON: () => ({ accessToken }) })` emitted its payload with
  nothing having inspected it. An ordinary function is still handed back untouched, so it keeps
  being omitted from the output rather than becoming `{}`.
- **The root of a log record never honours `toJSON`.** Pino ITERATES that object rather than
  serializing it, so honouring the method replaced the whole record with its return value:
  `logger.info(key, msg, userId, { toJSON: () => 'x' })` emitted `{"0":"x"}` and lost `logKey`,
  `userId` and every other field. Nested values and serializer outputs do reach `JSON.stringify`
  and keep it. The same applies to `child()` bindings, which Pino also iterates.
- **An object that reports no keys is snapshot, not passed through.** The empty-key fast path
  returned the original reference, which a Proxy exploits: answer `[]` to the walk's
  `Object.keys`, then expose an enumerable secret when Pino serializes the reference.
- **A censor that cannot be written fails closed.** `Reflect.defineProperty` reports failure by
  returning `false` rather than throwing, so an `Error` carrying a non-configurable enumerable
  secret kept its raw value while the redaction silently no-opped. A failed write is now a
  traversal failure.
- **A stateful `toJSON()` or getter cannot differ between inspection and serialization.** The walk
  probed `toJSON()` once and, when the result was clean, returned the original object — leaving
  `JSON.stringify` to call the method a second time (with the property key, which the probe does
  not pass). The inspected result is now what gets serialized, and the same applies to accessors.
- **Hostile metadata and hostile errors no longer crash the caller.** The never-throw guarantee
  now starts at the FIRST read of caller-controlled data: `Object.keys` fires a Proxy's `ownKeys`
  trap and `Reflect.get` fires a getter, both before anything reached the redaction pipeline, so
  `logger.info(key, msg, undefined, hostileMetadata)` threw outright. Unreadable metadata is
  dropped whole and marked with the redaction-failure envelope while the entry keeps its real
  `logKey`, message and correlation ids. The same guard covers the error path — `name`, `message`
  and `stack` are ordinary properties a caller can redefine as throwing accessors, and `message`
  is read outside the serializer.
- **A record whose getter throws is dropped WHOLE, not up to the failing property.** The mixin
  merge used `Object.assign` on the mixin's own object, which copies key by key — so everything
  read before the hostile getter was already written into it, and the failure path emitted that
  prefix while claiming to drop the record. Merging into a disposable target keeps the partial
  writes in the value that is discarded.
- **A throwing getter no longer crashes the log call.** Pino merges the mixin result with the
  caller's object before `formatters.log` runs, and the default strategy's `Object.assign` invokes
  every own getter — so a hostile getter threw before the redactor's fail-closed envelope could
  apply. The factory now owns the merge, and the never-throw guarantee holds through the real
  pipeline.
- **Bootstrap entries are emitted after destination initialization.** They were written from an
  eagerly instantiated provider factory, which runs before `DestinationRegistry.onModuleInit()` —
  so a sink that only accepts writes once its own `onInit()` has run could drop them, including
  `LOGGER_BOOTSTRAP_WARNING`. They now come from the registry that owns that initialization, which
  makes the ordering structural. Note for test authors: `Test.createTestingModule().compile()`
  builds the graph, `init()` runs the lifecycle hooks — the bootstrap entries appear after `init()`.
- **`LOGGER_BOOTSTRAP_WARNING` is emitted when `shouldDisableDefaultRedact` is on.** The README
  has always described this entry as the audit trail proving when PII protection was
  intentionally reduced. It was never written, so a deployment running without redaction was
  indistinguishable from a protected one.

### Changed

- **Default redaction is now a single name-based recursive walk** instead of 140 compiled
  `fast-redact` paths. A value is censored when its key name is in `REDACT_COMMON_FIELDS`, at any
  depth, in one snapshotting traversal that mutates nothing of the caller's and reads every value
  exactly once.
  Circular references collapse to `[Circular]`; a record that cannot be walked
  degrades to a marked, data-free envelope rather than being emitted unredacted.

  Measured on the full production path (`forRoot({ service })`, no other option set):
  **9,311 → ~274,000 logs/s**, ~107 µs → ~3.6 µs per entry. Every value is read exactly once and
  pinned into a fresh structure, so what reaches the sink is guaranteed to be what was inspected —
  an earlier copy-on-write draft returned clean subtrees by reference and let `JSON.stringify`
  re-evaluate their accessors, which a stateful getter can answer differently.

- **`redactPaths` is unchanged** — consumer paths are still `fast-redact` paths, applied on top of
  the default coverage. `fast-redact` is now configured only when there are consumer paths to
  apply.
- **Bundle-size budget raised** 13.5 → 16.0 KiB brotli for the server subpath, and the benchmark's
  throughput floor raised 0.004 → 0.20; the old floor was calibrated to the wildcard engine and
  could no longer fail on anything short of a 100× regression.

### Added

- **`redactStrategy: 'names' | 'paths'`** (default `'names'`). `'paths'` restores the pre-1.2
  engine for a consumer depending on exact `fast-redact` path semantics — with its four-level
  ceiling and its cost. Expect it to be removed in a future major.
- **`PINO_LEVEL_NUMBERS` / `PINO_LEVEL_NAMES` are exported** from the server subpath, so a
  destination writing a numeric level column can convert the string label without hard-coding the
  mapping.
- **`RESERVED_LOG_KEYS.LOGGER_REDACTION_FAILED`** — the marker on the envelope substituted for a
  record whose traversal threw.
- **`RESERVED_LOG_KEYS_NOT_EMITTED`** — the keys that are reserved but intentionally never
  written, each with its reason. A unit test now asserts that every other declared key has a
  writer in production source, so a key can no longer be declared, documented as a signal, and
  silently never emitted.

### Fixed

- **AsyncLocalStorage context reaches structured entries.** `emitStructured` / `errorStructured` /
  the NestJS-variadic path wrote `userId` and `context` as own properties even when they were
  `undefined`, and Pino's default `mixinMergeStrategy` (`Object.assign(mixinResult, mergeObject)`)
  let that `undefined` overwrite the value the trace mixin had just read from the ALS store. The
  key then vanished during serialization, so `logContext.set('userId', …)` — the documented way to
  attach the authenticated user once per request — never reached a log unless every call site
  repeated it. `requestId` and `tenantId` only ever survived because those names are not written
  by this class. Precedence is now explicit argument > ALS store > field absent.
- **A caller's `metadata` can never occupy `logKey`, `userId` or `context`.** The invariant was
  previously enforced by overwriting those fields after the spread — the same unconditional write
  that clobbered the ALS context. Now that they are written only when defined, the owned names are
  stripped from `metadata` on the way in, so a metadata bag cannot forge the acting user that the
  mixin read from the authenticated request scope.
- **`RESERVED_LOG_KEYS_NOT_EMITTED` is exported** from both subpaths, so the `{@link}` in
  `RESERVED_LOG_KEYS`'s documentation resolves in the published declarations.
- **`LOGGER_SHUTDOWN_OK` is emitted** at the start of `onApplicationShutdown`, before the
  destinations are torn down, with an event-loop barrier so an async sink's write is not raced by
  its own teardown (the authoritative contract remains `ILogDestination.onShutdown`, which MUST
  flush pending writes). It is the bookend to `LOGGER_BOOTSTRAP_OK`: its absence in a log
  stream is how an operator tells a graceful shutdown from a killed process.
- **A consumer path's leaf name reaches the walk, so it cannot leak through a truncation preview.**
  Consumer `redactPaths` are applied by Pino's stringifier, which runs AFTER the per-field size
  bound — so a field covered only by a path was still raw when the 200-character `_preview` was
  built. The leaf name is now matched by the walk as well, which closes that and covers the same
  name on every other surface the walk reaches. Deliberately broader than the path itself:
  `redactPaths: ['user.ssn']` censors `ssn` wherever it appears.
- **An oversized field's truncation `_preview` is redacted.** Redaction now runs before the size
  bound, so the 200-character preview of a truncated value carries `[REDACTED]` instead of the
  head of a secret.

### Documentation

- **`README.md` API reference corrected.** The table described `warn` / `debug` / `error` / `fatal`
  as structured methods taking a log key — they are the NestJS variadic bridge — documented a
  `fatalStructured` that does not exist, labelled the structured API's third parameter `context`
  when it is `userId`, and described `@LogContext` as a method decorator that opens a
  `logContext.run()` scope when it is a class decorator that only records metadata.
- **The Loki and Prisma destination examples now run.** The Loki example called
  `BigInt(entry.time)` on an ISO 8601 string, which throws; the Prisma example wrote the string
  level label into a numeric column. Both conversions are now correct and are exercised by
  `test/e2e/log-entry-contract.e2e-spec.ts`.
- **The architecture diagram no longer inverts the pipeline** — `RequestIdMiddleware` runs before
  `HttpLoggingInterceptor`, which is why the interceptor's entries carry a `requestId` at all.

### Breaking

- **`LogEntry.level` is `LogLevel` (a string) and `LogEntry.time` is `string`.** They were declared
  `number` and `string | number`; the runtime has always emitted the Pino string label and an ISO
  8601 string. This is a **type-level** break only — code relying on the old declaration was
  already failing at runtime — but it can newly fail to compile. Convert with the now-exported
  `PINO_LEVEL_NUMBERS` and `Date.parse`.

  Shipped as a minor rather than a major deliberately: the library has no consumers yet, and
  SemVer's major exists to protect the consumers a break would reach. Breaks are documented here
  under this heading with their migration path, which is what carries the signal while the version
  number does not.

## [1.1.0] - 2026-08-11

Coordinated ecosystem release aligning every `@bymax-one/*` package after the ioredis 6 /
bullmq 6 migration. This is a version-alignment-only release: the published `dist/` is
identical to `1.0.8`, and nothing changed but the version number.

### Changed

- No changes since `1.0.8`; version advanced to keep the `@bymax-one/*` line aligned.

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

[Unreleased]: https://github.com/bymaxone/nest-logger/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/bymaxone/nest-logger/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/bymaxone/nest-logger/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/bymaxone/nest-logger/compare/v1.2.9...v1.3.0
[1.2.9]: https://github.com/bymaxone/nest-logger/compare/v1.2.7...v1.2.9

<!-- 1.2.8 has no link: it was merged but never tagged, so there is no v1.2.8 to compare against. See its section above. -->

[1.2.7]: https://github.com/bymaxone/nest-logger/compare/v1.2.6...v1.2.7
[1.2.6]: https://github.com/bymaxone/nest-logger/compare/v1.2.5...v1.2.6
[1.2.5]: https://github.com/bymaxone/nest-logger/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/bymaxone/nest-logger/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/bymaxone/nest-logger/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/bymaxone/nest-logger/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/bymaxone/nest-logger/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/bymaxone/nest-logger/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/bymaxone/nest-logger/compare/v1.0.8...v1.1.0
[1.0.8]: https://github.com/bymaxone/nest-logger/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/bymaxone/nest-logger/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/bymaxone/nest-logger/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/bymaxone/nest-logger/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/bymaxone/nest-logger/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/bymaxone/nest-logger/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/bymaxone/nest-logger/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/bymaxone/nest-logger/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bymaxone/nest-logger/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/bymaxone/nest-logger/releases/tag/v0.1.0
