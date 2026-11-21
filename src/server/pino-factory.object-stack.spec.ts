/**
 * Pins that a plain-object message with a `message` and a `stack` of its own, which is no error to
 * the library, has the message hidden in the first line of its `stack` where the options hide
 * `message`, as the stack of an `err` is, and that its other text is left as it was written.
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
const STACK = `Error: ${SECRET}\n    at run (/srv/app.js:1:1)`

/** The line written by `call` on a service built under `extra`. */
function lineOf(
  call: (service: PinoLoggerService) => void,
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
  call(new PinoLoggerService(pino))
  return lines[0] ?? {}
}

describe('the stack of a plain-object message that has a message of its own', () => {
  it.each([
    ['warn', (s: PinoLoggerService) => s.warn({ message: SECRET, stack: STACK })],
    ['error', (s: PinoLoggerService) => s.error({ message: SECRET, stack: STACK })]
  ])('opens with the censored message, with %s', (_label, call) => {
    const line = lineOf(call, { redactPaths: ['message'] })

    expect(line['stack']).toBe('Error: [REDACTED]\n    at run (/srv/app.js:1:1)')
    expect(JSON.stringify(line)).not.toContain(SECRET)
  })

  it('hides a message that repeats in the header, and a message of several lines', () => {
    const repeated = lineOf(
      (s) =>
        s.warn({
          message: SECRET,
          stack: `Error: ${SECRET} ${SECRET}\n    at run (/srv/a.js:1:1)`
        }),
      { redactPaths: ['message'] }
    )
    const several = lineOf(
      (s) =>
        s.warn({
          message: `a\n${SECRET}\nb`,
          stack: `Error: a\n${SECRET}\nb\n    at run (/srv/a.js:1:1)`
        }),
      { redactPaths: ['message'] }
    )

    expect(repeated['stack']).toBe('Error: [REDACTED] [REDACTED]\n    at run (/srv/a.js:1:1)')
    expect(several['stack']).toBe('Error: [REDACTED]\n    at run (/srv/a.js:1:1)')
    expect(JSON.stringify([repeated, several])).not.toContain(SECRET)
  })

  it('is left as it was written when message is not a name to hide', () => {
    const line = lineOf((s) => s.warn({ message: SECRET, stack: STACK }), {
      redactPaths: ['password']
    })

    expect(line['stack']).toBe(STACK)
  })

  it('is left as it was written when its first line does not hold the message', () => {
    const stack = 'Error: other\n    at run (/srv/app.js:1:1)'
    const line = lineOf((s) => s.warn({ message: SECRET, stack }), { redactPaths: ['message'] })

    expect(line['stack']).toBe(stack)
  })

  it('does not touch a frame that holds the message text', () => {
    const stack = `Error: head\n    at ${SECRET} (/srv/app.js:1:1)`
    const line = lineOf((s) => s.warn({ message: SECRET, stack }), { redactPaths: ['message'] })

    expect(line['stack']).toBe(stack)
  })
})
