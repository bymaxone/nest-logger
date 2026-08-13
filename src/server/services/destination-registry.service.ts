/**
 * Lifecycle manager for the registered log destinations.
 *
 * Layer: server/services — an internal (NOT exported) NestJS provider that owns
 * the `onInit` / `onShutdown` lifecycle of every `ILogDestination` supplied
 * under `LOGGER_DESTINATIONS_TOKEN`. The Pino multi-stream wiring writes to the
 * same destination objects; this registry guarantees they are initialized before
 * traffic and flushed in reverse order at shutdown.
 *
 * Failure policy: a destination that throws during `onInit` is dropped from the
 * active set and reported via `LOGGER_DESTINATION_INIT_FAILED` — boot is NEVER
 * aborted (degraded logging is preferred over a crashed application).
 */
import { Inject, Injectable } from '@nestjs/common'
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common'

import { PinoLoggerService } from './pino-logger.service'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import {
  LOGGER_DESTINATIONS_TOKEN,
  LOGGER_OPTIONS_TOKEN
} from '../constants/injection-tokens.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

/**
 * Coordinates destination initialization and graceful shutdown.
 *
 * @example
 *   // Registered internally by BymaxLoggerModule — consumers never inject it.
 *   providers: [DestinationRegistry]
 */
@Injectable()
export class DestinationRegistry implements OnModuleInit, OnApplicationShutdown {
  /**
   * Destinations that initialized successfully, in registration order.
   *
   * Note: the Pino multistream is built from the full registered list, and the
   * write path is independently fail-soft (see `destinationToStream`). This set
   * is the authoritative record of init success — it drives reverse-order
   * shutdown — but is not currently used to remove a failed-init sink from the
   * write fan-out; a sink that failed `onInit` still receives writes, contained
   * fail-soft by the wrapper.
   */
  private readonly active: ILogDestination[] = []

  /**
   * @param registered - Every destination declared under
   *   `LOGGER_DESTINATIONS_TOKEN`. Injected by token explicitly because the
   *   package is bundled without `emitDecoratorMetadata`.
   * @param logger - Structured logger used to report init failures. Injected by
   *   token explicitly for the same bundling reason.
   */
  constructor(
    @Inject(LOGGER_DESTINATIONS_TOKEN) private readonly registered: readonly ILogDestination[],
    @Inject(PinoLoggerService) private readonly logger: PinoLoggerService,
    @Inject(LOGGER_OPTIONS_TOKEN) private readonly options: ResolvedBymaxLoggerModuleOptions
  ) {}

  /**
   * Initialize every registered destination. A destination whose `onInit`
   * rejects is skipped (not added to the active set) and reported — it must not
   * block application bootstrap.
   */
  async onModuleInit(): Promise<void> {
    for (const destination of this.registered) {
      try {
        await destination.onInit?.()
        this.active.push(destination)
      } catch (cause) {
        this.logger.errorStructured(
          RESERVED_LOG_KEYS.LOGGER_DESTINATION_INIT_FAILED,
          cause instanceof Error ? cause : new Error(String(cause)),
          undefined,
          { destination: destination.name }
        )
      }
    }
    this.announceBootstrap()
  }

  /**
   * Emit the one-shot bootstrap entries, AFTER every destination has been
   * initialized.
   *
   * Ordering is the whole point of doing this here rather than from an eagerly
   * instantiated provider factory: a provider factory runs while Nest is still
   * building the graph, before `onModuleInit`, so a sink that only accepts
   * writes once its own `onInit()` has run would drop these entries — including
   * `LOGGER_BOOTSTRAP_WARNING`, which exists precisely so a security review can
   * see that PII redaction was turned off. A signal that a custom destination
   * can silently swallow is not an audit trail. Emitting from the registry that
   * owns destination initialization makes the ordering structural instead of a
   * cross-provider hook-order assumption.
   */
  private announceBootstrap(): void {
    this.logger.info(RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_OK, 'BymaxLoggerModule initialized')
    if (this.options.shouldDisableDefaultRedact) {
      this.logger.warnStructured(
        RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_WARNING,
        'Default PII redaction is DISABLED — sensitive fields will be logged verbatim ' +
          'unless every one of them is listed in options.redactPaths',
        undefined,
        {
          shouldDisableDefaultRedact: true,
          redactPathCount: this.options.redactPaths.length
        }
      )
    }
  }

  /**
   * Flush and close active destinations in REVERSE registration order, so a
   * destination registered first (e.g. stdout) closes last. Failures are written
   * directly to stderr: `PinoLoggerService` may already be torn down at this
   * point in the shutdown sequence.
   */
  async onApplicationShutdown(): Promise<void> {
    // Emitted BEFORE the sinks are torn down — a shutdown entry written after
    // the destinations closed would have nowhere to go. It is the bookend to
    // `LOGGER_BOOTSTRAP_OK`: its absence in a log stream is how an operator
    // tells a graceful shutdown from a killed process.
    this.logger.info(
      RESERVED_LOG_KEYS.LOGGER_SHUTDOWN_OK,
      'BymaxLoggerModule shutting down',
      undefined,
      { destinations: this.active.length }
    )
    // Yield the event loop once before teardown. `destinationToStream` leaves the
    // Writable callback pending until an async `write()` settles, and
    // `logger.info()` returns immediately — so without this barrier the loop below
    // could call `onShutdown()` on a sink whose shutdown entry is still in flight.
    // This is a best-effort ordering nudge, not a delivery guarantee: the
    // authoritative contract is `ILogDestination.onShutdown`, which MUST flush
    // pending writes.
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    for (const destination of [...this.active].reverse()) {
      try {
        await destination.onShutdown?.()
      } catch (cause) {
        const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
        process.stderr.write(
          `[DestinationRegistry] Shutdown failed for "${destination.name}": ${detail}\n`
        )
      }
    }
  }

  /**
   * The destinations that initialized successfully.
   *
   * @returns A read-only view of the active destination set.
   */
  getActive(): readonly ILogDestination[] {
    return this.active
  }
}
