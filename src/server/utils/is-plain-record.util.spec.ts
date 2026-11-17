/**
 * Verifies isPlainRecord: an object literal, a null-prototype object and a parsed JSON object are
 * plain; null, primitives, arrays, errors, dates and class instances are not; an object whose
 * prototype cannot be read is not.
 *
 * Layer: server/utils, tests.
 */
import { isPlainRecord } from './is-plain-record.util'

describe('isPlainRecord', () => {
  it.each([
    ['an object literal', (): unknown => ({ a: 1 })],
    ['an empty object', (): unknown => ({})],
    ['a null-prototype object', (): unknown => Object.create(null)],
    ['a parsed JSON object', (): unknown => JSON.parse('{"a":{"b":1}}')]
  ])('accepts %s', (_label, make) => {
    expect(isPlainRecord(make())).toBe(true)
  })

  it.each([
    ['null', (): unknown => null],
    ['undefined', (): unknown => undefined],
    ['a string', (): unknown => 'text'],
    ['a number', (): unknown => 1],
    ['a function', (): unknown => (): void => undefined],
    ['an array', (): unknown => [1]],
    ['an Error', (): unknown => new Error('x')],
    ['a Date', (): unknown => new Date(0)],
    [
      'a class instance',
      (): unknown =>
        new (class Dto {
          readonly a = 1
        })()
    ],
    [
      'an object whose prototype is a null-prototype object',
      (): unknown => Object.create(Object.create(null))
    ]
  ])('rejects %s', (_label, make) => {
    expect(isPlainRecord(make())).toBe(false)
  })

  it('rejects an object whose prototype cannot be read instead of throwing', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error('trap')
        }
      }
    )

    expect(isPlainRecord(hostile)).toBe(false)
  })
})
