/**
 * Shapes of a nested `Error`, part C: the ones a first review of the node writer found it loses,
 * each with a leaf of its own next to the part under test so that losing the part, or the rest of the
 * node, shows. Judged against the entry 1.4.8 wrote for the same shape (`__tests__/nested-error-shapes.c.base.json`).
 *
 * Layer: server, tests. To record a base, run this file with `RECORD_SHAPES=<path>` on the tree
 * whose output is the reference.
 */
import { writeFileSync } from 'node:fs'

import { loadBase, problem, run, type Shape } from './__tests__/nested-error-shapes.runner'

const cases: Record<string, () => Shape> = {}
const add = (name: string, make: () => Shape): void => {
  cases[name] = make
}

/** An Error with the given own enumerable fields. */
const withFields = (message: string, fields: Record<string, unknown>): Error =>
  Object.assign(new Error(message), fields)

/** A value whose reading throws. */
const hostile = (): Record<string, unknown> => ({
  get exploded(): never {
    throw new Error('exploded')
  }
})

add('own-type-and-fields', () => ({
  meta: { inner: withFields('t', { type: 'KEEPtype', fields: { z: 'KEEPf' }, other: 'KEEPother' }) }
}))
add('own-type-and-fields-in-array', () => ({
  meta: {
    list: [withFields('t', { type: 'KEEPtype2', fields: { z: 'KEEPf2' }, other: 'KEEPother2' })]
  }
}))
add('own-fields-without-type', () => ({
  meta: { inner: withFields('t', { fields: { z: 'KEEPf3' }, other: 'KEEPother3' }) }
}))
add('own-inherited-names', () => ({
  meta: {
    inner: withFields('t', {
      toString: 'KEEPts',
      constructor: 'KEEPctor',
      hasOwnProperty: 'KEEPhop'
    })
  }
}))
add('own-incomplete-marker-name', () => ({
  meta: { inner: withFields('t', { _errorFieldsIncomplete: 'KEEPmarker', other: 'KEEPother4' }) }
}))
add('hostile-enumerable-cause-with-sibling', () => ({
  meta: { inner: withFields('o', { cause: hostile(), good: 'KEEPgood' }) }
}))
add('hostile-cause-object-with-sibling', () => ({
  meta: { inner: Object.assign(new Error('o', { cause: hostile() }), { good: 'KEEPgood2' }) }
}))
add('hostile-errors-member-with-sibling', () => ({
  meta: { inner: Object.assign(new AggregateError([hostile()], 'agg'), { good: 'KEEPgood3' }) }
}))
add('hostile-field-with-sibling', () => ({
  meta: { inner: withFields('o', { first: 'KEEPfirst', bad: hostile(), last: 'KEEPlast' }) }
}))
add('hostile-cause-keeps-stack', () => ({
  meta: { inner: Object.assign(new Error('o', { cause: hostile() }), { code: 'KEEPcode' }) }
}))
add('errors-nested-through-fields', () => {
  let chain: Error = withFields('e6', { code: 'KEEPcode6' })
  for (let index = 5; index >= 0; index--) {
    chain = withFields(`e${index}`, { code: `KEEPcode${index}`, w: chain })
  }
  return { meta: { inner: chain } }
})
add('errors-nested-through-array-fields', () => {
  let chain: Error = withFields('a6', { code: 'KEEPacode6' })
  for (let index = 5; index >= 0; index--) {
    chain = withFields(`a${index}`, { code: `KEEPacode${index}`, list: [chain] })
  }
  return { meta: { inner: chain } }
})
add('errors-array-with-toJSON', () => ({
  meta: {
    inner: Object.assign(new Error('x'), {
      errors: Object.assign([new Error('m1')], { toJSON: () => ['KEEPtj2'] }),
      sibling: 'KEEPsibling'
    })
  }
}))
add('errors-array-subclass-with-toJSON', () => {
  class Members extends Array<unknown> {
    toJSON(): unknown {
      return ['KEEPtj3']
    }
  }
  const list = new Members()
  list.push(new Error('m1'))
  return { meta: { inner: withFields('x', { errors: list, sibling: 'KEEPsibling2' }) } }
})
add('duplicate-leaf-values', () => ({
  meta: { inner: withFields('d', { a: 'KEEPdup', b: 'KEEPdup', c: ['KEEPdup'] }) }
}))
add('own-stack-not-text', () => ({
  meta: { inner: withFields('s', { stack: { v: 'KEEPstack' }, sibling: 'KEEPsibling3' }) }
}))
add('to-json-getter-throws-with-fields', () => ({
  meta: {
    inner: Object.defineProperty(withFields('x', { sibling: 'KEEPsibling4' }), 'toJSON', {
      get: () => {
        throw new Error('exploded')
      }
    })
  }
}))
add('error-in-array-field-with-sibling', () => ({
  meta: {
    inner: withFields('o', {
      list: [new Error('in-array', { cause: new Error('deep') })],
      sibling: 'KEEPsibling5'
    })
  }
}))

/**
 * Shapes that show less by decision. 1.4.8 stood in for a cause it could not read with
 * `{ name: 'UnknownError', message: '[object Object]' }`, which came from turning the value into text,
 * and that call can run a method of the user's. The sibling field and the stack are kept; the node is
 * marked incomplete instead.
 */
const ACCEPTED: Record<string, RegExp> = {
  'hostile-enumerable-cause-with-sibling': /^LOST "UnknownError" "\[object Object\]"$/
}

describe('nested Error shapes, part C, against the 1.4.8 output', () => {
  if (process.env.RECORD_SHAPES) {
    it('records the output of this tree as the base', () => {
      const out = Object.fromEntries(Object.entries(cases).map(([name, make]) => [name, run(make)]))
      writeFileSync(process.env.RECORD_SHAPES as string, JSON.stringify(out, null, 1))
    })
    return
  }

  const base = loadBase('nested-error-shapes.c.base.json')

  it('has a recorded base for every shape and no base for a shape that is gone', () => {
    expect(Object.keys(base).sort()).toStrictEqual(Object.keys(cases).sort())
  })

  it.each(Object.keys(cases))('%s loses nothing and leaks nothing that 1.4.8 did not', (name) => {
    expect(problem(base[name], run(cases[name] as () => Shape))).toMatch(ACCEPTED[name] ?? /^$/)
  })
})
