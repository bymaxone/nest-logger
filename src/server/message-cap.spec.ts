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
