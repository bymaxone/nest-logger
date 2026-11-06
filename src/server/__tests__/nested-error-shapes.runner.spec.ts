/**
 * Pins the criterion the shape specs judge with, so that a weakness in it shows up here and not as a
 * shape that passes for the wrong reason.
 *
 * Layer: server, tests.
 */
import { problem } from './nested-error-shapes.runner'

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

  it('does not count a masked stack as a value the new entry may drop for free', () => {
    expect(
      problem(
        { err: { stack: '<stack>' }, inner: { stack: '<stack>' } },
        { err: { stack: '<stack>' }, inner: {} }
      )
    ).toMatch(/^LOST /)
  })

  it('sees a new throw, a new record failure and a new secret marker, and forgives the reverse', () => {
    expect(problem({ a: 1 }, 'THROW boom')).toBe('throws: THROW boom')
    expect(problem({ a: 1 }, { _redactionFailed: true })).toBe('record-level failure')
    expect(problem({ a: 'ok' }, { a: 'SECRET' })).toBe('LEAK SECRET')
    expect(problem({ _redactionFailed: true }, { a: 1 })).toBe('')
    expect(problem({ a: 'SECRET' }, { a: '[REDACTED]' })).toBe('')
  })
})
