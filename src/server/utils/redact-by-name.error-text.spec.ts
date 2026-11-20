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
  it('is left to the serializer under the key err, for message and stack both', () => {
    const out = redactor(true)({ err: shaped() }) as { err: Record<string, unknown> }

    expect(out.err['message']).toBe('SECRET')
    expect(out.err['stack']).toBe(shaped()['stack'])
  })

  it('is hidden under any other key', () => {
    const out = redactor(true)({ error: shaped() }) as { error: Record<string, unknown> }

    expect(out.error['message']).toBe(CENSOR)
    expect(out.error['stack']).toBe(CENSOR)
  })

  it.each([
    ['not told so', false],
    ['not told at all', undefined]
  ])('is hidden under err when the redactor is %s', (_label, leave) => {
    const out = redactor(leave)({ err: shaped() }) as { err: Record<string, unknown> }

    expect(out.err['message']).toBe(CENSOR)
    expect(out.err['stack']).toBe(CENSOR)
  })
})
