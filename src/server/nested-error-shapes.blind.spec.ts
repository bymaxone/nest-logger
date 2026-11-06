/**
 * Shapes of a nested `Error`, the blind spots: the ones a comparison of leaf values alone would miss. Values under
 * a `stack` key, `null` leaves, a node that breaks only when the record is stringified, a user
 * redaction leaf that names a key the node uses, and shapes on which 1.4.8 failed the whole record,
 * which cannot be compared and so say what they must keep. Judged against the entry 1.4.8 wrote for
 * the same shape (`__tests__/nested-error-shapes.blind.base.json`).
 *
 * Layer: server, tests. To record a base, run this file with `RECORD_SHAPES=<path>` on the tree
 * whose output is the reference.
 */
import { writeFileSync } from 'node:fs'

import { judge, loadBase, run, type Shape } from './__tests__/nested-error-shapes.runner'

const cases: Record<string, () => Shape> = {}
const add = (name: string, make: () => Shape): void => {
  cases[name] = make
}

/** An Error with the given own enumerable fields. */
const withFields = (message: string, fields: Record<string, unknown>): Error =>
  Object.assign(new Error(message), fields)

/** An Error whose stack has been read, so a `name` set afterwards does not reach its header. */
const withPinnedStack = (message: string): Error => {
  const error = new Error(message)
  void error.stack
  return error
}

/** An Error whose own `toJSON` throws when it is called. */
const throwingToJson = (message: string, fields: Record<string, unknown>): Error =>
  withFields(message, {
    ...fields,
    toJSON(): never {
      throw new Error('toJSON exploded')
    }
  })

/** A list whose array species constructor throws when a method asks for a new array. */
const speciesThrows = (members: unknown[]): unknown[] =>
  Object.defineProperty(members, 'constructor', {
    value: {
      [Symbol.species]: class {
        constructor() {
          throw new Error('species exploded')
        }
      }
    }
  })

add('errors-list-whose-species-throws', () => ({
  meta: {
    inner: withFields('inner', {
      errors: speciesThrows([withFields('member', { code: 'KEEPmember' })]),
      sibling: 'KEEPsibling'
    })
  }
}))
add('cause-with-own-toJSON-that-throws', () => ({
  meta: {
    inner: Object.assign(
      new Error('outer', { cause: throwingToJson('link', { code: 'KEEPlink' }) }),
      {
        code: 'KEEPouter'
      }
    ),
    sibling: 'KEEPtop'
  }
}))
add('errors-member-with-own-toJSON-that-throws', () => ({
  meta: {
    inner: Object.assign(
      new AggregateError([throwingToJson('link', { code: 'KEEPlink2' })], 'agg'),
      {
        code: 'KEEPouter2'
      }
    ),
    sibling: 'KEEPtop2'
  }
}))
add('enumerable-stack-object', () => ({
  meta: {
    inner: Object.defineProperty(withFields('s', { z: 'KEEPz' }), 'stack', {
      value: { v: 'KEEPstack' },
      enumerable: true
    })
  }
}))
add('enumerable-stack-number', () => ({
  meta: {
    inner: Object.defineProperty(withFields('s', { z: 'KEEPz2' }), 'stack', {
      value: 12345,
      enumerable: true
    })
  }
}))
add('enumerable-stack-text', () => ({
  meta: {
    inner: Object.defineProperty(withFields('s', { z: 'KEEPz3' }), 'stack', {
      value: 'KEEPline1\n    at somewhere',
      enumerable: true
    })
  }
}))
add('redaction-leaf-type-with-own-name', () => ({
  meta: { inner: withFields('m', { name: 'ValidationError' }) },
  extra: { redactPaths: ['*.type'] }
}))
add('redaction-leaf-fields-with-own-type', () => ({
  meta: { inner: withFields('m', { type: 'KEEPtype', fields: { z: 'KEEPf' } }) },
  extra: { redactPaths: ['*.fields'] }
}))
add('null-and-falsy-leaves', () => ({
  meta: {
    inner: withFields('o', { cause: null, errors: [null], n: null, zero: 0, off: false, empty: '' })
  }
}))
add('own-toJSON-that-throws-with-sibling', () => ({
  meta: { inner: throwingToJson('t', { sibling: 'KEEPsib' }) }
}))
add('field-with-toJSON-that-throws-with-sibling', () => ({
  meta: {
    inner: withFields('o', {
      field: {
        toJSON(): never {
          throw new Error('toJSON exploded')
        }
      },
      sibling: 'KEEPsib2'
    })
  }
}))
add('proxy-whose-prototype-read-throws-with-sibling', () => ({
  meta: {
    inner: new Proxy(withFields('p', { sibling: 'KEEPsib3' }), {
      getPrototypeOf(): never {
        throw new Error('exploded')
      }
    })
  }
}))
add('serializer-output-with-error-under-a-small-size-cap', () => ({
  meta: { thing: 1 },
  extra: {
    maxEntrySizeBytes: 300,
    serializers: { thing: () => ({ status: 500, code: 'E_X', inner: new Error('x') }) }
  }
}))

