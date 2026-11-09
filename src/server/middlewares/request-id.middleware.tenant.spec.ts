/**
 * Pins where the tenant id of a request comes from. By default it is the value of the
 * `x-tenant-id` header, which the client chose; a host that knows better turns the header off
 * (`http.tenantIdHeader: false`) or supplies `http.tenantIdResolver`, which is then the only
 * source, so a client cannot attribute its requests to another tenant by sending the header.
 *
 * Layer: server, middlewares, tests.
 */
import { Controller, Get, Inject, Module } from '@nestjs/common'
import type { INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { applyRequestIdMiddleware } from './apply-request-id-middleware'
import type { LoggableRequest } from '../interfaces/http-context.interface'
import type { HttpOptions } from '../interfaces/logger-module-options.interface'
import { BymaxLoggerModule } from '../logger.module'
import { LogContextService } from '../services/log-context.service'

@Controller()
class TenantController {
  constructor(@Inject(LogContextService) private readonly logContext: LogContextService) {}

  @Get('tenant')
  tenant(): { tenantId: unknown } {
    return { tenantId: this.logContext.get('tenantId') }
  }
}

/** Boots an app whose middleware reads the tenant the way `http` says; an earlier middleware plays auth. */
async function boot(http: HttpOptions): Promise<INestApplication> {
  @Module({
    imports: [
      BymaxLoggerModule.forRoot({ service: { name: 'tenant-test', version: '1.0.0' }, http })
    ],
    controllers: [TenantController]
  })
  class TenantModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer
        .apply((req: { authenticatedTenant?: string }, _res: unknown, next: () => void) => {
          req.authenticatedTenant = 'tenant-from-auth'
          next()
        })
        .forRoutes('*')
      applyRequestIdMiddleware(consumer)
    }
  }
  const moduleRef = await Test.createTestingModule({ imports: [TenantModule] }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  return app
}

const fromAuth = (req: LoggableRequest): string | undefined =>
  (req as unknown as { authenticatedTenant?: string }).authenticatedTenant

describe.each([
  ['the default header', {}, 'x-tenant-id', 'tenant-42'],
  ['a header of its own name', { tenantIdHeader: 'x-org-id' }, 'x-org-id', 'org-7']
])('the tenant id read from %s', (_name, http, header, value) => {
  it('is the value the client sent', async () => {
    const app = await boot(http)
    const res = await request(app.getHttpServer()).get('/tenant').set(header, value).expect(200)
    await app.close()

    expect(res.body.tenantId).toBe(value)
  })
})

describe('http.tenantIdHeader: false', () => {
  it('reads no header, whatever the client sends', async () => {
    const app = await boot({ tenantIdHeader: false })
    const res = await request(app.getHttpServer())
      .get('/tenant')
      .set('x-tenant-id', 'someone-elses')
      .expect(200)
    await app.close()

    expect(res.body.tenantId).toBeUndefined()
  })
})

describe('http.tenantIdResolver', () => {
  it('wins over the header, which the client cannot use to override it', async () => {
    const app = await boot({ tenantIdResolver: fromAuth })
    const res = await request(app.getHttpServer())
      .get('/tenant')
      .set('x-tenant-id', 'someone-elses')
      .expect(200)
    await app.close()

    expect(res.body.tenantId).toBe('tenant-from-auth')
  })

  it('leaves the header unread when it answers nothing', async () => {
    const app = await boot({ tenantIdResolver: () => undefined })
    const res = await request(app.getHttpServer())
      .get('/tenant')
      .set('x-tenant-id', 'someone-elses')
      .expect(200)
    await app.close()

    expect(res.body.tenantId).toBeUndefined()
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
  ])('gives no tenant id, and the request still succeeds, when it %s', async (_name, resolver) => {
    const app = await boot({ tenantIdResolver: resolver, tenantIdHeader: 'x-tenant-id' })
    const res = await request(app.getHttpServer())
      .get('/tenant')
      .set('x-tenant-id', 'someone-elses')
      .expect(200)
    await app.close()

    expect(res.body.tenantId).toBeUndefined()
  })

  it('is called with the request', async () => {
    const seen: string[] = []
    const app = await boot({
      tenantIdResolver: (req) => {
        seen.push(req.method)
        return undefined
      }
    })
    await request(app.getHttpServer()).get('/tenant').expect(200)
    await app.close()

    expect(seen).toEqual(['GET'])
  })
})
