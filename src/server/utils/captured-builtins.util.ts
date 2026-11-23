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

const shift = Array.prototype.shift
const forEach = Array.prototype.forEach
const slice = String.prototype.slice
const stringIterator = String.prototype[Symbol.iterator]
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const ownKeys = Reflect.ownKeys

/**
 * Whether the built-in methods this library cannot capture are the ones the module loaded with. Pino
 * reads `shift` for each log call and `forEach` when it builds its fan-out, and the code that hides the
 * message in an error stack reads `slice`, the string iterator, `getOwnPropertyDescriptors` and
 * `ownKeys`. One that answers wrongly makes Pino write an `Error` unredacted, or drop every log, and
 * leaves the message in the first line of a stack: a record is dropped instead, whole.
 *
 * @returns `false` when any of them was replaced after the module loaded.
 */
export function pinoBuiltinsIntact(): boolean {
  return (
    Array.prototype.shift === shift &&
    Array.prototype.forEach === forEach &&
    String.prototype.slice === slice &&
    String.prototype[Symbol.iterator] === stringIterator &&
    Object.getOwnPropertyDescriptors === getOwnPropertyDescriptors &&
    Reflect.ownKeys === ownKeys
  )
}
