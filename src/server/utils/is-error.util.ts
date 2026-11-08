/**
 * Whether a value is an error, in any realm.
 *
 * Layer: server, utils. `instanceof Error` is false for an `Error` made in another realm: a `vm`
 * context, a worker, or a Node core module under a test runner. Its `name` and `message` are
 * non-enumerable, so it is recognised with `util.types.isNativeError`, and `instanceof` still
 * covers an object that only inherits from this realm's `Error`.
 */
import { types } from 'node:util'

/**
 * @param value - Any value.
 * @returns `true` when the value is a native error of any realm or inherits from this realm's
 *   `Error`. `false` for a Proxy whose `getPrototypeOf` trap throws. Never throws.
 */
export function isError(value: unknown): value is Error {
  try {
    return types.isNativeError(value) || value instanceof Error
  } catch {
    return false
  }
}
