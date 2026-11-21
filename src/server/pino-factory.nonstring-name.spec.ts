/**
 * Pins that an `Error` whose `name` is not text is still read as an error: its message is hidden
 * where the options hide `message`, in the line's `msg` and in `err`, as it is for any other `Error`,
 * and its type is the one of an `Error`.
 *
 * Layer: server, tests. Driven through the real factory.
 */
import { applyDefaults } from './config/default-options'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { isErrorLike, sanitizeError } from './utils/sanitize-error.util'

const SECRET = 'SEC_9f3a'

/** An `Error` with a message that holds the secret and the `name` given. */
function errorNamed(name: unknown): Error {
  const error = new Error(`msg ${SECRET}`)
  Object.defineProperty(error, 'name', { value: name, configurable: true })
  return error
}

/** The line written when the Error is the message of a NestJS call, under redactPaths message. */
function lineOf(error: Error): Record<string, unknown> {
  const lines: Array<Record<string, unknown>> = []
  const options = applyDefaults({
    service: { name: 'app', version: '1.0.0' },
    redactPaths: ['message']
  })
  const sink = { name: 'sink', write: (line: unknown) => lines.push(JSON.parse(String(line))) }
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [sink as never],
    new DestinationHealth()
  )
  new PinoLoggerService(pino).warn(error as never)
  return lines[0] ?? {}
}

describe('an Error whose name is not text', () => {
  const names: Array<[string, unknown]> = [
    ['a number', 12],
    ['an array', ['a', 'b']],
    ['an object with a toString', { toString: () => 'N' }]
  ]

  it.each(names)('is read as an error, with the name %s', (_label, name) => {
    expect(isErrorLike(errorNamed(name))).toBe(true)
  })

  it.each(names)('is written as an Error with its message hidden, with the name %s', (_l, name) => {
    const line = lineOf(errorNamed(name))

    expect(JSON.stringify(line)).not.toContain(SECRET)
    expect((line['err'] as { type: string }).type).toBe('Error')
  })

  it('has the name Error in the sanitized node', () => {
    expect(sanitizeError(errorNamed(12)).name).toBe('Error')
  })

  it.each([42, { code: 'E1' }, undefined])(
    'is not read as an error when its message is not text either, and is not a failure: %j',
    (message) => {
      const error = new Error('x')
      Object.defineProperty(error, 'message', { value: message, configurable: true })

      expect(isErrorLike(error)).toBe(false)
      expect(sanitizeError(error).name).toBe('UnknownError')
    }
  )

  describe('when the name itself holds a value, with message hidden', () => {
    const secretNames: Array<[string, () => unknown]> = [
      ['an array', () => [SECRET]],
      ['an object with a toString', () => ({ toString: () => `obj ${SECRET}` })]
    ]

    const warn = (extra: Record<string, unknown>, call: (s: PinoLoggerService) => void): string => {
      const lines: string[] = []
      const options = applyDefaults({
        service: { name: 'app', version: '1.0.0' },
        redactPaths: ['message'],
        errorFormat: 'both',
        ...extra
      })
      const sink = { name: 'sink', write: (line: unknown) => lines.push(String(line)) }
      const pino = buildPinoInstance(
        options,
        new LogContextService(),
        [sink as never],
        new DestinationHealth()
      )
      call(new PinoLoggerService(pino))
      return lines[0] ?? ''
    }

    it.each(secretNames)(
      'writes nothing of the name %s as err, and opens the stack with Error',
      (_l, name) => {
        const line = warn({}, (s) => s.warn({ event: 'E', err: errorNamed(name()) } as never))

        expect(line).not.toContain(SECRET)
        expect((JSON.parse(line) as { err: { stack: string } }).err.stack).toMatch(/^Error: /)
      }
    )

    it.each(secretNames)(
      'writes nothing of the name %s as the message of a NestJS call',
      (_l, name) => {
        expect(warn({}, (s) => s.warn(errorNamed(name()) as never))).not.toContain(SECRET)
      }
    )

    it.each(secretNames)('writes nothing of the name %s under a key of your own', (_l, name) => {
      const line = warn({}, (s) => s.warn({ event: 'E', error: errorNamed(name()) } as never))

      expect(line).not.toContain(SECRET)
      expect((JSON.parse(line) as { error: { type: unknown } }).error.type).toBe('[REDACTED]')
    })

    it('keeps a name that is a number under a key of your own', () => {
      const line = warn({}, (s) => s.warn({ event: 'E', error: errorNamed(12) } as never))

      expect((JSON.parse(line) as { error: { type: unknown } }).error.type).toBe(12)
    })
  })
})
