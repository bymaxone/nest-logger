/**
 * Verifies createEntryTextFinisher: the text is censored by the redactor under the name of its
 * member, cut at the limit when there is one (a text of exactly the limit is kept), and becomes
 * empty when the redactor throws or turns it into something that is not text.
 *
 * Layer: server/utils, tests.
 */
import { TEXT_TRUNCATED } from './bounded-text.util'
import { createEntryTextFinisher } from './entry-text-finisher.util'
import type { Redactor } from './redact-by-name.util'

const LIMIT = 64
const censoring: Redactor = (value) =>
  Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      k === 'event' ? '[REDACTED]' : v
    ])
  )
const identity: Redactor = (value) => value

describe('createEntryTextFinisher', () => {
  it('gives the text of a member the redactor censors as the redactor wrote it', () => {
    expect(createEntryTextFinisher(censoring, undefined)('event', 'secret')).toBe('[REDACTED]')
  })

  it('leaves the text of a member the redactor does not censor', () => {
    expect(createEntryTextFinisher(censoring, undefined)('message', 'plain')).toBe('plain')
  })

  it.each([
    ['one under the limit', LIMIT - 1, false],
    ['exactly the limit', LIMIT, false],
    ['one over the limit', LIMIT + 1, true]
  ])('cuts at the limit: %s', (_label, length, isCut) => {
    const text = 'x'.repeat(length)

    const out = createEntryTextFinisher(identity, LIMIT)('message', text)

    expect(out).toBe(isCut ? 'x'.repeat(LIMIT) + TEXT_TRUNCATED : text)
  })

  it('does not cut when there is no limit', () => {
    expect(
      createEntryTextFinisher(identity, undefined)('message', 'x'.repeat(100_000))
    ).toHaveLength(100_000)
  })

  it.each([
    [
      'throws',
      (): never => {
        throw new Error('redactor exploded')
      }
    ],
    ['returns text that is not a string', (): unknown => ({ message: 1 })],
    ['returns a value that is not an object', (): unknown => null]
  ])('gives the empty string when the redactor %s', (_label, redactor) => {
    expect(createEntryTextFinisher(redactor as unknown as Redactor, LIMIT)('message', 'text')).toBe(
      ''
    )
  })
})
