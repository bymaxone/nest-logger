/**
 * Pins four edges of the names and the stacks: a symbol that is not ASCII and is no letter (a copyright
 * sign, a sound recording sign) stands for a letter in a key, so a key drawn with symbols hides its value; an
 * own enumerable property of an `Error` called exactly `stack` is written as a stack; the stack keys at the
 * root of an entry are capped like those below it; and the positional stack of `error(object, stack)` has
 * the message hidden like the others.
 *
 * Layer: server, tests. Driven through the real factory.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { MAX_TEXT_LENGTH } from './utils/bounded-text.util'

const SECRET = 'SEC_9f3a'
const STACK = `Error: ${SECRET}\n    at f (/app/x.js:1:1)`

/** The line written for `{ event, ...payload }` under `extra`. */
function lineOf(
  payload: Record<string, unknown>,
  extra: Partial<BymaxLoggerModuleOptions> = {},
  call: (service: PinoLoggerService, payload: Record<string, unknown>) => void = (
    service,
    fields
  ) => service.warn(fields)
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
  call(new PinoLoggerService(pino), { event: 'E', ...payload })
  return lines[0] ?? ''
}

describe('a key drawn with symbols that are not letters', () => {
  it.each([
    ['\u2117assword'],
    ['\u00a9ookie'],
    ['tok\u212en'],
    ['s\u212ecret'],
    ['api\u2212key'],
    ['pass\u00d7word'],
    ['\u00aeauthorization'],
    ['to\u00b0ken']
  ])('hides a value under %j, at the top, below it and in a header array', (key) => {
    expect(lineOf({ [key]: SECRET })).not.toContain(SECRET)
    expect(lineOf({ meta: { nested: { [key]: SECRET } } })).not.toContain(SECRET)
    expect(lineOf({ meta: { rawHeaders: [key, SECRET, 'Accept', 'text/html'] } })).not.toContain(
      SECRET
    )
  })

  it.each([['pass\u2010word'], ['pass\u2013word'], ['pass\u00a0word']])(
    'still reads %j as a separator, so the value is hidden as under password',
    (key) => {
      expect(lineOf({ [key]: SECRET })).not.toContain(SECRET)
    }
  )

  it('keeps a key made of two words joined by a hyphen', () => {
    expect(lineOf({ 'user-name': SECRET })).toContain(SECRET)
  })

  it('keeps a key that is longer than every name and holds a symbol', () => {
    expect(lineOf({ [`${'a'.repeat(40)}\u00a9`]: SECRET })).toContain(SECRET)
  })
})

describe('an own enumerable stack of an Error', () => {
  const errorWithStack = (message: string): Error => {
    const err = new Error(message)
    Object.defineProperty(err, 'stack', {
      value: `Error: ${message}\n    at f (/app/x.js:1:1)`,
      enumerable: true
    })
    return err
  }

  it('is written as a stack, nested and under err, when message is a name to hide', () => {
    expect(
      lineOf({ meta: { failure: errorWithStack(SECRET) } }, { redactPaths: ['message'] })
    ).not.toContain(SECRET)
    expect(lineOf({ err: errorWithStack(SECRET) }, { redactPaths: ['message'] })).not.toContain(
      SECRET
    )
  })

  it('keeps the text when message is not a name to hide', () => {
    expect(lineOf({ meta: { failure: errorWithStack('kept text') } })).toContain('kept text')
  })
})

describe('the stack keys at the root of an entry', () => {
  const aliases = (count: number): Record<string, string> =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `stack${'\u200b'.repeat(i)}`,
        `Error: ${SECRET}\n at f`
      ])
    )

  it('are written as the censor when there are more than eight', () => {
    const line = lineOf({ message: SECRET, ...aliases(9) }, { redactPaths: ['message'] })

    expect(line).not.toContain(SECRET)
    expect(line).not.toContain('at f')
  })

  it('are searched for the message when there are eight', () => {
    const line = lineOf({ message: SECRET, ...aliases(8) }, { redactPaths: ['message'] })

    expect(line).not.toContain(SECRET)
    expect(line).toContain('at f')
  })

  it('are written as the censor when the message is longer than the text limit', () => {
    const message = 'm'.repeat(MAX_TEXT_LENGTH + 1)
    const line = lineOf(
      { message, stack: `Error: ${message}\n at f` },
      { redactPaths: ['message'] }
    )

    expect(line).not.toContain('mmmmmmmmmm')
    expect(line).not.toContain('at f')
  })
})

describe('the positional stack of error(object, stack)', () => {
  const errorCall = (service: PinoLoggerService, fields: Record<string, unknown>): void =>
    service.error(fields, `Error: ${SECRET}\n    at f (/app/x.js:1:1)`)

  it('has the message hidden when message is a name to hide', () => {
    const line = lineOf({ message: SECRET }, { redactPaths: ['message'] }, errorCall)

    expect(line).not.toContain(SECRET)
    expect(line).toContain('at f')
  })

  it('is kept when message is not a name to hide', () => {
    expect(lineOf({ message: SECRET }, {}, errorCall)).toContain(`Error: ${SECRET}`)
  })
})
