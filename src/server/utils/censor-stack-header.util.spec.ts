/**
 * Pins how the message of an error is censored where it opens the stack: replaced once, by an exact
 * match, only ahead of the frames, and only where the serialized node shows that the message was
 * censored; the causes and the aggregated errors follow their own nodes.
 *
 * Layer: server/utils, tests. Pure.
 */
import { censorErrorStacks, censorStackHeader } from './censor-stack-header.util'

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
    ['the first of two occurrences', 'Error: x x', 'x', 'Error: [REDACTED] x']
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
})

describe('censorErrorStacks', () => {
  const node = (message: string, extra: object = {}): Record<string, unknown> => ({
    type: 'Error',
    message,
    stack: `Error: ${message}${FRAMES}`,
    ...extra
  })
  const censored = (message: string, extra: object = {}): Record<string, unknown> => ({
    type: 'Error',
    message: '[REDACTED]',
    stack: `Error: ${message}${FRAMES}`,
    ...extra
  })

  it('censors the header of a node whose message was censored', () => {
    expect(censorErrorStacks(node('secret'), censored('secret'))).toEqual({
      type: 'Error',
      message: '[REDACTED]',
      stack: `Error: [REDACTED]${FRAMES}`
    })
  })

  it('follows the cause and the aggregated errors, each by its own message', () => {
    const raw = node('a', { cause: node('b'), errors: [node('c'), node('d')] })
    const redacted = censored('a', {
      cause: censored('b'),
      errors: [censored('c'), { ...node('d') }]
    })

    const out = censorErrorStacks(raw, redacted) as Record<string, unknown>

    expect(out['stack']).toBe(`Error: [REDACTED]${FRAMES}`)
    expect((out['cause'] as Record<string, unknown>)['stack']).toBe(`Error: [REDACTED]${FRAMES}`)
    const errors = out['errors'] as Array<Record<string, unknown>>
    expect(errors[0]?.['stack']).toBe(`Error: [REDACTED]${FRAMES}`)
    expect(errors[1]?.['stack']).toBe(`Error: d${FRAMES}`)
  })

  it.each([
    ['a node whose message was not censored', node('kept'), node('kept')],
    ['a node with no stack', node('s'), { type: 'Error', message: '[REDACTED]' }],
    ['a node with no message', { type: 'Error' }, { type: 'Error' }]
  ])('leaves %s as the walk wrote it', (_label, raw, redacted) => {
    expect(censorErrorStacks(raw, redacted)).toEqual(redacted)
  })

  it.each([
    [
      'a cause the walk replaced by a text',
      node('a', { cause: node('b') }),
      { ...censored('a'), cause: '[REDACTED]' }
    ],
    [
      'a list of errors that is not a list',
      node('a', { errors: [] }),
      { ...censored('a'), errors: 'x' }
    ]
  ])('keeps %s, and censors the stack of the node itself', (_label, raw, redacted) => {
    const out = censorErrorStacks(raw, redacted) as Record<string, unknown>

    expect(out['cause']).toBe((redacted as Record<string, unknown>)['cause'])
    expect(out['errors']).toBe((redacted as Record<string, unknown>)['errors'])
    expect(out['stack']).toBe(`Error: [REDACTED]${FRAMES}`)
  })

  it.each([
    ['a text', 'x', 'y'],
    ['an array', [], []],
    ['a null', null, null],
    ['a raw node that is not a record', 'x', { message: 'y' }]
  ])('returns the redacted value for %s', (_label, raw, redacted) => {
    expect(censorErrorStacks(raw, redacted)).toBe(redacted)
  })
})
