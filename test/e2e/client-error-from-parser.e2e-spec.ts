/**
 * E2E: the client errors the real body parser raises, through a real Nest application and real HTTP.
 *
 * A body over the limit (413), an unsupported content encoding or charset (415) and a body that is
 * not JSON (400) reach `HttpExceptionFilter` as the parser's own errors. The filter keeps their
 * status; for the two 415 types it answers and logs a fixed text that echoes nothing the client
 * sent. The same decisions for each error shape are pinned with doubles in
 * `src/server/filters/http-exception.filter.client-errors.spec.ts`.
 *
 * Layer: E2E, server (`HttpExceptionFilter` and the body parser Nest mounts).
 */
import { Body, Controller, Module, Post } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule } from '@bymax-one/nest-logger'
import request from 'supertest'

import { parseLogEntries } from './fixtures/parse-log-entries'

@Controller()
class EchoController {
  @Post('echo')
  echo(@Body() _body: unknown): { ok: boolean } {
    return { ok: true }
  }
}

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-client-error', version: '0.0.0' },
      http: { isEnabled: true, shouldCaptureExceptions: true }
    })
  ],
  controllers: [EchoController]
})
class AppModule {}

describe('Logger E2E — a client error from the real body parser', () => {
  let app: INestApplication
  let stdout: jest.SpyInstance

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stdout.mockRestore()
  })

  it.each([
    ['a body over the limit', {}, JSON.stringify({ a: 'x'.repeat(200_000) }), 413],
    ['an unsupported content encoding', { 'content-encoding': 'unknown' }, '{"a":1}', 415],
    ['truncated JSON', {}, '{"a":', 400]
  ])('answers %s with its status', async (_name, headers, body, code) => {
    const res = await request(app.getHttpServer())
      .post('/echo')
      .set('content-type', 'application/json')
      .set(headers)
      .send(body)

    expect(res.status).toBe(code)
    expect(res.body.statusCode).toBe(code)
  })

  it.each([
    [
      'a content encoding',
      { 'content-type': 'application/json', 'content-encoding': 'x-CLIENT-MARKER' },
      'unsupported content encoding'
    ],
    [
      'a charset',
      { 'content-type': 'application/json; charset=CLIENT-MARKER' },
      'unsupported charset'
    ]
  ])(
    'echoes nothing of the client when it names %s the body parser does not support',
    async (_name, headers, message) => {
      const res = await request(app.getHttpServer()).post('/echo').set(headers).send('{"a":1}')

      expect(res.status).toBe(415)
      expect(res.body).toEqual({ statusCode: 415, message })
      const handled = parseLogEntries(stdout).find(
        (entry) => entry['logKey'] === 'HTTP_EXCEPTION_HANDLED'
      )
      expect(handled).toMatchObject({ msg: message, status: 415 })
      const written = stdout.mock.calls.map((call) => String(call[0])).join('')
      expect(JSON.stringify([res.body, written])).not.toMatch(/marker/i)
    }
  )
})
