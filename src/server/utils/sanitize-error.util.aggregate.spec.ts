/**
 * Pins how `sanitizeError` reads the width marker a list of `AggregateError.errors` can already end
 * in, once the redaction walk has capped it: the number it carries is kept when it is a positive
 * integer on the last element of a list one past the cap, and every other value is a member.
 *
 * Layer: server, utils, tests.
 */
import { sanitizeError } from './sanitize-error.util'

describe('sanitizeError, the width marker of an AggregateError', () => {
  it(/*
   * A list the redaction walk already capped ends in its width marker. The marker says how many
   * members were left out, so that number is kept: counting the marker as one more member would
   * report 1 where 90 were omitted.
   */
  'should keep the omitted count of a width marker the list already ends in', () => {
    const members = Array.from({ length: 10 }, (_, i) => new Error(`e${i}`))
    const marker = { _truncated: true, _reason: 'aggregate-width-exceeded', _omitted: 90 }
    const result = sanitizeError(new AggregateError([...members, marker], 'already capped'))

    expect(result.errors).toHaveLength(11)
    expect(result.errors?.[10]).toEqual(marker)
  })

  it.each([
    ['a marker-shaped member in a longer list', { _truncated: true, _omitted: 1e9 }, 91, 81],
    ['a negative count', { _truncated: true, _omitted: -5 }, 11, 1],
    ['a count that is a string', { _truncated: true, _omitted: 'abc' }, 11, 1],
    ['a count of zero', { _truncated: true, _omitted: 0 }, 11, 1],
    ['a flag that is false', { _truncated: false, _omitted: 5 }, 11, 1],
    ['a flag that is not a boolean', { _truncated: 'yes', _omitted: 5 }, 11, 1],
    ['a count that is a numeric string', { _truncated: true, _omitted: '5' }, 11, 1],
    ['a count that is a Symbol', { _truncated: true, _omitted: Symbol('x') }, 11, 1],
    [
      'a count whose valueOf throws',
      {
        _truncated: true,
        _omitted: {
          valueOf() {
            throw new Error('hostile')
          }
        }
      },
      11,
      1
    ],
    ['a count of Infinity', { _truncated: true, _omitted: Infinity }, 11, 1],
    ['a count of NaN', { _truncated: true, _omitted: NaN }, 11, 1],
    ['a count that is a fraction', { _truncated: true, _omitted: 1.5 }, 11, 1],
    ['a count that is a bigint', { _truncated: true, _omitted: 5n }, 11, 1],
    ['a count that is null', { _truncated: true, _omitted: null }, 11, 1],
    ['a count that is true', { _truncated: true, _omitted: true }, 11, 1]
  ])(
    /*
     * The number a marker carries is trusted only when it is the last element of a list of one
     * more than the cap and is a positive number. Anything else is a member, and the members are
     * counted. A marker-shaped member can set the count only as the last element of a list of
     * exactly one more than the cap, where it cannot be told from the walk's own, and only as a
     * positive integer: a number in a log line.
     */
    'should count the members, not trust %s',
    (_label, lookalike, length, omitted) => {
      const members: unknown[] = Array.from({ length }, (_, i) => new Error(`e${i}`))
      members[10] = lookalike
      const result = sanitizeError(new AggregateError(members, 'looks capped'))

      expect(result.errors).toHaveLength(11)
      expect(result.errors?.[10]).toEqual({
        _truncated: true,
        _reason: 'aggregate-width-exceeded',
        _omitted: omitted
      })
    }
  )

  it(/*
   * The member at the cut position is caller data, so it is read once and never trusted to behave:
   * a stateful getter cannot make the count differ from the one value read, and a getter that
   * throws means the member is not a marker, never that the whole aggregate node is lost.
   */
  'should read a marker lookalike once and survive a member that throws', () => {
    const members: unknown[] = Array.from({ length: 10 }, (_, i) => new Error(`e${i}`))
    let reads = 0
    members.push({
      _truncated: true,
      get _omitted() {
        reads++
        return reads === 1 ? 5 : 99
      }
    })
    const stateful = sanitizeError(new AggregateError(members, 'stateful'))

    expect(reads).toBe(1)
    expect(stateful.errors?.[10]).toMatchObject({ _omitted: 5 })

    const hostile: unknown[] = Array.from({ length: 12 }, (_, i) => new Error(`e${i}`))
    hostile[10] = {
      get _truncated(): boolean {
        throw new Error('hostile')
      }
    }
    const survived = sanitizeError(new AggregateError(hostile, 'hostile'))

    expect(survived.name).toBe('AggregateError')
    expect(survived.errors).toHaveLength(11)
    expect(survived.errors?.[10]).toMatchObject({ _omitted: 2 })

    const eleven: unknown[] = Array.from({ length: 10 }, (_, i) => new Error(`e${i}`))
    eleven.push({
      get _truncated(): boolean {
        throw new Error('hostile')
      }
    })
    const lone = sanitizeError(new AggregateError(eleven, 'eleven'))

    expect(lone.name).toBe('AggregateError')
    expect(lone.errors?.[10]).toMatchObject({ _omitted: 1 })
  })

  it.each([
    ['an integer and then a Symbol', [5, Symbol('s')]],
    ['an integer and then a numeric string', [5, '9']]
  ] as const)('should use the one value it read when a count answers %s', (_label, answers) => {
    let reads = 0
    const marker = {
      _truncated: true,
      get _omitted(): unknown {
        return answers[Math.min(reads++, answers.length - 1)]
      }
    }
    const members: unknown[] = [...Array.from({ length: 10 }, (_, i) => new Error(`e${i}`)), marker]
    const result = sanitizeError(new AggregateError(members, 'stateful count'))

    expect(result.name).toBe('AggregateError')
    expect(result.errors?.[10]).toMatchObject({ _omitted: 5 })
  })

  it(/*
   * Eleven real members are not a capped list: the eleventh is a member that is left out, so the
   * marker counts one, and a member that merely sits at that index is not mistaken for a marker.
   */
  'should count one omitted member for eleven real members', () => {
    const members = Array.from({ length: 11 }, (_, i) => new Error(`e${i}`))
    const result = sanitizeError(new AggregateError(members, 'eleven'))

    expect(result.errors).toHaveLength(11)
    expect(result.errors?.[10]).toEqual({
      _truncated: true,
      _reason: 'aggregate-width-exceeded',
      _omitted: 1
    })
  })
})
