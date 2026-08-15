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

  /**
   * The LOWEST effective level among destinations that initialized, as an index
   * into {@link LOG_LEVEL_PRIORITY}. Starts above every real level so the first
   * `markHealthy` always wins.
   *
   * A level rather than a boolean because `pino.multistream` filters PER stream:
   * an entry reaches a destination only when its severity clears that
   * destination's own level. So "a sink survived" does not mean "your entry went
   * somewhere" — a healthy `error` sink never saw the `info` boot entries a
   * pretty sink at `info` was holding.
   */
  private lowestHealthyLevel = Number.POSITIVE_INFINITY

  /**
   * Record that a destination initialized successfully.
   *
   * @param effectiveLevel - Its multistream level: `minLevel` when set, otherwise
   *   the module-wide `level`.
   */
  markHealthy(effectiveLevel: LogLevel): void {
    this.hasHealthy = true
    // `Math.min` rather than a compare-and-assign branch. The branch left two
    // mutants alive that no test could kill: `<` → `<=` reassigns the identical
    // value, and the guard exists only to keep the smallest. Expressing "keep the
    // smallest" directly removes the branch instead of documenting why nothing
    // can observe it.
    this.lowestHealthyLevel = Math.min(
      this.lowestHealthyLevel,
      LOG_LEVEL_PRIORITY.indexOf(effectiveLevel)
    )
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
    return !this.hasHealthy && this.rescuer === destination
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
    return this.hasHealthy
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
  deliveredByHealthySink(effectiveLevel: LogLevel): boolean {
    return this.hasHealthy && this.lowestHealthyLevel <= LOG_LEVEL_PRIORITY.indexOf(effectiveLevel)
  }
}
