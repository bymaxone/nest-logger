/**
 * Size-bounded serializer wrapper.
 *
 * Layer: server/utils — wraps a Pino field serializer so a single field whose
 * serialized JSON exceeds a byte ceiling is replaced by a compact truncation
 * envelope instead of flooding the log pipeline (e.g. a full Stripe webhook
 * payload accidentally logged on an `err` or custom-serialized field).
 *
 * The ceiling is measured in UTF-8 BYTES (not characters) because that is the
 * wire format Pino writes — a multi-byte string can blow the budget with fewer
 * characters than the limit suggests.
 */
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'

/** Characters of the original JSON retained as a preview in the envelope. */
const PREVIEW_LENGTH = 200

/**
 * Compact envelope substituted for a field that exceeded the size ceiling.
 *
 * Not re-exported by the package barrel — it is an internal log-shape contract,
 * documented here so downstream queries know what a truncated field looks like.
 */
export interface TruncatedEntry {
  /** Always `true` — marks the field value as truncated. */
  _truncated: true
  /** Reserved log key so aggregators can detect/alert on truncated entries. */
  _logKey: typeof RESERVED_LOG_KEYS.LOGGER_ENTRY_TRUNCATED
  /** Byte size (UTF-8) of the original serialized value. */
  _originalSize: number
  /** First {@link PREVIEW_LENGTH} characters of the original serialized JSON. */
  _preview: string
}

/**
 * Wrap a serializer so its output is replaced by a {@link TruncatedEntry} when
 * the serialized JSON exceeds `maxBytes`.
 *
 * @typeParam T - The serializer's input type (inferred from `baseSerializer`).
 * @param baseSerializer - The serializer whose output is size-bounded.
 * @param maxBytes - Maximum UTF-8 byte size before the value is truncated.
 * @returns A serializer with identical input but a size-capped output.
 */
export function createSizeBoundedSerializer<T>(
  baseSerializer: (input: T) => unknown,
  maxBytes: number
): (input: T) => unknown {
  return (input: T): unknown => {
    const serialized = baseSerializer(input)
    const json = JSON.stringify(serialized)
    // A serializer may legitimately produce `undefined` (JSON.stringify → undefined
    // for undefined / functions / symbols). There is nothing to measure, so pass it
    // through untouched rather than crash `Buffer.byteLength`.
    if (json === undefined) {
      return serialized
    }
    const byteSize = Buffer.byteLength(json, 'utf-8')
    if (byteSize > maxBytes) {
      return {
        _truncated: true,
        _logKey: RESERVED_LOG_KEYS.LOGGER_ENTRY_TRUNCATED,
        _originalSize: byteSize,
        _preview: json.slice(0, PREVIEW_LENGTH)
      } satisfies TruncatedEntry
    }
    return serialized
  }
}
