import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException
} from '@nestjs/common'
import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { of, throwError } from 'rxjs'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import { applyDefaults } from '../config/default-options'
import type { PinoLoggerService } from '../services/pino-logger.service'
import { markRecorderActive, readRecordedError } from '../utils/http-log-state.util'

import { HttpLoggingInterceptor } from './http-logging.interceptor'

interface Run {
  readonly info: jest.Mock
  readonly warn: jest.Mock
  readonly error: jest.Mock
  /** What the stream raised, or `undefined` when it completed. */
  readonly raised: unknown
}

interface RequestSpec {
  readonly url?: string
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly user?: { sub?: string; id?: string }
  readonly fails?: unknown
}

/**
 * Drives `HttpLoggingInterceptor.intercept` for one request with a logger double and request,
 * response and handler doubles: the handler completes, or raises `fails`; the response carries
 * `status`. The options are the module defaults with HTTP logging on.
 */
async function run(spec: RequestSpec = {}): Promise<Run> {
  const info = jest.fn()
  const warn = jest.fn()
  const error = jest.fn()
  const logger = {
    info,
    warnStructured: warn,
    errorStructured: error
  } as unknown as PinoLoggerService
  const options = applyDefaults({
    service: { name: 'interceptor-test', version: '1.0.0' },
    http: { isEnabled: true, shouldCaptureExceptions: false }
  })
  const interceptor = new HttpLoggingInterceptor(logger, options)
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        url: spec.url ?? '/probe',
        ip: '127.0.0.1',
        headers: spec.headers ?? {},
        ...(spec.user === undefined ? {} : { user: spec.user })
      }),
      getResponse: () => ({ statusCode: spec.status ?? 200 })
    })
  } as unknown as ExecutionContext
  const handler: CallHandler = {
    handle: () => ('fails' in spec ? throwError(() => spec.fails) : of(undefined))
  }

  const raised = await new Promise<unknown>((resolve) => {
    interceptor.intercept(context, handler).subscribe({
      error: (error_: unknown) => resolve(error_),
      complete: () => resolve(undefined)
    })
  })

  return { info, warn, error, raised }
}

