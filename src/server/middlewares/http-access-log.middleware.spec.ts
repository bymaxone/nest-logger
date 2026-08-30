import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import type { PinoLoggerService } from '../services/pino-logger.service'
import { LogContextService } from '../services/log-context.service'
import { isRecorderActive, recordError } from '../utils/http-log-state.util'

import { HttpAccessLogMiddleware } from './http-access-log.middleware'

/** Logger double capturing every structured call the middleware makes. */
function createLogger(): {
  logger: PinoLoggerService
  info: jest.Mock
  warnStructured: jest.Mock
  errorStructured: jest.Mock
} {
  const info = jest.fn()
  const warnStructured = jest.fn()
  const errorStructured = jest.fn()
  return {
    logger: { info, warnStructured, errorStructured } as unknown as PinoLoggerService,
    info,
    warnStructured,
    errorStructured
  }
}

/** Options double carrying only what the middleware reads. */
function createOptions(
  excludePaths: RegExp[] = [],
  isEnabled = true
): ResolvedBymaxLoggerModuleOptions {
  return { http: { excludePaths, isEnabled } } as unknown as ResolvedBymaxLoggerModuleOptions
}

/** Mutable response double exposing the registered `'close'` listener. */
function createResponse(
  statusCode = 200,
  writableFinished = true
): { res: LoggableResponse; fireClose: () => void } {
  let listener: (() => void) | undefined
  const res = {
    statusCode,
    writableFinished,
    setHeader: jest.fn(),
    status: jest.fn(),
    on: (_event: 'close', fn: () => void): unknown => {
      listener = fn
      return res
    }
  } as unknown as LoggableResponse
  return {
    res,
    fireClose: (): void => {
      listener?.()
    }
  }
}

/** Request double with the members the middleware reads. */
function createRequest(overrides: Partial<LoggableRequest> = {}): LoggableRequest {
  return {
    headers: { 'user-agent': 'jest/1.0' },
    method: 'GET',
    url: '/users/123',
    ip: '10.0.0.1',
    ...overrides
  } as LoggableRequest
}

