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

/** `String.prototype.replaceAll`, as it was when the module loaded. */
export const replaceAllText = call.bind(String.prototype.replaceAll) as (
  text: string,
  search: string,
  replacement: string
) => string

/**
 * A set whose `has` and `add` are its own, bound to the methods captured at load, so a call on the set
 * does not read `Set.prototype`. The values go in through the captured `add`, which the `Set`
 * constructor would read from the prototype.
 *
 * @param values - What the set starts with.
 * @returns The set.
 */
export function capturedSet<T>(values: Iterable<T> = []): Set<T> {
  const set = new Set<T>()
  const has = (value: T): boolean => setHas(set, value)
  const add = (value: T): Set<T> => {
    setAdd(set as Set<unknown>, value)
    return set
  }
  defineProperty(set, 'has', bareDescriptor({ value: has }))
  defineProperty(set, 'add', bareDescriptor({ value: add }))
  for (const value of values) add(value)
  return set
}

const shift = Array.prototype.shift
const forEach = Array.prototype.forEach

/**
 * Whether the two built-in methods Pino calls for each log call and when it builds its fan-out are the
 * ones the module loaded with. Pino reads them from the prototype where this library cannot capture
 * them, and one that answers nothing makes it write an `Error` unredacted, or drop every log.
 *
 * @returns `false` when either was replaced after the module loaded.
 */
export function pinoBuiltinsIntact(): boolean {
  return Array.prototype.shift === shift && Array.prototype.forEach === forEach
}
