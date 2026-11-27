/**
 * Redaction of the objects that Pino writes into the message of an entry.
 *
 * Layer: server/utils. An object reaches `msg` two ways. Through a `%o`, `%O` or `%j` placeholder,
 * which Pino serializes with the `stringify` of the format options of the instance. And as the whole
 * message, passed as such or taken by Pino from `err.message`, which it hands to the serializer
 * registered under `msg`. The walk by name is composed into both, so the redact paths of Pino still
 * apply to a placeholder. `%s` and `%d` print what they printed before.
 *
 * The format options are reached through `pino.symbols`. A Pino that does not have them in the shape
 * this module expects is refused when the logger is built.
 */
import pino from 'pino'
import type { Logger as PinoLogger } from 'pino'

import { bareDescriptor } from './bare-descriptor.util'
import type { MessageRedactor } from './redact-by-name.util'

const apply = Reflect.apply
const get = Reflect.get
const defineProperty = Object.defineProperty
const hasOwn = Object.hasOwn

type AnyCallable = (...inputs: unknown[]) => unknown

const UNSUPPORTED =
  'LOGGER_PINO_UNSUPPORTED: this version of pino does not expose symbols.formatOptsSym as ' +
  "redactStrategy: 'names' needs it to redact the message of an entry"

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

/** {@link walkedWith} as a serializer, whose `undefined` Pino would write into the line as is. */
function serializerOf(redact: MessageRedactor): (message: unknown) => unknown {
  const walked = walkedWith(redact)
  return (message) => {
    const written = walked(message)
    return written === undefined ? NO_MESSAGE : written
  }
}

/**
 * The serializer of `msg` under `'names'`, none under `'paths'`. A serializer of the host or of a
 * child under the same key replaces it, and has what it returns redacted like any other.
 *
 * @param strategy - The redaction strategy of the module.
 * @param redact - The redactor that walks by name.
 * @returns The entry to spread into the serializers of Pino.
 */
export function messageSerializers(
  strategy: 'names' | 'paths',
  redact: MessageRedactor
): { msg?: (message: unknown) => unknown } {
  return strategy === 'names' ? { msg: serializerOf(redact) } : {}
}

/** Give `target` its own value under `key`, writable so that Pino can still replace it. */
function define(target: object, key: symbol, value: unknown): void {
  const open = { value, writable: true, configurable: true }
  defineProperty(target, key, bareDescriptor(open))
}

/**
 * Compose the walk by name into the placeholders of a Pino instance. Every child of the instance
 * inherits it through its prototype.
 *
 * @param logger - The Pino instance the factory built.
 * @param redact - The redactor that walks by name.
 * @returns What guards a child that Pino gave format options of its own, as it does for the child
 *   options `redact`.
 * @throws Error `LOGGER_PINO_UNSUPPORTED` when Pino does not have the members to compose with.
 */
export function guardMessageValues(
  logger: PinoLogger,
  redact: MessageRedactor
): (child: object) => void {
  const symbols = get(pino, 'symbols') as Record<string, unknown> | undefined
  const formatOptions = requiredSymbol(symbols?.['formatOptsSym'])
  const walked = walkedWith(redact)

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
