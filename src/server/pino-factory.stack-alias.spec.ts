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
import { MAX_TEXT_LENGTH } from './utils/bounded-text.util'
import { MAX_STACK_SCAN } from './utils/sanitize-error.util'

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

  it('hides the message in a stack key only, not in another field that holds the same text', () => {
    const line = lineOf(
      { message: SECRET, Stack: STACK, note: `see ${SECRET}` },
      { redactPaths: ['message'] }
    )

    expect(line).toContain(`see ${SECRET}`)
    expect(line).not.toContain(`Error: ${SECRET}`)
  })

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

describe('the stack of a plain object that is very long or very dense', () => {
  /** The stack of an object under `meta`, as a log line. */
  const lineFor = (message: string, stack: string): string =>
    lineOf({ meta: { message, stack } }, { redactPaths: ['message'] })

  /**
   * Given a stack of a million characters of one kind and a message of four of them
   * When the entry is written
   * Then it takes little time and little memory, whatever the stack holds
   */
  it('is written in bounded time and memory for a dense stack of a million characters', () => {
    const stack = `Error: ${'a'.repeat(1_000_000)}`
    const before = process.memoryUsage().rss
    const started = Date.now()

    const line = lineFor('aaaa', stack)

    expect(Date.now() - started).toBeLessThan(3_000)
    expect(process.memoryUsage().rss - before).toBeLessThan(300_000_000)
    expect(line).not.toContain('aaaa')
  })

  /**
   * Given a message longer than the text limit that a stack repeats
   * When the entry is written
   * Then the stack is the censor, and the message is not searched for in a million characters
   */
  it('is written as the censor when the message is longer than the text limit', () => {
    const message = 'k'.repeat(1_000_000)
    const started = Date.now()

    const line = lineFor(message, `Error: ${message}\n${'k'.repeat(1_000_000)}`)

    expect(Date.now() - started).toBeLessThan(3_000)
    expect(line).not.toContain('kkkkkkkkkk')
    expect(line).toContain('[REDACTED]')
  })
})

describe('the length of the message a plain-object stack is searched for', () => {
  const stackOf = (message: string, stack: string): string =>
    (
      JSON.parse(lineOf({ meta: { message, stack } }, { redactPaths: ['message'] })) as {
        meta: { stack: string }
      }
    ).meta.stack

  /**
   * Given a message of exactly the text limit and one a character longer, each repeated by its stack
   * When the entry is written
   * Then the first is hidden where the stack repeats it and the second makes the stack the censor
   */
  it('searches a message of the text limit and gives up on one a character longer', () => {
    const exact = 'e'.repeat(MAX_TEXT_LENGTH)
    const longer = 'e'.repeat(MAX_TEXT_LENGTH + 1)

    expect(stackOf(exact, `Error: ${exact}\n    at f (/app/x.js:1:1)`)).toBe(
      'Error: [REDACTED]\n    at f (/app/x.js:1:1)'
    )
    expect(stackOf(longer, `Error: ${longer}\n    at f (/app/x.js:1:1)`)).toBe('[REDACTED]')
  })

  /**
   * Given a message that starts before the end of the part of the stack that is read and ends after it
   * When the entry is written
   * Then none of it is left: the part searched reaches as far past the bound as the message is long
   */
  it('hides a message that starts before the bound and ends after it', () => {
    const message = `LEAKMARK${'q'.repeat(MAX_TEXT_LENGTH - 8)}`
    const head = 'Error: a\n'
    const stack = `${head}${'p'.repeat(MAX_STACK_SCAN - 100 - head.length)}${message}`
    expect(stack.indexOf('LEAKMARK')).toBe(MAX_STACK_SCAN - 100)

    const written = stackOf(message, stack)

    expect(written).not.toContain('LEAKMARK')
    expect(written).not.toContain('qqqq')
  })

  /**
   * Given a stack where earlier copies of the message shrink once hidden, so the text kept reaches
   * the bound, and a last copy that starts before the bound and ends after it
   * When the entry is written
   * Then no part of the last copy is written
   */
  it('hides a straddling copy when the copies before it shrink the text', () => {
    const message = `LEAKMARK${'q'.repeat(1_991)}`
    const head = 'Error: a\n'
    const copies = message.repeat(60)
    const filler = 'p'.repeat(MAX_STACK_SCAN - 100 - head.length - copies.length)
    const stack = `${head}${copies}${filler}${message}`
    expect(stack.lastIndexOf('LEAKMARK')).toBe(MAX_STACK_SCAN - 100)

    const written = stackOf(message, stack)

    expect(written).not.toContain('LEAKMARK')
    expect(written).not.toContain('qqqq')
    // The copy is replaced where it stands: the part searched reaches the end of the copy.
    expect(written).toContain('p[REDACTED]')
  })

  /**
   * Given dependency frames that are dropped from the text kept, and a copy that straddles the bound
   * When the entry is written
   * Then no part of the copy is written
   */
  it('hides a straddling copy when dependency frames before it are dropped', () => {
    const message = `LEAKMARK${'q'.repeat(1_991)}`
    const head = 'Error: a'
    const frame = '\n    at dep (/node_modules/x/index.js:1:1)'
    const app = '\n    at app (/srv/'
    const room = MAX_STACK_SCAN - 100 - head.length - app.length
    const frames = frame.repeat(Math.floor(room / frame.length))
    const filler = 'p'.repeat(room - frames.length)
    const stack = `${head}${frames}${app}${filler}${message}`
    expect(stack.lastIndexOf('LEAKMARK')).toBe(MAX_STACK_SCAN - 100)

    const written = stackOf(message, stack)

    expect(written).not.toContain('LEAKMARK')
    expect(written).not.toContain('qqqq')
    // The copy is replaced where it stands: the part searched reaches the end of the copy.
    expect(written).toContain('p[REDACTED]')
  })
})

