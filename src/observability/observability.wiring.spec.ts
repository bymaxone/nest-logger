/**
 * Pins how the observability providers reach the logger: through `LOGGER_OBSERVABILITY_TOKEN`, which
 * `BymaxLoggerModule` exports. The module is global by default, so `BymaxLoggerObservabilityModule`
 * next to it resolves; with `isGlobal: false` the token is visible only to the modules that import
 * the logger module, so the two providers go in a module of the host that does.
 *
 * Layer: server, tests. Builds real Nest modules; no destination is started.
 */
import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'

import {
  BymaxLoggerObservabilityModule,
  LoggerHealthIndicator,
  LoggerMetricsContributor
} from './index'

const service = { name: 'wiring', version: '0.0.0' }

describe('how the providers reach the logger', () => {
  it('resolves both next to the global logger module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BymaxLoggerModule.forRoot({ service }), BymaxLoggerObservabilityModule]
    }).compile()

    expect(moduleRef.get(LoggerMetricsContributor)).toBeInstanceOf(LoggerMetricsContributor)
    expect(moduleRef.get(LoggerHealthIndicator)).toBeInstanceOf(LoggerHealthIndicator)
    await moduleRef.close()
  })

  it('resolves both in a module that imports a logger module that is not global', async () => {
    @Module({
      imports: [BymaxLoggerModule.forRoot({ service, isGlobal: false })],
      providers: [LoggerMetricsContributor, LoggerHealthIndicator]
    })
    class HostObservabilityModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [HostObservabilityModule]
    }).compile()

    expect(moduleRef.get(LoggerMetricsContributor)).toBeInstanceOf(LoggerMetricsContributor)
    expect(moduleRef.get(LoggerHealthIndicator)).toBeInstanceOf(LoggerHealthIndicator)
    await moduleRef.close()
  })

  it('cannot resolve them from a sibling of a logger module that is not global', async () => {
    const building = Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({ service, isGlobal: false }),
        BymaxLoggerObservabilityModule
      ]
    }).compile()

    await expect(building).rejects.toThrow(/LOGGER_OBSERVABILITY_TOKEN|BYMAX_LOGGER_OBSERVABILITY/)
  })
})
