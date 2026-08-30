import { Controller, Get, Inject, Module } from '@nestjs/common'
import type { INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { applyRequestIdMiddleware } from './apply-request-id-middleware'
import { RequestIdMiddleware } from './request-id.middleware'
import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { BymaxLoggerModule } from '../logger.module'
import { LogContextService } from '../services/log-context.service'

/** UUID v4 shape used to assert a generated correlation id. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Exposes the propagated context so tests can prove the scope started pre-handler. */
@Controller()
class ContextController {
  constructor(@Inject(LogContextService) private readonly logContext: LogContextService) {}

  @Get('ctx')
  ctx(): { requestId: unknown; tenantId: unknown } {
    return {
      requestId: this.logContext.get('requestId'),
      tenantId: this.logContext.get('tenantId')
    }
  }
}

/** Wires the middleware via the public helper, exactly as a consumer would. */
@Module({
  imports: [BymaxLoggerModule.forRoot({ service: { name: 'middleware-test', version: '1.0.0' } })],
  controllers: [ContextController]
})
class ContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applyRequestIdMiddleware(consumer)
  }
}

describe('RequestIdMiddleware (integration via applyRequestIdMiddleware)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ContextModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it(/*
   * With no inbound x-request-id the middleware must mint a UUID, expose it on the
   * response, and propagate it into the handler's context — proving the scope is
   * opened before the handler runs.
   */
  'generates a request id, exposes it, and propagates it', async () => {
    const res = await request(app.getHttpServer()).get('/ctx').expect(200)

    const header = res.headers['x-request-id']
    expect(header).toMatch(UUID_V4)
    expect(res.body.requestId).toBe(header)
  })

  it(/*
   * An inbound x-request-id must be honored (not regenerated) and echoed back —
   * covers the "header present" branch of the id resolution.
   */
  'echoes and propagates an inbound x-request-id', async () => {
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-request-id', 'req-abc-123')
      .expect(200)

    expect(res.headers['x-request-id']).toBe('req-abc-123')
    expect(res.body.requestId).toBe('req-abc-123')
  })

  it(/*
   * The configured tenant header must be read into the context when present —
   * covers the tenant "present" branch.
   */
  'propagates the tenant id from the x-tenant-id header', async () => {
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-tenant-id', 'tenant-42')
      .expect(200)

    expect(res.body.tenantId).toBe('tenant-42')
  })

  it(/*
   * With no tenant header the context must carry no tenantId — covers the tenant
   * "absent" branch and proves an undefined value is never written.
   */
  'omits the tenant id when the header is absent', async () => {
    const res = await request(app.getHttpServer()).get('/ctx').expect(200)

    expect(res.body.tenantId).toBeUndefined()
  })

  it(/*
   * An oversized inbound x-request-id must be rejected and replaced with a fresh
   * UUID, so a client cannot push an unbounded string into every log entry —
   * covers the length-bound rejection on the request-id path.
   */
  'rejects an oversized x-request-id and generates a fresh one', async () => {
    const oversized = 'x'.repeat(300)
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-request-id', oversized)
      .expect(200)

    expect(res.headers['x-request-id']).not.toBe(oversized)
    expect(res.headers['x-request-id']).toMatch(UUID_V4)
    expect(res.body.requestId).toBe(res.headers['x-request-id'])
  })

  it(/*
   * An x-request-id carrying a character outside the id-safe set (here a markup
   * fragment) must be rejected and replaced with a fresh UUID, so a client cannot
   * plant markup or a control byte into the logs and the echoed correlationId.
   */
  'rejects a request id with disallowed characters and generates a fresh one', async () => {
    const malicious = '<script>alert(1)</script>'
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-request-id', malicious)
      .expect(200)

    expect(res.headers['x-request-id']).not.toBe(malicious)
    expect(res.headers['x-request-id']).toMatch(UUID_V4)
    expect(res.body.requestId).toBe(res.headers['x-request-id'])
  })

  it(/*
   * A tenant header with a disallowed character (a space here) must be dropped,
   * not propagated into the log context — the same id-safe gate on the tenant path.
   */
  'omits a tenant id with disallowed characters', async () => {
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-tenant-id', 'acme evil')
      .expect(200)

    expect(res.body.tenantId).toBeUndefined()
  })

  it(/*
   * An oversized tenant header must be dropped (not propagated) — covers the
   * length-bound rejection on the tenant path.
   */
  'omits an oversized tenant id', async () => {
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-tenant-id', 'y'.repeat(300))
      .expect(200)

    expect(res.body.tenantId).toBeUndefined()
  })

  it(/*
   * An x-request-id at EXACTLY the 256-char bound must be honored (the check is
   * `length <= 256`, inclusive) — pins the boundary so an off-by-one (`<`) that
   * would reject a max-length id is caught.
   */
  'honors an x-request-id at exactly the 256-char limit', async () => {
    const atLimit = 'a'.repeat(256)
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-request-id', atLimit)
      .expect(200)

    expect(res.headers['x-request-id']).toBe(atLimit)
    expect(res.body.requestId).toBe(atLimit)
  })
})

