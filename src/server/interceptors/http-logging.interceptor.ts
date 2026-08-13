/**
 * HTTP request lifecycle logging.
 *
 * Layer: server/interceptors — a global `NestInterceptor` that emits a START log
 * on entry and a terminal log on completion: SUCCESS (2xx), REDIRECT (3xx),
 * CLIENT_ERROR (4xx, warn) or SERVER_ERROR (5xx, error). URLs are normalized
 * (ids collapsed to `/:id`) so log keys stay low-cardinality. Exceptions are
 * always re-thrown — the interceptor observes, it never swallows.
 *
 * The START entry captures the client `ip` (conventional for access logs, but
 * personal data under GDPR/CCPA): consumers in regulated contexts can suppress it
 * by adding `'ip'` to `redactPaths`. The query string is stripped from every
 * logged URL so secrets in query parameters never reach the sink.
 *
 * Registered as `APP_INTERCEPTOR` by `BymaxLoggerModule` when `http.isEnabled`.
 */
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common'
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { catchError, tap, throwError } from 'rxjs'
import type { Observable } from 'rxjs'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { PinoLoggerService } from '../services/pino-logger.service'
import {
  HTTP_CLIENT_ERROR_MIN,
  HTTP_REDIRECT_MIN,
  HTTP_SERVER_ERROR_MIN,
  isRecorderActive,
  readUserAgent,
  readUserId,
  recordError,
  toError
} from '../utils/http-log-state.util'
import { normalizeUrl, stripQueryString } from '../utils/normalize-url.util'

/** Lower bound of the HTTP success (2xx) range. */
const HTTP_SUCCESS_MIN = 200

