/**
 * Verifies the own values the factory hands Pino for the names it reads and the library does not set
 * (`transport`, `crlf`, `msgPrefix`, `name`, `writable`, `_writableState`, `prettyPrint`, `onChild`):
 * against the real Pino, at the point of use, a logger built with them writes what one built without
 * them writes, so an own `undefined` or `false` does not break the dependency it is handed to.
 *
 * Layer: server, tests. Driven through the real Pino.
 */
import pino from 'pino'

import { UNSET_PINO_NAMES } from './pino-factory'

/** The lines a logger built from `extra` writes for a spread of calls. */
function linesOf(extra: Record<string, unknown>): string[] {
  const lines: string[] = []
  const stream = pino.multistream([{ stream: { write: (line: string) => lines.push(line) } }])
  const logger = pino(
    {
      level: 'debug',
      base: { service: { name: 'app' } },
      timestamp: () => ',"time":"T"',
      formatters: { level: (label: string) => ({ level: label }) },
      redact: { paths: ['password'], censor: '[REDACTED]', remove: false },
      ...extra
    },
    stream
  )
  logger.info({ event: 'E', password: 'S1', n: 1 }, 'a message')
  logger.warn('plain')
  logger.trace('filtered out by the level')
  logger.error({ err: new Error('boom') }, 'failed')
  logger.child({ context: 'Ctx' }).debug({ k: 'v' }, 'from a child')
  return lines.map((line) => line.replace(/"stack":"[^"]*"/, '"stack":"S"'))
}

describe('the own values handed to Pino for the names the library does not set', () => {
  /**
   * Given a logger built with the own values and one built without them
   * When the same calls are made on both
   * Then the lines are the same, and neither throws
   */
  it('write what a logger without them writes', () => {
    const without = linesOf({})
    const withOwn = linesOf({ ...UNSET_PINO_NAMES })

    expect(withOwn).toEqual(without)
    expect(withOwn).toHaveLength(3)
    expect(withOwn[0]).toContain('"password":"[REDACTED]"')
    expect(withOwn.join('')).not.toContain('\r')
  })

  /**
   * Given each name taken alone
   * When a logger is built with only that one
   * Then it writes what a logger without it writes, so no one of them changes Pino by itself
   */
  it.each(Object.keys(UNSET_PINO_NAMES))('does not change what Pino writes, alone: %s', (name) => {
    const alone = { [name]: Reflect.get(UNSET_PINO_NAMES, name) as unknown }

    expect(linesOf(alone)).toEqual(linesOf({}))
  })
})