/** Wires the middleware with request-id generation disabled (gateway owns it). */
@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'no-gen-test', version: '1.0.0' },
      http: { shouldGenerateRequestId: false }
    })
  ],
  controllers: [ContextController]
})
class NoGenContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applyRequestIdMiddleware(consumer)
  }
}

describe('RequestIdMiddleware with shouldGenerateRequestId disabled', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [NoGenContextModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it(/*
   * With generation disabled and no inbound header, the middleware must NOT mint
   * an id: no x-request-id header is exposed and the context carries no requestId —
   * correlation is delegated to the upstream gateway. Pins both the
   * `shouldGenerateRequestId ? … : undefined` and `if (requestId !== undefined)` branches.
   */
  'mints no request id when disabled and no header is present', async () => {
    const res = await request(app.getHttpServer()).get('/ctx').expect(200)

    expect(res.headers['x-request-id']).toBeUndefined()
    expect(res.body.requestId).toBeUndefined()
  })

  it(/*
   * With generation disabled an INBOUND header must still be honored and echoed —
   * the gateway-provided id flows through unchanged.
   */
  'still honors an inbound x-request-id when generation is disabled', async () => {
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-request-id', 'gw-1')
      .expect(200)

    expect(res.headers['x-request-id']).toBe('gw-1')
    expect(res.body.requestId).toBe('gw-1')
  })
})

/**
 * Options double carrying only what the middleware reads.
 *
 * `otel` is required as well as `http`: the non-inheritable set is built from the
 * RESOLVED trace field names, so the middleware reads them in its constructor.
 */
function createOptions(
  shouldGenerateRequestId = true,
  otel: Partial<ResolvedBymaxLoggerModuleOptions['otel']> = {}
): ResolvedBymaxLoggerModuleOptions {
  return {
    http: { tenantIdHeader: 'x-tenant-id', shouldGenerateRequestId },
    otel: {
      traceIdField: 'traceId',
      spanIdField: 'spanId',
      traceFlagsField: 'traceFlags',
      ...otel
    }
  } as unknown as ResolvedBymaxLoggerModuleOptions
}

/** Response double recording the correlation header it is given. */
function createResponse(): { res: LoggableResponse; setHeader: jest.Mock } {
  const setHeader = jest.fn()
  return { res: { setHeader } as unknown as LoggableResponse, setHeader }
}

/** Request double carrying only inbound headers. */
function createRequest(headers: Record<string, string> = {}): LoggableRequest {
  return { headers, method: 'GET', url: '/ctx' } as unknown as LoggableRequest
}

