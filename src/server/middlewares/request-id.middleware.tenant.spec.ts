/**
 * Pins where the tenant id of a request comes from. By default it is the value of the
 * `x-tenant-id` header, which the client chose; a host that knows better turns the header off
 * (`http.tenantIdHeader: false`) or supplies `http.tenantIdResolver`, which is then the only
 * source, so a client cannot attribute its requests to another tenant by sending the header.
 *
 * Layer: server, middlewares, tests. The middleware is driven directly with request and response
 * doubles, the way its other unit specs do, and the tenant is read from the log context its
 * `next` runs in.
 */
import { RequestIdMiddleware } from './request-id.middleware'
import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import { applyDefaults } from '../config/default-options'
import type { HttpOptions } from '../interfaces/logger-module-options.interface'
import { LogContextService } from '../services/log-context.service'

/** The tenant id the middleware puts in the context of a request with these headers. */
function tenantOf(
  http: HttpOptions,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {}
): unknown {
  const logContext = new LogContextService()
  const options = applyDefaults({ service: { name: 'tenant-test', version: '1.0.0' }, http })
  const middleware = new RequestIdMiddleware(logContext, options)
  const req = { headers, method: 'GET', url: '/tenant', ...extra } as unknown as LoggableRequest
  const res = { setHeader: jest.fn() } as unknown as LoggableResponse
  let seen: unknown = 'next was not called'
  middleware.use(req, res, () => {
    seen = logContext.get('tenantId')
  })
  return seen
}

const fromAuth = (req: LoggableRequest): string | undefined =>
  (req as unknown as { authenticatedTenant?: string }).authenticatedTenant

describe.each([
  ['the default header', {}, 'x-tenant-id', 'tenant-42'],
  ['a header of its own name', { tenantIdHeader: 'x-org-id' }, 'x-org-id', 'org-7']
])('the tenant id read from %s', (_name, http, header, value) => {
  it('is the value the client sent', () => {
    expect(tenantOf(http, { [header]: value })).toBe(value)
  })
})

describe('http.tenantIdHeader: false', () => {
  it('reads no header, whatever the client sends', () => {
    expect(tenantOf({ tenantIdHeader: false }, { 'x-tenant-id': 'someone-elses' })).toBeUndefined()
  })
})

describe('http.tenantIdResolver', () => {
  const extra = { authenticatedTenant: 'tenant-from-auth' }

  it('wins over the header, which the client cannot use to override it', () => {
    expect(
      tenantOf({ tenantIdResolver: fromAuth }, { 'x-tenant-id': 'someone-elses' }, extra)
    ).toBe('tenant-from-auth')
  })

  it('leaves the header unread when it answers nothing', () => {
    expect(
      tenantOf({ tenantIdResolver: () => undefined }, { 'x-tenant-id': 'someone-elses' })
    ).toBeUndefined()
  })

  it('keeps the tenant of the first mount when a second one runs on the same request', () => {
    const logContext = new LogContextService()
    const options = applyDefaults({
      service: { name: 'tenant-test', version: '1.0.0' },
      http: { tenantIdResolver: fromAuth }
    })
    const middleware = new RequestIdMiddleware(logContext, options)
    const req = {
      headers: { 'x-tenant-id': 'someone-elses' },
      method: 'GET',
      url: '/tenant',
      ...extra
    } as unknown as LoggableRequest
    const res = { setHeader: jest.fn() } as unknown as LoggableResponse
    let seen: unknown
    middleware.use(req, res, () => {
      middleware.use(req, res, () => {
        seen = logContext.get('tenantId')
      })
    })

    expect(seen).toBe('tenant-from-auth')
  })

  it.each([
    [
      'throws',
      (): string => {
        throw new Error('no session')
      }
    ],
    ['answers a value with a space', () => 'acme evil'],
    ['answers an oversized value', () => 'y'.repeat(300)],
    ['answers an empty value', () => ''],
    ['answers something that is not text', () => 7 as unknown as string]
  ])('gives no tenant id, and next still runs, when it %s', (_name, resolver) => {
    expect(
      tenantOf({ tenantIdResolver: resolver }, { 'x-tenant-id': 'someone-elses' })
    ).toBeUndefined()
  })

  it('is called with the request', () => {
    const seen: string[] = []

    tenantOf({
      tenantIdResolver: (req) => {
        seen.push(req.method)
        return undefined
      }
    })

    expect(seen).toEqual(['GET'])
  })
  it.each([
    ['a rejected promise', () => Promise.reject(new Error('session store down'))],
    [
      'a thenable whose then throws',
      () => ({
        then: (): never => {
          throw new Error('hostile then')
        }
      })
    ],
    [
      'a thenable that rejects',
      () => ({ then: (_ok: unknown, no: (e: Error) => void) => no(new Error('no')) })
    ]
  ])(
    'gives no tenant id and leaves no unhandled rejection when it answers %s',
    async (_name, answer) => {
      const unhandled = jest.fn()
      process.on('unhandledRejection', unhandled)
      try {
        const tenant = tenantOf({ tenantIdResolver: answer as unknown as () => string })
        await new Promise((resolve) => setImmediate(resolve))
        await new Promise((resolve) => setImmediate(resolve))

        expect(tenant).toBeUndefined()
        expect(unhandled).not.toHaveBeenCalled()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    }
  )
})
