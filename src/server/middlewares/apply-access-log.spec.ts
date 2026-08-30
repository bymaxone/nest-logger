import { Body, Controller, Module, Post } from '@nestjs/common'
import type { INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { applyAccessLog } from './apply-access-log'
import { applyRequestIdMiddleware } from './apply-request-id-middleware'
import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { ILogDestination } from '../interfaces/log-destination.interface'
import { BymaxLoggerModule } from '../logger.module'

/** A body the JSON parser cannot accept — the request under measurement. */
const TRUNCATED_JSON = '{"label":'

/** Captures every emitted entry so a test can assert on absence as well as presence. */
class CaptureDestination implements ILogDestination {
  readonly name = 'capture'
  readonly entries: Record<string, unknown>[] = []

  write(payload: string): void {
    this.entries.push(JSON.parse(payload) as Record<string, unknown>)
  }

  /** Only the HTTP access entries — the bootstrap line is noise here. */
  httpKeys(): unknown[] {
    return this.entries
      .map((entry) => entry.logKey)
      .filter((logKey) => typeof logKey === 'string' && logKey.startsWith('HTTP_'))
  }

  clear(): void {
    this.entries.length = 0
  }
}

/**
 * Wait until `capture` holds at least `count` HTTP entries, then settle one more
 * turn.
 *
 * The terminal entry is emitted from the server response's `'close'` event,
 * which can fire AFTER supertest's promise resolves. Asserting straight away
 * therefore races: the entry is sometimes missing from this test and sometimes
 * lands in the NEXT one, after `beforeEach` cleared the capture — measured as a
 * flaky failure roughly one run in three. The extra settle turn is what keeps a
 * straggler from corrupting the following test rather than this one.
 */
async function waitForHttpEntries(capture: CaptureDestination, count: number): Promise<void> {
  const deadline = Date.now() + 2000
  while (capture.httpKeys().length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 10)
  })
}

const earlyCapture = new CaptureDestination()
const lateCapture = new CaptureDestination()
const bothCapture = new CaptureDestination()
const prefixCapture = new CaptureDestination()
const scopedCapture = new CaptureDestination()

/** Route that only ever runs when the body parsed — deliberately trivial. */
@Controller()
class EchoController {
  @Post('examples')
  create(@Body() body: unknown): unknown {
    return body
  }
}

/** The recommended wiring: mounted from `main.ts`, ahead of the parser. */
@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'early-mount', version: '1.0.0' },
      http: { isEnabled: true },
      destinations: [earlyCapture]
    })
  ],
  controllers: [EchoController]
})
class EarlyMountModule {}

/** The module-middleware wiring, kept as the POSITIVE CONTROL for the gap. */
@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'late-mount', version: '1.0.0' },
      http: { isEnabled: true },
      destinations: [lateCapture]
    })
  ],
  controllers: [EchoController]
})
class LateMountModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applyRequestIdMiddleware(consumer)
  }
}

/** Both helpers at once — the wiring a consumer lands on mid-migration. */
@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'both-mounts', version: '1.0.0' },
      http: { isEnabled: true },
      destinations: [bothCapture]
    })
  ],
  controllers: [EchoController]
})
class BothMountsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    applyRequestIdMiddleware(consumer)
  }
}

describe('applyAccessLog', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EarlyMountModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    // BEFORE init(): `init()` registers the body parser and only then registers
    // module middleware, so mounting here is what puts this ahead of the parser.
    applyAccessLog(app)
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    earlyCapture.clear()
  })

  it(/*
   * THE defect this helper exists for. A body the JSON parser rejects never
   * reaches module middleware, a guard, an interceptor or a route, so the access
   * log never saw it. Mounted ahead of the parser it must emit START and a
   * terminal 4xx entry around whatever the exception filter produces.
   */
  'logs a request the body parser rejects', async () => {
    await request(app.getHttpServer())
      .post('/examples')
      .set('Content-Type', 'application/json')
      .send(TRUNCATED_JSON)
      .expect(400)
    await waitForHttpEntries(earlyCapture, 3)

    expect(earlyCapture.httpKeys()).toEqual([
      RESERVED_LOG_KEYS.HTTP_REQUEST_START,
      RESERVED_LOG_KEYS.HTTP_EXCEPTION_HANDLED,
      RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR
    ])
  })

  it(/*
   * The rejected request must be CORRELATABLE, not merely counted: the id the
   * client sent has to reach both entries. An id in the response with no line to
   * join it to is a token the client can quote and nothing more — that was the
   * failed first attempt at this fix, and this assertion is what distinguishes
   * the two.
   */
  'carries the inbound request id onto the entries for a rejected body', async () => {
    const res = await request(app.getHttpServer())
      .post('/examples')
      .set('Content-Type', 'application/json')
      .set('x-request-id', 'measure-me')
      .send(TRUNCATED_JSON)
      .expect(400)

    await waitForHttpEntries(earlyCapture, 3)

    expect(res.headers['x-request-id']).toBe('measure-me')
    const requestIds = earlyCapture.entries
      .filter((entry) => typeof entry.logKey === 'string' && entry.logKey.startsWith('HTTP_'))
      .map((entry) => entry.requestId)
    expect(requestIds).toEqual(['measure-me', 'measure-me', 'measure-me'])
  })

  it(/*
   * The terminal entry must carry the status the server actually produced, so a
   * rejected body is queryable as the 400 it was rather than being lumped in
   * with successes.
   */
  'records the real status code for a rejected body', async () => {
    await request(app.getHttpServer())
      .post('/examples')
      .set('Content-Type', 'application/json')
      .send(TRUNCATED_JSON)
      .expect(400)
    await waitForHttpEntries(earlyCapture, 3)

    const terminal = earlyCapture.entries.find(
      (entry) => entry.logKey === RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR
    )
    expect(terminal?.statusCode).toBe(400)
  })

  it(/*
   * A request that DOES reach the handler must still be logged exactly once
   * end-to-end — the early mount must not regress the ordinary path it shares
   * with the module-middleware wiring.
   */
  'still logs a well-formed request exactly once', async () => {
    await request(app.getHttpServer()).post('/examples').send({ label: 'ok' }).expect(201)
    await waitForHttpEntries(earlyCapture, 2)

    expect(earlyCapture.httpKeys()).toEqual([
      RESERVED_LOG_KEYS.HTTP_REQUEST_START,
      RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS
    ])
  })
})

