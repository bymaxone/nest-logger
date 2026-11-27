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

import { refuseCensorBeyondLimit } from './config/validate-options'
import { REDACT_COMMON_FIELDS } from './constants/default-redact-paths.constants'
import type { ILogDestination } from './interfaces/log-destination.interface'
import type { ResolvedBymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import type { TruncationReason } from './interfaces/logger-observability.interface'
import { createTraceContextMixin } from './mixins/trace-context.mixin'
import type { DestinationHealth } from './services/destination-health.service'
import type { LogContextService } from './services/log-context.service'
import {
  capturedSet,
  lowerCase,
  allMatches,
  matchesPattern,
  pinoBuiltinsIntact,
  replaceAllText
} from './utils/captured-builtins.util'
import { compileRedactPaths } from './utils/compile-redact-paths.util'
import { cutStrings } from './utils/cut-strings.util'
import { destinationToStream } from './utils/destination-to-stream'
import {
  createEntryTextFinisher,
  createTextCensor,
  ENTRY_TEXT_FINISHER
} from './utils/entry-text-finisher.util'
import { guardChildBindings } from './utils/guard-child-bindings.util'
import { messageSerializers, redactMessageOutput } from './utils/guard-message-values.util'
import { mixinMergeFor } from './utils/merge-mixin-safely.util'
import {
  createOwnFieldPolicy,
  type OwnFieldPolicy,
  ALL_OWN_FIELDS
} from './utils/own-field-policy.util'
import { createNameRedactor, markErrorOutput } from './utils/redact-by-name.util'
import type { MessageRedactor, Redactor } from './utils/redact-by-name.util'
import { safeMinLevel } from './utils/report-destination-failure.util'
import {
  buildResourceBindings,
  extraServiceFields,
  resolveServiceMetadata
} from './utils/resolve-resource.util'
import { assignOwnErrorFields, sanitizeError } from './utils/sanitize-error.util'
import { withSemconvException } from './utils/semconv-exception.util'
import { withSerializedRequest } from './utils/serialize-request.util'
import { createSizeBoundedSerializer } from './utils/truncate-large-entries'

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
 * The leaf field name of a `@pinojs/redact` path.
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
 * @param path - A `@pinojs/redact` path, dotted and/or bracketed.
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
  for (const match of allMatches(PATH_SEGMENT, path)) {
    const quoted = match[1]
    const name =
      quoted ??
      (match[2] !== undefined && matchesPattern(INDEX_SEGMENT, match[2]) ? undefined : match[2])
    if (name !== undefined && name !== '*') {
      leaf = name
    }
  }
  return leaf
}

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
 * @param ownFields - Which of the error's own fields are written; every one by default.
 * @returns A JSON-safe error object.
 * @example
 *   serializeErrorValue(new Error('outer', { cause: new Error('inner') }))
 *   // → { type: 'Error', message: 'outer', stack: '…',
 *   //     cause: { name: 'Error', message: 'inner', … } }
 */
