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

  it('rebuilds the header of a stack that opens with another text than the message', () => {
    const error = {
      name: 'Error',
      message: 'secret changed later',
      stack: 'Error: built with this\n    at run (/srv/app.js:1:1)'
    }

    expect(sanitizeError(error, { censorMessage: censor }).stack).toBe('Error: [REDACTED]')
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

  /*
   * The stack is read up to MAX_STACK_SCAN characters. The header is 'Error: ' and the message, so
   * it fits while the message is at most MAX_STACK_SCAN - 7 characters, ends the part read exactly
   * at that length, and runs past it for every longer message, which leaves the start of it in the
   * part read and never the whole of it. The header is rebuilt in every case, and keeps its name.
   */
  describe.each([
    ['a message that fits in the part read', 100_000, 'Error: [REDACTED]\n'],
    ['a message that ends the part read exactly', 131_065, 'Error: [REDACTED]'],
    ['a message one character past it', 131_066, 'Error: [REDACTED]'],
    ['a message that overruns it by a little', 131_071, 'Error: [REDACTED]'],
    ['a message as long as the part read', 131_072, 'Error: [REDACTED]'],
    ['a message longer than the part read', 131_073, 'Error: [REDACTED]'],
    ['a message far longer than the part read', 200_000, 'Error: [REDACTED]']
  ])('%s', (_label, length, opening) => {
    const message = `SECRET${'x'.repeat(length - 6)}`
    const stack = `Error: ${message}\n    at run (/srv/app.js:1:1)`

    it('is censored, whatever part of the header the stack reads', () => {
      const out = scrubStack(stack, { message, censored: '[REDACTED]' })

      expect(out).not.toContain('SECRET')
      expect(out.startsWith(opening)).toBe(true)
    })

    it('is left as it is when nothing censored it, at the same cost', () => {
      expect(scrubStack(stack, { message, censored: message })).toBe(scrubStack(stack))
    })
  })

  it('rebuilds the header of a cut stack that holds other text than the message', () => {
    const stack = `Error: original\n    at run (/srv/app.js:1:1)${'x'.repeat(131_072)}`
    const message = `secret${'x'.repeat(131_072)}`

    expect(scrubStack(stack, { message, censored: '[REDACTED]' })).toBe(
      'Error: [REDACTED]…[truncated]'
    )
  })

  it('leaves a cut stack alone when the message is empty, whatever it is censored to', () => {
    const stack = `Error: \n    at run (/srv/app.js:1:1)${'x'.repeat(131_072)}`

    expect(scrubStack(stack, { message: '', censored: '[REDACTED]' })).toBe(scrubStack(stack))
  })

  it('rebuilds the header when the message is longer than a stack that does not hold it', () => {
    const stack = 'Error: short\n    at run (/srv/app.js:1:1)'

    expect(scrubStack(stack, { message: 'x'.repeat(200_000), censored: '[R]' })).toBe('Error: [R]')
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
