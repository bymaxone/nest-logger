/**
 * Pins `maxStringLength` through the logger a module builds: what an entry carries for a long
 * string under a metadata key, in each redaction strategy and with no field name covered, and what
 * the option leaves whole (the log message, an `Error`'s stack and a value that is not text).
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { resolveNameRedactor } from './pino-factory'
import { TEXT_TRUNCATED } from './utils/bounded-text.util'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { buildPinoInstance, createCapture } from './__tests__/pino-factory.fixtures'

const LIMIT = 64

/** A logger built with `overrides`, and the entries its destination captured. */
function loggerWith(overrides: Record<string, unknown>) {
  const capture = createCapture()
  const logger = new PinoLoggerService(
    buildPinoInstance(
      applyDefaults({ service: { name: 'svc', version: '1.0.0' }, ...overrides }),
      new LogContextService(),
      [capture.destination]
    )
  )
  return { logger, capture }
}

const long = 'x'.repeat(LIMIT + 36)
const cutLong = 'x'.repeat(LIMIT) + TEXT_TRUNCATED

describe('maxStringLength through the logger', () => {
  it.each(['names', 'paths'])('cuts a long metadata string under redactStrategy %s', (strategy) => {
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT, redactStrategy: strategy })

    logger.info('K', 'message', undefined, { big: long, nested: { list: [long] } })

    const entry = capture.entries()[0] as { big: string; nested: { list: string[] } }
    expect(entry.big).toBe(cutLong)
    expect(entry.nested.list).toEqual([cutLong])
  })

  /*
   * With the default names switched off and no `redactPaths`, no field name is covered and the
   * record is not walked at all; setting the limit is what makes the walk run.
   */
  it('cuts the string even when no field name is covered', () => {
    const { logger, capture } = loggerWith({
      maxStringLength: LIMIT,
      shouldDisableDefaultRedact: true
    })

    logger.info('K', 'message', undefined, { big: long })

    expect((capture.entries()[0] as { big: string }).big).toBe(cutLong)
  })

  it('writes the string whole when the option is not set', () => {
    const { logger, capture } = loggerWith({})

    logger.info('K', 'message', undefined, { big: long })

    expect((capture.entries()[0] as { big: string }).big).toBe(long)
  })

  it('leaves the log message, the log key and a number as they are', () => {
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT })
    const message = 'm'.repeat(LIMIT * 4)

    logger.info('PAYMENT_REFUND_SUCCESS', message, undefined, { count: 123456789012 })

    const entry = capture.entries()[0] as Record<string, unknown>
    expect(entry['msg']).toBe(message)
    expect(entry['logKey']).toBe('PAYMENT_REFUND_SUCCESS')
    expect(entry['count']).toBe(123456789012)
  })

  it('cuts a long acting user id like any other string of the record', () => {
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT })

    logger.info('K', 'message', 'u'.repeat(LIMIT + 20))

    expect((capture.entries()[0] as { userId: string }).userId).toBe(
      'u'.repeat(LIMIT) + TEXT_TRUNCATED
    )
  })

  /*
   * A stack is longer than the limit by its nature, and it is the text an operator reads first, so
   * the option never touches it: not under `err`, and not in an Error held in the metadata.
   */
  it('keeps the whole stack of the error of an entry', () => {
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT })
    const error = new Error('failed')
    error.stack = `Error: failed\n${'    at frame (src/app.service.ts:10:5)\n'.repeat(30)}`

    logger.errorStructured('OPERATION_FAILED', error, undefined, { note: long })

    const entry = capture.entries()[0] as { err: { stack: string }; note: string }
    expect(entry.err.stack.length).toBeGreaterThan(LIMIT * 5)
    expect(entry.err.stack.startsWith('Error: failed\n    at frame')).toBe(true)
    expect(entry.note).toBe(cutLong)
  })

  /*
   * An Error under a key with no serializer is data of the record by the time the cut runs: the
   * walk wrote it as a plain object, so its stack is a string like any other and is cut. The Error
   * logged under `err`, which the test above covers, is the one that keeps its stack.
   */
  it('cuts the stack of an Error that sits in the metadata under another key', () => {
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT })
    const error = new Error('inner')
    error.stack = `Error: inner\n${'    at frame (src/app.service.ts:10:5)\n'.repeat(30)}`

    logger.info('K', 'message', undefined, { cause: error })

    const entry = capture.entries()[0] as { cause: { stack: string } }
    expect(entry.cause.stack).toBe(error.stack.slice(0, LIMIT) + TEXT_TRUNCATED)
  })
})