describe('HttpAccessLogMiddleware', () => {
  it(/*
   * The START entry is what an investigation reads for a request that was later
   * rejected: the URL is normalized so ids do not explode log cardinality, and
   * the query string is stripped from `fullUrl` because it may carry a reset
   * token that no key-name redaction can scrub out of a string VALUE.
   */
  'emits START with normalized url, stripped query, ip and user agent', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const req = createRequest({ url: '/users/123?token=SECRET' })
    const { res } = createResponse()
    const next = jest.fn()

    middleware.use(req, res, next)

    expect(info).toHaveBeenCalledWith(
      RESERVED_LOG_KEYS.HTTP_REQUEST_START,
      'GET /users/:id',
      undefined,
      {
        method: 'GET',
        url: '/users/:id',
        fullUrl: '/users/123',
        ip: '10.0.0.1',
        userAgent: 'jest/1.0'
      }
    )
    expect(next).toHaveBeenCalledTimes(1)
  })

  it(/*
   * An excluded path bypasses logging entirely — no START and no terminal entry —
   * so health-check and metrics traffic does not flood the sink. It must also NOT
   * claim the lifecycle, or the interceptor would fall silent for a request this
   * middleware never logs, losing it from both.
   */
  'skips an excluded path without claiming the lifecycle', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(
      logger,
      new LogContextService(),
      createOptions([/^\/health/])
    )
    const req = createRequest({ url: '/health?probe=1' })
    const { res } = createResponse()
    const next = jest.fn()

    middleware.use(req, res, next)

    expect(info).not.toHaveBeenCalled()
    expect(isRecorderActive(req)).toBe(false)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it(/*
   * REGRESSION — `applyRequestIdMiddleware` is ALSO the public wiring for
   * correlation alone, and `http.isEnabled` defaults to false. Without this gate
   * a consumer who asked only for a `requestId` started emitting an access log
   * they never opted into — and the lifecycle claim would silence the interceptor
   * for a request nothing logs, losing it from both.
   */
  'emits nothing and does not claim when http logging is disabled', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(
      logger,
      new LogContextService(),
      createOptions([], false)
    )
    const req = createRequest()
    const next = jest.fn()

    middleware.use(req, createResponse().res, next)

    expect(info).not.toHaveBeenCalled()
    expect(isRecorderActive(req)).toBe(false)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it(/*
   * REGRESSION — this middleware is MOUNTED, and a mounted middleware sees `url`
   * relative to its mount point. Measured under `setGlobalPrefix('api')`:
   * `/api/users/7` arrives as `url = '/users/7'` with
   * `originalUrl = '/api/users/7'`. Logging `url` dropped the prefix from every
   * entry and stopped an `excludePaths` pattern written against the real path
   * from matching.
   */
  'logs the original target, not the mount-relative url', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const req = createRequest({ url: '/users/123', originalUrl: '/api/users/123?q=1' })

    middleware.use(req, createResponse().res, jest.fn())

    expect(info.mock.calls[0]?.[3]).toMatchObject({
      url: '/api/users/:id',
      fullUrl: '/api/users/123'
    })
  })

  it(/*
   * The exclude patterns are written against the REAL path, so they must be
   * matched against it too — `/api/health` must be skipped by `^/api/health`.
   */
  'matches exclude patterns against the original target', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(
      logger,
      new LogContextService(),
      createOptions([/^\/api\/health/])
    )
    const req = createRequest({ url: '/health', originalUrl: '/api/health' })

    middleware.use(req, createResponse().res, jest.fn())

    expect(info).not.toHaveBeenCalled()
    expect(isRecorderActive(req)).toBe(false)
  })

  it(/*
   * The claim is what stops the interceptor emitting a second START and terminal
   * entry for every request both can see.
   */
  'claims the lifecycle for a logged request', () => {
    const { logger } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const req = createRequest()

    middleware.use(req, createResponse().res, jest.fn())

    expect(isRecorderActive(req)).toBe(true)
  })

  it.each([
    [200, RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS],
    [299, RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS],
    // 300 exactly: the one input that tells `>= 300` from `> 300`, and the edge
    // an off-by-one would silently relabel as a success.
    [300, RESERVED_LOG_KEYS.HTTP_REQUEST_REDIRECT],
    [301, RESERVED_LOG_KEYS.HTTP_REQUEST_REDIRECT],
    [399, RESERVED_LOG_KEYS.HTTP_REQUEST_REDIRECT]
  ])(
    /*
     * The non-error terminal entries. The boundaries are asserted directly
     * because an off-by-one on the 3xx edge silently relabels every redirect.
     */
    'logs status %i as %s',
    (statusCode, expectedKey) => {
      const { logger, info } = createLogger()
      const middleware = new HttpAccessLogMiddleware(
        logger,
        new LogContextService(),
        createOptions()
      )
      const { res, fireClose } = createResponse(statusCode)

      middleware.use(createRequest(), res, jest.fn())
      info.mockClear()
      fireClose()

      expect(info).toHaveBeenCalledTimes(1)
      expect(info.mock.calls[0]?.[0]).toBe(expectedKey)
      expect(info.mock.calls[0]?.[3]).toMatchObject({ statusCode })
    }
  )

  it.each([[400], [401], [403], [429], [499]])(
    /*
     * The line a guard rejection produces, and the reason this middleware exists:
     * an interceptor never runs for these, so 401/403/429 emitted nothing at all.
     * `warn`, not `error` — a rejected credential is not a server fault.
     */
    'logs client error %i at warn level',
    (statusCode) => {
      const { logger, warnStructured } = createLogger()
      const middleware = new HttpAccessLogMiddleware(
        logger,
        new LogContextService(),
        createOptions()
      )
      const { res, fireClose } = createResponse(statusCode)

      middleware.use(createRequest(), res, jest.fn())
      fireClose()

      expect(warnStructured).toHaveBeenCalledWith(
        RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR,
        `GET /users/:id → ${statusCode}`,
        undefined,
        expect.objectContaining({ statusCode })
      )
    }
  )

  it(/*
   * REGRESSION — the interceptor's 4xx entry carried `errorMessage`, and the
   * middleware taking over the lifecycle dropped it. That silently narrowed the
   * log schema for any consumer already querying the field.
   */
  'carries errorMessage on a 4xx that threw', () => {
    const { logger, warnStructured } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const req = createRequest()
    const { res, fireClose } = createResponse(400)

    middleware.use(req, res, jest.fn())
    recordError(req, new Error('bad input'))
    fireClose()

    expect(warnStructured.mock.calls[0]?.[3]).toMatchObject({
      statusCode: 400,
      errorMessage: 'bad input'
    })
  })

  it(/*
   * A rejection that never threw through the interceptor — a guard rejection an
   * exception filter resolved, or a status set directly — carries NO
   * `errorMessage` rather than an empty one, so "no message" stays
   * distinguishable from a message that happened to be blank.
   */
  'omits errorMessage on a 4xx that did not throw', () => {
    const { logger, warnStructured } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const { res, fireClose } = createResponse(403)

    middleware.use(createRequest(), res, jest.fn())
    fireClose()

    expect(warnStructured.mock.calls[0]?.[3]).not.toHaveProperty('errorMessage')
  })

  it(/*
   * A 5xx that threw: the interceptor recorded the value on the way past, so the
   * terminal entry carries the real stack. Losing it would strip the most useful
   * half of a server-error line.
   */
  'logs a 5xx with the error the interceptor recorded', () => {
    const { logger, errorStructured } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const req = createRequest()
    const { res, fireClose } = createResponse(500)
    const thrown = new Error('handler exploded')

    middleware.use(req, res, jest.fn())
    recordError(req, thrown)
    fireClose()

    expect(errorStructured).toHaveBeenCalledWith(
      RESERVED_LOG_KEYS.HTTP_REQUEST_SERVER_ERROR,
      thrown,
      undefined,
      expect.objectContaining({ statusCode: 500 })
    )
  })

  it(/*
   * A 5xx that did NOT throw through the interceptor — a filter or a guard set
   * the status directly. There is no stack to carry, but the entry must still be
   * an error-level structured line rather than silently degrading to info.
   */
  'logs a 5xx with no recorded error as a synthesized one', () => {
    const { logger, errorStructured } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const { res, fireClose } = createResponse(503)

    middleware.use(createRequest(), res, jest.fn())
    fireClose()

    expect(errorStructured).toHaveBeenCalledTimes(1)
    const [key, error, , meta] = errorStructured.mock.calls[0] as [string, Error, unknown, object]
    expect(key).toBe(RESERVED_LOG_KEYS.HTTP_REQUEST_SERVER_ERROR)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('GET /users/:id → 503')
    expect(meta).toMatchObject({ statusCode: 503 })
  })

  it(/*
   * REGRESSION — delivery is a SEPARATE axis from status. The handler ran to
   * completion and set 200, but the connection died before the bytes were
   * flushed, so reporting a success asserted something that never happened. The
   * status the server produced is preserved: inventing one (nginx's 499, which
   * IANA leaves unassigned) would assert a code the protocol has no name for.
   */
  'logs an undelivered response as ABORTED, keeping the real status', () => {
    const { logger, info, warnStructured } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const { res, fireClose } = createResponse(200, false)

    middleware.use(createRequest(), res, jest.fn())
    info.mockClear()
    fireClose()

    expect(info).not.toHaveBeenCalled()
    expect(warnStructured).toHaveBeenCalledWith(
      RESERVED_LOG_KEYS.HTTP_REQUEST_ABORTED,
      expect.stringContaining('not delivered'),
      undefined,
      expect.objectContaining({ statusCode: 200 })
    )
  })

  it(/*
   * An undelivered 5xx takes the ABORTED path too. Delivery is checked FIRST,
   * because "the client never got it" is true whatever the status would have
   * been — otherwise the two axes collapse back into one.
   */
  'prefers ABORTED over the status classification', () => {
    const { logger, warnStructured, errorStructured } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const { res, fireClose } = createResponse(500, false)

    middleware.use(createRequest(), res, jest.fn())
    fireClose()

    expect(errorStructured).not.toHaveBeenCalled()
    expect(warnStructured.mock.calls[0]?.[0]).toBe(RESERVED_LOG_KEYS.HTTP_REQUEST_ABORTED)
  })

  it(/*
   * `userId` is read at CLOSE, not at START: authentication runs in a guard,
   * downstream of this middleware, so at START there is no principal yet. Reading
   * it early would drop the acting user from every terminal entry.
   */
  'reads the acting user at close, after the guard populated it', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const req = createRequest() as { user?: { sub?: string } }
    const { res, fireClose } = createResponse(200)

    middleware.use(req as LoggableRequest, res, jest.fn())
    expect(info.mock.calls[0]?.[2]).toBeUndefined()

    req.user = { sub: 'user-9' }
    info.mockClear()
    fireClose()

    expect(info.mock.calls[0]?.[2]).toBe('user-9')
  })

  it(/*
   * The terminal message is what a human reads in a tail. Asserting the key and
   * the metadata alone left the rendered line unpinned, so it could degrade to an
   * empty string without a test noticing.
   */
  'renders the terminal message with method, url, status and duration', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const { res, fireClose } = createResponse(200)

    middleware.use(createRequest(), res, jest.fn())
    info.mockClear()
    fireClose()

    expect(info.mock.calls[0]?.[1]).toMatch(/^GET \/users\/:id → 200 \(\d+ms\)$/)
  })

  it(/*
   * `duration` must be the ELAPSED time. An inverted sign still produces a
   * number — and a plausible-looking entry — so the value is bounded here rather
   * than merely asserted to exist: adding the timestamps yields ~1e12 ms.
   */
  'reports an elapsed duration, not a timestamp', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const { res, fireClose } = createResponse(200)

    middleware.use(createRequest(), res, jest.fn())
    info.mockClear()
    fireClose()

    const { duration } = info.mock.calls[0]?.[3] as { duration: number }
    expect(duration).toBeGreaterThanOrEqual(0)
    expect(duration).toBeLessThan(1000)
  })

  it(/*
   * A recorded error does NOT promote a 4xx into a server error. The interceptor
   * records every thrown value, including the `HttpException` behind a 400, so
   * the status is what decides the level — otherwise a bad request would page
   * someone.
   */
  'keeps a 4xx at warn even when an error was recorded', () => {
    const { logger, warnStructured, errorStructured } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const req = createRequest()
    const { res, fireClose } = createResponse(400)

    middleware.use(req, res, jest.fn())
    recordError(req, new Error('bad request'))
    fireClose()

    expect(errorStructured).not.toHaveBeenCalled()
    expect(warnStructured.mock.calls[0]?.[0]).toBe(RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR)
  })

  it(/*
   * A missing or malformed user-agent must not produce `undefined` in the entry —
   * the field is part of the access-log contract.
   */
  'falls back to unknown when the user agent is absent', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())

    middleware.use(createRequest({ headers: {} }), createResponse().res, jest.fn())

    expect(info.mock.calls[0]?.[3]).toMatchObject({ userAgent: 'unknown' })
  })
})

