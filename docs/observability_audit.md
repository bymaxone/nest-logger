# Observability Audit — `@bymax-one/nest-logger`

> **Audited version:** `1.1.0` (branch `ci/add-osv-scanner`, commit `edcbeee`)
> **Date:** 2026-08-12
> **Scope:** structured logging, request context, OpenTelemetry correlation, semantic
> conventions, PII/security, cardinality, sampling, performance, tests
> **Status:** **P0 remediated in `1.2.0`** (2026-08-12) — see the
> [implementation status](#p0-implementation-status) below. P1/P2 remain open and
> are unchanged from the original audit.
> **Reference points:** OpenTelemetry Semantic Conventions **1.44.0**, OTel Logs Data Model
> (stable), `@opentelemetry/api` **1.9.1** (installed), `@opentelemetry/api-logs` **0.221.0**
> (alpha), Pino **10.x**, NestJS **11**

---

## <a id="p0-implementation-status"></a>P0 implementation status — shipped in `1.2.0`

| Finding                                   | Status | What landed                                                                                                                                                     |
| ----------------------------------------- | :----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [S-1](#s-1) auth headers unredacted       |   ✅   | Header names added to `REDACT_COMMON_FIELDS`; caught at any position                                                                                            |
| [S-2](#2-5-security--pii) depth-4 ceiling |   ✅   | Removed — the walk is depth-unbounded (fail-closed guard at 100 for stack safety)                                                                               |
| [P-1](#p-1) redaction cost                |   ✅   | Name-walk engine, then hardened to a snapshotting walk after review. **9,311 → ~274,000 logs/s** on the shipped config (~29×)                                   |
| [C-1](#c-1) ALS `userId` dropped          |   ✅   | `assignIfDefined` — reserved fields written only when defined                                                                                                   |
| [C-2](#c-2) `LogEntry` type mismatch      |   ✅   | `level: LogLevel`, `time: string`; level maps exported; README examples fixed and executed by a test                                                            |
| [D-1](#d-1) dead reserved keys            |   ✅   | `LOGGER_BOOTSTRAP_WARNING` + `LOGGER_SHUTDOWN_OK` emitted; `HTTP_REQUEST_COMPLETED` justified in `RESERVED_LOG_KEYS_NOT_EMITTED`; completeness test added       |
| [D-4](#d-4) README API table wrong        |   ✅   | Table rewritten to match the source; diagram corrected                                                                                                          |
| **S-3** guard rejections unlogged         |   ✅   | Found after the audit, by the template/nest-core sessions. Access log moved to `HttpAccessLogMiddleware`, which runs before guards — 401/403/429/404 now logged |
| **C-3** aborted request logged as success |   ✅   | Found after the audit, measured in this repo. `HTTP_REQUEST_ABORTED` from the response's `'close'` event; the real status is preserved                          |
| **D-5** middleware skipped prefixed root  |   ✅   | Found after the audit. `applyRequestIdMiddleware` defaulted to `'*'`, which stops matching under `setGlobalPrefix`; now mounts at `'/'`                         |

### Findings added after the audit was written

Three defects surfaced from integration testing by the `bymax-one` template and `nest-core`
sessions, which observed a real backend through Grafana/Loki rather than reading this repository.
They are recorded here because the audit missed them, and the reason it missed them is
instructive: **it reviewed each component against its own contract, and all three are defects of
POSITION in the request pipeline.** The interceptor does exactly what its file says; it is mounted
where it cannot see a guard rejection. A component-by-component reading cannot find that. The
measurement that did was "count the log lines per status code over 20 minutes of real traffic, and
notice that 401 has none".

The generalizable lesson for the remaining P1/P2 work: an observability audit needs at least one
pass that asks what the pipeline as a whole never emits, not only whether each part emits what it
claims.

Every fix carries a regression test that reproduces the original defect, verified to fail
against the pre-fix code. Seven rounds of adversarial PR review followed, each finding more —
child-logger bindings, `Error` values outside a serializer key, secrets synthesized by `toJSON`,
header-name casing, hostile metadata crashing the caller, a time-of-check/time-of-use window
between inspection and serialization, and callables carrying a `toJSON`. All are closed and
covered; see the PR for the reproduction of each. Coverage 100 %, mutation 100 % on a cold run.

**Found while implementing, NOT fixed (out of P0 scope):** `err.type` is always
`"Object"` for anything logged through `errorStructured` — and therefore through
`HttpExceptionFilter`. `serializeError` produces a plain object carrying the real
class name on `type`, and `pino.stdSerializers.err` then overwrites that field
with the object's own constructor name. The June 2026 fix that made
`serializeError` read `error.name` is defeated one layer downstream. Belongs with
[P1-4](#p1-4--semconv-aligned-error-fields-and-a-full-cause-chain), which already
reworks the error shape.

---

## 0. Executive summary

`nest-logger` is a **correctly scoped** logging library. It contains no metrics, no tracing
SDK, no exporters, no backend clients, and no Bymax-specific coupling. The architecture the
prompt asks for is, at the boundary level, already the architecture that exists. **Phase 10
recommendation: B.**

But the audit found defects that matter more than the missing semantic conventions:

| #                       | Finding                                                                                                                                                                                                 | Severity             | Verified how                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| [S-1](#s-1)             | Auth headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`) are **only** redacted at the absolute paths `req.headers.*` / `res.headers.*`. A logged headers bag leaks in clear. | **P0 · security**    | Runtime probe against `DEFAULT_REDACT_PATHS`                  |
| [P-1](#p-1)             | The default production path runs at **9,311 logs/s** (≈107 µs/log). 100% of the cost is the 108 wildcard redact paths. README claims "< 3% throughput impact" and "~750,000 logs/sec".                  | **P0 · perf**        | `pnpm bench` + isolation benchmark                            |
| [C-1](#c-1)             | `userId` set in the ALS context **never reaches a structured log**. `emitStructured` writes `userId: undefined`, which clobbers the mixin value under Pino's default merge strategy.                    | **P0 · correctness** | Runtime repro with real Pino 10                               |
| [C-2](#c-2)             | `LogEntry.level` is typed `number`, `time` as `string \| number`; the runtime emits `level: "info"` and an ISO string. The README's own Loki destination example throws on it.                          | **P1**               | Runtime probe; same defect class as the `1.0.5` `write()` bug |
| [O-1](#o-1)             | OTel detection is anchored to `process.cwd()`. A process whose CWD is not the app root silently loses **all** trace correlation, with no warning.                                                       | **P1**               | Source review of `otel-detector.ts`                           |
| [O-2](#o-2)–[O-5](#o-5) | No `service.instance.id` / `service.namespace` / `deployment.environment.name`; no `event.name`; error fields are `err.*` not `exception.*`; HTTP fields are ad-hoc, not semconv.                       | **P1**               | Compared against semconv 1.44.0                               |
| [D-1](#d-1)–[D-4](#d-4) | Three reserved log keys are never emitted (one of them a **documented security signal**), `LOGGER_ERROR_CODES` is dead code, `@LogContext` is inert, and the README API table is wrong in 6 places.     | **P1**               | Grep + source review                                          |

The single highest-value change in this report is **not** a semantic convention: it is
replacing the wildcard-path redaction strategy. A measured alternative produces **byte-identical
output at 943,240 ops/s vs 10,117 ops/s** — 93× faster — while covering _unbounded_ nesting
depth instead of four levels. Security and performance are not in tension here; the current
design is losing on both.

---

## 1. Current architecture

### 1.1 Package shape

Two subpaths, zero runtime dependencies, everything via peer deps.

```
@bymax-one/nest-logger          → NestJS module, services, HTTP layer, decorators, destinations
@bymax-one/nest-logger/shared   → LogLevel, LogEntry, ServiceMetadata, log-key regex/constants
```

Peers: `@nestjs/common`, `@nestjs/core`, `pino`, `reflect-metadata`, `rxjs` (required);
`@opentelemetry/api`, `pino-pretty` (optional).

### 1.2 Runtime pipeline

```
forRoot(options)
  └─ validateOptions()                       structural check, throws [BymaxLoggerModule] …
  └─ applyDefaults()                         deep-frozen ResolvedBymaxLoggerModuleOptions
       └─ LOGGER_OPTIONS_TOKEN

LOGGER_DESTINATIONS_TOKEN  ← options.destinations, or [DefaultStdoutDestination]
LOGGER_PINO_INSTANCE_TOKEN ← buildPinoInstance(options, logContext, destinations)
       ├─ redact:      compileRedactPaths(DEFAULT_REDACT_PATHS ∪ redactPaths)  → fast-redact
       ├─ base:        { service: { name, version } }                          (replaces pino's pid/hostname)
       ├─ timestamp:   () => `,"time":"<ISO 8601>"`
       ├─ formatters:  level → string label
       ├─ serializers: err (pino std) + user serializers, each size-bounded
       ├─ mixin:       createTraceContextMixin(logContext, otel)
       └─ pino.multistream(destinations.map(destinationToStream))

PinoLoggerService     ← wraps the Pino instance; NestJS LoggerService + structured API
LogContextService     ← AsyncLocalStorage<LogContext>
DestinationRegistry   ← onModuleInit / onApplicationShutdown lifecycle for destinations
bootstrapProvider     ← emits LOGGER_BOOTSTRAP_OK once
```

Per log entry, the mixin runs:

```
merged = {}
merged ← ALS store            (requestId, tenantId, userId, arbitrary custom keys)
merged ← OTel active span     (traceId, spanId, traceFlags) — only if both IDs pass W3C validation
```

Then Pino merges the caller's object **over** the mixin result, applies serializers and
`fast-redact`, serializes to NDJSON, and fans out to every destination stream. Each stream
wrapper contains write failures (reports one line to stderr, never rethrows, never re-enters
the logger).

### 1.3 HTTP layer (opt-in, `http.isEnabled`)

- `RequestIdMiddleware` — **manually wired** by the consumer via `applyRequestIdMiddleware(consumer)`.
  Validates `x-request-id` (charset + 256-byte cap), mints a UUID if absent and allowed, echoes it
  on the response, reads `x-tenant-id`, opens the ALS scope.
- `HttpLoggingInterceptor` — `HTTP_REQUEST_START` on entry; `HTTP_REQUEST_SUCCESS` /
  `_REDIRECT` on completion; `_CLIENT_ERROR` (warn) / `_SERVER_ERROR` (error) on throw.
  Query string stripped, URL normalized to `/:id`.
- `HttpExceptionFilter` — catch-all; `HTTP_EXCEPTION_HANDLED` (4xx, warn) /
  `HTTP_EXCEPTION_UNHANDLED` (5xx, error, sanitized stack). Auto-registered only on the
  **sync** path.

### 1.4 Emitted record (verified, not assumed)

```json
{
  "level": "info",
  "time": "2026-08-12T09:25:46.520Z",
  "service": { "name": "my-app", "version": "abc123" },
  "requestId": "r_7f3a9b",
  "tenantId": "t_acme",
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "spanId": "b7ad6b7169203331",
  "traceFlags": "01",
  "logKey": "PAYMENT_REFUND_SUCCESS",
  "context": "PaymentsService",
  "paymentId": "pi_xyz",
  "msg": "Refund processed"
}
```

`pid` and `hostname` are **not** emitted — `base` is fully overridden by `{ service }`.

---

## 2. Existing capabilities

Legend: ✅ implemented correctly · ⚠️ implemented but should be improved · ❌ missing · 🚫 should not belong here

### 2.1 Structured logging

| Capability                   | Status | Notes                                                                                                                 |
| ---------------------------- | :----: | --------------------------------------------------------------------------------------------------------------------- |
| Structured JSON output       |   ✅   | NDJSON, one object per line.                                                                                          |
| Pino 10 integration          |   ✅   | Idiomatic: `mixin` for ambient data, `formatters.level`, `base`, `multistream`.                                       |
| Consistent levels / severity |   ⚠️   | Six Pino levels, emitted as a **string label only**. No `SeverityNumber`. See [O-6](#o-6).                            |
| Child loggers                |   ✅   | `PinoLoggerService.child()` + `@InjectLogger(ctx)` auto-provider. Avoids the singleton `setContext()` race correctly. |
| Contextual metadata          |   ⚠️   | Works, but ALS `userId` is silently dropped — [C-1](#c-1).                                                            |
| Error serialization          |   ⚠️   | `{ type, message, stack }` under `err`. Loses `cause` / `AggregateError.errors`; not semconv-named. [O-4](#o-4)       |
| Stack traces                 |   ✅   | Present; `sanitizeError` scrubs `node_modules/` frames.                                                               |
| Custom serializers           |   ✅   | `options.serializers`, each wrapped by the size-bounded envelope.                                                     |
| Custom destinations          |   ✅   | `ILogDestination` with lifecycle + fail-soft write path. Genuinely good design.                                       |
| Prod vs dev formatting       |   ⚠️   | Only via `PrettyDevDestination` opt-in. `isPretty` was removed (inert). Level default flips on `NODE_ENV`.            |
| Machine-readable schema      |   ⚠️   | Stable and consistent at runtime — but the **published `LogEntry` type does not match it**. [C-2](#c-2)               |

### 2.2 Request context

| Field / capability           | Status | Notes                                                                                    |
| ---------------------------- | :----: | ---------------------------------------------------------------------------------------- |
| `requestId`                  |   ✅   | Header-echoed or minted; charset- and length-validated; exposed on the response.         |
| `correlationId`              |   ✅   | Same field; `x-request-id` is the industry norm — a separate name is not needed.         |
| `traceId` / `spanId`         |   ✅   | From the active OTel span, W3C-validated.                                                |
| `tenantId`                   |   ✅   | From a configurable header, same validation.                                             |
| `userId`                     |   ❌   | Reachable only as a **per-call argument**. The ALS path is broken — [C-1](#c-1).         |
| Service metadata             |   ⚠️   | `name` + `version` only. See [O-2](#o-2).                                                |
| Sync context propagation     |   ✅   | `AsyncLocalStorage`, singleton service, no `Scope.REQUEST`. Correct choice.              |
| Async context propagation    |   ✅   | Native ALS; propagates through promises, timers, `queueMicrotask`.                       |
| Context leakage between reqs |   ✅   | `run()` gives each request a fresh, sanitized store. Unit-tested for parallel isolation. |
| Worker-thread propagation    |   🚫   | ALS does not cross `worker_threads`. Correctly documented as out of scope.               |

**Propagation failure modes found:**

1. `LogContextService.set()` **throws** outside a `run()` scope. Any call from a background job,
   a cron handler, or a lifecycle hook crashes the caller. `get()` correctly returns `undefined`;
   `set()` is asymmetric.
2. `RequestIdMiddleware` is not auto-wired. `http.isEnabled: true` gives you the access log with
   **no `requestId`** unless the consumer separately calls `applyRequestIdMiddleware`. The README
   documents both steps but the module never warns when the interceptor runs outside a scope.
3. `@LogContext` looks like it opens a scope. It does not — [D-3](#d-3).

### 2.3 OpenTelemetry integration

| Capability                            | Status | Notes                                                                                    |
| ------------------------------------- | :----: | ---------------------------------------------------------------------------------------- |
| Detects the active span               |   ✅   | `trace.getActiveSpan()` per log entry.                                                   |
| Extracts `traceId` / `spanId`         |   ✅   | Validated as 32/16 lowercase hex, all-zeros rejected.                                    |
| Auto-injects into every log           |   ✅   | Via mixin — the correct Pino hook (`formatters.log` cannot see ambient state).           |
| Preserves context across async ops    |   ✅   | Delegated to the OTel context manager. Correct: the logger reads, it does not propagate. |
| W3C Trace Context                     |   ✅   | Consumes the SDK's `SpanContext`; `traceFlags` masked to one byte and hex-formatted.     |
| Injects on **unsampled** spans        |   ✅   | Gates on the zero trace ID, not on `traceFlags` — the classic bug, correctly avoided.    |
| Works with auto-instrumentation       |   ✅   | Ambient-span based; source-agnostic.                                                     |
| Works with manual instrumentation     |   ✅   | Same path.                                                                               |
| Coupling to an OTel **SDK**           |   ✅   | **None.** API-only, optional, lazily resolved. Exactly right.                            |
| Forces an exporter / Collector config |   ✅   | Does not. Nothing OTLP-related ships.                                                    |
| Detection robustness                  |   ⚠️   | CWD-anchored resolution — [O-1](#o-1).                                                   |
| OTel **Logs** Bridge (`api-logs`)     |   🚫   | Absent, and should stay absent — the JS Logs Bridge API is still **alpha** (`0.221.0`).  |

### 2.4 Semantic conventions

| Attribute                           | semconv 1.44.0 status              | In library                                        | Verdict |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------- | :-----: |
| `service.name`                      | Stable                             | `service.name` (nested object)                    |   ⚠️    |
| `service.version`                   | Stable                             | `service.version` (nested object)                 |   ⚠️    |
| `service.namespace`                 | Stable                             | —                                                 |   ❌    |
| `service.instance.id`               | Stable                             | —                                                 |   ❌    |
| `deployment.environment.name`       | Stable                             | —                                                 |   ❌    |
| `exception.type/message/stacktrace` | Stable                             | `err.type/message/stack`                          |   ⚠️    |
| `error.type`                        | Stable                             | —                                                 |   ❌    |
| `http.request.method`               | Stable                             | `method`                                          |   ⚠️    |
| `http.response.status_code`         | Stable                             | `statusCode`                                      |   ⚠️    |
| `http.route`                        | Stable                             | `url` (regex-normalized, not the real route)      |   ⚠️    |
| `url.path`                          | Stable                             | `fullUrl`                                         |   ⚠️    |
| `client.address`                    | Stable                             | `ip`                                              |   ⚠️    |
| `user_agent.original`               | Stable                             | `userAgent`                                       |   ⚠️    |
| `event.name` (LogRecord EventName)  | Stable field, Development registry | `logKey`                                          |   ⚠️    |
| `TraceId` / `SpanId` / `TraceFlags` | Stable (Logs Data Model)           | `traceId` / `spanId` / `traceFlags`, configurable |   ✅    |

### 2.5 Security / PII

| Capability                   | Status | Notes                                                                                               |
| ---------------------------- | :----: | --------------------------------------------------------------------------------------------------- |
| Redaction at source          |   ✅   | In-process, before serialization. Strictly better than scrub-after-ingest.                          |
| Passwords / tokens / secrets |   ✅   | 27 field names covered at root + depths 1–4.                                                        |
| PCI DSS card fields          |   ✅   | `cardNumber`, `cardCvv`, `cvv`, `cvc`, `cardExpiry`.                                                |
| LGPD documents               |   ✅   | `cpf`, `cnpj`, `rg`; `email` as a conservative default.                                             |
| **Authorization / cookies**  |   ❌   | **Only** at `req.headers.*` / `res.headers.*`. A headers bag under any other key leaks. [S-1](#s-1) |
| Nested objects               |   ⚠️   | Covered to depth 4. Deeper nesting leaks silently.                                                  |
| Arrays                       |   ✅   | `fast-redact` wildcards match array indices (verified).                                             |
| Configurable                 |   ✅   | `redactPaths`, `redactCensor`, `shouldDisableDefaultRedact`.                                        |
| Production-safe defaults     |   ⚠️   | Yes, except [S-1](#s-1) and the depth cap.                                                          |
| Request bodies               |   ✅   | Never logged by the library.                                                                        |
| Response bodies              |   ✅   | Never logged.                                                                                       |
| Query parameters             |   ✅   | Stripped in the interceptor **and** the filter.                                                     |
| Headers                      |   ⚠️   | Only `user-agent` is logged — good — but see [S-1](#s-1) for consumer-logged bags.                  |
| Exception objects            |   ✅   | Sanitized: circular-safe, depth- and width-bounded, `node_modules` frames scrubbed.                 |
| Message string               |   ❌   | Never scanned. A secret interpolated into `msg` is written verbatim. Documented nowhere.            |
| Client IP                    |   ⚠️   | Logged by default on `HTTP_REQUEST_START` — personal data under GDPR/LGPD. Opt-**out** only.        |
| Prototype pollution          |   ✅   | `__proto__` / `constructor` / `prototype` rejected in `set()`, stripped in `run()`.                 |
| Trace-ID injection           |   ✅   | Validated before write.                                                                             |
| ReDoS on `excludePaths`      |   ⚠️   | Consumer-supplied regexes run per request. Documented, not enforced.                                |

### 2.6 Cardinality, sampling, metrics

| Capability                      | Status | Notes                                                                                                                 |
| ------------------------------- | :----: | --------------------------------------------------------------------------------------------------------------------- |
| URL normalization               |   ⚠️   | Bounds cardinality, but by heuristic — see [O-5](#o-5).                                                               |
| Bounded `logKey` vocabulary     |   ✅   | `MODULE_ACTION_RESULT` + exported regex. The right metric-label candidate.                                            |
| High-cardinality field guidance |   ❌   | Not documented in-repo. Nothing tells a consumer that `requestId`/`traceId`/`userId` must never become metric labels. |
| Log sampling                    |   ❌   | None. No way to damp a hot loop or the per-request `HTTP_REQUEST_START` doubling.                                     |
| Trace head sampling             |   🚫   | Correctly absent — OTel SDK responsibility.                                                                           |
| Trace tail sampling             |   🚫   | Correctly absent — Collector responsibility.                                                                          |
| Metrics of any kind             |   🚫   | Correctly absent.                                                                                                     |

No functionality in the library currently duplicates a Collector responsibility. That
separation is clean today.

---

## 3. Gap analysis

### <a id="s-1"></a>S-1 · Auth headers are not redacted by name — **P0 security**

`REDACT_ABSOLUTE_PATHS` lists five paths and `REDACT_COMMON_FIELDS` lists 27 field names.
`authorization`, `cookie`, `set-cookie`, `x-api-key` and `x-auth-token` appear **only** in
the absolute list, rooted at `req.headers` / `res.headers`.

Verified against `DEFAULT_REDACT_PATHS` with real Pino:

```
input : { headers: { authorization: 'Bearer SECRET', cookie: 'sid=SECRET' } }
output: {"headers":{"authorization":"Bearer SECRET","cookie":"sid=SECRET"}}   ← LEAK

input : { authorization: 'Bearer SECRET' }
output: {"authorization":"Bearer SECRET"}                                     ← LEAK

input : { headers: { 'set-cookie': 'sid=SECRET' } }
output: {"headers":{"set-cookie":"sid=SECRET"}}                               ← LEAK
```

The interceptor and filter never log a headers bag, so the library itself does not leak.
But `logger.info(key, msg, userId, { headers: req.headers })` is one of the most common
things an application logs while debugging an integration, and the README's security table
tells the reader those headers are covered. They are not, outside the `req`/`res` shapes.

`DEFAULT_REDACT_PATHS` is append-only by contract, so the fix — adding these names to the
common-field list — is **purely additive and non-breaking**.

### <a id="p-1"></a>P-1 · Wildcard redaction costs 99% of the logging pipeline — **P0 performance**

`pnpm bench` on this machine (Node 24, M-series):

| Scenario                                 |     ops/s | bytes/op |
| ---------------------------------------- | --------: | -------: |
| A — bare Pino 10                         | 1,223,780 |       24 |
| B — `PinoLoggerService`, no redact/mixin | 1,263,774 |    1,324 |
| C — full production path                 | **9,311** |      967 |

Isolating the cost, same payload, same sink:

| Configuration                              |     ops/s | vs no-redaction |
| ------------------------------------------ | --------: | --------------: |
| no redact, no mixin                        |   662,967 |           1.00× |
| mixin only (ALS + OTel)                    |   572,380 |           0.86× |
| root-only redact (32 exact paths) + mixin  |   551,974 |           0.83× |
| depth 1 (59 paths) + mixin                 |    54,317 |           0.08× |
| depth 1–2 (86 paths) + mixin               |    22,302 |           0.03× |
| **depth 1–4 (140 paths, current)** + mixin | **9,286** |      **0.014×** |

Conclusions that follow directly from the numbers:

- The **mixin is cheap** (14%). ALS lookup + OTel span lookup are not the problem.
- **Exact paths are free** (a further 4%).
- **Every wildcard level costs roughly 2.5×.** The 108 wildcard paths are the entire cliff.
- The shipped default runs at **~107 µs per log entry**. On a service logging 3 entries per
  request (START, SUCCESS, one business event), that is **~320 µs of CPU per request** spent
  inside the logger.

The README's claims — "~750,000 logs/sec", "under 3% throughput impact", "no per-log regex
matching" — describe scenario B, not the configuration the library actually ships.
`bench/README.md` is honest about this internally ("the security tax"), but the framing is
wrong: it is not an inherent tax, it is a strategy choice.

**A measured alternative.** Replacing path-matching with a single recursive walk over the
merged record, testing each key name against a `Set`:

| Configuration                              |     ops/s |
| ------------------------------------------ | --------: |
| no redaction                               | 1,107,300 |
| `fast-redact`, 140 paths (current)         |    10,117 |
| single recursive walk, **unbounded depth** |   943,240 |

For a payload nested three levels deep with `password`, `token`, `email` and `cpf` at
different depths, the two produce **byte-identical output**. The walk is 93× faster _and_
strictly more thorough (no depth-4 ceiling, so [the nesting gap](#2-5-security--pii)
disappears too).

Caveats that must be resolved before implementing, not hand-waved:

- The walk must be copy-on-write. Mutating nested objects in place would corrupt application
  state, since Pino's merge object holds the caller's own references.
- `formatters.log` does not see `base` or child bindings. Those are library-controlled
  (`service`, `context`) and carry no secrets, so this is acceptable — but it must be asserted
  by a test, not assumed.
- `redactPaths` is public API and takes `fast-redact` path syntax. It must keep working. The
  proposal is: **name-based walk for the defaults, `fast-redact` retained for consumer-supplied
  paths** (typically a handful, usually exact).
- Interaction ordering with serializers and with the size-bounded envelope needs pinning down.

### <a id="c-1"></a>C-1 · ALS `userId` never reaches a structured log — **P0 correctness**

`emitStructured` builds `{ ...metadata, logKey, userId, context }`. When the caller omits the
`userId` argument, that is `userId: undefined` — an **own property**. Pino's default
`mixinMergeStrategy` is `Object.assign(mixinResult, mergeObject)`, so the explicit `undefined`
overwrites whatever the mixin read from the ALS store, and the key then vanishes during
serialization.

Reproduced with real Pino 10 (`store = { requestId, tenantId, userId: 'ALS_USER' }`):

```
logger.info({ plan:'pro', logKey:'USER_CREATED', userId: undefined }, 'created')
→ {"requestId":"r1","tenantId":"t1","traceId":"aaaa…","plan":"pro","logKey":"USER_CREATED","msg":"created"}
                                    ↑ userId is gone
```

`requestId` and `tenantId` survive because `emitStructured` does not name them.

This breaks the exact pattern the README documents in §7 and that `LogContext.userId` exists
for: set the authenticated user once per request, have every log carry it. Today every call
site must pass it again by hand, and there is no test asserting otherwise — which is why the
100% coverage gate did not catch it.

Same mechanism affects any future reserved field written unconditionally into the payload.

### <a id="c-2"></a>C-2 · The published `LogEntry` type does not match the emitted record — **P1**

```ts
// src/shared/types/log-entry.type.ts
level: number // runtime emits "info" (formatters.level → string label)
time: string | number // runtime always emits an ISO 8601 string
```

Downstream consequences, both in the README:

```ts
// Loki destination example — throws SyntaxError at runtime
String(BigInt((JSON.parse(line) as LogEntry).time) * 1_000_000n)
//            BigInt("2026-08-12T09:25:46.520Z")  ✗

// Prisma destination example — writes "info" into a column typed from `entry.level: number`
data: { level: entry.level, ... }
```

The README's sample output also shows `"level": 30`, which the library never produces.

This is the same defect class the vault records for `1.0.5` (`ILogDestination.write` documented
as taking a `LogEntry` when it takes a `string`): the published contract describing the
extension seam does not match the artifact. `check:published` compiles README snippets against
`dist/` — it caught the last one because it was a type error; this one type-checks and fails at
runtime, so the gate is blind to it.

### <a id="o-1"></a>O-1 · OTel detection is anchored to `process.cwd()` — **P1**

```ts
const requireFromCwd = createRequire(join(process.cwd(), 'noop.cjs'))
const mod = requireFromCwd('@opentelemetry/api')
```

The header comment explains the choice: `import.meta.url` fails to compile under the CommonJS
test transform (TS1343). But the consequence is that resolution walks up from the **working
directory**, not from the installed module. In a container with `WORKDIR /`, under a process
manager that sets a different CWD, or in a monorepo where the service is launched from the repo
root while its `node_modules` sits in `apps/api/`, the lookup fails, `detectOtelTraceApi()`
returns `undefined`, and **every log silently loses `traceId`/`spanId`** — no warning, no
`LOGGER_OTEL_API_UNAVAILABLE`, nothing.

Detection also runs exactly once at Pino-build time. That is fine for the `trace` namespace
object (it is a stable singleton) but means a misdetection is permanent for the process
lifetime.

`LOGGER_OTEL_API_UNAVAILABLE` exists as a constant and is documented in the README's error
catalog as "Nothing emitted" — deliberate, but it converts a config error into invisible data
loss on the single field the whole correlation story depends on.

### <a id="o-2"></a>O-2 · Missing stable resource attributes — **P1**

`ServiceMetadata` carries `name` and `version`. semconv 1.44.0 marks four more service/deployment
attributes **Stable**, and three of them are exactly what an AI or a human needs to answer
"which deployment of which service, in which environment":

| Attribute                     | Status | Why it matters                                                                                                                       |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `service.namespace`           | Stable | Disambiguates same-named services across teams/tenants.                                                                              |
| `service.instance.id`         | Stable | Distinguishes replicas. Today **nothing** identifies the emitting instance — `pid`/`hostname` are suppressed by the `base` override. |
| `deployment.environment.name` | Stable | `deployment.environment` is deprecated in its favour. Nothing carries env today.                                                     |

The library also emits `service` as a **nested object**, while semconv names are flat dotted
keys. Both work in Loki/Elastic; but a Collector `transform`/`attributes` processor mapping a
log record onto OTLP resource attributes needs the flat form. A `resourceFormat: 'nested' |
'flat'` option (default `nested`, for compatibility) resolves this additively.

There is a real duplicated-source-of-truth risk here worth stating plainly: the OTel SDK
already knows `service.name`, `service.version` and the environment from `OTEL_RESOURCE_ATTRIBUTES`
/ `OTEL_SERVICE_NAME`. The logger requires them again as constructor options. The right answer
is **not** to read the OTel Resource from the logger (that would couple it to the SDK); it is to
document the convention — feed both from the same env vars — and optionally default the logger's
values from `OTEL_SERVICE_NAME` / `OTEL_SERVICE_VERSION` / `OTEL_RESOURCE_ATTRIBUTES` when the
options are omitted.

### <a id="o-3"></a>O-3 · No `event.name` — **P1**

`logKey` is a well-designed, bounded, machine-readable event identifier with an enforced
regex — conceptually exactly what OTel calls an **EventName**. In the stable Logs Data Model,
`EventName` is now a top-level LogRecord field, and "a log record with a non-empty event name
is an Event."

The library invented `logKey` before that field existed. The correct move is **not to rename**
it — that would break every dashboard, alert and query in the Bymax fleet and the example app.
The correct move is to **also emit** `event.name` carrying the same value, behind an option,
so a Collector can map it onto the OTLP `EventName` field with a one-line `transform` rule.

Caveat for Phase 9: the OTel **event registry** and the JS Events/Logs Bridge API are still in
Development/alpha. Emitting an `event.name` **attribute** costs nothing and depends on nothing.
Adopting `@opentelemetry/api-logs` (`0.221.0`, explicitly "alpha software with no guarantee of
stability") into a library with a 100%-coverage release gate would be a mistake.

### <a id="o-4"></a>O-4 · Error fields are Pino-shaped, not semconv-shaped — **P1**

Emitted today: `err: { type, message, stack }` (Pino's `err` convention).
semconv 1.44.0, **all Stable**: `exception.type`, `exception.message`, `exception.stacktrace`.
Also Stable and absent: `error.type` — the low-cardinality error classifier that RED-style
error-rate breakdowns key on.

Two further losses on the error path:

1. `errorStructured` re-serializes with `{ type: error.name, message, stack }`, which **discards
   the `cause` chain and `AggregateError.errors`** that `sanitizeError` just computed. The
   `HttpExceptionFilter` source already documents this as known and deferred. For a `cause`-chained
   Node 24 codebase, the root cause is the interesting part and it never reaches the log.
2. There is no `errorStructured`-equivalent at `fatal` level, and the README documents a
   `fatalStructured` that does not exist.

### <a id="o-5"></a>O-5 · HTTP attributes are ad-hoc, and `http.route` is guessed — **P1/P2**

Current fields: `method`, `url`, `fullUrl`, `statusCode`, `duration`, `ip`, `userAgent`.
Stable semconv equivalents: `http.request.method`, `http.route`, `url.path`,
`http.response.status_code`, `client.address`, `user_agent.original`.

Separately, `normalizeUrl` derives the route by regex — UUID, ULID, 21-char nanoid, `\d+`.
NestJS already knows the **real** route pattern (`req.route.path` on Express, or
`Reflector` + `PATH_METADATA` on the handler). The heuristic is both less accurate and more
dangerous than the real thing:

- `/api/2024/reports` → `/api/:id/reports` (a literal path segment collapsed)
- any 21-character slug → `/:id` (`/posts/why-pino-beats-winston` is 24 chars, safe; a 21-char
  slug is not)
- a route with two different id params collapses to the same string, so the two cannot be told
  apart in a dashboard

Using the real route eliminates the guesswork and gives a genuinely bounded `http.route`.
The regex should remain as the fallback for non-NestJS-routed requests.

### <a id="o-6"></a>O-6 · No numeric severity — **P2**

The record carries `level: "info"` and nothing else. The OTel Logs Data Model defines both
`SeverityText` and `SeverityNumber`, and a Collector converting NDJSON to OTLP must map the
string back to a number using a per-source config. Emitting an optional `severityNumber`
(Pino 30 → OTel 9 `INFO`, etc.) removes that config step. Low effort, purely additive.

### <a id="d-1"></a>D-1 · Reserved keys that are never emitted — **P1**

`RESERVED_LOG_KEYS` declares 16 keys. Three are never written by any code path:

| Key                        | Documented as                                                                                                                          | Reality       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `LOGGER_BOOTSTRAP_WARNING` | README: emitted when `shouldDisableDefaultRedact` is on, "so security reviews can audit when PII protection was intentionally reduced" | never emitted |
| `LOGGER_SHUTDOWN_OK`       | reserved-key catalog                                                                                                                   | never emitted |
| `HTTP_REQUEST_COMPLETED`   | reserved-key catalog                                                                                                                   | never emitted |

The first is a **security control the README promises and the library does not implement**. A
team that disabled default redaction and relies on the startup warning to catch it in review
gets silence.

### <a id="d-2"></a>D-2 · `LOGGER_ERROR_CODES` is dead code — **P2**

`src/server/errors/logger-error-codes.constants.ts` is not exported from `src/server/index.ts`,
not imported anywhere, and its values never appear in any emitted record or thrown error. The
README documents it as an "Error Code Catalog" with the footnote that thrown errors carry a
message, "not the code string" — i.e. the file's own documentation admits it is inert. It exists
only to be covered by its spec file.

### <a id="d-3"></a>D-3 · `@LogContext` is inert — **P2**

`@LogContext('PaymentsService')` calls `SetMetadata`. Nothing reads that metadata key. The
JSDoc is honest ("until wired up"), but the **README's decorator table describes it as a method
decorator that wraps the method in `logContext.run(store, …)` so all downstream logs carry the
given fields.** It is a class decorator that does nothing observable. A consumer following the
README will believe they have request context and have none.

### <a id="d-4"></a>D-4 · The README API reference is wrong in six places — **P1**

| README says                                            | Reality                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `info(logKey, msg, context?, meta?)`                   | 3rd parameter is **`userId`**, not context                                |
| `warn/debug/error/fatal(logKey, msg, context?, meta?)` | these are the **NestJS variadic** methods: `(message, ...optionalParams)` |
| `warnStructured(logKey, error, …)`                     | takes a **`string` message**, not an `Error`                              |
| `fatalStructured` exists                               | does not exist                                                            |
| `@LogContext(store)` wraps in `run()`                  | class decorator, sets unread metadata                                     |
| `LogEntry.time: number`, `level: number`               | ISO string and level label — [C-2](#c-2)                                  |

Since `README.md` ships in `files`, per this repo's own `CLAUDE.md` rule these fixes require a
patch release, not a "next time" note.

### <a id="d-5"></a>D-5 · Smaller inconsistencies — **P2**

- The README architecture diagram places `HttpLoggingInterceptor` **before** `RequestIdMiddleware`.
  Middleware runs first in NestJS; the diagram inverts the one relationship that matters for
  understanding why `requestId` is present at all.
- `level` default is documented as `'info'`; the code uses `info` in production and `debug`
  otherwise.
- `bench/README.md` and the bench source still say "97 redact paths"; the current count is 140.
- `docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md` §2 shows `createRequire(import.meta.url)`;
  the shipped code uses `process.cwd()`.
- The same guideline calls `snake_case` "the OTel Logs Data Model wire format". OTLP/JSON uses
  proto3 JSON mapping — `traceId`, `spanId` (camelCase). The real reason to pick snake_case is
  parity with `@opentelemetry/instrumentation-pino`, whose default `logKeys` are
  `trace_id`/`span_id`/`trace_flags`. The option is right; the justification is not.
- `pino-pretty` ignores `pid,hostname,service` — but `pid`/`hostname` are never emitted.

### <a id="d-6"></a>D-6 · Volume and sampling — **P2**

`HTTP_REQUEST_START` fires at `info` for every non-excluded request, doubling access-log volume
against the terminal entry, with no independent switch. There is no log sampling of any kind, so
a hot loop or a retry storm has no damping mechanism inside the process — the only control is
`excludePaths` or the global level.

Log sampling **is** legitimately a logger concern (it is about what the process emits). Trace
head/tail sampling is not, and correctly does not exist here.

---

## 4. Architecture issues

1. **No coupling problems.** Zero dependencies, interface-defined sinks, API-only OTel, no
   backend-specific code. The vendor-neutrality requirement is already satisfied.
2. **Two competing error-serialization paths.** `sanitizeError` (rich, hardened, cause-aware)
   feeds `errorStructured` (flat, lossy), which discards most of what the first produced. One
   of them should own the shape.
3. **Two config surfaces for the same thing.** `otel.fieldFormat` plus three `*Field` overrides
   produce four ways to name three fields, but there is no equivalent knob for the far more
   consequential naming question (semconv attribute names for service/HTTP/error fields).
4. **`LogContextService.set()` throws; `get()` does not.** Asymmetric failure modes on a logging
   primitive.
5. **Public options that do nothing.** `isPretty` (**removed** — it was inert, and an option a
   consumer turns and then reasons from is worse than an absent one), `shouldUseAsNestLogger`
   (still `@deprecated`), `@LogContext`, `LOGGER_ERROR_CODES`. The last two are simply unfinished.
6. **Async path is not at parity with sync.** `forRootAsync` never auto-registers
   `HttpExceptionFilter`. The reasoning is documented and sound, but the asymmetry is a
   permanent DX trap.
7. **`DestinationRegistry.active` is authoritative for shutdown but not for writes.** A sink
   that failed `onInit` still receives writes. Documented, contained by the fail-soft wrapper —
   acceptable, but it means `getActive()` does not describe the write fan-out.
8. **Express-only.** `LoggableRequest`/`LoggableResponse` mirror Express (`setHeader`,
   `status().json()`). Honest in the JSDoc, but Fastify is a common NestJS deployment and there
   is no adapter seam.

---

## 5. Security issues

| ID  | Issue                                                                                    | Severity | Note                                                                      |
| --- | ---------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| S-1 | Auth headers not redacted by name outside `req.headers`/`res.headers`                    | **High** | [detail](#s-1)                                                            |
| S-2 | Redaction depth capped at 4 levels; deeper nesting leaks silently                        | Medium   | The walk-based fix in [P-1](#p-1) removes the cap entirely                |
| S-3 | `LOGGER_BOOTSTRAP_WARNING` promised by the README, never emitted                         | Medium   | Disabled redaction leaves no audit signal                                 |
| S-4 | Secrets interpolated into the `msg` string are never scrubbed                            | Medium   | Inherent to string messages; needs an explicit doc warning, not a feature |
| S-5 | Client `ip` logged by default (GDPR/LGPD personal data)                                  | Low-Med  | Opt-out only; regulated deployments need opt-in                           |
| S-6 | `excludePaths` regexes are consumer-supplied and run per request (ReDoS)                 | Low      | Documented; could be linted at `validateOptions` time                     |
| S-7 | `redactPaths` is not validated — a malformed path makes `fast-redact` throw at bootstrap | Low      | Fails loudly at boot, so low impact                                       |

Confirmed **not** issues (checked, sound): query-string stripping in both the interceptor and
the filter; trace/span ID validation; prototype-pollution guards in `run()` and `set()`;
correlation-id charset and length caps; circular-reference and `AggregateError` bounds in
`sanitizeError`; `node_modules` stack scrubbing; deep-frozen options; the fail-soft write path
and its stderr-only failure reporting; request/response bodies never being logged.

---

## 6. Performance issues

| ID  | Issue                                                                 | Severity   | Measured                                                                                                          |
| --- | --------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| P-1 | 108 wildcard redact paths dominate the pipeline                       | **High**   | 9,311 vs 552,000 ops/s; ~107 µs/entry                                                                             |
| P-2 | `HTTP_REQUEST_START` doubles access-log volume with no switch         | Medium     | 2× serialization + 2× sink I/O per request                                                                        |
| P-3 | No level guard before building the structured payload                 | Low-Med    | `emitStructured` spreads `metadata` and allocates before Pino checks the level — wasted work for a disabled level |
| P-4 | Wrapper allocates ~1.3 KB/op vs bare Pino's 24 B                      | Low        | Bench, advisory-only; dominated by GC sampling noise but the object spread is real                                |
| P-5 | `@LogPerformance` forces every decorated method to return a `Promise` | Low        | Documented; changes sync methods' effective signature                                                             |
| P-6 | `normalizeUrl` runs 4 global regexes per request                      | Negligible | Fixed quantifiers, no backtracking. Replaceable by the real route ([O-5](#o-5))                                   |

On P-3: `emitStructured` builds `{ ...metadata, logKey, userId, context }` unconditionally.
Pino's `logger.info()` then discards it if `info` is below the configured level. A
`this.pino.isLevelEnabled(level)` guard (or `pino.levels.values`) makes disabled levels free.
This matters most for `debug`/`trace` in production.

The mixin is **not** a performance problem: ALS `getStore()` plus `trace.getActiveSpan()` cost
~14% combined, and OTel detection is hoisted to construction time. That design is correct and
should not change.

---

## 7. Recommended architecture

The boundary does not move. What changes is what crosses it.

```
NestJS application
   │
   ├── @bymax-one/nest-logger ────────────────────────────────────┐
   │      structured JSON + request context + trace correlation   │
   │      · ALS: requestId, tenantId, userId                      │
   │      · OTel API (optional): traceId, spanId, traceFlags      │
   │      · resource: service.name/.version/.namespace/           │
   │                  .instance.id, deployment.environment.name   │
   │      · event.name (= logKey), severityNumber                 │
   │      · exception.type/.message/.stacktrace + error.type      │
   │      · http.request.method/.route/.response.status_code      │
   │      · redaction at source, name-based, unbounded depth      │
   │      · optional log sampling                                 │
   │      → NDJSON to stdout (or any ILogDestination)             │
   │                                                              │
   └── @opentelemetry/sdk-node  (consumer-owned, or later         │
          traces · metrics · resource · propagators                │
          → OTLP                                                   │
                                                                   │
   ┌───────────────────────────────────────────────────────────────┘
   ▼
OpenTelemetry Collector
   filelog/OTLP receiver · resource & transform processors ·
   tail sampling · redaction backstop · routing · batching
   ▼
Loki / Tempo / Mimir / Elastic / any OTLP-compatible backend
   ▼
Grafana · Bymax Live · any observability platform
```

`nest-logger` stays a **log producer**. It never exports, never samples traces, never speaks
OTLP. Everything it adds is a field in a JSON line that a Collector can map onto OTLP without
per-deployment glue.

---

## 8. Implementation plan

Every item below is scoped as: problem → current → desired → files → compatibility → performance
→ tests.

### P0 — Critical

---

#### P0-1 · Redact auth headers by name

- **Problem:** [S-1](#s-1). `authorization`/`cookie`/`set-cookie`/`x-api-key`/`x-auth-token` leak
  outside the `req.headers`/`res.headers` shapes.
- **Current:** covered only as five absolute paths.
- **Desired:** the same names in `REDACT_COMMON_FIELDS`, so they are covered at root and every
  wildcard depth (or at any depth, once P0-2 lands).
- **Files:** `src/server/constants/default-redact-paths.constants.ts`
- **Compatibility:** additive; honours the append-only contract. **No breaking change.**
- **Performance:** +5 field names. Under the current engine that is +20 wildcard paths and a
  further throughput loss — which is why this should land **together with or after P0-2**, not
  before it.
- **Tests:** redaction of a headers bag at root, one level deep, and under `req`; `set-cookie`
  hyphenated-key handling; the existing `DEFAULT_REDACT_PATHS` length assertion updated.

#### P0-2 · Replace default redaction with a single name-based walk

- **Problem:** [P-1](#p-1). 107 µs/entry; 99% of the pipeline.
- **Current:** 140 `fast-redact` paths, 108 of them wildcards, depth-capped at 4.
- **Desired:** one recursive copy-on-write walk of the merged record against a `Set` of
  sensitive field names, unbounded depth, cycle-guarded, with a node-count budget so a
  pathological payload cannot become O(N²). `redactPaths` continues to use `fast-redact` for
  consumer-supplied paths (skipped entirely when the array is empty).
- **Files:** new `src/server/utils/redact-by-name.util.ts`; `src/server/pino-factory.ts`;
  `src/server/constants/default-redact-paths.constants.ts` (keep the exported constant for
  backward compatibility, re-derive the name set from `REDACT_COMMON_FIELDS`);
  `src/server/utils/compile-redact-paths.util.ts`.
- **Compatibility:** output-compatible for every case the current defaults cover, and strictly
  broader (deeper nesting now covered). `DEFAULT_REDACT_PATHS` stays exported and unchanged in
  value, so nothing importing it breaks. An escape hatch
  (`redactStrategy: 'name-walk' | 'paths'`, default `'name-walk'`) lets a consumer with an exotic
  setup opt back into the old engine for one minor cycle.
- **Performance:** measured **10,117 → 943,240 ops/s** on an equivalent payload.
- **Tests:** output equivalence against the current engine across a matrix (root / depth 1–6 /
  arrays / arrays of objects / circular / `null` prototype / getters that throw); censor honoured;
  `shouldDisableDefaultRedact` still disables; consumer `redactPaths` still applied; interaction
  with the size-bounded serializer envelope; a bench assertion that the prod path stays within
  2× of the no-redaction baseline (the current 0.004× floor becomes meaningless and must be
  recalibrated).

#### P0-3 · Stop clobbering ALS context fields

- **Problem:** [C-1](#c-1). ALS `userId` is silently dropped from every structured log.
- **Current:** `emitStructured` / `errorStructured` write `userId: undefined` into the merge
  object, overwriting the mixin value.
- **Desired:** reserved fields are only written when defined. Precedence must be stated and
  tested: explicit argument > ALS store > absent.
- **Files:** `src/server/services/pino-logger.service.ts` (`emitStructured`, `errorStructured`,
  `emitNestStyle`).
- **Compatibility:** additive at runtime — a field that was disappearing now appears. Any query
  written to tolerate a missing `userId` still works. Worth a CHANGELOG "Fixed" entry because
  log volume/shape changes slightly.
- **Performance:** one conditional assignment instead of an unconditional one. Neutral to
  marginally positive.
- **Tests:** ALS `userId` reaches the record when the argument is omitted; the argument wins when
  both are present; the same for any custom key set via `LogContextService.set`; an e2e test
  through the real module (this is the test whose absence let the bug ship).

---

### P1 — Important

> **Status: SHIPPED.** P1-1, P1-6 and P1-7 landed with the P0 remediation (PR #82). P1-2, P1-3,
> P1-4 and P1-5 landed in the P1 release. Design rationale:
> [ADR 0001](./adr/0001-resource-identity-and-otel-correlation.md). Field inventory:
> [`semantic-convention-mapping.md`](./semantic-convention-mapping.md).
>
> | Item                                   | Status | Note                                         |
> | -------------------------------------- | :----: | -------------------------------------------- |
> | P1-1 `LogEntry` type + README examples |   ✅   | Shipped in 1.2.0                             |
> | P1-2 stable resource attributes        |   ✅   | With one correction below                    |
> | P1-3 `event.name`                      |   ✅   | With one correction below                    |
> | P1-4 semconv errors + cause chain      |   ✅   | Plus a second layer of the `err.type` defect |
> | P1-5 robust OTel detection             |   ✅   | Measured against a hostile CWD               |
> | P1-6 reserved keys emitted             |   ✅   | Shipped in 1.2.0                             |
> | P1-7 README API reference              |   ✅   | Shipped in 1.2.0                             |
>
> **Two things this audit got wrong**, found by verifying against the specification on 2026-08-13
> rather than trusting the plan:
>
> 1. **There is no `OTEL_SERVICE_VERSION` environment variable.** P1-2 below prescribes reading it.
>    The specification defines `OTEL_SERVICE_NAME` only; version comes from
>    `OTEL_RESOURCE_ATTRIBUTES`. Implemented accordingly.
> 2. **The `event.name` attribute is Deprecated.** P1-3 below prescribes emitting it as an
>    attribute. Semantic Conventions now require the value to be set as the LogRecord's top-level
>    `EventName` field. The implementation emits a configurable JSON key documented as the carrier
>    for that mapping, never as an OTLP attribute.
>
> A third correction is about the audit's own method: the HTTP findings that P0 missed (guard
> rejections unlogged, aborted requests logged as successes) were defects of POSITION in the
> pipeline, not of any component's contract. This audit reviewed components against their own
> contracts. A pass asking "what does the pipeline as a whole never emit" is what would have caught
> them.

---

#### P1-1 · Correct the published `LogEntry` type and the README examples

- **Problem:** [C-2](#c-2). The type says `level: number` / `time: number`; the runtime emits a
  string label and an ISO string. Two README destination examples fail at runtime.
- **Desired:** `level: LogLevel` (string), `time: string`, both matching the shipped behaviour;
  README's Loki example parses the ISO timestamp with `Date.parse`; the Prisma example maps the
  label through `PINO_LEVEL_NUMBERS` if it wants a number; the sample output shows `"level": "info"`.
- **Files:** `src/shared/types/log-entry.type.ts`, `README.md`, `docs/technical_specification.md`.
- **Compatibility:** a **compile-time** break for anyone who relied on the wrong type — but the
  runtime was never what the type claimed, so any such code was already broken. Ship as a
  **minor** with an explicit CHANGELOG note, not a major. Consider exporting
  `PINO_LEVEL_NUMBERS`/`PINO_LEVEL_NAMES` from `/shared` so consumers can convert.
- **Performance:** none.
- **Tests:** a schema test asserting the emitted record's `level` and `time` types against
  `LogEntry`; extend `check:published` to **execute** (not just compile) the README destination
  snippets against a real serialized line.

#### P1-2 · Emit stable resource attributes

- **Problem:** [O-2](#o-2). No instance, namespace, or environment identity.
- **Desired:** `ServiceMetadata` gains optional `namespace`, `instanceId`, `environment`;
  emitted as `service.namespace`, `service.instance.id`, `deployment.environment.name`. Defaults
  read from `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `OTEL_RESOURCE_ATTRIBUTES` and
  `NODE_ENV` when the option is omitted, so the SDK and the logger share one source of truth.
  Add `resourceFormat: 'nested' | 'flat'` (default `'nested'`).
- **Files:** `src/shared/types/service-metadata.type.ts`, `src/server/config/default-options.ts`,
  `src/server/config/validate-options.ts`, `src/server/pino-factory.ts` (the `base` binding),
  `README.md`.
- **Compatibility:** fully additive — new fields are optional, the nested default is unchanged.
- **Performance:** three more keys in `base`, serialized once per entry as a pre-computed string
  by Pino. Negligible.
- **Tests:** each attribute present when configured and absent when not; env-var fallback
  precedence; flat vs nested formats; `OTEL_RESOURCE_ATTRIBUTES` parsing (including malformed
  input not throwing at bootstrap).

#### P1-3 · Add `event.name` alongside `logKey`

- **Problem:** [O-3](#o-3). The library's event identifier has no OTel-recognised name.
- **Desired:** `eventNameField` option (default: emit `event.name` mirroring `logKey`;
  `false` disables). `logKey` is **never** removed or renamed.
- **Files:** `src/server/services/pino-logger.service.ts`, `src/server/config/default-options.ts`,
  `src/server/interfaces/logger-module-options.interface.ts`, `README.md`,
  `docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md`.
- **Compatibility:** additive. One extra key per structured entry (~20 bytes).
- **Performance:** one property assignment. Negligible.
- **Tests:** present by default; suppressible; identical to `logKey`; absent on NestJS-variadic
  calls that have no log key.
- **Explicitly not doing:** adopting `@opentelemetry/api-logs`. See [Phase 9](#9-challenging-the-requirements).

#### P1-4 · Semconv-aligned error fields and a full cause chain

- **Problem:** [O-4](#o-4). `err.*` instead of `exception.*`; no `error.type`; cause chains
  dropped; no `fatalStructured`.
- **Desired:** `errorStructured` consumes `sanitizeError` output directly (keeping `cause` and
  `errors`); an `errorFormat: 'pino' | 'semconv' | 'both'` option (default `'pino'` for
  compatibility, `'both'` recommended) adds `exception.type` / `exception.message` /
  `exception.stacktrace` and a low-cardinality `error.type`; add `fatalStructured` (or remove it
  from the README — pick one).
- **Files:** `src/server/services/pino-logger.service.ts`,
  `src/server/utils/sanitize-error.util.ts`, `src/server/filters/http-exception.filter.ts`,
  `src/server/interfaces/logger-module-options.interface.ts`, `README.md`.
- **Compatibility:** additive under the default; `'semconv'` mode is opt-in.
- **Performance:** `sanitizeError` already runs on the filter path — reusing its output is
  _cheaper_ than re-serializing. Cause-chain traversal is depth- and width-bounded already.
- **Tests:** cause chain reaches the record; `AggregateError` members reach it; circular cause;
  each `errorFormat` mode; `error.type` for `HttpException` vs a plain `Error`; stack still
  scrubbed.

#### P1-5 · Make OTel detection robust

- **Problem:** [O-1](#o-1). CWD-anchored resolution silently disables all trace correlation.
- **Desired:** resolve from the module's own location first (`import.meta.url` in the ESM bundle,
  `__dirname` in the CJS bundle — tsup can emit both), falling back to `process.cwd()`. When
  `shouldAutoInjectTraceContext` is `true` **and** resolution fails, emit exactly one
  `LOGGER_BOOTSTRAP_WARNING` naming `LOGGER_OTEL_API_UNAVAILABLE`, so a missing peer is visible
  instead of invisible.
- **Files:** `src/server/utils/otel-detector.ts`, `src/server/pino-factory.ts` or
  `src/server/logger.module.ts` (the warning emission), `tsup.config.ts` if a banner is needed,
  `docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md` §2.
- **Compatibility:** additive; one extra startup line in the failure case only.
- **Performance:** unchanged — resolution still happens once at build time.
- **Tests:** resolution succeeding from module location with a hostile CWD; falling back to CWD;
  the warning emitted once and only when auto-injection is on; **no** warning when
  auto-injection is off.

#### P1-6 · Emit the reserved keys the docs promise, or delete them

- **Problem:** [D-1](#d-1). `LOGGER_BOOTSTRAP_WARNING` is a documented security signal that
  never fires; `LOGGER_SHUTDOWN_OK` and `HTTP_REQUEST_COMPLETED` are catalog-only.
- **Desired:** emit `LOGGER_BOOTSTRAP_WARNING` when `shouldDisableDefaultRedact` is on (and for
  the OTel case in P1-5); emit `LOGGER_SHUTDOWN_OK` from `DestinationRegistry.onApplicationShutdown`;
  either emit `HTTP_REQUEST_COMPLETED` or remove it from the catalog and the README.
- **Files:** `src/server/logger.module.ts`, `src/server/services/destination-registry.service.ts`,
  `src/shared/constants/reserved-log-keys.constants.ts`, `README.md`.
- **Compatibility:** additive (new entries at boot/shutdown only). Removing an unused key from
  `RESERVED_LOG_KEYS` is technically a type-level break — prefer keeping it and emitting it.
- **Performance:** none (boot/shutdown only).
- **Tests:** the warning is emitted exactly once when redaction is disabled and never otherwise;
  shutdown entry emitted; the reserved-key catalog test asserts **every** declared key is
  emitted by some code path (this test is what prevents the class of defect recurring).

#### P1-7 · Correct the README API reference and architecture diagram

- **Problem:** [D-4](#d-4), [D-5](#d-5). Six wrong signatures, a non-existent method, a decorator
  described as doing something it does not, and an inverted pipeline diagram.
- **Desired:** the table matches the source; `@LogContext` documented as metadata-only (or
  implemented — see P2-1); diagram shows middleware → interceptor → handler.
- **Files:** `README.md`, `AGENTS.md`, `bench/README.md` (97 → 140 paths),
  `docs/guidelines/OTEL-INTEGRATION-GUIDELINES.md` (§2 detection snippet, §6 snake_case
  justification).
- **Compatibility:** none.
- **Performance:** none.
- **Tests:** extend `check:published` to assert that every method named in the README API table
  exists on the built `PinoLoggerService` prototype.
- **Release note:** `README.md` is in `files`, so per this repo's own rule these fixes ship as a
  patch release with a verified-unchanged `dist/`.

---

### P2 — Improvements

---

#### P2-1 · Finish or remove `@LogContext`

Implement it as a **method** decorator that wraps the call in `logContext.run(...)` (matching
what the README already claims), or delete the decorator and its README row. Files:
`src/server/decorators/log-context.decorator.ts`, `src/server/index.ts`, `README.md`. Removal is
a breaking export change; implementing is additive. **Recommend implementing.**

#### P2-2 · Delete `LOGGER_ERROR_CODES`

Not exported, not referenced, not emitted ([D-2](#d-2)). Deleting is invisible to consumers.
Keep the README's error catalog as prose. Files:
`src/server/errors/logger-error-codes.constants.ts` (+ spec).

#### P2-3 · Real `http.route` from NestJS

Read `req.route?.path` (Express) or `Reflector` + `PATH_METADATA` on the handler, falling back
to `normalizeUrl`. Removes the false-collapse cases in [O-5](#o-5). Files:
`src/server/interceptors/http-logging.interceptor.ts`,
`src/server/interfaces/http-context.interface.ts`. Additive field; `url` keeps its current
value for compatibility. Tests: parametrised routes, wildcard routes, 404s with no matched
route, non-Express fallback.

#### P2-4 · Semconv HTTP attribute names (opt-in)

`http: { attributeFormat: 'bymax' | 'semconv' | 'both' }`, default `'bymax'`. Maps `method` →
`http.request.method`, `statusCode` → `http.response.status_code`, `url` → `http.route`,
`fullUrl` → `url.path`, `ip` → `client.address`, `userAgent` → `user_agent.original`.
Additive; `'both'` doubles those six keys' bytes on HTTP entries only.

#### P2-5 · Optional `severityNumber`

[O-6](#o-6). One extra numeric field mapping Pino levels to OTel SeverityNumber. Default off,
one option to turn on. Files: `src/server/pino-factory.ts` (`formatters.level`).

#### P2-6 · Level guard before payload construction

[P-3](#p-3). `if (!this.pino.isLevelEnabled(level)) return` before spreading `metadata`. Makes
disabled `debug`/`trace` free in production. Files:
`src/server/services/pino-logger.service.ts`. Tests: no allocation and no serializer invocation
for a disabled level.

#### P2-7 · `http.shouldLogRequestStart` and optional log sampling

[D-6](#d-6), [P-2](#p-2). A flag to suppress `HTTP_REQUEST_START` (default `true` for
compatibility, `false` recommended in the docs), plus an opt-in sampler:
`sampling: { rate, alwaysLogAtOrAbove: 'warn', keyBy: 'logKey' }`, **default disabled**. Errors
and warnings must never be sampled out. Explicitly documented as _log_ sampling, distinct from
trace head/tail sampling, which stay with the SDK and the Collector.

#### P2-8 · `LogContextService.set()` should not throw

Make it a no-op returning `false` outside a scope (or add `trySet`). A logging primitive
crashing a background job is the wrong failure mode. Breaking behaviour change for anyone
catching the throw — ship behind `set()` returning `boolean` in a minor, keep the throw only
under an explicit `strict` option.

#### P2-9 · Auto-wire `RequestIdMiddleware` when `http.isEnabled`

Today `http.isEnabled: true` yields an access log with no `requestId` unless
`applyRequestIdMiddleware` is also called. `BymaxLoggerModule` can implement `NestModule` and
call `configure()` itself. Additive; keep the helper exported for custom route scoping.

#### P2-10 · Documentation: cardinality and the field taxonomy

Add `docs/guidelines/CARDINALITY-AND-FIELDS.md` stating which emitted fields are **bounded**
(`level`, `logKey`/`event.name`, `service.*`, `deployment.environment.name`, `http.route`,
`http.request.method`, `http.response.status_code`, `error.type`) and therefore safe as metric
labels or `group by` dimensions, versus **unbounded** (`requestId`, `traceId`, `spanId`,
`userId`, `tenantId` above top-N, `url.path`, arbitrary ids) which are search and drill-down
keys only. This knowledge currently lives only in the Obsidian vault; it belongs in the repo.

---

### Future — not `nest-logger`

| Capability                                  | Belongs to                                         |
| ------------------------------------------- | -------------------------------------------------- |
| OTel SDK bootstrap, resource, propagators   | `@bymax-one/nest-observability`                    |
| Tracing, spans, manual instrumentation      | OTel SDK (wrapped by `nest-observability`)         |
| Metrics, RED metrics, histograms, exemplars | OTel SDK + Collector + backend                     |
| OTLP / trace exporters                      | OTel SDK, configured by `nest-observability`       |
| Tail-based trace sampling                   | OTel Collector                                     |
| Continuous profiling, eBPF                  | Pyroscope / Grafana Alloy / Beyla — infrastructure |
| SLI/SLO, error budgets, burn-rate alerts    | Backend (Mimir/Prometheus rules) or Bymax Live     |
| Anomaly detection, AI root-cause            | Bymax Live                                         |
| Incident management                         | Bymax Live / PagerDuty                             |
| MCP server                                  | Bymax Live                                         |
| Storage, dashboards                         | Backend / Grafana / Bymax Live                     |

---

## Phase 2 — What does **not** belong in `nest-logger`

| Capability                | Owner                                 | Reasoning                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metrics                   | **OTel SDK**                          | Different data model (aggregation, temporality, cardinality limits). A logger emitting metrics would need an exporter and a periodic reader — both SDK concerns.                                                        |
| RED metrics               | **Backend** (derived) or **OTel SDK** | RED can be _derived_ from `HTTP_REQUEST_*` + duration at query time (the vault's own Observability recipe). Computing it in-process duplicates the backend.                                                             |
| Native histograms         | **Backend** (Prometheus/Mimir)        | A storage/encoding feature, not an instrumentation one.                                                                                                                                                                 |
| Exemplars                 | **OTel SDK**                          | Exemplars attach trace IDs to _metric_ samples. No metrics here, so nothing to attach to.                                                                                                                               |
| Distributed tracing impl. | **OTel SDK**                          | The logger must _read_ trace context, never create or manage it. Creating spans would fight auto-instrumentation.                                                                                                       |
| Trace exporters / OTLP    | **OTel SDK**                          | Would force a transport dependency and an endpoint config into a library whose selling point is zero dependencies.                                                                                                      |
| Tail-based sampling       | **OTel Collector**                    | Requires buffering complete traces across services — impossible in one process, by definition.                                                                                                                          |
| Continuous profiling      | **Infrastructure**                    | Needs a runtime profiler agent; unrelated to log emission.                                                                                                                                                              |
| eBPF instrumentation      | **Infrastructure**                    | Kernel-level, out-of-process.                                                                                                                                                                                           |
| SLI/SLO calculation       | **Backend** / **Bymax Live**          | Needs a time window and a query engine over historical data.                                                                                                                                                            |
| Error budgets             | **Bymax Live**                        | A policy artifact on top of SLOs.                                                                                                                                                                                       |
| Burn-rate alerts          | **Backend** / **Bymax Live**          | Multiwindow multi-burn-rate needs the full metric history.                                                                                                                                                              |
| Anomaly detection         | **Bymax Live**                        | Needs cross-service baselines the process cannot see.                                                                                                                                                                   |
| Incident management       | **Bymax Live**                        | Workflow, not telemetry.                                                                                                                                                                                                |
| AI root-cause analysis    | **Bymax Live**                        | Needs logs + traces + metrics + deploys correlated. The logger's job is to make its slice _correlatable_ — see Phase 4.                                                                                                 |
| MCP server                | **Bymax Live**                        | An interface onto stored telemetry.                                                                                                                                                                                     |
| Observability storage     | **Backend**                           | `ILogDestination` is the seam; a storage client is a consumer implementation.                                                                                                                                           |
| Dashboards                | **Grafana / Bymax Live**              | Presentation.                                                                                                                                                                                                           |
| **Log** sampling          | **`nest-logger`** (opt-in)            | The only item on this list that _is_ a logger concern: it governs what this process emits, needs no cross-service state, and cannot be done as well downstream (the Collector pays the serialization cost first). P2-7. |
| Log redaction             | **`nest-logger`**                     | Must happen before the data leaves the process. A Collector-side scrubber is a backstop, not a control.                                                                                                                 |

The library currently violates none of these boundaries.

---

## Phase 3 — A future `@bymax-one/nest-observability`

**Verdict: yes, eventually — and it must be a separate package.**

Why separate rather than adding to `nest-logger`:

1. **Dependency weight.** A tracing/metrics bootstrap needs `@opentelemetry/sdk-node`,
   `auto-instrumentations-node`, `exporter-trace-otlp-http`, `exporter-metrics-otlp-http`,
   `resources`, `semantic-conventions` — well over a hundred transitive packages. `nest-logger`'s
   `"dependencies": {}` is a genuine security property (it is why the OpenSSF Scorecard badge
   means something here). Folding the SDK in would destroy it for every consumer who only wants
   logs.
2. **Different lifecycle.** The SDK must start **before** any instrumented module is imported —
   a `--import` preload or the top of `main.ts`. A NestJS dynamic module runs far too late.
   These are not the same kind of artifact.
3. **Different stability.** The OTel JS SDK is `0.2xx` and ships breaking changes routinely.
   `nest-logger` is `1.x` under semver. Coupling them forces the stable package to inherit the
   unstable one's release cadence.
4. **Different consumers.** A worker, a CLI or a Lambda may want structured logs and no tracing
   at all.

What it should do:

```
@bymax-one/nest-observability
  ├─ bootstrapObservability()      // called from --import or the top of main.ts
  │    · Resource from OTEL_* env  (service.name/.version/.namespace/.instance.id,
  │                                 deployment.environment.name)
  │    · OTLP trace + metric exporters, endpoint from OTEL_EXPORTER_OTLP_ENDPOINT
  │    · auto-instrumentations with Bymax defaults (fs off, http/pg/redis/ioredis on)
  │    · W3C propagators; graceful shutdown on SIGTERM
  ├─ BymaxObservabilityModule.forRoot()
  │    · imports BymaxLoggerModule, feeding it the SAME resource attributes
  │    · health/readiness endpoints
  │    · runtime instrumentation (event-loop lag, GC, heap) as OTel metrics
  └─ escape hatches: every OTel object returned, nothing hidden, all defaults overridable
```

Non-negotiables: no Bymax Live endpoint, no vendor exporter, nothing that prevents a consumer
from configuring the SDK themselves, and **`nest-logger` must remain independently usable with
no knowledge that `nest-observability` exists**. The dependency arrow points one way only:
`nest-observability → nest-logger`, never the reverse.

**Do not build it yet.** Build it after P0/P1 here land, and after the resource-attribute
contract (P1-2) is stable — that contract is the interface between the two packages.

---

## Phase 4 — Bymax Live compatibility

`nest-logger` must not, and does not, depend on Bymax Live. The question is only whether the
data it owns is standardized enough for an agent to correlate.

For an agent to answer _"why did checkout start failing?"_ it must traverse:

```
error → log → traceId → trace → service → service.version → deployment → code
```

| Link                  | Field required                                        | Today                           |
| --------------------- | ----------------------------------------------------- | ------------------------------- |
| error → log           | a stable error classifier                             | ⚠️ `err.type` (no `error.type`) |
| log → trace           | `traceId` / `spanId`                                  | ✅ present and validated        |
| trace → service       | `service.name`                                        | ✅ (nested)                     |
| service → version     | `service.version`                                     | ✅ (nested)                     |
| version → deployment  | `deployment.environment.name` + `service.instance.id` | ❌ absent                       |
| event identity        | `event.name`                                          | ❌ (`logKey` only)              |
| severity for triage   | `SeverityNumber`                                      | ⚠️ string label only            |
| "when did this start" | monotonic, timezone-unambiguous timestamp             | ✅ ISO 8601 UTC                 |

So **four of eight links are missing or non-standard**, and all four are addressed by P1-2,
P1-3, P1-4 and P2-5. After those, a log line from any Bymax service carries everything an agent
needs to pivot to a trace, a service, a version, an environment and an instance — using only
OTel-standard names, with no Bymax-specific field and no Bymax-specific dependency.

The correct integration path stays: `nest-logger` → NDJSON → Collector → OTLP → _any_ backend,
with Bymax Live as one possible consumer of that OTLP stream. Nothing in this plan makes Bymax
Live a privileged destination.

---

## Phase 5 — Backward compatibility

### Public API inventory (from `src/server/index.ts`)

**Classes/values:** `BymaxLoggerModule`, `PinoLoggerService`, `LogContextService`,
`DefaultStdoutDestination`, `PrettyDevDestination`, `HttpExceptionFilter`,
`HttpLoggingInterceptor`, `applyRequestIdMiddleware`, `RequestIdMiddleware`, `InjectLogger`,
`LogContext`, `LOG_CONTEXT_METADATA_KEY`, `LogPerformance`, `LOGGER_OPTIONS_TOKEN`,
`LOGGER_PINO_INSTANCE_TOKEN`, `LOGGER_DESTINATIONS_TOKEN`, `LOG_CONTEXT_TOKEN`,
`DEFAULT_REDACT_PATHS`, `LOG_KEYS_CONVENTION_REGEX`, `RESERVED_LOG_KEYS`.

**Types:** `ILogDestination`, `IncomingHeaders`, `LoggableRequest`, `LoggableResponse`,
`NextHandler`, `BymaxLoggerModuleOptions`, `BymaxLoggerModuleAsyncOptions`,
`BymaxLoggerModuleOptionsFactory`, `ResolvedBymaxLoggerModuleOptions`, `HttpOptions`,
`OtelOptions`, `LogContextBag`, `LogLevel`, `LogEntry`, `ServiceMetadata`.

**Shared subpath:** `LogLevel`, `LogEntry`, `ServiceMetadata`, `LOG_KEYS_CONVENTION_REGEX`,
`RESERVED_LOG_KEYS`, `ReservedLogKey`.

### Compatibility verdict per change

| Change                           | Kind                 | Impact                                                                                              |
| -------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| P0-1 header redaction            | additive             | none (append-only contract honoured)                                                                |
| P0-2 redaction engine            | behaviour, additive  | same or broader output; `DEFAULT_REDACT_PATHS` stays exported unchanged; opt-out flag for one cycle |
| P0-3 ALS `userId`                | behaviour            | a field that was missing now appears — CHANGELOG "Fixed"                                            |
| P1-1 `LogEntry` type             | **type-level break** | only breaks code that relied on a type the runtime never satisfied. Minor + note                    |
| P1-2 resource attributes         | additive             | new optional fields                                                                                 |
| P1-3 `event.name`                | additive             | one new key; disableable                                                                            |
| P1-4 error fields                | additive             | default `errorFormat: 'pino'` preserves today's shape exactly                                       |
| P1-5 OTel detection              | additive             | one new warning line in a failure case                                                              |
| P1-6 reserved keys               | additive             | new boot/shutdown entries                                                                           |
| P1-7 docs                        | none                 | patch release (README ships)                                                                        |
| P2-1 `@LogContext`               | additive             | if implemented; **breaking** if removed                                                             |
| P2-2 delete `LOGGER_ERROR_CODES` | none                 | never exported                                                                                      |
| P2-3/P2-4 HTTP fields            | additive             | new fields; renaming only under an opt-in mode                                                      |
| P2-8 `set()` no longer throws    | behaviour            | breaks anyone catching the throw — gate behind an option                                            |
| P2-9 auto-wire middleware        | additive             | a `requestId` appears where none did; double-wiring must be idempotent                              |

**No major version is required.** Every P0 and P1 item is additive or fixes behaviour that
contradicted its own documentation. The only genuine break is the `LogEntry` type, which is a
correction of a type that never described the runtime — a minor with an explicit note is
proportionate. Deprecate before removing: `isPretty` **was removed in the Unreleased line** (inert,
type-only break, migration documented in the CHANGELOG); `shouldUseAsNestLogger` is still
`@deprecated` and should go alongside `LOGGER_ERROR_CODES` and, if the decision goes that way,
`@LogContext`.

---

## Phase 6 — Performance analysis

Measured on Node 24.18, Apple Silicon, no-op sink, ~200-byte structured payload.

| Concern                    | Finding                                                                                                                  | Severity |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| Redaction                  | 108 wildcard paths → **107 µs/entry**, 99% of pipeline cost                                                              | **High** |
| Serialization              | Pino's own; ~0.9 µs/entry unredacted. Not a problem.                                                                     | None     |
| AsyncLocalStorage lookup   | Part of the 14% mixin cost. `getStore()` is a near-free read on Node 24.                                                 | None     |
| OTel context lookup        | Also in that 14%; detection hoisted to construction. Correct.                                                            | None     |
| Serializers                | Size-bounded wrapper adds one `JSON.stringify` **per serialized field** — only `err` and custom fields, not every entry. | Low      |
| Object cloning             | `emitStructured` spreads `metadata` on every call: ~1.3 KB/op vs bare Pino's 24 B.                                       | Low-Med  |
| Sync vs async destinations | `destinationToStream` awaits promises correctly; back-pressure is Pino's. Stdout sink is sync and cheap.                 | None     |
| Stack generation           | Only on the error path; `sanitizeError` is depth- and width-bounded.                                                     | None     |
| Level-disabled work        | Payload built **before** Pino checks the level — wasted allocation for disabled `debug`/`trace`.                         | Low-Med  |
| Dev vs prod                | `PrettyDevDestination` opt-in, never active by default. Level default flips on `NODE_ENV`.                               | None     |
| Bundle size                | 12.84 KiB server subpath, gated at 13.5 KiB brotli.                                                                      | None     |

Every proposal in §8 is either performance-neutral or performance-positive. P0-2 alone recovers
roughly two orders of magnitude. The bench's `THROUGHPUT_BUDGET = 0.004` floor becomes
meaningless after it and must be recalibrated in the same PR — otherwise the gate silently stops
gating.

---

## Phase 7 — Testing requirements

Current suite: **297 unit `it()`s** across co-located specs, **36 e2e `it()`s**, 100%
statements/branches/functions/lines, Stryker at 97.42% with `break: 95`. That is a strong
suite — but the C-1 defect proves that coverage of _lines_ is not coverage of _behaviour
across layers_: no test asserts that a value placed in the ALS store reaches a serialized record.

| Area                                      | Status | Gap                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `traceId`/`spanId` correlation            |   ⚠️   | Covered — but with `detectOtelTraceApi` **mocked**. No test runs against a real SDK.                                                                                                                                                                                                                    |
| Request with no active span               |   ✅   | e2e covered.                                                                                                                                                                                                                                                                                            |
| Concurrent request isolation              |   ❌   | ALS isolation is unit-tested with two parallel `run()` calls; **no e2e** issuing overlapping HTTP requests and asserting no `requestId`/`tenantId` bleed.                                                                                                                                               |
| ALS context leakage                       |   ⚠️   | Partially — see above.                                                                                                                                                                                                                                                                                  |
| Nested async operations                   |   ❌   | No test chaining `setTimeout` → `await` → `queueMicrotask` inside one scope and asserting the context survives.                                                                                                                                                                                         |
| **ALS field reaches the record**          |   ❌   | **The missing test that let [C-1](#c-1) ship.** Highest priority.                                                                                                                                                                                                                                       |
| Errors                                    |   ✅   | Well covered, including hostile inputs.                                                                                                                                                                                                                                                                 |
| Error `cause` chain in the emitted record |   ❌   | `sanitizeError` is tested in isolation; the loss at the `errorStructured` boundary is untested.                                                                                                                                                                                                         |
| Redaction                                 |   ✅   | Good e2e coverage.                                                                                                                                                                                                                                                                                      |
| **Nested redaction beyond depth 4**       |   ❌   | No test asserts the depth-4 ceiling exists — so nobody notices the leak past it.                                                                                                                                                                                                                        |
| **Header-bag redaction**                  |   ❌   | The gap in [S-1](#s-1) is untested in either direction.                                                                                                                                                                                                                                                 |
| Custom context keys                       |   ⚠️   | `set()`/`get()` unit-tested; not asserted end-to-end in a record.                                                                                                                                                                                                                                       |
| Service metadata                          |   ✅   | Present in every e2e assertion.                                                                                                                                                                                                                                                                         |
| Production JSON format                    |   ⚠️   | Asserted field-by-field, never as a **whole-record schema contract**. A schema snapshot would have caught [C-2](#c-2).                                                                                                                                                                                  |
| OTel disabled                             |   ✅   | Covered.                                                                                                                                                                                                                                                                                                |
| OTel enabled                              |   ⚠️   | Mocked only.                                                                                                                                                                                                                                                                                            |
| **`@opentelemetry/api` genuinely absent** |   ❌   | Never exercised — and [O-1](#o-1) makes this the realistic failure mode.                                                                                                                                                                                                                                |
| Auto-instrumentation compatibility        |   ❌   | None. The vault records why (HTTP server auto-instrumentation does not produce spans under Jest/ESM on Node ≤ 22) — but a **manual** `tracer.startActiveSpan` integration test with a real `NodeSDK` + `AsyncLocalStorageContextManager` and an `InMemorySpanExporter` is entirely feasible on Node 24. |
| Backward compatibility                    |   ⚠️   | `check:published` compiles README snippets against `dist/`; it does not **execute** them, which is why [C-2](#c-2) survived.                                                                                                                                                                            |

### Recommended additions

1. **`test/e2e/logger-context-propagation.e2e-spec.ts`** — ALS `userId`/custom keys reach the
   record; explicit argument precedence; nested async chains; 50 concurrent supertest requests
   asserting zero `requestId` cross-contamination.
2. **`test/integration/otel-real-sdk.spec.ts`** — real `NodeSDK` with
   `AsyncLocalStorageContextManager` + `InMemorySpanExporter`; a manual `startActiveSpan` around
   a logger call; assert the emitted `traceId` equals the exporter's recorded span. This closes
   the "we only ever tested our own mock" gap.
3. **A whole-record schema contract test** — one canonical entry validated field-by-field
   _against the exported `LogEntry` type_ (types and runtime asserted together), so the two can
   never drift again.
4. **Redaction matrix test** — depths 0–6, arrays, arrays of objects, header bags at three
   shapes, `null`-prototype objects, and (post-P0-2) an equivalence assertion against the
   `fast-redact` engine.
5. **A reserved-key completeness test** — every key in `RESERVED_LOG_KEYS` must be emitted by
   some code path, or explicitly listed as reserved-for-future with a reason.
6. **Executing README snippets** in `check:published`, not just compiling them.

---

## Phase 8 — see §§1–8 above

Sections 1–8 of this document are the report the prompt's Phase 8 asks for.

---

## Phase 9 — Challenging the requirements

Where the prompt's guidance should **not** be followed as written:

1. **"Do not invent custom names when a semantic convention exists" → do not _rename_, _add_.**
   `logKey`, `requestId`, `msg` and `service` predate or sit outside semconv, and every Bymax
   dashboard, LogQL query and alert keys on them. Renaming would be a fleet-wide breaking change
   for zero functional gain. Dual emission behind an option gets the standard names into the
   pipeline at the cost of a few bytes, and lets the Collector drop whichever half a given
   backend does not want.

2. **`event.name`: adopt the attribute, not the API.** The LogRecord `EventName` field is part
   of the stable Logs Data Model, so emitting an `event.name` attribute is safe. But the OTel JS
   **Logs Bridge API** (`@opentelemetry/api-logs@0.221.0`) is self-described as _"alpha software
   with no guarantee of stability or long-term support"_, and the event **registry** is still in
   Development. A library with a 100%-coverage, mutation-tested release gate should not take an
   alpha API as a peer dependency. Recommendation: **attribute yes, API no** — revisit when
   `api-logs` merges into `@opentelemetry/api`.

3. **`deployment.environment` is deprecated — use `deployment.environment.name`.** The repo's
   own OTel guideline (§4) and the README both still show the deprecated `'deployment.environment'`
   key in their `resourceFromAttributes` example. That is a doc fix, not just a code one.

4. **`service.namespace` and `service.instance.id` are Stable in semconv 1.44.0** and safe to
   adopt. Note that the service _entity_ requirement levels mark them Required — but that is a
   requirement on a fully-specified OTel Resource, not on a log record. Treat them as optional
   in the logger's own options and emit them only when known; emitting a fabricated
   `service.instance.id` is worse than omitting it.

5. **Sampling: the prompt's split is right, with one refinement.** Log sampling belongs here
   (opt-in, never sampling out `warn`+); trace head sampling belongs to the SDK; tail sampling
   belongs to the Collector. But the prompt frames log sampling as merely "may support" — given
   the measured 107 µs/entry cost and the doubled HTTP volume, a rate limiter is a more
   immediately useful lever than several of the semconv items.

6. **"Do not sacrifice application performance for unnecessary metadata" — agreed, and the
   library is already sacrificing it for _necessary_ metadata inefficiently.** Every semconv
   field proposed here costs a property assignment (nanoseconds). The redaction strategy costs
   107 µs. Fixing the second buys enough headroom for all of the first several thousand times
   over. Ordering matters: **P0-2 before every P1 field addition.**

7. **The prompt's architecture is already the implemented architecture.** It is worth saying
   plainly rather than implying a rewrite: `nest-logger` does not depend on Grafana, Loki, Tempo,
   Prometheus, Datadog, New Relic or Bymax Live; it does not initialize an SDK; it does not
   export OTLP; it does not force a Collector configuration. The requirement is met. What is not
   met is field-level standardization and pipeline performance.

8. **One item in the prompt is a non-goal here:** "detects the active OpenTelemetry span",
   "extracts traceId", "extracts spanId", "preserves trace context across asynchronous
   operations", "supports W3C Trace Context" — all five already work correctly, including the
   subtle unsampled-span case that most implementations get wrong. No work is needed.

---

## Phase 10 — Final recommendation

### **B — `nest-logger` needs architectural improvements, but should remain a focused logging library.**

Not **A**, because the defects are not incremental polish: a P0 security gap on auth headers, a
P0 correctness bug that silently drops the authenticated user from every structured log, and a
production path running at 0.7% of its achievable throughput are not "incremental improvements".

Not **C**, because responsibilities are **not** mixed. The package contains no metrics, no
tracing SDK, no exporters, no backend clients and no vendor coupling. There is nothing to move
out. `@bymax-one/nest-observability` should exist — but as a **new layer above**, not as a
rescue operation for a logger that overreached.

### Target architecture

```
NestJS application
   │
   ├──▶ @bymax-one/nest-observability          (future, optional)
   │        · OTel SDK bootstrap + Resource + propagators
   │        · auto-instrumentation with Bymax defaults
   │        · traces + metrics → OTLP
   │        · imports and configures ↓ with the SAME resource attributes
   │
   └──▶ @bymax-one/nest-logger                 (today, standalone)
            · structured JSON, semconv-aligned fields
            · ALS request context (requestId, tenantId, userId)
            · OTel API only — reads the active span, never creates one
            · redaction at source, name-based, unbounded depth
            · ILogDestination fan-out
            → NDJSON on stdout
                       │
                       ▼
            OpenTelemetry Collector
              receivers · resource/transform processors ·
              tail sampling · redaction backstop · batching
                       │
                       ▼
            Loki · Tempo · Mimir · Elastic · any OTLP backend
                       │
                       ▼
            Grafana · Bymax Live · any platform
```

`nest-logger` remains fully usable on its own: install it, pass `service`, get correlated
structured logs. `nest-observability` is additive sugar for teams that want the whole pipeline
wired for them. The dependency arrow never reverses.

### Suggested sequencing

1. **Ship P0-2 first** (redaction engine). It is the largest win, it is measurable, and it
   unblocks every subsequent field addition by creating the performance headroom.
2. **P0-1 and P0-3 in the same release** — the header names are only affordable after P0-2, and
   the ALS fix is small and independent.
3. **P1-1 and P1-7** as a documentation/type correctness release (patch, `dist/` verified
   unchanged where applicable).
4. **P1-2 → P1-6** as the semantic-conventions minor.
5. **Recalibrate the bench budgets and add the missing tests in the same PRs**, never after.
6. **Only then** scope `@bymax-one/nest-observability`, against the now-stable resource contract.

---

## Appendix A — Reproductions

All numbers in this document were produced on this repository at commit `edcbeee`, Node 24.18.

**A.1 — ALS `userId` clobbered ([C-1](#c-1))** — real Pino 10, ALS store carrying
`userId: 'ALS_USER'`:

```
{"level":"info","time":"…","service":{…},"requestId":"r1","tenantId":"t1",
 "traceId":"aaaa…","plan":"pro","logKey":"USER_CREATED","msg":"created"}
```

`userId` absent. Passing it explicitly restores it.

**A.2 — Header leak ([S-1](#s-1))** — Pino configured with `DEFAULT_REDACT_PATHS`:

```
{"headers":{"authorization":"Bearer SECRET","cookie":"sid=SECRET"}}
{"authorization":"Bearer SECRET"}
{"headers":{"set-cookie":"sid=SECRET"}}
```

**A.3 — `pnpm bench` ([P-1](#p-1))**

```
| A: bare pino                | 1,223,780 ops/s |    24 B/op |
| B: PinoLoggerService        | 1,263,774 ops/s | 1,324 B/op |
| C: prod path (redact+mixin) |     9,311 ops/s |   967 B/op |
Throughput retention (C/B): 0.007× (budget ≥ 0.004×)
```

**A.4 — Redaction-strategy isolation ([P-1](#p-1))**

```
no redact, no mixin                       662,967 ops/s
mixin only                                572,380 ops/s
root-only redact (32 paths) + mixin       551,974 ops/s
depth 1 (59 paths) + mixin                 54,317 ops/s
depth 1-2 (86 paths) + mixin               22,302 ops/s
depth 1-4 (140 paths, current) + mixin      9,286 ops/s
```

**A.5 — Name-walk vs path-matching, identical output**

```
no redaction                             1,107,300 ops/s
fast-redact 140 paths                       10,117 ops/s
single recursive walk (unbounded depth)    943,240 ops/s
```

Both engines produced the identical record for
`{ password, token, user: { email, profile: { cpf } } }`.

**A.6 — Level and time types ([C-2](#c-2))** — every emitted record carries
`"level":"info"` (string) and `"time":"2026-08-12T09:25:46.520Z"` (ISO string), never the
`number`s the published `LogEntry` declares.
