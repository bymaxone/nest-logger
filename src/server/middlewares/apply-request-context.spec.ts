/**
 * Pins `applyRequestContext`: the correlation scope runs ahead of the body parser, a second mount
 * reuses it, and calling it without the module imported fails with a clear message.
 *
 * Layer: server/middlewares, tests.
 */
import { Controller, Module, Post } from '@nestjs/common'
import type {
  ArgumentsHost,
  INestApplication,
  MiddlewareConsumer,
  NestModule
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { applyRequestContext } from './apply-request-context'
import { applyRequestIdMiddleware } from './apply-request-id-middleware'
import { BymaxLoggerModule } from '../logger.module'
import { LogContextService } from '../services/log-context.service'

@Controller()
class EchoController {
  @Post('echo')
  echo(): { ok: boolean } {
    return { ok: true }
  }
}

@Module({
  imports: [BymaxLoggerModule.forRoot({ service: { name: 'app', version: '1.0.0' } })],
  controllers: [EchoController]
})
class PlainModule {}

@Module({
  imports: [BymaxLoggerModule.forRoot({ service: { name: 'app', version: '1.0.0' } })],
  controllers: [EchoController]
})
class ModuleWithMiddleware implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applyRequestIdMiddleware(consumer)
  }
}

/** Answers every error with the request id read from the log context. */
function envelopeFilter(logContext: LogContextService): {
  catch(exception: { getStatus(): number }, host: ArgumentsHost): void
} {
  return {
    catch(exception, host): void {
      host
        .switchToHttp()
        .getResponse()
        .status(exception.getStatus())
        .json({ correlationId: logContext.get('requestId') ?? null })
    }
  }
}

async function create(module: new () => unknown, mount: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [module] }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  if (mount) applyRequestContext(app)
  app.useGlobalFilters(envelopeFilter(app.get(LogContextService)))
  await app.init()
  return app
}

const refuse = (app: INestApplication): request.Test =>
  request(app.getHttpServer()).post('/echo').set('content-type', 'application/json').send('{"a":')

describe('applyRequestContext', () => {
  it('opens the scope ahead of the body parser, so a refused body has its request id', async () => {
    const app = await create(PlainModule, true)

    const res = await refuse(app)

    expect(res.status).toBe(400)
    expect(res.body.correlationId).toBe(res.headers['x-request-id'])
    await app.close()
  })

  it('is reused by a module-level mount, which mints no second id', async () => {
    const app = await create(ModuleWithMiddleware, true)

    const res = await request(app.getHttpServer())
      .post('/echo')
      .set('content-type', 'application/json')
      .set('x-request-id', 'caller-id-1')
      .send('{"a":1}')

    expect(res.headers['x-request-id']).toBe('caller-id-1')
    await app.close()
  })

  it('leaves a refused body without an id when it is not called', async () => {
    const app = await create(PlainModule, false)

    const res = await refuse(app)

    expect(res.body.correlationId).toBeNull()
    await app.close()
  })

  it('throws a clear error, with the DI failure as the cause, when the module is not imported', async () => {
    const moduleRef = await Test.createTestingModule({}).compile()
    const app = moduleRef.createNestApplication({ logger: false })

    expect(() => applyRequestContext(app)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('useRequestContext(app) called but BymaxLoggerModule'),
        cause: expect.any(Error)
      })
    )
    await app.close()
  })
})
