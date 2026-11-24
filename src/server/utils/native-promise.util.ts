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
const define = Object.defineProperty
const remove = Reflect.deleteProperty
const ownDescriptor = Reflect.getOwnPropertyDescriptor
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
  // The descriptor, not a read: an accessor would answer the intrinsic here and a stand-in at the await.
  const own = ownDescriptor(promisePrototype, 'constructor')
  if (own === undefined || !hasOwn(own, 'value') || own.value !== IntrinsicPromise) return false
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
 * While the handlers are attached, `pending` is given an own `constructor`, the intrinsic one, so that
 * they and an `await` read that slot and not the `constructor` of `Promise.prototype`, which a program
 * may have replaced with one whose species throws. The slot is removed again at once, so a value the
 * caller owns is left as it was; one that cannot take it (a frozen object) or already has its own keeps
 * what it has, and a frozen promise under a replaced constructor whose species throws is therefore not covered. A promise is given its handlers by the
 * `then` captured at load, which does not read the `then` of `pending`; a value that is not a promise
 * is awaited instead.
 *
 * @param pending - A value that may be a promise nobody else will read.
 */
export function absorb(pending: unknown): void {
  const drop = (): void => undefined
  const pinned = pin(pending)
  try {
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
  } finally {
    if (pinned) unpin(pending)
  }
}

/**
 * Gives a promise this library returns an own `constructor`, the intrinsic one, so the `await` of
 * whoever receives it reads that slot and not the `constructor` of `Promise.prototype`, which a program
 * may have replaced after this check. It stays: the promise is the library's own. A frozen object keeps
 * what it has.
 *
 * @param promise - A promise on a decision path, or a promise of a dependency about to be awaited.
 * @returns `promise`.
 */
export function tag<T>(promise: T): T {
  write(promise)
  return promise
}

function write(target: unknown): boolean {
  try {
    define(target as object, 'constructor', {
      __proto__: null,
      value: IntrinsicPromise,
      writable: true,
      configurable: true
    } as PropertyDescriptor)
    return true
  } catch {
    // A frozen object, a primitive, or a Proxy that refuses: it keeps what it has.
    return false
  }
}

/** Gives an object with no own `constructor` the intrinsic one; `false` when nothing was written. */
function pin(target: unknown): boolean {
  if (typeof target !== 'object' || target === null || hasOwn(target, 'constructor')) return false
  return write(target)
}

/** Takes back what {@link pin} wrote. */
function unpin(target: unknown): void {
  try {
    remove(target as object, 'constructor')
  } catch {
    // A Proxy that refuses the delete: nothing more can be done.
  }
}

/**
 * Calls `work`, waits for what it returned, and hands `finish` how that ended. A throw, a rejection and
 * a baseline that does not hold end as `ok: false`, and a throw of `finish` itself is dropped.
 *
 * @param work - Produces the value to wait for; called after the baseline was checked.
 * @param finish - Called once, synchronously, with how the wait ended.
 * @param held - A value the caller already holds that `work` will return; absorbed when the wait is
 *   refused at entry, because `work` is not called then and nothing else would read it.
 */
export function awaitOutcome(
  work: () => unknown,
  finish: (outcome: Outcome) => void,
  held?: unknown
): void {
  // Whatever `finish` throws would reject the promise of the run, which nothing reads.
  absorb(run(work, finish, held))
}

async function run(
  work: () => unknown,
  finish: (outcome: Outcome) => void,
  held: unknown
): Promise<void> {
  if (!promiseIntact()) {
    if (held !== undefined) absorb(held)
    return finish({ __proto__: null, ok: false, cause: new PromiseTamperedError() } as Outcome)
  }
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
