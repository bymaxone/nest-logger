/**
 * E2E: the observability subpath through a real Nest application. `BymaxLoggerObservabilityModule`
 * next to `BymaxLoggerModule` resolves the counts of the logger by token, the metrics contributor
 * publishes what the application cut and what a destination refused on a real registry, and the
 * readiness check is up with a healthy destination.
 *
 * Layer: e2e, server (`BymaxLoggerObservabilityModule`, `BymaxLoggerModule`).
 */
import 'reflect-metadata'
import { Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import type { ILogDestination } from '@bymax-one/nest-logger'
import {
  BymaxLoggerObservabilityModule,
  LoggerHealthIndicator,
  LoggerMetricsContributor
} from '@bymax-one/nest-logger/observability'
import { Registry } from 'prom-client'

const refusing: ILogDestination = {
  name: 'refusing',
  write(): void {
    throw new Error('refused')
  }
}
const healthy: ILogDestination = { name: 'healthy', write: () => undefined }

async function run(act: (logger: Logger) => void): Promise<{ metrics: string; up: string }> {
  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-observability-subpath', version: '0.0.0' },
        maxStringLength: 64,
        destinations: [healthy, refusing]
      }),
      BymaxLoggerObservabilityModule
    ]
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  app.useLogger(app.get(PinoLoggerService))
  const registry = new Registry()
  app.get(LoggerMetricsContributor).registerMetrics(registry)
  act(new Logger('Subpath'))
  const metrics = await registry.metrics()
  const check = await app.get(LoggerHealthIndicator).check()
  await app.close()
  return { metrics, up: check.status }
}

describe('Logger E2E — the observability subpath', () => {
  it('publishes what the application cut and what a destination refused, and is up', async () => {
    const { metrics, up } = await run((logger) =>
      logger.warn({ event: 'LIB_EVENT', detail: 'x'.repeat(500) })
    )

    expect(metrics).toMatch(
      /bymax_logger_entries_truncated_total\{reason="max_string_length"\} [1-9]/
    )
    expect(metrics).toMatch(/bymax_logger_entries_truncated_total\{reason="max_entry_size"\} 0/)
    expect(metrics).toMatch(/bymax_logger_destination_errors_total [1-9]/)
    expect(up).toBe('up')
  })
})
