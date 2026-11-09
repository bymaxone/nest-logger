/**
 * E2E: a request body the parser refuses, through a real Nest application and real HTTP.
 *
 * Nest rebuilds the body parser's `SyntaxError` as a `BadRequestException` before any filter runs,
 * so a test that hands the filter a parser error directly proves nothing about what a host sees.
 * These cases start the application with `NestFactory` and Nest's default body parser, and read
 * the lines the logger writes: a fixed text and `bodyParserType` for a body that does not parse,
 * for a refused `verify` and for an unsupported encoding or charset, and the application's own
 * errors left alone. Run for the module alone and with `applyAccessLog`.
 *
 * Layer: E2E, server (`HttpExceptionFilter` and the error layer `BymaxLoggerModule` mounts).
 */
import { BadRequestException, Body, Controller, Module, Post } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { applyAccessLog, BymaxLoggerModule } from '@bymax-one/nest-logger'
import { json } from 'express'
import request from 'supertest'

import { parseLogEntries } from './fixtures/parse-log-entries'

const SECRET = 'hunter2-SENTINEL'

@Controller()
class BodyController {
  @Post('echo')
  echo(@Body() _body: unknown): { ok: boolean } {
    return { ok: true }
  }

  /** The application's own 400, worded with text of its own. */
  @Post('own-bad-request')
  ownBadRequest(): never {
    throw new BadRequestException(`own message ${SECRET}`)
  }

  /** The application parsing JSON itself: a SyntaxError raised inside a handler. */
  @Post('own-parse')
  ownParse(@Body() body: { text?: string }): { ok: boolean } {
    JSON.parse(body.text ?? '')
    return { ok: true }
  }
}

/** A module importing the logger the way a host does, with the filter on. */
@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-body-parser', version: '0.0.0' },
      http: { isEnabled: true, shouldCaptureExceptions: true }
    })
  ],
  controllers: [BodyController]
})
class AppModule {}

/** Every line the logger wrote while `act` ran, and what the client was sent. */
async function logged(
  app: INestApplication,
  stdout: jest.SpyInstance,
  act: (server: ReturnType<INestApplication['getHttpServer']>) => request.Test
): Promise<{ status: number; message: string; handled: Record<string, unknown>; text: string }> {
  stdout.mockClear()
  const res = await act(app.getHttpServer())
  const entries = parseLogEntries(stdout)
  const handled = entries.find((entry) => entry['logKey'] === 'HTTP_EXCEPTION_HANDLED') ?? {}
  const text = stdout.mock.calls.map((call) => String(call[0])).join('')
  return { status: res.status, message: String(res.body?.message ?? ''), handled, text }
}

describe.each([
  ['the module alone', false],
  ['applyAccessLog', true]
])('Logger E2E — a body the parser refuses, through Nest (%s)', (_name, withAccessLog) => {
  let app: INestApplication
  let stdout: jest.SpyInstance

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false })
    if (withAccessLog) applyAccessLog(app)
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it.each([
    ['a body that is not an object', SECRET],
    ['a value left unquoted', `{"password":${SECRET}}`],
    ['an unquoted value in a list', `{"items":[${SECRET}]}`]
  ])(
    'logs a fixed text for malformed JSON, %s, and still answers with the parser',
    async (_n, body) => {
      const out = await logged(app, stdout, (server) =>
        request(server).post('/echo').set('content-type', 'application/json').send(body)
      )

      expect(out.status).toBe(400)
      expect(out.message).toContain('is not valid JSON')
      expect(out.handled['msg']).toBe('request body could not be parsed')
      expect(out.handled['bodyParserType']).toBe('entity.parse.failed')
      expect(out.text).not.toContain('hunter')
    }
  )

  it.each([
    ['a content encoding', { 'content-encoding': `x-${SECRET}` }, 'encoding.unsupported'],
    ['a charset', { 'content-type': `application/json; charset=${SECRET}` }, 'charset.unsupported']
  ])('logs a fixed text for %s the parser does not support', async (_n, headers, type) => {
    const out = await logged(app, stdout, (server) =>
      request(server)
        .post('/echo')
        .set({ 'content-type': 'application/json', ...headers })
        .send('{"a":1}')
    )

    expect(out.status).toBe(415)
    expect(out.handled['bodyParserType']).toBe(type)
    expect(out.text).not.toMatch(/hunter/i)
  })

  it('leaves the 400 of the application alone, with its own text and no parser type', async () => {
    const out = await logged(app, stdout, (server) => request(server).post('/own-bad-request'))

    expect(out.status).toBe(400)
    expect(out.handled['msg']).toBe(`own message ${SECRET}`)
    expect(out.handled).not.toHaveProperty('bodyParserType')
  })

  it('leaves a SyntaxError the application raised in a handler alone', async () => {
    const out = await logged(app, stdout, (server) =>
      request(server).post('/own-parse').send({ text: SECRET })
    )

    expect(out.status).toBe(500)
    expect(out.text).not.toContain('bodyParserType')
  })
})

describe('Logger E2E — a body the verify function of the parser refuses, through Nest', () => {
  let app: INestApplication
  let stdout: jest.SpyInstance

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, bodyParser: false })
    app.use(
      json({
        verify: (_req, _res, buffer) => {
          throw new Error(`verify says ${buffer.toString()}`)
        }
      })
    )
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it('logs a fixed text and answers with the message of the application', async () => {
    const out = await logged(app, stdout, (server) =>
      request(server)
        .post('/echo')
        .set('content-type', 'application/json')
        .send(`{"password":"${SECRET}"}`)
    )

    expect(out.status).toBe(403)
    expect(out.message).toContain(SECRET)
    expect(out.handled['msg']).toBe('request body verification failed')
    expect(out.handled['bodyParserType']).toBe('entity.verify.failed')
    expect(out.text).not.toContain(SECRET)
  })
})
