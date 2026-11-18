/**
 * The Prometheus counters of the logger, published on the registry `@bymax-one/nest-core` serves.
 *
 * Layer: observability. A provider marked as a metrics contributor: the module that collects the
 * metrics calls `registerMetrics` once at bootstrap, with its registry. The counters read the
 * logger's own counts at scrape time, through the `collect` hook, so a log call pays no more than
 * the increment it always paid, and a scrape pays one pass over a closed set of labels.
 */
import { BymaxMetricsContributor } from '@bymax-one/nest-core/metrics'
import type { IMetricsContributor, MetricsRegistry } from '@bymax-one/nest-core/metrics'
import { Inject, Injectable } from '@nestjs/common'
import { Counter } from 'prom-client'

import { LOGGER_OBSERVABILITY_TOKEN } from '@bymax-one/nest-logger'
import type { ILoggerObservability, TruncationReason } from '@bymax-one/nest-logger'

/** The closed set of values of the `reason` label. */
const TRUNCATION_REASONS: readonly TruncationReason[] = ['max_entry_size', 'max_string_length']

/**
 * A reader of the growth of a count since it was last read, which is what a Prometheus counter is
 * incremented by at each scrape.
 *
 * @param read - Reads the running total.
 * @returns A function that gives the total gained since its previous call.
 */
function growthOf(read: () => number): () => number {
  let last = 0
  return () => {
    const total = read()
    const growth = total - last
    last = total
    return growth
  }
}

/**
 * Registers `bymax_logger_entries_truncated_total{reason}` and
 * `bymax_logger_destination_errors_total` on the registry it is given.
 */
@BymaxMetricsContributor()
@Injectable()
export class LoggerMetricsContributor implements IMetricsContributor {
  /**
   * @param observability - The counts of the logger, provided by `BymaxLoggerModule`.
   */
  constructor(
    @Inject(LOGGER_OBSERVABILITY_TOKEN) private readonly observability: ILoggerObservability
  ) {}

  /**
   * Create the two counters on `registry`. Each `reason` series exists from the first scrape, at
   * zero, so a rate over it never starts from a missing series.
   *
   * @param registry - The registry the scrape endpoint serves.
   */
  registerMetrics(registry: MetricsRegistry): void {
    const observability = this.observability
    const growth = new Map(
      TRUNCATION_REASONS.map((reason) => [
        reason,
        growthOf(() => observability.truncatedTotal(reason))
      ])
    )
    new Counter({
      name: 'bymax_logger_entries_truncated_total',
      help: 'Fields of a log entry cut or replaced for a size bound, by reason.',
      labelNames: ['reason'],
      registers: [registry],
      collect(): void {
        for (const [reason, next] of growth) this.labels(reason).inc(next())
      }
    })
    const errors = growthOf(() => observability.destinationErrorTotal())
    new Counter({
      name: 'bymax_logger_destination_errors_total',
      help: 'Writes to a log destination that threw or rejected.',
      registers: [registry],
      collect(): void {
        this.inc(errors())
      }
    })
  }
}
