/**
 * Adapter bridging an `ILogDestination` to a Node `Writable` so it can join a
 * `pino.multistream` fan-out.
 *
 * Layer: server/utils — Pino writes serialized NDJSON to a set of `Writable`
 * streams. Each destination is wrapped here so its `write()` (sync or async) is
 * driven by Pino's stream back-pressure protocol, and a throwing or rejecting
 * destination surfaces as a stream error on its OWN wrapper — never breaking the
 * sibling destinations sharing the multistream.
 */
import { Writable } from 'node:stream'

import type { ILogDestination } from '../interfaces/log-destination.interface'

/**
 * Wrap a destination as a `Writable` consumable by `pino.multistream`.
 *
 * @param destination - The destination receiving each serialized NDJSON entry.
 * @returns A `Writable` that forwards every chunk to `destination.write`,
 *   awaiting async writes and isolating per-destination failures via the
 *   stream's error callback.
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
      try {
        const payload = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        const result = destination.write(payload)
        if (result instanceof Promise) {
          result.then(
            () => callback(),
            (cause: unknown) => callback(cause instanceof Error ? cause : new Error(String(cause)))
          )
        } else {
          callback()
        }
      } catch (cause) {
        callback(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }
  })
}
