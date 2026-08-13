# @bymax-one/nest-observability — architecture specification

> **Status:** Specification only — the package does not exist yet. · **Date:** 2026-08-13
> **Prerequisite reading:** [`OBSERVABILITY-CONTRACT.md`](./OBSERVABILITY-CONTRACT.md) (the frozen
> nest-logger contract this package builds on) and
> [`NEST-OBSERVABILITY-HANDOFF.md`](./NEST-OBSERVABILITY-HANDOFF.md) (why/process).
>
> This document is detailed enough that the implementing agent should not need to rediscover the
> architectural decisions. Where it says MUST, the decision was already made and argued; where it
> says SHOULD/CONSIDER, the implementer has latitude.

## Mission

One NestJS module that turns on production-grade OpenTelemetry — tracing, metrics, resource
identity, OTLP export — with sane defaults, so no Bymax service ever hand-assembles SDK bootstrap
again. It composes `nest-logger` rather than replacing it, and both signals carry **one** service
identity configured **once**.

## Non-goals

Not an observability backend: no storage, no querying, no dashboards, no alerting, no SLO math, no
incident management, no AI analysis, no MCP server, no Bymax Live client. Not a logger: logging
stays entirely in `nest-logger`. Not a Collector: batching-for-reliability, tail sampling,
enrichment, routing and vendor export live in the Collector/infrastructure layer. Not profiling or
eBPF: OTel Profiles is **Alpha** (verified 2026-08-13) — excluded from v1 on stability grounds.

## Ecosystem baseline (verified 2026-08-13 — re-verify at implementation time)

| Package                                                             | Version             | Implication                                                                                              |
| ------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `@opentelemetry/api`                                                | 1.9.1 (stable 1.x)  | The only OTel surface `nest-logger` touches; the contract boundary.                                      |
| `@opentelemetry/sdk-trace-node`, `resources`, `context-async-hooks` | 2.10.0 (stable 2.x) | Usable as regular dependencies of THIS package.                                                          |
| `@opentelemetry/sdk-node`                                           | 0.221.0 (**0.x**)   | The all-in-one wrapper is NOT stable. See "SDK assembly" below.                                          |
| `@opentelemetry/auto-instrumentations-node`                         | 0.79.0 (0.x)        | Meta-package of instrumentations; individually pin what v1 needs.                                        |
| `@opentelemetry/api-logs`                                           | 0.221.0 (0.x)       | Still unstable. v1 does NOT bridge Pino into the OTel Logs SDK.                                          |
| OTel JS SDK 3.0                                                     | announced/planned   | Do not couple to package layouts that are about to move; prefer the stable-2.x packages and the 1.x API. |
| Semantic Conventions                                                | v1.44.0             | Same baseline nest-logger implements.                                                                    |
| OTel Profiles                                                       | **Alpha**           | Out of v1.                                                                                               |

**SDK assembly decision:** because `sdk-node` is 0.x while its constituent parts
(`sdk-trace-node`, `sdk-metrics`, `resources`, `context-async-hooks`) are stable 2.x, v1 SHOULD
assemble the SDK from the stable parts directly rather than through the 0.x convenience wrapper.
This is more code (≈50 lines) and strictly fewer unstable dependencies, and it insulates the
package from the SDK 3.0 re-shuffle. Re-evaluate if `sdk-node` reaches 1.0/3.0-stable first.

## Architecture and dependency direction

```
Application
  └─ BymaxObservabilityModule.forRoot({ service, otlp, sampling, … })
       ├─ builds the OTel Resource            (from ServiceMetadata — the shared contract)
       ├─ starts trace SDK + context manager  (AsyncLocalStorageContextManager)
       ├─ starts metrics SDK                  (OTLP metric exporter)
       ├─ registers W3C propagators           (tracecontext + baggage)
       ├─ enables instrumentations            (http, express/nest, pg/ioredis as opted-in)
       └─ re-exports BymaxLoggerModule.forRoot({ service: SAME OBJECT, … })
Dependency direction: nest-observability → nest-logger. NEVER the reverse.
```

`nest-logger` remains fully usable standalone; this package is an accelerator, not a requirement.
Any polyglot service can skip both and speak OTLP directly — Bymax Live consumes OTLP, not Bymax
libraries.

## The shared identity contract (the load-bearing piece)

```ts
import type { ServiceMetadata } from '@bymax-one/nest-logger/shared'
```

`forRoot` takes a `ServiceMetadata` (plus observability-only options), uses it to build the OTel
`Resource`, and passes **the same object** to `BymaxLoggerModule`. Logs and traces then agree on
`service.name/.namespace/.version/.instance.id` and `deployment.environment.name` by construction.
Environment-only configuration converges too, because both packages read `OTEL_SERVICE_NAME` /
`OTEL_RESOURCE_ATTRIBUTES` with the spec-mandated precedence.

Rules the implementer MUST keep:

- Never write a second copy of identity resolution. If the resolver needs to be shared, it is
  `nest-logger` that exports it — never duplicated here.
- `service.instance.id`: prefer the standard Resource detectors (container/K8s/host) or an
  explicit value. If, after detection, no instance id exists, THIS package may mint one random
  UUID per process **and must then feed it back into the `ServiceMetadata` handed to the logger**,
  so both signals carry the same one. (The logger itself never generates it — that asymmetry is
  deliberate: only the layer that owns the Resource may mint identity.)
