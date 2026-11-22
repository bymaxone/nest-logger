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

import { GLYPH_LETTER_RUNS } from './glyph-letters.generated'

/**
 * What is not part of a name: everything that is not a letter or a digit (the separators and the rest
 * of the punctuation, white space, control and format characters, the combining marks, which include
 * the dot that lower-casing `İ` leaves behind, and symbols), and the Hangul fillers, which are letters
 * that print as nothing.
 */
const NOT_NAME = /[^\p{L}\p{N}]|[\u115f\u1160\u3164\uffa0]/gu

/** A symbol that is not ASCII (`So`, `Sm`, `Sk`) is read, where a value is hidden, as this stand-in for nothing, one or two characters of a name. */
const SYMBOL_STAND_IN = '\ufffc'
const NON_ASCII_SYMBOL = /(?=[^\0-\x7f])[\p{So}\p{Sm}\p{Sk}]/gu

/** What is not part of a name where a value is hidden: the same, except the stand-in for a symbol. */
const NOT_NAME_STRICT = /[^\p{L}\p{N}\ufffc]|[\u115f\u1160\u3164\uffa0]/gu

/** The symbols drawn as a Latin letter that Unicode gives no decomposition for, by the letter, from {@link GLYPH_LETTER_RUNS}. */
const GLYPH_LETTERS: ReadonlyMap<string, string> = new Map(
  GLYPH_LETTER_RUNS.flatMap(([first, letters]) =>
    [...letters].map((letter, index): [string, string] => [
      String.fromCodePoint(first + index),
      letter
    ])
  )
)

/** `text` with each symbol drawn as a Latin letter read as the letter, before the symbols are dropped as punctuation. */
function readGlyphs(text: string): string {
  return Array.from(text, (glyph) => GLYPH_LETTERS.get(glyph) ?? glyph).join('')
}

/** The same without the separators: what prints as nothing, white space and the combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}\u115f\u1160\u2800\u3164\uffa0]/gu

/** The characters drawn like a full stop, which a key may use in place of the `.` of a dotted name. */
const DOTS = /[\u3002\u0701\u06d4\u22c5\u00b7\ufe12]/gu

/** A key made only of printable ASCII: no rule here changes it except its case and what is not a letter or a digit. */
const PLAIN = /^[\x21-\x7e]*$/

/** The characters that are not ASCII. */
const NON_ASCII = /[^\x20-\x7e]/

/** What is not an ASCII letter or digit. */
const NOT_ASCII_NAME = /[^A-Za-z0-9]/g

/**
 * The letters of other scripts drawn like one Latin letter and no other, by the Latin letter they are
 * taken for. A letter that lower-cases from a capital drawn like two Latin letters (the capital Greek
 * nu is an N, a capital Cyrillic or Greek i is an I and an l) is not here: it is a wildcard where a
 * value is hidden.
 */
const LOOKALIKES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    a: '\u0430\u03b1\u1d00',
    b: '\u0299',
    c: '\u0441\u03f2\u1d04\u023c\u0188',
    d: '\u0501\u1d05',
    e: '\u0435\u03b5\u03f5\u1d07\u025b\u04bd',
    f: '\ua730',
    g: '\u0262',
    h: '\u029c',
    j: '\u0458\u1d0a',
    k: '\u1d0b',
    l: '\u029f',
    m: '\u1d0d',
    n: '\u0274',
    o: '\u043e\u03bf\u1d0f\u00f8',
    p: '\u0440\u03c1\u1d18\u01bf',
    q: '\u051b',
    r: '\u0280',
    s: '\u0455\ua731',
    t: '\u1d1b\u0167',
    u: '\u1d1c',
    v: '\u1d20',
    w: '\u051d\u1d21',
    x: '\u0445',
    y: '\u0443\u028f\u04af',
    z: '\u1d22'
  }).flatMap(([latin, letters]) => [...letters].map((letter): [string, string] => [letter, latin]))
)

/**
 * The letters drawn like an I, which is also an l, mapped to `i` where a field is dropped: the key of the
 * entry is not a secret, and a spelling that only looks like it is dropped like it.
 */
const I_LIKE: ReadonlyMap<string, string> = new Map(
  [...'\u0456\u03b9\u0131\u026a\u0269'].map((letter): [string, string] => [letter, 'i'])
)

