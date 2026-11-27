/**
 * Redaction of what reaches a line through `child()` and `setBindings()` of the Pino instance.
 *
 * Layer: server/utils. Pino writes bindings into the instance when they are passed: `child()` swaps
 * the `bindings` formatter for one that returns its input unless the options bring another, and
 * `setBindings()` runs whatever formatter the instance holds. The options of a child can also replace
 * the record formatter and the serializers. Both methods are redefined on the instance the factory
 * builds, and every child inherits them through its prototype.
 */
import type { ChildLoggerOptions, Logger as PinoLogger } from 'pino'

import type { Redactor } from './redact-by-name.util'

const apply = Reflect.apply
const create = Object.create
const defineProperty = Object.defineProperty
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const getPrototypeOf = Object.getPrototypeOf
const hasOwn = Object.hasOwn

/** What the logger of the module redacts and formats with. */
export interface ChildGuard {
  /** The redactor of bindings. */
  readonly redactBindings: Redactor
  /** The redactor of what a serializer returns. */
  readonly redactSerialized: Redactor
  /** The record formatter of the module, which redacts the record. */
  readonly formatRecord: (record: Record<string, unknown>) => Record<string, unknown>
}

type Callable = (input: unknown) => unknown

/** `run` with what the function it wraps returns passed through `then`, keeping `this`. */
function followedBy(run: unknown, then: Callable): unknown {
  if (typeof run !== 'function') return run
  return function (this: unknown, input: unknown): unknown {
    return then(apply(run as Callable, this, [input]))
  }
}

/**
 * A copy of `source` with some members replaced. The prototype and the other members stay as they
 * are, because Pino reads them from the object it is given, and a frozen source can be copied.
 */
function replacing(source: object, replaced: Readonly<Record<string, unknown>>): object {
  const descriptors: PropertyDescriptorMap = getOwnPropertyDescriptors(source)
  for (const key in replaced) {
    descriptors[key] = {
      value: replaced[key],
      enumerable: true,
      writable: true,
      configurable: true
    }
  }
  return create(getPrototypeOf(source) as object | null, descriptors) as object
}

/** The formatters of a child's options, with the module's redaction after each of the host's. */
function guardFormatters(formatters: object, guard: ChildGuard): object {
  const { bindings, log } = formatters as NonNullable<ChildLoggerOptions['formatters']>
  const replaced: Record<string, unknown> = {}
  // With none of its own, the child gets the `bindings` formatter of Pino, which returns its input,
  // and keeps the `log` formatter of its parent, which already redacts.
  if (bindings) {
    replaced['bindings'] = followedBy(bindings, (output) => guard.redactBindings(output, true))
  }
  if (log) {
    replaced['log'] = followedBy(log, (output) =>
      guard.formatRecord(output as Record<string, unknown>)
    )
  }
  return replacing(formatters, replaced)
}

/**
 * The serializers of a child's options, each with its output redacted like a module serializer's.
 * Every enumerable key is read, as Pino does.
 */
function guardSerializers(serializers: object, redact: Redactor): object {
  const source = serializers as Record<PropertyKey, unknown>
  const guarded: Record<PropertyKey, unknown> = {}
  for (const key in source) {
    defineProperty(guarded, key, {
      value: followedBy(source[key], (output) => redact(output)),
      enumerable: true
    })
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
 * writes them, and what the options of a child replace is redacted too.
 *
 * @param logger - The Pino instance the factory built.
 * @param guard - The redaction of the module.
 * @returns `logger`.
 */
export function guardChildBindings(logger: PinoLogger, guard: ChildGuard): PinoLogger {
  const nativeChild: unknown = logger.child
  const nativeSetBindings: unknown = logger.setBindings
  // Missing bindings are passed on as they are, so Pino answers for them.
  const redacted = (bindings: unknown): unknown =>
    bindings ? guard.redactBindings(bindings, true) : bindings

  defineProperty(logger, 'child', {
    value: function (this: PinoLogger, bindings: unknown, options?: unknown): unknown {
      return apply(nativeChild as Callable, this, [
        redacted(bindings),
        guardOptions(options, guard)
      ])
    },
    writable: true,
    configurable: true
  })
  defineProperty(logger, 'setBindings', {
    value: function (this: PinoLogger, bindings: unknown): void {
      apply(nativeSetBindings as Callable, this, [redacted(bindings)])
    },
    writable: true,
    configurable: true
  })
  return logger
}
