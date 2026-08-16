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
  write(payload: string): void | Promise<void>

  /**
   * Optional lifecycle hook — called once during NestJS module init.
   * Use for opening connections, allocating buffers, scheduling flushers.
   */
  onInit?(): void | Promise<void>

  /**
   * Optional lifecycle hook — called once after EVERY destination's `onInit`
   * has settled, successfully or not, and before the bootstrap entry is emitted.
   *
   * Only useful to a destination that holds entries written before its own
   * `onInit` ran: until this point it cannot know what became of them. The
   * fan-out hands each entry to every registered destination whose level accepts
   * it, so a held copy may be a SECOND copy.
   *
   * **The policy is: never lose an entry.** Discard only what is PROVEN
   * delivered; emit everything else, accepting that a duplicated boot line is the
   * price of never dropping one. That is why a single fact is handed over rather
   * than a set of hints — a hint invites a judgement call, and every judgement
   * call here has a losing branch.
   *
   * Called on failed destinations too, which is the point: the one that could not
   * initialize is exactly the one still holding entries.
   *
   * @param status.heldEntriesDeliveredElsewhere - Whether ANOTHER live sink
   *   accepted everything this destination accepted, as far as this library can
   *   see. It is `true` only when that sink is not this one, initialized, sits at
   *   or below this level, has had no write failure, and has no write still in
   *   flight — anything less certain is reported as `false`, and you emit.
   *
   *   **Best-effort, not a proof.** The accounting covers writes this library has
   *   handed to a destination. One still QUEUED inside the `Writable` adapter,
   *   behind a slow async sink that has not been called yet, is invisible to it:
   *   this can read `true` while such an entry has not reached that sink. It
   *   normally arrives — queued, not lost — and the residual risk is a queued
   *   write that later fails. Weigh that before discarding your only copy; when
   *   in doubt, emit.
   * @returns Nothing, or a promise the library AWAITS. Returning one is
   *   supported deliberately: TypeScript accepts an `async` implementation where
   *   a void-returning member is declared, so a hook that was not awaited would
   *   reject into nothing and let the bootstrap entry be emitted before the
   *   buffer had been resolved.
   */
  onRegistryReady?(status: {
    readonly heldEntriesDeliveredElsewhere: boolean
  }): void | Promise<void>

  /**
   * Optional lifecycle hook — called during NestJS `onApplicationShutdown`.
   * MUST flush any pending writes and close resources.
   *
   * The library awaits this — graceful shutdown blocks until all destinations
   * return.
   */
  onShutdown?(): void | Promise<void>
}