/**
 * A key with its case, its separators, its white space and its invisible characters removed, and the
 * letters drawn like a Latin one replaced by it, so the spellings of one name compare equal:
 * `trace_id`, `trace.id`, `Trace-Id`, `TRACEID`, `trace id` and `trace\u200bid` all fold to `traceid`.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param key - A field name.
 * @param keepSeparators - Keep `_`, `.` and `-`, so `exception_type` and `exception.type` stay two names.
 * @returns The folded name, with every look-alike read: this is the form where a field is dropped.
 */
export function foldKey(key: string, keepSeparators = false): string {
  if (keepSeparators) {
    // Stryker disable next-line ConditionalExpression: for a key of printable ASCII the full path returns the same text; this branch only skips its work (about 90 ns a key, measured).
    if (PLAIN.test(key)) return key.toLowerCase()
    return withLookalikes(
      readGlyphs(key.normalize('NFKD').toLowerCase()).replace(DOTS, '.').replace(INVISIBLE, ''),
      true
    )
  }
  // Stryker disable next-line ConditionalExpression: for a key of printable ASCII the full path returns the same text; this branch only skips its work (about 90 ns a key, measured).
  if (PLAIN.test(key)) return key.replace(NOT_ASCII_NAME, '').toLowerCase()
  return withLookalikes(readGlyphs(key.normalize('NFKD').toLowerCase()).replace(NOT_NAME, ''), true)
}

/**
 * The key folded where a value is hidden: the look-alikes of one Latin letter and no other are read as
 * it, and every other letter that is not ASCII is left for the comparison, where it stands for a letter.
 */
function foldStrict(key: string): string {
  // Stryker disable next-line ConditionalExpression: for a key of printable ASCII the full path returns the same text; this branch only skips its work (about 90 ns a key, measured).
  if (PLAIN.test(key)) return key.replace(NOT_ASCII_NAME, '').toLowerCase()
  return withLookalikes(
    readGlyphs(key.normalize('NFKD').toLowerCase())
      .replace(NON_ASCII_SYMBOL, SYMBOL_STAND_IN)
      .replace(NOT_NAME_STRICT, ''),
    false
  )
}

/** `folded` with the look-alikes read as the Latin letters, and the i-like ones too when `all` is set. */
function withLookalikes(folded: string, all: boolean): string {
  let read = folded
  for (const [letter, latin] of LOOKALIKES) read = read.replaceAll(letter, latin)
  if (all) for (const [letter, latin] of I_LIKE) read = read.replaceAll(letter, latin)
  return read
}

/** A key of ASCII letters and digits: folding it is lower-casing it. */
const ALNUM = /^[A-Za-z0-9]*$/

/** A field name folded for hiding. */
function formOf(key: string): string {
  // Stryker disable next-line ConditionalExpression: false is equivalent (foldStrict lower-cases an ASCII alphanumeric key too); true is killed by the foldName rows, and one disable covers both mutants
  return ALNUM.test(key) ? key.toLowerCase() : foldStrict(key)
}

/** What each set of names answered for the short keys it was asked about; a set is fixed once built. */
const answers = new WeakMap<ReadonlySet<string>, Map<string, boolean>>()

/**
 * The form of a field name that a configured name is compared in, where a value is hidden: the
 * key with everything that is not a letter or a digit dropped and the look-alikes of exactly one Latin
 * letter read as it, so `apiKey`, `api_key`, `API-KEY`, `api\u200bKey` and `\u0430piKey` are one name.
 * A letter that is not ASCII and is no such look-alike is left, for {@link matchesFolded}.
 * The common spellings skip the fold, so the comparison that runs for every key of every record costs
 * about what lower-casing it did; {@link matchesKey} remembers what a set answered for a short key.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param key - A field name, or a configured name.
 * @returns The folded name.
 */
export function foldName(key: string): string {
  return formOf(key)
}

/**
 * The configured names in the form every key is compared in. A name that folds to nothing is left out,
 * since it would match every key that prints as nothing.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param names - The configured names.
 * @returns The set the keys of a record are looked up in.
 */
export function foldedNames(names: Iterable<string>): Set<string> {
  return new Set(Array.from(names, foldName).filter((name) => name !== ''))
}

/** How many names of a compatible length a key is walked against before it is taken for one of them. */
const MAX_CANDIDATES = 64

/** The names of a set grouped by their length in characters, and the longest, built once for each set. */
interface Grouped {
  readonly byLength: ReadonlyMap<number, readonly string[]>
  readonly longest: number
}
const grouped = new WeakMap<ReadonlySet<string>, Grouped>()

