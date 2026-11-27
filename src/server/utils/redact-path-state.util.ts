/**
 * What the configured `redactPaths` can reach in a value that decides its own serialized form.
 *
 * `@pinojs/redact` matches a path against the fields of a value, and the record walk calls
 * `toJSON` before Pino sees them, so the walk has to answer for what the paths name.
 *
 * Layer: server/utils — pure helpers, no I/O.
 */
import { bareDescriptor } from './bare-descriptor.util'
import { allMatches, capturedSet, matchesPattern, setAdd, setHas } from './captured-builtins.util'
import { isError } from './is-error.util'
import { DERIVED_ERROR_FIELDS, type OwnFieldPolicy } from './own-field-policy.util'

/**
 * One path segment: either a `["quoted"]` / `['quoted']` bracket segment, whose
 * contents are ONE name however many dots it holds, or a run of bare characters
 * between the separators.
 *
 * Tokenizing rather than rewriting brackets into dotted text is load-bearing: a
 * key may legitimately contain a dot, and `blob["social.security"]` rewritten as
 * `blob.social.security` yields the leaf `security` — a name that does not exist
 * in the payload, while the one that does goes uncovered.
 */
const PATH_SEGMENT = /\[\s*['"]([^'"]+)['"]\s*\]|([^.[\]]+)/g

/** An unquoted path segment that is an array index rather than a field name. */
const INDEX_SEGMENT = /^\d+$/

/**
 * The leaf field name of a `@pinojs/redact` path.
 *
 * Consumer `redactPaths` are applied by Pino's stringifier, which runs AFTER the
 * serializer wrapper — so a field they cover was still raw when the size bound
 * built its 200-character `_preview`, and an oversized value leaked its secret
 * there. Feeding the leaf NAME to the walk closes that, wherever the walk matches
 * names.
 *
 * The trade is deliberate and broader than the path: a consumer who writes
 * `user.ssn` gets `ssn` censored wherever the walk matches names, not only under `user`.
 * That errs toward redacting a name the consumer has already declared secret.
 *
 * An UNQUOTED numeric segment is an array INDEX, not a field name, and is skipped
 * like a wildcard. `tokens[0]` yields `tokens`, not `0`: the walk matches names,
 * and it never compares array positions — feeding it `0` covered nothing while
 * censoring any object key that happened to be named `0`. Falling back to the
 * nearest name censors the whole `tokens` array, which is broader than the path
 * and in the safe direction. The QUOTED form is left alone: `["0"]` is explicit
 * key syntax, and an object key named `0` IS matched by the walk.
 *
 * @internal NOT re-exported by the package barrel.
 * @param path - A `@pinojs/redact` path, dotted and/or bracketed.
 * @returns The last segment that names a field, or `undefined` for a path with
 *   none (a wildcard- or index-only path).
 * @example
 *   leafNameOf('req.headers["x-api-key"]')  // 'x-api-key'
 *   leafNameOf('*.*.password')              // 'password'
 *   leafNameOf('tokens[0]')                 // 'tokens' — the index is not a name
 *   leafNameOf('blob["social.security"]')   // 'social.security' — one name, dots included
 */
export function leafNameOf(path: string): string | undefined {
  let leaf: string | undefined
  for (const match of allMatches(PATH_SEGMENT, path)) {
    const quoted = match[1]
    const name =
      quoted ??
      (match[2] !== undefined && matchesPattern(INDEX_SEGMENT, match[2]) ? undefined : match[2])
    if (name !== undefined && name !== '*') {
      leaf = name
    }
  }
  return leaf
}

/** Whether the last segment of a path is the wildcard, which names every field. */
function endsInWildcard(path: string): boolean {
  let last: string | undefined
  for (const match of allMatches(PATH_SEGMENT, path)) last = match[1] ?? match[2]
  return last === '*'
}

/** What the configured paths decide about a value that has a `toJSON`. */
export interface PathHold {
  /** Whether the value holds, at any depth, a field the paths name. Never throws. */
  readonly holds: (value: object) => boolean
  /** What is written for a held `Error`: a copy with no `toJSON`. Never throws. */
  readonly standIn: (error: Error) => unknown
}

/** What every copy of one held `Error` and of the errors under it shares. */
interface StandInRules {
  readonly matches: (name: string) => boolean
  readonly safeFields: ReadonlySet<string>
  readonly censor: string
}

/** How many `cause` and `errors` links deep a held `Error` is copied. */
const MAX_LINKS = 8

/** Define a property of a copy as plain data, whatever its prototype has under that name. */
function define(copy: object, name: string, value: unknown, enumerable: boolean): void {
  Object.defineProperty(
    copy,
    name,
    bareDescriptor({ value, enumerable, writable: true, configurable: true })
  )
}