describe('applyRequestIdMiddleware (positive control for the parser gap)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [LateMountModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    lateCapture.clear()
  })

  it(/*
   * The control that makes the assertion above mean something. A zero is only
   * evidence when the same measurement produces a non-zero somewhere it should:
   * the module-middleware wiring logs a well-formed request perfectly well...
   */
  'logs a well-formed request', async () => {
    await request(app.getHttpServer()).post('/examples').send({ label: 'ok' }).expect(201)
    await waitForHttpEntries(lateCapture, 2)

    expect(lateCapture.httpKeys()).toEqual([
      RESERVED_LOG_KEYS.HTTP_REQUEST_START,
      RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS
    ])
  })

  it(/*
   * ...and for the rejected body it emits ONE line and no access log, because
   * NestJS registers the parser before module middleware. Measured rather than
   * assumed: the auto-wired exception filter DOES catch a parser rejection on the
   * sync path, so this is not the flat zero it first looks like. It is one line
   * short of an access log — no START, no terminal entry, no status/duration/ip.
   */
  'emits only the filter line, and no access log, for a rejected body', async () => {
    await request(app.getHttpServer())
      .post('/examples')
      .set('Content-Type', 'application/json')
      .send(TRUNCATED_JSON)
      .expect(400)
    await waitForHttpEntries(lateCapture, 1)

    expect(lateCapture.httpKeys()).toEqual([RESERVED_LOG_KEYS.HTTP_EXCEPTION_HANDLED])
  })

  it(/*
   * And the line it does emit is UNCORRELATED, which is the half that matters.
   * The correlation middleware is mounted behind the parser too, so no scope is
   * ever opened: the client sent `x-request-id: measure-me` and the entry carries
   * no requestId at all. A 400 you cannot join to the caller's id is the same
   * defect as a missing 400, wearing a healthier face — this is the assertion
   * that separates "the request is logged" from "the request is traceable".
   */
  'emits that line without the correlation id the client sent', async () => {
    await request(app.getHttpServer())
      .post('/examples')
      .set('Content-Type', 'application/json')
      .set('x-request-id', 'measure-me')
      .send(TRUNCATED_JSON)
      .expect(400)
    await waitForHttpEntries(lateCapture, 1)

    const handled = lateCapture.entries.find(
      (entry) => entry.logKey === RESERVED_LOG_KEYS.HTTP_EXCEPTION_HANDLED
    )
    expect(handled).toBeDefined()
    expect(handled?.requestId).toBeUndefined()
  })
})

describe('applyAccessLog alongside applyRequestIdMiddleware', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BothMountsModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    applyAccessLog(app)
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    bothCapture.clear()
  })

  it(/*
   * Both helpers wired at once is a reasonable state to be in mid-migration, and
   * it must not double the access log: the second access-log mount finds the
   * request's lifecycle already claimed and stands down.
   */
  'logs a request exactly once with both helpers wired', async () => {
    await request(app.getHttpServer()).post('/examples').send({ label: 'ok' }).expect(201)
    await waitForHttpEntries(bothCapture, 2)

    expect(bothCapture.httpKeys()).toEqual([
      RESERVED_LOG_KEYS.HTTP_REQUEST_START,
      RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS
    ])
  })

  it(/*
   * Nor may it mint two ids. Before the middleware became idempotent, two mounts
   * with no inbound header produced two different UUIDs — the outer set the
   * response header to one, the inner overwrote the context with the other — so
   * the header and the log entries disagreed about the request's identity.
   */
  'mints exactly one request id with both helpers wired', async () => {
    const res = await request(app.getHttpServer())
      .post('/examples')
      .send({ label: 'ok' })
      .expect(201)
    await waitForHttpEntries(bothCapture, 2)

    const requestIds = bothCapture.entries
      .filter((entry) => typeof entry.logKey === 'string' && entry.logKey.startsWith('HTTP_'))
      .map((entry) => entry.requestId)
    expect(new Set(requestIds).size).toBe(1)
    expect(requestIds[0]).toBe(res.headers['x-request-id'])
  })
})

