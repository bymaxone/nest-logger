/**
 * Pins which own fields of an error a policy writes, and how a binary value is written.
 *
 * Layer: server, utils, tests.
 */
import {
  ALL_OWN_FIELDS,
  allowsOwnField,
  createOwnFieldPolicy,
  DEFAULT_SAFE_ERROR_FIELDS,
  withBinaryAsSize
} from './own-field-policy.util'

describe('createOwnFieldPolicy', () => {
  it("returns the one shared policy of every field for 'all', whatever names are given", () => {
    expect(createOwnFieldPolicy('all', ['orderId'])).toBe(ALL_OWN_FIELDS)
    expect(ALL_OWN_FIELDS.safe).toBe(false)
  })

  it("holds the default list and the consumer's names for 'safe'", () => {
    const policy = createOwnFieldPolicy('safe', ['orderId'])

    expect(policy.safe).toBe(true)
    expect([...policy.names].sort()).toEqual([...DEFAULT_SAFE_ERROR_FIELDS, 'orderId'].sort())
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it('does not list a file system path by default', () => {
    expect(DEFAULT_SAFE_ERROR_FIELDS).not.toContain('path')
    expect(DEFAULT_SAFE_ERROR_FIELDS).toEqual(
      expect.arrayContaining(['code', 'errno', 'syscall', 'signal', 'status', 'statusCode'])
    )
  })
})

describe('allowsOwnField', () => {
  it("allows every name under 'all'", () => {
    expect(allowsOwnField(ALL_OWN_FIELDS, 'anything')).toBe(true)
  })

  it.each(['code', 'statusCode', 'orderId'])("allows the listed name %s under 'safe'", (name) => {
    expect(allowsOwnField(createOwnFieldPolicy('safe', ['orderId']), name)).toBe(true)
  })

  it.each(['name', 'message', 'stack', 'cause', 'errors', '_errorFieldsIncomplete'])(
    "allows the field %s the logger writes itself under 'safe'",
    (name) => {
      expect(allowsOwnField(createOwnFieldPolicy('safe', []), name)).toBe(true)
    }
  )

  it.each(['path', 'stdout', 'Code', 'orderid', ''])(
    "refuses %j under 'safe', matched exactly",
    (name) => {
      expect(allowsOwnField(createOwnFieldPolicy('safe', ['orderId']), name)).toBe(false)
    }
  )
})

describe('withBinaryAsSize', () => {
  it.each([
    ['a Buffer', Buffer.from('abc'), '[Binary 3 bytes]'],
    ['a Uint8Array', new Uint8Array(5), '[Binary 5 bytes]'],
    ['a Float32Array', new Float32Array(2), '[Binary 8 bytes]'],
    ['a DataView', new DataView(new ArrayBuffer(7)), '[Binary 7 bytes]'],
    ['an empty Buffer', Buffer.alloc(0), '[Binary 0 bytes]']
  ])('writes %s as its size', (_label, value, marker) => {
    expect(withBinaryAsSize(value)).toBe(marker)
  })

  it('replaces the binary members of an array and leaves the original array alone', () => {
    const original = [null, Buffer.from('ab'), 'text', 4, new Uint8Array(1)]

    expect(withBinaryAsSize(original)).toEqual([
      null,
      '[Binary 2 bytes]',
      'text',
      4,
      '[Binary 1 bytes]'
    ])
    expect(original[1]).toBeInstanceOf(Buffer)
  })

  it.each([
    ['an array without a binary member', [1, 'a', { b: 2 }]],
    ['an empty array', []],
    ['a string', 'text'],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
    ['an object', { data: Buffer.from('x') }],
    ['a plain ArrayBuffer', new ArrayBuffer(3)]
  ])('returns %s as the very same value', (_label, value) => {
    expect(withBinaryAsSize(value)).toBe(value)
  })
})
