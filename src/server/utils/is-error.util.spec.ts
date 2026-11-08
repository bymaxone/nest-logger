/**
 * Pins what `isError` accepts: a native error of any realm, and an object that inherits from this
 * realm's `Error` without being one.
 *
 * Layer: server, utils, tests.
 */
import { runInNewContext } from 'node:vm'
import { isError } from './is-error.util'

describe('isError', () => {
  it.each([
    ['an Error', () => new Error('x')],
    ['a TypeError', () => new TypeError('x')],
    ['an Error of another realm', () => runInNewContext('new RangeError("x")')],
    ['an object that inherits from Error without being one', () => Object.create(Error.prototype)],
    ['a subclass of Error', () => new (class Failure extends Error {})('x')]
  ])('accepts %s', (_label, make) => {
    expect(isError(make())).toBe(true)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'Error: x'],
    ['a number', 7],
    ['a plain object shaped like an error', { name: 'Error', message: 'x' }],
    ['an array', [new Error('x')]]
  ])('rejects %s', (_label, value) => {
    expect(isError(value)).toBe(false)
  })

  it('rejects a Proxy whose prototype is Error.prototype only through a trap, without throwing', () => {
    const proxy = new Proxy({}, { getPrototypeOf: () => Error.prototype })

    expect(() => isError(proxy)).not.toThrow()
  })

  it('rejects a Proxy whose getPrototypeOf trap throws', () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('trap')
        }
      }
    )

    expect(isError(proxy)).toBe(false)
  })
})
