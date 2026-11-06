/**
 * Pins the exact shape of the node the redactor writes for an `Error` outside a serialized root key,
 * read on the redactor's own result: a key that holds `undefined` is dropped by `JSON.stringify`, so
 * a test through the logger cannot tell an omitted field from one written as `undefined`.
 *
 * Layer: server/utils, tests.
 */
import { createNameRedactor } from './redact-by-name.util'

/** A redactor that writes nested Errors as data, with `err` as the only serialized key. */
const redact = createNameRedactor(['password'], '[REDACTED]', ['err'])

/** The node written for `error` placed under a metadata key. */
function nodeOf(error: Error): Record<string, unknown> {
  const record = redact({ inner: error }, true) as { inner: Record<string, unknown> }
  return record.inner
}

describe('whether an Error outside a serialized root key is written as data', () => {
  /*
   * The redactor is built INSIDE each case on purpose: one built when the file loads has already
   * run the line under test, so a mutation run, which switches the mutant on afterwards, could
   * never reach it.
   */
  it('leaves the Error as it is when the serialized keys are not given', () => {
    const plain = createNameRedactor(['password'], '[REDACTED]')
    const error = Object.assign(new Error('x'), { password: 'p' })

    const written = (plain({ inner: error }, true) as { inner: unknown }).inner

    expect(written).toBeInstanceOf(Error)
    expect((written as Error & { password: string }).password).toBe('[REDACTED]')
  })

  it('writes it as data when the serialized keys are given, even with none', () => {
    const none = createNameRedactor(['password'], '[REDACTED]', [])

    const written = (none({ inner: new Error('x') }, true) as { inner: unknown }).inner

    expect(written).not.toBeInstanceOf(Error)
    expect(written).toMatchObject({ type: 'Error', message: 'x' })
  })
})

