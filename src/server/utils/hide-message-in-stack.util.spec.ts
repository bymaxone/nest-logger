/**
 * Pins the replacement of a message in the first line of a stack, and only there.
 *
 * Layer: server/utils, tests. Pure.
 */
import { hideMessageInStack } from './hide-message-in-stack.util'

describe('hideMessageInStack', () => {
  /*
   * The cases of the mechanism: where the message sits in the stack and what shape it has. Each rule
   * of the function is held by at least one of them.
   */
  it.each([
    ['a message in a one-line stack', 'Error: SEC', 'SEC', '[R]', 'Error: [R]'],
    ['a message in the first line', 'Err: a SEC b\n  at x', 'SEC', '[R]', 'Err: a [R] b\n  at x'],
    [
      'a message that repeats in the first line',
      'Err: SEC SEC\n  at x',
      'SEC',
      '[R]',
      'Err: [R] [R]\n  at x'
    ],
    [
      'a message of several lines',
      'Error: a\nSEC\nb\n    at x (f:1)',
      'a\nSEC\nb',
      '[R]',
      'Error: [R]\n    at x (f:1)'
    ],
    [
      'a message that holds a line shaped like a frame',
      'Error: x\n    at SECRET\n    at f (g:1)',
      'x\n    at SECRET',
      '[R]',
      'Error: [R]\n    at f (g:1)'
    ],
    [
      'a message that holds a frame-shaped line, repeated in the header',
      'Error: x\n  at S\nx\n  at S\n  at f',
      'x\n  at S',
      '[R]',
      'Error: [R]\n[R]\n  at f'
    ],
    [
      'a header of lines, none a frame',
      'Error: SEC\nmore SEC',
      'SEC',
      '[R]',
      'Error: [R]\nmore [R]'
    ],
    ['a header with CRLF', 'Error: SEC\r\n    at x', 'SEC', '[R]', 'Error: [R]\r\n    at x'],
    ['a tab before the frame', 'Error: SEC\n\tat x', 'SEC', '[R]', 'Error: [R]\n\tat x'],
    ['a message that is the whole header', 'SEC\n  at x', 'SEC', '[R]', '[R]\n  at x'],
    [
      'a message that fills the end of a stack with no frame',
      'Error: a\nSEC',
      'a\nSEC',
      '[R]',
      'Error: [R]'
    ],
    [
      'a replacement that holds the message',
      'Error: SEC\n  at x',
      'SEC',
      'SEC!',
      'Error: SEC!\n  at x'
    ],
    ['occurrences that overlap', 'Error: aaa\n  at x', 'aa', '[R]', 'Error: [R]a\n  at x'],
    [
      'a message that begins with a frame-shaped line',
      'Error:\n  at SEC\n  at f',
      '\n  at SEC',
      '[R]',
      'Error:[R]\n  at f'
    ],
    [
      'a message prefix of a longer word',
      'Error: SECRET\n  at x',
      'SEC',
      '[R]',
      'Error: [R]RET\n  at x'
    ]
  ])('replaces %s', (_label, stack, message, replacement, expected) => {
    expect(hideMessageInStack(stack, message, replacement)).toBe(expected)
  })

  it.each([
    ['a frame that holds the message', 'Error: head\n  at SEC (f)', 'SEC'],
    ['a message in a frame only', 'Error: x\n  at SEC (f)', 'SEC'],
    ['an empty message', 'Error: x\n  at y', ''],
    ['a header that does not hold the message', 'Error: other', 'SEC'],
    [
      'a message that is in a frame only, below a first line that is not it',
      'a\n  at SEC\n  at SEC',
      'SEC'
    ]
  ])('leaves the stack alone for %s', (_label, stack, message) => {
    expect(hideMessageInStack(stack, message, '[R]')).toBe(stack)
  })

  it('replaces the message in the header and leaves the same text in a frame', () => {
    expect(hideMessageInStack('Error: SEC\n  at SEC (f)', 'SEC', '[R]')).toBe(
      'Error: [R]\n  at SEC (f)'
    )
  })
})
