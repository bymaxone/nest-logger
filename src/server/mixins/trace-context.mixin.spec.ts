jest.mock('../utils/otel-detector', () => ({
  ...jest.requireActual('../utils/otel-detector'),
  detectOtelTraceApi: jest.fn()
}))

import pino from 'pino'

import { detectOtelTraceApi } from '../utils/otel-detector'
import type { OtelTraceApi } from '../utils/otel-detector'

import { LogContextService } from '../services/log-context.service'

import { createTraceContextMixin } from './trace-context.mixin'

const mockedDetect = jest.mocked(detectOtelTraceApi)

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN_ID = '00f067aa0ba902b7'
const ZERO_TRACE_ID = '0'.repeat(32)

type SpanContext = { traceId: string; spanId: string; traceFlags: number }
/** `traceFlags` is `unknown` so a single test can feed a malformed (non-numeric) value. */
type RawSpanContext = { traceId: string; spanId: string; traceFlags: unknown }

/** Build a fake OTel trace API around an optional span context. */
function apiWith(context: RawSpanContext | undefined): OtelTraceApi {
  return {
    getActiveSpan: () =>
      context === undefined ? undefined : { spanContext: () => context as SpanContext }
  }
}

const defaultFields = {
  traceIdField: 'traceId',
  spanIdField: 'spanId',
  traceFlagsField: 'traceFlags'
}

describe('createTraceContextMixin', () => {
  let logContext: LogContextService
  // The mixin ignores the logger arg, but the signature requires a PinoLogger.
  const logger = pino({ enabled: false })

  beforeEach(() => {
    logContext = new LogContextService()
  })

  it(/*
   * With auto-injection off and no active context, the mixin must contribute
   * nothing — proves it never fabricates fields.
   */
  'returns an empty object with no context and no OTel', () => {
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: false
    })
    expect(mixin({}, 30, logger)).toEqual({})
  })

  it(/*
   * The AsyncLocalStorage store must be merged into every entry so request
   * identifiers propagate.
   */
  'merges the LogContext store', () => {
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: false
    })
    logContext.run({ requestId: 'r_1', tenantId: 't_1', userId: 'u_1' }, () => {
      expect(mixin({}, 30, logger)).toMatchObject({
        requestId: 'r_1',
        tenantId: 't_1',
        userId: 'u_1'
      })
    })
  })

  it(/*
   * An active, valid span must inject traceId/spanId and the 2-hex traceFlags.
   */
  'injects trace context from an active valid span', () => {
    mockedDetect.mockReturnValue(
      apiWith({ traceId: VALID_TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })
    )
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: true
    })
    expect(mixin({}, 30, logger)).toEqual({
      traceId: VALID_TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: '01'
    })
  })

  it(/*
   * The all-zeros (no-trace) sentinel must be skipped so logs aren't tagged with
   * a meaningless trace ID.
   */
  'skips injection when the trace ID is all zeros', () => {
    mockedDetect.mockReturnValue(
      apiWith({ traceId: ZERO_TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })
    )
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: true
    })
    expect(mixin({}, 30, logger)).toEqual({})
  })

  it(/*
   * A valid trace ID paired with an invalid span ID must skip injection — a
   * half-valid correlation is worse than none.
   */
  'skips injection when the span ID is invalid', () => {
    mockedDetect.mockReturnValue(
      apiWith({ traceId: VALID_TRACE_ID, spanId: 'not-a-span', traceFlags: 1 })
    )
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: true
    })
    expect(mixin({}, 30, logger)).toEqual({})
  })

  it(/*
   * shouldAutoInjectTraceContext: false must disable OTel detection entirely, even if
   * a span would otherwise be active.
   */
  'does not inject when auto-injection is disabled', () => {
    mockedDetect.mockReturnValue(
      apiWith({ traceId: VALID_TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })
    )
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: false
    })
    expect(mixin({}, 30, logger)).toEqual({})
    expect(mockedDetect).not.toHaveBeenCalled()
  })

  it(/*
   * Custom field names must be honored so consumers can match the OTel Logs
   * Data Model wire format.
   */
  'honors custom field names', () => {
    mockedDetect.mockReturnValue(
      apiWith({ traceId: VALID_TRACE_ID, spanId: SPAN_ID, traceFlags: 1 })
    )
    const mixin = createTraceContextMixin(logContext, {
      traceIdField: 'trace_id',
      spanIdField: 'span_id',
      traceFlagsField: 'trace_flags',
      shouldAutoInjectTraceContext: true
    })
    expect(mixin({}, 30, logger)).toEqual({
      trace_id: VALID_TRACE_ID,
      span_id: SPAN_ID,
      trace_flags: '01'
    })
  })

  it(/*
   * traceFlags of 0 (unsampled but recorded) must still be emitted — a falsy
   * value must not be mistaken for "absent".
   */
  'emits traceFlags even when the value is zero', () => {
    mockedDetect.mockReturnValue(
      apiWith({ traceId: VALID_TRACE_ID, spanId: SPAN_ID, traceFlags: 0 })
    )
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: true
    })
    expect(mixin({}, 30, logger)).toEqual({
      traceId: VALID_TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: '00'
    })
  })

  it(/*
   * traceFlags larger than a byte must be masked to the low 8 bits so the
   * emitted value is always 2 hex digits (e.g. 511 -> "ff"), never longer than
   * the W3C one-byte format — guards against a malformed span.
   */
  'masks out-of-range traceFlags to a single byte', () => {
    mockedDetect.mockReturnValue(
      apiWith({ traceId: VALID_TRACE_ID, spanId: SPAN_ID, traceFlags: 511 })
    )
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: true
    })
    expect(mixin({}, 30, logger)).toEqual({
      traceId: VALID_TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 'ff'
    })
  })

  it(/*
   * When the API is present but no span is active, the mixin must contribute
   * nothing.
   */
  'skips injection when no span is active', () => {
    mockedDetect.mockReturnValue(apiWith(undefined))
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: true
    })
    expect(mixin({}, 30, logger)).toEqual({})
  })

  it(/*
   * A malformed span lacking a numeric traceFlags must still inject traceId/
   * spanId but skip traceFlags rather than throwing on the hot path.
   */
  'injects ids but skips traceFlags when traceFlags is not a number', () => {
    mockedDetect.mockReturnValue(
      apiWith({ traceId: VALID_TRACE_ID, spanId: SPAN_ID, traceFlags: 'oops' })
    )
    const mixin = createTraceContextMixin(logContext, {
      ...defaultFields,
      shouldAutoInjectTraceContext: true
    })
    expect(mixin({}, 30, logger)).toEqual({ traceId: VALID_TRACE_ID, spanId: SPAN_ID })
  })
})