describe('RequestIdMiddleware mounted a second time', () => {
  let logContext: LogContextService

  beforeEach(() => {
    logContext = new LogContextService()
  })

  it(/*
   * Two mounts must not mint two ids. Before this, `applyAccessLog(app)` next to
   * `applyRequestIdMiddleware(consumer)` produced UUID A on the response header
   * and UUID B in the context, so the header and the log entries disagreed about
   * which id the request had. The id already in scope wins.
   */
  'adopts the id already in scope instead of minting a second', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res, setHeader } = createResponse()
    const req = createRequest({ 'x-request-id': 'inbound-1' })

    // Two real mounts on the SAME request, which is what `applyAccessLog(app)`
    // alongside `applyRequestIdMiddleware(consumer)` produces.
    middleware.use(req, res, () => {
      middleware.use(req, res, () => {
        expect(logContext.get('requestId')).toBe('inbound-1')
      })
    })

    const written = setHeader.mock.calls.map(([, value]) => value)
    expect(written).toEqual(['inbound-1', 'inbound-1'])
  })

  it(/*
   * Adopting must not open another scope at all. Asserting object IDENTITY is
   * what proves it: an equal-but-fresh store would pass a value comparison while
   * having actually opened a third scope on a request that needed none.
   */
  'adopts without opening another scope', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()
    const req = createRequest({ 'x-tenant-id': 't_1' })

    middleware.use(req, res, () => {
      const firstStore = logContext.getStore()
      middleware.use(req, res, () => {
        expect(logContext.getStore()).toBe(firstStore)
        expect(logContext.get('tenantId')).toBe('t_1')
      })
    })
  })

  it(/*
   * An enclosing scope carrying no correlation id is NOT a second mount — it is
   * consumer code that opened its own scope. The request gets its own id, and the
   * enclosing scope's fields are carried into it rather than discarded, which is
   * the failure `run()` would produce here: a tenantId resolved at the
   * edge silently absent for the whole request.
   */
  'takes its own scope and inherits the enclosing fields', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res, setHeader } = createResponse()

    logContext.run({ tenantId: 't_1' }, () => {
      middleware.use(createRequest({ 'x-request-id': 'inbound-9' }), res, () => {
        expect(logContext.get('requestId')).toBe('inbound-9')
        expect(logContext.get('tenantId')).toBe('t_1')
      })
    })

    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'inbound-9')
  })

  it(/*
   * With generation disabled and no inbound header there is no id to carry, so no
   * header is exposed and no requestId reaches the scope — the gateway owns
   * correlation on that configuration — while the enclosing fields still survive.
   */
  'exposes no id when generation is disabled and none is available', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions(false))
    const { res, setHeader } = createResponse()

    logContext.run({ tenantId: 't_1' }, () => {
      middleware.use(createRequest(), res, () => {
        expect(logContext.get('requestId')).toBeUndefined()
      })
    })

    expect(setHeader).not.toHaveBeenCalled()
  })

  it(/*
   * A tenant id already in scope must not be overwritten by the header. The
   * enclosing scope resolved it deliberately — from an auth claim, say — and a
   * client-supplied header must not be able to displace that.
   */
  'keeps a tenant id already in scope over a later header value', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()
    const headers: Record<string, string> = { 'x-tenant-id': 'resolved-first' }
    const req = createRequest(headers)

    middleware.use(req, res, () => {
      // Something downstream rewrote the header between the two mounts. The
      // tenant already in scope is the one the request was admitted under.
      headers['x-tenant-id'] = 'rewritten'
      middleware.use(req, res, () => {
        expect(logContext.get('tenantId')).toBe('resolved-first')
      })
    })
  })

  it(/*
   * A scope missing the tenant id must still pick it up from the header —
   * the counterpart branch to the one above.
   */
  'fills in a tenant id the first mount did not have', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()
    const headers: Record<string, string> = {}
    const req = createRequest(headers)

    middleware.use(req, res, () => {
      // Upstream auth resolved the tenant after the correlation scope opened.
      headers['x-tenant-id'] = 'acme'
      middleware.use(req, res, () => {
        expect(logContext.get('tenantId')).toBe('acme')
      })
    })
  })

  it(/*
   * An unacceptable tenant header (a space is outside the id-safe set) must be
   * dropped on the enrich path too, not just when opening a fresh scope — the
   * validation gate cannot be bypassed by arriving through the second mount.
   */
  'drops an unacceptable tenant header on the adopt path', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()
    const headers: Record<string, string> = {}
    const req = createRequest(headers)

    middleware.use(req, res, () => {
      headers['x-tenant-id'] = 'acme evil'
      middleware.use(req, res, () => {
        // The exact shape, not just a `toBeUndefined()` read: the contract is
        // "absent means absent — no key is ever written holding `undefined` to
        // mean not set", and a store carrying `tenantId: undefined` reads as
        // undefined through `get()` while still having the key. Only comparing
        // the whole object can tell those apart.
        expect(Object.keys(logContext.getStore() ?? {})).toEqual(['requestId'])
      })
    })
  })
  it(/*
   * REGRESSION — two requests must never share a correlation id.
   *
   * An earlier version of this middleware ENRICHED an enclosing scope in place
   * instead of opening its own. Measured on that version, with the server created
   * inside a `run()` scope (every request handler then inherits that store):
   * the first request wrote its UUID into the shared store, the second adopted it,
   * and both were logged under one id — while the shared store kept that id after
   * both had finished. Correlation that silently merges two requests is worse than
   * no correlation, because it is trusted.
   */
  'gives two requests inside one enclosing scope different ids', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()
    const seen: (string | undefined)[] = []

    logContext.run({ service: 'api' }, () => {
      middleware.use(createRequest(), res, () => {
        seen.push(logContext.get<string>('requestId'))
      })
      middleware.use(createRequest(), res, () => {
        seen.push(logContext.get<string>('requestId'))
      })

      // The shared store must be exactly as it was: no requestId leaked into it.
      expect(logContext.getStore()).toEqual({ service: 'api' })
    })

    expect(seen[0]).toBeDefined()
    expect(seen[1]).toBeDefined()
    expect(seen[0]).not.toBe(seen[1])
  })

  it(/*
   * The enclosing scope's own fields must still reach the request's entries —
   * isolation must not be bought by dropping what the caller had set, which is
   * the trade `run()` would have made.
   */
  'carries the enclosing fields into each isolated request scope', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()

    logContext.run({ service: 'api' }, () => {
      middleware.use(createRequest(), res, () => {
        expect(logContext.get('service')).toBe('api')
        expect(logContext.get('requestId')).toBeDefined()
      })
    })
  })
  it(/*
   * SECURITY — an id a consumer put in the store is NOT adopted.
   *
   * `LogContextService.set()` takes `unknown`, so consumer middleware can place a
   * raw user-controlled header value under `requestId`. Adopting it would echo it
   * onto the response header verbatim: this value carries CR/LF, and Node's
   * `res.setHeader` throws ERR_INVALID_CHAR on it — measured — which would break
   * the request before it reached the application. The adopt path is reachable
   * only for an id THIS middleware established, which the per-request mark
   * establishes and the store alone cannot.
   */
  'does not adopt a request id the middleware did not set', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res, setHeader } = createResponse()

    logContext.run({ requestId: 'evil\r\nInjected: 1' }, () => {
      middleware.use(createRequest(), res, () => {
        expect(logContext.get('requestId')).not.toBe('evil\r\nInjected: 1')
        expect(logContext.get<string>('requestId')).toMatch(UUID_V4)
      })
    })

    const [, written] = setHeader.mock.calls[0] as [string, string]
    expect(written).toMatch(UUID_V4)
  })

  it(/*
   * The same gate for the length bound: an oversized value in an enclosing scope
   * must not reach the response header. `setHeader` accepts a 5000-character
   * value without complaint — measured — so nothing downstream would catch it,
   * and it would ride on every entry for the request's lifetime.
   */
  'does not adopt an oversized request id from an enclosing scope', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res, setHeader } = createResponse()
    const oversized = 'y'.repeat(5000)

    logContext.run({ requestId: oversized }, () => {
      middleware.use(createRequest(), res, () => {
        expect(logContext.get('requestId')).not.toBe(oversized)
      })
    })

    const [, written] = setHeader.mock.calls[0] as [string, string]
    expect(written).not.toBe(oversized)
    expect(written).toMatch(UUID_V4)
  })

  it(/*
   * With generation disabled and no inbound header the middleware sets no id, so
   * a second mount finds the request marked but the store empty and simply takes
   * the ordinary path again. Pins the third branch of the mark/store pair, which
   * is reachable and would otherwise be an untested combination.
   */
  'takes the ordinary path on a second mount that established no id', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions(false))
    const { res, setHeader } = createResponse()
    const req = createRequest()

    middleware.use(req, res, () => {
      middleware.use(req, res, () => {
        expect(logContext.get('requestId')).toBeUndefined()
      })
    })

    expect(setHeader).not.toHaveBeenCalled()
  })
  it(/*
   * SECURITY — a value written into the store BETWEEN two mounts is not echoed.
   *
   * The previous fix marked the request with a boolean, which proved only that
   * this middleware opened the scope. Middleware running between the two mounts
   * can call set('requestId', rawHeader), and the flag still read true — so the
   * second mount echoed the replacement, and a CR/LF value there makes
   * res.setHeader throw ERR_INVALID_CHAR before the request reaches the
   * application. The id is now read back from the REQUEST, so what is echoed is
   * what was validated, whatever the store holds by then.
   */
  'echoes its own id even when the store was overwritten between mounts', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res, setHeader } = createResponse()
    const req = createRequest({ 'x-request-id': 'validated-1' })

    middleware.use(req, res, () => {
      // Consumer middleware, running between the two mounts.
      logContext.set('requestId', 'evil\r\nInjected: 1')
      middleware.use(req, res, () => {
        // The STORE, not just the header. The emitted entry reads `requestId`
        // from here, so asserting only the header would leave every subsequent
        // log line carrying the injected value while the response said otherwise
        // — the same header/entry split this change exists to remove.
        expect(logContext.get('requestId')).toBe('validated-1')
      })
    })

    const written = setHeader.mock.calls.map(([, value]) => value)
    expect(written).toEqual(['validated-1', 'validated-1'])
  })

  it(/*
   * SECURITY — a client-supplied x-tenant-id must not displace a tenant the
   * application already resolved.
   *
   * The request's context overrides the inherited fields key by key, so
   * copying the header unconditionally let a client rewrite the tenant on every
   * entry the request produced. The adopt path already preserved a resolved
   * tenant; this pins the same rule on the path that opens the scope, which is
   * where the asymmetry actually bit.
   */
  'does not let the tenant header override a tenant already resolved upstream', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()

    logContext.run({ tenantId: 'from-auth' }, () => {
      middleware.use(createRequest({ 'x-tenant-id': 'attacker' }), res, () => {
        expect(logContext.get('tenantId')).toBe('from-auth')
      })
    })
  })

  it(/*
   * The counterpart branch: with no tenant in the enclosing scope the header is
   * still the source, so the gate above narrows the rule rather than disabling
   * tenant propagation.
   */
  'still takes the tenant header when the enclosing scope has none', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()

    logContext.run({ region: 'eu-west-1' }, () => {
      middleware.use(createRequest({ 'x-tenant-id': 'acme' }), res, () => {
        expect(logContext.get('tenantId')).toBe('acme')
        // An ordinary consumer field IS inherited; identity is the exception.
        expect(logContext.get('region')).toBe('eu-west-1')
      })
    })
  })
  it(/*
   * Pins the documented behaviour of the DEFAULT generation mode under a
   * long-lived enclosing scope, because the JSDoc used to warn about the
   * opposite. Adoption reads a value recorded on the REQUEST, which a scope
   * opened elsewhere does not have — so the enclosing id reaches neither the
   * header nor the entries, and two requests differ.
   */
  'never adopts an enclosing scope id when generation is on', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res, setHeader } = createResponse()
    const seen: (string | undefined)[] = []

    logContext.run({ requestId: 'LONG-LIVED' }, () => {
      for (let i = 0; i < 2; i += 1) {
        const req = createRequest()
        middleware.use(req, res, () => {
          middleware.use(req, res, () => {
            seen.push(logContext.get<string>('requestId'))
          })
        })
      }
    })

    expect(seen[0]).not.toBe('LONG-LIVED')
    expect(seen[0]).not.toBe(seen[1])
    expect(setHeader.mock.calls.map(([, value]) => value)).not.toContain('LONG-LIVED')
  })

  it(/*
   * The other generation mode, and the one where an enclosing id DOES reach the
   * entries — by the request scope inheriting the consumer's own, not by
   * adoption. Nothing is minted and no header is exposed, which is what
   * `shouldGenerateRequestId: false` means: the gateway owns the id.
   */
  'inherits an enclosing scope id when generation is off, without echoing it', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions(false))
    const { res, setHeader } = createResponse()
    const seen: (string | undefined)[] = []

    logContext.run({ requestId: 'LONG-LIVED' }, () => {
      const req = createRequest()
      middleware.use(req, res, () => {
        seen.push(logContext.get<string>('requestId'))
      })
    })

    expect(seen).toEqual(['LONG-LIVED'])
    expect(setHeader).not.toHaveBeenCalled()
  })
  it(/*
   * SECURITY — a request must never inherit an authenticated identity.
   *
   * `userId` is resolved by a guard that runs AFTER this middleware, so an
   * enclosing scope cannot hold a correct value for the request. Measured before
   * this guard existed: an anonymous request inside a scope holding
   * `userId: 'admin-u1'` was logged under `admin-u1`, because the mixin copies
   * the store onto every entry and omitting the argument does not erase it.
   * This is the exact leak `run()` replaces by default to avoid, and inheriting
   * reopened it.
   */
  'does not inherit userId from an enclosing scope', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()

    logContext.run({ userId: 'admin-u1', tenantId: 'acme' }, () => {
      middleware.use(createRequest(), res, () => {
        expect(logContext.get('userId')).toBeUndefined()
        // The field is absent, not present-and-undefined: the contract is that
        // no key is ever written holding `undefined` to mean "not set".
        expect(Object.keys(logContext.getStore() ?? {})).not.toContain('userId')
        // The tenant still comes through — the rule is narrow, not a blanket ban.
        expect(logContext.get('tenantId')).toBe('acme')
      })
    })
  })

  it(/*
   * The same rule for trace correlation. The mixin overwrites `traceId` from the
   * active span, but only when there IS one — so a stale value inherited here
   * survives into every entry of a request with no span and points at another
   * request's trace.
   */
  'does not inherit traceId or spanId from an enclosing scope', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()

    logContext.run({ traceId: 'stale-trace', spanId: 'stale-span' }, () => {
      middleware.use(createRequest(), res, () => {
        const keys = Object.keys(logContext.getStore() ?? {})
        expect(keys).not.toContain('traceId')
        expect(keys).not.toContain('spanId')
      })
    })
  })

  it(/*
   * The enclosing scope must be left exactly as it was — dropping the identity
   * happens on the request's own copy, never by deleting from the caller's store.
   */
  'leaves the enclosing scope intact when dropping identity', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()

    logContext.run({ userId: 'admin-u1', traceId: 't', spanId: 's' }, () => {
      middleware.use(createRequest(), res, () => undefined)
      expect(logContext.getStore()).toEqual({ userId: 'admin-u1', traceId: 't', spanId: 's' })
    })
  })
  it(/*
   * `traceFlags` was missing from the exclusion even on the DEFAULT options — the
   * first version listed `traceId` and `spanId` literally and forgot the third
   * field the mixin emits. A stale flags value inherited here survives into every
   * entry of a request with no active span, exactly like the other two.
   */
  'does not inherit traceFlags from an enclosing scope', () => {
    const middleware = new RequestIdMiddleware(logContext, createOptions())
    const { res } = createResponse()

    logContext.run({ traceFlags: '01' }, () => {
      middleware.use(createRequest(), res, () => {
        expect(Object.keys(logContext.getStore() ?? {})).not.toContain('traceFlags')
      })
    })
  })

  it(/*
   * The trace field NAMES are configurable, so the exclusion cannot be literal.
   * Under `fieldFormat: 'snake_case'` the mixin emits `trace_id` / `span_id` /
   * `trace_flags` — the OTel Logs Data Model wire shape — and a hard-coded
   * camelCase list would inherit exactly the fields the library is emitting while
   * excluding ones it is not.
   */
  'does not inherit the snake_case trace fields when they are configured', () => {
    const middleware = new RequestIdMiddleware(
      logContext,
      createOptions(true, {
        traceIdField: 'trace_id',
        spanIdField: 'span_id',
        traceFlagsField: 'trace_flags'
      })
    )
    const { res } = createResponse()

    logContext.run({ trace_id: 'stale', span_id: 'stale', trace_flags: '01' }, () => {
      middleware.use(createRequest(), res, () => {
        const keys = Object.keys(logContext.getStore() ?? {})
        expect(keys).not.toContain('trace_id')
        expect(keys).not.toContain('span_id')
        expect(keys).not.toContain('trace_flags')
      })
    })
  })

  it(/*
   * An individually overridden field name is honoured too, and a field the
   * library is NOT emitting under that configuration stays an ordinary consumer
   * field — the rule is "whatever this library emits as trace correlation",
   * neither wider nor narrower.
   */
  'excludes a custom trace field name while inheriting the unused default', () => {
    const middleware = new RequestIdMiddleware(
      logContext,
      createOptions(true, { traceIdField: 'correlation.trace' })
    )
    const { res } = createResponse()

    logContext.run({ 'correlation.trace': 'stale', traceId: 'a-consumer-field' }, () => {
      middleware.use(createRequest(), res, () => {
        expect(logContext.get('correlation.trace')).toBeUndefined()
        expect(logContext.get('traceId')).toBe('a-consumer-field')
      })
    })
  })
})
