/**
 * Structured failure reporting for log destinations, written to `process.stderr`.
 *
 * Layer: server/utils — the one place that formats a destination failure, shared
 * by the two stages that can produce one: `DestinationRegistry` (a sink that
 * failed `onInit`) and `destinationToStream` (a sink that failed a `write`).
 *
 * Why stderr and never the logger: `destinations` REPLACES the default stdout
 * sink, so the sinks that just failed may be the only ones the application has.
 * Reporting a broken sink *through the sink set* is a feedback loop, and in the
 * total-failure case it delivers the explanation into the dead sink — an
 * application that boots, runs, exits 0 and says nothing about why. Stderr is
 * outside the fan-out, and every container runtime collects it.
 *
 * Why one function rather than one per stage: the two reports share a wire shape
 * on purpose, so an operator greps a single `logKey` field regardless of which
 * stage failed. Two copies of the shape would let that drift silently.
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
 * @example
 *   reportDestinationFailure(
 *     RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
 *     'loki',
 *     new Error('ECONNREFUSED'),
 *     'Log destination "loki" failed to write; the entry was dropped'
 *   )
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
