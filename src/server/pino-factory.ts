/**
 * Pino instance factory.
 *
 * Layer: server — turns a resolved options snapshot into a configured Pino
 * logger. Wires PII redaction, the service base bindings, string level output,
 * the default error serializer, and the trace-context mixin (ALS + OTel), then
 * fans the serialized output out to every registered destination via
 * `pino.multistream`.
 *
 * Redaction is wired at TWO hooks, and both are needed:
 *   - `formatters.log` — the name walk over the merged record (mixin + caller
 *     object), which is the whole surface a caller controls;
 *   - each serializer's output — because `formatters.log` runs BEFORE
 *     serializers, so a field a serializer produces would otherwise reach the
 *     sink unwalked.
 */
import pino from 'pino'
import type { Logger as PinoLogger, LoggerOptions } from 'pino'

import { REDACT_COMMON_FIELDS } from './constants/default-redact-paths.constants'
import type { ILogDestination } from './interfaces/log-destination.interface'
import type { ResolvedBymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { createTraceContextMixin } from './mixins/trace-context.mixin'
import type { LogContextService } from './services/log-context.service'
import { compileRedactPaths } from './utils/compile-redact-paths.util'
import { destinationToStream } from './utils/destination-to-stream'
import { createNameRedactor } from './utils/redact-by-name.util'
import type { Redactor } from './utils/redact-by-name.util'
import {
  buildResourceBindings,
  extraServiceFields,
  resolveServiceMetadata
} from './utils/resolve-resource.util'
import { sanitizeError, scrubStack } from './utils/sanitize-error.util'
import { createSizeBoundedSerializer } from './utils/truncate-large-entries'
import { RESERVED_LOG_KEYS } from '../shared/constants/reserved-log-keys.constants'

/**
 * One path segment: either a `["quoted"]` / `['quoted']` bracket segment, whose
 * contents are ONE name however many dots it holds, or a run of bare characters
 * between the separators.
 *
 * Tokenizing rather than rewriting brackets into dotted text is load-bearing: a
 * key may legitimately contain a dot, and `blob["social.security"]` rewritten as
 * `blob.social.security` yields the leaf `security` — a name that does not exist
 * in the payload, while the one that does goes uncovered.
 */
const PATH_SEGMENT = /\[\s*['"]([^'"]+)['"]\s*\]|([^.[\]]+)/g

/** An unquoted path segment that is an array index rather than a field name. */
const INDEX_SEGMENT = /^\d+$/

/**
 * The leaf field name of a `fast-redact` path.
 *
 * Consumer `redactPaths` are applied by Pino's stringifier, which runs AFTER the
 * serializer wrapper — so a field they cover was still raw when the size bound
 * built its 200-character `_preview`, and an oversized value leaked its secret
 * there. Feeding the leaf NAME to the walk closes that, and closes it for every
 * other surface the walk reaches (base and child bindings) rather than only for
 * the preview.
 *
 * The trade is deliberate and broader than the path: a consumer who writes
 * `user.ssn` gets `ssn` censored wherever it appears, not only under `user`.
 * That errs toward redacting a name the consumer has already declared secret.
 *
 * An UNQUOTED numeric segment is an array INDEX, not a field name, and is skipped
 * like a wildcard. `tokens[0]` yields `tokens`, not `0`: the walk matches names,
 * and it never compares array positions — feeding it `0` covered nothing while
 * censoring any object key that happened to be named `0`. Falling back to the
 * nearest name censors the whole `tokens` array, which is broader than the path
 * and in the safe direction. The QUOTED form is left alone: `["0"]` is explicit
 * key syntax, and an object key named `0` IS matched by the walk.
 *
 * @internal Exported only for unit testing — its edge cases (a wildcard-only
 *   path, a trailing separator, bracket syntax) are invisible in a serialized
 *   line, so they are asserted directly. NOT re-exported by the package barrel.
 * @param path - A `fast-redact` path, dotted and/or bracketed.
 * @returns The last segment that names a field, or `undefined` for a path with
 *   none (a wildcard- or index-only path).
 * @example
 *   leafNameOf('req.headers["x-api-key"]')  // 'x-api-key'
 *   leafNameOf('*.*.password')              // 'password'
 *   leafNameOf('tokens[0]')                 // 'tokens' — the index is not a name
 *   leafNameOf('blob["social.security"]')   // 'social.security' — one name, dots included
 */
export function leafNameOf(path: string): string | undefined {
  let leaf: string | undefined
  for (const match of path.matchAll(PATH_SEGMENT)) {
    const quoted = match[1]
    const name =
      quoted ?? (match[2] !== undefined && INDEX_SEGMENT.test(match[2]) ? undefined : match[2])
    // Stryker disable next-line ConditionalExpression: NOT equivalent, and not a coverage gap — the suite kills this mutant, verified by applying it by hand and watching three tests turn red (`leafNameOf yields no leaf for *`, `for *.*`, and the pass-through case in `resolveNameRedactor`). Stryker fails to attribute the killing tests to it under `perTest` coverage analysis, the same way it already does for `otel-detector.ts`. Recorded as what it is rather than mislabelled equivalent.
    if (name !== undefined && name !== '*') {
      leaf = name
    }
  }
  return leaf
}

/**
 * Fields the serializer derives itself, excluded from the own-property copy.
 *
 * A real `Error` keeps `name` / `message` / `stack` non-enumerable, so they never
 * reach the copy loop. An error-LIKE plain object — what `HttpExceptionFilter`
 * produces, and what any error crossing a worker boundary becomes — carries them
 * as ordinary own keys, and copying them would emit `name` beside the `type`
 * derived from it: the same value under two names, one of which no consumer
 * queries.
 */
const DERIVED_ERROR_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'message',
  'stack',
  'cause',
  'errors'
])

