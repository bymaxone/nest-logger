/**
 * Pino mixin that enriches every log entry with ambient correlation context.
 *
 * Layer: server/mixins — bridges `AsyncLocalStorage` (request context) and the
 * active OpenTelemetry span into Pino's per-entry merge object. A mixin (not
 * `formatters.log`) is the correct hook because the data is ambient: derived
 * from the environment, not from the arguments passed to `logger.info(obj)`.
 *
 * @see https://github.com/pinojs/pino/blob/main/docs/api.md#mixin-function
 */
import type { Logger as PinoLogger } from 'pino'

import type { LogContextService } from '../services/log-context.service'
import { detectOtelTraceApi, isValidSpanId, isValidTraceId } from '../utils/otel-detector'
import type { OtelTraceApi } from '../utils/otel-detector'

/** Field-name targets and the auto-inject toggle for {@link createTraceContextMixin}. */
export interface TraceContextMixinOptions {
  /** Log field receiving the active trace ID. */
  traceIdField: string
  /** Log field receiving the active span ID. */
  spanIdField: string
  /** Log field receiving the W3C trace flags (2 lowercase hex digits). */
  traceFlagsField: string
  /** When `false`, OTel detection is skipped entirely. */
  shouldAutoInjectTraceContext: boolean
}

/**
 * Pino 10 mixin signature: invoked for every log entry to produce extra fields.
 */
type PinoMixin = (mergeObject: object, level: number, logger: PinoLogger) => Record<string, unknown>

/**
 * Build a Pino mixin that merges request context and OTel trace context.
 *
 * OTel detection runs once, at construction time, so the per-log hot path stays
 * allocation-light when the SDK is absent. The returned function keeps Pino's
 * mandatory 3-argument shape even though the arguments are unused — Pino 10
 * always calls the mixin with `(mergeObject, level, logger)`.
 *
 * @param logContext - The request-scoped context service.
 * @param opts - Field names and the auto-inject toggle.
 * @returns A Pino mixin merging context + trace fields into each entry.
 */
export function createTraceContextMixin(
  logContext: LogContextService,
  opts: TraceContextMixinOptions
): PinoMixin {
  const traceApi: OtelTraceApi | undefined = opts.shouldAutoInjectTraceContext
    ? detectOtelTraceApi()
    : undefined

  return function mixin(
    _mergeObject: object,
    _level: number,
    _logger: PinoLogger
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {}

    // 1. Request context (requestId, tenantId, userId, custom keys).
    const store = logContext.getStore()
    if (store) {
      Object.assign(merged, store)
    }

    // 2. OTel trace context — overrides store values when both are present.
    if (traceApi) {
      const span = traceApi.getActiveSpan()
      if (span) {
        const ctx = span.spanContext()
        // Both IDs must be valid W3C values, otherwise the correlation is
        // incoherent and a malformed value could be injected into logs.
        if (isValidTraceId(ctx.traceId) && isValidSpanId(ctx.spanId)) {
          Reflect.set(merged, opts.traceIdField, ctx.traceId)
          Reflect.set(merged, opts.spanIdField, ctx.spanId)
          // Defensive: a malformed span may omit traceFlags. Guarding keeps the
          // logger from throwing on the hot path.
          if (typeof ctx.traceFlags === 'number') {
            // W3C trace-flags is a single byte; mask to it so a malformed span
            // can never emit more than 2 lowercase hex digits (e.g. 256 -> "00").
            const flagsByte = ctx.traceFlags & 0xff
            Reflect.set(merged, opts.traceFlagsField, flagsByte.toString(16).padStart(2, '0'))
          }
        }
      }
    }

    return merged
  }
}