describe('HttpAccessLogMiddleware — terminal-entry async context', () => {
  /*
   * Which async context the terminal entry is emitted in decides which
   * correlation the Pino mixin reads. Neither strategy alone covers both paths,
   * measured against real ALS behaviour (and confirmed independently by
   * nest-core against a real OTel ContextManager):
   *
   *   normal:  live context = innermost scope at emit time; bound = stale
   *   aborted: live context = undefined; bound = the middleware's scope
   */
  function arm(logContext: LogContextService): {
    fireClose: () => void
    seenScopes: unknown[]
  } {
    const seenScopes: unknown[] = []
    const logger = {
      info: jest.fn(() => {
        seenScopes.push(logContext.getStore()?.['requestId'])
      }),
      warnStructured: jest.fn(),
      errorStructured: jest.fn()
    } as unknown as PinoLoggerService
    const middleware = new HttpAccessLogMiddleware(logger, logContext, createOptions())
    const { res, fireClose } = createResponse(200)
    logContext.run({ requestId: 'mw-scope' }, () => {
      middleware.use(createRequest(), res, jest.fn())
    })
    return { fireClose, seenScopes }
  }

  it(/*
   * REGRESSION — bound-only was the previous behaviour, and it attributed the
   * terminal entry to the REGISTRATION-time context whenever instrumentation
   * opened a scope downstream of this middleware. Silent, because a plausible
   * correlation was still present — just the wrong one. When a live store is
   * readable at close time, the emit must run in it, so the mixin reads the
   * freshest state.
   */
  'emits in the LIVE context when one is readable at close time', () => {
    const logContext = new LogContextService()
    const { fireClose, seenScopes } = arm(logContext)

    // A downstream scope, opened AFTER the middleware registered its listener —
    // the shape of instrumentation running later in the pipeline.
    logContext.run({ requestId: 'downstream-scope' }, () => {
      fireClose()
    })

    expect(seenScopes).toEqual(['mw-scope', 'downstream-scope'])
  })

  it(/*
   * The aborted path: `close` fires from the socket's context, outside every
   * request scope, where the live store is undefined. The bound fallback is what
   * keeps that entry carrying its requestId — the case where correlation matters
   * most, and the case the live read alone loses entirely.
   */
  'falls back to the BOUND context when no live store is readable', () => {
    const logContext = new LogContextService()
    const { fireClose, seenScopes } = arm(logContext)

    // Fired outside any scope, as the socket does on an aborted connection.
    fireClose()

    expect(seenScopes).toEqual(['mw-scope', 'mw-scope'])
  })
  it(/*
   * A second mount of this middleware on the same request must stand down.
   * `applyAccessLog(app)` in main.ts alongside `applyRequestIdMiddleware(consumer)`
   * is a reasonable state to be in mid-migration, and without the claim check it
   * doubles every access-log line: two STARTs, two terminal entries, twice the
   * ingestion bill for the same traffic.
   */
  'emits nothing when the request lifecycle is already claimed', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const req = createRequest()
    const { res, fireClose } = createResponse()
    const next = jest.fn()

    middleware.use(req, res, next)
    middleware.use(req, res, next)
    fireClose()

    expect(info).toHaveBeenCalledTimes(2)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it(/*
   * Standing down must still CONTINUE the chain. An early return that forgot
   * `next()` would hang every request the moment a consumer wired both helpers —
   * a far worse failure than the double logging it prevents.
   */
  'continues the chain when it stands down', () => {
    const { logger } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const req = createRequest()
    const { res } = createResponse()
    const next = jest.fn()

    middleware.use(req, res, jest.fn())
    middleware.use(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
  })

  it(/*
   * The claim is per-REQUEST state, so a different request must be unaffected —
   * the providers here are singletons and a claim stored on the instance would
   * silence every subsequent request in the process.
   */
  'still logs a different request after standing down on one', () => {
    const { logger, info } = createLogger()
    const middleware = new HttpAccessLogMiddleware(logger, new LogContextService(), createOptions())
    const first = createRequest()
    const { res: firstRes } = createResponse()
    const second = createRequest()
    const { res: secondRes } = createResponse()

    middleware.use(first, firstRes, jest.fn())
    middleware.use(first, firstRes, jest.fn())
    info.mockClear()
    middleware.use(second, secondRes, jest.fn())

    expect(info).toHaveBeenCalledTimes(1)
  })
})
