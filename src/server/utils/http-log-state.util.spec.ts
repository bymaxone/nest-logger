import {
  isRecorderActive,
  markRecorderActive,
  readRecordedError,
  readUserAgent,
  readUserId,
  recordError,
  toError
} from './http-log-state.util'

describe('http-log-state', () => {
  describe('recorder claim', () => {
    it(/*
     * A request nobody claimed must read as unclaimed. This is the branch that
     * keeps a consumer who never wired the middleware from losing HTTP logs
     * altogether: the interceptor falls back to emitting its own entries.
     */
    'reports an unclaimed request as inactive', () => {
      expect(isRecorderActive({})).toBe(false)
    })

    it('reports a claimed request as active', () => {
      const req = {}
      markRecorderActive(req)
      expect(isRecorderActive(req)).toBe(true)
    })

    it(/*
     * The claim is keyed by a Symbol so it can never collide with a consumer's
     * own field and never reaches a log line: `Object.keys` does not see it, and
     * neither does `JSON.stringify`.
     */
    'stores the claim invisibly to enumeration and serialization', () => {
      const req: Record<string, unknown> = { url: '/x' }
      markRecorderActive(req)

      expect(Object.keys(req)).toEqual(['url'])
      expect(JSON.stringify(req)).toBe('{"url":"/x"}')
    })
  })

  describe('recorded error', () => {
    it('reports no error for a request that never threw', () => {
      expect(readRecordedError({})).toBeUndefined()
    })

    it(/*
     * The hand-off that keeps a 5xx terminal entry carrying its stack: the
     * interceptor sees the thrown value, the middleware's close handler sees only
     * a status code.
     */
    'round-trips the recorded error', () => {
      const req = {}
      const error = new Error('boom')

      recordError(req, error)

      expect(readRecordedError(req)?.error).toBe(error)
    })

    it('keeps the error out of enumeration and serialization', () => {
      const req: Record<string, unknown> = { url: '/x' }
      recordError(req, new Error('boom'))

      expect(Object.keys(req)).toEqual(['url'])
      expect(JSON.stringify(req)).toBe('{"url":"/x"}')
    })
  })

  describe('toError', () => {
    it('returns an Error unchanged, preserving its stack', () => {
      const error = new Error('original')
      expect(toError(error)).toBe(error)
    })

    it(/*
     * A `throw` can carry anything. The error serializer keys off an `Error`
     * instance, so a thrown string would otherwise reach the sink with no message
     * and no stack.
     */
    'wraps a non-Error into one carrying its text', () => {
      const wrapped = toError('just a string')
      expect(wrapped).toBeInstanceOf(Error)
      expect(wrapped.message).toBe('just a string')
    })

    it.each([
      [undefined, 'undefined'],
      [null, 'null'],
      [42, '42']
    ])('wraps %p as %p', (thrown, expected) => {
      expect(toError(thrown).message).toBe(expected)
    })
  })

  describe('readUserId', () => {
    it(/*
     * `sub` wins over `id`: the JWT subject is the authenticated identity, and
     * every `@bymax-one/nest-auth` token names it that way. Reading only `id` —
     * as the interceptor once did — dropped the user for every JWT request.
     */
    'prefers the JWT subject over the ORM id', () => {
      expect(readUserId({ user: { sub: 'jwt-sub', id: 'orm-id' } })).toBe('jwt-sub')
    })

    it('falls back to the ORM id', () => {
      expect(readUserId({ user: { id: 'orm-id' } })).toBe('orm-id')
    })

    it.each([[{}], [{ user: undefined }], [{ user: {} }]])(
      'yields undefined without a principal (%p)',
      (req) => {
        expect(readUserId(req)).toBeUndefined()
      }
    )
  })

  describe('readUserAgent', () => {
    it('reads the header when it is a string', () => {
      expect(readUserAgent({ headers: { 'user-agent': 'curl/8' } })).toBe('curl/8')
    })

    it.each<[Record<string, string | string[] | undefined>, string]>([
      [{}, 'header absent'],
      [{ 'user-agent': undefined }, 'header undefined'],
      [{ 'user-agent': ['a', 'b'] }, 'header repeated into an array']
    ])(
      /*
       * The field is part of the access-log contract, so a missing or repeated
       * header must not put `undefined` (or an array) into the entry.
       */
      'falls back to unknown when the header is not a string (%#: %s)',
      (headers) => {
        expect(readUserAgent({ headers })).toBe('unknown')
      }
    )
  })
})
