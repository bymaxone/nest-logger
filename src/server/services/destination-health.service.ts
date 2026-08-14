/**
 * Init-health record shared by the destination registry and the write fan-out.
 *
 * Layer: server/services — an internal (NOT exported) NestJS provider holding
 * one fact per destination: did its `onInit()` succeed?
 *
 * It exists because of an ordering constraint that cannot be removed cheaply.
 * The Pino instance is built by a `useFactory` while NestJS assembles the DI
 * graph, so `pino.multistream` is wired from the FULL registered list — strictly
 * before `DestinationRegistry.onModuleInit` has had the chance to discover which
 * sinks actually came up. Rebuilding the fan-out afterwards would mean either
 * restructuring the module or reaching for `multistream.remove()`, which exists
 * at runtime but is absent from Pino's published `MultiStreamRes` typings and is
 * keyed by an internal auto-incrementing stream id. A correctness fix does not
 * get to depend on an undocumented API, so the stream stays and consults this
 * record instead.
 *
 * Two behaviours fall out of the same record:
 *   - a failed sink stops receiving writes (it was never able to accept them);
 *   - if EVERY sink failed, one of them is designated to rescue the entry as raw
 *     NDJSON on stdout, so a misconfiguration degrades instead of going silent.
 */
import { Injectable } from '@nestjs/common'

import type { LogLevel } from '../../shared/types/log-level.type'
import { LOG_LEVEL_PRIORITY } from '../constants/log-levels.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'

/**
 * Tracks which destinations initialized, and which one speaks when none did.
 *
 * @example
 *   // Written by DestinationRegistry during onModuleInit, read by the
 *   // Writable wrapper in destinationToStream on every entry.
 *   health.markFailed(destination, 'info')
 *   health.isFailed(destination)     // true  → not a live sink
 *   health.shouldRescue(destination) // true  → and nothing else survived
 */
@Injectable()
export class DestinationHealth {
  /** Destinations whose `onInit()` rejected. Identity-keyed, not name-keyed. */
  private readonly failed = new Set<ILogDestination>()

  /**
   * Whether ANY destination initialized successfully.
   *
   * A boolean rather than a count, deliberately: the only question ever asked of
   * it is "is there somewhere to write?". Mutation testing made the point — a
   * counter incremented with `+=` survived being flipped to `-=`, because
   * `count === 0` means the same thing either way. A value whose arithmetic
   * cannot be observed was not a counter, it was a flag wearing a number.
   */
  private hasHealthy = false

  /** The failed destination designated to rescue entries, if any. */
  private rescuer: ILogDestination | undefined

  /**
   * The rescuer's severity index within {@link LOG_LEVEL_PRIORITY}. Starts above
   * every real level so the first `markFailed` always wins the comparison.
   */
  private rescuerLevel = Number.POSITIVE_INFINITY

  /** Record that a destination initialized successfully. */
  markHealthy(): void {
    this.hasHealthy = true
  }

  /**
   * Record that a destination failed to initialize, and re-elect the rescuer.
   *
   * The rescuer is the failed destination with the LOWEST effective level, ties
   * broken by registration order (the comparison is strict, so the first one
   * marked keeps the slot). Registration order alone would have been
   * deterministic but arbitrary: given a `warn` sink registered before an `info`
   * one, it would rescue at `warn` and silently drop the `info` entries the
   * second sink was configured to receive — and swapping the array would change
   * the output for the same configuration. Electing by level rescues the UNION of
   * what the consumer asked to see, which is the only defensible reading of a
   * last resort.
   *
   * Inheriting a level filter at all is deliberate: `minLevel` is the consumer's
   * own instruction, and a rescue that ignored it would deliver entries they had
   * filtered out, in the one moment they least expect output. The one entry that
   * must never be filtered — the init failure itself — does not travel this path:
   * it goes straight to stderr, outside the multistream.
   *
   * @param destination - The destination whose `onInit()` rejected.
   * @param effectiveLevel - Its multistream level: `minLevel` when set, otherwise
   *   the module-wide `level`.
   */
  markFailed(destination: ILogDestination, effectiveLevel: LogLevel): void {
    this.failed.add(destination)
    // `LOG_LEVEL_PRIORITY` is ordered low → high severity, so its index IS the
    // comparison key. Used instead of indexing `PINO_LEVEL_NUMBERS` by the level
    // string: the two orderings are identical, and a lookup keyed by a value
    // rather than a literal is an object-injection sink the linter flags — which
    // it should, even when the type makes it safe here.
    const level = LOG_LEVEL_PRIORITY.indexOf(effectiveLevel)
    if (level < this.rescuerLevel) {
      this.rescuer = destination
      this.rescuerLevel = level
    }
  }

  /**
   * Whether a destination failed to initialize and must not receive writes.
   *
   * @param destination - The destination backing a fan-out stream.
   * @returns `true` when its `onInit()` rejected.
   */
  isFailed(destination: ILogDestination): boolean {
    return this.failed.has(destination)
  }

  /**
   * Whether this destination is the one that must write the entry as raw NDJSON
   * to stdout because NOTHING initialized.
   *
   * Exactly one failed destination can satisfy this, so N failed sinks rescue an
   * entry once rather than N times.
   *
   * @param destination - The destination backing a fan-out stream.
   * @returns `true` when no destination initialized and this one is the elected
   *   rescuer.
   */
  shouldRescue(destination: ILogDestination): boolean {
    return !this.hasHealthy && this.rescuer === destination
  }
}