describe('HttpLoggingInterceptor', () => {
  it(/*
   * A 2xx response must emit START then SUCCESS, and the high-cardinality id in
   * the path must be normalized to `/:id` in both entries.
   */
  'logs START and SUCCESS with a normalized URL for a 2xx response', async () => {
    const { info } = await run({
      url: '/ok/123e4567-e89b-12d3-a456-426614174000',
      headers: { 'user-agent': 'jest-agent/9.9' }
    })

    expect(info).toHaveBeenCalledWith(
      'HTTP_REQUEST_START',
      expect.any(String),
      undefined,
      // A provided User-Agent must be captured verbatim (covers the string branch).
      expect.objectContaining({ method: 'GET', url: '/ok/:id', userAgent: 'jest-agent/9.9' })
    )
    expect(info).toHaveBeenCalledWith(
      'HTTP_REQUEST_SUCCESS',
      expect.any(String),
      undefined,
      expect.objectContaining({ statusCode: 200, url: '/ok/:id' })
    )
  })

  it(/*
   * A 3xx response must emit REDIRECT (not SUCCESS) — covers the redirect branch
   * of the success logger.
   */
  'logs REDIRECT for a 3xx response', async () => {
    const { info } = await run({ status: 302 })

    expect(info).toHaveBeenCalledWith(
      'HTTP_REQUEST_REDIRECT',
      expect.stringContaining('→ 302'),
      undefined,
      expect.objectContaining({ statusCode: 302 })
    )
  })

  it(/*
   * A non-throwing response outside 2xx/3xx (a 418) must emit only START — covers
   * the "neither success nor redirect" fall-through with no terminal log.
   */
  'logs only START for a non-2xx/3xx non-throwing response', async () => {
    const { info } = await run({ url: '/teapot', status: 418 })

    expect(info).toHaveBeenCalledWith(
      'HTTP_REQUEST_START',
      expect.any(String),
      undefined,
      expect.objectContaining({ url: '/teapot' })
    )
    const terminalKeys = info.mock.calls.map((call) => call[0])
    expect(terminalKeys).not.toContain('HTTP_REQUEST_SUCCESS')
    expect(terminalKeys).not.toContain('HTTP_REQUEST_REDIRECT')
  })

  it(/*
   * The library builds `errorMessage` from the thrown value, so it is cut at the same limit as
   * every other message it copies from a value it does not own.
   */
  'cuts errorMessage on a 4xx at the message limit', async () => {
    const { warn } = await run({ status: 400, fails: new BadRequestException('x'.repeat(100_000)) })

    expect(warn).toHaveBeenCalledWith(
      'HTTP_REQUEST_CLIENT_ERROR',
      expect.stringContaining('→ 400'),
      undefined,
      expect.objectContaining({ errorMessage: 'x'.repeat(16_384) + '…[truncated]' })
    )
  })

  it(/*
   * `message` is typed as a string, but a thrown value can carry anything. The cut applies only
   * to a string, and the interceptor still raises the error it was given.
   */
  'copies errorMessage as given when the message of the error is not a string', async () => {
    const failure = Object.assign(new BadRequestException('x'), { message: 42 })

    const { warn, raised } = await run({ status: 400, fails: failure })

    expect(warn).toHaveBeenCalledWith(
      'HTTP_REQUEST_CLIENT_ERROR',
      expect.stringContaining('→ 400'),
      undefined,
      expect.objectContaining({ errorMessage: 42 })
    )
    expect(raised).toBe(failure)
  })

  it(/*
   * A 4xx HttpException must emit CLIENT_ERROR at warn level (with the error
   * message) and the exception must still propagate.
   */
  'logs CLIENT_ERROR (warn) for a 4xx and propagates it', async () => {
    const failure = new BadRequestException('bad input')

    const { warn, error, raised } = await run({ status: 400, fails: failure })

    expect(warn).toHaveBeenCalledWith(
      'HTTP_REQUEST_CLIENT_ERROR',
      expect.stringContaining('→ 400'),
      undefined,
      expect.objectContaining({ statusCode: 400, errorMessage: 'bad input' })
    )
    expect(error).not.toHaveBeenCalled()
    expect(raised).toBe(failure)
  })

  it.each([
    ['status', { status: 413, expose: true }, 413],
    ['statusCode', { statusCode: 415, expose: true }, 415],
    ['a plain 400', { status: 400, expose: true }, 400]
  ])(
    /*
     * An error that is not an HttpException but carries the `http-errors` shape (what the body
     * parser raises) is a client error too: CLIENT_ERROR at warn level, with the status it exposes
     * in the message and in `statusCode`, and the error is raised as it was thrown.
     */
    'logs CLIENT_ERROR with the status of an exposed http-errors error, read from %s',
    async (_name, fields, code) => {
      const failure = Object.assign(new Error('refused'), fields)

      const { warn, error, raised } = await run({ status: code, fails: failure })

      expect(warn).toHaveBeenCalledWith(
        'HTTP_REQUEST_CLIENT_ERROR',
        `GET /probe → ${code}`,
        undefined,
        expect.objectContaining({ method: 'GET', url: '/probe', statusCode: code })
      )
      expect(error).not.toHaveBeenCalled()
      expect(raised).toBe(failure)
    }
  )

  it(/*
   * For an error of a type whose message quotes the request body the entry carries the fixed text
   * and the parser type, never the message: no key-name redaction can censor a piece of the body
   * out of free text.
   */
  'logs the fixed text and the parser type for an exposed error that quotes the body', async () => {
    const failure = Object.assign(
      new Error(`Unexpected token 'h', "hunter2-SENTINEL" is not valid JSON`),
      { status: 400, expose: true, type: 'entity.parse.failed' }
    )

    const { warn } = await run({ status: 400, fails: failure })

    expect(warn).toHaveBeenCalledWith(
      'HTTP_REQUEST_CLIENT_ERROR',
      'GET /probe → 400',
      undefined,
      expect.objectContaining({
        errorMessage: 'request body could not be parsed',
        bodyParserType: 'entity.parse.failed'
      })
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2')
  })

  it(/*
   * A plain Error must emit SERVER_ERROR (error level, with the Error) and
   * propagate — the exception is logged, never swallowed.
   */
  'logs SERVER_ERROR for a thrown Error and propagates it', async () => {
    const failure = new Error('kaboom')

    const { error, raised } = await run({ status: 500, fails: failure })

    expect(error).toHaveBeenCalledWith(
      'HTTP_REQUEST_SERVER_ERROR',
      failure,
      undefined,
      expect.objectContaining({ statusCode: 500 })
    )
    expect(raised).toBe(failure)
  })

  it(/*
   * A 5xx HttpException must also map to SERVER_ERROR — covers the HttpException
   * branch at/above 500.
   */
  'logs SERVER_ERROR for a 5xx HttpException', async () => {
    const failure = new InternalServerErrorException('explicit 500')

    const { error } = await run({ status: 500, fails: failure })

    expect(error).toHaveBeenCalledWith(
      'HTTP_REQUEST_SERVER_ERROR',
      expect.any(Error),
      undefined,
      expect.objectContaining({ statusCode: 500 })
    )
  })

  it(/*
   * A non-Error throw must be wrapped into an Error for the SERVER_ERROR log —
   * covers the `err instanceof Error` false branch — and still be raised as it was thrown.
   */
  'wraps a non-Error throw into an Error for SERVER_ERROR', async () => {
    const { error, raised } = await run({ status: 500, fails: 'plain string failure' })

    expect(error).toHaveBeenCalledWith(
      'HTTP_REQUEST_SERVER_ERROR',
      expect.any(Error),
      undefined,
      expect.objectContaining({ statusCode: 500 })
    )
    expect(raised).toBe('plain string failure')
  })

  it.each([
    ['req.user.id when it is the only field', { id: 'u_1' }, 'u_1'],
    ['req.user.sub when id is absent (a JWT principal)', { sub: 's_1' }, 's_1'],
    // An `id ?? sub` swap would attribute the log to the ORM id instead.
    ['req.user.sub over req.user.id when both are present', { sub: 's_2', id: 'u_2' }, 's_2']
  ])('extracts the acting user from %s', async (_name, user, expected) => {
    const { info } = await run({ user })

    expect(info).toHaveBeenCalledWith(
      'HTTP_REQUEST_START',
      expect.any(String),
      expected,
      expect.objectContaining({ method: 'GET' })
    )
  })

  it(/*
   * A missing User-Agent header must fall back to 'unknown' — covers the
   * non-string branch of the user-agent read.
   */
  'falls back to "unknown" when the User-Agent header is absent', async () => {
    const { info } = await run({ status: 418 })

    expect(info).toHaveBeenCalledWith(
      'HTTP_REQUEST_START',
      expect.any(String),
      undefined,
      expect.objectContaining({ userAgent: 'unknown' })
    )
  })

  it(/*
   * A path matching the default excludePaths (`/health`) must bypass logging
   * entirely — no START and no terminal entry — so monitoring probes never flood
   * the logs. Covers the isExcluded() true branch.
   */
  'skips logging for an excluded path', async () => {
    const { info } = await run({ url: '/health' })

    expect(info).not.toHaveBeenCalled()
  })

  it(/*
   * The START and SUCCESS entries must carry human-readable messages (not empty
   * strings) and a sane, non-negative duration. Pins the message templates and
   * the `Date.now() - start` duration arithmetic (a `+` would yield an
   * epoch-sized number).
   */
  'emits readable START/SUCCESS messages and a sane duration', async () => {
    const { info } = await run({ url: '/ok/4bf92f35-77b3-4da6-a3ce-929d0e0e4736' })

    const start = info.mock.calls.find((call) => call[0] === 'HTTP_REQUEST_START')
    const success = info.mock.calls.find((call) => call[0] === 'HTTP_REQUEST_SUCCESS')
    expect(start?.[1]).toContain('GET /ok/:id')
    expect(success?.[1]).toContain('→ 200')
    const duration = (success?.[3] as { duration: number }).duration
    expect(duration).toBeGreaterThanOrEqual(0)
    expect(duration).toBeLessThan(60_000)
  })

  it(/*
   * Exactly 300 is the REDIRECT lower boundary: it must log REDIRECT, never
   * SUCCESS. Pins `statusCode < HTTP_REDIRECT_MIN` (success upper bound) and
   * `statusCode >= HTTP_REDIRECT_MIN` (redirect lower bound).
   */
  'logs REDIRECT (not SUCCESS) at the 300 boundary', async () => {
    const { info } = await run({ status: 300 })

    const keys = info.mock.calls.map((call) => call[0])
    expect(keys).toContain('HTTP_REQUEST_REDIRECT')
    expect(keys).not.toContain('HTTP_REQUEST_SUCCESS')
  })

  it(/*
   * A non-throwing 400 is the REDIRECT upper boundary: it must log only START
   * (neither REDIRECT nor SUCCESS). Pins `statusCode < HTTP_CLIENT_ERROR_MIN`.
   */
  'logs only START for a non-throwing 400', async () => {
    const { info } = await run({ status: 400 })

    const keys = info.mock.calls.map((call) => call[0])
    expect(keys).toContain('HTTP_REQUEST_START')
    expect(keys).not.toContain('HTTP_REQUEST_REDIRECT')
    expect(keys).not.toContain('HTTP_REQUEST_SUCCESS')
  })

  it(/*
   * The error path must also report a sane, non-negative duration — pins the
   * `Date.now() - start` arithmetic in the catchError branch.
   */
  'reports a sane duration on the error path', async () => {
    const { error } = await run({ status: 500, fails: new Error('kaboom') })

    const errorCall = error.mock.calls.find((call) => call[0] === 'HTTP_REQUEST_SERVER_ERROR')
    const duration = (errorCall?.[3] as { duration: number }).duration
    expect(duration).toBeGreaterThanOrEqual(0)
    expect(duration).toBeLessThan(60_000)
  })
})

describe('HttpLoggingInterceptor unit', () => {
  /**
   * Build a minimal interceptor with mocked logger and options — no HTTP server,
   * no NestJS app bootstrap. Used to test statusCode boundary conditions that
   * cannot be exercised reliably via supertest (e.g. 1xx responses never reach
   * the handler in a real HTTP stack).
   */
  function makeInterceptor(infoFn: jest.Mock): HttpLoggingInterceptor {
    const logger = { info: infoFn, warnStructured: jest.fn(), errorStructured: jest.fn() } as never
    const opts = { http: { excludePaths: [] } } as never
    return new HttpLoggingInterceptor(logger, opts)
  }

  function makeCtx(statusCode: number): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/probe', ip: '127.0.0.1', headers: {} }),
        getResponse: () => ({ statusCode })
      })
    } as never
  }

  it(/*
   * A 1xx (informational) response is neither 2xx nor 3xx, so logSuccess must
   * emit only the START entry. Pins the `statusCode >= HTTP_SUCCESS_MIN` (≥ 200)
   * guard — a mutation to `true` would incorrectly log SUCCESS for 1xx.
   */
  'logs only START (not SUCCESS or REDIRECT) for a 1xx response', async () => {
    const infoSpy = jest.fn()
    const interceptor = makeInterceptor(infoSpy)
    const callHandler: CallHandler = { handle: () => of(undefined) }

    await new Promise<void>((resolve, reject) => {
      interceptor
        .intercept(makeCtx(100), callHandler)
        .subscribe({ complete: resolve, error: reject })
    })

    const keys = (infoSpy.mock.calls as unknown[][]).map((c) => c[0])
    expect(keys).toContain(RESERVED_LOG_KEYS.HTTP_REQUEST_START)
    expect(keys).not.toContain(RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS)
    expect(keys).not.toContain(RESERVED_LOG_KEYS.HTTP_REQUEST_REDIRECT)
  })

  it.each([
    ['an HttpException', (message: string): unknown => new NotFoundException(message)],
    [
      'an exposed http-errors client error',
      (message: string): unknown => Object.assign(new Error(message), { status: 404, expose: true })
    ]
  ])(
    /*
     * A handler that words its error with the URL it was called on puts the query string in
     * `errorMessage`, which no key-name redaction can censor out of a string. The request carries
     * the query in `originalUrl` and in the relative `url` of a mounted request, and both are cut.
     */
    'cuts the query string of the request out of errorMessage on a 4xx, for %s',
    async (_name, make) => {
      const warn = jest.fn()
      const logger = { info: jest.fn(), warnStructured: warn, errorStructured: jest.fn() } as never
      const interceptor = new HttpLoggingInterceptor(logger, {
        http: { excludePaths: [] }
      } as never)
      const query = '?code=SECRET-CODE&token=SECRET-TOKEN'
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({
            method: 'GET',
            url: `/x${query}`,
            originalUrl: `/api/x${query}`,
            ip: '127.0.0.1',
            headers: {}
          }),
          getResponse: () => ({ statusCode: 404 })
        })
      } as never
      const callHandler: CallHandler = {
        handle: () => throwError(() => make(`Cannot GET /api/x${query}`))
      }

      await new Promise<void>((resolve) => {
        interceptor.intercept(ctx, callHandler).subscribe({ error: () => resolve() })
      })

      expect(warn).toHaveBeenCalledWith(
        RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR,
        expect.any(String),
        undefined,
        expect.objectContaining({ errorMessage: 'Cannot GET /api/x' })
      )
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET')
    }
  )

  /** Context whose request the access-log middleware already claimed. */
  function makeClaimedCtx(req: object): ExecutionContext {
    markRecorderActive(req)
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ statusCode: 200 })
      })
    } as never
  }

  it(/*
   * REGRESSION — when the middleware owns the lifecycle the interceptor must not
   * emit anything. Both observe an ordinary request, so emitting here too would
   * double every START and terminal line while still leaving the requests only
   * the middleware sees uncovered.
   */
  'emits nothing when the access-log middleware claimed the request', async () => {
    const infoSpy = jest.fn()
    const interceptor = makeInterceptor(infoSpy)
    const callHandler: CallHandler = { handle: () => of(undefined) }
    const req = { method: 'GET', url: '/probe', ip: '127.0.0.1', headers: {} }

    await new Promise<void>((resolve, reject) => {
      interceptor
        .intercept(makeClaimedCtx(req), callHandler)
        .subscribe({ complete: resolve, error: reject })
    })

    expect(infoSpy).not.toHaveBeenCalled()
  })

  it(/*
   * What the interceptor uniquely has is the thrown value: the middleware's
   * `'close'` handler sees only a status code, so without this hand-off a 5xx
   * terminal entry would lose its stack. The exception must still propagate —
   * the interceptor observes, it never swallows.
   */
  'records the thrown error for the middleware and re-throws it', async () => {
    const interceptor = makeInterceptor(jest.fn())
    const thrown = new Error('handler exploded')
    const callHandler: CallHandler = { handle: () => throwError(() => thrown) }
    const req = { method: 'GET', url: '/probe', ip: '127.0.0.1', headers: {} }

    const propagated = await new Promise<unknown>((resolve) => {
      interceptor.intercept(makeClaimedCtx(req), callHandler).subscribe({
        error: resolve,
        complete: () => resolve(undefined)
      })
    })

    expect(propagated).toBe(thrown)
    expect(readRecordedError(req)?.error).toBe(thrown)
  })

  it(/*
   * A `throw` can carry anything. The recorded value is normalized to an `Error`
   * so the terminal entry's serializer has a message and a stack to work with.
   */
  'normalizes a non-Error throw before recording it', async () => {
    const interceptor = makeInterceptor(jest.fn())
    const callHandler: CallHandler = { handle: () => throwError(() => 'plain string') }
    const req = { method: 'GET', url: '/probe', ip: '127.0.0.1', headers: {} }

    await new Promise<void>((resolve) => {
      interceptor
        .intercept(makeClaimedCtx(req), callHandler)
        .subscribe({ error: () => resolve(), complete: () => resolve() })
    })

    const recorded = readRecordedError(req)?.error
    expect(recorded).toBeInstanceOf(Error)
    expect(recorded?.message).toBe('plain string')
  })
})
