/**
 * Pins that an object with a `message` and a `stack` of its own, below the top level of an entry, has
 * the message hidden in the header of its stack where the options hide `message`, as the stack of an
 * `err` and the stack of an object message are: under a key of your own, in a list, in what a `toJSON`
 * returns, and in a cause. What it holds apart from that header is left as it was written.
 *
 * Layer: server, tests. Driven through the real factory.
 */
import { applyDefaults } from './config/default-options'
import type { BymaxLoggerModuleOptions } from './interfaces/logger-module-options.interface'
import { buildPinoInstance } from './pino-factory'
import { DestinationHealth } from './services/destination-health.service'
import { LogContextService } from './services/log-context.service'
import { PinoLoggerService } from './services/pino-logger.service'
import { createNameRedactor, markErrorOutput } from './utils/redact-by-name.util'

const SECRET = 'SEC_9f3a'
const FRAME = '    at run (/srv/app.js:1:1)'
const stackOf = (name: string): string => `${name}: ${SECRET}\n${FRAME}`

/** The line written for `{ event, ...payload }` under `extra`. */
function lineOf(
  payload: Record<string, unknown>,
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
  new PinoLoggerService(pino).warn({ event: 'E', ...payload })
  return lines[0] ?? {}
}

const shaped = (name = 'Error'): Record<string, unknown> => ({
  name,
  message: SECRET,
  stack: stackOf(name)
})

describe('the stack header of an object with a message and a stack, below the top level', () => {
  it.each([
    ['under a key of your own', { n: { message: SECRET, stack: stackOf('Error') } }],
    ['an error-shaped object under a key of your own', { error: shaped() }],
    ['in a list', { items: [{ message: SECRET, stack: stackOf('Error') }] }],
    ['two levels down', { a: { b: { message: SECRET, stack: stackOf('Error') } } }]
  ])('is censored, %s', (_label, payload) => {
    const line = lineOf(payload, { redactPaths: ['message'] })

    expect(JSON.stringify(line)).not.toContain(SECRET)
    expect(JSON.stringify(line)).toContain('[REDACTED]\\n')
  })

  it('is censored in the cause and the inner error that a toJSON returns', () => {
    const line = lineOf(
      {
        err: {
          toJSON: () => ({
            name: 'A',
            message: 'top',
            stack: `A: top\n${FRAME}`,
            cause: shaped('B'),
            inner: { message: SECRET, stack: stackOf('C') }
          })
        }
      },
      { redactPaths: ['message'] }
    )

    expect(JSON.stringify(line)).not.toContain(SECRET)
  })

  it('keeps the frames and every other field as they were written', () => {
    const line = lineOf(
      { n: { message: SECRET, stack: stackOf('Error'), code: 'E1' } },
      { redactPaths: ['message'] }
    )

    expect(line['n']).toEqual({
      message: '[REDACTED]',
      stack: `Error: [REDACTED]\n${FRAME}`,
      code: 'E1'
    })
  })

  it('leaves the stack as it was written when message is not hidden', () => {
    const stack = 'Error: ababa\n' + FRAME
    const line = lineOf({ n: { message: 'aba', stack } }, { redactPaths: ['password'] })

    expect((line['n'] as { stack: string }).stack).toBe(stack)
  })

  it('leaves a stack alone when the message is not text', () => {
    const line = lineOf(
      { n: { message: { detail: 1 }, stack: stackOf('Error') } },
      { redactPaths: ['message'] }
    )

    expect((line['n'] as { stack: string }).stack).toBe(stackOf('Error'))
  })
})

describe('the stack header of an object whose keys are spelled in another case, or look alike', () => {
  it.each([
    ['Message', 'Stack'],
    ['MESSAGE', 'stack'],
    ['message', 'STACK'],
    ['M\u0435ssage', 'St\u0430ck'],
    ['M\u200bessage', 'Stack']
  ])('is censored for %s and %s', (messageKey, stackKey) => {
    const line = lineOf(
      { meta: { cause: { [messageKey]: SECRET, [stackKey]: stackOf('Error') } } },
      { redactPaths: ['message'] }
    )
    const cause = (line['meta'] as { cause: Record<string, string> }).cause

    expect(cause[stackKey]).toMatch(/^Error: \[REDACTED\]\n/)
  })
})

describe('the redactor for what the err serializer returned', () => {
  const redact = createNameRedactor(['message'], '[REDACTED]')
  const output = { message: SECRET, stack: stackOf('Error') }

  it('leaves the stack header to the serializer that already censored it', () => {
    const result = redact(markErrorOutput({ ...output })) as { stack: string }

    expect(result.stack).toBe(output.stack)
  })

  it('hides the message in the header of an object below it', () => {
    const result = redact(markErrorOutput({ ...output, cause: output })) as {
      cause: { stack: string }
    }

    expect(result.cause.stack).not.toContain(SECRET)
  })

  it('hides it in the header of an object that did not come from the serializer', () => {
    const result = redact(output) as { stack: string }

    expect(result.stack).not.toContain(SECRET)
  })
})

describe('markErrorOutput', () => {
  it.each([['text'], [null], [7], [undefined]])('returns %p as it is', (value) => {
    expect(markErrorOutput(value)).toBe(value)
  })
})
