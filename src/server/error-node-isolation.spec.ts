/**
 * Drives `errorStructured` through the real Pino pipeline with errors that cannot be read, to
 * pin what reaches the destination: the caller's `logKey` and metadata survive, and the error
 * node says what it lost.
 *
 * Layer: server, tests. Kept apart from the factory's spec, which is already past the size limit.
 */
import { applyDefaults } from './config/default-options'
import type { ILogDestination } from './interfaces/log-destination.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

/** A logger over the real factory whose destination captures each entry, parsed. */
function createPipeline(): {
  service: PinoLoggerService
  entries(): Record<string, unknown>[]
} {
  const lines: string[] = []
  const destination: ILogDestination = {
    name: 'capture',
    write(line: string): void {
      lines.push(line)
    }
  }
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [destination],
    new DestinationHealth()
  )
  return {
    service: new PinoLoggerService(pino),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

const throwing = (label: string): never => {
  throw new Error(label)
}

/** Each way an `Error` can refuse to be read, with what the error node should still say. */
const unreadable: [string, () => Error, Record<string, unknown>][] = [
  [
    'an ownKeys trap that throws',
    () =>
      new Proxy(Object.assign(new Error('boom'), { code: 'E1' }), {
        ownKeys: () => throwing('ownKeys exploded')
      }),
    { type: 'Error', message: 'boom', _errorFieldsIncomplete: true }
  ],
  [
    'an own getter that throws',
    () =>
      Object.defineProperty(new Error('boom'), 'detail', {
        enumerable: true,
        get: () => throwing('getter exploded')
      }),
    { type: 'Error', message: 'boom', _errorFieldsIncomplete: true }
  ],
  [
    'a stack getter that throws',
    () =>
      Object.defineProperty(new Error('boom'), 'stack', { get: () => throwing('stack exploded') }),
    { type: 'Error', message: 'boom', _errorFieldsIncomplete: true }
  ],
  [
    'a cause getter that throws',
    () =>
      Object.defineProperty(new Error('boom'), 'cause', { get: () => throwing('cause exploded') }),
    { type: 'Error', message: 'boom', _errorFieldsIncomplete: true }
  ],
  [
    'a message getter that throws',
    () =>
      Object.defineProperty(new Error('boom'), 'message', {
        get: () => throwing('message exploded')
      }),
    { type: 'SanitizeFailed' }
  ]
]

describe('errorStructured with an error that cannot be read', () => {
  it.each(unreadable)(
    'keeps the logKey and the metadata, and marks the error, for %s',
    (_label, makeError, expectedNode) => {
      /*
       * The entry is what an alert is keyed on, so one unreadable property of the error must
       * not cost it its `logKey`, its `userId` or its metadata. The record-level
       * LOGGER_REDACTION_FAILED envelope is reserved for a record that really cannot be read.
       */
      const { service, entries } = createPipeline()

      service.errorStructured('PAYMENT_FAILED', makeError(), 'u1', { paymentId: 'p1' })

      expect(entries()).toHaveLength(1)
      const entry = entries()[0] ?? {}
      expect(entry).toMatchObject({ logKey: 'PAYMENT_FAILED', userId: 'u1', paymentId: 'p1' })
      expect(entry).not.toHaveProperty('_redactionFailed')
      expect(entry['err']).toMatchObject(expectedNode)
    }
  )

  it(/*
   * The control: a readable error is emitted as before, with no marker.
   */
  'emits a readable error unchanged', () => {
    const { service, entries } = createPipeline()

    service.errorStructured('PAYMENT_FAILED', new TypeError('boom'), 'u1', { paymentId: 'p1' })

    const entry = entries()[0] ?? {}
    expect(entry).toMatchObject({ logKey: 'PAYMENT_FAILED', paymentId: 'p1' })
    expect(entry['err']).toMatchObject({ type: 'TypeError', message: 'boom' })
    expect(entry['err']).not.toHaveProperty('_errorFieldsIncomplete')
  })

  it(/*
   * A record whose metadata is hostile still fails closed as a whole: only an Error node is
   * isolated, so the envelope keeps its documented meaning.
   */
  'still fails the record when the metadata, not the error, is hostile', () => {
    const { service, entries } = createPipeline()
    // Nested one level, so it passes the service's own metadata copy and reaches the walk.
    const hostile = {
      nested: {
        get field(): never {
          return throwing('metadata exploded')
        }
      }
    }

    service.errorStructured('PAYMENT_FAILED', new Error('boom'), 'u1', hostile)

    expect(entries()[0]).toMatchObject({
      _redactionFailed: true,
      _logKey: 'LOGGER_REDACTION_FAILED'
    })
    expect(entries()[0]).not.toHaveProperty('logKey')
  })
})
