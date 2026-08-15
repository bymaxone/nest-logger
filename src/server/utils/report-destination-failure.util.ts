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
