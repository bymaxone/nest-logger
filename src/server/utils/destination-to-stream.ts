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
import type { WritableOptions } from 'node:stream'

import { toSingleLineMessage } from './escape-log-text.util'
import { reportDestinationFailure, safeDestinationName } from './report-destination-failure.util'
import { writeStderrSafely, writeStdoutSafely } from './safe-stdio.util'
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
 * @param destination - The failing destination. Passed whole so its `name` is read
 *   under `safeDestinationName` here rather than at the call site, which sits
 *   inside the catch and the rejection handler.
 * @param cause - The thrown or rejected value.
 */
function reportWriteFailure(destination: ILogDestination, cause: unknown): void {
  // The name is read HERE, under `safeDestinationName`, not at the call site: the
  // call site is inside the catch and the rejection handler, where a throwing
  // getter would skip `callback()` and become the very unhandled rejection this
  // path contains.
  const name = safeDestinationName(destination)
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

/** What the queue holds, in bytes, shared by the stream and the write handler that releases it. */
interface QueueCount {
  bytes: number
}

/** How a destination's own buffer is read: absent, throwing or not a number all count as empty. */
function ownQueuedBytes(destination: ILogDestination): number {
  try {
    const bytes = destination.queuedBytes?.() ?? 0
    // Stryker disable next-line EqualityOperator: equivalent, `bytes >= 0` and `bytes > 0` differ only at 0, where the conditional returns `bytes`, which is 0, and the else branch returns 0. The result is 0 for every input either way.
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  } catch {
    return 0
  }
}

/**
 * A `Writable` that refuses an entry the destination has no room for.
 *
 * Pino calls `write` on every stream whether or not the last write has finished, and a `Writable`
 * buffers what it is given without limit, so the bound has to sit where the chunk enters. An entry
 * that would take the queue, the destination's own buffer and itself past the bound is dropped and
 * its callback is called, so the producer and the in-flight accounting see a write that completed.
 * One entry is always accepted when nothing is queued: a bound smaller than an entry would otherwise
 * drop everything.
 */
export class BoundedWritable extends Writable {
  constructor(
    private readonly destination: ILogDestination,
    private readonly health: DestinationHealth,
    private readonly maxBytes: number,
    private readonly queue: QueueCount,
    options: WritableOptions
  ) {
    super(options)
  }

  /**
   * A destroyed stream holds nothing: Writable fails the chunks still buffered without calling the
   * write handler, so nothing else would release their bytes.
   */
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.queue.bytes = 0
    super._destroy(error, callback)
  }

  /** The bytes of NDJSON waiting for the destination, the write in flight included. */
  get queuedBytes(): number {
    return this.queue.bytes
  }

  override write(
    chunk: string | Buffer,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean {
    // Only strings and Buffers are counted, which is all Pino writes: a chunk type that Writable
    // refuses with a synchronous throw (an ArrayBuffer) would stay counted, and the adapter is not
    // reachable from outside the module.
    // A stream that has ended or been destroyed refuses the chunk without calling the handler, so
    // nothing would release the bytes; it is left to Writable to report, and is not counted.
    if (this.writableEnded || this.destroyed) {
      return this.forward(chunk, encodingOrCallback, callback)
    }
    const bytes = Buffer.byteLength(chunk)
    const held = this.heldBytes()
    if (this.maxBytes > 0 && held > 0 && held + bytes > this.maxBytes) {
      this.dropped()
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
      done?.()
      return true
    }
    this.queue.bytes += bytes
    return this.forward(chunk, encodingOrCallback, callback)
  }

  /** `Writable.write` for either of its two signatures. */
  private forward(
    chunk: string | Buffer,
    encodingOrCallback: BufferEncoding | ((error?: Error | null) => void) | undefined,
    callback: ((error?: Error | null) => void) | undefined
  ): boolean {
    return typeof encodingOrCallback === 'function'
      ? super.write(chunk, encodingOrCallback)
      : super.write(chunk, encodingOrCallback ?? 'utf8', callback)
  }

  /**
   * What the entry would queue behind. A live destination holds its module queue and what it reports
   * in a buffer of its own. A failed destination receives nothing, so what it reports does not count,
   * and the one elected to rescue entries writes them to stdout, whose queue is what grows.
   */
  private heldBytes(): number {
    if (!this.health.isFailed(this.destination)) {
      return this.queue.bytes + ownQueuedBytes(this.destination)
    }
    return this.health.shouldRescue(this.destination)
      ? this.queue.bytes + process.stdout.writableLength
      : 0
  }

  /** Count the drop, and write the report when one is due. */
  private dropped(): void {
    const due = this.health.recordDrop(this.destination, performance.now())
    if (due === undefined) return
    const name = toSingleLineMessage(safeDestinationName(this.destination))
    writeStderrSafely(
      `[DestinationRegistry] Destination "${name}" queue full: ${String(due)} entries dropped since the last report (limit ${String(this.maxBytes)} bytes)\n`
    )
  }
}

/**
 * Wrap a destination as a `Writable` consumable by `pino.multistream`.
 *
 * @param destination - The destination receiving each serialized NDJSON entry.
 * @param health - Init-health record consulted before every write, so a sink that
 *   failed `onInit` is skipped and a total failure is rescued to stdout.
 * @param maxQueueBytes - The most bytes the queue may hold before an entry is dropped; `0` for
 *   no bound.
 * @returns A `Writable` that forwards every chunk to `destination.write`,
 *   awaiting async writes and containing per-destination failures fail-soft
 *   (reported to stderr, never propagated as a crashing stream error).
 */
export function destinationToStream(
  destination: ILogDestination,
  health: DestinationHealth,
  maxQueueBytes = 0
): Writable & { readonly queuedBytes: number } {
  const queue = { bytes: 0 }
  const stream = new BoundedWritable(destination, health, maxQueueBytes, queue, {
    // Keep string chunks as strings (Node's default re-encodes them to Buffers
    // before `_write`): the common Pino path emits NDJSON strings, so this skips
    // a string→Buffer→string round-trip on the hot logging path.
    // Stryker disable next-line BooleanLiteral: equivalent for every chunk this stream receives — with `true`, Node encodes the string to a Buffer and `write()` below decodes it back with `toString('utf-8')`. Pino writes UTF-8 NDJSON strings at the default encoding, so the round-trip returns the identical string. It is NOT equivalent in general: a `write(chunk, 'latin1')` would round-trip through UTF-8 and change non-ASCII bytes, which is unreachable here because nothing writes to this stream but Pino. The flag stays because it skips the round-trip on the hot logging path.
    decodeStrings: false,
    write(
      chunk: string | Buffer,
      _encoding: BufferEncoding,
      settled: (error?: Error | null) => void
    ): void {
      // The bytes this chunk held in the queue are released when its write settles, however it settles.
      const bytes = Buffer.byteLength(chunk)
      const callback = (error?: Error | null): void => {
        // Never below zero: a destroyed stream has already reset the count.
        queue.bytes = Math.max(0, queue.bytes - bytes)
        settled(error)
      }
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
        reportWriteFailure(destination, cause)
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
        // Branch on `undefined`, NOT on `instanceof Promise`. The declared return
        // is `void | PromiseLike<void>`, but `instanceof` is realm-local and answers
        // `false` for a promise from another realm (a worker, a vm context) and
        // for any structurally valid thenable — measured, both. Either would take
        // the synchronous path here: the callback would fire immediately, a later
        // rejection would escape as an unhandled rejection instead of being
        // reported, and the write would never be counted as pending — so readiness
        // could tell a buffering sink to discard its only copy of an entry that
        // was about to fail. This library already learned the realm-local lesson
        // once, from `instanceof Error`, which is why `isErrorLike` exists.
        //
        // `Promise.resolve` assimilates both shapes. Synchronous writes keep the
        // synchronous path, so the back-pressure contract is unchanged.
        if (result === undefined) {
          callback()
        } else {
          // Counted while in flight. A rejection is only recorded when the promise
          // settles, and readiness can be computed before that — so a pending
          // write has to read as UNPROVEN rather than as silent success, or a
          // buffering sink discards its copy moments before this one rejects.
          health.markWritePending(destination)
          Promise.resolve(result).then(
            () => {
              health.markWriteSettled(destination)
              callback()
            },
            (cause: unknown) => {
              health.markWriteSettled(destination)
              onFailure(cause)
            }
          )
        }
      } catch (cause) {
        onFailure(cause)
      }
    }
  })
  return stream
}