/**
 * The `err` serializer, replacing `pino.stdSerializers.err`.
 *
 * Two defects made the standard serializer the wrong tool here.
 *
 * It CLOBBERS the type. `stdSerializers.err` derives `type` from the value's
 * constructor, so anything that reached it already normalized into a plain
 * object came out as `type: "Object"` — every `ForbiddenException`, every
 * `HttpException`, every error the service had pre-serialized. The fix is
 * architectural rather than a special case: nothing pre-serializes any more, and
 * the type is read from the error itself.
 *
 * It DROPS the cause chain. `sanitizeError` already walks `cause` and
 * `AggregateError.errors` — depth- and width-bounded, circular-safe, and unable
 * to throw — and that work was being computed on one path and discarded on
 * another. Reusing it is both more correct and cheaper than re-serializing.
 *
 * The output keeps the LEGACY key names (`type`, `message`, `stack`) so every
 * existing query, dashboard and alert keeps working. `cause` and `errors` are
 * additive.
 *
 * @internal Exported only for unit testing. These hooks write fields whose
 *   absence is invisible in a serialized line — `JSON.stringify` drops a key
 *   holding `undefined` — so asserting them through the sink cannot tell an
 *   omitted field from one written as `undefined`. Mutation testing found that
 *   gap. NOT re-exported by the package barrel.
 * @param value_ - The thrown value, in whatever shape it reached the log call.
 * @returns A JSON-safe error object.
 * @example
 *   serializeErrorValue(new Error('outer', { cause: new Error('inner') }))
 *   // → { type: 'Error', message: 'outer', stack: '…',
 *   //     cause: { name: 'Error', message: 'inner', … } }
 */
export function serializeErrorValue(value_: unknown): Record<string, unknown> {
  const sanitized = sanitizeError(value_)
  const serialized: Record<string, unknown> = {
    // `type` rather than `name`: the field consumers already query.
    type: sanitized.name,
    message: sanitized.message
  }
  if (sanitized.stack !== undefined) {
    serialized['stack'] = sanitized.stack
  }
  if (sanitized.cause !== undefined) {
    serialized['cause'] = sanitized.cause
  }
  if (sanitized.errors !== undefined) {
    serialized['errors'] = sanitized.errors
  }
  // An error's OWN enumerable properties are part of the contract. Node puts
  // `code` on system errors, HTTP layers put `statusCode`, and application code
  // attaches domain fields — `pino.stdSerializers.err` copied all of them, so
  // dropping them here would have been a silent compatibility loss. They are
  // copied only where they do not shadow a field this serializer owns, and they
  // pass through the same redaction and size bound as any other serializer
  // output, which is what keeps a secret attached to an error from escaping.
  try {
    for (const [key, value] of Object.entries(value_ as Record<string, unknown>)) {
      if (!Object.hasOwn(serialized, key) && !DERIVED_ERROR_FIELDS.has(key)) {
        // `Reflect` keeps the dynamic write off the object-injection sink list.
        Reflect.set(serialized, key, value)
      }
    }
  } catch {
    // A hostile own-property enumeration degrades to the fields already read
    // rather than failing the entry: something is better than nothing, and the
    // never-throw contract on this path is absolute.
  }
  return serialized
}

