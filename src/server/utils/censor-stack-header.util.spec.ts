/**
 * Pins how the message of an error is censored where it opens the stack: replaced once, by an exact
 * match, and only where it ends the header, which is where the first frame begins or where a stack
 * with no frame ends, so a name that repeats the message or contains it is never the match.
 *
 * Layer: server/utils, tests. Pure.
 */
import { censorStackHeader } from './censor-stack-header.util'

const FRAMES = '\n    at run (/srv/app.js:1:1)\n    at main (/srv/main.js:2:2)'

describe('censorStackHeader', () => {
  it.each([
    [
      'a message on the first line',
      `Error: secret${FRAMES}`,
      'secret',
      `Error: [REDACTED]${FRAMES}`
    ],
    [
      'a message of several lines',
      `Error: line one\nline two${FRAMES}`,
      'line one\nline two',
      `Error: [REDACTED]${FRAMES}`
    ],
    [
      'a message that holds the text of a frame line',
      `Error: a\n    at b${FRAMES}`,
      'a\n    at b',
      `Error: [REDACTED]${FRAMES}`
    ],
    ['a stack with no frame', 'Error: secret', 'secret', 'Error: [REDACTED]'],
    ['a message with a regular expression in it', 'Error: a.*(b', 'a.*(b', 'Error: [REDACTED]'],
    ['an error with no name', `secret${FRAMES}`, 'secret', `[REDACTED]${FRAMES}`],
    ['a name equal to the message', `LEAK: LEAK${FRAMES}`, 'LEAK', `LEAK: [REDACTED]${FRAMES}`],
    [
      'a message that is a part of the name',
      `TypeError: Error${FRAMES}`,
      'Error',
      `TypeError: [REDACTED]${FRAMES}`
    ],
    [
      'the message twice, the second one ending the header',
      'Error: x x',
      'x',
      'Error: x [REDACTED]'
    ],
    [
      'a header the engine did not write, with frames of two spaces',
      'Error: SEC\n  at foo (/a.ts:1:1)',
      'SEC',
      'Error: [REDACTED]\n  at foo (/a.ts:1:1)'
    ],
    [
      'a header with a line after the message',
      `Error: SEC\nextra detail${FRAMES}`,
      'SEC',
      `Error: [REDACTED]\nextra detail${FRAMES}`
    ],
    [
      'a name equal to the message and a line after it',
      `LEAK: LEAK\nextra${FRAMES}`,
      'LEAK',
      `LEAK: [REDACTED]\nextra${FRAMES}`
    ],
    [
      'a message that is the start of a longer header text',
      `Error: secret and more${FRAMES}`,
      'secret',
      `Error: [REDACTED] and more${FRAMES}`
    ],
    [
      'a header whose frames are indented with a tab',
      'Error: SEC\n\tat foo (/a.ts:1:1)',
      'SEC',
      'Error: [REDACTED]\n\tat foo (/a.ts:1:1)'
    ],
    [
      'a message that is a part of an older header text, as the stack kept it',
      `Error: old secret${FRAMES}`,
      'secret',
      `Error: old [REDACTED]${FRAMES}`
    ],
    [
      'a header that holds the message as often as is examined',
      `Error: ${'a'.repeat(64)}`,
      'a',
      `Error: ${'a'.repeat(63)}[REDACTED]`
    ],
    [
      'a header that holds more occurrences than are examined, and frames after it',
      `Error: ${'a'.repeat(65)}${FRAMES}`,
      'a',
      `[REDACTED]${FRAMES}`
    ],
    [
      'a stack with no frame that holds more occurrences than are examined',
      `Error: ${'a'.repeat(65)}`,
      'a',
      '[REDACTED]'
    ],
    [
      'a message that a later frame repeats at the end of the stack',
      'Error: x\n    at a\n    at x',
      'x',
      'Error: [REDACTED]\n    at a\n    at x'
    ]
  ])('censors %s', (_label, stack, message, expected) => {
    expect(censorStackHeader(stack, message, '[REDACTED]')).toBe(expected)
  })

  it.each([
    ['a message that is empty', `Error${FRAMES}`, '', '[REDACTED]'],
    ['a message that was not censored', `Error: kept${FRAMES}`, 'kept', 'kept'],
    ['a message that only a frame repeats', `Error: other${FRAMES}x`, 'at run', '[REDACTED]'],
    ['a message the stack does not hold', `Error: built with this${FRAMES}`, 'changed later', 'x']
  ])('leaves the stack alone for %s', (_label, stack, message, censored) => {
    expect(censorStackHeader(stack, message, censored)).toBe(stack)
  })

  it('censors a message that overlaps itself in time that does not depend on its length', () => {
    const message = 'a'.repeat(100_000)
    const stack = 'a'.repeat(131_072 + 100_000)
    const started = Date.now()

    const out = censorStackHeader(stack, message, '[REDACTED]')

    expect(out).toBe('[REDACTED]')
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
