/**
 * Pins that no callable `toJSON` survives the redaction walk under `errorOwnFields: 'all'`.
 * `JSON.stringify` reads `toJSON` with `[[Get]]` after the redaction, so a hook the walk did not
 * see (because the object hid it from a descriptor read, or answered differently the second time)
 * runs afterwards and can write a field under a censored name in clear.
 *
 * Layer: server, utils, tests.
 */
import { createNameRedactor } from './redact-by-name.util'

const SECRET = 'SECRET-VALUE'

/** The output of the redactor, serialized the way the log line is. */
function written(value: unknown, isRecordRoot = true, serializedKeys?: readonly string[]): string {
  return JSON.stringify(createNameRedactor(['password'], 'X', serializedKeys)(value, isRecordRoot))
}

/** A function-valued Proxy whose `get` trap answers a hook that `has` and descriptors hide. */
const hidingProxy = (): object =>
  new Proxy(() => 1, {
    get: (target, key) =>
      key === 'toJSON' ? () => ({ password: SECRET }) : Reflect.get(target, key),
    has: (target, key) => key !== 'toJSON' && Reflect.has(target, key),
    getOwnPropertyDescriptor: (target, key) =>
      key === 'toJSON' ? undefined : Reflect.getOwnPropertyDescriptor(target, key)
  })

/** A function-valued Proxy that answers no hook the first time and a hook afterwards. */
const statefulProxy = (): object => {
  let reads = 0
  return new Proxy(() => 1, {
    get: (target, key) =>
      key === 'toJSON' && reads++ > 0 ? () => ({ password: SECRET }) : Reflect.get(target, key)
  })
}

/** A function with an accessor `toJSON` that answers no hook the first time. */
const statefulFunction = (): object => {
  let reads = 0
  const fn = (): number => 1
  Object.defineProperty(fn, 'toJSON', {
    get: () => (reads++ === 0 ? undefined : () => ({ password: SECRET }))
  })
  return fn
}

/** An `Error` with an accessor `toJSON` that answers no hook the first time. */
const statefulError = (enumerable: boolean): Error => {
  let reads = 0
  const error = new Error('boom')
  Object.defineProperty(error, 'toJSON', {
    enumerable,
    get: () => (reads++ === 0 ? undefined : () => ({ password: SECRET }))
  })
  return error
}

describe('a hook the walk could not see', () => {
  it.each([
    ['a Proxy that hides its hook from descriptors', hidingProxy],
    ['a Proxy that answers a hook only after the first read', statefulProxy],
    ['a function with a stateful accessor', statefulFunction]
  ])('does not run in the stringifier after a callable: %s', (_name, make) => {
    expect(written({ run: make() })).not.toContain(SECRET)
    expect(written({ list: [make()] })).not.toContain(SECRET)
  })

  it.each([
    ['not enumerable', false],
    ['enumerable', true]
  ])('does not run after an Error with a stateful accessor that is %s', (_name, enumerable) => {
    expect(written({ err: statefulError(enumerable) })).not.toContain(SECRET)
    expect(written({ meta: { cause: statefulError(enumerable) } })).not.toContain(SECRET)
  })

  it('does not run after an Error under a serializer key', () => {
    expect(written({ err: statefulError(false) }, true, ['err'])).not.toContain(SECRET)
  })
})

/** An object with an enumerable `toJSON` accessor that answers no hook the first time. */
const withStatefulAccessor = <T extends object>(target: T): T => {
  let reads = 0
  Object.defineProperty(target, 'toJSON', {
    enumerable: true,
    get: () => (reads++ === 0 ? undefined : () => ({ password: SECRET }))
  })
  return target
}

/** A function whose prototype is a Proxy that hides a hook from descriptors. */
const functionWithHidingPrototype = (): object => {
  const fn = (): number => 1
  Object.setPrototypeOf(
    fn,
    new Proxy(
      {},
      {
        get: (target, key) =>
          key === 'toJSON' ? () => ({ password: SECRET }) : Reflect.get(target, key),
        has: (target, key) => key !== 'toJSON' && Reflect.has(target, key),
        getOwnPropertyDescriptor: (target, key) =>
          key === 'toJSON' ? undefined : Reflect.getOwnPropertyDescriptor(target, key)
      }
    )
  )
  return fn
}

describe('a hook behind an enumerable accessor on a copy', () => {
  class Instance {
    readonly a = 1
  }

  it.each([
    ['a plain object', (): object => withStatefulAccessor({})],
    ['a class instance', (): object => withStatefulAccessor(new Instance())],
    ['a Map', (): object => withStatefulAccessor(new Map())],
    ['an array', (): object => withStatefulAccessor([])]
  ])('is not run after %s', (_name, make) => {
    expect(written({ x: make() })).not.toContain(SECRET)
    expect(written({ list: [make()] })).not.toContain(SECRET)
  })

  it.each([
    ['under a serializer key', ['err']],
    ['with no serializer key', undefined]
  ])('is not run after an Error written as data, %s', (_name, keys) => {
    expect(written({ other: withStatefulAccessor(new Error('boom')) }, true, keys)).not.toContain(
      SECRET
    )
  })

  it('keeps a toJSON function key at the record root, which Pino iterates and never stringifies', () => {
    const hook = (): number => 1

    const copy = createNameRedactor(['password'], 'X')({ a: 1, toJSON: hook }, true) as Record<
      string,
      unknown
    >

    expect(copy['toJSON']).toBe(hook)
  })

  it('keeps the other own fields of the object', () => {
    const copy = createNameRedactor(['password'], 'X')(
      withStatefulAccessor({ a: 1, password: 'p' }),
      false
    ) as Record<string, unknown>

    expect(copy['a']).toBe(1)
    expect(copy['password']).toBe('X')
    expect(Object.keys(copy)).not.toContain('toJSON')
  })
})

describe('a hook behind the prototype chain of a callable', () => {
  it('is not run after a function whose prototype is a Proxy that hides it', () => {
    expect(written({ run: functionWithHidingPrototype() })).not.toContain(SECRET)
    expect(written({ list: [functionWithHidingPrototype()] })).not.toContain(SECRET)
  })
})

describe('a toJSON accessor that shadows a hook the walk did not follow', () => {
  /** An `Error` class whose prototype has a `toJSON` method, which the walk never reads past a shadow. */
  class Hooked extends Error {
    toJSON(): object {
      return { password: SECRET }
    }
  }

  const shadowed = (enumerable: boolean, stateful: boolean): Error => {
    let reads = 0
    const error = new Hooked('boom')
    Object.defineProperty(error, 'toJSON', {
      enumerable,
      get: () => (stateful && reads++ > 0 ? () => ({ password: SECRET }) : undefined)
    })
    return error
  }

  it.each([
    ['not enumerable and constant', false, false],
    ['not enumerable and stateful', false, true],
    ['enumerable and constant', true, false],
    ['enumerable and stateful', true, true]
  ])(
    'keeps the shadow, so the prototype method does not run: %s',
    (_name, enumerable, stateful) => {
      expect(written({ err: shadowed(enumerable, stateful) })).not.toContain(SECRET)
      expect(written({ err: shadowed(enumerable, stateful) }, true, ['err'])).not.toContain(SECRET)
    }
  )
})
