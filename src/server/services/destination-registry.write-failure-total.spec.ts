/**
 * Pins that shutdown says how many writes each destination failed in total, so the throttle on the
 * per-failure report never hides the size of a refusal.
 *
 * Layer: server/services, tests.
 */
import pino from 'pino'

import { applyDefaults } from '../config/default-options'
import type { ILogDestination } from '../interfaces/log-destination.interface'

import { DestinationHealth } from './destination-health.service'
import { DestinationRegistry } from './destination-registry.service'
import { PinoLoggerService } from './pino-logger.service'

describe('DestinationRegistry, the failed-write total at shutdown', () => {
  let stderr: jest.SpyInstance
  let health: DestinationHealth

  function registryOf(destinations: ILogDestination[]): DestinationRegistry {
    const options = applyDefaults({ service: { name: 'app', version: '1.0.0' } })
    const logger = new PinoLoggerService(pino({ enabled: false }))
    jest.spyOn(logger, 'info').mockImplementation(() => undefined)
    return new DestinationRegistry(destinations, logger, options, health)
  }

  const text = (): string => stderr.mock.calls.map((call) => String(call[0])).join('')

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    health = new DestinationHealth()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('names each destination that failed more than one write, with its count', async () => {
    const refuser: ILogDestination = { name: 'refuser', write: jest.fn() }
    const once: ILogDestination = { name: 'once', write: jest.fn() }
    const clean: ILogDestination = { name: 'clean', write: jest.fn() }
    const registry = registryOf([refuser, once, clean])
    await registry.onModuleInit()
    for (let i = 0; i < 7; i += 1) health.recordWriteFailure(refuser, 1000)
    health.recordWriteFailure(once, 1000)

    await registry.onApplicationShutdown()

    expect(text()).toContain('Destination "refuser" failed 7 writes in total')
    expect(text()).not.toContain('"once" failed')
    expect(text()).not.toContain('"clean" failed')
  })
})
