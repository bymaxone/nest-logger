import pino from 'pino'
import type { Logger } from 'pino'

import type { UnexpectedErrorReport } from '../interfaces/unexpected-error-sink.interface'
import { PinoLoggerService } from '../services/pino-logger.service'

import { PinoUnexpectedErrorSink } from './pino-unexpected-error.sink'

/**
 * nest-core's 1.6.2 contract, copied with one deliberate change (below). The
 * sink must stay assignable to it without importing nest-core: the assignment
 * in the first test is the compile-time check.
 *
 * `record` is declared as a property, not a method, on purpose: a method
 * signature compares its parameter bivariantly, so a report that stopped
 * guaranteeing a field this sink reads (an optional `route`) would still
 * typecheck. As a property it fails under `strictFunctionTypes`.
 */
interface NestCoreUnexpectedErrorReport {
  readonly error: unknown
  readonly method: string
  readonly route: string
  readonly correlationId?: string
  readonly traceId?: string
}
interface NestCoreUnexpectedErrorSink {
  record: (report: NestCoreUnexpectedErrorReport) => void
}

/** One sink over a logger whose `error` is a non-delegating mock. */
interface Harness {
  readonly sink: PinoUnexpectedErrorSink
  readonly errorSpy: jest.SpyInstance
  /** The payload object handed to `pino.error` by the single expected call. */
  readonly emittedPayload: () => Record<string, unknown>
}

/**
 * Build a fresh {@link Harness}. `error` is replaced by a `jest.fn()` that never
 * calls through, so only the arguments handed to Pino are under test; the
 * silent instance exists to give the remaining methods the `Logger` type
 * without a cast.
 *
 * @returns The sink, the `error` mock and a reader for its single payload.
 */
function createHarness(): Harness {
  const rawLogger: Logger = pino({ enabled: false })
  const errorSpy: jest.SpyInstance = jest
    .spyOn(rawLogger, 'error')
    .mockImplementation(() => undefined)
  return {
    sink: new PinoUnexpectedErrorSink(new PinoLoggerService(rawLogger)),
    errorSpy,
    emittedPayload: () => {
      expect(errorSpy).toHaveBeenCalledTimes(1)
      return errorSpy.mock.calls[0][0] as Record<string, unknown>
    }
  }
}

describe('PinoUnexpectedErrorSink — nest-core contract', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  it(/*
   * The class is bound to nest-core's token by shape alone, so its shape is the
   * contract. Assigning it to a verbatim copy of nest-core's interface fails
   * typecheck when nest-core's report stops providing a field this sink reads.
   */
  'is structurally assignable to the nest-core sink contract', () => {
    const asNestCore: NestCoreUnexpectedErrorSink = h.sink

    asNestCore.record({ error: new Error('boom'), method: 'GET', route: '/x' })

    expect(h.errorSpy).toHaveBeenCalledTimes(1)
  })
})

describe('PinoUnexpectedErrorSink — entry shape', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  it(/*
   * One error-level entry with the stable key, the ORIGINAL error by identity
   * (so the configured `err` serializer keeps its real type, stack and cause),
   * and the request coordinates the report carries.
   */
  'writes one HTTP_UNEXPECTED_ERROR entry with the error and request coordinates', () => {
    const error = new TypeError('x is undefined')

    h.sink.record({ error, method: 'GET', route: '/invoices/:id', correlationId: 'req-1' })

    expect(h.emittedPayload()).toEqual({
      logKey: 'HTTP_UNEXPECTED_ERROR',
      err: error,
      method: 'GET',
      route: '/invoices/:id',
      correlationId: 'req-1'
    })
    expect(h.emittedPayload()['err']).toBe(error)
    expect(h.errorSpy.mock.calls[0][1]).toBe('x is undefined')
  })

  it(/*
   * nest-core leaves the key out when no correlation id resolved; the entry
   * must not then carry `correlationId: undefined`.
   */
  'omits correlationId when the report has none', () => {
    h.sink.record({ error: new Error('boom'), method: 'POST', route: '<unmatched>' })

    expect(Object.keys(h.emittedPayload())).not.toContain('correlationId')
  })
})

describe('PinoUnexpectedErrorSink — what the entry leaves out', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  it(/*
   * The trace mixin already stamps the active span's trace id under the
   * configured field. Writing `report.traceId` here would override that field
   * and bypass `shouldAutoInjectTraceContext: false`.
   */
  'does not write the report traceId', () => {
    h.sink.record({
      error: new Error('boom'),
      method: 'GET',
      route: '/x',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736'
    })

    expect(Object.keys(h.emittedPayload())).not.toContain('traceId')
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

    h.sink.record(report)

    expect(Object.keys(h.emittedPayload()).sort()).toEqual(['err', 'logKey', 'method', 'route'])
    expect(JSON.stringify(h.emittedPayload())).not.toMatch(/secret-token|hunter2|reset-code/)
  })
})

describe('PinoUnexpectedErrorSink — arbitrary thrown values', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  it(/*
   * nest-core passes the thrown value uncut, and a thrown value need not be an
   * Error. A string must still produce a readable entry rather than a blank
   * message or a throw.
   */
  'normalizes a non-error thrown value', () => {
    h.sink.record({ error: 'plain string', method: 'GET', route: '/x' })

    expect(h.emittedPayload()['err']).toEqual({ name: 'UnknownError', message: 'plain string' })
    expect(h.errorSpy.mock.calls[0][1]).toBe('plain string')
  })

  it(/*
   * The thrown value is arbitrary application data. One whose `name` or
   * `message` getter throws must still produce the entry — degraded to the
   * sanitizer's failure shape — rather than being dropped while detecting
   * whether it is an error at all.
   */
  'still writes the entry when the thrown value has a throwing getter', () => {
    const hostile = Object.defineProperty({ name: 'Error' }, 'message', {
      enumerable: true,
      get(): string {
        throw new Error('hostile getter')
      }
    })

    h.sink.record({ error: hostile, method: 'GET', route: '/x' })

    expect(h.emittedPayload()).toMatchObject({
      logKey: 'HTTP_UNEXPECTED_ERROR',
      err: { name: 'SanitizeFailed' },
      method: 'GET',
      route: '/x'
    })
  })
})

describe('PinoUnexpectedErrorSink — failure containment', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })

  it(/*
   * The sink runs on nest-core's response path. A failing logger (a throwing
   * serializer or destination surfacing synchronously) must not escape.
   */
  'never throws when the logger throws', () => {
    h.errorSpy.mockImplementation(() => {
      throw new Error('serializer exploded')
    })

    expect(() => {
      h.sink.record({ error: new Error('boom'), method: 'GET', route: '/x' })
    }).not.toThrow()
    expect(h.errorSpy).toHaveBeenCalledTimes(1)
  })

  it(/*
   * A hostile report — a getter that throws — must not escape either.
   */
  'never throws on a report whose fields throw when read', () => {
    const report: UnexpectedErrorReport = { error: new Error('boom'), method: 'GET', route: '/x' }
    Object.defineProperty(report, 'method', {
      get(): string {
        throw new Error('hostile getter')
      }
    })

    expect(() => {
      h.sink.record(report)
    }).not.toThrow()
    expect(h.errorSpy).not.toHaveBeenCalled()
  })
})
