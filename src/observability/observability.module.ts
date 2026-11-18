/**
 * The module that registers the two observability providers.
 *
 * Layer: observability. Import it next to `BymaxLoggerModule`: the providers read the logger
 * through `LOGGER_OBSERVABILITY_TOKEN`, which the global `BymaxLoggerModule` exports.
 */
import { Module } from '@nestjs/common'

import { LoggerHealthIndicator } from './logger-health.indicator'
import { LoggerMetricsContributor } from './logger-metrics.contributor'

/**
 * Provides {@link LoggerMetricsContributor} and {@link LoggerHealthIndicator}, which
 * `@bymax-one/nest-core` finds by their markers. With `isGlobal: false` on `BymaxLoggerModule`,
 * import that module here too.
 */
@Module({
  providers: [LoggerMetricsContributor, LoggerHealthIndicator],
  exports: [LoggerMetricsContributor, LoggerHealthIndicator]
})
export class BymaxLoggerObservabilityModule {}
