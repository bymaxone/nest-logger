/**
 * Pins the replacement of a message in the first line of a stack, and only there.
 *
 * Layer: server/utils, tests. Pure.
 */
import { hideMessageInStack } from './hide-message-in-stack.util'

describe('hideMessageInStack', () => {
  it('replaces every occurrence in the header, in the middle of it', () => {
    expect(hideMessageInStack('Err: a SEC b SEC\n  at x', 'SEC', '[R]')).toBe(
      'Err: a [R] b [R]\n  at x'
    )
  })

  it('replaces a message of several lines, which the header holds up to the first frame', () => {
    expect(hideMessageInStack('Error: a\nSEC\nb\n    at x (f:1)', 'a\nSEC\nb', '[R]')).toBe(
      'Error: [R]\n    at x (f:1)'
    )
  })

  it('replaces the message in a header of lines that none is a frame', () => {
    expect(hideMessageInStack('Error: SEC\nmore SEC', 'SEC', '[R]')).toBe('Error: [R]\nmore [R]')
  })

  it('replaces the message in a stack of one line, which has no frame', () => {
    expect(hideMessageInStack('Error: SEC', 'SEC', '[R]')).toBe('Error: [R]')
  })

  it('replaces a message that holds a line shaped like a frame', () => {
    expect(
      hideMessageInStack('Error: x\n    at SECRET\n    at f (g:1)', 'x\n    at SECRET', '[R]')
    ).toBe('Error: [R]\n    at f (g:1)')
  })

  it('leaves a frame that holds the message alone', () => {
    expect(hideMessageInStack('Error: head\n  at SEC (f)', 'SEC', '[R]')).toBe(
      'Error: head\n  at SEC (f)'
    )
  })

  it('leaves the stack alone for an empty message', () => {
    expect(hideMessageInStack('Error: x\n  at y', '', '[R]')).toBe('Error: x\n  at y')
  })

  it('leaves the stack alone when the first line does not hold the message', () => {
    expect(hideMessageInStack('Error: other', 'SEC', '[R]')).toBe('Error: other')
  })
})
