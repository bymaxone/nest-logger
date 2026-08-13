/**
 * HTTP access logging, recorded from middleware.
 *
 * Layer: server/middlewares — emits `HTTP_REQUEST_START` on arrival and one
 * terminal entry when the connection closes, for EVERY request.
 *
 * Why middleware and not the interceptor. NestJS runs
 * middleware → guards → interceptors → pipes → handler. An interceptor therefore
 * never sees a request a guard rejected, and never sees one that matched no
 * route at all. Measured against a real backend: 401, 403, 429 from a throttler
 * and 404 for an unknown path produced NO log line — not even START — so brute
 * force, credential stuffing and route enumeration were invisible, and invisible
 * without a `trace_id`, which is the case where correlation matters most.
 * Middleware runs before guards, so it sees everything.
 *
 * Why `'close'` and not `'finish'`. Measured on Node 24: a completed response
 * fires `finish` then `close`; an ABORTED one fires only `close`. `'finish'`
 * means "the response was sent", `'close'` means "the request completed OR the
 * connection was terminated prematurely". A `finish`-only hook is blind to
 * exactly the traffic this exists to reveal — the client that hangs up, the
 * load-balancer timeout, the cancelled brute-force attempt. `writableFinished`
 * then separates the two, so an aborted request is not logged as the success the
 * handler intended.
 *
 * Why the listener is bound. An `AsyncLocalStorage` store does NOT reach an
 * `EventEmitter` listener just because the listener was registered inside
 * `run()` — Node's own docs say a listener "may be run in a different execution
 * context than the one that was active when `eventEmitter.on()` was called", and
 * use `req.on('close', ...)` as the example. Measured here: on the normal path
 * the store is readable by accident (the response ends inside the scope), and on
 * the ABORTED path it is `undefined`, because `close` is emitted from the
 * socket's context. Capturing values into locals would not save it either: the
 * correlation fields are read from the store by the Pino mixin at the moment the
 * line is built. `AsyncResource.bind` restores the whole context, which is what
 * the mixin needs.
 */
import { AsyncResource } from 'node:async_hooks'

import { Inject, Injectable } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'

import { RESERVED_LOG_KEYS } from '../../shared/constants/reserved-log-keys.constants'
import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import type {
  LoggableRequest,
  LoggableResponse,
  NextHandler
} from '../interfaces/http-context.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { PinoLoggerService } from '../services/pino-logger.service'
import {
  HTTP_CLIENT_ERROR_MIN,
  HTTP_REDIRECT_MIN,
  HTTP_SERVER_ERROR_MIN,
  markRecorderActive,
  readRecordedError,
  readUserAgent,
  readUserId
} from '../utils/http-log-state.util'
import { normalizeUrl, stripQueryString } from '../utils/normalize-url.util'

/**
 * Records the HTTP access log for every request, including the ones no
 * interceptor can observe.
 */
@Injectable()
export class HttpAccessLogMiddleware implements NestMiddleware {
  /** Whether HTTP logging is on at all (`http.isEnabled`). */
  private readonly isEnabled: boolean
  /** Path patterns that bypass HTTP logging entirely (health checks, metrics). */
  private readonly excludePaths: readonly RegExp[]

  /**
   * @param logger - The structured logger the access entries are written to.
   *   Injected by token explicitly: the package is bundled without
   *   `emitDecoratorMetadata`, so implicit class-type injection would not resolve.
   * @param options - Resolved module options (read for `http.excludePaths`).
   */
  constructor(
    @Inject(PinoLoggerService) private readonly logger: PinoLoggerService,
    @Inject(LOGGER_OPTIONS_TOKEN) options: ResolvedBymaxLoggerModuleOptions
  ) {
    this.isEnabled = options.http.isEnabled
    this.excludePaths = options.http.excludePaths
  }

