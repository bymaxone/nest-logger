/**
 * Pins the deadlines of the destination lifecycle: a hook that never settles does not hold the
 * application, and shutdown ends within one budget however many destinations there are.
 *
 * The destinations are doubles, the timers are real and short, and the registry is built by hand with
 * the options a consumer would pass.
 */
import pino from 'pino'
import { Writable } from 'node:stream'

import { applyDefaults } from '../config/default-options'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import type { BymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'

import { DestinationHealth } from './destination-health.service'
import { DestinationRegistry } from './destination-registry.service'
import { PinoLoggerService } from './pino-logger.service'

/** A promise that settles only when `release` is called. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** The stderr text written during a case, joined. */
function stderrText(spy: jest.SpyInstance): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

describe('DestinationRegistry lifecycle deadlines', () => {
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

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    health = new DestinationHealth()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('onInit', () => {
    it('treats an onInit that does not settle in time as one that threw', async () => {
      const hung: ILogDestination = { name: 'hung', write: jest.fn(), onInit: () => gate().promise }
      const healthy: ILogDestination = { name: 'healthy', write: jest.fn() }
      const registry = registryOf([hung, healthy], { destinationHookTimeoutMs: 30 })

      await registry.onModuleInit()

      expect(registry.getActive()).toEqual([healthy])
      expect(health.isFailed(hung)).toBe(true)
      expect(stderrText(stderr)).toContain('LOGGER_DESTINATION_INIT_FAILED')
      expect(stderrText(stderr)).toContain('did not settle within 30 ms')
    })

    it('keeps a destination inactive when its abandoned onInit settles later', async () => {
      const late = gate()
      const onShutdown = jest.fn()
      const hung: ILogDestination = {
        name: 'hung',
        write: jest.fn(),
        onInit: () => late.promise,
        onShutdown
      }
      const registry = registryOf([hung], { destinationHookTimeoutMs: 20 })

      await registry.onModuleInit()
      late.release()
      await new Promise((resolve) => setTimeout(resolve, 20))
      await registry.onApplicationShutdown()

      expect(registry.getActive()).toEqual([])
      expect(health.isFailed(hung)).toBe(true)
      expect(onShutdown).not.toHaveBeenCalled()
    })
  })

  describe('onRegistryReady', () => {
    it('reports an onRegistryReady that does not settle in time and goes on', async () => {
      const slow: ILogDestination = {
        name: 'slow',
        write: jest.fn(),
        onRegistryReady: () => gate().promise
      }
      const next = jest.fn()
      const after: ILogDestination = { name: 'after', write: jest.fn(), onRegistryReady: next }
      const registry = registryOf([slow, after], { destinationHookTimeoutMs: 20 })

      await registry.onModuleInit()

      expect(next).toHaveBeenCalledTimes(1)
      expect(stderrText(stderr)).toContain('did not settle within 20 ms')
    })
  })

  describe('onApplicationShutdown', () => {
    it('ends within the total budget and names the destinations it did not call', async () => {
      const calls: string[] = []
      const hang = (name: string): ILogDestination => ({
        name,
        write: jest.fn(),
        onShutdown: () => {
          calls.push(name)
          return gate().promise
        }
      })
      const registry = registryOf([hang('a'), hang('b'), hang('c')], {
        shutdown: { timeoutMs: 120, drainTimeoutMs: 50 }
      })
      await registry.onModuleInit()
      const started = Date.now()

      await registry.onApplicationShutdown()

      expect(Date.now() - started).toBeLessThan(120 + 80)
      expect(calls).toEqual(['c'])
      expect(stderrText(stderr)).toContain('onShutdown not called for: "b", "a"')
    })

    it('calls every onShutdown when the budget is not spent', async () => {
      const order: string[] = []
      const make = (name: string): ILogDestination => ({
        name,
        write: jest.fn(),
        onShutdown: () => {
          order.push(name)
        }
      })
      const registry = registryOf([make('a'), make('b')])
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(order).toEqual(['b', 'a'])
      expect(stderrText(stderr)).not.toContain('not called')
    })

    it('goes on to the next destination after a slow onShutdown ran out of time', async () => {
      const second = jest.fn()
      const slow: ILogDestination = {
        name: 'slow',
        write: jest.fn(),
        onShutdown: () => gate().promise
      }
      const first: ILogDestination = { name: 'first', write: jest.fn(), onShutdown: second }
      const registry = registryOf([slow, first], {
        shutdown: { timeoutMs: 500, drainTimeoutMs: 50 }
      })
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(second).toHaveBeenCalledTimes(1)
      expect(stderrText(stderr)).toContain('Shutdown failed for "slow"')
    })
  })

  describe('drain', () => {
    /** A destination fronted by a stream that holds `queued` characters until released. */
    function queuedDestination(name: string, queued: number): ILogDestination {
      const destination: ILogDestination = { name, write: jest.fn() }
      const stream = new Writable({
        write(_chunk, _encoding, callback): void {
          void callback
        }
      })
      stream.write('x'.repeat(queued))
      health.registerStream(destination, stream)
      return destination
    }

    it('names the destinations and the queued sizes, and no entry content, when the drain ends', async () => {
      const destination = queuedDestination('stuck', 12)
      const registry = registryOf([destination], {
        shutdown: { timeoutMs: 200, drainTimeoutMs: 40 }
      })
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(stderrText(stderr)).toContain('entries still queued, by size: "stuck" (12)')
      expect(stderrText(stderr)).not.toContain('xxxx')
    })

    it('ends the drain at the total budget when the drain was set longer than it', async () => {
      const destination = queuedDestination('stuck', 3)
      const registry = registryOf([destination], {
        shutdown: { timeoutMs: 60, drainTimeoutMs: 600 }
      })
      await registry.onModuleInit()
      const started = Date.now()

      await registry.onApplicationShutdown()

      expect(Date.now() - started).toBeLessThan(60 + 80)
    })

    it('waits for a queue that empties within the drain budget', async () => {
      const destination: ILogDestination = { name: 'busy', write: jest.fn() }
      const stream = { writableLength: 5 }
      health.registerStream(destination, stream)
      const registry = registryOf([destination], {
        shutdown: { timeoutMs: 400, drainTimeoutMs: 300 }
      })
      await registry.onModuleInit()
      setTimeout(() => {
        stream.writableLength = 0
      }, 30)
      const started = Date.now()

      await registry.onApplicationShutdown()

      expect(Date.now() - started).toBeGreaterThanOrEqual(25)
      expect(stderrText(stderr)).not.toContain('entries still queued')
    })
  })
})
