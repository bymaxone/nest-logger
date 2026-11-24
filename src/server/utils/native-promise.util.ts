/**
 * The intrinsic promise machinery a verdict of the logger is awaited with.
 *
 * Layer: server/utils. A program that replaces `Promise.resolve` or the `constructor` of
 * `Promise.prototype` after the logger is imported, or plants a `then` on the root of the prototype
 * chains, can forge what an `await` yields. A verdict that reads a promise (a hook that settled, a write
 * that failed) is therefore built from the intrinsic constructor, awaited with no static of `Promise`,
 * and refused when the baseline that makes that sound no longer holds.
 */

/** The intrinsic `Promise`, taken from an async function so a `globalThis.Promise` set before the load is not it. */
export const IntrinsicPromise = Object.getPrototypeOf((async (): Promise<void> => undefined)())
  .constructor as PromiseConstructor

const hasOwn = Object.hasOwn
const nativeThen = Function.prototype.call.bind(IntrinsicPromise.prototype.then) as (
  promise: unknown,
  onFulfilled: () => void,
  onRejected: () => void
) => unknown
const promisePrototype = IntrinsicPromise.prototype as object
const roots: readonly object[] = [Object.prototype, Array.prototype, Function.prototype]

/** The error a verdict is refused with when the promise baseline no longer holds. */
export class PromiseTamperedError extends Error {
  constructor() {
    super(
      'the constructor of the promise prototype was replaced, or a then was planted on a prototype root'
    )
  }
}

/**
 * Whether an `await` still reads what it read at load: `Promise.prototype.constructor` is the intrinsic
 * one, and no `then` sits on `Object.prototype`, `Array.prototype` or `Function.prototype`. A replaced
 * `then` of `Promise.prototype` is not looked at: a runtime that wraps it (a context manager) is allowed.
 *
 * @returns `false` when the baseline was changed.
 */
export function promiseIntact(): boolean {
  if ((promisePrototype as { constructor: unknown }).constructor !== IntrinsicPromise) return false
  for (let at = 0; at < roots.length; at++) {
    if (hasOwn(roots[at] as object, 'then')) return false
  }
  return true
}

/**
 * Returns `pending` after asserting the baseline, so a caller writes `await intactOr(pending)` and no
 * call of the host runs between the check and the wait.
 *
 * @param pending - The value about to be awaited.
 * @returns `pending`.
 * @throws {PromiseTamperedError} When the baseline does not hold.
 */
export function intactOr<T>(pending: T): T {
  if (!promiseIntact()) throw new PromiseTamperedError()
  return pending
}

/** How a wait ended: a box with no prototype, so a `then` planted on `Object.prototype` is not read from it. */
export interface Outcome {
  readonly ok: boolean
  readonly cause: unknown
}

/**
 * Waits for `pending` and drops how it ended, so a rejection of it is not left to the process. Nothing
 * is decided from the wait, which is why it is not refused when the baseline does not hold.
 *
 * A promise is given its handlers by the `then` captured at load, which reads neither the `constructor`
 * nor the `then` of `pending`; any other value is awaited.
 *
 * @param pending - A value that may be a promise nobody else will read.
 */
export function absorb(pending: unknown): void {
  const drop = (): void => undefined
  try {
    nativeThen(pending, drop, drop)
    return
  } catch {
    // Not a native promise: awaited below.
  }
  void (async (): Promise<void> => {
    try {
      await pending
    } catch {
      // The failure of a value nobody reads is of no use to anyone.
    }
  })()
}

/**
 * Calls `work`, waits for what it returned, and hands `finish` how that ended. A throw, a rejection and
 * a baseline that does not hold end as `ok: false`; none of them rejects the promise returned, which
 * resolves with nothing and is meant to be dropped.
 *
 * @param work - Produces the value to wait for; called after the baseline was checked.
 * @param finish - Called once, synchronously, with how the wait ended.
 * @returns A promise nothing reads.
 */
export async function awaitOutcome(
  work: () => unknown,
  finish: (outcome: Outcome) => void
): Promise<void> {
  if (!promiseIntact())
    return finish({ __proto__: null, ok: false, cause: new PromiseTamperedError() } as Outcome)
  let pending: unknown
  try {
    pending = work()
  } catch (cause) {
    return finish({ __proto__: null, ok: false, cause } as Outcome)
  }
  try {
    await intactOr(pending)
  } catch (cause) {
    // A refusal leaves the work's own rejection with no handler, and an unhandled rejection ends the process.
    if (cause instanceof PromiseTamperedError) absorb(pending)
    return finish({ __proto__: null, ok: false, cause } as Outcome)
  }
  finish({ __proto__: null, ok: true, cause: undefined } as Outcome)
}
