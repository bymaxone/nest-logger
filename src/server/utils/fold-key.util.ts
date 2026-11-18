/**
 * The comparison of two keys that are spellings of one name.
 *
 * Layer: server/utils — pure, no I/O. A backend that normalises field names reads `trace_id`,
 * `trace.id` and `TraceId` as one field, so a key a caller writes that only spells a key the logger
 * writes is dropped like the key itself. One rule decides it, here, for the keys the entry owns and
 * for the keys the request context and the active span write.
 */

/** The separators that are not part of a name: `_`, `.` and `-`. */
const SEPARATORS = /[._-]/g

/**
 * A key with its case and its separators removed, so the spellings of one name compare equal:
 * `trace_id`, `trace.id`, `Trace-Id` and `TRACEID` all fold to `traceid`.
 *
 * @internal Shared across the logger. NOT re-exported by the package barrel.
 * @param key - A field name.
 * @returns The name with no separators, in lower case.
 */
export function foldKey(key: string): string {
  return key.replace(SEPARATORS, '').toLowerCase()
}