describe('the node of an Error outside a serialized root key', () => {
  it('has only the keys it has a value for', () => {
    expect(Object.keys(nodeOf(new Error('plain')))).toStrictEqual(['type', 'message', 'stack'])
  })

  it('skips an own field that holds undefined and one that cannot be read, and marks the second', () => {
    const error = Object.assign(new Error('x'), { gone: undefined })
    Object.defineProperty(error, 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('exploded')
      }
    })

    expect(Object.keys(nodeOf(error))).toStrictEqual([
      'type',
      'message',
      'stack',
      '_errorFieldsIncomplete'
    ])
  })

  it('keeps the head and the stack and marks the node when its own keys cannot be listed', () => {
    // A proxy whose `ownKeys` throws; `stack` is answered by the trap, since reading it through a
    // proxy would otherwise find nothing.
    const proxy = new Proxy(new Error('px'), {
      ownKeys: () => {
        throw new Error('exploded')
      },
      get: (target, key, receiver) =>
        key === 'stack' ? 'Error: px\n    at somewhere' : Reflect.get(target, key, receiver)
    })

    expect(Object.keys(nodeOf(proxy))).toStrictEqual([
      'type',
      'message',
      'stack',
      '_errorFieldsIncomplete'
    ])
  })

  it('ends a cycle that runs through both cause and errors, and keeps the level of the link it came by', () => {
    // b is the cause of a, c is a member of b's errors, and c's cause is b again.
    const b = new Error('b')
    const c = new Error('c', { cause: b })
    Object.assign(b, { errors: [c] })
    const a = new Error('a', { cause: b })

    const written = JSON.stringify(nodeOf(a))

    expect(written).toContain('[Circular]')
    expect(written).toContain('"message":"b"')
    expect(written).toContain('"message":"c"')
  })

  it('keeps an own field named like something every object inherits at the top level', () => {
    // `toString` and `constructor` are on every object's prototype, not on the node, so they collide with nothing.
    const written = nodeOf(
      Object.assign(new Error('x'), { toString: 'custom', constructor: 'ctor' })
    )

    expect(written).toMatchObject({ toString: 'custom', constructor: 'ctor' })
    expect(Object.keys(written)).not.toContain('fields')
  })

  it('keeps an own fields field and an own type field together', () => {
    const written = nodeOf(
      Object.assign(new Error('x'), { type: 'mine', fields: { z: 1 }, other: 2 })
    )

    expect(written).toMatchObject({ type: 'Error', other: 2, stack: expect.any(String) })
    expect(written['fields']).toStrictEqual({ type: 'mine', fields: { z: 1 } })
  })

  it('keeps a colliding own field under fields and no key for fields otherwise', () => {
    const colliding = nodeOf(Object.assign(new Error('x'), { type: 'validation' }))

    expect(colliding['fields']).toStrictEqual({ type: 'validation' })
    expect(Object.keys(nodeOf(new Error('x')))).not.toContain('fields')
  })

  it('leaves a long errors list that has a toJSON to the method, with no cap and no marker', () => {
    const members = Array.from({ length: 11 }, (_, index) => new Error(`m${index}`))
    const list = Object.assign(members, { toJSON: () => ['from-toJSON'] })

    expect(nodeOf(Object.assign(new Error('x'), { errors: list }))['errors']).toStrictEqual([
      'from-toJSON'
    ])
  })

  it('writes an Error whose toJSON cannot be read in full under every key that holds it', () => {
    const error = Object.assign(new Error('x'), { sibling: 'kept' })
    Object.defineProperty(error, 'toJSON', {
      get: () => {
        throw new Error('exploded')
      }
    })

    const written = redact({ first: error, second: error }, true) as Record<string, any>

    expect(written['first']).toMatchObject({ message: 'x', sibling: 'kept' })
    expect(written['second']).toMatchObject({ message: 'x', sibling: 'kept' })
  })

  it('does not copy an own field the head already carries', () => {
    const written = nodeOf(Object.assign(new Error('x'), { name: 'Custom' }))

    expect(written['type']).toBe('Custom')
    expect(Object.keys(written)).toStrictEqual(['type', 'message', 'stack'])
  })

  it('counts the chain budget along errors as it does along cause', () => {
    let error: Error = new Error('leaf')
    for (let level = 0; level < 6; level++) error = new AggregateError([error], `level${level}`)

    const written = nodeOf(error) as any

    expect(written.errors[0].errors[0].errors[0]['message']).toBeDefined()
    expect(written.errors[0].errors[0].errors[0].errors[0]).toStrictEqual({
      _truncated: true,
      _reason: 'cause-depth-exceeded'
    })
  })

  it('gives an Error back its own level once it has been walked as a link', () => {
    // `shared` is the cause of the error, at level 1, and later one of its fields, at level 0.
    const third = new Error('third')
    const second = new Error('second', { cause: third })
    const first = new Error('first', { cause: second })
    const shared = new Error('shared', { cause: first })
    const error = Object.assign(new Error('top', { cause: shared }), { held: shared })

    const written = nodeOf(error) as any

    expect(written.held.cause.cause.cause['message']).toBe('third')
  })

  it('writes exactly ten members of errors with no marker, and a marker only past ten', () => {
    const members = (count: number): Error[] =>
      Array.from({ length: count }, (_, index) => new Error(`m${index}`))

    const ten = nodeOf(new AggregateError(members(10), 'agg'))['errors'] as unknown[]
    const eleven = nodeOf(new AggregateError(members(11), 'agg'))['errors'] as unknown[]

    expect(ten).toHaveLength(10)
    expect(eleven).toHaveLength(11)
    expect(eleven[10]).toStrictEqual({
      _truncated: true,
      _reason: 'aggregate-width-exceeded',
      _omitted: 1
    })
  })

  it('counts the depth of its parts from its own depth', () => {
    /*
     * The walk drops a container past its depth ceiling. The parts of an Error are one level
     * below it, so the same structure is kept at one nesting and dropped at the next.
     */
    const written = (nesting: number): string => {
      let holder: Record<string, unknown> = {
        e: Object.assign(new Error('x'), { cause: { a: { b: { c: 'leaf' } } } })
      }
      for (let level = 0; level < nesting; level++) holder = { n: holder }
      return JSON.stringify(redact({ meta: holder }, true))
    }

    expect(written(95)).toContain('leaf')
    expect(written(96)).not.toContain('leaf')
  })

  it('writes the exact SanitizeFailed node when the head cannot be read at all', () => {
    const explode = {
      get: (): never => {
        throw new Error('exploded')
      }
    }
    const error = new Error('boom')
    Object.defineProperty(error, 'toJSON', explode)
    Object.defineProperty(error, 'name', explode)

    expect(nodeOf(error)).toStrictEqual({
      type: 'SanitizeFailed',
      message: 'Failed to sanitize the thrown value'
    })
  })
})
