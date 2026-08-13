# Semantic convention mapping

> **Verified:** 2026-08-13 against OpenTelemetry Semantic Conventions **v1.44.0**.
> Every stability level below was read from the attribute registry, not inferred.

This table is the complete inventory of what `@bymax-one/nest-logger` emits, what each field means,
whether OpenTelemetry defines an equivalent, and what was decided. It exists so the next person to
propose a rename can see which fields were left alone on purpose.

## Resource / service identity

| Field (default `nested` shape) | Meaning                      | OTel equivalent                       | Stability      | Action                                      |
| ------------------------------ | ---------------------------- | ------------------------------------- | -------------- | ------------------------------------------- |
| `service.name`                 | Service identifier           | `service.name`                        | **Stable**     | Emitted                                     |
| `service.version`              | Build / release              | `service.version`                     | **Stable**     | Emitted                                     |
| `service.namespace`            | Group the service belongs to | `service.namespace`                   | **Stable**     | Emitted when resolved                       |
| `service.instance.id`          | One running instance         | `service.instance.id`                 | **Stable**     | Emitted when supplied — **never generated** |
| `deployment.environment.name`  | `production`, `staging`, …   | `deployment.environment.name`         | **Stable**     | Emitted when resolved                       |
| —                              | —                            | `deployment.environment`              | **Deprecated** | **Never emitted**                           |
| —                              | —                            | `deployment.id` / `.name` / `.status` | Development    | Out of scope                                |

`resourceFormat: 'flat'` emits the same values under the dotted attribute names verbatim.

## Errors

| Field                  | Meaning                       | OTel equivalent        | Stability  | Action                                 |
| ---------------------- | ----------------------------- | ---------------------- | ---------- | -------------------------------------- |
| `err.type`             | Error class name              | `exception.type`       | **Stable** | Kept; dual-emitted under `errorFormat` |
| `err.message`          | Error message                 | `exception.message`    | **Stable** | Kept; dual-emitted                     |
| `err.stack`            | Scrubbed, escaped stack       | `exception.stacktrace` | **Stable** | Kept; dual-emitted                     |
| `err.cause`            | `Error.cause` chain           | _(none)_               | —          | Custom, namespaced under `err`         |
| `err.errors`           | `AggregateError` members      | _(none)_               | —          | Custom, namespaced under `err`         |
| `exception.type`       | Error class name              | `exception.type`       | **Stable** | `errorFormat: 'semconv' \| 'both'`     |
| `exception.message`    | Error message                 | `exception.message`    | **Stable** | `errorFormat: 'semconv' \| 'both'`     |
| `exception.stacktrace` | Scrubbed, escaped stack       | `exception.stacktrace` | **Stable** | `errorFormat: 'semconv' \| 'both'`     |
| `error.type`           | Low-cardinality failure class | `error.type`           | **Stable** | `errorFormat: 'semconv' \| 'both'`     |

The spec requires at least one of `exception.type` / `exception.message`; both are emitted because
both derive from the same value. `error.type` carries the class name — bounded by how many
exception types a codebase defines — never a message and never an identifier.

There is **no OpenTelemetry attribute for a cause chain.** `err.cause` and `err.errors` are custom
and stay namespaced under `err` rather than inventing an `exception.cause` the spec does not define.

Both stack fields carry the SAME text, and that text is escaped as well as scrubbed: control
characters become `\uXXXX`, newlines stay. The escaping is not cosmetic — `pino-pretty` prints a stack
raw rather than as a JSON string, and a stack's first line repeats the error message, so an
attacker-supplied message would otherwise reach the terminal through the stack of the same entry.
A consumer parsing `exception.stacktrace` sees frames unchanged; only control bytes differ.

## Events and correlation

| Field        | Meaning                               | OTel equivalent                 | Stability               | Action                                                        |
| ------------ | ------------------------------------- | ------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `logKey`     | `MODULE_ACTION_RESULT` identifier     | _(none)_                        | —                       | **Kept as-is** — application-level, never renamed             |
| `event.name` | Derived event name (`payment.failed`) | LogRecord **`EventName`** field | **Stable** (Data Model) | Emitted; the same-named _attribute_ is Deprecated — see below |
| `traceId`    | Active trace                          | `trace_id`                      | **Stable**              | Emitted; `fieldFormat: 'snake_case'` renames it               |
| `spanId`     | Active span                           | `span_id`                       | **Stable**              | Emitted                                                       |
| `traceFlags` | Sampling flags                        | `trace_flags`                   | **Stable**              | Emitted                                                       |

### On `event.name`

The **`event.name` attribute is Deprecated**: _"The value of this attribute MUST now be set as the
value of the EventName field on the LogRecord to indicate that the LogRecord represents an Event."_
`EventName` is a **top-level field** of the LogRecord in the Stable Logs Data Model, not an
attribute.

A Pino line is JSON, where every key is just a key — there is no structural distinction between "a
top-level LogRecord field" and "an attribute". So the value is emitted under a key a bridge maps
**onto `EventName`**, and the key is configurable (`eventNameField`) precisely so a pipeline that
reads a different one can say so. What must not happen is the value being carried into an OTLP
_attributes_ map under the deprecated name; that is a mapping decision for the collector.

## Application fields kept as-is

| Field                  | Why it is not renamed                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`            | Application correlation. `trace_id` is not a substitute — it exists only when tracing is configured.                                    |
| `tenantId`             | Domain concept with no OTel equivalent.                                                                                                 |
| `userId`               | Domain concept. `enduser.id` exists in semconv but is Development and carries PII implications this library does not want to normalize. |
| `logKey`               | The library's own event convention, and the source `event.name` is derived from.                                                        |
| `context`              | NestJS class label.                                                                                                                     |
| `msg`, `level`, `time` | Pino's own record shape.                                                                                                                |

Renaming any of these for aesthetic alignment would break every existing query for no semantic
gain. OpenTelemetry does not require an application to stop having application fields.

## Cardinality

Structured logs tolerate high-cardinality fields; metric labels do not. **Do not blindly promote
these to metric labels.**

| Bounded — safe as labels                               | High cardinality — log fields only |
| ------------------------------------------------------ | ---------------------------------- |
| `service.name`, `service.namespace`, `service.version` | `service.instance.id`              |
| `deployment.environment.name`                          | `traceId`, `spanId`                |
| `event.name`, `logKey`                                 | `requestId`, `tenantId`, `userId`  |
| `error.type`, `exception.type`                         | `err.message`, `exception.message` |
| `method`, `statusCode`                                 | `url`, `fullUrl`                   |

`error.type` is deliberately the class name rather than the message for exactly this reason: the
spec says it "SHOULD have low cardinality", and a message is unbounded.