  /**
   * Emit START, arm the terminal entry on `'close'`, and continue the chain.
   *
   * @param req - The incoming request (Express satisfies the contract).
   * @param res - The outgoing response (Express satisfies the contract).
   * @param next - The next handler in the chain.
   */
  use(req: LoggableRequest, res: LoggableResponse, next: NextHandler): void {
    // `applyRequestIdMiddleware` is ALSO the public wiring for correlation alone,
    // and `http.isEnabled` defaults to false. Registering this middleware there
    // would otherwise start emitting an access log for consumers who asked only
    // for a `requestId` — and the claim below would silence the interceptor for a
    // request nothing logs. The flag is checked before both.
    if (!this.isEnabled) {
      next()
      return
    }

    // `originalUrl` first: this middleware is MOUNTED, and a mounted middleware
    // sees `url` relative to its mount point. Under `setGlobalPrefix('api')` a
    // request for `/api/users/7` arrives here as `/users/7`, so logging `url`
    // would drop the prefix from every entry and stop an `excludePaths` pattern
    // written against the real path from matching.
    const target = req.originalUrl ?? req.url
    const path = stripQueryString(target)
    // Excluded paths bypass logging entirely — no START, no terminal entry — so
    // health-check and metrics traffic does not flood the sink. The recorder is
    // NOT marked active here, so the interceptor keeps its own exclude handling
    // and the two agree on what is skipped.
    if (this.excludePaths.some((pattern) => pattern.test(path))) {
      next()
      return
    }

    // Claim the lifecycle BEFORE `next()`: the interceptor runs downstream and
    // checks this mark to stay silent, which is what keeps every request to one
    // START and one terminal entry rather than two of each.
    markRecorderActive(req)

    const method = req.method
    const url = normalizeUrl(target)
    const start = Date.now()

    this.logger.info(RESERVED_LOG_KEYS.HTTP_REQUEST_START, `${method} ${url}`, readUserId(req), {
      method,
      url,
      // Query string stripped: it may carry secrets (reset tokens, OAuth codes)
      // that no key-name redaction can scrub out of a string VALUE.
      fullUrl: path,
      // Conventional for an access log and personal data under GDPR/LGPD. Its
      // fidelity is the app's to establish: behind a proxy it is only the real
      // client when the app configures `trust proxy`, and a value the app has not
      // established is attacker-chosen. Suppress with `redactPaths: ['ip']`.
      ip: req.ip,
      userAgent: readUserAgent(req)
    })

    res.on(
      'close',
      AsyncResource.bind(() => {
        this.logTerminal(req, res, method, url, Date.now() - start)
      })
    )

    next()
  }

  /**
   * Emit the terminal entry for a closed request.
   *
   * `userId` is read HERE rather than at START because authentication runs in a
   * guard, downstream of this middleware — at START there is no principal yet.
   *
   * @param req - The request, carrying any error the interceptor recorded.
   * @param res - The closed response.
   * @param method - The HTTP method.
   * @param url - The normalized request URL.
   * @param duration - Elapsed milliseconds.
   */
  private logTerminal(
    req: LoggableRequest,
    res: LoggableResponse,
    method: string,
    url: string,
    duration: number
  ): void {
    const statusCode = res.statusCode
    const userId = readUserId(req)
    const meta = { method, url, statusCode, duration }

    // Delivery is a SEPARATE axis from status, and conflating them is what made
    // an aborted request read as a success. The status stays whatever the server
    // produced — inventing one (nginx's non-standard 499; IANA has 452–499
    // unassigned) would assert a code the server never emitted and break any
    // consumer grouping by class. The KEY carries the delivery failure instead.
    if (!res.writableFinished) {
      this.logger.warnStructured(
        RESERVED_LOG_KEYS.HTTP_REQUEST_ABORTED,
        `${method} ${url} → ${statusCode} not delivered (${duration}ms)`,
        userId,
        meta
      )
      return
    }

    if (statusCode >= HTTP_SERVER_ERROR_MIN) {
      // The interceptor records the thrown value on its way past, so a 5xx that
      // threw carries its real stack. A 5xx that did NOT throw — a filter or a
      // guard set the status directly — still gets an error-level structured
      // line rather than degrading to info; it just has nothing to attach.
      const recorded = readRecordedError(req)
      this.logger.errorStructured(
        RESERVED_LOG_KEYS.HTTP_REQUEST_SERVER_ERROR,
        recorded?.error ?? new Error(`${method} ${url} → ${statusCode}`),
        userId,
        meta
      )
      return
    }

    if (statusCode >= HTTP_CLIENT_ERROR_MIN) {
      // The line a guard rejection produces, and the reason this file exists.
      //
      // `errorMessage` is carried when something threw, because the interceptor's
      // 4xx entry included it and dropping it would silently narrow the log schema
      // for consumers already querying that field. It is ABSENT for a rejection
      // that never threw through the interceptor — a guard rejection resolved by
      // an exception filter, or a status set directly — rather than being filled
      // with an empty string, so "no message" stays distinguishable from "".
      const recorded = readRecordedError(req)
      this.logger.warnStructured(
        RESERVED_LOG_KEYS.HTTP_REQUEST_CLIENT_ERROR,
        `${method} ${url} → ${statusCode}`,
        userId,
        recorded === undefined ? meta : { ...meta, errorMessage: recorded.error.message }
      )
      return
    }

    this.logger.info(
      statusCode >= HTTP_REDIRECT_MIN
        ? RESERVED_LOG_KEYS.HTTP_REQUEST_REDIRECT
        : RESERVED_LOG_KEYS.HTTP_REQUEST_SUCCESS,
      `${method} ${url} → ${statusCode} (${duration}ms)`,
      userId,
      meta
    )
  }
}
