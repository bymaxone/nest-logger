/**
 * E2E: a credential carried in a path segment, through a real Nest application and real HTTP.
 *
 * A reset or verification link puts its token in the path (`/auth/reset/<hex>`), where the query
 * stripping cannot reach it and no key-name redaction can censor it, because it is the VALUE of a
 * string field (`fullUrl`, `url`) and free text (the not-found message). These cases read every
 * line the logger writes, with the module alone and with `applyAccessLog`, and with a global prefix.
 * The route shape stays, so a per-route dashboard still groups the requests.
 *
 * Layer: E2E, server (`HttpLoggingInterceptor`, `HttpAccessLogMiddleware`, `HttpExceptionFilter`).
 */
import { Controller, Get, Module, Param } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { applyAccessLog, BymaxLoggerModule } from '@bymax-one/nest-logger'
import request from 'supertest'

import { parseLogEntries } from './fixtures/parse-log-entries'

const HEX_TOKEN = 'a3f1c9d2b7e4086f5a1c3d9e7b2f4a6c8d0e1f3a5b7c9d2e4f6a8b0c1d3e5f7a'
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJzZWNyZXQiOiJKV1QtUEFZTE9BRCJ9.c2lnbmF0dXJlLXZhbHVlLWhlcmU'
const B64 = 'Zk9vQmFyQmF6UXV4MTIzNDU2Nzg5MGFiY2RlZkdISUo'
const EMAIL = 'someone.private@example.com'

@Controller()
class AuthController {
  @Get('auth/reset/:token')
  reset(@Param('token') token: string): { ok: boolean; echoed: string } {
    return { ok: true, echoed: token }
  }
}

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-path-segment-secrets', version: '0.0.0' },
      http: { isEnabled: true, shouldCaptureExceptions: true }
    })
  ],
  controllers: [AuthController]
})
class AppModule {}

describe.each([
  ['the module alone', false, undefined],
  ['applyAccessLog', true, undefined],
  ['a global prefix', false, 'api'],
  ['applyAccessLog and a global prefix', true, 'api']
])('Logger E2E — a secret in a path segment (%s)', (_name, accessLog, prefix) => {
  let app: INestApplication
  let stdout: jest.SpyInstance
  const base = prefix === undefined ? '' : `/${prefix}`
  const everything = (): string => stdout.mock.calls.map((call) => String(call[0])).join('')

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

  it.each([
    ['a 64-char hex token', HEX_TOKEN],
    ['a JWT', JWT],
    ['a base64url token', B64],
    ['an email address', EMAIL]
  ])('writes no line that carries %s from a routed path', async (_label, secret) => {
    const res = await request(app.getHttpServer()).get(`${base}/auth/reset/${secret}`)

    const entries = parseLogEntries(stdout)
    const start = entries.find((entry) => entry['logKey'] === 'HTTP_REQUEST_START')
    expect(res.status).toBe(200)
    expect(everything()).not.toContain(secret)
    expect(String(start?.['fullUrl'])).toBe(`${base}/auth/reset/:redacted`)
  })

  it.each([
    ['a 64-char hex token', HEX_TOKEN],
    ['a JWT', JWT]
  ])('writes no line that carries %s from a path that matched no route', async (_label, secret) => {
    const res = await request(app.getHttpServer()).get(`${base}/missing/${secret}`)

    const handled = parseLogEntries(stdout).find(
      (entry) => entry['logKey'] === 'HTTP_EXCEPTION_HANDLED'
    )
    expect(res.status).toBe(404)
    expect(everything()).not.toContain(secret)
    expect(String(handled?.['msg'])).toBe(`Cannot GET ${base}/missing/:redacted`)
  })

  it('keeps the route shape for an ordinary path', async () => {
    await request(app.getHttpServer()).get(`${base}/auth/reset/short-slug`)

    const start = parseLogEntries(stdout).find((entry) => entry['logKey'] === 'HTTP_REQUEST_START')
    expect(String(start?.['fullUrl'])).toBe(`${base}/auth/reset/short-slug`)
  })
})

@Controller()
class PayController {
  @Get('pay/:ref')
  pay(@Param('ref') ref: string): { ok: boolean; ref: string } {
    return { ok: true, ref }
  }
}

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-path-segment-secrets-own', version: '0.0.0' },
      http: { isEnabled: true, shouldCaptureExceptions: true, secretPathSegments: [/^tok_/] }
    })
  ],
  controllers: [PayController]
})
class OwnPatternModule {}

describe.each([
  ['the module alone', false],
  ['applyAccessLog', true]
])('Logger E2E — http.secretPathSegments (%s)', (_name, accessLog) => {
  let app: INestApplication
  let stdout: jest.SpyInstance

  beforeAll(async () => {
    app = await NestFactory.create(OwnPatternModule, { logger: false })
    if (accessLog) applyAccessLog(app)
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it('censors a segment the host pattern matches, in a routed path and in a not-found message', async () => {
    await request(app.getHttpServer()).get('/pay/tok_live_SECRET-REF')
    await request(app.getHttpServer()).get('/missing/tok_live_SECRET-REF')

    const lines = stdout.mock.calls.map((call) => String(call[0])).join('')
    expect(lines).not.toContain('SECRET-REF')
    expect(lines).toContain('/pay/:redacted')
    expect(lines).toContain('Cannot GET /missing/:redacted')
  })

  it('still writes a segment the pattern does not match', async () => {
    await request(app.getHttpServer()).get('/pay/plain-ref')

    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('/pay/plain-ref')
  })
})
