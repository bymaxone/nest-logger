/**
 * Verifies createEntryTextFinisher: the text is censored by the redactor under the name of its
 * member, cut at the limit when there is one (a text of exactly the limit is kept), and becomes
 * empty when the redactor throws or turns it into something that is not text.
 *
 * Layer: server/utils, tests.
 */
import { TEXT_TRUNCATED } from './bounded-text.util'
import { createEntryTextFinisher, createTextCensor } from './entry-text-finisher.util'
import type { EntryTextCut } from './entry-text-finisher.util'
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

/** A cut of the text of an entry that is written. */
const CUT: EntryTextCut = { emitted: true }

describe('createEntryTextFinisher', () => {
  it('gives the text of a member the redactor censors as the redactor wrote it', () => {
    expect(createEntryTextFinisher(censoring, undefined)('event', 'secret', CUT)).toBe('[REDACTED]')
  })

  it('leaves the text of a member the redactor does not censor', () => {
    expect(createEntryTextFinisher(censoring, undefined)('message', 'plain', CUT)).toBe('plain')
  })

  it.each([
    ['one under the limit', LIMIT - 1, false],
    ['exactly the limit', LIMIT, false],
    ['one over the limit', LIMIT + 1, true]
  ])('cuts at the limit: %s', (_label, length, isCut) => {
    const text = 'x'.repeat(length)

    const out = createEntryTextFinisher(identity, LIMIT)('message', text, CUT)

    expect(out).toBe(isCut ? 'x'.repeat(LIMIT) + TEXT_TRUNCATED : text)
  })

  it('does not cut when there is no limit', () => {
    expect(
      createEntryTextFinisher(identity, undefined)('message', 'x'.repeat(100_000), CUT)
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
    expect(
      createEntryTextFinisher(redactor as unknown as Redactor, LIMIT)('message', 'text', CUT)
    ).toBe('')
  })

  describe('the count of the texts it cuts', () => {
    const cuts = (
      text: string,
      limit: number | undefined,
      cut: EntryTextCut | null = CUT
    ): number => {
      let count = 0
      createEntryTextFinisher(identity, limit, () => {
        count += 1
      })('message', text, cut ?? undefined)
      return count
    }

    it('calls back once for a text cut at the limit', () => {
      expect(cuts('x'.repeat(LIMIT + 1), LIMIT)).toBe(1)
    })

    it.each([
      ['a text at the limit', 'x'.repeat(LIMIT), LIMIT, CUT],
      ['a text with no limit', 'x'.repeat(100_000), undefined, CUT],
      ['an entry that is not written', 'x'.repeat(LIMIT + 1), LIMIT, { emitted: false }]
    ])('does not call back for %s', (_label, text, limit, cut) => {
      expect(cuts(text, limit, cut)).toBe(0)
    })

    it('does not call back, and does not cut, a text it is told not to cut', () => {
      const text = 'x'.repeat(LIMIT + 50)

      expect(cuts(text, LIMIT, null)).toBe(0)
      expect(createEntryTextFinisher(identity, LIMIT)('message', text)).toBe(text)
    })

    it('still cuts the text of an entry that is not written', () => {
      const out = createEntryTextFinisher(identity, LIMIT)('message', 'x'.repeat(LIMIT + 1), {
        emitted: false
      })

      expect(out).toBe(`${'x'.repeat(LIMIT)}${TEXT_TRUNCATED}`)
    })
  })
})

describe('createTextCensor', () => {
  const censoring: Redactor = (value) => ({ ...(value as object), event: '[REDACTED]' })

  it('censors the text under the name of its member, and does not cut it', () => {
    const censor = createTextCensor(censoring)

    expect(censor('event', 'secret')).toBe('[REDACTED]')
    expect(censor('message', 'x'.repeat(100_000))).toBe('x'.repeat(100_000))
  })

  /**
   * Given a redactor that records whether it was told the value is the root of a record
   * When a text is censored under the name of its field
   * Then the redactor was told so, because the wrapper object it is given is that root
   */
  it('hands the text to the redactor as the root of a record', () => {
    const told: Array<boolean | undefined> = []
    const censor = createTextCensor((value, isRecordRoot) => {
      told.push(isRecordRoot)
      return value
    })

    censor('message', 'text')

    expect(told).toStrictEqual([true])
  })

  it.each([
    [
      'a redactor that throws',
      () => {
        throw new Error('boom')
      }
    ],
    ['a redactor that turns the text into a value that is not text', () => ({ message: 42 })]
  ])('gives the empty string for %s', (_label, redactor) => {
    expect(createTextCensor(redactor as unknown as Redactor)('message', 'text')).toBe('')
  })
})
