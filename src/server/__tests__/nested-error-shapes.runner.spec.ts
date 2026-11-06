/**
 * Pins the criterion the shape specs judge with, so that a weakness in it shows up here and not as a
 * shape that passes for the wrong reason.
 *
 * Layer: server, tests.
 */
import { judge, problem, runShape } from './nested-error-shapes.runner'

describe('the shape criterion', () => {
  it('sees a repeated value that was written twice and is written once', () => {
    expect(problem({ a: ['x', 'x'] }, { a: ['x'] })).toMatch(/^LOST /)
  })

  it('accepts the same values under other keys and in another order', () => {
    expect(problem({ name: 'E', list: [1, 2] }, { type: 'E', other: [2, 1] })).toBe('')
  })

  it('sees a value that is gone even when another leaf holds a different value', () => {
    expect(problem({ code: 'KEEP-1', note: 'a' }, { note: 'a' })).toBe('LOST "KEEP-1"')
  })

  it('sees a stack that is gone, and a stack whose first line changed', () => {
    expect(problem({ inner: { stack: 'Error: a' } }, { inner: {} })).toMatch(/^LOST /)
    expect(problem({ inner: { stack: 'Error: a' } }, { inner: { stack: 'Error: b' } })).toMatch(
      /^LOST /
    )
  })

  it('counts a null leaf', () => {
    expect(problem({ cause: null, errors: [null] }, { errors: [null] })).toBe('LOST null')
  })

  it('sees a key that Pino replaced because its value could not be stringified', () => {
    const replaced = '[unable to serialize, circular reference is too complex to analyze]'

    expect(problem({ inner: { code: 'x' } }, { inner: replaced })).toBe(
      'unserializable at stringify time'
    )
    expect(problem({ inner: replaced }, { inner: replaced })).toBe('')
  })

  it('sees a new throw, a new record failure and a new secret marker, and forgives the reverse', () => {
    expect(problem({ a: 1 }, 'THROW boom')).toBe('throws: THROW boom')
    expect(problem({ a: 1 }, { _redactionFailed: true })).toBe('record-level failure')
    expect(problem({ a: 'ok' }, { a: 'SECRET' })).toBe('LEAK SECRET')
    expect(problem({ _redactionFailed: true }, { a: 1 })).toBe('')
    expect(problem({ a: 'SECRET' }, { a: '[REDACTED]' })).toBe('')
  })

  it('masks a stack to its first line when it logs a shape', () => {
    const entry = runShape({ meta: { inner: Object.assign(new Error('x'), { code: 1 }) } }) as {
      err: { stack: string }
    }

    expect(entry.err.stack).toBe('Error: root')
  })

  it('judges a shape on which the base failed by what it says it keeps', () => {
    const base = { _redactionFailed: true }
    const shape = (keeps: string[]) => () => ({
      meta: { inner: Object.assign(new Error('x'), { sibling: 'KEEPsib' }) },
      keeps
    })

    expect(judge(base, shape(['KEEPsib']))).toBe('')
    expect(judge(base, shape(['KEEPnot']))).toBe('MISSING KEEPnot')
  })
})
