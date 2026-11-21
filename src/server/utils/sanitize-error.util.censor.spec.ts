/**
 * Pins that the stack of a sanitized error opens with the censored message, at every depth: the
 * censor runs on the stack the engine wrote, before the lines are filtered and the control
 * characters are escaped, so a message that holds one of them, or a line that names a dependency, is
 * censored too.
 *
 * Layer: server/utils, tests. Pure.
 */
import { headerCensor, MAX_STACK_SCAN, sanitizeError, scrubStack } from './sanitize-error.util'

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

  it('writes the stack as scrubStack does when no censor is given', () => {
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

describe('the reads of the message and the part of a stack that is read', () => {
  /** An error whose message is a getter that counts its reads and fails on a third one. */
  function countedError(): { error: object; reads: () => number } {
    let reads = 0
    const error = { name: 'Error', stack: 'Error: secret\n    at run (/srv/app.js:1:1)' }
    Object.defineProperty(error, 'message', {
      enumerable: false,
      get(): string {
        reads += 1
        if (reads > 2) throw new Error('third read')
        return 'secret'
      }
    })
    return { error, reads: () => reads }
  }

  it('reads the message no more often than it did without a censor', () => {
    const without = countedError()
    const withCensor = countedError()

    sanitizeError(without.error)
    const out = sanitizeError(withCensor.error, { censorMessage: censor })

    expect(out.name).toBe('Error')
    expect(out.stack).toMatch(/^Error: \[REDACTED\]\n/)
    expect(withCensor.reads()).toBe(without.reads())
    expect(withCensor.reads()).toBe(2)
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

    it('is censored, and the header is rebuilt, for a message of this length', () => {
      const out = scrubStack(stack, {
        name: 'Error',
        censoredName: 'Error',
        message,
        censored: '[REDACTED]'
      })

      expect(out).not.toContain('SECRET')
      expect(out.startsWith(opening)).toBe(true)
    })

    it('leaves the stack as scrubStack writes it when nothing censored the message', () => {
      expect(
        scrubStack(stack, { name: 'Error', censoredName: 'Error', message, censored: message })
      ).toBe(scrubStack(stack))
    })
  })

  it('rebuilds the header of a cut stack that holds other text than the message', () => {
    const stack = `Error: original\n    at run (/srv/app.js:1:1)${'x'.repeat(131_072)}`
    const message = `secret${'x'.repeat(131_072)}`

    expect(
      scrubStack(stack, { name: 'Error', censoredName: 'Error', message, censored: '[REDACTED]' })
    ).toBe('Error: [REDACTED]…[truncated]')
  })

  it('leaves a cut stack alone when the message is empty', () => {
    const stack = `Error: \n    at run (/srv/app.js:1:1)${'x'.repeat(131_072)}`

    expect(
      scrubStack(stack, {
        name: 'Error',
        censoredName: 'Error',
        message: '',
        censored: '[REDACTED]'
      })
    ).toBe(scrubStack(stack))
  })

  it('rebuilds the header when the message is longer than a stack that does not hold it', () => {
    const stack = 'Error: short\n    at run (/srv/app.js:1:1)'

    expect(
      scrubStack(stack, {
        name: 'Error',
        censoredName: 'Error',
        message: 'x'.repeat(200_000),
        censored: '[R]'
      })
    ).toBe('Error: [R]')
  })

  it.each([
    ['a name that is not in the stack', { name: 'Other', censoredName: '[N]' }],
    ['an empty name', { name: '', censoredName: '[N]' }]
  ])('leaves the stack alone for %s', (_label, names) => {
    const out = scrubStack('Error: m\n  at foo (/a.ts:1:1)', {
      ...names,
      message: 'zzz',
      censored: 'zzz'
    })

    expect(out).toBe('Error: m\n  at foo (/a.ts:1:1)')
  })

  it('replaces a name that opens the stack by its censored form', () => {
    const out = scrubStack('N user=U: m\n  at foo (/a.ts:1:1)', {
      name: 'N user=U',
      censoredName: '[N]',
      message: 'm',
      censored: 'm'
    })

    expect(out).toBe('[N]: m\n  at foo (/a.ts:1:1)')
  })

  it('censors a header written with frames of two spaces', () => {
    const out = scrubStack('Error: SEC\n  at foo (/a.ts:1:1)', {
      name: 'Error',
      censoredName: 'Error',
      message: 'SEC',
      censored: '[R]'
    })

    expect(out).toBe('Error: [R]\n  at foo (/a.ts:1:1)')
  })
})

describe('headerCensor', () => {
  it('pairs a text message with its censored form', () => {
    expect(headerCensor('Error', 'secret', censor)).toEqual({
      name: 'Error',
      censoredName: 'Error',
      message: 'secret',
      censored: '[REDACTED]'
    })
  })

  it('removes the message from the header when the censor cannot answer', () => {
    const failing = (): string => {
      throw new Error('cannot censor')
    }

    expect(headerCensor('Error', 'secret', failing)).toEqual({
      name: 'Error',
      censoredName: 'Error',
      message: 'secret',
      censored: ''
    })
    expect(sanitizeError(new Error('secret'), { censorMessage: failing }).stack).toMatch(
      /^Error: \n/
    )
  })

  it.each([
    ['a message that is not text', 42, censor],
    ['no censor', 'secret', undefined]
  ])('gives nothing for %s', (_label, message, censorMessage) => {
    expect(headerCensor('Error', message, censorMessage)).toBeUndefined()
  })

  it('takes an empty name for a name that is not text', () => {
    expect(headerCensor(undefined, 'secret', censor)).toEqual({
      name: '',
      censoredName: '',
      message: 'secret',
      censored: '[REDACTED]'
    })
  })
})

describe('scrubStack, a message that the censor leaves as it is', () => {
  it('leaves the stack as it was written, a message that overlaps itself included', () => {
    const header = headerCensor('Error', 'aa', (text) => text)

    expect(scrubStack('Error: aa\n    at f (x.js:1:1)\nCaused by: aaa', header)).toBe(
      'Error: aa\n    at f (x.js:1:1)\nCaused by: aaa'
    )
  })
})

describe('scrubStack, a hidden message against the part of the stack that is read', () => {
  const DEP = (text: string): string => `\n    at dep (/node_modules/${text})`
  const censor = (): string => '[R]'

  it('does not keep a frame whose offset is past the bound when long messages are hidden before it', () => {
    const message = 'm'.repeat(5_000)
    const lead = `Error: x${DEP(message).repeat(25)}`
    const pad = '\n    at pad'
    const stack = `${lead}${pad.repeat(Math.ceil((MAX_STACK_SCAN + 1_000 - lead.length) / pad.length))}\n    at ZZZ_APP (/srv/z.js:1:1)`
    expect(stack.indexOf('ZZZ_APP')).toBeGreaterThan(MAX_STACK_SCAN)

    expect(scrubStack(stack, headerCensor('Error', message, censor))).not.toContain('ZZZ_APP')
  })

  it('leaves no part of a message that starts before the end of the window and ends after it', () => {
    const message = `LEAKMARK${'q'.repeat(992)}`
    const before = `Error: a${DEP(message)}`
    const padding = `\n    at dep (/node_modules/${'p'.repeat(MAX_STACK_SCAN + 500 - before.length - 30)}`
    const stack = `${before}${padding})\n    at app (/srv/${message}`
    expect(stack.indexOf('LEAKMARK', 100)).toBeGreaterThan(MAX_STACK_SCAN)

    expect(scrubStack(stack, headerCensor('Error', message, censor))).not.toContain('LEAKMARK')
  })

  it('hides a message that opens the stack and is longer than the part read', () => {
    const message = `LEAKMARK${'x'.repeat(140_000)}`

    expect(scrubStack(`Error: ${message}`, headerCensor('Error', message, censor))).not.toContain(
      'LEAKMARK'
    )
  })

  it('hides a message that starts before the bound and ends after it, in a line that is kept', () => {
    const message = `LEAKMARK${'q'.repeat(100)}`
    const stack = `Error: a\n    at app (/srv/${'z'.repeat(10_000)}${message}\n    at b (/srv/b.js:1:1)`

    expect(scrubStack(stack, headerCensor('Error', message, censor))).not.toContain('LEAKMARK')
  })

  it('does not keep a frame whose offset is past the bound after a header that opens the stack', () => {
    const message = 'm'.repeat(5_000)
    const lead = `Error: ${message}${DEP(message).repeat(24)}`
    const pad = '\n    at pad'
    const stack = `${lead}${pad.repeat(Math.ceil((MAX_STACK_SCAN + 1_000 - lead.length) / pad.length))}\n    at ZZZ_APP (/srv/z.js:1:1)`
    expect(stack.indexOf('ZZZ_APP')).toBeGreaterThan(MAX_STACK_SCAN)

    expect(scrubStack(stack, headerCensor('Error', message, censor))).not.toContain('ZZZ_APP')
  })

  it('keeps no more than the bound of a stack whose censored header is longer than the bound', () => {
    const censored = 'node_modules'.repeat(20_000)
    const stack = 'Error: SEC\n    at app (/srv/a.js:1:1)'

    expect(
      scrubStack(
        stack,
        headerCensor('Error', 'SEC', () => censored)
      )
    ).toBe('')
  })
})
