import { escapeControlCharacters, toSingleLineMessage } from './escape-log-text.util'

/*
 * SECURITY. These helpers are the boundary between log text and a terminal.
 * Characters are built with String.fromCharCode rather than written as escapes
 * so the test source itself stays free of control bytes.
 */
const ch = (code: number): string => String.fromCharCode(code)

const NUL = ch(0x00)
const BACKSPACE = ch(0x08)
const TAB = ch(0x09)
const VTAB = ch(0x0b)
const FORM_FEED = ch(0x0c)
const ESC = ch(0x1b)
const DEL = ch(0x7f)
const C1_NEL = ch(0x85)
const C1_TOP = ch(0x9f)
const NBSP = ch(0xa0)
const LINE_SEPARATOR = ch(0x2028)
const PARAGRAPH_SEPARATOR = ch(0x2029)

describe('escape-log-text util', () => {
  describe('toSingleLineMessage()', () => {
    it(/*
     * Every character a terminal treats as "next line" must collapse to the
     * readable two-character sequence, including the C1 and Unicode ones that
     * the JavaScript line-terminator set alone would miss.
     */
    'turns every line terminator into the literal escape', () => {
      const forged = [
        'a\rb',
        'a\nb',
        `a${C1_NEL}b`,
        `a${LINE_SEPARATOR}b`,
        `a${PARAGRAPH_SEPARATOR}b`
      ]

      expect(forged.map(toSingleLineMessage)).toEqual(['a\\nb', 'a\\nb', 'a\\nb', 'a\\nb', 'a\\nb'])
    })

    it(/*
     * SECURITY — ESC is what makes ANSI sequences work: `ESC E` is NEL (next
     * line) and `ESC [` opens a control sequence. Escaping the byte disarms
     * every sequence built on it, which pinning newlines alone does not.
     */
    'disarms ANSI escape sequences', () => {
      expect(toSingleLineMessage(`fail${ESC}E[12:00:00.000] INFO: FORGED`)).toBe(
        'fail\\u001bE[12:00:00.000] INFO: FORGED'
      )
    })

    it(/*
     * The remaining control characters that move or overwrite the cursor.
     * NUL also pins the zero-padding of the hex escape.
     */
    'escapes the other cursor-moving control characters', () => {
      expect(toSingleLineMessage(`${NUL}${BACKSPACE}${VTAB}${FORM_FEED}${DEL}${C1_TOP}`)).toBe(
        '\\u0000\\u0008\\u000b\\u000c\\u007f\\u009f'
      )
    })

    it(/*
     * TAB moves horizontally, so it cannot forge a line, and callers align text
     * with it — it must survive. The characters immediately outside each
     * escaped range must survive too, or the ranges are wrong.
     */
    'leaves safe characters untouched', () => {
      expect(toSingleLineMessage(`a${TAB}b ~${NBSP}z`)).toBe(`a${TAB}b ~${NBSP}z`)
    })

    it(/*
     * The replacement is global: one sanitized break is not enough when the
     * caller supplies several.
     */
    'replaces every occurrence, not just the first', () => {
      expect(toSingleLineMessage('a\nb\nc')).toBe('a\\nb\\nc')
    })

    it(/*
     * Ordinary text must be handed over byte-for-byte — the guard against a
     * normalization that quietly rewrites messages.
     */
    'returns single-line text unchanged', () => {
      expect(toSingleLineMessage('Payment failed for order 123')).toBe(
        'Payment failed for order 123'
      )
    })
  })

  describe('escapeControlCharacters()', () => {
    it(/*
     * A stack trace is legitimately multi-line, and `pino-pretty` prints it raw.
     * Newlines stay; everything that can drive the terminal is escaped.
     */
    'keeps newlines and escapes control characters', () => {
      expect(escapeControlCharacters(`Error: boom${ESC}[2J\n    at app (/srv/a.ts:1:1)`)).toBe(
        'Error: boom\\u001b[2J\n    at app (/srv/a.ts:1:1)'
      )
    })

    it(/*
     * CR alone returns the cursor to column zero and overwrites the line just
     * drawn — it forges as effectively as LF and must not be treated as a
     * legitimate line break here.
     */
    'escapes a carriage return', () => {
      expect(escapeControlCharacters('a\rb')).toBe('a\\u000db')
    })

    it(/*
     * Every escaped range of the multiline set, asserted separately. Stryker
     * ignores static initializers, so a range deleted from this regex would
     * otherwise leave the suite green — verified by removing them by hand.
     */
    'escapes each range of the multiline set', () => {
      expect(escapeControlCharacters(`${NUL}${BACKSPACE}`)).toBe('\\u0000\\u0008')
      expect(escapeControlCharacters(`${VTAB}${ESC}`)).toBe('\\u000b\\u001b')
      expect(escapeControlCharacters(`${DEL}${C1_NEL}${C1_TOP}`)).toBe('\\u007f\\u0085\\u009f')
      expect(escapeControlCharacters(`${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`)).toBe(
        '\\u2028\\u2029'
      )
    })

    it(/*
     * Indentation in a stack must survive.
     */
    'keeps tabs and ordinary text', () => {
      expect(escapeControlCharacters(`at app${TAB}(/srv/a.ts:1:1)`)).toBe(
        `at app${TAB}(/srv/a.ts:1:1)`
      )
    })
  })
})
