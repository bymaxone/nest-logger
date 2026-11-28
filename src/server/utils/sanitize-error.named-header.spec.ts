/**
 * Pins the stack header of an error whose `name` is not text: the engine wrote that name as its own
 * text in front of the message, so the header is rebuilt with `Error`, the part of the stack the scrub
 * reads is the only part searched and kept, and a stack cut before the scrub keeps its suffix.
 *
 * Layer: server/utils, tests. Pure.
 */
import { MAX_STACK_SCAN, sanitizeError } from './sanitize-error.util'

describe('sanitizeError — the stack header of an error whose name is not text', () => {
  const FRAME = '\n    at run (/srv/app.js:1:1)'
  const named = (stack: string, message: string): Error => {
    const error = new Error(message)
    Object.defineProperty(error, 'name', { value: { toString: () => 'pw=hunter2' } })
    Object.defineProperty(error, 'stack', { value: stack })
    return error
  }

  it.each([
    [
      'the engine header, with the message in it',
      `pw=hunter2: boom${FRAME}`,
      'boom',
      `Error: boom${FRAME}`
    ],
    [
      'a message that holds a frame-shaped line',
      `pw=hunter2: m\n    at fake${FRAME}`,
      'm\n    at fake',
      `Error: m\n    at fake${FRAME}`
    ],
    [
      'a stack that holds no message, with frames',
      `pw=hunter2${FRAME}`,
      'boom',
      `Error: boom${FRAME}`
    ],
    ['a stack that holds no message, and no frames', 'pw=hunter2', 'boom', 'Error: boom'],
    ['an empty message, with frames', `pw=hunter2: ${FRAME}`, '', `Error${FRAME}`],
    ['an empty message, and no frames', 'pw=hunter2', '', 'Error']
  ])('is written with Error as the name, %s', (_label, stack, message, expected) => {
    expect(sanitizeError(named(stack, message)).stack).toBe(expected)
  })

  it('searches the part of the stack the scrub reads, and no further', () => {
    const stack = `pw=hunter2${FRAME}${'z'.repeat(MAX_STACK_SCAN)}boom`

    const result = sanitizeError(named(stack, 'boom'))

    expect(result.stack?.startsWith(`Error: boom${FRAME}`)).toBe(true)
    expect(result.stack).not.toContain('hunter2')
  })

  it('keeps nothing of a name longer than the part of the stack the scrub reads', () => {
    const stack = `${'n'.repeat(MAX_STACK_SCAN)}pw=hunter2: boom${FRAME}`

    const result = sanitizeError(named(stack, 'boom'))

    expect(result.stack).toBe('Error: boom…[truncated]')
  })

  it('keeps nothing after the part the scrub reads when the message is in it', () => {
    const stack = `${'n'.repeat(MAX_STACK_SCAN - 10)}: boom${FRAME}TAIL_SECRET${'z'.repeat(MAX_STACK_SCAN)}`

    const result = sanitizeError(named(stack, 'boom'))

    expect(result.stack).not.toContain('TAIL_SECRET')
    expect(result.stack?.startsWith('Error: boom')).toBe(true)
  })

  it('ends with the truncation suffix when the stack was longer than the part the scrub reads', () => {
    const frames = '\n    at dep (/srv/node_modules/p/i.js:2:2)'.repeat(MAX_STACK_SCAN / 20)
    const stack = `pw=hunter2: boom${frames}`

    const result = sanitizeError(named(stack, 'boom'))
    const text = sanitizeError(Object.assign(new Error('boom'), { stack })).stack

    expect(result.stack?.endsWith('[truncated]')).toBe(true)
    expect(text?.endsWith('[truncated]')).toBe(true)
  })

  it.each([
    [0, 'Error: boom'],
    [1, 'Error: boom…[truncated]']
  ])('adds the suffix only to a stack longer than the part read (%i over)', (over, expected) => {
    const head = 'pw=hunter2: boom'
    const frame = '\n    at dep (/srv/node_modules/p/i.js:1:1)'
    const fill = MAX_STACK_SCAN + over - head.length
    const stack = `${head}${frame.repeat(Math.floor(fill / frame.length))}${'x'.repeat(fill % frame.length)}`

    expect(stack.length).toBe(MAX_STACK_SCAN + over)
    expect(sanitizeError(named(stack, 'boom')).stack).toBe(expected)
  })
  it('keeps nothing of a binary name whose bytes repeat the message', () => {
    const error = Object.assign(new Error('boom'), { name: Buffer.from('boom-AB-CDE') })

    const result = sanitizeError(error)

    expect(result.stack).toMatch(/^Error: boom\n\s+at /)
    expect(result.stack).not.toContain('AB-CDE')
  })
  it('keeps the frames where the name is binary and a frame holds the message', () => {
    const error = Object.assign(new Error('spec'), { name: Buffer.from('AB-CDE') })

    const result = sanitizeError(error)

    expect(result.stack).toMatch(/^Error: spec\n\s+at /)
    expect(result.stack).not.toContain('AB-CDE')
  })
})