/** An Error whose `key` is defined with `value`, as an own data property. */
const withPart = (key: string, value: unknown, enumerable: boolean): Error =>
  Object.defineProperty(new Error('part'), key, { value, enumerable })

/** An Error whose `key` is an accessor that throws when it is read. */
const withHostilePart = (key: string): Error =>
  Object.defineProperty(new Error('part'), key, {
    get(): never {
      throw new Error('getter exploded')
    }
  })

for (const key of ['message', 'name']) {
  for (const enumerable of [false, true]) {
    add(`${key}-holding-an-object-${enumerable ? 'enumerable' : 'non-enumerable'}`, () => ({
      meta: { inner: withPart(key, { password: 'LEAK', keep: 'KEEPobj' }, enumerable) }
    }))
  }
  add(`${key}-whose-getter-throws-with-sibling`, () => ({
    meta: { inner: Object.assign(withHostilePart(key), { sibling: 'KEEPsib' }) }
  }))
}
add('stack-holding-an-object-non-enumerable', () => ({
  meta: { inner: withPart('stack', { password: 'LEAK', keep: 'KEEPstk' }, false) }
}))
add('redaction-leaf-name-with-own-name', () => ({
  // The stack is read first: V8 formats it on first read, and a later `name` would land in its header.
  meta: { inner: Object.assign(withPinnedStack('o'), { name: 'LEAKperson' }) },
  extra: { redactPaths: ['*.name'] }
}))
add('redaction-leaf-name-with-prototype-name', () => ({
  meta: { inner: new (class Sub extends Error {})('o') },
  extra: { redactPaths: ['*.name'] }
}))
add('redaction-leaf-name-with-own-name-in-the-stack-header', () => ({
  meta: { inner: Object.assign(new Error('o'), { name: 'LEAKperson' }) },
  extra: { redactPaths: ['*.name'] }
}))
add('redaction-leaf-name-with-prototype-name-in-the-stack-header', () => {
  class Sub extends Error {}
  Sub.prototype.name = 'LEAKproto'
  return { meta: { inner: new Sub('o') }, extra: { redactPaths: ['*.name'] } }
})
add('redaction-leaf-message-with-message-in-the-stack-header', () => ({
  meta: { inner: new Error('LEAKmessage') },
  extra: { redactPaths: ['*.message'] }
}))

/** Shapes that show less by decision: none in this part. */
const ACCEPTED: Record<string, RegExp> = {}

describe('nested Error shapes, the blind spots, against the 1.4.8 output', () => {
  if (process.env.RECORD_SHAPES) {
    it('records the output of this tree as the base', () => {
      const out = Object.fromEntries(Object.entries(cases).map(([name, make]) => [name, run(make)]))
      writeFileSync(process.env.RECORD_SHAPES as string, JSON.stringify(out, null, 1))
    })
    return
  }

  const base = loadBase('nested-error-shapes.blind.base.json')

  it('has a recorded base for every shape and no base for a shape that is gone', () => {
    expect(Object.keys(base).sort()).toStrictEqual(Object.keys(cases).sort())
  })

  it.each(Object.keys(cases))('%s loses nothing and leaks nothing that 1.4.8 did not', (name) => {
    expect(judge(base[name], cases[name] as () => Shape)).toMatch(ACCEPTED[name] ?? /^$/)
  })
})
