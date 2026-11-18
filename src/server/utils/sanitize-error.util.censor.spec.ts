/**
 * Pins that the stack of a sanitized error opens with the censored message, at every depth: the
 * censor runs on the stack the engine wrote, before the lines are filtered and the control
 * characters are escaped, so a message that holds one of them, or a line that names a dependency, is
 * censored too.
 *
 * Layer: server/utils, tests. Pure.
 */
import { headerCensor, sanitizeError, scrubStack } from './sanitize-error.util'

const censor = (text: string): string => (text.includes('secret') ? '[REDACTED]' : text)

const stackOf = (error: unknown): string => String((error as { stack?: unknown }).stack)

describe('sanitizeError with a censor of messages', () => {
  it('opens the stack with the censored message, and leaves the message to the redaction', () => {
    const out = sanitizeError(new Error('secret'), { censorMessage: censor })

    expect(out.stack).toMatch(/^Error: \[REDACTED\]\n/)
    expect(out.message).toBe('secret')
  })

  it('censors the stack of each cause and of each aggregated error', () => {
    const error = new AggregateError([new Error('secret one'), new Error('kept')], 'secret all', {
      cause: new Error('secret cause')
    })

    const out = sanitizeError(error, { censorMessage: censor })

    expect(out.stack).toMatch(/^AggregateError: \[REDACTED\]\n/)
    expect(out.cause).toMatchObject({ stack: expect.stringMatching(/^Error: \[REDACTED\]\n/) })
    const [first, second] = out.errors as Array<{ stack?: string }>
    expect(first?.stack).toMatch(/^Error: \[REDACTED\]\n/)
    expect(second?.stack).toMatch(/^Error: kept\n/)
  })

  it.each([
    ['a carriage return', 'tok\rsecret'],
    ['an escape', 'tok\u001bsecret'],
    ['a line separator', 'tok secret'],
    ['a line that names a dependency', 'a\nsecret in node_modules/x']
  ])('censors a message that holds %s', (_label, message) => {
    const out = sanitizeError(new Error(message), { censorMessage: censor })

    expect(out.stack).toMatch(/^Error: \[REDACTED\]\n/)
    expect(out.stack).not.toContain('secret')
  })

  it('writes the stack as it did when no censor is given', () => {
    const error = new Error('secret')

    expect(sanitizeError(error).stack).toBe(scrubStack(stackOf(error)))
    expect(sanitizeError(error, { censorMessage: undefined }).stack).toMatch(/^Error: secret\n/)
  })

  it('leaves a stack that opens with another text than the message the error carries', () => {
    const error = {
      name: 'Error',
      message: 'secret changed later',
      stack: 'Error: built with this\n    at run (/srv/app.js:1:1)'
    }

    expect(sanitizeError(error, { censorMessage: censor }).stack).toMatch(/^Error: built with this/)
  })
})

describe('the reads of the message and the size of what is searched', () => {
  it('reads the message no more often than it did without a censor', () => {
    let reads = 0
    const hostile = { name: 'Error', stack: 'Error: secret\n    at run (/srv/app.js:1:1)' }
    Object.defineProperty(hostile, 'message', {
      enumerable: false,
      get(): string {
        reads += 1
        if (reads > 2) throw new Error('third read')
        return 'secret'
      }
    })

    const out = sanitizeError(hostile, { censorMessage: censor })

    expect(out.name).toBe('Error')
    expect(out.stack).toMatch(/^Error: \[REDACTED\]\n/)
    expect(reads).toBe(2)
  })

  it('censors a message longer than the scan that bounds the stack', () => {
    const message = 'S'.repeat(200_000) + ' secret'
    const stack = `Error: ${message}\n    at run (/srv/app.js:1:1)`

    const out = scrubStack(stack, { message, censored: '[REDACTED]' })

    expect(out).toMatch(/^Error: \[REDACTED\]\n/)
    expect(out).not.toContain('SSSS')
  })

  it('censors a header written with frames of two spaces', () => {
    const out = scrubStack('Error: SEC\n  at foo (/a.ts:1:1)', { message: 'SEC', censored: '[R]' })

    expect(out).toBe('Error: [R]\n  at foo (/a.ts:1:1)')
  })
})

describe('headerCensor', () => {
  it('pairs a text message with its censored form', () => {
    expect(headerCensor('secret', censor)).toEqual({ message: 'secret', censored: '[REDACTED]' })
  })

  it('removes the message from the header when the censor cannot answer', () => {
    const failing = (): string => {
      throw new Error('cannot censor')
    }

    expect(headerCensor('secret', failing)).toEqual({ message: 'secret', censored: '' })
    expect(sanitizeError(new Error('secret'), { censorMessage: failing }).stack).toMatch(
      /^Error: \n/
    )
  })

  it.each([
    ['a message that is not text', 42, censor],
    ['no censor', 'secret', undefined]
  ])('gives nothing for %s', (_label, message, censorMessage) => {
    expect(headerCensor(message, censorMessage)).toBeUndefined()
  })
})
