/**
 * Whether a value is plain data: an object whose prototype is `Object.prototype` or none.
 *
 * Layer: server/utils — shared by the string cut and by the logger service, so both read "plain"
 * the same way. An array, an `Error`, a `Date` or an instance of a class is not plain.
 */

/**
 * @param node - Any value.
 * @returns `true` for an object literal, a `JSON.parse` result or `Object.create(null)`; `false`
 *   for everything else, and for an object whose prototype cannot be read.
 */
export function isPlainRecord(node: unknown): node is Record<string, unknown> {
  try {
    const prototype: unknown = Object.getPrototypeOf(node)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}
