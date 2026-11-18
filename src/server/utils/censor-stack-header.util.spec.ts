/**
 * Pins how the message of an error is censored in the header of its stack: it is replaced where the
 * engine writes it, right after the first `: ` of the first line or at the start for an error with no
 * name, even when it holds lines that look like frames; a header that is not in that form is
 * replaced by the name and the censored message and loses its frames; a message that was not
 * censored changes nothing.
 *
 * Layer: server/utils, tests. Pure.
 */
import { censorStackHeader } from './censor-stack-header.util'

const FRAMES = '\n    at run (/srv/app.js:1:1)\n    at main (/srv/main.js:2:2)'

const WRAPPED = [
  'request failed: Error: inner',
  '    at db.query (/srv/db.js:10:5)',
  '    at run (/srv/app.js:2:2)',
  'token=SECRET123'
].join('\n')

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
    [
      'a message that wraps another error, with its frames and a secret after them',
      `Error: ${WRAPPED}${FRAMES}`,
      WRAPPED,
      `Error: [REDACTED]${FRAMES}`
    ],
    ['a stack with no frame', 'Error: secret', 'secret', 'Error: [REDACTED]'],
    ['a message with a regular expression in it', 'Error: a.*(b', 'a.*(b', 'Error: [REDACTED]'],
    ['an error with no name', `secret${FRAMES}`, 'secret', `[REDACTED]${FRAMES}`],
    [
      'an error with no name whose message holds the separator',
      `foo: bar${FRAMES}`,
      'foo: bar',
      `[REDACTED]${FRAMES}`
    ],
    ['a name equal to the message', `LEAK: LEAK${FRAMES}`, 'LEAK', `LEAK: [REDACTED]${FRAMES}`],
    [
      'a message that is a part of the name',
      `TypeError: Error${FRAMES}`,
      'Error',
      `TypeError: [REDACTED]${FRAMES}`
    ],
    [
      'a name that holds a separator of its own',
      `App (code 7): secret${FRAMES}`,
      'secret',
      `App (code 7): [REDACTED]${FRAMES}`
    ],
    [
      'a line after the message',
      `Error: SEC\nextra detail${FRAMES}`,
      'SEC',
      `Error: [REDACTED]\nextra detail${FRAMES}`
    ],
    [
      'frames of two spaces',
      'Error: SEC\n  at foo (/a.ts:1:1)',
      'SEC',
      'Error: [REDACTED]\n  at foo (/a.ts:1:1)'
    ],
    [
      'frames indented with a tab',
      'Error: SEC\n\tat foo (/a.ts:1:1)',
      'SEC',
      'Error: [REDACTED]\n\tat foo (/a.ts:1:1)'
    ],
    [
      'a message that starts exactly where the first frame line starts',
      `Error: \n    at b${FRAMES}`,
      '\n    at b',
      `Error: [REDACTED]${FRAMES}`
    ]
  ])('replaces the message in %s', (_label, stack, message, expected) => {
    expect(censorStackHeader(stack, message, '[REDACTED]')).toBe(expected)
  })

  /*
   * A header that is not the default form is not read: it becomes the name and the censored message,
   * and the frames go, because no search for the secret in it can be shown to find all of it.
   */
  it.each([
    [
      'text between the colon and the message',
      `Error: build 12 failed - secret${FRAMES}`,
      'secret',
      'Error: [REDACTED]'
    ],
    [
      'the same wrapped message under a header with text before it',
      `Error: attempt 3 ${WRAPPED}${FRAMES}`,
      WRAPPED,
      'Error: [REDACTED]'
    ],
    [
      'a message that is the start of a longer one',
      `Error: secret and more${FRAMES}`,
      'secret',
      'Error: [REDACTED]'
    ],
    [
      'a message that was changed after the stack was written',
      `Error: old secret${FRAMES}`,
      'secret',
      'Error: [REDACTED]'
    ],
    [
      'a stack that does not hold the message',
      `Error: built with this${FRAMES}`,
      'changed',
      'Error: [REDACTED]'
    ],
    ['a message that a line after it repeats', `Error: x y\nx${FRAMES}`, 'x', 'Error: [REDACTED]'],
    ['a first line with no name', `Error${FRAMES}`, 'secret', '[REDACTED]'],
    [
      'a header that holds the message many times',
      `Error: ${'a'.repeat(65)}${FRAMES}`,
      'a',
      'Error: [REDACTED]'
    ]
  ])(
    'drops the frames of a stack whose header is not the default form: %s',
    (_l, stack, message, expected) => {
      expect(censorStackHeader(stack, message, '[REDACTED]')).toBe(expected)
    }
  )

  it.each([
    ['a message that is empty', `Error${FRAMES}`, '', '[REDACTED]'],
    ['a message that was not censored', `Error: kept${FRAMES}`, 'kept', 'kept'],
    [
      'a message that was not censored, whatever the header',
      `Error: ${'a'.repeat(65)}${FRAMES}`,
      'a',
      'a'
    ]
  ])('leaves the stack alone for %s', (_label, stack, message, censored) => {
    expect(censorStackHeader(stack, message, censored)).toBe(stack)
  })

  it('does the same work for a message of 100,000 characters that is not the header', () => {
    const message = 'a'.repeat(100_000)
    const stack = 'a'.repeat(231_072)
    const started = Date.now()

    const out = censorStackHeader(stack, message, '[REDACTED]')

    expect(out).toBe('[REDACTED]')
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
