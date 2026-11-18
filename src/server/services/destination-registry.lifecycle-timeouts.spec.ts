/**
 * Covers DestinationRegistry lifecycle deadlines: an onInit that does not settle counts as failed,
 * an onRegistryReady that does not settle is reported and the next hook runs, a shutdown hook is
 * held to the budget left, and the drain and drop tally report sizes and counts.
 * Layer: server/services, tests.
 */
import pino from 'pino'

import { applyDefaults } from '../config/default-options'
import { DefaultStdoutDestination } from '../destinations/default-stdout.destination'
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
      // The clock reads 1000 at the start and at the first hook, and 1120, the end of the budget, from
      // then on: whatever the real timer of the first hook does, the other two find nothing left.
      const readings = [1000, 1000]
      jest.spyOn(performance, 'now').mockImplementation(() => readings.shift() ?? 1120)
      const timer = jest.spyOn(globalThis, 'setTimeout')

      await registry.onApplicationShutdown()

      expect(calls).toEqual(['c'])
      expect(stderrText(stderr)).toContain('onShutdown not called for: "b", "a"')
      // The first hook is held to what is left of the budget, 120 ms, and no timer is longer: a hook
      // given more would hold shutdown past its total.
      const delays = timer.mock.calls.map((call) => Number(call[1]))
      expect(delays).toContain(120)
      expect(Math.max(...delays)).toBeLessThanOrEqual(120)
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

    it('reports a timed-out onShutdown at the budget, after the destination before it completed', async () => {
      const order: string[] = []
      const slow: ILogDestination = {
        name: 'slow',
        write: jest.fn(),
        onShutdown: () => {
          order.push('slow')
          return gate().promise
        }
      }
      const first: ILogDestination = {
        name: 'first',
        write: jest.fn(),
        onShutdown: () => {
          order.push('first')
        }
      }
      // Shutdown runs in reverse registration order, so `first` is called, and completes, before `slow`.
      const registry = registryOf([slow, first], {
        shutdown: { timeoutMs: 80, drainTimeoutMs: 40 }
      })
      await registry.onModuleInit()

      await registry.onApplicationShutdown()

      expect(order).toEqual(['first', 'slow'])
      const reported = stderrText(stderr)
        .split('\n')
        .filter((line) => line.includes('LOGGER_DESTINATION_SHUTDOWN_FAILED'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(reported).toHaveLength(1)
      expect(reported[0]).toMatchObject({ destination: 'slow', err: { type: 'HookTimeoutError' } })
    })
  })

  describe('drain', () => {
    /** A destination whose queue holds `queued` bytes and never empties. */
    function queuedDestination(name: string, queued: number): ILogDestination {
      const destination: ILogDestination = { name, write: jest.fn() }
      health.registerStream(destination, { queuedBytes: queued })
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
      // The total ends at 1060 and the drain was set to 1600. The first look is at 1059, with 1 ms left
      // of the total, and every later one at 1060: only a drain held to the total ends, and reports.
      const readings = [1000, 1059]
      jest.spyOn(performance, 'now').mockImplementation(() => readings.shift() ?? 1060)

      await registry.onApplicationShutdown()

      expect(stderrText(stderr)).toContain('entries still queued, by size: "stuck" (3)')
    })

    it('waits for a queue that empties within the drain budget, and no longer than that', async () => {
      const destination: ILogDestination = { name: 'busy', write: jest.fn() }
      const stream = { queuedBytes: 5 }
      health.registerStream(destination, stream)
      const registry = registryOf([destination], {
        shutdown: { timeoutMs: 400, drainTimeoutMs: 300 }
      })
      await registry.onModuleInit()
      // The clock is scripted: the queue empties at 30 ms of it, and the drain looks every 5 ms of it.
      jest.useFakeTimers()
      try {
        setTimeout(() => {
          stream.queuedBytes = 0
        }, 30)
        const started = performance.now()
        let settledAt: number | undefined
        const shutdown = registry.onApplicationShutdown().then(() => {
          settledAt = performance.now()
        })

        await jest.advanceTimersByTimeAsync(400)
        await shutdown

        // Not before the queue emptied, and not as late as the drain budget (300 ms).
        expect(settledAt).toBeDefined()
        expect((settledAt ?? 0) - started).toBeGreaterThanOrEqual(30)
        expect((settledAt ?? 0) - started).toBeLessThan(35)
        expect(stderrText(stderr)).not.toContain('entries still queued')
      } finally {
        jest.useRealTimers()
      }
    })
    /*
     * Nest raises the signal again when the shutdown hooks return, which ends the process, so what
     * `process.stdout` still holds then is lost. The drain waits for it, for the default stdout
     * destination only: another destination's own buffer may flush only in `onShutdown`.
     */
    describe('what process.stdout holds', () => {
      let held: number
      beforeEach(() => {
        held = 0
        Object.defineProperty(process.stdout, 'writableLength', {
          configurable: true,
          get: () => held
        })
      })

      afterEach(() => {
        Reflect.deleteProperty(process.stdout, 'writableLength')
      })

      it('waits for the default stdout destination while stdout holds bytes, and no longer', async () => {
        const registry = registryOf([new DefaultStdoutDestination()], {
          shutdown: { timeoutMs: 400, drainTimeoutMs: 300 }
        })
        await registry.onModuleInit()
        held = 9
        jest.useFakeTimers()
        try {
          setTimeout(() => {
            held = 0
          }, 30)
          const started = performance.now()
          let settledAt: number | undefined
          const shutdown = registry.onApplicationShutdown().then(() => {
            settledAt = performance.now()
          })

          await jest.advanceTimersByTimeAsync(400)
          await shutdown

          expect((settledAt ?? 0) - started).toBeGreaterThanOrEqual(30)
          expect((settledAt ?? 0) - started).toBeLessThan(35)
          expect(stderrText(stderr)).not.toContain('entries still queued')
        } finally {
          jest.useRealTimers()
        }
      })

      it('names it with the bytes stdout holds when the drain ends', async () => {
        const registry = registryOf([new DefaultStdoutDestination()], {
          shutdown: { timeoutMs: 200, drainTimeoutMs: 40 }
        })
        await registry.onModuleInit()
        held = 7
        jest.useFakeTimers()
        try {
          const shutdown = registry.onApplicationShutdown()
          await jest.advanceTimersByTimeAsync(300)
          await shutdown
        } finally {
          jest.useRealTimers()
        }

        expect(stderrText(stderr)).toContain('entries still queued, by size: "stdout-json" (7)')
      })

      it('does not wait for a destination that is not the default one', async () => {
        const registry = registryOf([{ name: 'other', write: jest.fn() }], {
          shutdown: { timeoutMs: 200, drainTimeoutMs: 40 }
        })
        await registry.onModuleInit()
        held = 7

        await registry.onApplicationShutdown()

        expect(stderrText(stderr)).not.toContain('entries still queued')
      })
    })
  })

  describe('the drop tally', () => {
    it('says once, at shutdown, how many entries each destination had dropped, and not for one that dropped none', async () => {
      const dropper: ILogDestination = { name: 'dropper', write: jest.fn() }
      const clean: ILogDestination = { name: 'clean', write: jest.fn() }
      const registry = registryOf([dropper, clean])
      await registry.onModuleInit()
      health.recordDrop(dropper, 0)
      health.recordDrop(dropper, 1)

      await registry.onApplicationShutdown()

      expect(stderrText(stderr)).toContain(
        'Destination "dropper" dropped 2 entries in total because its queue was full'
      )
      expect(stderrText(stderr)).not.toContain('"clean" dropped')
    })
  })
})
