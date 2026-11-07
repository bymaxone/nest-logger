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
  ['an Error under the key err', () => ({ err: errorWithHook() })],
  ['an Error under a key with a serializer', () => ({ thing: errorWithHook() })]
]

const SAFE = createOwnFieldPolicy('safe', [])

/** The ways the walk is built: the caller's record or serializer output, with each policy. */
const configurations = [
  {
    name: 'record, all',
    coversPassword: true,
    build: () => createNameRedactor(['password'], 'X', ['err', 'thing'], undefined, ALL_OWN_FIELDS)
  },
  {
    name: 'record, safe',
    coversPassword: true,
    build: () => createNameRedactor(['password'], 'X', ['err', 'thing'], undefined, SAFE)
  },
  {
    name: 'record, safe, toJSON listed as an own field',
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
    coversPassword: false,
    build: () => createNameRedactor(new Set<string>(), 'X', ['err', 'thing'], undefined, SAFE)
  },
  {
    name: 'serializer output, all',
    coversPassword: true,
    build: () => createNameRedactor(['password'], 'X', undefined, undefined, ALL_OWN_FIELDS)
  },
  {
    name: 'serializer output, safe',
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

describe('the output of the redaction walk', () => {
  describe.each(configurations)('as $name', ({ build, coversPassword }) => {
    it.each(shapes)('carries no hook that runs after it, for %s', (_shape, make) => {
      const written = build()(make(), true)

      expect(hooksIn(written)).toEqual([])
      if (coversPassword) expect(JSON.stringify(written)).not.toContain(SECRET)
    })
  })
})

describe('what the walk keeps beside the hooks it removes', () => {
  it('keeps a function that is not a toJSON as one that still works, and a toJSON that is not a function', () => {
    const redact = createNameRedactor(['password'], 'X', undefined, undefined, ALL_OWN_FIELDS)
    const run = (): number => 1

    const output = redact(
      { run, nested: Object.assign(new Error('o'), { run, toJSON: 'text' }) },
      true
    ) as {
      run: () => number
      nested: Record<string, unknown> & { run: () => number }
    }

    expect(output.run()).toBe(1)
    expect(output.nested.run()).toBe(1)
    expect(output.nested['toJSON']).toBe('text')
  })

  it('hands on a function whose toJSON read as no hook as one that still calls the original', () => {
    const owner = { base: 10 }
    function add(this: { base: number }, left: number, right: number): number {
      return this.base + left + right
    }
    withStatefulHook(add)
    const redact = createNameRedactor(['password'], 'X', undefined, undefined, ALL_OWN_FIELDS)

    const output = redact({ add }, true) as { add: (this: unknown, ...args: number[]) => number }

    expect(output.add).not.toBe(add)
    expect(output.add.call(owner, 1, 2)).toBe(13)
    expect(JSON.stringify({ add: output.add })).toBe('{}')
  })

  it('gives that function no toJSON even when one is inherited from Function.prototype', () => {
    const run = withStatefulHook((): number => 1)
    const redact = createNameRedactor(['password'], 'X', undefined, undefined, ALL_OWN_FIELDS)
    Object.defineProperty(Function.prototype, 'toJSON', {
      value: () => ({ password: SECRET }),
      configurable: true
    })

    try {
      const output = redact({ run }, true) as { run: { toJSON?: unknown } }

      expect(output.run.toJSON).toBeUndefined()
    } finally {
      Reflect.deleteProperty(Function.prototype, 'toJSON')
    }
  })
})
