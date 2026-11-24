/**
 * Resolves the `toJSON` of a value along its prototype chain, with a bound on the walk.
 *
 * Layer: server/utils. Reads descriptors, and calls the one accessor a `toJSON` is defined by, once;
 * that accessor is the value's own code and may have effects.
 */
import { types } from 'node:util'

/** A `toJSON` resolved off a value. */
export interface ResolvedToJson {
  /** The callable method, or `undefined` when the value has none. */
  method: (() => unknown) | undefined
  /**
   * Whether a later read may answer differently than this one: the method sits behind an
   * accessor, or the value or something on its prototype chain is a Proxy, which can answer as it
   * likes.
   */
  volatile: boolean
  /** The prototype chain did not end within {@link MAX_PROTOTYPE_HOPS}: the value is redacted whole. */
  hostile?: true
}

/** A real chain is a handful of prototypes deep; a Proxy can answer a cycle for ever. */
const MAX_PROTOTYPE_HOPS = 256

/**
 * Resolve `toJSON` along the prototype chain, reading it exactly ONCE. A plain `value.toJSON`
 * read twice invokes a getter twice per value, and a getter can answer differently each time.
 *
 * @param value - A non-null object.
 * @param viaGet - Read with one `[[Get]]` through any Proxy trap, as `JSON.stringify` does.
 * @returns The callable method, or `undefined` when the value has none, and whether the answer can
 *   change.
 */
export function resolveToJson(value: object, viaGet = false): ResolvedToJson {
  // Under 'safe' the read is the one `JSON.stringify` makes, a single `[[Get]]` through any Proxy
  // trap, which is not the descriptor walk below.
  let candidate: unknown = viaGet ? Reflect.get(value, 'toJSON') : undefined
  let accessor = false
  let proxied = false
  let current: object | null = viaGet ? null : value
  for (let hops = 0; current !== null; hops++) {
    if (hops > MAX_PROTOTYPE_HOPS) return { method: undefined, volatile: true, hostile: true }
    proxied = proxied || types.isProxy(current)
    const descriptor = Object.getOwnPropertyDescriptor(current, 'toJSON')
    if (descriptor !== undefined) {
      accessor = descriptor.get !== undefined
      candidate = descriptor.get === undefined ? descriptor.value : descriptor.get.call(value)
      break
    }
    const next: unknown = Object.getPrototypeOf(current) // a non-object ends the walk
    current = typeof next === 'object' ? next : null
  }
  return {
    method: typeof candidate === 'function' ? (candidate as () => unknown) : undefined,
    volatile: accessor || proxied
  }
}
