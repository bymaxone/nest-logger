/**
 * The module that registers the two observability providers.
 *
 * Layer: observability. Import it next to `BymaxLoggerModule`: the providers read the logger
 * through `LOGGER_OBSERVABILITY_TOKEN`, which the global `BymaxLoggerModule` exports. This module
 * imports nothing, so it resolves the token only while the logger module is global, which is the
 * default.
 */
import { Module } from '@nestjs/common'

import { LoggerHealthIndicator } from './logger-health.indicator'
import { LoggerMetricsContributor } from './logger-metrics.contributor'

/**
 * Provides {@link LoggerMetricsContributor} and {@link LoggerHealthIndicator}, which
 * `@bymax-one/nest-core` finds by their markers. With `isGlobal: false` on `BymaxLoggerModule`,
 * do not import this module: list both providers in a module of yours that imports the logger module.
 */
@Module({
  providers: [LoggerMetricsContributor, LoggerHealthIndicator],
  exports: [LoggerMetricsContributor, LoggerHealthIndicator]
})
export class BymaxLoggerObservabilityModule {}
