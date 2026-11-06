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

/** `error` with `errors` as an AggregateError holds it: an own property that is not enumerable. */
function withErrors(error: Error, errors: unknown): Error {
  return Object.defineProperty(error, 'errors', { value: errors, enumerable: false })
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

    // An Error whose own field cannot be read is written by the sanitizer.
    expect(Object.keys(nodeOf(error))).toStrictEqual([
      'name',
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
      'name',
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

  it('keeps an own fields field and an own type field exactly as the walk wrote them', () => {
    const written = nodeOf(
      Object.assign(new Error('x'), { type: 'mine', fields: { z: 1 }, other: 2 })
    )

    expect(written).toMatchObject({
      type: 'mine',
      fields: { z: 1 },
      other: 2,
      message: 'x',
      stack: expect.any(String)
    })
  })

  it('does not replace an own field with the head key of the same name, and adds no fields key', () => {
    const colliding = nodeOf(Object.assign(new Error('x'), { type: 'validation' }))

    expect(colliding['type']).toBe('validation')
    expect(Object.keys(colliding)).not.toContain('fields')
    expect(Object.keys(nodeOf(new Error('x')))).not.toContain('fields')
  })

  it('leaves a long errors list that has a toJSON to the method, with no cap and no marker', () => {
    const members = Array.from({ length: 11 }, (_, index) => new Error(`m${index}`))
    const list = Object.assign(members, { toJSON: () => ['from-toJSON'] })

    expect(nodeOf(withErrors(new Error('x'), list))['errors']).toStrictEqual(['from-toJSON'])
  })

  it('walks an errors that is not a list as data, with no cap and no budget of its own', () => {
    const written = nodeOf(withErrors(new Error('x'), { code: 7, password: 'p' }))

    expect(written['errors']).toStrictEqual({ code: 7, password: '[REDACTED]' })
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

  it('writes a null cause and a null member of errors as they are, without marking the node', () => {
    const withCause = nodeOf(new Error('x', { cause: null }))
    const withMember = nodeOf(withErrors(new Error('y'), [null, 'text']))

    expect(withCause['cause']).toBeNull()
    expect(withCause).not.toHaveProperty('_errorFieldsIncomplete')
    expect(withMember['errors']).toStrictEqual([null, 'text'])
    expect(withMember).not.toHaveProperty('_errorFieldsIncomplete')
  })

  it('writes the head type beside an own name field, which stays as the walk wrote it', () => {
    const written = nodeOf(Object.assign(new Error('x'), { name: 'Custom' }))

    expect(written['type']).toBe('Custom')
    expect(Object.keys(written)).toStrictEqual(['name', 'type', 'message', 'stack'])
  })

  it('counts the chain budget along errors as it does along cause', () => {
    let error: Error = new Error('leaf')
    for (let level = 0; level < 6; level++) error = new AggregateError([error], `level${level}`)

    const written = nodeOf(error) as any

    expect(written.errors[0].errors[0].errors[0]['message']).toBeDefined()
    expect(written.errors[0].errors[0].errors[0].errors).toStrictEqual({
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

  it.each([
    ['cause', (value: unknown) => new Error('x', { cause: value })],
    ['message', (value: unknown) => Object.defineProperty(new Error('x'), 'message', { value })]
  ])('counts the depth of its %s from its own depth', (_part, build) => {
    /*
     * The walk drops a container past its depth ceiling. The parts of an Error are one level
     * below it, so the same structure is kept at one nesting and dropped at the next.
     */
    const written = (nesting: number): string => {
      let holder: Record<string, unknown> = { e: build({ a: { b: { c: 'leaf' } } }) }
      for (let level = 0; level < nesting; level++) holder = { n: holder }
      return JSON.stringify(redact({ meta: holder }, true))
    }

    expect(written(95)).toContain('leaf')
    expect(written(96)).not.toContain('leaf')
  })

  it('reads no index past the end of an errors list', () => {
    const reads: string[] = []
    const list = new Proxy([new Error('m0'), new Error('m1')], {
      get: (target, key, receiver) => {
        reads.push(String(key))
        return Reflect.get(target, key, receiver)
      }
    })

    nodeOf(withErrors(new Error('x'), list))

    expect(reads).not.toContain('2')
  })

  it('writes a cause that is not an Error past the budget, where only an Error link is cut', () => {
    let chain: Error = new Error('d3', { cause: 'tail' })
    for (let level = 2; level >= 0; level--) chain = new Error(`d${level}`, { cause: chain })

    const written = nodeOf(chain) as any

    expect(written.cause.cause.cause.cause).toBe('tail')
  })

  it('gives an Error back its own level after a walk that reached it as a link', () => {
    // `shared` is walked as the cause of `top` first and as a key of the record after it.
    const s3 = new Error('s3')
    const s2 = new Error('s2', { cause: s3 })
    const s1 = new Error('s1', { cause: s2 })
    const shared = new Error('s0', { cause: s1 })
    const top = new Error('top', { cause: shared })

    const written = redact({ a: top, b: shared }, true) as any

    expect(written.b.cause.cause.cause['message']).toBe('s3')
  })

  it('does not read a part the node already has a key for', () => {
    const readsOfName = (own: object): number => {
      let reads = 0
      const error = Object.defineProperty(Object.assign(new Error('x'), own), 'name', {
        get: () => {
          reads++
          return 'Custom'
        }
      })
      nodeOf(error)
      return reads
    }

    // Only the added `type` reads the name; an own `type` leaves that one read out.
    expect(readsOfName({ type: 'mine' })).toBe(readsOfName({}) - 1)
  })

  it('censors an added part whose key is a covered name', () => {
    const covered = createNameRedactor(['message', 'cause', 'stack'], '[REDACTED]', ['err'])
    const error = new Error('secret text', { cause: new Error('c') })

    const written = (covered({ inner: error }, true) as { inner: Record<string, unknown> }).inner

    expect(written).toMatchObject({
      type: 'Error',
      message: '[REDACTED]',
      stack: '[REDACTED]',
      cause: '[REDACTED]'
    })
  })

  it('walks an object held by name or message, and drops one held by stack', () => {
    const hold = (key: string): Error =>
      Object.defineProperty(new Error('x'), key, {
        value: { password: 'p', keep: 'k' },
        enumerable: false
      })

    const named = nodeOf(hold('name'))
    const messaged = nodeOf(hold('message'))
    const stacked = nodeOf(hold('stack'))

    expect(named['type']).toStrictEqual({ password: '[REDACTED]', keep: 'k' })
    expect(messaged['message']).toStrictEqual({ password: '[REDACTED]', keep: 'k' })
    expect(stacked).not.toHaveProperty('stack')
  })

  it('censors the added type when the name it is read from is a covered name', () => {
    const covered = createNameRedactor(['name'], '[REDACTED]', ['err'])
    const own = Object.assign(new Error('x'), { name: 'PRIVATE_PERSON' })
    class Sub extends Error {}

    const written = covered({ own, sub: new Sub('y') }, true) as Record<string, any>

    expect(written['own']).toMatchObject({ name: '[REDACTED]', type: '[REDACTED]' })
    expect(written['sub']['type']).toBe('[REDACTED]')
    // Only `type` is read from `name`: the other added parts keep their own coverage.
    expect(written['sub']).toMatchObject({ message: 'y', stack: expect.any(String) })
    expect(nodeOf(own)['type']).toBe('PRIVATE_PERSON')
  })

  it.each([
    ['name', ['name']],
    ['message', ['message']],
    ['neither', ['password']]
  ])('censors the added stack only when %s is a covered name', (label, names) => {
    const covered = createNameRedactor(names, '[REDACTED]', ['err'])
    class Sub extends Error {}
    const error = Object.assign(new Sub('SECRETmsg'), { stack: 'Sub: SECRETmsg\n    at x' })

    const written = (covered({ inner: error }, true) as { inner: Record<string, unknown> }).inner

    expect(written['stack']).toBe(label === 'neither' ? 'Sub: SECRETmsg\n    at x' : '[REDACTED]')
  })

  it.each([
    ['type', ['type']],
    ['name', ['type', 'stack']],
    ['message', ['message', 'stack']],
    ['stack', ['stack']],
    ['cause', ['cause']],
    ['errors', ['errors']]
  ])('censors exactly these added parts when only %s is covered', (name, expected) => {
    const alone = createNameRedactor([name], '[REDACTED]', ['err'])
    const error = new AggregateError([new Error('m')], 'agg', { cause: new Error('c') })

    const written = (alone({ inner: error }, true) as { inner: Record<string, unknown> }).inner
    const censored = ['type', 'message', 'stack', 'cause', 'errors'].filter(
      (part) => written[part] === '[REDACTED]'
    )

    expect(censored).toStrictEqual(
      ['type', 'message', 'stack', 'cause', 'errors'].filter((part) => expected.includes(part))
    )
  })

  it('leaves an omitted driver field out of the node altogether, not as a value JSON drops', () => {
    const error = Object.assign(new Error('x'), {
      args: ['a'],
      parameters: ['b'],
      command: { args: ['c'] },
      code: 'E_X'
    })

    expect(Object.keys(nodeOf(error))).toStrictEqual(['code', 'type', 'message', 'stack'])
  })

  it('removes a driver field from an Error kept as an instance, and leaves it under a serializer key', () => {
    const plain = createNameRedactor(['password'], '[REDACTED]')
    const keyed = createNameRedactor(['password'], '[REDACTED]', ['db'])
    const error = Object.assign(new Error('x'), {
      severity: 'ERROR',
      code: '23505',
      routine: 'r',
      detail: 'Key (email)=(a@b.c) already exists.',
      args: ['k'],
      table: 'users'
    })

    const instance = (plain({ e: error }, true) as { e: Error }).e
    const under = (keyed({ db: error }, true) as { db: Error }).db

    expect(instance).toBeInstanceOf(Error)
    expect(Object.keys(instance)).toStrictEqual(['severity', 'code', 'routine', 'table'])
    expect(Object.keys(under)).toStrictEqual(Object.keys(error))
  })

  it('writes the exact sanitizer node when the head cannot be read at all', () => {
    const explode = {
      get: (): never => {
        throw new Error('exploded')
      }
    }
    const error = new Error('boom')
    Object.defineProperty(error, 'toJSON', explode)
    Object.defineProperty(error, 'name', explode)

    expect(nodeOf(error)).toStrictEqual({
      name: 'SanitizeFailed',
      message: 'Failed to sanitize the thrown value'
    })
  })
})
