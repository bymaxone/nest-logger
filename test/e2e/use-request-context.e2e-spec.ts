/**
 * Pins that `BymaxLoggerModule.useRequestContext(app)` opens the correlation scope ahead of the
 * body parser, so a request the parser refuses still has its `requestId` where a consumer's
 * exception filter reads it. Without the call the module middleware sits behind the parser and a
 * refused body is answered outside any scope.
 *
 * Layer: end-to-end tests (boots the module through `@nestjs/testing`).
 */
import { ArgumentsHost, Catch, Controller, Post } from '@nestjs/common'
import type { ExceptionFilter, INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, LogContextService } from '@bymax-one/nest-logger'
import request from 'supertest'

/**
 * A consumer's catch-all filter: the envelope carries the id from the log context. It is installed
 * with `useGlobalFilters`; `use-request-context-filters.e2e-spec.ts` pins why.
 */
@Catch()
class EnvelopeFilter implements ExceptionFilter {
  constructor(private readonly logContext: LogContextService) {}

  catch(exception: { getStatus?: () => number; status?: number }, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse()
    const status = exception.getStatus?.() ?? exception.status ?? 500
    res.status(status).json({ correlationId: this.logContext.get('requestId') ?? null })
  }
}

@Controller()
class EchoController {
  @Post('echo')
  echo(): { ok: boolean } {
    return { ok: true }
  }
}

async function bootstrap(mountEarly: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({
        service: { name: 'e2e-ctx', version: '0.0.0' },
        http: { isEnabled: true }
      })
    ],
    controllers: [EchoController]
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  if (mountEarly) BymaxLoggerModule.useRequestContext(app)
  app.useGlobalFilters(new EnvelopeFilter(app.get(LogContextService)))
  await app.init()
  return app
}

describe('Logger E2E — useRequestContext', () => {
  let stdoutSpy: jest.SpyInstance

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  it.each([
    ['truncated JSON', {}, '{"a":', 400],
    ['an unsupported content encoding', { 'content-encoding': 'unknown' }, '{"a":1}', 415],
    ['a body over the limit', {}, JSON.stringify({ a: 'x'.repeat(200_000) }), 413]
  ])(
    'answers %s with the request id of the response header',
    async (_name, headers, body, code) => {
      const app = await bootstrap(true)

      const res = await request(app.getHttpServer())
        .post('/echo')
        .set('content-type', 'application/json')
        .set(headers)
        .send(body)

      expect(res.status).toBe(code)
      expect(res.headers['x-request-id']).toEqual(expect.any(String))
      expect(res.body.correlationId).toBe(res.headers['x-request-id'])
      await app.close()
    }
  )

  it('answers a refused body with no id when the helper is not called', async () => {
    const app = await bootstrap(false)

    const res = await request(app.getHttpServer())
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{"a":')

    expect(res.body.correlationId).toBeNull()
    await app.close()
  })

  it('throws a clear error when the module was not imported', async () => {
    const moduleRef = await Test.createTestingModule({}).compile()
    const app = moduleRef.createNestApplication({ logger: false })

    expect(() => BymaxLoggerModule.useRequestContext(app)).toThrow(/not imported/)
    await app.close()
  })
})
