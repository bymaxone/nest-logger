/**
 * Verifies that no outcome the logger reads depends on `Promise.resolve`: a program that replaces it
 * after the library loaded (a polyfill, a patched runtime) must not turn a `down` health verdict into
 * `up`, a failed hook into a settled one, a failed write into an unrecorded one, or hand the process
 * a rejection nobody absorbs.
 *
 * Layer: server, tests. The static is replaced only for the synchronous call that would read it and
 * restored at once, so no case holds the replacement across an await.
 */
import { LoggerHealthIndicator } from '../observability/logger-health.indicator'

import type { ILogDestination } from './interfaces/log-destination.interface'
import { RequestIdMiddleware } from './middlewares/request-id.middleware'
import { applyDefaults } from './config/default-options'
import { LogContextService } from './services/log-context.service'
import { DestinationHealth } from './services/destination-health.service'
import { destinationToStream } from './utils/destination-to-stream'
import { absorb, intactOr, PromiseTamperedError } from './utils/native-promise.util'
import { withTimeout } from './utils/with-timeout.util'

import type { LoggableRequest, LoggableResponse } from './interfaces/http-context.interface'

/** Runs `act` while `Promise.resolve` is `forged`, and puts the real one back before returning. */
function whileForged<T>(forged: (value?: unknown) => unknown, act: () => T): T {
  const real = Promise.resolve
  Promise.resolve = forged as never
  try {
    return act()
  } finally {
    Promise.resolve = real
  }
}

