/**
 * Pins that a message the options hide is hidden wherever a stack repeats it, not only where the stack
 * opens (`Caused by: Error: <message>` is written by some libraries), for an `Error`, for an `Error`
 * whose name is not text, for a cause and for an object that is no `Error`, and that the `stack` of an
 * object that is no `Error` is bounded and scrubbed at any depth, like the stack of an error.
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
const FRAME = '    at run (/srv/app.js:1:1)'
/** Characters that print as nothing. */
const INVISIBLE = ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad']

/** The text of the line written by `call` on a service built under `extra`. */
function lineOf(
  call: (service: PinoLoggerService) => void,
  extra: Partial<BymaxLoggerModuleOptions> = {}
): string {
  const lines: string[] = []
  const options = applyDefaults({
    service: { name: 'app', version: '1.0.0' },
    redactPaths: ['message'],
    ...extra
  })
  const sink = { name: 'sink', write: (line: unknown) => lines.push(String(line)) }
  const pino = buildPinoInstance(
    options,
    new LogContextService(),
    [sink as never],
    new DestinationHealth()
  )
  call(new PinoLoggerService(pino))
  return lines[0] ?? ''
}

/** An `Error` whose stack repeats its message below the header, as a library that appends causes does. */
function repeating(message: string, name?: unknown): Error {
  const error = new Error(message)
  if (name !== undefined) Object.defineProperty(error, 'name', { value: name })
  error.stack = `${String(name ?? 'Error')}: ${message}\n${FRAME}\nCaused by: Error: ${message}\n${FRAME}`
  return error
}

describe('a message the options hide, repeated in the body of a stack', () => {
  it.each([
    ['logged by error()', (s: PinoLoggerService) => s.error(repeating(SECRET))],
    [
      'logged by errorStructured()',
      (s: PinoLoggerService) => s.errorStructured('LIB_FAILED', repeating(SECRET))
    ],
    [
      'an error whose name is not text',
      (s: PinoLoggerService) => s.error(repeating(SECRET, { toString: () => 'N' }))
    ],
    [
      'a cause',
      (s: PinoLoggerService) =>
        s.error(Object.assign(new Error('outer'), { cause: repeating(SECRET) }))
    ],
    [
      'an object message',
      (s: PinoLoggerService) =>
        s.warn({
          message: SECRET,
          stack: `Error: ${SECRET}\n${FRAME}\nCaused by: Error: ${SECRET}`
        })
    ]
  ])('is hidden for %s', (_label, call) => {
    expect(lineOf(call, { errorFormat: 'both' })).not.toContain(SECRET)
  })

  it('is hidden in the stack of an object below the top level of an entry', () => {
    const line = lineOf((s) =>
      s.info('KEY', 'text', undefined, {
        deep: { n: { message: SECRET, stack: `Error: ${SECRET}\n${FRAME}\nCaused by: ${SECRET}` } }
      })
    )

    expect(line).not.toContain(SECRET)
  })
})

describe('the header of a stack whose name holds the text of the message', () => {
  const stackOf = (line: string): string =>
    (JSON.parse(line) as { err: { stack: string } }).err.stack

  it('keeps the name whole and hides the message in the header and below it', () => {
    class Named extends Error {}
    Named.prototype.name = SECRET
    const error = new Named(SECRET)
    error.stack = `${SECRET}: ${SECRET}\n${FRAME}\nCaused by: Error: ${SECRET}`

    const stack = stackOf(lineOf((s) => s.error(error)))

    expect(stack).toBe(`${SECRET}: [REDACTED]\n${FRAME}\nCaused by: Error: [REDACTED]`)
  })

  it('keeps a name that contains the message whole in the header, and hides it in the lines', () => {
    class ValidationError extends Error {}
    ValidationError.prototype.name = 'ValidationError'
    const error = new ValidationError('Error')
    error.stack = `ValidationError: Error\n    at new ValidationError (/srv/a.js:1:1)\nCaused by: Error`

    const stack = stackOf(lineOf((s) => s.error(error)))

    expect(stack.startsWith('ValidationError: [REDACTED]\n')).toBe(true)
    expect(stack.endsWith('Caused by: [REDACTED]')).toBe(true)
  })
})

describe('a message longer than the part of a stack that is read', () => {
  const PREFIX = 'DO_NOT_LOG_THIS_SECRET_'
  const long = `${PREFIX}${'x'.repeat(140_000)}`

  it('is hidden whole in a nested plain stack that opens with it', () => {
    const line = lineOf((s) =>
      s.info('KEY', 'text', undefined, { deep: { message: long, stack: `Error: ${long}` } })
    )

    expect(line).not.toContain(PREFIX)
  })

  it('is hidden whole in the stack of an Error that opens with it', () => {
    const error = new Error(long)
    error.stack = `Error: ${long}`

    expect(lineOf((s) => s.error(error))).not.toContain(PREFIX)
  })
})

