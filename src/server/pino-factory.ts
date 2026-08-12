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
import { createSizeBoundedSerializer } from './utils/truncate-large-entries'
import { RESERVED_LOG_KEYS } from '../shared/constants/reserved-log-keys.constants'

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
  if (options.redactStrategy !== 'names' || options.shouldDisableDefaultRedact) {
    return PASS_THROUGH
  }
  return createNameRedactor(REDACT_COMMON_FIELDS, options.redactCensor)
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
    err: bound(pino.stdSerializers.err),
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
    base: { service: options.service },
    // Pino requires the timestamp fn to emit the `,"time":"..."` fragment.
    timestamp: () => `,"time":"${options.timestamp()}"`,
    formatters: {
      // Emit the level as a string label instead of the numeric code — easier
      // for log aggregators. Trace context is injected via `mixin`, never via
      // `formatters.log` (which cannot see ambient ALS / OTel state).
      level: (label) => ({ level: label }),
      // The name-walk redactor runs here, on the merged record (mixin output +
      // the caller's object), which is exactly the surface a caller controls.
      // `base` and child bindings are NOT visible at this hook — they are
      // library-owned (`service`, the `@InjectLogger` context) and carry nothing
      // sensitive, which `pino-factory.spec.ts` pins.
      log: (record) => redact(record, true) as Record<string, unknown>
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
