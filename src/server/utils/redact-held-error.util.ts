/**
 * What is written for an `Error` the configured `redactPaths` hold and that has its own `toJSON`.
 *
 * Two walks are made and only what both write is kept, but for a name {@link noteUnread} lets the
 * comparison add: the one of the `Error` as
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
    // Stryker disable next-line BooleanLiteral: these ownFields are safe, which writes an Error as data whatever this is
    errorsAsData: true,
    dataOnly: true
  }
}

/** What was written of an unread `Error`'s `toJSON`: under a serialized key it may take a name. */
const unreadOutputs = new WeakSet<object>()

/**
 * The rules below a part added to an `Error`. Under the output of a held one, what is there is
 * unread: had that `Error` stayed an instance, no `toJSON` below the part would have run.
 *
 * @param rules - The rules of the `Error`.
 * @returns The rules the part is walked with.
 */
export function unreadBelow(rules: RedactRules): RedactRules {
  return rules.link === undefined ? rules : { ...rules, unread: true }
}

/**
 * Note what was written of an unread `Error` that has a `toJSON`.
 *
 * @param walked - What is written.
 * @param rules - The rules the object with the `toJSON` was reached under.
 * @param value - That object.
 * @returns `walked`.
 */
export function noteUnread(walked: unknown, rules: RedactRules, value: object): unknown {
  if (rules.unread && isError(value) && typeof walked === 'object' && walked !== null) {
    unreadOutputs.add(walked)
  }
  return walked
}

/** How two walked forms are compared. */
interface Comparison {
  readonly hold: PathHold
  readonly censor: string
  /** The held `Error` is under a serialized key, whose serializer reads an error by its `name`. */
  readonly serialized: boolean
}

const isWritten = (form: object, key: string): boolean =>
  Object.prototype.propertyIsEnumerable.call(form, key)

function writeOwn(copy: object, key: string, value: unknown): void {
  Object.defineProperty(
    copy,
    key,
    bareDescriptor({ value, enumerable: true, writable: true, configurable: true })
  )
}

/** The key of `safe` that answers for `key`: the walks may write the name under `type`. */
function partnerKey(safe: object, key: string): string {
  const isNameAsType = key === 'name' && !isWritten(safe, key)
  return isNameAsType ? 'type' : key
}

/**
 * What two walked forms both write. Equal values are kept; lists and objects are compared member by
 * member, under the keys `written` has; anything that differs is the censor. A key that `safe` does
 * not have is the censor when it names a part or a listed field of an `Error`, and is left out
 * otherwise.
 *
 * Under a serialized key, what an unread `Error`'s `toJSON` wrote with a `message` and no `name`
 * takes the `name` of `safe`: without one the serializer writes neither.
 */
function commonForm(safe: unknown, written: unknown, how: Comparison): unknown {
  const { hold, censor } = how
  if (safe === written) return written
  if (typeof safe !== 'object' || typeof written !== 'object') return censor
  if (safe === null || written === null) return censor
  if (Array.isArray(written)) {
    if (!Array.isArray(safe)) return censor
    return written.map((member: unknown, at) =>
      at < safe.length ? commonForm(safe[at], member, how) : censor
    )
  }
  if (Array.isArray(safe)) return censor
  const copy = {}
  for (const key of Object.keys(written)) {
    const from = partnerKey(safe, key)
    const shared = isWritten(safe, from)
    if (!shared && !setHas(ERROR_PARTS, key) && !setHas(hold.safeFields.names, key)) continue
    const value = shared
      ? commonForm(Reflect.get(safe, from), Reflect.get(written, key), how)
      : censor
    writeOwn(copy, key, value)
  }
  const unnamed = how.serialized && unreadOutputs.has(written) && !isWritten(written, 'name')
  if (unnamed && isWritten(written, 'message') && isWritten(safe, 'name')) {
    writeOwn(copy, 'name', Reflect.get(safe, 'name'))
  }
  return copy
}

/**
 * Write a held `Error`: what both its `'safe'` form and what its `toJSON` returns hold. A `toJSON`
 * that returns no plain object, and anything that cannot be read, is the censor. Never throws.
 *
 * The `'safe'` form is read first, so what `toJSON` does to the `Error` is not part of it. An
 * `Error` in the output's `cause` or `errors`, or in those of an `Error` so written or of an object
 * a `toJSON` among them returns, is written as data under a serialized key too: an instance keeps
 * its head and links where the comparison does not read them. An object below those that is no
 * `Error` does not end this.
 *
 * @param error - The held `Error`.
 * @param toJson - Its `toJSON`.
 * @param rules - The rules it is walked under, with the `pathHold` that holds it.
 * @param ancestors - References on the current path, `error` among them.
 * @param walkPart - The walk.
 * @param serialized - Whether `error` is under a serialized key.
 * @returns What is written.
 */
export function writeHeldError(
  error: Error,
  toJson: () => unknown,
  rules: RedactRules & { readonly pathHold: PathHold },
  ancestors: Set<object>,
  walkPart: PartWalk,
  serialized: boolean
): unknown {
  try {
    ancestors.delete(error)
    const safe = walkPart(error, asSafe(rules, rules.pathHold), 0)
    setAdd(ancestors, error)
    const output = toJson.call(error)
    if (Array.isArray(output) || isError(output)) return rules.censor
    const written = walkPart(output, { ...rules, link: 'output' }, 1)
    const how = { hold: rules.pathHold, censor: rules.censor, serialized }
    return noteUnread(commonForm(safe, written, how), rules, error)
  } catch {
    return rules.censor
  }
}
