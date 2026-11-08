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
