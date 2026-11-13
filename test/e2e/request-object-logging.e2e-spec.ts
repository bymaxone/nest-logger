/**
 * E2E: a request object passed as log metadata, through a real Nest application and real HTTP.
 *
 * `logger.info(key, msg, userId, { req })` is the first thing a host writes when it wants the request
 * in a line. An `IncomingMessage` carries its credentials twice: in `headers`, an object whose keys the
 * name redaction censors, and in `rawHeaders`, a flat array of alternating names and values, where a
 * value sits beside a name and is not under any key. Under the default names strategy the array's
 * strings are not covered by a name, so the `Authorization` and `X-Api-Key` values reach the line.
 *
 * Layer: E2E, server (`PinoLoggerService`, the default serializers).
 */
import { Controller, Get, Inject, Module, Req } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { BymaxLoggerModule, PinoLoggerService } from '@bymax-one/nest-logger'
import request from 'supertest'

import { parseLogEntries } from './fixtures/parse-log-entries'

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
    await request(app.getHttpServer())
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
    await request(app.getHttpServer()).get('/probe').set('User-Agent', 'probe-agent')

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
    await request(app.getHttpServer())
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

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-request-object-own', version: '0.0.0' },
      serializers: { req: () => ({ ownSerializer: true }) }
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

  it('receives the request itself, and its output is what is written', async () => {
    await request(app.getHttpServer()).get('/probe').set('Authorization', 'Bearer LEAK-BEARER')

    const entry = parseLogEntries(stdout).find((e) => e['logKey'] === 'PROBE_REQUEST')
    expect(entry?.['req']).toEqual({ ownSerializer: true })
  })
})
