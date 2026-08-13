/**
 * Keys that corrupt an object's prototype chain instead of becoming own fields.
 *
 * Layer: server — a single source of truth for the two independent surfaces that
 * copy caller-controlled bags into a fresh object: the ALS context
 * (`LogContextService`) and the structured metadata of a log call
 * (`PinoLoggerService`). Both used to carry their own copy of this list, and one
 * of them was missing it — the metadata path wrote through `Reflect.set`, which
 * finds `Object.prototype`'s inherited `__proto__` SETTER and invokes it, so the
 * field was silently dropped and the copy's prototype was swapped. Keeping the
 * list in one place is what stops the two guards drifting again.
 */

/**
 * Own keys that must never be copied onto a fresh object.
 *
 * `__proto__` is the accessor case above. `constructor` and `prototype` are
 * included because they are the other names a payload uses to reach a prototype
 * chain, and a logging concern has no reason to carry any of the three.
 *
 * A key here is DROPPED rather than escaped: these names have no legitimate use
 * as a log field, and dropping is the behaviour the ALS path already had.
 */
export const PROTOTYPE_POLLUTING_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype'
])
