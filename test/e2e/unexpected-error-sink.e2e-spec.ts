import {
  Catch,
  Controller,
  Get,
  Global,
  HttpStatus,
  Inject,
  Module,
  Optional
} from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter, INestApplication } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { BymaxLoggerModule, PinoUnexpectedErrorSink } from '@bymax-one/nest-logger'
import type { IUnexpectedErrorSink } from '@bymax-one/nest-logger'
import type { Request, Response } from 'express'
import request from 'supertest'

import { parseLogEntries } from './fixtures/parse-log-entries'

/**
 * Stand-in for nest-core's token. nest-core 1.6.2 declares it with
 * `Symbol.for`, so this is the same symbol a real consumer would import.
 */
const BYMAX_UNEXPECTED_ERROR_SINK = Symbol.for('@bymax-one/nest-core:unexpected-error-sink')

/**
 * Stand-in for nest-core's exception filter, reduced to the sink contract: it
 * calls `record()` synchronously before writing the fixed 500 body, and
 * contains anything the sink throws.
 */
@Catch()
class NestCoreLikeFilter implements ExceptionFilter {
  constructor(
    @Optional()
    @Inject(BYMAX_UNEXPECTED_ERROR_SINK)
    private readonly sink: IUnexpectedErrorSink | null
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<Request>()
    const res = host.switchToHttp().getResponse<Response>()
    try {
      this.sink?.record({
        error: exception,
        method: req.method,
        route: '/invoices/:id',
        correlationId: 'corr-1'
      })
    } catch {
      // nest-core drops a sink failure; the response never changes.
    }
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ code: 'BYMAX_INTERNAL_ERROR' })
  }
}

/** The consumer-side binding, exactly as the README documents it. */
@Global()
@Module({
  providers: [{ provide: BYMAX_UNEXPECTED_ERROR_SINK, useClass: PinoUnexpectedErrorSink }],
  exports: [BYMAX_UNEXPECTED_ERROR_SINK]
})
class UnexpectedErrorSinkModule {}

@Controller()
class InvoiceController {
  @Get('invoices/:id')
  find(): never {
    throw new TypeError('Cannot read properties of undefined', {
      cause: Object.assign(new Error('pool exhausted'), { password: 'db-secret' })
    })
  }
}

/**
 * Boot an application wired the way a consumer would: the global logger
 * module, the sink bound from its own global module, and the nest-core-like
 * filter as `APP_FILTER`.
 *
 * @returns The initialized application.
 */
async function createSinkApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      BymaxLoggerModule.forRoot({ service: { name: 'e2e-sink', version: '0.0.0' } }),
      UnexpectedErrorSinkModule
    ],
    controllers: [InvoiceController],
    providers: [{ provide: APP_FILTER, useClass: NestCoreLikeFilter }]
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  return app
}

describe('Logger E2E — PinoUnexpectedErrorSink bound to the nest-core token', () => {
  let app: INestApplication
  let stdoutSpy: jest.SpyInstance

  beforeAll(async () => {
    app = await createSinkApp()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it(/*
   * End to end through DI and the real Pino pipeline: the consumer binding
   * resolves PinoLoggerService from the global logger module, and the emitted
   * line carries the original error type, its stack and cause, and the request
   * coordinates — with the default redaction still applied to the cause's own
   * fields and nothing from the request beyond method and route.
   */
  'emits one HTTP_UNEXPECTED_ERROR line with the original error', async () => {
    await request(app.getHttpServer())
      .get('/invoices/42?token=reset-code')
      .set('authorization', 'Bearer header-secret')
      .expect(500, { code: 'BYMAX_INTERNAL_ERROR' })

    const entries = parseLogEntries(stdoutSpy).filter(
      (entry) => entry['logKey'] === 'HTTP_UNEXPECTED_ERROR'
    )
    expect(entries).toHaveLength(1)
    const entry = entries[0] ?? {}
    expect(entry).toMatchObject({
      level: 'error',
      msg: 'Cannot read properties of undefined',
      method: 'GET',
      route: '/invoices/:id',
      correlationId: 'corr-1',
      err: {
        type: 'TypeError',
        message: 'Cannot read properties of undefined',
        cause: { message: 'pool exhausted', password: '[REDACTED]' }
      }
    })
    expect((entry['err'] as { stack: string }).stack).toContain('TypeError')
    expect(JSON.stringify(entry)).not.toMatch(/reset-code|header-secret|db-secret|\/invoices\/42/)
  })
})
