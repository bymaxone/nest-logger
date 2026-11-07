/**
 * The parts the redaction walk adds to an `Error` it writes as data, and the helpers they share.
 *
 * Layer: server/utils. `redact-by-name.util.ts` walks a record. This module decides what an
 * `Error` node gains (`type`, `message`, `stack`, `cause`, `errors`), how deep a chain of them
 * goes, and how an own field of an `Error` is read. It does not import the walk: the walk hands
 * over what it needs as an {@link ErrorPartsHost}.
 */
import { cutText } from './bounded-text.util'
import { withBinaryAsSize } from './own-field-policy.util'
import {
  createDepthMarker,
  createWidthMarker,
  DEFAULT_MAX_CAUSE_DEPTH,
  MAX_AGGREGATE_ERRORS,
  scrubStack
} from './sanitize-error.util'

/** What the walk gives the code that writes the parts of an `Error`. */
export interface ErrorPartsHost {
  /** Lower-cased field names whose values are censored. */
  readonly sensitive: ReadonlySet<string>
  /** Replacement written in place of a sensitive value. */
  readonly censor: string
  /** The key the error's name is written under: `type` in an entry, `name` for a serializer. */
  readonly nameKey: 'name' | 'type'
  /** Walk a value one container deeper than `depth`, under the walk's own bounds. */
  walk(value: unknown, depth: number): unknown
  /** Whether a value has a `toJSON` the walk would honour. */
  hasToJson(value: object): boolean
}

/**
 * Write a key onto a copy without triggering a setter.
 *
 * `Reflect.defineProperty` rather than assignment: a key named `__proto__`
 * reaching an ordinary assignment would walk the prototype chain to
 * `Object.prototype`'s accessor and repoint the copy's prototype instead of
 * storing a property. Defining the property keeps a hostile key inert AND keeps
 * the dynamic write off the `security/detect-object-injection` sink list.
 *
 * @param target - The copy being built.
 * @param key - The property name.
 * @param value - The value to store.
 */
export function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // Only `enumerable` is specified. `writable` / `configurable` would default to
  // `false`, and nothing here can tell the difference: `Object.keys` yields each
  // key once so a copy never redefines one, and the copy is serialized and
  // discarded without further mutation (verified against Pino's `redact`, which
  // tolerates a non-writable property on the record it censors). Stating them
  // would be two more literals no test could ever pin.
  //
  // The write cannot fail, and that is established at CONSTRUCTION rather than
  // checked here. Every target is either a fresh `{}` or an error clone whose
  // descriptors `cloneError` relaxes precisely so a censor always lands.
  // `Reflect.defineProperty` reports failure by returning `false`, not by throwing, so a check
  // of the result would be a branch no input can take: untested code claiming a guarantee.
  Reflect.defineProperty(target, key, { value, enumerable: true })
}

/** An own field as the walk reads it: a binary value of an `Error` is read as its size. */
export function readOwnField(source: object, key: string): unknown {
  const field: unknown = Reflect.get(source, key)
  return source instanceof Error ? withBinaryAsSize(field) : field
}

/** The chain level of an `Error` while it is walked as a `cause` or `errors` link. */
const linkDepths = new WeakMap<object, number>()

/** The own fields of an `Error` that hold text the logger copies and bounds like a message. */
export const ERROR_TEXT_FIELDS: ReadonlySet<string> = new Set(['name', 'message', 'stack'])

/** The marker key of a node that lost a part while it was being written. */
const INCOMPLETE_KEY = '_errorFieldsIncomplete'

/** The first `MAX_AGGREGATE_ERRORS` members of `errors` and one marker for the rest. */
function capErrors(errors: unknown, host: ErrorPartsHost): unknown {
  if (!Array.isArray(errors) || errors.length <= MAX_AGGREGATE_ERRORS) return errors
  // A list with a `toJSON` is left to that method.
  if (host.hasToJson(errors)) return errors
  const kept: unknown[] = []
  for (let index = 0; index < MAX_AGGREGATE_ERRORS; index++) kept.push(Reflect.get(errors, index))
  kept.push(createWidthMarker(errors.length - MAX_AGGREGATE_ERRORS))
  return kept
}

/** The objects a `cause` or `errors` holds, read by index. */
function linkTargets(value: unknown): object[] {
  const targets: object[] = []
  const take = (link: unknown): void => {
    if (typeof link === 'object' && link !== null) targets.push(link)
  }
  if (!Array.isArray(value)) take(value)
  else for (let index = 0; index < value.length; index++) take(Reflect.get(value, index))
  return targets
}

/** Walk an added `cause` or `errors`: its `Error`s are links one level deeper; past the budget, a marker. */
function walkChainPart(
  value: unknown,
  level: number,
  host: ErrorPartsHost,
  depth: number
): unknown {
  const targets = linkTargets(value)
  if (targets.length > 0 && level + 1 > DEFAULT_MAX_CAUSE_DEPTH) return createDepthMarker()
  const before = new Map(targets.map((target) => [target, linkDepths.get(target)]))
  for (const target of targets) linkDepths.set(target, level + 1)
  try {
    return host.walk(value, depth + 1)
  } finally {
    before.forEach((earlier, target) => {
      if (earlier === undefined) linkDepths.delete(target)
      else linkDepths.set(target, earlier)
    })
  }
}

/** Write an added `type` or `message`: a string is cut at the text limit, anything else is walked as a chain part. */
function cutOrWalk(value: unknown, level: number, host: ErrorPartsHost, depth: number): unknown {
  return typeof value === 'string' ? cutText(value) : walkChainPart(value, level, host, depth)
}

/**
 * Add the non-enumerable `type`, `message`, `stack`, `cause` and `errors`, each only where the copy
 * has no such key and each read and walked alone: a part that cannot be costs only itself.
 * A part's `covers` names every field whose text it carries, its own included: covering any of
 * them covers the part. `type` is the `name`; the first line of `stack` is the `name` and the
 * `message`.
 */
export function addErrorParts(
  copy: Record<string, unknown>,
  error: Error,
  ownKeys: readonly string[],
  host: ErrorPartsHost,
  depth: number
): void {
  const taken = new Set(ownKeys)
  const level = linkDepths.get(error) ?? 0
  let incomplete = false
  const add = (
    key: string,
    covers: readonly string[],
    read: () => unknown,
    write = (value: unknown): unknown => walkChainPart(value, level, host, depth)
  ): void => {
    if (taken.has(key)) return
    try {
      const written = write(read())
      if (written === undefined) return
      const covered = covers.some((name) => host.sensitive.has(name))
      defineOwn(copy, key, covered ? host.censor : written)
    } catch {
      incomplete = true
    }
  }
  add(
    host.nameKey,
    [host.nameKey, 'name'],
    () => error.name,
    (name) => cutOrWalk(name, level, host, depth)
  )
  add(
    'message',
    ['message'],
    () => error.message,
    (message) => cutOrWalk(message, level, host, depth)
  )
  add(
    'stack',
    ['stack', 'name', 'message'],
    (): unknown => error.stack,
    (stack) => (typeof stack === 'string' ? scrubStack(stack) : undefined)
  )
  add('cause', ['cause'], (): unknown => error.cause)
  add('errors', ['errors'], (): unknown => capErrors((error as { errors?: unknown }).errors, host))
  if (incomplete && !taken.has(INCOMPLETE_KEY)) defineOwn(copy, INCOMPLETE_KEY, true)
}
