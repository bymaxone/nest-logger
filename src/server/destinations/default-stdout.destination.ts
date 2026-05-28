/**
 * Canonical `ILogDestination` writing serialized JSON entries to `stdout`.
 *
 * Layer: server/destinations — the default sink registered by
 * `BymaxLoggerModule` when the consumer supplies no custom destinations.
 *
 * Constraint: thin synchronous wrapper around `process.stdout.write` so the
 * Pino producer remains the back-pressure boundary. No buffering, no
 * formatting, no async I/O at this layer.
 */
import { Injectable } from '@nestjs/common'

import type { LogLevel } from '../../shared/types/log-level.type'
import type { ILogDestination } from '../interfaces/log-destination.interface'

/**
 * Canonical destination that writes log payloads to `process.stdout`.
 *
 * `process.stdout.write` is buffered by Node.js, which makes it safe to call
 * on the hot path without blocking the event loop. The Pino producer is the
 * back-pressure boundary — this destination is intentionally a thin sink.
 */
@Injectable()
export class DefaultStdoutDestination implements ILogDestination {
  readonly name = 'stdout-json'
  readonly minLevel?: LogLevel

  /**
   * @param opts.minLevel — Optional minimum level filter. Entries below this
   *   level are dropped by the destination registry before reaching `write`.
   *   Omit (or pass `undefined`) to accept every level.
   */
  constructor(opts: { minLevel?: LogLevel } = {}) {
    if (opts.minLevel !== undefined) {
      this.minLevel = opts.minLevel
    }
  }

  /**
   * Write a serialized JSON log entry (terminated with `\n`) to `stdout`.
   */
  write(payload: string): void {
    process.stdout.write(payload)
  }
}
