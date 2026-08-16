/**
 * Init-health record shared by the destination registry and the write fan-out.
 *
 * Layer: server/services — an internal (NOT exported) NestJS provider holding
 * one fact per destination: did its `onInit()` succeed?
 *
 * It exists because of an ordering constraint. `pino.multistream` is wired by a
 * `useFactory` while NestJS assembles the DI graph — strictly before
 * `DestinationRegistry.onModuleInit` discovers which sinks came up — so the
 * fan-out cannot be built from the surviving set. Rebuilding it afterwards would
 * need `multistream.remove()`, which exists at runtime but is absent from Pino's
 * published `MultiStreamRes` typings and is keyed by an internal stream id; a
 * correctness fix does not get to depend on an undocumented API. The streams stay
 * and consult this record instead.
 *
 * Two behaviours fall out of it: a failed sink stops receiving writes, and if
 * EVERY sink failed one is elected to rescue the entry as raw NDJSON on stdout,
 * so a misconfiguration degrades instead of going silent.
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
   * Destinations that initialized, each with its effective level as an index into
   * {@link LOG_LEVEL_PRIORITY}.
   *
   * Keyed by identity rather than reduced to a flag or a minimum, because the
   * question a buffering destination asks is "did SOMEONE ELSE receive what I
   * received?" — and a minimum cannot exclude the asker. A destination that is
   * itself the only healthy sink would otherwise be told its held entries were
   * delivered elsewhere, and discard its only copies.
   *
   * The level matters for the same reason it does everywhere here: `pino.multistream`
   * filters per stream, so "alive" and "received what I received" are different
   * facts.
   */
  private readonly healthy = new Map<ILogDestination, number>()

  /**
   * Destinations whose `write()` threw or rejected at least once.
   *
   * Init health says a sink is LIVE; it does not say the sink accepted anything.
   * A destination that throws on write is reported and skipped per entry, so
   * inferring delivery from level alone would credit it with entries it dropped.
   * Uncertainty drains, so any write failure disqualifies it as proof of delivery
   * for the whole window — coarser than per-entry tracking, and wrong only in the
   * direction that duplicates rather than loses.
   */
  private readonly writeFailed = new Set<ILogDestination>()

  /** The failed destination designated to rescue entries, if any. */
  private rescuer: ILogDestination | undefined

  /**
   * The rescuer's severity index within {@link LOG_LEVEL_PRIORITY}. Starts above
   * every real level so the first `markFailed` always wins the comparison.
   */
  private rescuerLevel = Number.POSITIVE_INFINITY

  /**
   * Record that a destination initialized successfully.
   *
   * @param effectiveLevel - Its multistream level: `minLevel` when set, otherwise
   *   the module-wide `level`.
   */
  /**
   * Record that a destination's `write()` threw or rejected.
   *
   * Called from the fan-out's failure path, which already reports the entry as
   * dropped. This is what stops {@link deliveredByHealthySink} from crediting a
   * throwing sink with entries it never accepted.
   *
   * @param destination - The destination whose write failed.
   */
  markWriteFailed(destination: ILogDestination): void {
    this.writeFailed.add(destination)
  }

  markHealthy(destination: ILogDestination, effectiveLevel: LogLevel): void {
    this.healthy.set(destination, LOG_LEVEL_PRIORITY.indexOf(effectiveLevel))
  }

  /**
   * Record that a destination failed to initialize, and re-elect the rescuer.
   *
   * The rescuer is the failed destination with the LOWEST effective level, ties
   * broken by registration order (the comparison is strict). Registration order
   * alone is deterministic but arbitrary: a `warn` sink registered before an
   * `info` one would rescue at `warn` and silently drop the `info` entries the
   * second was configured to receive, and swapping the array would change the
   * output for the same configuration. Electing by level rescues the UNION of
   * what the consumer asked to see.
   *
   * Inheriting a level filter at all is deliberate — `minLevel` is the consumer's
   * own instruction, so the rescue delivers what a working sink would have, never
   * more. The one entry that must never be filtered, the init failure itself, goes
   * straight to stderr, outside the multistream.
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
    return this.healthy.size === 0 && this.rescuer === destination
  }

  /**
   * Whether ANY destination initialized, regardless of level.
   *
   * Read together with {@link deliveredByHealthySink}: "a sink is alive" and "a
   * sink received what I received" are different facts, and the gap between them
   * is a live sink whose level sits ABOVE the asking destination's.
   *
   * @returns `true` when at least one destination is live.
   */
  hasHealthySink(): boolean {
    return this.healthy.size > 0
  }

  /**
   * Whether a LIVE sink received everything a destination at `effectiveLevel`
   * received — the question a destination holding pre-init entries actually has
   * before discarding them.
   *
   * Not "did any sink survive": `pino.multistream` filters per stream, so a
   * healthy `error` sink never saw the `info` entries a pretty sink at `info`
   * buffered. Discarding those because something else was alive would lose them,
   * which is the failure the buffer exists to prevent. A healthy sink whose level
   * is at or below this one accepted a superset, so those entries are delivered.
   *
   * @param effectiveLevel - The asking destination's multistream level.
   * @returns `true` when a live sink accepted everything this destination did.
   */
  deliveredByHealthySink(asking: ILogDestination, effectiveLevel: LogLevel): boolean {
    const level = LOG_LEVEL_PRIORITY.indexOf(effectiveLevel)
    for (const [destination, healthyLevel] of this.healthy) {
      if (destination !== asking && !this.writeFailed.has(destination) && healthyLevel <= level) {
        return true
      }
    }
    return false
  }
}