/**
 * Add the Stable OpenTelemetry exception attributes alongside (or instead of)
 * the legacy `err` object.
 *
 * **Stability, verified 2026-08-13 against SemConv v1.44.0.** `exception.type`,
 * `exception.message` and `exception.stacktrace` are **Stable** on log records;
 * the spec requires at least one of `type` / `message` to be present, which is
 * satisfied here because both are derived from the same value. `error.type` is
 * **Stable** and must be low cardinality — it carries the error's CLASS NAME,
 * which is bounded by the number of exception types a codebase defines, never a
 * message or an identifier.
 *
 * `error.type` and `exception.type` are not redundant even when they hold the
 * same string: `exception.type` describes the thrown object, while `error.type`
 * is the classification a consumer aggregates on. Emitting both is what lets a
 * dashboard group by failure class without parsing the exception.
 *
 * Runs at `formatters.log`, so the value read here is the REDACTED copy the walk
 * produced — a cloned `Error` with resolved properties, never the caller's live
 * object. A hostile getter has already been dealt with by the fail-closed guard
 * upstream; the try/catch is the belt to that braces, because this hook must not
 * be the thing that throws inside a log call.
 *
 * @internal Exported only for unit testing. These hooks write fields whose
 *   absence is invisible in a serialized line — `JSON.stringify` drops a key
 *   holding `undefined` — so asserting them through the sink cannot tell an
 *   omitted field from one written as `undefined`. Mutation testing found that
 *   gap. NOT re-exported by the package barrel.
 * @param record - The redacted record about to be serialized.
 * @param format - `'pino'` keeps only `err`; `'semconv'` replaces it; `'both'`
 *   emits each.
 * @returns The record, with the exception attributes applied.
 * @example
 *   withSemconvException({ err: new TypeError('bad') }, 'both')
 *   // → { err: TypeError, 'exception.type': 'TypeError',
 *   //     'error.type': 'TypeError', 'exception.message': 'bad', … }
 */
export function withSemconvException(
  record: Record<string, unknown>,
  format: 'pino' | 'semconv' | 'both'
): Record<string, unknown> {
  if (format === 'pino') {
    return record
  }
  try {
    // Optional chaining rather than a type guard: a `null` or primitive `err`
    // yields `undefined` for every field and adds nothing, which is exactly what
    // a guard would have produced. A guard whose presence no input can
    // distinguish is not a check, it is untested code.
    const candidate = record['err'] as
      { name?: unknown; message?: unknown; stack?: unknown } | undefined
    if (typeof candidate?.name === 'string') {
      record['exception.type'] = candidate.name
      record['error.type'] = candidate.name
    }
    if (typeof candidate?.message === 'string') {
      record['exception.message'] = candidate.message
    }
    if (typeof candidate?.stack === 'string') {
      // Same scrubbing the legacy `err.stack` gets. Without it, a consumer moving
      // to `errorFormat: 'semconv'` would silently start seeing dependency frames
      // that the shape they migrated FROM had filtered out.
      record['exception.stacktrace'] = scrubStack(candidate.stack)
    }
    if (format === 'semconv') {
      // Explicitly opted out of the legacy shape. Kept as a deliberate choice
      // rather than a default: `err.*` is what every existing query reads, and
      // dropping it silently would break dashboards that never asked to migrate.
      //
      // Rebuilt rather than deleted: the redaction walk defines every property
      // of its snapshot as non-configurable, so `delete` throws `TypeError` here
      // — silently, into the catch below, leaving `err` in place. Adding keys
      // still works because the object itself is extensible; only the existing
      // properties are pinned. Measured, not assumed.
      const withoutErr: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) {
        if (key !== 'err') {
          Reflect.set(withoutErr, key, value)
        }
      }
      return withoutErr
    }
  } catch {
    // A value that resists reading leaves the legacy `err` untouched rather than
    // half-populated attributes. Partial semconv fields would be worse than
    // none: a consumer cannot tell an absent attribute from a failed read.
  }
  return record
}

