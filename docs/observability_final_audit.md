# Final observability audit — is nest-logger the foundation it set out to be?

> **Date:** 2026-08-13 · **Auditor:** post-P1 architectural audit (adversarial, runtime-based)
> **Companion documents:** [`OBSERVABILITY-CONTRACT.md`](./OBSERVABILITY-CONTRACT.md) (the frozen
> contract) · [`nest-observability-spec.md`](./nest-observability-spec.md) ·
> [`NEST-OBSERVABILITY-HANDOFF.md`](./NEST-OBSERVABILITY-HANDOFF.md) ·
> [`semantic-convention-mapping.md`](./semantic-convention-mapping.md) ·
> [`observability_audit.md`](./observability_audit.md) (the original P0/P1 audit)

## Executive verdict

**READY** — after two defects found by this audit were fixed inside it (both within the approved
P0/P1 scope; see [What this audit found and fixed](#what-this-audit-found-and-fixed)).

The public contract is stable enough to build `@bymax-one/nest-observability` on. This verdict is
based on adversarial runtime behaviour, not on the test suite being green: every claim below was
exercised against real serialized bytes, hostile inputs, hostile working directories and
concurrent contexts during this audit.

## The goal, restated

`nest-logger` owns exactly one slice of the future stack: trustworthy structured logs, request
context, redaction, error semantics and **correlation identity** (trace IDs it observes, service
identity it emits). Everything else — SDK bootstrap, spans, metrics, OTLP, Collector, dashboards,
AI — belongs to layers above it. Bad telemetry cannot be repaired downstream, so this library's
job is to make the data excellent at its origin and to leave a contract the next layer consumes
without workarounds.

## Standards baseline (researched 2026-08-13, primary sources)

| Item                                                                           | Status                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Semantic Conventions                                                           | **v1.44.0** (latest release)                                                |
| `service.name/.namespace/.version/.instance.id`, `deployment.environment.name` | **Stable**                                                                  |
| `deployment.environment`                                                       | **Deprecated** — never emitted here                                         |
| `deployment.id/.name/.status`                                                  | Development — out of scope                                                  |
| `exception.type/.message/.stacktrace` (logs), `error.type`                     | **Stable** (`error.type` requires low cardinality)                          |
| Logs Data Model / top-level `EventName` field                                  | **Stable**; the `event.name` _attribute_ is **Deprecated**                  |
| `@opentelemetry/api`                                                           | 1.9.1 — the stable boundary, and the only OTel surface this library touches |
| `@opentelemetry/api-logs` / `sdk-node` / `auto-instrumentations-node`          | 0.221.0 / 0.221.0 / 0.79.0 — all 0.x, all correctly absent                  |
| `sdk-trace-node`, `resources`, `context-async-hooks`                           | 2.10.0 stable — relevant to nest-observability, absent here                 |
| OTel Profiles                                                                  | **Alpha** — excluded from all near-term plans                               |
| Pino / pino-std-serializers / NestJS core                                      | 10.3.1 / 7.1.0 / 11.1.29                                                    |
| Collector deployment guidance                                                  | agent + gateway patterns; processing/export belongs there                   |

Two findings from this baseline had already contradicted the original P1 plan and were implemented
correctly: there is **no `OTEL_SERVICE_VERSION`** environment variable, and `event.name` must
target the LogRecord's `EventName` field rather than an OTLP attribute.

## P0 verification — old issues stay fixed

Re-verified at runtime during this audit, not assumed from tests:

| P0 item                                                                                | Status                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Name-keyed recursive redaction, unbounded depth, fail-closed ceiling                   | ✅ zero leaks across 8 adversarial vectors (below) |
| Credential-bearing headers at any position, case-insensitive                           | ✅                                                 |
| ALS `userId` reaches structured entries; explicit args win; `undefined` never erases   | ✅                                                 |
| `LogEntry` matches the runtime (`level` string, `time` ISO)                            | ✅                                                 |
| Reserved keys all emitted or justified                                                 | ✅                                                 |
| Guard rejections + unmatched routes logged; aborted ≠ success (`HTTP_REQUEST_ABORTED`) | ✅                                                 |
| Prototype-polluting keys dropped at both copy sites                                    | ✅                                                 |

## P1 verification — requirement by requirement

| Requirement                                              | Implementation                                                                                    | Test                                                          | Status                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| CWD-independent OTel detection                           | module-path anchor, cwd fallback, thunk-deferred `__filename`                                     | unit incl. hostile-CWD; measured `cwd=/`                      | ✅                                                                                                                               |
| Visible failure when injection on + peer absent          | one `LOGGER_BOOTSTRAP_WARNING` (`OTEL_API_UNAVAILABLE`)                                           | unit ×3                                                       | ✅                                                                                                                               |
| Stable resource identity + deterministic precedence      | `resolve-resource.util` (options → `OTEL_SERVICE_NAME` → `OTEL_RESOURCE_ATTRIBUTES` → `NODE_ENV`) | 30+ unit cases incl. conflicts, malformed env, duplicate keys | ✅                                                                                                                               |
| `service.instance.id` never generated                    | omitted unless supplied                                                                           | unit                                                          | ✅                                                                                                                               |
| `resourceFormat` nested/flat                             | precomputed into Pino `base`                                                                      | unit + runtime probe                                          | ✅                                                                                                                               |
| `err.type` never `"Object"`                              | architectural: raw value to a `sanitizeError`-based serializer; structural error-like detection   | unit + e2e regression                                         | ✅                                                                                                                               |
| `Error.cause` / `AggregateError` reach the record        | depth/width-bounded, circular-safe                                                                | unit ×10+                                                     | ✅                                                                                                                               |
| Semconv exception attributes + `error.type`              | `errorFormat: 'pino'\|'semconv'\|'both'`, default preserves legacy                                | unit incl. degenerate values                                  | ✅                                                                                                                               |
| `event.name`                                             | derived (`PAYMENT_FAILED`→`payment.failed`), configurable key, off for variadic calls             | unit                                                          | ✅                                                                                                                               |
| No new runtime dependency                                | `"dependencies": {}` unchanged                                                                    | `package.json` + dogfood                                      | ✅                                                                                                                               |
| Options validated (closed sets)                          | `validateOptions` covers all three new options                                                    | unit ×11                                                      | ✅                                                                                                                               |
| Emitted type ≠ config type                               | `EmittedServiceResource`/`EmittedDeploymentResource`                                              | type-level + published-surface gate                           | ✅                                                                                                                               |
| Did NOT become an observability SDK                      | grep-verified: no SDK, exporter, metrics, sampling, collector, vendor code anywhere               | —                                                             | 🚫 correctly out of scope                                                                                                        |
| Disabled-level fast path                                 | payload built before Pino's level check                                                           | —                                                             | ❌ known **P2** (unchanged from original audit)                                                                                  |
| HTTP field names vs semconv (`http.request.method` etc.) | legacy names kept (`method`, `url`, `statusCode`)                                                 | —                                                             | ⚠️ deliberate **P2**: renaming breaks every existing query; instrumentation-owned tracing semantics belong to nest-observability |

## What this audit found and fixed

Runtime probing found **two genuine defects**, both inside the approved P0/P1 scope, both fixed in
this audit's PR with mutation-visible regression tests:

1. **A thrown non-object spread garbage into `err`.** The serializer's own-property copy ran on
   any value, and `Object.entries` on a thrown _string_ spreads its characters: a real record
   carried `err: {"0":"t","1":"h",…, type:"UnknownError"}`; a thrown array spread its elements.
   Fixed: own properties are copied only off a plain non-array object — the envelope's stringified
   message already carries the whole value.
2. **The HTTP terminal entry was emitted in the wrong async context when instrumentation opened a
   scope downstream of the middleware.** `AsyncResource.bind` alone captures registration-time
   context; a live read alone loses the aborted path. Measured (and independently confirmed by
   nest-core against a real ContextManager): neither strategy covers both. Fixed:
   **live-context-first, bound-fallback** — the ALS store doubles as the liveness probe. Normal
   requests now attribute to the innermost active span; aborted requests keep their `requestId`.

One near-miss re-verified as **not** a defect: child-logger binding redaction is intact on the DI
path; the probe that appeared to leak had constructed `PinoLoggerService` by hand without the
redactor, which is the documented default for hand-built instances.

## Runtime behaviour (real records)

All 10 record shapes generated in this audit (every level, structured + variadic, ALS scope,
nested cause, non-Error throw, child logger, secrets, undefined fields) are valid JSON with a
predictable schema; `undefined` fields are omitted; human `msg` is preserved beside
machine-readable fields; average line ≈ 430 bytes with full identity. No duplicated fields in the
default format (`'both'` duplicates error info by design, as the migration mode).

## Security — adversarial result

Marker-string hunt over real serialized bytes, 9 vectors: authorization/cookie/set-cookie headers
(case-varied), access/refresh tokens, apiKey/password/secret/clientSecret/privateKey, credentials
nested 30 deep, secrets on error own-properties and inside `Error.cause`, headers inside exception
data, `toJSON`-synthesized secrets, circular structures carrying secrets, child bindings.
**Zero leaks in 8 of 9.** The ninth is the documented boundary: a secret **embedded in free text**
(`error.message` carrying a connection string) is emitted — name-keyed redaction has no key to
match inside a string value. Recorded in the contract as explicitly-not-guaranteed; value-pattern
scrubbing (e.g. URL-credential regex) is a P2 candidate requiring its own perf/design decision.

## Performance

| Path                                       |      P0 (1.2.0) |              P1 (this audit) |
| ------------------------------------------ | --------------: | ---------------------------: |
| Shipped config                             | ~278,000 logs/s | **263,100 logs/s** (~3.8 µs) |
| Retention vs bare service (budget ≥ 0.20×) |          0.349× |                   **0.319×** |
| Info path, full identity                   |               — |                928,226 ops/s |
| Info path without `event.name`             |               — |              1,039,806 ops/s |
| Error, legacy / both / semconv             |               — |     265k / 215k / 289k ops/s |

Historical anchor: pre-P0 shipped config was **9,311 logs/s** — P1 remains ~28× above it. The P1
cost is almost entirely `event.name` derivation (opt-out) plus the error dual-emission mode
(opt-in). Static work (identity, env parsing, redactor construction) is resolved once at
construction; per-log work scales with record size only. The one known inefficiency is the
disabled-level path (P2).

## Cardinality

Full table in [`semantic-convention-mapping.md`](./semantic-convention-mapping.md). Summary:
bounded and safe as metric labels — `service.name/.namespace/.version`,
`deployment.environment.name`, `event.name`, `logKey`, `error.type`, `method`, `statusCode`.
High-cardinality, logs-only — `traceId`, `spanId`, `requestId`, `tenantId`, `userId`,
`service.instance.id`, `url`, messages. The documentation states explicitly that the second group
must never be promoted to metric labels; `nest-observability` inherits that rule.

## Dependencies and boundaries

Runtime dependencies: **zero**, unchanged since inception. `@opentelemetry/api` remains an
optional peer and the only OTel surface touched — no SDK internals, no exporters, no Collector
code, no vendor packages. Nothing in the schema requires Loki, Tempo, Datadog or Bymax Live; all
vendor references live in documentation examples only.

## Technical debt (P2 — deliberate, documented, not blocking)

1. Disabled-level fast path (payload built before the level check).
2. HTTP field semconv alignment (`http.request.method` etc.) — dual-emission design needed;
   coordinates with nest-observability's instrumentation ownership.
3. Value-pattern redaction for free-text secrets (connection strings in messages).
4. `errorFormat`/`eventNameField`/`resourceFormat` remain per-logger; a future shared profile
   could live in nest-observability's defaults.

## Responsibility matrix

| Capability                                                  |            nest-logger            |    nest-observability     |  Backend template   |   Collector/infra    |   Bymax Live    |
| ----------------------------------------------------------- | :-------------------------------: | :-----------------------: | :-----------------: | :------------------: | :-------------: |
| Structured logs, redaction, request context                 |             **owner**             |         consumes          |      consumes       |          —           | consumes output |
| Trace correlation (observe IDs)                             |             **owner**             |       enables (SDK)       |          —          |          —           |    consumes     |
| Service/resource identity contract                          |       **owner** (contract)        |   **owner** (Resource)    |     configures      |          —           |    consumes     |
| Event naming, error semantics                               |             **owner**             |             —             |          —          |          —           |    consumes     |
| Traces, spans, propagation                                  |                 —                 |         **owner**         |          —          |      transport       |    consumes     |
| Metrics (HTTP/runtime/business), exemplars                  |                 —                 |         **owner**         |          —          |      transport       |    consumes     |
| HTTP/DB instrumentation                                     |                 —                 | **owner** (official pkgs) |          —          |          —           |        —        |
| Head sampling                                               |                 —                 |         **owner**         |     configures      |          —           |        —        |
| Tail sampling, batching, enrichment, routing, vendor export |                 —                 |             —             |          —          |      **owner**       |        —        |
| OTLP export                                                 |                 —                 |     **owner** (emits)     | configures endpoint | **owner** (receives) |    receives     |
| Native histograms                                           |                 —                 | emits standard histograms |          —          |  **owner** (repr.)   |        —        |
| Health/readiness                                            |                 —                 |             —             |      **owner**      |        probes        |        —        |
| Profiling, eBPF                                             |                 —                 |   future (Alpha today)    |          —          |        future        |     future      |
| SLOs, alerts, dashboards, incident mgmt, MCP, AI RCA        |                 —                 |             —             |          —          |          —           |    **owner**    |
| Deployment correlation                                      | emits join key (name+version+env) |             —             |          —          |          —           |    **owner**    |

## Architecture and roadmap

```
Application
  └─ nest-logger            logs · redaction · context · error semantics · trace-ID observation
       └─ nest-observability   OTel SDK · Resource · traces · metrics · instrumentation · OTLP   [NEXT]
            └─ OpenTelemetry Collector   batch · retry · enrich · tail-sample · route
                 └─ backend(s)   Grafana stack · Bymax Live · any OTLP-compatible
AI / MCP agents  →  observability backend / Bymax Live APIs   (never → nest-logger)
```

**DONE** nest-logger P0 (security/correctness/perf) · **DONE** nest-logger P1 (OTel alignment,
stable contracts) · **NEXT** nest-observability MVP (per the spec) · **AFTER** backend-template
integration (observable by default) · **LATER** tail sampling, exemplars polish, native-histogram
negotiation, profiling when past Alpha, SLO tooling, deployment correlation · **FUTURE** Bymax
Live (ingestion, correlation, investigation, AI, MCP). The ordering was re-examined against
current research and stands: the identity contract had to freeze before the SDK layer exists, and
the SDK layer must exist before template defaults mean anything.

## The ideal backend, end to end (checkout-api)

A request hits `checkout-api`. The template's `bootstrapObservability()` started the OTel SDK
before imports, so the HTTP instrumentation opens a server span and the W3C context flows.
`nest-logger`'s middleware opens the request scope (`requestId`) before any guard; every log line
the handler emits carries `requestId`, `traceId`/`spanId` read live from the active span, and the
same `service.name=checkout-api · service.version=2.14.3 · deployment.environment.name=production`
that the span's Resource carries — because both came from one `ServiceMetadata`. The payment call
fails: `errorStructured` emits `logKey=PAYMENT_FAILED`, `event.name=payment.failed`,
`err.type=PaymentDeclined` with its cause chain, and `error.type` for aggregation. The pg span
under the same trace shows the slow dependency. RED metrics from the official instrumentation
stream over OTLP with exemplars pointing at the trace. The Collector batches, tail-samples errors,
and fans out to Grafana and Bymax Live. An investigator — human or agent — starts from the
`payment.failed` event rate, follows an exemplar to the trace, reads the correlated logs by
`traceId`, sees the failing span and the exact version/environment, and lands on the deployment
that shipped it. No field in that chain is proprietary; a Go service speaking bare OTLP joins the
same investigation.

## Go/no-go gates

P0 stable ✅ · P1 stable ✅ · resource contract deterministic and frozen ✅ · trace correlation
CWD-independent, validated, live-first ✅ · errors stable (type, cause, semconv) ✅ · event
semantics stable and standards-correct ✅ · redaction adversarially verified ✅ · performance
within budget (~28× pre-P0) ✅ · zero vendor coupling ✅ · no unresolved breaking change ✅.

**Recommended next step:** implement `@bymax-one/nest-observability` v1 exactly per
[`nest-observability-spec.md`](./nest-observability-spec.md), starting with the one integration
test that justifies the package: same `traceId` and same Resource on a log and its span.
