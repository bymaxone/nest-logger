/**
 * Pins which exception filter answers an error the body parser raised, because the README tells a
 * consumer how to register the filter that writes the request id into its envelope. With
 * `http.isEnabled` the library registers its own exception filter as an `APP_FILTER` provider; a
 * filter registered with `useGlobalFilters` answers instead of it, and an `APP_FILTER` provider of
 * the consumer, with or without an injected dependency, is answered by the library's filter. Without
 * `http.isEnabled` the library registers none and the consumer's `APP_FILTER` answers.
 *
 * Layer: e2e tests (boots the module through `@nestjs/testing`).
 */
import { ArgumentsHost, Catch, Controller, Inject, Module, Post } from '@nestjs/common'
import type { ExceptionFilter, INestApplication, Type } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, LogContextService } from '@bymax-one/nest-logger'
import request from 'supertest'
import { listeningServer } from './support/listening-server'

/** Writes the status and a marker, with no dependency. */
@Catch()
class PlainFilter implements ExceptionFilter {
  catch(exception: { getStatus?: () => number; status?: number }, host: ArgumentsHost): void {
    const status = exception.getStatus?.() ?? exception.status ?? 500
    host.switchToHttp().getResponse().status(status).json({ answeredBy: 'consumer' })
  }
}

/** Writes the id from the log context, so it injects `LogContextService`. */
@Catch()
class EnvelopeFilter implements ExceptionFilter {
  constructor(@Inject(LogContextService) private readonly logContext: LogContextService) {}

  catch(exception: { getStatus?: () => number; status?: number }, host: ArgumentsHost): void {
    const status = exception.getStatus?.() ?? exception.status ?? 500
    host
      .switchToHttp()
      .getResponse()
      .status(status)
      .json({ answeredBy: 'consumer', correlationId: this.logContext.get('requestId') ?? null })
  }
}

@Controller()
class EchoController {
  @Post('echo')
  echo(): { ok: boolean } {
    return { ok: true }
  }
}

async function bootstrap(
  appFilter: Type<ExceptionFilter> | undefined,
  global: boolean,
  isHttpEnabled = true
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-filters', version: '0.0.0' },
        http: { isEnabled: isHttpEnabled }
      })
    ],
    controllers: [EchoController],
    providers: appFilter === undefined ? [] : [{ provide: APP_FILTER, useClass: appFilter }]
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  BymaxLoggerModule.useRequestContext(app)
  if (global) app.useGlobalFilters(new EnvelopeFilter(app.get(LogContextService)))
  await app.init()
  return app
}

async function refuse(app: INestApplication): Promise<request.Response> {
  return request(await listeningServer(app))
    .post('/echo')
    .set('content-type', 'application/json')
    .send('{"a":')
}

describe('Logger E2E — the filter that answers a parser error', () => {
  beforeEach(() => {
    jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it('is a filter registered with useGlobalFilters, which reads the request id', async () => {
    const app = await bootstrap(undefined, true)

    const res = await refuse(app)

    expect(res.body.answeredBy).toBe('consumer')
    expect(res.body.correlationId).toBe(res.headers['x-request-id'])
    await app.close()
  })

  it('is a dependency-free APP_FILTER provider when the library registers no filter', async () => {
    const app = await bootstrap(PlainFilter, false, false)

    const res = await refuse(app)

    expect(res.body).toEqual({ answeredBy: 'consumer' })
    await app.close()
  })

  it.each([
    ['a dependency-free', PlainFilter],
    ['one that injects LogContextService', EnvelopeFilter]
  ])("is the library's own filter when an APP_FILTER provider is %s", async (_name, filter) => {
    const app = await bootstrap(filter, false)

    const res = await refuse(app)

    expect(res.status).toBe(400)
    expect(res.body.answeredBy).toBeUndefined()
    expect(res.body.statusCode).toBe(400)
    await app.close()
  })

  describe('by the order the modules are imported', () => {
    const logger = (): ReturnType<typeof BymaxLoggerModule.forRoot> =>
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-order', version: '0.0.0' },
        http: { isEnabled: true }
      })

    @Module({ providers: [{ provide: APP_FILTER, useClass: PlainFilter }] })
    class FilterModule {}

    async function mount(imports: unknown[]): Promise<INestApplication> {
      const moduleRef = await Test.createTestingModule({
        imports: imports as never[],
        controllers: [EchoController]
      }).compile()
      const app = moduleRef.createNestApplication({ logger: false })
      BymaxLoggerModule.useRequestContext(app)
      await app.init()
      return app
    }

    it("is the library's filter for an APP_FILTER module imported before the logger", async () => {
      const app = await mount([FilterModule, logger()])

      const res = await refuse(app)

      expect(res.body.answeredBy).toBeUndefined()
      await app.close()
    })

    it('is the consumer filter for an APP_FILTER module imported after the logger', async () => {
      const app = await mount([logger(), FilterModule])

      const res = await refuse(app)

      expect(res.body).toEqual({ answeredBy: 'consumer' })
      await app.close()
    })
  })
})
