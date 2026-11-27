/**
 * @fileoverview Finding binary values where Pino's redact paths would copy them.
 * @layer server/utils
 */
import { binaryAsField, holdsBinary } from './binary-values.util'
import { REDACT_MAX_VISITS } from './redact-by-name.util'

describe('holdsBinary', () => {
  it.each<readonly [string, unknown]>([
    ['a Buffer', Buffer.from('x')],
    ['a DataView', new DataView(new ArrayBuffer(1))],
    ['a member of a member', { a: [{ b: new Uint8Array(1) }] }]
  ])('finds %s', (_name, value) => {
    expect(holdsBinary(value)).toBe(true)
  })

  it.each<readonly [string, unknown]>([
    ['a string', 'x'],
    ['null', null],
    ['an object with none', { a: [1, 'b', null, {}] }],
    ['an ArrayBuffer, which is not a view', new ArrayBuffer(1)],
    ['a member that is not enumerable', Object.defineProperty({}, 'a', { value: Buffer.from('x') })]
  ])('finds none in %s', (_name, value) => {
    expect(holdsBinary(value)).toBe(false)
  })

  it('reads a shared or a cyclic member once', () => {
    let reads = 0
    const shared = {
      get a(): number {
        reads += 1
        return 1
      }
    }
    const cycle: Record<string, unknown> = { shared, again: shared }
    cycle['self'] = cycle

    expect(holdsBinary(cycle)).toBe(false)
    expect(reads).toBe(1)
  })

  it('answers that what it cannot read holds one', () => {
    const hostile = {
      get a(): never {
        throw new Error('no')
      }
    }

    expect(holdsBinary(hostile)).toBe(true)
  })

  it.each([
    ['stops at the limit of members, which it reads whole', REDACT_MAX_VISITS, false],
    ['leaves what has more members than the limit to the walk', REDACT_MAX_VISITS + 1, true]
  ])('%s', (_name, members, expected) => {
    expect(holdsBinary(Array.from({ length: members }, () => 0))).toBe(expected)
  })

  it('ends a chain of getters that makes a new object on every read', () => {
    let reads = 0
    const link = (): object => ({
      get next(): unknown {
        reads += 1
        // Ends on its own well past the limit, so that a scan without one fails and does not hang.
        return reads > REDACT_MAX_VISITS * 2 ? null : link()
      }
    })

    expect(holdsBinary(link())).toBe(true)
    expect(reads).toBe(REDACT_MAX_VISITS)
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
