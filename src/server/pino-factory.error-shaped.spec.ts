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
})
