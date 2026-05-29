/**
 * Pino instance factory.
 *
 * Layer: server — turns a resolved options snapshot into a configured Pino
 * logger. Wires PII redaction, the service base bindings, string level output,
 * the default error serializer, and the trace-context mixin (ALS + OTel).
 *
 * Single-stream stdout output for now; multi-destination fan-out arrives in
 * Phase 4 via the destination registry.
 */
import pino from 'pino'
import type { DestinationStream, Logger as PinoLogger, LoggerOptions } from 'pino'

import type { ResolvedBymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { createTraceContextMixin } from './mixins/trace-context.mixin'
import type { LogContextService } from './services/log-context.service'
import { compileRedactPaths } from './utils/compile-redact-paths.util'

/**
 * Build a configured Pino instance from a resolved options snapshot.
 *
 * @param options - Fully-defaulted, frozen module options.
 * @param logContext - Request-context service consumed by the trace mixin.
 * @param stream - Optional destination stream. Defaults to Pino's stdout sink.
 *   The multi-destination fan-out (Phase 4) and unit tests inject a stream here.
 * @returns A configured Pino logger writing structured JSON to the destination.
 */
export function buildPinoInstance(
  options: ResolvedBymaxLoggerModuleOptions,
  logContext: LogContextService,
  stream?: DestinationStream
): PinoLogger {
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
    serializers: {
      err: pino.stdSerializers.err,
      ...options.serializers
    },
    mixin: createTraceContextMixin(logContext, options.otel)
  }

  return stream ? pino(pinoOptions, stream) : pino(pinoOptions)
}
