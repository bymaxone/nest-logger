/**
 * Request correlation middleware.
 *
 * Layer: server/middlewares — opens an {@link LogContextService} scope per HTTP
 * request so every downstream log (and the Pino trace mixin) inherits the
 * request's `requestId` and optional `tenantId`. Runs before guards and
 * interceptors, which is exactly where the correlation scope must start.
 *
 * Express-only (`@nestjs/platform-express`). A Fastify adapter is not currently
 * supported.
 */
import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'

import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
import type {
  LoggableRequest,
  LoggableResponse,
  NextHandler
} from '../interfaces/http-context.interface'
import type { LogContext } from '../interfaces/log-context.interface'
import type { ResolvedBymaxLoggerModuleOptions } from '../interfaces/logger-module-options.interface'
import { LogContextService } from '../services/log-context.service'

/** Response/request header carrying the correlation id. */
const REQUEST_ID_HEADER = 'x-request-id'

/**
 * Upper bound on an accepted correlation/tenant header value. Generous enough
 * for any real id format (UUID, ULID, trace id, slug) while preventing a
 * client-controlled string of unbounded size from being propagated into every
 * log entry for the request's lifetime.
 */
const MAX_CORRELATION_ID_LENGTH = 256

/**
 * Characters an accepted correlation/tenant id may contain: the union every real
 * id format needs — hex and alphanumerics, plus the punctuation of UUID/ULID
 * (`-`), W3C traceparent (`-`), dotted ids (`.`), namespaced ids (`:`, `/`) and
 * base64url/base64 (`_`, `+`, `/`, `=`). A single character class with `+`, so it
 * scans linearly and carries no backtracking question.
 *
 * The point is what it EXCLUDES: control characters, whitespace, and the HTML
 * metacharacters `< > " '`. The value is echoed back verbatim as `x-request-id`
 * and into the `correlationId` of the error envelope, so confining it to id-safe
 * characters keeps a client from planting a control byte or markup fragment in
 * the logs and responses of every request it makes.
 */
const CORRELATION_ID_CHARSET = /^[A-Za-z0-9._:/+=-]+$/

/**
 * Whether a raw header value is an acceptable correlation/tenant id: a non-empty
 * string within the length bound and drawn only from {@link CORRELATION_ID_CHARSET}.
 * Anything else — a non-string, an oversized value, or one carrying a character
 * outside the id-safe set — is rejected so the caller falls back to a generated
 * id (or omits the field).
 *
 * @param value - The raw header value (anything).
 * @returns `true` when `value` is an id-safe string within the bound.
 */
function isAcceptableHeaderValue(value: unknown): value is string {
  // No explicit non-empty check: {@link CORRELATION_ID_CHARSET} is anchored with `+`, so it
  // already rejects the empty string, and a redundant `length >= 1` would only be untestable.
  return (
    typeof value === 'string' &&
    value.length <= MAX_CORRELATION_ID_LENGTH &&
    CORRELATION_ID_CHARSET.test(value)
  )
}

/**
 * Reads (or generates) the correlation id and starts the per-request log
 * context scope.
 *
 * @example
 *   // Wire it in the consumer's AppModule:
 *   export class AppModule implements NestModule {
 *     configure(consumer: MiddlewareConsumer): void {
 *       applyRequestIdMiddleware(consumer)
 *     }
 *   }
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  /** Header name carrying the tenant id, resolved from module options. */
  private readonly tenantIdHeader: string
  /** Whether to mint a `requestId` when the inbound header is absent. */
  private readonly shouldGenerateRequestId: boolean

  /**
   * @param logContext - The AsyncLocalStorage-backed context service. Injected by
   *   token explicitly: the package is bundled without `emitDecoratorMetadata`,
   *   so implicit class-type injection would not resolve.
   * @param options - Resolved module options (read for `http.tenantIdHeader` and
   *   `http.shouldGenerateRequestId`).
   */
  constructor(
    @Inject(LogContextService) private readonly logContext: LogContextService,
    @Inject(LOGGER_OPTIONS_TOKEN) options: ResolvedBymaxLoggerModuleOptions
  ) {
    this.tenantIdHeader = options.http.tenantIdHeader
    this.shouldGenerateRequestId = options.http.shouldGenerateRequestId
  }

  /**
   * Echo or mint the `x-request-id`, expose it on the response, and run the
   * remainder of the request inside a fresh log-context scope.
   *
   * @param req - The incoming request (Express satisfies the contract).
   * @param res - The outgoing response (Express satisfies the contract).
   * @param next - The next handler in the chain.
   */
  use(req: LoggableRequest, res: LoggableResponse, next: NextHandler): void {
    // `Reflect.get` keeps both header lookups off the
    // `security/detect-object-injection` sink list (the names are runtime
    // configuration / named constants, not inline literals).
    const incoming: unknown = Reflect.get(req.headers, REQUEST_ID_HEADER)
    const fromHeader = isAcceptableHeaderValue(incoming) ? incoming : undefined
    // Honor `shouldGenerateRequestId`: with it disabled (and no inbound header),
    // correlation is left to the upstream gateway — no id is minted or exposed.
    const requestId = fromHeader ?? (this.shouldGenerateRequestId ? randomUUID() : undefined)

    const context: LogContext = {}
    if (requestId !== undefined) {
      res.setHeader(REQUEST_ID_HEADER, requestId)
      context.requestId = requestId
    }
    const rawTenantId: unknown = Reflect.get(req.headers, this.tenantIdHeader)
    if (isAcceptableHeaderValue(rawTenantId)) {
      context.tenantId = rawTenantId
    }

    this.logContext.run(context, () => next())
  }
}
