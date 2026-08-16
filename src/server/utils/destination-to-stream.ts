/**
 * Adapter bridging an `ILogDestination` to a Node `Writable` so it can join a
 * `pino.multistream` fan-out.
 *
 * Layer: server/utils — Pino writes serialized NDJSON to a set of `Writable`
 * streams. Each destination is wrapped here so its `write()` (sync or async) is
 * driven by Pino's stream back-pressure protocol.
 *
 * Fail-soft contract (the library's core guarantee): a destination whose
 * `write()` throws or rejects MUST NOT crash the host application. The failure is
 * CONTAINED here — each failed write emits one
 * `LOGGER_DESTINATION_WRITE_FAILED` line to `process.stderr` and is then swallowed
 * (the stream callback is invoked WITHOUT an error). Propagating it via `callback(err)` would make the
 * wrapper `Writable` emit an unhandled `'error'` event, which crashes the process.
 * The report goes to stderr — NEVER back through the logger — so a broken
 * destination cannot create a write → log → write feedback loop.
 *
 * Init health (`DestinationHealth`) is consulted BEFORE the destination is
 * called, which is what keeps a failed sink out of the fan-out and what makes a
 * total init failure degrade to raw NDJSON instead of silence. See the health
 * record's own documentation for why the check lives here rather than in the
 * multistream.
 */
import { Writable } from 'node:stream'

import { reportDestinationFailure } from './report-destination-failure.util'
import { writeStdoutSafely } from './safe-stdio.util'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { DestinationHealth } from '../services/destination-health.service'

/**
 * Report one destination write failure — one line per failed write (not
 * throttled, so a sustained outage stays visible rather than silently dropping).
 *
 * Formatting and the stderr-vs-logger reasoning live in
 * {@link reportDestinationFailure}, shared with the registry's init-failure path
 * so both stages emit the same wire shape.
 *
 * @param name - The failing destination's name.
 * @param cause - The thrown or rejected value.
 */
function reportWriteFailure(name: string, cause: unknown): void {
  reportDestinationFailure(
    RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
    name,
    cause,
    `Log destination "${name}" failed to write; the entry was dropped`
  )
}

/**
 * Write one entry directly to stdout because every destination failed to
 * initialize and this one was elected to speak for them.
 *
 * The payload is the already-serialized NDJSON line, emitted verbatim: the point
 * of a last resort is to lose nothing, and reformatting it here would need the
 * very sink machinery that just failed. Errors from stdout are swallowed for the
 * same reason `reportWriteFailure` swallows them — the fail-soft contract is
 * absolute, and rescuing a log line must never become the crash it prevents.
 *
 * @param payload - The serialized, newline-terminated NDJSON entry.
 */
function rescueToStdout(payload: string): void {
  writeStdoutSafely(payload)
}

/**
 * Wrap a destination as a `Writable` consumable by `pino.multistream`.
 *
 * @param destination - The destination receiving each serialized NDJSON entry.
 * @param health - Init-health record consulted before every write, so a sink that
 *   failed `onInit` is skipped and a total failure is rescued to stdout.
 * @returns A `Writable` that forwards every chunk to `destination.write`,
 *   awaiting async writes and containing per-destination failures fail-soft
 *   (reported to stderr, never propagated as a crashing stream error).
 */
export function destinationToStream(
  destination: ILogDestination,
  health: DestinationHealth
): Writable {
  return new Writable({
    // Keep string chunks as strings (Node's default re-encodes them to Buffers
    // before `_write`): the common Pino path emits NDJSON strings, so this skips
    // a string→Buffer→string round-trip on the hot logging path.
    // Stryker disable next-line BooleanLiteral: equivalent for every chunk this stream receives — with `true`, Node encodes the string to a Buffer and `write()` below decodes it back with `toString('utf-8')`. Pino writes UTF-8 NDJSON strings at the default encoding, so the round-trip returns the identical string. It is NOT equivalent in general: a `write(chunk, 'latin1')` would round-trip through UTF-8 and change non-ASCII bytes, which is unreachable here because nothing writes to this stream but Pino. The flag stays because it skips the round-trip on the hot logging path.
    decodeStrings: false,
    write(
      chunk: string | Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ): void {
      // A destination failure is CONTAINED, not propagated: calling the callback
      // with an error would surface as an unhandled stream 'error' and crash the
      // host. Report to stderr (one line per failure), then signal success so the
      // fan-out continues.
      const onFailure = (cause: unknown): void => {
        // Recorded, not only reported. A destination that threw on a write did
        // NOT receive that entry, and the readiness hook would otherwise infer
        // delivery from init health and level alone — telling a buffering sink
        // its held copies are safe elsewhere when the sink it is trusting has
        // been dropping them.
        health.markWriteFailed(destination)
        reportWriteFailure(destination.name, cause)
        callback()
      }
      try {
        const payload = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        // A sink that failed `onInit` never became live, so it is skipped rather
        // than written to — its `write()` may assume resources never acquired.
        // When NOTHING initialized, the elected rescuer emits the raw entry to
        // stdout: without it, one bad destination silences the whole application.
        if (health.isFailed(destination)) {
          if (health.shouldRescue(destination)) {
            rescueToStdout(payload)
          }
          callback()
          return
        }
        const result = destination.write(payload)
        if (result instanceof Promise) {
          result.then(() => callback(), onFailure)
        } else {
          callback()
        }
      } catch (cause) {
        onFailure(cause)
      }
    }
  })
}
