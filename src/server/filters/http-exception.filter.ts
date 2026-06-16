/**
 * Catch-all HTTP exception filter.
 *
 * Layer: server/filters — a universal `@Catch()` filter that logs any exception
 * escaping the request pipeline and writes a JSON error response. `HttpException`
 * carries its own status/body; anything else is treated as an unhandled 500.
 * The level follows the status: 5xx → error (with a sanitized stack), 4xx → warn.
 *
 * For an `HttpException` the response body is the exception's own `getResponse()`
 * payload (standard NestJS behavior), so callers control what a client sees —
 * never put internal detail in a thrown `HttpException`. A non-`HttpException`
 * always returns the fixed, detail-free `{ statusCode: 500, message: 'Internal
 * server error' }`.
 *
 * The logged `url` has its query string stripped (`stripQueryString`): query
 * params routinely carry secrets (reset tokens, OAuth codes, signed-URL
 * signatures) and Pino's `redact.paths` cannot scrub a substring inside a string
 * value — so the query must be removed before the URL is logged, exactly as the
 * request interceptor already does.
 *
 * Registered as `APP_FILTER` by `BymaxLoggerModule` when `http.isEnabled` and
 * `http.shouldCaptureExceptions` are both set.
 */
import { Catch, HttpException, HttpStatus, Inject } from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import type { Response } from 'express'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { RequestWithUser } from '../interfaces/request-with-user.interface'
import { PinoLoggerService } from '../services/pino-logger.service'
import { stripQueryString } from '../utils/normalize-url.util'
import { sanitizeError } from '../utils/sanitize-error.util'

/** Body returned when a non-`HttpException` reaches the filter. */
const INTERNAL_ERROR_BODY = {
  statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
  message: 'Internal server error'
}

/**
 * Logs and renders any exception that escapes the request pipeline.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  /**
   * @param logger - The structured logger exception entries are written to.
   *   Injected by token explicitly: the package is bundled without
   *   `emitDecoratorMetadata`, so implicit class-type injection would not resolve.
   */
  constructor(@Inject(PinoLoggerService) private readonly logger: PinoLoggerService) {}

  /**
   * Log the exception at the status-appropriate level and write the JSON
   * response.
   *
   * @param exception - The thrown value (anything).
   * @param host - The arguments host (switched to HTTP).
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    const req = ctx.getRequest<RequestWithUser>()
    const userId = req.user?.id
    // Strip the query string: it may carry secrets and cannot be redacted as a
    // substring once embedded in the logged `url` string.
    const url = stripQueryString(req.url)

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const metadata = { method: req.method, url, status }
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        // sanitizeError guarantees (1) no-throw on a hostile exception and (2)
        // node_modules/ stack scrubbing. Note: errorStructured re-serializes to
        // name/message/stack only, so the cause chain / AggregateError.errors
        // sanitizeError can produce are dropped at that boundary (full cause-chain
        // logging lands when errorStructured is extended — roadmap).
        this.logger.errorStructured(
          RESERVED_LOG_KEYS.HTTP_EXCEPTION_UNHANDLED,
          sanitizeError(exception),
          userId,
          metadata
        )
      } else {
        this.logger.warnStructured(
          RESERVED_LOG_KEYS.HTTP_EXCEPTION_HANDLED,
          exception.message,
          userId,
          metadata
        )
      }
      res.status(status).json(exception.getResponse())
      return
    }

    // A non-HttpException is always an unhandled 500.
    const status = HttpStatus.INTERNAL_SERVER_ERROR
    this.logger.errorStructured(
      RESERVED_LOG_KEYS.HTTP_EXCEPTION_UNHANDLED,
      sanitizeError(exception),
      userId,
      {
        method: req.method,
        url,
        status
      }
    )
    res.status(status).json(INTERNAL_ERROR_BODY)
  }
}
