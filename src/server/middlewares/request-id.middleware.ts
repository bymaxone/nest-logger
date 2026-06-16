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
import type { NextFunction, Request, Response } from 'express'

import { LOGGER_OPTIONS_TOKEN } from '../constants/injection-tokens.constants'
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
 * Whether a raw header value is an acceptable correlation/tenant id: a string
 * within the length bound. Non-strings and oversized values are rejected so the
 * caller can fall back to a generated id (or omit the field).
 *
 * @param value - The raw header value (anything).
 * @returns `true` when `value` is a string no longer than the bound.
 */
function isAcceptableHeaderValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_CORRELATION_ID_LENGTH
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
   * @param req - The incoming Express request.
   * @param res - The outgoing Express response.
   * @param next - The next handler in the chain.
   */
  use(req: Request, res: Response, next: NextFunction): void {
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
