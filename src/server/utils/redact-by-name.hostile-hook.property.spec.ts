/**
 * Pins the rule behind the hostile-hook cases as a property: for each shape in `shapes()`, however
 * it is nested and whether or not its key is a serializer key, `JSON.stringify` of the walk's
 * output neither writes the secret nor runs a hook. The nesting is drawn from a fixed seed, so a
 * failure names a case that can be run again; a new way to hide a hook needs a new entry in
 * `shapes()`. A hook the walk follows itself is called during the walk and its output is redacted;
 * only a call made by the stringifier afterwards counts.
 *
 * Layer: server, utils, tests.
 */
import { createNameRedactor } from './redact-by-name.util'

const SECRET = 'SECRET-VALUE'
const CASES = 2200
const SEED = 20261108

/** A deterministic generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

interface Planted {
  /** The value to log. */
  readonly value: unknown
  /** The kind of shape, for the coverage check. */
  readonly kind: string
}

type Counter = { calls: number }

/** A hook that counts its own calls and would write the secret under a censored name. */
const hookOf = (counter: Counter) => (): object => {
  counter.calls += 1
  return { password: SECRET }
}

/** Shapes that answer no hook to the first read and a hook to a later one. */
function shapes(counter: Counter): Array<(pick: () => number) => Planted> {
  const hook = hookOf(counter)
  const laterHook = (): (() => unknown) => {
    let reads = 0
    return () => (reads++ === 0 ? undefined : hook)
  }
  return [
    (): Planted => {
      const target: Record<string, unknown> = { a: 1 }
      Object.defineProperty(target, 'toJSON', { enumerable: true, get: laterHook() })
      return { value: target, kind: 'object, enumerable accessor' }
    },
    (): Planted => {
      const target = new Error('boom')
      Object.defineProperty(target, 'toJSON', { enumerable: false, get: laterHook() })
      return { value: target, kind: 'error, accessor' }
    },
    (): Planted => {
      const target = new Error('boom')
      Object.defineProperty(target, 'toJSON', { enumerable: true, get: laterHook() })
      return { value: target, kind: 'error, enumerable accessor' }
    },
    (pick): Planted => {
      const enumerable = pick() < 0.5
      const target = new Error('boom')
      Object.defineProperty(target, 'toJSON', {
        configurable: true,
        enumerable: false,
        get() {
          Object.defineProperty(target, 'toJSON', { configurable: true, enumerable, value: hook })
          return undefined
        }
      })
      return { value: target, kind: 'error, accessor that rewrites itself' }
    },
    (): Planted => {
      const target = (): number => 1
      Object.defineProperty(target, 'toJSON', { get: laterHook() })
      return { value: target, kind: 'function, accessor' }
    },
    (): Planted => ({
      kind: 'function, Proxy hiding its hook',
      value: new Proxy(() => 1, {
        get: (target, key) => (key === 'toJSON' ? hook : Reflect.get(target, key)),
        has: (target, key) => key !== 'toJSON' && Reflect.has(target, key),
        getOwnPropertyDescriptor: (target, key) =>
          key === 'toJSON' ? undefined : Reflect.getOwnPropertyDescriptor(target, key)
      })
    }),
    (): Planted => {
      const later = laterHook()
      return {
        kind: 'function, Proxy answering a hook later',
        value: new Proxy(() => 1, {
          get: (target, key) => (key === 'toJSON' ? later() : Reflect.get(target, key))
        })
      }
    },
    (): Planted => {
      const target = (): number => 1
      Object.setPrototypeOf(
        target,
        new Proxy(
          {},
          {
            get: (base, key) => (key === 'toJSON' ? hook : Reflect.get(base, key)),
            getOwnPropertyDescriptor: (base, key) =>
              key === 'toJSON' ? undefined : Reflect.getOwnPropertyDescriptor(base, key)
          }
        )
      )
      return { value: target, kind: 'function, Proxy prototype' }
    },
    (): Planted => {
      const base = new Error('boom')
      let reads = 0
      const proxy = new Proxy(base, {
        ownKeys: (target) => [...Reflect.ownKeys(target), 'toJSON'],
        getOwnPropertyDescriptor: (target, key) =>
          key === 'toJSON'
            ? reads++ === 0
              ? undefined
              : { configurable: true, enumerable: false, value: hook }
            : Reflect.getOwnPropertyDescriptor(target, key),
        has: (target, key) => key !== 'toJSON' && key in target,
        get: (target, key, receiver) =>
          key === 'toJSON' ? undefined : Reflect.get(target, key, receiver)
      })
      return { value: proxy, kind: 'error, Proxy with changing descriptors' }
    },
    (): Planted => {
      const target = new Error('boom')
      Object.defineProperty(target, 'a', {
        configurable: true,
        enumerable: true,
        get() {
          Object.defineProperty(target, 'leak', {
            configurable: true,
            enumerable: true,
            value: { password: SECRET }
          })
          return 1
        }
      })
      return { value: target, kind: 'error, getter that defines a property when read' }
    },
    (): Planted => {
      let descriptorReads = 0
      const proxy = new Proxy(new Error('boom'), {
        ownKeys: (target) => [...Reflect.ownKeys(target), 'leak'],
        getOwnPropertyDescriptor: (target, key) =>
          key === 'leak'
            ? {
                configurable: true,
                enumerable: descriptorReads++ > 0,
                value: { password: SECRET },
                writable: true
              }
            : Reflect.getOwnPropertyDescriptor(target, key)
      })
      return { value: proxy, kind: 'error, Proxy whose descriptors disagree with its keys' }
    }
  ]
}

/** Wrap a value in random plain containers, so it sits at a random depth under random keys. */
function nested(value: unknown, pick: () => number): unknown {
  let current = value
  for (let depth = Math.floor(pick() * 4); depth > 0; depth--) {
    const key = ['err', 'meta', 'data', 'cause'][Math.floor(pick() * 4)] as string
    current = pick() < 0.3 ? [current] : { [key]: current, other: 1 }
  }
  return current
}

describe('no hook the walk did not follow survives it, for any generated hostile shape', () => {
  it('writes no secret and runs no hook in the stringifier', () => {
    const pick = random(SEED)
    const counter: Counter = { calls: 0 }
    const makers = shapes(counter)
    const seen = new Map<string, number>()
    const failures: string[] = []

    for (let index = 0; index < CASES; index++) {
      const planted = (makers[Math.floor(pick() * makers.length)] as (p: () => number) => Planted)(
        pick
      )
      seen.set(planted.kind, (seen.get(planted.kind) ?? 0) + 1)
      const serializedKeys = pick() < 0.5 ? ['err'] : undefined
      const redact = createNameRedactor(['password'], 'X', serializedKeys)

      const output = redact({ record: nested(planted.value, pick) }, true)
      counter.calls = 0
      const text = JSON.stringify(output)

      if (text.includes(SECRET) || counter.calls > 0) {
        failures.push(`${index} ${planted.kind} calls=${counter.calls} ${text.slice(0, 120)}`)
      }
    }

    expect(failures).toEqual([])
    expect(seen.size).toBe(makers.length)
    for (const count of seen.values()) expect(count).toBeGreaterThan(50)
  })
})
