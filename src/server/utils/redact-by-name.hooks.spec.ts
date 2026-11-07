/**
 * Pins one invariant of the redaction walk: nothing in its output that `JSON.stringify` will see
 * carries a callable `toJSON`. A hook that survives the walk runs after the redaction, so a secret
 * it returns is written uncensored. The walk's final value is inspected for every shape a value
 * with a hook can take, under every configuration of the walk.
 *
 * Layer: server, utils, tests.
 */
import { createNameRedactor } from './redact-by-name.util'
import { ALL_OWN_FIELDS, createOwnFieldPolicy } from './own-field-policy.util'

const SECRET = 'SECRET-FROM-HOOK'

/** A value whose `toJSON` returns the secret under a name the redaction censors. */
function withHook<T extends object>(value: T): T {
  Object.defineProperty(value, 'toJSON', {
    value: () => ({ password: SECRET, actual: 'visible' })
  })
  return value
}

/** A value whose `toJSON` accessor answers `undefined` on the first read and a hook after that. */
function withStatefulHook<T extends object>(value: T): T {
  let reads = 0
  Object.defineProperty(value, 'toJSON', {
    get: () => (reads++ === 0 ? undefined : () => ({ password: SECRET, actual: 'visible' })),
    configurable: true
  })
  return value
}

const errorWithHook = (): Error => withHook(Object.assign(new Error('boom'), { code: 'E_X' }))
const plainWithHook = (): object => withHook({ amount: 5 })

/** Every place a value with a hook can sit in a record. */
const shapes: [string, () => Record<string, unknown>][] = [
  ['an Error under a key', () => ({ inner: errorWithHook() })],
  ['a plain object under a key', () => ({ inner: plainWithHook() })],
  ['an Error in an array', () => ({ list: [1, errorWithHook()] })],
  ['an Error deep in the record', () => ({ a: { b: { c: { d: { inner: errorWithHook() } } } } })],
  [
    'an Error as an own field of an Error',
    () => ({ inner: Object.assign(new Error('o'), { held: errorWithHook() }) })
  ],
  [
    'an Error as the cause of an Error',
    () => ({ inner: new Error('o', { cause: errorWithHook() }) })
  ],
  [
    'an Error in the errors of an AggregateError',
    () => ({ inner: new AggregateError([errorWithHook()], 'many') })
  ],
  [
    'a plain object as the cause of an Error',
    () => ({ inner: new Error('o', { cause: plainWithHook() }) })
  ],
  [
    'an Error with a hook that holds an Error with a hook',
    () => ({ inner: withHook(Object.assign(new Error('o'), { held: errorWithHook() })) })
  ],
  [
    'an instance whose class defines the hook',
    () => {
      class Money {
        toJSON(): object {
          return { password: SECRET, actual: 'visible' }
        }
      }
      return { inner: new Money() }
    }
  ],
  [
    'an Error whose class defines the hook',
    () => {
      class Failure extends Error {
        toJSON(): object {
          return { password: SECRET, actual: 'visible' }
        }
      }
      return { inner: new Failure('f') }
    }
  ],
  [
    'an Error whose hook is an own enumerable field',
    () => ({
      inner: Object.assign(new Error('o'), {
        toJSON: () => ({ password: SECRET, actual: 'visible' })
      })
    })
  ],
  ['an Error under the key err', () => ({ err: errorWithHook() })],
  ['an Error under a key with a serializer', () => ({ thing: errorWithHook() })]
]

const SAFE = createOwnFieldPolicy('safe', [])

/** The ways the walk is built: the caller's record or serializer output, with each policy. */
const configurations = [
  {
    name: 'record, all',
    plain: false,
    coversPassword: true,
    build: () => createNameRedactor(['password'], 'X', ['err', 'thing'], undefined, ALL_OWN_FIELDS)
  },
  {
    name: 'record, safe',
    plain: true,
    coversPassword: true,
    build: () => createNameRedactor(['password'], 'X', ['err', 'thing'], undefined, SAFE)
  },
  {
    name: 'record, safe, toJSON listed as an own field',
    plain: true,
    coversPassword: true,
    build: () =>
      createNameRedactor(
        ['password'],
        'X',
        ['err', 'thing'],
        undefined,
        createOwnFieldPolicy('safe', ['toJSON'])
      )
  },
  {
    name: 'record, safe, no names',
    plain: true,
    coversPassword: false,
    build: () => createNameRedactor(new Set<string>(), 'X', ['err', 'thing'], undefined, SAFE)
  },
  {
    name: 'serializer output, all',
    plain: false,
    coversPassword: true,
    build: () => createNameRedactor(['password'], 'X', undefined, undefined, ALL_OWN_FIELDS)
  },
  {
    name: 'serializer output, safe',
    plain: true,
    coversPassword: true,
    build: () => createNameRedactor(['password'], 'X', undefined, undefined, SAFE)
  }
]

