/**
 * The requests an interceptor cannot see, and the one it saw wrongly.
 *
 * NestJS runs middleware → guards → interceptors → handler, so an interceptor
 * never observes a guard rejection or an unmatched route: 401, 403, 429 and 404
 * produced no log line at all, which made brute force and route enumeration
 * invisible. It also cannot judge delivery — the response has not been flushed
 * when it completes — so an aborted request was logged as the success the
 * handler intended.
 *
 * These are e2e rather than unit because the defect was one of POSITION in the
 * request pipeline: a unit test of any single component passes while the
 * pipeline as a whole stays blind.
 */
import net from 'node:net'

import type { CanActivate, INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common'
import {
  Controller,
  Get,
  Injectable,
  Module,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { applyRequestIdMiddleware, BymaxLoggerModule } from '@bymax-one/nest-logger'

import { parseLogEntries } from './fixtures/parse-log-entries'

/** Rejects every request, standing in for any real authentication guard. */
@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('denied')
  }
}

@Controller()
class CoverageController {
  @Get('open')
  open(): string {
    return 'ok'
  }

  @Get('guarded')
  @UseGuards(DenyGuard)
  guarded(): string {
    return 'never reached'
  }

  /**
   * Still running when the client hangs up. This is the shape the fidelity fix
   * is about: a slow upstream, a load-balancer timeout, a cancelled brute-force
   * attempt — the response is IN FLIGHT when the connection dies.
   */
  @Get('slow')
  async slow(): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 150))
    return 'late'
  }
}

@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'e2e-coverage', version: '0.0.0' },
      http: { isEnabled: true }
    })
  ],
  controllers: [CoverageController]
})
class CoverageAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applyRequestIdMiddleware(consumer)
  }
}

describe('Logger E2E — coverage of requests the interceptor never sees', () => {
  let app: INestApplication
  let stdoutSpy: jest.SpyInstance
  let port: number

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CoverageAppModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    await app.listen(0)
    port = Number((await app.getUrl()).split(':').pop())
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  /** Log keys emitted so far, in order. */
  const keys = (): string[] => parseLogEntries(stdoutSpy).map((e) => String(e['logKey']))

  it(/*
   * A guard rejection is the case that motivated this: `UnauthorizedException`
   * is thrown BEFORE any interceptor runs, so a 401 used to emit nothing at all —
   * no line, and no `requestId` to correlate a brute-force attempt by.
   */
  'logs a guard rejection (401) that no interceptor can observe', async () => {
    await request(app.getHttpServer()).get('/guarded').expect(401)

    const emitted = keys()
    expect(emitted).toContain('HTTP_REQUEST_START')
    expect(emitted).toContain('HTTP_REQUEST_CLIENT_ERROR')
    const terminal = parseLogEntries(stdoutSpy).find(
      (e) => e['logKey'] === 'HTTP_REQUEST_CLIENT_ERROR'
    )
    expect(terminal?.['statusCode']).toBe(401)
  })

  it(/*
   * An unmatched route has no controller to intercept at all, so route
   * enumeration by a scanner was equally invisible.
   */
  'logs an unmatched route (404)', async () => {
    await request(app.getHttpServer()).get('/no-such-route').expect(404)

    const terminal = parseLogEntries(stdoutSpy).find(
      (e) => e['logKey'] === 'HTTP_REQUEST_CLIENT_ERROR'
    )
    expect(terminal?.['statusCode']).toBe(404)
  })

  it(/*
   * The START entry must carry what an investigation needs. The middleware is the
   * only point that observes a request BEFORE a guard can reject it, so it is the
   * only place `ip` and `userAgent` can be captured for a rejected one.
   */
  'carries ip and userAgent on a rejected request', async () => {
    await request(app.getHttpServer()).get('/guarded').set('user-agent', 'probe/1.0').expect(401)

    const start = parseLogEntries(stdoutSpy).find((e) => e['logKey'] === 'HTTP_REQUEST_START')
    expect(start?.['userAgent']).toBe('probe/1.0')
    expect(start?.['ip']).toBeDefined()
    expect(start?.['requestId']).toBeDefined()
  })

  it(/*
   * The query string may carry a magic-link token or a reset code. It is stripped
   * from every logged URL, because no key-name redaction can scrub a secret out of
   * a string VALUE.
   */
  'strips the query string from the logged URL', async () => {
    await request(app.getHttpServer()).get('/open?token=SECRET-VALUE').expect(200)

    expect(JSON.stringify(parseLogEntries(stdoutSpy))).not.toContain('SECRET-VALUE')
  })

  it(/*
   * REGRESSION — the middleware and the interceptor both observe an ordinary
   * request. Exactly one START and one terminal entry must be emitted: the
   * middleware claims the lifecycle and the interceptor stands down.
   */
  'does not double-log a request both components can see', async () => {
    await request(app.getHttpServer()).get('/open').expect(200)

    const emitted = keys()
    expect(emitted.filter((k) => k === 'HTTP_REQUEST_START')).toHaveLength(1)
    expect(emitted.filter((k) => k === 'HTTP_REQUEST_SUCCESS')).toHaveLength(1)
  })

  it(/*
   * REGRESSION — destroying the socket does not cancel the handler: it runs to
   * completion, writes to a dead connection and the observable completes, so the
   * interceptor reported the 200 it intended. Delivery is a separate axis from
   * status, and `writableFinished` is what separates them.
   */
  'logs an aborted request as ABORTED rather than a success', async () => {
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n')
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 20)
      })
      socket.on('error', () => resolve())
    })
    await new Promise((r) => setTimeout(r, 400))

    const emitted = keys()
    expect(emitted).toContain('HTTP_REQUEST_ABORTED')
    expect(emitted).not.toContain('HTTP_REQUEST_SUCCESS')
    const terminal = parseLogEntries(stdoutSpy).find((e) => e['logKey'] === 'HTTP_REQUEST_ABORTED')
    // The status the server produced is PRESERVED. Inventing one — nginx's
    // non-standard 499, with IANA 452-499 unassigned — would assert a code the
    // server never emitted and break grouping by class.
    expect(terminal?.['statusCode']).toBe(200)
  })

  it(/*
   * The terminal entry is emitted from a `'close'` listener, which Node may run
   * in a different execution context than the one active at registration. Without
   * `AsyncResource.bind` the AsyncLocalStorage store is undefined there — measured
   * to fail on the ABORTED path specifically — and the entry loses its
   * correlation id, in the case where correlation matters most.
   */
  'keeps the correlation id on the terminal entry of an aborted request', async () => {
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n')
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 20)
      })
      socket.on('error', () => resolve())
    })
    await new Promise((r) => setTimeout(r, 400))

    const terminal = parseLogEntries(stdoutSpy).find((e) => e['logKey'] === 'HTTP_REQUEST_ABORTED')
    expect(terminal?.['requestId']).toBeDefined()
  })
})
