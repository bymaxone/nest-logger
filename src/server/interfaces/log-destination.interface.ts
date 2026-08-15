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
   * it, so a held copy may be a SECOND copy — printing it anyway is what made a
   * supported `[DefaultStdoutDestination(), PrettyDevDestination()]` pair emit
   * every boot entry twice when the pretty sink failed to initialize.
   *
   * Called on failed destinations too, which is the point: the one that could not
   * initialize is exactly the one still holding entries.
   *
   * @param status.heldEntriesDeliveredElsewhere - Whether a LIVE sink accepted
   *   everything this destination accepted, so anything held is already
   *   delivered. `false` does not mean nothing survived — it also covers a live
   *   sink whose level is HIGHER than yours, which never saw your lower-severity
   *   entries.
   * @param status.hasHealthySink - Whether any destination is live at all. Read
   *   with the flag above: "someone is alive" and "someone got what I got" differ
   *   exactly when a live sink's level sits above yours.
   * @param status.isElectedRescuer - When nothing survived, whether YOU are the
   *   single destination elected to speak. Two buffering destinations hold the
   *   same entries, so draining from both would recreate the duplicate.
   */
  onRegistryReady?(status: {
    readonly heldEntriesDeliveredElsewhere: boolean
    readonly hasHealthySink: boolean
    readonly isElectedRescuer: boolean
  }): void

  /**
   * Optional lifecycle hook — called during NestJS `onApplicationShutdown`.
   * MUST flush any pending writes and close resources.
   *
   * The library awaits this — graceful shutdown blocks until all destinations
   * return.
   */
  onShutdown?(): void | Promise<void>
}
