# Changelog

All notable changes to `@bymax-one/nest-logger` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `release.yml` workflow extracts the section matching the pushed `vX.Y.Z` tag
as the GitHub Release body, so each released version needs a matching `## [X.Y.Z]`
heading here.

## [Unreleased]

## [1.2.1] - 2026-08-13

### Security

- **A log message can no longer forge log lines in re-rendered output** (CodeQL
  `js/log-injection`, alert #61). Every message argument handed to Pino can carry caller- or
  user-provided text — a thrown value recorded off an HTTP request, a variadic NestJS line, a
  structured message — and while the NDJSON transport already neutralizes an embedded line break
  through JSON escaping (measured), `pino-pretty` — shipped here as `PrettyDevDestination` — and
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
  rendered as its readable `\uXXXX` escape — one form for every character, the same shape JSON
  already uses for control bytes, so the pretty rendering and the NDJSON line agree. Escaping the
  ESC byte is what disarms every sequence built on it, rather than chasing sequences one by one.
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

[Unreleased]: https://github.com/bymaxone/nest-logger/compare/v1.2.1...HEAD
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