/** The paths in a value that hold a callable `toJSON`, own or inherited. */
function hooksIn(value: unknown, path = '$', seen = new Set<object>()): string[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) return []
  seen.add(value)
  const found = typeof (value as { toJSON?: unknown }).toJSON === 'function' ? [path] : []
  for (const key of Object.keys(value)) {
    found.push(...hooksIn(Reflect.get(value, key), `${path}.${key}`, seen))
  }
  return found
}

/** Whether a value is plain data: primitives, arrays and plain objects with data properties only. */
function isPlainTree(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'function' || typeof value === 'symbol') return false
  if (typeof value !== 'object') return true
  if (seen.has(value)) return false
  seen.add(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  const shapeOk = Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype
  return (
    shapeOk &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return (
        descriptor !== undefined &&
        'value' in descriptor &&
        (Array.isArray(value) && key === 'length' ? true : isPlainTree(descriptor.value, seen))
      )
    })
  )
}

describe('the output of the redaction walk', () => {
  describe.each(configurations)('as $name', ({ build, coversPassword, plain }) => {
    it.each(shapes)('carries no hook that runs after it, for %s', (_shape, make) => {
      const written = build()(make(), true)

      expect(hooksIn(written)).toEqual([])
      if (coversPassword) expect(JSON.stringify(written)).not.toContain(SECRET)
      if (plain) expect(isPlainTree(written)).toBe(true)
    })
  })
})

/** Values that only the 'safe' output turns into plain data: binary, symbols and callables. */
const plainOnlyShapes: [string, () => Record<string, unknown>][] = [
  [
    'an Error whose toJSON is Buffer.prototype.toJSON and that holds a Buffer',
    () => ({
      inner: Object.assign(new Error('x'), {
        toJSON: Buffer.prototype.toJSON,
        stdout: Buffer.from('S')
      })
    })
  ],
  [
    'a Proxy that answers Buffer.prototype.toJSON once and a hook after that',
    () => {
      let reads = 0
      return {
        inner: new Proxy(
          {},
          {
            get: (_target, key) =>
              key === 'toJSON'
                ? reads++ === 0
                  ? Buffer.prototype.toJSON
                  : () => ({ password: SECRET })
                : undefined
          }
        )
      }
    }
  ],
  [
    'an Error whose toJSON is an accessor that answers differently the second time',
    () => ({ inner: withStatefulHook(new Error('o')) })
  ],
  [
    'a function that carries a toJSON accessor that answers differently the second time',
    () => ({ run: withStatefulHook(() => 1) })
  ],
  [
    'a function Proxy whose get trap answers a hook that its has and descriptor traps hide',
    () => ({
      run: new Proxy((): number => 1, {
        get: (target, key, receiver) =>
          key === 'toJSON'
            ? () => ({ password: SECRET, actual: 'visible' })
            : Reflect.get(target, key, receiver),
        has: (target, key) => key !== 'toJSON' && Reflect.has(target, key),
        getOwnPropertyDescriptor: (target, key) =>
          key === 'toJSON' ? undefined : Reflect.getOwnPropertyDescriptor(target, key)
      })
    })
  ],
  ['a Buffer', () => ({ raw: Buffer.from('ab') })],
  [
    'a typed array and a DataView',
    () => ({ a: new Uint8Array(2), b: new DataView(new ArrayBuffer(3)) })
  ],
  [
    'a subclass of Uint8Array that defines a hook',
    () => {
      class Bytes extends Uint8Array {
        toJSON(): object {
          return { password: SECRET }
        }
      }
      return { raw: new Bytes(2) }
    }
  ],
  [
    'a symbol and a function beside data',
    () => ({ id: Symbol('x'), run: () => 1, ok: 1, list: [() => 1, Symbol('y'), 2] })
  ],
  [
    'a Map, a Set and a class instance',
    () => ({
      m: new Map([[1, 2]]),
      s: new Set([1]),
      c: new (class Box {
        v = 1
      })()
    })
  ],
  [
    'an Error with a cause that is an Error with a hook',
    () => ({ err: new Error('o', { cause: errorWithHook() }) })
  ]
]

