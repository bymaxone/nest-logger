/**
 * Pins the merge of the mixin result with the caller's object: the keys the mixin writes win over
 * the payload and over their spellings, a key the mixin leaves undefined changes nothing, the acting
 * user a call names wins over the ambient one, a prototype key is dropped, and an object that cannot
 * be read is dropped whole with the mixin's own keys kept.
 *
 * Layer: server/utils, tests. Pure.
 */
import { mergeMixinSafely } from './merge-mixin-safely.util'

const merge = (payload: object, mixin: object): Record<string, unknown> =>
  mergeMixinSafely(payload, mixin) as Record<string, unknown>

describe('mergeMixinSafely', () => {
  it('keeps the fields of the payload and adds the ones of the mixin', () => {
    expect(merge({ a: 1 }, { requestId: 'r' })).toEqual({ a: 1, requestId: 'r' })
  })

  it('lets the mixin win over a payload key of the same name', () => {
    expect(merge({ requestId: 'forged', a: 1 }, { requestId: 'real' })).toEqual({
      requestId: 'real',
      a: 1
    })
  })

  it.each([
    ['request_id', 'requestId'],
    ['REQUEST.ID', 'requestId'],
    ['Trace-Id', 'traceId'],
    ['trace.id', 'trace_id'],
    ['trace\u200bid', 'traceId'],
    ['request id', 'requestId'],
    ['req\nuest_id', 'requestId'],
    ['r\u0435questId', 'requestId'],
    ['\uff32equestId', 'requestId'],
    ['\u017fpan_id', 'spanId'],
    ['trace\u0301Id', 'traceId'],
    ['tr\u0000ace_id', 'traceId'],
    ['\u1d1b\u0280\u1d00\u1d04\u1d07_\u026a\u1d05', 'traceId'],
    ['trace_\u0131d', 'traceId'],
    ['trace\u2011id', 'traceId']
  ])('drops %s, a spelling of %s, whichever way the mixin writes it', (spelling, written) => {
    const out = merge({ [spelling]: 'forged', a: 1 }, { [written]: 'real' })

    expect(out).not.toHaveProperty([spelling])
    expect(out).toEqual({ a: 1, [written]: 'real' })
  })

  it('keeps a key that only looks like one the mixin writes', () => {
    expect(merge({ request_ids: 'kept' }, { requestId: 'r' })).toEqual({
      request_ids: 'kept',
      requestId: 'r'
    })
  })

  it('keeps the spelling when the mixin writes nothing for that key', () => {
    expect(merge({ request_id: 'own' }, {})).toEqual({ request_id: 'own' })
    expect(merge({ request_id: 'own' }, { requestId: undefined })).toEqual({ request_id: 'own' })
  })

  it('does not write a mixin key that is undefined, and so does not erase the payload value', () => {
    const out = merge({ requestId: 'own' }, { requestId: undefined })

    expect(out).toEqual({ requestId: 'own' })
  })

  it.each(['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'])(
    'writes a key of the mixin named like a member every object inherits: %s',
    (key) => {
      const out = merge({ a: 1 }, { [key]: 'ambient' })

      expect(Object.keys(out)).toEqual(['a', key])
      expect(Object.getOwnPropertyDescriptor(out, key)?.value).toBe('ambient')
    }
  )

  describe('the acting user', () => {
    it('keeps the one the payload names over the ambient one', () => {
      expect(merge({ userId: 'explicit' }, { userId: 'ambient' })).toEqual({ userId: 'explicit' })
    })

    it('writes the ambient one when the payload names none', () => {
      expect(merge({ a: 1 }, { userId: 'ambient' })).toEqual({ a: 1, userId: 'ambient' })
      expect(merge({ userId: undefined }, { userId: 'ambient' })).toEqual({ userId: 'ambient' })
    })

    it('drops a spelling of it that the payload carries, even beside the exact key', () => {
      const out = merge({ userId: 'explicit', user_id: 'forged' }, { userId: 'ambient' })

      expect(out).toEqual({ userId: 'explicit' })
    })
  })

  it('drops the own __proto__ key of a parsed payload and keeps its prototype', () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as object

    const out = merge(payload, { requestId: 'r' })

    expect(out).toEqual({ a: 1, requestId: 'r' })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(out).not.toHaveProperty('polluted')
  })

  it('drops the payload whole when it cannot be read, and keeps the keys of the mixin', () => {
    const hostile = {
      a: 1,
      get b(): string {
        throw new Error('hostile')
      }
    }

    const out = merge(hostile, { requestId: 'r' })

    expect(out).toMatchObject({ requestId: 'r', _redactionFailed: true })
    expect(out).not.toHaveProperty('a')
  })
})
