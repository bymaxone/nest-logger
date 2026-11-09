/**
 * Catch-all HTTP exception filter.
 *
 * Layer: server/filters — a universal `@Catch()` filter that logs any exception
 * escaping the request pipeline and writes a JSON error response. `HttpException`
 * carries its own status/body; an error with the `http-errors` shape that exposes a 4xx
 * (`status` or `statusCode` from 400 to 499 and `expose: true`, as the body parser raises for a
 * body over the limit) keeps that status and its message; anything else is an unhandled 500.
 * The level follows the status: 5xx → error (with a sanitized stack), 4xx → warn.
 *
 * For an `HttpException` the response body is the exception's own `getResponse()`
 * payload (standard NestJS behavior), so callers control what a client sees —
 * never put internal detail in a thrown `HttpException`. A non-`HttpException`
 * always returns the fixed, detail-free `{ statusCode: 500, message: 'Internal
 * server error' }`. The `http-errors` shape answers `{ statusCode, message }`.
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

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import type { LoggableRequest, LoggableResponse } from '../interfaces/http-context.interface'
import { PinoLoggerService } from '../services/pino-logger.service'
import { readExposedClientError } from '../utils/exposed-client-error.util'
import type { ExposedClientError } from '../utils/exposed-client-error.util'
import { stripQueryString } from '../utils/normalize-url.util'
import { sanitizeError } from '../utils/sanitize-error.util'

/** The request facts every entry the filter writes carries. */
interface RequestFacts {
  readonly method: string
  readonly url: string
  readonly userId: string | undefined
}

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
    const res = ctx.getResponse<LoggableResponse>()
    const req = ctx.getRequest<LoggableRequest>()
    // `id` for an ORM principal, `sub` for a JWT one — see LoggableRequest. Reading
    // only `id` dropped the acting user from every JWT-authenticated error entry.
    const userId = req.user?.sub ?? req.user?.id
    // Strip the query string: it may carry secrets and cannot be redacted as a
    // substring once embedded in the logged `url` string.
    const url = stripQueryString(req.url)

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const metadata = { method: req.method, url, status }
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        // sanitizeError guarantees (1) no-throw on a hostile exception and (2)
        // node_modules/ stack scrubbing. The node it produces keeps the cause chain,
        // `AggregateError.errors` and the exception's own fields, such as the
        // response body, all the way to the entry: `errorStructured` hands it to the
        // `err` serializer, and the name redaction walks it like the rest of the
        // record.
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

    // An error with the `http-errors` shape that exposes a 4xx keeps its status and message: that is
    // how the body parser refuses a body over the limit or in an unsupported encoding.
    const clientError = readExposedClientError(exception)
    if (clientError !== undefined) {
      this.answerClientError(clientError, res, { method: req.method, url, userId })
      return
    }

    // Any other non-HttpException is an unhandled 500.
    this.answerUnhandled(exception, res, { method: req.method, url, userId })
  }

  /**
   * Log an exposed client error as handled and answer it with its own status and message.
   *
   * @param clientError - The status and message the error exposes.
   * @param res - The response to write.
   * @param request - The request facts every entry carries.
   */
  private answerClientError(
    clientError: ExposedClientError,
    res: LoggableResponse,
    request: RequestFacts
  ): void {
    const { method, url, userId } = request
    // The entry carries the log text, never the message: a body parser words some of its messages
    // with a piece of the request body, and the name redaction cannot censor free text. The
    // response keeps the message, which is the application's concern.
    this.logger.warnStructured(
      RESERVED_LOG_KEYS.HTTP_EXCEPTION_HANDLED,
      clientError.logMessage,
      userId,
      {
        method,
        url,
        status: clientError.status,
        bodyParserType: clientError.bodyParserType
      }
    )
    res.status(clientError.status).json({
      statusCode: clientError.status,
      message: clientError.message
    })
  }

  /**
   * Log any other non-`HttpException` as unhandled and answer it with the fixed 500 body.
   *
   * @param exception - The thrown value.
   * @param res - The response to write.
   * @param request - The request facts every entry carries.
   */
  private answerUnhandled(exception: unknown, res: LoggableResponse, request: RequestFacts): void {
    const { method, url, userId } = request
    const status = HttpStatus.INTERNAL_SERVER_ERROR
    this.logger.errorStructured(
      RESERVED_LOG_KEYS.HTTP_EXCEPTION_UNHANDLED,
      sanitizeError(exception),
      userId,
      { method, url, status }
    )
    res.status(status).json(INTERNAL_ERROR_BODY)
  }
}