export function serializeErrorValue(
  value_: unknown,
  ownFields: OwnFieldPolicy = ALL_OWN_FIELDS,
  censorMessage?: (text: string) => string
): Record<string, unknown> {
  const sanitized = sanitizeError(value_, { ownFields, censorMessage })
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
  // dropping them here would have been a silent compatibility loss. They pass
  // through the same redaction and size bound as any other serializer output,
  // which is what keeps a secret attached to an error from escaping.
  //
  // Copied from the SANITIZED node rather than from the raw value, which is the
  // same set of fields by a shorter route: `sanitizeError` now performs that copy
  // at every depth, so reading the raw value again here would be the identical
  // walk written twice — and the version that drifts is always the one further
  // from the bug report.
  // The policy already applied when `sanitized` was built, so what this copies is filtered.
  assignOwnErrorFields(serialized, sanitized)
  return serialized
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
  return replaceAllText(lowerCase(logKey), '_', '.')
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
 * when the walk is not in play (legacy `'paths'` strategy, or defaults disabled) and
 * `errorOwnFields` is not `'safe'`.
 *
 * @internal Exported only for unit testing — this is the switch that decides
 *   whether the DEFAULT PII protection is active at all, so its branches are
 *   asserted directly rather than inferred from a serialized line. NOT
 *   re-exported by the package barrel.
 * @param options - Fully-defaulted module options.
 * @returns A redaction function; the identity function when the walk is off and the policy is not
 *   `errorOwnFields: 'safe'`, which walks the record whatever the strategy or the names covered.
 */
export function resolveNameRedactor(options: ResolvedBymaxLoggerModuleOptions): Redactor {
  return buildNameRedactor(options, true, options.redactStrategy === 'names')
}

/**
 * {@link resolveNameRedactor} for the record of an entry: the walk also runs when
 * `maxStringLength` is set, because the cut that follows reads only what the walk wrote.
 *
 * @internal NOT re-exported by the package barrel.
 * @param options - Fully-defaulted module options.
 * @returns The redaction function of the caller's record.
 */
function resolveRecordRedactor(options: ResolvedBymaxLoggerModuleOptions): Redactor {
  return buildNameRedactor(
    options,
    true,
    options.redactStrategy === 'names',
    options.maxStringLength !== undefined
  )
}

/**
 * The root keys `maxStringLength` leaves whole: the `logKey`, an identifier the event name is
 * derived from, and the keys that have a serializer (`err` and the keys of `serializers`), whose
 * output `maxEntrySizeBytes` already bounds. The fields the library writes itself, the event name
 * and the exception fields, are added after the cut, so no name is left whole for them.
 *
 * @param options - Fully-defaulted module options.
 * @returns The set of root keys.
 */
function wholeRootKeys(options: ResolvedBymaxLoggerModuleOptions): ReadonlySet<string> {
  return capturedSet(['logKey', 'err', ...Object.keys(options.serializers)])
}

/** The own-field policy the configuration resolves to. */
function ownFieldPolicyOf(options: ResolvedBymaxLoggerModuleOptions): OwnFieldPolicy {
  return createOwnFieldPolicy(options.errorOwnFields, options.errorOwnFieldNames)
}

/**
 * The names censored inside an `Error` under `redactStrategy: 'paths'`: the record's names belong to
 * `@pinojs/redact` there, but an `Error` is converted by the walk, so the default names are censored
 * in its own fields and its causes at any depth, beyond what the default path list reaches.
 */
function namesInsideErrors(
  options: ResolvedBymaxLoggerModuleOptions
): readonly string[] | undefined {
  return options.shouldDisableDefaultRedact ? undefined : REDACT_COMMON_FIELDS
}

/**
 * Build the name-walk redactor from the configured coverage.
 *
 * This is what SERIALIZER output is redacted with, ungated — it ignores
 * `redactStrategy` on purpose.
 *
 * `redactStrategy: 'paths'` is an escape hatch for a consumer who depends on
 * `@pinojs/redact`'s exact path-matching over THEIR OWN payload. It was never a
 * statement about the fields this library synthesizes — and treating it as one
 * opened a hole the moment error serialization started carrying an error's own
 * properties at every depth of the `cause` chain.
 *
 * Measured, on the built artifact, with `redactStrategy: 'paths'` and a password
 * attached to the deepest link of `err.errors[0].cause.cause`:
 *
 * ```
 * {"type":"AggregateError", … ,"cause":{"name":"Error","message":"deep",
 *  "password":"LEAK-deep"}}
 * ```
 *
 * `DEFAULT_REDACT_PATHS` reaches `*.*.*.*.password` — four wildcard levels — and
 * the serialized shape goes deeper than that, so `@pinojs/redact` never saw the
 * field. The name walk has no depth ceiling, which is why it is the right tool
 * for output this library produces regardless of what the consumer chose for
 * their own record.
 *
 * `shouldDisableDefaultRedact` is still honoured: a consumer who explicitly
 * turned the default coverage off gets only the leaf names of their own
 * `redactPaths`.
 *
 * @param options - Fully-defaulted module options.
 * @param nestedErrorsAsData - `true` only for the redactor of the caller's record: an `Error`
 *   nested in it is written with its content. Serializer output keeps the shape the serializer
 *   chose, because the size bound that follows measures it and a larger value would be truncated
 *   where the same output was not; under `errorOwnFields: 'safe'` it is walked into plain data
 *   too, since nothing else would make it so.
 * @param coversNames - `false` for the record under the `'paths'` strategy, whose names
 *   `@pinojs/redact` covers.
 * @param forcesWalk - `true` for the record when `maxStringLength` is set: the cut that follows
 *   reads only what the walk wrote, so the walk runs even when it would redact nothing.
 * @returns A redaction function; the identity function when no name is covered and the policy is
 *   not `errorOwnFields: 'safe'`.
 */
function buildNameRedactor(
  options: ResolvedBymaxLoggerModuleOptions,
  nestedErrorsAsData = false,
  coversNames = true,
  forcesWalk = false
): MessageRedactor {
  const allNames = [
    ...(options.shouldDisableDefaultRedact ? [] : REDACT_COMMON_FIELDS),
    ...options.redactPaths.flatMap((path) => leafNameOf(path) ?? [])
  ]
  const names = coversNames ? allNames : []
  const ownFields = ownFieldPolicyOf(options)
  // With no name to cover the value is still walked under 'safe', which writes plain data only the
  // walk can produce: an `Error` nested in the record, and what a serializer returns. It is also
  // walked whenever Pino's own path redaction is configured, because that cannot read a `Buffer`.
  const walks = names.length > 0 || ownFields.safe || forcesWalk
  if (!walks && resolveRedactOption(options) === undefined) {
    return PASS_THROUGH
  }
  return nestedErrorsAsData && (walks || !coversNames)
    ? createNameRedactor(
        names,
        options.redactCensor,
        ['err', ...Object.keys(options.serializers)],
        undefined,
        ownFields,
        coversNames ? undefined : namesInsideErrors(options),
        allNames,
        !Object.hasOwn(options.serializers, 'err')
      )
    : createNameRedactor(
        names,
        options.redactCensor,
        undefined,
        undefined,
        ownFields,
        undefined,
        allNames
      )
}

/**
 * Build the `redact` option handed to Pino.
 *
 * Under `'names'` the default coverage is already applied by the walk, so
 * `@pinojs/redact` is configured ONLY for the consumer's own `redactPaths` — and
 * skipped entirely when there are none, which keeps `@pinojs/redact` off the hot
 * path completely for the common configuration.
 *
 * @internal Exported only for unit testing — the difference between "no
 *   `@pinojs/redact` at all" and "`@pinojs/redact` with the full default expansion" is
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
      : [...capturedSet(options.redactPaths)]
  if (paths.length === 0) {
    return undefined
  }
  return { paths, censor: options.redactCensor }
}

/** Called for each field the logger cuts or replaces for a size bound, to count it by its reason. */
type TruncationSink = (reason: TruncationReason) => void

/**
 * The serializers of the logger: the default `err` one and every consumer-supplied one, each
 * composed as size-bound(redact(serialize)).
 *
 * @param options - Fully-defaulted module options.
 * @param redactSerialized - The redactor applied to what a serializer returns.
 * @param ownFields - The own-field policy of an error.
 * @returns The Pino `serializers` option.
 */
function buildSerializers(
  options: ResolvedBymaxLoggerModuleOptions,
  redactSerialized: MessageRedactor,
  ownFields: OwnFieldPolicy,
  onTruncate: TruncationSink
): Record<string, (input: unknown) => unknown> {
  const maxBytes = options.maxEntrySizeBytes
  const censorMessage = buildMessageCensor(options)
  // Every serializer (default `err` + any consumer-supplied) is composed as
  // size-bound(redact(serialize)). Two orderings matter here:
  //   0. The redactor here is `buildNameRedactor`, applied ungated: it ignores
  //      `redactStrategy`. That strategy is the consumer's choice about THEIR
  //      OWN payload; this output is what the library synthesizes, and
  //      the default path list stops at four wildcards, short of the depth a
  //      cause chain serializes to.
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
  const asMessage = redactMessageOutput(options.redactStrategy, redactSerialized)
  const bound = <T>(
    serializer: (input: T) => unknown,
    redact: (output: unknown) => unknown = redactSerialized
  ): ((input: T) => unknown) =>
    createSizeBoundedSerializer(
      (input: T) => redact(serializer(input)),
      maxBytes,
      () => onTruncate('max_entry_size')
    )
  return {
    ...messageSerializers(options.redactStrategy, redactSerialized),
    err: bound((error) => markErrorOutput(serializeErrorValue(error, ownFields, censorMessage))),
    ...Object.fromEntries(
      Object.entries(options.serializers).map(
        ([key, serializer]): [string, (input: unknown) => unknown] => [
          key,
          bound(serializer, key === 'msg' ? asMessage : redactSerialized)
        ]
      )
    )
  }
}

/**
 * The function that censors the text of a message as the name `message` is: the stack of an error
 * opens with its message and the `exception.*` fields are copies of it, so they carry the censored
 * text, whatever the strategy.
 *
 * @param options - Fully-defaulted module options.
 * @returns The censor of a message text.
 * @internal Shared with the registry and the streams, for the message of the error in a failure
 *   line. NOT re-exported by the package barrel.
 */
export function buildMessageCensor(
  options: ResolvedBymaxLoggerModuleOptions
): (text: string) => string {
  const censor = createTextCensor(buildNameRedactor(options))
  return (text) => censor('message', text)
}

/**
 * Leaves on the instance the function that finishes the entry text of an object message: censored
 * under the names of its field, whatever the strategy, and cut at `maxStringLength` like the field.
 *
 * @param logger - The Pino instance the factory built.
 * @param options - Fully-defaulted module options.
 * @param onTruncate - Called for each text the finisher cuts, so the cuts are counted.
 * @returns `logger`.
 */
function withEntryTextFinisher(
  logger: PinoLogger,
  options: ResolvedBymaxLoggerModuleOptions,
  onTruncate: TruncationSink
): PinoLogger {
  // The defaults of the name redactor cover the names whatever the strategy.
  const redact = buildNameRedactor(options)
  const finisher = createEntryTextFinisher(redact, options.maxStringLength, () =>
    onTruncate('max_string_length')
  )
  Reflect.set(logger, ENTRY_TEXT_FINISHER, finisher)
  return logger
}

/**
 * The mixin that merges the request context and the trace context into each entry, given the censor
 * of the `message` of an entry for the warning it writes when the OTel install is broken.
 *
 * @param logContext - The request-scoped context service.
 * @param options - Fully-defaulted module options.
 * @returns The Pino mixin.
 */
function buildTraceMixin(
  logContext: LogContextService,
  options: ResolvedBymaxLoggerModuleOptions
): ReturnType<typeof createTraceContextMixin> {
  return createTraceContextMixin(logContext, {
    ...options.otel,
    censorMessage: buildMessageCensor(options)
  })
}

/**
 * An own value for each name the multistream reads off an entry that this library does not set: a
 * `levelVal` planted on `Object.prototype` would give every entry that level, and a `write` would make
 * the entry itself the stream.
 */
const UNSET_ENTRY_NAMES: Readonly<Record<string, undefined>> = {
  levelVal: undefined,
  write: undefined
}

/**
 * One multistream entry for each destination, each behind its bounded queue.
 *
 * @param options - Fully-defaulted module options.
 * @param destinations - The sinks to fan out to.
 * @param health - Init-health record shared with the registry.
 * @returns The entries `pino.multistream` takes.
 */
function buildStreams(
  options: ResolvedBymaxLoggerModuleOptions,
  destinations: readonly ILogDestination[],
  health: DestinationHealth
): pino.StreamEntry[] {
  const censorMessage = buildMessageCensor(options)
  return destinations.map((destination) => {
    const stream = destinationToStream(
      destination,
      health,
      options.destinationQueue.maxBytes,
      censorMessage
    )
    // The registry drains this buffer before it tells the destination to shut down.
    health.registerStream(destination, stream)
    return {
      ...UNSET_ENTRY_NAMES,
      // Guarded: this runs at provider construction, BEFORE any lifecycle hook, so a
      // consumer implementing `minLevel` as a throwing getter would fail the factory
      // and the application would never start — earlier than any fail-soft path can
      // contain. Unreadable and absent give the same answer: the module level.
      level: safeMinLevel(destination) ?? options.level,
      stream
    }
  })
}

/**
 * The `formatters.log` of the logger: the caller's record is redacted, its event name and
 * exception fields are added, and, when `maxStringLength` is set, its strings are cut.
 *
 * @param options - Fully-defaulted module options.
 * @param redactRecord - The redactor of the caller's record.
 * @returns The record formatter.
 */
function buildRecordFormatter(
  options: ResolvedBymaxLoggerModuleOptions,
  redactRecord: Redactor,
  onTruncate: TruncationSink
): (record: Record<string, unknown>) => Record<string, unknown> {
  // The request is serialized here, before the walk, and not as a Pino serializer: Pino runs the
  // record formatter first, so the walk would copy a whole `IncomingMessage`, its sockets and its
  // server, and hand the serializer a copy of own enumerable properties, which has no `headers`
  // because Node defines it as an accessor on the prototype. A host that registers its own `req`
  // serializer gets that copy, and `rawHeaders` is the field that carries the headers in it.
  const hostSerializesRequest = Object.hasOwn(options.serializers, 'req')
  const maxStringLength = options.maxStringLength
  const wholeRoots = wholeRootKeys(options)
  const censorMessage = buildMessageCensor(options)
  // The `stack` the `exception.*` fields copy is hidden by the names that hide the one `err` writes.
  const redactSerialized = buildNameRedactor(options)
  const redactStack = (stack: string): string =>
    (redactSerialized({ stack }) as { stack: string }).stack
  return (record) => {
    const redacted = redactRecord(
      hostSerializesRequest
        ? record
        : withSerializedRequest(record, options.http.secretPathSegments),
      true
    ) as Record<string, unknown>
    // The cut follows every censor, so it can never precede a rule that needs the whole string,
    // and it precedes the fields the library derives, which are written whole after it.
    const bounded =
      maxStringLength === undefined
        ? redacted
        : cutStrings(redacted, maxStringLength, wholeRoots, () => onTruncate('max_string_length'))
    return withSemconvException(
      withEventName(bounded, options.eventNameField),
      options.errorFormat,
      options.maxEntrySizeBytes,
      () => onTruncate('max_entry_size'),
      censorMessage,
      redactStack
    )
  }
}

/**
 * The `formatters` of the logger: the level as a label, and the name-walk redaction of the record
 * and of the bindings.
 *
 * @param redactBindings - The redactor of the bindings, which `maxStringLength` does not limit.
 * @param formatRecord - The record formatter, which redacts the caller's record.
 * @returns The Pino `formatters` option.
 */
function buildFormatters(
  redactBindings: Redactor,
  formatRecord: (record: Record<string, unknown>) => Record<string, unknown>
): NonNullable<LoggerOptions['formatters']> {
  return {
    // The level as a label, easier for log aggregators. Trace context comes from `mixin`:
    // `formatters.log` cannot see ambient ALS / OTel state.
    level: (label) => ({ level: label }),
    // `base` bindings never reach `formatters.log`: Pino pre-serializes them into `chindings`.
    // `service` is CONSUMER-supplied and `applyDefaults` keeps whatever it was given, so a
    // `{ name, version, apiKey }` is redacted here, which keeps the consumer's extra metadata
    // where trimming to the two declared fields would drop it. Runs ONCE, at logger
    // construction. `true`: bindings are a record root, iterated rather than serialized.
    bindings: (bindings) => redactBindings(bindings, true) as Record<string, unknown>,
    // The record, not bindings: `base` is redacted above, and a child's by `guardChildBindings`.
    log: formatRecord
  }
}

/**
 * An own value for each name Pino reads that this library does not set, so a key planted on
 * `Object.prototype` is not read in its place (a planted `transport` would be built at startup).
 * Pino tests each value for truth. The names are typed as a record, not as the options of Pino, whose
 * types have no `undefined` for `transport`.
 */
export const UNSET_PINO_NAMES: Readonly<Record<string, false | undefined>> = {
  transport: undefined,
  crlf: false,
  msgPrefix: undefined,
  name: undefined,
  writable: false,
  _writableState: undefined,
  prettyPrint: undefined,
  onChild: undefined
}

/**
 * Refuses what the options must not carry into a logger: a built-in the names are read with that was
 * replaced (a logger built then would carry the answer for good), and a censor beyond the string limit.
 * A derived backend can build resolved options without `validateOptions`, so the rule holds here too.
 */
function refuseUnsafeOptions(options: ResolvedBymaxLoggerModuleOptions): void {
  if (!pinoBuiltinsIntact()) throw new Error('LOGGER_BUILTINS_REPLACED')
  if (options.maxStringLength !== undefined) {
    refuseCensorBeyondLimit(options.redactCensor, options.maxStringLength)
  }
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
 * @param health - Init-health record shared with the registry. This factory runs
 *   while NestJS builds the DI graph — before any `onInit` — so the fan-out is
 *   necessarily wired from the full list and each stream consults the record at
 *   write time instead.
 * @returns A configured Pino logger writing structured JSON to every destination.
 */
export function buildPinoInstance(
  options: ResolvedBymaxLoggerModuleOptions,
  logContext: LogContextService,
  destinations: readonly ILogDestination[],
  health: DestinationHealth
): PinoLogger {
  refuseUnsafeOptions(options)
  // TWO redactors, deliberately, because they answer to different owners.
  //   - `redactRecord` honours `redactStrategy`: the caller's record is the
  //     caller's payload, and `'paths'` is their documented escape hatch (an e2e
  //     case pins its four-level ceiling as expected behaviour).
  //   - `redactSerialized` ignores it: serializer output is what THIS library
  //     synthesizes, and the ceiling cannot reach the depth a cause chain
  //     serializes to. Collapsing these two into one binding is what broke that
  //     e2e case, which is the check that caught it.
  const redactRecord = resolveRecordRedactor(options)
  const redactSerialized = buildNameRedactor(options)
  const redactBindings = resolveNameRedactor(options)
  const ownFields = ownFieldPolicyOf(options)

  const redactOption = resolveRedactOption(options)
  const onTruncate: TruncationSink = (reason) => health.recordTruncation(reason)
  const formatRecord = buildRecordFormatter(options, redactRecord, onTruncate)
  const pinoOptions: LoggerOptions = {
    level: options.level,
    ...(redactOption === undefined ? {} : { redact: { ...redactOption, remove: false } }),
    ...UNSET_PINO_NAMES,
    // Resource identity, resolved ONCE here rather than per entry: Pino pre-serializes `base` into
    // the instance's chindings, so the extra attributes cost one string at construction.
    base: buildResourceBindings(
      resolveServiceMetadata(options.service),
      options.resourceFormat,
      extraServiceFields(options.service)
    ),
    // Pino requires the timestamp fn to emit the `,"time":<json>` fragment, and
    // inserts it into the line verbatim. The value comes from consumer code, so it
    // is encoded as a JSON string here: a quote, a backslash or a newline in it must
    // neither break the line nor add fields to it.
    timestamp: () => `,"time":${JSON.stringify(String(options.timestamp()))}`,
    formatters: buildFormatters(redactBindings, formatRecord),
    serializers: buildSerializers(options, redactSerialized, ownFields, onTruncate),
    mixin: buildTraceMixin(logContext, options),
    mixinMergeStrategy: mixinMergeFor(options.redactStrategy)
  }

  const streams = pino.multistream(buildStreams(options, destinations, health))
  const logger = withEntryTextFinisher(pino(pinoOptions, streams), options, onTruncate)
  return guardChildBindings(logger, { redactBindings, redactSerialized, formatRecord }, options)
}
