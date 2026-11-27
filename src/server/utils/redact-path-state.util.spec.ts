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
const redactedStateMatcher = (paths: readonly string[], max: number) => hold(paths, max).holds

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

  /* Every `Error` has them, so they are not what a host set. */
  it('does not count the message and stack an Error is built with, but counts those set', () => {
    const matcher = redactedStateMatcher(['message', 'stack'], 100)

    expect(matcher(new Error('failed'))).toBe(false)
    expect(matcher({ e: new Error('failed') })).toBe(false)
    expect(matcher(Object.defineProperty(new Error(), 'message', { enumerable: true }))).toBe(true)
    expect(matcher({ message: 'x' })).toBe(true)
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

    expect(redactedStateMatcher(['password'], 2)({ a: shared, b: shared })).toBe(false)
  })

  it('answers true past the number of objects it may read', () => {
    const matcher = redactedStateMatcher(['password'], 2)

    expect(matcher({ a: { b: 1 } })).toBe(false)
    expect(matcher({ a: { b: {} } })).toBe(true)
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
  /** The stand-in as the walk reads it. */
  const standIn = (error: Error, paths = ['*.password']): Record<string, unknown> =>
    hold(paths).standIn(error) as Record<string, unknown>

  /* Type, message, stack and the safe fields that are no object: nothing else of the host. */
  it('carries the type, message, stack, name and safe fields only', () => {
    class HttpError extends Error {
      code = 'E1'
      tenant = 't1'
      status = { password: 'x' }
      config = { password: 'x' }
    }
    const error = new HttpError('failed')
    const copy = standIn(error)

    expect(copy).toBeInstanceOf(HttpError)
    expect(copy['message']).toBe('failed')
    expect(copy['stack']).toBe(error.stack)
    expect(Object.keys(copy)).toEqual(['code', 'tenant'])
  })

  /* A path that names a safe field takes it out. */
  it('drops a safe field a path names, and every one under a wildcard', () => {
    const error = Object.assign(new Error('failed'), { code: 'E1', tenant: 't1' })

    expect(Object.keys(standIn(error, ['a.code']))).toEqual(['tenant'])
    expect(Object.keys(standIn(error, ['a.*']))).toEqual([])
  })

  /* The copy has no `toJSON`, whatever the prototype has, and no accessor of the host is run. */
  it('has no toJSON and runs no accessor of the held fields', () => {
    let runs = 0
    const read = (): string => {
      runs++
      return 'x'
    }
    class Hostile extends Error {
      toJSON(): unknown {
        runs++
        return 'x'
      }
    }
    const error = new Hostile('failed')
    // The engine writes the stack at its first read, from the name it finds then.
    expect(error.stack).toContain('failed')
    for (const key of ['code', 'name', 'cause', 'errors']) {
      Object.defineProperty(error, key, { get: read, enumerable: true })
    }
    const copy = standIn(error)

    expect(copy['toJSON']).toBeUndefined()
    expect(JSON.parse(JSON.stringify(copy))).toEqual({})
    expect(Object.hasOwn(copy, 'cause')).toBe(false)
    expect(runs).toBe(0)
  })

  /* A message or stack that cannot be read, or is not text, is written empty. */
  it('writes an empty message and stack it cannot read', () => {
    const error = Object.defineProperties(new Error(), {
      message: { value: { password: 'x' } },
      stack: {
        get: () => {
          throw new Error('no')
        }
      }
    })
    const copy = standIn(error)

    expect(copy['message']).toBe('')
    expect(copy['stack']).toBe('')
  })

  /* The errors under it are copied the same way; an object that is no `Error` is not written. */
  it('copies the errors under it and censors the objects', () => {
    const root = new Error('failed')
    const inner = Object.assign(new Error('inner', { cause: { password: 'x' } }), { config: 1 })
    Object.defineProperty(root, 'cause', { value: inner })
    Object.assign(root, { errors: [inner, 'text', { password: 'x' }, root] })
    const copy = standIn(root)
    const members = copy['errors'] as unknown[]
    const cause = copy['cause'] as Record<string, unknown>

    expect(cause['message']).toBe('inner')
    expect(cause['cause']).toBe('[X]')
    expect(Object.keys(cause)).toEqual([])
    expect(members).toEqual([cause, 'text', '[X]', copy])
  })

  /* A chain of causes is bounded. */
  it('censors a cause past the eighth link', () => {
    let error = new Error('0')
    for (let at = 1; at <= 12; at++) error = new Error(String(at), { cause: error })
    let node: unknown = standIn(error)
    let links = 0
    while (typeof node === 'object') {
      node = (node as { cause?: unknown }).cause
      links++
    }

    expect(links).toBe(9)
    expect(node).toBe('[X]')
  })

  /* Anything the copy cannot read leaves the censor. */
  it('answers the censor for an Error it cannot copy', () => {
    const { proxy, revoke } = Proxy.revocable(new Error(), {})
    revoke()

    expect(hold(['password']).standIn(proxy)).toBe('[X]')
  })
})
