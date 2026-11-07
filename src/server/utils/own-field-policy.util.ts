/**
 * Which of an error's own fields are written to a line, and how a binary one is written.
 *
 * Layer: server, utils. Shared by the error sanitizer and the redaction walk, so the serializer
 * and the walk answer the same question the same way.
 */
import type { ErrorOwnFieldsMode } from '../interfaces/logger-module-options.interface'

/**
 * The own fields `errorOwnFields: 'safe'` writes unless the consumer adds to them: the operational
 * names of Node's system errors, an HTTP layer's status, and the PostgreSQL fields that name a
 * place in the schema and quote no row. `path` is not here, because it is a file system path and
 * the consumer decides whether that is data.
 */
export const DEFAULT_SAFE_ERROR_FIELDS: readonly string[] = Object.freeze([
  'code',
  'errno',
  'syscall',
  'signal',
  'status',
  'statusCode',
  'address',
  'port',
  'hostname',
  'constraint',
  'table',
  'column',
  'schema',
  'routine'
])

/**
 * Fields the logger itself writes on a node, whatever the policy: the ones it derives, and the
 * marker of a field it could not read. Filtering these would lose the error's own message.
 */
const LIBRARY_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'message',
  'stack',
  'cause',
  'errors',
  '_errorFieldsIncomplete'
])

/** What the sanitizer and the redaction walk consult for each own field of an error. */
export interface OwnFieldPolicy {
  /** Whether a field must be on the list to be written. */
  readonly safe: boolean
  /** The names written when {@link OwnFieldPolicy.safe} is on. */
  readonly names: ReadonlySet<string>
}

/** The policy of `errorOwnFields: 'all'`: every own field is written. */
export const ALL_OWN_FIELDS: OwnFieldPolicy = Object.freeze({
  safe: false,
  names: new Set<string>()
})

/**
 * Resolve the policy for the configured mode.
 *
 * @param mode - `'all'` writes every own field, `'safe'` only the listed ones.
 * @param extraNames - The consumer's names, written in `'safe'` mode beside the default list.
 * @returns The policy to hand to the sanitizer and the redaction walk.
 */
export function createOwnFieldPolicy(
  mode: ErrorOwnFieldsMode,
  extraNames: readonly string[]
): OwnFieldPolicy {
  if (mode === 'all') return ALL_OWN_FIELDS
  return Object.freeze({
    safe: true,
    names: new Set([...DEFAULT_SAFE_ERROR_FIELDS, ...extraNames])
  })
}

/**
 * Whether the policy writes a field of this name.
 *
 * @param policy - The resolved policy.
 * @param key - The own field's name, matched exactly.
 * @returns `true` when the field is written.
 */
export function allowsOwnField(policy: OwnFieldPolicy, key: string): boolean {
  return !policy.safe || LIBRARY_FIELDS.has(key) || policy.names.has(key)
}

/** The size marker written in place of a Buffer, a typed array or a DataView. */
function binaryMarker(view: ArrayBufferView): string {
  return `[Binary ${view.byteLength} bytes]`
}

/**
 * Replace the bytes of a binary own field by their size. Nobody intends a byte array as log data,
 * and it is exactly what a failed child process carries in `stdout`, `stderr` and `output` (an
 * array whose members are those buffers), so the value itself and the members of an array are
 * covered, and nothing deeper is read.
 *
 * @param value - The own field's value.
 * @returns The value, or a copy with each binary member replaced by its marker.
 */
export function withBinaryAsSize(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return binaryMarker(value)
  if (!Array.isArray(value) || !value.some((member) => ArrayBuffer.isView(member))) return value
  return value.map((member: unknown) =>
    ArrayBuffer.isView(member) ? binaryMarker(member) : member
  )
}
