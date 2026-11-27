/**
 * Redaction of what reaches a line through `child()` and `setBindings()` of the Pino instance.
 *
 * Layer: server/utils. Pino writes bindings into the instance when they are passed: `child()` swaps
 * the `bindings` formatter for one that returns its input unless the options bring another, and
 * `setBindings()` runs whatever formatter the instance holds. The options of a child can also replace
 * the record formatter and the serializers. Both methods are redefined on the instance the factory
 * builds, and every child inherits them through its prototype.
 *
 * Under the `'names'` strategy the objects of the message placeholders are walked too, by
 * {@link guardMessageValues}, which a child with format options of its own needs again.
 */
import type { ChildLoggerOptions, Logger as PinoLogger } from 'pino'

import { bareDescriptor } from './bare-descriptor.util'
import { guardMessageValues } from './guard-message-values.util'
import type { Redactor } from './redact-by-name.util'

const apply = Reflect.apply
const create = Object.create
const defineProperty = Object.defineProperty
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const getPrototypeOf = Object.getPrototypeOf
const hasOwn = Object.hasOwn
const ownKeys = Reflect.ownKeys

/** What the logger of the module redacts and formats with. */
export interface ChildGuard {
  /** The redactor of bindings. */
  readonly redactBindings: Redactor
  /** The redactor that walks by name under every strategy. */
  readonly redactSerialized: Redactor
  /** The record formatter of the module, which redacts the record. */
  readonly formatRecord: (record: Record<string, unknown>) => Record<string, unknown>
}

type Callable = (input: unknown) => unknown
type AnyCallable = (...inputs: unknown[]) => unknown

/** `run` with what the function it wraps returns passed through `then`, keeping `this`. */
function followedBy(run: unknown, then: Callable): unknown {
  if (typeof run !== 'function') return run
  return function (this: unknown, ...inputs: unknown[]): unknown {
    return then(apply(run as AnyCallable, this, inputs))
  }
}

/** What was given, for bindings the module does not walk. */
const asPassed: Redactor = (value: unknown): unknown => value

/**
 * A copy of `source` with some members replaced. The prototype and the other members stay as they
 * are, because Pino reads them from the object it is given, and a frozen source can be copied.
 */
function replacing(source: object, replaced: Readonly<Record<string, unknown>>): object {
  const descriptors = getOwnPropertyDescriptors(source) as Record<PropertyKey, PropertyDescriptor>
  for (const key in replaced) descriptors[key] = { value: replaced[key] }
  // Bare, so that a `get` or a `set` planted on the root is not read as part of a descriptor.
  for (const name of ownKeys(descriptors)) {
    descriptors[name] = bareDescriptor(descriptors[name] as PropertyDescriptor)
  }
  return create(getPrototypeOf(source) as object | null, descriptors) as object
}

/** The formatters of a child's options, with the module's redaction after each of the host's. */
function guardFormatters(formatters: object, guard: ChildGuard): object {
  const { bindings, level, log } = formatters as NonNullable<ChildLoggerOptions['formatters']>
  // With none of its own, which stays so here, the child gets the `bindings` formatter of Pino,
  // which returns its input, and keeps the `log` formatter of its parent, which already redacts.
  // Pino's redact paths never reach what `level` returns, so that is walked by name under every
  // strategy.
  return replacing(formatters, {
    bindings: followedBy(bindings, (output) => guard.redactBindings(output, true)),
    level: followedBy(level, (output) => guard.redactSerialized(output)),
    // A formatter that returns nothing is passed on as it is: Pino writes no fields for it.
    log: followedBy(log, (output) =>
      output ? guard.formatRecord(output as Record<string, unknown>) : output
    )
  })
}

/**
 * The serializers of a child's options, each with its output redacted like a module serializer's.
 * Only string keys are copied: Pino 10 runs no serializer under a symbol.
 */
function guardSerializers(serializers: object, redact: Redactor): object {
  const source = serializers as Record<PropertyKey, unknown>
  const guarded: Record<PropertyKey, unknown> = {}
  for (const key in source) {
    const value = followedBy(source[key], (output) => redact(output))
    defineProperty(guarded, key, bareDescriptor({ value, enumerable: true }))
  }
  return guarded
}

/** The options of a child with the module's redaction composed into what they replace. */
function guardOptions(options: unknown, guard: ChildGuard): unknown {
  if (typeof options !== 'object' || options === null) return options
  const { formatters, serializers } = options as ChildLoggerOptions
  const replaced: Record<string, unknown> = {}
  // Own members only, as Pino reads these two.
  if (hasOwn(options, 'formatters') && formatters) {
    replaced['formatters'] = guardFormatters(formatters, guard)
  }
  if (hasOwn(options, 'serializers') && serializers) {
    replaced['serializers'] = guardSerializers(serializers, guard.redactSerialized)
  }
  return replacing(options, replaced)
}

/**
 * Redefine `child` and `setBindings` on a Pino instance so that bindings are redacted before Pino
 * writes them, and what the options of a child replace is redacted too. Under `'names'`, so are the
 * objects of the message placeholders.
 *
 * @param logger - The Pino instance the factory built.
 * @param redaction - The redaction of the module.
 * @param options - The strategy. Under `'paths'`, bindings are passed on as they are, so the
 *   formatters and serializers of the child options receive the objects the caller passed, and the
 *   message is written as Pino writes it.
 * @returns `logger`.
 * @throws Error `LOGGER_PINO_UNSUPPORTED` under `'names'`, from {@link guardMessageValues}.
 */
export function guardChildBindings(
  logger: PinoLogger,
  redaction: ChildGuard,
  options: { readonly redactStrategy: 'names' | 'paths' }
): PinoLogger {
  const guard =
    options.redactStrategy === 'names' ? redaction : { ...redaction, redactBindings: asPassed }
  const guardChildMessages =
    options.redactStrategy === 'names'
      ? guardMessageValues(logger, redaction.redactSerialized)
      : undefined
  const nativeChild: unknown = logger.child
  const nativeSetBindings: unknown = logger.setBindings
  // Missing bindings are passed on as they are, so Pino answers for them.
  const redacted = (bindings: unknown): unknown =>
    bindings ? guard.redactBindings(bindings, true) : bindings

  const child = function (this: PinoLogger, bindings: unknown, options?: unknown): unknown {
    const built = apply(nativeChild as AnyCallable, this, [
      redacted(bindings),
      guardOptions(options, guard)
    ])
    guardChildMessages?.(built as object)
    return built
  }
  const setBindings = function (this: PinoLogger, bindings: unknown): void {
    apply(nativeSetBindings as Callable, this, [redacted(bindings)])
  }
  const open = { writable: true, configurable: true }
  defineProperty(logger, 'child', bareDescriptor({ ...open, value: child }))
  defineProperty(logger, 'setBindings', bareDescriptor({ ...open, value: setBindings }))
  return logger
}
