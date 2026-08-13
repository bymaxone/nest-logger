# The nest-logger observability contract

> **Status:** Frozen as of 2026-08-13 · **Applies to:** `@bymax-one/nest-logger` ≥ the P1 release
> **Audience:** `@bymax-one/nest-observability`, the Bymax backend template, Bymax Live, and any
> consumer building queries, dashboards, alerts or agents against this library's output.
>
> This document is the authoritative statement of what the library **promises**. Anything not
> promised here may change in a minor release. Everything promised here changes only under the
> [compatibility rules](#compatibility-contract) at the bottom.

## Logging contract

Every entry is one line of valid JSON on its destination. The invariant keys:

| Key          | Type                           | Presence                               | Meaning                                                                                             |
| ------------ | ------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `level`      | `'trace'…'fatal'` string label | always                                 | Severity. Never a number.                                                                           |
| `time`       | ISO 8601 UTC string            | always                                 | Timestamp. Never epoch millis.                                                                      |
| `msg`        | single-line string             | always                                 | Human-readable message. Machines should not parse it. Never contains a line separator — see below.  |
| `logKey`     | `MODULE_ACTION_RESULT` string  | structured calls only                  | The library's event convention. Never renamed.                                                      |
| `event.name` | lowercase dotted string        | structured calls only, unless disabled | Derived from `logKey` (`PAYMENT_FAILED` → `payment.failed`). See [Event contract](#event-contract). |
| `context`    | string                         | when set                               | NestJS class label.                                                                                 |

Absent means absent: no key is ever written holding `undefined` or `null` to mean "not set".
Variadic NestJS bridge calls (`logger.log(…)`) carry `msg` but no `logKey` and no `event.name`.

The published `LogEntry` type describes the **emitted** record. Configuration shapes
(`ServiceMetadata`) and emitted shapes (`EmittedServiceResource`, `EmittedDeploymentResource`) are
deliberately distinct types — reusing one as the other is how this library shipped a lying type
twice, and it will not do so a third time.

## Context contract

`LogContextService` is AsyncLocalStorage-backed. Fields set in a `run()` scope — `requestId`,
`tenantId`, `userId`, and anything added with `set()` — appear on every entry emitted inside that
scope, at any async depth, with these guarantees:

- **Isolation:** concurrent scopes never observe each other's values. Verified under interleaved
  awaits, `Promise.all`, and timers.
- **Precedence:** an explicit argument (`userId` passed to a structured call) wins over the ALS
  value. An `undefined` argument does **not** erase the ALS value — reserved fields are written
  only when defined.
- **Caller metadata cannot forge identity:** `logKey`, `userId` and `context` keys inside a
  metadata bag are stripped; `__proto__`, `constructor` and `prototype` are dropped.
- Prototype-polluting keys never reach the store (`set()` throws; `run()` drops them).

## Trace correlation contract

- When `@opentelemetry/api` resolves **and** a valid span is active, entries carry `traceId`,
  `spanId` and `traceFlags` (field names configurable; `snake_case` shortcut available).
- IDs are validated against W3C Trace Context (32/16 lowercase hex, non-zero) before emission.
  Invalid or all-zero contexts emit nothing.
- No span is ever created, no context manager installed, no `traceparent` parsed by hand. The
  logger **observes** the active context through the stable API surface only.
- Resolution of the optional peer is anchored at the library's own module path with a
  `process.cwd()` fallback. There is **no** working-directory or filesystem-layout assumption.
- Without OpenTelemetry: identical behaviour minus the three fields. No error, no per-log warning.
  The single exception: when `otel.shouldAutoInjectTraceContext` is on and the peer cannot be
  resolved, one `LOGGER_BOOTSTRAP_WARNING` (`reason: 'OTEL_API_UNAVAILABLE'`) fires at boot.
- The HTTP access log's terminal entry is emitted in the **live** async context when one is
  readable at close time, falling back to the context captured at middleware registration. This is
  what keeps a normal request attributed to the innermost active span and an aborted request still
  carrying its `requestId`.

## Resource identity contract

Emitted on every entry, resolved **once** at module construction:

| Attribute                     | SemConv stability | Source precedence (first non-empty wins)                           |
| ----------------------------- | ----------------- | ------------------------------------------------------------------ |
| `service.name`                | Stable            | explicit option → `OTEL_SERVICE_NAME` → `OTEL_RESOURCE_ATTRIBUTES` |
| `service.version`             | Stable            | explicit option → `OTEL_RESOURCE_ATTRIBUTES`                       |
| `service.namespace`           | Stable            | explicit option → `OTEL_RESOURCE_ATTRIBUTES`                       |
| `service.instance.id`         | Stable            | explicit option → `OTEL_RESOURCE_ATTRIBUTES` — **never generated** |
| `deployment.environment.name` | Stable            | explicit option → `OTEL_RESOURCE_ATTRIBUTES` → `NODE_ENV`          |

- The `OTEL_SERVICE_NAME`-over-attributes order is required by the OTel specification, not chosen.
- The deprecated `deployment.environment` spelling is **never** emitted.
- `resourceFormat: 'nested'` (default) emits `{ service: { …, instance: { id } }, deployment:
{ environment: { name } } }`; `'flat'` emits the dotted attribute names verbatim. Same values,
  different key shape.
- A malformed `OTEL_RESOURCE_ATTRIBUTES` — including repeated keys — can never prevent boot.
- **The one-identity guarantee:** because the logger reads the same environment variables the OTel
  SDK reads, configuring identity once (either through the environment, or by passing the same
  `ServiceMetadata` object to both packages) makes logs and traces agree by construction.
  `nest-observability` consumes exactly this: `ServiceMetadata` in, one identity out.

## Error contract

The `err` serializer (legacy shape, always on):

| Key                            | Meaning                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `err.type`                     | The error's **own** `name` — a `ForbiddenException` reports `ForbiddenException`, never `"Object"`, including for plain error-like objects and errors from other realms. |
| `err.message`                  | The message.                                                                                                                                                             |
| `err.stack`                    | Stack with `node_modules` frames removed.                                                                                                                                |
| `err.cause`                    | The `Error.cause` chain, depth-bounded, circular-safe.                                                                                                                   |
| `err.errors`                   | `AggregateError` members, width-bounded.                                                                                                                                 |
| _(other own enumerable props)_ | Carried through (`code`, `statusCode`, domain fields), redacted like everything else.                                                                                    |

A non-object thrown value produces only `{ type: 'UnknownError', message: String(value) }`.
Serialization **never throws**; an unreadable value degrades to a marked envelope, and a record
whose error resists even redaction degrades to the fail-closed `LOGGER_REDACTION_FAILED` record.

`errorFormat: 'semconv' | 'both'` adds the Stable attributes `exception.type`,
`exception.message`, `exception.stacktrace` (same scrubbed stack) and `error.type` (the class
name — low cardinality by construction, per the spec's requirement). `exception.type` describes
the thrown object; `error.type` is the aggregation key. They are distinct attributes that may hold
the same string.

## Event contract

- `event.name` is **derived**, never mirrored: lowercase, `_` → `.`, exactly reversible for the
  `MODULE_ACTION_RESULT` convention. `logKey` is untouched.
- Only structured calls get one. Ordinary diagnostic lines are not Events.
- The value targets the LogRecord's Stable top-level **`EventName`** field. The same-named OTLP
  _attribute_ is Deprecated; a collector mapping this key must set `EventName`, not an attribute.
  The carrier key is configurable (`eventNameField`) for exactly that reason; `false` disables.
- Names must stay low-cardinality. Identifiers belong in their own fields, never in the name.

## Security contract

**Guaranteed** (verified on serialized bytes, adversarially):

- 32 sensitive field names (passwords, tokens, auth/cookie headers, API keys, PCI, LGPD documents)
  are censored **wherever the key appears**: any nesting depth to the traversal ceiling, arrays,
  class instances, child-logger bindings, base bindings, serializer outputs, error own-properties
  and cause chains. Matching is case-insensitive.
- `toJSON` cannot smuggle a value past the matcher — its output is walked, a sensitive source key
  fails closed, and an accessor `toJSON` cannot select the binary fast path.
- Circular structures, hostile getters and depth bombs degrade fail-closed (censored value,
  dropped container, or the marked `LOGGER_REDACTION_FAILED` record) — never a crash, never a leak
  through the failure path.
- Query strings are stripped from every logged URL.
- **A message cannot forge an entry.** Every string reaching Pino's message argument — from an
  error, a structured call or the NestJS variadic bridge — has its line terminators (`\r`, `\n`,
  U+2028, U+2029, U+0085) replaced with the literal `\n` sequence, and every other terminal control
  character (C0 except TAB, DEL, C1 — ESC among them) replaced with its `\uXXXX` escape. NDJSON was
  safe for C0 only — `JSON.stringify` and Pino's serializer emit DEL, the C1 range (U+0085 NEL
  among them), U+2028 and U+2029 verbatim — so this protects BOTH the raw NDJSON line read in a
  terminal and destinations that re-render the parsed text (`pino-pretty` among them), where a raw
  break **or** an ANSI sequence such as `ESC E` prints a line indistinguishable from a genuine
  entry. The scrubbed stack carries the same escaping with
  its newlines preserved. Structured fields are untouched, so `err.message` still carries the
  verbatim text.
- Every value is read exactly once and pinned (snapshot), so a stateful getter cannot answer clean
  to inspection and dirty to serialization.

**Explicitly NOT guaranteed** — the boundary, stated so nobody assumes otherwise:

- A secret embedded in **free text** (an `error.message` carrying a connection string, a caller
  interpolating a token into `msg`) is emitted. Name-keyed redaction has no key to match inside a
  string value. Do not put secrets in messages; value-pattern scrubbing is a possible P2, not a
  present promise.
- The **stack** still renders across several lines in pretty output — a stack is multi-line by
  nature, and its first line repeats the error message. Its control characters are escaped, so it
  cannot drive the terminal, but nothing pins it to one line: only `msg` carries the one-line
  guarantee.
- A secret under a key **nobody declared sensitive** (`{ renamed: user.password }`, a `toJSON`
  renaming nested state) is emitted. Declare the name or keep the value out of the log.

## Performance expectations

Measured on the maintainer's reference machine (Node 24, Apple Silicon); relative numbers travel
better than absolute ones:

- Shipped default config: **~263,000 logs/s** (~3.8 µs/log) including redaction, resource
  identity, mixin and event naming. Retention ≥ 0.20× vs. the bare service is a CI-enforced budget.
- Static work (identity resolution, env parsing, redactor construction) happens **once**; per-log
  work is bounded by record size, never by config size.
- `event.name` costs ~7% of the shipped path and is opt-out. Error entries cost ~3.8–4.7 µs.
- **Not promised:** a fast path for disabled levels (payload building runs before Pino's level
  check — a known P2), and any specific absolute number on other hardware.

## Compatibility contract

- **Additive fields** (new optional keys) may arrive in a **minor**.
- **Removing or renaming an emitted key**, changing a key's type, or changing documented
  precedence requires a **major**, preceded by at least one minor of dual emission or deprecation
  notice in the CHANGELOG.
- The 32-name default redaction set is **append-only**; removal is a major.
- Deprecated fields carry a documented removal target; aliases do not live forever.
- Every break, regardless of version-line policy in force, is documented under `### Breaking` in
  the CHANGELOG with a migration path.
- Vendor-specific fields will never be added to the core schema. Loki/Tempo/Datadog examples in
  documentation are illustrations, not contract.
