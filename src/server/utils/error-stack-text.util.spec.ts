/**
 * Unit: the stack of an error whose name or message holds a binary value.
 */
import { readStackText } from './error-stack-text.util'

const bytes = (): Buffer => Buffer.from('AB-CDE')

/** An error whose stack is formatted after `parts` are assigned: the engine formats on first read. */
const holding = (parts: Record<string, unknown>): Error => Object.assign(new Error('boom'), parts)

describe('readStackText', () => {
  it.each([
    ['name', { name: bytes() }],
    ['message', { message: bytes() }],
    ['listed name', { name: [bytes()] }]
  ])('replaces the first line when the %s holds a binary value', (_label, parts) => {
    const written = readStackText(holding(parts)) as string

    expect(written.split('\n')[0]).toBe('[Binary 6 bytes]')
    expect(written).toMatch(/\n\s+at /)
    expect(written).not.toContain('AB-CDE')
  })

  it('keeps no part of a stack that does not start with the line the engine writes', () => {
    const error = holding({ message: bytes() })
    error.stack = 'other AB-CDE\n    at somewhere'

    expect(readStackText(error)).toBe('[Binary 6 bytes]')
  })

  it('returns a stack unchanged when name and message are text', () => {
    const error = new Error('boom')

    expect(readStackText(error)).toBe(error.stack)
  })

  it('returns what the stack holds when it is not a string', () => {
    const error = Object.assign(holding({ message: bytes() }), { stack: 42 as unknown as string })

    expect(readStackText(error)).toBe(42)
  })

  it('leaves the stack as it is when the message cannot be read', () => {
    const error = new Error('boom')
    error.stack = 'Error: boom'
    Object.defineProperty(error, 'message', {
      get: () => {
        throw new Error('unreadable')
      }
    })

    expect(readStackText(error)).toBe('Error: boom')
  })
})
