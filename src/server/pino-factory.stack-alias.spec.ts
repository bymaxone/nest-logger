/**
 * Pins that a key that only spells `stack` is written as a stack: the message the options hide is
 * hidden in its header, for the fields of an object message at the root of an entry (as for the key
 * `stack` itself) and for an `Error`'s own property spelled that way, when `message` is a name to hide.
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
const STACK = `Error: ${SECRET}\n    at f (/app/x.js:1:1)`

/** The line written for `{ event, ...payload }` under `extra`. */
function lineOf(
  payload: Record<string, unknown>,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): string {
  const lines: string[] = []
  const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...extra })
  const sink = { name: 'sink', write: (line: unknown) => lines.push(String(line)) }
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [sink as never],
    new DestinationHealth()
  )
  new PinoLoggerService(pino).warn({ event: 'E', ...payload })
  return lines[0] ?? ''
}

const SPELLINGS = ['stack', 'Stack', 'STACK', 'st​ack', 'Ｓtack', 'sta ck', 'st-ack']

describe('the stack of an object message at the root of an entry', () => {
  it.each(SPELLINGS)('hides the message in the header under the key %j', (key) => {
    const line = lineOf({ message: SECRET, [key]: STACK }, { redactPaths: ['message'] })

    expect(line).not.toContain(SECRET)
  })

  it.each([[42], [{ frames: [SECRET] }], [null]])(
    'leaves a stack key that holds %j, which is no text, to the walk',
    (value) => {
      const line = lineOf({ message: SECRET, Stack: value }, { redactPaths: ['message'] })

      expect(line).not.toContain(`Error: ${SECRET}`)
      expect(line).toContain('"Stack"')
    }
  )

  it('keeps the text when message is not a name to hide', () => {
    expect(lineOf({ message: SECRET, Stack: STACK })).toContain(SECRET)
  })
})

describe('an own property of an Error that spells stack', () => {
  it.each(SPELLINGS.filter((key) => key !== 'stack'))(
    'is written with the message hidden in its header, under %j',
    (key) => {
      const err = Object.assign(new Error(SECRET), { [key]: STACK })

      expect(lineOf({ err }, { redactPaths: ['message'] })).not.toContain(SECRET)
    }
  )

  it('is kept when message is not a name to hide', () => {
    const err = Object.assign(new Error('benign'), {
      Stack: 'Error: kept\n    at f (/app/x.js:1:1)'
    })

    expect(lineOf({ err })).toContain('Error: kept')
  })
})
