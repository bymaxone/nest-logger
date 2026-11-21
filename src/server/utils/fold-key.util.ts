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

/**
 * The separators that are not part of a name: `_`, `.` and `-`; white space; control and format
 * characters; and the combining marks, which include the dot that lower-casing `İ` leaves behind.
 */
const IGNORED = /[\s._\p{Cc}\p{Cf}\p{M}-]/gu

/** A key made only of the printable ASCII characters that no rule here changes except case and `._-`. */
const PLAIN = /^[\x21-\x7e]*$/

/** The Cyrillic and Greek letters drawn like a Latin one, by the Latin letter they are taken for. */
const LOOKALIKES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    a: '\u0430\u03b1\u1d00',
    b: '\u0299',
    c: '\u0441\u03f2\u1d04',
    d: '\u0501\u1d05',
    e: '\u0435\u03b5\u03f5\u1d07',
    f: '\ua730',
    g: '\u0262',
    h: '\u029c',
    i: '\u0456\u03b9\u0131\u026a',
    j: '\u0458\u1d0a',
    k: '\u1d0b',
    l: '\u029f',
    m: '\u1d0d',
    n: '\u0274',
    o: '\u043e\u03bf\u1d0f',
    p: '\u0440\u03c1\u1d18',
    q: '\u051b',
    r: '\u0280',
    s: '\u0455\ua731',
    t: '\u1d1b',
    u: '\u1d1c',
    v: '\u03bd\u1d20',
    w: '\u051d\u1d21',
    x: '\u0445',
    y: '\u0443\u028f',
    z: '\u1d22'
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
  let folded = key.normalize('NFKD').toLowerCase().replace(IGNORED, '')
  for (const [letter, latin] of LOOKALIKES) folded = folded.replaceAll(letter, latin)
  return folded
}