/** A thenable that settles as fulfilled at once, whatever it stands for. */
const fulfilled = (): unknown => ({ then: (ok: (value: unknown) => void) => ok(undefined) })

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('Promise.resolve replaced after the library loaded', () => {
  /**
   * Given a delivery state with no healthy sink, and a `Promise.resolve` that answers `up`
   * When the health indicator is checked
   * Then the verdict is still `down`
   */
  it('does not change the health verdict', async () => {
    const real = Promise.resolve.bind(Promise)
    const indicator = new LoggerHealthIndicator({
      deliveryState: () => ({
        destinations: 1,
        failedInit: 1,
        writeFailing: 0,
        hasHealthySink: false
      })
    } as never)

    const result = await whileForged(
      () => real({ status: 'up', details: {} }),
      () => indicator.check()
    )

    expect(result.status).toBe('down')
  })

  /**
   * Given a hook whose promise rejects, and a `Promise.resolve` that answers a thenable that fulfils
   * When the hook runs under `withTimeout`
   * Then the call rejects with what the hook rejected with
   */
  it('does not settle a failed hook as fulfilled', async () => {
    const failure = new Error('hook failed')
    const work = (): Promise<never> => Promise.reject(failure)

    const outcome = whileForged(fulfilled, () => withTimeout(work, 1000))

    await expect(outcome).rejects.toBe(failure)
  })

  /**
   * Given a destination whose write rejects, and a `Promise.resolve` that answers a thenable that
   * fulfils
   * When a chunk is written to its stream
   * Then the failure is recorded for readiness
   */
  it('does not hide a failed write', async () => {
    const health = new DestinationHealth()
    const destination: ILogDestination = {
      name: 'sink',
      write: () => Promise.reject(new Error('write failed'))
    }
    const stream = destinationToStream(destination, health)
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

    try {
      whileForged(fulfilled, () => stream.write('entry\n'))
      await tick()
      await tick()

      expect(health.failedWriteTotal(destination)).toBe(1)
    } finally {
      stderr.mockRestore()
    }
  })

  /**
   * Given a tenant resolver that answers a promise, and a `Promise.resolve` that answers something
   * that absorbs nothing
   * When the middleware reads the answer
   * Then the answer is still awaited, so a rejection of it is absorbed and not left to the process
   */
  it('still absorbs the rejection of a resolver that answers a promise', async () => {
    let awaited = false
    const answer = {
      then: (_ok: (value: unknown) => void, fail: (cause: unknown) => void): void => {
        awaited = true
        fail(new Error('late'))
      }
    }
    const logContext = new LogContextService()
    const options = applyDefaults({
      service: { name: 'promise-statics', version: '1.0.0' },
      http: { tenantIdResolver: () => answer as never }
    })
    const middleware = new RequestIdMiddleware(logContext, options)
    const req = { headers: {}, method: 'GET', url: '/x' } as unknown as LoggableRequest
    const res = { setHeader: jest.fn() } as unknown as LoggableResponse

    whileForged(
      () => ({ catch: () => undefined }),
      () => {
        middleware.use(req, res, () => undefined)
      }
    )
    await tick()

    expect(awaited).toBe(true)
  })

  /**
   * Given a `then` that fulfils with `up`, planted on `Object.prototype` while the result is built
   * When the health indicator is checked with no healthy sink
   * Then the verdict is still `down`, because the result is a box with no prototype
   */
  it('does not let a then on Object.prototype change the verdict', async () => {
    const indicator = new LoggerHealthIndicator({
      deliveryState: () => ({
        destinations: 1,
        failedInit: 1,
        writeFailing: 0,
        hasHealthySink: false
      })
    } as never)
    const proto = Object.prototype as unknown as { then?: unknown }
    proto.then = (ok: (value: unknown) => void): void => ok({ status: 'up', details: {} })

    let pending: Promise<{ status: string }>
    try {
      pending = indicator.check() as Promise<{ status: string }>
    } finally {
      delete proto.then
    }

    expect((await pending).status).toBe('down')
  })

  /**
   * Given a hook that swaps `Promise.prototype.constructor` for a stand-in and rejects, and a `then`
   * that puts the real constructor back before it fulfils
   * When the hook runs under `withTimeout`
   * Then the call is refused, not settled as fulfilled
   */
  it('refuses a constructor replaced and restored around the await', async () => {
    const prototype = Promise.prototype as unknown as { constructor: unknown; then: unknown }
    const realConstructor = prototype.constructor
    const realThen = prototype.then
    const work = (): Promise<never> => {
      prototype.constructor = function Stand() {}
      prototype.then = (ok: (value: unknown) => void): void => {
        prototype.constructor = realConstructor
        prototype.then = realThen
        ok(undefined)
      }
      return Promise.reject(new Error('hook failed'))
    }

    let outcome: Promise<void>
    try {
      outcome = withTimeout(work, 1000)
    } finally {
      prototype.constructor = realConstructor
      prototype.then = realThen
    }

    await expect(outcome).rejects.toBeInstanceOf(PromiseTamperedError)
  })

  /**
   * Given a `then` already planted on a root of the prototype chains
   * When a hook runs under `withTimeout`
   * Then the call is refused at entry and the hook is not called
   */
  it.each([
    ['Object.prototype', Object.prototype],
    ['Array.prototype', Array.prototype],
    ['Function.prototype', Function.prototype]
  ])('refuses at entry when a then is planted on %s', async (_name, root) => {
    const work = jest.fn()
    Object.defineProperty(root, 'then', { value: undefined, configurable: true })

    let outcome: Promise<void>
    try {
      outcome = withTimeout(work, 1000)
    } finally {
      delete (root as { then?: unknown }).then
    }

    await expect(outcome).rejects.toBeInstanceOf(PromiseTamperedError)
    expect(work).not.toHaveBeenCalled()
  })

  /**
   * Given a `then` planted on Object.prototype and a destination whose write answers a promise
   * When a chunk is written to its stream
   * Then the write is refused: it is recorded as failed and the refusal is reported on stderr
   */
  it('records a refused write as failed and reports it', async () => {
    const health = new DestinationHealth()
    const destination: ILogDestination = { name: 'sink', write: () => Promise.resolve() }
    const stream = destinationToStream(destination, health)
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    const proto = Object.prototype as unknown as { then?: unknown }
    Object.defineProperty(proto, 'then', { value: undefined, configurable: true })

    try {
      stream.write('entry\n')
    } finally {
      delete proto.then
    }
    await tick()
    await tick()

    try {
      expect(health.failedWriteTotal(destination)).toBe(1)
      expect(String(stderr.mock.calls.map((call) => call[0]))).toContain('promise prototype')
    } finally {
      stderr.mockRestore()
    }
  })

  /**
   * Given a `then` planted on Object.prototype, and a hook awaited the way the registry awaits it
   * When the wait is refused before anything reads the promise `withTimeout` returned
   * Then the refusal is reported to the caller and no rejection is left to the process
   */
  it('leaves no unhandled rejection when a refused wait is never read', async () => {
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const root = Object.prototype as unknown as { then?: unknown }
    Object.defineProperty(root, 'then', { value: undefined, configurable: true })

    let refusal: unknown
    try {
      try {
        intactOr(withTimeout(() => undefined, 1000))
      } catch (cause) {
        refusal = cause
      }
    } finally {
      delete root.then
    }
    await tick()
    await tick()
    process.off('unhandledRejection', unhandled)

    expect(refusal).toBeInstanceOf(PromiseTamperedError)
    expect(unhandled).not.toHaveBeenCalled()
  })

  /**
   * Given a `then` planted on Object.prototype and a write that answers a promise that later rejects
   * When a chunk is written to its stream and the write is refused at entry
   * Then the failure is recorded once and the rejection of the answered promise is not left to the process
   */
  it('absorbs the promise a refused write already holds', async () => {
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const health = new DestinationHealth()
    const destination: ILogDestination = {
      name: 'sink',
      write: () => Promise.reject(new Error('write failed'))
    }
    const stream = destinationToStream(destination, health)
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
    const root = Object.prototype as unknown as { then?: unknown }
    Object.defineProperty(root, 'then', { value: undefined, configurable: true })

    try {
      stream.write('entry\n')
    } finally {
      delete root.then
    }
    await tick()
    await tick()
    stderr.mockRestore()
    process.off('unhandledRejection', unhandled)

    expect(health.failedWriteTotal(destination)).toBe(1)
    expect(unhandled).not.toHaveBeenCalled()
  })

  /**
   * Given a hook that rejects and makes `Promise.prototype.constructor` an accessor that answers the
   * intrinsic on its first read and a stand-in on the next, with a `then` that puts the data property back
   * When the hook runs under `withTimeout`
   * Then the call is refused and never settles as fulfilled
   */
  it('refuses a constructor that is an accessor', async () => {
    const prototype = Promise.prototype as unknown as { constructor: unknown; then: unknown }
    const realConstructor = prototype.constructor
    const realThen = prototype.then
    const restore = (): void => {
      Object.defineProperty(prototype, 'constructor', {
        value: realConstructor,
        writable: true,
        configurable: true,
        enumerable: false
      })
      prototype.then = realThen
    }
    const work = (): Promise<never> => {
      let reads = 0
      Object.defineProperty(prototype, 'constructor', {
        configurable: true,
        get: () => (++reads === 1 ? realConstructor : function Stand() {})
      })
      prototype.then = (ok: (value: unknown) => void): void => {
        restore()
        ok(undefined)
      }
      return Promise.reject(new Error('hook failed'))
    }

    let outcome: Promise<void>
    try {
      outcome = withTimeout(work, 1000)
    } finally {
      restore()
    }

    await expect(outcome).rejects.toBeInstanceOf(PromiseTamperedError)
  })

  /**
   * Given a `Promise.prototype.constructor` whose species throws, left in place while microtasks run
   * When a rejected promise is absorbed
   * Then no rejection is left to the process
   */
  it('absorbs a rejection under a constructor whose species throws', (done) => {
    const prototype = Promise.prototype as unknown as { constructor: unknown }
    const realConstructor = prototype.constructor
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const Stand = function Stand() {} as unknown as { [Symbol.species]: unknown }
    Object.defineProperty(Stand, Symbol.species, {
      get: () => {
        throw new Error('species')
      }
    })
    prototype.constructor = Stand

    absorb(Promise.reject(new Error('dropped')))

    setImmediate(() => {
      setImmediate(() => {
        prototype.constructor = realConstructor
        process.off('unhandledRejection', unhandled)
        expect(unhandled).not.toHaveBeenCalled()
        done()
      })
    })
  })

  /**
   * Given a hook that plants a constructor whose species throws, and rejects
   * When it runs under `withTimeout` and the plant stays in place while microtasks run
   * Then the call is refused, and neither the hook's rejection nor the returned promise is left to the process
   */
  it('leaves nothing unhandled when a hook plants a throwing species and rejects', (done) => {
    const prototype = Promise.prototype as unknown as { constructor: unknown }
    const realConstructor = prototype.constructor
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const Stand = function Stand() {} as unknown as { [Symbol.species]: unknown }
    Object.defineProperty(Stand, Symbol.species, {
      get: () => {
        throw new Error('species')
      }
    })
    const work = (): Promise<never> => {
      prototype.constructor = Stand
      return Promise.reject(new Error('hook failed'))
    }

    withTimeout(work, 1000)

    setImmediate(() => {
      setImmediate(() => {
        prototype.constructor = realConstructor
        process.off('unhandledRejection', unhandled)
        expect(unhandled).not.toHaveBeenCalled()
        done()
      })
    })
  })

  /**
   * Given a frozen promise and a value that is not an object
   * When each is absorbed
   * Then neither throws
   */
  it('absorbs a frozen promise and a primitive without throwing', () => {
    const frozen = Object.freeze(Promise.reject(new Error('dropped')))

    expect(() => {
      absorb(frozen)
      absorb(42)
    }).not.toThrow()
  })

  /**
   * Given a hook that settles after 20 ms and a `then` accessor planted on Object.prototype at 10 ms
   * When it runs under `withTimeout`
   * Then the call resolves with nothing and the accessor was never read, because nothing is returned that has a `then`
   */
  it('reads no then of Object.prototype when the wait ends', async () => {
    const root = Object.prototype as unknown as { then?: unknown }
    const reads = jest.fn()
    const plant = setTimeout(() => {
      Object.defineProperty(root, 'then', {
        configurable: true,
        get: () => {
          reads()
          return undefined
        }
      })
    }, 10)
    const work = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

    let settled: unknown = 'pending'
    try {
      settled = await withTimeout(work, 1000)
    } finally {
      clearTimeout(plant)
      delete root.then
    }

    expect(settled).toBeUndefined()
    expect(reads).not.toHaveBeenCalled()
  })
})
