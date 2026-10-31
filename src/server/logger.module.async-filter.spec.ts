/**
 * What each registration path logs when a request throws: `forRoot` wires the
 * exception filter itself, `forRootAsync` does not, and registering the filter by hand
 * is how an asynchronous consumer gets the same entries.
 *
 * Layer: server, tests. The asymmetry is deliberate (a global catch-all filter added
 * from asynchronously resolved options would sit in every consumer's pipeline, whether
 * or not HTTP logging is on). These cases pin the behaviour and the remedy the README
 * gives, so a change to either has to update the documentation with it.
 */
import { Controller, Get, NotFoundException } from '@nestjs/common'
import type { DynamicModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { HttpExceptionFilter } from './filters/http-exception.filter'
import type { ILogDestination } from './interfaces/log-destination.interface'
import { BymaxLoggerModule } from './logger.module'
import { applyAccessLog } from './middlewares/apply-access-log'

@Controller()
class ThrowingController {
  @Get('missing')
  missing(): never {
    throw new NotFoundException('missing')
  }

  @Get('boom')
  boom(): never {
    throw new Error('kaboom')
  }
}

/** Log keys the HTTP layer emitted, in order, and the response of the failing route. */
async function httpKeysFor(
  logger: (destination: ILogDestination) => DynamicModule,
  extraProviders: { provide: symbol | string; useClass: typeof HttpExceptionFilter }[] = []
): Promise<{ keys: string[]; status: number; body: unknown }> {
  const lines: string[] = []
  const destination: ILogDestination = {
    name: 'capture',
    write: (line: string): void => void lines.push(line)
  }
  const ref = await Test.createTestingModule({
    imports: [logger(destination)],
    controllers: [ThrowingController],
    providers: extraProviders
  }).compile()
  const app = ref.createNestApplication()
  applyAccessLog(app)
  await app.init()
  await request(app.getHttpServer()).get('/missing')
  const response = await request(app.getHttpServer()).get('/boom')
  await app.close()
  const keys = lines
    .map((line) => (JSON.parse(line) as { logKey?: string }).logKey ?? '')
    .filter((key) => key.startsWith('HTTP_'))
  return { keys, status: response.status, body: response.body as unknown }
}

const service = { name: 'app', version: '1.0.0' }
const http = { isEnabled: true }

describe('exception filter wiring by registration path', () => {
  it(/*
   * `forRoot` with HTTP logging on registers `HttpExceptionFilter`, so a thrown
   * `HttpException` and an unexpected `Error` each produce their exception entry beside
   * the access-log entries.
   */
  'forRoot emits the exception entries', async () => {
    const { keys } = await httpKeysFor((destination) =>
      BymaxLoggerModule.forRoot({ service, http, destinations: [destination] })
    )
    expect(keys).toEqual(
      expect.arrayContaining(['HTTP_EXCEPTION_HANDLED', 'HTTP_EXCEPTION_UNHANDLED'])
    )
  })

  it(/*
   * `forRootAsync` with HTTP logging on registers the access log but NOT the filter: the
   * request entries are there, the two exception entries are not, and the response is
   * the same 500 the filter would have written. The real error still reaches the
   * terminal `HTTP_REQUEST_SERVER_ERROR` entry.
   */
  'forRootAsync emits the access log but not the exception entries', async () => {
    const { keys, status, body } = await httpKeysFor((destination) =>
      BymaxLoggerModule.forRootAsync({
        useFactory: () => ({ service, http, destinations: [destination] })
      })
    )
    expect(keys).toEqual(
      expect.arrayContaining([
        'HTTP_REQUEST_START',
        'HTTP_REQUEST_CLIENT_ERROR',
        'HTTP_REQUEST_SERVER_ERROR'
      ])
    )
    expect(keys).not.toContain('HTTP_EXCEPTION_HANDLED')
    expect(keys).not.toContain('HTTP_EXCEPTION_UNHANDLED')
    expect(status).toBe(500)
    expect(body).toEqual({ statusCode: 500, message: 'Internal server error' })
  })

  it(/*
   * The remedy the README gives an asynchronous consumer: register the filter as
   * `APP_FILTER`. It produces the same exception entries the synchronous path does.
   */
  'forRootAsync plus a hand-registered APP_FILTER emits the exception entries', async () => {
    const { keys } = await httpKeysFor(
      (destination) =>
        BymaxLoggerModule.forRootAsync({
          useFactory: () => ({ service, http, destinations: [destination] })
        }),
      [{ provide: APP_FILTER, useClass: HttpExceptionFilter }]
    )
    expect(keys).toEqual(
      expect.arrayContaining(['HTTP_EXCEPTION_HANDLED', 'HTTP_EXCEPTION_UNHANDLED'])
    )
  })
})
