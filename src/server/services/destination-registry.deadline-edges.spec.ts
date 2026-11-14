/**
 * Pins the edges of the shutdown deadlines: the instant a budget is exactly spent, the wait between
 * two looks at a queue, and the line that names what is still queued.
 *
 * The monotonic clock is scripted, so a budget can be spent to the millisecond and no case depends on
 * how fast the machine runs.
 */
import pino from 'pino'

import { applyDefaults } from '../config/default-options'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

import { DestinationHealth } from './destination-health.service'
import { DestinationRegistry } from './destination-registry.service'
import { PinoLoggerService } from './pino-logger.service'

describe('DestinationRegistry shutdown deadline edges', () => {
  let stderr: jest.SpyInstance
  let health: DestinationHealth

  /** A registry over `destinations` with the given timing options. */
  function registryOf(
    destinations: ILogDestination[],
    timing: Partial<BymaxLoggerModuleOptions> = {}
  ): DestinationRegistry {
    const options = applyDefaults({ service: { name: 'app', version: '1.0.0' }, ...timing })
    const logger = new PinoLoggerService(pino({ enabled: false }))
    jest.spyOn(logger, 'info').mockImplementation(() => undefined)
    return new DestinationRegistry(destinations, logger, options, health)
  }

  /** The clock reads `first` once, for the start of shutdown, and `then` from there on. */
  function scriptClock(first: number, then: number): void {
    const readings = [first]
    jest.spyOn(performance, 'now').mockImplementation(() => readings.shift() ?? then)
  }

  const text = (): string => stderr.mock.calls.map((call) => String(call[0])).join('')

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    health = new DestinationHealth()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('skips an onShutdown reached at the exact instant the budget is spent, and names it', async () => {
    const onShutdown = jest.fn()
    const destination: ILogDestination = { name: 'late', write: jest.fn(), onShutdown }
    const registry = registryOf([destination], { shutdown: { timeoutMs: 100, drainTimeoutMs: 50 } })
    await registry.onModuleInit()
    scriptClock(1000, 1100)

    await registry.onApplicationShutdown()

    expect(onShutdown).not.toHaveBeenCalled()
    expect(text()).toContain('onShutdown not called for: "late"')
  })

  it('calls an onShutdown reached one millisecond before the budget is spent', async () => {
    const onShutdown = jest.fn()
    const destination: ILogDestination = { name: 'on-time', write: jest.fn(), onShutdown }
    const registry = registryOf([destination], { shutdown: { timeoutMs: 100, drainTimeoutMs: 50 } })
    await registry.onModuleInit()
    scriptClock(1000, 1099)

    await registry.onApplicationShutdown()

    expect(onShutdown).toHaveBeenCalledTimes(1)
    expect(text()).not.toContain('not called')
  })

  it('ends the drain at the exact instant its deadline is reached, and reports what is queued', async () => {
    const destination: ILogDestination = { name: 'stuck', write: jest.fn() }
    health.registerStream(destination, { queuedBytes: 7 })
    const registry = registryOf([destination], { shutdown: { timeoutMs: 100, drainTimeoutMs: 50 } })
    await registry.onModuleInit()
    scriptClock(1000, 1050)

    await registry.onApplicationShutdown()

    expect(text()).toContain('entries still queued, by size: "stuck" (7)')
  })

  it('names every destination still queued, separated, with each queued size', async () => {
    const first: ILogDestination = { name: 'first', write: jest.fn() }
    const second: ILogDestination = { name: 'second', write: jest.fn() }
    health.registerStream(first, { queuedBytes: 3 })
    health.registerStream(second, { queuedBytes: 4 })
    const registry = registryOf([first, second], {
      shutdown: { timeoutMs: 100, drainTimeoutMs: 50 }
    })
    await registry.onModuleInit()
    scriptClock(1000, 1050)

    await registry.onApplicationShutdown()

    expect(text()).toContain('"first" (3), "second" (4)')
  })

  it('never waits longer than what is left of the drain between two looks at a queue', async () => {
    const destination: ILogDestination = { name: 'stuck', write: jest.fn() }
    health.registerStream(destination, { queuedBytes: 1 })
    const registry = registryOf([destination], { shutdown: { timeoutMs: 100, drainTimeoutMs: 3 } })
    await registry.onModuleInit()
    // Shutdown starts at 1000, the first look is at 1001 with 2 ms left, the next is past the deadline.
    const readings = [1000, 1001]
    jest.spyOn(performance, 'now').mockImplementation(() => readings.shift() ?? 1003)
    const timer = jest.spyOn(globalThis, 'setTimeout')

    await registry.onApplicationShutdown()

    // A wait of the poll interval (5 ms) would pass the deadline by 3 ms.
    const waits = timer.mock.calls.map((call) => Number(call[1]))
    expect(waits).toContain(2)
    expect(waits).not.toContain(5)
  })
})
