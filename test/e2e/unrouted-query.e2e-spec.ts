/**
 * E2E: the query string of a request that matched no route, through a real Nest application and
 * real HTTP.
 *
 * Nest words its not-found message as `Cannot GET <originalUrl>`, with the whole URL, so an OAuth
 * callback or a reset link that reaches a route that does not exist carries its `code`, `state` or
 * `token` in the message the logger writes. The `url` fields have their query stripped; a message
 * is free text, which name-based redaction cannot censor. These cases read every line the logger
 * writes, with and without a global prefix, with the module alone and with `applyAccessLog`. The
 * response is the application's concern and still carries what Nest wrote.
 *
 * Layer: E2E, server (`HttpExceptionFilter` and the access log).
 */
import { Controller, Get, Module } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { applyAccessLog, BymaxLoggerModule } from '@bymax-one/nest-logger'
import request from 'supertest'

import { parseLogEntries } from './fixtures/parse-log-entries'

const QUERY = '?code=SECRET-CODE&state=SECRET-STATE&token=SECRET-TOKEN&password=SECRET-PW'

@Controller()
class OkController {
  @Get('ok')
  ok(): { ok: boolean } {
    return { ok: true }
  }
}

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-unrouted-query', version: '0.0.0' },
      http: { isEnabled: true, shouldCaptureExceptions: true }
    })
  ],
  controllers: [OkController]
})
class AppModule {}

describe.each([
  ['the module alone', false, undefined],
  ['applyAccessLog', true, undefined],
  ['a global prefix', false, 'api'],
  ['applyAccessLog and a global prefix', true, 'api']
])('Logger E2E — the query of a request that matched no route (%s)', (_name, accessLog, prefix) => {
  let app: INestApplication
  let stdout: jest.SpyInstance
  const base = prefix === undefined ? '' : `/${prefix}`

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false })
    if (prefix !== undefined) app.setGlobalPrefix(prefix)
    if (accessLog) applyAccessLog(app)
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it('writes the not-found message without the query, and no line carries a secret', async () => {
    const res = await request(app.getHttpServer()).get(`${base}/missing${QUERY}`)

    const entries = parseLogEntries(stdout)
    const handled = entries.find((entry) => entry['logKey'] === 'HTTP_EXCEPTION_HANDLED')
    expect(res.status).toBe(404)
    expect(handled?.['msg']).toBe(`Cannot GET ${base}/missing`)
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).not.toContain('SECRET')
    expect(String(res.body.message)).toContain('SECRET-CODE')
  })

  it('cuts a percent-encoded query too, because Nest words the message with the raw bytes', async () => {
    await request(app.getHttpServer()).get(`${base}/missing?t=SECRET-A%20B%2FC%C3%A9&u=%3Cx%3E`)

    const entries = parseLogEntries(stdout)
    const handled = entries.find((entry) => entry['logKey'] === 'HTTP_EXCEPTION_HANDLED')
    expect(handled?.['msg']).toBe(`Cannot GET ${base}/missing`)
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).not.toContain('SECRET')
  })

  it('leaves the line of a routed request as it was', async () => {
    await request(app.getHttpServer()).get(`${base}/ok${QUERY}`).expect(200)

    const entries = parseLogEntries(stdout)
    const start = entries.find((entry) => entry['logKey'] === 'HTTP_REQUEST_START')
    expect(start?.['url']).toBe(`${base}/ok`)
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).not.toContain('SECRET')
  })
})
