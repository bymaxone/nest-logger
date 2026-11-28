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
  withBinaryAsSize,
  withBinaryAsSizeForText
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

  it.each<readonly [string, () => DataView]>([
    [
      'whose buffer was transferred',
      () => {
        const buffer = new ArrayBuffer(4)
        const view = new DataView(buffer)
        structuredClone(buffer, { transfer: [buffer] })
        return view
      }
    ],
    [
      'left out of bounds by a buffer that shrank',
      () => {
        const buffer = Reflect.construct(ArrayBuffer, [4, { maxByteLength: 4 }]) as ArrayBuffer
        const view = new DataView(buffer, 0, 4)
        ;(buffer as unknown as { resize(size: number): void }).resize(0)
        return view
      }
    ]
  ])('writes a DataView %s as a size of zero', (_label, make) => {
    expect(withBinaryAsSize(make())).toBe('[Binary 0 bytes]')
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

describe('withBinaryAsSizeForText', () => {
  const two = (): Buffer => Buffer.from('ab')
  const MARKER = '[Binary 2 bytes]'

  /*
   * `String` reads every one of these through the bytes, so each must be sized first.
   */
  it.each([
    ['a binary value', two(), MARKER],
    ['a member', [two(), 'x'], `${MARKER},x`],
    ['a member of a member', [[[two()]], 'x'], `${MARKER},x`],
    ['the message of an error', Object.assign(new Error(), { message: two() }), MARKER],
    ['the name of an error', Object.assign(new Error('m'), { name: two() }), MARKER],
    ['an error in an array', [Object.assign(new Error(), { message: [two()] })], MARKER]
  ])('sizes %s', (_label, value, text) => {
    expect(String(withBinaryAsSizeForText(value))).toBe(text)
  })

  /*
   * A value with nothing to size keeps its identity, so its own text is what is written.
   */
  it.each([
    ['text', 'text'],
    ['a number', 7],
    ['null', null],
    ['an object', { data: Buffer.from('x') }],
    ['a plain ArrayBuffer', new ArrayBuffer(3)],
    ['an array', ['a', [1], null]],
    ['an error', new Error('m')]
  ])('returns %s as the very same value', (_label, value) => {
    expect(withBinaryAsSizeForText(value)).toBe(value)
  })

  it('reads an array by its length and index, never through its iterator', () => {
    const list = [two()]
    Object.defineProperty(list, Symbol.iterator, {
      value: () => {
        throw new Error('iterated')
      }
    })

    expect(String(withBinaryAsSizeForText(list))).toBe(MARKER)
  })

  /*
   * `join` writes an array that is already being joined as nothing; so does the copy.
   */
  it('ends an array that holds itself where join ends it', () => {
    const list: unknown[] = ['a', two()]
    list.push(list)

    expect(String(withBinaryAsSizeForText(list))).toBe(`a,${MARKER},`)
  })

  it('ends an error whose message holds the error', () => {
    const error = new Error()
    Object.assign(error, { message: [two(), error] })

    expect(String(withBinaryAsSizeForText(error))).toBe(`${MARKER},`)
  })

  /*
   * Nothing is sized here, so the text is the one `String` gives the value, cycle and all.
   */
  it('returns an error that holds itself and nothing binary as the very same value', () => {
    const error = new Error()
    Object.assign(error, { message: ['a', error] })
    const list = [error]

    expect(withBinaryAsSizeForText(list)).toBe(list)
  })

  it('returns arrays nested far deeper than the call stack allows a walk to recurse', () => {
    let deep: unknown[] = []
    for (let level = 0; level < 100_000; level += 1) deep = [deep]

    expect(withBinaryAsSizeForText(deep)).toBe(deep)
  })

  /*
   * A sparse array can have a length far beyond what it holds, so no pass may allocate by it.
   */
  it('keeps the holes of a sparse array that it has to copy', () => {
    const list: unknown[] = []
    list[3] = two()
    list.length = 1_000

    const read = withBinaryAsSizeForText(list) as unknown[]

    expect(Object.keys(read)).toStrictEqual(['3'])
    expect(read).toHaveLength(1_000)
  })

  /*
   * `String` reads the value itself afterwards, so every further read here is one more that it can
   * answer differently; and `join` never asks an array whether it has an index.
   */
  it.each([
    ['that holds nothing binary', ['a', 'b'], ['length', '0', '1']],
    ['that it has to copy', [two(), 'b'], ['length', '0', 'length', '0', '1']]
  ])('reads an array %s no more than once in each pass', (_label, held, expected) => {
    const asked: Array<string | symbol> = []
    const list = new Proxy(held, {
      get(target, key, receiver): unknown {
        asked.push(key)
        return Reflect.get(target, key, receiver) as unknown
      },
      has(target, key): boolean {
        asked.push(`has ${String(key)}`)
        return Reflect.has(target, key)
      }
    })

    withBinaryAsSizeForText(list)

    expect(asked).toStrictEqual(expected)
  })

  it('reads the name and the message of an error it only searches once', () => {
    const asked: string[] = []
    const error = new Error()
    for (const part of ['name', 'message']) {
      Object.defineProperty(error, part, { get: () => (asked.push(part), 'x') })
    }

    withBinaryAsSizeForText(error)

    expect(asked).toStrictEqual(['name', 'message'])
  })

  it('keeps a binary-free array and error that sit beside a binary value', () => {
    const list = ['b']
    const error = new Error('x')

    const read = withBinaryAsSizeForText([two(), list, error]) as unknown[]

    expect(read[1]).toBe(list)
    expect(read[2]).toBe(error)
  })

  it('sizes the same array and the same error each time they appear', () => {
    const list = [two()]
    const error = Object.assign(new Error(), { message: two() })

    expect(String(withBinaryAsSizeForText([list, list, error, error]))).toBe(
      `${MARKER},${MARKER},${MARKER},${MARKER}`
    )
  })
})
