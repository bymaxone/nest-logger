/**
 * Pins the default `req` serializer: what a Node request is written as, and that a value that is not
 * a request is left alone. The requests are real `IncomingMessage` objects, whose `headers` is a
 * prototype accessor and whose `rawHeaders` holds every header value beside its name.
 */
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'

import { censorRawHeaders } from './censor-raw-headers.util'
import { createNameRedactor } from './redact-by-name.util'
import { serializeRequestValue, withSerializedRequest } from './serialize-request.util'

const HEX = 'a3f1c9d2b7e4086f5a1c3d9e7b2f4a6c8d0e1f3a5b7c9d2e4f6a8b0c1d3e5f7a'

/** A real request with the given raw headers and URL. */
function request(rawHeaders: string[], url = '/probe?token=QUERY-SECRET'): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = 'POST'
  req.url = url
  req.rawHeaders = rawHeaders
  for (let i = 0; i < rawHeaders.length; i += 2) {
    req.headers[String(rawHeaders[i]).toLowerCase()] = rawHeaders[i + 1]
  }
  return req
}

describe('serializeRequestValue', () => {
  it('writes the method, the URL, the headers and the peer, and nothing of the connection', () => {
    const req = request(['Authorization', 'Bearer LEAK', 'User-Agent', 'probe-agent'])

    const out = serializeRequestValue(req) as Record<string, unknown>

    expect(Object.keys(out).sort()).toEqual(['headers', 'method', 'remoteAddress', 'url'])
    expect(out['method']).toBe('POST')
    expect(out['headers']).toEqual({ authorization: 'Bearer LEAK', 'user-agent': 'probe-agent' })
    expect(JSON.stringify(out)).not.toContain('rawHeaders')
  })

  it('writes the URL without its query and with a credential path segment replaced', () => {
    const out = serializeRequestValue(request([], `/auth/reset/${HEX}?code=QUERY-SECRET`))

    expect((out as { url: string }).url).toBe('/auth/reset/:redacted')
  })

  it('replaces a path segment a host pattern matches, as every other URL writer does', () => {
    const out = serializeRequestValue(request([], '/pay/sk_live123?x=1'), [/^sk_/])

    expect((out as { url: string }).url).toBe('/pay/:redacted')
    expect((serializeRequestValue(request([], '/pay/sk_live123')) as { url: string }).url).toBe(
      '/pay/sk_live123'
    )
  })

  it('prefers originalUrl, which a mounted request keeps whole', () => {
    const req = request([], '/users/7')
    ;(req as unknown as { originalUrl: string }).originalUrl = '/api/users/7'

    expect((serializeRequestValue(req) as { url: string }).url).toBe('/api/users/7')
  })

  it('writes the peer address of the socket', () => {
    const req = request([])
    Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.9' })

    expect((serializeRequestValue(req) as { remoteAddress: string }).remoteAddress).toBe(
      '203.0.113.9'
    )
  })

  it('reads a request that has no socket, no headers and no string URL', () => {
    const bare = { rawHeaders: [], method: 'GET', url: 42 }

    expect(serializeRequestValue(bare)).toEqual({
      method: 'GET',
      url: 42,
      headers: {},
      remoteAddress: undefined
    })
  })

  it('reads a request that has a connection and no raw headers', () => {
    const req = { method: 'GET', url: '/x', socket: {}, headers: { host: 'h' } }

    expect(serializeRequestValue(req)).toMatchObject({ method: 'GET', headers: { host: 'h' } })
  })

  it.each([
    ['a plain record under req', { id: 5, route: '/x' }],
    ['a string', 'GET /x'],
    ['null', null],
    ['a record with a method and no connection', { method: 'GET', url: '/x', id: 1 }]
  ])('returns %s as it is', (_name, value) => {
    expect(serializeRequestValue(value)).toBe(value)
  })

  it('writes a marker, and does not throw, for a request whose field cannot be read', () => {
    const hostile = {
      rawHeaders: [],
      get method(): string {
        throw new Error('hostile getter')
      }
    }

    expect(serializeRequestValue(hostile)).toEqual({ _unserializable: 'request' })
  })
})

describe('withSerializedRequest', () => {
  it('returns the record itself when req is absent or is not a request', () => {
    const record = { a: 1, req: { id: 5 } }

    expect(withSerializedRequest(record)).toBe(record)
    expect(withSerializedRequest({ a: 1 })).toEqual({ a: 1 })
  })

  it('passes the host patterns on to the URL', () => {
    const out = withSerializedRequest({ req: request([], '/pay/sk_live123') }, [/^sk_/])

    expect((out['req'] as { url: string }).url).toBe('/pay/:redacted')
  })

  it('returns a copy with the serialized request, and leaves the record alone', () => {
    const req = request(['X-Api-Key', 'LEAK'])
    const record = { a: 1, req }

    const out = withSerializedRequest(record)

    expect(out).not.toBe(record)
    expect(record.req).toBe(req)
    expect((out['req'] as { headers: unknown }).headers).toEqual({ 'x-api-key': 'LEAK' })
    expect(out['a']).toBe(1)
  })
})

describe('censorRawHeaders', () => {
  const sensitive = new Set(['authorization', 'x-api-key'])

  it('censors the value beside a sensitive name, whatever its case, and nothing else', () => {
    expect(
      censorRawHeaders(
        ['Authorization', 'Bearer LEAK', 'Accept', 'text/html', 'X-API-KEY', 'LEAK2'],
        sensitive,
        '[C]'
      )
    ).toEqual(['Authorization', '[C]', 'Accept', 'text/html', 'X-API-KEY', '[C]'])
  })

  it('censors the same shape under rawTrailers', () => {
    const redact = createNameRedactor(['authorization'], '[C]')

    expect(redact({ rawTrailers: ['Authorization', 'LEAK', 'X-Other', 'kept'] })).toEqual({
      rawTrailers: ['Authorization', '[C]', 'X-Other', 'kept']
    })
  })

  it('censors the values under the legacy paths strategy, where the walk holds only the names it covers inside errors', () => {
    const redact = createNameRedactor([], '[C]', [], undefined, undefined, ['authorization'])

    expect(
      redact({ request: { rawHeaders: ['Authorization', 'LEAK', 'Accept', 'kept'] } })
    ).toEqual({
      request: { rawHeaders: ['Authorization', '[C]', 'Accept', 'kept'] }
    })
  })

  it('leaves a rawHeaders array as it is when the walk covers no name at all', () => {
    const redact = createNameRedactor([], '[C]')

    expect(redact({ rawHeaders: ['Authorization', 'kept'] })).toEqual({
      rawHeaders: ['Authorization', 'kept']
    })
  })

  it('leaves a value that sits at an even index, and a name that is not text, alone', () => {
    expect(censorRawHeaders(['authorization', 'v', 7, 'w', 'x'], sensitive, '[C]')).toEqual([
      'authorization',
      '[C]',
      7,
      'w',
      'x'
    ])
  })
})