describe('the caps on the stack keys and on the message at the root of an entry', () => {
  const KEYS = [
    'stack',
    'Stack',
    'STACK',
    'st\u200back',
    '\uff33tack',
    'sta ck',
    'st-ack',
    'sTack',
    'stAck'
  ]
  const FRAME = '\n    at f (/app/x.js:1:1)'

  /** The record written for an object message at the root, with the positional stack when one is given. */
  function recordOf(fields: Record<string, unknown>, positional?: string): Record<string, unknown> {
    const lines: string[] = []
    const options = applyDefaults({
      service: { name: 'app', version: '1.0.0' },
      redactPaths: ['message']
    })
    const sink = { name: 'sink', write: (line: unknown) => lines.push(String(line)) }
    const pino = buildPinoInstance(
      options,
      new LogContextService(),
      [sink as never],
      new DestinationHealth()
    )
    const logger = new PinoLoggerService(pino)
    if (positional === undefined) logger.warn({ event: 'E', ...fields })
    else logger.error(fields, positional)
    return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
  }

  /** What the record holds under the first `count` keys. */
  const writtenBy = (record: Record<string, unknown>, count: number): unknown[] =>
    KEYS.slice(0, count).map((key) => record[key])

  const stacksOf = (count: number): Record<string, string> =>
    Object.fromEntries(KEYS.slice(0, count).map((key) => [key, `Error: ${SECRET}${FRAME}`]))

  /**
   * Given a message and as many stack keys as the cap allows, and then one more
   * When the entry is written
   * Then each stack keeps its frames with the message hidden, and past the cap each is the censor
   */
  it('searches the stacks of eight keys and gives up on nine', () => {
    const eight = recordOf({ message: SECRET, ...stacksOf(8) })
    const nine = recordOf({ message: SECRET, ...stacksOf(9) })

    expect(writtenBy(eight, 8)).toEqual(Array(8).fill(`Error: [REDACTED]${FRAME}`))
    expect(writtenBy(nine, 9)).toEqual(Array(9).fill('[REDACTED]'))
  })

  /**
   * Given a stack passed beside the message, which counts as one of the stacks
   * When the keys and the positional stack make eight, and then nine
   * Then eight are searched and nine are the censor
   */
  it('counts the stack passed beside the message among the stacks', () => {
    const eight = recordOf({ message: SECRET, ...stacksOf(7) }, `Error: ${SECRET}${FRAME}`)
    const nine = recordOf({ message: SECRET, ...stacksOf(8) }, `Error: ${SECRET}${FRAME}`)

    expect(writtenBy(eight, 7)).toEqual(Array(7).fill(`Error: [REDACTED]${FRAME}`))
    expect(eight.stack).toBe(`Error: [REDACTED]${FRAME}`)
    expect(writtenBy(nine, 8)).toEqual(Array(8).fill('[REDACTED]'))
    expect(nine.stack).toBe('[REDACTED]')
  })

  /**
   * Given a message of exactly the text limit and one a character longer, each repeated by a stack
   * When the entry is written at the root
   * Then the first is hidden where the stack repeats it and the second makes the stack the censor
   */
  it('searches a message of the text limit at the root and gives up on one a character longer', () => {
    const exact = 'e'.repeat(MAX_TEXT_LENGTH)
    const longer = 'e'.repeat(MAX_TEXT_LENGTH + 1)

    expect(recordOf({ message: exact, stack: `Error: ${exact}${FRAME}` }).stack).toBe(
      `Error: [REDACTED]${FRAME}`
    )
    expect(recordOf({ message: longer, stack: `Error: ${longer}${FRAME}` }).stack).toBe(
      '[REDACTED]'
    )
  })
})