describe('a message and a stack under a spelling the folding reads as a wildcard', () => {
  it.each([
    ['m\u04bbssage', 'stack'],
    ['message', 'st\u0251ck'],
    ['m\u04bbssage', 'st\u0251ck'],
    ['mes\u057dage', 'sta\u0441k']
  ])('hides the message in the stack of %j and %j', (messageKey, stackKey) => {
    const deep: Record<string, string> = {
      [messageKey]: SECRET,
      [stackKey]: `Error: ${SECRET}\n${FRAME}`
    }

    expect(lineOf((s) => s.info('KEY', 'text', undefined, { deep }))).not.toContain(SECRET)
  })
})

describe('a message that is no own enumerable key of an object with a stack', () => {
  it('is hidden in the stack all the same', () => {
    const deep: Record<string, string> = { stack: `Error: ${SECRET}\n${FRAME}` }
    Object.defineProperty(deep, 'message', { value: SECRET, enumerable: false })

    const line = lineOf((s) => s.info('KEY', 'text', undefined, { deep }))

    expect(line).not.toContain(SECRET)
  })

  it('is hidden when it is inherited', () => {
    const deep = Object.create({ message: SECRET }) as Record<string, string>
    deep['stack'] = `Error: ${SECRET}\n${FRAME}`

    expect(lineOf((s) => s.info('KEY', 'text', undefined, { deep }))).not.toContain(SECRET)
  })
})

describe('a payload with many keys that spell message or stack', () => {
  /** A spelling of `name` for each `index`, as long as six invisible characters: the index in base six. */
  const spelled = (name: string, index: number): string =>
    `${name}${[...index.toString(6).padStart(6, '0')].map((digit) => INVISIBLE[Number(digit)]).join('')}`
  const alias = (index: number): string => spelled('message', index)
  const stackOf = (line: string): string =>
    (JSON.parse(line) as { deep: { stack: string } }).deep.stack
  /** The milliseconds `lineOf` takes for `deep`, with its line. */
  const timed = (deep: Record<string, string>): { ms: number; line: string } => {
    const started = Date.now()
    const line = lineOf((s) => s.info('KEY', 'text', undefined, { deep }))
    return { ms: Date.now() - started, line }
  }

  it('costs about what the cap costs, and hides the stack whole, for 5,000 message aliases', () => {
    const stack = `Error: x\n${'z'.repeat(131_000)}`
    const make = (count: number): Record<string, string> => {
      const deep: Record<string, string> = { stack }
      for (let i = 0; i < count; i += 1) deep[alias(i)] = `secret${String(i)}`
      return deep
    }
    const cap = timed(make(8))

    const many = timed(make(5_000))

    expect(many.ms).toBeLessThan(cap.ms * 10 + 500)
    expect(stackOf(many.line)).toBe('[REDACTED]')
    expect(many.line).not.toContain('secret4999')
  })

  it('costs about what the cap costs, for 5,000 keys that spell stack', () => {
    const make = (count: number): Record<string, string> => {
      const deep: Record<string, string> = {}
      for (let i = 0; i < count; i += 1) {
        deep[spelled('stack', i)] = `Error: x\n${'z'.repeat(60_000)}`
      }
      return deep
    }
    const cap = timed(make(8))

    const many = timed(make(5_000))

    // A quadratic walk over 5,000 keys of 60,000 characters takes minutes; the margin is wide so a machine
    // that runs other work does not fail the gate.
    expect(many.ms).toBeLessThan(cap.ms * 10 + 2_000)
    expect(many.line).not.toContain('zzzz')
  })

  it('still hides the message in the stack for as many messages as the cap', () => {
    const deep: Record<string, string> = { stack: `Error: secret0 secret7\n${FRAME}` }
    for (let i = 0; i < 8; i += 1) deep[alias(i)] = `secret${String(i)}`

    const line = lineOf((s) => s.info('KEY', 'text', undefined, { deep }))

    expect(stackOf(line)).toBe(`Error: [REDACTED] [REDACTED]\n${FRAME}`)
  })
})

describe('the stack of an object that is no Error, at any depth', () => {
  const stackOf = (line: string): string =>
    (JSON.parse(line) as { meta?: unknown; deep: { stack: string } }).deep.stack

  it('is cut at the text limit, with the suffix, when it is long', () => {
    const line = lineOf((s) =>
      s.info('KEY', 'text', undefined, { deep: { stack: `E\n${'x'.repeat(200_000)}` } })
    )

    expect(stackOf(line).length).toBeLessThan(20_000)
    expect(stackOf(line).endsWith('[truncated]')).toBe(true)
  })

  it('drops dependency frames and escapes control characters', () => {
    const stack = `Error: a\u001b[31m\n${FRAME}\n    at dep (/srv/node_modules/p/i.js:1:1)`
    const line = lineOf((s) => s.info('KEY', 'text', undefined, { deep: { stack } }))

    expect(stackOf(line)).not.toContain('node_modules')
    expect(stackOf(line)).not.toContain('\u001b')
    expect(stackOf(line)).toContain(FRAME)
  })

  it('is left alone, apart from that, when it is short and clean', () => {
    const stack = `Error: a\n${FRAME}`
    const line = lineOf((s) => s.info('KEY', 'text', undefined, { deep: { stack } }))

    expect(stackOf(line)).toBe(stack)
  })
})
