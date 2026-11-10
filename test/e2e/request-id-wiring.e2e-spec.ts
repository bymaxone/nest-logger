/**
 * E2E: `RequestIdMiddleware` mounted through `applyRequestIdMiddleware(consumer)`, through a real
 * Nest application and real HTTP.
 *
 * The middleware's own decisions (which ids and tenants it accepts, the length bound, the disabled
 * generation) are pinned with doubles in `src/server/middlewares/request-id.middleware.spec.ts`.
 * What doubles cannot show is that the module wiring mounts it ahead of a handler, so the id it
 * minted is on the response and in the log context that the handler reads. These cases read both.
 *
 * Layer: E2E, server.
 */
import { Controller, Get, Inject, Module } from '@nestjs/common'
import type { INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
  applyRequestIdMiddleware,
  BymaxLoggerModule,
  LogContextService
} from '@bymax-one/nest-logger'
import request from 'supertest'

/** UUID v4 shape used to assert a generated correlation id. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Exposes the propagated context so the cases can prove the scope started before the handler. */
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
  imports: [BymaxLoggerModule.forRoot({ service: { name: 'request-id-e2e', version: '1.0.0' } })],
  controllers: [ContextController]
})
class ContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applyRequestIdMiddleware(consumer)
  }
}

describe('Logger E2E — the request id middleware, mounted through the module', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ContextModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('generates a request id, exposes it, and propagates it into the handler', async () => {
    const res = await request(app.getHttpServer()).get('/ctx').expect(200)

    const header = res.headers['x-request-id']
    expect(header).toMatch(UUID_V4)
    expect(res.body.requestId).toBe(header)
  })

  it('echoes and propagates an inbound x-request-id', async () => {
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-request-id', 'req-abc-123')
      .expect(200)

    expect(res.headers['x-request-id']).toBe('req-abc-123')
    expect(res.body.requestId).toBe('req-abc-123')
  })

  it('propagates the tenant id from the x-tenant-id header, and omits it when absent', async () => {
    const withTenant = await request(app.getHttpServer())
      .get('/ctx')
      .set('x-tenant-id', 'tenant-42')
      .expect(200)
    const without = await request(app.getHttpServer()).get('/ctx').expect(200)

    expect(withTenant.body.tenantId).toBe('tenant-42')
    expect(without.body.tenantId).toBeUndefined()
  })
})
