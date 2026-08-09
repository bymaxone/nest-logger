import { BadRequestException, Controller, Get, InternalServerErrorException } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'

import { BymaxLoggerModule } from '../logger.module'
import { PinoLoggerService } from '../services/pino-logger.service'

/**
 * Fixture controller throwing the exception shapes the filter must distinguish:
 * a 4xx HttpException, a 5xx HttpException, a generic Error, and a generic Error
 * on a route carrying an authenticated user.
 */
@Controller()
class FilterFixtureController {
  @Get('bad')
  bad(): never {
    throw new BadRequestException('bad input')
  }

  @Get('server-http')
  serverHttp(): never {
    throw new InternalServerErrorException('explicit 500')
  }

  @Get('boom')
  boom(): never {
    throw new Error('kaboom')
  }

  @Get('me-boom')
  meBoom(): never {
    throw new Error('user boom')
  }

  @Get('me-boom-jwt')
  meBoomJwt(): never {
    throw new Error('user boom')
  }

  @Get('me-boom-both')
  meBoomBoth(): never {
    throw new Error('user boom')
  }
}

describe('HttpExceptionFilter (integration)', () => {
  let app: INestApplication
  let logger: PinoLoggerService
  let warnSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'filter-test', version: '1.0.0' },
          http: { isEnabled: true, shouldCaptureExceptions: true }
        })
      ],
      controllers: [FilterFixtureController]
    }).compile()

    app = moduleRef.createNestApplication({ logger: false })
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.url.startsWith('/me-boom-both')) {
        // Both fields present: the JWT subject must win over the ORM id.
        ;(req as Request & { user?: { sub?: string; id?: string } }).user = {
          sub: 's_2',
          id: 'u_2'
        }
      } else if (req.url.startsWith('/me-boom-jwt')) {
        // A JWT principal names its subject `sub`, not `id`.
        ;(req as Request & { user?: { sub?: string } }).user = { sub: 's_1' }
      } else if (req.url.startsWith('/me-boom')) {
        ;(req as Request & { user?: { id?: string } }).user = { id: 'u_1' }
      }
      next()
    })
    await app.init()
    logger = app.get(PinoLoggerService)
  })

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warnStructured').mockImplementation()
    errorSpy = jest.spyOn(logger, 'errorStructured').mockImplementation()
  })

  afterAll(async () => {
    await app.close()
  })

  it(/*
   * A 4xx HttpException must log HTTP_EXCEPTION_HANDLED at warn level and the
   * response must echo the exception's own status and body.
   */
  'logs HTTP_EXCEPTION_HANDLED (warn) and renders a 4xx', async () => {
    const res = await request(app.getHttpServer()).get('/bad').expect(400)

    expect(res.body).toMatchObject({ statusCode: 400, message: 'bad input' })
    expect(warnSpy).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_HANDLED',
      expect.any(String),
      undefined,
      expect.objectContaining({ status: 400, method: 'GET' })
    )
  })

  it(/*
   * A 5xx HttpException must log HTTP_EXCEPTION_UNHANDLED at error level (with a
   * sanitized error) and render the exception's status/body.
   */
  'logs HTTP_EXCEPTION_UNHANDLED (error) for a 5xx HttpException', async () => {
    await request(app.getHttpServer()).get('/server-http').expect(500)

    expect(errorSpy).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_UNHANDLED',
      expect.objectContaining({ name: expect.any(String), message: expect.any(String) }),
      undefined,
      expect.objectContaining({ status: 500 })
    )
  })

  it(/*
   * For an HttpException the response must echo the exception's own status code
   * and serialized body (not the generic internal-error body) — proves
   * res.status().json() is driven by the exception, not hardcoded.
   */
  'renders the HttpException own status and body', async () => {
    const res = await request(app.getHttpServer()).get('/server-http').expect(500)

    expect(res.body).toMatchObject({ statusCode: 500, message: 'explicit 500' })
  })

  it(/*
   * A non-HttpException must be treated as an unhandled 500: logged as
   * HTTP_EXCEPTION_UNHANDLED and rendered with the generic internal-error body.
   */
  'treats a generic Error as an unhandled 500', async () => {
    const res = await request(app.getHttpServer()).get('/boom').expect(500)

    expect(res.body).toMatchObject({ statusCode: 500, message: 'Internal server error' })
    expect(errorSpy).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_UNHANDLED',
      expect.objectContaining({ name: expect.any(String) }),
      undefined,
      expect.objectContaining({ status: 500 })
    )
  })

  it(/*
   * When req.user is present the acting userId must be attached to the exception
   * log — covers the populated `req.user?.id` path in the filter.
   */
  'attaches userId from req.user when present', async () => {
    await request(app.getHttpServer()).get('/me-boom').expect(500)

    expect(errorSpy).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_UNHANDLED',
      expect.objectContaining({ name: expect.any(String) }),
      'u_1',
      expect.objectContaining({ status: 500 })
    )
  })

  it(/*
   * A JWT principal names its subject `sub`, not `id`. The acting userId must
   * still be attached to the exception log — covers the `req.user?.id` fallback
   * of `sub ?? id` that every nest-auth token relies on.
   */
  'attaches userId from req.user.sub when id is absent (JWT principal)', async () => {
    await request(app.getHttpServer()).get('/me-boom-jwt').expect(500)

    expect(errorSpy).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_UNHANDLED',
      expect.objectContaining({ name: expect.any(String) }),
      's_1',
      expect.objectContaining({ status: 500 })
    )
  })

  it(/*
   * When a principal carries both `sub` and `id`, the JWT subject is the
   * authenticated identity and must win — pins the `sub ?? id` precedence
   * (an `id ?? sub` swap would attribute the error to the ORM id instead).
   */
  'attaches req.user.sub over req.user.id when both are present', async () => {
    await request(app.getHttpServer()).get('/me-boom-both').expect(500)

    expect(errorSpy).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_UNHANDLED',
      expect.objectContaining({ name: expect.any(String) }),
      's_2',
      expect.objectContaining({ status: 500 })
    )
  })

  it(/*
   * The logged `url` must have its query string stripped: query params routinely
   * carry secrets (reset tokens, OAuth codes) and cannot be redacted as a
   * substring once embedded in the URL. The secret must never reach the log.
   */
  'strips the query string from the logged url', async () => {
    await request(app.getHttpServer()).get('/boom?token=supersecret&x=1').expect(500)

    const metadata = errorSpy.mock.calls.at(-1)?.[3] as Record<string, unknown>
    expect(metadata).toMatchObject({ url: '/boom' })
    expect(JSON.stringify(metadata)).not.toContain('supersecret')
  })
})
