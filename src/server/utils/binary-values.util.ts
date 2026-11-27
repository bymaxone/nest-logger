/**
 * A binary view where a line expects named fields.
 *
 * Layer: server/utils.
 */
import { withBinaryAsSize } from './own-field-policy.util'

const isView = ArrayBuffer.isView

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
