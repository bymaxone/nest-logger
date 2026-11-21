/**
 * Pins the replacement of a message wherever a stack holds it.
 *
 * Layer: server/utils, tests. Pure.
 */
import { hideMessageInStack, hideMessagesInStack } from './hide-message-in-stack.util'

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
    ['occurrences that overlap', 'Error: aaa\n  at x', 'aa', '[R]', 'Error: [R]\n  at x'],
    ['a message that overlaps itself', 'Error: ababa\n  at f', 'aba', '[R]', 'Error: [R]\n  at f'],
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
    [
      'a frame that holds the message',
      'Error: head\n  at SEC (f)',
      'SEC',
      'Error: head\n  at [R] (f)'
    ],
    ['a message in a frame only', 'Error: x\n  at SEC (f)', 'SEC', 'Error: x\n  at [R] (f)'],
    ['the header and a later line', 'Error: SEC\n  at SEC (f)', 'SEC', 'Error: [R]\n  at [R] (f)'],
    [
      'a cause that repeats the message',
      'Error: SEC\n  at f (g:1)\nCaused by: Error: SEC\n  at h (i:2)',
      'SEC',
      'Error: [R]\n  at f (g:1)\nCaused by: Error: [R]\n  at h (i:2)'
    ]
  ])('replaces the message in %s', (_label, stack, message, expected) => {
    expect(hideMessageInStack(stack, message, '[R]')).toBe(expected)
  })

  it.each([
    ['an empty message', 'Error: x\n  at y', ''],
    ['a stack that does not hold the message', 'Error: other', 'SEC']
  ])('leaves the stack alone for %s', (_label, stack, message) => {
    expect(hideMessageInStack(stack, message, '[R]')).toBe(stack)
  })

  it('is linear in a message made of a frame-shaped line that repeats many times', () => {
    const message = '\n  at SEC'
    const stack = `Error:${message.repeat(100_000)}\n  at f (g:1)`
    const started = Date.now()

    const hidden = hideMessageInStack(stack, message, '[R]')

    expect(hidden).toBe(`Error:${'[R]'.repeat(100_000)}\n  at f (g:1)`)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('is linear in a message that overlaps itself, a long run of one character', () => {
    const message = 'a'.repeat(250_000)
    const stack = `Error: ${'a'.repeat(500_000)}\n  at f (g:1)`
    const started = Date.now()

    const hidden = hideMessageInStack(stack, message, '[R]')

    expect(hidden).toBe('Error: [R]\n  at f (g:1)')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it.each([
    ['abab', 'xababab\n  at f', 'x[R]\n  at f'],
    ['aabaa', 'aabaabaa\n  at f', '[R]\n  at f'],
    ['abaaba', 'abaabaaba\n  at f', '[R]\n  at f'],
    ['aab', 'aaab aab\n  at f', 'a[R] [R]\n  at f'],
    ['aabaaab', 'aabaabaaab\n  at f', 'aab[R]\n  at f'],
    ['abcabd', 'abcabcabd\n  at f', 'abc[R]\n  at f'],
    ['aaaa', 'aaaaaa\n  at f', '[R]\n  at f'],
    ['aabaaa', 'aabaaabaaa\n  at f', '[R]\n  at f'],
    ['aabaaaa', 'aabaaabaaaa\n  at f', 'aaba[R]\n  at f']
  ])('finds the occurrences of %s with the table of its prefixes', (message, stack, expected) => {
    expect(hideMessageInStack(stack, message, '[R]')).toBe(expected)
  })

  it('leaves the stack alone for a message longer than the stack, without building a table for it', () => {
    expect(hideMessageInStack('Error: x', 'x'.repeat(50_000_000), '[R]')).toBe('Error: x')
  })

  /*
   * The search is held against the plain one, indexOf from each next character, on every message and
   * every stack over two letters up to a length: a wrong failure table gives a wrong occurrence for one
   * of them, and no hand-written case has to guess which.
   */
  it('agrees with a plain search on every message and stack over two letters', () => {
    const words = (length: number): string[] =>
      Array.from({ length: 2 ** length }, (_, n) =>
        n.toString(2).padStart(length, '0').replaceAll('0', 'a').replaceAll('1', 'b')
      )
    const plain = (stack: string, message: string): string => {
      const spans: Array<[number, number]> = []
      for (let at = stack.indexOf(message); at !== -1; at = stack.indexOf(message, at + 1)) {
        const last = spans[spans.length - 1]
        if (last !== undefined && at < last[1]) last[1] = at + message.length
        else spans.push([at, at + message.length])
      }
      let result = ''
      let from = 0
      for (const [start, end] of spans) {
        result += stack.slice(from, start) + '#'
        from = end
      }
      return result + stack.slice(from)
    }
    const stacks = [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(words)
    const messages = [1, 2, 3, 4, 5, 6, 7].flatMap(words)
    const wrong = messages.flatMap((message) =>
      stacks.filter((stack) => hideMessageInStack(stack, message, '#') !== plain(stack, message))
    )

    expect(wrong).toEqual([])
  })
})

describe('hideMessagesInStack', () => {
  it.each([
    ['text before the limit', 'abcSECdef', ['SEC'], 6, 'abc[R]'],
    ['no message, a limit inside the stack', 'abcdefgh', ['SEC'], 5, 'abcde'],
    ['no message, a limit past the stack', 'abcd', ['SEC'], 50, 'abcd'],
    [
      'an occurrence that starts before the limit and ends after it',
      'abSECcdef',
      ['SEC'],
      3,
      'ab[R]'
    ],
    ['an occurrence that starts at the limit', 'abcSECdef', ['SEC'], 3, 'abc'],
    ['an occurrence that starts after the limit', 'abcdSECef', ['SEC'], 3, 'abc'],
    ['two messages', 'aXXbYYc', ['XX', 'YY'], 7, 'a[R]b[R]c'],
    ['two messages that overlap', 'aXYZb', ['XY', 'YZ'], 5, 'a[R]b'],
    ['a message inside another', 'aXYZb', ['XYZ', 'Y'], 5, 'a[R]b'],
    [
      'a second message that starts inside the first and at the limit',
      'aXYZb',
      ['XY', 'YZ'],
      2,
      'a[R]'
    ],
    ['an empty message', 'abc', ['', 'b'], 3, 'a[R]c'],
    ['a message longer than the stack', 'abc', ['abcd'], 3, 'abc'],
    ['no message', 'abc', [], 2, 'ab']
  ])('keeps %s', (_label, stack, messages, limit, expected) => {
    expect(hideMessagesInStack(stack, messages, '[R]', limit)).toBe(expected)
  })

  it('stands for the limit however much the replacement shrinks the text', () => {
    const stack = `${'ABC'.repeat(30)}tail`

    expect(hideMessagesInStack(stack, ['ABC'], '#', 10)).toBe('####')
  })
})
