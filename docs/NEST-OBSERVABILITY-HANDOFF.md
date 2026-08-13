# Handoff — creating @bymax-one/nest-observability

> **Date:** 2026-08-13 · **For:** the agent that will create the package.
> The detailed architecture is in [`nest-observability-spec.md`](./nest-observability-spec.md);
> the contract you build on is [`OBSERVABILITY-CONTRACT.md`](./OBSERVABILITY-CONTRACT.md).
> This file is the short answer to "why, what, and in which order".

## Why the package exists

Without it, every Bymax service assembles OpenTelemetry by hand and each one drifts: different
Resource names, missing metrics, divergent sampling, one service on gRPC and another on HTTP.
Fragmented telemetry cannot be correlated, and correlation is the whole point. One module, sane
production defaults, escape hatches — that is the entire pitch.

## What it prevents duplicating

SDK bootstrap and lifecycle, Resource construction, context-manager registration, propagator
configuration, instrumentation wiring, OTLP export settings, and — critically — **service
identity**. Identity is configured once as `ServiceMetadata` (imported from
`@bymax-one/nest-logger/shared`) and flows to both the OTel Resource and `BymaxLoggerModule`, so
logs and traces agree by construction. Never re-implement the identity resolver; if sharing is
needed, `nest-logger` exports it.

## How it consumes nest-logger

Composition, not wrapping: `forRoot({ service, … , logger })` re-exports
`BymaxLoggerModule.forRoot({ service: SAME OBJECT, …logger })`. Dependency direction is strictly
`nest-observability → nest-logger`. The logger's mixin already reads the active span through
`@opentelemetry/api`; your job is only to make a span exist (SDK + `AsyncLocalStorageContextManager`)
— correlation then happens without any glue code.

## Key implementation decisions already made (do not re-litigate)

1. **Assemble from stable 2.x parts** (`sdk-trace-node`, `sdk-metrics`, `resources`,
   `context-async-hooks`), not the 0.x `sdk-node` wrapper. Re-check versions first — if `sdk-node`
   went stable, reconsider.
2. **No `api-logs` bridge in v1** (0.x). Pino JSON is the log transport.
3. **Head sampling only** (parent-based ratio). Tail sampling is the Collector's.
4. **Official instrumentations only** for http/framework/db; custom code is for business metrics.
5. **`service.instance.id`:** detectors or explicit value; if this package mints a UUID fallback,
   it must feed the same value back into the logger's `ServiceMetadata`.
6. **Bootstrap before imports** — provide `bootstrapObservability()` for `main.ts` top /
   `--import`; document loudly.
7. **Graceful shutdown** with bounded flush on `onApplicationShutdown`.
8. **No profiling, no eBPF, no SLOs, no vendor clients** in v1.

## What stays user-configurable

OTLP endpoint/protocol/headers (default: standard `OTEL_*` env vars), sampling ratio, which
instrumentations are on, metric export interval, everything in the logger's own options, and full
escape hatches (`custom` instrumentations array, provider access for advanced cases).

## Testing shape

The first test to write is the reason the package exists: boot SDK + logger with an in-memory
exporter, make one request, assert **the log's `traceId` equals the span's, and the span's
Resource equals the log's `service.*`**. Unit tests for option validation and identity
pass-through; Stryker over the unit suite, mutation-visible tests for precedence and lifecycle —
same discipline as nest-logger.

## MVP vs later

**MVP:** bootstrap + Resource + traces (http/nest/pg/ioredis) + metrics (official http/runtime +
business helper) + OTLP + logger integration + graceful shutdown.
**Later:** logs-over-OTLP bridge, profiles (Alpha today), more detectors, exemplar polish.
**Never here:** dashboards, alerting, SLO math, incident tooling, MCP, Bymax Live client.

## Known sharp edges, learned the hard way in nest-logger — read before coding

- Middleware/instrumentation **position** in the Nest lifecycle causes silent gaps (guards run
  before interceptors; mounted middleware sees mount-relative `req.url`). Audit the pipeline as a
  whole, not components against their contracts.
- `AsyncResource.bind` captures registration-time context; event-time reads see live context;
  neither alone covers normal + aborted requests. The logger now does live-first/bound-fallback —
  don't reintroduce single-strategy reads.
- Without a registered ContextManager, **no** event-time reader sees any span, and tests pass
  while proving nothing. Register a real `AsyncLocalStorageContextManager` in integration tests
  and dispose of it in `afterEach`.
- Any text that reaches a terminal is an injection surface, and the JavaScript line terminators are
  only half of it: `ESC E` is ANSI NEL, and VT/FF/U+0085 move the cursor too. `pino-pretty` prints
  the parsed message — and the stack, RAW — straight to the terminal. Escape at the sink, never in
  the renderer, or third-party sinks stay exposed. `nest-logger` already applies this to everything
  logged through it — the helpers are internal, deliberately: the fix belongs at the sink that owns
  the text. If this package ever renders text itself, it inherits the same problem, and the answer
  is to log through `nest-logger` rather than to copy the escaping.
- Jest `toHaveProperty('a.b')` treats the dot as a nested path — dotted-key assertions must use
  bracket access, or every negative assertion passes vacuously.
- A surviving "equivalent" Stryker mutant means "no test distinguishes", not "code is dead".
