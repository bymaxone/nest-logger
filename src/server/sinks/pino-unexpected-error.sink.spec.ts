import pino from 'pino'
import type { Logger } from 'pino'

import type { UnexpectedErrorReport } from '../interfaces/unexpected-error-sink.interface'
import { PinoLoggerService } from '../services/pino-logger.service'

import { PinoUnexpectedErrorSink } from './pino-unexpected-error.sink'

/**
 * nest-core's contract as nest-core-8b published it for 1.6.2, copied verbatim.
 * The sink must stay assignable to it without importing nest-core: the
 * assignment in the first test is the compile-time check.
 */
interface NestCoreUnexpectedErrorReport {
  readonly error: unknown
  readonly method: string
  readonly route: string
  readonly correlationId?: string
  readonly traceId?: string
}
interface NestCoreUnexpectedErrorSink {
  record(report: NestCoreUnexpectedErrorReport): void
}

describe('PinoUnexpectedErrorSink', () => {
  let rawLogger: Logger
  let errorSpy: jest.SpyInstance
  let sink: PinoUnexpectedErrorSink

  beforeEach(() => {
    // A real but silent Pino instance: the spy sees exactly what reaches Pino.
    rawLogger = pino({ enabled: false })
    errorSpy = jest.spyOn(rawLogger, 'error')
    sink = new PinoUnexpectedErrorSink(new PinoLoggerService(rawLogger))
  })

  /** The payload object handed to `pino.error` by the single expected call. */
  function emittedPayload(): Record<string, unknown> {
    expect(errorSpy).toHaveBeenCalledTimes(1)
    return errorSpy.mock.calls[0][0] as Record<string, unknown>
  }

  it(/*
   * The class is bound to nest-core's token by shape alone, so its shape is the
   * contract. Assigning it to a verbatim copy of nest-core's interface fails
   * typecheck the moment the two drift apart.
   */
  'is structurally assignable to the nest-core sink contract', () => {
    const asNestCore: NestCoreUnexpectedErrorSink = sink

    asNestCore.record({ error: new Error('boom'), method: 'GET', route: '/x' })

    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it(/*
   * One error-level entry with the stable key, the ORIGINAL error by identity
   * (so the configured `err` serializer keeps its real type, stack and cause),
   * and the request coordinates the report carries.
   */
  'writes one HTTP_UNEXPECTED_ERROR entry with the error and request coordinates', () => {
    const error = new TypeError('x is undefined')

    sink.record({ error, method: 'GET', route: '/invoices/:id', correlationId: 'req-1' })

    expect(emittedPayload()).toEqual({
      logKey: 'HTTP_UNEXPECTED_ERROR',
      err: error,
      method: 'GET',
      route: '/invoices/:id',
      correlationId: 'req-1'
    })
    expect(emittedPayload()['err']).toBe(error)
    expect(errorSpy.mock.calls[0][1]).toBe('x is undefined')
  })

  it(/*
   * nest-core leaves the key out when no correlation id resolved; the entry
   * must not then carry `correlationId: undefined`.
   */
  'omits correlationId when the report has none', () => {
    sink.record({ error: new Error('boom'), method: 'POST', route: '<unmatched>' })

    expect(Object.keys(emittedPayload())).not.toContain('correlationId')
  })

  it(/*
   * The trace mixin already stamps the active span's trace id under the
   * configured field. Writing `report.traceId` here would override that field
   * and bypass `shouldAutoInjectTraceContext: false`.
   */
  'does not write the report traceId', () => {
    sink.record({
      error: new Error('boom'),
      method: 'GET',
      route: '/x',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736'
    })

    expect(Object.keys(emittedPayload())).not.toContain('traceId')
  })

  it(/*
   * nest-core passes the thrown value uncut, and a thrown value need not be an
   * Error. A string must still produce a readable entry rather than a blank
   * message or a throw.
   */
  'normalizes a non-error thrown value', () => {
    sink.record({ error: 'plain string', method: 'GET', route: '/x' })

    expect(emittedPayload()['err']).toEqual({ name: 'UnknownError', message: 'plain string' })
    expect(errorSpy.mock.calls[0][1]).toBe('plain string')
  })

  it(/*
   * Only the named coordinates are copied. A report object that carries more
   * than the contract (a future nest-core field, or a caller passing the
   * request) must not smuggle body, headers, query or the raw URL into the
   * entry.
   */
  'copies nothing from the report beyond the contract fields', () => {
    const report = {
      error: new Error('boom'),
      method: 'GET',
      route: '/x',
      headers: { authorization: 'Bearer secret-token' },
      body: { password: 'hunter2' },
      query: { token: 'reset-code' },
      url: '/x?token=reset-code'
    }

    sink.record(report)

    expect(Object.keys(emittedPayload()).sort()).toEqual(['err', 'logKey', 'method', 'route'])
    expect(JSON.stringify(emittedPayload())).not.toMatch(/secret-token|hunter2|reset-code/)
  })

  it(/*
   * The sink runs on nest-core's response path. A failing logger (a throwing
   * serializer or destination surfacing synchronously) must not escape.
   */
  'never throws when the logger throws', () => {
    errorSpy.mockImplementation(() => {
      throw new Error('serializer exploded')
    })

    expect(() => {
      sink.record({ error: new Error('boom'), method: 'GET', route: '/x' })
    }).not.toThrow()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it(/*
   * A hostile report — a getter that throws — must not escape either.
   */
  'never throws on a report whose fields throw when read', () => {
    const report = Object.defineProperty({ error: new Error('boom'), route: '/x' }, 'method', {
      enumerable: true,
      get(): string {
        throw new Error('hostile getter')
      }
    }) as unknown as UnexpectedErrorReport

    expect(() => {
      sink.record(report)
    }).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
