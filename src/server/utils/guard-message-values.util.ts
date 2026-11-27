/**
 * Redaction of the objects that Pino writes into the message of an entry.
 *
 * Layer: server/utils. An object reaches `msg` two ways: through a `%o`, `%O` or `%j` placeholder,
 * which Pino serializes with the `stringify` of the format options of the instance, and passed as
 * the message itself, which arrives at the instance's write method still an object. The walk by name
 * is composed into both, so the objects keep their structure and the redact paths of Pino still
 * apply to a placeholder. `%s` and `%d` call neither and print what they printed before.
 *
 * Both members are reached through `pino.symbols`. A Pino that does not have them in the shape this
 * module expects is refused when the logger is built.
 */
import pino from 'pino'
import type { Logger as PinoLogger } from 'pino'

import { bareDescriptor } from './bare-descriptor.util'
import type { Redactor } from './redact-by-name.util'

const apply = Reflect.apply
const get = Reflect.get
const defineProperty = Object.defineProperty
const hasOwn = Object.hasOwn

type AnyCallable = (...inputs: unknown[]) => unknown

const UNSUPPORTED =
  'LOGGER_PINO_UNSUPPORTED: this version of pino does not expose symbols.formatOptsSym and ' +
  "symbols.writeSym as redactStrategy: 'names' needs them to redact the message of an entry"

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

/** `redact` for what can hold a field; a primitive has no name to match. */
function walkedWith(redact: Redactor): (value: unknown) => unknown {
  return (value) =>
    (typeof value === 'object' && value !== null) || typeof value === 'function'
      ? redact(value)
      : value
}

/** Give `target` its own value under `key`, writable so that Pino can still replace it. */
function define(target: object, key: symbol, value: unknown): void {
  const open = { value, writable: true, configurable: true }
  defineProperty(target, key, bareDescriptor(open))
}

/**
 * Compose the walk by name into the placeholders and the message of a Pino instance. Every child of
 * the instance inherits both through its prototype.
 *
 * @param logger - The Pino instance the factory built.
 * @param redact - The redactor that walks by name.
 * @returns What guards a child that Pino gave format options of its own, as it does for the child
 *   options `redact`.
 * @throws Error `LOGGER_PINO_UNSUPPORTED` when Pino does not have the members to compose with.
 */
export function guardMessageValues(logger: PinoLogger, redact: Redactor): (child: object) => void {
  const symbols = get(pino, 'symbols') as Record<string, unknown> | undefined
  const formatOptions = requiredSymbol(symbols?.['formatOptsSym'])
  const writeMethod = requiredSymbol(symbols?.['writeSym'])
  const walked = walkedWith(redact)

  const guardFormat = (instance: object): void => {
    const current = get(instance, formatOptions) as { stringify?: unknown } | undefined
    const stringify = required(current?.stringify)
    define(instance, formatOptions, {
      stringify: (value: unknown): unknown => apply(stringify, undefined, [walked(value)])
    })
  }

  const write = required(get(logger, writeMethod))
  define(
    logger,
    writeMethod,
    function (this: unknown, record: unknown, message: unknown, level: unknown): void {
      apply(write, this, [record, walked(message), level])
    }
  )
  guardFormat(logger)

  return (child: object): void => {
    if (hasOwn(child, formatOptions)) guardFormat(child)
  }
}
