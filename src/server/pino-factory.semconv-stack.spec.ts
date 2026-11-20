/**
 * Pins that `exception.stacktrace` is the stack the `err` serializer writes, under every redaction
 * rule the options name: a `stack` that is named hides it whole, a `message` that is named is
 * censored in its header, for an `Error`, for an error-shaped object with no `name` and for an
 * `Error` with a `toJSON`, with `errorFormat` `semconv` and `both`.
 *
 * Layer: server, tests. Driven through the real factory.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'

const SECRET = 'SEC_9f3a'
const FRAME = 'FRAME_77c1'
const STACK = `Error: ${SECRET}\n    at ${FRAME} (/srv/app.js:1:1)`

/** The line written for `{ event, err }` under `extra`. */
function lineOf(err: unknown, extra: Partial<BymaxLoggerModuleOptions>): Record<string, unknown> {
  const lines: Array<Record<string, unknown>> = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const sink = { name: 'sink', write: (line: unknown) => lines.push(JSON.parse(String(line))) }
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [sink as never],
    new DestinationHealth()
  )
  new PinoLoggerService(pino).warn({ event: 'E', err })
  return lines[0] ?? {}
}

const plainError = (): Error => Object.assign(new Error(SECRET), { stack: STACK })
const noName = (): object => ({ message: SECRET, stack: STACK })
const withToJson = (): Error =>
  Object.assign(new Error(SECRET), { stack: STACK, toJSON: () => ({ detail: 'kept' }) })

describe('exception.stacktrace under the names the options hide', () => {
  describe.each(['semconv', 'both'] as const)('with errorFormat %s', (errorFormat) => {
    it.each([
      ['an Error', plainError],
      ['an error-shaped object with a name', () => ({ name: 'Err', message: SECRET, stack: STACK })]
    ])('is the censor when stack is named, for %s', (_label, make) => {
      const line = lineOf(make(), { redactPaths: ['stack'], errorFormat })

      expect(line['exception.stacktrace']).toBe('[REDACTED]')
      expect(JSON.stringify(line)).not.toContain(FRAME)
    })

    it('opens with the censored message when message is named, for an Error', () => {
      const line = lineOf(plainError(), { redactPaths: ['message'], errorFormat })

      expect(line['exception.stacktrace']).toMatch(/^Error: \[REDACTED\]\n/)
      expect(JSON.stringify(line)).not.toContain(SECRET)
    })

    it.each([
      ['an error-shaped object with no name', noName],
      ['an Error with a toJSON', withToJson]
    ])(
      'writes no stacktrace, as err writes none, when message is named, for %s',
      (_label, make) => {
        const line = lineOf(make(), { redactPaths: ['message'], errorFormat })

        expect(line).not.toHaveProperty('exception.stacktrace')
        expect(JSON.stringify(line)).not.toContain(SECRET)
      }
    )
  })

  it('is the same text as err.stack, with errorFormat both', () => {
    const line = lineOf(plainError(), { redactPaths: ['message'], errorFormat: 'both' })

    expect(line['exception.stacktrace']).toBe((line['err'] as { stack: string }).stack)
  })
})