/** Same wiring, under a global prefix — the shape that broke the old default. */
@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'prefixed', version: '1.0.0' },
      http: { isEnabled: true },
      destinations: [prefixCapture]
    })
  ],
  controllers: [EchoController]
})
class PrefixedModule {}

describe('applyAccessLog under setGlobalPrefix', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrefixedModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    app.setGlobalPrefix('api')
    applyAccessLog(app)
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    prefixCapture.clear()
  })

  it(/*
   * A global prefix is exactly where this library has been bitten before: the
   * middleware default used to be `'*'`, which stops matching the prefixed root
   * under `setGlobalPrefix`, so requests silently vanished from the log. This
   * mount goes through `app.use()` rather than `forRoutes`, so it is a different
   * mechanism with the same failure mode available to it — pinned rather than
   * assumed.
   */
  'logs a prefixed request', async () => {
    await request(app.getHttpServer()).post('/api/examples').send({ label: 'ok' }).expect(201)
    await waitForHttpEntries(prefixCapture, 2)

    expect(prefixCapture.httpKeys()).toEqual([
      RESERVED_LOG_KEYS.HTTP_REQUEST_START,
      RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS
    ])
  })

  it(/*
   * And it must log the WHOLE path. A mounted middleware sees `url` relative to
   * its mount point, so logging `url` instead of `originalUrl` would drop the
   * prefix from every entry and stop an `excludePaths` pattern written against
   * the real path from ever matching.
   */
  'records the full prefixed path', async () => {
    await request(app.getHttpServer()).post('/api/examples').send({ label: 'ok' }).expect(201)
    await waitForHttpEntries(prefixCapture, 2)

    const start = prefixCapture.entries.find(
      (entry) => entry.logKey === RESERVED_LOG_KEYS.HTTP_REQUEST_START
    )
    expect(start?.url).toBe('/api/examples')
  })

  it(/*
   * The parser gap must stay closed under a prefix too — the reason the helper
   * exists does not get to depend on the app's routing configuration.
   */
  'still logs a rejected body under a prefix', async () => {
    await request(app.getHttpServer())
      .post('/api/examples')
      .set('Content-Type', 'application/json')
      .send(TRUNCATED_JSON)
      .expect(400)
    await waitForHttpEntries(prefixCapture, 3)

    expect(prefixCapture.httpKeys()).toContain(RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR)
  })
})

/** The logger registered NON-globally, inside a feature module. */
@Module({
  imports: [
    BymaxLoggerModule.forRoot({
      service: { name: 'scoped', version: '1.0.0' },
      isGlobal: false,
      http: { isEnabled: true },
      destinations: [scopedCapture]
    })
  ],
  controllers: [EchoController]
})
class ScopedLoggerModule {}

@Module({ imports: [ScopedLoggerModule] })
class RootModule {}

describe('applyAccessLog with a non-global logger module', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RootModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    applyAccessLog(app)
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it(/*
   * `isGlobal: false` puts the providers in a feature module rather than the root
   * one, so a STRICT container lookup would not find them and the helper would
   * throw "BymaxLoggerModule was not imported" at a consumer who imported it
   * perfectly well. The lookup is deliberately non-strict; this is the
   * configuration that tells the two apart.
   */
  'resolves its dependencies and logs', async () => {
    await request(app.getHttpServer()).post('/examples').send({ label: 'ok' }).expect(201)
    await waitForHttpEntries(scopedCapture, 2)

    expect(scopedCapture.httpKeys()).toEqual([
      RESERVED_LOG_KEYS.HTTP_REQUEST_START,
      RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS
    ])
  })
})

describe('applyAccessLog without the module', () => {
  it(/*
   * Calling the helper on an app that never imported BymaxLoggerModule must fail
   * with a message naming the cause, not with a raw DI error about an unknown
   * provider — the same contract `useNestLogger` already offers.
   */
  'throws a clear error when BymaxLoggerModule was not imported', async () => {
    @Module({ controllers: [EchoController] })
    class BareModule {}

    const moduleRef = await Test.createTestingModule({ imports: [BareModule] }).compile()
    const app = moduleRef.createNestApplication({ logger: false })

    expect(() => {
      applyAccessLog(app)
    }).toThrow('applyAccessLog(app) called but BymaxLoggerModule was not imported')

    await app.close()
  })

  it(/*
   * The original DI failure must survive as `cause` — the clear message is an
   * addition to the diagnosis, never a replacement that discards it.
   */
  'preserves the original DI failure as cause', async () => {
    @Module({ controllers: [EchoController] })
    class BareModule {}

    const moduleRef = await Test.createTestingModule({ imports: [BareModule] }).compile()
    const app = moduleRef.createNestApplication({ logger: false })

    let caught: unknown
    try {
      applyAccessLog(app)
    } catch (error) {
      caught = error
    }
    expect((caught as Error).cause).toBeDefined()

    await app.close()
  })
})
