/**
 * Pins how `HttpExceptionFilter` answers an error that is not an `HttpException` but carries an
 * `http-errors` shape (`status` or `statusCode` in 400-499 and `expose: true`), which is what the
 * body parser raises for a body over the limit (413) or an unsupported content encoding (415). The
 * client error keeps its status; every other non-`HttpException` stays a 500.
 *
 * Layer: server/filters, tests.
 */
import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { BymaxLoggerModule } from '../logger.module'
import { PinoLoggerService } from '../services/pino-logger.service'

/** An error shaped like the ones the `http-errors` package builds. */
function httpError(fields: Record<string, unknown>, message = 'refused'): Error {
  return Object.assign(new Error(message), fields)
}

@Controller()
class ThrowingController {
  @Get('shape/:name')
  shape(@Param('name') name: string): never {
    const shapes: Record<string, Error> = {
      status: httpError({ status: 413, expose: true }, 'request entity too large'),
      'status-code': httpError({ statusCode: 415, expose: true }, 'unsupported content encoding'),
      'bad-request': httpError({ status: 400, expose: true }, 'bad request'),
      hidden: httpError({ status: 413, expose: false }, 'internal detail'),
      server: httpError({ status: 503, expose: true }, 'unavailable'),
      low: httpError({ status: 399, expose: true }),
      high: httpError({ status: 600, expose: true }),
      fraction: httpError({ status: 413.5, expose: true }),
      text: httpError({ status: '413', expose: true }),
      'no-expose': httpError({ status: 413 })
    }
    throw shapes[name]
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body
  }
}

describe('HttpExceptionFilter, a client error that is not an HttpException', () => {
  let app: INestApplication
  let warnSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'filter-client', version: '1.0.0' },
          http: { isEnabled: true, shouldCaptureExceptions: true }
        })
      ],
      controllers: [ThrowingController]
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
  })

  beforeEach(() => {
    const logger = app.get(PinoLoggerService)
    warnSpy = jest.spyOn(logger, 'warnStructured').mockImplementation()
    errorSpy = jest.spyOn(logger, 'errorStructured').mockImplementation()
  })

  afterAll(async () => {
    await app.close()
  })

  it.each([
    ['status', 413, 'request entity too large'],
    ['status-code', 415, 'unsupported content encoding'],
    ['bad-request', 400, 'bad request']
  ])('keeps the %s of an exposed client error', async (name, status, message) => {
    const res = await request(app.getHttpServer()).get(`/shape/${name}`)

    expect(res.status).toBe(status)
    expect(res.body).toEqual({ statusCode: status, message })
    expect(warnSpy).toHaveBeenCalledWith(
      'HTTP_EXCEPTION_HANDLED',
      message,
      undefined,
      expect.objectContaining({ status, method: 'GET' })
    )
    expect(warnSpy).toHaveBeenCalledWith(
      'HTTP_REQUEST_CLIENT_ERROR',
      expect.stringContaining(`→ ${status}`),
      undefined,
      expect.objectContaining({ statusCode: status })
    )
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it.each(['hidden', 'server', 'low', 'high', 'fraction', 'text', 'no-expose'])(
    'stays an unhandled 500 for the %s shape',
    async (name) => {
      const res = await request(app.getHttpServer()).get(`/shape/${name}`)

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' })
      expect(errorSpy).toHaveBeenCalledWith(
        'HTTP_EXCEPTION_UNHANDLED',
        expect.anything(),
        undefined,
        expect.objectContaining({ status: 500 })
      )
    }
  )

  it.each([
    ['a body over the limit', {}, JSON.stringify({ a: 'x'.repeat(200_000) }), 413],
    ['an unsupported content encoding', { 'content-encoding': 'unknown' }, '{"a":1}', 415],
    ['truncated JSON', {}, '{"a":', 400]
  ])('answers %s from the real body parser with its status', async (_name, headers, body, code) => {
    const res = await request(app.getHttpServer())
      .post('/echo')
      .set('content-type', 'application/json')
      .set(headers)
      .send(body)

    expect(res.status).toBe(code)
    expect(res.body.statusCode).toBe(code)
  })
})
