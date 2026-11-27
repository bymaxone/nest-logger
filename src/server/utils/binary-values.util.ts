/**
 * What reaches Pino without the walk of the record having read it, and may hold a binary value.
 *
 * Layer: server/utils. Pino's path redaction copies what it reads onto the prototype of the
 * original, and a copy with the prototype of a `Buffer` throws a `TypeError` when it is written,
 * into the caller.
 */
import { types } from 'node:util'

import { setAdd, setHas } from './captured-builtins.util'
import { withBinaryAsSize } from './own-field-policy.util'
import { REDACT_MAX_VISITS } from './redact-by-name.util'

const keysOf = Object.keys
const describe = Reflect.getOwnPropertyDescriptor
const prototypeOf = Object.getPrototypeOf
const hasOwn = Object.hasOwn
const dateToJson = Date.prototype.toJSON
const isView = ArrayBuffer.isView

/** A real chain is a handful of prototypes deep; a Proxy can answer a cycle for ever. */
const MAX_PROTOTYPE_HOPS = 256

/**
 * Whether writing `value` may run code of the host: it is a Proxy, or it has a `toJSON` of its own
 * or from its prototypes. The `toJSON` of a `Date` does not count. Nothing of the host is called.
 */
function answersByCode(value: object): boolean {
  let current: object | null = value
  for (let hops = 0; current !== null; hops++) {
    if (hops > MAX_PROTOTYPE_HOPS || types.isProxy(current)) return true
    const found = describe(current, 'toJSON')
    if (found !== undefined) {
      // A descriptor with no value of its own is an accessor.
      if (!hasOwn(found, 'value')) return true
      return typeof found.value === 'function' && found.value !== dateToJson
    }
    current = prototypeOf(current) as object | null
  }
  return false
}

/**
 * Whether the walk has to answer for `value`: it is or holds a binary view under an own enumerable
 * string key, at any depth, which the copy of Pino's redaction reaches, or something in it answers
 * through code of the host (a getter, a `toJSON`, a Proxy), which can give a view when Pino writes
 * it. The scan runs none of that code, so the walk is the one to read it, once.
 *
 * @param value - Anything a caller passed.
 * @returns `true` too when `value` cannot be read, or has more members than
 *   {@link REDACT_MAX_VISITS} to look through, so that the walk, which is bounded, answers for it.
 */
export function needsTheWalk(value: unknown): boolean {
  const seen = new Set<unknown>()
  const pending: unknown[] = [value]
  let read = 0
  try {
    while (pending.length > 0) {
      const next = pending.pop()
      // `JSON.stringify` calls the `toJSON` of a function too.
      if (typeof next === 'function' && answersByCode(next)) return true
      if (typeof next !== 'object' || next === null || setHas(seen, next)) continue
      if (isView(next) || answersByCode(next)) return true
      setAdd(seen, next)
      for (const key of keysOf(next)) {
        read += 1
        if (read > REDACT_MAX_VISITS) return true
        const member = describe(next, key) as PropertyDescriptor
        if (!hasOwn(member, 'value')) return true
        pending[pending.length] = member.value
      }
    }
    return false
  } catch {
    return true
  }
}

/**
 * A binary view given where the fields of a line or of the bindings are expected, as one field with
 * its size. It has no field names, and Pino would write one field for each element of a typed array.
 *
 * @param value - The merge object or the bindings.
 * @returns `value`, or the one field.
 */
export function binaryAsField<T>(value: T): T | { binary: unknown } {
  return isView(value) ? { binary: withBinaryAsSize(value) } : value
}
