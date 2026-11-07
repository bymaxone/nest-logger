/**
 * Pins the length of a stack the logger writes: the window it reads, the limit it cuts at, the
 * suffix, and a cut that must not split a surrogate pair.
 *
 * Layer: server/utils, tests.
 */
import { MAX_TEXT_LENGTH, TEXT_TRUNCATED } from './bounded-text.util'
import { MAX_STACK_SCAN, scrubStack } from './sanitize-error.util'

describe('scrubStack — the length of a stack', () => {
  const frame = '    at app (/srv/src/a.ts:1:1)'

  it('is 16 KiB, with a suffix that says the stack was cut', () => {
    expect(MAX_TEXT_LENGTH).toBe(16_384)
    expect(TEXT_TRUNCATED).toBe('…[truncated]')
  })

  it('keeps a stack of exactly the limit and cuts one character more', () => {
    const exact = 'x'.repeat(MAX_TEXT_LENGTH)

    expect(scrubStack(exact)).toBe(exact)
    expect(scrubStack(exact + 'y')).toBe(exact + TEXT_TRUNCATED)
  })

  it('cuts a stack of many megabytes to the limit plus the suffix', () => {
    const huge = `Error: ${'a'.repeat(5_000_000)}\n${frame}`

    const scrubbed = scrubStack(huge)

    expect(scrubbed).toHaveLength(MAX_TEXT_LENGTH + TEXT_TRUNCATED.length)
    expect(scrubbed.endsWith(TEXT_TRUNCATED)).toBe(true)
  })

  it('drops dependency frames before it counts, so a long dependency trace alone is not a cut', () => {
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `    at dep${i} (/srv/node_modules/p/i.js:${i})`
    )
    const stack = ['Error: boom', frame, ...lines].join('\n')

    expect(scrubStack(stack)).toBe(`Error: boom\n${frame}`)
  })

  it('counts the length after control characters are escaped', () => {
    const escapes = '\u001b'.repeat(MAX_TEXT_LENGTH)

    const scrubbed = scrubStack(escapes)

    expect(scrubbed).toHaveLength(MAX_TEXT_LENGTH + TEXT_TRUNCATED.length)
  })

  describe('the part of a stack that is read', () => {
    const frame = '    at app (/srv/src/a.ts:1:1)'
    /** A dependency line of exactly `length` characters (it is dropped by the filter). */
    const dependency = (length: number): string =>
      'node_modules'.padEnd(length, 'x').slice(0, length)

    it('is eight times the limit', () => {
      expect(MAX_STACK_SCAN).toBe(8 * MAX_TEXT_LENGTH)
    })

    it('reads a stack of exactly that size whole, and marks one character more as unread', () => {
      const head = `Error: boom\n${frame}\n`
      const whole = head + dependency(MAX_STACK_SCAN - head.length)

      expect(whole).toHaveLength(MAX_STACK_SCAN)
      expect(scrubStack(whole)).toBe(`Error: boom\n${frame}`)
      expect(scrubStack(whole + 'x')).toBe(`Error: boom\n${frame}${TEXT_TRUNCATED}`)
    })

    it('keeps a frame of the application that sits beyond seven limits of dependency lines', () => {
      const dependencies = dependency(MAX_STACK_SCAN - 2_000)
      const stack = `Error: boom\n${dependencies}\n${frame}`

      expect(stack.length).toBeLessThan(MAX_STACK_SCAN)
      expect(scrubStack(stack)).toBe(`Error: boom\n${frame}`)
    })

    it('does not read past the window: a frame beyond it is gone and the cut is marked', () => {
      const stack = `Error: boom\n${dependency(MAX_STACK_SCAN + 1_000)}\n${frame}`

      expect(scrubStack(stack)).toBe(`Error: boom${TEXT_TRUNCATED}`)
    })
  })
})

describe('scrubStack — a cut that falls inside a surrogate pair', () => {
  it('does not leave half of the pair before the suffix', () => {
    const text = 'x'.repeat(MAX_TEXT_LENGTH - 1) + '\u{1F600}' + 'tail'

    const cut = scrubStack(text)

    expect(cut).toBe('x'.repeat(MAX_TEXT_LENGTH - 1) + TEXT_TRUNCATED)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false)
  })
})
