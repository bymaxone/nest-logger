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
import { MAX_AGGREGATE_ERRORS, OMIT_OWN_FIELD, ownFieldForLog } from './sanitize-error.util'

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

/** The work the searches of one log call have done, shared by them. */
export interface SearchSpent {
  searched: number
}

/** What the configured paths decide about a value that has a `toJSON`. */
export interface PathHold {
  /** Whether the value holds, at any depth, a field the paths name. Never throws. */
  readonly holds: (value: object, spent: SearchSpent) => boolean
  /** What is written for a held `Error`. Never throws. */
  readonly standIn: (error: Error, toJson: () => unknown, spent: SearchSpent) => unknown
}

/** What every part of one held `Error` shares. */
interface StandIn {
  readonly policy: OwnFieldPolicy
  readonly censor: string
  readonly maxWork: number
  readonly spent: SearchSpent
  /** What each `Error` already met is written as, so a cycle stays a cycle. */
  readonly seen: Map<Error, unknown>
}

/** How many `cause` and `errors` links deep a held `Error` is written. */
const MAX_LINKS = 8

/** The keys `errorOwnFields: 'safe'` reads from an `Error` without a list of the host. */
const DERIVED_KEYS = capturedSet(['type', 'name', 'message', 'stack'])

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

/** What `errorOwnFields: 'safe'` reads from an `Error` under one key. */
function safeReading(error: Error, key: string): unknown {
  if (key === 'message' || key === 'stack') return readText(error, key)
  // The `err` serializer writes the name as the type.
  if (key === 'name' || key === 'type') return error.name
  return Object.prototype.propertyIsEnumerable.call(error, key) ? ownValue(error, key) : undefined
}

/** Whether `errorOwnFields: 'safe'` writes a field of this name for this `Error`. */
function isSafeKey(error: Error, key: string, value: unknown, policy: OwnFieldPolicy): boolean {
  if (setHas(DERIVED_KEYS, key)) return true
  if (setHas(DERIVED_ERROR_FIELDS, key) || !setHas(policy.names, key)) return false
  return ownFieldForLog(error, key, value, policy) !== OMIT_OWN_FIELD
}

/** What a `cause` or a member of `errors` that is an `Error` is written as, under the same rules. */
function linked(error: Error, rules: StandIn, depth: number): unknown {
  if (rules.seen.has(error)) return rules.seen.get(error)
  if (depth > MAX_LINKS || ++rules.spent.searched > rules.maxWork) return rules.censor
  const toJson: unknown = (error as { toJSON?: unknown }).toJSON
  return typeof toJson === 'function'
    ? fromToJson(error, toJson as () => unknown, rules, depth)
    : copyError(error, rules, depth)
}

/** Copy the `name` and the own fields `errorOwnFields: 'safe'` writes that are not objects. */
function copyOwnFields(copy: object, error: Error, policy: OwnFieldPolicy): void {
  const name = ownValue(error, 'name')
  if (typeof name === 'string') define(copy, 'name', name, false)
  for (const key of Object.keys(error)) {
    const value = ownValue(error, key)
    if (typeof value === 'object' || typeof value === 'function') continue
    if (!setHas(DERIVED_KEYS, key) && isSafeKey(error, key, value, policy)) {
      define(copy, key, value, true)
    }
  }
}

/**
 * The `errors` of a held chain: the first members, each followed when it is an `Error` that is one
 * of the original's own and censored otherwise, and one censor for all past those.
 */
function linkedMembers(
  members: unknown[],
  originals: unknown,
  rules: StandIn,
  depth: number
): unknown[] {
  const written = members
    .slice(0, MAX_AGGREGATE_ERRORS)
    .map((member: unknown) =>
      isError(member) && Array.isArray(originals) && originals.includes(member)
        ? linked(member, rules, depth)
        : rules.censor
    )
  return members.length > MAX_AGGREGATE_ERRORS ? [...written, rules.censor] : written
}

/**
 * Write the `cause` and `errors` that `source` holds as `Error`s onto `copy`. One that `original`
 * does not have itself is the censor.
 */
function copyLinks(
  copy: object,
  source: object,
  original: Error,
  rules: StandIn,
  depth: number,
  enumerable: boolean
): void {
  const cause = ownValue(source, 'cause')
  if (isError(cause)) {
    const own = cause === ownValue(original, 'cause')
    define(copy, 'cause', own ? linked(cause, rules, depth + 1) : rules.censor, enumerable)
  }
  const members = ownValue(source, 'errors')
  if (Array.isArray(members) && members.some(isError)) {
    const originals = ownValue(original, 'errors')
    define(copy, 'errors', linkedMembers(members, originals, rules, depth + 1), enumerable)
  }
}

/** The safe form of an `Error` under a held one that has no `toJSON` of its own. */
function copyError(error: Error, rules: StandIn, depth: number): object {
  const copy = new Error()
  rules.seen.set(error, copy)
  Object.setPrototypeOf(copy, Object.getPrototypeOf(error) as object)
  copyOwnFields(copy, error, rules.policy)
  define(copy, 'message', readText(error, 'message'), false)
  define(copy, 'stack', readText(error, 'stack'), false)
  // Own and not enumerable, so one the prototype has is neither found nor called.
  define(copy, 'toJSON', undefined, false)
  copyLinks(copy, error, error, rules, depth, false)
  return copy
}

