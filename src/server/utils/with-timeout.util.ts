/**
 * A deadline for a destination lifecycle hook.
 *
 * Layer: server/utils — a pure helper of `DestinationRegistry`. A hook is consumer code that may
 * never settle (a connection that is never answered), and an application that waits for it never
 * starts or never stops. The deadline abandons the wait; it cannot cancel the work.
 */
import { awaitOutcome, IntrinsicPromise } from './native-promise.util'

/** The error a hook that did not settle in time is rejected with. */
export class HookTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`did not settle within ${String(timeoutMs)} ms`)
    this.name = 'HookTimeoutError'
  }
}

/**
 * Run `work` and settle once it has, or reject with a {@link HookTimeoutError} once `ms` pass.
 *
 * The timer is cleared when the work settles. It is not unreferenced: it is what settles the wait
 * when the work never does, and a process with no other handle would otherwise exit with the hook
 * still pending, and never report it. A throw and a rejection are the work's own failure, and what
 * the work returned is not read. When the deadline wins, a later settlement of the work is ignored.
 * The wait is refused with a {@link PromiseTamperedError} when the promise baseline does not hold.
 *
 * @param work - The hook call, which may throw, return a value or return a promise.
 * @param ms - The deadline in milliseconds, an integer from 1 to 2147483647.
 * @returns A promise that resolves with nothing once the work settled.
 */
export function withTimeout(work: () => unknown, ms: number): Promise<void> {
  return new IntrinsicPromise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HookTimeoutError(ms))
    }, ms)
    void awaitOutcome(work, (outcome) => {
      clearTimeout(timer)
      if (outcome.ok) resolve()
      else reject(outcome.cause)
    })
  })
}
