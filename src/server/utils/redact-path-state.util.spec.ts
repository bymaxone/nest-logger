/**
 * Pins `createPathHold`: which own state counts as holding a field the paths name.
 *
 * Layer: server, utils.
 */
import { createOwnFieldPolicy } from './own-field-policy.util'
import { createPathHold } from './redact-path-state.util'

/** What the paths decide. */
const hold = (paths: readonly string[], max = 100) =>
  createPathHold(paths, max, createOwnFieldPolicy('safe', ['tenant']))

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
    ['the own field of an Error in the state', { e: Object.assign(new Error(), { password: 1 }) }],
    ['a non-enumerable field of a list', Object.defineProperty([], 'password', { value: 'x' })]
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

  it('ends a search that takes exactly the work it may do', () => {
    expect(redactedStateMatcher(['password'], 1)({})).toBe(false)
  })

  /* A list is not listed when its length alone is over the work left. */
  it('lists a list as long as the work left, and not a longer one', () => {
    const matcher = redactedStateMatcher(['password'], 10)

    expect(matcher(new Array<number>(9))).toBe(false)
    expect(matcher(new Array<number>(10))).toBe(true)
  })

  /* An enumerable property is a field, whatever it is called. */
  it('counts an enumerable field of a function that has a built name', () => {
    const named = Object.defineProperty(() => 'x', 'name', { value: 'x', enumerable: true })

    expect(redactedStateMatcher(['a.name'], 100)({ named })).toBe(true)
  })

  it('counts every field when one of several paths ends in *', () => {
    expect(redactedStateMatcher(['u.*', 'a.b'], 100)({ n: 1 })).toBe(true)
  })

  /* The searches of one walk share the bound; an overlong list's members spend none. */
  it('shares the bound between the searches of one walk', () => {
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
