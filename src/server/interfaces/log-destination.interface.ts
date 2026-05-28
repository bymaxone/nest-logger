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
   * Optional lifecycle hook — called during NestJS `onApplicationShutdown`.
   * MUST flush any pending writes and close resources.
   *
   * The library awaits this — graceful shutdown blocks until all destinations
   * return.
   */
  onShutdown?(): void | Promise<void>
}
