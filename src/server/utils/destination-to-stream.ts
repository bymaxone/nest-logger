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
 * CONTAINED here — reported once to `process.stderr` as a
 * `LOGGER_DESTINATION_WRITE_FAILED` line and then swallowed (the stream callback
 * is invoked WITHOUT an error). Propagating it via `callback(err)` would make the
 * wrapper `Writable` emit an unhandled `'error'` event, which crashes the process.
 * The report goes to stderr — NEVER back through the logger — so a broken
 * destination cannot create a write → log → write feedback loop.
 */
import { Writable } from 'node:stream'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'

/**
 * Report a single destination write failure to `process.stderr` as a structured
 * `LOGGER_DESTINATION_WRITE_FAILED` line. Writes to stderr directly (the safe
 * sink) — never through the logger — to avoid a write-failure feedback loop.
 *
 * @param name - The failing destination's name.
 * @param cause - The thrown or rejected value.
 */
function reportWriteFailure(name: string, cause: unknown): void {
  const err =
    cause instanceof Error
      ? { type: cause.name, message: cause.message }
      : { type: 'UnknownError', message: String(cause) }
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      logKey: RESERVED_LOG_KEYS.LOGGER_DESTINATION_WRITE_FAILED,
      destination: name,
      err,
      msg: `Log destination "${name}" failed to write; the entry was dropped`
    }) + '\n'
  )
}

/**
 * Wrap a destination as a `Writable` consumable by `pino.multistream`.
 *
 * @param destination - The destination receiving each serialized NDJSON entry.
 * @returns A `Writable` that forwards every chunk to `destination.write`,
 *   awaiting async writes and containing per-destination failures fail-soft
 *   (reported to stderr, never propagated as a crashing stream error).
 */
export function destinationToStream(destination: ILogDestination): Writable {
  return new Writable({
    // Keep string chunks as strings (Node's default re-encodes them to Buffers
    // before `_write`): the common Pino path emits NDJSON strings, so this skips
    // a string→Buffer→string round-trip on the hot logging path.
    decodeStrings: false,
    write(
      chunk: string | Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ): void {
      // A destination failure is CONTAINED, not propagated: calling the callback
      // with an error would surface as an unhandled stream 'error' and crash the
      // host. Report once to stderr, then signal success so the fan-out continues.
      const onFailure = (cause: unknown): void => {
        reportWriteFailure(destination.name, cause)
        callback()
      }
      try {
        const payload = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
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
