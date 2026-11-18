/**
 * Pins the length of the text the logger writes: the limit, the suffix, and a cut that must not
 * split a surrogate pair.
 *
 * Layer: server/utils, tests.
 */
import { cutBytes, cutIfText, cutText, MAX_TEXT_LENGTH, TEXT_TRUNCATED } from './bounded-text.util'

describe('cutText — the length of a text written as given', () => {
  it('cuts at the limit and leaves every frame and character before it as given', () => {
    const exact = `Error: x\n${'    at node_modules/a (b)\n'.repeat(10)}`.padEnd(
      MAX_TEXT_LENGTH,
      'y'
    )

    expect(cutText(exact)).toBe(exact)
    expect(cutText(exact + 'z')).toBe(exact + TEXT_TRUNCATED)
  })

  it('cuts a stack of many megabytes', () => {
    const huge = 'a'.repeat(5_000_000)

    expect(cutText(huge)).toBe('a'.repeat(MAX_TEXT_LENGTH) + TEXT_TRUNCATED)
  })
})

describe('a cut that falls inside a surrogate pair', () => {
  const pair = '\u{1F600}'

  it('does not leave half of the pair before the suffix', () => {
    // The pair starts at the last allowed character, so the limit lands between its halves.
    const text = 'x'.repeat(MAX_TEXT_LENGTH - 1) + pair + 'tail'

    for (const cut of [cutText(text)]) {
      expect(cut).toBe('x'.repeat(MAX_TEXT_LENGTH - 1) + TEXT_TRUNCATED)
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false)
    }
  })

  it.each([
    ['the first high surrogate', '\uD800'],
    ['the last high surrogate', '\uDBFF']
  ])('drops %s when the cut falls right after it', (_label, half) => {
    const text = 'x'.repeat(MAX_TEXT_LENGTH - 1) + half + 'tail'

    expect(cutText(text)).toBe('x'.repeat(MAX_TEXT_LENGTH - 1) + TEXT_TRUNCATED)
  })

  it('keeps a low surrogate or any other character that ends the kept text', () => {
    for (const last of ['\uDC00', '\uDFFF', '\uD7FF', 'z']) {
      const text = 'x'.repeat(MAX_TEXT_LENGTH - 1) + last + 'tail'

      expect(cutText(text)).toBe('x'.repeat(MAX_TEXT_LENGTH - 1) + last + TEXT_TRUNCATED)
    }
  })

  it('keeps a whole pair that ends exactly at the limit', () => {
    const text = 'x'.repeat(MAX_TEXT_LENGTH - 2) + pair + 'tail'

    expect(cutText(text)).toBe('x'.repeat(MAX_TEXT_LENGTH - 2) + pair + TEXT_TRUNCATED)
  })
})

describe('cutIfText', () => {
  it('cuts a string like cutText and returns anything else as the very same value', () => {
    const object = { text: 'x' }

    expect(cutIfText('x'.repeat(MAX_TEXT_LENGTH + 1))).toBe(
      'x'.repeat(MAX_TEXT_LENGTH) + TEXT_TRUNCATED
    )
    expect(cutIfText('short')).toBe('short')
    expect(cutIfText(object)).toBe(object)
    expect(cutIfText(42)).toBe(42)
    expect(cutIfText(undefined)).toBeUndefined()
    expect(cutIfText(null)).toBeNull()
  })
})

describe('cutBytes — a text cut to a byte ceiling', () => {
  const MARKER_BYTES = Buffer.byteLength(TEXT_TRUNCATED, 'utf-8')

  it.each([
    ['one byte under', 1023, false],
    ['exactly the ceiling', 1024, false],
    ['one byte over', 1025, true]
  ])('handles an ASCII text that is %s', (_label, bytes, isCut) => {
    const text = 'x'.repeat(bytes)

    const out = cutBytes(text, 1024)

    expect(out).toBe(isCut ? 'x'.repeat(1024 - MARKER_BYTES) + TEXT_TRUNCATED : text)
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(1024)
  })

  it.each([
    ['two-byte characters', 'é'],
    ['three-byte characters', '€'],
    ['four-byte characters', '😀']
  ])('never exceeds the ceiling and never splits a character: %s', (_label, character) => {
    const out = cutBytes(character.repeat(5000), 1024)

    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThanOrEqual(1024)
    expect(out.endsWith(TEXT_TRUNCATED)).toBe(true)
    expect(out.slice(0, -TEXT_TRUNCATED.length)).toBe(
      character.repeat((out.length - TEXT_TRUNCATED.length) / character.length)
    )
  })

  it('does not cut when the ceiling is infinite', () => {
    expect(cutBytes('x'.repeat(100_000), Number.POSITIVE_INFINITY)).toHaveLength(100_000)
  })

  it('writes only the marker when the ceiling is exactly the marker', () => {
    expect(cutBytes('x'.repeat(100), MARKER_BYTES)).toBe(TEXT_TRUNCATED)
  })

  it('cuts without the marker when the ceiling cannot hold it, so the ceiling still holds', () => {
    expect(cutBytes('x'.repeat(100), 5)).toBe('xxxxx')
    expect(cutBytes('€'.repeat(100), 5)).toBe('€')
    expect(cutBytes('x'.repeat(100), 0)).toBe('')
  })
})
