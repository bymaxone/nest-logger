/**
 * Structured failure reporting for log destinations, written to `process.stderr`.
 *
 * Layer: server/utils — the one place that formats a destination failure, shared
 * by the two stages that can produce one: `DestinationRegistry` (a sink that
 * failed `onInit`) and `destinationToStream` (a sink that failed a `write`).
 *
 * Why stderr and never the logger: `destinations` REPLACES the default stdout
 * sink, so the sinks that just failed may be the only ones there are. Reporting a
 * broken sink *through the sink set* is a feedback loop, and in the total-failure
 * case it delivers the explanation into the dead sink. Stderr is outside the
 * fan-out, and every container runtime collects it.
 *
 * One function rather than one per stage, so both reports share a wire shape and
 * an operator greps a single `logKey` regardless of which stage failed.
 */
import { toSingleLineMessage } from './escape-log-text.util'
import { writeStderrSafely } from './safe-stdio.util'
import type { ReservedLogKey } from '../../shared/constants/reserved-log-keys.constants'
import type { LogLevel } from '../../shared/types/log-level.type'
import { LOG_LEVEL_PRIORITY } from '../constants/log-levels.constants'

/**
 * Write one structured destination-failure line to `process.stderr`.
 *
 * Errors from stderr itself are swallowed — it can be a closed pipe (`node app |
 * head`), and reporting a broken sink must never become the crash it exists to
 * prevent. The fail-soft contract is absolute.
 *
 * @param logKey - The reserved key classifying the stage that failed.
 * @param name - The failing destination's name.
 * @param cause - The thrown or rejected value, in whatever shape it arrived.
 * @param msg - Human-readable explanation, including what happens to the entry.
 */
export function reportDestinationFailure(
  logKey: ReservedLogKey,
  name: string,
  cause: unknown,
  msg: string
): void {
  try {
    // Coercion is INSIDE the guard, not above it. `String(cause)` on a value
    // with a throwing `toString`/`Symbol.toPrimitive`, and the `name`/`message`
    // reads on an `Error` with hostile getters, both throw — and from
    // `DestinationRegistry` this runs inside the catch that is supposed to keep
    // a bad sink from mattering, so an escape there would abort application
    // bootstrap. The never-throw contract has to cover reading the value, not
    // just writing it.
    const err =
      cause instanceof Error
        ? {
            type: toSingleLineMessage(String(cause.name)),
            message: toSingleLineMessage(String(cause.message))
          }
        : { type: 'UnknownError', message: toSingleLineMessage(String(cause)) }
    // Escaped per sink, like every other path that can reach a terminal.
    // `JSON.stringify` escapes C0 and nothing else, so DEL, the C1 range
    // (U+0085 NEL included), U+2028 and U+2029 survive verbatim into a line an
    // operator reads in a terminal — enough to drive it or to forge a rendered
    // entry. `destination` is consumer-named and `cause` is often remote-derived.
    writeStderrSafely(
      JSON.stringify({
        level: 'error',
        logKey,
        destination: toSingleLineMessage(name),
        err,
        msg: toSingleLineMessage(msg)
      }) + '\n'
    )
  } catch {
    // The value resisted being read — a hostile `toString` or getter. Nothing is
    // reported rather than anything thrown. A broken stderr is handled one layer
    // down by `writeStderrSafely`, which covers the ASYNC half a try/catch cannot.
  }
}

/**
 * Read a destination's `name` without letting that read abort the caller.
 *
 * `ILogDestination` declares `readonly name: string`, which does not stop a
 * consumer implementing it as a getter. Every reporter below is called from
 * inside a `catch` that exists to keep one bad sink from mattering, so a name
 * read at the CALL SITE puts the throw back outside the guard: from
 * `onModuleInit` it aborts bootstrap, and from the write adapter it skips the
 * stream callback and becomes an unhandled rejection.
 *
 * Escaping is left to the reporters, which already apply it to everything they
 * emit; this only guarantees a string comes back.
 *
 * @param destination - The destination whose name is needed for a report.
 * @returns The name, or `'unknown'` when reading it throws.
 *
 * @example
 * ```ts
 * const hostile = {
 *   get name(): string {
 *     throw new Error('boom')
 *   }
 * }
 * safeDestinationName(hostile) // 'unknown', instead of throwing at the call site
 * ```
 */
