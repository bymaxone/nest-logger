/**
 * What is written for an `Error` the configured `redactPaths` hold and that has its own `toJSON`.
 *
 * Two walks are made and only what both write is kept: the one of the `Error` as
 * `errorOwnFields: 'safe'` writes it, and the one of what its `toJSON` returns. Nothing about
 * either walk is repeated here, so a rule of theirs cannot be missed.
 *
 * Layer: server/utils — pure helpers, no I/O.
 */
import { bareDescriptor } from './bare-descriptor.util'
import { capturedSet, setAdd, setHas } from './captured-builtins.util'
import { isError } from './is-error.util'
import type { RedactRules } from './redact-by-name.util'
import type { PathHold } from './redact-path-state.util'

/** The head and the links of an `Error`, as the walks write them. */
const ERROR_PARTS = capturedSet(['type', 'name', 'message', 'stack', 'cause', 'errors'])

/** Walk one part of a held `Error` under `rules`, `below` levels under it. */
export type PartWalk = (part: unknown, rules: RedactRules, below: number) => unknown

/** The own enumerable keys, without the accessors when only data is to be read. */
export function keysToRead(source: object, dataOnly: boolean | undefined): string[] {
  const keys = Object.keys(source)
  if (dataOnly !== true) return keys
  return keys.filter((key) => Object.getOwnPropertyDescriptor(source, key)?.get === undefined)
}

/**
 * The rules of the walk, made those of `errorOwnFields: 'safe'`. An `Error` is already walked
 * under the rules of its inside, so they hold for everything below it.
 */
function asSafe(rules: RedactRules, hold: PathHold): RedactRules {
  return {
    ...rules,
    ownFields: hold.safeFields,
    pathHold: undefined,
    errorsAsData: true,
    dataOnly: true
  }
}

/** The key of `safe` that answers for `key`: the walks may write the name under `type`. */
function partnerKey(safe: object, key: string): string {
  const isNameAsType = key === 'name' && !Object.prototype.propertyIsEnumerable.call(safe, key)
  return isNameAsType ? 'type' : key
}

/**
 * What two walked forms both write. Equal values are kept; lists and objects are compared member by
 * member, under the keys `written` has; anything that differs is the censor. A key that `safe` does
 * not have is the censor when it names a part or a listed field of an `Error`, and is left out
 * otherwise.
 */
function commonForm(safe: unknown, written: unknown, hold: PathHold, censor: string): unknown {
  if (safe === written) return written
  if (typeof safe !== 'object' || typeof written !== 'object') return censor
  if (safe === null || written === null) return censor
  if (Array.isArray(written)) {
    if (!Array.isArray(safe)) return censor
    return written.map((member: unknown, at) =>
      at < safe.length ? commonForm(safe[at], member, hold, censor) : censor
    )
  }
  if (Array.isArray(safe)) return censor
  const copy = {}
  for (const key of Object.keys(written)) {
    const from = partnerKey(safe, key)
    const shared = Object.prototype.propertyIsEnumerable.call(safe, from)
    if (!shared && !setHas(ERROR_PARTS, key) && !setHas(hold.safeFields.names, key)) continue
    const value = shared
      ? commonForm(Reflect.get(safe, from), Reflect.get(written, key), hold, censor)
      : censor
    Object.defineProperty(
      copy,
      key,
      bareDescriptor({ value, enumerable: true, writable: true, configurable: true })
    )
  }
  return copy
}

/**
 * Write a held `Error`: what both its `'safe'` form and what its `toJSON` returns hold. A `toJSON`
 * that returns no plain object, and anything that cannot be read, is the censor. Never throws.
 *
 * The `'safe'` form is read first, so what `toJSON` does to the `Error` is not part of it.
 *
 * @param error - The held `Error`.
 * @param toJson - Its `toJSON`.
 * @param rules - The rules it is walked under, with the `pathHold` that holds it.
 * @param ancestors - References on the current path, `error` among them.
 * @param walkPart - The walk.
 * @returns What is written.
 */
export function writeHeldError(
  error: Error,
  toJson: () => unknown,
  rules: RedactRules & { readonly pathHold: PathHold },
  ancestors: Set<object>,
  walkPart: PartWalk
): unknown {
  try {
    ancestors.delete(error)
    const safe = walkPart(error, asSafe(rules, rules.pathHold), 0)
    setAdd(ancestors, error)
    const output = toJson.call(error)
    if (Array.isArray(output) || isError(output)) return rules.censor
    return commonForm(safe, walkPart(output, rules, 1), rules.pathHold, rules.censor)
  } catch {
    return rules.censor
  }
}
