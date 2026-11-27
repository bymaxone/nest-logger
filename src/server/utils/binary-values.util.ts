/**
 * Where a binary value reaches Pino without the walk of the record having read it.
 *
 * Layer: server/utils. Pino's path redaction copies what it reads onto the prototype of the
 * original, and a copy with the prototype of a `Buffer` throws a `TypeError` when it is written,
 * into the caller.
 */
import { setAdd, setHas } from './captured-builtins.util'
import { withBinaryAsSize } from './own-field-policy.util'
import { REDACT_MAX_VISITS } from './redact-by-name.util'

const keysOf = Object.keys
const get = Reflect.get
const isView = ArrayBuffer.isView

/**
 * Whether `value` is a binary view or holds one under an own enumerable string key, at any depth,
 * which is what the copy of Pino's redaction reaches.
 *
 * @param value - Anything a caller passed.
 * @returns `true` too when `value` cannot be read, or has more members than
 *   {@link REDACT_MAX_VISITS} to look through, so that the walk, which is bounded, answers for it.
 */
export function holdsBinary(value: unknown): boolean {
  const seen = new Set<unknown>()
  const pending: unknown[] = [value]
  // Counted as members are read: a getter can make a new object on every read, which no set of the
  // objects already seen ends.
  let read = 0
  try {
    while (pending.length > 0) {
      const next = pending.pop()
      if (typeof next !== 'object' || next === null || setHas(seen, next)) continue
      if (isView(next)) return true
      setAdd(seen, next)
      for (const key of keysOf(next)) {
        read += 1
        if (read > REDACT_MAX_VISITS) return true
        pending[pending.length] = get(next, key)
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
