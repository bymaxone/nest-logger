/**
 * Verifies cutStrings: strings at any depth are cut at the limit and end with the marker, a string
 * of exactly the limit is kept, a surrogate pair is never split, keys and values that are not text
 * are kept, a root key marked whole is not entered, and only data the redaction walk builds is
 * entered: an Error, a Date or any other instance is returned as it is. The input is not changed.
 *
 * Layer: server/utils, tests.
 */
import { TEXT_TRUNCATED } from './bounded-text.util'
import { cutStrings } from './cut-strings.util'

const LIMIT = 64
const NONE: ReadonlySet<string> = new Set()
const cutOf = (length: number): string => 'x'.repeat(length)

describe('cutStrings', () => {
  describe('the limit', () => {
    /*
     * The boundary is the limit itself: a string of N characters is whole, one of N + 1 is cut to N
     * and followed by the marker, so the written length is N plus the marker at most.
     */
    it.each([
      ['one under the limit', LIMIT - 1, false],
      ['exactly the limit', LIMIT, false],
      ['one over the limit', LIMIT + 1, true],
      ['far over the limit', LIMIT * 100, true]
    ])('handles a string that is %s', (_label, length, isCut) => {
      const out = cutStrings({ note: cutOf(length) }, LIMIT, NONE)

      expect(out['note']).toBe(isCut ? cutOf(LIMIT) + TEXT_TRUNCATED : cutOf(length))
    })

    it('never splits a surrogate pair at the boundary', () => {
      const text = 'x'.repeat(LIMIT - 1) + '😀' + 'tail'

      const out = cutStrings({ note: text }, LIMIT, NONE)

      expect(out['note']).toBe('x'.repeat(LIMIT - 1) + TEXT_TRUNCATED)
    })
  })

  describe('what it enters', () => {
    it('cuts a string inside an object and an array at any depth', () => {
      const long = cutOf(LIMIT + 10)

      const out = cutStrings({ a: { b: [{ c: long }, long] } }, LIMIT, NONE)

      expect(out).toEqual({
        a: { b: [{ c: cutOf(LIMIT) + TEXT_TRUNCATED }, cutOf(LIMIT) + TEXT_TRUNCATED] }
      })
    })

    it('keeps a value that is not text and a key as they are', () => {
      const longKey = cutOf(LIMIT + 10)

      const out = cutStrings(
        { [longKey]: 1, flag: true, nothing: null, missing: undefined },
        LIMIT,
        NONE
      )

      expect(out).toEqual({ [longKey]: 1, flag: true, nothing: null, missing: undefined })
    })

    /*
     * The pass reads what the walk wrote. An instance the walk keeps (an Error, a Date) is not
     * data it built, so it is returned as the same object, whatever its fields hold.
     */
    it.each([
      [
        'an Error',
        (): unknown => Object.assign(new Error(cutOf(LIMIT + 10)), { detail: cutOf(LIMIT + 10) })
      ],
      ['a Date', (): unknown => new Date(0)]
    ])('returns %s as the same object', (_label, make) => {
      const instance = make()

      const out = cutStrings({ held: instance }, LIMIT, NONE)

      expect(out['held']).toBe(instance)
    })

    it('enters an object that has no prototype', () => {
      const bare = Object.assign(Object.create(null) as Record<string, unknown>, {
        note: cutOf(LIMIT + 10)
      })

      const out = cutStrings({ bare }, LIMIT, NONE)

      expect(out['bare']).toEqual({ note: cutOf(LIMIT) + TEXT_TRUNCATED })
    })

    /*
     * A key named `__proto__` that arrives as own data must stay data in the copy: assigning it
     * would change the prototype of the result.
     */
    it('keeps an own __proto__ key as a key of the copy', () => {
      const record = JSON.parse(`{"__proto__":{"note":"${cutOf(LIMIT + 10)}"}}`) as Record<
        string,
        unknown
      >

      const out = cutStrings(record, LIMIT, NONE)

      expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
      expect(Object.keys(out)).toEqual(['__proto__'])
    })
  })

  describe('the root keys left whole', () => {
    it('does not enter a root key in the exempt set and cuts the rest', () => {
      const long = cutOf(LIMIT + 10)

      const out = cutStrings(
        { logKey: long, err: { stack: long }, note: long },
        LIMIT,
        new Set(['logKey', 'err'])
      )

      expect(out).toEqual({
        logKey: long,
        err: { stack: long },
        note: cutOf(LIMIT) + TEXT_TRUNCATED
      })
    })
  })

  describe('the input', () => {
    it('returns a new record and leaves the one it was given unchanged', () => {
      const long = cutOf(LIMIT + 10)
      const record = { note: long, nested: { note: long } }

      const out = cutStrings(record, LIMIT, NONE)

      expect(out).not.toBe(record)
      expect(record).toEqual({ note: long, nested: { note: long } })
    })
  })

  describe('the count of the strings it cuts', () => {
    const counted = (
      record: Record<string, unknown>,
      exempt: ReadonlySet<string> = NONE
    ): number => {
      let count = 0
      cutStrings(record, LIMIT, exempt, () => {
        count += 1
      })
      return count
    }

    it('calls back once for each string that was cut, at any depth', () => {
      const long = cutOf(LIMIT + 1)

      expect(counted({ a: long, b: { c: [long, 'short'] }, d: cutOf(LIMIT) })).toBe(2)
    })

    it('does not call back for a string left whole or under an exempt root key', () => {
      expect(counted({ kept: cutOf(LIMIT + 50), note: 'short' }, new Set(['kept']))).toBe(0)
    })
  })
})
