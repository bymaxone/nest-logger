/**
 * Pins that an error-shaped object logged as `err` is written with the same message and stack
 * header under both redaction strategies: the walk of the `names` strategy leaves the text of
 * that object to the serializer of `err`, which knows the message the stack opens with.
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

/** The `err` of the entry written for `thrown` under `extra`. */
function errOf(
  thrown: unknown,
  extra: Partial<BymaxLoggerModuleOptions>
): Record<string, unknown> | undefined {
  const lines: Array<{ err?: Record<string, unknown> }> = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const sink = { name: 'sink', write: (line: unknown) => lines.push(JSON.parse(String(line))) }
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [sink as never],
    new DestinationHealth()
  )
  new PinoLoggerService(pino).error(thrown)
  return lines[0]?.err
}

/** The whole line written for `thrown` under `extra`. */
function lineOf(
  thrown: unknown,
  extra: Partial<BymaxLoggerModuleOptions>
): Record<string, unknown> {
  const lines: Array<Record<string, unknown>> = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const sink = { name: 'sink', write: (line: unknown) => lines.push(JSON.parse(String(line))) }
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [sink as never],
    new DestinationHealth()
  )
  new PinoLoggerService(pino).error(thrown)
  return lines[0] ?? {}
}

describe('an error-shaped object logged as err', () => {
  const shaped = (): object => ({
    name: 'Err',
    message: SECRET,
    stack: `Err: ${SECRET}\n    at run (/srv/app.js:1:1)`
  })

  it.each([
    ['names', {}],
    ['paths', { redactStrategy: 'paths' as const }]
  ])('hides the message in its stack header under %s', (_strategy, extra) => {
    const err = errOf(shaped(), { redactPaths: ['message'], ...extra })

    expect(err?.['message']).toBe('[REDACTED]')
    expect(err?.['stack']).toMatch(/^Err: \[REDACTED\]\n/)
    expect(JSON.stringify(err)).not.toContain(SECRET)
  })

  it('still hides a name the options cover, in an own field of the object', () => {
    const err = errOf({ ...shaped(), password: SECRET }, { redactPaths: ['message'] })

    expect(err?.['password']).toBe('[REDACTED]')
  })

  it('leaves the text to the host when the host serializes err itself', () => {
    const err = errOf(shaped(), {
      redactPaths: ['message'],
      serializers: { err: (value: unknown) => ({ seen: (value as { message: string }).message }) }
    })

    expect(err).toEqual({ seen: '[REDACTED]' })
  })

  it.each(['pino', 'semconv', 'both'] as const)(
    'hides the stack in every field derived from it when stack is a name to hide, with errorFormat %s',
    (errorFormat) => {
      const line = lineOf(
        { ...shaped(), stack: `Err: ${SECRET}\n    at FRAME_9f3a (/srv/app.js:1:1)` },
        { redactPaths: ['stack'], errorFormat }
      )

      expect(JSON.stringify(line)).not.toContain('FRAME_9f3a')
    }
  )

  it.each(['semconv', 'both'] as const)(
    'writes exception.stacktrace as the censor when stack is a name to hide, with errorFormat %s',
    (errorFormat) => {
      const line = lineOf(shaped(), { redactPaths: ['stack'], errorFormat })

      expect(line['exception.stacktrace']).toBe('[REDACTED]')
    }
  )
})
