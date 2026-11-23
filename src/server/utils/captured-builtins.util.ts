/**
 * The built-in methods the redaction and the routing of the logger decide with, captured when the module
 * loads.
 *
 * Layer: server/utils. Pure. A method a program replaces after the logger is imported (`Set.prototype.has`
 * that answers `undefined`, `String.prototype.toLowerCase`) would otherwise answer for the names to hide
 * and the destinations to write to; a call through the function captured here does not read the property.
 */
import { bareDescriptor } from './bare-descriptor.util'

const call = Function.prototype.call
const defineProperty = Object.defineProperty

/** `Set.prototype.has`, as it was when the module loaded. */
export const setHas = call.bind(Set.prototype.has) as (
  set: ReadonlySet<unknown>,
  value: unknown
) => boolean

/** `Set.prototype.add`, as it was when the module loaded. */
export const setAdd = call.bind(Set.prototype.add) as (
  set: Set<unknown>,
  value: unknown
) => Set<unknown>

/** `String.prototype.toLowerCase`, as it was when the module loaded. */
export const lowerCase = call.bind(String.prototype.toLowerCase) as (text: string) => string

const indexOfText = call.bind(String.prototype.indexOf) as (
  text: string,
  search: string,
  from: number
) => number
const sliceText = call.bind(String.prototype.slice) as (
  text: string,
  from: number,
  to?: number
) => string

/**
 * Replaces every occurrence of a plain `search` in `text` with `replacement`, read as it is (no `$`
 * pattern). `String.prototype.replaceAll` asks a string pattern for `Symbol.replace` on
 * `String.prototype`, so one planted there after the load would change what the fold reads.
 *
 * @param text - The text to read.
 * @param search - What to replace; an empty one replaces nothing.
 * @param replacement - What takes its place.
 * @returns The text with every occurrence replaced.
 */
export function replaceAllText(text: string, search: string, replacement: string): string {
  if (search === '') return text
  let result = ''
  let from = 0
  for (let at = indexOfText(text, search, 0); at !== -1; at = indexOfText(text, search, from)) {
    result += sliceText(text, from, at) + replacement
    from = at + search.length
  }
  return result + sliceText(text, from)
}

/** `String.prototype.normalize`, as it was when the module loaded. */
export const normalizeText = call.bind(String.prototype.normalize) as (
  text: string,
  form: 'NFKD'
) => string

const regExpExec = call.bind(RegExp.prototype.exec) as (
  pattern: RegExp,
  text: string
) => RegExpExecArray | null
const regExpReplace = call.bind(RegExp.prototype[Symbol.replace]) as (
  pattern: RegExp,
  text: string,
  replacement: string
) => string

/**
 * Whether `pattern` matches in `text`, by the `exec` captured at load: `RegExp.prototype.test` reads
 * `exec` from the pattern, and one replaced after the load would answer for the names to hide.
 *
 * @param pattern - The pattern to look for.
 * @param text - What it is matched against.
 * @returns `true` when it matches.
 */
export function matchesPattern(pattern: RegExp, text: string): boolean {
  return regExpExec(pattern, text) !== null
}

/**
 * Every match of a global `pattern` in `text`, by the `exec` captured at load: `String.prototype.matchAll`
 * reads `Symbol.matchAll` from the pattern's prototype, and one replaced after the load would yield no
 * match for the names to hide. A match that is empty ends the walk.
 *
 * @param pattern - A global pattern.
 * @param text - What it is matched against.
 * @returns The matches in order.
 */
export function allMatches(pattern: RegExp, text: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = []
  pattern.lastIndex = 0
  for (let match = regExpExec(pattern, text); match !== null; match = regExpExec(pattern, text)) {
    if (match[0] === '') break
    found[found.length] = match
  }
  pattern.lastIndex = 0
  return found
}

/**
 * A global pattern that replaces by the `exec` captured at load: `String.prototype.replace` reads the
 * replacing method from the pattern's prototype, and that method reads `exec` from the pattern. The
 * pattern gets its own `exec`, and the text is replaced through the replacing method captured at load.
 *
 * @param pattern - A global pattern.
 * @returns A function that replaces every match in a text with a string.
 */
export function replacer(pattern: RegExp): (text: string, replacement: string) => string {
  defineProperty(
    pattern,
    'exec',
    bareDescriptor({ value: (text: string) => regExpExec(pattern, text) })
  )
  return (text, replacement) => regExpReplace(pattern, text, replacement)
}

