/**
 * Pins `createPathHold`: which own state counts as holding a field the paths name, and what is
 * written for a held `Error`.
 *
 * Layer: server, utils.
 */
import { createOwnFieldPolicy } from './own-field-policy.util'
import { createPathHold } from './redact-path-state.util'

/** What the paths decide, with `errorOwnFields: 'safe'` extended by `tenant`. */
const hold = (paths: readonly string[], max = 100) =>
  createPathHold(paths, max, createOwnFieldPolicy('safe', ['tenant']), '[X]')

/** The search alone. */
const redactedStateMatcher = (paths: readonly string[], max: number) => {
  const { holds: search } = hold(paths, max)
  return (value: object): boolean => search(value, { searched: 0 })
}

/** The matcher of `*.password`, with room for every case here. */
const holds = redactedStateMatcher(['*.password'], 100)

describe('redactedStateMatcher', () => {
  it.each<readonly [string, object]>([
    ['its own field', { password: 'x' }],
    ['nested state', { a: { b: { password: 'x' } } }],
    ['a member of a list', { list: [1, { password: 'x' }] }],
    ['a non-enumerable field', Object.defineProperty({}, 'password', { value: 'x' })],
    ['the own field of an Error in the state', { e: Object.assign(new Error(), { password: 1 }) }]
  ])('answers true for %s', (_label, value) => {
    expect(holds(value)).toBe(true)
  })

  it.each<readonly [string, object]>([
    ['no field', new Date(0)],
    ['other names', { a: 'password', b: [null, 2], c: { d: undefined } }],
    ['the name in other letters', { Password: 'x' }],
    ['a method', { toJSON: () => 'x' }],
    ['an Error, whose built stack is an accessor', { e: new Error('failed') }],
    ['a binary view', { raw: Buffer.from('ab'), view: new DataView(new ArrayBuffer(2)) }]
  ])('answers false for %s', (_label, value) => {
    expect(holds(value)).toBe(false)
  })

  /* A path that names `message` or `stack` names those of an `Error` too. */
  it.each(['message', 'stack'])('counts the built %s of an Error a path names', (name) => {
    const matcher = redactedStateMatcher([`u.${name}`], 100)

    expect(matcher(new Error('failed'))).toBe(true)
    expect(matcher({ e: new Error('failed') })).toBe(true)
  })

  /* A wildcard censors the siblings itself, so the built fields are not counted for it. */
  it('does not count the built message and stack for a wildcard', () => {
    expect(redactedStateMatcher(['u.*'], 100)(new Error('failed'))).toBe(false)
  })

  /* A function-valued field has state too; what every function has is not a field. */
  it('searches the own properties of a function in the state', () => {
    const client = Object.assign(() => 'x', { password: 'x' })

    expect(holds({ client })).toBe(true)
    expect(holds({ make: class {} })).toBe(false)
    expect(redactedStateMatcher(['a.name', 'a.length', 'a.prototype'], 100)({ f: class {} })).toBe(
      false
    )
  })

  /* A getter cannot be read without running it. */
  it.each<readonly [string, PropertyDescriptor]>([
    ['a getter', { get: () => 'x' }],
    ['a getter that is not enumerable', { get: () => 'x', enumerable: false }]
  ])('answers true for %s, without running it', (_label, descriptor) => {
    const get = jest.fn(descriptor.get)
    const value = Object.defineProperty({}, 'inner', { ...descriptor, get })

    expect(holds(value)).toBe(true)
    expect(get).not.toHaveBeenCalled()
  })

  /* A binary view is not read at all, not even its own properties. */
  it('does not read the properties of a binary view', () => {
    expect(holds({ raw: Object.assign(Buffer.from('ab'), { password: 'x' }) })).toBe(false)
  })

  /* A shared object is read once, and a cycle ends. */
  it('reads each object once', () => {
    const shared: Record<string, unknown> = { n: 1 }
    shared['self'] = shared

    expect(redactedStateMatcher(['password'], 7)({ a: shared, b: shared })).toBe(false)
  })

  /* Objects and their properties count against one bound. */
  it('answers true past the work it may do', () => {
    const matcher = redactedStateMatcher(['password'], 4)

    expect(matcher({ a: { b: 1 } })).toBe(false)
    expect(matcher({ a: { b: 1, c: 2 } })).toBe(true)
    expect(matcher({ list: new Array<number>(1_000_000) })).toBe(true)
  })

  /* The searches of one log call share the bound; a list too long for it spends none. */
  it('shares the bound between the searches of one call', () => {
    const { holds: search } = hold(['password'], 5)
    const spent = { searched: 0 }

    expect(search({ list: new Array<number>(10) }, spent)).toBe(true)
    expect(search({ n: 1 }, spent)).toBe(false)
    expect(search({ n: 1 }, spent)).toBe(true)
  })

  it('answers true for a state that cannot be inspected', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()

    expect(holds({ inner: proxy })).toBe(true)
  })

  /* The length of a list is not a field of it, even where every name counts. */
  it('counts every field, but not the length of a list, when a path ends in *', () => {
    const any = redactedStateMatcher(['u.*'], 100)

    expect(any({ n: 1 })).toBe(true)
    expect(any([])).toBe(false)
    expect(any(new Date(0))).toBe(false)
  })

  it.each(['*', 'u["*"]', 'a.*'])('reads the path %s as ending in the wildcard', (path) => {
    expect(redactedStateMatcher([path], 100)({ n: 1 })).toBe(true)
  })

  it('reads a wildcard before the last segment as no name of its own', () => {
    expect(redactedStateMatcher(['*.a'], 100)({ n: 1 })).toBe(false)
  })
})

