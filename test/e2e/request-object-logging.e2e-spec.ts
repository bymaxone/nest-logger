/**
 * E2E: a request object passed as log metadata, through a real Nest application and real HTTP.
 *
 * `logger.info(key, msg, userId, { req })` is how a host puts the request in a line. An
 * `IncomingMessage` carries its credentials twice: in `headers`, an object whose keys the name
 * redaction censors, and in `rawHeaders`, a flat array of alternating names and values, where a value
 * sits beside its name and not under a key. A key-name rule cannot reach it, so the value beside a
 * sensitive name is censored as a pair, under every redaction strategy. These cases read every line
 * the logger writes for a request logged under `req`, under another key, with a host serializer and
 * with the legacy paths strategy.
 *
 * Layer: E2E, server (`PinoLoggerService`, the default serializers).
 */
import { Controller, Get, Inject, Module, Req } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import request from 'supertest'

import { parseLogEntries } from './fixtures/parse-log-entries'
import { listeningServer } from './support/listening-server'

@Controller()
class RequestController {
  constructor(@Inject(PinoLoggerService) private readonly logger: PinoLoggerService) {}

  @Get('probe')
  probe(@Req() req: unknown): { ok: boolean } {
    this.logger.info('PROBE_REQUEST', 'request as metadata', undefined, { req })
    return { ok: true }
  }

  @Get('nested')
  nested(@Req() req: unknown): { ok: boolean } {
    this.logger.info('NESTED_REQUEST', 'request under another key', undefined, { request: req })
    return { ok: true }
  }
}

@Controller()
class PayController {
  constructor(@Inject(PinoLoggerService) private readonly logger: PinoLoggerService) {}

  @Get('pay/:ref')
  pay(@Req() req: unknown): { ok: boolean } {
    this.logger.info('PAY_REQUEST', 'request as metadata', undefined, { req })
    return { ok: true }
  }
}

@Module({
  imports: [
    BymaxLoggerModule.forRoot({ service: { name: 'e2e-request-object', version: '0.0.0' } })
  ],
  controllers: [RequestController]
})
class AppModule {}

describe('Logger E2E — a request object as metadata', () => {
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

  it('writes no credential header value, in headers or in rawHeaders', async () => {
    await request(await listeningServer(app))
      .get('/probe')
      .set('Authorization', 'Bearer LEAK-BEARER')
      .set('X-Api-Key', 'LEAK-KEY')
      .set('Cookie', 'sid=LEAK-COOKIE')

    const text = stdout.mock.calls.map((call) => String(call[0])).join('')
    const entry = parseLogEntries(stdout).find((e) => e['logKey'] === 'PROBE_REQUEST')
    expect(entry).toBeDefined()
    expect(text).not.toContain('LEAK-BEARER')
    expect(text).not.toContain('LEAK-KEY')
    expect(text).not.toContain('LEAK-COOKIE')
  })

  it('keeps the facts a request line is for', async () => {
    await request(await listeningServer(app))
      .get('/probe')
      .set('User-Agent', 'probe-agent')

    const entry = parseLogEntries(stdout).find((e) => e['logKey'] === 'PROBE_REQUEST')
    const req = entry?.['req'] as Record<string, unknown> | undefined
    expect(req?.['method']).toBe('GET')
    expect(req?.['url']).toBe('/probe')
    expect((req?.['headers'] as Record<string, unknown>)['user-agent']).toBe('probe-agent')
  })
})

describe('Logger E2E — a request object under another key', () => {
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

  it('censors the credential values in rawHeaders, which the name walk reads beside their names', async () => {
    await request(await listeningServer(app))
      .get('/nested')
      .set('Authorization', 'Bearer LEAK-BEARER')
      .set('X-Api-Key', 'LEAK-KEY')
      .set('User-Agent', 'probe-agent')

    const text = stdout.mock.calls.map((call) => String(call[0])).join('')
    expect(text).not.toContain('LEAK-BEARER')
    expect(text).not.toContain('LEAK-KEY')
    expect(text).toContain('probe-agent')
  })
})

let received: unknown

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-request-object-own', version: '0.0.0' },
      serializers: {
        req: (input) => {
          received = input
          return { ownSerializer: true }
        }
      }
    })
  ],
  controllers: [RequestController]
})
class OwnSerializerModule {}

describe('Logger E2E — a host req serializer', () => {
  let app: INestApplication
  let stdout: jest.SpyInstance

  beforeAll(async () => {
    app = await NestFactory.create(OwnSerializerModule, { logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it('replaces the default, and receives the request as the redaction walk copied it', async () => {
    await request(await listeningServer(app))
      .get('/probe')
      .set('Authorization', 'Bearer LEAK-BEARER')

    const entry = parseLogEntries(stdout).find((e) => e['logKey'] === 'PROBE_REQUEST')
    expect(entry?.['req']).toEqual({ ownSerializer: true })
    expect(received).toMatchObject({ method: 'GET', url: '/probe' })
    expect(received).not.toHaveProperty('headers')
    expect(JSON.stringify(received)).not.toContain('LEAK-BEARER')
  })
})

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-request-object-segments', version: '0.0.0' },
      http: { secretPathSegments: [/^sk_/] }
    })
  ],
  controllers: [PayController]
})
class SegmentsModule {}

describe('Logger E2E — the host credential path patterns reach a logged request', () => {
  let app: INestApplication
  let stdout: jest.SpyInstance

  beforeAll(async () => {
    app = await NestFactory.create(SegmentsModule, { logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it('writes the request URL with a segment the host pattern matches replaced', async () => {
    await request(await listeningServer(app)).get('/pay/sk_live123')

    const text = stdout.mock.calls.map((call) => String(call[0])).join('')
    expect(text).not.toContain('sk_live123')
    expect(text).toContain('"url":"/pay/:redacted"')
  })
})

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-request-object-paths', version: '0.0.0' },
      redactStrategy: 'paths'
    })
  ],
  controllers: [RequestController]
})
class PathsStrategyModule {}

describe('Logger E2E — a request object under another key, with the legacy paths strategy', () => {
  let app: INestApplication
  let stdout: jest.SpyInstance

  beforeAll(async () => {
    app = await NestFactory.create(PathsStrategyModule, { logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it('censors the credential values in rawHeaders, which no path can match by the name beside them', async () => {
    await request(await listeningServer(app))
      .get('/nested')
      .set('Authorization', 'Bearer LEAK-BEARER')
      .set('X-Api-Key', 'LEAK-KEY')

    const text = stdout.mock.calls.map((call) => String(call[0])).join('')
    expect(text).not.toContain('LEAK-BEARER')
    expect(text).not.toContain('LEAK-KEY')
  })

  it('censors them for a request under req as well', async () => {
    await request(await listeningServer(app))
      .get('/probe')
      .set('Authorization', 'Bearer LEAK-BEARER')

    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).not.toContain('LEAK-BEARER')
  })
})
