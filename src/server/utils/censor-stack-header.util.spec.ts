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
    ['a message the stack does not hold', `Error: built with this${FRAMES}`, 'changed later', 'x'],
    ['a message that does not end the header', `Error: secret and more${FRAMES}`, 'secret', 'x']
  ])('leaves the stack alone for %s', (_label, stack, message, censored) => {
    expect(censorStackHeader(stack, message, censored)).toBe(stack)
  })
})
