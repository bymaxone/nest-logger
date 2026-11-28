/**
 * What the configured `redactPaths` can reach in a value that decides its own serialized form.
 *
 * `@pinojs/redact` matches a path against the fields of a value, and the record walk calls
 * `toJSON` before Pino sees them, so the walk has to answer for what the paths name.
 *
 * Layer: server/utils — pure helpers, no I/O.
 */
import { allMatches, capturedSet, matchesPattern, setAdd, setHas } from './captured-builtins.util'
import { isError } from './is-error.util'
import type { OwnFieldPolicy } from './own-field-policy.util'

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

/** The work the searches of one walk have done, shared by them. */
export interface SearchSpent {
  searched: number
}

/** What the configured paths decide about a value that has a `toJSON`. */
export interface PathHold {
  /** Whether the value holds, at any depth, a field the paths name. Never throws. */
  readonly holds: (value: object, spent: SearchSpent) => boolean
  /** The own fields `errorOwnFields: 'safe'` writes, which bound what a held `Error` writes. */
  readonly safeFields: OwnFieldPolicy
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
    // A list longer than the work left is not listed, so its members spend none.
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
 * @param paths - The paths handed to `@pinojs/redact`.
 * @param maxWork - Objects and properties the searches of one walk may read before they
 *   answer `true`.
 * @param safeFields - The policy of `errorOwnFields: 'safe'`, with the host's own field names.
 * @returns The decision, which does not throw, and the policy.
 */
export function createPathHold(
  paths: readonly string[],
  maxWork: number,
  safeFields: OwnFieldPolicy
): PathHold {
  const anyName = paths.some(endsInWildcard)
  // A path with no name of its own adds `undefined`, which no field is called.
  const names = capturedSet(paths.map(leafNameOf))
  const isNamed = (name: string): boolean => setHas(names, name)
  const search: Search = { matches: (name) => anyName || isNamed(name), isNamed, maxWork }
  return {
    safeFields,
    holds: (value, spent): boolean => {
      try {
        return searchState(value, search, spent)
      } catch {
        return true
      }
    }
  }
}