describe('maxStringLength through the logger: the key and what a serializer reads', () => {
  it('keeps a logKey longer than the limit whole, and the event name derived from it', () => {
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT })
    const key = 'PAYMENT_' + 'REFUND_'.repeat(20) + 'SUCCESS'

    logger.info(key, 'message')

    const entry = capture.entries()[0] as Record<string, unknown>
    expect(entry['logKey']).toBe(key)
    expect(entry['event.name']).toBe(key.toLowerCase().replace(/_/g, '.'))
  })

  it('keeps the text of an error-like object under err, which is not an Error', () => {
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT })
    const stack = `Error: m\n${'    at f (x.ts:1:1)\n'.repeat(40)}`

    logger.info('K', 'message', undefined, {
      err: { name: 'Error', message: 'y'.repeat(200), stack }
    })

    const err = (capture.entries()[0] as { err: { message: string; stack: string } }).err
    expect(err.message).toBe('y'.repeat(200))
    expect(err.stack).toBe(stack)
  })

  it('hands a custom serializer its input whole', () => {
    const { logger, capture } = loggerWith({
      maxStringLength: LIMIT,
      serializers: { order: (value: { notes: string }) => ({ notes: value.notes }) }
    })

    logger.info('K', 'message', undefined, { order: { notes: 'n'.repeat(500) } })

    expect((capture.entries()[0] as { order: { notes: string } }).order.notes).toBe('n'.repeat(500))
  })
})

describe('maxStringLength through the logger: what is written once', () => {
  /*
   * The service identity is a binding written when the logger is built, and a binding is not a
   * string of a record: a long service name or version is written whole on every line.
   */
  it('writes a service name and version longer than the limit whole', () => {
    const { logger, capture } = loggerWith({
      maxStringLength: LIMIT,
      service: { name: 'n'.repeat(LIMIT + 16), version: 'v'.repeat(LIMIT + 6) }
    })

    logger.info('K', 'message')

    const service = (capture.entries()[0] as { service: { name: string; version: string } }).service
    expect(service).toEqual({ name: 'n'.repeat(LIMIT + 16), version: 'v'.repeat(LIMIT + 6) })
  })

  it('does not cut the bindings a child logger is given', () => {
    const redactBindings = resolveNameRedactor(
      applyDefaults({ service: { name: 'svc', version: '1.0.0' }, maxStringLength: LIMIT })
    )

    expect(redactBindings({ context: 'C'.repeat(LIMIT + 20) }, true)).toEqual({
      context: 'C'.repeat(LIMIT + 20)
    })
  })
})

describe('maxStringLength through the logger: the configured censor', () => {
  /*
   * The options refuse a censor longer than the limit, so the longest one is exactly the limit, and
   * it is written whole: a consumer recognizes the censor by its exact text.
   */
  it('writes a censor of exactly the limit whole', () => {
    const censor = 'R'.repeat(LIMIT)
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT, redactCensor: censor })

    logger.info('K', 'message', undefined, { password: 'secret-value', note: long })

    const entry = capture.entries()[0] as Record<string, unknown>
    expect(entry['password']).toBe(censor)
    expect(entry['note']).toBe(cutLong)
  })
})

describe('maxStringLength through the logger: the exception fields', () => {
  /*
   * The fields the library derives from an error are written after the cut, so no name has to be
   * left whole for them, and a key of the caller's with the same name is cut like any other string:
   * left whole it would be a string no size cap bounds, since only `err` and the serializer keys
   * are bounded by `maxEntrySizeBytes`.
   */
  it.each(['pino', 'semconv'] as const)(
    'cuts a key of the caller named like an exception field under errorFormat %s',
    (errorFormat) => {
      const { logger, capture } = loggerWith({ maxStringLength: LIMIT, errorFormat })

      logger.info('K', 'message', undefined, {
        'exception.message': long,
        'exception.stacktrace': long,
        'error.type': long
      })

      const entry = capture.entries()[0] as Record<string, unknown>
      expect(entry['exception.message']).toBe(cutLong)
      expect(entry['exception.stacktrace']).toBe(cutLong)
      expect(entry['error.type']).toBe(cutLong)
    }
  )

  it('writes the exception fields derived from the error whole, after the cut', () => {
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT, errorFormat: 'semconv' })
    const error = new Error('m'.repeat(LIMIT + 40))

    logger.errorStructured('OPERATION_FAILED', error)

    const entry = capture.entries()[0] as Record<string, string>
    expect(entry['exception.type']).toBe('Error')
    expect(entry['exception.message']).toBe('m'.repeat(LIMIT + 40))
  })
})