/** The names of `names` grouped by length. */
function groupsOf(names: ReadonlySet<string>): Grouped {
  let groups = grouped.get(names)
  if (groups === undefined) {
    const built = new Map<number, string[]>()
    let longest = 0
    for (const name of names) {
      const size = [...name].length
      const same = built.get(size)
      if (same === undefined) built.set(size, [name])
      else same.push(name)
      longest = Math.max(longest, size)
    }
    groups = { byLength: built, longest }
    grouped.set(names, groups)
  }
  return groups
}

/**
 * Whether a folded key is one of the folded names. A key that is only ASCII is looked up as it is. A
 * key that still holds a letter that is not ASCII is compared as a pattern in which each such letter
 * stands for one or for two characters of a name, against the names of the lengths that allows: a
 * look-alike of a letter the folding does not know cannot hide a key from its name, and a key that only
 * happens to share a name's length is hidden too, which is the safe way to be wrong. A key longer than
 * the longest name is no pattern, and one with more candidate names than a bound is hidden without
 * being walked.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param names - The folded names, from {@link foldedNames}.
 * @param folded - The key, folded.
 * @returns `true` when the key is one of the names.
 */
export function matchesFolded(names: ReadonlySet<string>, folded: string): boolean {
  if (names.has(folded)) return true
  if (!NON_ASCII.test(folded)) return false
  const letters = [...folded]
  const wide = letters.filter((letter) => !isAscii(letter)).length
  const stands = letters.filter((letter) => letter === SYMBOL_STAND_IN).length
  const { byLength, longest } = groupsOf(names)
  // More stand-ins than the longest name has characters: the key is hidden without being walked, since
  // the walk is quadratic in them and a key made of symbols is the safe way to be wrong.
  if (longest === 0) return false
  if (stands > longest) return true
  // Stryker disable next-line ConditionalExpression: the false mutant is equivalent (no name is as long as the key, so the walk finds none and answers the same), and the true mutant is killed by the rows of fold-key.util.spec.ts; this disable also hides it from the report because Stryker cannot disable one mutant of a line.
  if (letters.length - stands > longest) return false
  const lengths = Array.from(
    { length: wide + stands + 1 },
    (_, extra) => byLength.get(letters.length - stands + extra) ?? []
  )
  // More names of a compatible length than a key is walked against: the value is hidden, since the work
  // for a key of any length and any set of names is bounded and a hidden value is the safe answer. The
  // names are counted before they are gathered.
  if (lengths.reduce((count, same) => count + same.length, 0) > MAX_CANDIDATES) return true
  return lengths.some((same) => same.some((name) => matchesName(letters, [...name])))
}

/** Whether a character is ASCII, the DEL character included. */
const isAscii = (letter: string): boolean => letter < '\x80'

/**
 * Whether the letters of a key read as the characters of a name: an ASCII letter is itself, and any
 * other letter is one or two characters of the name (`ß` is two, a capital drawn like an `l` is one).
 */
function matchesName(letters: readonly string[], name: readonly string[]): boolean {
  let at = new Set([0])
  for (const letter of letters) {
    const next = new Set<number>()
    for (const position of at) {
      if (letter === SYMBOL_STAND_IN) {
        next.add(position)
        next.add(position + 1)
        next.add(position + 2)
        continue
      }
      if (isAscii(letter)) {
        if (name[position] === letter) next.add(position + 1)
        continue
      }
      next.add(position + 1)
      next.add(position + 2)
    }
    at = next
  }
  return at.has(name.length)
}

/**
 * Whether a field name is one of the folded names: {@link matchesFolded} of the folded key, with the
 * common spellings answered without folding, since this runs for every key of every record.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param names - The folded names, from {@link foldedNames}.
 * @param key - A field name as the record has it.
 * @returns `true` when the key is one of the names.
 */
export function matchesKey(names: ReadonlySet<string>, key: string): boolean {
  const seen = answers.get(names) ?? new Map<string, boolean>()
  answers.set(names, seen)
  const known = seen.get(key)
  if (known !== undefined) return known
  const folded = formOf(key)
  const answer = names.has(folded) || matchesFolded(names, folded)
  if (key.length <= 64) {
    if (seen.size > 1023) seen.clear()
    seen.set(key, answer)
  }
  return answer
}