/**
 * Logs the full HTTP request lifecycle through a Pino-backed logger.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  /** Path patterns that bypass HTTP logging entirely (health checks, metrics). */
  private readonly excludePaths: readonly RegExp[]

  /**
   * @param logger - The structured logger the lifecycle entries are written to.
   *   Injected by token explicitly: the package is bundled without
   *   `emitDecoratorMetadata`, so implicit class-type injection would not resolve.
   * @param options - Resolved module options (read for `http.excludePaths`).
   *   Injected by token for the same bundling reason.
   */
  constructor(
    @Inject(PinoLoggerService) private readonly logger: PinoLoggerService,
    @Inject(LOGGER_OPTIONS_TOKEN) options: ResolvedBymaxLoggerModuleOptions
  ) {
    this.excludePaths = options.http.excludePaths
  }

  /**
   * Whether a request path bypasses HTTP logging (matches any `excludePaths`).
   *
   * @param path - The query-stripped request path.
   * @returns `true` when the path matches a configured exclude pattern.
   */
  private isExcluded(path: string): boolean {
    return this.excludePaths.some((pattern) => pattern.test(path))
  }

  /**
   * Emit the START entry, then attach success/redirect/error logging to the
   * downstream observable while always re-propagating any thrown exception.
   *
   * @param context - The current execution context (HTTP).
   * @param next - The downstream call handler.
   * @returns The (unmodified) response stream.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp()
    const req = http.getRequest<LoggableRequest>()
    const res = http.getResponse<LoggableResponse>()

    // The middleware runs before guards and already claimed this request, so it
    // emits START and the terminal entry. Emitting here too would double every
    // line for the requests BOTH can see, while still leaving the ones only the
    // middleware sees uncovered.
    if (isRecorderActive(req)) {
      return this.recordOnly(req, next)
    }

    const { method, url, ip } = req

    // Excluded paths (health checks, metrics) bypass logging entirely — no START
    // and no terminal entry — so monitoring traffic does not flood the logs.
    if (this.isExcluded(stripQueryString(url))) {
      return next.handle()
    }

    const userAgent = readUserAgent(req)
    const userId = readUserId(req)
    const normalizedUrl = normalizeUrl(url)
    const start = Date.now()

    this.logger.info(RESERVED_LOG_KEYS.HTTP_REQUEST_START, `${method} ${normalizedUrl}`, userId, {
      method,
      url: normalizedUrl,
      // Query string stripped: it may carry secrets (reset tokens, OAuth codes)
      // that Pino's path-based redaction cannot scrub from a string value. The
      // raw (un-normalized) path is kept for per-request debugging.
      fullUrl: stripQueryString(url),
      ip,
      userAgent
    })

    return next.handle().pipe(
      tap(() => {
        this.logSuccess(res.statusCode, method, normalizedUrl, userId, Date.now() - start)
      }),
      catchError((err: unknown) => {
        this.logError(err, method, normalizedUrl, userId, Date.now() - start)
        return throwError(() => err)
      })
    )
  }

  /**
   * Hand the lifecycle to the access-log middleware, recording only the thrown
   * error for its terminal entry.
   *
   * The interceptor cannot be the recorder: it never runs for a request a guard
   * rejected or one that matched no route. It also cannot judge DELIVERY — at the
   * moment it completes, the response has not been flushed yet, which is why an
   * aborted request used to be logged as the 200 the handler intended. What it
   * uniquely has is the thrown value, so that is all it contributes.
   *
   * @param req - The request whose lifecycle the middleware owns.
   * @param next - The downstream call handler.
   * @returns The response stream, unmodified and with exceptions re-thrown.
   */
  private recordOnly(req: LoggableRequest, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        recordError(req, toError(err))
        return throwError(() => err)
      })
    )
  }

  /**
   * Log a non-throwing completion: SUCCESS for 2xx, REDIRECT for 3xx, nothing
   * for any other status (those are surfaced via the error path instead).
   *
   * @param statusCode - The final response status code.
   * @param method - The HTTP method.
   * @param url - The normalized request URL.
   * @param userId - The acting user id, when known.
   * @param duration - The elapsed time in milliseconds.
   */
  private logSuccess(
    statusCode: number,
    method: string,
    url: string,
    userId: string | undefined,
    duration: number
  ): void {
    if (statusCode >= HTTP_SUCCESS_MIN && statusCode < HTTP_REDIRECT_MIN) {
      this.logger.info(
        RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS,
        `${method} ${url} → ${statusCode} (${duration}ms)`,
        userId,
        { method, url, statusCode, duration }
      )
    } else if (statusCode >= HTTP_REDIRECT_MIN && statusCode < HTTP_CLIENT_ERROR_MIN) {
      this.logger.info(
        RESERVED_LOG_KEYS.HTTP_REQUEST_REDIRECT,
        `${method} ${url} → ${statusCode}`,
        userId,
        { method, url, statusCode, duration }
      )
    }
  }

  /**
   * Log a thrown completion: SERVER_ERROR (error level, with stack) for 5xx,
   * CLIENT_ERROR (warn level) for an `HttpException` below 500. A non-`HttpException`
   * always maps to 500, so it is reported as a server error.
   *
   * @param err - The thrown value (anything).
   * @param method - The HTTP method.
   * @param url - The normalized request URL.
   * @param userId - The acting user id, when known.
   * @param duration - The elapsed time in milliseconds.
   */
  private logError(
    err: unknown,
    method: string,
    url: string,
    userId: string | undefined,
    duration: number
  ): void {
    if (err instanceof HttpException) {
      const statusCode = err.getStatus()
      if (statusCode >= HTTP_SERVER_ERROR_MIN) {
        this.logger.errorStructured(RESERVED_LOG_KEYS.HTTP_REQUEST_SERVER_ERROR, err, userId, {
          method,
          url,
          statusCode,
          duration
        })
      } else {
        this.logger.warnStructured(
          RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR,
          `${method} ${url} → ${statusCode}`,
          userId,
          { method, url, statusCode, duration, errorMessage: err.message }
        )
      }
      return
    }

    // A non-HttpException never carries a status, so it is always a 500.
    this.logger.errorStructured(RESERVED_LOG_KEYS.HTTP_REQUEST_SERVER_ERROR, toError(err), userId, {
      method,
      url,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      duration
    })
  }
}
