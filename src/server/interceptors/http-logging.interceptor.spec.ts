import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  InternalServerErrorException,
  Param
} from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'

import { BymaxLoggerModule } from '../logger.module'
import { PinoLoggerService } from '../services/pino-logger.service'

/**
 * Fixture controller exercising every interceptor branch through real HTTP:
 * 2xx / 3xx / non-2xx-3xx success, 4xx and 5xx HttpExceptions, a plain Error,
 * and a non-Error throw.
 */
@Controller()
class FixtureController {
  @Get('ok/:id')
  ok(@Param('id') id: string): { id: string } {
    return { id }
  }

  @Get('redirect')
  @HttpCode(302)
  redirect(): { ok: boolean } {
    return { ok: true }
  }

  @Get('teapot')
  @HttpCode(418)
  teapot(): { ok: boolean } {
    return { ok: true }
  }

  @Get('bad')
  bad(): never {
    throw new BadRequestException('bad input')
  }

  @Get('boom')
  boom(): never {
    throw new Error('kaboom')
  }

  @Get('server-http')
  serverHttp(): never {
    throw new InternalServerErrorException('explicit 500')
  }

  @Get('throw-string')
  throwString(): never {
    // Throwing a non-Error value exercises the `err instanceof Error` false path.
    throw 'plain string failure'
  }

  @Get('me')
  me(): { ok: boolean } {
    return { ok: true }
  }
}

describe('HttpLoggingInterceptor (integration)', () => {
  let app: INestApplication
  let logger: PinoLoggerService
  let infoSpy: jest.SpyInstance
  let warnSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'interceptor-test', version: '1.0.0' },
          // Filter disabled so the interceptor is tested in isolation; thrown
          // exceptions fall through to Nest's default handler.
          http: { isEnabled: true, shouldCaptureExceptions: false }
        })
      ],
      controllers: [FixtureController]
    }).compile()

    // `logger: false` silences Nest's internal logger so the deliberate 5xx
    // tests do not print exception stacks to the suite output.
    app = moduleRef.createNestApplication({ logger: false })
    // Simulate an upstream auth layer populating req.user for one route.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.url.startsWith('/me')) {
        ;(req as Request & { user?: { id?: string } }).user = { id: 'u_1' }
      }
      next()
    })
    await app.init()
    logger = app.get(PinoLoggerService)
  })

  beforeEach(() => {
    // Spies are (re)created here because `restoreMocks: true` resets them between
    // tests; mockImplementation keeps the suite output silent.
    infoSpy = jest.spyOn(logger, 'info').mockImplementation()
    warnSpy = jest.spyOn(logger, 'warnStructured').mockImplementation()
    errorSpy = jest.spyOn(logger, 'errorStructured').mockImplementation()
  })

  afterAll(async () => {
    await app.close()
  })

  it(/*
   * A 2xx response must emit START then SUCCESS, and the high-cardinality id in
   * the path must be normalized to `/:id` in both entries.
   */
  'logs START and SUCCESS with a normalized URL for a 2xx response', async () => {
    await request(app.getHttpServer())
      .get('/ok/123e4567-e89b-12d3-a456-426614174000')
      .set('User-Agent', 'jest-agent/9.9')
      .expect(200)

    expect(infoSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_START',
      expect.any(String),
      undefined,
      // A provided User-Agent must be captured verbatim (covers the string branch).
      expect.objectContaining({ method: 'GET', url: '/ok/:id', userAgent: 'jest-agent/9.9' })
    )
    expect(infoSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_SUCCESS',
      expect.any(String),
      undefined,
      expect.objectContaining({ statusCode: 200, url: '/ok/:id' })
    )
  })

  it(/*
   * A 3xx response must emit REDIRECT (not SUCCESS) — covers the redirect branch
   * of the success logger.
   */
  'logs REDIRECT for a 3xx response', async () => {
    await request(app.getHttpServer()).get('/redirect').expect(302)

    expect(infoSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_REDIRECT',
      expect.any(String),
      undefined,
      expect.objectContaining({ statusCode: 302 })
    )
  })

  it(/*
   * A non-throwing response outside 2xx/3xx (a 418) must emit only START — covers
   * the "neither success nor redirect" fall-through with no terminal log.
   */
  'logs only START for a non-2xx/3xx non-throwing response', async () => {
    await request(app.getHttpServer()).get('/teapot').expect(418)

    expect(infoSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_START',
      expect.any(String),
      undefined,
      expect.objectContaining({ url: '/teapot' })
    )
    const terminalKeys = infoSpy.mock.calls.map((call) => call[0])
    expect(terminalKeys).not.toContain('HTTP_REQUEST_SUCCESS')
    expect(terminalKeys).not.toContain('HTTP_REQUEST_REDIRECT')
  })

  it(/*
   * A 4xx HttpException must emit CLIENT_ERROR at warn level (with the error
   * message) and the exception must still propagate to a 400 response.
   */
  'logs CLIENT_ERROR (warn) for a 4xx and propagates it', async () => {
    await request(app.getHttpServer()).get('/bad').expect(400)

    expect(warnSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_CLIENT_ERROR',
      expect.any(String),
      undefined,
      expect.objectContaining({ statusCode: 400, errorMessage: 'bad input' })
    )
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it(/*
   * A plain Error must emit SERVER_ERROR (error level, with the Error) and
   * propagate as a 500 — the exception is logged, never swallowed.
   */
  'logs SERVER_ERROR for a thrown Error and propagates it', async () => {
    await request(app.getHttpServer()).get('/boom').expect(500)

    expect(errorSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_SERVER_ERROR',
      expect.any(Error),
      undefined,
      expect.objectContaining({ statusCode: 500 })
    )
  })

  it(/*
   * A 5xx HttpException must also map to SERVER_ERROR — covers the HttpException
   * branch at/above 500.
   */
  'logs SERVER_ERROR for a 5xx HttpException', async () => {
    await request(app.getHttpServer()).get('/server-http').expect(500)

    expect(errorSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_SERVER_ERROR',
      expect.any(Error),
      undefined,
      expect.objectContaining({ statusCode: 500 })
    )
  })

  it(/*
   * A non-Error throw must be wrapped into an Error for the SERVER_ERROR log —
   * covers the `err instanceof Error` false branch — and still return 500.
   */
  'wraps a non-Error throw into an Error for SERVER_ERROR', async () => {
    await request(app.getHttpServer()).get('/throw-string').expect(500)

    expect(errorSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_SERVER_ERROR',
      expect.any(Error),
      undefined,
      expect.objectContaining({ statusCode: 500 })
    )
  })

  it(/*
   * When upstream auth populated req.user, the acting userId must flow into the
   * log entries — covers the `req.user?.id` populated path.
   */
  'extracts userId from req.user when present', async () => {
    await request(app.getHttpServer()).get('/me').expect(200)

    expect(infoSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_START',
      expect.any(String),
      'u_1',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it(/*
   * A missing User-Agent header must fall back to 'unknown' — covers the
   * non-string branch of the user-agent read.
   */
  'falls back to "unknown" when the User-Agent header is absent', async () => {
    await request(app.getHttpServer()).get('/teapot').unset('User-Agent').expect(418)

    expect(infoSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_START',
      expect.any(String),
      undefined,
      expect.objectContaining({ userAgent: 'unknown' })
    )
  })
})
