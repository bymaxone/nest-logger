/**
 * Pins that the message an error-shaped `toJSON` result carries is hidden in the first line of its
 * stack, under both redaction strategies: the walk follows the `toJSON` of the value under `err`, and
 * what it returns is left to the serializer of `err` as an error-shaped object is, which knows the
 * message the stack opens with.
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
const STACK = `TJ: ${SECRET}\n    at run (/srv/app.js:1:1)`
const result = (): object => ({ name: 'TJ', message: SECRET, stack: STACK })

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

describe('the stack header of an error-shaped toJSON result', () => {
  describe.each(['names', 'paths'] as const)('with redactStrategy %s', (redactStrategy) => {
    it.each([
      ['an Error', () => Object.assign(new Error('own'), { toJSON: result })],
      ['an object', () => ({ toJSON: result })],
      ['a function', () => Object.assign(() => 1, { toJSON: result })]
    ])('is censored in err.stack and exception.stacktrace, for %s', (label, make) => {
      /* Under 'paths' a path naming `message` holds an `Error`, and what its `toJSON` returns
       * that is not the value the `Error` has is the censor whole, the stack included. */
      const held = redactStrategy === 'paths' && label === 'an Error'
      const stack = held ? /^\[REDACTED\]$/ : /^TJ: \[REDACTED\]\n/
      const line = lineOf(make(), { redactPaths: ['message'], redactStrategy, errorFormat: 'both' })

      expect((line['err'] as { stack: string }).stack).toMatch(stack)
      expect(line['exception.stacktrace']).toMatch(stack)
      expect((line['err'] as { message: string }).message).toBe('[REDACTED]')
      expect(line['exception.message']).toBe('[REDACTED]')
      expect(JSON.stringify(line)).not.toContain(SECRET)
    })
  })

  it('keeps the type of an error-like object whose message is not text, with redactStrategy names', () => {
    const line = lineOf(
      { name: 'A', message: { detail: SECRET } },
      { redactPaths: ['message'], redactStrategy: 'names', errorFormat: 'both' }
    )

    expect(line['err']).toEqual({ type: 'A', message: '[REDACTED]' })
    expect(line['exception.message']).toBe('[REDACTED]')
    expect(JSON.stringify(line)).not.toContain(SECRET)
  })
})
