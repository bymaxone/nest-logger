/**
 * Pino instance factory.
 *
 * Layer: server — turns a resolved options snapshot into a configured Pino
 * logger. Wires PII redaction, the service base bindings, string level output,
 * the default error serializer, and the trace-context mixin (ALS + OTel), then
 * fans the serialized output out to every registered destination via
 * `pino.multistream`.
 */
import pino from 'pino'
import type { Logger as PinoLogger, LoggerOptions } from 'pino'

import type { ILogDestination } from './interfaces/log-destination.interface'
import type { ResolvedBymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { createTraceContextMixin } from './mixins/trace-context.mixin'
import type { LogContextService } from './services/log-context.service'
import { compileRedactPaths } from './utils/compile-redact-paths.util'
import { destinationToStream } from './utils/destination-to-stream'
import { createSizeBoundedSerializer } from './utils/truncate-large-entries'

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
  // Every serializer (default `err` + any consumer-supplied) is size-bounded so
  // an oversized field is replaced by a compact truncation envelope instead of
  // flooding the sink. `Object.fromEntries` avoids a dynamic `obj[key] =` write
  // (which would trip the object-injection lint rule).
  const maxBytes = options.maxEntrySizeBytes
  const serializers = {
    err: createSizeBoundedSerializer(pino.stdSerializers.err, maxBytes),
    ...Object.fromEntries(
      Object.entries(options.serializers).map(
        ([key, serializer]): [string, (input: unknown) => unknown] => [
          key,
          createSizeBoundedSerializer(serializer, maxBytes)
        ]
      )
    )
  }

  const pinoOptions: LoggerOptions = {
    level: options.level,
    redact: {
      paths: compileRedactPaths(options.redactPaths, options.shouldDisableDefaultRedact),
      censor: options.redactCensor
    },
    base: { service: options.service },
    // Pino requires the timestamp fn to emit the `,"time":"..."` fragment.
    timestamp: () => `,"time":"${options.timestamp()}"`,
    formatters: {
      // Emit the level as a string label instead of the numeric code — easier
      // for log aggregators. Trace context is injected via `mixin`, never via
      // `formatters.log` (which cannot see ambient ALS / OTel state).
      level: (label) => ({ level: label })
    },
    serializers,
    mixin: createTraceContextMixin(logContext, options.otel)
  }

  const streams = destinations.map((destination) => ({
    level: destination.minLevel ?? options.level,
    stream: destinationToStream(destination)
  }))

  return pino(pinoOptions, pino.multistream(streams))
}
