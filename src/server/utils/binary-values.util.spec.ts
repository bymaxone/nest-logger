/**
 * @fileoverview A binary view where named fields are expected.
 * @layer server/utils
 */
import { binaryAsField } from './binary-values.util'

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
