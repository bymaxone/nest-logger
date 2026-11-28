/**
 * Which of an error's own fields are written to a line, and how a binary one is written.
 *
 * Layer: server, utils. Shared by the error sanitizer and the redaction walk, so the serializer
 * and the walk answer the same question the same way.
 */
import { types } from 'node:util'

import { capturedSet } from './captured-builtins.util'
import { isError } from './is-error.util'
import type { ErrorOwnFieldsMode } from '../interfaces/logger-module-options.interface'

/**
 * The own fields `errorOwnFields: 'safe'` writes unless the consumer adds to them: the operational
 * names of Node's system errors, an HTTP layer's status, and the PostgreSQL fields that name a
 * place in the schema and quote no row. `path` is not here, because it is a file system path and
 * the consumer decides whether that is data.
 */
export const DEFAULT_SAFE_ERROR_FIELDS: readonly string[] = [
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
]

/**
 * Fields a sanitized node derives itself, excluded from the own-property copy and always written,
 * whatever the policy: filtering them would lose the error's own message.
 *
 * A real `Error` keeps `name` / `message` / `stack` non-enumerable, so they never reach the copy
 * loop. An error-LIKE plain object (what `HttpExceptionFilter` produces, and what any error
 * crossing a worker boundary becomes) carries them as ordinary own keys, and copying them would
 * emit the same value twice: once derived (scrubbed, in the case of `stack`) and once raw.
 */
export const DERIVED_ERROR_FIELDS: ReadonlySet<string> = capturedSet([
  'name',
  'message',
  'stack',
  'cause',
  'errors'
])

/** What the sanitizer and the redaction walk consult for each own field of an error. */
export interface OwnFieldPolicy {
  /** Whether a field must be on the list to be written. */
  readonly safe: boolean
  /** The names written when {@link OwnFieldPolicy.safe} is on. */
  readonly names: ReadonlySet<string>
}

/** The policy of `errorOwnFields: 'all'`: every own field is written. */
export const ALL_OWN_FIELDS: OwnFieldPolicy = { safe: false, names: capturedSet<string>() }

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
  return { safe: true, names: capturedSet([...DEFAULT_SAFE_ERROR_FIELDS, ...extraNames]) }
}

/**
 * Whether the policy writes a field of this name.
 *
 * @param policy - The resolved policy.
 * @param key - The own field's name, matched exactly.
 * @returns `true` when the field is written.
 */
export function allowsOwnField(policy: OwnFieldPolicy, key: string): boolean {
  return (
    !policy.safe ||
    DERIVED_ERROR_FIELDS.has(key) ||
    key === '_errorFieldsIncomplete' ||
    policy.names.has(key)
  )
}

/**
 * The engine's own `byteLength` getters. A subclass can override the property with text that
 * should have been redacted, so the size is never read from the value's own `byteLength`.
 * The `?.` only keeps the import from throwing where a getter was deleted before this module loaded.
 */
const TYPED_ARRAY_BYTE_LENGTH = Reflect.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength'
)?.get as (this: ArrayBufferView) => number
const DATA_VIEW_BYTE_LENGTH = Reflect.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')
  ?.get as (this: ArrayBufferView) => number

/** The size of a DataView, which is zero when none of its bytes can be read. */
function dataViewSize(view: ArrayBufferView): number {
  try {
    return DATA_VIEW_BYTE_LENGTH.call(view)
  } catch {
    // The getter throws on a detached or out of bounds view, where that of a typed array gives 0.
    return 0
  }
}

/** The size marker written in place of a Buffer, a typed array or a DataView. */
function binaryMarker(view: ArrayBufferView): string {
  const size = types.isDataView(view) ? dataViewSize(view) : TYPED_ARRAY_BYTE_LENGTH.call(view)
  return `[Binary ${size} bytes]`
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

/**
 * A value that is about to be turned into text, with each binary value it is or its arrays hold
 * replaced by its size: `String` joins an array through the text of every member, however deep, and
 * the text of a Buffer is its bytes.
 *
 * @param value - The value to be turned into text.
 * @returns The value itself when it holds nothing binary, else what to turn into text.
 */
export function withBinaryAsSizeForText(value: unknown): unknown {
  return holdsBinary(value) ? sizedForText(value, capturedSet<unknown>()) : value
}

/** What the text of `value` is made from, when that is more than the value itself. */
function isTextContainer(value: unknown): boolean {
  return Array.isArray(value) || isError(value)
}

/**
 * Whether the text of a value would read a binary one. It keeps its own list of what is left to
 * look at, so that no depth of nesting ends the call stack, and it copies nothing.
 */
function holdsBinary(root: unknown): boolean {
  if (ArrayBuffer.isView(root)) return true
  // Only what `isTextContainer` accepts is queued, so what is taken from the list is not tested again.
  // Stryker disable next-line ArrayDeclaration: equivalent, a planted string is taken last and nothing in it is binary or queued.
  const pending: unknown[] = []
  const queue = (value: unknown): void => {
    if (isTextContainer(value)) pending.push(value)
  }
  queue(root)
  const seen = capturedSet<unknown>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (seen.has(value)) continue
    seen.add(value)
    const parts = isError(value) ? [value.name, value.message] : (value as unknown[])
    // By index and a length read once, as `join` reads an array, so no iterator of the host's runs.
    for (let index = 0, length = parts.length; index < length; index += 1) {
      const part: unknown = parts[index]
      if (ArrayBuffer.isView(part)) return true
      queue(part)
    }
  }
  return false
}

/** The copy of a value that holds something binary; `open` ends a cycle where `join` ends it. */
function sizedForText(value: unknown, open: Set<unknown>): unknown {
  if (ArrayBuffer.isView(value)) return binaryMarker(value)
  if (isError(value)) return errorTextSource(value, open)
  if (!Array.isArray(value)) return value
  if (open.has(value)) return ''
  open.add(value)
  let changed = false
  // The length is set rather than filled, and a hole stays one: it can far exceed what is held.
  const members: unknown[] = []
  const length = value.length
  members.length = length
  for (let index = 0; index < length; index += 1) {
    const member: unknown = value[index]
    // A hole reads as `undefined`, which `join` writes the same way: it stays a hole.
    if (member === undefined) continue
    members[index] = sizedForText(member, open)
    if (members[index] !== member) changed = true
  }
  open.delete(value)
  return changed ? members : value
}

/**
 * An error is turned into text from its name and its message, which code without types can fill with
 * a binary value: its size then stands for the whole error.
 */
function errorTextSource(error: Error, open: Set<unknown>): unknown {
  if (open.has(error)) return ''
  open.add(error)
  const parts: unknown[] = [error.name, error.message]
  const sized = parts.map((part) => sizedForText(part, open))
  open.delete(error)
  const changed = sized.findIndex((part, index) => part !== parts[index])
  return changed === -1 ? error : sized[changed]
}
