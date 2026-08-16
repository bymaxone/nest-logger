/**
 * Pluggable destination contract for the logger.
 *
 * Layer: server/interfaces — implemented by every concrete sink
 * (`DefaultStdoutDestination`, future HTTP / file / queue destinations).
 * The library owns the JSON serialization; implementations only forward
 * the already-encoded payload.
 */
import type { LogLevel } from '../../shared/types/log-level.type'

/**
 * Pluggable destination for log entries.
 *
 * Implementations receive the final JSON-serialized payload (with trailing
 * newline) and write it wherever they want — file, network, queue, etc.
 *
 * Implementations MUST be non-blocking and tolerant to errors. A destination
 * that throws or hangs MUST NOT break the application — the library's
 * `DestinationRegistry` catches errors and emits a meta-log
 * (`LOGGER_DESTINATION_WRITE_FAILED`).
 *
 * @example
 *   class FileDestination implements ILogDestination {
 *     readonly name = 'file'
 *     write(payload: string): void {
 *       fs.appendFileSync('/var/log/app.log', payload)
 *     }
 *   }
 */
export interface ILogDestination {
  /** Unique identifier — used in error logs and registry lookups. */
  readonly name: string

  /**
   * Minimum log level this destination accepts. Entries below this level
   * are not written. Undefined means "accept everything".
   */
  readonly minLevel?: LogLevel

  /**
   * Write a single log entry. Payload is the already-serialized JSON string
   * (UTF-8, terminated with `\n`).
   *
   * Implementations may:
   *   - Write synchronously (e.g., `process.stdout`)
   *   - Buffer and flush periodically (e.g., HTTP batching)
   *   - Return a Promise for async I/O
   *
   * Errors thrown here are caught by the library; the destination may be
   * temporarily skipped if it consistently fails.
   *
   * @param payload — Newline-terminated JSON entry, UTF-8 encoded.
   */
  write(payload: string): void | PromiseLike<void>

  /**
   * Optional lifecycle hook — called once during NestJS module init.
   * Use for opening connections, allocating buffers, scheduling flushers.
   */
  onInit?(): void | PromiseLike<void>

  /**
   * Optional lifecycle hook — called once after EVERY destination's `onInit`
   * has settled, successfully or not, and before the bootstrap entry is emitted.
   *
   * Only useful to a destination that holds entries written before its own
   * `onInit` ran: until this point it cannot know what became of them. The
   * fan-out hands each entry to every registered destination whose level accepts
   * it, so a held copy may be a SECOND copy.
   *
   * **This is a deduplication signal, not a proof — and the difference is the
   * whole contract.** A held copy may be a second copy, so emitting it duplicates
   * a line and dropping it may lose one. The flag says which risk is smaller, as
   * far as this library can see; it does not say the entry is safe.
   *
   * The library's own destinations act on it by discarding when it is `true` and
   * emitting otherwise, because a duplicated boot line is a smaller harm than a
   * lost one. **A destination that cannot tolerate ANY loss should emit
   * regardless** — see the accounting limits on the flag below.
   *
   * Called on failed destinations too, which is the point: the one that could not
   * initialize is exactly the one still holding entries.
   *
   * @param status.heldEntriesDeliveredElsewhere - Whether another live sink
   *   accepted everything this destination accepted, as far as this library can
   *   see. `true` requires that sink to be not this one, initialized, at or below
   *   this level, with no write failure and no write still in flight; anything
   *   less certain is `false`.
   *
   *   **What it cannot see:** a write still QUEUED inside the `Writable` adapter,
   *   behind a slow async sink that has not been called yet. So `true` can precede
   *   a queued write that later fails, and there is no flag that distinguishes
   *   that case — which is exactly why this is a tradeoff rather than a
   *   guarantee. It normally arrives, being queued rather than lost.
   *
   * @returns Nothing, or a promise the library AWAITS. Returning one is
   *   supported deliberately: TypeScript accepts an `async` implementation where
   *   a void-returning member is declared, so a hook that was not awaited would
   *   reject into nothing and let the bootstrap entry be emitted before the
   *   buffer had been resolved.
   */
  onRegistryReady?(status: {
    readonly heldEntriesDeliveredElsewhere: boolean
  }): void | PromiseLike<void>

  /**
   * Optional lifecycle hook — called during NestJS `onApplicationShutdown`.
   * MUST flush any pending writes and close resources.
   *
   * The library awaits this — graceful shutdown blocks until all destinations
   * return.
   */
  onShutdown?(): void | PromiseLike<void>
}