/**
 * A set whose `has` and `add` are its own, bound to the methods captured at load, so a call on the set
 * does not read `Set.prototype`. The values go in through the captured `add`, which the `Set`
 * constructor would read from the prototype.
 *
 * @param values - What the set starts with.
 * @returns The set.
 */
export function capturedSet<T>(values: Iterable<T> = []): Set<T> {
  // An array is walked by index: a `for...of` reads `Array.prototype[Symbol.iterator]`, which a program may replace.
  const set = new Set<T>()
  const has = (value: T): boolean => setHas(set, value)
  const add = (value: T): Set<T> => {
    setAdd(set as Set<unknown>, value)
    return set
  }
  defineProperty(set, 'has', bareDescriptor({ value: has }))
  defineProperty(set, 'add', bareDescriptor({ value: add }))
  if (Array.isArray(values)) for (let at = 0; at < values.length; at++) add(values[at] as T)
  else for (const value of values) add(value)
  return set
}

type Member = string | symbol

/** The prototype of an iterator, which holds the `next` a spread or a `for...of` calls on each step. */
function nextOf(iterator: unknown): object {
  return Object.getPrototypeOf(iterator) as object
}

/**
 * Every built-in the redaction of a record reads, by holder and member: the files that decide what to
 * hide (`fold-key`, `normalize-url`, `matches-exclude-path`, `sanitize-error`, the name paths of
 * `pino-factory`) call these, and Pino and the code that hides a message in an error stack call the
 * rest. A spec scans those files and fails for a built-in member a call reaches that is not here.
 */
export const GUARDED_BUILTINS: ReadonlyArray<readonly [object, ReadonlyArray<Member>]> = [
  [Array, ['from', 'isArray']],
  [
    Array.prototype,
    ['at', 'filter', 'flatMap', 'forEach', 'join', 'map', 'push', 'reduce', 'shift', 'some', 'sort']
  ],
  [Array.prototype, [Symbol.iterator]],
  [String, ['fromCodePoint']],
  [
    String.prototype,
    ['includes', 'indexOf', 'lastIndexOf', 'normalize', 'replace', 'search', 'slice', 'split']
  ],
  [String.prototype, ['startsWith', 'toLowerCase', Symbol.iterator, Symbol.replace]],
  [Map.prototype, ['clear', 'get', 'has', 'set', Symbol.iterator]],
  [Set.prototype, ['add', 'has', 'values', Symbol.iterator]],
  [RegExp.prototype, ['exec', 'test', Symbol.replace]],
  [Object, ['create', 'defineProperty', 'entries', 'fromEntries', 'getOwnPropertyDescriptor']],
  [Object, ['getOwnPropertyDescriptors', 'getPrototypeOf', 'hasOwn', 'keys']],
  [
    Reflect,
    ['defineProperty', 'deleteProperty', 'get', 'getOwnPropertyDescriptor', 'ownKeys', 'set']
  ],
  [Math, ['max']],
  [Number, ['isInteger']],
  [nextOf([][Symbol.iterator]()), ['next']],
  [nextOf(''[Symbol.iterator]()), ['next']],
  [nextOf(new Map()[Symbol.iterator]()), ['next']],
  [nextOf(new Set()[Symbol.iterator]()), ['next']],
  [nextOf(/(?:)/[Symbol.matchAll]('')), ['next']]
]

const guardedHolders: object[] = []
const guardedMembers: Member[] = []
const guardedValues: unknown[] = []
for (let at = 0; at < GUARDED_BUILTINS.length; at++) {
  const entry = GUARDED_BUILTINS[at] as readonly [object, ReadonlyArray<Member>]
  for (let member = 0; member < entry[1].length; member++) {
    const name = entry[1][member] as Member
    guardedHolders[guardedHolders.length] = entry[0]
    guardedMembers[guardedMembers.length] = name
    guardedValues[guardedValues.length] = (entry[0] as Record<Member, unknown>)[name]
  }
}

/**
 * Whether every built-in member of {@link GUARDED_BUILTINS} is the one the module loaded with. A method
 * the logger cannot capture, because Pino or the language reads it (`Array.prototype.shift`, the `next`
 * of a string iterator), would answer for the names to hide: one that was replaced makes a record be
 * dropped, whole, and a URL path be redacted whole.
 *
 * @returns `false` when any of them was replaced after the module loaded.
 */
export function pinoBuiltinsIntact(): boolean {
  for (let at = 0; at < guardedHolders.length; at++) {
    if (
      (guardedHolders[at] as Record<Member, unknown>)[guardedMembers[at] as Member] !==
      guardedValues[at]
    ) {
      return false
    }
  }
  return true
}
