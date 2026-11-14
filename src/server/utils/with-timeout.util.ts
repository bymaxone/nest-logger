/**
 * A deadline for a destination lifecycle hook.
 *
 * Layer: server/utils — a pure helper of `DestinationRegistry`. A hook is consumer code that may
 * never settle (a connection that is never answered), and an application that waits for it never
 * starts or never stops. The deadline abandons the wait; it cannot cancel the work.
 */

/** The error a hook that did not settle in time is rejected with. */
export class HookTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`did not settle within ${String(timeoutMs)} ms`)
    this.name = 'HookTimeoutError'
  }
}

/**
 * Run `work` and settle with its result, or reject with a {@link HookTimeoutError} once `ms` pass.
 *
 * The timer is cleared when the work settles and does not keep the process alive. A throw, a
 * rejection and a value that is not a promise are all read as the work's own outcome. When the
 * deadline wins, a later settlement of the work is ignored.
 *
 * @param work - The hook call, which may throw, return a value or return a promise.
 * @param ms - The deadline in milliseconds, an integer from 1 to 2147483647.
 * @returns What the work settled with.
 */
export function withTimeout<T>(work: () => T | PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HookTimeoutError(ms))
    }, ms)
    timer.unref()
    const settle =
      <A extends unknown[]>(done: (...args: A) => void) =>
      (...args: A): void => {
        clearTimeout(timer)
        done(...args)
      }
    try {
      Promise.resolve(work()).then(settle(resolve), settle(reject))
    } catch (cause) {
      settle(reject)(cause)
    }
  })
}