- Resource detectors run here, not in the logger. Start with `envDetector`, `processDetector`,
  `hostDetector`; add container/K8s detectors as options mature. Never reimplement detection.

## Public API concept

```ts
BymaxObservabilityModule.forRoot({
  service: { name, version, namespace?, instanceId?, environment? },   // ServiceMetadata
  otlp?: { endpoint?, protocol?: 'http/protobuf' | 'grpc', headers? }, // default: standard env vars
  traces?: { enabled?: true, sampleRatio?: number },                   // parent-based head sampling
  metrics?: { enabled?: true, exportIntervalMillis? },
  instrumentations?: { http?: true, nestjs?: true, pg?, ioredis?, custom?: Instrumentation[] },
  logger?: BymaxLoggerModuleOptions | false                            // false = consumer wires nest-logger separately
})
// plus forRootAsync mirroring nest-logger's pattern
```

Design constraints: no boolean explosion (group by signal), no vendor names anywhere in the API,
no Pino or SDK types leaking through public signatures, standard OTel environment variables
(`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER*`, `OTEL_SERVICE_NAME`,
`OTEL_RESOURCE_ATTRIBUTES`) honoured before Bymax-specific options are invented.

## Lifecycle

- **Startup ordering is the hard problem:** instrumentation patches must be registered before the
  instrumented modules are imported. Provide a `bootstrapObservability()` entry to be called at the
  top of `main.ts` (or via `--import`), with the Nest module then adopting the already-started SDK.
  Document this loudly; it is the number-one integration mistake.
- The context manager (`AsyncLocalStorageContextManager`) MUST be registered, or no event-time
  reader anywhere — including `nest-logger`'s mixin — sees any span.
- **Shutdown:** on `onApplicationShutdown`, flush and shut down metric readers and span processors
  with a bounded timeout (default ~5 s), before the process exits. Never lose the tail of a
  deployment's telemetry. Shutdown failures are logged through `nest-logger` and swallowed.

## Traces (v1)

Head sampling only: `ParentBasedSampler(TraceIdRatioBased(ratio))`, default ratio 1.0 in
non-production and configurable in production. Tail sampling is a Collector concern — never
implemented here. W3C `tracecontext` + `baggage` propagators by default. Instrumentations in v1:
`http`, `express`/`nestjs-core`, and opt-in `pg` + `ioredis` (the stacks the Bymax templates use).
Everything else arrives via the `custom` escape hatch.

## Metrics (v1)

- HTTP server metrics come from the official `http` instrumentation
  (`http.server.request.duration` histogram per current semconv) — do NOT hand-roll a competing
  recorder; the nest-core experience showed instrumentation position bugs are subtle.
- Runtime metrics via the official runtime/host instrumentation where stable.
- A thin helper for **business** metrics (counter/histogram factories bound to the shared
  Resource) — nothing more. RED/Golden-Signal dashboards are derived downstream from these
  standard metrics; the package emits, it does not aggregate.
- Exemplars: enable where the stable SDK supports them; they are what links a latency histogram to
  a trace. Do not build custom exemplar plumbing.
- Native histograms are a Prometheus-side representation negotiated by the Collector/backend, not
  something this package encodes.
- Cardinality discipline: metric labels drawn ONLY from the bounded set (see the logger's
  `semantic-convention-mapping.md` table). `requestId`/`userId`/`traceId` never become labels.

## Testing strategy

- Unit: Resource assembly, option validation, identity pass-through to the logger (assert the SAME
  values, not similar ones).
- Integration (in-process): start SDK with an InMemory span/metric exporter; assert a request
  produces a span, a log inside it carries the SAME `traceId`, and the span's Resource equals the
  log's `service.*` fields. This single test is the package's reason to exist — make it the first
  one written.
- E2E: boot a real Nest app with `bootstrapObservability()`, exercise HTTP + one dependency, assert
  export batches. Keep Stryker on the unit suite as in nest-logger; mutation-visible tests for
  precedence and lifecycle.

## Performance and security

SDK overhead budget: measure request p50 latency with and without the module; document it. The
logger's own budget is unchanged and enforced in its repo. Security: OTLP headers may carry
credentials — accept them via env/secret refs, never log them (they are already in the logger's
redaction set); span attributes are NOT redacted by nest-logger, so the package documents that
request/DB attributes captured by instrumentations follow OTel's own capture rules — do not enable
header capture by default.

## Migration and template usage

Existing services using `nest-logger` alone: replace `BymaxLoggerModule.forRoot(x)` with
`BymaxObservabilityModule.forRoot({ service: x.service, logger: x })` — one move, no logger option
changes. The backend template ships the module on by default with OTLP pointed at the
environment's Collector agent, standard env vars for per-deploy configuration, health/readiness
endpoints **separate** from telemetry (health is not observability — it belongs in the template or
a small terminus module, not here), and graceful shutdown wired.

## Future extension points (explicitly not v1)

Logs-over-OTLP bridge (when `api-logs` stabilizes), OTel Profiles (Alpha today), richer resource
detectors, SLO/burn-rate tooling (lives above the SDK, likely Bymax Live), deployment-event
correlation (Bymax Live maintains deployments → commits → PRs; the identity triplet emitted today
is the join key).
