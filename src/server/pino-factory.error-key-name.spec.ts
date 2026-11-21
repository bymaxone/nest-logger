/**
 * Pins that the name of an `Error` held under a key of your own, which the names strategy writes as
 * data, passes the censor of the message when it is text, in `name` and in `type`, as the name of the
 * `err` of an entry does; a name that reads as a name stays.
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

/** The line written for `{ event, error }` under `extra`. */
function lineOf(error: Error, extra: Partial<BymaxLoggerModuleOptions>): Record<string, unknown> {
  const lines: Array<Record<string, unknown>> = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const sink = { name: 'sink', write: (line: unknown) => lines.push(JSON.parse(String(line))) }
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [sink as never],
    new DestinationHealth()
  )
  new PinoLoggerService(pino).warn({ event: 'E', error } as never)
  return lines[0] ?? {}
}

/** An `Error` named `name`, with an own `name` as an assignment makes it. */
function errorNamed(name: string): Error {
  const error = new Error('msg')
  error.name = name
  return error
}

describe('the name of an Error under a key of your own, with redactStrategy names', () => {
  it.each([
    ['text that holds a value', `N_user=U token=${SECRET}`],
    ['a name longer than 64 characters', `Name${'x'.repeat(70)}${SECRET}`]
  ])('is censored in name and type when it is %s', (_label, name) => {
    const line = lineOf(errorNamed(name), { redactPaths: ['message'] })

    expect(line['error']).toMatchObject({ name: '[REDACTED]', type: '[REDACTED]' })
    expect(JSON.stringify(line)).not.toContain(SECRET)
  })

  it('keeps a name that reads as a name', () => {
    const line = lineOf(errorNamed('TypeError'), { redactPaths: ['message'] })

    expect(line['error']).toMatchObject({ name: 'TypeError', type: 'TypeError' })
  })

  it('keeps any name when message is not a name to hide', () => {
    const line = lineOf(errorNamed(`N_user=U token=${SECRET}`), { redactPaths: ['password'] })

    expect(line['error']).toMatchObject({ name: `N_user=U token=${SECRET}` })
  })
})
