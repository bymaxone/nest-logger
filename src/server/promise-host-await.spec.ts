/**
 * Verifies what the logger does with a native promise a hook or a destination returns: it is waited
 * for through the intrinsic constructor and never through a `then`, and one that carries its own
 * `constructor` or `then` is refused instead of letting the host decide the outcome.
 *
 * Layer: server, tests. Every planted accessor is put back in the same synchronous window that reads it,
 * so no case holds a replacement across an await of the test runner.
 */
import type { ILogDestination } from './interfaces/log-destination.interface'
import { DestinationHealth } from './services/destination-health.service'
import { destinationToStream } from './utils/destination-to-stream'
import { PromiseTamperedError } from './utils/native-promise.util'
import { withTimeout } from './utils/with-timeout.util'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('A native promise the host returns', () => {
  /**
   * Given a hook that returns a native promise carrying its own then, its own data constructor or its
   * own accessor constructor
   * When it runs under `withTimeout`
   * Then each is refused with a PromiseTamperedError, and a forged settlement is never read
   */
  it.each([
    [
      'own then',
      (p: Promise<void>) =>
        Object.defineProperty(p, 'then', {
          value: (resolve: () => void) => resolve()
        })
    ],
    [
      'own data constructor',
      (p: Promise<void>) => Object.defineProperty(p, 'constructor', { value: Object })
    ],
    [
      'own accessor constructor',
      (p: Promise<void>) =>
        Object.defineProperty(p, 'constructor', {
          get() {
            return Object
          }
        })
    ]
  ])('refuses a hook promise with %s', async (_name, plant) => {
    const hostile = Promise.reject(new Error('hook'))
    plant(hostile)

    const outcome = withTimeout(() => hostile, 50)

    await expect(outcome).rejects.toBeInstanceOf(PromiseTamperedError)
  })

  /**
   * Given a hook that installs, inside its own call, accessors on the constructor and the then of
   * Promise.prototype that restore themselves after one read, and returns a rejected promise
   * When it runs under `withTimeout`
   * Then it is refused, because the baseline is read before the wait and an accessor is not the intrinsic
   */
  it('refuses a hook that plants self-restoring prototype accessors', async () => {
    const proto = Promise.prototype as unknown as Record<string, unknown>
    const own = (key: string) => Object.getOwnPropertyDescriptor(proto, key) as PropertyDescriptor
    const original = { constructor: own('constructor'), then: own('then') }
    const restore = () => {
      Object.defineProperty(proto, 'constructor', original.constructor)
      Object.defineProperty(proto, 'then', original.then)
    }
    class Fake {}
    let answer: Promise<void>
    try {
      answer = withTimeout(() => {
        const hostile = Promise.reject(new Error('hook'))
        Object.defineProperty(proto, 'constructor', {
          get() {
            restore()
            return Fake
          },
          configurable: true
        })
        Object.defineProperty(proto, 'then', {
          get() {
            restore()
            return (resolve: () => void) => resolve()
          },
          configurable: true
        })
        return hostile
      }, 50)
    } finally {
      restore()
    }

    await expect(answer).rejects.toBeInstanceOf(PromiseTamperedError)
  })

  /**
   * Given a destination whose write answers a rejected native promise with its own accessor constructor,
   * and a `then` of Promise.prototype that fulfils and puts itself back
   * When a chunk is written to its stream
   * Then the failure is counted and no rejection is left to the process
   */
  it('counts a failed write whose promise carries its own constructor', async () => {
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const health = new DestinationHealth()
    const proto = Promise.prototype as unknown as { then: unknown }
    const realThen = proto.then
    const destination: ILogDestination = {
      name: 'sink',
      write: () => {
        const answer = Promise.reject(new Error('write failed'))
        Object.defineProperty(answer, 'constructor', {
          get() {
            return Object
          },
          configurable: true
        })
        proto.then = function forged(this: unknown, resolve: () => void) {
          proto.then = realThen
          resolve()
        }
        return answer
      }
    }
    const stream = destinationToStream(destination, health)
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)

    try {
      stream.write('entry\n')
    } finally {
      proto.then = realThen
    }
    await tick()
    await tick()
    stderr.mockRestore()
    process.off('unhandledRejection', unhandled)

    expect(health.failedWriteTotal(destination)).toBe(1)
    expect(unhandled).not.toHaveBeenCalled()
  })

  /**
   * Given a `then` of Promise.prototype replaced by a data function before the call and kept until the
   * hook settles
   * When a hook that rejects runs under `withTimeout`
   * Then the rejection is the one the caller sees, because a native promise is waited for without a `then`
   */
  it('keeps the rejection of a hook under a then replaced for the whole wait', async () => {
    const proto = Promise.prototype as unknown as { then: unknown }
    const realThen = proto.then as (
      this: unknown,
      a: () => void,
      b: (c: unknown) => void
    ) => unknown
    proto.then = function forged(this: unknown, resolve: () => void) {
      resolve()
    }
    const seen = new Promise<unknown>((settled) => {
      try {
        const answer = withTimeout(() => Promise.reject(new Error('hook')), 50)
        // Observed through the real then: the replaced one would answer for the caller.
        realThen.call(
          answer,
          () => settled('fulfilled'),
          (cause: unknown) => settled(cause)
        )
      } finally {
        proto.then = realThen
      }
    })

    const outcome = await seen

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('hook')
  })

  /**
   * Given a hook that returns a native promise whose prototype was swapped, inside the hook, for one whose
   * constructor and then are accessors that restore themselves after one read
   * When it runs under `withTimeout`
   * Then the rejection is the one the caller sees, and the forged then is never read
   */
  it('keeps the rejection of a hook promise whose prototype was swapped', async () => {
    class Fake {}
    const hostile = Promise.reject(new Error('hook'))
    const swapped = Object.create(Promise.prototype, {
      constructor: {
        get() {
          return Fake
        },
        configurable: true
      },
      then: {
        get() {
          return (resolve: () => void) => resolve()
        },
        configurable: true
      }
    }) as object
    Object.setPrototypeOf(hostile, swapped)

    const answer = withTimeout(() => hostile, 50)

    await expect(answer).rejects.toThrow('hook')
  })
})
