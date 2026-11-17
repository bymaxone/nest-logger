/**
 * Pins `maxStringLength` through the logger a module builds: what an entry carries for a long
 * string under a metadata key, in each redaction strategy and with no field name covered, and what
 * the option leaves whole (the log message, an `Error`'s stack and a value that is not text).
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
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

  it('keeps the whole stack of an Error that sits in the metadata', () => {
    const { logger, capture } = loggerWith({ maxStringLength: LIMIT })
    const error = new Error('inner')
    error.stack = `Error: inner\n${'    at frame (src/app.service.ts:10:5)\n'.repeat(30)}`

    logger.info('K', 'message', undefined, { cause: error })

    const entry = capture.entries()[0] as { cause: { stack: string } }
    expect(entry.cause.stack.length).toBeGreaterThan(LIMIT * 5)
  })
})