describe('the stand-in of a held Error', () => {
  /** What is written for an `Error` whose `toJSON` returns what `output` builds. */
  const standIn = (error: Error, output: () => unknown, max = 100): Record<string, unknown> =>
    hold(['*.password'], max).standIn(error, output, { searched: 0 }) as Record<string, unknown>

  /** An `Error` with a `toJSON` of its own, as a library defines it. */
  const withToJson = (error: Error, output: () => unknown): Error =>
    Object.defineProperty(error, 'toJSON', { value: output })

  const failed = (): Error =>
    Object.assign(new Error('failed'), {
      code: 'E1',
      tenant: 't1',
      config: { password: 'x' }
    })

  /* What `toJSON` returns, cut to the names 'safe' writes, with the values the `Error` has. */
  it('keeps the safe keys of the output that match the Error', () => {
    const error = failed()
    const { message, stack, name } = error

    expect(
      standIn(error, () => ({ type: name, name, message, stack, code: 'E1', tenant: 't1' }))
    ).toEqual({ type: name, name, message, stack, code: 'E1', tenant: 't1' })
    expect(standIn(error, () => ({ code: 'E1' }))).toEqual({ code: 'E1' })
  })

  it('drops the keys outside the list and the objects under one', () => {
    const error = failed()

    expect(
      standIn(error, () => ({ config: 'x', password: 'x', code: {}, tenant: () => 'x' }))
    ).toEqual({})
  })

  /* A value that is not the Error's own under that key may be another field, renamed. */
  it.each(['type', 'name', 'message', 'stack', 'code', 'tenant', 'status'])(
    'censors a %s that is not the value the Error has',
    (key) => {
      expect(standIn(failed(), () => ({ [key]: 'x' }))).toEqual({ [key]: '[X]' })
    }
  )

  it('compares with no getter of the Error', () => {
    const get = jest.fn(() => 'x')
    const error = Object.defineProperty(new Error(), 'code', { get, enumerable: true })

    expect(standIn(error, () => ({ code: 'x' }))).toEqual({ code: '[X]' })
    expect(get).not.toHaveBeenCalled()
  })

  /* What 'safe' drops stays dropped: the detail of a database error. */
  it('drops the detail of a database error, whatever the host lists', () => {
    const error = Object.assign(new Error(), { code: '23505', detail: 'Key (a)=(b)' })
    const held = createPathHold(['u.code'], 100, createOwnFieldPolicy('safe', ['detail']), '[X]')

    expect(held.standIn(error, () => ({ detail: 'Key (a)=(b)' }), { searched: 0 })).toEqual({})
  })

  /* The output cannot be read: nothing of it is written. */
  it.each<readonly [string, () => unknown]>([
    ['text', () => 'x'],
    ['null', () => null],
    ['nothing', () => undefined],
    ['a list', () => ['x']],
    ['another Error', () => new Error('x')],
    [
      'a throw',
      () => {
        throw new Error('no')
      }
    ]
  ])('is the censor for %s', (_label, output) => {
    expect(standIn(new Error('failed'), output)).toBe('[X]')
  })

  it('is the censor for an Error that returns itself', () => {
    const error = new Error('failed')

    expect(standIn(error, () => error)).toBe('[X]')
  })

  it('calls toJSON on the Error', () => {
    const error = failed()

    expect(
      standIn(error, function (this: Error) {
        return { message: this.message }
      })
    ).toEqual({ message: 'failed' })
  })

  /* A cause or a member the Error does not have itself is text the host made. */
  it('censors a cause and a member the Error does not have', () => {
    const error = new Error('failed', { cause: new Error('real') })
    const other = new Error('x')

    expect(standIn(error, () => ({ cause: other, errors: [other] }))).toEqual({
      cause: '[X]',
      errors: ['[X]']
    })
    expect(standIn(new Error(), () => ({ cause: 'x', errors: ['x'] }))).toEqual({})
  })

  /* Its own cause and members are followed: by their `toJSON` if they have one. */
  it('follows the cause and members the Error has', () => {
    const plain = Object.assign(new Error('plain', { cause: { password: 'x' } }), { code: 'E2' })
    const custom = withToJson(new Error('custom'), () => ({ message: 'custom', config: 'x' }))
    const error = Object.assign(new Error('failed', { cause: plain }), { errors: [custom] })
    const written = standIn(error, () => ({ cause: plain, errors: [custom, 'x'] }))
    const cause = written['cause'] as Record<string, unknown>

    expect(cause['message']).toBe('plain')
    expect(cause['code']).toBe('E2')
    expect(cause['toJSON']).toBeUndefined()
    expect(written['errors']).toEqual([{ message: 'custom' }, '[X]'])
  })

  /* Of a linked `Error`'s own fields, the name and the listed values that are no object. */
  it('copies the name and the listed fields of a linked Error', () => {
    const cause = Object.assign(new Error('inner'), {
      name: 'Inner',
      code: { password: 'x' },
      tenant: () => 'x',
      status: 503,
      config: 'x'
    })
    const written = standIn(new Error('failed', { cause }), () => ({ cause }))
    const copy = written['cause'] as Record<string, unknown>

    expect(copy['name']).toBe('Inner')
    expect(Object.keys(copy)).toEqual(['status'])
  })

  /* The copy under it has no `toJSON`, and none of its accessors is run. */
  it('runs no accessor of a linked Error', () => {
    const get = jest.fn(() => 'x')
    const cause = new Error('inner')
    expect(cause.stack).toContain('inner')
    for (const key of ['code', 'name', 'cause', 'errors']) {
      Object.defineProperty(cause, key, { get, enumerable: true })
    }
    const error = new Error('failed', { cause })
    const written = standIn(error, () => ({ cause }))

    expect(JSON.parse(JSON.stringify(written['cause'] ?? null))).toEqual({})
    expect(get).not.toHaveBeenCalled()
  })

  /* A message or stack that cannot be read, or is not text, is written empty. */
  it('writes an empty message and stack it cannot read', () => {
    const cause = Object.defineProperties(new Error(), {
      message: { value: { password: 'x' } },
      stack: {
        get: () => {
          throw new Error('no')
        }
      }
    })
    const written = standIn(new Error('failed', { cause }), () => ({ cause }))
    const copy = written['cause'] as Record<string, unknown>

    expect(copy['message']).toBe('')
    expect(copy['stack']).toBe('')
  })

  /* A cycle stays a cycle. */
  it('writes a cause that leads back as the same object', () => {
    const error = new Error('failed')
    const cause = new Error('inner', { cause: error })
    Object.defineProperty(error, 'cause', { value: cause })
    withToJson(error, () => ({ cause }))
    const written = standIn(error, () => ({ cause }))

    expect((written['cause'] as Record<string, unknown>)['cause']).toBe(written)
  })

  it('writes the first ten members and one censor for the rest', () => {
    const errors = Array.from({ length: 12 }, (_, at) => new Error(String(at)))
    const error = Object.assign(new Error(), { errors })
    const written = standIn(error, () => ({ errors }))['errors'] as unknown[]

    expect(written).toHaveLength(11)
    expect(written[10]).toBe('[X]')
  })

  /* A chain of causes is bounded. */
  it('censors a cause past the eighth link', () => {
    let error = new Error('0')
    for (let at = 1; at <= 12; at++) error = new Error(String(at), { cause: error })
    const top = error
    let node: unknown = standIn(top, () => ({ cause: top.cause }))
    let links = 0
    while (typeof node === 'object') {
      node = (node as { cause?: unknown }).cause
      links++
    }

    expect(links).toBe(9)
    expect(node).toBe('[X]')
  })

  /* The keys and links count against the bound of the call. */
  it('is the censor past the work the call may do', () => {
    const cause = new Error('inner')
    const error = new Error('failed', { cause })

    expect(standIn(error, () => ({ a: 1, b: 1 }), 1)).toBe('[X]')
    expect(standIn(error, () => ({ cause }), 1)).toEqual({ cause: '[X]' })
  })

  /* Anything it cannot read leaves the censor. */
  it('is the censor for an Error it cannot read', () => {
    const { proxy, revoke } = Proxy.revocable(new Error(), {})
    revoke()

    expect(standIn(proxy, () => ({ code: 'x' }))).toBe('[X]')
  })
})