/**
 * Derive an OTel-conforming event name from a `MODULE_ACTION_RESULT` log key.
 *
 * `logKey` and the event name are deliberately NOT the same string. OTel's
 * naming rules call for lowercase, dot-namespaced names; `PAYMENT_FAILED` is
 * neither, and emitting it verbatim would produce a non-conforming event name —
 * defeating the point of carrying the field at all. The mapping is lowercase
 * plus `_` → `.`, which is exactly reversible for the convention this library
 * already enforces on log keys:
 *
 *   `PAYMENT_FAILED`             → `payment.failed`
 *   `USER_AUTHENTICATION_FAILED` → `user.authentication.failed`
 *
 * `logKey` itself is untouched, so every existing query keeps working.
 *
 * Deliberately NOT memoized, and the cost is real rather than hypothetical:
 * measured at 949,560 vs 1,089,561 ops/sec on the info path (~13%), which is
 * ~7% of the full shipped configuration once the redaction walk is in the
 * picture. A cache would recover most of it, at the price of module-level
 * mutable state plus an arbitrary size bound — caller-controlled keys make an
 * unbounded one a memory leak. Two allocations per entry is the honest price of
 * a standards-conforming event name, and a consumer who does not want to pay it
 * sets `eventNameField: false` and pays nothing.
 *
 * @param logKey - The structured log key.
 * @returns The derived, lowercase dot-separated event name.
 */
function toEventName(logKey: string): string {
  return logKey.toLowerCase().replaceAll('_', '.')
}

/**
 * Derive the configured event-name field from `logKey`.
 *
 * **On the semantic convention, verified 2026-08-13 against SemConv v1.44.0.**
 * The `event.name` *attribute* is **Deprecated**: "The value of this attribute
 * MUST now be set as the value of the EventName field on the LogRecord to
 * indicate that the LogRecord represents an Event." `EventName` is a **top-level
 * field of the LogRecord** in the Stable Logs Data Model — not an attribute.
 *
 * A Pino line is JSON, and JSON has no notion of "top-level LogRecord field"
 * distinct from "attribute": every key is just a key. So this emits the value
 * under a key a bridge maps ONTO `EventName`, and the field name is configurable
 * precisely so a pipeline expecting a different key can say so. What must not
 * happen is the value being carried through into an OTLP *attributes* map under
 * the deprecated name; that is a mapping decision, documented in the OTel
 * integration guidelines, not something this library can enforce.
 *
 * Applied AFTER redaction: the value is a copy of `logKey`, which the walk has
 * already inspected, so re-walking it would cost a traversal to reach the same
 * answer.
 *
 * Only structured calls carry a `logKey`. The NestJS variadic bridge (`log`,
 * `warn`, `error`…) has none, and those entries correctly get no event name —
 * an ordinary diagnostic line is not an Event.
 *
 * @internal Exported only for unit testing. These hooks write fields whose
 *   absence is invisible in a serialized line — `JSON.stringify` drops a key
 *   holding `undefined` — so asserting them through the sink cannot tell an
 *   omitted field from one written as `undefined`. Mutation testing found that
 *   gap. NOT re-exported by the package barrel.
 * @param record - The redacted record about to be serialized.
 * @param field - The field name, or `false` to emit nothing.
 * @returns The same record, with the event name added when applicable.
 * @example
 *   withEventName({ logKey: 'PAYMENT_FAILED' }, 'event.name')
 *   // → { logKey: 'PAYMENT_FAILED', 'event.name': 'payment.failed' }
 */
export function withEventName(
  record: Record<string, unknown>,
  field: string | false
): Record<string, unknown> {
  if (field === false) {
    return record
  }
  const logKey: unknown = record['logKey']
  if (typeof logKey === 'string' && logKey.length > 0) {
    Reflect.set(record, field, toEventName(logKey))
  }
  return record
}

