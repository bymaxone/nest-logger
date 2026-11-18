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
  /** Byte size (UTF-8) of the original serialized value, or `-1` when it could not be measured. */
  _originalSize: number
  /** First {@link PREVIEW_LENGTH} characters of the original serialized JSON. */
  _preview: string
}

/**
 * The JSON text of `value` as Pino would write it, with the two things `JSON.stringify` throws on
 * written the way the logger writes them: a reference back to an ancestor becomes `"[Circular]"`
 * and a `BigInt` its decimal digits. A value that is referenced twice without a cycle is written
 * twice, because only a reference to an ANCESTOR is a cycle.
 *
 * @param value - The serializer output.
 * @returns The JSON text, or `undefined` when JSON has nothing to write for the value (a
 *   function, a symbol, `undefined`).
 * @throws Error When the value cannot be read at all (a `toJSON` or a getter that throws).
 */
function measurableJson(value: unknown): string | undefined {
  // The holder each object was last visited from. Walking up from the holder of the value being
  // visited gives the path that leads to it, so a value that is on that path is a cycle, and one
  // that is not (a shared sub-object) is written again, as Pino writes it.
  const parents = new WeakMap<object, unknown>()
  return JSON.stringify(value, function (this: unknown, _key: string, inner: unknown): unknown {
    if (typeof inner === 'bigint') return inner.toString()
    if (typeof inner !== 'object' || inner === null) return inner
    for (let holder: unknown = this; holder !== undefined; holder = parents.get(holder as object)) {
      if (holder === inner) return '[Circular]'
    }
    parents.set(inner, this)
    return inner
  })
}

/**
 * Wrap a serializer so its output is replaced by a {@link TruncatedEntry} when
 * the serialized JSON exceeds `maxBytes`. An output that cannot be measured at all is replaced too,
 * with `_originalSize` of `-1`, because a size that cannot be shown to be under the ceiling is not
 * known to be bounded.
 *
 * @typeParam T - The serializer's input type (inferred from `baseSerializer`).
 * @param baseSerializer - The serializer whose output is size-bounded.
 * @param maxBytes - Maximum UTF-8 byte size before the value is truncated.
 * @param onTruncate - Called each time an output is replaced by the envelope, so the replacements
 *   can be counted.
 * @returns A serializer with identical input but a size-capped output.
 */
export function createSizeBoundedSerializer<T>(
  baseSerializer: (input: T) => unknown,
  maxBytes: number,
  onTruncate?: () => void
): (input: T) => unknown {
  return (input: T): unknown => {
    const serialized = baseSerializer(input)
    let json: string | undefined
    try {
      json = measurableJson(serialized)
    } catch {
      // The value cannot be read (a `toJSON` or a getter that throws). The logging path must never
      // throw, and a value that cannot be measured cannot be shown to be bounded, so it is replaced.
      onTruncate?.()
      return unmeasurableEnvelope()
    }
    // A serializer may legitimately produce `undefined` (JSON.stringify → undefined
    // for undefined / functions / symbols). There is nothing to measure, so pass it
    // through untouched rather than crash `Buffer.byteLength`.
    if (json === undefined) {
      return serialized
    }
    const byteSize = Buffer.byteLength(json, 'utf-8')
    if (byteSize > maxBytes) {
      onTruncate?.()
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

/** The envelope for a value whose size could not be measured: `-1` is "unknown", not a size. */
function unmeasurableEnvelope(): TruncatedEntry {
  return {
    _truncated: true,
    _logKey: RESERVED_LOG_KEYS.LOGGER_ENTRY_TRUNCATED,
    _originalSize: -1,
    _preview: ''
  }
}
