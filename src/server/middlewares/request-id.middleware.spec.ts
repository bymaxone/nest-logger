import { Controller, Get, Module } from '@nestjs/common'
import type { INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { applyRequestIdMiddleware } from './apply-request-id-middleware'
import { BymaxLoggerModule } from '../logger.module'
import { LogContextService } from '../services/log-context.service'

/** UUID v4 shape used to assert a generated correlation id. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Exposes the propagated context so tests can prove the scope started pre-handler. */
@Controller()
class ContextController {
  constructor(private readonly logContext: LogContextService) {}

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
})