/** No-op redactor used when the name-walk is not the active strategy. */
const PASS_THROUGH: Redactor = (value: unknown): unknown => value

/**
 * Resolve the name-walk redactor for the active configuration, or a pass-through
 * when the walk is not in play (legacy `'paths'` strategy, or defaults disabled).
 *
 * @internal Exported only for unit testing — this is the switch that decides
 *   whether the DEFAULT PII protection is active at all, so its branches are
 *   asserted directly rather than inferred from a serialized line. NOT
 *   re-exported by the package barrel.
 * @param options - Fully-defaulted module options.
 * @returns A redaction function; the identity function when the walk is off.
 */
export function resolveNameRedactor(options: ResolvedBymaxLoggerModuleOptions): Redactor {
  if (options.redactStrategy !== 'names') {
    return PASS_THROUGH
  }
  const names = [
    ...(options.shouldDisableDefaultRedact ? [] : REDACT_COMMON_FIELDS),
    ...options.redactPaths.flatMap((path) => leafNameOf(path) ?? [])
  ]
  if (names.length === 0) {
    return PASS_THROUGH
  }
  return createNameRedactor(names, options.redactCensor)
}

/**
 * Build the `redact` option handed to Pino.
 *
 * Under `'names'` the default coverage is already applied by the walk, so
 * `fast-redact` is configured ONLY for the consumer's own `redactPaths` — and
 * skipped entirely when there are none, which keeps `fast-redact` off the hot
 * path completely for the common configuration.
 *
 * @internal Exported only for unit testing — the difference between "no
 *   `fast-redact` at all" and "`fast-redact` with the full default expansion" is
 *   a ~100× throughput difference that produces IDENTICAL log output, so it
 *   cannot be asserted from a serialized line. NOT re-exported by the package
 *   barrel.
 * @param options - Fully-defaulted module options.
 * @returns The Pino `redact` option, or `undefined` when nothing needs it.
 */
export function resolveRedactOption(
  options: ResolvedBymaxLoggerModuleOptions
): { paths: string[]; censor: string } | undefined {
  const paths =
    options.redactStrategy === 'paths'
      ? compileRedactPaths(options.redactPaths, options.shouldDisableDefaultRedact)
      : [...new Set(options.redactPaths)]
  if (paths.length === 0) {
    return undefined
  }
  return { paths, censor: options.redactCensor }
}

/**
 * Build a configured Pino instance from a resolved options snapshot.
 *
 * Each destination becomes one entry in a `pino.multistream` fan-out. A
 * destination's `minLevel` gates its own stream; entries below the Pino
 * instance's own `level` are filtered upstream by Pino before the multistream
 * sees them, so a `minLevel` BELOW the global `level` cannot widen what that
 * destination receives (a known multistream constraint, acceptable for v0.1).
 *
 * @param options - Fully-defaulted, frozen module options.
 * @param logContext - Request-context service consumed by the trace mixin.
 * @param destinations - Non-empty list of sinks to fan out to. The registry
 *   (`DestinationRegistry`) owns their `onInit` / `onShutdown` lifecycle; this
 *   factory only wires their streams.
 * @returns A configured Pino logger writing structured JSON to every destination.
 */