export function safeDestinationName(destination: { readonly name: string }): string {
  try {
    return String(destination.name)
  } catch {
    return 'unknown'
  }
}

/**
 * Whether a value is one of the six levels this library recognises.
 *
 * The widening is on the ARRAY, not on the value: reading `readonly LogLevel[]` as
 * `readonly unknown[]` is always true, whereas asserting the value to be a `LogLevel`
 * in order to ask whether it IS one states the very thing being checked. Widening to
 * `unknown[]` rather than `string[]` also drops a `typeof` guard that `includes`
 * already covers — strict equality against six strings rejects every other type —
 * and with it a branch only a forged value could ever exercise.
 *
 * @param value - Any value, typically read from consumer-controlled configuration.
 * @returns `true` when the value is a recognised level.
 */
function isLogLevel(value: unknown): value is LogLevel {
  return (LOG_LEVEL_PRIORITY as readonly unknown[]).includes(value)
}

/**
 * First answer per destination, so two readers cannot get different ones. Declared
 * ABOVE the JSDoc below on purpose: a declaration between a comment block and the
 * function it documents steals that comment, leaving the export undocumented.
 */
const resolvedMinLevels = new WeakMap<object, LogLevel | undefined>()

/**
 * Read a destination's `minLevel` without letting that read abort the caller, and
 * without trusting what it returns.
 *
 * `readonly minLevel?: LogLevel` does not stop a consumer implementing it as a
 * getter. It is read in two places that must not throw: the Pino factory, which
 * builds the multistream entry BEFORE any lifecycle hook runs — a throw there
 * fails provider construction and the application never starts — and the
 * registry's init loop, on both branches including the catch that exists so a
 * failing destination cannot abort bootstrap.
 *
 * The first answer is CACHED per destination, and that is the point rather than an
 * optimisation. Nothing stops the getter being stateful, and the value is read by
 * two independent consumers: the factory, which fixes the multistream entry's level,
 * and the registry, which records the same destination's health level. A getter
 * returning `info` to one and `error` to the other would let an `error` sink be
 * credited with covering held `info` entries — and a buffering destination would
 * discard its only copy of them. Pinning the first read makes the two agree by
 * construction. `readonly minLevel?: LogLevel` says it should not change anyway.
 *
 * The VALUE is checked too, not only the read. `readonly minLevel?: LogLevel` is a
 * compile-time claim, and a JavaScript consumer — or a miscast one — can return any
 * string. An unrecognised level is not rejected by `pino.multistream`: it builds
 * without complaint and the entry then matches NOTHING, so that destination receives
 * zero entries while the registry, whose `indexOf` returns `-1` and loses the
 * comparison, records it as covering the module level. Measured: a sink configured
 * with an invalid level received 0 of 3 emitted entries, silently. Silent total loss
 * is the worst outcome available here, so an unrecognised value is treated as absent
 * and the destination falls back to the module level, where it receives entries.
 * `validateOptions` already holds `options.level` to this same list; this is that
 * check reaching the place it had not.
 *
 * @param destination - The destination whose configured level is needed.
 * @returns The configured level, or `undefined` when absent, unreadable OR not a
 *   recognised level — the same answer for all three, since each means "no usable
 *   per-destination level". Stable across calls for a given destination.
 *
 * @example
 * ```ts
 * const hostile = {
 *   get minLevel(): LogLevel {
 *     throw new Error('boom')
 *   }
 * }
 * safeMinLevel(hostile) // undefined, instead of throwing at the call site
 * ```
 */
export function safeMinLevel(destination: { readonly minLevel?: LogLevel }): LogLevel | undefined {
  if (resolvedMinLevels.has(destination)) {
    return resolvedMinLevels.get(destination)
  }
  let resolved: LogLevel | undefined
  try {
    const read: unknown = destination.minLevel
    resolved = isLogLevel(read) ? read : undefined
  } catch {
    resolved = undefined
  }
  resolvedMinLevels.set(destination, resolved)
  return resolved
}
