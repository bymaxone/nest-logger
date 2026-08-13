# ADR 0001 — Resource identity and OpenTelemetry correlation contract

> **Status:** Accepted · **Date:** 2026-08-13 · **Applies to:** `@bymax-one/nest-logger` 1.2.x
> **Supersedes:** nothing · **Related:** [`docs/observability_audit.md`](../observability_audit.md) P1-2, P1-5

## Research baseline

Every stability claim below was verified against primary sources on **2026-08-13**:

| Source                                                                           | Version / status consulted                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| OpenTelemetry Semantic Conventions                                               | **v1.44.0** (latest release)                                         |
| OTel Logs Data Model                                                             | **Stable**                                                           |
| `service.name` · `service.namespace` · `service.version` · `service.instance.id` | **Stable**                                                           |
| `deployment.environment.name`                                                    | **Stable**                                                           |
| `deployment.environment`                                                         | **Deprecated** — "Replaced by `deployment.environment.name`"         |
| `deployment.id` · `deployment.name` · `deployment.status`                        | **Development**                                                      |
| `exception.type` · `exception.message` · `exception.stacktrace` (logs)           | **Stable**                                                           |
| `error.type`                                                                     | **Stable**, "SHOULD be predictable, and SHOULD have low cardinality" |
| `event.name` **attribute**                                                       | **Deprecated** — value belongs in the LogRecord `EventName` field    |
| `@opentelemetry/api`                                                             | 1.9.1 — stable 1.x                                                   |
| `@opentelemetry/api-logs`                                                        | 0.221.0 — still 0.x, **not adopted**                                 |
| Pino                                                                             | 10.3.1                                                               |

Two of these contradicted the assumptions this work started from, and both changed the design:
there is **no `OTEL_SERVICE_VERSION` environment variable** in the specification, and the
**`event.name` attribute is deprecated**.

## Context

The logger needs a service identity on every record, and a `traceId` when a span is active. Both
sound trivial and both have a failure mode that is worse than doing nothing.

**Identity can disagree with itself.** If the logger reads `service.version` from its own options
while the OpenTelemetry SDK reads it from the environment, a deployment that updates one and not
the other produces logs claiming `1.7.0` and traces claiming `1.8.0` for the same request. Nothing
downstream can tell which is lying. A wrong-but-confident answer is worse than an absent one.

**Correlation can fail silently.** The previous detector resolved `@opentelemetry/api` from
`process.cwd()`. When the working directory was not the application root — a Docker `WORKDIR`, a
pnpm workspace with hoisted `node_modules`, a monorepo launched from the repository root, a
serverless bundle — resolution failed, trace correlation switched off, and the only symptom was an
absent `traceId`, which is indistinguishable from "no active span".

## Decision

### The logger OBSERVES the trace context; it never owns one

`nest-logger` reads the active span through the stable `@opentelemetry/api` surface and emits
`traceId` / `spanId` when that span is valid. It does not create spans, does not install a context
manager, does not configure propagators, and does not parse `traceparent` by hand. When the API
resolves but no span is active, it emits nothing rather than fabricating identifiers; when a span
context is invalid, the identifiers are dropped after validation.

**Why:** a logger that creates spans becomes a second, competing tracing system. Two systems
disagreeing about the shape of a trace is a harder problem than having no trace at all. Reading
W3C Trace Context out of the API the SDK already populates is the only way both signals describe
the same trace by construction.

### `@opentelemetry/api` stays an OPTIONAL peer dependency

It already was, and the research confirmed it is the right boundary. The library depends on **no**
SDK, exporter, instrumentation or Collector package, and adds **zero** runtime dependencies.

**Why not `@opentelemetry/api-logs`:** it is `0.221.0`. Adopting a 0.x package as a core dependency
of a library that ships `"dependencies": {}` would import an unstable contract into every consumer
for no capability this library needs — structured Pino JSON aligned with the Stable Logs Data Model
carries the same information without becoming a Logs SDK.

### Resolution is anchored at the module, not the working directory

`detectOtelTraceApi` resolves from **this module's own path** first, falling back to
`process.cwd()`. Walking up from the library's own location is how Node module resolution is
defined and how every other dependency in the process is found; the working directory answers a
different question — "is the peer reachable from wherever the operator launched the process" — and
those answers diverge in exactly the deployment shapes listed above. The fallback is kept because a
bundled application's module path may sit outside any `node_modules` tree.

When auto-injection is **enabled** and resolution fails, the module emits one
`LOGGER_BOOTSTRAP_WARNING` naming `OTEL_API_UNAVAILABLE` at boot. Absence of `traceId` stops being
ambiguous.

