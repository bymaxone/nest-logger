/**
 * Pins which values the name walk leaves to the serializer of `err`: only a plain error-shaped
 * object under the key `err` of the record root, and only when the redactor was told so; the names
 * `message` and `stack` are lifted for that subtree and for no other.
 *
 * Layer: server/utils, tests. Pure.
 */
import { createNameRedactor } from './redact-by-name.util'

const CENSOR = '[REDACTED]'
const shaped = (): Record<string, unknown> => ({
  name: 'Err',
  message: 'SECRET',
  stack: 'Err: SECRET\n    at run (/srv/app.js:1:1)'
})
const redactor = (leave?: boolean): ((record: unknown) => unknown) => {
  const redact = createNameRedactor(
    ['message', 'stack'],
    CENSOR,
    ['err'],
    undefined,
    undefined,
    undefined,
    undefined,
    leave
  )
  return (record) => redact(record, true)
}

describe('the text of an error-shaped object under the names walk', () => {
  it('leaves the message to the serializer under the key err, and hides the stack', () => {
    const out = redactor(true)({ err: shaped() }) as { err: Record<string, unknown> }

    expect(out.err['message']).toBe('SECRET')
    expect(out.err['stack']).toBe(CENSOR)
  })

  it('is hidden under any other key', () => {
    const out = redactor(true)({ error: shaped() }) as { error: Record<string, unknown> }

    expect(out.error['message']).toBe(CENSOR)
    expect(out.error['stack']).toBe(CENSOR)
  })

  it('is hidden in what a list under err holds', () => {
    const out = redactor(true)({ err: [shaped()] }) as { err: Array<Record<string, unknown>> }

    expect(out.err[0]?.['message']).toBe(CENSOR)
  })

  it('is left to the serializer for any object under err, an error-shaped one or not', () => {
    const out = redactor(true)({ err: { message: 'SECRET', code: 7 } }) as {
      err: Record<string, unknown>
    }

    expect(out.err).toEqual({ message: 'SECRET', code: 7 })
  })

  it.each([
    ['not told so', false],
    ['not told at all', undefined]
  ])('is hidden under err when the redactor is %s', (_label, leave) => {
    const out = redactor(leave)({ err: shaped() }) as { err: Record<string, unknown> }

    expect(out.err['message']).toBe(CENSOR)
    expect(out.err['stack']).toBe(CENSOR)
  })

  it('keeps the names for what the object holds: a nested message is still hidden, and so is what a toJSON of it reads', () => {
    const nested = {
      message: 'SECRET',
      toJSON(this: { message: string }): Record<string, string> {
        return { leak: this.message }
      }
    }
    const out = redactor(true)({ err: { ...shaped(), nested } }) as {
      err: { nested: unknown }
    }

    expect(JSON.stringify(out.err.nested)).not.toContain('SECRET')
  })

  it('keeps the names for a nested message that is a plain field', () => {
    const out = redactor(true)({ err: { ...shaped(), nested: { message: 'SECRET' } } }) as {
      err: { nested: { message: string } }
    }

    expect(out.err.nested.message).toBe(CENSOR)
  })
})
