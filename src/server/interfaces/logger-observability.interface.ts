/**
 * What the logger counts about itself, for a host that wants to publish it as metrics or as a
 * readiness check. Provided under `LOGGER_OBSERVABILITY_TOKEN`; the `/observability` subpath builds
 * the Prometheus counters and the health indicator on it.
 */

/** Why a field of an entry was cut or replaced: a closed set, safe to use as a metric label. */
export type TruncationReason = 'max_entry_size' | 'max_string_length'

/** The state of the fan-out to the destinations, read without sending anything. */
export interface DeliveryState {
  /** How many destinations have finished their `onInit`, healthy or failed. */
  readonly destinations: number
  /** How many of them failed their `onInit`. */
  readonly failedInit: number
  /** How many have refused a write or had an entry dropped since startup. */
  readonly writeFailing: number
  /** Whether at least one destination is healthy, so an entry can still be delivered. */
  readonly hasHealthySink: boolean
}

/** The counters and the delivery state of one logger, since the module started. */
export interface ILoggerObservability {
  /**
   * How many fields were cut or replaced for a reason: with `max_entry_size` a serializer output
   * over `maxEntrySizeBytes` (or one that could not be measured) or a derived exception field cut
   * to it, with `max_string_length` a string cut at `maxStringLength`. One field is one count.
   *
   * @param reason - The reason.
   * @returns The count since startup.
   */
  truncatedTotal(reason: TruncationReason): number

  /**
   * How many writes the destinations refused (they threw or rejected), over all destinations.
   *
   * @returns The count since startup.
   */
  destinationErrorTotal(): number

  /**
   * The state of the fan-out.
   *
   * @returns A snapshot; nothing is sent to a destination to produce it.
   */
  deliveryState(): DeliveryState
}
