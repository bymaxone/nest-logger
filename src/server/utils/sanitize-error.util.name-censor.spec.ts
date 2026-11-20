/**
 * Pins that the name of an error is censored when it is text and not a name: a name that reads as an
 * identifier of at most 64 characters is kept, every other passes the censor of the message, and the
 * stack, the semconv fields and the line about a failed destination carry the same name.
 *
 * Layer: server/utils, tests. Pure.
 */
import { censorName, sanitizeError } from './sanitize-error.util'

const hide = (): string => '[REDACTED]'

describe('censorName', () => {
  it.each([
    ['TypeError'],
    ['pg.DatabaseError'],
    ['E_TIMEOUT'],
    ['$Weird_Name-1'],
    ['A'.repeat(64)],
    ['']
  ])('keeps %j, which reads as a name', (name) => {
    expect(censorName(name, hide)).toBe(name)
  })

  it.each([
    ['N_user=U token=S'],
    ['A'.repeat(65)],
    ['sk_live_' + 'a'.repeat(60)],
    ['1StartsWithDigit'],
    ['two words'],
    ['new\nline']
  ])('censors %j, which is text', (name) => {
    expect(censorName(name, hide)).toBe('[REDACTED]')
  })

  it('keeps every name when nothing censors', () => {
    expect(censorName('N_user=U token=S', undefined)).toBe('N_user=U token=S')
  })

  it('writes an empty name, never the text, when the censor cannot answer', () => {
    expect(
      censorName('N_user=U token=S', () => {
        throw new Error('broken')
      })
    ).toBe('')
  })
})

describe('sanitizeError with a name that is text', () => {
  const named = (name: string, message = 'm'): Error => {
    const error = new Error(message)
    error.name = name
    return error
  }

  it('writes the censored name, in the node, in its stack header and in its causes', () => {
    const error = named('N_user=U token=S')
    Object.defineProperty(error, 'cause', { value: named('C_user=U token=S') })

    const out = sanitizeError(error, { censorMessage: hide })

    expect(out.name).toBe('[REDACTED]')
    expect(out.stack).toMatch(/^\[REDACTED\]: \[REDACTED\]\n/)
    expect(out.stack).not.toContain('token=S')
    expect(JSON.stringify(out)).not.toContain('token=S')
  })

  it('keeps the name of a class, so the type stays what an alert groups by', () => {
    expect(sanitizeError(new TypeError('m'), { censorMessage: hide }).name).toBe('TypeError')
  })

  it('does not censor the name when nothing censors', () => {
    expect(sanitizeError(named('N_user=U token=S')).name).toBe('N_user=U token=S')
  })
})
