/**
 * The comparison of two keys that are spellings of one name.
 *
 * Layer: server/utils — pure, no I/O. A backend that normalises field names reads `trace_id`,
 * `trace.id` and `TraceId` as one field, so a key a caller writes that only spells a key the logger
 * writes is dropped like the key itself. One rule decides it, here, for the keys the entry owns and
 * for the keys the request context and the active span write. The rule also reads through the ways a
 * key can look like another without being it: the compatibility forms Unicode defines, characters
 * that print as nothing, white space, and a short list of letters of other scripts that are drawn
 * like a Latin one.
 */

/** The separators that are not part of a name: `_`, `.` and `-`; white space; and format characters. */
const IGNORED = /[\s._\p{Cf}-]/gu

/** What lower-casing `İ` leaves behind, a combining dot above that is not part of a name. */
const DOT_ABOVE = /\u0307/g

/** A key made only of the printable ASCII characters that no rule here changes except case and `._-`. */
const PLAIN = /^[\x21-\x7e]*$/

/** The Cyrillic and Greek letters drawn like a Latin one, by the Latin letter they are taken for. */
const LOOKALIKES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    a: '\u0430\u03b1',
    c: '\u0441\u03f2',
    d: '\u0501',
    e: '\u0435',
    i: '\u0456\u03b9',
    j: '\u0458',
    o: '\u043e\u03bf',
    p: '\u0440\u03c1',
    q: '\u051b',
    s: '\u0455',
    v: '\u03bd',
    w: '\u051d',
    x: '\u0445',
    y: '\u0443'
  }).flatMap(([latin, letters]) => [...letters].map((letter): [string, string] => [letter, latin]))
)

/**
 * A key with its case, its separators, its white space and its invisible characters removed, and the
 * letters drawn like a Latin one replaced by it, so the spellings of one name compare equal:
 * `trace_id`, `trace.id`, `Trace-Id`, `TRACEID`, `trace id` and `trace\u200bid` all fold to `traceid`.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param key - A field name.
 * @returns The folded name.
 */
export function foldKey(key: string): string {
  // Stryker disable next-line ConditionalExpression: for a key of printable ASCII the full path returns the same text; this branch only skips its work (about 90 ns a key, measured).
  if (PLAIN.test(key)) return key.replace(IGNORED, '').toLowerCase()
  let folded = key.normalize('NFKC').replace(IGNORED, '').toLowerCase().replace(DOT_ABOVE, '')
  for (const [letter, latin] of LOOKALIKES) folded = folded.replaceAll(letter, latin)
  return folded
}