/** Read the `message` or the `stack`, as any writer of an error does; empty when it cannot be. */
function readText(error: Error, key: 'message' | 'stack'): string {
  try {
    const text: unknown = error[key]
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/** The value of an own data property: an accessor is not run. */
function ownValue(source: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(source, key)
  return field !== undefined && Object.hasOwn(field, 'value') ? field.value : undefined
}

/** What a `cause` or a member of `errors` is written as: an object that is no `Error` is not. */
function linked(
  value: unknown,
  rules: StandInRules,
  depth: number,
  seen: Map<Error, object>
): unknown {
  if (isError(value)) {
    return depth > MAX_LINKS ? rules.censor : copyError(value, rules, depth, seen)
  }
  return typeof value === 'object' && value !== null ? rules.censor : value
}

/** Copy the `name`, and the own fields `errorOwnFields: 'safe'` writes that no path names. */
function copyOwnFields(copy: object, error: Error, rules: StandInRules): void {
  const name = ownValue(error, 'name')
  if (typeof name === 'string') define(copy, 'name', name, false)
  for (const key of Object.keys(error)) {
    if (setHas(DERIVED_ERROR_FIELDS, key) || !setHas(rules.safeFields, key)) continue
    if (rules.matches(key)) continue
    const value = ownValue(error, key)
    if (typeof value !== 'object' && typeof value !== 'function') define(copy, key, value, true)
  }
}

/** Copy one `Error` of a held chain; `seen` keeps a cycle a cycle. */
function copyError(
  error: Error,
  rules: StandInRules,
  depth: number,
  seen: Map<Error, object>
): object {
  const known = seen.get(error)
  if (known !== undefined) return known
  const copy = new Error()
  seen.set(error, copy)
  Object.setPrototypeOf(copy, Object.getPrototypeOf(error) as object)
  copyOwnFields(copy, error, rules)
  define(copy, 'message', readText(error, 'message'), false)
  define(copy, 'stack', readText(error, 'stack'), false)
  // Own and not enumerable, so one the prototype has is neither found nor called.
  define(copy, 'toJSON', undefined, false)
  const cause = ownValue(error, 'cause')
  if (cause !== undefined) define(copy, 'cause', linked(cause, rules, depth + 1, seen), false)
  const members = ownValue(error, 'errors')
  if (Array.isArray(members)) {
    const copies = members.map((member: unknown) => linked(member, rules, depth + 1, seen))
    define(copy, 'errors', copies, false)
  }
  return copy
}

/** What the constructor of an `Error` writes, neither of them enumerable. */
const BUILT_ERROR_FIELDS = capturedSet(['message', 'stack'])

/**
 * Whether a property is one the language puts on every value of its kind, so no field of the
 * host: the length of a list, and the `message` and `stack` an `Error` is built with. The same
 * names set as enumerable fields are fields.
 */
function isBuiltIn(holder: object, name: string, field: PropertyDescriptor | undefined): boolean {
  if (field?.enumerable === true) return false
  if (Array.isArray(holder)) return name === 'length'
  return isError(holder) && setHas(BUILT_ERROR_FIELDS, name)
}

/**
 * Search the string-keyed own properties of a value for a field the paths name, running no getter.
 * A getter cannot be read without running it, so it counts as a match, and so does a state that
 * cannot be inspected or holds more than `maxObjects` objects.
 */
function searchState(
  root: object,
  matches: (name: string) => boolean,
  maxObjects: number
): boolean {
  const pending: object[] = [root]
  const seen = new Set<object>()
  let visited = 0
  for (let at = 0; at < pending.length; at++) {
    const next = pending[at] as object
    // The bytes of a binary view are not fields.
    if (setHas(seen, next) || ArrayBuffer.isView(next)) continue
    if (++visited > maxObjects) return true
    setAdd(seen, next)
    for (const name of Object.getOwnPropertyNames(next)) {
      const field = Object.getOwnPropertyDescriptor(next, name)
      if (isBuiltIn(next, name, field)) continue
      if (matches(name) || field?.get !== undefined) return true
      const held: unknown = field?.value
      if (typeof held === 'object' && held !== null) pending.push(held)
    }
  }
  return false
}

/**
 * Build what a set of `redactPaths` decides: a field matches when its name is the last segment of
 * a path, and every field matches when a path ends in `*`.
 *
 * A held `Error` is written from a copy: its type, `message`, `stack`, the own fields of
 * `errorOwnFields: 'safe'` that are not objects and that no path names, and the errors under it,
 * copied the same way to a bounded depth.
 *
 * @param paths - The paths handed to `@pinojs/redact`.
 * @param maxObjects - Objects one search may read before it answers `true`.
 * @param safe - The policy of `errorOwnFields: 'safe'`, with the host's own field names.
 * @param censor - Written for what is not copied.
 * @returns The two decisions. Neither throws.
 */
export function createPathHold(
  paths: readonly string[],
  maxObjects: number,
  safe: OwnFieldPolicy,
  censor: string
): PathHold {
  const anyName = paths.some(endsInWildcard)
  const names = capturedSet(paths.flatMap((path) => leafNameOf(path) ?? []))
  const matches = (name: string): boolean => anyName || setHas(names, name)
  const rules: StandInRules = { matches, safeFields: safe.names, censor }
  return {
    holds: (value: object): boolean => {
      try {
        return searchState(value, matches, maxObjects)
      } catch {
        return true
      }
    },
    standIn: (error: Error): unknown => {
      try {
        return copyError(error, rules, 0, new Map())
      } catch {
        return censor
      }
    }
  }
}