/**
 * Of what an `Error`'s own `toJSON` returns, what `errorOwnFields: 'safe'` would write. A safe
 * key is written when its value is the one the `Error` itself has, and as the censor when it is
 * another, so a renamed or derived value is not written. An object under such a key and every
 * other key are left out; `cause` and `errors` are followed where they are the `Error`s this one
 * has.
 */
function fromToJson(error: Error, toJson: () => unknown, rules: StandIn, depth: number): unknown {
  // Until the output is read, an `Error` that returns itself or leads back is the censor.
  rules.seen.set(error, rules.censor)
  const output = toJson.call(error)
  // An `Error` it returns is not read: nothing says its fields are those of this one.
  if (typeof output !== 'object' || output === null) return rules.censor
  if (isError(output) || Array.isArray(output)) return rules.censor
  const copy = {}
  rules.seen.set(error, copy)
  for (const key of Object.keys(output)) {
    if (++rules.spent.searched > rules.maxWork) return rules.censor
    const value = ownValue(output, key)
    if (typeof value === 'object' && value !== null) continue
    if (typeof value === 'function' || !isSafeKey(error, key, value, rules.policy)) continue
    define(copy, key, value === safeReading(error, key) ? value : rules.censor, true)
  }
  copyLinks(copy, output, error, rules, depth, true)
  return copy
}

/** What the constructor of an `Error` writes, neither of them enumerable. */
const BUILT_ERROR_FIELDS = capturedSet(['message', 'stack'])

/** What the language puts on a function. */
const BUILT_FUNCTION_FIELDS = capturedSet(['length', 'name', 'prototype'])

/**
 * Whether a property is one the language puts on every value of its kind, so no field of the
 * host: the length of a list, what every function has, and the `message` and `stack` an `Error`
 * is built with. The same names set as enumerable fields are fields.
 */
function isBuiltIn(holder: object, name: string, field: PropertyDescriptor | undefined): boolean {
  if (field?.enumerable === true) return false
  if (Array.isArray(holder)) return name === 'length'
  if (typeof holder === 'function') return setHas(BUILT_FUNCTION_FIELDS, name)
  return isError(holder) && setHas(BUILT_ERROR_FIELDS, name)
}

/** What a search looks for, and how much it may do. */
interface Search {
  readonly matches: (name: string) => boolean
  /** The names the paths end in, without the wildcard. */
  readonly isNamed: (name: string) => boolean
  readonly maxWork: number
}

/**
 * Search the string-keyed own properties of a value for a field the paths name, running no getter.
 * A getter cannot be read without running it, so it counts as a match, and so does a state that
 * cannot be inspected or that takes more work than the call has left. Each object and each
 * property read is one unit of work.
 */
function searchState(root: object, search: Search, spent: SearchSpent): boolean {
  const pending: object[] = [root]
  const seen = new Set<object>()
  for (let at = 0; at < pending.length; at++) {
    const next = pending[at] as object
    // The bytes of a binary view are not fields.
    if (setHas(seen, next) || ArrayBuffer.isView(next)) continue
    if (++spent.searched > search.maxWork) return true
    setAdd(seen, next)
    // A list longer than the work left is not listed at all, and spends none of it.
    if (Array.isArray(next) && next.length > search.maxWork - spent.searched) return true
    const names = Object.getOwnPropertyNames(next)
    spent.searched += names.length
    if (spent.searched > search.maxWork) return true
    for (const name of names) {
      const field = Object.getOwnPropertyDescriptor(next, name)
      if (isBuiltIn(next, name, field)) {
        if (isError(next) && search.isNamed(name)) return true
        continue
      }
      if (search.matches(name) || field?.get !== undefined) return true
      const held: unknown = field?.value
      const kind = typeof held
      if (kind === 'function' || (kind === 'object' && held !== null)) pending.push(held as object)
    }
  }
  return false
}

/**
 * Build what a set of `redactPaths` decides: a field matches when its name is the last segment of
 * a path, and every field matches when a path ends in `*`. The `message` and `stack` an `Error` is
 * built with match by name only.
 *
 * A held `Error` is written from what its own `toJSON` returns, cut to what `errorOwnFields:
 * 'safe'` would write for it (see `fromToJson`), so never more than either would.
 *
 * @param paths - The paths handed to `@pinojs/redact`.
 * @param maxWork - Objects and properties the searches of one log call may read before they
 *   answer `true`.
 * @param safe - The policy of `errorOwnFields: 'safe'`, with the host's own field names.
 * @param censor - Written for what is not.
 * @returns The two decisions. Neither throws.
 */
export function createPathHold(
  paths: readonly string[],
  maxWork: number,
  safe: OwnFieldPolicy,
  censor: string
): PathHold {
  const anyName = paths.some(endsInWildcard)
  const names = capturedSet(paths.flatMap((path) => leafNameOf(path) ?? []))
  const isNamed = (name: string): boolean => setHas(names, name)
  const search: Search = { matches: (name) => anyName || isNamed(name), isNamed, maxWork }
  return {
    holds: (value, spent): boolean => {
      try {
        return searchState(value, search, spent)
      } catch {
        return true
      }
    },
    standIn: (error, toJson, spent): unknown => {
      try {
        const rules = { policy: safe, censor, maxWork, spent, seen: new Map<Error, unknown>() }
        return fromToJson(error, toJson, rules, 0)
      } catch {
        return censor
      }
    }
  }
}
