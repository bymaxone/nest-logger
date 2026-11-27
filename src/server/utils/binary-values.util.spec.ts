/**
 * @fileoverview Finding binary values where Pino's redact paths would copy them.
 * @layer server/utils
 */
import { types } from 'node:util'

import { binaryAsField, needsTheWalk } from './binary-values.util'
import { REDACT_MAX_VISITS } from './redact-by-name.util'

describe('needsTheWalk', () => {
  it.each<readonly [string, unknown]>([
    ['a Buffer', Buffer.from('x')],
    ['a DataView', new DataView(new ArrayBuffer(1))],
    ['a member of a member', { a: [{ b: new Uint8Array(1) }] }]
  ])('finds %s', (_name, value) => {
    expect(needsTheWalk(value)).toBe(true)
  })

  it.each<readonly [string, unknown]>([
    ['a string', 'x'],
    ['null', null],
    ['an object with none', { a: [1, 'b', null, {}] }],
    ['an ArrayBuffer, which is not a view', new ArrayBuffer(1)],
    ['a member that is not enumerable', Object.defineProperty({}, 'a', { value: Buffer.from('x') })]
  ])('finds none in %s', (_name, value) => {
    expect(needsTheWalk(value)).toBe(false)
  })

  it('looks at a shared or a cyclic member once, so that a cycle ends', () => {
    const shared = { a: 1 }
    const cycle: Record<string, unknown> = { shared, again: shared }
    cycle['self'] = cycle

    expect(needsTheWalk(cycle)).toBe(false)
  })

  it('answers that what it cannot read holds one', () => {
    const failing = jest.spyOn(types, 'isProxy').mockImplementation(() => {
      throw new Error('no')
    })

    expect(needsTheWalk({})).toBe(true)
    failing.mockRestore()
  })

  it.each([
    ['stops at the limit of members, which it reads whole', REDACT_MAX_VISITS, false],
    ['leaves what has more members than the limit to the walk', REDACT_MAX_VISITS + 1, true]
  ])('%s', (_name, members, expected) => {
    expect(needsTheWalk(Array.from({ length: members }, () => 0))).toBe(expected)
  })

  it('calls no getter and no toJSON', () => {
    let calls = 0
    const count = (): number => (calls += 1)
    const getter = {
      get a(): number {
        return count()
      }
    }

    expect(needsTheWalk(getter)).toBe(true)
    expect(needsTheWalk({ t: { toJSON: count } })).toBe(true)
    expect(needsTheWalk(Object.defineProperty({}, 'toJSON', { get: count }))).toBe(true)
    expect(calls).toBe(0)
  })

  it.each<readonly [string, unknown, boolean]>([
    [
      'a toJSON of a class',
      new (class Held {
        toJSON(): number {
          return 1
        }
      })(),
      true
    ],
    ['a toJSON of a function', Object.assign(() => 1, { toJSON: () => 1 }), true],
    ['a function without one', { f: () => 1 }, false],
    ['a Proxy', new Proxy({}, {}), true],
    ['a Proxy among the prototypes', Object.create(new Proxy({}, {})) as object, true],
    ['a toJSON that is no function', { toJSON: 'text' }, false],
    [
      'a setter alone',
      Object.defineProperty({}, 'a', {
        set: (next: unknown) => {
          expect(next).toBeDefined()
        },
        enumerable: true
      }),
      true
    ],
    ['a Date', { at: new Date(0) }, false],
    ['a toJSON of its own on a Date', Object.assign(new Date(0), { toJSON: () => 1 }), true],
    ['an object without a prototype', Object.create(null) as object, false]
  ])('answers for %s', (_name, value, expected) => {
    expect(needsTheWalk(value)).toBe(expected)
  })

  it('answers that a chain of prototypes with no end in sight may run code', () => {
    let deep: object = {}
    for (let hop = 0; hop < 300; hop++) deep = Object.create(deep) as object

    expect(needsTheWalk(deep)).toBe(true)
  })
})

describe('binaryAsField', () => {
  it('gives a view as one field with its size', () => {
    expect(binaryAsField(Buffer.from('abc'))).toStrictEqual({ binary: '[Binary 3 bytes]' })
  })

  it('gives anything else as it is', () => {
    const fields = { a: Buffer.from('abc') }

    expect(binaryAsField(fields)).toBe(fields)
    expect(binaryAsField(undefined)).toBeUndefined()
  })
})