describe('the output of the redaction walk under safe is plain data', () => {
  describe.each(configurations.filter((configuration) => configuration.plain))(
    'as $name',
    ({ build, coversPassword }) => {
      it.each([...shapes, ...plainOnlyShapes])('has only plain nodes, for %s', (_shape, make) => {
        const written = build()(make(), true)

        expect(isPlainTree(written)).toBe(true)
        if (coversPassword) expect(JSON.stringify(written)).not.toContain(SECRET)
      })
    }
  )
})

describe('what the walk does with a function', () => {
  it("hands it on as it is under 'all' and omits it under 'safe', with a toJSON that is not a function kept", () => {
    const run = (): number => 1
    const record = (): Record<string, unknown> => ({
      run,
      list: [run, 2],
      nested: Object.assign(new Error('o'), { toJSON: 'text' })
    })

    const all = createNameRedactor(
      ['password'],
      'X',
      undefined,
      undefined,
      ALL_OWN_FIELDS
    )(record(), true) as {
      run: unknown
      list: unknown[]
      nested: Record<string, unknown>
    }
    const safe = createNameRedactor(
      ['password'],
      'X',
      ['err'],
      undefined,
      SAFE
    )(record(), true) as {
      run: unknown
      list: unknown[]
      nested: Record<string, unknown>
    }

    expect(all.run).toBe(run)
    expect(all.nested['toJSON']).toBe('text')
    expect(safe.run).toBeUndefined()
    expect(safe.list).toEqual([undefined, 2])
    expect(JSON.stringify(safe)).toContain('"list":[null,2]')
  })

  it("applies the toJSON of a function once, as the stringifier would, under 'safe'", () => {
    const run = Object.assign((): number => 1, { toJSON: () => ({ password: SECRET, shown: 1 }) })
    const redact = createNameRedactor(['password'], 'X', ['err'], undefined, SAFE)

    expect(redact({ run }, true)).toEqual({ run: { password: 'X', shown: 1 } })
  })
})

describe("the width cap of an AggregateError's errors under 'safe'", () => {
  it('reads a toJSON accessor of the list at most once, and writes the cap marker', () => {
    const errors = Array.from({ length: 11 }, () => new Error('x'))
    let reads = 0
    Object.defineProperty(errors, 'toJSON', {
      get() {
        reads++
        return () => errors
      }
    })
    const redact = createNameRedactor([], 'X', undefined, undefined, SAFE)

    const aggregate = new AggregateError([], 'many')
    Object.defineProperty(aggregate, 'errors', { value: errors })

    const written = redact({ inner: aggregate }, true) as {
      inner: { errors: unknown[] }
    }

    expect(reads).toBeLessThanOrEqual(1)
    expect(written.inner.errors).toHaveLength(11)
    expect(JSON.stringify(written.inner.errors.at(-1))).toContain('_truncated')
  })

  it("keeps a value whose toJSON is not a function as the data it is, under 'safe'", () => {
    const redact = createNameRedactor(['password'], 'X', ['err'], undefined, SAFE)

    expect(redact({ value: { toJSON: 'text', kept: 1, password: 'p' } }, true)).toEqual({
      value: { toJSON: 'text', kept: 1, password: 'X' }
    })
  })
})

describe("the width cap of an AggregateError's errors in the default mode", () => {
  it('reads the list for a toJSON by its descriptors, so a hook only a get trap answers does not exempt it', () => {
    const members = Array.from({ length: 12 }, (_member, index) => new Error(`m${String(index)}`))
    const list = new Proxy(members, {
      get: (target, key, receiver) =>
        key === 'toJSON' ? () => target : Reflect.get(target, key, receiver)
    })
    const aggregate = new AggregateError([], 'many')
    Object.defineProperty(aggregate, 'errors', { value: list })
    const redact = createNameRedactor(['password'], 'X', ['err'], undefined, ALL_OWN_FIELDS)

    const written = redact({ inner: aggregate }, true) as { inner: { errors: unknown[] } }

    expect(written.inner.errors).toHaveLength(11)
    expect(JSON.stringify(written.inner.errors.at(-1))).toContain('_omitted":2')
  })
})
