/**
 * The transient clone of an `Error` the redaction walk keeps when it does not write the `Error` as
 * data: same prototype, same descriptors relaxed so every write lands, and nothing enumerable that
 * the walk did not itself write.
 *
 * Layer: server/utils — a helper of {@link createNameRedactor}; it reads no rule of the walk.
 */

/**
 * Give an object a `toJSON` of `undefined`, which the stringifier does not run. It is defined and
 * not deleted, because deleting would leave a `toJSON` method further up the prototype chain to
 * run in its place. The clone of an `Error` gets it before it leaves `cloneError`, with no condition
 * and no read of the original, which a Proxy can answer differently each time it is asked: an own
 * property of an object only this walk can reach is read by `JSON.stringify` before any hook on the
 * prototype chain. It is configurable so the property loop can delete it and write a `toJSON`
 * value of its own.
 *
 * @param target - The copy that must not run a hook.
 */
function shadowHook(target: object): void {
  Reflect.defineProperty(target, 'toJSON', { value: undefined, configurable: true })
}

/**
 * Remove every enumerable own key from a clone. The property loop writes each key the walk took, so
 * what the clone holds afterwards is exactly what the walk produced for it. The clone is built
 * from descriptors read after the keys were taken, so an object whose reads disagree, a Proxy, can
 * hand it an enumerable value the walk never saw and never redacted.
 *
 * @param clone - The clone of an `Error`.
 */
function withoutEnumerableKeys(clone: object): void {
  for (const key of Object.keys(clone)) Reflect.deleteProperty(clone, key)
}

/** The setter of a clone's accessor that had none: the write is dropped, never thrown. */
function discardWrite(): void {
  // Nothing to keep: the clone is read once and discarded.
}

/**
 * Clone an `Error` preserving what makes it an Error.
 *
 * The walk cannot flatten an error into a plain object: Pino's `err` serializer
 * keys off the instance, and `message` / `stack` are own but NON-enumerable, so
 * a spread would silently drop them. Copying the prototype and the full
 * descriptor set keeps `instanceof`, the message and the stack intact while the
 * caller redefines the enumerable properties it censored.
 *
 * @param error - The error to clone.
 * @returns A structurally identical error with its own descriptors copied.
 */
export function cloneError(error: Error): Error {
  // Descriptors are copied for their SHAPE, not their immutability. A consumer
  // that freezes its errors — a deliberate, documented practice, so nobody mutates
  // an issue list after the throw — hands us properties that are neither writable
  // nor configurable, and the clone inherited that. Every own enumerable key is
  // then rewritten below with its walked value, and redefining a non-configurable
  // property fails whenever that value is a fresh object rather than the original
  // reference: a censored secret, or simply the structural copy the walk makes of
  // a nested array. The failure used to reach the caller's guard and drop the
  // WHOLE record, so a frozen error carrying an array lost every field including
  // its own message — total silent loss of the one thing worth logging.
  //
  // The clone is transient: built here, serialized, discarded. Nothing downstream
  // reads its descriptors, so relaxing them changes only whether this function can
  // finish its job. Freezing is the CALLER's guarantee about the CALLER's object,
  // which is untouched either way.
  // `configurable` lets `Reflect.defineProperty` redefine a property the original froze. `writable`
  // is relaxed on data properties too, so that an assignment into the clone, in strict mode, lands
  // whatever the original froze. An accessor has no `writable`; one with no setter throws on an
  // assignment, so it is given a setter that discards the write.
  const descriptors = Object.getOwnPropertyDescriptors(error)
  for (const descriptor of Object.values(descriptors)) {
    descriptor.configurable = true
    if ('value' in descriptor) descriptor.writable = true
    else descriptor.set ??= discardWrite
  }
  const clone = Object.create(Object.getPrototypeOf(error) as object, descriptors) as Error
  // V8 exposes `stack` as an own ACCESSOR bound to the original error's internal
  // state, so copying the descriptor hands the clone a getter that resolves to a
  // near-empty string. Pin the already-resolved trace as a plain data property —
  // without this the redacted error reaches the sink with its stack erased,
  // which is worse than the leak the clone exists to close.
  const { stack } = error
  if (typeof stack === 'string') {
    // `enumerable: false` matches how a real Error carries its stack — making it
    // enumerable would push the whole trace into `JSON.stringify` output for every
    // redacted error. `writable` is stated for the reason given above; `configurable` is left at
    // its `false` default: nothing downstream deletes a stack.
    Reflect.defineProperty(clone, 'stack', { value: stack, enumerable: false, writable: true })
  }
  // The clone carries every descriptor of the original, read after the walk's own read, so it can
  // hold an enumerable value the walk never saw and a `toJSON` that answers a hook later.
  withoutEnumerableKeys(clone)
  shadowHook(clone)
  return clone
}