export function buildPinoInstance(
  options: ResolvedBymaxLoggerModuleOptions,
  logContext: LogContextService,
  destinations: readonly ILogDestination[]
): PinoLogger {
  const maxBytes = options.maxEntrySizeBytes
  const redact = resolveNameRedactor(options)

  // Every serializer (default `err` + any consumer-supplied) is composed as
  // size-bound(redact(serialize)). Two orderings matter here:
  //   1. Redaction runs on the serializer's OUTPUT. This is NOT a redundant
  //      second pass over data the `formatters.log` walk already saw — a
  //      serializer PRODUCES a value, and can synthesize fields that existed
  //      nowhere in the record the walk inspected (a derived token, a decoded
  //      claim, an `Error`'s own enumerable properties, which the walk skips
  //      because copying an `Error` would break the instance the `err`
  //      serializer keys off). Those fields reach the sink through this hook
  //      alone.
  //   2. Redaction runs BEFORE the size bound, so an oversized field's 200-char
  //      `_preview` carries `[REDACTED]` rather than the head of a secret.
  // `Object.fromEntries` avoids a dynamic `obj[key] =` write (which would trip
  // the object-injection lint rule).
  const bound = <T>(serializer: (input: T) => unknown): ((input: T) => unknown) =>
    createSizeBoundedSerializer((input: T) => redact(serializer(input)), maxBytes)
  const serializers = {
    err: bound(serializeErrorValue),
    ...Object.fromEntries(
      Object.entries(options.serializers).map(
        ([key, serializer]): [string, (input: unknown) => unknown] => [key, bound(serializer)]
      )
    )
  }

  const redactOption = resolveRedactOption(options)
  const pinoOptions: LoggerOptions = {
    level: options.level,
    ...(redactOption === undefined ? {} : { redact: redactOption }),
    // Resource identity, resolved ONCE here rather than per entry: Pino
    // pre-serializes `base` into the instance's chindings, so the cost of the
    // extra attributes is one string built at construction, not work per log.
    base: buildResourceBindings(
      resolveServiceMetadata(options.service),
      options.resourceFormat,
      extraServiceFields(options.service)
    ),
    // Pino requires the timestamp fn to emit the `,"time":"..."` fragment.
    timestamp: () => `,"time":"${options.timestamp()}"`,
    formatters: {
      // Emit the level as a string label instead of the numeric code — easier
      // for log aggregators. Trace context is injected via `mixin`, never via
      // `formatters.log` (which cannot see ambient ALS / OTel state).
      level: (label) => ({ level: label }),
      // `base` bindings never reach `formatters.log` — Pino pre-serializes them
      // into the instance's `chindings`, the same reason `child()` has to redact
      // its own. That matters because `service` is CONSUMER-supplied and
      // `applyDefaults` keeps whatever it was given: a `{ name, version, apiKey }`
      // went out in clear, where the path expansion had covered it via `*.*.apiKey`.
      // Redacting here rather than trimming to the two declared fields keeps a
      // consumer's extra metadata instead of silently dropping it. Runs ONCE, at
      // logger construction — no per-entry cost. `true`: bindings are a record
      // root, iterated rather than serialized.
      bindings: (bindings) => redact(bindings, true) as Record<string, unknown>,
      // The name-walk redactor runs here, on the merged record (mixin output +
      // the caller's object), which is exactly the surface a caller controls.
      // `base` and child bindings are NOT visible at this hook — they are
      // library-owned (`service`, the `@InjectLogger` context) and carry nothing
      // sensitive, which `pino-factory.spec.ts` pins.
      log: (record) =>
        withSemconvException(
          withEventName(redact(record, true) as Record<string, unknown>, options.eventNameField),
          options.errorFormat
        )
    },
    serializers,
    mixin: createTraceContextMixin(logContext, options.otel),
    // `formatters.log` is NOT the first code to touch the caller's object: Pino
    // merges the mixin result with it first, and the default strategy's
    // `Object.assign` invokes every own getter. A throwing getter therefore
    // crashed the log call before the redactor could return its fail-closed
    // envelope. Owning the merge moves that boundary inside the guarantee.
    mixinMergeStrategy: (mergeObject: object, mixinObject: object): object => {
      try {
        // Merged into a FRESH target rather than into `mixinObject`. `Object.assign`
        // copies key by key, so a getter that throws part-way leaves everything
        // read before it already written into the target — and the catch below
        // would then emit that prefix, contradicting the sentence it is written
        // under. A disposable target keeps the partial writes in the value that
        // is about to be discarded.
        return Object.assign({}, mixinObject, mergeObject)
      } catch {
        // The caller's object cannot be read, so it cannot be proven safe and is
        // dropped WHOLE — not up to the property that threw. The mixin's own
        // ambient context (requestId, trace ids) is library-produced and kept.
        return {
          ...mixinObject,
          _redactionFailed: true,
          _logKey: RESERVED_LOG_KEYS.LOGGER_REDACTION_FAILED
        }
      }
    }
  }

  const streams = destinations.map((destination) => ({
    level: destination.minLevel ?? options.level,
    stream: destinationToStream(destination)
  }))

  return pino(pinoOptions, pino.multistream(streams))
}
