/**
 * Redaction of the objects that Pino writes into the message of an entry.
 *
 * Layer: server/utils. An object reaches `msg` two ways. Through a `%o`, `%O` or `%j` placeholder,
 * which Pino serializes with the `stringify` of the format options of the instance. And as the whole
 * message, passed as such or taken by Pino from `err.message`, which it hands to the serializer
 * registered under `msg`. The walk by name is composed into both, so the redact paths of Pino still
 * apply to a placeholder. `%s` and `%d` print what Pino prints. Under `'paths'` the walk is applied
 * only where {@link needsTheWalk} says so, for the binary values Pino would write or cannot copy.
 *
 * The format options are reached through `pino.symbols`. A Pino that does not have them in the shape
 * this module expects is refused when the logger is built.
 */
import pino from 'pino'
import type { Logger as PinoLogger } from 'pino'

import { bareDescriptor } from './bare-descriptor.util'
import { needsTheWalk } from './binary-values.util'
import type { MessageRedactor } from './redact-by-name.util'

const apply = Reflect.apply
const get = Reflect.get
const defineProperty = Object.defineProperty
const hasOwn = Object.hasOwn

type AnyCallable = (...inputs: unknown[]) => unknown

const UNSUPPORTED =
  'LOGGER_PINO_UNSUPPORTED: this version of pino does not expose symbols.formatOptsSym as ' +
  'the logger needs to redact the message of an entry'

/** The function under `value`, or a refusal when it is not one. */
function required(value: unknown): AnyCallable {
  if (typeof value !== 'function') throw new Error(UNSUPPORTED)
  return value as AnyCallable
}

/** The symbol under `value`, or a refusal when it is not one. */
function requiredSymbol(value: unknown): symbol {
  if (typeof value !== 'symbol') throw new Error(UNSUPPORTED)
  return value
}

/**
 * `redact` for what can hold a field; a primitive has no name to match. An `Error` is given no
 * text that Pino would not write for it.
 */
function walkedWith(redact: MessageRedactor): (value: unknown) => unknown {
  return (value) =>
    (typeof value === 'object' && value !== null) || typeof value === 'function'
      ? redact(value, false, true)
      : value
}

/** A message the walk leaves nothing of: Pino writes no `msg` for a function. */
const NO_MESSAGE: unknown = Function.prototype

/** `walk` as a serializer of `msg`: Pino would write an `undefined` from it into the line as is. */
function writable(walk: (message: unknown) => unknown): (message: unknown) => unknown {
  return (message) => {
    const written = walk(message)
    return written === undefined ? NO_MESSAGE : written
  }
}

/**
 * The redaction of what a `msg` serializer of the host or of a child returns.
 *
 * @param strategy - The redaction strategy of the module.
 * @param redact - The redactor that walks by name.
 * @returns What takes the output of the serializer to what Pino writes as the message. Under
 *   `'paths'`, `redact` as it is.
 */
export function redactMessageOutput(
  strategy: 'names' | 'paths',
  redact: MessageRedactor
): (output: unknown) => unknown {
  if (strategy === 'paths') return (output) => redact(output)
  return writable((output) => redact(output, false, true))
}

/** What takes a message, or the object of a placeholder, to what Pino is given under `strategy`. */
function messageWalk(
  strategy: 'names' | 'paths',
  redact: MessageRedactor
): (value: unknown) => unknown {
  const walked = walkedWith(redact)
  if (strategy === 'names') return walked
  return (value) => (needsTheWalk(value) ? walked(value) : value)
}

/**
 * The serializer of `msg`. A serializer of the host or of a child under the same key replaces it,
 * and has what it returns redacted by {@link redactMessageOutput}.
 *
 * @param strategy - The redaction strategy of the module.
 * @param redact - The redactor that walks by name.
 * @param redactRecord - The redactor of the record under `strategy`, which under `'paths'` walks what
 *   {@link needsTheWalk} says.
 * @returns The entry to spread into the serializers of Pino.
 */
export function messageSerializers(
  strategy: 'names' | 'paths',
  redact: MessageRedactor,
  redactRecord: MessageRedactor
): { msg: (message: unknown) => unknown } {
  return { msg: writable(messageWalk(strategy, strategy === 'names' ? redact : redactRecord)) }
}

/** Give `target` its own value under `key`, writable so that Pino can still replace it. */
function define(target: object, key: symbol, value: unknown): void {
  const open = { value, writable: true, configurable: true }
  defineProperty(target, key, bareDescriptor(open))
}

/**
 * Compose the walk of {@link messageSerializers} into the placeholders of a Pino instance. Every
 * child of the instance inherits it through its prototype.
 *
 * @param logger - The Pino instance the factory built.
 * @param redact - The redactor that walks by name under `'names'`, that of the record under
 *   `'paths'`.
 * @param strategy - The redaction strategy of the module.
 * @returns What guards a child that Pino gave format options of its own, as it does for the child
 *   options `redact`.
 * @throws Error `LOGGER_PINO_UNSUPPORTED` when Pino does not have the members to compose with.
 */
export function guardMessageValues(
  logger: PinoLogger,
  redact: MessageRedactor,
  strategy: 'names' | 'paths'
): (child: object) => void {
  const symbols = get(pino, 'symbols') as Record<string, unknown> | undefined
  const formatOptions = requiredSymbol(symbols?.['formatOptsSym'])
  const walked = messageWalk(strategy, redact)

  const guardFormat = (instance: object): void => {
    const current = get(instance, formatOptions) as { stringify?: unknown } | undefined
    const stringify = required(current?.stringify)
    define(instance, formatOptions, {
      stringify: (value: unknown): unknown => apply(stringify, undefined, [walked(value)])
    })
  }
  guardFormat(logger)

  return (child: object): void => {
    if (hasOwn(child, formatOptions)) guardFormat(child)
  }
}
