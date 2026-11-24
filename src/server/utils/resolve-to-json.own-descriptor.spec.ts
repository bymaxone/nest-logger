/**
 * Pins that a `toJSON` is read from its descriptor as own fields only: a data property is not an
 * accessor, and a setter-only accessor has no value, even when `Object.prototype` carries a `get` or a
 * `value` that a descriptor would otherwise inherit.
 *
 * Layer: server/utils, tests. Pure.
 */
import { resolveToJson } from './resolve-to-json.util'

/** Runs `body` with `key` planted on `Object.prototype`, and takes it off again. */
function withPlanted<T>(key: 'get' | 'value', planted: unknown, body: () => T): T {
  Object.defineProperty(Object.prototype, key, {
    value: planted,
    configurable: true,
    writable: true
  })
  try {
    return body()
  } finally {
    Reflect.deleteProperty(Object.prototype, key)
  }
}

describe('resolveToJson reads own descriptor fields only', () => {
  /**
   * Given a data `toJSON` and a function planted as `get` on Object.prototype
   * When it is resolved
   * Then the method is the data one, it is not volatile, and the planted function never ran
   */
  it('does not take an inherited get for the accessor of a data toJSON', () => {
    const planted = jest.fn(() => (): unknown => 'forged')
    const own = (): unknown => 'own'
    const value = { toJSON: own }

    const resolved = withPlanted('get', planted, () => resolveToJson(value))

    expect(resolved).toEqual({ method: own, volatile: false })
    expect(planted).not.toHaveBeenCalled()
  })

  /**
   * Given a setter-only accessor `toJSON` and a function planted as `value` on Object.prototype
   * When it is resolved
   * Then there is no method, because the accessor has no getter and no value of its own
   */
  it('does not take an inherited value for a toJSON with no getter', () => {
    const value = Object.defineProperty({}, 'toJSON', { set: jest.fn(), configurable: true })

    const resolved = withPlanted(
      'value',
      () => 'forged',
      () => resolveToJson(value)
    )

    expect(resolved).toEqual({ method: undefined, volatile: false })
  })
})