### Identity precedence is deterministic and reads the SDK's own sources

In order: **explicit options → `OTEL_SERVICE_NAME` → `OTEL_RESOURCE_ATTRIBUTES` → `NODE_ENV`**.

Explicit configuration wins because it is the most specific statement an operator can make. The
order of the two OTel variables is not a preference — the specification requires it: _"If
`service.name` is also provided in `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME` takes
precedence."_ Reading the same two variables the SDK reads is what makes logs and traces agree
without the logger depending on the SDK.

`NODE_ENV` is last and applies only to the environment, because it is a Node convention rather than
an OpenTelemetry one.

### `service.instance.id` is never generated

The specification requires the triplet (`service.namespace`, `service.name`, `service.instance.id`)
to be globally unique and recommends a random UUID. The library still refuses to mint one.

**Why:** a UUID generated here would be the _logger's_, not the OpenTelemetry Resource's, so logs
and traces would claim different instances of the same process — reintroducing the disagreement
this ADR exists to prevent — and it would change on every restart while looking authoritative. The
platform knows the answer (pod UID, ECS task ARN, VM instance id) and the OTel Resource is where it
belongs. The value is read from configuration or `OTEL_RESOURCE_ATTRIBUTES`, or omitted. Omission is
honest.

The spec also notes that underlying data such as pod names may be confidential, which is a second
reason not to synthesize something that looks like infrastructure identity.

### Deprecated attributes are never emitted

`deployment.environment.name` is emitted; the deprecated `deployment.environment` is not, in any
mode. `deployment.id` / `.name` / `.status` are Development and out of scope — richer deployment
metadata belongs to whatever manages deployments, not to a logger.

## The contract a future `@bymax-one/nest-observability` consumes

The exported surface is deliberately small:

```ts
import type { ServiceMetadata, ResolvedServiceMetadata } from '@bymax-one/nest-logger/shared'
```

- **`ServiceMetadata`** — what a consumer configures: `name`, `version`, and the optional
  `namespace`, `instanceId`, `environment`.
- **`ResolvedServiceMetadata`** — the same identity after precedence has been applied, where an
  absent optional field means "no source supplied one".

A future `nest-observability` configures the OpenTelemetry SDK's `Resource` and passes the **same**
`ServiceMetadata` object into `BymaxLoggerModule.forRoot`. Both signals then carry one identity, and
neither package imports the other. If the two are configured through the environment instead, they
converge anyway, because both read `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`.

**What the contract deliberately excludes:** exporters, metric readers, tracer providers, Collector
options, sampling. Those are `nest-observability`'s concerns. Putting them in a logger's resource
contract would make the logger the configuration surface for a system it is not part of.

**What `nest-observability` will NOT have to do:** patch internals, monkey-patch Pino, duplicate
configuration parsing, or reach into private classes. It configures a Resource and hands over an
object.

## Consequences

- The logger works **identically with and without** OpenTelemetry installed. No SDK, no error, no
  per-log warning.
- Logs and traces agree on service identity whenever either source is configured once.
- A missing optional peer is **visible at boot** instead of silently degrading correlation.
- Some entries carry fewer attributes than a maximalist implementation would emit —
  `service.instance.id` in particular is often absent. That is the intended trade: the fields that
  are present can be trusted.
- Two attributes now cost per-entry work that did not exist before, measured and recorded in the
  benchmark table in `README.md`. The resource identity itself is precomputed into Pino's `base`
  and costs ~2%.

## Alternatives considered and rejected

- **Generating `service.instance.id` from a UUID at boot.** Spec-conformant in isolation, wrong in
  context: it guarantees the logger and the SDK disagree, and the value looks authoritative.
- **Reading the OTel `Resource` object directly through the SDK.** Would give perfect agreement and
  a hard dependency on `@opentelemetry/resources`, which is exactly the SDK coupling this design
  exists to avoid. The environment variables are the same source without the dependency.
- **Emitting both `deployment.environment` and `deployment.environment.name`.** Dual emission of a
  deprecated attribute buys compatibility with pipelines that should be migrating, and the library
  never emitted the deprecated spelling in the first place — so there is nothing to be compatible
  with.
- **Adopting `@opentelemetry/api-logs`.** Rejected on stability, per the dependency policy.
- **A separate package for the shared types.** Premature: two interfaces do not justify a package,
  and `@bymax-one/nest-logger/shared` already exists with zero dependencies for exactly this.
