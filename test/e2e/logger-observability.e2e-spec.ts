/**
 * E2E: the counters and the delivery state of the logger are readable through
 * `LOGGER_OBSERVABILITY_TOKEN` from a real Nest application: a string cut at `maxStringLength` is
 * counted under `max_string_length`, a destination that refuses a write is counted as an error and
 * its state is visible, and with nothing cut and nothing refused every counter is zero.
 *
 * Layer: e2e, server (`BymaxLoggerModule`, `DestinationHealth`).
 */
import 'reflect-metadata'
import { Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import {
  BymaxLoggerModule,
  LOGGER_OBSERVABILITY_TOKEN,
  PinoLoggerService
} from '@bymax-one/nest-logger'
import type {
  BymaxLoggerModuleOptions,
  ILogDestination,
  ILoggerObservability
} from '@bymax-one/nest-logger'

async function observe(
  act: (logger: Logger) => void,
  extra: Partial<BymaxLoggerModuleOptions>
): Promise<ILoggerObservability> {
  @Module({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-observability', version: '0.0.0' },
        ...extra
      })
    ]
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
  app.useLogger(app.get(PinoLoggerService))
  const observability = app.get<ILoggerObservability>(LOGGER_OBSERVABILITY_TOKEN, { strict: false })
  act(new Logger('Observe'))
  const snapshot = {
    truncatedTotal: observability.truncatedTotal.bind(observability),
    destinationErrorTotal: observability.destinationErrorTotal.bind(observability),
    deliveryState: observability.deliveryState.bind(observability)
  }
  const frozen = {
    entry: snapshot.truncatedTotal('max_entry_size'),
    string: snapshot.truncatedTotal('max_string_length'),
    errors: snapshot.destinationErrorTotal(),
    state: snapshot.deliveryState()
  }
  await app.close()
  return {
    truncatedTotal: (reason) => (reason === 'max_entry_size' ? frozen.entry : frozen.string),
    destinationErrorTotal: () => frozen.errors,
    deliveryState: () => frozen.state
  }
}

describe('Logger E2E — the observability view', () => {
  it('counts nothing when nothing is cut or refused', async () => {
    const view = await observe((logger) => logger.log('quiet'), { maxStringLength: 64 })

    expect(view.truncatedTotal('max_entry_size')).toBe(0)
    expect(view.truncatedTotal('max_string_length')).toBe(0)
    expect(view.destinationErrorTotal()).toBe(0)
    expect(view.deliveryState()).toMatchObject({ failedInit: 0, hasHealthySink: true })
  })

  it('counts a string cut at maxStringLength', async () => {
    const view = await observe(
      (logger) => logger.warn({ event: 'LIB_EVENT', detail: 'x'.repeat(500) }),
      {
        maxStringLength: 64
      }
    )

    expect(view.truncatedTotal('max_string_length')).toBeGreaterThanOrEqual(1)
    expect(view.truncatedTotal('max_entry_size')).toBe(0)
  })

  it('counts a write a destination refused, and shows it in the delivery state', async () => {
    const refusing: ILogDestination = {
      name: 'refusing',
      write(): void {
        throw new Error('refused')
      }
    }
    const healthy: ILogDestination = { name: 'healthy', write: () => undefined }

    const view = await observe((logger) => logger.warn('to both'), {
      destinations: [healthy, refusing]
    })

    expect(view.destinationErrorTotal()).toBeGreaterThanOrEqual(1)
    expect(view.deliveryState()).toMatchObject({ destinations: 2, hasHealthySink: true })
    expect(view.deliveryState().writeFailing).toBeGreaterThanOrEqual(1)
  })
})
