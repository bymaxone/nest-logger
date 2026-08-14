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
 * active set, removed from the write fan-out, and reported as
 * `LOGGER_DESTINATION_INIT_FAILED` **directly to `process.stderr`** — boot is
 * NEVER aborted (degraded logging is preferred over a crashed application).
 *
 * The report does not go through `this.logger`, and that is the whole fix rather
 * than a stylistic choice. `destinations` REPLACES the default stdout sink, so
 * the sinks that just failed may be the only ones there are; routing the
 * explanation back through them is what turned a misconfiguration into an
 * application that boots, runs, exits 0 and writes nothing anywhere — with the
 * diagnostic naming the cause delivered into the dead sink. It is the same
 * reasoning `destinationToStream` already applies to write failures, and the
 * same reasoning the shutdown path below already applies to teardown failures.
 */
import { Inject, Injectable } from '@nestjs/common'
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common'

import { DestinationHealth } from './destination-health.service'
import { PinoLoggerService } from './pino-logger.service'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import {
  LOGGER_DESTINATIONS_TOKEN,
  LOGGER_OPTIONS_TOKEN
} from '../constants/injection-tokens.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { detectOtelTraceApi } from '../utils/otel-detector'
import { reportDestinationFailure } from '../utils/report-destination-failure.util'

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
   * Authoritative for BOTH shutdown (reverse order) and — via the shared
   * `DestinationHealth` record written alongside it — the write fan-out. The two
   * are kept in step here because the multistream itself is wired before any
   * `onInit` runs and cannot be rebuilt afterwards; see `DestinationHealth`.
   */
  private readonly active: ILogDestination[] = []

  /**
   * @param registered - Every destination declared under
   *   `LOGGER_DESTINATIONS_TOKEN`. Injected by token explicitly because the
   *   package is bundled without `emitDecoratorMetadata`.
   * @param logger - Structured logger used for the bootstrap entries. Injected by
   *   token explicitly for the same bundling reason. Deliberately NOT used to
   *   report init failures — see the file-level note.
   * @param options - Resolved module options, read for the bootstrap warnings and
   *   for each destination's effective level.
   * @param health - Init-health record shared with the write fan-out.
   */
  constructor(
    @Inject(LOGGER_DESTINATIONS_TOKEN) private readonly registered: readonly ILogDestination[],
    @Inject(PinoLoggerService) private readonly logger: PinoLoggerService,
    @Inject(LOGGER_OPTIONS_TOKEN) private readonly options: ResolvedBymaxLoggerModuleOptions,
    @Inject(DestinationHealth) private readonly health: DestinationHealth
  ) {}

  /**
   * Initialize every registered destination. A destination whose `onInit`
   * rejects is skipped (not added to the active set), marked failed so the
   * fan-out stops writing to it, and reported to stderr — it must not block
   * application bootstrap.
   *
   * The loop completes BEFORE {@link announceBootstrap}, and that ordering is
   * load-bearing rather than incidental: the health record is what lets a
   * last-resort sink carry the bootstrap entries when every destination failed.
   * Announcing first would emit them into a fan-out that has not yet been told
   * anything is wrong, and `LOGGER_BOOTSTRAP_WARNING` — the signal that exists so
   * a security review can see PII redaction was disabled — would be lost exactly
   * when the configuration is already known to be broken.
   */
  async onModuleInit(): Promise<void> {
    for (const destination of this.registered) {
      try {
        await destination.onInit?.()
        this.active.push(destination)
        this.health.markHealthy()
      } catch (cause) {
        this.health.markFailed(destination, destination.minLevel ?? this.options.level)
        this.reportInitFailure(destination.name, cause)
      }
    }
    this.announceBootstrap()
  }

  /**
   * Report one destination init failure as a structured
   * `LOGGER_DESTINATION_INIT_FAILED` line on `process.stderr`.
   *
   * Shares {@link reportDestinationFailure} with the write-failure path rather
   * than restating the shape, so an operator greps one `logKey` regardless of
   * which stage failed — and the two cannot drift apart.
   *
   * @param name - The failing destination's name.
   * @param cause - The thrown or rejected value.
   */
  private reportInitFailure(name: string, cause: unknown): void {
    reportDestinationFailure(
      RESERVED_LOG_KEYS.LOGGER_DESTINATION_INIT_FAILED,
      name,
      cause,
      `Log destination "${name}" failed to initialize and will receive no entries. ` +
        'If no destination initializes, entries fall back to raw NDJSON on stdout.'
    )
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
    // Trace correlation was ASKED FOR and cannot be delivered. Without this line
    // the failure is invisible: `traceId` is simply absent from every entry, and
    // absence reads as "no active span" rather than "the peer is not installed".
    // That ambiguity cost the previous implementation its correlation silently
    // whenever the working directory was not the app root. Only warned when the
    // consumer opted in — a logger with auto-injection off is not missing
    // anything.
    if (this.options.otel.shouldAutoInjectTraceContext && detectOtelTraceApi() === undefined) {
      this.logger.warnStructured(
        RESERVED_LOG_KEYS.LOGGER_BOOTSTRAP_WARNING,
        'Trace-context auto-injection is enabled but @opentelemetry/api could not be ' +
          'resolved — traceId and spanId will be absent from every entry',
        undefined,
        { reason: 'OTEL_API_UNAVAILABLE', shouldAutoInjectTraceContext: true }
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
