/**
 * Pins that a message is written at most 16384 characters long, wherever the logger writes one:
 * the `msg` of every call, the `message` of a serialized error and of each cause link, the
 * `message` of a nested error in the metadata, and the diagnostic reports of a failed destination.
 * Driven through the real Pino pipeline, on the line a destination receives.
 *
 * Layer: server, tests.
 */
import { applyDefaults } from './config/default-options'
import { buildPinoInstance, resolveNameRedactor } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { describeCause } from './utils/report-destination-failure.util'
import { HttpException } from '@nestjs/common'
import { sanitizeError } from './utils/sanitize-error.util'

const LIMIT = 16_384
const SUFFIX = '…[truncated]'
const BIG = 'x'.repeat(5_000_000)
const CUT = 'x'.repeat(LIMIT) + SUFFIX

function pipeline(): {
  service: PinoLoggerService
  entry: () => Record<string, any>
  line: () => string
} {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [{ name: 'capture', write: (line: string): void => void lines.push(line) }],
    new DestinationHealth()
  )
  return {
    service: new PinoLoggerService(pino, resolveNameRedactor(options)),
    entry: () => JSON.parse(lines[0] ?? '{}'),
    line: () => lines[0] ?? ''
  }
}

describe('the msg of a call', () => {
  it.each([
    ['info(key, message)', (s: PinoLoggerService) => s.info('KEY', BIG)],
    ['error(string)', (s: PinoLoggerService) => s.error(BIG)],
    ['error(Error)', (s: PinoLoggerService) => s.error(new Error(BIG))],
    [
      'errorStructured(key, Error)',
      (s: PinoLoggerService) => s.errorStructured('KEY', new Error(BIG), 'u1')
    ],
    ['warn(string)', (s: PinoLoggerService) => s.warn(BIG)]
  ])('is cut at the limit for %s', (_label, call) => {
    const { service, entry } = pipeline()

    call(service)

    expect(entry().msg).toBe(CUT)
  })

  it('leaves a message of exactly the limit, and one of ordinary length, as given', () => {
    const { service, entry } = pipeline()

    service.info('KEY', 'x'.repeat(LIMIT))

    expect(entry().msg).toBe('x'.repeat(LIMIT))
  })

  it('cuts after the line breaks are escaped, so the limit counts what is written', () => {
    const { service, entry } = pipeline()

    service.info('KEY', 'a\nb'.repeat(LIMIT))

    expect(entry().msg.length).toBe(LIMIT + SUFFIX.length)
    expect(entry().msg).not.toContain('\n')
  })
})

describe('the message of an error in the entry', () => {
  it('is cut for the root err, with the name and fields kept', () => {
    const { service, entry } = pipeline()
    const error = Object.assign(new Error('x'.repeat(30_000)), { code: 'E_BIG' })

    service.errorStructured('KEY', error, 'u1')

    expect(entry().err).toMatchObject({ code: 'E_BIG', message: CUT })
  })

  it('is cut for a cause link', () => {
    const { service, entry } = pipeline()

    service.errorStructured('KEY', new Error('top', { cause: new Error('x'.repeat(30_000)) }), 'u1')

    expect(entry().err.cause.message).toBe(CUT)
  })

  it('is cut for an error nested in the metadata', () => {
    const { service, entry } = pipeline()

    service.errorStructured('KEY', new Error('root'), 'u1', {
      nested: new Error('x'.repeat(30_000))
    })

    expect(entry().nested.message).toBe(CUT)
  })

  it('is cut for the stand-in of a value that is not an error', () => {
    expect(sanitizeError('x'.repeat(30_000)).message).toBe(CUT)
  })
})

describe('the report of a failed destination', () => {
  it('cuts the message of the cause, whether it is an error or not', () => {
    expect(describeCause(new Error('x'.repeat(30_000))).message).toBe(CUT)
    expect(describeCause('x'.repeat(30_000)).message).toBe(CUT)
  })
})

describe('the name of an error', () => {
  const longName = (): Error => Object.assign(new Error('boom'), { name: 'N'.repeat(100_000) })

  it('is cut for the serialized root err, a cause link and a nested Error in the metadata', () => {
    const cut = 'N'.repeat(LIMIT) + SUFFIX
    // Separate calls: two cut names and their two cut stacks together pass the 64 KiB size bound
    // of the err slot, which replaces the slot by its envelope.
    const root = pipeline()
    root.service.errorStructured('KEY', longName(), 'u1')
    const linked = pipeline()
    linked.service.errorStructured('KEY', new Error('top', { cause: longName() }), 'u1')
    const nested = pipeline()
    nested.service.errorStructured('KEY', new Error('root'), 'u1', { nested: longName() })

    expect(root.entry().err.type).toBe(cut)
    expect(linked.entry().err.cause.name).toBe(cut)
    expect(nested.entry().nested.type).toBe(cut)
  })

  it('is cut for the stand-in node and for the destination failure report', () => {
    expect(sanitizeError({ name: 'N'.repeat(100_000), message: 'x' }).name).toBe(
      'N'.repeat(LIMIT) + SUFFIX
    )
    expect(describeCause(longName()).type).toBe('N'.repeat(LIMIT) + SUFFIX)
  })
})

describe('a nested Error whose name, message or stack is an own enumerable field', () => {
  /** The shapes where the field loop copies the field before an added part could cut it. */
  const shapes: [string, string, () => Error][] = [
    [
      'a name set by the constructor',
      'name',
      () => {
        class Named extends Error {
          constructor() {
            super('boom')
            this.name = 'N'.repeat(100_000)
          }
        }
        return new Named()
      }
    ],
    [
      'a message assigned after construction',
      'message',
      () => Object.assign(new Error(), { message: 'M'.repeat(100_000) })
    ],
    ['an HttpException message', 'message', () => new HttpException('H'.repeat(100_000), 400)],
    [
      'an enumerable stack',
      'stack',
      () =>
        Object.defineProperty(new Error('x'), 'stack', {
          value: 'S'.repeat(100_000),
          enumerable: true
        })
    ]
  ]

  it.each(shapes)('is cut for %s', (_label, field, make) => {
    const { service, entry } = pipeline()

    service.errorStructured('KEY', new Error('root'), 'u1', { nested: make() })

    const written = entry().nested[field] as string
    expect(written.length).toBe(LIMIT + SUFFIX.length)
    expect(written.endsWith(SUFFIX)).toBe(true)
  })
})

describe('a name, message or stack that belongs to caller data', () => {
  it('is written as given on a plain object that only looks like an error', () => {
    const { service, entry } = pipeline()
    const long = 'P'.repeat(100_000)

    service.info('KEY', 'hello', 'u1', { shaped: { name: long, message: long, stack: long } })

    expect(entry().shaped).toEqual({ name: long, message: long, stack: long })
  })
})
