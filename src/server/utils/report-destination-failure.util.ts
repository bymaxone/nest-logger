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
  const err =
    cause instanceof Error
      ? { type: cause.name, message: cause.message }
      : { type: 'UnknownError', message: String(cause) }
  try {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        logKey,
        destination: name,
        err,
        msg
      }) + '\n'
    )
  } catch {
    // The safe sink itself can fail — e.g. EPIPE when stderr is a closed pipe.
    // Swallow it: reporting a dropped log must never become a crash.
  }
}
