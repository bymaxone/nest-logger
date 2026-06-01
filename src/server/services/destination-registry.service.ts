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
import { LOGGER_DESTINATIONS_TOKEN } from '../constants/injection-tokens.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'

/**
 * Coordinates destination initialization and graceful shutdown.
 *
 * @example
 *   // Registered internally by BymaxLoggerModule — consumers never inject it.
 *   providers: [DestinationRegistry]
 */
@Injectable()
export class DestinationRegistry implements OnModuleInit, OnApplicationShutdown {
  /** Destinations that initialized successfully, in registration order. */
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
    @Inject(PinoLoggerService) private readonly logger: PinoLoggerService
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
  }

  /**
   * Flush and close active destinations in REVERSE registration order, so a
   * destination registered first (e.g. stdout) closes last. Failures are written
   * directly to stderr: `PinoLoggerService` may already be torn down at this
   * point in the shutdown sequence.
   */
  async onApplicationShutdown(): Promise<void> {
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
