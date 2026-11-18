/**
 * Public barrel of the `@bymax-one/nest-logger/observability` subpath: the Prometheus counters and
 * the readiness check of the logger. It needs the optional peers `@bymax-one/nest-core` and
 * `prom-client`; the main entry needs neither and imports nothing from here.
 *
 * @layer public-api
 */
export { BymaxLoggerObservabilityModule } from './observability.module'
export { LoggerMetricsContributor } from './logger-metrics.contributor'
export { LoggerHealthIndicator, LOGGER_HEALTH_INDICATOR_NAME } from './logger-health.indicator'
