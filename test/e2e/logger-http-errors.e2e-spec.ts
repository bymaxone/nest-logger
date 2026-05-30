import { BadRequestException, Controller, Get, HttpCode, NotFoundException } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'
import request from 'supertest'

import { parseLogEntries } from './fixtures/parse-log-entries'

/** Routes covering the 4xx (thrown) and 3xx (redirect) lifecycle branches. */
@Controller()
class ErrorController {
  /** Throws a 400 — drives HTTP_REQUEST_CLIENT_ERROR + HTTP_EXCEPTION_HANDLED. */
  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException('bad input')
  }

  /** Throws a 404 inside a real handler so the interceptor + filter both run. */
  @Get('not-found')
  notFound(): never {
    throw new NotFoundException('missing')
  }

  /** Returns a 3xx status — drives HTTP_REQUEST_REDIRECT on the success path. */
  @Get('moved')
  @HttpCode(301)
  moved(): { ok: boolean } {
    return { ok: true }
  }
}

describe('Logger E2E — HTTP error and redirect lifecycle', () => {
  let app: INestApplication
  let stdoutSpy: jest.SpyInstance

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BymaxLoggerModule.forRoot({
          service: { name: 'e2e-http-errors', version: '0.0.0' },
          http: { isEnabled: true }
        })
      ],
      controllers: [ErrorController]
    }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  // Installed per-test (the suite config restores mocks between tests).
  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it(/*
   * A thrown 400 must produce the access-log START plus BOTH warn-level error
   * entries: HTTP_REQUEST_CLIENT_ERROR (interceptor) and HTTP_EXCEPTION_HANDLED
   * (filter) — and the client still receives a 400.
   */
  'logs CLIENT_ERROR and EXCEPTION_HANDLED for a thrown 400', async () => {
    await request(app.getHttpServer()).get('/bad-request').expect(400)

    const entries = parseLogEntries(stdoutSpy)
    expect(entries.map((entry) => entry['logKey'])).toContain('HTTP_REQUEST_START')

    const clientError = entries.find((entry) => entry['logKey'] === 'HTTP_REQUEST_CLIENT_ERROR')
    expect(clientError?.['level']).toBe('warn')
    expect(clientError?.['statusCode']).toBe(400)

    const handled = entries.find((entry) => entry['logKey'] === 'HTTP_EXCEPTION_HANDLED')
    expect(handled?.['level']).toBe('warn')
    expect(handled?.['status']).toBe(400)
  })

  it(/*
   * A 404 thrown from a real handler must carry the 404 status on the
   * interceptor's CLIENT_ERROR entry — not collapse to a generic error.
   */
  'tags the CLIENT_ERROR entry with the 404 status', async () => {
    await request(app.getHttpServer()).get('/not-found').expect(404)

    const clientError = parseLogEntries(stdoutSpy).find(
      (entry) => entry['logKey'] === 'HTTP_REQUEST_CLIENT_ERROR'
    )
    expect(clientError?.['statusCode']).toBe(404)
  })

  it(/*
   * A 3xx response must be logged as HTTP_REQUEST_REDIRECT at info level (the
   * non-throwing success branch), never as an error.
   */
  'logs REDIRECT for a 3xx response', async () => {
    await request(app.getHttpServer()).get('/moved').expect(301)

    const entries = parseLogEntries(stdoutSpy)
    const redirect = entries.find((entry) => entry['logKey'] === 'HTTP_REQUEST_REDIRECT')
    expect(redirect?.['level']).toBe('info')
    expect(redirect?.['statusCode']).toBe(301)
    expect(entries.map((entry) => entry['logKey'])).not.toContain('HTTP_REQUEST_SERVER_ERROR')
  })
})
